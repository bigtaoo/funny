import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── PvP card win-rate query (BALANCE data pipeline P1) ─────────────────
export interface PvpCardStatRow {
  cardId: string;
  games: number;
  wins: number;
}

export interface PvpCardStatsClient {
  readonly available: boolean;
  listPvpCardStats(filter: { mode?: string; since?: string }): Promise<PvpCardStatRow[]>;
}

export class HttpPvpCardStatsClient implements PvpCardStatsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listPvpCardStats(filter: { mode?: string; since?: string }): Promise<PvpCardStatRow[]> {
    if (!this.metaBaseUrl) return [];
    const qs = new URLSearchParams();
    if (filter.mode) qs.set('mode', filter.mode);
    if (filter.since) qs.set('since', filter.since);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    // Degrades to [] on any failure, as before.
    const r = await fetchInternalJson<{ cards?: PvpCardStatRow[] }>(`${this.metaBaseUrl}/internal/pvp-card-stats${suffix}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/pvp-card-stats',
    });
    if (!r.ok || !r.body) return [];
    return r.body.cards ?? [];
  }
}
