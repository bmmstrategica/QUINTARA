import { memberReportSchema, profileUpdateSchema, ROLES, suggestMatches } from '@quintara/domain';
import type { BlockedMember, MatchSuggestion, MemberProfile, Role } from '@quintara/domain';
import { audit, requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, notFound, validation } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Profile fields that other members may see. Email and phone are deliberately
 * not selected here, so no handler built on this query can return them.
 * $1 is the viewer's member id, used only to work out the connection state.
 */
const SELECT_PROFILE = `
  SELECT m.id, p.full_name, p.position, p.company, p.industry, p.city, p.biography, p.interests, p.looking_for, p.can_offer, p.avatar_media_id,
         ARRAY(SELECT r.role_key FROM user_roles r WHERE r.user_id = m.user_id ORDER BY r.role_key) AS roles,
         COALESCE((SELECT CASE WHEN c.status = 'connected' THEN 'connected'
                               WHEN c.status = 'requested' AND c.requester_id = $1 THEN 'requested'
                               WHEN c.status = 'requested' THEN 'incoming'
                               ELSE 'none' END
                     FROM connections c
                    WHERE LEAST(c.requester_id, c.addressee_id) = LEAST(m.id, $1::uuid) AND GREATEST(c.requester_id, c.addressee_id) = GREATEST(m.id, $1::uuid)), 'none') AS connection
    FROM members m JOIN profiles p ON p.user_id = m.user_id
   WHERE m.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM member_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = m.id) OR (b.blocker_id = m.id AND b.blocked_id = $1))`;

function toProfile(row: Row): MemberProfile {
  return {
    id: row.id as string,
    fullName: row.full_name as string,
    position: row.position as string,
    company: row.company as string,
    industry: row.industry as string,
    city: row.city as string,
    biography: row.biography as string,
    interests: row.interests as string[],
    lookingFor: row.looking_for as string,
    canOffer: row.can_offer as string,
    roles: row.roles as Role[],
    avatarPath: row.avatar_media_id ? `/v1/media/${row.avatar_media_id as string}` : null,
    connection: row.connection as MemberProfile['connection'],
  };
}

export async function listMembers(db: Queryable, ctx: RequestContext, query: { search?: string; role?: string }): Promise<MemberProfile[]> {
  const session = requireMember(ctx, 'directory.view');
  const role = ROLES.includes(query.role as Role) ? query.role : null;
  const search = query.search?.trim() ? `%${query.search.trim().toLowerCase().replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db.query(
    `${SELECT_PROFILE} AND m.id <> $1 AND p.show_in_directory
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = m.user_id AND r.role_key = $2))
       AND ($3::text IS NULL OR lower(p.full_name || ' ' || p.company || ' ' || p.industry || ' ' || p.position || ' ' || p.city || ' ' || array_to_string(p.interests, ' ')) LIKE $3)
       AND m.home_market_id = $4
     ORDER BY p.full_name`,
    // The directory is the city's: members are listed in their home city.
    [session.memberId, role, search, ctx.marketId],
  );
  return rows.map(toProfile);
}

/**
 * People to meet. Drawn only from members the caller could already find in the directory, and never includes
 * anyone who has switched suggestions off. Nobody is told they were suggested.
 */
export async function listSuggestions(db: Queryable, ctx: RequestContext): Promise<MatchSuggestion[]> {
  const session = requireMember(ctx, 'directory.view');
  const off = new Set((await db.query<{ id: string }>('SELECT m.id FROM members m JOIN privacy_settings s ON s.user_id = m.user_id WHERE NOT s.suggestions')).map((row) => row.id));
  if (off.has(session.memberId)) return [];
  const [me, others] = await Promise.all([getMyProfile(db, ctx), listMembers(db, ctx, {})]);
  return suggestMatches(me, others.filter((other) => !off.has(other.id)));
}

export async function getMember(db: Queryable, ctx: RequestContext, id: string): Promise<MemberProfile> {
  const session = requireMember(ctx, 'directory.view');
  const rows = UUID.test(id) ? await db.query(`${SELECT_PROFILE} AND m.id = $2 AND m.id <> $1 AND p.show_in_directory`, [session.memberId, id]) : [];
  if (!rows[0]) throw notFound('This profile is not available.');
  return toProfile(rows[0]);
}

export async function requestConnection(db: Db, ctx: RequestContext, memberId: string): Promise<MemberProfile> {
  const session = requireMember(ctx, 'connections.request');
  return db.tx(async (tx) => {
    const target = await getMember(tx, ctx, memberId);
    if (target.connection === 'connected' || target.connection === 'requested') throw conflict('You have already connected or asked to connect.');
    if (target.connection === 'incoming') {
      // Accepting a request the other member made.
      await tx.query(`UPDATE connections SET status = 'connected', updated_at = now() WHERE requester_id = $1 AND addressee_id = $2`, [memberId, session.memberId]);
    } else {
      await tx.query(
        `INSERT INTO connections (requester_id, addressee_id) VALUES ($1, $2)
         ON CONFLICT (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)) DO UPDATE SET requester_id = $1, addressee_id = $2, status = 'requested', updated_at = now()`,
        [session.memberId, memberId],
      );
    }
    await audit(tx, session.userId, target.connection === 'incoming' ? 'connection.accepted' : 'connection.requested', 'member', memberId);
    return getMember(tx, ctx, memberId);
  });
}

export async function getMyProfile(db: Queryable, ctx: RequestContext): Promise<MemberProfile> {
  const session = requireMember(ctx, 'profile.edit');
  const rows = await db.query(`${SELECT_PROFILE} AND m.id = $1`, [session.memberId]);
  return { ...toProfile(rows[0]!), connection: 'none' };
}

export async function updateMyProfile(db: Queryable, ctx: RequestContext, body: unknown): Promise<MemberProfile> {
  const session = requireMember(ctx, 'profile.edit');
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const p = parsed.data;
  await db.query(
    `UPDATE profiles SET position = $2, company = $3, industry = $4, city = $5, biography = $6, interests = $7::text[], looking_for = $8, can_offer = $9, updated_at = now() WHERE user_id = $1`,
    [session.userId, p.position, p.company, p.industry, p.city, p.biography, p.interests, p.lookingFor, p.canOffer],
  );
  return getMyProfile(db, ctx);
}

/** Sets or, with null, removes the member's profile picture. The image has already been checked and stored. */
export async function setMyAvatar(db: Queryable, ctx: RequestContext, mediaId: string | null): Promise<MemberProfile> {
  const session = requireMember(ctx, 'profile.edit');
  await db.query('UPDATE profiles SET avatar_media_id = $2, updated_at = now() WHERE user_id = $1', [session.userId, mediaId]);
  // Earlier pictures of theirs that nothing uses any more are removed, not kept.
  await db.query('DELETE FROM media m WHERE m.uploaded_by = $1 AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.avatar_media_id = m.id) AND NOT EXISTS (SELECT 1 FROM products p WHERE p.image_id = m.id) AND NOT EXISTS (SELECT 1 FROM home_slides h WHERE h.media_id = m.id)', [session.userId]);
  await audit(db, session.userId, mediaId ? 'profile.picture_set' : 'profile.picture_removed', 'user', session.userId);
  return getMyProfile(db, ctx);
}

/* ---------- Safety: blocking and reporting ---------- */

export async function blockMember(db: Db, ctx: RequestContext, memberId: string): Promise<void> {
  const session = requireMember(ctx, 'directory.view');
  await db.tx(async (tx) => {
    const already = UUID.test(memberId) ? await tx.query('SELECT 1 FROM member_blocks WHERE blocker_id = $1 AND blocked_id = $2', [session.memberId, memberId]) : [];
    if (already[0]) return;
    await getMember(tx, ctx, memberId);   // not found unless the profile is one the caller can see
    await tx.query('INSERT INTO member_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [session.memberId, memberId]);
    await tx.query('DELETE FROM connections WHERE LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)', [session.memberId, memberId]);
    await audit(tx, session.userId, 'member.blocked', 'member', memberId);
  });
}

export async function unblockMember(db: Queryable, ctx: RequestContext, memberId: string): Promise<void> {
  const session = requireMember(ctx, 'directory.view');
  if (!UUID.test(memberId)) return;
  const rows = await db.query('DELETE FROM member_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING 1', [session.memberId, memberId]);
  if (rows[0]) await audit(db, session.userId, 'member.unblocked', 'member', memberId);
}

/** Only the caller's own blocks: nobody can find out who has blocked them. */
export async function listBlockedMembers(db: Queryable, ctx: RequestContext): Promise<BlockedMember[]> {
  const session = requireMember(ctx, 'directory.view');
  const rows = await db.query(
    `SELECT m.id, p.full_name FROM member_blocks b JOIN members m ON m.id = b.blocked_id JOIN profiles p ON p.user_id = m.user_id
      WHERE b.blocker_id = $1 ORDER BY p.full_name`, [session.memberId]);
  return rows.map((row) => ({ id: row.id as string, fullName: row.full_name as string }));
}

export async function reportMember(db: Db, ctx: RequestContext, memberId: string, body: unknown): Promise<void> {
  const session = requireMember(ctx, 'directory.view');
  await db.tx(async (tx) => {
    await getMember(tx, ctx, memberId);
    const parsed = memberReportSchema.safeParse(body);
    if (!parsed.success) throw validation(parsed.error.issues);
    const open = await tx.query(`SELECT 1 FROM member_reports WHERE reporter_id = $1 AND reported_id = $2 AND status = 'open'`, [session.memberId, memberId]);
    if (open[0]) throw conflict('Your earlier report is still with the team.');
    await tx.query('INSERT INTO member_reports (reporter_id, reported_id, reason, detail) VALUES ($1, $2, $3, $4)', [session.memberId, memberId, parsed.data.reason, parsed.data.detail]);
    // The audit entry records that a report was made, not what it says.
    await audit(tx, session.userId, 'member.reported', 'member', memberId);
  });
}
