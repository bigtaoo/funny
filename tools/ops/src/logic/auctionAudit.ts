// Pure layer for the SLG anomalous trade audit page (G7 anti-RMT, §17.7; ADR-070 Phase 4e).
import type {
  AuctionAnomaly, AuctionListingAdminView, AuctionListingQuery, TradeAuditSnapshot,
  TradeAuditTicketView,
} from '../types';
import { adminLabel, plural } from './shared';

// ── Listing lookup ──

/**
 * The listing query, or the reason it cannot be run. Requiring at least one of seller / item type /
 * item name is this page's own rule, not the backend's: the endpoint would happily return every
 * listing in the world, which is neither useful to read nor cheap to produce.
 *
 * `status` alone deliberately does NOT satisfy the requirement — "every expired listing ever" is the
 * same unbounded query wearing a filter.
 */
export function listingQuery(fields: {
  sellerId: string;
  itemType: string;
  status: string;
  itemName: string;
}): { ok: true; filter: AuctionListingQuery } | { ok: false; error: string } {
  const filter: AuctionListingQuery = {};
  const sellerId = fields.sellerId.trim();
  const itemName = fields.itemName.trim();
  if (sellerId) filter.sellerId = sellerId;
  if (fields.itemType) filter.itemType = fields.itemType as AuctionListingQuery['itemType'];
  if (fields.status) filter.status = fields.status as AuctionListingQuery['status'];
  if (itemName) filter.itemName = itemName;
  if (!filter.sellerId && !filter.itemType && !filter.itemName) {
    return { ok: false, error: 'at least one of sellerId / itemType / item name is required' };
  }
  return { ok: true, filter };
}

const LISTING_STATUS_CLS: Record<string, string> = { open: 'warn', sold: '', cancelled: '', expired: 'failed' };

export function listingStatusCls(status: string): string {
  return LISTING_STATUS_CLS[status] ?? '';
}

/**
 * The price column. A fixed-price listing has one number; an auction has up to three (current bid or
 * start price, plus an optional buyout), and which of those is meaningful depends on whether anyone
 * has bid yet — that choice is exactly what an RMT investigation is reading this column for.
 */
export function listingPriceLabel(l: AuctionListingAdminView): string {
  if (l.saleMode !== 'auction') return String(l.price);
  const base = l.topBid ? `bid ${l.topBid.amount}` : `start ${l.startPrice ?? l.price}`;
  return `${base}${l.buyoutPrice != null ? ` / buyout ${l.buyoutPrice}` : ''}`;
}

/** When the listing ended, falling back to when it is due to — a still-open listing has no close time. */
export function listingCloseTs(l: AuctionListingAdminView): number {
  const closed = l.soldAt ?? l.closedAt;
  return closed ? closed : l.expireAt;
}

export function listingItemText(l: Pick<AuctionListingAdminView, 'itemType' | 'itemName'>): string {
  return `${l.itemType}: ${l.itemName || '—'}`;
}

export function listingsFoundText(n: number): string {
  return `${plural(n, 'listing')} found`;
}

// ── Anomaly scan ──

/** Blank means "the backend's default window", which is not the same as zero seconds. */
export function scanWindowSec(raw: string): number | undefined {
  return raw.trim() ? Number(raw.trim()) : undefined;
}

const SEVERITY_CLS: Record<string, string> = { high: 'failed', medium: 'warn' };

/** Unknown severities read as `warn` — an unclassified signal is still a signal. */
export function severityCls(severity: string): string {
  return SEVERITY_CLS[severity] ?? 'warn';
}

export function anomaliesFoundText(n: number, worldId: string): string {
  return `${plural(n, 'suspicious pair')} found in world "${worldId}"`;
}

export function noAnomaliesText(worldId: string): string {
  return `No anomalies found in world "${worldId}".`;
}

/** The ticket snapshot for an anomaly: the scan result frozen at filing time, plus its world. */
export function snapshotOf(a: AuctionAnomaly, worldId: string): TradeAuditSnapshot {
  return {
    worldId,
    sellerId: a.sellerId,
    buyerId: a.buyerId,
    trades: a.trades,
    designatedTrades: a.designatedTrades,
    totalCoins: a.totalCoins,
    firstTs: a.firstTs,
    lastTs: a.lastTs,
    severity: a.severity,
    reasons: a.reasons,
  };
}

// ── Audit ticket queue ──

const TICKET_STATUS_CLS: Record<string, string> = { open: 'warn', dismissed: '', actioned: 'failed' };

export function auditTicketStatusCls(status: string): string {
  return TICKET_STATUS_CLS[status] ?? '';
}

export function auditTicketFiledBy(tk: Pick<TradeAuditTicketView, 'filedByName' | 'filedBy'>): string {
  return adminLabel(tk.filedByName, tk.filedBy);
}

export function sellerBuyerText(snap: Pick<TradeAuditSnapshot, 'sellerId' | 'buyerId'>): string {
  return `${snap.sellerId} → ${snap.buyerId}`;
}

/** "Confirmed violation" vs "Dismiss" — the prompt names the verdict so a misclick is visible. */
export function resolvePrompt(disposition: 'dismissed' | 'actioned'): string {
  return `${disposition === 'actioned' ? 'Confirmed violation' : 'Dismiss'}: add a note (optional)`;
}

/** Takes its timestamp formatter for the reason given in logic/flags.ts. */
export function auditResolvedByText(tk: TradeAuditTicketView, fmtTime: (ms: number) => string): string {
  const by = adminLabel(tk.resolvedByName, tk.resolvedBy);
  return `by ${by}${tk.resolvedAt ? ` · ${fmtTime(tk.resolvedAt)}` : ''}`;
}

/**
 * Actioning a ticket bans both parties best-effort, so a per-party outcome is reported: "ban failed"
 * is the case that matters (an account still trading after being actioned), and it is invisible unless
 * printed here.
 */
export function enforcementText(enf: { sellerBanned: boolean; buyerBanned: boolean }): string {
  return `Enforcement: seller ${enf.sellerBanned ? 'banned' : 'ban failed'}, buyer ${enf.buyerBanned ? 'banned' : 'ban failed'}`;
}

export function canAdjudicate(canManage: boolean, status: string): boolean {
  return canManage && status === 'open';
}
