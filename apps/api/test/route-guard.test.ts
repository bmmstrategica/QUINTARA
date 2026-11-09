/**
 * Every route the API has, called as a visitor and (for staff routes) as a member: only the public ones answer.
 * A route added later without a permission check fails this test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './harness.ts';

const PUBLIC = new Set([
  'GET /health', 'GET /ready', 'GET /v1/markets', 'GET /v1/content/sections', 'GET /v1/auth/config', 'GET /v1/auth/2fa', 'GET /admin/v1/auth/2fa',
  'GET /v1/application/plans', 'GET /v1/application/questions', 'GET /v1/session', 'DELETE /v1/session', 'GET /v1/guest/account',
  'GET /admin/v1/session', 'DELETE /admin/v1/session',
  // Open shelves: what visitors may see, filtered to what they may see.
  'GET /v1/experiences', 'GET /v1/boutique/products', 'GET /v1/boutique/delivery-options', 'GET /v1/home/slides', 'GET /v1/lifestyle/services', 'GET /v1/lifestyle/services/:id', 'GET /v1/payments/config', 'GET /v1/tv/series',
  // Empty for a visitor; a visitor's first save starts a draft application on this device.
  'GET /v1/boutique/orders', 'GET /v1/me/application', 'PUT /v1/me/application',
]);

test('route guard: no route answers a visitor, or a member on a staff route, unless it is meant to be public', async () => {
  const s = await startServer();
  try {
    const routes: [string, string][] = [];
    const stack: string[] = [];
    for (const line of s.app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?/.exec(line);
      if (!m) continue;
      const depth = m[1]!.length / 4;
      stack.length = depth; stack[depth] = m[2]!;
      for (const method of (m[3] ?? '').split(', ').filter((x) => x && x !== 'HEAD' && x !== 'OPTIONS')) routes.push([method, stack.join('')]);
    }
    assert.ok(routes.length > 200, `found ${routes.length} routes`);
    const id = '00000000-0000-4000-8000-000000000000';
    const member = (await s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const open: string[] = [];
    for (const [method, path] of routes) {
      const url = path.replace(/:[a-zA-Z]+/g, id);
      for (const [who, cookie] of [['visitor', ''], ['member', member]] as const) {
        if (who === 'member' && !url.startsWith('/admin/')) continue;
        const r = await s.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
        if (r.statusCode < 300 && !PUBLIC.has(`${method} ${path}`)) open.push(`${who} ${method} ${path} -> ${r.statusCode}`);
        if (r.statusCode >= 500) open.push(`${who} ${method} ${path} -> ${r.statusCode} (server error)`);
      }
    }
    assert.deepEqual(open, []);
  } finally { await s.close(); }
});
