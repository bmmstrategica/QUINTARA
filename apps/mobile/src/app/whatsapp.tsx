import { useEffect, useState } from 'react';
import { Linking, Text } from 'react-native';
import { useAction, useResource } from '@quintara/app-core';
import type { WhatsAppLink } from '@quintara/domain';
import { ActionError, Body, Button, Choice, confirmThen, Divider, Heading, Muted, ResourceView, Screen, Tag } from '@/components/ui';
import { useTheme } from '@/theme';

/** QÉRA on WhatsApp: link a number by sending a one-time code from it, and unlink it at any time. */
export default function WhatsAppScreen() {
  const state = useResource((api) => api.getWhatsApp());
  const [started, setStarted] = useState<WhatsAppLink | null>(null);
  // While a code is waiting to be sent, check every few seconds whether it has arrived.
  useEffect(() => {
    if (!started || started.status === 'linked') return;
    const timer = setInterval(() => { state.reload(); }, 4000);
    return () => clearInterval(timer);
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state.data?.status === 'linked' && started?.status === 'pending') setStarted(null); }, [state.data, started]);
  return (
    <Screen onRefresh={state.reload} refreshing={state.status === 'loading'}>
      <Heading>QÉRA on WhatsApp</Heading>
      <Muted>Write to QÉRA from WhatsApp as you do here: ask, plan and book, in the same conversation. QÉRA asks before it does anything, and acts only when you tap Confirm.</Muted>
      <ResourceView resource={state}>
        {(current) => !current.available ? <Muted>QÉRA on WhatsApp is not available yet.</Muted>
          : current.status === 'linked' && !started ? <Linked link={current} onChanged={() => { setStarted(null); state.reload(); }} onRelink={setStarted} />
          : started ? <Waiting link={started} onRestart={setStarted} /> : <Start onStarted={setStarted} />}
      </ResourceView>
      <Divider />
      <Muted>Only a number that has sent its code is linked, and Quintara never writes to a number first. QÉRA on WhatsApp has exactly what you have in the app. Your number is stored encrypted and shown only by its last four digits. Messages travel through WhatsApp, which is run by Meta. Reply STOP on WhatsApp, or unlink here, and QÉRA stops answering at once.</Muted>
    </Screen>
  );
}

function Start({ onStarted }: { onStarted: (link: WhatsAppLink) => void }) {
  const [consent, setConsent] = useState<'yes' | 'no'>('no');
  const start = useAction((api) => api.linkWhatsApp({ consent: (consent === 'yes') as true }));
  return (
    <>
      <Choice label="I agree to talk to QÉRA on WhatsApp, and that my messages travel through WhatsApp, run by Meta" options={[['yes', 'I agree'], ['no', 'Not yet']] as const} value={consent} onChange={setConsent} />
      {start.error?.fields?.consent ? <Muted>Please agree to continue.</Muted> : null}
      <ActionError error={start.error?.code === 'validation' ? null : start.error} />
      <Button label="Link my WhatsApp" busy={start.pending} onPress={async () => { const link = await start.run(); if (link) onStarted(link); }} />
    </>
  );
}

function Waiting({ link, onRestart }: { link: WhatsAppLink; onRestart: (link: WhatsAppLink) => void }) {
  const { color, displayFont } = useTheme();
  const again = useAction((api) => api.linkWhatsApp({ consent: true }));
  return (
    <>
      <Body>Send this from your WhatsApp to Quintara on {link.businessNumber}:</Body>
      <Text accessibilityLabel={`Your code is ${link.code?.split('').join(' ')}`} style={{ fontFamily: displayFont, fontSize: 34, letterSpacing: 2, color: color.ink }}>{link.message}</Text>
      <Muted>The code works once, for fifteen minutes. This screen updates when it arrives.</Muted>
      {link.openUrl ? <Button label="Open WhatsApp" onPress={() => { void Linking.openURL(link.openUrl!); }} /> : null}
      <Button quiet label="New code" busy={again.pending} onPress={async () => { const next = await again.run(); if (next) onRestart(next); }} />
      <ActionError error={again.error} />
    </>
  );
}

function Linked({ link, onChanged, onRelink }: { link: WhatsAppLink; onChanged: () => void; onRelink: (link: WhatsAppLink) => void }) {
  const unlink = useAction(async (api) => { await api.unlinkWhatsApp(); return true; });
  const change = useAction((api) => api.linkWhatsApp({ consent: true }));
  return (
    <>
      <Tag tone="positive" label="Linked" />
      <Body>Your number ending {link.numberMasked?.slice(-4)}. Write to Quintara on {link.businessNumber}.</Body>
      {link.businessNumber ? <Button label="Open WhatsApp" onPress={() => { void Linking.openURL(`https://wa.me/${link.businessNumber!.replace(/\D/g, '')}`); }} /> : null}
      <Button quiet label="Use another number" busy={change.pending} onPress={async () => { const next = await change.run(); if (next) onRelink(next); }} />
      <Button quiet label="Unlink" busy={unlink.pending} onPress={() => confirmThen('Unlink your WhatsApp?', 'QÉRA stops answering that number at once.', 'Unlink', async () => { if (await unlink.run()) onChanged(); }, true)} />
      <ActionError error={unlink.error ?? change.error} />
    </>
  );
}
