'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import type { Privilege, Redemption } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

export default function PartnerPage() {
  const { id } = useParams<{ id: string }>();
  const partner = useResource((api) => api.getPartner(id), [id]);
  return (
    <>
      <p><Link href="/lifestyle" className="muted">All partners</Link></p>
      <ResourceView resource={partner}>
        {(p) => (
          <>
            <div className="cover">
              <div className="row"><span className="tag">{p.category}</span>{p.area ? <span className="tag">{p.area}</span> : null}</div>
              <h1>{p.name}</h1>
              <p className="lede" style={{ margin: 0 }}>{p.summary}</p>
            </div>
            <div className="detail">
              <div>
                {p.description ? <p>{p.description}</p> : null}
                <h3>Privileges for members</h3>
                {p.privileges.length === 0 ? <p className="muted" style={{ marginTop: '0.8rem' }}>Nothing on offer at the moment.</p> : null}
                {p.privileges.map((privilege) => <PrivilegeItem key={privilege.id} privilege={privilege} partnerName={p.name} />)}
              </div>
              <aside className="aside">
                <dl>
                  <dt>Category</dt><dd>{p.category}</dd>
                  {p.address || p.area ? <><dt>Location</dt><dd>{p.address || p.area}</dd></> : null}
                  {p.offer ? <><dt>They offer</dt><dd>{p.offer}</dd></> : null}
                  {p.contactName ? <><dt>Focal point</dt><dd>{p.contactName}</dd></> : null}
                  {p.contactEmail ? <><dt>Email</dt><dd><a href={`mailto:${p.contactEmail}`}>{p.contactEmail}</a></dd></> : null}
                  {p.contactPhone ? <><dt>Contact</dt><dd><a href={`tel:${p.contactPhone.replace(/[^0-9+]/g, '')}`}>{p.contactPhone}</a></dd></> : null}
                  {p.website ? <><dt>Website</dt><dd><a href={p.website} target="_blank" rel="noopener noreferrer">{new URL(p.website).hostname}</a></dd></> : null}
                </dl>
                <p className="muted" style={{ fontSize: '0.9rem' }}>Quintara shares nothing about you with a partner. The code is your proof of membership.</p>
              </aside>
            </div>
          </>
        )}
      </ResourceView>
    </>
  );
}

function PrivilegeItem({ privilege: v, partnerName }: { privilege: Privilege; partnerName: string }) {
  const redeem = useAction((api) => api.redeemPrivilege(v.id));
  const [issued, setIssued] = useState<Redemption | null>(null);
  const ended = Boolean(v.validUntil && v.validUntil < new Date().toISOString().slice(0, 10));
  const limit = v.usesPerMember === 0 ? 'No limit on use' : v.usesPerMember === 1 ? 'Once per member' : `${v.usesPerMember} times per member, ${v.myUses} used`;
  return (
    <div className="item-row plain">
      <div>
        <h3 style={{ fontSize: '1.2rem' }}>{v.title}</h3>
        <p>{v.details}</p>
        <div className="facts muted">{limit}.{v.validUntil ? ` Until ${new Date(v.validUntil).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}.` : ''} {v.terms}</div>
        {issued ? <p className="notice" role="status">Your code is <strong>{issued.code}</strong>. Show it at {partnerName}. It is also kept under Lifestyle.</p> : null}
        <ActionError error={redeem.error} />
      </div>
      <div className="actions">
        {ended ? <span className="tag">Ended</span> : !v.available && !issued ? <span className="tag positive">Used</span> : null}
        {v.available && !issued ? (
          <button className="btn small" disabled={redeem.pending} onClick={async () => {
            if (v.usesPerMember > 0 && !window.confirm(`Use "${v.title}" now? This counts as one of your uses.`)) return;
            const result = await redeem.run();
            if (result) setIssued(result);   // the page is not reloaded, so the code stays on screen
          }}>{redeem.pending ? 'Preparing' : 'Get my code'}</button>
        ) : null}
      </div>
    </div>
  );
}
