'use client';

import Link from 'next/link';
import { useResource } from '@quintara/app-core';
import { DailyBriefView } from '@/components/daily-brief';
import { ResourceView } from '@/components/states';

export default function TodayPage() {
  const brief = useResource((api) => api.getDailyBrief());
  return (
    <>
      <p><Link className="muted" href="/qera">Back to QÉRA</Link></p>
      <ResourceView resource={brief}>{(b) => <DailyBriefView brief={b} />}</ResourceView>
    </>
  );
}
