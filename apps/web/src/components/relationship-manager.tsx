'use client';

import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { BUSINESS_ROLE_LABEL, RELATIONSHIP_MANAGER, RM_NOTICE, RM_TOPIC_LABEL, RM_TOPICS, rmEnquiryInputSchema } from '@quintara/domain';
import type { BusinessUpdate, RmEnquiry, RmTopic } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const when = (iso: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** Opportunities published by Quintara, and the member's conversations with the relationship manager. */
export function QuintaraBusiness() {
  const updates = useResource((api) => api.listBusinessUpdates());
  const enquiries = useResource((api) => api.listRmEnquiries());
  const [about, setAbout] = useState<BusinessUpdate | null>(null);
  const manager = useSection('relationship');
  return (
    <>
      <section className="panel" style={{ marginBottom: '2.5rem' }}>
        <h3>From Quintara</h3>
        <ResourceView resource={updates} isEmpty={(list) => list.length === 0} empty={<p className="muted" style={{ marginTop: '0.8rem' }}>No opportunities are addressed to you at the moment.</p>}>
          {(list) => list.map((u) => (
            <div className="panel-item" key={u.id} style={{ alignItems: 'flex-start' }}>
              <div>
                <strong style={{ fontWeight: 500 }}>{u.title}</strong>
                <small>{[u.sector, u.audience.length ? `For ${u.audience.map((role) => BUSINESS_ROLE_LABEL[role].toLowerCase()).join(', ')}` : 'For all members'].filter(Boolean).join('. ')}.</small>
                <p style={{ margin: '0.5rem 0 0' }}>{u.summary}</p>
              </div>
              <button className="btn small" onClick={() => { setAbout(u); document.getElementById('relationship-manager')?.scrollIntoView({ behavior: 'smooth' }); }}>Pursue this</button>
            </div>
          ))}
        </ResourceView>
      </section>

      <section className="panel" id="relationship-manager" style={{ marginBottom: '2.5rem' }}>
        <h3>Your relationship manager</h3>
        <p style={{ marginTop: '0.8rem' }}><strong style={{ fontWeight: 500 }}>{RELATIONSHIP_MANAGER.name}</strong>, {manager.summary}. {manager.description}</p>
        <p className="notice">{RM_NOTICE}</p>
        <ResourceView resource={enquiries}>
          {(list) => <>{list.map((e) => <Enquiry key={e.id} enquiry={e} onChanged={enquiries.reload} />)}</>}
        </ResourceView>
        <NewEnquiry key={about?.id ?? 'general'} about={about} onClear={() => setAbout(null)} onCreated={() => { setAbout(null); enquiries.reload(); }} />
      </section>
    </>
  );
}

function Enquiry({ enquiry: e, onChanged }: { enquiry: RmEnquiry; onChanged: () => void }) {
  const [open, setOpen] = useState(e.status === 'open');
  const [body, setBody] = useState('');
  const send = useAction((api) => api.sendRmMessage(e.id, body));
  const close = useAction(async (api) => { await api.closeRmEnquiry(e.id); return true; });
  return (
    <div style={{ borderBottom: '1px solid var(--q-line)', padding: '0.8rem 0' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)} style={{ textAlign: 'left' }}><strong style={{ fontWeight: 500 }}>{e.subject}</strong></button>
        <span className="row"><span className="tag">{e.updateTitle ?? RM_TOPIC_LABEL[e.topic]}</span><span className={`tag ${e.status === 'open' ? 'accent' : ''}`}>{e.status === 'open' ? 'Open' : 'Closed'}</span></span>
      </div>
      {open ? (
        <>
          <div className="thread">
            {e.messages.map((m) => <div key={m.id} className={`bubble ${m.from === 'member' ? 'mine' : ''}`}>{m.body}<small>{m.from === 'manager' ? RELATIONSHIP_MANAGER.shortName : 'You'}, {when(m.sentAt)}</small></div>)}
            {e.messages.every((m) => m.from === 'member') ? <p className="muted">{RELATIONSHIP_MANAGER.shortName} will reply here.</p> : null}
          </div>
          {e.status === 'open' ? (
            <form className="composer" onSubmit={async (event) => { event.preventDefault(); if (await send.run()) { setBody(''); onChanged(); } }}>
              <textarea aria-label={`Reply about ${e.subject}`} value={body} maxLength={2000} placeholder="Write a reply" onChange={(event) => setBody(event.target.value)} />
              <button className="btn small" disabled={send.pending || !body.trim()}>Send</button>
              <button type="button" className="btn quiet small" disabled={close.pending} onClick={async () => { if (window.confirm('Close this enquiry?') && (await close.run())) onChanged(); }}>Close</button>
            </form>
          ) : null}
          <ActionError error={send.error ?? close.error} />
        </>
      ) : null}
    </div>
  );
}

function NewEnquiry({ about, onClear, onCreated }: { about: BusinessUpdate | null; onClear: () => void; onCreated: () => void }) {
  const [topic, setTopic] = useState<RmTopic>('partnership');
  const [subject, setSubject] = useState(about ? about.title : '');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const create = useAction((api) => api.createRmEnquiry({ topic: about ? 'opportunity' : topic, subject, message, updateId: about?.id ?? null }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = rmEnquiryInputSchema.safeParse({ topic, subject, message });
    if (!parsed.success) { setProblem(parsed.error.issues[0]?.message ?? 'Check your enquiry'); return; }
    setProblem('');
    if (await create.run()) { setSubject(''); setMessage(''); onCreated(); }
  }
  return (
    <form className="stack" style={{ marginTop: '1.2rem' }} onSubmit={submit}>
      <strong style={{ fontWeight: 500 }}>{about ? `Ask about: ${about.title}` : `Write to ${RELATIONSHIP_MANAGER.shortName}`}</strong>
      {about ? <div><button type="button" className="link" onClick={onClear}>Ask about something else instead</button></div> : (
        <label>What it is about
          <select value={topic} onChange={(event) => setTopic(event.target.value as RmTopic)}>{RM_TOPICS.filter((t) => t !== 'opportunity').map((t) => <option key={t} value={t}>{RM_TOPIC_LABEL[t]}</option>)}</select>
        </label>
      )}
      <label>Subject<input value={subject} maxLength={120} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Your message<textarea value={message} maxLength={2000} onChange={(event) => setMessage(event.target.value)} placeholder="What you would like to understand, or the dealing you would like help with." /></label>
      {problem ? <span className="field-error" role="alert">{problem}</span> : null}
      <ActionError error={create.error} />
      <div><button className="btn" disabled={create.pending}>{create.pending ? 'Sending' : `Send to ${RELATIONSHIP_MANAGER.shortName}`}</button></div>
    </form>
  );
}
