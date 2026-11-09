# Quintara

Monorepo for the Quintara web app, mobile app and the packages they share.
This is the Phase 1 foundation: a real API on PostgreSQL for the first slice of features,
and apps that run against either that API or an in-browser mock with the same rules.

**Going live and publishing to the App Store and Google Play: see [docs/RELEASE.md](docs/RELEASE.md)**, which also
lists the actions still pending. Deploying the backend and the three web apps: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
The audit, test results and feature status of the November 2026 completion work: [docs/DELIVERY_REPORT.md](docs/DELIVERY_REPORT.md).

## Run it

Requires Node 22+ and pnpm 12.

```sh
pnpm install
pnpm dev:api       # the API on http://localhost:4000, with an in-memory database and sample data
pnpm dev:web       # the web app on http://localhost:3000
pnpm dev:admin     # the admin app on http://localhost:3001 (staff: admin@example.com or desk@example.com)
pnpm dev:maison    # the Maison Quintara shop on http://localhost:3002
pnpm dev:mobile    # Expo: press i (iOS simulator) or a (Android), or scan the QR code in Expo Go
pnpm typecheck     # every package and app
pnpm test          # mock tests, contract tests and security tests
pnpm e2e           # browser journeys across the web app, admin console and API (Playwright)
```

To connect the web app to the API, copy `.env.example` to `apps/web/.env.local`.
Sign in as `thandi@example.com` (sample member). Without that file the web app runs on the in-browser mock.

Use `localhost` for both the web app and the API (not `127.0.0.1` for one of them), or the browser
will treat them as different sites and withhold the session cookie.

## Structure

```text
apps/
  api/       Fastify + PostgreSQL: the real API for the Phase 1 slice
  admin/     Next.js 16: the staff console (applications, members, experiences, guest lists, concierge desk, check-in, member reports, insights)
  web/       Next.js 16 (App Router): public site and member app
  mobile/    Expo 57 (expo-router): iOS and Android
packages/
  design-tokens/  colour, type and spacing; web turns them into CSS variables, mobile reads them directly
  domain/         types, statuses, permission keys, validation schemas, formatting
  api-client/     the QuintaraApi contract, a REST client, and a mock implementation with tests
  app-core/       React provider and hooks shared by web and mobile (session, data loading, actions)
db/
  migrations/     versioned SQL, applied in order by `pnpm --filter @quintara/api migrate`
docs/
  quintara_schema.sql   the full target data model; migrations implement it phase by phase
```

Still to come from the blueprint: `infra/`, and the identity, payment and email providers.

## The API

- **One route per contract call.** `apps/api/src/app.ts` maps the 119 calls in `QuintaraApi` (`setMarket` only chooses the city sent with each request) to module
  functions in `experiences.ts`, `members.ts`, `applications.ts`, `membership.ts`, `concierge.ts`,
  `messaging.ts` and `notifications.ts`.
- **Concierge.** Members send requests and talk to the desk inside each one; the desk replies and moves the
  request through its stages; the member confirms the options offered. Each step notifies the member.
- **Messaging.** Connected members can write to each other. A conversation is reachable only by its two
  participants. There are no live updates yet: the screens have a refresh link until the real-time service is added.
- **Staff routes under `/admin/v1`** (`admin.ts`): review and approve applications with a tier, list and
  suspend members, grant founder, investor and creator roles, create and edit experiences, send invitations,
  read guest lists, confirm or decline waitlisted and applied bookings, and check guests in by ticket code.
  Staff roles (`admin`, `concierge`) are separate from member roles; the desk cannot decide memberships.
- **Membership lifecycle.** Apply, review, approve with a tier, pay, activate. Activation creates the profile,
  the member record and a membership number from a sequence. Investor access is never granted by applying.
- **Payments** go through the `PaymentProvider` interface in `payments.ts`. Only a mock provider exists;
  write an adapter for the real provider and pass it in `server.ts`. Each attempt has an idempotency key.
- **Permissions.** Every handler calls `requirePermission` or `requireMember` with a permission key from
  `packages/domain`. A suspended member has no roles, so every member check fails closed.
- **Sessions.** An HttpOnly, SameSite cookie carries a random token; only its SHA-256 hash is stored.
  The mobile app can send the same token as a bearer header.
- **Sign-in is a development stand-in.** `AUTH_MODE=dev` signs in any registered member or staff account by
  email alone and the server refuses to start with it in production. Replace `POST /v1/session` and
  `POST /admin/v1/session` with the identity provider. Attempts are limited per address per minute.
  Sample accounts: `thandi@example.com` (member); staff `admin@example.com` (Super Administrator),
  `desk@example.com` (Concierge Manager) and `content@example.com` (Content Manager).
- **Bookings are transactional.** The experience row is locked while seats are counted, and a partial
  unique index allows one live booking per member per experience.
- **Audit.** Bookings, cancellations, connections and application submissions are written to an
  append-only `audit_logs` table.
- **Database.** PostgreSQL in real environments (`DATABASE_URL`). With no URL the API runs on PGlite,
  PostgreSQL compiled to WebAssembly, so development and tests need nothing installed.
- **Framework.** Fastify, not NestJS as the blueprint proposed: the same module-per-domain structure
  without a decorator build step. Moving to NestJS later means wrapping these module functions in providers.

### Tests

`apps/api/test/contract.test.ts` runs one set of scenarios against both the mock API and the real API,
so the apps behave the same whichever they are connected to. `security.test.ts` covers what only the
real API has: cookies, token hashing, isolation between members, hidden experiences, suspension, the
audit log and malformed input. `staff.test.ts` covers the staff routes and the whole membership lifecycle,
including a declined card, a repeated payment request and the sign-in limit.

Not yet done on the API: row-level security policies in the database, rate limiting beyond sign-in,
idempotency keys on bookings, pagination, partial refunds, a real payment provider, message attachments
and live delivery of messages. The admin app covers
applications, members, tiers, payments, experiences, guest lists, check-in, reports and insights; content has no screen yet. The concurrency test runs on a single in-memory
connection, so repeat it against a real PostgreSQL before relying on it.

## How the apps reach data

Screens depend only on the `QuintaraApi` interface in `packages/api-client`.

- With no API URL set, each app uses `createMockApi()`. It applies permissions,
  admission types, capacity and validation, so loading, empty, error and permission-denied
  states are all real.
- Set `NEXT_PUBLIC_API_URL` (web) or `EXPO_PUBLIC_API_URL` (mobile) to switch to `createHttpApi()`,
  the REST client for the API in `apps/api`. See `.env.example`.

## Conventions

- Check a permission (`can(session, 'experiences.book')`), never a role name.
- Every screen loads through `useResource` and renders through `ResourceView`, which handles
  loading, error, permission-denied and empty states in one place.
- Every mutation goes through `useAction`, which gives pending and error state and blocks double submission.
- Validation schemas live in `packages/domain` and are used by forms and by the API.
- Dates are formatted in the time zone of the place an experience happens. Money is stored in minor units.
- Nothing is tied to Cape Town: experiences carry a market, a currency and a time zone.

## Placeholder content

Member names, experiences, venues, dates and prices in `packages/api-client/src/mock.ts` are invented.

## Member safety and insights (migration 0004)

- **Blocking.** `PUT/DELETE /v1/members/:id/block` and `GET /v1/me/blocks`. A block hides each member from the
  other in the directory, profiles, connections and messages, and removes any connection between them. The
  blocked member gets the same "not available" answer as for a profile that does not exist, and cannot see
  or lift the block.
- **Reporting.** `POST /v1/members/:id/reports` with a fixed reason and optional detail. One open report per
  pair. Reports are read only by staff with `admin.members.manage` (`GET /admin/v1/reports`,
  `POST /admin/v1/reports/:id/resolve`); resolving as `suspended` suspends the member and ends their sessions.
- **Insights.** `GET /admin/v1/insights` returns counts and totals only (seats filled, money received by
  purpose, membership and application counts, concierge requests by category, club activity). It never
  returns a name or an email.
- Web: the Safety section on a member's profile and the Blocked list on the members page.
  Admin: Reports on the Members page, and the Insights page.

## Mock-ups

`mockups/` holds the clickable design mock-ups as single HTML files that open in any browser, with no server:
`quintara-mobile-web-admin.html` (the current one, all three views) and `quintara-product-guide.html`.
They show the whole intended product, including parts the code here does not implement yet (QÉRA, lifestyle
partners, privileges, opportunities, TV, boutique and its wishlist, paying for experiences). Their data lives
in the browser only.

## Look and feel

The web app, admin console and mobile app all use the one dark brand theme from `packages/design-tokens`
(near-black ground, ivory type, champagne accent; Cormorant Garamond and Jost), with the Quintara emblem and
wordmark in `public/`. There is no light theme.

## Paying for experiences (migration 0005)

- Booking a paid experience creates the booking as `awaiting_payment` and holds the seats for the experience's
  `payment_hold_minutes` (default 30). Held seats count as taken; a hold that is never paid stops counting and
  is cancelled. Complimentary experiences are confirmed at once, as before.
- `POST /v1/me/bookings/:id/pay` charges the member price times the seats through the `PaymentProvider`
  interface and confirms the booking. The idempotency key is derived from the booking on the server, so two
  tabs or a double click produce one charge. A declined card leaves the hold in place.
- Cancelling a paid booking refunds it in full while the experience is more than `refund_hours` away
  (default 48); after that nothing is refunded. A refund the provider refuses is written to the audit log as
  `refund.failed` for staff to settle.
- When staff confirm an applied or waitlisted booking on a paid experience, the member gets two days to pay.
- No card data touches Quintara. `MockPaymentProvider` stands in until a real provider adapter is written.

## Mobile app

Tabs: Home, Experiences, Members, Concierge, Profile. From Profile: Bookings (pay, cancel, ticket code),
Messages and Notifications. A member's profile has Connect, Send a message, and Safety (report, block);
blocked members are listed on the Members tab with Unblock. Every payment, cancellation, confirmation and
block asks first.

With `EXPO_PUBLIC_API_URL` set, the app calls the real API. The session is the same HttpOnly cookie the web
app uses, kept by the device's own cookie store, so app code never holds the token. On a phone, use the
computer's network address rather than `localhost`, and start the API with `HOST=0.0.0.0`.

Checked so far by type-checking and by building the iOS bundle (`npx expo export --platform ios`). It has not
yet been run on a simulator or a phone, and the membership application form exists only on the web.

## Tiers, payments and payment rules in the admin console

- **Tiers** (`/tiers`): add a tier, change its fee or billing period, retire it or offer it again. A retired
  tier cannot be offered to new applicants; a tier's currency never changes. Price changes are audited with
  the previous price.
- **Payments** (`/payments`): a read-only ledger of charges and refunds with a filter and net totals.
- **Payment rules** on a paid experience's page: how long seats are held and how late a full refund is given.
- These need the new staff permission `admin.finance.manage`, which only the `admin` role has.

## Privacy and email (migration 0006)

- **Privacy settings** (`GET/PUT /v1/me/privacy`): directory listing and promotional email. Promotion is off
  until switched on. Every change is written to `consent_events`, which is never edited.
- **Data export** (`GET /v1/me/data-export`): one JSON file of everything held about the member. Other
  people appear by name only, and only the member's own messages are included.
- **Closing an account** (`POST /v1/me/account/close`, confirm with the word CLOSE): bookings are cancelled
  and refunded where the experience's rules allow, the membership ends, every session is revoked, and erasure
  is scheduled 30 days on (`ERASURE_DELAY_DAYS`). Staff can reinstate before then or erase at once.
- **Erasure** replaces the name, clears the profile, application and email address, and blanks the member's
  messages and concierge text. Payment and audit records are kept. The server erases due accounts every minute.
- **Email**: a database trigger copies every notification into `email_outbox`; promotional categories are
  skipped without consent. `deliverEmails` sends after each request and again every minute, retries a failed
  send up to five times, and never delays the action that caused the message. `MockEmailProvider` stands in
  until a mail service is chosen; links use `WEB_URL`.
- Web: Privacy and Your data on the profile page. Admin: Closed accounts on the Members page.
  The mobile app does not have these screens yet.

## Lifestyle partners and privileges (migration 0007)

- **Members** (`privileges.use`): `GET /v1/partners`, `GET /v1/partners/:id`,
  `POST /v1/privileges/:id/redemptions`, `GET /v1/me/redemptions`. Redeeming issues a `QP-` code to show the
  partner. Each privilege has a per-member limit (0 for none) and an optional last day; the limit is checked
  under a lock, so two taps cannot both pass. Nothing about the member is sent to the partner.
- **Staff** (`admin.providers.manage`: Super Administrator, Concierge Manager, Content Manager): create and edit partners and
  privileges, publish, unpublish, archive. A privilege is visible only when it and its partner are both
  published. Staff see how many codes were issued, never who redeemed.
- Categories are free text set by staff. Web: `/lifestyle`. Admin: `/partners`. Not on mobile yet.
- Not built: a way for the partner to confirm a code at the door, and partner photography.

## Business: listings and introductions (migration 0008)

The section earlier called Opportunities is named **Business**. Introductions are made between four
professional roles: founders, investors, creatives and executives (`BUSINESS_ROLES`). The old `creator` role
is now `creative`, and `executive` is new. All four are granted by staff on the Members page.

Rules that keep this an introductions service and not an investment marketplace:

- A listing has no field for an amount, valuation or terms, and is visible to nobody else until staff publish it.
- A listing is shown only to the roles it is addressed to. `capital` listings can be posted only by founders
  and are always shown to investors only; investor status is granted by staff after verification.
- An introduction request goes to the team first. The other member sees nothing until staff offer it, and
  may decline; the requester is told only that it was not taken forward, never who refused.
- Only when the other member accepts are the two connected, which opens messaging. Contact details are
  never exchanged by the system. Every step is in the audit log.
- Blocked members do not see each other's listings. One open request per pair; five open listings per member.

Member routes: `/v1/business/listings`, `/v1/me/introductions` (permissions `business.view`, `business.post`).
Staff routes under `/admin/v1/business/` need `admin.business.manage` (admin only).
Web: `/business`. Admin: `/business`. Not on mobile yet.

## Boutique (migration 0009)

- **Members** (`boutique.shop`): products with options and stock, a wishlist, and orders.
  `POST /v1/boutique/orders` creates the order and sets its stock aside; `.../pay` charges it once, however
  often it is asked; `.../cancel` is allowed until the order is being prepared and refunds a paid order in full.
- Prices are always read from the product. Anything about price in a request is ignored.
- Product rows are locked in a fixed order while an order is created, so the last item cannot sell twice.
  An order left unpaid for 30 minutes is cancelled and its stock returned.
- **Staff** (`admin.content.manage`): create products, change price and stock, put on or take off sale, and
  move paid orders through preparing, dispatched and delivered. The member is notified (and emailed) at each step.
- Orders are included in the member's data export; on erasure the delivery name and address are removed.
- Web: `/boutique`. Admin: `/boutique`.

## Boutique: delivery, tracking, photographs and member pricing (migration 0010)

- **Delivery methods** are set by staff per market (`delivery_options`): a fee, and optionally a goods total
  from which the method is free. The member chooses one at checkout; the fee is worked out on the server and
  copied onto the order with the method's name, so later changes never alter an order.
- **Courier tracking**: an order cannot be marked dispatched without a courier and tracking number (and an
  optional `https` tracking link). The member sees them on the order and in the dispatch notification.
- **Photographs**: `POST /admin/v1/media` takes a JPEG, PNG or WebP of up to 2 MB as base64. The declared type,
  the size and the file's first bytes are all checked. Images are served from `GET /v1/media/:id` under an
  unguessable id with `nosniff` and a locked-down content policy. The `MediaStore` interface has a database
  implementation for development; production should put object storage behind it.
- **Member pricing**: a product has a public price and an optional lower member price, and may be members-only.
  Visitors can browse `/boutique` and see public shelves and public prices; members see everything at member
  prices, with the saving shown. Only members can order, and an order is always charged at the member price.
- **Mobile** now has Boutique, Lifestyle, Business and Privacy screens, reached from Profile. Adding a business
  listing and downloading a data file remain on the web. The iOS bundle builds; the app has still not been run on a device.

## Guest orders (migration 0011)

- Guests can browse the Boutique and order without a membership. They give a name and an email address at
  checkout and pay the public price. Member prices, members-only pieces and the wishlist stay with members.
- A first order creates a pending device account and a session cookie, so the guest can pay for, follow and
  cancel that order afterwards. The email address is kept on the order (`orders.contact_email`), not turned
  into an account, and order emails are sent to it. Orders are found by `orders.user_id`, so a guest and a
  member can never reach each other's orders.
- First orders by guests are limited per address per minute (`guestOrderLimit`, default 10).
- The sample delivery methods no longer include collection at an experience; only the courier remains.

## Quintara TV (migration 0012)

- `GET /v1/tv/series` is open to guests. An episode is `public` or `members`; a guest sees a members' episode
  as locked and is never sent its video address. `PUT /v1/tv/episodes/:id/progress` remembers where a member
  stopped; an episode watched to within 20 seconds of its end stays marked as watched.
- Staff (`admin.content.manage`) create series and episodes, set who can watch, and publish or withdraw them.
  An episode is visible only when it and its series are both published. Staff see viewer counts, never names.
- Videos are streamed from a video host: an episode stores an `https` address, not a file. Before launch this
  should be a host that issues short-lived signed links, so a members' address cannot be passed on.
- The sample episodes all point at one short public-domain clip, standing in for real footage.
- Web: `/tv` with a player that resumes. Admin: `/tv`. Mobile: a TV screen that opens the phone's own player.

## Search and matching (migration 0013)

- **Search** (`GET /v1/search?q=`, open to guests) covers experiences, members, partners, business listings,
  the Boutique and Quintara TV. It runs no queries of its own: it asks each module for what the viewer may
  already see and looks through that, so it cannot show anything the rest of the app would hide. Every word
  typed must appear in an item; up to five results per kind.
- **People to meet** (`GET /v1/me/suggestions`) suggests up to four members with the reasons in plain words.
  The rule is `suggestMatches` in the domain package: shared interests, and one member offering what the other
  is looking for. It reads only published profile fields, leaves out existing connections, blocked members and
  anyone hidden from the directory, and nobody is told they were suggested. It is a fixed rule, not an AI model.
- A new privacy setting, `suggestions` (on by default), lets a member opt out: they are then neither suggested
  nor shown suggestions. Each change is recorded in `consent_events`.
- Web: `/search`, and People to meet at the top of `/members`. Mobile: Search from Profile, and People to
  meet on the Members tab.

## QÉRA (migration 0014)

QÉRA is the member's assistant. The shared logic is in `packages/domain/src/qera.ts`; the server side is
`apps/api/src/qera.ts`.

- **Tools, not powers.** QÉRA can only use tools, and is offered only the tools the signed-in member has the
  permission for. Each tool calls the same function as the app's own screens, so visibility, capacity,
  blocking and every other rule apply again when it runs.
- **Read or act.** `read` tools (experiences, bookings, partners, people to meet, search) run at once.
  `action` tools (book, cancel a booking, send a concierge request, ask to connect) are never run by the
  model: they become a proposal in `qera_proposals`.
- **Confirmation.** The member confirms or declines (`POST /v1/qera/proposals/:id/confirm|cancel`). A proposal
  is claimed in one statement, so it runs once; it lapses after 15 minutes; a new message replaces it; and only
  its owner can decide it. The wording the member confirms is written by the tool from the real record.
- **No payments.** QÉRA can reserve seats but never pays: the member pays under Bookings.
- **Audit.** Every tool use, proposal, confirmation, refusal and failure is written to `audit_logs`.
- **Limits.** Arguments are validated before a tool is touched, a turn is at most four steps, and messages
  are limited per member per minute (`qeraLimit`, default 20).
- **The model.** `QeraModel` is the interface. `RuleBasedQeraModel` is the stand-in used today: it recognises
  common requests by their wording and needs no outside service. A hosted language model can be supplied as
  `qeraModel` in the app config. When that is done, tool results must go to it as data, never as instructions.
- The conversation is the member's personal data: it is in their data export and removed on erasure, and they
  can clear it at any time (`DELETE /v1/qera`).
- Web: `/qera`. Mobile: QÉRA from Profile. The offline mock client runs the same model and rules.

## Light and dark looks

Dark is the brand look and the default everywhere. Anyone can switch to light, and the choice is remembered on
that device (key `quintara.theme`); it does not follow the device's system setting.

- **Light palette.** White `#FFFFFF` ground, warm ivory `#F7F6F2` cards, near-black `#161616` text, slate
  `#686868` secondary text, deep forest `#183C32` accent, `#E5E2DB` borders, `#111111` buttons with white text.
- **Tokens.** `packages/design-tokens` holds both palettes. `themeStylesheet()` gives the web apps their CSS
  variables (`data-theme="light"` on `<html>` switches), and `themeBootScript` applies the saved choice before
  first paint so there is no flash.
- **Web and admin.** `components/theme-toggle.tsx`: in the header on the web app, and in the side bar and on the
  sign-in screen of the admin console. No colours are hard-coded in the stylesheets.
- **Mobile.** `src/theme.ts` has `ThemeProvider`, `useTheme` and `useThemeChoice`; the choice is kept with
  AsyncStorage. The switch is under Profile (also shown when signed out). The status bar follows the look.
- **Mock-up.** A Dark / Light switch at the top, under Profile and in the admin side bar.
- **Imagery is the same in both looks.** Photographs, covers, the QR tile and the membership card keep the dark
  treatment (dark scrim, ivory type, champagne detail) in light, so pictures have the same texture and contrast.
  Type sizes, weights, spacing and layout are shared by both looks; only colours differ.

## Signature experiences (content)

The ten experiences come from the document "Quintara Signature Experiences": Costa Convivio, Epísimo Dípno,
The Penthouse Sessions, Quintara Golf Invitational, The Executive Yacht Club, The Aura Enclave, The Investor
Circle, Quintara Tennis Social, House Feast and Tera Convivio. The same records are in `apps/api/src/seed.ts`,
`packages/api-client/src/mock.ts` and the mock-up. Titles, taglines and descriptions follow the document; dates,
venues, prices, capacities, dress codes and programme times are placeholders until the real ones are supplied
(staff can edit them in the admin console). QÉRA matches names typed without accents.

## Admin editing of partners, privileges and Boutique items

- **Partners** (`apps/admin/src/app/partners/page.tsx`): each partner has an Edit form (name, category, area,
  website, one-line description, about) and each privilege an Edit form (title, what the member receives, terms,
  uses per member, last day). They use the existing `PATCH /admin/v1/partners/:id` and `/admin/v1/privileges/:id`.
- **Boutique** (`apps/admin/src/app/boutique/page.tsx`): an Add product button, and an Edit form per product
  (title, maker, category, options, description, remove photograph) beside the existing price, stock and
  photograph controls. Every change is written to the audit log by the API.
- **Mock-up**: Partners rows have Edit; a new Boutique page in the admin console adds, edits and removes
  products with their photographs; Photography links to the same edit screens.

## Business: opportunities from Quintara and the relationship manager (migration 0015)

Server code is in `apps/api/src/relationship.ts`.

- **Opportunities from Quintara** (`business_updates`). Staff add, edit, publish, unpublish and remove them
  (`/admin/v1/business/updates`). Members see published ones addressed to their roles, or to everyone
  (`GET /v1/business/updates`). Like listings, they have no field for an amount, a valuation or terms.
- **Relationship manager** (`rm_enquiries`, `rm_messages`). A member writes privately for insight on investments,
  help with a business dealing, or to pursue an opportunity (`/v1/me/relationship-manager`). Staff who hold
  `admin.business.manage` reply and close (`/admin/v1/business/enquiries`); the concierge desk has no access.
  The member is notified of each reply. Enquiries are in the member's data export, closed with the account and
  deleted on erasure. `RM_NOTICE` in the domain package is the wording shown wherever an enquiry can be started:
  it is not financial advice and Quintara takes no part in any transaction. Have a lawyer confirm that wording.
- **Members' listings.** Staff can edit the title, sector, description and audience
  (`PATCH /admin/v1/business/listings/:id`) and remove a listing. The kind cannot be changed, a capital listing
  stays with investors only, and the member is told their listing was edited.
- Every staff action here is written to the audit log.
- Web: Business page. Mobile: Business screen. Admin: Business page. The contract tests now close each
  in-memory database after its scenario.

## Additional updates (migration 0016)

From the document "Additional Updates". Server code is in `apps/api/src/lifestyle.ts` unless noted.

- **Home page welcome** (`home_slides`). Staff add photographs (uploaded) and films (an https link to where the
  film is hosted, as for Quintara TV), order them, hide and remove them (`/admin/v1/home-slides`, admin page
  Home page). The visitor home page alternates between them (`GET /v1/home/slides`). Films are links because
  no video host has been chosen yet; when one is, an upload can replace the link field.
- **Quintara TV programmes.** The admin TV page now has Edit on each programme (title, description) and each
  episode (title, description, length, video address), beside add and publish.
- **Profile pictures** (`profiles.avatar_media_id`). A member uploads, changes or removes their own picture
  (`PUT`/`DELETE /v1/me/avatar`); it is checked like every other image and shown in the directory. Replaced
  pictures are deleted, and a picture is deleted on erasure. Mobile shows the picture; uploading is on the web.
- **Named people.** `RELATIONSHIP_MANAGER` (Mr. Wayne Huffton, BMM Capital) and `CONCIERGE_SPECIALIST`
  (Ms. Palesa Makam, Lifestyle Curator, Private Client Services) are constants in the domain package and are
  used in the apps and in notifications. The relationship manager's subjects are now partnership, advisory,
  brand collaboration, investment insight and opportunity. Replies are still sent by whichever staff member
  holds the permission; they are shown under these names.
- **Partner directory.** Partners have what they offer, a focal point, email address, contact number and
  location, edited in the admin Partners page and shown to members only.
- **Lifestyle services** (`lifestyle_services`, `service_requests`). Seventeen services are seeded. Guests and
  members ask to book (`POST /v1/lifestyle/services/:id/requests`); a guest gives a name and email, used only
  for that booking, and guest requests are rate-limited. A request is not a payment. Members see and cancel
  their own; the concierge desk works the queue and members are notified (`/admin/v1/service-requests`).
  Staff add, edit, order and withdraw services (`/admin/v1/services`, admin page Services). Requests are in the
  member's data export and anonymised on erasure.

## QÉRA, the Quintara Intelligence (migration 0017)

Shared logic is in `packages/domain/src/qera.ts`; the server side is `apps/api/src/qera.ts` and
`apps/api/src/partner-bookings.ts`. The earlier rules still hold: QÉRA is offered only the tools the member is
permitted, every action needs the member's yes, and it never pays.

- **Knows the company** (`about_quintara`). Answers about membership, experiences, lifestyle, Business, the
  Boutique, TV, privacy, the relationship manager and the Lifestyle Curator, from what members are told elsewhere
  in the apps and live counts. It is given no internal figures.
- **Recommends** (`recommend`). Experiences, partners, services and people, ordered by the interests on the
  member's profile.
- **Books partners** (`book_partner`, `partner_bookings`). QÉRA writes to the contact in the partner directory.
  The partner is given the member's name, the date, the time, the number of guests and the note, and nothing
  else. The email carries a private link (`/partner-booking/<token>` in the web app) where the partner confirms
  or declines without signing in. Only a SHA-256 hash of the token is stored, and guesses are rate-limited. The
  member is notified either way. A refusal becomes a concierge request automatically, so the Lifestyle Curator
  finds an alternative. A partner with no email in the directory is referred instead of written to. Staff see
  everything QÉRA has sent under Services and can record a partner's answer given by telephone.
- **Requests services** (`request_service`), through the same service requests as the Lifestyle page.
- **Prepares plans** (`create_itinerary`, `qera_documents`). A day, a weekend or a holiday, laid out from
  Quintara's own experiences on those dates, its partners and its services (`composeItinerary`). The plan is a
  private document: the web app shows it as a branded Quintara page (`/qera/documents/<id>`) with Print or save
  as PDF; mobile shows it in-app. Nothing in a plan is booked. The twenty most recent are kept.
- **Refers the rest.** What QÉRA cannot manage (nothing at Quintara fits, or it needs a person) is proposed as
  a referral to the Lifestyle Curator, and sent only when the member agrees.
- **The model.** `RuleBasedQeraModel` is still the stand-in: it recognises wording, dates ("17 October",
  "Saturday", "tomorrow"), times and party sizes. A hosted language model supplied as `qeraModel` would make
  the conversation and the plans far richer, using the same tools and the same safeguards.
- **Email in development.** No mail service is connected, so the development server prints each message to
  its log, including the partner's link. Partner bookings, plans and documents are in the member's data export;
  documents are deleted and bookings cancelled on erasure.
- A display fault was also fixed: "QÉRA" was shown as "Q\\u00c9RA" in some headings of the web and mobile apps.

## Lifestyle: classified services and the Lifestyle Curator (migration 0018)

- **Service categories.** `lifestyle_services.category` classifies each service like a partner (Wellness,
  Dining, Mobility, Beauty and Style, Photography and Media, Home and Design, Talent and Brand, Business).
  Staff set it in the admin Services page. On the Lifestyle page services are grouped under their category and
  shown in the same form as partners, and one category filter covers both.
- **Lifestyle Curator.** Ms. Palesa Makam is presented under Lifestyle, as the relationship manager is under
  Business, with a way for members to write to her. The Concierge screens no longer name her: they refer to the
  desk. Her messages are concierge requests underneath, so replies are followed under Concierge.

## Guest accounts, guest QÉRA and what guests see (migration 0019)

- **Guest accounts.** Anyone can create a free personal account (`/join` on the web, the Guest account screen
  on mobile) with a name and email, and agree to the guest terms (recorded in `consent_events`). A guest signs in
  with the same email form as members (`POST /v1/guest/session`), holds no member roles, and every member check
  still fails closed. The account page lets a guest rename, download their data, sign out, or delete the account
  at once (`DELETE /v1/guest/account`). Guests applying for membership start with their name and email filled in.
- **QÉRA for guests, five hours a day.** Guests get QÉRA with read-only tools only (about Quintara, services,
  experiences open to guests, recommendations and search): no bookings, plans, introductions, partner directory
  or member data. Time is counted on the server in `qera_guest_usage`, per guest and per local day in the
  guest's market (the city's time zone, not a fixed Cape Town). While the QÉRA screen is open the app sends a
  heartbeat each minute (`POST /v1/qera/heartbeat`, at most 90 seconds counted per beat) and each message counts
  the time since the last activity (at most 5 minutes), so a long pause or a closed tab is not charged and a client
  that skips heartbeats is still charged for what it sends. At five hours, messages are refused with a prompt to
  apply for membership; the allowance resets at local midnight. `guestQeraSeconds` in the API config sets the
  limit (tests use two seconds).
- **No dates or seats for guests.** For guests and visitors the API leaves `startsAt`, `capacity` and
  `seatsTaken` out of experiences (they are `null`), so the apps and QÉRA cannot show what was never sent.
  Members and staff see them as before.
- **Staff choose what guests see.** `experiences.open_to_guests` is set per experience with the “Open to guests”
  switch on the admin Experiences list, the new-experience form and the experience page. It is separate from
  admission, which is now labelled “Open booking” for experiences any member can book. Existing open-booking
  experiences start open to guests.
- **Social media handle.** The membership application asks for one handle on Instagram, TikTok or X (step 7,
  “Where to find you”). Staff see it on the application, linked to the public profile. It is never shown to
  other members.
- **Mobile.** The membership application itself is still in the web app; the mobile app opens it there
  (`EXPO_PUBLIC_WEB_URL`).

## Lifestyle service descriptions (migration 0020)

- Each of the 17 lifestyle services now has a full description: what the service is, what it covers, and what
  to tell Quintara when asking to book. Migration 0020 updates only descriptions staff have not already changed.
  Staff edit descriptions in a larger box on the admin Services page. QÉRA names each service by the first
  sentence of its description when it lists them.
- BMM Capital's description states that any financial or investment advice comes from BMM Capital directly, not
  from Quintara.

## QÉRA as Chief of Staff, and service packages (migration 0021)

- **Memory.** `qera_memory` holds what QÉRA remembers about a member: dietary needs, likes, favourite places
  and partners, important dates, people close to them, and notes. It is written only by the member (QÉRA,
  Memory: `/qera/memory` on the web, the Memory screen on mobile) or by QÉRA after the member confirms
  (“remember that I am vegetarian”, “forget …”). QÉRA may notice things from the member's own bookings and offer
  them as suggestions, but nothing is kept until the member adds it. Every item can be changed or removed, or
  everything forgotten at once. It is in the data export and erased with the account. The audit trail records
  that memory changed, never what it says. Memory leans recommendations and plans, and dietary needs are passed
  to restaurants and chefs when QÉRA books them (the member is told so before confirming).
- **The weekly brief.** `GET /v1/qera/brief` gives the member's week: what is booked (experiences, partners,
  services), reminders, remembered dates in the next 30 days, what is waiting on them (seats to pay for),
  experiences chosen for them, and one service and one business opportunity worth a look. It is on the QÉRA
  screen, and QÉRA answers “what does my week look like?”.
- **Reminders, and what QÉRA sends of its own accord.** Members set reminders themselves or through QÉRA
  (“remind me to call the florist tomorrow at 10am”), at a local time in their market's time zone. The
  housekeeping loop (`runChiefOfStaff`) delivers due reminders as notifications and, once each, the Monday brief
  at 07:00 local time, a note two weeks before a remembered date, and a note the day before a confirmed booking.
  `qera_nudges` keeps each from being sent twice. Members switch the brief and those notes off under Profile
  (privacy); reminders they set are always delivered. Email delivery of the brief can be added on the same path.
- **Booking a whole plan.** Each line of a plan QÉRA prepares now records what it would book. The plan page shows
  exactly what booking each line would do and cost (`GET /v1/qera/documents/:id/booking`); the member unticks
  anything to leave, and one confirmation books the rest (`POST …/booking`). QÉRA does the same on “book the whole
  plan for two”, as one proposal. Each line runs through the same functions as booking it by hand, so capacity,
  invitations, notice periods and duplicates are checked again. Nothing is paid: seats that need paying for are
  held for the member to pay under Bookings. The document records what happened to each line. Plans no longer
  suggest a service sooner than its notice period allows.
- **Service packages.** `service_packages` gives each lifestyle service its packages: name, what is included, an
  indicative price (or price on request) per person, session, booking, hour or day, the notice needed, and a
  duration. Staff add, edit and remove them on the admin Services page. Guests and members see them under
  Lifestyle, choose one when asking to book, and cannot choose a date sooner than its notice allows. A request
  keeps the package name and price as they were. QÉRA quotes packages and notice when it arranges a service. The
  seeded prices are placeholders until each provider confirms them.

## Cities, the calendar, the daily brief and the membership card (migration 0022)

- **Cities.** Every experience, member (by home city), partner, service and Boutique piece belongs to a city
  (`markets`). The apps show a city picker (web header, mobile screens); each request carries the city chosen
  (`X-Quintara-Market`), and the API answers for that city if it is open, otherwise the member's home city, otherwise
  the first open city. `GET /v1/markets` lists the open cities. Nothing in the schema assumes Cape Town: each city
  has its own time zone and currency.
- **Staff control which cities open.** The admin console has a Cities page (`admin.markets.manage`): each city's
  counts, Open and Close (the last open city cannot be closed), and Add a city, which starts closed so it can be
  prepared. A “Working in” selector in the side bar chooses the city staff are working in: lists and new
  experiences, partners, services and Boutique pieces belong to it. Only staff see a closed city.
- **A calendar connected to QÉRA, by choice.** Members connect Google Calendar, Apple iCloud or Outlook by the
  private calendar address each publishes (`/qera/calendar` on the web, Your calendar on mobile), after agreeing
  (recorded in `consent_events`). The address is stored encrypted with AES-256-GCM (`CALENDAR_SECRET`, at least 32 characters, required in production) and never
  returned to any app or included in the data export. The server reads only the provider's own hosts, over HTTPS,
  without redirects, with time and size limits, and keeps only the next seven days (time, title and place; with
  “show titles” off, only the busy times). It re-reads each calendar every half hour. Disconnecting deletes the
  address and every event at once. A sample calendar is available in development. Signing in with Google or
  Microsoft can replace the address later behind the same `CalendarFetcher`.
- **The daily brief.** `GET /v1/qera/brief/today`: a greeting, a one-line summary, the day in order (the member's
  own calendar, Quintara bookings, partner bookings, service requests and reminders), what is ahead this week,
  what is waiting on them, and one suggestion, made only when it fits the day (a free evening, or seats worth
  taking). It has its own page (`/qera/today` on the web, Today's brief on mobile), reached from QÉRA and Profile. QÉRA sends a
  notification each morning from 07:00 in the member's city; members switch it off under Profile.
- The home screen and the membership card are unchanged from the previous version.

## The location icon, emerald tabs and section descriptions (migration 0023)

- **The city switch is an icon.** Only the location icon shows: in the mobile mock-up and web top bar it sits
  between search and messages; in the web app it sits in the header; in the mobile app it is in the header of
  Home, Experiences, Members, Lifestyle and the Boutique. Choosing it opens the list of open cities.
- **Emerald tabs in the light look.** In light, the chosen tab of the mobile tab bar is emerald, as QÉRA is. The
  dark look is unchanged.
- **Descriptions.** Staff edit the introductions to QÉRA, The Club, Concierge, Lifestyle, Privileges, the Boutique,
  Bookings, Messaging and the Lifestyle Curator, Ms. Palesa Makam, in the admin console under Descriptions
  (`admin.content.manage`): a short line for menus and lists, and the page description. Each can be restored to
  Quintara's original wording. `GET /v1/content/sections` gives the wording to the apps; a section with nothing
  written uses the default in `SECTION_DEFAULTS`. Every change is in the audit log.

## More sections under Descriptions (migration 0024)

- Besides the nine main sections, staff can now edit the introductions to **Experiences** (the member wording),
  **Business**, the **Relationship Manager, Mr. Wayne Huffton**, **People to meet**, **Lifestyle services**, the
  **Partner directory**, **Quintara TV**, the **membership application**, the **guest account** page and
  **Notifications**. The admin page groups them as "Main sections" and "Other sections and pages" and says where
  each one is shown.
- Wording with legal weight stays fixed and is not editable: the notice that Quintara does not offer, arrange or
  advise on investments, and the relationship manager's "not financial advice" notice.
- Migration 0024 widens the `section_copy` key check; nothing else changes in the API.

## The membership application: waiting list, phone, plans and questions (migration 0025)

- **The waiting list.** Once an application is sent, the applicant is told: "Thank you. You have been added to the
  waiting list. The membership committee will come back to you once your application is approved, so that you can
  proceed with payment." The same message is sent as a notification, and so by email. On approval the applicant is
  told the application has been approved and can proceed with payment.
- **Phone number.** The application asks for a phone number with the country code. It is checked on the server, and
  only staff who review applications see it. It is kept in the application, so it is in the applicant's data
  export and is erased with the account.
- **Membership plans.** The applicant chooses Resident or International, then a term:
  Resident 3 months R10,000, 6 months R18,000, 12 months R30,000;
  International 1 month R8,000, 3 months R16,000, 6 months R28,000, 12 months R50,000.
  Plans are membership tiers with a residency and a term (`membership_tiers.residency`, `term_months`), paid once,
  per city. Every city priced in rand starts with these; staff change fees, retire plans and add plans under Tiers.
  The server checks the plan is offered in the city for the residency chosen. Staff see the plan applied for, and
  approval offers it unless they choose another; the fee charged is that plan's. Nothing is charged before approval.
- **Application questions.** Under Application questions in the admin console (`admin.applications.review`), staff
  reword any standard question and its help text (and the list of interests), and add questions of their own: a
  short answer, a paragraph, one choice, several choices, or yes or no, required or optional, in an order they set.
  Added questions appear on a page of their own before the review. Required answers and choices are checked on the
  server; answers to questions that are not on the form are dropped. Questions are retired rather than deleted, so
  earlier answers keep their question for the committee. Every change is in the audit log.
- `GET /v1/application/plans` and `GET /v1/application/questions` give the apps what to ask.
- The QÉRA button in the mobile tab bar keeps its own look in the light theme; only the other tabs turn emerald.

## QÉRA on WhatsApp (migration 0026)

Members and guest accounts can talk to QÉRA from WhatsApp, through the WhatsApp Business Platform (Cloud API).

- **Linking.** In the app (QÉRA, then WhatsApp) the person agrees, and is given a one-time code. They send
  `LINK 123456` from their WhatsApp to Quintara's number (the app opens WhatsApp with it typed). Sending it proves
  they hold the number. Codes last 15 minutes and work once. Quintara never writes to a number that has not written
  first, and only replies inside WhatsApp's 24-hour window, so no message templates are needed.
- **The same QÉRA.** A message from a linked number is passed to QÉRA as that person, through the same functions as
  the app: the same tools, permissions and city, and a guest's daily five hours. Staff powers are never available on
  WhatsApp. It is one conversation: what is written on WhatsApp appears in QÉRA in the app, marked "On WhatsApp".
- **Confirmation.** When QÉRA would book or request something, WhatsApp shows the proposal with **Confirm** and
  **Not now** buttons (or the person replies YES or NO). The button carries the proposal's id; it works only from the
  linked number of the person it belongs to, only while it is waiting, and only once. Every confirmation is audited
  with `channel: whatsapp`.
- **Security.** Meta's webhook is confirmed with a verify token; every delivery is checked against the app secret
  (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body) before it is read; each message id is handled once; each number
  is rate-limited. An unknown number is told only how to link, and learns nothing about any account.
- **Privacy (POPIA).** Consent is recorded when linking and withdrawn on unlinking. The number is stored as a keyed
  hash (to recognise it), encrypted (AES-256-GCM, to reply) and its last four digits (to show). Message text is kept
  only in the QÉRA conversation, which the person can clear. Reply STOP, or unlink in the app, and QÉRA stops at once.
  Closing or deleting an account removes the link; the data export shows the last four digits and when it was linked.
- **Routes.** `GET/POST/DELETE /v1/me/whatsapp` (status, start linking, unlink); `GET /v1/whatsapp/webhook` (Meta's
  check) and `POST /v1/whatsapp/webhook` (deliveries).
- **Going live.** Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
  `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_BUSINESS_NUMBER` and `WHATSAPP_NUMBER_SECRET` (32+ characters), and point the
  app's webhook at `https://<api>/v1/whatsapp/webhook`, subscribed to `messages`. Without them, development uses a
  stand-in that prints what would be sent, and production tells people WhatsApp is not available yet.

## Production sign-in by one-time code (migration 0027), store builds and first-run setup

- **Sign-in.** In production (`AUTH_MODE=code`, required) members, guests, applicants and staff sign in with a
  six-digit code sent to their email: it lasts ten minutes, is checked at most five times and works once; only
  hashes are stored; the answer to "send me a code" is the same for any address. Creating a guest account proves the
  address the same way. Routes: `GET /v1/auth/config`, `POST /v1/auth/code`, `POST /v1/auth/verify`; the admin
  console's `POST /admin/v1/session` takes the code too. Development keeps sign-in by address alone.
- **App store review.** `REVIEW_EMAIL` and `REVIEW_CODE` give one account a fixed code, as reviewers cannot receive
  email. `first-run` creates that member, hidden from the directory.
- **Email.** `ResendEmailProvider` sends through Resend (`RESEND_API_KEY`, `EMAIL_FROM`); production refuses to start
  without a mail service. A failed send is logged and the person can ask again.
- **First run.** `pnpm --filter @quintara/api run first-run` opens the first city with the standard plans and
  creates the first administrator (and the review member). Safe to run again.
- **Mobile store builds.** Icons, splash, versions, privacy manifest, export compliance, Android permissions,
  `eas.json` build and submit profiles; native modules held at the versions Expo SDK 57 supports
  (`pnpm-workspace.yaml`). See docs/RELEASE.md.


## Maison Quintara

- The Boutique is now **Maison Quintara** in every app, the admin console, QÉRA's answers, search, emails and the
  mock-up. QÉRA also understands "Maison". The code, routes (`/boutique`), permissions and database keep the name
  `boutique`, so nothing stored or linked changes.

## The Maison Quintara shop (apps/maison)

- A separate, public website for Maison Quintara (for example `maison.quintaralifestyle.com`), built with Next.js
  like the web app, on the same API. Pieces, prices, member prices, stock, photographs and the shop's description
  come from the admin console; orders placed on it appear in the admin console's Maison Quintara orders, and a
  member's orders and wishlist are the same as in the apps. It has no data of its own.
- Visitors buy as guests. Members sign in with the same account (a one-time code by email in production) and see
  the pieces kept for members, at member prices, with their wishlist.
- Design: bottle green and brass on cool stone, Bodoni Moda for names and Jost for text; every piece sits in an
  arched vitrine. The bag is kept on the device until the order is placed.
- Settings: `NEXT_PUBLIC_API_URL` (the API) and `NEXT_PUBLIC_APP_URL` (the web app, for "Your orders" and applying).
  Add the shop's address to the API's `WEB_ORIGINS`. The web app and admin console link to it with
  `NEXT_PUBLIC_MAISON_URL`.
- In the mock-up it is the fourth view, "Maison Quintara shop", on the same data as the apps and the admin console.


## Maison order tracking and high-resolution photographs (migration 0028)

**Order tracking.** Every Maison Quintara order, from the apps or the shop, is tracked through five steps:
order placed, payment received, processing, dispatched for delivery, received.

- Each step is a row in `order_events`, with the time and who recorded it: the buyer, a member of staff, or
  Quintara itself (an unpaid order lapsing, say). Cancellations, refunds and staff notes are recorded the same way.
- Admin console, **Maison orders** (`/orders`): a pipeline of counts by step, with a tile for orders needing
  attention. An order needs attention when it has been paid but not processed for 24 hours, processing for
  3 days, or with the courier for 7 days. You can search by order number, name, piece or tracking number.
- Each order shows a tracker with its times, the next step and its full history. Steps cannot be skipped or
  reversed:
  - Dispatching needs the courier and the tracking number.
  - Marking an order received needs the name of whoever took the parcel in.
- Every step asks for confirmation. The buyer is told, with an optional note from staff. Notes added under
  the history stay with staff and are never sent to the buyer.
- Staff can cancel an order until it is dispatched. They must give the buyer a reason. A paid order is
  refunded in full and its stock returned.
- Buyers follow the same five steps:
  - in the web app and the mobile app, under Maison Quintara;
  - on the shop, under **Your orders**. Members see their orders there, and so do guests on the device they
    ordered from.
- API routes:
  - `GET /admin/v1/orders` now returns every order from placement, with its history.
  - `POST /admin/v1/orders/:id/advance` moves an order on. It takes `courier`, `trackingNumber`,
    `trackingUrl`, `receivedBy` and `note`.
  - `POST /admin/v1/orders/:id/notes` adds a staff note.
  - `POST /admin/v1/orders/:id/cancel` cancels an order. It takes `reason`.
  - `Order.timeline` and `Order.receivedBy` are the buyer's view.

**Photographs.**
- **Uploading.** Staff can upload originals of up to 40 MB and about 120 megapixels: JPEG, PNG, WebP, AVIF and
  TIFF. In browsers that can read HEIC (iPhone), HEIC is turned into a full-size JPEG first.
- **Settings at upload.** Before uploading, staff choose:
  - the stored size (the longest side, 1,600 to 8,000 px, or a custom size);
  - the framing (as taken, square, portrait 4:5, tall 2:3, landscape 3:2, wide 16:9), with zoom and position
    shown in a live preview;
  - the quality (78 to 98).
- **Processing on the server.** The original goes to the server untouched. The server (`apps/api/src/media.ts`,
  using sharp) then:
  - turns the photograph upright and crops it;
  - resizes it with Lanczos resampling and converts it to sRGB;
  - removes camera and GPS details;
  - stores the master as JPEG (PNG when it has transparency), with no chroma subsampling at high quality;
  - makes WebP copies at 480, 960, 1,440, 2,048, 2,880 and 3,840 px wide. A picture is never enlarged.
- **Displaying.** `GET /v1/media/:id?w=` serves the smallest copy at least that wide.
  - Web app and shop: `<img srcset>` lets each screen take the sharpest copy it can show.
  - Mobile app: it asks for its displayed width times the screen's pixel density.
- **Upload routes.**
  - `POST /admin/v1/photos?maxEdge=&quality=&crop=x,y,w,h` takes the image file as the request body.
  - The JSON base64 route `POST /admin/v1/media` still works, for files up to 10 MB.
  - Uploads require a CORS preflight, so only the Quintara apps can send them.
- **Hosting.** sharp ships prebuilt binaries. `pnpm-workspace.yaml` allows its install check (`allowBuilds`).

## Two-factor, staff accounts, the audit log and security (migrations 0029 and 0030)

- **Two-factor for every account.** After the emailed code, a code from an authenticator app. It is required in
  production. In development, `TWO_FACTOR` sets it to `required`, `optional` (the default) or `off`.
  - Code: `apps/api/src/two-factor.ts`; the routes are under `/v1/auth/2fa` and `/admin/v1/auth/2fa`.
  - The apps show the second step until it is done:
    - web: `components/two-factor.tsx`, with settings on Profile and the guest account page;
    - mobile: `components/two-factor.tsx`, with settings on Profile;
    - shop: the second step after a member's sign-in;
    - admin console: at sign-in, and under "Your security".
- **Admin console accounts.** Up to five are active (`STAFF_SEATS`), managed by administrators under Staff
  accounts: add, change role, suspend or reactivate, and reset two-factor.
  - Code: `apps/api/src/staff.ts`.
  - Every member of staff signs in with their own address, two-factor and a separate 12-hour session.
- **Audit log.** Every action and every console request by each member of staff, with time, IP address and
  device.
  - It is append-only and hash-chained, with an integrity check and CSV export.
  - Admin console: Audit log. Administrators see everyone; others see their own.
- **Security review.** See docs/SECURITY.md: the design, the findings of 19 October 2026 and what they changed,
  and what to do before launch.

## One Lifestyle directory, and cropping photographs (migration 0031)

**Partners and services directory.** Under Lifestyle, the services now sit in one directory with the partners.
- Every service carries the same directory details as a partner: a one-line description, the area, a website,
  what they offer members, the location, and the focal point (who to ask for), their email and their number.
- As for partners, the focal point and contact details go to signed-in members only. The API leaves them out for
  visitors (`GET /v1/lifestyle/services` and the new `GET /v1/lifestyle/services/:id`), and a test checks it.
- Web: `/lifestyle` shows one directory, filtered by partners or services and by category, with a page for each
  service at `/lifestyle/services/[id]`. Mobile: the same, with `lifestyle/service/[id]`.
- Admin console, Services: every directory field can be added and edited, with the same checks as partners
  (a real email address, an http or https website, digits in the number).
- Contact details for the seeded services are left empty on purpose: staff enter each provider's details once
  the provider confirms them.

**Cropping photographs.** In the admin console, wherever a photograph is added (products, the home page):
- **Crop** by dragging on the picture: draw a crop, drag inside it to move it, drag a corner to resize it. It can
  be free or held to a shape (square, portrait, tall, landscape, wide). Keyboard: arrow keys move it; Shift and
  arrow keys resize it.
- **Crop photograph** on a product, and **Crop** on a home page photograph, open the photograph already in use
  (the stored full-size version) for cropping again. The result is stored as a new photograph and replaces the
  old one; a part already cut away comes back only by uploading the original again.
- The server does the cutting at full resolution (`crop=x,y,w,h` on `POST /admin/v1/photos`). Home page slides
  now accept `imageId` on `PATCH /admin/v1/home-slides/:id` (photograph slides only).

## Store builds (.aab and .ipa)

`pnpm build:store` builds the Android app bundle and the iOS app in Expo's cloud, signed with your own Google Play
and Apple credentials, and downloads them to `builds/quintara.aab` and `builds/quintara.ipa`. The steps and the
accounts needed are in `docs/MOBILE_BUILDS.md`.

## Push notifications, Face ID, automatic renewals and Insights (migration 0032)

**Push notifications** (`apps/api/src/push.ts`, mobile `components/push.tsx`).
- Every notification the apps already create is pushed: the sender picks up new rows in `notifications` every few
  seconds, after their transaction commits, so none of the places that notify people changed. Ones older than six
  hours are not pushed.
- Through Expo's push service (`ExpoPushProvider`), which delivers with Apple and Google. `MockPushProvider` in
  development and tests. `PUSH=off` turns it off.
- The app asks the phone for permission only when the member turns notifications on (Profile, Notification
  settings, or from Notifications). Each phone is tied to its session: signing out stops it.
- Members choose which kinds are pushed, and whether the lock screen shows details (off by default). Tapping a
  notification opens what it is about. Staff and members can send a test.
- Routes: `PUT /v1/me/push/device`, `POST /v1/me/push/device/remove`, `GET|PUT /v1/me/push`,
  `DELETE /v1/me/push/devices/:id`, `POST /v1/me/push/test`.

**Face ID or fingerprint** (mobile `components/app-lock.tsx`). Under Profile: "Open Quintara with Face ID" (or
Touch ID, fingerprint, face unlock: the app uses the phone's own name for it). Turning it on asks for Face ID once.
The app then opens locked and locks again after 0, 1, 5 or 15 minutes away; it is covered in the app switcher.
Passcode fallback, and "Sign out" on the lock screen.

**Automatic membership renewals** (`apps/api/src/renewals.ts`).
- Each membership has a term (the plan's months). Members keep one card with the payment provider and can turn on
  automatic renewal. Reminders go 30 and 7 days before the end.
- On the day, the saved card is charged for the next term, which starts where the last one ended. A declined card
  is tried again after 1, 3 and 7 days; the member is told each time and can update the card and renew at once.
- Access continues for 14 days of grace; then the membership lapses and member access stops. A lapsed member can
  still sign in, sees a "Welcome back" renewal screen, and renewing starts a new term from that day.
- Members: Profile, Membership (web and Android; the iPhone app opens the web app to pay). Staff: Renewals (coming
  up, needing attention, lapsed), with "Try the card now" and "Extend" (with a reason, in the audit log).
- Runs every minute with the other housekeeping; not in production while payments are the stand-in (RELEASE.md,
  item 23).
- Routes: `GET /v1/me/membership`, `PUT|DELETE /v1/me/membership/card`, `PUT /v1/me/membership/auto-renew`,
  `POST /v1/me/membership/renew`, `GET /v1/payments/config`; `GET /admin/v1/renewals`,
  `POST /admin/v1/renewals/:id/retry`, `POST /admin/v1/renewals/:id/extend`.

**Insights** (`apps/api/src/insights.ts`, admin `/insights`).
- For the city being viewed, over 7, 30 or 90 days, 12 months, this year or chosen dates, compared with the period
  before: revenue by source and over time (with the detail on hover and a table view), members joining and lapsing,
  renewals, plans, applications, experiences, services, partners, Maison Quintara, concierge, QÉRA and push use.
- Counts and totals only: no member is named anywhere on the page or in the export.
- Export as CSV. A weekly report by email every Monday from 07:00 to the staff who ask for it, once per week.
- Routes: `GET /admin/v1/insights?period=&from=&to=`, `GET /admin/v1/insights/export`,
  `GET|PUT /admin/v1/insights/report`, `POST /admin/v1/insights/report/send`.

## Completion work, November 2026 (migration 0033)

- **Eight staff roles.** Super Administrator (`admin`), Executive Administrator (`executive_admin`), Membership
  Manager, Experiences Manager, Concierge Manager (`concierge`), Finance Manager, Content Manager, Support
  Administrator. Permissions in `STAFF_ROLE_PERMISSIONS` (`packages/domain`), checked by the API; the console shows
  each role its own menu. New permissions: `admin.providers.manage` (partners, services), `admin.boutique.manage`
  (Maison Quintara and orders), `admin.insights.view` (figures).
- **The Overview** (`GET /admin/v1/dashboard`): revenue, members, bookings and orders over 30 days (from Insights),
  and the work waiting (applications, renewals, seats, concierge and service requests, partner bookings, orders),
  each section for the roles that may see it. Counts only.
- **Payments in production** are refused until a real provider is configured; nothing is marked paid without money.
- **QÉRA on Claude** (`apps/api/src/qera-claude.ts`) when `ANTHROPIC_API_KEY` is set on the API, behind the same
  safeguards, with the rule-based model as fallback.
- Booking an experience that has started is refused. Sample experience dates follow today (`sampleDate`).
- `GET /ready` (database check), `apps/api/Dockerfile`, CI in `.github/workflows/ci.yml`, browser journeys in `e2e/`.
- Admin console on phones: tables scroll in place instead of widening every page.

## Hosted checkout and QR tickets (migration 0034)

- **Paying.** Bookings, Maison orders and membership fees are paid on the payment provider's hosted checkout:
  `POST /v1/payments/checkout` starts one (the return address must be a Quintara app), the provider's signed webhook
  (`POST /v1/payments/webhook`) and the member's return (`GET /v1/payments/checkout/:id`, web `/payments/return`) settle
  it exactly once. Development and staging use a test checkout on the API (Pay or Decline; `PAYMENTS=simulated` charges
  at once instead). Production refuses payments until a real provider's `HostedCheckout` adapter is configured.
  The apps choose through `payThrough` in `app-core`.
- **Tickets.** Confirmed bookings on the web show their ticket as a QR code; the admin Check-in page scans it with the
  camera where the browser can (Chrome, Edge), and takes the typed code everywhere.
