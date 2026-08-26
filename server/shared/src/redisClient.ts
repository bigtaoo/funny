// Structural typing for the Redis client (2026-08-26). This used to be `export type RedisLike = any`
// in activeMatch.ts, threaded through ~20 files across matchsvc / metaserver / commercial / gateway —
// which meant no Redis call anywhere on the server was type-checked: a typo'd command name or a swapped
// argument order compiled fine and only blew up at runtime (or, worse, silently no-op'd inside one of the
// many best-effort `catch` blocks these modules wrap their Redis I/O in).
//
// Why a hand-written interface instead of `import type Redis from 'ioredis'`: @nw/shared must compile
// without ioredis installed. gateway/matchsvc/metaserver/worldsvc each declare ioredis as a dependency,
// but @nw/shared deliberately does not (it is also linked into processes that never touch Redis), so a
// static `import ... from 'ioredis'` would break `tsc -b` wherever the package isn't installed — which is
// why `loadIoRedisCtor` below still goes through a variable-specifier dynamic import. The interface follows
// worldsvc/src/redis.ts's WorldRedis convention: declare only the commands we actually call, with the
// signatures we actually call them with (so e.g. `set(key, val, 'EX', ttl)` is checked, and the classic
// mode/ttl swap is a compile error), and let the loader's single cast be the one unchecked seam.

/** MULTI pipeline (matchsvc/src/persist.ts). Only the commands persist.ts queues are declared; each
 *  returns the builder so calls can chain, matching ioredis's chainable multi. */
export interface RedisMulti {
  set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): RedisMulti;
  del(...keys: string[]): RedisMulti;
  zadd(key: string, score: number, member: string): RedisMulti;
  zrem(key: string, ...members: string[]): RedisMulti;
  /** Resolves once every queued command has run; matchsvc ignores the per-command results. */
  exec(): Promise<unknown>;
}

/** Non-transactional pipeline (gateway/src/redis.ts's batch presence check). `exec` resolves to one
 *  `[error, reply]` tuple per queued command, in order — or null if the pipeline was discarded. */
export interface RedisPipeline {
  exists(key: string): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * The Redis command surface the server actually uses. Return types are `unknown` wherever no caller reads
 * the reply (the value of this interface is checking command names and argument shapes, not reply parsing)
 * — which also keeps the in-memory test fakes in matchsvc/shared/gateway easy to satisfy.
 */
export interface RedisLike {
  // ── strings ────────────────────────────────────────────────────────────────
  get(key: string): Promise<string | null>;
  /** `mode`/`ttl` are the SET expiry options: 'EX' seconds (activeMatch, persist) or 'PX' milliseconds (gateway presence). */
  set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  del(...keys: string[]): Promise<unknown>;
  /** Only ever called on matchsvc's own small private namespaces — see loadAllRooms' doc comment for why KEYS is acceptable there. */
  keys(pattern: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;

  // ── hashes ─────────────────────────────────────────────────────────────────
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hincrby(key: string, field: string, delta: number): Promise<number>;

  // ── sorted sets ────────────────────────────────────────────────────────────
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;

  // ── scripting ──────────────────────────────────────────────────────────────
  /** EVAL: script, key count, then KEYS followed by ARGV (rateLimiter's sliding window, dailyCounter's
   *  guarded timestamp, worldsvc's atomic cover merge). Redis coerces every argument to a string. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;

  // ── pub/sub (publish side) ─────────────────────────────────────────────────
  /** Resolves to the number of subscribers that received the message — matchsvc's GatewayClient treats 0
   *  as "nobody delivered" and falls back to a direct HTTP push. */
  publish(channel: string, message: string): Promise<number>;

  // ── batching ───────────────────────────────────────────────────────────────
  multi(): RedisMulti;
  pipeline(): RedisPipeline;
}

/**
 * A live connection, i.e. `RedisLike` plus the lifecycle/subscription members the `connect*` helpers use.
 * Consumers that only issue commands should keep taking `RedisLike`; this is for the connection owner.
 */
export interface RedisConnection extends RedisLike {
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'ready' | 'connect' | 'close' | 'end' | 'reconnecting', listener: () => void): void;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  once(event: 'ready', listener: () => void): void;
  off(event: 'error', listener: (err: Error) => void): void;
  off(event: 'ready', listener: () => void): void;
  /** Subscriber mode: once subscribed, this connection can no longer issue ordinary commands — hence `duplicate()`. */
  subscribe(channel: string): Promise<unknown>;
  /** Opens a second socket with the same connection options (gateway needs three: subscribe / publish / rate-limit). */
  duplicate(): RedisConnection;
  /** Graceful close (drains in-flight commands). */
  quit(): Promise<unknown>;
  /** Immediate close, no drain — used when a connection turns out to be unusable during startup. */
  disconnect(): void;
}

/** The subset of ioredis's constructor options the server passes. */
export interface RedisConnectOptions {
  lazyConnect?: boolean;
  maxRetriesPerRequest?: number | null;
  /** ioredis re-subscribes automatically after a reconnect; gateway sets it explicitly for auditability. */
  autoResubscribe?: boolean;
}

export type RedisCtor = new (url: string, options?: RedisConnectOptions) => RedisConnection;

/**
 * Loads ioredis's constructor at runtime, typed as `RedisCtor`.
 *
 * The variable specifier is load-bearing, not a style choice: it stops tsc from resolving 'ioredis'
 * statically, so every workspace compiles whether or not ioredis is installed (see the header comment).
 * The cast here is the single unchecked seam in the whole Redis surface — everything downstream of it is
 * structurally typed, so a wrong command name or argument order is a compile error rather than a runtime one.
 */
export async function loadIoRedisCtor(): Promise<RedisCtor> {
  const spec = 'ioredis';
  const mod = (await import(spec)) as { default?: RedisCtor } & RedisCtor;
  return mod.default ?? mod;
}
