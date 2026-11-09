/**
 * REST implementation of QuintaraApi, plus the request helper the admin client shares.
 * Set NEXT_PUBLIC_API_URL / EXPO_PUBLIC_API_URL to switch an app from the mock to this client.
 */
import { ApiError } from './index.ts';
import type { ApiErrorCode, QuintaraApi } from './index.ts';

export interface HttpApiOptions {
  baseUrl: string;
  /**
   * Returns a bearer token, or null. The web apps leave this out and rely on
   * the HttpOnly session cookie; the mobile app supplies a token from the keychain.
   */
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** The city being viewed (a market slug), sent with every request. */
  getMarket?: () => string | null;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'validation',
  401: 'unauthenticated',
  402: 'conflict',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation',
};

const isFile = (body: unknown): body is Blob => typeof Blob !== 'undefined' && body instanceof Blob;

export type Requester = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** One place that knows how to call the API and turn any failure into an ApiError. */
export function createRequester(options: HttpApiOptions): Requester {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  return async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    let response: Response;
    try {
      response = await doFetch(base + path, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          // A file (a photograph) is sent as it is, with its own type; anything else as JSON.
          ...(body === undefined ? {} : { 'Content-Type': isFile(body) ? body.type || 'application/octet-stream' : 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.getMarket?.() ? { 'x-quintara-market': options.getMarket()! } : {}),
          // Bookings and payments are retried safely: the server de-duplicates on this key.
          ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
        },
        body: body === undefined ? undefined : isFile(body) ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('network', 'Quintara could not be reached. Check your connection and try again.');
    }
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = (payload ?? {}) as { message?: string; fields?: Record<string, string> };
      throw new ApiError(STATUS_CODES[response.status] ?? 'unknown', problem.message ?? 'Something went wrong', problem.fields);
    }
    return payload as T;
  };
}

export const queryString = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
};

export function createHttpApi(options: HttpApiOptions): QuintaraApi {
  // The city chosen in the app wins over one supplied by the host; null means the person's home city.
  let market: string | null = null;
  const request = createRequester({ ...options, getMarket: () => market ?? options.getMarket?.() ?? null });
  const id = encodeURIComponent;

  return {
    getSession: () => request('GET', '/v1/session'),
    listMarkets: () => request('GET', '/v1/markets'),
    listSectionCopy: () => request('GET', '/v1/content/sections'),
    setMarket: (slug) => { market = slug; },
    signIn: (input) => request('POST', '/v1/session', input),
    getAuthConfig: () => request('GET', '/v1/auth/config'),
    requestSignInCode: async (input) => { await request('POST', '/v1/auth/code', { purpose: 'sign_in', ...input }); },
    verifySignInCode: (input) => request('POST', '/v1/auth/verify', input),
    signOut: () => request('DELETE', '/v1/session'),
    signOutEverywhere: () => request('DELETE', '/v1/sessions'),
    getTwoFactor: () => request('GET', '/v1/auth/2fa'),
    startTwoFactorSetup: (code) => request('POST', '/v1/auth/2fa/setup', code ? { code } : {}),
    confirmTwoFactor: (code) => request('POST', '/v1/auth/2fa/confirm', { code }),
    verifyTwoFactor: (code) => request('POST', '/v1/auth/2fa/verify', { code }),
    newRecoveryCodes: (code) => request('POST', '/v1/auth/2fa/recovery-codes', { code }),
    disableTwoFactor: async (code) => { await request('POST', '/v1/auth/2fa/disable', { code }); },
    getGuestAccount: () => request('GET', '/v1/guest/account'),
    createGuestAccount: (input) => request('POST', '/v1/guest/account', input),
    signInGuest: (input) => request('POST', '/v1/guest/session', input),
    updateGuestAccount: (input) => request('PATCH', '/v1/guest/account', input),
    exportGuestData: () => request('GET', '/v1/guest/data-export'),
    deleteGuestAccount: () => request('DELETE', '/v1/guest/account'),
    listExperiences: () => request('GET', '/v1/experiences'),
    getExperience: (experienceId) => request('GET', `/v1/experiences/${id(experienceId)}`),
    bookExperience: (experienceId, seats) => request('POST', `/v1/experiences/${id(experienceId)}/bookings`, { seats }),
    listBookings: () => request('GET', '/v1/me/bookings'),
    payBooking: (bookingId) => request('POST', `/v1/me/bookings/${id(bookingId)}/pay`),
    cancelBooking: (bookingId) => request('POST', `/v1/me/bookings/${id(bookingId)}/cancel`),
    listMembers: (q = {}) => request('GET', '/v1/members' + queryString({ search: q.search, role: q.role })),
    listSuggestions: () => request('GET', '/v1/me/suggestions'),
    search: (query) => request('GET', '/v1/search' + queryString({ q: query })),
    getMember: (memberId) => request('GET', `/v1/members/${id(memberId)}`),
    requestConnection: (memberId) => request('POST', `/v1/members/${id(memberId)}/connection`),
    blockMember: (memberId) => request('PUT', `/v1/members/${id(memberId)}/block`),
    unblockMember: (memberId) => request('DELETE', `/v1/members/${id(memberId)}/block`),
    listBlockedMembers: () => request('GET', '/v1/me/blocks'),
    reportMember: (memberId, input) => request('POST', `/v1/members/${id(memberId)}/reports`, input),
    getMyProfile: () => request('GET', '/v1/me/profile'),
    updateMyProfile: (update) => request('PATCH', '/v1/me/profile', update),
    listBusinessListings: () => request('GET', '/v1/business/listings'),
    createBusinessListing: (input) => request('POST', '/v1/business/listings', input),
    closeBusinessListing: (listingId) => request('POST', `/v1/business/listings/${id(listingId)}/close`),
    listIntroductions: () => request('GET', '/v1/me/introductions'),
    requestIntroduction: (listingId, note) => request('POST', '/v1/me/introductions', { listingId, note }),
    respondToIntroduction: (introductionId, accept) => request('POST', `/v1/me/introductions/${id(introductionId)}/respond`, { accept }),
    withdrawIntroduction: (introductionId) => request('POST', `/v1/me/introductions/${id(introductionId)}/withdraw`),
    listBusinessUpdates: () => request('GET', '/v1/business/updates'),
    listRmEnquiries: () => request('GET', '/v1/me/relationship-manager'),
    createRmEnquiry: (input) => request('POST', '/v1/me/relationship-manager', input),
    sendRmMessage: (enquiryId, body) => request('POST', `/v1/me/relationship-manager/${id(enquiryId)}/messages`, { body }),
    closeRmEnquiry: (enquiryId) => request('POST', `/v1/me/relationship-manager/${id(enquiryId)}/close`),
    setMyAvatar: (contentType, dataBase64) => request('PUT', '/v1/me/avatar', { contentType, dataBase64 }),
    removeMyAvatar: () => request('DELETE', '/v1/me/avatar'),
    listHomeSlides: () => request('GET', '/v1/home/slides'),
    listLifestyleServices: () => request('GET', '/v1/lifestyle/services'),
    getLifestyleService: (serviceId) => request('GET', `/v1/lifestyle/services/${id(serviceId)}`),
    requestLifestyleService: (serviceId, input) => request('POST', `/v1/lifestyle/services/${id(serviceId)}/requests`, input),
    listMyServiceRequests: () => request('GET', '/v1/me/service-requests'),
    cancelMyServiceRequest: (requestId) => request('POST', `/v1/me/service-requests/${id(requestId)}/cancel`),
    listProducts: () => request('GET', '/v1/boutique/products'),
    listDeliveryOptions: () => request('GET', '/v1/boutique/delivery-options'),
    setWishlist: (productId, wished) => request('PUT', `/v1/boutique/products/${id(productId)}/wishlist`, { wished }),
    createOrder: (input) => request('POST', '/v1/boutique/orders', input),
    payOrder: (orderId) => request('POST', `/v1/boutique/orders/${id(orderId)}/pay`),
    cancelOrder: (orderId) => request('POST', `/v1/boutique/orders/${id(orderId)}/cancel`),
    listOrders: () => request('GET', '/v1/boutique/orders'),
    getQeraThread: () => request('GET', '/v1/qera'),
    qeraHeartbeat: () => request('POST', '/v1/qera/heartbeat'),
    getQeraMemory: () => request('GET', '/v1/qera/memory'),
    addQeraMemory: (input) => request('POST', '/v1/qera/memory', input),
    updateQeraMemory: (id, input) => request('PUT', `/v1/qera/memory/${encodeURIComponent(id)}`, input),
    deleteQeraMemory: (id) => request('DELETE', `/v1/qera/memory/${encodeURIComponent(id)}`),
    clearQeraMemory: () => request('DELETE', '/v1/qera/memory'),
    getWeeklyBrief: () => request('GET', '/v1/qera/brief'),
    getDailyBrief: () => request('GET', '/v1/qera/brief/today'),
    getCalendar: () => request('GET', '/v1/me/calendar'),
    connectCalendar: (input) => request('PUT', '/v1/me/calendar', input),
    updateCalendar: (input) => request('PATCH', '/v1/me/calendar', input),
    syncCalendar: () => request('POST', '/v1/me/calendar/sync'),
    disconnectCalendar: () => request('DELETE', '/v1/me/calendar'),
    getWhatsApp: () => request('GET', '/v1/me/whatsapp'),
    linkWhatsApp: (input) => request('POST', '/v1/me/whatsapp', input),
    unlinkWhatsApp: () => request('DELETE', '/v1/me/whatsapp'),
    listReminders: () => request('GET', '/v1/qera/reminders'),
    createReminder: (input) => request('POST', '/v1/qera/reminders', input),
    cancelReminder: (id) => request('POST', `/v1/qera/reminders/${encodeURIComponent(id)}/cancel`),
    previewPlanBooking: (documentId, partySize) => request('GET', `/v1/qera/documents/${encodeURIComponent(documentId)}/booking${partySize ? `?partySize=${partySize}` : ''}`),
    bookPlan: (documentId, input) => request('POST', `/v1/qera/documents/${encodeURIComponent(documentId)}/booking`, input),
    sendQeraMessage: (text) => request('POST', '/v1/qera/messages', { text }),
    confirmQeraProposal: (proposalId) => request('POST', `/v1/qera/proposals/${id(proposalId)}/confirm`),
    cancelQeraProposal: (proposalId) => request('POST', `/v1/qera/proposals/${id(proposalId)}/cancel`),
    clearQeraThread: () => request('DELETE', '/v1/qera'),
    listQeraDocuments: () => request('GET', '/v1/qera/documents'),
    getQeraDocument: (documentId) => request('GET', `/v1/qera/documents/${id(documentId)}`),
    deleteQeraDocument: (documentId) => request('DELETE', `/v1/qera/documents/${id(documentId)}`),
    listPartnerBookings: () => request('GET', '/v1/me/partner-bookings'),
    cancelPartnerBooking: (bookingId) => request('POST', `/v1/me/partner-bookings/${id(bookingId)}/cancel`),
    getPartnerBookingByToken: (token) => request('GET', `/v1/partner-bookings/${id(token)}`),
    respondToPartnerBooking: (token, answer, note) => request('POST', `/v1/partner-bookings/${id(token)}`, { answer, note: note ?? '' }),
    listTvSeries: () => request('GET', '/v1/tv/series'),
    saveTvProgress: (episodeId, positionSeconds) => request('PUT', `/v1/tv/episodes/${id(episodeId)}/progress`, { positionSeconds }),
    listPartners: () => request('GET', '/v1/partners'),
    getPartner: (partnerId) => request('GET', `/v1/partners/${id(partnerId)}`),
    redeemPrivilege: (privilegeId) => request('POST', `/v1/privileges/${id(privilegeId)}/redemptions`),
    listMyRedemptions: () => request('GET', '/v1/me/redemptions'),
    getPrivacySettings: () => request('GET', '/v1/me/privacy'),
    updatePrivacySettings: (settings) => request('PUT', '/v1/me/privacy', settings),
    exportMyData: () => request('GET', '/v1/me/data-export'),
    closeMyAccount: (confirm) => request('POST', '/v1/me/account/close', { confirm }),
    getApplication: () => request('GET', '/v1/me/application'),
    saveApplicationDraft: (data) => request('PUT', '/v1/me/application', data),
    submitApplication: (data) => request('POST', '/v1/me/application/submit', data),
    listMembershipPlans: () => request('GET', '/v1/application/plans'),
    getApplicationQuestions: () => request('GET', '/v1/application/questions'),
    payMembershipFee: () => request('POST', '/v1/me/application/pay'),
    listConciergeRequests: () => request('GET', '/v1/me/concierge-requests'),
    getConciergeRequest: (requestId) => request('GET', `/v1/me/concierge-requests/${id(requestId)}`),
    createConciergeRequest: (input) => request('POST', '/v1/me/concierge-requests', input),
    sendConciergeMessage: (requestId, body) => request('POST', `/v1/me/concierge-requests/${id(requestId)}/messages`, { body }),
    confirmConciergeRequest: (requestId) => request('POST', `/v1/me/concierge-requests/${id(requestId)}/confirm`),
    cancelConciergeRequest: (requestId) => request('POST', `/v1/me/concierge-requests/${id(requestId)}/cancel`),
    listConversations: () => request('GET', '/v1/me/conversations'),
    getConversation: (memberId) => request('GET', `/v1/me/conversations/${id(memberId)}`),
    sendMessage: (memberId, body) => request('POST', `/v1/me/conversations/${id(memberId)}/messages`, { body }),
    markConversationRead: (memberId) => request('POST', `/v1/me/conversations/${id(memberId)}/read`),
    listNotifications: () => request('GET', '/v1/me/notifications'),
    markNotificationRead: (notificationId) => request('POST', `/v1/me/notifications/${id(notificationId)}/read`),
    registerPushDevice: (input) => request('PUT', '/v1/me/push/device', input),
    unregisterPushDevice: async (token) => { await request('POST', '/v1/me/push/device/remove', { token }); },
    removePushDevice: async (deviceId) => { await request('DELETE', `/v1/me/push/devices/${id(deviceId)}`); },
    getPushSettings: () => request('GET', '/v1/me/push'),
    updatePushSettings: (input) => request('PUT', '/v1/me/push', input),
    sendTestPush: async () => { await request('POST', '/v1/me/push/test'); },
    getMembership: () => request('GET', '/v1/me/membership'),
    getPaymentConfig: () => request('GET', '/v1/payments/config'),
    startCheckout: (input) => request('POST', '/v1/payments/checkout', input),
    getCheckout: (paymentId) => request('GET', `/v1/payments/checkout/${encodeURIComponent(paymentId)}`),
    saveCard: (setupToken) => request('PUT', '/v1/me/membership/card', { setupToken }),
    removeCard: () => request('DELETE', '/v1/me/membership/card'),
    setAutoRenew: (autoRenew) => request('PUT', '/v1/me/membership/auto-renew', { autoRenew }),
    renewMembership: (idempotencyKey) => request('POST', '/v1/me/membership/renew', { idempotencyKey }),
  };
}
