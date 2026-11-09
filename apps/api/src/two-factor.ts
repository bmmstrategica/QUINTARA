/**
 * Two-factor authentication: after the code sent by email, a second code from an authenticator app
 * (Google Authenticator, Microsoft Authenticator, 1Password and the like, using TOTP, RFC 6238).
 *
 * How it is kept safe:
 *  - A sign-in is not complete until the second step is done. Until then the session can do nothing but that step:
 *    every other route sees nobody signed in, so nothing can be reached by skipping it.
 *  - With the policy `required` (production), every account with an email address (members, guest accounts,
 *    applicants and staff) must set up an authenticator at its first sign-in, and cannot turn it off.
 *  - The authenticator secret is encrypted (AES-256-GCM, MFA_ENCRYPTION_KEY) and never shown again once set up.
 *  - A code works once (the last step used is kept) and only within thirty seconds either side of now.
 *  - Five wrong codes end the sign-in; ten wrong codes in a row lock the second step for fifteen minutes.
 *  - Ten recovery codes are given once, for a lost phone. Only their hashes are kept and each works once.
 *  - Finishing the second step replaces the session with a new one, so a session token seen before it is useless.
 *  - Turning it on or off, a recovery code being used, and a reset by staff are all audited, and the person is
 *    told by email.
 *  - Staff can reset someone's second step (a lost phone and lost codes). That signs the person out everywhere,
 *    and they set it up again at their next sign-in, after proving their email address again.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { openAddress, sealAddress } from './calendar.ts';
import { audit, createSession, hashToken, requireStaff, revokeAllSessions } from './context.ts';
import type { RequestContext, SessionKind } from './context.ts';
import type { Db, Queryable } from './db.ts';
import type { EmailProvider } from './email.ts';
import { conflict, HttpError, notFound, unauthenticated, validation } from './errors.ts';

export type TwoFactorPolicy = 'required' | 'optional' | 'off';
export interface TwoFactorConfig {
  policy: TwoFactorPolicy;
  /** Encrypts authenticator secrets. 32 characters or more. */
  key: string;
  /** What the authenticator app shows the account under. */
  issuer: string;
  /** App store review: the review account's second step accepts this fixed code. */
  review?: { email: string; code: string } | null;
}

const STEP_SECONDS = 30;
const DIGITS = 6;
const SESSION_TRIES = 5;
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;

/* ---------- TOTP ---------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The code an authenticator shows for a time step. */
export function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** The step a code matches, within one step either side of now, and only if it is later than the last one used. */
export function matchTotp(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  const step = currentStep(now);
  let found: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const a = Buffer.from(totp(secret, s)), b = Buffer.from(code.padEnd(DIGITS).slice(0, DIGITS));
    // Every candidate is compared, in constant time, so timing says nothing about which one matched.
    if (a.length === b.length && timingSafeEqual(a, b) && s > lastStep && found === null) found = s;
  }
  return found;
}

/* ---------- Recovery codes ---------- */

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o, 1/l/i
const recoveryHash = (userId: string, code: string) => createHash('sha256').update(`${userId}:${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`).digest('hex');
function newRecoveryCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
async function issueRecoveryCodes(db: Queryable, userId: string): Promise<string[]> {
  await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  for (const code of codes) await db.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, recoveryHash(userId, code)]);
  return codes;
}

/* ---------- Who is asking ---------- */

const norm = (email: string) => email.trim().toLowerCase();
const isReview = (cfg: TwoFactorConfig, email: string | null) => !!email && !!cfg.review && norm(cfg.review.email) === norm(email);

interface Enrolment { confirmed: boolean; secret: Buffer; lastStep: number; failed: number; lockedUntil: Date | null }
async function enrolment(db: Queryable, cfg: TwoFactorConfig, userId: string): Promise<Enrolment | null> {
  const row = (await db.query<{ totp_secret_enc: string; confirmed_at: string | null; last_step: string; failed_attempts: number; locked_until: string | null }>(
    'SELECT totp_secret_enc, confirmed_at, last_step, failed_attempts, locked_until FROM user_mfa WHERE user_id = $1', [userId]))[0];
  if (!row) return null;
  return { confirmed: Boolean(row.confirmed_at), secret: Buffer.from(openAddress(row.totp_secret_enc, cfg.key), 'base64'), lastStep: Number(row.last_step), failed: row.failed_attempts, lockedUntil: row.locked_until ? new Date(row.locked_until) : null };
}

/**
 * What a new sign-in still needs: nothing, the code from the authenticator, or setting one up. Accounts without an
 * email address (a device that placed a guest order) have nothing to prove beyond the device itself.
 */
export async function secondStepFor(db: Queryable, cfg: TwoFactorConfig, userId: string): Promise<'complete' | 'verify' | 'enrol'> {
  if (cfg.policy === 'off') return 'complete';
  const user = (await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]))[0];
  if (!user?.email) return 'complete';
  if (isReview(cfg, user.email)) return 'verify';
  const found = await enrolment(db, cfg, userId);
  if (found?.confirmed) return 'verify';
  return cfg.policy === 'required' ? 'enrol' : 'complete';
}

/** Starts a session after the email code: complete, or waiting for the second step. */
export async function startSession(db: Queryable, cfg: TwoFactorConfig, userId: string, kind: SessionKind = 'app'): Promise<{ token: string; state: 'complete' | 'verify' | 'enrol' }> {
  const state = await secondStepFor(db, cfg, userId);
  const token = await createSession(db, userId, kind, state);
  if (state !== 'complete') await audit(db, userId, 'auth.second_step_required', 'user', userId, { state, kind });
  return { token, state };
}

/** The signed-in person, whether their session is complete or still at the second step. */
function personOf(ctx: RequestContext): { userId: string; state: 'complete' | 'verify' | 'enrol'; token: string | null } {
  if (ctx.pending) return { userId: ctx.pending.userId, state: ctx.pending.state, token: ctx.pending.token };
  if (ctx.userId) return { userId: ctx.userId, state: 'complete', token: null };
  throw unauthenticated();
}

export interface TwoFactorStatus {
  /** none: nobody signed in. verify/enrol: the second step of a sign-in. on/off: a complete session. */
  state: 'none' | 'verify' | 'enrol' | 'on' | 'off';
  required: boolean;
  recoveryCodesLeft: number;
  enabledAt: string | null;
}

export async function status(db: Queryable, cfg: TwoFactorConfig, ctx: RequestContext): Promise<TwoFactorStatus> {
  if (!ctx.pending && !ctx.userId) return { state: 'none', required: cfg.policy === 'required', recoveryCodesLeft: 0, enabledAt: null };
  const who = personOf(ctx);
  const row = (await db.query<{ confirmed_at: string | null }>('SELECT confirmed_at FROM user_mfa WHERE user_id = $1', [who.userId]))[0];
  const left = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [who.userId]))[0]!.n);
  const state = who.state !== 'complete' ? who.state : row?.confirmed_at ? 'on' : 'off';
  return { state, required: cfg.policy === 'required', recoveryCodesLeft: left, enabledAt: row?.confirmed_at ? new Date(row.confirmed_at).toISOString() : null };
}

const codeSchema = z.object({ code: z.string().trim().min(6).max(20) });
const readCode = (body: unknown) => {
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  return parsed.data.code.replace(/\s/g, '');
};
const isTotpShape = (code: string) => /^\d{6}$/.test(code);

/**
 * Starts setting up an authenticator: a new secret, as a QR code and as text to type in. Allowed during the
 * second step of a sign-in that requires it, for someone without one, or (with the current code) to move to a new
 * phone.
 */
export async function beginSetup(db: Queryable, cfg: TwoFactorConfig, ctx: RequestContext, body: unknown) {
  const who = personOf(ctx);
  if (who.state === 'verify') throw new HttpError(403, 'Enter the code from your authenticator app first.');
  if (cfg.policy === 'off') throw new HttpError(404, 'Two-factor authentication is not available.');
  const found = await enrolment(db, cfg, who.userId);
  if (found?.confirmed) {
    // Replacing a working authenticator needs a code from it, so a borrowed session cannot move it elsewhere.
    const code = readCode(body);
    if (!isTotpShape(code) || matchTotp(found.secret, code, found.lastStep) === null) throw new HttpError(422, 'That code is not right. Enter the current code from your authenticator app.', { code: 'Not right' });
  }
  const email = (await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [who.userId]))[0]?.email ?? 'account';
  const secret = randomBytes(20);
  const sealed = sealAddress(secret.toString('base64'), cfg.key);
  if (found?.confirmed) {
    // Kept beside the working one until the new one is confirmed: stored as a pending replacement.
    await db.query(`INSERT INTO user_mfa_pending (user_id, totp_secret_enc) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, created_at = now()`, [who.userId, sealed]);
  } else {
    await db.query(`INSERT INTO user_mfa (user_id, totp_secret_enc) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, confirmed_at = NULL, last_step = 0, updated_at = now()`, [who.userId, sealed]);
  }
  const key = base32(secret);
  const label = encodeURIComponent(`${cfg.issuer}:${email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${key}&issuer=${encodeURIComponent(cfg.issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  const qr = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  await audit(db, who.userId, 'mfa.setup_started', 'user', who.userId);
  return { secret: key.replace(/(.{4})/g, '$1 ').trim(), otpauthUrl, qr };
}

/** Confirms the authenticator with its first code. Returns the recovery codes, shown once, and a fresh session when this finishes a sign-in. */
export async function confirmSetup(db: Db, cfg: TwoFactorConfig, mail: EmailProvider, ctx: RequestContext, body: unknown): Promise<{ recoveryCodes: string[]; newToken: string | null }> {
  const who = personOf(ctx);
  if (who.state === 'verify') throw new HttpError(403, 'Enter the code from your authenticator app first.');
  const code = readCode(body);
  const replacing = (await db.query<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM user_mfa_pending WHERE user_id = $1 AND created_at > now() - interval \'30 minutes\'', [who.userId]))[0];
  const current = await enrolment(db, cfg, who.userId);
  const secret = replacing ? Buffer.from(openAddress(replacing.totp_secret_enc, cfg.key), 'base64') : current && !current.confirmed ? current.secret : null;
  if (!secret) throw conflict('Start setting up your authenticator app again.');
  const step = isTotpShape(code) ? matchTotp(secret, code, replacing ? 0 : current?.lastStep ?? 0) : null;
  if (step === null) throw new HttpError(422, 'That code is not right. Check the time on your phone is set automatically, and enter the code now showing.', { code: 'Not right' });
  return db.tx(async (tx) => {
    if (replacing) {
      await tx.query('UPDATE user_mfa SET totp_secret_enc = $2, confirmed_at = now(), last_step = $3, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1', [who.userId, replacing.totp_secret_enc, step]);
      await tx.query('DELETE FROM user_mfa_pending WHERE user_id = $1', [who.userId]);
    } else {
      await tx.query('UPDATE user_mfa SET confirmed_at = now(), last_step = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1', [who.userId, step]);
    }
    const recoveryCodes = await issueRecoveryCodes(tx, who.userId);
    await audit(tx, who.userId, replacing ? 'mfa.authenticator_replaced' : 'mfa.enabled', 'user', who.userId);
    let newToken: string | null = null;
    if (who.state === 'enrol' && who.token) {
      // The sign-in is now complete: a fresh session replaces the half-finished one.
      const kind = (await tx.query<{ kind: SessionKind }>('SELECT kind FROM sessions WHERE token_hash = $1', [hashToken(who.token)]))[0]?.kind ?? 'app';
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(who.token)]);
      newToken = await createSession(tx, who.userId, kind, 'complete');
      await audit(tx, who.userId, 'auth.signed_in', 'user', who.userId, { method: 'email_code_and_authenticator', kind });
    }
    await notify(tx, mail, who.userId, replacing ? 'Your authenticator app was changed' : 'Two-factor authentication is on',
      replacing ? 'Your Quintara account now uses a new authenticator app. The old one no longer works.' : 'Your Quintara account is now protected by a code from your authenticator app as well as your email.');
    return { recoveryCodes, newToken };
  });
}

/** The second step of a sign-in: a code from the authenticator, or a recovery code. Returns the new session's token. */
export async function verify(db: Db, cfg: TwoFactorConfig, mail: EmailProvider, ctx: RequestContext, body: unknown): Promise<string> {
  if (!ctx.pending || ctx.pending.state !== 'verify') throw new HttpError(409, 'There is no sign-in waiting for a code.');
  const { userId, token } = ctx.pending;
  const code = readCode(body);
  const user = (await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]))[0];
  const found = await enrolment(db, cfg, userId);
  if (found?.lockedUntil && found.lockedUntil > new Date()) throw new HttpError(429, 'Too many wrong codes. Wait fifteen minutes, then try again.');

  let how: 'authenticator' | 'recovery_code' | 'review' | null = null;
  if (isReview(cfg, user?.email ?? null) && isTotpShape(code)) {
    const a = Buffer.from(code), b = Buffer.from(cfg.review!.code);
    if (a.length === b.length && timingSafeEqual(a, b)) how = 'review';
  } else if (found?.confirmed && isTotpShape(code)) {
    const step = matchTotp(found.secret, code, found.lastStep);
    // Claimed in one statement, so the same code cannot be used by two requests at once.
    if (step !== null && (await db.query('UPDATE user_mfa SET last_step = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1 AND last_step < $2 RETURNING 1', [userId, step])).length) how = 'authenticator';
  } else if (found?.confirmed && /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code)) {
    const used = await db.query('UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING 1', [userId, recoveryHash(userId, code)]);
    if (used.length) how = 'recovery_code';
  }

  if (!how) {
    const tries = (await db.query<{ mfa_failures: number }>('UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE token_hash = $1 RETURNING mfa_failures', [hashToken(token)]))[0]?.mfa_failures ?? SESSION_TRIES;
    if (found) await db.query(`UPDATE user_mfa SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE user_id = $1`, [userId, LOCK_AFTER, LOCK_MINUTES]);
    await audit(db, userId, 'mfa.code_rejected', 'user', userId, { tries });
    if (tries >= SESSION_TRIES) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
      throw new HttpError(401, 'Too many wrong codes. Sign in again from the start.');
    }
    throw new HttpError(422, 'That code is not right. Enter the code now showing in your authenticator app, or one of your recovery codes.', { code: 'Not right' });
  }

  return db.tx(async (tx) => {
    const kind = (await tx.query<{ kind: SessionKind }>('SELECT kind FROM sessions WHERE token_hash = $1', [hashToken(token)]))[0]?.kind ?? 'app';
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
    const fresh = await createSession(tx, userId, kind, 'complete');
    await audit(tx, userId, 'auth.signed_in', 'user', userId, { method: `email_code_and_${how}`, kind });
    if (how === 'recovery_code') {
      const left = Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]))[0]!.n);
      await notify(tx, mail, userId, 'A recovery code was used', `A recovery code was used to sign in to your Quintara account. ${left} ${left === 1 ? 'code is' : 'codes are'} left. If this was not you, contact the Quintara desk at once.`);
    }
    return fresh;
  });
}

/** New recovery codes, replacing the old ones. Needs a current code from the authenticator. */
export async function regenerateRecoveryCodes(db: Db, cfg: TwoFactorConfig, ctx: RequestContext, body: unknown): Promise<string[]> {
  if (!ctx.userId) throw unauthenticated();
  const found = await enrolment(db, cfg, ctx.userId);
  if (!found?.confirmed) throw conflict('Turn on two-factor authentication first.');
  const code = readCode(body);
  const step = isTotpShape(code) ? matchTotp(found.secret, code, found.lastStep) : null;
  if (step === null || !(await db.query('UPDATE user_mfa SET last_step = $2 WHERE user_id = $1 AND last_step < $2 RETURNING 1', [ctx.userId, step])).length) throw new HttpError(422, 'That code is not right.', { code: 'Not right' });
  const codes = await issueRecoveryCodes(db, ctx.userId);
  await audit(db, ctx.userId, 'mfa.recovery_codes_replaced', 'user', ctx.userId);
  return codes;
}

/** Turns two-factor off. Not possible where it is required. Needs a current code. */
export async function disable(db: Db, cfg: TwoFactorConfig, mail: EmailProvider, ctx: RequestContext, body: unknown): Promise<void> {
  if (!ctx.userId) throw unauthenticated();
  if (cfg.policy === 'required') throw new HttpError(403, 'Two-factor authentication is required for every Quintara account. To move it to a new phone, set up a new authenticator instead.');
  const found = await enrolment(db, cfg, ctx.userId);
  if (!found?.confirmed) return;
  const code = readCode(body);
  if (!isTotpShape(code) || matchTotp(found.secret, code, found.lastStep) === null) throw new HttpError(422, 'That code is not right.', { code: 'Not right' });
  await db.query('DELETE FROM user_mfa WHERE user_id = $1', [ctx.userId]);
  await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [ctx.userId]);
  await audit(db, ctx.userId, 'mfa.disabled', 'user', ctx.userId);
  await notify(db, mail, ctx.userId, 'Two-factor authentication is off', 'Two-factor authentication was turned off for your Quintara account. If this was not you, contact the Quintara desk at once.');
}

/**
 * Staff: clears someone's authenticator and recovery codes after they have lost both, once their identity has been
 * checked. Signs them out everywhere; they set up a new authenticator at their next sign-in.
 */
export async function adminReset(db: Db, mail: EmailProvider, ctx: RequestContext, userId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.staff.manage');
  const parsed = z.object({ reason: z.string().trim().min(5, 'Say how the person was identified').max(300) }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (staffId === userId) throw new HttpError(403, 'Another administrator must reset your own two-factor authentication.');
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !(await db.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]))[0]) throw notFound('This account does not exist.');
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM user_mfa WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM user_mfa_pending WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    await revokeAllSessions(tx, userId);
    await audit(tx, staffId, 'mfa.reset_by_staff', 'user', userId, { reason: parsed.data.reason });
    await notify(tx, mail, userId, 'Your two-factor authentication was reset', 'At your request, the Quintara team reset two-factor authentication on your account and signed you out everywhere. Set up your authenticator app again when you next sign in. If you did not ask for this, contact the Quintara desk at once.');
  });
}

/** A security notice by email. A mail failure never blocks the change itself. */
async function notify(db: Queryable, mail: EmailProvider, userId: string, subject: string, text: string) {
  const email = (await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]))[0]?.email;
  if (!email) return;
  try { await mail.send({ to: email, subject: `Quintara security: ${subject}`, text: `${text}\n\nQuintara` }); } catch { /* logged by the provider; the change stands */ }
}
