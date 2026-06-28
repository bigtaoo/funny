// socialsvc → gateway 内部推送（SOCIAL_SVC_DESIGN §5）。
// socialsvc 是所有频道推送的调度层，经 /gw/push 下发给 gateway（accountId → socket）。
// gateway 未配置 → push 为 no-op（降级：客户端靠轮询）。
import { internalHeaders } from '@nw/shared';

export type SocialPushMsg =
  | {
      kind: 'family_msg';
      familyId: string;
      fromAccountId: string;
      fromName: string;
      body: string;
      ts: number;
    }
  | {
      kind: 'friend_online';
      accountId: string;
    }
  | {
      kind: 'friend_offline';
      accountId: string;
    }
  | {
      // 委托推送：来自 worldsvc/metaserver 的 /internal/push 转发
      kind: 'sect_msg';
      sectId: string;
      fromAccountId: string;
      fromName: string;
      body: string;
      ts: number;
    }
  | {
      kind: 'nation_msg';
      worldId: string;
      fromAccountId: string;
      fromName: string;
      body: string;
      ts: number;
    }
  | { kind: 'system_notify'; message: string }
  // P2: 好友 / 私聊 / 邮件实时推送
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean };

export interface SocialGatewayClient {
  readonly available: boolean;
  push(accountId: string, msg: SocialPushMsg): Promise<void>;
  pushMany(accountIds: string[], msg: SocialPushMsg): Promise<void>;
  /** 批量查在线态（好友列表用）。返回 accountId→bool map。 */
  presence(accountIds: string[]): Promise<Record<string, boolean>>;
  /** 好友关系变更后让 gateway 的好友缓存失效（presence 广播范围重拉）。best-effort。 */
  invalidateFriends(accountId: string): Promise<void>;
}

export class HttpSocialGatewayClient implements SocialGatewayClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/gw/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('socialsvc', this.internalKey) },
        body: JSON.stringify({ accountId, msg }),
      });
    } catch {
      // best-effort
    }
  }

  async pushMany(accountIds: string[], msg: SocialPushMsg): Promise<void> {
    if (!this.baseUrl || accountIds.length === 0) return;
    await Promise.allSettled(accountIds.map((id) => this.push(id, msg)));
  }

  async presence(accountIds: string[]): Promise<Record<string, boolean>> {
    if (!this.baseUrl || accountIds.length === 0) return {};
    try {
      const qs = encodeURIComponent(accountIds.join(','));
      const res = await fetch(`${this.baseUrl}/gw/presence?accounts=${qs}`, {
        headers: internalHeaders('socialsvc', this.internalKey),
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
        headers: { 'content-type': 'application/json', ...internalHeaders('socialsvc', this.internalKey) },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // best-effort
    }
  }
}

export const nullSocialGatewayClient: SocialGatewayClient = {
  available: false,
  async push() { /* no-op */ },
  async pushMany() { /* no-op */ },
  async presence() { return {}; },
  async invalidateFriends() { /* no-op */ },
};
