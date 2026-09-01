import { describe, it, expect, vi } from 'vitest';

// **A second track, mocked in.** `MusicTrack` has exactly one member today — `bgm.battle` has no
// master, and `types.ts` explains why an absent track must not be present-and-empty. But two
// decks exist FOR the transition between two tracks, so the alternative to a mock here is to
// leave the track-change half of this player untested until a second master arrives, and then
// discover its bugs by ear. The mock keeps the real `bgm.lobby` entry untouched and adds one
// beside it; nothing else the file asserts (envelope shape, wrap timing, duck ramps) depends on
// which tracks exist.
vi.mock('../../src/audio/musicCatalogue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/audio/musicCatalogue')>();
  return {
    ...real,
    MUSIC_CATALOGUE: {
      ...real.MUSIC_CATALOGUE,
      'bgm.battle': { path: '/test/bgm-battle.mp3', lengthS: 60.0, gain: 1.0 },
    },
  };
});

import { MusicPlayer, type MusicDeck } from '../../src/audio/MusicPlayer';
import { MUSIC_CATALOGUE, XFADE_S } from '../../src/audio/musicCatalogue';
import type { MusicTrack } from '../../src/audio/types';

// `MusicPlayer` is the one part of the BGM step that can be wrong SILENTLY. A deck that never
// starts is obvious (no music); a crossfade that dips 3 dB in the middle, a wrap that fires two
// seconds off the seam it was measured for, or a duck that never releases all sound like "the
// music is a bit odd" rather than like a bug — and none of them is visible to `audit.py` (which
// measures files), to `musicAssets.test.ts` (which measures bytes), or to a screenshot.
//
// So every case below asserts a NUMBER or an ORDER, not "it did something".

const LOBBY: MusicTrack = 'bgm.lobby';
/** Only reachable through the mock above — hence the cast rather than a union member. */
const BATTLE = 'bgm.battle' as unknown as MusicTrack;

interface Call { fn: string; arg?: unknown }

/** A deck that records what was asked of it and reports whatever position the test sets. */
class FakeDeck implements MusicDeck {
  readonly calls: Call[] = [];
  gain = 0;
  playing = false;
  paused = false;
  src: string | null = null;
  pos: number | null = null;
  /** Set to a method name to make that method throw once — the containment cases. */
  throwOn: string | null = null;

  private maybeThrow(fn: string): void {
    if (this.throwOn === fn) {
      this.throwOn = null;
      throw new Error(`deck blew up in ${fn}`);
    }
  }

  play(path: string): void {
    this.calls.push({ fn: 'play', arg: path });
    this.maybeThrow('play');
    this.src = path;
    this.playing = true;
    this.pos = 0;
  }

  setGain(level: number): void {
    this.maybeThrow('setGain');
    this.gain = level;
  }

  stop(): void {
    this.calls.push({ fn: 'stop' });
    this.maybeThrow('stop');
    this.playing = false;
    this.pos = null;
  }

  position(): number | null {
    return this.playing ? this.pos : null;
  }

  setPaused(paused: boolean): void {
    this.calls.push({ fn: 'setPaused', arg: paused });
    this.maybeThrow('setPaused');
    this.paused = paused;
  }
}

function makePlayer(): {
  player: MusicPlayer; decks: [FakeDeck, FakeDeck]; warns: string[];
} {
  const decks: [FakeDeck, FakeDeck] = [new FakeDeck(), new FakeDeck()];
  const warns: string[] = [];
  const player = new MusicPlayer({ decks, warn: (m) => warns.push(m) });
  player.setBusVolume(1); // the mix knob is tested on its own below; 1 keeps the others readable
  return { player, decks, warns };
}

/** Run `ms` of frames at 16 ms each, asking for `track` every frame (the real caller's shape). */
function run(player: MusicPlayer, track: MusicTrack | null, ms: number, step = 16): void {
  for (let t = 0; t < ms; t += step) player.update(track, step);
}

const XFADE_MS = XFADE_S * 1000;

describe('MusicPlayer — starting from silence', () => {
  it('starts the first deck on the requested track and leaves the second alone', () => {
    const { player, decks } = makePlayer();
    player.update(LOBBY, 16);
    expect(decks[0].calls[0]).toEqual({ fn: 'play', arg: MUSIC_CATALOGUE[LOBBY].path });
    expect(decks[1].calls).toEqual([]);
    expect(player.current).toBe(LOBBY);
  });

  it('reaches the track gain by the end of the crossfade and not before', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS / 2);
    // Equal-power: halfway is sin(pi/4) = 0.707, NOT 0.5. A linear pair would read 0.5 here and
    // would dip ~3 dB in the middle of every fade — heard once per loop, forever.
    expect(decks[0].gain).toBeCloseTo(Math.SQRT1_2, 1);
    run(player, LOBBY, XFADE_MS / 2 + 32);
    expect(decks[0].gain).toBeCloseTo(MUSIC_CATALOGUE[LOBBY].gain, 5);
    expect(player.isCrossfading).toBe(false);
  });

  it('asking for the track that is already playing is a no-op (the property the caller relies on)',
    () => {
      const { player, decks } = makePlayer();
      run(player, LOBBY, XFADE_MS + 64);
      const playsBefore = decks[0].calls.filter((c) => c.fn === 'play').length;
      run(player, LOBBY, 500);
      expect(decks[0].calls.filter((c) => c.fn === 'play').length).toBe(playsBefore);
    });
});

describe('MusicPlayer — changing track', () => {
  it('crossfades onto the other deck and stops the outgoing one when it settles', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    player.update(BATTLE, 16);
    expect(decks[1].calls[0]).toEqual({ fn: 'play', arg: MUSIC_CATALOGUE[BATTLE].path });
    expect(decks[0].playing).toBe(true); // still playing out its tail

    run(player, BATTLE, XFADE_MS / 2);
    // Both audible at once, summing to unity in power.
    expect(decks[0].gain ** 2 + decks[1].gain ** 2).toBeCloseTo(1, 1);

    run(player, BATTLE, XFADE_MS / 2 + 64);
    expect(decks[1].gain).toBeCloseTo(MUSIC_CATALOGUE[BATTLE].gain, 5);
    // Stopped, not merely faded to 0: a media element held at gain 0 keeps decoding, which on a
    // phone is battery spent on something inaudible.
    expect(decks[0].playing).toBe(false);
    expect(decks[0].calls.some((c) => c.fn === 'stop')).toBe(true);
  });

  it('a change arriving MID-crossfade reuses the deck that was fading out', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);          // lobby on deck 0
    run(player, BATTLE, XFADE_MS / 4);          // fading 0 -> 1
    player.update(LOBBY, 16);                   // back again, still mid-fade
    // Deck 0 is the one still draining, so it is the one taken — and it is hard-stopped first so
    // it cannot be left at a non-zero level with nothing driving it.
    expect(decks[0].calls.filter((c) => c.fn === 'play').length).toBe(2);
    run(player, LOBBY, XFADE_MS + 64);
    expect(player.current).toBe(LOBBY);
    expect(decks[0].gain).toBeCloseTo(MUSIC_CATALOGUE[LOBBY].gain, 5);
    expect(decks[1].playing).toBe(false);
  });

  it('null fades to silence and then stops the deck', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    run(player, null, XFADE_MS + 64);
    expect(player.current).toBeNull();
    expect(decks[0].playing).toBe(false);
    expect(decks[0].gain).toBe(0);
  });
});

describe('MusicPlayer — closing the loop', () => {
  it('wraps onto the other deck with the SAME file, XFADE_S before the end', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    const len = MUSIC_CATALOGUE[LOBBY].lengthS;

    // Just short of the seam: nothing happens.
    decks[0].pos = len - XFADE_S - 0.1;
    player.update(LOBBY, 16);
    expect(decks[1].calls).toEqual([]);

    // At the seam: the other deck starts the same path from 0.
    decks[0].pos = len - XFADE_S;
    player.update(LOBBY, 16);
    expect(decks[1].calls[0]).toEqual({ fn: 'play', arg: MUSIC_CATALOGUE[LOBBY].path });
    expect(player.isCrossfading).toBe(true);
  });

  it('reads the wrap off the deck rather than counting frames', () => {
    // The distinction that matters: 10 minutes of frames go by, but the deck says it is at 3 s,
    // so no wrap. An accumulated clock would have wrapped ten times by now — and it would drift
    // silently on every stalled frame, backgrounded tab and audio interruption.
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    decks[0].pos = 3;
    run(player, LOBBY, 600_000);
    expect(decks[1].calls).toEqual([]);
  });

  it('does not wrap while a crossfade is already in flight', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    decks[0].pos = MUSIC_CATALOGUE[LOBBY].lengthS;   // past the seam
    run(player, BATTLE, 32);                          // ...but a track change is under way
    expect(decks[1].calls.filter((c) => c.fn === 'play')
      .every((c) => c.arg === MUSIC_CATALOGUE[BATTLE].path)).toBe(true);
  });

  it('a deck that reports no position never triggers a wrap', () => {
    // The frames before a stream starts are indistinguishable from "not playing", and both mean
    // "no wrap decision can be made yet". Treating null as 0 would be harmless; treating it as
    // "past the end" would restart the bed every frame.
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    decks[0].playing = false;   // position() -> null
    run(player, LOBBY, 5000);
    expect(decks[1].calls).toEqual([]);
  });
});

describe('MusicPlayer — ducking', () => {
  it('drops toward the duck level, holds, and comes all the way back to 1', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    const full = decks[0].gain;

    player.requestDuck();
    run(player, LOBBY, 96);                     // past the 80 ms attack
    expect(player.duckLevel).toBeCloseTo(0.45, 2);
    expect(decks[0].gain).toBeCloseTo(full * 0.45, 3);

    // Still held 400 ms in (the longest triggering cue is ~400 ms).
    run(player, LOBBY, 300);
    expect(player.duckLevel).toBeCloseTo(0.45, 2);

    // Released, and all the way back — a duck that settles at 0.99 is a bed quietly 0.1 dB low
    // forever, which is exactly the kind of thing nothing else would report.
    run(player, LOBBY, 200 + 700 + 64);
    expect(player.duckLevel).toBe(1);
    expect(decks[0].gain).toBeCloseTo(full, 5);
  });

  it('release is slower than attack', () => {
    // Not a style preference: a fast recovery is itself an audible event, and the entire point of
    // ducking is that nobody notices the bed moved.
    const { player } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    player.requestDuck();
    let downFrames = 0;
    while (player.duckLevel > 0.46 && downFrames < 1000) { player.update(LOBBY, 16); downFrames++; }
    run(player, LOBBY, 500);                    // let the hold expire
    let upFrames = 0;
    while (player.duckLevel < 1 && upFrames < 1000) { player.update(LOBBY, 16); upFrames++; }
    expect(upFrames).toBeGreaterThan(downFrames * 3);
  });

  it('repeated requests re-arm the hold instead of stacking the attenuation', () => {
    // A ten-pull reveal must not press the bed ten times further down.
    const { player } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    for (let i = 0; i < 10; i++) { player.requestDuck(); player.update(LOBBY, 16); }
    run(player, LOBBY, 200);
    expect(player.duckLevel).toBeCloseTo(0.45, 2);
    expect(player.duckLevel).toBeGreaterThanOrEqual(0.45);
  });
});

describe('MusicPlayer — bus volume and pausing', () => {
  it('multiplies the bus volume into the deck gain', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    player.setBusVolume(0.5);
    player.update(LOBBY, 16);
    expect(decks[0].gain).toBeCloseTo(MUSIC_CATALOGUE[LOBBY].gain * 0.5, 5);
    player.setBusVolume(0);
    player.update(LOBBY, 16);
    expect(decks[0].gain).toBe(0);
  });

  it('a paused player advances nothing at all — including the wrap check', () => {
    // The wrap especially: a paused deck's position stands still, so a decision made while held
    // would fire the instant it is released, on stale evidence.
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    player.setPaused(true);
    expect(decks[0].calls.some((c) => c.fn === 'setPaused' && c.arg === true)).toBe(true);
    expect(decks[1].calls.some((c) => c.fn === 'setPaused' && c.arg === true)).toBe(true);

    decks[0].pos = MUSIC_CATALOGUE[LOBBY].lengthS;
    run(player, BATTLE, 5000);
    expect(decks[1].calls.filter((c) => c.fn === 'play')).toEqual([]);
    expect(player.current).toBe(LOBBY);

    player.setPaused(false);
    player.update(BATTLE, 16);
    expect(player.current).toBe(BATTLE);
  });

  it('setPaused is idempotent', () => {
    const { player, decks } = makePlayer();
    player.setPaused(true);
    player.setPaused(true);
    expect(decks[0].calls.filter((c) => c.fn === 'setPaused').length).toBe(1);
  });

  it('stop() clears everything and silences both decks', () => {
    const { player, decks } = makePlayer();
    run(player, LOBBY, XFADE_MS + 64);
    player.stop();
    expect(player.current).toBeNull();
    expect(player.isCrossfading).toBe(false);
    expect(decks[0].playing).toBe(false);
    expect(decks[1].playing).toBe(false);
  });
});

describe('MusicPlayer — a broken deck must not take the frame with it', () => {
  // This runs on `app.ticker`, AHEAD of PIXI's renderer listener: in PIXI 7 a throw from any
  // ticker listener aborts the update loop and stops scheduling `requestAnimationFrame`, i.e. the
  // canvas freezes permanently until a reload (`SceneManager.tickScene`'s own header records that
  // report). Every deck call is therefore contained, and each one is checked here rather than
  // trusting that the try/catch "is there".
  for (const fn of ['play', 'setGain', 'stop', 'setPaused'] as const) {
    it(`contains a deck that throws in ${fn}(), and says so once`, () => {
      const { player, decks, warns } = makePlayer();
      if (fn === 'stop' || fn === 'setGain') run(player, LOBBY, XFADE_MS + 64);
      decks[0].throwOn = fn;
      expect(() => {
        player.update(LOBBY, 16);
        if (fn === 'stop') player.stop();
        if (fn === 'setPaused') player.setPaused(true);
      }).not.toThrow();
      expect(warns.length).toBeGreaterThan(0);
    });
  }

  it('falls back to console.warn when no warn dep is given', () => {
    const decks: [FakeDeck, FakeDeck] = [new FakeDeck(), new FakeDeck()];
    const player = new MusicPlayer({ decks });
    decks[0].throwOn = 'play';
    expect(() => player.update(LOBBY, 16)).not.toThrow();
  });
});
