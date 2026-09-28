/**
 * adaptiveResolution.test.ts — when the renderer drops from 2 to 1.5, and (mostly) when it must not.
 *
 * Driven frame by frame through ResolutionGovernor so every case states the exact frame gaps it
 * feeds. See src/render/adaptiveResolution.ts (ADR-100) for why each threshold is where it is.
 */
import { describe, it, expect } from 'vitest';
import {
  ResolutionGovernor, applyRendererResolution, installAdaptiveResolution,
  LOW_RESOLUTION, WARMUP_MS, WINDOW_MS,
} from '../src/render/adaptiveResolution';

/** Feed `ms` of frames at a fixed gap (optionally with a stall every `stallEvery` frames). */
function run(
  g: ResolutionGovernor, t0: number, ms: number, gap: number,
  opts: { live?: boolean; stallEvery?: number; stallMs?: number } = {},
) {
  let t = t0;
  let i = 0;
  let decision = null as ReturnType<ResolutionGovernor['frame']>;
  while (t < t0 + ms) {
    const g1 = opts.stallEvery && ++i % opts.stallEvery === 0 ? opts.stallMs ?? 600 : gap;
    t += g1;
    const d = g.frame(t, g1, opts.live ?? true);
    if (d) decision = d;
  }
  return { t, decision };
}

describe('ResolutionGovernor', () => {
  it('drops a resolution-2 renderer to 1.5 after warm-up plus one window below 24 fps', () => {
    const g = new ResolutionGovernor(2);
    const { decision } = run(g, 0, WARMUP_MS + WINDOW_MS + 200, 1000 / 18);
    expect(decision).toEqual({ from: 2, to: LOW_RESOLUTION, fps: 18 });
    expect(g.settled).toBe(true);
  });

  it('does not judge during the warm-up', () => {
    const g = new ResolutionGovernor(2);
    expect(run(g, 0, WARMUP_MS + WINDOW_MS - 100, 1000 / 15).decision).toBeNull();
  });

  it('leaves a 30 Hz-capped browser alone (Low Power Mode Safari: a steady 33 ms)', () => {
    const g = new ResolutionGovernor(2);
    expect(run(g, 0, 60_000, 1000 / 30).decision).toBeNull();
    expect(g.settled).toBe(false);
  });

  it('ignores isolated stalls — they are not frame-rate load', () => {
    const g = new ResolutionGovernor(2);
    expect(run(g, 0, 60_000, 1000 / 55, { stallEvery: 20, stallMs: 900 }).decision).toBeNull();
  });

  it('a reactive scene or a hidden tab resets the window: only an unbroken live stretch counts', () => {
    const g = new ResolutionGovernor(2);
    let t = 0;
    for (let k = 0; k < 6; k++) {
      // 6 s slow and live, then a non-live frame: never a full warm-up + window in one stretch.
      const r = run(g, t, WARMUP_MS + WINDOW_MS - 2_500, 1000 / 15);
      expect(r.decision).toBeNull();
      t = r.t + 16;
      expect(g.frame(t, 16, false)).toBeNull();
    }
  });

  it('never fires at or below the target resolution (dpr 1, WeChat, an already-lowered 1.5)', () => {
    for (const res of [1, 1.25, LOW_RESOLUTION]) {
      const g = new ResolutionGovernor(res);
      expect(g.settled).toBe(true);
      expect(run(g, 0, 60_000, 1000 / 10).decision).toBeNull();
    }
  });

  it('fires once per session', () => {
    const g = new ResolutionGovernor(2);
    const first = run(g, 0, WARMUP_MS + WINDOW_MS + 200, 1000 / 15);
    expect(first.decision).not.toBeNull();
    expect(run(g, first.t, 60_000, 1000 / 10).decision).toBeNull();
  });

  it('needs enough samples: a window of mostly stalls does not judge', () => {
    const g = new ResolutionGovernor(2);
    // 200 ms frames are under STALL_MS but only 25 fit in a window (< MIN_SAMPLES).
    expect(run(g, 0, 60_000, 200).decision).toBeNull();
  });
});

describe('applyRendererResolution', () => {
  it('keeps the CSS size and reallocates the backbuffer at the new resolution', () => {
    const calls: string[] = [];
    const r = {
      resolution: 2,
      screen: { width: 768, height: 654 },
      resize(w: number, h: number) { calls.push(`resize ${w}x${h} @${this.resolution}`); },
    };
    applyRendererResolution(r, 1.5);
    expect(r.resolution).toBe(1.5);
    expect(calls).toEqual(['resize 768x654 @1.5']);
  });
});

describe('installAdaptiveResolution', () => {
  it('does not even subscribe to the ticker on a renderer that can never drop', () => {
    let added = 0;
    const ticker = { add: () => { added++; }, remove: () => {}, elapsedMS: 16 };
    installAdaptiveResolution(
      { renderer: { resolution: 1, screen: { width: 1, height: 1 }, resize: () => {} }, ticker: ticker as never },
      () => 'live', () => {},
    );
    expect(added).toBe(0);
  });
});
