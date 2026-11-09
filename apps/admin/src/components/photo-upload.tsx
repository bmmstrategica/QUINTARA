'use client';

/**
 * Choosing and preparing a photograph before it is uploaded. Staff pick the file (camera originals up to 40 MB),
 * then choose how large it is stored, how it is cropped, and the quality, with a live preview of the crop.
 * The crop is drawn by dragging on the picture: freely, or held to a shape (square, portrait, wide). A photograph
 * already in use can be opened again (`source`) and cropped further; the result is stored as a new photograph.
 * The original goes to the server untouched with these choices, and the server does the resizing with
 * high-quality resampling, so nothing is lost to the browser re-compressing it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PhotoUploadOptions, UploadedPhoto } from '@quintara/api-client';
import { useAdmin, useRun } from '@/lib/admin';

export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/tiff,image/heic,image/heif';

export type Frame = 'original' | 'free' | 'square' | 'portrait' | 'landscape' | 'wide' | 'tall';
const FRAMES: Record<Frame, [label: string, ratio: number | null]> = {
  original: ['No crop: as taken', null], free: ['Free: any shape', null], square: ['Square, 1:1', 1], portrait: ['Portrait, 4:5', 4 / 5], tall: ['Tall, 2:3', 2 / 3], landscape: ['Landscape, 3:2', 3 / 2], wide: ['Wide, 16:9', 16 / 9],
};
export type Crop = { x: number; y: number; width: number; height: number };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const SIZES: [edge: number, label: string][] = [
  [8000, 'Full resolution, up to 8000 px'], [5120, 'Very large, 5120 px'], [4096, 'Large, 4096 px (recommended)'], [3200, 'Standard, 3200 px'], [2400, 'Medium, 2400 px'], [1600, 'Small, 1600 px'],
];
const QUALITIES: [q: number, label: string][] = [[98, 'Maximum (98)'], [92, 'High (92, recommended)'], [85, 'Balanced (85)'], [78, 'Light (78)']];

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** The crop as fractions of the upright picture, for a frame ratio, a zoom (1 = as large as fits) and a position (0 to 1 each way). */
export function cropFor(width: number, height: number, ratio: number | null, zoom: number, x: number, y: number) {
  if (!ratio && zoom <= 1) return null;
  const r = ratio ?? width / height;
  let cw = width, ch = height;
  if (width / height > r) cw = height * r; else ch = width / r;
  cw /= zoom; ch /= zoom;
  return { x: ((width - cw) * x) / width, y: ((height - ch) * y) / height, width: cw / width, height: ch / height };
}

/** The crop a frame starts with: the largest of its shape, centred; a free crop starts with a margin all round. */
function startCrop(width: number, height: number, frame: Frame): Crop | null {
  if (frame === 'original') return null;
  if (frame === 'free') return { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
  return cropFor(width, height, FRAMES[frame][1], 1, 0.5, 0.5);
}

/**
 * Dragging on the preview. Inside the crop moves it; a corner resizes it (keeping its shape unless free); anywhere
 * else draws a new one. All in fractions of the picture; `aspect` is the shape in fractions (ratio × height / width).
 */
type Drag = { mode: 'move' | 'draw' | 'corner'; start: { x: number; y: number }; from: Crop; anchor: { x: number; y: number } };
const MIN = 0.03;
function dragTo(drag: Drag, at: { x: number; y: number }, aspect: number | null): Crop {
  if (drag.mode === 'move') {
    const { from } = drag;
    return { ...from, x: clamp(from.x + at.x - drag.start.x, 0, 1 - from.width), y: clamp(from.y + at.y - drag.start.y, 0, 1 - from.height) };
  }
  const { anchor } = drag, sx = at.x >= anchor.x ? 1 : -1, sy = at.y >= anchor.y ? 1 : -1;
  let w = Math.max(MIN, Math.abs(at.x - anchor.x)), h = Math.max(MIN, Math.abs(at.y - anchor.y));
  const roomX = sx > 0 ? 1 - anchor.x : anchor.x, roomY = sy > 0 ? 1 - anchor.y : anchor.y;
  if (aspect) { if (w / h > aspect) h = w / aspect; else w = h * aspect; const k = Math.min(1, roomX / w, roomY / h); w *= k; h *= k; }
  else { w = Math.min(w, roomX); h = Math.min(h, roomY); }
  return { x: sx > 0 ? anchor.x : anchor.x - w, y: sy > 0 ? anchor.y : anchor.y - h, width: w, height: h };
}

/** iPhone photographs (HEIC) are turned into a full-size, high-quality JPEG in the browser, where the browser can read them. */
async function asUploadable(file: File, bitmap: ImageBitmap | null): Promise<Blob> {
  if (!/heic|heif/i.test(file.type) && !/\.hei[cf]$/i.test(file.name)) return file;
  if (!bitmap) throw new Error('This browser cannot read HEIC photographs. Export it as JPEG first (on an iPhone: Settings, Camera, Formats, Most Compatible).');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That photograph could not be converted.'))), 'image/jpeg', 0.96));
}

export function PhotoUpload({ onUploaded, frame: initialFrame = 'original', actionLabel = 'Upload photograph', hint, source, children }: {
  onUploaded: (photo: UploadedPhoto) => Promise<void> | void;
  /** The framing to start with, for where the photograph will be shown. */
  frame?: Frame;
  actionLabel?: string;
  hint?: string;
  /** A photograph already in use, opened for cropping (its stored path, from the API). */
  source?: string;
  /** Extra fields shown with the upload button (a caption, say). */
  children?: React.ReactNode;
}) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [file, setFile] = useState<File | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame>(initialFrame);
  const [edge, setEdge] = useState(4096);
  const [custom, setCustom] = useState('');
  const [quality, setQuality] = useState(92);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [done, setDone] = useState<UploadedPhoto | null>(null);
  const [loading, setLoading] = useState(Boolean(source));
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);

  async function choose(chosen: File | undefined) {
    setDone(null); setProblem(null); setBitmap(null); setCrop(null);
    if (!chosen) { setFile(null); return; }
    if (chosen.size > MAX_PHOTO_BYTES) { setFile(null); setProblem(`That file is ${mb(chosen.size)}. Photographs can be up to 40 MB.`); return; }
    setFile(chosen);
    // Upright, as the camera meant it, so the crop below matches what is stored.
    try {
      const b = await createImageBitmap(chosen, { imageOrientation: 'from-image' });
      setBitmap(b); setCrop(startCrop(b.width, b.height, frame));
    } catch { setBitmap(null); }
  }

  // A photograph already in use: the stored full-size photograph (JPEG or PNG, never a smaller copy) is opened for cropping.
  useEffect(() => {
    if (!source) return;
    let live = true;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ''}${source}`, { headers: { accept: 'image/jpeg,image/png' }, credentials: 'omit' });
        if (!response.ok) throw new Error();
        const blob = await response.blob();
        if (live) await choose(new File([blob], `photograph.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type || 'image/jpeg' }));
      } catch { if (live) setProblem('The photograph could not be opened for cropping. Upload the original instead.'); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const maxEdge = edge === 0 ? Math.max(320, Math.min(8000, Number(custom) || 0)) : edge;
  const ratio = FRAMES[frame][1];
  // The shape held while dragging, in fractions of the picture.
  const aspect = bitmap && ratio ? (ratio * bitmap.height) / bitmap.width : null;
  const changeFrame = (next: Frame) => {
    setFrame(next);
    if (!bitmap) return;
    if (next === 'free' && crop) return;   // keep what was drawn, now free to change shape
    setCrop(startCrop(bitmap.width, bitmap.height, next));
  };
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1), box };
  };
  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!bitmap) return;
    const { x, y, box } = point(event), near = 14 / box.width, nearY = 14 / box.height;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (crop) {
      const corners = [[crop.x, crop.y], [crop.x + crop.width, crop.y], [crop.x, crop.y + crop.height], [crop.x + crop.width, crop.y + crop.height]] as const;
      const hit = corners.findIndex(([cx, cy]) => Math.abs(cx - x) < near && Math.abs(cy - y) < nearY);
      if (hit >= 0) { const [ax, ay] = corners[3 - hit]!; drag.current = { mode: 'corner', start: { x, y }, from: crop, anchor: { x: ax, y: ay } }; return; }
      if (x > crop.x && x < crop.x + crop.width && y > crop.y && y < crop.y + crop.height) { drag.current = { mode: 'move', start: { x, y }, from: crop, anchor: { x, y } }; return; }
    }
    if (frame === 'original') setFrame('free');
    drag.current = { mode: 'draw', start: { x, y }, from: crop ?? { x, y, width: 0, height: 0 }, anchor: { x, y } };
  }
  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d) {
      if (!crop) return;
      const { x, y, box } = point(event), near = 14 / box.width, nearY = 14 / box.height;
      const corner = [[crop.x, crop.y, 'nwse'], [crop.x + crop.width, crop.y + crop.height, 'nwse'], [crop.x + crop.width, crop.y, 'nesw'], [crop.x, crop.y + crop.height, 'nesw']].find(([cx, cy]) => Math.abs((cx as number) - x) < near && Math.abs((cy as number) - y) < nearY);
      event.currentTarget.style.cursor = corner ? `${corner[2]}-resize` : x > crop.x && x < crop.x + crop.width && y > crop.y && y < crop.y + crop.height ? 'move' : 'crosshair';
      return;
    }
    const { x, y } = point(event);
    if (d.mode === 'draw' && Math.abs(x - d.anchor.x) < 0.01 && Math.abs(y - d.anchor.y) < 0.01) return;
    setCrop(dragTo(d, { x, y }, frame === 'free' || frame === 'original' ? null : aspect));
  }
  const pointerUp = () => { drag.current = null; };
  /** The keyboard: arrows move the crop; with Shift, they make it larger or smaller. */
  function key(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!crop || !event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const step = 0.01, dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0, dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!event.shiftKey) { setCrop({ ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) }); return; }
    const free = frame === 'free' || !aspect;
    let w = clamp(crop.width + (free ? dx : dx || -dy), MIN, 1 - crop.x), h = free ? clamp(crop.height + dy, MIN, 1 - crop.y) : w / aspect!;
    if (!free && crop.y + h > 1) { h = 1 - crop.y; w = h * aspect!; }
    setCrop({ ...crop, width: w, height: h });
  }
  const out = useMemo(() => {
    if (!bitmap) return null;
    const w = bitmap.width * (crop?.width ?? 1), h = bitmap.height * (crop?.height ?? 1), scale = Math.min(1, maxEdge / Math.max(w, h));
    return { w: Math.round(w * scale), h: Math.round(h * scale), shrunk: scale < 1 };
  }, [bitmap, crop, maxEdge]);

  // The preview: the whole picture, with what will be cut away dimmed, the kept part outlined with thirds and corner handles.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !bitmap) return;
    const width = Math.min(560, c.parentElement?.clientWidth ?? 560), scale = width / bitmap.width, height = Math.round(bitmap.height * scale);
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); c.style.width = `${width}px`; c.style.height = `${height}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, width, height);
    if (crop) {
      const x = crop.x * width, y = crop.y * height, w = crop.width * width, h = crop.height * height;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, width, y); g.fillRect(0, y + h, width, height - y - h); g.fillRect(0, y, x, h); g.fillRect(x + w, y, width - x - w, h);
      g.strokeStyle = '#D2B88E'; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
      g.strokeStyle = 'rgba(210,184,142,0.45)'; g.lineWidth = 1; g.beginPath();
      for (const k of [1, 2]) { g.moveTo(x + (w * k) / 3, y); g.lineTo(x + (w * k) / 3, y + h); g.moveTo(x, y + (h * k) / 3); g.lineTo(x + w, y + (h * k) / 3); }
      g.stroke();
      g.fillStyle = '#D2B88E';
      for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as const) g.fillRect(cx - 5, cy - 5, 10, 10);
    }
  }, [bitmap, crop]);

  function upload() {
    if (!file) return;
    void run(async () => {
      const options: PhotoUploadOptions = { maxEdge, quality, crop };
      const photo = await api.uploadPhoto(await asUploadable(file, bitmap), options);
      await onUploaded(photo);
      setDone(photo);
      setFile(null); setBitmap(null); setCrop(null);
      if (input.current) input.current.value = '';
    });
  }

  return (
    <div className="photo-upload">
      {loading ? <p className="muted" role="status">Opening the photograph</p> : null}
      <label>{source ? 'Or choose another photograph' : 'Photograph'}: JPEG, PNG, WebP, AVIF, TIFF or HEIC, up to 40 MB{hint ? `. ${hint}` : ''}
        <input ref={input} type="file" accept={ACCEPT} onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      {problem ? <p className="error" role="alert">{problem}</p> : null}
      {file ? (
        <div className="photo-editor">
          <div className="photo-preview">
            {bitmap ? <canvas ref={canvas} tabIndex={0} aria-label="Crop: drag on the picture to draw the crop, drag inside it to move it, drag a corner to resize it. Arrow keys move it; Shift and arrow keys resize it." style={{ touchAction: 'none', cursor: 'crosshair' }}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={key} /> : <p className="note">No preview in this browser for this file. It will be stored as taken, at the size and quality chosen.</p>}
            <small className="muted">{source ? 'The photograph in use' : file.name}: {bitmap ? `${bitmap.width.toLocaleString('en-ZA')} × ${bitmap.height.toLocaleString('en-ZA')} px, ` : ''}{mb(file.size)}{bitmap ? '. Drag on the picture to crop.' : ''}</small>
          </div>
          <div className="photo-settings">
            <label>Stored size (longest side)
              <select value={edge} onChange={(event) => setEdge(Number(event.target.value))}>
                {SIZES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                <option value={0}>Custom size</option>
              </select>
            </label>
            {edge === 0 ? <label>Longest side, in pixels (320 to 8000)<input type="number" min={320} max={8000} step={10} value={custom} placeholder="3000" onChange={(event) => setCustom(event.target.value)} /></label> : null}
            <label>Crop
              <select value={frame} disabled={!bitmap} onChange={(event) => changeFrame(event.target.value as Frame)}>
                {(Object.keys(FRAMES) as Frame[]).map((key) => <option key={key} value={key}>{FRAMES[key][0]}</option>)}
              </select>
            </label>
            {bitmap && crop ? (
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 13 }}>Keeping {Math.round(crop.width * bitmap.width).toLocaleString('en-ZA')} × {Math.round(crop.height * bitmap.height).toLocaleString('en-ZA')} px of the picture.</span>
                <button type="button" className="link" onClick={() => setCrop(startCrop(bitmap.width, bitmap.height, frame))}>Reset the crop</button>
                <button type="button" className="link" onClick={() => { setFrame('original'); setCrop(null); }}>No crop</button>
              </div>
            ) : bitmap ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Drag on the picture to crop it, or choose a shape.</p> : null}
            <label>Quality
              <select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>
                {QUALITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {out ? <p className="note" aria-live="polite">Stored at {out.w.toLocaleString('en-ZA')} × {out.h.toLocaleString('en-ZA')} px{out.shrunk ? '' : ', its full size'}, with sharp copies made for phones, tablets and large screens.{Math.max(out.w, out.h) < 1600 ? ' This is small for a full-width picture; a larger original will look better.' : ''}</p> : null}
            {children}
            {error ? <p className="error" role="alert">{error}</p> : null}
            <div className="row">
              <button type="button" className="btn" disabled={pending || (edge === 0 && !(Number(custom) >= 320))} onClick={upload}>{pending ? `Uploading ${mb(file.size)}` : actionLabel}</button>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => { void choose(undefined); if (input.current) input.current.value = ''; }}>Clear</button>
            </div>
          </div>
        </div>
      ) : null}
      {done ? <p className="muted" role="status">Uploaded: {done.width.toLocaleString('en-ZA')} × {done.height.toLocaleString('en-ZA')} px, {mb(done.bytes)}.</p> : null}
    </div>
  );
}

/** A small, sharp thumbnail of an uploaded photograph for staff lists. */
export const thumb = (path: string, cssWidth: number) => `${process.env.NEXT_PUBLIC_API_URL ?? ''}${path}?w=${Math.min(3840, Math.ceil(cssWidth * 2))}`;
