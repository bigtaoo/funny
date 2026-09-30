// Transaction-record retention (COMPLIANCE_GLOBAL §3.5, decided 2026-09-29): payment records are kept for
// TEN full calendar years and then deleted. Applies to every account — live or purged — because the
// retention obligation is per record, not per account; the account purge (service/accountPurge.ts) only
// strips identity and raw payloads and then leaves the rows to this sweep.
//
// "Ten full calendar years" follows the usual accounting convention (e.g. German §147 AO / §257 HGB): the
// period starts at the END of the calendar year the record was created in. A record from March 2016 is
// kept through 31.12.2026 and becomes deletable on 1.1.2027. So the cutoff is a UTC year boundary, never a
// rolling `now − 10y` — the rolling form would delete up to a year early.
//
// Collections and their clock:
//   ledger / orders / recharges / paddleEvents / appleNotifications   `ts` (creation time)
//   appleTransactionLinks   `updatedAt`, AND only if Apple has sent no notification about that subscription
//                           since the cutoff: the link is what routes a renewal to its account, and
//                           `updatedAt` only moves on purchase/restore — a subscription renewing for over a
//                           decade would otherwise lose its routing while still active.
// Everything here is a plain delete by an indexed time range, so the sweep is idempotent and cheap to run
// often (index.ts runs it every 6h; a daily timer on a service that is redeployed more than once a day
// would never fire).

import type { CommercialCollections } from './db';

export const TRANSACTION_RETENTION_YEARS = 10;

/** First instant (UTC) of the oldest calendar year that must still be kept. Records strictly before it are due. */
export function transactionRetentionCutoff(now: number): number {
  const year = new Date(now).getUTCFullYear();
  return Date.UTC(year - TRANSACTION_RETENTION_YEARS, 0, 1);
}

export interface TransactionRetentionResult {
  cutoff: number;
  removed: Record<'ledger' | 'orders' | 'recharges' | 'paddleEvents' | 'appleNotifications' | 'appleTransactionLinks', number>;
}

export async function sweepExpiredTransactionsOnce(deps: {
  cols: CommercialCollections;
  now: () => number;
  /** Max subscription links examined per run (default 1000); the rest wait for the next run. */
  linkBatchLimit?: number;
}): Promise<TransactionRetentionResult> {
  const { cols } = deps;
  const cutoff = transactionRetentionCutoff(deps.now());
  const before = { $lt: cutoff };

  // Links first: the "any notification since the cutoff" check only looks at notifications that the
  // deletions below keep anyway, so the order is not load-bearing — it just reads more naturally.
  let links = 0;
  const staleLinks = await cols.appleTransactionLinks
    .find({ updatedAt: before }, { projection: { _id: 1 }, limit: deps.linkBatchLimit ?? 1000 })
    .toArray();
  for (const l of staleLinks) {
    const recent = await cols.appleNotifications.findOne(
      { originalTransactionId: l._id, ts: { $gte: cutoff } },
      { projection: { _id: 1 } },
    );
    if (recent) continue; // still renewing — keep routing it
    links += (await cols.appleTransactionLinks.deleteOne({ _id: l._id, updatedAt: before })).deletedCount;
  }

  const [ledger, orders, recharges, paddleEvents, appleNotifications] = await Promise.all([
    cols.ledger.deleteMany({ ts: before }),
    cols.orders.deleteMany({ ts: before }),
    cols.recharges.deleteMany({ ts: before }),
    cols.paddleEvents.deleteMany({ ts: before }),
    cols.appleNotifications.deleteMany({ ts: before }),
  ]);
  return {
    cutoff,
    removed: {
      ledger: ledger.deletedCount,
      orders: orders.deletedCount,
      recharges: recharges.deletedCount,
      paddleEvents: paddleEvents.deletedCount,
      appleNotifications: appleNotifications.deletedCount,
      appleTransactionLinks: links,
    },
  };
}
