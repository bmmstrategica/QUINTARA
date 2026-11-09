/** Maison Quintara: products and wishlists, orders with payment and refunds, and the staff side that runs it. */
import { advanceOrderSchema, can, deliveryFee, deliveryOptionInputSchema, dispatchSchema, orderInputSchema, orderNoteSchema, productInputSchema, receivedSchema } from '@quintara/domain';
import type { DeliveryOption, Order, OrderEvent, OrderEventKind, Product } from '@quintara/domain';
import { z } from 'zod';
import { audit, createSession, requireMember, requirePermission, requireStaff } from './context.ts';
import { mediaPath } from './media.ts';
import type { RequestContext } from './context.ts';
import type { Db, Queryable, Row } from './db.ts';
import { conflict, HttpError, notFound, validation } from './errors.ts';
import { refundPayment } from './experiences.ts';
import { markPaymentFailed } from './payments.ts';
import type { PaymentProvider, PreparedPayment, Settlement } from './payments.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An order that is never paid gives its stock back after this long. */
const HOLD_MINUTES = 30;

/** `member` decides which price applies. Staff see the public price with the member price alongside. */
function toProduct(row: Row, member: boolean): Product & { status: string; memberPriceMinor: number | null } {
  const publicPrice = Number(row.price_minor), memberPrice = row.member_price_minor === null ? null : Number(row.member_price_minor);
  const price = member && memberPrice !== null ? memberPrice : publicPrice;
  return {
    id: row.id as string, title: row.title as string, maker: row.maker as string, category: row.category as string, description: row.description as string,
    priceMinor: price, publicPriceMinor: price < publicPrice ? publicPrice : null, membersOnly: Boolean(row.members_only), imagePath: row.image_id ? mediaPath(row.image_id as string) : null,
    currency: (row.currency_code as string).trim(), options: row.options as string[],
    stock: row.stock === null ? null : Number(row.stock), wished: Boolean(row.wished), status: row.status as string, memberPriceMinor: memberPrice,
  };
}
const forShopper = ({ status: _status, memberPriceMinor: _memberPrice, ...product }: ReturnType<typeof toProduct>): Product => product;
const SELECT_PRODUCT = `SELECT p.*, EXISTS (SELECT 1 FROM wishlist_items w WHERE w.product_id = p.id AND w.member_id = $1) AS wished FROM products p`;

/** Whoever is buying: a member, a guest who has ordered before on this device, or a first-time guest. */
interface Buyer { userId: string | null; memberId: string | null; marketId: string; fullName: string | null }
function buyerOf(ctx: RequestContext, defaultMarketId: string): Buyer {
  requirePermission(ctx, 'boutique.shop');
  return { userId: ctx.userId, memberId: ctx.session?.memberId ?? null, marketId: ctx.marketId, fullName: ctx.session?.fullName ?? null };
}

/* ---------- Products and wishlist ---------- */

/** Visitors see the public shelves at public prices. Members see everything, at member prices where set. */
export async function listProducts(db: Queryable, ctx: RequestContext, defaultMarketId: string): Promise<Product[]> {
  requirePermission(ctx, 'boutique.browse');
  const member = can({ roles: ctx.roles }, 'boutique.shop') && ctx.session !== null;
  const rows = await db.query(`${SELECT_PRODUCT} WHERE p.status = 'published' AND p.market_id = $2 AND ($3 OR NOT p.members_only) ORDER BY p.title`, [ctx.session?.memberId ?? null, defaultMarketId, member]);
  return rows.map((row) => forShopper(toProduct(row, member)));
}

export async function listDeliveryOptions(db: Queryable, ctx: RequestContext, defaultMarketId: string): Promise<DeliveryOption[]> {
  const buyer = buyerOf(ctx, defaultMarketId);
  return (await db.query('SELECT * FROM delivery_options WHERE is_active AND market_id = $1 ORDER BY fee_minor, name', [buyer.marketId])).map(toDeliveryOption).map(({ isActive: _active, ...option }) => option);
}
const toDeliveryOption = (row: Row): DeliveryOption & { isActive: boolean } => ({
  id: row.id as string, name: row.name as string, description: row.description as string, feeMinor: Number(row.fee_minor),
  freeOverMinor: row.free_over_minor === null ? null : Number(row.free_over_minor), currency: (row.currency_code as string).trim(), isActive: Boolean(row.is_active),
});

export async function setWishlist(db: Queryable, ctx: RequestContext, productId: string, body: unknown): Promise<void> {
  const session = requireMember(ctx, 'boutique.browse');   // a wishlist needs an account to keep it in
  const parsed = z.object({ wished: z.boolean() }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const found = UUID.test(productId) ? await db.query(`SELECT 1 FROM products WHERE id = $1 AND status = 'published' AND market_id = $2`, [productId, ctx.marketId]) : [];
  if (!found[0]) throw notFound('This product is not available.');
  if (parsed.data.wished) await db.query('INSERT INTO wishlist_items (member_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [session.memberId, productId]);
  else await db.query('DELETE FROM wishlist_items WHERE member_id = $1 AND product_id = $2', [session.memberId, productId]);
}

/* ---------- Orders ---------- */

const SELECT_ORDER = `
  SELECT o.id, o.order_number, o.status, o.total_minor, o.currency_code, o.delivery_name, o.delivery_address, o.created_at, o.member_id,
         o.delivery_label, o.delivery_fee_minor, o.courier, o.tracking_number, o.tracking_url, o.received_by, o.user_id, o.contact_email, o.updated_at,
         COALESCE((SELECT json_agg(json_build_object('kind', e.kind, 'at', e.created_at, 'note', e.note, 'actor', e.actor_id) ORDER BY e.created_at, e.id) FROM order_events e WHERE e.order_id = o.id), '[]'::json) AS events,
         COALESCE((SELECT SUM(p.refunded_minor) FROM payments p WHERE p.order_id = o.id), 0) AS refunded_minor,
         COALESCE((SELECT json_agg(json_build_object('title', i.title, 'option', i.option, 'quantity', i.quantity, 'unitPriceMinor', i.unit_price_minor) ORDER BY i.title) FROM order_items i WHERE i.order_id = o.id), '[]'::json) AS items
    FROM orders o`;

type EventRow = { kind: OrderEventKind; at: string; note: string; actor: string | null };
/** What the buyer sees: the steps, cancellation and refund, never staff notes. */
const forBuyer = (events: EventRow[]): OrderEvent[] => events.filter((e) => e.kind !== 'note').map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString(), note: e.note }));

function toOrder(row: Row): Order {
  return {
    receivedBy: (row.received_by as string | null) ?? null, timeline: forBuyer(row.events as EventRow[]),
    id: row.id as string, orderNumber: row.order_number as string, status: row.status as Order['status'], totalMinor: Number(row.total_minor), currency: (row.currency_code as string).trim(),
    deliveryName: row.delivery_name as string, deliveryAddress: row.delivery_address as string, createdAt: new Date(row.created_at as string).toISOString(),
    refundedMinor: Number(row.refunded_minor), deliveryLabel: row.delivery_label as string, deliveryFeeMinor: Number(row.delivery_fee_minor),
    courier: (row.courier as string | null) ?? null, trackingNumber: (row.tracking_number as string | null) ?? null, trackingUrl: (row.tracking_url as string | null) ?? null,
    items: (row.items as { title: string; option: string; quantity: number; unitPriceMinor: number | string }[]).map((i) => ({ ...i, unitPriceMinor: Number(i.unitPriceMinor) })),
  };
}

const restock = (tx: Queryable, orderId: string) =>
  tx.query(`UPDATE products p SET stock = p.stock + i.quantity FROM order_items i WHERE i.order_id = $1 AND i.product_id = p.id AND p.stock IS NOT NULL`, [orderId]);

export async function listOrders(db: Queryable, ctx: RequestContext): Promise<Order[]> {
  requirePermission(ctx, 'boutique.shop');
  if (!ctx.userId) return [];   // a guest who has not ordered yet
  return (await db.query(`${SELECT_ORDER} WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [ctx.userId])).map(toOrder);
}

/** Records a step in an order's history. `actor` is the buyer, a member of staff, or null for Quintara itself. */
const recordEvent = (tx: Queryable, orderId: string, kind: OrderEventKind, actor: string | null, note = '') =>
  tx.query('INSERT INTO order_events (order_id, kind, actor_id, note) VALUES ($1, $2, $3, $4)', [orderId, kind, actor, note]);

/** Creates an order awaiting payment and sets its stock aside. Prices come from the database, never from the caller. */
export async function createOrder(db: Db, ctx: RequestContext, defaultMarketId: string, body: unknown): Promise<{ order: Order; newSessionToken: string | null }> {
  const buyer = buyerOf(ctx, defaultMarketId);
  const parsed = orderInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const { items, deliveryAddress, deliveryOptionId, guest } = parsed.data;
  const member = buyer.memberId !== null;
  if (!member && !guest) throw new HttpError(422, 'Enter your name and email address so we can confirm your order.', { guest: 'Enter your name and email address' });
  return db.tx(async (tx) => {
    let userId = buyer.userId, newSessionToken: string | null = null;
    if (!userId) {
      // A first order by a guest: a device account, so they can pay for, follow and cancel this order afterwards.
      userId = (await tx.query<{ id: string }>(`INSERT INTO users (status) VALUES ('pending') RETURNING id`))[0]!.id;
      newSessionToken = await createSession(tx, userId);
    }
    // Orders that were never paid give their stock back before this one is counted.
    const stale = await tx.query<{ id: string }>(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1) RETURNING id`, [HOLD_MINUTES]);
    for (const order of stale) { await restock(tx, order.id); await recordEvent(tx, order.id, 'cancelled', null, 'Not paid in time.'); }

    const lines: { productId: string; title: string; option: string; quantity: number; unit: number }[] = [];
    let currency = '';
    // Lock the products in a fixed order so two orders for the last item cannot both succeed, or deadlock.
    for (const item of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const product = (await tx.query(`SELECT id, title, price_minor, member_price_minor, currency_code, options, stock FROM products WHERE id = $1 AND status = 'published' AND market_id = $2 AND ($3 OR NOT members_only) FOR UPDATE`, [item.productId, buyer.marketId, member]))[0];
      if (!product) throw notFound('One of these products is no longer available.');
      const options = product.options as string[], option = item.option ?? '';
      if (options.length ? !options.includes(option) : option !== '') throw new HttpError(422, `Choose an option for ${product.title}.`, { items: 'Choose an option' });
      if (product.stock !== null && Number(product.stock) < item.quantity) throw conflict(`${product.title} is sold out${Number(product.stock) > 0 ? ` beyond ${product.stock}` : ''}.`);
      if (currency && currency !== (product.currency_code as string).trim()) throw conflict('These products cannot be ordered together.');
      currency = (product.currency_code as string).trim();
      if (product.stock !== null) await tx.query('UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1', [item.productId, item.quantity]);
      lines.push({ productId: item.productId, title: product.title as string, option, quantity: item.quantity, unit: Number((member ? product.member_price_minor : null) ?? product.price_minor) });   // the member price is for members only
    }
    const goods = lines.reduce((sum, line) => sum + line.unit * line.quantity, 0);
    const option = (await tx.query('SELECT * FROM delivery_options WHERE id = $1 AND is_active AND market_id = $2 AND currency_code = $3', [deliveryOptionId, buyer.marketId, currency]))[0];
    if (!option) throw new HttpError(422, 'Choose how you would like it delivered.', { deliveryOptionId: 'Choose a delivery method' });
    const delivery = toDeliveryOption(option), fee = deliveryFee(delivery, goods), total = goods + fee;
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO orders (market_id, member_id, order_number, total_minor, currency_code, delivery_name, delivery_address, delivery_option_id, delivery_label, delivery_fee_minor, user_id, contact_email)
       VALUES ($1, $2, 'Q-' || nextval('order_number_seq'), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [buyer.marketId, buyer.memberId, total, currency, member ? buyer.fullName : guest!.fullName, deliveryAddress, delivery.id, delivery.name, fee, userId, member ? null : guest!.email]))[0]!.id;
    for (const line of lines) await tx.query('INSERT INTO order_items (order_id, product_id, title, option, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, $5, $6)', [id, line.productId, line.title, line.option, line.quantity, line.unit]);
    await recordEvent(tx, id, 'placed', userId);
    await audit(tx, userId, 'order.created', 'order', id, { totalMinor: total, guest: !member });
    return { order: toOrder((await tx.query(`${SELECT_ORDER} WHERE o.id = $1`, [id]))[0]!), newSessionToken };
  });
}

/** Charges the order's total once, however often it is asked. */
/** Sets the money aside for an unpaid order: a pending payment row, keyed by the order and the attempt. */
export async function prepareOrderPayment(db: Db, ctx: RequestContext, provider: PaymentProvider, orderId: string): Promise<PreparedPayment> {
  requirePermission(ctx, 'boutique.shop');
  // Scoped to the buyer's own account, member or guest: anyone else's order is simply not found.
  const userId = ctx.userId;
  if (!userId) throw notFound('This order is not available.');
  const prepared = await db.tx(async (tx) => {
    const rows = UUID.test(orderId) ? await tx.query(`SELECT status, total_minor, currency_code, order_number, market_id, created_at < now() - make_interval(mins => $3) AS lapsed FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [orderId, userId, HOLD_MINUTES]) : [];
    const order = rows[0];
    if (!order) throw notFound('This order is not available.');
    if (order.status !== 'awaiting_payment') throw conflict('This order has nothing to pay.');
    if (order.lapsed) {
      await tx.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [orderId]);
      await restock(tx, orderId);
      await recordEvent(tx, orderId, 'cancelled', null, 'Not paid in time.');
      return null;
    }
    const failed = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM payments WHERE order_id = $1 AND status = 'failed'`, [orderId]))[0]!.n);
    const key = `order:${orderId}:${failed}`, amount = Number(order.total_minor), currency = (order.currency_code as string).trim();
    const paymentId = (await tx.query<{ id: string }>(
      `INSERT INTO payments (user_id, market_id, purpose, order_id, amount_minor, currency_code, provider, idempotency_key) VALUES ($1, $2, 'boutique', $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING id`, [userId, order.market_id, orderId, amount, currency, provider.name, key]))[0]!.id;
    return { key, amount, currency, paymentId, description: `Maison Quintara order ${order.order_number as string}`, userId };
  });
  if (!prepared) throw conflict('This order was held for too long without payment. Please order again.');
  return prepared;
}

/**
 * Records that an order's payment came in. Exactly once; a repeat changes nothing. If the order was cancelled
 * meanwhile, or already paid by another payment, this money is refunded and the refund recorded on the order.
 */
export async function settleOrderPayment(db: Db, provider: PaymentProvider, paymentId: string, providerPaymentId: string): Promise<Settlement> {
  const outcome = await db.tx(async (tx) => {
    const payment = (await tx.query<{ user_id: string; order_id: string | null; amount_minor: string; status: string }>(
      'SELECT user_id, order_id, amount_minor, status FROM payments WHERE id = $1 FOR UPDATE', [paymentId]))[0];
    if (!payment?.order_id) throw notFound('This payment is not for an order.');
    const done = { userId: payment.user_id, orderId: payment.order_id };
    if (payment.status === 'paid') return { result: 'settled' as const, ...done };
    if (payment.status === 'refunded') return { result: 'refunded' as const, ...done };
    const order = (await tx.query<{ status: string; order_number: string }>('SELECT status, order_number FROM orders WHERE id = $1 FOR UPDATE', [payment.order_id]))[0];
    await tx.query(`UPDATE payments SET status = 'paid', provider_payment_id = $2, paid_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1`, [paymentId, providerPaymentId]);
    if (order?.status !== 'awaiting_payment') return { result: 'refund' as const, ...done };
    await tx.query(`UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1`, [payment.order_id]);
    await recordEvent(tx, payment.order_id, 'paid', payment.user_id);
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'order', $2)`, [payment.user_id, `Thank you. Order ${order.order_number} is paid and will be prepared for delivery.`]);
    await audit(tx, payment.user_id, 'payment.paid', 'payment', paymentId, { purpose: 'boutique', amountMinor: Number(payment.amount_minor), orderId: payment.order_id });
    return { result: 'settled' as const, ...done };
  });
  if (outcome.result !== 'refund') return outcome.result;
  await refundPayment(db, provider, outcome.userId, paymentId);
  await recordRefund(db, outcome.orderId, paymentId, outcome.userId);
  return 'refunded';
}

/** Pays an order by charging the provider directly (simulated payments). Hosted providers use a checkout instead. */
export async function payOrder(db: Db, ctx: RequestContext, provider: PaymentProvider, orderId: string): Promise<Order> {
  if (provider.hosted) throw conflict('Please pay through the secure checkout.');
  const prepared = await prepareOrderPayment(db, ctx, provider, orderId);
  const result = await provider.charge({ amountMinor: prepared.amount, currency: prepared.currency, description: prepared.description, idempotencyKey: prepared.key, customerReference: prepared.userId });
  if (result.status === 'failed') {
    await markPaymentFailed(db, prepared.paymentId, result.reason);
    throw new HttpError(402, `The payment did not go through. ${result.reason}`);
  }
  if ((await settleOrderPayment(db, provider, prepared.paymentId, result.providerPaymentId)) === 'refunded') {
    throw conflict('This order was cancelled before the payment finished. You have been refunded.');
  }
  return toOrder((await db.query(`${SELECT_ORDER} WHERE o.id = $1`, [orderId]))[0]!);
}

/** A member can cancel until the order is being prepared. A paid order is refunded in full. */
export async function cancelOrder(db: Db, ctx: RequestContext, provider: PaymentProvider, orderId: string): Promise<Order> {
  requirePermission(ctx, 'boutique.shop');
  // Scoped to the buyer's own account, member or guest: anyone else's order is simply not found.
  const userId = ctx.userId;
  if (!userId) throw notFound('This order is not available.');
  const paymentId = await db.tx(async (tx) => {
    const rows = UUID.test(orderId) ? await tx.query<{ status: string }>('SELECT status FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [orderId, userId]) : [];
    if (!rows[0]) throw notFound('This order is not available.');
    if (!['awaiting_payment', 'paid'].includes(rows[0].status)) throw conflict('This order is already being prepared. Ask the concierge desk for help.');
    await tx.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [orderId]);
    await restock(tx, orderId);
    await recordEvent(tx, orderId, 'cancelled', userId, 'Cancelled by the buyer.');
    await audit(tx, userId, 'order.cancelled', 'order', orderId);
    return (await tx.query<{ id: string }>(`SELECT id FROM payments WHERE order_id = $1 AND status = 'paid'`, [orderId]))[0]?.id ?? null;
  });
  if (paymentId) { await refundPayment(db, provider, userId, paymentId); await recordRefund(db, orderId, paymentId, userId); }
  return toOrder((await db.query(`${SELECT_ORDER} WHERE o.id = $1`, [orderId]))[0]!);
}

/** Notes the refund on the order once the provider has made it. A failed refund is left to staff (see the audit log). */
async function recordRefund(db: Queryable, orderId: string, paymentId: string, actor: string | null) {
  const row = (await db.query<{ status: string; refunded_minor: string; currency_code: string }>('SELECT status, refunded_minor, currency_code FROM payments WHERE id = $1', [paymentId]))[0];
  if (row?.status === 'refunded') await recordEvent(db, orderId, 'refunded', actor, `${row.currency_code.trim()} ${(Number(row.refunded_minor) / 100).toFixed(2)} returned to the original payment method.`);
  else await recordEvent(db, orderId, 'note', null, 'The refund did not go through with the payment provider. Settle it by hand.');
}

/* ---------- Staff ---------- */

const COLUMNS: Record<string, string> = { title: 'title', maker: 'maker', category: 'category', description: 'description', priceMinor: 'price_minor', memberPriceMinor: 'member_price_minor', membersOnly: 'members_only', imageId: 'image_id', options: 'options', stock: 'stock', status: 'status' };
const priceProblem = () => new HttpError(422, 'The member price cannot be higher than the public price.', { memberPriceMinor: 'Too high' });

export async function listProductsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.boutique.manage');
  return (await db.query(`${SELECT_PRODUCT} WHERE p.market_id = $2 ORDER BY (p.status = 'archived'), p.title`, [null, ctx.marketId])).map((row) => toProduct(row, false));
}

export async function createProduct(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = productInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if (!(await db.query('SELECT 1 FROM currencies WHERE code = $1', [d.currency]))[0]) throw new HttpError(422, 'Choose a supported currency.', { currency: 'Unsupported currency' });
  if (d.memberPriceMinor != null && d.memberPriceMinor > d.priceMinor) throw priceProblem();
  if (d.imageId && !(await db.query('SELECT 1 FROM media WHERE id = $1', [d.imageId]))[0]) throw new HttpError(422, 'That photograph was not found.', { imageId: 'Not found' });
  const id = (await db.query<{ id: string }>(
    'INSERT INTO products (market_id, title, maker, category, description, price_minor, currency_code, options, stock, status, member_price_minor, members_only, image_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12, $13) RETURNING id',
    [marketId, d.title, d.maker, d.category, d.description, d.priceMinor, d.currency, d.options, d.stock ?? null, d.status, d.memberPriceMinor ?? null, d.membersOnly, d.imageId ?? null]))[0]!.id;
  await audit(db, staffId, 'product.created', 'product', id, { title: d.title });
  return { id };
}

export async function updateProduct(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = productInputSchema.omit({ currency: true }).partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const data = parsed.data as Record<string, unknown>, sent = Object.keys(COLUMNS).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  const current = UUID.test(id) ? (await db.query('SELECT price_minor, member_price_minor FROM products WHERE id = $1', [id]))[0] : undefined;
  if (!current) throw notFound('This product does not exist.');
  if (!sent.length) return;
  const nextPrice = Number(data.priceMinor ?? current.price_minor), nextMember = 'memberPriceMinor' in data ? data.memberPriceMinor : current.member_price_minor;
  if (nextMember != null && Number(nextMember) > nextPrice) throw priceProblem();
  if (data.imageId && !(await db.query('SELECT 1 FROM media WHERE id = $1', [data.imageId]))[0]) throw new HttpError(422, 'That photograph was not found.', { imageId: 'Not found' });
  await db.query(`UPDATE products SET ${sent.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, 'product.updated', 'product', id, { fields: sent });
}

/** An order as staff see it: who bought it, every step with who recorded it, and internal notes. */
export type StaffOrder = Order & {
  buyer: 'member' | 'guest';
  /** A guest's email address, for questions about delivery. Members are reached through the app. */
  contactEmail: string | null;
  updatedAt: string;
  /** For an unpaid order: when its hold ends and it lapses. */
  payBy: string | null;
  history: (OrderEvent & { by: string })[];
};

export async function listOrdersForStaff(db: Queryable, ctx: RequestContext): Promise<StaffOrder[]> {
  requireStaff(ctx, 'admin.boutique.manage');
  // Every order from the moment it is placed. Unpaid and cancelled orders are shown for 30 days, for reference.
  const rows = await db.query(`${SELECT_ORDER} WHERE o.market_id = $1 AND (o.status NOT IN ('awaiting_payment', 'cancelled') OR o.created_at > now() - interval '30 days')
    ORDER BY CASE o.status WHEN 'paid' THEN 0 WHEN 'preparing' THEN 1 WHEN 'dispatched' THEN 2 WHEN 'awaiting_payment' THEN 3 ELSE 4 END, o.created_at DESC LIMIT 500`, [ctx.marketId]);
  const actors = [...new Set(rows.flatMap((r) => (r.events as EventRow[]).map((e) => e.actor)).filter((a): a is string => Boolean(a)))];
  const names = new Map((actors.length ? await db.query<{ id: string; name: string }>(
    `SELECT u.id, COALESCE(NULLIF(p.full_name, ''), u.email, 'Staff') AS name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ANY($1::uuid[])`, [actors]) : []).map((r) => [r.id, r.name]));
  return rows.map((row) => {
    const buyerId = row.user_id as string;
    return {
      ...toOrder(row), buyer: row.member_id ? 'member' : 'guest', contactEmail: row.member_id ? null : (row.contact_email as string | null) ?? null, updatedAt: new Date(row.updated_at as string).toISOString(),
      payBy: row.status === 'awaiting_payment' ? new Date(new Date(row.created_at as string).getTime() + HOLD_MINUTES * 60_000).toISOString() : null,
      history: (row.events as EventRow[]).map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString(), note: e.note, by: !e.actor ? 'Quintara' : e.actor === buyerId ? 'Buyer' : names.get(e.actor) ?? 'Staff' })),
    };
  });
}

const NEXT: Record<string, string> = { paid: 'preparing', preparing: 'dispatched', dispatched: 'delivered' };
const TOLD: Record<string, string> = { preparing: 'is being processed', dispatched: 'has been dispatched for delivery', delivered: 'has been received' };

/**
 * Moves an order one step forward. Steps cannot be skipped or reversed. Dispatching needs the courier and tracking
 * number; marking it received needs the name of whoever took it in. A note, if given, is shown to the buyer.
 */
export async function advanceOrder(db: Db, ctx: RequestContext, id: string, body: unknown = null): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = advanceOrderSchema.safeParse(body ?? {});
  if (!parsed.success) throw validation(parsed.error.issues);
  const input = parsed.data, note = input.note ?? '';
  await db.tx(async (tx) => {
    const rows = UUID.test(id) ? await tx.query<{ status: string; order_number: string; user_id: string }>('SELECT o.status, o.order_number, o.user_id FROM orders o WHERE o.id = $1 FOR UPDATE', [id]) : [];
    if (!rows[0]) throw notFound('This order does not exist.');
    const next = NEXT[rows[0].status];
    if (!next) throw conflict(rows[0].status === 'awaiting_payment' ? 'This order has not been paid yet.' : 'This order cannot be moved on.');
    let detail = '';
    if (next === 'dispatched') {
      const dispatch = dispatchSchema.safeParse(input);
      if (!dispatch.success) throw validation(dispatch.error.issues);
      await tx.query('UPDATE orders SET courier = $2, tracking_number = $3, tracking_url = $4 WHERE id = $1', [id, dispatch.data.courier, dispatch.data.trackingNumber, dispatch.data.trackingUrl ?? null]);
      detail = ` ${dispatch.data.courier}, tracking number ${dispatch.data.trackingNumber}.`;
    }
    if (next === 'delivered') {
      const received = receivedSchema.safeParse(input);
      if (!received.success) throw validation(received.error.issues);
      await tx.query('UPDATE orders SET received_by = $2 WHERE id = $1', [id, received.data.receivedBy]);
      detail = ` Received by ${received.data.receivedBy}.`;
    }
    await tx.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [id, next]);
    await recordEvent(tx, id, next as OrderEventKind, staffId, note);
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'order', $2)`, [rows[0].user_id, `Order ${rows[0].order_number} ${TOLD[next]}.${detail}${note ? ` ${note}` : ''}`.slice(0, 300)]);
    await audit(tx, staffId, 'order.' + next, 'order', id);
  });
}

/** A note on an order for staff only: a call with the courier, a question from the buyer. */
export async function addOrderNote(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = orderNoteSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM orders WHERE id = $1', [id]))[0]) throw notFound('This order does not exist.');
  await recordEvent(db, id, 'note', staffId, parsed.data.note);
  await audit(db, staffId, 'order.note_added', 'order', id);
}

/** Staff can cancel an order until it is dispatched, with a reason the buyer is told. A paid order is refunded in full. */
export async function cancelOrderForStaff(db: Db, ctx: RequestContext, provider: PaymentProvider, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = z.object({ reason: z.string().trim().min(5, 'Give the buyer a reason').max(500) }).safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const found = await db.tx(async (tx) => {
    const rows = UUID.test(id) ? await tx.query<{ status: string; order_number: string; user_id: string }>('SELECT status, order_number, user_id FROM orders WHERE id = $1 FOR UPDATE', [id]) : [];
    if (!rows[0]) throw notFound('This order does not exist.');
    if (!['awaiting_payment', 'paid', 'preparing'].includes(rows[0].status)) throw conflict('An order that has been dispatched cannot be cancelled here.');
    await tx.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await restock(tx, id);
    await recordEvent(tx, id, 'cancelled', staffId, parsed.data.reason);
    await tx.query(`INSERT INTO notifications (user_id, category, title) VALUES ($1, 'order', $2)`, [rows[0].user_id, `Order ${rows[0].order_number} has been cancelled. ${parsed.data.reason}`.slice(0, 300)]);
    await audit(tx, staffId, 'order.cancelled_by_staff', 'order', id, { reason: parsed.data.reason });
    return { buyer: rows[0].user_id, paymentId: (await tx.query<{ id: string }>(`SELECT id FROM payments WHERE order_id = $1 AND status = 'paid'`, [id]))[0]?.id ?? null };
  });
  // The refund notice goes to the buyer, so they are named as the account refunded.
  if (found.paymentId) { await refundPayment(db, provider, found.buyer, found.paymentId); await recordRefund(db, id, found.paymentId, staffId); }
}

/* ---------- Staff: delivery methods ---------- */

export async function listDeliveryOptionsForStaff(db: Queryable, ctx: RequestContext) {
  requireStaff(ctx, 'admin.boutique.manage');
  return (await db.query('SELECT * FROM delivery_options WHERE market_id = $1 ORDER BY is_active DESC, fee_minor, name', [ctx.marketId])).map(toDeliveryOption);
}

export async function createDeliveryOption(db: Db, ctx: RequestContext, marketId: string, body: unknown): Promise<{ id: string }> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = deliveryOptionInputSchema.safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const d = parsed.data;
  if (!(await db.query('SELECT 1 FROM currencies WHERE code = $1', [d.currency]))[0]) throw new HttpError(422, 'Choose a supported currency.', { currency: 'Unsupported currency' });
  if ((await db.query('SELECT 1 FROM delivery_options WHERE market_id = $1 AND lower(name) = lower($2)', [marketId, d.name]))[0]) throw conflict('A delivery method with that name already exists.');
  const id = (await db.query<{ id: string }>('INSERT INTO delivery_options (market_id, name, description, fee_minor, free_over_minor, currency_code, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [marketId, d.name, d.description, d.feeMinor, d.freeOverMinor ?? null, d.currency, d.isActive]))[0]!.id;
  await audit(db, staffId, 'delivery_option.created', 'delivery_option', id, { name: d.name, feeMinor: d.feeMinor });
  return { id };
}

export async function updateDeliveryOption(db: Db, ctx: RequestContext, id: string, body: unknown): Promise<void> {
  const staffId = requireStaff(ctx, 'admin.boutique.manage');
  const parsed = deliveryOptionInputSchema.omit({ currency: true }).partial().safeParse(body);
  if (!parsed.success) throw validation(parsed.error.issues);
  const columns: Record<string, string> = { name: 'name', description: 'description', feeMinor: 'fee_minor', freeOverMinor: 'free_over_minor', isActive: 'is_active' };
  const data = parsed.data as Record<string, unknown>, sent = Object.keys(columns).filter((key) => key in ((body ?? {}) as object) && data[key] !== undefined);
  if (!UUID.test(id) || !(await db.query('SELECT 1 FROM delivery_options WHERE id = $1', [id]))[0]) throw notFound('This delivery method does not exist.');
  if (!sent.length) return;
  await db.query(`UPDATE delivery_options SET ${sent.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...sent.map((k) => data[k] ?? null)]);
  await audit(db, staffId, 'delivery_option.updated', 'delivery_option', id, { fields: sent });
}
