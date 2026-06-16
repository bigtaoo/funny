// worldsvc → gateway 内部推送（S8-2）。SLG 实时事件（行军状态 / 格变更）按 owner accountId
// 定向经 gateway /gw/push 下发（与 social 同 SOC3 原则：动作走 REST、事件走 push）。
// 内部鉴权 X-Internal-Key（共用 NW_INTERNAL_KEY）。gateway 未配置基址 → push 为 no-op
// （worldsvc 降级：客户端靠 REST 轮询 /world/me、/world/map 看状态）。与 meta gatewayClient 同形。
//
// 注：worldsvc 侧 SlgPushMsg 的 kind/字段须与 gateway matchsvcClient.PushMsg 的 SLG 分支逐字对齐
// （JSON 线契约，camelCase discriminator=kind）。

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
    };

export interface WorldGatewayClient {
  readonly available: boolean;
  /** 据 accountId 定向推一条 SLG 事件（离线 / 未配置 gateway → 丢弃）。best-effort，不抛。 */
  push(accountId: string, msg: SlgPushMsg): Promise<void>;
}

export class HttpWorldGatewayClient implements WorldGatewayClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://gateway:8090（内部 HTTP 端口）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
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
}

/** 测试/无 gateway 时的空实现。 */
export const nullWorldGatewayClient: WorldGatewayClient = {
  available: false,
  async push() {
    /* no-op */
  },
};
