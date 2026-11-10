/**
 * Checks every daily copy of the audit log against the database: the same entries and hashes, in the same order.
 *   DATABASE_URL=… AUDIT_S3_BUCKET=… (and the rest) pnpm --filter @quintara/api run audit:check-copies
 * Exit code 1 if any copy is missing or differs.
 */
import { checkAuditCopy } from './audit-export.ts';
import type { AuditLogName } from './audit-export.ts';
import { createPostgresDb } from './db.ts';
import { auditObjectStore } from './objects-config.ts';

const env0 = (key: string) => (process.env[key] ?? '').trim();
const objects = auditObjectStore(env0);
if (!env0('DATABASE_URL') || !objects) { console.error('Set DATABASE_URL and AUDIT_S3_BUCKET (with its region, endpoint and keys as needed).'); process.exit(2); }
const db = createPostgresDb(env0('DATABASE_URL'));
let problems = 0;
for (const row of await db.query<{ day: string; log: AuditLogName }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, log FROM audit_exports ORDER BY day, log`)) {
  const result = await checkAuditCopy(db, objects, row.log, row.day);
  if (!result.intact) { problems++; console.log(`${row.day} ${row.log}: ${result.problem}`); }
}
console.log(problems ? `${problems} copy or copies do not match.` : 'Every copy matches the database.');
await db.close();
process.exitCode = problems ? 1 : 0;
