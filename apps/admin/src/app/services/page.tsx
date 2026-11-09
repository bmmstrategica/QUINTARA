'use client';

import { useState } from 'react';
import type { StaffPartnerBooking, StaffService, StaffServicePackage, StaffServiceRequest } from '@quintara/api-client';
import { CONCIERGE_SPECIALIST, leadTimeLabel, longDay, packagePriceLabel, PARTNER_BOOKING_STATUS_LABEL, PRICE_BASES, PRICE_BASIS_LABEL, SERVICE_REQUEST_STATUS_LABEL } from '@quintara/domain';
import type { PriceBasis, PublishStatus, ServicePackageInput, ServiceRequestStatus } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

/** The directory details a service shares with partners: shown to members on Lifestyle. The contact details are for members only. */
type Directory = Pick<StaffService, 'summary' | 'area' | 'website' | 'offer' | 'contactName' | 'contactEmail' | 'contactPhone' | 'address'>;
const readDirectory = (f: FormData): Directory => {
  const text = (key: string) => String(f.get(key) ?? '').trim();
  return { summary: text('summary'), area: text('area'), website: text('website') || null, offer: text('offer'), contactName: text('contactName'), contactEmail: text('contactEmail'), contactPhone: text('contactPhone'), address: text('address') };
};
function DirectoryFields({ s }: { s?: Directory }) {
  return (
    <fieldset className="panel" style={{ display: 'grid', gap: 12, margin: 0 }}>
      <legend>In the directory</legend>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>As for partners. Everyone sees the description, area, website and what they offer; only signed-in members see the focal point and contact details.</p>
      <div className="form">
        <label>Area<input name="area" maxLength={120} defaultValue={s?.area} placeholder="Sea Point, Cape Town" /></label>
        <label>Website (optional)<input name="website" type="url" placeholder="https://" defaultValue={s?.website ?? ''} /></label>
        <label>Location<input name="address" maxLength={240} defaultValue={s?.address} /></label>
      </div>
      <label>One-line description<input name="summary" maxLength={240} defaultValue={s?.summary} /></label>
      <label>What they offer members<textarea name="offer" maxLength={1000} rows={2} defaultValue={s?.offer} /></label>
      <div className="form">
        <label>Focal point (who to ask for)<input name="contactName" maxLength={120} defaultValue={s?.contactName} /></label>
        <label>Email address<input name="contactEmail" type="email" maxLength={200} defaultValue={s?.contactEmail} /></label>
        <label>Contact number<input name="contactPhone" maxLength={40} pattern="[0-9+() \-]*" defaultValue={s?.contactPhone} /></label>
      </div>
    </fieldset>
  );
}

const STATUS: Record<PublishStatus, string> = { draft: 'Draft', published: 'Offered', archived: 'Withdrawn' };
const NEXT: Partial<Record<ServiceRequestStatus, [ServiceRequestStatus, string][]>> = {
  requested: [['in_progress', 'Start arranging'], ['cancelled', 'Cancel']],
  in_progress: [['confirmed', 'Mark confirmed'], ['cancelled', 'Cancel']],
  confirmed: [['completed', 'Mark completed'], ['cancelled', 'Cancel']],
};

export default function ServicesPage() {
  const { api } = useAdmin();
  const services = useLoad((client) => client.listServices());
  const requests = useLoad((client) => client.listServiceRequests());
  const partnerBookings = useLoad((client) => client.listPartnerBookings());
  const { run, pending, error } = useRun();
  return (
    <>
      <div><h1>Lifestyle services</h1><p className="lede">Services that guests and members can ask to book. They appear with the partners in the Lifestyle directory, with the same directory details. Each request comes here for {CONCIERGE_SPECIALIST.shortName} and the concierge desk to arrange with the provider.</p></div>
      <h2>Partner bookings sent by QÉRA</h2>
      <p className="muted">QÉRA writes to the partner's contact in the directory, and the partner confirms or declines through a private link. Nothing is needed here unless a partner telephones instead: then record their answer. A refusal comes to the concierge queue for an alternative.</p>
      <Loaded state={partnerBookings}>
        {(list) => list.length === 0 ? <p className="note">QÉRA has not sent any partner bookings yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Partner</th><th>Member</th><th>When</th><th>Guests</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((b) => <PartnerBookingRow key={b.id} booking={b} onChanged={partnerBookings.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <h2>Service requests</h2>
      <Loaded state={requests}>
        {(list) => list.length === 0 ? <p className="note">No requests yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Service</th><th>From</th><th>Preferred date</th><th>Notes</th><th>Asked</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((r) => <RequestRow key={r.id} request={r} onChanged={requests.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>Services</h2><a className="btn" href="#new-service">Add service</a></div>
      <Loaded state={services}>
        {(list) => list.length === 0 ? <p className="note">No services yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Service</th><th>Category</th><th>Packages</th><th>Order</th><th>Requests</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((s) => <ServiceRow key={s.id} service={s} onChanged={services.reload} />)}</tbody>
          </table><datalist id="service-categories">{[...new Set(list.map((s) => s.category))].sort().map((c) => <option key={c} value={c} />)}</datalist></div>
        )}
      </Loaded>
      <h2 id="new-service">New service</h2>
      <form className="panel" aria-label="New service" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
        void run(() => api.createService({ name: text('name'), description: text('description'), category: text('category') || 'Lifestyle', position: Number(f.get('position') || 0), status: f.get('publish') === 'on' ? 'published' : 'draft', ...readDirectory(f) }), () => { form.reset(); services.reload(); });
      }}>
        <div className="form">
          <label>Name<input name="name" required minLength={2} maxLength={120} /></label>
          <label>Category<input name="category" required minLength={2} maxLength={60} list="service-categories" placeholder="Wellness, Dining, Mobility" /></label>
          <label>Order in the list<input name="position" type="number" min={0} max={10000} defaultValue={100} /></label>
        </div>
        <label>Description<textarea name="description" maxLength={1000} rows={3} placeholder="What the service is, what it includes, and what to tell us when asking to book." /></label>
        <DirectoryFields />
        <label className="check"><input type="checkbox" name="publish" /> Offer it straight away</label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Add service'}</button></div>
      </form>
    </>
  );
}

function ServiceRow({ service: s, onChanged }: { service: StaffService; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <tr>
        <td style={{ maxWidth: 460 }}>{s.name}<small>{s.summary || s.description || 'No description'}</small><small>{s.contactName || s.contactEmail || s.contactPhone ? `Focal point: ${[s.contactName, s.contactEmail, s.contactPhone].filter(Boolean).join(', ')}` : 'No focal point yet'}{s.area ? `. ${s.area}` : ''}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
        <td>{s.category}</td>
        <td>{s.packages.length}<small>{s.packages.slice(0, 2).map((p) => `${p.name}: ${packagePriceLabel(p)}`).join(' · ')}</small></td>
        <td>{s.position}</td>
        <td>{s.requests}</td>
        <td><span className={`chip ${s.status === 'published' ? 'ok' : s.status === 'draft' ? 'gold' : ''}`}>{STATUS[s.status]}</span></td>
        <td className="row">
          <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
          {s.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updateService(s.id, { status: 'published' }), onChanged)}>Offer</button> : <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Withdraw ${s.name}? It will no longer be offered. Requests already made are kept.`)) void run(() => api.updateService(s.id, { status: 'archived' }), onChanged); }}>Remove</button>}
        </td>
      </tr>
      {editing ? (
        <tr><td colSpan={7}>
          <form aria-label={`Edit ${s.name}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
            void run(() => api.updateService(s.id, { name: text('name'), description: text('description'), category: text('category') || s.category, position: Number(f.get('position') || 0), ...readDirectory(f) }), () => { setEditing(false); onChanged(); });
          }}>
            <div className="form">
              <label>Name<input name="name" required minLength={2} maxLength={120} defaultValue={s.name} /></label>
              <label>Category<input name="category" required minLength={2} maxLength={60} list="service-categories" defaultValue={s.category} /></label>
              <label>Order in the list<input name="position" type="number" min={0} max={10000} defaultValue={s.position} /></label>
            </div>
            <label>Description<textarea name="description" maxLength={1000} rows={4} defaultValue={s.description} /></label>
            <DirectoryFields s={s} />
            <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
          </form>
          <Packages service={s} onChanged={onChanged} />
        </td></tr>
      ) : null}
    </>
  );
}

function RequestRow({ request: r, onChanged }: { request: StaffServiceRequest; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{r.serviceName}{r.packageName ? <small>{r.packageName}{r.priceLabel ? `, ${r.priceLabel}` : ''}</small> : null}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{r.contactName}<small>{r.contactEmail}</small><small>{r.isMember ? 'Member' : 'Guest'}</small></td>
      <td>{r.preferredDate ?? 'Not given'}</td>
      <td style={{ maxWidth: 300 }}>{r.notes || 'None'}</td>
      <td>{fmtDate(r.createdAt)}</td>
      <td><span className={`chip ${r.status === 'completed' || r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? '' : 'gold'}`}>{SERVICE_REQUEST_STATUS_LABEL[r.status]}</span></td>
      <td className="row">{(NEXT[r.status] ?? []).map(([status, label]) => <button key={status} className={`btn ${status === 'cancelled' ? 'ghost' : ''}`} disabled={pending} onClick={() => run(() => api.setServiceRequestStatus(r.id, status), onChanged)}>{label}</button>)}</td>
    </tr>
  );
}

function PartnerBookingRow({ booking: b, onChanged }: { booking: StaffPartnerBooking; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{b.partnerName}<small>{b.emailed ? 'Email sent to the partner' : 'Email waiting to be sent'}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{b.memberName}</td>
      <td>{longDay(b.date)}{b.time ? ` at ${b.time}` : ''}{b.notes ? <small>{b.notes}</small> : null}</td>
      <td>{b.partySize}</td>
      <td><span className={`chip ${b.status === 'confirmed' ? 'ok' : b.status === 'requested' ? 'gold' : ''}`}>{PARTNER_BOOKING_STATUS_LABEL[b.status]}</span>{b.partnerNote ? <small>{b.partnerNote}</small> : null}</td>
      <td className="row">{b.status === 'requested' ? (
        <>
          <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Record that ${b.partnerName} confirmed by telephone? ${b.memberName} will be told.`)) void run(() => api.settlePartnerBooking(b.id, 'confirm'), onChanged); }}>Partner confirmed</button>
          <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Record that ${b.partnerName} cannot take it? It becomes a concierge request for an alternative.`)) void run(() => api.settlePartnerBooking(b.id, 'decline'), onChanged); }}>Partner declined</button>
        </>
      ) : null}</td>
    </tr>
  );
}

/** Packages: what can be booked, at an indicative price, with how much notice. */
function Packages({ service: s, onChanged }: { service: StaffService; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const read = (form: HTMLFormElement): ServicePackageInput => {
    const f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim(), price = text('price');
    return { name: text('name'), description: text('description'), priceMinor: price === '' ? null : Math.round(Number(price) * 100), priceBasis: text('basis') as PriceBasis, leadTimeHours: Math.round(Number(text('days') || 0) * 24), duration: text('duration'), position: Number(text('position') || 0) };
  };
  const fields = (p?: StaffServicePackage) => (
    <div className="form">
      <label>Package<input name="name" required minLength={2} maxLength={120} defaultValue={p?.name} /></label>
      <label>Price in rand (blank: on request)<input name="price" type="number" min={0} step="1" defaultValue={p?.priceMinor === null || p === undefined ? '' : p.priceMinor / 100} /></label>
      <label>Charged<select name="basis" defaultValue={p?.priceBasis ?? 'per_booking'}>{PRICE_BASES.map((b) => <option key={b} value={b}>{PRICE_BASIS_LABEL[b]}</option>)}</select></label>
      <label>Notice, in days<input name="days" type="number" min={0} max={365} step="0.25" defaultValue={p ? p.leadTimeHours / 24 : 2} /></label>
      <label>Duration<input name="duration" maxLength={60} defaultValue={p?.duration} placeholder="2 hours" /></label>
      <label>Order<input name="position" type="number" min={0} max={10000} defaultValue={p?.position ?? s.packages.length} /></label>
      <label style={{ gridColumn: '1 / -1' }}>What it includes<input name="description" maxLength={600} defaultValue={p?.description} /></label>
    </div>
  );
  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ margin: '0 0 8px' }}>Packages</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>Members and guests see these under Lifestyle. Prices are shown as indicative; the provider confirms the final price. Requests keep the package and price they were made with.</p>
      {s.packages.map((p) => (
        <form key={p.id} className="panel" style={{ marginBottom: 10 }} aria-label={`Package ${p.name}`} onSubmit={(event) => { event.preventDefault(); const v = read(event.currentTarget); void run(() => api.updateServicePackage(p.id, v), onChanged); }}>
          {fields(p)}
          <div className="row">
            <button className="btn ghost" disabled={pending}>Save package</button>
            <button type="button" className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Remove the package ${p.name}?`)) void run(() => api.deleteServicePackage(p.id), onChanged); }}>Remove</button>
            <span className="muted" style={{ fontSize: 13 }}>{packagePriceLabel(p)}. {leadTimeLabel(p.leadTimeHours)}.</span>
          </div>
        </form>
      ))}
      <form className="panel" aria-label={`New package for ${s.name}`} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, v = read(form); void run(() => api.createServicePackage(s.id, v), () => { form.reset(); onChanged(); }); }}>
        {fields()}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>Add package</button></div>
      </form>
    </div>
  );
}
