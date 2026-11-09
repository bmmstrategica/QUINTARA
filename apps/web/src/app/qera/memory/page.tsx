'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import { dayAndMonth, MEMORY_KIND_LABEL, MEMORY_KINDS } from '@quintara/domain';
import type { MemoryKind, QeraMemory, QeraMemoryItem } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

const PLACEHOLDER: Record<MemoryKind, string> = {
  dietary: 'Vegetarian, no shellfish', likes: 'Natural wine, quiet tables', favourite: 'Saffron House, the corner table', date: 'Our anniversary', person: 'Lindiwe, my wife', note: 'I travel to Johannesburg most Mondays',
};

/** Everything QÉRA remembers about the member, which they can change or remove at any time. */
export default function QeraMemoryPage() {
  const [version, setVersion] = useState(0);
  const memory = useResource((api) => api.getQeraMemory(), [version]);
  const refresh = () => setVersion((n) => n + 1);
  const clear = useAction(async (api) => { await api.clearQeraMemory(); return true; });
  return (
    <>
      <p><Link href="/qera" className="muted">Back to Q&Eacute;RA</Link></p>
      <div className="head"><div>
        <h2>What Q&Eacute;RA remembers</h2>
        <p className="lede">Q&Eacute;RA uses this to recommend, plan and book for you. It remembers only what you add here or ask it to remember, and it always asks first. Restaurants and chefs are told your dietary needs when Q&Eacute;RA books them; nothing else here is shared. It is in your data download, and it is erased with your account.</p>
      </div></div>
      <ResourceView resource={memory}>
        {(m: QeraMemory) => (
          <div className="chief-grid">
            <div>
              {m.items.length === 0 ? <p className="notice">Nothing yet. Add something on the right, or tell Q&Eacute;RA, for example, &ldquo;remember that I am vegetarian&rdquo;.</p> : null}
              {MEMORY_KINDS.filter((k) => m.items.some((i) => i.kind === k)).map((k) => (
                <section className="memory-kind" key={k} aria-label={MEMORY_KIND_LABEL[k]}>
                  <h3>{MEMORY_KIND_LABEL[k]}</h3>
                  {m.items.filter((i) => i.kind === k).map((item) => <MemoryRow key={item.id} item={item} onChanged={refresh} />)}
                </section>
              ))}
              {m.items.length ? (
                <p style={{ marginTop: '2rem' }}>
                  <button className="btn quiet small" disabled={clear.pending} onClick={async () => { if (window.confirm('Forget everything QÉRA remembers about you?') && (await clear.run())) refresh(); }}>Forget everything</button>
                </p>
              ) : null}
              <ActionError error={clear.error} />
            </div>
            <aside className="stack">
              <AddMemory onAdded={refresh} />
              {m.suggestions.length ? (
                <section className="panel" aria-label="Suggestions">
                  <h3>Q&Eacute;RA noticed</h3>
                  <p className="muted" style={{ fontSize: '0.85rem' }}>Nothing is kept unless you add it.</p>
                  {m.suggestions.map((sg) => <Suggestion key={`${sg.kind}:${sg.label}`} kind={sg.kind} label={sg.label} reason={sg.reason} onAdded={refresh} />)}
                </section>
              ) : null}
            </aside>
          </div>
        )}
      </ResourceView>
    </>
  );
}

function Suggestion({ kind, label, reason, onAdded }: { kind: MemoryKind; label: string; reason: string; onAdded: () => void }) {
  const add = useAction(async (api) => { await api.addQeraMemory({ kind, label }); return true; });
  return (
    <div className="panel-item">
      <div><strong style={{ fontWeight: 500 }}>{label}</strong><small>{MEMORY_KIND_LABEL[kind]}. {reason}</small><ActionError error={add.error} /></div>
      <button className="btn small" disabled={add.pending} onClick={async () => { if (await add.run()) onAdded(); }}>Remember</button>
    </div>
  );
}

function MemoryForm({ initial, submitLabel, onSubmit, pending }: { initial: { kind: MemoryKind; label: string; detail: string; date: string }; submitLabel: string; onSubmit: (v: { kind: MemoryKind; label: string; detail: string; date: string | null }) => void; pending: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <form className="stack" onSubmit={(event) => { event.preventDefault(); onSubmit({ ...v, date: v.kind === 'date' ? v.date || null : null }); }}>
      <label>Kind<select value={v.kind} onChange={(event) => setV({ ...v, kind: event.target.value as MemoryKind })}>{MEMORY_KINDS.map((k) => <option key={k} value={k}>{MEMORY_KIND_LABEL[k]}</option>)}</select></label>
      <label>What to remember<input value={v.label} maxLength={120} placeholder={PLACEHOLDER[v.kind]} onChange={(event) => setV({ ...v, label: event.target.value })} /></label>
      {v.kind === 'date' ? <label>Date<input type="date" value={v.date} onChange={(event) => setV({ ...v, date: event.target.value })} /></label> : null}
      <label>Detail (optional)<input value={v.detail} maxLength={300} onChange={(event) => setV({ ...v, detail: event.target.value })} /></label>
      <div><button className="btn small" disabled={pending}>{pending ? 'Saving' : submitLabel}</button></div>
    </form>
  );
}

function AddMemory({ onAdded }: { onAdded: () => void }) {
  const [key, setKey] = useState(0);
  const add = useAction(async (api, v: { kind: MemoryKind; label: string; detail: string; date: string | null }) => { await api.addQeraMemory(v); return true; });
  return (
    <section className="panel" aria-label="Add to memory">
      <h3>Add</h3>
      <MemoryForm key={key} initial={{ kind: 'likes', label: '', detail: '', date: '' }} submitLabel="Remember this" pending={add.pending} onSubmit={async (v) => { if (await add.run(v)) { setKey((n) => n + 1); onAdded(); } }} />
      <ActionError error={add.error} />
    </section>
  );
}

function MemoryRow({ item, onChanged }: { item: QeraMemoryItem; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const save = useAction(async (api, v: { kind: MemoryKind; label: string; detail: string; date: string | null }) => { await api.updateQeraMemory(item.id, v); return true; });
  const remove = useAction(async (api) => { await api.deleteQeraMemory(item.id); return true; });
  if (editing) {
    return (
      <div className="panel" style={{ marginBottom: '0.6rem' }}>
        <MemoryForm initial={{ kind: item.kind, label: item.label, detail: item.detail, date: item.date ?? '' }} submitLabel="Save" pending={save.pending} onSubmit={async (v) => { if (await save.run(v)) { setEditing(false); onChanged(); } }} />
        <ActionError error={save.error} />
        <div><button className="btn quiet small" onClick={() => setEditing(false)}>Cancel</button></div>
      </div>
    );
  }
  return (
    <div className="panel-item">
      <div>
        <strong style={{ fontWeight: 500 }}>{item.label}</strong>
        <small>{[item.date ? dayAndMonth(item.date) : '', item.detail, item.source === 'qera' ? 'Added by QÉRA when you asked' : ''].filter(Boolean).join('. ')}</small>
        <ActionError error={remove.error} />
      </div>
      <div className="row">
        <button className="btn quiet small" onClick={() => setEditing(true)}>Change</button>
        <button className="btn quiet small" disabled={remove.pending} onClick={async () => { if (await remove.run()) onChanged(); }}>Remove</button>
      </div>
    </div>
  );
}
