'use client';

import { Avatar } from '@/components/media';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { REPORT_REASON_LABELS, REPORT_REASONS } from '@quintara/domain';
import type { MemberProfile, ReportReason } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

export default function MemberPage() {
  const { id } = useParams<{ id: string }>();
  const member = useResource((api) => api.getMember(id), [id]);
  return (
    <>
      <p><Link href="/members" className="muted">All members</Link></p>
      <ResourceView resource={member}>{(profile) => <Profile profile={profile} onChanged={member.reload} />}</ResourceView>
    </>
  );
}

function Profile({ profile, onChanged }: { profile: MemberProfile; onChanged: () => void }) {
  const connect = useAction((api) => api.requestConnection(profile.id));
  const act = async () => { if (await connect.run()) onChanged(); };
  return (
    <div className="split">
      <div className="stack">
        <div className="row" style={{ gap: '1rem' }}><Avatar name={profile.fullName} path={profile.avatarPath} size={72} /><h2>{profile.fullName}</h2></div>
        <p>{profile.position}, {profile.company}</p>
        <div className="row">{profile.roles.filter((role) => role !== 'member').map((role) => <span className="tag" key={role}>{role[0]?.toUpperCase() + role.slice(1)}</span>)}</div>
        <ActionError error={connect.error} />
        <div className="row">
          {profile.connection === 'none' ? <button className="btn" disabled={connect.pending} onClick={act}>{connect.pending ? 'Sending' : 'Connect'}</button> : null}
          {profile.connection === 'incoming' ? <button className="btn" disabled={connect.pending} onClick={act}>{connect.pending ? 'Accepting' : 'Accept connection'}</button> : null}
          {profile.connection === 'requested' ? <span className="tag accent">Connection requested</span> : null}
          {profile.connection === 'connected' ? <><span className="tag positive">Connected</span><Link className="btn" href={`/messages/${profile.id}`}>Send a message</Link></> : null}
        </div>
        <p className="muted" style={{ fontSize: '0.9rem' }}>Messaging opens once you are connected.</p>
      </div>
      <div>
        <p className="lede">{profile.biography}</p>
        <dl>
          <dt>Industry</dt><dd>{profile.industry}</dd>
          <dt>Location</dt><dd>{profile.city}</dd>
          <dt>Interests</dt><dd>{profile.interests.join(', ') || 'Not said'}</dd>
          <dt>Looking for</dt><dd>{profile.lookingFor || 'Not said'}</dd>
          <dt>Can offer</dt><dd>{profile.canOffer || 'Not said'}</dd>
        </dl>
        <Safety profile={profile} />
      </div>
    </div>
  );
}

/** Report a concern to staff, or block this member. Both are private to the member who does them. */
function Safety({ profile }: { profile: MemberProfile }) {
  const router = useRouter();
  const [reason, setReason] = useState<ReportReason>('unwanted_contact');
  const [detail, setDetail] = useState('');
  const [sent, setSent] = useState(false);
  const report = useAction(async (api) => { await api.reportMember(profile.id, { reason, detail }); return true; });
  const block = useAction(async (api) => { await api.blockMember(profile.id); return true; });
  const first = profile.fullName.split(' ')[0];
  return (
    <details style={{ marginTop: '1.5rem' }}>
      <summary>Safety</summary>
      {sent ? <p role="status">Your report is with the Quintara team. {first} is not told who reported them.</p> : (
        <form className="stack" style={{ maxWidth: '26rem', marginTop: '0.75rem' }} onSubmit={async (event) => { event.preventDefault(); if (await report.run()) setSent(true); }}>
          <label>Report a concern
            <select value={reason} onChange={(event) => setReason(event.target.value as ReportReason)}>
              {REPORT_REASONS.map((key) => <option key={key} value={key}>{REPORT_REASON_LABELS[key]}</option>)}
            </select>
          </label>
          <label>What happened (optional)<textarea value={detail} maxLength={1000} onChange={(event) => setDetail(event.target.value)} /></label>
          <ActionError error={report.error} />
          <div className="row"><button className="btn" disabled={report.pending}>{report.pending ? 'Sending' : 'Send report'}</button></div>
        </form>
      )}
      <ActionError error={block.error} />
      <p className="muted" style={{ fontSize: '0.9rem' }}>Blocking hides you from each other and ends any connection. {first} is not notified.</p>
      <button className="btn" disabled={block.pending} onClick={async () => { if (window.confirm(`Block ${profile.fullName}?`) && (await block.run())) router.push('/members'); }}>{block.pending ? 'Blocking' : `Block ${first}`}</button>
    </details>
  );
}
