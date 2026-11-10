# Deploying Quintara

How to put the API and the three web apps live, and what each setting does. The mobile apps are in
[RELEASE.md](RELEASE.md). Nothing here has been deployed: every step below needs Quintara's approval and accounts.

## What runs where

| Part | Runs as | Suggested host | Health |
|---|---|---|---|
| API (`apps/api`) | Node 22, one long-running process (it also runs housekeeping every minute) | Render, Fly.io, Railway, AWS ECS or Azure Container Apps, from `apps/api/Dockerfile` | `GET /health` (alive), `GET /ready` (alive and the database answers) |
| Database | PostgreSQL 15+ (tested on 16) | Managed PostgreSQL with daily backups and point-in-time recovery | |
| Web app (`apps/web`) | Next.js 16 | Vercel (or any Node host: `next build && next start`) | |
| Admin console (`apps/admin`) | Next.js 16 | Vercel, on its own domain | |
| Maison Quintara (`apps/maison`) | Next.js 16 | Vercel | |

The three web apps hold no data or secrets: they call the API, which is the only part that touches the database.
They are deployed separately and share the one API. The architecture was not changed for any host.

Suggested addresses: `api.quintaralifestyle.com`, `app.quintaralifestyle.com`, `admin.quintaralifestyle.com`,
`maison.quintaralifestyle.com`. All HTTPS; the hosts above issue certificates automatically once DNS points at them.

## Environments

Use three, each with its own database and secrets:

| | `NODE_ENV` | `DEPLOY_ENV` | Sign-in | Payments |
|---|---|---|---|---|
| Development (a laptop) | `development` | | address alone, or codes | test checkout, or simulated |
| Staging | `production` | `staging` | codes by email, two-factor | test checkout (no money) |
| Production | `production` | `production` | codes by email, two-factor | refused until a real provider is configured |

Staging runs exactly as production does, except that it may simulate payments. Never point staging at the
production database.

## API settings

Production refuses to start without the ones marked *required*. Keep every secret in the host's secret store, never
in the repository. `.env.example` lists them all with notes.

| Setting | Required | What it is |
|---|---|---|
| `NODE_ENV=production` | yes | Turns on production behaviour and the start-up checks. |
| `DATABASE_URL` | yes | PostgreSQL connection string. Use a role that is not a superuser (the audit log's append-only triggers must not be disable-able). |
| `AUTH_MODE=code` | yes | Sign-in by one-time code sent by email. |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes | Email (codes and notifications). Verify the sending domain (SPF, DKIM) first. |
| `MFA_ENCRYPTION_KEY` | yes | 32+ random characters. Encrypts authenticator secrets. Back it up; never change it. |
| `CALENDAR_SECRET` | for calendars | 32+ random characters, different from the key above. |
| `WEB_ORIGINS` | yes | The web app, admin console and shop addresses, comma-separated. Only these may call with cookies. |
| `WEB_URL`, `ADMIN_URL` | yes | Where email links point. |
| `TRUST_PROXY=true` | behind a load balancer | So rate limits see real addresses. |
| `REDIS_URL` | more than one API process | Shares rate limits across processes. |
| `DEPLOY_ENV` | | `staging` lets a staging deployment use the test checkout. |
| `API_URL` | staging | The API's own public address, for the test checkout's links. |
| `PAYMENTS` | optional | Development and staging: `simulated` charges at once instead of the test checkout. |
| `ANTHROPIC_API_KEY` | optional | QÉRA answers with Claude. Without it, the built-in rule-based model. |
| `QERA_MODEL`, `QERA_EFFORT` | optional | Claude model (default `claude-opus-5-5`; `rules` keeps the rule-based model) and thinking effort. |
| `WHATSAPP_*` (six) | optional | QÉRA on WhatsApp; all six or none. |
| `PUSH`, `EXPO_ACCESS_TOKEN` | optional | Push notifications through Expo. |
| `REVIEW_EMAIL`, `REVIEW_CODE`, `REVIEW_2FA_CODE` | app review only | The fixed-code account for App Store and Play reviewers. |
| `STAFF_SEATS` | optional | Admin console accounts that can be active (5). |

Web apps: `NEXT_PUBLIC_API_URL` (all three), `NEXT_PUBLIC_MAISON_URL` (web, admin), `NEXT_PUBLIC_APP_URL` (shop).
These are public by design: they are addresses, not secrets.

## First deployment

1. Create the database. Run migrations from a machine or release job that can reach it:
   `DATABASE_URL=… pnpm --filter @quintara/api migrate`. Re-running applies nothing new.
2. First-run setup (opens the first city with the standard plans and creates the first Super Administrator):
   `DATABASE_URL=… SETUP_ADMIN_EMAIL=… SETUP_ADMIN_NAME=… pnpm --filter @quintara/api run first-run`. Safe to repeat.
3. Build and start the API: `docker build -f apps/api/Dockerfile -t quintara-api .` then run it with the settings above.
   Point the host's health check at `/ready`.
4. Check `GET /ready` returns `{"ok":true,"database":"ok"}` and `GET /v1/auth/config` returns `{"method":"code"}`.
5. Deploy the three web apps with their `NEXT_PUBLIC_*` settings; point DNS; confirm HTTPS.
6. Sign in to the admin console as the first administrator, set up two-factor, add the other staff with their roles,
   and add the real content (experiences, partners, services, Maison Quintara, TV, photographs, descriptions).

## Payments

Members pay on the provider's hosted checkout and come back to `https://app…/payments/return` (the shop: its home
page). Once a provider is chosen and its adapter written: register `https://<api>/v1/payments/webhook` with the provider
for payment events, set its keys in the host's secret store, and test end to end in staging with the provider's test
cards before production.

## Each release

1. CI must be green on the branch: types, all tests, production builds, migrations on PostgreSQL 16, the API image and
   the browser journeys (`.github/workflows/ci.yml`).
2. Take a database snapshot.
3. Run `migrate`, then deploy the API, then the web apps. Migrations so far add tables, columns and reference rows;
   none drops a table or column (0008 renamed the `creator` role to `creative` and removed the old key). Read each new
   migration before a release with that in mind.
4. Watch `/ready` and the error log for ten minutes.

**Rolling back.** Redeploy the previous API image and web builds. Because migrations add rather than remove, the
previous API normally runs on the newer schema. If a migration itself must be undone, restore the snapshot from step 2 (and accept losing what
was written since); do this only with approval.

## Backups and recovery

- Managed PostgreSQL with daily backups kept at least 30 days and point-in-time recovery. Test a restore into a
  scratch database once a quarter, and before launch.
- Copy the audit log to write-once storage daily (docs/SECURITY.md, "Before launch").
- `MFA_ENCRYPTION_KEY`, `CALENDAR_SECRET` and `WHATSAPP_NUMBER_SECRET` must be backed up with the database: a backup
  without them cannot decrypt those columns.

## Capacity

The load test (`pnpm --filter @quintara/api load` against a staging database) gives a baseline: one API process
handled about 550 requests per second with a 95th percentile under 160 ms at 50 members at once, on 4 shared cores.
Run it against staging after each significant change and before launch.

**More than one API process.** Set `REDIS_URL` (a managed Redis 7, private network, with a password) so rate limits are
shared; otherwise each process counts on its own. The API stops cleanly on SIGTERM: it finishes the requests in flight
(up to 25 seconds) before exiting, so rolling deploys do not cut requests off. Health checks: `/health` for liveness,
`/ready` for readiness.

## Monitoring

- Uptime checks on `/ready` (API) and the three web addresses.
- Error reporting: the API logs errors as JSON to standard output (Fastify's logger); send the host's logs to an
  error service (for example Sentry or the host's own). Request logs redact cookies, tokens and query values.
- With more than one API process, move the in-process rate limits to Redis (docs/SECURITY.md).
