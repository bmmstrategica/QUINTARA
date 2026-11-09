import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useAction, usePermission, useResource, useSession } from '@quintara/app-core';
import { ADMISSION_LABEL, BOOKING_STATUS_LABEL, bookingOffer, formatDateTime, formatMoney } from '@quintara/domain';
import type { Booking, BookingOffer, Experience } from '@quintara/domain';
import { ActionError, Body, Button, Divider, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';

const OFFER_LABEL: Partial<Record<BookingOffer, string>> = { reserve: 'Reserve', rsvp: 'RSVP', apply: 'Apply to attend', waitlist: 'Join waitlist' };

export default function ExperienceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const canBook = usePermission('experiences.book');
  const resource = useResource(async (api) => {
    const [experience, bookings] = await Promise.all([api.getExperience(id), canBook ? api.listBookings() : Promise.resolve([])]);
    const booking = bookings.find((b) => b.experienceId === id && b.status !== 'cancelled' && b.status !== 'declined') ?? null;
    return { experience, booking };
  }, [id, canBook]);

  return (
    <Screen>
      <ResourceView resource={resource}>
        {({ experience, booking }) => <Detail experience={experience} booking={booking} onChanged={resource.reload} />}
      </ResourceView>
    </Screen>
  );
}

function Detail({ experience, booking, onChanged }: { experience: Experience; booking: Booking | null; onChanged: () => void }) {
  const router = useRouter();
  const { session } = useSession();
  const { space } = useTheme();
  const [seats, setSeats] = useState(1);
  const book = useAction((api, count: number) => api.bookExperience(experience.id, count));
  const cancel = useAction((api, bookingId: string) => api.cancelBooking(bookingId));
  const pay = useAction((api, bookingId: string) => api.payBooking(bookingId));
  const when = experience.startsAt ? formatDateTime(experience.startsAt, experience.timezone) : null;
  const seatsLeft = experience.capacity === null ? null : experience.capacity - (experience.seatsTaken ?? 0);
  const offer = bookingOffer(experience, session);
  const label = OFFER_LABEL[offer];

  return (
    <>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Tag label={experience.category} />
        <Tag tone="accent" label={ADMISSION_LABEL[experience.admission]} />
      </View>
      <Title>{experience.title}</Title>
      <Body>{when ? `${when.long}, ${when.time}. ` : ''}{experience.venueName}, {experience.area}.</Body>
      <Muted>{experience.summary}</Muted>
      <Body>{experience.description}</Body>
      <Divider />
      <Muted>Price</Muted>
      <Body>{formatMoney(experience.memberPriceMinor, experience.currency)}{experience.memberPriceMinor ? ' per seat for members' : ''}</Body>
      <Muted>{seatsLeft === null ? 'Date and seats' : 'Availability'}</Muted>
      <Body>{seatsLeft === null ? 'Shared with members' : seatsLeft > 0 ? `${seatsLeft} of ${experience.capacity} seats` : 'Full, waitlist open'}</Body>
      <Muted>Dress</Muted>
      <Body>{experience.dressCode}</Body>
      <Muted>Guests</Muted>
      <Body>{experience.guestPolicy}</Body>
      <Divider />
      {experience.programme.length > 0 ? <Heading>Programme</Heading> : null}
      {experience.programme.map((item) => <Body key={item.time + item.title}>{item.time}  {item.title}</Body>)}
      <Divider />

      {booking ? (
        <>
          <Tag tone={booking.status === 'confirmed' ? 'positive' : 'accent'} label={`${BOOKING_STATUS_LABEL[booking.status]}, ${booking.seats} seat${booking.seats > 1 ? 's' : ''}`} />
          {booking.status === 'confirmed' ? <Body>Ticket code: {booking.ticketCode}</Body> : null}
          {booking.status === 'awaiting_payment' ? (
            <>
              <Body>Your seats are held. Pay {formatMoney(booking.amountDueMinor, booking.currency)} to confirm them.</Body>
              <ActionError error={pay.error} />
              <Button busy={pay.pending} label={`Pay ${formatMoney(booking.amountDueMinor, booking.currency)}`} onPress={async () => { if (await pay.run(booking.id)) onChanged(); }} />
            </>
          ) : null}
          <ActionError error={cancel.error} />
          <Button quiet busy={cancel.pending} label="Cancel booking" onPress={async () => { if (await cancel.run(booking.id)) onChanged(); }} />
        </>
      ) : offer === 'membership_needed' ? (
        <>
          <Muted>Booking is for members.</Muted>
          <Button label="Sign in" onPress={() => router.push('/sign-in')} />
        </>
      ) : offer === 'invitation_needed' ? (
        <Muted>This experience is by invitation.</Muted>
      ) : (
        <>
          {experience.maxSeatsPerBooking > 1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Button quiet label="Fewer" disabled={seats <= 1} onPress={() => setSeats(seats - 1)} />
              <Body accessibilityLiveRegion="polite">{seats} seat{seats > 1 ? 's' : ''}</Body>
              <Button quiet label="More" disabled={seats >= experience.maxSeatsPerBooking} onPress={() => setSeats(seats + 1)} />
            </View>
          ) : null}
          <ActionError error={book.error} />
          {label ? <Button busy={book.pending} label={label} onPress={async () => { if (await book.run(seats)) onChanged(); }} /> : null}
        </>
      )}
    </>
  );
}
