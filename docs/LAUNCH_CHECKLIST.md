# Launch checklist

What must be true before Quintara goes live, who provides it, and in what order. The how is in
[DEPLOYMENT.md](DEPLOYMENT.md) (servers), [RELEASE.md](RELEASE.md) (mobile apps) and [SECURITY.md](SECURITY.md).
Nothing has been deployed: every step marked **approval** needs Quintara's written go-ahead.

## 1. Decisions and accounts (Quintara)

| | Item | Why it is needed |
|---|---|---|
| ☐ | Hosting chosen: API host (Render, Fly.io, Railway, AWS ECS or Azure), web host (Vercel or a Node host), managed PostgreSQL with point-in-time recovery, Redis | Nothing can be deployed without them |
| ☐ | Domain and DNS access for `quintaralifestyle.com` | The four addresses and their certificates |
| ☐ | Email: a Resend account with the sending domain verified (SPF, DKIM) | Sign-in codes are sent by email; the API will not start without it |
| ☐ | Two S3-compatible buckets: photographs, and one **with Object Lock** for audit copies | Photographs and the write-once audit log |
| ☐ | Payment provider chosen, merchant account approved | Until then production refuses payments (by design) |
| ☐ | Optional services: Anthropic API key (QÉRA on Claude), Meta WhatsApp Business (QÉRA on WhatsApp), Expo access token | Each works without them in a lesser form; see DEPLOYMENT.md |
| ☐ | Apple Developer and Google Play accounts | Mobile apps (RELEASE.md) |
| ☐ | GitHub: the `staging` and `production` environments, with required reviewers on `production` | The release workflow's secrets and its approval gate |
| ☐ | The people: first Super Administrator, and a second (so a lost phone cannot lock everyone out) | First-run, then the console |

## 2. Legal and policy (Quintara)

| | Item |
|---|---|
| ☐ | Information Officer registered under POPIA |
| ☐ | Privacy policy and terms published (drafts in RELEASE.md) |
| ☐ | Retention periods confirmed: the working records (SECURITY.md, "Retention", defaults set) and the audit log (`AUDIT_RETENTION_DAYS`, 2,555 days by default) |
| ☐ | Independent penetration test of the staging setup, findings resolved |

## 3. Staging (can start as soon as section 1's accounts exist)

| | Step | Done when |
|---|---|---|
| ☐ | Create the staging database; run `migrate`, `first-run`, `app-role` | Preflight reports the database ready |
| ☐ | Set the staging environment's secrets and variables (DEPLOYMENT.md, "Release workflow") | `preflight` prints "Ready" |
| ☐ | Run the Release workflow for `staging` | It finishes green, smoke test included |
| ☐ | Confirm each outside service once (DEPLOYMENT.md, "Confirming the outside services in staging") | Each row checked |
| ☐ | Payments end to end with the chosen provider's test cards (once its adapter exists) | Paid, declined and refunded as expected |
| ☐ | Restore a backup into a scratch database | The restore works and the data is there |
| ☐ | Content entered: experiences, partners, services, Maison pieces, TV, home page, descriptions | Reviewed by Quintara |
| ☐ | A week of use by Quintara's own staff | No open defects that block launch |

## 4. Production (**approval** required for each)

| | Step |
|---|---|
| ☐ | Written go-ahead from Quintara for the production release |
| ☐ | Production database created; `migrate`, `first-run`, `app-role` |
| ☐ | Production secrets set: all new values, none copied from staging |
| ☐ | Release workflow for `production`, with the typed confirmation and the reviewers' approval |
| ☐ | Smoke test green; the first administrator signs in and sets up two-factor |
| ☐ | Live payments switched on only once merchant credentials and configuration are approved |
| ☐ | Mobile apps submitted for review (RELEASE.md) |
| ☐ | Watch `/ready` and the error log for the first day; the rollback plan (DEPLOYMENT.md, "Each release") at hand |

## Already done in the repository

- Every feature built and tested: docs/DELIVERY_REPORT.md, sections 4g and 6.
- The pipeline:
  - CI runs the tests, the builds, and the browser tests on development and production builds;
  - a release workflow with preflight, migrations, deploy hooks, smoke test and an approval gate.
- The checks:
  - the API refuses to start in production with unsafe or missing settings;
  - preflight checks a deployment's settings and database before release;
  - the smoke test checks it after.
- A full staging-style deployment rehearsed locally with the real container image (DEPLOYMENT.md, "Rehearsed here").
