/** The admin console's Overview: counted from the database, and each section only for the roles that may see it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './harness.ts';

test('the overview is counted from the database and moves when members act', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com');
    const first = await admin('GET', '/admin/v1/dashboard');
    assert.equal(first.status, 200);
    const d = first.body;
    // An administrator sees every section.
    for (const key of ['business', 'membership', 'experiences', 'concierge', 'maison']) assert.ok(d[key], key);
    // The figures are what the database holds.
    const market = (await s.db.query<{ id: string }>(`SELECT id FROM markets WHERE slug = 'cape-town'`))[0]!.id;
    const count = async (sql: string) => Number((await s.db.query<{ n: string }>(sql, [market]))[0]!.n);
    assert.equal(d.membership.activeMembers, await count(`SELECT count(*) AS n FROM members WHERE home_market_id = $1 AND status = 'active'`));
    assert.equal(d.membership.applicationsToReview, await count(`SELECT count(*) AS n FROM membership_applications WHERE market_id = $1 AND status IN ('submitted', 'under_review', 'interview')`));
    assert.equal(d.experiences.upcoming, await count(`SELECT count(*) AS n FROM experiences WHERE market_id = $1 AND status = 'published' AND starts_at > now()`));
    assert.ok(d.experiences.next.length <= 5 && d.experiences.seatsBooked <= d.experiences.seatsTotal);
    // It agrees with Insights for the same 30 days.
    const insights = (await admin('GET', '/admin/v1/insights?period=30d')).body;
    assert.equal(d.business.revenueMinor, insights.headline.revenueMinor);
    assert.equal(d.business.bookings, insights.headline.bookings);

    // A member asks the concierge for something and books a seat: the overview shows both at once.
    const member = s.client();
    await member.signIn({ email: 'thandi@example.com' });
    await member.createConciergeRequest({ category: 'travel', subject: 'Airport transfer', details: 'Two passengers arriving on Friday at 14:20.', neededBy: '2026-12-09' });
    const yacht = (await member.listExperiences()).find((e) => e.title === 'The Executive Yacht Club')!;
    await member.bookExperience(yacht.id, 2);
    const after = (await admin('GET', '/admin/v1/dashboard')).body;
    assert.equal(after.concierge.openRequests, d.concierge.openRequests + 1);
    assert.equal(after.concierge.newRequests, d.concierge.newRequests + 1);
    assert.equal(after.experiences.seatsBooked, d.experiences.seatsBooked + 2);
    // Never a name or an email anywhere in it.
    assert.ok(!/thandi|@example\.com/i.test(JSON.stringify(after)));
  } finally { await s.close(); }
});

test('each role sees only its sections; members and visitors are refused', async () => {
  const s = await startServer();
  try {
    const content = (await (await s.staff('content@example.com'))('GET', '/admin/v1/dashboard')).body;
    assert.deepEqual(['business', 'membership', 'experiences', 'concierge'].map((k) => content[k]), [null, null, null, null]);
    assert.ok(content.maison);
    const desk = (await (await s.staff('desk@example.com'))('GET', '/admin/v1/dashboard')).body;
    assert.equal(desk.business, null);
    assert.equal(desk.membership, null);
    assert.ok(desk.concierge && desk.experiences);

    assert.equal((await s.app.inject({ method: 'GET', url: '/admin/v1/dashboard' })).statusCode, 401);
    // A member's app session carries no staff powers.
    const signIn = await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } });
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.ok([401, 403].includes((await s.app.inject({ method: 'GET', url: '/admin/v1/dashboard', headers: { cookie } })).statusCode));
  } finally { await s.close(); }
});
