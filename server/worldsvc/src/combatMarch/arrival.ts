// worldsvc march domain: the arrival tick's two scans and their tuning knobs. This file is the queue end
// of the domain — it decides WHICH marches a pass touches, in what order, and how long a pass may run;
// what happens to each one lives next door in arrivalWalk.ts (the per-tile walk of a stepping march) and
// arrivalSettle.ts (what an arrived march does at its destination).
//
// 2026-09-09 split (claudedocs/server.md's "拆分形态的优先级" 形态① — independent function modules): the
// two halves described in WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §7.2/§7.3 are deliberately disjoint and
// share no state, so they are now two modules of free functions reached through an explicit
// `core`/`ArrivalSiegeCtx` pair rather than three private methods on one 592-line class. Zero behaviour
// change: the scans, the ordering, the time slice and the counters below are the code they already were.
//
// Independent sibling class (2026-08-11 mixin-chain split, 形态②): the only one of the three march
// domains that needs `siege` — assembled by composition in ../combatMarch.ts.
import type { WorldCore } from '../core';
import type { SiegeService } from '../combatSiege';
import { applyFastSteps, collectArrivalBatch } from './arrivalBatch';
import { advanceMarch } from './arrivalWalk';
import { applyArrival } from './arrivalSettle';
import { bumpCounter } from '../metrics';

/**
 * How many due marches one arrival tick will settle. Each one costs a handful of Mongo/Redis round trips
 * (and a step-by-step walk for a stepping march), all issued sequentially, so an unbounded scan could make
 * a single tick run for minutes. Overridable via `NW_SLG_ARRIVAL_SCAN_LIMIT` so an operator can trade tick
 * length for arrival punctuality without a deploy.
 *
 * 2026-09-05: the deep batching (arrivalBatch.ts) makes this cap far cheaper to raise — an uneventful march
 * now costs a share of a constant number of round trips rather than seven of its own. The DEFAULT is left
 * alone anyway: what a tick still pays per march is the serial tail (arrivals, encounters, interceptions),
 * and how big that tail is depends on how crowded the world is, not on how many marches are due. Raise it
 * from the env when the cap warning below actually fires.
 */
const ARRIVAL_SCAN_LIMIT = Number(process.env.NW_SLG_ARRIVAL_SCAN_LIMIT) || 500;

/**
 * The arrival tick runs every 2s, and a world that is over the cap is typically over it for a while — so
 * the warning is throttled to once a minute. Unthrottled it would be 30 identical lines per minute for as
 * long as the condition lasts, which is how a signal stops being read.
 */
const CAP_WARN_INTERVAL_MS = 60_000;
/** Per-half (2026-09-09): one shared timestamp would let a chatty walking scan mute the settlement one for a
 *  minute at a time, and those two say different things about what the world has outgrown. */
const lastCapWarnAt: Record<'step' | 'settlement', number> = { step: 0, settlement: 0 };

/**
 * How long one settlement pass may hold the event loop before it stops and leaves the rest for the next
 * one (WORLDSVC_CONCURRENCY_AUDIT §6.7 item 1 — "不能批，只能摊").
 *
 * The deep batching of 2026-09-05 took the *stepping* half of the arrival tick from p50 1761ms to ~2ms, and
 * the counters it added then named what was left: in a 32s storm, 1071 of the 1797 serial marches were
 * `arriving` — each one a real capture battle plus a metaserver round trip. That half cannot be batched (it
 * writes the DEFENDER's ledger) and cannot be made concurrent for the same reason, so a tick with dozens of
 * them due simply ran for seconds, and while it ran nothing else on this single thread moved: not the other
 * scheduler tasks, not `POST /world/march`, not `getMap`.
 *
 * A time slice does not make that work cheaper or faster — **throughput is unchanged**, and under a storm
 * heavy enough that settlements cannot keep up, the backlog still grows (see `arrivals.deferred`). What it
 * buys is that the growth is graceful: the service keeps answering, the other tasks keep their cadence, and
 * arrivals degrade by getting later rather than by taking the process down with them. A count-based budget
 * would not do this — settlement cost per march varies by an order of magnitude with what it runs into — so
 * the budget is wall clock, checked BETWEEN settlements (a settlement in flight is never abandoned).
 *
 * Sized against the settle task's own interval (a quarter of it, by default 150ms against 500ms): high
 * enough that an ordinary world never reaches it, low enough that a storm leaves most of the thread to
 * everyone else. `NW_SLG_ARRIVAL_SETTLE_SLICE_MS` overrides it; 0 disables the slice entirely (the
 * pre-2026-09-09 behaviour — settle everything due, however long it takes).
 */
const SETTLE_SLICE_MS = (() => {
  const raw = process.env.NW_SLG_ARRIVAL_SETTLE_SLICE_MS;
  if (raw === undefined || raw === '') return 150;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 150;
})();

/**
 * Hitting the cap means more marches were due this pass than one scan will return. The remainder is not
 * lost — the next pass picks it up — but every march in it is late, and before 2026-09-05 that happened in
 * complete silence. It is the clearest single signal that the world has outgrown this scheduler, so it is
 * logged rather than left to be inferred from player complaints about late armies. Throttled to once a
 * minute: a world over the cap is typically over it for a while, and 30 identical lines per minute is how a
 * signal stops being read.
 */
function warnIfCapped(dueCount: number, t: number, half: 'step' | 'settlement'): void {
  if (dueCount < ARRIVAL_SCAN_LIMIT || t - lastCapWarnAt[half] < CAP_WARN_INTERVAL_MS) return;
  lastCapWarnAt[half] = t;
  console.warn(`[world-scheduler] arrival ${half} scan hit its ${ARRIVAL_SCAN_LIMIT}-march cap; the overflow settles a tick late (raise NW_SLG_ARRIVAL_SCAN_LIMIT or shard the world)`);
}

export class ArrivalService {
  constructor(
    private readonly core: WorldCore,
    private readonly siege: SiegeService,
  ) {}

  /**
   * Both halves of the arrival tick in one call, walking first and settling without a time slice.
   *
   * This is no longer what the scheduler runs — it drives {@link processDueArrivalSteps} and
   * {@link processDueArrivalSettlements} on their own timers (see scheduler.ts) — but it stays the entry
   * point for every caller that owns the clock rather than sharing it: tests and the admin tools jump `now`
   * past a march's `arriveAt` and expect ONE call to leave the world settled, which a time-sliced pass
   * cannot promise. Returns the number of marches processed. worldsvc single-consumer (U12).
   */
  async processDueArrivals(nowMs?: number): Promise<number> {
    const t = nowMs ?? this.core.deps.now();
    const stepped = await this.processDueArrivalSteps(t);
    const settled = await this.processDueArrivalSettlements(t, 0);
    return stepped + settled;
  }

  /**
   * The walking half: stepping marches whose next per-tile step is due but whose final arrival is NOT
   * (`arriveAt > t`), so nothing here can settle, fight-on-arrival, park or take ground. Cheap and
   * batchable, which is the whole reason it is now separate — see processDueArrivalSettlements.
   *
   * ADR-051 (P1): a stepping march advances tile-by-tile, writing the occupancy index at each cell for the
   * P2 encounter check. Legacy docs and 'return' legs carry no stepping cursor and never appear here.
   */
  async processDueArrivalSteps(nowMs?: number): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    // `arriveAt: { $gt: t }` is what makes this half disjoint from the settlement half: a march at or past
    // its final arrival belongs to that one, which walks it the rest of the way AND settles it. The
    // `nextStepAt` index drives the scan; `arriveAt` rides along as a residual filter.
    const due = await cols.marches
      .find({ status: 'marching', nextStepAt: { $lte: t }, arriveAt: { $gt: t } })
      .limit(ARRIVAL_SCAN_LIMIT)
      .toArray();
    warnIfCapped(due.length, t, 'step');
    // 2026-09-05 (`sched:arrivals` deep batching, WORLDSVC_CONCURRENCY_AUDIT §5.4): the due list used to be
    // walked one march at a time, ~7 serial round trips each, which the 200-bot load test measured at
    // p50 1761ms / p90 6705ms against this task's own 2000ms interval. Marches that provably cannot fight
    // this tick — no occupant or coverage on any cell they enter, no cell shared with another march in the
    // batch — are settled together in a constant number of round trips instead. See arrivalBatch.ts for why
    // the rest deliberately stays serial: a field encounter writes the DEFENDER's ledger, so concurrent
    // settlement is a genuine cross-player race, not a theoretical one.
    const { fast, serial, stats, familyOf } = await collectArrivalBatch(this.core, due, t);
    // Batched writes first, while the reads that justified them are freshest.
    await applyFastSteps(this.core, fast, familyOf);
    // Publish the split so a regression that quietly demotes everything to the per-march path is a visible
    // number rather than just a slower tick (see metrics.ts `bumpCounter`).
    bumpCounter('arrivals.batched', fast.length);
    bumpCounter('arrivals.serial', serial.length);
    // `arriving`/`legacy` are structurally zero in this half now (the query excludes both) and are still
    // bumped so the counter set keeps meaning the same thing wherever it is read: a non-zero `arriving` here
    // would mean the disjointness above has broken.
    bumpCounter('arrivals.arriving', stats.arriving);
    bumpCounter('arrivals.blocked', stats.blocked);
    bumpCounter('arrivals.legacy', stats.legacy);
    let n = 0;
    for (const m of serial) {
      // Legacy docs and 'return' legs have no stepping cursor and settle by `arriveAt` alone, which is the
      // settlement half's queue — the query above cannot return one. Checked anyway rather than assumed:
      // advanceMarch on a cursor-less doc is not a no-op, and "the query guarantees it" is a coupling
      // between a filter and a loop two functions apart.
      if (!m.path || m.stepIndex == null || m.nextStepAt == null) continue;
      // Stepping march demoted by contention: advance cell-by-cell up to t. Returns true only when the march
      // is fully handled — here that means it was destroyed en route or vanished, never that it arrived.
      if (await advanceMarch(this.core, this.siege, m, t)) n++;
    }
    return n;
  }

  /**
   * The settling half: every march at or past its final arrival — the ones that fight, park and take ground.
   * Oldest arrival first, and bounded by a wall-clock slice (see {@link SETTLE_SLICE_MS}); whatever the
   * slice does not reach stays untouched and is still due on the next pass, so deferral needs no state of
   * its own. Pass `sliceMs = 0` to settle everything due, however long that takes.
   *
   * Why oldest-first: the scan cap and the slice both cut the list short, and without an order that is a
   * lottery a march can lose repeatedly. `arriveAt: 1` is an existing index, so the sort is free, and it
   * makes lateness bounded and fair instead of arbitrary.
   */
  async processDueArrivalSettlements(nowMs?: number, sliceMs: number = SETTLE_SLICE_MS): Promise<number> {
    const { cols } = this.core.deps;
    const t = nowMs ?? this.core.deps.now();
    const due = await cols.marches
      .find({ status: 'marching', arriveAt: { $lte: t } })
      .sort({ arriveAt: 1 })
      .limit(ARRIVAL_SCAN_LIMIT)
      .toArray();
    warnIfCapped(due.length, t, 'settlement');
    const startedAt = performance.now();
    let n = 0;
    let i = 0;
    for (; i < due.length; i++) {
      // Checked between settlements, never during one: a half-applied capture is not a thing this code can
      // represent. The first march always runs, so a slice smaller than one settlement still makes progress
      // rather than deadlocking the queue.
      if (sliceMs > 0 && i > 0 && performance.now() - startedAt >= sliceMs) break;
      const m = due[i]!;
      if (m.path && m.stepIndex != null && m.nextStepAt != null) {
        // Stepping march at its destination: walk out the remaining cells (it may be several, if this task
        // has fallen behind) and settle on the final one.
        if (await advanceMarch(this.core, this.siege, m, t)) n++;
      } else {
        // Legacy / return leg: single-arrival model. Atomic claim + delete; skip if lost to a recall or a
        // concurrent processor.
        const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
        if (!claimed) continue;
        await applyArrival(this.core, this.siege, claimed, t);
        n++;
      }
    }
    // What THIS pass left behind, as a number — not the whole backlog: marches past the scan cap were never
    // in `due` to begin with, and that overflow has its own warning above. Under an ordinary load this is
    // always 0; a value that keeps growing is the honest statement that settlement throughput — not the
    // scheduler, not the batching — is the ceiling, and the signal that the next lever (cross-player
    // concurrency, §6.7) is finally due.
    bumpCounter('arrivals.settled', n);
    bumpCounter('arrivals.deferred', due.length - i);
    return n;
  }
}
