import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useAction, useApi, useResource, useSession } from '@quintara/app-core';
import { longDay, PARTNER_BOOKING_STATUS_LABEL, QERA_GUEST_HELP, QERA_HELP } from '@quintara/domain';
import type { QeraThread, QeraUsage } from '@quintara/domain';
import { ActionError, Body, Bubble, Button, clock, Composer, Divider, Heading, Muted, ResourceView, Row, Screen, Tag } from '@/components/ui';
import { openApply } from '@/web-link';
import { useSection } from '@/components/section-copy';

const IDEAS = ['What does my week look like?', 'Remember that I am vegetarian', 'Plan a weekend for me', 'Book the whole plan for 2', 'Remind me to call the florist tomorrow at 10am', 'What would you recommend for me?'];

/** QÉRA as Chief of Staff: the week, reminders, and what it remembers. */
function ChiefPanels({ version }: { version: number }) {
  const router = useRouter();
  const brief = useResource((api) => api.getWeeklyBrief(), [version]);
  const [changed, setChanged] = useState(0);
  const reminders = useResource((api) => api.listReminders(), [version, changed]);
  const cancel = useAction(async (api, id: string) => { await api.cancelReminder(id); return true; });
  return (
    <>
      <Heading>Your brief</Heading>
      <ResourceView resource={brief}>
        {(b) => (
          <>
            <Body>{b.greeting}</Body>
            {b.sections.filter((x) => x.items.length).map((x) => (
              <View key={x.key} style={{ gap: 2 }}>
                <Muted style={{ textTransform: 'uppercase', letterSpacing: 1.5, fontSize: 11 }}>{x.title}</Muted>
                {x.items.map((item, i) => <Row key={i} title={item.title} detail={item.detail} onPress={item.link?.kind === 'experience' ? () => router.push(`/experience/${item.link!.id}`) : item.link?.kind === 'bookings' ? () => router.push('/bookings') : item.link?.kind === 'service' ? () => router.push('/lifestyle') : undefined} />)}
              </View>
            ))}
          </>
        )}
      </ResourceView>
      <ResourceView resource={reminders}>
        {(list) => list.filter((r) => r.status === 'scheduled').length ? (
          <>
            <Heading>Reminders</Heading>
            {list.filter((r) => r.status === 'scheduled').map((r) => <Row key={r.id} title={r.text} detail={new Date(r.remindAt).toLocaleString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })} trailing={<Button quiet label="Cancel" disabled={cancel.pending} onPress={async () => { if (await cancel.run(r.id)) setChanged((n) => n + 1); }} />} />)}
          </>
        ) : <Muted>No reminders. Tell QÉRA “remind me to … on Friday at 10am”.</Muted>}
      </ResourceView>
      <Row title="What QÉRA remembers" detail="See, change or remove it" onPress={() => router.push('/memory')} />
      <Row title="QÉRA on WhatsApp" detail="Ask, plan and book from WhatsApp" onPress={() => router.push('/whatsapp')} />
      <Divider />
    </>
  );
}

const GUEST_IDEAS = ['What is Quintara?', 'What experiences are open to guests?', 'How does membership work?'];
const hours = (seconds: number) => { const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };

export default function QeraScreen() {
  const router = useRouter();
  const { session, guest, status } = useSession();
  const loaded = useResource((api) => (session || guest ? api.getQeraThread() : Promise.resolve(null)), [Boolean(session || guest)]);
  const qera = useSection('qera');
  if (status === 'ready' && !session && !guest) {
    return (
      <Screen>
        <Heading>QÉRA, the Quintara Intelligence</Heading>
        <Body>Create a free guest account to ask QÉRA about Quintara, its experiences, services, Maison Quintara and TV, for up to five hours a day.</Body>
        <Button label="Create a guest account" onPress={() => router.push('/join')} />
        <Button quiet label="Sign in" onPress={() => router.push('/sign-in')} />
      </Screen>
    );
  }
  return <Screen>{guest ? null : <Muted>{qera.description}</Muted>}<ResourceView resource={loaded}>{(thread) => (thread ? <Chat initial={thread} guest={Boolean(guest)} /> : null)}</ResourceView></Screen>;
}

/** A guest's time today, counted by the server; a heartbeat goes each minute while the app is in front. */
function Allowance({ usage, onUsage }: { usage: QeraUsage; onUsage: (next: QeraUsage) => void }) {
  const api = useApi();
  useEffect(() => {
    if (usage.exhausted) return;
    const timer = setInterval(() => { if (AppState.currentState === 'active') api.qeraHeartbeat().then((next) => { if (next) onUsage(next); }).catch(() => undefined); }, 60_000);
    return () => clearInterval(timer);
  }, [api, usage.exhausted, onUsage]);
  return usage.exhausted ? (
    <>
      <Tag tone="accent" label="Today’s five hours are used" />
      <Body>Apply for membership to keep talking to QÉRA without a daily limit, or come back tomorrow.</Body>
      <Button label="Apply for membership" onPress={() => { void openApply(); }} />
    </>
  ) : <Muted>{hours(Math.max(0, usage.limitSeconds - usage.usedSeconds))} of QÉRA left today. Guests have five hours a day.</Muted>;
}

function Chat({ initial, guest }: { initial: QeraThread; guest: boolean }) {
  const [thread, setThread] = useState(initial);
  const [usage, setUsage] = useState<QeraUsage | null>(initial.usage ?? null);
  useEffect(() => { if (thread.usage) setUsage(thread.usage); }, [thread]);
  const send = useAction((api, message: string) => api.sendQeraMessage(message));
  const exhausted = Boolean(usage?.exhausted) || send.error?.code === 'forbidden';
  const decide = useAction((api, id: string, yes: boolean) => (yes ? api.confirmQeraProposal(id) : api.cancelQeraProposal(id)));
  const busy = send.pending || decide.pending;
  const router = useRouter();
  const documents = useResource((api) => (guest ? Promise.resolve([]) : api.listQeraDocuments()), [thread]);
  const bookings = useResource((api) => (guest ? Promise.resolve([]) : api.listPartnerBookings()), [thread]);
  const submit = async (message: string) => { const next = await send.run(message); if (next) setThread(next); return Boolean(next); };
  const answer = async (yes: boolean) => { if (!thread.pending) return; const next = await decide.run(thread.pending.id, yes); if (next) setThread(next); };
  return (
    <>
      {usage ? <Allowance usage={exhausted ? { ...usage, exhausted: true } : usage} onUsage={setUsage} /> : null}
      {guest ? null : <Button quiet label="Today's brief" onPress={() => router.push('/today')} />}
      {guest ? <Button quiet label="QÉRA on WhatsApp" onPress={() => router.push('/whatsapp')} /> : null}
      {guest ? null : <ChiefPanels version={thread.messages.length} />}
      {thread.messages.length === 0 ? <Bubble mine={false} body={guest ? QERA_GUEST_HELP : QERA_HELP} meta="QÉRA" /> : null}
      {thread.messages.map((m) => <Bubble key={m.id} mine={m.role === 'member'} body={m.text} meta={`${m.role === 'member' ? 'You' : 'QÉRA'}, ${clock(m.sentAt)}${m.via === 'whatsapp' ? ', on WhatsApp' : ''}`} />)}
      {thread.pending ? (
        <>
          <Divider />
          <Body>{thread.pending.summary}</Body>
          <Button label="Yes, go ahead" busy={decide.pending} onPress={() => { void answer(true); }} />
          <Button quiet label="No" disabled={busy} onPress={() => { void answer(false); }} />
        </>
      ) : null}
      <ActionError error={exhausted ? null : send.error ?? decide.error} />
      {thread.messages.length === 0 && !exhausted ? (guest ? GUEST_IDEAS : IDEAS).map((idea) => <Button key={idea} quiet label={idea} disabled={busy} onPress={() => { void submit(idea); }} />) : null}
      {exhausted ? null : <Composer placeholder={guest ? 'Ask about Quintara' : 'Ask, or tell me what you would like arranged'} busy={send.pending} onSend={submit} />}
      {documents.data?.length ? <><Heading>Documents</Heading>{documents.data.map((d) => <Row key={d.id} title={d.title} detail="A plan prepared by QÉRA" onPress={() => router.push(`/document/${d.id}`)} />)}</> : null}
      {bookings.data?.length ? <><Heading>Bookings with partners</Heading>{bookings.data.map((b) => <Row key={b.id} title={b.partnerName} detail={`${longDay(b.date)}${b.time ? ` at ${b.time}` : ''}, for ${b.partySize}`} trailing={<Tag tone={b.status === 'confirmed' ? 'positive' : b.status === 'requested' ? 'accent' : 'neutral'} label={PARTNER_BOOKING_STATUS_LABEL[b.status]} />} />)}</> : null}
      <Muted>QÉRA is the Quintara Intelligence. It sees only what you can see in Quintara, asks before it acts, never pays for anything, and refers to your Lifestyle Curator only what it cannot manage itself.</Muted>
    </>
  );
}
