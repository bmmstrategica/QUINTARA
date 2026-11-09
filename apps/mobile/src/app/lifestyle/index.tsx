import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useResource } from '@quintara/app-core';
import { CONCIERGE_SPECIALIST, SERVICE_REQUEST_STATUS_LABEL } from '@quintara/domain';
import type { DirectoryEntry } from '@quintara/domain';
import { Body, Button, Choice, Heading, Muted, ResourceView, Row, Screen, Tag, Title } from '@/components/ui';
import { useSection } from '@/components/section-copy';

type Kind = 'all' | 'partner' | 'service';

/** Lifestyle: the Lifestyle Curator, one directory of partners and services with the same details, requests and codes. */
export default function LifestyleScreen() {
  const life = useSection('lifestyle');
  const curator = useSection('curator');
  const directory = useSection('partners');
  const privileges = useSection('privileges');
  const router = useRouter();
  const partners = useResource((api) => api.listPartners());
  const redemptions = useResource((api) => api.listMyRedemptions());
  const services = useResource((api) => api.listLifestyleServices());
  const requests = useResource((api) => api.listMyServiceRequests());
  const [kind, setKind] = useState<Kind>('all');
  const entries: DirectoryEntry[] = [
    ...(partners.data ?? []).map((p) => ({ kind: 'partner' as const, ...p })),
    ...(services.data ?? []).map((x) => ({ kind: 'service' as const, ...x })),
  ].filter((e) => kind === 'all' || e.kind === kind);
  return (
    <Screen onRefresh={() => { partners.reload(); redemptions.reload(); services.reload(); requests.reload(); }} refreshing={partners.status === 'loading'}>
      <Title>Lifestyle</Title>
      <Muted>{life.description}</Muted>
      <Heading>Your Lifestyle Curator</Heading>
      <Body>{CONCIERGE_SPECIALIST.name}, {curator.summary}. {curator.description}</Body>
      <Button quiet label={`Write to ${CONCIERGE_SPECIALIST.shortName}`} onPress={() => router.push('/concierge/new')} />
      <Heading>{directory.title}</Heading>
      <Muted>{directory.description} {privileges.description}</Muted>
      <Choice label="Show" options={[['all', 'Everything'], ['partner', 'Partners'], ['service', 'Services']] as const} value={kind} onChange={(v) => setKind(v as Kind)} />
      <ResourceView resource={services}>
        {() => !entries.length ? <Muted>The directory will fill as partners and services join.</Muted> : [...new Set(entries.map((e) => e.category))].sort().map((group) => (
          <View key={group} style={{ gap: 6 }}>
            <Tag tone="accent" label={group} />
            {entries.filter((e) => e.category === group).sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
              const where = e.area ? `. ${e.area}` : '';
              if (e.kind === 'service') return <Row key={e.id} title={e.name} detail={`Service${where}. ${e.summary || e.description}`} onPress={() => router.push(`/lifestyle/service/${e.id}`)} trailing={e.packages.length ? <Tag label={`${e.packages.length} package${e.packages.length > 1 ? 's' : ''}`} /> : undefined} />;
              const open = e.privileges.filter((v) => v.available).length;
              return <Row key={e.id} title={e.name} detail={`Partner${where}. ${e.summary}`} onPress={() => router.push(`/lifestyle/${e.id}`)} trailing={open ? <Tag tone="accent" label={`${open} privilege${open > 1 ? 's' : ''}`} /> : undefined} />;
            })}
          </View>
        ))}
      </ResourceView>
      <ResourceView resource={requests}>
        {(list) => list.length ? <><Heading>Your requests</Heading>{list.map((r) => <Row key={r.id} title={r.serviceName} detail={[r.preferredDate ? `For ${r.preferredDate}` : '', r.notes].filter(Boolean).join('. ')} trailing={<Tag tone={r.status === 'cancelled' ? 'neutral' : r.status === 'confirmed' || r.status === 'completed' ? 'positive' : 'accent'} label={SERVICE_REQUEST_STATUS_LABEL[r.status]} />} />)}</> : null}
      </ResourceView>
      <Heading>Your codes</Heading>
      <ResourceView resource={redemptions} isEmpty={(list) => list.length === 0} empty={<Muted>Codes you redeem appear here.</Muted>}>
        {(list) => list.map((r) => <Row key={r.id} title={r.privilegeTitle} detail={r.partnerName} trailing={<Tag tone="accent" label={r.code} />} />)}
      </ResourceView>
    </Screen>
  );
}
