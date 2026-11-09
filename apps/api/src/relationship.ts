/**
 * Business, the Quintara side: opportunities the team publishes, corrections to members' listings,
 * and the relationship manager.
 *
 * The same limits apply as in business.ts. An opportunity has no price, valuation or terms. A member pursues
 * one by writing to the relationship manager: a private conversation with staff who hold admin.business.manage.
 * The relationship manager shares insight and facilitates introductions; nothing here moves money, and no
 * member's details are passed to another member by this module.
 */
import { BUSINESS_ROLES, RELATIONSHIP_MANAGER, businessUpdateInputSchema, listingInputSchema, messageBodySchema, rmEnquiryInputSchema } from '@quintara/domain';
import type { BusinessRole, BusinessUpdate, RmEnquiry, RmMessage, Role } from '@quintara/domain';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessRoles = (roles: readonly Role[]) => roles.filter((role): role is BusinessRole => (BUSINESS_ROLES as readonly string[]).includes(role));
const iso = (value: unknown) => new Date(value as string).toISOString();
const notify = (db: Queryable, userId: string, title: string) =>
  db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'membership_update', $2, NULL)`, [userId, title]);

/* ---------- Opportunities from Quintara ---------- */

const toUpdate = (row: Row): BusinessUpdate => ({
  id: row.id as string, title: row.title as string, summary: row.summary as string, sector: row.sector as string,
  audience: row.audience as BusinessRole[], publishedAt: iso(row.updated_at),
});
/** Published, and addressed to everyone or to one of the viewer's roles. */
const VISIBLE_UPDATE = `u.status = 'published' AND u.market_id = $1 AND (cardinality(u.audience) = 0 OR u.audience && $2::text[])`;

export async function listUpdates(db: Queryable, ctx: RequestContext): Promise<BusinessUpdate[]> {
  const session = requireMember(ctx, 'business.view');
  const rows = await db.query(`SELECT u.* FROM business_updates u WHERE ${VISIBLE_UPDATE} ORDER BY u.updated_at DESC LIMIT 100`, [ctx.marketId, businessRoles(session.roles)]);
  return rows.map(toUpdate);
}

export async function listUpdatesForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.business.manage');
  const rows = await db.query(`SELECT u.*, (SELECT count(*) FROM rm_enquiries e WHERE e.update_id = u.id) AS enquiries FROM business_updates u WHERE u.market_id = $1 ORDER BY (u.status = 'archived'), u.updated_at DESC LIMIT 300`, [ctx.marketId]);
  return rows.map((row) => ({ ...toUpdate(row), status: row.status as string, enquiries: Number(row.enquiries) }));
}

export async function createUpdate(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const parsed = businessUpdateInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const id = (await db.query<{ id: string }>(
    'INSERT INTO business_updates (market_id, title, summary, sector, audience, status, created_by) VALUES ($1, $2, $3, $4, $5::text[], $6, $7) RETURNING id',
    [marketId, d.title, d.summary, d.sector, [...new Set(d.audience)], d.status, staffId]))[0]!.id;
  await audit(db, staffId, 'business_update.created', 'business_update', id, { status: d.status });
  return { id };
}

const UPDATE_COLUMNS = ['title', 'summary', 'sector', 'audience', 'status'] as const;

export async function updateUpdate(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const parsed = businessUpdateInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = UPDATE_COLUMNS.filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM business_updates WHERE id = $1', [id]))[0]) throw notFound('This opportunity does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE business_updates SET ${sent.map((k, i) => `${k} = $${i + 2}${k === 'audience' ? '::text[]' : ''}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...sent.map((k) => (k === 'audience' ? [...new Set(data[k] as string[])] : data[k]))]);
  await audit(db, staffId, 'business_update.updated', 'business_update', id, { fields: sent });
}

/** Removes the opportunity. Conversations already started about it are kept, without the link. */
export async function deleteUpdate(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const rows = UUID.test(id) ? await db.query<{ title: string }>('DELETE FROM business_updates WHERE id = $1 RETURNING title', [id]) : [];
  if (!rows[0]) throw notFound('This opportunity does not exist.');
  await audit(db, staffId, 'business_update.deleted', 'business_update', id, { title: rows[0].title });
}

/* ---------- Members' listings: corrections by staff ---------- */

export async function editListing(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  // The kind is not editable: who may post about raising capital, and who may see it, is decided when it is written.
  const parsed = listingInputSchema.omit({ kind: true }).partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  const current = UUID.test(id) ? (await db.query<{ kind: string; user_id: string; title: string }>('SELECT l.kind, m.user_id, l.title FROM business_listings l JOIN members m ON m.id = l.member_id WHERE l.id = $1', [id]))[0] : undefined;
  if (!current) throw notFound('This listing does not exist.');
  const sets: string[] = [], values: unknown[] = [id];
  const set = (column: string, value: unknown, cast = '') => { values.push(value); sets.push(`${column} = $${values.length}${cast}`); };
  if (d.title !== undefined) set('title', d.title);
  if (d.summary !== undefined) set('summary', d.summary);
  if (d.sector !== undefined && 'sector' in ((body ?? {}) as object)) set('sector', d.sector);
  // A listing about raising capital stays with investors only.
  if (d.audience !== undefined && current.kind !== 'capital') set('audience', [...new Set(d.audience)], '::text[]');
  if (!sets.length) return;
  await db.query(`UPDATE business_listings SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
  await notify(db, current.user_id, `The Quintara team edited your listing "${d.title ?? current.title}". Open Business to see it.`);
  await audit(db, staffId, 'listing.edited', 'business_listing', id, { fields: sets.map((s) => s.split(' ')[0]) });
}

/* ---------- Relationship manager ---------- */

async function messagesFor(db: Queryable, ids: string[]): Promise<Map<string, RmMessage[]>> {
  const by = new Map<string, RmMessage[]>();
  if (!ids.length) return by;
  const rows = await db.query('SELECT id, enquiry_id, from_manager, body, created_at FROM rm_messages WHERE enquiry_id = ANY($1::uuid[]) ORDER BY created_at, id', [ids]);
  for (const row of rows) {
    const list = by.get(row.enquiry_id as string) ?? [];
    list.push({ id: row.id as string, from: row.from_manager ? 'manager' : 'member', body: row.body as string, sentAt: iso(row.created_at) });
    by.set(row.enquiry_id as string, list);
  }
  return by;
}
const toEnquiry = (row: Row, messages: RmMessage[]): RmEnquiry => ({
  id: row.id as string, topic: row.topic as RmEnquiry['topic'], subject: row.subject as string, updateTitle: (row.update_title as string | null) ?? null,
  status: row.status as RmEnquiry['status'], createdAt: iso(row.created_at), messages,
});
const SELECT_ENQUIRY = `SELECT e.*, u.title AS update_title FROM rm_enquiries e LEFT JOIN business_updates u ON u.id = e.update_id`;

/** Always scoped to the member's own enquiries. */
export async function listEnquiries(db: Queryable, ctx: RequestContext): Promise<RmEnquiry[]> {
  const session = requireMember(ctx, 'business.view');
  const rows = await db.query(`${SELECT_ENQUIRY} WHERE e.member_id = $1 ORDER BY e.updated_at DESC LIMIT 100`, [session.memberId]);
  const messages = await messagesFor(db, rows.map((row) => row.id as string));
  return rows.map((row) => toEnquiry(row, messages.get(row.id as string) ?? []));
}

async function ownEnquiry(db: Queryable, memberId: string, id: string): Promise<RmEnquiry> {
  const rows = UUID.test(id) ? await db.query(`${SELECT_ENQUIRY} WHERE e.id = $1 AND e.member_id = $2`, [id, memberId]) : [];
  if (!rows[0]) throw notFound('This enquiry is not available.');
  return toEnquiry(rows[0], (await messagesFor(db, [id])).get(id) ?? []);
}

export async function createEnquiry(db: Db, ctx: RequestContext, body: unknown): Promise<RmEnquiry> {
  const session = requireMember(ctx, 'business.view');
  const parsed = rmEnquiryInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  // An enquiry can only be attached to an opportunity the member is able to see.
  if (d.updateId && !(await db.query(`SELECT 1 FROM business_updates u WHERE u.id = $3 AND ${VISIBLE_UPDATE}`, [ctx.marketId, businessRoles(session.roles), d.updateId]))[0]) throw notFound('This opportunity is not available.');
  const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM rm_enquiries WHERE member_id = $1 AND status = 'open'`, [session.memberId]))[0]!.n);
  if (open >= 10) throw conflict('You have ten open enquiries. Close one before starting another.');
  const id = await db.tx(async (tx) => {
    const created = (await tx.query<{ id: string }>('INSERT INTO rm_enquiries (market_id, member_id, topic, subject, update_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [ctx.marketId, session.memberId, d.updateId ? 'opportunity' : d.topic, d.subject, d.updateId ?? null]))[0]!.id;
    await tx.query('INSERT INTO rm_messages (enquiry_id, sender_user_id, from_manager, body) VALUES ($1, $2, false, $3)', [created, session.userId, d.message]);
    await audit(tx, session.userId, 'rm.enquiry_opened', 'rm_enquiry', created, { topic: d.topic });
    return created;
  });
  return ownEnquiry(db, session.memberId, id);
}

export async function sendEnquiryMessage(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<RmEnquiry> {
  const session = requireMember(ctx, 'business.view');
  const enquiry = await ownEnquiry(db, session.memberId, id);
  if (enquiry.status === 'closed') throw conflict('This enquiry is closed.');
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.query('INSERT INTO rm_messages (enquiry_id, sender_user_id, from_manager, body) VALUES ($1, $2, false, $3)', [id, session.userId, parsed.data.body]);
  await db.query('UPDATE rm_enquiries SET updated_at = now() WHERE id = $1', [id]);
  return ownEnquiry(db, session.memberId, id);
}

export async function closeEnquiry(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'business.view');
  const rows = UUID.test(id) ? await db.query(`UPDATE rm_enquiries SET status = 'closed', updated_at = now() WHERE id = $1 AND member_id = $2 AND status = 'open' RETURNING id`, [id, session.memberId]) : [];
  if (!rows[0]) throw notFound('This enquiry is not available.');
  await audit(db, session.userId, 'rm.enquiry_closed', 'rm_enquiry', id);
}

const STAFF_ENQUIRY = `SELECT e.*, u.title AS update_title, p.full_name, p.position, p.company, m.member_number, m.user_id AS member_user_id
  FROM rm_enquiries e LEFT JOIN business_updates u ON u.id = e.update_id JOIN members m ON m.id = e.member_id JOIN profiles p ON p.user_id = m.user_id`;

export async function listEnquiriesForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.business.manage');
  // Open first, the longest-waiting at the top.
  const rows = await db.query(`${STAFF_ENQUIRY} ORDER BY (e.status = 'closed'), e.updated_at LIMIT 300`);
  const messages = await messagesFor(db, rows.map((row) => row.id as string));
  return rows.map((row) => ({ ...toEnquiry(row, messages.get(row.id as string) ?? []), memberName: row.full_name as string, memberNumber: row.member_number as string, memberRole: [row.position, row.company].filter(Boolean).join(', ') }));
}

export async function replyToEnquiry(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.tx(async (tx) => {
    const rows = UUID.test(id) ? await tx.query(`${STAFF_ENQUIRY} WHERE e.id = $1 FOR UPDATE OF e`, [id]) : [];
    if (!rows[0]) throw notFound('This enquiry does not exist.');
    if (rows[0].status === 'closed') throw conflict('This enquiry is closed.');
    await tx.query('INSERT INTO rm_messages (enquiry_id, sender_user_id, from_manager, body) VALUES ($1, $2, true, $3)', [id, staffId, parsed.data.body]);
    await tx.query('UPDATE rm_enquiries SET updated_at = now() WHERE id = $1', [id]);
    await notify(tx, rows[0].member_user_id as string, `Your relationship manager, ${RELATIONSHIP_MANAGER.shortName}, replied about "${rows[0].subject as string}". Open Business to read it.`);
    await audit(tx, staffId, 'rm.replied', 'rm_enquiry', id);
  });
}

export async function closeEnquiryAsStaff(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const rows = UUID.test(id) ? await db.query(`UPDATE rm_enquiries SET status = 'closed', updated_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [id]) : [];
  if (!rows[0]) throw conflict('This enquiry is already closed.');
  await audit(db, staffId, 'rm.enquiry_closed', 'rm_enquiry', id);
}
