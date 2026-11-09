'use client';

import Link from 'next/link';
import { usePermission, useResource, useSession } from '@quintara/app-core';
import { LifestyleCurator, LifestyleDirectory } from '@/components/lifestyle-services';
import { Loading, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

/** Lifestyle: the Lifestyle Curator, the partners and services directory, and (for members) the codes they have redeemed. */
export default function LifestylePage() {
  const { status } = useSession();
  const isMember = usePermission('privileges.use');
  const life = useSection('lifestyle');
  if (status === 'loading') return <Loading />;
  return (
    <>
      <div className="head">
        <div><h2>Lifestyle</h2><p className="lede">{isMember ? life.description : 'Services you can ask Quintara to arrange. Members also have the partners in the directory, and their privileges.'}</p></div>
        {isMember ? null : <Link className="btn quiet" href="/apply">Apply for membership</Link>}
      </div>
      <LifestyleCurator />
      <LifestyleDirectory isMember={isMember} />
      {isMember ? <YourCodes /> : null}
    </>
  );
}

function YourCodes() {
  const redemptions = useResource((api) => api.listMyRedemptions());
  return (
    <section className="panel" style={{ marginTop: '2.5rem' }}>
      <h3>Your codes</h3>
      <ResourceView resource={redemptions} isEmpty={(list) => list.length === 0} empty={<p className="muted" style={{ paddingTop: '0.8rem' }}>Codes you redeem appear here.</p>}>
        {(list) => list.map((r) => (
          <div className="panel-item" key={r.id}>
            <div><strong style={{ fontWeight: 500 }}>{r.privilegeTitle}</strong><small>{r.partnerName}. {new Date(r.redeemedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}.</small></div>
            <span className="tag accent">{r.code}</span>
          </div>
        ))}
      </ResourceView>
    </section>
  );
}
