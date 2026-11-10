/** The payments ledger a page at a time, with totals over everything, and the CSV exports of payments and members. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './harness.ts';

test('the ledger pages through every payment once, and its total covers all of them, not just the page', async () => {
  const s = await startServer();
  try {
    const thandi = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    const market = (await s.db.query<{ id: string }>(`SELECT id FROM markets WHERE slug = 'cape-town'`))[0]!.id;
    await s.db.query(`INSERT INTO payments (user_id, market_id, purpose, amount_minor, refunded_minor, currency_code, status, provider, idempotency_key, paid_at, created_at)
      SELECT $1, $2, 'experience', 1000 + n, CASE WHEN n % 10 = 0 THEN 500 ELSE 0 END, 'ZAR', 'paid', 'mock', 'ledger-test-' || n, now(), now() - make_interval(mins => n)
        FROM generate_series(1, 250) n`, [thandi, market]);
    const admin = await s.staff('admin@example.com');
    const first = (await admin('GET', '/admin/v1/payments?limit=100')).body;
    const expected = Number((await s.db.query<{ n: string }>(`SELECT sum(amount_minor - refunded_minor) AS n FROM payments WHERE status IN ('paid', 'refunded') AND currency_code = 'ZAR'`))[0]!.n);
    assert.equal(first.payments.length, 100);
    assert.ok(first.count >= 250);
    assert.equal(first.nextOffset, 100);
    assert.equal(first.totals.find((t: any) => t.currency === 'ZAR').receivedMinor, expected);

    const ids = new Set<string>(first.payments.map((p: any) => p.id));
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = (await admin('GET', `/admin/v1/payments?limit=100&offset=${offset}`)).body;
      for (const p of page.payments) { assert.ok(!ids.has(p.id), 'no payment twice'); ids.add(p.id); }
      offset = page.nextOffset;
    }
    assert.equal(ids.size, first.count);
    const refunded = (await admin('GET', '/admin/v1/payments?status=refunded')).body;
    assert.ok(refunded.payments.every((p: any) => p.status === 'refunded'));
    assert.equal((await admin('GET', '/admin/v1/payments?limit=1000')).status, 422);
  } finally { await s.close(); }
});

test('payments and members export as CSV for the roles allowed, every export audited, spreadsheet formulas neutralised', async () => {
  const s = await startServer();
  try {
    // A name that a spreadsheet would run as a formula.
    await s.db.query(`UPDATE profiles SET full_name = '=HYPERLINK("http://evil.example")' WHERE user_id = (SELECT id FROM users WHERE email = 'thandi@example.com')`);
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const aura = (await api.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;
    await api.payBooking((await api.bookExperience(aura.id, 1)).id);

    const cookie = async (email: string) => (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const admin = await cookie('admin@example.com');
    const ledger = await s.app.inject({ method: 'GET', url: '/admin/v1/payments/export', headers: { cookie: admin } });
    assert.equal(ledger.statusCode, 200);
    assert.match(String(ledger.headers['content-type']), /text\/csv/);
    const lines = ledger.body.trim().split('\r\n');
    assert.match(lines[0]!, /^"Time \(UTC\)","Payer","For"/);
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil.example"")"`)), 'the formula is neutralised with an apostrophe');
    assert.ok(lines.some((l) => l.includes('"The Aura Enclave, 1 seat"')), 'what was paid for, as a person would say it');

    const members = await s.app.inject({ method: 'GET', url: '/admin/v1/members/export', headers: { cookie: admin } });
    assert.equal(members.statusCode, 200);
    assert.match(members.body, /"Member number","Name","Email"/);
    assert.match(members.body, /"Q-\d+"/);
    const audited = await s.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action IN ('payments.exported', 'members.exported')`);
    assert.deepEqual(audited.map((a) => a.action).sort(), ['members.exported', 'payments.exported']);

    const desk = await cookie('desk@example.com');
    for (const url of ['/admin/v1/payments/export', '/admin/v1/members/export']) assert.equal((await s.app.inject({ method: 'GET', url, headers: { cookie: desk } })).statusCode, 403, url);
    assert.equal((await s.app.inject({ method: 'GET', url: '/admin/v1/members/export' })).statusCode, 401);
  } finally { await s.close(); }
});
