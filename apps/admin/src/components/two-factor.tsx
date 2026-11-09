'use client';

/**
 * Two-factor for staff: the second step of signing in to the console, setting up an authenticator app,
 * and recovery codes. Every admin console account must use it.
 */
import { useState } from 'react';
import { toApiError } from '@quintara/api-client';
import type { AdminApi } from '@quintara/api-client';
import type { TwoFactorSetup } from '@quintara/domain';

const digits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

/** The second step at sign-in: the code from the authenticator (or a recovery code), or setting one up. */
export function SecondStep({ api, step, onDone, onCancel }: { api: AdminApi; step: 'verify' | 'enrol'; onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (step === 'enrol') {
    return (
      <div className="gate"><div className="gate-card">
        <img src="/quintara-emblem.png" alt="Quintara" style={{ width: 56 }} />
        <h1>Set up two-factor</h1>
        <p className="lede">Every admin console account is protected by a code from an authenticator app on your phone, as well as the code we email you.</p>
        <Enrol api={api} onDone={onDone} />
        <button className="link" onClick={onCancel}>Sign out</button>
      </div></div>
    );
  }
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={async (event) => {
        event.preventDefault(); setPending(true); setError(null);
        try { await api.verifyTwoFactor(code.trim()); onDone(); } catch (caught) { setError(toApiError(caught).message); setCode(''); if (toApiError(caught).code === 'unauthenticated') onCancel(); } finally { setPending(false); }
      }}>
        <img src="/quintara-emblem.png" alt="Quintara" style={{ width: 56 }} />
        <h1>One more step</h1>
        {recovery
          ? <label style={{ textAlign: 'left' }}>One of your recovery codes<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="xxxxx-xxxxx" autoFocus /></label>
          : <label style={{ textAlign: 'left' }}>The six-digit code from your authenticator app<input className="code-input" value={code} onChange={(event) => setCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus /></label>}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button className="btn" disabled={pending || (recovery ? code.trim().length < 10 : code.length !== 6)}>{pending ? 'Checking' : 'Continue'}</button>
        <button type="button" className="link" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>{recovery ? 'Use my authenticator app' : 'Lost your phone? Use a recovery code'}</button>
        <p className="muted" style={{ fontSize: 12.5 }}>Lost both? Another administrator can reset it under Staff accounts, once they have confirmed who you are.</p>
        <button type="button" className="link" onClick={onCancel}>Sign out</button>
      </form>
    </div>
  );
}

/** Setting up an authenticator: scan, confirm with its first code, keep the recovery codes. */
export function Enrol({ api, currentCode, onDone }: { api: AdminApi; currentCode?: string; onDone: () => void }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => { setPending(true); setError(null); try { await work(); } catch (caught) { setError(toApiError(caught).message); } finally { setPending(false); } };
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  if (!setup) {
    return (
      <div className="stack-left">
        <ol className="how">
          <li>Install an authenticator app: Google Authenticator, Microsoft Authenticator or 1Password.</li>
          <li>Add Quintara to it with the QR code shown next.</li>
          <li>Enter the code it shows, and keep your recovery codes safe.</li>
        </ol>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button className="btn" disabled={pending} onClick={() => run(async () => setSetup(await api.startTwoFactorSetup(currentCode)))}>{pending ? 'One moment' : 'Set up my authenticator'}</button>
      </div>
    );
  }
  return (
    <form className="stack-left" onSubmit={(event) => { event.preventDefault(); void run(async () => setCodes((await api.confirmTwoFactor(code)).recoveryCodes)); }}>
      <div className="qr-row">
        {setup.qr ? <img className="qr" src={setup.qr} alt="QR code to add Quintara to your authenticator app" width={180} height={180} /> : null}
        <div className="stack-left">
          <span className="muted">Or type this key into the app:</span>
          <code className="secret" aria-label="Setup key">{setup.secret}</code>
        </div>
      </div>
      <label>The six-digit code your app now shows<input className="code-input" value={code} onChange={(event) => setCode(digits(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn" disabled={pending || code.length !== 6}>{pending ? 'Checking' : 'Confirm'}</button>
    </form>
  );
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const text = `Quintara admin console recovery codes\nEach works once, if you lose your phone.\n\n${codes.join('\n')}\n`;
  return (
    <div className="stack-left">
      <h2>Your recovery codes</h2>
      <p className="muted">If you lose your phone, each of these lets you sign in once. Keep them in a password manager or another safe, private place. They are shown only now.</p>
      <ul className="recovery-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="row">
        <button type="button" className="btn ghost" onClick={() => { void navigator.clipboard.writeText(text).catch(() => undefined); }}>Copy</button>
        <button type="button" className="btn ghost" onClick={() => { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); Object.assign(document.createElement('a'), { href: url, download: 'quintara-admin-recovery-codes.txt' }).click(); URL.revokeObjectURL(url); }}>Download</button>
      </div>
      <label className="check"><input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} /> I have kept my recovery codes somewhere safe</label>
      <button className="btn" disabled={!kept} onClick={onDone}>Continue</button>
    </div>
  );
}
