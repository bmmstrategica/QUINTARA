'use client';

import { useState } from 'react';
import type { StaffPartner, StaffPrivilege } from '@quintara/api-client';
import type { PublishStatus } from '@quintara/domain';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const STATUS: Record<PublishStatus, string> = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const tone = (status: PublishStatus) => (status === 'published' ? 'ok' : status === 'draft' ? 'gold' : '');

export default function PartnersPage() {
  const { api } = useAdmin();
  const state = useLoad((client) => client.listPartners());
  const { run, pending, error } = useRun();

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
    void run(() => api.createPartner({ name: text('name'), category: text('category'), summary: text('summary'), area: text('area'), website: text('website') || null, offer: text('offer'), contactName: text('contactName'), contactEmail: text('contactEmail'), contactPhone: text('contactPhone'), address: text('address') }), () => { form.reset(); state.reload(); });
  }

  return (
    <>
      <div><h1>Partners and privileges</h1><p className="lede">Members see a partner only once it is published, and a privilege only once both it and its partner are published.</p></div>
      <Loaded state={state}>
        {(partners) => partners.length === 0 ? <p className="note">No partners yet.</p> : <>{partners.map((p) => <PartnerPanel key={p.id} partner={p} onChanged={state.reload} />)}</>}
      </Loaded>
      <h2>New partner</h2>
      <form className="panel" onSubmit={create}>
        <div className="form">
          <label>Name<input name="name" required minLength={2} maxLength={120} /></label>
          <label>Category<input name="category" required minLength={2} maxLength={60} placeholder="Dining, Wellness, Travel" /></label>
          <label>Area<input name="area" maxLength={120} /></label>
          <label>Website (optional)<input name="website" type="url" placeholder="https://" /></label>
        </div>
        <label>One-line description<input name="summary" maxLength={240} /></label>
        <label>What they offer<input name="offer" maxLength={1000} /></label>
        <div className="form">
          <label>Focal point (who to ask for)<input name="contactName" maxLength={120} /></label>
          <label>Email address<input name="contactEmail" type="email" maxLength={200} /></label>
          <label>Contact number<input name="contactPhone" maxLength={40} /></label>
          <label>Location<input name="address" maxLength={240} /></label>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Create draft'}</button></div>
      </form>
    </>
  );
}

function PartnerPanel({ partner: p, onChanged }: { partner: StaffPartner; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
    void run(() => api.updatePartner(p.id, { name: text('name'), category: text('category'), area: text('area'), website: text('website') || null, summary: text('summary'), description: text('description'), offer: text('offer'), contactName: text('contactName'), contactEmail: text('contactEmail'), contactPhone: text('contactPhone'), address: text('address') }), () => { setEditing(false); onChanged(); });
  }

  function addPrivilege(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
    void run(() => api.createPrivilege(p.id, { title: text('title'), details: text('details'), terms: text('terms'), usesPerMember: Number(f.get('uses')), validUntil: text('until') || null }), () => { form.reset(); onChanged(); });
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>{p.name}</h2><span className="muted">{p.category}{p.area ? `. ${p.area}` : ''}</span></div>
        <div className="row">
          <span className={`chip ${tone(p.status)}`}>{STATUS[p.status]}</span>
          <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
          {p.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updatePartner(p.id, { status: 'published' }), onChanged)}>Publish</button> : null}
          {p.status === 'published' ? <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updatePartner(p.id, { status: 'draft' }), onChanged)}>Unpublish</button> : null}
          {p.status !== 'archived' ? <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm(`Archive ${p.name}? Members will no longer see it.`)) void run(() => api.updatePartner(p.id, { status: 'archived' }), onChanged); }}>Archive</button> : null}
        </div>
      </div>
      {editing ? (
        <form onSubmit={save} style={{ display: 'grid', gap: 12 }} aria-label={`Edit ${p.name}`}>
          <div className="form">
            <label>Name<input name="name" required minLength={2} maxLength={120} defaultValue={p.name} /></label>
            <label>Category<input name="category" required minLength={2} maxLength={60} defaultValue={p.category} /></label>
            <label>Area<input name="area" maxLength={120} defaultValue={p.area} /></label>
            <label>Website (optional)<input name="website" type="url" placeholder="https://" defaultValue={p.website ?? ''} /></label>
          </div>
          <label>One-line description<input name="summary" maxLength={240} defaultValue={p.summary} /></label>
          <label>About the partner<textarea name="description" maxLength={4000} rows={4} defaultValue={p.description} /></label>
          <label>What they offer<textarea name="offer" maxLength={1000} rows={2} defaultValue={p.offer} /></label>
          <div className="form">
            <label>Focal point (who to ask for)<input name="contactName" maxLength={120} defaultValue={p.contactName} /></label>
            <label>Email address<input name="contactEmail" type="email" maxLength={200} defaultValue={p.contactEmail} /></label>
            <label>Contact number<input name="contactPhone" maxLength={40} defaultValue={p.contactPhone} /></label>
            <label>Location<input name="address" maxLength={240} defaultValue={p.address} /></label>
          </div>
          <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : <p className="muted">{p.summary || 'No description yet.'}{p.contactName || p.contactEmail || p.contactPhone ? ` Focal point: ${[p.contactName, p.contactEmail, p.contactPhone].filter(Boolean).join(', ')}.` : ' No focal point yet.'}{p.address ? ` ${p.address}.` : ''}</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {p.privileges.length ? (
        <div className="scroll"><table>
          <thead><tr><th>Privilege</th><th>Limit</th><th>Until</th><th>Codes issued</th><th>Status</th><th></th></tr></thead>
          <tbody>{p.privileges.map((v) => <PrivilegeRow key={v.id} privilege={v} onChanged={onChanged} />)}</tbody>
        </table></div>
      ) : <p className="muted">No privileges yet.</p>}
      <form onSubmit={addPrivilege} style={{ display: 'grid', gap: 12 }}>
        <div className="form">
          <label>New privilege<input name="title" required minLength={2} maxLength={120} placeholder="A complimentary first treatment" /></label>
          <label>Uses per member (0 for no limit)<input name="uses" type="number" min={0} max={1000} required defaultValue={1} /></label>
          <label>Last day (optional)<input name="until" type="date" /></label>
        </div>
        <div className="form">
          <label>What the member receives<input name="details" maxLength={1000} /></label>
          <label>Terms<input name="terms" maxLength={1000} /></label>
        </div>
        <div><button className="btn ghost" disabled={pending}>Add as draft</button></div>
      </form>
    </div>
  );
}

function PrivilegeRow({ privilege: v, onChanged }: { privilege: StaffPrivilege; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <tr>
        <td colSpan={6}>
          <form aria-label={`Edit ${v.title}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
            void run(() => api.updatePrivilege(v.id, { title: text('title'), details: text('details'), terms: text('terms'), usesPerMember: Number(f.get('uses')), validUntil: text('until') || null }), () => { setEditing(false); onChanged(); });
          }}>
            <div className="form">
              <label>Privilege<input name="title" required minLength={2} maxLength={120} defaultValue={v.title} /></label>
              <label>Uses per member (0 for no limit)<input name="uses" type="number" min={0} max={1000} required defaultValue={v.usesPerMember} /></label>
              <label>Last day (optional)<input name="until" type="date" defaultValue={v.validUntil ?? ''} /></label>
            </div>
            <div className="form">
              <label>What the member receives<input name="details" maxLength={1000} defaultValue={v.details} /></label>
              <label>Terms<input name="terms" maxLength={1000} defaultValue={v.terms} /></label>
            </div>
            {error ? <p className="error" role="alert">{error}</p> : null}
            <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
          </form>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{v.title}<small>{v.details || 'No description'}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{v.usesPerMember === 0 ? 'No limit' : `${v.usesPerMember} per member`}</td>
      <td>{v.validUntil ?? 'No end date'}</td>
      <td>{v.totalUses}</td>
      <td><span className={`chip ${tone(v.status)}`}>{STATUS[v.status]}</span></td>
      <td className="row">
        <button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>
        {v.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updatePrivilege(v.id, { status: 'published' }), onChanged)}>Publish</button> : null}
        {v.status === 'published' ? <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updatePrivilege(v.id, { status: 'archived' }), onChanged)}>Withdraw</button> : null}
      </td>
    </tr>
  );
}
