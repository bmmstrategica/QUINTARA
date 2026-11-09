'use client';

import type { StaffClosure, StaffMember, StaffReport } from '@quintara/api-client';
import { REPORT_REASON_LABELS } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useCan, useLoad, useRun } from '@/lib/admin';

export default function MembersPage() {
  const state = useLoad((api) => api.listMembers());
  return (
    <>
      <div><h1>Members</h1><p className="lede">Suspending a member ends their sessions at once. Investor access is granted here, after verification, never by applying.</p></div>
      <Loaded state={state}>
        {(members) => (
          <div className="scroll"><table>
            <thead><tr><th>Member</th><th>Tier</th><th>Founder</th><th>Investor</th><th>Creative</th><th>Executive</th><th>Standing</th><th></th></tr></thead>
            <tbody>{members.map((m) => <MemberRow key={m.id} member={m} onChanged={state.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <Reports onChanged={state.reload} />
      <Closures onChanged={state.reload} />
    </>
  );
}

function MemberRow({ member: m, onChanged }: { member: StaffMember; onChanged: () => void }) {
  const { api } = useAdmin();
  const canReset = useCan('admin.staff.manage');
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{m.fullName}<small>{m.memberNumber}. {m.email}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{m.tierName}</td>
      {(['founder', 'investor', 'creative', 'executive'] as const).map((role) => (
        <td key={role}><input type="checkbox" aria-label={`${role} role for ${m.fullName}`} checked={m.roles.includes(role)} disabled={pending} onChange={(event) => run(() => api.setMemberRole(m.id, role, event.target.checked), onChanged)} /></td>
      ))}
      <td><span className={`chip ${m.status === 'active' ? 'ok' : ''}`}>{m.status === 'active' ? 'Active' : m.status === 'resigned' ? 'Closed' : 'Suspended'}</span></td>
      <td className="row">{m.status === 'resigned' ? null : <button className="btn ghost" disabled={pending} onClick={() => run(() => api.setMemberStatus(m.id, m.status === 'active' ? 'suspended' : 'active'), onChanged)}>{m.status === 'active' ? 'Suspend' : 'Reinstate'}</button>}
        {m.status === 'resigned' || !canReset ? null : <button className="btn ghost" disabled={pending} title="For a member who has lost their phone and their recovery codes" onClick={() => {
          const reason = window.prompt(`Reset two-factor for ${m.fullName}? Do this only once you have confirmed who is asking. How was the member identified?`);
          if (reason && reason.trim().length >= 5) void run(() => api.resetTwoFactor(m.userId, reason.trim()), onChanged);
        }}>Reset two-factor</button>}</td>
    </tr>
  );
}

/** Concerns members have raised about one another. Staff only; the reported member never sees these. */
function Reports({ onChanged }: { onChanged: () => void }) {
  const state = useLoad((api) => api.listReports());
  return (
    <>
      <div><h2>Reports from members</h2><p className="lede">Visible to staff only. Suspending closes the report and ends the member's sessions at once.</p></div>
      <Loaded state={state}>
        {(reports) => reports.length === 0 ? <p className="muted">No reports.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>About</th><th>Concern</th><th>Reported by</th><th>Received</th><th>Outcome</th></tr></thead>
            <tbody>{reports.map((r) => <ReportRow key={r.id} report={r} onChanged={() => { state.reload(); onChanged(); }} />)}</tbody>
          </table></div>
        )}
      </Loaded>
    </>
  );
}

function ReportRow({ report: r, onChanged }: { report: StaffReport; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{r.reported.fullName}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{REPORT_REASON_LABELS[r.reason]}<small>{r.detail || 'No detail given.'}</small></td>
      <td>{r.reporter.fullName}</td>
      <td>{fmtDate(r.createdAt)}</td>
      <td>{r.status === 'open' ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" disabled={pending} onClick={() => run(() => api.resolveReport(r.id, 'dismissed'), onChanged)}>Dismiss</button>
          <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Suspend ${r.reported.fullName}?`)) void run(() => api.resolveReport(r.id, 'suspended'), onChanged); }}>Suspend member</button>
        </span>
      ) : <span className="chip">{r.status === 'suspended' ? 'Member suspended' : 'Dismissed'}</span>}</td>
    </tr>
  );
}

/** Accounts their owners have closed. Personal data is erased when the date passes, or now if the member asks. */
function Closures({ onChanged }: { onChanged: () => void }) {
  const state = useLoad((api) => api.listClosures());
  return (
    <>
      <div><h2>Closed accounts</h2><p className="lede">Closed by the member. Personal data is erased automatically on the date shown; payment records are kept as the law requires.</p></div>
      <Loaded state={state}>
        {(closures) => closures.length === 0 ? <p className="muted">No closed accounts.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Member</th><th>Closed</th><th>Erasure</th><th></th></tr></thead>
            <tbody>{closures.map((c) => <ClosureRow key={c.userId} closure={c} onChanged={() => { state.reload(); onChanged(); }} />)}</tbody>
          </table></div>
        )}
      </Loaded>
    </>
  );
}

function ClosureRow({ closure: c, onChanged }: { closure: StaffClosure; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{c.fullName}<small>{c.memberNumber}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{fmtDate(c.requestedAt)}</td>
      <td>{c.erasedAt ? <span className="chip">Erased {fmtDate(c.erasedAt)}</span> : <span className="chip gold">Due {fmtDate(c.eraseAfter)}</span>}</td>
      <td className="row">{c.erasedAt ? null : (
        <>
          <button className="btn ghost" disabled={pending} onClick={() => run(() => api.reinstateClosedAccount(c.userId), onChanged)}>Reinstate</button>
          <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Erase ${c.fullName}'s personal data now? This cannot be undone.`)) void run(() => api.eraseClosedAccount(c.userId), onChanged); }}>Erase now</button>
        </>
      )}</td>
    </tr>
  );
}
