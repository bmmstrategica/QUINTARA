'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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
            <tr key={g.bookingId}>
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
              </td>
            </tr>
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
    </>
  );
}
