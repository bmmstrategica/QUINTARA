'use client';

import { useState } from 'react';
import type { StaffBusinessUpdate, StaffIntroduction, StaffRmEnquiry } from '@quintara/api-client';
import { BUSINESS_ROLE_LABEL, BUSINESS_ROLES, INTRODUCTION_STATUS_LABEL, LISTING_KIND_LABEL, RM_NOTICE, RM_TOPIC_LABEL } from '@quintara/domain';
import type { BusinessListing, BusinessRole } from '@quintara/domain';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const LISTING_STATUS: Record<BusinessListing['status'], string> = { pending: 'To review', published: 'Published', declined: 'Declined', closed: 'Closed' };

export default function BusinessPage() {
  const introductions = useLoad((api) => api.listIntroductions());
  const listings = useLoad((api) => api.listBusinessListings());
  const updates = useLoad((api) => api.listBusinessUpdates());
  const enquiries = useLoad((api) => api.listRmEnquiries());
  return (
    <>
      <div><h1>Business</h1><p className="lede">Quintara introduces members and takes no part in what they agree. Publish only listings that describe what someone is looking for, never an offer with amounts or terms.</p></div>
      <h2>Relationship manager: Mr. Wayne Huffton, BMM Capital</h2>
      <p className="muted">Members write here for insight on investments and for help with a business dealing. {RM_NOTICE}</p>
      <Loaded state={enquiries}>
        {(list) => list.length === 0 ? <p className="note">No enquiries yet.</p> : <>{list.map((e) => <EnquiryPanel key={e.id} enquiry={e} onChanged={enquiries.reload} />)}</>}
      </Loaded>
      <h2>Opportunities from Quintara</h2>
      <p className="muted">Members see a published opportunity under Business and pursue it by writing to the relationship manager. Describe the opportunity; leave out amounts, valuations and terms.</p>
      <Loaded state={updates}>
        {(list) => list.length === 0 ? <p className="note">No opportunities yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Opportunity</th><th>Shown to</th><th>Enquiries</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((u) => <UpdateRow key={u.id} update={u} onChanged={updates.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <UpdateForm onSaved={updates.reload} />
      <h2>Introductions</h2>
      <p className="muted">Offering an introduction shows the request and the note to the other member, who may accept or decline. The requester is never told who said no.</p>
      <Loaded state={introductions}>
        {(list) => list.length === 0 ? <p className="note">No introductions have been requested.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>From</th><th>To</th><th>Their note</th><th>Asked</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((i) => <IntroductionRow key={i.id} introduction={i} onChanged={introductions.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <h2>Members' listings</h2>
      <Loaded state={listings}>
        {(list) => list.length === 0 ? <p className="note">No listings yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Listing</th><th>From</th><th>Shown to</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((l) => <ListingRow key={l.id} listing={l} onChanged={listings.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
    </>
  );
}

function IntroductionRow({ introduction: i, onChanged }: { introduction: StaffIntroduction; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <tr>
      <td>{i.requester.fullName}<small>{i.requester.position}, {i.requester.company}</small></td>
      <td>{i.target.fullName}<small>{i.listingTitle ?? 'No listing'}</small></td>
      <td style={{ maxWidth: 320 }}>{i.note}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{fmtDate(i.createdAt)}</td>
      <td><span className={`chip ${i.status === 'accepted' ? 'ok' : i.status === 'requested' || i.status === 'offered' ? 'gold' : ''}`}>{i.status === 'requested' ? 'To review' : INTRODUCTION_STATUS_LABEL[i.status]}</span></td>
      <td className="row">{i.status === 'requested' ? (
        <>
          <button className="btn" disabled={pending} onClick={() => { if (window.confirm(`Put this request to ${i.target.fullName}? They will see who is asking and the note.`)) void run(() => api.handleIntroduction(i.id, 'offer'), onChanged); }}>Offer to {i.target.fullName.split(' ')[0]}</button>
          <button className="btn ghost" disabled={pending} onClick={() => run(() => api.handleIntroduction(i.id, 'not_progressed'), onChanged)}>Do not progress</button>
        </>
      ) : null}</td>
    </tr>
  );
}

function ListingRow({ listing: l, onChanged }: { listing: BusinessListing; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  const decline = () => { const note = window.prompt('A short note for the member, explaining what to change:'); if (note !== null) void run(() => api.reviewListing(l.id, 'decline', note), onChanged); };
  return (
    <>
    <tr>
      <td style={{ maxWidth: 420 }}>{l.title}<small>{LISTING_KIND_LABEL[l.kind]}{l.sector ? `. ${l.sector}` : ''}</small><small>{l.summary}</small>{l.reviewNote ? <small>Note to member: {l.reviewNote}</small> : null}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{l.postedBy.fullName}<small>{l.postedBy.company}</small></td>
      <td>{l.audience.map((role) => BUSINESS_ROLE_LABEL[role]).join(', ')}</td>
      <td><span className={`chip ${l.status === 'published' ? 'ok' : l.status === 'pending' ? 'gold' : ''}`}>{LISTING_STATUS[l.status]}</span></td>
      <td className="row">
        <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
        {l.status === 'pending' ? <><button className="btn" disabled={pending} onClick={() => run(() => api.reviewListing(l.id, 'publish'), onChanged)}>Publish</button><button className="btn ghost" disabled={pending} onClick={decline}>Decline</button></> : null}
        {l.status === 'published' ? <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm('Remove this listing? Members will no longer see it.')) void run(() => api.reviewListing(l.id, 'close'), onChanged); }}>Remove</button> : null}
      </td>
    </tr>
    {editing ? (
      <tr><td colSpan={5}>
        <form aria-label={`Edit ${l.title}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
          void run(() => api.editListing(l.id, { title: text('title'), summary: text('summary'), sector: text('sector'), audience: BUSINESS_ROLES.filter((role) => f.get(`aud_${role}`) === 'on') }), () => { setEditing(false); onChanged(); });
        }}>
          <div className="form">
            <label>Title<input name="title" required minLength={4} maxLength={120} defaultValue={l.title} /></label>
            <label>Sector<input name="sector" maxLength={60} defaultValue={l.sector} /></label>
          </div>
          <label>Description<textarea name="summary" required minLength={20} maxLength={1200} rows={3} defaultValue={l.summary} /></label>
          {l.kind === 'capital' ? <p className="muted">A listing about raising capital is always shown to investors only.</p> : <Audience selected={l.audience} />}
          <p className="muted">The member is told that the team edited their listing.</p>
          <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      </td></tr>
    ) : null}
    </>
  );
}

function Audience({ selected }: { selected: BusinessRole[] }) {
  return (
    <div className="row" role="group" aria-label="Who should see it">
      {BUSINESS_ROLES.map((role) => <label key={role} className="check"><input type="checkbox" name={`aud_${role}`} defaultChecked={selected.includes(role)} /> {BUSINESS_ROLE_LABEL[role]}</label>)}
    </div>
  );
}

const UPDATE_STATUS = { draft: 'Draft', published: 'Published', archived: 'Archived' } as const;

/** Adds an opportunity, or edits one when `update` is given. */
function UpdateForm({ update: u, onSaved, onCancel }: { update?: StaffBusinessUpdate; onSaved: () => void; onCancel?: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <form className={u ? undefined : 'panel'} aria-label={u ? `Edit ${u.title}` : 'New opportunity'} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
      const data = { title: text('title'), summary: text('summary'), sector: text('sector'), audience: BUSINESS_ROLES.filter((role) => f.get(`aud_${role}`) === 'on') };
      void run(() => (u ? api.updateBusinessUpdate(u.id, data) : api.createBusinessUpdate({ ...data, status: f.get('publish') === 'on' ? 'published' : 'draft' })), () => { if (!u) form.reset(); onSaved(); });
    }}>
      {u ? null : <h2 style={{ margin: 0 }}>Add an opportunity</h2>}
      <div className="form">
        <label>Title<input name="title" required minLength={4} maxLength={120} defaultValue={u?.title} /></label>
        <label>Sector<input name="sector" maxLength={60} defaultValue={u?.sector} placeholder="Hospitality, Technology" /></label>
      </div>
      <label>Description<textarea name="summary" required minLength={20} maxLength={2000} rows={4} defaultValue={u?.summary} /></label>
      <div><span className="muted">Who should see it (none ticked means every member)</span><Audience selected={u?.audience ?? []} /></div>
      {u ? null : <label className="check"><input type="checkbox" name="publish" /> Publish straight away</label>}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : u ? 'Save changes' : 'Add opportunity'}</button>{onCancel ? <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button> : null}</div>
    </form>
  );
}

function UpdateRow({ update: u, onChanged }: { update: StaffBusinessUpdate; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <tr>
        <td style={{ maxWidth: 460 }}>{u.title}<small>{u.sector}</small><small>{u.summary}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
        <td>{u.audience.length ? u.audience.map((role) => BUSINESS_ROLE_LABEL[role]).join(', ') : 'All members'}</td>
        <td>{u.enquiries}</td>
        <td><span className={`chip ${u.status === 'published' ? 'ok' : u.status === 'draft' ? 'gold' : ''}`}>{UPDATE_STATUS[u.status]}</span></td>
        <td className="row">
          <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
          {u.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updateBusinessUpdate(u.id, { status: 'published' }), onChanged)}>Publish</button> : <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateBusinessUpdate(u.id, { status: 'draft' }), onChanged)}>Unpublish</button>}
          <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Remove "${u.title}"? Members will no longer see it. Conversations already started are kept.`)) void run(() => api.deleteBusinessUpdate(u.id), onChanged); }}>Remove</button>
        </td>
      </tr>
      {editing ? <tr><td colSpan={5}><UpdateForm update={u} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /></td></tr> : null}
    </>
  );
}

function EnquiryPanel({ enquiry: e, onChanged }: { enquiry: StaffRmEnquiry; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [body, setBody] = useState('');
  const waiting = e.status === 'open' && e.messages.at(-1)?.from === 'member';
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>{e.subject}</h2><span className="muted">{e.memberName}, {e.memberNumber}{e.memberRole ? `. ${e.memberRole}` : ''}. {e.updateTitle ? `About: ${e.updateTitle}` : RM_TOPIC_LABEL[e.topic]}.</span></div>
        <span className={`chip ${e.status === 'closed' ? '' : waiting ? 'gold' : 'ok'}`}>{e.status === 'closed' ? 'Closed' : waiting ? 'Awaiting your reply' : 'Replied'}</span>
      </div>
      {e.messages.map((m) => <p key={m.id} className={m.from === 'manager' ? 'note' : undefined} style={{ margin: 0 }}><strong style={{ fontWeight: 500 }}>{m.from === 'manager' ? 'Wayne Huffton' : e.memberName}</strong> <span className="muted">{fmtDate(m.sentAt)}</span><br />{m.body}</p>)}
      {e.status === 'open' ? (
        <form style={{ display: 'grid', gap: 12 }} onSubmit={(event) => { event.preventDefault(); void run(() => api.replyToRmEnquiry(e.id, body), () => { setBody(''); onChanged(); }); }}>
          <label>Reply as Wayne Huffton<textarea value={body} maxLength={2000} rows={3} onChange={(event) => setBody(event.target.value)} /></label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="row"><button className="btn" disabled={pending || !body.trim()}>Send reply</button><button type="button" className="btn ghost" disabled={pending} onClick={() => { if (window.confirm('Close this enquiry? The member can start a new one.')) void run(() => api.closeRmEnquiry(e.id), onChanged); }}>Close enquiry</button></div>
        </form>
      ) : null}
    </div>
  );
}
