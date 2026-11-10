/**
 * Push notifications to members' phones.
 *
 * Every row added to `notifications` is pushed by `dispatchPush`, which runs every few seconds: the 19 places that
 * notify someone need no change, and a notification is only pushed once its transaction has committed.
 *
 * - A phone is registered by the signed-in app with its Expo push token, tied to that session: when the session
 *   ends (sign out, sign out everywhere, suspension, a two-factor reset) the phone gets nothing more.
 * - The lock screen shows only "There is news about your order" unless the person turns on details.
 * - People choose which kinds of notification are pushed; everything still appears under Notifications.
 * - Notifications more than six hours old are not pushed (after an outage, say).
 */
import type { NotificationCategory, PushDevice, PushSettings } from '@quintara/domain';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABEL, pushRegistrationSchema, pushSettingsInputSchema } from '@quintara/domain';
import { audit, hashToken } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { HttpError, notFound, unauthenticated, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Where the app opens when the notification is tapped. */
  data: { notificationId: string; link: unknown };
  badge?: number;
}
/** One answer per message, in order. `unregistered`: the app was removed or the token is no longer valid. */
export type PushTicket = { status: 'ok' } | { status: 'error'; reason: string; unregistered: boolean; retry?: boolean };

export interface PushProvider {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

/** Records what would have been sent. Used in development and tests. */
export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  readonly sent: PushMessage[] = [];
  /** Tokens to answer as no longer registered. */
  readonly gone = new Set<string>();
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    return messages.map((m) => {
      if (this.gone.has(m.to)) return { status: 'error', reason: 'DeviceNotRegistered', unregistered: true };
      this.sent.push(m);
      return { status: 'ok' };
    });
  }
}

/**
 * Expo's push service, which delivers through Apple (APNs) and Google (FCM) with the credentials set up by EAS.
 * `accessToken` is the optional Expo access token for "enhanced push security".
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  private readonly accessToken: string | undefined;
  private readonly endpoint: string;
  constructor(accessToken?: string, endpoint = 'https://exp.host/--/api/v2/push/send') { this.accessToken = accessToken; this.endpoint = endpoint; }
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const out: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) },
          body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default', channelId: 'default', priority: 'high' }))),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`The push service answered ${response.status}.`);
      } catch (error) {
        // Nothing went out yet: the caller tries everything again later. Otherwise the batches already delivered
        // must not be sent twice, so only this batch and those after it are marked to try again.
        if (i === 0) throw error;
        const reason = (error as Error).message;
        for (let k = i; k < messages.length; k++) out.push({ status: 'error', reason, unregistered: false, retry: true });
        return out;
      }
      const tickets = ((await response.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] }).data ?? [];
      batch.forEach((_, k) => {
        const t = tickets[k];
        out.push(!t ? { status: 'error', reason: 'No answer', unregistered: false }
          : t.status === 'ok' ? { status: 'ok' }
          : { status: 'error', reason: t.details?.error ?? t.message ?? 'Error', unregistered: t.details?.error === 'DeviceNotRegistered' });
      });
    }
    return out;
  }
}

/* ---------- Registration and settings ---------- */

/** Any signed-in member or guest account may register the phone they are using. */
export async function registerDevice(db: Queryable, ctx: RequestContext, sessionToken: string | undefined, body: unknown): Promise<{ id: string }> {
  if (!ctx.userId || !sessionToken) throw unauthenticated();
  const parsed = pushRegistrationSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const session = (await db.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(sessionToken)]))[0];
  if (!session) throw unauthenticated();
  const d = parsed.data;
  // The same phone signing in as someone else takes the token over: it now belongs to this person and session only.
  const id = (await db.query<{ id: string }>(
    `INSERT INTO push_devices (user_id, session_id, token, platform, device_name) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, platform = EXCLUDED.platform,
       device_name = EXCLUDED.device_name, last_seen_at = now(), disabled_at = NULL, disabled_reason = NULL
     RETURNING id`, [ctx.userId, session.id, d.token, d.platform, d.deviceName]))[0]!.id;
  return { id };
}

/** The app removes its own token when it signs out or push is turned off on the phone. */
export async function unregisterDevice(db: Queryable, ctx: RequestContext, body: unknown): Promise<void> {
  if (!ctx.userId) throw unauthenticated();
  const token = String((body as { token?: unknown } | null)?.token ?? '');
  await db.query('DELETE FROM push_devices WHERE token = $1 AND user_id = $2', [token, ctx.userId]);
}

/** Removes one of the person's phones from the list in their settings. */
export async function removeDevice(db: Queryable, ctx: RequestContext, id: string): Promise<void> {
  if (!ctx.userId) throw unauthenticated();
  const rows = UUID.test(id) ? await db.query('DELETE FROM push_devices WHERE id = $1 AND user_id = $2 RETURNING id', [id, ctx.userId]) : [];
  if (!rows[0]) throw notFound('That phone is not registered.');
}

export async function getPushSettings(db: Queryable, ctx: RequestContext, sessionToken?: string): Promise<PushSettings> {
  if (!ctx.userId) throw unauthenticated();
  const row = (await db.query<{ muted: string[]; show_details: boolean }>('SELECT muted, show_details FROM push_settings WHERE user_id = $1', [ctx.userId]))[0];
  const devices = await db.query(
    `SELECT d.id, d.platform, d.device_name, d.created_at, d.last_seen_at, s.token_hash = $2 AS this_device
       FROM push_devices d JOIN sessions s ON s.id = d.session_id
      WHERE d.user_id = $1 AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY d.last_seen_at DESC`,
    [ctx.userId, sessionToken ? hashToken(sessionToken) : '']);
  return {
    muted: (row?.muted ?? []).filter((c): c is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly string[]).includes(c)),
    showDetails: row?.show_details ?? false,
    devices: devices.map((d): PushDevice => ({ id: d.id as string, platform: d.platform as PushDevice['platform'], deviceName: d.device_name as string, createdAt: new Date(d.created_at as string).toISOString(), lastSeenAt: new Date(d.last_seen_at as string).toISOString(), thisDevice: Boolean(d.this_device) })),
  };
}

export async function updatePushSettings(db: Db, ctx: RequestContext, body: unknown, sessionToken?: string): Promise<PushSettings> {
  if (!ctx.userId) throw unauthenticated();
  const parsed = pushSettingsInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const userId = ctx.userId;
  await db.tx(async (tx) => {
    const before = (await tx.query<{ show_details: boolean }>('SELECT show_details FROM push_settings WHERE user_id = $1', [userId]))[0];
    await tx.query(
      `INSERT INTO push_settings (user_id, muted, show_details) VALUES ($1, $2::text[], $3)
       ON CONFLICT (user_id) DO UPDATE SET muted = EXCLUDED.muted, show_details = EXCLUDED.show_details, updated_at = now()`,
      [userId, [...new Set(parsed.data.muted)], parsed.data.showDetails]);
    // Details on the lock screen are a privacy choice, so the change is recorded like the others.
    if ((before?.show_details ?? false) !== parsed.data.showDetails) await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'push', $2)`, [userId, parsed.data.showDetails]);
  });
  return getPushSettings(db, ctx, sessionToken);
}

/* ---------- Sending ---------- */

const STALE_HOURS = 6;

/**
 * Pushes notifications not yet pushed. Rows are claimed in one statement (`SKIP LOCKED`), so with several servers
 * each is sent once; the push service is then called outside any transaction. Returns how many were sent.
 */
export async function dispatchPush(db: Db, provider: PushProvider, limit = 200): Promise<number> {
  // Anything left half-sent by a server that stopped is given up on rather than sent twice.
  await db.query(`UPDATE notifications SET push_state = 'failed' WHERE push_state = 'sending' AND pushed_at < now() - interval '10 minutes'`);
  await db.query(`UPDATE notifications SET push_state = 'skipped' WHERE push_state = 'pending' AND created_at < now() - make_interval(hours => $1)`, [STALE_HOURS]);
  const claimed = await db.query<{ id: string; user_id: string; category: NotificationCategory; title: string; link: unknown }>(
    `UPDATE notifications SET push_state = 'sending', pushed_at = now()
      WHERE id IN (SELECT id FROM notifications WHERE push_state = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, category, title, link`, [limit]);
  if (!claimed.length) return 0;

  const users = [...new Set(claimed.map((n) => n.user_id))];
  // Only phones whose session is still signed in, of accounts still active.
  const devices = await db.query<{ id: string; user_id: string; token: string }>(
    `SELECT d.id, d.user_id, d.token FROM push_devices d JOIN sessions s ON s.id = d.session_id JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ANY($1::uuid[]) AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.status = 'active' AND u.deleted_at IS NULL`, [users]);
  const settings = new Map((await db.query<{ user_id: string; muted: string[]; show_details: boolean }>('SELECT user_id, muted, show_details FROM push_settings WHERE user_id = ANY($1::uuid[])', [users])).map((r) => [r.user_id, r]));
  const unread = new Map((await db.query<{ user_id: string; n: string }>('SELECT user_id, count(*) AS n FROM notifications WHERE user_id = ANY($1::uuid[]) AND read_at IS NULL GROUP BY user_id', [users])).map((r) => [r.user_id, Number(r.n)]));

  const messages: { notificationId: string; deviceId: string; message: PushMessage }[] = [];
  const skipped: string[] = [];
  for (const n of claimed) {
    const mine = devices.filter((d) => d.user_id === n.user_id), s = settings.get(n.user_id);
    if (!mine.length || s?.muted.includes(n.category)) { skipped.push(n.id); continue; }
    const discreet = NOTIFICATION_CATEGORY_LABEL[n.category]?.[1] ?? 'You have a new notification.';
    for (const d of mine) {
      messages.push({ notificationId: n.id, deviceId: d.id, message: { to: d.token, title: 'Quintara', body: s?.show_details ? n.title : discreet, data: { notificationId: n.id, link: n.link ?? null }, badge: unread.get(n.user_id) ?? 1 } });
    }
  }
  if (skipped.length) await db.query(`UPDATE notifications SET push_state = 'skipped' WHERE id = ANY($1::uuid[])`, [skipped]);
  if (!messages.length) return 0;

  let tickets: PushTicket[];
  try { tickets = await provider.send(messages.map((m) => m.message)); }
  catch {
    // The push service is unreachable: try again on the next run (they are skipped once six hours old).
    await db.query(`UPDATE notifications SET push_state = 'pending' WHERE id = ANY($1::uuid[])`, [[...new Set(messages.map((m) => m.notificationId))]]);
    return 0;
  }
  const delivered = new Set<string>(), retry = new Set<string>(), gone: string[] = [];
  tickets.forEach((t, k) => {
    const m = messages[k]!;
    if (t.status === 'ok') delivered.add(m.notificationId);
    else if (t.unregistered) gone.push(m.deviceId);
    else if (t.retry) retry.add(m.notificationId);
  });
  // Not reached at all this time, on any phone: tried again on the next run. One that reached a phone is not resent.
  const again = [...retry].filter((id) => !delivered.has(id));
  if (again.length) await db.query(`UPDATE notifications SET push_state = 'pending' WHERE id = ANY($1::uuid[])`, [again]);
  if (gone.length) await db.query(`UPDATE push_devices SET disabled_at = now(), disabled_reason = 'The app is no longer registered on this phone' WHERE id = ANY($1::uuid[])`, [gone]);
  const ids = [...new Set(messages.map((m) => m.notificationId))].filter((id) => !again.includes(id));
  await db.query(`UPDATE notifications SET push_state = CASE WHEN id = ANY($2::uuid[]) THEN 'sent' ELSE 'failed' END WHERE id = ANY($1::uuid[])`, [ids, [...delivered]]);
  return delivered.size;
}

/** Staff: send a test push to their own phones, to check the set-up. */
export async function sendTestPush(db: Db, ctx: RequestContext): Promise<{ queued: boolean }> {
  if (!ctx.userId) throw unauthenticated();
  const has = (await db.query(`SELECT 1 FROM push_devices WHERE user_id = $1 AND disabled_at IS NULL`, [ctx.userId]))[0];
  if (!has) throw new HttpError(409, 'No phone is registered for push notifications. Turn them on in the Quintara app first.');
  const recent = (await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'This is a test notification from Quintara.' AND created_at > now() - interval '1 minute'`, [ctx.userId]))[0];
  if (recent) throw new HttpError(429, 'A test was sent a moment ago. Try again in a minute.');
  await db.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'membership_update', 'This is a test notification from Quintara.')`, [ctx.userId]);
  await audit(db, ctx.userId, 'push.test', 'user', ctx.userId);
  return { queued: true };
}
