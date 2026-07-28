import { fetchInternalJson } from '@nw/shared';
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
  banned?: boolean;
}

/** Fuzzy search hit row (= meta AccountSearchRow, shown in OPS list views). */
export interface PlayerSummary {
  accountId: string;
  publicId?: string;
  displayName?: string;
  loginId?: string;
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

export interface PlayerClient {
  readonly available: boolean;
  /** Look up a player profile by 9-digit public id; returns null if not found. */
  lookupByPublicId(publicId: string): Promise<PlayerProfile | null>;
  /** Look up a player profile by accountId; returns null if not found. */
  lookupByAccountId(accountId: string): Promise<PlayerProfile | null>;
  /** Fuzzy search (display name / login id / public id / accountId); returns a list of matching summaries. */
  search(q: string, limit: number): Promise<PlayerSummary[]>;
  /** Admin-initiated password reset (player.password_reset); fails if the account has no password credential. */
  resetPassword(accountId: string, password: string): Promise<ResetPasswordResult>;
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
    // 404 (not found) and any failure both degrade to null, as before.
    const r = await fetchInternalJson<PlayerProfile>(`${this.metaBaseUrl}/internal/player?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /internal/player',
    });
    if (r.status === 404) return null;
    if (!r.ok || !r.body) {
      log.warn('player lookup failed', { status: r.status, err: r.error });
      return null;
    }
    return r.body;
  }

  async search(q: string, limit: number): Promise<PlayerSummary[]> {
    if (!this.metaBaseUrl) return [];
    // Degrades to [] on any failure, as before.
    const r = await fetchInternalJson<{ players: PlayerSummary[] }>(
      `${this.metaBaseUrl}/internal/players/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { caller: 'admin', key: this.internalKey, timeoutMs: 10000, log, label: 'meta /internal/players/search' },
    );
    if (!r.ok || !r.body) return [];
    return r.body.players;
  }

  async resetPassword(accountId: string, password: string): Promise<ResetPasswordResult> {
    if (!this.metaBaseUrl) return { ok: false, error: 'player backend unavailable' };
    const r = await fetchInternalJson<{ error?: string }>(
      `${this.metaBaseUrl}/internal/accounts/${encodeURIComponent(accountId)}/reset-password`,
      {
        caller: 'admin',
        key: this.internalKey,
        method: 'POST',
        body: { password },
        timeoutMs: 10000,
        label: 'meta /internal/accounts/:id/reset-password',
      },
    );
    if (r.ok) return { ok: true };
    if (r.status === 0) {
      log.warn('reset player password failed', { err: r.error });
      return { ok: false, error: 'request failed' };
    }
    return { ok: false, error: r.body?.error ?? `http ${r.status}` };
  }
}
