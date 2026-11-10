/**
 * The adapters for outside services, run for real against local stand-ins that answer as each provider's published
 * API does: Resend (email), the WhatsApp Cloud API, Expo push, a calendar host, and the Claude Messages API.
 * What is checked is what goes over the wire (address, credentials, body) and what happens when the service fails.
 * The services themselves still need confirming with real credentials in staging (docs/DEPLOYMENT.md).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { httpCalendarFetcher } from '../src/calendar.ts';
import { deliverEmails, ResendEmailProvider } from '../src/email.ts';
import { dispatchPush, ExpoPushProvider } from '../src/push.ts';
import type { PushMessage, PushProvider } from '../src/push.ts';
import { ClaudeQeraModel } from '../src/qera-claude.ts';
import { CloudApiWhatsAppProvider } from '../src/whatsapp.ts';
import { startServer } from './harness.ts';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: any }
type Answer = (seen: Seen, res: ServerResponse) => void;

/** A local HTTP server that records each request and answers with `answer`. */
async function standIn(answer: Answer) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const one: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(one);
      answer(one, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('Resend: the message as Resend expects it, a key that makes retries safe, and a refusal kept for the next run', async () => {
  let fail = true;
  const resend = await standIn((_, res) => (fail ? json(res, 500, { name: 'internal_server_error' }) : json(res, 200, { id: 'email_1' })));
  const s = await startServer();
  try {
    const provider = new ResendEmailProvider({ apiKey: 're_test_key', from: 'Quintara <hello@quintara.test>', baseUrl: resend.url });
    const user = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    await s.db.query(`DELETE FROM email_outbox`);
    await s.db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'booking_confirmation', 'Your table is ready.', '{"type":"booking","id":"x"}'::jsonb)`, [user]);

    // The service fails: nothing is lost, the error is kept, and the message waits for the next run.
    assert.equal(await deliverEmails(s.db, provider, 'https://app.quintara.test'), 0);
    const waiting = (await s.db.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM email_outbox`))[0]!;
    assert.deepEqual([waiting.status, waiting.last_error], ['pending', 'The mail service refused the message (500).']);

    fail = false;
    assert.equal(await deliverEmails(s.db, provider, 'https://app.quintara.test'), 1);
    assert.equal((await s.db.query<{ status: string }>(`SELECT status FROM email_outbox`))[0]!.status, 'sent');
    const [first, second] = resend.seen;
    assert.deepEqual([second!.method, second!.url, second!.headers.authorization], ['POST', '/emails', 'Bearer re_test_key']);
    assert.deepEqual(second!.body, { from: 'Quintara <hello@quintara.test>', to: ['thandi@example.com'], subject: 'Your table is ready.', text: 'Dear Thandi,\n\nYour table is ready.\n\nOpen Quintara: https://app.quintara.test/bookings\n\nQuintara' });
    // Both attempts at the one message carry the same key: had the first gone out, the second would not.
    assert.match(String(second!.headers['idempotency-key']), /^email\/[0-9a-f-]{36}$/);
    assert.equal(first!.headers['idempotency-key'], second!.headers['idempotency-key']);
  } finally { await s.close(); await resend.close(); }
});

test('WhatsApp Cloud API: text and buttons as Meta defines them, the message id kept, a refusal reported', async () => {
  let n = 0;
  const meta = await standIn((seen, res) => (seen.body.to === '27000000000' ? json(res, 400, { error: { message: 'Recipient not on WhatsApp' } }) : json(res, 200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.test.${++n}` }] })));
  try {
    const wa = new CloudApiWhatsAppProvider({ token: 'EAAG-test', phoneNumberId: '1234567890', baseUrl: meta.url });
    assert.deepEqual(await wa.send('27821234567', { type: 'text', text: 'Hello from QÉRA' }), { id: 'wamid.test.1' });
    const sent = await wa.send('27821234567', { type: 'buttons', text: 'Book two seats?', buttons: [
      { id: 'yes', title: 'Yes, go ahead please, now' }, { id: 'no', title: 'No' }, { id: 'later', title: 'Later' }, { id: 'extra', title: 'Extra' }] });
    assert.equal(sent.id, 'wamid.test.2');
    const [text, buttons] = meta.seen;
    assert.deepEqual([text!.method, text!.url, text!.headers.authorization], ['POST', '/v21.0/1234567890/messages', 'Bearer EAAG-test']);
    assert.deepEqual(text!.body, { messaging_product: 'whatsapp', to: '27821234567', type: 'text', text: { body: 'Hello from QÉRA', preview_url: false } });
    // Meta allows three reply buttons of at most 20 characters.
    assert.equal(buttons!.body.type, 'interactive');
    assert.deepEqual(buttons!.body.interactive.action.buttons, [
      { type: 'reply', reply: { id: 'yes', title: 'Yes, go ahead please' } }, { type: 'reply', reply: { id: 'no', title: 'No' } }, { type: 'reply', reply: { id: 'later', title: 'Later' } }]);
    await assert.rejects(wa.send('27000000000', { type: 'text', text: 'Hi' }), /WhatsApp refused the message \(400\)/);
  } finally { await meta.close(); }
});

test('WhatsApp end to end: a signed message from Meta is answered by QÉRA through the Cloud API adapter', async () => {
  const meta = await standIn((_, res) => json(res, 200, { messages: [{ id: 'wamid.reply.1' }] }));
  const cloud = new CloudApiWhatsAppProvider({ token: 'EAAG-test', phoneNumberId: '42', baseUrl: meta.url });
  const s = await startServer({ whatsapp: { provider: cloud, businessNumber: '+27 21 000 0000', verifyToken: 'test-verify-token', appSecret: 'test-app-secret', numberSecret: 'test-number-secret-of-at-least-32-chars', perMinute: 1000 } });
  try {
    assert.equal(await s.whatsappIn('+27 82 555 0101', { text: 'hello' }), 200);
    // An unlinked number is told how to link it, through Meta's API.
    assert.equal(meta.seen.length, 1);
    assert.deepEqual([meta.seen[0]!.url, meta.seen[0]!.body.to], ['/v21.0/42/messages', '27825550101']);
    assert.ok(String(meta.seen[0]!.body.text?.body ?? meta.seen[0]!.body.interactive?.body?.text).length > 10);
    // Meta's own message id is what the reply is recorded under.
    assert.equal((await s.db.query(`SELECT 1 FROM whatsapp_events WHERE wamid = 'wamid.reply.1' AND direction = 'out'`)).length, 1);
  } finally { await s.close(); await meta.close(); }
});

const msg = (k: number): PushMessage => ({ to: `ExponentPushToken[device${k}]`, title: 'Quintara', body: 'News', data: { notificationId: `n${k}`, link: null } });

test('Expo push: batches of 100 with the access token; unregistered phones recognised; a later batch failing is retried alone', async () => {
  let calls = 0;
  const expo = await standIn((seen, res) => {
    calls++;
    if (calls === 2) return json(res, 503, { errors: [{ code: 'INTERNAL' }] });
    json(res, 200, { data: seen.body.map((m: { to: string }) => (m.to.endsWith('[device3]') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket' })) });
  });
  try {
    const provider = new ExpoPushProvider('expo-access-token', `${expo.url}/--/api/v2/push/send`);
    const tickets = await provider.send(Array.from({ length: 250 }, (_, k) => msg(k)));
    assert.equal(expo.seen.length, 2);                                           // the third batch is not tried once one fails
    assert.deepEqual(expo.seen.map((r) => r.body.length), [100, 100]);
    assert.equal(expo.seen[0]!.headers.authorization, 'Bearer expo-access-token');
    assert.deepEqual(Object.keys(expo.seen[0]!.body[0]).sort(), ['body', 'channelId', 'data', 'priority', 'sound', 'title', 'to']);
    assert.equal(tickets.length, 250);
    assert.deepEqual(tickets[3], { status: 'error', reason: 'DeviceNotRegistered', unregistered: true });
    assert.equal(tickets.slice(0, 100).filter((t) => t.status === 'ok').length, 99);
    assert.ok(tickets.slice(100).every((t) => t.status === 'error' && t.retry), 'the rest are marked to try again');

    // The first batch failing means nothing went out: the whole send fails and is tried again later.
    calls = 1;
    await assert.rejects(provider.send([msg(1)]), /answered 503/);
  } finally { await expo.close(); }
});

test('a push the service could not take this time is sent on the next run; one that reached a phone is not sent again', async () => {
  const s = await startServer();
  try {
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    await thandi.registerPushDevice({ token: 'ExponentPushToken[thandiphone1]', platform: 'ios' });
    const user = (await s.db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'thandi@example.com'`))[0]!.id;
    await s.db.query(`UPDATE notifications SET push_state = 'skipped' WHERE push_state = 'pending'`);
    await s.db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'booking_confirmation', 'One'), ($1, 'booking_confirmation', 'Two')`, [user]);
    const sent: string[] = [];
    let busy = true;
    const flaky: PushProvider = {
      name: 'flaky',
      // As the Expo adapter answers when its second batch fails: the first message out, the second to try again.
      async send(messages) { return messages.map((m, k) => (k === 0 || !busy ? (sent.push(String(m.data.notificationId)), { status: 'ok' as const }) : { status: 'error' as const, reason: 'busy', unregistered: false, retry: true })); },
    };
    assert.equal(await dispatchPush(s.db, flaky), 1);
    const states = await s.db.query<{ title: string; push_state: string }>(`SELECT title, push_state FROM notifications WHERE title IN ('One', 'Two') ORDER BY title`);
    assert.deepEqual(states.map((n) => n.push_state), ['sent', 'pending']);
    busy = false;
    assert.equal(await dispatchPush(s.db, flaky), 1);
    assert.equal(new Set(sent).size, sent.length, 'nothing pushed twice');
    assert.equal(sent.length, 2);
  } finally { await s.close(); }
});

test('calendar fetch: reads a calendar; refuses redirects, error answers and oversized files', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Board meeting\r\nDTSTART:20261112T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const host = await standIn((seen, res) => {
    if (seen.url === '/cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(ics); }
    if (seen.url === '/moved.ics') { res.writeHead(302, { location: '/cal.ics' }); return res.end(); }
    if (seen.url === '/huge.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end('X'.repeat(2_100_000)); }
    res.writeHead(404); res.end();
  });
  try {
    assert.equal(await httpCalendarFetcher(new URL(`${host.url}/cal.ics`)), ics);
    assert.equal(host.seen[0]!.headers.accept, 'text/calendar');
    await assert.rejects(httpCalendarFetcher(new URL(`${host.url}/moved.ics`)));                       // a redirect could lead anywhere
    await assert.rejects(httpCalendarFetcher(new URL(`${host.url}/gone.ics`)), /answered 404/);
    await assert.rejects(httpCalendarFetcher(new URL(`${host.url}/huge.ics`)), /too large/);
  } finally { await host.close(); }
});

test('Claude: the request QÉRA sends to the Messages API, and how it reads a tool call, a reply and a refusal', async () => {
  const answers = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_experiences', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The Aura Enclave is on Friday.' }] },
    { stop_reason: 'refusal', content: [] },
  ];
  const api = await standIn((_, res) => {
    const next = answers.shift()!;
    json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, ...next });
  });
  try {
    const model = new ClaudeQeraModel({ client: new Anthropic({ apiKey: 'sk-ant-test', baseURL: api.url, maxRetries: 0 }), today: () => '2026-11-10' });
    const step = await model.next({ message: 'What is on this week?', results: [], tools: ['list_experiences'] });
    assert.deepEqual(step, { toolCall: { name: 'list_experiences', args: {} } });
    const request = api.seen[0]!;
    // The SDK in use (1.x) sends the key as a bearer token; the beta goes in the anthropic-beta header.
    assert.deepEqual([request.method, request.url, request.headers.authorization], ['POST', '/v1/messages', 'Bearer sk-ant-test']);
    assert.match(String(request.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(request.body.model, 'claude-opus-5-5');
    assert.equal(request.body.max_tokens, 16_000);
    assert.equal(request.body.fallbacks, 'default');
    assert.deepEqual(request.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal(request.body.tools[0].name, 'list_experiences');
    assert.equal(request.body.tools[0].input_schema.type, 'object');
    assert.deepEqual(request.body.system[0].cache_control, { type: 'ephemeral' });                      // the fixed prompt is cached
    assert.equal(request.body.thinking, undefined);                                                     // left to the model's default

    // With the tool's result, the conversation is sent back with the call and its answer.
    const reply = await model.next({ message: 'What is on this week?', results: [{ name: 'list_experiences', args: {}, data: [{ title: 'The Aura Enclave' }] }], tools: ['list_experiences'] });
    assert.deepEqual(reply, { reply: 'The Aura Enclave is on Friday.' });
    assert.deepEqual(api.seen[1]!.body.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);
    assert.equal(api.seen[1]!.body.messages[2].content[0].type, 'tool_result');
    assert.match((await model.next({ message: 'Something else', results: [], tools: [] }) as { reply: string }).reply, /concierge desk/);
  } finally { await api.close(); }
});
