# Quintara: going live, and publishing to the App Store and Google Play

This is the hand-over guide for the team taking Quintara to production. It covers what is in the repository,
how to put the backend live, how to build and submit the iOS and Android apps, and the actions still pending.

## 1. What is in the repository

| Part | Where | What it is |
|---|---|---|
| API | `apps/api` | Node 22, Fastify, PostgreSQL. Every feature of every app. the 119 calls of the shared contract, plus the admin routes. |
| Database | `db/migrations` (0001–0032), `docs/quintara_schema.sql` | Applied in order by `pnpm --filter @quintara/api migrate`. |
| Web app | `apps/web` | Next.js 16. Members, guests, applicants. |
| Admin console | `apps/admin` | Next.js 16. Staff only. |
| Maison Quintara shop | `apps/maison` | Next.js 16. The public shop, on the same API and data. |
| Mobile app | `apps/mobile` | Expo SDK 57 (React Native 0.86), one codebase for iOS and Android. |
| Shared code | `packages/*` | Domain rules, the API client (real and offline mock), shared React state, design tokens. |
| Store configuration | `apps/mobile/app.json`, `apps/mobile/eas.json`, `apps/mobile/assets` | Identifiers, versions, icons, splash, privacy manifest, build and submit profiles. |
| Settings template | `.env.example` | Every setting, with what it does. |
| Mock-up | `mockups/quintara-mobile-web-admin.html` | The clickable mock-up of all three apps. |

The iOS and Android native projects are not stored in the repository: Expo generates them from `app.json` on each
build (EAS Build). This keeps both platforms in step and is Expo's recommended way of working.

## 2. Put the backend live (do this before building the apps)

1. **Host.** A Node 22 host for the API (for example Render, Fly.io, Railway, AWS or Azure), managed PostgreSQL 15+,
   with daily backups. Hosting for the web app, the admin console and the Maison Quintara shop (for example Vercel).
2. **Addresses.** The store builds expect `https://api.quintaralifestyle.com` (API) and
   `https://app.quintaralifestyle.com` (web app); change them in `apps/mobile/eas.json` if you choose others.
   The admin console can live at, say, `https://admin.quintaralifestyle.com`, and the shop at `https://maison.quintaralifestyle.com`. Everything must be HTTPS.
3. **Settings.** Set the API's settings from `.env.example`. Production refuses to start without
   `DATABASE_URL`, `AUTH_MODE=code`, `RESEND_API_KEY`, `EMAIL_FROM` and `MFA_ENCRYPTION_KEY` (two-factor; 32+ random characters, different from `CALENDAR_SECRET`). Also set `NODE_ENV=production`,
   `WEB_ORIGINS` (web app, admin console and shop addresses), `WEB_URL`, `ADMIN_URL`, `TRUST_PROXY` (behind a load balancer), `CALENDAR_SECRET`, and, when ready, the six `WHATSAPP_*`.
4. **Database.**
   ```sh
   pnpm install
   DATABASE_URL=… pnpm --filter @quintara/api migrate
   DATABASE_URL=… SETUP_ADMIN_EMAIL=you@quintaralifestyle.com REVIEW_EMAIL=review@quintaralifestyle.com \
     pnpm --filter @quintara/api run first-run
   ```
   `first-run` opens Cape Town with the standard membership plans, creates the first administrator, and (with
   `REVIEW_EMAIL`) the member account app store reviewers use. It is safe to run again.
5. **Start.** `pnpm --filter @quintara/api start`. Check `GET /health` returns `{"ok":true}` and
   `GET /v1/auth/config` returns `{"method":"code"}`.
6. **Web, admin and shop.** Build with `pnpm --filter @quintara/web build`, `pnpm --filter @quintara/admin build` and
   `pnpm --filter @quintara/maison build`, with `NEXT_PUBLIC_API_URL` set to the API address (and, for the shop,
   `NEXT_PUBLIC_APP_URL` to the web app; for the web app and admin, `NEXT_PUBLIC_MAISON_URL` to the shop).
7. **Content.** Production starts empty (the sample people and places are for development only). Sign in to the
   admin console with the code emailed to the first administrator and add experiences, partners, services, Maison Quintara
   items, Quintara TV, home photographs, descriptions and application questions.

This sequence was rehearsed on PostgreSQL 16 in production mode: migrations 0001–0032, first-run (twice), start-up
checks, code sign-in, the review account, plans and cities all behaved as described.

## 3. Build and submit the mobile apps

Accounts needed: Apple Developer Program (organisation), Google Play Console (organisation), and an Expo account.

The quickest way: `pnpm build:store` builds both and downloads `builds/quintara.aab` and `builds/quintara.ipa`
(see `docs/MOBILE_BUILDS.md`). Step by step, it does this:

```sh
npm install -g eas-cli
cd apps/mobile
eas login
eas init                      # links the project; writes extra.eas.projectId into app.json
eas build --platform ios --profile production
eas build --platform android --profile production
eas submit --platform ios --profile production       # fill the REPLACE_WITH_ values in eas.json first
eas submit --platform android --profile production   # needs a Google Play service account key (see eas.json)
```

- EAS creates and keeps the signing credentials (Apple certificates and profiles, the Android upload key) unless you
  supply your own. Keep the Android upload key safe: it signs every future update.
- Versions: `version` in `app.json` is what people see (1.0.0). Build numbers increase automatically on each
  production build (`autoIncrement`, remote version source).
- For testing before the stores: `eas build --profile preview` gives an installable Android APK and an internal iOS
  build; TestFlight takes the production iOS build.
- The first Android upload must be made in the Play Console or via `eas submit` to the internal track before the
  production track can be used.

### What the store builds already contain

- App name **Quintara**; identifiers `com.quintara.app` (iOS bundle and Android package). Confirm before the first
  upload: they cannot be changed afterwards, and must not already be taken.
- Icons (iOS, Android adaptive with monochrome), splash screen in Quintara ink, light and dark appearance.
- iOS privacy manifest (no tracking; the one system API used, UserDefaults, with its reason) and the export
  compliance answer (`ITSAppUsesNonExemptEncryption = false`: only standard HTTPS).
- Android: only the internet permission is needed; audio, overlay and storage permissions are explicitly removed.
- In-app account deletion (Apple and Google both require it): members under Profile, Privacy and your data, Close my
  account; guests under Profile, Delete guest account.
- Sign-in by a one-time code sent by email, then a code from an authenticator app (two-factor, required for every
  account); no passwords. No third-party sign-in, so Sign in with Apple is not required.

### Store listing answers (prepare in App Store Connect and Play Console)

- **App privacy / Data safety.** Collected and linked to the person, not used for tracking: name, email address,
  phone number (on the membership application), user ID, messages and QÉRA conversations (user content), purchase
  history (bookings, Maison Quintara orders), and the city chosen. Optional: WhatsApp number (if linked) and calendar
  events (if connected). Data is encrypted in transit; people can request deletion in the app.
- **Review notes.** "Quintara is a private members' club. Membership is by application. Use the review account:
  email `review@…`, then enter code `REVIEW_CODE` when asked for the one-time code, and `REVIEW_2FA_CODE` when
  asked for the authenticator code. Membership fees are paid on the
  web after approval; Maison Quintara sells physical goods and experiences are real-world events."
- Privacy policy URL, support URL, marketing URL (`https://quintaralifestyle.com`), age rating questionnaire,
  screenshots (iPhone 6.9" and 6.5", Android phone), description and keywords.

## 4. Pending actions

Items marked **Blocking** must be done before the apps can go to the stores with real members.

| # | Action | Who | Status |
|---|---|---|---|
| 1 | **Blocking.** Enrol in the Apple Developer Program and Google Play Console as an organisation (D-U-N-S number needed for Apple); create an Expo account. | Quintara | To do |
| 2 | **Blocking.** Host the API, PostgreSQL, the web app and the admin console on HTTPS; point the DNS (section 2). | Developer | To do |
| 3 | **Blocking.** Create a Resend account, verify quintaralifestyle.com for sending (SPF, DKIM), set `RESEND_API_KEY` and `EMAIL_FROM`. Without email nobody can sign in. | Developer | To do |
| 4 | **Blocking for taking money.** Choose the payment provider (for example Peach Payments, Paystack or Stripe) and write its adapter for the `PaymentProvider` interface in `apps/api/src/payments.ts`. Until then production refuses payments with a plain message (development and `DEPLOY_ENV=staging` simulate them); nothing is ever marked paid without money. The hosted checkout flow (start, redirect, signed webhook, return) is built and tested; the adapter implements `HostedCheckout` for the chosen provider (docs/DELIVERY_REPORT.md, section 4b). No card details are ever stored. | Quintara and developer | To do |
| 5 | **Blocking.** Run `migrate` and `first-run` on the production database (section 2). | Developer | To do |
| 6 | **Blocking.** Confirm the app identifiers `com.quintara.app` (or choose others) before the first upload. | Quintara | To confirm |
| 7 | **Blocking.** Publish a Privacy Policy and Terms on the website and give their addresses; add them to both store listings, and to the sign-in page next to About Quintara. | Quintara | To do |
| 8 | **Blocking.** Run `eas init`, fill the `REPLACE_WITH_` values in `eas.json`, build and submit (section 3). | Developer | To do |
| 9 | Prepare the store listings: screenshots, descriptions, privacy answers, review notes, age rating (section 3). | Quintara | To do |
| 10 | Add the real content in the admin console before launch: experiences, partners, services, Maison Quintara, TV, photographs. | Quintara | To do |
| 11 | POPIA: register the Information Officer with the Information Regulator; make sure the privacy policy names the processors (hosting, Resend, the payment provider, and Meta for WhatsApp). | Quintara (legal) | To do |
| 12 | Supply the logo as a vector or a 1024-pixel image for the final app icons; the current icons are made from the 220-pixel emblem. | Quintara | Recommended |
| 13 | Photographs in object storage: built (`MEDIA_S3_*`). Create the bucket (private, versioned), set the settings, upload a photograph in staging, and run `media:to-objects` for any stored before. A CDN can front `/v1/media`. | Developer | To do (configuration) |
| 14 | WhatsApp: Meta business verification, a WhatsApp Business number, the six `WHATSAPP_*` settings, and the webhook (README, "QÉRA on WhatsApp"). Until then the apps say it is not available yet. | Quintara and developer | When ready |
| 15 | Set `CALENDAR_SECRET` (32+ random characters) so members can connect their calendars. | Developer | To do |
| 16 | Monitoring: error reporting (for example Sentry) and uptime checks. With more than one API server, move the in-process rate limits to Redis. | Developer | Recommended |
| 17 | On a machine with internet access, run `npx expo install --check` and `npx expo-doctor` in `apps/mobile`. Two of expo-doctor's 21 checks need Expo's servers and could not run here; the other 19 passed. | Developer | To do |
| 18 | Optional: QÉRA on Claude. Set `ANTHROPIC_API_KEY` on the API (and optionally `QERA_MODEL`, `QERA_EFFORT`). Built and tested offline with a scripted client; not yet run against the live API. The rule-based model answers when no key is set or the API fails. | Quintara | Optional |
| 19 | **Blocking.** Set `MFA_ENCRYPTION_KEY` (and `REVIEW_2FA_CODE` with the review account), and back the key up. Then add the other admin console accounts (up to five) under Staff accounts. See docs/SECURITY.md, "Before launch". | Developer and Quintara | To do |
| 21 | Security before launch: the restricted database role (`app-role`) and the daily write-once audit copies (`AUDIT_S3_*`) are built and tested: set them up (docs/DEPLOYMENT.md). Still to do: commission an independent penetration test (docs/SECURITY.md). | Developer and Quintara | To do |
| 22 | **Blocking for push.** In EAS, add the push credentials: an Apple Push Notifications key (`eas credentials`, iOS) and a Firebase Cloud Messaging V1 service account key (Android). Run `eas init` first so the app has its Expo project ID. Optional: turn on enhanced push security in the Expo project and set `EXPO_ACCESS_TOKEN`. | Developer | To do |
| 23 | **Blocking for renewals.** Automatic renewals charge saved cards, so they wait for the real payment provider (item 4): its adapter needs `saveCard`, `removeCard` and charges by saved card (`paymentMethodToken`), and the web app's card form becomes the provider's own secure form (hosted fields or a hosted page). Until then renewals do not run in production. Have the renewal terms (automatic renewal, reminders 30 and 7 days before, 14 days' grace) checked against the Consumer Protection Act and put in the membership terms. | Developer and Quintara (legal) | To do |
| 24 | Choose which staff receive the weekly Insights report (Insights, "Email me the weekly report"). | Quintara | When ready |
| 20 | Membership fees and renewals are paid on the web, not in the iOS app (the iPhone app shows the membership and opens the web app to pay or change the card). Keep it that way, and have the review notes say so, as Apple may otherwise ask for in-app purchase. | Quintara | Note |
| 25 | Before launch, give each admin console account its role from the eight in docs/SECURITY.md. The Concierge Manager no longer edits TV, the home page, descriptions or Maison Quintara: that is the Content Manager's. | Quintara | To do |

## 5. What was checked for this hand-over

- Type checks for all 8 packages; 153 API tests (including push notifications, renewals and Insights, production sign-in by code, two-factor, staff accounts and the audit log, a guard over
  all 232 routes, WhatsApp, applications, order tracking, photographs, security), 8 client tests, 9 security tests.
- Production builds of the web app and the admin console.
- iOS and Android bundles exported; native iOS and Android projects generated from `app.json` without errors (then
  removed, as EAS generates them); Expo's 19 offline checks passed; native modules aligned with SDK 57.
- The real web and admin apps driven end to end in a browser, in development and in production sign-in mode.
- The API started in production mode on PostgreSQL 16, with a fresh database migrated and set up.
- All mock-up checks.

Native compilation for iOS (needs a Mac with Xcode) and Android (needs the Android SDK) happens on EAS Build's
servers and was not possible here; it is the first thing the release build will confirm.
