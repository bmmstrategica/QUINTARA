/**
 * The admin console's accounts, and its audit log.
 *
 * Accounts:
 *  - Up to five active admin console accounts (STAFF_SEATS). Each has a name, a title and one role: administrator
 *    (everything) or concierge desk (experiences, bookings, requests, content).
 *  - Administrators add, change and suspend accounts. Nobody can suspend or demote themselves, and the last active
 *    administrator cannot be suspended or demoted, so the console can never be left without one.
 *  - A new account is told by email how to sign in. At their first sign-in they prove their email address with a
 *    code and set up two-factor; there is no password to send or share.
 *  - Suspending an account signs it out of the console at once and removes its powers.
 *
 * The audit log:
 *  - Every action (who did what to which record, when, from which address and device) is in `audit_logs`, and
 *    every request a member of staff makes to the console (including what they opened) is in `staff_activity`.
 *  - Both are append-only (the database refuses changes and deletions) and hash-chained, so a removed or altered
 *    entry is detected by the integrity check.
 *  - Administrators see everyone's entries and can export them; each member of staff can see their own.
 */
import { STAFF_ROLES } from '@quintara/domain';
import type { StaffRole } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff, revokeAllSessions } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import type { EmailProvider } from './email.ts';
import { conflict, forbidden, notFound, validation } from './errors.ts';

export const DEFAULT_STAFF_SEATS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaffAccount {
  userId: string; fullName: string; email: string; title: string; role: StaffRole; status: 'active' | 'suspended';
  twoFactor: boolean; lastSignInAt: string | null; lastActiveAt: string | null; createdAt: string; you: boolean;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const roleOf = (roles: string[]): StaffRole => (roles.includes('admin') ? 'admin' : 'concierge');

export async function listStaff(db: Queryable, ctx: RequestContext, seats: number) {
  const me = requireStaff(ctx, 'admin.staff.manage');
  const rows = await db.query(`
    SELECT s.user_id, s.full_name, s.title, s.status, s.created_at, s.last_sign_in_at, u.email,
           COALESCE((SELECT array_agg(r.role_key) FROM user_roles r WHERE r.user_id = s.user_id AND r.role_key IN ('admin', 'concierge')), '{}') AS roles,
           EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = s.user_id AND m.confirmed_at IS NOT NULL) AS two_factor,
           (SELECT max(a.occurred_at) FROM staff_activity a WHERE a.user_id = s.user_id) AS last_active
      FROM staff_accounts s JOIN users u ON u.id = s.user_id
     WHERE u.deleted_at IS NULL
     ORDER BY (s.status = 'active') DESC, s.full_name`);
  const staff: StaffAccount[] = rows.map((r) => ({
    userId: r.user_id as string, fullName: r.full_name as string, email: (r.email as string) ?? '', title: r.title as string, role: roleOf(r.roles as string[]),
    status: r.status as 'active' | 'suspended', twoFactor: Boolean(r.two_factor), lastSignInAt: iso(r.last_sign_in_at), lastActiveAt: iso(r.last_active), createdAt: iso(r.created_at)!, you: r.user_id === me,
  }));
  return { staff, seats: { used: staff.filter((s) => s.status === 'active').length, total: seats } };
}

const staffInput = z.object({
  fullName: z.string().trim().min(2, 'Enter their full name').max(120),
  email: z.email('Enter a valid email address').max(200),
  title: z.string().trim().max(80).default(''),
  role: z.enum(STAFF_ROLES),
});
const staffChange = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  title: z.string().trim().max(80).optional(),
  role: z.enum(STAFF_ROLES).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

async function activeCount(db: Queryable) {
  return Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM staff_accounts s JOIN users u ON u.id = s.user_id WHERE s.status = 'active' AND u.deleted_at IS NULL`))[0]!.n);
}
async function activeAdmins(db: Queryable) {
  return Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM staff_accounts s JOIN user_roles r ON r.user_id = s.user_id AND r.role_key = 'admin' WHERE s.status = 'active'`))[0]!.n);
}

/** Adds an admin console account and tells the person how to sign in. */
export async function addStaff(db: Db, mail: EmailProvider, ctx: RequestContext, seats: number, adminUrl: string, body: unknown): Promise<{ userId: string }> {
  const me = requireStaff(ctx, 'admin.staff.manage');
  const parsed = staffInput.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const userId = await db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(4242)');   // two administrators adding at once cannot both take the last seat
    if ((await activeCount(tx)) >= seats) throw conflict(`All ${seats} admin console accounts are in use. Suspend one before adding another.`);
    let id = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [d.email]))[0]?.id;
    if (id && (await tx.query('SELECT 1 FROM staff_accounts WHERE user_id = $1', [id]))[0]) throw conflict('This person already has an admin console account. Change it in the list instead.');
    // A member can also be staff: their membership is untouched, and their staff powers live in a separate session.
    if (!id) id = (await tx.query<{ id: string }>(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [d.email]))[0]!.id;
    await tx.query(`INSERT INTO staff_accounts (user_id, full_name, title, created_by) VALUES ($1, $2, $3, $4)`, [id, d.fullName, d.title, me]);
    await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, d.role]);
    await audit(tx, me, 'staff.added', 'user', id, { fullName: d.fullName, role: d.role, title: d.title });
    return id;
  });
  try {
    await mail.send({
      to: d.email,
      subject: 'Your Quintara admin console account',
      text: `Dear ${d.fullName.split(' ')[0]},\n\nYou have been given an account on the Quintara admin console, as ${d.role === 'admin' ? 'an administrator' : 'a member of the concierge desk'}.\n\nSign in at ${adminUrl} with this email address. We will email you a one-time code, and at your first sign-in you will set up an authenticator app on your phone for two-factor authentication. There is no password.\n\nIf you were not expecting this, you can ignore this email.\n\nQuintara`,
    });
  } catch { /* the account stands; the person can still sign in */ }
  return { userId };
}

/** Changes an account: name, title, role, or suspends and reactivates it. */
export async function updateStaff(db: Db, ctx: RequestContext, seats: number, userId: string, body: unknown): Promise<void> {
  const me = requireStaff(ctx, 'admin.staff.manage');
  const parsed = staffChange.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if (!UUID.test(userId)) throw notFound('This account does not exist.');
  await db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(4242)');
    const current = (await tx.query<{ status: string }>('SELECT status FROM staff_accounts WHERE user_id = $1 FOR UPDATE', [userId]))[0];
    if (!current) throw notFound('This account does not exist.');
    const roles = (await tx.query<{ role_key: string }>(`SELECT role_key FROM user_roles WHERE user_id = $1`, [userId])).map((r) => r.role_key);
    const wasAdmin = roles.includes('admin');
    const losingAdmin = wasAdmin && current.status === 'active' && (d.status === 'suspended' || d.role === 'concierge');
    if (userId === me && (d.status === 'suspended' || d.role === 'concierge')) throw forbidden('Another administrator must change your own access.');
    if (losingAdmin && (await activeAdmins(tx)) <= 1) throw conflict('This is the last active administrator. Make someone else an administrator first.');
    if (d.status === 'active' && current.status !== 'active' && (await activeCount(tx)) >= seats) throw conflict(`All ${seats} admin console accounts are in use. Suspend one before reactivating another.`);

    const sets: string[] = [], values: unknown[] = [userId];
    if (d.fullName !== undefined) { values.push(d.fullName); sets.push(`full_name = $${values.length}`); }
    if (d.title !== undefined) { values.push(d.title); sets.push(`title = $${values.length}`); }
    if (d.status !== undefined) { values.push(d.status); sets.push(`status = $${values.length}`); }
    if (sets.length) await tx.query(`UPDATE staff_accounts SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, values);
    if (d.role) {
      await tx.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_key IN ('admin', 'concierge')`, [userId]);
      await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2)`, [userId, d.role]);
    }
    // A suspension, or a change of role, takes effect at once: the person's console sessions end.
    if (d.status === 'suspended' || (d.role && d.role !== roleOf(roles))) await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'staff' AND revoked_at IS NULL`, [userId]);
    await audit(tx, me, d.status === 'suspended' ? 'staff.suspended' : d.status === 'active' && current.status !== 'active' ? 'staff.reactivated' : 'staff.changed', 'user', userId, d);
  });
}

/** Records a staff sign-in on the account. */
export async function noteSignIn(db: Queryable, userId: string) {
  await db.query('UPDATE staff_accounts SET last_sign_in_at = now() WHERE user_id = $1', [userId]);
}

/** Every request by a member of staff to the console. Called once the answer has been sent. */
export async function recordActivity(db: Queryable, entry: { userId: string; method: string; route: string; targetId: string | null; status: number; ip: string; userAgent: string }) {
  await db.query('INSERT INTO staff_activity (user_id, method, route, target_id, status, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [entry.userId, entry.method, entry.route.slice(0, 200), entry.targetId?.slice(0, 80) ?? null, entry.status, entry.ip.slice(0, 64), entry.userAgent.slice(0, 200)]);
}

/* ---------- The audit log ---------- */

export interface AuditEntry {
  kind: 'action' | 'request';
  seq: number; at: string; staffId: string | null; staffName: string; action: string; summary: string;
  entityType: string | null; entityId: string | null; details: unknown; status: number | null; ip: string | null; device: string | null;
}

const filters = z.object({
  staff: z.string().regex(UUID).optional(),
  kind: z.enum(['action', 'request', 'all']).default('all'),
  q: z.string().trim().max(80).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Plain words for the actions staff see most. Others show as recorded. */
const ACTION_WORDS: Record<string, string> = {
  'auth.staff_signed_in': 'Signed in to the admin console', 'auth.staff_sign_in_failed': 'A sign-in to the admin console failed',
  'auth.signed_in': 'Signed in', 'auth.second_step_required': 'Asked for two-factor', 'mfa.enabled': 'Turned on two-factor',
  'mfa.code_rejected': 'Two-factor code refused', 'mfa.reset_by_staff': 'Reset someone’s two-factor', 'mfa.recovery_codes_replaced': 'Made new recovery codes',
  'mfa.authenticator_replaced': 'Moved two-factor to a new phone', 'mfa.disabled': 'Turned off two-factor', 'mfa.setup_started': 'Started setting up two-factor',
  'staff.added': 'Added an admin console account', 'staff.changed': 'Changed an admin console account', 'staff.suspended': 'Suspended an admin console account', 'staff.reactivated': 'Reactivated an admin console account',
  'audit.exported': 'Exported the audit log', 'audit.verified': 'Checked the audit log',
  'media.uploaded': 'Uploaded a photograph', 'product.created': 'Added a product', 'product.updated': 'Changed a product',
  'order.preparing': 'Started processing an order', 'order.dispatched': 'Dispatched an order', 'order.delivered': 'Confirmed an order received', 'order.note_added': 'Added a note to an order', 'order.cancelled_by_staff': 'Cancelled an order',
  'application.approved': 'Approved an application', 'application.reviewed': 'Reviewed an application', 'payment.refunded': 'Refunded a payment',
};
const METHOD_WORDS: Record<string, string> = { GET: 'Opened', POST: 'Sent', PUT: 'Saved', PATCH: 'Changed', DELETE: 'Removed' };
/** Plain names for what a route shows. */
const ROUTE_WORDS: Record<string, string> = {
  audit: 'the audit log', 'audit export': 'the audit log export', 'audit verify': 'the audit log check', staff: 'staff accounts', members: 'members', applications: 'applications', orders: 'Maison orders',
  'orders advance': 'an order’s next step', 'orders notes': 'a note on an order', 'orders cancel': 'an order’s cancellation', payments: 'payments', insights: 'insights', reports: 'reports', photos: 'a photograph', media: 'a photograph',
};
const describeRequest = (method: string, route: string) => {
  const key = route.replace(/^\/admin\/v1\//, '').replace(/\/:[a-zA-Z]+/g, '').replace(/[/-]/g, ' ').trim();
  return `${METHOD_WORDS[method] ?? method} ${ROUTE_WORDS[key] ?? (key || 'the console')}`;
};

/** The log, newest first. Administrators see everyone; other staff see only their own entries. */
export async function listAudit(db: Queryable, ctx: RequestContext, query: unknown) {
  const me = requireStaff(ctx, 'admin.experiences.manage');
  const parsed = filters.safeParse(query ?? {});
  if (!parsed.success) throw validation(parsed.error.issues);
  const f = parsed.data;
  const all = ctx.staffRoles.includes('admin');
  const staffFilter = all ? f.staff ?? null : me;
  const params: unknown[] = [staffFilter, f.from ?? null, f.to ?? null, f.before ?? null, f.limit, f.q ? `%${f.q.replace(/[%_\\]/g, '\\$&')}%` : null];
  const actions = f.kind === 'request' ? [] : await db.query(`
    SELECT 'action' AS kind, a.seq, a.occurred_at AS at, a.actor_user_id AS staff_id, a.action, a.entity_type, a.entity_id::text, a.changes AS details, NULL::int AS status, a.ip, a.user_agent
      FROM audit_logs a
     WHERE a.actor_user_id IN (SELECT user_id FROM staff_accounts)
       AND ($1::uuid IS NULL OR a.actor_user_id = $1) AND ($2::date IS NULL OR a.occurred_at >= $2::date) AND ($3::date IS NULL OR a.occurred_at < $3::date + 1)
       AND ($4::bigint IS NULL OR a.seq < $4) AND ($6::text IS NULL OR a.action ILIKE $6 OR a.changes::text ILIKE $6)
     ORDER BY a.seq DESC LIMIT $5`, params);
  const requests = f.kind === 'action' ? [] : await db.query(`
    SELECT 'request' AS kind, r.seq, r.occurred_at AS at, r.user_id AS staff_id, r.method || ' ' || r.route AS action, NULL AS entity_type, r.target_id AS entity_id, NULL::jsonb AS details, r.status, r.ip, r.user_agent
      FROM staff_activity r
     WHERE ($1::uuid IS NULL OR r.user_id = $1) AND ($2::date IS NULL OR r.occurred_at >= $2::date) AND ($3::date IS NULL OR r.occurred_at < $3::date + 1)
       AND ($4::bigint IS NULL OR r.seq < $4) AND ($6::text IS NULL OR r.route ILIKE $6)
     ORDER BY r.seq DESC LIMIT $5`, params);
  const names = new Map((await db.query<{ user_id: string; full_name: string }>('SELECT user_id, full_name FROM staff_accounts')).map((r) => [r.user_id, r.full_name]));
  const entries: AuditEntry[] = [...actions, ...requests].map((r) => {
    const action = r.action as string;
    return {
      kind: r.kind as 'action' | 'request', seq: Number(r.seq), at: new Date(r.at as string).toISOString(), staffId: (r.staff_id as string) ?? null, staffName: names.get(r.staff_id as string) ?? 'Unknown',
      action, summary: r.kind === 'request' ? describeRequest(action.split(' ')[0]!, action.split(' ')[1] ?? '') : ACTION_WORDS[action] ?? action.replace(/[._]/g, ' '),
      entityType: (r.entity_type as string) ?? null, entityId: (r.entity_id as string) ?? null, details: r.details ?? null, status: r.status === null ? null : Number(r.status), ip: (r.ip as string) ?? null, device: (r.user_agent as string) ?? null,
    };
  }).sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq).slice(0, f.limit);
  return { entries, all, staff: all ? [...names].map(([userId, fullName]) => ({ userId, fullName })) : [{ userId: me, fullName: names.get(me) ?? 'You' }] };
}

/** The log as CSV, for an auditor. The export itself is recorded. Administrators only. */
export async function exportAudit(db: Queryable, ctx: RequestContext, query: unknown): Promise<string> {
  const me = requireStaff(ctx, 'admin.audit.view');
  const { entries } = await listAudit(db, ctx, { ...(query as object), limit: 500 });
  await audit(db, me, 'audit.exported', 'audit_log', me, { rows: entries.length, filters: query });
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    // Quoted, and a leading = + - @ is neutralised so a spreadsheet never runs it as a formula.
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const head = ['Time (UTC)', 'Staff', 'Kind', 'What', 'Recorded as', 'Record', 'Details', 'Answer', 'IP address', 'Device'];
  return [head.map(cell).join(','), ...entries.map((e) => [e.at, e.staffName, e.kind, e.summary, e.action, e.entityId ? `${e.entityType ?? ''} ${e.entityId}`.trim() : '', e.details, e.status, e.ip, e.device].map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Recomputes both hash chains. Any entry removed or altered shows as the first place the chain breaks. */
export async function verifyAudit(db: Queryable, ctx: RequestContext) {
  const me = requireStaff(ctx, 'admin.audit.view');
  const check = async (table: 'audit_logs' | 'staff_activity') => {
    const rows = await db.query<{ seq: string; ok_link: boolean; ok_hash: boolean }>(`
      SELECT seq, prev_hash = COALESCE(lag(hash) OVER (ORDER BY seq), '') AS ok_link,
             hash = encode(sha256(convert_to(prev_hash || '|' || audit_payload('${table}', to_jsonb(t), t.occurred_at), 'UTF8')), 'hex') AS ok_hash
        FROM ${table} t ORDER BY seq`);
    const broken = rows.find((r) => !r.ok_link || !r.ok_hash);
    return { entries: rows.length, intact: !broken, firstBrokenAt: broken ? Number(broken.seq) : null };
  };
  const result = { actions: await check('audit_logs'), requests: await check('staff_activity'), checkedAt: new Date().toISOString() };
  await audit(db, me, 'audit.verified', 'audit_log', me, { actions: result.actions.intact, requests: result.requests.intact });
  return result;
}

