// Pure layer for the SLG anomalous trade audit page (G7 anti-RMT, §17.7; ADR-070 Phase 4e).
import type {
  AuctionAnomaly, AuctionListingAdminView, AuctionListingQuery, AuctionSettlementDebtView,
  AuctionSettlementQuery, AuctionSettlementStepView, TradeAuditSnapshot, TradeAuditTicketView,
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

/**
 * Whether this listing's cross-service hand-over has actually happened (U13 close-out).
 *
 * `owed` is the one worth reading: a closed listing with no `settledAt` means the buyer has not been sent
 * their item, or the seller their proceeds, and until this column existed that state was visible nowhere.
 * An OPEN listing has nothing to settle yet, which is not the same as a debt — conflating the two would
 * paint the whole market red.
 */
export function listingSettlementState(l: Pick<AuctionListingAdminView, 'status' | 'settledAt'>): 'open' | 'settled' | 'owed' {
  if (l.status === 'open') return 'open';
  return l.settledAt != null ? 'settled' : 'owed';
}

const SETTLEMENT_STATE_TEXT: Record<string, string> = { open: '—', settled: 'settled', owed: 'OWED' };

export function listingSettlementText(l: Pick<AuctionListingAdminView, 'status' | 'settledAt'>): string {
  return SETTLEMENT_STATE_TEXT[listingSettlementState(l)]!;
}

export function listingSettlementCls(l: Pick<AuctionListingAdminView, 'status' | 'settledAt'>): string {
  return listingSettlementState(l) === 'owed' ? 'failed' : '';
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

// ── Owed settlements (U13 close-out) ──

/**
 * The owed-settlement query, or the reason it cannot be run.
 *
 * Unlike the listing lookup, an unfiltered query here is the MOST useful one — "show me everything still
 * owed" is the whole point, and the set is tiny by nature (an unfinished settlement is rare and
 * short-lived). So the only validation is on `minAttempts`, which is a number typed into a box.
 */
export function settlementQuery(fields: {
  auctionId: string;
  accountId: string;
  minAttempts: string;
}): { ok: true; filter: AuctionSettlementQuery } | { ok: false; error: string } {
  const filter: AuctionSettlementQuery = {};
  const auctionId = fields.auctionId.trim();
  const accountId = fields.accountId.trim();
  if (auctionId) filter.auctionId = auctionId;
  if (accountId) filter.accountId = accountId;
  const raw = fields.minAttempts.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'min attempts must be a non-negative integer' };
    filter.minAttempts = n;
  }
  return { ok: true, filter };
}

export function settlementsFoundText(n: number): string {
  return `${plural(n, 'unfinished settlement')} found`;
}

/**
 * The reassuring empty case, spelled out rather than left blank: "nothing owed" is the normal state of
 * this table, and an ops reader needs to be able to tell it apart from "the filter was too narrow".
 */
export function noSettlementsText(filtered: boolean): string {
  return filtered
    ? 'No unfinished settlements match this filter.'
    : 'Nothing owed — every settlement has handed over.';
}

/** A stuck row is the one worth a human; anything else is mid-backoff and will resolve itself. */
export function settlementRowCls(d: Pick<AuctionSettlementDebtView, 'stuck'>): string {
  return d.stuck ? 'failed' : 'warn';
}

export function settlementAttemptsText(d: Pick<AuctionSettlementDebtView, 'attempts' | 'stuck'>): string {
  return `${d.attempts}${d.stuck ? ' (stuck)' : ''}`;
}

/**
 * What the settlement is doing, in words rather than a field name: `forward` is someone waiting on goods
 * or coins, `rollback` is the system giving something back. Ops reads these two completely differently —
 * the first is a player complaint waiting to happen, the second is usually self-healing.
 */
export function settlementPhaseText(d: Pick<AuctionSettlementDebtView, 'kind' | 'phase'>): string {
  return `${d.kind} · ${d.phase === 'forward' ? 'delivering' : 'unwinding'}`;
}

/** `cycle 0` is the ordinary case and adds nothing; a reopened settlement is worth flagging. */
export function settlementCycleText(d: Pick<AuctionSettlementDebtView, 'cycle'>): string {
  return d.cycle > 0 ? `retry #${d.cycle}` : '';
}

/**
 * One owed step as a sentence: who is owed what. The coin/item split matters — "seller owed 270 coins"
 * and "buyer owed equipment wp_marker" are different investigations — and a local step owes nobody
 * anything, so it says so instead of naming a phantom account.
 */
export function owedStepText(step: AuctionSettlementStepView): string {
  const what = step.amount != null ? `${step.amount} coins` : step.item ?? step.op;
  if (!step.accountId) return `${step.name}: ${what} (internal)`;
  return `${step.name}: ${step.accountId} ← ${what}`;
}

/** Every owed step on one line, for the table's summary column. */
export function owedSummary(d: Pick<AuctionSettlementDebtView, 'owed'>): string {
  return d.owed.length === 0 ? '—' : d.owed.map(owedStepText).join('; ');
}

export function completedText(d: Pick<AuctionSettlementDebtView, 'completed'>): string {
  return d.completed.length === 0 ? 'nothing yet' : d.completed.join(', ');
}

/**
 * Takes its timestamp formatter for the reason given in logic/flags.ts. Both halves are needed: how long
 * this has been owed, and when the sweep will next try — a row whose next attempt is minutes out is not
 * being ignored, which is the first thing anyone reading this table assumes.
 */
export function settlementTimingText(
  d: Pick<AuctionSettlementDebtView, 'createdAt' | 'nextAttemptAt'>,
  fmtTime: (ms: number) => string,
): string {
  return `since ${fmtTime(d.createdAt)} · next try ${fmtTime(d.nextAttemptAt)}`;
}
