import { usePermission, useResource } from '@quintara/app-core';
import { ExperienceCard } from '@/components/experience-card';
import { EmptyState, Muted, ResourceView, Screen } from '@/components/ui';
import { useSection } from '@/components/section-copy';

export default function ExperiencesScreen() {
  const experiences = useResource((api) => api.listExperiences());
  const canBook = usePermission('experiences.book');
  const intro = useSection('experiences');
  return (
    <Screen onRefresh={experiences.reload} refreshing={experiences.status === 'loading'}>
      <Muted>{canBook ? intro.description : 'Some experiences are kept for members. Apply to see the full calendar.'}</Muted>
      <ResourceView
        resource={experiences}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="Nothing on the calendar yet" message="New experiences are announced to members first." />}
      >
        {(list) => list.map((experience) => <ExperienceCard key={experience.id} experience={experience} />)}
      </ResourceView>
    </Screen>
  );
}
