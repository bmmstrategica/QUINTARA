/**
 * Daily copies of the audit log in write-once storage (docs/SECURITY.md, "Before launch", item 5).
 *
 * The audit log (audit_logs) and the staff activity log (staff_activity) are append-only and hash-chained in the
 * database. A copy outside the database survives even a full compromise of it: each UTC day, once it is over, both
 * logs' entries for that day are written as JSON lines to an S3 bucket with Object Lock, in compliance mode, so nobody
 * (not even the bucket's owner) can change or delete them before the retention date.
 *
 * - One file per day and log: audit/<log>/<yyyy>/<mm>/<dd>.jsonl, each entry with its seq, prev_hash and hash. The
 *   first entry's prev_hash is the previous day's last hash, so the files chain together as the log does.
 * - Each copy is recorded in audit_exports (entries, first and last seq, last hash, retention), and written to the
 *   audit log itself (audit.copied).
 * - checkAuditCopy() reads a copy back and compares it, entry by entry, with the database.
 */
import { audit } from './context.ts';
import type { Db, Queryable } from './db.ts';
import type { ObjectStore } from './objects.ts';

export const AUDIT_LOGS = ['audit_logs', 'staff_activity'] as const;
export type AuditLogName = (typeof AUDIT_LOGS)[number];
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const auditCopyKey = (log: AuditLogName, day: string) => `audit/${log}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.jsonl`;

async function entriesOf(db: Queryable, log: AuditLogName, day: string) {
  // The table name is one of two fixed strings, never input.
  return db.query<Record<string, unknown> & { seq: string; hash: string }>(
    `SELECT * FROM ${log} WHERE occurred_at >= $1::date AND occurred_at < $1::date + 1 ORDER BY seq`, [day]);
}
const line = (row: Record<string, unknown>) => JSON.stringify(row, (_key, value) => (value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value));

/** Copies one UTC day of both logs. Already-copied days are left alone (a copy is never rewritten). */
export async function copyAuditDay(db: Db, objects: ObjectStore, day: string, retentionDays: number): Promise<{ log: AuditLogName; entries: number }[]> {
  const done: { log: AuditLogName; entries: number }[] = [];
  const retainUntil = new Date(Date.now() + retentionDays * DAY);
  for (const log of AUDIT_LOGS) {
    if ((await db.query('SELECT 1 FROM audit_exports WHERE day = $1 AND log = $2', [day, log])).length) continue;
    const rows = await entriesOf(db, log, day);
    const key = auditCopyKey(log, day);
    await objects.put(key, Buffer.from(rows.map(line).join('\n') + (rows.length ? '\n' : ''), 'utf8'), 'application/x-ndjson', { retainUntil });
    await db.query(`INSERT INTO audit_exports (day, log, entries, first_seq, last_seq, last_hash, object_key, retain_until) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [day, log, rows.length, rows[0]?.seq ?? null, rows.at(-1)?.seq ?? null, rows.at(-1)?.hash ?? null, key, retainUntil]);
    await audit(db, null, 'audit.copied', 'audit_log', null, { log, day, entries: rows.length, key });
    done.push({ log, entries: rows.length });
  }
  return done;
}

/**
 * Copies every finished day not yet copied, oldest first (at most `maxDays` per run), from the first day with
 * entries up to yesterday (UTC). Run by housekeeping; cheap when there is nothing to do.
 */
export async function copyDueAuditDays(db: Db, objects: ObjectStore, options: { retentionDays: number; now?: Date; maxDays?: number }): Promise<string[]> {
  const today = isoDay(options.now ?? new Date());
  const first = (await db.query<{ day: string | null }>(`SELECT to_char(min(d), 'YYYY-MM-DD') AS day FROM (SELECT min(occurred_at) AS d FROM audit_logs UNION ALL SELECT min(occurred_at) FROM staff_activity) t`))[0]?.day;
  if (!first) return [];
  const copied = new Set((await db.query<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM audit_exports GROUP BY day HAVING count(*) = $1`, [AUDIT_LOGS.length])).map((r) => r.day));
  const days: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); isoDay(new Date(t)) < today && days.length < (options.maxDays ?? 7); t += DAY) {
    const day = isoDay(new Date(t));
    if (!copied.has(day)) days.push(day);
  }
  for (const day of days) await copyAuditDay(db, objects, day, options.retentionDays);
  return days;
}

/** Reads a day's copy back and compares it with the database: the same entries, the same hashes, in the same order. */
export async function checkAuditCopy(db: Queryable, objects: ObjectStore, log: AuditLogName, day: string): Promise<{ intact: boolean; entries: number; problem: string | null }> {
  const bytes = await objects.get(auditCopyKey(log, day));
  if (!bytes) return { intact: false, entries: 0, problem: 'The copy is missing.' };
  const copy = bytes.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: string | number; hash: string; prev_hash: string });
  const rows = await entriesOf(db, log, day);
  if (copy.length !== rows.length) return { intact: false, entries: copy.length, problem: `The copy has ${copy.length} entries; the database has ${rows.length}.` };
  for (let i = 0; i < rows.length; i++) {
    if (String(copy[i]!.seq) !== String(rows[i]!.seq) || copy[i]!.hash !== rows[i]!.hash) return { intact: false, entries: copy.length, problem: `Entry ${rows[i]!.seq} differs from the copy.` };
    if (i > 0 && copy[i]!.prev_hash !== copy[i - 1]!.hash) return { intact: false, entries: copy.length, problem: `The copy's chain breaks at entry ${copy[i]!.seq}.` };
  }
  return { intact: true, entries: copy.length, problem: null };
}
