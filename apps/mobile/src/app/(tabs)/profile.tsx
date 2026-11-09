import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Photo } from '@/components/photo';
import { TwoFactorSettings } from '@/components/two-factor';
import { AppLockSettings } from '@/components/app-lock';
import { useSignOutWithPush } from '@/components/push';
import { useResource, useSession } from '@quintara/app-core';
import { Body, Button, confirmThen, Divider, EmptyState, Heading, Loading, Muted, ResourceView, Row, Screen } from '@/components/ui';
import { openApply } from '@/web-link';
import { useTheme, useThemeChoice } from '@/theme';

function Appearance() {
  const { color, space, radius } = useTheme();
  const { name, setName } = useThemeChoice();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Appearance" style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
      <Muted>Appearance</Muted>
      {(['dark', 'light'] as const).map((option) => (
        <Pressable
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ selected: name === option }}
          onPress={() => setName(option)}
          style={{ paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: name === option ? color.accent : color.line, backgroundColor: name === option ? color.inverseBg : 'transparent' }}
        >
          <Text style={{ color: name === option ? color.inverseInk : color.muted }}>{option === 'dark' ? 'Dark' : 'Light'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { session, guest, status, deleteGuestAccount } = useSession();
  const signOut = useSignOutWithPush();
  const { color, space, radius, displayFont } = useTheme();
  const profile = useResource((api) => api.getMyProfile());

  if (status === 'loading') return <Screen><Loading /></Screen>;
  if (!session && guest) {
    return (
      <Screen>
        <Heading>{guest.fullName}</Heading>
        <Muted>Guest account. {guest.email}</Muted>
        <View>
          <Row title="QÉRA" detail="The Quintara Intelligence, up to five hours a day" onPress={() => router.push('/qera')} />
          <Row title="QÉRA on WhatsApp" detail="Talk to QÉRA from WhatsApp" onPress={() => router.push('/whatsapp')} />
          <Row title="Apply for membership" detail="Book experiences, meet members and use QÉRA without a limit" onPress={() => { void openApply(); }} />
          <Row title="Lifestyle" detail="Request a service" onPress={() => router.push('/lifestyle')} />
          <Row title="Maison Quintara" detail="Shop Quintara and its makers" onPress={() => router.push('/boutique')} />
          <Row title="Quintara TV" detail="Films from inside Quintara" onPress={() => router.push('/tv')} />
        </View>
        <Row title="Notification settings" detail="Notifications on this phone" onPress={() => router.push('/notification-settings')} />
        <Appearance />
        <TwoFactorSettings />
        <AppLockSettings />
        <Button quiet label="Sign out" onPress={() => { void signOut(); }} />
        <Button quiet label="Delete guest account" onPress={() => confirmThen('Delete your guest account?', 'Your name, email and conversations with QÉRA are erased at once. This cannot be undone.', 'Delete', () => { void deleteGuestAccount(); }, true)} />
      </Screen>
    );
  }
  if (!session) {
    return (
      <Screen>
        <EmptyState title="Your membership lives here" message="Sign in to see your card, profile and bookings, or create a free guest account to talk to QÉRA.">
          <Button label="Sign in" onPress={() => router.push('/sign-in')} />
          <Button quiet label="Create a guest account" onPress={() => router.push('/join')} />
        </EmptyState>
        <Appearance />
      </Screen>
    );
  }

  return (
    <Screen onRefresh={profile.reload} refreshing={profile.status === 'loading'}>
      <View accessible accessibilityLabel={`Membership card. ${session.fullName}, ${session.tierName}, number ${session.memberNumber}`} style={{ backgroundColor: color.inverseBg, borderRadius: radius.md, padding: space.lg, minHeight: 200, justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: color.inverseInk, fontFamily: displayFont, fontSize: 18, letterSpacing: 3 }}>QUINTARA</Text>
          <Text style={{ color: color.inverseInk }}>{session.tierName}</Text>
        </View>
        <View>
          <Text style={{ color: color.inverseInk, fontFamily: displayFont, fontSize: 26 }}>{session.fullName}</Text>
          <Text style={{ color: color.inverseInk }}>{session.memberNumber}</Text>
        </View>
      </View>
      <ResourceView resource={profile}>
        {(data) => (
          <>
            {data.avatarPath ? <Photo path={data.avatarPath} label="Your profile picture" fraction={0.25} style={{ width: 88, height: 88, borderRadius: 44 }} /> : null}
            <Muted>{data.avatarPath ? 'Change your profile picture in the Quintara web app.' : 'Add a profile picture in the Quintara web app.'}</Muted>
            <Heading>{data.position}, {data.company}</Heading>
            <Muted>{data.industry}. {data.city}.</Muted>
            <Body>{data.biography}</Body>
            <Divider />
            <Muted>Looking for</Muted>
            <Body>{data.lookingFor || 'Not said'}</Body>
            <Muted>Can offer</Muted>
            <Body>{data.canOffer || 'Not said'}</Body>
          </>
        )}
      </ResourceView>
      <View>
        <Row title="QÉRA" detail="Your Quintara assistant" onPress={() => router.push('/qera')} />
        <Row title="Today's brief" detail="Your day from QÉRA, with your calendar" onPress={() => router.push('/today')} />
        <Row title="Your calendar" detail="Connect it to QÉRA for your daily brief" onPress={() => router.push('/calendar')} />
        <Row title="QÉRA on WhatsApp" detail="Ask, plan and book from WhatsApp" onPress={() => router.push('/whatsapp')} />
        <Row title="Search" detail="Experiences, people, partners, Maison Quintara and TV" onPress={() => router.push('/search')} />
        <Row title="Bookings" detail="Tickets, payments and cancellations" onPress={() => router.push('/bookings')} />
        <Row title="Messages" detail="Conversations with members you are connected to" onPress={() => router.push('/messages')} />
        <Row title="Business" detail="Listings and introductions made by the team" onPress={() => router.push('/business')} />
        <Row title="Lifestyle" detail="Partners and member privileges" onPress={() => router.push('/lifestyle')} />
        <Row title="Quintara TV" detail="Films from inside Quintara" onPress={() => router.push('/tv')} />
        <Row title="Maison Quintara" detail="Shop, wishlist and orders" onPress={() => router.push('/boutique')} />
        <Row title="Privacy and your data" detail="Directory, email, close account" onPress={() => router.push('/privacy')} />
        <Row title="Notifications" detail="Invitations, confirmations and replies" onPress={() => router.push('/notifications')} />
        <Row title="Notification settings" detail="What reaches this phone, and the lock screen" onPress={() => router.push('/notification-settings')} />
        <Row title="Membership" detail="Renewal, card and payments" onPress={() => router.push('/membership')} />
      </View>
      <TwoFactorSettings />
      <AppLockSettings />
      <Appearance />
      <Button quiet label="Sign out" onPress={() => { void signOut(); }} />
    </Screen>
  );
}
