import { internalHeaders, type LiveStats } from '@nw/shared';
import { log } from './shared';

// ── Stats (gateway / matchsvc) ────────────────────────────
export interface StatsClient {
  readonly available: boolean;
  /** Fetches one aggregated live snapshot; returns zeros if unavailable or on error (sampling must not block). */
  fetchLive(): Promise<LiveStats>;
}

interface GatewayStats {
  online: number;
}
interface MatchsvcStats {
  queue: number;
  rooms: number;
  gameInstances: number;
  gameLoad: number;
}

/** Merges GET /internal/stats from gateway + matchsvc. Fields from any unavailable service default to 0. */
export class HttpStatsClient implements StatsClient {
  constructor(
    private readonly gatewayUrl: string | null,
    private readonly matchsvcUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.gatewayUrl !== null || this.matchsvcUrl !== null;
  }

  async fetchLive(): Promise<LiveStats> {
    const [gw, mm] = await Promise.all([this.gateway(), this.matchsvc()]);
    return {
      online: gw?.online ?? 0,
      queue: mm?.queue ?? 0,
      rooms: mm?.rooms ?? 0,
      gameInstances: mm?.gameInstances ?? 0,
      gameLoad: mm?.gameLoad ?? 0,
    };
  }

  private async gateway(): Promise<GatewayStats | null> {
    if (!this.gatewayUrl) return null;
    return this.get<GatewayStats>(`${this.gatewayUrl}/internal/stats`, 'gateway');
  }
  private async matchsvc(): Promise<MatchsvcStats | null> {
    if (!this.matchsvcUrl) return null;
    return this.get<MatchsvcStats>(`${this.matchsvcUrl}/internal/stats`, 'matchsvc');
  }

  private async get<T>(url: string, tag: string): Promise<T | null> {
    try {
      const res = await fetch(url, { headers: internalHeaders('admin', this.internalKey) });
      if (!res.ok) {
        log.warn('stats fetch non-2xx', { tag, status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      log.warn('stats fetch failed', { tag, err: (e as Error).message });
      return null;
    }
  }
}
