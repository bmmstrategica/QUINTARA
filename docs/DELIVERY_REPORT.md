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
| Migrations 0001–0033 and first-run, each twice, on **PostgreSQL 16**; API ready on it | run by hand here; also a CI job |

## 4. Quality assurance

**Executed on the final code (9 November 2026):**

| Suite | Result |
|---|---|
| Type-check, 9 packages | passed |
| API tests (unit, integration, security, contract) | **167 passed, 0 failed** (153 before this work) |
| Offline-mock client tests | 8 passed |
| End-to-end browser journeys (Playwright, Chromium) | 5 passed |
| Production builds: web, admin, Maison | succeeded |
| Migrations and first-run on PostgreSQL 16 | succeeded, idempotent |
| API on its image's production-only dependencies | booted, `/ready` ok |

**Defects found and fixed during testing:** the role key collision (found only on real PostgreSQL), the Overview
under-counting seats held outside the app (seen in a screenshot), the phone layout overflow, liveness depending on
the database, past experiences being bookable, and sample data that had fallen into the past.

**Not done, stated plainly:**

- *Visual regression against reference images*: no reference images exist. Changed screens were checked by eye in
  screenshots at 1440px and 390px. A baseline could be recorded now (Playwright `toHaveScreenshot`) to guard future work.
- *Performance and load tests*: not run. The bookings path locks the experience row, and the concurrency test runs
  on a single in-memory connection; repeat both on PostgreSQL under load before launch.
- *Docker image build*: the Dockerfile's dependency step and runtime were verified outside Docker. A full `docker build`
  could not complete in this sandbox (its TLS proxy and BuildKit sessions); the CI job builds it.
- *QÉRA against the live Anthropic API*: not called (no key here). The request shape follows the current SDK types.
- *Mobile app*: not run on a device in this work (as before; RELEASE.md).
- *Known minor issue*: on a 390px phone the Insights chart's axis labels overhang the page by 14px.

## 5. Security assessment

Already strong before this work (docs/SECURITY.md): two-factor for every account, hashed tokens, separate staff
sessions, CSRF origin checks, zod validation everywhere, parameterised SQL, security headers and CSP, an append-only
hash-chained audit log, rate limits, encrypted secrets at rest, upload checking and re-encoding, POPIA export,
consent records and erasure. A route-guard test calls all routes as a visitor and as a member.

Added: findings 14–18 in docs/SECURITY.md (payments fail-safe, role key collision, past bookings, probe isolation,
Insights permission). The Anthropic key stays on the server, and QÉRA can only propose actions, never take them.

**Outstanding risks before launch:** a real payment provider with hosted checkout (no card data at Quintara); an
independent penetration test; a non-superuser database role; daily write-once audit export; Redis-backed rate limits
with more than one API process; `pnpm audit` advisories in Expo build tooling (not on servers).

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
| | Membership payment | Blocked | provider choice and merchant credentials |
| | Digital membership card | Partial | card with member number on Profile (existing); not separately tested in this work |
| Experiences | Listings, details, categories, capacity, limits | Tested | existing |
| | Booking, waitlist, applied, complimentary and paid holds | Tested | existing |
| | Cancellation and refund rules | Tested | refunds run through the provider; blocked like payments in production |
| | Past experiences cannot be booked | Tested | new |
| | Ticket codes and check-in | Tested | existing |
| | QR codes on tickets | Partial | text ticket codes only; no QR image or scanner |
| | Notifications and email | Tested | email needs `RESEND_API_KEY` (Credentials) |
| | Create, edit, publish, guest lists, attendance in the console | Tested | e2e and existing |
| Concierge and lifestyle | Requests, desk replies, stages, member confirmation | Tested | existing; e2e |
| | Lifestyle services, packages, requests; partners and privileges | Tested | existing |
| | Partner bookings confirmed by the partner, never assumed | Tested | existing |
| Maison Quintara | Products, stock, member pricing, cart, guest orders, tracking | Tested | existing |
| | Checkout payment | Blocked | as membership payment |
| Networking | Directory, connections, messages, blocking, reports | Tested | existing; the web screens refresh by link, not live (README) |
| QÉRA | Rule-based model, tools, proposals, memory, briefs | Tested | existing |
| | Claude as hosted model | Credentials | `ANTHROPIC_API_KEY`; tested offline only |
| | WhatsApp | Credentials | six `WHATSAPP_*` settings |
| Admin | Overview from the database, by role | Tested | new |
| | Insights and CSV export | Tested | existing |
| | Eight roles, server-enforced | Tested | new |
| | Audit log, staff activity, integrity check | Tested | existing |
| | Content management (TV, home page, descriptions, questions) | Tested | existing |
| Platform | Readiness probe, Dockerfile, CI, deployment guide | Tested | image build itself runs in CI |
| | Visual regression, load tests | Not built | section 4 |
| | Production deployment | Blocked | needs approval, hosting accounts and DNS |

## 7. GitHub and approvals

- Branch `claude/gifted-wright-qapo61`, 7 commits on the initial commit `3aeb174`. No pull request opened yet; nothing
  merged. CI runs on push once the workflow is on GitHub.
- **Decisions and approvals needed from Quintara:** the payment provider (for example Peach Payments, Paystack or
  Stripe) and merchant credentials; hosting accounts and DNS; Resend; whether QÉRA should use Claude (and an
  Anthropic key); staff role assignments; the legal reviews in section 5; approval to deploy.
