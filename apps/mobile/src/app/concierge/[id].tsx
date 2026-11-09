import { useLocalSearchParams } from 'expo-router';
import { useAction, useResource } from '@quintara/app-core';
import { CONCIERGE_CATEGORY_LABEL, CONCIERGE_STATUS_LABEL } from '@quintara/domain';
import { ActionError, Body, Bubble, Button, clock, Composer, confirmThen, Divider, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';

export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const request = useResource((api) => api.getConciergeRequest(id), [id]);
  const send = useAction((api, body: string) => api.sendConciergeMessage(id, body));
  const confirm = useAction((api) => api.confirmConciergeRequest(id));
  const cancel = useAction((api) => api.cancelConciergeRequest(id));
  return (
    <Screen onRefresh={request.reload} refreshing={request.status === 'loading'}>
      <ResourceView resource={request}>
        {(data) => {
          const open = data.status !== 'completed' && data.status !== 'cancelled';
          return (
            <>
              <Title>{data.subject}</Title>
              <Tag tone={data.status === 'cancelled' ? 'neutral' : 'accent'} label={`${CONCIERGE_CATEGORY_LABEL[data.category]}. ${CONCIERGE_STATUS_LABEL[data.status]}`} />
              <Body>{data.details}</Body>
              <Divider />
              {data.messages.length === 0 ? <Muted>The desk has your request and will reply here.</Muted> : null}
              {data.messages.map((message) => <Bubble key={message.id} mine={message.from === 'member'} body={message.body} meta={`${message.from === 'desk' ? 'Concierge desk' : 'You'}, ${clock(message.sentAt)}`} />)}
              <ActionError error={send.error ?? confirm.error ?? cancel.error} />
              {data.status === 'options_provided' ? (
                <Button label="Confirm these arrangements" busy={confirm.pending} onPress={() => confirmThen('Confirm?', 'The desk will go ahead and book what it has offered.', 'Confirm', async () => { if (await confirm.run()) request.reload(); })} />
              ) : null}
              {open ? <Composer placeholder="Reply to the desk" busy={send.pending} onSend={async (body) => { const sent = await send.run(body); if (sent) request.reload(); return Boolean(sent); }} /> : null}
              {open && data.status !== 'confirmed' ? (
                <Button quiet label="Cancel request" busy={cancel.pending} onPress={() => confirmThen('Cancel this request?', 'The desk will stop work on it.', 'Cancel request', async () => { if (await cancel.run()) request.reload(); }, true)} />
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
