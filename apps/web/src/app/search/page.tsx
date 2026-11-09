'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useResource } from '@quintara/app-core';
import { SEARCH_KIND_LABEL } from '@quintara/domain';
import type { SearchResult } from '@quintara/domain';
import { ResourceView } from '@/components/states';

const HREF: Record<SearchResult['kind'], (id: string) => string> = {
  experience: (id) => `/experiences/${id}`, member: (id) => `/members/${id}`, partner: (id) => `/lifestyle/${id}`,
  listing: () => '/business', product: () => '/boutique', episode: () => '/tv',
};
const ORDER = Object.keys(SEARCH_KIND_LABEL) as SearchResult['kind'][];

export default function SearchPage() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(timer); }, [text]);
  const ready = query.length >= 2;
  const results = useResource((api) => (ready ? api.search(query) : Promise.resolve([] as SearchResult[])), [query, ready]);
  return (
    <>
      <div className="head"><div><h2>Search</h2><p className="lede">Experiences, people, partners, Maison Quintara and Quintara TV.</p></div></div>
      <label style={{ maxWidth: '36rem', marginBottom: '1.5rem' }}>Search Quintara
        <input type="search" value={text} autoFocus maxLength={80} onChange={(event) => setText(event.target.value)} placeholder="A name, a place, an interest" />
      </label>
      {!ready ? <p className="muted">Type at least two letters.</p> : (
        <ResourceView resource={results} isEmpty={(list) => list.length === 0} empty={<p className="muted">Nothing matches &ldquo;{query}&rdquo;. Try fewer or different words.</p>}>
          {(list) => ORDER.filter((kind) => list.some((r) => r.kind === kind)).map((kind) => (
            <section className="panel" key={kind} style={{ marginBottom: '2rem' }}>
              <h3>{SEARCH_KIND_LABEL[kind]}</h3>
              {list.filter((r) => r.kind === kind).map((r) => (
                <div className="panel-item" key={r.id}>
                  <div><strong style={{ fontWeight: 500 }}>{r.title}</strong><small>{r.detail}</small></div>
                  <Link className="btn quiet small" href={HREF[kind](r.id)}>Open</Link>
                </div>
              ))}
            </section>
          ))}
        </ResourceView>
      )}
    </>
  );
}
