/** The staff side of the API, used by the admin app. */
import type { TvEpisode, TvEpisodeInput, TvSeries, TvSeriesInput,
  AdvanceOrderInput, DeliveryOption, DeliveryOptionInput, DispatchInput, Order, OrderEvent, Product, ProductInput,
  PartnerBooking, HomeSlide, LifestyleService, LifestyleServiceInput, ServicePackage, ServicePackageInput, ServiceRequest, ServiceRequestStatus,
  BusinessListing, BusinessPerson, BusinessRole, BusinessUpdate, BusinessUpdateInput, ListingEdit, RmEnquiry, Introduction,
  Admission, ApplicationData, ApplicationStatus, ConciergeRequest, ConciergeStatus, Experience, Partner, PartnerInput, Privilege, PrivilegeInput, PublishStatus, ReportReason, StaffRole, Market, MarketInput, SectionCopy, SectionCopyInput, SectionKey, Residency, ApplicationQuestions, BuiltinQuestionKey, BuiltinQuestionInput, CustomQuestionInput, TwoFactorStatus, TwoFactorSetup } from '@quintara/domain';
import { createRequester, queryString } from './http.ts';
import type { HttpApiOptions } from './http.ts';

/** An order as staff see it, with who bought it and every step, including internal notes. */
export interface StaffOrder extends Order {
  buyer: 'member' | 'guest';
  contactEmail: string | null;
  updatedAt: string;
  /** For an unpaid order: when it lapses. */
  payBy: string | null;
  history: (OrderEvent & { by: string })[];
}
export interface UploadedPhoto { id: string; path: string; width: number; height: number; bytes: number }
/** How a photograph is stored: its longest side in pixels, the quality (70 to 100), and the part to keep, as fractions. */
export interface PhotoUploadOptions { maxEdge?: number; quality?: number; crop?: { x: number; y: number; width: number; height: number } | null }
export interface StaffAccount {
  userId: string; fullName: string; email: string; title: string; role: StaffRole; status: 'active' | 'suspended';
  /** Two-factor set up. */
  twoFactor: boolean; lastSignInAt: string | null; lastActiveAt: string | null; createdAt: string;
  /** The signed-in member of staff. */
  you: boolean;
}
/** One entry: an action (what was done to which record) or a request (what was opened or sent). */
export interface AuditEntry {
  kind: 'action' | 'request'; seq: number; at: string; staffId: string | null; staffName: string; action: string; summary: string;
  entityType: string | null; entityId: string | null; details: unknown; status: number | null; ip: string | null; device: string | null;
}
export interface AuditFilters { staff?: string; kind?: 'action' | 'request' | 'all'; q?: string; from?: string; to?: string; limit?: number }
export interface AuditCheck { entries: number; intact: boolean; firstBrokenAt: number | null }
const auditQuery = (f: AuditFilters) => ({ staff: f.staff, kind: f.kind, q: f.q, from: f.from, to: f.to, limit: f.limit?.toString() });
const insightQuery = (q: InsightQuery) => ({ period: q.period, from: q.from, to: q.to });
export interface StaffSession { userId: string; roles: StaffRole[] }
/** A city, with how much has been prepared in it. */
export interface StaffMarket extends Market { experiences: number; members: number; partners: number; services: number; products: number }
export interface StaffApplication { id: string; status: ApplicationStatus; data: ApplicationData; email: string | null; submittedAt: string | null; offeredTierName: string | null; decisionNote: string | null; requestedTier: { id: string; name: string; priceMinor: number; currency: string } | null }
export interface StaffTier { id: string; marketId: string; name: string; priceMinor: number; currency: string; billingPeriod: string; residency: Residency | null; termMonths: number | null }
export interface StaffMember { id: string; userId: string; memberNumber: string; status: string; fullName: string; email: string; tierName: string; roles: string[]; joinedAt: string }
/** Staff always see the date and the seat counts. */
export interface StaffExperience extends Omit<Experience, 'startsAt' | 'capacity' | 'seatsTaken'> { startsAt: string; capacity: number; seatsTaken: number; status: 'draft' | 'published' | 'cancelled' | 'completed'; isHidden: boolean; seatsHeld: number; paymentHoldMinutes: number; refundHours: number }
export type BillingPeriod = 'month' | 'year' | 'once' | 'none';
export interface StaffTierDetail extends StaffTier { isActive: boolean; members: number }
export interface TierInput { name: string; priceMinor: number; currency: string; billingPeriod: BillingPeriod; isActive?: boolean; residency?: Residency | null; termMonths?: number | null }
export interface StaffPayment { id: string; purpose: string; payer: string; description: string; amountMinor: number; refundedMinor: number; currency: string; status: 'pending' | 'paid' | 'failed' | 'refunded'; provider: string; failureReason: string | null; createdAt: string }
export interface Guest { bookingId: string; memberId: string; memberNumber: string; fullName: string; seats: number; status: string; ticketCode: string; checkedInAt: string | null }
export interface StaffConciergeRequest extends ConciergeRequest { memberName: string; memberNumber: string }
export interface StaffReport { id: string; reason: ReportReason; detail: string; status: 'open' | 'dismissed' | 'suspended'; createdAt: string; reporter: { id: string; fullName: string }; reported: { id: string; fullName: string; status: string } }
/** Counts and totals only: nothing here identifies a member. */
export type InsightPeriod = '7d' | '30d' | '90d' | '12m' | 'ytd';
export interface InsightQuery { period?: InsightPeriod; from?: string; to?: string }
export interface InsightRange { from: string; to: string; label: string }
/** The Overview: GET /admin/v1/dashboard. A section is null when the viewer's role does not include it. */
export interface StaffDashboard {
  market: { name: string; currency: string };
  business: null | {
    revenueMinor: number; revenuePrevMinor: number; activeMembers: number; newMembers: number; newMembersPrev: number;
    bookings: number; bookingsPrev: number; orders: number; ordersPrev: number; revenueBySource: { label: string; totalMinor: number }[];
  };
  membership: null | { activeMembers: number; suspendedMembers: number; applicationsToReview: number; awaitingPayment: number; renewalsDue30: number };
  experiences: null | {
    upcoming: number; full: number; seatsBooked: number; seatsTotal: number; awaitingDecision: number;
    next: { id: string; title: string; startsAt: string; seatsTaken: number; capacity: number }[];
  };
  concierge: null | { openRequests: number; newRequests: number; openServiceRequests: number; partnerBookingsWaiting: number };
  maison: null | { toProcess: number; preparing: number; withCourier: number };
  generatedAt: string;
}

export interface StaffInsights {
  market: { name: string; currency: string };
  period: InsightRange;
  previous: InsightRange;
  bucket: 'day' | 'week' | 'month';
  headline: {
    revenueMinor: number; revenuePrevMinor: number; activeMembers: number; newMembers: number; newMembersPrev: number; lapsedMembers: number;
    renewalRate: number | null; autoRenewShare: number | null; bookings: number; bookingsPrev: number; orders: number; ordersPrev: number;
  };
  revenueSeries: { bucket: string; label: string; bySource: Record<string, number> }[];
  revenueBySource: { source: string; label: string; totalMinor: number; count: number; refundedMinor: number }[];
  membership: {
    byTier: { tier: string; count: number }[];
    flow: { bucket: string; label: string; joined: number; lapsed: number }[];
    renewals: { due30: number; due60: number; autoRenewOn: number; autoRenewOff: number; failing: number; renewed: number; lapsed: number };
    applications: { submitted: number; approved: number; activated: number; declined: number; waitlisted: number };
  };
  experiences: { id: string; title: string; startsAt: string; capacity: number; seatsTaken: number; bookings: number; revenueMinor: number }[];
  services: { name: string; requests: number }[];
  partners: { name: string; bookings: number; redemptions: number }[];
  maison: { orders: number; revenueMinor: number; averageMinor: number; cancelled: number; topProducts: { title: string; units: number; revenueMinor: number }[] };
  concierge: { kind: string; count: number }[];
  club: { connections: number; conversations: number; blocks: number; openReports: number };
  engagement: { qeraMessages: number; qeraActionsConfirmed: number; membersWithPush: number; pushShare: number | null };
}
/** A membership coming up for renewal, failing to renew, or lapsed. Card details are never shown to staff. */
export interface StaffRenewal {
  memberId: string; memberName: string; memberNumber: string; tierName: string; termEndsAt: string | null; autoRenew: boolean; cardOnFile: boolean;
  cardExpiresBeforeRenewal: boolean; attempts: number; nextAttemptAt: string | null; lastFailure: string | null; status: string; lapsedAt: string | null; amountMinor: number; currency: string;
}
export interface StaffClosure { userId: string; fullName: string; memberNumber: string; requestedAt: string; eraseAfter: string; erasedAt: string | null }
export interface StaffPrivilege extends Privilege { status: PublishStatus; totalUses: number }
export interface StaffPartner extends Omit<Partner, 'privileges'> { status: PublishStatus; privileges: StaffPrivilege[] }
export interface StaffPartnerBooking extends PartnerBooking { memberName: string; emailed: boolean }
export interface StaffServicePackage extends ServicePackage { status: PublishStatus; position: number }
export interface StaffService extends Omit<LifestyleService, 'packages'> { status: PublishStatus; position: number; requests: number; packages: StaffServicePackage[] }
export interface StaffServiceRequest extends ServiceRequest { contactName: string; contactEmail: string; isMember: boolean }
export interface StaffHomeSlide extends HomeSlide { isActive: boolean; position: number }
export interface StaffBusinessUpdate extends BusinessUpdate { status: PublishStatus; enquiries: number }
export interface StaffRmEnquiry extends RmEnquiry { memberName: string; memberNumber: string; memberRole: string }
export interface StaffIntroduction { id: string; status: Introduction['status']; note: string; listingTitle: string | null; requester: BusinessPerson; target: BusinessPerson; createdAt: string }
export interface StaffProduct extends Product { status: PublishStatus; memberPriceMinor: number | null }
export interface StaffDeliveryOption extends DeliveryOption { isActive: boolean }
export interface StaffTvEpisode extends TvEpisode { status: PublishStatus; viewers: number }
export interface StaffTvSeries extends Omit<TvSeries, 'episodes'> { status: PublishStatus; episodes: StaffTvEpisode[] }
export interface ExperienceInput {
  title: string; category: string; summary?: string; description?: string; startsAt: string; timezone: string; venueName?: string; area?: string;
  dressCode?: string; host?: string; capacity: number; seatsHeld?: number; priceMinor?: number; memberPriceMinor?: number; currency: string;
  admission: Admission; isHidden?: boolean; openToGuests?: boolean; guestPolicy?: string; maxSeatsPerBooking?: number; paymentHoldMinutes?: number; refundHours?: number; status?: 'draft' | 'published' | 'cancelled';
}

export interface AdminApi {
  getSession(): Promise<StaffSession | null>;
  /** Every city, open or not, with counts. */
  listMarkets(): Promise<StaffMarket[]>;
  /** Adds a city, closed. */
  createMarket(input: MarketInput): Promise<Market>;
  setMarketOpen(id: string, isOpen: boolean): Promise<Market>;
  listSectionCopy(): Promise<SectionCopy[]>;
  updateSectionCopy(key: SectionKey, input: SectionCopyInput): Promise<SectionCopy>;
  /** Back to Quintara's default wording. */
  resetSectionCopy(key: SectionKey): Promise<SectionCopy>;
  /** The city staff are working in: lists show it and new entries are created in it. */
  setMarket(slug: string | null): void;
  /** With a code in production (`getAuthConfig`), or by address alone in development. */
  /** With `twoFactor` set, the sign-in waits for its second step (verifyTwoFactor, or setting up an authenticator). */
  signIn(email: string, code?: string): Promise<{ userId: string | null; roles: StaffRole[]; twoFactor?: 'verify' | 'enrol' }>;
  getAuthConfig(): Promise<{ method: 'dev' | 'code' }>;
  requestSignInCode(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Two-factor for the signed-in member of staff. */
  getTwoFactor(): Promise<TwoFactorStatus>;
  startTwoFactorSetup(code?: string): Promise<TwoFactorSetup>;
  confirmTwoFactor(code: string): Promise<{ recoveryCodes: string[] }>;
  verifyTwoFactor(code: string): Promise<StaffSession>;
  newRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }>;
  /** Admin console accounts (up to five active) and how many seats are used. Administrators only. */
  listStaff(): Promise<{ staff: StaffAccount[]; seats: { used: number; total: number } }>;
  /** Adds an account; the person is emailed how to sign in. */
  addStaff(input: { fullName: string; email: string; title?: string; role: StaffRole }): Promise<{ userId: string }>;
  updateStaff(userId: string, input: { fullName?: string; title?: string; role?: StaffRole; status?: 'active' | 'suspended' }): Promise<void>;
  /** The audit log, newest first. Administrators see everyone; others see their own. */
  listAudit(filters?: AuditFilters): Promise<{ entries: AuditEntry[]; all: boolean; staff: { userId: string; fullName: string }[] }>;
  /** The address of the CSV export for these filters (opened in the browser, with the staff cookie). */
  auditExportUrl(filters?: AuditFilters): string;
  /** Recomputes the hash chains: any entry removed or altered shows where the chain breaks. */
  verifyAudit(): Promise<{ actions: AuditCheck; requests: AuditCheck; checkedAt: string }>;
  /** Clears someone's authenticator after they lost their phone and codes, once identified. Signs them out everywhere. Administrators only. */
  resetTwoFactor(userId: string, reason: string): Promise<void>;
  listApplications(status?: ApplicationStatus): Promise<StaffApplication[]>;
  reviewApplication(id: string, status: 'under_review' | 'interview' | 'waitlisted' | 'declined', note?: string): Promise<void>;
  approveApplication(id: string, tierId: string): Promise<void>;
  listTiers(): Promise<StaffTier[]>;
  listApplicationQuestions(): Promise<ApplicationQuestions>;
  updateBuiltinQuestion(key: BuiltinQuestionKey, input: BuiltinQuestionInput): Promise<ApplicationQuestions>;
  resetBuiltinQuestion(key: BuiltinQuestionKey): Promise<ApplicationQuestions>;
  createApplicationQuestion(input: CustomQuestionInput): Promise<ApplicationQuestions>;
  updateApplicationQuestion(id: string, changes: Partial<CustomQuestionInput>): Promise<ApplicationQuestions>;
  listAllTiers(): Promise<StaffTierDetail[]>;
  createTier(input: TierInput): Promise<void>;
  updateTier(id: string, changes: Partial<Omit<TierInput, 'currency'>>): Promise<void>;
  listPayments(): Promise<StaffPayment[]>;
  listMembers(): Promise<StaffMember[]>;
  setMemberStatus(id: string, status: 'active' | 'suspended'): Promise<void>;
  setMemberRole(id: string, role: BusinessRole, granted: boolean): Promise<void>;
  listExperiences(): Promise<StaffExperience[]>;
  createExperience(input: ExperienceInput): Promise<StaffExperience>;
  updateExperience(id: string, changes: Partial<ExperienceInput>): Promise<StaffExperience>;
  inviteMember(experienceId: string, memberId: string): Promise<void>;
  listGuests(experienceId: string): Promise<Guest[]>;
  decideBooking(bookingId: string, decision: 'confirm' | 'decline'): Promise<void>;
  checkIn(ticketCode: string): Promise<{ fullName: string; seats: number; experienceTitle: string }>;
  listBusinessListings(): Promise<BusinessListing[]>;
  reviewListing(id: string, decision: 'publish' | 'decline' | 'close', note?: string): Promise<void>;
  /** Corrects a member's listing. The kind cannot be changed. */
  editListing(id: string, changes: Omit<ListingEdit, 'kind'>): Promise<void>;
  listBusinessUpdates(): Promise<StaffBusinessUpdate[]>;
  createBusinessUpdate(input: BusinessUpdateInput): Promise<{ id: string }>;
  updateBusinessUpdate(id: string, changes: Partial<BusinessUpdateInput>): Promise<void>;
  deleteBusinessUpdate(id: string): Promise<void>;
  listRmEnquiries(): Promise<StaffRmEnquiry[]>;
  replyToRmEnquiry(id: string, body: string): Promise<void>;
  closeRmEnquiry(id: string): Promise<void>;
  listIntroductions(): Promise<StaffIntroduction[]>;
  /** `offer` puts the request to the other member; `not_progressed` lets it rest. */
  handleIntroduction(id: string, decision: 'offer' | 'not_progressed'): Promise<void>;
  listProducts(): Promise<StaffProduct[]>;
  createProduct(input: ProductInput): Promise<{ id: string }>;
  updateProduct(id: string, changes: Partial<Omit<ProductInput, 'currency'>>): Promise<void>;
  /** Every order from placement: paid ones first, then unpaid and closed ones, with the full history. */
  listOrders(): Promise<StaffOrder[]>;
  /** Moves a paid order on by one step: preparing, dispatched, delivered. Dispatching needs the courier details. */
  /** One step on: processing, dispatched (courier and tracking number), received (who took it in). The note is shown to the buyer. */
  advanceOrder(id: string, input?: AdvanceOrderInput | DispatchInput): Promise<void>;
  /** A note for staff only. */
  addOrderNote(id: string, note: string): Promise<void>;
  /** Cancels an order before dispatch and refunds a paid one. The buyer is told the reason. */
  cancelOrder(id: string, reason: string): Promise<void>;
  listDeliveryOptions(): Promise<StaffDeliveryOption[]>;
  createDeliveryOption(input: DeliveryOptionInput): Promise<{ id: string }>;
  updateDeliveryOption(id: string, changes: Partial<Omit<DeliveryOptionInput, 'currency'>>): Promise<void>;
  /** Uploads a JPEG, PNG or WebP of up to 2 MB and returns its id for a product. */
  uploadImage(contentType: string, dataBase64: string): Promise<UploadedPhoto>;
  /** Uploads a photograph as it is (up to 40 MB), stored at the size, crop and quality chosen. */
  uploadPhoto(file: Blob, options?: PhotoUploadOptions): Promise<UploadedPhoto>;
  listTvSeries(): Promise<StaffTvSeries[]>;
  createTvSeries(input: TvSeriesInput): Promise<{ id: string }>;
  updateTvSeries(id: string, changes: Partial<TvSeriesInput>): Promise<void>;
  createTvEpisode(seriesId: string, input: TvEpisodeInput): Promise<{ id: string }>;
  updateTvEpisode(id: string, changes: Partial<Omit<TvEpisodeInput, 'number'>>): Promise<void>;
  /** Bookings QÉRA has sent to partners. Staff can answer for a partner who telephones instead of using the link. */
  listPartnerBookings(): Promise<StaffPartnerBooking[]>;
  settlePartnerBooking(id: string, answer: 'confirm' | 'decline', note?: string): Promise<void>;
  listServices(): Promise<StaffService[]>;
  createService(input: LifestyleServiceInput): Promise<{ id: string }>;
  updateService(id: string, changes: Partial<LifestyleServiceInput>): Promise<void>;
  createServicePackage(serviceId: string, input: ServicePackageInput): Promise<{ id: string }>;
  updateServicePackage(id: string, changes: Partial<ServicePackageInput>): Promise<void>;
  deleteServicePackage(id: string): Promise<void>;
  listServiceRequests(): Promise<StaffServiceRequest[]>;
  setServiceRequestStatus(id: string, status: ServiceRequestStatus): Promise<void>;
  listHomeSlides(): Promise<StaffHomeSlide[]>;
  /** A photograph already uploaded with uploadImage, or a film by https link. */
  createHomeSlide(input: { kind: 'image'; imageId: string; caption?: string; position?: number } | { kind: 'video'; videoUrl: string; caption?: string; position?: number }): Promise<{ id: string }>;
  updateHomeSlide(id: string, changes: { caption?: string; position?: number; isActive?: boolean; imageId?: string }): Promise<void>;
  deleteHomeSlide(id: string): Promise<void>;
  listPartners(): Promise<StaffPartner[]>;
  createPartner(input: PartnerInput): Promise<{ id: string }>;
  updatePartner(id: string, changes: Partial<PartnerInput>): Promise<void>;
  createPrivilege(partnerId: string, input: PrivilegeInput): Promise<{ id: string }>;
  updatePrivilege(id: string, changes: Partial<PrivilegeInput>): Promise<void>;
  listClosures(): Promise<StaffClosure[]>;
  /** Erases a closed account's personal data now. Cannot be undone. */
  eraseClosedAccount(userId: string): Promise<void>;
  reinstateClosedAccount(userId: string): Promise<void>;
  listReports(): Promise<StaffReport[]>;
  /** Closes a report. `suspended` also suspends the reported member. */
  resolveReport(id: string, outcome: 'dismissed' | 'suspended'): Promise<void>;
  getDashboard(): Promise<StaffDashboard>;
  getInsights(query?: InsightQuery): Promise<StaffInsights>;
  /** The figures as a CSV file, for the same period. */
  insightsExportUrl(query?: InsightQuery): string;
  getReportSetting(): Promise<{ weeklyReport: boolean }>;
  setReportSetting(weeklyReport: boolean): Promise<{ weeklyReport: boolean }>;
  /** Emails this week's report for the city being viewed to the member of staff asking. */
  sendReportToMe(): Promise<{ sent: boolean }>;
  listRenewals(): Promise<{ upcoming: StaffRenewal[]; failing: StaffRenewal[]; lapsed: StaffRenewal[] }>;
  retryRenewal(memberId: string): Promise<{ paid: boolean; reason?: string }>;
  extendRenewal(memberId: string, days: number, reason: string): Promise<{ termEndsAt: string }>;
  listConciergeRequests(): Promise<StaffConciergeRequest[]>;
  getConciergeRequest(id: string): Promise<StaffConciergeRequest>;
  replyToConciergeRequest(id: string, body: string): Promise<StaffConciergeRequest>;
  setConciergeStatus(id: string, status: Exclude<ConciergeStatus, 'requested' | 'cancelled'>): Promise<StaffConciergeRequest>;
}

export function createAdminApi(options: HttpApiOptions): AdminApi {
  // The city staff are working in. A closed city can be chosen, to prepare it before it opens.
  let market: string | null = null;
  const request = createRequester({ ...options, getMarket: () => market });
  const id = encodeURIComponent;
  return {
    getSession: () => request('GET', '/admin/v1/session'),
    listMarkets: () => request('GET', '/admin/v1/markets'),
    createMarket: (input) => request('POST', '/admin/v1/markets', input),
    setMarketOpen: (marketId, isOpen) => request('PATCH', `/admin/v1/markets/${encodeURIComponent(marketId)}`, { isOpen }),
    listSectionCopy: () => request('GET', '/admin/v1/content/sections'),
    updateSectionCopy: (key, input) => request('PUT', `/admin/v1/content/sections/${encodeURIComponent(key)}`, input),
    resetSectionCopy: (key) => request('DELETE', `/admin/v1/content/sections/${encodeURIComponent(key)}`),
    setMarket: (slug) => { market = slug; },
    signIn: (email, code) => request('POST', '/admin/v1/session', code ? { email, code } : { email }),
    getAuthConfig: () => request('GET', '/v1/auth/config'),
    requestSignInCode: async (email) => { await request('POST', '/v1/auth/code', { email, purpose: 'staff' }); },
    signOut: () => request('DELETE', '/admin/v1/session'),
    getTwoFactor: () => request('GET', '/admin/v1/auth/2fa'),
    startTwoFactorSetup: (code) => request('POST', '/admin/v1/auth/2fa/setup', code ? { code } : {}),
    confirmTwoFactor: (code) => request('POST', '/admin/v1/auth/2fa/confirm', { code }),
    verifyTwoFactor: (code) => request('POST', '/admin/v1/auth/2fa/verify', { code }),
    newRecoveryCodes: (code) => request('POST', '/admin/v1/auth/2fa/recovery-codes', { code }),
    listStaff: () => request('GET', '/admin/v1/staff'),
    addStaff: (input) => request('POST', '/admin/v1/staff', input),
    updateStaff: (userId, input) => request('PATCH', `/admin/v1/staff/${id(userId)}`, input),
    listAudit: (f = {}) => request('GET', '/admin/v1/audit' + queryString(auditQuery(f))),
    auditExportUrl: (f = {}) => `${options.baseUrl.replace(/\/$/, '')}/admin/v1/audit/export${queryString(auditQuery(f))}`,
    verifyAudit: () => request('POST', '/admin/v1/audit/verify', {}),
    resetTwoFactor: (userId, reason) => request('POST', `/admin/v1/users/${encodeURIComponent(userId)}/two-factor/reset`, { reason }),
    listApplications: (status) => request('GET', '/admin/v1/applications' + queryString({ status })),
    reviewApplication: (applicationId, status, note) => request('POST', `/admin/v1/applications/${id(applicationId)}/review`, { status, note }),
    approveApplication: (applicationId, tierId) => request('POST', `/admin/v1/applications/${id(applicationId)}/approve`, { tierId }),
    listTiers: () => request('GET', '/admin/v1/tiers'),
    listApplicationQuestions: () => request('GET', '/admin/v1/application/questions'),
    updateBuiltinQuestion: (key, input) => request('PUT', `/admin/v1/application/questions/builtin/${encodeURIComponent(key)}`, input),
    resetBuiltinQuestion: (key) => request('DELETE', `/admin/v1/application/questions/builtin/${encodeURIComponent(key)}`),
    createApplicationQuestion: (input) => request('POST', '/admin/v1/application/questions', input),
    updateApplicationQuestion: (questionId, changes) => request('PATCH', `/admin/v1/application/questions/${id(questionId)}`, changes),
    listAllTiers: () => request('GET', '/admin/v1/tiers/all'),
    createTier: (input) => request('POST', '/admin/v1/tiers', input),
    updateTier: (tierId, changes) => request('PATCH', `/admin/v1/tiers/${id(tierId)}`, changes),
    listPayments: () => request('GET', '/admin/v1/payments'),
    listMembers: () => request('GET', '/admin/v1/members'),
    setMemberStatus: (memberId, status) => request('POST', `/admin/v1/members/${id(memberId)}/status`, { status }),
    setMemberRole: (memberId, role, granted) => request('POST', `/admin/v1/members/${id(memberId)}/roles`, { role, granted }),
    listExperiences: () => request('GET', '/admin/v1/experiences'),
    createExperience: (input) => request('POST', '/admin/v1/experiences', input),
    updateExperience: (experienceId, changes) => request('PATCH', `/admin/v1/experiences/${id(experienceId)}`, changes),
    inviteMember: (experienceId, memberId) => request('POST', `/admin/v1/experiences/${id(experienceId)}/invitations`, { memberId }),
    listGuests: (experienceId) => request('GET', `/admin/v1/experiences/${id(experienceId)}/guests`),
    decideBooking: (bookingId, decision) => request('POST', `/admin/v1/bookings/${id(bookingId)}/decision`, { decision }),
    checkIn: (ticketCode) => request('POST', '/admin/v1/check-in', { ticketCode }),
    listBusinessListings: () => request('GET', '/admin/v1/business/listings'),
    reviewListing: (listingId, decision, note) => request('POST', `/admin/v1/business/listings/${id(listingId)}/review`, { decision, note }),
    editListing: (listingId, changes) => request('PATCH', `/admin/v1/business/listings/${id(listingId)}`, changes),
    listBusinessUpdates: () => request('GET', '/admin/v1/business/updates'),
    createBusinessUpdate: (input) => request('POST', '/admin/v1/business/updates', input),
    updateBusinessUpdate: (updateId, changes) => request('PATCH', `/admin/v1/business/updates/${id(updateId)}`, changes),
    deleteBusinessUpdate: (updateId) => request('DELETE', `/admin/v1/business/updates/${id(updateId)}`),
    listRmEnquiries: () => request('GET', '/admin/v1/business/enquiries'),
    replyToRmEnquiry: (enquiryId, body) => request('POST', `/admin/v1/business/enquiries/${id(enquiryId)}/reply`, { body }),
    closeRmEnquiry: (enquiryId) => request('POST', `/admin/v1/business/enquiries/${id(enquiryId)}/close`),
    listIntroductions: () => request('GET', '/admin/v1/business/introductions'),
    handleIntroduction: (introductionId, decision) => request('POST', `/admin/v1/business/introductions/${id(introductionId)}/handle`, { decision }),
    listProducts: () => request('GET', '/admin/v1/products'),
    createProduct: (input) => request('POST', '/admin/v1/products', input),
    updateProduct: (productId, changes) => request('PATCH', `/admin/v1/products/${id(productId)}`, changes),
    listOrders: () => request('GET', '/admin/v1/orders'),
    advanceOrder: (orderId, input) => request('POST', `/admin/v1/orders/${id(orderId)}/advance`, input ?? {}),
    addOrderNote: (orderId, note) => request('POST', `/admin/v1/orders/${id(orderId)}/notes`, { note }),
    cancelOrder: (orderId, reason) => request('POST', `/admin/v1/orders/${id(orderId)}/cancel`, { reason }),
    listDeliveryOptions: () => request('GET', '/admin/v1/delivery-options'),
    createDeliveryOption: (input) => request('POST', '/admin/v1/delivery-options', input),
    updateDeliveryOption: (optionId, changes) => request('PATCH', `/admin/v1/delivery-options/${id(optionId)}`, changes),
    uploadImage: (contentType, dataBase64) => request('POST', '/admin/v1/media', { contentType, dataBase64 }),
    uploadPhoto: (file, o = {}) => request('POST', '/admin/v1/photos' + queryString({ maxEdge: o.maxEdge?.toString(), quality: o.quality?.toString(), crop: o.crop ? [o.crop.x, o.crop.y, o.crop.width, o.crop.height].map((n) => n.toFixed(5)).join(',') : undefined }), file),
    listTvSeries: () => request('GET', '/admin/v1/tv/series'),
    createTvSeries: (input) => request('POST', '/admin/v1/tv/series', input),
    updateTvSeries: (seriesId, changes) => request('PATCH', `/admin/v1/tv/series/${id(seriesId)}`, changes),
    createTvEpisode: (seriesId, input) => request('POST', `/admin/v1/tv/series/${id(seriesId)}/episodes`, input),
    updateTvEpisode: (episodeId, changes) => request('PATCH', `/admin/v1/tv/episodes/${id(episodeId)}`, changes),
    listPartnerBookings: () => request('GET', '/admin/v1/partner-bookings'),
    settlePartnerBooking: (bookingId, answer, note) => request('POST', `/admin/v1/partner-bookings/${id(bookingId)}/settle`, { answer, note: note ?? '' }),
    listServices: () => request('GET', '/admin/v1/services'),
    createService: (input) => request('POST', '/admin/v1/services', input),
    updateService: (serviceId, changes) => request('PATCH', `/admin/v1/services/${id(serviceId)}`, changes),
    createServicePackage: (serviceId, input) => request('POST', `/admin/v1/services/${id(serviceId)}/packages`, input),
    updateServicePackage: (packageId, changes) => request('PATCH', `/admin/v1/service-packages/${id(packageId)}`, changes),
    deleteServicePackage: (packageId) => request('DELETE', `/admin/v1/service-packages/${id(packageId)}`),
    listServiceRequests: () => request('GET', '/admin/v1/service-requests'),
    setServiceRequestStatus: (requestId, status) => request('POST', `/admin/v1/service-requests/${id(requestId)}/status`, { status }),
    listHomeSlides: () => request('GET', '/admin/v1/home-slides'),
    createHomeSlide: (input) => request('POST', '/admin/v1/home-slides', input),
    updateHomeSlide: (slideId, changes) => request('PATCH', `/admin/v1/home-slides/${id(slideId)}`, changes),
    deleteHomeSlide: (slideId) => request('DELETE', `/admin/v1/home-slides/${id(slideId)}`),
    listPartners: () => request('GET', '/admin/v1/partners'),
    createPartner: (input) => request('POST', '/admin/v1/partners', input),
    updatePartner: (partnerId, changes) => request('PATCH', `/admin/v1/partners/${id(partnerId)}`, changes),
    createPrivilege: (partnerId, input) => request('POST', `/admin/v1/partners/${id(partnerId)}/privileges`, input),
    updatePrivilege: (privilegeId, changes) => request('PATCH', `/admin/v1/privileges/${id(privilegeId)}`, changes),
    listClosures: () => request('GET', '/admin/v1/account-closures'),
    eraseClosedAccount: (userId) => request('POST', `/admin/v1/account-closures/${id(userId)}/erase`),
    reinstateClosedAccount: (userId) => request('POST', `/admin/v1/account-closures/${id(userId)}/reinstate`),
    listReports: () => request('GET', '/admin/v1/reports'),
    resolveReport: (reportId, outcome) => request('POST', `/admin/v1/reports/${id(reportId)}/resolve`, { outcome }),
    getDashboard: () => request('GET', '/admin/v1/dashboard'),
    getInsights: (q = {}) => request('GET', `/admin/v1/insights${queryString(insightQuery(q))}`),
    insightsExportUrl: (q = {}) => `${options.baseUrl.replace(/\/$/, '')}/admin/v1/insights/export${queryString(insightQuery(q))}`,
    getReportSetting: () => request('GET', '/admin/v1/insights/report'),
    setReportSetting: (weeklyReport) => request('PUT', '/admin/v1/insights/report', { weeklyReport }),
    sendReportToMe: () => request('POST', '/admin/v1/insights/report/send'),
    listRenewals: () => request('GET', '/admin/v1/renewals'),
    retryRenewal: (memberId) => request('POST', `/admin/v1/renewals/${id(memberId)}/retry`),
    extendRenewal: (memberId, days, reason) => request('POST', `/admin/v1/renewals/${id(memberId)}/extend`, { days, reason }),
    listConciergeRequests: () => request('GET', '/admin/v1/concierge-requests'),
    getConciergeRequest: (requestId) => request('GET', `/admin/v1/concierge-requests/${id(requestId)}`),
    replyToConciergeRequest: (requestId, body) => request('POST', `/admin/v1/concierge-requests/${id(requestId)}/reply`, { body }),
    setConciergeStatus: (requestId, status) => request('POST', `/admin/v1/concierge-requests/${id(requestId)}/status`, { status }),
  };
}
