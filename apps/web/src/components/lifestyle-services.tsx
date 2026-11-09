'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAction, useResource, useSession } from '@quintara/app-core';
import { CONCIERGE_SPECIALIST, earliestDate, leadTimeLabel, longDay, packagePriceLabel, SERVICE_REQUEST_STATUS_LABEL } from '@quintara/domain';
import type { DirectoryEntry, LifestyleService, Partner, ServiceRequest } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

/** Services guests and members can ask to book. A request goes to the concierge desk; nothing is paid here. */
/** The Lifestyle Curator, named under Lifestyle as the relationship manager is under Business. */
export function LifestyleCurator() {
  const curator = useSection('curator');
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const write = useAction((api) => api.createConciergeRequest({ category: 'personal', subject, details, neededBy: null }));
  return (
    <section className="panel" style={{ marginBottom: '2.5rem' }} aria-label="Your Lifestyle Curator">
      <h3>Your Lifestyle Curator</h3>
      <p style={{ marginTop: '0.8rem' }}><strong style={{ fontWeight: 500 }}>{CONCIERGE_SPECIALIST.name}</strong>, {curator.summary}. {curator.description}</p>
      {sent ? <p className="notice" role="status">Thank you. {CONCIERGE_SPECIALIST.shortName} has your message. <Link href={`/concierge/${sent}`}>Follow her reply</Link>.</p> : null}
      {!session ? <p className="muted">Members can write to her directly. Guests reach her by asking to book a service below.</p> : open ? (
        <form className="stack" aria-label={`Write to ${CONCIERGE_SPECIALIST.shortName}`} onSubmit={async (event) => { event.preventDefault(); const made = await write.run(); if (made) { setSent(made.id); setOpen(false); setSubject(''); setDetails(''); } }}>
          <label>Subject<input value={subject} maxLength={120} onChange={(event) => setSubject(event.target.value)} />{write.error?.fields?.subject ? <span className="field-error" role="alert">{write.error.fields.subject}</span> : null}</label>
          <label>What you would like arranged<textarea value={details} maxLength={2000} onChange={(event) => setDetails(event.target.value)} placeholder="Dates, number of people, preferences" />{write.error?.fields?.details ? <span className="field-error" role="alert">{write.error.fields.details}</span> : null}</label>
          <ActionError error={write.error} />
          <div className="row"><button className="btn small" disabled={write.pending}>{write.pending ? 'Sending' : `Send to ${CONCIERGE_SPECIALIST.shortName}`}</button><button type="button" className="btn quiet small" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      ) : <div className="row"><button className="btn small" onClick={() => { setSent(null); setOpen(true); }}>Write to {CONCIERGE_SPECIALIST.shortName}</button><Link className="btn quiet small" href="/qera">Ask QÉRA first</Link></div>}
    </section>
  );
}

/** Who to ask for and how to reach them: members only (the server sends nothing to visitors). */
export function ContactFacts({ entry }: { entry: Pick<LifestyleService, 'contactName' | 'contactEmail' | 'contactPhone'> }) {
  if (!entry.contactName && !entry.contactEmail && !entry.contactPhone) return null;
  return (
    <div className="facts row" style={{ marginTop: '0.3rem' }}>
      {entry.contactName ? <span>Ask for {entry.contactName}.</span> : null}
      {entry.contactEmail ? <a href={`mailto:${entry.contactEmail}`}>{entry.contactEmail}</a> : null}
      {entry.contactPhone ? <a href={`tel:${entry.contactPhone.replace(/[^0-9+]/g, '')}`}>{entry.contactPhone}</a> : null}
    </div>
  );
}

type Kind = '' | 'partner' | 'service';

/**
 * The partners and services directory: one list of the places, people and services Quintara vouches for, each with
 * the same details. Partners (with their privileges) are for members; visitors see the services.
 */
export function LifestyleDirectory({ isMember }: { isMember: boolean }) {
  const { session } = useSession();
  const services = useResource((api) => api.listLifestyleServices(), [Boolean(session)]);
  const partners = useResource((api) => (isMember ? api.listPartners() : Promise.resolve([] as Partner[])), [isMember]);
  const intro = useSection('partners');
  const privileges = useSection('privileges');
  const [kind, setKind] = useState<Kind>('');
  const [category, setCategory] = useState('');
  const [version, setVersion] = useState(0);
  const entries: DirectoryEntry[] = [
    ...(partners.data ?? []).map((p) => ({ kind: 'partner' as const, ...p })),
    ...(services.data ?? []).map((x) => ({ kind: 'service' as const, ...x })),
  ];
  const shown = entries.filter((e) => (!kind || e.kind === kind) && (!category || e.category === category));
  return (
    <section style={{ marginBottom: '3rem' }} aria-label={intro.title}>
      <div className="head" style={{ marginBottom: 0 }}>
        <div>
          <h3 style={{ fontStyle: 'italic' }}>{intro.title}</h3>
          <p className="muted" style={{ margin: '0.6rem 0 0.4rem' }}>{intro.description}{isMember ? ` ${privileges.description}` : ' Members also see our partners and their privileges.'}</p>
        </div>
        <div className="row">
          {isMember ? (
            <label>Show
              <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                <option value="">Partners and services</option><option value="partner">Partners</option><option value="service">Services</option>
              </select>
            </label>
          ) : null}
          <label>Category
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Every category</option>
              {[...new Set(entries.map((e) => e.category))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
      </div>
      <ResourceView resource={services}>
        {() => !shown.length ? <p className="muted">{entries.length ? 'Nothing in this category yet.' : 'The directory will fill as partners and services join.'}</p>
          : [...new Set(shown.map((e) => e.category))].sort().map((group) => (
            <div key={group} role="group" aria-label={group}>
              <h4 className="group-label">{group}</h4>
              {shown.filter((e) => e.category === group).sort((x, y) => x.name.localeCompare(y.name)).map((e) => e.kind === 'partner'
                ? <PartnerItem key={e.id} partner={e} />
                : <ServiceItem key={e.id} service={e} isMember={Boolean(session)} onRequested={() => setVersion(version + 1)} />)}
            </div>
          ))}
      </ResourceView>
      {session ? <MyRequests key={version} /> : null}
    </section>
  );
}

function PartnerItem({ partner }: { partner: Partner }) {
  const open = partner.privileges.filter((v) => v.available).length;
  return (
    <article className="item-row plain">
      <div>
        <h3><Link href={`/lifestyle/${partner.id}`}>{partner.name}</Link></h3>
        <p>{partner.summary}</p>
        {partner.offer && partner.offer !== partner.summary ? <p className="muted">{partner.offer}</p> : null}
        <div className="facts row"><span className="tag">Partner</span>{partner.address || partner.area ? <span>{partner.address || partner.area}.</span> : null}</div>
        <ContactFacts entry={partner} />
      </div>
      <div className="actions">
        {open ? <span className="tag accent">{open} privilege{open > 1 ? 's' : ''}</span> : null}
        <Link className="btn quiet small" href={`/lifestyle/${partner.id}`}>View</Link>
      </div>
    </article>
  );
}

/** A service in the directory, or on its own page (`detail`): its details, packages and a request to book. */
export function ServiceItem({ service, isMember, onRequested, detail = false }: { service: LifestyleService; isMember: boolean; onRequested: () => void; detail?: boolean }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const { guest } = useSession();
  // A signed-in guest's name and email are filled in from their account.
  const [form, setForm] = useState({ fullName: guest?.fullName ?? '', email: guest?.email ?? '', preferredDate: '', notes: '', packageId: service.packages[0]?.id ?? '' });
  const chosen = service.packages.find((p) => p.id === form.packageId) ?? null;
  // The earliest date the chosen package allows, in Cape Town's calendar (the server checks it again).
  const first = earliestDate(chosen?.leadTimeHours ?? 0, new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10));
  const request = useAction((api) => api.requestLifestyleService(service.id, { preferredDate: form.preferredDate || null, notes: form.notes, packageId: form.packageId || null, guest: isMember ? undefined : { fullName: form.fullName, email: form.email } }));
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: event.target.value });
  return (
    <article className="item-row plain">
      <div>
        {detail ? null : <h3><Link href={`/lifestyle/services/${service.id}`}>{service.name}</Link></h3>}
        {detail ? null : <p>{service.summary || service.description}</p>}
        {!detail && service.offer ? <p className="muted">{service.offer}</p> : null}
        {detail ? null : <div className="facts row"><span className="tag">Service</span>{service.address || service.area ? <span>{service.address || service.area}.</span> : null}<span>Arranged by Quintara.</span></div>}
        {detail ? null : <ContactFacts entry={service} />}
        {service.packages.length ? (
          <ul className="packages" aria-label={`${service.name} packages`}>
            {service.packages.map((p) => (
              <li key={p.id}>
                <span><strong>{p.name}</strong>{p.duration ? <small> · {p.duration}</small> : null}{p.description ? <small className="pkg-about">{p.description}</small> : null}</span>
                <span className="pkg-meta"><span>{packagePriceLabel(p)}</span><small>{leadTimeLabel(p.leadTimeHours)}</small></span>
              </li>
            ))}
          </ul>
        ) : null}
        {service.packages.length ? <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>Prices are indicative. The provider confirms the final price before anything is booked.</p> : null}
        {sent ? <p className="notice" role="status">Thank you. Your request for {service.name} is with the concierge desk{isMember ? '. You can follow it under Your requests' : ', who will reply by email'}.</p> : null}
        {open ? (
          <form className="stack" style={{ marginTop: '1rem' }} aria-label={`Book ${service.name}`} onSubmit={async (event) => { event.preventDefault(); if (await request.run()) { setOpen(false); setSent(true); setForm({ ...form, preferredDate: '', notes: '' }); onRequested(); } }}>
            {isMember ? null : (
              <div className="field-row">
                <label>Your name<input value={form.fullName} maxLength={120} autoComplete="name" onChange={set('fullName')} />{request.error?.fields?.fullName ? <span className="field-error" role="alert">{request.error.fields.fullName}</span> : null}</label>
                <label>Email address<input type="email" value={form.email} maxLength={200} autoComplete="email" onChange={set('email')} />{request.error?.fields?.email ? <span className="field-error" role="alert">{request.error.fields.email}</span> : null}</label>
              </div>
            )}
            {service.packages.length ? (
              <label>Package
                <select value={form.packageId} onChange={(event) => setForm({ ...form, packageId: event.target.value })}>
                  {service.packages.map((p) => <option key={p.id} value={p.id}>{p.name}, {packagePriceLabel(p)}, {leadTimeLabel(p.leadTimeHours).toLowerCase()}</option>)}
                </select>
              </label>
            ) : null}
            <label>Preferred date (optional){chosen && chosen.leadTimeHours > 0 ? <small className="muted"> The earliest is {longDay(first)}.</small> : null}<input type="date" min={first} value={form.preferredDate} onChange={set('preferredDate')} />{request.error?.fields?.preferredDate ? <span className="field-error" role="alert">{request.error.fields.preferredDate}</span> : null}</label>
            <label>What you have in mind<textarea value={form.notes} maxLength={1000} onChange={set('notes')} placeholder="Occasion, number of people, anything the provider should know." /></label>
            {isMember ? null : <p className="muted" style={{ fontSize: '0.9rem' }}>Your name and email are used only to arrange this booking.</p>}
            <ActionError error={request.error} />
            <div className="row"><button className="btn small" disabled={request.pending}>{request.pending ? 'Sending' : 'Send request'}</button><button type="button" className="btn quiet small" onClick={() => setOpen(false)}>Cancel</button></div>
          </form>
        ) : null}
      </div>
      <div className="actions">
        {open ? null : <button className="btn small" onClick={() => { setSent(false); setOpen(true); }}>Ask to book</button>}
        {detail ? null : <Link className="btn quiet small" href={`/lifestyle/services/${service.id}`}>View</Link>}
      </div>
    </article>
  );
}

function MyRequests() {
  const requests = useResource((api) => api.listMyServiceRequests());
  const cancel = useAction(async (api, id: string) => { await api.cancelMyServiceRequest(id); return true; });
  return (
    <ResourceView resource={requests}>
      {(list: ServiceRequest[]) => list.length ? (
        <section className="panel" style={{ marginTop: '2rem' }}>
          <h3>Your requests</h3>
          {list.map((r) => (
            <div className="panel-item" key={r.id}>
              <div><strong style={{ fontWeight: 500 }}>{r.serviceName}{r.packageName ? `, ${r.packageName}` : ''}</strong><small>{r.priceLabel ? `${r.priceLabel} (indicative). ` : ''}{r.preferredDate ? `For ${new Date(r.preferredDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}. ` : ''}{r.notes}</small></div>
              <div className="row">
                <span className={`tag ${r.status === 'confirmed' || r.status === 'completed' ? 'positive' : r.status === 'cancelled' ? '' : 'accent'}`}>{SERVICE_REQUEST_STATUS_LABEL[r.status]}</span>
                {['requested', 'in_progress', 'confirmed'].includes(r.status) ? <button className="btn quiet small" disabled={cancel.pending} onClick={async () => { if (window.confirm(`Cancel your request for ${r.serviceName}?`) && (await cancel.run(r.id))) requests.reload(); }}>Cancel</button> : null}
              </div>
            </div>
          ))}
          <ActionError error={cancel.error} />
        </section>
      ) : null}
    </ResourceView>
  );
}
