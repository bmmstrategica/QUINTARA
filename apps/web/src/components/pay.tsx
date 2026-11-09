'use client';

import { payThrough, useAction } from '@quintara/app-core';
import type { PayOutcome } from '@quintara/app-core';
import { formatMoney } from '@quintara/domain';
import type { Booking } from '@quintara/domain';
import { ActionError } from './states';

/** Where the provider's checkout sends the member back to. */
export const paymentReturnUrl = () => `${window.location.origin}/payments/return`;

/** After paying: true if it was paid here; false (and the browser is on its way to the checkout) otherwise. */
export function follow<T>(outcome: PayOutcome<T> | undefined): outcome is { kind: 'paid'; result: T } {
  if (outcome?.kind === 'checkout') { window.location.assign(outcome.url); return false; }
  return outcome?.kind === 'paid';
}

/** Shown while seats are held: what is owed, until when, and the button that pays it. */
export function PayBooking({ booking, onPaid }: { booking: Booking; onPaid: () => void }) {
  const pay = useAction((api) => payThrough(api, { purpose: 'experience', id: booking.id, returnUrl: paymentReturnUrl() }, (a) => a.payBooking(booking.id)));
  if (booking.status !== 'awaiting_payment') return null;
  const amount = formatMoney(booking.amountDueMinor, booking.currency);
  const until = booking.paymentDueAt
    ? new Intl.DateTimeFormat('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(booking.paymentDueAt))
    : null;
  return (
    <div className="notice">
      <p style={{ margin: 0 }}>Your seats are held{until ? ` until ${until}` : ''}. Pay {amount} to confirm them.</p>
      <ActionError error={pay.error} />
      <p style={{ margin: '0.7rem 0 0' }}>
        <button className="btn small" disabled={pay.pending} onClick={async () => { if (window.confirm(`Pay ${amount} for ${booking.experienceTitle}?`) && follow(await pay.run())) onPaid(); }}>
          {pay.pending ? 'Paying' : `Pay ${amount}`}
        </button>
      </p>
    </div>
  );
}

/** After a cancellation: says plainly whether money came back. */
export function RefundNote({ booking }: { booking: Booking }) {
  if (booking.status !== 'cancelled' || !booking.refundedMinor) return null;
  return <div className="facts">Refunded {formatMoney(booking.refundedMinor, booking.currency)}.</div>;
}
