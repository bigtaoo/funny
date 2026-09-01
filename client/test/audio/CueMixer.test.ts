// CueMixer is where the two-rung ladder lives, and both rungs are audible-but-different rather
// than present-or-absent — so "it played something" proves nothing. Each case pins WHICH rung ran
// and at what gain.
//
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { CueMixer, coalesceBoost } from '../../src/audio/CueMixer';
import { CUE_CATALOGUE } from '../../src/audio/cueCatalogue';
import type { SampleBank } from '../../src/audio/SampleBank';
import type { AudioCue } from '../../src/audio/types';
import { fakeAudioContext, asCtx, asGain, fakeBuffer, type FakeAudioContext, type FakeNode } from './fakeAudioContext';

/** A SampleBank stand-in holding whatever variants a case wants. */
function bankOf(map: Partial<Record<AudioCue, AudioBuffer[]>>): SampleBank {
  return {
    variantsOf: (cue: AudioCue) => map[cue],
  } as unknown as SampleBank;
}

interface Rig {
  ctx: FakeAudioContext;
  bus: FakeNode;
  mixer: CueMixer;
}

function rig(
  map: Partial<Record<AudioCue, AudioBuffer[]>> = {},
  opts: { cap?: number; random?: () => number } = {},
): Rig {
  const ctx = fakeAudioContext();
  const bus = ctx.createGain();
  const mixer = new CueMixer({
    ctx: asCtx(ctx),
    bus: asGain(bus),
    bank: bankOf(map),
    cap: opts.cap,
    random: opts.random ?? (() => 0.5),
  });
  return { ctx, bus, mixer };
}

/** Gain nodes that feed the bus, i.e. one per voice actually started. */
function voiceGains(r: Rig): FakeNode[] {
  return r.ctx.nodes.filter((n) => n.kind === 'gain' && n !== r.bus && n.out.includes(r.bus));
}

describe('coalesceBoost', () => {
  it('is 1 for a single event and log-shaped above it', () => {
    expect(coalesceBoost(1)).toBe(1);
    expect(coalesceBoost(0)).toBe(1);
    // +0.15 per doubling: 2 -> 1.15, 4 -> 1.30, 8 -> 1.45.
    expect(coalesceBoost(2)).toBeCloseTo(1.15, 6);
    expect(coalesceBoost(4)).toBeCloseTo(1.3, 6);
    expect(coalesceBoost(8)).toBeCloseTo(1.45, 6);
  });

  it('is capped, so a pathological frame cannot blow the bus', () => {
    expect(coalesceBoost(1000)).toBe(1.5);
    expect(coalesceBoost(Number.MAX_SAFE_INTEGER)).toBe(1.5);
  });

  it('is monotonic', () => {
    let prev = 0;
    for (const n of [1, 2, 3, 4, 8, 16, 64]) {
      const v = coalesceBoost(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('CueMixer rung 1: a decoded sample', () => {
  it('plays the sample and no oscillator', () => {
    const r = rig({ 'sfx.unit.hit': [fakeBuffer(0.1)] });
    r.mixer.play('sfx.unit.hit');
    expect(r.ctx.of('bufferSource')).toHaveLength(1);
    expect(r.ctx.of('oscillator')).toHaveLength(0);
    expect(r.ctx.of('bufferSource')[0].started).toEqual([0]);
  });

  it('applies the catalogue gain, and the coalesce boost on top of it', () => {
    const r = rig({ 'sfx.unit.hit': [fakeBuffer(0.1)] });
    r.mixer.play('sfx.unit.hit', 4);
    const expected = CUE_CATALOGUE['sfx.unit.hit'].gain * coalesceBoost(4);
    expect(voiceGains(r)).toHaveLength(1);
    expect(voiceGains(r)[0].gain!.value).toBeCloseTo(expected, 6);
  });

  it('a coalesced cue plays ONCE, louder — not N times', () => {
    const r = rig({ 'sfx.unit.hit': [fakeBuffer(0.1)] });
    r.mixer.play('sfx.unit.hit', 10);
    expect(r.ctx.of('bufferSource')).toHaveLength(1);
    expect(voiceGains(r)[0].gain!.value).toBeGreaterThan(CUE_CATALOGUE['sfx.unit.hit'].gain);
  });

  it('jitters pitch within +/-3%', () => {
    for (const [rand, expected] of [
      [0, 0.97],
      [0.5, 1],
      [1, 1.03],
    ] as const) {
      const r = rig({ 'sfx.unit.hit': [fakeBuffer(0.1)] }, { random: () => rand });
      r.mixer.play('sfx.unit.hit');
      expect(r.ctx.of('bufferSource')[0].playbackRate!.value).toBeCloseTo(expected, 6);
    }
  });

  it('never repeats the previous variant', () => {
    // Cycle `random` so a naive implementation would repeat.
    let n = 0;
    const r = rig(
      { 'sfx.unit.hit': [fakeBuffer(0.1), fakeBuffer(0.2), fakeBuffer(0.3)] },
      // cap well above the play count: this case is about variant choice, and letting it sit on
      // the default cap would make it fail for an unrelated reason if that default ever changes.
      { cap: 64, random: () => (n++ % 2 === 0 ? 0 : 0.99) },
    );
    const played: number[] = [];
    for (let i = 0; i < 12; i++) {
      const before = r.ctx.of('bufferSource').length;
      r.mixer.play('sfx.unit.hit');
      const src = r.ctx.of('bufferSource')[before];
      played.push((src.buffer as AudioBuffer).duration);
    }
    for (let i = 1; i < played.length; i++) {
      expect(played[i], `play #${i}`).not.toBe(played[i - 1]);
    }
  });

  it('a single-variant cue plays that variant every time', () => {
    const only = fakeBuffer(0.15);
    const r = rig({ 'sfx.ui.tap': [only] }, { random: () => 0.999999 });
    r.mixer.play('sfx.ui.tap');
    r.mixer.play('sfx.ui.tap');
    // Would be an out-of-range index if pickVariant did not clamp.
    for (const src of r.ctx.of('bufferSource')) expect(src.buffer).toBe(only);
  });
});

describe('CueMixer rung 2: the synth fallback', () => {
  it('runs when the cue has no samples at all', () => {
    const r = rig({});
    r.mixer.play('sfx.ui.back');
    // sfx.ui.back is a single tone → exactly one oscillator, no buffer source.
    expect(r.ctx.of('oscillator')).toHaveLength(1);
    expect(r.ctx.of('bufferSource')).toHaveLength(0);
  });

  it('runs when the cue is present but its variant list is empty', () => {
    // SampleBank never stores [], but a hand-built bank (or a future loader change) could.
    const r = rig({ 'sfx.ui.back': [] });
    r.mixer.play('sfx.ui.back');
    expect(r.ctx.of('oscillator')).toHaveLength(1);
  });

  it('connects straight to the bus when the effective gain is exactly 1', () => {
    // sfx.ui.tap has catalogue gain 1.0; with count=1 the trim node would be a provable no-op.
    const before = rig({});
    before.mixer.play('sfx.ui.tap');
    expect(CUE_CATALOGUE['sfx.ui.tap'].gain).toBe(1);
    // The only gain nodes are the bus and the voice's own envelope — no extra trim node.
    expect(before.ctx.of('gain')).toHaveLength(2);
  });

  it('inserts a trim node when the catalogue gain is not 1', () => {
    const r = rig({});
    expect(CUE_CATALOGUE['sfx.unit.attack'].gain).not.toBe(1);
    r.mixer.play('sfx.unit.attack');
    const trims = r.ctx.nodes.filter(
      (n) => n.kind === 'gain' && n !== r.bus && n.out.includes(r.bus) && n.gain!.value !== 1,
    );
    expect(trims).toHaveLength(1);
    expect(trims[0].gain!.value).toBeCloseTo(CUE_CATALOGUE['sfx.unit.attack'].gain, 6);
  });

  it('the coalesce boost reaches the synth rung too', () => {
    // Both rungs pass through the same gain, so swapping in a sample never changes the weight of
    // the mix — that is the property that makes the ladder invisible to the player.
    const r = rig({});
    r.mixer.play('sfx.ui.tap', 8);
    const trims = r.ctx.nodes.filter(
      (n) => n.kind === 'gain' && n !== r.bus && n.out.includes(r.bus) && n.gain!.value !== 1,
    );
    expect(trims).toHaveLength(1);
    expect(trims[0].gain!.value).toBeCloseTo(coalesceBoost(8), 6);
  });
});

describe('CueMixer voice cap', () => {
  it('drops a low-priority cue once the cap is met by stronger voices', () => {
    const r = rig(
      { 'sfx.unit.attack': [fakeBuffer(5)], 'sfx.base.hit': [fakeBuffer(5)] },
      { cap: 1 },
    );
    r.mixer.play('sfx.base.hit');
    r.mixer.play('sfx.unit.attack');
    // Only the first got a slot; the second built nothing at all.
    expect(r.ctx.of('bufferSource')).toHaveLength(1);
  });

  it('a higher-priority cue steals, and the stolen voice is faded rather than cut dead', () => {
    const r = rig(
      { 'sfx.unit.attack': [fakeBuffer(5)], 'sfx.base.hit': [fakeBuffer(5)] },
      { cap: 1 },
    );
    r.mixer.play('sfx.unit.attack');
    const victim = voiceGains(r)[0];
    r.mixer.play('sfx.base.hit');
    expect(r.ctx.of('bufferSource')).toHaveLength(2);
    // The fade: a hold at the current value, then a ramp to 0 shortly after.
    expect(victim.gain!.sets).toHaveLength(1);
    expect(victim.gain!.ramps).toHaveLength(1);
    expect(victim.gain!.ramps[0][1]).toBe(0);
    expect(victim.gain!.ramps[0][0]).toBeGreaterThan(0);
    // …and the source is stopped at the end of that fade, not at `now`.
    expect(r.ctx.of('bufferSource')[0].stopped[0]).toBeCloseTo(victim.gain!.ramps[0][0], 6);
  });

  it('claims a slot BEFORE building nodes, so a dropped cue costs nothing', () => {
    const r = rig({ 'sfx.unit.attack': [fakeBuffer(5)] }, { cap: 1 });
    r.mixer.play('sfx.unit.attack');
    const after = r.ctx.nodes.length;
    r.mixer.play('sfx.unit.attack'); // equal priority at the cap → refused
    expect(r.ctx.nodes.length).toBe(after);
  });

  it('the cap does not apply to the synth rung', () => {
    // Only sample voices are counted (VoiceBudget is claimed in the sample branch). A cold boot
    // fires every cue through the synth, and gating those on a cap sized for samples would make
    // the pre-preload game quieter than the post-preload one for no reason.
    const r = rig({}, { cap: 1 });
    // sfx.ui.back's voice is a single tone(), so oscillator count IS the voice count.
    for (let i = 0; i < 5; i++) r.mixer.play('sfx.ui.back');
    expect(r.ctx.of('oscillator')).toHaveLength(5);
  });

  it('a voice that has finished frees its slot', () => {
    const r = rig({ 'sfx.unit.attack': [fakeBuffer(0.1)] }, { cap: 1 });
    r.mixer.play('sfx.unit.attack');
    r.ctx.currentTime = 1; // well past the 0.1s clip
    r.mixer.play('sfx.unit.attack');
    expect(r.ctx.of('bufferSource')).toHaveLength(2);
  });

  it('accounts for pitch jitter when computing when a voice ends', () => {
    // A voice slowed to 0.97x lasts LONGER than its buffer duration; using the raw duration would
    // free the slot early and let the cap drift over budget.
    const r = rig({ 'sfx.unit.attack': [fakeBuffer(1)] }, { cap: 1, random: () => 0 });
    r.mixer.play('sfx.unit.attack');
    r.ctx.currentTime = 1.0; // buffer duration, but at 0.97x it is still sounding
    r.mixer.play('sfx.unit.attack');
    expect(r.ctx.of('bufferSource')).toHaveLength(1);
  });
});
