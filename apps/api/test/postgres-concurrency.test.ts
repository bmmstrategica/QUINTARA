/**
 * Races on a real PostgreSQL server, with a pool of connections, so requests truly run at the same time (the in-memory
 * database has one connection and runs them in turn). Skipped unless TEST_DATABASE_URL points at a PostgreSQL server
 * the tests may create databases on; CI runs them against PostgreSQL 16.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres pnpm --filter @quintara/api test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { TestCheckoutProvider } from '../src/payments.ts';
import { freshPostgres, startServer } from './harness.ts';

const skip = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';
const MEMBERS = ['thandi', 'daniel', 'aisha', 'sipho', 'chloe'].map((n) => `${n}@example.com`);

async function server(overrides: Parameters<typeof startServer>[0] = {}) {
  const pg = (await freshPostgres())!;   // startServer migrates and seeds it
  const s = await startServer(overrides, { db: pg.db });
  // Email goes out after each answer; let it finish before the database goes.
  return { ...s, close: async () => { await s.app.flushEmails(); await s.app.close(); await pg.db.close(); await pg.drop(); } };
}
const signedIn = async (s: Awaited<ReturnType<typeof server>>, email: string) => { const api = s.client(); await api.signIn({ email }); return api; };

test('five members race for the last seat: exactly one gets it, the rest are waitlisted', { skip }, async () => {
  const s = await server();
  try {
    const apis = await Promise.all(MEMBERS.map((e) => signedIn(s, e)));
    const yacht = (await apis[0]!.listExperiences()).find((e) => e.title === 'The Executive Yacht Club')!;
    // Complimentary, and one seat left.
    await s.db.query(`UPDATE experiences SET price_minor = 0, member_price_minor = 0, capacity = $2 WHERE id = $1`, [yacht.id, yacht.seatsTaken! + 1]);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(apis.map((api) => api.bookExperience(yacht.id, 1).catch((e) => e)));
      if (round === 0) {
        const statuses = results.map((r) => (r instanceof ApiError ? r.code : r.status)).sort();
        assert.deepEqual(statuses, ['confirmed', 'waitlisted', 'waitlisted', 'waitlisted', 'waitlisted']);
      } else {
        assert.ok(results.every((r) => r instanceof ApiError && r.code === 'conflict'));   // nobody holds two live bookings
      }
    }
    const taken = await s.db.query<{ seats: number; capacity: number }>(`
      SELECT e.seats_held + COALESCE((SELECT sum(b.seats) FROM experience_bookings b WHERE b.experience_id = e.id AND b.status = 'confirmed'), 0)::int AS seats, e.capacity
        FROM experiences e WHERE e.id = $1`, [yacht.id]);
    assert.equal(taken[0]!.seats, taken[0]!.capacity);   // full, never over
  } finally { await s.close(); }
});

test('one member pressing Book many times at once gets one booking', { skip }, async () => {
  const s = await server();
  try {
    const api = await signedIn(s, 'chloe@example.com');
    const costa = (await api.listExperiences()).find((e) => e.title === 'Costa Convivio')!;
    const results = await Promise.all(Array.from({ length: 10 }, () => api.bookExperience(costa.id, 1).catch((e) => e)));
    assert.equal(results.filter((r) => !(r instanceof ApiError)).length, 1);
    const live = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN users u ON u.id = m.user_id
      WHERE b.experience_id = $1 AND u.email = 'chloe@example.com' AND b.status IN ('applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'attended')`, [costa.id]);
    assert.equal(live[0]!.n, 1);
  } finally { await s.close(); }
});

test('the last Maison piece sells once when five buyers order at the same moment', { skip }, async () => {
  const s = await server();
  try {
    const apis = await Promise.all(MEMBERS.map((e) => signedIn(s, e)));
    const candle = (await apis[0]!.listProducts()).find((p) => p.title === 'Fynbos candle')!;
    await s.db.query('UPDATE products SET stock = 1 WHERE id = $1', [candle.id]);
    const courier = (await apis[0]!.listDeliveryOptions())[0]!;
    const order = { items: [{ productId: candle.id, quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: '12 Kloof Street, Gardens, Cape Town' };
    const results = await Promise.all(apis.map((api) => api.createOrder(order).catch((e) => e)));
    assert.equal(results.filter((r) => !(r instanceof ApiError)).length, 1);
    assert.ok(results.filter((r) => r instanceof ApiError).every((r) => r.code === 'conflict'));
    assert.equal((await s.db.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [candle.id]))[0]!.stock, 0);
  } finally { await s.close(); }
});

test('a payment settled by ten webhooks and ten return pages at once is recorded once, with no refund', { skip }, async () => {
  const provider = new TestCheckoutProvider({ apiUrl: 'http://api.test', secret: 'concurrency-test-secret-of-some-length' });
  const s = await server({ payments: provider });
  try {
    const api = await signedIn(s, 'thandi@example.com');
    const aura = (await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const held = await api.bookExperience(aura.id, 1);
    const start = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: 'http://localhost:3000/payments/return' });
    const signed = provider.complete(start.url.split('/test-checkout/')[1]!, 'paid')!;
    const webhook = () => s.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers: { 'content-type': 'application/json', 'x-test-checkout-signature': signed.signature }, payload: signed.body });
    const answers = await Promise.all([
      ...Array.from({ length: 10 }, webhook),
      ...Array.from({ length: 10 }, () => api.getCheckout(start.paymentId)),
    ]);
    assert.ok(answers.slice(0, 10).every((r) => (r as { statusCode: number }).statusCode === 200));
    assert.equal((await api.getCheckout(start.paymentId)).status, 'paid');
    assert.equal(provider.refunds.length, 0);
    const told = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'thandi@example.com' AND n.title = 'Your place at The Aura Enclave is confirmed.'`);
    assert.equal(told[0]!.n, 1);
    const audited = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.paid' AND entity_id = $1`, [start.paymentId]);
    assert.equal(audited[0]!.n, 1);
  } finally { await s.close(); }
});

test('ten Pay presses at once: one charge, the seats confirmed, and no request fails with a server error', { skip }, async () => {
  const s = await server();
  try {
    const api = await signedIn(s, 'sipho@example.com');
    const aura = (await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const held = await api.bookExperience(aura.id, 1);
    const before = s.payments.charges.length;
    const results = await Promise.all(Array.from({ length: 10 }, () => api.payBooking(held.id).catch((e) => e)));
    // Each answer is either the confirmed booking or "nothing to pay"; a deadlock would show as an unknown error.
    for (const r of results) assert.ok(r instanceof ApiError ? r.code === 'conflict' : r.status === 'confirmed', r instanceof ApiError ? r.message : r.status);
    assert.equal(s.payments.charges.length, before + 1);
    assert.equal((await api.listBookings()).find((b) => b.id === held.id)!.status, 'confirmed');
  } finally { await s.close(); }
});
