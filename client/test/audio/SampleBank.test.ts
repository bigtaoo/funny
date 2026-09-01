// SampleBank's contract is "degrade per file, never throw, never block boot". Every case here is
// a way that could quietly become "load nothing and stay on the synth voices forever", which is
// invisible in the game.
//
// The real cueAssets.ts is empty today (no audio assets exist yet), so it is mocked with a
// mutable map — that is the point of the module, not a workaround: the loader must be provably
// correct BEFORE the first file lands, or the first file landing is when we find out it isn't.
//
// Run with: npm test
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBuffer } from './fakeAudioContext';

const { assets } = vi.hoisted(() => ({ assets: new Map<string, string[]>() }));

vi.mock('../../src/audio/cueAssets', () => ({
  CUE_ASSETS: {},
  variantUrls: (cue: string) => assets.get(cue) ?? [],
  variantCount: (cue: string) => (assets.get(cue) ?? []).length,
  allSfxUrls: () => [...assets.values()].flat(),
}));

// Static imports are fine: vitest hoists vi.mock above them, so cueCatalogue's cuesWithSamples()
// reads the mocked variantCount too (that indirection is exactly what makes the mock enough).
import { SampleBank } from '../../src/audio/SampleBank';
import { cuesWithSamples } from '../../src/audio/cueCatalogue';
import type { AudioCue } from '../../src/audio/types';

interface Harness {
  bank: SampleBank;
  reads: string[];
  warnings: string[];
  /** url -> what readBinary does. Missing url = a rejected read. */
  bytes: Map<string, ArrayBuffer>;
  /** url -> what decodeAudioData does. An Error means decode failure. */
  decoded: Map<string, AudioBuffer | Error>;
}

function harness(): Harness {
  const h: Partial<Harness> = {
    reads: [],
    warnings: [],
    bytes: new Map(),
    decoded: new Map(),
  };
  // Bytes carry their url so the fake decoder can decide per file.
  const urlOf = new Map<ArrayBuffer, string>();
  const ctx = {
    decodeAudioData: (data: ArrayBuffer, ok?: (b: AudioBuffer) => void, fail?: (e: unknown) => void) => {
      const url = urlOf.get(data) ?? '?';
      const outcome = h.decoded!.get(url);
      if (outcome instanceof Error) fail?.(outcome);
      else if (outcome) ok?.(outcome);
      else fail?.(new Error(`no decode outcome for ${url}`));
      return undefined;
    },
  };
  h.bank = new SampleBank({
    ctx,
    readBinary: async (url: string) => {
      h.reads!.push(url);
      const b = h.bytes!.get(url);
      if (!b) throw new Error(`404 ${url}`);
      urlOf.set(b, url);
      return b;
    },
    warn: (msg) => h.warnings!.push(msg),
  });
  return h as Harness;
}

/** Register a cue with `n` variants, all of which load and decode fine. */
function ok(h: Harness, cue: AudioCue, n: number, durations = 0.1): void {
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const url = `${cue}_${i}.mp3`;
    urls.push(url);
    h.bytes.set(url, new ArrayBuffer(4 + i));
    h.decoded.set(url, fakeBuffer(durations));
  }
  assets.set(cue, urls);
}

beforeEach(() => {
  assets.clear();
});

describe('SampleBank', () => {
  it('loads and exposes every variant, in order', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 3);
    await h.bank.load();
    expect(h.bank.loadedCues).toBe(1);
    expect(h.bank.loadedVariants).toBe(3);
    expect(h.bank.variantsOf('sfx.unit.hit')).toHaveLength(3);
    expect(h.reads).toEqual(['sfx.unit.hit_0.mp3', 'sfx.unit.hit_1.mp3', 'sfx.unit.hit_2.mp3']);
  });

  it('skips cues with no assets entirely — no read, no warning', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 1);
    await h.bank.load();
    // Every other cue in the union has no urls; none of them may produce a request.
    expect(h.reads).toHaveLength(1);
    expect(h.warnings).toEqual([]);
    expect(h.bank.variantsOf('sfx.card.play')).toBeUndefined();
    expect(cuesWithSamples()).toEqual(['sfx.unit.hit']);
  });

  it('a failed READ costs that variant, not the cue', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 3);
    h.bytes.delete('sfx.unit.hit_1.mp3'); // 404
    await h.bank.load();
    // 2 of 3 → the cue still plays, with two-way variation instead of nothing.
    expect(h.bank.variantsOf('sfx.unit.hit')).toHaveLength(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('sfx.unit.hit_1.mp3');
  });

  it('a failed DECODE costs that variant too', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 2);
    h.decoded.set('sfx.unit.hit_0.mp3', new Error('corrupt'));
    await h.bank.load();
    expect(h.bank.variantsOf('sfx.unit.hit')).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
  });

  it('a cue whose every file fails is ABSENT, not empty — the mixer reads that as "use synth"', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 2);
    h.bytes.clear();
    await h.bank.load();
    // An empty array would also make CueMixer fall through, but absence is what the retry logic
    // keys on; storing [] would make the cue look loaded and never retry.
    expect(h.bank.variantsOf('sfx.unit.hit')).toBeUndefined();
    expect(h.bank.loadedCues).toBe(0);
  });

  it('never rejects, whatever fails', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 2);
    ok(h, 'sfx.card.play', 2);
    h.bytes.clear();
    h.decoded.clear();
    await expect(h.bank.load()).resolves.toBeUndefined();
  });

  it('a second load retries ONLY what has nothing loaded', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 1);
    ok(h, 'sfx.card.play', 1);
    h.bytes.delete('sfx.card.play_0.mp3'); // this one fails the first time
    await h.bank.load();
    expect(h.bank.loadedCues).toBe(1);

    // Network came back.
    h.reads.length = 0;
    h.bytes.set('sfx.card.play_0.mp3', new ArrayBuffer(4));
    await h.bank.load();
    expect(h.reads).toEqual(['sfx.card.play_0.mp3']);
    expect(h.bank.loadedCues).toBe(2);
  });

  it('a concurrent load JOINS the in-flight one instead of doubling the requests', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 2);
    const a = h.bank.load();
    const b = h.bank.load();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(h.reads).toHaveLength(2);
  });

  it('releases the in-flight handle so a later retry can run', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 1);
    h.bytes.clear();
    await h.bank.load();
    // If `inFlight` were not cleared in a finally, this second call would resolve instantly
    // against the old promise and never retry — a failure that only shows up as "audio never
    // recovers after a flaky boot".
    h.bytes.set('sfx.unit.hit_0.mp3', new ArrayBuffer(4));
    h.decoded.set('sfx.unit.hit_0.mp3', fakeBuffer(0.1));
    await h.bank.load();
    expect(h.bank.loadedCues).toBe(1);
  });

  it('counts variants across cues', async () => {
    const h = harness();
    ok(h, 'sfx.unit.hit', 3);
    ok(h, 'sfx.card.play', 2);
    await h.bank.load();
    expect(h.bank.loadedCues).toBe(2);
    expect(h.bank.loadedVariants).toBe(5);
  });
});
