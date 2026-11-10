import { useRouter } from 'expo-router';
import { useApi, useLive, useResource } from '@quintara/app-core';
import type { AppNotification } from '@quintara/domain';
import { Button, clock, EmptyState, Muted, ResourceView, Row, Screen, Tag } from '@/components/ui';
import { NOTIFICATION_ROUTE, usePush } from '@/components/push';
import { useSection } from '@/components/section-copy';

const ROUTE = NOTIFICATION_ROUTE;

export default function NotificationsScreen() {
  const router = useRouter();
  const api = useApi();
  const notifications = useResource((client) => client.listNotifications());
  useLive(notifications.refresh, 30000);
  const intro = useSection('notifications');
  const push = usePush();
  const open = async (n: AppNotification) => {
    if (!n.readAt) await api.markNotificationRead(n.id).catch(() => undefined);
    if (n.link) router.push(ROUTE[n.link.type](n.link.id));
    else notifications.reload();
  };
  return (
    <Screen onRefresh={notifications.reload} refreshing={notifications.status === 'loading'}>
      <Muted>{intro.description}</Muted>
      {push && push.permission === 'undetermined' ? <Button quiet label="Have these arrive on this phone" onPress={() => { void push.turnOn(); }} /> : null}
      <Button quiet label="Notification settings" onPress={() => router.push('/notification-settings')} />
      <ResourceView resource={notifications} isEmpty={(list) => list.length === 0} empty={<EmptyState title="Nothing new" message="Nothing is waiting for you." />}>
        {(list) => list.map((n) => <Row key={n.id} title={n.title} detail={clock(n.createdAt)} onPress={() => { void open(n); }} trailing={n.readAt ? undefined : <Tag tone="accent" label="New" />} />)}
      </ResourceView>
    </Screen>
  );
}
