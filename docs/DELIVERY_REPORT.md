# Quintara: delivery report, November 2026

The audit of the repository, what was changed, how it was tested, the security position, and the status of every
feature the brief asks for. Branch `claude/gifted-wright-qapo61`. Nothing has been deployed or merged.

## 1. Audit: what was found

**The repository is a mature, working platform, not a set of placeholders.** It is a pnpm and Turborepo monorepo:

| Part | Technology | State found |
|---|---|---|
| API (`apps/api`) | Node 22, Fastify 5, PostgreSQL (PGlite in development and tests), zod | 232 routes, 32 migrations, 153 passing tests, every route permission-checked |
| Web app (`apps/web`) | Next.js 16, React 19 | Members, guests, applicants; connected to the API through one typed client |
| Admin console (`apps/admin`) | Next.js 16 | 25 pages over the staff API |
| Maison Quintara shop (`apps/maison`) | Next.js 16 | Public shop on the same API |
| Mobile app (`apps/mobile`) | Expo 57 | Out of scope for this brief; untouched apart from shared code |
| Shared (`packages/*`) | TypeScript | Domain rules, API client and an offline mock with the same rules, design tokens |

Authentication is passwordless by design: a one-time email code, then an authenticator app (two-factor, required in
production), with recovery codes. There are no passwords, so "password recovery" is account recovery through
recovery codes and an administrator's two-factor reset. This was kept: replacing it would be a redesign.

**Visual references.** The deployed design is the code itself (dark and light themes from `packages/design-tokens`,
Cormorant Garamond and Jost, the emblem and wordmark) plus the clickable mock-ups in `mockups/`. No pixel-exact
reference images exist, so automated visual comparison against "the uploaded versions" was not possible (section 4).
No colours, fonts or layouts were introduced; every screen changed uses the existing classes.

**Gaps found, in order of severity:**

1. *Critical.* Production used the simulated payment provider, which approves every charge: membership fees,
   paid seats and Maison orders would have been marked paid with no money taken.
2. *High.* The admin console had two staff roles; the brief requires eight with defined permissions.
3. *Medium.* An experience that had already started could still be booked and paid for. (Hidden in tests because the
   sample experiences were dated October 2026, which is now past.)
4. *Medium.* The admin Overview showed four counts worked out in the browser; no revenue, concierge or Maison figures.
5. *Medium.* QÉRA had only the rule-based model; no hosted AI integration.
6. *Medium.* No CI, no container image, no deployment guide, no committed end-to-end browser tests.
7. *Low.* Every admin console page was 720px wide on a 390px phone.
8. *Low.* `/health` depended on the database through the session lookup.
9. *Not built (choice needed).* A real payment provider. The `PaymentProvider` interface is ready, but the provider
   must be chosen by Quintara and merchant credentials issued (RELEASE.md item 4).

## 2. What was changed

| Commit | Change |
|---|---|
| `f6c2fa9` | Production refuses payments until a real provider is configured; staging may simulate (`DEPLOY_ENV=staging`). Renewals never run on a stand-in. |
| `f000621` | Eight staff roles, with three new finer permissions; console menus by role; migration 0033. |
| `8cffd49` | The Overview from `GET /admin/v1/dashboard`; past experiences cannot be booked; sample dates follow today; phone layout fix. |
| `f094b73` | QÉRA on Claude (official Anthropic SDK), server-side, behind the existing safeguards, with the rule-based model as fallback. |
| `e33c12d` | Fix of a staff/member role key collision found on real PostgreSQL; `/ready`; Dockerfile; CI. |
| `6c77124`, `2efabf0` | End-to-end browser journeys; housekeeping. |

**The eight roles** (server-enforced; `STAFF_ROLE_PERMISSIONS` in `packages/domain`):

| Role (key) | May |
|---|---|
| Super Administrator (`admin`) | Everything, including staff accounts, cities and the full audit log |
| Executive Administrator (`executive_admin`) | Figures and Insights, applications, members, money, Business, experiences, full audit log |
| Membership Manager (`membership`) | Applications, application questions, members and their roles |
| Experiences Manager (`experiences`) | Experiences, pricing, availability, guest lists, reservations, check-in |
| Concierge Manager (`concierge`) | Concierge and service requests, partner bookings, partners and services, experiences, check-in |
| Finance Manager (`finance`) | Tiers and fees, payments ledger, renewals, figures and Insights |
| Content Manager (`content`) | TV, home page, descriptions, partners and services, Maison Quintara and its orders |
| Support Administrator (`support`) | Concierge and service requests, guest lists, check-in |

Every role sees its own audit entries. Changing a role or suspending an account signs the person out of the console.

**Behaviour change to note:** the existing concierge desk account becomes the Concierge Manager and no longer edits TV,
the home page, descriptions or Maison Quintara. Give that work a Content Manager account.

## 3. Functional integration: verified workflows

Each line was exercised against the real API (on PostgreSQL in WebAssembly unless stated) by an automated test that
passed on the final code.

| Workflow | Evidence |
|---|---|
| Staff create and publish an experience; members see it; drafts stay hidden | e2e journey 1 (browser: admin console → web app) |
| A member books on the web; it is in their Bookings and on the console guest list | e2e journey 2 (browser) |
| A concierge request from the web reaches the desk | e2e journey 3 (browser) |
| Each staff role sees its own menu; the server refuses the rest | e2e journey 4; `staff-accounts.test.ts` role-by-route matrix |
| Web app and console fit a phone screen | e2e journey 5 (390px) |
| Overview figures equal the database and move when members act; sections by role | `dashboard.test.ts` |
| Payments refused in production; nothing marked paid | `payments-production.test.ts` |
| A started experience cannot be booked | `booking-integrity.test.ts` |
| QÉRA on Claude: lookups, proposals confirmed before booking, invalid arguments and unknown tools refused, guests read-only, fallback on failure, refusals | `qera-claude.test.ts` (scripted client, offline) |
| Membership lifecycle: apply, review, approve, pay, activate; declined card; repeated payment request | `staff.test.ts` (existing) |
| Bookings, waitlists, applications, payment holds, refunds, duplicates | `contract.test.ts` (existing; runs against both the API and the offline mock) |
| Sign-in by code, two-factor, staff accounts, audit chain, renewals, push, WhatsApp, order tracking, photographs, privacy, search | existing suites, all passing |
| A visitor becomes a member: guest account, application, approval with a discount, checkout payment | e2e (browser: web app → admin console → web app) |
| Concierge both ways: request, desk reply with options, member confirms | e2e (browser) |
| QÉRA plans a document and books only once the member says yes | e2e (browser) |
| Staff cancel a booking; the member sees the reason; finance refund from the ledger | e2e (browser) |
| A guest buys in the Maison shop, pays at the checkout; staff process and dispatch it; the buyer follows it with tracking | e2e (browser: shop → admin console → shop) |
| Every page reachable as visitor, member and each of the eight staff roles opens without an error or refusal | e2e crawls (`routes.spec.ts`, `admin-routes.spec.ts`) |
| Email (Resend), WhatsApp Cloud API, Expo push, calendar hosts and the Claude Messages API: the real adapters' requests, and their failures | `adapters.test.ts`, against local stand-ins of each API |
| The mobile app builds against the current API client and domain types | typecheck of all workspaces; iOS bundle export |
| Migrations 0001–0033 and first-run, each twice, on **PostgreSQL 16**; API ready on it | run by hand here; also a CI job |

## 4. Quality assurance

**Executed on the final code of stage 5 (10 November 2026).** The latest results, after Phases 2 to 6, are in section 4g.

| Suite | Result |
|---|---|
| Type-check, 9 packages | passed |
| API tests (unit, integration, security, contract), in memory, with an S3 protocol server | **184 passed, 0 failed**; 8 skipped that need PostgreSQL or Redis (153 tests before this work) |
| The same suite on **PostgreSQL 16, connected as the restricted production role** | **190 passed, 0 failed** (Redis tests skipped in that run; they pass with Redis) |
| Load test on PostgreSQL 16 (50 members at once, 20 s) | 568 requests/s, p95 158 ms, 0 errors (150 at once: 530/s, p95 495 ms, 0 errors) |
| Visual regression (40 screens, both themes, desktop and phone) | passed; deterministic across repeated runs |
| Offline-mock client tests | 8 passed |
| End-to-end browser journeys (Playwright, Chromium) | 9 passed |
| Accessibility (axe, WCAG 2.1 A and AA): 21 web, 15 admin and 3 shop views, both themes | no serious or critical violations |
| `pnpm audit --prod` for the API, web app, admin console and shop | no advisories |
| Production builds: web, admin, Maison | succeeded |
| Migrations and first-run on PostgreSQL 16 | succeeded, idempotent |
| API on its image's production-only dependencies | booted, `/ready` ok |

**Defects found and fixed during testing:** the role key collision (found only on real PostgreSQL), the Overview
under-counting seats held outside the app (seen in a screenshot), the phone layout overflow, liveness depending on
the database, past experiences being bookable, and sample data that had fallen into the past.

**Not done, stated plainly:**

- *Visual regression*: there were no reference images from the original design, so the baseline is the web app as it
  stands (reviewed by eye). It covers the web app, not the admin console or the shop, whose screens need the API's
  data; and it is not yet blocking in CI until recorded on the CI runner.
- *Load*: one API process on a 4-core machine shared with PostgreSQL and the load generator. Production figures
  depend on the host; more than one API process needs the shared (Redis) rate limits first.
- *Docker image build*: the Dockerfile's dependency step and runtime were verified outside Docker. A full `docker build`
  could not complete in this sandbox (its TLS proxy and BuildKit sessions); the CI job builds it.
- *QÉRA against the live Anthropic API*: not called (no key here). The request shape follows the current SDK types.
- *Mobile app*: not run on a device in this work (as before; RELEASE.md).
- *Camera scanning at check-in*: built on the browser's BarcodeDetector, which headless Chromium on Linux lacks, so
  decoding a ticket by camera was not automated. The QR image and check-in by its code are tested end to end.

## 4b. Stage 2: hosted checkout, QR tickets, phone layout

With the payment provider to be chosen later, stage 2 built everything a provider needs except its adapter.

- **Hosted checkout** (`apps/api/src/checkout.ts`). Bookings, Maison orders and membership fees are prepared and
  settled by shared functions; the app sends the member to the provider's page; a signed webhook and the member's
  return both settle the payment, exactly once. Money that arrives for something already paid or cancelled is refunded.
  Development and staging use a test checkout on the API (Pay or Decline, HMAC-signed webhooks). Production still
  refuses payments until an adapter is configured.
- **Apps.** Web (`/payments/return`), the Maison shop (its Thank you sheet) and mobile (the phone's browser) all pay
  through `payThrough` in `app-core`, which falls back to direct charges where the API simulates payments.
- **QR tickets** on the web Bookings page; **camera scanning** at admin Check-in where the browser supports it.
- **Fixes:** Insights tiles overflowed phones (the cause was a wide figure, not the chart as stage 1 said); the dev
  server's sign-in limit can be raised for test runs (never in production); `tsc` now rejects syntax Node cannot strip.

**Adding a real provider** means one class implementing `HostedCheckout` (`startCheckout`, `checkoutState`,
`readWebhook` with the provider's signature scheme) and `refund`, passed in `server.ts`, plus its webhook pointed at
`https://<api>/v1/payments/webhook`. Saved cards for automatic renewals (`saveCard`, charging by token) are a second,
provider-specific step.

## 4c. Stage 3: PostgreSQL, load, visual regression, live messaging

- **Every API test on real PostgreSQL** (`TEST_ALL_ON_POSTGRES=1`) and five dedicated races (`TEST_DATABASE_URL`): last
  seat among five members, ten Book presses, last Maison piece among five buyers, ten webhooks with ten return pages,
  ten Pay presses. **This found a deadlock** I had introduced with the checkout: two simultaneous Pay requests could
  take the booking and payment locks in opposite orders. Fixed in all three settle functions; CI now runs the suite
  on PostgreSQL. It also found that a dropped database connection would have ended the API process; the pool now
  handles it.
- **Load test** (`pnpm --filter @quintara/api load`, also in CI with a 500 ms p95 budget): results in section 4.
  Search is the costliest request (it gathers from every module); everything else stays near the median.
- **Visual regression** (`pnpm visual`): 40 screenshots of the web app on fixed data with a frozen clock. A 0.2 rem
  heading change fails it.
- **Live messaging** on the web: open conversations, the message list, notifications and the header's unread dots
  update while the page is visible, without a reload.

## 4d. Stage 4: accessibility, shared rate limits, mobile live updates, security updates

- **Accessibility** (`e2e/accessibility.spec.ts`, in CI): axe checks WCAG 2.1 A and AA in both themes. It found two
  problems, both fixed: a faint month label in the visitor date block (2.99:1 in light, 4.06:1 in dark; 4.5:1
  required), and shop cards whose accessible name left out their visible text. The visual suite was made stricter after
  it let the first fix through unnoticed.
- **Shared rate limits** through Redis (`REDIS_URL`), and a **graceful shutdown** on SIGTERM. Tested with two servers
  sharing a real Redis, a Redis outage, and a real SIGTERM.
- **Mobile**: messages and notifications refresh while the app is in the foreground.
- **Security updates**: Next.js 16.4.6 closes two critical unauthenticated remote code execution advisories in the
  version the apps used; zod, fastify and fast-uri patched too.

## 4e. Stage 5: object storage, a restricted database role, write-once audit copies

- **Photographs in object storage** (`MEDIA_S3_*`): bytes in a private S3-compatible bucket, details in PostgreSQL,
  served at the same addresses. Images stored earlier keep working and move with `media:to-objects`. A trigger queues
  every deleted photograph so its files leave the bucket too; without it, erased members' pictures would have stayed.
- **A restricted database role** for the API (`app-role`): data only, owning nothing, so the audit log's triggers
  cannot be lifted through it. CI runs every API test as this role, which proves it has everything the API needs.
- **Daily write-once copies of the audit log** (`AUDIT_S3_*`, S3 Object Lock in compliance mode), recorded in
  `audit_exports` and checkable with `audit:check-copies`.
- Tested against an S3 protocol server (moto) as well as in memory: Docker Hub was rate-limiting and the MinIO
  image's registry was not reachable from this environment. moto is an emulator, so check the first real bucket in
  staging. The retention period (2,555 days by default) is for legal confirmation.

## 4f. Phases 2 to 5: services, web app, console, integration

Phase 2 (back-end services) closed four gaps found on a second audit against the brief:

- **Cancellations decided by Quintara.** Staff cancel one booking with a reason, and finance chooses the refund (all,
  part or none). Cancelling a whole experience cancels every booking and refunds everyone in full, whatever the
  refund window. An experience can no longer be set to "cancelled" by a plain edit, which would skip its guests. The
  member sees the reason on the booking as well as in a notification.
- **Discounts on membership fees**, granted by finance when an application is approved (an amount or a percentage,
  with a reason), audited, charged through either payment path, and shown to the applicant as fee, discount and
  amount due. A full discount starts the membership at once.
- **No silent caps.** The payments ledger showed only the latest 200 payments and totalled only those. It now pages
  and totals every payment by currency. Payments and members export as CSV (finance and admin roles only; every
  export audited; spreadsheet formulas neutralised).
- **Data retention (POPIA).** Hourly deletion of working records past their period (ended sessions, used codes,
  delivered emails and so on; table in SECURITY.md). The periods are defaults for legal review.

Phase 3 (web app completion), completed:

- Every member and guest method of the API is called from a web screen. The only exception is push notification
  settings, which are phone-only by design.
- No placeholders or dead controls were found. "Coming soon" appears only on a TV episode that has no video yet.
- A new e2e test (`e2e/routes.spec.ts`) crawls the web app through its own links, once as a visitor (28 pages) and
  once as a member (34 pages, including experience, lifestyle, service and member pages behind ids). It fails on
  uncaught errors, console errors, server errors, error pages and links to missing pages. Both runs pass.

- Browser journeys for the member flows not yet covered end to end, all passing:
  - **The membership funnel:** a visitor makes a guest account and applies through every step; the application is
    approved with a 50% discount; the applicant sees fee, discount and amount due, pays at the checkout and becomes
    an active member.
  - **Concierge both ways:** the desk replies with options, and the member confirms them on the request's own page.
  - **QÉRA:** a weekend plan saved as a document (opened and deleted); seats booked only after the member says yes.
- Visual baselines unchanged: the design is untouched.

Phase 4 (admin console completion):

- Every staff method of the API is used by a console screen. The exception is `uploadImage`, which `uploadPhoto`
  (with cropping) replaced.
- No placeholders or dead controls.
- A new e2e test (`e2e/admin-routes.spec.ts`) signs in as each of the eight roles and follows the console's links.
  It found:
  - **Support could not open a single guest list.** The role is for guest lists and check-in, but the guest lists
    sit on experience pages that needed the experiences permission. Guest-list staff may now read experiences;
    editing, creating and cancelling still need the experiences permission, and those controls are hidden from
    everyone else.
- A second gap came from checking the console's own text against what it does:
  - **The console promised refunds it had no way to make.** It told the desk that a Finance Manager could refund a
    cancelled booking "afterwards from Payments", but the Payments page could not refund anything. Finance now
    refund any received payment there, in full or in part, with an audited reason; the payer is told.
  - While building it, I found two simultaneous identical refunds would have been counted twice in the ledger
    (refunded once by the provider). Fixed, and tested on PostgreSQL.

Phase 5 (integration):

- **Outside services on the wire.** The real adapters for Resend, the WhatsApp Cloud API, Expo push, calendar hosts
  and the Claude Messages API had never run in a test; only their stand-ins had. `test/adapters.test.ts` now runs
  each against a local server that answers as the provider's API does. It checks address, credentials, body, and
  behaviour when the service fails. One test sends a signed WhatsApp delivery through the whole app and out through
  the Cloud API adapter. What this cannot prove is that the real services accept the requests: DEPLOYMENT.md has a
  one-time check for each in staging.
- Fixed along the way:
  - **Duplicate emails:** a retry after a lost answer from Resend could deliver a message twice. Each message now
    carries an idempotency key.
  - **Duplicate pushes:** when Expo refused a later batch of 100, the batches already delivered were pushed again.
    Only the rest is now retried.
  - **Cut-off QÉRA answers:** the default model always thinks, and thinking counts towards the 4,096-token ceiling,
    so long answers could be cut off. Raised to 16,000.
  - SDK 1.x sends the API key as a bearer token: noted, and checked by the test.
- **The Maison shop's checkout return.** A buyer coming back from the checkout could see neither the order nor its
  payment: the shop read the payment id inside an effect and cleared it from the address at once. Fixed, and the
  whole shop journey (shop, console, buyer's tracking) is now an e2e test.
- **Mobile.** Every workspace typechecks against the changed domain types (Phases 2 to 5), and the iOS bundle
  builds. The app was not run on a device here.

Evidence at this point:
- API: 212 tests, 201 passing, 0 failing, 11 skipped; the skipped tests need PostgreSQL, Redis or S3 and run in CI.
- The retention test also passed on PostgreSQL 16 as the restricted role.
- e2e: 30 tests, all passing. These include the eight role crawls, the two web crawls and the new journeys.
- Visual regression: 8 of 8 passing.

## 4g. Phase 6: testing

**Executed on the final code of Phase 6 (10 November 2026):**

| Suite | Result |
|---|---|
| Type-check, 9 workspaces | passed |
| API tests, in memory | **219 tests: 208 passed, 0 failed**, 11 skipped (those need PostgreSQL, Redis or S3) |
| The same suite on **PostgreSQL 16 as the restricted app role, with Redis 7 and an S3 server** (as CI runs it) | **219 passed, 0 failed, 0 skipped** |
| API coverage (in memory) | 97.4% of lines, 82% of branches. The rest is mostly start-up code (`server.ts`) and the PostgreSQL and S3 code that the run above covers |
| End-to-end browser tests on the development servers | **30 passed** |
| The same 30 against **production builds** (`next build`, `next start`) of the web app, console and shop | **30 passed** |
| Visual regression, web app (40 screens) | 8 of 8 passing, unchanged |
| Accessibility (axe, WCAG 2.1 A and AA), web, console, shop, both themes | no serious or critical violations |
| Load: 50 members at once for 30 s, on PostgreSQL 16 | 509 requests/s, p95 178 ms (limit 500), 0 server errors |
| Production builds: web, console, shop; mobile iOS bundle | succeeded |
| `pnpm audit --prod` | none in the API, web app, console or shop. 7 in Expo's command-line tools (mobile builds only), down from 19; see below |

**How the gaps were found.**
- *Coverage.* Measuring coverage showed which code no test ran. Where money, accounts or security were at stake, a
  test was written for each path:
  - the renewals desk, and retrying a member's card;
  - a membership fee or an order paid after it was withdrawn or cancelled;
  - an unpaid order released after its hold;
  - a refund the provider refuses;
  - declining a booking, and offering a seat from the waiting list;
  - reinstating a closed account, and the scheduled erasure;
  - moving two-factor to a new phone, new recovery codes, and turning two-factor off.

  All of these passed as written: none of these paths was broken.
- *Production builds.* Running the e2e suite against production builds found a real deployment defect. A web app or
  shop built without `NEXT_PUBLIC_API_URL` ran on its offline demo data, looking as if it worked; the console
  called localhost. A production build now stops with an error until the address is set.

**Dependencies.** All 19 advisories were in Expo's command-line tools, which run only when the mobile app is built,
not in anything deployed.
- *Fixed:* twelve came from `node-forge` 1.4.0, now pinned to 1.4.1 or later (same minor version).
- *Left:* seven (uuid, zod 3, glob, minimatch, decode-uri-component, deepmerge) need major upgrades inside Expo's own
  dependencies, which could break the mobile build. They wait for Expo's next release.

**Not done, stated plainly.**
- *Real outside services:* email, WhatsApp, push, Claude, calendars and S3 were tested against stand-ins of their
  APIs, not the services themselves. DEPLOYMENT.md lists a one-time check for each in staging.
- *Payments:* tested with the test checkout only, until a provider is chosen.
- *Mobile app:* typechecked and bundled, not run on a device or simulator.
- *Visual regression:* covers the web app only. The console and shop show live, dated data; they would need frozen
  data to compare screenshots reliably.
- *CI:* the e2e job still runs against development servers. Running it against production builds as well, as here,
  would have caught the missing-address defect; it is a recommended addition.
- *Load:* measured on one machine shared with the database and the load generator; production figures depend on the
  host.
- *Camera scanning at check-in:* as before, not automatable here.

## 5. Security assessment

Already strong before this work (docs/SECURITY.md): two-factor for every account, hashed tokens, separate staff
sessions, CSRF origin checks, zod validation everywhere, parameterised SQL, security headers and CSP, an append-only
hash-chained audit log, rate limits, encrypted secrets at rest, upload checking and re-encoding, POPIA export,
consent records and erasure. A route-guard test calls all routes as a visitor and as a member.

Added: findings 14–18 in docs/SECURITY.md (payments fail-safe, role key collision, past bookings, probe isolation,
Insights permission), and in stage 2 the checkout's protections (signed webhooks checked on the raw body, return
addresses limited to Quintara's apps, exactly-once settlement, refunds of late money). The Anthropic key stays on the server, and QÉRA can only propose actions, never take them.

**Outstanding risks before launch:** a real payment provider's adapter for the hosted checkout (no card data at Quintara); an
independent penetration test; setting up the restricted role and the two buckets (built and tested); `REDIS_URL` set once more
than one API process runs; the Expo SDK advisories (build tooling, and expo-router on the phone).

**For professional review:** POPIA registration of the Information Officer and a privacy policy naming the processors
(hosting, Resend, the payment provider, Meta, and Anthropic if QÉRA uses Claude); the membership and automatic-renewal
terms against the Consumer Protection Act; the "not financial advice" wording.

## 6. Feature verification matrix

Statuses: **Tested** = implemented and tested. **Credentials** = implemented, awaiting external credentials.
**Partial** = partially implemented. **Blocked**. **Not built** = not implemented.

| Area | Feature | Status | Note |
|---|---|---|---|
| Membership | Application with plans, questions, phone, social handle | Tested | existing |
| | Review, approve with tier, decline, waitlist | Tested | existing |
| | Invitation-only experiences; guest accounts | Tested | existing |
| | Sign-in, sign-out, email verification by code, two-factor | Tested | existing |
| | Password recovery | n/a | passwordless; recovery codes and admin reset (tested) |
| | Profiles, privacy settings, data export, account closure | Tested | existing |
| | Tiers, fees, privileges configurable in the console | Tested | existing |
| | Renewal and expiry tracking, reminders | Tested | charging waits for a payment provider |
| | Membership payment | Partial | hosted checkout flow built and tested with the test checkout; the provider's adapter waits on its choice and merchant credentials |
| | Digital membership card | Partial | card with member number on Profile (existing); not separately tested in this work |
| Experiences | Listings, details, categories, capacity, limits | Tested | existing |
| | Booking, waitlist, applied, complimentary and paid holds | Tested | existing |
| | Paying for seats through the hosted checkout | Partial | flow tested end to end with the test checkout (e2e); real provider adapter pending |
| | Cancellation and refund rules | Tested | refunds run through the provider; blocked like payments in production |
| | Past experiences cannot be booked | Tested | new |
| | Ticket codes and check-in | Tested | existing |
| | QR codes on tickets; camera scanning at check-in | Tested | QR and check-in by its code tested end to end; camera decoding not automatable here (section 4) |
| | Notifications and email | Tested | email needs `RESEND_API_KEY` (Credentials) |
| | Create, edit, publish, guest lists, attendance in the console | Tested | e2e and existing |
| Concierge and lifestyle | Requests, desk replies, stages, member confirmation | Tested | existing; e2e |
| | Lifestyle services, packages, requests; partners and privileges | Tested | existing |
| | Partner bookings confirmed by the partner, never assumed | Tested | existing |
| Maison Quintara | Products, stock, member pricing, cart, guest orders, tracking | Tested | existing |
| | Checkout payment | Partial | as membership payment |
| Networking | Directory, connections, messages, blocking, reports | Tested | existing |
| | Live messages and unread indicators | Tested | web (e2e); mobile refreshes in the foreground (typecheck and iOS bundle only, not run on a device) |
| QÉRA | Rule-based model, tools, proposals, memory, briefs | Tested | existing |
| | Claude as hosted model | Credentials | `ANTHROPIC_API_KEY`; request and responses tested against a stand-in of the Messages API |
| | WhatsApp | Credentials | six `WHATSAPP_*` settings; Cloud API adapter tested against a stand-in, end to end |
| Admin | Overview from the database, by role | Tested | new |
| | Insights and CSV export | Tested | existing |
| | Eight roles, server-enforced | Tested | new |
| | Audit log, staff activity, integrity check | Tested | existing |
| | Content management (TV, home page, descriptions, questions) | Tested | existing |
| Platform | Readiness probe, Dockerfile, CI, deployment guide | Tested | image build itself runs in CI |
| | Concurrency on PostgreSQL, load tests | Tested | stage 3 |
| | Visual regression | Tested | web app; admin and shop not covered (section 4) |
| | Accessibility (WCAG 2.1 AA, automated) | Tested | web, admin, shop; a manual screen-reader review is still advised |
| | Shared rate limits, graceful shutdown | Tested | Redis needed in production once more than one API process runs |
| | Photographs in object storage | Credentials | built and tested (in memory and an S3 protocol server); needs a bucket |
| | Restricted database role | Tested | every API test runs as it in CI |
| | Write-once daily audit copies | Credentials | built and tested; needs a bucket with Object Lock; retention period for legal review |
| | Staff cancellations with finance-approved refunds; whole-experience cancellation | Tested | Phase 2; e2e |
| | Membership fee discounts | Tested | Phase 2 |
| | Maison shop to console to buyer tracking | Tested | Phase 5 e2e |
| | Email and push adapters: no duplicates on retry | Tested | Phase 5, against stand-ins; real services: Credentials |
| | Payments ledger paging, totals; payments and members CSV export | Tested | Phase 2 |
| | Data retention (POPIA) | Tested | Phase 2; periods for legal review |
| | Every web page opens without errors (visitor, member) | Tested | Phase 3 crawl |
| | Membership funnel in the browser: guest account to active member, with a discount | Tested | Phase 3 e2e |
| | Every console page each role is offered opens, unrefused (eight roles) | Tested | Phase 4 crawl |
| | Refunds from the payments ledger (finance) | Tested | Phase 4; real refunds wait on the provider, as payments |
| | Support role: guest lists and check-in | Tested | Phase 4 fix |
| | Production deployment | Blocked | needs approval, hosting accounts and DNS |

## 7. GitHub and approvals

- Branch `claude/gifted-wright-qapo61`, on the initial commit `3aeb174` (stage 1: 9 commits; stage 2 below). No pull request opened yet; nothing
  merged. CI runs on push once the workflow is on GitHub.
- **Decisions and approvals needed from Quintara:** the payment provider (for example Peach Payments, Paystack or
  Stripe) and merchant credentials; hosting accounts and DNS; Resend; whether QÉRA should use Claude (and an
  Anthropic key); staff role assignments; the legal reviews in section 5; approval to deploy.
