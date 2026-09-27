import type { IncomingMessage } from 'node:http';

/**
 * Abuse protection: per-client rate limits and bounded concurrency for expensive work.
 *
 * Behind the proxy (TRUST_PROXY=1) the client address comes from the proxy's headers:
 * Cloudflare's CF-Connecting-IP first, then X-Real-IP. Without it, only the socket address
 * is trusted, so nobody can dodge a limit by sending their own headers.
 */

const TRUST_PROXY = process.env.TRUST_PROXY === '1';

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const h = req.headers['cf-connecting-ip'] ?? req.headers['x-real-ip'];
    const v = Array.isArray(h) ? h[0] : h;
    if (v) return v.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Fixed-window counter per key: at most `max` hits per `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(private max: number, private windowMs: number) {
    // Forget idle keys so the map can't grow without bound.
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, Math.max(10_000, windowMs)).unref();
  }

  allow(key: string): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    e.n++;
    return e.n <= this.max;
  }
}

export class BusyError extends Error {
  constructor() {
    super('Server is busy, try again in a moment');
  }
}

/** At most `limit` tasks run at once; a few more may wait, the rest are refused. */
export class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number, private maxQueue: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.queue.length >= this.maxQueue) throw new BusyError();
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
