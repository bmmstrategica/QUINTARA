/**
 * Section descriptions: the introductions to QÉRA, The Club, Concierge, Lifestyle and the rest, written by staff.
 * Anyone may read them; only staff with the content permission change them. Every change is audited.
 */
import { SECTION_DEFAULTS, SECTION_KEYS, sectionCopyInputSchema } from '@quintara/domain';
import type { SectionCopy, SectionKey } from '@quintara/domain';
import { audit, requireStaff } from './context.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable } from './db.ts';
import { notFound, validation } from './errors.ts';

export async function listSections(db: Queryable): Promise<SectionCopy[]> {
  const rows = await db.query<{ key: SectionKey; summary: string; description: string; updated_at: Date }>('SELECT key, summary, description, updated_at FROM section_copy');
  return SECTION_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return { key, title: SECTION_DEFAULTS[key].title, summary: row?.summary ?? SECTION_DEFAULTS[key].summary, description: row?.description ?? SECTION_DEFAULTS[key].description, updatedAt: row ? new Date(row.updated_at).toISOString() : null };
  });
}

export async function listSectionsForStaff(db: Queryable, ctx: RequestContext): Promise<SectionCopy[]> {
  requireStaff(ctx, 'admin.content.manage');
  return listSections(db);
}

export async function updateSection(db: Db, ctx: RequestContext, key: string, body: unknown): Promise<SectionCopy> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  if (!(SECTION_KEYS as readonly string[]).includes(key)) throw notFound('There is no such section.');
  const parsed = sectionCopyInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const row = (await db.query<{ id: string }>(`INSERT INTO section_copy (key, summary, description, updated_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT (key) DO UPDATE SET summary = $2, description = $3, updated_by = $4, updated_at = now() RETURNING id`, [key, parsed.data.summary, parsed.data.description, staffId]))[0]!;
  await audit(db, staffId, 'section.updated', 'section_copy', row.id, { key });
  return (await listSections(db)).find((c) => c.key === key)!;
}

/** Back to Quintara's default wording. */
export async function resetSection(db: Db, ctx: RequestContext, key: string): Promise<SectionCopy> {
  const staffId = requireStaff(ctx, 'admin.content.manage');
  if (!(SECTION_KEYS as readonly string[]).includes(key)) throw notFound('There is no such section.');
  const gone = (await db.query<{ id: string }>('DELETE FROM section_copy WHERE key = $1 RETURNING id', [key]))[0];
  if (gone) await audit(db, staffId, 'section.reset', 'section_copy', gone.id, { key });
  return (await listSections(db)).find((c) => c.key === key)!;
}
