// Coin-anomaly daily audit (COMMERCIAL_DESIGN §6.6, 2026-07-26): aggregates the ledger for accounts whose
// non-recharge coin gain in a single UTC day exceeds a threshold, for the OPS anti-cheat review queue
// (metaserver AntiCheatReviewDoc.kind:'coin_anomaly'). Pure read — never mutates the wallet/ledger.
import type { CommercialBaseCtor, Constructor } from './base';

export interface CoinGainRow {
  accountId: string;
  /** Sum of positive ledger deltas for this account within [dayStart,dayEnd) whose reason !== 'recharge'. */
  nonRechargeGain: number;
}

export interface AuditHandlers {
  /**
   * Accounts whose non-recharge coin gain within the UTC day `dayKey` (YYYY-MM-DD) is >= minGain, sorted
   * by gain descending. Real-money recharges (`reason:'recharge'`) are excluded by design — a whale buying
   * coins is not an anomaly. Never throws on a malformed dayKey; an invalid date yields an empty range.
   */
  auditCoinGains(dayKey: string, minGain: number): Promise<CoinGainRow[]>;
}

export function AuditMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<AuditHandlers> {
  return class extends Base {
    async auditCoinGains(dayKey: string, minGain: number): Promise<CoinGainRow[]> {
      const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
      if (Number.isNaN(dayStart)) return [];
      const dayEnd = dayStart + 24 * 3600 * 1000;

      const rows = await this.cols.ledger
        .aggregate<{ _id: string; gain: number }>([
          { $match: { ts: { $gte: dayStart, $lt: dayEnd }, delta: { $gt: 0 }, reason: { $ne: 'recharge' } } },
          { $group: { _id: '$accountId', gain: { $sum: '$delta' } } },
          { $match: { gain: { $gte: minGain } } },
          { $sort: { gain: -1 } },
        ])
        .toArray();

      return rows.map((r) => ({ accountId: r._id, nonRechargeGain: r.gain }));
    }
  };
}
