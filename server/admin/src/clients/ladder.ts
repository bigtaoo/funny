import { fetchInternalJson } from '@nw/shared';

// ── Ladder season (meta /admin/ladder/season/roll, SE-3) ─────────────────────
export interface LadderSeasonInfo {
  seasonNo: number;
  startAt: number;
  endAt: number;
  state: string;
}

export interface LadderClient {
  readonly available: boolean;
  /** CAS-idempotent ladder season advance; returns the new (or current) season info. */
  rollSeason(): Promise<LadderSeasonInfo>;
  /** Read the current season (GET /internal/ladder/season/current). */
  getCurrentSeason(): Promise<LadderSeasonInfo | null>;
}

export class HttpLadderClient implements LadderClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async rollSeason(): Promise<LadderSeasonInfo> {
    if (!this.metaBaseUrl) throw new Error('meta not configured');
    // Season roll is a synchronous long operation (rank settlement over the whole ladder);
    // give it a long deadline instead of the default so the client doesn't cut it off.
    const r = await fetchInternalJson<{ season?: LadderSeasonInfo }>(`${this.metaBaseUrl}/admin/ladder/season/roll`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      timeoutMs: 120000,
      label: 'meta /admin/ladder/season/roll',
    });
    if (!r.ok || !r.body?.season) throw new Error(`rollSeason ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body.season;
  }

  async getCurrentSeason(): Promise<LadderSeasonInfo | null> {
    if (!this.metaBaseUrl) return null;
    // Degrades to null on any failure, as before.
    const r = await fetchInternalJson<{ season?: LadderSeasonInfo }>(`${this.metaBaseUrl}/internal/ladder/season/current`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /internal/ladder/season/current',
    });
    if (!r.ok || !r.body) return null;
    return r.body.season ?? null;
  }
}
