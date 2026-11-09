'use client';

import { useState } from 'react';
import type { BillingPeriod, StaffTierDetail } from '@quintara/api-client';
import { planName, RESIDENCIES, RESIDENCY_LABEL, termLabel } from '@quintara/domain';
import type { Residency } from '@quintara/domain';
import { fmtMoney, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const PERIOD: Record<BillingPeriod, string> = { year: 'Per year', month: 'Per month', once: 'Once', none: 'No fee' };

export default function TiersPage() {
  const state = useLoad((api) => api.listAllTiers());
  return (
    <>
      <div><h1>Membership tiers</h1><p className="lede">Plans with a residency and a term are the memberships applicants choose on the application. A new price applies to applications approved from now on. Fees already paid do not change.</p></div>
      <Loaded state={state}>
        {(tiers) => (
          <>
            <div className="scroll"><table>
              <thead><tr><th>Tier</th><th>On the application</th><th>Members</th><th>Fee</th><th>Billed</th><th>Offered</th><th></th></tr></thead>
              <tbody>{tiers.map((t) => <TierRow key={t.id} tier={t} onChanged={state.reload} />)}</tbody>
            </table></div>
            <NewTier currency={tiers[0]?.currency ?? 'ZAR'} onCreated={state.reload} />
          </>
        )}
      </Loaded>
    </>
  );
}

function TierRow({ tier: t, onChanged }: { tier: StaffTierDetail; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [price, setPrice] = useState(t.priceMinor / 100);
  const [period, setPeriod] = useState(t.billingPeriod as BillingPeriod);
  const changed = Math.round(price * 100) !== t.priceMinor || period !== t.billingPeriod;
  const save = () => {
    const next = Math.round(price * 100);
    if (!Number.isFinite(next) || next < 0) return;
    if (next !== t.priceMinor && !window.confirm(`Change the ${t.name} fee from ${fmtMoney(t.priceMinor, t.currency)} to ${fmtMoney(next, t.currency)}?`)) return;
    void run(() => api.updateTier(t.id, { priceMinor: next, billingPeriod: period }), onChanged);
  };
  return (
    <tr>
      <td>{t.name}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{t.residency && t.termMonths ? `${RESIDENCY_LABEL[t.residency as Residency]}, ${termLabel(t.termMonths)}` : <span className="muted">No</span>}</td>
      <td>{t.members}</td>
      <td><label className="check">{t.currency}<input type="number" min={0} step={100} aria-label={`Fee for ${t.name}`} value={price} onChange={(event) => setPrice(Number(event.target.value))} style={{ width: 120 }} /></label></td>
      <td><select aria-label={`Billing for ${t.name}`} value={period} onChange={(event) => setPeriod(event.target.value as BillingPeriod)}>{(Object.keys(PERIOD) as BillingPeriod[]).map((k) => <option key={k} value={k}>{PERIOD[k]}</option>)}</select></td>
      <td><span className={`chip ${t.isActive ? 'ok' : ''}`}>{t.isActive ? 'Offered' : 'Retired'}</span></td>
      <td className="row">
        <button className="btn" disabled={pending || !changed} onClick={save}>Save</button>
        <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateTier(t.id, { isActive: !t.isActive }), onChanged)}>{t.isActive ? 'Retire' : 'Offer again'}</button>
      </td>
    </tr>
  );
}

function NewTier({ currency, onCreated }: { currency: string; onCreated: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [name, setName] = useState('');
  const [price, setPrice] = useState(0);
  const [period, setPeriod] = useState<BillingPeriod>('year');
  // A plan for the application: a residency and a term, paid once. Its name follows from them unless staff write one.
  const [residency, setResidency] = useState<Residency | ''>('');
  const [months, setMonths] = useState(12);
  const plan = residency !== '';
  const shownName = plan && !name.trim() ? planName(residency, months) : name;
  return (
    <form className="panel" onSubmit={(event) => { event.preventDefault(); void run(() => api.createTier({ name: shownName, priceMinor: Math.round(price * 100), currency, billingPeriod: plan ? 'once' : period, residency: plan ? residency : null, termMonths: plan ? months : null }), () => { setName(''); setPrice(0); setResidency(''); onCreated(); }); }}>
      <h2 style={{ marginTop: 0 }}>Add a tier or plan</h2>
      <div className="row">
        <label className="check">On the application<select value={residency} onChange={(event) => setResidency(event.target.value as Residency | '')}><option value="">No</option>{RESIDENCIES.map((r) => <option key={r} value={r}>{RESIDENCY_LABEL[r]}</option>)}</select></label>
        {plan ? <label className="check">Term in months<input type="number" min={1} max={60} value={months} onChange={(event) => setMonths(Number(event.target.value))} style={{ width: 80 }} /></label> : null}
        <label className="check">Name<input value={name} placeholder={plan ? planName(residency, months) : ''} onChange={(event) => setName(event.target.value)} maxLength={60} /></label>
        <label className="check">Fee ({currency})<input type="number" min={0} step={100} value={price} onChange={(event) => setPrice(Number(event.target.value))} style={{ width: 120 }} /></label>
        {plan ? null : <label className="check">Billed<select value={period} onChange={(event) => setPeriod(event.target.value as BillingPeriod)}>{(Object.keys(PERIOD) as BillingPeriod[]).map((k) => <option key={k} value={k}>{PERIOD[k]}</option>)}</select></label>}
        <button className="btn" disabled={pending || shownName.trim().length < 2}>Add</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}
