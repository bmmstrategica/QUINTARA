'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAction, useApi, useResource, useSession } from '@quintara/app-core';
import { CONCIERGE_SPECIALIST, longDay, PARTNER_BOOKING_STATUS_LABEL, QERA_GUEST_HELP, QERA_HELP } from '@quintara/domain';
import type { BriefLink, QeraMemory, QeraReminder, QeraThread, QeraUsage, WeeklyBrief } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const GUEST_IDEAS = ['What is Quintara?', 'What experiences are open to guests?', 'What services are there?', 'How does membership work?'];
const IDEAS = ['What does my week look like?', 'Remember that I am vegetarian', 'Plan a weekend for me', 'Book the whole plan for 2', 'What would you recommend for me?', 'Remind me to call the florist tomorrow at 10am', 'What services can you arrange?', 'Show my bookings'];

export default function QeraPage() {
  const { session, guest, status } = useSession();
  const loaded = useResource((api) => (session || guest ? api.getQeraThread() : Promise.resolve(null)), [Boolean(session || guest)]);
  if (status === 'ready' && !session && !guest) return <GuestInvitation />;
  if (guest) {
    return (
      <>
        <div className="head"><div><h2>QÉRA</h2><p className="lede">The Quintara Intelligence. As a guest you can ask QÉRA about Quintara, its experiences, services, Maison Quintara and TV, for up to five hours a day. Booking, plans and introductions are for members.</p></div></div>
        <ResourceView resource={loaded}>{(thread) => (thread ? <Chat initial={thread} guest /> : null)}</ResourceView>
        <div style={{ maxWidth: '44rem', marginTop: '2rem' }}><WhatsAppPanel /></div>
      </>
    );
  }
  return <ChiefOfStaff loaded={loaded} />;
}

/** For members: QÉRA as Chief of Staff. The conversation, with the week, reminders and memory beside it. */
function ChiefOfStaff({ loaded }: { loaded: ReturnType<typeof useResource<QeraThread | null>> }) {
  const qera = useSection('qera');
  const [turn, setTurn] = useState(0);
  return (
    <>
      <div className="head"><div><p className="eyebrow">Your Chief of Staff</p><h2>QÉRA</h2><p className="lede">{qera.description}</p></div></div>
      <div className="chief-grid">
        <div><ResourceView resource={loaded}>{(thread) => (thread ? <Chat initial={thread} onTurn={() => setTurn((n) => n + 1)} /> : null)}</ResourceView></div>
        <aside className="stack" aria-label="Your Chief of Staff">
          <BriefPanel version={turn} />
          <RemindersPanel version={turn} />
          <TodayPanel />
          <WhatsAppPanel />
          <MemoryPanel version={turn} />
        </aside>
      </div>
    </>
  );
}

const briefHref = (link: BriefLink | null) => !link ? null : link.kind === 'experience' ? `/experiences/${link.id}` : link.kind === 'service' ? '/lifestyle' : link.kind === 'bookings' ? '/bookings' : link.kind === 'business' ? '/business' : link.kind === 'boutique' ? '/boutique' : link.kind === 'memory' ? '/qera/memory' : null;

function BriefPanel({ version }: { version: number }) {
  const brief = useResource((api) => api.getWeeklyBrief(), [version]);
  return (
    <section className="panel" aria-label="Your week">
      <h3>Your brief</h3>
      <ResourceView resource={brief}>
        {(b: WeeklyBrief) => (
          <>
            <p style={{ margin: '0.4rem 0 1rem' }}>{b.greeting}</p>
            {b.sections.filter((x) => x.items.length).map((x) => (
              <div className="brief-section" key={x.key}>
                <h4>{x.title}</h4>
                {x.items.map((item, i) => {
                  const href = briefHref(item.link);
                  return <div className="panel-item" key={i}><div>{href ? <Link href={href}><strong style={{ fontWeight: 500 }}>{item.title}</strong></Link> : <strong style={{ fontWeight: 500 }}>{item.title}</strong>}<small>{item.detail}</small></div></div>;
                })}
              </div>
            ))}
            <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>{b.enabled ? 'QÉRA sends this to you every Monday morning, with reminders of dates and bookings. Switch it off under Profile.' : 'The Monday brief is off. Switch it on under Profile.'}</p>
          </>
        )}
      </ResourceView>
    </section>
  );
}

function RemindersPanel({ version }: { version: number }) {
  const [form, setForm] = useState({ text: '', date: '', time: '09:00' });
  const [added, setAdded] = useState(0);
  const reminders = useResource((api) => api.listReminders(), [version, added]);
  const add = useAction(async (api) => { await api.createReminder(form); return true; });
  const cancel = useAction(async (api, id: string) => { await api.cancelReminder(id); return true; });
  return (
    <section className="panel" aria-label="Reminders">
      <h3>Reminders</h3>
      <ResourceView resource={reminders}>
        {(list: QeraReminder[]) => (
          <>
            {list.filter((r) => r.status === 'scheduled').length === 0 ? <p className="muted" style={{ fontSize: '0.9rem' }}>Nothing to remind you of. Add one here, or tell QÉRA “remind me to … on Friday at 10am”.</p> : null}
            {list.filter((r) => r.status === 'scheduled').map((r) => (
              <div className="panel-item" key={r.id}>
                <div><strong style={{ fontWeight: 500 }}>{r.text}</strong><small>{new Date(r.remindAt).toLocaleString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })}</small></div>
                <button className="btn quiet small" disabled={cancel.pending} onClick={async () => { if (await cancel.run(r.id)) setAdded((n) => n + 1); }}>Cancel</button>
              </div>
            ))}
          </>
        )}
      </ResourceView>
      <form className="stack" style={{ marginTop: '1rem' }} aria-label="Add a reminder" onSubmit={async (event) => { event.preventDefault(); if (await add.run()) { setForm({ text: '', date: '', time: '09:00' }); setAdded((n) => n + 1); } }}>
        <label>Remind me to<input value={form.text} maxLength={200} onChange={(event) => setForm({ ...form, text: event.target.value })} /></label>
        <div className="field-row">
          <label>Date<input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
          <label>Time<input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} /></label>
        </div>
        <ActionError error={add.error ?? cancel.error} />
        <div><button className="btn small" disabled={add.pending}>{add.pending ? 'Adding' : 'Add reminder'}</button></div>
      </form>
    </section>
  );
}

/** Today's brief and the member's calendar, from the QÉRA page. */
function TodayPanel() {
  const calendar = useResource((api) => api.getCalendar());
  return (
    <section className="panel" aria-label="Your day">
      <h3>Your day</h3>
      <p className="muted" style={{ fontSize: '0.9rem' }}>QÉRA’s daily brief: your day in order, from your calendar and from Quintara, each morning.{calendar.data ? (calendar.data.connection ? ` Your ${calendar.data.connection.label} is connected.` : ' Connect your calendar to see your own meetings in it.') : ''}</p>
      <div className="row">
        <Link className="btn small" href="/qera/today">Today’s brief</Link>
        <Link className="btn quiet small" href="/qera/calendar">{calendar.data?.connection ? 'Your calendar' : 'Connect a calendar'}</Link>
      </div>
    </section>
  );
}

/** QÉRA on WhatsApp, from the QÉRA page. */
function WhatsAppPanel() {
  const link = useResource((api) => api.getWhatsApp());
  if (link.data && !link.data.available) return null;
  const linked = link.data?.status === 'linked';
  return (
    <section className="panel" aria-label="QÉRA on WhatsApp">
      <h3>QÉRA on WhatsApp</h3>
      <p className="muted" style={{ fontSize: '0.9rem' }}>{linked ? `Linked to your number ending ${link.data!.numberMasked!.slice(-4)}. Write to QÉRA there as you do here; it asks before it does anything.` : 'Ask, plan and book from WhatsApp, in the same conversation. QÉRA acts only when you tap Confirm.'}</p>
      <div className="row"><Link className="btn small quiet" href="/qera/whatsapp">{linked ? 'Manage' : 'Link WhatsApp'}</Link></div>
    </section>
  );
}

function MemoryPanel({ version }: { version: number }) {
  const memory = useResource((api) => api.getQeraMemory(), [version]);
  return (
    <section className="panel" aria-label="What QÉRA remembers">
      <h3>What QÉRA remembers</h3>
      <ResourceView resource={memory}>
        {(m: QeraMemory) => (
          <>
            <p className="muted" style={{ fontSize: '0.9rem' }}>{m.items.length ? `${m.items.length} thing${m.items.length > 1 ? 's' : ''}: ${m.items.slice(0, 4).map((i) => i.label).join(', ')}${m.items.length > 4 ? ' and more' : ''}.` : 'Nothing yet. QÉRA remembers only what you tell it to.'}{m.suggestions.length ? ` ${m.suggestions.length} suggestion${m.suggestions.length > 1 ? 's' : ''} waiting.` : ''}</p>
            <Link className="btn quiet small" href="/qera/memory">See and edit</Link>
          </>
        )}
      </ResourceView>
    </section>
  );
}

/** For visitors: QÉRA is open to anyone with a free guest account. */
function GuestInvitation() {
  return (
    <div className="split">
      <div>
        <h2>QÉRA</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>The Quintara Intelligence. Create a free guest account to ask QÉRA about Quintara, its signature experiences, lifestyle services, Maison Quintara and Quintara TV, for up to five hours a day.</p>
      </div>
      <div className="stack">
        <div className="row"><Link className="btn" href="/join">Create a guest account</Link><Link className="btn quiet" href="/sign-in">Sign in</Link></div>
        <p className="muted">Members talk to QÉRA without a daily limit, and QÉRA books and plans for them. <Link href="/apply">Apply for membership</Link></p>
      </div>
    </div>
  );
}

const hours = (seconds: number) => { const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };

/** A guest's time today, counted by the server. The screen sends a heartbeat each minute while it is in view. */
function GuestAllowance({ usage, onUsage }: { usage: QeraUsage; onUsage: (next: QeraUsage) => void }) {
  const api = useApi();
  useEffect(() => {
    if (usage.exhausted) return;
    const beat = () => { if (document.visibilityState === 'visible') api.qeraHeartbeat().then((next) => { if (next) onUsage(next); }).catch(() => undefined); };
    const timer = window.setInterval(beat, 60_000);
    return () => window.clearInterval(timer);
  }, [api, usage.exhausted, onUsage]);
  const left = Math.max(0, usage.limitSeconds - usage.usedSeconds);
  return (
    <div className="notice" role="status" aria-label="Your QÉRA time today" style={{ marginBottom: '1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>{usage.exhausted ? 'You have used today’s five hours with QÉRA.' : `${hours(left)} of QÉRA left today`}</span>
        <span className="muted" style={{ fontSize: '0.85rem' }}>Resets {new Date(usage.resetsAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })} {usage.exhausted ? '' : '· guest account'}</span>
      </div>
      <progress max={usage.limitSeconds} value={usage.usedSeconds} aria-label="QÉRA time used today" style={{ width: '100%', marginTop: '0.6rem' }} />
      {usage.exhausted ? (
        <div className="row" style={{ marginTop: '0.8rem' }}>
          <Link className="btn" href="/apply">Apply for membership</Link>
          <span className="muted">Members talk to QÉRA without a daily limit.</span>
        </div>
      ) : null}
    </div>
  );
}

function Chat({ initial, guest = false, onTurn }: { initial: QeraThread; guest?: boolean; onTurn?: () => void }) {
  const [thread, setThread] = useState(initial);
  const [usage, setUsage] = useState<QeraUsage | null>(initial.usage ?? null);
  useEffect(() => { if (thread.usage) setUsage(thread.usage); }, [thread]);
  const [text, setText] = useState('');
  const send = useAction((api, message: string) => api.sendQeraMessage(message));
  const exhausted = Boolean(usage?.exhausted) || send.error?.code === 'forbidden';
  const decide = useAction((api, id: string, yes: boolean) => (yes ? api.confirmQeraProposal(id) : api.cancelQeraProposal(id)));
  const clear = useAction(async (api) => { await api.clearQeraThread(); return true; });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [thread]);
  // What QÉRA has prepared or sent is reloaded whenever the conversation moves on.
  const documents = useResource((api) => (guest ? Promise.resolve([]) : api.listQeraDocuments()), [thread]);
  const bookings = useResource((api) => (guest ? Promise.resolve([]) : api.listPartnerBookings()), [thread]);
  const cancelBooking = useAction(async (api, id: string) => { await api.cancelPartnerBooking(id); return true; });
  const busy = send.pending || decide.pending;

  async function submit(message: string) {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    setText('');
    const next = await send.run(trimmed);
    if (next) { setThread(next); onTurn?.(); }
  }
  async function answer(yes: boolean) {
    if (!thread.pending) return;
    const next = await decide.run(thread.pending.id, yes);
    if (next) { setThread(next); onTurn?.(); }
  }

  return (
    <div style={{ maxWidth: '44rem' }}>
      {usage ? <GuestAllowance usage={exhausted ? { ...usage, exhausted: true, usedSeconds: usage.limitSeconds } : usage} onUsage={setUsage} /> : null}
      <div className="thread" role="log" aria-live="polite" aria-label="Conversation with QÉRA" style={{ maxWidth: 'none' }}>
        {thread.messages.length === 0 ? <div className="bubble">{guest ? QERA_GUEST_HELP : QERA_HELP}</div> : null}
        {thread.messages.map((m) => <div key={m.id} className={`bubble ${m.role === 'member' ? 'mine' : ''}`}>{m.text}{m.via === 'whatsapp' ? <small className="via">On WhatsApp</small> : null}</div>)}
        {busy ? <div className="bubble muted" role="status">One moment</div> : null}
        <div ref={end} />
      </div>
      {thread.pending ? (
        <div className="notice" role="group" aria-label="Waiting for your answer">
          <p style={{ margin: 0 }}>{thread.pending.summary}</p>
          <p className="row" style={{ margin: '0.8rem 0 0' }}>
            <button className="btn small" disabled={busy} onClick={() => answer(true)}>Yes, go ahead</button>
            <button className="btn quiet small" disabled={busy} onClick={() => answer(false)}>No</button>
          </p>
        </div>
      ) : null}
      <ActionError error={exhausted && send.error?.code === 'forbidden' ? null : send.error ?? decide.error ?? clear.error ?? cancelBooking.error} />
      {thread.messages.length === 0 && !exhausted ? <div className="row" style={{ margin: '1rem 0' }}>{(guest ? GUEST_IDEAS : IDEAS).map((idea) => <button key={idea} className="btn quiet small" disabled={busy} onClick={() => submit(idea)}>{idea}</button>)}</div> : null}
      <form className="composer" style={{ maxWidth: 'none', marginTop: '1rem' }} onSubmit={(event) => { event.preventDefault(); void submit(text); }}>
        <textarea aria-label="Message QÉRA" value={text} maxLength={1000} disabled={exhausted} placeholder={exhausted ? 'Apply for membership to keep talking to QÉRA' : guest ? 'Ask about Quintara' : 'Ask, or tell me what you would like arranged'} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(text); } }} />
        <button className="btn" disabled={busy || exhausted || !text.trim()}>Send</button>
      </form>
      {documents.data?.length ? (
        <section className="panel" style={{ marginTop: '2rem' }} aria-label="Documents">
          <h3>Documents</h3>
          {documents.data.map((d) => (
            <div className="panel-item" key={d.id}>
              <div><strong style={{ fontWeight: 500 }}>{d.title}</strong><small>Prepared {new Date(d.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}</small></div>
              <Link className="btn quiet small" href={`/qera/documents/${d.id}`}>Open</Link>
            </div>
          ))}
        </section>
      ) : null}
      {bookings.data?.length ? (
        <section className="panel" style={{ marginTop: '2rem' }} aria-label="Partner bookings">
          <h3>Bookings with partners</h3>
          {bookings.data.map((b) => (
            <div className="panel-item" key={b.id}>
              <div><strong style={{ fontWeight: 500 }}>{b.partnerName}</strong><small>{longDay(b.date)}{b.time ? ` at ${b.time}` : ''}, for {b.partySize}.{b.partnerNote ? ` ${b.partnerNote}` : ''}</small></div>
              <div className="row">
                <span className={`tag ${b.status === 'confirmed' ? 'positive' : b.status === 'requested' ? 'accent' : ''}`}>{PARTNER_BOOKING_STATUS_LABEL[b.status]}</span>
                {b.status === 'requested' || b.status === 'confirmed' ? <button className="btn quiet small" disabled={cancelBooking.pending} onClick={async () => { if (window.confirm(`Cancel your booking at ${b.partnerName}?`) && (await cancelBooking.run(b.id))) bookings.reload(); }}>Cancel</button> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <p className="muted" style={{ fontSize: '0.85rem', marginTop: '1rem' }}>
        QÉRA sees only what you can see in Quintara, and never pays for anything: payments are always made by you. {thread.messages.length ? <button className="link" disabled={clear.pending} onClick={async () => { if (window.confirm('Clear this conversation?') && (await clear.run())) setThread({ messages: [], pending: null, usage }); }}>Clear this conversation</button> : null}
      </p>
    </div>
  );
}
