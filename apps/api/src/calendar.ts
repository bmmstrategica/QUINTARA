/**
 * A member's calendar, connected to QÉRA by choice, so the daily brief can show the day as it really is.
 *
 * How it is kept safe:
 *  - It is opt-in. Connecting records consent; disconnecting deletes the address and every event at once.
 *  - The member gives the private calendar address their provider publishes (Google's "secret address", an
 *    iCloud public link, Outlook's ICS link). It is stored encrypted (AES-256-GCM) and never sent back to any app.
 *  - QÉRA fetches only from the provider's own calendar hosts, over HTTPS, without following redirects, with a
 *    time limit and a size limit, so an address cannot be used to make the server call anywhere else.
 *  - Only the next seven days are kept, and only the title, place and times. With "show titles" off, QÉRA keeps
 *    nothing but the busy times.
 *  - Google and Microsoft sign-in (OAuth) can replace the address later behind the same `CalendarFetcher`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CALENDAR_HOSTS, CALENDAR_PROVIDER_LABEL, calendarConnectSchema, SAMPLE_CALENDAR_WEEK } from '@quintara/domain';
import type { CalendarConnection, CalendarEvent, CalendarProvider, CalendarState } from '@quintara/domain';
import { audit, requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { HttpError, notFound, validation } from './errors.ts';
import { addDaysIso, localNow, marketNow, zonedInstant } from './time.ts';

/** Fetches a calendar file. Replaced in tests; a hosted provider's API can stand behind the same shape. */
export type CalendarFetcher = (url: URL) => Promise<string>;

const WINDOW_DAYS = 7;
const MAX_BYTES = 2_000_000;
const MAX_EVENTS = 400;
const RESYNC_MINUTES = 30;

/** The real fetcher: HTTPS to an allowed host only, no redirects, eight seconds, two megabytes. */
export const httpCalendarFetcher: CalendarFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal, headers: { accept: 'text/calendar' } });
    if (!response.ok) throw new Error(`The calendar answered ${response.status}.`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The calendar is too large to read.');
    // Read at most MAX_BYTES, so a huge or endless answer cannot fill the server's memory.
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('The calendar is too large to read.'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); }
};

/* ---------- The address, encrypted ---------- */

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();
export function sealAddress(address: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function openAddress(sealed: string, secret: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** The address as a URL QÉRA may read, or a clear reason why not. webcal:// is the same address over HTTPS. */
export function checkAddress(provider: Exclude<CalendarProvider, 'sample'>, address: string): URL {
  let url: URL;
  try { url = new URL(address.replace(/^webcals?:\/\//i, 'https://')); } catch { throw new HttpError(422, 'That does not look like a calendar address.', { address: 'Paste the full address, starting with https:// or webcal://' }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !CALENDAR_HOSTS[provider].test(url.hostname)) {
    throw new HttpError(422, `That is not a ${CALENDAR_PROVIDER_LABEL[provider]} address.`, { address: `Paste the private address from ${CALENDAR_PROVIDER_LABEL[provider]}` });
  }
  return url;
}

/* ---------- Reading an ICS calendar ---------- */

interface Parsed { uid: string; title: string; location: string; start: Date; end: Date | null; allDay: boolean }
const unescape = (text: string) => text.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function when(value: string, params: string, fallbackZone: string): { at: Date; allDay: boolean } | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || /VALUE=DATE(?!-)/i.test(params)) {
    const d = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    return d ? { at: zonedInstant(`${d[1]}-${d[2]}-${d[3]}`, '00:00', fallbackZone), allDay: true } : null;
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!t) return null;
  if (t[7]) return { at: new Date(Date.UTC(+t[1]!, +t[2]! - 1, +t[3]!, +t[4]!, +t[5]!, +t[6]!)), allDay: false };
  const zone = /TZID=([^;:]+)/i.exec(params)?.[1]?.replace(/^"|"$/g, '');
  let tz = fallbackZone;
  if (zone) { try { new Intl.DateTimeFormat('en', { timeZone: zone }); tz = zone; } catch { /* a Windows zone name: the city's own zone is the best guess */ } }
  return { at: zonedInstant(`${t[1]}-${t[2]}-${t[3]}`, `${t[4]}:${t[5]}`, tz), allDay: false };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Reads the events in a window. Handles all-day and timed events, time zones, and the common repeating rules
 * (daily and weekly, with an interval, a count, an end date and chosen weekdays). Exceptions to a repeat are skipped.
 */
export function readIcs(text: string, from: Date, to: Date, zone: string): Parsed[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out: Parsed[] = [];
  let ev: Record<string, { value: string; params: string }> | null = null;
  const exdates: string[] = [];
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; exdates.length = 0; continue; }
    if (line === 'END:VEVENT' && ev) {
      const start = ev.DTSTART && when(ev.DTSTART.value, ev.DTSTART.params, zone);
      if (start && !/CANCELLED/i.test(ev.STATUS?.value ?? '')) {
        // An all-day event without an end lasts the day.
        const end = ev.DTEND ? when(ev.DTEND.value, ev.DTEND.params, zone)?.at ?? null : start.allDay ? new Date(start.at.getTime() + 86_400_000) : null;
        const length = end ? end.getTime() - start.at.getTime() : 0;
        const base = { uid: (ev.UID?.value ?? `${start.at.toISOString()}-${ev.SUMMARY?.value ?? ''}`).slice(0, 250), title: unescape(ev.SUMMARY?.value ?? '').slice(0, 200), location: unescape(ev.LOCATION?.value ?? '').slice(0, 200), allDay: start.allDay };
        const rule = ev.RRULE?.value ? Object.fromEntries(ev.RRULE.value.split(';').map((p) => p.split('=') as [string, string])) : null;
        const push = (at: Date) => { if (at < to && new Date(at.getTime() + Math.max(length, 1)) > from && !exdates.includes(at.toISOString())) out.push({ ...base, start: at, end: length ? new Date(at.getTime() + length) : null }); };
        if (!rule || !['DAILY', 'WEEKLY'].includes(rule.FREQ ?? '')) push(start.at);
        else {
          const step = Math.max(1, Number(rule.INTERVAL ?? 1)), count = rule.COUNT ? Number(rule.COUNT) : Infinity;
          const until = rule.UNTIL ? when(rule.UNTIL.slice(0, 16), '', zone)?.at ?? to : to;
          const byDay = rule.FREQ === 'WEEKLY' && rule.BYDAY ? rule.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))) : null;
          let made = 0;
          // Without a count, an old repeating event is picked up a week before the window rather than walked from its first day.
          const skip = count === Infinity ? Math.max(0, Math.floor((from.getTime() - start.at.getTime()) / 86_400_000) - 7) : 0;
          for (let i = 0, at = new Date(start.at.getTime() + skip * 86_400_000); at <= until && at < to && made < count && i < 3000; i++, at = new Date(at.getTime() + 86_400_000)) {
            const days = Math.round((at.getTime() - start.at.getTime()) / 86_400_000);
            const weekday = new Date(localNow(zone, at).today + 'T12:00:00Z').getUTCDay();
            const fits = rule.FREQ === 'DAILY' ? days % step === 0 : Math.floor(days / 7) % step === 0 && (byDay ? byDay.includes(weekday) : days % 7 === 0);
            if (!fits) continue;
            made++;
            push(at);
          }
        }
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'EXDATE') { for (const v of m[3]!.split(',')) { const w = when(v, m[2]!, zone); if (w) exdates.push(w.at.toISOString()); } continue; }
    ev[m[1]!] = { value: m[3]!, params: m[2]! };
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_EVENTS);
}

/* ---------- The sample calendar ---------- */

/** A believable week for trying the brief: no real data, and the same for everyone. */
function sampleEvents(today: string, zone: string): Parsed[] {
  return SAMPLE_CALENDAR_WEEK.map(([day, start, end, title, location]) => {
    const date = addDaysIso(today, day);
    return { uid: `sample-${day}-${start}`, title, location, start: zonedInstant(date, start, zone), end: end ? zonedInstant(date, end, zone) : null, allDay: false };
  });
}

/* ---------- Connecting, reading and disconnecting ---------- */

const toConnection = (row: Row): CalendarConnection => ({
  provider: row.provider as CalendarProvider, label: row.label as string, showTitles: Boolean(row.show_titles),
  connectedAt: new Date(row.connected_at as string).toISOString(), syncedAt: row.synced_at ? new Date(row.synced_at as string).toISOString() : null, syncError: (row.sync_error as string | null) ?? null,
});
const toEvent = (row: Row): CalendarEvent => ({
  id: `${row.uid as string}@${new Date(row.starts_at as string).toISOString()}`, title: row.title as string, location: row.location as string,
  startsAt: new Date(row.starts_at as string).toISOString(), endsAt: row.ends_at ? new Date(row.ends_at as string).toISOString() : null, allDay: Boolean(row.all_day),
});

/** Today's and the coming week's events for a member, as kept. */
export async function calendarEvents(db: Queryable, userId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  return (await db.query('SELECT * FROM calendar_events WHERE user_id = $1 AND starts_at < $3 AND COALESCE(ends_at, starts_at) >= $2 ORDER BY starts_at, title', [userId, from.toISOString(), to.toISOString()])).map(toEvent);
}

export async function getCalendar(db: Queryable, ctx: RequestContext): Promise<CalendarState> {
  const session = requireMember(ctx, 'qera.use');
  const row = (await db.query('SELECT * FROM calendar_connections WHERE user_id = $1', [session.userId]))[0];
  if (!row) return { connection: null, events: [] };
  const now = new Date();
  return { connection: toConnection(row), events: await calendarEvents(db, session.userId, new Date(now.getTime() - 12 * 3_600_000), new Date(now.getTime() + WINDOW_DAYS * 86_400_000)) };
}

export interface CalendarConfig { fetcher: CalendarFetcher; secret: string | null; allowSample: boolean }

/** Reads a member's calendar and replaces what is kept for the next week. */
async function sync(db: Db, cfg: CalendarConfig, userId: string, row: { provider: string; address_secret: string | null; show_titles: boolean }, zone: string): Promise<number> {
  const now = new Date(), { today } = localNow(zone, now);
  const from = zonedInstant(today, '00:00', zone), to = new Date(from.getTime() + (WINDOW_DAYS + 1) * 86_400_000);
  let events: Parsed[];
  if (row.provider === 'sample') events = sampleEvents(today, zone);
  else {
    if (!cfg.secret || !row.address_secret) throw new HttpError(503, 'Calendar connection is not set up on this server.');
    const url = checkAddress(row.provider as Exclude<CalendarProvider, 'sample'>, openAddress(row.address_secret, cfg.secret));
    events = readIcs(await cfg.fetcher(url), from, to, zone);
  }
  await db.tx(async (tx) => {
    await tx.query('DELETE FROM calendar_events WHERE user_id = $1', [userId]);
    for (const e of events) {
      // With titles off, only the busy time is kept: nothing about what the meeting is or where.
      await tx.query('INSERT INTO calendar_events (user_id, uid, starts_at, ends_at, all_day, title, location) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
        [userId, e.uid, e.start.toISOString(), e.end?.toISOString() ?? null, e.allDay, row.show_titles ? e.title : '', row.show_titles ? e.location : '']);
    }
    await tx.query('UPDATE calendar_connections SET synced_at = now(), sync_error = NULL WHERE user_id = $1', [userId]);
  });
  return events.length;
}

export async function connectCalendar(db: Db, ctx: RequestContext, cfg: CalendarConfig, body: unknown): Promise<CalendarState> {
  const session = requireMember(ctx, 'qera.use');
  const parsed = calendarConnectSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  let sealed: string | null = null, label: string = CALENDAR_PROVIDER_LABEL[d.provider];
  if (d.provider === 'sample') {
    if (!cfg.allowSample) throw new HttpError(422, 'The sample calendar is for trying Quintara in development.');
  } else {
    const url = checkAddress(d.provider, d.address);
    if (!cfg.secret) throw new HttpError(503, 'Calendar connection is not set up on this server yet.');
    // Read it once before keeping anything, so a wrong address is caught now rather than tomorrow morning.
    try { readIcs(await cfg.fetcher(url), new Date(), new Date(Date.now() + 86_400_000), 'UTC'); } catch (error) {
      throw new HttpError(422, 'QÉRA could not read that calendar. Check the address, and that it is the private or public address, not the page you view it on.', { address: error instanceof HttpError ? error.message : 'Could not read this calendar' });
    }
    sealed = sealAddress(url.toString(), cfg.secret);
    label = `${CALENDAR_PROVIDER_LABEL[d.provider]}`;
  }
  const { zone } = await marketNow(db, session.marketId);
  await db.tx(async (tx) => {
    await tx.query(`INSERT INTO calendar_connections (user_id, provider, label, address_secret, show_titles) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET provider = $2, label = $3, address_secret = $4, show_titles = $5, connected_at = now(), synced_at = NULL, sync_error = NULL`, [session.userId, d.provider, label, sealed, d.showTitles]);
    await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'calendar', true)`, [session.userId]);
    await audit(tx, session.userId, 'calendar.connected', 'user', session.userId, { provider: d.provider, showTitles: d.showTitles });
  });
  await sync(db, cfg, session.userId, { provider: d.provider, address_secret: sealed, show_titles: d.showTitles }, zone);
  return getCalendar(db, ctx);
}

export async function updateCalendar(db: Db, ctx: RequestContext, cfg: CalendarConfig, body: unknown): Promise<CalendarState> {
  const session = requireMember(ctx, 'qera.use');
  const showTitles = (body as { showTitles?: unknown } | null)?.showTitles;
  if (typeof showTitles !== 'boolean') throw new HttpError(422, 'Say whether QÉRA may see what your meetings are.');
  const row = (await db.query<{ provider: string; address_secret: string | null; show_titles: boolean }>('UPDATE calendar_connections SET show_titles = $2 WHERE user_id = $1 RETURNING provider, address_secret, show_titles', [session.userId, showTitles]))[0];
  if (!row) throw notFound('No calendar is connected.');
  await audit(db, session.userId, 'calendar.updated', 'user', session.userId, { showTitles });
  await syncOne(db, cfg, session.userId, row, session.marketId);
  return getCalendar(db, ctx);
}

export async function syncCalendarNow(db: Db, ctx: RequestContext, cfg: CalendarConfig): Promise<CalendarState> {
  const session = requireMember(ctx, 'qera.use');
  const row = (await db.query<{ provider: string; address_secret: string | null; show_titles: boolean }>('SELECT provider, address_secret, show_titles FROM calendar_connections WHERE user_id = $1', [session.userId]))[0];
  if (!row) throw notFound('No calendar is connected.');
  await syncOne(db, cfg, session.userId, row, session.marketId);
  return getCalendar(db, ctx);
}

/** Syncs, and keeps a short, safe note of what went wrong instead of failing the request. */
async function syncOne(db: Db, cfg: CalendarConfig, userId: string, row: { provider: string; address_secret: string | null; show_titles: boolean }, marketId: string): Promise<void> {
  const { zone } = await marketNow(db, marketId);
  try { await sync(db, cfg, userId, row, zone); } catch (error) {
    await db.query('UPDATE calendar_connections SET sync_error = $2 WHERE user_id = $1', [userId, error instanceof HttpError ? error.message : 'Your calendar could not be read just now. QÉRA will try again.']);
  }
}

/** Disconnects: the address and every event are deleted at once. */
export async function disconnectCalendar(db: Db, ctx: RequestContext): Promise<void> {
  const session = requireMember(ctx, 'qera.use');
  await db.tx(async (tx) => {
    const gone = await tx.query('DELETE FROM calendar_connections WHERE user_id = $1 RETURNING user_id', [session.userId]);
    await tx.query('DELETE FROM calendar_events WHERE user_id = $1', [session.userId]);
    if (gone[0]) {
      await tx.query(`INSERT INTO consent_events (user_id, consent_key, granted) VALUES ($1, 'calendar', false)`, [session.userId]);
      await audit(tx, session.userId, 'calendar.disconnected', 'user', session.userId);
    }
  });
}

/** Run from the housekeeping loop: refreshes calendars not read in the last half hour. */
export async function syncDueCalendars(db: Db, cfg: CalendarConfig): Promise<number> {
  const due = await db.query<{ user_id: string; provider: string; address_secret: string | null; show_titles: boolean; market_id: string }>(
    `SELECT c.user_id, c.provider, c.address_secret, c.show_titles, m.home_market_id AS market_id FROM calendar_connections c JOIN members m ON m.user_id = c.user_id AND m.status = 'active'
      WHERE c.synced_at IS NULL OR c.synced_at < now() - make_interval(mins => $1) LIMIT 50`, [RESYNC_MINUTES]);
  for (const row of due) await syncOne(db, cfg, row.user_id, row, row.market_id);
  return due.length;
}
