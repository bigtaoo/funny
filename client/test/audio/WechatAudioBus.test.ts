// `platform/wechat/WechatAudioBus.ts` — the WeChat mini-game half of the audio backend.
//
// Its twin's suite (`WebAudioBus.test.ts`) explains why neither had any cases until 2026-09-02.
// The reason to write this one *separately* rather than parameterise that one: the two backends
// disagree, on purpose, about the single most consequential thing in the file —
//
//   * web: no `AudioContext` => no SFX **and** no BGM (the deck needs the context, because
//     `audioEl.volume` is read-only on iOS Safari).
//   * WeChat: no `wx.createWebAudioContext` (base lib < 2.19.0) => no SFX, but **BGM still plays**,
//     because `InnerAudioContext` has no audio graph and never wanted the context.
//
// That asymmetry is the entire reason `ContextAudioBusDeps.createMusicDecks` is handed a NULLABLE
// context. Half of it was already held: `ContextAudioBus.test.ts` has "hands the deck factory a
// null context and still takes the decks it returns", which is the platform-NEUTRAL half — verified
// 2026-09-02 by mutating `ensureMusic()` to bail on a null context, which reddens ten cases there.
// What no suite held is this backend's half of the same deal: that `createMusicDecks` here ignores
// the context it is given. Mutating it to `if (!ctx) return null` — the "helpful" refactor, and the
// shape the web backend legitimately has — passed everything in the repo before this file existed,
// while taking BGM away from exactly the old, low-end devices WeChat is there to reach.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WechatAudioBus } from '../../src/platform/wechat/WechatAudioBus';
import { fakeAudioContext, type FakeAudioContext } from './fakeAudioContext';

// ── the wx surface this file touches ─────────────────────────────────────────────────────────

/** The slice of `InnerAudioContext` a `WechatMusicDeck` drives. */
class FakeInner {
  src = '';
  loop = true;
  volume = 1;
  currentTime: number = NaN;
  playCalls = 0;
  pauseCalls = 0;
  stopCalls = 0;
  play(): void { this.playCalls++; }
  pause(): void { this.pauseCalls++; }
  stop(): void { this.stopCalls++; }
  onError(): void { /* the deck's own error listener */ }
}

type Hook = 'onTouchStart' | 'onHide' | 'onShow' | 'onAudioInterruptionBegin' | 'onAudioInterruptionEnd';
const HOOKS: Hook[] = ['onTouchStart', 'onHide', 'onShow', 'onAudioInterruptionBegin', 'onAudioInterruptionEnd'];

interface FakeWx {
  hooks: Record<Hook, (() => void)[]>;
  inners: FakeInner[];
  webAudioCalls: number;
  innerCalls: number;
  fire(hook: Hook): void;
  createWebAudioContext?(): unknown;
  createInnerAudioContext?(): unknown;
  onTouchStart?(cb: () => void): void;
  onHide?(cb: () => void): void;
  onShow?(cb: () => void): void;
  onAudioInterruptionBegin?(cb: () => void): void;
  onAudioInterruptionEnd?(cb: () => void): void;
}

/**
 * A `wx` global that records what was asked of it.
 *
 * Every hook keeps a LIST of callbacks, not one: `onAudioInterruptionEnd` is deliberately
 * registered twice by this backend (once through `onFocusChange` to release the bed, once directly
 * to `resume()` the SFX context), and a fake that kept only the last one would silently drop half
 * of the behaviour under test.
 */
function fakeWx(ctx: FakeAudioContext | null): FakeWx {
  const hooks = Object.fromEntries(HOOKS.map((h) => [h, [] as (() => void)[]])) as Record<Hook, (() => void)[]>;
  const wx: FakeWx = {
    hooks,
    inners: [],
    webAudioCalls: 0,
    innerCalls: 0,
    fire: (hook) => { for (const cb of [...hooks[hook]]) cb(); },
    createInnerAudioContext: () => { wx.innerCalls++; const i = new FakeInner(); wx.inners.push(i); return i; },
  };
  if (ctx) wx.createWebAudioContext = () => { wx.webAudioCalls++; return ctx; };
  for (const h of HOOKS) wx[h] = (cb: () => void): void => { hooks[h].push(cb); };
  return wx;
}

const g = globalThis as unknown as Record<string, unknown>;

describe('WechatAudioBus', () => {
  let ctx: FakeAudioContext;
  let wx: FakeWx;

  beforeEach(() => {
    ctx = fakeAudioContext();
    ctx.state = 'suspended'; // what the runtime hands over before the first touch
    wx = fakeWx(ctx);
    g.wx = wx;
  });

  afterEach(() => { delete g.wx; });

  /** Get past the autoplay gate and run one frame of BGM. */
  function startBgm(bus: WechatAudioBus): void {
    wx.fire('onTouchStart');
    bus.updateMusic('bgm.lobby', 16);
  }

  // ── context ─────────────────────────────────────────────────────────────────────────────────

  describe('the context', () => {
    it('uses wx.createWebAudioContext, exactly once', () => {
      const bus = new WechatAudioBus();
      expect(wx.webAudioCalls).toBe(0); // lazy: nothing built at construction
      bus.resume();
      bus.play('sfx.ui.tap');
      expect(wx.webAudioCalls).toBe(1);
    });

    it('goes mute without it (base lib < 2.19.0) instead of throwing', () => {
      delete wx.createWebAudioContext;
      const bus = new WechatAudioBus();
      expect(() => { bus.resume(); bus.play('sfx.ui.tap'); }).not.toThrow();
      expect(ctx.nodes).toHaveLength(0);
      expect(bus.loaded).toEqual({ cues: 0, variants: 0 });
    });

    it('constructs with no wx global at all (node suites, the e2e entry)', () => {
      delete g.wx;
      expect(() => { const b = new WechatAudioBus(); b.play('sfx.ui.tap'); b.updateMusic(null, 16); }).not.toThrow();
    });
  });

  // ── the invariant this file exists for ──────────────────────────────────────────────────────

  describe('base lib < 2.19.0 loses SFX, NOT music', () => {
    it('still builds both decks and starts the bed with no AudioContext anywhere', () => {
      delete wx.createWebAudioContext;
      const bus = new WechatAudioBus();
      startBgm(bus);
      expect(wx.inners).toHaveLength(2);
      expect(wx.inners.some((i) => i.playCalls > 0)).toBe(true);
      // ...while SFX is genuinely gone on that device, which is the half that IS allowed to fail.
      expect(ctx.nodes).toHaveLength(0);
    });

    it('and that is the opposite of the web backend, which needs the context for both', () => {
      // Stated here rather than only in `WebAudioBus.test.ts` because the two halves of the
      // contrast are what make `createMusicDecks(ctx: AudioContext | null)` the right signature.
      // If this case and its web counterpart ever agree, one of them is wrong.
      delete wx.createWebAudioContext;
      const bus = new WechatAudioBus();
      startBgm(bus);
      expect(wx.inners.length).toBe(2);
    });

    it('ignores the context even when there IS one — music never touches the audio graph', () => {
      const bus = new WechatAudioBus();
      startBgm(bus);
      expect(wx.inners).toHaveLength(2);
      // No `MediaElementSource`, no per-deck gain: the whole gain product lands on `.volume`.
      expect(ctx.mediaElements).toHaveLength(0);
    });
  });

  // ── gesture ─────────────────────────────────────────────────────────────────────────────────

  describe('the autoplay gate', () => {
    it('takes wx.onTouchStart — there is no DOM here to listen on', () => {
      new WechatAudioBus();
      expect(wx.hooks.onTouchStart).toHaveLength(1);
    });

    it('a touch unlocks the suspended context', () => {
      new WechatAudioBus();
      expect(ctx.resumeCalls).toBe(0);
      wx.fire('onTouchStart');
      expect(ctx.resumeCalls).toBe(1);
      expect(ctx.state).toBe('running');
    });

    it('no BGM before the first touch', () => {
      const bus = new WechatAudioBus();
      bus.updateMusic('bgm.lobby', 16);
      expect(wx.inners).toHaveLength(0);
    });

    it('a runtime without wx.onTouchStart is SILENT, not broken — the gate never opens', () => {
      // Documenting a coupling rather than asserting a wish: `onGesture` is always supplied by
      // this backend, so `ContextAudioBus.gestured` starts false and only `wx.onTouchStart` can
      // ever flip it. Every shipping base lib has that API (this is why it is not a live bug),
      // but if one ever drops it the symptom is total silence with nothing logged — so it should
      // fail here first, where the reason is written down, rather than on a device.
      delete wx.onTouchStart;
      const bus = new WechatAudioBus();
      expect(() => bus.play('sfx.ui.tap')).not.toThrow();
      bus.updateMusic('bgm.lobby', 16);
      expect(wx.inners).toHaveLength(0);
    });
  });

  // ── decks ───────────────────────────────────────────────────────────────────────────────────

  describe('the BGM decks', () => {
    it('two distinct InnerAudioContexts, one per crossfade end', () => {
      const bus = new WechatAudioBus();
      startBgm(bus);
      expect(wx.innerCalls).toBe(2);
      expect(wx.inners[0]).not.toBe(wx.inners[1]);
      // `loop` off on BOTH: MP3 frame padding makes sample-accurate native looping impossible, so
      // the wrap is a crossfade (see WechatAudioBus's own correction note).
      expect(wx.inners.every((i) => i.loop === false)).toBe(true);
    });

    it('no BGM without wx.createInnerAudioContext, and it latches off after one try', () => {
      delete wx.createInnerAudioContext;
      const bus = new WechatAudioBus();
      wx.fire('onTouchStart');
      expect(() => bus.updateMusic('bgm.lobby', 16)).not.toThrow();
      // updateMusic runs every frame on the ticker; a retry per frame is what the latch prevents.
      for (let i = 0; i < 100; i++) bus.updateMusic('bgm.lobby', 16);
      expect(wx.inners).toHaveLength(0);
    });
  });

  // ── focus + interruption ────────────────────────────────────────────────────────────────────

  describe('hold and release', () => {
    /** A running bed, plus the deck that owns it. */
    function running(bus: WechatAudioBus): FakeInner {
      startBgm(bus);
      const inner = wx.inners.find((i) => i.playCalls > 0);
      expect(inner).toBeDefined();
      return inner as FakeInner;
    }

    it('registers all four signals — this runtime has no visibilitychange', () => {
      new WechatAudioBus();
      expect(wx.hooks.onHide).toHaveLength(1);
      expect(wx.hooks.onShow).toHaveLength(1);
      expect(wx.hooks.onAudioInterruptionBegin).toHaveLength(1);
      // Twice on purpose: release the bed, and resume the SFX context. See `fakeWx`.
      expect(wx.hooks.onAudioInterruptionEnd).toHaveLength(2);
    });

    it('onHide holds the bed, onShow releases it', () => {
      const bus = new WechatAudioBus();
      const inner = running(bus);
      const plays = inner.playCalls;
      wx.fire('onHide');
      expect(inner.pauseCalls).toBe(1);
      wx.fire('onShow');
      expect(inner.playCalls).toBe(plays + 1);
    });

    it('an audio interruption is treated as backgrounding — a call holds the bed in place', () => {
      // Same callback on purpose: to a 74-second bed, "the player switched away" and "the phone
      // rang" both mean hold here and continue from here, not restart.
      const bus = new WechatAudioBus();
      const inner = running(bus);
      const plays = inner.playCalls;
      wx.fire('onAudioInterruptionBegin');
      expect(inner.pauseCalls).toBe(1);
      wx.fire('onAudioInterruptionEnd');
      expect(inner.playCalls).toBe(plays + 1);
    });

    it('a hold freezes the envelope: no wrap decision on stale evidence', () => {
      const bus = new WechatAudioBus();
      const inner = running(bus);
      wx.fire('onHide');
      // 74s track, 2s crossfade — enough frames to cross the wrap seam many times over.
      for (let i = 0; i < 6000; i++) bus.updateMusic('bgm.lobby', 16);
      expect(inner.playCalls).toBe(1);
      expect(inner.pauseCalls).toBe(1);
    });

    it('interruption END resumes the SFX context — otherwise the game is mute after a phone call', () => {
      // The failure this extra listener exists for, and the one case in this file that would not
      // reproduce anywhere else: the runtime can leave the context `suspended` after an
      // interruption, and no further gesture will ever fix it — the autoplay unlock was spent on
      // the first touch of the session, so `onTouchStart` firing again changes nothing.
      const bus = new WechatAudioBus();
      wx.fire('onTouchStart');
      bus.play('sfx.ui.tap');
      expect(ctx.state).toBe('running');
      const resumesBefore = ctx.resumeCalls;

      ctx.state = 'suspended'; // the phone rang
      wx.fire('onAudioInterruptionBegin');
      wx.fire('onAudioInterruptionEnd');

      expect(ctx.resumeCalls).toBe(resumesBefore + 1);
      expect(ctx.state).toBe('running');
    });

    it('the game that STARTS in the background stays silent until it is shown', () => {
      // The WeChat shape of the hole `WebAudioBus.test.ts` pins for a hidden browser tab: onHide
      // can arrive before anything ever asked for music (a launch straight into a system dialog,
      // an interruption during the loading screen), i.e. before `ContextAudioBus.music` exists.
      const bus = new WechatAudioBus();
      wx.fire('onTouchStart');
      wx.fire('onHide');
      bus.updateMusic('bgm.lobby', 16);
      expect(wx.inners.every((i) => i.playCalls === 0)).toBe(true);

      wx.fire('onShow');
      bus.updateMusic('bgm.lobby', 16);
      expect(wx.inners.some((i) => i.playCalls > 0)).toBe(true);
    });

    it('a runtime missing the focus hooks entirely still constructs and plays', () => {
      for (const h of ['onHide', 'onShow', 'onAudioInterruptionBegin', 'onAudioInterruptionEnd'] as const) {
        delete wx[h];
      }
      const bus = new WechatAudioBus();
      expect(() => startBgm(bus)).not.toThrow();
      expect(wx.inners.some((i) => i.playCalls > 0)).toBe(true);
    });
  });
});
