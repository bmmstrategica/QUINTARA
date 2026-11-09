import { randomBytes } from 'node:crypto';
import { can, formatMoney } from '@quintara/domain';
import type { Booking, BookingStatus, Experience } from '@quintara/domain';
import { audit, requireMember, requirePermission } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import type { PaymentProvider } from './payments.ts';
import { conflict, forbidden, HttpError, notFound } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: BookingStatus[] = ['applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'attended'];

/** One query shape for lists and single reads: the row plus seats taken and whether this member is invited. */
const SELECT_EXPERIENCE = `
  SELECT e.*,
         e.seats_held + COALESCE((SELECT SUM(b.seats) FROM experience_bookings b WHERE b.experience_id = e.id AND (b.status = 'confirmed' OR (b.status = 'awaiting_payment' AND b.payment_due_at > now()))), 0) AS seats_taken,
         EXISTS (SELECT 1 FROM experience_invitations i WHERE i.experience_id = e.id AND i.member_id = $1) AS invited
    FROM experiences e
   WHERE e.status = 'published'`;

/** For staff: every experience, whatever its status or visibility. */
export const SELECT_EXPERIENCE_ALL = SELECT_EXPERIENCE.replace("WHERE e.status = 'published'", 'WHERE true');

/** Members see everything that is not hidden, plus hidden experiences they are invited to. Guests and visitors see what staff have opened to guests. */
const visibility = (ctx: RequestContext) =>
  can({ roles: ctx.roles }, 'experiences.view_member')
    ? `AND (NOT e.is_hidden OR EXISTS (SELECT 1 FROM experience_invitations i WHERE i.experience_id = e.id AND i.member_id = $1))`
    : `AND e.open_to_guests AND NOT e.is_hidden`;

/**
 * Dates and seat counts are for members. For guests and visitors they are left out of the reply altogether,
 * not merely hidden by the apps. Staff screens pass `full`.
 */
export function toExperience(row: Row, full = true): Experience {
  return {
    id: row.id as string,
    marketId: row.market_id as string,
    title: row.title as string,
    category: row.category as string,
    summary: row.summary as string,
    description: row.description as string,
    startsAt: full ? new Date(row.starts_at as string).toISOString() : null,
    timezone: row.timezone as string,
    venueName: row.venue_name as string,
    area: row.area as string,
    dressCode: row.dress_code as string,
    host: row.host as string,
    programme: row.programme as Experience['programme'],
    included: row.included as string[],
    capacity: full ? Number(row.capacity) : null,
    seatsTaken: full ? Number(row.seats_taken) : null,
    priceMinor: Number(row.price_minor),
    memberPriceMinor: Number(row.member_price_minor),
    currency: (row.currency_code as string).trim(),
    admission: row.admission as Experience['admission'],
    guestPolicy: row.guest_policy as string,
    openToGuests: Boolean(row.open_to_guests),
    maxSeatsPerBooking: Number(row.max_seats_per_booking),
    invited: Boolean(row.invited),
  };
}

function toBooking(row: Row): Booking {
  return {
    id: row.id as string,
    experienceId: row.experience_id as string,
    experienceTitle: row.title as string,
    startsAt: new Date(row.starts_at as string).toISOString(),
    timezone: row.timezone as string,
    venueName: row.venue_name as string,
    area: row.area as string,
    seats: Number(row.seats),
    status: row.status as BookingStatus,
    ticketCode: row.ticket_code as string,
    currency: (row.currency_code as string).trim(),
    amountDueMinor: row.status === 'awaiting_payment' ? Number(row.amount_due_minor) : 0,
    paymentDueAt: row.status === 'awaiting_payment' && row.payment_due_at ? new Date(row.payment_due_at as string).toISOString() : null,
    refundedMinor: Number(row.refunded_minor),
  };
}

const SELECT_BOOKING = `
  SELECT b.id, b.experience_id, b.seats, b.status, b.ticket_code, b.amount_due_minor, b.payment_due_at, e.title, e.starts_at, e.timezone, e.venue_name, e.area, e.currency_code,
         COALESCE((SELECT SUM(p.refunded_minor) FROM payments p WHERE p.booking_id = b.id), 0) AS refunded_minor
    FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id`;

export async function listExperiences(db: Queryable, ctx: RequestContext): Promise<Experience[]> {
  requirePermission(ctx, 'experiences.view_public');
  // The calendar is the city's: switching city shows that city's experiences.
  const rows = await db.query(`${SELECT_EXPERIENCE} ${visibility(ctx)} AND e.market_id = $2 ORDER BY e.starts_at`, [ctx.session?.memberId ?? null, ctx.marketId]);
  const full = can({ roles: ctx.roles }, 'experiences.view_member');
  return rows.map((row) => toExperience(row, full));
}

export async function getExperience(db: Queryable, ctx: RequestContext, id: string): Promise<Experience> {
  requirePermission(ctx, 'experiences.view_public');
  // A hidden experience is reported as missing, never as forbidden, so its existence does not leak.
  const rows = UUID.test(id) ? await db.query(`${SELECT_EXPERIENCE} ${visibility(ctx)} AND e.id = $2`, [ctx.session?.memberId ?? null, id]) : [];
  if (!rows[0]) throw notFound('This experience is not available.');
  return toExperience(rows[0], can({ roles: ctx.roles }, 'experiences.view_member'));
}

export async function bookExperience(db: Db, ctx: RequestContext, experienceId: string, seats: unknown): Promise<Booking> {
  const session = requireMember(ctx, 'experiences.book');
  return db.tx(async (tx) => {
    // Lock the experience row so two bookings cannot both take the last seat.
    const locked = UUID.test(experienceId) ? await tx.query<{ payment_hold_minutes: number }>(`SELECT payment_hold_minutes FROM experiences WHERE id = $1 AND status = 'published' FOR UPDATE`, [experienceId]) : [];
    if (!locked[0]) throw notFound('This experience is not available.');
    // Holds that were never paid give their seats back.
    await tx.query(`UPDATE experience_bookings SET status = 'cancelled', updated_at = now() WHERE experience_id = $1 AND status = 'awaiting_payment' AND payment_due_at <= now()`, [experienceId]);
    const experience = await getExperience(tx, ctx, experienceId);

    if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > experience.maxSeatsPerBooking) {
      throw new HttpError(422, `Choose between 1 and ${experience.maxSeatsPerBooking} seats.`, { seats: 'Choose a valid number of seats' });
    }
    if (experience.admission === 'invitation_only' && !experience.invited) throw forbidden('This experience is by invitation.');
    const existing = await tx.query('SELECT 1 FROM experience_bookings WHERE experience_id = $1 AND member_id = $2 AND status = ANY($3::text[])', [experienceId, session.memberId, LIVE]);
    if (existing[0]) throw conflict('You already have a booking for this experience.');

    const amountDue = experience.memberPriceMinor * seats;
    // A paid experience holds the seats while the member pays; a complimentary one is confirmed at once.
    const status: BookingStatus =
      experience.admission === 'application_required' ? 'applied' : (experience.seatsTaken ?? 0) + seats > (experience.capacity ?? 0) ? 'waitlisted' : amountDue > 0 ? 'awaiting_payment' : 'confirmed';
    const ticketCode = 'QT-' + randomBytes(5).toString('hex').toUpperCase();
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO experience_bookings (experience_id, member_id, seats, status, ticket_code, amount_due_minor, payment_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'awaiting_payment' THEN now() + make_interval(mins => $7) END) RETURNING id`,
      [experienceId, session.memberId, seats, status, ticketCode, status === 'awaiting_payment' ? amountDue : 0, Number(locked[0].payment_hold_minutes)],
    );
    const bookingId = inserted[0]!.id;
    if (status === 'confirmed') {
      await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'booking_confirmation', $2, $3::jsonb)`, [
        session.userId,
        `Your place at ${experience.title} is confirmed.`,
        JSON.stringify({ type: 'booking', id: bookingId }),
      ]);
    }
    await audit(tx, session.userId, 'booking.created', 'experience_booking', bookingId, { experienceId, seats, status });
    const rows = await tx.query(`${SELECT_BOOKING} WHERE b.id = $1`, [bookingId]);
    return toBooking(rows[0]!);
  });
}

export async function listBookings(db: Queryable, ctx: RequestContext): Promise<Booking[]> {
  const session = requireMember(ctx, 'experiences.book');
  const rows = await db.query(`${SELECT_BOOKING} WHERE b.member_id = $1 ORDER BY e.starts_at`, [session.memberId]);
  return rows.map(toBooking);
}

/**
 * Pays for held seats and confirms the booking. The card never reaches Quintara: the provider charges it.
 * The charge happens between two short transactions so no database lock is held during the network call.
 */
export async function payBooking(db: Db, ctx: RequestContext, provider: PaymentProvider, bookingId: string): Promise<Booking> {
  const session = requireMember(ctx, 'experiences.book');
  const prepared = await db.tx(async (tx) => {
    const rows = UUID.test(bookingId)
      ? await tx.query<{ status: BookingStatus; amount_due_minor: string; lapsed: boolean; title: string; currency_code: string; market_id: string }>(
          `SELECT b.status, b.amount_due_minor, b.payment_due_at <= now() AS lapsed, e.title, e.currency_code, e.market_id
             FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.id = $1 AND b.member_id = $2 FOR UPDATE OF b`, [bookingId, session.memberId])
      : [];
    const booking = rows[0];
    if (!booking) throw notFound('This booking is not available.');
    if (booking.status !== 'awaiting_payment') throw conflict('This booking has nothing to pay.');
    if (booking.lapsed) {
      await tx.query(`UPDATE experience_bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [bookingId]);
      await audit(tx, session.userId, 'booking.hold_lapsed', 'experience_booking', bookingId);
      return null;
    }
    // Keep the seats for the few moments the charge takes, even if the hold was about to end.
    await tx.query(`UPDATE experience_bookings SET payment_due_at = GREATEST(payment_due_at, now() + interval '5 minutes') WHERE id = $1`, [bookingId]);
    const failed = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM payments WHERE booking_id = $1 AND status = 'failed'`, [bookingId]))[0]!.n);
    // The key comes from the booking itself, not from the caller, so two tabs or a double click
    // can only ever produce one charge. It moves on only after a declined attempt.
    const key = `booking:${bookingId}:${failed}`;
    const amount = Number(booking.amount_due_minor), currency = booking.currency_code.trim();
    const payment = (await tx.query<{ id: string; status: string; booking_id: string | null }>(
      `INSERT INTO payments (user_id, market_id, purpose, booking_id, amount_minor, currency_code, provider, idempotency_key)
       VALUES ($1, $2, 'experience', $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING id, status, booking_id`,
      [session.userId, booking.market_id, bookingId, amount, currency, provider.name, key]))[0]!;
    if (payment.booking_id !== bookingId) throw conflict('That payment reference belongs to something else.');
    return { key, amount, currency, title: booking.title, paymentId: payment.id };
  });
  if (!prepared) throw conflict('The hold on your seats has ended. Please book again.');

  const result = await provider.charge({ amountMinor: prepared.amount, currency: prepared.currency, description: prepared.title, idempotencyKey: prepared.key, customerReference: session.userId });
  if (result.status === 'failed') {
    await db.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [prepared.paymentId, result.reason]);
    throw new HttpError(402, `The payment did not go through. ${result.reason}`);
  }
  const confirmed = await db.tx(async (tx) => {
    const current = await tx.query<{ status: BookingStatus }>('SELECT status FROM experience_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    await tx.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = COALESCE(paid_at, now()), updated_at = now() WHERE id = $1 AND status <> 'refunded'`, [prepared.paymentId, result.providerPaymentId]);
    if (current[0]?.status === 'confirmed') return true;                 // a repeat of a request that already succeeded
    if (current[0]?.status !== 'awaiting_payment') return false;         // cancelled while the charge was in flight
    await tx.query(`UPDATE experience_bookings SET status = 'confirmed', payment_due_at = NULL, updated_at = now() WHERE id = $1`, [bookingId]);
    await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'booking_confirmation', $2, $3::jsonb)`, [session.userId, `Your place at ${prepared.title} is confirmed.`, JSON.stringify({ type: 'booking', id: bookingId })]);
    await audit(tx, session.userId, 'payment.paid', 'payment', prepared.paymentId, { purpose: 'experience', amountMinor: prepared.amount, bookingId });
    return true;
  });
  if (!confirmed) {
    await refundPayment(db, provider, session.userId, prepared.paymentId);
    throw conflict('This booking was cancelled before the payment finished. You have been refunded.');
  }
  return toBooking((await db.query(`${SELECT_BOOKING} WHERE b.id = $1`, [bookingId]))[0]!);
}

/** Returns a paid payment in full. Safe to repeat: the provider de-duplicates on the key. */
export async function refundPayment(db: Db, provider: PaymentProvider, actorUserId: string, paymentId: string): Promise<void> {
  const rows = await db.query<{ provider_payment_id: string | null; amount_minor: string; currency_code: string; status: string }>('SELECT provider_payment_id, amount_minor, currency_code, status FROM payments WHERE id = $1', [paymentId]);
  const payment = rows[0];
  if (!payment || payment.status !== 'paid' || !payment.provider_payment_id) return;
  const result = await provider.refund({ providerPaymentId: payment.provider_payment_id, amountMinor: Number(payment.amount_minor), currency: payment.currency_code.trim(), idempotencyKey: `refund:${paymentId}` });
  if (result.status === 'failed') {
    // The booking stays cancelled; staff see this entry and settle the refund by hand.
    await audit(db, actorUserId, 'refund.failed', 'payment', paymentId, { reason: result.reason });
    return;
  }
  await db.query(`UPDATE payments SET status = 'refunded', refunded_minor = amount_minor, refunded_at = now(), provider_refund_id = $2, updated_at = now() WHERE id = $1`, [paymentId, result.providerRefundId]);
  await db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'booking_confirmation', $2)`, [actorUserId, `We have refunded ${formatMoney(Number(payment.amount_minor), payment.currency_code.trim())} to your original payment method.`]);
  await audit(db, actorUserId, 'payment.refunded', 'payment', paymentId, { amountMinor: Number(payment.amount_minor) });
}

export async function cancelBooking(db: Db, ctx: RequestContext, provider: PaymentProvider, bookingId: string): Promise<Booking> {
  const session = requireMember(ctx, 'experiences.book');
  const refundable = await db.tx(async (tx) => {
    // Scoped to the member: another member's booking id is simply not found.
    const rows = UUID.test(bookingId)
      ? await tx.query<{ status: BookingStatus; in_time: boolean }>(
          `SELECT b.status, e.starts_at - make_interval(hours => e.refund_hours) >= now() AS in_time
             FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.id = $1 AND b.member_id = $2 FOR UPDATE OF b`, [bookingId, session.memberId])
      : [];
    if (!rows[0]) throw notFound('This booking is not available.');
    if (!['applied', 'waitlisted', 'awaiting_payment', 'confirmed'].includes(rows[0].status)) throw conflict('This booking can no longer be cancelled.');
    await tx.query(`UPDATE experience_bookings SET status = 'cancelled', payment_due_at = NULL, updated_at = now() WHERE id = $1`, [bookingId]);
    await audit(tx, session.userId, 'booking.cancelled', 'experience_booking', bookingId, { refund: rows[0].in_time });
    // A full refund while the experience's refund window is open; nothing after it closes.
    if (!rows[0].in_time) return null;
    return (await tx.query<{ id: string }>(`SELECT id FROM payments WHERE booking_id = $1 AND status = 'paid'`, [bookingId]))[0]?.id ?? null;
  });
  if (refundable) await refundPayment(db, provider, session.userId, refundable);
  return toBooking((await db.query(`${SELECT_BOOKING} WHERE b.id = $1`, [bookingId]))[0]!);
}
