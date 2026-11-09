'use client';

import Link from 'next/link';
import { usePermission, useResource, useSession } from '@quintara/app-core';
import { formatDateTime } from '@quintara/domain';
import { DateBlock } from '@/components/experience';
import { HomeSlides } from '@/components/media';
import { Loading, ResourceView } from '@/components/states';

export default function HomePage() {
  const { status } = useSession();
  const isMember = usePermission('directory.view');
  if (status === 'loading') return <Loading />;
  return isMember ? <MemberHome /> : <VisitorHome />;
}

function VisitorHome() {
  const experiences = useResource((api) => api.listExperiences());
  return (
    <>
      <HomeSlides />
      <div className="hero">
        <div>
          <h1>The city&rsquo;s best tables, rooms and introductions, kept for people who show up.</h1>
          <p className="lede" style={{ marginTop: '1.4rem' }}>
            Quintara is a private membership for founders, investors, creatives and executives. Members book experiences and meet each other properly.
          </p>
          <div className="row">
            <Link className="btn" href="/apply">Apply for membership</Link>
            <Link className="btn quiet" href="/experiences">See experiences</Link>
          </div>
        </div>
        <div>
          <p className="muted" style={{ fontSize: '0.9rem' }}>Open to guests</p>
          <ResourceView
            resource={experiences}
            isEmpty={(list) => list.length === 0}
            empty={<p className="muted">The next season is being planned. Apply to hear first.</p>}
          >
            {(list) =>
              list.slice(0, 4).map((experience) => (
                <div className="item-row" key={experience.id}>
                  <DateBlock iso={experience.startsAt} timezone={experience.timezone} />
                  <div>
                    <strong style={{ fontWeight: 500 }}>{experience.title}</strong>
                    <div className="muted">{experience.area}</div>
                  </div>
                  <Link className="btn quiet small" href={`/experiences/${experience.id}`}>View</Link>
                </div>
              ))
            }
          </ResourceView>
        </div>
      </div>
    </>
  );
}

function MemberHome() {
  const { session } = useSession();
  const home = useResource(async (api) => {
    const [experiences, bookings, notifications] = await Promise.all([api.listExperiences(), api.listBookings(), api.listNotifications()]);
    return { experiences, bookings, notifications };
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <h1>{greeting}, {session?.fullName.split(' ')[0]}.</h1>
      <ResourceView resource={home}>
        {({ experiences, bookings, notifications }) => {
          const live = bookings.filter((b) => b.status === 'confirmed' || b.status === 'applied' || b.status === 'waitlisted');
          const bookedIds = new Set(live.map((b) => b.experienceId));
          const invitations = experiences.filter((e) => e.invited && !bookedIds.has(e.id));
          const suggestions = experiences.filter((e) => !e.invited && !bookedIds.has(e.id)).slice(0, 3);
          const unread = notifications.filter((n) => !n.readAt);
          return (
            <div className="panels">
              <section className="panel">
                <h3>Invitations</h3>
                {invitations.length === 0 ? <p className="muted" style={{ paddingTop: '0.8rem' }}>No open invitations.</p> : null}
                {invitations.map((e) => (
                  <div className="panel-item" key={e.id}>
                    <div><strong style={{ fontWeight: 500 }}>{e.title}</strong><small>{e.startsAt ? `${formatDateTime(e.startsAt, e.timezone).long}, ` : ''}{e.area}</small></div>
                    <Link className="btn small" href={`/experiences/${e.id}`}>Open invitation</Link>
                  </div>
                ))}
              </section>
              <section className="panel">
                <h3>Your bookings</h3>
                {live.length === 0 ? <p className="muted" style={{ paddingTop: '0.8rem' }}>Nothing booked yet. <Link href="/experiences">Browse experiences</Link></p> : null}
                {live.slice(0, 3).map((b) => (
                  <div className="panel-item" key={b.id}>
                    <div><strong style={{ fontWeight: 500 }}>{b.experienceTitle}</strong><small>{formatDateTime(b.startsAt, b.timezone).long}. {b.seats} seat{b.seats > 1 ? 's' : ''}.</small></div>
                    <Link className="btn quiet small" href="/bookings">View</Link>
                  </div>
                ))}
              </section>
              <section className="panel">
                <h3>Chosen for you</h3>
                {suggestions.length === 0 ? <p className="muted" style={{ paddingTop: '0.8rem' }}>You have seen everything on the calendar.</p> : null}
                {suggestions.map((e) => (
                  <div className="panel-item" key={e.id}>
                    <div><strong style={{ fontWeight: 500 }}>{e.title}</strong><small>{e.category}{e.startsAt ? `. ${formatDateTime(e.startsAt, e.timezone).long}` : ''}</small></div>
                    <Link className="btn quiet small" href={`/experiences/${e.id}`}>View</Link>
                  </div>
                ))}
              </section>
              <section className="panel">
                <h3>Notifications</h3>
                {unread.length === 0 ? <p className="muted" style={{ paddingTop: '0.8rem' }}>You are up to date.</p> : null}
                {unread.slice(0, 3).map((n) => (
                  <div className="panel-item" key={n.id}><div>{n.title}</div></div>
                ))}
                {unread.length > 0 ? <p style={{ marginTop: '0.8rem' }}><Link href="/notifications">See all notifications</Link></p> : null}
              </section>
            </div>
          );
        }}
      </ResourceView>
    </>
  );
}
