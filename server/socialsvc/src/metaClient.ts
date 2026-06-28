// socialsvc → metaserver 内部客户端（P2）。
// 用于 publicId→accountId 反查 + 批量资料获取（好友列表/申请显示名）。
// 两个内部端点由 metaserver/src/internal.ts 实现（NW_META_INTERNAL_URL）。
import { internalHeaders } from '@nw/shared';
import type { ProfileView } from '@nw/shared';

export interface SocialMetaClient {
  readonly available: boolean;
  /** publicId → accountId + 基础资料。不存在 → null。 */
  resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null>;
  /** 批量 accountId → 资料映射（缺失 accountId 直接跳过）。 */
  batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>>;
}

export class HttpSocialMetaClient implements SocialMetaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return true; }

  async resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/account/by-public-id/${encodeURIComponent(publicId)}`,
        { headers: internalHeaders('socialsvc', this.internalKey) },
      );
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return (await res.json()) as { accountId: string; profile: ProfileView };
    } catch {
      return null;
    }
  }

  async batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>> {
    const out = new Map<string, ProfileView>();
    if (accountIds.length === 0) return out;
    try {
      const res = await fetch(`${this.baseUrl}/internal/account/batch-profiles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('socialsvc', this.internalKey) },
        body: JSON.stringify({ accountIds }),
      });
      if (!res.ok) return out;
      const data = (await res.json()) as { profiles: Record<string, ProfileView> };
      for (const [id, p] of Object.entries(data.profiles)) {
        out.set(id, p);
      }
    } catch {
      // best-effort
    }
    return out;
  }
}

export const nullSocialMetaClient: SocialMetaClient = {
  available: false,
  async resolveByPublicId() { return null; },
  async batchProfiles() { return new Map(); },
};
