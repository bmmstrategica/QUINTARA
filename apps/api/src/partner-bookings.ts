/**
 * Bookings QÉRA makes with a partner on a member's behalf, and the documents it prepares.
 *
 * A booking is sent to the contact the partner directory holds. The partner is told the member's name, the
 * date, the time, the number of guests and the note: enough to hold a table, and nothing else. The partner
 * answers through a private link. Only a hash of the link's token is stored, so the database alone cannot be
 * used to answer for a partner. If the partner cannot take the booking, it is referred to the Lifestyle
 * Curator automatically, so the member is never left without an answer.
 */
import { createHash, randomBytes } from 'node:crypto';
import { CONCIERGE_SPECIALIST, longDay } from '@quintara/domain';
import type { ItineraryContent, PartnerBooking, PartnerBookingView, QeraDocument, QeraDocumentSummary } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireMember, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import type { EmailProvider } from './email.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const day = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const iso = (value: unknown) => new Date(value as string).toISOString();
const MAX_ATTEMPTS = 5;

const SELECT = `SELECT b.*, p.name AS partner_name FROM partner_bookings b JOIN partners p ON p.id = b.partner_id`;
const toBooking = (row: Row): PartnerBooking => ({
  id: row.id as string, partnerId: row.partner_id as string, partnerName: row.partner_name as string, date: day(row.booking_date), time: (row.booking_time as string | null) ?? null,
  partySize: Number(row.party_size), notes: row.notes as string, status: row.status as PartnerBooking['status'], partnerNote: row.partner_note as string, createdAt: iso(row.created_at),
});
/** "Saturday 10 October at 19:30" */
export const bookingWhen = (b: { date: string; time: string | null }) => `${longDay(b.date)}${b.time ? ` at ${b.time}` : ''}`;

const inputSchema = z.object({ partnerId: z.string().regex(UUID), date: z.iso.date(), time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/).nullable().default(null), partySize: z.number().int().min(1).max(50), notes: z.string().trim().max(1000).default('') });

/** The partner as the member may see it, with whether there is a contact to write to. Throws if it cannot be booked. */
export async function bookablePartner(db: Queryable, ctx: RequestContext, partnerId: string): Promise<{ id: string; name: string; contactName: string; contactEmail: string }> {
  const session = requireMember(ctx, 'privileges.use');
  const row = UUID.test(partnerId) ? (await db.query(`SELECT id, name, contact_name, contact_email FROM partners WHERE id = $1 AND status = 'published' AND market_id = $2`, [partnerId, ctx.marketId]))[0] : undefined;
  if (!row) throw notFound('This partner is not available.');
  if (!row.contact_email) throw conflict(`${row.name as string} has no booking contact in the directory yet.`);
  return { id: row.id as string, name: row.name as string, contactName: row.contact_name as string, contactEmail: row.contact_email as string };
}

export async function createPartnerBooking(db: Db, ctx: RequestContext, body: unknown): Promise<PartnerBooking> {
  const session = requireMember(ctx, 'privileges.use');
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if (d.date < new Date().toISOString().slice(0, 10)) throw new HttpError(422, 'Choose a date from today onwards.', { date: 'Choose a date from today onwards' });
  await bookablePartner(db, ctx, d.partnerId);
  const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM partner_bookings WHERE member_id = $1 AND status = 'requested'`, [session.memberId]))[0]!.n);
  if (open >= 10) throw conflict('You have ten bookings waiting for a partner to answer. Please wait for a reply.');
  if ((await db.query(`SELECT 1 FROM partner_bookings WHERE member_id = $1 AND partner_id = $2 AND booking_date = $3 AND status IN ('requested', 'confirmed')`, [session.memberId, d.partnerId, d.date]))[0]) throw conflict('You already have a booking with this partner on that date.');
  // The token goes only into the partner's email. What is stored cannot be turned back into it.
  const token = randomBytes(32).toString('base64url');
  const id = (await db.query<{ id: string }>(
    'INSERT INTO partner_bookings (market_id, partner_id, member_id, booking_date, booking_time, party_size, notes, token_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [ctx.marketId, d.partnerId, session.memberId, d.date, d.time, d.partySize, d.notes, hash(token)]))[0]!.id;
  await audit(db, session.userId, 'partner_booking.requested', 'partner_booking', id, { partnerId: d.partnerId });
  pendingTokens.set(id, token);
  return toBooking((await db.query(`${SELECT} WHERE b.id = $1`, [id]))[0]!);
}

/** Tokens wait here, in memory, only until the email that carries them is sent. They are never written down. */
const pendingTokens = new Map<string, string>();

/**
 * Sends the booking emails that are waiting. If the server restarted before one was sent its token is gone,
 * so a fresh one is issued: the old link was never delivered and cannot have been used.
 */
export async function deliverPartnerBookings(db: Db, provider: EmailProvider, webUrl: string, batch = 25): Promise<number> {
  const due = await db.query(
    `SELECT b.id, b.booking_date, b.booking_time, b.party_size, b.notes, p.name AS partner_name, p.contact_name, p.contact_email, pr.full_name
       FROM partner_bookings b JOIN partners p ON p.id = b.partner_id JOIN members m ON m.id = b.member_id JOIN profiles pr ON pr.user_id = m.user_id
      WHERE b.emailed_at IS NULL AND b.status = 'requested' AND b.email_attempts < $2 ORDER BY b.created_at LIMIT $1`, [batch, MAX_ATTEMPTS]);
  let sent = 0;
  for (const row of due) {
    const id = row.id as string;
    let token = pendingTokens.get(id);
    if (!token) { token = randomBytes(32).toString('base64url'); await db.query('UPDATE partner_bookings SET token_hash = $2 WHERE id = $1 AND emailed_at IS NULL', [id, hash(token)]); }
    const when = bookingWhen({ date: day(row.booking_date), time: (row.booking_time as string | null) ?? null });
    const text = [
      `${row.contact_name ? `Dear ${String(row.contact_name).split(' ')[0]},` : 'Hello,'}`, '',
      `Quintara would like to make a booking at ${row.partner_name as string} for one of its members.`, '',
      `Name: ${row.full_name as string}`, `Date: ${when}`, `Guests: ${row.party_size as number}`, ...(row.notes ? [`Note: ${row.notes as string}`] : []), '',
      `Please confirm or decline here: ${webUrl.replace(/\/$/, '')}/partner-booking/${token}`, '',
      'The member is a Quintara member and should receive their member privilege. If you have a question, reply to this email and the Quintara concierge desk will answer.', '', 'Quintara',
    ].join('\n');
    try {
      await provider.send({ to: row.contact_email as string, subject: `Booking request from Quintara: ${row.full_name as string}, ${when}`, text });
      await db.query('UPDATE partner_bookings SET emailed_at = now(), email_attempts = email_attempts + 1 WHERE id = $1', [id]);
      pendingTokens.delete(id);
      sent++;
    } catch {
      await db.query('UPDATE partner_bookings SET email_attempts = email_attempts + 1 WHERE id = $1', [id]);
    }
  }
  return sent;
}

export async function listMyPartnerBookings(db: Queryable, ctx: RequestContext): Promise<PartnerBooking[]> {
  const session = requireMember(ctx, 'privileges.use');
  return (await db.query(`${SELECT} WHERE b.member_id = $1 ORDER BY b.booking_date DESC, b.created_at DESC LIMIT 100`, [session.memberId])).map(toBooking);
}

export async function cancelMyPartnerBooking(db: Db, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'privileges.use');
  const rows = UUID.test(id) ? await db.query(`UPDATE partner_bookings SET status = 'cancelled', updated_at = now() WHERE id = $1 AND member_id = $2 AND status IN ('requested', 'confirmed') RETURNING id`, [id, session.memberId]) : [];
  if (!rows[0]) throw notFound('This booking is not available.');
  await audit(db, session.userId, 'partner_booking.cancelled', 'partner_booking', id);
}

/* ---------- The partner's side: reached only with the link from the email ---------- */


async function byToken(db: Queryable, token: string, lock = false): Promise<Row> {
  const rows = TOKEN.test(token) ? await db.query(`SELECT b.*, p.name AS partner_name, pr.full_name, m.user_id AS member_user FROM partner_bookings b JOIN partners p ON p.id = b.partner_id JOIN members m ON m.id = b.member_id JOIN profiles pr ON pr.user_id = m.user_id WHERE b.token_hash = $1 ${lock ? 'FOR UPDATE OF b' : ''}`, [hash(token)]) : [];
  if (!rows[0]) throw notFound('This link is not valid.');
  return rows[0];
}
const toView = (row: Row): PartnerBookingView => ({ partnerName: row.partner_name as string, memberName: row.full_name as string, date: day(row.booking_date), time: (row.booking_time as string | null) ?? null, partySize: Number(row.party_size), notes: row.notes as string, status: row.status as PartnerBooking['status'] });

export async function viewByToken(db: Queryable, token: string): Promise<PartnerBookingView> {
  return toView(await byToken(db, token));
}

async function settle(db: Queryable, row: Row, status: 'confirmed' | 'declined', note: string, actor: string | null): Promise<void> {
  await db.query('UPDATE partner_bookings SET status = $2, partner_note = $3, responded_at = now(), updated_at = now() WHERE id = $1', [row.id, status, note]);
  const when = bookingWhen({ date: day(row.booking_date), time: (row.booking_time as string | null) ?? null });
  const notify = (title: string, link: unknown = null) => db.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'concierge_update', $2, $3::jsonb)`, [row.member_user, title, JSON.stringify(link)]);
  if (status === 'confirmed') {
    await notify(`${row.partner_name as string} has confirmed your booking for ${when}.${note ? ` They say: ${note}` : ''}`);
  } else {
    // QÉRA could not complete it, so the Lifestyle Curator takes it from here without the member having to ask.
    const request = (await db.query<{ id: string }>(
      `INSERT INTO concierge_requests (member_id, market_id, category, subject, details) VALUES ($1, $2, 'hospitality', $3, $4) RETURNING id`,
      [row.member_id, row.market_id, `An alternative to ${row.partner_name as string} on ${when}`.slice(0, 120), `${row.partner_name as string} could not take a booking for ${row.party_size as number} on ${when}.${note ? ` They said: ${note}` : ''}${row.notes ? ` The member's note: ${row.notes as string}` : ''} Please suggest an alternative.`]))[0]!.id;
    await notify(`${row.partner_name as string} could not take your booking for ${when}. ${CONCIERGE_SPECIALIST.shortName}, your Lifestyle Curator, will suggest an alternative.`, { type: 'request', id: request });
  }
  await audit(db, actor, `partner_booking.${status}`, 'partner_booking', row.id as string, { by: actor ? 'staff' : 'partner' });
}

export async function respondByToken(db: Db, token: string, body: unknown): Promise<PartnerBookingView> {
  const parsed = z.object({ answer: z.enum(['confirm', 'decline']), note: z.string().trim().max(500).default('') }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  return db.tx(async (tx) => {
    const row = await byToken(tx, token, true);
    if (row.status !== 'requested') throw conflict(row.status === 'cancelled' ? 'The member has cancelled this booking.' : 'This booking has already been answered.');
    const status = parsed.data.answer === 'confirm' ? 'confirmed' : 'declined';
    await settle(tx, row, status, parsed.data.note, null);
    return { ...toView(row), status };
  });
}

/* ---------- Staff: the Lifestyle Curator sees what QÉRA has sent, and can answer for a partner who telephones ---------- */

export async function listPartnerBookingsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.concierge.manage');
  const rows = await db.query(`SELECT b.*, p.name AS partner_name, pr.full_name FROM partner_bookings b JOIN partners p ON p.id = b.partner_id JOIN members m ON m.id = b.member_id JOIN profiles pr ON pr.user_id = m.user_id ORDER BY (b.status <> 'requested'), b.booking_date, b.created_at LIMIT 300`);
  return rows.map((row) => ({ ...toBooking(row), memberName: row.full_name as string, emailed: row.emailed_at !== null }));
}

export async function settlePartnerBookingAsStaff(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.concierge.manage');
  const parsed = z.object({ answer: z.enum(['confirm', 'decline']), note: z.string().trim().max(500).default('') }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await db.tx(async (tx) => {
    const row = UUID.test(id) ? (await tx.query(`SELECT b.*, p.name AS partner_name, pr.full_name, m.user_id AS member_user FROM partner_bookings b JOIN partners p ON p.id = b.partner_id JOIN members m ON m.id = b.member_id JOIN profiles pr ON pr.user_id = m.user_id WHERE b.id = $1 FOR UPDATE OF b`, [id]))[0] : undefined;
    if (!row) throw notFound('This booking does not exist.');
    if (row.status !== 'requested') throw conflict('This booking has already been answered.');
    await settle(tx, row, parsed.data.answer === 'confirm' ? 'confirmed' : 'declined', parsed.data.note, staffId);
  });
}

/* ---------- Documents QÉRA has prepared ---------- */

export async function saveDocument(db: Queryable, userId: string, kind: QeraDocument['kind'], content: ItineraryContent): Promise<QeraDocumentSummary> {
  // Old plans are not kept for ever: the twenty most recent stay.
  await db.query('DELETE FROM qera_documents WHERE user_id = $1 AND id NOT IN (SELECT id FROM qera_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 19)', [userId]);
  const row = (await db.query('INSERT INTO qera_documents (user_id, kind, title, content) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, kind, title, created_at', [userId, kind, `${content.title}, ${content.subtitle}`.slice(0, 200), JSON.stringify(content)]))[0]!;
  return { id: row.id as string, kind: row.kind as QeraDocument['kind'], title: row.title as string, createdAt: iso(row.created_at) };
}

export async function listDocuments(db: Queryable, ctx: RequestContext): Promise<QeraDocumentSummary[]> {
  const session = requireMember(ctx, 'qera.use');
  return (await db.query('SELECT id, kind, title, created_at FROM qera_documents WHERE user_id = $1 ORDER BY created_at DESC', [session.userId])).map((row) => ({ id: row.id as string, kind: row.kind as QeraDocument['kind'], title: row.title as string, createdAt: iso(row.created_at) }));
}

export async function getDocument(db: Queryable, ctx: RequestContext, id: string): Promise<QeraDocument> {
  const session = requireMember(ctx, 'qera.use');
  const row = UUID.test(id) ? (await db.query('SELECT * FROM qera_documents WHERE id = $1 AND user_id = $2', [id, session.userId]))[0] : undefined;
  if (!row) throw notFound('This document is not available.');
  return { id: row.id as string, kind: row.kind as QeraDocument['kind'], title: row.title as string, createdAt: iso(row.created_at), content: row.content as ItineraryContent, booked: (row.booked as Record<string, string> | null) ?? {} };
}

export async function deleteDocument(db: Queryable, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'qera.use');
  const rows = UUID.test(id) ? await db.query('DELETE FROM qera_documents WHERE id = $1 AND user_id = $2 RETURNING id', [id, session.userId]) : [];
  if (!rows[0]) throw notFound('This document is not available.');
}
