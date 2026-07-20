import { internalHeaders } from '@nw/shared';
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
    try {
      const qs = new URLSearchParams();
      if (filter.mode) qs.set('mode', filter.mode);
      if (filter.since) qs.set('since', filter.since);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const res = await fetch(`${this.metaBaseUrl}/internal/pvp-card-stats${suffix}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('pvp-card-stats non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { cards?: PvpCardStatRow[] };
      return body.cards ?? [];
    } catch (e) {
      log.warn('pvp-card-stats fetch failed', { err: (e as Error).message });
      return [];
    }
  }
}
