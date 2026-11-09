'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePermission, useResource } from '@quintara/app-core';
import type { BookingStatus } from '@quintara/domain';
import { ExperienceRow } from '@/components/experience';
import { EmptyState, ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

export default function ExperiencesPage() {
  const canBook = usePermission('experiences.book');
  const intro = useSection('experiences');
  const [category, setCategory] = useState('');
  const resource = useResource(async (api) => {
    const [experiences, bookings] = await Promise.all([api.listExperiences(), canBook ? api.listBookings() : Promise.resolve([])]);
    return { experiences, bookings };
  }, [canBook]);

  return (
    <>
      <div className="head">
        <div>
          <h2>Experiences</h2>
          <p className="lede">{canBook ? intro.description : 'Some experiences are kept for members. Apply to see the full calendar.'}</p>
        </div>
        {resource.status === 'ready' ? (
          <label style={{ minWidth: '12rem' }}>
            Category
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {[...new Set(resource.data.experiences.map((e) => e.category))].map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <ResourceView
        resource={resource}
        isEmpty={({ experiences }) => experiences.length === 0}
        empty={<EmptyState title="Nothing on the calendar yet"><p className="lede">New experiences are announced to members first.</p><Link className="btn" href="/apply">Apply for membership</Link></EmptyState>}
      >
        {({ experiences, bookings }) => {
          const statusByExperience = new Map<string, BookingStatus>();
          for (const b of bookings) if (b.status !== 'cancelled' && b.status !== 'declined') statusByExperience.set(b.experienceId, b.status);
          const shown = experiences.filter((e) => !category || e.category === category);
          if (shown.length === 0) return <p className="muted">Nothing in this category right now.</p>;
          return shown.map((e) => <ExperienceRow key={e.id} experience={e} status={statusByExperience.get(e.id)} />);
        }}
      </ResourceView>
    </>
  );
}
