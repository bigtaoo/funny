/**
 * `engine/driver/realtimeDriver.ts` — the wall-clock front door: how much banked real time
 * becomes how many sim steps, and how fast we drain a backlog. 50% branch coverage before this
 * file: only the 1× rung of the catch-up ladder, and neither the accumulator cap nor the
 * lockstep-stall path had ever run.
 *
 * All four rungs are worth pinning individually because each one is a *number the player feels*
 * and none of them has any other guard. A rung wired to the wrong threshold does not break
 * anything visibly in a local test — the sim still advances, deterministically, in the right
 * order — it just means a client that backgrounded its tab spends the rest of the match a second
 * behind the server, which is the netcode bug this ladder exists to prevent (and which the
 * CATCHUP_MIN_LEAD doc comment describes as having actually happened). Likewise the two clamps:
 * without the accumulator cap a long pause converts into an unbounded burst (spiral of death),
 * and without the stall clamp a resolved stall replays the whole buffered batch in one render
 * frame, which is the 10 Hz-looking stutter the source comment calls out.
 *
 * The driver takes `stepFn` as a parameter and touches no GameState, so a counting fake is the
 * whole harness — no engine, no board, no ctx.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { RealtimeDriver } from '../engine/driver/realtimeDriver';
import { TICK_RATE } from '../math/fixed';
import type { InputSource } from '../net/InputSource';
import type { GameEvent, PlayerCommand } from '../types';

const TICK_DT = 1 / TICK_RATE;

/**
 * One tick of wall clock plus a hair. The accumulator is a plain `number` (wall clock is
 * deliberately outside the fp/determinism domain — only the sim steps it schedules are
 * deterministic), so banking exactly N × stepDt and subtracting stepDt N times can land a few
 * ulps short of the Nth comparison and run N-1 steps. The slack removes that harness artefact
 * from the assertions below; it is not a driver behaviour worth pinning either way.
 */
const ONE_TICK = TICK_DT * 1.001;

/** An InputSource that always confirms, reporting a fixed backlog (or none at all). */
function source(opts: { lead?: number; stallFrom?: number } = {}): InputSource {
  return {
    submit() {},
    take(frame: number) {
      if (opts.stallFrom !== undefined && frame >= opts.stallFrom) return null;
      return [] as readonly PlayerCommand[];
    },
    ...(opts.lead === undefined ? {} : { confirmedLead: () => opts.lead! }),
  };
}

/** A stepFn that counts calls and records the tick numbers it was handed. */
function counter(eventsPerStep: (tick: number) => readonly GameEvent[] = () => []) {
  const ticks: number[] = [];
  const fn = (tick: number, _cmds: readonly PlayerCommand[]) => {
    ticks.push(tick);
    return eventsPerStep(tick);
  };
  return { fn, ticks };
}

// ── The catch-up ladder ─────────────────────────────────────────────────────────────────────

test('a source with no confirmedLead at all plays at 1x (the ?? 0 fallback)', () => {
  // LocalInputSource / ReplayInputSource omit confirmedLead entirely — absent must read as
  // "no backlog", not as NaN (which would make every `>` comparison false by accident and
  // therefore look identical while meaning something else).
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(TICK_DT, source(), c.fn);
  assert.equal(c.ticks.length, 1, 'one banked tick of real time = exactly one sim step at 1x');
});

test('one banked tick of real time yields speed x steps, one rung per backlog band', () => {
  const rungs: { lead: number; speed: number; why: string }[] = [
    { lead: 0, speed: 1, why: 'synced' },
    { lead: 3, speed: 1, why: 'a single 100 ms batch lands 3 frames at once — must NOT trip catch-up' },
    { lead: 4, speed: 3, why: 'just past one batch: drain back to the jitter cushion' },
    { lead: 1 * TICK_RATE, speed: 3, why: 'exactly 1 s is still the 3x rung (> is strict)' },
    { lead: 1 * TICK_RATE + 1, speed: 5, why: 'over 1 s' },
    { lead: 3 * TICK_RATE, speed: 5, why: 'exactly 3 s is still the 5x rung (> is strict)' },
    { lead: 3 * TICK_RATE + 1, speed: 10, why: 'over 3 s — a backgrounded tab' },
    { lead: 10_000, speed: 10, why: 'the top rung has no further tier' },
  ];
  for (const { lead, speed, why } of rungs) {
    const d = new RealtimeDriver();
    const c = counter();
    d.tick(ONE_TICK, source({ lead }), c.fn);
    assert.equal(c.ticks.length, speed, `lead ${lead} should run ${speed} steps (${why})`);
  }
});

test('catch-up re-times steps but never reorders or skips them', () => {
  // The determinism claim in the doc comment: at 10x the tick numbers are still 0,1,2,… with
  // no gaps, i.e. speed only changes WHEN steps run, never WHICH.
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(ONE_TICK, source({ lead: 10 * TICK_RATE }), c.fn);
  assert.deepEqual(c.ticks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(d.currentTick, 10, 'currentTick is where a command submitted now would land');
});

// ── The accumulator cap ─────────────────────────────────────────────────────────────────────

test('banked time is capped at MAX_CATCHUP_TICKS so a long pause cannot burst unbounded', () => {
  // 60 s of banked wall clock (a backgrounded tab) with no backlog reported: the cap must
  // convert it into 5 steps, not 1800. Without it, one tick() call runs a half-minute of sim
  // inside a single render frame — the spiral of death.
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(60, source(), c.fn);
  assert.equal(c.ticks.length, 5, 'MAX_CATCHUP_TICKS at 1x');
});

test('the cap is on REAL time, so a high catch-up speed still gets speed x more steps out of it', () => {
  // Same 60 s pause, but the source reports a big backlog: the same 5 capped ticks of real
  // time now buy 50 sim steps. This is the intended fast-forward, and it is the reason the cap
  // is expressed in real time rather than in steps.
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(60, source({ lead: 10 * TICK_RATE }), c.fn);
  assert.equal(c.ticks.length, 50);
});

test('a dt below one step banks without stepping, and two of them add up to one step', () => {
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(TICK_DT / 2, source(), c.fn);
  assert.equal(c.ticks.length, 0, 'half a tick is not a step');
  assert.deepEqual(d.tick(TICK_DT / 2, source(), c.fn), [], 'a 0-step frame returns no events');
  assert.equal(c.ticks.length, 1, '...but the two halves do add up');
});

// ── The lockstep stall ──────────────────────────────────────────────────────────────────────

test('an unconfirmed frame stops the loop and drops banked time back to a single step', () => {
  // 10 ticks banked, but the source confirms only frames 0-2. The driver must run those three
  // and then hold, keeping at most ONE step of banked time — so when the batch lands, playback
  // resumes at the natural cadence instead of replaying the whole buffer in one frame.
  const d = new RealtimeDriver();
  const c = counter();
  d.tick(TICK_DT * 10, source({ stallFrom: 3 }), c.fn);
  assert.deepEqual(c.ticks, [0, 1, 2]);
  assert.equal(d.currentTick, 3);

  // The frame is still unconfirmed, and the banked time is already clamped: the next call adds
  // one tick, so it can bank at most 2 steps' worth — which yields at most ONE step once the
  // batch lands, not the 7 that were originally banked.
  const c2 = counter();
  d.tick(TICK_DT, source({ stallFrom: 3 }), c2.fn);
  assert.deepEqual(c2.ticks, [], 'still stalled');
  const c3 = counter();
  d.tick(0, source(), c3.fn);
  assert.ok(c3.ticks.length <= 2, `resumed with a burst of ${c3.ticks.length} steps`);
  assert.deepEqual(c3.ticks.slice(0, 1), [3], 'and it resumes exactly where it stalled');
});

test('a stall on the very first frame runs nothing and returns no events', () => {
  const d = new RealtimeDriver();
  const c = counter();
  // Banked time is only ONE step here, so the `accumulatedTime > stepDt` guard inside the stall
  // branch takes its other arm (nothing to clamp) — the frame is simply held.
  assert.deepEqual(d.tick(TICK_DT, source({ stallFrom: 0 }), c.fn), []);
  assert.deepEqual(c.ticks, []);
  assert.equal(d.currentTick, 0);
});

// ── Event unioning across the steps of one frame ────────────────────────────────────────────

test('a catch-up frame returns the UNION of every step it ran, in step order', () => {
  const d = new RealtimeDriver();
  const c = counter((tick) => [{ type: 'base_upgraded', owner: 0, level: tick } as unknown as GameEvent]);
  const events = d.tick(ONE_TICK, source({ lead: 4 }), c.fn);
  assert.equal(c.ticks.length, 3, '3x rung');
  assert.equal(events.length, 3, "an earlier step's events must not be lost");
  assert.deepEqual(
    events.map((e) => (e as unknown as { level: number }).level),
    [0, 1, 2],
  );
});

test('steps that produce no events contribute nothing (the length guard)', () => {
  const d = new RealtimeDriver();
  // Every other step emits; the frame's union must hold only the non-empty ones.
  const c = counter((tick) =>
    tick % 2 === 0 ? [{ type: 'base_upgraded', owner: 0, level: tick } as unknown as GameEvent] : [],
  );
  const events = d.tick(ONE_TICK, source({ lead: 4 }), c.fn);
  assert.equal(events.length, 2);
});
