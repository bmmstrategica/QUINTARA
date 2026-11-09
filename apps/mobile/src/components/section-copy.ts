import { useResource } from '@quintara/app-core';
import { sectionText } from '@quintara/domain';
import type { SectionCopy, SectionKey } from '@quintara/domain';

/** The wording staff have written for a section, or Quintara's default while it loads or if it cannot be read. */
export function useSection(key: SectionKey): SectionCopy {
  const copy = useResource((api) => api.listSectionCopy());
  return sectionText(copy.data, key);
}
