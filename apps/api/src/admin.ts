/** Staff operations. Every function starts with a staff permission check and ends with an audit entry. */
import { ADMISSIONS, APPLICATION_APPROVED_MESSAGE, EMPTY_APPLICATION, RESIDENCIES } from '@quintara/domain';
import type { ApplicationData, Experience } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { SELECT_EXPERIENCE_ALL, toExperience } from './experiences.ts';
import { activateApplication } from './membership.ts';
import { eraseAccount } from './privacy.ts';

const uuid = z.uuid();
const isUuid = (value: unknown): value is string => uuid.safeParse(value).success;
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw validation(result.error.issues);
  return result.data;
}
const notify = (db: Queryable, userId: string, category: string, title: string, link: unknown = null) =>
  db.query('INSERT INTO notifications (user_id, category, title, link) VALUES ($1, $2, $3, $4::jsonb)', [userId, category, title, JSON.stringify(link)]);

/* ---------- Applications ---------- */

export async function listApplications(db: Queryable, ctx: RequestContext, status?: string) {
  requireStaff(ctx, 'admin.applications.review');
  const rows = await db.query(
    `SELECT a.id, a.status, a.data, a.submitted_at, a.decision_note, t.name AS tier_name, u.email,
            r.id AS requested_id, r.name AS requested_name, r.price_minor AS requested_price, r.currency_code AS requested_currency
       FROM membership_applications a JOIN users u ON u.id = a.user_id LEFT JOIN membership_tiers t ON t.id = a.offered_tier_id
       LEFT JOIN membership_tiers r ON r.id = a.requested_tier_id
      WHERE a.status <> 'draft' AND ($1::text IS NULL OR a.status = $1) AND a.market_id = $2 ORDER BY a.submitted_at`, [status ?? null, ctx.marketId]);
  return rows.map((row) => ({
    id: row.id as string, status: row.status as string, data: { ...EMPTY_APPLICATION, ...(row.data as Partial<ApplicationData>) }, email: row.email as string | null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string).toISOString() : null,
    offeredTierName: (row.tier_name as string | null) ?? null, decisionNote: (row.decision_note as string | null) ?? null,
    requestedTier: row.requested_id ? { id: row.requested_id as string, name: row.requested_name as string, priceMinor: Number(row.requested_price), currency: (row.requested_currency as string).trim() } : null,
  }));
}

const reviewSchema = z.object({ status: z.enum(['under_review', 'interview', 'waitlisted', 'declined']), note: z.string().trim().max(1000).optional() });
const REVIEWABLE = ['submitted', 'under_review', 'interview', 'waitlisted'];

export async function reviewApplication(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.applications.review');
  const { status, note } = parse(reviewSchema, body);
  await db.tx(async (tx) => {
    const rows = isUuid(id) ? await tx.query<{ status: string; user_id: string }>('SELECT status, user_id FROM membership_applications WHERE id = $1 FOR UPDATE', [id]) : [];
    if (!rows[0]) throw notFound('This application does not exist.');
    if (!REVIEWABLE.includes(rows[0].status)) throw conflict('This application has already been decided.');
    const decided = status === 'declined' || status === 'waitlisted';
    await tx.query(`UPDATE membership_applications SET status = $2, decision_note = COALESCE($3, decision_note), reviewed_by = $4, decided_at = CASE WHEN $5 THEN now() ELSE decided_at END, updated_at = now() WHERE id = $1`, [id, status, note ?? null, staffId, decided]);
    await audit(tx, staffId, 'application.' + status, 'membership_application', id, { from: rows[0].status });
  });
}

export async function approveApplication(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.applications.review');
  const { tierId } = parse(z.object({ tierId: uuid }), body);
  await db.tx(async (tx) => {
    const rows = isUuid(id) ? await tx.query<{ status: string; market_id: string; user_id: string }>('SELECT status, market_id, user_id FROM membership_applications WHERE id = $1 FOR UPDATE', [id]) : [];
    if (!rows[0]) throw notFound('This application does not exist.');
    if (!REVIEWABLE.includes(rows[0].status)) throw conflict('This application has already been decided.');
    const tier = (await tx.query<{ price_minor: string }>('SELECT price_minor FROM membership_tiers WHERE id = $1 AND market_id = $2 AND is_active', [tierId, rows[0].market_id]))[0];
    if (!tier) throw new HttpError(422, 'Choose a tier from this market.', { tierId: 'Choose a tier from this market' });
    await tx.query(`UPDATE membership_applications SET status = 'payment_pending', offered_tier_id = $2, reviewed_by = $3, decided_at = now(), updated_at = now() WHERE id = $1`, [id, tierId, staffId]);
    await audit(tx, staffId, 'application.approved', 'membership_application', id, { tierId });
    // A complimentary tier has nothing to pay, so the membership starts at once.
    if (Number(tier.price_minor) === 0) await activateApplication(tx, id, staffId);
    else await notify(tx, rows[0].user_id, 'membership_update', APPLICATION_APPROVED_MESSAGE);
  });
}

export async function listTiers(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.applications.review');
  const rows = await db.query('SELECT id, market_id, name, price_minor, currency_code, billing_period, residency, term_months FROM membership_tiers WHERE is_active AND market_id = $1 ORDER BY residency DESC NULLS LAST, term_months, name', [ctx.marketId]);
  return rows.map((r) => ({ id: r.id as string, marketId: r.market_id as string, name: r.name as string, priceMinor: Number(r.price_minor), currency: (r.currency_code as string).trim(), billingPeriod: r.billing_period as string, residency: (r.residency as string | null) ?? null, termMonths: r.term_months === null ? null : Number(r.term_months) }));
}

/* ---------- Members ---------- */

export async function listMembersForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.members.manage');
  const rows = await db.query(
    `SELECT m.id, m.user_id, m.member_number, m.status, m.joined_at, p.full_name, u.email, t.name AS tier_name,
            ARRAY(SELECT r.role_key FROM user_roles r WHERE r.user_id = m.user_id ORDER BY r.role_key) AS roles
       FROM members m JOIN users u ON u.id = m.user_id JOIN profiles p ON p.user_id = m.user_id JOIN membership_tiers t ON t.id = m.tier_id WHERE m.home_market_id = $1 ORDER BY p.full_name`, [ctx.marketId]);
  return rows.map((r) => ({ id: r.id as string, userId: r.user_id as string, memberNumber: r.member_number as string, status: r.status as string, fullName: r.full_name as string, email: r.email as string, tierName: r.tier_name as string, roles: r.roles as string[], joinedAt: new Date(r.joined_at as string).toISOString() }));
}

export async function setMemberStatus(db: Db, ctx: RequestContext, memberId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), body);
  // A member who closed their own account is handled under Closed accounts, never switched back on here.
  if (isUuid(memberId) && (await db.query(`SELECT 1 FROM members WHERE id = $1 AND status = 'resigned'`, [memberId]))[0]) throw conflict('This member closed their account. Use Reinstate under Closed accounts.');
  const rows = isUuid(memberId) ? await db.query<{ user_id: string }>('UPDATE members SET status = $2 WHERE id = $1 RETURNING user_id', [memberId, status]) : [];
  if (!rows[0]) throw notFound('This member does not exist.');
  // Suspension also ends every open session, so access stops now rather than at the next sign-in.
  if (status === 'suspended') await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].user_id]);
  await audit(db, staffId, 'member.' + status, 'member', memberId);
}

export async function setMemberRole(db: Db, ctx: RequestContext, memberId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  // Staff roles can never be handed out through this route.
  const { role, granted } = parse(z.object({ role: z.enum(['founder', 'investor', 'creative', 'executive']), granted: z.boolean() }), body);
  const rows = isUuid(memberId) ? await db.query<{ user_id: string }>('SELECT user_id FROM members WHERE id = $1', [memberId]) : [];
  if (!rows[0]) throw notFound('This member does not exist.');
  if (granted) await db.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].user_id, role]);
  else await db.query('DELETE FROM user_roles WHERE user_id = $1 AND role_key = $2', [rows[0].user_id, role]);
  await audit(db, staffId, granted ? 'member.role_granted' : 'member.role_removed', 'member', memberId, { role });
}

/* ---------- Experiences ---------- */

const experienceSchema = z.object({
  title: z.string().trim().min(2).max(120), category: z.string().trim().min(2).max(60),
  summary: z.string().trim().max(240).default(''), description: z.string().trim().max(4000).default(''),
  startsAt: z.iso.datetime({ offset: true }), timezone: z.string().trim().min(3).max(60),
  venueName: z.string().trim().max(120).default(''), area: z.string().trim().max(120).default(''),
  dressCode: z.string().trim().max(120).default(''), host: z.string().trim().max(120).default(''),
  capacity: z.number().int().min(1).max(100000), seatsHeld: z.number().int().min(0).default(0),
  priceMinor: z.number().int().min(0).default(0), memberPriceMinor: z.number().int().min(0).default(0), currency: z.string().length(3),
  admission: z.enum(ADMISSIONS), isHidden: z.boolean().default(false), openToGuests: z.boolean().default(false), guestPolicy: z.string().trim().max(240).default(''),
  maxSeatsPerBooking: z.number().int().min(1).max(20).default(1),
  paymentHoldMinutes: z.number().int().min(5).max(10080).default(30), refundHours: z.number().int().min(0).max(8760).default(48), status: z.enum(['draft', 'published', 'cancelled']).default('draft'),
});
const COLUMNS: Record<string, string> = { title: 'title', category: 'category', summary: 'summary', description: 'description', startsAt: 'starts_at', timezone: 'timezone', venueName: 'venue_name', area: 'area', dressCode: 'dress_code', host: 'host', capacity: 'capacity', seatsHeld: 'seats_held', priceMinor: 'price_minor', memberPriceMinor: 'member_price_minor', currency: 'currency_code', admission: 'admission', isHidden: 'is_hidden', openToGuests: 'open_to_guests', guestPolicy: 'guest_policy', maxSeatsPerBooking: 'max_seats_per_booking', paymentHoldMinutes: 'payment_hold_minutes', refundHours: 'refund_hours', status: 'status' };

type StaffExperience = Omit<Experience, 'startsAt' | 'capacity' | 'seatsTaken'> & { startsAt: string; capacity: number; seatsTaken: number; status: string; isHidden: boolean; seatsHeld: number; paymentHoldMinutes: number; refundHours: number };
const toStaffExperience = (row: Record<string, unknown>): StaffExperience => ({ ...(toExperience(row, true) as Experience & { startsAt: string; capacity: number; seatsTaken: number }), status: row.status as string, isHidden: Boolean(row.is_hidden), seatsHeld: Number(row.seats_held), paymentHoldMinutes: Number(row.payment_hold_minutes), refundHours: Number(row.refund_hours) });

export async function listExperiencesForStaff(db: Queryable, ctx: RequestContext): Promise<StaffExperience[]> {
  requireStaff(ctx, 'admin.experiences.manage');
  return (await db.query(`${SELECT_EXPERIENCE_ALL} AND e.market_id = $2 ORDER BY e.starts_at`, [null, ctx.marketId])).map(toStaffExperience);
}

async function staffExperience(db: Queryable, id: string): Promise<StaffExperience> {
  const rows = isUuid(id) ? await db.query(`${SELECT_EXPERIENCE_ALL} AND e.id = $2`, [null, id]) : [];
  if (!rows[0]) throw notFound('This experience does not exist.');
  return toStaffExperience(rows[0]);
}

export async function createExperience(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<StaffExperience> {
  const staffId = requireStaff(ctx, 'admin.experiences.manage');
  const data = parse(experienceSchema, body) as Record<string, unknown>;
  if (data.status === 'cancelled') throw conflict('A new experience starts as a draft or published.');
  if (!(await db.query('SELECT 1 FROM currencies WHERE code = $1', [data.currency]))[0]) throw new HttpError(422, 'Choose a supported currency.', { currency: 'Unsupported currency' });
  const keys = Object.keys(COLUMNS).filter((key) => data[key] !== undefined);
  const id = (await db.query<{ id: string }>(
    `INSERT INTO experiences (market_id, ${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING id`,
    [marketId, ...keys.map((k) => data[k])]))[0]!.id;
  await audit(db, staffId, 'experience.created', 'experience', id, { title: data.title });
  return staffExperience(db, id);
}

export async function updateExperience(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<StaffExperience> {
  const staffId = requireStaff(ctx, 'admin.experiences.manage');
  const data = parse(experienceSchema.partial(), body) as Record<string, unknown>;
  // Only the keys the caller actually sent: defaults must not overwrite stored values.
  const sent = Object.keys(COLUMNS).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  // Cancelling has consequences (guests told, payments refunded): it has its own action, never a plain edit.
  if (data.status === 'cancelled') throw conflict('Use Cancel experience: it tells the guests and refunds what they paid.');
  const current = await staffExperience(db, id);
  if (current.status === 'cancelled' && sent.includes('status')) throw conflict('A cancelled experience cannot be published again. Create a new one.');
  if (sent.length) {
    await db.query(`UPDATE experiences SET ${sent.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k])]);
    await audit(db, staffId, 'experience.updated', 'experience', id, { fields: sent });
  }
  return staffExperience(db, id);
}

export async function inviteMember(db: Db, ctx: RequestContext, experienceId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.experiences.manage');
  const { memberId } = parse(z.object({ memberId: uuid }), body);
  const experience = await staffExperience(db, experienceId);
  const member = (await db.query<{ user_id: string }>(`SELECT user_id FROM members WHERE id = $1 AND status = 'active'`, [memberId]))[0];
  if (!member) throw notFound('This member does not exist.');
  const added = await db.query('INSERT INTO experience_invitations (experience_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING member_id', [experienceId, memberId]);
  if (added[0]) {
    await notify(db, member.user_id, 'experience_invitation', `You are invited to ${experience.title}.`, { type: 'experience', id: experienceId });
    await audit(db, staffId, 'experience.invited', 'experience', experienceId, { memberId });
  }
}

/* ---------- Guest lists, decisions and check-in ---------- */

export async function listGuests(db: Queryable, ctx: RequestContext, experienceId: string) {
  requireStaff(ctx, 'admin.bookings.manage');
  await staffExperience(db, experienceId);
  const rows = await db.query(
    `SELECT b.id, b.seats, b.status, b.ticket_code, b.checked_in_at, m.id AS member_id, m.member_number, p.full_name
       FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN profiles p ON p.user_id = m.user_id
      WHERE b.experience_id = $1 AND b.status NOT IN ('cancelled', 'declined') ORDER BY b.created_at`, [experienceId]);
  return rows.map((r) => ({ bookingId: r.id as string, memberId: r.member_id as string, memberNumber: r.member_number as string, fullName: r.full_name as string, seats: Number(r.seats), status: r.status as string, ticketCode: r.ticket_code as string, checkedInAt: r.checked_in_at ? new Date(r.checked_in_at as string).toISOString() : null }));
}

export async function decideBooking(db: Db, ctx: RequestContext, bookingId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.bookings.manage');
  const { decision } = parse(z.object({ decision: z.enum(['confirm', 'decline']) }), body);
  await db.tx(async (tx) => {
    const rows = isUuid(bookingId)
      ? await tx.query<{ status: string; seats: number; experience_id: string; user_id: string; title: string }>(
          `SELECT b.status, b.seats, b.experience_id, m.user_id, e.title FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN experiences e ON e.id = b.experience_id WHERE b.id = $1`, [bookingId])
      : [];
    const booking = rows[0];
    if (!booking) throw notFound('This booking does not exist.');
    if (!['applied', 'waitlisted'].includes(booking.status)) throw conflict('This booking is not waiting for a decision.');
    if (decision === 'decline') {
      await tx.query(`UPDATE experience_bookings SET status = 'declined', updated_at = now() WHERE id = $1`, [bookingId]);
      await notify(tx, booking.user_id, 'booking_confirmation', `We could not offer you a place at ${booking.title}.`, { type: 'experience', id: booking.experience_id });
    } else {
      // Lock the experience, then recount: staff cannot overfill it either.
      await tx.query('SELECT id FROM experiences WHERE id = $1 FOR UPDATE', [booking.experience_id]);
      const experience = await staffExperience(tx, booking.experience_id);
      if (experience.seatsTaken + Number(booking.seats) > experience.capacity) throw conflict('There are not enough seats left. Raise the capacity or release held seats first.');
      const due = experience.memberPriceMinor * Number(booking.seats);
      if (due > 0) {
        // Staff offer the place; it is confirmed when the member pays. Two days to do so.
        await tx.query(`UPDATE experience_bookings SET status = 'awaiting_payment', amount_due_minor = $2, payment_due_at = now() + interval '48 hours', updated_at = now() WHERE id = $1`, [bookingId, due]);
        await notify(tx, booking.user_id, booking.status === 'waitlisted' ? 'waitlist_opening' : 'booking_confirmation', `A place is yours at ${booking.title}. Pay within two days to confirm it.`, { type: 'booking', id: bookingId });
      } else {
        await tx.query(`UPDATE experience_bookings SET status = 'confirmed', updated_at = now() WHERE id = $1`, [bookingId]);
        await notify(tx, booking.user_id, booking.status === 'waitlisted' ? 'waitlist_opening' : 'booking_confirmation', booking.status === 'waitlisted' ? `A seat has opened for you at ${booking.title}.` : `Your place at ${booking.title} is confirmed.`, { type: 'booking', id: bookingId });
      }
    }
    await audit(tx, staffId, 'booking.' + (decision === 'confirm' ? 'confirmed' : 'declined'), 'experience_booking', bookingId, { from: booking.status });
  });
}

export async function checkIn(db: Db, ctx: RequestContext, body: unknown) {
  const staffId = requireStaff(ctx, 'admin.bookings.manage');
  const { ticketCode } = parse(z.object({ ticketCode: z.string().trim().min(4).max(40) }), body);
  return db.tx(async (tx) => {
    const rows = await tx.query<{ id: string; status: string; seats: number; checked_in_at: Date | null; full_name: string; title: string }>(
      `SELECT b.id, b.status, b.seats, b.checked_in_at, p.full_name, e.title FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN profiles p ON p.user_id = m.user_id JOIN experiences e ON e.id = b.experience_id
        WHERE upper(b.ticket_code) = upper($1) FOR UPDATE OF b`, [ticketCode]);
    const booking = rows[0];
    if (!booking) throw notFound('No ticket has that code.');
    if (booking.checked_in_at) throw conflict(`${booking.full_name} is already checked in.`);
    if (booking.status !== 'confirmed') throw conflict('This booking is not confirmed.');
    await tx.query(`UPDATE experience_bookings SET status = 'attended', checked_in_at = now(), checked_in_by = $2, updated_at = now() WHERE id = $1`, [booking.id, staffId]);
    await audit(tx, staffId, 'booking.checked_in', 'experience_booking', booking.id);
    return { fullName: booking.full_name, seats: Number(booking.seats), experienceTitle: booking.title };
  });
}

/* ---------- Reports from members ---------- */

export async function listReports(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.members.manage');
  const rows = await db.query(
    `SELECT r.id, r.reason, r.detail, r.status, r.created_at, rm.id AS reporter_id, rp.full_name AS reporter_name,
            dm.id AS reported_id, dp.full_name AS reported_name, dm.status AS reported_status
       FROM member_reports r
       JOIN members rm ON rm.id = r.reporter_id JOIN profiles rp ON rp.user_id = rm.user_id
       JOIN members dm ON dm.id = r.reported_id JOIN profiles dp ON dp.user_id = dm.user_id
      ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 200`);
  return rows.map((row) => ({
    id: row.id as string, reason: row.reason as string, detail: row.detail as string, status: row.status as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    reporter: { id: row.reporter_id as string, fullName: row.reporter_name as string },
    reported: { id: row.reported_id as string, fullName: row.reported_name as string, status: row.reported_status as string },
  }));
}

export async function resolveReport(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  const { outcome } = parse(z.object({ outcome: z.enum(['dismissed', 'suspended']) }), body);
  await db.tx(async (tx) => {
    const rows = isUuid(id) ? await tx.query<{ status: string; reported_id: string }>('SELECT status, reported_id FROM member_reports WHERE id = $1 FOR UPDATE', [id]) : [];
    if (!rows[0]) throw notFound('This report does not exist.');
    if (rows[0].status !== 'open') throw conflict('This report has already been closed.');
    await tx.query('UPDATE member_reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1', [id, outcome, staffId]);
    if (outcome === 'suspended') await setMemberStatus(tx as Db, ctx, rows[0].reported_id, { status: 'suspended' });
    await audit(tx, staffId, 'report.' + outcome, 'member_report', id);
  });
}

/* Insights are in insights.ts. */

/* ---------- Membership tiers and prices ---------- */

const tierBase = z.object({
  name: z.string().trim().min(2).max(60), priceMinor: z.number().int().min(0).max(100_000_000_00),
  currency: z.string().length(3), billingPeriod: z.enum(['month', 'year', 'once', 'none']).default('year'), isActive: z.boolean().default(true),
  // A tier with a residency and a term is a plan applicants can choose on the application.
  residency: z.enum(RESIDENCIES).nullable().default(null), termMonths: z.number().int().min(1).max(60).nullable().default(null),
});
const tierSchema = tierBase.refine((t) => (t.residency === null) === (t.termMonths === null), { message: 'Give both the residency and the term, or neither', path: ['termMonths'] });

/** Every tier, including retired ones, with how many members hold it. */
export async function listAllTiers(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.finance.manage');
  const rows = await db.query(
    `SELECT t.id, t.market_id, t.name, t.price_minor, t.currency_code, t.billing_period, t.is_active, t.residency, t.term_months,
            (SELECT count(*) FROM members m WHERE m.tier_id = t.id) AS members
       FROM membership_tiers t WHERE t.market_id = $1 ORDER BY t.is_active DESC, t.residency DESC NULLS LAST, t.term_months, t.name`, [ctx.marketId]);
  return rows.map((r) => ({ id: r.id as string, marketId: r.market_id as string, name: r.name as string, priceMinor: Number(r.price_minor), currency: (r.currency_code as string).trim(), billingPeriod: r.billing_period as string, isActive: Boolean(r.is_active), members: Number(r.members), residency: (r.residency as string | null) ?? null, termMonths: r.term_months === null ? null : Number(r.term_months) }));
}

export async function createTier(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.finance.manage');
  const data = parse(tierSchema, body);
  if (!(await db.query('SELECT 1 FROM currencies WHERE code = $1', [data.currency]))[0]) throw new HttpError(422, 'Choose a supported currency.', { currency: 'Unsupported currency' });
  if ((await db.query('SELECT 1 FROM membership_tiers WHERE market_id = $1 AND lower(name) = lower($2)', [marketId, data.name]))[0]) throw conflict('A tier with that name already exists.');
  const id = (await db.query<{ id: string }>(
    'INSERT INTO membership_tiers (market_id, name, price_minor, currency_code, billing_period, is_active, residency, term_months) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [marketId, data.name, data.priceMinor, data.currency, data.billingPeriod, data.isActive, data.residency, data.termMonths]))[0]!.id;
  await audit(db, staffId, 'tier.created', 'membership_tier', id, { name: data.name, priceMinor: data.priceMinor });
}

/** A new price applies to approvals from now on. Fees already paid are not touched. The currency of a tier never changes. */
export async function updateTier(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.finance.manage');
  const data = parse(tierBase.omit({ currency: true, residency: true, termMonths: true }).partial(), body) as Record<string, unknown>;
  const columns: Record<string, string> = { name: 'name', priceMinor: 'price_minor', billingPeriod: 'billing_period', isActive: 'is_active' };
  const sent = Object.keys(columns).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  const before = isUuid(id) ? await db.query('SELECT price_minor FROM membership_tiers WHERE id = $1', [id]) : [];
  if (!before[0]) throw notFound('This tier does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE membership_tiers SET ${sent.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...sent.map((k) => data[k])]);
  await audit(db, staffId, 'tier.updated', 'membership_tier', id, { fields: sent, previousPriceMinor: Number(before[0].price_minor) });
}

/* ---------- Payments ledger (read only) ---------- */

export async function listPayments(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.finance.manage');
  // No card details exist to show: only the provider's reference is ever stored.
  const rows = await db.query(
    `SELECT p.id, p.purpose, p.amount_minor, p.refunded_minor, p.currency_code, p.status, p.provider, p.failure_reason, p.created_at,
            COALESCE(pr.full_name, a.data->>'fullName', 'Applicant') AS payer,
            COALESCE(e.title, t.name || ' membership', initcap(p.purpose)) AS description
       FROM payments p
       LEFT JOIN profiles pr ON pr.user_id = p.user_id
       LEFT JOIN membership_applications a ON a.id = p.application_id
       LEFT JOIN membership_tiers t ON t.id = a.offered_tier_id
       LEFT JOIN experience_bookings b ON b.id = p.booking_id
       LEFT JOIN experiences e ON e.id = b.experience_id
      ORDER BY p.created_at DESC LIMIT 300`);
  return rows.map((r) => ({
    id: r.id as string, purpose: r.purpose as string, payer: r.payer as string, description: r.description as string,
    amountMinor: Number(r.amount_minor), refundedMinor: Number(r.refunded_minor), currency: (r.currency_code as string).trim(),
    status: r.status as string, provider: r.provider as string, failureReason: (r.failure_reason as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}

/* ---------- Closed accounts awaiting erasure ---------- */

export async function listClosures(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.members.manage');
  const rows = await db.query(
    `SELECT c.user_id, c.requested_at, c.erase_after, c.erased_at, p.full_name, m.member_number
       FROM account_closures c LEFT JOIN profiles p ON p.user_id = c.user_id LEFT JOIN members m ON m.user_id = c.user_id
      ORDER BY (c.erased_at IS NULL) DESC, c.requested_at DESC LIMIT 200`);
  return rows.map((r) => ({
    userId: r.user_id as string, fullName: (r.full_name as string | null) ?? 'Former member', memberNumber: (r.member_number as string | null) ?? '',
    requestedAt: new Date(r.requested_at as string).toISOString(), eraseAfter: new Date(r.erase_after as string).toISOString(),
    erasedAt: r.erased_at ? new Date(r.erased_at as string).toISOString() : null,
  }));
}

/** Erases now instead of waiting for the cooling-off period, for a member who asks for that. */
export async function eraseClosedAccount(db: Db, ctx: RequestContext, userId: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  if (!isUuid(userId) || !(await eraseAccount(db, userId, staffId))) throw notFound('There is no closed account waiting to be erased.');
}

/** Undoes a closure made by mistake, while the data still exists. Cancelled bookings are not restored. */
export async function reinstateClosedAccount(db: Db, ctx: RequestContext, userId: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.members.manage');
  await db.tx(async (tx) => {
    const rows = isUuid(userId) ? await tx.query('DELETE FROM account_closures WHERE user_id = $1 AND erased_at IS NULL RETURNING user_id', [userId]) : [];
    if (!rows[0]) throw notFound('There is no closed account that can be reinstated.');
    await tx.query(`UPDATE members SET status = 'active' WHERE user_id = $1 AND status = 'resigned'`, [userId]);
    await tx.query('UPDATE profiles SET show_in_directory = true WHERE user_id = $1', [userId]);
    await notify(tx, userId, 'membership_update', 'Your Quintara membership has been reinstated.');
    await audit(tx, staffId, 'account.reinstated', 'user', userId);
  });
}
