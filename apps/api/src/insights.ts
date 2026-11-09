/**
 * Insights for management: counts and totals for the city being viewed, over a chosen period, compared with the
 * period before. Nothing here identifies a member: every figure is a count or a sum, and lists name experiences,
 * services, partners and products, never people.
 *
 * The weekly report sends the same figures for the last seven days, every Monday morning, to the staff who ask for it.
 */
import { formatMoney } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import type { EmailProvider } from './email.ts';
import { notFound, validation } from './errors.ts';
import { localNow } from './time.ts';

export const INSIGHT_PERIODS = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months', ytd: 'This year' } as const;
export type InsightPeriod = keyof typeof INSIGHT_PERIODS;
const SOURCES = ['membership', 'membership_renewal', 'experience', 'boutique', 'other'] as const;
export const SOURCE_LABEL: Record<(typeof SOURCES)[number], string> = { membership: 'New memberships', membership_renewal: 'Renewals', experience: 'Experiences', boutique: 'Maison Quintara', other: 'Other' };

const querySchema = z.object({
  period: z.enum(Object.keys(INSIGHT_PERIODS) as [InsightPeriod, ...InsightPeriod[]]).default('30d'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export interface InsightRange { from: string; to: string; label: string }
export interface Insights {
  market: { name: string; currency: string };
  period: InsightRange;
  previous: InsightRange;
  bucket: 'day' | 'week' | 'month';
  headline: {
    revenueMinor: number; revenuePrevMinor: number;
    activeMembers: number; newMembers: number; newMembersPrev: number; lapsedMembers: number;
    renewalRate: number | null; autoRenewShare: number | null;
    bookings: number; bookingsPrev: number; orders: number; ordersPrev: number;
  };
  revenueSeries: { bucket: string; label: string; bySource: Record<string, number> }[];
  revenueBySource: { source: string; label: string; totalMinor: number; count: number; refundedMinor: number }[];
  membership: {
    byTier: { tier: string; count: number }[];
    flow: { bucket: string; label: string; joined: number; lapsed: number }[];
    renewals: { due30: number; due60: number; autoRenewOn: number; autoRenewOff: number; failing: number; renewed: number; lapsed: number };
    applications: { submitted: number; approved: number; activated: number; declined: number; waitlisted: number };
  };
  experiences: { id: string; title: string; startsAt: string; capacity: number; seatsTaken: number; bookings: number; revenueMinor: number }[];
  services: { name: string; requests: number }[];
  partners: { name: string; bookings: number; redemptions: number }[];
  maison: { orders: number; revenueMinor: number; averageMinor: number; cancelled: number; topProducts: { title: string; units: number; revenueMinor: number }[] };
  concierge: { kind: string; count: number }[];
  club: { connections: number; conversations: number; blocks: number; openReports: number };
  engagement: { qeraMessages: number; qeraActionsConfirmed: number; membersWithPush: number; pushShare: number | null };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const fmtDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The period's first and last days (inclusive) in the city's calendar, and the same length just before. */
export function rangeFor(period: InsightPeriod, today: string, from?: string, to?: string): { period: InsightRange; previous: InsightRange } {
  let start: string, end = today;
  if (from && to) { start = from <= to ? from : to; end = from <= to ? to : from; }
  else if (period === 'ytd') start = `${today.slice(0, 4)}-01-01`;
  else if (period === '12m') start = addDays(today, -364);
  else start = addDays(today, -(Number(period.replace('d', '')) - 1));
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const prevEnd = addDays(start, -1), prevStart = addDays(prevEnd, -(days - 1));
  return {
    period: { from: start, to: end, label: from && to ? `${fmtDay(start)} to ${fmtDay(end)}` : INSIGHT_PERIODS[period] },
    previous: { from: prevStart, to: prevEnd, label: `${fmtDay(prevStart)} to ${fmtDay(prevEnd)}` },
  };
}

export async function getInsights(db: Queryable, ctx: RequestContext, query: unknown = {}): Promise<Insights> {
  requireStaff(ctx, 'admin.members.manage');
  const parsed = querySchema.safeParse(query ?? {});
  if (!parsed.success) throw validation(parsed.error.issues);
  return insightsFor(db, ctx.marketId, parsed.data.period, parsed.data.from, parsed.data.to);
}

export async function insightsFor(db: Queryable, marketId: string, period: InsightPeriod, from?: string, to?: string): Promise<Insights> {
  const market = (await db.query<{ name: string; currency_code: string; timezone: string }>(
    `SELECT m.name, m.currency_code, c.timezone FROM markets m JOIN cities c ON c.id = m.city_id WHERE m.id = $1`, [marketId]))[0];
  if (!market) throw notFound('This city does not exist.');
  const zone = market.timezone, today = localNow(zone).today;
  const { period: range, previous } = rangeFor(period, today, from, to);
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  const bucket: Insights['bucket'] = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
  // Instants for the city's midnights at each end, so "today" means the city's today.
  const at = `(($X::date)::timestamp AT TIME ZONE '${zone.replace(/'/g, '')}')`;
  /** `col` within the city's days a to b (parameter numbers), both included. */
  const within = (col: string, a: number, b: number) => `(${col} >= ${at.replace('$X', `$${a}`)} AND ${col} < ${at.replace('$X', `$${b}`)} + interval '1 day')`;
  const P = [marketId, range.from, range.to], PP = [marketId, previous.from, previous.to];
  const n = async (sql: string, params: unknown[] = P) => Number((await db.query<{ n: string }>(sql, params))[0]?.n ?? 0);
  const local = (col: string) => `(${col} AT TIME ZONE '${zone.replace(/'/g, '')}')`;
  const trunc = (col: string) => `to_char(date_trunc('${bucket}', ${local(col)}), 'YYYY-MM-DD')`;

  const sourceOf = `CASE WHEN p.purpose IN ('membership', 'membership_renewal', 'experience', 'boutique') THEN p.purpose ELSE 'other' END`;
  const revenue = await db.query<{ source: string; total: string; refunded: string; count: string }>(
    `SELECT ${sourceOf} AS source, sum(p.amount_minor - p.refunded_minor) AS total, sum(p.refunded_minor) AS refunded, count(*) AS count
       FROM payments p WHERE p.market_id = $1 AND ${within('p.paid_at', 2, 3)} AND p.status IN ('paid', 'refunded') GROUP BY 1`, P);
  const revenuePrev = await n(`SELECT COALESCE(sum(p.amount_minor - p.refunded_minor), 0) AS n FROM payments p WHERE p.market_id = $1 AND ${within('p.paid_at', 2, 3)} AND p.status IN ('paid', 'refunded')`, PP);
  const series = await db.query<{ b: string; source: string; total: string }>(
    `SELECT ${trunc('p.paid_at')} AS b, ${sourceOf} AS source, sum(p.amount_minor - p.refunded_minor) AS total
       FROM payments p WHERE p.market_id = $1 AND ${within('p.paid_at', 2, 3)} AND p.status IN ('paid', 'refunded') GROUP BY 1, 2`, P);

  // Every bucket in the period, so quiet weeks show as empty rather than disappearing.
  const buckets: string[] = [];
  const first = new Date(`${range.from}T00:00:00Z`);
  if (bucket === 'week') first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  if (bucket === 'month') first.setUTCDate(1);
  for (const d = first; isoDay(d) <= range.to; bucket === 'day' ? d.setUTCDate(d.getUTCDate() + 1) : bucket === 'week' ? d.setUTCDate(d.getUTCDate() + 7) : d.setUTCMonth(d.getUTCMonth() + 1)) buckets.push(isoDay(d));
  const labelOf = (b: string) => bucket === 'month'
    ? new Date(`${b}T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : new Date(`${b}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  const joined = await db.query<{ b: string; n: string }>(`SELECT ${trunc('m.joined_at')} AS b, count(*) AS n FROM members m WHERE m.home_market_id = $1 AND ${within('m.joined_at', 2, 3)} GROUP BY 1`, P);
  const lapsedSeries = await db.query<{ b: string; n: string }>(`SELECT ${trunc('m.lapsed_at')} AS b, count(*) AS n FROM members m WHERE m.home_market_id = $1 AND ${within('m.lapsed_at', 2, 3)} GROUP BY 1`, P);
  const sumOf = (rows: { n: string }[]) => rows.reduce((s, r) => s + Number(r.n), 0);

  const active = await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active'`, [marketId]);
  const withTerm = await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND term_ends_at IS NOT NULL`, [marketId]);
  const autoOn = await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND term_ends_at IS NOT NULL AND auto_renew`, [marketId]);
  const renewed = await n(`SELECT count(DISTINCT p.member_id) AS n FROM payments p WHERE p.market_id = $1 AND p.purpose = 'membership_renewal' AND p.status = 'paid' AND ${within('p.paid_at', 2, 3)}`);
  const lapsed = sumOf(lapsedSeries);

  const bookingsIn = (a: number, b: number) => `SELECT count(*) AS n FROM experience_bookings eb JOIN experiences e ON e.id = eb.experience_id
     WHERE e.market_id = $1 AND ${within('eb.created_at', a, b)} AND eb.status IN ('confirmed', 'attended', 'awaiting_payment', 'cancelled')`;
  const ordersIn = (a: number, b: number) => `SELECT count(*) AS n FROM orders o WHERE o.market_id = $1 AND ${within('o.created_at', a, b)} AND o.status IN ('paid', 'preparing', 'dispatched', 'delivered')`;

  const experiences = await db.query(
    `SELECT e.id, e.title, e.starts_at, e.capacity,
            e.seats_held + COALESCE((SELECT sum(b.seats) FROM experience_bookings b WHERE b.experience_id = e.id AND b.status IN ('confirmed', 'attended')), 0) AS taken,
            (SELECT count(*) FROM experience_bookings b WHERE b.experience_id = e.id AND ${within('b.created_at', 2, 3)}) AS bookings,
            COALESCE((SELECT sum(p.amount_minor - p.refunded_minor) FROM payments p JOIN experience_bookings b ON b.id = p.booking_id WHERE b.experience_id = e.id AND p.status IN ('paid', 'refunded') AND ${within('p.paid_at', 2, 3)}), 0) AS revenue
       FROM experiences e WHERE e.market_id = $1 AND e.status = 'published' AND (${within('e.starts_at', 2, 3)} OR e.starts_at >= now() - interval '1 day')
      ORDER BY e.starts_at LIMIT 12`, P);
  const services = await db.query<{ name: string; n: string }>(
    `SELECT s.name, count(r.id) AS n FROM service_requests r JOIN lifestyle_services s ON s.id = r.service_id
      WHERE r.market_id = $1 AND ${within('r.created_at', 2, 3)} GROUP BY s.name ORDER BY n DESC, s.name LIMIT 8`, P);
  const partners = await db.query<{ name: string; bookings: string; redemptions: string }>(
    `SELECT p.name,
            (SELECT count(*) FROM partner_bookings b WHERE b.partner_id = p.id AND ${within('b.created_at', 2, 3)}) AS bookings,
            (SELECT count(*) FROM privilege_redemptions r JOIN privileges v ON v.id = r.privilege_id WHERE v.partner_id = p.id AND ${within('r.redeemed_at', 2, 3)}) AS redemptions
       FROM partners p WHERE p.market_id = $1`, P);
  const maison = (await db.query<{ orders: string; revenue: string; cancelled: string }>(
    `SELECT count(*) FILTER (WHERE o.status IN ('paid', 'preparing', 'dispatched', 'delivered')) AS orders,
            COALESCE(sum(o.total_minor) FILTER (WHERE o.status IN ('paid', 'preparing', 'dispatched', 'delivered')), 0) AS revenue,
            count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
       FROM orders o WHERE o.market_id = $1 AND ${within('o.created_at', 2, 3)}`, P))[0]!;
  const products = await db.query<{ title: string; units: string; revenue: string }>(
    `SELECT i.title, sum(i.quantity) AS units, sum(i.quantity * i.unit_price_minor) AS revenue FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.market_id = $1 AND ${within('o.created_at', 2, 3)} AND o.status IN ('paid', 'preparing', 'dispatched', 'delivered')
      GROUP BY i.title ORDER BY units DESC, revenue DESC LIMIT 8`, P);
  const concierge = await db.query<{ k: string; n: string }>(`SELECT category AS k, count(*) AS n FROM concierge_requests WHERE market_id = $1 AND ${within('created_at', 2, 3)} GROUP BY 1 ORDER BY n DESC`, P);
  const apps = Object.fromEntries((await db.query<{ k: string; n: string }>(
    `SELECT status AS k, count(*) AS n FROM membership_applications WHERE market_id = $1 AND ${within('submitted_at', 2, 3)} GROUP BY 1`, P)).map((r) => [r.k, Number(r.n)]));
  const submitted = Object.values(apps).reduce((s, v) => s + v, 0);
  const withPush = await n(
    `SELECT count(DISTINCT m.id) AS n FROM members m JOIN push_devices d ON d.user_id = m.user_id JOIN sessions s ON s.id = d.session_id
      WHERE m.home_market_id = $1 AND m.status = 'active' AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()`, [marketId]);
  const memberUsers = `(SELECT user_id FROM members WHERE home_market_id = $1)`;

  return {
    market: { name: market.name, currency: market.currency_code.trim() },
    period: range, previous, bucket,
    headline: {
      revenueMinor: revenue.reduce((s, r) => s + Number(r.total), 0), revenuePrevMinor: revenuePrev,
      activeMembers: active, newMembers: sumOf(joined),
      newMembersPrev: await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND ${within('joined_at', 2, 3)}`, PP),
      lapsedMembers: lapsed,
      renewalRate: renewed + lapsed ? renewed / (renewed + lapsed) : null,
      autoRenewShare: withTerm ? autoOn / withTerm : null,
      bookings: await n(bookingsIn(2, 3)), bookingsPrev: await n(bookingsIn(2, 3), PP),
      orders: await n(ordersIn(2, 3)), ordersPrev: await n(ordersIn(2, 3), PP),
    },
    revenueSeries: buckets.map((b) => ({ bucket: b, label: labelOf(b), bySource: Object.fromEntries(SOURCES.map((s) => [s, Number(series.find((r) => r.b === b && r.source === s)?.total ?? 0)])) })),
    revenueBySource: SOURCES.map((s) => { const r = revenue.find((x) => x.source === s); return { source: s, label: SOURCE_LABEL[s], totalMinor: Number(r?.total ?? 0), count: Number(r?.count ?? 0), refundedMinor: Number(r?.refunded ?? 0) }; }),
    membership: {
      byTier: (await db.query<{ tier: string; n: string }>(`SELECT t.name AS tier, count(*) AS n FROM members m JOIN membership_tiers t ON t.id = m.tier_id WHERE m.home_market_id = $1 AND m.status = 'active' GROUP BY t.name ORDER BY n DESC`, [marketId])).map((r) => ({ tier: r.tier, count: Number(r.n) })),
      flow: buckets.map((b) => ({ bucket: b, label: labelOf(b), joined: Number(joined.find((r) => r.b === b)?.n ?? 0), lapsed: Number(lapsedSeries.find((r) => r.b === b)?.n ?? 0) })),
      renewals: {
        due30: await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND term_ends_at BETWEEN now() AND now() + interval '30 days'`, [marketId]),
        due60: await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND term_ends_at BETWEEN now() AND now() + interval '60 days'`, [marketId]),
        autoRenewOn: autoOn, autoRenewOff: withTerm - autoOn,
        failing: await n(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active' AND (renewal_attempts > 0 OR term_ends_at < now())`, [marketId]),
        renewed, lapsed,
      },
      applications: { submitted, approved: (apps.approved ?? 0) + (apps.payment_pending ?? 0), activated: apps.active ?? 0, declined: apps.declined ?? 0, waitlisted: apps.waitlisted ?? 0 },
    },
    experiences: experiences.map((e) => ({ id: e.id as string, title: e.title as string, startsAt: new Date(e.starts_at as string).toISOString(), capacity: Number(e.capacity), seatsTaken: Number(e.taken), bookings: Number(e.bookings), revenueMinor: Number(e.revenue) })),
    services: services.map((s) => ({ name: s.name, requests: Number(s.n) })),
    partners: partners.map((p) => ({ name: p.name, bookings: Number(p.bookings), redemptions: Number(p.redemptions) })).filter((p) => p.bookings + p.redemptions > 0).sort((a, b) => b.bookings + b.redemptions - a.bookings - a.redemptions).slice(0, 8),
    maison: { orders: Number(maison.orders), revenueMinor: Number(maison.revenue), averageMinor: Number(maison.orders) ? Math.round(Number(maison.revenue) / Number(maison.orders)) : 0, cancelled: Number(maison.cancelled), topProducts: products.map((p) => ({ title: p.title, units: Number(p.units), revenueMinor: Number(p.revenue) })) },
    concierge: concierge.map((r) => ({ kind: r.k, count: Number(r.n) })),
    club: {
      connections: await n(`SELECT count(*) AS n FROM connections c JOIN members m ON m.id = c.requester_id WHERE m.home_market_id = $1 AND c.status = 'connected'`, [marketId]),
      conversations: await n(`SELECT count(*) AS n FROM conversations`, []),
      blocks: await n(`SELECT count(*) AS n FROM member_blocks`, []),
      openReports: await n(`SELECT count(*) AS n FROM member_reports WHERE status = 'open'`, []),
    },
    engagement: {
      qeraMessages: await n(`SELECT count(*) AS n FROM qera_messages WHERE role = 'user' AND ${within('created_at', 2, 3)} AND user_id IN ${memberUsers}`),
      qeraActionsConfirmed: await n(`SELECT count(*) AS n FROM qera_proposals WHERE status = 'confirmed' AND ${within('decided_at', 2, 3)} AND user_id IN ${memberUsers}`),
      membersWithPush: withPush, pushShare: active ? withPush / active : null,
    },
  };
}

/** The figures as a spreadsheet, one row per figure. Formula-looking text is neutralised. */
export async function insightsCsv(db: Queryable, ctx: RequestContext, query: unknown): Promise<string> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  const i = await getInsights(db, ctx, query);
  const cur = i.market.currency, money = (m: number) => (m / 100).toFixed(2);
  const rows: (string | number)[][] = [['Section', 'Figure', 'Value', 'Unit'], ['Period', `${i.period.from} to ${i.period.to}`, '', ''], ['City', i.market.name, '', '']];
  const h = i.headline;
  rows.push(['Headline', 'Revenue', money(h.revenueMinor), cur], ['Headline', 'Revenue, previous period', money(h.revenuePrevMinor), cur], ['Headline', 'Active members', h.activeMembers, 'members'],
    ['Headline', 'New members', h.newMembers, 'members'], ['Headline', 'Lapsed members', h.lapsedMembers, 'members'], ['Headline', 'Renewal rate', h.renewalRate === null ? '' : (h.renewalRate * 100).toFixed(1), '%'],
    ['Headline', 'Automatic renewal on', h.autoRenewShare === null ? '' : (h.autoRenewShare * 100).toFixed(1), '%'], ['Headline', 'Experience bookings', h.bookings, 'bookings'], ['Headline', 'Maison orders', h.orders, 'orders']);
  for (const s of i.revenueBySource) rows.push(['Revenue by source', s.label, money(s.totalMinor), cur]);
  for (const r of i.revenueSeries) for (const [k, v] of Object.entries(r.bySource)) rows.push([`Revenue, ${i.bucket} of ${r.bucket}`, SOURCE_LABEL[k as keyof typeof SOURCE_LABEL] ?? k, money(v), cur]);
  for (const t of i.membership.byTier) rows.push(['Members by plan', t.tier, t.count, 'members']);
  for (const [k, v] of Object.entries(i.membership.renewals)) rows.push(['Renewals', k, v, 'members']);
  for (const [k, v] of Object.entries(i.membership.applications)) rows.push(['Applications', k, v, 'applications']);
  for (const e of i.experiences) rows.push(['Experiences', e.title, e.seatsTaken, `of ${e.capacity} seats`], ['Experiences, revenue', e.title, money(e.revenueMinor), cur]);
  for (const s of i.services) rows.push(['Service requests', s.name, s.requests, 'requests']);
  for (const p of i.partners) rows.push(['Partner bookings', p.name, p.bookings, 'bookings'], ['Privileges used', p.name, p.redemptions, 'codes']);
  rows.push(['Maison Quintara', 'Orders', i.maison.orders, 'orders'], ['Maison Quintara', 'Revenue', money(i.maison.revenueMinor), cur], ['Maison Quintara', 'Average order', money(i.maison.averageMinor), cur]);
  for (const p of i.maison.topProducts) rows.push(['Maison, units sold', p.title, p.units, 'units']);
  for (const c of i.concierge) rows.push(['Concierge requests', c.kind, c.count, 'requests']);
  rows.push(['Engagement', 'Messages to QÉRA', i.engagement.qeraMessages, 'messages'], ['Engagement', 'QÉRA actions confirmed', i.engagement.qeraActionsConfirmed, 'actions'], ['Engagement', 'Members with push notifications', i.engagement.membersWithPush, 'members']);
  const cell = (v: string | number) => { let t = String(v); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  await audit(db, staffId, 'insights.exported', 'market', ctx.marketId, { from: i.period.from, to: i.period.to });
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/* ---------- The weekly report ---------- */

const pct = (x: number | null) => (x === null ? 'not yet measurable' : `${Math.round(x * 100)}%`);
const change = (now: number, before: number) => (before === 0 ? (now ? 'new this week' : 'no change') : `${now >= before ? 'up' : 'down'} ${Math.abs(Math.round(((now - before) / before) * 100))}% on the week before`);

/** The text of the report for one city, from the figures for the last seven days. */
export function reportText(i: Insights): string {
  const h = i.headline, m = (x: number) => formatMoney(x, i.market.currency);
  const lines = [
    `${i.market.name}: ${i.period.label.toLowerCase()} (${i.period.from} to ${i.period.to})`,
    '',
    `Revenue: ${m(h.revenueMinor)}, ${change(h.revenueMinor, h.revenuePrevMinor)}.`,
    ...i.revenueBySource.filter((s) => s.totalMinor).map((s) => `  ${s.label}: ${m(s.totalMinor)}`),
    `Members: ${h.activeMembers} active. ${h.newMembers} joined, ${h.lapsedMembers} lapsed.`,
    `Renewals: ${i.membership.renewals.renewed} renewed. ${i.membership.renewals.due30} due in the next 30 days; ${i.membership.renewals.failing} need attention. Automatic renewal is on for ${pct(h.autoRenewShare)} of members.`,
    `Experiences: ${h.bookings} bookings, ${change(h.bookings, h.bookingsPrev)}.`,
    ...i.experiences.filter((e) => e.bookings).slice(0, 3).map((e) => `  ${e.title}: ${e.seatsTaken} of ${e.capacity} seats`),
    `Maison Quintara: ${h.orders} orders, ${m(i.maison.revenueMinor)}.`,
    `Applications: ${i.membership.applications.submitted} received.`,
    i.services.length ? `Most requested services: ${i.services.slice(0, 3).map((s) => `${s.name} (${s.requests})`).join(', ')}.` : '',
    `QÉRA: ${i.engagement.qeraMessages} messages from members, ${i.engagement.qeraActionsConfirmed} actions confirmed.`,
  ];
  return lines.filter((l, k) => l || k === 1).join('\n');
}

/** Monday from 07:00 (Johannesburg time), once per week: the last seven days for each open city. */
export async function sendWeeklyReport(db: Db, mail: EmailProvider, adminUrl: string, now = new Date(), force = false): Promise<number> {
  const local = localNow('Africa/Johannesburg', now);
  if (!force && (local.weekday !== 1 || local.hour < 7)) return 0;
  const weekStart = local.today;
  const recipients = await db.query<{ email: string; full_name: string }>(
    `SELECT u.email, s.full_name FROM staff_accounts s JOIN users u ON u.id = s.user_id WHERE s.status = 'active' AND s.weekly_report AND u.email IS NOT NULL AND u.deleted_at IS NULL`);
  if (!recipients.length) return 0;
  if (!force) {
    const claimed = await db.query('INSERT INTO insight_reports (week_start, recipients) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING week_start', [weekStart, recipients.length]);
    if (!claimed[0]) return 0;
  }
  const markets = await db.query<{ id: string }>(`SELECT m.id FROM markets m JOIN cities c ON c.id = m.city_id WHERE m.is_active ORDER BY m.position, m.created_at`);
  const sections: string[] = [];
  for (const k of markets) sections.push(reportText(await insightsFor(db, k.id, '7d')));
  const text = `${sections.join('\n\n')}\n\nCounts and totals only. The full figures, by any period, are under Insights in the admin console: ${adminUrl}/insights\n\nQuintara`;
  let sent = 0;
  for (const r of recipients) {
    try { await mail.send({ to: r.email, subject: `Quintara weekly report, week of ${weekStart}`, text: `Good morning, ${r.full_name.split(' ')[0]}.\n\n${text}` }); sent++; } catch { /* the next week's report still goes */ }
  }
  return sent;
}

export async function getReportSetting(db: Queryable, ctx: RequestContext): Promise<{ weeklyReport: boolean }> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  return { weeklyReport: Boolean((await db.query<{ weekly_report: boolean }>('SELECT weekly_report FROM staff_accounts WHERE user_id = $1', [staffId]))[0]?.weekly_report) };
}
export async function setReportSetting(db: Queryable, ctx: RequestContext, body: unknown): Promise<{ weeklyReport: boolean }> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  const parsed = z.object({ weeklyReport: z.boolean() }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.query('UPDATE staff_accounts SET weekly_report = $2, updated_at = now() WHERE user_id = $1', [staffId, parsed.data.weeklyReport]);
  await audit(db, staffId, parsed.data.weeklyReport ? 'insights.report_on' : 'insights.report_off', 'user', staffId);
  return parsed.data;
}
/** Sends this week's report now, to the member of staff who asks only. */
export async function sendReportToMe(db: Db, ctx: RequestContext, mail: EmailProvider, adminUrl: string): Promise<{ sent: boolean }> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  const me = (await db.query<{ email: string; full_name: string }>(`SELECT u.email, s.full_name FROM staff_accounts s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`, [staffId]))[0];
  if (!me?.email) throw notFound('Your account has no email address.');
  const i = await insightsFor(db, ctx.marketId, '7d');
  await mail.send({ to: me.email, subject: `Quintara weekly report (${i.market.name}, sent on request)`, text: `${reportText(i)}\n\nQuintara` });
  await audit(db, staffId, 'insights.report_sent', 'user', staffId);
  return { sent: true };
}
