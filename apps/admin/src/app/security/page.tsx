'use client';

/** The signed-in member of staff's own security: two-factor, recovery codes, moving to a new phone, and their activity. */
import { useState } from 'react';
import Link from 'next/link';
import { Enrol, RecoveryCodes } from '@/components/two-factor';
import { fmtDate, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

export default function SecurityPage() {
  const { api, session } = useAdmin();
  const status = useLoad((client) => client.getTwoFactor());
  const { run, pending, error } = useRun();
  const [mode, setMode] = useState<'idle' | 'codes' | 'move'>('idle');
  const [code, setCode] = useState('');
  const [moveCode, setMoveCode] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const reset = () => { setMode('idle'); setCode(''); setMoveCode(null); setCodes(null); status.reload(); };
  return (
    <>
      <div><h1>Your security</h1><p className="lede">Your admin console account is protected by the code we email you and a code from your authenticator app. A console session ends after two hours without use, and after twelve hours in any case.</p></div>
      <Loaded state={status}>
        {(s) => (
          <div className="panel" style={{ maxWidth: 680 }}>
            <p><b style={{ fontWeight: 500 }}>Two-factor authentication is {s.state === 'on' ? 'on' : 'off'}.</b> {s.enabledAt ? `Since ${fmtDate(s.enabledAt)}. ` : ''}{s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
            {codes ? <RecoveryCodes codes={codes} onDone={reset} /> : null}
            {!codes && mode === 'idle' ? (
              <div className="row">
                <button className="btn ghost" onClick={() => setMode('codes')}>New recovery codes</button>
                <button className="btn ghost" onClick={() => setMode('move')}>Move to a new phone</button>
              </div>
            ) : null}
            {!codes && (mode === 'codes' || (mode === 'move' && !moveCode)) ? (
              <form className="stack-left" onSubmit={(event) => {
                event.preventDefault();
                if (mode === 'move') { setMoveCode(code); return; }
                void run(async () => setCodes((await api.newRecoveryCodes(code)).recoveryCodes));
              }}>
                <label>The code now showing in your authenticator app<input className="code-input" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
                {error ? <p className="error" role="alert">{error}</p> : null}
                <div className="row"><button className="btn" disabled={pending || code.length !== 6}>{mode === 'codes' ? 'Make new codes' : 'Continue'}</button><button type="button" className="link" onClick={reset}>Cancel</button></div>
                {mode === 'codes' ? <p className="muted" style={{ fontSize: 13 }}>Your old recovery codes stop working.</p> : <p className="muted" style={{ fontSize: 13 }}>Your current phone keeps working until the new one is confirmed.</p>}
              </form>
            ) : null}
            {mode === 'move' && moveCode && !codes ? <Enrol api={api} currentCode={moveCode} onDone={reset} /> : null}
          </div>
        )}
      </Loaded>
      <p><Link href={`/audit?staff=${session.userId}`}>Your activity in the audit log</Link></p>
    </>
  );
}
