'use client';

import type { StaffHomeSlide } from '@quintara/api-client';
import { useState } from 'react';
import { PhotoUpload, thumb } from '@/components/photo-upload';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

export default function HomeSlidesPage() {
  const { api } = useAdmin();
  const slides = useLoad((client) => client.listHomeSlides());
  const { run, pending, error } = useRun();
  const [caption, setCaption] = useState('');
  const [position, setPosition] = useState(10);
  return (
    <>
      <div><h1>Home page welcome</h1><p className="lede">The welcome area of the home page alternates between these photographs and films, in the order shown. With none, the home page shows its text alone.</p></div>
      <Loaded state={slides}>
        {(list) => list.length === 0 ? <p className="note">No photographs or films yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th></th><th>Kind</th><th>Caption</th><th>Order</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((s) => <SlideRow key={s.id} slide={s} onChanged={slides.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <h2>Add a photograph</h2>
      <div className="panel" aria-label="Add a photograph" role="group">
        <div className="form">
          <label>Caption (optional)<input maxLength={160} value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
          <label>Order<input type="number" min={0} max={10000} value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label>
        </div>
        <PhotoUpload frame="wide" hint="Shown full width behind the welcome: a wide photograph of at least 3200 px looks sharpest" actionLabel="Add photograph"
          onUploaded={async (photo) => { await api.createHomeSlide({ kind: 'image', imageId: photo.id, caption: caption.trim(), position }); setCaption(''); slides.reload(); }} />
      </div>
      <h2>Add a film</h2>
      <form className="panel" aria-label="Add a film" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget, f = new FormData(form);
        void run(() => api.createHomeSlide({ kind: 'video', videoUrl: String(f.get('video') ?? '').trim(), caption: String(f.get('caption') ?? '').trim(), position: Number(f.get('position') || 0) }), () => { form.reset(); slides.reload(); });
      }}>
        <p className="muted">Paste the https address of the film where it is hosted (an MP4 file), as for Quintara TV. Films play silently and loop.</p>
        <div className="form">
          <label>Film address<input name="video" type="url" required placeholder="https://" /></label>
          <label>Caption (optional)<input name="caption" maxLength={160} /></label>
          <label>Order<input name="position" type="number" min={0} max={10000} defaultValue={10} /></label>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Add film'}</button></div>
      </form>
    </>
  );
}

function SlideRow({ slide: s, onChanged }: { slide: StaffHomeSlide; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [cropping, setCropping] = useState(false);
  return (
    <>
    <tr>
      <td>{s.kind === 'image' ? <img src={thumb(s.src, 96)} alt="" style={{ width: 96, height: 56, objectFit: 'cover', borderRadius: 4 }} /> : <video src={s.src} muted playsInline preload="metadata" style={{ width: 96, height: 56, objectFit: 'cover', borderRadius: 4 }} />}</td>
      <td>{s.kind === 'image' ? 'Photograph' : 'Film'}{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td><input aria-label="Caption" defaultValue={s.caption} maxLength={160} onBlur={(event) => { if (event.target.value.trim() !== s.caption) void run(() => api.updateHomeSlide(s.id, { caption: event.target.value.trim() }), onChanged); }} /></td>
      <td><input aria-label="Order" type="number" min={0} max={10000} defaultValue={s.position} style={{ width: 90 }} onBlur={(event) => { if (Number(event.target.value) !== s.position) void run(() => api.updateHomeSlide(s.id, { position: Number(event.target.value) }), onChanged); }} /></td>
      <td><span className={`chip ${s.isActive ? 'ok' : ''}`}>{s.isActive ? 'Showing' : 'Hidden'}</span></td>
      <td className="row">
        <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateHomeSlide(s.id, { isActive: !s.isActive }), onChanged)}>{s.isActive ? 'Hide' : 'Show'}</button>
        {s.kind === 'image' ? <button className="btn ghost" aria-expanded={cropping} onClick={() => setCropping(!cropping)}>{cropping ? 'Close' : 'Crop'}</button> : null}
        <button className="btn ghost" disabled={pending} onClick={() => { if (window.confirm('Remove this from the home page?')) void run(() => api.deleteHomeSlide(s.id), onChanged); }}>Remove</button>
      </td>
    </tr>
    {cropping ? (
      <tr><td colSpan={6}>
        <PhotoUpload frame="wide" source={s.src} actionLabel="Save the crop" hint="Cropping starts from the photograph now in use. To bring back a part already cut away, upload the original again"
          onUploaded={async (photo) => { await api.updateHomeSlide(s.id, { imageId: photo.id }); setCropping(false); onChanged(); }} />
      </td></tr>
    ) : null}
    </>
  );
}
