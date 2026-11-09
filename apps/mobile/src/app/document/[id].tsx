import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { useState } from 'react';
import { Alert } from 'react-native';
import { useAction, useApi, useResource } from '@quintara/app-core';
import type { PlanBookingResult } from '@quintara/domain';
import { ActionError, Body, Button, Choice, Divider, Heading, Muted, ResourceView, Screen, Title } from '@/components/ui';
import { useTheme } from '@/theme';

/** A plan QÉRA prepared. The web app has the print and PDF version. */
export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { color, space } = useTheme();
  const [version, setVersion] = useState(0);
  const [party, setParty] = useState<'1' | '2' | '4' | '6'>('2');
  const [result, setResult] = useState<PlanBookingResult | null>(null);
  const api = useApi();
  const loaded = useResource((client) => client.getQeraDocument(id), [id, version]);
  const book = useAction((client, lines: number[]) => client.bookPlan(id, { partySize: Number(party), lines }));
  // Shows exactly what each line would do, then books the bookable ones on one confirmation.
  async function bookAll() {
    const preview = await api.previewPlanBooking(id, Number(party));
    const ready = preview.lines.filter((l) => l.bookable);
    if (!ready.length) { Alert.alert('Nothing to book', 'Every line is booked already, or cannot be booked now.'); return; }
    Alert.alert(`Book ${ready.length} line${ready.length > 1 ? 's' : ''} for ${party}?`, [...ready.map((l) => `${l.title}, ${l.day}${l.cost ? `: ${l.cost}` : ''}`), '', ...preview.notes].join('\n'), [
      { text: 'Not now', style: 'cancel' },
      { text: 'Book', onPress: async () => { const done = await book.run(ready.map((l) => l.index)); if (done) { setResult(done); setVersion((n) => n + 1); } } },
    ]);
  }
  return (
    <Screen>
      <ResourceView resource={loaded}>
        {(doc) => (
          <>
            <Muted>Prepared by QÉRA, the Quintara Intelligence</Muted>
            <Title>{doc.content.title}</Title>
            <Body>{doc.content.subtitle}</Body>
            <Muted>For {doc.content.preparedFor}</Muted>
            {doc.content.days.map((day, dayIndex) => (
              <View key={day.date} style={{ gap: space.sm }}>
                <Divider />
                <Heading>{day.label}</Heading>
                {day.items.map((item, i) => { const index = doc.content.days.slice(0, dayIndex).reduce((n, d) => n + d.items.length, 0) + i; return (
                  <View key={index} style={{ flexDirection: 'row', gap: space.md }}>
                    <Body style={{ color: color.accent, width: 52 }}>{item.time}</Body>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Body style={{ fontWeight: '500' }}>{item.title}</Body>
                      {item.detail ? <Muted>{item.detail}</Muted> : null}
                      {doc.booked?.[String(index)] ? <Body style={{ color: color.positive }}>Booked: {doc.booked[String(index)]}</Body> : item.book ? <Muted>To book: book the whole plan below, or tell QÉRA “{item.book}”</Muted> : null}
                    </View>
                  </View>
                ); })}
              </View>
            ))}
            <Divider />
            {doc.content.notes.map((note) => <Muted key={note}>{note}</Muted>)}
            <Divider />
            <Heading>Book the whole plan</Heading>
            <Muted>QÉRA books every bookable line at once, in your name, with the same checks as booking each yourself. You confirm first, and nothing is paid until you pay under Bookings.</Muted>
            <Choice label="Guests" options={[['1', '1'], ['2', '2'], ['4', '4'], ['6', '6']] as const} value={party} onChange={setParty} />
            <ActionError error={book.error} />
            {result ? result.lines.map((l) => <Muted key={l.index}>{l.ok ? '✓' : '·'} {l.title}: {l.text}</Muted>) : null}
            <Button label="Book the whole plan" busy={book.pending} onPress={() => { void bookAll(); }} />
            <Muted>To print this or save it as a PDF, open it in the Quintara web app.</Muted>
          </>
        )}
      </ResourceView>
    </Screen>
  );
}
