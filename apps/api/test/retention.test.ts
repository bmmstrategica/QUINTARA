/** Data retention: working records go once their period has passed; anything still in use, or kept by law, stays. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RETENTION, purgeExpiredData, retentionFromEnv } from '../src/retention.ts';
import { startServer } from './harness.ts';

test('expired working records are deleted; live ones, members and the audit log are kept', async () => {
  const s = await startServer();
  try {
    const api = s.client();
    await api.signIn({ email: 'thandi@example.com' });
    const user = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    const q = (sql: string, params: unknown[] = []) => s.db.query(sql, params);
    const count = async (sql: string) => Number((await s.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`))[0]!.n);

    // Old: a session signed out 40 days ago (with its push device), a used code, an abandoned 2FA set-up, an email sent
    // 100 days ago, a cancelled proposal, an old WhatsApp id, an old guest counter, a push device switched off long ago.
    const old = (await q(`INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at, created_at) VALUES ($1, 'retention-old', now() + interval '1 day', now() - interval '40 days', now() - interval '60 days') RETURNING id`, [user]))[0] as { id: string };
    await q(`INSERT INTO push_devices (user_id, session_id, token, platform) VALUES ($1, $2, 'ExponentPushToken[retention-old]', 'ios')`, [user, old.id]);
    const live = (await q(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'retention-live', now() + interval '30 days') RETURNING id`, [user]))[0] as { id: string };
    await q(`INSERT INTO push_devices (user_id, session_id, token, platform, disabled_at, last_seen_at) VALUES ($1, $2, 'ExponentPushToken[retention-off]', 'android', now() - interval '100 days', now() - interval '100 days')`, [user, live.id]);
    await q(`INSERT INTO sign_in_codes (email_hash, purpose, code_hash, expires_at, used_at) VALUES ('h', 'sign_in', 'c', now() - interval '2 days', now() - interval '2 days'), ('h', 'sign_in', 'c2', now() + interval '10 minutes', NULL)`);
    await q(`INSERT INTO user_mfa_pending (user_id, totp_secret_enc, created_at) VALUES ($1, 'x', now() - interval '3 days')`, [user]);
    await q(`INSERT INTO email_outbox (user_id, category, subject, status, created_at, sent_at) VALUES ($1, 'test', 'old', 'sent', now() - interval '100 days', now() - interval '100 days'), ($1, 'test', 'stuck', 'pending', now() - interval '100 days', NULL), ($1, 'test', 'recent', 'sent', now(), now())`, [user]);
    await q(`INSERT INTO qera_proposals (user_id, tool, args, summary, status, expires_at, decided_at) VALUES ($1, 't', '{}', 'old', 'cancelled', now() - interval '100 days', now() - interval '100 days'), ($1, 't', '{}', 'kept', 'confirmed', now() - interval '100 days', now() - interval '100 days')`, [user]);
    await q(`INSERT INTO whatsapp_events (wamid, direction, kind, created_at) VALUES ('wamid.old', 'in', 'text', now() - interval '40 days'), ('wamid.new', 'in', 'text', now())`);
    await q(`INSERT INTO qera_guest_usage (user_id, usage_day) VALUES ($1, (now() - interval '40 days')::date), ($1, now()::date)`, [user]);
    const audits = await count('audit_logs');

    const r = await purgeExpiredData(s.db, DEFAULT_RETENTION);
    assert.ok(r.sessionDays >= 1 && r.signInCodeDays >= 1 && r.mfaPendingDays === 1 && r.emailDays === 1 && r.proposalDays === 1 && r.whatsappDays === 1 && r.guestUsageDays === 1 && r.pushDeviceDays === 1, JSON.stringify(r));

    assert.equal(await count(`sessions WHERE id = '${old.id}'`), 0);
    assert.equal(await count(`sessions WHERE id = '${live.id}'`), 1);
    assert.equal(await count(`push_devices WHERE token LIKE '%retention%'`), 0);       // one with its session, one switched off
    assert.equal(await count(`sign_in_codes WHERE code_hash = 'c2'`), 1);               // still usable
    assert.deepEqual((await s.db.query<{ subject: string }>(`SELECT subject FROM email_outbox WHERE category = 'test' ORDER BY subject`)).map((e) => e.subject), ['recent', 'stuck']);
    assert.deepEqual((await s.db.query<{ summary: string }>(`SELECT summary FROM qera_proposals WHERE user_id = $1`, [user])).map((p) => p.summary), ['kept']);
    assert.equal(await count(`whatsapp_events WHERE wamid = 'wamid.new'`), 1);
    assert.equal(await count(`qera_guest_usage`), 1);
    assert.equal(await count('audit_logs'), audits);
    assert.ok((await api.listExperiences()).length > 0, 'the signed-in member is still signed in');

    // Run again: nothing left to do.
    assert.ok(Object.values(await purgeExpiredData(s.db)).every((n) => n === 0));
  } finally { await s.close(); }
});

test('retention periods come from the environment, and nonsense is refused at start', () => {
  assert.deepEqual(retentionFromEnv({}), DEFAULT_RETENTION);
  assert.equal(retentionFromEnv({ RETENTION_EMAIL_DAYS: '365' }).emailDays, 365);
  for (const bad of ['0', '-3', '1.5', 'forever', '99999']) assert.throws(() => retentionFromEnv({ RETENTION_SESSION_DAYS: bad }), /RETENTION_SESSION_DAYS/);
});
