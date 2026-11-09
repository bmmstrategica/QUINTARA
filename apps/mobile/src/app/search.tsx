import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useResource } from '@quintara/app-core';
import { SEARCH_KIND_LABEL } from '@quintara/domain';
import type { SearchResult } from '@quintara/domain';
import { Field, Heading, Muted, ResourceView, Row, Screen } from '@/components/ui';

const ROUTE: Record<SearchResult['kind'], (id: string) => string> = {
  experience: (id) => `/experience/${id}`, member: (id) => `/member/${id}`, partner: (id) => `/lifestyle/${id}`,
  listing: () => '/business', product: () => '/boutique', episode: () => '/tv',
};
const ORDER = Object.keys(SEARCH_KIND_LABEL) as SearchResult['kind'][];

export default function SearchScreen() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(timer); }, [text]);
  const ready = query.length >= 2;
  const results = useResource((api) => (ready ? api.search(query) : Promise.resolve([] as SearchResult[])), [query, ready]);
  return (
    <Screen>
      <Field label="Search Quintara" value={text} onChangeText={setText} placeholder="A name, a place, an interest" autoCorrect={false} autoCapitalize="none" returnKeyType="search" maxLength={80} />
      {!ready ? <Muted>Type at least two letters.</Muted> : (
        <ResourceView resource={results} isEmpty={(list) => list.length === 0} empty={<Muted>Nothing matches. Try fewer or different words.</Muted>}>
          {(list) => ORDER.filter((kind) => list.some((r) => r.kind === kind)).map((kind) => (
            <ResultGroup key={kind} title={SEARCH_KIND_LABEL[kind]} results={list.filter((r) => r.kind === kind)} onOpen={(r) => router.push(ROUTE[kind](r.id))} />
          ))}
        </ResourceView>
      )}
    </Screen>
  );
}

function ResultGroup({ title, results, onOpen }: { title: string; results: SearchResult[]; onOpen: (result: SearchResult) => void }) {
  return (
    <>
      <Heading>{title}</Heading>
      {results.map((r) => <Row key={r.id} title={r.title} detail={r.detail} onPress={() => onOpen(r)} />)}
    </>
  );
}
