import { conciergeRequestSchema, messageBodySchema } from '@quintara/domain';
import type { ConciergeRequest, ConciergeStatus, ThreadMessage } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED: ConciergeStatus[] = ['completed', 'cancelled'];

function toRequest(row: Row, messages: ThreadMessage[]): ConciergeRequest {
  return {
    id: row.id as string, category: row.category as ConciergeRequest['category'], subject: row.subject as string, details: row.details as string,
    neededBy: row.needed_by ? new Date(row.needed_by as string).toISOString().slice(0, 10) : null,
    status: row.status as ConciergeStatus, createdAt: new Date(row.created_at as string).toISOString(), messages,
  };
}

async function messagesFor(db: Queryable, requestIds: string[]): Promise<Map<string, ThreadMessage[]>> {
  const byRequest = new Map<string, ThreadMessage[]>();
  if (!requestIds.length) return byRequest;
  const rows = await db.query('SELECT id, request_id, from_desk, body, created_at FROM concierge_messages WHERE request_id = ANY($1::uuid[]) ORDER BY created_at, id', [requestIds]);
  for (const row of rows) {
    const list = byRequest.get(row.request_id as string) ?? [];
    list.push({ id: row.id as string, from: row.from_desk ? 'desk' : 'member', body: row.body as string, sentAt: new Date(row.created_at as string).toISOString() });
    byRequest.set(row.request_id as string, list);
  }
  return byRequest;
}

/* ---------- Member side: always scoped to the member's own requests ---------- */

export async function listRequests(db: Queryable, ctx: RequestContext): Promise<ConciergeRequest[]> {
  const session = requireMember(ctx, 'concierge.request');
  const rows = await db.query('SELECT * FROM concierge_requests WHERE member_id = $1 ORDER BY created_at DESC', [session.memberId]);
  const messages = await messagesFor(db, rows.map((row) => row.id as string));
  return rows.map((row) => toRequest(row, messages.get(row.id as string) ?? []));
}

async function ownRequest(db: Queryable, memberId: string, id: string, lock = false): Promise<Row> {
  const rows = UUID.test(id) ? await db.query(`SELECT * FROM concierge_requests WHERE id = $1 AND member_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, memberId]) : [];
  if (!rows[0]) throw notFound('This request is not available.');
  return rows[0];
}

export async function getRequest(db: Queryable, ctx: RequestContext, id: string): Promise<ConciergeRequest> {
  const session = requireMember(ctx, 'concierge.request');
  const row = await ownRequest(db, session.memberId, id);
  return toRequest(row, (await messagesFor(db, [id])).get(id) ?? []);
}

export async function createRequest(db: Db, ctx: RequestContext, body: unknown): Promise<ConciergeRequest> {
  const session = requireMember(ctx, 'concierge.request');
  const parsed = conciergeRequestSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const input = parsed.data;
  const id = (await db.query<{ id: string }>(
    'INSERT INTO concierge_requests (member_id, market_id, category, subject, details, needed_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [session.memberId, ctx.marketId, input.category, input.subject, input.details, input.neededBy ?? null]))[0]!.id;
  await audit(db, session.userId, 'concierge.requested', 'concierge_request', id, { category: input.category });
  return getRequest(db, ctx, id);
}

export async function sendMessage(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<ConciergeRequest> {
  const session = requireMember(ctx, 'concierge.request');
  const parsed = messageBodySchema.safeParse(body);
  const row = await ownRequest(db, session.memberId, id);
  if (CLOSED.includes(row.status as ConciergeStatus)) throw conflict('This request is closed.');
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.query('INSERT INTO concierge_messages (request_id, sender_user_id, from_desk, body) VALUES ($1, $2, false, $3)', [id, session.userId, parsed.data.body]);
  await db.query('UPDATE concierge_requests SET updated_at = now() WHERE id = $1', [id]);
  return getRequest(db, ctx, id);
}

async function memberTransition(db: Db, ctx: RequestContext, id: string, to: 'confirmed' | 'cancelled'): Promise<ConciergeRequest> {
  const session = requireMember(ctx, 'concierge.request');
  await db.tx(async (tx) => {
    const row = await ownRequest(tx, session.memberId, id, true);
    const from = row.status as ConciergeStatus;
    if (to === 'confirmed' && from !== 'options_provided') throw conflict('There are no options to confirm yet.');
    if (to === 'cancelled' && CLOSED.includes(from)) throw conflict('This request is already closed.');
    await tx.query('UPDATE concierge_requests SET status = $2, updated_at = now() WHERE id = $1', [id, to]);
    await audit(tx, session.userId, 'concierge.' + to, 'concierge_request', id, { from });
  });
  return getRequest(db, ctx, id);
}
export const confirmRequest = (db: Db, ctx: RequestContext, id: string) => memberTransition(db, ctx, id, 'confirmed');
export const cancelRequest = (db: Db, ctx: RequestContext, id: string) => memberTransition(db, ctx, id, 'cancelled');

/* ---------- Staff side ---------- */

type StaffRequest = ConciergeRequest & { memberName: string; memberNumber: string };
const STAFF_SELECT = `SELECT r.*, p.full_name, m.member_number, m.user_id AS member_user_id FROM concierge_requests r JOIN members m ON m.id = r.member_id JOIN profiles p ON p.user_id = m.user_id`;
const toStaffRequest = (row: Row, messages: ThreadMessage[]): StaffRequest => ({ ...toRequest(row, messages), memberName: row.full_name as string, memberNumber: row.member_number as string });

export async function listRequestsForStaff(db: Queryable, ctx: RequestContext): Promise<StaffRequest[]> {
  requireStaff(ctx, 'admin.concierge.manage');
  // Open requests first, oldest at the top: the desk works the queue in order.
  const rows = await db.query(`${STAFF_SELECT} ORDER BY (r.status IN ('completed', 'cancelled')), r.created_at`);
  const messages = await messagesFor(db, rows.map((row) => row.id as string));
  return rows.map((row) => toStaffRequest(row, messages.get(row.id as string) ?? []));
}

async function staffRequest(db: Queryable, id: string, lock = false): Promise<Row> {
  const rows = UUID.test(id) ? await db.query(`${STAFF_SELECT} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id]) : [];
  if (!rows[0]) throw notFound('This request does not exist.');
  return rows[0];
}

export async function getRequestForStaff(db: Queryable, ctx: RequestContext, id: string): Promise<StaffRequest> {
  requireStaff(ctx, 'admin.concierge.manage');
  return toStaffRequest(await staffRequest(db, id), (await messagesFor(db, [id])).get(id) ?? []);
}

const notifyMember = (db: Queryable, userId: string, title: string, requestId: string) =>
  db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'concierge_update', $2, $3::jsonb)`, [userId, title, JSON.stringify({ type: 'request', id: requestId })]);

export async function replyAsDesk(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<StaffRequest> {
  const staffId = requireStaff(ctx, 'admin.concierge.manage');
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.tx(async (tx) => {
    const row = await staffRequest(tx, id, true);
    if (CLOSED.includes(row.status as ConciergeStatus)) throw conflict('This request is closed.');
    await tx.query('INSERT INTO concierge_messages (request_id, sender_user_id, from_desk, body) VALUES ($1, $2, true, $3)', [id, staffId, parsed.data.body]);
    // The first reply shows the member that someone has picked the request up.
    await tx.query(`UPDATE concierge_requests SET status = CASE WHEN status = 'requested' THEN 'reviewing' ELSE status END, assigned_to = COALESCE(assigned_to, $2), updated_at = now() WHERE id = $1`, [id, staffId]);
    await notifyMember(tx, row.member_user_id as string, `The concierge desk replied about your request: ${row.subject as string}.`, id);
    await audit(tx, staffId, 'concierge.replied', 'concierge_request', id);
  });
  return getRequestForStaff(db, ctx, id);
}

const statusSchema = z.object({ status: z.enum(['reviewing', 'options_provided', 'confirmed', 'completed']) });
const STATUS_NOTE: Record<string, string> = { reviewing: 'is being reviewed', options_provided: 'has options for you to choose from', confirmed: 'is confirmed', completed: 'is complete' };

export async function setStatus(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<StaffRequest> {
  const staffId = requireStaff(ctx, 'admin.concierge.manage');
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.tx(async (tx) => {
    const row = await staffRequest(tx, id, true);
    if (CLOSED.includes(row.status as ConciergeStatus)) throw conflict('This request is closed.');
    if (row.status === parsed.data.status) return;
    await tx.query('UPDATE concierge_requests SET status = $2, assigned_to = COALESCE(assigned_to, $3), updated_at = now() WHERE id = $1', [id, parsed.data.status, staffId]);
    await notifyMember(tx, row.member_user_id as string, `Your request "${row.subject as string}" ${STATUS_NOTE[parsed.data.status]}.`, id);
    await audit(tx, staffId, 'concierge.' + parsed.data.status, 'concierge_request', id, { from: row.status });
  });
  return getRequestForStaff(db, ctx, id);
}
