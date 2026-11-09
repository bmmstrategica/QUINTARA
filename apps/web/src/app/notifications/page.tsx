'use client';

import { useRouter } from 'next/navigation';
import { useApi, useLive, useResource } from '@quintara/app-core';
import type { AppNotification } from '@quintara/domain';
import { EmptyState, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

const hrefFor = (link: NonNullable<AppNotification['link']>) =>
  link.type === 'experience' ? `/experiences/${link.id}` : link.type === 'member' ? `/members/${link.id}` : link.type === 'request' ? `/concierge/${link.id}` : link.type === 'conversation' ? `/messages/${link.id}` : link.type === 'qera' ? '/qera' : '/bookings';

export default function NotificationsPage() {
  const api = useApi();
  const router = useRouter();
  const notifications = useResource((client) => client.listNotifications());
  useLive(notifications.refresh, 30000);
  const intro = useSection('notifications');

  async function open(notification: AppNotification) {
    // Marking as read must never block navigation.
    await api.markNotificationRead(notification.id).catch(() => undefined);
    if (notification.link) router.push(hrefFor(notification.link));
    else notifications.reload();
  }

  return (
    <>
      <div className="head"><div><h2>Notifications</h2><p className="lede">{intro.description}</p></div></div>
      <ResourceView
        resource={notifications}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="Nothing new"><p className="lede">Nothing is waiting for you.</p></EmptyState>}
      >
        {(list) =>
          list.map((notification) => (
            <div className="panel-item" key={notification.id} style={{ maxWidth: '46rem' }}>
              <div>
                <span style={{ fontWeight: notification.readAt ? 400 : 600 }}>{notification.title}</span>
                <small>{new Date(notification.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}{notification.readAt ? '' : '. Unread'}</small>
              </div>
              <button className="btn quiet small" onClick={() => open(notification)}>{notification.link ? 'Open' : 'Mark as read'}</button>
            </div>
          ))
        }
      </ResourceView>
    </>
  );
}
