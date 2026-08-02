// worldsvc Redis connection (S8-0, first introduction of Redis; META_DESIGN §6.7 / SOCIAL_DESIGN SOC7).
// Current uses: family/sect channel pub/sub (publish) + the ADR-051 occupancy/coverage spatial index
// (hset/hget/hdel). No Redis URL by default → returns null; worldsvc degrades gracefully (march arrival
// scanning falls back to Mongo arriveAt index, channel features disabled, encounter/interception disabled).
//
// 2026-07-27: this interface used to also declare zadd/zrangebyscore/zrem (march/siegeDamage/occupation
// wake-up ZSETs) and get/set — all dead: the ZSETs were written on every march step but zrangebyscore was
// never called anywhere in src/ (the Mongo due-time scan was always the sole consumer), and get/set had no
// callers at all. Removed along with their write sites (core/push.ts, combatMarch.ts, combatSiege/*) rather
// than left as unread I/O — see claudedocs/server.md for the audit that found this.
//
// Implementation note: dynamic import with a variable specifier so tsc can compile even when
// ioredis is not installed (Redis is a production dependency; it need not be installed during
// the dev skeleton phase — package.json declares it and production npm i installs it).

/** Minimal Redis interface used by worldsvc (extend as needed; types are independent of the concrete ioredis implementation). */
export interface WorldRedis {
  publish(channel: string, message: string): Promise<unknown>;
  // ADR-051 (P1): hash ops for the field-unit occupancy index (`world:{w}:occ`, field=tileId → occupant JSON).
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  // Whole-key delete (2026-07-29 audit fix): resetSeason uses this to drop the occ/cover hashes for a
  // worldId being recycled — without it, stale entries survive a reset and can affect a future season on
  // the same worldId (see WorldCorePush.clearSpatialIndexes). Optional so existing test fakes that only
  // exercise the per-field hset/hget/hdel occupancy/coverage paths don't all need a stub implementation.
  del?(key: string): Promise<unknown>;
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
