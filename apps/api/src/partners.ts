/** Lifestyle partners and privileges: what members see and redeem, and what staff manage. */
import { randomBytes } from 'node:crypto';
import { partnerInputSchema, privilegeInputSchema } from '@quintara/domain';
import type { Partner, Privilege, Redemption } from '@quintara/domain';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (value: unknown) => (value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null);

/** $1 is the viewing member (NULL for staff), used only to count their own redemptions. */
const SELECT_PRIVILEGE = `
  SELECT v.id, v.partner_id, v.title, v.details, v.terms, v.valid_until, v.uses_per_member, v.status,
         (v.valid_until IS NOT NULL AND v.valid_until < CURRENT_DATE) AS expired,
         (SELECT count(*) FROM privilege_redemptions r WHERE r.privilege_id = v.id AND r.member_id = $1) AS my_uses,
         (SELECT count(*) FROM privilege_redemptions r WHERE r.privilege_id = v.id) AS total_uses
    FROM privileges v`;

function toPrivilege(row: Row): Privilege & { status: string; totalUses: number } {
  const limit = Number(row.uses_per_member), mine = Number(row.my_uses);
  return {
    id: row.id as string, partnerId: row.partner_id as string, title: row.title as string, details: row.details as string, terms: row.terms as string,
    validUntil: day(row.valid_until), usesPerMember: limit, myUses: mine,
    available: !row.expired && (limit === 0 || mine < limit),
    status: row.status as string, totalUses: Number(row.total_uses),
  };
}
const forMember = ({ status: _status, totalUses: _total, ...privilege }: ReturnType<typeof toPrivilege>): Privilege => privilege;

function toPartner(row: Row, privileges: Privilege[]): Partner {
  return { id: row.id as string, name: row.name as string, category: row.category as string, summary: row.summary as string, description: row.description as string, area: row.area as string, website: (row.website as string | null) ?? null,
    offer: row.offer as string, contactName: row.contact_name as string, contactEmail: row.contact_email as string, contactPhone: row.contact_phone as string, address: row.address as string, privileges };
}

/* ---------- Members ---------- */

export async function listPartners(db: Queryable, ctx: RequestContext): Promise<Partner[]> {
  const session = requireMember(ctx, 'privileges.use');
  const partners = await db.query(`SELECT * FROM partners WHERE status = 'published' AND market_id = $1 ORDER BY name`, [ctx.marketId]);
  const privileges = (await db.query(`${SELECT_PRIVILEGE} JOIN partners p ON p.id = v.partner_id WHERE v.status = 'published' AND p.status = 'published' AND p.market_id = $2 ORDER BY v.created_at`, [session.memberId, ctx.marketId])).map(toPrivilege);
  return partners.map((row) => toPartner(row, privileges.filter((v) => v.partnerId === row.id).map(forMember)));
}

export async function getPartner(db: Queryable, ctx: RequestContext, id: string): Promise<Partner> {
  const partner = (await listPartners(db, ctx)).find((candidate) => candidate.id === id);
  if (!partner) throw notFound('This partner is not available.');
  return partner;
}

/** Issues a code for one use of a privilege. The limit is checked under a lock, so two taps cannot both pass it. */
export async function redeemPrivilege(db: Db, ctx: RequestContext, privilegeId: string): Promise<Redemption> {
  const session = requireMember(ctx, 'privileges.use');
  return db.tx(async (tx) => {
    // Lock the member's row: every redemption by this member waits its turn.
    await tx.query('SELECT 1 FROM members WHERE id = $1 FOR UPDATE', [session.memberId]);
    const rows = UUID.test(privilegeId)
      ? await tx.query(`${SELECT_PRIVILEGE} JOIN partners p ON p.id = v.partner_id WHERE v.id = $2 AND v.status = 'published' AND p.status = 'published' AND p.market_id = $3`, [session.memberId, privilegeId, ctx.marketId])
      : [];
    if (!rows[0]) throw notFound('This privilege is not available.');
    const privilege = toPrivilege(rows[0]);
    if (rows[0].expired) throw conflict('This privilege has ended.');
    if (!privilege.available) throw conflict('You have already used this privilege.');
    const code = 'QP-' + randomBytes(4).toString('hex').toUpperCase();
    const id = (await tx.query<{ id: string }>('INSERT INTO privilege_redemptions (privilege_id, member_id, code) VALUES ($1, $2, $3) RETURNING id', [privilegeId, session.memberId, code]))[0]!.id;
    await audit(tx, session.userId, 'privilege.redeemed', 'privilege', privilegeId);
    return (await redemptions(tx, session.memberId, id))[0]!;
  });
}

async function redemptions(db: Queryable, memberId: string, id: string | null = null): Promise<Redemption[]> {
  const rows = await db.query(
    `SELECT r.id, r.code, r.redeemed_at, v.id AS privilege_id, v.title, p.name AS partner_name
       FROM privilege_redemptions r JOIN privileges v ON v.id = r.privilege_id JOIN partners p ON p.id = v.partner_id
      WHERE r.member_id = $1 AND ($2::uuid IS NULL OR r.id = $2) ORDER BY r.redeemed_at DESC LIMIT 200`, [memberId, id]);
  return rows.map((row) => ({ id: row.id as string, code: row.code as string, privilegeId: row.privilege_id as string, privilegeTitle: row.title as string, partnerName: row.partner_name as string, redeemedAt: new Date(row.redeemed_at as string).toISOString() }));
}

export async function listMyRedemptions(db: Queryable, ctx: RequestContext): Promise<Redemption[]> {
  return redemptions(db, requireMember(ctx, 'privileges.use').memberId);
}

/* ---------- Staff ---------- */

const PARTNER_COLUMNS: Record<string, string> = { name: 'name', category: 'category', summary: 'summary', description: 'description', area: 'area', website: 'website', status: 'status', offer: 'offer', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', address: 'address' };
const PRIVILEGE_COLUMNS: Record<string, string> = { title: 'title', details: 'details', terms: 'terms', validUntil: 'valid_until', usesPerMember: 'uses_per_member', status: 'status' };
const sentKeys = (columns: Record<string, string>, body: unknown, data: Record<string, unknown>) => Object.keys(columns).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);

export async function listPartnersForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.providers.manage');
  const partners = await db.query('SELECT * FROM partners WHERE market_id = $1 ORDER BY (status = \'archived\'), name', [ctx.marketId]);
  const privileges = (await db.query(`${SELECT_PRIVILEGE} ORDER BY v.created_at`, [null])).map(toPrivilege);
  return partners.map((row) => ({ ...toPartner(row, []), status: row.status as string, privileges: privileges.filter((v) => v.partnerId === row.id) }));
}

export async function createPartner(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.providers.manage');
  const parsed = partnerInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if ((await db.query('SELECT 1 FROM partners WHERE market_id = $1 AND lower(name) = lower($2)', [marketId, d.name]))[0]) throw conflict('A partner with that name already exists.');
  const id = (await db.query<{ id: string }>(
    'INSERT INTO partners (market_id, name, category, summary, description, area, website, status, offer, contact_name, contact_email, contact_phone, address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id',
    [marketId, d.name, d.category, d.summary, d.description, d.area, d.website ?? null, d.status, d.offer, d.contactName, d.contactEmail, d.contactPhone, d.address]))[0]!.id;
  await audit(db, staffId, 'partner.created', 'partner', id, { name: d.name });
  return { id };
}

export async function updatePartner(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.providers.manage');
  const parsed = partnerInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = sentKeys(PARTNER_COLUMNS, body, data);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM partners WHERE id = $1', [id]))[0]) throw notFound('This partner does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE partners SET ${sent.map((k, i) => `${PARTNER_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, 'partner.updated', 'partner', id, { fields: sent });
}

export async function createPrivilege(db: Db, ctx: RequestContext, partnerId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.providers.manage');
  const parsed = privilegeInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (!UUID.test(partnerId) || !(await db.query('SELECT 1 FROM partners WHERE id = $1', [partnerId]))[0]) throw notFound('This partner does not exist.');
  const d = parsed.data;
  const id = (await db.query<{ id: string }>(
    'INSERT INTO privileges (partner_id, title, details, terms, valid_until, uses_per_member, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [partnerId, d.title, d.details, d.terms, d.validUntil ?? null, d.usesPerMember, d.status]))[0]!.id;
  await audit(db, staffId, 'privilege.created', 'privilege', id, { title: d.title });
  return { id };
}

export async function updatePrivilege(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.providers.manage');
  const parsed = privilegeInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = sentKeys(PRIVILEGE_COLUMNS, body, data);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM privileges WHERE id = $1', [id]))[0]) throw notFound('This privilege does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE privileges SET ${sent.map((k, i) => `${PRIVILEGE_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, 'privilege.updated', 'privilege', id, { fields: sent });
}
