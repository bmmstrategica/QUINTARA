'use client';

import { useState } from 'react';
import type { StaffTvEpisode, StaffTvSeries } from '@quintara/api-client';
import { formatDuration } from '@quintara/domain';
import type { PublishStatus } from '@quintara/domain';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const STATUS: Record<PublishStatus, string> = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const tone = (status: PublishStatus) => (status === 'published' ? 'ok' : status === 'draft' ? 'gold' : '');

export default function TvPage() {
  const { api } = useAdmin();
  const state = useLoad((client) => client.listTvSeries());
  const { run, pending, error } = useRun();
  return (
    <>
      <div><h1>Quintara TV</h1><p className="lede">Members see an episode once it and its series are both published. Videos are streamed from your video host: paste the secure address it gives you.</p></div>
      <Loaded state={state}>
        {(list) => list.length === 0 ? <p className="note">No series yet.</p> : <>{list.map((s) => <SeriesPanel key={s.id} series={s} onChanged={state.reload} />)}</>}
      </Loaded>
      <h2>New series</h2>
      <form className="panel" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget, f = new FormData(form);
        void run(() => api.createTvSeries({ title: String(f.get('title') ?? '').trim(), summary: String(f.get('summary') ?? '').trim() }), () => { form.reset(); state.reload(); });
      }}>
        <div className="form"><label>Title<input name="title" required minLength={2} maxLength={120} /></label><label>One-line description<input name="summary" maxLength={600} /></label></div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Create draft'}</button></div>
      </form>
    </>
  );
}

function SeriesPanel({ series: s, onChanged }: { series: StaffTvSeries; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
    void run(() => api.createTvEpisode(s.id, { title: text('title'), summary: text('summary'), durationSeconds: Math.round(Number(f.get('minutes')) * 60), videoUrl: text('video') || null, audience: f.get('open') === 'on' ? 'public' : 'members' }), () => { form.reset(); onChanged(); });
  }
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>{s.title}</h2><span className="muted">{s.summary}</span></div>
        <div className="row">
          <span className={`chip ${tone(s.status)}`}>{STATUS[s.status]}</span>
          <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
          {s.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updateTvSeries(s.id, { status: 'published' }), onChanged)}>Publish</button> : <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateTvSeries(s.id, { status: 'draft' }), onChanged)}>Unpublish</button>}
        </div>
      </div>
      {editing ? (
        <form aria-label={`Edit ${s.title}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void run(() => api.updateTvSeries(s.id, { title: String(f.get('title') ?? '').trim(), summary: String(f.get('summary') ?? '').trim() }), () => { setEditing(false); onChanged(); });
        }}>
          <label>Programme title<input name="title" required minLength={2} maxLength={120} defaultValue={s.title} /></label>
          <label>Description<textarea name="summary" maxLength={600} rows={3} defaultValue={s.summary} /></label>
          <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {s.episodes.length ? (
        <div className="scroll"><table>
          <thead><tr><th>Episode</th><th>Length</th><th>Who can watch</th><th>Video</th><th>Viewers</th><th>Status</th><th></th></tr></thead>
          <tbody>{s.episodes.map((e) => <EpisodeRow key={e.id} episode={e} onChanged={onChanged} />)}</tbody>
        </table></div>
      ) : <p className="muted">No episodes yet.</p>}
      <form onSubmit={add} style={{ display: 'grid', gap: 12 }}>
        <div className="form">
          <label>New episode<input name="title" required minLength={2} maxLength={120} /></label>
          <label>Length, in minutes<input name="minutes" type="number" min={1} max={1440} required defaultValue={30} /></label>
          <label>Video address (https, optional for now)<input name="video" type="url" placeholder="https://" /></label>
        </div>
        <label>One-line description<input name="summary" maxLength={600} /></label>
        <label className="check"><input name="open" type="checkbox" /> Open to everyone, not only members</label>
        <div><button className="btn ghost" disabled={pending}>Add as draft</button></div>
      </form>
    </div>
  );
}

function EpisodeRow({ episode: e, onChanged }: { episode: StaffTvEpisode; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <tr><td colSpan={7}>
        <form aria-label={`Edit ${e.title}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
          void run(() => api.updateTvEpisode(e.id, { title: text('title'), summary: text('summary'), durationSeconds: Math.round(Number(f.get('minutes')) * 60), videoUrl: text('video') || null }), () => { setEditing(false); onChanged(); });
        }}>
          <div className="form">
            <label>Episode title<input name="title" required minLength={2} maxLength={120} defaultValue={e.title} /></label>
            <label>Length, in minutes<input name="minutes" type="number" min={1} max={1440} required defaultValue={Math.max(1, Math.round(e.durationSeconds / 60))} /></label>
            <label>Video address (https)<input name="video" type="url" placeholder="https://" defaultValue={e.videoUrl ?? ''} /></label>
          </div>
          <label>Description<input name="summary" maxLength={600} defaultValue={e.summary} /></label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="row"><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      </td></tr>
    );
  }
  return (
    <tr>
      <td>{e.number}. {e.title}<small>{e.summary || 'No description'}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td>{formatDuration(e.durationSeconds)}</td>
      <td><select className="small" aria-label={`Audience for ${e.title}`} value={e.audience} disabled={pending} onChange={(event) => run(() => api.updateTvEpisode(e.id, { audience: event.target.value as 'public' | 'members' }), onChanged)}><option value="members">Members</option><option value="public">Everyone</option></select></td>
      <td>{e.videoUrl ? <span className="chip ok">Linked</span> : <span className="chip gold">No video yet</span>}</td>
      <td>{e.viewers}</td>
      <td><span className={`chip ${tone(e.status)}`}>{STATUS[e.status]}</span></td>
      <td className="row"><button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>{e.status !== 'published' ? <button className="btn" disabled={pending} onClick={() => run(() => api.updateTvEpisode(e.id, { status: 'published' }), onChanged)}>Publish</button> : <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateTvEpisode(e.id, { status: 'archived' }), onChanged)}>Withdraw</button>}</td>
    </tr>
  );
}
