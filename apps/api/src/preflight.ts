/**
 * The checks a deployment must pass before it serves anyone, as one list: the API runs them at start-up in production
 * (errors stop it), and `pnpm --filter @quintara/api preflight` runs them before a release, together with the checks
 * that need the database (preflight-cli.ts).
 *
 * Errors would leave the deployment broken or unsafe. Warnings are things it runs without, which should be decided on
 * purpose (no payment provider yet, no object storage, one process only).
 */
export interface Findings { errors: string[]; warnings: string[] }

const SECRET_MIN = 32;
const isHttps = (value: string) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const isLocal = (value: string) => { try { return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(new URL(value).hostname); } catch { return false; } };

export function checkDeployment(env: Record<string, string | undefined>): Findings {
  const get = (key: string) => (env[key] ?? '').trim();
  const errors: string[] = [], warnings: string[] = [];
  const error = (message: string) => errors.push(message), warn = (message: string) => warnings.push(message);
  const stage = get('DEPLOY_ENV') === 'staging' ? 'staging' : 'production';

  if (get('NODE_ENV') !== 'production') error('Set NODE_ENV=production.');
  if (!get('DATABASE_URL')) error('Set DATABASE_URL, connecting as the restricted role (see app-role), not the owner.');
  if (get('AUTH_MODE') !== 'code') error('Set AUTH_MODE=code: production signs in with codes sent by email.');
  if (!get('RESEND_API_KEY') || !get('EMAIL_FROM')) error('Set RESEND_API_KEY and EMAIL_FROM: sign-in codes and notifications are sent by email.');

  // Secrets: long enough, and never the same key twice (one leaked key must not open the others).
  // CALENDAR_SECRET is optional: without it members cannot connect a calendar (a warning, below).
  const secrets: [string, boolean][] = [['MFA_ENCRYPTION_KEY', true], ['CALENDAR_SECRET', false], ['WHATSAPP_NUMBER_SECRET', false], ['PAYMENTS_TEST_SECRET', false]];
  for (const [key, required] of secrets) {
    const value = get(key);
    if (!value) { if (required) error(`Set ${key} (${SECRET_MIN} or more random characters).`); continue; }
    if (value.length < SECRET_MIN) error(`${key} is too short: use ${SECRET_MIN} or more random characters.`);
    if (/^(development|test|changeme|secret|password)/i.test(value)) error(`${key} looks like a placeholder: generate a random value.`);
  }
  const given = secrets.map(([key]) => [key, get(key)] as const).filter(([, value]) => value);
  for (let i = 0; i < given.length; i++) for (let j = i + 1; j < given.length; j++) {
    if (given[i]![1] === given[j]![1]) error(`${given[i]![0]} and ${given[j]![0]} are the same: each must be its own random value.`);
  }

  // Addresses: the browser apps that may call with cookies, and where links in emails point.
  const origins = get('WEB_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origins.length) error('Set WEB_ORIGINS to the web app, admin console and shop addresses (comma-separated). Without it only localhost is allowed.');
  for (const origin of origins) {
    if (!isHttps(origin)) error(`WEB_ORIGINS: ${origin} must be an https:// address.`);
    else if (isLocal(origin)) error(`WEB_ORIGINS: ${origin} is this machine, not a public address.`);
  }
  // Without WEB_URL, every link in every email would point at localhost.
  if (!get('WEB_URL')) error('Set WEB_URL to the web app\'s address: links in emails point there.');
  if (!get('ADMIN_URL')) warn('ADMIN_URL is not set: staff emails link to https://admin.quintaralifestyle.com.');
  for (const key of ['WEB_URL', 'ADMIN_URL']) {
    if (get(key) && (!isHttps(get(key)) || isLocal(get(key)))) error(`${key} must be the public https:// address.`);
  }
  if (get('API_URL') && (!isHttps(get('API_URL')) || isLocal(get('API_URL')))) error('API_URL must be the API\'s public https:// address.');

  // Review account (app store review): a fixed code needs a fixed second step, different from it.
  if (get('REVIEW_EMAIL')) {
    if (!/^\d{6}$/.test(get('REVIEW_CODE'))) error('REVIEW_CODE must be six digits when REVIEW_EMAIL is set.');
    if (!/^\d{6}$/.test(get('REVIEW_2FA_CODE'))) error('Set REVIEW_2FA_CODE (six digits) for the review account, or remove REVIEW_EMAIL.');
    else if (get('REVIEW_2FA_CODE') === get('REVIEW_CODE')) error('REVIEW_2FA_CODE must differ from REVIEW_CODE.');
    if (stage === 'production') warn('REVIEW_EMAIL is set: an app store review account can sign in with fixed codes. Remove it once the review is done.');
  }

  // Development switches have no place here.
  if (get('SIGN_IN_LIMIT')) warn('SIGN_IN_LIMIT is ignored in production (sign-in attempts stay at 10 a minute); remove it.');
  if (get('TWO_FACTOR') && get('TWO_FACTOR') !== 'required') warn('TWO_FACTOR is ignored in production: two-factor is always required.');
  if (get('PAYMENTS') === 'simulated' && stage === 'production') error('PAYMENTS=simulated would mark payments paid without taking money. Remove it.');

  // Payments: until a provider is chosen, production takes no money; staging uses the test checkout.
  if (stage === 'staging') {
    if (!get('PAYMENTS_TEST_SECRET')) error('Staging uses the test checkout: set PAYMENTS_TEST_SECRET (32+ random characters).');
    if (!get('API_URL')) error('Staging uses the test checkout: set API_URL to the API\'s public address, for its links.');
    warn('Staging\'s test checkout keeps open checkouts in the API process: run one API process, and expect a checkout open during a restart to be reported as failed.');
  } else {
    warn('Payments: no payment provider is configured, so production refuses payments. This stays until a provider is chosen and its adapter added.');
  }

  // Several API processes share rate limits only through Redis; behind a load balancer, addresses come from it.
  if (!get('REDIS_URL')) warn('REDIS_URL is not set: rate limits are counted per process, so run exactly one API process.');
  if (!get('TRUST_PROXY')) warn('TRUST_PROXY is not set: behind a load balancer (every suggested host), set TRUST_PROXY=true so rate limits see real addresses.');
  if (!get('MEDIA_S3_BUCKET')) warn('MEDIA_S3_BUCKET is not set: photographs are kept in the database.');
  if (!get('AUDIT_S3_BUCKET')) warn('AUDIT_S3_BUCKET is not set: the audit log has no write-once copies outside the database.');
  for (const prefix of ['MEDIA_S3', 'AUDIT_S3']) {
    if (get(`${prefix}_BUCKET`) && (!get(`${prefix}_ACCESS_KEY_ID`) || !get(`${prefix}_SECRET_ACCESS_KEY`))) warn(`${prefix}_BUCKET is set without its own keys: the host's default credentials will be used.`);
  }
  if (!get('CALENDAR_SECRET')) warn('CALENDAR_SECRET is not set: members cannot connect a calendar to QÉRA.');
  if (!get('ANTHROPIC_API_KEY')) warn('ANTHROPIC_API_KEY is not set: QÉRA uses its built-in rule-based model.');
  const whatsapp = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_BUSINESS_NUMBER', 'WHATSAPP_NUMBER_SECRET'];
  const setCount = whatsapp.filter((key) => get(key)).length;
  if (setCount > 0 && setCount < whatsapp.length) error(`WhatsApp needs all six settings; missing: ${whatsapp.filter((key) => !get(key)).join(', ')}.`);
  if (!get('EXPO_ACCESS_TOKEN')) warn('EXPO_ACCESS_TOKEN is not set: push notifications are sent without Expo\'s enhanced security.');
  for (const key of Object.keys(env).filter((k) => /^RETENTION_.*_DAYS$/.test(k))) {
    const days = Number(get(key));
    if (get(key) && (!Number.isInteger(days) || days < 1 || days > 3650)) error(`${key} must be a whole number of days from 1 to 3650.`);
  }
  return { errors, warnings };
}

/** What only the database can tell: the role connected, migrations applied, first-run done, no sample data. */
export async function checkDatabase(db: import('./db.ts').Queryable, migrationFiles: string[], options: { pendingAllowed?: boolean } = {}): Promise<Findings> {
  const errors: string[] = [], warnings: string[] = [];
  const role = (await db.query<{ rolsuper: boolean; owns: string }>(
    `SELECT r.rolsuper, (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns FROM pg_roles r WHERE r.rolname = current_user`))[0];
  if (role?.rolsuper || Number(role?.owns ?? 0) > 0) errors.push('DATABASE_URL connects as the owner (or a superuser). The API must use the restricted role from app-role, so the audit log stays append-only.');

  const applied = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`).catch((error: { code?: string }) => {
    if (error.code === '42P01') return [];                                        // no table: nothing migrated yet
    if (error.code === '42501') throw new Error('The API\'s role cannot read schema_migrations: run app-role again with this version.');
    throw error;
  })).map((r) => r.name));
  const pending = migrationFiles.filter((f) => !applied.has(f));
  if (!applied.size) errors.push('The database has no migrations applied: run migrate with the owner\'s connection first.');
  else if (pending.length) (options.pendingAllowed ? warnings : errors).push(`Migrations not yet applied: ${pending.join(', ')}. Run migrate with the owner's connection before deploying this version.`);
  if (!applied.size) return { errors, warnings };

  if (!Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM markets`))[0]!.n)) errors.push('No city is set up: run first-run.');
  const admins = Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM staff_accounts s JOIN user_roles r ON r.user_id = s.user_id AND r.role_key = 'admin' WHERE s.status = 'active'`))[0]!.n);
  if (!admins) errors.push('No active Super Administrator: run first-run with SETUP_ADMIN_EMAIL.');
  else if (admins === 1) warnings.push('Only one active Super Administrator: add a second, so a lost phone cannot lock everyone out.');
  const samples = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE email LIKE '%@example.com' AND deleted_at IS NULL`))[0]!.n);
  if (samples) errors.push(`The database holds ${samples} sample account(s) (@example.com): this is development data, not production's.`);
  return { errors, warnings };
}
