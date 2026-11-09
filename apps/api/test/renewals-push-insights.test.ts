/** Push notifications, automatic membership renewals, and the fuller Insights with its weekly report. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { startServer } from './harness.ts';
import { dispatchPush, MockPushProvider } from '../src/push.ts';
import { runRenewals } from '../src/renewals.ts';
import { sendWeeklyReport } from '../src/insights.ts';

const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const token = (n: string) => `ExponentPushToken[${n.padEnd(12, 'x')}]`;

test('push: phones register with their session; discreet by default; muted kinds and old ones are not pushed; signing out stops them', async () => {
  const s = await startServer();
  try {
    const push = new MockPushProvider();
    const thandi = s.client();
    await assert.rejects(thandi.registerPushDevice({ token: token('aaa'), platform: 'ios' }), fails('unauthenticated'));
    await thandi.signIn({ email: 'thandi@example.com' });
    await assert.rejects(thandi.registerPushDevice({ token: 'not-a-token', platform: 'ios' }), fails('validation'));
    await thandi.registerPushDevice({ token: token('thandi1'), platform: 'ios', deviceName: 'iPhone' });
    const settings = await thandi.getPushSettings();
    assert.equal(settings.devices.length, 1);
    assert.equal(settings.devices[0]!.thisDevice, true);
    assert.equal(settings.showDetails, false);
    assert.ok(!JSON.stringify(settings).includes('thandi1'), 'the push token is never sent back');
    const userId = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    const notify = (category: string, title: string, ago = '0 minutes') => s.db.query(`INSERT INTO notifications (user_id, category, title, created_at) VALUES ($1, $2, $3, now() - $4::interval)`, [userId, category, title, ago]);

    // Discreet on the lock screen until the member chooses details.
    await notify('message', 'Daniel Fourie sent you a message.');
    assert.equal(await dispatchPush(s.db, push), 1);
    assert.equal(push.sent.at(-1)!.title, 'Quintara');
    assert.equal(push.sent.at(-1)!.body, 'You have a new message.');
    assert.ok(push.sent.at(-1)!.data.notificationId);
    assert.equal(await dispatchPush(s.db, push), 0, 'each notification is pushed once');

    await thandi.updatePushSettings({ muted: ['order'], showDetails: true });
    await notify('message', 'Aisha Parker sent you a message.');
    await notify('order', 'Order Q-1 has been dispatched.');
    await notify('booking_confirmation', 'From yesterday', '7 hours');
    assert.equal(await dispatchPush(s.db, push), 1);
    assert.equal(push.sent.at(-1)!.body, 'Aisha Parker sent you a message.');
    const states = await s.db.query<{ title: string; push_state: string }>(`SELECT title, push_state FROM notifications WHERE user_id = $1 AND title IN ('Order Q-1 has been dispatched.', 'From yesterday')`, [userId]);
    assert.deepEqual(states.map((r) => r.push_state).sort(), ['skipped', 'skipped']);
    assert.equal((await s.db.query(`SELECT 1 FROM consent_events WHERE user_id = $1 AND consent_key = 'push' AND granted`, [userId])).length, 1);

    // A test from the settings, then not again within the minute.
    await thandi.sendTestPush();
    await assert.rejects(thandi.sendTestPush(), (e: unknown) => e instanceof ApiError && /moment ago/.test(e.message));
    assert.equal(await dispatchPush(s.db, push), 1);

    // The app was removed from a phone: the token is switched off.
    const daniel = s.client();
    await daniel.signIn({ email: 'daniel@example.com' });
    await daniel.registerPushDevice({ token: token('daniel1'), platform: 'android' });
    push.gone.add(token('daniel1'));
    const danielId = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'daniel@example.com'`))[0]!.id;
    await s.db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'message', 'Hello')`, [danielId]);
    assert.equal(await dispatchPush(s.db, push), 0);
    assert.ok((await s.db.query(`SELECT disabled_at FROM push_devices WHERE token = $1`, [token('daniel1')]))[0]!.disabled_at);

    // The data export lists the phone, never the token.
    const exported = JSON.stringify(await thandi.exportMyData());
    assert.ok(exported.includes('"pushNotifications"') && exported.includes('iPhone') && !exported.includes('thandi1'));

    // Signing out ends pushes to that phone.
    await thandi.signOut();
    await notify('message', 'After signing out');
    assert.equal(await dispatchPush(s.db, push), 0);
  } finally { await s.close(); }
});

test('renewals: reminders once, the saved card charged when the term ends, declines retried, grace then lapse, renewing brings the member back', async () => {
  const s = await startServer();
  try {
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const before = await thandi.getMembership();
    assert.equal(before.state, 'renewal_due');
    assert.equal(before.autoRenew, true);
    assert.deepEqual([before.card?.brand, before.card?.last4], ['Visa', '4242']);
    assert.equal(before.termMonths, 12);

    // The 30-day reminder, once.
    const first = await runRenewals(s.db, s.payments);
    assert.equal(first.reminded, 1);
    assert.equal((await runRenewals(s.db, s.payments)).reminded, 0);
    assert.ok((await thandi.listNotifications()).some((n) => /renews automatically on .* Visa ending 4242/.test(n.title)));

    // The term ends: the card is charged once, and the next term starts where the last one ended.
    const end = (await s.db.query<{ term_ends_at: Date }>(`UPDATE members SET term_ends_at = now() - interval '1 hour' WHERE member_number = 'Q-1001' RETURNING term_ends_at`))[0]!.term_ends_at;
    const charged = await runRenewals(s.db, s.payments);
    assert.equal(charged.renewed, 1);
    assert.equal(s.payments.charges.at(-1)!.paymentMethodToken, 'mock_pm_visa_seed');
    assert.equal((await runRenewals(s.db, s.payments)).renewed, 0, 'never charged twice');
    const after = await thandi.getMembership();
    assert.equal(after.state, 'active');
    const months = (new Date(after.termEndsAt!).getTime() - new Date(end).getTime()) / 86_400_000;
    assert.ok(months > 364 && months < 367, String(months));
    assert.equal(after.history[0]!.status, 'paid');
    assert.ok((await thandi.listNotifications()).some((n) => n.title.includes('membership is renewed until')));

    // No card numbers, ever; automatic renewal needs a card.
    const daniel = s.client();
    await daniel.signIn({ email: 'daniel@example.com' });
    await assert.rejects(daniel.saveCard('4242424242424242'), fails('validation'));
    await assert.rejects(daniel.setAutoRenew(true), fails('conflict'));
    // A declined card: retried after a day, the member told each time.
    await daniel.saveCard('test_card_declined');
    await daniel.setAutoRenew(true);
    await s.db.query(`UPDATE members SET term_ends_at = now() - interval '1 hour' WHERE member_number = 'Q-1002'`);
    assert.equal((await runRenewals(s.db, s.payments)).failed, 1);
    let d = await daniel.getMembership();
    assert.equal(d.state, 'grace');
    assert.ok(d.graceEndsAt && d.nextAttemptAt && d.lastFailure);
    assert.equal((await runRenewals(s.db, s.payments)).failed, 0, 'the next try waits a day');
    await s.db.query(`UPDATE members SET next_renewal_attempt_at = now() - interval '1 minute' WHERE member_number = 'Q-1002'`);
    assert.equal((await runRenewals(s.db, s.payments)).failed, 1);
    assert.ok((await daniel.listNotifications()).some((n) => n.title.startsWith('We could not renew your membership')));
    // A new card, renewed at once by the member.
    await daniel.saveCard('test_card_mastercard');
    d = await daniel.renewMembership('tap-1');
    assert.equal(d.state, 'active');
    assert.equal(d.card?.last4, '4444');
    await assert.rejects(daniel.renewMembership('tap-2'), fails('conflict'), 'not due again for a year');
    // Removing the card turns automatic renewal off, recorded as a consent.
    d = await daniel.removeCard();
    assert.equal(d.autoRenew, false);
    assert.equal(d.card, null);

    // Without automatic renewal: fourteen days of grace, then the membership lapses and member access stops.
    const aisha = s.client();
    await aisha.signIn({ email: 'aisha@example.com' });
    await s.db.query(`UPDATE members SET term_ends_at = now() - interval '15 days', auto_renew = false WHERE member_number = 'Q-1003'`);
    assert.equal((await runRenewals(s.db, s.payments)).lapsed, 1);
    assert.equal(await aisha.getSession(), null);
    await assert.rejects(aisha.listNotifications());
    const lapsed = await aisha.getMembership();
    assert.equal(lapsed.state, 'lapsed');
    assert.equal(lapsed.canRenewNow, true);
    // A lapsed member can still sign in, to renew.
    const again = s.client();
    assert.deepEqual(await again.signIn({ email: 'aisha@example.com' }), { lapsed: true });
    await again.saveCard('test_card_visa');
    const back = await again.renewMembership('k1');
    assert.equal(back.state, 'active');
    assert.ok(new Date(back.termEndsAt!).getTime() > Date.now() + 360 * 86_400_000, 'a new term from today');
    assert.equal((await again.getSession())?.memberNumber, 'Q-1003');

    // Staff: what is coming up and failing; extend a term with a reason; card details are never shown.
    const admin = await s.staff('admin@example.com');
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/renewals')).status, 403);
    const list = (await admin('GET', '/admin/v1/renewals')).body;
    assert.ok(Array.isArray(list.upcoming) && Array.isArray(list.failing) && Array.isArray(list.lapsed));
    assert.ok(!JSON.stringify(list).match(/4242|4444|mock_pm/));
    const chloe = (await s.db.query<{ id: string }>(`SELECT id FROM members WHERE member_number = 'Q-1005'`))[0]!.id;
    assert.equal((await admin('POST', `/admin/v1/renewals/${chloe}/extend`, { days: 30 })).status, 422);
    const extended = await admin('POST', `/admin/v1/renewals/${chloe}/extend`, { days: 30, reason: 'Delayed by the bank' });
    assert.equal(extended.status, 200);
    assert.equal((await s.db.query(`SELECT 1 FROM audit_logs WHERE action = 'membership.extended'`)).length, 1);
    assert.equal((await admin('POST', `/admin/v1/renewals/${chloe}/retry`)).status, 409);
  } finally { await s.close(); }
});

test('insights: periods, revenue by source and over time, renewals, no member named; CSV; the weekly report once a week', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com');
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/insights')).status, 403);
    // A renewal, so there is revenue in the period.
    await s.db.query(`UPDATE members SET term_ends_at = now() - interval '1 hour' WHERE member_number = 'Q-1001'`);
    await runRenewals(s.db, s.payments);

    const monthRes = await admin('GET', '/admin/v1/insights?period=30d');
    assert.equal(monthRes.status, 200, JSON.stringify(monthRes.body));
    const month = monthRes.body;
    assert.equal(month.bucket, 'day');
    assert.equal(month.revenueSeries.length, 30);
    const renewalsIn = month.revenueBySource.find((r: any) => r.source === 'membership_renewal');
    assert.ok(renewalsIn.totalMinor > 0 && renewalsIn.count === 1, JSON.stringify(month.revenueBySource));
    assert.equal(month.membership.renewals.renewed, 1);
    assert.ok(month.headline.activeMembers >= 5);
    assert.ok(month.headline.revenueMinor >= renewalsIn.totalMinor);
    const json = JSON.stringify(month);
    for (const name of ['Thandi', 'Mokoena', 'thandi@example.com', 'Q-1001']) assert.ok(!json.includes(name), `${name} must not appear`);

    const year = (await admin('GET', '/admin/v1/insights?period=12m')).body;
    assert.equal(year.bucket, 'month');
    assert.ok(year.revenueSeries.length >= 12 && year.revenueSeries.length <= 13);
    const custom = (await admin('GET', '/admin/v1/insights?period=30d&from=2026-01-01&to=2026-03-31')).body;
    assert.equal(custom.period.from, '2026-01-01');
    assert.equal(custom.bucket, 'week');
    assert.equal(custom.previous.to, '2025-12-31');
    assert.equal((await admin('GET', '/admin/v1/insights?period=forever')).status, 422);

    const csv = await s.app.inject({ method: 'GET', url: '/admin/v1/insights/export?period=30d', headers: { cookie: (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'admin@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    assert.ok(csv.body.includes('Revenue by source,Renewals'));

    // The weekly report: only to staff who ask for it, Monday from 07:00, once a week.
    const monday = new Date('2026-11-02T06:30:00Z'), tuesday = new Date('2026-11-03T06:30:00Z');
    assert.equal(await sendWeeklyReport(s.db, s.email, 'https://admin.test', monday), 0, 'nobody has asked for it yet');
    assert.deepEqual((await admin('PUT', '/admin/v1/insights/report', { weeklyReport: true })).body, { weeklyReport: true });
    assert.equal(await sendWeeklyReport(s.db, s.email, 'https://admin.test', tuesday), 0);
    assert.equal(await sendWeeklyReport(s.db, s.email, 'https://admin.test', monday), 1);
    assert.equal(await sendWeeklyReport(s.db, s.email, 'https://admin.test', monday), 0, 'once a week');
    const report = s.email.sent.at(-1)!;
    assert.match(report.subject, /weekly report/);
    assert.ok(report.text.includes('Revenue:') && report.text.includes('Renewals:') && report.text.includes('https://admin.test/insights'));
    assert.ok(!report.text.includes('Mokoena'));
    assert.equal((await admin('POST', '/admin/v1/insights/report/send')).status, 200);
  } finally { await s.close(); }
});
