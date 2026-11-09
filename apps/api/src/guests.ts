/**
 * Guest accounts: a personal account for someone who is not a member, and the guest's daily allowance with QÉRA.
 *
 * A guest holds no member roles, so every member check fails closed for them. What a guest may do beyond a
 * visitor is limited to keeping a signed-in account and talking to QÉRA, which is offered read-only tools.
 *
 * The QÉRA allowance is counted on the server, per guest and per local day in the guest's market. Time is
 * measured from activity: while the QÉRA screen is open the app sends a heartbeat every minute, and every
 * message counts too. Each event adds the time since the previous one, capped, so a closed tab or a long pause
 * is not charged and a client that stops sending heartbeats is still charged for the messages it sends.
 */
import { GUEST_QERA_DAILY_SECONDS, guestAccountSchema } from '@quintara/domain';
import type { GuestAccount, QeraUsage } from '@quintara/domain';
import { audit, createSession, requireGuest } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { conflict, HttpError, validation } from './errors.ts';

/** The most one heartbeat can add: a little over the one-minute interval the apps use. */
const HEARTBEAT_CAP_SECONDS = 90;
/** The most one message can add: reading a reply and writing the next one. */
const MESSAGE_CAP_SECONDS = 5 * 60;

export interface GuestResult { guest: GuestAccount; newSessionToken: string | null }

/** Creates a guest account and signs it in. An applicant's unfinished application stays with the account. */
export async function createGuestAccount(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<GuestResult> {
  if (ctx.session) throw conflict('You are already a member.');
  if (ctx.guest) throw conflict('You already have a guest account.');
  const parsed = guestAccountSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const { fullName, email } = parsed.data;
  return db.tx(async (tx) => {
    const taken = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id IS DISTINCT FROM $2 AND deleted_at IS NULL', [email, ctx.userId]);
    if (taken[0]) throw new HttpError(409, 'An account already uses this email address. Sign in instead.', { email: 'This email address is already in use' });
    let userId = ctx.userId, newSessionToken: string | null = null;
    if (userId) {
      await tx.query(`UPDATE users SET email = $2, status = 'active', updated_at = now() WHERE id = $1`, [userId, email]);
    } else {
      userId = (await tx.query<{ id: string }>(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [email]))[0]!.id;
      newSessionToken = await createSession(tx, userId);
    }
    await tx.query('INSERT INTO guest_accounts (user_id, market_id, full_name) VALUES ($1, $2, $3)', [userId, marketId, fullName]);
    await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'guest_terms', true)`, [userId]);
    await audit(tx, userId, 'guest.created', 'user', userId);
    const created = (await tx.query<{ created_at: Date }>('SELECT created_at FROM guest_accounts WHERE user_id = $1', [userId]))[0]!;
    return { guest: { userId, fullName, email, createdAt: new Date(created.created_at).toISOString() }, newSessionToken };
  });
}

/** Finds the guest account to sign in. Returns null for anything else, so the caller gives one answer for all. */
export async function findGuestForSignIn(db: Queryable, email: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN guest_accounts g ON g.user_id = u.id
      WHERE lower(u.email) = lower($1) AND u.status = 'active' AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = u.id AND m.status = 'active')`, [email]);
  return rows[0]?.id ?? null;
}

export async function updateGuestAccount(db: Db, ctx: RequestContext, body: unknown): Promise<GuestAccount> {
  const guest = requireGuest(ctx);
  const parsed = guestAccountSchema.pick({ fullName: true }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.query('UPDATE guest_accounts SET full_name = $2 WHERE user_id = $1', [guest.userId, parsed.data.fullName]);
  await audit(db, guest.userId, 'guest.updated', 'user', guest.userId);
  return { ...guest, fullName: parsed.data.fullName };
}

/** Everything held about a guest. */
export async function exportGuestData(db: Queryable, ctx: RequestContext): Promise<Record<string, unknown>> {
  const guest = requireGuest(ctx);
  const [messages, usage, application] = await Promise.all([
    db.query('SELECT role, body, created_at FROM qera_messages WHERE user_id = $1 ORDER BY created_at', [guest.userId]),
    db.query('SELECT usage_day, used_seconds FROM qera_guest_usage WHERE user_id = $1 ORDER BY usage_day', [guest.userId]),
    db.query('SELECT status, data, submitted_at FROM membership_applications WHERE user_id = $1', [guest.userId]),
  ]);
  return { exportedAt: new Date().toISOString(), account: guest, qeraMessages: messages, qeraUsage: usage, applications: application };
}

/** A guest account has no bookings or payments to settle, so it is erased at once. */
export async function deleteGuestAccount(db: Db, ctx: RequestContext): Promise<void> {
  const guest = requireGuest(ctx);
  await db.tx(async (tx) => {
    for (const table of ['qera_messages', 'qera_proposals', 'qera_documents', 'qera_guest_usage', 'whatsapp_links', 'notifications', 'email_outbox', 'push_devices', 'push_settings', 'guest_accounts']) {
      await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [guest.userId]);
    }
    await tx.query(`DELETE FROM membership_applications WHERE user_id = $1 AND status = 'draft'`, [guest.userId]);
    await tx.query(`UPDATE membership_applications SET data = '{}'::jsonb, decision_note = NULL, updated_at = now() WHERE user_id = $1`, [guest.userId]);
    // Two-factor secrets and recovery codes go with the account.
    for (const table of ['user_mfa', 'user_mfa_pending', 'mfa_recovery_codes']) await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [guest.userId]);
    await tx.query(`UPDATE users SET email = NULL, status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`, [guest.userId]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [guest.userId]);
    await audit(tx, guest.userId, 'guest.deleted', 'user', guest.userId);
  });
}

/* ---------- The QÉRA allowance ---------- */

interface Day { day: string; resetsAt: string }

/** Today in the guest's market, and when tomorrow starts there. The market's city sets the time zone. */
async function today(db: Queryable, userId: string): Promise<Day> {
  const rows = await db.query<{ day: string; resets_at: Date }>(
    `SELECT to_char((now() AT TIME ZONE c.timezone)::date, 'YYYY-MM-DD') AS day,
            ((date_trunc('day', now() AT TIME ZONE c.timezone) + interval '1 day') AT TIME ZONE c.timezone) AS resets_at
       FROM guest_accounts g JOIN markets m ON m.id = g.market_id JOIN cities c ON c.id = m.city_id WHERE g.user_id = $1`, [userId]);
  if (!rows[0]) throw new HttpError(403, 'This is for guest accounts.');
  return { day: rows[0].day, resetsAt: new Date(rows[0].resets_at).toISOString() };
}

const usageOf = (used: number, limit: number, resetsAt: string): QeraUsage => ({ usedSeconds: Math.min(used, limit), limitSeconds: limit, resetsAt, exhausted: used >= limit });

/** What the guest has used today, without counting anything. */
export async function guestUsage(db: Queryable, userId: string, limit = GUEST_QERA_DAILY_SECONDS): Promise<QeraUsage> {
  const { day, resetsAt } = await today(db, userId);
  const rows = await db.query<{ used_seconds: number }>('SELECT used_seconds FROM qera_guest_usage WHERE user_id = $1 AND usage_day = $2', [userId, day]);
  return usageOf(Number(rows[0]?.used_seconds ?? 0), limit, resetsAt);
}

/** Adds the time since the guest's last activity today, capped, and returns the new total. */
export async function chargeGuestUsage(db: Queryable, userId: string, event: 'heartbeat' | 'message', limit = GUEST_QERA_DAILY_SECONDS): Promise<QeraUsage> {
  const { day, resetsAt } = await today(db, userId);
  const cap = event === 'heartbeat' ? HEARTBEAT_CAP_SECONDS : MESSAGE_CAP_SECONDS;
  const rows = await db.query<{ used_seconds: number }>(
    `INSERT INTO qera_guest_usage (user_id, usage_day, used_seconds, last_seen_at) VALUES ($1, $2, 0, now())
     ON CONFLICT (user_id, usage_day) DO UPDATE
        SET used_seconds = LEAST($3::int, qera_guest_usage.used_seconds + LEAST($4::int, GREATEST(0, floor(EXTRACT(EPOCH FROM now() - qera_guest_usage.last_seen_at)))::int)),
            last_seen_at = now()
     RETURNING used_seconds`, [userId, day, limit, cap]);
  return usageOf(Number(rows[0]!.used_seconds), limit, resetsAt);
}

export const GUEST_LIMIT_MESSAGE = 'You have used today’s five hours with QÉRA. Apply for membership to keep talking to QÉRA without a daily limit, or come back tomorrow.';
