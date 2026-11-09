'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useLive, usePermission, useResource, useSession } from '@quintara/app-core';
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

  // Unread messages and notifications, shown as a dot beside each, kept current while the page is visible.
  const unread = useResource(async (api) => {
    if (!isMember) return { messages: 0, notifications: 0 };
    const [conversations, notifications] = await Promise.all([api.listConversations(), api.listNotifications()]);
    return { messages: conversations.filter((c) => c.unread).length, notifications: notifications.filter((n) => !n.readAt).length };
  }, [isMember]);
  useLive(unread.refresh, 30000, isMember);
  // Reading a conversation or the notifications clears its dot on the next page, without the dots flickering.
  const { refresh: refreshUnread } = unread;
  useEffect(() => { if (isMember) refreshUnread(); }, [pathname, isMember, refreshUnread]);
  const dots: Record<string, number> = { '/messages': unread.data?.messages ?? 0, '/notifications': unread.data?.notifications ?? 0 };

  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <header className="bar">
      <Link className="brand" href="/" aria-label="Quintara home"><img src="/quintara-emblem.png" alt="" /><img src="/quintara-wordmark.png" alt="Quintara" /></Link>
      <nav className="nav" aria-label="Main">
        {links.map(([href, label]) => (
          <Link key={href} href={href} aria-current={isCurrent(href) ? 'page' : undefined}>
            {label}{dots[href] ? <><span className="dot" aria-hidden="true" /><span className="visually-hidden">, {dots[href]} unread</span></> : null}
          </Link>
        ))}
      </nav>
      <CityPicker />
      <ThemeToggle />
      {status === 'ready' && !session && !guest ? <><Link className="btn quiet small" href="/join">Create account</Link><Link className="btn quiet small" href="/sign-in">Sign in</Link></> : null}
    </header>
  );
}
