/**
 * Cities. The apps send the city being viewed in a header; this module turns it into the request's market and lets
 * staff open, close and add cities. Nothing in the schema assumes Cape Town: each city carries its own time zone and
 * currency.
 */
import { marketInputSchema } from '@quintara/domain';
import type { Market } from '@quintara/domain';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { addDefaultPlans } from './application-form.ts';

const SELECT = `SELECT m.id, m.slug, m.name, m.currency_code, m.is_active, m.position, c.timezone, k.name AS country
  FROM markets m JOIN cities c ON c.id = m.city_id JOIN countries k ON k.code = c.country_code`;
const toMarket = (row: Row): Market => ({ id: row.id as string, slug: row.slug as string, name: row.name as string, country: row.country as string, timezone: row.timezone as string, currency: (row.currency_code as string).trim(), isOpen: Boolean(row.is_active) });

/** The cities open to members, guests and visitors. */
export async function listOpenMarkets(db: Queryable): Promise<Market[]> {
  return (await db.query(`${SELECT} WHERE m.is_active ORDER BY m.position, m.created_at`)).map(toMarket);
}

/**
 * Which city this request is about: the one asked for, if it is open (staff may ask for a closed one); otherwise
 * the member's or guest's home city if it is open; otherwise the first open city.
 */
export async function resolveMarket(db: Queryable, ctx: RequestContext, asked: string | undefined): Promise<string> {
  const rows = await db.query<{ id: string; slug: string; is_active: boolean }>('SELECT id, slug, is_active FROM markets ORDER BY position, created_at');
  const staff = ctx.staffRoles.length > 0;
  const wanted = asked ? rows.find((r) => r.slug === asked || r.id === asked) : undefined;
  if (wanted && (wanted.is_active || staff)) return wanted.id;
  const home = ctx.session?.marketId ? rows.find((r) => r.id === ctx.session!.marketId && r.is_active) : undefined;
  if (home) return home.id;
  const open = rows.find((r) => r.is_active);
  if (open) return open.id;
  if (staff && rows[0]) return rows[0].id;
  throw new HttpError(503, 'Quintara is not open in any city yet.');
}

export interface StaffMarket extends Market { experiences: number; members: number; partners: number; services: number; products: number }

export async function listMarketsForStaff(db: Queryable, ctx: RequestContext): Promise<StaffMarket[]> {
  // Every member of staff sees the cities, to choose where to work; only those allowed open, close or add them.
  if (!ctx.userId) requireStaff(ctx, 'admin.markets.manage');
  if (!ctx.staffRoles.length) throw new HttpError(403, 'This is for Quintara staff.');
  const rows = await db.query(`${SELECT.replace('SELECT m.id,', `SELECT
      (SELECT count(*) FROM experiences e WHERE e.market_id = m.id AND e.status <> 'cancelled') AS experiences,
      (SELECT count(*) FROM members x WHERE x.home_market_id = m.id AND x.status = 'active') AS members,
      (SELECT count(*) FROM partners p WHERE p.market_id = m.id AND p.status <> 'archived') AS partners,
      (SELECT count(*) FROM lifestyle_services s WHERE s.market_id = m.id AND s.status <> 'archived') AS services,
      (SELECT count(*) FROM products p WHERE p.market_id = m.id AND p.status <> 'archived') AS products, m.id,`)} ORDER BY m.position, m.created_at`);
  return rows.map((row) => ({ ...toMarket(row), experiences: Number(row.experiences), members: Number(row.members), partners: Number(row.partners), services: Number(row.services), products: Number(row.products) }));
}

const slugOf = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Adds a city, closed, so staff can prepare it before opening it. */
export async function createMarket(db: Db, ctx: RequestContext, body: unknown): Promise<Market> {
  const staffId = requireStaff(ctx, 'admin.markets.manage');
  const parsed = marketInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data, slug = slugOf(d.name);
  if (!slug) throw new HttpError(422, 'Enter the city.', { name: 'Enter the city' });
  return db.tx(async (tx) => {
    if ((await tx.query('SELECT 1 FROM markets WHERE slug = $1', [slug]))[0]) throw conflict('That city has already been added.');
    if (!(await tx.query('SELECT 1 FROM countries WHERE code = $1', [d.countryCode]))[0]) {
      if (!d.countryName) throw new HttpError(422, 'Name the country, as it is new to Quintara.', { countryName: 'Name the country' });
      await tx.query('INSERT INTO countries (code, name) VALUES ($1, $2)', [d.countryCode, d.countryName]);
    }
    await tx.query('INSERT INTO currencies (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [d.currency, d.currency]);
    const city = (await tx.query<{ id: string }>(`INSERT INTO cities (country_code, name, timezone) VALUES ($1, $2, $3)
      ON CONFLICT (country_code, name) DO UPDATE SET timezone = EXCLUDED.timezone RETURNING id`, [d.countryCode, d.name, d.timezone]))[0]!.id;
    const position = Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM markets'))[0]!.n);
    const id = (await tx.query<{ id: string }>('INSERT INTO markets (city_id, slug, name, currency_code, is_active, position) VALUES ($1, $2, $3, $4, false, $5) RETURNING id',
      [city, slug, d.name, d.currency, position]))[0]!.id;
    await addDefaultPlans(tx, id, d.currency);
    await audit(tx, staffId, 'market.created', 'market', id, { name: d.name });
    return toMarket((await tx.query(`${SELECT} WHERE m.id = $1`, [id]))[0]!);
  });
}

/** Opens or closes a city. The last open city cannot be closed, or nobody could use Quintara. */
export async function setMarketOpen(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<Market> {
  const staffId = requireStaff(ctx, 'admin.markets.manage');
  const open = (body as { isOpen?: unknown } | null)?.isOpen;
  if (typeof open !== 'boolean') throw new HttpError(422, 'Say whether the city is open.');
  return db.tx(async (tx) => {
    const row = /^[0-9a-f-]{36}$/i.test(id) ? (await tx.query<{ is_active: boolean }>('SELECT is_active FROM markets WHERE id = $1 FOR UPDATE', [id]))[0] : undefined;
    if (!row) throw notFound('This city does not exist.');
    if (!open && row.is_active && Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM markets WHERE is_active'))[0]!.n) <= 1) throw conflict('At least one city must stay open.');
    await tx.query('UPDATE markets SET is_active = $2, opened_at = CASE WHEN $2 AND opened_at IS NULL THEN now() ELSE opened_at END WHERE id = $1', [id, open]);
    await audit(tx, staffId, open ? 'market.opened' : 'market.closed', 'market', id);
    return toMarket((await tx.query(`${SELECT} WHERE m.id = $1`, [id]))[0]!);
  });
}
