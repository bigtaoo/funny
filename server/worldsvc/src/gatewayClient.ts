// worldsvc → gateway 内部推送（S8-2）。SLG 实时事件（行军状态 / 格变更）按 owner accountId
// 定向经 gateway /gw/push 下发（与 social 同 SOC3 原则：动作走 REST、事件走 push）。
// 内部鉴权 X-Internal-Key（共用 NW_INTERNAL_KEY）。gateway 未配置基址 → push 为 no-op
// （worldsvc 降级：客户端靠 REST 轮询 /world/me、/world/map 看状态）。与 meta gatewayClient 同形。
//
// 注：worldsvc 侧 SlgPushMsg 的 kind/字段须与 gateway matchsvcClient.PushMsg 的 SLG 分支逐字对齐
// （JSON 线契约，camelCase discriminator=kind）。
import { GW_PUSH_REDIS_CHANNEL } from '@nw/shared';

export type SlgPushMsg =
  | {
      kind: 'march_update';
      marchId: string;
      marchKind: string; // attack | reinforce | occupy | sweep | return
      fromTile: string;
      toTile: string;
      arriveAt: number; // ms
      status: string; // marching | arrived | recalled
    }
  | {
      kind: 'tile_update';
      tileId: string;
      type: string; // TileType
      level: number;
      ownerId: string; // 占领者标识（空=中立）；S8-2 暂用 accountId，publicId 解析待后补
      familyId: string;
      protectedUntil: number; // ms（0=无保护）
    }
  | {
      kind: 'under_attack'; // S8-3：出征发起即推给防守方（预警，到达时刻 + 兵力估计）
      tile: string;
      attackerName: string; // 攻方标识；S8-3 暂用 accountId，publicId 解析待后补
      attackerPublicId: string;
      arriveAt: number; // ms
      troopsHint: number;
    }
  | {
      kind: 'siege_result'; // S8-3：围攻结算后推给攻守双方
      siegeId: string;
      tile: string;
      outcome: string; // attacker_win | defender_win | draw
      lootSummary: string; // 人读摘要（如 "food+250"），UI 直接展示
      replayRef: string; // 录像引用（S8-3b 接 judge 复算后填，当前空）
    }
  | {
      kind: 'family_msg'; // S8-4：家族频道新消息（仅推给在线成员）
      familyId: string;
      fromPublicId: string; // S8-4 暂用 accountId，publicId 解析待后补
      fromName: string;
      body: string;
      ts: number; // ms（epoch，非 Date）
    }
  | {
      kind: 'sect_msg'; // S8-4b：宗门频道新消息（经 Redis 扇出给在线成员）
      sectId: string;
      fromPublicId: string; // 暂用 accountId，publicId 解析待后补
      fromName: string;
      body: string;
      ts: number; // ms（epoch，非 Date）
    };

/** S8-3b：worldsvc → gateway judge 请求（关键围攻录像复算）。 */
export interface WorldJudgeArgs {
  seed: number;
  mode: number;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: string }[] }[];
  exclude: string[];
  /** 防守 config JSON 字符串（siege 模式，gateway judge 用来重建防守关）。 */
  defenseJson?: string;
  pveUpgrades?: Record<string, number>;
}

export interface WorldJudgeResult {
  ok: boolean;
  winnerSide?: number;
  stateHash?: string;
  judgeAccountId?: string;
}

export interface WorldGatewayClient {
  readonly available: boolean;
  /** 据 accountId 定向推一条 SLG 事件（离线 / 未配置 gateway → 丢弃）。best-effort，不抛。 */
  push(accountId: string, msg: SlgPushMsg): Promise<void>;
  /**
   * 群发一条 SLG 事件给一批收件人（S8-4b 宗门频道）。Redis 可用 → 发一条到
   * GW_PUSH_REDIS_CHANNEL，由各 gateway 实例据在线成员扇出（避免 ≤900 人 O(n) HTTP）；
   * 无 Redis → 降级逐个 HTTP push 兜底。best-effort，不抛。
   */
  broadcast(recipients: string[], msg: SlgPushMsg): Promise<void>;
  /** S8-3b：关键围攻录像送 gateway 裁判复算。gateway 未配置 → 返回 { ok: false }。 */
  judge(args: WorldJudgeArgs): Promise<WorldJudgeResult>;
}

/** broadcast 用到的最小 Redis 接口（publish）；与 worldsvc/redis.ts 的 WorldRedis 结构相容。 */
export interface BroadcastRedis {
  publish(channel: string, message: string): Promise<unknown>;
}

export class HttpWorldGatewayClient implements WorldGatewayClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
    /** 可选 Redis：用于宗门频道扇出（缺省 → broadcast 降级为逐个 HTTP push）。 */
    private readonly redis: BroadcastRedis | null = null,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async broadcast(recipients: string[], msg: SlgPushMsg): Promise<void> {
    if (recipients.length === 0) return;
    if (this.redis) {
      try {
        await this.redis.publish(GW_PUSH_REDIS_CHANNEL, JSON.stringify({ recipients, msg }));
        return;
      } catch {
        // Redis publish 失败 → 落到 HTTP 兜底（不抛，频道已落库可 REST 拉取）。
      }
    }
    await Promise.allSettled(recipients.map((r) => this.push(r, msg)));
  }

  async push(accountId: string, msg: SlgPushMsg): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify({ accountId, msg }),
      });
    } catch {
      // best-effort：推送失败不影响已落库的权威状态；客户端下次 REST 轮询拉到。
    }
  }

  async judge(args: WorldJudgeArgs): Promise<WorldJudgeResult> {
    if (!this.baseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.baseUrl}/gw/judge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify(args),
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as WorldJudgeResult;
    } catch {
      return { ok: false };
    }
  }
}

/** 测试/无 gateway 时的空实现。 */
export const nullWorldGatewayClient: WorldGatewayClient = {
  available: false,
  async push() { /* no-op */ },
  async broadcast() { /* no-op */ },
  async judge() { return { ok: false }; },
};
