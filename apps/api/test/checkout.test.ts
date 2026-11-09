/**
 * Paying through a hosted checkout, with the test checkout standing in for a provider: the member is sent to the
 * provider's page, the outcome comes back as a signed webhook, and the return page asks how it stands. Settling must be
 * exactly once, and money for something already paid or cancelled must go back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { EMPTY_APPLICATION } from '@quintara/domain';
import { TestCheckoutProvider } from '../src/payments.ts';
import { startServer } from './harness.ts';

const RETURN = 'http://localhost:3000/payments/return';
const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const refOf = (url: string) => url.split('/test-checkout/')[1]!;

async function setup() {
  const provider = new TestCheckoutProvider({ apiUrl: 'http://api.test', secret: 'test-checkout-secret-of-some-length' });
  const s = await startServer({ payments: provider });
  const api = s.client();
  await api.signIn({ email: 'thandi@example.com' });
  /** The member's browser on the provider's page: Pay or Decline, then back to the app. */
  const choose = async (url: string, outcome: 'paid' | 'declined') => s.app.inject({ method: 'GET', url: `/v1/payments/test-checkout/${refOf(url)}/complete?outcome=${outcome}` });
  const holdAura = async () => api.bookExperience((await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!.id, 1);
  return { s, provider, api, choose, holdAura };
}

test('a held booking is paid through the checkout: redirect, signed webhook, return page; settled once', async () => {
  const { s, provider, api, choose, holdAura } = await setup();
  try {
    assert.equal((await api.getPaymentConfig()).checkout, 'hosted');
    const held = await holdAura();
    await assert.rejects(api.payBooking(held.id), fails('conflict'));      // no direct charge with a hosted provider

    const start = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    assert.match(start.url, /^http:\/\/api\.test\/v1\/payments\/test-checkout\/tc_/);
    assert.equal((await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN })).url, start.url);   // asking again: the same page
    assert.equal((await api.getCheckout(start.paymentId)).status, 'pending');

    // The provider's page shows what is paid, and runs no script.
    const page = await s.app.inject({ method: 'GET', url: `/v1/payments/test-checkout/${refOf(start.url)}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /The Aura Enclave/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /script-src/);

    const back = await choose(start.url, 'paid');
    assert.equal(back.statusCode, 303);
    assert.equal(back.headers.location, `${RETURN}?payment=${start.paymentId}`);
    const status = await api.getCheckout(start.paymentId);
    assert.deepEqual([status.status, status.purpose, status.targetId], ['paid', 'experience', held.id]);
    assert.equal((await api.listBookings()).find((b) => b.id === held.id)!.status, 'confirmed');

    // The provider sends the webhook again: nothing changes, and the member is told once.
    const again = provider.complete(refOf(start.url), 'paid')!;
    const replay = await s.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers: { 'content-type': 'application/json', 'x-test-checkout-signature': again.signature }, payload: again.body });
    assert.equal(replay.statusCode, 200);
    const told = (await api.listNotifications()).filter((n) => n.title === 'Your place at The Aura Enclave is confirmed.');
    assert.equal(told.length, 1);
    const paid = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE booking_id = $1 AND status = 'paid'`, [held.id]);
    assert.equal(paid[0]!.n, 1);
  } finally { await s.close(); }
});

test('webhooks must carry the provider’s signature; unknown checkouts are ignored', async () => {
  const { s, provider } = await setup();
  try {
    const body = JSON.stringify({ type: 'checkout.updated', checkoutRef: 'tc_forged', state: { status: 'paid', providerPaymentId: 'x' } });
    const forged = await s.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers: { 'content-type': 'application/json', 'x-test-checkout-signature': 'f'.repeat(64) }, payload: body });
    assert.equal(forged.statusCode, 401);
    const unsigned = await s.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers: { 'content-type': 'application/json' }, payload: body });
    assert.equal(unsigned.statusCode, 401);
    const signedUnknown = await s.app.inject({ method: 'POST', url: '/v1/payments/webhook', headers: { 'content-type': 'application/json', 'x-test-checkout-signature': provider.sign(body) }, payload: body });
    assert.equal(signedUnknown.statusCode, 200);
  } finally { await s.close(); }
});

test('if the webhook is late, the return page asks the provider and settles', async () => {
  const { s, provider, api, holdAura } = await setup();
  try {
    const held = await holdAura();
    const start = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    provider.complete(refOf(start.url), 'paid');               // paid at the provider; no webhook delivered
    assert.equal((await api.getCheckout(start.paymentId)).status, 'paid');
    assert.equal((await api.listBookings()).find((b) => b.id === held.id)!.status, 'confirmed');
  } finally { await s.close(); }
});

test('a declined card leaves the seats held; trying again opens a new checkout that can succeed', async () => {
  const { s, api, choose, holdAura } = await setup();
  try {
    const held = await holdAura();
    const first = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    await choose(first.url, 'declined');
    const declined = await api.getCheckout(first.paymentId);
    assert.equal(declined.status, 'failed');
    assert.match(declined.reason ?? '', /declined/);
    assert.equal((await api.listBookings()).find((b) => b.id === held.id)!.status, 'awaiting_payment');

    const second = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    assert.notEqual(second.paymentId, first.paymentId);
    assert.notEqual(second.url, first.url);
    await choose(second.url, 'paid');
    assert.equal((await api.getCheckout(second.paymentId)).status, 'paid');
  } finally { await s.close(); }
});

test('money that arrives after the booking was cancelled is refunded, and the booking stays cancelled', async () => {
  const { s, provider, api, choose, holdAura } = await setup();
  try {
    const held = await holdAura();
    const start = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    await api.cancelBooking(held.id);
    await choose(start.url, 'paid');
    assert.equal((await api.getCheckout(start.paymentId)).status, 'refunded');
    assert.equal((await api.listBookings()).find((b) => b.id === held.id)!.status, 'cancelled');
    assert.equal(provider.refunds.length, 1);
  } finally { await s.close(); }
});

test('a Maison Quintara order and a membership fee are paid the same way', async () => {
  const { s, api, choose } = await setup();
  try {
    const candle = (await api.listProducts()).find((p) => p.title === 'Fynbos candle')!;
    const courier = (await api.listDeliveryOptions())[0]!;
    const order = await api.createOrder({ items: [{ productId: candle.id, quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: '12 Kloof Street, Gardens, Cape Town' });
    const pay = await api.startCheckout({ purpose: 'boutique', id: order.id, returnUrl: 'http://localhost:3000/boutique' });
    await choose(pay.url, 'paid');
    assert.equal((await api.getCheckout(pay.paymentId)).status, 'paid');
    assert.equal((await api.listOrders()).find((o) => o.id === order.id)!.status, 'paid');

    // An applicant approved by the committee pays the fee, and the membership starts.
    const applicant = s.client();
    const planId = (await applicant.listMembershipPlans()).find((p) => p.residency === 'resident' && p.termMonths === 12)!.id;
    await applicant.submitApplication({ ...EMPTY_APPLICATION, email: 'checkout.applicant@example.com', fullName: 'Checkout Applicant', city: 'Cape Town', position: 'Director', industry: 'Art', motivation: 'I would like to host gallery evenings for members.', socialPlatform: 'tiktok' as const, socialHandle: 'checkout.art', phone: '+27 82 555 0199', planId });
    const admin = await s.staff('admin@example.com');
    const application = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === 'Checkout Applicant');
    assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/approve`, { tierId: application.requestedTier.id })).status, 204);
    const fee = await applicant.startCheckout({ purpose: 'membership', returnUrl: RETURN });
    await choose(fee.url, 'paid');
    assert.equal((await applicant.getCheckout(fee.paymentId)).status, 'paid');
    assert.equal((await applicant.getApplication())?.status, 'active');
    await assert.rejects(applicant.startCheckout({ purpose: 'membership', returnUrl: RETURN }), fails('conflict'));   // nothing left to pay
  } finally { await s.close(); }
});

test('only Quintara apps can be returned to, and nobody can see another person’s payment', async () => {
  const { s, api, holdAura } = await setup();
  try {
    const held = await holdAura();
    await assert.rejects(api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: 'https://evil.example/steal' }), fails('validation'));
    const start = await api.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN });
    const other = s.client();
    await other.signIn({ email: 'aisha@example.com' });
    await assert.rejects(other.getCheckout(start.paymentId), fails('not_found'));
    await assert.rejects(other.startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN }), fails('not_found'));
    await assert.rejects(s.client().startCheckout({ purpose: 'experience', id: held.id, returnUrl: RETURN }), fails('unauthenticated'));
  } finally { await s.close(); }
});
