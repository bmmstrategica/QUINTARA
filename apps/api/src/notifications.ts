import type { AppNotification } from '@quintara/domain';
import { requireMember } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Queryable } from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listNotifications(db: Queryable, ctx: RequestContext): Promise<AppNotification[]> {
  const session = requireMember(ctx, 'notifications.view');
  const rows = await db.query('SELECT id, category, title, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [session.userId]);
  return rows.map((row) => ({
    id: row.id as string,
    category: row.category as AppNotification['category'],
    title: row.title as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    readAt: row.read_at ? new Date(row.read_at as string).toISOString() : null,
    link: (row.link as AppNotification['link']) ?? null,
  }));
}

export async function markNotificationRead(db: Queryable, ctx: RequestContext, id: string): Promise<void> {
  const session = requireMember(ctx, 'notifications.view');
  // Scoped to the owner, so one member can never mark another member's notification.
  if (UUID.test(id)) await db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [id, session.userId]);
}
