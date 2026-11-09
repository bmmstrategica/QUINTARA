/**
 * Sign-in by a one-time code sent by email: the production sign-in for members, guest accounts, applicants and
 * staff. Proving the address is proving the account; there are no passwords to steal or reuse.
 *
 * - A code is six digits, lasts ten minutes, is checked at most five times, and works once.
 * - The answer to "send me a code" is the same whether or not the address has an account, so the endpoint cannot
 *   be used to find out who is a member.
 * - Only hashes of the address and the code are stored.
 * - App store reviewers cannot receive email, so one review account may be given a fixed code in the settings.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from './db.ts';
import type { EmailProvider } from './email.ts';
import { HttpError } from './errors.ts';

export type AuthMethod = 'dev' | 'code';
export type CodePurpose = 'sign_in' | 'join' | 'staff';
export const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const MAX_CODES_PER_QUARTER_HOUR = 5;

/** For app store review: one address that signs in with a fixed code, without email. */
export interface ReviewAccount { email: string; code: string }

const norm = (email: string) => email.trim().toLowerCase();
const emailHash = (email: string) => createHash('sha256').update(norm(email)).digest('hex');
const codeHash = (email: string, code: string) => createHash('sha256').update(`${norm(email)}:${code}`).digest('hex');

export function readEmail(body: unknown): string {
  const email = String((body as { email?: unknown } | null)?.email ?? '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) throw new HttpError(422, 'Enter a valid email address.', { email: 'Enter a valid email address' });
  return email;
}
export function readCode(body: unknown): string {
  const code = String((body as { code?: unknown } | null)?.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new HttpError(422, 'Enter the six-digit code from the email.', { code: 'Enter the six-digit code from the email' });
  return code;
}
const isReview = (review: ReviewAccount | null | undefined, email: string) => !!review && norm(review.email) === norm(email);

/** Whether a code may be sent for this address and purpose. The caller never tells the person. */
async function eligible(db: Queryable, email: string, purpose: CodePurpose): Promise<boolean> {
  const user = (await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND status IN ('active', 'pending') AND deleted_at IS NULL`, [email]))[0];
  if (purpose === 'join') return !user;
  if (!user) return false;
  if (purpose === 'staff') return (await db.query(`SELECT 1 FROM user_roles r JOIN staff_accounts s ON s.user_id = r.user_id AND s.status = 'active' WHERE r.user_id = $1 AND r.role_key IN ('admin', 'concierge')`, [user.id])).length > 0;
  return true;
}

/** Sends a code if the address may have one. Always resolves the same way. */
export async function requestCode(db: Db, mail: EmailProvider, review: ReviewAccount | null | undefined, email: string, purpose: CodePurpose): Promise<void> {
  if (isReview(review, email)) return;
  const recent = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sign_in_codes WHERE email_hash = $1 AND created_at > now() - interval '15 minutes'`, [emailHash(email)]);
  if (Number(recent[0]!.n) >= MAX_CODES_PER_QUARTER_HOUR) return;
  if (!(await eligible(db, email, purpose))) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(`INSERT INTO sign_in_codes (email_hash, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [emailHash(email), purpose, codeHash(email, code), CODE_MINUTES]);
  const what = purpose === 'join' ? 'create your Quintara account' : purpose === 'staff' ? 'sign in to the Quintara admin console' : 'sign in to Quintara';
  await mail.send({
    to: email.trim(),
    subject: `Your Quintara code: ${code}`,
    text: `Your code to ${what} is ${code}.\n\nIt works once, for the next ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email; nobody can sign in without the code.\n\nQuintara`,
  });
}

/** True when the code is right for this address and purpose. A right code is used up; a wrong one counts as a try. */
export async function checkCode(db: Db, review: ReviewAccount | null | undefined, email: string, code: string, purpose: CodePurpose): Promise<boolean> {
  if (isReview(review, email)) {
    const a = Buffer.from(code), b = Buffer.from(review!.code);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return db.tx(async (tx) => {
    const row = (await tx.query<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM sign_in_codes WHERE email_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [emailHash(email), purpose]))[0];
    if (!row || row.attempts >= MAX_TRIES) return false;
    const a = Buffer.from(row.code_hash), b = Buffer.from(codeHash(email, code));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      await tx.query('UPDATE sign_in_codes SET used_at = now() WHERE id = $1', [row.id]);
      return true;
    }
    await tx.query('UPDATE sign_in_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return false;
  });
}

export const WRONG_CODE = 'That code is not right, or it has expired. Ask for a new one.';
