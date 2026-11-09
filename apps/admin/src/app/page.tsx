'use client';

/**
 * The Overview: the figures and the work waiting in the city being worked in, counted by the API when the page is
 * opened (GET /admin/v1/dashboard). Each section appears only for roles that may see it, and links to where the work is done.
 */
import Link from 'next/link';
import type { StaffDashboard } from '@quintara/api-client';
import { fmtDate, Loaded, useLoad } from '@/lib/admin';

const money = (minor: number, currency: string) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: currency || 'ZAR', maximumFractionDigits: 0 }).format(minor / 100);
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
      <div><h1>Today at Quintara</h1><p className="lede">What you do here reaches members straight away.</p></div>
      <Loaded state={state}>{(d) => <Overview d={d} />}</Loaded>
    </>
  );
}

function Overview({ d }: { d: StaffDashboard }) {
  const nothing = !d.business && !d.membership && !d.experiences && !d.concierge && !d.maison;
  return (
    <>
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
