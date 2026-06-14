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
  /** 参赛双方 accountId——不可自己裁自己。 */
  exclude: string[];
}

export interface JudgeRes {
  ok: boolean;
  stateHash?: string;
  winnerSide?: number;
  judgeAccountId?: string;
}

export interface GatewayClient {
  readonly available: boolean;
  judge(req: JudgeReq): Promise<JudgeRes>;
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
}
