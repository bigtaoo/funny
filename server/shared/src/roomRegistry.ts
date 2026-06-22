// 房间目录抽象（META_DESIGN.md §6.5）。v1 内存实现；扩展时换 Redis 实现，
// 不动 gameserver 业务。这是现在唯一要留的口子。

export interface RoomInfo {
  roomId: string;
  code: string; // 好友房短码
  mode: 'friendly' | 'ranked';
  /** 持有该房的 gameserver 实例 id（单实例时恒定）。 */
  instanceId: string;
  createdAt: number;
}

export interface RoomRegistry {
  create(info: RoomInfo): Promise<void>;
  getByCode(code: string): Promise<RoomInfo | null>;
  getById(roomId: string): Promise<RoomInfo | null>;
  remove(roomId: string): Promise<void>;
}

/** 单实例内存实现。多实例需换一致性哈希 by roomId + Redis pub-sub。 */
export class InMemoryRoomRegistry implements RoomRegistry {
  private byId = new Map<string, RoomInfo>();
  private byCode = new Map<string, string>(); // code → roomId

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
 * C7 Redis 实现：横扩多实例时 roomId → 任意节点均可查。
 * 动态 import ioredis（与 worldsvc/gateway/redis.ts 同形，dev 未装也能编译）。
 * 工厂 `createRedisRoomRegistry` 连接失败时返回 null → 调用方回退到 InMemoryRoomRegistry。
 */
export class RedisRoomRegistry implements RoomRegistry {
  private readonly TTL_SEC = 86400; // 24h 防泄漏
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
 * 工厂：连接 Redis 并返回 RedisRoomRegistry；失败时返回 null（调用方降级到内存）。
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
