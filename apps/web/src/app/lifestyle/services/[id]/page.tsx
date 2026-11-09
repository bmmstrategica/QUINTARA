'use client';

/** A service in the directory: who they are, where, what they offer, who to ask for (members), packages and a request to book. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useResource, useSession } from '@quintara/app-core';
import { ServiceItem } from '@/components/lifestyle-services';
import { ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

export default function ServicePage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useSession();
  const intro = useSection('services');
  const service = useResource((api) => api.getLifestyleService(id), [id, Boolean(session)]);
  return (
    <>
      <p><Link href="/lifestyle" className="muted">The directory</Link></p>
      <ResourceView resource={service}>
        {(x) => (
          <>
            <div className="cover">
              <div className="row"><span className="tag">Service</span><span className="tag">{x.category}</span>{x.area ? <span className="tag">{x.area}</span> : null}</div>
              <h1>{x.name}</h1>
              {x.summary ? <p className="lede" style={{ margin: 0 }}>{x.summary}</p> : null}
            </div>
            <div className="detail">
              <div>
                {x.description ? <p>{x.description}</p> : null}
                <h3>Packages</h3>
                <p className="muted" style={{ margin: '0.6rem 0 0' }}>{intro.description}</p>
                <ServiceItem service={x} isMember={Boolean(session)} onRequested={service.reload} detail />
              </div>
              <aside className="aside">
                <dl>
                  <dt>Category</dt><dd>{x.category}</dd>
                  {x.address || x.area ? <><dt>Location</dt><dd>{x.address || x.area}</dd></> : null}
                  {x.offer ? <><dt>They offer</dt><dd>{x.offer}</dd></> : null}
                  {x.contactName ? <><dt>Focal point</dt><dd>{x.contactName}</dd></> : null}
                  {x.contactEmail ? <><dt>Email</dt><dd><a href={`mailto:${x.contactEmail}`}>{x.contactEmail}</a></dd></> : null}
                  {x.contactPhone ? <><dt>Contact</dt><dd><a href={`tel:${x.contactPhone.replace(/[^0-9+]/g, '')}`}>{x.contactPhone}</a></dd></> : null}
                  {x.website ? <><dt>Website</dt><dd><a href={x.website} target="_blank" rel="noopener noreferrer">{new URL(x.website).hostname}</a></dd></> : null}
                </dl>
                <p className="muted" style={{ fontSize: '0.9rem' }}>{session ? 'Requests go to the Quintara concierge desk, who arrange it with the provider.' : 'Members also see who to ask for and how to reach them.'}</p>
              </aside>
            </div>
          </>
        )}
      </ResourceView>
    </>
  );
}
