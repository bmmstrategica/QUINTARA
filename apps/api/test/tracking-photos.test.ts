/** Maison Quintara order tracking from placement to receipt, and high-resolution photographs with sizes chosen at upload. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { ApiError } from '@quintara/api-client';
import { startServer } from './harness.ts';

const fails = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test('order tracking: every step is recorded with when and who, staff notes stay internal, staff can cancel and refund before dispatch', async () => {
  const s = await startServer();
  try {
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    const candle = (await thandi.listProducts()).find((p) => p.stock === null) ?? (await thandi.listProducts())[0]!;
    const courier = (await thandi.listDeliveryOptions())[0]!;
    const place = () => thandi.createOrder({ items: [{ productId: candle.id, option: candle.options[0], quantity: 1 }], deliveryOptionId: courier.id, deliveryAddress: '12 Kloof Street, Gardens, Cape Town' });

    const order = await place();
    assert.deepEqual(order.timeline.map((e) => e.kind), ['placed']);
    await thandi.payOrder(order.id);
    const desk = await s.staff('content@example.com');
    const find = async (id: string) => ((await desk('GET', '/admin/v1/orders')).body as any[]).find((o) => o.id === id);

    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { note: 'Wrapped in tissue, with a handwritten card.' })).status, 204);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/notes`, { note: 'Buyer called: please deliver after 3pm.' })).status, 204);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/notes`, { note: '' })).status, 422);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { courier: 'The Courier Guy', trackingNumber: 'TCG777' })).status, 204);
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/cancel`, { reason: 'Too late for this.' })).status, 409);   // dispatched: no longer cancellable here
    assert.equal((await desk('POST', `/admin/v1/orders/${order.id}/advance`, { receivedBy: 'Sipho at reception' })).status, 204);

    const staffView = await find(order.id);
    assert.deepEqual(staffView.history.map((e: any) => e.kind), ['placed', 'paid', 'preparing', 'note', 'dispatched', 'delivered']);
    const by = staffView.history.map((e: any) => e.by);
    assert.deepEqual(by.slice(0, 2), ['Buyer', 'Buyer']);
    assert.ok(by.slice(2).every((name: string) => name === by[2] && !['Buyer', 'Quintara', 'Staff'].includes(name)), by.join());   // the member of staff, by name
    assert.equal(staffView.receivedBy, 'Sipho at reception');
    assert.ok(staffView.history.every((e: any, i: number) => i === 0 || e.at >= staffView.history[i - 1].at));

    // The buyer sees the steps and the note meant for them, never the internal one.
    const mine = (await thandi.listOrders()).find((o) => o.id === order.id)!;
    assert.deepEqual(mine.timeline.map((e) => e.kind), ['placed', 'paid', 'preparing', 'dispatched', 'delivered']);
    assert.ok(mine.timeline.some((e) => e.note.includes('handwritten card')));
    assert.ok(!JSON.stringify(mine).includes('after 3pm'));
    assert.equal(mine.receivedBy, 'Sipho at reception');
    const told = (await thandi.listNotifications()).map((n) => n.title).join(' | ');
    assert.ok(told.includes('is being processed') && told.includes('dispatched for delivery') && told.includes('has been received'));

    // Staff cancel a paid order they cannot fulfil: a reason is required, stock returns, the buyer is refunded and told.
    const second = await place();
    await thandi.payOrder(second.id);
    assert.equal((await desk('POST', `/admin/v1/orders/${second.id}/cancel`, {})).status, 422);
    assert.equal((await desk('POST', `/admin/v1/orders/${second.id}/cancel`, { reason: 'The atelier cannot make this colour this season.' })).status, 204);
    const cancelled = (await thandi.listOrders()).find((o) => o.id === second.id)!;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.refundedMinor, cancelled.totalMinor);
    assert.deepEqual(cancelled.timeline.map((e) => e.kind), ['placed', 'paid', 'cancelled', 'refunded']);
    assert.ok((await thandi.listNotifications()).some((n) => n.title.includes('cannot make this colour')));
    await assert.rejects(thandi.payOrder(second.id), fails('conflict'));

    // Only staff run the queue.
    const cookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'daniel@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal((await s.app.inject({ method: 'POST', url: `/admin/v1/orders/${second.id}/notes`, headers: { cookie }, payload: { note: 'Hello there' } })).statusCode, 401);
    assert.equal((await s.app.inject({ method: 'GET', url: '/admin/v1/orders', headers: { cookie } })).statusCode, 401);
  } finally { await s.close(); }
});

test('photographs: large originals, size, crop and quality chosen at upload, location data removed, sharp copies for each screen', async () => {
  const s = await startServer();
  try {
    const staffCookie = (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'desk@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const memberCookie = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'daniel@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const upload = (bytes: Buffer, type: string, query = '', cookie = staffCookie) =>
      s.app.inject({ method: 'POST', url: '/admin/v1/photos' + query, headers: { cookie, 'content-type': type }, payload: bytes });

    // A 6000 x 4000 camera photograph, stored sideways with an instruction to turn it, carrying camera and GPS details.
    const detail = await sharp(randomBytes(1500 * 1000 * 3), { raw: { width: 1500, height: 1000, channels: 3 } }).resize(6000, 4000, { kernel: 'nearest' }).raw().toBuffer();
    const original = await sharp(detail, { raw: { width: 6000, height: 4000, channels: 3 } })
      .withExif({ IFD0: { Make: 'Hasselblad', Model: 'X2D' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 55/1 0/1' } })
      .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
    assert.ok(original.length > 2 * 1024 * 1024, 'larger than the old 2 MB limit');

    assert.equal((await upload(original, 'image/jpeg', '', memberCookie)).statusCode, 401);
    assert.equal((await upload(original, 'image/png')).statusCode, 422);                       // says PNG, is JPEG
    assert.equal((await upload(original, 'image/jpeg', '?quality=40')).statusCode, 422);       // below the quality floor
    assert.equal((await upload(original, 'image/jpeg', '?crop=0.5,0.5,0.8,0.8')).statusCode, 422);   // a crop outside the picture
    assert.equal((await upload(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).statusCode, 415);

    // Turned upright (portrait, 4000 x 6000), the middle half kept (4000 x 3000), stored with its longest side at 3000 pixels.
    const res = await upload(original, 'image/jpeg', '?maxEdge=3000&quality=92&crop=0,0.25,1,0.5');
    assert.equal(res.statusCode, 200, res.body);
    const photo = JSON.parse(res.body);
    assert.deepEqual([photo.width, photo.height], [3000, 2250]);   // sideways it would have been 3000 x 1000

    const master = await s.app.inject({ method: 'GET', url: photo.path, headers: { accept: 'image/jpeg' } });
    assert.equal(master.headers['content-type'], 'image/jpeg');
    const meta = await sharp(master.rawPayload).metadata();
    assert.deepEqual([meta.width, meta.height, meta.exif, meta.orientation], [3000, 2250, undefined, undefined]);   // no camera or GPS details left
    assert.equal(master.headers.vary, 'Accept');

    // A phone asks for 500 pixels and gets the 960 copy in WebP; a large screen gets the full detail.
    const phone = await s.app.inject({ method: 'GET', url: `${photo.path}?w=500`, headers: { accept: 'image/avif,image/webp,*/*' } });
    assert.equal(phone.headers['content-type'], 'image/webp');
    assert.equal((await sharp(phone.rawPayload).metadata()).width, 960);
    const big = await s.app.inject({ method: 'GET', url: `${photo.path}?w=3840`, headers: { accept: 'image/webp' } });
    assert.equal((await sharp(big.rawPayload).metadata()).width, 3000);
    assert.ok(phone.rawPayload.length < big.rawPayload.length / 4);

    // A picture is never enlarged, and transparency is kept.
    const small = await sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 169, g: 135, b: 90, alpha: 0.4 } } }).png().toBuffer();
    const kept = JSON.parse((await upload(small, 'image/png', '?maxEdge=4096')).body);
    assert.deepEqual([kept.width, kept.height], [900, 600]);
    assert.equal((await s.app.inject({ method: 'GET', url: kept.path, headers: { accept: 'image/png' } })).headers['content-type'], 'image/png');

    // Too large a file, and a small file that would unpack into an enormous picture, are both refused.
    assert.equal((await upload(Buffer.alloc(41 * 1024 * 1024, 0xff), 'image/jpeg')).statusCode, 413);
    const bomb = await sharp({ create: { width: 16000, height: 16000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(bomb.length < 2 * 1024 * 1024);
    assert.equal((await upload(bomb, 'image/png')).statusCode, 422);
  } finally { await s.close(); }
});
