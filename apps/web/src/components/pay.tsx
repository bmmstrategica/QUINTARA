'use client';

import { useAction } from '@quintara/app-core';
import { formatMoney } from '@quintara/domain';
import type { Booking } from '@quintara/domain';
import { ActionError } from './states';

/** Shown while seats are held: what is owed, until when, and the button that pays it. */
export function PayBooking({ booking, onPaid }: { booking: Booking; onPaid: () => void }) {
  const pay = useAction((api) => api.payBooking(booking.id));
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
        <button className="btn small" disabled={pay.pending} onClick={async () => { if (window.confirm(`Pay ${amount} for ${booking.experienceTitle}?`) && (await pay.run())) onPaid(); }}>
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
