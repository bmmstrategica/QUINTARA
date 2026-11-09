import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useAction } from '@quintara/app-core';
import { CONCIERGE_CATEGORIES, CONCIERGE_CATEGORY_LABEL, conciergeRequestSchema } from '@quintara/domain';
import type { ConciergeCategory, ConciergeRequestInput } from '@quintara/domain';
import { ActionError, Button, Choice, Field, Screen } from '@/components/ui';

export default function NewRequestScreen() {
  const router = useRouter();
  const create = useAction((api, input: ConciergeRequestInput) => api.createConciergeRequest(input));
  const [category, setCategory] = useState<ConciergeCategory>('hospitality');
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit() {
    const parsed = conciergeRequestSchema.safeParse({ category, subject, details, neededBy: null });
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    const created = await create.run(parsed.data);
    if (created) router.replace(`/concierge/${created.id}`);
  }

  return (
    <Screen>
      <Choice label="Area" value={category} onChange={setCategory} options={CONCIERGE_CATEGORIES.map((key) => [key, CONCIERGE_CATEGORY_LABEL[key]] as const)} />
      <Field label="In a few words" value={subject} onChangeText={setSubject} placeholder="A table for six on Saturday" error={errors.subject} maxLength={120} />
      <Field label="The details" multiline value={details} onChangeText={setDetails} placeholder="Dates, number of people, preferences, anything we should know" error={errors.details} maxLength={2000} />
      <ActionError error={create.error} />
      <Button label="Send to the desk" busy={create.pending} onPress={submit} />
    </Screen>
  );
}
