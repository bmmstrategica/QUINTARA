/**
 * The admin console's Overview: the figures and the work waiting, for the city staff are working in.
 *
 * - Every number is counted from the database when the page is opened; nothing is stored or typed in.
 * - Each section is included only for staff whose role may see it (the same permissions as the pages it links to),
 *   so the Overview never shows a figure its viewer could not find elsewhere in the console.
 * - Counts and totals only: no member is named.
 * - Business figures (revenue, members joining, bookings, orders over the last 30 days against the 30 before) come from
 *   Insights (`insightsFor`), so the Overview and Insights always agree.
 */
import { staffCan, staffCanAny } from '@quintara/domain';
import { requireAnyStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Queryable } from './db.ts';
import { insightsFor } from './insights.ts';

export interface Dashboard {
  market: { name: string; currency: string };
  /** Last 30 days against the 30 before (Insights' figures). */
  business: null | {
    revenueMinor: number; revenuePrevMinor: number; activeMembers: number; newMembers: number; newMembersPrev: number;
    bookings: number; bookingsPrev: number; orders: number; ordersPrev: number;
    revenueBySource: { label: string; totalMinor: number }[];
  };
  membership: null | { activeMembers: number; suspendedMembers: number; applicationsToReview: number; awaitingPayment: number; renewalsDue30: number };
  experiences: null | {
    upcoming: number; full: number; seatsBooked: number; seatsTotal: number; awaitingDecision: number;
    next: { id: string; title: string; startsAt: string; seatsTaken: number; capacity: number }[];
  };
  concierge: null | { openRequests: number; newRequests: number; openServiceRequests: number; partnerBookingsWaiting: number };
  maison: null | { toProcess: number; preparing: number; withCourier: number };
  generatedAt: string;
}

const num = async (db: Queryable, sql: string, params: unknown[]) => Number((await db.query<{ n: string | number | null }>(sql, params))[0]?.n ?? 0);

export async function getDashboard(db: Queryable, ctx: RequestContext): Promise<Dashboard> {
  requireAnyStaff(ctx);
  const roles = ctx.staffRoles, m = ctx.marketId, P = [m];
  const market = (await db.query<{ name: string; currency_code: string }>('SELECT name, currency_code FROM markets WHERE id = $1', P))[0];

  let business: Dashboard['business'] = null;
  if (staffCan(roles, 'admin.insights.view')) {
    const { headline: h, revenueBySource } = await insightsFor(db, m, '30d');
    business = {
      revenueMinor: h.revenueMinor, revenuePrevMinor: h.revenuePrevMinor, activeMembers: h.activeMembers, newMembers: h.newMembers, newMembersPrev: h.newMembersPrev,
      bookings: h.bookings, bookingsPrev: h.bookingsPrev, orders: h.orders, ordersPrev: h.ordersPrev,
      revenueBySource: revenueBySource.filter((s) => s.totalMinor > 0).map((s) => ({ label: s.label, totalMinor: s.totalMinor })),
    };
  }

  let membership: Dashboard['membership'] = null;
  if (staffCanAny(roles, ['admin.applications.review', 'admin.members.manage'])) {
    const [active, suspended, toReview, awaitingPayment, due] = await Promise.all([
      num(db, `SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active'`, P),
      num(db, `SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'suspended'`, P),
      num(db, `SELECT count(*) AS n FROM membership_applications WHERE market_id = $1 AND status IN ('submitted', 'under_review', 'interview')`, P),
      num(db, `SELECT count(*) AS n FROM membership_applications WHERE market_id = $1 AND status IN ('approved', 'payment_pending')`, P),
      num(db, `SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND term_ends_at BETWEEN now() AND now() + interval '30 days'`, P),
    ]);
    membership = { activeMembers: active, suspendedMembers: suspended, applicationsToReview: toReview, awaitingPayment, renewalsDue30: due };
  }

  let experiences: Dashboard['experiences'] = null;
  if (staffCanAny(roles, ['admin.experiences.manage', 'admin.bookings.manage'])) {
    const rows = await db.query<{ id: string; title: string; starts_at: string; capacity: number; taken: string }>(`
      -- Seats taken as the Experiences pages count them (experiences.ts): held seats, confirmed, and unexpired payment holds.
      SELECT e.id, e.title, e.starts_at, e.capacity,
             e.seats_held + COALESCE((SELECT sum(b.seats) FROM experience_bookings b WHERE b.experience_id = e.id AND (b.status = 'confirmed' OR (b.status = 'awaiting_payment' AND b.payment_due_at > now()))), 0) AS taken
        FROM experiences e
       WHERE e.market_id = $1 AND e.status = 'published' AND e.starts_at > now()
       ORDER BY e.starts_at`, P);
    const awaiting = await num(db, `
      SELECT count(*) AS n FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id
       WHERE e.market_id = $1 AND e.starts_at > now() AND b.status IN ('applied', 'waitlisted')`, P);
    const taken = rows.map((r) => Number(r.taken));
    experiences = {
      upcoming: rows.length,
      full: rows.filter((r, i) => taken[i]! >= r.capacity).length,
      seatsBooked: taken.reduce((a, b) => a + b, 0),
      seatsTotal: rows.reduce((a, r) => a + r.capacity, 0),
      awaitingDecision: awaiting,
      next: rows.slice(0, 5).map((r, i) => ({ id: r.id, title: r.title, startsAt: new Date(r.starts_at).toISOString(), seatsTaken: taken[i]!, capacity: r.capacity })),
    };
  }

  let concierge: Dashboard['concierge'] = null;
  if (staffCan(roles, 'admin.concierge.manage')) {
    const [open, fresh, services, partners] = await Promise.all([
      num(db, `SELECT count(*) AS n FROM concierge_requests WHERE market_id = $1 AND status NOT IN ('completed', 'cancelled')`, P),
      num(db, `SELECT count(*) AS n FROM concierge_requests WHERE market_id = $1 AND status = 'requested'`, P),
      num(db, `SELECT count(*) AS n FROM service_requests WHERE market_id = $1 AND status IN ('requested', 'in_progress')`, P),
      num(db, `SELECT count(*) AS n FROM partner_bookings WHERE market_id = $1 AND status = 'requested'`, P),
    ]);
    concierge = { openRequests: open, newRequests: fresh, openServiceRequests: services, partnerBookingsWaiting: partners };
  }

  let maison: Dashboard['maison'] = null;
  if (staffCan(roles, 'admin.boutique.manage')) {
    const [paid, preparing, dispatched] = await Promise.all(['paid', 'preparing', 'dispatched'].map((status) =>
      num(db, `SELECT count(*) AS n FROM orders WHERE market_id = $1 AND status = $2`, [m, status])));
    maison = { toProcess: paid!, preparing: preparing!, withCourier: dispatched! };
  }

  return { market: { name: market?.name ?? '', currency: market?.currency_code.trim() ?? '' }, business, membership, experiences, concierge, maison, generatedAt: new Date().toISOString() };
}
