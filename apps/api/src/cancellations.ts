/**
 * Cancellations decided by Quintara (brief 4C: "process authorised cancellations").
 *
 * - One booking: staff cancel a member's booking with a reason, and choose the refund: in full, part of it, or none.
 *   Any refund needs admin.finance.manage as well as admin.bookings.manage, since it moves money.
 * - A whole experience (weather, a venue falling through): every live booking is cancelled and every payment refunded
 *   in full, whatever the experience's own refund window, because Quintara cancelled it. Each guest is told why.
 *   This is the only way an experience becomes 'cancelled' (editing the status directly is refused).
 *
 * Seats come free at once (a cancelled booking no longer counts). Everything is written to the audit log, with the
 * reason and the refund. A refund the provider refuses leaves the cancellation in place and is logged as
 * refund.failed, for finance to settle by hand.
 */
import { staffCan } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { conflict, forbidden, HttpError, notFound, validation } from './errors.ts';
import { refundPayment } from './experiences.ts';
import type { PaymentProvider } from './payments.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ['applied', 'waitlisted', 'awaiting_payment', 'confirmed'];
const reason = z.string().trim().min(3, 'Say why, in a few words. The guest is told.').max(300);

const bookingInput = z.object({
  reason,
  refund: z.enum(['full', 'partial', 'none']),
  /** For a partial refund: how much, in minor units. */
  amountMinor: z.number().int().positive().optional(),
});

export interface StaffCancellation { bookingId: string; status: 'cancelled'; refundedMinor: number; refundFailed: boolean }

export async function cancelBookingForStaff(db: Db, ctx: RequestContext, provider: PaymentProvider, bookingId: string, body: unknown): Promise<StaffCancellation> {
  const staffId = requireStaff(ctx, 'admin.bookings.manage');
  const parsed = bookingInput.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const input = parsed.data;
  if (input.refund !== 'none' && !staffCan(ctx.staffRoles, 'admin.finance.manage')) throw forbidden('Refunds are decided by finance. Cancel without a refund, or ask a Finance Manager.');
  if (input.refund === 'partial' && !input.amountMinor) throw validation([{ path: ['amountMinor'], message: 'Enter the amount to refund.', code: 'custom' } as never]);

  const found = await db.tx(async (tx) => {
    const row = UUID.test(bookingId) ? (await tx.query<{ status: string; user_id: string; title: string }>(
      `SELECT b.status, m.user_id, e.title FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN experiences e ON e.id = b.experience_id
        WHERE b.id = $1 FOR UPDATE OF b`, [bookingId]))[0] : undefined;
    if (!row) throw notFound('This booking does not exist.');
    if (!LIVE.includes(row.status)) throw conflict('This booking is no longer live, so there is nothing to cancel.');
    const payment = (await tx.query<{ id: string; amount_minor: string; refunded_minor: string; currency_code: string }>(
      `SELECT id, amount_minor, refunded_minor, currency_code FROM payments WHERE booking_id = $1 AND status = 'paid'`, [bookingId]))[0] ?? null;
    if (input.refund !== 'none' && !payment) throw conflict('Nothing was paid for this booking, so there is nothing to refund.');
    if (input.refund === 'partial' && payment && input.amountMinor! > Number(payment.amount_minor) - Number(payment.refunded_minor)) {
      throw validation([{ path: ['amountMinor'], message: 'That is more than was paid.', code: 'custom' } as never]);
    }
    await tx.query(`UPDATE experience_bookings SET status = 'cancelled', payment_due_at = NULL, cancelled_by_quintara_reason = $2, updated_at = now() WHERE id = $1`, [bookingId, input.reason]);
    await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'booking_confirmation', $2, $3::jsonb)`,
      [row.user_id, `Your booking for ${row.title} has been cancelled by Quintara. ${input.reason}`, JSON.stringify({ type: 'booking', id: bookingId })]);
    await audit(tx, staffId, 'booking.cancelled_by_staff', 'experience_booking', bookingId, { reason: input.reason, refund: input.refund, amountMinor: input.amountMinor ?? null });
    return { payment };
  });

  let refunded = 0;
  if (found.payment && input.refund !== 'none') refunded = await refundPayment(db, provider, staffId, found.payment.id, input.refund === 'partial' ? input.amountMinor : undefined);
  return { bookingId, status: 'cancelled', refundedMinor: refunded, refundFailed: input.refund !== 'none' && refunded === 0 };
}

export interface ExperienceCancellation { experienceId: string; bookingsCancelled: number; refunds: number; refundedMinor: number; currency: string; refundsFailed: number }

export async function cancelExperience(db: Db, ctx: RequestContext, provider: PaymentProvider, experienceId: string, body: unknown): Promise<ExperienceCancellation> {
  const staffId = requireStaff(ctx, 'admin.experiences.manage');
  const parsed = z.object({ reason }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const why = parsed.data.reason;

  const plan = await db.tx(async (tx) => {
    const experience = UUID.test(experienceId) ? (await tx.query<{ title: string; status: string; currency_code: string }>('SELECT title, status, currency_code FROM experiences WHERE id = $1 FOR UPDATE', [experienceId]))[0] : undefined;
    if (!experience) throw notFound('This experience does not exist.');
    if (experience.status === 'cancelled') throw conflict('This experience is already cancelled.');
    const bookings = await tx.query<{ id: string; user_id: string }>(
      `SELECT b.id, m.user_id FROM experience_bookings b JOIN members m ON m.id = b.member_id WHERE b.experience_id = $1 AND b.status = ANY($2::text[]) FOR UPDATE OF b`, [experienceId, LIVE]);
    await tx.query(`UPDATE experiences SET status = 'cancelled', updated_at = now() WHERE id = $1`, [experienceId]);
    for (const b of bookings) {
      await tx.query(`UPDATE experience_bookings SET status = 'cancelled', payment_due_at = NULL, cancelled_by_quintara_reason = $2, updated_at = now() WHERE id = $1`, [b.id, why]);
      await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'booking_confirmation', $2, $3::jsonb)`,
        [b.user_id, `${experience.title} has been cancelled. ${why} Anything you paid is refunded in full.`, JSON.stringify({ type: 'booking', id: b.id })]);
    }
    const payments = await tx.query<{ id: string }>(`SELECT id FROM payments WHERE booking_id = ANY($1::uuid[]) AND status = 'paid'`, [bookings.map((b) => b.id)]);
    await audit(tx, staffId, 'experience.cancelled', 'experience', experienceId, { reason: why, bookings: bookings.length, payments: payments.length });
    return { bookings: bookings.length, payments: payments.map((p) => p.id), currency: experience.currency_code.trim() };
  });

  // Refunds after the cancellation is committed: a refusal from the provider never undoes the cancellation.
  let refunds = 0, total = 0, failed = 0;
  for (const paymentId of plan.payments) {
    const amount = await refundPayment(db, provider, staffId, paymentId);
    if (amount > 0) { refunds++; total += amount; } else failed++;
  }
  return { experienceId, bookingsCancelled: plan.bookings, refunds, refundedMinor: total, currency: plan.currency, refundsFailed: failed };
}

const refundInput = z.object({
  reason,
  /** Part of what is left; the whole of it when left out. */
  amountMinor: z.number().int().positive().optional(),
});

export interface StaffRefund { paymentId: string; refundedMinor: number; status: 'paid' | 'refunded' }

/**
 * A refund decided by finance, from the payments ledger: the money only, whatever it paid for (a goodwill refund, a
 * booking cancelled earlier without one, a refund the provider first refused). Nothing is cancelled by it. The payer
 * is told; the reason is kept in the audit log.
 */
export async function refundPaymentForStaff(db: Db, ctx: RequestContext, provider: PaymentProvider, paymentId: string, body: unknown): Promise<StaffRefund> {
  const staffId = requireStaff(ctx, 'admin.finance.manage');
  const parsed = refundInput.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const input = parsed.data;
  const payment = UUID.test(paymentId) ? (await db.query<{ status: string; amount_minor: string; refunded_minor: string }>(
    'SELECT status, amount_minor, refunded_minor FROM payments WHERE id = $1', [paymentId]))[0] : undefined;
  if (!payment) throw notFound('This payment does not exist.');
  const left = Number(payment.amount_minor) - Number(payment.refunded_minor);
  if (payment.status !== 'paid' || left <= 0) throw conflict('Only a payment that was received, and not yet refunded in full, can be refunded.');
  if (input.amountMinor && input.amountMinor > left) throw validation([{ path: ['amountMinor'], message: 'That is more than is left to refund.', code: 'custom' } as never]);
  await audit(db, staffId, 'payment.refund_requested', 'payment', paymentId, { reason: input.reason, amountMinor: input.amountMinor ?? left });
  const refunded = await refundPayment(db, provider, staffId, paymentId, input.amountMinor);
  if (refunded === 0) throw new HttpError(502, 'The payment provider did not make the refund. Nothing was returned; it is in the audit log as refund.failed.');
  const after = (await db.query<{ status: 'paid' | 'refunded' }>('SELECT status FROM payments WHERE id = $1', [paymentId]))[0]!;
  return { paymentId, refundedMinor: refunded, status: after.status };
}
