'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAction, useResource } from '@quintara/app-core';
import type { PlanBookingPreview, PlanBookingResult, QeraDocument } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';

/** A plan QÉRA prepared, laid out as a Quintara document. Print, or save as a PDF, from the button. */
export default function QeraDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [version, setVersion] = useState(0);
  // Kept here, not in the booking panel, so it survives the document reloading after a booking.
  const [result, setResult] = useState<PlanBookingResult | null>(null);
  const loaded = useResource((api) => api.getQeraDocument(id), [id, version]);
  const remove = useAction(async (api) => { await api.deleteQeraDocument(id); return true; });
  return (
    <>
      <p className="no-print"><Link href="/qera" className="muted">Back to Q&Eacute;RA</Link></p>
      <ResourceView resource={loaded}>
        {(doc) => (
          <>
            <article className="doc" aria-label={doc.title}>
              <header className="doc-head">
                <img src="/quintara-emblem.png" alt="" />
                <img src="/quintara-wordmark.png" alt="Quintara" />
              </header>
              <p className="doc-eyebrow">Prepared by Q&Eacute;RA, the Quintara Intelligence</p>
              <h1>{doc.content.title}</h1>
              <p className="doc-sub">{doc.content.subtitle}</p>
              <p className="doc-for">For {doc.content.preparedFor}</p>
              {lineNumbers(doc).map(({ day, items }) => (
                <section key={day.date} className="doc-day">
                  <h2>{day.label}</h2>
                  {items.map(({ item, index }) => (
                    <div key={index} className="doc-item">
                      <span className="doc-time">{item.time}</span>
                      <div>
                        <strong>{item.title}</strong>
                        {item.detail ? <p>{item.detail}</p> : null}
                        {doc.booked?.[String(index)] ? <p className="doc-booked">Booked: {doc.booked[String(index)]}</p> : item.book ? <p className="doc-book">To book: book the whole plan below, or tell Q&Eacute;RA &ldquo;{item.book}&rdquo;</p> : null}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
              <div className="doc-foot">
                {doc.content.notes.map((note) => <p key={note}>{note}</p>)}
                <p>Quintara. A private membership. Prepared on {new Date(doc.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
              </div>
            </article>
            <div className="row no-print" style={{ marginTop: '1.5rem' }}>
              <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
              <Link className="btn quiet" href="/qera">Ask Q&Eacute;RA to book from this</Link>
              <button className="btn quiet" disabled={remove.pending} onClick={async () => { if (window.confirm('Delete this document?') && (await remove.run())) router.push('/qera'); }}>Delete</button>
            </div>
            <ActionError error={remove.error} />
            <BookThePlan documentId={doc.id} result={result} onBooked={(r) => { setResult(r); setVersion((n) => n + 1); }} />
          </>
        )}
      </ResourceView>
    </>
  );
}

/** Each line's number in the whole plan, which is how bookings are recorded against it. */
function lineNumbers(doc: QeraDocument) {
  let n = -1;
  return doc.content.days.map((day) => ({ day, items: day.items.map((item) => ({ item, index: ++n })) }));
}

/** Book the whole plan, or the lines the member keeps ticked, after seeing exactly what each will do. */
function BookThePlan({ documentId, result, onBooked }: { documentId: string; result: PlanBookingResult | null; onBooked: (r: PlanBookingResult) => void }) {
  const [partySize, setPartySize] = useState(2);
  const [version, setVersion] = useState(0);
  const [off, setOff] = useState<number[]>([]);
  const preview = useResource((api) => api.previewPlanBooking(documentId, partySize), [documentId, partySize, version]);
  const book = useAction((api, lines: number[]) => api.bookPlan(documentId, { partySize, lines }));
  return (
    <section className="panel no-print" style={{ marginTop: '2rem', maxWidth: '52rem' }} aria-label="Book the whole plan">
      <h3>Book the whole plan</h3>
      <p className="muted">Q&Eacute;RA books every ticked line at once, in your name, with the same checks as booking each yourself. Untick anything you would rather leave.</p>
      <label style={{ maxWidth: '12rem' }}>Number of guests<input type="number" min={1} max={20} value={partySize} onChange={(event) => { setPartySize(Math.max(1, Math.min(20, Number(event.target.value) || 1))); }} /></label>
      <ResourceView resource={preview}>
        {(p: PlanBookingPreview) => {
          const chosen = p.lines.filter((l) => l.bookable && !off.includes(l.index));
          return (
            <>
              <ul className="plan-lines">
                {p.lines.map((l) => (
                  <li key={l.index} className={l.bookable ? '' : 'off'}>
                    <input type="checkbox" aria-label={`Book ${l.title}`} disabled={!l.bookable} checked={l.bookable && !off.includes(l.index)} onChange={(event) => setOff(event.target.checked ? off.filter((i) => i !== l.index) : [...off, l.index])} />
                    <div><strong style={{ fontWeight: 500 }}>{l.title}</strong><small style={{ display: 'block' }}>{l.day}{l.time ? `, ${l.time}` : ''}. {l.status ? `Booked: ${l.status}` : l.action}</small></div>
                    <span className="muted" style={{ whiteSpace: 'nowrap' }}>{l.cost ?? ''}</span>
                  </li>
                ))}
              </ul>
              {p.notes.map((n) => <p key={n} className="muted" style={{ fontSize: '0.85rem', margin: '0.2rem 0' }}>{n}</p>)}
              <ActionError error={book.error} />
              {result ? (
                <div className="notice" role="status">
                  <p style={{ margin: 0 }}>{result.lines.filter((l) => l.ok).length} of {result.lines.length} booked.</p>
                  <ul style={{ margin: '0.5rem 0 0' }}>{result.lines.map((l) => <li key={l.index}>{l.title}: {l.text}</li>)}</ul>
                </div>
              ) : null}
              <div className="row" style={{ marginTop: '1rem' }}>
                <button className="btn" disabled={book.pending || !chosen.length} onClick={async () => {
                  if (!window.confirm(`Book ${chosen.length} line${chosen.length > 1 ? 's' : ''} of this plan for ${partySize}?\n\n${chosen.map((l) => `${l.title}: ${l.cost ?? 'request'}`).join('\n')}`)) return;
                  const done = await book.run(chosen.map((l) => l.index));
                  if (done) { setVersion((n) => n + 1); onBooked(done); }
                }}>{book.pending ? 'Booking' : chosen.length ? `Book ${chosen.length} line${chosen.length > 1 ? 's' : ''}` : 'Nothing left to book'}</button>
              </div>
            </>
          );
        }}
      </ResourceView>
    </section>
  );
}
