'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ADMISSION_LABEL, ADMISSIONS, localToInstant } from '@quintara/domain';
import type { Admission } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useCan, useLoad, useRun } from '@/lib/admin';

export default function ExperiencesPage() {
  const { api, market } = useAdmin();
  const zone = market?.timezone ?? 'Africa/Johannesburg';
  const router = useRouter();
  const state = useLoad((client) => client.listExperiences());
  const { run, pending, error } = useRun();
  // Guest-list staff (Support) see the experiences to reach their guest lists, and change nothing else.
  const canEdit = useCan('admin.experiences.manage');

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
    await run(async () => {
      const created = await api.createExperience({
        title: text('title'), category: text('category'), summary: text('summary'), venueName: text('venue'), area: text('area'),
        // The form is filled in the city's own time; the instant is worked out from its time zone.
        startsAt: localToInstant(text('date'), text('time'), zone), timezone: zone,
        capacity: Number(f.get('capacity')), memberPriceMinor: Math.round(Number(f.get('price')) * 100), priceMinor: Math.round(Number(f.get('price')) * 100),
        currency: market?.currency ?? 'ZAR', admission: text('admission') as Admission, openToGuests: f.get('openToGuests') === 'on', maxSeatsPerBooking: Number(f.get('maxSeats')), status: 'draft',
      });
      router.push(`/experiences/${created.id}`);
    });
  }

  return (
    <>
      <div><h1>Experiences</h1><p className="lede">{canEdit ? <>New experiences start as drafts. Publish from the experience page when it is ready. Tick “Open to guests” for each experience guests may see; guests never see dates or seat numbers.</> : 'Open an experience for its guest list: confirm seats, check guests in, cancel a booking.'}</p></div>
      <Loaded state={state}>
        {(experiences) => (
          <div className="scroll"><table>
            <thead><tr><th>Experience</th><th>When</th><th>Admission</th><th>Open to guests</th><th>Seats</th><th>Status</th><th></th></tr></thead>
            <tbody>{experiences.map((e) => (
              <tr key={e.id}>
                <td>{e.title}<small>{e.category}. {e.venueName}{e.area ? `, ${e.area}` : ''}</small></td>
                <td>{fmtDate(e.startsAt, e.timezone)}</td>
                <td>{ADMISSION_LABEL[e.admission]}{e.isHidden ? <small>Hidden from the calendar</small> : null}</td>
                <td>
                  {canEdit ? <label className="check"><input type="checkbox" checked={e.openToGuests} disabled={pending} aria-label={`Open ${e.title} to guests`}
                    onChange={(event) => run(() => api.updateExperience(e.id, { openToGuests: event.target.checked }), state.reload)} /> {e.openToGuests ? 'Yes' : 'No'}</label> : e.openToGuests ? 'Yes' : 'No'}
                </td>
                <td>{e.seatsTaken} of {e.capacity}</td>
                <td><span className={`chip ${e.status === 'published' ? 'ok' : e.status === 'draft' ? 'gold' : ''}`}>{e.status[0]?.toUpperCase() + e.status.slice(1)}</span></td>
                <td><Link className="btn ghost" href={`/experiences/${e.id}`}>Open</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Loaded>
      {canEdit ? <>
      <h2>New experience</h2>
      <form className="panel" onSubmit={create}>
        <div className="form">
          <label>Title<input name="title" required minLength={2} /></label>
          <label>Category<input name="category" required defaultValue="Dining" /></label>
          <label>Date<input name="date" type="date" required /></label>
          <label>Start time ({market?.name ?? 'local'} time)<input name="time" type="time" required defaultValue="18:30" /></label>
          <label>Venue<input name="venue" /></label>
          <label>Area<input name="area" /></label>
          <label>Seats<input name="capacity" type="number" min={1} required defaultValue={20} /></label>
          <label>Most seats per booking<input name="maxSeats" type="number" min={1} max={20} required defaultValue={2} /></label>
          <label>Member price per seat, in rand<input name="price" type="number" min={0} step="1" required defaultValue={0} /></label>
          <label>Admission<select name="admission" defaultValue="members_only">{ADMISSIONS.map((a) => <option key={a} value={a}>{ADMISSION_LABEL[a]}</option>)}</select></label>
        </div>
        <label>One-line description<input name="summary" maxLength={240} /></label>
        <label className="check"><input type="checkbox" name="openToGuests" /> Open to guests (shown without its date or seat numbers)</label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Create draft'}</button></div>
      </form>
      </> : null}
    </>
  );
}
