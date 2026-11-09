import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { useAction, useResource, useSession } from '@quintara/app-core';
import type { PrivacySettings } from '@quintara/domain';
import { ActionError, Body, Button, confirmThen, Divider, Field, Heading, Muted, ResourceView, Screen, Title } from '@/components/ui';
import { useTheme } from '@/theme';

export default function PrivacyScreen() {
  const router = useRouter();
  const { color, space } = useTheme();
  const { refresh } = useSession();
  const settings = useResource((api) => api.getPrivacySettings());
  const update = useAction((api, next: PrivacySettings) => api.updatePrivacySettings(next));
  const [confirm, setConfirm] = useState('');
  const close = useAction((api) => api.closeMyAccount(confirm));
  const toggle = async (current: PrivacySettings, key: keyof PrivacySettings, value: boolean) => { if (await update.run({ ...current, [key]: value })) settings.reload(); };
  const line = (label: string, value: boolean, onChange: (value: boolean) => void) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <Body style={{ flex: 1 }}>{label}</Body>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={update.pending} trackColor={{ true: color.accent, false: color.line }} />
    </View>
  );
  return (
    <Screen>
      <Title>Privacy and your data</Title>
      <ResourceView resource={settings}>
        {(current) => (
          <>
            {line('Show my profile in the members directory', current.showInDirectory, (v) => { void toggle(current, 'showInDirectory', v); })}
            {line('Email me recommendations and partner offers', current.marketingEmail, (v) => { void toggle(current, 'marketingEmail', v); })}
            {line('Include me in People to meet', current.suggestions, (v) => { void toggle(current, 'suggestions', v); })}
            {line('QÉRA’s daily brief, each morning', current.dailyBrief ?? true, (v) => { void toggle(current, 'dailyBrief', v); })}
            {line('QÉRA’s Monday brief, and reminders of dates and bookings', current.weeklyBrief, (v) => { void toggle(current, 'weeklyBrief', v); })}
            <Muted>Emails about your own bookings, requests and membership are always sent.</Muted>
          </>
        )}
      </ResourceView>
      <ActionError error={update.error} />
      <Divider />
      <Heading>Your data</Heading>
      <Muted>To download a copy of everything Quintara holds about you, sign in to the Quintara web app and open Profile.</Muted>
      <Divider />
      <Heading>Close my account</Heading>
      <Muted>This ends your membership and signs you out everywhere. Bookings are cancelled, with refunds where the experience allows. Your personal data is erased after 30 days; until then the team can reinstate you.</Muted>
      <Field label="Type CLOSE to confirm" value={confirm} onChangeText={setConfirm} autoCapitalize="characters" autoCorrect={false} />
      <ActionError error={close.error} />
      <Button quiet label="Close my account" disabled={confirm !== 'CLOSE'} busy={close.pending} onPress={() => confirmThen('Close your account?', 'You will be signed out now.', 'Close account', async () => { if (await close.run()) { await refresh(); router.replace('/'); } }, true)} />
    </Screen>
  );
}
