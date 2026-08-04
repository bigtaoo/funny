import { describe, expect, it } from 'vitest';
import {
  AUDIT_PAIR_MIN_COINS,
  AUDIT_PAIR_MIN_DESIGNATED,
  AUDIT_PAIR_MIN_TRADES,
  detectAuctionAnomalies,
  type AuctionTradeRecord,
} from '../src/slg';

function trade(overrides: Partial<AuctionTradeRecord> = {}): AuctionTradeRecord {
  return { sellerId: 'seller', buyerId: 'buyer', designated: false, coins: 100, ts: 1000, ...overrides };
}

describe('detectAuctionAnomalies', () => {
  it('returns empty for no trades', () => {
    expect(detectAuctionAnomalies([])).toEqual([]);
  });

  it('ignores self-trades (sellerId === buyerId)', () => {
    expect(detectAuctionAnomalies([trade({ sellerId: 'a', buyerId: 'a' })])).toEqual([]);
  });

  it('does not flag a pair below every threshold', () => {
    expect(detectAuctionAnomalies([trade()])).toEqual([]);
  });

  it('flags "repeated" once trade count reaches minTrades', () => {
    const trades = Array.from({ length: AUDIT_PAIR_MIN_TRADES }, (_, i) => trade({ ts: 1000 + i, coins: 10 }));
    const out = detectAuctionAnomalies(trades);
    expect(out).toHaveLength(1);
    expect(out[0]!.reasons).toEqual(['repeated']);
    expect(out[0]!.severity).toBe('medium');
    expect(out[0]!.trades).toBe(AUDIT_PAIR_MIN_TRADES);
  });

  it('regression: an alternating-direction wash-trading pair is caught, not split into two half-strength buckets', () => {
    // Root cause: aggregation used to be keyed by the DIRECTED seller→buyer pair ("A B" distinct from
    // "B A"), so a colluding pair that alternates who buys and sells could evade detection entirely —
    // each direction's trade count/coin volume independently falls under the threshold even though the
    // combined bidirectional activity between the same two accounts clearly should trip it. 4 trades A→B +
    // 4 trades B→A = 8 total (≥ AUDIT_PAIR_MIN_TRADES) and well past AUDIT_PAIR_MIN_COINS combined, but
    // only 4 trades / half the coins in either single direction.
    const perTradeCoins = AUDIT_PAIR_MIN_COINS / 4; // 4 trades each way reach the combined coin threshold too
    const trades = [
      ...Array.from({ length: 4 }, (_, i) => trade({ sellerId: 'a', buyerId: 'b', ts: 1000 + i, coins: perTradeCoins })),
      ...Array.from({ length: 4 }, (_, i) => trade({ sellerId: 'b', buyerId: 'a', ts: 2000 + i, coins: perTradeCoins })),
    ];
    // Directional-only aggregation (the old bug) would find nothing: each direction only has 4 trades
    // (< AUDIT_PAIR_MIN_TRADES=5) and half the coins (< AUDIT_PAIR_MIN_COINS).
    const out = detectAuctionAnomalies(trades);
    expect(out).toHaveLength(1);
    expect(out[0]!.trades).toBe(8);
    expect(out[0]!.totalCoins).toBe(perTradeCoins * 8);
    expect(out[0]!.reasons).toContain('repeated');
    expect(out[0]!.reasons).toContain('high_value');
    // Both accounts appear as the pair, regardless of which one is labeled seller/buyer.
    expect(new Set([out[0]!.sellerId, out[0]!.buyerId])).toEqual(new Set(['a', 'b']));
  });

  it('flags "designated" once designated-bid count reaches minDesignated', () => {
    const trades = Array.from({ length: AUDIT_PAIR_MIN_DESIGNATED }, (_, i) => trade({ ts: 1000 + i, designated: true, coins: 10 }));
    const out = detectAuctionAnomalies(trades);
    expect(out[0]!.reasons).toEqual(['designated']);
    expect(out[0]!.severity).toBe('medium');
  });

  it('flags "high_value" once cumulative coins reach minCoins', () => {
    const out = detectAuctionAnomalies([trade({ coins: AUDIT_PAIR_MIN_COINS })]);
    expect(out[0]!.reasons).toEqual(['high_value']);
    expect(out[0]!.severity).toBe('medium');
  });

  it('severity is "high" only when designated and high_value trigger together', () => {
    const trades = Array.from({ length: AUDIT_PAIR_MIN_DESIGNATED }, () => trade({ designated: true, coins: AUDIT_PAIR_MIN_COINS }));
    const out = detectAuctionAnomalies(trades);
    expect(out[0]!.reasons).toEqual(['designated', 'high_value']);
    expect(out[0]!.severity).toBe('high');
  });

  it('aggregates trades/totalCoins/firstTs/lastTs per pair, clamping negative coins to 0', () => {
    const trades = [
      trade({ ts: 500, coins: 100 }),
      trade({ ts: 200, coins: -50 }), // negative clamped to 0, not subtracted
      trade({ ts: 900, coins: 50 }),
    ];
    const out = detectAuctionAnomalies(trades, { minTrades: 1 });
    expect(out[0]!.trades).toBe(3);
    expect(out[0]!.totalCoins).toBe(150);
    expect(out[0]!.firstTs).toBe(200);
    expect(out[0]!.lastTs).toBe(900);
  });

  it('sorts multiple anomalous pairs by totalCoins descending', () => {
    const trades = [
      trade({ sellerId: 's1', buyerId: 'b1', coins: 60_000 }),
      trade({ sellerId: 's2', buyerId: 'b2', coins: 90_000 }),
    ];
    const out = detectAuctionAnomalies(trades);
    expect(out.map((a) => a.totalCoins)).toEqual([90_000, 60_000]);
  });

  it('honors custom thresholds overriding the module defaults', () => {
    const trades = [trade({ coins: 10 })];
    expect(detectAuctionAnomalies(trades)).toEqual([]);
    const out = detectAuctionAnomalies(trades, { minCoins: 10 });
    expect(out[0]!.reasons).toEqual(['high_value']);
  });
});
