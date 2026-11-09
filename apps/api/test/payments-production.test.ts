/**
 * Production must never confirm anything as paid without money being taken. Until a real provider's adapter is
 * configured, production uses UnavailablePaymentProvider: these tests run the real API with it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePaymentProvider, MockPaymentProvider, takesRealPayments, UnavailablePaymentProvider } from '../src/payments.ts';
import { startServer } from './harness.ts';

test('production never chooses the simulated provider, except on a staging deployment that says so', () => {
  assert.ok(choosePaymentProvider({ production: true }) instanceof UnavailablePaymentProvider);
  assert.ok(choosePaymentProvider({ production: true, deployEnv: 'production' }) instanceof UnavailablePaymentProvider);
  assert.ok(choosePaymentProvider({ production: true, deployEnv: 'staging' }) instanceof MockPaymentProvider);
  assert.ok(choosePaymentProvider({ production: false }) instanceof MockPaymentProvider);
  assert.equal(takesRealPayments(new MockPaymentProvider()), false);
  assert.equal(takesRealPayments(new UnavailablePaymentProvider()), false);
});

test('with payments unavailable, a held booking cannot be paid, stays held, and no payment is recorded as paid', async () => {
  const server = await startServer({ payments: new UnavailablePaymentProvider() as unknown as MockPaymentProvider });
  try {
    const api = server.client();
    await api.signIn({ email: 'thandi@example.com' });
    const aura = (await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const held = await api.bookExperience(aura.id, 1);
    assert.equal(held.status, 'awaiting_payment');
    await assert.rejects(api.payBooking(held.id), (error: { message?: string }) => /not available yet/.test(error.message ?? ''));
    const after = (await api.listBookings()).find((b) => b.id === held.id)!;
    assert.equal(after.status, 'awaiting_payment');
    const paid = await server.db.query(`SELECT count(*)::int AS n FROM payments WHERE booking_id = $1 AND status = 'paid'`, [held.id]);
    assert.equal(paid[0]!.n, 0);
    // The apps are told no test cards are on offer.
    const config = await server.app.inject({ method: 'GET', url: '/v1/payments/config' });
    assert.deepEqual(JSON.parse(config.body), { provider: 'unavailable', testCards: false });
  } finally {
    await server.close();
  }
});
