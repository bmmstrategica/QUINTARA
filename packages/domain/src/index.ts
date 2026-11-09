/**
 * Shared domain model: types, statuses, permission keys and validation schemas.
 * The API, web app, mobile app and QERA tools all import from here, so a
 * status or permission can never be spelled two ways.
 */
import { z } from 'zod';

/* ---------- Roles and permissions ---------- */

/** Roles stack on one account. `member` is the base; the others are additions. */
export const ROLES = ['member', 'founder', 'investor', 'creative', 'executive'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'experiences.view_public',
  'experiences.view_member',
  'experiences.book',
  'membership.apply',
  'directory.view',
  'connections.request',
  'messages.use',
  'concierge.request',
  'notifications.view',
  'profile.edit',
  'qera.use',
  'privileges.use',
  'business.view',
  // Anyone can see what is on Quintara TV and watch public episodes; members watch everything and keep their place.
  'tv.browse',
  'tv.watch',
  // Guests may browse and buy from Maison Quintara’s public shelves. Member prices, members-only pieces and the wishlist need a membership.
  'boutique.browse',
  'boutique.shop',
  // Posting a listing needs one of the four professional roles, which staff grant.
  'business.post',
  'founder.publish_profile',
  'investor.view_fundraising',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VISITOR_PERMISSIONS: Permission[] = ['experiences.view_public', 'membership.apply', 'boutique.browse', 'boutique.shop', 'tv.browse'];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  member: [
    'experiences.view_public',
    'experiences.view_member',
    'experiences.book',
    'directory.view',
    'connections.request',
    'messages.use',
    'concierge.request',
    'notifications.view',
    'profile.edit',
    'qera.use',
    'privileges.use',
    'business.view',
    'boutique.browse',
    'boutique.shop',
    'tv.browse',
    'tv.watch',
  ],
  founder: ['founder.publish_profile', 'business.post'],
  investor: ['investor.view_fundraising', 'business.post'],
  creative: ['business.post'],
  executive: ['business.post'],
};

/** The permissions a set of roles grants. No roles means a visitor. */
export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  if (roles.length === 0) return new Set(VISITOR_PERMISSIONS);
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

/** Always check a permission, never a role name. */
export function can(session: Pick<Session, 'roles'> | null, permission: Permission): boolean {
  return permissionsFor(session?.roles ?? []).has(permission);
}

/* ---------- Staff ---------- */

/**
 * Staff roles are separate from member roles: a staff account need not be a member. Each account has one role.
 * Role keys are stored in the database; `admin` is the Super Administrator and `concierge` the Concierge Manager
 * (the keys predate the full set of roles and are kept so stored accounts keep their meaning). Staff keys must never
 * equal a member role key (ROLES): both live in user_roles, and `executive` is already a member's business role.
 */
export const STAFF_ROLES = ['admin', 'executive_admin', 'membership', 'experiences', 'concierge', 'finance', 'content', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_PERMISSIONS = [
  'admin.applications.review',
  'admin.members.manage',
  'admin.experiences.manage',
  'admin.bookings.manage',
  'admin.concierge.manage',
  // Prices and money: membership tiers, the payments ledger and renewals.
  'admin.finance.manage',
  // Published content: Quintara TV, the home page and section descriptions.
  'admin.content.manage',
  // Lifestyle partners, their privileges, and the lifestyle services with their packages (the service providers).
  'admin.providers.manage',
  // Maison Quintara: pieces, stock, delivery methods and orders.
  'admin.boutique.manage',
  // Business performance: the dashboard figures and Insights (counts and totals only, never names).
  'admin.insights.view',
  // Reviewing business listings and making introductions.
  'admin.business.manage',
  // Opening and closing cities.
  'admin.markets.manage',
  // Admin console accounts: adding staff, roles, suspending, resetting two-factor.
  'admin.staff.manage',
  // The full audit log of every member of staff. Everyone sees their own activity.
  'admin.audit.view',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

/** What each role may do. The server checks these on every request; the console only hides what would be refused. */
export const STAFF_ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = {
  // Super Administrator: everything, including staff accounts, cities and the full audit log.
  admin: [...STAFF_PERMISSIONS],
  // Executive Administrator: runs the club day to day and sees the whole picture; does not manage staff or cities.
  executive_admin: ['admin.insights.view', 'admin.audit.view', 'admin.applications.review', 'admin.members.manage', 'admin.finance.manage', 'admin.business.manage', 'admin.experiences.manage', 'admin.bookings.manage'],
  // Membership Manager: applications, the application form, members and their roles.
  membership: ['admin.applications.review', 'admin.members.manage'],
  // Experiences Manager: experiences, pricing and availability, guest lists, reservations and check-in.
  experiences: ['admin.experiences.manage', 'admin.bookings.manage'],
  // Concierge Manager: the concierge desk, service requests, partner bookings and the service providers.
  concierge: ['admin.concierge.manage', 'admin.providers.manage', 'admin.bookings.manage', 'admin.experiences.manage'],
  // Finance Manager: tiers and fees, the payments ledger, renewals, and the figures.
  finance: ['admin.finance.manage', 'admin.insights.view'],
  // Content Manager: what members read and see: TV, the home page, descriptions, partners and services, Maison Quintara.
  content: ['admin.content.manage', 'admin.providers.manage', 'admin.boutique.manage'],
  // Support Administrator: helps members with requests and at the door.
  support: ['admin.concierge.manage', 'admin.bookings.manage'],
};

export const STAFF_ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  admin: 'Super Administrator', executive_admin: 'Executive Administrator', membership: 'Membership Manager', experiences: 'Experiences Manager',
  concierge: 'Concierge Manager', finance: 'Finance Manager', content: 'Content Manager', support: 'Support Administrator',
};

export const STAFF_ROLE_NOTES: Readonly<Record<StaffRole, string>> = {
  admin: 'Everything, including staff accounts, cities, money and the full audit log.',
  executive_admin: 'The dashboard and Insights, applications, members, money, Business, experiences and the full audit log. Not staff accounts or cities.',
  membership: 'Applications, the application questions, members, their roles and member reports.',
  experiences: 'Experiences, pricing and availability, guest lists, reservations and check-in.',
  concierge: 'Concierge requests, service requests, partner bookings, partners and services, experiences, guest lists and check-in.',
  finance: 'Membership tiers and fees, the payments ledger, renewals, the dashboard and Insights.',
  content: 'Quintara TV, the home page, descriptions, partners and services, and Maison Quintara with its orders.',
  support: 'Concierge and service requests, guest lists and check-in.',
};

export function staffCan(roles: readonly StaffRole[], permission: StaffPermission): boolean {
  return roles.some((role) => STAFF_ROLE_PERMISSIONS[role]?.includes(permission));
}

/** True when any of the roles holds any of the permissions. */
export function staffCanAny(roles: readonly StaffRole[], permissions: readonly StaffPermission[]): boolean {
  return permissions.some((permission) => staffCan(roles, permission));
}

/* ---------- Session ---------- */

export interface Session {
  userId: string;
  memberId: string;
  fullName: string;
  email: string;
  roles: Role[];
  tierName: string;
  memberNumber: string;
  memberSince: string; // ISO date
  marketId: string;
}

/* ---------- Cities ---------- */

/**
 * A city Quintara operates in. Experiences, members, partners, services, Maison Quintara and Business belong to a city.
 * Staff open a city when it is ready; until then only staff see it, so they can prepare it.
 */
export interface Market {
  id: string;
  slug: string;
  name: string;
  country: string;
  timezone: string;
  currency: string;
  isOpen: boolean;
}
export const marketInputSchema = z.object({
  name: z.string().trim().min(2, 'Enter the city').max(60),
  countryCode: z.string().trim().length(2, 'Use the two-letter country code, for example ZA').transform((v) => v.toUpperCase()),
  countryName: z.string().trim().max(60).default(''),
  timezone: z.string().trim().min(3).max(60).refine((zone) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }, 'Choose a valid time zone, for example Africa/Johannesburg'),
  currency: z.string().trim().length(3, 'Use a three-letter currency code, for example ZAR').transform((v) => v.toUpperCase()),
});
export type MarketInput = z.input<typeof marketInputSchema>;
/** The instant of a local date and time in a city's time zone, as an ISO string: 18:30 on 2026-11-20 in Africa/Nairobi. */
export function localToInstant(date: string, time: string, zone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(guess).replace(' ', 'T') + 'Z');
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime())).toISOString();
}
/** The header the apps send to say which city is being viewed. */
export const MARKET_HEADER = 'x-quintara-market';

/* ---------- Guest accounts ---------- */

/**
 * A personal account for someone who is not (yet) a member. A guest signs in, keeps their Maison Quintara orders and
 * service requests together, and may use QÉRA for a limited time each day. A guest holds no member roles, so every
 * member check still fails closed.
 */
export interface GuestAccount {
  userId: string;
  fullName: string;
  email: string;
  createdAt: string;
}
export const guestAccountSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(80),
  email: z.email('Enter a valid email address').max(200),
});
export type GuestAccountInput = z.input<typeof guestAccountSchema>;

/** How long a guest may use QÉRA each day, in seconds. */
export const GUEST_QERA_DAILY_SECONDS = 5 * 60 * 60;

/* ---------- Experiences ---------- */

export const ADMISSIONS = ['open', 'members_only', 'invitation_only', 'application_required'] as const;
export type Admission = (typeof ADMISSIONS)[number];

export const ADMISSION_LABEL: Record<Admission, string> = {
  open: 'Open booking',
  members_only: 'Members only',
  invitation_only: 'By invitation',
  application_required: 'By application',
};

export interface ProgrammeItem {
  time: string;
  title: string;
}

export interface Experience {
  id: string;
  marketId: string;
  title: string;
  category: string;
  summary: string;
  description: string;
  /** ISO instant. Null for guests and visitors: dates are shown to members only. */
  startsAt: string | null;
  timezone: string; // IANA zone of the experience location
  venueName: string;
  area: string;
  dressCode: string;
  host: string;
  programme: ProgrammeItem[];
  included: string[];
  /** Seat counts are shown to members only; null for guests and visitors. */
  capacity: number | null;
  seatsTaken: number | null;
  priceMinor: number;
  memberPriceMinor: number;
  currency: string;
  admission: Admission;
  guestPolicy: string;
  /** Chosen by staff: whether guests and visitors can see this experience. */
  openToGuests: boolean;
  maxSeatsPerBooking: number;
  /** True when the signed-in member holds an invitation. */
  invited: boolean;
}

export const BOOKING_STATUSES = ['applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'cancelled', 'declined', 'attended'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  applied: 'Applied',
  waitlisted: 'Waitlisted',
  awaiting_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  declined: 'Declined',
  attended: 'Attended',
};

export interface Booking {
  id: string;
  experienceId: string;
  experienceTitle: string;
  startsAt: string;
  timezone: string;
  venueName: string;
  area: string;
  seats: number;
  status: BookingStatus;
  ticketCode: string;
  currency: string;
  /** What is still to pay, in minor units. Zero unless the status is `awaiting_payment`. */
  amountDueMinor: number;
  /** The seats are held until this moment; null when nothing is owed. */
  paymentDueAt: string | null;
  /** What has been returned to the member after a cancellation. */
  refundedMinor: number;
}

/** What the booking button should offer for this experience and viewer. */
export type BookingOffer = 'reserve' | 'rsvp' | 'apply' | 'waitlist' | 'invitation_needed' | 'membership_needed';

export function bookingOffer(experience: Experience, session: Session | null): BookingOffer {
  if (!can(session, 'experiences.book')) return 'membership_needed';
  if (experience.admission === 'invitation_only' && !experience.invited) return 'invitation_needed';
  if (experience.admission === 'application_required') return 'apply';
  if (experience.capacity !== null && (experience.seatsTaken ?? 0) >= experience.capacity) return 'waitlist';
  return experience.memberPriceMinor > 0 ? 'reserve' : 'rsvp';
}

/* ---------- Members ---------- */

export interface MemberProfile {
  id: string;
  fullName: string;
  position: string;
  company: string;
  industry: string;
  city: string;
  biography: string;
  interests: string[];
  lookingFor: string;
  canOffer: string;
  roles: Role[];
  /** Where the member's profile picture is served from, if they have added one. */
  avatarPath: string | null;
  /** Relationship to the signed-in member. Contact details are never part of a profile. */
  connection: 'none' | 'requested' | 'incoming' | 'connected';
}

/** Why a member is reporting another. The list is fixed so staff can count and compare. */
export const REPORT_REASONS = ['unwanted_contact', 'misrepresentation', 'unsolicited_investment', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  unwanted_contact: 'Unwanted contact',
  misrepresentation: 'Misrepresentation',
  unsolicited_investment: 'Unsolicited investment approach',
  other: 'Something else',
};
export const memberReportSchema = z.object({ reason: z.enum(REPORT_REASONS), detail: z.string().trim().max(1000).default('') });
export type MemberReportInput = z.input<typeof memberReportSchema>;
export interface BlockedMember { id: string; fullName: string }

/* ---------- Lifestyle partners and privileges ---------- */

export interface Privilege {
  id: string;
  partnerId: string;
  title: string;
  details: string;
  terms: string;
  /** Last day it can be used (ISO date), or null for no end date. */
  validUntil: string | null;
  /** How many times one member may use it. Zero means no limit. */
  usesPerMember: number;
  myUses: number;
  /** Whether the viewing member can redeem it now. */
  available: boolean;
}

export interface Partner {
  id: string;
  name: string;
  category: string;
  summary: string;
  description: string;
  area: string;
  website: string | null;
  /** Directory details, entered by staff: what the partner offers and who to speak to there. */
  offer: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  privileges: Privilege[];
}

/** The member's proof at the partner's door. */
export interface Redemption {
  id: string;
  code: string;
  privilegeId: string;
  privilegeTitle: string;
  partnerName: string;
  redeemedAt: string;
}

const PUBLISH_STATUSES = ['draft', 'published', 'archived'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const partnerInputSchema = z.object({
  name: z.string().trim().min(2).max(120), category: z.string().trim().min(2).max(60),
  summary: z.string().trim().max(240).default(''), description: z.string().trim().max(4000).default(''), area: z.string().trim().max(120).default(''),
  website: z.url({ protocol: /^https?$/ }).max(300).nullable().optional(), status: z.enum(PUBLISH_STATUSES).default('draft'),
  offer: z.string().trim().max(1000).default(''), contactName: z.string().trim().max(120).default(''),
  contactEmail: z.union([z.literal(''), z.email().max(200)]).default(''), contactPhone: z.string().trim().max(40).regex(/^[0-9+() -]*$/, 'Use digits, spaces and + only').default(''),
  address: z.string().trim().max(240).default(''),
});
export type PartnerInput = z.input<typeof partnerInputSchema>;

export const privilegeInputSchema = z.object({
  title: z.string().trim().min(2).max(120), details: z.string().trim().max(1000).default(''), terms: z.string().trim().max(1000).default(''),
  validUntil: z.iso.date().nullable().optional(), usesPerMember: z.number().int().min(0).max(1000).default(1), status: z.enum(PUBLISH_STATUSES).default('draft'),
});
export type PrivilegeInput = z.input<typeof privilegeInputSchema>;

/* ---------- Business: listings and introductions ---------- */

/** The four professional roles introductions are made between. Each is granted by staff. */
export const BUSINESS_ROLES = ['founder', 'investor', 'creative', 'executive'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];
export const BUSINESS_ROLE_LABEL: Record<BusinessRole, string> = { founder: 'Founders', investor: 'Investors', creative: 'Creatives', executive: 'Executives' };

export const LISTING_KINDS = ['capital', 'partnership', 'collaboration', 'advisory'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
export const LISTING_KIND_LABEL: Record<ListingKind, string> = { capital: 'Raising capital', partnership: 'Partnership', collaboration: 'Creative collaboration', advisory: 'Board or advisory role' };

export interface BusinessPerson { memberId: string; fullName: string; position: string; company: string }

export interface BusinessListing {
  id: string;
  kind: ListingKind;
  title: string;
  summary: string;
  sector: string;
  audience: BusinessRole[];
  status: 'pending' | 'published' | 'declined' | 'closed';
  createdAt: string;
  postedBy: BusinessPerson;
  mine: boolean;
  /** The state of the viewer's own introduction request on this listing, if any. */
  myRequest: Introduction['status'] | null;
  /** The team's note on a declined listing. Only its owner sees it. */
  reviewNote: string | null;
}

export interface Introduction {
  id: string;
  direction: 'outgoing' | 'incoming';
  /**
   * requested: with the Quintara team. offered: put to the other member. accepted: both agreed and are connected.
   * declined: seen only by the member who declined. not_progressed: what the requester sees for any refusal.
   */
  status: 'requested' | 'offered' | 'accepted' | 'declined' | 'not_progressed' | 'withdrawn';
  note: string;
  listingTitle: string | null;
  with: BusinessPerson;
  createdAt: string;
  updatedAt: string;
}
export const INTRODUCTION_STATUS_LABEL: Record<Introduction['status'], string> = {
  requested: 'With the team', offered: 'Awaiting a reply', accepted: 'Introduced', declined: 'Declined', not_progressed: 'Not taken forward', withdrawn: 'Withdrawn',
};

// A listing deliberately has no field for an amount, a valuation or terms.
export const listingInputSchema = z.object({
  kind: z.enum(LISTING_KINDS),
  title: z.string().trim().min(4, 'Give the listing a title').max(120),
  summary: z.string().trim().min(20, 'Say a little more about what you are looking for').max(1200),
  sector: z.string().trim().max(60).default(''),
  audience: z.array(z.enum(BUSINESS_ROLES)).min(1, 'Choose who should see this').max(4),
});
export type ListingInput = z.input<typeof listingInputSchema>;

export const introductionRequestSchema = z.object({
  listingId: z.uuid(),
  note: z.string().trim().min(20, 'Say why you would like to be introduced').max(1000),
});
export type IntroductionRequest = z.infer<typeof introductionRequestSchema>;

/* ---------- Business: opportunities from Quintara, and the relationship manager ---------- */

/** An opportunity the Quintara team tells members about. Members pursue it through the relationship manager. */
export interface BusinessUpdate {
  id: string;
  title: string;
  summary: string;
  sector: string;
  /** Roles it is addressed to. Empty means every member. */
  audience: BusinessRole[];
  publishedAt: string;
}

// Like a listing, an opportunity has no field for an amount, a valuation or terms.
export const businessUpdateInputSchema = z.object({
  title: z.string().trim().min(4, 'Give the opportunity a title').max(120),
  summary: z.string().trim().min(20, 'Say a little more about the opportunity').max(2000),
  sector: z.string().trim().max(60).default(''),
  audience: z.array(z.enum(BUSINESS_ROLES)).max(4).default([]),
  status: z.enum(PUBLISH_STATUSES).default('draft'),
});
export type BusinessUpdateInput = z.input<typeof businessUpdateInputSchema>;

/** Staff may correct a member's listing. The same rules apply as when the member wrote it. */
export const listingEditSchema = listingInputSchema.partial();
export type ListingEdit = z.input<typeof listingEditSchema>;

export const RM_TOPICS = ['partnership', 'advisory', 'brand_collaboration', 'investment_insight', 'opportunity'] as const;
export type RmTopic = (typeof RM_TOPICS)[number];
export const RM_TOPIC_LABEL: Record<RmTopic, string> = { partnership: 'A business partnership', advisory: 'Advisory', brand_collaboration: 'A brand collaboration', investment_insight: 'Insight on investments', opportunity: 'An opportunity from Quintara' };

/** The people members deal with by name. Change them here when the people change. */
export const RELATIONSHIP_MANAGER = { name: 'Mr. Wayne Huffton', shortName: 'Wayne Huffton', role: 'Dedicated Relationship Manager', organisation: 'BMM Capital' } as const;
export const CONCIERGE_SPECIALIST = { name: 'Ms. Palesa Makam', shortName: 'Palesa Makam', role: 'Lifestyle Curator, Private Client Services' } as const;

/** What members are told about the relationship manager. Shown wherever an enquiry can be started. */
export const RM_NOTICE = 'At your request, your relationship manager facilitates business partnerships, advisory and brand collaborations, and shares insight. This is not financial advice, and Quintara does not hold money or take part in any transaction.';

export interface RmMessage { id: string; from: 'member' | 'manager'; body: string; sentAt: string }
export interface RmEnquiry {
  id: string;
  topic: RmTopic;
  subject: string;
  /** The Quintara opportunity it is about, if any. */
  updateTitle: string | null;
  status: 'open' | 'closed';
  createdAt: string;
  messages: RmMessage[];
}

export const rmEnquiryInputSchema = z.object({
  topic: z.enum(RM_TOPICS),
  subject: z.string().trim().min(4, 'Give your enquiry a subject').max(120),
  message: z.string().trim().min(10, 'Say a little more about what you need').max(2000),
  updateId: z.uuid().nullable().optional(),
});
export type RmEnquiryInput = z.input<typeof rmEnquiryInputSchema>;

/* ---------- Lifestyle services, and the home page ---------- */

/** A service guests and members can ask to book. The concierge desk arranges it. */
export interface LifestyleService {
  id: string; name: string; description: string;
  /** Classified like a partner: Wellness, Dining, Mobility and so on. */
  category: string;
  /** What can be booked, at indicative prices. */
  packages: ServicePackage[];
  /** Directory details, as for a partner. */
  summary: string; area: string; website: string | null; offer: string; address: string;
  /** Who to speak to there. Shown to members only: empty for guests and visitors. */
  contactName: string; contactEmail: string; contactPhone: string;
}

/** One entry in the Lifestyle directory: a partner (with privileges, for members) or a service (that can be booked). */
export type DirectoryEntry = ({ kind: 'partner' } & Partner) | ({ kind: 'service' } & LifestyleService);

/* ---------- Service packages ---------- */

export const PRICE_BASES = ['per_person', 'per_session', 'per_booking', 'per_hour', 'per_day'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export const PRICE_BASIS_LABEL: Record<PriceBasis, string> = { per_person: 'per person', per_session: 'per session', per_booking: 'per booking', per_hour: 'per hour', per_day: 'per day' };

/** One way of booking a service. Prices are indicative: the provider confirms the final amount. */
export interface ServicePackage {
  id: string;
  name: string;
  description: string;
  /** Null when the price is on request. */
  priceMinor: number | null;
  priceBasis: PriceBasis;
  currency: string;
  /** How much notice the provider needs. */
  leadTimeHours: number;
  duration: string;
}

export const servicePackageInputSchema = z.object({
  name: z.string().trim().min(2, 'Give the package a name').max(120), description: z.string().trim().max(600).default(''),
  priceMinor: z.number().int().min(0).max(100_000_000).nullable().default(null), priceBasis: z.enum(PRICE_BASES).default('per_booking'),
  leadTimeHours: z.number().int().min(0).max(8760).default(48), duration: z.string().trim().max(60).default(''),
  position: z.number().int().min(0).max(10000).default(0), status: z.enum(['draft', 'published', 'archived']).default('published'),
});
export type ServicePackageInput = z.input<typeof servicePackageInputSchema>;

/** "R 2 500 per session", or "Price on request". */
export function packagePriceLabel(p: Pick<ServicePackage, 'priceMinor' | 'priceBasis' | 'currency'>): string {
  return p.priceMinor === null ? 'Price on request' : `${formatMoney(p.priceMinor, p.currency)} ${PRICE_BASIS_LABEL[p.priceBasis]}`;
}
/** "Same day", "24 hours' notice", "5 days' notice". */
export function leadTimeLabel(hours: number): string {
  if (hours <= 0) return 'Same day';
  if (hours < 48 && hours % 24 !== 0) return `${hours} hours’ notice`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? '1 day’s notice' : `${days} days’ notice`;
}
/** The first date a package can be booked for, given today's date where the member is. */
export function earliestDate(leadTimeHours: number, today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.ceil(leadTimeHours / 24));
  return d.toISOString().slice(0, 10);
}

/* ---------- QÉRA as Chief of Staff: memory, reminders, the weekly brief and plan booking ---------- */

export const MEMORY_KINDS = ['dietary', 'likes', 'favourite', 'date', 'person', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  dietary: 'Dietary needs', likes: 'Likes and tastes', favourite: 'Favourite places and partners', date: 'Important dates', person: 'People close to you', note: 'Notes',
};
/** Something QÉRA remembers. Only the member, or QÉRA with the member's confirmation, writes it. */
export interface QeraMemoryItem { id: string; kind: MemoryKind; label: string; detail: string; date: string | null; source: 'member' | 'qera'; updatedAt: string }
/** What QÉRA noticed and offers to remember. Nothing is kept until the member adds it. */
export interface QeraMemorySuggestion { kind: MemoryKind; label: string; detail: string; reason: string }
export interface QeraMemory { items: QeraMemoryItem[]; suggestions: QeraMemorySuggestion[] }
export const qeraMemoryInputSchema = z.object({
  kind: z.enum(MEMORY_KINDS), label: z.string().trim().min(1, 'Say what to remember').max(120), detail: z.string().trim().max(300).default(''),
  date: z.iso.date().nullable().default(null),
}).refine((v) => v.kind !== 'date' || v.date !== null, { path: ['date'], message: 'Choose the date' });
export type QeraMemoryInput = z.input<typeof qeraMemoryInputSchema>;

export interface QeraReminder { id: string; text: string; remindAt: string; status: 'scheduled' | 'sent' | 'cancelled'; source: 'member' | 'qera' }
/** A reminder is set for a local date and time where the member is. */
export const reminderInputSchema = z.object({
  text: z.string().trim().min(2, 'Say what to remind you about').max(200), date: z.iso.date('Choose a date'), time: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'Choose a time').default('09:00'),
});
export type ReminderInput = z.input<typeof reminderInputSchema>;

export type BriefLink = { kind: 'experience' | 'service' | 'qera' | 'document' | 'bookings' | 'business' | 'boutique' | 'memory' | 'calendar' | 'brief'; id?: string };
export interface BriefItem { title: string; detail: string; link: BriefLink | null }
export interface BriefSection { key: 'week' | 'dates' | 'waiting' | 'chosen' | 'worth'; title: string; items: BriefItem[] }
/* ---------- The member's calendar and the daily brief ---------- */

/** Where a member's calendar lives. Each offers a private calendar address that QÉRA can read. */
export const CALENDAR_PROVIDERS = ['google', 'apple', 'outlook', 'sample'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const CALENDAR_PROVIDER_LABEL: Record<CalendarProvider, string> = { google: 'Google Calendar', apple: 'Apple iCloud Calendar', outlook: 'Outlook', sample: 'Sample calendar' };
/** Where each provider shows the private address a member copies. */
export const CALENDAR_PROVIDER_HELP: Record<CalendarProvider, string> = {
  google: 'In Google Calendar on the web, open Settings, choose your calendar, and copy “Secret address in iCal format”.',
  apple: 'In the Calendar app on a Mac, or iCloud.com, share the calendar as a public calendar and copy its link (it starts with webcal://).',
  outlook: 'In Outlook on the web, open Settings, Calendar, Shared calendars, publish your calendar, and copy the ICS link.',
  sample: 'A sample week of meetings, for trying the daily brief before connecting a real calendar.',
};
/** The hosts each provider publishes calendars from. QÉRA reads nothing else, so an address cannot point it elsewhere. */
export const CALENDAR_HOSTS: Record<Exclude<CalendarProvider, 'sample'>, RegExp> = {
  google: /^calendar\.google\.com$/,
  apple: /^p\d{1,3}-(?:caldav|calendars)\.icloud\.com$/,
  outlook: /^outlook\.(?:office365|office|live)\.com$/,
};
export const calendarConnectSchema = z.object({
  provider: z.enum(CALENDAR_PROVIDERS),
  address: z.string().trim().max(2000).default(''),
  /** Off: QÉRA sees only that the time is taken, never what the meeting is. */
  showTitles: z.boolean().default(true),
  consent: z.literal(true, { error: 'Please agree to let QÉRA read your calendar' }),
});
export type CalendarConnectInput = z.input<typeof calendarConnectSchema>;
export interface CalendarConnection { provider: CalendarProvider; label: string; showTitles: boolean; connectedAt: string; syncedAt: string | null; syncError: string | null }
export interface CalendarEvent { id: string; title: string; location: string; startsAt: string; endsAt: string | null; allDay: boolean }
export interface CalendarState { connection: CalendarConnection | null; events: CalendarEvent[] }
/** The sample calendar: a believable week for trying the daily brief, with no real data. [day from today, start, end, title, place] */
export const SAMPLE_CALENDAR_WEEK: [day: number, start: string, end: string | null, title: string, location: string][] = [
  [0, '08:30', '09:15', 'Weekly team check-in', 'Video call'],
  [0, '11:00', '12:00', 'Design review with the hotel group', 'Kloof Street Studio'],
  [0, '16:30', '17:00', 'Call with the London office', 'Phone'],
  [1, '07:00', '08:00', 'Run on the promenade', 'Sea Point'],
  [1, '10:00', '11:30', 'Board meeting', 'Head office'],
  [1, '13:00', '14:00', 'Lunch with the architect', 'Gardens'],
  [2, '09:00', '10:00', 'Investor update', 'Video call'],
  [3, '18:30', '21:00', 'Dinner with friends', 'De Waterkant'],
  [4, '08:30', '09:15', 'Weekly team check-in', 'Video call'],
  [4, '15:00', '16:00', 'School concert', 'Rondebosch'],
];

/** One line of the day: from the member's calendar, from Quintara, or a reminder. */
export interface DailyItem { time: string | null; endTime: string | null; title: string; detail: string; source: 'calendar' | 'quintara' | 'reminder'; link: BriefLink | null }
/** QÉRA's morning brief: the day in order, what is ahead, what is waiting, and one thought. */
export interface DailyBrief {
  date: string;
  /** "Friday 9 October" */
  dateLabel: string;
  /** "Good morning, Thandi." */
  greeting: string;
  /** One sentence on the shape of the day. */
  summary: string;
  city: string;
  agenda: DailyItem[];
  ahead: BriefItem[];
  waiting: BriefItem[];
  /** QÉRA's suggestion for the day, if it has one worth making. */
  suggestion: BriefItem | null;
  calendar: { connected: boolean; label: string | null; syncedAt: string | null; showTitles: boolean };
  enabled: boolean;
}

/** QÉRA's view of the member's week: what is booked, what is coming, and what it would suggest. */
export interface WeeklyBrief { weekOf: string; greeting: string; sections: BriefSection[]; enabled: boolean }

/** One line of a prepared plan, and what booking it would do. */
export interface PlanLine {
  index: number; day: string; time: string; title: string; kind: 'experience' | 'partner' | 'service';
  /** What will happen, in words written from the real record. */
  action: string;
  cost: string | null;
  /** Set once the line has been booked. */
  status: string | null;
  bookable: boolean;
}
export interface PlanBookingPreview { documentId: string; title: string; partySize: number; lines: PlanLine[]; notes: string[] }
export interface PlanBookingResult { lines: { index: number; title: string; ok: boolean; text: string }[] }
export const planBookingInputSchema = z.object({ partySize: z.number().int().min(1).max(20), lines: z.array(z.number().int().min(0).max(500)).min(1, 'Choose at least one line').max(60) });

export const lifestyleServiceInputSchema = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).default(''), category: z.string().trim().min(2).max(60).default('Lifestyle'),
  status: z.enum(PUBLISH_STATUSES).default('draft'), position: z.number().int().min(0).max(10000).default(0),
  // The same directory details as a partner.
  summary: z.string().trim().max(240).default(''), area: z.string().trim().max(120).default(''),
  website: z.url({ protocol: /^https?$/ }).max(300).nullable().optional(),
  offer: z.string().trim().max(1000).default(''), contactName: z.string().trim().max(120).default(''),
  contactEmail: z.union([z.literal(''), z.email().max(200)]).default(''), contactPhone: z.string().trim().max(40).regex(/^[0-9+() -]*$/, 'Use digits, spaces and + only').default(''),
  address: z.string().trim().max(240).default(''),
});
export type LifestyleServiceInput = z.input<typeof lifestyleServiceInputSchema>;

export const SERVICE_REQUEST_STATUSES = ['requested', 'in_progress', 'confirmed', 'completed', 'cancelled'] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];
export const SERVICE_REQUEST_STATUS_LABEL: Record<ServiceRequestStatus, string> = { requested: 'Requested', in_progress: 'Being arranged', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };

export interface ServiceRequest { id: string; serviceName: string; preferredDate: string | null; notes: string; status: ServiceRequestStatus; createdAt: string; packageName: string | null; priceLabel: string | null }

/** A member's name and email come from their account; a guest gives theirs. */
export const serviceRequestInputSchema = z.object({
  preferredDate: z.iso.date().nullable().optional(),
  notes: z.string().trim().max(1000).default(''),
  /** The package being asked for, if the service has packages. */
  packageId: z.string().max(80).nullable().optional(),
  guest: z.object({ fullName: z.string().trim().min(2, 'Enter your name').max(120), email: z.email('Enter a valid email address').max(200) }).optional(),
});
export type ServiceRequestInput = z.input<typeof serviceRequestInputSchema>;

/** One item in the welcome area of the home page: a photograph, or a film by link. */
export interface HomeSlide { id: string; kind: 'image' | 'video'; src: string; caption: string }

/* ---------- Bookings QÉRA makes with partners ---------- */

/** A booking request sent to a partner for the member. The partner confirms or declines through a private link. */
export interface PartnerBooking { id: string; partnerId: string; partnerName: string; date: string; time: string | null; partySize: number; notes: string; status: 'requested' | 'confirmed' | 'declined' | 'cancelled'; partnerNote: string; createdAt: string }
export const PARTNER_BOOKING_STATUS_LABEL: Record<PartnerBooking['status'], string> = { requested: 'Sent to the partner', confirmed: 'Confirmed', declined: 'Could not be taken', cancelled: 'Cancelled' };
/** What the partner sees when they open the link: the member's name and the booking, nothing else. */
export interface PartnerBookingView { partnerName: string; memberName: string; date: string; time: string | null; partySize: number; notes: string; status: PartnerBooking['status'] }

/* ---------- Maison Quintara ---------- */

export interface Product {
  id: string;
  title: string;
  maker: string;
  category: string;
  description: string;
  /** What the viewer pays: the member price for a member where one is set, otherwise the public price. */
  priceMinor: number;
  /** The public price, given only when the viewer's price is lower, so the saving can be shown. */
  publicPriceMinor: number | null;
  /** Sold to members only. Visitors are not shown these. */
  membersOnly: boolean;
  /** Path of the photograph on the API, or null. Prefix it with the API's address. */
  imagePath: string | null;
  currency: string;
  /** Versions to choose between, such as colours. Empty when there is only one. */
  options: string[];
  /** How many are left, or null when it is made to order. */
  stock: number | null;
  /** Whether the viewing member has it on their wishlist. */
  wished: boolean;
}

/** Two-factor authentication, as the apps see it. */
export interface TwoFactorStatus {
  /** none: nobody signed in. verify: enter the code to finish signing in. enrol: set up an authenticator to finish signing in. on/off: signed in. */
  state: 'none' | 'verify' | 'enrol' | 'on' | 'off';
  /** Required for every account (production): it cannot be turned off. */
  required: boolean;
  recoveryCodesLeft: number;
  enabledAt: string | null;
}
/** A new authenticator being set up: scan the QR code, or type the key, then confirm with the first code. */
export interface TwoFactorSetup { secret: string; otpauthUrl: string; qr: string }
/** After a sign-in: null when complete, otherwise the second step still to do. */
export type SecondStep = 'verify' | 'enrol' | null;

export const ORDER_STATUSES = ['awaiting_payment', 'paid', 'preparing', 'dispatched', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { awaiting_payment: 'Awaiting payment', paid: 'Paid', preparing: 'Processing', dispatched: 'Dispatched for delivery', delivered: 'Received', cancelled: 'Cancelled' };

/** The five steps every order is tracked through, in order. */
export const ORDER_STAGES = ['placed', 'paid', 'preparing', 'dispatched', 'delivered'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
export const ORDER_STAGE_LABEL: Record<OrderStage, string> = { placed: 'Order placed', paid: 'Payment received', preparing: 'Processing', dispatched: 'Dispatched for delivery', delivered: 'Received' };
/** How far an order has come: the index in ORDER_STAGES of the last step reached (-1 for a cancelled order). */
export const orderStageIndex = (status: OrderStatus) => (status === 'cancelled' ? -1 : status === 'awaiting_payment' ? 0 : ORDER_STAGES.indexOf(status as OrderStage));
export type OrderEventKind = OrderStage | 'cancelled' | 'refunded' | 'note';
/** One step in an order's history. Staff notes are never sent to the buyer. */
export interface OrderEvent { kind: OrderEventKind; at: string; note: string }

export interface OrderItem { title: string; option: string; quantity: number; unitPriceMinor: number }
export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  items: OrderItem[];
  /** Goods plus delivery. */
  totalMinor: number;
  deliveryLabel: string;
  deliveryFeeMinor: number;
  /** Set by staff when the order is dispatched. */
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  refundedMinor: number;
  currency: string;
  deliveryName: string;
  deliveryAddress: string;
  createdAt: string;
  /** Who took the parcel in, once received. */
  receivedBy: string | null;
  /** Every step so far, oldest first. */
  timeline: OrderEvent[];
}

// The caller says what and how many. The price is always taken from the product, never from the request.
export const orderInputSchema = z.object({
  items: z.array(z.object({ productId: z.uuid(), option: z.string().trim().max(60).optional(), quantity: z.number().int().min(1).max(20) })).min(1, 'Your bag is empty').max(20)
    .refine((items) => new Set(items.map((i) => `${i.productId}|${i.option ?? ''}`)).size === items.length, 'The same item appears twice'),
  deliveryOptionId: z.uuid('Choose how you would like it delivered'),
  /** Who the order is for, when the buyer is a guest. Ignored for members. */
  guest: z.object({ fullName: z.string().trim().min(2, 'Enter your name').max(120), email: z.email('Enter a valid email address').max(200) }).optional(),
  deliveryAddress: z.string().trim().min(10, 'Enter a delivery address').max(500),
});
export type OrderInput = z.input<typeof orderInputSchema>;

export interface DeliveryOption {
  id: string;
  name: string;
  description: string;
  feeMinor: number;
  /** Goods total from which this method is free, or null. */
  freeOverMinor: number | null;
  currency: string;
}
/** The fee for a method on a given goods total. */
export const deliveryFee = (option: Pick<DeliveryOption, 'feeMinor' | 'freeOverMinor'>, goodsMinor: number) => (option.freeOverMinor !== null && goodsMinor >= option.freeOverMinor ? 0 : option.feeMinor);

export const deliveryOptionInputSchema = z.object({
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(240).default(''),
  feeMinor: z.number().int().min(0).max(10_000_000), freeOverMinor: z.number().int().min(1).nullable().optional(), currency: z.string().length(3), isActive: z.boolean().default(true),
});
export type DeliveryOptionInput = z.input<typeof deliveryOptionInputSchema>;

export const dispatchSchema = z.object({
  courier: z.string().trim().min(2, 'Name the courier').max(80), trackingNumber: z.string().trim().min(3, 'Enter the tracking number').max(80),
  trackingUrl: z.url({ protocol: /^https$/ }).max(300).nullable().optional(),
});
export type DispatchInput = z.input<typeof dispatchSchema>;
/** Moving an order on. Dispatching needs the courier and tracking number; marking it received needs who took it in. */
export const advanceOrderSchema = z.object({
  courier: z.string().trim().max(80).optional(), trackingNumber: z.string().trim().max(80).optional(), trackingUrl: z.url({ protocol: /^https$/ }).max(300).nullable().optional(),
  receivedBy: z.string().trim().max(120).optional(),
  /** Shown to the buyer with the step. */
  note: z.string().trim().max(500).optional(),
});
export type AdvanceOrderInput = z.input<typeof advanceOrderSchema>;
export const receivedSchema = z.object({ receivedBy: z.string().trim().min(2, 'Enter who received the parcel').max(120) });
export const orderNoteSchema = z.object({ note: z.string().trim().min(2, 'Write a note').max(1000) });

/**
 * Photographs are served at the width a screen needs: `?w=` picks the closest copy that is at least that wide.
 * These are the widths the server keeps.
 */
export const PHOTO_WIDTHS = [480, 960, 1440, 2048, 2880, 3840] as const;
/** The address of a photograph at a given width. */
export const photoUrl = (base: string, path: string, width?: number) => `${base}${path}${width ? `?w=${Math.min(Math.ceil(width), 3840)}` : ''}`;
/** A srcset for <img>: every stored width, so the browser picks the sharpest one for the screen. */
export const photoSrcSet = (base: string, path: string) => PHOTO_WIDTHS.map((w) => `${base}${path}?w=${w} ${w}w`).join(', ');

export const productInputSchema = z.object({
  title: z.string().trim().min(2).max(120), maker: z.string().trim().max(120).default(''), category: z.string().trim().min(2).max(60),
  description: z.string().trim().max(2000).default(''), priceMinor: z.number().int().min(1).max(100_000_000_00), currency: z.string().length(3),
  options: z.array(z.string().trim().min(1).max(60)).max(12).default([]), stock: z.number().int().min(0).max(100000).nullable().optional(),
  memberPriceMinor: z.number().int().min(1).nullable().optional(), membersOnly: z.boolean().default(false), imageId: z.uuid().nullable().optional(),
  status: z.enum(PUBLISH_STATUSES).default('draft'),
});
export type ProductInput = z.input<typeof productInputSchema>;

/* ---------- Quintara TV ---------- */

export interface TvEpisode {
  id: string;
  seriesId: string;
  number: number;
  title: string;
  summary: string;
  durationSeconds: number;
  /** `public` episodes can be watched by anyone; `members` episodes need a membership. */
  audience: 'public' | 'members';
  imagePath: string | null;
  /** True when the viewer may not watch it. The video address is then withheld. */
  locked: boolean;
  /** Where to stream from, or null when locked or not yet uploaded. */
  videoUrl: string | null;
  /** Where the member stopped. Always zero for guests. */
  positionSeconds: number;
  completed: boolean;
}
export interface TvSeries { id: string; title: string; summary: string; imagePath: string | null; episodes: TvEpisode[] }

export const tvSeriesInputSchema = z.object({
  title: z.string().trim().min(2).max(120), summary: z.string().trim().max(600).default(''), status: z.enum(PUBLISH_STATUSES).default('draft'), imageId: z.uuid().nullable().optional(),
});
export type TvSeriesInput = z.input<typeof tvSeriesInputSchema>;
export const tvEpisodeInputSchema = z.object({
  title: z.string().trim().min(2).max(120), summary: z.string().trim().max(600).default(''), number: z.number().int().min(1).max(999).optional(),
  durationSeconds: z.number().int().min(1).max(86400), videoUrl: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
  audience: z.enum(['public', 'members']).default('members'), status: z.enum(PUBLISH_STATUSES).default('draft'), imageId: z.uuid().nullable().optional(),
});
export type TvEpisodeInput = z.input<typeof tvEpisodeInputSchema>;
/** "42 min" or "1 hr 5 min". */
export const formatDuration = (seconds: number) => { const m = Math.max(1, Math.round(seconds / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`; };

/* ---------- Privacy ---------- */

export const privacySettingsSchema = z.object({
  /** Whether other members can find this profile in the directory. */
  showInDirectory: z.boolean(),
  /** Promotional email: recommendations and partner offers. Off unless switched on. */
  marketingEmail: z.boolean(),
  /** Whether this member is suggested to others, and sees suggestions, under People to meet. */
  suggestions: z.boolean().default(true),
  /** QÉRA's weekly brief and its reminders of dates and bookings. On unless switched off. */
  weeklyBrief: z.boolean().default(true),
  /** QÉRA's daily brief, each morning. On unless switched off. */
  dailyBrief: z.boolean().default(true),
});
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

/* ---------- Search and matching ---------- */

export interface SearchResult {
  kind: 'experience' | 'member' | 'partner' | 'listing' | 'product' | 'episode';
  id: string;
  title: string;
  detail: string;
}
export const SEARCH_KIND_LABEL: Record<SearchResult['kind'], string> = { experience: 'Experiences', member: 'Members', partner: 'Partners', listing: 'Business', product: 'Maison Quintara', episode: 'Quintara TV' };

/** A member worth meeting, with the reasons in plain words. Reasons come only from what both profiles show. */
export interface MatchSuggestion { member: MemberProfile; reasons: string[] }

const STOP_WORDS = new Set(['with', 'that', 'this', 'from', 'have', 'their', 'your', 'ready', 'them', 'into', 'about', 'will', 'want', 'like', 'year', 'years', 'what', 'who', 'looking', 'offer', 'worth', 'more', 'some', 'other', 'properly', 'second']);
const keywords = (text: string) => new Set(text.toLowerCase().split(/[^a-z\u00c0-\u024f]+/).filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((word) => b.has(word));

/**
 * Suggests members to meet. The rule is simple enough to explain to anyone: shared interests, and one person
 * offering what the other is looking for. It uses nothing but the profile fields members chose to publish.
 */
export function suggestMatches(me: MemberProfile, others: readonly MemberProfile[], limit = 4): MatchSuggestion[] {
  const myWants = keywords(me.lookingFor), myOffers = keywords(`${me.canOffer} ${me.industry}`), myInterests = new Set(me.interests.map((i) => i.toLowerCase()));
  return others
    .filter((other) => other.id !== me.id && other.connection === 'none')
    .map((other) => {
      const reasons: string[] = [];
      let score = 0;
      const theyOffer = shared(myWants, keywords(`${other.canOffer} ${other.industry} ${other.position}`));
      if (theyOffer.length) { score += 3 * theyOffer.length; reasons.push(`Offers what you are looking for: ${other.canOffer || other.industry}`); }
      const theyWant = shared(keywords(other.lookingFor), myOffers);
      if (theyWant.length) { score += 3 * theyWant.length; reasons.push(`Looking for what you offer: ${other.lookingFor}`); }
      const interests = other.interests.filter((i) => myInterests.has(i.toLowerCase()));
      if (interests.length) { score += 2 * interests.length; reasons.push(`You both list ${interests.join(' and ')}`); }
      if (score > 0 && other.city && other.city === me.city) score += 1;
      return { member: other, reasons, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.member.fullName.localeCompare(b.member.fullName))
    .slice(0, limit)
    .map(({ member, reasons }) => ({ member, reasons }));
}

export const profileUpdateSchema = z.object({
  position: z.string().trim().max(80),
  company: z.string().trim().max(80),
  industry: z.string().trim().max(60),
  city: z.string().trim().max(60),
  biography: z.string().trim().max(600),
  interests: z.array(z.string().trim().min(1).max(40)).max(12),
  lookingFor: z.string().trim().max(160),
  canOffer: z.string().trim().max(160),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/* ---------- Membership application ---------- */

export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'interview',
  'approved',
  'waitlisted',
  'declined',
  'payment_pending',
  'active',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  interview: 'Interview',
  approved: 'Approved',
  waitlisted: 'Waitlisted',
  declined: 'Declined',
  payment_pending: 'Payment pending',
  active: 'Active',
};

/** The happy path shown as a progress line. Waitlisted and declined are outcomes beside it. */
export const APPLICATION_PATH: ApplicationStatus[] = [
  'submitted',
  'under_review',
  'interview',
  'approved',
  'payment_pending',
  'active',
];

/** One schema per step, so each screen validates only what it shows. */
export const applicationStepSchemas = {
  account: z.object({ email: z.email('Enter a valid email address') }),
  personal: z.object({
    fullName: z.string().trim().min(2, 'Enter your full name').max(80),
    phone: z.string().trim().min(1, 'Enter your phone number').max(24)
      .regex(/^\+?[0-9][0-9 ()-]{5,22}$/, 'Enter a phone number, for example +27 82 123 4567')
      .refine((value) => { const digits = value.replace(/\D/g, '').length; return digits >= 7 && digits <= 15; }, 'Enter a phone number, for example +27 82 123 4567'),
    city: z.string().trim().min(2, 'Enter your home city').max(60),
  }),
  professional: z.object({
    position: z.string().trim().min(2, 'Enter your position').max(80),
    company: z.string().trim().max(80),
    industry: z.string().trim().min(2, 'Enter your industry').max(60),
    asFounder: z.boolean(),
    asInvestor: z.boolean(),
  }),
  interests: z.object({ interests: z.array(z.string()).max(12) }),
  motivation: z.object({
    motivation: z.string().trim().min(20, 'Tell us a little more (at least 20 characters)').max(1200),
  }),
  referral: z.object({ referral: z.string().trim().max(120) }),
  links: z.object({
    socialPlatform: z.enum(['instagram', 'tiktok', 'x'], { error: 'Choose Instagram, TikTok or X' }),
    socialHandle: z.string().trim().min(1, 'Enter your social media handle').max(31).regex(/^@?[A-Za-z0-9._]{1,30}$/, 'Enter your handle as it appears, for example @yourname'),
    links: z.string().trim().max(200),
  }),
  membership: z.object({
    residency: z.enum(['resident', 'international'], { error: 'Choose resident or international' }),
    planId: z.string().trim().min(1, 'Choose the membership you are applying for').max(64),
  }),
  questions: z.object({
    // The questions staff add. Which are required, and the allowed choices, are checked by checkAnswers.
    answers: z.record(z.string().max(64), z.union([z.string().max(1200), z.array(z.string().max(120)).max(24)])),
  }),
} as const;

/** Where an applicant can be found online. One handle is asked for on the application. */
export const SOCIAL_PLATFORMS = ['instagram', 'tiktok', 'x'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatform, string> = { instagram: 'Instagram', tiktok: 'TikTok', x: 'X' };
/** "@name", whichever way it was typed. */
export const formatHandle = (handle: string) => (handle.trim() ? `@${handle.trim().replace(/^@+/, '')}` : '');
/** The public profile address for a handle, for staff reading an application. */
export function socialProfileUrl(platform: SocialPlatform, handle: string): string | null {
  const name = handle.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(name)) return null;
  return platform === 'instagram' ? `https://www.instagram.com/${name}/` : platform === 'tiktok' ? `https://www.tiktok.com/@${name}` : `https://x.com/${name}`;
}

export type ApplicationStepKey = keyof typeof applicationStepSchemas;
export const APPLICATION_STEPS = Object.keys(applicationStepSchemas) as ApplicationStepKey[];

export const applicationSchema = z.object({
  ...applicationStepSchemas.account.shape,
  ...applicationStepSchemas.personal.shape,
  ...applicationStepSchemas.professional.shape,
  ...applicationStepSchemas.interests.shape,
  ...applicationStepSchemas.motivation.shape,
  ...applicationStepSchemas.referral.shape,
  ...applicationStepSchemas.links.shape,
  ...applicationStepSchemas.membership.shape,
  ...applicationStepSchemas.questions.shape,
});
export type ApplicationData = z.infer<typeof applicationSchema>;

export const EMPTY_APPLICATION: ApplicationData = {
  email: '',
  fullName: '',
  city: '',
  position: '',
  company: '',
  industry: '',
  asFounder: false,
  asInvestor: false,
  interests: [],
  motivation: '',
  referral: '',
  socialPlatform: 'instagram',
  socialHandle: '',
  links: '',
  phone: '',
  residency: 'resident',
  planId: '',
  answers: {},
};

export interface Application {
  id: string;
  status: ApplicationStatus;
  data: ApplicationData;
  offeredTierName: string | null;
  submittedAt: string | null;
}

/** What an applicant is told once the application is sent, until the committee decides. */
export const APPLICATION_WAITING_LIST_MESSAGE = 'Thank you. You have been added to the waiting list. The membership committee will come back to you once your application is approved, so that you can proceed with payment.';
export const APPLICATION_APPROVED_MESSAGE = 'Your application has been approved. You can now proceed with payment to activate your membership.';

/* ---------- Membership plans ---------- */

/** Whether the applicant lives in the country of the city they apply in, or abroad. */
export const RESIDENCIES = ['resident', 'international'] as const;
export type Residency = (typeof RESIDENCIES)[number];
export const RESIDENCY_LABEL: Record<Residency, string> = { resident: 'Resident', international: 'International' };
export const RESIDENCY_HELP: Record<Residency, string> = { resident: 'You live in the country you are applying in.', international: 'You live abroad and visit.' };

/** A membership an applicant can apply for: a residency, a term and a fee, offered in one market. */
export interface MembershipPlan { id: string; name: string; residency: Residency; termMonths: number; priceMinor: number; currency: string }
export const termLabel = (months: number) => (months === 1 ? '1 month' : `${months} months`);
export const planName = (residency: Residency, months: number) => `${RESIDENCY_LABEL[residency]}, ${termLabel(months)}`;
/** The plans a new market priced in rand starts with. Staff change fees and add plans under Tiers. */
export const DEFAULT_MEMBERSHIP_PLANS: { residency: Residency; termMonths: number; priceMinor: number }[] = [
  { residency: 'resident', termMonths: 3, priceMinor: 10_000_00 },
  { residency: 'resident', termMonths: 6, priceMinor: 18_000_00 },
  { residency: 'resident', termMonths: 12, priceMinor: 30_000_00 },
  { residency: 'international', termMonths: 1, priceMinor: 8_000_00 },
  { residency: 'international', termMonths: 3, priceMinor: 16_000_00 },
  { residency: 'international', termMonths: 6, priceMinor: 28_000_00 },
  { residency: 'international', termMonths: 12, priceMinor: 50_000_00 },
];

/* ---------- Application questions ---------- */

/** The questions every application has. Staff can reword them; they cannot be removed. */
export const BUILTIN_QUESTION_KEYS = ['email', 'fullName', 'phone', 'city', 'position', 'company', 'industry', 'roles', 'interests', 'motivation', 'referral', 'social', 'links', 'membership'] as const;
export type BuiltinQuestionKey = (typeof BUILTIN_QUESTION_KEYS)[number];
export const DEFAULT_INTERESTS = ['Dining', 'Wine', 'Travel', 'Wellness', 'Golf', 'Padel', 'Art', 'Fashion', 'Business', 'Investment', 'Founder gatherings', 'Retreats'];
export const BUILTIN_QUESTION_DEFAULTS: Record<BuiltinQuestionKey, { label: string; help: string; options: string[] }> = {
  email: { label: 'Email', help: 'We write to you here about your application.', options: [] },
  fullName: { label: 'Full name', help: '', options: [] },
  phone: { label: 'Phone number', help: 'With the country code, for example +27 82 123 4567. Only the membership team sees it.', options: [] },
  city: { label: 'Home city', help: '', options: [] },
  position: { label: 'Position', help: '', options: [] },
  company: { label: 'Company (optional)', help: '', options: [] },
  industry: { label: 'Industry', help: '', options: [] },
  roles: { label: 'How you would take part', help: 'Investor access is confirmed by the team after verification.', options: [] },
  interests: { label: 'Your interests', help: 'Choose any that apply.', options: DEFAULT_INTERESTS },
  motivation: { label: 'What would you bring, and what are you hoping to find?', help: '', options: [] },
  referral: { label: 'Referred by a member, or an invitation code (optional)', help: '', options: [] },
  social: { label: 'Your social media handle', help: 'The membership committee may look at your public profile. It is never shown to other members.', options: [] },
  links: { label: 'LinkedIn or website (optional)', help: '', options: [] },
  membership: { label: 'The membership you are applying for', help: 'Nothing is charged now. You pay once the committee approves your application.', options: [] },
};
export const QUESTION_KINDS = ['short_text', 'long_text', 'choice', 'multi_choice', 'yes_no'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = { short_text: 'Short answer', long_text: 'Paragraph', choice: 'One choice', multi_choice: 'Several choices', yes_no: 'Yes or no' };

export interface BuiltinQuestion { key: BuiltinQuestionKey; label: string; help: string; options: string[]; edited: boolean }
export interface CustomQuestion { id: string; kind: QuestionKind; label: string; help: string; options: string[]; required: boolean; active: boolean; position: number }
export interface ApplicationQuestions { builtin: BuiltinQuestion[]; custom: CustomQuestion[] }

export const builtinQuestionInputSchema = z.object({
  label: z.string().trim().min(2, 'Write the question').max(160),
  help: z.string().trim().max(300).default(''),
  options: z.array(z.string().trim().min(1).max(60)).max(24).optional(),
});
export type BuiltinQuestionInput = z.input<typeof builtinQuestionInputSchema>;
export const customQuestionInputSchema = z.object({
  kind: z.enum(QUESTION_KINDS),
  label: z.string().trim().min(2, 'Write the question').max(160),
  help: z.string().trim().max(300).default(''),
  options: z.array(z.string().trim().min(1).max(120)).max(24).default([]),
  required: z.boolean().default(false),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(999).default(100),
}).refine((q) => (q.kind === 'choice' || q.kind === 'multi_choice' ? q.options.length >= 2 : true), { message: 'Give at least two choices', path: ['options'] });
export type CustomQuestionInput = z.input<typeof customQuestionInputSchema>;

/** The wording of a built-in question: what staff wrote, or the default. */
export function builtinQuestion(questions: ApplicationQuestions | null | undefined, key: BuiltinQuestionKey): BuiltinQuestion {
  return questions?.builtin.find((q) => q.key === key) ?? { key, ...BUILTIN_QUESTION_DEFAULTS[key], edited: false };
}

const answerEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' ? !value.trim() : Array.isArray(value) ? value.length === 0 : true);

/**
 * Checks the answers to the questions staff added, and keeps only answers to questions that are open.
 * Returns the cleaned answers and an error per question, keyed by question id.
 */
export function checkAnswers(questions: readonly CustomQuestion[], answers: Record<string, unknown>): { answers: Record<string, string | string[]>; errors: Record<string, string> } {
  const clean: Record<string, string | string[]> = {}, errors: Record<string, string> = {};
  for (const q of questions.filter((item) => item.active)) {
    const value = answers[q.id];
    if (answerEmpty(value)) { if (q.required) errors[q.id] = q.kind === 'choice' || q.kind === 'multi_choice' || q.kind === 'yes_no' ? 'Choose an answer' : 'Answer this question'; continue; }
    if (q.kind === 'multi_choice') {
      if (!Array.isArray(value) || value.some((v) => !q.options.includes(String(v)))) { errors[q.id] = 'Choose from the list'; continue; }
      clean[q.id] = [...new Set(value.map(String))];
    } else if (typeof value !== 'string') { errors[q.id] = 'Answer this question'; }
    else if (q.kind === 'choice' && !q.options.includes(value)) errors[q.id] = 'Choose from the list';
    else if (q.kind === 'yes_no' && value !== 'Yes' && value !== 'No') errors[q.id] = 'Choose yes or no';
    else if (q.kind === 'short_text' && value.trim().length > 200) errors[q.id] = 'Keep this under 200 characters';
    else clean[q.id] = value.trim();
  }
  return { answers: clean, errors };
}

/* ---------- Notifications ---------- */

export const NOTIFICATION_CATEGORIES = [
  'experience_invitation',
  'booking_confirmation',
  'waitlist_opening',
  'message',
  'concierge_update',
  'qera_recommendation',
  'membership_update',
  'partner_privilege',
  'order',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  createdAt: string;
  readAt: string | null;
  /** Where "Open" should take the member. */
  link: { type: 'experience' | 'booking' | 'member' | 'request' | 'conversation' | 'order' | 'qera'; id: string } | null;
}

/* ---------- Push notifications ---------- */

/** How each kind of notification is named in the settings, and what the lock screen says when details are hidden. */
export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, [label: string, discreet: string]> = {
  experience_invitation: ['Invitations to experiences', 'You have a new invitation.'],
  booking_confirmation: ['Bookings and payments', 'There is news about a booking.'],
  waitlist_opening: ['Waiting list places', 'A place may be free for you.'],
  message: ['Messages from members', 'You have a new message.'],
  concierge_update: ['Concierge and Lifestyle requests', 'There is news about your request.'],
  qera_recommendation: ['QÉRA reminders and suggestions', 'QÉRA has something for you.'],
  membership_update: ['Membership and account', 'There is news about your membership.'],
  partner_privilege: ['Partner privileges', 'There is news about a privilege.'],
  order: ['Maison Quintara orders', 'There is news about your order.'],
};

/** A phone registered for push notifications. The push token itself is never sent back. */
export interface PushDevice { id: string; platform: 'ios' | 'android'; deviceName: string; createdAt: string; lastSeenAt: string; thisDevice: boolean }

export interface PushSettings {
  /** Kinds of notification not pushed. They still appear under Notifications. */
  muted: NotificationCategory[];
  /** Show what the notification says on the lock screen. Off: only "There is news about your order", and so on. */
  showDetails: boolean;
  devices: PushDevice[];
}
export const pushSettingsInputSchema = z.object({ muted: z.array(z.enum(NOTIFICATION_CATEGORIES)).max(NOTIFICATION_CATEGORIES.length), showDetails: z.boolean() });
export type PushSettingsInput = z.infer<typeof pushSettingsInputSchema>;

/** The token Expo gives the app for this phone, registered with the session that is signed in. */
export const pushRegistrationSchema = z.object({
  token: z.string().trim().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/, 'Not a push token'),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().trim().max(80).default(''),
});
export type PushRegistration = z.input<typeof pushRegistrationSchema>;

/* ---------- Membership renewal ---------- */

/** A card kept by the payment provider. Only the brand, the last four digits and the expiry are ever known here. */
export interface SavedCard { brand: string; last4: string; expMonth: number; expYear: number; expired: boolean; expiresBeforeRenewal: boolean }

export type MembershipState =
  /** Paid up, with a term ending on `termEndsAt` (or no end). */
  | 'active'
  /** Within 30 days of the end of the term. */
  | 'renewal_due'
  /** The term has ended and the renewal has not gone through yet: access continues until `graceEndsAt`. */
  | 'grace'
  /** The term ended and was not renewed. Member access is paused until it is renewed. */
  | 'lapsed';

export interface MembershipRenewalPayment { id: string; at: string; amountMinor: number; currency: string; status: 'paid' | 'failed' | 'refunded' | 'pending'; periodEnd: string | null; reason: string | null }

export interface MembershipStatus {
  memberNumber: string;
  tierName: string;
  priceMinor: number;
  currency: string;
  /** Months in a term. Null: a membership with no end, which never renews. */
  termMonths: number | null;
  termEndsAt: string | null;
  state: MembershipState;
  graceEndsAt: string | null;
  autoRenew: boolean;
  card: SavedCard | null;
  /** When the next automatic attempt will be made, after a declined one. */
  nextAttemptAt: string | null;
  lastFailure: string | null;
  /** Renewing now is possible: within 30 days of the end, in the grace period, or lapsed. */
  canRenewNow: boolean;
  history: MembershipRenewalPayment[];
}

/** Days before the end of a term when a reminder is sent, and the days of grace after it before the membership lapses. */
export const RENEWAL_REMINDER_DAYS = [30, 7] as const;
export const RENEWAL_GRACE_DAYS = 14;
/** Days after the end of the term when a declined renewal is tried again. */
export const RENEWAL_RETRY_DAYS = [1, 3, 7] as const;

/**
 * Saving a card: the card details are typed into the payment provider's own secure form, which gives the app a
 * one-time setup token. Only that token comes to Quintara. Anything that looks like a card number is refused.
 */
export const paymentMethodInputSchema = z.object({
  setupToken: z.string().trim().min(6).max(200).regex(/^[A-Za-z0-9_.:-]+$/, 'Not a setup token').refine((t) => !/\d{12,}/.test(t), 'Card numbers are never sent to Quintara'),
});
export const autoRenewInputSchema = z.object({ autoRenew: z.boolean() });

/** Test cards for development and the app store review, used only when the payment provider is the stand-in. */
export const TEST_CARDS = [
  { setupToken: 'test_card_visa', label: 'Visa, ending 4242, accepted' },
  { setupToken: 'test_card_mastercard', label: 'Mastercard, ending 4444, accepted' },
  { setupToken: 'test_card_declined', label: 'Visa, ending 0002, always declined' },
] as const;

/* ---------- Concierge ---------- */

export const CONCIERGE_CATEGORIES = ['hospitality', 'travel', 'wellness', 'personal', 'entertainment'] as const;
export type ConciergeCategory = (typeof CONCIERGE_CATEGORIES)[number];
export const CONCIERGE_CATEGORY_LABEL: Record<ConciergeCategory, string> = {
  hospitality: 'Hospitality', travel: 'Travel', wellness: 'Wellness', personal: 'Personal services', entertainment: 'Entertainment',
};

export const CONCIERGE_STATUSES = ['requested', 'reviewing', 'options_provided', 'confirmed', 'completed', 'cancelled'] as const;
export type ConciergeStatus = (typeof CONCIERGE_STATUSES)[number];
export const CONCIERGE_STATUS_LABEL: Record<ConciergeStatus, string> = {
  requested: 'Requested', reviewing: 'Reviewing', options_provided: 'Options provided', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled',
};
/** The path shown as a progress line. Cancelled sits beside it. */
export const CONCIERGE_PATH: ConciergeStatus[] = ['requested', 'reviewing', 'options_provided', 'confirmed', 'completed'];

export interface ThreadMessage {
  id: string;
  from: 'member' | 'desk';
  body: string;
  sentAt: string;
}

export interface ConciergeRequest {
  id: string;
  category: ConciergeCategory;
  subject: string;
  details: string;
  neededBy: string | null; // ISO date
  status: ConciergeStatus;
  createdAt: string;
  messages: ThreadMessage[];
}

export const conciergeRequestSchema = z.object({
  category: z.enum(CONCIERGE_CATEGORIES),
  subject: z.string().trim().min(3, 'Give the request a short title').max(120),
  details: z.string().trim().min(10, 'Tell the desk a little more').max(2000),
  neededBy: z.iso.date().nullable().optional(),
});
export type ConciergeRequestInput = z.infer<typeof conciergeRequestSchema>;

export const messageBodySchema = z.object({ body: z.string().trim().min(1, 'Write a message first').max(2000, 'That message is too long') });

/* ---------- Messaging ---------- */

export interface ChatPartner {
  memberId: string;
  fullName: string;
  position: string;
  company: string;
}

export interface Conversation extends ChatPartner {
  lastMessage: string;
  lastMessageAt: string;
  unread: boolean;
}

export interface ChatMessage {
  id: string;
  mine: boolean;
  body: string;
  sentAt: string;
}

export interface ConversationThread {
  with: ChatPartner;
  /** False until the two members are connected. */
  canSend: boolean;
  messages: ChatMessage[];
}

/* ---------- Formatting helpers shared by web and mobile ---------- */

export function formatMoney(minor: number, currency: string, locale = 'en-ZA'): string {
  if (minor === 0) return 'Complimentary';
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/** Formats an instant in the time zone of the place it happens, not the viewer's. */
export function formatDateTime(iso: string, timezone: string, locale = 'en-ZA'): { day: string; month: string; long: string; time: string } {
  const date = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options }).format(date);
  return {
    day: part({ day: 'numeric' }),
    month: part({ month: 'short' }),
    long: part({ weekday: 'short', day: 'numeric', month: 'long' }),
    time: part({ hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

/* ---------- Section descriptions, edited by staff ---------- */

/** The parts of the apps whose introductions staff write: a short line for menus and lists, and the page description. */
export const SECTION_KEYS = ['qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator', 'experiences', 'business', 'relationship', 'matching', 'services', 'partners', 'tv', 'membership', 'guest', 'notifications'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export interface SectionCopy { key: SectionKey; title: string; summary: string; description: string; /** Null while the wording is Quintara's default. */ updatedAt: string | null }
export const SECTION_DEFAULTS: Record<SectionKey, { title: string; summary: string; description: string }> = {
  qera: { title: 'QÉRA', summary: 'Your Chief of Staff, the Quintara Intelligence', description: 'The Quintara Intelligence. It knows what Quintara offers and what you have asked it to remember. It briefs you on your week, reminds you of what matters, recommends, books experiences, partners and services, and prepares plans you can book in one go. It asks before it acts, never pays for anything, and refers to Ms. Palesa Makam only what it cannot manage itself.' },
  club: { title: 'The Club', summary: 'An approved directory, introductions and private messaging', description: 'Every profile is approved by Quintara. Contact details stay private until a member chooses to share them.' },
  concierge: { title: 'Concierge', summary: 'A person who arranges tables, travel and tickets', description: 'The desk steps in for anything QÉRA cannot manage itself. Most things are quicker through QÉRA. For the rest, tell the desk what you need; a person returns with options and books what you choose.' },
  lifestyle: { title: 'Lifestyle', summary: 'Services, and the places and people Quintara vouches for', description: 'Services you can ask Quintara to arrange, and the places and people Quintara vouches for.' },
  privileges: { title: 'Privileges', summary: 'Benefits at Quintara partner venues', description: 'Benefits arranged with Quintara partners. Show the code when you arrive.' },
  boutique: { title: 'Maison Quintara', summary: 'Pieces by members, partners and Quintara', description: 'A small shop of things made by members, partners and Quintara.' },
  bookings: { title: 'Bookings', summary: 'Tickets, payments and cancellations', description: 'Every reservation, application and waitlist place in one itinerary.' },
  messaging: { title: 'Messaging', summary: 'Private conversations with members you are connected to', description: 'Private conversations with members you are connected to.' },
  curator: { title: 'Lifestyle Curator, Ms. Palesa Makam', summary: 'Lifestyle Curator, Private Client Services', description: 'She looks after the services and partners here, arranges what you ask to book, and steps in for anything QÉRA cannot manage itself.' },
  experiences: { title: 'Experiences', summary: 'Tables, evenings and gatherings arranged by Quintara', description: 'Members reserve first and at member prices.' },
  business: { title: 'Business', summary: 'Opportunities, a relationship manager and introductions', description: 'Opportunities from Quintara, a relationship manager to help you pursue them, and introductions between founders, investors, creatives and executives, made with consent on both sides.' },
  relationship: { title: 'Relationship Manager, Mr. Wayne Huffton', summary: 'Relationship Manager, BMM Capital', description: 'Mr. Wayne Huffton of BMM Capital is Quintara’s dedicated relationship manager. On your request he can facilitate business partnerships, advisory and brand collaborations.' },
  matching: { title: 'People to meet', summary: 'Suggestions from what members choose to show', description: 'Suggested from what you and they have chosen to show. Nobody is told they were suggested. You can switch this off under Profile.' },
  services: { title: 'Lifestyle services', summary: 'Services Quintara arranges with its providers', description: 'Available to guests and members. Ask to book and Quintara arranges it with the provider and confirms it with you.' },
  partners: { title: 'Partners and services directory', summary: 'The places, people and services Quintara vouches for', description: 'Who they are, what they offer and who to ask for. Partners give members privileges; services can be booked through Quintara.' },
  tv: { title: 'Quintara TV', summary: 'Films from inside Quintara', description: 'Films from inside Quintara: the tables, the people and the places.' },
  membership: { title: 'Membership application', summary: 'A few short steps, read by a person', description: 'A few short steps. Your answers are saved as you go, and a person reads every application.' },
  guest: { title: 'Guest account', summary: 'A free personal account for guests', description: 'A free personal account for guests of Quintara. Talk to QÉRA, the Quintara Intelligence, for up to five hours a day, request lifestyle services and order from Maison Quintara.' },
  notifications: { title: 'Notifications', summary: 'Invitations, confirmations and replies', description: 'Confirmations, invitations and connection requests appear here.' },
};
export const sectionCopyInputSchema = z.object({
  summary: z.string().trim().min(2, 'Write a short line').max(160),
  description: z.string().trim().min(10, 'Write at least a sentence').max(1200),
});
export type SectionCopyInput = z.input<typeof sectionCopyInputSchema>;
/** The wording to show for a section: what staff wrote, or Quintara's default. */
export function sectionText(list: readonly SectionCopy[] | undefined, key: SectionKey): SectionCopy {
  return list?.find((c) => c.key === key) ?? { key, ...SECTION_DEFAULTS[key], updatedAt: null };
}

export * from './qera.ts';
export * from './whatsapp.ts';

/* ---------- Sample data ---------- */

const SAMPLE_BASE = Date.parse('2026-10-11T00:00:00Z');
const WEEK = 7 * 86_400_000;
/**
 * The sample experiences (development seed and the offline mock) are written with dates from 11 October 2026. They are
 * moved forward by whole weeks so the earliest is always at least a week ahead, keeping weekdays and local times.
 * Before that date nothing moves. Production data never passes through this.
 */
export function sampleDate(iso: string, now: number = Date.now()): string {
  const weeks = Math.max(0, Math.ceil((now + WEEK - SAMPLE_BASE) / WEEK));
  return new Date(Date.parse(iso) + weeks * WEEK).toISOString().replace('.000Z', 'Z');
}
