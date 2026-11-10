'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useState } from 'react';
import type { Guest, StaffExperience, StaffMember } from '@quintara/api-client';
import { ADMISSION_LABEL } from '@quintara/domain';
import { fmtDate, fmtMoney, Loaded, useAdmin, useCan, useLoad, useRun } from '@/lib/admin';

export default function ExperiencePage() {
  const { id } = useParams<{ id: string }>();
  const canSeeMembers = useCan('admin.members.manage');
  const state = useLoad(async (api) => {
    const [experiences, guests, members] = await Promise.all([api.listExperiences(), api.listGuests(id), canSeeMembers ? api.listMembers() : Promise.resolve([])]);
    const experience = experiences.find((e) => e.id === id);
    if (!experience) throw new Error('This experience does not exist.');
    return { experience, guests, members };
  }, [id, canSeeMembers]);
  return (
    <>
      <p><Link className="muted" href="/experiences">All experiences</Link></p>
      <Loaded state={state}>{({ experience, guests, members }) => <Detail experience={experience} guests={guests} members={members} onChanged={state.reload} />}</Loaded>
    </>
  );
}

function Detail({ experience: e, guests, members, onChanged }: { experience: StaffExperience; guests: Guest[]; members: StaffMember[]; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [capacity, setCapacity] = useState(e.capacity);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [invitee, setInvitee] = useState('');
  const [hold, setHold] = useState(e.paymentHoldMinutes);
  const [refund, setRefund] = useState(e.refundHours);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>{e.title}</h1><p className="lede">{fmtDate(e.startsAt, e.timezone)}. {e.venueName}{e.area ? `, ${e.area}` : ''}. {ADMISSION_LABEL[e.admission]}{e.openToGuests ? ', open to guests' : ', members only'}. {fmtMoney(e.memberPriceMinor, e.currency)}.</p></div>
        <span className={`chip ${e.status === 'published' ? 'ok' : 'gold'}`}>{e.status[0]?.toUpperCase() + e.status.slice(1)}</span>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="panel">
        <div className="row">
          <strong style={{ fontWeight: 500 }}>{e.seatsTaken} of {e.capacity} seats taken</strong>
          <label className="check">Capacity<input type="number" min={1} value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} style={{ width: 90 }} /></label>
          <button className="btn ghost" disabled={pending || capacity === e.capacity} onClick={() => run(() => api.updateExperience(e.id, { capacity }), onChanged)}>Save capacity</button>
          {e.status === 'draft' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updateExperience(e.id, { status: 'published' }), onChanged)}>Publish</button> : null}
          {e.status === 'published' ? <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateExperience(e.id, { status: 'draft' }), onChanged)}>Unpublish</button> : null}
          <label className="check"><input type="checkbox" checked={e.isHidden} disabled={pending} onChange={(event) => run(() => api.updateExperience(e.id, { isHidden: event.target.checked }), onChanged)} /> Hidden from the calendar</label>
          <label className="check"><input type="checkbox" checked={e.openToGuests} disabled={pending} onChange={(event) => run(() => api.updateExperience(e.id, { openToGuests: event.target.checked }), onChanged)} /> Open to guests</label>
        </div>
      </div>

      {e.memberPriceMinor > 0 ? (
        <div className="panel">
          <div className="row">
            <strong style={{ fontWeight: 500 }}>Payment rules</strong>
            <label className="check">Hold seats for<input type="number" min={5} max={10080} value={hold} onChange={(event) => setHold(Number(event.target.value))} style={{ width: 90 }} />minutes</label>
            <label className="check">Full refund up to<input type="number" min={0} max={8760} value={refund} onChange={(event) => setRefund(Number(event.target.value))} style={{ width: 90 }} />hours before</label>
            <button className="btn ghost" disabled={pending || (hold === e.paymentHoldMinutes && refund === e.refundHours)} onClick={() => run(() => api.updateExperience(e.id, { paymentHoldMinutes: hold, refundHours: refund }), onChanged)}>Save rules</button>
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>A booking holds its seats this long while the member pays. Cancelling later than the refund point returns nothing.</p>
        </div>
      ) : null}

      <h2>Guest list</h2>
      {guests.length === 0 ? <p className="note">No bookings yet.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Guest</th><th>Seats</th><th>Ticket</th><th>Status</th><th></th></tr></thead>
          <tbody>{guests.map((g) => (
            <Fragment key={g.bookingId}>
            <tr>
              <td>{g.fullName}<small>{g.memberNumber}</small></td><td>{g.seats}</td><td>{g.ticketCode}</td>
              <td><span className={`chip ${g.status === 'confirmed' || g.status === 'attended' ? 'ok' : 'gold'}`}>{g.checkedInAt ? 'Checked in' : g.status === 'awaiting_payment' ? 'Awaiting payment' : g.status[0]?.toUpperCase() + g.status.slice(1)}</span></td>
              <td className="row">
                {g.status === 'applied' || g.status === 'waitlisted' ? (
                  <>
                    <button className="btn" disabled={pending} onClick={() => run(() => api.decideBooking(g.bookingId, 'confirm'), onChanged)}>Confirm seat</button>
                    <button className="btn ghost" disabled={pending} onClick={() => run(() => api.decideBooking(g.bookingId, 'decline'), onChanged)}>Decline</button>
                  </>
                ) : null}
                {g.status === 'confirmed' ? <button className="btn" disabled={pending} onClick={() => run(() => api.checkIn(g.ticketCode), onChanged)}>Check in</button> : null}
                {LIVE.includes(g.status) && !g.checkedInAt ? <button className="btn ghost" disabled={pending} aria-expanded={cancelling === g.bookingId} onClick={() => setCancelling(cancelling === g.bookingId ? null : g.bookingId)}>Cancel</button> : null}
              </td>
            </tr>
            {cancelling === g.bookingId ? <CancelBookingRow guest={g} currency={e.currency} onDone={() => { setCancelling(null); onChanged(); }} /> : null}
          </Fragment>
          ))}</tbody>
        </table></div>
      )}

      {members.length > 0 ? (
        <>
          <h2>Invite a member</h2>
          <div className="row">
            <select aria-label="Member to invite" value={invitee} onChange={(event) => setInvitee(event.target.value)}>
              <option value="">Choose a member</option>
              {members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
            </select>
            <button className="btn ghost" disabled={pending || !invitee} onClick={() => run(() => api.inviteMember(e.id, invitee), () => { setInvitee(''); onChanged(); })}>Send invitation</button>
          </div>
        </>
      ) : null}

      <h2>Cancel the experience</h2>
      <CancelExperience e={e} guests={guests} onChanged={onChanged} />
    </>
  );
}

const LIVE = ['applied', 'waitlisted', 'awaiting_payment', 'confirmed'];

/** Cancelling one booking: a reason the guest is told, and (for finance) the refund. */
function CancelBookingRow({ guest, currency, onDone }: { guest: Guest; currency: string; onDone: () => void }) {
  const { api } = useAdmin();
  const canRefund = useCan('admin.finance.manage');
  const { run, pending, error } = useRun();
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'full' | 'partial' | 'none'>(canRefund ? 'full' : 'none');
  const [amount, setAmount] = useState('');
  const submit = () => {
    const amountMinor = refund === 'partial' ? Math.round(Number(amount) * 100) : undefined;
    const said = refund === 'full' ? 'refund what was paid in full' : refund === 'partial' ? `refund ${fmtMoney(amountMinor ?? 0, currency)}` : 'refund nothing';
    if (!window.confirm(`Cancel ${guest.fullName}'s booking and ${said}? They are told the reason.`)) return;
    void run(() => api.cancelBooking(guest.bookingId, { reason, refund, amountMinor }), onDone);
  };
  return (
    <tr><td colSpan={5}>
      <div className="panel">
        <label>Reason, as the guest will read it<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} placeholder="The host has fallen ill." /></label>
        {canRefund ? (
          <div className="row">
            <label>Refund<select value={refund} onChange={(event) => setRefund(event.target.value as typeof refund)}>
              <option value="full">In full</option><option value="partial">Part of it</option><option value="none">None</option>
            </select></label>
            {refund === 'partial' ? <label>Amount, in {currency}<input type="number" min={1} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></label> : null}
          </div>
        ) : <p className="note">Refunds are decided by finance. This cancels the booking without one; a Finance Manager can refund afterwards from Payments.</p>}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row"><button className="btn" disabled={pending || reason.trim().length < 3 || (refund === 'partial' && !(Number(amount) > 0))} onClick={submit}>{pending ? 'Cancelling' : 'Cancel booking'}</button></div>
      </div>
    </td></tr>
  );
}

/** Cancelling the whole experience: everyone told, everyone refunded in full. */
function CancelExperience({ e, guests, onChanged }: { e: StaffExperience; guests: Guest[]; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [reason, setReason] = useState('');
  const live = guests.filter((g) => LIVE.includes(g.status)).length;
  if (e.status === 'cancelled') return <p className="note">This experience is cancelled. Its guests were told and refunded.</p>;
  return (
    <div className="panel">
      <p className="muted" style={{ margin: 0 }}>Cancels every booking ({live}) and refunds everything paid, in full, whatever the refund rules. Each guest is told the reason. It cannot be undone.</p>
      <label>Reason, as the guests will read it<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} placeholder="A storm warning for the Atlantic Seaboard." /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row"><button className="btn ghost" disabled={pending || reason.trim().length < 3} onClick={() => { if (window.confirm(`Cancel ${e.title}? ${live} guest(s) will be told and refunded in full.`)) void run(() => api.cancelExperience(e.id, reason), onChanged); }}>{pending ? 'Cancelling' : 'Cancel experience'}</button></div>
    </div>
  );
}
