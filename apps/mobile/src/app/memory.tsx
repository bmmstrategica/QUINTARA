import { useState } from 'react';
import { View } from 'react-native';
import { useAction, useResource } from '@quintara/app-core';
import { dayAndMonth, MEMORY_KIND_LABEL, MEMORY_KINDS } from '@quintara/domain';
import type { MemoryKind } from '@quintara/domain';
import { ActionError, Body, Button, Choice, confirmThen, Divider, Field, Heading, Muted, ResourceView, Row, Screen, Title } from '@/components/ui';

/** Everything QÉRA remembers, which the member can add to, change or remove. */
export default function MemoryScreen() {
  const [version, setVersion] = useState(0);
  const memory = useResource((api) => api.getQeraMemory(), [version]);
  const refresh = () => setVersion((n) => n + 1);
  const [kind, setKind] = useState<MemoryKind>('likes');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const add = useAction(async (api, input: { kind: MemoryKind; label: string; date?: string | null }) => { await api.addQeraMemory(input); return true; });
  const remove = useAction(async (api, id: string) => { await api.deleteQeraMemory(id); return true; });
  const clear = useAction(async (api) => { await api.clearQeraMemory(); return true; });
  return (
    <Screen>
      <Title>What QÉRA remembers</Title>
      <Muted>QÉRA remembers only what you add here or ask it to remember, and it always asks first. Restaurants and chefs are told your dietary needs when QÉRA books them; nothing else here is shared.</Muted>
      <ResourceView resource={memory}>
        {(m) => (
          <>
            {m.items.length === 0 ? <Body>Nothing yet.</Body> : null}
            {MEMORY_KINDS.filter((k) => m.items.some((i) => i.kind === k)).map((k) => (
              <View key={k}>
                <Heading>{MEMORY_KIND_LABEL[k]}</Heading>
                {m.items.filter((i) => i.kind === k).map((i) => <Row key={i.id} title={i.label} detail={[i.date ? dayAndMonth(i.date) : '', i.detail].filter(Boolean).join('. ') || undefined} trailing={<Button quiet label="Remove" disabled={remove.pending} onPress={async () => { if (await remove.run(i.id)) refresh(); }} />} />)}
              </View>
            ))}
            {m.suggestions.length ? <Heading>QÉRA noticed</Heading> : null}
            {m.suggestions.map((sg) => <Row key={sg.label} title={sg.label} detail={sg.reason} trailing={<Button quiet label="Remember" disabled={add.pending} onPress={async () => { if (await add.run({ kind: sg.kind, label: sg.label })) refresh(); }} />} />)}
          </>
        )}
      </ResourceView>
      <Divider />
      <Heading>Add</Heading>
      <Choice label="Kind" options={MEMORY_KINDS.map((k) => [k, MEMORY_KIND_LABEL[k]] as const)} value={kind} onChange={setKind} />
      <Field label="What to remember" value={label} onChangeText={setLabel} maxLength={120} />
      {kind === 'date' ? <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} maxLength={10} /> : null}
      <ActionError error={add.error ?? remove.error ?? clear.error} />
      <Button label="Remember this" busy={add.pending} onPress={async () => { if (await add.run({ kind, label, date: kind === 'date' ? date || null : null })) { setLabel(''); setDate(''); refresh(); } }} />
      <Button quiet label="Forget everything" onPress={() => confirmThen('Forget everything?', 'QÉRA will forget everything it remembers about you.', 'Forget', () => { void clear.run().then((ok) => { if (ok) refresh(); }); }, true)} />
    </Screen>
  );
}
