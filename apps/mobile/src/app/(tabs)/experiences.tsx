import { useState } from 'react';
import { usePermission, useResource } from '@quintara/app-core';
import { ExperienceCard } from '@/components/experience-card';
import { Chips, EmptyState, Muted, ResourceView, Screen } from '@/components/ui';
import { useSection } from '@/components/section-copy';

export default function ExperiencesScreen() {
  const experiences = useResource((api) => api.listExperiences());
  const canBook = usePermission('experiences.book');
  const intro = useSection('experiences');
  const [category, setCategory] = useState('');
  return (
    <Screen onRefresh={experiences.reload} refreshing={experiences.status === 'loading'}>
      <Muted>{canBook ? intro.description : 'Some experiences are kept for members. Apply to see the full calendar.'}</Muted>
      <ResourceView
        resource={experiences}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="Nothing on the calendar yet" message="New experiences are announced to members first." />}
      >
        {(list) => {
          const types = [...new Set(list.map((e) => e.category))].sort();
          const shown = list.filter((e) => !category || e.category === category);
          return <>
            <Chips label="Type of experience" value={category} onChange={setCategory} options={[['', 'All', list.length], ...types.map((t) => [t, t, list.filter((e) => e.category === t).length] as const)]} />
            {shown.length ? shown.map((experience) => <ExperienceCard key={experience.id} experience={experience} />) : <Muted>Nothing of this type right now.</Muted>}
          </>;
        }}
      </ResourceView>
    </Screen>
  );
}
