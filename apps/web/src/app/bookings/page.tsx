'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { formatDateTime } from '@quintara/domain';
import type { Booking } from '@quintara/domain';
import { BookingStatusTag, DateBlock } from '@/components/experience';
import { PayBooking, RefundNote } from '@/components/pay';
import { Ticket } from '@/components/ticket';
import { ActionError, EmptyState, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';
import { FilterChips, useQueryFilter } from '@/components/filter-chips';

const BOOKING_FILTERS = ['upcoming', 'past', 'cancelled'] as const;
type BookingFilter = (typeof BOOKING_FILTERS)[number];
const bucket = (b: Booking): BookingFilter => (b.status === 'cancelled' || b.status === 'declined' ? 'cancelled' : Date.parse(b.startsAt) < Date.now() ? 'past' : 'upcoming');

export default function BookingsPage() {
  return <Suspense><Bookings /></Suspense>;
}

/** Bookings, filtered by upcoming, past or cancelled (?show=). */
function Bookings() {
  const intro = useSection('bookings');
  const bookings = useResource((api) => api.listBookings());
  const [show, setShow] = useQueryFilter('show', BOOKING_FILTERS);
  return (
    <>
      <div className="head"><div><h2>Bookings</h2><p className="lede">{intro.description}</p></div></div>
      <ResourceView
        resource={bookings}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No bookings yet"><p className="lede">Reserve a seat and it will appear here with its ticket.</p><Link className="btn" href="/experiences">Browse experiences</Link></EmptyState>}
      >
        {(list) => {
          const shown = list.filter((b) => !show || bucket(b) === show);
          const count = (f: BookingFilter) => list.filter((b) => bucket(b) === f).length;
          return <>
            <FilterChips label="Which bookings" value={show} onChange={setShow} options={[['', 'All', list.length], ['upcoming', 'Upcoming', count('upcoming')], ['past', 'Past', count('past')], ['cancelled', 'Cancelled', count('cancelled')]]} />
            {shown.length ? shown.map((booking) => <BookingRow key={booking.id} booking={booking} onChanged={bookings.reload} />) : <p className="muted">Nothing here.</p>}
          </>;
        }}
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
