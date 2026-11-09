'use client';

/**
 * Maison Quintara orders, tracked from the moment they are placed: payment, processing, dispatch for delivery
 * and receipt. Each step records when it happened and who recorded it, and the buyer is told. Notes added here
 * stay with staff.
 */
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import type { StaffOrder } from '@quintara/api-client';
import { ORDER_STAGE_LABEL, ORDER_STAGES, ORDER_STATUS_LABEL, orderStageIndex } from '@quintara/domain';
import type { OrderEventKind, OrderStage, OrderStatus } from '@quintara/domain';
import { fmtDate, fmtMoney, Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

type Filter = 'open' | 'attention' | OrderStatus;
const HOUR = 3_600_000;
/** How long an order may sit at a step before it is flagged. */
const WAIT_LIMIT: Partial<Record<OrderStatus, [hours: number, what: string]>> = {
  paid: [24, 'Paid, not yet processing'],
  preparing: [72, 'Processing for more than 3 days'],
  dispatched: [168, 'With the courier for more than 7 days'],
};
const NEXT: Partial<Record<OrderStatus, [label: string, stage: OrderStage]>> = {
  paid: ['Start processing', 'preparing'], preparing: ['Dispatch for delivery', 'dispatched'], dispatched: ['Confirm received', 'delivered'],
};
const EVENT_LABEL: Record<OrderEventKind, string> = { ...ORDER_STAGE_LABEL, cancelled: 'Cancelled', refunded: 'Refunded', note: 'Staff note' };

const lastAt = (o: StaffOrder, kind: OrderEventKind) => [...o.history].reverse().find((e) => e.kind === kind);
/** When the order reached the step it is at. */
const since = (o: StaffOrder) => {
  const kind: OrderEventKind = o.status === 'awaiting_payment' ? 'placed' : (o.status as OrderEventKind);
  return new Date(lastAt(o, kind)?.at ?? o.updatedAt).getTime();
};
const waiting = (o: StaffOrder, now: number) => {
  const limit = WAIT_LIMIT[o.status];
  return limit && now - since(o) > limit[0] * HOUR ? limit[1] : null;
};
const lapsed = (o: StaffOrder, now: number) => o.status === 'awaiting_payment' && o.payBy !== null && new Date(o.payBy).getTime() < now;
function ago(iso: string, now: number) {
  const h = (now - new Date(iso).getTime()) / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export default function OrdersPage() {
  const orders = useLoad((client) => client.listOrders());
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [now] = useState(() => Date.now());
  return (
    <>
      <div>
        <h1>Maison orders</h1>
        <p className="lede">Every order from the Quintara apps and the Maison Quintara shop, from the moment it is placed until it is received. Record each step as it happens: the buyer is told at once. Notes stay with staff.</p>
        <p><Link href="/boutique">Pieces, prices and delivery methods</Link></p>
      </div>
      <Loaded state={orders}>
        {(list) => <Board list={list} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} now={now} reload={orders.reload} />}
      </Loaded>
    </>
  );
}

function Board({ list, filter, setFilter, search, setSearch, now, reload }: { list: StaffOrder[]; filter: Filter; setFilter: (f: Filter) => void; search: string; setSearch: (s: string) => void; now: number; reload: () => void }) {
  const count = (f: Filter) => list.filter((o) => matches(o, f, now)).length;
  const tiles: [Filter, string][] = [
    ['open', 'All open'], ['attention', 'Needs attention'], ['awaiting_payment', 'Placed, awaiting payment'], ['paid', 'Paid, to process'], ['preparing', 'Processing'], ['dispatched', 'Dispatched for delivery'], ['delivered', 'Received'], ['cancelled', 'Cancelled'],
  ];
  const term = search.trim().toLowerCase();
  const shown = useMemo(() => list.filter((o) => matches(o, filter, now) && (!term || [o.orderNumber, o.deliveryName, o.contactEmail ?? '', o.trackingNumber ?? '', ...o.items.map((i) => i.title)].some((v) => v.toLowerCase().includes(term)))), [list, filter, term, now]);
  return (
    <>
      <div className="pipeline" role="group" aria-label="Orders by step">
        {tiles.map(([key, label]) => {
          const n = count(key);
          return <button key={key} type="button" aria-pressed={filter === key} className={key === 'attention' && n > 0 ? 'alert' : ''} onClick={() => setFilter(key)}><b>{n}</b>{label}</button>;
        })}
      </div>
      <div className="toolbar">
        <h2>{tiles.find(([key]) => key === filter)?.[1]}</h2>
        <input type="search" aria-label="Find an order" placeholder="Order number, name, piece or tracking number" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {shown.length === 0 ? <p className="note">{list.length === 0 ? 'No orders yet. Orders placed in the apps or on the Maison Quintara shop appear here as soon as they are placed.' : 'No orders here.'}</p> : (
        <div className="orders">{shown.map((o) => <OrderCard key={o.id} order={o} now={now} onChanged={reload} />)}</div>
      )}
    </>
  );
}

function matches(o: StaffOrder, f: Filter, now: number) {
  if (f === 'open') return ['awaiting_payment', 'paid', 'preparing', 'dispatched'].includes(o.status) && !lapsed(o, now);
  if (f === 'attention') return waiting(o, now) !== null;
  if (f === 'awaiting_payment') return o.status === 'awaiting_payment' && !lapsed(o, now);
  if (f === 'cancelled') return o.status === 'cancelled' || lapsed(o, now);
  return o.status === f;
}

function OrderCard({ order: o, now, onChanged }: { order: StaffOrder; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(false);
  const reached = orderStageIndex(o.status), cancelled = o.status === 'cancelled', late = waiting(o, now), gone = lapsed(o, now);
  const next = NEXT[o.status];
  // For a cancelled order, the steps it had reached before it was cancelled.
  const reachedBefore = cancelled ? Math.max(...ORDER_STAGES.map((s, i) => (lastAt(o, s) ? i : -1))) : reached;
  return (
    <article className={`order${late ? ' attention' : ''}`} aria-label={`Order ${o.orderNumber}`}>
      <div className="order-head">
        <div>
          <h3>{o.orderNumber}</h3>
          <span className="buyer">{o.deliveryName} · {o.buyer === 'member' ? 'Member' : 'Guest'} · placed {fmtDate(o.createdAt)}</span>
        </div>
        <div className="sum">
          <span>{fmtMoney(o.totalMinor, o.currency)}</span>
          <span className={`chip ${o.status === 'delivered' ? 'ok' : cancelled || gone ? '' : 'gold'}`}>{gone ? 'Lapsed, not paid' : ORDER_STATUS_LABEL[o.status]}</span>
          {late ? <span className="chip gold" title={late}>{late}, {ago(new Date(since(o)).toISOString(), now).replace(' ago', '')}</span> : null}
        </div>
      </div>

      <ol className={`tracker${cancelled || gone ? ' cancelled' : ''}`} aria-label="Progress">
        {ORDER_STAGES.map((stage, i) => {
          const event = stage === 'placed' ? { at: o.createdAt, by: 'Buyer' } : lastAt(o, stage);
          const done = i <= reachedBefore, current = !cancelled && !gone && i === reached + 1;
          return (
            <li key={stage} className={done ? 'done' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
              <b>{ORDER_STAGE_LABEL[stage]}</b>
              {done && event ? <small>{fmtDate(event.at)}{event.by !== 'Buyer' && event.by !== 'Quintara' ? `, ${event.by}` : ''}</small> : current ? <small>{stage === 'paid' && o.payBy ? `Due by ${fmtDate(o.payBy)}` : 'Next'}</small> : null}
              {stage === 'dispatched' && done && o.trackingNumber ? <small>{o.courier}, {o.trackingNumber}</small> : null}
              {stage === 'delivered' && done && o.receivedBy ? <small>By {o.receivedBy}</small> : null}
            </li>
          );
        })}
      </ol>
      {cancelled ? <p className="note">Cancelled {fmtDate(lastAt(o, 'cancelled')?.at ?? o.updatedAt)}{lastAt(o, 'cancelled')?.note ? `: ${lastAt(o, 'cancelled')!.note}` : ''}{o.refundedMinor ? ` ${fmtMoney(o.refundedMinor, o.currency)} refunded.` : ''}</p> : null}

      <div className="row">
        {next && !step ? <button className="btn" onClick={() => setStep(true)}>{next[0]}</button> : null}
        <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details and history'}</button>
      </div>
      {next && step ? <StepForm order={o} stage={next[1]} label={next[0]} onClose={() => setStep(false)} onChanged={onChanged} /> : null}
      {open ? <Details order={o} onChanged={onChanged} /> : null}
    </article>
  );
}

function StepForm({ order: o, stage, label, onClose, onChanged }: { order: StaffOrder; stage: OrderStage; label: string; onClose: () => void; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [courier, setCourier] = useState(o.courier ?? '');
  const [tracking, setTracking] = useState('');
  const [link, setLink] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [note, setNote] = useState('');
  const ready = stage === 'dispatched' ? courier.trim().length >= 2 && tracking.trim().length >= 3 : stage === 'delivered' ? receivedBy.trim().length >= 2 : true;
  function record(event: React.FormEvent) {
    event.preventDefault();
    const told = stage === 'preparing' ? 'that their order is being processed' : stage === 'dispatched' ? `that it is on its way with ${courier.trim()}, tracking number ${tracking.trim()}` : `that it was received by ${receivedBy.trim()}`;
    if (!window.confirm(`${label} for order ${o.orderNumber}? ${o.deliveryName} will be told ${told}.`)) return;
    void run(() => api.advanceOrder(o.id, {
      note: note.trim() || undefined,
      ...(stage === 'dispatched' ? { courier: courier.trim(), trackingNumber: tracking.trim(), trackingUrl: link.trim() || null } : {}),
      ...(stage === 'delivered' ? { receivedBy: receivedBy.trim() } : {}),
    }), () => { onClose(); onChanged(); });
  }
  return (
    <form className="step-form" aria-label={label} onSubmit={record}>
      {stage === 'dispatched' ? (
        <div className="form">
          <label>Courier<input value={courier} onChange={(event) => setCourier(event.target.value)} required minLength={2} maxLength={80} placeholder="The Courier Guy" /></label>
          <label>Tracking number<input value={tracking} onChange={(event) => setTracking(event.target.value)} required minLength={3} maxLength={80} /></label>
          <label>Tracking link (optional)<input type="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" maxLength={300} /></label>
        </div>
      ) : null}
      {stage === 'delivered' ? <label>Received by<input value={receivedBy} onChange={(event) => setReceivedBy(event.target.value)} required minLength={2} maxLength={120} placeholder="Name of whoever took the parcel in" /></label> : null}
      <label>Note for the buyer (optional)<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={stage === 'preparing' ? 'Being wrapped by the atelier' : stage === 'dispatched' ? 'Expected on Thursday' : 'Signed for at the front desk'} /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn" disabled={pending || !ready}>{pending ? 'Saving' : label}</button>
        <button type="button" className="btn ghost" disabled={pending} onClick={onClose}>Back</button>
      </div>
    </form>
  );
}

function Details({ order: o, onChanged }: { order: StaffOrder; onChanged: () => void }) {
  const { api } = useAdmin();
  const note = useRun(), cancel = useRun();
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const cancellable = ['awaiting_payment', 'paid', 'preparing'].includes(o.status);
  return (
    <div className="order-body">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section>
          <h4>Pieces</h4>
          <dl>
            {o.items.map((i) => <Fragment key={i.title + i.option}><dt>{i.quantity} ×</dt><dd>{i.title}{i.option ? ` (${i.option})` : ''}, {fmtMoney(i.unitPriceMinor * i.quantity, o.currency)}</dd></Fragment>)}
            <dt>Delivery</dt><dd>{o.deliveryFeeMinor ? fmtMoney(o.deliveryFeeMinor, o.currency) : 'Free'}{o.deliveryLabel ? `, ${o.deliveryLabel}` : ''}</dd>
            <dt>Total</dt><dd>{fmtMoney(o.totalMinor, o.currency)}{o.refundedMinor ? `, ${fmtMoney(o.refundedMinor, o.currency)} refunded` : ''}</dd>
          </dl>
        </section>
        <section>
          <h4>Delivery</h4>
          <dl>
            <dt>To</dt><dd>{o.deliveryName}</dd>
            <dt>Address</dt><dd style={{ whiteSpace: 'pre-line' }}>{o.deliveryAddress}</dd>
            {o.contactEmail ? <><dt>Email</dt><dd><a href={`mailto:${o.contactEmail}`}>{o.contactEmail}</a></dd></> : <><dt>Contact</dt><dd>A member: reached through the Quintara app.</dd></>}
            {o.trackingNumber ? <><dt>Courier</dt><dd>{o.courier}, {o.trackingUrl ? <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer">{o.trackingNumber}</a> : o.trackingNumber}</dd></> : null}
            {o.receivedBy ? <><dt>Received by</dt><dd>{o.receivedBy}</dd></> : null}
          </dl>
        </section>
        {cancellable ? (
          <section>
            <h4>Cancel this order</h4>
            <form className="step-form" aria-label="Cancel this order" onSubmit={(event) => {
              event.preventDefault();
              if (!window.confirm(`Cancel order ${o.orderNumber}?${o.status === 'awaiting_payment' ? '' : ` ${fmtMoney(o.totalMinor, o.currency)} will be refunded in full.`} ${o.deliveryName} will be told the reason. This cannot be undone.`)) return;
              void cancel.run(() => api.cancelOrder(o.id, reason.trim()), onChanged);
            }}>
              <label>Reason, sent to the buyer<input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={500} placeholder="The atelier cannot make this piece in time" /></label>
              {cancel.error ? <p className="error" role="alert">{cancel.error}</p> : null}
              <div><button className="btn ghost" disabled={cancel.pending || reason.trim().length < 5}>{o.status === 'awaiting_payment' ? 'Cancel order' : 'Cancel and refund'}</button></div>
            </form>
          </section>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4>History</h4>
        <ol className="history">
          {o.history.map((e, i) => (
            <li key={i} className={e.kind === 'note' ? 'note' : ''}>
              <b style={{ fontWeight: 500 }}>{EVENT_LABEL[e.kind]}</b>{e.note ? `: ${e.note}` : ''}
              <small>{fmtDate(e.at)}, {e.by === 'Buyer' ? 'by the buyer' : e.by === 'Quintara' ? 'automatically' : `by ${e.by}`}{e.kind === 'note' ? '. Staff only' : ''}</small>
            </li>
          ))}
        </ol>
        <form className="composer" aria-label="Add a note" onSubmit={(event) => { event.preventDefault(); void note.run(() => api.addOrderNote(o.id, text.trim()), () => { setText(''); onChanged(); }); }}>
          <textarea aria-label="Note for staff" placeholder="A note for staff: a call, a request, an issue with the courier" value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} />
          <button className="btn ghost" disabled={note.pending || text.trim().length < 2}>Add note</button>
        </form>
        {note.error ? <p className="error" role="alert">{note.error}</p> : null}
      </div>
    </div>
  );
}
