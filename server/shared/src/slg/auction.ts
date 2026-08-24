// SLG auction house: basic constants, anti-RMT guardrails, and offline anomalous-trade detection.
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).

export const AUCTION_TAX_RATE = 0.1; // U1 deferred to S8-5; placeholder for now
export const AUCTION_MAX_LISTINGS = 20;
export const AUCTION_DURATIONS_SEC: readonly number[] = [72 * 3600];

// ── Auction house anti-RMT gates (AUCTION_DESIGN §4; DRAFT values — tune after launch) ──────────────
/** C daily cap: maximum new listing count per account per day (reset at server UTC day boundary). */
export const AUCTION_DAILY_LIST_CAP = 30;
/** C daily cap: maximum buy/bid count per account per day. */
export const AUCTION_DAILY_BUY_CAP = 30;
/** C daily cap counter document TTL (seconds): expires after 2 days for natural cleanup (isolated by dayKey; buffer for cross-day boundary). */
export const AUCTION_DAILY_TTL_SEC = 2 * 24 * 3600;
/**
 * E banned bound materials: materials in this set cannot be listed on the auction house (account-bound / season-event exclusive).
 * Empty initially — the mechanism is in place; the ban list will be populated by economic operations over time (AUCTION_DESIGN §4.E).
 */
export const AUCTION_BANNED_MATERIALS: ReadonlySet<string> = new Set<string>();
/**
 * G price guardrail (dynamic sliding window, AUCTION_DESIGN §4.G): maintains a window of the N most recent sale unit prices per category to compute refPrice;
 * listing/bid unit price must fall within [refPrice×FLOOR, refPrice×CEIL]; falls back to static reference price if samples are insufficient; passes through if no static value (cold-start: no false positives, no nakedly unguarded).
 */
export const AUCTION_PRICE_WINDOW_N = 20; // retain N most recent sale unit prices in the window
export const AUCTION_PRICE_WINDOW_MIN_SAMPLES = 5; // fall back to static reference if fewer than this many samples
export const AUCTION_PRICE_FLOOR_RATIO = 0.5; // unit price floor = refPrice × 0.5 (prevents dumping below floor)
export const AUCTION_PRICE_CEIL_RATIO = 2.0; // unit price ceiling = refPrice × 2.0 (prevents price-ceiling money laundering)
/** G cold-start static reference unit price (per item, DRAFT): used when the sliding window has insufficient samples; calibration figures go in ECONOMY_NUMBERS. Categories not listed are passed through. */
export const AUCTION_STATIC_REF_PRICE: Readonly<Record<string, number>> = {
  scrap: 10,
  lead: 30,
  binding: 80,
};
// ── B Bidding (AUCTION_DESIGN §4.B, DRAFT) ──────────────────────────────────────
/** Minimum bid increment = current highest bid × this ratio (falls back to the absolute starting price if the increment is too small). */
export const AUCTION_MIN_INCREMENT_RATIO = 0.05;
/** Anti-snipe window (seconds): if a new bid arrives within this window before expiry → expireAt is extended by the same window duration, preventing last-second sniping. */
export const AUCTION_ANTI_SNIPE_WINDOW_SEC = 5 * 60;

// ── Anomalous trade auditing (D / G7, anti-RMT, SLG_DESIGN §17.7 / AUCTION_DESIGN §4.D, DRAFT) ──
// Gates C/E/F/G are hard guardrails at order time (rate-limiting / listing bans / freezes / price bands), but they cannot catch
// the money-laundering / item-funneling pattern of "two colluding accounts repeatedly trading directionally within the price band" — that only surfaces after the fact.
// This is the offline detection layer: it scans completed trade records, aggregates suspicious seller→buyer pairs into anomalies,
// and pushes them to the admin audit queue for operators to adjudicate. Pure functions + numeric thresholds; unit-testable and tunable.
/** Default look-back window for audit scans (seconds): only recent trades are considered, avoiding noise from stale cross-season data. */
export const AUDIT_WINDOW_SEC = 7 * 24 * 3600;
/** Number of completed trades between the same seller→buyer pair within the window that triggers a "repeated wash-trading" signal. */
export const AUDIT_PAIR_MIN_TRADES = 5;
/** Number of "designated bid" trades (seller designated this specific buyer) within a pair that triggers a "directed funneling" signal (strong RMT indicator). */
export const AUDIT_PAIR_MIN_DESIGNATED = 3;
/** Cumulative coins traded between the same pair within the window that triggers a "large transfer" signal. */
export const AUDIT_PAIR_MIN_COINS = 50000;

/** A single completed trade record (minimal input for detectAuctionAnomalies; projected from sold auction documents by worldsvc). */
export interface AuctionTradeRecord {
  sellerId: string;
  buyerId: string;
  /** Whether this trade used "designated bid" (the seller specified this buyer when listing). Directed funneling is a strong RMT indicator. */
  designated: boolean;
  /** Gross trade amount (coins = sale unit price × qty, before tax). */
  coins: number;
  ts: number;
}

/**
 * A detected anomalous pair, aggregated by the UNORDERED account pair (2026-08-04 fix — see
 * detectAuctionAnomalies' doc comment). `sellerId`/`buyerId` are only a stable display label (whichever
 * direction this pair's first trade in the scanned window happened to be); a pair that alternates who buys
 * and sells is still one anomaly with combined totals, not two independent half-strength ones.
 */
export interface AuctionAnomaly {
  sellerId: string;
  buyerId: string;
  trades: number;
  designatedTrades: number;
  totalCoins: number;
  firstTs: number;
  lastTs: number;
  severity: 'medium' | 'high';
  /** Triggered signals: repeated (wash-trading) / designated (directed funneling) / high_value (large transfer). */
  reasons: Array<'repeated' | 'designated' | 'high_value'>;
}

/** Tunable thresholds for detectAuctionAnomalies (defaults to the constants above; admin/worldsvc can pass overrides for tuning). */
export interface AuctionAuditThresholds {
  minTrades?: number;
  minDesignated?: number;
  minCoins?: number;
}

// ── Ops listing lookup (auctionsvc /internal/audit/listings, admin.slg.audit.view) ──
// Unlike the anomaly scan (which only aggregates completed 'sold' trades), this surfaces a single
// listing's full record across every status (open/sold/cancelled/expired) — needed when ops has to
// answer "what does this specific in-flight listing look like" (e.g. designatedBuyerId, escrowed price).
export interface AuctionListingQuery {
  sellerId?: string;
  itemType?: 'material' | 'equipment' | 'card' | 'skin';
  status?: 'open' | 'sold' | 'cancelled' | 'expired';
  /** Case-insensitive substring match against the listing's derived item name (material name / equip defId / card defId / skinId). */
  itemName?: string;
  limit?: number;
}

/** Full admin-facing view of one auction listing (mirrors AuctionDoc, adds a derived display name). */
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
  /**
   * When this listing's cross-service settlement finished. A CLOSED listing (sold/cancelled/expired)
   * with no `settledAt` is one whose hand-over is still owed — the buyer has not been sent their item,
   * or the seller their proceeds. That is the state ops needs to be able to see, and it is also what
   * the journal sweep scans for, so a listing in it is being retried, not abandoned.
   */
  settledAt?: number;
  rev: number;
}

// ── Owed settlements (auctionsvc /internal/audit/settlements, admin.slg.audit.view) ──
// The auction house settles across three services, so a settlement is a small durable to-do list
// (`auctionOrders`) rather than one atomic write. Almost always that list drains within a tick and
// nobody needs to look; what ops needs is the exception — a hand-over that has been retried many
// times and is still failing, which otherwise exists only in a log line.

/**
 * Attempts after which a still-unpaid settlement step counts as stuck rather than merely in flight.
 * Shared so the journal's own escalating log level and the ops-facing `stuck` flag cannot drift apart:
 * "loud in the logs" and "listed for ops" must mean the same thing.
 */
export const AUCTION_SETTLEMENT_STUCK_ATTEMPTS = 10;

/** One still-owed hand-over, summarised for ops: who is owed what, plus the key to look it up downstream. */
export interface AuctionSettlementStepView {
  /** Progress name within the settlement (`spend` / `item` / `seller` / `refundPrev` / `return` / `unclaim`). */
  name: string;
  op: 'escrow' | 'grant' | 'spend' | 'mailItem' | 'mailCoins' | 'unclaim';
  /** The account whose assets this step moves. Absent for a purely local step (`unclaim`). */
  accountId?: string;
  /** Coin amount, for `spend` / `mailCoins`. */
  amount?: number;
  /** Item summary (`material scrap x3`, `equipment wp_marker`), for `escrow` / `grant` / `mailItem`. */
  item?: string;
  /** The downstream idempotency key — the exact string to search commercial's orders or meta's mail dispatch log for. */
  key: string;
}

/** One settlement that still owes something. */
export interface AuctionSettlementDebtView {
  /** The journal row id, which is also the base of every downstream key for this settlement. */
  orderId: string;
  auctionId: string;
  kind: 'list' | 'buy' | 'bid' | 'settle' | 'cancel' | 'expire';
  /** The account the settlement is acting for (buyer / bidder / seller). */
  actorId: string;
  /**
   * `forward` — the settlement committed and is still owed hand-overs (someone is waiting on goods or coins).
   * `rollback` — it could not go forward and is unwinding (releasing a claim, handing an escrow back).
   */
  phase: 'forward' | 'rollback';
  /** What is still owed, in the order it will be retried. */
  owed: AuctionSettlementStepView[];
  /** Names of the steps that already landed — how far this settlement got, without reading the raw document. */
  completed: string[];
  attempts: number;
  /** Retried at least AUCTION_SETTLEMENT_STUCK_ATTEMPTS times and still failing: worth a human looking. */
  stuck: boolean;
  /** How many times this settlement has been reopened (each reopen re-keys its downstream calls). */
  cycle: number;
  createdAt: number;
  /** Earliest time the sweep will try again (per-row exponential backoff). */
  nextAttemptAt: number;
}

export interface AuctionSettlementQuery {
  auctionId?: string;
  /** Match the acting account, or any account owed something by this settlement. */
  accountId?: string;
  /** Only settlements that have already failed at least this many times. Omitted / 0 = every unfinished one. */
  minAttempts?: number;
  limit?: number;
}

/**
 * Anomalous trade detection (pure function, D/G7): aggregates completed trade records by the UNORDERED
 * account pair (2026-08-04 fix — was previously keyed by the DIRECTED seller→buyer pair, e.g. `"A B"`
 * distinct from `"B A"`); reports an anomaly if any signal is triggered.
 * - repeated: pair trade count ≥ minTrades (repeated wash-trading / self-buy loop).
 * - designated: designated-bid trades ≥ minDesignated (seller repeatedly naming the same buyer = directed funneling).
 * - high_value: cumulative coins ≥ minCoins (large transfer, either direction).
 * severity=high when both "directed funneling" and "large transfer" are triggered simultaneously (strongest RMT indicator); otherwise medium.
 * Results are sorted by cumulative coins descending so operators can prioritize large-value cases first.
 *
 * Directional keying used to let a colluding pair evade detection entirely by alternating who buys and
 * sells: e.g. 4 trades A→B + 4 trades B→A (8 total, real collusive volume) would split into two buckets of
 * 4 trades / half the coins each — both individually falling under AUDIT_PAIR_MIN_TRADES/MIN_COINS even
 * though the same 8 trades in one direction would clearly trigger both signals. Aggregating by the
 * unordered pair closes that gap; `sellerId`/`buyerId` on the result are just a display label (see
 * AuctionAnomaly's doc comment), not a claim about which side predominantly sold.
 */
export function detectAuctionAnomalies(
  trades: readonly AuctionTradeRecord[],
  thresholds: AuctionAuditThresholds = {},
): AuctionAnomaly[] {
  const minTrades = thresholds.minTrades ?? AUDIT_PAIR_MIN_TRADES;
  const minDesignated = thresholds.minDesignated ?? AUDIT_PAIR_MIN_DESIGNATED;
  const minCoins = thresholds.minCoins ?? AUDIT_PAIR_MIN_COINS;

  interface Agg {
    sellerId: string;
    buyerId: string;
    trades: number;
    designatedTrades: number;
    totalCoins: number;
    firstTs: number;
    lastTs: number;
  }
  const byPair = new Map<string, Agg>();
  for (const r of trades) {
    if (!r.sellerId || !r.buyerId || r.sellerId === r.buyerId) continue; // self-trade is impossible; defensive guard
    // Unordered pair key: sort so "A sells to B" and "B sells to A" land in the SAME bucket (see the
    // function doc comment for why — this is the actual fix for the alternating-direction evasion).
    const [lo, hi] = [r.sellerId, r.buyerId].sort();
    const key = `${lo}:${hi}`;
    let a = byPair.get(key);
    if (!a) {
      a = { sellerId: r.sellerId, buyerId: r.buyerId, trades: 0, designatedTrades: 0, totalCoins: 0, firstTs: r.ts, lastTs: r.ts };
      byPair.set(key, a);
    }
    a.trades += 1;
    if (r.designated) a.designatedTrades += 1;
    a.totalCoins += Math.max(0, r.coins);
    if (r.ts < a.firstTs) a.firstTs = r.ts;
    if (r.ts > a.lastTs) a.lastTs = r.ts;
  }

  const out: AuctionAnomaly[] = [];
  for (const a of byPair.values()) {
    const reasons: AuctionAnomaly['reasons'] = [];
    if (a.trades >= minTrades) reasons.push('repeated');
    if (a.designatedTrades >= minDesignated) reasons.push('designated');
    if (a.totalCoins >= minCoins) reasons.push('high_value');
    if (reasons.length === 0) continue;
    const severity: AuctionAnomaly['severity'] =
      reasons.includes('designated') && reasons.includes('high_value') ? 'high' : 'medium';
    out.push({ ...a, severity, reasons });
  }
  out.sort((x, y) => y.totalCoins - x.totalCoins);
  return out;
}
