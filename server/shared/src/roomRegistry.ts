// Room directory abstraction (META_DESIGN.md §6.5). v1 is an in-memory implementation; swap in a
// Redis implementation when scaling out — no changes to gameserver business logic needed. This is
// the single extension point to preserve for now.

export interface RoomInfo {
  roomId: string;
  code: string; // short code for friend rooms
  mode: 'friendly' | 'ranked';
  /** gameserver instance id that owns this room (constant in single-instance deployments). */
  instanceId: string;
  createdAt: number;
}

export interface RoomRegistry {
  create(info: RoomInfo): Promise<void>;
  getByCode(code: string): Promise<RoomInfo | null>;
  getById(roomId: string): Promise<RoomInfo | null>;
  remove(roomId: string): Promise<void>;
}

/** Single-instance in-memory implementation. Multi-instance deployments need consistent hashing by roomId + Redis pub-sub. */
export class InMemoryRoomRegistry implements RoomRegistry {
  private byId = new Map<string, RoomInfo>();
  private byCode = new Map<string, string>(); // short code → roomId

  async create(info: RoomInfo): Promise<void> {
    this.byId.set(info.roomId, info);
    this.byCode.set(info.code, info.roomId);
  }

  async getByCode(code: string): Promise<RoomInfo | null> {
    const id = this.byCode.get(code);
    return id ? this.byId.get(id) ?? null : null;
  }

  async getById(roomId: string): Promise<RoomInfo | null> {
    return this.byId.get(roomId) ?? null;
  }

  async remove(roomId: string): Promise<void> {
    const info = this.byId.get(roomId);
    if (info) this.byCode.delete(info.code);
    this.byId.delete(roomId);
  }
}

/**
 * C7 Redis implementation: any node can look up a roomId when scaling horizontally.
 * Stores data with HSET nw:rooms:<roomId> field value (TTL 24h to prevent leaks).
 * Uses dynamic import of ioredis (same pattern as worldsvc/gateway/redis.ts — compiles even when
 * ioredis is not installed in dev). Factory `createRedisRoomRegistry` returns null on connection
 * failure → caller falls back to InMemoryRoomRegistry.
 */
export class RedisRoomRegistry implements RoomRegistry {
  private readonly TTL_SEC = 86400; // 24h to prevent leaks
  private readonly PREFIX_ROOM = 'nw:rooms:';
  private readonly PREFIX_CODE = 'nw:room-codes:';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly client: any) {}

  async create(info: RoomInfo): Promise<void> {
    const key = this.PREFIX_ROOM + info.roomId;
    const codeKey = this.PREFIX_CODE + info.code;
    const payload = JSON.stringify(info);
    await Promise.all([
      this.client.set(key, payload, 'EX', this.TTL_SEC),
      this.client.set(codeKey, info.roomId, 'EX', this.TTL_SEC),
    ]);
  }

  async getByCode(code: string): Promise<RoomInfo | null> {
    const roomId = await this.client.get(this.PREFIX_CODE + code) as string | null;
    if (!roomId) return null;
    return this.getById(roomId);
  }

  async getById(roomId: string): Promise<RoomInfo | null> {
    const raw = await this.client.get(this.PREFIX_ROOM + roomId) as string | null;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomInfo;
    } catch {
      return null;
    }
  }

  async remove(roomId: string): Promise<void> {
    const info = await this.getById(roomId);
    const keys = [this.PREFIX_ROOM + roomId];
    if (info) keys.push(this.PREFIX_CODE + info.code);
    await this.client.del(...keys);
  }
}

/**
 * Factory: connect to Redis and return a RedisRoomRegistry; returns null on failure (caller degrades to in-memory).
 * Example: `const reg = await createRedisRoomRegistry(url) ?? new InMemoryRoomRegistry()`
 */
export async function createRedisRoomRegistry(url: string): Promise<RedisRoomRegistry | null> {
  try {
    const spec = 'ioredis';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(spec);
    const Redis = mod.default ?? mod;
    const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
    return new RedisRoomRegistry(client);
  } catch {
    return null;
  }
}
