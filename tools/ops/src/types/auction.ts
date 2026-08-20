// Ops-side mirrors of the SLG auction audit / anti-RMT types (G7), split out of types.ts on
// 2026-08-20 to clear the 500-line convention gate (ADR-067; tools/scripts/checkFileLength.mjs).
// Pure type moves, no shape changes. types.ts re-exports every name, so all `from './types'` /
// `from '../types'` imports are unchanged. This group was chosen because it is the largest
// self-contained one in the file: the anomaly scan, the ops listing lookup, and the trade-audit
// ticket lifecycle are read by exactly two pages (auctionAudit, slgSeason) and by nothing else.

export type AuctionAnomalyReason = 'repeated' | 'designated' | 'high_value';
export interface AuctionAnomaly {
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  reasons: AuctionAnomalyReason[];
}

// ── Ops auction listing lookup (mirror of @nw/shared AuctionListingAdminView/AuctionListingQuery) ──
export interface AuctionListingQuery {
  sellerId?: string;
  itemType?: 'material' | 'equipment' | 'card' | 'skin';
  status?: 'open' | 'sold' | 'cancelled' | 'expired';
  itemName?: string;
  limit?: number;
}

export interface AuctionListingAdminView {
  auctionId: string;
  sellerId: string;
  itemType: 'material' | 'equipment' | 'card' | 'skin';
  itemName: string;
  item: Record<string, unknown>;
  qty: number;
  price: number;
  currency: string;
  designatedBuyerId?: string;
  expireAt: number;
  status: 'open' | 'sold' | 'cancelled' | 'expired';
  buyerId?: string;
  soldAt?: number;
  closedAt?: number;
  saleMode: 'fixed' | 'auction';
  startPrice?: number;
  buyoutPrice?: number;
  topBid?: { bidderId: string; amount: number; ts: number };
  rev: number;
}

export interface TradeAuditSnapshot {
  worldId: string;
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  reasons: AuctionAnomalyReason[];
}

export type TradeAuditTicketStatus = 'open' | 'dismissed' | 'actioned';

export interface TradeAuditTicketView {
  id: string;
  snapshot: TradeAuditSnapshot;
  status: TradeAuditTicketStatus;
  filedBy: string;
  filedByName?: string;
  filedAt: number;
  note?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: number;
  enforcement?: { sellerBanned: boolean; buyerBanned: boolean };
}
