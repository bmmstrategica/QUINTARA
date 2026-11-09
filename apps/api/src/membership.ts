/** Turning an approved application into a membership: payment, then activation. */
import type { Application, ApplicationData } from '@quintara/domain';
import { getApplication } from './applications.ts';
import { audit } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { conflict, HttpError, notFound, unauthenticated } from './errors.ts';
import { refundPayment } from './experiences.ts';
import { markPaymentFailed } from './payments.ts';
import type { PaymentProvider, PreparedPayment, Settlement } from './payments.ts';

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

/** Sets the money aside for an approved application's fee: a pending payment row. */
export async function prepareMembershipPayment(db: Db, ctx: RequestContext, provider: PaymentProvider, idempotencyKey?: string): Promise<PreparedPayment & { alreadyPaid: boolean }> {
  if (!ctx.userId) throw unauthenticated();
  const userId = ctx.userId;
  const rows = await db.query<{ id: string; status: string; market_id: string; price_minor: string; currency_code: string; tier_name: string }>(
    `SELECT a.id, a.status, a.market_id, t.price_minor, t.currency_code, t.name AS tier_name
       FROM membership_applications a JOIN membership_tiers t ON t.id = a.offered_tier_id
      WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`, [userId]);
  const application = rows[0];
  if (!application || application.status !== 'payment_pending') throw conflict('There is no membership fee to pay yet.');
  // One payment row per attempt. The key is the caller's, or else comes from the application and the attempt, so a
  // double click or a second tab can never charge twice. It moves on only after a declined attempt.
  const failed = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM payments WHERE application_id = $1 AND status = 'failed'`, [application.id]))[0]!.n);
  const key = idempotencyKey?.slice(0, 200) || `membership:${application.id}:${failed}`;
  const amount = Number(application.price_minor), currency = application.currency_code.trim();
  const payment = (await db.query<{ id: string; status: string; application_id: string | null }>(
    `INSERT INTO payments (user_id, market_id, purpose, application_id, amount_minor, currency_code, provider, idempotency_key)
     VALUES ($1, $2, 'membership', $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING id, status, application_id`,
    [userId, application.market_id, application.id, amount, currency, provider.name, key]))[0]!;
  if (payment.application_id !== application.id) throw conflict('That payment reference belongs to something else.');
  return { paymentId: payment.id, key, amount, currency, description: `${application.tier_name} membership`, userId, alreadyPaid: payment.status === 'paid' };
}

/**
 * Records that a membership fee came in and activates the membership. Exactly once; a repeat changes nothing. If the
 * application is no longer waiting for payment (paid another way, or withdrawn), this money is refunded.
 */
export async function settleMembershipPayment(db: Db, provider: PaymentProvider, paymentId: string, providerPaymentId: string): Promise<Settlement> {
  const outcome = await db.tx(async (tx) => {
    const payment = (await tx.query<{ user_id: string; application_id: string | null; amount_minor: string; status: string }>(
      'SELECT user_id, application_id, amount_minor, status FROM payments WHERE id = $1 FOR UPDATE', [paymentId]))[0];
    if (!payment?.application_id) throw notFound('This payment is not for a membership.');
    if (payment.status === 'paid') return { result: 'settled' as const, userId: payment.user_id };
    if (payment.status === 'refunded') return { result: 'refunded' as const, userId: payment.user_id };
    const application = (await tx.query<{ status: string }>('SELECT status FROM membership_applications WHERE id = $1 FOR UPDATE', [payment.application_id]))[0];
    await tx.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1`, [paymentId, providerPaymentId]);
    if (application?.status !== 'payment_pending') return { result: 'refund' as const, userId: payment.user_id };
    await audit(tx, payment.user_id, 'payment.paid', 'payment', paymentId, { purpose: 'membership', amountMinor: Number(payment.amount_minor) });
    await activateApplication(tx, payment.application_id, payment.user_id);
    return { result: 'settled' as const, userId: payment.user_id };
  });
  if (outcome.result !== 'refund') return outcome.result;
  await refundPayment(db, provider, outcome.userId, paymentId);
  return 'refunded';
}

/** Pays the fee by charging the provider directly (simulated payments). Hosted providers use a checkout instead. */
export async function payMembershipFee(db: Db, ctx: RequestContext, provider: PaymentProvider, idempotencyKey: string | undefined): Promise<Application> {
  if (provider.hosted) throw conflict('Please pay through the secure checkout.');
  const prepared = await prepareMembershipPayment(db, ctx, provider, idempotencyKey);
  if (!prepared.alreadyPaid) {
    const result = await provider.charge({ amountMinor: prepared.amount, currency: prepared.currency, description: prepared.description, idempotencyKey: prepared.key, customerReference: prepared.userId });
    if (result.status === 'failed') {
      await markPaymentFailed(db, prepared.paymentId, result.reason);
      throw new HttpError(402, `The payment did not go through. ${result.reason}`);
    }
    if ((await settleMembershipPayment(db, provider, prepared.paymentId, result.providerPaymentId)) === 'refunded') {
      throw conflict('This application changed before the payment finished. You have been refunded.');
    }
  }
  return (await getApplication(db, ctx))!;
}
