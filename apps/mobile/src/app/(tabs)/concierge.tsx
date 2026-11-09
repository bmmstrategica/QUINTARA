import { useRouter } from 'expo-router';
import { useResource, useSession } from '@quintara/app-core';
import { CONCIERGE_CATEGORY_LABEL, CONCIERGE_STATUS_LABEL } from '@quintara/domain';
import { Button, EmptyState, Heading, Loading, Muted, ResourceView, Row, Screen, Tag, Title } from '@/components/ui';
import { useSection } from '@/components/section-copy';

export default function ConciergeScreen() {
  const desk = useSection('concierge');
  const router = useRouter();
  const { session, status } = useSession();
  const requests = useResource((api) => api.listConciergeRequests(), [session?.userId]);
  if (status === 'loading') return <Screen><Loading /></Screen>;
  if (!session) {
    return <Screen><EmptyState title="The concierge desk" message="Sign in to ask the desk for anything."><Button label="Sign in" onPress={() => router.push('/sign-in')} /></EmptyState></Screen>;
  }
  return (
    <Screen onRefresh={requests.reload} refreshing={requests.status === 'loading'}>
      <Title>Concierge</Title>
      <Muted>{desk.description}</Muted>
      <Button label="New request" onPress={() => router.push('/concierge/new')} />
      <Heading>Your requests</Heading>
      <ResourceView resource={requests} isEmpty={(list) => list.length === 0} empty={<Muted>Nothing yet. Your requests and the desk's replies appear here.</Muted>}>
        {(list) => list.map((request) => (
          <Row key={request.id} title={request.subject} detail={CONCIERGE_CATEGORY_LABEL[request.category]} onPress={() => router.push(`/concierge/${request.id}`)}
            trailing={<Tag tone={request.status === 'confirmed' || request.status === 'completed' ? 'positive' : request.status === 'cancelled' ? 'neutral' : 'accent'} label={CONCIERGE_STATUS_LABEL[request.status]} />} />
        ))}
      </ResourceView>
    </Screen>
  );
}
