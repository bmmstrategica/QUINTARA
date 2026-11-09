/**
 * Business: listings and introductions between founders, investors, creatives and executives.
 *
 * The rules that keep this an introductions service and not a marketplace:
 *  - a listing has no price, valuation or terms, and is published only after staff review;
 *  - a listing is seen only by the roles it is addressed to; raising capital is seen by investors only,
 *    and the investor role is granted by staff after verification, never self-declared;
 *  - an introduction is requested, reviewed by staff, then offered to the other member, who may decline
 *    without the requester being told why; contact details are never exchanged by the system;
 *  - only when both sides agree are the two members connected, which opens messaging.
 */
import { BUSINESS_ROLES, introductionRequestSchema, listingInputSchema } from '@quintara/domain';
import type { BusinessListing, BusinessRole, Introduction, Role } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, forbidden, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessRoles = (roles: readonly Role[]) => roles.filter((role): role is BusinessRole => (BUSINESS_ROLES as readonly string[]).includes(role));
const notify = (db: Queryable, userId: string, title: string, link: unknown = null) =>
  db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'membership_update', $2, $3::jsonb)`, [userId, title, JSON.stringify(link)]);
const NOT_BLOCKED = (a: string, b: string) => `NOT EXISTS (SELECT 1 FROM member_blocks x WHERE (x.blocker_id = ${a} AND x.blocked_id = ${b}) OR (x.blocker_id = ${b} AND x.blocked_id = ${a}))`;

const SELECT_LISTING = `
  SELECT l.id, l.kind, l.title, l.summary, l.sector, l.audience, l.status, l.review_note, l.created_at, l.member_id,
         p.full_name, p.position, p.company,
         (SELECT i.status FROM introductions i WHERE i.listing_id = l.id AND i.requester_id = $1 ORDER BY i.created_at DESC LIMIT 1) AS my_request
    FROM business_listings l JOIN members m ON m.id = l.member_id JOIN profiles p ON p.user_id = m.user_id`;

function toListing(row: Row, viewer: string | null): BusinessListing {
  return {
    id: row.id as string, kind: row.kind as BusinessListing['kind'], title: row.title as string, summary: row.summary as string, sector: row.sector as string,
    audience: row.audience as BusinessRole[], status: row.status as BusinessListing['status'], createdAt: new Date(row.created_at as string).toISOString(),
    postedBy: { memberId: row.member_id as string, fullName: row.full_name as string, position: row.position as string, company: row.company as string },
    mine: row.member_id === viewer, myRequest: (row.my_request as BusinessListing['myRequest']) ?? null,
    reviewNote: row.member_id === viewer ? ((row.review_note as string | null) ?? null) : null,
  };
}

/* ---------- Listings: members ---------- */

/** Published listings addressed to one of the viewer's roles, plus every listing of their own. */
export async function listListings(db: Queryable, ctx: RequestContext): Promise<BusinessListing[]> {
  const session = requireMember(ctx, 'business.view');
  const rows = await db.query(
    `${SELECT_LISTING}
      WHERE l.market_id = $2 AND (l.member_id = $1 OR (l.status = 'published' AND m.status = 'active' AND l.audience && $3::text[] AND ${NOT_BLOCKED('$1', 'l.member_id')}))
      ORDER BY (l.member_id = $1) DESC, l.created_at DESC LIMIT 200`, [session.memberId, ctx.marketId, businessRoles(session.roles)]);
  return rows.map((row) => toListing(row, session.memberId));
}

export async function createListing(db: Db, ctx: RequestContext, body: unknown): Promise<BusinessListing> {
  const session = requireMember(ctx, 'business.post');
  const parsed = listingInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  // Only a founder raises capital, and only verified investors may see it.
  if (d.kind === 'capital' && !session.roles.includes('founder')) throw forbidden('Only founders can post about raising capital.');
  const audience = d.kind === 'capital' ? ['investor'] : [...new Set(d.audience)];
  const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM business_listings WHERE member_id = $1 AND status IN ('pending', 'published')`, [session.memberId]))[0]!.n);
  if (open >= 5) throw conflict('You have five open listings. Close one before adding another.');
  const id = (await db.query<{ id: string }>(
    'INSERT INTO business_listings (market_id, member_id, kind, title, summary, sector, audience) VALUES ($1, $2, $3, $4, $5, $6, $7::text[]) RETURNING id',
    [ctx.marketId, session.memberId, d.kind, d.title, d.summary, d.sector, audience]))[0]!.id;
  await audit(db, session.userId, 'listing.submitted', 'business_listing', id, { kind: d.kind });
  return toListing((await db.query(`${SELECT_LISTING} WHERE l.id = $2`, [session.memberId, id]))[0]!, session.memberId);
}

export async function closeListing(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'business.view');
  const rows = UUID.test(id) ? await db.query(`UPDATE business_listings SET status = 'closed', updated_at = now() WHERE id = $1 AND member_id = $2 AND status IN ('pending', 'published') RETURNING id`, [id, session.memberId]) : [];
  if (!rows[0]) throw notFound('This listing is not available.');
  await audit(db, session.userId, 'listing.closed', 'business_listing', id);
}

/* ---------- Introductions: members ---------- */

const SELECT_INTRO = `
  SELECT i.id, i.status, i.note, i.created_at, i.updated_at, i.requester_id, i.target_id, l.title AS listing_title,
         rp.full_name AS requester_name, rp.position AS requester_position, rp.company AS requester_company,
         tp.full_name AS target_name, tp.position AS target_position, tp.company AS target_company
    FROM introductions i
    JOIN members rm ON rm.id = i.requester_id JOIN profiles rp ON rp.user_id = rm.user_id
    JOIN members tm ON tm.id = i.target_id JOIN profiles tp ON tp.user_id = tm.user_id
    LEFT JOIN business_listings l ON l.id = i.listing_id`;

function toIntroduction(row: Row, viewer: string): Introduction {
  const outgoing = row.requester_id === viewer, side = outgoing ? 'target' : 'requester';
  const status = row.status as string;
  return {
    id: row.id as string, direction: outgoing ? 'outgoing' : 'incoming',
    // The requester is never told whether the team or the other member said no.
    status: (outgoing && (status === 'declined' || status === 'not_progressed') ? 'not_progressed' : status) as Introduction['status'],
    note: row.note as string, listingTitle: (row.listing_title as string | null) ?? null,
    with: { memberId: row[`${side}_id`] as string, fullName: row[`${side}_name`] as string, position: row[`${side}_position`] as string, company: row[`${side}_company`] as string },
    createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/** The viewer's own requests, and requests the team has chosen to put to them. Never a request still with the team. */
export async function listIntroductions(db: Queryable, ctx: RequestContext): Promise<Introduction[]> {
  const session = requireMember(ctx, 'business.view');
  const rows = await db.query(`${SELECT_INTRO} WHERE i.requester_id = $1 OR (i.target_id = $1 AND i.status IN ('offered', 'accepted', 'declined')) ORDER BY i.updated_at DESC LIMIT 200`, [session.memberId]);
  return rows.map((row) => toIntroduction(row, session.memberId));
}

export async function requestIntroduction(db: Db, ctx: RequestContext, body: unknown): Promise<Introduction> {
  const session = requireMember(ctx, 'business.view');
  const parsed = introductionRequestSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const { listingId, note } = parsed.data;
  return db.tx(async (tx) => {
    // The listing must be one the caller is allowed to see: the same rule as the list, so nothing can be probed.
    const listing = (await tx.query<{ member_id: string }>(
      `SELECT l.member_id FROM business_listings l JOIN members m ON m.id = l.member_id
        WHERE l.id = $1 AND l.status = 'published' AND m.status = 'active' AND l.market_id = $2 AND l.audience && $3::text[] AND l.member_id <> $4 AND ${NOT_BLOCKED('$4', 'l.member_id')}`,
      [listingId, ctx.marketId, businessRoles(session.roles), session.memberId]))[0];
    if (!listing) throw notFound('This listing is not available.');
    const connected = await tx.query(`SELECT 1 FROM connections WHERE status = 'connected' AND LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)`, [session.memberId, listing.member_id]);
    if (connected[0]) throw conflict('You are already connected. Send a message instead.');
    const open = await tx.query(`SELECT 1 FROM introductions WHERE requester_id = $1 AND target_id = $2 AND status IN ('requested', 'offered')`, [session.memberId, listing.member_id]);
    if (open[0]) throw conflict('You have already asked for this introduction.');
    const id = (await tx.query<{ id: string }>('INSERT INTO introductions (requester_id, target_id, listing_id, note) VALUES ($1, $2, $3, $4) RETURNING id', [session.memberId, listing.member_id, listingId, note]))[0]!.id;
    await audit(tx, session.userId, 'introduction.requested', 'introduction', id);
    return toIntroduction((await tx.query(`${SELECT_INTRO} WHERE i.id = $1`, [id]))[0]!, session.memberId);
  });
}

/** The member who was asked says yes or no. Yes connects the two members, which opens messaging. */
export async function respondToIntroduction(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<Introduction> {
  const session = requireMember(ctx, 'business.view');
  const parsed = z.object({ accept: z.boolean() }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  return db.tx(async (tx) => {
    const rows = UUID.test(id) ? await tx.query<{ status: string; requester_id: string; requester_user: string }>(
      `SELECT i.status, i.requester_id, m.user_id AS requester_user FROM introductions i JOIN members m ON m.id = i.requester_id WHERE i.id = $1 AND i.target_id = $2 AND i.status <> 'requested' FOR UPDATE OF i`, [id, session.memberId]) : [];
    if (!rows[0]) throw notFound('This introduction is not available.');
    if (rows[0].status !== 'offered') throw conflict('This introduction has already been answered.');
    await tx.query(`UPDATE introductions SET status = $2, updated_at = now() WHERE id = $1`, [id, parsed.data.accept ? 'accepted' : 'declined']);
    if (parsed.data.accept) {
      await tx.query(
        `INSERT INTO connections (requester_id, addressee_id, status) VALUES ($1, $2, 'connected')
         ON CONFLICT (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)) DO UPDATE SET status = 'connected', updated_at = now()`, [rows[0].requester_id, session.memberId]);
      await notify(tx, rows[0].requester_user, `${session.fullName} has accepted your introduction. You can now message each other.`, { type: 'conversation', id: session.memberId });
    }
    await audit(tx, session.userId, parsed.data.accept ? 'introduction.accepted' : 'introduction.declined', 'introduction', id);
    return toIntroduction((await tx.query(`${SELECT_INTRO} WHERE i.id = $1`, [id]))[0]!, session.memberId);
  });
}

export async function withdrawIntroduction(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'business.view');
  const rows = UUID.test(id) ? await db.query(`UPDATE introductions SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND requester_id = $2 AND status IN ('requested', 'offered') RETURNING id`, [id, session.memberId]) : [];
  if (!rows[0]) throw notFound('This introduction is not available.');
  await audit(db, session.userId, 'introduction.withdrawn', 'introduction', id);
}

/* ---------- Staff ---------- */

export async function listListingsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.business.manage');
  const rows = await db.query(`${SELECT_LISTING} ORDER BY (l.status = 'pending') DESC, l.created_at DESC LIMIT 300`, [null]);
  return rows.map((row) => ({ ...toListing(row, null), reviewNote: (row.review_note as string | null) ?? null }));
}

export async function reviewListing(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const parsed = z.object({ decision: z.enum(['publish', 'decline', 'close']), note: z.string().trim().max(500).optional() }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const next = { publish: 'published', decline: 'declined', close: 'closed' }[parsed.data.decision];
  const rows = UUID.test(id) ? await db.query<{ user_id: string; title: string }>(
    `UPDATE business_listings l SET status = $2, review_note = $3, reviewed_by = $4, updated_at = now() FROM members m
      WHERE l.id = $1 AND m.id = l.member_id AND l.status <> $2 AND (l.status = 'pending' OR $2 = 'closed') RETURNING m.user_id, l.title`, [id, next, parsed.data.note ?? null, staffId]) : [];
  if (!rows[0]) throw conflict('This listing cannot be changed in that way.');
  await notify(db, rows[0].user_id, next === 'published' ? `Your listing "${rows[0].title}" is now visible to the members it is addressed to.` : `Your listing "${rows[0].title}" was not published. Open Business to read the note from the team.`);
  await audit(db, staffId, 'listing.' + next, 'business_listing', id);
}

export async function listIntroductionsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.business.manage');
  const rows = await db.query(`${SELECT_INTRO} ORDER BY (i.status = 'requested') DESC, i.updated_at DESC LIMIT 300`);
  return rows.map((row) => ({
    id: row.id as string, status: row.status as string, note: row.note as string, listingTitle: (row.listing_title as string | null) ?? null,
    requester: { memberId: row.requester_id as string, fullName: row.requester_name as string, position: row.requester_position as string, company: row.requester_company as string },
    target: { memberId: row.target_id as string, fullName: row.target_name as string, position: row.target_position as string, company: row.target_company as string },
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

/** The team either puts the request to the other member or lets it rest. */
export async function handleIntroduction(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.business.manage');
  const parsed = z.object({ decision: z.enum(['offer', 'not_progressed']) }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.tx(async (tx) => {
    const rows = UUID.test(id) ? await tx.query<{ status: string; target_user: string; requester_name: string }>(
      `SELECT i.status, tm.user_id AS target_user, rp.full_name AS requester_name FROM introductions i JOIN members tm ON tm.id = i.target_id JOIN members rm ON rm.id = i.requester_id JOIN profiles rp ON rp.user_id = rm.user_id WHERE i.id = $1 FOR UPDATE OF i`, [id]) : [];
    if (!rows[0]) throw notFound('This introduction does not exist.');
    if (rows[0].status !== 'requested') throw conflict('This introduction has already been handled.');
    await tx.query('UPDATE introductions SET status = $2, handled_by = $3, updated_at = now() WHERE id = $1', [id, parsed.data.decision === 'offer' ? 'offered' : 'not_progressed', staffId]);
    if (parsed.data.decision === 'offer') await notify(tx, rows[0].target_user, `${rows[0].requester_name} would like an introduction. Open Business to accept or decline.`);
    await audit(tx, staffId, 'introduction.' + (parsed.data.decision === 'offer' ? 'offered' : 'not_progressed'), 'introduction', id);
  });
}
