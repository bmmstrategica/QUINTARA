/** The staff side and the full membership lifecycle: apply, review, approve, pay, join. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { ApiError } from '@quintara/api-client';
import { APPLICATION_APPROVED_MESSAGE, APPLICATION_WAITING_LIST_MESSAGE, EMPTY_APPLICATION } from '@quintara/domain';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

let server: TestServer;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });
const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const applicant = { ...EMPTY_APPLICATION, email: 'naledi@example.com', fullName: 'Naledi Khumalo', city: 'Johannesburg', position: 'Director', industry: 'Art', asFounder: true, asInvestor: true, motivation: 'I would like to host gallery evenings for members.', socialPlatform: 'tiktok' as const, socialHandle: 'naledi.art', phone: '+27 82 555 0101' };
/** The resident twelve-month plan in the visitor's city, as an applicant would choose it. */
const plan = async (client: { listMembershipPlans: () => Promise<{ id: string; residency: string; termMonths: number }[]> }) => (await client.listMembershipPlans()).find((p) => p.residency === 'resident' && p.termMonths === 12)!.id;

test('staff routes refuse visitors and members: only a staff session reaches them (401)', async () => {
  const visitor = await server.app.inject({ method: 'GET', url: '/admin/v1/applications' });
  assert.equal(visitor.statusCode, 401);
  const member = await server.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } });
  const cookie = member.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  for (const url of ['/admin/v1/applications', '/admin/v1/members', '/admin/v1/experiences']) {
    assert.equal((await server.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, 401);   // an app session carries no staff powers
  }
  assert.equal((await server.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'thandi@example.com' } })).statusCode, 401);
});

test('the full lifecycle: apply, review, approve, pay, become a member', async () => {
  const visitor = server.client();
  await visitor.submitApplication({ ...applicant, planId: await plan(visitor) });
  await assert.rejects(visitor.payMembershipFee(), fails('conflict'));          // nothing to pay before approval

  const admin = await server.staff('admin@example.com');
  const queue = (await admin('GET', '/admin/v1/applications?status=submitted')).body;
  const application = queue.find((a: any) => a.data.fullName === 'Naledi Khumalo');
  assert.ok(application);
  // Staff see the phone number and the membership applied for.
  assert.equal(application.data.phone, '+27 82 555 0101');
  assert.equal(application.requestedTier.name, 'Resident, 12 months');
  assert.equal(application.requestedTier.priceMinor, 30_000_00);
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/review`, { status: 'under_review' })).status, 204);
  assert.equal((await visitor.getApplication())?.status, 'under_review');

  const tier = (await admin('GET', '/admin/v1/tiers')).body.find((t: any) => t.name === 'Member');
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/approve`, { tierId: tier.id })).status, 204);
  const offered = await visitor.getApplication();
  assert.equal(offered?.status, 'payment_pending');
  assert.equal(offered?.offeredTierName, 'Member');
  assert.equal(await visitor.getSession(), null);                               // approved is not yet a member

  server.payments.failNext = true;
  await assert.rejects(visitor.payMembershipFee(), fails('conflict'));          // a declined card leaves the offer open
  assert.equal((await visitor.getApplication())?.status, 'payment_pending');

  const before = server.payments.charges.length;
  assert.equal((await visitor.payMembershipFee()).status, 'active');
  assert.equal(server.payments.charges.length, before + 1);
  assert.equal(server.payments.charges.at(-1)?.amountMinor, 4800000);

  const session = await visitor.getSession();
  assert.equal(session?.fullName, 'Naledi Khumalo');
  assert.match(session!.memberNumber, /^Q-2\d{3}$/);
  assert.deepEqual([...session!.roles].sort(), ['founder', 'member']);         // investor is not granted by applying
  assert.ok((await visitor.listNotifications()).some((n) => n.category === 'membership_update'));
  await assert.rejects(visitor.payMembershipFee(), fails('conflict'));          // cannot pay twice

  const thandi = server.client();
  await thandi.signIn({ email: 'thandi@example.com' });
  assert.ok((await thandi.listMembers({ search: 'naledi' })).length === 1);     // now in the directory
});

test('a repeated payment request with the same key charges once', async () => {
  const visitor = server.client();
  await visitor.submitApplication({ ...applicant, planId: await plan(visitor), email: 'second@example.com', fullName: 'Second Applicant' });
  const admin = await server.staff('admin@example.com');
  const application = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === 'Second Applicant');
  const tier = (await admin('GET', '/admin/v1/tiers')).body.find((t: any) => t.name === 'Member');
  await admin('POST', `/admin/v1/applications/${application.id}/approve`, { tierId: tier.id });
  const userId = (await server.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'second@example.com'`))[0]!.id;
  const token = 'test-token-' + Math.random();
  const { hashToken } = await import('../src/context.ts');
  await server.db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [userId, hashToken(token)]);
  const before = server.payments.charges.length;
  const pay = () => server.app.inject({ method: 'POST', url: '/v1/me/application/pay', headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'same-key' } });
  const [a, b] = [await pay(), await pay()];
  assert.equal(a.statusCode, 200);
  assert.ok([200, 409].includes(b.statusCode));
  assert.equal(server.payments.charges.length, before + 1);
  assert.equal((await server.db.query(`SELECT 1 FROM payments WHERE idempotency_key = 'same-key'`)).length, 1);
});

test('declined and waitlisted applications are final for review, and staff cannot approve with a foreign tier', async () => {
  const visitor = server.client();
  await visitor.submitApplication({ ...applicant, planId: await plan(visitor), email: 'third@example.com', fullName: 'Third Applicant' });
  const admin = await server.staff('admin@example.com');
  const application = (await admin('GET', '/admin/v1/applications')).body.find((a: any) => a.data.fullName === 'Third Applicant');
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/approve`, { tierId: '00000000-0000-4000-8000-000000000000' })).status, 422);
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/review`, { status: 'declined', note: 'Not this season.' })).status, 204);
  assert.equal((await visitor.getApplication())?.status, 'declined');
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/review`, { status: 'under_review' })).status, 409);
});

test('the concierge can run experiences but cannot decide memberships or manage members', async () => {
  const desk = await server.staff('desk@example.com');
  assert.equal((await desk('GET', '/admin/v1/experiences')).status, 200);
  assert.equal((await desk('GET', '/admin/v1/applications')).status, 403);
  assert.equal((await desk('GET', '/admin/v1/members')).status, 403);
});

test('staff publish an experience, release a seat, confirm the waitlist and check a guest in', async () => {
  const desk = await server.staff('desk@example.com');
  const created = await desk('POST', '/admin/v1/experiences', { title: 'Harvest Supper', category: 'Dining', startsAt: '2026-11-20T17:00:00+02:00', timezone: 'Africa/Johannesburg', capacity: 2, currency: 'ZAR', admission: 'members_only', maxSeatsPerBooking: 2, status: 'published' });
  assert.equal(created.status, 200);
  assert.equal((await desk('POST', '/admin/v1/experiences', { title: 'x' })).status, 422);

  const daniel = server.client(), aisha = server.client();
  await daniel.signIn({ email: 'daniel@example.com' });
  await aisha.signIn({ email: 'aisha@example.com' });
  const first = await daniel.bookExperience(created.body.id, 2);
  const second = await aisha.bookExperience(created.body.id, 1);
  assert.deepEqual([first.status, second.status], ['confirmed', 'waitlisted']);

  // Still full: staff cannot overfill it.
  assert.equal((await desk('POST', `/admin/v1/bookings/${second.id}/decision`, { decision: 'confirm' })).status, 409);
  assert.equal((await desk('PATCH', `/admin/v1/experiences/${created.body.id}`, { capacity: 3 })).body.capacity, 3);
  assert.equal((await desk('POST', `/admin/v1/bookings/${second.id}/decision`, { decision: 'confirm' })).status, 204);
  assert.equal((await aisha.listBookings()).find((b) => b.id === second.id)?.status, 'confirmed');
  assert.ok((await aisha.listNotifications()).some((n) => n.category === 'waitlist_opening'));

  const guests = (await desk('GET', `/admin/v1/experiences/${created.body.id}/guests`)).body;
  assert.deepEqual(guests.map((g: any) => g.fullName).sort(), ['Aisha Parker', 'Daniel Fourie']);
  const checked = await desk('POST', '/admin/v1/check-in', { ticketCode: first.ticketCode.toLowerCase() });
  assert.deepEqual(checked.body, { fullName: 'Daniel Fourie', seats: 2, experienceTitle: 'Harvest Supper' });
  assert.equal((await desk('POST', '/admin/v1/check-in', { ticketCode: first.ticketCode })).status, 409);
  assert.equal((await desk('POST', '/admin/v1/check-in', { ticketCode: 'QT-NOPE' })).status, 404);
  assert.equal((await daniel.listBookings()).find((b) => b.id === first.id)?.status, 'attended');
});

test('an invitation makes a hidden experience visible to that member only', async () => {
  const desk = await server.staff('desk@example.com'), admin = await server.staff('admin@example.com');
  const hidden = (await desk('GET', '/admin/v1/experiences')).body.find((e: any) => e.title === 'Quintara Golf Invitational');
  const members = (await admin('GET', '/admin/v1/members')).body;
  const daniel = server.client(), aisha = server.client();
  await daniel.signIn({ email: 'daniel@example.com' });
  await aisha.signIn({ email: 'aisha@example.com' });
  await assert.rejects(daniel.getExperience(hidden.id), fails('not_found'));
  assert.equal((await desk('POST', `/admin/v1/experiences/${hidden.id}/invitations`, { memberId: members.find((m: any) => m.fullName === 'Daniel Fourie').id })).status, 204);
  assert.equal((await daniel.getExperience(hidden.id)).invited, true);
  await assert.rejects(aisha.getExperience(hidden.id), fails('not_found'));
});

test('suspending a member ends their sessions; investor access is a separate staff grant', async () => {
  const admin = await server.staff('admin@example.com');
  const members = (await admin('GET', '/admin/v1/members')).body;
  const chloe = members.find((m: any) => m.fullName === 'Chloe van der Merwe');
  const client = server.client();
  await client.signIn({ email: 'chloe@example.com' });
  assert.equal((await admin('POST', `/admin/v1/members/${chloe.id}/roles`, { role: 'investor', granted: true })).status, 204);
  assert.ok((await client.getSession())?.roles.includes('investor'));
  assert.equal((await admin('POST', `/admin/v1/members/${chloe.id}/roles`, { role: 'admin', granted: true })).status, 422);   // staff roles cannot be granted here
  assert.equal((await admin('POST', `/admin/v1/members/${chloe.id}/status`, { status: 'suspended' })).status, 204);
  assert.equal(await client.getSession(), null);
  await assert.rejects(client.signIn({ email: 'chloe@example.com' }), fails('unauthenticated'));
});

test('concierge: the desk replies and offers options, the member confirms, the desk completes', async () => {
  const sipho = server.client();
  await sipho.signIn({ email: 'sipho@example.com' });
  const request = await sipho.createConciergeRequest({ category: 'hospitality', subject: 'Private dinner', details: 'Dinner for eight founders next Thursday, quiet room.' });

  const desk = await server.staff('desk@example.com');
  const queue = (await desk('GET', '/admin/v1/concierge-requests')).body;
  assert.ok(queue.some((r: any) => r.id === request.id && r.memberName === 'Sipho Ndlovu'));
  const replied = await desk('POST', `/admin/v1/concierge-requests/${request.id}/reply`, { body: 'The private room at Saffron House is free at 19:30.' });
  assert.equal(replied.body.status, 'reviewing');                         // the first reply picks the request up
  assert.equal((await desk('POST', `/admin/v1/concierge-requests/${request.id}/status`, { status: 'options_provided' })).body.status, 'options_provided');
  assert.equal((await desk('POST', `/admin/v1/concierge-requests/${request.id}/status`, { status: 'cancelled' })).status, 422);

  const seen = await sipho.getConciergeRequest(request.id);
  assert.deepEqual(seen.messages.map((m) => m.from), ['desk']);
  assert.ok((await sipho.listNotifications()).filter((n) => n.category === 'concierge_update' && n.link?.type === 'request').length >= 2);
  assert.equal((await sipho.confirmConciergeRequest(request.id)).status, 'confirmed');
  assert.equal((await desk('POST', `/admin/v1/concierge-requests/${request.id}/status`, { status: 'completed' })).body.status, 'completed');
  assert.equal((await desk('POST', `/admin/v1/concierge-requests/${request.id}/reply`, { body: 'One more thing' })).status, 409);
});

test('concierge requests and conversations are private to the people in them', async () => {
  const thandi = server.client(), daniel = server.client(), aisha = server.client();
  await thandi.signIn({ email: 'thandi@example.com' });
  await daniel.signIn({ email: 'daniel@example.com' });
  await aisha.signIn({ email: 'aisha@example.com' });
  const hers = (await thandi.listConciergeRequests())[0]!;
  await assert.rejects(daniel.getConciergeRequest(hers.id), fails('not_found'));
  await assert.rejects(daniel.sendConciergeMessage(hers.id, 'Let me in'), fails('not_found'));
  await assert.rejects(daniel.cancelConciergeRequest(hers.id), fails('not_found'));
  assert.equal((await server.app.inject({ method: 'GET', url: '/admin/v1/concierge-requests' })).statusCode, 401);

  // Thandi and Aisha have a conversation. Daniel, connected to Thandi but not part of it, sees none of it.
  const members = await daniel.listMembers();
  const thandiId = members.find((m) => m.fullName === 'Thandi Mokoena')!.id;
  assert.deepEqual((await daniel.getConversation(thandiId)).messages, []);
  assert.equal((await daniel.listConversations()).length, 0);

  // A message reaches the other person, shows as unread for them, and raises one notification however many are sent.
  const aishaId = (await thandi.listMembers()).find((m) => m.fullName === 'Aisha Parker')!.id;
  await thandi.sendMessage(aishaId, 'One');
  await thandi.sendMessage(aishaId, 'Two');
  const inbox = await aisha.listConversations();
  assert.equal(inbox[0]?.fullName, 'Thandi Mokoena');
  assert.equal(inbox[0]?.unread, true);
  assert.equal((await aisha.listNotifications()).filter((n) => n.category === 'message').length, 1);
  assert.deepEqual((await aisha.getConversation(thandiId)).messages.slice(-2).map((m) => [m.body, m.mine]), [['One', false], ['Two', false]]);
});

test('sign-in attempts are limited per address', async () => {
  const limited = await (await import('../src/app.ts')).buildApp(server.db, { webOrigins: ['http://localhost:3000'], authMode: 'dev', secureCookies: false, payments: server.payments, email: server.email, webUrl: 'https://app.quintara.test', signInLimit: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: 'POST', url: '/v1/session', payload: { email: 'nobody@example.com' } })).statusCode);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  await limited.close();
});

test('every staff decision is in the audit log', async () => {
  const actions = (await server.db.query<{ action: string }>('SELECT DISTINCT action FROM audit_logs')).map((r) => r.action);
  for (const expected of ['application.under_review', 'application.approved', 'application.declined', 'payment.paid', 'membership.activated', 'experience.created', 'experience.updated', 'booking.confirmed', 'booking.checked_in', 'experience.invited', 'member.suspended', 'member.role_granted']) {
    assert.ok(actions.includes(expected), expected);
  }
});

test('safety: a block hides both members from each other, and the blocked member cannot tell', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), aisha = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await aisha.signIn({ email: 'aisha@example.com' });
    const target = (await thandi.listMembers()).find((m) => m.fullName === 'Aisha Parker')!;
    const me = (await aisha.listMembers()).find((m) => m.fullName === 'Thandi Mokoena')!;
    await thandi.blockMember(target.id);
    assert.ok(!(await aisha.listMembers()).some((m) => m.id === me.id));
    await assert.rejects(aisha.getMember(me.id), fails('not_found'));
    await assert.rejects(aisha.sendMessage(me.id, 'Hello?'), fails('not_found'));
    await assert.rejects(aisha.requestConnection(me.id), fails('not_found'));
    assert.deepEqual(await aisha.listBlockedMembers(), []);                       // she sees no trace of the block
    await aisha.unblockMember(me.id);                                             // and cannot lift it
    await assert.rejects(aisha.getMember(me.id), fails('not_found'));
  } finally { await s.close(); }
});

test('reports: staff only, never visible to members, and suspending ends the reported member\'s access', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), sipho = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await sipho.signIn({ email: 'sipho@example.com' });
    const target = (await thandi.listMembers()).find((m) => m.fullName === 'Sipho Ndlovu')!;
    await thandi.reportMember(target.id, { reason: 'unsolicited_investment', detail: 'Pitched a fund.' });

    const memberCookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'sipho@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    for (const url of ['/admin/v1/reports', '/admin/v1/insights']) assert.equal((await s.app.inject({ method: 'GET', url, headers: { cookie: memberCookie } })).statusCode, 401);   // an app session carries no staff powers
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/reports')).status, 403);          // the desk does not handle member conduct
    assert.equal((await desk('GET', '/admin/v1/insights')).status, 403);

    const admin = await s.staff('admin@example.com');
    const reports = (await admin('GET', '/admin/v1/reports')).body;
    assert.equal(reports.length, 1);
    assert.deepEqual([reports[0].reporter.fullName, reports[0].reported.fullName, reports[0].reason, reports[0].status], ['Thandi Mokoena', 'Sipho Ndlovu', 'unsolicited_investment', 'open']);
    const insights = (await admin('GET', '/admin/v1/insights')).body;
    assert.equal(insights.club.openReports, 1);
    assert.equal(insights.headline.activeMembers, 5);   // the city being viewed: Cape Town (Johannesburg has its own two)
    assert.ok(insights.experiences.length >= 1 && insights.experiences.every((e: any) => e.seatsTaken <= e.capacity));
    assert.ok(!JSON.stringify(insights).includes('@') && !JSON.stringify(insights).includes('Thandi'));

    assert.equal((await admin('POST', `/admin/v1/reports/${reports[0].id}/resolve`, { outcome: 'maybe' })).status, 422);
    assert.equal((await admin('POST', `/admin/v1/reports/${reports[0].id}/resolve`, { outcome: 'suspended' })).status, 204);
    assert.equal((await admin('POST', `/admin/v1/reports/${reports[0].id}/resolve`, { outcome: 'dismissed' })).status, 409);
    assert.equal(await sipho.getSession(), null);                                 // signed out at once
    assert.ok(!(await thandi.listMembers()).some((m) => m.id === target.id));
    const log = await s.db.query(`SELECT action FROM audit_logs WHERE action IN ('member.reported', 'report.suspended', 'member.suspended') ORDER BY action`);
    assert.deepEqual(log.map((r) => r.action), ['member.reported', 'member.suspended', 'report.suspended']);
  } finally { await s.close(); }
});

test('experience payments: one charge however often it is asked, a declined card keeps the hold, a lapsed hold frees the seats, late cancellation is not refunded', async () => {
  const s = await startServer();
  try {
    const daniel = s.client(), aisha = s.client();
    await daniel.signIn({ email: 'daniel@example.com' }); await aisha.signIn({ email: 'aisha@example.com' });
    const aura = (await daniel.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const held = await daniel.bookExperience(aura.id, 2);

    await assert.rejects(aisha.payBooking(held.id), fails('not_found'));        // nobody can pay for, or probe, another member's booking
    s.payments.failNext = true;
    await assert.rejects(daniel.payBooking(held.id), fails('conflict'));        // 402 from the provider
    assert.equal((await daniel.listBookings()).find((b) => b.id === held.id)?.status, 'awaiting_payment');
    const before = s.payments.charges.length;
    const [a, b] = await Promise.all([daniel.payBooking(held.id), daniel.payBooking(held.id).catch((e) => e)]);
    assert.equal(a.status, 'confirmed');
    assert.ok(b instanceof ApiError ? b.code === 'conflict' : b.status === 'confirmed', JSON.stringify(b instanceof ApiError ? { code: b.code, message: b.message } : b));
    assert.equal(s.payments.charges.length, before + 1);                         // charged once
    assert.equal(s.payments.charges.at(-1)?.amountMinor, aura.memberPriceMinor * 2);
    const rows = await s.db.query(`SELECT status, amount_minor FROM payments WHERE booking_id = $1 ORDER BY created_at`, [held.id]);
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'paid']);

    // Inside the refund window: nothing comes back, and the provider is not asked.
    await s.db.query(`UPDATE experiences SET starts_at = now() + interval '3 hours' WHERE id = $1`, [aura.id]);
    assert.equal((await daniel.cancelBooking(held.id)).refundedMinor, 0);
    assert.equal(s.payments.refunds.length, 0);

    // A hold that is never paid stops counting, and paying it late is refused.
    const late = await aisha.bookExperience(aura.id, 2);
    assert.equal((await aisha.getExperience(aura.id)).seatsTaken, aura.seatsTaken! + 2);
    await s.db.query(`UPDATE experience_bookings SET payment_due_at = now() - interval '1 minute' WHERE id = $1`, [late.id]);
    assert.equal((await aisha.getExperience(aura.id)).seatsTaken, aura.seatsTaken);
    await assert.rejects(aisha.payBooking(late.id), fails('conflict'));
    assert.equal((await aisha.listBookings()).find((x) => x.id === late.id)?.status, 'cancelled');
    assert.equal((await aisha.bookExperience(aura.id, 1)).status, 'awaiting_payment');   // and she can book again
    const audit = await s.db.query(`SELECT action FROM audit_logs WHERE action IN ('payment.paid', 'booking.hold_lapsed') ORDER BY action`);
    assert.deepEqual(audit.map((r) => r.action), ['booking.hold_lapsed', 'payment.paid']);
  } finally { await s.close(); }
});

test('tiers and payments: administrators only; a price change is audited and does not alter fees already paid', async () => {
  const s = await startServer();
  try {
    const desk = await s.staff('desk@example.com'), admin = await s.staff('admin@example.com');
    for (const url of ['/admin/v1/tiers/all', '/admin/v1/payments']) assert.equal((await desk('GET', url)).status, 403);
    assert.equal((await desk('POST', '/admin/v1/tiers', { name: 'Desk tier', priceMinor: 1, currency: 'ZAR' })).status, 403);

    const tiers = (await admin('GET', '/admin/v1/tiers/all')).body;
    const founding = tiers.find((t: any) => t.name === 'Founding member');
    assert.ok(founding.members >= 1 && founding.isActive);
    assert.equal((await admin('POST', '/admin/v1/tiers', { name: 'Patron', priceMinor: 9600000, currency: 'ZAR', billingPeriod: 'year' })).status, 204);
    assert.equal((await admin('POST', '/admin/v1/tiers', { name: 'patron', priceMinor: 1, currency: 'ZAR' })).status, 409);
    assert.equal((await admin('POST', '/admin/v1/tiers', { name: 'Free', priceMinor: -5, currency: 'ZAR' })).status, 422);
    assert.equal((await admin('POST', '/admin/v1/tiers', { name: 'Dollar', priceMinor: 5, currency: 'XXX' })).status, 422);
    assert.equal((await admin('PATCH', `/admin/v1/tiers/${founding.id}`, { priceMinor: 4000000, currency: 'USD' })).status, 204);
    const after = (await admin('GET', '/admin/v1/tiers/all')).body.find((t: any) => t.id === founding.id);
    assert.deepEqual([after.priceMinor, after.currency], [4000000, 'ZAR']);                 // the currency cannot be switched
    const patron = (await admin('GET', '/admin/v1/tiers/all')).body.find((t: any) => t.name === 'Patron');
    assert.equal((await admin('PATCH', `/admin/v1/tiers/${patron.id}`, { isActive: false })).status, 204);
    assert.ok(!(await admin('GET', '/admin/v1/tiers')).body.some((t: any) => t.name === 'Patron'));   // retired tiers cannot be offered
    const log = await s.db.query(`SELECT changes FROM audit_logs WHERE action = 'tier.updated' ORDER BY occurred_at LIMIT 1`);
    assert.equal((log[0]!.changes as any).previousPriceMinor, 3600000);

    const daniel = s.client(); await daniel.signIn({ email: 'daniel@example.com' });
    const aura = (await daniel.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    assert.equal((await admin('PATCH', `/admin/v1/experiences/${aura.id}`, { paymentHoldMinutes: 2 })).status, 422);
    assert.equal((await admin('PATCH', `/admin/v1/experiences/${aura.id}`, { paymentHoldMinutes: 90, refundHours: 0 })).body.paymentHoldMinutes, 90);
    const held = await daniel.bookExperience(aura.id, 1);
    assert.ok(Date.parse(held.paymentDueAt!) - Date.now() > 80 * 60_000);
    await daniel.payBooking(held.id);
    await daniel.cancelBooking(held.id);                                                     // refund window set to the start, so it is refunded
    const payments = (await admin('GET', '/admin/v1/payments')).body;
    assert.deepEqual([payments[0].payer, payments[0].description, payments[0].status, payments[0].refundedMinor], ['Daniel Fourie', 'The Aura Enclave', 'refunded', aura.memberPriceMinor]);
    assert.ok(!/card|pan|cvv/i.test(Object.keys(payments[0]).join(' ')));
  } finally { await s.close(); }
});

test('privacy: leaving the directory hides the profile; closing an account ends access, refunds, and is erased on request', async () => {
  const s = await startServer();
  try {
    const daniel = s.client(), thandi = s.client();
    await daniel.signIn({ email: 'daniel@example.com' }); await thandi.signIn({ email: 'thandi@example.com' });
    const me = (await thandi.listMembers()).find((m) => m.fullName === 'Daniel Fourie')!;
    await daniel.updatePrivacySettings({ showInDirectory: false, marketingEmail: false, suggestions: true, weeklyBrief: true, dailyBrief: true });
    assert.ok(!(await thandi.listMembers()).some((m) => m.id === me.id));
    await assert.rejects(thandi.getMember(me.id), fails('not_found'));
    await daniel.updatePrivacySettings({ showInDirectory: true, marketingEmail: true, suggestions: true, weeklyBrief: true, dailyBrief: true });
    const consents = await s.db.query(`SELECT consent_key, granted FROM consent_events ORDER BY occurred_at, consent_key`);
    assert.deepEqual(consents.map((c) => `${c.consent_key}:${c.granted}`), ['directory_listing:false', 'directory_listing:true', 'marketing_email:true']);

    // The export holds his own words only: Thandi's side of a conversation is not his to take.
    await thandi.sendMessage(me.id, 'A private note from Thandi');
    const thandiId = (await daniel.listMembers()).find((m) => m.fullName === 'Thandi Mokoena')!.id;
    await daniel.sendMessage(thandiId, 'Thank you, see you Tuesday');
    const copy = JSON.stringify(await daniel.exportMyData());
    assert.ok(copy.includes('see you Tuesday') && !copy.includes('A private note from Thandi') && !copy.includes('thandi@example.com'));

    const aura = (await daniel.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const booking = await daniel.bookExperience(aura.id, 1);
    await daniel.payBooking(booking.id);
    await daniel.closeMyAccount('CLOSE');
    assert.equal(await daniel.getSession(), null);
    await assert.rejects(daniel.signIn({ email: 'daniel@example.com' }), fails('unauthenticated'));
    assert.equal(s.payments.refunds.length, 1);                                    // the paid booking was cancelled and refunded
    assert.equal((await thandi.getExperience(aura.id)).seatsTaken, aura.seatsTaken);
    assert.ok(!(await thandi.listMembers()).some((m) => m.id === me.id));

    const desk = await s.staff('desk@example.com'), admin = await s.staff('admin@example.com');
    assert.equal((await desk('GET', '/admin/v1/account-closures')).status, 403);
    const closures = (await admin('GET', '/admin/v1/account-closures')).body;
    assert.deepEqual([closures.length, closures[0].fullName, closures[0].erasedAt], [1, 'Daniel Fourie', null]);
    assert.equal((await admin('POST', `/admin/v1/account-closures/${closures[0].userId}/erase`)).status, 204);
    assert.equal((await admin('POST', `/admin/v1/account-closures/${closures[0].userId}/erase`)).status, 404);
    const left = await s.db.query(`SELECT u.email, u.status, p.full_name, p.company, (SELECT count(*) FROM payments WHERE user_id = u.id) AS payments,
                                          (SELECT string_agg(body, '|') FROM messages WHERE sender_member_id = $1) AS said FROM users u JOIN profiles p ON p.user_id = u.id WHERE p.user_id = $2`, [me.id, closures[0].userId]);
    assert.deepEqual([left[0]!.email, left[0]!.status, left[0]!.full_name, left[0]!.company, left[0]!.said], [null, 'deleted', 'Former member', '', '[removed]']);
    assert.equal(Number(left[0]!.payments), 1);                                    // the payment record is kept, as the law requires
    assert.equal((await thandi.getConversation(me.id).catch((e) => e.code)), 'not_found');
  } finally { await s.close(); }
});

test('email: notifications are emailed with a link, promotion needs consent, and a failed send is retried', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
    const aura = (await thandi.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    const booking = await thandi.bookExperience(aura.id, 1);
    s.email.failNext = true;
    await thandi.payBooking(booking.id);
    assert.equal((await thandi.listBookings()).find((b) => b.id === booking.id)?.status, 'confirmed');   // a mail failure does not affect the payment
    await s.app.flushEmails();
    await s.app.flushEmails();
    const tries = await s.db.query(`SELECT attempts, status FROM email_outbox WHERE subject LIKE '%Aura Enclave%'`);
    assert.deepEqual([Number(tries[0]!.attempts), tries[0]!.status], [2, 'sent']);  // failed once, then went out
    assert.equal(s.email.sent.length, 1);
    const mail = s.email.sent.at(-1)!;
    assert.deepEqual([mail.to, mail.subject], ['thandi@example.com', 'Your place at The Aura Enclave is confirmed.']);
    assert.ok(mail.text.startsWith('Dear Thandi,') && mail.text.includes('https://app.quintara.test/bookings'));

    const userId = (await thandi.getSession())!.userId, before = s.email.sent.length;
    await s.db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'partner_privilege', 'A new privilege at Saffron House.')`, [userId]);
    await s.app.flushEmails();
    assert.equal(s.email.sent.length, before);                                     // no consent, no promotional email
    await thandi.updatePrivacySettings({ showInDirectory: true, marketingEmail: true, suggestions: true, weeklyBrief: true, dailyBrief: true });
    await s.db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'partner_privilege', 'A new privilege at Saffron House.')`, [userId]);
    await s.app.flushEmails();
    assert.equal(s.email.sent.at(-1)?.subject, 'A new privilege at Saffron House.');
    assert.equal((await thandi.listNotifications()).filter((n) => n.category === 'partner_privilege').length, 2);   // both still show in the app
  } finally { await s.close(); }
});

test('partners: staff publish and retire them; a draft or archived partner and its privileges are invisible and cannot be redeemed', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
    const memberCookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'sipho@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal((await s.app.inject({ method: 'GET', url: '/admin/v1/partners', headers: { cookie: memberCookie } })).statusCode, 401);   // an app session carries no staff powers

    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('POST', '/admin/v1/partners', { name: 'x' })).status, 422);
    assert.equal((await desk('POST', '/admin/v1/partners', { name: 'Kloof Cellars', category: 'Wine', website: 'javascript:alert(1)' })).status, 422);
    const created = await desk('POST', '/admin/v1/partners', { name: 'Kloof Cellars', category: 'Wine', summary: 'A cellar under Kloof Street.', website: 'https://example.com' });
    assert.equal(created.status, 200);
    assert.equal((await desk('POST', '/admin/v1/partners', { name: 'kloof cellars', category: 'Wine' })).status, 409);
    const privilege = await desk('POST', `/admin/v1/partners/${created.body.id}/privileges`, { title: 'A private tasting', usesPerMember: 1, status: 'published' });
    assert.equal(privilege.status, 200);

    // The privilege is published but its partner is still a draft: members see neither.
    assert.ok(!(await thandi.listPartners()).some((p) => p.name === 'Kloof Cellars'));
    await assert.rejects(thandi.redeemPrivilege(privilege.body.id), fails('not_found'));
    assert.equal((await desk('PATCH', `/admin/v1/partners/${created.body.id}`, { status: 'published' })).status, 204);
    assert.ok((await thandi.listPartners()).some((p) => p.name === 'Kloof Cellars'));

    // Two taps at once still produce one redemption.
    const results = await Promise.all([thandi.redeemPrivilege(privilege.body.id).catch((e) => e), thandi.redeemPrivilege(privilege.body.id).catch((e) => e)]);
    assert.equal(results.filter((r) => !(r instanceof ApiError)).length, 1);
    const staffView = (await desk('GET', '/admin/v1/partners')).body.find((p: any) => p.name === 'Kloof Cellars');
    assert.equal(staffView.privileges[0].totalUses, 1);
    assert.ok(!JSON.stringify(staffView).includes('Thandi'));                       // counts only, no names

    assert.equal((await desk('PATCH', `/admin/v1/privileges/${privilege.body.id}`, { status: 'archived' })).status, 204);
    assert.equal((await thandi.getPartner(created.body.id)).privileges.length, 0);
    assert.equal((await thandi.listMyRedemptions()).length, 1);                     // her code is still hers
  } finally { await s.close(); }
});

test('business: nothing reaches the other member until staff offer it; a refusal never says who refused; acceptance connects', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), chloe = s.client(), daniel = s.client(), aisha = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await chloe.signIn({ email: 'chloe@example.com' }); await daniel.signIn({ email: 'daniel@example.com' }); await aisha.signIn({ email: 'aisha@example.com' });
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/business/introductions')).status, 403);

    // Capital listings: investors only, and only founders may post them.
    assert.deepEqual((await daniel.listBusinessListings()).filter((l) => l.kind === 'capital').map((l) => l.title), ['Series A for Ledgerline']);
    await assert.rejects(daniel.createBusinessListing({ kind: 'capital', title: 'A fund looking for money', summary: 'An investor is not a founder and cannot post about raising capital.', audience: ['investor'] }), fails('forbidden'));
    const ledger = (await daniel.listBusinessListings()).find((l) => l.kind === 'capital')!;
    await assert.rejects(thandi.requestIntroduction(ledger.id, 'I am not an investor, so I should not be able to reach this listing.'), fails('not_found'));

    // A new listing is invisible until staff publish it; a declined one carries a note only its owner sees.
    const draft = await thandi.createBusinessListing({ kind: 'advisory', title: 'A chair for our advisory board', summary: 'Kloof Street Studio is forming an advisory board and would like an executive with hotel group experience.', audience: ['executive', 'investor'] });
    assert.ok(!(await daniel.listBusinessListings()).some((l) => l.id === draft.id));
    assert.equal((await admin('POST', `/admin/v1/business/listings/${draft.id}/review`, { decision: 'publish' })).status, 204);
    assert.equal((await admin('POST', `/admin/v1/business/listings/${draft.id}/review`, { decision: 'decline' })).status, 409);
    assert.ok((await daniel.listBusinessListings()).some((l) => l.id === draft.id));
    assert.ok(!(await chloe.listBusinessListings()).some((l) => l.id === draft.id));           // a creative is not in its audience

    // Thandi asks to meet Chloe. Chloe sees nothing until the team offers it.
    const film = (await thandi.listBusinessListings()).find((l) => l.title.startsWith('Brands'))!;
    const asked = await thandi.requestIntroduction(film.id, 'Our studio turns ten next year and the story of how it began is worth telling.');
    assert.deepEqual(await chloe.listIntroductions(), []);
    await assert.rejects(chloe.respondToIntroduction(asked.id, true), fails('not_found'));
    const queue = (await admin('GET', '/admin/v1/business/introductions')).body;
    assert.deepEqual([queue[0].requester.fullName, queue[0].target.fullName, queue[0].status], ['Thandi Mokoena', 'Chloe van der Merwe', 'requested']);
    assert.equal((await admin('POST', `/admin/v1/business/introductions/${asked.id}/handle`, { decision: 'offer' })).status, 204);
    assert.equal((await admin('POST', `/admin/v1/business/introductions/${asked.id}/handle`, { decision: 'offer' })).status, 409);
    const incoming = await chloe.listIntroductions();
    assert.deepEqual([incoming[0]!.direction, incoming[0]!.status, incoming[0]!.with.fullName], ['incoming', 'offered', 'Thandi Mokoena']);
    await assert.rejects(daniel.respondToIntroduction(asked.id, true), fails('not_found'));     // a third member cannot answer for her

    // Chloe declines. Thandi is told only that it was not taken forward.
    assert.equal((await chloe.respondToIntroduction(asked.id, false)).status, 'declined');
    assert.equal((await thandi.listIntroductions())[0]?.status, 'not_progressed');
    assert.equal((await thandi.getMember(incoming[0]!.with.memberId === '' ? '' : (await thandi.listMembers()).find((m) => m.fullName === 'Chloe van der Merwe')!.id)).connection, 'none');

    // Aisha (a creative, so not in Daniel's audience) cannot ask; Thandi's board listing brings Daniel to her through the team.
    const board = (await daniel.listBusinessListings()).find((l) => l.id === draft.id)!;
    await thandi.blockMember((await thandi.listMembers()).find((m) => m.fullName === 'Sipho Ndlovu')!.id);
    const second = await s.client(); await second.signIn({ email: 'sipho@example.com' });
    assert.ok(!(await second.listBusinessListings()).some((l) => l.postedBy.fullName === 'Thandi Mokoena'));   // blocked members do not see each other's listings
    await assert.rejects(daniel.requestIntroduction(board.id, 'Already connected to Thandi, so the team need not be involved.'), fails('conflict'));

    // An accepted introduction connects the two and opens messaging.
    const hospitality = (await aisha.listBusinessListings());
    assert.ok(!hospitality.some((l) => l.title.startsWith('Hospitality')));                      // founders only
    const again = await thandi.requestIntroduction(film.id, 'A second, better explained request after speaking to the team about it.');
    await admin('POST', `/admin/v1/business/introductions/${again.id}/handle`, { decision: 'offer' });
    assert.equal((await chloe.respondToIntroduction(again.id, true)).status, 'accepted');
    await assert.rejects(chloe.respondToIntroduction(again.id, false), fails('conflict'));
    const chloeId = (await thandi.listMembers()).find((m) => m.fullName === 'Chloe van der Merwe')!.id;
    assert.equal((await thandi.getMember(chloeId)).connection, 'connected');
    assert.equal((await thandi.sendMessage(chloeId, 'Thank you for agreeing to meet.')).messages.length, 1);
    assert.ok((await thandi.listNotifications()).some((n) => n.title.includes('accepted your introduction')));
    const trail = await s.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'introduction.%' ORDER BY occurred_at`);
    assert.deepEqual(trail.map((r) => r.action), ['introduction.requested', 'introduction.offered', 'introduction.declined', 'introduction.requested', 'introduction.offered', 'introduction.accepted']);
  } finally { await s.close(); }
});

test('boutique: the last item sells once, prices cannot be sent by the buyer, dispatch needs tracking, uploads must be real images', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), daniel = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await daniel.signIn({ email: 'daniel@example.com' });
    const print = (await thandi.listProducts())[2]!, address = '12 Kloof Street, Gardens, Cape Town';
    const courier = (await thandi.listDeliveryOptions())[0]!;
    const one = { items: [{ productId: print.id, option: 'Unframed', quantity: 2 }], deliveryOptionId: courier.id, deliveryAddress: address };
    const results = await Promise.all([thandi.createOrder(one).catch((e) => e), daniel.createOrder(one).catch((e) => e)]);
    assert.equal(results.filter((r) => !(r instanceof ApiError)).length, 1);                  // two left, two buyers wanting two each
    const winner = results[0] instanceof ApiError ? daniel : thandi, loser = winner === thandi ? daniel : thandi;
    const order = (await winner.listOrders())[0]!;
    assert.equal(order.totalMinor, 2 * print.priceMinor);
    await assert.rejects(loser.payOrder(order.id), fails('not_found'));                        // another member's order cannot be seen or paid
    await assert.rejects(loser.cancelOrder(order.id), fails('not_found'));

    // A price or a fee in the request is ignored: the shop's member price and the method's fee are charged.
    const cookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'aisha@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const scarf = (await thandi.listProducts())[3]!;
    const sneaky = await s.app.inject({ method: 'POST', url: '/v1/boutique/orders', headers: { cookie }, payload: { items: [{ productId: scarf.id, option: 'Protea', quantity: 1, priceMinor: 1, unitPriceMinor: 1 }], deliveryOptionId: courier.id, deliveryAddress: address, totalMinor: 1, deliveryFeeMinor: 0 } });
    assert.equal(JSON.parse(sneaky.body).totalMinor, 280000 + 15000);

    const [a, b] = await Promise.all([winner.payOrder(order.id), winner.payOrder(order.id).catch((e) => e)]);
    assert.equal(a.status, 'paid');
    assert.ok(b instanceof ApiError ? b.code === 'conflict' : b.status === 'paid');
    assert.equal(s.payments.charges.filter((c) => c.description.includes(order.orderNumber)).length, 1);

    const desk = await s.staff('content@example.com');
    const queue = (await desk('GET', '/admin/v1/orders')).body;
    // Paid orders lead the queue; an order placed but not paid follows, with the time it lapses.
    assert.deepEqual(queue.map((o: any) => o.status), ['paid', 'awaiting_payment']);
    assert.deepEqual([queue[0].orderNumber, queue[0].history.map((e: any) => [e.kind, e.by])], [order.orderNumber, [['placed', 'Buyer'], ['paid', 'Buyer']]]);
    assert.ok(queue[1].payBy && queue[0].payBy === null);
    assert.equal((await desk('POST', `/admin/v1/orders/${queue[1].id}/advance`)).status, 409);   // unpaid: cannot be processed
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`)).status, 204);
    await assert.rejects(winner.cancelOrder(order.id), fails('conflict'));                     // too late once it is being prepared
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`)).status, 422);    // dispatch without courier details
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { courier: 'The Courier Guy', trackingNumber: 'TCG123456', trackingUrl: 'javascript:alert(1)' })).status, 422);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { courier: 'The Courier Guy', trackingNumber: 'TCG123456', trackingUrl: 'https://example.com/track/TCG123456' })).status, 204);
    const sent = (await winner.listOrders())[0]!;
    assert.deepEqual([sent.status, sent.courier, sent.trackingNumber], ['dispatched', 'The Courier Guy', 'TCG123456']);
    assert.ok((await winner.listNotifications()).some((n) => n.title.includes('TCG123456')));
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`)).status, 422);    // received, but by whom?
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { receivedBy: 'Reception, Thandi Mokoena' })).status, 204);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { receivedBy: 'Again' })).status, 409);
    assert.equal((await winner.listOrders())[0]?.status, 'delivered');

    // Delivery methods are staff-defined; a retired one cannot be chosen.
    const pudo = await desk('POST', '/admin/v1/delivery-options', { name: 'Locker collection', feeMinor: 6000, currency: 'ZAR' });
    assert.equal(pudo.status, 200);
    assert.ok((await thandi.listDeliveryOptions()).some((d) => d.name === 'Locker collection'));
    assert.equal((await desk('PATCH', `/admin/v1/delivery-options/${pudo.body.id}`, { isActive: false })).status, 204);
    const candle = (await thandi.listProducts())[0]!;
    await assert.rejects(thandi.createOrder({ items: [{ productId: candle.id, quantity: 1 }], deliveryOptionId: pudo.body.id, deliveryAddress: address }), fails('validation'));

    // Photographs: staff only, real images only, served as images and nothing else.
    const png = (await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 22, g: 48, b: 43, alpha: 0.5 } } }).png().toBuffer()).toString('base64');
    assert.equal((await s.app.inject({ method: 'POST', url: '/admin/v1/media', headers: { cookie }, payload: { contentType: 'image/png', dataBase64: png } })).statusCode, 401);   // an app session carries no staff powers
    assert.equal((await desk('POST', '/admin/v1/media', { contentType: 'image/png', dataBase64: Buffer.from('<script>alert(1)</script> not an image at all').toString('base64') })).status, 422);
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]).toString('base64');
    assert.equal((await desk('POST', '/admin/v1/media', { contentType: 'image/png', dataBase64: fakePng })).status, 422);   // the right first bytes, but not a picture
    assert.equal((await desk('POST', '/admin/v1/media', { contentType: 'image/svg+xml', dataBase64: png })).status, 422);
    assert.equal((await desk('POST', '/admin/v1/media', { contentType: 'image/jpeg', dataBase64: png })).status, 422);    // says JPEG, is PNG
    const uploaded = await desk('POST', '/admin/v1/media', { contentType: 'image/png', dataBase64: png });
    assert.equal(uploaded.status, 200);
    const served = await s.app.inject({ method: 'GET', url: uploaded.body.path });
    assert.deepEqual([served.statusCode, served.headers['content-type'], served.headers['x-content-type-options']], [200, 'image/png', 'nosniff']);
    assert.equal((await s.app.inject({ method: 'GET', url: '/v1/media/00000000-0000-4000-8000-000000000000' })).statusCode, 404);

    assert.equal((await desk('POST', '/admin/v1/products', { title: 'Brass key ring', category: 'Accessories', priceMinor: 0, currency: 'ZAR' })).status, 422);
    assert.equal((await desk('POST', '/admin/v1/products', { title: 'Brass key ring', category: 'Accessories', priceMinor: 45000, memberPriceMinor: 50000, currency: 'ZAR' })).status, 422);   // a member price above the public price
    const created = await desk('POST', '/admin/v1/products', { title: 'Brass key ring', category: 'Accessories', priceMinor: 45000, memberPriceMinor: 39000, currency: 'ZAR', stock: 5, imageId: uploaded.body.id });
    assert.ok(!(await thandi.listProducts()).some((p) => p.title === 'Brass key ring'));       // a draft is not on sale
    assert.equal((await desk('PATCH', `/admin/v1/products/${created.body.id}`, { status: 'published', priceMinor: 48000 })).status, 204);
    assert.equal((await desk('PATCH', `/admin/v1/products/${created.body.id}`, { priceMinor: 30000 })).status, 422);       // would drop below the member price
    const ring = (await thandi.listProducts()).find((p) => p.title === 'Brass key ring')!;
    assert.deepEqual([ring.priceMinor, ring.publicPriceMinor, ring.imagePath], [39000, 48000, uploaded.body.path]);
    assert.equal((await s.client().listProducts()).find((p) => p.title === 'Brass key ring')?.priceMinor, 48000);   // a visitor sees the public price
    assert.ok(JSON.stringify(await winner.exportMyData()).includes(order.orderNumber));

    // Guests: public shelves only, no reach into anyone else's order, and their emails go to the address on the order.
    const guest = s.client(), other = s.client();
    const membersOnly = (await thandi.listProducts()).find((p) => p.membersOnly)!;
    const who = { fullName: 'Lerato Dube', email: 'lerato@example.org' };
    await assert.rejects(guest.createOrder({ items: [{ productId: membersOnly.id, option: 'Unframed', quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address, guest: who }), fails('not_found'));
    const placed = await guest.createOrder({ items: [{ productId: candle.id, quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: address, guest: who });
    await assert.rejects(other.payOrder(placed.id), fails('not_found'));                        // another guest
    await assert.rejects(thandi.cancelOrder(placed.id), fails('not_found'));                    // a member
    await assert.rejects(guest.payOrder(order.id), fails('not_found'));                         // a guest reaching for a member's order
    await guest.payOrder(placed.id);
    await s.app.flushEmails();
    const mail = s.email.sent.find((m) => m.to === 'lerato@example.org')!;
    assert.ok(mail.subject.includes(placed.orderNumber) && mail.text.startsWith('Dear Lerato,'));
    assert.ok((await desk('GET', '/admin/v1/orders')).body.some((o: any) => o.orderNumber === placed.orderNumber && o.deliveryName === 'Lerato Dube'));
    const users = await s.db.query(`SELECT u.email, u.status FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [placed.id]);
    assert.deepEqual([users[0]!.email, users[0]!.status], [null, 'pending']);                 // the guest's address is not turned into an account
  } finally { await s.close(); }
});

test('tv: staff publish series and episodes; drafts stay hidden; progress is private to each member', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), daniel = s.client(), guest = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await daniel.signIn({ email: 'daniel@example.com' });
    const desk = await s.staff('content@example.com');
    const cookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'sipho@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal((await s.app.inject({ method: 'GET', url: '/admin/v1/tv/series', headers: { cookie } })).statusCode, 401);   // an app session carries no staff powers

    const all = (await desk('GET', '/admin/v1/tv/series')).body;
    const draft = all.find((x: any) => x.title === 'Founders at Work');
    assert.equal(draft.status, 'draft');
    assert.equal((await desk('POST', `/admin/v1/tv/series/${draft.id}/episodes`, { title: 'The first hire', durationSeconds: 1500, videoUrl: 'http://insecure.example/video.mp4' })).status, 422);   // https only
    const episode = await desk('POST', `/admin/v1/tv/series/${draft.id}/episodes`, { title: 'The first hire', durationSeconds: 1500, videoUrl: 'https://video.example/first-hire.m3u8', status: 'published' });
    assert.equal(episode.status, 200);
    assert.equal((await desk('POST', `/admin/v1/tv/series/${draft.id}/episodes`, { title: 'Again', number: 1, durationSeconds: 60 })).status, 409);
    // The episode is published but its series is not: nobody sees it, and its progress cannot be saved.
    assert.equal((await thandi.listTvSeries()).length, 1);
    await assert.rejects(thandi.saveTvProgress(episode.body.id, 10), fails('not_found'));
    assert.equal((await desk('PATCH', `/admin/v1/tv/series/${draft.id}`, { status: 'published' })).status, 204);
    const second = (await thandi.listTvSeries()).find((x) => x.title === 'Founders at Work')!;
    assert.deepEqual([second.episodes.length, second.episodes[0]!.number, second.episodes[0]!.videoUrl], [1, 1, 'https://video.example/first-hire.m3u8']);
    assert.ok(!JSON.stringify(await guest.listTvSeries()).includes('first-hire'));              // members' video addresses never reach a guest
    assert.equal((await desk('PATCH', `/admin/v1/tv/episodes/${episode.body.id}`, { audience: 'public' })).status, 204);
    assert.ok(JSON.stringify(await guest.listTvSeries()).includes('first-hire'));

    await thandi.saveTvProgress(episode.body.id, 700);
    assert.equal((await daniel.listTvSeries()).find((x) => x.title === 'Founders at Work')!.episodes[0]!.positionSeconds, 0);
    const staffView = (await desk('GET', '/admin/v1/tv/series')).body.find((x: any) => x.id === draft.id);
    assert.equal(staffView.episodes[0].viewers, 1);                                              // a count, not a name
    assert.ok(!JSON.stringify(staffView).includes('Thandi'));
  } finally { await s.close(); }
});

test('matching and search respect the other member: opted out, hidden or blocked members are never suggested or found', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), chloe = s.client(), sipho = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await chloe.signIn({ email: 'chloe@example.com' }); await sipho.signIn({ email: 'sipho@example.com' });
    const names = async () => (await thandi.listSuggestions()).map((x) => x.member.fullName);
    assert.ok((await names()).includes('Chloe van der Merwe'));
    await chloe.updatePrivacySettings({ showInDirectory: true, marketingEmail: false, suggestions: false, weeklyBrief: true, dailyBrief: true });
    assert.ok(!(await names()).includes('Chloe van der Merwe'));                               // she opted out of being suggested
    assert.equal((await thandi.search('longkloof')).filter((r) => r.kind === 'member').length, 1);   // but is still in the directory
    await chloe.updatePrivacySettings({ showInDirectory: false, marketingEmail: false, suggestions: true, weeklyBrief: true, dailyBrief: true });
    assert.ok(!(await names()).includes('Chloe van der Merwe'));                               // hidden from the directory
    assert.equal((await thandi.search('longkloof')).filter((r) => r.kind === 'member').length, 0);
    await chloe.updatePrivacySettings({ showInDirectory: true, marketingEmail: false, suggestions: true, weeklyBrief: true, dailyBrief: true });
    assert.ok((await names()).includes('Chloe van der Merwe'));
    const consents = await s.db.query(`SELECT granted FROM consent_events WHERE consent_key = 'suggestions' ORDER BY occurred_at`);
    assert.deepEqual(consents.map((c) => c.granted), [false, true]);

    const siphoId = (await thandi.listMembers()).find((m) => m.fullName === 'Sipho Ndlovu')!.id;
    assert.equal((await thandi.search('ledgerline')).filter((r) => r.kind === 'member').length, 1);
    await sipho.blockMember((await sipho.listMembers()).find((m) => m.fullName === 'Thandi Mokoena')!.id);
    assert.equal((await thandi.search('ledgerline')).length, 0);                                // blocked by him: gone from her search
    await assert.rejects(thandi.getMember(siphoId), fails('not_found'));
    assert.ok(!(await names()).includes('Sipho Ndlovu'));
  } finally { await s.close(); }
});

test('qera: a misbehaving model cannot exceed the member, act without confirmation, or reach another member', async () => {
  const s = await startServer();
  try {
    // A model that ignores the rules: it asks for whatever it is told to, including things it was never offered.
    const { buildApp } = await import('../src/app.ts');
    let wanted: { name: string; args: Record<string, unknown> } | null = null;
    const seen: string[][] = [];
    const rogue = { name: 'rogue', next: async ({ results, tools }: { results: { data: unknown }[]; tools: string[] }) => { seen.push(tools); return results.length || !wanted ? { reply: 'ok ' + JSON.stringify(results.map((r) => r.data)) } : { toolCall: wanted as never }; } };
    const app = await buildApp(s.db, { webOrigins: [], authMode: 'dev', secureCookies: false, payments: s.payments, email: s.email, webUrl: 'https://app.quintara.test', signInLimit: 1000, qeraModel: rogue, qeraLimit: 1000 });
    const as = async (email: string) => { const cookie = (await app.inject({ method: 'POST', url: '/v1/session', payload: { email } })).cookies.map((c) => `${c.name}=${c.value}`).join('; '); return async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object }); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; }; };
    const thandi = await as('thandi@example.com'), daniel = await as('daniel@example.com');
    const ask = async (who: typeof thandi, call: typeof wanted) => { wanted = call; return (await who('POST', '/v1/qera/messages', { text: 'do it' })).body; };

    // Tools that do not exist, or with malformed arguments, are refused before anything runs.
    assert.ok((await ask(thandi, { name: 'delete_everything', args: {} })).messages.at(-1).text.includes('not something I can do'));
    assert.ok((await ask(thandi, { name: 'book_experience', args: { experienceId: 'x', seats: 500 } })).messages.at(-1).text.includes('could not work out'));

    // An action is never run on the model's say-so: it only ever becomes a proposal.
    const aura = (await thandi('GET', '/v1/experiences')).body.find((e: any) => e.title === 'The Aura Enclave');
    const proposed = await ask(thandi, { name: 'book_experience', args: { experienceId: aura.id, seats: 1 } });
    assert.ok(proposed.pending && (await thandi('GET', '/v1/me/bookings')).body.every((b: any) => b.experienceTitle !== 'The Aura Enclave'));

    // Another member cannot confirm, decline or see it.
    assert.equal((await daniel('POST', `/v1/qera/proposals/${proposed.pending.id}/confirm`)).status, 409);
    assert.equal((await daniel('POST', `/v1/qera/proposals/${proposed.pending.id}/cancel`)).status, 409);
    assert.deepEqual((await daniel('GET', '/v1/qera')).body, { messages: [], pending: null, usage: null });

    // A proposal lapses: confirming late does nothing.
    await s.db.query(`UPDATE qera_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [proposed.pending.id]);
    assert.equal((await thandi('POST', `/v1/qera/proposals/${proposed.pending.id}/confirm`)).status, 409);
    assert.equal((await thandi('GET', '/v1/qera')).body.pending, null);

    // The model cannot reach what the member cannot: a hidden experience, another member's booking, a blocked member.
    const danielBooking = (await daniel('POST', `/v1/experiences/${aura.id}/bookings`, { seats: 1 })).body;
    assert.ok((await ask(thandi, { name: 'cancel_booking', args: { bookingId: danielBooking.id } })).messages.at(-1).text.includes('could not find that booking'));
    const sipho = (await thandi('GET', '/v1/members')).body.find((m: any) => m.fullName === 'Sipho Ndlovu');
    await thandi('PUT', `/v1/members/${sipho.id}/block`);
    const blocked = await ask(thandi, { name: 'request_connection', args: { memberId: sipho.id } });
    assert.ok(blocked.pending === null && blocked.messages.at(-1).text.includes('not available'));
    assert.ok(!JSON.stringify(await ask(thandi, { name: 'search', args: { query: 'ledgerline' } })).includes('Sipho'));

    // What the model reads back never includes contact details, and every use is in the audit log.
    assert.ok(!JSON.stringify(await ask(thandi, { name: 'list_suggestions', args: {} })).includes('@'));
    assert.ok(seen.every((tools) => !tools.includes('delete_everything')));
    const trail = await s.db.query(`SELECT action, changes FROM audit_logs WHERE action LIKE 'qera.%' ORDER BY occurred_at`);
    assert.ok(trail.some((r) => r.action === 'qera.proposed') && trail.some((r) => r.action === 'qera.tool_used' && (r.changes as any).model === 'rogue'));
    assert.ok(!trail.some((r) => r.action === 'qera.confirmed'));

    // A flood of messages is slowed down.
    const limited = await buildApp(s.db, { webOrigins: [], authMode: 'dev', secureCookies: false, payments: s.payments, email: s.email, webUrl: 'https://app.quintara.test', signInLimit: 1000, qeraLimit: 2 });
    const cookie = (await limited.inject({ method: 'POST', url: '/v1/session', payload: { email: 'aisha@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await limited.inject({ method: 'POST', url: '/v1/qera/messages', headers: { cookie }, payload: { text: 'hello' } })).statusCode);
    assert.deepEqual(codes, [200, 200, 429]);
    await app.close(); await limited.close();
  } finally { await s.close(); }
});

test('business desk: staff add, edit and remove opportunities, correct a listing, and answer as relationship manager', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), daniel = s.client(), chloe = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await daniel.signIn({ email: 'daniel@example.com' }); await chloe.signIn({ email: 'chloe@example.com' });
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com');
    // The concierge desk does not hold the business permission.
    for (const [method, url] of [['GET', '/admin/v1/business/updates'], ['GET', '/admin/v1/business/enquiries'], ['POST', '/admin/v1/business/updates']] as const) assert.equal((await desk(method, url, {})).status, 403);

    // Add: a draft is invisible; publishing shows it to the roles it is addressed to.
    assert.equal((await admin('POST', '/admin/v1/business/updates', { title: 'x', summary: 'too short' })).status, 422);
    const created = await admin('POST', '/admin/v1/business/updates', { title: 'A wine estate seeking a hospitality operator', summary: 'A family estate in the Winelands would like to meet an operator for its guest house and restaurant.', sector: 'Hospitality', audience: ['founder'] });
    assert.equal(created.status, 200);
    const id = created.body.id as string;
    assert.ok(!(await thandi.listBusinessUpdates()).some((u) => u.id === id));
    assert.equal((await admin('PATCH', `/admin/v1/business/updates/${id}`, { status: 'published' })).status, 204);
    assert.ok((await thandi.listBusinessUpdates()).some((u) => u.id === id));
    assert.ok(!(await chloe.listBusinessUpdates()).some((u) => u.id === id));   // a creative, not a founder
    // Update: the change is what members read.
    assert.equal((await admin('PATCH', `/admin/v1/business/updates/${id}`, { title: 'A Winelands estate seeking an operator', audience: [] })).status, 204);
    assert.equal((await chloe.listBusinessUpdates()).find((u) => u.id === id)?.title, 'A Winelands estate seeking an operator');

    // Relationship manager: the member writes, staff reply, the member is notified, and nobody else can read it.
    const enquiry = await thandi.createRmEnquiry({ topic: 'opportunity', subject: 'The Winelands estate', message: 'We run hospitality brands and would like the briefing.', updateId: id });
    const queue = (await admin('GET', '/admin/v1/business/enquiries')).body;
    assert.deepEqual([queue.length, queue[0].memberName, queue[0].updateTitle, queue[0].messages[0].body], [1, 'Thandi Mokoena', 'A Winelands estate seeking an operator', 'We run hospitality brands and would like the briefing.']);
    assert.equal(JSON.stringify(queue).includes('@example.com'), false);   // no contact details in the queue
    assert.equal((await admin('POST', `/admin/v1/business/enquiries/${enquiry.id}/reply`, { body: 'Thank you. I will send the briefing and arrange a first conversation.' })).status, 204);
    const mine = (await thandi.listRmEnquiries())[0]!;
    assert.deepEqual(mine.messages.map((m) => m.from), ['member', 'manager']);
    assert.ok((await thandi.listNotifications()).some((n) => n.title.includes('Wayne Huffton, replied')));
    assert.deepEqual(await daniel.listRmEnquiries(), []);
    await assert.rejects(daniel.sendRmMessage(enquiry.id, 'Reading someone else\u2019s enquiry.'), fails('not_found'));
    assert.equal((await daniel.listBusinessUpdates()).length, 4);   // an investor sees those for investors too
    const exported = await thandi.exportMyData() as { relationshipManagerEnquiries: { subject: string }[] };
    assert.equal(exported.relationshipManagerEnquiries[0]!.subject, 'The Winelands estate');

    // Remove: the opportunity goes; the conversation stays, without the link.
    assert.equal((await admin('DELETE', `/admin/v1/business/updates/${id}`)).status, 204);
    assert.ok(!(await thandi.listBusinessUpdates()).some((u) => u.id === id));
    assert.equal((await thandi.listRmEnquiries())[0]!.updateTitle, null);
    assert.equal((await admin('DELETE', `/admin/v1/business/updates/${id}`)).status, 404);
    assert.equal((await admin('POST', `/admin/v1/business/enquiries/${enquiry.id}/close`)).status, 204);
    await assert.rejects(thandi.sendRmMessage(enquiry.id, 'Is this still open?'), fails('conflict'));
    assert.equal((await admin('POST', `/admin/v1/business/enquiries/${enquiry.id}/reply`, { body: 'Too late.' })).status, 409);

    // Correct a member's listing: the text changes, a capital listing stays with investors only, the owner is told.
    const listings = (await admin('GET', '/admin/v1/business/listings')).body;
    const film = listings.find((l: any) => l.title === 'Brands with a story worth filming'), capital = listings.find((l: any) => l.kind === 'capital');
    assert.equal((await admin('PATCH', `/admin/v1/business/listings/${film.id}`, { title: 'Brands with a story worth a film', audience: ['founder'] })).status, 204);
    assert.equal((await admin('PATCH', `/admin/v1/business/listings/${capital.id}`, { audience: ['founder', 'creative'] })).status, 204);
    const after = (await admin('GET', '/admin/v1/business/listings')).body;
    assert.deepEqual(after.find((l: any) => l.id === film.id).audience, ['founder']);
    assert.deepEqual(after.find((l: any) => l.id === capital.id).audience, ['investor']);
    assert.ok((await thandi.listBusinessListings()).some((l) => l.title === 'Brands with a story worth a film'));
    assert.ok((await chloe.listNotifications()).some((n) => n.title.includes('edited your listing')));
    assert.equal((await desk('PATCH', `/admin/v1/business/listings/${film.id}`, { title: 'Not allowed to do this' })).status, 403);

    const log = await s.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'business_update.%' OR action LIKE 'rm.%' OR action = 'listing.edited' ORDER BY occurred_at`);
    for (const action of ['business_update.created', 'business_update.updated', 'business_update.deleted', 'rm.enquiry_opened', 'rm.replied', 'rm.enquiry_closed', 'listing.edited']) assert.ok(log.some((row) => row.action === action), action);
  } finally { await s.close(); }
});

test('lifestyle desk: services, booking requests, the partner directory, home slides and profile pictures', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), daniel = s.client(), guest = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await daniel.signIn({ email: 'daniel@example.com' });
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com'), content = await s.staff('content@example.com');

    // Services: staff add and edit; a draft or archived one is not offered.
    const added = await desk('POST', '/admin/v1/services', { name: 'Cape Helicopters', description: 'Scenic flights.', category: 'Mobility' });
    assert.equal(added.status, 200);
    assert.equal((await desk('POST', '/admin/v1/services', { name: 'cape helicopters' })).status, 409);
    assert.ok(!(await guest.listLifestyleServices()).some((x) => x.name === 'Cape Helicopters'));
    assert.equal((await desk('PATCH', `/admin/v1/services/${added.body.id}`, { status: 'published', description: 'Scenic flights over the peninsula.' })).status, 204);
    const offered = (await guest.listLifestyleServices()).find((x) => x.name === 'Cape Helicopters')!;
    assert.equal(offered.description, 'Scenic flights over the peninsula.');
    assert.equal(offered.category, 'Mobility');
    assert.equal((await desk('PATCH', `/admin/v1/services/${added.body.id}`, { category: 'Travel' })).status, 204);
    assert.equal((await guest.listLifestyleServices()).find((x) => x.name === 'Cape Helicopters')!.category, 'Travel');

    // Requests: the desk sees who asked; a member is told when it moves; a guest's details stay with the desk.
    await guest.requestLifestyleService(offered.id, { notes: 'For two.', guest: { fullName: 'Lerato Dlamini', email: 'Lerato@Example.org' } });
    const mine = await thandi.requestLifestyleService(offered.id, { preferredDate: '2030-12-06' });
    const queue = (await desk('GET', '/admin/v1/service-requests')).body;
    assert.deepEqual(queue.map((r: any) => [r.contactName, r.contactEmail, r.isMember]), [['Lerato Dlamini', 'lerato@example.org', false], ['Thandi Mokoena', 'thandi@example.com', true]]);
    assert.equal((await desk('POST', `/admin/v1/service-requests/${mine.id}/status`, { status: 'confirmed' })).status, 204);
    assert.equal((await thandi.listMyServiceRequests())[0]!.status, 'confirmed');
    assert.ok((await thandi.listNotifications()).some((n) => n.title === 'Your request for Cape Helicopters is confirmed.'));
    assert.deepEqual(await daniel.listMyServiceRequests(), []);
    await assert.rejects(daniel.cancelMyServiceRequest(mine.id), fails('not_found'));
    assert.equal((await desk('PATCH', `/admin/v1/services/${added.body.id}`, { status: 'archived' })).status, 204);
    await assert.rejects(guest.requestLifestyleService(offered.id, { guest: { fullName: 'Lerato Dlamini', email: 'lerato@example.org' } }), fails('not_found'));
    const exported = await thandi.exportMyData() as { serviceRequests: { service: string }[] };
    assert.equal(exported.serviceRequests[0]!.service, 'Cape Helicopters');

    // Partner directory: staff enter the partner's contact details; members see them.
    const saffron = (await desk('GET', '/admin/v1/partners')).body.find((p: any) => p.name === 'Saffron House');
    assert.equal((await desk('PATCH', `/admin/v1/partners/${saffron.id}`, { contactEmail: 'not an email' })).status, 422);
    assert.equal((await desk('PATCH', `/admin/v1/partners/${saffron.id}`, { offer: 'Dinner, private dining and a chef\u2019s table.', contactName: 'Aisha Parker', contactEmail: 'bookings@saffronhouse.example', contactPhone: '+27 21 555 0142', address: '12 Wale Street, Bo-Kaap' })).status, 204);
    const seen = (await thandi.listPartners()).find((p) => p.name === 'Saffron House')!;
    assert.deepEqual([seen.contactName, seen.contactEmail, seen.contactPhone, seen.address], ['Aisha Parker', 'bookings@saffronhouse.example', '+27 21 555 0142', '12 Wale Street, Bo-Kaap']);
    await assert.rejects(guest.listPartners(), fails('unauthenticated'));

    // Home slides: a photograph that was uploaded, or a film by https link; visitors see the active ones in order.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const image = (await desk('POST', '/admin/v1/media', { contentType: 'image/png', dataBase64: png })).body;
    assert.equal((await content('POST', '/admin/v1/home-slides', { kind: 'video', videoUrl: 'http://insecure.example/film.mp4' })).status, 422);
    assert.equal((await content('POST', '/admin/v1/home-slides', { kind: 'image', imageId: '00000000-0000-4000-8000-000000000000' })).status, 422);
    const photo = await content('POST', '/admin/v1/home-slides', { kind: 'image', imageId: image.id, caption: 'Welcome', position: 2 });
    const film = await content('POST', '/admin/v1/home-slides', { kind: 'video', videoUrl: 'https://video.example/welcome.mp4', position: 1 });
    assert.deepEqual((await guest.listHomeSlides()).map((x) => [x.kind, x.src]), [['video', 'https://video.example/welcome.mp4'], ['image', image.path]]);
    assert.equal((await content('PATCH', `/admin/v1/home-slides/${film.body.id}`, { isActive: false })).status, 204);
    assert.deepEqual((await guest.listHomeSlides()).map((x) => x.kind), ['image']);
    assert.equal((await content('DELETE', `/admin/v1/home-slides/${photo.body.id}`)).status, 204);
    assert.deepEqual(await guest.listHomeSlides(), []);
    assert.equal((await thandi.listHomeSlides()).length, 0);

    // Profile pictures: other members see it; a file that is not an image is refused; replacing removes the old one.
    await assert.rejects(thandi.setMyAvatar('image/png', Buffer.from('this is not an image at all').toString('base64')), fails('validation'));
    const first = (await thandi.setMyAvatar('image/png', png)).avatarPath!;
    const me = (await thandi.getMyProfile()).id;
    assert.equal((await daniel.getMember(me)).avatarPath, first);
    const second = (await thandi.setMyAvatar('image/png', png)).avatarPath!;
    assert.notEqual(second, first);
    assert.equal((await s.app.inject({ method: 'GET', url: first })).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'GET', url: second })).statusCode, 200);
    await thandi.removeMyAvatar();
    assert.equal((await s.app.inject({ method: 'GET', url: second })).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'GET', url: image.path })).statusCode, 200);   // staff photographs are untouched
    void admin;
  } finally { await s.close(); }
});

test('qera partner bookings: the partner is written to, answers through a private link, and a refusal goes to the Lifestyle Curator', async () => {
  const s = await startServer();
  try {
    const thandi = s.client(), daniel = s.client(), partner = s.client();
    await thandi.signIn({ email: 'thandi@example.com' }); await daniel.signIn({ email: 'daniel@example.com' });
    const desk = await s.staff('desk@example.com'), admin = await s.staff('admin@example.com');
    const book = async (who: typeof thandi, text: string) => { const proposed = await who.sendQeraMessage(text); assert.equal(proposed.pending?.tool, 'book_partner', proposed.messages.at(-1)!.text); return who.confirmQeraProposal(proposed.pending!.id); };

    // A partner with no contact in the directory cannot be written to: that one is referred, not sent.
    const saffron = (await desk('GET', '/admin/v1/partners')).body.find((p: any) => p.name === 'Saffron House');
    await desk('PATCH', `/admin/v1/partners/${saffron.id}`, { contactEmail: '', contactName: '' });
    const referred = await thandi.sendQeraMessage('Book Saffron House on 2030-12-06 at 7pm for four');
    assert.equal(referred.pending?.tool, 'create_concierge_request');
    await thandi.cancelQeraProposal(referred.pending!.id);
    await desk('PATCH', `/admin/v1/partners/${saffron.id}`, { contactEmail: 'table@saffronhouse.example', contactName: 'Aisha Parker' });

    // Sent to the directory contact, with the member's name and the booking, and nothing else about them.
    await book(thandi, 'Book Saffron House on 2030-12-06 at 7pm for four');
    await s.app.flushEmails();
    const mail = s.email.sent.find((m) => m.to === 'table@saffronhouse.example')!;
    assert.ok(mail.subject === 'Booking request from Quintara: Thandi Mokoena, Friday 6 December at 19:00' && mail.text.startsWith('Dear Aisha,') && mail.text.includes('Guests: 4'), mail.text);
    assert.ok(!mail.text.includes('thandi@example.com') && !mail.text.includes('Q-1001'));
    const token = /partner-booking\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    assert.ok(mail.text.includes(`https://app.quintara.test/partner-booking/${token}`));
    // Only a hash of the token is kept.
    const stored = await s.db.query('SELECT token_hash, emailed_at FROM partner_bookings');
    assert.ok(stored[0]!.token_hash !== token && !JSON.stringify(stored).includes(token) && stored[0]!.emailed_at);
    await s.app.flushEmails();
    assert.equal(s.email.sent.filter((m) => m.to === 'table@saffronhouse.example').length, 1);   // sent once

    // The partner needs no account: the link shows the booking and takes the answer, once.
    const seen = await partner.getPartnerBookingByToken(token);
    assert.deepEqual(seen, { partnerName: 'Saffron House', memberName: 'Thandi Mokoena', date: '2030-12-06', time: '19:00', partySize: 4, notes: '', status: 'requested' });
    await assert.rejects(partner.getPartnerBookingByToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), fails('not_found'));
    assert.equal((await partner.respondToPartnerBooking(token, 'confirm', 'Table by the window.')).status, 'confirmed');
    await assert.rejects(partner.respondToPartnerBooking(token, 'decline'), fails('conflict'));
    assert.equal((await thandi.listPartnerBookings())[0]!.status, 'confirmed');
    assert.ok((await thandi.listNotifications()).some((n) => n.title === 'Saffron House has confirmed your booking for Friday 6 December at 19:00. They say: Table by the window.'));
    assert.deepEqual(await daniel.listPartnerBookings(), []);
    await assert.rejects(daniel.cancelPartnerBooking((await thandi.listPartnerBookings())[0]!.id), fails('not_found'));

    // A refusal: the Lifestyle Curator is given it, without the member having to ask.
    await book(daniel, 'Reserve Saffron House on 2030-12-08 for two');
    await s.app.flushEmails();
    const second = /partner-booking\/([A-Za-z0-9_-]+)/.exec(s.email.sent.filter((m) => m.to === 'table@saffronhouse.example').at(-1)!.text)![1]!;
    const before = (await daniel.listConciergeRequests()).length;
    assert.equal((await partner.respondToPartnerBooking(second, 'decline', 'Closed for a private event.')).status, 'declined');
    const requests = await daniel.listConciergeRequests();
    assert.equal(requests.length, before + 1);
    assert.ok(requests[0]!.subject.startsWith('An alternative to Saffron House') && requests[0]!.details.includes('Closed for a private event.'));
    assert.ok((await daniel.listNotifications()).some((n) => n.title.includes('could not take your booking') && n.title.includes('Palesa Makam')));

    // The desk sees what QÉRA has sent and can answer for a partner who telephones; other staff cannot.
    await book(thandi, 'Book Saffron House on 2030-12-10 for six');
    const queue = (await desk('GET', '/admin/v1/partner-bookings')).body;
    assert.deepEqual(queue.map((b: any) => [b.memberName, b.date, b.status]), [['Thandi Mokoena', '2030-12-10', 'requested'], ['Thandi Mokoena', '2030-12-06', 'confirmed'], ['Daniel Fourie', '2030-12-08', 'declined']]);
    assert.equal((await desk('POST', `/admin/v1/partner-bookings/${queue[0].id}/settle`, { answer: 'confirm' })).status, 204);
    assert.equal((await desk('POST', `/admin/v1/partner-bookings/${queue[0].id}/settle`, { answer: 'decline' })).status, 409);
    assert.equal((await thandi.listPartnerBookings()).find((b) => b.date === '2030-12-10')!.status, 'confirmed');

    // Documents are private to the member they were prepared for, and are part of their data.
    await thandi.sendQeraMessage('Prepare an itinerary for a weekend from 2030-12-06');
    const mine = (await thandi.listQeraDocuments())[0]!;
    await assert.rejects(daniel.getQeraDocument(mine.id), fails('not_found'));
    await assert.rejects(daniel.deleteQeraDocument(mine.id), fails('not_found'));
    const exported = await thandi.exportMyData() as { qeraDocuments: unknown[]; partnerBookings: { partner: string }[] };
    assert.deepEqual([exported.qeraDocuments.length, exported.partnerBookings.length], [1, 2]);

    const log = await s.db.query(`SELECT action, changes FROM audit_logs WHERE action LIKE 'partner_booking.%' ORDER BY occurred_at`);
    assert.deepEqual(log.map((row) => row.action).sort(), ['partner_booking.confirmed', 'partner_booking.confirmed', 'partner_booking.declined', 'partner_booking.requested', 'partner_booking.requested', 'partner_booking.requested']);
    void admin;
  } finally { await s.close(); }
});

test('guest accounts: QÉRA time is counted on the server, stops at the daily limit, and staff choose which experiences guests see', async () => {
  const s = await startServer();
  try {
    const { buildApp } = await import('../src/app.ts');
    // A two-second allowance stands in for five hours.
    const app = await buildApp(s.db, { webOrigins: [], authMode: 'dev', secureCookies: false, payments: s.payments, email: s.email, webUrl: 'https://app.quintara.test', signInLimit: 1000, qeraLimit: 1000, guestQeraSeconds: 2 });
    const created = await app.inject({ method: 'POST', url: '/v1/guest/account', payload: { fullName: 'Lerato Guest', email: 'lerato.guest@example.com' } });
    assert.equal(created.statusCode, 201);
    const cookie = created.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => { const r = await app.inject({ method, url, headers: { cookie }, payload }); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
    // An address already in use cannot be taken, and a guest is not let in through the member sign-in.
    assert.equal((await app.inject({ method: 'POST', url: '/v1/guest/account', payload: { fullName: 'Someone', email: 'thandi@example.com' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'lerato.guest@example.com' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/guest/session', payload: { email: 'thandi@example.com' } })).statusCode, 401);

    assert.equal((await call('POST', '/v1/qera/messages', { text: 'hello' })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const last = await call('POST', '/v1/qera/messages', { text: 'What is Quintara?' });
    assert.equal(last.status, 200);
    assert.equal(last.body.usage.exhausted, true);
    const refused = await call('POST', '/v1/qera/messages', { text: 'One more question' });
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /Apply for membership/);
    // A heartbeat cannot push the count past the limit, and the day is the market's local day.
    assert.equal((await call('POST', '/v1/qera/heartbeat')).body.usedSeconds, 2);
    const day = (await s.db.query<{ usage_day: string }>(`SELECT to_char(usage_day, 'YYYY-MM-DD') AS usage_day FROM qera_guest_usage`))[0]!.usage_day;
    assert.equal(day, new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    // Guests are never offered an action, and the tools they used are on the audit trail.
    const tools = await s.db.query<{ tool: string }>(`SELECT changes->>'tool' AS tool FROM audit_logs WHERE action = 'qera.tool_used'`);
    assert.ok(tools.every((row) => ['about_quintara', 'list_services', 'list_experiences', 'recommend', 'search'].includes(row.tool)));
    assert.equal((await s.db.query(`SELECT 1 FROM qera_proposals`)).length, 0);

    // Staff open an experience to guests, or take it away. Guests still see no date or seats.
    const admin = await s.staff('admin@example.com');
    const all = (await admin('GET', '/admin/v1/experiences')).body as { id: string; title: string; openToGuests: boolean }[];
    const tennis = all.find((e) => e.title === 'Quintara Tennis Social')!, feast = all.find((e) => e.title === 'House Feast')!;
    assert.equal(tennis.openToGuests, false);
    assert.equal((await admin('PATCH', `/admin/v1/experiences/${tennis.id}`, { openToGuests: true })).status, 200);
    assert.equal((await admin('PATCH', `/admin/v1/experiences/${feast.id}`, { openToGuests: false })).status, 200);
    const seen = (await call('GET', '/v1/experiences')).body as { title: string; startsAt: string | null; capacity: number | null }[];
    assert.ok(seen.some((e) => e.title === 'Quintara Tennis Social') && !seen.some((e) => e.title === 'House Feast'));
    assert.ok(seen.every((e) => e.startsAt === null && e.capacity === null));
    assert.equal((await call('GET', `/v1/experiences/${feast.id}`)).status, 404);
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('PATCH', `/admin/v1/experiences/${feast.id}`, { openToGuests: true })).status, 200);   // the desk runs experiences

    // Deleting the account erases it at once.
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/guest/account', headers: { cookie } })).statusCode, 204);
    assert.equal((await s.db.query(`SELECT 1 FROM guest_accounts`)).length, 0);
    assert.equal((await s.db.query(`SELECT 1 FROM qera_messages m JOIN users u ON u.id = m.user_id WHERE u.status = 'deleted'`)).length, 0);
    assert.equal((await call('GET', '/v1/qera')).status, 401);
    await app.close();
  } finally { await s.close(); }
});

test('chief of staff: QÉRA sends reminders, the Monday brief, dates and the eve of bookings once each; staff manage packages', async () => {
  const s = await startServer();
  try {
    const { runChiefOfStaff } = await import('../src/chief.ts');
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const day = (n: number) => new Date(Date.now() + 2 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
    await thandi.createReminder({ text: 'Call the florist', date: day(1), time: '09:00' });
    await thandi.addQeraMemory({ kind: 'date', label: 'Our anniversary', date: `2019-${day(10).slice(5)}` });
    await thandi.addQeraMemory({ kind: 'dietary', label: 'Vegetarian' });
    // Two days on, on a Monday morning in Cape Town: the reminder is due and the brief goes out.
    let monday = new Date(Date.now() + 2 * 86_400_000); while (new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short' }).format(monday) !== 'Mon') monday = new Date(monday.getTime() + 86_400_000);
    const at = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(monday)}T08:00:00+02:00`);
    if (at.getTime() < Date.now() + 2 * 86_400_000) at.setTime(at.getTime() + 7 * 86_400_000);
    const sent = await runChiefOfStaff(s.db, at);
    assert.ok(sent >= 2);
    const titles = (await thandi.listNotifications()).map((n) => n.title);
    assert.ok(titles.includes('Reminder from QÉRA: Call the florist'), titles.join('|'));
    assert.ok(titles.includes('Your week with QÉRA is ready.'));
    assert.ok(titles.some((t) => /^Good morning\. Your daily brief is ready: (one thing on your day|\d+ things on your day|your day is clear)\.$/.test(t)), titles.join('|'));
    assert.equal(await runChiefOfStaff(s.db, at), 0);   // each is sent once
    assert.equal((await thandi.listReminders()).find((r) => r.text === 'Call the florist')?.status, 'sent');
    // The remembered date, within two weeks of that Monday.
    assert.ok((await thandi.listNotifications()).some((n) => /^Our anniversary is on .*\. Shall I plan something\?$/.test(n.title)), titles.join('|'));
    // Switching the briefs off stops what QÉRA sends of its own accord.
    await thandi.updatePrivacySettings({ ...(await thandi.getPrivacySettings()), weeklyBrief: false, dailyBrief: false });
    const before = (await thandi.listNotifications()).length;
    await runChiefOfStaff(s.db, new Date(at.getTime() + 7 * 86_400_000));
    assert.equal((await thandi.listNotifications()).length, before);
    assert.equal((await thandi.getWeeklyBrief()).enabled, false);
    // What QÉRA remembers is in the export; the audit trail says that memory changed, never what it says.
    const exported = await thandi.exportMyData() as { qeraMemory: { label: string }[]; qeraReminders: unknown[] };
    assert.deepEqual(exported.qeraMemory.map((m) => m.label).sort(), ['Our anniversary', 'Vegetarian']);
    const trail = await s.db.query(`SELECT changes FROM audit_logs WHERE action LIKE 'qera.memory%'`);
    assert.ok(trail.length >= 2 && !JSON.stringify(trail).includes('Vegetarian'));
    // Another member sees none of it.
    const daniel = s.client(); await daniel.signIn({ email: 'daniel@example.com' });
    assert.deepEqual((await daniel.getQeraMemory()).items, []);
    assert.deepEqual(await daniel.listReminders(), []);
    const mine = (await thandi.getQeraMemory()).items[0]!;
    await assert.rejects(daniel.deleteQeraMemory(mine.id), fails('not_found'));

    // Packages: the content desk adds, edits and removes them; a removed package leaves old requests intact.
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com');
    const services = (await admin('GET', '/admin/v1/services')).body as { id: string; name: string; packages: { id: string; name: string }[] }[];
    const chef = services.find((x) => x.name === 'The Culinary House')!;
    assert.equal(chef.packages.length, 3);
    assert.equal((await admin('POST', `/admin/v1/services/${chef.id}/packages`, { name: 'x' })).status, 422);
    const created = await desk('POST', `/admin/v1/services/${chef.id}/packages`, { name: 'Sunday lunch', priceMinor: 180000, priceBasis: 'per_person', leadTimeHours: 72 });
    assert.equal(created.status, 200);
    assert.ok((await thandi.listLifestyleServices()).find((x) => x.id === chef.id)!.packages.some((p) => p.name === 'Sunday lunch'));
    assert.equal((await admin('PATCH', `/admin/v1/service-packages/${created.body.id}`, { priceMinor: null })).status, 204);
    const req = await thandi.requestLifestyleService(chef.id, { notes: 'For eight.', packageId: created.body.id });
    assert.equal(req.priceLabel, 'Price on request');
    assert.equal((await admin('DELETE', `/admin/v1/service-packages/${created.body.id}`)).status, 204);
    assert.equal((await thandi.listMyServiceRequests())[0]!.packageName, 'Sunday lunch');
    assert.equal((await thandi.listMyServiceRequests())[0]!.priceLabel, 'Price on request');
    // Erasing the account removes the memory and reminders.
    const { eraseAccount } = await import('../src/privacy.ts');
    const userId = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    await s.db.query(`INSERT INTO account_closures (user_id, erase_after) VALUES ($1, now())`, [userId]).catch(() => undefined);
    if (await eraseAccount(s.db, userId, null)) {
      assert.equal((await s.db.query('SELECT 1 FROM qera_memory WHERE user_id = $1', [userId])).length, 0);
      assert.equal((await s.db.query('SELECT 1 FROM qera_reminders WHERE user_id = $1', [userId])).length, 0);
    }
  } finally { await s.close(); }
});

test('cities: staff work city by city, prepare a closed city, open it, and cannot close the last one', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com'), desk = await s.staff('desk@example.com');
    const inCity = async (who: typeof admin, slug: string, method: string, url: string, body?: unknown) => {
      const cookie = (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: who === admin ? 'admin@example.com' : 'desk@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const r = await s.app.inject({ method: method as 'GET', url, headers: { cookie, 'x-quintara-market': slug }, payload: body as object | undefined });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    };
    const cities = (await admin('GET', '/admin/v1/markets')).body as { id: string; slug: string; isOpen: boolean; experiences: number; members: number }[];
    assert.deepEqual(cities.map((c) => [c.slug, c.isOpen]), [['cape-town', true], ['johannesburg', true], ['durban', false]]);
    assert.deepEqual(cities.map((c) => c.members), [5, 2, 0]);
    // The desk sees the cities to work in, but cannot open, close or add them.
    assert.equal((await desk('GET', '/admin/v1/markets')).status, 200);
    assert.equal((await desk('PATCH', `/admin/v1/markets/${cities[2]!.id}`, { isOpen: true })).status, 403);
    assert.equal((await desk('POST', '/admin/v1/markets', { name: 'Stellenbosch', countryCode: 'ZA', timezone: 'Africa/Johannesburg', currency: 'ZAR' })).status, 403);

    // Lists follow the city staff are working in; new entries are created there.
    assert.deepEqual((await inCity(admin, 'johannesburg', 'GET', '/admin/v1/experiences')).body.map((e: { title: string }) => e.title), ['The Rooftop Supper', 'Founders Breakfast']);
    assert.equal((await inCity(admin, 'johannesburg', 'GET', '/admin/v1/members')).body.length, 2);
    assert.deepEqual((await inCity(admin, 'durban', 'GET', '/admin/v1/experiences')).body.map((e: { title: string }) => e.title), ['Durban opening evening']);
    const made = await inCity(admin, 'durban', 'POST', '/admin/v1/partners', { name: 'Umhlanga Beach House', category: 'Dining', status: 'published' });
    assert.equal(made.status, 200);
    assert.equal((await inCity(admin, 'durban', 'GET', '/admin/v1/partners')).body.length, 1);
    assert.ok(!(await inCity(admin, 'cape-town', 'GET', '/admin/v1/partners')).body.some((p: { name: string }) => p.name === 'Umhlanga Beach House'));

    // A closed city is invisible to the public: asking for it falls back to an open one.
    const visitor = async (slug: string) => JSON.parse((await s.app.inject({ method: 'GET', url: '/v1/experiences', headers: { 'x-quintara-market': slug } })).body) as { title: string }[];
    assert.ok(!(await visitor('durban')).some((e) => e.title === 'Durban opening evening'));
    assert.ok(!(await s.app.inject({ method: 'GET', url: '/v1/markets' })).body.includes('durban'));
    // Opening it: the city appears, with what was prepared.
    assert.equal((await inCity(admin, 'durban', 'PATCH', `/admin/v1/experiences/${(await inCity(admin, 'durban', 'GET', '/admin/v1/experiences')).body[0].id}`, { status: 'published', openToGuests: true })).status, 200);
    assert.equal((await admin('PATCH', `/admin/v1/markets/${cities[2]!.id}`, { isOpen: true })).status, 200);
    assert.ok((await s.app.inject({ method: 'GET', url: '/v1/markets' })).body.includes('durban'));
    assert.deepEqual((await visitor('durban')).map((e) => e.title), ['Durban opening evening']);

    // A new city starts closed, with its own time zone and currency; a bad zone is refused.
    assert.equal((await admin('POST', '/admin/v1/markets', { name: 'Nairobi', countryCode: 'KE', timezone: 'Not/AZone', currency: 'KES' })).status, 422);
    assert.equal((await admin('POST', '/admin/v1/markets', { name: 'Nairobi', countryCode: 'KE', timezone: 'Africa/Nairobi', currency: 'KES' })).status, 422);   // the country is new: it needs a name
    const nairobi = await admin('POST', '/admin/v1/markets', { name: 'Nairobi', countryCode: 'KE', countryName: 'Kenya', timezone: 'Africa/Nairobi', currency: 'KES' });
    assert.deepEqual([nairobi.status, nairobi.body.slug, nairobi.body.isOpen, nairobi.body.currency, nairobi.body.timezone], [200, 'nairobi', false, 'KES', 'Africa/Nairobi']);
    assert.equal((await admin('POST', '/admin/v1/markets', { name: 'Nairobi', countryCode: 'KE', timezone: 'Africa/Nairobi', currency: 'KES' })).status, 409);

    // The last open city cannot be closed.
    for (const c of (await admin('GET', '/admin/v1/markets')).body.filter((c: { isOpen: boolean; slug: string }) => c.isOpen && c.slug !== 'cape-town')) assert.equal((await admin('PATCH', `/admin/v1/markets/${c.id}`, { isOpen: false })).status, 200);
    assert.equal((await admin('PATCH', `/admin/v1/markets/${cities[0]!.id}`, { isOpen: false })).status, 409);
    const log = await s.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'market.%'`);
    assert.ok(['market.created', 'market.opened', 'market.closed'].every((a) => log.some((r) => r.action === a)));
  } finally { await s.close(); }
});

test('calendar: a real calendar address is checked, kept encrypted, never returned, read on the server, and erased on disconnect', async () => {
  const s = await startServer();
  try {
    const { buildApp } = await import('../src/app.ts');
    const fetched: string[] = [];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date()).replaceAll('-', '');
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:one', `DTSTART;TZID=Africa/Johannesburg:${today}T091500`, `DTEND;TZID=Africa/Johannesburg:${today}T100000`, 'SUMMARY:Strategy session', 'LOCATION:Head office', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:two', `DTSTART;VALUE=DATE:${today}`, 'SUMMARY:Public holiday', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:three', 'DTSTART:20200106T050000Z', 'DTEND:20200106T053000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Morning run', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:four', `DTSTART;TZID=Africa/Johannesburg:${today}T130000`, 'SUMMARY:Cancelled lunch', 'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const app = await buildApp(s.db, { webOrigins: [], authMode: 'dev', secureCookies: false, payments: s.payments, email: s.email, webUrl: 'https://app.quintara.test', signInLimit: 1000,
      calendar: { secret: 'test-secret-for-calendar-addresses', allowSample: false, fetcher: async (url) => { fetched.push(url.toString()); return ics; } } });
    const cookie = (await app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const call = async (method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) => { const r = await app.inject({ method, url, headers: { cookie }, payload }); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r.body }; };
    const address = 'webcal://calendar.google.com/calendar/ical/thandi%40example.com/private-0123456789abcdef/basic.ics';
    // Only the provider's own host, over HTTPS; the sample calendar is off in production.
    for (const bad of ['https://calendar.google.com.evil.example/x.ics', 'http://calendar.google.com/x.ics', 'https://user:pw@calendar.google.com/x.ics', 'https://localhost/x.ics']) {
      assert.equal((await call('PUT', '/v1/me/calendar', { provider: 'google', address: bad, showTitles: true, consent: true })).status, 422, bad);
    }
    assert.equal((await call('PUT', '/v1/me/calendar', { provider: 'sample', showTitles: true, consent: true })).status, 422);
    assert.equal(fetched.length, 0);
    const connected = await call('PUT', '/v1/me/calendar', { provider: 'google', address, showTitles: true, consent: true });
    assert.equal(connected.status, 200);
    assert.equal(fetched[0], address.replace('webcal://', 'https://'));
    assert.ok(!connected.raw.includes('private-0123456789abcdef'));
    const titles = connected.body.events.map((e: { title: string }) => e.title);
    // What is still to come (an event earlier today has passed by evening, so the full day is checked in the brief below).
    assert.ok(titles.includes('Public holiday') && titles.includes('Morning run') && !titles.includes('Cancelled lunch'), titles.join('|'));
    // Stored encrypted: the address is nowhere in the database as text.
    const stored = await s.db.query<{ address_secret: string }>('SELECT address_secret FROM calendar_connections');
    assert.ok(stored[0]!.address_secret && !stored[0]!.address_secret.includes('calendar.google.com'));
    // The brief has the day in order, with the times in the member's city.
    const brief = await call('GET', '/v1/qera/brief/today');
    const mine = brief.body.agenda.filter((i: { source: string }) => i.source === 'calendar');
    assert.deepEqual(mine.map((i: { title: string; time: string | null }) => `${i.time ?? 'all day'} ${i.title}`), ['all day Public holiday', '07:00 Morning run', '09:15 Strategy session']);
    // Not in the export either; consent is recorded both ways.
    const exported = await call('GET', '/v1/me/data-export');
    assert.ok(!exported.raw.includes('private-0123456789abcdef') && exported.body.calendar.provider === 'google');
    assert.equal((await call('DELETE', '/v1/me/calendar')).status, 204);
    assert.equal((await s.db.query('SELECT 1 FROM calendar_events')).length, 0);
    assert.equal((await s.db.query('SELECT 1 FROM calendar_connections')).length, 0);
    const consents = await s.db.query<{ granted: boolean }>(`SELECT granted FROM consent_events WHERE consent_key = 'calendar' ORDER BY occurred_at`);
    assert.deepEqual(consents.map((c) => c.granted), [true, false]);
    // Another member sees nothing of it, and a visitor cannot ask.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me/calendar' })).statusCode, 401);
    await app.close();
  } finally { await s.close(); }
});

test('descriptions: staff edit what introduces each section, members and guests read it, and it can be restored', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com'), desk = await s.staff('content@example.com');
    const visitor = s.client(), thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const member = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal((await s.app.inject({ method: 'PUT', url: '/admin/v1/content/sections/club', headers: { cookie: member }, payload: { summary: 'x', description: 'Not allowed for a member.' } })).statusCode, 401);   // an app session carries no staff powers
    assert.equal((await admin('PUT', '/admin/v1/content/sections/club', { summary: 'A', description: 'short' })).status, 422);
    assert.equal((await admin('PUT', '/admin/v1/content/sections/nowhere', { summary: 'A line', description: 'A sentence long enough.' })).status, 404);
    const saved = await admin('PUT', '/admin/v1/content/sections/club', { summary: 'The people of Quintara', description: 'Founders, investors, creatives and executives, each approved by Quintara.' });
    assert.equal(saved.status, 200);
    assert.ok(saved.body.updatedAt);
    // The Content Manager looks after the descriptions.
    assert.equal((await desk('PUT', '/admin/v1/content/sections/curator', { summary: 'Lifestyle Curator, Private Client Services', description: 'Palesa arranges what you ask to book.' })).status, 200);
    // The sections added in migration 0024 are stored the same way.
    assert.equal((await admin('PUT', '/admin/v1/content/sections/relationship', { summary: 'Relationship Manager, BMM Capital', description: 'Wayne helps you pursue the opportunities you choose.' })).status, 200);
    assert.equal((await admin('PUT', '/admin/v1/content/sections/tv', { summary: 'Films', description: 'Short films from inside Quintara.' })).status, 200);
    for (const client of [visitor, thandi]) {
      const list = await client.listSectionCopy();
      assert.equal(list.find((c) => c.key === 'club')!.description, 'Founders, investors, creatives and executives, each approved by Quintara.');
      assert.equal(list.find((c) => c.key === 'curator')!.description, 'Palesa arranges what you ask to book.');
      assert.equal(list.find((c) => c.key === 'relationship')!.description, 'Wayne helps you pursue the opportunities you choose.');
      assert.equal(list.find((c) => c.key === 'tv')!.description, 'Short films from inside Quintara.');
    }
    const reset = await admin('DELETE', '/admin/v1/content/sections/club');
    assert.equal(reset.body.updatedAt, null);
    assert.match((await visitor.listSectionCopy()).find((c) => c.key === 'club')!.description, /^Every profile is approved by Quintara/);
    const log = await s.db.query(`SELECT action FROM audit_logs WHERE action LIKE 'section.%' ORDER BY occurred_at`);
    assert.deepEqual(log.map((r) => r.action), ['section.updated', 'section.updated', 'section.updated', 'section.updated', 'section.reset']);
  } finally { await s.close(); }
});

test('the applicant is told they are on the waiting list, and approval of the plan applied for asks them to pay its fee', async () => {
  const visitor = server.client();
  const plans = await visitor.listMembershipPlans();
  const chosen = plans.find((p) => p.residency === 'international' && p.termMonths === 6)!;
  await visitor.submitApplication({ ...applicant, email: 'waiting@example.com', fullName: 'Waiting Applicant', residency: 'international', planId: chosen.id });
  const user = (await server.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'waiting@example.com'`))[0]!.id;
  const titles = async () => (await server.db.query<{ title: string }>('SELECT title FROM notifications WHERE user_id = $1 ORDER BY created_at', [user])).map((r) => r.title);
  assert.deepEqual(await titles(), [APPLICATION_WAITING_LIST_MESSAGE]);
  const admin = await server.staff('admin@example.com');
  const application = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === 'Waiting Applicant');
  assert.equal(application.requestedTier.id, chosen.id);
  assert.equal((await admin('POST', `/admin/v1/applications/${application.id}/approve`, { tierId: application.requestedTier.id })).status, 204);
  assert.deepEqual(await titles(), [APPLICATION_WAITING_LIST_MESSAGE, APPLICATION_APPROVED_MESSAGE]);
  const offered = await visitor.getApplication();
  assert.equal(offered?.offeredTierName, 'International, 6 months');
  await visitor.payMembershipFee();
  const paid = (await server.db.query<{ amount_minor: string }>(`SELECT amount_minor FROM payments WHERE user_id = $1 AND purpose = 'membership'`, [user]))[0]!;
  assert.equal(Number(paid.amount_minor), 28_000_00);
  assert.ok(await visitor.getSession());
});

test('staff reword the standard questions and add their own; applicants must answer the required ones', async () => {
  const admin = await server.staff('admin@example.com');
  const desk = await server.staff('desk@example.com');
  assert.equal((await desk('POST', '/admin/v1/application/questions', { kind: 'short_text', label: 'A question' })).status, 403);
  // Reword a standard question, and change the interests.
  assert.equal((await admin('PUT', '/admin/v1/application/questions/builtin/phone', { label: 'Mobile number', help: 'Including the country code.' })).status, 200);
  assert.equal((await admin('PUT', '/admin/v1/application/questions/builtin/interests', { label: 'Your interests', options: ['Dining', 'Sailing'] })).status, 200);
  assert.equal((await admin('PUT', '/admin/v1/application/questions/builtin/nowhere', { label: 'Nothing' })).status, 404);
  // Add a required choice and an optional paragraph.
  assert.equal((await admin('POST', '/admin/v1/application/questions', { kind: 'choice', label: 'Which city would you visit most?', options: ['Cape Town'] })).status, 422);
  const created = (await admin('POST', '/admin/v1/application/questions', { kind: 'choice', label: 'Which city would you visit most?', options: ['Cape Town', 'Johannesburg'], required: true, position: 1 })).body;
  const city = created.custom.find((q: any) => q.label === 'Which city would you visit most?');
  await admin('POST', '/admin/v1/application/questions', { kind: 'long_text', label: 'Anything else?', position: 2 });

  const visitor = server.client();
  const questions = await visitor.getApplicationQuestions();
  assert.equal(questions.builtin.find((q) => q.key === 'phone')!.label, 'Mobile number');
  assert.deepEqual(questions.builtin.find((q) => q.key === 'interests')!.options, ['Dining', 'Sailing']);
  assert.deepEqual(questions.custom.map((q) => q.label), ['Which city would you visit most?', 'Anything else?']);
  const base = { ...applicant, email: 'asked@example.com', fullName: 'Asked Applicant', planId: await plan(visitor) };
  await assert.rejects(visitor.submitApplication(base), (e: unknown) => e instanceof ApiError && e.code === 'validation' && `q:${city.id}` in e.fields);
  await assert.rejects(visitor.submitApplication({ ...base, answers: { [city.id]: 'Durban' } }), (e: unknown) => e instanceof ApiError && `q:${city.id}` in (e as ApiError).fields);
  const sent = await visitor.submitApplication({ ...base, answers: { [city.id]: 'Johannesburg', 'not-a-question': 'dropped' } });
  assert.deepEqual(sent.data.answers, { [city.id]: 'Johannesburg' });

  // Retiring a question stops it being asked; the answer stays with the application for staff.
  const retired = (await admin('PATCH', `/admin/v1/application/questions/${city.id}`, { active: false })).body;
  assert.equal(retired.custom.find((q: any) => q.id === city.id).active, false);
  assert.deepEqual((await visitor.getApplicationQuestions()).custom.map((q) => q.label), ['Anything else?']);
  const application = (await admin('GET', '/admin/v1/applications?status=submitted')).body.find((a: any) => a.data.fullName === 'Asked Applicant');
  assert.equal(application.data.answers[city.id], 'Johannesburg');
  // Restoring the standard wording, and the audit trail.
  assert.equal((await admin('DELETE', '/admin/v1/application/questions/builtin/phone')).body.builtin.find((q: any) => q.key === 'phone').label, 'Phone number');
  const log = (await server.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'application_question.%' ORDER BY occurred_at`)).map((r) => r.action);
  assert.deepEqual(log, ['application_question.reworded', 'application_question.reworded', 'application_question.created', 'application_question.created', 'application_question.retired', 'application_question.restored']);
  // Leave the form as it was for the other tests.
  for (const q of retired.custom) await admin('PATCH', `/admin/v1/application/questions/${q.id}`, { active: false });
  await admin('DELETE', '/admin/v1/application/questions/builtin/interests');
});
