// meta → gateway 内部调用（Phase C 对等裁判）。ranked 局 hash 不一致时，meta 把整局
// 录像发给 gateway，由 gateway 挑一名高配空闲在线玩家无头复算，回报终局 hash + winner。
// 内部鉴权：X-Internal-Key（共用 NW_INTERNAL_KEY）。gateway 未配置 → 裁判不可用（作废）。
//
// 与 commercialClient 同形：HTTP 实现 + 接口（便于测试注入假裁判）。

/** 录像帧（command bytes 用 base64 传输，JSON 安全；gateway 解回 bytes 推给裁判客户端）。 */
export interface JudgeFrame {
  frame: number;
  cmds: { side: number; commands: string }[];
}

export interface JudgeReq {
  seed: number;
  /** MatchMode 数值（ranked = 1）。 */
  mode: number;
  endFrame: number;
  frames: JudgeFrame[];
  /** 参赛双方 accountId——不可自己裁自己（PvE 仅排除本人）。 */
  exclude: string[];
  /** PvE 抽检复算（PVE_INTEGRITY §8.6 L1）：非空 → 裁判按战役模式复算该关。 */
  levelId?: string;
  /** 服务器权威蓝图快照（升级等级），保证 PvE 复算确定性。 */
  pveUpgrades?: Record<string, number>;
}

export interface JudgeRes {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  /** PvE 复算得到的星数（PVE_INTEGRITY §8.6 L1）。 */
  stars?: number;
  judgeAccountId?: string;
}

/**
 * 社交实时推送（S6，SOCIAL_DESIGN §4.2）：meta → gateway /gw/push 据 accountId 定向下发。
 * 与 gateway 侧 PushMsg 社交分支同形（JSON 线契约，camelCase discriminator=kind）。
 */
export type SocialPushMsg =
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean };

export interface GatewayClient {
  readonly available: boolean;
  judge(req: JudgeReq): Promise<JudgeRes>;
  /** 据 accountId 定向推一条社交消息（离线 gateway 丢弃）。best-effort，不抛。 */
  push(accountId: string, msg: SocialPushMsg): Promise<void>;
  /** 批量查在线态（好友列表标 online flag）；gateway 不可用 / 出错 → 全 false。 */
  presence(accountIds: string[]): Promise<Record<string, boolean>>;
  /** 好友关系变更后让 gateway 的好友缓存失效（presence 广播范围重拉）。best-effort。 */
  invalidateFriends(accountId: string): Promise<void>;
}

export class HttpGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://gateway:8090（内部 HTTP 端口）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  /** 出错 / 未配置 / 无候选 → {ok:false}（meta 退回作废，不定罪）。 */
  async judge(req: JudgeReq): Promise<JudgeRes> {
    if (!this.baseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.baseUrl}/gw/judge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify(req),
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as JudgeRes;
    } catch {
      return { ok: false };
    }
  }

  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify({ accountId, msg }),
      });
    } catch {
      // best-effort：推送失败不影响已落库的数据；客户端下次登录拉取。
    }
  }

  async presence(accountIds: string[]): Promise<Record<string, boolean>> {
    if (!this.baseUrl || accountIds.length === 0) return {};
    try {
      const qs = encodeURIComponent(accountIds.join(','));
      const res = await fetch(`${this.baseUrl}/gw/presence?accounts=${qs}`, {
        headers: { 'X-Internal-Key': this.internalKey },
      });
      if (!res.ok) return {};
      return (await res.json()) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  async invalidateFriends(accountId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/social/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // best-effort：缓存最终一致；失败仅导致 presence 范围短暂滞后。
    }
  }
}
