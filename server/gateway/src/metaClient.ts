// gateway → meta 内部调用（M17）。目前只用一处：ranked 入队前取玩家当前 ELO，
// 带进 matchsvc enqueue，让 matchsvc 保持 DB-free（SERVER_API.md §8.5）。
// 内部鉴权：X-Internal-Key（共用 NW_INTERNAL_KEY）。meta 不可用 → 退回初始分。
import { INITIAL_ELO } from '@nw/shared';

export class MetaClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://meta:8080（无 /api 前缀，内部直连）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  /** 取 ELO；meta 未配置 / 出错 → 返回 INITIAL_ELO（ranked 仍可匹配，分数从初始算）。 */
  async getElo(accountId: string): Promise<number> {
    if (!this.baseUrl) return INITIAL_ELO;
    try {
      const url = `${this.baseUrl}/internal/elo?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: { 'X-Internal-Key': this.internalKey } });
      if (!res.ok) return INITIAL_ELO;
      const body = (await res.json()) as { elo?: number };
      return typeof body.elo === 'number' ? body.elo : INITIAL_ELO;
    } catch {
      return INITIAL_ELO;
    }
  }

  /**
   * 取玩家公开资料（展示名 + 9 位数字公开 id），用于房间显示。meta 未配置 / 出错 →
   * 返回空（gateway 退回 accountId 前缀做名字、publicId 为空）。
   */
  async getProfile(accountId: string): Promise<{ displayName?: string; publicId?: string }> {
    if (!this.baseUrl) return {};
    try {
      const url = `${this.baseUrl}/internal/profile?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: { 'X-Internal-Key': this.internalKey } });
      if (!res.ok) return {};
      return (await res.json()) as { displayName?: string; publicId?: string };
    } catch {
      return {};
    }
  }

  /**
   * 取某账号的好友 accountId 列表（presence 广播范围，SOC9）。meta 未配置 / 出错 → 空。
   */
  async getFriends(accountId: string): Promise<string[]> {
    if (!this.baseUrl) return [];
    try {
      const url = `${this.baseUrl}/internal/social/friends?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: { 'X-Internal-Key': this.internalKey } });
      if (!res.ok) return [];
      const body = (await res.json()) as { friends?: string[] };
      return Array.isArray(body.friends) ? body.friends : [];
    } catch {
      return [];
    }
  }
}
