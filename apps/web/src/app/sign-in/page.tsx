'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@quintara/app-core';
import { ApiError } from '@quintara/app-core';

export default function SignInPage() {
  const router = useRouter();
  const { signIn, authMethod, requestCode } = useSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // With codes (production): first the address, then the code sent to it.
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (authMethod === 'code' && !codeSent) {
        if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new ApiError('validation', 'Enter a valid email address.');
        await requestCode(email.trim());
        setCodeSent(true);
        setPending(false);
        return;
      }
      await signIn(email.trim(), authMethod === 'code' ? code.trim() : undefined);
      router.push('/');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed. Try again.');
      setPending(false);
    }
  }

  return (
    <div className="split">
      <div>
        <h2>Sign in</h2>
        <p className="lede" style={{ marginTop: '1rem' }}>{authMethod === 'code' ? 'Members and guests sign in with their email address and a one-time code we send to it.' : 'Members and guests sign in with their email address.'}</p>
        {authMethod === 'dev' ? <p className="notice">Development build: the email address alone signs you in. In production a one-time code is sent to the address.</p> : null}
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} readOnly={codeSent} onChange={(event) => setEmail(event.target.value)} aria-invalid={error && !codeSent ? true : undefined} aria-describedby={error ? 'sign-in-error' : undefined} required />
        </label>
        {codeSent ? (
          <>
            <p className="muted" style={{ margin: 0 }} role="status">If {email.trim()} has a Quintara account, a six-digit code is on its way. It works for ten minutes.</p>
            <label>
              Code
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} aria-invalid={error ? true : undefined} aria-describedby={error ? 'sign-in-error' : undefined} autoFocus />
            </label>
          </>
        ) : null}
        {error ? <span className="field-error" id="sign-in-error" role="alert">{error}</span> : null}
        <div className="row">
          <button className="btn" disabled={pending || (codeSent && code.length !== 6)}>{pending ? 'One moment' : authMethod === 'code' && !codeSent ? 'Send me a code' : 'Sign in'}</button>
          {codeSent ? <button type="button" className="btn quiet" disabled={pending} onClick={() => { setCodeSent(false); setCode(''); setError(null); }}>Use another address</button> : null}
          <Link href="/apply">Not a member? Apply</Link>
        </div>
        <p className="muted">No account yet? <Link href="/join">Create a free guest account</Link> to talk to QÉRA and keep your details in one place.</p>
        <p className="muted" style={{ marginTop: '1.5rem' }}><a href="https://quintaralifestyle.com" target="_blank" rel="noopener noreferrer">About Quintara</a></p>
      </form>
    </div>
  );
}
