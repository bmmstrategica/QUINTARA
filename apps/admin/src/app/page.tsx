'use client';

/**
 * The Overview: the figures and the work waiting in the city being worked in, counted by the API when the page is
 * opened (GET /admin/v1/dashboard). Each section appears only for roles that may see it, and links to where the work is done.
 */
import Link from 'next/link';
import type { StaffDashboard } from '@quintara/api-client';
import { fmtAmount as money, fmtDate, Loaded, useLoad } from '@/lib/admin';

/** "up 12% on the 30 days before", or nothing when there is nothing to compare with. */
const change = (now: number, before: number) => {
  if (!before) return now ? 'New this period' : 'No change';
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? 'Level with the 30 days before' : `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct)}% on the 30 days before`;
};

function Stat({ href, value, label, detail }: { href: string; value: string | number; label: string; detail?: string }) {
  return <Link className="panel stat" href={href}><b>{value}</b><span className="muted">{label}</span>{detail ? <small className="muted">{detail}</small> : null}</Link>;
}

export default function OverviewPage() {
  const state = useLoad((api) => api.getDashboard());
  return (
    <>
      <div><p className="eyebrow">Admin console</p><h1>Today at Quintara</h1><p className="lede">What you do here appears in the member apps straight away.</p></div>
      <Loaded state={state}>{(d) => <Overview d={d} />}</Loaded>
    </>
  );
}

function Overview({ d }: { d: StaffDashboard }) {
  const nothing = !d.business && !d.membership && !d.experiences && !d.concierge && !d.maison;
  // As the design: what is waiting today, then what needs someone's attention. Each figure only for the roles it concerns.
  const today: [href: string, value: string | number, label: string][] = [
    ...(d.membership ? [['/applications', d.membership.applicationsToReview, 'Applications to review'] as [string, number, string]] : []),
    ...(d.concierge ? [['/concierge', d.concierge.openRequests, 'Requests awaiting the desk'] as [string, number, string]] : []),
    ...(d.experiences ? [['/experiences', d.experiences.awaitingDecision, 'Bookings awaiting a decision'] as [string, number, string]] : []),
    ...(d.maison ? [['/orders', d.maison.toProcess + d.maison.preparing, 'Orders to dispatch'] as [string, number, string]] : []),
    ...(d.membership ? [['/members', d.membership.activeMembers, 'Active members'] as [string, number, string]] : []),
    ...(d.business ? [['/payments', money(d.business.revenueMinor, d.market.currency), 'Received, last 30 days'] as [string, string, string]] : []),
  ];
  return (
    <>
      {today.length ? <div className="stats">{today.map(([href, value, label]) => <Stat key={label} href={href} value={value} label={label} />)}</div> : null}
      {today.length ? (
        <>
          <h2>Needs attention</h2>
          {d.attention.length ? (
            <div className="list">{d.attention.map((x, i) => (
              <Link key={`${x.href}-${i}`} className="list-row link" href={x.href}>
                <span className="lead" aria-hidden="true"><AttentionIcon kind={x.kind} /></span>
                <span className="txt"><b>{x.title}</b><span>{x.detail}</span></span>
              </Link>
            ))}</div>
          ) : <p className="note">Nothing is waiting on you.</p>}
        </>
      ) : null}

      {d.business ? (
        <>
          <h2>The last 30 days in {d.market.name}</h2>
          <div className="stats">
            <Stat href="/insights" value={money(d.business.revenueMinor, d.market.currency)} label="Revenue received" detail={change(d.business.revenueMinor, d.business.revenuePrevMinor)} />
            <Stat href="/insights" value={d.business.newMembers} label="Members joined" detail={change(d.business.newMembers, d.business.newMembersPrev)} />
            <Stat href="/insights" value={d.business.bookings} label="Experience bookings" detail={change(d.business.bookings, d.business.bookingsPrev)} />
            <Stat href="/insights" value={d.business.orders} label="Maison Quintara orders" detail={change(d.business.orders, d.business.ordersPrev)} />
          </div>
          {d.business.revenueBySource.length ? (
            <p className="note">{d.business.revenueBySource.map((s) => `${s.label} ${money(s.totalMinor, d.market.currency)}`).join(' · ')}</p>
          ) : <p className="note">No payments were received in these 30 days.</p>}
        </>
      ) : null}

      {d.membership ? (
        <>
          <h2>Membership</h2>
          <div className="stats">
            <Stat href="/applications" value={d.membership.applicationsToReview} label="Applications to review" />
            <Stat href="/members" value={d.membership.activeMembers} label="Active members" detail={d.membership.suspendedMembers ? `${d.membership.suspendedMembers} suspended` : undefined} />
            <Stat href="/applications" value={d.membership.awaitingPayment} label="Approved, awaiting payment" />
            <Stat href="/members" value={d.membership.renewalsDue30} label="Terms ending in 30 days" />
          </div>
        </>
      ) : null}

      {d.experiences ? (
        <>
          <h2>Experiences</h2>
          <div className="stats">
            <Stat href="/experiences" value={d.experiences.upcoming} label="Upcoming experiences" />
            <Stat href="/experiences" value={`${d.experiences.seatsBooked} / ${d.experiences.seatsTotal}`} label="Seats taken" />
            <Stat href="/experiences" value={d.experiences.full} label="Experiences that are full" />
            <Stat href="/experiences" value={d.experiences.awaitingDecision} label="Bookings waiting for a decision" detail="Applied or on the waiting list" />
          </div>
          {d.experiences.next.length ? (
            <div className="scroll"><table>
              <thead><tr><th>Coming up</th><th>When</th><th>Seats</th></tr></thead>
              <tbody>{d.experiences.next.map((e) => (
                <tr key={e.id}><td><Link href={`/experiences/${e.id}`}>{e.title}</Link></td><td>{fmtDate(e.startsAt)}</td><td>{e.seatsTaken} of {e.capacity}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <p className="note">No experiences are published for the coming weeks.</p>}
        </>
      ) : null}

      {d.concierge ? (
        <>
          <h2>Concierge</h2>
          <div className="stats">
            <Stat href="/concierge" value={d.concierge.newRequests} label="New requests" detail={`${d.concierge.openRequests} open in all`} />
            <Stat href="/services" value={d.concierge.openServiceRequests} label="Service requests to arrange" />
            <Stat href="/services" value={d.concierge.partnerBookingsWaiting} label="Partner bookings awaiting an answer" />
          </div>
        </>
      ) : null}

      {d.maison ? (
        <>
          <h2>Maison Quintara</h2>
          <div className="stats">
            <Stat href="/orders" value={d.maison.toProcess} label="Paid orders to process" />
            <Stat href="/orders" value={d.maison.preparing} label="Being prepared" />
            <Stat href="/orders" value={d.maison.withCourier} label="With the courier" />
          </div>
        </>
      ) : null}

      {nothing ? <p className="note">Your role has no figures on this page. Use the menu to reach your work.</p> : null}
    </>
  );
}

/** The design's marks: a person for an application, the desk bell for a request, the calendar for a booking. */
function AttentionIcon({ kind }: { kind: StaffDashboard['attention'][number]['kind'] }) {
  if (kind === 'application') return <svg className="ic" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c.4-3.9 3.2-6.4 7-6.4s6.6 2.5 7 6.4" /></svg>;
  if (kind === 'request') return <svg className="ic" viewBox="0 0 24 24"><path d="M4 17h16M6 17a6 6 0 0 1 12 0M12 8V6.5M10 6.5h4" /></svg>;
  return <svg className="ic" viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14.5" rx="1.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></svg>;
}
