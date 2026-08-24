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
  /** When the cross-service settlement finished. Absent on a CLOSED listing = the hand-over is still owed. */
  settledAt?: number;
  rev: number;
}

// ── Owed settlements (mirror of @nw/shared AuctionSettlementDebtView/Query, U13 close-out) ──
// An auction settlement spans three services, so it runs as a durable to-do list the auctionsvc sweep
// retries forever. Ops does not normally care; what ops needs is the exception — one that keeps failing.
export interface AuctionSettlementStepView {
  name: string;
  op: 'escrow' | 'grant' | 'spend' | 'mailItem' | 'mailCoins' | 'unclaim';
  accountId?: string;
  amount?: number;
  item?: string;
  /** The downstream idempotency key: paste this into a commercial order / meta mail-dispatch lookup. */
  key: string;
}

export interface AuctionSettlementDebtView {
  orderId: string;
  auctionId: string;
  kind: 'list' | 'buy' | 'bid' | 'settle' | 'cancel' | 'expire';
  actorId: string;
  phase: 'forward' | 'rollback';
  owed: AuctionSettlementStepView[];
  completed: string[];
  attempts: number;
  stuck: boolean;
  cycle: number;
  createdAt: number;
  nextAttemptAt: number;
}

export interface AuctionSettlementQuery {
  auctionId?: string;
  accountId?: string;
  minAttempts?: number;
  limit?: number;
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
