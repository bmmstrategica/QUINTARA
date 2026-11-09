/**
 * QÉRA, the Quintara assistant: the parts shared by the real API and the offline mock.
 *
 * How it is kept safe:
 *  - QÉRA has no powers of its own. Everything it does is a "tool", and the tools it is offered are only the
 *    ones the signed-in member is permitted to use. Each tool calls the same code as the app's own screens,
 *    so the same permission checks run again when it is used.
 *  - Tools are of two kinds. A `read` tool looks something up and may run at once. An `action` tool changes
 *    something, and is never run by QÉRA: it becomes a proposal that the member must confirm.
 *  - The words of a proposal are written by the tool from the real record ("Reserve 2 seats at …"), never by
 *    the language model, so what the member confirms is what will happen.
 *  - What a tool returns is treated as information, never as instructions.
 *  - QÉRA handles what it can itself: it answers about Quintara, recommends, books experiences, sends booking
 *    requests to partners and services, and prepares itineraries. What it cannot manage it refers to the
 *    Lifestyle Curator at the concierge desk, and says so.
 *
 * The language model sits behind `QeraModel`. `RuleBasedQeraModel` is a stand-in that understands a set of
 * common requests without any outside service; a hosted model can replace it without touching the rest.
 */
import { z } from 'zod';
// Types only from the main file: importing a value here would make the two files depend on each other at load time.
import type { ConciergeCategory } from './index.ts';

const CATEGORIES = ['hospitality', 'travel', 'wellness', 'personal', 'entertainment'] as const satisfies readonly ConciergeCategory[];

export const QERA_TOOLS = {
  list_experiences: { kind: 'read', description: 'Experiences the member can see, with dates, places and seats left.' },
  list_bookings: { kind: 'read', description: "The member's own bookings." },
  list_partners: { kind: 'read', description: 'Lifestyle partners and the privileges open to the member.' },
  list_suggestions: { kind: 'read', description: 'Members worth meeting, with reasons.' },
  search: { kind: 'read', description: 'Search across everything the member can see.' },
  about_quintara: { kind: 'read', description: 'What Quintara is and offers: membership, experiences, lifestyle, business, Maison Quintara, TV and who looks after members.' },
  list_services: { kind: 'read', description: 'Lifestyle services that can be booked through Quintara.' },
  recommend: { kind: 'read', description: 'Experiences, partners, services and people chosen for this member.' },
  list_partner_bookings: { kind: 'read', description: 'Bookings QÉRA has made with partners for the member.' },
  create_itinerary: { kind: 'read', description: 'Prepares a private Quintara document for the member: a plan for a day, a weekend or a holiday. Nothing in it is booked.' },
  book_partner: { kind: 'action', description: 'Send a booking request to a partner, using the contact in the partner directory.' },
  request_service: { kind: 'action', description: 'Ask for a lifestyle service to be arranged.' },
  book_experience: { kind: 'action', description: 'Reserve seats at an experience.' },
  cancel_booking: { kind: 'action', description: 'Cancel one of the member’s bookings.' },
  create_concierge_request: { kind: 'action', description: 'Refer something QÉRA cannot manage itself to the Lifestyle Curator at the concierge desk.' },
  request_connection: { kind: 'action', description: 'Ask to connect with another member.' },
  list_memory: { kind: 'read', description: 'What QÉRA remembers about the member: dietary needs, tastes, favourites, important dates, people and notes.' },
  remember: { kind: 'action', description: 'Remember something the member has asked QÉRA to remember.' },
  forget: { kind: 'action', description: 'Forget one thing QÉRA remembers.' },
  set_reminder: { kind: 'action', description: 'Set a reminder for a date and time.' },
  weekly_brief: { kind: 'read', description: "The member's week: what is booked, dates coming up, what is waiting on them, and what QÉRA would suggest." },
  book_plan: { kind: 'action', description: 'Book every bookable line of a prepared plan at once.' },
} as const satisfies Record<string, { kind: 'read' | 'action'; description: string }>;
export type QeraToolName = keyof typeof QERA_TOOLS;

/** What each tool accepts. Anything the model sends is checked against these before a tool is touched. */
export const QERA_ARGS = {
  list_experiences: z.object({}),
  list_bookings: z.object({}),
  list_partners: z.object({}),
  list_suggestions: z.object({}),
  search: z.object({ query: z.string().trim().min(2).max(80) }),
  about_quintara: z.object({}),
  list_services: z.object({}),
  recommend: z.object({}),
  list_partner_bookings: z.object({}),
  create_itinerary: z.object({ kind: z.enum(['day', 'weekend', 'holiday']), startDate: z.iso.date(), days: z.number().int().min(1).max(14), focus: z.string().trim().max(200).default('') }),
  book_partner: z.object({ partnerId: z.string().min(1).max(80), date: z.iso.date(), time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/).nullable().default(null), partySize: z.number().int().min(1).max(50), notes: z.string().trim().max(1000).default('') }),
  request_service: z.object({ serviceId: z.string().min(1).max(80), date: z.iso.date().nullable().default(null), notes: z.string().trim().max(1000).default('') }),
  book_experience: z.object({ experienceId: z.string().min(1).max(80), seats: z.number().int().min(1).max(20) }),
  cancel_booking: z.object({ bookingId: z.string().min(1).max(80) }),
  create_concierge_request: z.object({ category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(120), details: z.string().trim().min(10).max(2000) }),
  request_connection: z.object({ memberId: z.string().min(1).max(80) }),
  list_memory: z.object({}),
  remember: z.object({ kind: z.enum(['dietary', 'likes', 'favourite', 'date', 'person', 'note']), label: z.string().trim().min(1).max(120), detail: z.string().trim().max(300).default(''), date: z.iso.date().nullable().default(null) }),
  forget: z.object({ memoryId: z.string().min(1).max(80) }),
  set_reminder: z.object({ text: z.string().trim().min(2).max(200), date: z.iso.date(), time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/).default('09:00') }),
  weekly_brief: z.object({}),
  /** `latest` books the plan prepared most recently. */
  book_plan: z.object({ documentId: z.string().min(1).max(80), partySize: z.number().int().min(1).max(20) }),
} satisfies Record<QeraToolName, z.ZodType>;

/** Compact shapes handed to the model: enough to answer with, and nothing private. */
export interface QeraExperience { id: string; title: string; category: string; /** Empty for guests: dates are for members. */ when: string; area: string; /** Null for guests: seat counts are for members. */ seatsLeft: number | null; price: string; admission: string; /** Local date and time, for itineraries. */ date?: string; time?: string }
export interface QeraBooking { id: string; title: string; when: string; seats: number; status: string }
export interface QeraPartner { name: string; category: string; privileges: string[]; id?: string; area?: string; offer?: string; /** True when the directory has a contact QÉRA can send a booking to. */ bookable?: boolean }
export interface QeraService { id: string; name: string; description: string; /** "Tasting menu for six, R 9 000 per booking, 5 days' notice" */ packages?: { id: string; name: string; price: string; notice: string; leadTimeHours: number }[] }
export interface QeraMemoryFact { id: string; kind: string; label: string; detail: string; date: string | null }
export interface QeraFact { topic: string; text: string }
export interface QeraPartnerBooking { id: string; partner: string; when: string; partySize: number; status: string }
export interface QeraRecommendation { experiences: QeraExperience[]; partners: QeraPartner[]; services: QeraService[]; people: QeraPerson[]; interests: string[]; /** Dietary needs QÉRA remembers, so dining suggestions can mention them. */ dietary?: string[] }

/** One line of a plan. `book` says what QÉRA can be asked to book for it. */
export interface ItineraryItem { time: string; title: string; detail: string; kind: 'experience' | 'partner' | 'service' | 'note'; book?: string; /** What this line would book, so a whole plan can be booked at once. */ ref?: { kind: 'experience' | 'partner' | 'service'; id: string } }
export interface ItineraryDay { date: string; label: string; items: ItineraryItem[] }
export interface ItineraryContent { title: string; subtitle: string; preparedFor: string; days: ItineraryDay[]; notes: string[] }
/** A document QÉRA prepared. Private to the member it was prepared for. */
export interface QeraDocument { id: string; kind: 'day' | 'weekend' | 'holiday'; title: string; createdAt: string; content: ItineraryContent; /** What booking the plan did, by line number. */ booked?: Record<string, string> }
export type QeraDocumentSummary = Omit<QeraDocument, 'content'>;
export interface QeraPerson { id: string; name: string; role: string; reasons: string[] }
export interface QeraFound { kind: string; title: string; detail: string }

export interface QeraMessage { id: string; role: 'member' | 'qera'; text: string; sentAt: string; /** Set when the message was sent or answered on WhatsApp. */ via?: 'whatsapp' }
/** An action QÉRA would like to take, waiting for the member's yes or no. */
export interface QeraProposal { id: string; tool: QeraToolName; summary: string; expiresAt: string }
/** A guest's QÉRA time today. Members have no daily limit, so theirs is null. */
export interface QeraUsage { usedSeconds: number; limitSeconds: number; /** When the allowance starts again (ISO instant). */ resetsAt: string; exhausted: boolean }
export interface QeraThread { messages: QeraMessage[]; pending: QeraProposal | null; usage?: QeraUsage | null }
/** Who QÉRA is talking to. A guest is offered read-only tools and is told what membership adds. */
export type QeraAudience = 'member' | 'guest';

export const qeraMessageSchema = z.object({ text: z.string().trim().min(1, 'Type a message').max(1000) });

export interface QeraToolCall { name: QeraToolName; args: Record<string, unknown> }
export interface QeraResult extends QeraToolCall { data: unknown }
export interface QeraStep { reply?: string; toolCall?: QeraToolCall }
export interface QeraModel {
  readonly name: string;
  /** Given the member's message and what has been looked up so far, either answers or asks for one tool. */
  next(input: { message: string; results: QeraResult[]; tools: QeraToolName[]; audience?: QeraAudience }): Promise<QeraStep>;
}

/** One tool as the host (API or mock) provides it, already bound to the signed-in member. */
export interface QeraTool {
  /** Runs the tool. For an action this happens only after the member has confirmed. */
  run(args: never): Promise<{ data?: unknown; text?: string }>;
  /** For actions: says, from the real record, what would happen. Throws if it cannot be done. */
  summarise?(args: never): Promise<string>;
}
export type QeraToolbox = Partial<Record<QeraToolName, QeraTool>>;

export interface QeraTurn { reply: string; proposal: { tool: QeraToolName; args: Record<string, unknown>; summary: string } | null; used: QeraToolName[] }

const MAX_STEPS = 6;

/** Runs one exchange: the model may look things up, then either answers or proposes a single action. */
export async function qeraTurn(model: QeraModel, toolbox: QeraToolbox, message: string, audience: QeraAudience = 'member'): Promise<QeraTurn> {
  const offered = Object.keys(toolbox) as QeraToolName[];
  const results: QeraResult[] = [], used: QeraToolName[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const { reply, toolCall } = await model.next({ message, results, tools: offered, audience });
    // A guest is never offered an action, whatever a model asks for.
    if (toolCall && audience === 'guest' && QERA_TOOLS[toolCall.name]?.kind === 'action') return { reply: QERA_GUEST_MEMBERS_ONLY, proposal: null, used };
    if (!toolCall) return { reply: reply?.trim() || 'I am not sure how to help with that yet.', proposal: null, used };
    const tool = toolbox[toolCall.name];
    // A tool the member is not permitted to use is simply not there, whatever the model asks for.
    if (!tool || !(toolCall.name in QERA_TOOLS)) return { reply: 'That is not something I can do for you.', proposal: null, used };
    const parsed = QERA_ARGS[toolCall.name].safeParse(toolCall.args);
    if (!parsed.success) return { reply: 'I could not work out the details of that. Could you say it another way?', proposal: null, used };
    used.push(toolCall.name);
    try {
      if (QERA_TOOLS[toolCall.name].kind === 'action') {
        const summary = await tool.summarise!(parsed.data as never);
        return { reply: `${summary} Shall I go ahead?`, proposal: { tool: toolCall.name, args: parsed.data as Record<string, unknown>, summary }, used };
      }
      results.push({ name: toolCall.name, args: parsed.data as Record<string, unknown>, data: (await tool.run(parsed.data as never)).data });
    } catch (error) {
      return { reply: error instanceof Error && error.message ? error.message : 'I could not do that.', proposal: null, used };
    }
  }
  return { reply: 'That took more steps than I am allowed. Could you ask for one thing at a time?', proposal: null, used };
}

/* ---------- Dates and plans ---------- */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const atNoon = (iso: string) => new Date(`${iso}T12:00:00Z`);
const addDays = (iso: string, days: number) => isoDay(new Date(atNoon(iso).getTime() + days * DAY_MS));
/** "Saturday 10 October" */
export const longDay = (iso: string) => { const d = atNoon(iso), cap = (word: string) => word[0]!.toUpperCase() + word.slice(1); return `${cap(WEEKDAYS[d.getUTCDay()]!)} ${d.getUTCDate()} ${cap(MONTHS[d.getUTCMonth()]!)}`; };

/** "14 November": a remembered date, without the weekday of the year it was first set. */
export const dayAndMonth = (iso: string) => { const d = atNoon(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]![0]!.toUpperCase()}${MONTHS[d.getUTCMonth()]!.slice(1)}`; };

/** The date a message names, if it names one: an ISO date, "17 October", a weekday, "today", "tomorrow" or "this weekend". */
export function dateIn(message: string, today: string): string | null {
  const text = message.toLowerCase();
  const iso = /\b(20\d\d-[01]\d-[0-3]\d)\b/.exec(text);
  if (iso) return iso[1]!;
  const named = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\b`).exec(text)
    ?? (() => { const m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text); return m ? ([m[0], m[2], m[1]] as unknown as RegExpExecArray) : null; })();
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[2]!.slice(0, 3))), day = Number(named[1]);
    if (day >= 1 && day <= 31) {
      const year = Number(today.slice(0, 4));
      const candidate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return candidate >= today ? candidate : `${year + 1}${candidate.slice(4)}`;
    }
  }
  if (/\btoday\b|\btonight\b/.test(text)) return today;
  if (/\btomorrow\b/.test(text)) return addDays(today, 1);
  const weekday = atNoon(today).getUTCDay();
  if (/\bweekend\b/.test(text)) { const until = (6 - weekday + 7) % 7; return addDays(today, (until === 0 ? 0 : until) + (/\bnext weekend\b/.test(text) ? 7 : 0)); }
  const found = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (found >= 0) { const until = (found - weekday + 7) % 7; return addDays(today, until === 0 ? 7 : until); }
  return null;
}

/** "at 7pm", "at 7:30 pm", "19:30" or "at 19h30" as 24-hour HH:MM. */
export function timeIn(message: string): string | null {
  const text = message.toLowerCase();
  const twelve = /\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(text);
  if (twelve) { let hour = Number(twelve[1]) % 12; if (twelve[3] === 'pm') hour += 12; return `${String(hour).padStart(2, '0')}:${twelve[2] ?? '00'}`; }
  const clock = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/.exec(text);
  return clock ? `${clock[1]!.padStart(2, '0')}:${clock[2]}` : null;
}

const DINING = /dining|restaurant|food|kitchen|hospitality|bar|wine/i;
const WELLNESS = /wellness|spa|health|fitness|gym|beauty|aesthetic|trainer/i;

/**
 * Lays a plan out from what Quintara itself offers: its experiences on those dates, its partners and its
 * services. It is a suggestion to book from, not a record of bookings.
 */
export function composeItinerary(
  input: { kind: 'day' | 'weekend' | 'holiday'; startDate: string; days: number; focus: string; preparedFor: string; /** Tastes and favourites QÉRA remembers: they lean the plan. */ prefer?: string[]; /** Dietary needs QÉRA remembers. */ dietary?: string[]; /** Today where the member is, so services are not suggested sooner than their notice allows. */ today?: string },
  data: { experiences: QeraExperience[]; partners: QeraPartner[]; services: QeraService[] },
): ItineraryContent {
  const focus = [...words(input.focus), ...(input.prefer ?? []).flatMap(words)];
  // What the member asked for comes first; otherwise the order the directory gives.
  const lean = <T>(items: T[], text: (item: T) => string) => [...items].sort((a, b) => Number(focus.some((w) => w.length > 3 && words(text(b)).includes(w))) - Number(focus.some((w) => w.length > 3 && words(text(a)).includes(w))));
  const CHEF = /chef|culinary|catering/i;
  const dining = lean([...data.partners.filter((p) => DINING.test(p.category)).map((p) => ({ partner: p })), ...data.services.filter((x) => CHEF.test(x.name)).map((service) => ({ service }))] as ({ partner?: QeraPartner; service?: QeraService })[], (x) => (x.partner ? `${x.partner.name} ${x.partner.category} ${x.partner.offer ?? ''}` : `${x.service!.name} ${x.service!.description}`));
  const wellness = lean([...data.partners.filter((p) => WELLNESS.test(p.category)).map((p) => ({ partner: p })), ...data.services.filter((s) => WELLNESS.test(`${s.name} ${s.description}`)).map((service) => ({ service }))] as ({ partner?: QeraPartner; service?: QeraService })[], (x) => (x.partner ? `${x.partner.name} ${x.partner.category}` : `${x.service!.name} ${x.service!.description}`));
  const other = lean([...data.partners.filter((p) => !DINING.test(p.category) && !WELLNESS.test(p.category)).map((p) => ({ partner: p })), ...data.services.filter((s) => !WELLNESS.test(`${s.name} ${s.description}`) && !CHEF.test(s.name)).map((service) => ({ service }))] as ({ partner?: QeraPartner; service?: QeraService })[], (x) => (x.partner ? `${x.partner.name} ${x.partner.category} ${x.partner.offer ?? ''}` : `${x.service!.name} ${x.service!.description}`));
  const partnerItem = (time: string, p: QeraPartner, lead: string): ItineraryItem => ({ time, title: `${lead} ${p.name}`, detail: [p.area, p.offer, p.privileges[0] ? `Member privilege: ${p.privileges[0]}` : ''].filter(Boolean).map((part) => part!.replace(/[.\s]+$/, '')).join('. ') + '.', kind: 'partner', book: p.bookable ? `Book ${p.name}` : undefined, ...(p.bookable && p.id ? { ref: { kind: 'partner' as const, id: p.id } } : {}) });
  const firstSentence = (text: string) => (/^[^.!?]*[.!?]?/.exec(text.trim())?.[0] ?? '').trim();
  const serviceItem = (time: string, x: QeraService): ItineraryItem => ({ time, title: x.name, detail: [firstSentence(x.description), x.packages?.[0] ? `${x.packages[0].name}: ${x.packages[0].price}, ${x.packages[0].notice}.` : ''].filter(Boolean).join(' '), kind: 'service', book: `Book ${x.name}`, ref: { kind: 'service', id: x.id } });
  const either = (time: string, x: { partner?: QeraPartner; service?: QeraService }, lead: string) => (x.partner ? partnerItem(time, x.partner, lead) : /^(Lunch|Dinner)/.test(lead) ? { ...serviceItem(time, x.service!), title: `${lead.replace(' at', ' by')} ${x.service!.name}` } : serviceItem(time, x.service!));

  // A service is only suggested on a day its notice period allows.
  const ready = (x: { service?: QeraService }, date: string) => !x.service || !input.today || !x.service.packages?.length || addDays(input.today, Math.ceil(Math.min(...x.service.packages.map((p) => p.leadTimeHours)) / 24)) <= date;
  const from = <T extends { service?: QeraService }>(list: T[], start: number, date: string, not?: T | null): T | null => {
    for (let k = 0; k < list.length; k++) { const c = list[(start + k) % list.length]!; if (c !== not && ready(c, date)) return c; }
    return null;
  };
  const days: ItineraryDay[] = [];
  for (let n = 0; n < input.days; n++) {
    const date = addDays(input.startDate, n), items: ItineraryItem[] = [];
    const on = data.experiences.filter((e) => e.date === date);
    const evening = on.find((e) => (e.time ?? '00:00') >= '16:00'), daytime = on.filter((e) => e !== evening);
    const morning = from(wellness, n, date);
    if (morning) items.push(either('09:00', morning, 'A morning at'));
    for (const e of daytime) items.push({ time: e.time ?? '11:00', title: e.title, detail: `A Quintara experience in ${e.area}. ${e.seatsLeft === null ? '' : e.seatsLeft > 0 ? `${e.seatsLeft} seats left, ` : 'Waitlist, '}${e.price}.`, kind: 'experience', book: `Book a seat at ${e.title}`, ref: { kind: 'experience', id: e.id } });
    // Lunch and dinner are never at the same table on the same day.
    const dinner = from(dining, 2 * n + 1, date), lunch = dining.length > 1 ? from(dining, 2 * n, date, dinner) : null;
    if (!daytime.length && lunch && lunch !== dinner) items.push(either('13:00', lunch, 'Lunch at'));
    const afternoon = from(other, n, date);
    if (afternoon) items.push(either('15:30', afternoon, 'An afternoon with'));
    if (evening) items.push({ time: evening.time ?? '19:00', title: evening.title, detail: `A Quintara experience in ${evening.area}. ${evening.seatsLeft === null ? '' : evening.seatsLeft > 0 ? `${evening.seatsLeft} seats left, ` : 'Waitlist, '}${evening.price}.`, kind: 'experience', book: `Book a seat at ${evening.title}`, ref: { kind: 'experience', id: evening.id } });
    else if (dinner) items.push(either('19:30', dinner, 'Dinner at'));
    if (!items.length) items.push({ time: '', title: 'A free day', detail: 'Nothing from Quintara falls on this day yet. Ask me again closer to the time.', kind: 'note' });
    days.push({ date, label: input.days > 1 ? `Day ${n + 1}. ${longDay(date)}` : longDay(date), items: items.sort((a, b) => a.time.localeCompare(b.time)) });
  }
  const span = input.days > 1 ? `${longDay(input.startDate)} to ${longDay(addDays(input.startDate, input.days - 1))}` : longDay(input.startDate);
  const name = { day: 'A day with Quintara', weekend: 'A weekend with Quintara', holiday: input.days > 1 ? `${input.days} days with Quintara` : 'A holiday with Quintara' }[input.kind];
  return {
    title: name, subtitle: span, preparedFor: input.preparedFor, days,
    notes: [
      'Nothing in this plan is booked yet. Book the whole plan at once from this document, or tell QÉRA which lines you would like. Either way you confirm first.',
      ...(input.dietary?.length ? [`Dietary needs passed to restaurants and chefs when booking: ${input.dietary.join(', ')}.`] : []),
      'Times are suggestions. Partners confirm their own availability when QÉRA sends the booking.',
      ...(input.focus ? [`Prepared with this in mind: ${input.focus}`] : []),
    ],
  };
}

/* ---------- The stand-in model ---------- */

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
const SMALL = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'please', 'could', 'would', 'want', 'like', 'need', 'have', 'book', 'seat', 'seats', 'reserve', 'cancel', 'booking', 'find', 'show', 'what', 'about', 'some', 'tell', 'there', 'any', 'are', 'you', 'can', 'who', 'should', 'meet', 'connect', 'place', 'places', 'quintara', 'table', 'people', 'guests', 'house', 'club', 'cape', 'town', 'management', 'studio', 'studios']);
/** Lower-case words with accents removed, so “Episimo Dipno” finds “Epísimo Dípno”. */
const words = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const has = (text: string, ...needles: string[]) => needles.some((needle) => text.includes(needle));
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** How many distinctive words of a name the message uses. */
function score(name: string, message: string): number {
  const said = new Set(words(message));
  return words(name).filter((word) => word.length >= 3 && !SMALL.has(word) && said.has(word)).length;
}
/** The item whose name shares the most words with the message, if any does. */
function pick<T>(items: T[], name: (item: T) => string, message: string): T | null {
  let best: T | null = null, bestScore = 0;
  for (const item of items) { const found = score(name(item), message); if (found > bestScore) { best = item; bestScore = found; } }
  return best;
}

function seatsIn(message: string): number {
  const text = message.toLowerCase();
  const digits = /\b(\d{1,2})\s*(seats?|places?|people|guests|of us|tickets?|persons?|pax)\b/.exec(text) ?? /\b(?:for|party of|table of)\s+(\d{1,2})\b(?!\s*(?:am|pm|:|h\d))/.exec(text);
  if (digits) return Number(digits[1]);
  const word = /\b(one|two|three|four|five|six|seven|eight|nine|ten|an?)\s+(seats?|places?|tickets?|people|guests)\b/.exec(text) ?? /\b(?:for|party of|table of)\s+(two|three|four|five|six|seven|eight|nine|ten)\b/.exec(text);
  return word ? NUMBER_WORDS[word[1]!]! : 1;
}

function conciergeCategory(text: string): ConciergeCategory {
  if (has(text, 'transfer', 'driver', 'chauffeur', 'flight', 'hotel', 'airport', 'car ', 'visa', 'jet')) return 'travel';
  if (has(text, 'spa', 'massage', 'trainer', 'yoga', 'treatment')) return 'wellness';
  if (has(text, 'ticket', 'concert', 'show', 'theatre', 'match', 'game')) return 'entertainment';
  if (has(text, 'gift', 'flowers', 'errand', 'tailor')) return 'personal';
  return 'hospitality';
}

/** Which kind of partner or service a request is about, judged from its wording. */
function wantedKind(text: string): RegExp | null {
  if (has(text, 'table', 'restaurant', 'dinner', 'lunch', 'brunch', 'eat', 'chef', 'dining')) return /dining|restaurant|chef|culinary|kitchen/i;
  if (has(text, 'spa', 'massage', 'wellness', 'treatment', 'sauna', 'gym', 'trainer', 'iv drip', 'facial', 'skin')) return WELLNESS;
  if (has(text, 'driver', 'chauffeur', 'transfer', 'car ', 'airport')) return /mobility|chauffeur|car|motion/i;
  if (has(text, 'yacht', 'boat', 'charter', 'sail')) return /yacht|charter|boat/i;
  if (has(text, 'villa', 'stay', 'suite', 'hotel')) return /hospitality|villa|hotel|stay/i;
  if (has(text, 'photo', 'shoot', 'video', 'film')) return /photo|video|studio/i;
  if (has(text, 'stylist', 'styling', 'makeup', 'make-up', 'beauty')) return /styling|beauty|makeup|make-up/i;
  return null;
}

export const QERA_HELP = 'I am QÉRA, the Quintara Intelligence. I can tell you about Quintara, recommend what suits you, reserve or cancel a seat, book partners and services from the directory, and prepare a plan for a day, a weekend or a holiday as a Quintara document and book the whole of it at once. As your Chief of Staff I remember what you tell me to, brief you on your week and remind you of what matters. I always ask before I do anything on your behalf, and I refer to Ms. Palesa Makam, your Lifestyle Curator, only what I cannot manage myself.';
const REFER = 'That is beyond what I can arrange myself.';
/** The first sentence of a description, lower-cased, to name a service in a list. */
const firstSentence = (text: string) => { const first = (/^[^.!?]*/.exec(text.trim())?.[0] ?? '').trim(); return first ? first[0]!.toLowerCase() + first.slice(1) : ''; };
export const QERA_GUEST_HELP = 'I am QÉRA, the Quintara Intelligence. As a guest you can ask me about Quintara, its signature experiences, its lifestyle partners and services, Maison Quintara and Quintara TV, and I will recommend what might suit you. Booking, plans and introductions are for members: apply for membership and I can arrange them for you.';
export const QERA_GUEST_MEMBERS_ONLY = 'Booking, prepared plans and introductions are for members. Apply for membership from the Apply page, and once you are in I can arrange it for you. In the meantime, guests can request a lifestyle service from the Lifestyle page.';
/** "Title, Saturday 10 October, 19:00 in Constantia (12 seats left, R 1 200 a seat)", leaving out what the viewer may not see. */
const experienceLine = (e: QeraExperience) => {
  const notes = [...(e.seatsLeft === null ? [] : [e.seatsLeft > 0 ? `${e.seatsLeft} seats left` : 'waitlist']), e.price];
  return `${e.title}${e.when ? `, ${e.when}` : ''} in ${e.area} (${notes.join(', ')})`;
};

/** Understands a set of common requests by their wording. Deterministic, and needs no outside service. */
export class RuleBasedQeraModel implements QeraModel {
  readonly name = 'rules';
  /** `today` is supplied by tests; otherwise it is the current date in South Africa. */
  private readonly today: () => string;
  constructor(today: () => string = () => isoDay(new Date(Date.now() + 2 * 3_600_000))) { this.today = today; }

  async next({ message, results, tools, audience = 'member' }: { message: string; results: QeraResult[]; tools: QeraToolName[]; audience?: QeraAudience }): Promise<QeraStep> {
    const text = message.toLowerCase();
    const guest = audience === 'guest';
    const can = (name: QeraToolName) => tools.includes(name);
    const got = <T>(name: QeraToolName) => results.find((result) => result.name === name)?.data as T | undefined;
    const call = (name: QeraToolName, args: Record<string, unknown> = {}): QeraStep => ({ toolCall: { name, args } });
    const refer = (lead = REFER): QeraStep => {
      const details = message.trim();
      if (guest) return { reply: `${lead} ${QERA_GUEST_MEMBERS_ONLY}` };
      if (!can('create_concierge_request')) return { reply: `${lead} Please ask the concierge desk.` };
      if (details.length < 15) return { reply: `${lead} Tell me a little more (when, for how many, and anything the Lifestyle Curator should know) and I will refer it to her.` };
      const subject = details.length > 110 ? `${details.slice(0, 107).trimEnd()}...` : details;
      return call('create_concierge_request', { category: conciergeCategory(text), subject: subject[0]!.toUpperCase() + subject.slice(1), details });
    };

    if (has(text, 'cancel') && has(text, 'booking', 'seat', 'reservation', 'place', 'ticket') && can('cancel_booking')) {
      const bookings = got<QeraBooking[]>('list_bookings');
      if (!bookings) return call('list_bookings');
      const live = bookings.filter((b) => ['confirmed', 'applied', 'waitlisted', 'awaiting_payment'].includes(b.status));
      if (!live.length) return { reply: 'You have no bookings to cancel.' };
      const match = pick(live, (b) => b.title, message) ?? (live.length === 1 ? live[0]! : null);
      return match ? call('cancel_booking', { bookingId: match.id }) : { reply: `Which booking? You have ${list(live.map((b) => b.title))}.` };
    }

    // A plan that has just been prepared: say where it is.
    const made = got<{ title: string; days: number; lines: number }>('create_itinerary');
    if (made) return { reply: `I have prepared “${made.title}”: ${made.days} day${made.days > 1 ? 's' : ''}, ${made.lines} suggestions, drawn from Quintara’s experiences, partners and services. It is under Documents, ready to read, print or save. Nothing in it is booked yet. Say “book the whole plan for two” and I will book every line at once, after you confirm, or open it to choose the lines yourself.` };
    const asking = /^(what|which|who|how|where|when|do you|does|is there|are there|tell me)\b/.test(text.trim());

    // A guest asking QÉRA to act: say plainly what membership adds, instead of half-doing it.
    if (guest && !asking && (has(text, 'itinerary', 'itinery', 'plan my', 'plan a', 'plan for', 'plan me', 'book', 'reserve', 'rsvp', 'a seat', 'a table', 'appointment', 'arrange', 'organise', 'organize', 'hire', 'charter', 'connect me', 'introduce me', 'cancel my', 'my booking'))) {
      return { reply: QERA_GUEST_MEMBERS_ONLY };
    }

    /* Chief of Staff: what QÉRA remembers, reminders, the weekly brief, and booking a whole plan. */
    const remembered = got<QeraMemoryFact[]>('list_memory');
    if (can('list_memory') && /what do you (know|remember) about me|what have you remembered|what do you remember|my preferences|show (me )?my memory/.test(text)) {
      if (!remembered) return call('list_memory');
      if (!remembered.length) return { reply: 'I do not remember anything about you yet. Tell me, for example, “remember that I am vegetarian” or “remember our anniversary is on 14 November”, or add it yourself under QÉRA, Memory.' };
      const byKind = new Map<string, string[]>();
      for (const m of remembered) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m.date ? `${m.label} (${dayAndMonth(m.date)})` : m.label]);
      const names: Record<string, string> = { dietary: 'Dietary', likes: 'You like', favourite: 'Favourites', date: 'Dates', person: 'People', note: 'Notes' };
      return { reply: `Here is what I remember:\n${[...byKind].map(([k, v]) => `${names[k] ?? k}: ${v.join('; ')}.`).join('\n')}\nYou can change or remove any of it under QÉRA, Memory.` };
    }
    if (can('forget') && /^(please )?(forget|stop remembering)\b/.test(text.trim())) {
      if (!remembered) return call('list_memory');
      const what = message.replace(/^(please )?(forget|stop remembering)\s+(that\s+|about\s+)?/i, '').trim();
      const match = pick(remembered, (m) => `${m.label} ${m.detail}`, what);
      return match ? call('forget', { memoryId: match.id }) : { reply: remembered.length ? `I could not tell which you mean. I remember ${list(remembered.slice(0, 6).map((m) => m.label))}.` : 'I do not remember anything about you yet.' };
    }
    if (can('remember') && /^(please )?(remember|note|keep in mind)\b/.test(text.trim())) {
      const raw = message.trim().replace(/^(please\s+)?(remember|note|keep in mind)\s+(that\s+)?/i, '').replace(/[.!]+$/, '').trim();
      if (raw.length < 2) return { reply: 'What would you like me to remember?' };
      const t = raw.toLowerCase(), date = dateIn(raw, this.today());
      const kind = /vegetarian|vegan|pescatarian|allerg|intoleran|halal|kosher|gluten|lactose|dairy|no pork|no meat|(don't|do not) eat|diet/.test(t) ? 'dietary'
        : /birthday|anniversary|born on|wedding day/.test(t) && date ? 'date'
        : /\bmy (wife|husband|partner|son|daughter|children|kids|assistant|mother|father|mom|mum|dad|fianc[eé]e?)\b/.test(t) ? 'person'
        : /favourite|favorite/.test(t) ? 'favourite'
        : /\bi (like|love|enjoy|prefer)\b|\bwe (like|love|enjoy|prefer)\b/.test(t) ? 'likes' : 'note';
      const label = (kind === 'dietary' ? raw.replace(/^(i am|i'm|we are|we're)\s+/i, '') : kind === 'date' ? raw.replace(/\s+(is\s+|falls\s+)?(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\s+\w+.*$/i, '').replace(/\s+(is|falls)\s+on\s+.*$/i, '') : kind === 'likes' ? raw.replace(/^(i|we)\s+(like|love|enjoy|prefer)\s+/i, '') : raw).slice(0, 120);
      return call('remember', { kind, label: label[0]!.toUpperCase() + label.slice(1), detail: '', date: kind === 'date' ? date : null });
    }
    if (can('set_reminder') && /\bremind me\b/.test(text)) {
      const what = message.replace(/^.*?\bremind me\s+(to\s+|about\s+|that\s+)?/i, '').replace(/\s+(on|at|by|tomorrow|today|tonight|this|next)\b.*$/i, '').replace(/[.!?]+$/, '').trim();
      if (what.length < 2) return { reply: 'What would you like me to remind you about, and when?' };
      return call('set_reminder', { text: what[0]!.toUpperCase() + what.slice(1), date: dateIn(message, this.today()) ?? addDays(this.today(), 1), time: timeIn(message) ?? '09:00' });
    }
    if (can('weekly_brief') && /\b(my week|this week for me|week ahead|weekly brief|brief me|my brief|what'?s on for me)\b/.test(text)) {
      const brief = got<{ sections: { title: string; items: { title: string; detail: string }[] }[] }>('weekly_brief');
      if (!brief) return call('weekly_brief');
      const parts = brief.sections.filter((x) => x.items.length).map((x) => `${x.title}: ${x.items.slice(0, 3).map((i) => `${i.title}${i.detail ? ` (${i.detail.replace(/\.$/, '')})` : ''}`).join('; ')}.`);
      return { reply: parts.length ? `Your week:\n${parts.join('\n')}` : 'Your week is clear. Shall I suggest something?' };
    }
    if (can('book_plan') && !asking && /\bbook\b/.test(text) && /\b(plan|itinerary|itinery|whole thing|everything|all of it)\b/.test(text)) {
      return call('book_plan', { documentId: 'latest', partySize: seatsIn(message) });
    }

    // A plan for a day, a weekend or a holiday, prepared as a document.
    if (has(text, 'itinerary', 'itinery', 'plan my', 'plan a', 'plan for', 'plan the', 'plan me', 'programme for', 'schedule for') && can('create_itinerary')) {
      const kind = has(text, 'holiday', 'vacation', 'trip', 'days', 'week ') ? 'holiday' : has(text, 'weekend') ? 'weekend' : 'day';
      const count = /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:day|night)s?\b/.exec(text);
      const days = kind === 'day' ? 1 : kind === 'weekend' ? 2 : Math.min(14, Math.max(2, count ? (NUMBER_WORDS[count[1]!] ?? Number(count[1])) : 5));
      const startDate = dateIn(kind === 'weekend' && !/\b(saturday|sunday|friday)\b/.test(text) ? `${text} weekend` : text, this.today()) ?? addDays(this.today(), 1);
      const about = /\b(?:with|including|around|focused on|focus on|i like|i love|i enjoy|we like|we love)\b(.*)$/i.exec(message.trim());
      return call('create_itinerary', { kind, startDate, days, focus: (about?.[1] ?? '').trim().replace(/[.?!]+$/, '').slice(0, 200) });
    }

    // Booking: an experience, a partner from the directory, or a service, whichever the message names.
    if (has(text, 'book', 'reserve', 'rsvp', 'a seat', 'seats at', 'seats for', 'get me in', 'a table', 'appointment', 'arrange', 'organise', 'organize', 'hire', 'charter') && !asking && (can('book_experience') || can('book_partner') || can('request_service'))) {
      const experiences = can('list_experiences') ? got<QeraExperience[]>('list_experiences') : [];
      if (!experiences) return call('list_experiences');
      const partners = can('list_partners') ? got<QeraPartner[]>('list_partners') : [];
      if (!partners) return call('list_partners');
      const services = can('list_services') ? got<QeraService[]>('list_services') : [];
      if (!services) return call('list_services');
      const e = pick(experiences, (x) => x.title, message), p = pick(partners, (x) => x.name, message), sv = pick(services, (x) => x.name, message);
      const best = Math.max(e ? score(e.title, message) : 0, p ? score(p.name, message) : 0, sv ? score(sv.name, message) : 0);
      const date = dateIn(message, this.today());
      if (best > 0 && e && score(e.title, message) === best && can('book_experience')) return call('book_experience', { experienceId: e.id, seats: seatsIn(message) });
      if (best > 0 && p && score(p.name, message) === best && can('book_partner')) {
        // Without a contact in the directory there is nobody for QÉRA to write to: the Lifestyle Curator takes it.
        if (!p.bookable || !p.id) return refer(`${p.name} has no booking contact in the directory yet, so this is one for your Lifestyle Curator.`);
        if (!date) return { reply: `I can book ${p.name} for you. For which date, at what time, and for how many?` };
        return call('book_partner', { partnerId: p.id, date, time: timeIn(message), partySize: seatsIn(message), notes: '' });
      }
      if (best > 0 && sv && can('request_service')) return call('request_service', { serviceId: sv.id, date, notes: message.trim().slice(0, 1000) });
      // Nothing named: offer what Quintara has of that kind before involving anybody else.
      const kind = wantedKind(text);
      const fits = kind ? [...partners.filter((x) => x.bookable && kind.test(`${x.category} ${x.name} ${x.offer ?? ''}`)).map((x) => x.name), ...services.filter((x) => kind.test(`${x.name} ${x.description}`)).map((x) => x.name)] : [];
      if (fits.length) return { reply: `I can book ${list(fits.slice(0, 4))} for you. Tell me which, the date, and for how many, and I will send the booking.` };
      if (has(text, 'book', 'reserve', 'rsvp', 'seat') && experiences.length && !kind) return { reply: `I could not tell which you mean. On the calendar: ${list(experiences.slice(0, 5).map((x) => x.title))}.` };
      return refer();
    }

    if (has(text, 'my booking', 'my ticket', 'have i booked', 'am i booked', 'my reservations', 'attending') && can('list_bookings')) {
      const bookings = got<QeraBooking[]>('list_bookings');
      if (!bookings) return call('list_bookings');
      const made = can('list_partner_bookings') ? got<QeraPartnerBooking[]>('list_partner_bookings') : [];
      if (!made) return call('list_partner_bookings');
      const live = bookings.filter((b) => !['cancelled', 'declined'].includes(b.status)), withPartners = made.filter((b) => !['cancelled', 'declined'].includes(b.status));
      const parts = [
        ...(live.length ? [`${list(live.map((b) => `${b.title} on ${b.when} (${b.status.replace('_', ' ')}, ${b.seats} seat${b.seats > 1 ? 's' : ''})`))}`] : []),
        ...(withPartners.length ? [`with partners, ${list(withPartners.map((b) => `${b.partner} on ${b.when} for ${b.partySize} (${b.status})`))}`] : []),
      ];
      return { reply: parts.length ? `You have ${parts.join('; ')}.` : 'You have nothing booked at the moment.' };
    }

    if (has(text, 'connect me', 'connect with') && can('request_connection') && can('search')) {
      const found = got<QeraFound[] & { id?: string }[]>('search');
      const name = words(message).filter((word) => word.length >= 3 && !SMALL.has(word) && word !== 'me').pop();
      if (!found) return name ? call('search', { query: name }) : { reply: 'Who would you like to connect with?' };
      const person = (found as unknown as { kind: string; id: string; title: string }[]).find((r) => r.kind === 'member');
      return person ? call('request_connection', { memberId: person.id }) : { reply: 'I could not find a member by that name.' };
    }

    // Recommendations chosen for this member.
    if (has(text, 'recommend', 'suggest', 'what should i', 'ideas', 'inspire', 'what do you think i', 'for me') && can('recommend')) {
      const r = got<QeraRecommendation>('recommend');
      if (!r) return call('recommend');
      const lines = [
        ...(r.experiences.length ? [`Experiences: ${r.experiences.slice(0, 3).map((e) => `${e.title}${e.when ? `, ${e.when}` : ''}${e.seatsLeft === null ? '' : ` (${e.seatsLeft > 0 ? `${e.seatsLeft} seats left` : 'waitlist'})`}`).join('; ')}.`] : []),
        ...(r.partners.length ? [`Partners: ${r.partners.slice(0, 3).map((p) => `${p.name}${p.privileges[0] ? ` (${p.privileges[0]})` : ''}`).join('; ')}.`] : []),
        ...(r.services.length ? [`Services: ${list(r.services.slice(0, 3).map((x) => x.name))}.`] : []),
        ...(r.people.length ? [`People to meet: ${r.people.slice(0, 2).map((p) => `${p.name}, ${p.role}`).join('; ')}.`] : []),
      ];
      if (r.dietary?.length && lines.length) lines.push(`I have kept your dietary needs in mind: ${list(r.dietary)}.`);
      return { reply: lines.length ? `${r.interests.length ? `With your interest in ${list(r.interests.slice(0, 3).map((i) => i.toLowerCase()))} in mind, here is what I would choose.` : 'Here is what I would choose for you.'}\n${lines.join('\n')}\n${guest ? 'Members can book any of these through me. Apply for membership to begin.' : 'Say the word and I will book any of them, or prepare a plan around them.'}` : 'I have nothing to recommend just now.' };
    }

    if (has(text, 'meet', 'introduc', 'who should', 'network') && can('list_suggestions')) {
      const people = got<QeraPerson[]>('list_suggestions');
      if (!people) return call('list_suggestions');
      return { reply: people.length ? `People worth meeting: ${people.map((p) => `${p.name}, ${p.role} (${p.reasons[0]?.toLowerCase() ?? 'a good fit'})`).join('; ')}. Open one from the Members page to connect.` : 'I have nobody to suggest just now. Adding what you are looking for to your profile helps.' };
    }

    // About Quintara itself.
    const aboutTopics: [string, string[]][] = [
      ['membership', ['membership', 'tier', 'join', 'renew', 'fee', 'member benefit']], ['relationship', ['relationship manager', 'wayne', 'huffton', 'bmm']], ['concierge', ['concierge', 'curator', 'palesa']],
      ['business', ['business', 'opportunit', 'invest', 'listing']], ['boutique', ['boutique', 'maison', 'shop', 'deliver', 'order']], ['tv', ['quintara tv', ' tv', 'programme', 'episode', 'film']],
      ['lifestyle', ['lifestyle', 'directory']], ['experiences', ['signature experience', 'kinds of experience', 'types of experience']], ['privacy', ['privacy', 'my data', 'personal information', 'popia']], ['chief', ['chief of staff', 'what can you do for me']], ['qera', ['who are you', 'what are you', 'qera', 'qéra']],
    ];
    const asked = aboutTopics.filter(([, needles]) => has(text, ...needles)).map(([topic]) => topic);
    if ((asked.length || has(text, 'what is quintara', 'about quintara', 'tell me about quintara', 'what does quintara', 'how does quintara', 'quintara offer', 'explain quintara', 'the company')) && can('about_quintara') && !has(text, 'privilege', 'perk')) {
      const facts = got<QeraFact[]>('about_quintara');
      if (!facts) return call('about_quintara');
      const chosen = asked.length ? facts.filter((f) => asked.includes(f.topic)) : facts.filter((f) => ['overview', 'experiences', 'lifestyle', 'business'].includes(f.topic));
      if (chosen.length) return { reply: chosen.map((f) => f.text).join('\n') };
    }

    if (has(text, 'service') && can('list_services')) {
      const services = got<QeraService[]>('list_services');
      if (!services) return call('list_services');
      return { reply: services.length ? `${guest ? 'Services you can request from the Lifestyle page' : 'Services I can arrange'}: ${services.map((x) => `${x.name} (${firstSentence(x.description)}${x.packages?.[0] ? `; from ${x.packages[0].price}` : ''})`).join('; ')}. ${guest ? 'The concierge desk confirms each request.' : 'Tell me which one, and when.'}` : 'No services are on offer at the moment.' };
    }

    if (has(text, 'privilege', 'partner', 'perk', 'benefit') && can('list_partners')) {
      const partners = got<QeraPartner[]>('list_partners');
      if (!partners) return call('list_partners');
      if (guest) return { reply: partners.length ? `Quintara's lifestyle partners include ${list(partners.slice(0, 6).map((p) => `${p.name} (${p.category.toLowerCase()})`))}. Their privileges are for members.` : 'The partner directory is being prepared.' };
      const open = partners.filter((p) => p.privileges.length);
      return { reply: open.length ? `Privileges open to you: ${open.map((p) => `${p.name} (${list(p.privileges)})`).join('; ')}. You can get your code under Lifestyle, and I can book any of them for you.` : 'There are no privileges open to you at the moment.' };
    }

    if (has(text, "what's on", 'whats on', 'what is on', 'experience', 'event', 'this month', 'this week', 'calendar', 'coming up', 'happening') && can('list_experiences')) {
      const experiences = got<QeraExperience[]>('list_experiences');
      if (!experiences) return call('list_experiences');
      const wanted = pick(experiences, (e) => `${e.category} ${e.area}`, message);
      const shown = (wanted ? experiences.filter((e) => e.category === wanted.category || e.area === wanted.area) : experiences).slice(0, 4);
      return { reply: shown.length ? `${guest ? 'Open to guests' : 'Coming up'}: ${shown.map(experienceLine).join('; ')}. ${guest ? 'Dates and seats are shared with members; apply for membership to book.' : 'Tell me if you would like a seat at any of them.'}` : 'Nothing is on the calendar just now.' };
    }

    if (has(text, 'help', 'what can you do', 'hello', 'hi ', 'hey') || text.trim() === 'hi') return { reply: guest ? QERA_GUEST_HELP : QERA_HELP };

    // Something to be arranged that names nothing Quintara has: see what there is of that kind, then refer.
    if (has(text, 'restaurant', 'dinner', 'lunch', 'transfer', 'driver', 'chauffeur', 'flight', 'hotel', 'concierge', 'massage', 'tickets to', 'gift', 'flowers', 'visa', 'jet', 'nanny', 'babysit', 'tailor')) {
      const kind = wantedKind(text);
      if (kind && can('list_partners') && can('list_services')) {
        const partners = got<QeraPartner[]>('list_partners');
        if (!partners) return call('list_partners');
        const services = got<QeraService[]>('list_services');
        if (!services) return call('list_services');
        const fits = [...partners.filter((x) => x.bookable && kind.test(`${x.category} ${x.name} ${x.offer ?? ''}`)).map((x) => x.name), ...services.filter((x) => kind.test(`${x.name} ${x.description}`)).map((x) => x.name)];
        if (fits.length) return { reply: `I can book ${list(fits.slice(0, 4))} for you. Tell me which, the date, and for how many, and I will send the booking.` };
      }
      return refer();
    }

    if (can('search')) {
      const found = got<QeraFound[]>('search');
      const keyword = words(message).filter((word) => word.length >= 4 && !SMALL.has(word)).sort((a, b) => b.length - a.length)[0];
      if (!found) return keyword ? call('search', { query: keyword }) : { reply: guest ? QERA_GUEST_HELP : QERA_HELP };
      if (found.length) return { reply: `Here is what I found: ${found.slice(0, 5).map((r) => `${r.title} (${r.detail})`).join('; ')}.` };
    }
    // A request in the member's own words that nothing above could manage goes to the Lifestyle Curator.
    if (message.trim().length >= 25 && can('create_concierge_request')) return refer('I could not find that at Quintara, and it is not something I can arrange myself.');
    return { reply: `I did not find anything for that. ${guest ? QERA_GUEST_HELP : QERA_HELP}` };
  }
}
