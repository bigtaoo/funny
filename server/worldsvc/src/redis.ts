// worldsvc Redis connection (S8-0, first introduction of Redis; META_DESIGN §6.7 / SOCIAL_DESIGN SOC7).
// S8-0 only establishes the optional connection skeleton — the actual uses (march scheduling
// ZSET `world:{w}:march`, family/sect channel pub/sub, gateway horizontal-scaling routing,
// hot-cell cache) are wired in S8-1/S8-2/S8-4. No Redis URL by default → returns null;
// worldsvc degrades gracefully (march arrival scanning falls back to Mongo arriveAt index,
// channel features disabled).
//
// Implementation note: dynamic import with a variable specifier so tsc can compile even when
// ioredis is not installed (Redis is a production dependency; it need not be installed during
// the dev skeleton phase — package.json declares it and production npm i installs it).

/** Minimal Redis interface used by worldsvc (extend as needed; types are independent of the concrete ioredis implementation). */
export interface WorldRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export async function connectRedis(url: string | undefined): Promise<WorldRedis | null> {
  if (!url) return null;
  try {
    // Variable specifier: bypasses tsc static module resolution (ioredis may not be installed in dev).
    const spec = 'ioredis';
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    client.on('error', (e: Error) => console.error('[world-redis] error:', e.message));
    return client as WorldRedis;
  } catch (e) {
    console.error(
      `[world-redis] Failed to connect to Redis (url=${url}): ${(e as Error).message}. ` +
        `worldsvc degraded (march scheduling falls back to Mongo, channels disabled).`,
    );
    return null;
  }
}
