// auctionsvc AuctionService split — D/G7 anomalous-trade audit scan (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): zero dependencies on any other layer, only `deps`.
import { createLogger, AUDIT_WINDOW_SEC, detectAuctionAnomalies, type AuctionAnomaly, type AuctionAuditThresholds, type AuctionTradeRecord } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';

const log = createLogger('auctionsvc:service');

export class AuctionServiceAudit {
  constructor(private readonly deps: AuctionServiceDeps) {}

  // ── D / G7 Anomalous-trade audit scan (anti-RMT, SLG_DESIGN §17.7) ─────────────────────
  /** Falls back to parsing the listing timestamp from the auctionId (`a:{sellerId}:{ts}:{seq}`) when legacy documents lack a soldAt field. */
  private soldTs(doc: AuctionDoc): number {
    if (typeof doc.soldAt === 'number') return doc.soldAt;
    const parts = doc._id.split(':');
    const ts = Number(parts[2]);
    return Number.isFinite(ts) ? ts : 0;
  }

  /** Gross sale amount (coins, before tax) for a sold document. Auction: top-bid unit price; fixed: price field; multiplied by qty. */
  private grossCoins(doc: AuctionDoc): number {
    const unit = (doc.saleMode ?? 'fixed') === 'auction'
      ? (doc.topBid?.amount ?? doc.startPrice ?? doc.price)
      : doc.price;
    return unit * doc.qty;
  }

  /**
   * Scans recent sold auctions and aggregates suspicious seller→buyer pairs (detectAuctionAnomalies).
   * Offline read-only — does not mutate any state. Results are pulled by the admin backend into an audit queue for ops review (G7).
   * windowSec defaults to AUDIT_WINDOW_SEC; thresholds can be overridden for tuning.
   */
  async scanAnomalies(
    windowSec: number = AUDIT_WINDOW_SEC,
    thresholds: AuctionAuditThresholds = {},
  ): Promise<AuctionAnomaly[]> {
    const since = this.deps.now() - windowSec * 1000;
    // sold documents may include legacy records without soldAt → do not filter by soldAt in Mongo (would miss old docs); fetch all sold docs
    // then window-filter by soldTs in memory (sold volume is far smaller than open — acceptable).
    // Sorted desc by soldAt (2026-07-29 audit fix, {status,soldAt} index in db.ts) so the 5000-doc cap — if
    // ever hit — drops the OLDEST sold docs first, not an arbitrary natural-order slice that could silently
    // exclude the most recent trades from the anti-RMT audit window. Legacy docs without soldAt sort last
    // (missing field sorts as null, which is smallest) and are dropped first of all, which is also correct:
    // soldTs() falls back to parsing the auctionId's embedded listing timestamp for those, so they're the
    // least reliable/least-recent-by-construction records anyway.
    const docs = await this.deps.cols.auctions
      .find({ status: 'sold' })
      .sort({ soldAt: -1 })
      .limit(5000)
      .toArray();
    if (docs.length >= 5000) {
      log.warn('scanAnomalies: 5000-doc cap reached — oldest sold docs beyond the cap were excluded', { windowSec });
    }
    const trades: AuctionTradeRecord[] = [];
    for (const doc of docs) {
      if (!doc.buyerId) continue;
      const ts = this.soldTs(doc);
      if (ts < since) continue;
      trades.push({
        sellerId: doc.sellerId,
        buyerId: doc.buyerId,
        designated: !!doc.designatedBuyerId && doc.designatedBuyerId === doc.buyerId,
        coins: this.grossCoins(doc),
        ts,
      });
    }
    return detectAuctionAnomalies(trades, thresholds);
  }
}
