/** The checks a deployment must pass: the settings, the database it will use, and the API refusing to start without them. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { migrate } from '../src/migrate.ts';
import { checkDatabase, checkDeployment } from '../src/preflight.ts';
import { freshPostgres, startServer } from './harness.ts';

const random = (seed: string) => `${seed}-${'x'.repeat(40)}`;
/** A complete production configuration, as the release would set it. */
const good = (): Record<string, string> => ({
  NODE_ENV: 'production', DEPLOY_ENV: 'production', DATABASE_URL: 'postgres://quintara_app:pw@db.internal:5432/quintara', AUTH_MODE: 'code',
  RESEND_API_KEY: 're_live', EMAIL_FROM: 'Quintara <hello@quintaralifestyle.com>',
  MFA_ENCRYPTION_KEY: random('k1'), CALENDAR_SECRET: random('k2'),
  WEB_ORIGINS: 'https://app.quintaralifestyle.com,https://admin.quintaralifestyle.com,https://maison.quintaralifestyle.com',
  WEB_URL: 'https://app.quintaralifestyle.com', ADMIN_URL: 'https://admin.quintaralifestyle.com',
  REDIS_URL: 'rediss://cache.internal:6379', TRUST_PROXY: 'true',
});
const migrationFiles = async () => (await readdir(new URL('../../../db/migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();

test('a complete production configuration passes; the decisions still open are warnings', () => {
  const { errors, warnings } = checkDeployment(good());
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.startsWith('Payments: no payment provider')));
  assert.ok(warnings.some((w) => w.includes('MEDIA_S3_BUCKET')));
});

test('each mistake is named', () => {
  const errorsFor = (changes: Record<string, string | undefined>) => checkDeployment({ ...good(), ...changes }).errors.join(' | ');
  assert.match(errorsFor({ AUTH_MODE: 'dev' }), /AUTH_MODE=code/);
  assert.match(errorsFor({ WEB_ORIGINS: undefined }), /Set WEB_ORIGINS/);
  assert.match(errorsFor({ WEB_ORIGINS: 'http://app.quintaralifestyle.com' }), /must be an https/);
  assert.match(errorsFor({ WEB_ORIGINS: 'https://localhost:3000' }), /is this machine/);
  assert.match(errorsFor({ WEB_URL: undefined }), /Set WEB_URL/);                                     // or email links point at localhost
  assert.match(errorsFor({ MFA_ENCRYPTION_KEY: 'short' }), /MFA_ENCRYPTION_KEY is too short/);
  assert.match(errorsFor({ CALENDAR_SECRET: good().MFA_ENCRYPTION_KEY }), /are the same/);
  assert.match(errorsFor({ MFA_ENCRYPTION_KEY: 'development-only-two-factor-key-do-not-use' }), /placeholder/);
  assert.match(errorsFor({ PAYMENTS: 'simulated' }), /without taking money/);
  assert.match(errorsFor({ WHATSAPP_ACCESS_TOKEN: 'EAAG' }), /WhatsApp needs all six settings/);
  assert.match(errorsFor({ REVIEW_EMAIL: 'review@quintaralifestyle.com', REVIEW_CODE: '123456', REVIEW_2FA_CODE: '123456' }), /must differ/);
  assert.match(errorsFor({ RETENTION_EMAIL_DAYS: 'forever' }), /RETENTION_EMAIL_DAYS/);
  // Staging uses the test checkout, which needs its secret and the API's public address.
  assert.match(errorsFor({ DEPLOY_ENV: 'staging' }), /PAYMENTS_TEST_SECRET[\s\S]*API_URL/);
  assert.deepEqual(checkDeployment({ ...good(), DEPLOY_ENV: 'staging', PAYMENTS_TEST_SECRET: random('k3'), API_URL: 'https://api-staging.quintaralifestyle.com' }).errors, []);
});

test('the database: sample data, the owner connection and a missing first-run are each refused', async () => {
  // The development database: seeded with sample accounts, connected as its owner.
  const s = await startServer();
  try {
    // The owner's connection is refused. (Where the suite runs as the restricted role, s.db is that role.)
    assert.ok((await checkDatabase(s.ownerDb, await migrationFiles())).errors.some((e) => e.includes('connects as the owner')));
    const { errors } = await checkDatabase(s.db, await migrationFiles());
    assert.ok(errors.some((e) => e.includes('sample account')), errors.join(' | '));
    assert.ok(!errors.some((e) => e.includes('Migrations not yet applied')), 'every migration is applied');
    assert.equal((await checkDatabase(s.db, [...await migrationFiles(), '9999_from_a_newer_release.sql'])).errors.some((e) => e.includes('9999_from_a_newer_release.sql')), true);
  } finally { await s.close(); }
});

test('the database, as production will have it: restricted role, migrated, first-run done, no sample data', { skip: !process.env.TEST_DATABASE_URL && 'needs TEST_DATABASE_URL' }, async () => {
  const fresh = (await freshPostgres())!;
  try {
    await migrate(fresh.db);
    const app = await fresh.asAppRole();
    const before = await checkDatabase(app, await migrationFiles());
    assert.ok(before.errors.some((e) => e.includes('No city')) && before.errors.some((e) => e.includes('Super Administrator')), before.errors.join(' | '));
    assert.ok(!before.errors.some((e) => e.includes('owner')), 'the restricted role is accepted');
    assert.ok((await checkDatabase(fresh.db, await migrationFiles())).errors.some((e) => e.includes('owner')), 'the owner is refused');
    // First-run, as the release runs it, with the owner's connection.
    const owner = new URL(process.env.TEST_DATABASE_URL!);
    owner.pathname = `/${(await fresh.db.query<{ name: string }>('SELECT current_database() AS name'))[0]!.name}`;
    await new Promise<void>((resolve, reject) => {
      const run = spawn(process.execPath, ['--experimental-strip-types', 'src/setup-cli.ts'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, DATABASE_URL: owner.toString(), SETUP_ADMIN_EMAIL: 'first.admin@quintaralifestyle.com', SETUP_ADMIN_NAME: 'First Admin' }, stdio: 'ignore' });
      run.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`first-run exited ${code}`))));
    });
    const after = await checkDatabase(app, await migrationFiles());
    assert.deepEqual(after.errors, []);
    assert.ok(after.warnings.some((w) => w.includes('Only one active Super Administrator')));
  } finally { await fresh.db.close(); await fresh.drop(); }
});

test('in production the API lists every problem with its settings and does not start', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
    env: { PATH: process.env.PATH!, NODE_ENV: 'production', PORT: '0', AUTH_MODE: 'dev', WEB_ORIGINS: 'http://localhost:3000' },
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  for (const expected of ['DATABASE_URL', 'AUTH_MODE=code', 'RESEND_API_KEY', 'MFA_ENCRYPTION_KEY', 'WEB_ORIGINS', 'WEB_URL']) assert.ok(output.includes(expected), `${expected} in:\n${output}`);
});
