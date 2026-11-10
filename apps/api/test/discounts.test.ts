/** Discounts on membership fees, granted by finance when the committee approves an application. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_APPLICATION } from '@quintara/domain';
import { TestCheckoutProvider } from '../src/payments.ts';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

/** An applicant who has applied for the resident twelve-month plan; returns their client and the application. */
async function applicant(s: TestServer, name: string) {
  const api = s.client();
  const planId = (await api.listMembershipPlans()).find((p) => p.residency === 'resident' && p.termMonths === 12)!.id;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`;
  await api.submitApplication({ ...EMPTY_APPLICATION, email, fullName: name, city: 'Cape Town', position: 'Director', industry: 'Art', motivation: 'I would like to host gallery evenings for members.', socialPlatform: 'tiktok' as const, socialHandle: 'gallery', phone: '+27 82 555 0123', planId });
  const admin = await s.staff('admin@example.com');
  const app = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === name);
  return { api, app, admin, tierId: app.requestedTier.id as string, price: app.requestedTier.priceMinor as number };
}

test('a percentage discount lowers what is charged, and the applicant sees the fee, the discount and what is due', async () => {
  const s = await startServer();
  try {
    const { api, app, admin, tierId } = await applicant(s, 'Discount Percent');
    const r = await admin('POST', `/admin/v1/applications/${app.id}/approve`, { tierId, discount: { kind: 'percent', value: 25, reason: 'Founding circle' } });
    assert.equal(r.status, 204, JSON.stringify(r.body));
    const fee = (await api.getApplication())!.fee!;
    assert.equal(fee.discountMinor, Math.round(fee.priceMinor * 0.25));
    assert.deepEqual([fee.dueMinor, fee.discountReason], [fee.priceMinor - fee.discountMinor, 'Founding circle']);
    const before = s.payments.charges.length;
    assert.equal((await api.payMembershipFee()).status, 'active');
    assert.equal(s.payments.charges.length, before + 1);
    assert.equal(s.payments.charges.at(-1)!.amountMinor, fee.dueMinor);
    const audited = (await s.db.query<{ changes: { discountMinor: number; discountReason: string } }>(`SELECT changes FROM audit_logs WHERE action = 'application.approved' AND entity_id = $1`, [app.id]))[0]!;
    assert.deepEqual([audited.changes.discountMinor, audited.changes.discountReason], [fee.discountMinor, 'Founding circle']);
  } finally { await s.close(); }
});

test('the hosted checkout charges the discounted fee too', async () => {
  const provider = new TestCheckoutProvider({ apiUrl: 'http://api.test', secret: 'discount-test-secret-of-some-length' });
  const s = await startServer({ payments: provider });
  try {
    const { api, app, admin, tierId, price } = await applicant(s, 'Discount Checkout');
    assert.equal((await admin('POST', `/admin/v1/applications/${app.id}/approve`, { tierId, discount: { kind: 'amount', value: 500_000, reason: 'Referred by a founder' } })).status, 204);
    const start = await api.startCheckout({ purpose: 'membership', returnUrl: 'http://localhost:3000/payments/return' });
    const checkout = [...provider.checkouts.values()].find((c) => c.request.paymentId === start.paymentId)!;
    assert.equal(checkout.request.amountMinor, price - 500_000);
  } finally { await s.close(); }
});

test('only finance grants discounts; impossible ones are refused; a full discount starts the membership at once', async () => {
  const s = await startServer({ staffSeats: 10 });
  try {
    const admin = await s.staff('admin@example.com');
    assert.equal((await admin('POST', '/admin/v1/staff', { fullName: 'Membership Lead', email: 'membership.lead@quintara.test', role: 'membership' })).status, 200);
    const membership = await s.staff('membership.lead@quintara.test');

    const one = await applicant(s, 'Discount Rules');
    const approve = (who: typeof admin, discount?: unknown) => who('POST', `/admin/v1/applications/${one.app.id}/approve`, { tierId: one.tierId, discount });
    assert.equal((await approve(membership, { kind: 'percent', value: 10, reason: 'Friend of the club' })).status, 403);
    assert.equal((await approve(admin, { kind: 'percent', value: 120, reason: 'Too much' })).status, 422);
    assert.equal((await approve(admin, { kind: 'amount', value: one.price + 1, reason: 'Too much' })).status, 422);
    assert.equal((await approve(admin, { kind: 'percent', value: 10, reason: '' })).status, 422);
    assert.equal((await approve(membership)).status, 204);                        // approving without a discount needs no finance
    assert.equal((await one.api.getApplication())!.fee!.discountMinor, 0);

    const two = await applicant(s, 'Discount Whole');
    assert.equal((await admin('POST', `/admin/v1/applications/${two.app.id}/approve`, { tierId: two.tierId, discount: { kind: 'percent', value: 100, reason: 'Honorary membership' } })).status, 204);
    assert.equal((await two.api.getApplication())!.status, 'active');             // nothing to pay
  } finally { await s.close(); }
});
