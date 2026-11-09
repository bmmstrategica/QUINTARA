'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAction, usePermission, useResource } from '@quintara/app-core';
import { deliveryFee, formatMoney, ORDER_STAGE_LABEL, ORDER_STAGES, ORDER_STATUS_LABEL, orderInputSchema, orderStageIndex } from '@quintara/domain';
import type { Order, OrderInput, Product } from '@quintara/domain';
import { ActionError, ResourceView } from '@/components/states';
import { Photo } from '@/components/media';
import { useSection } from '@/components/section-copy';

interface BagLine { product: Product; option: string; quantity: number }
const when = (iso: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const money = (minor: number, currency: string) => (minor === 0 ? 'No charge' : formatMoney(minor, currency));

export default function BoutiquePage() {
  const shop = useSection('boutique');
  const products = useResource((api) => api.listProducts());
  const canShop = usePermission('boutique.shop');
  const isMember = usePermission('directory.view');
  const orders = useResource((api) => (canShop ? api.listOrders() : Promise.resolve([])), [canShop]);
  const [bag, setBag] = useState<BagLine[]>([]);
  const [category, setCategory] = useState('');
  const [wishOnly, setWishOnly] = useState(false);
  const reload = () => { products.reload(); orders.reload(); };

  const add = (product: Product, option: string) => setBag((lines) => {
    const found = lines.find((l) => l.product.id === product.id && l.option === option);
    return found ? lines.map((l) => (l === found ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l)) : [...lines, { product, option, quantity: 1 }];
  });

  return (
    <>
      <div className="head">
        <div><h2>Maison Quintara</h2><p className="lede">{shop.description}</p><p style={{ margin: '0.6rem 0 0' }}><a href={process.env.NEXT_PUBLIC_MAISON_URL ?? 'http://localhost:3002'} target="_blank" rel="noopener noreferrer">Visit the Maison Quintara shop</a></p></div>
        <ResourceView resource={products}>
          {(list) => (
            <div className="row">
              {isMember ? <label className="check"><input type="checkbox" checked={wishOnly} onChange={(event) => setWishOnly(event.target.checked)} /> Wishlist only</label> : null}
              <label>Show
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="">Everything</option>
                  {[...new Set(list.map((p) => p.category))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
          )}
        </ResourceView>
      </div>
      <div className="detail" style={{ marginTop: 0 }}>
        <div>
          <ResourceView resource={products} isEmpty={(list) => list.length === 0} empty={<p className="muted">The shelves are being filled.</p>}>
            {(list) => {
              const shown = list.filter((p) => (!category || p.category === category) && (!wishOnly || p.wished));
              return shown.length ? shown.map((product) => <ProductItem key={product.id} product={product} canShop={canShop} isMember={isMember} onAdd={add} onChanged={products.reload} />) : <p className="muted">Nothing matches. {wishOnly ? 'Your wishlist is empty.' : ''}</p>;
            }}
          </ResourceView>
        </div>
        <aside className="aside">
          <Bag bag={bag} setBag={setBag} isMember={isMember} onOrdered={reload} />
          {isMember ? null : <p className="muted" style={{ fontSize: '0.9rem', marginTop: '1.5rem' }}>Members pay member prices and see pieces kept for members. <Link href="/apply">Apply for membership</Link> or <Link href="/sign-in">sign in</Link>.</p>}
        </aside>
      </div>
      {canShop ? <section className="panel" style={{ marginTop: '2.5rem' }}>
        <h3>Your orders</h3>
        <ResourceView resource={orders} isEmpty={(list) => list.length === 0} empty={<p className="muted" style={{ paddingTop: '0.8rem' }}>Orders appear here once you place one.</p>}>
          {(list) => list.map((order) => <OrderItem key={order.id} order={order} onChanged={reload} />)}
        </ResourceView>
      </section> : null}
    </>
  );
}

function ProductItem({ product: p, canShop, isMember, onAdd, onChanged }: { product: Product; canShop: boolean; isMember: boolean; onAdd: (product: Product, option: string) => void; onChanged: () => void }) {
  const [option, setOption] = useState(p.options[0] ?? '');
  const wish = useAction(async (api) => { await api.setWishlist(p.id, !p.wished); return true; });
  const soldOut = p.stock !== null && p.stock <= 0;
  return (
    <article className="item-row product-row">
      {p.imagePath ? <Photo path={p.imagePath} sizes="(max-width: 640px) 100vw, 10rem" className="product-photo" /> : <div aria-hidden="true" className="product-photo" style={{ background: 'var(--q-surface)' }} />}
      <div>
        <h3>{p.title}</h3>
        <p>{p.description}</p>
        <div className="facts row">
          <span className="tag">{p.category}</span>
          {p.membersOnly ? <span className="tag accent">Members only</span> : null}
          {p.maker ? <span>By {p.maker}.</span> : null}
          <span>{p.stock === null ? 'Made to order.' : soldOut ? 'Sold out.' : p.stock <= 3 ? `${p.stock} left.` : ''}</span>
        </div>
        <ActionError error={wish.error} />
      </div>
      <div className="actions">
        <strong style={{ fontWeight: 500 }}>{formatMoney(p.priceMinor, p.currency)}</strong>
        {p.publicPriceMinor ? <small className="muted">Member price. <s>{formatMoney(p.publicPriceMinor, p.currency)}</s></small> : null}
        {canShop && p.options.length ? <select aria-label={`Option for ${p.title}`} value={option} onChange={(event) => setOption(event.target.value)}>{p.options.map((o) => <option key={o}>{o}</option>)}</select> : null}
        {canShop ? <button className="btn small" disabled={soldOut} onClick={() => onAdd(p, option)}>{soldOut ? 'Sold out' : 'Add to bag'}</button> : null}
        {isMember ? <button className="link" disabled={wish.pending} onClick={async () => { if (await wish.run()) onChanged(); }}>{p.wished ? 'On your wishlist' : 'Add to wishlist'}</button> : null}
      </div>
    </article>
  );
}

function Bag({ bag, setBag, isMember, onOrdered }: { bag: BagLine[]; setBag: (update: (lines: BagLine[]) => BagLine[]) => void; isMember: boolean; onOrdered: () => void }) {
  const [guest, setGuest] = useState({ fullName: '', email: '' });
  const [address, setAddress] = useState('');
  const [problem, setProblem] = useState('');
  const create = useAction((api, input: OrderInput) => api.createOrder(input));
  const pay = useAction((api, id: string) => api.payOrder(id));
  const delivery = useResource((api) => api.listDeliveryOptions());
  const [chosen, setChosen] = useState('');
  const goods = bag.reduce((sum, l) => sum + l.product.priceMinor * l.quantity, 0);
  const currency = bag[0]?.product.currency ?? 'ZAR';
  // With one method on offer there is nothing to choose.
  const only = delivery.data?.length === 1 ? delivery.data[0]!.id : '';
  const picked = chosen || only;
  const method = delivery.data?.find((d) => d.id === picked) ?? null;
  const fee = method ? deliveryFee(method, goods) : 0, total = goods + fee;

  async function order() {
    const input = { items: bag.map((l) => ({ productId: l.product.id, option: l.option || undefined, quantity: l.quantity })), deliveryOptionId: picked, deliveryAddress: address, guest: isMember ? undefined : guest };
    const parsed = orderInputSchema.safeParse(input);
    if (!parsed.success) { setProblem(parsed.error.issues[0]?.message ?? 'Check your order'); return; }
    if (!isMember && (guest.fullName.trim().length < 2 || !guest.email.includes('@'))) { setProblem('Enter your name and email address'); return; }
    setProblem('');
    if (!window.confirm(`Place this order and pay ${formatMoney(total, currency)}?`)) return;
    const created = await create.run(input);
    if (!created) return;
    setBag(() => []);
    // If the payment fails the order stays under Your orders, where it can be paid or cancelled.
    await pay.run(created.id);
    onOrdered();
  }

  return (
    <div className="stack">
      <h3>Your bag</h3>
      {bag.length === 0 ? <p className="muted">Nothing in your bag yet.</p> : (
        <>
          {bag.map((l) => (
            <div className="panel-item" key={l.product.id + l.option}>
              <div><strong style={{ fontWeight: 500 }}>{l.product.title}</strong><small>{l.option ? `${l.option}. ` : ''}{l.quantity} at {formatMoney(l.product.priceMinor, l.product.currency)}</small></div>
              <button className="link" onClick={() => setBag((lines) => lines.filter((x) => x !== l))}>Remove</button>
            </div>
          ))}
          <fieldset>
            <legend>Delivery</legend>
            <ResourceView resource={delivery}>
              {(options) => <div className="stack" style={{ gap: '0.5rem' }}>{options.map((d) => (
                <label className="check" key={d.id} style={{ alignItems: 'flex-start' }}>
                  <input type="radio" name="delivery" checked={picked === d.id} onChange={() => setChosen(d.id)} style={{ width: 'auto', marginTop: 4 }} />
                  <span>{d.name}, {money(deliveryFee(d, goods), d.currency).toLowerCase()}<small className="muted" style={{ display: 'block' }}>{d.description}{d.freeOverMinor && goods < d.freeOverMinor ? ` Free over ${formatMoney(d.freeOverMinor, d.currency)}.` : ''}</small></span>
                </label>
              ))}</div>}
            </ResourceView>
          </fieldset>
          <dl><dt>Goods</dt><dd>{formatMoney(goods, currency)}</dd><dt>Delivery</dt><dd>{method ? money(fee, currency) : 'Choose a method'}</dd><dt>Total</dt><dd>{formatMoney(total, currency)}</dd></dl>
          {isMember ? null : (
            <>
              <label>Your name<input value={guest.fullName} maxLength={120} autoComplete="name" onChange={(event) => setGuest({ ...guest, fullName: event.target.value })} /></label>
              <label>Email address, for your order confirmation<input type="email" value={guest.email} maxLength={200} autoComplete="email" onChange={(event) => setGuest({ ...guest, email: event.target.value })} /></label>
            </>
          )}
          <label>Delivery address<textarea value={address} maxLength={500} onChange={(event) => setAddress(event.target.value)} placeholder="Street, suburb, city and postal code" /></label>
          {problem ? <span className="field-error" role="alert">{problem}</span> : null}
          <ActionError error={create.error ?? pay.error} />
          <div><button className="btn" disabled={create.pending || pay.pending} onClick={order}>{create.pending || pay.pending ? 'Placing your order' : `Order and pay ${formatMoney(total, currency)}`}</button></div>
          <p className="muted" style={{ fontSize: '0.9rem' }}>You can cancel for a full refund until the order is being prepared.</p>
        </>
      )}
    </div>
  );
}

function OrderItem({ order: o, onChanged }: { order: Order; onChanged: () => void }) {
  const pay = useAction((api) => api.payOrder(o.id));
  const cancel = useAction((api) => api.cancelOrder(o.id));
  const reached = orderStageIndex(o.status), step = o.status === 'cancelled' ? -1 : reached;
  const at = (stage: (typeof ORDER_STAGES)[number]) => (stage === 'placed' ? o.createdAt : [...o.timeline].reverse().find((e) => e.kind === stage)?.at);
  const told = o.timeline.filter((e) => e.note && e.kind !== 'cancelled' && e.kind !== 'refunded').at(-1);
  return (
    <div className="panel-item" style={{ alignItems: 'flex-start' }}>
      <div>
        <strong style={{ fontWeight: 500 }}>Order {o.orderNumber}</strong>
        <small>{o.items.map((i) => `${i.quantity} x ${i.title}${i.option ? ` (${i.option})` : ''}`).join(', ')}. {formatMoney(o.totalMinor, o.currency)}{o.deliveryLabel ? `, including ${o.deliveryFeeMinor ? formatMoney(o.deliveryFeeMinor, o.currency) : 'free'} delivery (${o.deliveryLabel})` : ''}.</small>
        {o.trackingNumber ? <small>{o.courier}, tracking number {o.trackingUrl ? <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer">{o.trackingNumber}</a> : o.trackingNumber}.</small> : null}
        {step >= 0 ? (
          <ol className="steps" aria-label="Progress">{ORDER_STAGES.map((s, i) => {
            const time = i <= step ? at(s) : undefined;
            return <li key={s} className={i <= step ? 'done' : i === step + 1 ? 'current' : ''}>{ORDER_STAGE_LABEL[s]}{time ? <small>{when(time)}</small> : null}</li>;
          })}</ol>
        ) : null}
        {o.receivedBy ? <small>Received by {o.receivedBy}.</small> : null}
        {told ? <small>{told.note}</small> : null}
        {o.status === 'cancelled' && o.timeline.some((e) => e.kind === 'cancelled' && e.note) ? <small>{o.timeline.filter((e) => e.kind === 'cancelled').at(-1)!.note}</small> : null}
        {o.status === 'cancelled' && o.refundedMinor ? <small>Refunded {formatMoney(o.refundedMinor, o.currency)}.</small> : null}
        <ActionError error={pay.error ?? cancel.error} />
      </div>
      <div className="row">
        {step < 0 || o.status === 'awaiting_payment' ? <span className={`tag ${o.status === 'awaiting_payment' ? 'accent' : ''}`}>{ORDER_STATUS_LABEL[o.status]}</span> : null}
        {o.status === 'awaiting_payment' ? <button className="btn small" disabled={pay.pending} onClick={async () => { if (window.confirm(`Pay ${formatMoney(o.totalMinor, o.currency)}?`) && (await pay.run())) onChanged(); }}>Pay</button> : null}
        {o.status === 'awaiting_payment' || o.status === 'paid' ? <button className="btn quiet small" disabled={cancel.pending} onClick={async () => { if (window.confirm(`Cancel order ${o.orderNumber}?`) && (await cancel.run())) onChanged(); }}>Cancel</button> : null}
      </div>
    </div>
  );
}
