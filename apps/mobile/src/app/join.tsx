import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ApiError, useSession } from '@quintara/app-core';
import { guestAccountSchema } from '@quintara/domain';
import { Button, Choice, Field, Muted, Screen, Title } from '@/components/ui';
import { useSection } from '@/components/section-copy';

/** A free personal account for guests: QÉRA for up to five hours a day, with the way to membership one tap away. */
export default function JoinScreen() {
  const router = useRouter();
  const { createGuestAccount, authMethod, requestCode } = useSession();
  const [code, setCode] = useState('');
  // Production: the address is proved with a code before the account is made.
  const [codeSent, setCodeSent] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState<'no' | 'yes'>('no');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const intro = useSection('guest');

  async function submit() {
    const parsed = guestAccountSchema.safeParse({ fullName, email: email.trim() });
    const found: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
    if (agreed !== 'yes') found.agreed = 'Please agree to continue';
    setErrors(found);
    if (Object.keys(found).length) return;
    setPending(true);
    try {
      if (authMethod === 'code' && !codeSent) {
        await requestCode(email.trim(), 'join');
        setCodeSent(true);
        setPending(false);
        return;
      }
      await createGuestAccount({ fullName, email: email.trim(), ...(authMethod === 'code' ? { code } : {}) });
      router.replace('/qera');
    } catch (caught) {
      setErrors(caught instanceof ApiError ? { ...caught.fields, form: caught.message } : { form: 'That did not work. Try again.' });
      setPending(false);
    }
  }

  return (
    <Screen>
      <Title>Create a guest account</Title>
      <Muted>{intro.description} Membership is separate and by application.</Muted>
      <Field label="Full name" value={fullName} onChangeText={setFullName} error={errors.fullName} autoComplete="name" />
      <Field label="Email" value={email} onChangeText={setEmail} error={errors.email ?? errors.form} keyboardType="email-address" autoCapitalize="none" autoComplete="email" autoCorrect={false} />
      <Choice label="Quintara keeps my name, email and conversations with QÉRA to run my account. I can download or delete them at any time." options={[['yes', 'I agree'], ['no', 'Not yet']] as const} value={agreed} onChange={setAgreed} />
      {errors.agreed ? <Muted>{errors.agreed}</Muted> : null}
      {codeSent ? <Muted>We have sent a six-digit code to {email.trim()}. It works for ten minutes.</Muted> : null}
      {codeSent ? <Field label="Code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} error={errors.code} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" /> : null}
      <Button label={authMethod === 'code' && !codeSent ? 'Send me a code' : 'Create account'} busy={pending} disabled={codeSent && code.length !== 6} onPress={submit} />
      <Button quiet label="I already have an account" onPress={() => router.replace('/sign-in')} />
    </Screen>
  );
}
