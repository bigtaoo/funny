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

import type { RedisCtor } from '@nw/shared';

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
  /**
   * Atomically merge one entry into (or remove one entry from) a JSON-object stored at a single hash
   * field, running server-side so the whole read-modify-write is one atomic Redis operation
   * (2026-08-03 worldsvc code review): `core/push.ts`'s addCover/removeCover used to do a plain
   * hget-then-hset, so two sources registering overlapping 3x3 footprints concurrently could lose one
   * source's entry (last writer wins on the whole field). `entryJson` null removes `entryKey` from the
   * map instead of setting it. Optional — falls back to the pre-existing non-atomic path when absent
   * (e.g. in-memory test fakes, which have no real concurrency to race against).
   */
  hmergeJsonField?(key: string, field: string, entryKey: string, entryJson: string | null): Promise<unknown>;
}

/** Bounded wait for the initial connection outcome (see doc comment on connectRedis below). */
const INITIAL_CONNECT_TIMEOUT_MS = 5000;

const MERGE_JSON_FIELD_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local map = {}
if cur then map = cjson.decode(cur) end
if ARGV[3] == '' then
  map[ARGV[2]] = nil
else
  map[ARGV[2]] = cjson.decode(ARGV[3])
end
local isEmpty = true
for _ in pairs(map) do isEmpty = false break end
if isEmpty then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(map))
end
return 1
`;

export async function connectRedis(url: string | undefined): Promise<WorldRedis | null> {
  if (!url) return null;
  try {
    // Variable specifier: bypasses tsc static module resolution (ioredis may not be installed in dev).
    // Kept local rather than using @nw/shared's loadIoRedisCtor() so redis.test.ts's vi.mock('ioredis')
    // still intercepts it — Vitest can't reach a dynamic import made inside the externalized @nw/shared.
    const spec = 'ioredis';
    const mod = (await import(spec)) as { default?: RedisCtor } & RedisCtor;
    const Redis: RedisCtor = mod.default ?? mod;
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    client.on('error', (e) => console.error('[world-redis] error:', e.message));

    // 2026-08-03 (worldsvc code review): this used to resolve immediately after construction without
    // waiting for the connection to actually succeed — during a real Redis outage at boot, index.ts
    // still logged `redis=on` and every occ/cover/pub-sub call then silently failed from that point on,
    // a false-positive health signal that misleads on-call debugging. Wait (bounded) for the first
    // ready/error signal before deciding what to return. Trade-off: a Redis that is merely slow to
    // become ready (recovers a few seconds after this timeout) now leaves worldsvc degraded for the
        // rest of the process's life instead of self-healing once ioredis's connection completes — judged
    // acceptable since every degraded-Redis code path in this service is already designed to run
    // indefinitely without it (occ/cover/channel fan-out all silently no-op or fall back).
    const ready = await new Promise<boolean>((resolve) => {
      const onReady = () => { cleanup(); resolve(true); };
      const onError = () => { cleanup(); resolve(false); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, INITIAL_CONNECT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        client.off('ready', onReady);
        client.off('error', onError);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
    if (!ready) {
      console.error(
        `[world-redis] Not ready within ${INITIAL_CONNECT_TIMEOUT_MS}ms (url=${url}). ` +
          `worldsvc degraded (march scheduling falls back to Mongo, channels disabled).`,
      );
      client.disconnect();
      return null;
    }

    const wrapped: WorldRedis = {
      publish: (channel, message) => client.publish(channel, message),
      hset: (key, field, value) => client.hset(key, field, value),
      hget: (key, field) => client.hget(key, field),
      hdel: (key, ...fields) => client.hdel(key, ...fields),
      quit: () => client.quit(),
      del: (key) => client.del(key),
      // See WorldRedis.hmergeJsonField doc comment — closes the addCover/removeCover read-modify-write
      // race by running the merge server-side in a single atomic Lua script.
      hmergeJsonField: (key, field, entryKey, entryJson) =>
        client.eval(MERGE_JSON_FIELD_SCRIPT, 1, key, field, entryKey, entryJson ?? ''),
    };
    return wrapped;
  } catch (e) {
    console.error(
      `[world-redis] Failed to connect to Redis (url=${url}): ${(e as Error).message}. ` +
        `worldsvc degraded (march scheduling falls back to Mongo, channels disabled).`,
    );
    return null;
  }
}
