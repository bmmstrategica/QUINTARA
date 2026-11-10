/**
 * Paths that measuring coverage showed no test ran: the renewals desk, a membership payment arriving after the
 * application changed, and moving or turning off two-factor authentication.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_APPLICATION } from '@quintara/domain';
import type { ChargeRequest, ChargeResult } from '../src/payments.ts';
import { MockPaymentProvider } from '../src/payments.ts';
import { runRenewals } from '../src/renewals.ts';
import { currentStep, fromBase32, totp } from '../src/two-factor.ts';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

test('the renewals desk: a failing renewal is listed with its reason; finance try the card again once the member fixes it', async () => {
  const s = await startServer();
  try {
    const daniel = s.client();
    await daniel.signIn({ email: 'daniel@example.com' });
    await daniel.saveCard('test_card_declined');
    await s.db.query(`UPDATE members SET term_ends_at = now() - interval '1 hour', auto_renew = true WHERE member_number = 'Q-1002'`);
    assert.equal((await runRenewals(s.db, s.payments)).failed, 1);

    const admin = await s.staff('admin@example.com');
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/renewals')).status, 403);
    const list = (await admin('GET', '/admin/v1/renewals')).body;
    const failing = list.failing.find((r: any) => r.memberNumber === 'Q-1002');
    assert.ok(failing, JSON.stringify(list));
    assert.deepEqual([failing.attempts, failing.cardOnFile, failing.lastFailure], [1, true, 'The card was declined.']);
    assert.ok(!list.upcoming.some((r: any) => r.memberNumber === 'Q-1002'));

    // Still the declined card: finance see why it failed again.
    assert.deepEqual((await admin('POST', `/admin/v1/renewals/${failing.memberId}/retry`)).body, { paid: false, reason: 'The card was declined.' });
    // The member adds a working card; finance try again, and the term runs on.
    await daniel.saveCard('test_card_visa');
    assert.deepEqual((await admin('POST', `/admin/v1/renewals/${failing.memberId}/retry`)).body, { paid: true });
    const after = (await s.db.query<{ term_ends_at: Date; renewal_attempts: number }>(`SELECT term_ends_at, renewal_attempts FROM members WHERE member_number = 'Q-1002'`))[0]!;
    assert.ok(new Date(after.term_ends_at) > new Date(Date.now() + 30 * 86_400_000));
    assert.equal(Number(after.renewal_attempts), 0);
    assert.ok(!(await admin('GET', '/admin/v1/renewals')).body.failing.some((r: any) => r.memberNumber === 'Q-1002'));
    // Not due now, so not charged again.
    assert.equal((await admin('POST', `/admin/v1/renewals/${failing.memberId}/retry`)).status, 409);
    assert.equal((await admin('POST', '/admin/v1/renewals/not-a-member/retry')).status, 404);
  } finally { await s.close(); }
});

/** A provider that lets the test change things while the charge is with the bank. */
class SlowProvider extends MockPaymentProvider {
  whileCharging: (() => Promise<void>) | null = null;
  override async charge(request: ChargeRequest): Promise<ChargeResult> {
    const during = this.whileCharging;
    this.whileCharging = null;
    if (during) await during();
    return super.charge(request);
  }
}

async function approvedApplicant(s: TestServer, name: string) {
  const api = s.client();
  const planId = (await api.listMembershipPlans()).find((p) => p.residency === 'resident' && p.termMonths === 12)!.id;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`;
  await api.submitApplication({ ...EMPTY_APPLICATION, email, fullName: name, city: 'Cape Town', position: 'Director', industry: 'Art', motivation: 'I would like to host gallery evenings for members.', socialPlatform: 'tiktok' as const, socialHandle: 'gallery', phone: '+27 82 555 0123', planId });
  const admin = await s.staff('admin@example.com');
  const app = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === name);
  assert.equal((await admin('POST', `/admin/v1/applications/${app.id}/approve`, { tierId: app.requestedTier.id })).status, 204);
  return { api, appId: app.id as string };
}

test('a membership fee paid after the application changed is refunded, and makes nobody a member', async () => {
  const provider = new SlowProvider();
  const s = await startServer({ payments: provider });
  try {
    const { api, appId } = await approvedApplicant(s, 'Late Payer');
    // While the bank is charging the card, the committee withdraws the offer.
    provider.whileCharging = async () => { await s.db.query(`UPDATE membership_applications SET status = 'declined' WHERE id = $1`, [appId]); };
    await assert.rejects(api.payMembershipFee(), /changed before the payment finished\. You have been refunded/);
    const payment = (await s.db.query<{ status: string; amount_minor: string; refunded_minor: string }>(`SELECT status, amount_minor, refunded_minor FROM payments WHERE application_id = $1`, [appId]))[0]!;
    assert.deepEqual([payment.status, payment.refunded_minor], ['refunded', payment.amount_minor]);
    assert.equal(provider.refunds.length, 1);
    assert.equal((await api.getApplication())!.status, 'declined');
    assert.equal((await s.db.query(`SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = 'late.payer@example.com'`)).length, 0);
  } finally { await s.close(); }
});

/** A browser for the two-factor routes: keeps its cookies and comes from the web app. */
function browser(s: TestServer) {
  const jar = new Map<string, string>();
  return async (method: string, url: string, body?: unknown) => {
    const r = await s.app.inject({ method: method as 'GET', url, headers: { origin: 'http://localhost:3000', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, payload: body as object });
    for (const c of r.cookies) c.value ? jar.set(c.name, c.value) : jar.delete(c.name);
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
}
const codeFor = (secret: string) => totp(fromBase32(secret), currentStep());

test('two-factor: moving to a new phone, new recovery codes, and turning it off where it is optional', async () => {
  const s = await startServer({ twoFactor: { policy: 'optional', key: 'test-two-factor-key-of-at-least-32-chars' } });
  // A code is good once per 30-second step; the test lets the same step be used again instead of waiting.
  const reuse = () => s.db.query(`UPDATE user_mfa SET last_step = 0 WHERE user_id = (SELECT id FROM users WHERE email = 'thandi@example.com')`);
  try {
    const call = browser(s);
    await call('POST', '/v1/session', { email: 'thandi@example.com' });
    const old = (await call('POST', '/v1/auth/2fa/setup', {})).body.secret.replace(/\s/g, '');
    assert.equal((await call('POST', '/v1/auth/2fa/confirm', { code: codeFor(old) })).status, 200);

    // A new phone: set up with a code from the old one. Until the new one is confirmed, the old one still counts.
    await reuse();
    const fresh = (await call('POST', '/v1/auth/2fa/setup', { code: codeFor(old) })).body.secret.replace(/\s/g, '');
    assert.notEqual(fresh, old);
    assert.equal((await s.db.query(`SELECT 1 FROM user_mfa_pending`)).length, 1);
    assert.equal((await call('GET', '/v1/auth/2fa')).body.state, 'on');
    assert.equal((await call('POST', '/v1/auth/2fa/confirm', { code: '000000' })).status, 422);
    assert.equal((await call('POST', '/v1/auth/2fa/confirm', { code: codeFor(fresh) })).status, 200);
    assert.equal((await s.db.query(`SELECT 1 FROM user_mfa_pending`)).length, 0);

    // From now on only the new phone's codes work.
    await reuse();
    assert.equal((await call('POST', '/v1/auth/2fa/recovery-codes', { code: codeFor(old) })).status, 422);
    const codes = await call('POST', '/v1/auth/2fa/recovery-codes', { code: codeFor(fresh) });
    assert.deepEqual([codes.status, codes.body.recoveryCodes.length], [200, 10]);

    // Optional here, so it can be turned off, with a current code; the member is told by email.
    await reuse();
    assert.equal((await call('POST', '/v1/auth/2fa/disable', { code: '123456' })).status, 422);
    assert.equal((await call('POST', '/v1/auth/2fa/disable', { code: codeFor(fresh) })).status, 204);
    assert.equal((await call('GET', '/v1/auth/2fa')).body.state, 'off');
    assert.equal((await s.db.query(`SELECT 1 FROM mfa_recovery_codes rc JOIN users u ON u.id = rc.user_id WHERE u.email = 'thandi@example.com'`)).length, 0);
    assert.ok(s.email.sent.some((m) => m.to === 'thandi@example.com' && m.subject === 'Quintara security: Two-factor authentication is off'));
    const actions = (await s.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'mfa.%' ORDER BY occurred_at`)).map((a) => a.action);
    assert.ok(actions.includes('mfa.recovery_codes_replaced') && actions.includes('mfa.disabled'), actions.join(' '));
  } finally { await s.close(); }
});

/** A provider whose refunds are refused, as a real one may refuse (card closed, refund window passed). */
class RefusingRefunds extends MockPaymentProvider {
  override async refund(): Promise<import('../src/payments.ts').RefundResult> { return { status: 'failed', reason: 'The card account is closed.' }; }
}

test('a refund the provider refuses: the cancellation stands, the money stays recorded as received, finance see it', async () => {
  const s = await startServer({ payments: new RefusingRefunds() });
  try {
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const aura = (await thandi.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const booking = await thandi.payBooking((await thandi.bookExperience(aura.id, 1)).id);
    const admin = await s.staff('admin@example.com');
    const r = await admin('POST', `/admin/v1/bookings/${booking.id}/cancel`, { reason: 'The host has fallen ill.', refund: 'full' });
    assert.deepEqual([r.status, r.body.status, r.body.refundedMinor, r.body.refundFailed], [200, 'cancelled', 0, true]);
    const payment = (await s.db.query<{ id: string; status: string; refunded_minor: string }>(`SELECT id, status, refunded_minor FROM payments WHERE booking_id = $1 AND status = 'paid'`, [booking.id]))[0]!;
    assert.deepEqual([payment.status, Number(payment.refunded_minor)], ['paid', 0]);
    const failed = (await s.db.query<{ changes: { reason: string } }>(`SELECT changes FROM audit_logs WHERE action = 'refund.failed' AND entity_id = $1`, [payment.id]))[0]!;
    assert.equal(failed.changes.reason, 'The card account is closed.');
    // Trying again from the ledger says so plainly and changes nothing.
    const again = await admin('POST', `/admin/v1/payments/${payment.id}/refund`, { reason: 'Second attempt.' });
    assert.equal(again.status, 502);
    assert.equal((await s.db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [payment.id]))[0]!.status, 'paid');
    assert.ok(!(await thandi.listNotifications()).some((n) => n.title.startsWith('We have refunded')), 'nobody is told of a refund that did not happen');
  } finally { await s.close(); }
});

test('Maison: an order cancelled while its payment is with the bank is refunded; one left unpaid too long is released', async () => {
  const provider = new SlowProvider();
  const s = await startServer({ payments: provider });
  try {
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const [product] = (await thandi.listProducts()).filter((p) => p.stock === null || p.stock > 2);
    const courier = (await thandi.listDeliveryOptions())[0]!;
    const order = () => thandi.createOrder({ items: [{ productId: product!.id, option: product!.options[0], quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: '12 Kloof Street, Gardens, Cape Town' });

    const first = await order();
    provider.whileCharging = async () => { await s.db.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [first.id]); };
    await assert.rejects(thandi.payOrder(first.id), /cancelled before the payment finished\. You have been refunded/);
    assert.equal((await s.db.query<{ status: string }>(`SELECT status FROM payments WHERE order_id = $1`, [first.id]))[0]!.status, 'refunded');
    assert.equal(provider.refunds.length, 1);

    const stockBefore = (await s.db.query<{ stock: number | null }>(`SELECT stock FROM products WHERE id = $1`, [product!.id]))[0]!.stock;
    const second = await order();
    await s.db.query(`UPDATE orders SET created_at = now() - interval '2 days' WHERE id = $1`, [second.id]);
    await assert.rejects(thandi.payOrder(second.id), /held for too long without payment/);
    assert.equal((await s.db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [second.id]))[0]!.status, 'cancelled');
    // The piece it held goes back on sale, and no money was taken.
    assert.equal((await s.db.query<{ stock: number | null }>(`SELECT stock FROM products WHERE id = $1`, [product!.id]))[0]!.stock, stockBefore);
    assert.equal((await s.db.query(`SELECT 1 FROM payments WHERE order_id = $1`, [second.id])).length, 0);
  } finally { await s.close(); }
});

test('guest list decisions: declining tells the member; a paid seat offered from the waiting list must be paid within two days', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com');
    const aura = (await admin('GET', '/admin/v1/experiences')).body.find((e: any) => e.title === 'The Aura Enclave');
    // A full experience: the next two members go on the waiting list.
    await admin('PATCH', `/admin/v1/experiences/${aura.id}`, { capacity: Math.max(1, aura.seatsTaken) });
    const [aisha, sipho] = [s.client(), s.client()];
    await aisha.signIn({ email: 'aisha@example.com' }); await sipho.signIn({ email: 'sipho@example.com' });
    const waitA = await aisha.bookExperience(aura.id, 1), waitS = await sipho.bookExperience(aura.id, 1);
    assert.deepEqual([waitA.status, waitS.status], ['waitlisted', 'waitlisted']);

    assert.equal((await admin('POST', `/admin/v1/bookings/${waitS.id}/decision`, { decision: 'decline' })).status < 300, true);
    assert.equal((await sipho.listBookings()).find((b) => b.id === waitS.id)!.status, 'declined');
    assert.ok((await sipho.listNotifications()).some((n) => n.title.startsWith('We could not offer you a place at The Aura Enclave')));

    // No room yet: confirming is refused rather than overfilling.
    assert.equal((await admin('POST', `/admin/v1/bookings/${waitA.id}/decision`, { decision: 'confirm' })).status, 409);
    await admin('PATCH', `/admin/v1/experiences/${aura.id}`, { capacity: aura.seatsTaken + 5 });
    assert.ok((await admin('POST', `/admin/v1/bookings/${waitA.id}/decision`, { decision: 'confirm' })).status < 300);
    const offered = (await aisha.listBookings()).find((b) => b.id === waitA.id)!;
    assert.deepEqual([offered.status, offered.amountDueMinor], ['awaiting_payment', aura.memberPriceMinor]);
    const hours = (new Date(offered.paymentDueAt!).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 47 && hours <= 48, String(hours));
    assert.ok((await aisha.listNotifications()).some((n) => n.title.startsWith('A place is yours at The Aura Enclave')));
    assert.equal((await admin('POST', `/admin/v1/bookings/${waitA.id}/decision`, { decision: 'confirm' })).status, 409);   // decided already
  } finally { await s.close(); }
});

test('closed accounts: staff can reinstate one during the cooling-off period; after it, the scheduled run erases it', async () => {
  const { eraseDueAccounts } = await import('../src/privacy.ts');
  const s = await startServer();
  try {
    const daniel = s.client(), aisha = s.client();
    await daniel.signIn({ email: 'daniel@example.com' }); await aisha.signIn({ email: 'aisha@example.com' });
    await daniel.closeMyAccount('CLOSE'); await aisha.closeMyAccount('CLOSE');
    const id = async (email: string) => (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]))[0]?.id;
    const danielId = (await id('daniel@example.com'))!, aishaId = (await id('aisha@example.com'))!;
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com');

    // Daniel changes his mind: staff reinstate him before the period ends.
    assert.equal((await desk('POST', `/admin/v1/account-closures/${danielId}/reinstate`)).status, 403);
    assert.ok((await admin('POST', `/admin/v1/account-closures/${danielId}/reinstate`)).status < 300);
    assert.equal((await s.db.query<{ status: string }>(`SELECT status FROM members WHERE user_id = $1`, [danielId]))[0]!.status, 'active');
    assert.equal((await admin('POST', `/admin/v1/account-closures/${danielId}/reinstate`)).status, 404);   // nothing left to reinstate

    // Nothing is erased early; once the period has passed, the scheduled run erases Aisha's personal data.
    assert.equal(await eraseDueAccounts(s.db), 0);
    await s.db.query(`UPDATE account_closures SET erase_after = now() - interval '1 minute' WHERE user_id = $1`, [aishaId]);
    assert.equal(await eraseDueAccounts(s.db), 1);
    assert.equal(await id('aisha@example.com'), undefined, 'the email address is gone');
    assert.equal((await s.db.query(`SELECT 1 FROM account_closures WHERE user_id = $1 AND erased_at IS NOT NULL`, [aishaId])).length, 1);
    assert.equal(await eraseDueAccounts(s.db), 0, 'erased once');
    assert.equal((await admin('POST', `/admin/v1/account-closures/${aishaId}/reinstate`)).status, 404);    // too late
  } finally { await s.close(); }
});
