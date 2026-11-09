/** Booking rules that depend on time: an experience that has begun cannot be booked. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDate } from '@quintara/domain';
import { startServer } from './harness.ts';

test('an experience that has already started cannot be booked, and no seats are taken', async () => {
  const s = await startServer();
  try {
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const yacht = (await api.listExperiences()).find((e) => e.title === 'The Executive Yacht Club')!;
    await s.db.query(`UPDATE experiences SET starts_at = now() - interval '1 hour' WHERE id = $1`, [yacht.id]);
    await assert.rejects(api.bookExperience(yacht.id, 1), (e: { code?: string; message?: string }) => e.code === 'conflict' && /already taken place/.test(e.message ?? ''));
    const live = await s.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM experience_bookings b JOIN members m ON m.id = b.member_id JOIN users u ON u.id = m.user_id WHERE b.experience_id = $1 AND u.email = 'thandi@example.com'`, [yacht.id]);
    assert.equal(live[0]!.n, 0);
  } finally { await s.close(); }
});

test('sample dates move forward by whole weeks, keeping the weekday and time, and never move before October 2026', () => {
  const iso = '2026-10-17T17:00:00Z';
  assert.equal(sampleDate(iso, Date.parse('2026-09-01T00:00:00Z')), iso);
  const now = Date.parse('2026-11-09T10:00:00Z');
  const moved = sampleDate(iso, now);
  assert.ok(Date.parse(moved) > now);
  assert.equal(new Date(moved).getUTCDay(), new Date(iso).getUTCDay());
  assert.equal(moved.slice(11), iso.slice(11));
  // The earliest sample (11 October) lands at least a week ahead.
  assert.ok(Date.parse(sampleDate('2026-10-11T08:00:00Z', now)) >= now + 6 * 86_400_000);
});

test('readiness checks the database; liveness does not', async () => {
  const s = await startServer();
  try {
    assert.deepEqual(JSON.parse((await s.app.inject({ method: 'GET', url: '/ready' })).body), { ok: true, database: 'ok' });
    await s.db.close();
    const down = await s.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(down.statusCode, 503);
    assert.equal((await s.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  } finally { await s.app.close(); }
});
