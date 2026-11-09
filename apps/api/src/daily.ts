/**
 * QÉRA's daily brief: the member's morning. Their day in order (their own calendar, if they have connected it,
 * alongside what Quintara has booked and the reminders they set), what lies ahead this week, what is waiting on
 * them, and one suggestion, made only when it fits the day.
 */
import { BOOKING_STATUS_LABEL, formatDateTime, formatMoney, longDay } from '@quintara/domain';
import type { BriefItem, DailyBrief, DailyItem } from '@quintara/domain';
import { calendarEvents } from './calendar.ts';
import { memoryItems, nextOccurrence } from './chief.ts';
import { requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { listBookings, listExperiences } from './experiences.ts';
import { listMyServiceRequests } from './lifestyle.ts';
import { bookingWhen, listMyPartnerBookings } from './partner-bookings.ts';
import { addDaysIso, localNow, marketNow, zonedInstant } from './time.ts';

const iso = (value: unknown) => new Date(value as string).toISOString();
const hm = (instant: string, zone: string) => formatDateTime(instant, zone).time;
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
const count = (n: number) => ['nothing', 'one thing', 'two things', 'three things', 'four things', 'five things', 'six things'][n] ?? `${n} things`;
const live = (status: string) => !['cancelled', 'declined', 'completed'].includes(status);

export async function getDailyBrief(db: Db, ctx: RequestContext, at: Date = new Date()): Promise<DailyBrief> {
  const session = requireMember(ctx, 'qera.use');
  const now = await marketNow(db, session.marketId, at), zone = now.zone;
  const dayStart = zonedInstant(now.today, '00:00', zone), dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const localDay = (instant: string) => localNow(zone, new Date(instant)).today;
  const [bookings, partnerBookings, requests, memory, reminders, connection, events, settings, experiences, city] = await Promise.all([
    listBookings(db, ctx), listMyPartnerBookings(db, ctx), listMyServiceRequests(db, ctx), memoryItems(db, session.userId),
    db.query(`SELECT * FROM qera_reminders WHERE user_id = $1 AND status = 'scheduled' AND remind_at >= $2 AND remind_at < $3 ORDER BY remind_at`, [session.userId, dayStart.toISOString(), dayEnd.toISOString()]),
    db.query<{ label: string; synced_at: unknown; show_titles: boolean }>('SELECT label, synced_at, show_titles FROM calendar_connections WHERE user_id = $1', [session.userId]),
    calendarEvents(db, session.userId, dayStart, dayEnd),
    db.query<{ daily_brief: boolean | null }>('SELECT daily_brief FROM privacy_settings WHERE user_id = $1', [session.userId]),
    listExperiences(db, ctx),
    db.query<{ name: string }>('SELECT name FROM markets WHERE id = $1', [ctx.marketId]),
  ]);

  const agenda: DailyItem[] = [
    ...events.map((e): DailyItem => ({
      time: e.allDay ? null : hm(e.startsAt, zone), endTime: e.allDay || !e.endsAt ? null : hm(e.endsAt, zone),
      title: e.title || 'Busy', detail: [e.allDay ? 'All day' : '', e.location].filter(Boolean).join('. '), source: 'calendar', link: null,
    })),
    ...bookings.filter((b) => live(b.status) && b.status !== 'waitlisted' && localDay(b.startsAt) === now.today).map((b): DailyItem => ({
      time: hm(b.startsAt, b.timezone), endTime: null, title: b.experienceTitle, detail: `${b.venueName}, ${b.area}. ${b.seats} seat${b.seats > 1 ? 's' : ''}, ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.`, source: 'quintara', link: { kind: 'bookings' },
    })),
    ...partnerBookings.filter((b) => live(b.status) && b.date === now.today).map((b): DailyItem => ({
      time: b.time, endTime: null, title: b.partnerName, detail: `For ${b.partySize}. ${b.status === 'confirmed' ? 'Confirmed' : 'Waiting for the partner to confirm'}.`, source: 'quintara', link: { kind: 'qera' },
    })),
    ...requests.filter((r) => live(r.status) && r.preferredDate === now.today).map((r): DailyItem => ({
      time: null, endTime: null, title: r.serviceName, detail: `${r.packageName ?? 'Arranged by Quintara'}. ${r.status === 'confirmed' ? 'Confirmed' : 'Being arranged'}.`, source: 'quintara', link: null,
    })),
    ...reminders.map((row): DailyItem => ({ time: hm(iso(row.remind_at), zone), endTime: null, title: row.text as string, detail: 'A reminder you asked for.', source: 'reminder', link: { kind: 'qera' } })),
  ].sort((a, b) => (a.time ?? '00:00').localeCompare(b.time ?? '00:00'));

  const tomorrow = addDaysIso(now.today, 1), weekEnd = addDaysIso(now.today, 7);
  const ahead: BriefItem[] = [
    ...bookings.filter((b) => ['confirmed', 'awaiting_payment', 'applied'].includes(b.status) && localDay(b.startsAt) >= tomorrow && localDay(b.startsAt) <= weekEnd)
      .map((b) => ({ title: b.experienceTitle, detail: `${longDay(localDay(b.startsAt))}, ${hm(b.startsAt, b.timezone)}. ${b.area}.`, link: { kind: 'bookings' as const } })),
    ...partnerBookings.filter((b) => live(b.status) && b.date >= tomorrow && b.date <= weekEnd)
      .map((b) => ({ title: b.partnerName, detail: `${bookingWhen(b)}, for ${b.partySize}.`, link: { kind: 'qera' as const } })),
    ...memory.filter((m) => m.kind === 'date' && m.date).map((m) => ({ m, next: nextOccurrence(m.date!, now.today) })).filter(({ next }) => daysBetween(now.today, next) <= 14)
      .map(({ m, next }) => { const n = daysBetween(now.today, next); return { title: m.label, detail: `${n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${longDay(next)}, in ${n} days`}. Shall I plan something?`, link: { kind: 'qera' as const } }; }),
  ];
  const waiting: BriefItem[] = bookings.filter((b) => b.status === 'awaiting_payment').map((b) => ({ title: b.experienceTitle, detail: `Pay ${formatMoney(b.amountDueMinor, b.currency)} to keep your seats.`, link: { kind: 'bookings' as const } }));

  // One suggestion, made only when it fits the day: a free evening, or something worth booking soon.
  const busyEvening = agenda.some((i) => i.time !== null && i.time >= '17:30');
  const booked = new Set(bookings.filter((b) => live(b.status)).map((b) => b.experienceId));
  const soon = experiences.filter((e) => e.startsAt && !booked.has(e.id) && localDay(e.startsAt) >= now.today && daysBetween(now.today, localDay(e.startsAt)) <= 14
    && (e.capacity ?? 0) > (e.seatsTaken ?? 0) && !(e.admission === 'invitation_only' && !e.invited));
  const tonight = soon.find((e) => localDay(e.startsAt!) === now.today && hm(e.startsAt!, e.timezone) >= '17:00');
  const favourite = memory.find((m) => m.kind === 'favourite')?.label;
  const suggestion: BriefItem | null = !busyEvening && tonight
    ? { title: `Tonight: ${tonight.title}`, detail: `Your evening is free, and there are seats at ${tonight.title}, ${hm(tonight.startsAt!, tonight.timezone)} in ${tonight.area}. Shall I reserve two?`, link: { kind: 'experience', id: tonight.id } }
    : !busyEvening && now.hour < 17
      ? { title: 'Your evening is free', detail: favourite ? `Shall I ask ${favourite} for a table tonight? Tell me the time and how many.` : 'Shall I find you a table tonight? Tell me the time and how many, and I will book one of Quintara’s partners.', link: { kind: 'qera' } }
      : soon[0] ? { title: soon[0].title, detail: `${longDay(localDay(soon[0].startsAt!))}, ${hm(soon[0].startsAt!, soon[0].timezone)}. ${soon[0].category}, ${soon[0].area}. Seats are open.`, link: { kind: 'experience', id: soon[0].id } } : null;

  const first = session.fullName.split(' ')[0];
  const timed = agenda.filter((i) => i.time);
  const summary = agenda.length
    ? `You have ${count(agenda.length)} today${timed[0] ? `, the first at ${timed[0].time}` : ''}.${busyEvening ? '' : ' Your evening is free.'}`
    : 'Your day is clear.';
  const c = connection[0];
  return {
    date: now.today, dateLabel: longDay(now.today),
    greeting: `${now.hour < 12 ? 'Good morning' : now.hour < 17 ? 'Good afternoon' : 'Good evening'}, ${first}.`,
    summary, city: city[0]?.name ?? '', agenda, ahead, waiting, suggestion,
    calendar: { connected: Boolean(c), label: c?.label ?? null, syncedAt: c?.synced_at ? iso(c.synced_at) : null, showTitles: c?.show_titles ?? true },
    enabled: settings[0]?.daily_brief ?? true,
  };
}

/** The line of the morning notification: "Your day: three things, the first at 09:00." */
export function dailyLine(brief: DailyBrief): string {
  return `${brief.greeting} ${brief.summary} Your daily brief is ready.`;
}
