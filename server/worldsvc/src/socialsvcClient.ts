// worldsvc → socialsvc 客户端（SOCIAL_SVC_DESIGN §4.2 / P1）。
// 两类调用：
//   内部 API（/internal/*）：X-Internal-Key，用于查 familyId 和委托频道推送。
//   公网代理（/social/*）：转发玩家 JWT，用于 /family/* 过渡期路由。
import { internalHeaders } from '@nw/shared';

/** 推送频道描述（/internal/push 请求体 channel 字段）。 */
export type SocialsvcChannel =
  | { kind: 'account'; accountId: string }
  | { kind: 'family';  familyId: string }
  | { kind: 'sect';    sectId: string }
  | { kind: 'world';   worldId: string };

export interface WorldSocialsvcClient {
  readonly available: boolean;
  /** 内部：查玩家当前所在 familyId（无则 null）。 */
  getFamilyId(accountId: string): Promise<string | null>;
  /**
   * 内部：委托频道推送。
   * targets 为明确收件人列表（worldsvc 已知成员时传入，跳过 socialsvc 侧 Redis 查询）；
   * 省略时 socialsvc 按 channel 自行路由（P3 Redis pub/sub 完整实现后可去掉 targets）。
   */
  push(channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void>;
  /**
   * 公网代理：转发玩家 JWT 调 socialsvc 公网端点，返回解析后的响应体。
   * 供 worldsvc /family/* 过渡期路由使用。
   */
  proxy(method: 'GET' | 'POST', path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }>;
}

export class HttpWorldSocialsvcClient implements WorldSocialsvcClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/family/by-account/${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('worldsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { familyId?: string | null } };
      return json.data?.familyId ?? null;
    } catch {
      return null;
    }
  }

  async push(channel: SocialsvcChannel, event: string, payload: unknown, targets?: string[]): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({ channel, event, payload, ...(targets ? { targets } : {}) }),
      });
    } catch {
      // best-effort：push 失败不影响已落库的消息，客户端靠 REST 拉取。
    }
  }

  async proxy(method: 'GET' | 'POST', path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }> {
    if (!this.baseUrl) return { status: 503, data: { error: 'socialsvc not configured' } };
    try {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        'authorization': authorization,
        'x-internal-caller': 'worldsvc',
      };
      let fetchOpts: RequestInit = { method, headers };
      if (method === 'POST' && body != null) {
        headers['content-type'] = 'application/json';
        fetchOpts = { ...fetchOpts, body: JSON.stringify(body) };
      }
      const res = await fetch(url, fetchOpts);
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch {
      return { status: 503, data: { error: 'socialsvc unreachable' } };
    }
  }
}

export const nullWorldSocialsvcClient: WorldSocialsvcClient = {
  available: false,
  async getFamilyId() { return null; },
  async push() { /* no-op */ },
  async proxy() { return { status: 503, data: { error: 'socialsvc not configured' } }; },
};
