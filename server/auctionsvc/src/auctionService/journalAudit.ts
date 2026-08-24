// auctionsvc AuctionService split — ops-facing read of the settlement journal (see journal.ts).
//
// The journal exists because an auction settlement spans three services, so it is a durable to-do list
// rather than one atomic write. Almost always that list drains within a tick and nobody needs to look;
// what ops needs is the exception — a hand-over that has been retried many times and is still failing.
// Before this read existed, such a debt lived only in a log line (`settlement step still owed after many
// retries`), which is exactly the sort of thing nobody finds until a player complains.
//
// Strictly read-only. Ops does not get a "retry now" button: the sweep already retries every row forever
// on its own backoff, so a manual poke would only race it, and every genuinely useful next action (chase
// the failing meta endpoint, credit a compensation ticket) lives outside this service.
import {
  AUCTION_SETTLEMENT_STUCK_ATTEMPTS,
  type AuctionSettlementDebtView,
  type AuctionSettlementQuery,
  type AuctionSettlementStepView,
} from '@nw/shared';
import type { AuctionOrderDoc, AuctionOrderStep } from '../db';
import type { AuctionServiceDeps } from './base';
import { itemNameOf } from './base';
import { applicableCompensation } from './journalPlans';

/** Default page size for the ops lookup; `limit` is clamped to LIMIT_CAP. */
const DEFAULT_LIMIT = 50;
const LIMIT_CAP = 200;

export class AuctionServiceJournalAudit {
  constructor(private readonly deps: AuctionServiceDeps) {}

  /**
   * List settlements that still owe something (capability slg.audit.view via the admin backend).
   *
   * Only `pending` rows are debts: a `done` row handed everything over, and an `aborted` one unwound
   * cleanly. Ordering puts the most-retried first and then the oldest, because "retried 40 times" and
   * "stuck since yesterday" are the two shapes worth a human, and a row that has failed once is almost
   * always just mid-backoff.
   *
   * The `status: 'pending'` filter has no dedicated index and does not need one: an unfinished settlement
   * is by nature rare and short-lived, so this set is tiny even on a busy market — if it ever is not, that
   * fact is the alert.
   */
  async listSettlementDebts(filter: AuctionSettlementQuery = {}): Promise<AuctionSettlementDebtView[]> {
    const q: Record<string, unknown> = { status: 'pending' };
    if (filter.auctionId) q['auctionId'] = filter.auctionId;
    if (filter.minAttempts != null && filter.minAttempts > 0) q['attempts'] = { $gte: filter.minAttempts };
    if (filter.accountId) {
      // Match the acting account OR any account a step owes something to. The second half is the one that
      // matters in practice: an outbid bidder waiting on a refund is not the actor of the flow that owes
      // it, so an actorId-only filter would answer "no debts" to the exact question ops is asking.
      q['$or'] = [
        { actorId: filter.accountId },
        { 'steps.accountId': filter.accountId },
        { 'compensation.accountId': filter.accountId },
      ];
    }
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), LIMIT_CAP);
    const rows = await this.deps.cols.auctionOrders
      .find(q)
      .sort({ attempts: -1, ts: 1 })
      .limit(limit)
      .toArray();
    return rows.map((row) => toDebtView(row));
  }
}

/**
 * Which plan a pending row is actually working through. `decided` is the journal's own fork: before it the
 * flow never committed and will unwind, after it the flow is a purchase that was agreed to and runs to
 * completion. Reading the wrong one would show ops a debt the engine has no intention of paying.
 */
function owedSteps(row: AuctionOrderDoc): AuctionOrderStep[] {
  const plan = row.decided ? row.steps : applicableCompensation(row.compensation, row.done);
  return plan.filter((s) => row.done[s.name] == null);
}

function toStepView(step: AuctionOrderStep): AuctionSettlementStepView {
  const base = { name: step.name, op: step.op, key: step.key };
  switch (step.op) {
    case 'spend':
      return { ...base, accountId: step.accountId, amount: step.amount };
    case 'mailCoins':
      return { ...base, accountId: step.accountId, amount: step.amount };
    case 'escrow':
    case 'grant':
    case 'mailItem':
      return { ...base, accountId: step.accountId, item: itemLabel(step.snapshot) };
    case 'unclaim':
      // Purely local (release a claimed listing) — nobody downstream is owed anything, so no accountId.
      return base;
  }
}

/** `material scrap x3` / `equipment wp_marker` — the same derived name the listing lookup shows, so the two read together. */
function itemLabel(snapshot: { itemType: string; item: Record<string, unknown>; qty: number }): string {
  const name = itemNameOf(snapshot);
  const label = name ? `${snapshot.itemType} ${name}` : snapshot.itemType;
  return snapshot.qty > 1 ? `${label} x${snapshot.qty}` : label;
}

export function toDebtView(row: AuctionOrderDoc): AuctionSettlementDebtView {
  return {
    orderId: row._id,
    auctionId: row.auctionId,
    kind: row.kind,
    actorId: row.actorId,
    phase: row.decided ? 'forward' : 'rollback',
    owed: owedSteps(row).map(toStepView),
    completed: Object.keys(row.done),
    attempts: row.attempts,
    stuck: row.attempts >= AUCTION_SETTLEMENT_STUCK_ATTEMPTS,
    cycle: row.cycle,
    createdAt: row.ts,
    nextAttemptAt: row.nextAttemptAt,
  };
}
