import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { REPORT_REASON_LABELS, REPORT_REASONS } from '@quintara/domain';
import type { ReportReason } from '@quintara/domain';
import { ActionError, Body, Button, Choice, confirmThen, Divider, Field, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';

export default function MemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const member = useResource((api) => api.getMember(id), [id]);
  const connect = useAction((api) => api.requestConnection(id));
  const act = async () => { if (await connect.run()) member.reload(); };

  return (
    <Screen>
      <ResourceView resource={member}>
        {(profile) => (
          <>
            <Title>{profile.fullName}</Title>
            <Body>{profile.position}, {profile.company}</Body>
            <Muted>{profile.industry}. {profile.city}.</Muted>
            <Body>{profile.biography}</Body>
            <Divider />
            <Muted>Looking for</Muted>
            <Body>{profile.lookingFor || 'Not said'}</Body>
            <Muted>Can offer</Muted>
            <Body>{profile.canOffer || 'Not said'}</Body>
            <Divider />
            <ActionError error={connect.error} />
            {profile.connection === 'none' ? <Button busy={connect.pending} label="Connect" onPress={act} /> : null}
            {profile.connection === 'incoming' ? <Button busy={connect.pending} label="Accept connection" onPress={act} /> : null}
            {profile.connection === 'requested' ? <Tag tone="accent" label="Connection requested" /> : null}
            {profile.connection === 'connected' ? <><Tag tone="positive" label="Connected" /><Button label="Send a message" onPress={() => router.push(`/messages/${id}`)} /></> : null}
            <Muted>Contact details stay private. Messaging opens once you are connected.</Muted>
            <Divider />
            <Safety memberId={id} firstName={profile.fullName.split(' ')[0] ?? profile.fullName} />
          </>
        )}
      </ResourceView>
    </Screen>
  );
}

/** Report a concern to staff, or block this member. Both are private to the member who does them. */
function Safety({ memberId, firstName }: { memberId: string; firstName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>('unwanted_contact');
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  const report = useAction(async (api) => { await api.reportMember(memberId, { reason, detail }); return true; });
  const block = useAction(async (api) => { await api.blockMember(memberId); return true; });
  if (!open) return <Button quiet label="Safety" onPress={() => setOpen(true)} />;
  return (
    <>
      <Heading>Safety</Heading>
      {sent ? <Body>Your report is with the Quintara team. {firstName} is not told who reported them.</Body> : (
        <>
          <Choice label="Report a concern" value={reason} onChange={setReason} options={REPORT_REASONS.map((key) => [key, REPORT_REASON_LABELS[key]] as const)} />
          <Field label="What happened (optional)" multiline value={detail} onChangeText={setDetail} maxLength={1000} />
          <ActionError error={report.error} />
          <Button label="Send report" busy={report.pending} onPress={async () => { if (await report.run()) setSent(true); }} />
        </>
      )}
      <Muted>Blocking hides you from each other and ends any connection. {firstName} is not notified.</Muted>
      <ActionError error={block.error} />
      <Button quiet label={`Block ${firstName}`} busy={block.pending} onPress={() => confirmThen(`Block ${firstName}?`, 'You can undo this from the Members tab.', 'Block', async () => { if (await block.run()) router.back(); }, true)} />
    </>
  );
}
