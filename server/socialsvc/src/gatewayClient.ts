// socialsvc → gateway internal push (SOCIAL_SVC_DESIGN §5).
// socialsvc is the dispatch layer for all channel pushes, delivered to gateway via /gw/push (accountId → socket).
// If gateway is not configured → push is a no-op (fallback: client relies on polling).
import { internalHeaders, postInternal } from '@nw/shared';

export type SocialPushMsg =
  | {
      kind: 'family_msg';
      familyId: string;
      fromAccountId: string;
      fromName: string;
      title?: string;
      familyName?: string;
      body: string;
      ts: number;
    }
  | { kind: 'friend_presence'; publicId: string; online: boolean }
  | {
      // Delegated push: forwarded from worldsvc/metaserver via /internal/push
      kind: 'sect_msg';
      sectId: string;
      fromAccountId: string;
      fromName: string;
      title?: string;
      sectName?: string;
      familyName?: string;
      body: string;
      ts: number;
    }
  | {
      kind: 'nation_msg';
      worldId: string;
      fromAccountId: string;
      fromName: string;
      title?: string;
      sectName?: string;
      familyName?: string;
      body: string;
      ts: number;
    }
  | { kind: 'system_notify'; message: string }
  // P2: friend / private chat / mail real-time push
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean };

export interface SocialGatewayClient {
  readonly available: boolean;
  push(accountId: string, msg: SocialPushMsg): Promise<void>;
  pushMany(accountIds: string[], msg: SocialPushMsg): Promise<void>;
  /** Batch presence query (used for friend lists). Returns an accountId→bool map. */
  presence(accountIds: string[]): Promise<Record<string, boolean>>;
  /** Invalidate the gateway's friend cache after a friend-relationship change (re-fetch presence broadcast scope). Best-effort. */
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
    // best-effort, self-healing (clients also poll) → retries=0; the win here is the
    // body-drain + timeout postInternal applies (a large channel fanout is a burst).
    await postInternal(`${this.baseUrl}/gw/push`, { accountId, msg }, {
      caller: 'socialsvc',
      key: this.internalKey,
      label: `/gw/push ${msg.kind}`,
    });
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
    await postInternal(`${this.baseUrl}/gw/social/invalidate`, { accountId }, {
      caller: 'socialsvc',
      key: this.internalKey,
      label: '/gw/social/invalidate',
    });
  }
}

export const nullSocialGatewayClient: SocialGatewayClient = {
  available: false,
  async push() { /* no-op */ },
  async pushMany() { /* no-op */ },
  async presence() { return {}; },
  async invalidateFriends() { /* no-op */ },
};
