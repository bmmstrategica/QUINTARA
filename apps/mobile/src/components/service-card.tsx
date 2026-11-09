import { useState } from 'react';
import { View } from 'react-native';
import { useAction } from '@quintara/app-core';
import { leadTimeLabel, packagePriceLabel } from '@quintara/domain';
import type { LifestyleService } from '@quintara/domain';
import { ActionError, Body, Button, Choice, Divider, Field, Muted } from '@/components/ui';

/** A service's packages and a request to book it; the request goes to the concierge desk. */
export function ServiceCard({ service, onRequested }: { service: LifestyleService; onRequested: () => void }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [preferredDate, setPreferredDate] = useState('');
  const [notes, setNotes] = useState('');
  const [packageId, setPackageId] = useState(service.packages[0]?.id ?? '');
  const chosen = service.packages.find((p) => p.id === packageId);
  const request = useAction((api) => api.requestLifestyleService(service.id, { preferredDate: preferredDate || null, notes, packageId: packageId || null }));
  return (
    <View style={{ gap: 6 }}>
      {service.packages.map((p) => <Muted key={p.id}>{p.name}{p.duration ? `, ${p.duration}` : ''}: {packagePriceLabel(p)}. {leadTimeLabel(p.leadTimeHours)}.</Muted>)}
      {service.packages.length ? <Muted style={{ fontSize: 12 }}>Prices are indicative; the provider confirms the final price.</Muted> : null}
      {sent ? <Muted>Your request is with the concierge desk. Follow it under Your requests.</Muted> : null}
      {open ? (
        <>
          {service.packages.length > 1 ? <Choice label="Package" options={service.packages.map((p) => [p.id, p.name] as const)} value={packageId} onChange={setPackageId} /> : null}
          {chosen && chosen.leadTimeHours > 0 ? <Muted>{chosen.name} needs {leadTimeLabel(chosen.leadTimeHours).toLowerCase()}.</Muted> : null}
          <Field label="Preferred date (optional, YYYY-MM-DD)" value={preferredDate} onChangeText={setPreferredDate} maxLength={10} error={request.error?.fields?.preferredDate} />
          <Field label="What you have in mind" value={notes} onChangeText={setNotes} maxLength={1000} multiline />
          <ActionError error={request.error} />
          <Button label="Send request" busy={request.pending} onPress={async () => { if (await request.run()) { setOpen(false); setSent(true); setNotes(''); setPreferredDate(''); onRequested(); } }} />
          <Button quiet label="Cancel" onPress={() => setOpen(false)} />
        </>
      ) : <Button quiet label="Ask to book" onPress={() => { setSent(false); setOpen(true); }} />}
      <Divider />
    </View>
  );
}
