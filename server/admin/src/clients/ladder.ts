import { internalHeaders } from '@nw/shared';

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
    const res = await fetch(`${this.metaBaseUrl}/admin/ladder/season/roll`, {
      method: 'POST',
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`rollSeason HTTP ${res.status}`);
    const body = (await res.json()) as { season: LadderSeasonInfo };
    return body.season;
  }

  async getCurrentSeason(): Promise<LadderSeasonInfo | null> {
    if (!this.metaBaseUrl) return null;
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/ladder/season/current`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { season?: LadderSeasonInfo };
      return body.season ?? null;
    } catch {
      return null;
    }
  }
}
