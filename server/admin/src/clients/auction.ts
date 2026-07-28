import { fetchInternalJson, type AuctionAnomaly, type AuctionListingAdminView, type AuctionListingQuery } from '@nw/shared';

// ── Auction anomaly scan (auctionsvc /internal/audit/anomalies, G7/§17.7) ──────────
// Auction task5 (AUCTION_DESIGN §9): auctionsvc is now the sole owner of auction state, decoupled from
// worldId — scanning is global (no worldId param), unlike the old worldsvc-scoped scan it replaces.
export interface AuctionClient {
  readonly available: boolean;
  /** Scan for anomalous auction transactions (G7 anti-RMT), global (no worldId — auction market is decoupled from SLG worlds). */
  scanAnomalies(windowSec?: number): Promise<AuctionAnomaly[]>;
  /** Ops lookup: query listings (any status) by sellerId / itemType / status / itemName (auctionsvc /internal/audit/listings). */
  queryListings(filter: AuctionListingQuery): Promise<AuctionListingAdminView[]>;
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
    // Throws on failure (as before, where non-2xx threw and network errors bubbled) —
    // ops must see auction scan failures, not a silently empty result.
    const r = await fetchInternalJson<{ ok?: boolean; data?: AuctionAnomaly[] }>(`${this.baseUrl}/internal/audit/anomalies?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'auctionsvc /internal/audit/anomalies',
    });
    if (!r.ok) throw new Error(`scanAnomalies failed: ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.data ?? [];
  }

  async queryListings(filter: AuctionListingQuery): Promise<AuctionListingAdminView[]> {
    if (!this.baseUrl) return [];
    const qs = new URLSearchParams();
    if (filter.sellerId) qs.set('sellerId', filter.sellerId);
    if (filter.itemType) qs.set('itemType', filter.itemType);
    if (filter.status) qs.set('status', filter.status);
    if (filter.itemName) qs.set('itemName', filter.itemName);
    if (filter.limit != null) qs.set('limit', String(filter.limit));
    const r = await fetchInternalJson<{ ok?: boolean; data?: AuctionListingAdminView[] }>(`${this.baseUrl}/internal/audit/listings?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'auctionsvc /internal/audit/listings',
    });
    if (!r.ok) throw new Error(`queryListings failed: ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.data ?? [];
  }
}
