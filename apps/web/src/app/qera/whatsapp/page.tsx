'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import type { WhatsAppLink } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

/** QÉRA on WhatsApp: link a number by sending a one-time code from it, and unlink it at any time. */
export default function WhatsAppPage() {
  const state = useResource((api) => api.getWhatsApp());
  const [started, setStarted] = useState<WhatsAppLink | null>(null);
  // While a code is waiting to be sent, check every few seconds whether it has arrived.
  useEffect(() => {
    if (!started || started.status === 'linked') return;
    const timer = setInterval(() => { state.reload(); }, 4000);
    return () => clearInterval(timer);
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state.data?.status === 'linked' && started?.status === 'pending') setStarted(null); }, [state.data, started]);
  return (
    <>
      <p><Link className="muted" href="/qera">Back to QÉRA</Link></p>
      <div className="head"><div>
        <p className="eyebrow">QÉRA on WhatsApp</p>
        <h2>Talk to QÉRA on WhatsApp</h2>
        <p className="lede">Write to QÉRA from WhatsApp as you would here: ask, plan and book. It is the same conversation, with the same care: QÉRA asks before it does anything, and acts only when you tap Confirm.</p>
      </div></div>
      <ResourceView resource={state}>
        {(current) => !current.available
          ? <p className="notice">QÉRA on WhatsApp is not available yet. It will appear here as soon as it is.</p>
          : current.status === 'linked' && !started
            ? <Linked link={current} onChanged={() => { setStarted(null); state.reload(); }} onRelink={setStarted} />
            : started ? <Waiting link={started} onRestart={setStarted} /> : <Start onStarted={setStarted} />}
      </ResourceView>
      <div className="stack" style={{ marginTop: '2.5rem', maxWidth: '44rem' }}>
        <h3>How it works, and how your number is kept</h3>
        <ul className="plain-list">
          <li>Only a number that has sent its code is linked. Quintara never writes to a number first.</li>
          <li>QÉRA on WhatsApp has exactly what you have in the app: the same experiences, services and permissions, and nothing more.</li>
          <li>When QÉRA suggests a booking or a request, nothing happens until you tap Confirm or reply YES from the linked number.</li>
          <li>Your number is stored encrypted. Only its last four digits are shown, here and in your data download.</li>
          <li>Messages travel through WhatsApp, which is run by Meta. The conversation is kept with your QÉRA conversation, where you can clear it.</li>
          <li>Reply STOP on WhatsApp, or unlink here, and QÉRA stops answering that number at once.</li>
        </ul>
      </div>
    </>
  );
}

function Start({ onStarted }: { onStarted: (link: WhatsAppLink) => void }) {
  const [consent, setConsent] = useState(false);
  const start = useAction((api) => api.linkWhatsApp({ consent: consent as true }));
  return (
    <form className="stack" style={{ maxWidth: '36rem' }} onSubmit={async (event) => { event.preventDefault(); const link = await start.run(); if (link) onStarted(link); }} noValidate>
      <label className="check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> I agree to talk to QÉRA on WhatsApp, and that my messages travel through WhatsApp, which is run by Meta.</label>
      {start.error?.fields?.consent ? <span className="field-error" role="alert">Please agree to continue.</span> : null}
      <ActionError error={start.error?.code === 'validation' ? null : start.error} />
      <div><button className="btn" disabled={start.pending}>{start.pending ? 'One moment' : 'Link my WhatsApp'}</button></div>
    </form>
  );
}

function Waiting({ link, onRestart }: { link: WhatsAppLink; onRestart: (link: WhatsAppLink) => void }) {
  const again = useAction((api) => api.linkWhatsApp({ consent: true }));
  const minutes = link.codeExpiresAt ? Math.max(1, Math.round((new Date(link.codeExpiresAt).getTime() - Date.now()) / 60000)) : 15;
  return (
    <div className="panel wa-link" style={{ maxWidth: '36rem' }}>
      <h3 style={{ marginTop: 0 }}>Send this from your WhatsApp</h3>
      <p className="wa-code" aria-label={`Your code is ${link.code?.split('').join(' ')}`}>{link.message}</p>
      <p className="muted" style={{ margin: 0 }}>To Quintara on {link.businessNumber}. The code works once, for the next {minutes} minutes. This page updates when it arrives.</p>
      <div className="row" style={{ marginTop: '1rem' }}>
        {link.openUrl ? <a className="btn" href={link.openUrl} target="_blank" rel="noopener noreferrer">Open WhatsApp</a> : null}
        <button className="btn quiet" disabled={again.pending} onClick={async () => { const next = await again.run(); if (next) onRestart(next); }}>New code</button>
      </div>
      <ActionError error={again.error} />
    </div>
  );
}

function Linked({ link, onChanged, onRelink }: { link: WhatsAppLink; onChanged: () => void; onRelink: (link: WhatsAppLink) => void }) {
  const unlink = useAction(async (api) => { await api.unlinkWhatsApp(); return true; });
  const change = useAction((api) => api.linkWhatsApp({ consent: true }));
  return (
    <div className="panel" style={{ maxWidth: '36rem' }}>
      <span className="tag positive">Linked</span>
      <h3 style={{ marginTop: '0.6rem' }}>QÉRA is on your WhatsApp</h3>
      <p style={{ margin: 0 }}>Your number ending {link.numberMasked?.slice(-4)}{link.linkedAt ? `, linked ${new Date(link.linkedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}. Write to Quintara on {link.businessNumber}.</p>
      <div className="row" style={{ marginTop: '1rem' }}>
        {link.businessNumber ? <a className="btn" href={`https://wa.me/${link.businessNumber.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer">Open WhatsApp</a> : null}
        <button className="btn quiet" disabled={change.pending} onClick={async () => { const next = await change.run(); if (next) onRelink(next); }}>Use another number</button>
        <button className="btn quiet" disabled={unlink.pending} onClick={async () => { if (window.confirm('Unlink your WhatsApp? QÉRA stops answering that number at once.') && await unlink.run()) onChanged(); }}>Unlink</button>
      </div>
      <ActionError error={unlink.error ?? change.error} />
    </div>
  );
}
