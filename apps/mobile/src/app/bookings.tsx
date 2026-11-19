import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { payThrough, useAction, useResource } from '@quintara/app-core';
import { followPayment, paymentReturnUrl } from '../web-link';
import { BOOKING_STATUS_LABEL, formatDateTime, formatMoney } from '@quintara/domain';
import type { Booking } from '@quintara/domain';
import { ActionError, Body, Button, Chips, clock, confirmThen, Divider, EmptyState, Heading, Muted, ResourceView, Screen, Tag } from '@/components/ui';
import { useTheme } from '@/theme';
import { useSection } from '@/components/section-copy';

type Bucket = 'upcoming' | 'past' | 'cancelled';
const bucket = (b: Booking): Bucket => (b.status === 'cancelled' || b.status === 'declined' ? 'cancelled' : Date.parse(b.startsAt) < Date.now() ? 'past' : 'upcoming');

export default function BookingsScreen() {
  const [show, setShow] = useState<Bucket | ''>('');
  const intro = useSection('bookings');
  const router = useRouter();
  const bookings = useResource((api) => api.listBookings());
  return (
    <Screen onRefresh={bookings.reload} refreshing={bookings.status === 'loading'}>
      <Muted>{intro.description}</Muted>
      <ResourceView resource={bookings} isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No bookings yet" message="Reserve a seat and it will appear here with its ticket."><Button label="Browse experiences" onPress={() => router.push('/experiences')} /></EmptyState>}>
        {(list) => {
          const count = (b: Bucket) => list.filter((x) => bucket(x) === b).length;
          const shown = list.filter((x) => !show || bucket(x) === show);
          return <>
            <Chips label="Which bookings" value={show} onChange={setShow} options={[['', 'All', list.length], ['upcoming', 'Upcoming', count('upcoming')], ['past', 'Past', count('past')], ['cancelled', 'Cancelled', count('cancelled')]]} />
            {shown.length ? shown.map((booking) => <BookingItem key={booking.id} booking={booking} onChanged={bookings.reload} />) : <Muted>Nothing here.</Muted>}
          </>;
        }}
      </ResourceView>
    </Screen>
  );
}

function BookingItem({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const { space } = useTheme();
  const pay = useAction((api) => payThrough(api, { purpose: 'experience', id: booking.id, returnUrl: paymentReturnUrl }, (a) => a.payBooking(booking.id)));
  const cancel = useAction((api) => api.cancelBooking(booking.id));
  const when = formatDateTime(booking.startsAt, booking.timezone);
  const amount = formatMoney(booking.amountDueMinor, booking.currency);
  const cancellable = ['confirmed', 'applied', 'waitlisted', 'awaiting_payment'].includes(booking.status);
  return (
    <View style={{ gap: space.sm }}>
      <Heading>{booking.experienceTitle}</Heading>
      <Muted>{when.long}, {when.time}. {booking.venueName}, {booking.area}. {booking.seats} seat{booking.seats > 1 ? 's' : ''}.</Muted>
      <Tag tone={booking.status === 'confirmed' || booking.status === 'attended' ? 'positive' : booking.status === 'cancelled' || booking.status === 'declined' ? 'critical' : 'accent'} label={BOOKING_STATUS_LABEL[booking.status]} />
      {booking.status === 'confirmed' ? <Body>Ticket code: {booking.ticketCode}</Body> : null}
      {booking.status === 'cancelled' && booking.cancelledByQuintaraReason ? <Muted>Cancelled by Quintara. {booking.cancelledByQuintaraReason}</Muted> : null}
      {booking.status === 'cancelled' && booking.refundedMinor ? <Muted>Refunded {formatMoney(booking.refundedMinor, booking.currency)}.</Muted> : null}
      <ActionError error={pay.error ?? cancel.error} />
      {booking.status === 'awaiting_payment' ? (
        <>
          <Body>Your seats are held{booking.paymentDueAt ? ` until ${clock(booking.paymentDueAt)}` : ''}.</Body>
          <Button label={`Pay ${amount}`} busy={pay.pending} onPress={() => confirmThen(`Pay ${amount}?`, booking.experienceTitle, 'Pay', async () => { if (followPayment(await pay.run())) onChanged(); })} />
        </>
      ) : null}
      {cancellable ? (
        <Button quiet label="Cancel booking" busy={cancel.pending} onPress={() => confirmThen('Cancel this booking?', 'Your seats go back on sale.', 'Cancel booking', async () => { if (await cancel.run()) onChanged(); }, true)} />
      ) : null}
      <Divider />
    </View>
  );
}
