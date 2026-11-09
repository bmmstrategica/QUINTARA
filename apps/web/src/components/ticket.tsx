'use client';

/**
 * A confirmed booking's ticket: the code, and on request a QR code of it for the door. The QR holds only the ticket
 * code, which staff check in against the guest list; it is drawn on the device, so nothing extra is fetched or stored.
 */
import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';

export function Ticket({ code, title }: { code: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || qr) return;
    // A dark code on the white tile scans best in low light at the door.
    void toDataURL(code, { margin: 1, width: 400, errorCorrectionLevel: 'M', color: { dark: '#0A0B0C', light: '#FFFFFF' } }).then(setQr, () => setQr(null));
  }, [open, qr, code]);
  return (
    <div className="facts">
      Ticket code: <strong>{code}</strong>{' '}
      <button className="link" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide ticket' : 'Show ticket'}</button>
      {open ? (
        <div className="qr-row" style={{ marginTop: '0.8rem' }}>
          {qr ? <img className="qr" src={qr} alt={`QR code of ticket ${code} for ${title}`} width={200} height={200} /> : null}
          <p className="lede" style={{ margin: 0, maxWidth: '28ch' }}>Show this at the door. It is your ticket for {title}.</p>
        </div>
      ) : null}
    </div>
  );
}
