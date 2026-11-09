'use client';

import { useState } from 'react';
import type { StaffPayment } from '@quintara/api-client';
import { fmtDate, fmtMoney, Loaded, useLoad } from '@/lib/admin';

const TONE: Record<StaffPayment['status'], string> = { paid: 'ok', refunded: 'gold', pending: '', failed: '' };
const LABEL: Record<StaffPayment['status'], string> = { paid: 'Paid', refunded: 'Refunded', pending: 'Pending', failed: 'Failed' };

export default function PaymentsPage() {
  const state = useLoad((api) => api.listPayments());
  const [show, setShow] = useState<'all' | StaffPayment['status']>('all');
  return (
    <>
      <div><h1>Payments</h1><p className="lede">A record of what was charged and returned. Card details are held by the payment provider and never reach Quintara.</p></div>
      <Loaded state={state}>
        {(payments) => {
          const totals = new Map<string, number>();
          for (const p of payments) if (p.status === 'paid' || p.status === 'refunded') totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.amountMinor - p.refundedMinor);
          const list = payments.filter((p) => show === 'all' || p.status === show);
          return (
            <>
              <div className="row">
                {[...totals].map(([currency, minor]) => <span className="chip ok" key={currency}>Received, less refunds: {minor ? fmtMoney(minor, currency) : `${currency} 0`}</span>)}
                <label className="check">Show<select value={show} onChange={(event) => setShow(event.target.value as typeof show)}><option value="all">Everything</option>{(Object.keys(LABEL) as StaffPayment['status'][]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select></label>
              </div>
              {list.length === 0 ? <p className="note">No payments to show.</p> : (
                <div className="scroll"><table>
                  <thead><tr><th>When</th><th>From</th><th>For</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>{list.map((p) => (
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
            </>
          );
        }}
      </Loaded>
    </>
  );
}
