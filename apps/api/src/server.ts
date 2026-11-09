/**
 * Entry point.
 *   DATABASE_URL set   -> PostgreSQL (run `pnpm --filter @quintara/api migrate` first)
 *   DATABASE_URL unset -> an in-memory database, migrated and filled with sample data on start
 */
import { buildApp } from './app.ts';
import { createMemoryDb, createPostgresDb } from './db.ts';
import { migrate } from './migrate.ts';
import { deliverEmails, MockEmailProvider, ResendEmailProvider } from './email.ts';
import type { EmailProvider } from './email.ts';
import { deliverPartnerBookings } from './partner-bookings.ts';
import { MockPaymentProvider } from './payments.ts';
import { dispatchPush, ExpoPushProvider, MockPushProvider } from './push.ts';
import type { PushProvider } from './push.ts';
import { runRenewals } from './renewals.ts';
import { sendWeeklyReport } from './insights.ts';
import { eraseDueAccounts } from './privacy.ts';
import { runChiefOfStaff } from './chief.ts';
import { httpCalendarFetcher, syncDueCalendars } from './calendar.ts';
import { seed } from './seed.ts';
import { CloudApiWhatsAppProvider, MockWhatsAppProvider } from './whatsapp.ts';
import type { WhatsAppConfig } from './whatsapp.ts';

const production = process.env.NODE_ENV === 'production';
const url = process.env.DATABASE_URL;
if (production && !url) throw new Error('DATABASE_URL is required in production.');

const db = url ? createPostgresDb(url) : createMemoryDb();
if (!url) {
  await migrate(db);
  await seed(db, { history: true });
  console.log('Using an in-memory database with sample data. Member: thandi@example.com. Staff: admin@example.com, desk@example.com.');
}

const env = process.env;
const env0 = (key: string) => (process.env[key] ?? '').trim();
// Production signs in with one-time codes sent by email. AUTH_MODE=dev (email alone) is refused in production.
const authMode = process.env.AUTH_MODE === 'code' ? 'code' : 'dev';
if (production && authMode !== 'code') throw new Error('Set AUTH_MODE=code in production.');
// App store review: one address that signs in with a fixed code (REVIEW_EMAIL, REVIEW_CODE: six digits).
const reviewAccount = process.env.REVIEW_EMAIL && /^\d{6}$/.test(process.env.REVIEW_CODE ?? '') ? { email: process.env.REVIEW_EMAIL, code: process.env.REVIEW_CODE! } : null;

// Email: Resend when RESEND_API_KEY and EMAIL_FROM are set. In development without them, each message is printed
// (sign-in codes included), so links and codes can be followed. Production refuses to start without a mail service,
// as nobody could sign in.
let email: EmailProvider;
if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
  email = new ResendEmailProvider({ apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM });
} else {
  if (production) throw new Error('Set RESEND_API_KEY and EMAIL_FROM: sign-in codes and notifications are sent by email.');
  const mock = new MockEmailProvider();
  const keep = mock.send.bind(mock);
  mock.send = async (message) => { await keep(message); console.log(`\n[email not sent: development] To: ${message.to}\nSubject: ${message.subject}\n${message.text}\n`); };
  email = mock;
}
const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';

// Two-factor authentication. Required for every account in production; TWO_FACTOR=required|optional|off in
// development (default optional: asked only of those who have set it up). MFA_ENCRYPTION_KEY (32+ characters)
// encrypts authenticator secrets; production refuses to start without it.
const twoFactorPolicy = production ? 'required' : (['required', 'optional', 'off'].includes(env0('TWO_FACTOR')) ? env0('TWO_FACTOR') : 'optional') as 'required' | 'optional' | 'off';
const mfaKey = (process.env.MFA_ENCRYPTION_KEY ?? '').length >= 32 ? process.env.MFA_ENCRYPTION_KEY! : production ? null : 'development-only-two-factor-key-do-not-use';
if (!mfaKey) throw new Error('Set MFA_ENCRYPTION_KEY (32 or more random characters): it encrypts the authenticator secrets for two-factor sign-in.');
if (production && process.env.CALENDAR_SECRET && process.env.CALENDAR_SECRET === process.env.MFA_ENCRYPTION_KEY) throw new Error('Use a different MFA_ENCRYPTION_KEY from CALENDAR_SECRET.');
// App store review: the review account's second step takes a fixed six-digit code (REVIEW_2FA_CODE).
const reviewSecondCode = /^\d{6}$/.test(process.env.REVIEW_2FA_CODE ?? '') ? process.env.REVIEW_2FA_CODE! : null;
if (reviewAccount && production && !reviewSecondCode) throw new Error('Set REVIEW_2FA_CODE (six digits) for the review account, or remove REVIEW_EMAIL.');
if (reviewAccount && reviewSecondCode === reviewAccount.code) throw new Error('REVIEW_2FA_CODE must differ from REVIEW_CODE.');

// QÉRA on WhatsApp. With Meta's details set, messages go through the WhatsApp Cloud API. In development a stand-in
// keeps what would be sent and prints it. In production without them, the apps say WhatsApp is not available yet.
const whatsappReady = env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_BUSINESS_NUMBER && (env.WHATSAPP_NUMBER_SECRET ?? '').length >= 32;
let whatsapp: WhatsAppConfig | null = null;
if (whatsappReady) {
  whatsapp = { provider: new CloudApiWhatsAppProvider({ token: env.WHATSAPP_ACCESS_TOKEN!, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID! }), businessNumber: env.WHATSAPP_BUSINESS_NUMBER!,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN!, appSecret: env.WHATSAPP_APP_SECRET!, numberSecret: env.WHATSAPP_NUMBER_SECRET! };
} else if (!production) {
  const provider = new MockWhatsAppProvider();
  const keep = provider.send.bind(provider);
  provider.send = async (to, message) => { const sent = await keep(to, message); console.log(`\n[WhatsApp not sent: development] To: +${to}\n${message.text}${message.type === 'buttons' ? `\n[${message.buttons.map((b) => b.title).join('] [')}]` : ''}\n`); return sent; };
  whatsapp = { provider, businessNumber: '+27 21 000 0000', verifyToken: 'development-verify-token', appSecret: 'development-app-secret', numberSecret: 'development-only-whatsapp-secret-do-not-use' };
}

// Push notifications go through Expo's push service (Apple and Google behind it), set up with the app's EAS
// credentials. EXPO_ACCESS_TOKEN is optional ("enhanced push security" in the Expo project). PUSH=off turns push
// off; in development a stand-in prints what would be sent.
let push: PushProvider | undefined;
if (env0('PUSH') === 'off') push = undefined;
else if (production || env0('PUSH') === 'expo') push = new ExpoPushProvider(process.env.EXPO_ACCESS_TOKEN || undefined);
else {
  const mock = new MockPushProvider();
  const keep = mock.send.bind(mock);
  mock.send = async (messages) => { const out = await keep(messages); for (const m of messages) console.log(`\n[push not sent: development] To: ${m.to.slice(0, 24)}…\n${m.title}: ${m.body}\n`); return out; };
  push = mock;
}
// Replace with the real provider's adapter (see payments.ts) before taking money.
const payments = new MockPaymentProvider();

const app = await buildApp(db, {
  webOrigins: (process.env.WEB_ORIGINS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',').map((origin) => origin.trim()),
  authMode,
  reviewAccount,
  secureCookies: production,
  payments,
  push,
  // Replace with the real mail service's adapter (see email.ts). The stand-in sends nothing.
  email,
  webUrl,
  // Encrypts the calendar addresses members give QÉRA. Without it, only the sample calendar can be connected.
  whatsapp,
  calendar: { secret: process.env.CALENDAR_SECRET && process.env.CALENDAR_SECRET.length >= 32 ? process.env.CALENDAR_SECRET : production ? null : 'development-only-calendar-secret-do-not-use' },
  twoFactor: { policy: twoFactorPolicy, key: mfaKey, issuer: 'Quintara', review: reviewAccount && reviewSecondCode ? { email: reviewAccount.email, code: reviewSecondCode } : null },
  // Behind a load balancer: TRUST_PROXY=true (or the proxy's address), so rate limits see the real address.
  trustProxy: env0('TRUST_PROXY') === 'true' ? true : env0('TRUST_PROXY') || false,
  // The admin console: up to STAFF_SEATS active accounts (five unless set), and its address for new staff's emails.
  staffSeats: Math.max(1, Math.min(50, Number(env0('STAFF_SEATS')) || 5)),
  adminUrl: env0('ADMIN_URL') || (production ? 'https://admin.quintaralifestyle.com' : 'http://localhost:3001'),
  logger: true,
});
const calendarConfig = { fetcher: httpCalendarFetcher, secret: process.env.CALENDAR_SECRET && process.env.CALENDAR_SECRET.length >= 32 ? process.env.CALENDAR_SECRET : production ? null : 'development-only-calendar-secret-do-not-use', allowSample: !production };
await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '127.0.0.1' });

// Housekeeping: retry any email that did not go out, erase closed accounts whose cooling-off period has ended,
// and let QÉRA send what it sends of its own accord.
const housekeeping = setInterval(() => {
  void deliverEmails(db, email, webUrl).then(() => deliverPartnerBookings(db, email, webUrl)).catch((error) => app.log.error(error));
  void eraseDueAccounts(db).then((n) => { if (n) app.log.info(`Erased ${n} closed account(s).`); }).catch((error) => app.log.error(error));
  // QÉRA as Chief of Staff: due reminders, the Monday brief, dates coming up and tomorrow's bookings.
  void runChiefOfStaff(db).catch((error) => app.log.error(error));
  // Members' calendars, read again every half hour for the daily brief.
  void syncDueCalendars(db, calendarConfig).catch((error) => app.log.error(error));
  // Membership renewals: reminders, charges that are due, and lapses. Not run in production while payments are the
  // stand-in, which would mark renewals paid without taking any money.
  if (!production || payments.name !== 'mock') void runRenewals(db, payments).then((r) => { if (r.renewed + r.failed + r.lapsed) app.log.info(r, 'renewals'); }).catch((error) => app.log.error(error));
  // The weekly insights report, Monday from 07:00, to the staff who asked for it.
  void sendWeeklyReport(db, email, env0('ADMIN_URL') || (production ? 'https://admin.quintaralifestyle.com' : 'http://localhost:3001')).catch((error) => app.log.error(error));
}, 60_000);
housekeeping.unref();

// Push notifications are sent within a few seconds of being created.
let pushing = false;
const pushLoop = setInterval(() => {
  if (!push || pushing) return;
  pushing = true;
  void dispatchPush(db, push).catch((error) => app.log.error(error)).finally(() => { pushing = false; });
}, 4_000);
pushLoop.unref();
