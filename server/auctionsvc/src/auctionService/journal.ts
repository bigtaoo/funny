// auctionsvc AuctionService split — cross-service settlement journal engine (U13 close-out, 2026-08-24).
//
// See db.ts's `AuctionOrderDoc` for WHY this is a journal and not a Mongo transaction (short version: the
// atomicity boundary spans three processes and four databases, so no single session can wrap it), and
// journalPlans.ts for the per-flow plans. This file is the executor, used verbatim by BOTH the request
// path and the scheduler sweep — deliberately, because a resumer running different code from the original
// attempt would be a second implementation of the same settlement rules, the "one formula, two languages"
// trap the 2026-08-24 `settleExpr` round already paid for once.
//
// The one idea the whole engine turns on: **a failure is either definitive or indeterminate, and they
// demand opposite responses.** A business rejection ("no coins", "not in your inventory") proves nothing
// moved, so the flow can be rolled back immediately. A transport failure proves nothing at all — the call
// may well have landed — so rolling back would mint coins or duplicate items. Those are retried against
// the downstream's own idempotency key until they answer definitively, and only then does the rollback
// decide what actually needs undoing.
// AUCTION_SETTLEMENT_STUCK_ATTEMPTS is the shared threshold for "retried a lot and still failing": this
// file escalates its log level at it, and journalAudit.ts flags the row `stuck` at it. One constant so
// "loud in the logs" and "listed for ops" cannot drift into meaning different things.
import { AUCTION_SETTLEMENT_STUCK_ATTEMPTS, SlgError } from '@nw/shared';
import type { AuctionItemSnapshot, AuctionOrderDoc, AuctionOrderKind, AuctionOrderStep } from '../db';
import type { AuctionServiceDeps } from './base';
import { AuctionOrderStepRunner } from './journalSteps';
import { applicableCompensation, type JournalPlan } from './journalPlans';

/**
 * How long a `pending` row must sit untouched before another caller may take it over. Mirrors
 * commercial's `REPLAY_HEAL_GRACE_MS` and for the same reason: the common cause of a duplicate key is a
 * client retrying a slow request while the original is still very much alive, and resuming during that
 * window would race the live attempt. Only a genuinely dead attempt matters here, and that only becomes
 * visible after a client-visible timeout, so erring long costs nothing but a slower repair.
 */
export const CLAIM_GRACE_MS = 15000;

/** Retry backoff for a step left owed: doubling from 2s, capped at 5min. Never gives up — the debt is real. */
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 300000;


/** Journal rows are kept this long after going terminal (audit trail for the ops "look up the orderId" workflow), then TTL-purged. */
const ORDER_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Flow kinds that close a listing; their completion stamps `settledAt` (the marker the repair sweep scans for). */
const SETTLING_KINDS: ReadonlySet<AuctionOrderKind> = new Set(['buy', 'settle', 'cancel', 'expire']);

/** What `begin` found under the requested key. */
export type BeginOutcome =
  /** The key is ours; the caller proceeds with its flow. */
  | { state: 'fresh'; row: AuctionOrderDoc }
  /** An earlier attempt already completed this exact flow; the caller returns the current view without redoing anything. */
  | { state: 'replay'; row: AuctionOrderDoc }
  /** A live (or still-unresolved) attempt holds the key. The caller rejects and lets the client retry. */
  | { state: 'inflight' };

export class AuctionOrderJournal {
  private readonly runner: AuctionOrderStepRunner;

  constructor(private readonly deps: AuctionServiceDeps) {
    this.runner = new AuctionOrderStepRunner(deps);
  }

  /**
   * Claim a flow key, insert-first (the same shape as commercial's order slot: reserve BEFORE the costly
   * side of the operation, so two concurrent callers cannot both pass a "does it exist?" read). This is
   * also the dedupe that kills the old double-refund: two same-amount bids from one bidder now collide
   * here instead of both reaching `spend` under a shared orderId.
   *
   * On collision the existing row decides: live → in-flight, abandoned → resolve it first and
   * re-dispatch, done → replay, aborted → reopen on a fresh `cycle` so the retry's downstream keys cannot
   * replay the previous attempt's charge.
   */
  async begin(
    rowId: string,
    kind: AuctionOrderKind,
    auctionId: string,
    actorId: string,
    build: (cycle: number) => JournalPlan,
  ): Promise<BeginOutcome> {
    const now = this.deps.now();
    const plan = build(0);
    try {
      const row: AuctionOrderDoc = {
        _id: rowId,
        auctionId,
        kind,
        actorId,
        status: 'pending',
        steps: plan.steps,
        prefix: plan.prefix,
        done: {},
        started: {},
        decided: plan.decided,
        compensation: plan.compensation,
        cycle: 0,
        claimedAt: now,
        attempts: 0,
        nextAttemptAt: now,
        ts: now,
      };
      await this.deps.cols.auctionOrders.insertOne(row);
      return { state: 'fresh', row };
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }

    let row = await this.deps.cols.auctionOrders.findOne({ _id: rowId });
    if (!row) return { state: 'inflight' }; // TTL-purged between the failed insert and this read; nothing to replay
    // A key is scoped to one account by construction; a mismatch means someone hand-built it (see flowKey).
    if (row.actorId !== actorId) throw new SlgError('BAD_REQUEST', 'auction order key belongs to another account');

    if (row.status === 'pending') {
      if (now - row.claimedAt <= CLAIM_GRACE_MS) return { state: 'inflight' };
      // Abandoned by a dead attempt: resolve it before deciding what this caller may do. Swallow whatever
      // it throws — that error belongs to the dead attempt, not to this caller, whose own verdict comes
      // from the row's resulting status.
      await this.resume(row).catch(() => undefined);
      row = (await this.deps.cols.auctionOrders.findOne({ _id: rowId })) ?? row;
      if (row.status === 'pending') return { state: 'inflight' }; // still unresolved; do not stack another attempt on top
    }
    if (row.status === 'done') return { state: 'replay', row };

    // Aborted: reopen on the next cycle. The cycle re-keys every downstream call, which is what makes a
    // retry after a refunded bid a real charge instead of a replay commercial would dedupe away.
    const next = build(row.cycle + 1);
    const reopened = await this.deps.cols.auctionOrders.findOneAndUpdate(
      { _id: rowId, status: 'aborted', cycle: row.cycle },
      {
        $set: {
          status: 'pending',
          steps: next.steps,
          prefix: next.prefix,
          done: {},
          started: {},
          decided: next.decided,
          compensation: next.compensation,
          claimedAt: now,
          nextAttemptAt: now,
        },
        $inc: { cycle: 1, attempts: 1 },
        $unset: { purgeAt: '' },
      },
      { returnDocument: 'after' },
    );
    if (!reopened) return { state: 'inflight' }; // another caller reopened it first
    return { state: 'fresh', row: reopened };
  }

  /**
   * Run the pre-branch steps (`steps[0..prefix)`) without closing the row out — the request path needs
   * the coins escrowed / the item in escrow before it can decide whether the flow proceeds. Throws on a
   * definitive failure; leaves the step owed on an indeterminate one (see `runPlan`).
   */
  async advance(row: AuctionOrderDoc): Promise<AuctionOrderDoc> {
    await this.runPlan(row, row.steps.slice(0, row.prefix), { markStarted: true });
    return row;
  }

  /**
   * Record that the request path got past its branch point, optionally appending steps that only became
   * known there (the outbid refund). `$push` rather than `$set`, so a concurrent resumer cannot truncate
   * what another writer appended — the same delta-not-absolute rule the 2026-08-24 sweep established for
   * `playerWorld`/`tiles`.
   */
  async decide(row: AuctionOrderDoc, extraSteps: AuctionOrderStep[] = []): Promise<void> {
    await this.deps.cols.auctionOrders.updateOne(
      { _id: row._id },
      {
        $set: { decided: true },
        ...(extraSteps.length > 0 ? { $push: { steps: { $each: extraSteps } } } : {}),
      },
    );
    row.decided = true;
    row.steps = [...row.steps, ...extraSteps];
  }

  /**
   * Drive a decided row forward to completion. A definitive failure of a step that can still be undone
   * rolls the flow back and rethrows; anything indeterminate is left owed for the sweep.
   */
  async finalize(row: AuctionOrderDoc): Promise<AuctionOrderDoc | null> {
    try {
      const complete = await this.runPlan(row, row.steps);
      if (complete) await this.finish(row, 'done');
    } catch (e) {
      await this.rollback(row);
      throw e;
    }
    return this.deps.cols.auctionOrders.findOne({ _id: row._id });
  }

  /** Abandon a flow that never got past its branch (the listing was already gone). Rolls back whatever the prefix actually moved. */
  async abort(row: AuctionOrderDoc): Promise<void> {
    await this.rollback(row);
  }

  /**
   * The sweep's entry point: resolve a row without knowing anything about which flow it came from.
   * `decided` rows go forward; undecided ones roll back. Identical to what the request path runs.
   *
   * `decided` is where the line between those two sits, and the line is deliberate rather than incidental.
   * Before it, the request had not yet committed to going forward — it may have died with the actor never
   * told they had bought anything, so unwinding is the honest outcome. After it, the flow is a purchase
   * that was agreed to, and finishing it (charge, deliver, pay the seller) leaves everyone whole; a
   * definitive refusal downstream still unwinds it via `finalize`'s catch. Both directions are safe: what
   * would not be safe is picking one by guessing what an unfinished step did, which is what `started`
   * plus the definitive/indeterminate split exists to avoid.
   */
  async resume(row: AuctionOrderDoc): Promise<AuctionOrderDoc | null> {
    if (row.status !== 'pending') return row;
    if (row.decided) return this.finalize(row);
    await this.rollback(row);
    return this.deps.cols.auctionOrders.findOne({ _id: row._id });
  }

  /** Read a row back (callers need `escrowed` and the resulting status; the sweep needs both). */
  async read(rowId: string): Promise<AuctionOrderDoc | null> {
    return this.deps.cols.auctionOrders.findOne({ _id: rowId });
  }

  /**
   * Undo a flow that cannot go forward.
   *
   * Step one is the part that is easy to get wrong: before undoing anything, every pre-branch step must be
   * resolved to a DEFINITIVE outcome, because a step that merely timed out may or may not have landed, and
   * each guess is a different way to create assets from nothing. So they are retried against the
   * downstream's own idempotency key until they either succeed or are definitively rejected; if they are
   * still indeterminate, the rollback defers entirely and the sweep tries again later.
   *
   * Only then does step two run the compensation, skipping any step whose `requires` forward step turned
   * out never to have landed.
   */
  private async rollback(row: AuctionOrderDoc): Promise<void> {
    let definitive = true;
    for (const step of row.steps.slice(0, row.prefix)) {
      if (row.done[step.name] != null) continue;
      if (row.started[step.name] == null) continue; // never attempted — leave it that way, do not fire it just to undo it
      try {
        await this.execAndRecord(row, step);
      } catch (e) {
        if (isDefinitive(e)) break; // proven not to have happened; every later prefix step is unreachable too
        await this.deferStep(row, step, e as Error);
        definitive = false;
        break;
      }
    }
    if (!definitive) return; // still ambiguous — the sweep retries rather than guessing

    const applicable = applicableCompensation(row.compensation, row.done)
      // Hand back what was actually escrowed, not what was requested. A listing arrives holding only an
      // `instanceId`/`skinId`; meta answers the escrow with the full instance, and that snapshot is the only
      // thing `grantEquipment`/`grantCard` (or a return mail) can act on — rolling back with the requested
      // payload silently grants nothing, which is how the seller's equipment would still vanish.
      .map((s) => (row.escrowed && (s.op === 'grant' || s.op === 'mailItem') ? { ...s, snapshot: row.escrowed } : s));
    const complete = await this.runPlan(row, applicable, { surface: false });
    if (complete) await this.finish(row, 'aborted');
  }

  /**
   * Execute a plan in order, skipping recorded steps. Returns false when a step was left owed.
   *
   * `surface: false` (compensation) never rethrows: a rollback is a debt, not a business decision, so it
   * is retried rather than reported.
   */
  private async runPlan(
    row: AuctionOrderDoc,
    plan: AuctionOrderStep[],
    opts?: { surface?: boolean; markStarted?: boolean },
  ): Promise<boolean> {
    const surface = opts?.surface ?? true;
    for (const step of plan) {
      if (row.done[step.name] != null) continue;
      try {
        if (opts?.markStarted) await this.markStarted(row, step);
        await this.execAndRecord(row, step);
      } catch (e) {
        // Definitive failures of a hand-over cannot exist (mail either sends or errors transiently), so in
        // practice this branch surfaces only `spend`/`escrow` business rejections — the two things a
        // caller can actually act on. Everything else is left owed and retried, which is the whole point:
        // the pre-journal code swallowed a failed mail and destroyed the asset silently.
        if (surface && isDefinitive(e)) throw e;
        await this.deferStep(row, step, e as Error);
        return false; // a later step may depend on this one having landed; the sweep resumes from here
      }
    }
    return true;
  }

  /** Record that a pre-branch step is about to go out, so a later rollback can tell "never tried" from "outcome unknown". */
  private async markStarted(row: AuctionOrderDoc, step: AuctionOrderStep): Promise<void> {
    const at = this.deps.now();
    await this.deps.cols.auctionOrders.updateOne({ _id: row._id }, { $set: { [`started.${step.name}`]: at } });
    row.started[step.name] = at;
  }

  /** Run one step and record its completion with a point-path `$set`, so two racing resumers cannot erase each other's progress. */
  private async execAndRecord(row: AuctionOrderDoc, step: AuctionOrderStep): Promise<void> {
    const escrowed: AuctionItemSnapshot | null = await this.runner.exec(step);
    const at = this.deps.now();
    await this.deps.cols.auctionOrders.updateOne(
      { _id: row._id },
      { $set: { [`done.${step.name}`]: at, ...(escrowed ? { escrowed } : {}) } },
    );
    row.done[step.name] = at;
    if (escrowed) row.escrowed = escrowed;
  }

  /** Record a step left owed: bump attempts, back off, and make a debt that refuses to settle loud enough to notice. */
  private async deferStep(row: AuctionOrderDoc, step: AuctionOrderStep, err: Error): Promise<void> {
    const attempts = row.attempts + 1;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 20));
    await this.deps.cols.auctionOrders.updateOne(
      { _id: row._id },
      { $set: { nextAttemptAt: this.deps.now() + delay }, $inc: { attempts: 1 } },
    );
    row.attempts = attempts;
    const detail = { order: row._id, kind: row.kind, step: step.name, op: step.op, attempts, err: err.message };
    if (attempts >= AUCTION_SETTLEMENT_STUCK_ATTEMPTS) console.error('[auctionsvc] settlement step still owed after many retries', detail);
    else console.warn('[auctionsvc] settlement step deferred, will retry', detail);
  }

  /**
   * Close the row out. For a flow that closed a listing, this is also where `settledAt` is stamped — after
   * the hand-over, never before, because its absence is exactly what the repair sweep treats as "still owed".
   */
  private async finish(row: AuctionOrderDoc, status: 'done' | 'aborted'): Promise<void> {
    const now = this.deps.now();
    await this.deps.cols.auctionOrders.updateOne(
      { _id: row._id },
      { $set: { status, purgeAt: new Date(now + ORDER_RETENTION_MS) } },
    );
    row.status = status;
    if (status === 'done' && SETTLING_KINDS.has(row.kind)) {
      await this.deps.cols.auctions.updateOne({ _id: row.auctionId }, { $set: { settledAt: now } });
    }
  }
}

/**
 * Did this failure prove the side effect did not happen?
 *
 * `SlgError` is what both clients raise for a rejection the downstream service actually evaluated and
 * refused (INSUFFICIENT_FUNDS, EQUIP_IN_USE, CARD_HAS_GEAR…). Anything else — a timeout, a socket reset,
 * a 502 — proves nothing: the request may have been fully applied before the answer was lost. Treating the
 * second kind as "did not happen" is how a rollback mints coins.
 */
function isDefinitive(e: unknown): boolean {
  return e instanceof SlgError;
}
