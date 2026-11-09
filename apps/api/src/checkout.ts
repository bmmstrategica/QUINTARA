/**
 * Paying through a provider's hosted checkout.
 *
 *   1. The app asks to pay (POST /v1/payments/checkout). The booking, order or membership fee is prepared exactly as for
 *      a direct charge (a pending payment row, keyed so repeats cannot charge twice), and the provider opens a checkout.
 *      The member is sent to the provider's own page: card details never reach Quintara.
 *   2. The provider reports the outcome by a signed webhook (POST /v1/payments/webhook). The signature is checked on the
 *      raw body before anything is read.
 *   3. When the member comes back, the app asks how the payment stands (GET /v1/payments/checkout/:id). If the webhook
 *      has not arrived yet, the API asks the provider itself.
 *
 * Settling is exactly once, whichever of 2 and 3 comes first or how often: the payment row is claimed under a lock,
 * and money that arrives for something already paid or cancelled is refunded (see settle* in each module).
 */
import type { CheckoutStatus } from '@quintara/domain';
import { z } from 'zod';
import { settleOrderPayment, prepareOrderPayment } from './boutique.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { conflict, HttpError, notFound, unauthenticated, validation } from './errors.ts';
import { prepareBookingPayment, settleBookingPayment } from './experiences.ts';
import { prepareMembershipPayment, settleMembershipPayment } from './membership.ts';
import { markPaymentFailed } from './payments.ts';
import type { CheckoutState, PaymentProvider, PreparedPayment, Settlement } from './payments.ts';

/** How long seats stay held while the member is on the checkout page. */
export const CHECKOUT_HOLD_MINUTES = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const startInput = z.object({
  purpose: z.enum(['experience', 'boutique', 'membership']),
  /** The booking or order. Not used for a membership fee, which is always the member's own current application. */
  id: z.string().max(80).optional(),
  /** Where the member comes back to. Must be one of the Quintara apps. */
  returnUrl: z.url().max(500),
});


type PaymentRow = { id: string; user_id: string; purpose: string; status: string; checkout_ref: string | null; booking_id: string | null; order_id: string | null; application_id: string | null; failure_reason: string | null };
const SELECT_PAYMENT = 'SELECT id, user_id, purpose, status, checkout_ref, booking_id, order_id, application_id, failure_reason FROM payments';

export async function startCheckout(db: Db, ctx: RequestContext, provider: PaymentProvider, allowedOrigins: ReadonlySet<string>, body: unknown): Promise<{ paymentId: string; url: string }> {
  if (!ctx.userId) throw unauthenticated();
  if (!provider.hosted) throw conflict('Payments are taken directly here, not through a checkout.');
  const parsed = startInput.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const { purpose, id } = parsed.data;
  const back = new URL(parsed.data.returnUrl);
  if (!allowedOrigins.has(back.origin)) throw validation([{ path: ['returnUrl'], message: 'Return to a Quintara app.', code: 'custom' } as never]);
  if (purpose !== 'membership' && !id) throw validation([{ path: ['id'], message: 'Say what is being paid for.', code: 'custom' } as never]);

  let prepared: PreparedPayment;
  if (purpose === 'experience') prepared = await prepareBookingPayment(db, ctx, provider, id!, CHECKOUT_HOLD_MINUTES);
  else if (purpose === 'boutique') prepared = await prepareOrderPayment(db, ctx, provider, id!);
  else {
    const membership = await prepareMembershipPayment(db, ctx, provider);
    if (membership.alreadyPaid) throw conflict('This membership fee has already been paid.');
    prepared = membership;
  }

  // Asking again while a checkout is open returns the same page, so there is never a second checkout to pay.
  const existing = (await db.query<{ checkout_ref: string | null; checkout_url: string | null; status: string }>('SELECT checkout_ref, checkout_url, status FROM payments WHERE id = $1', [prepared.paymentId]))[0];
  if (existing?.status === 'pending' && existing.checkout_ref && existing.checkout_url) {
    const state = await provider.hosted.checkoutState(existing.checkout_ref);
    if (state.status === 'pending') return { paymentId: prepared.paymentId, url: existing.checkout_url };
    await applyState(db, provider, prepared.paymentId, state);
    throw conflict(state.status === 'paid' ? 'This has just been paid.' : 'The last attempt did not go through. Please try again.');
  }

  back.searchParams.set('payment', prepared.paymentId);
  const email = (await db.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [prepared.userId]))[0]?.email ?? null;
  const checkout = await provider.hosted.startCheckout({
    paymentId: prepared.paymentId, amountMinor: prepared.amount, currency: prepared.currency, description: prepared.description,
    idempotencyKey: prepared.key, customerReference: prepared.userId, customerEmail: email, returnUrl: back.toString(),
  });
  await db.query('UPDATE payments SET checkout_ref = $2, checkout_url = $3, updated_at = now() WHERE id = $1', [prepared.paymentId, checkout.checkoutRef, checkout.url]);
  return { paymentId: prepared.paymentId, url: checkout.url };
}

/** How the member's payment stands. If it is still pending, the provider is asked, in case its webhook is late. */
export async function getCheckout(db: Db, ctx: RequestContext, provider: PaymentProvider, paymentId: string): Promise<CheckoutStatus> {
  if (!ctx.userId) throw unauthenticated();
  const load = async () => UUID.test(paymentId) ? (await db.query<PaymentRow>(`${SELECT_PAYMENT} WHERE id = $1 AND user_id = $2`, [paymentId, ctx.userId]))[0] : undefined;
  let payment = await load();
  if (!payment || !['experience', 'boutique', 'membership'].includes(payment.purpose)) throw notFound('This payment is not available.');
  if (payment.status === 'pending' && payment.checkout_ref && provider.hosted) {
    await applyState(db, provider, payment.id, await provider.hosted.checkoutState(payment.checkout_ref));
    payment = (await load())!;
  }
  return {
    paymentId: payment.id, status: payment.status as CheckoutStatus['status'], purpose: payment.purpose as CheckoutStatus['purpose'],
    targetId: payment.booking_id ?? payment.order_id ?? payment.application_id, reason: payment.status === 'failed' ? payment.failure_reason : null,
  };
}

/** A provider's webhook. Unsigned or unreadable deliveries are refused; events about unknown checkouts are ignored. */
export async function handleCheckoutWebhook(db: Db, provider: PaymentProvider, raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<void> {
  if (!provider.hosted) throw new HttpError(404, 'Not found.');
  const event = provider.hosted.readWebhook(raw, headers);
  if (!event) throw new HttpError(401, 'Not signed.');
  const payment = (await db.query<{ id: string }>('SELECT id FROM payments WHERE provider = $1 AND checkout_ref = $2', [provider.name, event.checkoutRef]))[0];
  if (payment) await applyState(db, provider, payment.id, event.state);
}

/** Applies what the provider says about a payment. */
export async function applyState(db: Db, provider: PaymentProvider, paymentId: string, state: CheckoutState): Promise<Settlement | 'failed' | 'pending'> {
  if (state.status === 'pending') return 'pending';
  if (state.status === 'failed') { await markPaymentFailed(db, paymentId, state.reason); return 'failed'; }
  const purpose = (await db.query<{ purpose: string }>('SELECT purpose FROM payments WHERE id = $1', [paymentId]))[0]?.purpose;
  if (purpose === 'experience') return settleBookingPayment(db, provider, paymentId, state.providerPaymentId);
  if (purpose === 'boutique') return settleOrderPayment(db, provider, paymentId, state.providerPaymentId);
  if (purpose === 'membership') return settleMembershipPayment(db, provider, paymentId, state.providerPaymentId);
  throw notFound('This payment is not available.');
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The test checkout's page (development and staging only): what is being paid, and Pay or Decline. Takes no card. */
export function testCheckoutPage(ref: string, amount: string, description: string): string {
  const link = (outcome: string) => `/v1/payments/test-checkout/${encodeURIComponent(ref)}/complete?outcome=${outcome}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test checkout</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f4efe6;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;border:1px solid #2a2a2c;border-radius:12px;text-align:center}
.note{color:#a59d90;font-size:14px}a{display:inline-block;margin:8px;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600}
.pay{background:#f4efe6;color:#0b0b0c}.decline{border:1px solid #a59d90;color:#f4efe6}
</style></head><body><main>
<p class="note">Test checkout: no card is taken and no money moves. A real provider's page replaces this in production.</p>
<h1 style="font-weight:400">${escape(amount)}</h1><p>${escape(description)}</p>
<a class="pay" href="${link('paid')}">Pay</a><a class="decline" href="${link('declined')}">Decline</a>
</main></body></html>`;
}
