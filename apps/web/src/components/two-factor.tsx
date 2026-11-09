'use client';

/**
 * Two-factor authentication in the web app: the second step of signing in, setting up an authenticator app,
 * recovery codes, and the settings on the profile and account pages.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toApiError } from '@quintara/api-client';
import { useAction, useResource, useSecondStep, useSession } from '@quintara/app-core';
import type { TwoFactorSetup } from '@quintara/domain';
import { ActionError } from '@/components/states';

const digits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

/** Until the second step is done, it is all the app shows. */
export function SecondStepGate({ children }: { children: ReactNode }) {
  const { secondStep } = useSecondStep();
  if (!secondStep) return <>{children}</>;
  return <SecondStep step={secondStep} />;
}

function SecondStep({ step }: { step: 'verify' | 'enrol' }) {
  const { verify, cancel } = useSecondStep();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (step === 'enrol') {
    return (
      <div className="auth-step">
        <p className="eyebrow">Two-factor authentication</p>
        <h2>Protect your account</h2>
        <p className="lede">Every Quintara account is protected by a second step: a code from an authenticator app on your phone, as well as the code we email you. It takes a minute to set up.</p>
        <EnrolFlow />
        <button className="link" onClick={() => cancel()}>Sign out</button>
      </div>
    );
  }
  return (
    <form className="auth-step" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true); setError(null);
      try { await verify(code.trim()); } catch (caught) { setError(toApiError(caught).message); setCode(''); } finally { setPending(false); }
    }}>
      <p className="eyebrow">Two-factor authentication</p>
      <h2>One more step</h2>
      {recovery ? (
        <label>One of your recovery codes<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="xxxxx-xxxxx" autoFocus /></label>
      ) : (
        <label>The six-digit code from your authenticator app<input className="code-input" value={code} onChange={(event) => setCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus /></label>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn" disabled={pending || (recovery ? code.trim().length < 10 : code.length !== 6)}>{pending ? 'Checking' : 'Continue'}</button>
      <button type="button" className="link" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>{recovery ? 'Use the code from my authenticator app' : 'I have lost my phone: use a recovery code'}</button>
      <p className="muted" style={{ fontSize: '0.9rem' }}>Lost your phone and your recovery codes? Contact the Quintara desk: once we have confirmed who you are, we can reset it.</p>
      <button type="button" className="link" onClick={() => cancel()}>Sign out</button>
    </form>
  );
}

/** Setting up an authenticator: scan, confirm with the first code, keep the recovery codes. */
export function EnrolFlow({ currentCode, onDone }: { currentCode?: string; onDone?: () => void }) {
  const { beginSetup, confirmSetup, finish } = useSecondStep();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => { setPending(true); setError(null); try { await work(); } catch (caught) { setError(toApiError(caught).message); } finally { setPending(false); } };

  if (codes) return <RecoveryCodes codes={codes} onDone={async () => { await finish(); onDone?.(); }} />;
  if (!setup) {
    return (
      <div className="stack">
        <ol className="how">
          <li>Install an authenticator app if you do not have one: Google Authenticator, Microsoft Authenticator or 1Password.</li>
          <li>Add Quintara to it with the QR code we show you next.</li>
          <li>Enter the six-digit code it shows, and keep your recovery codes somewhere safe.</li>
        </ol>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending} onClick={() => run(async () => setSetup(await beginSetup(currentCode)))}>{pending ? 'One moment' : 'Set up my authenticator'}</button></div>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={(event) => { event.preventDefault(); void run(async () => setCodes(await confirmSetup(code))); }}>
      <div className="qr-row">
        {setup.qr ? <img className="qr" src={setup.qr} alt="QR code to add Quintara to your authenticator app" width={200} height={200} /> : null}
        <div className="stack">
          <p>Scan the code with your authenticator app. On this phone? <a href={setup.otpauthUrl}>Open it in your authenticator app</a>.</p>
          <p className="muted">Or type this key into the app:</p>
          <code className="secret" aria-label="Setup key">{setup.secret}</code>
        </div>
      </div>
      <label>The six-digit code your app now shows<input className="code-input" value={code} onChange={(event) => setCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div><button className="btn" disabled={pending || code.length !== 6}>{pending ? 'Checking' : 'Confirm'}</button></div>
    </form>
  );
}

/** Recovery codes, shown once: copy, download or print, and confirm they are kept before going on. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Quintara recovery codes\nEach works once, if you lose your phone.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    Object.assign(document.createElement('a'), { href: url, download: 'quintara-recovery-codes.txt' }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack">
      <h3>Your recovery codes</h3>
      <p>If you lose your phone, each of these lets you sign in once. Keep them somewhere safe and private, such as a password manager. They are shown only now.</p>
      <ul className="recovery-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="row">
        <button type="button" className="btn quiet small" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* the codes stay on screen to copy by hand */ } }}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn quiet small" onClick={download}>Download</button>
        <button type="button" className="btn quiet small" onClick={() => window.print()}>Print</button>
      </div>
      <label className="check"><input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} /> I have kept my recovery codes somewhere safe</label>
      <div><button className="btn" disabled={!kept} onClick={onDone}>Continue</button></div>
    </div>
  );
}

/** The settings: on or off, new recovery codes, a new phone, turning it off where allowed, and signing out everywhere. */
export function TwoFactorSettings() {
  const status = useResource((api) => api.getTwoFactor());
  const { signOut } = useSession();
  const [mode, setMode] = useState<'idle' | 'enrol' | 'move' | 'codes' | 'off'>('idle');
  const [code, setCode] = useState('');
  const [moveCode, setMoveCode] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const regenerate = useAction((api, c: string) => api.newRecoveryCodes(c));
  const disable = useAction(async (api, c: string) => { await api.disableTwoFactor(c); return true; });
  const everywhere = useAction(async (api) => { await api.signOutEverywhere(); return true; });
  const reset = () => { setMode('idle'); setCode(''); setMoveCode(null); setCodes(null); status.reload(); };
  const s = status.data;
  return (
    <section className="panel stack" aria-label="Security">
      <h3>Security</h3>
      {!s ? <p className="muted">Loading</p> : (
        <>
          <p><strong style={{ fontWeight: 500 }}>Two-factor authentication: {s.state === 'on' ? 'on' : 'off'}.</strong> {s.state === 'on' ? `Since ${new Date(s.enabledAt!).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}. ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft === 1 ? '' : 's'} left.` : 'Add a code from an authenticator app to every sign-in.'}</p>
          {codes ? <RecoveryCodes codes={codes} onDone={reset} /> : null}
          {!codes && mode === 'idle' ? (
            <div className="row">
              {s.state !== 'on' ? <button className="btn quiet small" onClick={() => setMode('enrol')}>Set up</button> : (
                <>
                  <button className="btn quiet small" onClick={() => setMode('codes')}>New recovery codes</button>
                  <button className="btn quiet small" onClick={() => setMode('move')}>Move to a new phone</button>
                  {!s.required ? <button className="btn quiet small" onClick={() => setMode('off')}>Turn off</button> : null}
                </>
              )}
            </div>
          ) : null}
          {mode === 'enrol' ? <EnrolFlow onDone={reset} /> : null}
          {(mode === 'codes' || mode === 'off' || (mode === 'move' && !moveCode)) && !codes ? (
            <form className="stack" onSubmit={async (event) => {
              event.preventDefault();
              if (mode === 'move') setMoveCode(code);
              if (mode === 'codes') { const r = await regenerate.run(code); if (r) setCodes(r.recoveryCodes); }
              if (mode === 'off' && window.confirm('Turn off two-factor authentication? Signing in will need only the code we email you.') && (await disable.run(code))) reset();
            }}>
              <label>The code now showing in your authenticator app<input className="code-input" value={code} onChange={(event) => setCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
              <ActionError error={regenerate.error ?? disable.error} />
              <div className="row">
                <button className="btn small" disabled={code.length !== 6 || regenerate.pending || disable.pending}>{mode === 'codes' ? 'Make new codes' : mode === 'move' ? 'Continue' : 'Turn off'}</button>
                <button type="button" className="link" onClick={reset}>Cancel</button>
              </div>
              {mode === 'codes' ? <p className="muted" style={{ fontSize: '0.9rem' }}>Your old recovery codes stop working.</p> : null}
            </form>
          ) : null}
          {mode === 'move' && moveCode ? <EnrolFlow currentCode={moveCode} onDone={reset} /> : null}
          <hr />
          <p className="muted">Signed in on a device you no longer have? Sign out everywhere, then sign in again here.</p>
          <ActionError error={everywhere.error} />
          <div><button className="btn quiet small" disabled={everywhere.pending} onClick={async () => { if (window.confirm('Sign out of Quintara on every device, including this one?') && (await everywhere.run())) await signOut().catch(() => undefined); }}>Sign out everywhere</button></div>
        </>
      )}
      {status.error ? <p className="error" role="alert">{status.error.message}</p> : null}
    </section>
  );
}
