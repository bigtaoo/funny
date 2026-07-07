import { internalHeaders } from '@nw/shared';
import { log } from './shared';

// ── Player lookup (meta, player.lookup) ────────────────────
export interface PlayerProfile {
  publicId: string;
  accountId?: string;
  displayName?: string;
  rank?: string;
  elo?: number;
  wins?: number;
  losses?: number;
}

/** Fuzzy search hit row (= meta AccountSearchRow, shown in OPS list views). */
export interface PlayerSummary {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

export interface PlayerClient {
  readonly available: boolean;
  /** Look up a player profile by 9-digit public id; returns null if not found. */
  lookupByPublicId(publicId: string): Promise<PlayerProfile | null>;
  /** Look up a player profile by accountId; returns null if not found. */
  lookupByAccountId(accountId: string): Promise<PlayerProfile | null>;
  /** Fuzzy search (display name / login id / public id / accountId); returns a list of matching summaries. */
  search(q: string, limit: number): Promise<PlayerSummary[]>;
}

export class HttpPlayerClient implements PlayerClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async lookupByPublicId(publicId: string): Promise<PlayerProfile | null> {
    return this.lookup(`publicId=${encodeURIComponent(publicId)}`);
  }

  async lookupByAccountId(accountId: string): Promise<PlayerProfile | null> {
    return this.lookup(`accountId=${encodeURIComponent(accountId)}`);
  }

  private async lookup(qs: string): Promise<PlayerProfile | null> {
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/player?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.warn('player lookup non-2xx', { status: res.status });
        return null;
      }
      return (await res.json()) as PlayerProfile;
    } catch (e) {
      log.warn('player lookup failed', { err: (e as Error).message });
      return null;
    }
  }

  async search(q: string, limit: number): Promise<PlayerSummary[]> {
    if (!this.metaBaseUrl) return [];
    try {
      const res = await fetch(
        `${this.metaBaseUrl}/internal/players/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        { headers: internalHeaders('admin', this.internalKey) },
      );
      if (!res.ok) {
        log.warn('player search non-2xx', { status: res.status });
        return [];
      }
      return ((await res.json()) as { players: PlayerSummary[] }).players;
    } catch (e) {
      log.warn('player search failed', { err: (e as Error).message });
      return [];
    }
  }
}
