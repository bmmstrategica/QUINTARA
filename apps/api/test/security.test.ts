/** Behaviour that only the real API has: sessions, isolation between members, concurrency and the audit trail. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { hashToken } from '../src/context.ts';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

let server: TestServer;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });
const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test('the session cookie is HttpOnly and only a hash of the token is stored', async () => {
  const response = await server.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'daniel@example.com' } });
  const cookie = response.cookies.find((c) => c.name === 'q_session')!;
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  const stored = await server.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
  assert.ok(stored.some((row) => row.token_hash === hashToken(cookie.value)));
  assert.ok(!stored.some((row) => row.token_hash === cookie.value));
});

test('an unknown email and a non-member get the same refusal', async () => {
  const a = await server.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'nobody@example.com' } });
  await server.db.query(`INSERT INTO users (email, status) VALUES ('pending@example.com', 'active')`);
  const b = await server.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'pending@example.com' } });
  assert.equal(a.statusCode, 401);
  assert.equal(b.statusCode, 401);
  assert.equal(a.body, b.body);
});

test('a revoked or invented token is treated as a visitor', async () => {
  const api = server.client();
  await api.signIn({ email: 'daniel@example.com' });
  await api.signOut();
  await assert.rejects(api.listBookings(), fails('unauthenticated'));
  const forged = await server.app.inject({ method: 'GET', url: '/v1/me/bookings', headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(forged.statusCode, 401);
});

test('one member cannot cancel or read another member\u2019s booking or notifications', async () => {
  const thandi = server.client(), daniel = server.client();
  await thandi.signIn({ email: 'thandi@example.com' });
  await daniel.signIn({ email: 'daniel@example.com' });
  const booking = (await thandi.listBookings())[0]!;
  await assert.rejects(daniel.cancelBooking(booking.id), fails('not_found'));
  assert.equal((await daniel.listBookings()).length, 0);
  const note = (await thandi.listNotifications()).find((n) => !n.readAt)!;
  await daniel.markNotificationRead(note.id);
  assert.equal((await thandi.listNotifications()).find((n) => n.id === note.id)?.readAt, null);
});

test('a hidden experience is not found for members who are not invited', async () => {
  const thandi = server.client(), daniel = server.client();
  await thandi.signIn({ email: 'thandi@example.com' });
  await daniel.signIn({ email: 'daniel@example.com' });
  const hidden = (await thandi.listExperiences()).find((e) => e.title === 'Quintara Golf Invitational')!;
  await assert.rejects(daniel.getExperience(hidden.id), fails('not_found'));
  await assert.rejects(daniel.bookExperience(hidden.id, 1), fails('not_found'));
});

test('the last seats cannot be sold twice when members book at the same moment', async () => {
  const clients = await Promise.all(['daniel', 'aisha', 'sipho', 'chloe'].map(async (name) => { const c = server.client(); await c.signIn({ email: `${name}@example.com` }); return c; }));
  const aura = (await clients[0]!.listExperiences()).find((e) => e.title === 'The Aura Enclave')!;   // 5 seats left, 2 per booking
  const results = await Promise.all(clients.map((c) => c.bookExperience(aura.id, 2)));
  assert.deepEqual(results.map((b) => b.status).sort(), ['awaiting_payment', 'awaiting_payment', 'waitlisted', 'waitlisted']);
  const after = await clients[0]!.getExperience(aura.id);
  assert.ok(after.seatsTaken! <= after.capacity!);
});

test('a suspended member loses access at once', async () => {
  const api = server.client();
  await api.signIn({ email: 'chloe@example.com' });
  await server.db.query(`UPDATE members SET status = 'suspended' WHERE user_id = (SELECT id FROM users WHERE email = 'chloe@example.com')`);
  assert.equal(await api.getSession(), null);
  await assert.rejects(api.listMembers(), fails('unauthenticated'));
});

test('bookings are written to the audit log, which cannot be edited', async () => {
  const rows = await server.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'booking.created'`);
  assert.ok(rows.length >= 4);
  // Refused by the append-only trigger, and (as the restricted production role) by permission before it.
  await assert.rejects(server.db.query(`UPDATE audit_logs SET action = 'tampered'`), /append-only|permission denied/);
  await assert.rejects(server.db.query('DELETE FROM audit_logs'), /append-only|permission denied/);
});

test('malformed input is refused without a server error', async () => {
  const api = server.client();
  await api.signIn({ email: 'aisha@example.com' });
  await assert.rejects(api.getExperience("x' OR '1'='1"), fails('not_found'));
  await assert.rejects(api.getMember('not-a-uuid'), fails('not_found'));
  const bad = await server.app.inject({ method: 'POST', url: '/v1/session', payload: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.statusCode, 400);
  const huge = await server.app.inject({ method: 'PUT', url: '/v1/me/application', payload: { motivation: 'x'.repeat(200000) } });
  assert.equal(huge.statusCode, 413);
});
