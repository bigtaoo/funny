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
  | {
      kind: 'system_notify';
      message: string;
    };

export interface SocialGatewayClient {
  readonly available: boolean;
  push(accountId: string, msg: SocialPushMsg): Promise<void>;
  pushMany(accountIds: string[], msg: SocialPushMsg): Promise<void>;
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
}

export const nullSocialGatewayClient: SocialGatewayClient = {
  available: false,
  async push() { /* no-op */ },
  async pushMany() { /* no-op */ },
};
