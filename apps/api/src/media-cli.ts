/**
 * Moves photographs stored in the database to the bucket.
 *   DATABASE_URL=… MEDIA_S3_BUCKET=… (and the rest) pnpm --filter @quintara/api run media:to-objects
 * Safe to stop and run again: a photograph's database copy is cleared only after all its files are in the bucket.
 */
import { createPostgresDb } from './db.ts';
import { moveMediaToObjects } from './media.ts';
import { mediaObjectStore } from './objects-config.ts';

const env0 = (key: string) => (process.env[key] ?? '').trim();
if (!env0('DATABASE_URL')) { console.error('Set DATABASE_URL.'); process.exit(2); }
const objects = mediaObjectStore(env0);
if (!objects) { console.error('Set MEDIA_S3_BUCKET (and MEDIA_S3_REGION, MEDIA_S3_ENDPOINT, keys as needed).'); process.exit(2); }
const db = createPostgresDb(env0('DATABASE_URL'));
let moved = 0, step = 0;
while ((step = await moveMediaToObjects(db, objects)) > 0) { moved += step; console.log(`Moved ${moved} photograph(s)…`); }
console.log(`Done: ${moved} photograph(s) moved to object storage.`);
await db.close();
