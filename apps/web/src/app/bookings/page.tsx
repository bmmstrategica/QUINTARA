'use client';

import Link from 'next/link';
import { useAction, useResource } from '@quintara/app-core';
import { formatDateTime } from '@quintara/domain';
import type { Booking } from '@quintara/domain';
import { BookingStatusTag, DateBlock } from '@/components/experience';
import { PayBooking, RefundNote } from '@/components/pay';
import { Ticket } from '@/components/ticket';
import { ActionError, EmptyState, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

export default function BookingsPage() {
  const intro = useSection('bookings');
  const bookings = useResource((api) => api.listBookings());
  return (
    <>
      <div className="head"><div><h2>Bookings</h2><p className="lede">{intro.description}</p></div></div>
      <ResourceView
        resource={bookings}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No bookings yet"><p className="lede">Reserve a seat and it will appear here with its ticket.</p><Link className="btn" href="/experiences">Browse experiences</Link></EmptyState>}
      >
        {(list) => list.map((booking) => <BookingRow key={booking.id} booking={booking} onChanged={bookings.reload} />)}
      </ResourceView>
    </>
  );
}

function BookingRow({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const cancel = useAction((api) => api.cancelBooking(booking.id));
  const when = formatDateTime(booking.startsAt, booking.timezone);
  const cancellable = booking.status === 'confirmed' || booking.status === 'applied' || booking.status === 'waitlisted' || booking.status === 'awaiting_payment';
  return (
    <article className="item-row">
      <DateBlock iso={booking.startsAt} timezone={booking.timezone} />
      <div>
        <h3><Link href={`/experiences/${booking.experienceId}`} style={{ textDecoration: 'none' }}>{booking.experienceTitle}</Link></h3>
        <p>{when.long}, {when.time}. {booking.venueName}, {booking.area}. {booking.seats} seat{booking.seats > 1 ? 's' : ''}.</p>
        {booking.status === 'confirmed' ? <Ticket code={booking.ticketCode} title={booking.experienceTitle} /> : null}
        <PayBooking booking={booking} onPaid={onChanged} />
        <RefundNote booking={booking} />
        <ActionError error={cancel.error} />
      </div>
      <div className="actions">
        <BookingStatusTag status={booking.status} />
        {cancellable ? (
          <button className="btn quiet small" disabled={cancel.pending} onClick={async () => { if (await cancel.run()) onChanged(); }}>
            {cancel.pending ? 'Cancelling' : 'Cancel booking'}
          </button>
        ) : null}
      </div>
    </article>
  );
}
