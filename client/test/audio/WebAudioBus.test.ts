// `platform/web/WebAudioBus.ts` — the web/CrazyGames/Capacitor-iOS half of the audio backend.
//
// **These are its first cases.** `ContextAudioBus.test.ts`'s header explains why there were none:
// the logic was extracted into `src/audio/**` (inside the coverage gate) on 2026-08-31, leaving
// behind "~15 lines answering two questions" that nobody gated. Measured 2026-09-02: this file was
// 0% in BOTH the unit suite and test:ui, and so was its WeChat twin. `vitest.config.ts` had already
// written down what that costs — it gated the two music DECKS because each carries a branch that
// fails silently — but the two BUSES got the same treatment they were arguing against, and they are
// no longer 15 lines answering two questions: they answer FOUR (context, gesture, decks, focus),
// and three of those four have a silent-failure branch:
//
//   * `webkitAudioContext` unreachable = every pre-Safari-14 / old-WKWebView device is mute.
//   * `createMusicDecks` returning decks when it should return `null` = a WebAudio graph fed by a
//     `MediaElementSource` that never loads, i.e. silence with nothing logged anywhere.
//   * the focus seam reporting the WRONG initial value = a bed that plays into a background tab.
//
// So every case below asserts on the recorded graph / listener set, never on "it didn't throw" —
// which is equally true of a backend that builds nothing at all.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebAudioBus } from '../../src/platform/web/WebAudioBus';
import { fakeAudioContext, type FakeAudioContext } from './fakeAudioContext';

// ── host doubles ──────────────────────────────────────────────────────────────────────────────
//
// `WebAudioBus` reads five globals and nothing else, which is exactly why it is only 27 lines.
// Each double below is the smallest surface the file actually touches; anything wider would let a
// case pass against a shape the real browser never hands over.

interface Registered {
  type: string;
  cb: (arg?: unknown) => void;
  opts?: AddEventListenerOptions;
}

function listenerHost(): { events: Registered[]; addEventListener: (t: string, cb: (a?: unknown) => void, o?: AddEventListenerOptions) => void; fire: (t: string) => void } {
  const events: Registered[] = [];
  return {
    events,
    addEventListener: (type, cb, opts) => { events.push({ type, cb, opts }); },
    fire: (type) => { for (const e of events) if (e.type === type) e.cb(); },
  };
}

/** The slice of `HTMLAudioElement` a `WebMusicDeck` drives. */
class FakeAudio {
  src = '';
  crossOrigin: string | null = null;
  preload = '';
  loop = true;
  currentTime = 0;
  error: unknown = null;
  playCalls = 0;
  pauseCalls = 0;
  addEventListener(): void { /* the deck's own 'error' listener */ }
  play(): Promise<void> { this.playCalls++; return Promise.resolve(); }
  pause(): void { this.pauseCalls++; }
}

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;
const OWNED = ['AudioContext', 'webkitAudioContext', 'window', 'document', 'Audio'] as const;

/**
 * `new Ctor()` where the constructor RETURNS an object hands back that object — so one shared fake
 * context can stand in for the class `WebAudioBus` instantiates, and the test still sees how many
 * times it was constructed (`ensure()` promises to construct at most one).
 */
function ctxClass(ctx: FakeAudioContext | null, log: { built: number }): unknown {
  return function AudioContextStub(): unknown {
    log.built++;
    if (!ctx) throw new Error('host claims AudioContext but constructing it throws');
    return ctx;
  };
}

describe('WebAudioBus', () => {
  let ctx: FakeAudioContext;
  let built: { built: number };
  let win: ReturnType<typeof listenerHost>;
  let doc: ReturnType<typeof listenerHost> & { hidden: boolean };
  let audios: FakeAudio[];

  beforeEach(() => {
    ctx = fakeAudioContext();
    ctx.state = 'suspended'; // what a real browser hands over before the first gesture
    built = { built: 0 };
    win = listenerHost();
    doc = Object.assign(listenerHost(), { hidden: false });
    audios = [];
    g.AudioContext = ctxClass(ctx, built);
    g.window = win;
    g.document = doc;
    g.Audio = class { constructor() { const a = new FakeAudio(); audios.push(a); return a as unknown as FakeAudio; } };
  });

  afterEach(() => {
    for (const k of OWNED) delete g[k];
  });

  // ── context: where the AudioContext comes from ──────────────────────────────────────────────

  describe('the context', () => {
    it('uses the standard AudioContext, and builds it exactly once', () => {
      const bus = new WebAudioBus();
      // Construction itself must touch nothing: `ensure()` is lazy so that a host without audio
      // never pays for it, and so that a bus built at module load does not race the entry point.
      expect(built.built).toBe(0);
      bus.resume();
      bus.resume();
      bus.play('sfx.ui.tap');
      expect(built.built).toBe(1);
    });

    it('falls back to webkitAudioContext (Safari < 14, old WKWebView in the Capacitor shell)', () => {
      delete g.AudioContext;
      g.webkitAudioContext = ctxClass(ctx, built);
      new WebAudioBus().resume();
      expect(built.built).toBe(1);
      expect(ctx.resumeCalls).toBe(1);
    });

    it('goes mute — not throwing — when the host has neither (SSR, node, ancient WebView)', () => {
      delete g.AudioContext;
      const bus = new WebAudioBus();
      expect(() => { bus.resume(); bus.play('sfx.ui.tap'); bus.setSfxVolume(0.3); }).not.toThrow();
      // The point of the case: nothing was BUILT. "Did not throw" is also true of a bus that
      // silently constructed a graph nobody can hear.
      expect(ctx.nodes).toHaveLength(0);
      expect(bus.loaded).toEqual({ cues: 0, variants: 0 });
    });

    it('goes mute when the host claims AudioContext but constructing it throws (base-lib shims)', () => {
      g.AudioContext = ctxClass(null, built);
      const bus = new WebAudioBus();
      expect(() => bus.play('sfx.ui.tap')).not.toThrow();
      expect(built.built).toBe(1);
      // ...and it does not retry every frame: `play()` runs on the render clock.
      bus.play('sfx.ui.tap');
      bus.play('sfx.ui.tap');
      expect(built.built).toBe(1);
    });
  });

  // ── gesture: the autoplay gate ──────────────────────────────────────────────────────────────

  describe('the autoplay gate', () => {
    it('listens on window for all three gesture kinds, every one of them passive', () => {
      new WebAudioBus();
      expect(win.events.map((e) => e.type)).toEqual(['pointerdown', 'keydown', 'touchstart']);
      // `passive` is load-bearing, not tidiness: a non-passive touchstart on window makes the
      // browser wait for this handler before it may scroll, on every touch for the whole session.
      expect(win.events.every((e) => e.opts?.passive === true)).toBe(true);
    });

    it('any one of the three unlocks the suspended context', () => {
      new WebAudioBus();
      expect(ctx.resumeCalls).toBe(0);
      win.fire('touchstart');
      expect(ctx.resumeCalls).toBe(1);
      expect(ctx.state).toBe('running');
    });

    it('window on the gesture seam, NOT InputManager: a tap the game discards still unlocks', () => {
      // This is the design note in the file made checkable. `InputManager` gates pointer events
      // during scene fades and while a modal is up; the autoplay gate only needs "the user has
      // touched the page", so it takes the strictly wider set — a tap swallowed by a fade is one
      // the gate must still see. The observable form: the bus registers on the raw host surface
      // and nowhere else.
      new WebAudioBus();
      expect(win.events).toHaveLength(3);
      expect(doc.events.filter((e) => e.type !== 'visibilitychange')).toHaveLength(0);
    });

    it('constructs without a window (SSR / node) instead of throwing at import time', () => {
      delete g.window;
      expect(() => new WebAudioBus()).not.toThrow();
    });
  });

  // ── music decks ─────────────────────────────────────────────────────────────────────────────

  describe('the BGM decks', () => {
    /** Get the bus past the autoplay gate and run one frame of `updateMusic`. */
    function startBgm(bus: WebAudioBus): void {
      win.fire('pointerdown');
      bus.updateMusic('bgm.lobby', 16);
    }

    it('builds TWO independent decks, each with its own element and gain into destination', () => {
      const bus = new WebAudioBus();
      startBgm(bus);
      // Two, because a crossfade has two ends (MusicPlayer's `decks` is a 2-tuple by type).
      expect(audios).toHaveLength(2);
      expect(ctx.mediaElements).toEqual(audios);
      const deckGains = ctx.of('gain').filter((n) => n.out.includes(ctx.destination));
      // One bus gain for SFX + one per deck, all landing on destination.
      expect(deckGains.length).toBeGreaterThanOrEqual(3);
      // Distinct elements, not the same one twice — a shared element would make the crossfade a cut.
      expect(audios[0]).not.toBe(audios[1]);
      // And the bed actually started.
      expect(audios.some((a) => a.playCalls > 0)).toBe(true);
    });

    it('no BGM before the first gesture — the gate is the gesture, not ctx.state', () => {
      const bus = new WebAudioBus();
      bus.updateMusic('bgm.lobby', 16);
      expect(audios).toHaveLength(0);
    });

    it('no BGM when the host has no Audio constructor, and updateMusic stays a no-op', () => {
      delete g.Audio;
      const bus = new WebAudioBus();
      win.fire('pointerdown');
      expect(() => bus.updateMusic('bgm.lobby', 16)).not.toThrow();
      expect(ctx.mediaElements).toHaveLength(0);
      // Tried once, then latched off: this runs every frame on the ticker.
      bus.updateMusic('bgm.lobby', 16);
      expect(ctx.mediaElements).toHaveLength(0);
    });

    it('no BGM without an AudioContext either — the web deck NEEDS it (iOS volume is read-only)', () => {
      // Worth stating next to its WeChat twin, which is the exact opposite: there,
      // `createMusicDecks` ignores the context, so a base-lib < 2.19.0 device loses SFX but keeps
      // music. Here the same host condition costs both, and that asymmetry is the whole reason
      // `createMusicDecks` is handed a nullable ctx (see `ContextAudioBusDeps`).
      delete g.AudioContext;
      const bus = new WebAudioBus();
      win.fire('pointerdown');
      expect(() => bus.updateMusic('bgm.lobby', 16)).not.toThrow();
      expect(audios).toHaveLength(0);
    });
  });

  // ── focus ───────────────────────────────────────────────────────────────────────────────────

  describe('pause on blur', () => {
    /** Get the bed running so there is something for a focus change to act on. */
    function running(bus: WebAudioBus): FakeAudio {
      win.fire('pointerdown');
      bus.updateMusic('bgm.lobby', 16);
      const el = audios.find((a) => a.playCalls > 0);
      expect(el).toBeDefined();
      return el as FakeAudio;
    }

    it('listens for visibilitychange, not blur', () => {
      new WebAudioBus();
      // `blur` also fires for opening devtools or focusing another window — the game is still
      // visible then, and stopping the music only reads as broken.
      expect(doc.events.map((e) => e.type)).toEqual(['visibilitychange']);
    });

    it('backgrounding holds the bed; coming back releases it', () => {
      const bus = new WebAudioBus();
      const el = running(bus);
      const playsBefore = el.playCalls;

      doc.hidden = true;
      doc.fire('visibilitychange');
      expect(el.pauseCalls).toBe(1);

      doc.hidden = false;
      doc.fire('visibilitychange');
      expect(el.playCalls).toBe(playsBefore + 1);
    });

    it('a hold freezes the envelope: no wrap decision is taken on stale evidence', () => {
      const bus = new WebAudioBus();
      const el = running(bus);
      doc.hidden = true;
      doc.fire('visibilitychange');
      // 74s track, 2s crossfade: enough frames to cross the wrap seam several times over if the
      // clock kept advancing while held.
      for (let i = 0; i < 6000; i++) bus.updateMusic('bgm.lobby', 16);
      expect(el.playCalls).toBe(1);
      expect(el.pauseCalls).toBe(1);
    });

    it('a page that LOADS in a background tab stays silent', () => {
      // The hole the `cb(document.hidden)` line at the end of `onFocusChange` exists to close:
      // `visibilitychange` only fires on a CHANGE, and a page can finish loading in a hidden tab
      // (ctrl-clicked link, "open all bookmarks", session restore) with no event ever coming to
      // correct it — switching TO the tab reports `visible`, not `hidden`.
      //
      // Reporting the value at install time is not enough on its own: at that moment
      // `ContextAudioBus.music` is still null (the player is built lazily by `ensureMusic`), so
      // the callback's `this.music?.setPaused(hidden)` had nowhere to land and the value was
      // dropped. The bus therefore has to REMEMBER it and apply it to the player it builds later.
      doc.hidden = true;
      const bus = new WebAudioBus();
      // A gesture is unlikely in a hidden tab, but it is not impossible (a keydown reaches a
      // background tab in some window managers), and the gate must not be the only thing standing
      // between a background tab and an audible bed.
      win.fire('keydown');
      bus.updateMusic('bgm.lobby', 16);
      expect(audios.every((a) => a.playCalls === 0)).toBe(true);

      // ...and it releases on the first real switch to the foreground.
      doc.hidden = false;
      doc.fire('visibilitychange');
      bus.updateMusic('bgm.lobby', 16);
      expect(audios.some((a) => a.playCalls > 0)).toBe(true);
    });

    it('constructs without a document instead of throwing', () => {
      delete g.document;
      expect(() => new WebAudioBus()).not.toThrow();
    });
  });
});
