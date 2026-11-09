import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { usePermission, useResource, useSession } from '@quintara/app-core';
import { BOOKING_STATUS_LABEL, formatDateTime } from '@quintara/domain';
import { ExperienceCard } from '@/components/experience-card';
import { Body, Button, Divider, Heading, Loading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';

export default function HomeScreen() {
  const { status } = useSession();
  const isMember = usePermission('directory.view');
  if (status === 'loading') return <Screen><Loading /></Screen>;
  return isMember ? <MemberHome /> : <VisitorHome />;
}

function VisitorHome() {
  const router = useRouter();
  const experiences = useResource((api) => api.listExperiences());
  return (
    <Screen onRefresh={experiences.reload} refreshing={experiences.status === 'loading'}>
      <Title>The city&rsquo;s best tables, rooms and introductions, kept for people who show up.</Title>
      <Muted>Quintara is a private membership for founders, investors, creatives and executives.</Muted>
      <Button label="Sign in" onPress={() => router.push('/sign-in')} />
      <Heading style={{ marginTop: 16 }}>Open to guests</Heading>
      <ResourceView resource={experiences} isEmpty={(list) => list.length === 0} empty={<Muted>The next season is being planned.</Muted>}>
        {(list) => list.map((experience) => <ExperienceCard key={experience.id} experience={experience} />)}
      </ResourceView>
    </Screen>
  );
}

function MemberHome() {
  const { session } = useSession();
  const { space } = useTheme();
  const home = useResource(async (api) => {
    const [experiences, bookings] = await Promise.all([api.listExperiences(), api.listBookings()]);
    return { experiences, bookings };
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen onRefresh={home.reload} refreshing={home.status === 'loading'}>
      <Title>{greeting}, {session?.fullName.split(' ')[0]}.</Title>
      <ResourceView resource={home}>
        {({ experiences, bookings }) => {
          const live = bookings.filter((b) => b.status === 'confirmed' || b.status === 'applied' || b.status === 'waitlisted' || b.status === 'awaiting_payment');
          const booked = new Set(live.map((b) => b.experienceId));
          const invitations = experiences.filter((e) => e.invited && !booked.has(e.id));
          const suggestions = experiences.filter((e) => !e.invited && !booked.has(e.id)).slice(0, 3);
          return (
            <>
              {invitations.length > 0 ? (
                <>
                  <Heading>Invitations</Heading>
                  {invitations.map((experience) => <ExperienceCard key={experience.id} experience={experience} />)}
                </>
              ) : null}
              <Heading>Your bookings</Heading>
              {live.length === 0 ? <Muted>Nothing booked yet. The calendar is under Experiences.</Muted> : null}
              {live.map((booking) => {
                const when = formatDateTime(booking.startsAt, booking.timezone);
                return (
                  <View key={booking.id} style={{ gap: space.xs }}>
                    <Body style={{ fontWeight: '500' }}>{booking.experienceTitle}</Body>
                    <Muted>{when.long}, {when.time}. {booking.seats} seat{booking.seats > 1 ? 's' : ''}.</Muted>
                    <Tag tone={booking.status === 'confirmed' ? 'positive' : 'accent'} label={BOOKING_STATUS_LABEL[booking.status]} />
                    {booking.status === 'confirmed' ? <Muted>Ticket code: {booking.ticketCode}</Muted> : null}
                    <Divider />
                  </View>
                );
              })}
              <Heading>Chosen for you</Heading>
              {suggestions.length === 0 ? <Muted>You have seen everything on the calendar.</Muted> : null}
              {suggestions.map((experience) => <ExperienceCard key={experience.id} experience={experience} />)}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
