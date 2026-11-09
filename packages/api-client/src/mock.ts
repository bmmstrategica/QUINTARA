/**
 * In-memory implementation of QuintaraApi.
 *
 * It applies the same rules the real API will (permissions, admission types,
 * capacity, validation), so screens can be built and tested against real
 * behaviour, including their error and permission-denied states.
 * All names, venues, dates and prices below are placeholder content.
 */
import {
  applicationSchema,
  can,
  conciergeRequestSchema,
  introductionRequestSchema, listingInputSchema, rmEnquiryInputSchema, serviceRequestInputSchema, orderInputSchema, memberReportSchema, messageBodySchema,
  profileUpdateSchema, deliveryFee, suggestMatches, formatDateTime, LISTING_KIND_LABEL, qeraMessageSchema, qeraTurn, RuleBasedQeraModel, composeItinerary, longDay, CONCIERGE_SPECIALIST, formatMoney, BOOKING_STATUS_LABEL, guestAccountSchema, GUEST_QERA_DAILY_SECONDS, packagePriceLabel, leadTimeLabel, earliestDate, qeraMemoryInputSchema, reminderInputSchema, planBookingInputSchema, MEMORY_KIND_LABEL, bookingOffer, calendarConnectSchema, SECTION_KEYS, SECTION_DEFAULTS, whatsAppLinkSchema, linkMessage, waMeLink, WHATSAPP_CODE_MINUTES, BUILTIN_QUESTION_KEYS, BUILTIN_QUESTION_DEFAULTS, DEFAULT_MEMBERSHIP_PLANS, planName, CALENDAR_HOSTS, CALENDAR_PROVIDER_LABEL, SAMPLE_CALENDAR_WEEK, localToInstant, pushRegistrationSchema, pushSettingsInputSchema, paymentMethodInputSchema, RENEWAL_GRACE_DAYS } from '@quintara/domain';
import type {
  MembershipPlan,
  WhatsAppLink,
  AppNotification,
  Application,
  ApplicationData,
  Booking,
  BookingStatus,
  ChatMessage,
  ConciergeRequest,
  ConversationThread,
  Experience,
  MemberProfile,
  Permission,
  Session, Partner, Privilege, Redemption, BusinessListing, BusinessPerson, BusinessRole, BusinessUpdate, RmEnquiry, LifestyleService, ServiceRequest, PartnerBooking, QeraDocument, QeraExperience, QeraPartner, Introduction, ListingKind, Order, Product, DeliveryOption, TvEpisode, SearchResult, QeraMessage, QeraProposal, QeraThread, QeraToolbox, QeraToolName, QeraUsage, GuestAccount, Market, ConciergeCategory, ServicePackage, QeraMemoryItem, QeraMemorySuggestion, QeraReminder, WeeklyBrief, BriefItem, CalendarState, CalendarProvider, CalendarEvent, DailyBrief, DailyItem, PlanLine, PlanBookingResult, ItineraryContent, QeraService, NotificationCategory, PushDevice, MembershipRenewalPayment, MembershipStatus } from '@quintara/domain';
import { ApiError } from './index.ts';
import type { QuintaraApi } from './index.ts';

/** A stand-in for Quintara's WhatsApp Business number. */
const MOCK_WHATSAPP_NUMBER = '+27 21 000 0000';

/** The standard plans, with fixed ids so the mock behaves the same on every load. */
const MOCK_PLANS: MembershipPlan[] = DEFAULT_MEMBERSHIP_PLANS.map((p, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, name: planName(p.residency, p.termMonths), residency: p.residency, termMonths: p.termMonths, priceMinor: p.priceMinor, currency: 'ZAR' }));

/** Minimal synchronous storage, satisfied by `window.localStorage`. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MockApiOptions {
  /** Persist state between reloads. Omit for a fresh in-memory API. */
  storage?: KeyValueStore;
  /** Simulated network delay in milliseconds, so loading states are visible. */
  latencyMs?: number;
  /** A guest's daily QÉRA allowance in seconds. Tests shorten it. */
  guestQeraSeconds?: number;
}

const STORAGE_KEY = 'quintara.mock.v1';
const ZONE = 'Africa/Johannesburg';
const MARKET = 'market-cape-town';
const JOBURG = 'market-johannesburg';

type ExperienceSeed = Omit<Experience, 'invited' | 'seatsTaken' | 'startsAt' | 'capacity' | 'openToGuests'> & { startsAt: string; capacity: number; openToGuests?: boolean; baseSeatsTaken: number; hidden: boolean; invitedMemberIds: string[] };
type MemberSeed = Omit<MemberProfile, 'connection' | 'avatarPath'>;

const JOBURG_EXPERIENCES: ExperienceSeed[] = [
  { id: 'exp-rooftop-supper', marketId: JOBURG, title: 'The Rooftop Supper', category: 'Fine dining', summary: 'A long table above the city, and a chef cooking for thirty.', description: 'A long table above the city, and a chef cooking for thirty.',
    startsAt: '2026-10-24T16:30:00Z', timezone: ZONE, venueName: 'A private rooftop', area: 'Sandton', dressCode: 'Smart', host: 'Quintara', programme: [], included: [],
    capacity: 30, baseSeatsTaken: 0, priceMinor: 180000, memberPriceMinor: 180000, currency: 'ZAR', admission: 'members_only', guestPolicy: 'One guest per member.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [], openToGuests: false },
  { id: 'exp-founders-breakfast', marketId: JOBURG, title: 'Founders Breakfast', category: 'Networking', summary: 'An early table for founders and the people who back them.', description: 'An early table for founders and the people who back them.',
    startsAt: '2026-11-06T05:30:00Z', timezone: ZONE, venueName: 'A private dining room', area: 'Rosebank', dressCode: 'Smart', host: 'Quintara', programme: [], included: [],
    capacity: 24, baseSeatsTaken: 0, priceMinor: 0, memberPriceMinor: 0, currency: 'ZAR', admission: 'open', guestPolicy: 'One guest per member.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [], openToGuests: true },
];
const EXPERIENCES: ExperienceSeed[] = [
  {
    id: 'exp-costa-convivio', marketId: MARKET, title: 'Costa Convivio', category: 'Retreats',
    summary: 'The Cape Winelands retreat. An exquisite escape, a shared table, a deeper connection.',
    description: 'Costa Convivio is Quintara\u2019s signature retreat experience, bringing together wellness, gastronomy, culture and meaningful connection in exceptional surroundings. Set against the beauty of the Cape Winelands, it offers an intimate escape for those who appreciate thoughtful hospitality, engaging company and the pleasure of a day beautifully spent. From leisurely mornings and vineyard discoveries to elegant dining and conversations that linger, it creates space to reconnect with yourself, with nature and with an inspiring circle of people.',
    startsAt: '2026-10-11T08:00:00Z', timezone: ZONE, venueName: 'A private wine estate', area: 'Cape Winelands', dressCode: 'Linen and colour', host: 'Aisha Parker',
    programme: [{ time: '10:00', title: 'Arrival and a leisurely morning' }, { time: '11:30', title: 'Vineyard discovery' }, { time: '13:30', title: 'Lunch at the shared table' }],
    included: ['Wellness session', 'Vineyard discovery', 'Lunch with estate wines'],
    capacity: 40, baseSeatsTaken: 21, priceMinor: 145000, memberPriceMinor: 115000, currency: 'ZAR',
    admission: 'open', guestPolicy: 'Members may bring up to three guests.', maxSeatsPerBooking: 4, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-episimo-dipno', marketId: MARKET, title: 'Ep\u00edsimo D\u00edpno', category: 'Fine dining',
    summary: 'The art of dining. Considered hospitality, remarkable cuisine and conversations that deserve an evening of their own.',
    description: 'Ep\u00edsimo D\u00edpno is Quintara\u2019s signature fine dining experience, bringing together a carefully curated circle of members and invited guests around one beautifully appointed table. Set within distinguished restaurants, intimate private residences and exceptional hospitality destinations, each edition celebrates the pleasure of dining well and the people who make it memorable. From the welcome drink to the final conversation, every detail serves a shared purpose: an evening of warmth, discovery and meaningful connection.',
    startsAt: '2026-10-17T17:00:00Z', timezone: ZONE, venueName: 'A private residence', area: 'Constantia', dressCode: 'Black tie', host: 'Quintara',
    programme: [{ time: '19:00', title: 'Welcome drink' }, { time: '20:00', title: 'Dinner at one table' }, { time: '23:00', title: 'The final conversation' }],
    included: ['Welcome drink', 'Dinner with paired wines'],
    capacity: 24, baseSeatsTaken: 24, priceMinor: 240000, memberPriceMinor: 240000, currency: 'ZAR',
    admission: 'members_only', guestPolicy: 'One guest per member.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-founder-rally', marketId: MARKET, title: 'The Penthouse Sessions', category: 'Conversations',
    summary: 'Hosted in Cape Town\u2019s most exclusive penthouses, for a small audience of 20 to 30 guests.',
    description: 'Intimate sessions on entrepreneurship, wealth, artificial intelligence, leadership, luxury and venture capital, hosted in Cape Town\u2019s most exclusive penthouses. The audience is kept to 20 to 30 guests, so seats are allocated by the Quintara team.',
    startsAt: '2026-10-22T16:00:00Z', timezone: ZONE, venueName: 'A private penthouse', area: 'Cape Town', dressCode: 'Smart', host: 'Sipho Ndlovu',
    programme: [{ time: '18:00', title: 'Arrival' }, { time: '18:30', title: 'The session' }, { time: '20:00', title: 'Drinks and conversation' }],
    included: ['The session', 'Drinks'],
    capacity: 30, baseSeatsTaken: 12, priceMinor: 0, memberPriceMinor: 0, currency: 'ZAR',
    admission: 'application_required', guestPolicy: 'Members only. No guests.', maxSeatsPerBooking: 1, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-invitational', marketId: MARKET, title: 'Quintara Golf Invitational', category: 'Golf',
    summary: 'A private golf networking day, by invitation.',
    description: 'A private golf networking day with luxury hospitality, pairings that bring investors, founders and creatives together, and executive networking from the first tee to the clubhouse.',
    startsAt: '2026-10-29T05:30:00Z', timezone: ZONE, venueName: 'Steenberg Golf Club', area: 'Tokai', dressCode: 'Club golf attire', host: 'Daniel Fourie',
    programme: [{ time: '07:30', title: 'Breakfast and registration' }, { time: '08:30', title: 'Shotgun start' }, { time: '13:30', title: 'Lunch and networking' }],
    included: ['Luxury hospitality', 'Curated pairings', 'Executive networking'],
    capacity: 48, baseSeatsTaken: 30, priceMinor: 320000, memberPriceMinor: 320000, currency: 'ZAR',
    admission: 'invitation_only', guestPolicy: 'Invitations are personal.', maxSeatsPerBooking: 1, hidden: true, invitedMemberIds: ['mem-thandi'],
  },
  {
    id: 'exp-code-capital', marketId: MARKET, title: 'The Executive Yacht Club', category: 'Networking',
    summary: 'Networking aboard a luxury yacht along the Atlantic Seaboard.',
    description: 'A sunset cruise along the Atlantic Seaboard with a champagne reception, live music and gourmet dining. Investor introductions are arranged by the Quintara team on request.',
    startsAt: '2026-11-05T16:00:00Z', timezone: ZONE, venueName: 'Aboard a private yacht', area: 'Atlantic Seaboard', dressCode: 'Yacht smart', host: 'Quintara',
    programme: [{ time: '18:00', title: 'Boarding and champagne reception' }, { time: '18:45', title: 'Sunset cruise and live music' }, { time: '20:00', title: 'Dinner and introductions' }],
    included: ['Champagne reception', 'Gourmet dining', 'Live music'],
    capacity: 60, baseSeatsTaken: 18, priceMinor: 0, memberPriceMinor: 0, currency: 'ZAR',
    admission: 'members_only', guestPolicy: 'One guest per member.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-aura-enclave', marketId: MARKET, title: 'The Aura Enclave', category: 'Signature evenings',
    summary: 'A Gatsby experience. An era reimagined, not recreated.',
    description: 'An exquisite evening. An intriguing encounter. The beginning of summer. As the last light of a Cape Town afternoon dissolves into gold across the Atlantic, Quintara opens its most anticipated chapter of the year. The Aura Enclave is not simply an event; it is an invitation into a world where elegance is not performed, but lived; where the romance of a bygone era meets the unmistakable pulse of the city\u2019s most sought-after private circle. This is summer, as it was always meant to be entered: beautifully, deliberately, and among company worth remembering.',
    startsAt: '2026-11-13T16:00:00Z', timezone: ZONE, venueName: 'A private address', area: 'Atlantic Seaboard', dressCode: 'Gatsby, reimagined', host: 'Quintara',
    programme: [{ time: '18:00', title: 'Arrival at golden hour' }, { time: '19:30', title: 'The evening opens' }, { time: '22:00', title: 'Late music' }],
    included: ['Welcome reception', 'Dinner', 'Music'],
    capacity: 120, baseSeatsTaken: 115, priceMinor: 450000, memberPriceMinor: 380000, currency: 'ZAR',
    admission: 'open', guestPolicy: 'One guest per booking.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-investor-circle', marketId: MARKET, title: 'The Investor Circle', category: 'Investment',
    summary: 'Cape Town\u2019s premier invitation-only investment breakfast.',
    description: 'An exclusive breakfast for family offices, venture capitalists, angel investors and founders. Topics include investment trends, capital raising, deal sourcing, wealth creation and cross-border investment.',
    startsAt: '2026-11-19T05:30:00Z', timezone: ZONE, venueName: 'A private dining room', area: 'Cape Town', dressCode: 'Business', host: 'Daniel Fourie',
    programme: [{ time: '07:30', title: 'Arrival and coffee' }, { time: '08:00', title: 'Breakfast and discussion' }, { time: '09:30', title: 'Introductions' }],
    included: ['Breakfast'],
    capacity: 24, baseSeatsTaken: 10, priceMinor: 0, memberPriceMinor: 0, currency: 'ZAR',
    admission: 'invitation_only', guestPolicy: 'Invitations are personal.', maxSeatsPerBooking: 1, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-tennis-social', marketId: MARKET, title: 'Quintara Tennis Social', category: 'Sport and wellness',
    summary: 'Play. Connect. Inspire.',
    description: 'A members-only, invitation-only networking experience that brings together a curated community of 15 to 20 entrepreneurs, startup founders, investors, executives and premium digital creators for an afternoon of sport, wellness, meaningful conversation and luxury hospitality. It is not a competitive tournament, but a sophisticated lifestyle gathering where business relationships are cultivated through shared experiences in a relaxed and elegant environment.',
    startsAt: '2026-11-21T12:00:00Z', timezone: ZONE, venueName: 'A private tennis club', area: 'Cape Town', dressCode: 'Tennis whites', host: 'Quintara',
    programme: [{ time: '14:00', title: 'Arrival and welcome' }, { time: '14:30', title: 'Social tennis' }, { time: '17:00', title: 'Hospitality and conversation' }],
    included: ['Social tennis', 'Wellness', 'Luxury hospitality'],
    capacity: 20, baseSeatsTaken: 8, priceMinor: 150000, memberPriceMinor: 120000, currency: 'ZAR',
    admission: 'members_only', guestPolicy: 'Members only. No guests.', maxSeatsPerBooking: 1, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-house-feast', marketId: MARKET, title: 'House Feast', category: 'Parties',
    summary: 'The Quintara signature villa party.',
    description: 'Afro house sunsets with scenic views of the Atlantic Seaboard. A DJ, acoustic sets and good vibes.',
    startsAt: '2026-11-28T14:00:00Z', timezone: ZONE, venueName: 'A private villa', area: 'Atlantic Seaboard', dressCode: 'Summer chic', host: 'Quintara',
    programme: [{ time: '16:00', title: 'Doors' }, { time: '17:30', title: 'Sunset set' }, { time: '20:00', title: 'Acoustic session' }],
    included: ['DJ and acoustic sets', 'Welcome drink'],
    capacity: 150, baseSeatsTaken: 60, priceMinor: 95000, memberPriceMinor: 75000, currency: 'ZAR',
    admission: 'open', guestPolicy: 'Members may bring up to three guests.', maxSeatsPerBooking: 4, hidden: false, invitedMemberIds: [],
  },
  {
    id: 'exp-tera-convivio', marketId: MARKET, title: 'Tera Convivio', category: 'Journeys',
    summary: 'Three days of wilderness, refined hospitality and exceptional company.',
    description: 'Tera Convivio brings Quintara\u2019s spirit of connection into the African wilderness. Over three days and two nights, an intimate gathering of members and invited guests discovers extraordinary landscapes, shares beautifully prepared meals and enjoys the comfort of a luxury villa reserved exclusively for the group. The journey begins in Cape Town, continues through Johannesburg and unfolds with a private helicopter transfer to the Greater Kruger. At its heart is an unhurried rhythm: early mornings in the bush, leisurely afternoons at the villa and evenings gathered around a beautifully dressed table.',
    startsAt: '2026-12-04T06:00:00Z', timezone: ZONE, venueName: 'A private safari villa', area: 'Greater Kruger', dressCode: 'Safari neutrals', host: 'Quintara',
    programme: [{ time: 'Day 1', title: 'Cape Town to Johannesburg, then by private helicopter to the villa' }, { time: 'Day 2', title: 'Early morning in the bush, an afternoon at the villa, dinner at a dressed table' }, { time: 'Day 3', title: 'A last morning in the bush and the journey home' }],
    included: ['Two nights in a private villa', 'All meals', 'Private helicopter transfer'],
    capacity: 12, baseSeatsTaken: 4, priceMinor: 9500000, memberPriceMinor: 8500000, currency: 'ZAR',
    admission: 'members_only', guestPolicy: 'One guest per member.', maxSeatsPerBooking: 2, hidden: false, invitedMemberIds: [],
  },
];

EXPERIENCES.push(...JOBURG_EXPERIENCES);

const MEMBERS: MemberSeed[] = [
  { id: 'mem-thandi', fullName: 'Thandi Mokoena', position: 'Founder', company: 'Kloof Street Studio', industry: 'Design', city: 'Cape Town', biography: 'Building a design studio for hospitality brands.', interests: ['Dining', 'Wine', 'Art'], lookingFor: 'A hotel group ready to rethink its guest experience', canOffer: 'Brand and interior direction for hospitality', roles: ['member', 'founder'] },
  { id: 'mem-daniel', fullName: 'Daniel Fourie', position: 'Partner', company: 'Helderberg Capital', industry: 'Venture capital', city: 'Stellenbosch', biography: 'Early-stage investor in consumer and climate.', interests: ['Golf', 'Wine', 'Investment'], lookingFor: 'Founders with first revenue', canOffer: 'Seed funding and board experience', roles: ['member', 'investor'] },
  { id: 'mem-aisha', fullName: 'Aisha Parker', position: 'Chef and owner', company: 'Saffron House', industry: 'Hospitality', city: 'Cape Town', biography: 'Cape Malay cooking, told properly.', interests: ['Dining', 'Culture'], lookingFor: 'A second site on the Atlantic seaboard', canOffer: 'Private dinners and menu consulting', roles: ['member', 'creative'] },
  { id: 'mem-sipho', fullName: 'Sipho Ndlovu', position: 'Chief executive', company: 'Ledgerline', industry: 'Technology', city: 'Johannesburg', biography: 'Payments infrastructure for African merchants.', interests: ['Padel', 'Business'], lookingFor: 'Series A partners', canOffer: 'Introductions across fintech', roles: ['member', 'founder'] },
  { id: 'mem-chloe', fullName: 'Chloe van der Merwe', position: 'Director', company: 'Longkloof Pictures', industry: 'Film', city: 'Cape Town', biography: 'Commercials and documentaries.', interests: ['Art', 'Fashion'], lookingFor: 'Brands with a story worth filming', canOffer: 'Creative direction', roles: ['member', 'creative'] },
];

const DEMO_MEMBER_ID = 'mem-thandi';

/* Cities: Cape Town and Johannesburg are open; Durban is being prepared and is not shown. */
const MARKETS: Market[] = [
  { id: 'market-cape-town', slug: 'cape-town', name: 'Cape Town', country: 'South Africa', timezone: ZONE, currency: 'ZAR', isOpen: true },
  { id: 'market-johannesburg', slug: 'johannesburg', name: 'Johannesburg', country: 'South Africa', timezone: ZONE, currency: 'ZAR', isOpen: true },
];
/** Sample members whose home city is Johannesburg; everyone else's is Cape Town. */
const JOBURG_MEMBERS: MemberSeed[] = [
  { id: 'mem-kagiso', fullName: 'Kagiso Molefe', position: 'Managing partner', company: 'Highveld Partners', industry: 'Private equity', city: 'Johannesburg', biography: 'Backs founders building for the continent.', interests: ['Golf', 'Investment', 'Dining'], lookingFor: '', canOffer: '', roles: ['member', 'investor'] },
  { id: 'mem-lindiwe', fullName: 'Lindiwe Dube', position: 'Creative director', company: 'Studio Lindiwe', industry: 'Fashion', city: 'Johannesburg', biography: 'Collections and campaigns from Maboneng.', interests: ['Fashion', 'Art'], lookingFor: '', canOffer: '', roles: ['member', 'creative'] },
];
const JOBURG_PARTNERS: Omit<Partner, 'privileges'>[] = [
  { id: 'par-highveld', name: 'Highveld Wellness Rooms', category: 'Wellness', summary: 'Treatment rooms and a quiet pool.', description: '', area: 'Sandton', website: null, offer: 'Treatment rooms and a quiet pool.', contactName: 'Guest relations', contactEmail: 'highveldwellnessrooms@example.com', contactPhone: '+27 11 555 0100', address: 'Sandton, Johannesburg' },
  { id: 'par-marula', name: 'Marula House', category: 'Dining', summary: 'Seasonal Highveld cooking in a Parkhurst garden.', description: '', area: 'Parkhurst', website: null, offer: 'Seasonal Highveld cooking in a Parkhurst garden.', contactName: 'Guest relations', contactEmail: 'marulahouse@example.com', contactPhone: '+27 11 555 0100', address: 'Parkhurst, Johannesburg' },
];
const JOBURG_PRIVILEGES: Omit<Privilege, 'myUses' | 'available'>[] = [
  { id: 'prv-marula', partnerId: 'par-marula', title: 'A glass of something from the cellar with dinner', details: 'A glass of something from the cellar with dinner', terms: 'Mention Quintara when booking.', validUntil: null, usesPerMember: 1 },
  { id: 'prv-highveld', partnerId: 'par-highveld', title: 'A complimentary first treatment', details: 'A complimentary first treatment', terms: 'Mention Quintara when booking.', validUntil: null, usesPerMember: 1 },
];

interface StoredBooking { id: string; experienceId: string; seats: number; status: BookingStatus; ticketCode: string; paid?: number; refunded?: number }

const PARTNERS: Omit<Partner, 'privileges'>[] = [
  { id: 'par-atlantic', name: 'Atlantic Charter', category: 'Travel', summary: 'Skippered yachts out of Granger Bay.', description: '', area: 'Granger Bay', website: null, offer: '', contactName: 'Guest relations', contactEmail: 'partner1@example.com', contactPhone: '+27 21 555 0101', address: '' },
  { id: 'par-saffron', name: 'Saffron House', category: 'Dining', summary: 'Cape Malay cooking, told properly.', description: '', area: 'Bo-Kaap', website: null, offer: '', contactName: 'Guest relations', contactEmail: 'partner2@example.com', contactPhone: '+27 21 555 0102', address: '' },
  { id: 'par-silo', name: 'The Silo Spa', category: 'Wellness', summary: 'A quiet floor above the harbour.', description: '', area: 'V&A Waterfront', website: null, offer: '', contactName: 'Guest relations', contactEmail: 'partner3@example.com', contactPhone: '+27 21 555 0103', address: '' },
];
const PRIVILEGES: Omit<Privilege, 'myUses' | 'available'>[] = [
  { id: 'prv-course', partnerId: 'par-saffron', title: 'A course from the kitchen', details: 'An extra course chosen by the chef with any dinner booking.', terms: 'Dinner service only. Mention Quintara when booking.', validUntil: null, usesPerMember: 0 },
  { id: 'prv-treatment', partnerId: 'par-silo', title: 'A complimentary first treatment', details: 'One sixty-minute treatment of your choice.', terms: 'Weekdays only. Book two days ahead.', validUntil: null, usesPerMember: 1 },
  { id: 'prv-thermal', partnerId: 'par-silo', title: 'Winter thermal circuit', details: 'Use of the thermal circuit with any treatment.', terms: 'Ended with the season.', validUntil: '2026-08-31', usesPerMember: 1 },
  { id: 'prv-sunset', partnerId: 'par-atlantic', title: 'Sunset upgrade', details: 'A two-hour charter extended to three.', terms: 'Subject to weather and availability.', validUntil: null, usesPerMember: 2 },
];

const person = (id: string): BusinessPerson => { const m = MEMBERS.find((member) => member.id === id)!; return { memberId: m.id, fullName: m.fullName, position: m.position, company: m.company }; };
MEMBERS.push(...JOBURG_MEMBERS);
PARTNERS.push(...JOBURG_PARTNERS);
PRIVILEGES.push(...JOBURG_PRIVILEGES);
const SEED_LISTINGS: { id: string; owner: string; kind: ListingKind; title: string; summary: string; sector: string; audience: BusinessRole[] }[] = [
  { id: 'lst-film', owner: 'mem-chloe', kind: 'collaboration', title: 'Brands with a story worth filming', summary: 'Longkloof Pictures is looking for two founders or executives a year whose company deserves a short documentary.', sector: 'Film', audience: ['founder', 'executive'] },
  { id: 'lst-hospitality', owner: 'mem-daniel', kind: 'partnership', title: 'Hospitality founders worth backing', summary: 'Helderberg Capital would like to meet founders building hospitality and consumer brands in the Cape, at any stage.', sector: 'Hospitality', audience: ['founder'] },
  { id: 'lst-ledgerline', owner: 'mem-sipho', kind: 'capital', title: 'Series A for Ledgerline', summary: 'Payments infrastructure for African merchants, live in three countries. Looking to meet investors who know fintech and long sales cycles.', sector: 'Fintech', audience: ['investor'] },
];

/** Packages with indicative, placeholder prices: [name, description, price in minor units or null, basis, notice in hours, duration]. */
const PACKAGE_SEED: Record<string, [string, string, number | null, ServicePackage['priceBasis'], number, string][]> = {"Sun\u00e9 Photography": [["Portrait session", "Portraits at a location of your choice, with a selection of edited images.", 350000, "per_session", 72, "2 hours"], ["Event coverage", "Photography of your event, edited and delivered as a private gallery.", 1200000, "per_booking", 168, "Up to 4 hours"], ["Content day", "A day creating natural, personal content for social media.", 650000, "per_day", 120, "Full day"]], "One&Only Yacht Charter": [["Sunset cruise", "A private yacht with crew for a sunset cruise.", 2500000, "per_booking", 72, "3 hours"], ["Full-day charter", "A private yacht for the day, with crew and catering arranged around your party.", null, "per_day", 168, "Full day"]], "Vellora Interiors": [["Design consultation", "A first visit to understand the space, how you live in it and what you would like.", 250000, "per_session", 120, "90 minutes"], ["Room design", "Concept, materials, furniture and finishing touches for one room.", null, "per_booking", 336, ""]], "Elite Motion": [["A day with a luxury car", "A luxury or performance car for the day.", 450000, "per_day", 48, "24 hours"], ["Weekend", "A luxury car from Friday to Sunday.", 1100000, "per_booking", 72, "Friday to Sunday"]], "Atelier Lunda": [["Style consultation", "Your wardrobe, image and personal brand, with clear recommendations.", 280000, "per_session", 72, "2 hours"], ["Wardrobe edit", "An edit of your wardrobe at home, with a list of what to keep, change and add.", 600000, "per_session", 168, "Half a day"]], "Apex Performance": [["Personal training session", "One session with a personal trainer.", 75000, "per_session", 24, "1 hour"], ["Four-week programme", "Training, nutrition guidance and coaching for four weeks.", 750000, "per_booking", 72, "4 weeks"]], "The Culinary House": [["Dinner for two", "A private chef cooks a dinner for two where you are hosting.", 480000, "per_booking", 120, "Evening"], ["Tasting menu", "A tasting menu cooked for your guests, designed with you.", 220000, "per_person", 120, "Evening"], ["Celebration", "A menu for a larger celebration, up to twenty guests.", null, "per_booking", 336, ""]], "\u00c9clat Atelier": [["Event make-up", "Make-up for an event or evening out, where you are getting ready.", 150000, "per_person", 48, "1 hour"], ["Bridal", "Bridal make-up with a trial beforehand.", null, "per_booking", 336, ""]], "Skye Health": [["Hydration drip", "An IV drip for hydration, after a short consultation.", 180000, "per_session", 24, "45 minutes"], ["Recovery drip", "An IV drip for recovery, after a short consultation.", 240000, "per_session", 24, "60 minutes"]], "Alpha Management": [["Model booking", "Models for a campaign, shoot or event.", null, "per_day", 168, ""]], "EliteReach Management": [["Brand partnership consultation", "A first meeting about your brand, your audience and the partnerships that would suit it.", 300000, "per_session", 120, "1 hour"], ["Creator campaign", "A campaign with matched creators, planned and run from idea to results.", null, "per_booking", 336, ""]], "BMM Capital": [["Introductory meeting", "A first meeting with BMM Capital about your business or what you are looking for.", null, "per_session", 72, "1 hour"]], "TheFeed": [["Promotion feature", "A feature or advert placed with TheFeed's audience.", null, "per_booking", 168, ""]], "Nava Studios": [["Studio hire", "A photography or videography studio for your own shoot.", 120000, "per_hour", 48, "Per hour"], ["Full production", "Planning, crew, filming and editing for your project.", null, "per_booking", 336, ""]], "Novaderm Aesthetics": [["Skin consultation", "A consultation to recommend treatments for your skin and your goals.", 90000, "per_session", 48, "45 minutes"], ["Signature facial", "A facial chosen for your skin.", 220000, "per_session", 72, "75 minutes"]], "Wonderland Cape Town": [["Sauna session", "A sauna session.", 45000, "per_person", 4, "90 minutes"], ["Work and wellness day", "A day at a desk with sauna access.", 65000, "per_day", 24, "Full day"], ["Overnight stay", "A night at Wonderland.", null, "per_booking", 48, "One night"]], "Virgin Active Country Club": [["Day visit", "A visit to the club's gym and wellness facilities, on the club's terms.", null, "per_person", 24, "Day"]]};
type ServiceSeed = Pick<LifestyleService, 'id' | 'name' | 'description' | 'category'>;
/** Directory details for a service. The person to ask for is left to the Quintara desk until each provider confirms one. */
const directory = (x: ServiceSeed, area: string): Omit<LifestyleService, keyof ServiceSeed | 'packages'> => ({
  summary: `${x.description.split('. ')[0]!.replace(/\.$/, '')}.`, area, website: null, offer: '', address: '', contactName: '', contactEmail: '', contactPhone: '',
});
const SERVICE_SEED: ServiceSeed[] = [
  { id: '7c2e0a10-0001-4a00-8000-000000000001', name: 'Sun\u00e9 Photography', description: 'Professional photography for portraits, events and brands, with editing and retouching of every image. Sun\u00e9 Photography also creates user-generated content for social media that looks natural and personal. Tell us the occasion and the look you want, and the session is arranged for you.', category: 'Photography and Media' },
  { id: '7c2e0a10-0002-4a00-8000-000000000002', name: 'One&Only Yacht Charter', description: 'Private yacht charters for sunset cruises, celebrations and full days at sea. Each charter is arranged around your party: the vessel, the crew, the timing and the catering. Tell us the date, the number of guests and the occasion.', category: 'Mobility' },
  { id: '7c2e0a10-0003-4a00-8000-000000000003', name: 'Vellora Interiors', description: 'An interior design practice for homes, apartments and workspaces. From a single room to a full renovation, Vellora works through the concept, materials, furniture and finishing touches, and sees the project through to the finished space.', category: 'Home and Design' },
  { id: '7c2e0a10-0004-4a00-8000-000000000004', name: 'Elite Motion', description: 'Luxury and performance cars to rent for a day, a weekend, a special occasion or a longer visit. Delivery and collection can be arranged on request. Tell us the dates and the kind of car you have in mind.', category: 'Mobility' },
  { id: '7c2e0a10-0005-4a00-8000-000000000005', name: 'Atelier Lunda', description: 'Personal branding and styling for how you present yourself, in person and online. Atelier Lunda advises on wardrobe, image and personal brand, for everyday wear, public appearances and the moments that matter.', category: 'Beauty and Style' },
  { id: '7c2e0a10-0006-4a00-8000-000000000006', name: 'Apex Performance', description: 'A personal trainer, nutritionist and coach in one programme. Sessions are planned around your goals, whether strength, fitness, body composition or recovery, with nutrition guidance and ongoing coaching to keep you on track.', category: 'Wellness' },
  { id: '7c2e0a10-0007-4a00-8000-000000000007', name: 'The Culinary House', description: 'A private chef for your home or your event. Menus are designed with you around the occasion, your guests and any dietary needs, from an intimate dinner for two to a larger celebration, and cooked on the day where you are hosting.', category: 'Dining' },
  { id: '7c2e0a10-0008-4a00-8000-000000000008', name: '\u00c9clat Atelier', description: 'Beauty and make-up by professional artists for events, shoots, weddings and evenings out. Tell us the occasion, the look you would like and where you will be getting ready, and an appointment is arranged.', category: 'Beauty and Style' },
  { id: '7c2e0a10-0009-4a00-8000-000000000009', name: 'Skye Health', description: 'IV drip therapy for hydration, recovery and wellbeing, given by qualified health professionals. Each appointment starts with a short consultation so that the drip suits you, and it is not given where it would not be safe.', category: 'Wellness' },
  { id: '7c2e0a10-0010-4a00-8000-000000000010', name: 'Alpha Management', description: 'A modelling agency representing talent for fashion, commercial and editorial work. Brands can book models for campaigns, shoots and events, and aspiring models can ask about representation.', category: 'Talent and Brand' },
  { id: '7c2e0a10-0011-4a00-8000-000000000011', name: 'EliteReach Management', description: 'An elite agency for brand partnerships, marketing, promotions and user-generated content. EliteReach matches brands with the right creators and talent, and plans and runs campaigns from the first idea to the results.', category: 'Talent and Brand' },
  { id: '7c2e0a10-0012-4a00-8000-000000000012', name: 'BMM Capital', description: 'Financial services, business advisory and investments. BMM Capital works with founders and businesses on strategy, structuring and funding. Any financial or investment advice comes from BMM Capital directly, not from Quintara. Mr. Wayne Huffton, Quintara\'s relationship manager, is with BMM Capital.', category: 'Business' },
  { id: '7c2e0a10-0013-4a00-8000-000000000013', name: 'TheFeed', description: 'News, promotions and adverts. TheFeed publishes stories and features, and places promotions and adverts for brands and businesses that want to reach its audience.', category: 'Photography and Media' },
  { id: '7c2e0a10-0014-4a00-8000-000000000014', name: 'Nava Studios', description: 'Photography and videography studios, with full production. Hire a studio for your own shoot, or have Nava Studios produce the whole project, from planning and crew to filming and editing.', category: 'Photography and Media' },
  { id: '7c2e0a10-0015-4a00-8000-000000000015', name: 'Novaderm Aesthetics', description: 'Skin, body and wellness treatments from an aesthetics clinic. Every treatment starts with a consultation, and what is recommended is chosen for your skin and your goals.', category: 'Wellness' },
  { id: '7c2e0a10-0016-4a00-8000-000000000016', name: 'Wonderland Cape Town', description: 'Wellness, a hotel, a sauna and co-working under one roof. Book a stay, a sauna session or a day at a desk, or combine them for a day that mixes work and rest.', category: 'Wellness' },
  { id: '7c2e0a10-0017-4a00-8000-000000000017', name: 'Virgin Active Country Club', description: 'A country club with a gym and wellness facilities. Quintara can arrange a visit, classes or sessions for you; facilities, access and membership terms are set by the club.', category: 'Wellness' },
];
const SERVICES: LifestyleService[] = SERVICE_SEED.map((x, n) => ({ ...x, ...directory(x, 'Cape Town'), packages: (PACKAGE_SEED[x.name] ?? []).map(([name, description, priceMinor, priceBasis, leadTimeHours, duration], k) => ({
  id: `7c2e0a20-${String(n + 1).padStart(4, '0')}-4a00-8000-${String(k + 1).padStart(12, '0')}`, name, description, priceMinor, priceBasis, currency: 'ZAR', leadTimeHours, duration })) }));

const JOBURG_SERVICES: LifestyleService[] = ([
  { id: '7c2e0a10-0101-4a00-8000-000000000101', name: 'BMM Capital', category: 'Business', description: 'Financial services, business advisory and investments. Any financial or investment advice comes from BMM Capital directly, not from Quintara.', packages: [{ id: '7c2e0a20-0101-4a00-8000-000000000001', name: 'A first conversation', description: '', priceMinor: null, priceBasis: 'per_booking', currency: 'ZAR', leadTimeHours: 48, duration: '' }] },
  { id: '7c2e0a10-0102-4a00-8000-000000000102', name: 'EliteReach Management', category: 'Talent and Brand', description: 'An elite agency for brand partnerships, marketing, promotions and user-generated content.', packages: [{ id: '7c2e0a20-0102-4a00-8000-000000000001', name: 'A brand partnership brief', description: '', priceMinor: null, priceBasis: 'per_booking', currency: 'ZAR', leadTimeHours: 48, duration: '' }] },
] as (ServiceSeed & Pick<LifestyleService, 'packages'>)[]).map((x) => ({ ...x, ...directory(x, 'Johannesburg') }));
const SEED_UPDATES: BusinessUpdate[] = [
  { id: '5b1f0c1e-0001-4a00-8000-000000000001', title: 'Co-investment circle: boutique hospitality', summary: 'Quintara is convening a small group of members to look at a boutique hospitality project on the Atlantic Seaboard. Ask your relationship manager for the briefing and to be introduced to the principals.', sector: 'Hospitality', audience: ['investor'], publishedAt: '2026-10-05T08:00:00Z' },
  { id: '5b1f0c1e-0002-4a00-8000-000000000002', title: 'Brand partners for the summer season', summary: 'A small number of members\u2019 companies can partner with Quintara\u2019s summer experiences, from The Aura Enclave to House Feast. Tell your relationship manager what you have in mind.', sector: 'Partnerships', audience: [], publishedAt: '2026-10-03T08:00:00Z' },
  { id: '5b1f0c1e-0003-4a00-8000-000000000003', title: 'Advisers for early-stage founders', summary: 'Several founder members are looking for an experienced adviser for the next twelve months. If you would consider a seat, your relationship manager can tell you more and make the introduction.', sector: 'Advisory', audience: ['executive', 'investor'], publishedAt: '2026-10-01T08:00:00Z' },
];

type ProductSeed = Omit<Product, 'wished' | 'priceMinor' | 'publicPriceMinor' | 'imagePath'> & { publicPrice: number; memberPrice: number | null };
const PRODUCTS: ProductSeed[] = [
  { id: 'prd-print', title: 'Longkloof print, edition of fifty', maker: 'Longkloof Pictures', category: 'Limited editions', description: 'A still from the Cederberg film, signed and numbered.', publicPrice: 680000, memberPrice: null, membersOnly: true, currency: 'ZAR', options: ['Unframed', 'Framed in oak'], stock: 2 },
  { id: 'prd-weekender', title: 'Hand-stitched weekender', maker: 'Atelier Ndaba', category: 'Accessories', description: 'Full-grain leather, brass hardware, made to order in Gardens.', publicPrice: 1450000, memberPrice: 1300000, membersOnly: false, currency: 'ZAR', options: ['Tan', 'Black'], stock: null },
  { id: 'prd-candle', title: 'Fynbos candle', maker: 'Quintara', category: 'Home', description: 'Buchu, wild rosemary and salt air. Sixty hours.', publicPrice: 68000, memberPrice: null, membersOnly: false, currency: 'ZAR', options: [], stock: 40 },
  { id: 'prd-scarf', title: 'Silk scarf', maker: 'Atelier Ndaba', category: 'Accessories', description: 'Hand-rolled edges, printed in Cape Town.', publicPrice: 320000, memberPrice: 280000, membersOnly: false, currency: 'ZAR', options: ['Atlantic', 'Protea'], stock: 12 },
];
PRODUCTS.push({ id: 'prd-highveld-candle', title: 'Highveld candle', maker: 'Quintara', category: 'Home', description: 'Wild sage and summer rain. Sixty hours.', publicPrice: 68000, memberPrice: null, membersOnly: false, currency: 'ZAR', options: [], stock: 30 });
/** Which city each sample item belongs to: Johannesburg's are listed here, everything else is Cape Town's. */
const IN_JOBURG = new Set(['prd-highveld-candle', ...JOBURG_MEMBERS.map((m) => m.id), ...JOBURG_PARTNERS.map((p) => p.id)]);
const DELIVERY: DeliveryOption[] = [
  { id: 'del-courier', name: 'Courier, South Africa', description: 'Two to four working days, signed for.', feeMinor: 15000, freeOverMinor: 500000, currency: 'ZAR' },
];

const EPISODES: Omit<TvEpisode, 'locked' | 'positionSeconds' | 'completed'>[] = [
  { id: 'ep-1', seriesId: 'ser-long-table', number: 1, title: 'First light at the market', summary: 'Aisha chooses the snoek before the city is awake.', durationSeconds: 1680, audience: 'public', imagePath: null, videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
  { id: 'ep-2', seriesId: 'ser-long-table', number: 2, title: 'The long table is laid', summary: 'Forty places, one terrace, and a wind that will not settle.', durationSeconds: 2100, audience: 'members', imagePath: null, videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
  { id: 'ep-3', seriesId: 'ser-long-table', number: 3, title: 'Until the light goes', summary: 'The lunch itself, from the first glass to the last.', durationSeconds: 2520, audience: 'members', imagePath: null, videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
];

interface MockState {
  qera: { messages: QeraMessage[]; pending: (QeraProposal & { args: Record<string, unknown> }) | null };
  watched: Record<string, { positionSeconds: number; completed: boolean }>;
  wished: string[];
  sold: Record<string, number>;
  /** When two-factor was turned on in the offline mock. */
  twoFactorOn: string | null;
  orders: (Order & { lines: { productId: string; quantity: number }[]; paid?: boolean })[];
  myListings: BusinessListing[];
  introductions: Introduction[];
  enquiries: RmEnquiry[];
  serviceRequests: ServiceRequest[];
  partnerBookings: PartnerBooking[];
  documents: QeraDocument[];
  avatar: string | null;
  redemptions: Redemption[];
  session: Session | null;
  /** The guest account registered on this device, and whether it is signed in. */
  guestAccount: GuestAccount | null;
  guestSignedIn: boolean;
  guestQera: QeraMessage[];
  guestUsage: { day: string; seconds: number; lastSeen: number };
  bookings: StoredBooking[];
  connections: Record<string, MemberProfile['connection']>;
  myProfile: MemberSeed;
  application: Application | null;
  notifications: AppNotification[];
  requests: ConciergeRequest[];
  chats: Record<string, ChatMessage[]>;
  chatUnread: Record<string, boolean>;
  blocked: string[];
  privacy: { showInDirectory: boolean; marketingEmail: boolean; suggestions: boolean; weeklyBrief: boolean; dailyBrief: boolean };
  memory: QeraMemoryItem[];
  reminders: QeraReminder[];
  /** The member's calendar connection. The offline client reads only the sample calendar. */
  calendar: { provider: CalendarProvider; label: string; showTitles: boolean; connectedAt: string } | null;
  whatsapp: { status: 'pending' | 'linked'; code: string; linkedAt: string | null } | null;
  reported: string[];
  /** Push: the phones registered on this device's mock, and the choices. */
  push?: { muted: NotificationCategory[]; showDetails: boolean; devices: (PushDevice & { token: string })[] };
  /** The membership term, renewal choice and the saved test card. */
  renewal?: { termEndsAt: string; autoRenew: boolean; lapsed: boolean; card: { brand: string; last4: string; expMonth: number; expYear: number; declines: boolean } | null; history: MembershipRenewalPayment[] };
  nextId: number;
}

function initialState(): MockState {
  return {
    session: null,
    guestAccount: null,
    guestSignedIn: false,
    guestQera: [],
    guestUsage: { day: '', seconds: 0, lastSeen: 0 },
    qera: { messages: [], pending: null },
    watched: {},
    wished: [],
    sold: {},
    orders: [],
    twoFactorOn: null,
    myListings: [],
    introductions: [],
    enquiries: [],
    serviceRequests: [],
    partnerBookings: [],
    documents: [],
    avatar: null,
    redemptions: [],
    blocked: [],
    privacy: { showInDirectory: true, marketingEmail: false, suggestions: true, weeklyBrief: true, dailyBrief: true },
    memory: [],
    reminders: [],
    calendar: null,
    whatsapp: null,
    reported: [],
    bookings: [{ id: 'bkg-1', experienceId: 'exp-costa-convivio', seats: 2, status: 'confirmed', ticketCode: 'QT-7F3K9A' }],
    connections: { 'mem-daniel': 'connected', 'mem-aisha': 'connected', 'mem-sipho': 'incoming' },
    myProfile: structuredClone(MEMBERS.find((member) => member.id === DEMO_MEMBER_ID)!),
    application: null,
    notifications: [
      { id: 'ntf-1', category: 'experience_invitation', title: 'You are invited to the Quintara Golf Invitational.', createdAt: '2026-10-05T06:10:00Z', readAt: null, link: { type: 'experience', id: 'exp-invitational' } },
      { id: 'ntf-2', category: 'booking_confirmation', title: 'Your place at Costa Convivio is confirmed.', createdAt: '2026-10-02T09:00:00Z', readAt: '2026-10-02T09:30:00Z', link: { type: 'booking', id: 'bkg-1' } },
      { id: 'ntf-3', category: 'message', title: 'Sipho Ndlovu would like to connect.', createdAt: '2026-10-04T08:40:00Z', readAt: null, link: { type: 'member', id: 'mem-sipho' } },
    ],
    requests: [
      { id: 'req-1', category: 'hospitality', subject: 'Restaurant reservation', details: 'Table for six on Saturday evening, somewhere quiet enough to talk. One guest is vegetarian.', neededBy: '2026-10-17', status: 'options_provided', createdAt: '2026-10-04T13:00:00Z',
        messages: [{ id: 'cm-1', from: 'desk', body: 'Two options for 19:30: the private room at Saffron House, or a corner table at The Pot Luck Club. Which would you prefer?', sentAt: '2026-10-04T13:10:00Z' }] },
    ],
    chats: {
      'mem-aisha': [{ id: 'msg-1', mine: true, body: 'Loved the menu for Costa Convivio. Is the snoek course staying?', sentAt: '2026-10-04T08:02:00Z' }, { id: 'msg-2', mine: false, body: 'It is. And I have put you at my end of the table.', sentAt: '2026-10-04T08:40:00Z' }],
    },
    chatUnread: { 'mem-aisha': true },
    nextId: 2,
  };
}

const LIVE: BookingStatus[] = ['applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'attended'];
/** Today in Cape Town, where the sample market is. */
const saToday = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const GUEST_QERA_TOOLS: QeraToolName[] = ['about_quintara', 'list_services', 'list_experiences', 'recommend', 'search'];
const GUEST_HEARTBEAT_CAP = 90, GUEST_MESSAGE_CAP = 300;
const GUEST_LIMIT_MESSAGE = 'You have used today\u2019s five hours with Q\u00c9RA. Apply for membership to keep talking to Q\u00c9RA without a daily limit, or come back tomorrow.';

export function createMockApi(options: MockApiOptions = {}): QuintaraApi {
  const { storage, latencyMs = 250, guestQeraSeconds: guestLimit = GUEST_QERA_DAILY_SECONDS } = options;

  let state: MockState = initialState();
  if (storage) {
    try {
      const saved = storage.getItem(STORAGE_KEY);
      if (saved) state = { ...state, ...(JSON.parse(saved) as Partial<MockState>) };
    } catch {
      // Unreadable storage: start fresh.
    }
  }
  const persist = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable: the session continues in memory.
    }
  };

  /** Wraps every call: simulated latency, then the handler, then persistence. */
  async function call<T>(handler: () => T): Promise<T> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const result = handler();
    persist();
    return structuredClone(result);
  }

  function require(permission: Permission): Session | null {
    if (can(state.session, permission)) return state.session;
    if (!state.session) throw new ApiError('unauthenticated', 'Sign in to continue.');
    throw new ApiError('forbidden', 'Your membership does not include this.');
  }
  /** Members and signed-in guest accounts may link WhatsApp. */
  function whatsAppHolder(): void {
    if (!state.session && !state.guestSignedIn) throw new ApiError('unauthenticated', 'Sign in to continue.');
  }
  function whatsAppState(): WhatsAppLink {
    whatsAppHolder();
    const w = state.whatsapp;
    return { available: true, status: w?.status ?? 'none', businessNumber: MOCK_WHATSAPP_NUMBER, numberMasked: w?.status === 'linked' ? '•••• 4567' : null, linkedAt: w?.linkedAt ?? null, code: null, message: null, openUrl: null, codeExpiresAt: null };
  }

  /* Push and renewal state, created on first use (older saved states have neither). */
  const pushState = () => (state.push ??= { muted: [], showDetails: false, devices: [] });
  const renewalState = () => (state.renewal ??= {
    termEndsAt: new Date(Date.now() + 21 * 86_400_000).toISOString(), autoRenew: true, lapsed: false,
    card: { brand: 'Visa', last4: '4242', expMonth: 12, expYear: new Date().getFullYear() + 3, declines: false },
    history: [{ id: 'rp-0', at: new Date(Date.now() - 344 * 86_400_000).toISOString(), amountMinor: 3_000_000, currency: 'ZAR', status: 'paid', periodEnd: new Date(Date.now() + 21 * 86_400_000).toISOString(), reason: null }],
  });
  /** A member whose membership lapsed is signed in without member powers; renewing restores them. */
  let lapsedSession: Session | null = null;
  const membershipOwner = () => { if (!state.session && !lapsedSession) throw new ApiError('unauthenticated', 'Sign in to continue.'); };
  function membershipStatus(): MembershipStatus {
    membershipOwner();
    const r = renewalState(), end = new Date(r.termEndsAt), left = end.getTime() - Date.now();
    const st: MembershipStatus['state'] = r.lapsed ? 'lapsed' : left <= 0 ? 'grace' : left <= 30 * 86_400_000 ? 'renewal_due' : 'active';
    const valid = (c: NonNullable<typeof r.card>, at: Date) => new Date(Date.UTC(c.expYear, c.expMonth, 1)) > at;
    return {
      memberNumber: (state.session ?? lapsedSession)!.memberNumber, tierName: (state.session ?? lapsedSession)!.tierName, priceMinor: 3_000_000, currency: 'ZAR', termMonths: 12,
      termEndsAt: r.termEndsAt, state: st, graceEndsAt: st === 'grace' ? new Date(end.getTime() + RENEWAL_GRACE_DAYS * 86_400_000).toISOString() : null,
      autoRenew: r.autoRenew, card: r.card ? { brand: r.card.brand, last4: r.card.last4, expMonth: r.card.expMonth, expYear: r.card.expYear, expired: !valid(r.card, new Date()), expiresBeforeRenewal: !valid(r.card, end) } : null,
      nextAttemptAt: null, lastFailure: r.history.find((h) => h.status === 'failed')?.reason ?? null, canRenewNow: st !== 'active', history: r.history,
    };
  }

  function requireMember(permission: Permission): Session {
    const session = require(permission);
    if (!session) throw new ApiError('unauthenticated', 'Sign in to continue.');
    return session;
  }

  const seatsTaken = (seed: ExperienceSeed) =>
    seed.baseSeatsTaken + state.bookings.filter((b) => b.experienceId === seed.id && (b.status === 'confirmed' || b.status === 'awaiting_payment')).reduce((sum, b) => sum + b.seats, 0);

  /* The city being viewed. Like the header the real client sends, it is not stored with the rest of the state. */
  let marketSlug: string | null = null;
  const marketId = () => MARKETS.find((m) => m.slug === marketSlug)?.id ?? 'market-cape-town';
  const here = (id: string) => (IN_JOBURG.has(id) ? JOBURG : 'market-cape-town') === marketId();
  const servicesHere = () => (marketId() === JOBURG ? JOBURG_SERVICES : SERVICES);
  /** As on the server: the person to ask for and their contact details are for members only. */
  const forViewer = (x: LifestyleService): LifestyleService => (state.session ? x : { ...x, contactName: '', contactEmail: '', contactPhone: '' });

  function visible(seed: ExperienceSeed): boolean {
    const memberId = state.session?.memberId;
    if (!can(state.session, 'experiences.view_member')) return (seed.openToGuests ?? seed.admission === 'open') && !seed.hidden;
    return !seed.hidden || (memberId !== undefined && seed.invitedMemberIds.includes(memberId));
  }

  function toExperience(seed: ExperienceSeed): Experience {
    const { baseSeatsTaken: _base, hidden: _hidden, invitedMemberIds, openToGuests, ...rest } = seed;
    // Dates and seat counts are for members; guests and visitors are not sent them.
    const full = can(state.session, 'experiences.view_member');
    return { ...rest, openToGuests: openToGuests ?? seed.admission === 'open', startsAt: full ? seed.startsAt : null, capacity: full ? seed.capacity : null, seatsTaken: full ? seatsTaken(seed) : null, invited: state.session ? invitedMemberIds.includes(state.session.memberId) : false };
  }

  function findExperience(id: string): ExperienceSeed {
    const seed = EXPERIENCES.find((experience) => experience.id === id);
    // A hidden experience is reported as missing, never as forbidden, so its existence does not leak.
    if (!seed || !visible(seed)) throw new ApiError('not_found', 'This experience is not available.');
    return seed;
  }

  function toBooking(stored: StoredBooking): Booking {
    const seed = EXPERIENCES.find((experience) => experience.id === stored.experienceId)!;
    const awaiting = stored.status === 'awaiting_payment';
    return {
      id: stored.id, experienceId: stored.experienceId, seats: stored.seats, status: stored.status, ticketCode: stored.ticketCode,
      experienceTitle: seed.title, startsAt: seed.startsAt, timezone: seed.timezone, venueName: seed.venueName, area: seed.area,
      currency: seed.currency, amountDueMinor: awaiting ? seed.memberPriceMinor * stored.seats : 0,
      paymentDueAt: awaiting ? new Date(Date.now() + 30 * 60_000).toISOString() : null, refundedMinor: stored.refunded ?? 0,
    };
  }

  function toProfile(seed: MemberSeed): MemberProfile {
    return { ...seed, avatarPath: null, connection: state.connections[seed.id] ?? 'none' };
  }

  const otherMembers = () => MEMBERS.filter((member) => member.id !== state.session?.memberId && !state.blocked.includes(member.id));

  /** The member's own listings first, then published ones addressed to one of their roles. */
  function listingsForMember(): BusinessListing[] {
    const roles = state.session?.roles ?? [];
    const others = SEED_LISTINGS.filter(() => marketId() !== JOBURG).filter((l) => l.owner !== state.session?.memberId && !state.blocked.includes(l.owner) && l.audience.some((role) => roles.includes(role))).map(({ owner, ...l }): BusinessListing => ({
      ...l, status: 'published', createdAt: '2026-10-01T08:00:00Z', postedBy: person(owner), mine: false, reviewNote: null,
      myRequest: state.introductions.find((i) => i.listingTitle === l.title)?.status ?? null,
    }));
    return [...state.myListings, ...others];
  }

  const productsForMember = (): Product[] => {
    const member = state.session !== null && can(state.session, 'boutique.shop');
    return [...PRODUCTS].filter((p) => here(p.id)).filter((p) => member || !p.membersOnly).sort((a, b) => a.title.localeCompare(b.title)).map(({ publicPrice, memberPrice, ...p }) => {
      const price = member && memberPrice !== null ? memberPrice : publicPrice;
      return { ...p, priceMinor: price, publicPriceMinor: price < publicPrice ? publicPrice : null, imagePath: null, stock: p.stock === null ? null : p.stock - (state.sold[p.id] ?? 0), wished: member && state.wished.includes(p.id) };
    });
  };
  const publicOrder = ({ lines: _lines, paid: _paid, ...order }: MockState['orders'][number]): Order => order;

  function partnersForMember(): Partner[] {
    const today = new Date().toISOString().slice(0, 10);
    return PARTNERS.filter((partner) => here(partner.id)).map((partner) => ({
      ...partner,
      privileges: PRIVILEGES.filter((privilege) => privilege.partnerId === partner.id).map((privilege) => {
        const myUses = state.redemptions.filter((r) => r.privilegeId === privilege.id).length;
        return { ...privilege, myUses, available: !(privilege.validUntil && privilege.validUntil < today) && (privilege.usesPerMember === 0 || myUses < privilege.usesPerMember) };
      }),
    }));
  }

  function findRequest(id: string): ConciergeRequest {
    const request = state.requests.find((candidate) => candidate.id === id);
    if (!request) throw new ApiError('not_found', 'This request is not available.');
    return request;
  }

  function thread(memberId: string): ConversationThread {
    const partner = otherMembers().find((member) => member.id === memberId);
    if (!partner) throw new ApiError('not_found', 'This profile is not available.');
    return {
      with: { memberId, fullName: partner.fullName, position: partner.position, company: partner.company },
      canSend: state.connections[memberId] === 'connected',
      messages: state.chats[memberId] ?? [],
    };
  }

  function validationError(issues: { path: PropertyKey[]; message: string }[]): ApiError {
    const fields: Record<string, string> = {};
    for (const issue of issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
    return new ApiError('validation', 'Some details need attention.', fields);
  }

  const api: QuintaraApi = {
    getSession: () => call(() => state.session),
    listMarkets: () => call(() => MARKETS.filter((m) => m.isOpen)),
    listSectionCopy: () => call(() => SECTION_KEYS.map((key) => ({ key, ...SECTION_DEFAULTS[key], updatedAt: null }))),
    setMarket: (slug) => { marketSlug = slug; },

    signIn: ({ email }) =>
      call(() => {
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError('validation', 'Enter a valid email address.', { email: 'Enter a valid email address' });
        const profile = state.myProfile;
        state.session = {
          userId: 'usr-thandi', memberId: profile.id, fullName: profile.fullName, email, roles: profile.roles,
          tierName: 'Founding member', memberNumber: 'Q-1001', memberSince: '2026-06-12', marketId: MARKET,
        };
        return state.session;
      }),

    signOut: () => call(() => { state.session = null; state.guestSignedIn = false; }),
    signOutEverywhere: () => call(() => { state.session = null; state.guestSignedIn = false; }),
    // Two-factor in the offline mock: the screens can be tried; any six digits confirm. The real API checks real codes.
    getTwoFactor: () => call(() => ({ state: state.session || state.guestSignedIn ? (state.twoFactorOn ? 'on' as const : 'off' as const) : 'none' as const, required: false, recoveryCodesLeft: state.twoFactorOn ? 10 : 0, enabledAt: state.twoFactorOn })),
    startTwoFactorSetup: () => call(() => ({ secret: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP', otpauthUrl: 'otpauth://totp/Quintara:demo?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Quintara', qr: '' })),
    confirmTwoFactor: (code) => call(() => {
      if (!/^\d{6}$/.test(code)) throw new ApiError('validation', 'Enter the six-digit code from your authenticator app.', { code: 'Not right' });
      state.twoFactorOn = new Date().toISOString();
      return { recoveryCodes: ['k7m2p-q9x4r', 'h3n8t-w5c2v', 'b6f9j-m2k7s', 'x4r8p-n3h6t', 'c9w2v-k5m8q', 'p7s3x-r4n9j', 't2h6c-w8v3k', 'm5q9r-b2x7p', 'v8k4n-s3j6h', 'r6p2t-c9m4w'] };
    }),
    verifyTwoFactor: () => call(() => ({ session: state.session, guest: state.guestSignedIn ? state.guestAccount : null })),
    newRecoveryCodes: () => call(() => ({ recoveryCodes: ['n4k8p-x2r7m', 'w9h3t-c6v2q', 'j7m5s-b3f8k', 'p2x6r-h9n4t', 'q5k3w-v8c2m', 'j9r4n-x7s3p', 'k6w8h-t2c5v', 'p3b7x-q9m2r', 'h5s9j-k4n8v', 'w2m6t-r8p3c'] })),
    disableTwoFactor: () => call(() => { state.twoFactorOn = null; }),
    // The offline mock signs in by address alone, as in development.
    getAuthConfig: () => call(() => ({ method: 'dev' as const })),
    requestSignInCode: () => call(() => undefined),
    verifySignInCode: ({ email }) => call(() => {
      if (state.guestAccount && state.guestAccount.email.toLowerCase() === email.trim().toLowerCase()) { state.session = null; state.guestSignedIn = true; return { session: null, guest: state.guestAccount }; }
      const profile = state.myProfile;
      state.session = { userId: 'usr-thandi', memberId: profile.id, fullName: profile.fullName, email, roles: profile.roles, tierName: 'Founding member', memberNumber: 'Q-1001', memberSince: '2026-06-12', marketId: MARKET };
      return { session: state.session, guest: null };
    }),

    getGuestAccount: () => call(() => (!state.session && state.guestSignedIn ? state.guestAccount : null)),
    createGuestAccount: (input) =>
      call(() => {
        if (state.session) throw new ApiError('conflict', 'You are already a member.');
        if (state.guestSignedIn) throw new ApiError('conflict', 'You already have a guest account.');
        const parsed = guestAccountSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        state.guestAccount = { userId: 'usr-guest', fullName: parsed.data.fullName, email: parsed.data.email, createdAt: new Date().toISOString() };
        state.guestSignedIn = true;
        state.guestQera = [];
        return state.guestAccount;
      }),
    signInGuest: ({ email }) =>
      call(() => {
        if (!state.guestAccount || state.guestAccount.email.toLowerCase() !== email.trim().toLowerCase()) throw new ApiError('unauthenticated', 'No account was found for that email address.');
        state.session = null;
        state.guestSignedIn = true;
        return state.guestAccount;
      }),
    updateGuestAccount: ({ fullName }) =>
      call(() => {
        if (!asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
        const parsed = guestAccountSchema.pick({ fullName: true }).safeParse({ fullName });
        if (!parsed.success) throw validationError(parsed.error.issues);
        state.guestAccount = { ...state.guestAccount!, fullName: parsed.data.fullName };
        return state.guestAccount;
      }),
    exportGuestData: () =>
      call(() => {
        if (!asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
        return { exportedAt: new Date().toISOString(), account: state.guestAccount, qeraMessages: state.guestQera, qeraUsage: [state.guestUsage] };
      }),
    deleteGuestAccount: () =>
      call(() => {
        if (!asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
        state.guestAccount = null; state.guestSignedIn = false; state.guestQera = []; state.guestUsage = { day: '', seconds: 0, lastSeen: 0 };
      }),

    listExperiences: () =>
      call(() => {
        require('experiences.view_public');
        return [...EXPERIENCES].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).filter((e) => e.marketId === marketId()).filter(visible).map(toExperience);
      }),

    getExperience: (id) => call(() => { require('experiences.view_public'); return toExperience(findExperience(id)); }),

    bookExperience: (experienceId, seats) =>
      call(() => {
        const session = requireMember('experiences.book');
        const seed = findExperience(experienceId);
        if (!Number.isInteger(seats) || seats < 1 || seats > seed.maxSeatsPerBooking) {
          throw new ApiError('validation', `Choose between 1 and ${seed.maxSeatsPerBooking} seats.`, { seats: 'Choose a valid number of seats' });
        }
        if (seed.admission === 'invitation_only' && !seed.invitedMemberIds.includes(session.memberId)) {
          throw new ApiError('forbidden', 'This experience is by invitation.');
        }
        if (state.bookings.some((b) => b.experienceId === seed.id && LIVE.includes(b.status))) {
          throw new ApiError('conflict', 'You already have a booking for this experience.');
        }
        const status: BookingStatus =
          seed.admission === 'application_required' ? 'applied' : seatsTaken(seed) + seats > seed.capacity ? 'waitlisted' : seed.memberPriceMinor > 0 ? 'awaiting_payment' : 'confirmed';
        const n = state.nextId++;
        const stored: StoredBooking = { id: `bkg-${n}`, experienceId: seed.id, seats, status, ticketCode: `QT-${(n * 7919 + 100000).toString(36).toUpperCase()}` };
        state.bookings.push(stored);
        if (status === 'confirmed') {
          state.notifications.unshift({
            id: `ntf-b${n}`, category: 'booking_confirmation', title: `Your place at ${seed.title} is confirmed.`,
            createdAt: new Date().toISOString(), readAt: null, link: { type: 'booking', id: stored.id },
          });
        }
        return toBooking(stored);
      }),

    listBookings: () =>
      call(() => {
        requireMember('experiences.book');
        return state.bookings.map(toBooking).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      }),

    payBooking: (bookingId) =>
      call(() => {
        requireMember('experiences.book');
        const stored = state.bookings.find((b) => b.id === bookingId);
        if (!stored) throw new ApiError('not_found', 'This booking is not available.');
        if (stored.status !== 'awaiting_payment') throw new ApiError('conflict', 'This booking has nothing to pay.');
        const seed = EXPERIENCES.find((experience) => experience.id === stored.experienceId)!;
        stored.paid = seed.memberPriceMinor * stored.seats;
        stored.status = 'confirmed';
        state.notifications.unshift({ id: `ntf-p${state.nextId++}`, category: 'booking_confirmation', title: `Your place at ${seed.title} is confirmed.`, createdAt: new Date().toISOString(), readAt: null, link: { type: 'booking', id: stored.id } });
        return toBooking(stored);
      }),

    cancelBooking: (bookingId) =>
      call(() => {
        requireMember('experiences.book');
        const stored = state.bookings.find((b) => b.id === bookingId);
        if (!stored) throw new ApiError('not_found', 'This booking is not available.');
        if (!LIVE.includes(stored.status) || stored.status === 'attended') throw new ApiError('conflict', 'This booking can no longer be cancelled.');
        stored.status = 'cancelled';
        // The sample experiences are all more than two days away, so a paid booking is refunded in full.
        if (stored.paid) { stored.refunded = stored.paid; stored.paid = 0; }
        return toBooking(stored);
      }),

    listMembers: (query = {}) =>
      call(() => {
        require('directory.view');
        const search = query.search?.trim().toLowerCase() ?? '';
        return otherMembers().filter((member) => here(member.id))
          .filter((member) => !query.role || member.roles.includes(query.role))
          .filter((member) => !search || [member.fullName, member.company, member.industry, member.position, member.city, ...member.interests].join(' ').toLowerCase().includes(search))
          .map(toProfile);
      }),

    listSuggestions: () =>
      call(() => {
        requireMember('directory.view');
        if (!state.privacy.suggestions) return [];
        return suggestMatches({ ...state.myProfile, avatarPath: state.avatar, connection: 'none' }, otherMembers().filter((member) => here(member.id)).map(toProfile));
      }),

    search: (query) =>
      call(() => {
        const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
        if (text.length < 2 || text.length > 80) throw new ApiError('validation', 'Search for at least two letters', { q: 'Search for at least two letters' });
        const words = text.split(/\s+/).filter(Boolean), member = state.session !== null;
        const hit = (...fields: (string | null | undefined)[]) => { const hay = fields.filter(Boolean).join(' ').toLowerCase(); return words.every((word) => hay.includes(word)); };
        const results: SearchResult[] = [];
        const add = (found: SearchResult[]) => results.push(...found.slice(0, 5));
        add(EXPERIENCES.filter((e) => e.marketId === marketId()).filter(visible).filter((e) => hit(e.title, e.category, e.summary, e.venueName, e.area)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((e) => ({ kind: 'experience', id: e.id, title: e.title, detail: member ? `${e.category}. ${formatDateTime(e.startsAt, e.timezone).long}, ${e.area}` : `${e.category}. ${e.area}` })));
        if (member) {
          add(otherMembers().filter((m) => here(m.id)).filter((m) => hit(m.fullName, m.position, m.company, m.industry, m.city, ...m.interests)).sort((a, b) => a.fullName.localeCompare(b.fullName)).map((m) => ({ kind: 'member', id: m.id, title: m.fullName, detail: `${m.position}, ${m.company}. ${m.city}` })));
          add(partnersForMember().filter((p) => hit(p.name, p.category, p.summary, p.area, ...p.privileges.map((v) => v.title))).map((p) => ({ kind: 'partner', id: p.id, title: p.name, detail: `${p.category}${p.area ? `. ${p.area}` : ''}` })));
          add(listingsForMember().filter((l) => !l.mine && hit(l.title, l.summary, l.sector, LISTING_KIND_LABEL[l.kind])).map((l) => ({ kind: 'listing', id: l.id, title: l.title, detail: `${LISTING_KIND_LABEL[l.kind]}. ${l.postedBy.fullName}` })));
        }
        add(productsForMember().filter((p) => hit(p.title, p.maker, p.category, p.description)).map((p) => ({ kind: 'product', id: p.id, title: p.title, detail: `${p.category}${p.maker ? `. ${p.maker}` : ''}` })));
        add(EPISODES.filter((e) => hit('The Long Table', e.title, e.summary)).map((e) => ({ kind: 'episode', id: e.id, title: e.title, detail: `The Long Table, episode ${e.number}${!member && e.audience === 'members' ? '. For members' : ''}` })));
        return results;
      }),

    getMember: (id) =>
      call(() => {
        require('directory.view');
        const member = otherMembers().find((candidate) => candidate.id === id);
        if (!member) throw new ApiError('not_found', 'This profile is not available.');
        return toProfile(member);
      }),

    requestConnection: (memberId) =>
      call(() => {
        require('connections.request');
        const member = otherMembers().find((candidate) => candidate.id === memberId);
        if (!member) throw new ApiError('not_found', 'This profile is not available.');
        const current = state.connections[memberId] ?? 'none';
        if (current === 'connected' || current === 'requested') throw new ApiError('conflict', 'You have already connected or asked to connect.');
        // Accepting an incoming request connects at once; otherwise the other member decides.
        state.connections[memberId] = current === 'incoming' ? 'connected' : 'requested';
        return toProfile(member);
      }),

    blockMember: (memberId) =>
      call(() => {
        require('directory.view');
        if (state.blocked.includes(memberId)) return;
        if (!otherMembers().some((candidate) => candidate.id === memberId)) throw new ApiError('not_found', 'This profile is not available.');
        state.blocked.push(memberId);
        delete state.connections[memberId];
      }),

    unblockMember: (memberId) => call(() => { require('directory.view'); state.blocked = state.blocked.filter((id) => id !== memberId); }),

    listBlockedMembers: () =>
      call(() => { require('directory.view'); return MEMBERS.filter((member) => state.blocked.includes(member.id)).map((member) => ({ id: member.id, fullName: member.fullName })); }),

    reportMember: (memberId, input) =>
      call(() => {
        require('directory.view');
        if (!otherMembers().some((candidate) => candidate.id === memberId)) throw new ApiError('not_found', 'This profile is not available.');
        const parsed = memberReportSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        if (state.reported.includes(memberId)) throw new ApiError('conflict', 'Your earlier report is still with the team.');
        state.reported.push(memberId);
      }),

    listBusinessListings: () => call(() => { requireMember('business.view'); return listingsForMember(); }),

    createBusinessListing: (input) =>
      call(() => {
        const session = requireMember('business.post');
        const parsed = listingInputSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const d = parsed.data;
        if (d.kind === 'capital' && !session.roles.includes('founder')) throw new ApiError('forbidden', 'Only founders can post about raising capital.');
        if (state.myListings.filter((l) => l.status === 'pending' || l.status === 'published').length >= 5) throw new ApiError('conflict', 'You have five open listings. Close one before adding another.');
        const listing: BusinessListing = {
          id: `lst-${state.nextId++}`, kind: d.kind, title: d.title, summary: d.summary, sector: d.sector, audience: d.kind === 'capital' ? ['investor'] : [...new Set(d.audience)],
          status: 'pending', createdAt: new Date().toISOString(), postedBy: person(session.memberId), mine: true, myRequest: null, reviewNote: null,
        };
        state.myListings.unshift(listing);
        return listing;
      }),

    closeBusinessListing: (id) =>
      call(() => {
        requireMember('business.view');
        const listing = state.myListings.find((l) => l.id === id && (l.status === 'pending' || l.status === 'published'));
        if (!listing) throw new ApiError('not_found', 'This listing is not available.');
        listing.status = 'closed';
      }),

    listIntroductions: () => call(() => { requireMember('business.view'); return state.introductions; }),

    requestIntroduction: (listingId, note) =>
      call(() => {
        requireMember('business.view');
        const parsed = introductionRequestSchema.safeParse({ listingId: '00000000-0000-4000-8000-000000000000', note });
        if (!parsed.success) throw validationError(parsed.error.issues);
        const listing = listingsForMember().find((l) => l.id === listingId && !l.mine);
        if (!listing) throw new ApiError('not_found', 'This listing is not available.');
        if (state.connections[listing.postedBy.memberId] === 'connected') throw new ApiError('conflict', 'You are already connected. Send a message instead.');
        if (state.introductions.some((i) => i.with.memberId === listing.postedBy.memberId && (i.status === 'requested' || i.status === 'offered'))) throw new ApiError('conflict', 'You have already asked for this introduction.');
        const now = new Date().toISOString();
        const introduction: Introduction = { id: `int-${state.nextId++}`, direction: 'outgoing', status: 'requested', note: parsed.data.note, listingTitle: listing.title, with: listing.postedBy, createdAt: now, updatedAt: now };
        state.introductions.unshift(introduction);
        return introduction;
      }),

    respondToIntroduction: (id, accept) =>
      call(() => {
        requireMember('business.view');
        const introduction = state.introductions.find((i) => i.id === id && i.direction === 'incoming');
        if (!introduction) throw new ApiError('not_found', 'This introduction is not available.');
        if (introduction.status !== 'offered') throw new ApiError('conflict', 'This introduction has already been answered.');
        introduction.status = accept ? 'accepted' : 'declined';
        if (accept) state.connections[introduction.with.memberId] = 'connected';
        return introduction;
      }),

    withdrawIntroduction: (id) =>
      call(() => {
        requireMember('business.view');
        const introduction = state.introductions.find((i) => i.id === id && i.direction === 'outgoing' && (i.status === 'requested' || i.status === 'offered'));
        if (!introduction) throw new ApiError('not_found', 'This introduction is not available.');
        introduction.status = 'withdrawn';
      }),

    listBusinessUpdates: () => call(() => { const session = requireMember('business.view'); return SEED_UPDATES.filter(() => marketId() !== JOBURG).filter((u) => u.audience.length === 0 || u.audience.some((role) => session.roles.includes(role))); }),
    listRmEnquiries: () => call(() => { requireMember('business.view'); return state.enquiries; }),
    createRmEnquiry: (input) =>
      call(() => {
        const session = requireMember('business.view');
        const parsed = rmEnquiryInputSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const d = parsed.data;
        const update = d.updateId ? SEED_UPDATES.find((u) => u.id === d.updateId && (u.audience.length === 0 || u.audience.some((role) => session.roles.includes(role)))) : null;
        if (d.updateId && !update) throw new ApiError('not_found', 'This opportunity is not available.');
        if (state.enquiries.filter((e) => e.status === 'open').length >= 10) throw new ApiError('conflict', 'You have ten open enquiries. Close one before starting another.');
        const now = new Date().toISOString(), n = state.nextId++;
        const enquiry: RmEnquiry = { id: `rme-${n}`, topic: update ? 'opportunity' : d.topic, subject: d.subject, updateTitle: update?.title ?? null, status: 'open', createdAt: now, messages: [{ id: `rmm-${n}`, from: 'member', body: d.message, sentAt: now }] };
        state.enquiries.unshift(enquiry);
        return enquiry;
      }),
    sendRmMessage: (id, body) =>
      call(() => {
        requireMember('business.view');
        const enquiry = state.enquiries.find((e) => e.id === id);
        if (!enquiry) throw new ApiError('not_found', 'This enquiry is not available.');
        if (enquiry.status === 'closed') throw new ApiError('conflict', 'This enquiry is closed.');
        const parsed = messageBodySchema.safeParse({ body });
        if (!parsed.success) throw validationError(parsed.error.issues);
        enquiry.messages.push({ id: `rmm-${state.nextId++}`, from: 'member', body: parsed.data.body, sentAt: new Date().toISOString() });
        return enquiry;
      }),
    closeRmEnquiry: (id) =>
      call(() => {
        requireMember('business.view');
        const enquiry = state.enquiries.find((e) => e.id === id && e.status === 'open');
        if (!enquiry) throw new ApiError('not_found', 'This enquiry is not available.');
        enquiry.status = 'closed';
      }),

    setMyAvatar: (contentType, dataBase64) =>
      call(() => {
        requireMember('profile.edit');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || dataBase64.length < 16) throw new ApiError('validation', 'That file is not a JPEG, PNG or WebP image.', { file: 'Not an image' });
        if (dataBase64.length > 2 * 1024 * 1024 * 4 / 3 + 8) throw new ApiError('validation', 'Photographs can be up to 2 MB.', { file: 'Too large' });
        state.avatar = `data:${contentType};base64,${dataBase64}`;
        return { ...state.myProfile, avatarPath: state.avatar, connection: 'none' as const };
      }),
    removeMyAvatar: () => call(() => { requireMember('profile.edit'); state.avatar = null; return { ...state.myProfile, avatarPath: null, connection: 'none' as const }; }),
    listHomeSlides: () => call(() => []),
    listLifestyleServices: () => call(() => servicesHere().map(forViewer)),
    getLifestyleService: (serviceId) => call(() => {
      const service = servicesHere().find((x) => x.id === serviceId);
      if (!service) throw new ApiError('not_found', 'This service is not available.');
      return forViewer(service);
    }),
    requestLifestyleService: (serviceId, input) =>
      call(() => {
        const service = servicesHere().find((candidate) => candidate.id === serviceId);
        const parsed = serviceRequestInputSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        if (!service) throw new ApiError('not_found', 'This service is not available.');
        if (!state.session && !parsed.data.guest) throw new ApiError('validation', 'Enter your name and email address.', { fullName: 'Enter your name', email: 'Enter your email address' });
        if (parsed.data.preferredDate && parsed.data.preferredDate < saToday()) throw new ApiError('validation', 'Choose a date from today onwards.', { preferredDate: 'Choose a date from today onwards' });
        const pkg = parsed.data.packageId ? service.packages.find((x) => x.id === parsed.data.packageId) : null;
        if (parsed.data.packageId && !pkg) throw new ApiError('validation', 'Choose one of the packages offered.', { packageId: 'Choose one of the packages offered' });
        if (pkg && parsed.data.preferredDate && parsed.data.preferredDate < earliestDate(pkg.leadTimeHours, saToday())) {
          const first = earliestDate(pkg.leadTimeHours, saToday());
          throw new ApiError('validation', `${pkg.name} needs ${pkg.leadTimeHours <= 0 ? 'no notice' : leadTimeLabel(pkg.leadTimeHours)}. The earliest date is ${longDay(first)}.`, { preferredDate: `The earliest date is ${longDay(first)}` });
        }
        const request: ServiceRequest = { id: `srq-${state.nextId++}`, serviceName: service.name, preferredDate: parsed.data.preferredDate ?? null, notes: parsed.data.notes, status: 'requested', createdAt: new Date().toISOString(), packageName: pkg?.name ?? null, priceLabel: pkg ? packagePriceLabel(pkg) : null };
        if (state.session) state.serviceRequests.unshift(request);
        return request;
      }),
    listMyServiceRequests: () => call(() => { requireMember('concierge.request'); return state.serviceRequests; }),
    cancelMyServiceRequest: (id) =>
      call(() => {
        requireMember('concierge.request');
        const request = state.serviceRequests.find((r) => r.id === id && ['requested', 'in_progress', 'confirmed'].includes(r.status));
        if (!request) throw new ApiError('not_found', 'This request is not available.');
        request.status = 'cancelled';
      }),
    listProducts: () => call(() => { require('boutique.browse'); return productsForMember(); }),

    listDeliveryOptions: () => call(() => { require('boutique.shop'); return DELIVERY; }),

    setWishlist: (productId, wished) =>
      call(() => {
        requireMember('boutique.browse');
        if (!PRODUCTS.some((p) => p.id === productId)) throw new ApiError('not_found', 'This product is not available.');
        state.wished = state.wished.filter((id) => id !== productId);
        if (wished) state.wished.push(productId);
      }),

    createOrder: (input) =>
      call(() => {
        const session = require('boutique.shop');
        const shape = orderInputSchema.safeParse({ ...input, deliveryOptionId: input?.deliveryOptionId ? '00000000-0000-4000-8000-000000000000' : undefined, items: (input?.items ?? []).map((item) => ({ ...item, productId: '00000000-0000-4000-8000-000000000000' })) });
        if (!shape.success) throw validationError(shape.error.issues);
        if (new Set(input.items.map((i) => `${i.productId}|${i.option ?? ''}`)).size !== input.items.length) throw new ApiError('validation', 'The same item appears twice');
        if (!session && !shape.data.guest) throw new ApiError('validation', 'Enter your name and email address so we can confirm your order.', { guest: 'Enter your name and email address' });
        const products = productsForMember();
        const lines = input.items.map((item) => {
          const product = products.find((p) => p.id === item.productId);
          if (!product) throw new ApiError('not_found', 'One of these products is no longer available.');
          const option = item.option ?? '';
          if (product.options.length ? !product.options.includes(option) : option !== '') throw new ApiError('validation', `Choose an option for ${product.title}.`, { items: 'Choose an option' });
          if (product.stock !== null && product.stock < item.quantity) throw new ApiError('conflict', `${product.title} is sold out.`);
          return { product, option, quantity: item.quantity };
        });
        const delivery = DELIVERY.find((d) => d.id === input.deliveryOptionId);
        if (!delivery) throw new ApiError('validation', 'Choose how you would like it delivered.', { deliveryOptionId: 'Choose a delivery method' });
        const goods = lines.reduce((sum, l) => sum + l.product.priceMinor * l.quantity, 0), fee = deliveryFee(delivery, goods);
        for (const line of lines) state.sold[line.product.id] = (state.sold[line.product.id] ?? 0) + line.quantity;
        const order = {
          id: `ord-${state.nextId}`, orderNumber: `Q-${20431 + state.nextId++}`, status: 'awaiting_payment' as const, currency: 'ZAR', refundedMinor: 0,
          items: lines.map((l) => ({ title: l.product.title, option: l.option, quantity: l.quantity, unitPriceMinor: l.product.priceMinor })).sort((a, b) => a.title.localeCompare(b.title)),
          totalMinor: goods + fee, deliveryLabel: delivery.name, deliveryFeeMinor: fee, courier: null, trackingNumber: null, trackingUrl: null, deliveryName: session ? session.fullName : shape.data.guest!.fullName, deliveryAddress: shape.data.deliveryAddress, createdAt: new Date().toISOString(),
          receivedBy: null, timeline: [{ kind: 'placed' as const, at: new Date().toISOString(), note: '' }] as Order['timeline'],
          lines: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        };
        state.orders.unshift(order);
        return publicOrder(order);
      }),

    payOrder: (orderId) =>
      call(() => {
        require('boutique.shop');
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new ApiError('not_found', 'This order is not available.');
        if (order.status !== 'awaiting_payment') throw new ApiError('conflict', 'This order has nothing to pay.');
        order.status = 'paid'; order.paid = true; order.timeline = [...order.timeline, { kind: 'paid', at: new Date().toISOString(), note: '' }];
        if (state.session) state.notifications.unshift({ id: `ntf-o${state.nextId++}`, category: 'order', title: `Thank you. Order ${order.orderNumber} is paid and will be prepared for delivery.`, createdAt: new Date().toISOString(), readAt: null, link: null });
        return publicOrder(order);
      }),

    cancelOrder: (orderId) =>
      call(() => {
        require('boutique.shop');
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new ApiError('not_found', 'This order is not available.');
        if (order.status !== 'awaiting_payment' && order.status !== 'paid') throw new ApiError('conflict', 'This order is already being prepared. Ask the concierge desk for help.');
        const now = new Date().toISOString();
        order.timeline = [...order.timeline, { kind: 'cancelled', at: now, note: 'Cancelled by the buyer.' }, ...(order.paid ? [{ kind: 'refunded' as const, at: now, note: 'Returned to the original payment method.' }] : [])];
        if (order.paid) order.refundedMinor = order.totalMinor;
        order.status = 'cancelled';
        for (const line of order.lines) state.sold[line.productId] = (state.sold[line.productId] ?? 0) - line.quantity;
        return publicOrder(order);
      }),

    listOrders: () => call(() => { require('boutique.shop'); return state.orders.map(publicOrder); }),

    listTvSeries: () =>
      call(() => {
        require('tv.browse');
        const member = state.session !== null && can(state.session, 'tv.watch');
        return [{
          id: 'ser-long-table', title: 'The Long Table', summary: 'One Quintara gathering per episode, from the first delivery to the last glass.', imagePath: null,
          episodes: EPISODES.map((e) => { const allowed = member || e.audience === 'public', mine = member ? state.watched[e.id] : undefined; return { ...e, locked: !allowed, videoUrl: allowed ? e.videoUrl : null, positionSeconds: mine?.positionSeconds ?? 0, completed: mine?.completed ?? false }; }),
        }];
      }),

    saveTvProgress: (episodeId, positionSeconds) =>
      call(() => {
        requireMember('tv.watch');
        const episode = EPISODES.find((e) => e.id === episodeId);
        if (!episode) throw new ApiError('not_found', 'This episode is not available.');
        if (!Number.isInteger(positionSeconds) || positionSeconds < 0 || positionSeconds > 86400) throw new ApiError('validation', 'That position could not be read.');
        const position = Math.min(positionSeconds, episode.durationSeconds);
        state.watched[episodeId] = { positionSeconds: position, completed: Boolean(state.watched[episodeId]?.completed) || position >= episode.durationSeconds - 20 };
      }),

    listPartners: () => call(() => { requireMember('privileges.use'); return partnersForMember(); }),

    getPartner: (id) =>
      call(() => {
        requireMember('privileges.use');
        const partner = partnersForMember().find((candidate) => candidate.id === id);
        if (!partner) throw new ApiError('not_found', 'This partner is not available.');
        return partner;
      }),

    redeemPrivilege: (privilegeId) =>
      call(() => {
        requireMember('privileges.use');
        const privilege = partnersForMember().flatMap((partner) => partner.privileges).find((candidate) => candidate.id === privilegeId);
        if (!privilege) throw new ApiError('not_found', 'This privilege is not available.');
        if (privilege.validUntil && privilege.validUntil < new Date().toISOString().slice(0, 10)) throw new ApiError('conflict', 'This privilege has ended.');
        if (!privilege.available) throw new ApiError('conflict', 'You have already used this privilege.');
        const n = state.nextId++;
        const redemption: Redemption = { id: `red-${n}`, code: `QP-${(n * 104729 + 1000000).toString(16).toUpperCase()}`, privilegeId, privilegeTitle: privilege.title, partnerName: PARTNERS.find((p) => p.id === privilege.partnerId)!.name, redeemedAt: new Date().toISOString() };
        state.redemptions.unshift(redemption);
        return redemption;
      }),

    listMyRedemptions: () => call(() => { requireMember('privileges.use'); return state.redemptions; }),

    getPrivacySettings: () => call(() => { requireMember('profile.edit'); return { ...state.privacy }; }),

    updatePrivacySettings: (settings) =>
      call(() => {
        requireMember('profile.edit');
        if (typeof settings?.showInDirectory !== 'boolean' || typeof settings?.marketingEmail !== 'boolean') throw new ApiError('validation', 'Those settings could not be read.');
        state.privacy = { showInDirectory: settings.showInDirectory, marketingEmail: settings.marketingEmail, suggestions: settings.suggestions ?? true, weeklyBrief: settings.weeklyBrief ?? true, dailyBrief: settings.dailyBrief ?? true };
        return { ...state.privacy };
      }),

    exportMyData: () =>
      call(() => {
        const session = requireMember('profile.edit');
        return { exportedAt: new Date().toISOString(), email: session.email, profile: state.myProfile, privacy: state.privacy, bookings: state.bookings.map(toBooking), conciergeRequests: state.requests, notifications: state.notifications, qeraMemory: state.memory, qeraReminders: state.reminders };
      }),

    closeMyAccount: (confirm) =>
      call(() => {
        requireMember('profile.edit');
        if (confirm !== 'CLOSE') throw new ApiError('validation', 'Type CLOSE to confirm.', { confirm: 'Type CLOSE to confirm' });
        state.session = null;
        return { eraseAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() };
      }),

    getMyProfile: () => call(() => { requireMember('profile.edit'); return { ...state.myProfile, avatarPath: state.avatar, connection: 'none' as const }; }),

    updateMyProfile: (update) =>
      call(() => {
        requireMember('profile.edit');
        const parsed = profileUpdateSchema.safeParse(update);
        if (!parsed.success) throw validationError(parsed.error.issues);
        state.myProfile = { ...state.myProfile, ...parsed.data };
        return { ...state.myProfile, avatarPath: state.avatar, connection: 'none' as const };
      }),

    getApplication: () => call(() => state.application),

    saveApplicationDraft: (data: ApplicationData) =>
      call(() => {
        if (state.application && state.application.status !== 'draft') throw new ApiError('conflict', 'This application has already been sent.');
        state.application = { id: state.application?.id ?? 'app-1', status: 'draft', data, offeredTierName: null, submittedAt: null };
        return state.application;
      }),

    submitApplication: (data: ApplicationData) =>
      call(() => {
        if (state.application && state.application.status !== 'draft') throw new ApiError('conflict', 'This application has already been sent.');
        const parsed = applicationSchema.safeParse(data);
        if (!parsed.success) throw validationError(parsed.error.issues);
        if (!MOCK_PLANS.some((p) => p.id === parsed.data.planId && p.residency === parsed.data.residency)) throw validationError([{ path: ['planId'], message: 'Choose the membership you are applying for' }]);
        state.application = { id: state.application?.id ?? 'app-1', status: 'submitted', data: parsed.data, offeredTierName: null, submittedAt: new Date().toISOString() };
        return state.application;
      }),

    listMembershipPlans: () => call(() => MOCK_PLANS),

    getApplicationQuestions: () => call(() => ({ builtin: BUILTIN_QUESTION_KEYS.map((key) => ({ key, ...BUILTIN_QUESTION_DEFAULTS[key], edited: false })), custom: [] })),

    payMembershipFee: () =>
      call(() => {
        if (!state.application || state.application.status !== 'payment_pending') throw new ApiError('conflict', 'There is no membership fee to pay yet.');
        state.application = { ...state.application, status: 'active' };
        return state.application;
      }),

    listConciergeRequests: () => call(() => { requireMember('concierge.request'); return [...state.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }),

    getConciergeRequest: (id) => call(() => { requireMember('concierge.request'); return findRequest(id); }),

    createConciergeRequest: (input) =>
      call(() => {
        requireMember('concierge.request');
        const parsed = conciergeRequestSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const created: ConciergeRequest = { id: `req-${state.nextId++}`, ...parsed.data, neededBy: parsed.data.neededBy ?? null, status: 'requested', createdAt: new Date().toISOString(), messages: [] };
        state.requests.push(created);
        return created;
      }),

    sendConciergeMessage: (id, body) =>
      call(() => {
        requireMember('concierge.request');
        const request = findRequest(id);
        if (request.status === 'completed' || request.status === 'cancelled') throw new ApiError('conflict', 'This request is closed.');
        const parsed = messageBodySchema.safeParse({ body });
        if (!parsed.success) throw validationError(parsed.error.issues);
        request.messages.push({ id: `cm-${state.nextId++}`, from: 'member', body: parsed.data.body, sentAt: new Date().toISOString() });
        return request;
      }),

    confirmConciergeRequest: (id) =>
      call(() => {
        requireMember('concierge.request');
        const request = findRequest(id);
        if (request.status !== 'options_provided') throw new ApiError('conflict', 'There are no options to confirm yet.');
        request.status = 'confirmed';
        return request;
      }),

    cancelConciergeRequest: (id) =>
      call(() => {
        requireMember('concierge.request');
        const request = findRequest(id);
        if (request.status === 'completed' || request.status === 'cancelled') throw new ApiError('conflict', 'This request is already closed.');
        request.status = 'cancelled';
        return request;
      }),

    listConversations: () =>
      call(() => {
        requireMember('messages.use');
        return Object.entries(state.chats).filter(([memberId, messages]) => messages.length > 0 && !state.blocked.includes(memberId)).map(([memberId, messages]) => {
          const partner = MEMBERS.find((member) => member.id === memberId)!, last = messages[messages.length - 1]!;
          return { memberId, fullName: partner.fullName, position: partner.position, company: partner.company, lastMessage: last.body, lastMessageAt: last.sentAt, unread: Boolean(state.chatUnread[memberId]) };
        }).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      }),

    getConversation: (memberId) => call(() => { requireMember('messages.use'); return thread(memberId); }),

    sendMessage: (memberId, body) =>
      call(() => {
        requireMember('messages.use');
        const current = thread(memberId);
        if (!current.canSend) throw new ApiError('forbidden', 'Messaging opens once you are connected.');
        const parsed = messageBodySchema.safeParse({ body });
        if (!parsed.success) throw validationError(parsed.error.issues);
        (state.chats[memberId] ??= []).push({ id: `msg-${state.nextId++}`, mine: true, body: parsed.data.body, sentAt: new Date().toISOString() });
        return thread(memberId);
      }),

    markConversationRead: (memberId) => call(() => { requireMember('messages.use'); state.chatUnread[memberId] = false; }),

    listNotifications: () => call(() => { requireMember('notifications.view'); return state.notifications; }),

    registerPushDevice: (input) => call(() => {
      if (!state.session && !asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
      const parsed = pushRegistrationSchema.safeParse(input);
      if (!parsed.success) throw validationError(parsed.error.issues);
      const p = pushState(), now = new Date().toISOString();
      p.devices = p.devices.filter((d) => d.token !== parsed.data.token);
      const device = { id: `pd-${state.nextId++}`, token: parsed.data.token, platform: parsed.data.platform, deviceName: parsed.data.deviceName, createdAt: now, lastSeenAt: now, thisDevice: true };
      p.devices.unshift(device);
      return { id: device.id };
    }),
    unregisterPushDevice: (token) => call(() => { const p = pushState(); p.devices = p.devices.filter((d) => d.token !== token); }),
    removePushDevice: (id) => call(() => { const p = pushState(); p.devices = p.devices.filter((d) => d.id !== id); }),
    getPushSettings: () => call(() => {
      if (!state.session && !asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
      const p = pushState();
      return { muted: [...p.muted], showDetails: p.showDetails, devices: p.devices.map(({ token: _t, ...d }) => d) };
    }),
    updatePushSettings: (input) => call(() => {
      if (!state.session && !asGuest()) throw new ApiError('unauthenticated', 'Sign in to continue.');
      const parsed = pushSettingsInputSchema.safeParse(input);
      if (!parsed.success) throw validationError(parsed.error.issues);
      const p = pushState();
      p.muted = [...new Set(parsed.data.muted)]; p.showDetails = parsed.data.showDetails;
      return { muted: [...p.muted], showDetails: p.showDetails, devices: p.devices.map(({ token: _t, ...d }) => d) };
    }),
    sendTestPush: () => call(() => {
      if (!pushState().devices.length) throw new ApiError('conflict', 'No phone is registered for push notifications. Turn them on in the Quintara app first.');
      if (state.session) state.notifications.unshift({ id: `n-${state.nextId++}`, category: 'membership_update', title: 'This is a test notification from Quintara.', createdAt: new Date().toISOString(), readAt: null, link: null });
    }),

    getMembership: () => call(() => membershipStatus()),
    getPaymentConfig: () => call(() => ({ provider: 'mock', testCards: true })),
    saveCard: (setupToken) => call(() => {
      membershipOwner();
      const parsed = paymentMethodInputSchema.safeParse({ setupToken });
      if (!parsed.success) throw validationError(parsed.error.issues);
      const cards: Record<string, [string, string]> = { test_card_visa: ['Visa', '4242'], test_card_mastercard: ['Mastercard', '4444'], test_card_declined: ['Visa', '0002'] };
      const card = cards[parsed.data.setupToken];
      if (!card) throw new ApiError('validation', 'The card could not be saved. Try again, or use another card.', { setupToken: 'The card could not be saved' });
      renewalState().card = { brand: card[0], last4: card[1], expMonth: 12, expYear: new Date().getFullYear() + 3, declines: parsed.data.setupToken === 'test_card_declined' };
      return membershipStatus();
    }),
    removeCard: () => call(() => {
      membershipOwner();
      const r = renewalState();
      if (!r.card) throw new ApiError('not_found', 'There is no saved card.');
      r.card = null; r.autoRenew = false;
      return membershipStatus();
    }),
    setAutoRenew: (autoRenew) => call(() => {
      membershipOwner();
      const r = renewalState();
      if (autoRenew && !r.card) throw new ApiError('conflict', 'Add a card first.');
      r.autoRenew = autoRenew;
      return membershipStatus();
    }),
    renewMembership: (_key) => call(() => {
      membershipOwner();
      const r = renewalState(), now = membershipStatus();
      if (!now.canRenewNow) throw new ApiError('conflict', 'Your membership can be renewed from 30 days before it ends.');
      if (!r.card) throw new ApiError('conflict', 'Add a card first.');
      const at = new Date().toISOString();
      if (r.card.declines) {
        r.history.unshift({ id: `rp-${state.nextId++}`, at, amountMinor: 3_000_000, currency: 'ZAR', status: 'failed', periodEnd: null, reason: 'The card was declined.' });
        throw new ApiError('conflict', 'The payment did not go through. The card was declined.');
      }
      const from = r.lapsed ? new Date() : new Date(r.termEndsAt), end = new Date(from); end.setMonth(end.getMonth() + 12);
      r.termEndsAt = end.toISOString(); r.lapsed = false;
      r.history.unshift({ id: `rp-${state.nextId++}`, at, amountMinor: 3_000_000, currency: 'ZAR', status: 'paid', periodEnd: r.termEndsAt, reason: null });
      if (lapsedSession) { state.session = lapsedSession; lapsedSession = null; }
      return membershipStatus();
    }),

    markNotificationRead: (id) =>
      call(() => {
        requireMember('notifications.view');
        const notification = state.notifications.find((candidate) => candidate.id === id);
        if (notification && !notification.readAt) notification.readAt = new Date().toISOString();
      }),

    getQeraThread: () => call(() => { if (asGuest()) return guestThread(); requireMember('qera.use'); return qeraThread(); }),

    getQeraMemory: () =>
      call(() => {
        requireMember('qera.use');
        const known = new Set(state.memory.map((m) => m.label.toLowerCase()));
        const counts = new Map<string, number>();
        for (const b of state.partnerBookings) if (b.status !== 'cancelled') counts.set(b.partnerName, (counts.get(b.partnerName) ?? 0) + 1);
        const suggestions: QeraMemorySuggestion[] = [...counts].filter(([name]) => !known.has(name.toLowerCase())).slice(0, 3).map(([name, n]) => ({ kind: 'favourite' as const, label: name, detail: '', reason: `You have booked ${name} ${n === 1 ? 'once' : `${n} times`} through QÉRA.` }));
        if (!known.has('retreats') && state.bookings.some((b) => b.experienceId === 'exp-costa-convivio' && b.status === 'confirmed')) suggestions.push({ kind: 'likes', label: 'Retreats', detail: '', reason: 'You have booked retreats experiences.' });
        return { items: [...state.memory].sort((a, b) => a.kind.localeCompare(b.kind)), suggestions };
      }),
    addQeraMemory: (input) => call(() => addMemory(input, 'member')),
    updateQeraMemory: (id, input) =>
      call(() => {
        requireMember('profile.edit');
        const parsed = qeraMemoryInputSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const item = state.memory.find((m) => m.id === id);
        if (!item) throw new ApiError('not_found', 'QÉRA does not remember that.');
        Object.assign(item, { kind: parsed.data.kind, label: parsed.data.label, detail: parsed.data.detail, date: parsed.data.kind === 'date' ? parsed.data.date : null, updatedAt: new Date().toISOString() });
        return { ...item };
      }),
    deleteQeraMemory: (id) => call(() => { removeMemory(id); }),
    clearQeraMemory: () => call(() => { requireMember('profile.edit'); state.memory = []; }),
    getDailyBrief: async () => {
      await call(() => requireMember('qera.use'));
      return dailyBrief();
    },
    getCalendar: () => call(() => { requireMember('qera.use'); return calendarState(); }),
    connectCalendar: (input) =>
      call(() => {
        requireMember('qera.use');
        const parsed = calendarConnectSchema.safeParse(input);
        if (!parsed.success) throw validationError(parsed.error.issues);
        const d = parsed.data;
        if (d.provider !== 'sample') {
          let url: URL | null = null;
          try { url = new URL(d.address.replace(/^webcals?:\/\//i, 'https://')); } catch { /* reported below */ }
          if (!url || url.protocol !== 'https:' || !CALENDAR_HOSTS[d.provider].test(url.hostname)) throw new ApiError('validation', `That is not a ${CALENDAR_PROVIDER_LABEL[d.provider]} address.`, { address: `Paste the private address from ${CALENDAR_PROVIDER_LABEL[d.provider]}` });
        }
        state.calendar = { provider: d.provider, label: CALENDAR_PROVIDER_LABEL[d.provider], showTitles: d.showTitles, connectedAt: new Date().toISOString() };
        return calendarState();
      }),
    updateCalendar: ({ showTitles }) =>
      call(() => {
        requireMember('qera.use');
        if (!state.calendar) throw new ApiError('not_found', 'No calendar is connected.');
        state.calendar.showTitles = showTitles;
        return calendarState();
      }),
    syncCalendar: () => call(() => { requireMember('qera.use'); if (!state.calendar) throw new ApiError('not_found', 'No calendar is connected.'); return calendarState(); }),
    disconnectCalendar: () => call(() => { requireMember('qera.use'); state.calendar = null; }),
    // The mock has no WhatsApp to receive the code, so a pending link stays pending.
    getWhatsApp: () => call(() => whatsAppState()),
    linkWhatsApp: (input) => call(() => {
      whatsAppHolder();
      const parsed = whatsAppLinkSchema.safeParse(input);
      if (!parsed.success) throw validationError(parsed.error.issues);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      state.whatsapp = { status: state.whatsapp?.status === 'linked' ? 'linked' : 'pending', code, linkedAt: state.whatsapp?.linkedAt ?? null };
      return { ...whatsAppState(), code, message: linkMessage(code), openUrl: waMeLink(MOCK_WHATSAPP_NUMBER, linkMessage(code)), codeExpiresAt: new Date(Date.now() + WHATSAPP_CODE_MINUTES * 60_000).toISOString() };
    }),
    unlinkWhatsApp: () => call(() => { whatsAppHolder(); state.whatsapp = null; }),
    getWeeklyBrief: async () => {
      await call(() => requireMember('qera.use'));
      return weeklyBrief();
    },
    listReminders: () => call(() => { requireMember('qera.use'); return state.reminders.filter((r) => r.status !== 'cancelled').sort((a, b) => a.remindAt.localeCompare(b.remindAt)); }),
    createReminder: (input) => call(() => addReminder(input, 'member')),
    cancelReminder: (id) =>
      call(() => {
        requireMember('qera.use');
        const r = state.reminders.find((x) => x.id === id && x.status === 'scheduled');
        if (!r) throw new ApiError('not_found', 'This reminder is not waiting.');
        r.status = 'cancelled';
      }),
    previewPlanBooking: async (documentId, partySize = 2) => {
      const doc = await call(() => { requireMember('experiences.book'); return planDoc(documentId); });
      const size = Math.max(1, Math.min(20, Math.trunc(partySize) || 2));
      const lines = await planLines(doc.content, doc.booked ?? {}, size);
      const dietary = state.memory.filter((m) => m.kind === 'dietary').map((m) => m.label);
      return {
        documentId: doc.id, title: doc.title, partySize: size, lines: lines.map((l) => l.line),
        notes: ['Each line is booked in your name, with the same checks as booking it yourself. Nothing is paid now: seats that need paying for are held, and you pay under Bookings.', 'Partners and the concierge desk are given your name, the date, the time and the number of guests.', ...(dietary.length ? [`Restaurants and chefs are also told your dietary needs: ${dietary.join(', ')}.`] : [])],
      };
    },
    bookPlan: async (documentId, input) => {
      const doc = await call(() => { requireMember('experiences.book'); return planDoc(documentId); });
      const parsed = planBookingInputSchema.safeParse(input);
      if (!parsed.success) throw validationError(parsed.error.issues);
      const lines = (await planLines(doc.content, doc.booked ?? {}, parsed.data.partySize)).filter((l) => parsed.data.lines.includes(l.line.index));
      if (!lines.length) throw new ApiError('validation', 'Choose at least one line to book.', { lines: 'Choose at least one line' });
      const dietary = state.memory.filter((m) => m.kind === 'dietary').map((m) => m.label);
      const results: PlanBookingResult['lines'] = [];
      const booked: Record<string, string> = { ...(doc.booked ?? {}) };
      for (const l of lines) {
        if (!l.line.bookable) { results.push({ index: l.line.index, title: l.line.title, ok: false, text: l.line.status ? `Already done: ${l.line.status}` : l.line.action }); continue; }
        const note = [`From the plan \u201c${doc.title}\u201d.`, l.dining && dietary.length ? `Dietary needs: ${dietary.join(', ')}.` : ''].filter(Boolean).join(' ');
        try {
          let text: string;
          if (l.ref.kind === 'experience') { const b = await api.bookExperience(l.ref.id, l.seats); text = b.status === 'awaiting_payment' ? `Seats held. Pay ${formatMoney(b.amountDueMinor, b.currency)} under Bookings.` : BOOKING_STATUS_LABEL[b.status]; }
          else if (l.ref.kind === 'partner') { const partner = PARTNERS.find((x) => x.id === l.ref.id)!; await call(() => { state.partnerBookings.unshift({ id: `pbk-${state.nextId++}`, partnerId: partner.id, partnerName: partner.name, date: l.date, time: l.time, partySize: parsed.data.partySize, notes: note, status: 'requested', partnerNote: '', createdAt: new Date().toISOString() }); }); text = `Sent to ${partner.name}`; }
          else { const r = await api.requestLifestyleService(l.ref.id, { preferredDate: l.date, notes: `${note} For ${parsed.data.partySize}.`, packageId: l.packageId }); text = `Requested${r.packageName ? `: ${r.packageName}` : ''}`; }
          booked[String(l.line.index)] = text;
          results.push({ index: l.line.index, title: l.line.title, ok: true, text });
        } catch (error) { results.push({ index: l.line.index, title: l.line.title, ok: false, text: error instanceof ApiError ? error.message : 'This line could not be booked.' }); }
      }
      await call(() => { const stored = state.documents.find((d) => d.id === doc.id); if (stored) stored.booked = booked; });
      return { lines: results };
    },

    qeraHeartbeat: () => call(() => (asGuest() ? chargeGuest(GUEST_HEARTBEAT_CAP) : (requireMember('qera.use'), null))),

    sendQeraMessage: async (text) => {
      if (await call(() => asGuest())) {
        await call(() => {
          const parsed = qeraMessageSchema.safeParse({ text });
          if (!parsed.success) throw validationError(parsed.error.issues);
          if (guestUsageNow().exhausted) throw new ApiError('forbidden', GUEST_LIMIT_MESSAGE);
          chargeGuest(GUEST_MESSAGE_CAP);
          guestSay('member', parsed.data.text);
        });
        const tools = qeraTools();
        const allowed = Object.fromEntries(GUEST_QERA_TOOLS.map((name) => [name, name === 'recommend' ? guestRecommend : name === 'about_quintara' ? guestAbout : tools[name]])) as QeraToolbox;
        const turn = await qeraTurn(qeraModel, allowed, text.trim(), 'guest');
        return call(() => { guestSay('qera', turn.reply); return guestThread(); });
      }
      await call(() => {
        requireMember('qera.use');
        const parsed = qeraMessageSchema.safeParse({ text });
        if (!parsed.success) throw validationError(parsed.error.issues);
        state.qera.pending = null;
        qeraSay('member', parsed.data.text);
      });
      const turn = await qeraTurn(qeraModel, qeraTools(), text.trim());
      return call(() => {
        if (turn.proposal) state.qera.pending = { id: `prp-${state.nextId++}`, tool: turn.proposal.tool, summary: turn.proposal.summary, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), args: turn.proposal.args };
        qeraSay('qera', turn.reply);
        return qeraThread();
      });
    },

    confirmQeraProposal: async (id) => {
      const pending = await call(() => {
        requireMember('qera.use');
        const waiting = state.qera.pending;
        if (!waiting || waiting.id !== id) throw new ApiError('conflict', 'That is no longer waiting for an answer.');
        state.qera.pending = null;
        return waiting;
      });
      let text: string;
      try { text = (await qeraTools()[pending.tool]!.run(pending.args as never)).text ?? 'Done.'; }
      catch (error) { text = `I could not do that. ${error instanceof ApiError ? error.message : 'Please try again.'}`; }
      return call(() => { qeraSay('qera', text); return qeraThread(); });
    },

    cancelQeraProposal: (id) =>
      call(() => {
        requireMember('qera.use');
        if (!state.qera.pending || state.qera.pending.id !== id) throw new ApiError('conflict', 'That is no longer waiting for an answer.');
        state.qera.pending = null;
        qeraSay('qera', 'Understood. I have not done anything.');
        return qeraThread();
      }),

    clearQeraThread: () => call(() => { if (asGuest()) { state.guestQera = []; return; } requireMember('qera.use'); state.qera = { messages: [], pending: null }; }),
    listQeraDocuments: () => call(() => { requireMember('qera.use'); return state.documents.map(({ content: _content, ...summary }) => summary); }),
    getQeraDocument: (id) => call(() => { requireMember('qera.use'); const found = state.documents.find((d) => d.id === id); if (!found) throw new ApiError('not_found', 'This document is not available.'); return found; }),
    deleteQeraDocument: (id) => call(() => { requireMember('qera.use'); if (!state.documents.some((d) => d.id === id)) throw new ApiError('not_found', 'This document is not available.'); state.documents = state.documents.filter((d) => d.id !== id); }),
    listPartnerBookings: () => call(() => { requireMember('privileges.use'); return state.partnerBookings; }),
    cancelPartnerBooking: (id) =>
      call(() => {
        requireMember('privileges.use');
        const booking = state.partnerBookings.find((b) => b.id === id && (b.status === 'requested' || b.status === 'confirmed'));
        if (!booking) throw new ApiError('not_found', 'This booking is not available.');
        booking.status = 'cancelled';
      }),
    // A partner's link is issued by the real API only.
    getPartnerBookingByToken: () => call(() => { throw new ApiError('not_found', 'This link is not valid.'); }),
    respondToPartnerBooking: () => call(() => { throw new ApiError('not_found', 'This link is not valid.'); }),
  };

  /* QÉRA in the mock: the same model and the same rules as the real API, with tools that call this mock. */
  /* ---------- Chief of Staff, offline ---------- */
  function addMemory(input: unknown, source: 'member' | 'qera'): QeraMemoryItem {
    requireMember('profile.edit');
    const parsed = qeraMemoryInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    if (state.memory.length >= 60) throw new ApiError('conflict', 'QÉRA remembers up to sixty things. Remove one before adding another.');
    if (state.memory.some((m) => m.kind === parsed.data.kind && m.label.toLowerCase() === parsed.data.label.toLowerCase())) throw new ApiError('conflict', 'QÉRA already remembers that.');
    const item: QeraMemoryItem = { id: `mem-${state.nextId++}`, kind: parsed.data.kind, label: parsed.data.label, detail: parsed.data.detail, date: parsed.data.kind === 'date' ? parsed.data.date : null, source, updatedAt: new Date().toISOString() };
    state.memory.push(item);
    return { ...item };
  }
  function removeMemory(id: string): QeraMemoryItem {
    requireMember('profile.edit');
    const item = state.memory.find((m) => m.id === id);
    if (!item) throw new ApiError('not_found', 'QÉRA does not remember that.');
    state.memory = state.memory.filter((m) => m.id !== id);
    return item;
  }
  function addReminder(input: unknown, source: 'member' | 'qera'): QeraReminder {
    requireMember('qera.use');
    const parsed = reminderInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const at = new Date(`${parsed.data.date}T${parsed.data.time}:00+02:00`);
    if (at.getTime() < Date.now() + 60_000) throw new ApiError('validation', 'Choose a time in the future.', { date: 'Choose a time in the future' });
    const r: QeraReminder = { id: `rem-${state.nextId++}`, text: parsed.data.text, remindAt: at.toISOString(), status: 'scheduled', source };
    state.reminders.push(r);
    return { ...r };
  }
  const whenLocal = (iso: string) => { const d = formatDateTime(iso, ZONE); return `${d.long}, ${d.time}`; };
  const nextOccurrence = (date: string, today: string) => { const y = Number(today.slice(0, 4)); const c = `${y}${date.slice(4)}`; return c >= today ? c : `${y + 1}${date.slice(4)}`; };
  const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
  /** The offline client reads only the sample week; a real calendar address is accepted but not read. */
  function calendarEventsNow(): CalendarEvent[] {
    const c = state.calendar;
    if (!c || c.provider !== 'sample') return [];
    const today = saToday();
    return SAMPLE_CALENDAR_WEEK.map(([day, start, end, title, location]) => {
      const date = addDaysIso(today, day);
      return { id: `sample-${day}-${start}`, title: c.showTitles ? title : '', location: c.showTitles ? location : '', startsAt: localToInstant(date, start, ZONE), endsAt: end ? localToInstant(date, end, ZONE) : null, allDay: false };
    });
  }
  function calendarState(): CalendarState {
    const c = state.calendar;
    if (!c) return { connection: null, events: [] };
    return { connection: { ...c, syncedAt: c.provider === 'sample' ? new Date().toISOString() : null, syncError: c.provider === 'sample' ? null : 'The offline preview cannot read real calendars. Connect the sample calendar to try the daily brief.' }, events: calendarEventsNow() };
  }
  async function dailyBrief(): Promise<DailyBrief> {
    const today = saToday(), tomorrow = addDaysIso(today, 1), weekEnd = addDaysIso(today, 7);
    const localDay = (iso: string) => new Date(new Date(iso).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
    const hm = (iso: string) => formatDateTime(iso, ZONE).time;
    const [experiences, bookings] = await Promise.all([api.listExperiences(), api.listBookings()]);
    const live = (status: string) => !['cancelled', 'declined', 'completed'].includes(status);
    const agenda: DailyItem[] = [
      ...calendarEventsNow().filter((e) => localDay(e.startsAt) === today).map((e): DailyItem => ({ time: e.allDay ? null : hm(e.startsAt), endTime: e.endsAt ? hm(e.endsAt) : null, title: e.title || 'Busy', detail: e.location, source: 'calendar', link: null })),
      ...bookings.filter((b) => live(b.status) && b.status !== 'waitlisted' && localDay(b.startsAt) === today).map((b): DailyItem => ({ time: hm(b.startsAt), endTime: null, title: b.experienceTitle, detail: `${b.venueName}, ${b.area}. ${b.seats} seat${b.seats > 1 ? 's' : ''}, ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.`, source: 'quintara', link: { kind: 'bookings' } })),
      ...state.partnerBookings.filter((b) => live(b.status) && b.date === today).map((b): DailyItem => ({ time: b.time, endTime: null, title: b.partnerName, detail: `For ${b.partySize}. ${b.status === 'confirmed' ? 'Confirmed' : 'Waiting for the partner to confirm'}.`, source: 'quintara', link: { kind: 'qera' } })),
      ...state.serviceRequests.filter((r) => live(r.status) && r.preferredDate === today).map((r): DailyItem => ({ time: null, endTime: null, title: r.serviceName, detail: `${r.packageName ?? 'Arranged by Quintara'}. ${r.status === 'confirmed' ? 'Confirmed' : 'Being arranged'}.`, source: 'quintara', link: null })),
      ...state.reminders.filter((r) => r.status === 'scheduled' && localDay(r.remindAt) === today).map((r): DailyItem => ({ time: hm(r.remindAt), endTime: null, title: r.text, detail: 'A reminder you asked for.', source: 'reminder', link: { kind: 'qera' } })),
    ].sort((a, b) => (a.time ?? '00:00').localeCompare(b.time ?? '00:00'));
    const ahead: BriefItem[] = [
      ...bookings.filter((b) => ['confirmed', 'awaiting_payment', 'applied'].includes(b.status) && localDay(b.startsAt) >= tomorrow && localDay(b.startsAt) <= weekEnd).map((b) => ({ title: b.experienceTitle, detail: `${longDay(localDay(b.startsAt))}, ${hm(b.startsAt)}. ${b.area}.`, link: { kind: 'bookings' as const } })),
      ...state.partnerBookings.filter((b) => live(b.status) && b.date >= tomorrow && b.date <= weekEnd).map((b) => ({ title: b.partnerName, detail: `${partnerWhen(b)}, for ${b.partySize}.`, link: { kind: 'qera' as const } })),
      ...state.memory.filter((m) => m.kind === 'date' && m.date).map((m) => ({ m, next: nextOccurrence(m.date!, today) })).filter(({ next }) => daysBetween(today, next) <= 14)
        .map(({ m, next }) => { const n = daysBetween(today, next); return { title: m.label, detail: `${n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${longDay(next)}, in ${n} days`}. Shall I plan something?`, link: { kind: 'qera' as const } }; }),
    ];
    const waiting: BriefItem[] = bookings.filter((b) => b.status === 'awaiting_payment').map((b) => ({ title: b.experienceTitle, detail: `Pay ${formatMoney(b.amountDueMinor, b.currency)} to keep your seats.`, link: { kind: 'bookings' as const } }));
    const hour = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    const busyEvening = agenda.some((i) => i.time !== null && i.time >= '17:30');
    const booked = new Set(bookings.filter((b) => live(b.status)).map((b) => b.experienceId));
    const soon = experiences.filter((e) => e.startsAt && !booked.has(e.id) && localDay(e.startsAt) >= today && daysBetween(today, localDay(e.startsAt)) <= 14 && (e.capacity ?? 0) > (e.seatsTaken ?? 0) && !(e.admission === 'invitation_only' && !e.invited));
    const favourite = state.memory.find((m) => m.kind === 'favourite')?.label;
    const suggestion: BriefItem | null = !busyEvening && hour < 17
      ? { title: 'Your evening is free', detail: favourite ? `Shall I ask ${favourite} for a table tonight? Tell me the time and how many.` : 'Shall I find you a table tonight? Tell me the time and how many, and I will book one of Quintara\u2019s partners.', link: { kind: 'qera' } }
      : soon[0] ? { title: soon[0].title, detail: `${longDay(localDay(soon[0].startsAt!))}, ${hm(soon[0].startsAt!)}. ${soon[0].category}, ${soon[0].area}. Seats are open.`, link: { kind: 'experience', id: soon[0].id } } : null;
    const counted = ['nothing', 'one thing', 'two things', 'three things', 'four things', 'five things', 'six things'][agenda.length] ?? `${agenda.length} things`;
    const timed = agenda.filter((i) => i.time);
    const c = state.calendar;
    return {
      date: today, dateLabel: longDay(today),
      greeting: `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, ${state.session!.fullName.split(' ')[0]}.`,
      summary: agenda.length ? `You have ${counted} today${timed[0] ? `, the first at ${timed[0].time}` : ''}.${busyEvening ? '' : ' Your evening is free.'}` : 'Your day is clear.',
      city: MARKETS.find((m) => m.id === marketId())?.name ?? '', agenda, ahead, waiting, suggestion,
      calendar: { connected: Boolean(c), label: c?.label ?? null, syncedAt: c?.provider === 'sample' ? new Date().toISOString() : null, showTitles: c?.showTitles ?? true },
      enabled: state.privacy.dailyBrief ?? true,
    };
  }
  async function weeklyBrief(): Promise<WeeklyBrief> {
    const today = saToday(), until = addDaysIso(today, 7), weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const [experiences, bookings] = await Promise.all([api.listExperiences(), api.listBookings()]);
    const localDay = (iso: string) => new Date(new Date(iso).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
    const week: BriefItem[] = [
      ...bookings.filter((b) => ['confirmed', 'awaiting_payment', 'applied', 'waitlisted'].includes(b.status) && localDay(b.startsAt) >= today && localDay(b.startsAt) < until).map((b) => ({ title: b.experienceTitle, detail: `${whenLocal(b.startsAt)}. ${b.seats} seat${b.seats > 1 ? 's' : ''}, ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.`, link: { kind: 'bookings' as const } })),
      ...state.partnerBookings.filter((b) => ['requested', 'confirmed'].includes(b.status) && b.date >= today && b.date < until).map((b) => ({ title: b.partnerName, detail: `${partnerWhen(b)}, for ${b.partySize}. ${b.status === 'confirmed' ? 'Confirmed' : 'Waiting for the partner'}.`, link: { kind: 'qera' as const } })),
      ...state.serviceRequests.filter((r) => r.preferredDate && r.preferredDate >= today && r.preferredDate < until && !['cancelled', 'completed'].includes(r.status)).map((r) => ({ title: r.serviceName, detail: `${longDay(r.preferredDate!)}${r.packageName ? `. ${r.packageName}` : ''}. Being arranged.`, link: null })),
      ...state.reminders.filter((r) => r.status === 'scheduled' && r.remindAt < new Date(Date.now() + 7 * 86_400_000).toISOString()).map((r) => ({ title: `Reminder: ${r.text}`, detail: whenLocal(r.remindAt), link: { kind: 'qera' as const } })),
    ];
    const dates: BriefItem[] = state.memory.filter((m) => m.kind === 'date' && m.date).map((m) => ({ m, next: nextOccurrence(m.date!, today) })).filter(({ next }) => daysBetween(today, next) <= 30).sort((a, b) => a.next.localeCompare(b.next))
      .map(({ m, next }) => { const n = daysBetween(today, next); return { title: m.label, detail: `${longDay(next)}, ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}. Shall I plan something?`, link: { kind: 'qera' as const } }; });
    const waiting: BriefItem[] = bookings.filter((b) => b.status === 'awaiting_payment').map((b) => ({ title: b.experienceTitle, detail: `Pay ${formatMoney(b.amountDueMinor, b.currency)} to keep your seats.`, link: { kind: 'bookings' as const } }));
    const likes = [...state.myProfile.interests, ...state.memory.filter((m) => m.kind === 'likes' || m.kind === 'favourite').map((m) => m.label)].map((x) => x.toLowerCase());
    const fits = (text: string) => likes.filter((l) => text.toLowerCase().includes(l)).length;
    const booked = new Set(bookings.filter((b) => !['cancelled', 'declined'].includes(b.status)).map((b) => b.experienceId));
    const chosen: BriefItem[] = experiences.filter((e) => !booked.has(e.id) && e.startsAt && localDay(e.startsAt) >= today && daysBetween(today, localDay(e.startsAt)) <= 60 && (e.capacity ?? 0) > (e.seatsTaken ?? 0) && !(e.admission === 'invitation_only' && !e.invited))
      .map((e, i) => ({ e, score: fits(`${e.title} ${e.category} ${e.summary}`) * 10 - i })).sort((a, b) => b.score - a.score).slice(0, 3).map(({ e }) => ({ title: e.title, detail: `${e.category}. ${whenLocal(e.startsAt!)}, ${e.area}.`, link: { kind: 'experience' as const, id: e.id } }));
    const service = [...servicesHere()].sort((a, b) => fits(`${b.name} ${b.category} ${b.description}`) - fits(`${a.name} ${a.category} ${a.description}`))[0]!;
    const worth: BriefItem[] = [{ title: service.name, detail: `${service.packages[0]!.name}: ${packagePriceLabel(service.packages[0]!)}, ${leadTimeLabel(service.packages[0]!.leadTimeHours).toLowerCase()}.`, link: { kind: 'service', id: service.id } }];
    const hour = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    void weekday;
    return {
      weekOf: addDaysIso(today, -((weekday + 6) % 7)),
      greeting: `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, ${state.session!.fullName.split(' ')[0]}. ${week.length ? `You have ${week.length} thing${week.length > 1 ? 's' : ''} this week.` : 'Your week is clear.'}`,
      sections: [{ key: 'week', title: 'Your week', items: week }, { key: 'dates', title: 'Coming up', items: dates }, { key: 'waiting', title: 'Waiting on you', items: waiting }, { key: 'chosen', title: 'Chosen for you', items: chosen }, { key: 'worth', title: 'Worth a look', items: worth }],
      enabled: state.privacy.weeklyBrief,
    };
  }
  function planDoc(documentId: string): QeraDocument {
    const doc = documentId === 'latest' ? state.documents[0] : state.documents.find((d) => d.id === documentId);
    if (!doc) throw new ApiError('not_found', documentId === 'latest' ? 'There is no plan to book yet. Ask me to prepare one first.' : 'This document is not available.');
    return doc;
  }
  interface MockLine { line: PlanLine; date: string; time: string | null; ref: { kind: 'experience' | 'partner' | 'service'; id: string }; packageId: string | null; dining: boolean; seats: number }
  async function planLines(content: ItineraryContent, booked: Record<string, string>, partySize: number): Promise<MockLine[]> {
    const today = saToday(), mine = await api.listBookings(), out: MockLine[] = [];
    let index = -1;
    for (const d of content.days) for (const item of d.items) {
      index++;
      if (!item.ref) continue;
      const status = booked[String(index)] ?? null, time = /^[0-2]\d:[0-5]\d$/.test(item.time) ? item.time : null;
      let action = '', cost: string | null = null, bookable = true, packageId: string | null = null, seats = partySize;
      try {
        if (d.date < today) { bookable = false; action = 'This date has passed.'; }
        else if (item.ref.kind === 'experience') {
          const e = await api.getExperience(item.ref.id), offer = bookingOffer(e, state.session);
          seats = Math.min(partySize, e.maxSeatsPerBooking);
          const n = `${seats} seat${seats > 1 ? 's' : ''}`;
          if (mine.some((b) => b.experienceId === e.id && !['cancelled', 'declined'].includes(b.status))) { bookable = false; action = 'You already have a booking for this experience.'; }
          else if (offer === 'invitation_needed') { bookable = false; action = 'This experience is by invitation.'; }
          else { action = offer === 'apply' ? `Apply for ${n}; the team confirms places.` : offer === 'waitlist' ? `Join the waitlist for ${n}.` : offer === 'rsvp' ? `RSVP for ${n}.` : `Reserve ${n}. They are held while you pay under Bookings.`; cost = offer === 'reserve' && e.memberPriceMinor ? formatMoney(e.memberPriceMinor * seats, e.currency) : offer === 'reserve' || offer === 'rsvp' ? 'Complimentary' : null; }
        } else if (item.ref.kind === 'partner') {
          const p = PARTNERS.find((x) => x.id === item.ref!.id);
          if (!p || !p.contactEmail) { bookable = false; action = `${p?.name ?? 'This partner'} has no booking contact in the directory yet.`; }
          else action = `Ask ${p.name} for ${time ? `${time} on ` : ''}${longDay(d.date)}, for ${partySize}. They confirm or decline.`;
        } else {
          const x = servicesHere().find((y) => y.id === item.ref!.id);
          const pkg = x?.packages[0] ?? null;
          packageId = pkg?.id ?? null;
          if (!x) { bookable = false; action = 'This service is no longer offered.'; }
          else if (pkg && d.date < earliestDate(pkg.leadTimeHours, today)) { bookable = false; action = `${pkg.name} needs ${leadTimeLabel(pkg.leadTimeHours)}. The earliest date is ${longDay(earliestDate(pkg.leadTimeHours, today))}.`; }
          else { action = `Ask for ${x.name}${pkg ? `, ${pkg.name}` : ''}, on ${longDay(d.date)}. The desk arranges it and confirms.`; cost = pkg ? `${packagePriceLabel(pkg)} (indicative)` : null; }
        }
      } catch (error) { bookable = false; action = error instanceof ApiError ? error.message : 'This line cannot be booked.'; }
      if (status) bookable = false;
      out.push({ line: { index, day: longDay(d.date), time: item.time, title: item.title, kind: item.ref.kind, action, cost, status, bookable }, date: d.date, time, ref: item.ref, packageId, dining: /dinner|lunch|chef|culinary|table/i.test(`${item.title} ${item.detail}`), seats });
    }
    return out;
  }

  const qeraServices = (): QeraService[] => servicesHere().map((x) => ({ id: x.id, name: x.name, description: x.description, packages: x.packages.map((p) => ({ id: p.id, name: p.name, price: packagePriceLabel(p), notice: leadTimeLabel(p.leadTimeHours).toLowerCase(), leadTimeHours: p.leadTimeHours })) }));
  const choosePackage = (service: QeraService, said: string) => { const t = said.toLowerCase(); return service.packages?.find((p) => p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3).some((w) => t.includes(w))) ?? service.packages?.[0] ?? null; };
  const qeraModel = new RuleBasedQeraModel();
  const qeraSay = (role: 'member' | 'qera', text: string) => { state.qera.messages.push({ id: `qm-${state.nextId++}`, role, text, sentAt: new Date().toISOString() }); };
  const qeraThread = (): QeraThread => ({ messages: state.qera.messages.slice(-60), pending: state.qera.pending ? { id: state.qera.pending.id, tool: state.qera.pending.tool, summary: state.qera.pending.summary, expiresAt: state.qera.pending.expiresAt } : null, usage: null });
  const qeraWhen = (iso: string, zone: string) => { const d = formatDateTime(iso, zone); return `${d.long}, ${d.time}`; };
  const partnerWhen = (b: { date: string; time: string | null }) => `${longDay(b.date)}${b.time ? ` at ${b.time}` : ''}`;
  const localDay = (iso: string, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const qeraExperiences = async (): Promise<QeraExperience[]> => (await api.listExperiences()).map((e) => ({
    id: e.id, title: e.title, category: e.category, when: e.startsAt ? qeraWhen(e.startsAt, e.timezone) : '', area: e.area, seatsLeft: e.capacity === null ? null : Math.max(0, e.capacity - (e.seatsTaken ?? 0)),
    price: state.session ? (e.memberPriceMinor ? `${formatMoney(e.memberPriceMinor, e.currency)} a seat` : 'complimentary') : e.priceMinor ? `${formatMoney(e.priceMinor, e.currency)} a seat` : 'complimentary', admission: e.admission,
    ...(e.startsAt ? { date: localDay(e.startsAt, e.timezone), time: formatDateTime(e.startsAt, e.timezone).time } : {}),
  }));

  /* A guest account's QÉRA: read-only tools and a daily allowance, as on the server. */
  const asGuest = () => !state.session && state.guestSignedIn && state.guestAccount !== null;
  const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const tomorrowStart = () => { const d = new Date(`${todayKey()}T00:00:00+02:00`); return new Date(d.getTime() + 86_400_000).toISOString(); };
  function guestUsageNow(): QeraUsage {
    if (state.guestUsage.day !== todayKey()) state.guestUsage = { day: todayKey(), seconds: 0, lastSeen: 0 };
    const used = Math.min(state.guestUsage.seconds, guestLimit);
    return { usedSeconds: used, limitSeconds: guestLimit, resetsAt: tomorrowStart(), exhausted: state.guestUsage.seconds >= guestLimit };
  }
  function chargeGuest(cap: number): QeraUsage {
    guestUsageNow();
    const now = Date.now(), gap = state.guestUsage.lastSeen ? Math.max(0, Math.floor((now - state.guestUsage.lastSeen) / 1000)) : 0;
    state.guestUsage = { day: state.guestUsage.day, seconds: Math.min(guestLimit, state.guestUsage.seconds + Math.min(cap, gap)), lastSeen: now };
    return guestUsageNow();
  }
  const guestSay = (role: 'member' | 'qera', text: string) => { state.guestQera.push({ id: `gq-${state.nextId++}`, role, text, sentAt: new Date().toISOString() }); };
  const guestThread = (): QeraThread => ({ messages: state.guestQera.slice(-60), pending: null, usage: guestUsageNow() });
  const guestRecommend = { run: async () => ({ data: { interests: [], experiences: (await qeraExperiences()).slice(0, 3), partners: [], services: qeraServices().slice(0, 3), people: [] } }) };
  const guestAbout = {
    run: async () => ({ data: [
      { topic: 'overview', text: 'Quintara is a private membership for founders, investors, creatives and executives, based in Cape Town. Members book signature experiences, are introduced to one another by the Quintara team, and are looked after through its lifestyle partners and services.' },
      { topic: 'membership', text: 'Membership is by application, read by the membership committee. You can apply from the Apply page: the application asks about you, your work and where to find you online.' },
      { topic: 'experiences', text: `Quintara hosts signature experiences. ${(await qeraExperiences()).length} are open to guests at the moment; dates and seats are shared with members.` },
      { topic: 'lifestyle', text: `Lifestyle brings together Quintara's partner directory and ${servicesHere().length} services. Guests can request a service from the Lifestyle page; the partner directory and its privileges are for members.` },
      { topic: 'business', text: 'Under Business, Quintara publishes opportunities and members post listings. Introductions are made by the team with consent on both sides. Quintara does not offer or advise on investments and takes no part in what members agree.' },
      { topic: 'boutique', text: 'Maison Quintara sells pieces by Quintara and its makers, delivered by courier in South Africa. Members pay member prices; guests can order too.' },
      { topic: 'tv', text: 'Quintara TV shows films from inside Quintara. Some episodes are open to everyone and the rest are for members.' },
      { topic: 'privacy', text: 'Your conversation with me is private to your guest account. You can download or delete your account under Account at any time.' },
      { topic: 'qera', text: 'I am Q\u00c9RA, the Quintara Intelligence. Guests can talk to me for up to five hours a day; members have no daily limit, and I can book and plan for them.' },
    ] }),
  };
  const qeraPartners = async (): Promise<QeraPartner[]> => (await api.listPartners()).map((p) => ({ id: p.id, name: p.name, category: p.category, area: p.address || p.area, offer: p.offer || p.summary, bookable: Boolean(p.contactEmail), privileges: p.privileges.filter((v) => v.available).map((v) => v.title) }));
  function qeraTools(): QeraToolbox {
    return {
      list_experiences: { run: async () => ({ data: await qeraExperiences() }) },
      list_bookings: { run: async () => ({ data: (await api.listBookings()).map((b) => ({ id: b.id, title: b.experienceTitle, when: qeraWhen(b.startsAt, b.timezone), seats: b.seats, status: b.status })) }) },
      list_partners: { run: async () => ({ data: await qeraPartners() }) },
      list_services: { run: async () => ({ data: qeraServices() }) },
      about_quintara: {
        run: async () => ({ data: [
          { topic: 'overview', text: 'Quintara is a private membership for founders, investors, creatives and executives, based in Cape Town. Members book signature experiences, are introduced to one another by the Quintara team, and are looked after through its lifestyle partners and services.' },
          { topic: 'membership', text: 'Membership is by application, read by the membership committee. Your card, tier and renewal are under Profile.' },
          { topic: 'experiences', text: `There are ${(await qeraExperiences()).length} experiences on the calendar.` },
          { topic: 'lifestyle', text: `Lifestyle has ${partnersForMember().length} partners in the directory and ${servicesHere().length} services I can arrange.` },
          { topic: 'business', text: 'Under Business, Quintara publishes opportunities and members post listings. Introductions are made by the team with consent on both sides. Quintara does not offer or advise on investments and takes no part in what members agree.' },
          { topic: 'relationship', text: 'Mr. Wayne Huffton of BMM Capital is the dedicated relationship manager. On your request he facilitates business partnerships, advisory and brand collaborations. Write to him under Business.' },
          { topic: 'concierge', text: `${CONCIERGE_SPECIALIST.name}, ${CONCIERGE_SPECIALIST.role}, steps in for anything I cannot manage myself. I refer it to her and she replies under Concierge.` },
          { topic: 'boutique', text: 'Maison Quintara sells pieces by Quintara and its makers, delivered by courier in South Africa. Members pay member prices; guests can order too.' },
          { topic: 'tv', text: 'Quintara TV shows films from inside Quintara. Some episodes are open to everyone and the rest are for members.' },
          { topic: 'privacy', text: 'Your contact details are never shown to other members or to partners. When I book a partner for you they are given your name, the date and the number of guests, and nothing else. You can download or erase your data under Profile.' },
          { topic: 'qera', text: 'I am Q\u00c9RA, the Quintara Intelligence. I answer from what Quintara offers and what your membership allows, I ask before I act, and I never make a payment for you.' },
        ] }),
      },
      list_partner_bookings: { run: async () => ({ data: state.partnerBookings.map((b) => ({ id: b.id, partner: b.partnerName, when: partnerWhen(b), partySize: b.partySize, status: b.status })) }) },
      recommend: {
        run: async () => {
          const likes = [...state.myProfile.interests, ...state.memory.filter((m) => m.kind === 'likes' || m.kind === 'favourite').map((m) => m.label)].map((i) => i.toLowerCase());
          const fits = (text: string) => likes.filter((like) => text.toLowerCase().includes(like)).length;
          const ranked = <T>(items: T[], text: (item: T) => string) => [...items].sort((a, b) => fits(text(b)) - fits(text(a)));
          return { data: {
            interests: state.myProfile.interests,
            experiences: ranked((await qeraExperiences()).filter((x) => x.seatsLeft === null || x.seatsLeft > 0), (x) => `${x.title} ${x.category}`).slice(0, 3),
            partners: ranked(await qeraPartners(), (x) => `${x.name} ${x.category} ${x.offer ?? ''}`).slice(0, 3),
            services: ranked(qeraServices(), (x) => `${x.name} ${x.description}`).slice(0, 3),
            dietary: state.memory.filter((m) => m.kind === 'dietary').map((m) => m.label),
            people: (await api.listSuggestions()).slice(0, 2).map((s2) => ({ id: s2.member.id, name: s2.member.fullName, role: `${s2.member.position}, ${s2.member.company}`, reasons: s2.reasons })),
          } };
        },
      },
      create_itinerary: {
        run: async (args: { kind: 'day' | 'weekend' | 'holiday'; startDate: string; days: number; focus: string }) => {
          const content = composeItinerary({ ...args, today: saToday(), preparedFor: state.session!.fullName, prefer: state.memory.filter((m) => m.kind === 'likes' || m.kind === 'favourite').map((m) => m.label), dietary: state.memory.filter((m) => m.kind === 'dietary').map((m) => m.label) }, { experiences: await qeraExperiences(), partners: await qeraPartners(), services: qeraServices() });
          const doc: QeraDocument = { id: `doc-${state.nextId++}`, kind: args.kind, title: `${content.title}, ${content.subtitle}`, createdAt: new Date().toISOString(), content, booked: {} };
          state.documents.unshift(doc);
          return { data: { id: doc.id, title: doc.title, days: content.days.length, lines: content.days.reduce((n, d) => n + d.items.length, 0) } };
        },
      },
      book_partner: {
        summarise: async ({ partnerId, date, time, partySize }: { partnerId: string; date: string; time: string | null; partySize: number }) => {
          const partner = PARTNERS.find((p) => p.id === partnerId);
          if (!partner) throw new ApiError('not_found', 'This partner is not available.');
          if (!partner.contactEmail) throw new ApiError('conflict', `${partner.name} has no booking contact in the directory yet.`);
          return `I can ask ${partner.name} for a booking on ${partnerWhen({ date, time })} for ${partySize}. I will send them your name, the date and the number of guests, and nothing else. ${partner.contactName ? `${partner.contactName} there` : 'They'} will confirm or decline.`;
        },
        run: async ({ partnerId, date, time, partySize, notes }: { partnerId: string; date: string; time: string | null; partySize: number; notes: string }) => {
          const partner = PARTNERS.find((p) => p.id === partnerId)!;
          if (date < new Date().toISOString().slice(0, 10)) throw new ApiError('validation', 'Choose a date from today onwards.', { date: 'Choose a date from today onwards' });
          if (state.partnerBookings.some((b) => b.partnerId === partnerId && b.date === date && (b.status === 'requested' || b.status === 'confirmed'))) throw new ApiError('conflict', 'You already have a booking with this partner on that date.');
          const booking: PartnerBooking = { id: `pbk-${state.nextId++}`, partnerId, partnerName: partner.name, date, time, partySize, notes, status: 'requested', partnerNote: '', createdAt: new Date().toISOString() };
          state.partnerBookings.unshift(booking);
          return { text: `Done. I have sent the booking to ${partner.name} for ${partnerWhen(booking)}, for ${partySize}. I will tell you as soon as they answer. If they cannot take it, ${CONCIERGE_SPECIALIST.shortName} will suggest an alternative.` };
        },
      },
      request_service: {
        summarise: async ({ serviceId, date, notes }: { serviceId: string; date: string | null; notes: string }) => {
          const service = qeraServices().find((x) => x.id === serviceId);
          if (!service) throw new ApiError('not_found', 'That service is not on offer.');
          const pkg = choosePackage(service, notes);
          if (pkg && date && date < earliestDate(pkg.leadTimeHours, saToday())) throw new ApiError('conflict', `${service.name}'s ${pkg.name} needs ${pkg.notice}. The earliest I can ask for is ${partnerWhen({ date: earliestDate(pkg.leadTimeHours, saToday()), time: null })}.`);
          return `I can ask for ${service.name}${pkg ? `, ${pkg.name} (${pkg.price}, indicative)` : ''} to be arranged${date ? ` for ${partnerWhen({ date, time: null })}` : ''}. This is a request, not a payment: the provider confirms the final price, and you will be told when it is confirmed.`;
        },
        run: async ({ serviceId, date, notes }: { serviceId: string; date: string | null; notes: string }) => {
          const service = qeraServices().find((x) => x.id === serviceId), pkg = service ? choosePackage(service, notes) : null;
          const r = await api.requestLifestyleService(serviceId, { preferredDate: date, notes, packageId: pkg?.id ?? null });
          return { text: `Done. Your request for ${r.serviceName}${r.packageName ? `, ${r.packageName},` : ''} is in. You can follow it under Lifestyle.` };
        },
      },
      list_memory: { run: async () => ({ data: state.memory.map((m) => ({ id: m.id, kind: m.kind, label: m.label, detail: m.detail, date: m.date })) }) },
      remember: {
        summarise: async ({ kind, label, date }: { kind: keyof typeof MEMORY_KIND_LABEL; label: string; date: string | null }) => `Shall I remember this under ${MEMORY_KIND_LABEL[kind].toLowerCase()}: \u201c${label}\u201d${date ? `, ${partnerWhen({ date, time: null })}` : ''}? You can see, change or remove it at any time under Q\u00c9RA, Memory.`,
        run: async (args: { kind: string; label: string; detail: string; date: string | null }) => { const m = await call(() => addMemory(args, 'qera')); return { text: `Noted. I will remember \u201c${m.label}\u201d.` }; },
      },
      forget: {
        summarise: async ({ memoryId }: { memoryId: string }) => { const m = state.memory.find((x) => x.id === memoryId); if (!m) throw new ApiError('not_found', 'I do not remember that.'); return `I can forget \u201c${m.label}\u201d. It will be removed from what I remember.`; },
        run: async ({ memoryId }: { memoryId: string }) => { const m = await call(() => removeMemory(memoryId)); return { text: `Done. I have forgotten \u201c${m.label}\u201d.` }; },
      },
      set_reminder: {
        summarise: async ({ text, date, time }: { text: string; date: string; time: string }) => {
          const at = new Date(`${date}T${time}:00+02:00`).toISOString();
          if (at < new Date().toISOString()) throw new ApiError('conflict', 'That time has already passed. When would you like the reminder?');
          return `I can remind you to ${text.charAt(0).toLowerCase() + text.slice(1)} on ${whenLocal(at)}.`;
        },
        run: async (args: { text: string; date: string; time: string }) => { const r = await call(() => addReminder(args, 'qera')); return { text: `Done. I will remind you on ${whenLocal(r.remindAt)}.` }; },
      },
      weekly_brief: { run: async () => ({ data: await weeklyBrief() }) },
      book_plan: {
        summarise: async ({ documentId, partySize }: { documentId: string; partySize: number }) => {
          const preview = await api.previewPlanBooking(documentId, partySize);
          const ready = preview.lines.filter((l) => l.bookable);
          if (!ready.length) throw new ApiError('conflict', `Nothing in \u201c${preview.title}\u201d can be booked now. Open the plan to see why.`);
          const skipped = preview.lines.length - ready.length;
          return `I can book ${ready.length} line${ready.length > 1 ? 's' : ''} of \u201c${preview.title}\u201d for ${partySize}: ${ready.map((l) => `${l.title} (${l.day}${l.cost ? `, ${l.cost}` : ''})`).join('; ')}.${skipped ? ` ${skipped} other line${skipped > 1 ? 's' : ''} cannot be booked and will be left.` : ''} ${preview.notes.slice(0, 1).concat(preview.notes.slice(2)).join(' ')}`;
        },
        run: async ({ documentId, partySize }: { documentId: string; partySize: number }) => {
          const preview = await api.previewPlanBooking(documentId, partySize);
          const result = await api.bookPlan(preview.documentId, { partySize, lines: preview.lines.filter((l) => l.bookable).map((l) => l.index) });
          return { text: `Done. ${result.lines.filter((l) => l.ok).length} of ${result.lines.length} booked: ${result.lines.map((l) => `${l.title}: ${l.text}`).join('; ')}. The plan shows where each line stands.` };
        },
      },
      list_suggestions: { run: async () => ({ data: (await api.listSuggestions()).map((s) => ({ id: s.member.id, name: s.member.fullName, role: `${s.member.position}, ${s.member.company}`, reasons: s.reasons })) }) },
      search: { run: async ({ query }: { query: string }) => ({ data: await api.search(query) }) },
      book_experience: {
        summarise: async ({ experienceId, seats }: { experienceId: string; seats: number }) => {
          const e = await api.getExperience(experienceId);
          if (seats > e.maxSeatsPerBooking) throw new ApiError('conflict', `${e.title} allows up to ${e.maxSeatsPerBooking} seat${e.maxSeatsPerBooking > 1 ? 's' : ''} per booking.`);
          const cost = e.memberPriceMinor ? `${formatMoney(e.memberPriceMinor * seats, e.currency)} will be due, which you pay yourself under Bookings.` : 'It is complimentary.';
          return `I can reserve ${seats} seat${seats > 1 ? 's' : ''} at ${e.title} on ${qeraWhen(e.startsAt!, e.timezone)}. ${cost}`;
        },
        run: async ({ experienceId, seats }: { experienceId: string; seats: number }) => {
          const b = await api.bookExperience(experienceId, seats);
          const next = b.status === 'awaiting_payment' ? ` Your seats are held: pay ${formatMoney(b.amountDueMinor, b.currency)} under Bookings to confirm them.` : b.status === 'confirmed' ? ` Your ticket code is ${b.ticketCode}.` : '';
          return { text: `Done. ${b.experienceTitle}: ${BOOKING_STATUS_LABEL[b.status].toLowerCase()}.${next}` };
        },
      },
      cancel_booking: {
        summarise: async ({ bookingId }: { bookingId: string }) => {
          const b = (await api.listBookings()).find((candidate) => candidate.id === bookingId);
          if (!b) throw new ApiError('not_found', 'I could not find that booking.');
          return `I can cancel your booking for ${b.experienceTitle} on ${qeraWhen(b.startsAt, b.timezone)} (${b.seats} seat${b.seats > 1 ? 's' : ''}). Any refund follows that experience's rules.`;
        },
        run: async ({ bookingId }: { bookingId: string }) => { const b = await api.cancelBooking(bookingId); return { text: `Done. Your booking for ${b.experienceTitle} is cancelled.${b.refundedMinor ? ` ${formatMoney(b.refundedMinor, b.currency)} is being refunded.` : ''}` }; },
      },
      create_concierge_request: {
        summarise: async ({ subject }: { subject: string }) => `This is one for your Lifestyle Curator. I can refer it to ${CONCIERGE_SPECIALIST.name} at the concierge desk: \u201c${subject}\u201d. She will reply with options.`,
        run: async (args: { category: ConciergeCategory; subject: string; details: string }) => { const r = await api.createConciergeRequest({ ...args, neededBy: null }); return { text: `Done. ${CONCIERGE_SPECIALIST.shortName} has your request, \u201c${r.subject}\u201d. You can follow it under Concierge.` }; },
      },
      request_connection: {
        summarise: async ({ memberId }: { memberId: string }) => { const m = await api.getMember(memberId); return `I can ask ${m.fullName} to connect with you. They decide whether to accept.`; },
        run: async ({ memberId }: { memberId: string }) => { const m = await api.requestConnection(memberId); return { text: m.connection === 'connected' ? `Done. You and ${m.fullName} are now connected.` : `Done. ${m.fullName} has been asked.` }; },
      },
    };
  }
  return api;
}
