/**
 * Daily copies of the audit log in write-once storage. Runs on the in-memory store and, with TEST_S3_ENDPOINT, checks
 * that a copy in a bucket with Object Lock cannot be deleted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { auditCopyKey, checkAuditCopy, copyAuditDay, copyDueAuditDays } from '../src/audit-export.ts';
import { MemoryObjectStore, S3ObjectStore } from '../src/objects.ts';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

/** Entries from a finished day, as the log would hold them (inserted by the owner with their original times). */
async function pastDay(s: TestServer, day: string) {
  const staff = (await s.db.query<{ user_id: string }>('SELECT user_id FROM staff_accounts LIMIT 1'))[0]!.user_id;
  for (const [i, action] of ['booking.created', 'payment.paid', 'staff.changed'].entries()) {
    await s.ownerDb.query('INSERT INTO audit_logs (action, entity_type, changes, occurred_at) VALUES ($1, $2, $3::jsonb, $4)', [action, 'test', JSON.stringify({ i }), `${day}T0${i + 8}:00:00Z`]);
  }
  for (const route of ['/admin/v1/members', '/admin/v1/payments']) {
    await s.ownerDb.query('INSERT INTO staff_activity (user_id, method, route, status, occurred_at) VALUES ($1, $2, $3, 200, $4)', [staff, 'GET', route, `${day}T12:00:00Z`]);
  }
}

test('each finished day of both logs is copied once, with its hashes, and the copy matches the database', async () => {
  const s = await startServer();
  const objects = new MemoryObjectStore();
  try {
    await pastDay(s, '2026-11-01');
    const copied = await copyDueAuditDays(s.db, objects, { retentionDays: 30, now: new Date('2026-11-03T08:00:00Z') });
    assert.deepEqual(copied, ['2026-11-01', '2026-11-02']);           // up to yesterday; the empty day is copied too

    const rows = await s.db.query<{ day: string; log: string; entries: number; last_hash: string | null }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, log, entries, last_hash FROM audit_exports ORDER BY day, log`);
    assert.deepEqual(rows.map((r) => [r.day, r.log, r.entries]), [['2026-11-01', 'audit_logs', 3], ['2026-11-01', 'staff_activity', 2], ['2026-11-02', 'audit_logs', 0], ['2026-11-02', 'staff_activity', 0]]);
    const file = objects.objects.get(auditCopyKey('audit_logs', '2026-11-01'))!;
    const lines = file.bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.action), ['booking.created', 'payment.paid', 'staff.changed']);
    assert.ok(lines.every((l) => /^[0-9a-f]{64}$/.test(l.hash)) && lines[1].prev_hash === lines[0].hash);
    assert.equal(rows[0]!.last_hash, lines.at(-1).hash);
    // Kept for the retention period.
    const days = (file.retainUntil!.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1);

    for (const log of ['audit_logs', 'staff_activity'] as const) assert.deepEqual(await checkAuditCopy(s.db, objects, log, '2026-11-01'), { intact: true, entries: log === 'audit_logs' ? 3 : 2, problem: null });
    // The copy is recorded in the audit log itself.
    assert.equal((await s.db.query(`SELECT 1 FROM audit_logs WHERE action = 'audit.copied'`)).length, 4);

    // Running again copies nothing new and never rewrites a copy.
    const before = file.bytes;
    assert.deepEqual(await copyDueAuditDays(s.db, objects, { retentionDays: 30, now: new Date('2026-11-03T08:00:00Z') }), []);
    await copyAuditDay(s.db, objects, '2026-11-01', 30);
    assert.equal(objects.objects.get(auditCopyKey('audit_logs', '2026-11-01'))!.bytes, before);
  } finally { await s.close(); }
});

test('an entry changed in the database after it was copied is caught by comparing with the copy', async () => {
  const s = await startServer();
  const objects = new MemoryObjectStore();
  try {
    await pastDay(s, '2026-11-01');
    await copyAuditDay(s.db, objects, '2026-11-01', 30);
    // Someone with the owner's access lifts the protection, rewrites an entry and recomputes nothing.
    const victim = (await s.db.query<{ seq: string }>(`SELECT seq FROM audit_logs WHERE action = 'payment.paid'`))[0]!.seq;
    await s.ownerDb.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only');
    await s.ownerDb.query(`UPDATE audit_logs SET hash = repeat('0', 64) WHERE seq = $1`, [victim]);
    await s.ownerDb.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only');
    const check = await checkAuditCopy(s.db, objects, 'audit_logs', '2026-11-01');
    assert.equal(check.intact, false);
    assert.match(check.problem ?? '', new RegExp(`Entry ${victim} differs`));
    assert.deepEqual(await checkAuditCopy(s.db, objects, 'audit_logs', '2026-10-01'), { intact: false, entries: 0, problem: 'The copy is missing.' });
  } finally { await s.close(); }
});

test('in a bucket with Object Lock, a copy cannot be deleted before its retention date', { skip: process.env.TEST_S3_ENDPOINT ? false : 'TEST_S3_ENDPOINT is not set' }, async () => {
  const settings = { region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT!, credentials: { accessKeyId: process.env.TEST_S3_KEY ?? 'test', secretAccessKey: process.env.TEST_S3_SECRET ?? 'test' }, forcePathStyle: true };
  const client = new S3Client(settings);
  const bucket = `quintara-audit-${Date.now().toString(36)}`;
  await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  const objects = new S3ObjectStore({ bucket, region: settings.region, endpoint: settings.endpoint, accessKeyId: settings.credentials.accessKeyId, secretAccessKey: settings.credentials.secretAccessKey, forcePathStyle: true });
  const s = await startServer();
  try {
    await pastDay(s, '2026-11-01');
    await copyAuditDay(s.db, objects, '2026-11-01', 30);
    const key = auditCopyKey('audit_logs', '2026-11-01');
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(head.ObjectLockMode, 'COMPLIANCE');
    const days = (head.ObjectLockRetainUntilDate!.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1);
    const version = (await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }))).Versions![0]!.VersionId!;
    // Deleting the copy itself (its version) is refused until the retention date.
    await assert.rejects(client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version })), (e: { name?: string }) => e.name === 'AccessDenied');
    assert.equal((await checkAuditCopy(s.db, objects, 'audit_logs', '2026-11-01')).intact, true);
  } finally { await s.close(); }
});

test('a day is copied only once it has settled: an entry from a transaction begun before midnight is not left out', async () => {
  const s = await startServer();
  const objects = new MemoryObjectStore();
  try {
    await pastDay(s, '2026-11-01');
    // Five minutes after midnight: 1 November is over, but a transaction begun at 23:59 may still be writing to it.
    assert.deepEqual(await copyDueAuditDays(s.db, objects, { retentionDays: 30, now: new Date('2026-11-02T00:05:00Z') }), []);
    // That late entry arrives, stamped with its transaction's start.
    await s.ownerDb.query(`INSERT INTO audit_logs (action, entity_type, changes, occurred_at) VALUES ('late.entry', 'test', '{}'::jsonb, '2026-11-01T23:59:58Z')`);
    assert.deepEqual(await copyDueAuditDays(s.db, objects, { retentionDays: 30, now: new Date('2026-11-02T00:20:00Z') }), ['2026-11-01']);
    const copy = (await objects.get(auditCopyKey('audit_logs', '2026-11-01')))!.toString('utf8');
    assert.ok(copy.includes('late.entry'), 'the late entry is in the copy');
    assert.equal((await checkAuditCopy(s.db, objects, 'audit_logs', '2026-11-01')).intact, true);
  } finally { await s.close(); }
});
