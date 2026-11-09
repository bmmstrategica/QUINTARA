'use client';

import Link from 'next/link';
import { Loaded, useCan, useLoad } from '@/lib/admin';

export default function OverviewPage() {
  const canReview = useCan('admin.applications.review');
  const state = useLoad(async (api) => {
    const [experiences, applications, members] = await Promise.all([api.listExperiences(), canReview ? api.listApplications() : Promise.resolve([]), canReview ? api.listMembers() : Promise.resolve([])]);
    return { experiences, applications, members };
  }, [canReview]);
  return (
    <>
      <div><h1>Today at Quintara</h1><p className="lede">What you do here reaches members straight away.</p></div>
      <Loaded state={state}>
        {({ experiences, applications, members }) => {
          const open = applications.filter((a) => ['submitted', 'under_review', 'interview'].includes(a.status)).length;
          const published = experiences.filter((e) => e.status === 'published');
          return (
            <div className="stats">
              {canReview ? <Link className="panel stat" href="/applications"><b>{open}</b><span className="muted">Applications to review</span></Link> : null}
              {canReview ? <Link className="panel stat" href="/members"><b>{members.filter((m) => m.status === 'active').length}</b><span className="muted">Active members</span></Link> : null}
              <Link className="panel stat" href="/experiences"><b>{published.length}</b><span className="muted">Published experiences</span></Link>
              <Link className="panel stat" href="/experiences"><b>{published.filter((e) => e.seatsTaken >= e.capacity).length}</b><span className="muted">Experiences that are full</span></Link>
            </div>
          );
        }}
      </Loaded>
    </>
  );
}
