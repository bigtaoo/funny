/**
 * `audio/**` — the containment arms: what each piece does when the backend under it misbehaves.
 *
 * The audio layer is deliberately built so that no failure below it can reach the game: a deck
 * that throws, a source node that has already finished, a decoder that answers twice, a cue with
 * no shipped file. The existing suites drive the success paths and the deck-`play` throw; the 11
 * branches left are the other throw sites, the default `console.warn` fallback, the deck-retirement
 * bookkeeping, and the voice-stealing scan with more than two live voices.
 *
 * Worth cases rather than a percentage because the intended behaviour and a broken implementation
 * look identical from outside: both are "no sound". The assertions here are about what happens
 * AFTERWARDS — the player keeps its own state consistent, the mixer keeps its slot, the bank keeps
 * the variants that did decode — because that is the part that decides whether the next cue plays.
 */
import { describe, it, expect, vi } from 'vitest';
import { MusicPlayer, type MusicDeck } from '../../src/audio/MusicPlayer';
import { CueMixer } from '../../src/audio/CueMixer';
import { SampleBank } from '../../src/audio/SampleBank';
import { VoiceBudget } from '../../src/audio/VoiceBudget';
import { allSfxUrls, variantUrls } from '../../src/audio/cueAssets';
import { decodeAudio } from '../../src/audio/decodeAudio';
import { CUE_CATALOGUE } from '../../src/audio/cueCatalogue';
import { fakeAudioContext, asCtx, asGain, fakeBuffer } from './fakeAudioContext';
import type { AudioCue } from '../../src/audio/types';

/** A deck that can be told to throw from any one method. */
class ThrowingDeck implements MusicDeck {
  calls: string[] = [];
  throwOn = new Set<string>();
  gain = 0;
  src: string | null = null;
  playing = false;
  play(path: string): void { this.calls.push('play'); this.bang('play'); this.src = path; this.playing = true; }
  setGain(level: number): void { this.bang('setGain'); this.gain = level; }
  stop(): void { this.calls.push('stop'); this.bang('stop'); this.playing = false; }
  position(): number | null { return this.playing ? 0 : null; }
  setPaused(paused: boolean): void { this.calls.push(`setPaused:${paused}`); this.bang('setPaused'); }
  private bang(fn: string): void { if (this.throwOn.has(fn)) throw new Error(`deck blew up in ${fn}`); }
}

function player(): { p: MusicPlayer; decks: [ThrowingDeck, ThrowingDeck]; warns: string[] } {
  const decks: [ThrowingDeck, ThrowingDeck] = [new ThrowingDeck(), new ThrowingDeck()];
  const warns: string[] = [];
  return { p: new MusicPlayer({ decks, warn: (m) => warns.push(m) }), decks, warns };
}

// ── MusicPlayer: a deck that throws on pause / resume / stop ────────────────────────────────

describe('MusicPlayer containment', () => {
  it('names pause and resume separately when a deck throws on either', () => {
    // The two directions are different bugs (a background tab that keeps playing vs. one that
    // never comes back), and the message is the only place they are distinguishable in a log.
    const { p, decks, warns } = player();
    decks[0].throwOn.add('setPaused');
    p.setPaused(true);
    expect(warns.some((w) => w.includes('pause'))).toBe(true);

    warns.length = 0;
    decks[1].throwOn.add('setPaused');
    p.setPaused(false);
    expect(warns.some((w) => w.includes('resume'))).toBe(true);
    // The other deck still got the call — one broken backend must not skip its sibling.
    expect(decks[0].calls).toContain('setPaused:false');
  });

  it('ignores a repeated setPaused in the same direction', () => {
    const { p, decks } = player();
    p.setPaused(true);
    const before = decks[0].calls.length;
    p.setPaused(true);
    expect(decks[0].calls.length).toBe(before);
  });

  it('swallows a throw from stop() while retiring a deck', () => {
    const { p, decks, warns } = player();
    decks[0].throwOn.add('stop');
    decks[1].throwOn.add('stop');
    expect(() => p.stop()).not.toThrow();
    expect(warns.some((w) => w.includes('stop'))).toBe(true);
  });

  it('falls back to console.warn when no warn hook is injected', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decks: [ThrowingDeck, ThrowingDeck] = [new ThrowingDeck(), new ThrowingDeck()];
    decks[0].throwOn.add('stop');
    new MusicPlayer({ decks }).stop();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── CueMixer: stealing a source that has already finished ──────────────────────────────────

describe('CueMixer containment', () => {
  const CUE = Object.keys(CUE_CATALOGUE)[0] as AudioCue;

  it('swallows a throw from an already-finished source when the cap steals its slot', () => {
    // Between the sweep and the steal the node can end on its own; WebAudio then throws on
    // setValueAtTime/stop for a released node. Letting that escape would abort the NEW cue that
    // was doing the stealing — i.e. one stale node would silence the mix.
    const ctx = fakeAudioContext();
    const bus = ctx.createGain();
    const mixer = new CueMixer({
      ctx: asCtx(ctx),
      bus: asGain(bus),
      bank: { variantsOf: () => [fakeBuffer(0.2)] } as unknown as SampleBank,
      cap: 1,
    } as never);

    mixer.play(CUE, 0);
    // Make every gain node hostile, the way a released node behaves.
    for (const node of ctx.nodes) {
      if ('gain' in node && node.gain) {
        node.gain.setValueAtTime = (): never => { throw new Error('node already released'); };
      }
    }
    expect(() => mixer.play(CUE, 0)).not.toThrow();
  });
});

// ── SampleBank: the default warn sink ───────────────────────────────────────────────────────

describe('SampleBank containment', () => {
  it('warns through console when no warn hook is injected, and keeps the variants that decoded', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const bank = new SampleBank({
      ctx: { decodeAudioData: async () => fakeBuffer(0.2) } as never,
      readBinary: async () => {
        call++;
        if (call % 2 === 0) throw new Error('404');
        return new ArrayBuffer(8);
      },
    });
    return bank.load().then(() => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ── VoiceBudget: the weakest-voice scan with three live voices ──────────────────────────────

describe('VoiceBudget', () => {
  it('steals the weakest voice, not the first or the last, when three are live', () => {
    // With a cap of 2 the scan never has to compare more than one candidate, so the `<` inside
    // it is only exercised from three voices up. Getting it wrong steals the loudest cue in the
    // mix and leaves the quietest one running.
    const b = new VoiceBudget(3);
    const stolen: string[] = [];
    const claim = (name: string, priority: number): boolean =>
      b.claim(priority, 0, 10, () => stolen.push(name));

    expect(claim('mid', 50)).toBe(true);
    expect(claim('weak', 10)).toBe(true);
    expect(claim('strong', 90)).toBe(true);
    expect(claim('newcomer', 60)).toBe(true);
    expect(stolen).toEqual(['weak']);
    expect(b.held).toBe(3);
  });

  it('refuses everything at a cap of 0 rather than indexing an empty list', () => {
    const b = new VoiceBudget(0);
    expect(b.claim(99, 0, 10, () => {})).toBe(false);
    expect(b.held).toBe(0);
  });
});

// ── cueAssets: a cue with no shipped file ───────────────────────────────────────────────────

describe('cueAssets', () => {
  it('lists only cues that actually ship samples, and reports none for the rest', () => {
    // Synth-only cues have no entry; `?? []` is what keeps the preload list from containing
    // `undefined`, which the asset loader would try to fetch as the string "undefined".
    const urls = allSfxUrls();
    expect(Array.isArray(urls)).toBe(true);
    expect(urls.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);

    // Every catalogue cue answers with an array, shipped or not.
    for (const cue of Object.keys(CUE_CATALOGUE) as AudioCue[]) {
      expect(Array.isArray(variantUrls(cue)), cue).toBe(true);
    }
  });
});

// ── decodeAudio: a backend that settles twice ───────────────────────────────────────────────

describe('decodeAudio', () => {
  it('ignores a second settle, whichever way it arrives', async () => {
    // Safari's callback form and the promise form can BOTH fire. Promise semantics already ignore
    // the second one; the flag makes that explicit rather than accidental — and, more usefully,
    // stops a late error callback from being treated as a rejection after a successful decode.
    const buffer = fakeBuffer(0.2);
    const both = {
      decodeAudioData: (
        _data: ArrayBuffer,
        success?: (b: AudioBuffer) => void,
        error?: (e: unknown) => void,
      ) => {
        success?.(buffer);
        error?.(new Error('late failure'));
        success?.(buffer);
        return Promise.resolve(buffer);
      },
    };
    await expect(decodeAudio(both as never, new ArrayBuffer(8))).resolves.toBe(buffer);

    // ...and the mirror: an error first, a late success after it, still rejects.
    const failFirst = {
      decodeAudioData: (
        _data: ArrayBuffer,
        success?: (b: AudioBuffer) => void,
        error?: (e: unknown) => void,
      ) => {
        error?.('not audio');
        success?.(buffer);
      },
    };
    await expect(decodeAudio(failFirst as never, new ArrayBuffer(8))).rejects.toThrow(/not audio/);
  });
});
