/**
 * First-run setup for a new production database, after `migrate`. Safe to run again: it only adds what is missing.
 *
 *   DATABASE_URL=… SETUP_ADMIN_EMAIL=you@quintaralifestyle.com pnpm --filter @quintara/api run first-run
 *
 * Creates the first city (Cape Town unless SETUP_CITY, SETUP_COUNTRY_CODE, SETUP_COUNTRY, SETUP_TIMEZONE and
 * SETUP_CURRENCY say otherwise) with the standard membership plans, and the first admin, who signs in to the admin
 * console with a code sent to that address and adds everything else there. With REVIEW_EMAIL set, it also creates
 * the member account app store reviewers sign in with (using REVIEW_CODE, set on the API).
 */
import { addDefaultPlans } from './application-form.ts';
import { createPostgresDb } from './db.ts';

const env = process.env;
if (!env.DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(1); }
const admin = (env.SETUP_ADMIN_EMAIL ?? '').trim().toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(admin)) { console.error('Set SETUP_ADMIN_EMAIL to the first administrator\'s address.'); process.exit(1); }
const city = env.SETUP_CITY ?? 'Cape Town', countryCode = (env.SETUP_COUNTRY_CODE ?? 'ZA').toUpperCase(), country = env.SETUP_COUNTRY ?? 'South Africa';
const timezone = env.SETUP_TIMEZONE ?? 'Africa/Johannesburg', currency = (env.SETUP_CURRENCY ?? 'ZAR').toUpperCase();
const slug = city.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const db = createPostgresDb(env.DATABASE_URL);
const done: string[] = [];
await db.tx(async (tx) => {
  const one = async (sql: string, params: unknown[] = []) => (await tx.query<{ id: string }>(sql, params))[0]?.id;
  await tx.query('INSERT INTO currencies (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [currency, currency === 'ZAR' ? 'South African rand' : currency]);
  await tx.query('INSERT INTO countries (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [countryCode, country]);
  const cityId = await one(`INSERT INTO cities (country_code, name, timezone) VALUES ($1, $2, $3) ON CONFLICT (country_code, name) DO UPDATE SET timezone = EXCLUDED.timezone RETURNING id`, [countryCode, city, timezone]);
  let marketId = await one('SELECT id FROM markets WHERE slug = $1', [slug]);
  if (!marketId) {
    marketId = await one(`INSERT INTO markets (city_id, slug, name, currency_code, is_active, opened_at) VALUES ($1, $2, $3, $4, true, now()) RETURNING id`, [cityId, slug, city, currency]);
    done.push(`opened ${city}`);
  }
  await addDefaultPlans(tx, marketId!, currency);

  let adminId = await one(`SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [admin]);
  if (!adminId) { adminId = await one(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [admin]); done.push(`created ${admin}`); }
  await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [adminId]);
  // The first of the admin console's accounts (five in all); the others are added in the console, under Staff.
  await tx.query(`INSERT INTO staff_accounts (user_id, full_name, title) VALUES ($1, $2, 'Administrator') ON CONFLICT (user_id) DO UPDATE SET status = 'active'`, [adminId, (env.SETUP_ADMIN_NAME ?? '').trim() || admin.split('@')[0]]);

  const review = (env.REVIEW_EMAIL ?? '').trim().toLowerCase();
  if (review && !(await one(`SELECT id FROM users WHERE lower(email) = $1`, [review]))) {
    const tier = await one(`SELECT id FROM membership_tiers WHERE market_id = $1 AND is_active ORDER BY residency DESC NULLS LAST, term_months DESC LIMIT 1`, [marketId]);
    const userId = await one(`INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`, [review]);
    await tx.query(`INSERT INTO profiles (user_id, full_name, position, company, industry, city, interests, show_in_directory) VALUES ($1, 'App Review', 'Reviewer', '', 'Technology', $2, '{}'::text[], false)`, [userId, city]);
    await tx.query(`INSERT INTO members (user_id, member_number, home_market_id, tier_id) VALUES ($1, 'Q-' || nextval('member_number_seq'), $2, $3)`, [userId, marketId, tier]);
    await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'member')`, [userId]);
    done.push(`created the review member ${review}, hidden from the directory`);
  }
});
await db.close();
console.log(done.length ? `Set up: ${done.join('; ')}.` : 'Already set up. Nothing to add.');
console.log(`Next: sign in to the admin console as ${admin} with the code sent by email.`);
