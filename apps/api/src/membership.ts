/** Turning an approved application into a membership: payment, then activation. */
import { randomUUID } from 'node:crypto';
import type { Application, ApplicationData } from '@quintara/domain';
import { getApplication } from './applications.ts';
import { audit } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { conflict, HttpError, unauthenticated } from './errors.ts';
import type { PaymentProvider } from './payments.ts';

/**
 * Creates the profile, the member record and the member roles for an application.
 * Investor access is never granted here: it is switched on by staff after verification.
 */
export async function activateApplication(tx: Queryable, applicationId: string, actorUserId: string | null): Promise<void> {
  const rows = await tx.query<{ user_id: string; market_id: string; offered_tier_id: string | null; data: ApplicationData; status: string }>(
    'SELECT user_id, market_id, offered_tier_id, data, status FROM membership_applications WHERE id = $1 FOR UPDATE', [applicationId]);
  const application = rows[0];
  if (!application || !application.offered_tier_id) throw conflict('This application has no tier to activate.');
  if (application.status === 'active') return;
  const d = application.data;
  await tx.query(
    `INSERT INTO profiles (user_id, full_name, position, company, industry, city, interests) VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
     ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [application.user_id, d.fullName, d.position, d.company, d.industry, d.city, d.interests]);
  await tx.query(
    // The first term starts today and runs for the plan's months (none for a membership without a term).
    `INSERT INTO members (user_id, member_number, home_market_id, tier_id, term_ends_at)
     SELECT $1, 'Q-' || nextval('member_number_seq'), $2, t.id,
            now() + make_interval(months => COALESCE(t.term_months, CASE t.billing_period WHEN 'year' THEN 12 WHEN 'month' THEN 1 END))
       FROM membership_tiers t WHERE t.id = $3`,
    [application.user_id, application.market_id, application.offered_tier_id]);
  for (const role of ['member', ...(d.asFounder ? ['founder'] : [])]) {
    await tx.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [application.user_id, role]);
  }
  await tx.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`, [application.user_id]);
  await tx.query(`UPDATE membership_applications SET status = 'active', updated_at = now() WHERE id = $1`, [applicationId]);
  await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', 'Your membership is active. Welcome to Quintara.')`, [application.user_id]);
  await audit(tx, actorUserId, 'membership.activated', 'membership_application', applicationId);
}

export async function payMembershipFee(db: Db, ctx: RequestContext, provider: PaymentProvider, idempotencyKey: string | undefined): Promise<Application> {
  if (!ctx.userId) throw unauthenticated();
  const userId = ctx.userId;
  const rows = await db.query<{ id: string; status: string; market_id: string; price_minor: string; currency_code: string; tier_name: string }>(
    `SELECT a.id, a.status, a.market_id, t.price_minor, t.currency_code, t.name AS tier_name
       FROM membership_applications a JOIN membership_tiers t ON t.id = a.offered_tier_id
      WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`, [userId]);
  const application = rows[0];
  if (!application || application.status !== 'payment_pending') throw conflict('There is no membership fee to pay yet.');

  // One payment row per attempt key. A repeat of the same request reuses the row instead of charging again.
  const key = idempotencyKey?.slice(0, 200) || randomUUID();
  const amount = Number(application.price_minor);
  const payment = (await db.query<{ id: string; status: string }>(
    `INSERT INTO payments (user_id, market_id, purpose, application_id, amount_minor, currency_code, provider, idempotency_key)
     VALUES ($1, $2, 'membership', $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING id, status`,
    [userId, application.market_id, application.id, amount, application.currency_code.trim(), provider.name, key]))[0]!;

  if (payment.status !== 'paid') {
    const result = await provider.charge({ amountMinor: amount, currency: application.currency_code.trim(), description: `${application.tier_name} membership`, idempotencyKey: key, customerReference: userId });
    if (result.status === 'failed') {
      await db.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [payment.id, result.reason]);
      throw new HttpError(402, `The payment did not go through. ${result.reason}`);
    }
    await db.tx(async (tx) => {
      await tx.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), updated_at = now() WHERE id = $1`, [payment.id, result.providerPaymentId]);
      await audit(tx, userId, 'payment.paid', 'payment', payment.id, { purpose: 'membership', amountMinor: amount });
      await activateApplication(tx, application.id, userId);
    });
  }
  return (await getApplication(db, ctx))!;
}
