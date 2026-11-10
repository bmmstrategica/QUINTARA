/** Cancellations decided by Quintara: one booking with a refund chosen by finance, or a whole experience. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

async function paidBooking(s: TestServer, email: string, seats = 1) {
  const api = s.client();
  await api.signIn({ email });
  const aura = (await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
  const held = await api.bookExperience(aura.id, seats);
  const paid = await api.payBooking(held.id);
  assert.equal(paid.status, 'confirmed');
  return { api, aura, booking: paid };
}
const paymentOf = async (s: TestServer, bookingId: string) => (await s.db.query<{ status: string; amount_minor: string; refunded_minor: string }>('SELECT status, amount_minor, refunded_minor FROM payments WHERE booking_id = $1 AND status IN ($2, $3)', [bookingId, 'paid', 'refunded']))[0]!;

test('staff cancel a paid booking with a full refund: seats freed, the member told why and refunded', async () => {
  const s = await startServer();
  try {
    const { api, aura, booking } = await paidBooking(s, 'thandi@example.com');
    const before = (await api.getExperience(aura.id)).seatsTaken!;
    const admin = await s.staff('admin@example.com');
    const r = await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'The host has fallen ill.', refund: 'full' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.refundedMinor, r.body.refundFailed], ['cancelled', aura.memberPriceMinor, false]);
    const mine = (await api.listBookings()).find((b) => b.id === booking.id)!;
    assert.deepEqual([mine.status, mine.cancelledByQuintaraReason, mine.refundedMinor], ['cancelled', 'The host has fallen ill.', aura.memberPriceMinor]);
    assert.equal((await api.getExperience(aura.id)).seatsTaken, before - 1);
    const p = await paymentOf(s, booking.id);
    assert.deepEqual([p.status, Number(p.refunded_minor)], ['refunded', aura.memberPriceMinor]);
    const told = (await api.listNotifications()).map((n) => n.title);
    assert.ok(told.some((t) => t.includes('cancelled by Quintara') && t.includes('The host has fallen ill.')));
    assert.ok(told.some((t) => t.startsWith('We have refunded')));
    assert.equal((await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'Again', refund: 'none' })).status, 409);   // only once
  } finally { await s.close(); }
});

test('a partial refund returns part of the payment; more than was paid is refused', async () => {
  const s = await startServer();
  try {
    const { aura, booking } = await paidBooking(s, 'daniel@example.com', 2);
    const admin = await s.staff('admin@example.com');
    const paid = aura.memberPriceMinor * 2;
    assert.equal((await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'One guest could not come.', refund: 'partial', amountMinor: paid + 1 })).status, 422);
    assert.equal((await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'One guest could not come.', refund: 'partial' })).status, 422);
    const r = await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'One guest could not come.', refund: 'partial', amountMinor: paid / 2 });
    assert.equal(r.body.refundedMinor, paid / 2);
    const p = await paymentOf(s, booking.id);
    assert.deepEqual([p.status, Number(p.refunded_minor)], ['paid', paid / 2]);      // part refunded, the rest kept
    assert.equal(s.payments.refunds.at(-1)!.amountMinor, paid / 2);
  } finally { await s.close(); }
});

test('refunds need finance: the concierge desk can cancel, but not refund; nothing paid means nothing to refund', async () => {
  const s = await startServer();
  try {
    const { booking } = await paidBooking(s, 'aisha@example.com');
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'Venue changed.', refund: 'full' })).status, 403);
    assert.equal((await desk('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'x', refund: 'none' })).status, 422);      // a reason is required
    const r = await desk('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'Venue changed.', refund: 'none' });
    assert.deepEqual([r.status, r.body.refundedMinor], [200, 0]);
    assert.equal((await paymentOf(s, booking.id)).status, 'paid');                     // the money stays until finance decides

    const api = s.client();
    await api.signIn({ email: 'sipho@example.com' });
    const yacht = (await api.listExperiences()).find((e) => e.title === 'The Executive Yacht Club')!;
    const free = await api.bookExperience(yacht.id, 1);
    const admin = await s.staff('admin@example.com');
    assert.equal((await admin('POST', `/admin/v1/bookings/${free.id}/cancel`, { reason: 'Overbooked.', refund: 'full' })).status, 409);
    assert.equal((await s.app.inject({ method: 'POST', url: `/admin/v1/bookings/${free.id}/cancel`, payload: { reason: 'Overbooked.', refund: 'none' } })).statusCode, 401);
  } finally { await s.close(); }
});

test('cancelling an experience cancels every booking and refunds everyone in full, even outside the refund window', async () => {
  const s = await startServer();
  try {
    const a = await paidBooking(s, 'thandi@example.com');
    const b = await paidBooking(s, 'daniel@example.com', 2);
    // The refund window has closed for members: a member cancelling now would get nothing back.
    await s.db.query('UPDATE experiences SET refund_hours = 8760 WHERE id = $1', [a.aura.id]);
    const admin = await s.staff('content@example.com');
    assert.equal((await admin('POST', `/admin/v1/experiences/${a.aura.id}/cancel`, { reason: 'Storm warning.' })).status, 403);   // not an experiences role
    const exp = await s.staff('admin@example.com');
    // A plain edit cannot cancel: it would skip the guests and the refunds.
    assert.equal((await exp('PATCH', `/admin/v1/experiences/${a.aura.id}`, { status: 'cancelled' })).status, 409);
    const r = await exp('POST', `/admin/v1/experiences/${a.aura.id}/cancel`, { reason: 'Storm warning for the Atlantic Seaboard.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.bookingsCancelled, r.body.refunds, r.body.refundsFailed, r.body.refundedMinor], [2, 2, 0, a.aura.memberPriceMinor * 3]);
    for (const { api, booking } of [a, b]) {
      const mine = (await api.listBookings()).find((x) => x.id === booking.id)!;
      assert.deepEqual([mine.status, mine.cancelledByQuintaraReason], ['cancelled', 'Storm warning for the Atlantic Seaboard.']);
      assert.ok((await api.listNotifications()).some((n) => n.title.includes('has been cancelled. Storm warning')));
      assert.equal((await paymentOf(s, booking.id)).status, 'refunded');
    }
    assert.equal((await exp('POST', `/admin/v1/experiences/${a.aura.id}/cancel`, { reason: 'Again.' })).status, 409);
    assert.equal((await exp('PATCH', `/admin/v1/experiences/${a.aura.id}`, { status: 'published' })).status, 409);   // not brought back
    const audited = await s.db.query(`SELECT 1 FROM audit_logs WHERE action = 'experience.cancelled' AND entity_id = $1`, [a.aura.id]);
    assert.equal(audited.length, 1);
  } finally { await s.close(); }
});

test('finance refund a payment from the ledger, in part then the rest; the payer is told; nothing is cancelled', async () => {
  const s = await startServer();
  try {
    const { api, booking, aura } = await paidBooking(s, 'thandi@example.com');
    const paymentId = (await s.db.query<{ id: string }>(`SELECT id FROM payments WHERE booking_id = $1 AND status = 'paid'`, [booking.id]))[0]!.id;
    const price = aura.memberPriceMinor;
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'Goodwill.' })).status, 403);
    const admin = await s.staff('admin@example.com');
    assert.equal((await admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'x' })).status, 422);                         // a reason is needed
    assert.equal((await admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'Too much.', amountMinor: price + 1 })).status, 422);

    const part = await admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'The view was blocked.', amountMinor: 1000 });
    assert.deepEqual([part.status, part.body.refundedMinor, part.body.status], [200, 1000, 'paid']);
    assert.equal((await api.listBookings()).find((b) => b.id === booking.id)!.status, 'confirmed');                                    // money only
    const rest = await admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'Goodwill after the venue changed.' });
    assert.deepEqual([rest.body.refundedMinor, rest.body.status], [price - 1000, 'refunded']);
    assert.equal((await admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'Once more.' })).status, 409);
    const ledger = (await admin('GET', '/admin/v1/payments')).body.payments.find((p: any) => p.id === paymentId);
    assert.deepEqual([ledger.status, ledger.refundedMinor], ['refunded', price]);
    assert.equal((await api.listNotifications()).filter((n) => n.title.startsWith('We have refunded')).length, 2);
    const reasons = (await s.db.query<{ changes: { reason: string } }>(`SELECT changes FROM audit_logs WHERE action = 'payment.refund_requested' AND entity_id = $1 ORDER BY occurred_at`, [paymentId])).map((a) => a.changes.reason);
    assert.deepEqual(reasons, ['The view was blocked.', 'Goodwill after the venue changed.']);
  } finally { await s.close(); }
});

test('two refunds asked for at once: the ledger records exactly what the provider refunded', async () => {
  const s = await startServer();
  try {
    const { booking, aura } = await paidBooking(s, 'daniel@example.com');
    const paymentId = (await s.db.query<{ id: string }>(`SELECT id FROM payments WHERE booking_id = $1 AND status = 'paid'`, [booking.id]))[0]!.id;
    const admin = await s.staff('admin@example.com');
    const before = s.payments.refunds.length;
    const both = await Promise.all([1, 2].map(() => admin('POST', `/admin/v1/payments/${paymentId}/refund`, { reason: 'Double click.', amountMinor: 500 })));
    const p = await paymentOf(s, booking.id);
    // However the two requests interleave, the ledger records exactly what the provider refunded: once per distinct
    // refund (the same key twice is one refund at the provider), never more.
    const refundsMade = new Set(s.payments.refunds.slice(before).map((r) => r.idempotencyKey)).size;
    assert.ok(refundsMade >= 1 && refundsMade <= 2);
    assert.equal(Number(p.refunded_minor), 500 * refundsMade, JSON.stringify(both.map((b) => b.status)));
    assert.ok(aura.memberPriceMinor > 500);
  } finally { await s.close(); }
});
