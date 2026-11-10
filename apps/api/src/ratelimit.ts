/**
 * Rate limits: how many times something may be done per window (a minute, unless set), per key (an address, an
 * account, a phone number).
 *
 * - MemoryRateLimiter counts in this process. Right for one API process; with several, each would count separately and
 *   the effective limit would multiply.
 * - RedisRateLimiter counts in Redis (REDIS_URL), shared by every API process. One atomic INCR and PEXPIRE NX per
 *   request: a fixed window that starts with the first attempt, exactly as the in-process limiter. Keys are hashed,
 *   so no address or number is stored in Redis. If Redis cannot be reached, it counts in this process instead (and
 *   says so in the log) rather than refusing everyone or limiting no one.
 */
import { createHash } from 'node:crypto';

export interface RateLimiter {
  /** Records one attempt and returns how many this key has made in the current window, this one included. */
  hit(bucket: string, key: string, windowMs?: number): Promise<number>;
  close?(): Promise<void>;
}

const MINUTE = 60_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor() {
    // Entries are forgotten once their window is over, so a flood of addresses cannot grow the map without end.
    this.sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of this.windows) if (v.resetAt < now) this.windows.delete(k); }, MINUTE);
    this.sweep.unref();
  }
  async hit(bucket: string, key: string, windowMs = MINUTE): Promise<number> {
    const id = `${bucket}:${key}`, now = Date.now(), entry = this.windows.get(id);
    if (!entry || entry.resetAt < now) { this.windows.set(id, { count: 1, resetAt: now + windowMs }); return 1; }
    return ++entry.count;
  }
  async close() { clearInterval(this.sweep); }
}

/** The part of a Redis client this needs (node-redis's client provides it). */
export interface RedisLike {
  multi(): { incr(key: string): unknown; pExpire(key: string, ms: number, mode?: 'NX'): unknown; exec(): Promise<unknown[]> };
}

export class RedisRateLimiter implements RateLimiter {
  private readonly fallback = new MemoryRateLimiter();
  private failing = false;
  private readonly client: RedisLike;
  private readonly onError: (error: unknown) => void;
  private readonly prefix: string;
  constructor(client: RedisLike, onError: (error: unknown) => void = () => {}, prefix = 'q:rl:') {
    this.client = client; this.onError = onError; this.prefix = prefix;
  }

  async hit(bucket: string, key: string, windowMs = MINUTE): Promise<number> {
    const id = `${this.prefix}${bucket}:${createHash('sha256').update(key).digest('base64url').slice(0, 22)}`;
    try {
      const multi = this.client.multi();
      multi.incr(id);
      multi.pExpire(id, windowMs, 'NX');
      const [count] = await multi.exec();
      if (this.failing) { this.failing = false; this.onError(new Error('Redis is reachable again; rate limits are shared once more.')); }
      return Number(count);
    } catch (error) {
      if (!this.failing) { this.failing = true; this.onError(error); }
      return this.fallback.hit(bucket, key, windowMs);
    }
  }
  async close() { await this.fallback.close(); }
}
