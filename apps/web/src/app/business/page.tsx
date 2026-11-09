'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAction, usePermission, useResource } from '@quintara/app-core';
import { BUSINESS_ROLE_LABEL, BUSINESS_ROLES, INTRODUCTION_STATUS_LABEL, LISTING_KIND_LABEL, LISTING_KINDS, listingInputSchema } from '@quintara/domain';
import type { BusinessListing, BusinessRole, Introduction, ListingInput, ListingKind } from '@quintara/domain';
import { QuintaraBusiness } from '@/components/relationship-manager';
import { ActionError, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const LISTING_STATUS: Record<BusinessListing['status'], string> = { pending: 'With the team for review', published: 'Published', declined: 'Not published', closed: 'Closed' };

export default function BusinessPage() {
  const listings = useResource((api) => api.listBusinessListings());
  const introductions = useResource((api) => api.listIntroductions());
  const canPost = usePermission('business.post');
  const intro = useSection('business');
  const reload = () => { listings.reload(); introductions.reload(); };
  return (
    <>
      <div className="head">
        <div>
          <h2>Business</h2>
          <p className="lede">{intro.description}</p>
        </div>
      </div>
      <p className="notice">Quintara introduces members to one another. It does not offer, arrange or advise on investments, and takes no part in anything members agree between themselves.</p>

      <QuintaraBusiness />

      <ResourceView resource={introductions}>
        {(list) => list.length ? (
          <section className="panel" style={{ marginBottom: '2.5rem' }}>
            <h3>Introductions</h3>
            {list.map((i) => <IntroductionItem key={i.id} introduction={i} onChanged={reload} />)}
          </section>
        ) : null}
      </ResourceView>

      <h3 style={{ fontStyle: 'italic', marginBottom: '0.6rem' }}>From members</h3>
      <ResourceView resource={listings} isEmpty={(list) => list.length === 0} empty={<p className="muted">Nothing is addressed to your role at the moment.</p>}>
        {(list) => list.map((listing) => <ListingItem key={listing.id} listing={listing} onChanged={reload} />)}
      </ResourceView>

      {canPost ? <NewListing onCreated={reload} /> : <p className="muted" style={{ marginTop: '2rem' }}>Posting is open to members the team has recognised as a founder, investor, creative or executive. Ask the concierge desk if that should include you.</p>}
    </>
  );
}

function ListingItem({ listing: l, onChanged }: { listing: BusinessListing; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const request = useAction((api) => api.requestIntroduction(l.id, note));
  const close = useAction(async (api) => { await api.closeBusinessListing(l.id); return true; });
  const open = l.myRequest === 'requested' || l.myRequest === 'offered';
  return (
    <article className="item-row plain">
      <div>
        <h3>{l.title}</h3>
        <p>{l.summary}</p>
        <div className="facts row">
          <span className="tag accent">{LISTING_KIND_LABEL[l.kind]}</span>
          {l.sector ? <span className="tag">{l.sector}</span> : null}
          <span>{l.mine ? `Shown to ${l.audience.map((role) => BUSINESS_ROLE_LABEL[role].toLowerCase()).join(', ')}.` : `${l.postedBy.fullName}, ${l.postedBy.position}, ${l.postedBy.company}.`}</span>
        </div>
        {l.mine && l.reviewNote ? <p className="notice">From the team: {l.reviewNote}</p> : null}
        {asking ? (
          <form className="stack" style={{ marginTop: '1rem' }} onSubmit={async (event) => { event.preventDefault(); if (await request.run()) { setAsking(false); onChanged(); } }}>
            <label>Why you would like to be introduced
              <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="The team reads this first, then passes it on if the introduction looks right for both of you." />
            </label>
            <ActionError error={request.error} />
            <div className="row"><button className="btn small" disabled={request.pending}>{request.pending ? 'Sending' : 'Send to the team'}</button><button type="button" className="btn quiet small" onClick={() => setAsking(false)}>Cancel</button></div>
          </form>
        ) : null}
        <ActionError error={close.error} />
      </div>
      <div className="actions">
        {l.mine ? <span className={`tag ${l.status === 'published' ? 'positive' : l.status === 'pending' ? 'accent' : ''}`}>{LISTING_STATUS[l.status]}</span> : null}
        {l.mine && (l.status === 'pending' || l.status === 'published') ? <button className="btn quiet small" disabled={close.pending} onClick={async () => { if (window.confirm('Close this listing?') && (await close.run())) onChanged(); }}>Close listing</button> : null}
        {!l.mine && l.myRequest ? <span className={`tag ${l.myRequest === 'accepted' ? 'positive' : 'accent'}`}>{INTRODUCTION_STATUS_LABEL[l.myRequest]}</span> : null}
        {!l.mine && !open && l.myRequest !== 'accepted' && !asking ? <button className="btn small" onClick={() => setAsking(true)}>Request an introduction</button> : null}
      </div>
    </article>
  );
}

function IntroductionItem({ introduction: i, onChanged }: { introduction: Introduction; onChanged: () => void }) {
  const respond = useAction((api, accept: boolean) => api.respondToIntroduction(i.id, accept));
  const withdraw = useAction(async (api) => { await api.withdrawIntroduction(i.id); return true; });
  const incoming = i.direction === 'incoming';
  return (
    <div className="panel-item" style={{ alignItems: 'flex-start' }}>
      <div>
        <strong style={{ fontWeight: 500 }}>{incoming ? `${i.with.fullName} would like to meet you` : `To ${i.with.fullName}`}</strong>
        <small>{i.with.position}, {i.with.company}.{i.listingTitle ? ` About: ${i.listingTitle}.` : ''}</small>
        {incoming ? <p style={{ margin: '0.5rem 0 0' }}>{i.note}</p> : null}
        <ActionError error={respond.error ?? withdraw.error} />
      </div>
      <div className="row">
        {incoming && i.status === 'offered' ? (
          <>
            <button className="btn small" disabled={respond.pending} onClick={async () => { if (window.confirm(`Accept the introduction to ${i.with.fullName}? You will be connected and can message each other.`) && (await respond.run(true))) onChanged(); }}>Accept</button>
            <button className="btn quiet small" disabled={respond.pending} onClick={async () => { if (await respond.run(false)) onChanged(); }}>Decline</button>
          </>
        ) : <span className={`tag ${i.status === 'accepted' ? 'positive' : i.status === 'requested' || i.status === 'offered' ? 'accent' : ''}`}>{INTRODUCTION_STATUS_LABEL[i.status]}</span>}
        {i.status === 'accepted' ? <Link className="btn quiet small" href={`/messages/${i.with.memberId}`}>Message</Link> : null}
        {!incoming && (i.status === 'requested' || i.status === 'offered') ? <button className="btn quiet small" disabled={withdraw.pending} onClick={async () => { if (await withdraw.run()) onChanged(); }}>Withdraw</button> : null}
      </div>
    </div>
  );
}

function NewListing({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<{ kind: ListingKind; title: string; summary: string; sector: string; audience: BusinessRole[] }>({ kind: 'partnership', title: '', summary: '', sector: '', audience: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const create = useAction((api, input: ListingInput) => api.createBusinessListing(input));
  const capital = form.kind === 'capital';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = listingInputSchema.safeParse({ ...form, audience: capital ? ['investor'] : form.audience });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    if (await create.run(parsed.data)) { setSent(true); setForm({ kind: 'partnership', title: '', summary: '', sector: '', audience: [] }); onCreated(); }
  }

  return (
    <section style={{ marginTop: '3rem' }}>
      <h3>Add a listing</h3>
      <p className="muted" style={{ margin: '0.6rem 0 1.2rem' }}>Say what you are looking for or can offer. The team reviews every listing before anyone else sees it. Leave out amounts, valuations and terms: those are for the conversation that follows.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="field-row">
          <label>Kind
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ListingKind })}>{LISTING_KINDS.map((k) => <option key={k} value={k}>{LISTING_KIND_LABEL[k]}</option>)}</select>
          </label>
          <label>Sector (optional)<input value={form.sector} maxLength={60} onChange={(event) => setForm({ ...form, sector: event.target.value })} /></label>
        </div>
        <label>Title
          <input value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} aria-invalid={errors.title ? true : undefined} />
          {errors.title ? <span className="field-error" role="alert">{errors.title}</span> : null}
        </label>
        <label>What you are looking for
          <textarea value={form.summary} maxLength={1200} onChange={(event) => setForm({ ...form, summary: event.target.value })} aria-invalid={errors.summary ? true : undefined} />
          {errors.summary ? <span className="field-error" role="alert">{errors.summary}</span> : null}
        </label>
        <fieldset>
          <legend>Who should see it</legend>
          {capital ? <p className="muted" style={{ margin: 0 }}>A listing about raising capital is shown only to investors the team has verified.</p> : (
            <div className="checks">
              {BUSINESS_ROLES.map((role) => (
                <label className="check" key={role}><input type="checkbox" checked={form.audience.includes(role)} onChange={(event) => setForm({ ...form, audience: event.target.checked ? [...form.audience, role] : form.audience.filter((r) => r !== role) })} /> {BUSINESS_ROLE_LABEL[role]}</label>
              ))}
            </div>
          )}
          {errors.audience ? <span className="field-error" role="alert">{errors.audience}</span> : null}
        </fieldset>
        <ActionError error={create.error} />
        {sent ? <p className="notice" role="status">Sent to the team for review. You will be told when it is published.</p> : null}
        <div><button className="btn" disabled={create.pending}>{create.pending ? 'Sending' : 'Send for review'}</button></div>
      </form>
    </section>
  );
}
