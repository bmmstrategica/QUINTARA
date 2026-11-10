/**
 * Photographs in object storage. Each scenario runs against the in-memory store and, when TEST_S3_ENDPOINT is set
 * (for example a local MinIO: http://localhost:9000 with TEST_S3_KEY and TEST_S3_SECRET), against a real
 * S3-compatible bucket.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { createDbMediaStore, moveMediaToObjects, objectKeys, purgeDeletedMedia } from '../src/media.ts';
import { MemoryObjectStore, S3ObjectStore } from '../src/objects.ts';
import type { ObjectStore } from '../src/objects.ts';
import { startServer } from './harness.ts';

async function s3Store(): Promise<ObjectStore> {
  const settings = { region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT!, credentials: { accessKeyId: process.env.TEST_S3_KEY ?? 'minioadmin', secretAccessKey: process.env.TEST_S3_SECRET ?? 'minioadmin' }, forcePathStyle: true };
  const bucket = `quintara-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await new S3Client(settings).send(new CreateBucketCommand({ Bucket: bucket }));
  return new S3ObjectStore({ bucket, region: settings.region, endpoint: settings.endpoint, accessKeyId: settings.credentials.accessKeyId, secretAccessKey: settings.credentials.secretAccessKey, forcePathStyle: true });
}
const STORES: [name: string, make: () => Promise<ObjectStore>, skip: string | false][] = [
  ['in memory', async () => new MemoryObjectStore(), false],
  ['S3-compatible bucket', s3Store, process.env.TEST_S3_ENDPOINT ? false : 'TEST_S3_ENDPOINT is not set'],
];

for (const [name, make, skip] of STORES) {
  test(`photographs go to the bucket and are served from it (${name})`, { skip }, async () => {
    const objects = await make();
    const s = await startServer({ objects });
    try {
      const desk = (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'content@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const original = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#183c32' } }).jpeg({ quality: 90 }).toBuffer();
      const up = await s.app.inject({ method: 'POST', url: '/admin/v1/photos', headers: { cookie: desk, 'content-type': 'image/jpeg' }, payload: original });
      assert.equal(up.statusCode, 200, up.body);
      const { id } = JSON.parse(up.body) as { id: string };

      // The database keeps the details, not the bytes.
      const row = (await s.db.query<{ data_base64: string | null; width: number }>('SELECT data_base64, width FROM media WHERE id = $1', [id]))[0]!;
      assert.equal(row.data_base64, null);
      assert.equal(row.width, 2400);
      const copies = await s.db.query<{ data_base64: string | null; width: number; content_type: string }>('SELECT data_base64, width, content_type FROM media_variants WHERE media_id = $1 ORDER BY width', [id]);
      assert.ok(copies.length >= 3 && copies.every((c) => c.data_base64 === null));

      // Served through the API, the master and the right-sized copy, exactly as stored in the bucket.
      const master = await s.app.inject({ method: 'GET', url: `/v1/media/${id}`, headers: { accept: 'image/jpeg' } });
      assert.equal(master.statusCode, 200);
      assert.equal(master.headers['content-type'], 'image/jpeg');
      assert.ok(master.rawPayload.equals((await objects.get(objectKeys.master(id)))!));
      const small = await s.app.inject({ method: 'GET', url: `/v1/media/${id}?w=600`, headers: { accept: 'image/webp,*/*' } });
      assert.equal(small.headers['content-type'], 'image/webp');
      assert.ok((await sharp(small.rawPayload).metadata()).width! >= 600);
      assert.ok(small.rawPayload.length < master.rawPayload.length);
    } finally { await s.close(); }
  });

  test(`a replaced or erased picture's files leave the bucket; photographs kept in the database still work and can be moved (${name})`, { skip }, async () => {
    const objects = await make();
    const s = await startServer({ objects });
    try {
      // A photograph stored the old way, in the database, before object storage was set up.
      const old = await createDbMediaStore(s.db).put({
        master: { contentType: 'image/png', bytes: await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer(), width: 40, height: 30 },
        variants: [],
      } as never, (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'admin@example.com'`))[0]!.id);
      assert.equal((await s.app.inject({ method: 'GET', url: `/v1/media/${old}` })).statusCode, 200);

      // A member sets a profile picture, then replaces it: the first one's files are removed from the bucket.
      const api = s.client();
      await api.signIn({ email: 'thandi@example.com' });
      const picture = async (colour: string) => (await sharp({ create: { width: 500, height: 500, channels: 3, background: colour } }).jpeg().toBuffer()).toString('base64');
      const cookie = await (async () => { const r = await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } }); return r.cookies.map((c) => `${c.name}=${c.value}`).join('; '); })();
      const setAvatar = async (colour: string) => s.app.inject({ method: 'PUT', url: '/v1/me/avatar', headers: { cookie }, payload: { contentType: 'image/jpeg', dataBase64: await picture(colour) } });
      assert.equal((await setAvatar('#aa3355')).statusCode, 200);
      const first = (await s.db.query<{ id: string }>(`SELECT p.avatar_media_id AS id FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.email = 'thandi@example.com'`))[0]!.id;
      assert.ok(await objects.get(objectKeys.master(first)));
      assert.equal((await setAvatar('#3355aa')).statusCode, 200);
      assert.ok(await purgeDeletedMedia(s.db, objects) >= 1);
      assert.equal(await objects.get(objectKeys.master(first)), null);
      assert.equal((await s.db.query('SELECT 1 FROM media_purge')).length, 0);

      // The photographs still in the database move to the bucket and are served exactly as before.
      const before = (await s.app.inject({ method: 'GET', url: `/v1/media/${old}` })).rawPayload;
      let moved = 0, step = 0;
      while ((step = await moveMediaToObjects(s.db, objects)) > 0) moved += step;
      assert.ok(moved >= 1);
      assert.equal((await s.db.query<{ n: number }>('SELECT count(*)::int AS n FROM media WHERE data_base64 IS NOT NULL'))[0]!.n, 0);
      assert.ok((await s.app.inject({ method: 'GET', url: `/v1/media/${old}` })).rawPayload.equals(before));
    } finally { await s.close(); }
  });
}
