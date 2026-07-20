// socialsvc → metaserver internal client (P2).
// Used for publicId→accountId reverse-lookup + batch profile retrieval (friend list / request display names).
// Both internal endpoints are implemented in metaserver/src/internal.ts (NW_META_INTERNAL_URL).
import { internalHeaders } from '@nw/shared';
import type { ProfileView } from '@nw/shared';

export interface SocialMetaClient {
  readonly available: boolean;
  /** publicId → accountId + basic profile. Not found → null. */
  resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null>;
  /** Batch accountId → profile map (missing accountIds are silently skipped). */
  batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>>;
  /** Ladder rank + ELO for one accountId (unified profile popup, S8-4 family/friends rank display). Null on lookup failure. */
  getPlayerRank(accountId: string): Promise<{ rank?: string; elo?: number } | null>;
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

  async getPlayerRank(accountId: string): Promise<{ rank?: string; elo?: number } | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/player?accountId=${encodeURIComponent(accountId)}`,
        { headers: internalHeaders('socialsvc', this.internalKey) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { rank?: string; elo?: number };
      return { ...(data.rank ? { rank: data.rank } : {}), ...(data.elo !== undefined ? { elo: data.elo } : {}) };
    } catch {
      return null;
    }
  }
}

export const nullSocialMetaClient: SocialMetaClient = {
  available: false,
  async resolveByPublicId() { return null; },
  async batchProfiles() { return new Map(); },
  async getPlayerRank() { return null; },
};
