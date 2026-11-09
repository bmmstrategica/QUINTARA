import { useRouter } from 'expo-router';
import { useResource } from '@quintara/app-core';
import { clock, EmptyState, ResourceView, Row, Screen, Tag, Muted } from '@/components/ui';
import { useSection } from '@/components/section-copy';

export default function MessagesScreen() {
  const messaging = useSection('messaging');
  const router = useRouter();
  const conversations = useResource((api) => api.listConversations());
  return (
    <Screen onRefresh={conversations.reload} refreshing={conversations.status === 'loading'}>
      <Muted>{messaging.description}</Muted>
      <ResourceView resource={conversations} isEmpty={(list) => list.length === 0} empty={<EmptyState title="No conversations yet" message="Messaging opens with any member you are connected to. Start from their profile." />}>
        {(list) => list.map((c) => (
          <Row key={c.memberId} title={c.fullName} detail={`${c.lastMessage}  ${clock(c.lastMessageAt)}`} onPress={() => router.push(`/messages/${c.memberId}`)} trailing={c.unread ? <Tag tone="accent" label="New" /> : undefined} />
        ))}
      </ResourceView>
    </Screen>
  );
}
