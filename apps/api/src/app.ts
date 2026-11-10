/**
 * The HTTP surface: one route per call in the QuintaraApi contract.
 * Routes stay thin: they build the request context, call a module function, and shape the reply.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as admin from './admin.ts';
import * as applications from './applications.ts';
import * as boutique from './boutique.ts';
import * as business from './business.ts';
import * as relationship from './relationship.ts';
import * as concierge from './concierge.ts';
import { audit, hashToken, loadContext, loadGuest, loadMembership, loadStaffRoles, revokeAllSessions, revokeSession, SESSION_COOKIE, STAFF_COOKIE, STAFF_SESSION_HOURS } from './context.ts';
import type { SessionKind } from './context.ts';
import * as twoFactor from './two-factor.ts';
import * as staffAccounts from './staff.ts';
import { requestInfo } from './context.ts';
import type { TwoFactorConfig } from './two-factor.ts';
import type { RequestContext } from './context.ts';
import type { Db } from './db.ts';
import { HttpError } from './errors.ts';
import * as experiences from './experiences.ts';
import * as media from './media.ts';
import * as lifestyle from './lifestyle.ts';
import * as members from './members.ts';
import * as messaging from './messaging.ts';
import { payMembershipFee } from './membership.ts';
import * as qera from './qera.ts';
import { search } from './search.ts';
import * as notifications from './notifications.ts';
import * as push from './push.ts';
import * as renewals from './renewals.ts';
import * as insights from './insights.ts';
import { getDashboard } from './dashboard.ts';
import { MemoryRateLimiter } from './ratelimit.ts';
import type { ObjectStore } from './objects.ts';
import type { RateLimiter } from './ratelimit.ts';
import * as checkout from './checkout.ts';
import * as cancellations from './cancellations.ts';
import { TestCheckoutProvider } from './payments.ts';
import * as partners from './partners.ts';
import { deliverEmails } from './email.ts';
import * as partnerBookings from './partner-bookings.ts';
import * as guests from './guests.ts';
import * as markets from './markets.ts';
import * as content from './content.ts';
import { formatMoney, MARKET_HEADER } from '@quintara/domain';
import * as chief from './chief.ts';
import type { EmailProvider } from './email.ts';
import { RuleBasedQeraModel } from '@quintara/domain';
import type { QeraModel } from '@quintara/domain';
import * as privacy from './privacy.ts';
import type { PaymentProvider } from './payments.ts';
import * as tv from './tv.ts';
import * as calendar from './calendar.ts';
import type { CalendarConfig } from './calendar.ts';
import { getDailyBrief } from './daily.ts';
import * as form from './application-form.ts';
import * as whatsapp from './whatsapp.ts';
import type { WhatsAppConfig } from './whatsapp.ts';
import * as auth from './auth.ts';
import type { AuthMethod, ReviewAccount } from './auth.ts';

export interface AppConfig {
  /** The origins of the web app and the admin app: the only ones allowed to call with credentials. */
  webOrigins: string[];
  /**
   * `code`: sign in with a one-time code sent by email (production). `dev`: an email address alone signs in,
   * for development and tests only; the code routes work in both.
   */
  authMode: AuthMethod;
  /** App store review: one address that signs in with a fixed code, as reviewers cannot receive email. */
  reviewAccount?: ReviewAccount | null;
  /** Send cookies only over HTTPS. True everywhere except local development. */
  secureCookies: boolean;
  payments: PaymentProvider;
  email: EmailProvider;
  /** Push notifications to phones. Without one, notifications appear in the apps and by email only. */
  push?: push.PushProvider;
  /** Where links in emails point: the address of the web app. */
  webUrl: string;
  /** Sign-in attempts allowed per address per minute. */
  /** Where rate limits are counted: in this process by default; Redis (RedisRateLimiter) when several API processes run. */
  rateLimiter?: RateLimiter;
  /** Object storage for photographs (S3-compatible). Without it, photographs are kept in the database. */
  objects?: ObjectStore;
  signInLimit?: number;
  /** The language model behind QÉRA. Defaults to the built-in rule-based stand-in. */
  qeraModel?: QeraModel;
  /** Messages to QÉRA allowed per member per minute. */
  qeraLimit?: number;
  /** First orders by guests allowed per address per minute. */
  guestOrderLimit?: number;
  /** Booking requests a guest connection may send per minute. */
  guestRequestLimit?: number;
  /** Seconds of QÉRA a guest account may use each day. Five hours unless a test sets it. */
  guestQeraSeconds?: number;
  /**
   * Members' calendars. `secret` encrypts the calendar addresses members give (CALENDAR_SECRET); without it only the
   * sample calendar can be connected. `fetcher` reads a calendar file (replaced in tests).
   */
  calendar?: Partial<CalendarConfig>;
  /** QÉRA on WhatsApp. Null or absent: not set up, and the apps say so. */
  whatsapp?: WhatsAppConfig | null;
  /**
   * Two-factor authentication. `required` in production: every account with an email address sets up an
   * authenticator app. Defaults to `optional` (those who set one up are asked for it) with a development key.
   */
  twoFactor?: Partial<TwoFactorConfig>;
  /** Admin console accounts that can be active at once. Five unless set (STAFF_SEATS). */
  staffSeats?: number;
  /** The admin console's address, for the email to a new member of staff. */
  adminUrl?: string;
  /** Behind a load balancer or proxy: trust its X-Forwarded-For, so limits apply to the real address. */
  trustProxy?: boolean | string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
    sessionToken: string | undefined;
  }
  interface FastifyInstance {
    /** Sends any queued email now and waits for it. */
    flushEmails(): Promise<void>;
    /** Waits until every WhatsApp delivery received so far has been handled. */
    flushWhatsApp(): Promise<void>;
  }
}

export async function buildApp(db: Db, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    // Logs never carry query values (the WhatsApp verify token, a partner link token), cookies or authorisation headers.
    logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], serializers: { req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.replace(/\?.*$/, (q) => (q.length > 1 ? '?…' : '')).replace(/\/(partner-bookings|calendar)\/[^/?]+/, '/$1/…'), ip: req.ip }) } } : false,
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy ?? false,
    requestTimeout: 60_000,
    maxParamLength: 200,
    return503OnClosing: true,
  });
  // Only JSON (and, on their own routes, images and the signed webhook) are accepted. A browser can send text/plain
  // from any site without asking first, so it is not accepted at all.
  app.removeContentTypeParser('text/plain');
  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  const defaultMarket = async () => {
    const rows = await db.query<{ id: string }>('SELECT id FROM markets WHERE is_active ORDER BY created_at LIMIT 1');
    if (!rows[0]) throw new HttpError(503, 'Quintara is not open in any market yet.');
    return rows[0].id;
  };

  const mfa: TwoFactorConfig = {
    policy: config.twoFactor?.policy ?? 'optional',
    key: config.twoFactor?.key ?? 'development-only-two-factor-key-do-not-use',
    issuer: config.twoFactor?.issuer ?? 'Quintara',
    review: config.twoFactor?.review ?? null,
  };
  const secondStepRule = { required: mfa.policy === 'required', reviewEmail: mfa.review?.email ?? null };

  // App sessions: 30 days, sent everywhere. Staff sessions: their own cookie, sent only to /admin, strict, 12 hours.
  const setSessionCookie = (reply: FastifyReply, token: string, kind: SessionKind = 'app') => kind === 'staff'
    ? reply.setCookie(STAFF_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/admin', maxAge: 60 * 60 * STAFF_SESSION_HOURS })
    : reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: 60 * 60 * 24 * 30 });
  const isStaffRoute = (url: string) => url.startsWith('/admin/');

  // Every response: no sniffing, no framing, no referrer, HTTPS only in production, and nothing personal cached.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'no-referrer')
      .header('cross-origin-opener-policy', 'same-origin').header('x-permitted-cross-domain-policies', 'none');
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
    // The test checkout's page (development and staging) needs its own inline styles; it runs no script.
    const csp = request.url.startsWith('/v1/payments/test-checkout/') ? "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'";
    if (!request.url.startsWith('/v1/media/')) reply.header('cache-control', 'no-store').header('content-security-policy', csp);
    return payload;
  });

  // Cross-site request forgery: a request that changes something and carries a session must come from a Quintara app.
  // Browsers always send Origin on such requests; the native mobile app and server-to-server calls send none.
  const allowedOrigins = new Set(config.webOrigins);
  app.addHook('onRequest', async (request) => {
    // Every audit entry made while answering this request records where it came from.
    requestInfo.enterWith({ ip: request.ip, userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200) });
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    if (request.url.startsWith('/v1/whatsapp/webhook')) return;   // signed by Meta, checked on its own route
    if (request.url.startsWith('/v1/payments/webhook')) return;   // signed by the payment provider, checked on its own route
    const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
    if (origin && origin !== 'null' && !allowedOrigins.has(origin)) throw new HttpError(403, 'This request did not come from a Quintara app.');
    if ((origin === 'null' || site === 'cross-site') && (request.cookies?.[SESSION_COOKIE] || request.cookies?.[STAFF_COOKIE])) throw new HttpError(403, 'This request did not come from a Quintara app.');
  });

  app.decorateRequest('sessionToken', undefined);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    // The health probes carry no session and must not depend on one: liveness never touches the database.
    if (request.url === '/health' || request.url === '/ready') return;
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    const staff = isStaffRoute(request.url);
    request.sessionToken = (staff ? request.cookies[STAFF_COOKIE] : request.cookies[SESSION_COOKIE]) ?? bearer;
    request.ctx = await loadContext(db, request.sessionToken, staff ? 'staff' : 'app', secondStepRule);
    const asked = request.headers[MARKET_HEADER];
    request.ctx.marketId = await markets.resolveMarket(db, request.ctx, typeof asked === 'string' ? asked.slice(0, 80) : undefined);
  });

  // Every request by a member of staff to the console is kept in the staff activity log, once answered.
  app.addHook('onResponse', async (request, reply) => {
    if (!isStaffRoute(request.url) || !request.ctx?.userId || !request.ctx.staffRoles.length || request.method === 'OPTIONS') return;
    // The console's own housekeeping reads (who is signed in, the list of cities) say nothing about what was looked at.
    if (request.method === 'GET' && /^\/admin\/v1\/(session|auth\/2fa|markets|content\/sections)(\?|$)/.test(request.url)) return;
    const params = request.params as Record<string, string> | undefined;
    await staffAccounts.recordActivity(db, { userId: request.ctx.userId, method: request.method, route: request.routeOptions.url ?? request.url.replace(/\?.*$/, ''), targetId: params?.id ?? params?.key ?? null, status: reply.statusCode, ip: request.ip, userAgent: String(request.headers['user-agent'] ?? '') }).catch((error) => request.log.error(error));
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ message: error.message, fields: error.fields });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ message: 'That request could not be read.', fields: {} });
    request.log.error(error);
    // Never leak internals: the detail goes to the log, not the client.
    return reply.status(500).send({ message: 'Something went wrong on our side. Please try again.', fields: {} });
  });

  // Liveness: the process answers. Readiness: it can also reach the database (for load balancers and deploys).
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true, database: 'ok' };
    } catch {
      reply.code(503);
      return { ok: false, database: 'unreachable' };
    }
  });

  // Email goes out after the reply has been sent, so mail never slows a request down.
  let delivering: Promise<unknown> | null = null;
  const flushEmails = () => (delivering ??= deliverEmails(db, config.email, config.webUrl).then(() => partnerBookings.deliverPartnerBookings(db, config.email, config.webUrl)).catch((error) => app.log.error(error)).finally(() => { delivering = null; }));
  app.decorate('flushEmails', async () => { await delivering; await flushEmails(); });
  app.addHook('onResponse', async (request) => { if (request.method !== 'GET') void flushEmails(); });
  app.addHook('onClose', async () => { await delivering; });

  // Rate limits (ratelimit.ts): counted in this process, or in Redis when the API runs as several processes.
  const rateLimiter = config.rateLimiter ?? new MemoryRateLimiter();
  app.addHook('onClose', async () => { if (!config.rateLimiter) await rateLimiter.close?.(); });
  /** Throws 429 with `message` once `key` has used up `max` attempts this minute. */
  const limit = async (bucket: string, key: string, max: number, message = 'Too many attempts. Please wait a minute and try again.') => {
    if ((await rateLimiter.hit(bucket, key)) > max) throw new HttpError(429, message);
  };
  const limitSignIn = (request: FastifyRequest) => limit('sign-in', request.ip, config.signInLimit ?? 10);
  const emailFrom = (request: FastifyRequest) => {
    const email = String((request.body as { email?: unknown } | null)?.email ?? '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(422, 'Enter a valid email address.', { email: 'Enter a valid email address' });
    return email;
  };

  /* ---------- Cities ---------- */
  app.get('/v1/markets', () => markets.listOpenMarkets(db));
  // Section descriptions: read by everyone, written by staff.
  app.get('/v1/content/sections', () => content.listSections(db));
  app.get('/admin/v1/content/sections', (request) => content.listSectionsForStaff(db, request.ctx));
  app.put<{ Params: { key: string } }>('/admin/v1/content/sections/:key', (request) => content.updateSection(db, request.ctx, request.params.key, request.body));
  app.delete<{ Params: { key: string } }>('/admin/v1/content/sections/:key', (request) => content.resetSection(db, request.ctx, request.params.key));
  app.get('/admin/v1/markets', (request) => markets.listMarketsForStaff(db, request.ctx));
  app.post('/admin/v1/markets', (request) => markets.createMarket(db, request.ctx, request.body));
  app.patch<{ Params: { id: string } }>('/admin/v1/markets/:id', (request) => markets.setMarketOpen(db, request.ctx, request.params.id, request.body));

  /* ---------- Sign-in by one-time code ---------- */
  app.get('/v1/auth/config', async () => ({ method: config.authMode }));
  // The same answer whether or not the address has an account.
  app.post('/v1/auth/code', async (request, reply) => {
    await limitSignIn(request);
    const email = auth.readEmail(request.body);
    const asked = (request.body as { purpose?: unknown } | null)?.purpose;
    const purpose: auth.CodePurpose = asked === 'join' || asked === 'staff' ? asked : 'sign_in';
    // A mail service that is down is logged; the answer stays the same, and the person can ask again.
    try { await auth.requestCode(db, config.email, config.reviewAccount, email, purpose); } catch (error) { request.log.error(error); }
    return reply.status(202).send({ sent: true, minutes: auth.CODE_MINUTES });
  });
  // Members, guest accounts and applicants. Staff use the admin console's own sign-in.
  app.post('/v1/auth/verify', async (request, reply) => {
    await limitSignIn(request);
    const email = auth.readEmail(request.body), code = auth.readCode(request.body);
    if (!(await auth.checkCode(db, config.reviewAccount, email, code, 'sign_in'))) throw new HttpError(401, auth.WRONG_CODE);
    const user = (await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND status IN ('active', 'pending') AND deleted_at IS NULL`, [email]))[0];
    if (!user) throw new HttpError(401, auth.WRONG_CODE);
    const { token, state } = await twoFactor.startSession(db, mfa, user.id);
    setSessionCookie(reply, token);
    const ctx = await loadContext(db, token, 'app', secondStepRule);
    await audit(db, user.id, state === 'complete' ? 'auth.signed_in' : 'auth.email_code_accepted', 'user', user.id, { method: 'email_code' });
    return { session: ctx.session, guest: ctx.guest, twoFactor: ctx.pending ? ctx.pending.state : null };
  });

  /* ---------- Session ---------- */
  app.get('/v1/session', async (request, reply) => reply.send(JSON.stringify(request.ctx.session)).type('application/json'));

  app.post('/v1/session', async (request, reply) => {
    if (config.authMode !== 'dev') throw new HttpError(501, 'Sign in with the code sent to your email.');
    await limitSignIn(request);
    const email = emailFrom(request);
    const users = await db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE lower(email) = lower($1) AND status = 'active' AND deleted_at IS NULL`, [email]);
    const membership = users[0] ? await loadMembership(db, users[0].id, users[0].email) : null;
    // A lapsed member signs in to renew: signed in, with no member permissions until the membership is renewed.
    const lapsed = users[0] && !membership?.session && (await db.query(`SELECT 1 FROM members WHERE user_id = $1 AND status = 'lapsed'`, [users[0].id]))[0];
    if (lapsed) {
      const started = await twoFactor.startSession(db, mfa, users[0]!.id);
      setSessionCookie(reply, started.token);
      const pending = (await loadContext(db, started.token, 'app', secondStepRule)).pending;
      return { lapsed: true, ...(pending ? { twoFactor: pending.state } : {}) };
    }
    // The same answer whether the email is unknown or not a member, so the endpoint cannot be used to test addresses.
    if (!users[0] || !membership?.session) throw new HttpError(401, 'No active membership was found for that email address.');
    const { token } = await twoFactor.startSession(db, mfa, users[0].id);
    setSessionCookie(reply, token);
    const ctx = await loadContext(db, token, 'app', secondStepRule);
    return ctx.pending ? { ...membership.session, twoFactor: ctx.pending.state } : membership.session;
  });

  /* ---------- Guest accounts ---------- */
  app.get('/v1/guest/account', async (request, reply) => reply.send(JSON.stringify(request.ctx.guest)).type('application/json'));
  app.post('/v1/guest/account', async (request, reply) => {
    await limitSignIn(request);
    // In production the address is proved with a code before the account exists.
    if (config.authMode === 'code') {
      const email = auth.readEmail(request.body), code = auth.readCode(request.body);
      if (!(await auth.checkCode(db, config.reviewAccount, email, code, 'join'))) throw new HttpError(422, auth.WRONG_CODE, { code: auth.WRONG_CODE });
    }
    const result = await guests.createGuestAccount(db, request.ctx, request.ctx.marketId, request.body);
    if (result.newSessionToken) setSessionCookie(reply, result.newSessionToken);
    return reply.status(201).send(result.guest);
  });
  app.post('/v1/guest/session', async (request, reply) => {
    if (config.authMode !== 'dev') throw new HttpError(501, 'Sign in with the code sent to your email.');
    await limitSignIn(request);
    const userId = await guests.findGuestForSignIn(db, emailFrom(request));
    // The same answer for an unknown address as for one that is not a guest account.
    if (!userId) throw new HttpError(401, 'No account was found for that email address.');
    const { token } = await twoFactor.startSession(db, mfa, userId);
    setSessionCookie(reply, token);
    const ctx = await loadContext(db, token, 'app', secondStepRule);
    return ctx.pending ? { ...(await loadGuest(db, userId)), twoFactor: ctx.pending.state } : ctx.guest;
  });
  app.patch('/v1/guest/account', (request) => guests.updateGuestAccount(db, request.ctx, request.body));
  app.get('/v1/guest/data-export', (request) => guests.exportGuestData(db, request.ctx));
  app.delete('/v1/guest/account', async (request, reply) => {
    await guests.deleteGuestAccount(db, request.ctx);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send();
  });

  app.delete('/v1/session', async (request, reply) => {
    if (request.sessionToken) await revokeSession(db, request.sessionToken);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send();
  });
  // Sign out everywhere: every device and app, and the admin console.
  app.delete('/v1/sessions', async (request, reply) => {
    const userId = request.ctx.userId ?? request.ctx.pending?.userId;
    if (!userId) throw new HttpError(401, 'Sign in first.');
    await revokeAllSessions(db, userId);
    await audit(db, userId, 'auth.signed_out_everywhere', 'user', userId);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send();
  });

  /* ---------- Two-factor authentication: the same routes for the apps and, under /admin, for staff ---------- */
  const limitMfa = (request: FastifyRequest) => limit('two-factor', request.ip, 20);
  for (const [prefix, kind] of [['/v1/auth/2fa', 'app'], ['/admin/v1/auth/2fa', 'staff']] as const) {
    app.get(prefix, (request) => twoFactor.status(db, mfa, request.ctx));
    app.post(`${prefix}/setup`, async (request) => { await limitMfa(request); return twoFactor.beginSetup(db, mfa, request.ctx, request.body ?? {}); });
    app.post(`${prefix}/confirm`, async (request, reply) => {
      await limitMfa(request);
      const { recoveryCodes, newToken } = await twoFactor.confirmSetup(db, mfa, config.email, request.ctx, request.body);
      if (newToken) setSessionCookie(reply, newToken, kind);
      if (newToken && kind === 'staff') await staffAccounts.noteSignIn(db, (request.ctx.pending?.userId ?? request.ctx.userId)!);
      return { recoveryCodes };
    });
    app.post(`${prefix}/verify`, async (request, reply) => {
      await limitMfa(request);
      const token = await twoFactor.verify(db, mfa, config.email, request.ctx, request.body);
      setSessionCookie(reply, token, kind);
      const ctx = await loadContext(db, token, kind, secondStepRule);
      if (kind === 'staff' && ctx.userId) { await audit(db, ctx.userId, 'auth.staff_signed_in', 'user', ctx.userId, { state: 'verify' }); await staffAccounts.noteSignIn(db, ctx.userId); }
      return kind === 'staff' ? { userId: ctx.userId, roles: ctx.staffRoles } : { session: ctx.session, guest: ctx.guest };
    });
    app.post(`${prefix}/recovery-codes`, async (request) => { await limitMfa(request); return { recoveryCodes: await twoFactor.regenerateRecoveryCodes(db, mfa, request.ctx, request.body) }; });
    app.post(`${prefix}/disable`, async (request, reply) => { await limitMfa(request); await twoFactor.disable(db, mfa, config.email, request.ctx, request.body); return reply.status(204).send(); });
  }

  /* ---------- Experiences and bookings ---------- */
  app.get('/v1/experiences', (request) => experiences.listExperiences(db, request.ctx));
  app.get<{ Params: { id: string } }>('/v1/experiences/:id', (request) => experiences.getExperience(db, request.ctx, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/experiences/:id/bookings', (request) =>
    experiences.bookExperience(db, request.ctx, request.params.id, (request.body as { seats?: unknown } | null)?.seats));
  app.get('/v1/me/bookings', (request) => experiences.listBookings(db, request.ctx));
  app.post<{ Params: { id: string } }>('/v1/me/bookings/:id/cancel', (request) => experiences.cancelBooking(db, request.ctx, config.payments, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/me/bookings/:id/pay', (request) => experiences.payBooking(db, request.ctx, config.payments, request.params.id));

  /* ---------- Members ---------- */
  app.get<{ Querystring: { search?: string; role?: string } }>('/v1/members', (request) => members.listMembers(db, request.ctx, request.query));
  app.get('/v1/me/suggestions', (request) => members.listSuggestions(db, request.ctx));
  app.get<{ Querystring: { q?: string } }>('/v1/search', async (request) => search(db, request.ctx, request.ctx.marketId, request.query.q));
  app.get<{ Params: { id: string } }>('/v1/members/:id', (request) => members.getMember(db, request.ctx, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/members/:id/connection', (request) => members.requestConnection(db, request.ctx, request.params.id));
  const noContent = async (work: Promise<void>, reply: FastifyReply) => { await work; return reply.status(204).send(); };
  app.put<{ Params: { id: string } }>('/v1/members/:id/block', (request, reply) => noContent(members.blockMember(db, request.ctx, request.params.id), reply));
  app.delete<{ Params: { id: string } }>('/v1/members/:id/block', (request, reply) => noContent(members.unblockMember(db, request.ctx, request.params.id), reply));
  app.get('/v1/me/blocks', (request) => members.listBlockedMembers(db, request.ctx));
  app.post<{ Params: { id: string } }>('/v1/members/:id/reports', (request, reply) => noContent(members.reportMember(db, request.ctx, request.params.id, request.body), reply));
  app.get('/v1/me/profile', (request) => members.getMyProfile(db, request.ctx));
  app.patch('/v1/me/profile', (request) => members.updateMyProfile(db, request.ctx, request.body));

  /* ---------- Business ---------- */
  app.get('/v1/business/listings', (request) => business.listListings(db, request.ctx));
  app.post('/v1/business/listings', (request) => business.createListing(db, request.ctx, request.body));
  app.post<{ Params: { id: string } }>('/v1/business/listings/:id/close', (request, reply) => noContent(business.closeListing(db, request.ctx, request.params.id), reply));
  app.get('/v1/business/updates', (request) => relationship.listUpdates(db, request.ctx));
  app.get('/v1/me/relationship-manager', (request) => relationship.listEnquiries(db, request.ctx));
  app.post('/v1/me/relationship-manager', (request) => relationship.createEnquiry(db, request.ctx, request.body));
  app.post<{ Params: { id: string } }>('/v1/me/relationship-manager/:id/messages', (request) => relationship.sendEnquiryMessage(db, request.ctx, request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/v1/me/relationship-manager/:id/close', (request, reply) => noContent(relationship.closeEnquiry(db, request.ctx, request.params.id), reply));
  app.get('/v1/me/introductions', (request) => business.listIntroductions(db, request.ctx));
  app.post('/v1/me/introductions', (request) => business.requestIntroduction(db, request.ctx, request.body));
  app.post<{ Params: { id: string } }>('/v1/me/introductions/:id/respond', (request) => business.respondToIntroduction(db, request.ctx, request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/v1/me/introductions/:id/withdraw', (request, reply) => noContent(business.withdrawIntroduction(db, request.ctx, request.params.id), reply));

  /* ---------- Maison Quintara ---------- */
  app.get('/v1/boutique/products', async (request) => boutique.listProducts(db, request.ctx, request.ctx.marketId));
  app.get('/v1/boutique/delivery-options', async (request) => boutique.listDeliveryOptions(db, request.ctx, request.ctx.marketId));
  // Photographs: an unguessable id, a fixed image type, and no sniffing or scripting by the browser.
  // Photographs: in the object store when one is configured (MEDIA_S3_*), otherwise in the database.
  const mediaStore = config.objects ? media.createObjectMediaStore(db, config.objects) : media.createDbMediaStore(db);
  app.get<{ Params: { id: string }; Querystring: { w?: string } }>('/v1/media/:id', async (request, reply) => {
    // ?w= asks for the copy made for a screen that many pixels wide; browsers that take WebP get the sharper, lighter copy.
    const image = await media.readImage(mediaStore, request.params.id, request.query.w, request.headers.accept);
    return reply.header('content-type', image.contentType).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'cross-origin').header('vary', 'Accept').header('cache-control', 'public, max-age=31536000, immutable').send(image.bytes);
  });
  // Staff uploads. The JSON route takes small files as base64; the photograph route takes the file itself, up to 40 MB,
  // with the size, crop and quality in the query string. An image body is not a "simple" request, so browsers must
  // ask first (CORS preflight), which only the Quintara apps pass.
  app.post('/admin/v1/media', { bodyLimit: 15 * 1024 * 1024 }, (request) => media.uploadImage(db, mediaStore, request.ctx, request.body));
  await app.register(async (scope) => {
    scope.addContentTypeParser([...media.UPLOAD_TYPES], { parseAs: 'buffer', bodyLimit: media.MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));
    scope.post<{ Querystring: Record<string, string | undefined> }>('/admin/v1/photos', (request) => media.uploadPhoto(db, mediaStore, request.ctx, request.headers['content-type'], request.body, request.query));
  });
  // A member's own profile picture.
  app.put('/v1/me/avatar', { bodyLimit: 15 * 1024 * 1024 }, async (request) => members.setMyAvatar(db, request.ctx, await media.storeMemberImage(mediaStore, request.ctx, request.body)));
  app.delete('/v1/me/avatar', (request) => members.setMyAvatar(db, request.ctx, null));

  // Lifestyle services and the home page slides are open to everyone.
  app.get('/v1/home/slides', async (request) => lifestyle.listHomeSlides(db, request.ctx.marketId));
  app.get('/v1/lifestyle/services', async (request) => lifestyle.listServices(db, request.ctx.marketId, Boolean(request.ctx.session)));
  app.get<{ Params: { id: string } }>('/v1/lifestyle/services/:id', (request) => lifestyle.getService(db, request.ctx, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/lifestyle/services/:id/requests', async (request) => {
    if (!request.ctx.session) await limit('guest-requests', request.ip, config.guestRequestLimit ?? 5, 'Too many requests from this connection. Please wait a minute and try again.');
    return lifestyle.requestService(db, request.ctx, request.ctx.marketId, request.params.id, request.body);
  });
  app.get('/v1/me/service-requests', (request) => lifestyle.listMyServiceRequests(db, request.ctx));
  app.post<{ Params: { id: string } }>('/v1/me/service-requests/:id/cancel', (request, reply) => noContent(lifestyle.cancelMyServiceRequest(db, request.ctx, request.params.id), reply));
  app.put<{ Params: { id: string } }>('/v1/boutique/products/:id/wishlist', (request, reply) => noContent(boutique.setWishlist(db, request.ctx, request.params.id, request.body), reply));
  app.get('/v1/boutique/orders', (request) => boutique.listOrders(db, request.ctx));
  // Guests can order without an account, so first orders are limited per address to keep the shop from being flooded.
  app.post('/v1/boutique/orders', async (request, reply) => {
    if (!request.ctx.userId) await limit('guest-orders', request.ip, config.guestOrderLimit ?? 10, 'Too many orders from this connection. Please wait a minute and try again.');
    const result = await boutique.createOrder(db, request.ctx, request.ctx.marketId, request.body);
    if (result.newSessionToken) setSessionCookie(reply, result.newSessionToken);
    return result.order;
  });
  app.post<{ Params: { id: string } }>('/v1/boutique/orders/:id/pay', (request) => boutique.payOrder(db, request.ctx, config.payments, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/boutique/orders/:id/cancel', (request) => boutique.cancelOrder(db, request.ctx, config.payments, request.params.id));

  /* ---------- QÉRA ---------- */
  const qeraModel = config.qeraModel ?? new RuleBasedQeraModel();
  app.get('/v1/qera', (request) => qera.getThread(db, request.ctx, config.guestQeraSeconds));
  app.get('/v1/qera/memory', (request) => chief.getMemory(db, request.ctx));
  app.post('/v1/qera/memory', (request) => chief.addMemory(db, request.ctx, request.body));
  app.put<{ Params: { id: string } }>('/v1/qera/memory/:id', (request) => chief.updateMemory(db, request.ctx, request.params.id, request.body));
  app.delete<{ Params: { id: string } }>('/v1/qera/memory/:id', async (request, reply) => { await chief.deleteMemory(db, request.ctx, request.params.id); return reply.status(204).send(); });
  app.delete('/v1/qera/memory', (request, reply) => noContent(chief.clearMemory(db, request.ctx), reply));
  app.get('/v1/qera/brief', (request) => chief.getWeeklyBrief(db, request.ctx));
  app.get('/v1/qera/brief/today', (request) => getDailyBrief(db, request.ctx));
  // The member's calendar, connected by choice. The address is never returned.
  const calendarConfig: CalendarConfig = { fetcher: config.calendar?.fetcher ?? calendar.httpCalendarFetcher, secret: config.calendar?.secret ?? null, allowSample: config.calendar?.allowSample ?? config.authMode === 'dev' };
  app.get('/v1/me/calendar', (request) => calendar.getCalendar(db, request.ctx));
  app.put('/v1/me/calendar', (request) => calendar.connectCalendar(db, request.ctx, calendarConfig, request.body));
  app.patch('/v1/me/calendar', (request) => calendar.updateCalendar(db, request.ctx, calendarConfig, request.body));
  app.post('/v1/me/calendar/sync', (request) => calendar.syncCalendarNow(db, request.ctx, calendarConfig));
  app.delete('/v1/me/calendar', (request, reply) => noContent(calendar.disconnectCalendar(db, request.ctx), reply));
  app.get('/v1/qera/reminders', (request) => chief.listReminders(db, request.ctx));
  app.post('/v1/qera/reminders', (request) => chief.createReminder(db, request.ctx, request.body));
  app.post<{ Params: { id: string } }>('/v1/qera/reminders/:id/cancel', (request, reply) => noContent(chief.cancelReminder(db, request.ctx, request.params.id), reply));
  app.get<{ Params: { id: string }; Querystring: { partySize?: string } }>('/v1/qera/documents/:id/booking', (request) => chief.previewPlanBooking(db, request.ctx, request.params.id, Number(request.query.partySize ?? 2)));
  app.post<{ Params: { id: string } }>('/v1/qera/documents/:id/booking', async (request) => chief.bookPlan(db, request.ctx, request.ctx.marketId, request.params.id, request.body));
  app.post('/v1/qera/heartbeat', async (request, reply) => reply.send(JSON.stringify(await qera.heartbeat(db, request.ctx, config.guestQeraSeconds))).type('application/json'));
  /* ---------- QÉRA on WhatsApp ---------- */
  const whatsappConfig = config.whatsapp ?? null;
  app.get('/v1/me/whatsapp', (request) => whatsapp.getWhatsApp(db, request.ctx, whatsappConfig));
  app.post('/v1/me/whatsapp', (request) => whatsapp.startWhatsAppLink(db, request.ctx, whatsappConfig, request.body));
  app.delete('/v1/me/whatsapp', (request, reply) => noContent(whatsapp.unlinkWhatsApp(db, request.ctx), reply));
  // The payment provider's webhook. Its own scope reads the body as raw bytes, so the signature is checked on exactly
  // what was sent. Any provider's content type is accepted; nothing is read until the signature holds.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
    scope.post('/v1/payments/webhook', async (request, reply) => {
      const raw = request.body as Buffer;
      if (!Buffer.isBuffer(raw)) throw new HttpError(400, 'That request could not be read.');
      await checkout.handleCheckoutWebhook(db, config.payments, raw, request.headers as Record<string, string | string[] | undefined>);
      return reply.status(200).send({ received: true });
    });
  });

  // Meta's webhook. Its own scope reads the body as raw bytes, so the signature is checked on exactly what was sent.
  let whatsappWork: Promise<void> = Promise.resolve();
  app.decorate('flushWhatsApp', async () => { await whatsappWork; });
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
    scope.get<{ Querystring: Record<string, string | undefined> }>('/v1/whatsapp/webhook', async (request, reply) => reply.type('text/plain').send(whatsapp.verifyWebhook(whatsappConfig, request.query)));
    scope.post('/v1/whatsapp/webhook', async (request, reply) => {
      if (!whatsappConfig) throw new HttpError(404, 'Not found.');
      const raw = request.body as Buffer;
      if (!Buffer.isBuffer(raw) || !whatsapp.signatureValid(whatsappConfig, raw, request.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(401, 'Not signed.');
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'That request could not be read.'); }
      // Answered at once, as WhatsApp asks; the messages are handled in order, one delivery after another.
      const deps = { db, config: whatsappConfig, model: qeraModel, payments: config.payments, guestLimit: config.guestQeraSeconds, limiter: rateLimiter };
      whatsappWork = whatsappWork.then(() => whatsapp.handleDelivery(deps, body)).catch((error) => { app.log.error(error); });
      return reply.status(200).send({ received: true });
    });
  });

  app.post('/v1/qera/messages', async (request) => {
    await limit('qera', request.ctx.userId ?? request.ip, config.qeraLimit ?? 20, 'Give me a moment. Please try again in a minute.');
    return qera.sendMessage(db, request.ctx, qeraModel, config.payments, request.ctx.marketId, request.body, config.guestQeraSeconds);
  });
  app.post<{ Params: { id: string } }>('/v1/qera/proposals/:id/confirm', async (request) => qera.decideProposal(db, request.ctx, config.payments, request.ctx.marketId, request.params.id, true));
  app.post<{ Params: { id: string } }>('/v1/qera/proposals/:id/cancel', async (request) => qera.decideProposal(db, request.ctx, config.payments, request.ctx.marketId, request.params.id, false));
  app.delete('/v1/qera', (request, reply) => noContent(qera.clearThread(db, request.ctx), reply));
  app.get('/v1/qera/documents', (request) => partnerBookings.listDocuments(db, request.ctx));
  app.get<{ Params: { id: string } }>('/v1/qera/documents/:id', (request) => partnerBookings.getDocument(db, request.ctx, request.params.id));
  app.delete<{ Params: { id: string } }>('/v1/qera/documents/:id', (request, reply) => noContent(partnerBookings.deleteDocument(db, request.ctx, request.params.id), reply));
  app.get('/v1/me/partner-bookings', (request) => partnerBookings.listMyPartnerBookings(db, request.ctx));
  app.post<{ Params: { id: string } }>('/v1/me/partner-bookings/:id/cancel', (request, reply) => noContent(partnerBookings.cancelMyPartnerBooking(db, request.ctx, request.params.id), reply));
  // The partner's side. The token in the address is the only credential, so wrong guesses are limited per address.
  app.get<{ Params: { token: string } }>('/v1/partner-bookings/:token', async (request) => { await limit('partner-links', request.ip, 30); return partnerBookings.viewByToken(db, request.params.token); });
  app.post<{ Params: { token: string } }>('/v1/partner-bookings/:token', async (request) => { await limit('partner-links', request.ip, 30); return partnerBookings.respondByToken(db, request.params.token, request.body); });

  /* ---------- Quintara TV ---------- */
  app.get('/v1/tv/series', async (request) => tv.listSeries(db, request.ctx, await defaultMarket()));
  app.put<{ Params: { id: string } }>('/v1/tv/episodes/:id/progress', (request, reply) => noContent(tv.saveProgress(db, request.ctx, request.params.id, request.body), reply));

  /* ---------- Lifestyle partners and privileges ---------- */
  app.get('/v1/partners', (request) => partners.listPartners(db, request.ctx));
  app.get<{ Params: { id: string } }>('/v1/partners/:id', (request) => partners.getPartner(db, request.ctx, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/privileges/:id/redemptions', (request) => partners.redeemPrivilege(db, request.ctx, request.params.id));
  app.get('/v1/me/redemptions', (request) => partners.listMyRedemptions(db, request.ctx));

  /* ---------- Privacy ---------- */
  app.get('/v1/me/privacy', (request) => privacy.getPrivacy(db, request.ctx));
  app.put('/v1/me/privacy', (request) => privacy.updatePrivacy(db, request.ctx, request.body));
  app.get('/v1/me/data-export', (request) => privacy.exportMyData(db, request.ctx));
  app.post('/v1/me/account/close', async (request, reply) => {
    const result = await privacy.closeMyAccount(db, request.ctx, config.payments, request.body);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send(result);
  });

  /* ---------- Membership application ---------- */
  app.get('/v1/me/application', async (request, reply) => reply.send(JSON.stringify(await applications.getApplication(db, request.ctx))).type('application/json'));
  app.put('/v1/me/application', async (request, reply) => {
    const result = await applications.saveApplicationDraft(db, request.ctx, request.ctx.marketId, request.body);
    if (result.newSessionToken) setSessionCookie(reply, result.newSessionToken);
    return result.application;
  });
  app.post('/v1/me/application/submit', async (request, reply) => {
    const result = await applications.submitApplication(db, request.ctx, request.ctx.marketId, request.body);
    if (result.newSessionToken) setSessionCookie(reply, result.newSessionToken);
    return result.application;
  });

  // What the application asks: the plans offered in this city, and the questions. Open to anyone who may apply.
  app.get('/v1/application/plans', (request) => form.listPlans(db, request.ctx.marketId));
  app.get('/v1/application/questions', () => form.listQuestions(db));
  app.get('/admin/v1/application/questions', (request) => form.listQuestionsForStaff(db, request.ctx));
  app.put<{ Params: { key: string } }>('/admin/v1/application/questions/builtin/:key', (request) => form.updateBuiltinQuestion(db, request.ctx, request.params.key, request.body));
  app.delete<{ Params: { key: string } }>('/admin/v1/application/questions/builtin/:key', (request) => form.resetBuiltinQuestion(db, request.ctx, request.params.key));
  app.post('/admin/v1/application/questions', (request) => form.createQuestion(db, request.ctx, request.body));
  app.patch<{ Params: { id: string } }>('/admin/v1/application/questions/:id', (request) => form.updateQuestion(db, request.ctx, request.params.id, request.body));

  app.post('/v1/me/application/pay', (request) => payMembershipFee(db, request.ctx, config.payments, request.headers['idempotency-key'] as string | undefined));

  /* ---------- Concierge ---------- */
  type RequestId = { Params: { id: string } };
  const bodyOf = (request: FastifyRequest) => ({ body: (request.body as { body?: unknown } | null)?.body });
  app.get('/v1/me/concierge-requests', (request) => concierge.listRequests(db, request.ctx));
  app.post('/v1/me/concierge-requests', (request) => concierge.createRequest(db, request.ctx, request.body));
  app.get<RequestId>('/v1/me/concierge-requests/:id', (request) => concierge.getRequest(db, request.ctx, request.params.id));
  app.post<RequestId>('/v1/me/concierge-requests/:id/messages', (request) => concierge.sendMessage(db, request.ctx, request.params.id, bodyOf(request)));
  app.post<RequestId>('/v1/me/concierge-requests/:id/confirm', (request) => concierge.confirmRequest(db, request.ctx, request.params.id));
  app.post<RequestId>('/v1/me/concierge-requests/:id/cancel', (request) => concierge.cancelRequest(db, request.ctx, request.params.id));

  /* ---------- Messaging ---------- */
  type MemberId = { Params: { memberId: string } };
  app.get('/v1/me/conversations', (request) => messaging.listConversations(db, request.ctx));
  app.get<MemberId>('/v1/me/conversations/:memberId', (request) => messaging.getConversation(db, request.ctx, request.params.memberId));
  app.post<MemberId>('/v1/me/conversations/:memberId/messages', (request) => messaging.sendMessage(db, request.ctx, request.params.memberId, bodyOf(request)));
  app.post<MemberId>('/v1/me/conversations/:memberId/read', async (request, reply) => { await messaging.markRead(db, request.ctx, request.params.memberId); return reply.status(204).send(); });

  /* ---------- Notifications ---------- */
  app.get('/v1/me/notifications', (request) => notifications.listNotifications(db, request.ctx));
  // Push notifications: this phone, the person's choices, and a test.
  app.put('/v1/me/push/device', (request) => push.registerDevice(db, request.ctx, request.sessionToken, request.body));
  app.post('/v1/me/push/device/remove', async (request, reply) => { await push.unregisterDevice(db, request.ctx, request.body); return reply.status(204).send(); });
  app.delete<{ Params: { id: string } }>('/v1/me/push/devices/:id', async (request, reply) => { await push.removeDevice(db, request.ctx, request.params.id); return reply.status(204).send(); });
  app.get('/v1/me/push', (request) => push.getPushSettings(db, request.ctx, request.sessionToken));
  app.put('/v1/me/push', (request) => push.updatePushSettings(db, request.ctx, request.body, request.sessionToken));
  app.post('/v1/me/push/test', (request) => push.sendTestPush(db, request.ctx));
  // Membership: the term, renewal and the saved card. Also open to a lapsed member, so they can renew.
  app.get('/v1/me/membership', (request) => renewals.getMembership(db, request.ctx));
  // Which card form the apps show: the provider's own secure form, or the test cards while payments are the stand-in.
  app.get('/v1/payments/config', async () => ({ provider: config.payments.name, testCards: config.payments.name === 'mock', checkout: config.payments.hosted ? 'hosted' : 'direct' }));
  // Paying through the provider's hosted checkout (checkout.ts): start, then ask how it stands on the way back.
  app.post('/v1/payments/checkout', (request) => checkout.startCheckout(db, request.ctx, config.payments, allowedOrigins, request.body));
  app.get<{ Params: { id: string } }>('/v1/payments/checkout/:id', (request) => checkout.getCheckout(db, request.ctx, config.payments, request.params.id));
  // The test checkout's own page and its Pay and Decline links. Development and staging only (TestCheckoutProvider).
  app.get<{ Params: { ref: string } }>('/v1/payments/test-checkout/:ref', async (request, reply) => {
    const provider = config.payments;
    const found = provider instanceof TestCheckoutProvider ? provider.checkouts.get(request.params.ref) : undefined;
    if (!found) throw new HttpError(404, 'This checkout does not exist.');
    return reply.type('text/html; charset=utf-8').send(checkout.testCheckoutPage(request.params.ref, formatMoney(found.request.amountMinor, found.request.currency), found.request.description));
  });
  app.get<{ Params: { ref: string }; Querystring: { outcome?: string } }>('/v1/payments/test-checkout/:ref/complete', async (request, reply) => {
    const provider = config.payments;
    const done = provider instanceof TestCheckoutProvider ? provider.complete(request.params.ref, request.query.outcome === 'paid' ? 'paid' : 'declined') : null;
    if (!done) throw new HttpError(404, 'This checkout does not exist.');
    // Delivered as a real provider would deliver it: a signed webhook, checked by the same code.
    await checkout.handleCheckoutWebhook(db, provider, Buffer.from(done.body), { 'x-test-checkout-signature': done.signature });
    return reply.redirect(done.returnUrl, 303);
  });
  app.put('/v1/me/membership/card', (request) => renewals.savePaymentMethod(db, request.ctx, config.payments, request.body));
  app.delete('/v1/me/membership/card', (request) => renewals.removePaymentMethod(db, request.ctx, config.payments));
  app.put('/v1/me/membership/auto-renew', (request) => renewals.setAutoRenew(db, request.ctx, request.body));
  app.post('/v1/me/membership/renew', (request) => renewals.renewNow(db, request.ctx, config.payments, ((request.headers['idempotency-key'] as string | undefined) ?? (String((request.body as { idempotencyKey?: unknown } | null)?.idempotencyKey ?? '') || undefined))));
  app.post<{ Params: { id: string } }>('/v1/me/notifications/:id/read', async (request, reply) => {
    await notifications.markNotificationRead(db, request.ctx, request.params.id);
    return reply.status(204).send();
  });

  /* ---------- Staff: /admin/v1 ---------- */
  app.get('/admin/v1/session', async (request, reply) =>
    reply.send(JSON.stringify(request.ctx.staffRoles.length ? { userId: request.ctx.userId, roles: request.ctx.staffRoles } : null)).type('application/json'));
  app.post('/admin/v1/session', async (request, reply) => {
    await limitSignIn(request);
    if (config.authMode === 'code') {
      const email = auth.readEmail(request.body), code = auth.readCode(request.body);
      if (!(await auth.checkCode(db, config.reviewAccount, email, code, 'staff'))) throw new HttpError(401, auth.WRONG_CODE);
    }
    const users = await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND status = 'active' AND deleted_at IS NULL`, [emailFrom(request)]);
    const roles = users[0] ? await loadStaffRoles(db, users[0].id) : [];
    if (!users[0] || !roles.length) {
      // An attempt on a real (if suspended) staff account is recorded against it.
      if (users[0] && (await db.query('SELECT 1 FROM staff_accounts WHERE user_id = $1', [users[0].id]))[0]) await audit(db, users[0].id, 'auth.staff_sign_in_failed', 'user', users[0].id, { reason: 'no active staff role' });
      throw new HttpError(401, 'No staff account was found for that email address.');
    }
    const { token, state } = await twoFactor.startSession(db, mfa, users[0].id, 'staff');
    setSessionCookie(reply, token, 'staff');
    const ctx = await loadContext(db, token, 'staff', secondStepRule);
    if (ctx.pending) return { userId: null, roles: [], twoFactor: ctx.pending.state };
    await audit(db, users[0].id, 'auth.staff_signed_in', 'user', users[0].id, { state });
    await staffAccounts.noteSignIn(db, users[0].id);
    return { userId: users[0].id, roles };
  });
  app.delete('/admin/v1/session', async (request, reply) => {
    if (request.sessionToken) await revokeSession(db, request.sessionToken);
    return reply.clearCookie(STAFF_COOKIE, { path: '/admin' }).status(204).send();
  });
  // Admin console accounts (up to five active) and the audit log.
  const seats = config.staffSeats ?? staffAccounts.DEFAULT_STAFF_SEATS;
  const adminUrl = config.adminUrl ?? 'http://localhost:3001';
  app.get('/admin/v1/staff', (request) => staffAccounts.listStaff(db, request.ctx, seats));
  app.post('/admin/v1/staff', (request) => staffAccounts.addStaff(db, config.email, request.ctx, seats, adminUrl, request.body));
  app.patch<{ Params: { id: string } }>('/admin/v1/staff/:id', async (request, reply) => { await staffAccounts.updateStaff(db, request.ctx, seats, request.params.id, request.body); return reply.status(204).send(); });
  app.get('/admin/v1/audit', (request) => staffAccounts.listAudit(db, request.ctx, request.query));
  app.get('/admin/v1/audit/export', async (request, reply) => {
    const csv = await staffAccounts.exportAudit(db, request.ctx, request.query);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="quintara-audit-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });
  app.post('/admin/v1/audit/verify', (request) => staffAccounts.verifyAudit(db, request.ctx));
  app.post<{ Params: { id: string } }>('/admin/v1/users/:id/two-factor/reset', async (request, reply) => { await twoFactor.adminReset(db, config.email, request.ctx, request.params.id, request.body); return reply.status(204).send(); });

  type Id = { Params: { id: string } };
  const done = async (work: Promise<void>, reply: FastifyReply) => { await work; return reply.status(204).send(); };
  app.get<{ Querystring: { status?: string } }>('/admin/v1/applications', (request) => admin.listApplications(db, request.ctx, request.query.status));
  app.post<Id>('/admin/v1/applications/:id/review', (request, reply) => done(admin.reviewApplication(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/applications/:id/approve', (request, reply) => done(admin.approveApplication(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/tiers', (request) => admin.listTiers(db, request.ctx));
  app.get('/admin/v1/tiers/all', (request) => admin.listAllTiers(db, request.ctx));
  app.post('/admin/v1/tiers', async (request, reply) => done(admin.createTier(db, request.ctx, request.ctx.marketId, request.body), reply));
  app.patch<Id>('/admin/v1/tiers/:id', (request, reply) => done(admin.updateTier(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/payments', (request) => admin.listPayments(db, request.ctx, request.query));
  app.get('/admin/v1/payments/export', async (request, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="quintara-payments-${new Date().toISOString().slice(0, 10)}.csv"`).send(await admin.exportPayments(db, request.ctx)));
  app.get('/admin/v1/members/export', async (request, reply) => reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="quintara-members-${new Date().toISOString().slice(0, 10)}.csv"`).send(await admin.exportMembers(db, request.ctx)));
  app.get('/admin/v1/members', (request) => admin.listMembersForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/members/:id/status', (request, reply) => done(admin.setMemberStatus(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/members/:id/roles', (request, reply) => done(admin.setMemberRole(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/experiences', (request) => admin.listExperiencesForStaff(db, request.ctx));
  app.post('/admin/v1/experiences', async (request) => admin.createExperience(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/experiences/:id', (request) => admin.updateExperience(db, request.ctx, request.params.id, request.body));
  app.post<Id>('/admin/v1/experiences/:id/invitations', (request, reply) => done(admin.inviteMember(db, request.ctx, request.params.id, request.body), reply));
  app.get<Id>('/admin/v1/experiences/:id/guests', (request) => admin.listGuests(db, request.ctx, request.params.id));
  // Cancellations decided by Quintara: one booking (with a refund chosen by finance), or a whole experience (all refunded).
  app.post<Id>('/admin/v1/bookings/:id/cancel', (request) => cancellations.cancelBookingForStaff(db, request.ctx, config.payments, request.params.id, request.body));
  app.post<Id>('/admin/v1/payments/:id/refund', (request) => cancellations.refundPaymentForStaff(db, request.ctx, config.payments, request.params.id, request.body));
  app.post<Id>('/admin/v1/experiences/:id/cancel', (request) => cancellations.cancelExperience(db, request.ctx, config.payments, request.params.id, request.body));
  app.post<Id>('/admin/v1/bookings/:id/decision', (request, reply) => done(admin.decideBooking(db, request.ctx, request.params.id, request.body), reply));
  app.post('/admin/v1/check-in', (request) => admin.checkIn(db, request.ctx, request.body));
  app.get('/admin/v1/business/listings', (request) => business.listListingsForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/business/listings/:id/review', (request, reply) => done(business.reviewListing(db, request.ctx, request.params.id, request.body), reply));
  app.patch<Id>('/admin/v1/business/listings/:id', (request, reply) => done(relationship.editListing(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/business/updates', (request) => relationship.listUpdatesForStaff(db, request.ctx));
  app.post('/admin/v1/business/updates', async (request) => relationship.createUpdate(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/business/updates/:id', (request, reply) => done(relationship.updateUpdate(db, request.ctx, request.params.id, request.body), reply));
  app.delete<Id>('/admin/v1/business/updates/:id', (request, reply) => done(relationship.deleteUpdate(db, request.ctx, request.params.id), reply));
  app.get('/admin/v1/business/enquiries', (request) => relationship.listEnquiriesForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/business/enquiries/:id/reply', (request, reply) => done(relationship.replyToEnquiry(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/business/enquiries/:id/close', (request, reply) => done(relationship.closeEnquiryAsStaff(db, request.ctx, request.params.id), reply));
  app.get('/admin/v1/business/introductions', (request) => business.listIntroductionsForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/business/introductions/:id/handle', (request, reply) => done(business.handleIntroduction(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/products', (request) => boutique.listProductsForStaff(db, request.ctx));
  app.post('/admin/v1/products', async (request) => boutique.createProduct(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/products/:id', (request, reply) => done(boutique.updateProduct(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/orders', (request) => boutique.listOrdersForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/orders/:id/advance', (request, reply) => done(boutique.advanceOrder(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/orders/:id/notes', (request, reply) => done(boutique.addOrderNote(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/orders/:id/cancel', (request, reply) => done(boutique.cancelOrderForStaff(db, request.ctx, config.payments, request.params.id, request.body), reply));
  app.get('/admin/v1/delivery-options', (request) => boutique.listDeliveryOptionsForStaff(db, request.ctx));
  app.post('/admin/v1/delivery-options', async (request) => boutique.createDeliveryOption(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/delivery-options/:id', (request, reply) => done(boutique.updateDeliveryOption(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/tv/series', (request) => tv.listSeriesForStaff(db, request.ctx));
  app.post('/admin/v1/tv/series', async (request) => tv.createSeries(db, request.ctx, await defaultMarket(), request.body));
  app.patch<Id>('/admin/v1/tv/series/:id', (request, reply) => done(tv.updateSeries(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/tv/series/:id/episodes', (request) => tv.createEpisode(db, request.ctx, request.params.id, request.body));
  app.patch<Id>('/admin/v1/tv/episodes/:id', (request, reply) => done(tv.updateEpisode(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/partner-bookings', (request) => partnerBookings.listPartnerBookingsForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/partner-bookings/:id/settle', (request, reply) => done(partnerBookings.settlePartnerBookingAsStaff(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/services', (request) => lifestyle.listServicesForStaff(db, request.ctx));
  app.post('/admin/v1/services', async (request) => lifestyle.createService(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/services/:id', (request, reply) => done(lifestyle.updateService(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/services/:id/packages', (request) => lifestyle.createServicePackage(db, request.ctx, request.params.id, request.body));
  app.patch<Id>('/admin/v1/service-packages/:id', (request, reply) => done(lifestyle.updateServicePackage(db, request.ctx, request.params.id, request.body), reply));
  app.delete<Id>('/admin/v1/service-packages/:id', (request, reply) => done(lifestyle.deleteServicePackage(db, request.ctx, request.params.id), reply));
  app.get('/admin/v1/service-requests', (request) => lifestyle.listServiceRequestsForStaff(db, request.ctx));
  app.post<Id>('/admin/v1/service-requests/:id/status', (request, reply) => done(lifestyle.setServiceRequestStatus(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/home-slides', (request) => lifestyle.listHomeSlidesForStaff(db, request.ctx));
  app.post('/admin/v1/home-slides', async (request) => lifestyle.createHomeSlide(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/home-slides/:id', (request, reply) => done(lifestyle.updateHomeSlide(db, request.ctx, request.params.id, request.body), reply));
  app.delete<Id>('/admin/v1/home-slides/:id', (request, reply) => done(lifestyle.deleteHomeSlide(db, request.ctx, request.params.id), reply));
  app.get('/admin/v1/partners', (request) => partners.listPartnersForStaff(db, request.ctx));
  app.post('/admin/v1/partners', async (request) => partners.createPartner(db, request.ctx, request.ctx.marketId, request.body));
  app.patch<Id>('/admin/v1/partners/:id', (request, reply) => done(partners.updatePartner(db, request.ctx, request.params.id, request.body), reply));
  app.post<Id>('/admin/v1/partners/:id/privileges', (request) => partners.createPrivilege(db, request.ctx, request.params.id, request.body));
  app.patch<Id>('/admin/v1/privileges/:id', (request, reply) => done(partners.updatePrivilege(db, request.ctx, request.params.id, request.body), reply));
  app.get('/admin/v1/account-closures', (request) => admin.listClosures(db, request.ctx));
  app.post<Id>('/admin/v1/account-closures/:id/erase', (request, reply) => done(admin.eraseClosedAccount(db, request.ctx, request.params.id), reply));
  app.post<Id>('/admin/v1/account-closures/:id/reinstate', (request, reply) => done(admin.reinstateClosedAccount(db, request.ctx, request.params.id), reply));
  app.get('/admin/v1/reports', (request) => admin.listReports(db, request.ctx));
  app.post<Id>('/admin/v1/reports/:id/resolve', (request, reply) => done(admin.resolveReport(db, request.ctx, request.params.id, request.body), reply));
  // The Overview: figures and waiting work for the city, each section only for roles that may see it.
  app.get('/admin/v1/dashboard', (request) => getDashboard(db, request.ctx));
  app.get('/admin/v1/insights', (request) => insights.getInsights(db, request.ctx, request.query));
  app.get('/admin/v1/insights/export', async (request, reply) => {
    const csv = await insights.insightsCsv(db, request.ctx, request.query);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="quintara-insights-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });
  app.get('/admin/v1/insights/report', (request) => insights.getReportSetting(db, request.ctx));
  app.put('/admin/v1/insights/report', (request) => insights.setReportSetting(db, request.ctx, request.body));
  app.post('/admin/v1/insights/report/send', (request) => insights.sendReportToMe(db, request.ctx, config.email, config.adminUrl ?? 'http://localhost:3001'));
  // Renewals: coming up, failing and lapsed; staff can try the card again or extend a term.
  app.get('/admin/v1/renewals', (request) => renewals.listRenewals(db, request.ctx));
  app.post<{ Params: { id: string } }>('/admin/v1/renewals/:id/retry', (request) => renewals.retryRenewal(db, request.ctx, config.payments, request.params.id));
  app.post<{ Params: { id: string } }>('/admin/v1/renewals/:id/extend', (request) => renewals.extendTerm(db, request.ctx, request.params.id, request.body));
  app.get('/admin/v1/concierge-requests', (request) => concierge.listRequestsForStaff(db, request.ctx));
  app.get<Id>('/admin/v1/concierge-requests/:id', (request) => concierge.getRequestForStaff(db, request.ctx, request.params.id));
  app.post<Id>('/admin/v1/concierge-requests/:id/reply', (request) => concierge.replyAsDesk(db, request.ctx, request.params.id, bodyOf(request)));
  app.post<Id>('/admin/v1/concierge-requests/:id/status', (request) => concierge.setStatus(db, request.ctx, request.params.id, request.body));

  return app;
}
