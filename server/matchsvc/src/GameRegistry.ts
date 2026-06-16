// game 实例注册表（M17，matchsvc 内）。gameserver 启动时 POST /mm/game/register 上报
// 公开 WS 地址 + 容量，周期 heartbeat 上报负载；matchsvc 据此把对局分配到最空闲的健康实例。
//
// 单实例部署可不注册——用 env 兜底地址（GatewayEnv.gamePublicWsUrl）建一条静态条目。
// 多实例横扩时此表是「谁有空闲 game」的唯一知情者（玩家 / meta 都无需知道 game 拓扑）。

export interface GameInstance {
  gameId: string;
  wsUrl: string;
  capacity: number;
  load: number;
  lastSeen: number;
}

/** 心跳过期阈值：超过此时长未上报视为不健康，不再分配。 */
const STALE_MS = 30_000;

export class GameRegistry {
  private readonly instances = new Map<string, GameInstance>();

  constructor(
    /** 注入时钟（测试用）。 */
    private readonly now: () => number = Date.now,
    /** 单实例兜底地址；注册表为空时分配它。 */
    private readonly fallbackWsUrl: string | null = null,
  ) {}

  register(gameId: string, wsUrl: string, capacity: number): void {
    this.instances.set(gameId, {
      gameId,
      wsUrl,
      capacity: Math.max(1, capacity),
      load: 0,
      lastSeen: this.now(),
    });
  }

  heartbeat(gameId: string, load: number, _rooms: number): void {
    const inst = this.instances.get(gameId);
    if (!inst) return;
    inst.load = Math.max(0, load);
    inst.lastSeen = this.now();
  }

  /** 实时态聚合（admin 监控，OPS_DESIGN §4.1）：健康实例数 + 负载/容量合计。 */
  stats(): { instances: number; load: number; capacity: number } {
    const t = this.now();
    let instances = 0;
    let load = 0;
    let capacity = 0;
    for (const inst of this.instances.values()) {
      if (t - inst.lastSeen > STALE_MS) continue; // 不健康，不计入
      instances++;
      load += inst.load;
      capacity += inst.capacity;
    }
    return { instances, load, capacity };
  }

  /** 挑负载最低且健康的实例 wsUrl；无注册实例时退回兜底地址（null = 无 game 可用）。 */
  pick(): string | null {
    const t = this.now();
    let best: GameInstance | null = null;
    for (const inst of this.instances.values()) {
      if (t - inst.lastSeen > STALE_MS) continue; // 不健康
      if (inst.load >= inst.capacity) continue; // 满载
      const ratio = inst.load / inst.capacity;
      if (!best || ratio < best.load / best.capacity) best = inst;
    }
    if (best) {
      best.load++; // 乐观占位（下次 heartbeat 校准）
      return best.wsUrl;
    }
    return this.fallbackWsUrl;
  }
}
