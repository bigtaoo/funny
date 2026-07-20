// gateway → meta internal calls (M17). Used to fetch the player's current ELO (for matchmaking and
// deck-unlock validation) before enqueueing for ranked, and pass it into matchsvc enqueue so matchsvc
// stays DB-free (SERVER_API.md §8.5).
// Internal auth: X-Internal-Key (shared NW_INTERNAL_KEY). meta unavailable → fall back to initial rating.
import { INITIAL_ELO, internalHeaders } from '@nw/shared';

export class MetaClient {
  constructor(
    private readonly baseUrl: string | null, // e.g. http://meta:8080 (no /api prefix, direct internal connection)
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  /** Fetch current ELO; meta not configured / error → return INITIAL_ELO. */
  async getElo(accountId: string): Promise<{ elo: number }> {
    if (!this.baseUrl) return { elo: INITIAL_ELO };
    try {
      const url = `${this.baseUrl}/internal/elo?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: internalHeaders('gateway', this.internalKey) });
      if (!res.ok) return { elo: INITIAL_ELO };
      const body = (await res.json()) as { elo?: number };
      const elo = typeof body.elo === 'number' ? body.elo : INITIAL_ELO;
      return { elo };
    } catch {
      return { elo: INITIAL_ELO };
    }
  }

  /**
   * Fetch a player's public profile (display name + 9-digit public id) for room display.
   * meta not configured / error → return empty (gateway falls back to accountId prefix as name, publicId empty).
   */
  async getProfile(accountId: string): Promise<{ displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string }> {
    if (!this.baseUrl) return {};
    try {
      const url = `${this.baseUrl}/internal/profile?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: internalHeaders('gateway', this.internalKey) });
      if (!res.ok) return {};
      return (await res.json()) as { displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string };
    } catch {
      return {};
    }
  }

  /**
   * Fetch the list of friend accountIds for an account (presence broadcast scope, SOC9). meta not configured / error → empty.
   */
  async getFriends(accountId: string): Promise<string[]> {
    if (!this.baseUrl) return [];
    try {
      const url = `${this.baseUrl}/internal/social/friends?accountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: internalHeaders('gateway', this.internalKey) });
      if (!res.ok) return [];
      const body = (await res.json()) as { friends?: string[] };
      return Array.isArray(body.friends) ? body.friends : [];
    } catch {
      return [];
    }
  }
}
