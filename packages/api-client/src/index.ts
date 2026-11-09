/**
 * The contract between the apps and the Quintara API.
 *
 * Web and mobile depend only on the `QuintaraApi` interface. Two implementations
 * exist: `createHttpApi` (the real REST API) and `createMockApi` (in-memory, used
 * until the API is deployed, and in tests). Swapping one for the other is a
 * one-line change in each app's provider.
 */
import type {
  AppNotification,
  ConciergeRequest,
  ConciergeRequestInput,
  Conversation,
  ConversationThread,
  Application,
  ApplicationQuestions,
  WhatsAppLink,
  WhatsAppLinkInput,
  MembershipPlan,
  ApplicationData,
  Booking,
  Experience,
  MemberProfile,
  ProfileUpdate,
  Role,
  Session, Market, SectionCopy, CalendarConnectInput, CalendarState, DailyBrief, GuestAccount, GuestAccountInput, QeraUsage, QeraMemory, QeraMemoryInput, QeraMemoryItem, QeraReminder, ReminderInput, WeeklyBrief, PlanBookingPreview, PlanBookingResult, BlockedMember, PartnerBooking, PartnerBookingView, QeraDocument, QeraDocumentSummary, HomeSlide, LifestyleService, ServiceRequest, ServiceRequestInput, BusinessListing, BusinessUpdate, RmEnquiry, RmEnquiryInput, Introduction, ListingInput, DeliveryOption, MemberReportInput, Order, OrderInput, Partner, Product, PrivacySettings, Redemption, TvSeries, MatchSuggestion, SearchResult, QeraThread, TwoFactorStatus, TwoFactorSetup, SecondStep, PushRegistration, PushSettings, PushSettingsInput, MembershipStatus } from '@quintara/domain';

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'network'
  | 'unknown';

/** Every failure from either implementation is an ApiError with a stable code. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Field-level messages for `validation` errors, keyed by field name. */
  readonly fields: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = fields;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('unknown', error instanceof Error ? error.message : 'Something went wrong');
}

export interface MemberQuery {
  search?: string;
  role?: Role;
}

export interface QuintaraApi {
  // Session
  getSession(): Promise<Session | null>;
  signIn(input: { email: string }): Promise<Session>;
  /** How people sign in here: `code` (a one-time code sent by email, in production) or `dev` (an email address alone). */
  getAuthConfig(): Promise<{ method: 'dev' | 'code' }>;
  /** Sends a sign-in code if the address may have one. Always succeeds, so addresses cannot be tested. */
  requestSignInCode(input: { email: string; purpose?: 'sign_in' | 'join' }): Promise<void>;
  /** Signs in with the code: a member, a guest account, or an applicant (neither). */
  verifySignInCode(input: { email: string; code: string }): Promise<{ session: Session | null; guest: GuestAccount | null; twoFactor?: SecondStep }>;
  signOut(): Promise<void>;
  /** Signs out of every device and app. */
  signOutEverywhere(): Promise<void>;

  // Two-factor authentication
  getTwoFactor(): Promise<TwoFactorStatus>;
  /** A new authenticator. To replace a working one, `code` is the current code from it. */
  startTwoFactorSetup(code?: string): Promise<TwoFactorSetup>;
  /** Confirms the new authenticator with its first code. The recovery codes are shown once. */
  confirmTwoFactor(code: string): Promise<{ recoveryCodes: string[] }>;
  /** The second step of a sign-in: a code from the authenticator, or a recovery code. */
  verifyTwoFactor(code: string): Promise<{ session: Session | null; guest: GuestAccount | null }>;
  newRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }>;
  /** Only where it is not required. */
  disableTwoFactor(code: string): Promise<void>;

  // Cities
  /** The cities that are open. */
  listMarkets(): Promise<Market[]>;
  /** The section descriptions staff have written, with the defaults for the rest. Open to everyone. */
  listSectionCopy(): Promise<SectionCopy[]>;
  /** Chooses the city being viewed, by its slug; null for the person's home city. Lists then show that city. */
  setMarket(slug: string | null): void;

  // Guest accounts: a personal account for someone who is not a member
  /** The signed-in guest account, or null (for visitors and for members). */
  getGuestAccount(): Promise<GuestAccount | null>;
  /** Creates a guest account and signs it in. */
  /** In production the code sent with purpose `join` comes too. */
  createGuestAccount(input: GuestAccountInput & { code?: string }): Promise<GuestAccount>;
  signInGuest(input: { email: string }): Promise<GuestAccount>;
  updateGuestAccount(input: { fullName: string }): Promise<GuestAccount>;
  exportGuestData(): Promise<Record<string, unknown>>;
  /** Erases the guest account at once and signs out. */
  deleteGuestAccount(): Promise<void>;

  // Experiences and bookings
  listExperiences(): Promise<Experience[]>;
  getExperience(id: string): Promise<Experience>;
  bookExperience(experienceId: string, seats: number): Promise<Booking>;
  listBookings(): Promise<Booking[]>;
  /** Pays for held seats and confirms the booking. */
  payBooking(bookingId: string): Promise<Booking>;
  /** Cancels; a paid booking is refunded in full while the experience's refund window is open. */
  cancelBooking(bookingId: string): Promise<Booking>;

  // Members
  listMembers(query?: MemberQuery): Promise<MemberProfile[]>;
  getMember(id: string): Promise<MemberProfile>;
  /** People to meet, with the reasons. Empty when the member has switched suggestions off. */
  listSuggestions(): Promise<MatchSuggestion[]>;
  /** Looks across everything the viewer is allowed to see. Open to guests. */
  search(query: string): Promise<SearchResult[]>;
  requestConnection(memberId: string): Promise<MemberProfile>;
  /** Hides each member from the other and ends any connection between them. */
  blockMember(memberId: string): Promise<void>;
  unblockMember(memberId: string): Promise<void>;
  listBlockedMembers(): Promise<BlockedMember[]>;
  /** Sends a concern to staff. The reported member is never told who sent it. */
  reportMember(memberId: string, input: MemberReportInput): Promise<void>;
  getMyProfile(): Promise<MemberProfile>;
  updateMyProfile(update: ProfileUpdate): Promise<MemberProfile>;

  // Business: listings and introductions made by the team
  listBusinessListings(): Promise<BusinessListing[]>;
  /** Submitted for review; it is not visible to others until the team publishes it. */
  createBusinessListing(input: ListingInput): Promise<BusinessListing>;
  closeBusinessListing(id: string): Promise<void>;
  listIntroductions(): Promise<Introduction[]>;
  requestIntroduction(listingId: string, note: string): Promise<Introduction>;
  respondToIntroduction(id: string, accept: boolean): Promise<Introduction>;
  withdrawIntroduction(id: string): Promise<void>;
  /** Opportunities published by Quintara, addressed to the member's roles or to everyone. */
  listBusinessUpdates(): Promise<BusinessUpdate[]>;
  /** The member's own conversations with the relationship manager. */
  listRmEnquiries(): Promise<RmEnquiry[]>;
  createRmEnquiry(input: RmEnquiryInput): Promise<RmEnquiry>;
  sendRmMessage(id: string, body: string): Promise<RmEnquiry>;
  closeRmEnquiry(id: string): Promise<void>;

  // Profile picture: a JPEG, PNG or WebP of up to 2 MB
  setMyAvatar(contentType: string, dataBase64: string): Promise<MemberProfile>;
  removeMyAvatar(): Promise<MemberProfile>;

  // Lifestyle services and the home page: open to visitors
  listHomeSlides(): Promise<HomeSlide[]>;
  listLifestyleServices(): Promise<LifestyleService[]>;
  /** One service with its directory details; the contact details are for members only. */
  getLifestyleService(serviceId: string): Promise<LifestyleService>;
  /** A request for the concierge desk to arrange, not a payment. A guest gives a name and email. */
  requestLifestyleService(serviceId: string, input: ServiceRequestInput): Promise<ServiceRequest>;
  listMyServiceRequests(): Promise<ServiceRequest[]>;
  cancelMyServiceRequest(id: string): Promise<void>;

  // Maison Quintara
  /** Open to visitors, who see the public shelves at public prices. */
  listProducts(): Promise<Product[]>;
  listDeliveryOptions(): Promise<DeliveryOption[]>;
  setWishlist(productId: string, wished: boolean): Promise<void>;
  /** Creates the order and sets its stock aside; it is confirmed when paid. */
  createOrder(input: OrderInput): Promise<Order>;
  payOrder(orderId: string): Promise<Order>;
  /** Possible until the order is being prepared. A paid order is refunded in full. */
  cancelOrder(orderId: string): Promise<Order>;
  listOrders(): Promise<Order[]>;

  // QÉRA, the assistant
  getQeraThread(): Promise<QeraThread>;

  // QÉRA as Chief of Staff
  /** What QÉRA remembers about the member, and what it offers to remember. */
  getQeraMemory(): Promise<QeraMemory>;
  addQeraMemory(input: QeraMemoryInput): Promise<QeraMemoryItem>;
  updateQeraMemory(id: string, input: QeraMemoryInput): Promise<QeraMemoryItem>;
  deleteQeraMemory(id: string): Promise<void>;
  /** Forgets everything QÉRA remembers. */
  clearQeraMemory(): Promise<void>;
  getWeeklyBrief(): Promise<WeeklyBrief>;
  /** QÉRA's daily brief: today in order, from the member's own calendar (if connected) and from Quintara. */
  getDailyBrief(): Promise<DailyBrief>;
  /** The member's calendar connection and the coming week's events. The calendar address is never returned. */
  getCalendar(): Promise<CalendarState>;
  /** Connects a calendar by its private address, with the member's consent. */
  connectCalendar(input: CalendarConnectInput): Promise<CalendarState>;
  /** Whether QÉRA may see what meetings are, or only that the time is taken. */
  updateCalendar(input: { showTitles: boolean }): Promise<CalendarState>;
  syncCalendar(): Promise<CalendarState>;
  /** Disconnects, and deletes the address and every event at once. */
  disconnectCalendar(): Promise<void>;
  /** QÉRA on WhatsApp: whether a number is linked, and the way to link one. Members and guest accounts. */
  getWhatsApp(): Promise<WhatsAppLink>;
  /** Gives a one-time code to send from WhatsApp. Needs the person's agreement. */
  linkWhatsApp(input: WhatsAppLinkInput): Promise<WhatsAppLink>;
  unlinkWhatsApp(): Promise<void>;
  listReminders(): Promise<QeraReminder[]>;
  createReminder(input: ReminderInput): Promise<QeraReminder>;
  cancelReminder(id: string): Promise<void>;
  /** What booking a prepared plan would do, line by line. Nothing is booked. */
  previewPlanBooking(documentId: string, partySize?: number): Promise<PlanBookingPreview>;
  /** Books the chosen lines of a plan, each with the usual checks. */
  bookPlan(documentId: string, input: { partySize: number; lines: number[] }): Promise<PlanBookingResult>;
  /** Sent every minute while the QÉRA screen is open. Counts a guest's daily time; null for members, who have no limit. */
  qeraHeartbeat(): Promise<QeraUsage | null>;
  /** QÉRA answers, or proposes one action for the member to confirm. It never acts without that confirmation. */
  sendQeraMessage(text: string): Promise<QeraThread>;
  confirmQeraProposal(id: string): Promise<QeraThread>;
  cancelQeraProposal(id: string): Promise<QeraThread>;
  clearQeraThread(): Promise<void>;
  /** Plans and itineraries QÉRA has prepared for the member. */
  listQeraDocuments(): Promise<QeraDocumentSummary[]>;
  getQeraDocument(id: string): Promise<QeraDocument>;
  deleteQeraDocument(id: string): Promise<void>;
  /** Bookings QÉRA has sent to partners for the member. */
  listPartnerBookings(): Promise<PartnerBooking[]>;
  cancelPartnerBooking(id: string): Promise<void>;
  /** The partner's side, reached with the link from their email. No sign-in. */
  getPartnerBookingByToken(token: string): Promise<PartnerBookingView>;
  respondToPartnerBooking(token: string, answer: 'confirm' | 'decline', note?: string): Promise<PartnerBookingView>;

  // Quintara TV
  /** Open to guests, who can watch public episodes. A locked episode carries no video address. */
  listTvSeries(): Promise<TvSeries[]>;
  /** Remembers where a member stopped watching. */
  saveTvProgress(episodeId: string, positionSeconds: number): Promise<void>;

  // Lifestyle partners and privileges
  listPartners(): Promise<Partner[]>;
  getPartner(id: string): Promise<Partner>;
  /** Issues a code to show the partner. Counts as one use. */
  redeemPrivilege(privilegeId: string): Promise<Redemption>;
  listMyRedemptions(): Promise<Redemption[]>;

  // Privacy: the member's own data
  getPrivacySettings(): Promise<PrivacySettings>;
  updatePrivacySettings(settings: PrivacySettings): Promise<PrivacySettings>;
  /** A copy of everything held about the member. */
  exportMyData(): Promise<Record<string, unknown>>;
  /** Ends the membership and signs out everywhere. `confirm` must be the word CLOSE. */
  closeMyAccount(confirm: string): Promise<{ eraseAfter: string }>;

  // Membership application
  getApplication(): Promise<Application | null>;
  saveApplicationDraft(data: ApplicationData): Promise<Application>;
  submitApplication(data: ApplicationData): Promise<Application>;
  /** The memberships an applicant can apply for in the current city. */
  listMembershipPlans(): Promise<MembershipPlan[]>;
  /** The questions on the application: the built-in ones as staff have worded them, and the questions staff added. */
  getApplicationQuestions(): Promise<ApplicationQuestions>;
  /** Pays the fee for an approved application and activates the membership. */
  payMembershipFee(): Promise<Application>;

  // Concierge
  listConciergeRequests(): Promise<ConciergeRequest[]>;
  getConciergeRequest(id: string): Promise<ConciergeRequest>;
  createConciergeRequest(input: ConciergeRequestInput): Promise<ConciergeRequest>;
  sendConciergeMessage(id: string, body: string): Promise<ConciergeRequest>;
  /** Accepts the options the desk has offered. */
  confirmConciergeRequest(id: string): Promise<ConciergeRequest>;
  cancelConciergeRequest(id: string): Promise<ConciergeRequest>;

  // Messaging between connected members
  listConversations(): Promise<Conversation[]>;
  getConversation(memberId: string): Promise<ConversationThread>;
  sendMessage(memberId: string, body: string): Promise<ConversationThread>;
  markConversationRead(memberId: string): Promise<void>;

  // Notifications
  listNotifications(): Promise<AppNotification[]>;
  markNotificationRead(id: string): Promise<void>;

  // Push notifications to this phone
  /** Registers this phone's Expo push token with the session that is signed in. */
  registerPushDevice(input: PushRegistration): Promise<{ id: string }>;
  /** Removes this phone's token (on signing out, or when push is turned off on the phone). */
  unregisterPushDevice(token: string): Promise<void>;
  /** Removes one of the person's phones from their list. */
  removePushDevice(id: string): Promise<void>;
  getPushSettings(): Promise<PushSettings>;
  updatePushSettings(input: PushSettingsInput): Promise<PushSettings>;
  /** Sends a test notification to the person's own phones. */
  sendTestPush(): Promise<void>;

  // Membership: term, renewal and the saved card. Open to a lapsed member, so they can renew.
  getMembership(): Promise<MembershipStatus>;
  /** The payment provider, and whether the test cards are offered (only while payments are the stand-in). */
  getPaymentConfig(): Promise<{ provider: string; testCards: boolean }>;
  /** Saves the card from the payment provider's secure form, by its one-time setup token. */
  saveCard(setupToken: string): Promise<MembershipStatus>;
  removeCard(): Promise<MembershipStatus>;
  setAutoRenew(autoRenew: boolean): Promise<MembershipStatus>;
  /** Renews now with the saved card. `idempotencyKey` makes a repeated tap charge once. */
  renewMembership(idempotencyKey: string): Promise<MembershipStatus>;
}

export { createMockApi } from './mock.ts';
export type { MockApiOptions, KeyValueStore } from './mock.ts';
export { createHttpApi } from './http.ts';
export { createAdminApi } from './admin.ts';
export type { AdminApi, StaffAccount, AuditEntry, AuditFilters, AuditCheck, StaffOrder, UploadedPhoto, PhotoUploadOptions, StaffTvSeries, StaffTvEpisode, StaffDeliveryOption, StaffProduct, StaffIntroduction, StaffBusinessUpdate, StaffRmEnquiry, StaffService, StaffServicePackage, StaffServiceRequest, StaffMarket, StaffHomeSlide, StaffPartnerBooking, StaffPartner, StaffPrivilege, StaffClosure, BillingPeriod, StaffPayment, StaffTierDetail, TierInput, StaffInsights, StaffDashboard, StaffRenewal, InsightQuery, InsightPeriod, InsightRange, StaffReport, ExperienceInput, Guest, StaffApplication, StaffConciergeRequest, StaffExperience, StaffMember, StaffSession, StaffTier } from './admin.ts';
export type { HttpApiOptions } from './http.ts';
