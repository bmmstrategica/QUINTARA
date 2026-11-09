import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './db.ts';

/**
 * Payments sit behind an interface so the provider can differ by market
 * (a South African provider first, an international one later) without touching callers.
 * Quintara never sees card numbers: the provider holds them and returns a reference.
 */
export interface ChargeRequest {
  amountMinor: number;
  currency: string;
  description: string;
  /** The provider de-duplicates on this, so a retry cannot charge twice. */
  idempotencyKey: string;
  customerReference: string;
  /** Charge a saved card without the person present (a renewal). The provider's reference for the card. */
  paymentMethodToken?: string;
}

/** The one-time token from the provider's secure card form, exchanged for a lasting reference to the card. */
export interface SaveCardRequest { setupToken: string; customerReference: string }
export type SaveCardResult =
  | { status: 'saved'; token: string; brand: string; last4: string; expMonth: number; expYear: number }
  | { status: 'failed'; reason: string };

export type ChargeResult = { status: 'paid'; providerPaymentId: string } | { status: 'failed'; reason: string };

export interface RefundRequest {
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}
export type RefundResult = { status: 'refunded'; providerRefundId: string } | { status: 'failed'; reason: string };

/**
 * Paying by redirect, as every card provider's hosted checkout works: Quintara starts a checkout for a pending payment,
 * the member pays on the provider's own page (card details never reach Quintara), and the provider reports the outcome
 * by a signed webhook. The member's return to the app also asks the provider, in case the webhook is late.
 */
export interface CheckoutRequest {
  /** Quintara's payment id: the provider keeps it as its reference. */
  paymentId: string;
  amountMinor: number;
  currency: string;
  description: string;
  idempotencyKey: string;
  customerReference: string;
  customerEmail: string | null;
  /** Where the provider sends the member back afterwards. */
  returnUrl: string;
}
export interface CheckoutStart { checkoutRef: string; url: string }
export type CheckoutState = { status: 'paid'; providerPaymentId: string } | { status: 'failed'; reason: string } | { status: 'pending' };
export interface CheckoutEvent { checkoutRef: string; state: CheckoutState }

export interface HostedCheckout {
  startCheckout(request: CheckoutRequest): Promise<CheckoutStart>;
  /** Asks the provider how a checkout stands. */
  checkoutState(checkoutRef: string): Promise<CheckoutState>;
  /** Checks a webhook's signature on the raw body and reads it. Null when the signature is wrong or the event is not about a checkout. */
  readWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): CheckoutEvent | null;
}

export interface PaymentProvider {
  readonly name: string;
  /** Present when one-off payments go through the provider's hosted checkout rather than a direct charge. */
  readonly hosted?: HostedCheckout;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  /** Exchanges a setup token for a saved card. The card number never reaches Quintara. */
  saveCard(request: SaveCardRequest): Promise<SaveCardResult>;
  /** Tells the provider to forget a saved card. */
  removeCard(token: string): Promise<void>;
}

/**
 * Used in production until a real provider's adapter is configured. It takes no money and marks nothing as paid:
 * every charge and card is refused with a plain message, so a booking, order or membership is never confirmed as
 * paid when no payment was taken. Refunds cannot arise, as nothing was ever charged through it.
 */
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly name = 'unavailable';
  static readonly REASON = 'Online payment is not available yet. Please contact Quintara to complete this payment.';
  async charge(): Promise<ChargeResult> { return { status: 'failed', reason: UnavailablePaymentProvider.REASON }; }
  async refund(): Promise<RefundResult> { return { status: 'failed', reason: UnavailablePaymentProvider.REASON }; }
  async saveCard(): Promise<SaveCardResult> { return { status: 'failed', reason: UnavailablePaymentProvider.REASON }; }
  async removeCard(): Promise<void> {}
}

/** A pending payment, ready to be charged or sent to a checkout. */
export interface PreparedPayment { paymentId: string; key: string; amount: number; currency: string; description: string; userId: string }
/**
 * What settling a payment did. `settled`: the booking, order or membership is paid (or already was, by this payment).
 * `refunded`: the money came in but the thing paid for had changed (cancelled, or paid by another payment), so it was
 * returned.
 */
export type Settlement = 'settled' | 'refunded';

export async function markPaymentFailed(db: Queryable, paymentId: string, reason: string) {
  await db.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`, [paymentId, reason.slice(0, 300)]);
}

/** Whether a provider actually moves money. Simulated and unavailable providers do not. */
export const takesRealPayments = (provider: PaymentProvider) => provider.name !== 'mock' && provider.name !== 'unavailable';

/**
 * Chooses the payment provider for this process. Production never uses the simulated provider (which approves every
 * charge), except on a staging deployment that says so explicitly (DEPLOY_ENV=staging). Until a real adapter is
 * written and configured, production refuses payments rather than pretending to take them.
 */
export function choosePaymentProvider(env: { production: boolean; deployEnv?: string; mode?: string; apiUrl?: string; secret?: string }): PaymentProvider {
  if (env.production && env.deployEnv !== 'staging') return new UnavailablePaymentProvider();
  // Development and staging pay through the test checkout, as production will through a real one. PAYMENTS=simulated
  // charges at once instead, with no redirect.
  if (env.mode === 'simulated' || !env.apiUrl) return new MockPaymentProvider();
  return new TestCheckoutProvider({ apiUrl: env.apiUrl, secret: env.secret || randomBytes(32).toString('hex') });
}

/** Stands in for a real provider in development and tests. Approves everything unless told to fail. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly charges: ChargeRequest[] = [];
  readonly refunds: RefundRequest[] = [];
  failNext = false;
  readonly removedCards: string[] = [];

  /** The test cards: two that are accepted and one that is always declined. */
  async saveCard(request: SaveCardRequest): Promise<SaveCardResult> {
    const year = new Date().getUTCFullYear() + 3;
    const cards: Record<string, [brand: string, last4: string]> = { test_card_visa: ['Visa', '4242'], test_card_mastercard: ['Mastercard', '4444'], test_card_declined: ['Visa', '0002'] };
    const card = cards[request.setupToken];
    if (!card) return { status: 'failed', reason: 'The card could not be saved. Try again, or use another card.' };
    return { status: 'saved', token: `mock_pm_${request.setupToken.slice(10)}_${request.customerReference.slice(0, 8)}`, brand: card[0], last4: card[1], expMonth: 12, expYear: year };
  }
  async removeCard(token: string): Promise<void> { this.removedCards.push(token); }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const earlier = this.refunds.findIndex((r) => r.idempotencyKey === request.idempotencyKey);
    if (earlier < 0) this.refunds.push(request);
    return { status: 'refunded', providerRefundId: `mock_refund_${earlier < 0 ? this.refunds.length : earlier + 1}` };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const earlier = this.charges.findIndex((c) => c.idempotencyKey === request.idempotencyKey);
    if (earlier >= 0) return { status: 'paid', providerPaymentId: `mock_${earlier + 1}` };
    if (this.failNext || request.paymentMethodToken?.startsWith('mock_pm_declined')) {
      this.failNext = false;
      return { status: 'failed', reason: 'The card was declined.' };
    }
    this.charges.push(request);
    return { status: 'paid', providerPaymentId: `mock_${this.charges.length}` };
  }
}

/**
 * A hosted checkout for development and staging, shaped like a real provider's: the member is sent to a page served by
 * the API itself (Pay or Decline, no card), and the outcome comes back as a webhook signed with HMAC-SHA256, checked
 * exactly as a real provider's would be. It takes no money. Saved cards (renewals) use the simulated charges inherited
 * from MockPaymentProvider.
 */
export class TestCheckoutProvider extends MockPaymentProvider implements HostedCheckout {
  readonly hosted: HostedCheckout = this;
  readonly checkouts = new Map<string, { request: CheckoutRequest; state: CheckoutState }>();
  private readonly options: { apiUrl: string; secret: string };
  constructor(options: { apiUrl: string; secret: string }) { super(); this.options = options; }

  async startCheckout(request: CheckoutRequest): Promise<CheckoutStart> {
    // One checkout per payment attempt: asking again returns the same one.
    for (const [ref, c] of this.checkouts) if (c.request.idempotencyKey === request.idempotencyKey && c.state.status === 'pending') return { checkoutRef: ref, url: this.pageUrl(ref) };
    const ref = `tc_${randomBytes(18).toString('base64url')}`;
    this.checkouts.set(ref, { request, state: { status: 'pending' } });
    return { checkoutRef: ref, url: this.pageUrl(ref) };
  }
  async checkoutState(ref: string): Promise<CheckoutState> { return this.checkouts.get(ref)?.state ?? { status: 'failed', reason: 'This checkout does not exist.' }; }

  /** What the test page does when the member chooses: records the outcome and returns the signed webhook a provider would send. */
  complete(ref: string, outcome: 'paid' | 'declined'): { body: string; signature: string; returnUrl: string } | null {
    const checkout = this.checkouts.get(ref);
    if (!checkout) return null;
    if (checkout.state.status === 'pending') {
      checkout.state = outcome === 'paid' ? { status: 'paid', providerPaymentId: `tc_pay_${randomBytes(9).toString('hex')}` } : { status: 'failed', reason: 'The card was declined.' };
    }
    const body = JSON.stringify({ type: 'checkout.updated', checkoutRef: ref, state: checkout.state });
    return { body, signature: this.sign(body), returnUrl: checkout.request.returnUrl };
  }
  readWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): CheckoutEvent | null {
    const given = String(headers['x-test-checkout-signature'] ?? '');
    const expected = this.sign(raw.toString('utf8'));
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
    try {
      const event = JSON.parse(raw.toString('utf8')) as { type?: string; checkoutRef?: string; state?: CheckoutState };
      return event.type === 'checkout.updated' && event.checkoutRef && event.state ? { checkoutRef: event.checkoutRef, state: event.state } : null;
    } catch { return null; }
  }
  sign(body: string) { return createHmac('sha256', this.options.secret).update(body).digest('hex'); }
  private pageUrl(ref: string) { return `${this.options.apiUrl}/v1/payments/test-checkout/${ref}`; }
}
