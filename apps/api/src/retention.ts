/**
 * Data retention (POPIA s14: personal information is not kept longer than its purpose needs).
 *
 * Working records that only exist to make something happen are deleted once they have done it and a short grace
 * period has passed. What is kept is decided elsewhere and not touched here: the audit log and staff activity (legal
 * and security record, copied to write-once storage), payments (accounting), members' own content, and confirmed QÉRA
 * actions (counted in insights). A closed account is erased by privacy.ts after its cooling-off period.
 *
 * The periods are a starting point for legal review, each one settable (RETENTION_*_DAYS); see SECURITY.md.
 */
import type { Db } from './db.ts';

export interface RetentionPolicy {
  /** Sessions signed out or expired this many days ago (their push devices go with them). */
  sessionDays: number;
  /** Sign-in codes used or expired this many days ago. */
  signInCodeDays: number;
  /** Two-factor set-ups started and never finished. */
  mfaPendingDays: number;
  /** Emails sent, skipped or given up on (the subject line and who it went to). */
  emailDays: number;
  /** QÉRA proposals not acted on: cancelled, superseded, failed or left to expire. */
  proposalDays: number;
  /** WhatsApp message ids, kept only to ignore Meta's retries of the same message. */
  whatsappDays: number;
  /** Daily QÉRA time counters of guest accounts. */
  guestUsageDays: number;
  /** Push devices switched off (uninstalled, token refused) and not seen since. */
  pushDeviceDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  sessionDays: 30, signInCodeDays: 1, mfaPendingDays: 1, emailDays: 90, proposalDays: 90, whatsappDays: 30, guestUsageDays: 30, pushDeviceDays: 90,
};

const ENV: Record<keyof RetentionPolicy, string> = {
  sessionDays: 'RETENTION_SESSION_DAYS', signInCodeDays: 'RETENTION_SIGN_IN_CODE_DAYS', mfaPendingDays: 'RETENTION_MFA_PENDING_DAYS',
  emailDays: 'RETENTION_EMAIL_DAYS', proposalDays: 'RETENTION_PROPOSAL_DAYS', whatsappDays: 'RETENTION_WHATSAPP_DAYS',
  guestUsageDays: 'RETENTION_GUEST_USAGE_DAYS', pushDeviceDays: 'RETENTION_PUSH_DEVICE_DAYS',
};

/** The policy from the environment: each RETENTION_*_DAYS a whole number of days from 1 to 3650, else the default. */
export function retentionFromEnv(env: Record<string, string | undefined>): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(ENV) as (keyof RetentionPolicy)[]) {
    const raw = env[ENV[key]]?.trim();
    if (!raw) continue;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error(`${ENV[key]} must be a whole number of days from 1 to 3650.`);
    policy[key] = days;
  }
  return policy;
}

export type RetentionResult = Record<keyof RetentionPolicy, number>;

/** Deletes what the policy says has been kept long enough. Returns how many rows went, by kind. */
export async function purgeExpiredData(db: Db, policy: RetentionPolicy = DEFAULT_RETENTION): Promise<RetentionResult> {
  const del = async (sql: string, days: number) => (await db.query(`WITH gone AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM gone`, [days]))[0] as { n: number };
  const ago = `now() - make_interval(days => $1::int)`;
  return {
    sessionDays: (await del(`DELETE FROM sessions WHERE coalesce(revoked_at, expires_at) < ${ago} AND (revoked_at IS NOT NULL OR expires_at < now())`, policy.sessionDays)).n,
    signInCodeDays: (await del(`DELETE FROM sign_in_codes WHERE coalesce(used_at, expires_at) < ${ago}`, policy.signInCodeDays)).n,
    mfaPendingDays: (await del(`DELETE FROM user_mfa_pending WHERE created_at < ${ago}`, policy.mfaPendingDays)).n,
    emailDays: (await del(`DELETE FROM email_outbox WHERE status <> 'pending' AND coalesce(sent_at, created_at) < ${ago}`, policy.emailDays)).n,
    proposalDays: (await del(`DELETE FROM qera_proposals WHERE (status IN ('cancelled', 'superseded', 'failed') OR (status = 'pending' AND expires_at < now())) AND coalesce(decided_at, expires_at) < ${ago}`, policy.proposalDays)).n,
    whatsappDays: (await del(`DELETE FROM whatsapp_events WHERE created_at < ${ago}`, policy.whatsappDays)).n,
    guestUsageDays: (await del(`DELETE FROM qera_guest_usage WHERE usage_day < (now() - make_interval(days => $1::int))::date`, policy.guestUsageDays)).n,
    pushDeviceDays: (await del(`DELETE FROM push_devices WHERE disabled_at IS NOT NULL AND greatest(disabled_at, last_seen_at) < ${ago}`, policy.pushDeviceDays)).n,
  };
}
