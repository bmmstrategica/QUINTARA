'use client';

/**
 * Renewals in the city being viewed: memberships ending in the next 60 days, those whose renewal has been declined
 * or is overdue, and those that lapsed in the last 90 days. Staff can try the member's saved card again, or extend a
 * term with a reason (kept in the audit log). Card details are never shown here.
 */
import { useState } from 'react';
import type { StaffRenewal } from '@quintara/api-client';
import { fmtDate, fmtMoney, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : 'No end');

export default function RenewalsPage() {
  const state = useLoad((api) => api.listRenewals());
  return (
    <>
      <div><h1>Renewals</h1><p className="lede">Memberships ending soon, renewals that need attention, and recent lapses. Members are reminded 30 and 7 days before; a declined card is tried again after 1, 3 and 7 days; access continues for 14 days after the end of a term.</p></div>
      <Loaded state={state}>
        {(list) => (
          <>
            <h2>Need attention</h2>
            <Table rows={list.failing} empty="Nothing needs attention." onChanged={state.reload} />
            <h2>Ending in the next 60 days</h2>
            <Table rows={list.upcoming} empty="No memberships end in the next 60 days." onChanged={state.reload} />
            <h2>Lapsed in the last 90 days</h2>
            <Table rows={list.lapsed} empty="No memberships have lapsed recently." onChanged={state.reload} />
          </>
        )}
      </Loaded>
    </>
  );
}

function Table({ rows, empty, onChanged }: { rows: StaffRenewal[]; empty: string; onChanged: () => void }) {
  if (!rows.length) return <p className="note">{empty}</p>;
  return (
    <div className="scroll"><table>
      <thead><tr><th>Member</th><th>Plan</th><th>Term ends</th><th>Renewal</th><th>Status</th><th></th></tr></thead>
      <tbody>{rows.map((r) => <Row key={r.memberId} r={r} onChanged={onChanged} />)}</tbody>
    </table></div>
  );
}

function Row({ r, onChanged }: { r: StaffRenewal; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [extending, setExtending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const due = r.termEndsAt !== null && new Date(r.termEndsAt) <= new Date();
  return (
    <>
      <tr>
        <td>{r.memberName}<small>{r.memberNumber}</small>{error ? <small className="error" role="alert">{error}</small> : null}{result ? <small role="status">{result}</small> : null}</td>
        <td>{r.tierName}<small>{fmtMoney(r.amountMinor, r.currency)}</small></td>
        <td>{day(r.termEndsAt)}{r.lapsedAt ? <small>Lapsed {fmtDate(r.lapsedAt)}</small> : null}</td>
        <td>{r.autoRenew ? 'Automatic' : 'By the member'}<small>{r.cardOnFile ? (r.cardExpiresBeforeRenewal ? 'Card expires before the renewal date' : 'Card on file') : 'No card on file'}</small></td>
        <td>
          <span className={`chip ${r.status === 'lapsed' || r.attempts ? '' : due ? 'gold' : 'ok'}`}>{r.status === 'lapsed' ? 'Lapsed' : r.attempts ? `Declined ${r.attempts} time${r.attempts === 1 ? '' : 's'}` : due ? 'In grace period' : 'Upcoming'}</span>
          {r.lastFailure ? <small>{r.lastFailure}</small> : null}{r.nextAttemptAt ? <small>Next try {fmtDate(r.nextAttemptAt)}</small> : null}
        </td>
        <td className="row">
          {(due || r.status === 'lapsed') && r.cardOnFile ? <button className="btn ghost" disabled={pending} onClick={() => {
            if (!window.confirm(`Charge ${fmtMoney(r.amountMinor, r.currency)} to ${r.memberName}'s saved card now?`)) return;
            void run(async () => { const x = await api.retryRenewal(r.memberId); setResult(x.paid ? 'Renewed.' : `Declined: ${x.reason ?? ''}`); }, onChanged);
          }}>Try the card now</button> : null}
          <button className="btn ghost" aria-expanded={extending} onClick={() => setExtending(!extending)}>{extending ? 'Close' : 'Extend'}</button>
        </td>
      </tr>
      {extending ? (
        <tr><td colSpan={6}>
          <form className="row" aria-label={`Extend ${r.memberName}'s membership`} onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget), days = Number(f.get('days')), reason = String(f.get('reason') ?? '').trim();
            if (!window.confirm(`Extend ${r.memberName}'s membership by ${days} days without charging? ${r.memberName.split(' ')[0]} will be told.`)) return;
            void run(async () => { const x = await api.extendRenewal(r.memberId, days, reason); setResult(`Extended to ${day(x.termEndsAt)}.`); setExtending(false); }, onChanged);
          }}>
            <label>Days<input name="days" type="number" min={1} max={365} defaultValue={14} required style={{ width: 90 }} /></label>
            <label style={{ flex: 1 }}>Reason (kept in the audit log)<input name="reason" minLength={5} maxLength={300} required placeholder="Waiting for the member's bank" /></label>
            <button className="btn" disabled={pending}>Extend without charging</button>
          </form>
        </td></tr>
      ) : null}
    </>
  );
}
