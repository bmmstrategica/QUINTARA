'use client';

/**
 * Membership on the web: the plan, when it ends, automatic renewal, the saved card and past payments; and, for a
 * member whose membership has lapsed, the page shown in place of the app until they renew.
 *
 * The card is typed into the payment provider's own secure form; only its one-time setup token reaches Quintara.
 * While payments are the stand-in, the test cards are offered instead.
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAction, useResource, useSession } from '@quintara/app-core';
import { formatMoney, RENEWAL_GRACE_DAYS, TEST_CARDS } from '@quintara/domain';
import type { MembershipStatus } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
const STATE: Record<MembershipStatus['state'], [string, string]> = { active: ['Active', 'positive'], renewal_due: ['Renews soon', 'accent'], grace: ['Payment needed', 'critical'], lapsed: ['Ended', 'critical'] };

export function MembershipPanel({ onRenewed }: { onRenewed?: () => void }) {
  const membership = useResource((api) => api.getMembership());
  // Kept here, so the message survives the panel reloading after a change.
  const [done, setDone] = useState<string | null>(null);
  return (
    <section className="panel stack" id="membership" aria-label="Membership">
      <h3>Membership</h3>
      {done ? <p className="notice" role="status">{done}</p> : null}
      <ResourceView resource={membership}>{(m) => <Detail m={m} onChanged={membership.reload} onRenewed={onRenewed} setDone={setDone} />}</ResourceView>
    </section>
  );
}

function Detail({ m, onChanged, onRenewed, setDone }: { m: MembershipStatus; onChanged: () => void; onRenewed?: () => void; setDone: (message: string | null) => void }) {
  const config = useResource((api) => api.getPaymentConfig());
  const [adding, setAdding] = useState(false);
  const save = useAction((api, token: string) => api.saveCard(token));
  const remove = useAction((api) => api.removeCard());
  const auto = useAction((api, on: boolean) => api.setAutoRenew(on));
  const key = useRef(`renew-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const renew = useAction((api) => api.renewMembership(key.current));
  const price = formatMoney(m.priceMinor, m.currency);
  const after = (result: unknown, message: string) => { if (result) { setDone(message); onChanged(); } };
  return (
    <>
      <div className="row"><strong style={{ fontWeight: 500 }}>{m.tierName}</strong><span className={`tag ${STATE[m.state][1]}`}>{STATE[m.state][0]}</span><span className="muted">{m.memberNumber}</span></div>
      <p>
        {m.state === 'lapsed' ? `Your membership ended${m.termEndsAt ? ` on ${day(m.termEndsAt)}` : ''}. Renew to pick up where you left off: your profile, bookings and messages are kept.`
          : m.state === 'grace' ? `Your term ended on ${day(m.termEndsAt!)}. Your membership continues until ${day(m.graceEndsAt!)} while the renewal is completed.`
          : m.termEndsAt ? `${m.autoRenew ? 'Renews' : 'Ends'} on ${day(m.termEndsAt)}. ${price} for ${m.termMonths} month${m.termMonths === 1 ? '' : 's'}.`
          : 'Your membership has no end date.'}
      </p>
      {m.lastFailure && m.state !== 'active' ? <p className="notice" role="alert">The last renewal did not go through: {m.lastFailure}{m.nextAttemptAt ? ` We will try again on ${day(m.nextAttemptAt)}.` : ''}</p> : null}
      <ActionError error={save.error ?? remove.error ?? auto.error ?? renew.error} />
      {m.termMonths ? (
        <label className="check">
          <input type="checkbox" checked={m.autoRenew} disabled={auto.pending} onChange={async (event) => {
            const on = event.target.checked;
            if (on && !m.card) { setAdding(true); return; }
            const ok = window.confirm(on ? `Renew automatically? At the end of each term, ${price} will be charged to your ${m.card!.brand} ending ${m.card!.last4}. You can turn this off at any time before.` : `Turn off automatic renewal? Your membership will end on ${m.termEndsAt ? day(m.termEndsAt) : 'the renewal date'} unless you renew it.`);
            if (ok) after(await auto.run(on), on ? 'Automatic renewal is on.' : 'Automatic renewal is off.');
          }} /> Renew automatically{m.autoRenew && m.termEndsAt ? `: ${price} on ${day(m.termEndsAt)}, with reminders 30 and 7 days before` : ''}
        </label>
      ) : null}
      <h4 style={{ margin: '0.6rem 0 0' }}>Card</h4>
      {m.card ? (
        <>
          <p style={{ margin: 0 }}>{m.card.brand} ending {m.card.last4}, expires {String(m.card.expMonth).padStart(2, '0')}/{String(m.card.expYear).slice(-2)}</p>
          {m.card.expired ? <p className="field-error" role="alert">This card has expired. Add a new one.</p> : m.card.expiresBeforeRenewal ? <p className="muted">This card expires before your renewal date. Add a new one.</p> : null}
          <div className="row">
            <button className="btn quiet small" onClick={() => setAdding(true)}>Replace card</button>
            <button className="btn quiet small" disabled={remove.pending} onClick={async () => { if (window.confirm(`Remove this card? It is deleted here and at the payment provider.${m.autoRenew ? ' Automatic renewal stops.' : ''}`)) after(await remove.run(), 'The card has been removed.'); }}>Remove card</button>
          </div>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>No card saved. Quintara never sees your card number: it is kept by the payment provider.</p>}
      {(adding || !m.card) && config.data ? (
        config.data.testCards ? (
          <div className="stack" style={{ gap: '0.4rem' }}>
            <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>Test cards. The payment provider&rsquo;s secure card form appears here once payments are connected.</p>
            <div className="row">{TEST_CARDS.map((c) => <button key={c.setupToken} className="btn quiet small" disabled={save.pending} onClick={async () => { after(await save.run(c.setupToken), 'Card saved.'); setAdding(false); }}>{c.label}</button>)}</div>
          </div>
        ) : <p className="muted">The secure card form from {config.data.provider} appears here.</p>
      ) : null}
      {m.canRenewNow && m.card ? (
        <div><button className="btn" disabled={renew.pending} onClick={async () => {
          if (!window.confirm(`Renew your membership? ${price} will be charged to your ${m.card!.brand} ending ${m.card!.last4}.${m.state === 'lapsed' ? ' Your new term starts today.' : ' Your new term starts when the current one ends.'}`)) return;
          const r = await renew.run();
          if (r) { setDone(`Renewed until ${day(r.termEndsAt!)}. Thank you.`); onChanged(); onRenewed?.(); }
        }}>{renew.pending ? 'Renewing' : `Renew now for ${price}`}</button></div>
      ) : null}
      {m.history.length ? (
        <details>
          <summary>Payments</summary>
          <ul className="plain-list">{m.history.slice(0, 12).map((p) => <li key={p.id}>{day(p.at)}: {formatMoney(p.amountMinor, p.currency)}, {p.status === 'paid' ? `paid${p.periodEnd ? `, to ${day(p.periodEnd)}` : ''}` : p.status === 'failed' ? `declined${p.reason ? ` (${p.reason.replace(/\.$/, '')})` : ''}` : p.status}</li>)}</ul>
        </details>
      ) : null}
      <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>Membership continues for {RENEWAL_GRACE_DAYS} days after the end of a term while a renewal is completed.</p>
    </>
  );
}

/** A member whose membership has lapsed sees this in place of the app, until they renew or sign out. */
export function LapsedGate({ children }: { children: ReactNode }) {
  const { lapsed, refresh, signOut } = useSession();
  if (!lapsed) return <>{children}</>;
  return (
    <div className="stack" style={{ maxWidth: 680 }}>
      <div><h2>Welcome back</h2><p className="lede">Your membership has ended. Renew it here and everything is as you left it.</p></div>
      <MembershipPanel onRenewed={() => { void refresh(); }} />
      <div><button className="btn quiet" onClick={() => { void signOut(); }}>Sign out</button></div>
    </div>
  );
}
