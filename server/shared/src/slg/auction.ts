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

/** A detected anomalous pair (aggregated in the seller→buyer direction). */
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

/**
 * Anomalous trade detection (pure function, D/G7): aggregates completed trade records by directed seller→buyer pair; reports an anomaly if any signal is triggered.
 * - repeated: pair trade count ≥ minTrades (repeated wash-trading / self-buy loop).
 * - designated: designated-bid trades ≥ minDesignated (seller repeatedly naming the same buyer = directed funneling).
 * - high_value: cumulative coins ≥ minCoins (large unidirectional transfer).
 * severity=high when both "directed funneling" and "large transfer" are triggered simultaneously (strongest RMT indicator); otherwise medium.
 * Results are sorted by cumulative coins descending so operators can prioritize large-value cases first.
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
    const key = `${r.sellerId} ${r.buyerId}`;
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
