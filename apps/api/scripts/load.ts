/**
 * Load test: the real API on a real PostgreSQL database, driven over HTTP by many members at once.
 *
 *   LOAD_DATABASE_URL=postgres://user:pass@host:5432/postgres pnpm --filter @quintara/api load
 *   Options: LOAD_SECONDS (30), LOAD_CONCURRENCY (50 members' requests in flight), LOAD_P95_MS (fail above; 500)
 *
 * It creates a database of its own, migrates and seeds it, starts the API on a free port, and removes the database at
 * the end. Each virtual member signs in and repeats a mix weighted like real use: mostly reading experiences, bookings
 * and notifications, sometimes searching, and sometimes booking a seat and cancelling it (writes under row locks).
 * It reports requests per second, latency percentiles per kind of request, and every error. Exit code 1 if any request
 * fails or the overall 95th percentile is above LOAD_P95_MS.
 */
import { buildApp } from '../src/app.ts';
import { createPostgresDb } from '../src/db.ts';
import { MockEmailProvider } from '../src/email.ts';
import { migrate } from '../src/migrate.ts';
import { MockPaymentProvider } from '../src/payments.ts';
import { seed } from '../src/seed.ts';

const base = process.env.LOAD_DATABASE_URL;
if (!base) { console.error('Set LOAD_DATABASE_URL to a PostgreSQL server the test may create a database on.'); process.exit(2); }
const SECONDS = Number(process.env.LOAD_SECONDS ?? 30), CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50), P95_LIMIT = Number(process.env.LOAD_P95_MS ?? 500);

const name = `quintara_load_${Date.now().toString(36)}`;
const admin = createPostgresDb(base);
await admin.exec(`CREATE DATABASE ${name}`);
const url = new URL(base); url.pathname = `/${name}`;
const db = createPostgresDb(url.toString());
await migrate(db);
await seed(db, { history: true });
const app = await buildApp(db, { webOrigins: ['http://localhost:3000'], authMode: 'dev', secureCookies: false, payments: new MockPaymentProvider(), email: new MockEmailProvider(), webUrl: 'http://localhost:3000', signInLimit: 100_000 });
await app.listen({ port: 0, host: '127.0.0.1' });
const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const emails = (await db.query<{ email: string }>(`SELECT u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.status = 'active' AND u.email IS NOT NULL`)).map((r) => r.email);
const timings = new Map<string, number[]>();
const errors: string[] = [];
const record = (kind: string, ms: number) => { const list = timings.get(kind) ?? []; list.push(ms); timings.set(kind, list); };

async function call(kind: string, cookie: string, method: string, path: string, body?: unknown) {
  const started = performance.now();
  const response = await fetch(api + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: 'http://localhost:3000' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  record(kind, performance.now() - started);
  if (response.status >= 500) errors.push(`${kind} ${response.status} ${text.slice(0, 120)}`);
  return { status: response.status, json: () => JSON.parse(text) };
}

async function member(index: number, until: number) {
  const email = emails[index % emails.length]!;
  const session = await fetch(`${api}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ email }) });
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]!;
  const list = (await call('experiences: list', cookie, 'GET', '/v1/experiences')).json() as { id: string }[];
  while (Date.now() < until) {
    const r = Math.random();
    const pick = list[Math.floor(Math.random() * list.length)]!;
    if (r < 0.3) await call('experiences: list', cookie, 'GET', '/v1/experiences');
    else if (r < 0.5) await call('experiences: one', cookie, 'GET', `/v1/experiences/${pick.id}`);
    else if (r < 0.65) await call('bookings: mine', cookie, 'GET', '/v1/me/bookings');
    else if (r < 0.8) await call('notifications', cookie, 'GET', '/v1/me/notifications');
    else if (r < 0.9) await call('search', cookie, 'GET', `/v1/search?q=${encodeURIComponent(['cape', 'dinner', 'golf', 'wine', 'yacht'][Math.floor(Math.random() * 5)]!)}`);
    else {
      // Book a seat and give it back: a locked write, contended by everyone booking the same experience.
      const booked = await call('book a seat', cookie, 'POST', `/v1/experiences/${pick.id}/bookings`, { seats: 1 });
      if (booked.status === 200) await call('cancel a booking', cookie, 'POST', `/v1/me/bookings/${booked.json().id}/cancel`, {});
    }
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
console.log(`Load test: ${CONCURRENCY} members at once for ${SECONDS}s, on PostgreSQL (${emails.length} seeded member accounts reused).`);
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => member(i, started + SECONDS * 1000)));
const elapsed = (Date.now() - started) / 1000;

const all = [...timings.values()].flat().sort((a, b) => a - b);
const rows = [...timings.entries()].sort().map(([kind, list]) => { const s = [...list].sort((a, b) => a - b); return { kind, requests: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1)! }; });
rows.push({ kind: 'all', requests: all.length, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: all.at(-1)! });
console.log(`${all.length} requests in ${elapsed.toFixed(1)}s: ${(all.length / elapsed).toFixed(0)} per second. Server errors: ${errors.length}.`);
console.log('| Request | Count | p50 ms | p95 ms | p99 ms | max ms |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.kind} | ${r.requests} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(1)} |`);
for (const e of errors.slice(0, 10)) console.log('error:', e);

await app.close(); await db.close();
await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.close();
const p95 = pct(all, 95);
if (errors.length || p95 > P95_LIMIT) { console.error(`FAILED: ${errors.length} errors; p95 ${p95.toFixed(1)} ms (limit ${P95_LIMIT}).`); process.exit(1); }
console.log(`Passed: no errors; p95 ${p95.toFixed(1)} ms (limit ${P95_LIMIT}).`);
