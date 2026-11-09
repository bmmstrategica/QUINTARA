'use client';

import { useState } from 'react';
import type { ApiError } from '@quintara/app-core';

export interface Bubble { id: string; mine: boolean; body: string; meta: string }

export const timeOf = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function Thread({ bubbles, empty }: { bubbles: Bubble[]; empty: string }) {
  if (bubbles.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="thread" role="log" aria-label="Conversation">
      {bubbles.map((b) => <div key={b.id} className={`bubble ${b.mine ? 'mine' : ''}`}>{b.body}<small>{b.meta}</small></div>)}
    </div>
  );
}

/** A message box that keeps what was typed if sending fails. */
export function Composer({ label, pending, error, onSend }: { label: string; pending: boolean; error: ApiError | null; onSend: (body: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  return (
    <form onSubmit={async (event) => { event.preventDefault(); if (!text.trim()) return; if (await onSend(text)) setText(''); }}>
      <div className="composer">
        <textarea aria-label={label} placeholder={label} value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} />
        <button className="btn" disabled={pending || !text.trim()}>{pending ? 'Sending' : 'Send'}</button>
      </div>
      {error ? <p className="notice error" role="alert">{error.fields.body ?? error.message}</p> : null}
    </form>
  );
}
