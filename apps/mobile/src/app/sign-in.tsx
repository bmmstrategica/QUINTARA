import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable } from 'react-native';
import { ApiError, useSession } from '@quintara/app-core';
import { Button, Field, Muted, Screen, Title } from '@/components/ui';

export default function SignInScreen() {
  const router = useRouter();
  const { signIn, authMethod, requestCode } = useSession();
  const [code, setCode] = useState('');
  // Production: the address, then the one-time code sent to it.
  const [codeSent, setCodeSent] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    setError(undefined);
    try {
      if (authMethod === 'code' && !codeSent) {
        if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new ApiError('validation', 'Enter a valid email address.');
        await requestCode(email.trim());
        setCodeSent(true);
        setPending(false);
        return;
      }
      await signIn(email.trim(), authMethod === 'code' ? code : undefined);
      router.back();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed. Try again.');
      setPending(false);
    }
  }

  return (
    <Screen>
      <Title>Sign in</Title>
      <Muted>{authMethod === 'code' ? 'Enter the email address of your membership or guest account, and we will send you a one-time code.' : 'Enter the email address of your membership or your guest account.'}</Muted>
      <Field label="Email" value={email} onChangeText={setEmail} editable={!codeSent} error={codeSent ? undefined : error} keyboardType="email-address" autoCapitalize="none" autoComplete="email" autoCorrect={false} returnKeyType="go" onSubmitEditing={submit} />
      {codeSent ? <Muted>If {email.trim()} has a Quintara account, a six-digit code is on its way. It works for ten minutes.</Muted> : null}
      {codeSent ? <Field label="Code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} error={error} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="go" onSubmitEditing={submit} /> : null}
      <Button label={authMethod === 'code' && !codeSent ? 'Send me a code' : 'Sign in'} busy={pending} disabled={codeSent && code.length !== 6} onPress={submit} />
      {codeSent ? <Button quiet label="Use another address" onPress={() => { setCodeSent(false); setCode(''); setError(undefined); }} /> : null}
      <Button quiet label="Create a free guest account" onPress={() => router.replace('/join')} />
      <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL('https://quintaralifestyle.com'); }} style={{ alignSelf: 'center', marginTop: 24, padding: 8 }}>
        <Muted style={{ textDecorationLine: 'underline' }}>About Quintara</Muted>
      </Pressable>
    </Screen>
  );
}
