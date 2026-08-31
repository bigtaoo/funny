// The synth voice table is what makes the game audible today (cueAssets.ts is empty), so these
// cases assert the node graph each cue actually builds — not merely that playCue() returned.
// An implementation that built nothing would pass the latter and ship silence.
//
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { playCue, hasVoice, tone, noise } from '../../src/audio/audioSynth';
import { ALL_CUES } from '../../src/audio/cueCatalogue';
import { fakeAudioContext, asCtx, asGain, type FakeNode } from './fakeAudioContext';

function play(cue: (typeof ALL_CUES)[number]) {
  const ctx = fakeAudioContext();
  const bus = ctx.createGain();
  playCue(cue, asCtx(ctx), asGain(bus));
  return { ctx, bus };
}

/**
 * The loudest gain any of this cue's voices asks for. Both primitives express their peak as a
 * gain — tone() ramps 0 -> gain -> 0, noise() sets `gain.value` directly — so this IS the cue's
 * peak amplitude. The bus node itself is excluded: it carries the settings volume, not a voice.
 */
function peakOf(cue: (typeof ALL_CUES)[number]): number {
  const { ctx, bus } = play(cue);
  const voices = ctx.of('gain').filter((g) => g !== bus);
  return Math.max(
    0,
    ...voices.map((g) => Math.max(g.gain!.value, ...g.gain!.ramps.map(([, v]) => v))),
  );
}

/** Every node that ends up feeding `bus`, following connect() edges. */
function feeds(bus: FakeNode, ctx: ReturnType<typeof fakeAudioContext>): FakeNode[] {
  return ctx.nodes.filter((n) => n.out.includes(bus));
}

describe('audioSynth voice table', () => {
  it('every cue in the union has a voice', () => {
    for (const cue of ALL_CUES) expect(hasVoice(cue), cue).toBe(true);
  });

  it('every cue builds at least one sounding source and reaches the bus', () => {
    for (const cue of ALL_CUES) {
      const { ctx, bus } = play(cue);
      const sources = [...ctx.of('oscillator'), ...ctx.of('bufferSource')];
      expect(sources.length, cue).toBeGreaterThan(0);
      // Every source must actually be started, and every source must terminate: an unstopped
      // oscillator runs forever and a leak here is audible as a stuck tone.
      for (const s of sources) {
        expect(s.started.length, `${cue} started`).toBe(1);
        expect(s.stopped.length, `${cue} stopped`).toBe(1);
        expect(s.stopped[0], `${cue} stop after start`).toBeGreaterThan(s.started[0]);
      }
      expect(feeds(bus, ctx).length, `${cue} reaches bus`).toBeGreaterThan(0);
    }
  });

  it('no voice exceeds the 0.2 peak ceiling the mix is built on', () => {
    // AUDIO_DESIGN.md §4 wants a quiet bed and punchy combat; CueMixer multiplies these by the
    // catalogue gain and the coalesce boost (up to x1.5) before the bus volume. A voice authored
    // at 0.5 would clip the sum long before the settings slider is at 1.0.
    for (const cue of ALL_CUES) {
      expect(peakOf(cue), cue).toBeLessThanOrEqual(0.2);
      expect(peakOf(cue), cue).toBeGreaterThan(0);
    }
  });

  it('UI cues sit at or below every battle cue', () => {
    const loudestUi = Math.max(...ALL_CUES.filter((c) => c.startsWith('sfx.ui.')).map(peakOf));
    // A button has to be heard over a quiet menu, never startle over a loud fight.
    expect(loudestUi).toBeLessThanOrEqual(peakOf('sfx.unit.hit'));
    expect(loudestUi).toBeLessThanOrEqual(peakOf('sfx.base.hit'));
  });

  it('the three most frequent battle cues are the shortest', () => {
    // Duration is readable off the stop() time the voice scheduled.
    const durOf = (cue: (typeof ALL_CUES)[number]): number => {
      const { ctx } = play(cue);
      const ends = [...ctx.of('oscillator'), ...ctx.of('bufferSource')].flatMap((n) => n.stopped);
      return Math.max(...ends);
    };
    expect(durOf('sfx.unit.attack')).toBeLessThan(durOf('sfx.base.hit'));
    expect(durOf('sfx.unit.attack')).toBeLessThan(durOf('sfx.spell.cast'));
    expect(durOf('sfx.ui.tap')).toBeLessThan(durOf('sfx.ui.error'));
  });

  it('back sounds lower than tap, and error is separated by length not pitch', () => {
    // AUDIO_DESIGN.md §2.2's two UI distinctions, made concrete: leaving a screen must read under
    // entering one, and "that press did nothing" must not be just a differently-pitched click.
    const backOsc = play('sfx.ui.back').ctx.of('oscillator')[0];
    const errOsc = play('sfx.ui.error').ctx.of('oscillator')[0];
    expect(backOsc.frequency!.sets[0][1]).toBeLessThan(1000);
    // back glides DOWN.
    expect(backOsc.frequency!.ramps[0][1]).toBeLessThan(backOsc.frequency!.sets[0][1]);
    // error is a sustained buzz: a saw, and much longer than the tap click.
    expect(errOsc.type).toBe('sawtooth');
    expect(errOsc.stopped[0]).toBeGreaterThan(0.15);
  });

  it('gacha reveal escalates in note count with rarity', () => {
    const notes = (cue: (typeof ALL_CUES)[number]): number => play(cue).ctx.of('oscillator').length;
    expect(notes('sfx.ui.gacha.reveal.common')).toBe(1);
    expect(notes('sfx.ui.gacha.reveal.rare')).toBe(2);
    expect(notes('sfx.ui.gacha.reveal.epic')).toBe(3);
  });

  it('paper foley is multi-grain: the crumple is staggered in time', () => {
    // sfx.unit.death is 纸团揉碎 — one noise burst reads as a thud, not a crumple. The grains
    // must start at DIFFERENT times, which is what the `delay` primitive exists for.
    const { ctx } = play('sfx.unit.death');
    const starts = ctx.of('bufferSource').flatMap((n) => n.started);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('every noise grain is band-limited rather than raw white noise', () => {
    // art-direction §声音 bans metallic clash / explosion. A test cannot hear that, but one
    // structural half of it is checkable: raw full-spectrum white noise IS the explosion timbre,
    // so every grain must pass through at least one filter. Paper and pencil live in a band.
    for (const cue of ALL_CUES) {
      const { ctx } = play(cue);
      const sources = ctx.of('bufferSource');
      if (sources.length === 0) continue;
      // Each noise grain creates at least one biquad; count must keep up with the grains.
      expect(ctx.of('biquad').length, cue).toBeGreaterThanOrEqual(sources.length);
    }
  });
});

describe('audioSynth primitives', () => {
  it('tone ramps 0 -> gain -> 0, so its peak IS its gain argument', () => {
    // This property is what lets a future sample pass peak-match a UI voice without re-rendering
    // and measuring it (see the audio pipeline note in AUDIO_DESIGN.md §7).
    const ctx = fakeAudioContext({ now: 5 });
    const bus = ctx.createGain();
    tone(asCtx(ctx), asGain(bus), { freq: 440, type: 'square', dur: 0.1, gain: 0.09 });
    const g = ctx.of('gain')[1]; // [0] is the bus itself
    expect(g.gain!.sets).toEqual([[5, 0]]);
    // Times compared with closeTo: they are float sums off the context clock, and the exact
    // last-bit value is not what this case is about.
    expect(g.gain!.ramps).toHaveLength(2);
    expect(g.gain!.ramps[0][0]).toBeCloseTo(5.005, 6);
    expect(g.gain!.ramps[0][1]).toBe(0.09);
    expect(g.gain!.ramps[1][0]).toBeCloseTo(5.1, 6);
    expect(g.gain!.ramps[1][1]).toBe(0);
  });

  it('tone honours delay and slideTo against the context clock', () => {
    const ctx = fakeAudioContext({ now: 2 });
    const bus = ctx.createGain();
    tone(asCtx(ctx), asGain(bus), { freq: 400, type: 'sine', dur: 0.2, gain: 0.1, slideTo: 800, delay: 0.5 });
    const osc = ctx.of('oscillator')[0];
    expect(osc.started).toEqual([2.5]);
    expect(osc.frequency!.sets).toEqual([[2.5, 400]]);
    expect(osc.frequency!.ramps).toHaveLength(1);
    expect(osc.frequency!.ramps[0][0]).toBeCloseTo(2.7, 6);
    expect(osc.frequency!.ramps[0][1]).toBe(800);
  });

  it('noise bakes a decay envelope into the buffer and stays within +/-1', () => {
    const ctx = fakeAudioContext({ sampleRate: 1000 });
    const bus = ctx.createGain();
    noise(asCtx(ctx), asGain(bus), { dur: 0.1, gain: 0.15 });
    const src = ctx.of('bufferSource')[0];
    const data = (src.buffer as { data: Float32Array }).data;
    expect(data.length).toBe(100);
    for (const v of data) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    // Decay: the tail must be quieter than the head. Compare windowed averages rather than single
    // samples, since the carrier is random.
    const avg = (from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) s += Math.abs(data[i]);
      return s / (to - from);
    };
    expect(avg(0, 20)).toBeGreaterThan(avg(80, 100));
  });

  it('noise swell rises then falls — the shape of a page turn', () => {
    const ctx = fakeAudioContext({ sampleRate: 1000 });
    const bus = ctx.createGain();
    noise(asCtx(ctx), asGain(bus), { dur: 0.1, gain: 0.1, shape: 'swell' });
    const data = (ctx.of('bufferSource')[0].buffer as { data: Float32Array }).data;
    const avg = (from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) s += Math.abs(data[i]);
      return s / (to - from);
    };
    expect(avg(40, 60)).toBeGreaterThan(avg(0, 10));
    expect(avg(40, 60)).toBeGreaterThan(avg(90, 100));
  });

  it('noise inserts a highpass only when asked, and always a lowpass', () => {
    const plain = fakeAudioContext();
    noise(asCtx(plain), asGain(plain.createGain()), { dur: 0.05, gain: 0.1, cutoff: 2000 });
    expect(plain.of('biquad')).toHaveLength(1);
    expect(plain.of('biquad')[0].type).toBe('lowpass');

    const banded = fakeAudioContext();
    noise(asCtx(banded), asGain(banded.createGain()), { dur: 0.05, gain: 0.1, cutoff: 8000, hp: 1200 });
    const kinds = banded.of('biquad').map((n) => n.type);
    expect(kinds).toContain('lowpass');
    expect(kinds).toContain('highpass');
  });

  it('noise cutoffTo sweeps the lowpass over the grain', () => {
    const ctx = fakeAudioContext({ now: 1 });
    noise(asCtx(ctx), asGain(ctx.createGain()), { dur: 0.2, gain: 0.1, cutoff: 3000, cutoffTo: 9000 });
    const lp = ctx.of('biquad')[0];
    expect(lp.frequency!.sets).toEqual([[1, 3000]]);
    expect(lp.frequency!.ramps).toHaveLength(1);
    expect(lp.frequency!.ramps[0][0]).toBeCloseTo(1.2, 6);
    expect(lp.frequency!.ramps[0][1]).toBe(9000);
  });

  it('noise never builds a zero-length buffer', () => {
    // A 0-frame buffer throws in the real API; a sub-sample duration must round UP to 1.
    const ctx = fakeAudioContext({ sampleRate: 48000 });
    noise(asCtx(ctx), asGain(ctx.createGain()), { dur: 0.000001, gain: 0.1 });
    expect((ctx.of('bufferSource')[0].buffer as { length: number }).length).toBe(1);
  });
});
