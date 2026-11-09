'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, useSession } from '@quintara/app-core';
import { guestAccountSchema } from '@quintara/domain';
import { useSection } from '@/components/section-copy';

/** A personal account for guests: no membership, a daily allowance with QÉRA, and an easy path to apply. */
export default function JoinPage() {
  const router = useRouter();
  const { session, guest, createGuestAccount, authMethod, requestCode } = useSession();
  // In production the address is proved with a code before the account is made.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const intro = useSection('guest');

  if (session) return <div className="state"><h2>You are a member</h2><p className="lede">Your membership already includes everything a guest account offers.</p><Link className="btn" href="/">Home</Link></div>;
  if (guest) return <div className="state"><h2>You have a guest account</h2><p className="lede">Signed in as {guest.fullName}.</p><div className="row"><Link className="btn" href="/qera">Talk to QÉRA</Link><Link className="btn quiet" href="/account">Your account</Link></div></div>;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = guestAccountSchema.safeParse({ fullName, email });
    const found: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= issue.message;
    if (!agreed) found.agreed = 'Please agree to continue';
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
      await createGuestAccount({ fullName, email, ...(authMethod === 'code' ? { code } : {}) });
      router.push('/qera');
    } catch (caught) {
      setErrors(caught instanceof ApiError ? { ...caught.fields, form: caught.message } : { form: 'That did not work. Try again.' });
      setPending(false);
    }
  }

  const field = (key: 'fullName' | 'email', label: string, value: string, set: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      {label}
      <input {...props} value={value} onChange={(event) => set(event.target.value)} aria-invalid={errors[key] ? true : undefined} aria-describedby={errors[key] ? `${key}-error` : undefined} />
      {errors[key] ? <span className="field-error" id={`${key}-error`} role="alert">{errors[key]}</span> : null}
    </label>
  );

  return (
    <div className="split">
      <div>
        <h2>Create a guest account</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{intro.description}</p>
        <p className="muted">Membership is separate and by application. You can apply at any time from your account.</p>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        {field('fullName', 'Full name', fullName, setFullName, { autoComplete: 'name' })}
        {field('email', 'Email', email, setEmail, { type: 'email', autoComplete: 'email' })}
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} aria-invalid={errors.agreed ? true : undefined} />{' '}
          I agree that Quintara keeps my name, email and my conversations with QÉRA to run my account. I can download or delete them at any time.
        </label>
        {errors.agreed ? <span className="field-error" role="alert">{errors.agreed}</span> : null}
        {codeSent ? (
          <>
            <p className="muted" style={{ margin: 0 }} role="status">We have sent a six-digit code to {email.trim()}. It works for ten minutes. If the address already has an account, sign in instead.</p>
            <label>
              Code
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} aria-invalid={errors.code ? true : undefined} autoFocus />
              {errors.code ? <span className="field-error" role="alert">{errors.code}</span> : null}
            </label>
          </>
        ) : null}
        {errors.form && !errors.code ? <p className="field-error" role="alert">{errors.form}</p> : null}
        <div className="row">
          <button className="btn" disabled={pending || (codeSent && code.length !== 6)}>{pending ? 'One moment' : authMethod === 'code' && !codeSent ? 'Send me a code' : 'Create account'}</button>
          <Link href="/sign-in">I already have an account</Link>
        </div>
      </form>
    </div>
  );
}
