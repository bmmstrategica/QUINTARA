'use client';

/**
 * The payments ledger: newest first, a page at a time. The total received is worked out by the API over every payment,
 * so it never depends on how much of the ledger is on screen. The whole ledger exports as CSV for reconciliation.
 */
import { useEffect, useState } from 'react';
import type { StaffPayment, StaffPaymentsPage } from '@quintara/api-client';
import { fmtDate, fmtMoney, useAdmin, useRun } from '@/lib/admin';

const TONE: Record<StaffPayment['status'], string> = { paid: 'ok', refunded: 'gold', pending: '', failed: '' };
const LABEL: Record<StaffPayment['status'], string> = { paid: 'Paid', refunded: 'Refunded', pending: 'Pending', failed: 'Failed' };
const PAGE = 100;

export default function PaymentsPage() {
  const { api } = useAdmin();
  const [show, setShow] = useState<'all' | StaffPayment['status']>('all');
  const [page, setPage] = useState<StaffPaymentsPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const more = useRun();

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
              <thead><tr><th>When</th><th>From</th><th>For</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>{page.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.createdAt)}</td>
                  <td>{p.payer}</td>
                  <td>{p.description}<small>{p.purpose[0]?.toUpperCase() + p.purpose.slice(1)}, via {p.provider}</small></td>
                  <td>{fmtMoney(p.amountMinor, p.currency)}{p.refundedMinor ? <small>{fmtMoney(p.refundedMinor, p.currency)} returned</small> : null}</td>
                  <td><span className={`chip ${TONE[p.status]}`}>{LABEL[p.status]}</span>{p.failureReason ? <small>{p.failureReason}</small> : null}</td>
                </tr>
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
