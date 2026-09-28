// render/framePacer.ts — the frame cap as a whole-number divisor of the refresh rate (ADR-094).
//
// What this pins, and why each one matters:
//   1. At 60 Hz with a 60 cap, EVERY vsync runs. PIXI's `maxFPS` throttle truncates the elapsed
//      time to whole ms (16.67 -> 16 < 16.67) and dropped ~2% of frames; the first case below is
//      that bug, replayed against PIXI's own ticker so it goes red if anyone reinstates it.
//   2. Every other cap/refresh pair gives an EVEN cadence — the same number of vsyncs between runs,
//      every time. That is the owner's requirement ("stable, jitter <= 3").
//   3. Both tickers run on the same timestamp, shared first.
//   4. A stall is not paid twice, a cap raise takes effect on the very next vsync.
//
// Real `PIXI.Ticker`s (the headless adapter provides them); the rAF seam is manual.
//
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { FramePacer, VsyncPeriodEstimator, vsyncDivisor, type FrameScheduler } from '../../src/render/framePacer';

const manual: FrameScheduler = { request: () => 1, cancel: () => {} };

/** The timestamp a listener is being run for. `lastTime` is only advanced after listeners run. */
const nowOf = (t: PIXI.Ticker): number => t.lastTime + t.elapsedMS;

/** A pacer over two fresh tickers, recording the timestamp of every run of each. */
function rig(capFps: number) {
  const fx = new PIXI.Ticker();
  const app = new PIXI.Ticker();
  const runs: { fx: number[]; app: number[] } = { fx: [], app: [] };
  fx.add(() => { runs.fx.push(nowOf(fx)); });
  app.add(() => { runs.app.push(nowOf(app)); });
  const pacer = new FramePacer([fx, app], manual);
  pacer.install();
  pacer.capFps = capFps;
  return { pacer, runs, fx, app };
}

/** Feed `n` vsyncs of an `hz` display, with realistic ±0.3 ms timestamp jitter. */
function feed(pacer: FramePacer, hz: number, n: number, startMs = 1_000): number {
  const period = 1000 / hz;
  let t = startMs;
  for (let i = 0; i < n; i++) {
    t = startMs + i * period + (i % 3 === 0 ? 0.3 : i % 3 === 1 ? -0.3 : 0);
    pacer.onFrame(t);
  }
  return t;
}

/** Gaps between consecutive runs, in vsyncs of an `hz` display. */
function gapsInVsyncs(times: number[], hz: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push(Math.round((times[i] - times[i - 1]) * hz / 1000));
  return out;
}

describe('the bug this replaces', () => {
  it("PIXI's own maxFPS = 60 drops frames on a perfectly even 60 Hz stream", () => {
    // Kept as a characterisation: if a PIXI upgrade ever fixes the truncation this goes red, and
    // ADR-094 can be revisited. Until then it is the reason the pacer exists.
    const t = new PIXI.Ticker();
    let ran = 0;
    t.add(() => { ran++; });
    t.maxFPS = 60;
    t.lastTime = 0;
    (t as unknown as { _lastFrame: number })._lastFrame = 0;
    for (let i = 1; i <= 600; i++) t.update(i * (1000 / 60));
    expect(ran).toBeLessThan(600);
  });
});

describe('FramePacer — cadence', () => {
  it('at 60 Hz with a 60 cap, every vsync runs', () => {
    const { pacer, runs } = rig(60);
    feed(pacer, 60, 600);
    expect(runs.app).toHaveLength(600);
    expect(new Set(gapsInVsyncs(runs.app, 60))).toEqual(new Set([1]));
  });

  it.each([
    // [refresh Hz, cap, vsyncs between runs]
    [60, 20, 3],
    [120, 60, 2],
    [120, 20, 6],
    [144, 60, 2],
    [90, 60, 1],                   // 1.5 is a tie; the bias keeps it off the boundary
    [165, 60, 3],
    [144, 20, 7],
    [30, 20, 1],
    [75, 60, 1],
    [30, 60, 1],
    [60, 0, 1],
  ])('%i Hz, cap %i -> an even %i-vsync cadence', (hz, cap, n) => {
    const { pacer, runs } = rig(cap);
    feed(pacer, hz, 40);           // settle the refresh estimate
    runs.app.length = 0;
    feed(pacer, hz, hz * 3, 5_000);
    const gaps = gapsInVsyncs(runs.app, hz);
    expect(gaps.length).toBeGreaterThan(0);
    expect(new Set(gaps)).toEqual(new Set([n]));
  });

  it('runs both tickers on the same timestamp, shared first', () => {
    const order: string[] = [];
    const fx = new PIXI.Ticker();
    const app = new PIXI.Ticker();
    fx.add(() => { order.push(`fx@${nowOf(fx)}`); });
    app.add(() => { order.push(`app@${nowOf(app)}`); });
    const pacer = new FramePacer([fx, app], manual);
    pacer.install();
    pacer.capFps = 60;
    pacer.onFrame(1_000);
    pacer.onFrame(1_016.7);
    expect(order).toEqual(['fx@1000', 'app@1000', 'fx@1016.7', 'app@1016.7']);
  });

  it('raising the cap takes effect on the next vsync (input must not wait out an idle beat)', () => {
    const { pacer, runs } = rig(20);
    const t = feed(pacer, 60, 31);   // runs on vsyncs 0, 3, ... 30; at cap 20 the next one would skip
    const before = runs.app.length;
    pacer.capFps = 60;
    pacer.onFrame(t + 1000 / 60);
    expect(runs.app.length).toBe(before + 1);
  });

  it('a stall is not paid twice: after a long frame the next vsync runs', () => {
    const { pacer, runs } = rig(20);
    const t = feed(pacer, 60, 31);
    const before = runs.app.length;
    pacer.onFrame(t + 80);           // a 5-vsync stall, more than the 3-vsync beat
    expect(runs.app.length).toBe(before + 1);
  });

  it('dt is the real elapsed time between runs (every consumer integrates deltaMS)', () => {
    const { pacer, app } = rig(20);
    const seen: number[] = [];
    app.add(() => { seen.push(app.deltaMS); });
    feed(pacer, 60, 60);
    for (const d of seen.slice(2)) expect(d).toBeCloseTo(50, 0);
  });
});

describe('FramePacer — install / uninstall', () => {
  it("takes the tickers' own loops away, and gives them back as found", () => {
    const t = new PIXI.Ticker();
    t.autoStart = true;
    t.maxFPS = 30;
    t.add(() => {});                 // autoStart -> started
    expect(t.started).toBe(true);
    const pacer = new FramePacer([t], manual);
    pacer.install();
    expect(t.started).toBe(false);
    expect(t.maxFPS).toBe(0);
    t.add(() => {});                 // must NOT restart its own loop (autoStart is off)
    expect(t.started).toBe(false);
    pacer.uninstall();
    expect(t.started).toBe(true);
    expect(t.autoStart).toBe(true);
    expect(t.maxFPS).toBe(30);
    t.stop();
  });

  it('re-arms before running listeners, so one throwing listener costs one frame, not the loop', () => {
    let requested = 0;
    const sched: FrameScheduler = { request: () => ++requested, cancel: () => {} };
    const t = new PIXI.Ticker();
    t.add(() => { throw new Error('boom'); });
    const pacer = new FramePacer([t], sched);
    pacer.install();
    const before = requested;
    expect(() => pacer.onFrame(1_000)).toThrow('boom');
    expect(requested).toBe(before + 1);
  });
});

describe('vsyncDivisor / VsyncPeriodEstimator', () => {
  it('no common panel sits within 0.05 of a divisor boundary (a wobbling estimate must not flip it)', () => {
    for (const hz of [60, 75, 90, 100, 120, 144, 165, 240]) {
      for (const cap of [60, 20]) {
        expect(vsyncDivisor(hz * 0.9975, cap)).toBe(vsyncDivisor(hz * 1.0025, cap));
      }
    }
  });

  it('divisor never drops below 1, and 0 means uncapped', () => {
    expect(vsyncDivisor(30, 60)).toBe(1);
    expect(vsyncDivisor(60, 0)).toBe(1);
    expect(vsyncDivisor(0, 60)).toBe(1);
  });

  it('the refresh estimate ignores the odd dropped frame and backgrounded-tab gaps', () => {
    const e = new VsyncPeriodEstimator();
    for (let i = 0; i < 16; i++) e.push(i % 5 === 0 ? 33.3 : 16.7);
    e.push(5_000);
    expect(e.refreshHz).toBeCloseTo(60, 0);
  });

  it('follows a display that really runs at 30 Hz', () => {
    const e = new VsyncPeriodEstimator();
    for (let i = 0; i < 16; i++) e.push(33.3);
    expect(e.refreshHz).toBeCloseTo(30, 0);
  });
});
