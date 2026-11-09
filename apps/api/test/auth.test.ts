/** Production sign-in: one-time codes sent by email, for members, guests, applicants and staff. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

let s: TestServer;
before(async () => { s = await startServer({ authMode: 'code', reviewAccount: { email: 'review@quintara.example', code: '246810' } }); });
after(async () => { await s.close(); });

const codeFor = (email: string) => {
  const mail = [...s.email.sent].reverse().find((m) => m.to === email);
  return mail ? /\b(\d{6})\b/.exec(mail.subject)![1]! : null;
};

test('the apps learn that codes are used, and the address alone no longer signs in', async () => {
  const api = s.client();
  assert.deepEqual(await api.getAuthConfig(), { method: 'code' });
  await assert.rejects(api.signIn({ email: 'thandi@example.com' }), (e: unknown) => e instanceof ApiError && /code sent to your email/.test(e.message));
  await assert.rejects(api.signInGuest({ email: 'thandi@example.com' }), (e: unknown) => e instanceof ApiError && /code sent to your email/.test(e.message));
});

test('a member signs in with the code sent to their address; it works once', async () => {
  const api = s.client();
  await api.requestSignInCode({ email: 'thandi@example.com' });
  const code = codeFor('thandi@example.com')!;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  await assert.rejects(api.verifySignInCode({ email: 'thandi@example.com', code: wrong }), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
  const signed = await api.verifySignInCode({ email: 'Thandi@Example.com', code });
  assert.equal(signed.session?.fullName, 'Thandi Mokoena');
  assert.equal((await api.getSession())?.memberNumber, 'Q-1001');
  const again = s.client();
  await assert.rejects(again.verifySignInCode({ email: 'thandi@example.com', code }), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
  // Only hashes are stored.
  const rows = await s.db.query('SELECT * FROM sign_in_codes');
  assert.ok(!JSON.stringify(rows).includes(code) && !JSON.stringify(rows).includes('thandi'));
});

test('the answer is the same for an unknown address, and nothing is sent to it', async () => {
  const api = s.client();
  const before = s.email.sent.length;
  await api.requestSignInCode({ email: 'nobody@example.com' });
  assert.equal(s.email.sent.length, before);
  await assert.rejects(api.verifySignInCode({ email: 'nobody@example.com', code: '123456' }), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
});

test('five wrong tries end a code', async () => {
  const api = s.client();
  await api.requestSignInCode({ email: 'daniel@example.com' });
  const code = codeFor('daniel@example.com')!;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await assert.rejects(api.verifySignInCode({ email: 'daniel@example.com', code: wrong }));
  await assert.rejects(api.verifySignInCode({ email: 'daniel@example.com', code }), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
});

test('a guest account is created with a code that proves the address, then signs in like a member', async () => {
  const api = s.client();
  await assert.rejects(api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.code@example.org' }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  await api.requestSignInCode({ email: 'lerato.code@example.org', purpose: 'join' });
  const code = codeFor('lerato.code@example.org')!;
  const guest = await api.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.code@example.org', code });
  assert.equal(guest.fullName, 'Lerato Guest');
  // No join code for an address that already has an account.
  const before = s.email.sent.length;
  await api.requestSignInCode({ email: 'thandi@example.com', purpose: 'join' });
  assert.equal(s.email.sent.length, before);
  const later = s.client();
  await later.requestSignInCode({ email: 'lerato.code@example.org' });
  const signed = await later.verifySignInCode({ email: 'lerato.code@example.org', code: codeFor('lerato.code@example.org')! });
  assert.equal(signed.session, null);
  assert.equal(signed.guest?.fullName, 'Lerato Guest');
});

test('staff sign in to the admin console with a staff code; members get none', async () => {
  const send = (body: unknown) => s.app.inject({ method: 'POST', url: '/v1/auth/code', payload: body as object });
  assert.equal((await send({ email: 'admin@example.com', purpose: 'staff' })).statusCode, 202);
  const code = codeFor('admin@example.com')!;
  assert.equal((await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'admin@example.com' } })).statusCode, 422);
  const ok = await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'admin@example.com', code } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body).roles, ['admin']);
  const before = s.email.sent.length;
  await send({ email: 'thandi@example.com', purpose: 'staff' });
  assert.equal(s.email.sent.length, before);
});

test('the app store review account signs in with its fixed code, without email', async () => {
  // The review account is an ordinary member created by staff; here, a guest account stands in.
  await s.db.query(`INSERT INTO users (email, status) VALUES ('review@quintara.example', 'active')`);
  const id = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'review@quintara.example'`))[0]!.id;
  const market = (await s.db.query<{ id: string }>(`SELECT id FROM markets LIMIT 1`))[0]!.id;
  await s.db.query(`INSERT INTO guest_accounts (user_id, market_id, full_name) VALUES ($1, $2, 'App Review')`, [id, market]);
  const api = s.client();
  const before = s.email.sent.length;
  await api.requestSignInCode({ email: 'review@quintara.example' });
  assert.equal(s.email.sent.length, before);
  await assert.rejects(api.verifySignInCode({ email: 'review@quintara.example', code: '135791' }));
  assert.equal((await api.verifySignInCode({ email: 'review@quintara.example', code: '246810' })).guest?.fullName, 'App Review');
});
