'use client';

import { useEffect, useMemo, useState } from 'react';
import { ApiError, useAction, usePermission, useResource, useSecondStep, useSession } from '@quintara/app-core';
import { deliveryFee, formatMoney, ORDER_STAGE_LABEL, ORDER_STAGES, orderInputSchema, orderStageIndex, photoSrcSet, photoUrl, sectionText } from '@quintara/domain';
import type { Order, Product, TwoFactorSetup } from '@quintara/domain';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const WEBSITE = 'https://quintaralifestyle.com';
const BAG_KEY = 'maison.bag';

interface Line { productId: string; option: string; quantity: number }
type Sheet = { kind: 'piece'; id: string } | { kind: 'bag' } | { kind: 'signin' } | { kind: 'done'; order: Order } | { kind: 'orders' } | null;

const readBag = (): Line[] => { try { return JSON.parse(window.localStorage.getItem(BAG_KEY) ?? '[]') as Line[]; } catch { return []; } };
const keepBag = (lines: Line[]) => { try { window.localStorage.setItem(BAG_KEY, JSON.stringify(lines)); } catch { /* private browsing: the bag lasts this visit */ } };

/**
 * The photograph of a piece, or the Quintara emblem on stone while there is none. The browser is offered every
 * stored width and picks the sharpest for the space and the screen (`sizes`), so retina screens get full detail.
 */
function Picture({ product, eager = false, sizes }: { product: Product | null; eager?: boolean; sizes: string }) {
  if (product?.imagePath) {
    return /^(data:|https?:|blob:)/.test(product.imagePath)
      ? <img className="picture" src={product.imagePath} alt={product.title} loading={eager ? 'eager' : 'lazy'} decoding="async" />
      : <img className="picture" src={photoUrl(API_URL, product.imagePath, 1440)} srcSet={photoSrcSet(API_URL, product.imagePath)} sizes={sizes} alt={product.title} loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined} />;
  }
  // Until a photograph is added in the admin console, each piece gets one of the maison's tones.
  const tone = product ? [...product.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 5 : 0;
  return <div className={`placeholder tone-${tone}`} role="img" aria-label={product ? product.title : 'Maison Quintara'}><img src="/quintara-emblem.png" alt="" /></div>;
}

export default function MaisonPage() {
  const { session, guest, secondStep } = useSession();
  const isMember = usePermission('directory.view');
  const products = useResource((api) => api.listProducts());
  // Orders placed from this browser, as a member or as a guest; empty for a first visit.
  const mine = useResource((api) => api.listOrders(), [session?.userId]);
  const hasOrders = Boolean(session) || (mine.data?.length ?? 0) > 0;
  const copy = useResource((api) => api.listSectionCopy());
  const intro = sectionText(copy.data, 'boutique');
  const [category, setCategory] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [bag, setBag] = useState<Line[]>([]);
  useEffect(() => { setBag(readBag()); }, []);
  const changeBag = (next: Line[]) => { setBag(next); keepBag(next); };

  const list = products.data ?? [];
  // The bag keeps only what is still on the shelves for this viewer; prices are always today's.
  const lines = bag.map((l) => ({ ...l, product: list.find((p) => p.id === l.productId) })).filter((l): l is Line & { product: Product } => Boolean(l.product));
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const featured = list.find((p) => p.imagePath) ?? list[0] ?? null;
  const categories = useMemo(() => [...new Set(list.map((p) => p.category))].sort(), [list]);
  const shown = list.filter((p) => !category || p.category === category);

  useEffect(() => {
    if (!sheet) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSheet(null); };
    window.addEventListener('keydown', close);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', close); document.body.style.overflow = ''; };
  }, [sheet]);

  const add = (product: Product, option: string, quantity: number) => {
    const found = bag.find((l) => l.productId === product.id && l.option === option);
    changeBag(found ? bag.map((l) => (l === found ? { ...l, quantity: Math.min(20, l.quantity + quantity) } : l)) : [...bag, { productId: product.id, option, quantity }]);
    setSheet({ kind: 'bag' });
  };

  return (
    <>
      <header className="bar">
        <a className="mark" href="#top" aria-label="Maison Quintara, top of the page"><img src="/quintara-emblem.png" alt="" /><span className="brandname">Maison <img className="word" src="/quintara-wordmark.png" alt="Quintara" /></span></a>
        <nav aria-label="Maison">
          <a className="textbtn hide-sm" href="#collection">The collection</a>
          {hasOrders ? <button className="textbtn" onClick={() => setSheet({ kind: 'orders' })}>Your orders</button> : null}
          {session || guest ? null : <button className={`textbtn${hasOrders ? ' hide-sm' : ''}`} onClick={() => setSheet({ kind: 'signin' })}>Members sign in</button>}
          <button className="bagbtn" onClick={() => setSheet({ kind: 'bag' })} aria-label={`Your bag, ${count} ${count === 1 ? 'piece' : 'pieces'}`}>Bag <b>{count}</b></button>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="maison-title">
          <div>
            <h1 id="maison-title" className="brandname" aria-label="Maison Quintara">Maison <img className="word" src="/quintara-wordmark.png" alt="" /></h1>
            <p>{intro.description}</p>
            <div className="actions">
              <a className="btn light" href="#collection">See the collection</a>
              {isMember ? <span style={{ fontSize: '0.95rem' }}>Welcome back, {session?.fullName.split(' ')[0]}. Your member prices are shown.</span> : null}
            </div>
          </div>
          <figure className="vitrine">
            <div className="arch"><Picture product={featured} eager sizes="(max-width: 820px) 92vw, 40vw" /></div>
            {featured ? (
              <figcaption>
                <span><b>{featured.title}</b><br />{featured.maker}</span>
                <button className="textbtn" onClick={() => setSheet({ kind: 'piece', id: featured.id })}>View the piece</button>
              </figcaption>
            ) : <figcaption><span>The first pieces arrive soon.</span></figcaption>}
          </figure>
        </section>

        <section className="collection" id="collection" aria-labelledby="collection-title">
          <header>
            <div>
              <h2 id="collection-title">The collection</h2>
              <p>{isMember ? 'Including the pieces kept for members, at member prices.' : 'Members see pieces kept for them, and pay member prices.'} Delivered by courier across South Africa.</p>
            </div>
            {categories.length > 1 ? (
              <div className="filters" role="group" aria-label="Show">
                <button aria-pressed={category === ''} onClick={() => setCategory('')}>Everything</button>
                {categories.map((c) => <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
              </div>
            ) : null}
          </header>
          {products.status === 'loading' ? <p className="empty" role="status">Opening the shelves</p> : null}
          {products.status === 'error' ? <p className="empty" role="alert">The collection could not be loaded. <button className="textbtn" onClick={products.reload}>Try again</button></p> : null}
          {products.status === 'ready' && shown.length === 0 ? <p className="empty">The shelves are being filled. New pieces are added by the Quintara team.</p> : null}
          <div className="grid">
            {shown.map((p) => {
              const soldOut = p.stock !== null && p.stock <= 0;
              const flag = soldOut ? 'Sold out' : p.membersOnly ? 'Kept for members' : p.stock !== null && p.stock <= 3 ? `${p.stock} left` : p.stock === null ? 'Made to order' : null;
              return (
                <button key={p.id} className="piece" onClick={() => setSheet({ kind: 'piece', id: p.id })} aria-label={`${p.title} by ${p.maker}, ${formatMoney(p.priceMinor, p.currency)}`}>
                  <div className="arch"><Picture product={p} sizes="(max-width: 560px) 92vw, (max-width: 1100px) 46vw, 31vw" />{flag ? <span className="flag">{flag}</span> : null}</div>
                  <h3>{p.title}</h3>
                  <span className="meta"><span>{p.maker}</span><span className="price">{formatMoney(p.priceMinor, p.currency)}</span></span>
                </button>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="foot">
        <div><b className="lockup brandname" aria-label="Maison Quintara">Maison <img className="word" src="/quintara-wordmark.png" alt="" /></b><p>Part of Quintara, the private membership for founders, investors, creatives and executives.</p></div>
        <div><h3>Ordering</h3><p>Delivered by courier across South Africa.</p><p>Cancel for a full refund until your order is being prepared.</p></div>
        <div><h3>Quintara</h3><p><a href={APP_URL}>The Quintara app</a></p><p><a href={`${APP_URL}/apply`}>Apply for membership</a></p><p><a href={WEBSITE} target="_blank" rel="noopener noreferrer">About Quintara</a></p></div>
      </footer>

      {secondStep ? (
        <div className="scrim"><SecondStepSheet step={secondStep} /></div>
      ) : null}
      {sheet && !secondStep ? (
        <div className="scrim" onClick={(event) => { if (event.target === event.currentTarget) setSheet(null); }}>
          {sheet.kind === 'piece' ? <PieceSheet product={list.find((p) => p.id === sheet.id) ?? null} isMember={isMember} onAdd={add} onClose={() => setSheet(null)} onChanged={products.reload} /> : null}
          {sheet.kind === 'bag' ? <BagSheet lines={lines} isMember={isMember} onChange={changeBag} onClose={() => setSheet(null)} onOrdered={(order) => { changeBag([]); products.reload(); mine.reload(); setSheet({ kind: 'done', order }); }} /> : null}
          {sheet.kind === 'signin' ? <SignInSheet onClose={() => setSheet(null)} /> : null}
          {sheet.kind === 'done' ? <DoneSheet order={sheet.order} isMember={isMember} onClose={() => setSheet(null)} onFollow={() => setSheet({ kind: 'orders' })} /> : null}
          {sheet.kind === 'orders' ? <OrdersSheet isMember={isMember} onClose={() => setSheet(null)} /> : null}
        </div>
      ) : null}
    </>
  );
}

function PieceSheet({ product: p, isMember, onAdd, onClose, onChanged }: { product: Product | null; isMember: boolean; onAdd: (p: Product, option: string, quantity: number) => void; onClose: () => void; onChanged: () => void }) {
  const [option, setOption] = useState(p?.options[0] ?? '');
  const [quantity, setQuantity] = useState(1);
  const wish = useAction(async (api) => { if (p) await api.setWishlist(p.id, !p.wished); return true; });
  if (!p) return <div className="sheet" role="dialog" aria-modal="true" aria-label="Piece"><button className="textbtn close" onClick={onClose}>Close</button><p>This piece is no longer on the shelves.</p></div>;
  const soldOut = p.stock !== null && p.stock <= 0;
  const max = p.stock === null ? 20 : Math.max(1, Math.min(20, p.stock));
  return (
    <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="piece-title">
      <button className="textbtn close" onClick={onClose}>Close</button>
      <div className="detail">
        <div className="arch"><Picture product={p} eager sizes="(max-width: 820px) 92vw, 46vw" /></div>
        <div>
          <h2 id="piece-title">{p.title}</h2>
          <p className="maker">By {p.maker}. {p.category}.</p>
          <div className="price-line">
            <span>{formatMoney(p.priceMinor, p.currency)}</span>
            {p.publicPriceMinor ? <><s>{formatMoney(p.publicPriceMinor, p.currency)}</s><span className="note">Your member price</span></> : null}
          </div>
          <p style={{ margin: '0 0 1.4rem' }}>{p.description}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            {p.options.length > 1 ? (
              <div className="field"><span id="opt-label">Choose</span>
                <div className="options" role="group" aria-labelledby="opt-label">{p.options.map((o) => <button key={o} aria-pressed={option === o} onClick={() => setOption(o)}>{o}</button>)}</div>
              </div>
            ) : null}
            <div className="field"><span>Quantity</span>
              <div className="qty"><button aria-label="One fewer" onClick={() => setQuantity((n) => Math.max(1, n - 1))}>−</button><span aria-live="polite">{quantity}</span><button aria-label="One more" onClick={() => setQuantity((n) => Math.min(max, n + 1))}>+</button></div>
            </div>
            <button className="btn wide" disabled={soldOut} onClick={() => onAdd(p, option, quantity)}>{soldOut ? 'Sold out' : 'Add to bag'}</button>
            {isMember ? <button className="textbtn" style={{ alignSelf: 'flex-start' }} disabled={wish.pending} onClick={async () => { if (await wish.run()) onChanged(); }}>{p.wished ? 'On your wishlist. Remove it' : 'Add to your wishlist'}</button> : null}
            {wish.error ? <p className="error" role="alert">{wish.error.message}</p> : null}
            <p className="note">{p.stock === null ? 'Made to order for you.' : soldOut ? 'Sold out for now.' : `${p.stock} available.`} Delivered by courier across South Africa.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function BagSheet({ lines, isMember, onChange, onClose, onOrdered }: { lines: (Line & { product: Product })[]; isMember: boolean; onChange: (next: Line[]) => void; onClose: () => void; onOrdered: (order: Order) => void }) {
  const delivery = useResource((api) => api.listDeliveryOptions());
  const [chosen, setChosen] = useState('');
  const [guest, setGuest] = useState({ fullName: '', email: '' });
  const [address, setAddress] = useState('');
  const [problem, setProblem] = useState('');
  const create = useAction((api, input: Parameters<typeof api.createOrder>[0]) => api.createOrder(input));
  const pay = useAction((api, id: string) => api.payOrder(id));
  const goods = lines.reduce((n, l) => n + l.product.priceMinor * l.quantity, 0);
  const currency = lines[0]?.product.currency ?? 'ZAR';
  const options = delivery.data ?? [];
  const picked = chosen || (options.length === 1 ? options[0]!.id : '');
  const method = options.find((d) => d.id === picked) ?? null;
  const fee = method ? deliveryFee(method, goods) : 0;
  const total = goods + fee;
  const plain = (next: (Line & { product: Product })[]) => next.map(({ productId, option, quantity }) => ({ productId, option, quantity }));

  async function order() {
    const input = { items: lines.map((l) => ({ productId: l.productId, option: l.option || undefined, quantity: l.quantity })), deliveryOptionId: picked, deliveryAddress: address, guest: isMember ? undefined : guest };
    const parsed = orderInputSchema.safeParse(input);
    if (!parsed.success) { setProblem(parsed.error.issues[0]?.message ?? 'Check your order'); return; }
    if (!isMember && (guest.fullName.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(guest.email))) { setProblem('Enter your name and email address'); return; }
    setProblem('');
    if (!window.confirm(`Place this order and pay ${formatMoney(total, currency)}?`)) return;
    const created = await create.run(input);
    if (!created) return;
    const paid = await pay.run(created.id);
    onOrdered(paid ?? created);
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="bag-title">
      <button className="textbtn close" onClick={onClose}>Close</button>
      <h2 id="bag-title" style={{ fontSize: '2.2rem' }}>Your bag</h2>
      {lines.length === 0 ? <p className="note">Your bag is empty. <button className="textbtn" onClick={onClose}>See the collection</button></p> : (
        <>
          <div>
            {lines.map((l) => (
              <div className="bagline" key={l.productId + l.option}>
                <div className="arch"><Picture product={l.product} sizes="96px" /></div>
                <div><b>{l.product.title}</b><small>{l.option ? `${l.option}. ` : ''}{formatMoney(l.product.priceMinor, l.product.currency)} each</small>
                  <div className="qty" style={{ marginTop: '0.5rem' }}>
                    <button aria-label={`One fewer ${l.product.title}`} onClick={() => onChange(plain(lines.map((x) => (x === l ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))))}>−</button>
                    <span>{l.quantity}</span>
                    <button aria-label={`One more ${l.product.title}`} onClick={() => onChange(plain(lines.map((x) => (x === l ? { ...x, quantity: Math.min(20, x.quantity + 1) } : x))))}>+</button>
                  </div>
                </div>
                <button className="textbtn" onClick={() => onChange(plain(lines.filter((x) => x !== l)))}>Remove</button>
              </div>
            ))}
          </div>
          <fieldset className="delivery">
            <legend>Delivery</legend>
            {options.map((d) => (
              <label key={d.id}><input type="radio" name="delivery" checked={picked === d.id} onChange={() => setChosen(d.id)} />
                <span>{d.name}, {deliveryFee(d, goods) === 0 ? 'free' : formatMoney(deliveryFee(d, goods), d.currency)}<small>{d.description}{d.freeOverMinor && goods < d.freeOverMinor ? ` Free over ${formatMoney(d.freeOverMinor, d.currency)}.` : ''}</small></span>
              </label>
            ))}
          </fieldset>
          <dl className="totals">
            <dt>Pieces</dt><dd>{formatMoney(goods, currency)}</dd>
            <dt>Delivery</dt><dd>{method ? (fee ? formatMoney(fee, currency) : 'Free') : 'Choose a method'}</dd>
            <dt>Total</dt><dd className="total">{formatMoney(total, currency)}</dd>
          </dl>
          {isMember ? null : (
            <>
              <label className="field">Your name<input value={guest.fullName} maxLength={120} autoComplete="name" onChange={(event) => setGuest({ ...guest, fullName: event.target.value })} /></label>
              <label className="field">Email address, for your confirmation and tracking<input type="email" value={guest.email} maxLength={200} autoComplete="email" onChange={(event) => setGuest({ ...guest, email: event.target.value })} /></label>
            </>
          )}
          <label className="field">Delivery address<textarea value={address} maxLength={500} autoComplete="street-address" placeholder="Street, suburb, city and postal code" onChange={(event) => setAddress(event.target.value)} /></label>
          {problem ? <p className="error" role="alert">{problem}</p> : null}
          {create.error ?? pay.error ? <p className="error" role="alert">{(create.error ?? pay.error)!.message}</p> : null}
          <button className="btn wide" disabled={create.pending || pay.pending} onClick={order}>{create.pending || pay.pending ? 'Placing your order' : `Order and pay ${formatMoney(total, currency)}`}</button>
          <p className="note">You can cancel for a full refund until your order is being prepared. Card details are handled by the payment provider and never stored by Quintara.</p>
        </>
      )}
    </div>
  );
}

function SignInSheet({ onClose }: { onClose: () => void }) {
  const { signIn, authMethod, requestCode } = useSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setPending(true);
    try {
      if (authMethod === 'code' && !sent) { await requestCode(email.trim()); setSent(true); return; }
      await signIn(email.trim(), authMethod === 'code' ? code : undefined);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Signing in did not work. Try again.');
    } finally { setPending(false); }
  }
  return (
    <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="signin-title" onSubmit={submit} noValidate>
      <button type="button" className="textbtn close" onClick={onClose}>Close</button>
      <h2 id="signin-title" style={{ fontSize: '2.2rem' }}>Members sign in</h2>
      <p className="note">Members see the pieces kept for them, pay member prices and keep a wishlist. It is the same account as the Quintara app.</p>
      <label className="field">Email address<input type="email" autoComplete="email" value={email} readOnly={sent} onChange={(event) => setEmail(event.target.value)} /></label>
      {sent ? <label className="field">The six-digit code we emailed you<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /></label> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn wide" disabled={pending || (sent && code.length !== 6)}>{pending ? 'One moment' : authMethod === 'code' && !sent ? 'Send me a code' : 'Sign in'}</button>
      <p className="note">Not a member? You can order as a guest, or <a href={`${APP_URL}/apply`}>apply for membership</a>.</p>
    </form>
  );
}

function DoneSheet({ order, isMember, onClose, onFollow }: { order: Order; isMember: boolean; onClose: () => void; onFollow: () => void }) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="done-title">
      <button className="textbtn close" onClick={onClose}>Close</button>
      <div className="done">
        <div className="arch"><img src="/quintara-emblem.png" alt="" /></div>
        <h2 id="done-title">Thank you</h2>
        <p>Order {order.orderNumber}, {formatMoney(order.totalMinor, order.currency)}. {order.status === 'paid' ? 'It is paid and is being prepared.' : 'It is waiting for payment.'}</p>
        <p className="note">{isMember ? 'Follow it here under Your orders, or in the Quintara app under Maison Quintara.' : 'Follow it here under Your orders, on this device. We will also email you when it is on its way, with the tracking number.'}</p>
        <div className="done-actions"><button className="btn" onClick={onFollow}>Follow your order</button><button className="btn ghost" onClick={onClose}>Keep looking</button></div>
      </div>
    </div>
  );
}

const when = (iso: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** The buyer's orders, each followed step by step from placement to receipt. */
function OrdersSheet({ isMember, onClose }: { isMember: boolean; onClose: () => void }) {
  const orders = useResource((api) => api.listOrders());
  const list = orders.data ?? [];
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="orders-title">
      <button className="textbtn close" onClick={onClose}>Close</button>
      <h2 id="orders-title" style={{ fontSize: '2.2rem' }}>Your orders</h2>
      {orders.status === 'loading' ? <p className="note" role="status">One moment</p> : list.length === 0 ? <p className="note">No orders yet.</p> : (
        <div className="orders">
          {list.map((o) => {
            const reached = orderStageIndex(o.status), cancelled = o.status === 'cancelled';
            const at = (stage: (typeof ORDER_STAGES)[number]) => (stage === 'placed' ? o.createdAt : [...o.timeline].reverse().find((e) => e.kind === stage)?.at);
            const message = o.timeline.filter((e) => e.note && e.kind !== 'refunded').at(-1);
            return (
              <article key={o.id} className="order" aria-label={`Order ${o.orderNumber}`}>
                <div className="order-head"><b>Order {o.orderNumber}</b><span>{formatMoney(o.totalMinor, o.currency)}</span></div>
                <p className="muted">{o.items.map((i) => `${i.quantity} × ${i.title}${i.option ? ` (${i.option})` : ''}`).join(', ')}</p>
                {cancelled ? <p className="note">Cancelled{o.refundedMinor ? `, ${formatMoney(o.refundedMinor, o.currency)} refunded to your original payment method` : ''}.</p> : (
                  <ol className="track" aria-label="Progress">
                    {ORDER_STAGES.map((stage, i) => {
                      const done = i <= reached, current = i === reached + 1, time = done ? at(stage) : undefined;
                      return (
                        <li key={stage} className={done ? 'reached' : current ? 'next' : ''} aria-current={current ? 'step' : undefined}>
                          <span>{ORDER_STAGE_LABEL[stage]}</span>
                          {time ? <small>{when(time)}</small> : current && stage === 'paid' ? <small>Awaiting payment</small> : null}
                          {stage === 'dispatched' && done && o.trackingNumber ? <small>{o.courier}, {o.trackingUrl ? <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer">{o.trackingNumber}</a> : o.trackingNumber}</small> : null}
                          {stage === 'delivered' && done && o.receivedBy ? <small>By {o.receivedBy}</small> : null}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {message ? <p className="note">{message.note}</p> : null}
              </article>
            );
          })}
        </div>
      )}
      {isMember ? <p className="note">Your orders are also in the Quintara app, under <a href={`${APP_URL}/boutique`}>Maison Quintara</a>.</p> : null}
    </div>
  );
}

/**
 * The second step of a member's sign-in (two-factor): the code from their authenticator app, or a recovery code;
 * or, the first time, setting the authenticator up. Until it is done they are not signed in.
 */
function SecondStepSheet({ step }: { step: 'verify' | 'enrol' }) {
  const { verify, beginSetup, confirmSetup, finish, cancel } = useSecondStep();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [kept, setKept] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => { setError(''); setPending(true); try { await work(); } catch (caught) { setError(caught instanceof ApiError ? caught.message : 'That did not work. Try again.'); } finally { setPending(false); } };
  const six = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="second-title">
      <button type="button" className="textbtn close" onClick={() => cancel()}>Cancel</button>
      <h2 id="second-title" style={{ fontSize: '2.2rem' }}>{step === 'verify' ? 'One more step' : 'Protect your account'}</h2>
      {codes ? (
        <>
          <p className="note">Your recovery codes. If you lose your phone, each lets you sign in once. Keep them somewhere safe and private; they are shown only now.</p>
          <ul className="codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <label className="check"><input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} /> I have kept my recovery codes</label>
          <button className="btn wide" disabled={!kept} onClick={() => finish()}>Continue</button>
        </>
      ) : step === 'verify' ? (
        <form className="stack" onSubmit={(event) => { event.preventDefault(); void run(() => verify(code.trim())); }}>
          {recovery
            ? <label className="field">One of your recovery codes<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" placeholder="xxxxx-xxxxx" autoFocus /></label>
            : <label className="field">The six-digit code from your authenticator app<input value={code} onChange={(event) => setCode(six(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus /></label>}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button className="btn wide" disabled={pending || (recovery ? code.trim().length < 10 : code.length !== 6)}>{pending ? 'One moment' : 'Sign in'}</button>
          <button type="button" className="textbtn" onClick={() => { setRecovery(!recovery); setCode(''); }}>{recovery ? 'Use my authenticator app' : 'Lost your phone? Use a recovery code'}</button>
        </form>
      ) : !setup ? (
        <>
          <p className="note">Every Quintara account is protected by a code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or 1Password), as well as the code we email you.</p>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button className="btn wide" disabled={pending} onClick={() => run(async () => setSetup(await beginSetup()))}>{pending ? 'One moment' : 'Set up my authenticator'}</button>
        </>
      ) : (
        <form className="stack" onSubmit={(event) => { event.preventDefault(); void run(async () => setCodes(await confirmSetup(code))); }}>
          {setup.qr ? <img className="qr" src={setup.qr} alt="QR code to add Quintara to your authenticator app" width={180} height={180} /> : null}
          <p className="note">Scan it with your authenticator app{setup.qr ? '' : ''}. On this phone? <a href={setup.otpauthUrl}>Open it in your app</a>. Or type the key: <code>{setup.secret}</code></p>
          <label className="field">The six-digit code your app now shows<input value={code} onChange={(event) => setCode(six(event.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button className="btn wide" disabled={pending || code.length !== 6}>{pending ? 'One moment' : 'Confirm'}</button>
        </form>
      )}
    </div>
  );
}
