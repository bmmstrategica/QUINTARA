/** Two-factor authentication for every account, and the request-level protections around sessions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentStep, fromBase32, totp } from '../src/two-factor.ts';
import { hashToken } from '../src/context.ts';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

/** A browser: keeps its cookies, sends JSON, and comes from the web app unless told otherwise. */
function browser(s: TestServer) {
  const jar = new Map<string, string>();
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await s.app.inject({ method: method as 'GET', url, headers: { origin: 'http://localhost:3000', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers }, payload: body as object | undefined });
    for (const c of response.cookies) c.value ? jar.set(c.name, c.value) : jar.delete(c.name);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, headers: response.headers, cookies: response.cookies };
  };
  return { call, jar };
}
const codeFor = (secret: string, offset = 0) => totp(fromBase32(secret), currentStep() + offset);

test('two-factor, required: every account sets up an authenticator, and nothing is reachable before the second step', async () => {
  const s = await startServer({ twoFactor: { policy: 'required', key: 'test-two-factor-key-of-at-least-32-chars' } });
  try {
    const b = browser(s);
    const first = await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.equal(first.status, 200);
    assert.equal(first.body.twoFactor, 'enrol');
    // Half signed in: nothing works but the second step.
    assert.equal((await b.call('GET', '/v1/session')).body, null);
    assert.equal((await b.call('GET', '/v1/me/profile')).status, 401);
    assert.equal((await b.call('GET', '/v1/me/bookings')).status, 401);
    assert.deepEqual((await b.call('GET', '/v1/auth/2fa')).body.state, 'enrol');
    const pendingToken = b.jar.get('q_session')!;

    const setup = await b.call('POST', '/v1/auth/2fa/setup', {});
    assert.equal(setup.status, 200);
    assert.ok(setup.body.qr.startsWith('data:image/png;base64,') && setup.body.otpauthUrl.startsWith('otpauth://totp/Quintara') && setup.body.secret.length >= 32);
    const secret = setup.body.secret.replace(/\s/g, '');
    assert.equal((await b.call('POST', '/v1/auth/2fa/confirm', { code: '000000' })).status, 422);
    const confirmed = await b.call('POST', '/v1/auth/2fa/confirm', { code: codeFor(secret) });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recoveryCodes.length, 10);
    assert.ok(confirmed.body.recoveryCodes.every((c: string) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
    assert.notEqual(b.jar.get('q_session'), pendingToken);                  // a fresh session replaces the half-finished one
    assert.equal((await b.call('GET', '/v1/session')).body.fullName, 'Thandi Mokoena');
    assert.equal((await b.call('GET', '/v1/auth/2fa')).body.state, 'on');
    const old = await s.app.inject({ method: 'GET', url: '/v1/session', headers: { cookie: `q_session=${pendingToken}` } });
    assert.equal(old.body, 'null');
    // The secret is never shown again, and it is stored encrypted.
    const stored = (await s.db.query<{ totp_secret_enc: string }>("SELECT totp_secret_enc FROM user_mfa m JOIN users u ON u.id = m.user_id WHERE u.email = 'thandi@example.com'"))[0]!;
    assert.ok(!stored.totp_secret_enc.includes(secret) && !JSON.stringify(await b.call('GET', '/v1/auth/2fa')).includes(secret));
    assert.equal((await b.call('POST', '/v1/auth/2fa/disable', { code: codeFor(secret, 1) })).status, 403);   // required: cannot be turned off
    assert.ok(s.email.sent.some((m) => m.to === 'thandi@example.com' && m.subject.includes('Two-factor authentication is on')));

    // A later sign-in asks for the code. A code already used is refused; a recovery code works once.
    await b.call('DELETE', '/v1/session');
    assert.equal((await b.call('POST', '/v1/session', { email: 'thandi@example.com' })).body.twoFactor, 'verify');
    assert.equal((await b.call('POST', '/v1/auth/2fa/setup', {})).status, 403);   // cannot replace the authenticator from a half sign-in
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: codeFor(secret) })).status, 422);   // replayed
    const recovery = confirmed.body.recoveryCodes[0];
    const viaRecovery = await b.call('POST', '/v1/auth/2fa/verify', { code: recovery.toUpperCase() });
    assert.equal(viaRecovery.status, 200);
    assert.equal(viaRecovery.body.session.fullName, 'Thandi Mokoena');
    assert.ok(s.email.sent.some((m) => m.subject.includes('A recovery code was used')));
    assert.equal((await b.call('GET', '/v1/auth/2fa')).body.recoveryCodesLeft, 9);
    await b.call('DELETE', '/v1/session');
    await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: recovery })).status, 422);   // used up

    // Five wrong codes end the sign-in.
    for (let i = 0; i < 3; i++) assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: '111111' })).status, 422);
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: '222222' })).status, 401);
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: codeFor(secret, 1) })).status, 409);   // that sign-in is over
    await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: codeFor(secret, 1) })).status, 200);

    // Moving to a new phone needs a code from the old one; the old one works until the new one is confirmed.
    assert.equal((await b.call('POST', '/v1/auth/2fa/setup', {})).status, 422);
    const moved = await b.call('POST', '/v1/auth/2fa/setup', { code: codeFor(secret, -1) });
    assert.equal(moved.status, 422);   // step -1 is older than the last one used
    const next = await b.call('POST', '/v1/auth/2fa/recovery-codes', { code: codeFor(secret, 1) });
    assert.equal(next.status, 422);    // step +1 was just used to sign in
  } finally { await s.close(); }
});

test('two-factor for staff: the admin console has its own short session, and staff can reset a member who lost their phone', async () => {
  const s = await startServer({ twoFactor: { policy: 'required', key: 'test-two-factor-key-of-at-least-32-chars' }, webOrigins: ['http://localhost:3000', 'http://localhost:3001'] });
  try {
    const a = browser(s);
    const signIn = await a.call('POST', '/admin/v1/session', { email: 'admin@example.com' }, { origin: 'http://localhost:3001' });
    assert.deepEqual([signIn.status, signIn.body.twoFactor], [200, 'enrol']);
    const cookie = signIn.cookies.find((c) => c.name === 'q_staff')!;
    assert.deepEqual([cookie.path, cookie.sameSite, cookie.httpOnly, cookie.maxAge], ['/admin', 'Strict', true, 12 * 3600]);
    assert.equal((await a.call('GET', '/admin/v1/members')).status, 401);
    const setup = await a.call('POST', '/admin/v1/auth/2fa/setup', {});
    const secret = setup.body.secret.replace(/\s/g, '');
    assert.equal((await a.call('POST', '/admin/v1/auth/2fa/confirm', { code: codeFor(secret) })).status, 200);
    assert.equal((await a.call('GET', '/admin/v1/members')).status, 200);
    // A staff session is no app session, and an app session carries no staff powers.
    assert.equal((await s.app.inject({ method: 'GET', url: '/v1/session', headers: { cookie: `q_session=${a.jar.get('q_staff')}` } })).body, 'null');

    // A member enrols, then loses their phone and their recovery codes.
    const m = browser(s);
    await m.call('POST', '/v1/session', { email: 'daniel@example.com' });
    const ms = (await m.call('POST', '/v1/auth/2fa/setup', {})).body.secret.replace(/\s/g, '');
    await m.call('POST', '/v1/auth/2fa/confirm', { code: codeFor(ms) });
    assert.ok((await m.call('GET', '/v1/session')).body);
    const daniel = (await s.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'daniel@example.com'"))[0]!.id;
    assert.equal((await a.call('POST', `/admin/v1/users/${daniel}/two-factor/reset`, {})).status, 422);   // say how they were identified
    assert.equal((await a.call('POST', `/admin/v1/users/${daniel}/two-factor/reset`, { reason: 'Called from his registered number; video call to confirm.' })).status, 204);
    assert.equal((await m.call('GET', '/v1/session')).body, null);                                       // signed out everywhere
    assert.equal((await m.call('POST', '/v1/session', { email: 'daniel@example.com' })).body.twoFactor, 'enrol');
    assert.ok((await s.db.query("SELECT 1 FROM audit_logs WHERE action = 'mfa.reset_by_staff' AND entity_id = $1", [daniel])).length === 1);
    const adminId = (await s.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@example.com'"))[0]!.id;
    assert.equal((await a.call('POST', `/admin/v1/users/${adminId}/two-factor/reset`, { reason: 'Resetting my own, for a test.' })).status, 403);
    // A concierge cannot reset anyone.
    const d = browser(s);
    await d.call('POST', '/admin/v1/session', { email: 'desk@example.com' }, { origin: 'http://localhost:3001' });
    const ds = (await d.call('POST', '/admin/v1/auth/2fa/setup', {})).body.secret.replace(/\s/g, '');
    await d.call('POST', '/admin/v1/auth/2fa/confirm', { code: codeFor(ds) });
    assert.equal((await d.call('POST', `/admin/v1/users/${daniel}/two-factor/reset`, { reason: 'Not allowed for the desk.' })).status, 403);

    // An idle staff session ends after two hours.
    await s.db.query(`UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE token_hash = $1`, [hashToken(a.jar.get('q_staff')!)]);
    assert.equal((await a.call('GET', '/admin/v1/members')).status, 401);
  } finally { await s.close(); }
});

test('two-factor: ten wrong codes lock the second step; the review account has a fixed second code; a guest order on a device needs none', async () => {
  const s = await startServer({ twoFactor: { policy: 'required', key: 'test-two-factor-key-of-at-least-32-chars', review: { email: 'review@quintara.test', code: '424242' } } });
  try {
    const b = browser(s);
    await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    const secret = (await b.call('POST', '/v1/auth/2fa/setup', {})).body.secret.replace(/\s/g, '');
    await b.call('POST', '/v1/auth/2fa/confirm', { code: codeFor(secret) });
    for (let round = 0; round < 2; round++) {
      await b.call('DELETE', '/v1/session');
      await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
      for (let i = 0; i < 5; i++) await b.call('POST', '/v1/auth/2fa/verify', { code: '123123' });
    }
    await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.equal((await b.call('POST', '/v1/auth/2fa/verify', { code: codeFor(secret, 1) })).status, 429);   // locked, even with the right code

    // Review account (a member made for app store review): its second step takes the fixed code, and only that.
    await s.db.query("UPDATE users SET email = 'review@quintara.test' WHERE email = 'aisha@example.com'");
    const r = browser(s);
    assert.equal((await r.call('POST', '/v1/session', { email: 'review@quintara.test' })).body.twoFactor, 'verify');
    assert.equal((await r.call('POST', '/v1/auth/2fa/verify', { code: '000000' })).status, 422);
    assert.equal((await r.call('POST', '/v1/auth/2fa/verify', { code: '424242' })).status, 200);
    assert.ok((await r.call('GET', '/v1/session')).body);

    // A guest who orders on the shop has no email account: the device is all there is, and nothing more is asked.
    const g = browser(s);
    const products = (await g.call('GET', '/v1/boutique/products')).body, delivery = (await g.call('GET', '/v1/boutique/delivery-options')).body;
    const candle = products.find((p: { stock: number | null }) => p.stock === null) ?? products[0];
    const order = await g.call('POST', '/v1/boutique/orders', { items: [{ productId: candle.id, option: candle.options[0], quantity: 1 }], deliveryOptionId: delivery[0].id, deliveryAddress: '12 Kloof Street, Gardens, Cape Town', guest: { fullName: 'Lerato Dube', email: 'lerato@example.org' } });
    assert.equal(order.status, 200);
    assert.equal((await g.call('POST', `/v1/boutique/orders/${order.body.id}/pay`, {})).status, 200);
  } finally { await s.close(); }
});

test('request protections: other sites cannot act with a session, only JSON is read, headers forbid framing and caching, sign out everywhere', async () => {
  const s = await startServer({ secureCookies: true });
  try {
    const b = browser(s);
    await b.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.ok((await b.call('GET', '/v1/session')).body);
    // Another site's page: refused, with or without the session.
    assert.equal((await b.call('POST', '/v1/concierge/requests', { category: 'dining', title: 'x', details: 'y' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await b.call('DELETE', '/v1/session', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await b.call('POST', '/v1/qera/messages', { text: 'hello' }, { origin: 'null' })).status, 403);
    assert.equal((await b.call('POST', '/v1/qera/messages', { text: 'hello' }, { origin: '', 'sec-fetch-site': 'cross-site' })).status, 403);
    // A form or beacon from anywhere can send text/plain without asking first: it is not read at all.
    const plain = await s.app.inject({ method: 'POST', url: '/v1/auth/code', headers: { 'content-type': 'text/plain' }, payload: '{"email":"x@example.com"}' });
    assert.equal(plain.statusCode, 415);
    // Headers on every answer.
    const answer = await b.call('GET', '/v1/session');
    assert.equal(answer.headers['x-content-type-options'], 'nosniff');
    assert.equal(answer.headers['x-frame-options'], 'DENY');
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.match(String(answer.headers['strict-transport-security']), /max-age=63072000/);
    assert.match(String(answer.headers['content-security-policy']), /frame-ancestors 'none'/);
    // Sign out everywhere: a second device loses its session too.
    const other = browser(s);
    await other.call('POST', '/v1/session', { email: 'thandi@example.com' });
    assert.ok((await other.call('GET', '/v1/session')).body);
    assert.equal((await b.call('DELETE', '/v1/sessions')).status, 204);
    assert.equal((await other.call('GET', '/v1/session')).body, null);
    assert.equal((await b.call('GET', '/v1/session')).body, null);
    // A session begun before two-factor was required must set it up before doing anything else.
    const legacy = browser(s);
    await legacy.call('POST', '/v1/session', { email: 'daniel@example.com' });
    const strict = await startServer({ twoFactor: { policy: 'required', key: 'test-two-factor-key-of-at-least-32-chars' } });
    try {
      const token = legacy.jar.get('q_session')!;
      // The same token in a database that now requires two-factor: copy the session across.
      const user = (await strict.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'daniel@example.com'"))[0]!.id;
      await strict.db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user, hashToken(token)]);
      const asked = await strict.app.inject({ method: 'GET', url: '/v1/auth/2fa', headers: { cookie: `q_session=${token}` } });
      assert.equal(JSON.parse(asked.body).state, 'enrol');
      assert.equal((await strict.app.inject({ method: 'GET', url: '/v1/me/profile', headers: { cookie: `q_session=${token}` } })).statusCode, 401);
    } finally { await strict.close(); }
  } finally { await s.close(); }
});
