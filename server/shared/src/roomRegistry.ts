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
