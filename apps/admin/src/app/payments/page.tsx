'use client';

/**
 * The payments ledger: newest first, a page at a time. The total received is worked out by the API over every payment,
 * so it never depends on how much of the ledger is on screen. The whole ledger exports as CSV for reconciliation.
 * Finance refund a received payment from here, in full or in part, with a reason the audit log keeps.
 */
import { Fragment, useEffect, useState } from 'react';
import type { StaffPayment, StaffPaymentsPage } from '@quintara/api-client';
import { fmtAmount, fmtDate, fmtMoney, useAdmin, useCan, useRun } from '@/lib/admin';

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
  const onRefunded = (id: string, amountMinor: number, status: StaffPayment['status']) => {
    setRefunding(null);
    setPage((current) => current && { ...current, payments: current.payments.map((p) => (p.id === id ? { ...p, refundedMinor: p.refundedMinor + amountMinor, status } : p)),
      totals: current.totals.map((t) => (t.currency === current.payments.find((p) => p.id === id)?.currency ? { ...t, receivedMinor: t.receivedMinor - amountMinor, refundedMinor: t.refundedMinor + amountMinor } : t)) });
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

  const currency = page?.totals[0]?.currency ?? 'ZAR';
  const received = (page?.totals ?? []).reduce((n, t) => n + t.receivedMinor + t.refundedMinor, 0);
  const refunded = (page?.totals ?? []).reduce((n, t) => n + t.refundedMinor, 0);
  return (
    <>
      <div><h1>Payments</h1><p className="lede">Every membership fee, experience and boutique payment. Card details stay with the payment provider.</p></div>
      {problem ? <p className="error" role="alert">{problem}</p> : !page ? <p className="muted" role="status">Loading</p> : (
        <>
          {/* As the design: what came in, what went back, and how many payments. Totals cover every payment, not only those shown. */}
          <div className="stats">
            <div className="panel stat"><b>{fmtAmount(received, currency)}</b><span className="muted">Received</span></div>
            <div className="panel stat"><b>{fmtAmount(refunded, currency)}</b><span className="muted">Refunded</span></div>
            <div className="panel stat"><b>{page.count}</b><span className="muted">Transactions</span></div>
          </div>
          <div className="row">
            <label className="check">Show<select value={show} onChange={(event) => setShow(event.target.value as typeof show)}><option value="all">Everything</option>{(Object.keys(LABEL) as StaffPayment['status'][]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select></label>
            <a className="btn ghost" href={api.paymentsExportUrl()}>Export the ledger as CSV</a>
          </div>
          {page.payments.length === 0 ? <p className="note">No payments to show.</p> : (
            <div className="list" role="list" aria-label="Payments">{page.payments.map((p) => (
              <Fragment key={p.id}>
                <div className="list-row" role="listitem">
                  <span className="lead" aria-hidden="true"><CardIcon /></span>
                  <span className="txt">
                    <b>{p.description}</b>
                    <span>{p.payer}. {fmtDate(p.createdAt)}{p.refundedMinor ? `. ${fmtMoney(p.refundedMinor, p.currency)} returned` : ''}{p.failureReason ? `. ${p.failureReason}` : ''}</span>
                  </span>
                  <span className="trail">
                    <span>{fmtMoney(p.amountMinor, p.currency)}</span>
                    <span className={`chip ${TONE[p.status]}`}>{LABEL[p.status]}</span>
                    {canRefund && p.status === 'paid' && p.amountMinor > p.refundedMinor ? <button className="btn ghost small" aria-expanded={refunding === p.id} aria-label={`Refund ${p.description}`} onClick={() => setRefunding(refunding === p.id ? null : p.id)}>Refund</button> : null}
                  </span>
                </div>
                {refunding === p.id ? <RefundRow payment={p} onDone={onRefunded} /> : null}
              </Fragment>
            ))}</div>
          )}
          <p className="muted">Showing {page.payments.length} of {page.count}.</p>
          {more.error ? <p className="error" role="alert">{more.error}</p> : null}
          {page.nextOffset !== null ? <div><button className="btn ghost" disabled={more.pending} onClick={loadMore}>{more.pending ? 'Loading' : 'Show more'}</button></div> : null}
        </>
      )}
    </>
  );
}

/** The card mark from the design's icon set. */
function CardIcon() {
  return <svg className="ic" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12.5" rx="1.8" /><path d="M3 10.5h18M6.5 15h4" /></svg>;
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
    <div className="refund-form">
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
    </div>
  );
}
