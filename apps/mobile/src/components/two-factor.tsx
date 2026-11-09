/**
 * Two-factor authentication in the mobile app: the second step of signing in, setting up an authenticator app on
 * this phone (or another), recovery codes, and the settings under Profile.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Linking, Pressable, Share, Text, View } from 'react-native';
import { toApiError } from '@quintara/api-client';
import { useAction, useResource, useSecondStep, useSession } from '@quintara/app-core';
import type { ApiError } from '@quintara/app-core';
import type { TwoFactorSetup } from '@quintara/domain';
import { ActionError, Body, Button, confirmThen, Field, Heading, Muted, Screen, Title } from '@/components/ui';
import { useTheme } from '@/theme';

const six = (value: string) => value.replace(/\D/g, '').slice(0, 6);

function ErrorText({ message }: { message: string | null }) {
  const { color, type } = useTheme();
  return message ? <Text accessibilityRole="alert" style={{ color: color.critical, fontSize: type.small.size }}>{message}</Text> : null;
}

/** Until the second step is done, it is all the app shows. */
export function SecondStepGate({ children }: { children: ReactNode }) {
  const { secondStep } = useSecondStep();
  if (!secondStep) return <>{children}</>;
  return <SecondStepScreen step={secondStep} />;
}

function SecondStepScreen({ step }: { step: 'verify' | 'enrol' }) {
  const { verify, cancel } = useSecondStep();
  const { space } = useTheme();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen>
      <View style={{ gap: space.md, paddingTop: space.xl }}>
        <Muted>Two-factor authentication</Muted>
        <Title>{step === 'verify' ? 'One more step' : 'Protect your account'}</Title>
        {step === 'enrol' ? (
          <>
            <Body>Every Quintara account is protected by a code from an authenticator app, as well as the code we email you. It takes a minute to set up.</Body>
            <Enrol />
          </>
        ) : (
          <>
            {recovery
              ? <Field label="One of your recovery codes" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} placeholder="xxxxx-xxxxx" />
              : <Field label="The six-digit code from your authenticator app" value={code} onChangeText={(v) => setCode(six(v))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" placeholder="000000" />}
            <ErrorText message={error} />
            <Button label="Continue" busy={pending} disabled={recovery ? code.trim().length < 10 : code.length !== 6} onPress={async () => {
              setPending(true); setError(null);
              try { await verify(code.trim()); } catch (caught) { setError(toApiError(caught).message); setCode(''); } finally { setPending(false); }
            }} />
            <Button quiet label={recovery ? 'Use my authenticator app' : 'Lost your phone? Use a recovery code'} onPress={() => { setRecovery(!recovery); setCode(''); setError(null); }} />
            <Muted>Lost your phone and your recovery codes? Contact the Quintara desk. Once we have confirmed who you are, we can reset it.</Muted>
          </>
        )}
        <Button quiet label="Sign out" onPress={() => { void cancel(); }} />
      </View>
    </Screen>
  );
}

/** Setting up an authenticator: open it in the app on this phone, or scan the QR code from another; confirm; keep the codes. */
export function Enrol({ currentCode, onDone }: { currentCode?: string; onDone?: () => void }) {
  const { beginSetup, confirmSetup, finish } = useSecondStep();
  const { space, radius } = useTheme();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => { setPending(true); setError(null); try { await work(); } catch (caught) { setError(toApiError(caught).message); } finally { setPending(false); } };
  if (codes) return <RecoveryCodes codes={codes} onDone={async () => { await finish(); onDone?.(); }} />;
  if (!setup) {
    return (
      <View style={{ gap: space.sm }}>
        <Body>1. Install an authenticator app if you need one: Google Authenticator, Microsoft Authenticator or 1Password.</Body>
        <Body>2. Add Quintara to it in the next step.</Body>
        <Body>3. Enter the code it shows, and keep your recovery codes safe.</Body>
        <ErrorText message={error} />
        <Button label="Set up my authenticator" busy={pending} onPress={() => run(async () => setSetup(await beginSetup(currentCode)))} />
      </View>
    );
  }
  return (
    <View style={{ gap: space.md }}>
      <Button label="Add to the authenticator on this phone" onPress={() => { void Linking.openURL(setup.otpauthUrl).catch(() => setError('No authenticator app was found on this phone. Install one, or scan the QR code from another phone.')); }} />
      {setup.qr ? (
        <View style={{ alignItems: 'center', gap: space.xs }}>
          <Muted>Or scan this with the authenticator on another phone:</Muted>
          <Image source={{ uri: setup.qr }} accessibilityLabel="QR code to add Quintara to an authenticator app" style={{ width: 200, height: 200, borderRadius: radius.sm, backgroundColor: '#fff' }} />
        </View>
      ) : null}
      <Muted>Or type this key into the app:</Muted>
      <Text selectable style={{ fontSize: 16, letterSpacing: 1 }}>{setup.secret}</Text>
      <Field label="The six-digit code your app now shows" value={code} onChangeText={(v) => setCode(six(v))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" placeholder="000000" />
      <ErrorText message={error} />
      <Button label="Confirm" busy={pending} disabled={code.length !== 6} onPress={() => run(async () => setCodes(await confirmSetup(code)))} />
    </View>
  );
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { space } = useTheme();
  const [kept, setKept] = useState(false);
  const text = `Quintara recovery codes\nEach works once, if you lose your phone.\n\n${codes.join('\n')}\n`;
  return (
    <View style={{ gap: space.md }}>
      <Heading>Your recovery codes</Heading>
      <Body>If you lose your phone, each of these lets you sign in once. Keep them somewhere safe and private, such as a password manager. They are shown only now.</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{codes.map((c) => <Text key={c} selectable style={{ width: '46%', fontSize: 16, letterSpacing: 1 }}>{c}</Text>)}</View>
      <Button quiet label="Save to a password manager or notes" onPress={() => { void Share.share({ message: text }); }} />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: kept }} onPress={() => setKept(!kept)} style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <Text style={{ fontSize: 20 }}>{kept ? '☑' : '☐'}</Text><Body>I have kept my recovery codes somewhere safe</Body>
      </Pressable>
      <Button label="Continue" disabled={!kept} onPress={onDone} />
    </View>
  );
}

/** Under Profile: on or off, new recovery codes, a new phone, turning it off where allowed, signing out everywhere. */
export function TwoFactorSettings() {
  const { space } = useTheme();
  const status = useResource((api) => api.getTwoFactor());
  const { signOut } = useSession();
  const [mode, setMode] = useState<'idle' | 'enrol' | 'codes' | 'move' | 'off'>('idle');
  const [code, setCode] = useState('');
  const [moveCode, setMoveCode] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const regenerate = useAction((api, c: string) => api.newRecoveryCodes(c));
  const disable = useAction(async (api, c: string) => { await api.disableTwoFactor(c); return true; });
  const everywhere = useAction(async (api) => { await api.signOutEverywhere(); return true; });
  const reset = () => { setMode('idle'); setCode(''); setMoveCode(null); setCodes(null); status.reload(); };
  const s = status.data;
  if (!s) return null;
  return (
    <View style={{ gap: space.sm }}>
      <Heading>Security</Heading>
      <Body>Two-factor authentication is {s.state === 'on' ? `on. ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft === 1 ? '' : 's'} left.` : 'off.'}</Body>
      {codes ? <RecoveryCodes codes={codes} onDone={reset} /> : null}
      {!codes && mode === 'idle' ? (s.state !== 'on' ? <Button quiet label="Set up two-factor" onPress={() => setMode('enrol')} /> : (
        <>
          <Button quiet label="New recovery codes" onPress={() => setMode('codes')} />
          <Button quiet label="Move to a new phone" onPress={() => setMode('move')} />
          {!s.required ? <Button quiet label="Turn off two-factor" onPress={() => setMode('off')} /> : null}
        </>
      )) : null}
      {mode === 'enrol' ? <Enrol onDone={reset} /> : null}
      {!codes && (mode === 'codes' || mode === 'off' || (mode === 'move' && !moveCode)) ? (
        <>
          <Field label="The code now showing in your authenticator app" value={code} onChangeText={(v) => setCode(six(v))} keyboardType="number-pad" textContentType="oneTimeCode" placeholder="000000" />
          <ActionError error={(regenerate.error ?? disable.error) as ApiError | null} />
          <Button label={mode === 'codes' ? 'Make new codes' : mode === 'move' ? 'Continue' : 'Turn off'} disabled={code.length !== 6} busy={regenerate.pending || disable.pending} onPress={async () => {
            if (mode === 'move') { setMoveCode(code); return; }
            if (mode === 'codes') { const r = await regenerate.run(code); if (r) setCodes(r.recoveryCodes); return; }
            confirmThen('Turn off two-factor?', 'Signing in will need only the code we email you.', 'Turn off', async () => { if (await disable.run(code)) reset(); }, true);
          }} />
          <Button quiet label="Cancel" onPress={reset} />
        </>
      ) : null}
      {mode === 'move' && moveCode ? <Enrol currentCode={moveCode} onDone={reset} /> : null}
      <Muted>Signed in on a device you no longer have? Sign out everywhere, then sign in again here.</Muted>
      <ActionError error={everywhere.error as ApiError | null} />
      <Button quiet label="Sign out everywhere" busy={everywhere.pending} onPress={() => confirmThen('Sign out everywhere?', 'Quintara signs out on every device, including this one.', 'Sign out everywhere', async () => { if (await everywhere.run()) await signOut().catch(() => undefined); }, true)} />
    </View>
  );
}
