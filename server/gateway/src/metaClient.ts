// gateway → meta internal calls (M17). Used to fetch the player's current ELO (for matchmaking and
// deck-unlock validation) before enqueueing for ranked, and pass it into matchsvc enqueue so matchsvc
// stays DB-free (SERVER_API.md §8.5).
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). meta unavailable → fall back to initial rating.
// All calls go through fetchInternalJson (5s timeout, drained body, never throws) and degrade to their
// documented fallback values on any failure.
import { INITIAL_ELO, fetchInternalJson } from '@nw/shared';

export class MetaClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://meta:8080 (no /api prefix, direct internal connection)
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  private get<T>(pathAndQuery: string, label: string) {
    return fetchInternalJson<T>(`${this.baseUrl}${pathAndQuery}`, {
      caller: 'gateway',
      key: this.internalKey,
      timeoutMs: 5000,
      label,
    });
  }

  /** Fetch current ELO; meta not configured / error → return INITIAL_ELO. */
  async getElo(accountId: string): Promise<{ elo: number }> {
    if (!this.baseUrl) return { elo: INITIAL_ELO };
    const r = await this.get<{ elo?: number }>(
      `/internal/elo?accountId=${encodeURIComponent(accountId)}`,
      '/internal/elo',
    );
    if (!r.ok || !r.body) return { elo: INITIAL_ELO };
    return { elo: typeof r.body.elo === 'number' ? r.body.elo : INITIAL_ELO };
  }

  /**
   * Fetch a player's public profile (display name + 9-digit public id) for room display.
   * meta not configured / error → return empty (gateway falls back to accountId prefix as name, publicId empty).
   */
  async getProfile(accountId: string): Promise<{ displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string }> {
    if (!this.baseUrl) return {};
    const r = await this.get<{ displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string }>(
      `/internal/profile?accountId=${encodeURIComponent(accountId)}`,
      '/internal/profile',
    );
    return r.ok && r.body ? r.body : {};
  }

  /**
   * Merged elo+profile lookup (comm-audit batch F item 1): collapses the enqueue/room/duel-respond
   * paths' getElo()+getProfile() double hop into meta's existing /internal/player endpoint.
   * meta not configured / error → INITIAL_ELO + empty profile (same degrade as the two calls it replaces).
   */
  async getMatchIdentity(accountId: string): Promise<{ elo: number; displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string; equippedSkins?: string[] }> {
    if (!this.baseUrl) return { elo: INITIAL_ELO };
    const r = await this.get<{ elo?: number; displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string; equippedSkins?: string[] }>(
      `/internal/player?accountId=${encodeURIComponent(accountId)}`,
      '/internal/player',
    );
    if (!r.ok || !r.body) return { elo: INITIAL_ELO };
    return {
      elo: typeof r.body.elo === 'number' ? r.body.elo : INITIAL_ELO,
      ...(r.body.displayName ? { displayName: r.body.displayName } : {}),
      ...(r.body.publicId ? { publicId: r.body.publicId } : {}),
      ...(r.body.equippedTitle ? { equippedTitle: r.body.equippedTitle } : {}),
      ...(r.body.avatarId ? { avatarId: r.body.avatarId } : {}),
      ...(r.body.equippedSkins?.length ? { equippedSkins: r.body.equippedSkins } : {}),
    };
  }

  /**
   * publicId → accountId reverse lookup (friend-challenge invite, ADR friends-duel-confirm): the
   * client only ever knows a friend's publicId, never their accountId. Mirrors socialsvc's
   * HttpSocialMetaClient.resolveByPublicId — same metaserver endpoint, different caller header.
   * meta not configured / not found / error → null.
   */
  async resolveByPublicId(publicId: string): Promise<{ accountId: string } | null> {
    if (!this.baseUrl) return null;
    const r = await this.get<{ accountId?: string }>(
      `/internal/account/by-public-id/${encodeURIComponent(publicId)}`,
      '/internal/account/by-public-id',
    );
    if (!r.ok || !r.body?.accountId) return null;
    return { accountId: r.body.accountId };
  }

  /**
   * Fetch the list of friend accountIds for an account (presence broadcast scope, SOC9). meta not configured / error → empty.
   */
  async getFriends(accountId: string): Promise<string[]> {
    if (!this.baseUrl) return [];
    const r = await this.get<{ friends?: string[] }>(
      `/internal/social/friends?accountId=${encodeURIComponent(accountId)}`,
      '/internal/social/friends',
    );
    if (!r.ok || !r.body) return [];
    return Array.isArray(r.body.friends) ? r.body.friends : [];
  }
}
