# Quintara security

This is the security design of the Quintara apps, and the findings of the review of 19 October 2026: what was
checked, what was found and fixed, and what is left to do before launch.

No system is perfectly secure. What follows is defence in depth: several independent controls, each tested, so
one failure does not expose members' data. An independent penetration test before launch is still recommended
(item 6 at the end).

## Signing in

**Two factors, for every account.** In production, every account with an email address needs two things to sign in:
- the one-time code emailed to it;
- a code from an authenticator app (TOTP, RFC 6238), such as Google Authenticator, Microsoft Authenticator or
  1Password.

This covers members, guest accounts, applicants and staff. There are no passwords.

- **The email code.** It is six digits and lasts 10 minutes. It allows 5 tries and works once. Only a hash is
  stored. At most 5 codes can be sent per 15 minutes to an address. "Send me a code" gives the same answer whether
  or not the address has an account.
- **Setting up the authenticator.** It happens at the first sign-in; the app shows a QR code or a key to type.
  - The secret is encrypted with AES-256-GCM under `MFA_ENCRYPTION_KEY`, and is never shown again.
  - Ten one-time recovery codes are given once. Only their hashes are kept.
- **Until the second step is done, the session can do nothing else.** The API treats it as signed out. This also
  applies to:
  - sessions begun before two-factor was required;
  - accounts that gained an email address later (applicants, guest accounts).
- **Each authenticator code works once** (replay is blocked), and only within 30 seconds either side of now.
- **Wrong codes.** Five wrong codes end the sign-in. Ten in a row lock the second step for 15 minutes.
- **Session renewal.** Finishing the second step replaces the session token with a new one, so a token seen during
  sign-in is useless afterwards.
- **Email notices** are sent when two-factor is turned on, when the authenticator moves to a new phone, when a
  recovery code is used, and when staff reset it.
- **A lost phone.** The person uses a recovery code. If they have lost those too:
  1. An administrator confirms who they are and records how.
  2. The administrator resets two-factor. This signs the person out everywhere.
  3. The person sets up a new authenticator at their next sign-in.

  Nobody can reset their own two-factor.
- **App store review.** The review account (`REVIEW_EMAIL`) uses a fixed email code (`REVIEW_CODE`) and a different
  fixed second code (`REVIEW_2FA_CODE`). Production refuses to start with only one of them set.

**Sessions.**
- **Tokens.** A token is 32 random bytes. Only its SHA-256 hash is stored.
- **Cookie.** It is HttpOnly and Secure in production.
- **Staff sessions are separate from app sessions:**
  - their own cookie (`q_staff`), sent only to `/admin`, with SameSite=Strict;
  - 12 hours at most, and they end after 2 hours without use;
  - staff powers are never carried by an app session, even for the same person.
- **App sessions** last 30 days.
- **Signing out everywhere.** Anyone can sign out of every device from Profile (web and mobile).
- **What ends sessions automatically.** Closing an account, suspension, a two-factor reset, and a change of staff
  role or suspension of a staff account all end the person's sessions at once.

## Who can do what

- **Fail-closed checks.** Every route checks permissions on the server. Role checks fail closed: suspended members,
  lapsed members and suspended staff have no powers.
- **The route-guard test** (`test/route-guard.test.ts`) calls all 232 routes:
  - as a visitor;
  - for staff routes, also as a signed-in member.

  Only an explicit list of public routes may answer. A route added later without a permission check fails the
  build.
- **Record ownership** is enforced in the queries themselves. Another member's booking, order or message is
  simply "not found".
- **Admin console accounts.**
  - Up to five can be active (`STAFF_SEATS`).
  - One role each, of eight: Super Administrator (everything), Executive Administrator, Membership Manager,
    Experiences Manager, Concierge Manager, Finance Manager, Content Manager, Support Administrator. What each
    may do is `STAFF_ROLE_PERMISSIONS` in `packages/domain`; the API checks it on every request and
    `test/staff-accounts.test.ts` checks every role against real routes.
  - Staff role keys never equal member role keys (both live in `user_roles`); a test enforces it.
  - Only Super Administrators manage accounts.
  - Nobody can suspend or demote themselves, and the last administrator cannot be removed.

## The audit log

- **What it records.** `audit_logs` records every significant action:
  - who did it, to which record, and what changed;
  - when, and from which IP address and device.

  This includes sign-ins, failed staff sign-ins, two-factor events, refunds, approvals, order steps and staff
  changes.
- **Staff requests.** `staff_activity` records every request a member of staff makes to the admin console,
  including what they opened (the route and the record), with the answer, the IP address and the device. Query
  values are never stored.
- **Append-only.** Both tables are append-only: the database refuses UPDATE and DELETE.
- **Hash chain.** Each entry is SHA-256 chained to the one before it. The time in the hash is stored as
  milliseconds, so the database time zone cannot change it. "Check the log is intact" in the console recomputes
  the chains and reports the first entry that was altered or removed (tested by tampering with the database
  directly).
- **Who sees what.** Administrators see and export everyone's entries, as CSV with spreadsheet formulas
  neutralised. Every other member of staff sees their own. Exporting and checking the log are themselves
  recorded.

## Requests, input and output

- **CSRF (cross-site request forgery).**
  - A request that changes something and carries a session must come from a Quintara app: the `Origin` header
    must be one of `WEB_ORIGINS`, and `Sec-Fetch-Site: cross-site` is refused.
  - `text/plain` bodies (which a browser can send from any site without asking first) are not accepted at all.
  - Image uploads are a non-simple content type, so browsers must pass the CORS preflight first.
  - Cookies are SameSite.
- **Input validation.** Every input is validated with zod before use. SQL is always parameterised; the few dynamic
  fragments are fixed strings from the code. JSON parsing rejects prototype pollution. Body sizes are capped.
- **API response headers:**
  - `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`;
  - a Content-Security-Policy with `frame-ancestors 'none'`;
  - `Cache-Control: no-store` on personal data;
  - HSTS in production.
- **Web app, admin console and shop headers:**
  - a Content-Security-Policy: scripts only from the site itself, data only from the API, no framing, no
    plug-ins;
  - HSTS, `nosniff`, `DENY`, a restrictive Permissions-Policy and `Cross-Origin-Opener-Policy`.

  The admin console is also `noindex`. React escapes all output, and nothing renders raw HTML from data.
- **Errors** never reveal internals: details go to the server log, never to the client.
- **Logs** never contain cookies, authorisation headers or query values.
- **Rate limits** apply to:
  - sign-in and two-factor attempts;
  - guest orders and booking requests;
  - QÉRA messages;
  - partner booking links.

  Their memory is swept every minute. `TRUST_PROXY` makes them see real addresses behind a load balancer.

## Files and outside services

- **Photographs.** Every upload is checked by type, by its first bytes, by size (40 MB) and by pixel count
  (120 megapixels, to stop decompression bombs). It is then re-encoded, which removes camera and GPS data and
  anything hidden in the file. Images are served with `nosniff` and a sandboxing CSP.
- **Calendars.** Addresses are encrypted. Only the providers' own hosts are fetched, over HTTPS, with no redirects,
  8 seconds and 2 MB at most. The download is cut off as soon as it exceeds the limit.
- **The WhatsApp webhook** checks Meta's HMAC signature on the raw body, with a constant-time comparison. Its
  verification challenge is limited to safe characters.
- **Payments.** No card data ever touches Quintara: it stays with the provider's tokenisation.

## Push notifications, the app lock and saved cards

- **Push notifications.** A phone's push token is registered with the session signed in on it. When that session
  ends (signing out, signing out everywhere, suspension, a two-factor reset) nothing more is pushed to the phone, and
  a token that Apple or Google reports as gone is switched off. The token is never sent back to the apps or included
  in the data export.
- **Discreet by default.** The lock screen shows "There is news about your order" and the like, not who wrote or
  what about, until the member chooses to show details. The choice is recorded as a consent.
- **Face ID or fingerprint.** Members can lock the app on their phone: it opens locked, locks again after the time
  they choose in the background, and is covered in the app switcher. The phone's passcode is the fallback; "Sign out"
  is always offered. The setting lives in the phone's Keychain or Keystore. It adds to the two-step sign-in and never
  replaces it.
- **Saved cards.** The card number is typed into the payment provider's own form; Quintara holds only the provider's
  reference, the brand, the last four digits and the expiry. The API refuses anything that looks like a card number.
  Staff never see card details. Every renewal charge has an idempotency key per member, term and attempt, so a job
  that runs twice charges once. Choosing automatic renewal is recorded as a consent.

## Personal information (POPIA)

- **Data export.** Members can export their data.
- **Account erasure.** Closing an account erases the personal data after a 30-day cooling-off period. Two-factor
  secrets and recovery codes are deleted with the account.
- **Consent** is recorded for the directory, marketing, suggestions, calendar and WhatsApp.
- **Secrets** are encrypted at rest with separate keys:
  - `MFA_ENCRYPTION_KEY`: authenticator secrets;
  - `CALENDAR_SECRET`: calendar addresses;
  - `WHATSAPP_NUMBER_SECRET`: WhatsApp numbers.

  Production refuses to start without them, or with the same key used twice.

## Review of 19 October 2026: findings and fixes

| # | Finding | Severity | Fixed |
|---|---|---|---|
| 1 | No second factor: anyone with access to a member's or staff member's email could sign in. | High | Two-factor (TOTP and recovery codes) for every account, required in production. |
| 2 | Staff powers were carried by any session of a staff user, including a 30-day web app session. | High | Separate staff sessions: own cookie, `/admin` only, Strict, 12 hours, 2 hours idle. |
| 3 | sharp 0.34 carried known libvips/libheif vulnerabilities, and it decodes uploaded files. | High | Upgraded to sharp 0.35.5. |
| 4 | Cross-site requests relied on SameSite and JSON only; `text/plain` bodies were accepted. | Medium | Origin and Sec-Fetch-Site checks; `text/plain` no longer accepted. |
| 5 | The API sent no security headers of its own, and personal data could be cached. | Medium | Security headers on every response; `no-store` on JSON; HSTS. |
| 6 | The web apps had no Content-Security-Policy or HSTS. | Medium | CSP, HSTS, COOP and a restrictive Permissions-Policy on all three. |
| 7 | Logs could contain the WhatsApp verify token and partner link tokens (query strings and paths). | Medium | Request logging redacts query values, tokens, cookies and authorisation headers. |
| 8 | The calendar download was read in full before its size was checked. | Low | A streamed read that stops at 2 MB. |
| 9 | The rate-limit maps were never emptied: a flood of addresses could grow them without end. | Low | Swept every minute. |
| 10 | Behind a proxy, every request would share one address for rate limits. | Low | `TRUST_PROXY`. |
| 11 | The WhatsApp verification echoed any challenge text. | Low | Limited to safe characters. |
| 12 | The audit log could not show who among the staff viewed what, and was not tamper-evident. | Medium | Staff activity log, hash chains, integrity check, export. |
| 13 | Admin console accounts could only be created in the database. | Process | Staff accounts page: five seats, roles, suspension, two-factor reset. |

## Review of 9 November 2026: findings and fixes

| # | Finding | Severity | Fixed |
|---|---|---|---|
| 14 | Production used the simulated payment provider, which approves every charge: fees, paid seats and orders would be marked paid with no money taken. | Critical | Production refuses payments (`UnavailablePaymentProvider`) until a real adapter is configured; renewals never run on a stand-in. |
| 15 | A new staff role key `executive` equalled the member business role `executive`: a business executive with any console account would have gained executive powers. Found before release, when migrating a real PostgreSQL. | High | Staff key `executive_admin`; the migration fails loudly on any key collision; a test forbids overlap. |
| 16 | An experience that had already started could still be booked, and paid for. | Medium | Refused with 409 in the API and the offline mock. |
| 17 | Liveness (`/health`) read the database through the session lookup, so a database blip could restart healthy API processes. | Low | Probes skip the session lookup; `/ready` checks the database separately. |
| 18 | Insights (revenue) was readable by anyone who could manage members. | Low | Its own permission, `admin.insights.view`. |

**Paying through a hosted checkout (stage 2).** Card details are typed only on the provider's page. The provider's
webhook (`POST /v1/payments/webhook`) is read as raw bytes and refused unless its signature checks; it is exempt from
the cookie CSRF check because it carries no session. A checkout's return address must be one of `WEB_ORIGINS`.
Settling is exactly once under a row lock; money for something already paid or cancelled is refunded and audited.
The test checkout page exists only with the test provider (never in production) and runs no script.
**Database connections** that drop (a restart, failover or terminated session) are handled by the pool and logged;
before stage 3 one would have ended the API process. **The admin console may use the camera** (`camera=(self)`), for scanning tickets at check-in; the web app may not.

**Dependencies.** The remaining `pnpm audit` advisories are in Expo's and Metro's build tools (`node-forge`,
`braces`, `uuid` in `@expo/cli` and Metro) and in `decode-uri-component`, which expo-router uses on the device.
None runs on the API or the web servers. Each will be resolved when Expo updates them; run `pnpm audit` before
each release.

## Before launch

1. Set `MFA_ENCRYPTION_KEY` (32+ random characters, different from `CALENDAR_SECRET`). Keep it with the other
   secrets, and back it up: losing it means everyone sets up their authenticator again.
2. Set `REVIEW_2FA_CODE` if the review account is used.
3. Set `TRUST_PROXY` to match the hosting, and `WEB_ORIGINS` to exactly the three production addresses.
4. Restrict the database user the API uses: no superuser rights. The audit log's protection against changes is
   enforced by triggers, which a superuser could disable.
5. Copy the audit log to separate, write-once storage on a schedule (for example a daily export to an object
   storage bucket with object lock), so a copy survives even a full database compromise.
6. Commission an independent penetration test of the production setup.
7. Move the in-process rate limits to Redis if more than one API server runs.
8. Register the Information Officer under POPIA and publish the privacy policy (already in RELEASE.md).
