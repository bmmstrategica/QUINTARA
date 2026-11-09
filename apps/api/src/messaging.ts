import { messageBodySchema } from '@quintara/domain';
import type { ChatPartner, Conversation, ConversationThread } from '@quintara/domain';
import { requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { forbidden, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A pair of members in a fixed order, matching the unique key on conversations. */
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

async function partner(db: Queryable, me: string, memberId: string): Promise<{ partner: ChatPartner; userId: string; connected: boolean }> {
  const rows = UUID.test(memberId) && memberId !== me
    ? await db.query(
        `SELECT m.id, m.user_id, p.full_name, p.position, p.company,
                EXISTS (SELECT 1 FROM connections c WHERE c.status = 'connected' AND LEAST(c.requester_id, c.addressee_id) = LEAST(m.id, $2::uuid) AND GREATEST(c.requester_id, c.addressee_id) = GREATEST(m.id, $2::uuid)) AS connected
           FROM members m JOIN profiles p ON p.user_id = m.user_id WHERE m.id = $1 AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM member_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = m.id) OR (b.blocker_id = m.id AND b.blocked_id = $2))`, [memberId, me])
    : [];
  const row = rows[0];
  if (!row) throw notFound('This profile is not available.');
  return { partner: { memberId: row.id as string, fullName: row.full_name as string, position: row.position as string, company: row.company as string }, userId: row.user_id as string, connected: Boolean(row.connected) };
}

export async function listConversations(db: Queryable, ctx: RequestContext): Promise<Conversation[]> {
  const session = requireMember(ctx, 'messages.use');
  const rows = await db.query(
    `SELECT o.id AS member_id, p.full_name, p.position, p.company, last.body, last.created_at,
            EXISTS (SELECT 1 FROM messages u WHERE u.conversation_id = c.id AND u.sender_member_id <> $1
                      AND u.created_at > COALESCE((SELECT r.last_read_at FROM conversation_reads r WHERE r.conversation_id = c.id AND r.member_id = $1), 'epoch')) AS unread
       FROM conversations c
       JOIN members o ON o.id = CASE WHEN c.member_low = $1 THEN c.member_high ELSE c.member_low END
       JOIN profiles p ON p.user_id = o.user_id
       JOIN LATERAL (SELECT body, created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last ON true
      WHERE $1 IN (c.member_low, c.member_high)
        AND NOT EXISTS (SELECT 1 FROM member_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = o.id) OR (b.blocker_id = o.id AND b.blocked_id = $1))
      ORDER BY last.created_at DESC`, [session.memberId]);
  return rows.map((row) => ({ memberId: row.member_id as string, fullName: row.full_name as string, position: row.position as string, company: row.company as string, lastMessage: row.body as string, lastMessageAt: new Date(row.created_at as string).toISOString(), unread: Boolean(row.unread) }));
}

export async function getConversation(db: Queryable, ctx: RequestContext, memberId: string): Promise<ConversationThread> {
  const session = requireMember(ctx, 'messages.use');
  const other = await partner(db, session.memberId, memberId);
  const [low, high] = pair(session.memberId, memberId);
  // Only the two participants can ever reach these rows: the pair is built from the caller's own id.
  const rows = await db.query(
    `SELECT m.id, m.sender_member_id, m.body, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.member_low = $1 AND c.member_high = $2 ORDER BY m.created_at, m.id LIMIT 500`, [low, high]);
  return { with: other.partner, canSend: other.connected, messages: rows.map((row) => ({ id: row.id as string, mine: row.sender_member_id === session.memberId, body: row.body as string, sentAt: new Date(row.created_at as string).toISOString() })) };
}

export async function sendMessage(db: Db, ctx: RequestContext, memberId: string, body: unknown): Promise<ConversationThread> {
  const session = requireMember(ctx, 'messages.use');
  const other = await partner(db, session.memberId, memberId);
  if (!other.connected) throw forbidden('Messaging opens once you are connected.');
  const parsed = messageBodySchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const [low, high] = pair(session.memberId, memberId);
  await db.tx(async (tx) => {
    const conversationId = (await tx.query<{ id: string }>(
      `INSERT INTO conversations (member_low, member_high, last_message_at) VALUES ($1, $2, now())
       ON CONFLICT (member_low, member_high) DO UPDATE SET last_message_at = now() RETURNING id`, [low, high]))[0]!.id;
    await tx.query('INSERT INTO messages (conversation_id, sender_member_id, body) VALUES ($1, $2, $3)', [conversationId, session.memberId, parsed.data.body]);
    await tx.query(`INSERT INTO conversation_reads (conversation_id, member_id) VALUES ($1, $2) ON CONFLICT (conversation_id, member_id) DO UPDATE SET last_read_at = now()`, [conversationId, session.memberId]);
    // One unread notification per sender is enough; a burst of messages should not become a burst of alerts.
    const pending = await tx.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND category = 'message' AND read_at IS NULL AND link->>'id' = $2`, [other.userId, session.memberId]);
    if (!pending[0]) {
      await tx.query(`INSERT INTO notifications (user_id, category, title, link) VALUES ($1, 'message', $2, $3::jsonb)`, [other.userId, `${session.fullName} sent you a message.`, JSON.stringify({ type: 'conversation', id: session.memberId })]);
    }
  });
  return getConversation(db, ctx, memberId);
}

export async function markRead(db: Queryable, ctx: RequestContext, memberId: string): Promise<void> {
  const session = requireMember(ctx, 'messages.use');
  if (!UUID.test(memberId)) return;
  const [low, high] = pair(session.memberId, memberId);
  await db.query(
    `INSERT INTO conversation_reads (conversation_id, member_id) SELECT c.id, $3 FROM conversations c WHERE c.member_low = $1 AND c.member_high = $2
     ON CONFLICT (conversation_id, member_id) DO UPDATE SET last_read_at = now()`, [low, high, session.memberId]);
}
