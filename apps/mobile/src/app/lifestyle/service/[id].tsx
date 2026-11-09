import { Linking } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useResource } from '@quintara/app-core';
import { Body, Button, Divider, Heading, Muted, ResourceView, Screen, Title } from '@/components/ui';
import { ServiceCard } from '@/components/service-card';
import { useSection } from '@/components/section-copy';

/** A service in the directory: the same details as a partner, then its packages and a request to book. */
export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const intro = useSection('services');
  const service = useResource((api) => api.getLifestyleService(id), [id]);
  return (
    <Screen>
      <ResourceView resource={service}>
        {(x) => (
          <>
            <Title>{x.name}</Title>
            <Muted>Service. {x.category}{x.area ? `. ${x.area}` : ''}.</Muted>
            {x.summary ? <Body>{x.summary}</Body> : null}
            {x.description ? <Body>{x.description}</Body> : null}
            {x.offer ? <><Muted>They offer</Muted><Body>{x.offer}</Body></> : null}
            {x.contactName ? <><Muted>Focal point</Muted><Body>{x.contactName}</Body></> : null}
            {x.contactEmail ? <><Muted>Email</Muted><Body selectable>{x.contactEmail}</Body></> : null}
            {x.contactPhone ? <><Muted>Contact</Muted><Body selectable>{x.contactPhone}</Body></> : null}
            {x.address ? <><Muted>Location</Muted><Body>{x.address}</Body></> : null}
            {x.website ? <Button quiet label={`Website: ${new URL(x.website).hostname}`} onPress={() => { void Linking.openURL(x.website!); }} /> : null}
            <Divider />
            <Heading>Packages</Heading>
            <Muted>{intro.description}</Muted>
            <ServiceCard service={x} onRequested={service.reload} />
            <Muted>Requests go to the Quintara concierge desk, who arrange it with the provider.</Muted>
          </>
        )}
      </ResourceView>
    </Screen>
  );
}
