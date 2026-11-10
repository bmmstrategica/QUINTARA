'use client';

/**
 * The payments ledger: newest first, a page at a time. The total received is worked out by the API over every payment,
 * so it never depends on how much of the ledger is on screen. The whole ledger exports as CSV for reconciliation.
 * Finance refund a received payment from here, in full or in part, with a reason the audit log keeps.
 */
import { Fragment, useEffect, useState } from 'react';
import type { StaffPayment, StaffPaymentsPage } from '@quintara/api-client';
import { fmtDate, fmtMoney, useAdmin, useCan, useRun } from '@/lib/admin';

const TONE: Record<StaffPayment['status'], string> = { paid: 'ok', refunded: 'gold', pending: '', failed: '' };
const LABEL: Record<StaffPayment['status'], string> = { paid: 'Paid', refunded: 'Refunded', pending: 'Pending', failed: 'Failed' };
const PAGE = 100;

export default function PaymentsPage() {
  const { api } = useAdmin();
  const [show, setShow] = useState<'all' | StaffPayment['status']>('all');
  const [page, setPage] = useState<StaffPaymentsPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const more = useRun();
  const canRefund = useCan('admin.finance.manage');
  const [refunding, setRefunding] = useState<string | null>(null);
  // A refund changes one row: it is updated in place, so the pages already loaded stay as they are.
  const refunded = (id: string, amountMinor: number, status: StaffPayment['status']) => {
    setRefunding(null);
    setPage((current) => current && { ...current, payments: current.payments.map((p) => (p.id === id ? { ...p, refundedMinor: p.refundedMinor + amountMinor, status } : p)),
      totals: current.totals.map((t) => (t.currency === current.payments.find((p) => p.id === id)?.currency ? { ...t, receivedMinor: t.receivedMinor - amountMinor } : t)) });
  };

  useEffect(() => {
    let stale = false;
    setPage(null); setProblem(null);
    api.listPayments({ status: show === 'all' ? undefined : show, limit: PAGE }).then(
      (first) => { if (!stale) setPage(first); },
      (error: unknown) => { if (!stale) setProblem(error instanceof Error ? error.message : 'The ledger could not be loaded.'); },
    );
    return () => { stale = true; };
  }, [api, show]);

  const loadMore = () => page?.nextOffset !== null && page && void more.run(async () => {
    const next = await api.listPayments({ status: show === 'all' ? undefined : show, offset: page.nextOffset!, limit: PAGE });
    setPage({ ...next, payments: [...page.payments, ...next.payments] });
  });

  return (
    <>
      <div><h1>Payments</h1><p className="lede">A record of what was charged and returned. Card details are held by the payment provider and never reach Quintara.</p></div>
      {problem ? <p className="error" role="alert">{problem}</p> : !page ? <p className="muted" role="status">Loading</p> : (
        <>
          <div className="row">
            {page.totals.length ? page.totals.map((t) => <span className="chip ok" key={t.currency}>Received, less refunds: {t.receivedMinor ? fmtMoney(t.receivedMinor, t.currency) : `${t.currency} 0`}</span>) : <span className="chip">Nothing received yet</span>}
            <label className="check">Show<select value={show} onChange={(event) => setShow(event.target.value as typeof show)}><option value="all">Everything</option>{(Object.keys(LABEL) as StaffPayment['status'][]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select></label>
            <a className="btn ghost" href={api.paymentsExportUrl()}>Export the ledger as CSV</a>
          </div>
          {page.payments.length === 0 ? <p className="note">No payments to show.</p> : (
            <div className="scroll"><table>
              <thead><tr><th>When</th><th>From</th><th>For</th><th>Amount</th><th>Status</th>{canRefund ? <th></th> : null}</tr></thead>
              <tbody>{page.payments.map((p) => (
                <Fragment key={p.id}>
                <tr>
                  <td>{fmtDate(p.createdAt)}</td>
                  <td>{p.payer}</td>
                  <td>{p.description}<small>{p.purpose[0]?.toUpperCase() + p.purpose.slice(1)}, via {p.provider}</small></td>
                  <td>{fmtMoney(p.amountMinor, p.currency)}{p.refundedMinor ? <small>{fmtMoney(p.refundedMinor, p.currency)} returned</small> : null}</td>
                  <td><span className={`chip ${TONE[p.status]}`}>{LABEL[p.status]}</span>{p.failureReason ? <small>{p.failureReason}</small> : null}</td>
                  {canRefund ? <td>{p.status === 'paid' && p.amountMinor > p.refundedMinor ? <button className="btn ghost" aria-expanded={refunding === p.id} onClick={() => setRefunding(refunding === p.id ? null : p.id)}>Refund</button> : null}</td> : null}
                </tr>
                {refunding === p.id ? <RefundRow payment={p} onDone={refunded} /> : null}
                </Fragment>
              ))}</tbody>
            </table></div>
          )}
          <p className="muted">Showing {page.payments.length} of {page.count}.</p>
          {more.error ? <p className="error" role="alert">{more.error}</p> : null}
          {page.nextOffset !== null ? <div><button className="btn ghost" disabled={more.pending} onClick={loadMore}>{more.pending ? 'Loading' : 'Show more'}</button></div> : null}
        </>
      )}
    </>
  );
}

/** Refunding one payment: all that is left of it, or part, and why. The payer is told; nothing is cancelled. */
function RefundRow({ payment: p, onDone }: { payment: StaffPayment; onDone: (id: string, amountMinor: number, status: StaffPayment['status']) => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const left = p.amountMinor - p.refundedMinor;
  const [whole, setWhole] = useState(true);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const amountMinor = whole ? left : Math.round(Number(amount) * 100);
  const valid = reason.trim().length >= 3 && amountMinor > 0 && amountMinor <= left;
  const submit = () => {
    if (!window.confirm(`Refund ${fmtMoney(amountMinor, p.currency)} to ${p.payer}? It goes back to the card they paid with, and they are told. It cannot be undone.`)) return;
    void run(async () => {
      const r = await api.refundPayment(p.id, { reason: reason.trim(), amountMinor: whole ? undefined : amountMinor });
      onDone(p.id, r.refundedMinor, r.status);
    });
  };
  return (
    <tr><td colSpan={6}>
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>{fmtMoney(left, p.currency)} of this payment can be refunded. A refund returns money only: it does not cancel the booking, order or membership it paid for.</p>
        <div className="row">
          <label>Refund<select value={whole ? 'whole' : 'part'} onChange={(event) => setWhole(event.target.value === 'whole')}><option value="whole">All of it</option><option value="part">Part of it</option></select></label>
          {!whole ? <label>Amount, in {p.currency}<input type="number" min={1} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></label> : null}
        </div>
        <label>Reason, kept in the audit log<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} placeholder="Goodwill after the venue changed." /></label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row"><button className="btn" disabled={pending || !valid} onClick={submit}>{pending ? 'Refunding' : `Refund ${amountMinor > 0 && amountMinor <= left ? fmtMoney(amountMinor, p.currency) : ''}`.trim()}</button></div>
      </div>
    </td></tr>
  );
}
