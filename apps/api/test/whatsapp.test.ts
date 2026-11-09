/** QÉRA on WhatsApp: linking a number, the signed webhook, conversations, and confirmation from the linked number only. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ApiError } from '@quintara/api-client';
import { WHATSAPP_TEXT } from '@quintara/domain';
import { startServer } from './harness.ts';
import type { TestServer } from './harness.ts';

let s: TestServer;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const THANDI = '27821234567', STRANGER = '447700900123', DANIEL = '27825550199';
const texts = (number: string) => s.whatsapp.to(number).map((m) => m.text);
const last = (number: string) => s.whatsapp.to(number).at(-1)!;

test('the webhook is confirmed only with the verify token, and only signed deliveries are read', async () => {
  const ok = await s.app.inject({ method: 'GET', url: '/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '12345');
  assert.equal((await s.app.inject({ method: 'GET', url: '/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' })).statusCode, 403);
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: STRANGER, id: 'wamid.forged', type: 'text', text: { body: 'hello' } }] } }] }] });
  assert.equal((await s.app.inject({ method: 'POST', url: '/v1/whatsapp/webhook', headers: { 'content-type': 'application/json' }, payload: raw })).statusCode, 401);
  assert.equal((await s.app.inject({ method: 'POST', url: '/v1/whatsapp/webhook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, payload: raw })).statusCode, 401);
  await s.app.flushWhatsApp();
  assert.equal(texts(STRANGER).length, 0);
});

test('an unknown number learns nothing about any account', async () => {
  assert.equal(await s.whatsappIn(STRANGER, { text: 'What bookings does Thandi have?' }), 200);
  assert.deepEqual(texts(STRANGER), [WHATSAPP_TEXT.notLinked]);
});

test('linking: a one-time code sent from the number, with consent; staff and visitors cannot link', async () => {
  const visitor = s.client();
  await assert.rejects(visitor.getWhatsApp(), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
  const admin = await s.staff('admin@example.com');
  assert.equal((await admin('GET', '/v1/me/whatsapp')).status, 401);

  const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
  const before = await thandi.getWhatsApp();
  assert.equal(before.status, 'none');
  assert.equal(before.available, true);
  await assert.rejects(thandi.linkWhatsApp({ consent: false as never }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  const started = await thandi.linkWhatsApp({ consent: true });
  assert.equal(started.status, 'pending');
  assert.match(started.code!, /^\d{6}$/);
  assert.equal(started.openUrl, `https://wa.me/27210000000?text=${encodeURIComponent(`LINK ${started.code}`)}`);
  // The code is shown once; afterwards the link is only pending.
  assert.equal((await thandi.getWhatsApp()).code, null);

  await s.whatsappIn(THANDI, { text: 'LINK 000000' });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.badCode);
  await s.whatsappIn(THANDI, { text: `link ${started.code}` });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.welcome);
  const linked = await thandi.getWhatsApp();
  assert.equal(linked.status, 'linked');
  assert.equal(linked.numberMasked, '•••• 4567');
  // A used code does not work twice.
  await s.whatsappIn(STRANGER, { text: `LINK ${started.code}` });
  assert.equal(last(STRANGER).text, WHATSAPP_TEXT.badCode);
  // The number is kept as a hash and encrypted, never as written.
  const row = (await s.db.query('SELECT * FROM whatsapp_links WHERE number_last4 = $1', ['4567']))[0]!;
  assert.ok(!JSON.stringify(row).includes(THANDI));
  // Another account cannot take a number that is linked.
  const daniel = s.client(); await daniel.signIn({ email: 'daniel@example.com' });
  const other = await daniel.linkWhatsApp({ consent: true });
  await s.whatsappIn(THANDI, { text: `LINK ${other.code}` });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.numberTaken);
  assert.equal((await daniel.getWhatsApp()).status, 'pending');
});

test('a linked number talks to QÉRA as the member, in the same conversation as the app', async () => {
  const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
  const count = s.whatsapp.to(THANDI).length;
  await s.whatsappIn(THANDI, { text: 'What experiences are on?' });
  const reply = s.whatsapp.to(THANDI).slice(count);
  assert.equal(reply.length, 1);
  assert.equal(reply[0]!.type, 'text');
  const thread = await thandi.getQeraThread();
  const asked = thread.messages.find((m) => m.text === 'What experiences are on?')!;
  assert.equal(asked.via, 'whatsapp');
  assert.equal(thread.messages.at(-1)!.text, reply[0]!.text);
  // A delivery WhatsApp repeats is answered once.
  const before = s.whatsapp.to(THANDI).length;
  await s.whatsappIn(THANDI, { text: 'Hello', id: 'wamid.same' });
  await s.whatsappIn(THANDI, { text: 'Hello', id: 'wamid.same' });
  assert.equal(s.whatsapp.to(THANDI).length, before + 1);
});

test('an action waits for Confirm from the linked number, and runs once', async () => {
  const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
  await s.whatsappIn(THANDI, { text: 'Book Saffron House on 2030-12-06 at 7pm for four' });
  const ask = last(THANDI);
  assert.equal(ask.type, 'buttons');
  if (ask.type !== 'buttons') return;
  assert.deepEqual(ask.buttons.map((b) => b.title), ['Confirm', 'Not now']);
  const confirm = ask.buttons[0]!.id;
  assert.equal((await thandi.getQeraThread()).pending?.tool, 'book_partner');
  // Nothing has happened yet.
  assert.equal((await thandi.listPartnerBookings()).length, 0);
  // The same button from a number that is not linked does nothing.
  await s.whatsappIn(STRANGER, { button: confirm });
  assert.equal(last(STRANGER).text, WHATSAPP_TEXT.notLinked);
  assert.equal((await thandi.getQeraThread()).pending?.tool, 'book_partner');
  await s.whatsappIn(THANDI, { button: confirm });
  assert.equal((await thandi.getQeraThread()).pending, null);
  assert.equal((await thandi.listPartnerBookings()).length, 1);
  // Pressing it again cannot run it twice.
  await s.whatsappIn(THANDI, { button: confirm });
  assert.equal(last(THANDI).text, 'That is no longer waiting for an answer.');
  assert.equal((await thandi.listPartnerBookings()).length, 1);
  // A typed NO declines what is waiting.
  await s.whatsappIn(THANDI, { text: 'Book Saffron House on 2030-12-11 at 8pm for two' });
  await s.whatsappIn(THANDI, { text: 'No' });
  assert.equal(last(THANDI).text, 'Understood. I have not done anything.');
  assert.equal((await thandi.listPartnerBookings()).length, 1);
  const log = (await s.db.query<{ action: string; detail: { channel?: string } }>(`SELECT action, changes AS detail FROM audit_logs WHERE action IN ('whatsapp.linked', 'qera.confirmed', 'qera.declined') ORDER BY occurred_at`));
  assert.deepEqual(log.map((r) => r.action), ['whatsapp.linked', 'qera.confirmed', 'qera.declined']);
  assert.equal(log[1]!.detail.channel, 'whatsapp');
});

test('STOP unlinks the number at once; the app can unlink too; the export shows only the last digits', async () => {
  const thandi = s.client(); await thandi.signIn({ email: 'thandi@example.com' });
  const data = await thandi.exportMyData() as { whatsapp: { number_ends_with: string } | null };
  assert.equal(data.whatsapp?.number_ends_with, '4567');
  await s.whatsappIn(THANDI, { text: 'STOP' });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.unlinked);
  assert.equal((await thandi.getWhatsApp()).status, 'none');
  await s.whatsappIn(THANDI, { text: 'Are you there?' });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.notLinked);
  // Link again, then unlink from the app.
  const code = (await thandi.linkWhatsApp({ consent: true })).code!;
  await s.whatsappIn(THANDI, { text: `LINK ${code}` });
  assert.equal((await thandi.getWhatsApp()).status, 'linked');
  await thandi.unlinkWhatsApp();
  await s.whatsappIn(THANDI, { text: 'Hello again' });
  assert.equal(last(THANDI).text, WHATSAPP_TEXT.notLinked);
  const consents = (await s.db.query<{ granted: boolean }>(`SELECT granted FROM consent_events c JOIN users u ON u.id = c.user_id WHERE u.email = 'thandi@example.com' AND consent_key = 'whatsapp' ORDER BY occurred_at`)).map((r) => r.granted);
  assert.deepEqual(consents, [true, false, true, false]);
});

test('a guest account gets read-only QÉRA on WhatsApp, within the daily allowance', async () => {
  const guest = s.client();
  await guest.createGuestAccount({ fullName: 'Lerato Guest', email: 'lerato.wa@example.org' });
  const code = (await guest.linkWhatsApp({ consent: true })).code!;
  await s.whatsappIn(DANIEL, { text: `LINK ${code}` });
  assert.equal(last(DANIEL).text, WHATSAPP_TEXT.welcome);
  await s.whatsappIn(DANIEL, { text: 'Book Saffron House on 2030-12-06 at 7pm for four' });
  assert.equal(last(DANIEL).type, 'text');     // guests are never offered an action
  const user = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'lerato.wa@example.org'`))[0]!.id;
  await s.db.query('UPDATE qera_guest_usage SET used_seconds = 999999 WHERE user_id = $1', [user]);
  await s.whatsappIn(DANIEL, { text: 'One more question' });
  assert.match(last(DANIEL).text, /five hours with QÉRA/);
});
