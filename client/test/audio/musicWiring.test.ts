import { describe, it, expect } from 'vitest';
import { ContextAudioBus, DEFAULT_MUSIC_VOLUME } from '../../src/audio/ContextAudioBus';
import { DUCK_CUES, MUSIC_CATALOGUE } from '../../src/audio/musicCatalogue';
import type { MusicDeck } from '../../src/audio/MusicPlayer';
import type { AudioCue } from '../../src/audio/types';

// How the BGM runtime is wired into the bus — the seams where a platform question is asked and
// where the two gates (autoplay, focus) live. None of this is reachable from `MusicPlayer.test.ts`
// (which knows nothing about contexts or cues) and all of it fails quietly: a bed that never
// starts, a duck that never fires, a bed that keeps running in the background.

class StubDeck implements MusicDeck {
  played: string[] = [];
  gain = 0;
  paused: boolean | null = null;
  pos: number | null = null;
  play(path: string): void { this.played.push(path); this.pos = 0; }
  setGain(level: number): void { this.gain = level; }
  stop(): void { this.pos = null; }
  position(): number | null { return this.pos; }
  setPaused(paused: boolean): void { this.paused = paused; }
}

interface Harness {
  bus: ContextAudioBus;
  decks: [StubDeck, StubDeck];
  gesture: () => void;
  focus: (hidden: boolean) => void;
  ctxSeenByDecks: (AudioContext | null)[];
  deckCalls: number;
  warns: string[];
}

function harness(opts: {
  context?: AudioContext | null;
  decks?: 'stub' | 'none' | 'throw';
  withGesture?: boolean;
} = {}): Harness {
  const decks: [StubDeck, StubDeck] = [new StubDeck(), new StubDeck()];
  const ctxSeenByDecks: (AudioContext | null)[] = [];
  const warns: string[] = [];
  let gestureCb = (): void => {};
  let focusCb = (_hidden: boolean): void => {};
  const h = {
    decks, ctxSeenByDecks, warns, deckCalls: 0,
    gesture: () => gestureCb(),
    focus: (hidden: boolean) => focusCb(hidden),
  } as Harness;
  h.bus = new ContextAudioBus({
    createContext: () => opts.context ?? null,
    ...(opts.withGesture === false ? {} : { onGesture: (cb) => { gestureCb = cb; } }),
    onFocusChange: (cb) => { focusCb = cb; },
    warn: (m) => warns.push(m),
    createMusicDecks: (ctx) => {
      h.deckCalls++;
      ctxSeenByDecks.push(ctx);
      if (opts.decks === 'none') return null;
      if (opts.decks === 'throw') throw new Error('no音频设备');
      return decks;
    },
  });
  return h;
}

describe('ContextAudioBus — the BGM autoplay gate', () => {
  it('plays nothing before a gesture, and starts the bed on the very next frame after one', () => {
    const h = harness();
    h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].played).toEqual([]);
    expect(h.deckCalls).toBe(0);          // not even asked for — no decks are built speculatively

    h.gesture();
    h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].played).toEqual([MUSIC_CATALOGUE['bgm.lobby'].path]);
  });

  it('treats a host with no gesture source as already unlocked', () => {
    // SSR, node, the e2e entry: those contexts start `running`, so waiting for a gesture that can
    // never arrive would just be permanent silence.
    const h = harness({ withGesture: false });
    h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].played.length).toBe(1);
  });
});

describe('ContextAudioBus — asking the platform for decks', () => {
  it('hands the deck factory a null context and still takes the decks it returns', () => {
    // This is the property the WeChat half depends on: `InnerAudioContext` needs no audio graph,
    // so a base library without `createWebAudioContext` loses the SFX samples, NOT the music.
    const h = harness({ context: null });
    h.gesture();
    h.bus.updateMusic('bgm.lobby', 16);
    expect(h.ctxSeenByDecks).toEqual([null]);
    expect(h.decks[0].played.length).toBe(1);
  });

  it('a host that declines decks gets silence, and is asked exactly once', () => {
    const h = harness({ decks: 'none' });
    h.gesture();
    for (let i = 0; i < 100; i++) h.bus.updateMusic('bgm.lobby', 16);
    expect(h.deckCalls).toBe(1);
  });

  it('a deck factory that throws is contained, warned once, and not retried', () => {
    const h = harness({ decks: 'throw' });
    h.gesture();
    expect(() => { for (let i = 0; i < 50; i++) h.bus.updateMusic('bgm.lobby', 16); })
      .not.toThrow();
    expect(h.deckCalls).toBe(1);
    expect(h.warns.length).toBe(1);
  });

  it('omitting the deck factory entirely is silence, not a crash', () => {
    const bus = new ContextAudioBus({ createContext: () => null });
    expect(() => bus.updateMusic('bgm.lobby', 16)).not.toThrow();
  });
});

describe('ContextAudioBus — music volume', () => {
  it('starts at the documented default and reaches the decks', () => {
    const h = harness();
    h.gesture();
    for (let i = 0; i < 200; i++) h.bus.updateMusic('bgm.lobby', 16); // settle the fade
    expect(DEFAULT_MUSIC_VOLUME).toBe(0.5);
    expect(h.decks[0].gain).toBeCloseTo(MUSIC_CATALOGUE['bgm.lobby'].gain * 0.5, 5);
  });

  it('a volume set BEFORE the player exists still applies once it does', () => {
    // The real order: `installAudioSettings` pushes the stored volume during boot, long before the
    // first gesture builds the decks. Dropping it there would leave every returning player on the
    // default until they touched the slider again.
    const h = harness();
    h.bus.setMusicVolume(0.25);
    h.gesture();
    for (let i = 0; i < 200; i++) h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].gain).toBeCloseTo(MUSIC_CATALOGUE['bgm.lobby'].gain * 0.25, 5);
  });

  it('clamps out of range values', () => {
    const h = harness();
    h.gesture();
    h.bus.setMusicVolume(5);
    for (let i = 0; i < 200; i++) h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].gain).toBeLessThanOrEqual(1);
    h.bus.setMusicVolume(-3);
    h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].gain).toBe(0);
  });
});

describe('ContextAudioBus — ducking', () => {
  const settle = (h: Harness): void => {
    h.gesture();
    for (let i = 0; i < 200; i++) h.bus.updateMusic('bgm.lobby', 16);
  };

  it('every DUCK_CUES member presses the bed down', () => {
    for (const cue of DUCK_CUES) {
      const h = harness();
      settle(h);
      const full = h.decks[0].gain;
      h.bus.play(cue);
      for (let i = 0; i < 8; i++) h.bus.updateMusic('bgm.lobby', 16);
      expect(h.decks[0].gain, cue).toBeLessThan(full * 0.6);
    }
  });

  it('an ordinary cue does not', () => {
    const h = harness();
    settle(h);
    const full = h.decks[0].gain;
    h.bus.play('sfx.ui.tap' as AudioCue);
    for (let i = 0; i < 8; i++) h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].gain).toBeCloseTo(full, 5);
  });

  it('ducks even though no cue is actually audible here', () => {
    // The check that pins WHERE the duck trigger sits: this harness has no AudioContext, so
    // `play()` returns before the mixer. Ducking reads "what just happened in the game", not
    // "did this one sound come out" — and the bed IS audible, because it runs on the other gate.
    const h = harness({ context: null });
    settle(h);
    const full = h.decks[0].gain;
    h.bus.play('sfx.result.victory');
    for (let i = 0; i < 8; i++) h.bus.updateMusic('bgm.lobby', 16);
    expect(h.decks[0].gain).toBeLessThan(full * 0.6);
  });

  it('is a no-op before any music exists', () => {
    const h = harness();
    expect(() => h.bus.play('sfx.result.draw')).not.toThrow();
  });
});

describe('ContextAudioBus — focus', () => {
  it('holds both decks on hide and releases them on show', () => {
    const h = harness();
    h.gesture();
    h.bus.updateMusic('bgm.lobby', 16);
    h.focus(true);
    expect(h.decks[0].paused).toBe(true);
    expect(h.decks[1].paused).toBe(true);
    h.focus(false);
    expect(h.decks[0].paused).toBe(false);
  });

  it('is harmless before the decks exist', () => {
    const h = harness();
    expect(() => h.focus(true)).not.toThrow();
    expect(h.decks[0].paused).toBeNull();
  });
});
