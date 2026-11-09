'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePermission, useSession } from '@quintara/app-core';
import { CityPicker } from './city-picker';
import { ThemeToggle } from './theme-toggle';

export function Header() {
  const pathname = usePathname();
  const { session, guest, status } = useSession();
  const isMember = usePermission('directory.view');

  const links: [href: string, label: string][] = isMember
    ? [['/', 'Home'], ['/qera', 'QÉRA'], ['/search', 'Search'], ['/experiences', 'Experiences'], ['/members', 'Members'], ['/business', 'Business'], ['/lifestyle', 'Lifestyle'], ['/boutique', 'Maison Quintara'], ['/tv', 'TV'], ['/concierge', 'Concierge'], ['/messages', 'Messages'], ['/bookings', 'Bookings'], ['/notifications', 'Notifications'], ['/profile', 'Profile']]
    : guest
      ? [['/', 'Quintara'], ['/qera', 'QÉRA'], ['/experiences', 'Experiences'], ['/lifestyle', 'Lifestyle'], ['/boutique', 'Maison Quintara'], ['/tv', 'TV'], ['/search', 'Search'], ['/apply', 'Apply'], ['/account', 'Account']]
      : [['/', 'Quintara'], ['/experiences', 'Experiences'], ['/lifestyle', 'Lifestyle'], ['/boutique', 'Maison Quintara'], ['/tv', 'TV'], ['/search', 'Search'], ['/apply', 'Apply']];

  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <header className="bar">
      <Link className="brand" href="/" aria-label="Quintara home"><img src="/quintara-emblem.png" alt="" /><img src="/quintara-wordmark.png" alt="Quintara" /></Link>
      <nav className="nav" aria-label="Main">
        {links.map(([href, label]) => (
          <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined}>{label}</Link>
        ))}
      </nav>
      <CityPicker />
      <ThemeToggle />
      {status === 'ready' && !session && !guest ? <><Link className="btn quiet small" href="/join">Create account</Link><Link className="btn quiet small" href="/sign-in">Sign in</Link></> : null}
    </header>
  );
}
