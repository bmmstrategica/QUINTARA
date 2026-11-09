/** Dates where the member is: each market's city sets its time zone, so nothing assumes Cape Town. */
import type { Queryable } from './db.ts';

export interface LocalNow { today: string; zone: string; weekday: number; hour: number }

export async function marketNow(db: Queryable, marketId: string, at: Date = new Date()): Promise<LocalNow> {
  const zone = (await db.query<{ timezone: string }>('SELECT c.timezone FROM markets m JOIN cities c ON c.id = m.city_id WHERE m.id = $1', [marketId]))[0]?.timezone ?? 'UTC';
  return localNow(zone, at);
}

export function localNow(zone: string, at: Date = new Date()): LocalNow {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at).map((p) => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, zone, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!), hour: Number(parts.hour) };
}

/** The instant of a local date and time in a zone, e.g. 09:00 on 2026-10-12 in Africa/Johannesburg. */
export function zonedInstant(date: string, time: string, zone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  // The zone's offset at that moment, found by formatting the guess in the zone and measuring the difference.
  const shown = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(guess).replace(' ', 'T') + 'Z');
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime()));
}

export const addDaysIso = (iso: string, days: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
