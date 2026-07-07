import { internalHeaders, type AuctionAnomaly } from '@nw/shared';

// ── Auction anomaly scan (auctionsvc /internal/audit/anomalies, G7/§17.7) ──────────
// Auction task5 (AUCTION_DESIGN §9): auctionsvc is now the sole owner of auction state, decoupled from
// worldId — scanning is global (no worldId param), unlike the old worldsvc-scoped scan it replaces.
export interface AuctionClient {
  readonly available: boolean;
  /** Scan for anomalous auction transactions (G7 anti-RMT), global (no worldId — auction market is decoupled from SLG worlds). */
  scanAnomalies(windowSec?: number): Promise<AuctionAnomaly[]>;
}

export class HttpAuctionClient implements AuctionClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async scanAnomalies(windowSec?: number): Promise<AuctionAnomaly[]> {
    if (!this.baseUrl) return [];
    const qs = new URLSearchParams();
    if (windowSec != null) qs.set('windowSec', String(windowSec));
    const res = await fetch(`${this.baseUrl}/internal/audit/anomalies?${qs}`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`scanAnomalies failed: HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; data?: AuctionAnomaly[] };
    return body.data ?? [];
  }
}
