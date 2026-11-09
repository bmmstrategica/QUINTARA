import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useAction, useResource } from '@quintara/app-core';
import { BUSINESS_ROLE_LABEL, INTRODUCTION_STATUS_LABEL, LISTING_KIND_LABEL, RELATIONSHIP_MANAGER, RM_NOTICE, RM_TOPIC_LABEL } from '@quintara/domain';
import type { BusinessListing, BusinessUpdate, Introduction, RmEnquiry, RmTopic } from '@quintara/domain';
import { ActionError, Body, Bubble, Button, Choice, clock, Composer, confirmThen, Divider, Field, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';
import { useSection } from '@/components/section-copy';

export default function BusinessScreen() {
  const listings = useResource((api) => api.listBusinessListings());
  const introductions = useResource((api) => api.listIntroductions());
  const updates = useResource((api) => api.listBusinessUpdates());
  const enquiries = useResource((api) => api.listRmEnquiries());
  const [about, setAbout] = useState<BusinessUpdate | null>(null);
  const intro = useSection('business');
  const manager = useSection('relationship');
  const reload = () => { listings.reload(); introductions.reload(); updates.reload(); enquiries.reload(); };
  return (
    <Screen onRefresh={reload} refreshing={listings.status === 'loading'}>
      <Title>Business</Title>
      <Muted>{intro.description}</Muted>
      <Muted>Quintara introduces members to one another. It does not offer, arrange or advise on investments, and takes no part in anything members agree between themselves.</Muted>
      <Heading>From Quintara</Heading>
      <ResourceView resource={updates} isEmpty={(list) => list.length === 0} empty={<Muted>No opportunities are addressed to you at the moment.</Muted>}>
        {(list) => list.map((u) => (
          <View key={u.id} style={{ gap: 6 }}>
            <Body style={{ fontWeight: '500' }}>{u.title}</Body>
            <Muted>{[u.sector, u.audience.length ? `For ${u.audience.map((role) => BUSINESS_ROLE_LABEL[role].toLowerCase()).join(', ')}` : 'For all members'].filter(Boolean).join('. ')}.</Muted>
            <Body>{u.summary}</Body>
            <Button quiet label={about?.id === u.id ? 'Writing about this below' : 'Pursue this'} onPress={() => setAbout(u)} />
            <Divider />
          </View>
        ))}
      </ResourceView>
      <Heading>Your relationship manager</Heading>
      <Body>{RELATIONSHIP_MANAGER.name}, {manager.summary}. {manager.description}</Body>
      <Muted>{RM_NOTICE}</Muted>
      <ResourceView resource={enquiries}>
        {(list) => <>{list.map((e) => <EnquiryCard key={e.id} enquiry={e} onChanged={enquiries.reload} />)}</>}
      </ResourceView>
      <NewEnquiry key={about?.id ?? 'general'} about={about} onClear={() => setAbout(null)} onCreated={() => { setAbout(null); enquiries.reload(); }} />
      <ResourceView resource={introductions}>
        {(list) => list.length ? <><Heading>Introductions</Heading>{list.map((i) => <IntroductionCard key={i.id} introduction={i} onChanged={reload} />)}</> : null}
      </ResourceView>
      <Heading>From members</Heading>
      <ResourceView resource={listings} isEmpty={(list) => list.length === 0} empty={<Muted>Nothing is addressed to your role at the moment.</Muted>}>
        {(list) => list.map((l) => <ListingCard key={l.id} listing={l} onChanged={reload} />)}
      </ResourceView>
      <Muted>To add a listing of your own, use the Quintara web app.</Muted>
    </Screen>
  );
}

function IntroductionCard({ introduction: i, onChanged }: { introduction: Introduction; onChanged: () => void }) {
  const router = useRouter();
  const { space } = useTheme();
  const respond = useAction((api, accept: boolean) => api.respondToIntroduction(i.id, accept));
  const withdraw = useAction(async (api) => { await api.withdrawIntroduction(i.id); return true; });
  const incoming = i.direction === 'incoming';
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>{incoming ? `${i.with.fullName} would like to meet you` : `To ${i.with.fullName}`}</Body>
      <Muted>{i.with.position}, {i.with.company}.{i.listingTitle ? ` About: ${i.listingTitle}.` : ''}</Muted>
      {incoming ? <Body>{i.note}</Body> : null}
      <ActionError error={respond.error ?? withdraw.error} />
      {incoming && i.status === 'offered' ? (
        <>
          <Button label="Accept" busy={respond.pending} onPress={() => confirmThen(`Accept the introduction to ${i.with.fullName}?`, 'You will be connected and can message each other.', 'Accept', async () => { if (await respond.run(true)) onChanged(); })} />
          <Button quiet label="Decline" busy={respond.pending} onPress={async () => { if (await respond.run(false)) onChanged(); }} />
        </>
      ) : <Tag tone={i.status === 'accepted' ? 'positive' : i.status === 'requested' || i.status === 'offered' ? 'accent' : 'neutral'} label={INTRODUCTION_STATUS_LABEL[i.status]} />}
      {i.status === 'accepted' ? <Button quiet label={`Message ${i.with.fullName.split(' ')[0]}`} onPress={() => router.push(`/messages/${i.with.memberId}`)} /> : null}
      {!incoming && (i.status === 'requested' || i.status === 'offered') ? <Button quiet label="Withdraw" busy={withdraw.pending} onPress={async () => { if (await withdraw.run()) onChanged(); }} /> : null}
      <Divider />
    </View>
  );
}

function ListingCard({ listing: l, onChanged }: { listing: BusinessListing; onChanged: () => void }) {
  const { space } = useTheme();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const request = useAction((api) => api.requestIntroduction(l.id, note));
  const open = l.myRequest === 'requested' || l.myRequest === 'offered';
  return (
    <View style={{ gap: space.sm }}>
      <Tag tone="accent" label={LISTING_KIND_LABEL[l.kind]} />
      <Body style={{ fontWeight: '500' }}>{l.title}</Body>
      <Body>{l.summary}</Body>
      <Muted>{l.mine ? `Your listing. Shown to ${l.audience.map((role) => BUSINESS_ROLE_LABEL[role].toLowerCase()).join(', ')}. ${l.status === 'pending' ? 'With the team for review.' : l.status[0]?.toUpperCase() + l.status.slice(1) + '.'}` : `${l.postedBy.fullName}, ${l.postedBy.position}, ${l.postedBy.company}.`}</Muted>
      {!l.mine && l.myRequest ? <Tag tone={l.myRequest === 'accepted' ? 'positive' : 'accent'} label={INTRODUCTION_STATUS_LABEL[l.myRequest]} /> : null}
      {asking ? (
        <>
          <Field label="Why you would like to be introduced" multiline value={note} onChangeText={setNote} maxLength={1000} placeholder="The team reads this first." error={request.error?.fields?.note} />
          <ActionError error={request.error} />
          <Button label="Send to the team" busy={request.pending} onPress={async () => { if (await request.run()) { setAsking(false); onChanged(); } }} />
          <Button quiet label="Not now" onPress={() => setAsking(false)} />
        </>
      ) : !l.mine && !open && l.myRequest !== 'accepted' ? <Button quiet label="Request an introduction" onPress={() => setAsking(true)} /> : null}
      <Divider />
    </View>
  );
}

function EnquiryCard({ enquiry: e, onChanged }: { enquiry: RmEnquiry; onChanged: () => void }) {
  const { space } = useTheme();
  const send = useAction((api, body: string) => api.sendRmMessage(e.id, body));
  const close = useAction(async (api) => { await api.closeRmEnquiry(e.id); return true; });
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>{e.subject}</Body>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}><Tag label={e.updateTitle ?? RM_TOPIC_LABEL[e.topic]} /><Tag label={e.status === 'open' ? 'Open' : 'Closed'} tone={e.status === 'open' ? 'accent' : 'neutral'} /></View>
      {e.messages.map((m) => <Bubble key={m.id} mine={m.from === 'member'} body={m.body} meta={`${m.from === 'manager' ? 'Wayne Huffton' : 'You'}, ${clock(m.sentAt)}`} />)}
      {e.messages.every((m) => m.from === 'member') ? <Muted>Wayne Huffton will reply here.</Muted> : null}
      {e.status === 'open' ? (
        <>
          <Composer placeholder="Write a reply" busy={send.pending} onSend={async (body) => { const sent = Boolean(await send.run(body)); if (sent) onChanged(); return sent; }} />
          <Button quiet label="Close this enquiry" busy={close.pending} onPress={() => confirmThen('Close this enquiry?', 'You can start a new one at any time.', 'Close', async () => { if (await close.run()) onChanged(); })} />
        </>
      ) : null}
      <ActionError error={send.error ?? close.error} />
      <Divider />
    </View>
  );
}

function NewEnquiry({ about, onClear, onCreated }: { about: BusinessUpdate | null; onClear: () => void; onCreated: () => void }) {
  const { space } = useTheme();
  const [topic, setTopic] = useState<RmTopic>('partnership');
  const [subject, setSubject] = useState(about ? about.title : '');
  const [message, setMessage] = useState('');
  const create = useAction((api) => api.createRmEnquiry({ topic: about ? 'opportunity' : topic, subject, message, updateId: about?.id ?? null }));
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>{about ? `Ask about: ${about.title}` : 'Write to Wayne Huffton'}</Body>
      {about ? <Button quiet label="Ask about something else instead" onPress={onClear} /> : (
        <Choice label="What it is about" value={topic} onChange={setTopic} options={(['partnership', 'advisory', 'brand_collaboration', 'investment_insight'] as const).map((t) => [t, RM_TOPIC_LABEL[t]] as const)} />
      )}
      <Field label="Subject" value={subject} onChangeText={setSubject} maxLength={120} error={create.error?.fields?.subject} />
      <Field label="Your message" value={message} onChangeText={setMessage} maxLength={2000} multiline error={create.error?.fields?.message} />
      <ActionError error={create.error} />
      <Button label="Send to Wayne Huffton" busy={create.pending} onPress={async () => { if (await create.run()) { setSubject(''); setMessage(''); onCreated(); } }} />
      <Divider />
    </View>
  );
}
