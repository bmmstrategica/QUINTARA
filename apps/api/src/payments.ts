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

export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  /** Exchanges a setup token for a saved card. The card number never reaches Quintara. */
  saveCard(request: SaveCardRequest): Promise<SaveCardResult>;
  /** Tells the provider to forget a saved card. */
  removeCard(token: string): Promise<void>;
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
