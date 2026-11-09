import { useState } from 'react';
import { Text, View } from 'react-native';
import { payThrough, useAction, usePermission, useResource } from '@quintara/app-core';
import { followPayment, paymentReturnUrl } from '../web-link';
import { deliveryFee, formatMoney, ORDER_STAGE_LABEL, ORDER_STAGES, ORDER_STATUS_LABEL, orderInputSchema, orderStageIndex } from '@quintara/domain';
import type { Order, OrderInput, Product } from '@quintara/domain';
import { ActionError, Body, Button, Choice, confirmThen, Divider, Field, Heading, Muted, ResourceView, Row, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';
import { useSection } from '@/components/section-copy';
import { Photo } from '@/components/photo';

interface BagLine { product: Product; option: string; quantity: number }
const when = (iso: string) => new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export default function BoutiqueScreen() {
  const shop = useSection('boutique');
  const canShop = usePermission('boutique.shop');
  const isMember = usePermission('directory.view');
  const products = useResource((api) => api.listProducts());
  const orders = useResource((api) => (canShop ? api.listOrders() : Promise.resolve([])), [canShop]);
  const [bag, setBag] = useState<BagLine[]>([]);
  const reload = () => { products.reload(); orders.reload(); };
  const add = (product: Product, option: string) => setBag((lines) => {
    const found = lines.find((l) => l.product.id === product.id && l.option === option);
    return found ? lines.map((l) => (l === found ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l)) : [...lines, { product, option, quantity: 1 }];
  });
  return (
    <Screen onRefresh={reload} refreshing={products.status === 'loading'}>
      <Title>Maison Quintara</Title>
      <Muted>{shop.description}{isMember ? '' : ' Members pay member prices.'}</Muted>
      <ResourceView resource={products} isEmpty={(list) => list.length === 0} empty={<Muted>The shelves are being filled.</Muted>}>
        {(list) => list.map((product) => <ProductCard key={product.id} product={product} canShop={canShop} isMember={isMember} onAdd={add} onChanged={products.reload} />)}
      </ResourceView>
      {canShop ? <Bag isMember={isMember} bag={bag} clear={() => setBag([])} remove={(line) => setBag((lines) => lines.filter((l) => l !== line))} onOrdered={reload} /> : null}
      {canShop ? (
        <>
          <Heading>Your orders</Heading>
          <ResourceView resource={orders} isEmpty={(list) => list.length === 0} empty={<Muted>Orders appear here once you place one.</Muted>}>
            {(list) => list.map((order) => <OrderCard key={order.id} order={order} onChanged={reload} />)}
          </ResourceView>
        </>
      ) : null}
    </Screen>
  );
}

function ProductCard({ product: p, canShop, isMember, onAdd, onChanged }: { product: Product; canShop: boolean; isMember: boolean; onAdd: (product: Product, option: string) => void; onChanged: () => void }) {
  const { space, radius, color } = useTheme();
  const [option, setOption] = useState(p.options[0] ?? '');
  const wish = useAction(async (api) => { await api.setWishlist(p.id, !p.wished); return true; });
  const soldOut = p.stock !== null && p.stock <= 0;
  return (
    <View style={{ gap: space.sm }}>
      {p.imagePath ? <Photo path={p.imagePath} label={p.title} style={{ width: '100%', aspectRatio: 4 / 5, maxHeight: 520, borderRadius: radius.md, backgroundColor: color.surface }} /> : null}
      <Heading>{p.title}</Heading>
      <Muted>{p.maker ? `By ${p.maker}. ` : ''}{p.stock === null ? 'Made to order.' : soldOut ? 'Sold out.' : p.stock <= 3 ? `${p.stock} left.` : ''}</Muted>
      <Body>{p.description}</Body>
      <Body style={{ fontWeight: '500' }}>{formatMoney(p.priceMinor, p.currency)}{p.publicPriceMinor ? `  Member price, usually ${formatMoney(p.publicPriceMinor, p.currency)}` : ''}</Body>
      {p.membersOnly ? <Tag tone="accent" label="Members only" /> : null}
      {canShop && p.options.length ? <Choice label="Option" value={option} onChange={setOption} options={p.options.map((o) => [o, o] as const)} /> : null}
      <ActionError error={wish.error} />
      {canShop ? <Button label={soldOut ? 'Sold out' : 'Add to bag'} disabled={soldOut} onPress={() => onAdd(p, option)} /> : null}
      {isMember ? <Button quiet label={p.wished ? 'On your wishlist' : 'Add to wishlist'} busy={wish.pending} onPress={async () => { if (await wish.run()) onChanged(); }} /> : null}
      <Divider />
    </View>
  );
}

function Bag({ isMember, bag, clear, remove, onOrdered }: { isMember: boolean; bag: BagLine[]; clear: () => void; remove: (line: BagLine) => void; onOrdered: () => void }) {
  const delivery = useResource((api) => api.listDeliveryOptions());
  const [chosen, setChosen] = useState('');
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const create = useAction((api, input: OrderInput) => api.createOrder(input));
  const pay = useAction((api, id: string) => payThrough(api, { purpose: 'boutique', id, returnUrl: paymentReturnUrl }, (a) => a.payOrder(id)));
  if (bag.length === 0) return null;
  const goods = bag.reduce((sum, l) => sum + l.product.priceMinor * l.quantity, 0), currency = bag[0]!.product.currency;
  const picked = chosen || (delivery.data?.length === 1 ? delivery.data[0]!.id : '');
  const method = delivery.data?.find((d) => d.id === picked) ?? null, total = goods + (method ? deliveryFee(method, goods) : 0);

  function order() {
    const input = { items: bag.map((l) => ({ productId: l.product.id, option: l.option || undefined, quantity: l.quantity })), deliveryOptionId: picked, deliveryAddress: address, guest: isMember ? undefined : { fullName: name, email } };
    const parsed = orderInputSchema.safeParse(input);
    if (!parsed.success) { setProblem(parsed.error.issues[0]?.message ?? 'Check your order'); return; }
    setProblem(undefined);
    confirmThen(`Pay ${formatMoney(total, currency)}?`, 'Your order is placed and paid in one step.', 'Order and pay', async () => {
      const created = await create.run(input);
      if (!created) return;
      clear();
      // If this fails the order waits under Your orders. With a hosted checkout, the member pays in the browser.
      followPayment(await pay.run(created.id));
      onOrdered();
    });
  }

  return (
    <>
      <Heading>Your bag</Heading>
      {bag.map((l) => <Row key={l.product.id + l.option} title={l.product.title} detail={`${l.option ? `${l.option}. ` : ''}${l.quantity} at ${formatMoney(l.product.priceMinor, l.product.currency)}`} trailing={<Button quiet label="Remove" onPress={() => remove(l)} />} />)}
      <ResourceView resource={delivery}>
        {(options) => <Choice label="Delivery" value={picked} onChange={setChosen} options={options.map((d) => [d.id, `${d.name}, ${deliveryFee(d, goods) ? formatMoney(deliveryFee(d, goods), d.currency) : 'no charge'}`] as const)} />}
      </ResourceView>
      {isMember ? null : <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" maxLength={120} />}
      {isMember ? null : <Field label="Email address, for your order confirmation" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" autoCorrect={false} maxLength={200} />}
      <Field label="Delivery address" multiline value={address} onChangeText={setAddress} placeholder="Street, suburb, city and postal code" error={problem} maxLength={500} />
      <Body>Total {formatMoney(total, currency)}</Body>
      <ActionError error={create.error ?? pay.error} />
      <Button label={`Order and pay ${formatMoney(total, currency)}`} busy={create.pending || pay.pending} onPress={order} />
      <Muted>You can cancel for a full refund until the order is being prepared.</Muted>
      <Divider />
    </>
  );
}

function OrderCard({ order: o, onChanged }: { order: Order; onChanged: () => void }) {
  const { space, color } = useTheme();
  const reached = orderStageIndex(o.status), open = o.status !== 'cancelled';
  const at = (stage: (typeof ORDER_STAGES)[number]) => (stage === 'placed' ? o.createdAt : [...o.timeline].reverse().find((e) => e.kind === stage)?.at);
  const message = o.timeline.filter((e) => e.note && e.kind !== 'refunded').at(-1);
  const pay = useAction((api) => payThrough(api, { purpose: 'boutique', id: o.id, returnUrl: paymentReturnUrl }, (a) => a.payOrder(o.id)));
  const cancel = useAction((api) => api.cancelOrder(o.id));
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>Order {o.orderNumber}</Body>
      <Muted>{o.items.map((i) => `${i.quantity} x ${i.title}${i.option ? ` (${i.option})` : ''}`).join(', ')}. {formatMoney(o.totalMinor, o.currency)}, {o.deliveryLabel.toLowerCase()}.</Muted>
      <Tag tone={o.status === 'delivered' ? 'positive' : o.status === 'cancelled' ? 'neutral' : 'accent'} label={ORDER_STATUS_LABEL[o.status]} />
      {open ? (
        <View accessibilityLabel={`Progress: ${ORDER_STATUS_LABEL[o.status]}`} style={{ gap: 0, marginVertical: space.xs }}>
          {ORDER_STAGES.map((stage, i) => {
            const done = i <= reached, current = i === reached + 1, time = done ? at(stage) : undefined;
            return (
              <View key={stage} style={{ flexDirection: 'row', gap: space.sm }}>
                <View style={{ alignItems: 'center', width: 12 }}>
                  <View style={{ width: 12, height: 12, borderRadius: 6, marginTop: 4, borderWidth: 1, borderColor: done ? color.positive : current ? color.accent : color.line, backgroundColor: done ? color.positive : current ? color.accent : 'transparent' }} />
                  {i < ORDER_STAGES.length - 1 ? <View style={{ width: 1, flex: 1, minHeight: 14, backgroundColor: done ? color.positive : color.line }} /> : null}
                </View>
                <View style={{ flex: 1, paddingBottom: space.sm }}>
                  <Text style={{ color: done || current ? color.ink : color.muted, fontWeight: current ? '600' : '400' }}>{ORDER_STAGE_LABEL[stage]}</Text>
                  {time ? <Muted>{when(time)}</Muted> : null}
                  {stage === 'dispatched' && done && o.trackingNumber ? <Muted>{o.courier}, tracking number {o.trackingNumber}</Muted> : null}
                  {stage === 'delivered' && done && o.receivedBy ? <Muted>By {o.receivedBy}</Muted> : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {message ? <Muted>{message.note}</Muted> : null}
      {o.status === 'cancelled' && o.refundedMinor ? <Muted>Refunded {formatMoney(o.refundedMinor, o.currency)}.</Muted> : null}
      <ActionError error={pay.error ?? cancel.error} />
      {o.status === 'awaiting_payment' ? <Button label={`Pay ${formatMoney(o.totalMinor, o.currency)}`} busy={pay.pending} onPress={() => confirmThen(`Pay ${formatMoney(o.totalMinor, o.currency)}?`, `Order ${o.orderNumber}`, 'Pay', async () => { if (followPayment(await pay.run())) onChanged(); })} /> : null}
      {o.status === 'awaiting_payment' || o.status === 'paid' ? <Button quiet label="Cancel order" busy={cancel.pending} onPress={() => confirmThen('Cancel this order?', o.status === 'paid' ? 'You will be refunded in full.' : 'Nothing has been charged.', 'Cancel order', async () => { if (await cancel.run()) onChanged(); }, true)} /> : null}
      <Divider />
    </View>
  );
}
