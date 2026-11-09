'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { CALENDAR_PROVIDER_HELP, CALENDAR_PROVIDER_LABEL, CALENDAR_PROVIDERS, formatDateTime } from '@quintara/domain';
import type { CalendarProvider, CalendarState } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

/** Connecting a calendar to QÉRA, by choice, so the daily brief shows the member's own day. */
export default function CalendarPage() {
  const state = useResource((api) => api.getCalendar());
  return (
    <>
      <p><Link className="muted" href="/qera">Back to QÉRA</Link></p>
      <div className="head"><div>
        <h2>Your calendar</h2>
        <p className="lede">Connect your calendar and QÉRA puts your own meetings beside what Quintara has arranged, so your daily brief shows the day as it really is. It is your choice, and you can disconnect at any time.</p>
      </div></div>
      <ResourceView resource={state}>{(current) => (current.connection ? <Connected state={current} onChanged={state.reload} /> : <Connect onConnected={state.reload} />)}</ResourceView>
    </>
  );
}

function Connect({ onConnected }: { onConnected: () => void }) {
  const [provider, setProvider] = useState<CalendarProvider>('google');
  const [address, setAddress] = useState('');
  const [showTitles, setShowTitles] = useState(true);
  const [consent, setConsent] = useState(false);
  const connect = useAction((api) => api.connectCalendar({ provider, address, showTitles, consent: consent as true }));
  return (
    <div className="split">
      <form className="stack" onSubmit={async (event) => { event.preventDefault(); if (await connect.run()) onConnected(); }} noValidate>
        <fieldset>
          <legend>Where is your calendar?</legend>
          <div className="checks" role="radiogroup">
            {CALENDAR_PROVIDERS.map((p) => <label className="check" key={p}><input type="radio" name="provider" checked={provider === p} onChange={() => setProvider(p)} /> {CALENDAR_PROVIDER_LABEL[p]}</label>)}
          </div>
        </fieldset>
        <p className="muted" style={{ margin: 0 }}>{CALENDAR_PROVIDER_HELP[provider]}</p>
        {provider === 'sample' ? null : (
          <label>Private calendar address
            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://… or webcal://…" autoComplete="off" spellCheck={false} aria-invalid={connect.error?.fields?.address ? true : undefined} />
            {connect.error?.fields?.address ? <span className="field-error" role="alert">{connect.error.fields.address}</span> : null}
          </label>
        )}
        <label className="check"><input type="checkbox" checked={showTitles} onChange={(event) => setShowTitles(event.target.checked)} /> Let QÉRA see what my meetings are. Untick to share only the times you are busy.</label>
        <label className="check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> I agree that QÉRA reads this calendar to prepare my daily brief.</label>
        {connect.error?.fields?.consent ? <span className="field-error" role="alert">Please agree to let QÉRA read your calendar.</span> : null}
        <ActionError error={connect.error?.code === 'validation' ? null : connect.error} />
        <div><button className="btn" disabled={connect.pending}>{connect.pending ? 'Connecting' : 'Connect calendar'}</button></div>
      </form>
      <div className="stack">
        <h3>How your calendar is kept</h3>
        <ul className="plain-list">
          <li>The address is stored encrypted and never shown again, to you or anyone else.</li>
          <li>QÉRA reads only the next seven days: the time, the title and the place. Nothing else.</li>
          <li>Nothing from your calendar is shared with partners, the concierge desk or other members.</li>
          <li>Disconnecting deletes the address and every event at once. Your calendar is in your data download.</li>
        </ul>
      </div>
    </div>
  );
}

function Connected({ state, onChanged }: { state: CalendarState; onChanged: () => void }) {
  const c = state.connection!;
  const titles = useAction((api, show: boolean) => api.updateCalendar({ showTitles: show }));
  const sync = useAction((api) => api.syncCalendar());
  const disconnect = useAction(async (api) => { await api.disconnectCalendar(); return true; });
  const days = new Map<string, typeof state.events>();
  for (const e of state.events) { const d = formatDateTime(e.startsAt, 'Africa/Johannesburg').long; days.set(d, [...(days.get(d) ?? []), e]); }
  return (
    <div className="split">
      <div className="stack" style={{ alignContent: 'start' }}>
        <section className="panel" aria-label="Connection">
          <h3>{c.label}</h3>
          <p className="muted" style={{ margin: 0 }}>Connected {new Date(c.connectedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}{c.syncedAt ? `. Updated ${new Date(c.syncedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}` : ''}.</p>
          {c.syncError ? <p className="notice" role="status">{c.syncError}</p> : null}
          <label className="check"><input type="checkbox" checked={c.showTitles} disabled={titles.pending} onChange={async (event) => { if (await titles.run(event.target.checked)) onChanged(); }} /> Let QÉRA see what my meetings are</label>
          <ActionError error={titles.error ?? sync.error ?? disconnect.error} />
          <div className="row">
            <button className="btn quiet small" disabled={sync.pending} onClick={async () => { if (await sync.run()) onChanged(); }}>{sync.pending ? 'Updating' : 'Update now'}</button>
            <button className="btn quiet small" disabled={disconnect.pending} onClick={async () => { if (window.confirm('Disconnect your calendar? QÉRA deletes the address and every event at once.') && (await disconnect.run())) onChanged(); }}>Disconnect</button>
          </div>
        </section>
        <p><Link href="/qera/today">See today’s brief</Link></p>
      </div>
      <section aria-label="The coming week">
        <h3>The coming week, as QÉRA sees it</h3>
        {state.events.length === 0 ? <p className="muted">Nothing in the next seven days.</p> : [...days].map(([day, events]) => (
          <div key={day} className="cal-day">
            <h4>{day}</h4>
            {events.map((e) => <div key={e.id} className="panel-item"><div><strong style={{ fontWeight: 500 }}>{e.title || 'Busy'}</strong><small>{e.allDay ? 'All day' : `${formatDateTime(e.startsAt, 'Africa/Johannesburg').time}${e.endsAt ? ` to ${formatDateTime(e.endsAt, 'Africa/Johannesburg').time}` : ''}`}{e.location ? `. ${e.location}` : ''}</small></div></div>)}
          </div>
        ))}
      </section>
    </div>
  );
}
