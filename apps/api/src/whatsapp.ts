/**
 * QÉRA on WhatsApp, through the WhatsApp Business Platform (Cloud API).
 *
 * Linking: in the app the person agrees, and is given a one-time code. They send "LINK 123456" from their WhatsApp
 * to Quintara's number. The message proves they hold the number; nothing is ever sent to a number that has not
 * written to Quintara first, and nothing is sent outside WhatsApp's 24-hour reply window.
 *
 * Messages: WhatsApp posts each message to the webhook. The signature is checked against the app secret before
 * anything is read, each message is handled once (by its id), and a message from a linked number is passed to
 * QÉRA as that person, through the same functions as the app, so the same permissions, tools and guest allowance
 * apply. Anything QÉRA would do is sent back with Confirm and Not now buttons and happens only on Confirm from the
 * linked number. Staff powers are never available on WhatsApp.
 *
 * The number is stored as a keyed hash (to recognise it), encrypted (to reply) and by its last four digits (to
 * show). The text of the conversation is kept only in the QÉRA conversation, where the person can read and clear it.
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { linkMessage, maskNumber, readCommand, toWhatsAppText, waDigits, waMeLink, WHATSAPP_CODE_MINUTES, WHATSAPP_TEXT, whatsAppLinkSchema } from '@quintara/domain';
import type { QeraModel, QeraThread, WhatsAppLink } from '@quintara/domain';
import { sealAddress } from './calendar.ts';
import { audit, contextForUser } from './context.ts';
import { MemoryRateLimiter } from './ratelimit.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { HttpError, unauthenticated, validation } from './errors.ts';
import { GUEST_LIMIT_MESSAGE } from './guests.ts';
import { resolveMarket } from './markets.ts';
import type { PaymentProvider } from './payments.ts';
import { decideProposal, getThread, sendMessage } from './qera.ts';

/* ---------- Sending ---------- */

export type OutgoingMessage = { type: 'text'; text: string } | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] };

/** Sends a message to a WhatsApp number. Replace the stand-in with the Cloud API adapter below in production. */
export interface WhatsAppProvider {
  readonly name: string;
  send(to: string, message: OutgoingMessage): Promise<{ id: string }>;
}

/** Keeps what would have been sent, for development and tests. */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock';
  readonly sent: { to: string; message: OutgoingMessage }[] = [];
  async send(to: string, message: OutgoingMessage) { this.sent.push({ to, message }); return { id: `wamid.mock.${this.sent.length}` }; }
  /** Everything sent to a number, as text. */
  to(number: string) { return this.sent.filter((m) => m.to === waDigits(number)).map((m) => m.message); }
}

/** The WhatsApp Cloud API. Needs a permanent access token and the phone number id from Meta's Business Manager. */
export class CloudApiWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'whatsapp-cloud';
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly version: string;
  constructor(options: { token: string; phoneNumberId: string; version?: string }) {
    this.token = options.token; this.phoneNumberId = options.phoneNumberId; this.version = options.version ?? 'v21.0';
  }
  async send(to: string, message: OutgoingMessage) {
    const payload = message.type === 'text'
      ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.text, preview_url: false } }
      : { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: message.text.slice(0, 1024) },
          action: { buttons: message.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } } };
    const response = await fetch(`https://graph.facebook.com/${this.version}/${encodeURIComponent(this.phoneNumberId)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`WhatsApp refused the message (${response.status}).`);
    const body = await response.json() as { messages?: { id: string }[] };
    return { id: body.messages?.[0]?.id ?? '' };
  }
}

export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  /** Quintara's WhatsApp Business number, as people should see it. */
  businessNumber: string;
  /** Chosen by Quintara and entered in Meta's webhook settings, to confirm the webhook. */
  verifyToken: string;
  /** The Meta app secret: every delivery is signed with it. */
  appSecret: string;
  /** At least 32 characters. Keys the number hash and encrypts the number. */
  numberSecret: string;
  /** Messages a number may send per minute. */
  perMinute?: number;
}

/* ---------- Linking, from the app ---------- */

const hashOf = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('hex');
const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');

/** Members and guest accounts may use QÉRA on WhatsApp. */
function holder(ctx: RequestContext): string {
  if (ctx.session || ctx.guest) return ctx.userId!;
  throw unauthenticated();
}

export async function getWhatsApp(db: Queryable, ctx: RequestContext, config: WhatsAppConfig | null): Promise<WhatsAppLink> {
  const userId = holder(ctx);
  const base: WhatsAppLink = { available: !!config, status: 'none', businessNumber: config?.businessNumber ?? null, numberMasked: null, linkedAt: null, code: null, message: null, openUrl: null, codeExpiresAt: null };
  const row = (await db.query('SELECT status, number_last4, linked_at, code_expires_at FROM whatsapp_links WHERE user_id = $1', [userId]))[0];
  if (!row) return base;
  if (row.status === 'linked') return { ...base, status: 'linked', numberMasked: maskNumber(String(row.number_last4)), linkedAt: new Date(row.linked_at as string).toISOString() };
  // A code is shown only once, when it is made; afterwards the link is simply pending until it expires.
  return new Date(row.code_expires_at as string) > new Date() ? { ...base, status: 'pending', codeExpiresAt: new Date(row.code_expires_at as string).toISOString() } : base;
}

/** Makes a new one-time code. A number already linked stays linked until the new code is used. */
export async function startWhatsAppLink(db: Db, ctx: RequestContext, config: WhatsAppConfig | null, body: unknown): Promise<WhatsAppLink> {
  const userId = holder(ctx);
  if (!config) throw new HttpError(503, 'QÉRA on WhatsApp is not available yet.');
  const parsed = whatsAppLinkSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expires = await db.tx(async (tx) => {
    const rows = await tx.query<{ code_expires_at: Date }>(
      `INSERT INTO whatsapp_links (user_id, status, code_hash, code_expires_at) VALUES ($1, 'pending', $2, now() + make_interval(mins => $3))
       ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, code_expires_at = EXCLUDED.code_expires_at,
         status = CASE WHEN whatsapp_links.status = 'linked' THEN 'linked' ELSE 'pending' END
       RETURNING code_expires_at`, [userId, codeHash(code), WHATSAPP_CODE_MINUTES]);
    await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'whatsapp', true)`, [userId]);
    await audit(tx, userId, 'whatsapp.code_issued', 'user', userId);
    return new Date(rows[0]!.code_expires_at).toISOString();
  });
  const current = await getWhatsApp(db, ctx, config);
  return { ...current, status: current.status === 'linked' ? 'linked' : 'pending', code, message: linkMessage(code), openUrl: waMeLink(config.businessNumber, linkMessage(code)), codeExpiresAt: expires };
}

/** Unlinks the number. QÉRA stops answering it at once. */
export async function unlinkWhatsApp(db: Db, ctx: RequestContext): Promise<void> {
  const userId = holder(ctx);
  await db.tx(async (tx) => {
    const rows = await tx.query('DELETE FROM whatsapp_links WHERE user_id = $1 RETURNING status', [userId]);
    if (rows[0]) {
      await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'whatsapp', false)`, [userId]);
      await audit(tx, userId, 'whatsapp.unlinked', 'user', userId, { by: 'app' });
    }
  });
}

/* ---------- The webhook ---------- */

/** Meta's check when the webhook is set up: echo the challenge if the token matches. */
export function verifyWebhook(config: WhatsAppConfig | null, query: Record<string, string | undefined>): string {
  const token = query['hub.verify_token'] ?? '';
  if (!config || query['hub.mode'] !== 'subscribe' || !safeEqual(token, config.verifyToken)) throw new HttpError(403, 'Not allowed.');
  const challenge = query['hub.challenge'] ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) throw new HttpError(400, 'Not allowed.');
  return challenge;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when the body was signed with the app secret. Checked before the body is parsed. */
export function signatureValid(config: WhatsAppConfig, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), createHmac('sha256', config.appSecret).update(raw).digest('hex'));
}

interface Inbound { id: string; from: string; text: string | null; button: string | null }

/** The messages in a delivery. Anything that is not a message from a person (delivery receipts, for example) is skipped. */
export function readDelivery(body: unknown): Inbound[] {
  const out: Inbound[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries.slice(0, 20)) {
    for (const change of ((entry as { changes?: unknown[] }).changes ?? []).slice(0, 20)) {
      const messages = ((change as { value?: { messages?: unknown[] } }).value?.messages ?? []) as Record<string, unknown>[];
      for (const m of messages.slice(0, 50)) {
        const id = typeof m.id === 'string' ? m.id.slice(0, 200) : '', from = typeof m.from === 'string' ? waDigits(m.from).slice(0, 20) : '';
        if (!id || from.length < 7) continue;
        const text = m.type === 'text' ? String((m.text as { body?: unknown } | undefined)?.body ?? '').slice(0, 1000) : null;
        const reply = m.type === 'interactive' ? (m.interactive as { button_reply?: { id?: unknown } } | undefined)?.button_reply?.id : m.type === 'button' ? (m.button as { payload?: unknown } | undefined)?.payload : null;
        out.push({ id, from, text, button: typeof reply === 'string' ? reply.slice(0, 100) : null });
      }
    }
  }
  return out;
}

export interface WhatsAppDeps { db: Db; config: WhatsAppConfig; model: QeraModel; payments: PaymentProvider; guestLimit?: number; limiter?: RateLimiter }

// Messages per number per minute. Counted with the API's rate limiter when given (shared by every API process).
const ownLimiter = new MemoryRateLimiter();

/** Handles one delivery. Errors are logged by the caller; WhatsApp is always answered 200 so it does not resend. */
export async function handleDelivery(deps: WhatsAppDeps, body: unknown): Promise<void> {
  for (const message of readDelivery(body)) {
    // Each message once, however often WhatsApp delivers it.
    const fresh = await deps.db.query(`INSERT INTO whatsapp_events (wamid, direction, kind) VALUES ($1, 'in', $2) ON CONFLICT (wamid) DO NOTHING RETURNING id`, [message.id, message.button ? 'button' : message.text !== null ? 'text' : 'other']);
    if (!fresh[0]) continue;
    await handleMessage(deps, message);
  }
}

async function handleMessage(deps: WhatsAppDeps, m: Inbound): Promise<void> {
  const { db, config } = deps;
  const reply = (message: OutgoingMessage, userId: string | null = null) => send(deps, m.from, message, userId);
  const perMinute = config.perMinute ?? 20, sent = await (deps.limiter ?? ownLimiter).hit('whatsapp', m.from);
  if (sent > perMinute) {
    // Told once, on the first message over the limit; after that, silence until the minute is over.
    if (sent === perMinute + 1) await reply({ type: 'text', text: WHATSAPP_TEXT.slowDown });
    return;
  }
  const numberHash = hashOf(m.from, config.numberSecret);
  const command = m.text !== null ? readCommand(m.text) : null;

  if (command?.kind === 'link') return link(deps, m, numberHash, command.code);

  const linked = (await db.query<{ user_id: string }>(`SELECT user_id FROM whatsapp_links WHERE number_hash = $1 AND status = 'linked'`, [numberHash]))[0];
  // An unknown number learns nothing about any account.
  if (!linked) return reply({ type: 'text', text: WHATSAPP_TEXT.notLinked });
  const userId = linked.user_id;
  await db.query('UPDATE whatsapp_events SET user_id = $2 WHERE wamid = $1', [m.id, userId]);
  await db.query('UPDATE whatsapp_links SET last_inbound_at = now() WHERE user_id = $1', [userId]);

  if (command?.kind === 'unlink') {
    await db.query('DELETE FROM whatsapp_links WHERE user_id = $1', [userId]);
    await db.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'whatsapp', false)`, [userId]);
    await audit(db, userId, 'whatsapp.unlinked', 'user', userId, { by: 'whatsapp' });
    return reply({ type: 'text', text: WHATSAPP_TEXT.unlinked }, userId);
  }
  if (command?.kind === 'help') return reply({ type: 'text', text: WHATSAPP_TEXT.help }, userId);

  const ctx = await contextForUser(db, userId);
  if (!ctx.session && !ctx.guest) return reply({ type: 'text', text: WHATSAPP_TEXT.cannotUse }, userId);
  ctx.marketId = await resolveMarket(db, ctx, undefined);

  // A yes or no: the Confirm and Not now buttons carry the proposal's id; a typed YES or NO answers what is waiting.
  let decision: { id: string; confirm: boolean } | null = null;
  if (m.button) {
    const [verb, id] = m.button.split(':');
    if ((verb === 'confirm' || verb === 'cancel') && id) decision = { id, confirm: verb === 'confirm' };
  } else if (command?.kind === 'yes' || command?.kind === 'no') {
    const pending = (await getThread(db, ctx, deps.guestLimit)).pending;
    if (!pending) return reply({ type: 'text', text: WHATSAPP_TEXT.nothingWaiting }, userId);
    decision = { id: pending.id, confirm: command.kind === 'yes' };
  }
  if (decision) {
    if (!ctx.session) return reply({ type: 'text', text: WHATSAPP_TEXT.nothingWaiting }, userId);
    try {
      const thread = await decideProposal(db, ctx, deps.payments, ctx.marketId, decision.id, decision.confirm, 'whatsapp');
      return answer(deps, m.from, userId, thread);
    } catch (error) {
      return reply({ type: 'text', text: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' }, userId);
    }
  }
  if (m.text === null || m.button) return reply({ type: 'text', text: WHATSAPP_TEXT.unsupported }, userId);

  try {
    const thread = await sendMessage(db, ctx, deps.model, deps.payments, ctx.marketId, { text: m.text }, deps.guestLimit, 'whatsapp');
    return answer(deps, m.from, userId, thread);
  } catch (error) {
    if (error instanceof HttpError && error.message === GUEST_LIMIT_MESSAGE) return reply({ type: 'text', text: GUEST_LIMIT_MESSAGE }, userId);
    if (error instanceof HttpError && error.status === 422) return reply({ type: 'text', text: 'Please write a little less: up to 1,000 characters.' }, userId);
    throw error;
  }
}

/** QÉRA's latest reply; and, when it is waiting for a yes or no, Confirm and Not now buttons. */
async function answer(deps: WhatsAppDeps, to: string, userId: string, thread: QeraThread): Promise<void> {
  const last = [...thread.messages].reverse().find((message) => message.role === 'qera');
  if (thread.pending) {
    if (last) await send(deps, to, { type: 'text', text: toWhatsAppText(last.text) }, userId);
    await send(deps, to, { type: 'buttons', text: toWhatsAppText(`${thread.pending.summary}\n\nShall I go ahead?`), buttons: [{ id: `confirm:${thread.pending.id}`, title: 'Confirm' }, { id: `cancel:${thread.pending.id}`, title: 'Not now' }] }, userId);
    return;
  }
  if (last) await send(deps, to, { type: 'text', text: toWhatsAppText(last.text) }, userId);
}

async function link(deps: WhatsAppDeps, m: Inbound, numberHash: string, code: string): Promise<void> {
  const { db, config } = deps;
  const result = await db.tx(async (tx) => {
    const row = (await tx.query<{ user_id: string }>(`SELECT user_id FROM whatsapp_links WHERE code_hash = $1 AND code_expires_at > now() FOR UPDATE`, [codeHash(code)]))[0];
    if (!row) return { text: WHATSAPP_TEXT.badCode, userId: null };
    const other = (await tx.query<{ user_id: string }>(`SELECT user_id FROM whatsapp_links WHERE number_hash = $1 AND user_id <> $2`, [numberHash, row.user_id]))[0];
    if (other) return { text: WHATSAPP_TEXT.numberTaken, userId: null };
    await tx.query(
      `UPDATE whatsapp_links SET status = 'linked', number_hash = $2, number_sealed = $3, number_last4 = $4, linked_at = now(), last_inbound_at = now(), code_hash = NULL, code_expires_at = NULL WHERE user_id = $1`,
      [row.user_id, numberHash, sealAddress(m.from, config.numberSecret), m.from.slice(-4)]);
    await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'membership_update', $2, '{"type":"qera"}'::jsonb)`, [row.user_id, `QÉRA is now on WhatsApp, on the number ending ${m.from.slice(-4)}.`]);
    await audit(tx, row.user_id, 'whatsapp.linked', 'user', row.user_id);
    return { text: WHATSAPP_TEXT.welcome, userId: row.user_id };
  });
  await send(deps, m.from, { type: 'text', text: result.text }, result.userId);
}

async function send(deps: WhatsAppDeps, to: string, message: OutgoingMessage, userId: string | null): Promise<void> {
  const sent = await deps.config.provider.send(to, message);
  if (sent.id) await deps.db.query(`INSERT INTO whatsapp_events (wamid, direction, user_id, kind) VALUES ($1, 'out', $2, $3) ON CONFLICT (wamid) DO NOTHING`, [sent.id, userId, message.type]);
}
