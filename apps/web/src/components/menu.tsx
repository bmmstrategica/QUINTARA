'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { usePermission, useResource, useSession } from '@quintara/app-core';

/**
 * The web app's main menu: five headings at the top right, after the location icon.
 * Each heading opens a panel with its sub-headings (pages) and, below them, shortcuts to the filters on those
 * pages (experiences by type, members by type, and so on). The current heading's pages also show in a row under
 * the bar; each page shows its own filters as a row of chips.
 *
 * Access mirrors the pages: 'all' is open to visitors, 'account' needs a member or guest account,
 * 'member' needs membership. A filter someone cannot use shows a lock and leads to sign-up,
 * never to the page, so nothing private is shown by the menu.
 */
type Access = 'all' | 'account' | 'member';
type Item = { label: string; path: string; query?: Record<string, string>; hash?: string; access?: Access };
/** A set of filters on one page, shown in the heading's panel as shortcuts. The page shows the same filters itself. */
type FilterSet = { title: string; items: Item[] };
type Group = { title: string; summary: string; items: Item[]; filters: FilterSet[]; owns: string[] };

const ROLE_FILTERS: [string, string][] = [['founder', 'Founders'], ['investor', 'Investors'], ['creative', 'Creatives'], ['executive', 'Executives']];

function groups(experienceTypes: string[], productTypes: string[]): Group[] {
  return [
    {
      title: 'Discover', summary: 'Experiences, QÉRA and everything new',
      items: [{ label: 'Home', path: '/' }, { label: 'Experiences', path: '/experiences' }, { label: 'QÉRA', path: '/qera', access: 'account' }, { label: 'Search', path: '/search' }],
      filters: experienceTypes.length ? [{ title: 'Experiences by type', items: experienceTypes.map((t) => ({ label: t, path: '/experiences', query: { category: t } })) }] : [],
      owns: ['/experiences', '/qera', '/search'],
    },
    {
      title: 'The Club', summary: 'Members, introductions and Business',
      items: [
        { label: 'Members', path: '/members', access: 'member' },
        { label: 'People to meet', path: '/members', hash: 'people-to-meet', access: 'member' },
        { label: 'Messages', path: '/messages', access: 'member' },
        { label: 'Business', path: '/business', access: 'member' },
        { label: 'Notifications', path: '/notifications', access: 'member' },
        { label: 'Your profile', path: '/profile', access: 'member' },
      ],
      filters: [{ title: 'Members by type', items: ROLE_FILTERS.map(([role, label]) => ({ label, path: '/members', query: { role }, access: 'member' as Access })) }],
      owns: ['/members', '/messages', '/business', '/notifications', '/profile', '/account', '/apply'],
    },
    {
      title: 'Lifestyle', summary: 'Partners, services and your Curator',
      items: [
        { label: 'Partners and services', path: '/lifestyle' },
        { label: 'Lifestyle Curator', path: '/lifestyle', hash: 'curator' },
        { label: 'Your codes', path: '/lifestyle', hash: 'codes', access: 'member' },
        { label: 'Concierge', path: '/concierge', access: 'member' },
        { label: 'Bookings', path: '/bookings', access: 'member' },
      ],
      filters: [{ title: 'Show', items: [{ label: 'Partners', path: '/lifestyle', query: { show: 'partner' }, access: 'member' }, { label: 'Services', path: '/lifestyle', query: { show: 'service' } }] }],
      owns: ['/lifestyle', '/concierge', '/bookings', '/partner-booking'],
    },
    {
      title: 'Media', summary: 'Quintara TV: films from inside the club',
      items: [{ label: 'Quintara TV', path: '/tv' }],
      filters: [{ title: 'Episodes', items: [
        { label: 'Continue watching', path: '/tv', query: { show: 'continue' }, access: 'account' },
        { label: 'New to you', path: '/tv', query: { show: 'new' } },
        { label: 'Watched', path: '/tv', query: { show: 'watched' }, access: 'account' },
      ] }],
      owns: ['/tv'],
    },
    {
      title: 'Fashion', summary: 'Maison Quintara, the house’s own boutique',
      items: [{ label: 'Maison Quintara', path: '/boutique' }, { label: 'Your orders', path: '/boutique', hash: 'orders', access: 'account' }],
      filters: [{ title: 'Pieces by type', items: [...productTypes.map((c) => ({ label: c, path: '/boutique', query: { category: c } })), { label: 'Wishlist', path: '/boutique', query: { saved: '1' }, access: 'member' as Access }] }],
      owns: ['/boutique'],
    },
  ];
}

const hrefOf = (i: Item) => `${i.path}${i.query ? `?${new URLSearchParams(i.query)}` : ''}${i.hash ? `#${i.hash}` : ''}`;
const under = (pathname: string, path: string) => (path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`));

function currentGroup(all: Group[], pathname: string) {
  return all.find((g) => g.items.some((i) => i.path === pathname)) ?? all.find((g) => g.owns.some((p) => under(pathname, p)));
}

/** A filter is current when its page is open with its own settings, and the page's plain item when no sibling filter is set. */
function isOn(item: Item, pathname: string, params: URLSearchParams | null) {
  if (item.hash || pathname !== item.path) return false;
  return Object.entries(item.query ?? {}).every(([k, v]) => params?.get(k) === v);
}

function useAccess() {
  const { session, guest } = useSession();
  const isMember = usePermission('directory.view');
  return (access: Access = 'all') => access === 'all' || (access === 'account' ? Boolean(session || guest) : isMember);
}

const Lock = () => <svg className="lock" aria-hidden="true" viewBox="0 0 24 24" width="11" height="11"><rect x="5" y="11" width="14" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;

/** The panels open on hover or keyboard focus; after a choice, focus leaves so the panel closes on the new page. */
const close = (event: React.MouseEvent<HTMLAnchorElement>) => event.currentTarget.blur();

function Filter({ item, pathname, params }: { item: Item; pathname: string; params: URLSearchParams | null }) {
  const allowed = useAccess();
  const { session, guest } = useSession();
  if (!allowed(item.access)) {
    // Locked: lead to joining, never to the page.
    const to = item.access === 'account' && !session && !guest ? '/join' : '/apply';
    return <Link className="filter locked" href={to} onClick={close} title={item.access === 'account' ? 'For members and guests' : 'For members'}>{item.label}<Lock /><span className="vh"> (for {item.access === 'account' ? 'members and guests' : 'members'})</span></Link>;
  }
  const on = isOn(item, pathname, params);
  return <Link className={`filter${on ? ' on' : ''}`} href={hrefOf(item)} aria-current={on ? 'page' : undefined} onClick={close}>{item.label}</Link>;
}

function MenuView({ params }: { params: URLSearchParams | null }) {
  const pathname = usePathname();
  // The types come from what is published, so new ones appear in the menu as the team adds them.
  const products = useResource((api) => api.listProducts());
  const experiences = useResource((api) => api.listExperiences());
  const types = <T,>(list: T[] | undefined, of: (x: T) => string) => [...new Set((list ?? []).map(of))].sort();
  const all = groups(types(experiences.data, (e) => e.category), types(products.data, (p) => p.category));
  const current = currentGroup(all, pathname);
  const allowed = useAccess();
  return (
    <>
      <nav className="menu" aria-label="Main">
        {all.map((g, index) => {
          const first = g.items.find((i) => allowed(i.access)) ?? g.items[0]!;
          return (
            <div className={`menu-group${current === g ? ' current' : ''}`} key={g.title}>
              <Link className="menu-heading" onClick={close} href={allowed(first.access) ? hrefOf(first) : '/apply'} aria-current={current === g ? 'true' : undefined} aria-haspopup="true">
                {g.title}<svg aria-hidden="true" viewBox="0 0 10 6" width="9" height="6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
              </Link>
              <div className={`menu-panel${index >= 3 ? ' end' : ''}`} aria-label={`${g.title} filters`}>
                <div className="menu-panel-head"><strong>{g.title}</strong><span>{g.summary}</span></div>
                <div className="filters">{g.items.map((i) => <Filter key={hrefOf(i)} item={i} pathname={pathname} params={params} />)}</div>
                {g.filters.filter((set) => set.items.length).map((set) => (
                  <div className="menu-filters" key={set.title}>
                    <span className="menu-filters-title">{set.title}</span>
                    <div className="filters">{set.items.map((i) => <Filter key={hrefOf(i)} item={i} pathname={pathname} params={params} />)}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      {current ? (
        <div className="subbar" aria-label={`${current.title} filters`}>
          <span className="subbar-label">{current.title}</span>
          {current.items.map((i) => <Filter key={hrefOf(i)} item={i} pathname={pathname} params={params} />)}
        </div>
      ) : null}
    </>
  );
}

function MenuWithQuery() {
  return <MenuView params={useSearchParams()} />;
}

/** The query string is read inside Suspense, so pages can still be prerendered. */
export function Menu() {
  return <Suspense fallback={<MenuView params={null} />}><MenuWithQuery /></Suspense>;
}
