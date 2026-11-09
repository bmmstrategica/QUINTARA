'use client';

/**
 * Admin console accounts: up to five people. Administrators add them, choose their role, suspend and reactivate
 * them, and reset two-factor for someone who has lost their phone. Every change is in the audit log.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { StaffAccount } from '@quintara/api-client';
import type { StaffRole } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const ROLE: Record<StaffRole, string> = { admin: 'Administrator', concierge: 'Concierge desk' };
const ROLE_NOTE: Record<StaffRole, string> = {
  admin: 'Everything, including members, money, cities, staff accounts and the full audit log.',
  concierge: 'Experiences, guest lists, check-in, concierge requests, services and content. Not members, money or staff.',
};

export default function StaffPage() {
  const staff = useLoad((client) => client.listStaff());
  return (
    <>
      <div>
        <h1>Staff accounts</h1>
        <p className="lede">The people who use the admin console. Each signs in with their own email address and a code from their authenticator app. Nobody shares an account, so the <Link href="/audit">audit log</Link> shows who did what.</p>
      </div>
      <Loaded state={staff}>
        {({ staff: list, seats }) => (
          <>
            <div className="panel" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <div><b style={{ fontWeight: 500 }}>{seats.used} of {seats.total} accounts in use</b><p className="muted" style={{ fontSize: 13.5 }}>{seats.used >= seats.total ? 'All accounts are in use. Suspend one to add someone new.' : `${seats.total - seats.used} more can be added.`}</p></div>
              <div className="seats" aria-hidden="true">{Array.from({ length: seats.total }, (_, i) => <i key={i} className={i < seats.used ? 'on' : ''} />)}</div>
            </div>
            <div className="scroll"><table>
              <thead><tr><th>Name</th><th>Role</th><th>Two-factor</th><th>Last signed in</th><th>Status</th><th></th></tr></thead>
              <tbody>{list.map((s) => <StaffRow key={s.userId} account={s} onChanged={staff.reload} />)}</tbody>
            </table></div>
            <AddStaff full={seats.used >= seats.total} onAdded={staff.reload} />
          </>
        )}
      </Loaded>
    </>
  );
}

function StaffRow({ account: s, onChanged }: { account: StaffAccount; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [reason, setReason] = useState('');
  const change = (input: Parameters<typeof api.updateStaff>[1], question: string) => { if (window.confirm(question)) void run(() => api.updateStaff(s.userId, input), onChanged); };
  return (
    <>
      <tr>
        <td>{s.fullName}{s.you ? <span className="chip" style={{ marginLeft: 8 }}>You</span> : null}<small>{s.email}</small><small>{s.title}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
        <td>
          <select className="small" aria-label={`Role of ${s.fullName}`} value={s.role} disabled={pending || s.you || s.status !== 'active'}
            onChange={(event) => change({ role: event.target.value as StaffRole }, `Make ${s.fullName} ${event.target.value === 'admin' ? 'an administrator' : 'part of the concierge desk'}? ${ROLE_NOTE[event.target.value as StaffRole]} They are signed out of the console and sign in again with the new role.`)}>
            {(Object.keys(ROLE) as StaffRole[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
          </select>
        </td>
        <td><span className={`chip ${s.twoFactor ? 'ok' : 'gold'}`}>{s.twoFactor ? 'On' : 'At first sign-in'}</span></td>
        <td>{s.lastSignInAt ? fmtDate(s.lastSignInAt) : <span className="muted">Not yet</span>}{s.lastActiveAt ? <small>Last active {fmtDate(s.lastActiveAt)}</small> : null}</td>
        <td><span className={`chip ${s.status === 'active' ? 'ok' : ''}`}>{s.status === 'active' ? 'Active' : 'Suspended'}</span></td>
        <td className="row">
          <Link className="btn ghost" href={`/audit?staff=${s.userId}`}>Activity</Link>
          {!s.you ? <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Manage'}</button> : null}
        </td>
      </tr>
      {open ? (
        <tr><td colSpan={6}>
          <div className="form" style={{ alignItems: 'end' }}>
            <label>Title<input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></label>
            <div><button className="btn ghost" disabled={pending || title.trim() === s.title} onClick={() => run(() => api.updateStaff(s.userId, { title: title.trim() }), onChanged)}>Save title</button></div>
            <div>
              {s.status === 'active'
                ? <button className="btn ghost" disabled={pending} onClick={() => change({ status: 'suspended' }, `Suspend ${s.fullName}? They are signed out of the admin console at once and cannot sign in until reactivated. Their seat is freed.`)}>Suspend</button>
                : <button className="btn ghost" disabled={pending} onClick={() => change({ status: 'active' }, `Reactivate ${s.fullName}? They can sign in to the admin console again.`)}>Reactivate</button>}
            </div>
          </div>
          <form className="form" style={{ alignItems: 'end', marginTop: 12 }} onSubmit={(event) => {
            event.preventDefault();
            if (window.confirm(`Reset two-factor for ${s.fullName}? Their authenticator and recovery codes stop working, they are signed out everywhere, and they set up a new authenticator at their next sign-in. Do this only once you have confirmed who is asking.`)) void run(() => api.resetTwoFactor(s.userId, reason.trim()), () => { setReason(''); onChanged(); });
          }}>
            <label>Reset two-factor (lost phone and codes): how was the person identified?<input value={reason} minLength={5} maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="Video call; confirmed on their known mobile number" /></label>
            <div><button className="btn ghost" disabled={pending || reason.trim().length < 5}>Reset two-factor</button></div>
          </form>
        </td></tr>
      ) : null}
    </>
  );
}

function AddStaff({ full, onAdded }: { full: boolean; onAdded: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [role, setRole] = useState<StaffRole>('concierge');
  return (
    <>
      <h2>Add an account</h2>
      <form className="panel" aria-label="Add an account" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget, f = new FormData(form), text = (k: string) => String(f.get(k) ?? '').trim();
        if (!window.confirm(`Give ${text('fullName')} ${role === 'admin' ? 'administrator' : 'concierge desk'} access to the admin console? They are emailed how to sign in.`)) return;
        void run(() => api.addStaff({ fullName: text('fullName'), email: text('email'), title: text('title'), role }), () => { form.reset(); setRole('concierge'); onAdded(); });
      }}>
        <div className="form">
          <label>Full name<input name="fullName" required minLength={2} maxLength={120} disabled={full} /></label>
          <label>Work email address<input name="email" type="email" required maxLength={200} disabled={full} /></label>
          <label>Title (optional)<input name="title" maxLength={80} disabled={full} placeholder="Membership director" /></label>
          <label>Role<select value={role} disabled={full} onChange={(event) => setRole(event.target.value as StaffRole)}>{(Object.keys(ROLE) as StaffRole[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></label>
        </div>
        <p className="note">{ROLE_NOTE[role]}</p>
        <p className="muted" style={{ fontSize: 13.5 }}>They sign in at the admin console with this address: a one-time code is emailed to them, and at the first sign-in they set up two-factor. There is no password.</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending || full}>{full ? 'All accounts in use' : pending ? 'Adding' : 'Add account'}</button></div>
      </form>
    </>
  );
}
