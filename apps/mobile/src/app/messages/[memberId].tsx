import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { useAction, useApi, useLive, useResource } from '@quintara/app-core';
import { ActionError, Bubble, clock, Composer, Heading, Muted, ResourceView, Screen } from '@/components/ui';

export default function ConversationScreen() {
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  const api = useApi();
  const thread = useResource((client) => client.getConversation(memberId), [memberId]);
  // New messages appear while the conversation is open and the app is in the foreground.
  useLive(thread.refresh, 5000);
  const send = useAction((client, body: string) => client.sendMessage(memberId, body));
  // Opening the conversation, and each message arriving while it is open, marks it as read.
  const count = thread.data?.messages.length ?? 0;
  useEffect(() => { void api.markConversationRead(memberId).catch(() => undefined); }, [api, memberId, count]);
  return (
    <Screen onRefresh={thread.reload} refreshing={thread.status === 'loading'}>
      <ResourceView resource={thread}>
        {(data) => (
          <>
            <Heading>{data.with.fullName}</Heading>
            <Muted>{data.with.position}, {data.with.company}</Muted>
            {data.messages.length === 0 ? <Muted>No messages yet.</Muted> : null}
            {data.messages.map((message) => <Bubble key={message.id} mine={message.mine} body={message.body} meta={clock(message.sentAt)} />)}
            <ActionError error={send.error} />
            {data.canSend
              ? <Composer placeholder={`Write to ${data.with.fullName.split(' ')[0]}`} busy={send.pending} onSend={async (body) => { const sent = await send.run(body); if (sent) thread.refresh(); return Boolean(sent); }} />
              : <Muted>Messaging opens once you are connected.</Muted>}
          </>
        )}
      </ResourceView>
    </Screen>
  );
}
