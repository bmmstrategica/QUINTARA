/**
 * Quintara TV. Anyone can see what exists; the address of a video is only ever sent to someone allowed to
 * watch it, so a members' episode cannot be played by reading the listing. (A video host that issues
 * short-lived signed links should replace plain addresses before launch.)
 */
import { can, tvEpisodeInputSchema, tvSeriesInputSchema } from '@quintara/domain';
import type { TvEpisode, TvSeries } from '@quintara/domain';
import { z } from 'zod';
import { audit, requireMember, requirePermission, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, notFound, validation } from './errors.ts';
import { mediaPath } from './media.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Watched to within this many seconds of the end counts as finished. */
const NEARLY_DONE = 20;

function toEpisode(row: Row, member: boolean, staff = false): TvEpisode & { status: string } {
  const allowed = staff || member || row.audience === 'public';
  return {
    id: row.id as string, seriesId: row.series_id as string, number: Number(row.number), title: row.title as string, summary: row.summary as string,
    durationSeconds: Number(row.duration_seconds), audience: row.audience as TvEpisode['audience'], imagePath: row.image_id ? mediaPath(row.image_id as string) : null,
    locked: !allowed, videoUrl: allowed ? ((row.video_url as string | null) ?? null) : null,
    positionSeconds: Number(row.position_seconds ?? 0), completed: Boolean(row.completed), status: row.status as string,
  };
}
const SELECT_EPISODE = `
  SELECT e.*, g.position_seconds, g.completed
    FROM tv_episodes e JOIN tv_series s ON s.id = e.series_id
    LEFT JOIN tv_progress g ON g.episode_id = e.id AND g.member_id = $1`;

export async function listSeries(db: Queryable, ctx: RequestContext, defaultMarketId: string): Promise<TvSeries[]> {
  requirePermission(ctx, 'tv.browse');
  const member = ctx.session !== null && can({ roles: ctx.roles }, 'tv.watch');
  const market = defaultMarketId;
  const series = await db.query(`SELECT * FROM tv_series WHERE status = 'published' AND market_id = $1 ORDER BY created_at, title`, [market]);
  const episodes = await db.query(`${SELECT_EPISODE} WHERE e.status = 'published' AND s.status = 'published' AND s.market_id = $2 ORDER BY e.number`, [ctx.session?.memberId ?? null, market]);
  return series.map((row) => ({
    id: row.id as string, title: row.title as string, summary: row.summary as string, imagePath: row.image_id ? mediaPath(row.image_id as string) : null,
    episodes: episodes.filter((e) => e.series_id === row.id).map((e) => { const { status: _status, ...episode } = toEpisode(e, member); return episode; }),
  }));
}

/** Remembers where a member stopped. Only for episodes they are allowed to watch. */
export async function saveProgress(db: Queryable, ctx: RequestContext, episodeId: string, body: unknown): Promise<void> {
  const session = requireMember(ctx, 'tv.watch');
  const parsed = z.object({ positionSeconds: z.number().int().min(0).max(86400) }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const episode = UUID.test(episodeId)
    ? (await db.query<{ duration_seconds: number }>(`SELECT e.duration_seconds FROM tv_episodes e JOIN tv_series s ON s.id = e.series_id WHERE e.id = $1 AND e.status = 'published' AND s.status = 'published' AND s.market_id = $2`, [episodeId, session.marketId]))[0]
    : undefined;
  if (!episode) throw notFound('This episode is not available.');
  const duration = Number(episode.duration_seconds), position = Math.min(parsed.data.positionSeconds, duration);
  // Once an episode has been finished it stays finished, even if it is started again.
  await db.query(
    `INSERT INTO tv_progress (member_id, episode_id, position_seconds, completed) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id, episode_id) DO UPDATE SET position_seconds = $3, completed = tv_progress.completed OR $4, updated_at = now()`,
    [session.memberId, episodeId, position, position >= duration - NEARLY_DONE]);
}

/* ---------- Staff ---------- */

export async function listSeriesForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.content.manage');
  const series = await db.query(`SELECT * FROM tv_series ORDER BY (status = 'archived'), created_at`);
  const episodes = await db.query(`${SELECT_EPISODE} ORDER BY e.number`, [null]);
  const watched = Object.fromEntries((await db.query<{ episode_id: string; n: string }>('SELECT episode_id, count(*) AS n FROM tv_progress GROUP BY episode_id')).map((r) => [r.episode_id, Number(r.n)]));
  return series.map((row) => ({
    id: row.id as string, title: row.title as string, summary: row.summary as string, imagePath: row.image_id ? mediaPath(row.image_id as string) : null, status: row.status as string,
    episodes: episodes.filter((e) => e.series_id === row.id).map((e) => ({ ...toEpisode(e, true, true), viewers: watched[e.id as string] ?? 0 })),
  }));
}

export async function createSeries(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = tvSeriesInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if ((await db.query('SELECT 1 FROM tv_series WHERE market_id = $1 AND lower(title) = lower($2)', [marketId, parsed.data.title]))[0]) throw conflict('A series with that title already exists.');
  const id = (await db.query<{ id: string }>('INSERT INTO tv_series (market_id, title, summary, status) VALUES ($1, $2, $3, $4) RETURNING id', [marketId, parsed.data.title, parsed.data.summary, parsed.data.status]))[0]!.id;
  await audit(db, staffId, 'tv_series.created', 'tv_series', id, { title: parsed.data.title });
  return { id };
}

async function update(db: Db, staffId: string, table: 'tv_series' | 'tv_episodes', columns: Record<string, string>, id: string, body: unknown, data: Record<string, unknown>) {
  const sent = Object.keys(columns).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  if (!UUID.test(id) || !(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]))[0]) throw notFound('That does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE ${table} SET ${sent.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, `${table}.updated`, table, id, { fields: sent });
}

export async function updateSeries(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = tvSeriesInputSchema.partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await update(db, staffId, 'tv_series', { title: 'title', summary: 'summary', status: 'status', imageId: 'image_id' }, id, body, parsed.data);
}

export async function createEpisode(db: Db, ctx: RequestContext, seriesId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = tvEpisodeInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (!UUID.test(seriesId) || !(await db.query('SELECT 1 FROM tv_series WHERE id = $1', [seriesId]))[0]) throw notFound('This series does not exist.');
  const d = parsed.data;
  // The next number in the series, unless staff give one.
  const number = d.number ?? Number((await db.query<{ n: string }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM tv_episodes WHERE series_id = $1', [seriesId]))[0]!.n);
  if ((await db.query('SELECT 1 FROM tv_episodes WHERE series_id = $1 AND number = $2', [seriesId, number]))[0]) throw conflict(`This series already has an episode ${number}.`);
  const id = (await db.query<{ id: string }>(
    'INSERT INTO tv_episodes (series_id, number, title, summary, duration_seconds, video_url, audience, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [seriesId, number, d.title, d.summary, d.durationSeconds, d.videoUrl ?? null, d.audience, d.status]))[0]!.id;
  await audit(db, staffId, 'tv_episode.created', 'tv_episode', id, { title: d.title });
  return { id };
}

export async function updateEpisode(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  const parsed = tvEpisodeInputSchema.omit({ number: true }).partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  await update(db, staffId, 'tv_episodes', { title: 'title', summary: 'summary', durationSeconds: 'duration_seconds', videoUrl: 'video_url', audience: 'audience', status: 'status', imageId: 'image_id' }, id, body, parsed.data);
}
