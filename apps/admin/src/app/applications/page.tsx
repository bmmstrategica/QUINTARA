'use client';

import { useState } from 'react';
import type { StaffApplication, StaffTier } from '@quintara/api-client';
import { APPLICATION_STATUS_LABEL, formatHandle, SOCIAL_PLATFORM_LABEL, socialProfileUrl } from '@quintara/domain';
import type { CustomQuestion } from '@quintara/domain';
import { fmtMoney, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const OPEN = ['submitted', 'under_review', 'interview', 'waitlisted'];

export default function ApplicationsPage() {
  const state = useLoad(async (api) => {
    const [applications, tiers, questions] = await Promise.all([api.listApplications(), api.listTiers(), api.listApplicationQuestions()]);
    return { applications, tiers, questions };
  });
  return (
    <>
      <div><h1>Applications</h1><p className="lede">Applicants are told they are on the waiting list. Approval offers the membership they applied for, or another you choose, and asks them to proceed with payment. Payment activates the membership.</p></div>
      <Loaded state={state}>
        {({ applications, tiers, questions }) =>
          applications.length === 0 ? <p className="note">No applications yet. They appear here as soon as someone applies.</p> : (
            <div className="grid">{applications.map((a) => <ApplicationCard key={a.id} application={a} tiers={tiers} questions={questions.custom} onChanged={state.reload} />)}</div>
          )}
      </Loaded>
    </>
  );
}

function ApplicationCard({ application: a, tiers, questions, onChanged }: { application: StaffApplication; tiers: StaffTier[]; questions: CustomQuestion[]; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  // The membership the applicant asked for is offered unless staff choose another.
  const [tierId, setTierId] = useState(a.requestedTier && tiers.some((t) => t.id === a.requestedTier!.id) ? a.requestedTier.id : tiers[0]?.id ?? '');
  const answers = Object.entries(a.data.answers ?? {}).filter(([, value]) => (Array.isArray(value) ? value.length : String(value).trim()));
  const open = OPEN.includes(a.status);
  const review = (status: 'under_review' | 'interview' | 'waitlisted' | 'declined') => run(() => api.reviewApplication(a.id, status), onChanged);
  return (
    <article className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><strong style={{ fontWeight: 500 }}>{a.data.fullName}</strong><div className="muted">{a.data.position}{a.data.company ? `, ${a.data.company}` : ''}. {a.data.city}.</div></div>
        <span className={`chip ${a.status === 'active' ? 'ok' : open || a.status === 'payment_pending' ? 'gold' : ''}`}>{APPLICATION_STATUS_LABEL[a.status]}</span>
      </div>
      <div style={{ fontSize: 13 }}>
        <span className="muted">Applying for: </span>{a.requestedTier ? `${a.requestedTier.name}, ${fmtMoney(a.requestedTier.priceMinor, a.requestedTier.currency)}` : 'Not chosen'}
        {a.data.phone ? <><span className="muted">. Phone: </span><a href={`tel:${a.data.phone.replace(/[^+0-9]/g, '')}`}>{a.data.phone}</a></> : null}
      </div>
      <p className="note">{a.data.motivation}</p>
      {answers.length ? (
        <dl className="answers" style={{ fontSize: 13, margin: 0 }}>
          {answers.map(([id, value]) => <div key={id}><dt className="muted">{questions.find((q) => q.id === id)?.label ?? 'A question since removed'}</dt><dd style={{ margin: 0 }}>{Array.isArray(value) ? value.join(', ') : value}</dd></div>)}
        </dl>
      ) : null}
      <SocialHandle application={a} />
      <div className="muted" style={{ fontSize: 13 }}>
        {a.email}{a.data.referral ? `. Referral: ${a.data.referral}` : ''}{a.data.asFounder ? '. Applying as a founder' : ''}{a.data.asInvestor ? '. Asks for investor access' : ''}
        {a.offeredTierName ? `. Offered: ${a.offeredTierName}` : ''}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {open ? (
        <>
          <div className="row">
            {a.status === 'submitted' ? <button className="btn" disabled={pending} onClick={() => review('under_review')}>Start review</button> : null}
            {a.status === 'under_review' ? <button className="btn ghost" disabled={pending} onClick={() => review('interview')}>Invite to interview</button> : null}
            {a.status !== 'waitlisted' ? <button className="btn ghost" disabled={pending} onClick={() => review('waitlisted')}>Waitlist</button> : null}
            <button className="btn ghost" disabled={pending} onClick={() => review('declined')}>Decline</button>
          </div>
          <div className="row">
            <select className="small" aria-label="Tier to offer" value={tierId} onChange={(event) => setTierId(event.target.value)}>
              {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}, {fmtMoney(t.priceMinor, t.currency)}{t.id === a.requestedTier?.id ? ' (applied for)' : ''}</option>)}
            </select>
            <button className="btn" disabled={pending || !tierId} onClick={() => { const t = tiers.find((x) => x.id === tierId); if (window.confirm(`Approve ${a.data.fullName} for ${t?.name ?? 'this membership'}? They are asked to proceed with payment.`)) void run(() => api.approveApplication(a.id, tierId), onChanged); }}>Approve</button>
          </div>
        </>
      ) : a.status === 'payment_pending' ? <p className="muted" style={{ fontSize: 13 }}>Waiting for the applicant to pay.</p> : null}
    </article>
  );
}

/** The applicant's social media handle, linked to the public profile so staff can look before deciding. */
function SocialHandle({ application: a }: { application: StaffApplication }) {
  const platform = a.data.socialPlatform ?? 'instagram', handle = a.data.socialHandle ?? '';
  if (!handle) return <div className="muted" style={{ fontSize: 13 }}>Social media: not given</div>;
  const url = socialProfileUrl(platform, handle);
  return (
    <div style={{ fontSize: 13 }}>
      <span className="muted">{SOCIAL_PLATFORM_LABEL[platform] ?? 'Social media'}: </span>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer nofollow">{formatHandle(handle)}</a> : formatHandle(handle)}
    </div>
  );
}
