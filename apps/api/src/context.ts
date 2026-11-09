/**
 * Who is making this request. Built once per request from the session cookie
 * (or a bearer token for the mobile app), then passed to every handler.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { can, ROLES, STAFF_ROLES, staffCan } from '@quintara/domain';
import type { GuestAccount, Permission, Role, Session, StaffPermission, StaffRole } from '@quintara/domain';
import type { Queryable } from './db.ts';
import { forbidden, unauthenticated } from './errors.ts';

export interface RequestContext {
  userId: string | null;
  /** Present only for active members. */
  session: Session | null;
  roles: Role[];
  /** Staff roles, held independently of membership. */
  staffRoles: StaffRole[];
  /** Present for a signed-in guest account: someone with a personal account who is not an active member. */
  guest: GuestAccount | null;
  /**
   * The city being viewed, chosen by the person in the app (the `x-quintara-market` header). Lists and new entries
   * belong to it. Falls back to the member's home city, then to the first open city. Staff may work in a city that
   * is not yet open, to prepare it.
   */
  marketId: string;
  /**
   * A sign-in waiting for its second step (two-factor). Such a session has no powers at all: `userId` stays null,
   * so every route but the second step treats the request as signed out.
   */
  pending?: { userId: string; state: 'verify' | 'enrol'; token: string } | null;
}

export type SessionKind = 'app' | 'staff';

export const SESSION_COOKIE = 'q_session';
/** Staff sessions have their own cookie, sent only to the admin routes, and are much shorter. */
export const STAFF_COOKIE = 'q_staff';
const SESSION_DAYS = 30;
/** A staff session lasts at most twelve hours, and ends after two hours without use. */
export const STAFF_SESSION_HOURS = 12;
const STAFF_IDLE_MINUTES = 120;
/** A sign-in waiting for its second step lapses after fifteen minutes. */
const PENDING_MINUTES = 15;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Queryable, userId: string, kind: SessionKind = 'app', mfaState: 'complete' | 'verify' | 'enrol' = 'complete'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const minutes = mfaState !== 'complete' ? PENDING_MINUTES : kind === 'staff' ? STAFF_SESSION_HOURS * 60 : SESSION_DAYS * 24 * 60;
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at, kind, mfa_state) VALUES ($1, $2, now() + make_interval(mins => $3), $4, $5)`, [userId, hashToken(token), minutes, kind, mfaState]);
  return token;
}

/** Signs a person out everywhere: every app, every device, the admin console. */
export async function revokeAllSessions(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
}

const nobody = (): RequestContext => ({ userId: null, session: null, roles: [], staffRoles: [], guest: null, marketId: '', pending: null });

/**
 * The context for a session token. `kind` is the kind of session the route accepts: staff routes take only staff
 * sessions (staff powers are never carried by an app session), app routes only app sessions.
 */
/** What loadContext needs to know about two-factor: whether it is required, and the app store review address. */
export interface SecondStepRule { required: boolean; reviewEmail?: string | null }

export async function loadContext(db: Queryable, token: string | undefined, kind: SessionKind = 'app', rule: SecondStepRule = { required: false }): Promise<RequestContext> {
  if (!token) return nobody();
  const rows = await db.query<{ user_id: string; email: string | null; user_status: string; mfa_state: 'complete' | 'verify' | 'enrol'; idle: boolean; stale: boolean; has_mfa: boolean }>(
    `SELECT u.id AS user_id, u.email, u.status AS user_status, s.mfa_state,
            EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL) AS has_mfa,
            (s.kind = 'staff' AND s.last_seen_at < now() - make_interval(mins => $3)) AS idle,
            s.last_seen_at < now() - interval '1 minute' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.kind = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL AND u.status <> 'deleted'`,
    [hashToken(token), kind, STAFF_IDLE_MINUTES],
  );
  const user = rows[0];
  if (!user) return nobody();
  if (user.idle) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
    return nobody();
  }
  if (user.mfa_state !== 'complete') return { ...nobody(), pending: { userId: user.user_id, state: user.mfa_state, token } };
  // Where two-factor is required, an account with an email address and no authenticator can do nothing until it
  // sets one up. This also covers sessions begun before the rule, and accounts that gained an email address later.
  const review = !!rule.reviewEmail && !!user.email && rule.reviewEmail.trim().toLowerCase() === user.email.trim().toLowerCase();
  if (rule.required && user.email && !user.has_mfa && !review) return { ...nobody(), pending: { userId: user.user_id, state: 'enrol', token } };
  if (user.stale) await db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hashToken(token)]);
  const ctx = await contextOf(db, user);
  // Staff powers only through a staff session; an app session of the same person has none.
  return kind === 'staff' ? ctx : { ...ctx, staffRoles: [] };
}

/**
 * The same context for a user reached another way than a session: a message from their linked WhatsApp number.
 * Staff roles are never carried there; WhatsApp is for QÉRA only.
 */
export async function contextForUser(db: Queryable, userId: string): Promise<RequestContext> {
  const rows = await db.query<{ user_id: string; email: string | null; user_status: string }>(
    'SELECT id AS user_id, email, status AS user_status FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!rows[0]) return nobody();
  return { ...(await contextOf(db, rows[0])), staffRoles: [] };
}

async function contextOf(db: Queryable, user: { user_id: string; email: string | null; user_status: string }): Promise<RequestContext> {
  // A suspended or deleted account keeps no powers, staff or member.
  const staffRoles = user.user_status === 'active' ? await loadStaffRoles(db, user.user_id) : [];
  const membership = await loadMembership(db, user.user_id, user.email ?? '');
  // Once a guest becomes a member, the membership is what counts.
  const guest = !membership.session && user.user_status === 'active' ? await loadGuest(db, user.user_id) : null;
  return { userId: user.user_id, staffRoles, guest, marketId: '', pending: null, ...membership };
}

export async function loadGuest(db: Queryable, userId: string): Promise<GuestAccount | null> {
  const rows = await db.query<{ full_name: string; email: string; created_at: Date }>(
    `SELECT g.full_name, u.email, g.created_at FROM guest_accounts g JOIN users u ON u.id = g.user_id WHERE g.user_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL`, [userId]);
  const row = rows[0];
  return row ? { userId, fullName: row.full_name, email: row.email, createdAt: new Date(row.created_at).toISOString() } : null;
}

/** Throws 401 unless a guest account is signed in. */
export function requireGuest(ctx: RequestContext): GuestAccount {
  if (!ctx.guest) throw unauthenticated();
  return ctx.guest;
}

/** Membership, tier and roles for a user. A suspended or lapsed member has no roles, so every member check fails closed. */
export async function loadMembership(db: Queryable, userId: string, email: string): Promise<Pick<RequestContext, 'session' | 'roles'>> {
  const members = await db.query<{ member_id: string; member_number: string; joined_at: Date; market_id: string; tier_name: string; full_name: string }>(
    `SELECT m.id AS member_id, m.member_number, m.joined_at, m.home_market_id AS market_id, t.name AS tier_name, p.full_name
       FROM members m JOIN membership_tiers t ON t.id = m.tier_id JOIN profiles p ON p.user_id = m.user_id
      WHERE m.user_id = $1 AND m.status = 'active'`,
    [userId],
  );
  const member = members[0];
  if (!member) return { session: null, roles: [] };
  const roles = (await db.query<{ role_key: Role }>('SELECT role_key FROM user_roles WHERE user_id = $1 ORDER BY role_key', [userId])).map((row) => row.role_key).filter((key) => ROLES.includes(key));
  return {
    roles,
    session: {
      userId,
      memberId: member.member_id,
      fullName: member.full_name,
      email,
      roles,
      tierName: member.tier_name,
      memberNumber: member.member_number,
      memberSince: new Date(member.joined_at).toISOString().slice(0, 10),
      marketId: member.market_id,
    },
  };
}

/** Staff roles count only while the person's admin console account is active. */
export async function loadStaffRoles(db: Queryable, userId: string): Promise<StaffRole[]> {
  const keys = (await db.query<{ role_key: string }>(`SELECT r.role_key FROM user_roles r JOIN staff_accounts s ON s.user_id = r.user_id AND s.status = 'active' WHERE r.user_id = $1`, [userId])).map((row) => row.role_key);
  return STAFF_ROLES.filter((role) => keys.includes(role));
}

/** Throws 401 when nobody is signed in and 403 when the signed-in user is not staff with this permission. */
export function requireStaff(ctx: RequestContext, permission: StaffPermission): string {
  if (!ctx.userId) throw unauthenticated();
  if (!staffCan(ctx.staffRoles, permission)) throw forbidden('This is for Quintara staff.');
  return ctx.userId;
}

/** Throws 401 for a visitor and 403 for a signed-in user without the permission. */
export function requirePermission(ctx: RequestContext, permission: Permission): void {
  if (can({ roles: ctx.roles }, permission)) return;
  throw ctx.session ? forbidden() : unauthenticated();
}

export function requireMember(ctx: RequestContext, permission: Permission): Session {
  requirePermission(ctx, permission);
  if (!ctx.session) throw unauthenticated();
  return ctx.session;
}

/** Where the current request came from, so every audit entry records it without each caller passing it on. */
export const requestInfo = new AsyncLocalStorage<{ ip: string; userAgent: string }>();

export async function audit(db: Queryable, actorUserId: string | null, action: string, entityType: string, entityId: string, changes: unknown = null): Promise<void> {
  const from = requestInfo.getStore();
  await db.query('INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, changes, ip, user_agent) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
    [actorUserId, action, entityType, entityId, JSON.stringify(changes), from?.ip ?? null, from?.userAgent ?? null]);
}
