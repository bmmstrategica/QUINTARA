/**
 * Rate limits counted in this process and in Redis, and the API server stopping cleanly. The Redis tests need a Redis
 * server (TEST_REDIS_URL, for example redis://localhost:6379) and are skipped without one; CI runs them.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createClient } from 'redis';
import { MemoryRateLimiter, RedisRateLimiter, redisRateLimiter } from '../src/ratelimit.ts';
import type { RedisLike } from '../src/ratelimit.ts';
import { startServer } from './harness.ts';

const skipRedis = process.env.TEST_REDIS_URL ? false : 'TEST_REDIS_URL is not set';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('in this process: attempts are counted per key and start again after the window', async () => {
  const limiter = new MemoryRateLimiter();
  assert.deepEqual([await limiter.hit('b', 'k', 100), await limiter.hit('b', 'k', 100), await limiter.hit('b', 'other', 100)], [1, 2, 1]);
  await pause(130);
  assert.equal(await limiter.hit('b', 'k', 100), 1);
  await limiter.close();
});

test('two API processes sharing Redis share one sign-in limit', { skip: skipRedis }, async () => {
  const prefix = `q:test:${Date.now().toString(36)}:`;
  const clients = await Promise.all([0, 1].map(async () => { const c = createClient({ url: process.env.TEST_REDIS_URL }); await c.connect(); return c; }));
  // Two servers, each with its own database, connection and limiter, as two processes would have.
  const servers = await Promise.all(clients.map((c) => startServer({ signInLimit: 3, rateLimiter: new RedisRateLimiter(c, () => {}, prefix) })));
  const a = servers[0]!, b = servers[1]!;
  try {
    const signIn = (s: typeof a) => s.app.inject({ method: 'POST', url: '/v1/session', payload: { email: 'thandi@example.com' } });
    const codes = [];
    for (const s of [a, b, a, b, a]) codes.push((await signIn(s)).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);       // three in all, not three each

    // Without Redis, each process would have allowed three.
    const [c, d] = await Promise.all([startServer({ signInLimit: 3 }), startServer({ signInLimit: 3 })]);
    try {
      const alone = [];
      for (const s of [c, d, c, d, c, d]) alone.push((await signIn(s)).statusCode);
      assert.deepEqual(alone, [200, 200, 200, 200, 200, 200]);
    } finally { await c.close(); await d.close(); }

    // Nothing that identifies a person or an address is kept in Redis: keys are hashed.
    const keys = await clients[0]!.keys(`${prefix}*`);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((k) => !k.includes('127.0.0.1') && !k.includes('@')), keys.join(', '));
    // And each key expires with its window.
    assert.ok((await clients[0]!.pTTL(keys[0]!)) > 0);
  } finally {
    await a.close(); await b.close();
    for (const c of clients) await c.quit();
  }
});

test('a Redis window ends on time', { skip: skipRedis }, async () => {
  const client = createClient({ url: process.env.TEST_REDIS_URL });
  await client.connect();
  try {
    const limiter = new RedisRateLimiter(client, () => {}, `q:test:${Date.now().toString(36)}:`);
    assert.deepEqual([await limiter.hit('b', 'k', 150), await limiter.hit('b', 'k', 150)], [1, 2]);
    await pause(250);
    assert.equal(await limiter.hit('b', 'k', 150), 1);
  } finally { await client.quit(); }
});

test('if Redis cannot be reached, limits are still applied in this process, and the problem is reported once', async () => {
  const broken: RedisLike = { multi: () => ({ incr: () => undefined, pExpire: () => undefined, exec: async () => { throw new Error('connection refused'); } }) };
  const reported: unknown[] = [];
  const limiter = new RedisRateLimiter(broken, (e) => reported.push(e));
  const counts = [];
  for (let i = 0; i < 4; i++) counts.push(await limiter.hit('sign-in', '10.0.0.1'));
  assert.deepEqual(counts, [1, 2, 3, 4]);
  assert.equal(reported.length, 1);
  await limiter.close();
});

test('with Redis down, as the API runs it: it starts at once, and every request is counted here without waiting', async () => {
  // Nothing listens on this port: a real client, configured as the API configures it.
  const started = Date.now();
  const { limiter, quit } = redisRateLimiter('redis://127.0.0.1:9', () => {});
  assert.ok(Date.now() - started < 200, 'creating it does not wait for Redis');
  try {
    for (let i = 1; i <= 3; i++) {
      const t = Date.now();
      assert.equal(await limiter.hit('sign-in', 'down@example.com'), i);
      assert.ok(Date.now() - t < 1000, `request ${i} answered without waiting for Redis (${Date.now() - t} ms)`);
    }
  } finally { await quit(); }
});

test('the API stops cleanly on SIGTERM: it answers no more, closes its connections and exits 0', async () => {
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUSH: 'off', DATABASE_URL: '', NODE_ENV: 'development' }, stdio: 'pipe',
  });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ } await pause(250); }
    assert.equal((await fetch(`http://127.0.0.1:${port}/ready`)).status, 200);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.equal(await Promise.race([exited, pause(15_000).then(() => 'timeout')]), 0);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});
