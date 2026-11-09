'use client';

import { useState } from 'react';
import { toApiError } from '@quintara/api-client';
import { useAdmin } from '@/lib/admin';

type Result = { ok: true; text: string } | { ok: false; text: string };

/** Built for a phone at the door: one field, large type, an immediate answer. */
export default function CheckInPage() {
  const { api } = useAdmin();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const guest = await api.checkIn(code);
      setResult({ ok: true, text: `${guest.fullName}, ${guest.seats} seat${guest.seats > 1 ? 's' : ''}. ${guest.experienceTitle}.` });
      setCode('');
    } catch (caught) {
      setResult({ ok: false, text: toApiError(caught).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div><h1>Check-in</h1><p className="lede">Type or scan the code on the guest's ticket.</p></div>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 460 }}>
        <label>Ticket code<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="QT-" autoCapitalize="characters" autoComplete="off" required style={{ fontSize: 22, letterSpacing: '0.06em' }} /></label>
        <button className="btn" disabled={pending}>{pending ? 'Checking' : 'Check in'}</button>
      </form>
      {result ? <p className={result.ok ? 'note' : 'error'} role="status" style={{ fontSize: 18 }}>{result.ok ? 'Welcome. ' : ''}{result.text}</p> : null}
    </>
  );
}
