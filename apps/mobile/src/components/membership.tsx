/**
 * Membership: the plan, when the term ends, automatic renewal, the saved card and past payments. Also the screen a
 * lapsed member sees in place of the app, from which they renew.
 *
 * The card is typed into the payment provider's own secure form; the app only ever passes on the provider's
 * one-time setup token. While payments are the stand-in, the test cards are offered instead.
 */
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { useAction, useResource, useSession } from '@quintara/app-core';
import type { ApiError } from '@quintara/app-core';
import { formatMoney, RENEWAL_GRACE_DAYS, TEST_CARDS } from '@quintara/domain';
import type { MembershipStatus } from '@quintara/domain';
import { ActionError, Body, Button, confirmThen, Divider, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { Toggle } from '@/components/push';
import { useTheme } from '@/theme';
import { openWeb } from '@/web-link';

/**
 * On iPhone, card changes and renewal payments are made in the web app, as the membership fee is (Apple's rules on
 * payments in apps; see RELEASE.md). The iPhone app shows the membership and links there. Android takes them here.
 */
const PAY_HERE = Platform.OS !== 'ios';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
const STATE: Record<MembershipStatus['state'], [label: string, tone: 'neutral' | 'accent' | 'positive' | 'critical']> = {
  active: ['Active', 'positive'], renewal_due: ['Renews soon', 'accent'], grace: ['Payment needed', 'critical'], lapsed: ['Ended', 'critical'],
};

export function MembershipPanel({ onRenewed }: { onRenewed?: () => void }) {
  const membership = useResource((api) => api.getMembership());
  // Kept here, so the message survives the panel reloading after a change.
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      {done ? <Muted accessibilityRole="alert">{done}</Muted> : null}
      <ResourceView resource={membership}>
        {(m) => <MembershipDetail m={m} onChanged={membership.reload} onRenewed={onRenewed} setDone={setDone} />}
      </ResourceView>
    </>
  );
}

function MembershipDetail({ m, onChanged, onRenewed, setDone }: { m: MembershipStatus; onChanged: () => void; onRenewed?: () => void; setDone: (message: string | null) => void }) {
  const { space } = useTheme();
  const config = useResource((api) => api.getPaymentConfig());
  const [adding, setAdding] = useState(false);
  const save = useAction((api, token: string) => api.saveCard(token));
  const remove = useAction((api) => api.removeCard());
  const auto = useAction((api, on: boolean) => api.setAutoRenew(on));
  const [key] = useState(() => `renew-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const renew = useAction((api) => api.renewMembership(key));
  const price = formatMoney(m.priceMinor, m.currency);
  const after = async (result: unknown, message: string) => { if (result) { setDone(message); onChanged(); } };
  const error = (save.error ?? remove.error ?? auto.error ?? renew.error) as ApiError | null;
  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Heading>{m.tierName}</Heading><Tag tone={STATE[m.state][1]} label={STATE[m.state][0]} />
      </View>
      <Body>
        {m.state === 'lapsed' ? `Your membership ended${m.termEndsAt ? ` on ${day(m.termEndsAt)}` : ''}. Renew to pick up where you left off: your profile, bookings and messages are kept.`
          : m.state === 'grace' ? `Your term ended on ${day(m.termEndsAt!)}. Your membership continues until ${day(m.graceEndsAt!)} while the renewal is completed.`
          : m.termEndsAt ? `${m.autoRenew ? 'Renews' : 'Ends'} on ${day(m.termEndsAt)}. ${price} for ${m.termMonths} month${m.termMonths === 1 ? '' : 's'}.`
          : 'Your membership has no end date.'}
      </Body>
      {m.lastFailure && m.state !== 'active' ? <Body accessibilityRole="alert">The last renewal did not go through: {m.lastFailure}{m.nextAttemptAt ? ` We will try again on ${day(m.nextAttemptAt)}.` : ''}</Body> : null}
      <ActionError error={error} />

      {!PAY_HERE ? (
        <>
          <Body>{m.autoRenew ? `Automatic renewal is on${m.card ? `, with your ${m.card.brand} ending ${m.card.last4}` : ''}.` : 'Automatic renewal is off.'}</Body>
          <Button label={m.canRenewNow ? 'Renew in the Quintara web app' : 'Manage renewal and card in the web app'} onPress={() => { void openWeb('/profile#membership'); }} />
          <Muted>Card changes and renewal payments are made in the Quintara web app.</Muted>
        </>
      ) : null}
      {PAY_HERE && m.termMonths ? (
        <Toggle label="Renew automatically" on={m.autoRenew}
          detail={m.autoRenew ? `${price} will be charged to your card on ${m.termEndsAt ? day(m.termEndsAt) : 'the renewal date'}. We remind you 30 and 7 days before.` : 'You will be reminded before your membership ends, and renew yourself.'}
          onChange={(on) => {
            if (on && !m.card) { setAdding(true); return; }
            confirmThen(on ? 'Renew automatically?' : 'Turn off automatic renewal?',
              on ? `At the end of each term, ${price} will be charged to your ${m.card!.brand} ending ${m.card!.last4}. You can turn this off at any time before.` : `Your membership will end on ${m.termEndsAt ? day(m.termEndsAt) : 'the renewal date'} unless you renew it.`,
              on ? 'Renew automatically' : 'Turn off', async () => { await after(await auto.run(on), on ? 'Automatic renewal is on.' : 'Automatic renewal is off.'); }, !on);
          }} />
      ) : null}

      {PAY_HERE ? <>
      <Divider />
      <Heading>Card</Heading>
      {m.card ? (
        <>
          <Body>{m.card.brand} ending {m.card.last4}, expires {String(m.card.expMonth).padStart(2, '0')}/{String(m.card.expYear).slice(-2)}</Body>
          {m.card.expired ? <Body accessibilityRole="alert">This card has expired. Add a new one.</Body> : m.card.expiresBeforeRenewal ? <Muted>This card expires before your renewal date. Add a new one.</Muted> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button quiet label="Replace card" onPress={() => setAdding(true)} />
            <Button quiet label="Remove card" busy={remove.pending} onPress={() => confirmThen('Remove this card?', `It is deleted here and at the payment provider.${m.autoRenew ? ' Automatic renewal stops.' : ''}`, 'Remove', async () => { await after(await remove.run(), 'The card has been removed.'); }, true)} />
          </View>
        </>
      ) : <Muted>No card saved. Quintara never sees your card number: it is kept by the payment provider.</Muted>}
      {adding || !m.card ? (
        config.data?.testCards ? (
          <View style={{ gap: space.xs }}>
            <Muted>Test cards (the real card form appears once payments are connected):</Muted>
            {TEST_CARDS.map((c) => <Button key={c.setupToken} quiet label={c.label} busy={save.pending} onPress={async () => { await after(await save.run(c.setupToken), 'Card saved.'); setAdding(false); }} />)}
          </View>
        ) : config.data ? (
          <Button quiet label="Add a card on the secure page" onPress={() => { void openWeb('/profile#membership'); }} />
        ) : null
      ) : null}

      </> : null}
      {PAY_HERE && m.canRenewNow && m.card ? (
        <Button label={`Renew now for ${price}`} busy={renew.pending} onPress={() => confirmThen('Renew your membership?', `${price} will be charged to your ${m.card!.brand} ending ${m.card!.last4}${m.state === 'lapsed' ? '. Your new term starts today.' : '. Your new term starts when the current one ends.'}`, 'Renew', async () => {
          const r = await renew.run();
          if (r) { setDone(`Renewed until ${day(r.termEndsAt!)}. Thank you.`); onChanged(); onRenewed?.(); }
        })} />
      ) : null}

      {m.history.length ? (
        <>
          <Divider />
          <Heading>Payments</Heading>
          {m.history.slice(0, 8).map((p) => <Muted key={p.id}>{day(p.at)}: {formatMoney(p.amountMinor, p.currency)}, {p.status === 'paid' ? `paid${p.periodEnd ? `, to ${day(p.periodEnd)}` : ''}` : p.status === 'failed' ? `declined${p.reason ? ` (${p.reason.replace(/\.$/, '')})` : ''}` : p.status}</Muted>)}
        </>
      ) : null}
      <Muted>Membership continues for {RENEWAL_GRACE_DAYS} days after the end of a term while a renewal is completed.</Muted>
    </View>
  );
}

/** For a member whose membership has lapsed: this screen in place of the app, until they renew or sign out. */
export function LapsedScreen() {
  const { refresh, signOut } = useSession();
  return (
    <Screen>
      <Title>Welcome back</Title>
      <MembershipPanel onRenewed={() => { void refresh(); }} />
      <Button quiet label="Sign out" onPress={() => { void signOut(); }} />
    </Screen>
  );
}
