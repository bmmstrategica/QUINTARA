import { useResource } from '@quintara/app-core';
import { DailyBriefCard } from '@/components/daily-brief';
import { ResourceView, Screen } from '@/components/ui';

/** QÉRA's daily brief: the member's day, from their calendar and from Quintara. */
export default function TodayScreen() {
  const brief = useResource((api) => api.getDailyBrief());
  return <Screen onRefresh={brief.reload} refreshing={brief.status === 'loading'}><ResourceView resource={brief}>{(b) => <DailyBriefCard brief={b} />}</ResourceView></Screen>;
}
