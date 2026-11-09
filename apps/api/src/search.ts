/**
 * Search across Quintara. It has no queries of its own: it asks each part of the app for what this viewer is
 * already allowed to see and looks through that, so search can never show something the rest of the app would not.
 */
import { can, formatDateTime, LISTING_KIND_LABEL } from '@quintara/domain';
import type { SearchResult } from '@quintara/domain';
import { listProducts } from './boutique.ts';
import { listListings } from './business.ts';
import type { RequestContext } from './context.ts';
import type { Queryable } from './db.ts';
import { validation } from './errors.ts';
import { listExperiences } from './experiences.ts';
import { listMembers } from './members.ts';
import { listPartners } from './partners.ts';
import { listSeries } from './tv.ts';

const PER_KIND = 5;

export async function search(db: Queryable, ctx: RequestContext, defaultMarketId: string, query: unknown): Promise<SearchResult[]> {
  const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (text.length < 2 || text.length > 80) throw validation([{ path: ['q'], message: 'Search for at least two letters' }]);
  const words = text.split(/\s+/).filter(Boolean);
  // Every word must appear somewhere in the item's own text.
  const hit = (...fields: (string | null | undefined)[]) => { const hay = fields.filter(Boolean).join(' ').toLowerCase(); return words.every((word) => hay.includes(word)); };
  const allowed = (permission: Parameters<typeof can>[1]) => ctx.session !== null && can({ roles: ctx.roles }, permission);
  const results: SearchResult[] = [];
  const add = (found: SearchResult[]) => results.push(...found.slice(0, PER_KIND));

  add((await listExperiences(db, ctx)).filter((e) => hit(e.title, e.category, e.summary, e.venueName, e.area))
    .map((e) => ({ kind: 'experience', id: e.id, title: e.title, detail: e.startsAt ? `${e.category}. ${formatDateTime(e.startsAt, e.timezone).long}, ${e.area}` : `${e.category}. ${e.area}` })));
  if (allowed('directory.view')) {
    add((await listMembers(db, ctx, {})).filter((m) => hit(m.fullName, m.position, m.company, m.industry, m.city, ...m.interests))
      .map((m) => ({ kind: 'member', id: m.id, title: m.fullName, detail: `${m.position}, ${m.company}. ${m.city}` })));
  }
  if (allowed('privileges.use')) {
    add((await listPartners(db, ctx)).filter((p) => hit(p.name, p.category, p.summary, p.area, ...p.privileges.map((v) => v.title)))
      .map((p) => ({ kind: 'partner', id: p.id, title: p.name, detail: `${p.category}${p.area ? `. ${p.area}` : ''}` })));
  }
  if (allowed('business.view')) {
    add((await listListings(db, ctx)).filter((l) => !l.mine && hit(l.title, l.summary, l.sector, LISTING_KIND_LABEL[l.kind]))
      .map((l) => ({ kind: 'listing', id: l.id, title: l.title, detail: `${LISTING_KIND_LABEL[l.kind]}. ${l.postedBy.fullName}` })));
  }
  add((await listProducts(db, ctx, defaultMarketId)).filter((p) => hit(p.title, p.maker, p.category, p.description))
    .map((p) => ({ kind: 'product', id: p.id, title: p.title, detail: `${p.category}${p.maker ? `. ${p.maker}` : ''}` })));
  add((await listSeries(db, ctx, defaultMarketId)).flatMap((s) => s.episodes.filter((e) => hit(s.title, e.title, e.summary))
    .map((e): SearchResult => ({ kind: 'episode', id: e.id, title: e.title, detail: `${s.title}, episode ${e.number}${e.locked ? '. For members' : ''}` }))));
  return results;
}
