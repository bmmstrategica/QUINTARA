'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useLive, usePermission, useResource, useSession } from '@quintara/app-core';
import { CityPicker } from './city-picker';
import { Menu } from './menu';
import { ThemeToggle } from './theme-toggle';

const icon = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></>,
  messages: <path d="M4 5.5h16v10.5H9l-5 4z" />,
  bell: <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5" /></>,
};

function IconLink({ href, label, name, current, unread = 0 }: { href: string; label: string; name: keyof typeof icon; current: boolean; unread?: number }) {
  // With something unread, a dot on the icon, and the count in its name for screen readers.
  const named = unread ? `${label}, ${unread} unread` : label;
  return (
    <Link className="icon-link" href={href} aria-label={named} title={named} aria-current={current ? 'page' : undefined}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">{icon[name]}</svg>
      {unread ? <span className="dot" aria-hidden="true" /> : null}
    </Link>
  );
}

/** Logo on the left; on the right, search and account shortcuts, the location icon, then the five main headings. */
export function Header() {
  const pathname = usePathname();
  const { session, guest, status } = useSession();
  const isMember = usePermission('directory.view');
  const at = (href: string) => pathname.startsWith(href);

  // Unread messages and notifications, kept current while the page is visible.
  const unread = useResource(async (api) => {
    if (!isMember) return { messages: 0, notifications: 0 };
    const [conversations, notifications] = await Promise.all([api.listConversations(), api.listNotifications()]);
    return { messages: conversations.filter((c) => c.unread).length, notifications: notifications.filter((n) => !n.readAt).length };
  }, [isMember]);
  useLive(unread.refresh, 30000, isMember);
  // Reading a conversation or the notifications clears its dot on the next page, without the dots flickering.
  const { refresh: refreshUnread } = unread;
  useEffect(() => { if (isMember) refreshUnread(); }, [pathname, isMember, refreshUnread]);

  return (
    <header className="bar">
      <Link className="brand" href="/" aria-label="Quintara home"><img src="/quintara-emblem.png" alt="" /><img src="/quintara-wordmark.png" alt="Quintara" /></Link>
      <div className="bar-tools">
        <IconLink href="/search" label="Search" name="search" current={at('/search')} />
        {isMember ? <><IconLink href="/messages" label="Messages" name="messages" current={at('/messages')} unread={unread.data?.messages} /><IconLink href="/notifications" label="Notifications" name="bell" current={at('/notifications')} unread={unread.data?.notifications} /><IconLink href="/profile" label="Your profile" name="user" current={at('/profile')} /></> : null}
        {!isMember && guest ? <IconLink href="/account" label="Your account" name="user" current={at('/account')} /> : null}
        {status === 'ready' && !session && !guest ? <><Link className="btn quiet small" href="/sign-in">Sign in</Link><Link className="btn quiet small" href="/apply">Apply</Link></> : null}
        <ThemeToggle />
        <CityPicker />
      </div>
      <Menu />
    </header>
  );
}
