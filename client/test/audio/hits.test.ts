// The shared hit table + dispatcher (src/ui/hits.ts) — the single place a UI cue is emitted
// (AUDIO_DESIGN.md §7 step 4).
//
// Lives under test/audio/ rather than beside the scene tests because that is what these assertions
// are about: the geometry half is a three-line containment test that 40 scenes were already doing
// identically, while the cue half is new behaviour with a default, an opt-out, and an ordering
// guarantee that nothing else in the client encodes.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, AudioCue } from '../../src/audio/types';
import { inRect, hitTest, runHit, dispatchHit, hitAction, tapHandler, type Hit } from '../../src/ui/hits';

function recorder(): AudioBus & { cues: AudioCue[] } {
  const cues: AudioCue[] = [];
  return {
    cues,
    async preload() {},
    play(cue) { cues.push(cue); },
    setSfxVolume() {},
    setMusicVolume() {},
    playMusic() {},
    resume() {},
  };
}

let bus: ReturnType<typeof recorder>;

beforeEach(() => {
  bus = recorder();
  setAudioBus(bus);
});
afterEach(() => setAudioBus(new NullAudioBus()));

const R = { x: 10, y: 20, w: 100, h: 50 };

describe('inRect / hitTest — the geometry the 22 hand-written copies all had', () => {
  it('counts every edge as inside', () => {
    expect(inRect(10, 20, R)).toBe(true);
    expect(inRect(110, 70, R)).toBe(true);
    expect(inRect(9, 45, R)).toBe(false);
    expect(inRect(111, 45, R)).toBe(false);
    expect(inRect(60, 19, R)).toBe(false);
    expect(inRect(60, 71, R)).toBe(false);
  });

  it('returns the FIRST match, so push order is precedence', () => {
    const a: Hit = { rect: R, fn: () => {} };
    const b: Hit = { rect: R, fn: () => {} };
    expect(hitTest([a, b], 60, 45)).toBe(a);
  });

  it('is generic over anything carrying a rect — the slider lists are not Hits', () => {
    const sliders = [{ rect: R, onDrag: (): void => {} }];
    expect(hitTest(sliders, 60, 45)).toBe(sliders[0]);
  });
});

describe('runHit — the one place a UI cue is emitted', () => {
  it('defaults to sfx.ui.tap when the hit says nothing', () => {
    runHit({ fn: () => {} });
    expect(bus.cues).toEqual(['sfx.ui.tap']);
  });

  it('honours an explicit cue', () => {
    runHit({ sound: 'sfx.ui.back', fn: () => {} });
    expect(bus.cues).toEqual(['sfx.ui.back']);
  });

  it('null is silence, not the default — a blocker rect is not a button', () => {
    runHit({ sound: null, fn: () => {} });
    expect(bus.cues).toEqual([]);
  });

  it('plays BEFORE the action, so a slow synchronous fn cannot delay the feedback', () => {
    const order: string[] = [];
    setAudioBus({
      async preload() {}, play: () => { order.push('cue'); },
      setSfxVolume() {}, setMusicVolume() {}, playMusic() {}, resume() {},
    });
    runHit({ fn: () => order.push('fn') });
    expect(order).toEqual(['cue', 'fn']);
  });

  it('still runs the action when the device throws (playSfx swallows it)', () => {
    setAudioBus({
      async preload() {}, play() { throw new Error('device gone'); },
      setSfxVolume() {}, setMusicVolume() {}, playMusic() {}, resume() {},
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn();
    runHit({ fn });
    expect(fn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('dispatchHit', () => {
  it('fires the first hit under the point and reports it', () => {
    const first = vi.fn();
    const second = vi.fn();
    const hit = dispatchHit([{ rect: R, fn: first }, { rect: R, fn: second }], 60, 45);
    expect(hit).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(bus.cues).toEqual(['sfx.ui.tap']);
  });

  it('a miss is silent and reports false — scenes branch on this', () => {
    expect(dispatchHit([{ rect: R, fn: vi.fn() }], 500, 500)).toBe(false);
    expect(bus.cues).toEqual([]);
  });
});

describe('tapHandler — the listener form for PIXI-native buttons', () => {
  it('returns a listener that sounds and then runs, same as a hit', () => {
    const fn = vi.fn();
    const listener = tapHandler(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(bus.cues).toEqual([]);
    listener();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.tap']);
  });

  it('takes an explicit cue, and null for silence', () => {
    tapHandler(() => {}, 'sfx.ui.back')();
    expect(bus.cues).toEqual(['sfx.ui.back']);
    bus.cues.length = 0;
    tapHandler(() => {}, null)();
    expect(bus.cues).toEqual([]);
  });

  it('is reusable — PIXI keeps one listener for the whole object lifetime', () => {
    const listener = tapHandler(() => {});
    listener(); listener(); listener();
    expect(bus.cues).toEqual(['sfx.ui.tap', 'sfx.ui.tap', 'sfx.ui.tap']);
  });
});

describe('hitAction — the deferred form ScrollTapGesture takes', () => {
  it('does not fire (or sound) until the returned closure is called', () => {
    const fn = vi.fn();
    const run = hitAction([{ rect: R, sound: 'sfx.ui.back', fn }], 60, 45);
    expect(fn).not.toHaveBeenCalled();
    expect(bus.cues).toEqual([]);
    run!();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bus.cues).toEqual(['sfx.ui.back']);
  });

  it('a gesture that turns into a drag drops the closure — and therefore the cue', () => {
    const run = hitAction([{ rect: R, fn: vi.fn() }], 60, 45);
    expect(run).not.toBeNull();
    // ScrollTapGesture.up() returns null on a drag; the caller never invokes what we handed it.
    expect(bus.cues).toEqual([]);
  });

  it('returns null on a miss — the shape ScrollTapGesture.down expects', () => {
    expect(hitAction([{ rect: R, fn: vi.fn() }], 0, 0)).toBeNull();
  });
});
