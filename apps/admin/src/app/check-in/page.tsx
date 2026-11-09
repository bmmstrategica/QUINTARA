'use client';

import { useEffect, useRef, useState } from 'react';
import { toApiError } from '@quintara/api-client';
import { useAdmin } from '@/lib/admin';

type Result = { ok: true; text: string } | { ok: false; text: string };

/** The browser's own barcode reader (Chrome and Edge, Android included). Not on iPhone Safari, where codes are typed. */
interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
type DetectorClass = new (options: { formats: string[] }) => Detector;
const detectorClass = (): DetectorClass | null => (typeof window !== 'undefined' && 'BarcodeDetector' in window ? (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector : null);

/** Built for a phone at the door: one field, large type, an immediate answer. Scan the ticket's QR code where the browser can. */
export default function CheckInPage() {
  const { api } = useAdmin();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => { setCanScan(Boolean(detectorClass()) && Boolean(navigator.mediaDevices?.getUserMedia)); }, []);
  const stopCamera = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setScanning(false); };
  useEffect(() => stopCamera, []);

  async function checkIn(ticket: string) {
    setPending(true);
    try {
      const guest = await api.checkIn(ticket.trim());
      setResult({ ok: true, text: `${guest.fullName}, ${guest.seats} seat${guest.seats > 1 ? 's' : ''}. ${guest.experienceTitle}.` });
      setCode('');
    } catch (caught) {
      setResult({ ok: false, text: toApiError(caught).message });
    } finally {
      setPending(false);
    }
  }

  async function scan() {
    const Detector = detectorClass();
    if (!Detector) return;
    setResult(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      setResult({ ok: false, text: 'The camera could not be opened. Allow the camera for this site, or type the code.' });
      return;
    }
    setScanning(true);
    const detector = new Detector({ formats: ['qr_code'] });
    const element = video.current!;
    element.srcObject = stream.current;
    await element.play().catch(() => undefined);
    // Look for a ticket a few times a second until one is found or the camera is closed.
    const look = async () => {
      if (!stream.current) return;
      const found = (await detector.detect(element).catch(() => [])).map((c) => c.rawValue.trim()).find((v) => /^QT-[0-9A-F]+$/i.test(v));
      if (found) { stopCamera(); setCode(found); await checkIn(found); return; }
      setTimeout(look, 250);
    };
    void look();
  }

  return (
    <>
      <div><h1>Check-in</h1><p className="lede">Type or scan the code on the guest's ticket.</p></div>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); void checkIn(code); }} style={{ maxWidth: 460 }}>
        <label>Ticket code<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="QT-" autoCapitalize="characters" autoComplete="off" required style={{ fontSize: 22, letterSpacing: '0.06em' }} /></label>
        <div className="row">
          <button className="btn" disabled={pending}>{pending ? 'Checking' : 'Check in'}</button>
          {canScan ? (scanning
            ? <button type="button" className="btn ghost" onClick={stopCamera}>Close camera</button>
            : <button type="button" className="btn ghost" disabled={pending} onClick={() => void scan()}>Scan with camera</button>) : null}
        </div>
        <video ref={video} muted playsInline aria-label="Camera, looking for the ticket's QR code" hidden={!scanning} style={{ width: '100%', borderRadius: 8, background: '#000' }} />
      </form>
      {result ? <p className={result.ok ? 'note' : 'error'} role="status" style={{ fontSize: 18 }}>{result.ok ? 'Welcome. ' : ''}{result.text}</p> : null}
    </>
  );
}
