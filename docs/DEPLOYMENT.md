# Deploying Quintara

How to put the API and the three web apps live, and what each setting does. The mobile apps are in
[RELEASE.md](RELEASE.md). Nothing here has been deployed: every step below needs Quintara's approval and accounts.
What must be in place before launch, and in what order: [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md).

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
| `MEDIA_S3_BUCKET` (+ `_REGION`, `_ENDPOINT`, keys) | recommended | Photographs in object storage instead of the database. |
| `AUDIT_S3_BUCKET` (+ the same), `AUDIT_RETENTION_DAYS` | recommended | Daily write-once copies of the audit log. |
| `RETENTION_*_DAYS` (eight) | optional | How long working records are kept; defaults in SECURITY.md (POPIA). |
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
These are fixed into each build, so set them before `next build`. A production build without `NEXT_PUBLIC_API_URL`
stops with an error; until this check was added, the web app and shop would silently have run on their offline
demo data. A deliberate demonstration build on sample data sets `QUINTARA_DEMO_BUILD=1` instead.
These are public by design: they are addresses, not secrets.

## First deployment

1. Create the database. Run migrations from a machine or release job that can reach it:
   `DATABASE_URL=… pnpm --filter @quintara/api migrate`. Re-running applies nothing new.
2. First-run setup (opens the first city with the standard plans and creates the first Super Administrator):
   `DATABASE_URL=… SETUP_ADMIN_EMAIL=… SETUP_ADMIN_NAME=… pnpm --filter @quintara/api run first-run`. Safe to repeat.
3. Create the API's restricted database role, as the owner:
   `DATABASE_URL=<owner> APP_ROLE=quintara_app APP_ROLE_PASSWORD=<24+ random characters> pnpm --filter @quintara/api run app-role`.
   The API's `DATABASE_URL` uses this role; the owner's connection is kept for migrations only.
4. Create the two buckets with `deploy/aws/storage.yaml` (below, "Object storage and GitHub environments"): one for
   photographs (`MEDIA_S3_*`), and one **with Object Lock** for the audit log copies (`AUDIT_S3_*`), with a key limited
   to them. The audit copies need S3 Object Lock in compliance mode (Amazon S3, or a service that implements it).
   Upload a photograph in staging and check it is served, before going live.
5. Build and start the API: `docker build -f apps/api/Dockerfile -t quintara-api .` then run it with the settings above.
   Point the host's health check at `/ready`.
6. Check `GET /ready` returns `{"ok":true,"database":"ok"}` and `GET /v1/auth/config` returns `{"method":"code"}`.
7. Deploy the three web apps with their `NEXT_PUBLIC_*` settings; point DNS; confirm HTTPS.
8. Sign in to the admin console as the first administrator, set up two-factor, add the other staff with their roles,
   and add the real content (experiences, partners, services, Maison Quintara, TV, photographs, descriptions).

## Payments

Members pay on the provider's hosted checkout and come back to `https://app…/payments/return` (the shop: its home
page). Once a provider is chosen and its adapter written: register `https://<api>/v1/payments/webhook` with the provider
for payment events, set its keys in the host's secret store, and test end to end in staging with the provider's test
cards before production.

## Confirming the outside services in staging

Each adapter is tested against a local stand-in that answers as the provider's API does (`test/adapters.test.ts`).
A stand-in cannot prove the real service accepts the request, so with real keys in staging, check each once:

| Service | Do this in staging | Expect |
| --- | --- | --- |
| Email (Resend) | Sign in by code with a real address. | The code arrives from `EMAIL_FROM`, not in spam. `email_outbox` shows it `sent`. |
| Push (Expo) | Install a staging build, sign in, and tap "Send a test notification" in the app's notification settings. | The phone shows it. A removed app's device is switched off after the next push. |
| WhatsApp (Cloud API) | Link a number from the app, then send "hello" to the business number. | QÉRA answers. Meta's webhook dashboard shows deliveries answered 200. |
| QÉRA on Claude | Ask QÉRA "What is on this week?" | A reply naming real experiences. The API log shows no fallback to the rule-based model. |
| Calendars | Connect a Google or Outlook private address. | Today's events appear in the daily brief within half an hour. |
| Payments | After the provider is chosen: pay, decline and refund with its test cards. | As the e2e checkout journeys, with the provider's own pages. |
| Photographs and audit copies (S3) | Upload a photograph; wait a day. | It is served; `audit:check-copies` reports the day's copy. |

## Object storage and GitHub environments (one command each)

Both are created under Quintara's own accounts, by someone signed in to them. They cannot be created from a
development session.

**The two buckets**, per environment. `deploy/aws/storage.yaml` creates:
- a private, versioned bucket for photographs;
- a bucket **with Object Lock** for the audit copies (Object Lock can only be turned on when a bucket is created);
- an access key for the API, allowed only what it does. It can write audit copies with a retention date, but never
  delete them or shorten a retention. The key's secret goes into Secrets Manager, not the stack's outputs.

Both buckets are kept if the stack is ever deleted. Cape Town (`af-south-1`, enable it once under the account's
Regions) keeps the data in South Africa:

```bash
aws cloudformation deploy --region af-south-1 --template-file deploy/aws/storage.yaml --stack-name quintara-staging-storage --parameter-overrides Environment=staging --capabilities CAPABILITY_NAMED_IAM
```

Then the same with `production` in place of both `staging`s. Bucket names are global; if `quintara-…` is taken, add
`NamePrefix=<something unique>` to `--parameter-overrides`.

Read the settings from the stack's outputs (`aws cloudformation describe-stacks --region af-south-1 --stack-name …`),
and the secret with `aws secretsmanager get-secret-value --region af-south-1 --secret-id quintara/staging/object-storage-key`.
They become:
- `MEDIA_S3_BUCKET`, `AUDIT_S3_BUCKET`;
- `MEDIA_S3_REGION` and `AUDIT_S3_REGION` (`af-south-1`);
- the same key pair, in both `MEDIA_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` and `AUDIT_S3_…`.

Before relying on it, confirm on the real buckets what the local emulator could not show:

```bash
aws s3api get-object-lock-configuration --region af-south-1 --bucket quintara-staging-audit
```

It should say `"ObjectLockEnabled": "Enabled"`. Also check `get-bucket-versioning` on both buckets. The template
passes `cfn-lint`, and deploying it to the moto emulator created both buckets, encrypted, with the API's user. moto
does not apply Object Lock, versioning, inline policies or Secrets Manager entries from CloudFormation. The audit-copy
code itself is tested against a lock-enabled bucket.

**The GitHub environments.** `deploy/github/environments.sh` creates `staging` and `production`. Each may be deployed
from the default branch only, and production waits for the reviewers named. Run it as a repository admin signed in
with the GitHub CLI:

```bash
deploy/github/environments.sh <reviewer> <second-reviewer>
```

With two or more reviewers, whoever starts a production run cannot approve it themselves. Then add each
environment's secrets and variables (below, "Release workflow").

## Checks before and after a release

- **Preflight** (`pnpm --filter @quintara/api preflight`), run with the environment's settings:
  - every setting (`src/preflight.ts`): missing or placeholder secrets, the same secret used twice, non-HTTPS or
    localhost addresses, development switches, incomplete WhatsApp settings;
  - with `DATABASE_URL`, the database: the API connects as the restricted role, not the owner; every migration is
    applied; first-run has created a city and an active Super Administrator; no sample (`@example.com`) accounts.

  It prints every problem and exits 1. The API runs the same settings checks when it starts in production, and
  refuses to start, listing every problem at once.
- **Smoke test** (`pnpm --filter @quintara/api smoke`, with `SMOKE_API_URL`, `SMOKE_WEB_URL`, `SMOKE_ADMIN_URL`,
  `SMOKE_MAISON_URL`). Read-only, so it is safe against production. It checks:
  - the API is alive and ready;
  - sign-in is by emailed code;
  - CORS admits the three apps and no one else;
  - each app is served over HTTPS with HSTS, cannot be framed, and was built for this API (its content security
    policy names the API it calls);
  - the console is kept out of search engines.

## Release workflow

`.github/workflows/release.yml` runs by hand only (Actions > Release > Run workflow) and never on a push. It:
1. builds the API image for the exact commit and publishes it to the GitHub Container Registry;
2. runs preflight with the target environment's settings (new migrations allowed to be pending);
3. migrates, with the owner's connection;
4. runs preflight again, strictly;
5. calls the hosts' deploy hooks;
6. waits for `/ready`;
7. runs the smoke test.

It refuses to run unless CI passed for that commit. A production run also needs:
- the typed confirmation `deploy production`;
- approval by the required reviewers set on the `production` environment.

**Setting it up** (once per environment, in GitHub: Settings > Environments > `staging` / `production`):

| Kind | Names |
|---|---|
| Secrets | `DATABASE_URL` (the restricted role), `MIGRATION_DATABASE_URL` (the owner), `RESEND_API_KEY`, `MFA_ENCRYPTION_KEY`, `CALENDAR_SECRET`, `REDIS_URL`, `API_DEPLOY_HOOK_URL`, `WEB_DEPLOY_HOOK_URL`, `ADMIN_DEPLOY_HOOK_URL`, `MAISON_DEPLOY_HOOK_URL`; as used: `PAYMENTS_TEST_SECRET` (staging), `ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN`, `WHATSAPP_NUMBER_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`, `AUDIT_S3_ACCESS_KEY_ID`, `AUDIT_S3_SECRET_ACCESS_KEY` |
| Variables | `API_URL`, `WEB_URL`, `ADMIN_URL`, `MAISON_URL`, `WEB_ORIGINS`, `EMAIL_FROM`, `TRUST_PROXY=true`; as used: `MEDIA_S3_BUCKET`, `AUDIT_S3_BUCKET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_NUMBER` |
| Protection | `production`: required reviewers (at least one person who is not the one starting the run), and only the default branch may deploy |

The same values are also set on the hosts themselves (the API host's environment, and each web app's
`NEXT_PUBLIC_*` build settings); the workflow uses its copies for the checks and the migration.

**Deploy hooks.** The API step posts the image address as `imgURL`, which is the form Render's deploy hook takes.
Other hosts differ, so change that one step once the host is chosen:
- Fly.io: `flyctl deploy --image $IMAGE`;
- Railway or ECS: their command-line tools;
- Vercel (for the web apps): its deploy hook needs no parameters, as written.

**Rehearsed here.** The whole sequence was run in this sandbox on 10 November 2026: a fresh PostgreSQL 16 database,
`migrate` (then again, applying nothing), `first-run`, `app-role`, preflight as the restricted role with a staging
configuration ("Ready", five warnings to decide on), and the image built from `apps/api/Dockerfile`, started with
those settings. It then:
- reported itself healthy, with `/ready` ok;
- enforced code sign-in;
- admitted only the staging origins;
- stopped cleanly on SIGTERM, with exit code 0.

The deploy hooks and the smoke test against real HTTPS hosts can only be run once the hosts exist. The smoke test was
run here against production builds of the three apps.

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
- The audit log is copied daily to the write-once bucket (`AUDIT_S3_BUCKET`); check the copies with
  `pnpm --filter @quintara/api run audit:check-copies`.
- Photographs live in their bucket (`MEDIA_S3_BUCKET`): turn on its versioning or replication, since database backups
  no longer contain them. Photographs stored in the database earlier move with `media:to-objects`.
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
