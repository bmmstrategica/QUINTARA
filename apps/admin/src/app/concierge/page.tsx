'use client';

import Link from 'next/link';
import { CONCIERGE_CATEGORY_LABEL, CONCIERGE_STATUS_LABEL } from '@quintara/domain';
import { fmtDate, Loaded, useLoad } from '@/lib/admin';

export default function ConciergeQueuePage() {
  const state = useLoad((api) => api.listConciergeRequests());
  return (
    <>
      <div><h1>Concierge desk</h1><p className="lede">Open requests first, oldest at the top.</p></div>
      <Loaded state={state}>
        {(requests) => requests.length === 0 ? <p className="note">No requests yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Member</th><th>Request</th><th>Received</th><th>Status</th><th></th></tr></thead>
            <tbody>{requests.map((r) => {
              const waiting = r.messages.at(-1)?.from === 'member' || r.status === 'requested';
              return (
                <tr key={r.id}>
                  <td>{r.memberName}<small>{r.memberNumber}</small></td>
                  <td>{r.subject}<small>{CONCIERGE_CATEGORY_LABEL[r.category]}{r.neededBy ? `. Needed by ${r.neededBy}` : ''}</small></td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td><span className={`chip ${['completed', 'confirmed'].includes(r.status) ? 'ok' : r.status === 'cancelled' ? '' : 'gold'}`}>{CONCIERGE_STATUS_LABEL[r.status]}</span>{waiting && !['completed', 'cancelled'].includes(r.status) ? <small>Waiting for the desk</small> : null}</td>
                  <td><Link className="btn ghost" href={`/concierge/${r.id}`}>Open</Link></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Loaded>
    </>
  );
}
