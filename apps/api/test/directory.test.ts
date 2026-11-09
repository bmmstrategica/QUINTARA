/** Lifestyle: services sit in the directory with the partners, with the same details; contacts are for members only; staff edit them. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './harness.ts';

test('services carry directory details: everyone sees the description, only members see who to ask for, staff edit every field', async () => {
  const s = await startServer();
  try {
    const desk = await s.staff('desk@example.com');
    const listed = (await desk('GET', '/admin/v1/services')).body as any[];
    const target = listed.find((x) => x.status === 'published')!;
    assert.ok('summary' in target && 'contactEmail' in target);
    const changes = { summary: 'Portraits, events and brands.', area: 'De Waterkant, Cape Town', website: 'https://example.com/studio', offer: 'Ten per cent off a first session for members.', contactName: 'Lerato M.', contactEmail: 'bookings@example.com', contactPhone: '+27 21 555 0100', address: '1 Example Street, Cape Town' };
    assert.equal((await desk('PATCH', `/admin/v1/services/${target.id}`, changes)).status, 204);
    assert.equal((await desk('PATCH', `/admin/v1/services/${target.id}`, { contactEmail: 'not an email' })).status, 422);
    assert.equal((await desk('PATCH', `/admin/v1/services/${target.id}`, { website: 'javascript:alert(1)' })).status, 422);
    assert.equal((await desk('PATCH', `/admin/v1/services/${target.id}`, { contactPhone: '<b>1</b>' })).status, 422);
    const staffView = ((await desk('GET', '/admin/v1/services')).body as any[]).find((x) => x.id === target.id);
    for (const [key, value] of Object.entries(changes)) assert.equal(staffView[key], value, key);

    // A visitor: the directory details, never the contact details, in the list or on the service's own page.
    const guest = s.client();
    for (const seen of [(await guest.listLifestyleServices()).find((x) => x.id === target.id)!, await guest.getLifestyleService(target.id)]) {
      assert.equal(seen.summary, changes.summary); assert.equal(seen.area, changes.area); assert.equal(seen.offer, changes.offer); assert.equal(seen.website, changes.website);
      assert.equal(seen.contactName, ''); assert.equal(seen.contactEmail, ''); assert.equal(seen.contactPhone, '');
      assert.ok(!JSON.stringify(seen).includes('bookings@example.com'));
    }
    // A member sees who to ask for.
    const member = s.client();
    await member.signIn({ email: 'thandi@example.com' });
    const seen = await member.getLifestyleService(target.id);
    assert.equal(seen.contactName, 'Lerato M.'); assert.equal(seen.contactEmail, 'bookings@example.com'); assert.equal(seen.contactPhone, '+27 21 555 0100');

    // A new service with its directory details; drafts are not shown.
    const created = (await desk('POST', '/admin/v1/services', { name: 'Harbour Florist', category: 'Home and Design', area: 'Woodstock', summary: 'Flowers for homes and events.' })).body as { id: string };
    await assert.rejects(member.getLifestyleService(created.id));
    assert.equal((await desk('PATCH', `/admin/v1/services/${created.id}`, { status: 'published' })).status, 204);
    assert.equal((await member.getLifestyleService(created.id)).area, 'Woodstock');
    await assert.rejects(guest.getLifestyleService('not-an-id'));
  } finally { await s.close(); }
});

test('cropping a photograph in use: the stored photograph is opened from the admin console, cropped again and put back on the slide', async () => {
  const s = await startServer();
  try {
    const sharp = (await import('sharp')).default;
    const staffCookie = (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'desk@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const upload = (bytes: Buffer, query = '') => s.app.inject({ method: 'POST', url: '/admin/v1/photos' + query, headers: { cookie: staffCookie, 'content-type': 'image/jpeg' }, payload: bytes });
    const original = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#335577' } }).jpeg().toBuffer();
    const first = JSON.parse((await upload(original)).body);
    const desk = await s.staff('desk@example.com');
    const slide = (await desk('POST', '/admin/v1/home-slides', { kind: 'image', imageId: first.id })).body as { id: string };

    // The console fetches the full-size stored photograph from its own origin, asking for JPEG or PNG only.
    const origin = 'http://localhost:3000';
    const master = await s.app.inject({ method: 'GET', url: first.path, headers: { accept: 'image/jpeg,image/png', origin } });
    assert.equal(master.statusCode, 200);
    assert.equal(master.headers['content-type'], 'image/jpeg');
    assert.equal(master.headers['access-control-allow-origin'], origin);
    assert.deepEqual([(await sharp(master.rawPayload).metadata()).width, (await sharp(master.rawPayload).metadata()).height], [3200, 1800]);

    // A free crop of the right half, uploaded as a new photograph and set on the slide.
    const cropped = JSON.parse((await upload(master.rawPayload, '?crop=0.5,0,0.5,1&quality=92')).body);
    assert.deepEqual([cropped.width, cropped.height], [1600, 1800]);
    assert.equal((await desk('PATCH', `/admin/v1/home-slides/${slide.id}`, { imageId: cropped.id })).status, 204);
    assert.equal((await desk('PATCH', `/admin/v1/home-slides/${slide.id}`, { imageId: '00000000-0000-4000-8000-000000000000' })).status, 422);
    const film = (await desk('POST', '/admin/v1/home-slides', { kind: 'video', videoUrl: 'https://video.example/welcome.mp4' })).body as { id: string };
    assert.equal((await desk('PATCH', `/admin/v1/home-slides/${film.id}`, { imageId: cropped.id, caption: 'Changed' })).status, 422);
    const slides = await s.client().listHomeSlides();
    assert.equal(slides.find((x) => x.id === slide.id)!.src, cropped.path);
    assert.notEqual(slides.find((x) => x.id === film.id)?.caption, 'Changed');
  } finally { await s.close(); }
});
