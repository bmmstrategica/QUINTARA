import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { CALENDAR_PROVIDER_HELP, CALENDAR_PROVIDER_LABEL, CALENDAR_PROVIDERS, formatDateTime } from '@quintara/domain';
import type { CalendarProvider, CalendarState } from '@quintara/domain';
import { ActionError, Body, Button, Choice, confirmThen, Divider, Field, Heading, Muted, ResourceView, Row, Screen } from '@/components/ui';

/** Connecting a calendar to QÉRA, by choice, so the daily brief shows the member's own day. */
export default function CalendarScreen() {
  const state = useResource((api) => api.getCalendar());
  return (
    <Screen onRefresh={state.reload} refreshing={state.status === 'loading'}>
      <Heading>Your calendar</Heading>
      <Muted>Connect your calendar and QÉRA puts your own meetings beside what Quintara has arranged, in your daily brief. It is your choice, and you can disconnect at any time.</Muted>
      <ResourceView resource={state}>{(current) => (current.connection ? <Connected state={current} onChanged={state.reload} /> : <Connect onConnected={state.reload} />)}</ResourceView>
    </Screen>
  );
}

function Connect({ onConnected }: { onConnected: () => void }) {
  const [provider, setProvider] = useState<CalendarProvider>('google');
  const [address, setAddress] = useState('');
  const [titles, setTitles] = useState<'yes' | 'no'>('yes');
  const [consent, setConsent] = useState<'yes' | 'no'>('no');
  const connect = useAction((api) => api.connectCalendar({ provider, address, showTitles: titles === 'yes', consent: (consent === 'yes') as true }));
  return (
    <>
      <Choice label="Where is your calendar?" options={CALENDAR_PROVIDERS.map((p) => [p, CALENDAR_PROVIDER_LABEL[p]] as const)} value={provider} onChange={setProvider} />
      <Muted>{CALENDAR_PROVIDER_HELP[provider]}</Muted>
      {provider === 'sample' ? null : <Field label="Private calendar address" value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} placeholder="https://… or webcal://…" error={connect.error?.fields?.address} />}
      <Choice label="May QÉRA see what your meetings are?" options={[['yes', 'Yes'], ['no', 'Only that I am busy']] as const} value={titles} onChange={setTitles} />
      <Choice label="I agree that QÉRA reads this calendar to prepare my daily brief" options={[['yes', 'I agree'], ['no', 'Not yet']] as const} value={consent} onChange={setConsent} />
      {connect.error?.fields?.consent ? <Muted>Please agree to let QÉRA read your calendar.</Muted> : null}
      <ActionError error={connect.error?.code === 'validation' ? null : connect.error} />
      <Button label="Connect calendar" busy={connect.pending} onPress={async () => { if (await connect.run()) onConnected(); }} />
      <Divider />
      <Muted>The address is stored encrypted and never shown again. QÉRA reads only the next seven days, and nothing from your calendar is shared with partners, the desk or other members. Disconnecting deletes everything at once.</Muted>
    </>
  );
}

function Connected({ state, onChanged }: { state: CalendarState; onChanged: () => void }) {
  const c = state.connection!;
  const titles = useAction((api, show: boolean) => api.updateCalendar({ showTitles: show }));
  const sync = useAction((api) => api.syncCalendar());
  const disconnect = useAction(async (api) => { await api.disconnectCalendar(); return true; });
  return (
    <>
      <Body style={{ fontWeight: '500' }}>{c.label}</Body>
      <Muted>Connected {new Date(c.connectedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}.</Muted>
      {c.syncError ? <Muted>{c.syncError}</Muted> : null}
      <Choice label="May QÉRA see what your meetings are?" options={[['yes', 'Yes'], ['no', 'Only that I am busy']] as const} value={c.showTitles ? 'yes' : 'no'} onChange={async (v) => { if (await titles.run(v === 'yes')) onChanged(); }} />
      <ActionError error={titles.error ?? sync.error ?? disconnect.error} />
      <Button quiet label="Update now" busy={sync.pending} onPress={async () => { if (await sync.run()) onChanged(); }} />
      <Button quiet label="Disconnect" onPress={() => confirmThen('Disconnect your calendar?', 'QÉRA deletes the address and every event at once.', 'Disconnect', () => { void disconnect.run().then((ok) => { if (ok) onChanged(); }); }, true)} />
      <Heading>The coming week</Heading>
      {state.events.length === 0 ? <Muted>Nothing in the next seven days.</Muted> : state.events.map((e) => (
        <Row key={e.id} title={e.title || 'Busy'} detail={`${formatDateTime(e.startsAt, 'Africa/Johannesburg').long}, ${e.allDay ? 'all day' : formatDateTime(e.startsAt, 'Africa/Johannesburg').time}${e.location ? `. ${e.location}` : ''}`} />
      ))}
    </>
  );
}
