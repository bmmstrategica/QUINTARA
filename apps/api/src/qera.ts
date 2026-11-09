/**
 * QÉRA on the server. The tools below are thin wrappers over the same functions the app's screens call, so
 * every permission, visibility and capacity rule applies to QÉRA exactly as it does to the member's own taps.
 * See packages/domain/src/qera.ts for the rules that keep it safe.
 */
import { BOOKING_STATUS_LABEL, can, leadTimeLabel, MEMORY_KIND_LABEL, packagePriceLabel, composeItinerary, CONCIERGE_SPECIALIST, formatDateTime, formatMoney, QERA_TOOLS, qeraMessageSchema, qeraTurn, RELATIONSHIP_MANAGER } from '@quintara/domain';
import type { Permission, QeraAudience, QeraExperience, QeraFact, QeraModel, QeraPartner, QeraService, QeraThread, QeraToolbox, QeraToolName, QeraUsage } from '@quintara/domain';
import { createRequest } from './concierge.ts';
import { audit, requireMember } from './context.ts';
import { chargeGuestUsage, GUEST_LIMIT_MESSAGE, guestUsage } from './guests.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { bookExperience, cancelBooking, getExperience, listBookings, listExperiences } from './experiences.ts';
import { getMember, listSuggestions, requestConnection } from './members.ts';
import { listServices, requestService } from './lifestyle.ts';
import { getMyProfile } from './members.ts';
import { bookablePartner, bookingWhen, createPartnerBooking, listMyPartnerBookings, saveDocument } from './partner-bookings.ts';
import { listPartners } from './partners.ts';
import type { PaymentProvider } from './payments.ts';
import { search } from './search.ts';
import { addMemory, bookPlan, createReminder, deleteMemory, getWeeklyBrief, memoryItems, previewPlanBooking, reminderWhen } from './chief.ts';
import { marketNow, zonedInstant } from './time.ts';

const PROPOSAL_MINUTES = 15;
const HISTORY = 60;
/** The permission each tool needs. A tool the member lacks the permission for is never offered to the model. */
const NEEDS: Record<QeraToolName, Permission> = {
  list_experiences: 'experiences.view_member', list_bookings: 'experiences.book', list_partners: 'privileges.use', list_suggestions: 'directory.view', search: 'experiences.view_public',
  book_experience: 'experiences.book', cancel_booking: 'experiences.book', create_concierge_request: 'concierge.request', request_connection: 'connections.request',
  about_quintara: 'qera.use', list_services: 'qera.use', recommend: 'qera.use', list_partner_bookings: 'privileges.use', create_itinerary: 'qera.use', book_partner: 'privileges.use', request_service: 'concierge.request',
  list_memory: 'qera.use', remember: 'profile.edit', forget: 'profile.edit', set_reminder: 'qera.use', weekly_brief: 'qera.use', book_plan: 'experiences.book',
};

/** What a guest may ask QÉRA to look up. No actions, no member data, and nothing a visitor could not see. */
const GUEST_TOOLS: QeraToolName[] = ['about_quintara', 'list_services', 'list_experiences', 'recommend', 'search'];

/** Who QÉRA is talking to: an active member, or a signed-in guest account. Anyone else is turned away. */
interface Viewer { userId: string; audience: QeraAudience }
function viewer(ctx: RequestContext): Viewer {
  if (ctx.guest && !ctx.session) return { userId: ctx.guest.userId, audience: 'guest' };
  return { userId: requireMember(ctx, 'qera.use').userId, audience: 'member' };
}

/** The package a request is for: the one the member named, or the first on offer. */
function choosePackage(service: QeraService, said: string) {
  const text = said.toLowerCase();
  return service.packages?.find((p) => p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3).some((w) => text.includes(w))) ?? service.packages?.[0] ?? null;
}

function toolbox(db: Db, ctx: RequestContext, payments: PaymentProvider, marketId: string): QeraToolbox {
  const guest = !ctx.session && Boolean(ctx.guest);
  const when = (iso: string, zone: string) => { const d = formatDateTime(iso, zone); return `${d.long}, ${d.time}`; };
  const localDay = (iso: string, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  // Guests receive experiences without dates or seat counts, so QÉRA cannot repeat what it was never given.
  const experiences = async (): Promise<QeraExperience[]> => (await listExperiences(db, ctx)).map((e) => ({
    id: e.id, title: e.title, category: e.category, when: e.startsAt ? when(e.startsAt, e.timezone) : '', area: e.area,
    seatsLeft: e.capacity === null ? null : Math.max(0, e.capacity - (e.seatsTaken ?? 0)),
    price: guest ? (e.priceMinor ? `${formatMoney(e.priceMinor, e.currency)} a seat` : 'complimentary') : e.memberPriceMinor ? `${formatMoney(e.memberPriceMinor, e.currency)} a seat` : 'complimentary', admission: e.admission,
    ...(e.startsAt ? { date: localDay(e.startsAt, e.timezone), time: formatDateTime(e.startsAt, e.timezone).time } : {}),
  }));
  const partners = async (): Promise<QeraPartner[]> => guest ? [] : (await listPartners(db, ctx)).map((p) => ({ id: p.id, name: p.name, category: p.category, area: p.address || p.area, offer: p.offer || p.summary, bookable: Boolean(p.contactEmail), privileges: p.privileges.filter((v) => v.available).map((v) => v.title) }));
  const services = async (): Promise<QeraService[]> => (await listServices(db, marketId)).map((x) => ({ id: x.id, name: x.name, description: x.description, packages: x.packages.map((p) => ({ id: p.id, name: p.name, price: packagePriceLabel(p), notice: leadTimeLabel(p.leadTimeHours).toLowerCase(), leadTimeHours: p.leadTimeHours })) }));
  const remembered = async () => (ctx.session ? memoryItems(db, ctx.session.userId) : []);
  /** What QÉRA may say about Quintara: what members are told elsewhere in the apps, never internal figures. */
  const facts = async (): Promise<QeraFact[]> => {
    const [e, p, sv, tiers] = await Promise.all([experiences(), partners(), services(), db.query<{ name: string }>('SELECT name FROM membership_tiers WHERE is_active AND market_id = $1 ORDER BY price_minor', [marketId])]);
    const kinds = [...new Set(e.map((x) => x.category))];
    return [
      { topic: 'overview', text: 'Quintara is a private membership for founders, investors, creatives and executives, based in Cape Town. Members book signature experiences, are introduced to one another by the Quintara team, and are looked after through its lifestyle partners and services.' },
      { topic: 'membership', text: `Membership is by application, read by the membership committee. ${tiers.length ? `The tiers are ${tiers.map((t) => t.name).join(', ')}. ` : ''}${guest ? 'You can apply from the Apply page: the application asks about you, your work and where to find you online.' : 'Your card, tier and renewal are under Profile.'}` },
      { topic: 'experiences', text: e.length ? (guest ? `Quintara hosts signature experiences such as ${kinds.slice(0, 6).join(', ').toLowerCase()}. ${e.length} are open to guests at the moment; dates and seats are shared with members.` : `There are ${e.length} experiences on the calendar: ${kinds.slice(0, 6).join(', ').toLowerCase()}. The next is ${e[0]!.title}, ${e[0]!.when}.`) : 'The next season of experiences is being planned.' },
      { topic: 'lifestyle', text: guest ? `Lifestyle brings together Quintara's partner directory and ${sv.length} service${sv.length === 1 ? '' : 's'}${sv.length ? `, from ${sv[0]!.name} to ${sv[sv.length - 1]!.name}` : ''}. Guests can request a service from the Lifestyle page; the partner directory and its privileges are for members.` : `Lifestyle has ${p.length} partner${p.length === 1 ? '' : 's'} in the directory${p.length ? `, such as ${p.slice(0, 3).map((x) => x.name).join(', ')}` : ''}, and ${sv.length} service${sv.length === 1 ? '' : 's'} I can arrange${sv.length ? `, from ${sv[0]!.name} to ${sv[sv.length - 1]!.name}` : ''}.` },
      { topic: 'business', text: 'Under Business, Quintara publishes opportunities and members post listings. Introductions are made by the team with consent on both sides. Quintara does not offer or advise on investments and takes no part in what members agree.' },
      { topic: 'relationship', text: `${RELATIONSHIP_MANAGER.name} of ${RELATIONSHIP_MANAGER.organisation} is the ${RELATIONSHIP_MANAGER.role.toLowerCase()}. On your request he facilitates business partnerships, advisory and brand collaborations. Write to him under Business.` },
      { topic: 'concierge', text: `${CONCIERGE_SPECIALIST.name}, ${CONCIERGE_SPECIALIST.role}, steps in for anything I cannot manage myself. I refer it to her and she replies under Concierge.` },
      { topic: 'boutique', text: 'Maison Quintara sells pieces by Quintara and its makers, delivered by courier in South Africa. Members pay member prices; guests can order too.' },
      { topic: 'tv', text: 'Quintara TV shows films from inside Quintara. Some episodes are open to everyone and the rest are for members.' },
      ...(guest ? [{ topic: 'privacy', text: 'Your conversation with me is private to your guest account. You can download or delete your account under Account at any time.' }] : []),
      { topic: guest ? 'member_privacy' : 'privacy', text: 'Your contact details are never shown to other members or to partners. When I book a partner for you they are given your name, the date, the time and the number of guests, and for restaurants and chefs any dietary needs you have asked me to remember; nothing else. You can download or erase your data under Profile.' },
      ...(guest ? [] : [{ topic: 'chief', text: 'As your Chief of Staff I remember what you ask me to (dietary needs, tastes, favourites, important dates and the people close to you), brief you on your week every Monday, remind you of what matters, and can book a whole plan at once. You can see and change everything I remember under QÉRA, Memory.' }]),
      { topic: 'qera', text: guest ? 'I am QÉRA, the Quintara Intelligence. Guests can talk to me for up to five hours a day; members have no daily limit, and I can book and plan for them.' : 'I am QÉRA, the Quintara Intelligence. I answer from what Quintara offers and what your membership allows, I ask before I act, and I never make a payment for you.' },
    ];
  };
  const all: Required<QeraToolbox> = {
    list_experiences: { run: async () => ({ data: await experiences() }) },
    list_bookings: { run: async () => ({ data: (await listBookings(db, ctx)).map((b) => ({ id: b.id, title: b.experienceTitle, when: when(b.startsAt, b.timezone), seats: b.seats, status: b.status })) }) },
    list_partners: { run: async () => ({ data: await partners() }) },
    list_services: { run: async () => ({ data: await services() }) },
    about_quintara: { run: async () => ({ data: await facts() }) },
    list_partner_bookings: { run: async () => ({ data: (await listMyPartnerBookings(db, ctx)).map((b) => ({ id: b.id, partner: b.partnerName, when: bookingWhen(b), partySize: b.partySize, status: b.status })) }) },
    recommend: {
      run: async () => {
        if (guest) {
          const [e, sv] = await Promise.all([experiences(), services()]);
          return { data: { interests: [], experiences: e.slice(0, 3), partners: [], services: sv.slice(0, 3), people: [] } };
        }
        const [me, e, p, sv, people, memory] = await Promise.all([getMyProfile(db, ctx), experiences(), partners(), services(), can({ roles: ctx.roles }, 'directory.view') ? listSuggestions(db, ctx) : Promise.resolve([]), remembered()]);
        // What the member has asked QÉRA to remember weighs as much as the interests on their profile.
        const likes = [...me.interests, ...memory.filter((m) => m.kind === 'likes' || m.kind === 'favourite').map((m) => m.label)].map((i) => i.toLowerCase());
        const fits = (text: string) => likes.filter((like) => text.toLowerCase().includes(like)).length;
        // What matches the member's stated interests comes first; the rest keeps its order.
        const ranked = <T>(items: T[], text: (item: T) => string) => [...items].sort((a, b) => fits(text(b)) - fits(text(a)));
        return { data: {
          interests: me.interests,
          experiences: ranked(e.filter((x) => x.seatsLeft === null || x.seatsLeft > 0), (x) => `${x.title} ${x.category}`).slice(0, 3),
          partners: ranked(p, (x) => `${x.name} ${x.category} ${x.offer ?? ''}`).slice(0, 3),
          services: ranked(sv, (x) => `${x.name} ${x.description}`).slice(0, 3),
          people: people.slice(0, 2).map((s2) => ({ id: s2.member.id, name: s2.member.fullName, role: `${s2.member.position}, ${s2.member.company}`, reasons: s2.reasons })),
          dietary: memory.filter((m) => m.kind === 'dietary').map((m) => m.label),
        } };
      },
    },
    create_itinerary: {
      run: async (args: { kind: 'day' | 'weekend' | 'holiday'; startDate: string; days: number; focus: string }) => {
        const session = requireMember(ctx, 'qera.use');
        const memory = await remembered();
        const { today } = await marketNow(db, session.marketId);
        const content = composeItinerary({ ...args, today, preparedFor: session.fullName, prefer: memory.filter((m) => m.kind === 'likes' || m.kind === 'favourite').map((m) => m.label), dietary: memory.filter((m) => m.kind === 'dietary').map((m) => m.label) }, { experiences: await experiences(), partners: await partners(), services: await services() });
        const saved = await saveDocument(db, session.userId, args.kind, content);
        return { data: { id: saved.id, title: saved.title, days: content.days.length, lines: content.days.reduce((n, d) => n + d.items.length, 0) } };
      },
    },
    book_partner: {
      summarise: async ({ partnerId, date, time, partySize }: { partnerId: string; date: string; time: string | null; partySize: number }) => {
        const partner = await bookablePartner(db, ctx, partnerId);
        return `I can ask ${partner.name} for a booking on ${bookingWhen({ date, time })} for ${partySize}. I will send them your name, the date and the number of guests, and nothing else. ${partner.contactName ? `${partner.contactName} there` : 'They'} will confirm or decline.`;
      },
      run: async (args: { partnerId: string; date: string; time: string | null; partySize: number; notes: string }) => {
        const b = await createPartnerBooking(db, ctx, args);
        return { text: `Done. I have sent the booking to ${b.partnerName} for ${bookingWhen(b)}, for ${b.partySize}. I will tell you as soon as they answer. If they cannot take it, ${CONCIERGE_SPECIALIST.shortName} will suggest an alternative.` };
      },
    },
    request_service: {
      summarise: async ({ serviceId, date, notes }: { serviceId: string; date: string | null; notes: string }) => {
        const service = (await services()).find((x) => x.id === serviceId);
        if (!service) throw notFound('That service is not on offer.');
        const pkg = choosePackage(service, notes);
        if (pkg && date) {
          const { today } = await marketNow(db, ctx.session?.marketId ?? marketId);
          const first = new Date(`${today}T12:00:00Z`); first.setUTCDate(first.getUTCDate() + Math.ceil(pkg.leadTimeHours / 24));
          if (date < first.toISOString().slice(0, 10)) throw conflict(`${service.name}'s ${pkg.name} needs ${pkg.notice}. The earliest I can ask for is ${bookingWhen({ date: first.toISOString().slice(0, 10), time: null })}.`);
        }
        return `I can ask for ${service.name}${pkg ? `, ${pkg.name} (${pkg.price}, indicative)` : ''} to be arranged${date ? ` for ${bookingWhen({ date, time: null })}` : ''}. This is a request, not a payment: the provider confirms the final price, and you will be told when it is confirmed.`;
      },
      run: async ({ serviceId, date, notes }: { serviceId: string; date: string | null; notes: string }) => {
        const service = (await services()).find((x) => x.id === serviceId);
        const pkg = service ? choosePackage(service, notes) : null;
        const r = await requestService(db, ctx, marketId, serviceId, { preferredDate: date, notes, packageId: pkg?.id ?? null });
        return { text: `Done. Your request for ${r.serviceName}${r.packageName ? `, ${r.packageName},` : ''} is in. You can follow it under Lifestyle.` };
      },
    },
    list_memory: { run: async () => ({ data: (await remembered()).map((m) => ({ id: m.id, kind: m.kind, label: m.label, detail: m.detail, date: m.date })) }) },
    remember: {
      summarise: async ({ kind, label, date }: { kind: keyof typeof MEMORY_KIND_LABEL; label: string; date: string | null }) => `Shall I remember this under ${MEMORY_KIND_LABEL[kind].toLowerCase()}: “${label}”${date ? `, ${bookingWhen({ date, time: null })}` : ''}? You can see, change or remove it at any time under QÉRA, Memory.`,
      run: async (args: { kind: string; label: string; detail: string; date: string | null }) => { const m = await addMemory(db, ctx, args, 'qera'); return { text: `Noted. I will remember “${m.label}”.` }; },
    },
    forget: {
      summarise: async ({ memoryId }: { memoryId: string }) => { const m = (await remembered()).find((x) => x.id === memoryId); if (!m) throw notFound('I do not remember that.'); return `I can forget “${m.label}”. It will be removed from what I remember.`; },
      run: async ({ memoryId }: { memoryId: string }) => { const m = await deleteMemory(db, ctx, memoryId); return { text: `Done. I have forgotten “${m.label}”.` }; },
    },
    set_reminder: {
      summarise: async ({ text, date, time }: { text: string; date: string; time: string }) => {
        const { zone } = await marketNow(db, ctx.session?.marketId ?? marketId);
        if (zonedInstant(date, time, zone).getTime() < Date.now()) throw conflict('That time has already passed. When would you like the reminder?');
        return `I can remind you to ${text.charAt(0).toLowerCase() + text.slice(1)} on ${reminderWhen(zonedInstant(date, time, zone).toISOString(), zone)}.`;
      },
      run: async (args: { text: string; date: string; time: string }) => { const r = await createReminder(db, ctx, args, 'qera'); return { text: `Done. I will remind you on ${reminderWhen(r.remindAt, (await marketNow(db, ctx.session?.marketId ?? marketId)).zone)}.` }; },
    },
    weekly_brief: { run: async () => ({ data: await getWeeklyBrief(db, ctx) }) },
    book_plan: {
      summarise: async ({ documentId, partySize }: { documentId: string; partySize: number }) => {
        const preview = await previewPlanBooking(db, ctx, documentId, partySize);
        const ready = preview.lines.filter((l) => l.bookable);
        if (!ready.length) throw conflict(`Nothing in “${preview.title}” can be booked now. Open the plan to see why.`);
        const skipped = preview.lines.length - ready.length;
        return `I can book ${ready.length} line${ready.length > 1 ? 's' : ''} of “${preview.title}” for ${partySize}: ${ready.map((l) => `${l.title} (${l.day}${l.cost ? `, ${l.cost}` : ''})`).join('; ')}.${skipped ? ` ${skipped} other line${skipped > 1 ? 's' : ''} cannot be booked and will be left.` : ''} ${preview.notes.slice(0, 1).concat(preview.notes.slice(2)).join(' ')}`;
      },
      run: async ({ documentId, partySize }: { documentId: string; partySize: number }) => {
        const preview = await previewPlanBooking(db, ctx, documentId, partySize);
        const result = await bookPlan(db, ctx, marketId, preview.documentId, { partySize, lines: preview.lines.filter((l) => l.bookable).map((l) => l.index) });
        const done = result.lines.filter((l) => l.ok);
        return { text: `Done. ${done.length} of ${result.lines.length} booked: ${result.lines.map((l) => `${l.title}: ${l.text}`).join('; ')}. The plan shows where each line stands.` };
      },
    },
    list_suggestions: { run: async () => ({ data: (await listSuggestions(db, ctx)).map((s) => ({ id: s.member.id, name: s.member.fullName, role: `${s.member.position}, ${s.member.company}`, reasons: s.reasons })) }) },
    search: { run: async ({ query }: { query: string }) => ({ data: await search(db, ctx, marketId, query) }) },
    book_experience: {
      summarise: async ({ experienceId, seats }: { experienceId: string; seats: number }) => {
        const e = await getExperience(db, ctx, experienceId);
        if (seats > e.maxSeatsPerBooking) throw conflict(`${e.title} allows up to ${e.maxSeatsPerBooking} seat${e.maxSeatsPerBooking > 1 ? 's' : ''} per booking.`);
        const cost = e.memberPriceMinor ? `${formatMoney(e.memberPriceMinor * seats, e.currency)} will be due, which you pay yourself under Bookings.` : 'It is complimentary.';
        return `I can reserve ${seats} seat${seats > 1 ? 's' : ''} at ${e.title} on ${when(e.startsAt!, e.timezone)}. ${cost}`;
      },
      run: async ({ experienceId, seats }: { experienceId: string; seats: number }) => {
        const b = await bookExperience(db, ctx, experienceId, seats);
        const next = b.status === 'awaiting_payment' ? ` Your seats are held: pay ${formatMoney(b.amountDueMinor, b.currency)} under Bookings to confirm them.` : b.status === 'confirmed' ? ` Your ticket code is ${b.ticketCode}.` : '';
        return { text: `Done. ${b.experienceTitle}: ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.${next}` };
      },
    },
    cancel_booking: {
      summarise: async ({ bookingId }: { bookingId: string }) => {
        const b = (await listBookings(db, ctx)).find((candidate) => candidate.id === bookingId);
        if (!b) throw notFound('I could not find that booking.');
        return `I can cancel your booking for ${b.experienceTitle} on ${when(b.startsAt, b.timezone)} (${b.seats} seat${b.seats > 1 ? 's' : ''}). Any refund follows that experience's rules.`;
      },
      run: async ({ bookingId }: { bookingId: string }) => {
        const b = await cancelBooking(db, ctx, payments, bookingId);
        return { text: `Done. Your booking for ${b.experienceTitle} is cancelled.${b.refundedMinor ? ` ${formatMoney(b.refundedMinor, b.currency)} is being refunded.` : ''}` };
      },
    },
    create_concierge_request: {
      summarise: async ({ subject }: { subject: string }) => `This is one for your Lifestyle Curator. I can refer it to ${CONCIERGE_SPECIALIST.name} at the concierge desk: “${subject}”. She will reply with options.`,
      run: async (args: { category: string; subject: string; details: string }) => { const r = await createRequest(db, ctx, { ...args, neededBy: null }); return { text: `Done. ${CONCIERGE_SPECIALIST.shortName} has your request, “${r.subject}”. You can follow it under Concierge.` }; },
    },
    request_connection: {
      summarise: async ({ memberId }: { memberId: string }) => { const m = await getMember(db, ctx, memberId); return `I can ask ${m.fullName} to connect with you. They decide whether to accept.`; },
      run: async ({ memberId }: { memberId: string }) => { const m = await requestConnection(db, ctx, memberId); return { text: m.connection === 'connected' ? `Done. You and ${m.fullName} are now connected.` : `Done. ${m.fullName} has been asked.` }; },
    },
  };
  if (guest) return Object.fromEntries(Object.entries(all).filter(([name]) => GUEST_TOOLS.includes(name as QeraToolName))) as QeraToolbox;
  return Object.fromEntries(Object.entries(all).filter(([name]) => can({ roles: ctx.roles }, NEEDS[name as QeraToolName]))) as QeraToolbox;
}

export async function getThread(db: Db, ctx: RequestContext, guestLimit?: number, usage?: QeraUsage): Promise<QeraThread> {
  const session = viewer(ctx);
  await db.query(`UPDATE qera_proposals SET status = 'cancelled', decided_at = now() WHERE user_id = $1 AND status = 'pending' AND expires_at <= now()`, [session.userId]);
  const rows = await db.query(`SELECT id, role, body, created_at, channel FROM (SELECT * FROM qera_messages WHERE user_id = $1 ORDER BY created_at DESC, (role = 'member') ASC, id DESC LIMIT $2) recent ORDER BY created_at, (role = 'member') DESC, id`, [session.userId, HISTORY]);
  const pending = (await db.query(`SELECT id, tool, summary, expires_at FROM qera_proposals WHERE user_id = $1 AND status = 'pending'`, [session.userId]))[0];
  return {
    messages: rows.map((row) => ({ id: row.id as string, role: row.role as 'member' | 'qera', text: row.body as string, sentAt: new Date(row.created_at as string).toISOString(), ...(row.channel === 'whatsapp' ? { via: 'whatsapp' as const } : {}) })),
    pending: pending ? { id: pending.id as string, tool: pending.tool as QeraToolName, summary: pending.summary as string, expiresAt: new Date(pending.expires_at as string).toISOString() } : null,
    usage: session.audience === 'guest' ? usage ?? await guestUsage(db, session.userId, guestLimit) : null,
  };
}

// Within the same instant, the member's message comes before QÉRA's reply.
const say = (db: Db, userId: string, role: 'member' | 'qera', body: string, channel: Channel = 'app') => db.query('INSERT INTO qera_messages (user_id, role, body, channel) VALUES ($1, $2, $3, $4)', [userId, role, body.slice(0, 4000), channel]);
/** Where the member wrote: the app, or WhatsApp. The conversation is one and the same. */
export type Channel = 'app' | 'whatsapp';

export async function sendMessage(db: Db, ctx: RequestContext, model: QeraModel, payments: PaymentProvider, marketId: string, body: unknown, guestLimit?: number, channel: Channel = 'app'): Promise<QeraThread> {
  const session = viewer(ctx);
  const parsed = qeraMessageSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  // A guest's time is checked before anything is read or stored, then the message itself is counted.
  let usage: QeraUsage | undefined;
  if (session.audience === 'guest') {
    if ((await guestUsage(db, session.userId, guestLimit)).exhausted) throw new HttpError(403, GUEST_LIMIT_MESSAGE);
    usage = await chargeGuestUsage(db, session.userId, 'message', guestLimit);
  }
  // A new message replaces anything that was waiting for an answer: an old proposal can never be confirmed by accident.
  await db.query(`UPDATE qera_proposals SET status = 'superseded', decided_at = now() WHERE user_id = $1 AND status = 'pending'`, [session.userId]);
  await say(db, session.userId, 'member', parsed.data.text, channel);
  const turn = await qeraTurn(model, toolbox(db, ctx, payments, marketId), parsed.data.text, session.audience);
  for (const tool of turn.used) await audit(db, session.userId, 'qera.tool_used', 'user', session.userId, { tool, model: model.name });
  if (turn.proposal) {
    const id = (await db.query<{ id: string }>(`INSERT INTO qera_proposals (user_id, tool, args, summary, expires_at) VALUES ($1, $2, $3::jsonb, $4, now() + make_interval(mins => $5)) RETURNING id`,
      [session.userId, turn.proposal.tool, JSON.stringify(turn.proposal.args), turn.proposal.summary, PROPOSAL_MINUTES]))[0]!.id;
    await audit(db, session.userId, 'qera.proposed', 'qera_proposal', id, { tool: turn.proposal.tool, channel });
  }
  await say(db, session.userId, 'qera', turn.reply, channel);
  return getThread(db, ctx, guestLimit, usage);
}

/** The QÉRA screen's heartbeat. Counts a guest's time; members have no limit, so for them it does nothing. */
export async function heartbeat(db: Db, ctx: RequestContext, guestLimit?: number): Promise<QeraUsage | null> {
  const session = viewer(ctx);
  return session.audience === 'guest' ? chargeGuestUsage(db, session.userId, 'heartbeat', guestLimit) : null;
}

/** The member's yes or no. On yes the action runs as the member, with every usual check applied again. */
export async function decideProposal(db: Db, ctx: RequestContext, payments: PaymentProvider, marketId: string, id: string, confirm: boolean, channel: Channel = 'app'): Promise<QeraThread> {
  const session = requireMember(ctx, 'qera.use');   // guests are never given a proposal to decide
  // Claimed in one statement, so two taps cannot run the action twice, and nobody can decide another member's proposal.
  const claimed = /^[0-9a-f-]{36}$/i.test(id) ? await db.query<{ tool: QeraToolName; args: Record<string, unknown> }>(
    `UPDATE qera_proposals SET status = $3, decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now() RETURNING tool, args`, [id, session.userId, confirm ? 'confirmed' : 'cancelled']) : [];
  if (!claimed[0]) throw new HttpError(409, 'That is no longer waiting for an answer.');
  if (!confirm) {
    await say(db, session.userId, 'qera', 'Understood. I have not done anything.', channel);
    await audit(db, session.userId, 'qera.declined', 'qera_proposal', id, { tool: claimed[0].tool, channel });
    return getThread(db, ctx);
  }
  const tool = toolbox(db, ctx, payments, marketId)[claimed[0].tool];
  let text: string;
  try {
    if (!tool || QERA_TOOLS[claimed[0].tool].kind !== 'action') throw new HttpError(403, 'That is not something I can do for you.');
    text = (await tool.run(claimed[0].args as never)).text ?? 'Done.';
    await audit(db, session.userId, 'qera.confirmed', 'qera_proposal', id, { tool: claimed[0].tool, args: claimed[0].args, channel });
  } catch (error) {
    await db.query(`UPDATE qera_proposals SET status = 'failed' WHERE id = $1`, [id]);
    await audit(db, session.userId, 'qera.failed', 'qera_proposal', id, { tool: claimed[0].tool });
    text = `I could not do that. ${error instanceof HttpError ? error.message : 'Please try again.'}`;
  }
  await say(db, session.userId, 'qera', text, channel);
  return getThread(db, ctx);
}

export async function clearThread(db: Db, ctx: RequestContext): Promise<void> {
  const session = viewer(ctx);
  await db.query('DELETE FROM qera_messages WHERE user_id = $1', [session.userId]);
  await db.query(`UPDATE qera_proposals SET status = 'cancelled', decided_at = now() WHERE user_id = $1 AND status = 'pending'`, [session.userId]);
}
