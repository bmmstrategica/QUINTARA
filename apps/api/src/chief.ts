/**
 * QÉRA as the member's Chief of Staff: what it remembers, the reminders it keeps, the weekly brief, the things it
 * tells a member of its own accord, and booking a whole prepared plan at once.
 *
 * The rules:
 *  - Memory is written only by the member, or by QÉRA after the member has confirmed. QÉRA may notice things (a
 *    partner booked twice) and offer them as suggestions, but nothing is kept until the member adds it. Every
 *    item can be changed or removed, and all of it is in the data export and erased with the account.
 *  - The audit trail records that memory changed, never what it says.
 *  - Booking a plan runs each line through the same functions the member's own taps use, so every permission,
 *    capacity, notice-period and duplicate rule applies again, line by line. Nothing is paid: seats that need
 *    paying for are held, and the member pays under Bookings.
 */
import { bookingOffer, BOOKING_STATUS_LABEL, can, earliestDate, formatDateTime, formatMoney, leadTimeLabel, longDay, packagePriceLabel, planBookingInputSchema, qeraMemoryInputSchema, reminderInputSchema } from '@quintara/domain';
import type { BriefItem, BriefSection, ItineraryContent, PlanBookingPreview, PlanBookingResult, PlanLine, QeraMemory, QeraMemoryItem, QeraMemorySuggestion, QeraReminder, WeeklyBrief } from '@quintara/domain';
import { audit, requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { bookExperience, getExperience, listBookings, listExperiences } from './experiences.ts';
import { listMyServiceRequests, listServices, requestService } from './lifestyle.ts';
import { getMyProfile } from './members.ts';
import { bookablePartner, bookingWhen, createPartnerBooking, getDocument, listMyPartnerBookings } from './partner-bookings.ts';
import { listUpdates } from './relationship.ts';
import { addDaysIso, localNow, marketNow, zonedInstant } from './time.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MEMORY = 60, MAX_REMINDERS = 50;
const iso = (value: unknown) => new Date(value as string).toISOString();
const day = (value: unknown) => (value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null);
const words = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3);

/* ---------- Memory ---------- */

const toItem = (row: Row): QeraMemoryItem => ({ id: row.id as string, kind: row.kind as QeraMemoryItem['kind'], label: row.label as string, detail: row.detail as string, date: day(row.on_date), source: row.source as QeraMemoryItem['source'], updatedAt: iso(row.updated_at) });

export async function memoryItems(db: Queryable, userId: string): Promise<QeraMemoryItem[]> {
  return (await db.query('SELECT * FROM qera_memory WHERE user_id = $1 ORDER BY kind, created_at', [userId])).map(toItem);
}

export async function getMemory(db: Queryable, ctx: RequestContext): Promise<QeraMemory> {
  const session = requireMember(ctx, 'qera.use');
  const items = await memoryItems(db, session.userId);
  const known = new Set(items.map((i) => i.label.toLowerCase()));
  // Suggestions are worked out each time from the member's own bookings, and never stored.
  const suggestions: QeraMemorySuggestion[] = [];
  const partners = await db.query<{ name: string; n: string }>(`SELECT p.name, count(*) AS n FROM partner_bookings b JOIN partners p ON p.id = b.partner_id WHERE b.member_id = $1 AND b.status IN ('requested', 'confirmed') GROUP BY p.name ORDER BY count(*) DESC LIMIT 3`, [session.memberId]);
  for (const p of partners) if (!known.has(p.name.toLowerCase())) suggestions.push({ kind: 'favourite', label: p.name, detail: '', reason: `You have booked ${p.name} ${Number(p.n) === 1 ? 'once' : `${p.n} times`} through QÉRA.` });
  const services = await db.query<{ name: string; n: string }>(`SELECT s.name, count(*) AS n FROM service_requests r JOIN lifestyle_services s ON s.id = r.service_id WHERE r.member_id = $1 AND r.status <> 'cancelled' GROUP BY s.name ORDER BY count(*) DESC LIMIT 2`, [session.memberId]);
  for (const x of services) if (!known.has(x.name.toLowerCase())) suggestions.push({ kind: 'favourite', label: x.name, detail: '', reason: `You have asked for ${x.name} ${Number(x.n) === 1 ? 'before' : `${x.n} times`}.` });
  const kinds = await db.query<{ category: string; n: string }>(`SELECT e.category, count(*) AS n FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.member_id = $1 AND b.status IN ('confirmed', 'attended') GROUP BY e.category HAVING count(*) >= 1 ORDER BY count(*) DESC LIMIT 2`, [session.memberId]);
  for (const k of kinds) if (!known.has(k.category.toLowerCase())) suggestions.push({ kind: 'likes', label: k.category, detail: '', reason: `You have booked ${k.category.toLowerCase()} experiences.` });
  return { items, suggestions: suggestions.slice(0, 5) };
}

export async function addMemory(db: Db, ctx: RequestContext, body: unknown, source: 'member' | 'qera' = 'member'): Promise<QeraMemoryItem> {
  const session = requireMember(ctx, 'profile.edit');
  const parsed = qeraMemoryInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const count = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM qera_memory WHERE user_id = $1', [session.userId]))[0]!.n);
  if (count >= MAX_MEMORY) throw conflict('QÉRA remembers up to sixty things. Remove one before adding another.');
  if ((await db.query('SELECT 1 FROM qera_memory WHERE user_id = $1 AND kind = $2 AND lower(label) = lower($3)', [session.userId, d.kind, d.label]))[0]) throw conflict('QÉRA already remembers that.');
  const row = (await db.query('INSERT INTO qera_memory (user_id, kind, label, detail, on_date, source) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [session.userId, d.kind, d.label, d.detail, d.kind === 'date' ? d.date : null, source]))[0]!;
  await audit(db, session.userId, 'qera.memory_added', 'qera_memory', row.id as string, { kind: d.kind, source });
  return toItem(row);
}

export async function updateMemory(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<QeraMemoryItem> {
  const session = requireMember(ctx, 'profile.edit');
  const parsed = qeraMemoryInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const row = UUID.test(id) ? (await db.query('UPDATE qera_memory SET kind = $3, label = $4, detail = $5, on_date = $6, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [id, session.userId, d.kind, d.label, d.detail, d.kind === 'date' ? d.date : null]))[0] : undefined;
  if (!row) throw notFound('QÉRA does not remember that.');
  await audit(db, session.userId, 'qera.memory_changed', 'qera_memory', id, { kind: d.kind });
  return toItem(row);
}

export async function deleteMemory(db: Db, ctx: RequestContext, id: string): Promise<QeraMemoryItem> {
  const session = requireMember(ctx, 'profile.edit');
  const row = UUID.test(id) ? (await db.query('DELETE FROM qera_memory WHERE id = $1 AND user_id = $2 RETURNING *', [id, session.userId]))[0] : undefined;
  if (!row) throw notFound('QÉRA does not remember that.');
  await audit(db, session.userId, 'qera.memory_forgotten', 'qera_memory', id, { kind: row.kind });
  return toItem(row);
}

export async function clearMemory(db: Db, ctx: RequestContext): Promise<void> {
  const session = requireMember(ctx, 'profile.edit');
  await db.query('DELETE FROM qera_memory WHERE user_id = $1', [session.userId]);
  await audit(db, session.userId, 'qera.memory_cleared', 'user', session.userId);
}

/* ---------- Reminders ---------- */

const toReminder = (row: Row): QeraReminder => ({ id: row.id as string, text: row.text as string, remindAt: iso(row.remind_at), status: row.status as QeraReminder['status'], source: row.source as QeraReminder['source'] });

export async function listReminders(db: Queryable, ctx: RequestContext): Promise<QeraReminder[]> {
  const session = requireMember(ctx, 'qera.use');
  return (await db.query(`SELECT * FROM qera_reminders WHERE user_id = $1 AND (status = 'scheduled' OR (status = 'sent' AND sent_at > now() - interval '14 days')) ORDER BY remind_at`, [session.userId])).map(toReminder);
}

export async function createReminder(db: Db, ctx: RequestContext, body: unknown, source: 'member' | 'qera' = 'member'): Promise<QeraReminder> {
  const session = requireMember(ctx, 'qera.use');
  const parsed = reminderInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const { zone } = await marketNow(db, session.marketId);
  const at = zonedInstant(parsed.data.date, parsed.data.time, zone);
  if (at.getTime() < Date.now() + 60_000) throw new HttpError(422, 'Choose a time in the future.', { date: 'Choose a time in the future' });
  if (Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM qera_reminders WHERE user_id = $1 AND status = 'scheduled'`, [session.userId]))[0]!.n) >= MAX_REMINDERS) throw conflict('You have fifty reminders waiting. Cancel one before adding another.');
  const row = (await db.query('INSERT INTO qera_reminders (user_id, text, remind_at, source) VALUES ($1, $2, $3, $4) RETURNING *', [session.userId, parsed.data.text, at.toISOString(), source]))[0]!;
  await audit(db, session.userId, 'qera.reminder_set', 'qera_reminder', row.id as string, { source });
  return toReminder(row);
}

export async function cancelReminder(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'qera.use');
  const rows = UUID.test(id) ? await db.query(`UPDATE qera_reminders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING id`, [id, session.userId]) : [];
  if (!rows[0]) throw notFound('This reminder is not waiting.');
}

/** "Saturday 10 October, 19:00" in the member's own time zone. */
export const reminderWhen = (at: string, zone: string) => { const d = formatDateTime(at, zone); return `${d.long}, ${d.time}`; };

/* ---------- The weekly brief ---------- */

/** The next time a remembered date comes round, on or after today. */
export function nextOccurrence(date: string, today: string): string {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const candidate = `${y}${date.slice(4)}`;
    // 29 February falls on 1 March in other years.
    const real = new Date(`${candidate}T12:00:00Z`).toISOString().slice(0, 10);
    if (real >= today) return real;
  }
  return `${year + 1}${date.slice(4)}`;
}
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);

export async function getWeeklyBrief(db: Db, ctx: RequestContext, at: Date = new Date()): Promise<WeeklyBrief> {
  const session = requireMember(ctx, 'qera.use');
  const now = await marketNow(db, session.marketId, at);
  const weekOf = addDaysIso(now.today, -((now.weekday + 6) % 7)), until = addDaysIso(now.today, 7);
  const localDay = (instant: string) => localNow(now.zone, new Date(instant)).today;
  const [experiences, bookings, partnerBookings, requests, memory, reminders, profile, services, updates, settings] = await Promise.all([
    listExperiences(db, ctx), listBookings(db, ctx), listMyPartnerBookings(db, ctx), listMyServiceRequests(db, ctx), memoryItems(db, session.userId),
    db.query(`SELECT * FROM qera_reminders WHERE user_id = $1 AND status = 'scheduled' AND remind_at < $2 ORDER BY remind_at`, [session.userId, new Date(at.getTime() + 7 * 86_400_000).toISOString()]),
    getMyProfile(db, ctx), listServices(db, ctx.marketId), can({ roles: ctx.roles }, 'business.view') ? listUpdates(db, ctx) : Promise.resolve([]),
    db.query<{ weekly_brief: boolean | null }>('SELECT weekly_brief FROM privacy_settings WHERE user_id = $1', [session.userId]),
  ]);
  const when = (iso: string, zone: string) => { const d = formatDateTime(iso, zone); return `${d.long}, ${d.time}`; };

  const week: BriefItem[] = [
    ...bookings.filter((b) => ['confirmed', 'awaiting_payment', 'applied', 'waitlisted'].includes(b.status) && localDay(b.startsAt) >= now.today && localDay(b.startsAt) < until)
      .map((b) => ({ title: b.experienceTitle, detail: `${when(b.startsAt, b.timezone)}. ${b.seats} seat${b.seats > 1 ? 's' : ''}, ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.`, link: { kind: 'bookings' as const } })),
    ...partnerBookings.filter((b) => ['requested', 'confirmed'].includes(b.status) && b.date >= now.today && b.date < until)
      .map((b) => ({ title: b.partnerName, detail: `${bookingWhen(b)}, for ${b.partySize}. ${b.status === 'confirmed' ? 'Confirmed' : 'Waiting for the partner'}.`, link: { kind: 'qera' as const } })),
    ...requests.filter((r) => r.preferredDate && r.preferredDate >= now.today && r.preferredDate < until && !['cancelled', 'completed'].includes(r.status))
      .map((r) => ({ title: r.serviceName, detail: `${longDay(r.preferredDate!)}${r.packageName ? `. ${r.packageName}` : ''}. ${r.status === 'confirmed' ? 'Confirmed' : 'Being arranged'}.`, link: null })),
    ...reminders.map((row) => ({ title: `Reminder: ${row.text as string}`, detail: reminderWhen(iso(row.remind_at), now.zone), link: { kind: 'qera' as const } })),
  ];
  const dates: BriefItem[] = memory.filter((m) => m.kind === 'date' && m.date).map((m) => ({ m, next: nextOccurrence(m.date!, now.today) })).filter(({ next }) => daysBetween(now.today, next) <= 30)
    .sort((a, b) => a.next.localeCompare(b.next))
    .map(({ m, next }) => { const n = daysBetween(now.today, next); return { title: m.label, detail: `${longDay(next)}, ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}. Shall I plan something?`, link: { kind: 'qera' as const } }; });
  const waiting: BriefItem[] = bookings.filter((b) => b.status === 'awaiting_payment').map((b) => ({ title: b.experienceTitle, detail: `Pay ${formatMoney(b.amountDueMinor, b.currency)} to keep your seats.`, link: { kind: 'bookings' as const } }));
  const likes = [...profile.interests, ...memory.filter((m) => ['likes', 'favourite'].includes(m.kind)).map((m) => m.label)].flatMap(words);
  const fits = (text: string) => { const w = new Set(words(text)); return likes.filter((l) => w.has(l)).length; };
  const booked = new Set(bookings.filter((b) => !['cancelled', 'declined'].includes(b.status)).map((b) => b.experienceId));
  const chosen: BriefItem[] = experiences.filter((e) => !booked.has(e.id) && e.startsAt && localDay(e.startsAt) >= now.today && daysBetween(now.today, localDay(e.startsAt)) <= 60 && (e.capacity ?? 0) > (e.seatsTaken ?? 0) && !(e.admission === 'invitation_only' && !e.invited))
    .map((e, i) => ({ e, score: fits(`${e.title} ${e.category} ${e.summary}`) * 10 - i })).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(({ e }) => ({ title: e.title, detail: `${e.category}. ${when(e.startsAt!, e.timezone)}, ${e.area}.`, link: { kind: 'experience' as const, id: e.id } }));
  const service = [...services].filter((x) => x.packages.length).sort((a, b) => fits(`${b.name} ${b.category} ${b.description}`) - fits(`${a.name} ${a.category} ${a.description}`))[0];
  const recent = updates.find((u) => daysBetween(u.publishedAt.slice(0, 10), now.today) <= 21);
  const worth: BriefItem[] = [
    ...(service ? [{ title: service.name, detail: `${service.packages[0]!.name}: ${packagePriceLabel(service.packages[0]!)}, ${leadTimeLabel(service.packages[0]!.leadTimeHours).toLowerCase()}.`, link: { kind: 'service' as const, id: service.id } }] : []),
    ...(recent ? [{ title: recent.title, detail: 'A new opportunity under Business.', link: { kind: 'business' as const } }] : []),
  ];
  const sections: BriefSection[] = [
    { key: 'week', title: 'Your week', items: week },
    { key: 'dates', title: 'Coming up', items: dates },
    { key: 'waiting', title: 'Waiting on you', items: waiting },
    { key: 'chosen', title: 'Chosen for you', items: chosen },
    { key: 'worth', title: 'Worth a look', items: worth },
  ];
  const first = session.fullName.split(' ')[0];
  const greeting = `${now.hour < 12 ? 'Good morning' : now.hour < 17 ? 'Good afternoon' : 'Good evening'}, ${first}. ${week.length ? `You have ${week.length} thing${week.length > 1 ? 's' : ''} this week.` : 'Your week is clear.'}`;
  return { weekOf, greeting, sections, enabled: settings[0]?.weekly_brief ?? true };
}

/* ---------- Booking a whole plan ---------- */

interface PlannedLine { line: PlanLine; date: string; time: string | null; ref: { kind: 'experience' | 'partner' | 'service'; id: string }; packageId: string | null; dining: boolean; seats: number }

async function planLines(db: Db, ctx: RequestContext, content: ItineraryContent, booked: Record<string, string>, partySize: number): Promise<PlannedLine[]> {
  const session = requireMember(ctx, 'qera.use');
  const { today } = await marketNow(db, session.marketId);
  const services = await listServices(db, ctx.marketId);
  const mine = await listBookings(db, ctx);
  const out: PlannedLine[] = [];
  let index = -1;
  for (const d of content.days) {
    for (const item of d.items) {
      index++;
      if (!item.ref) continue;
      const base = { index, day: longDay(d.date), time: item.time, title: item.title, kind: item.ref.kind, status: booked[String(index)] ?? null };
      const time = /^[0-2]\d:[0-5]\d$/.test(item.time) ? item.time : null;
      let action = '', cost: string | null = null, bookable = true, packageId: string | null = null, seats = partySize;
      try {
        if (d.date < today) { bookable = false; action = 'This date has passed.'; }
        else if (item.ref.kind === 'experience') {
          const e = await getExperience(db, ctx, item.ref.id);
          seats = Math.min(partySize, e.maxSeatsPerBooking);
          const offer = bookingOffer(e, session), s = `${seats} seat${seats > 1 ? 's' : ''}`;
          if (mine.some((b) => b.experienceId === e.id && !['cancelled', 'declined'].includes(b.status))) { bookable = false; action = 'You already have a booking for this experience.'; }
          else if (offer === 'invitation_needed') { bookable = false; action = 'This experience is by invitation.'; }
          else {
            action = offer === 'apply' ? `Apply for ${s}; the team confirms places.` : offer === 'waitlist' ? `Join the waitlist for ${s}.` : offer === 'rsvp' ? `RSVP for ${s}.` : `Reserve ${s}. They are held while you pay under Bookings.`;
            cost = e.memberPriceMinor && offer === 'reserve' ? formatMoney(e.memberPriceMinor * seats, e.currency) : offer === 'reserve' || offer === 'rsvp' ? 'Complimentary' : null;
            if (seats < partySize) action += ` This experience allows up to ${e.maxSeatsPerBooking} per booking.`;
          }
        } else if (item.ref.kind === 'partner') {
          const p = await bookablePartner(db, ctx, item.ref.id);
          action = `Ask ${p.name} for ${time ? `${time} on ` : ''}${longDay(d.date)}, for ${partySize}. They confirm or decline.`;
        } else {
          const x = services.find((s) => s.id === item.ref!.id);
          if (!x) { bookable = false; action = 'This service is no longer offered.'; }
          else {
            const pkg = x.packages[0] ?? null;
            packageId = pkg?.id ?? null;
            if (pkg && d.date < earliestDate(pkg.leadTimeHours, today)) { bookable = false; action = `${pkg.name} needs ${leadTimeLabel(pkg.leadTimeHours)}. The earliest date is ${longDay(earliestDate(pkg.leadTimeHours, today))}.`; }
            else { action = `Ask for ${x.name}${pkg ? `, ${pkg.name}` : ''}, on ${longDay(d.date)}. The desk arranges it and confirms.`; cost = pkg ? `${packagePriceLabel(pkg)} (indicative)` : null; }
          }
        }
      } catch (error) {
        bookable = false; action = error instanceof HttpError ? error.message : 'This line cannot be booked.';
      }
      if (base.status) bookable = false;
      out.push({ line: { ...base, action, cost, bookable }, date: d.date, time, ref: item.ref, packageId, dining: /dinner|lunch|chef|culinary|table/i.test(`${item.title} ${item.detail}`), seats });
    }
  }
  return out;
}

async function planDocument(db: Queryable, ctx: RequestContext, documentId: string) {
  const session = requireMember(ctx, 'qera.use');
  const id = documentId === 'latest' ? ((await db.query<{ id: string }>('SELECT id FROM qera_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [session.userId]))[0]?.id ?? '') : documentId;
  if (!id) throw notFound('There is no plan to book yet. Ask me to prepare one first.');
  return getDocument(db, ctx, id);
}

export async function previewPlanBooking(db: Db, ctx: RequestContext, documentId: string, partySize = 2): Promise<PlanBookingPreview> {
  const session = requireMember(ctx, 'experiences.book');
  const doc = await planDocument(db, ctx, documentId);
  const size = Math.max(1, Math.min(20, Math.trunc(partySize) || 2));
  const lines = await planLines(db, ctx, doc.content, doc.booked ?? {}, size);
  const dietary = (await memoryItems(db, session.userId)).filter((m) => m.kind === 'dietary').map((m) => m.label);
  return {
    documentId: doc.id, title: doc.title, partySize: size, lines: lines.map((l) => l.line),
    notes: [
      'Each line is booked in your name, with the same checks as booking it yourself. Nothing is paid now: seats that need paying for are held, and you pay under Bookings.',
      'Partners and the concierge desk are given your name, the date, the time and the number of guests.',
      ...(dietary.length ? [`Restaurants and chefs are also told your dietary needs: ${dietary.join(', ')}.`] : []),
    ],
  };
}

export async function bookPlan(db: Db, ctx: RequestContext, marketId: string, documentId: string, body: unknown): Promise<PlanBookingResult> {
  const session = requireMember(ctx, 'experiences.book');
  const parsed = planBookingInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const doc = await planDocument(db, ctx, documentId);
  const booked: Record<string, string> = { ...(doc.booked ?? {}) };
  const lines = await planLines(db, ctx, doc.content, booked, parsed.data.partySize);
  const chosen = lines.filter((l) => parsed.data.lines.includes(l.line.index));
  if (!chosen.length) throw new HttpError(422, 'Choose at least one line to book.', { lines: 'Choose at least one line' });
  const dietary = (await memoryItems(db, session.userId)).filter((m) => m.kind === 'dietary').map((m) => m.label);
  const note = (l: PlannedLine) => [`From the plan “${doc.title}”.`, l.dining && dietary.length ? `Dietary needs: ${dietary.join(', ')}.` : ''].filter(Boolean).join(' ');
  const results: PlanBookingResult['lines'] = [];
  for (const l of chosen) {
    if (!l.line.bookable) { results.push({ index: l.line.index, title: l.line.title, ok: false, text: l.line.status ? `Already done: ${l.line.status}` : l.line.action }); continue; }
    try {
      let text: string;
      if (l.ref.kind === 'experience') {
        const b = await bookExperience(db, ctx, l.ref.id, l.seats);
        text = b.status === 'awaiting_payment' ? `Seats held. Pay ${formatMoney(b.amountDueMinor, b.currency)} under Bookings.` : BOOKING_STATUS_LABEL[b.status];
      } else if (l.ref.kind === 'partner') {
        const b = await createPartnerBooking(db, ctx, { partnerId: l.ref.id, date: l.date, time: l.time, partySize: parsed.data.partySize, notes: note(l) });
        text = `Sent to ${b.partnerName}`;
      } else {
        const r = await requestService(db, ctx, marketId, l.ref.id, { preferredDate: l.date, notes: `${note(l)} For ${parsed.data.partySize}.`, packageId: l.packageId });
        text = `Requested${r.packageName ? `: ${r.packageName}` : ''}`;
      }
      booked[String(l.line.index)] = text;
      results.push({ index: l.line.index, title: l.line.title, ok: true, text });
    } catch (error) {
      results.push({ index: l.line.index, title: l.line.title, ok: false, text: error instanceof HttpError ? error.message : 'This line could not be booked.' });
    }
  }
  await db.query('UPDATE qera_documents SET booked = $3::jsonb WHERE id = $1 AND user_id = $2', [doc.id, session.userId, JSON.stringify(booked)]);
  await audit(db, session.userId, 'qera.plan_booked', 'qera_document', doc.id, { lines: results.length, done: results.filter((r) => r.ok).length });
  return { lines: results };
}

/* ---------- What QÉRA says of its own accord ---------- */

/** Records a nudge once; returns false if it was already sent. */
async function once(db: Queryable, userId: string, key: string): Promise<boolean> {
  return (await db.query('INSERT INTO qera_nudges (user_id, nudge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nudge_key', [userId, key])).length > 0;
}
const notify = (db: Queryable, userId: string, title: string) => db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'qera_recommendation', $2, $3::jsonb)`, [userId, title.slice(0, 300), JSON.stringify({ type: 'qera', id: '' })]);

/**
 * Run from the housekeeping loop. Delivers due reminders, the Monday brief, notice of remembered dates two weeks
 * ahead, and a note the day before a booking. Each is sent once, and only to active members; the brief and the
 * nudges respect the member's weekly-brief setting. Reminders the member set are always delivered.
 */
/** How many things are on a member's day: their calendar, their Quintara bookings and their reminders. */
async function dayCount(db: Db, userId: string, memberId: string, zone: string, today: string): Promise<number> {
  const from = zonedInstant(today, '00:00', zone).toISOString(), to = new Date(zonedInstant(today, '00:00', zone).getTime() + 86_400_000).toISOString();
  const rows = await db.query<{ n: string }>(`SELECT
      (SELECT count(*) FROM calendar_events WHERE user_id = $1 AND starts_at >= $3 AND starts_at < $4)
    + (SELECT count(*) FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.member_id = $2 AND b.status IN ('confirmed', 'awaiting_payment') AND e.starts_at >= $3 AND e.starts_at < $4)
    + (SELECT count(*) FROM partner_bookings WHERE member_id = $2 AND status IN ('requested', 'confirmed') AND booking_date = $5)
    + (SELECT count(*) FROM qera_reminders WHERE user_id = $1 AND status = 'scheduled' AND remind_at >= $3 AND remind_at < $4) AS n`, [userId, memberId, from, to, today]);
  return Number(rows[0]?.n ?? 0);
}

export async function runChiefOfStaff(db: Db, at: Date = new Date()): Promise<number> {
  let sent = 0;
  const due = await db.query(`UPDATE qera_reminders r SET status = 'sent', sent_at = $1 FROM users u WHERE r.user_id = u.id AND u.status = 'active' AND r.status = 'scheduled' AND r.remind_at <= $1 RETURNING r.user_id, r.text`, [at.toISOString()]);
  for (const r of due) { await notify(db, r.user_id as string, `Reminder from QÉRA: ${r.text as string}`); sent++; }

  const members = await db.query<{ user_id: string; member_id: string; timezone: string; brief: boolean | null; daily: boolean | null }>(
    `SELECT m.user_id, m.id AS member_id, c.timezone, s.weekly_brief AS brief, s.daily_brief AS daily FROM members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
       JOIN markets k ON k.id = m.home_market_id JOIN cities c ON c.id = k.city_id LEFT JOIN privacy_settings s ON s.user_id = m.user_id WHERE m.status = 'active'`);
  for (const m of members) {
    const now = localNow(m.timezone, at);
    // The daily brief, each morning from 07:00 in the member's own city.
    if (m.daily !== false && now.hour >= 7 && await once(db, m.user_id, `daily:${now.today}`)) {
      const n = await dayCount(db, m.user_id, m.member_id, m.timezone, now.today);
      await notify(db, m.user_id, `Good morning. Your daily brief is ready: ${n ? `${n === 1 ? 'one thing' : `${n} things`} on your day` : 'your day is clear'}.`);
      sent++;
    }
    if (m.brief === false) continue;
    if (now.weekday === 1 && now.hour >= 7 && await once(db, m.user_id, `brief:${now.today}`)) { await notify(db, m.user_id, 'Your week with QÉRA is ready.'); sent++; }
    for (const d of await db.query<{ id: string; label: string; on_date: unknown }>(`SELECT id, label, on_date FROM qera_memory WHERE user_id = $1 AND kind = 'date' AND on_date IS NOT NULL`, [m.user_id])) {
      const next = nextOccurrence(day(d.on_date)!, now.today), n = daysBetween(now.today, next);
      if (n <= 14 && await once(db, m.user_id, `date:${d.id}:${next}`)) { await notify(db, m.user_id, `${d.label} is on ${longDay(next)}${n <= 1 ? (n === 0 ? ', today' : ', tomorrow') : `, in ${n} days`}. Shall I plan something?`); sent++; }
    }
    const tomorrow = addDaysIso(now.today, 1);
    for (const b of await db.query<{ id: string; title: string; starts_at: unknown }>(`SELECT b.id, e.title, e.starts_at FROM experience_bookings b JOIN experiences e ON e.id = b.experience_id WHERE b.member_id = $1 AND b.status = 'confirmed' AND e.starts_at > $2 AND e.starts_at <= $3`, [m.member_id, at.toISOString(), new Date(at.getTime() + 36 * 3_600_000).toISOString()])) {
      if (localNow(m.timezone, new Date(b.starts_at as string)).today !== tomorrow) continue;
      if (await once(db, m.user_id, `eve:${b.id}`)) { await notify(db, m.user_id, `Tomorrow: ${b.title} at ${formatDateTime(iso(b.starts_at), m.timezone).time}. Your ticket is under Bookings.`); sent++; }
    }
    for (const b of await db.query<{ id: string; name: string; booking_time: string | null }>(`SELECT b.id, p.name, b.booking_time FROM partner_bookings b JOIN partners p ON p.id = b.partner_id WHERE b.member_id = $1 AND b.status = 'confirmed' AND b.booking_date = $2`, [m.member_id, tomorrow])) {
      if (await once(db, m.user_id, `eve-p:${b.id}`)) { await notify(db, m.user_id, `Tomorrow: ${b.name}${b.booking_time ? ` at ${b.booking_time.slice(0, 5)}` : ''}.`); sent++; }
    }
  }
  return sent;
}
