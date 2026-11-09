'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAction, useResource } from '@quintara/app-core';
import { CONCIERGE_CATEGORY_LABEL, CONCIERGE_PATH, CONCIERGE_STATUS_LABEL } from '@quintara/domain';
import type { ConciergeRequest } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { Composer, Thread, timeOf } from '@/components/thread';

export default function ConciergeRequestPage() {
  const { id } = useParams<{ id: string }>();
  const request = useResource((api) => api.getConciergeRequest(id), [id]);
  return (
    <>
      <p><Link href="/concierge" className="muted">All requests</Link></p>
      <ResourceView resource={request}>{(data) => <Detail request={data} onChanged={request.reload} />}</ResourceView>
    </>
  );
}

function Detail({ request, onChanged }: { request: ConciergeRequest; onChanged: () => void }) {
  const send = useAction((api, body: string) => api.sendConciergeMessage(request.id, body));
  const confirm = useAction((api) => api.confirmConciergeRequest(request.id));
  const cancel = useAction((api) => api.cancelConciergeRequest(request.id));
  const position = CONCIERGE_PATH.indexOf(request.status);
  const closed = request.status === 'completed' || request.status === 'cancelled';
  return (
    <>
      <div className="head">
        <div>
          <h2>{request.subject}</h2>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>{CONCIERGE_CATEGORY_LABEL[request.category]}.{request.neededBy ? ` Needed by ${new Date(request.neededBy).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}.` : ''}</p>
        </div>
        <button className="link" onClick={onChanged}>Check for replies</button>
      </div>
      {position >= 0 ? (
        <ol className="steps">{CONCIERGE_PATH.map((status, index) => (
          <li key={status} className={index < position ? 'done' : index === position ? 'current' : undefined} aria-current={index === position ? 'step' : undefined}>{CONCIERGE_STATUS_LABEL[status]}</li>
        ))}</ol>
      ) : <p><span className="tag">Cancelled</span></p>}
      <p>{request.details}</p>
      <Thread empty="The desk has your request and will reply here." bubbles={request.messages.map((m) => ({ id: m.id, mine: m.from === 'member', body: m.body, meta: `${m.from === 'desk' ? 'Concierge desk' : 'You'}, ${timeOf(m.sentAt)}` }))} />
      {closed ? null : (
        <>
          <Composer label="Message the desk" pending={send.pending} error={send.error} onSend={async (body) => { const ok = Boolean(await send.run(body)); if (ok) onChanged(); return ok; }} />
          <ActionError error={confirm.error} /><ActionError error={cancel.error} />
          <div className="row" style={{ marginTop: '1.2rem' }}>
            {request.status === 'options_provided' ? <button className="btn" disabled={confirm.pending} onClick={async () => { if (await confirm.run()) onChanged(); }}>{confirm.pending ? 'Confirming' : 'Confirm this option'}</button> : null}
            <button className="btn quiet" disabled={cancel.pending} onClick={async () => { if (await cancel.run()) onChanged(); }}>{cancel.pending ? 'Cancelling' : 'Cancel request'}</button>
          </div>
        </>
      )}
    </>
  );
}
