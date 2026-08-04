// socialsvc → metaserver internal client (P2).
// Used for publicId→accountId reverse-lookup + batch profile retrieval (friend list / request display names).
// Both internal endpoints are implemented in metaserver/src/internal.ts (NW_META_INTERNAL_URL).
import { fetchInternalJson } from '@nw/shared';
import type { ProfileView } from '@nw/shared';

export interface SocialMetaClient {
  readonly available: boolean;
  /** publicId → accountId + basic profile. Not found → null. */
  resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null>;
  /** Batch accountId → profile map (missing accountIds are silently skipped). */
  batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>>;
  /**
   * publicId → accountId + rank/elo in a single round trip (comm-audit batch F item 2): meta's
   * /internal/player already accepts publicId directly, so the profile-popup "extra" lookup needs
   * no separate resolveByPublicId hop. Not found → null.
   */
  getPlayerRankByPublicId(publicId: string): Promise<{ accountId: string; rank?: string; elo?: number } | null>;
}

export class HttpSocialMetaClient implements SocialMetaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return true; }

  async resolveByPublicId(publicId: string): Promise<{ accountId: string; profile: ProfileView } | null> {
    // Degrades to null on 404 (not found) and on any failure, as before.
    const r = await fetchInternalJson<{ accountId: string; profile: ProfileView }>(
      `${this.baseUrl}/internal/account/by-public-id/${encodeURIComponent(publicId)}`,
      { caller: 'socialsvc', key: this.internalKey, timeoutMs: 5000, label: 'meta /internal/account/by-public-id' },
    );
    if (!r.ok || !r.body) return null;
    return r.body;
  }

  async batchProfiles(accountIds: string[]): Promise<Map<string, ProfileView>> {
    const out = new Map<string, ProfileView>();
    if (accountIds.length === 0) return out;
    // Best-effort: any failure returns whatever was collected (empty map), as before.
    const r = await fetchInternalJson<{ profiles: Record<string, ProfileView> }>(
      `${this.baseUrl}/internal/account/batch-profiles`,
      {
        caller: 'socialsvc',
        key: this.internalKey,
        method: 'POST',
        body: { accountIds },
        timeoutMs: 5000,
        label: 'meta /internal/account/batch-profiles',
      },
    );
    if (!r.ok || !r.body?.profiles) return out;
    for (const [id, p] of Object.entries(r.body.profiles)) {
      out.set(id, p);
    }
    return out;
  }

  async getPlayerRankByPublicId(publicId: string): Promise<{ accountId: string; rank?: string; elo?: number } | null> {
    const r = await fetchInternalJson<{ accountId?: string; rank?: string; elo?: number }>(
      `${this.baseUrl}/internal/player?publicId=${encodeURIComponent(publicId)}`,
      { caller: 'socialsvc', key: this.internalKey, timeoutMs: 5000, label: 'meta /internal/player' },
    );
    const accountId = r.ok ? r.body?.accountId : undefined;
    if (!accountId) return null;
    const data = r.body!;
    return {
      accountId,
      ...(data.rank ? { rank: data.rank } : {}),
      ...(data.elo !== undefined ? { elo: data.elo } : {}),
    };
  }
}

export const nullSocialMetaClient: SocialMetaClient = {
  available: false,
  async resolveByPublicId() { return null; },
  async batchProfiles() { return new Map(); },
  async getPlayerRankByPublicId() { return null; },
};
