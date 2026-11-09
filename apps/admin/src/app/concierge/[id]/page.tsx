'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { StaffConciergeRequest } from '@quintara/api-client';
import { CONCIERGE_CATEGORY_LABEL, CONCIERGE_STATUS_LABEL } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const SETTABLE = ['reviewing', 'options_provided', 'confirmed', 'completed'] as const;

export default function ConciergeRequestPage() {
  const { id } = useParams<{ id: string }>();
  const state = useLoad((api) => api.getConciergeRequest(id), [id]);
  return (
    <>
      <p><Link className="muted" href="/concierge">All requests</Link></p>
      <Loaded state={state}>{(request) => <Detail request={request} onChanged={state.reload} />}</Loaded>
    </>
  );
}

function Detail({ request: r, onChanged }: { request: StaffConciergeRequest; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [reply, setReply] = useState('');
  const closed = r.status === 'completed' || r.status === 'cancelled';
  return (
    <>
      <div><h1>{r.subject}</h1><p className="lede">{r.memberName}, {r.memberNumber}. {CONCIERGE_CATEGORY_LABEL[r.category]}.{r.neededBy ? ` Needed by ${r.neededBy}.` : ''} Received {fmtDate(r.createdAt)}.</p></div>
      {closed ? <p><span className="chip">{CONCIERGE_STATUS_LABEL[r.status]}</span></p> : (
        <div className="row" role="group" aria-label="Status">
          {SETTABLE.map((status) => (
            <button key={status} className={`btn ${r.status === status ? '' : 'ghost'}`} aria-pressed={r.status === status} disabled={pending || r.status === status} onClick={() => run(() => api.setConciergeStatus(r.id, status), onChanged)}>{CONCIERGE_STATUS_LABEL[status]}</button>
          ))}
        </div>
      )}
      <p className="note">{r.details}</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="thread" role="log" aria-label="Conversation">
        {r.messages.length === 0 ? <p className="muted">No messages yet. Your first reply shows the member the request has been picked up.</p> : null}
        {r.messages.map((m) => <div key={m.id} className={`bubble ${m.from === 'desk' ? 'mine' : ''}`}>{m.body}<small>{m.from === 'desk' ? 'Desk' : r.memberName}, {fmtDate(m.sentAt)}</small></div>)}
      </div>
      {closed ? null : (
        <form className="composer" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) void run(() => api.replyToConciergeRequest(r.id, reply), () => { setReply(''); onChanged(); }); }}>
          <textarea aria-label="Reply to the member" placeholder="Reply to the member" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={2000} />
          <button className="btn" disabled={pending || !reply.trim()}>Send</button>
        </form>
      )}
    </>
  );
}
