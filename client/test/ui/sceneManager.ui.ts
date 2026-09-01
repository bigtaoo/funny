// SceneManager containment + fade-transition + input-gating regression tests.
//
// Background (containment): SceneManager.onTick runs on app.ticker AHEAD of PIXI's renderer
// listener. In PIXI 7 a throw from any ticker listener aborts the update loop and prevents the next
// requestAnimationFrame — the whole canvas freezes until a page reload. A scene whose update()
// touched a display object destroyed mid-transition triggered exactly this. onTick isolates
// scene.update() and the swap isolates the outgoing scene.destroy().
//
// Background (fade): goto() swaps in the same frame by default (no fade) — that covers ordinary
// navigation (lobby tabs, sub-screens, back buttons). Passing `{ fade: true }` instead cross-fades
// through a full-screen paper-tint cover (fade-out → swap → fade-in), driven off app.ticker; the
// old scene stays mounted until the fade-out completes. Reserved for entering/exiting a match or
// the SLG world map — every other transition is instant.
//
// Background (input gate): pointer input bypasses PixiJS (DOM-fed straight into InputManager), so the
// cover can't block taps. The manager freezes the InputManager for the span of each fade —
// otherwise a tap mid-fade hits the outgoing scene's still-live hit-rects (the "Store → Career"
// mis-navigation this replaced, back when every goto faded). The first tap ABORTS the fade instead
// of being swallowed for the full ~270ms. An instant (non-fade) goto never freezes input at all.
//
// A fake ticker (deltaMS = 16) is stepped manually; helpers advance frames until the fade settles.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SceneManager, type Scene, type InputGate, type DialogGate } from '../../src/scenes/SceneManager';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, MusicTrack } from '../../src/audio/types';
import { InputManager } from '../../src/inputSystem/InputManager';

/** Fake PIXI.Application exposing just what SceneManager touches, plus a manual frame(). */
function makeApp() {
  let tick: (() => void) | null = null;
  const stage = new PIXI.Container();
  const app = {
    ticker: {
      add: (fn: () => void) => { tick = fn; }, // onTick is an already-bound arrow
      deltaMS: 16,
    },
    stage,
    screen: { width: 800, height: 600 },
  } as unknown as PIXI.Application;
  return { app, stage, frame: (): void => tick?.() };
}

function makeScene(opts: Partial<Pick<Scene, 'update' | 'destroy'>> = {}): Scene {
  return {
    container: new PIXI.Container(),
    update: opts.update ?? ((): void => {}),
    destroy: opts.destroy ?? ((): void => {}),
  };
}

/** Step a generous number of frames — more than enough for one full fade (90ms out + 180ms in). */
function settle(frame: () => void, n = 30): void {
  for (let i = 0; i < n; i++) frame();
}

/** Step frames until `pred()` holds (or `max` is hit); returns whether it held. */
function frameUntil(frame: () => void, pred: () => boolean, max = 60): boolean {
  for (let i = 0; i < max; i++) {
    if (pred()) return true;
    frame();
  }
  return pred();
}

describe('SceneManager containment', () => {
  it('a throwing scene.update() is contained — the tick never throws (would kill the ticker)', () => {
    const { app, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ update: () => { throw new Error('update-boom'); } })); // instant (default, no fade)

    // A throw escaping here is what freezes the real app. It must be swallowed —
    // every frame, not just the first.
    expect(() => frame()).not.toThrow();
    expect(() => frame()).not.toThrow();
  });

  it('recovers after a faulted scene: switching to a healthy scene resumes updates', () => {
    const { app, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ update: () => { throw new Error('update-boom'); } }));
    frame(); // faults (contained)

    const healthy = makeScene({ update: vi.fn() });
    mgr.goto(healthy, { fade: true }); // fades in over subsequent frames
    settle(frame);
    expect(healthy.update).toHaveBeenCalled();
  });

  it('a throwing scene.destroy() does not block mounting the next scene', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ destroy: () => { throw new Error('destroy-boom'); } }));

    const next = makeScene({ update: vi.fn() });
    expect(() => mgr.goto(next, { fade: true })).not.toThrow();
    settle(frame); // the throwing destroy fires (contained) at the mid-fade swap
    expect(stage.children).toContain(next.container);
    expect(next.update).toHaveBeenCalled();
  });

  it('goto swaps the stage child and destroys the outgoing scene (after the fade)', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene({ destroy: vi.fn() });
    mgr.goto(a); // instant (default, no fade)
    expect(stage.children).toContain(a.container);

    const b = makeScene();
    mgr.goto(b, { fade: true });
    settle(frame);
    expect(a.destroy).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(a.container);
    expect(stage.children).toContain(b.container);
  });

  it('only the current scene is updated each frame', () => {
    const { app, frame } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene({ update: vi.fn() });
    mgr.goto(a);
    const b = makeScene({ update: vi.fn() });
    mgr.goto(b, { fade: true });
    settle(frame); // b becomes current once the fade completes

    (a.update as ReturnType<typeof vi.fn>).mockClear();
    (b.update as ReturnType<typeof vi.fn>).mockClear();
    frame();
    expect(a.update).not.toHaveBeenCalled();
    expect(b.update).toHaveBeenCalledTimes(1);
  });
});

describe('SceneManager instant swaps (default)', () => {
  it('goto() with no opts swaps in the same frame, even when a scene is already mounted', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene());
    const b = makeScene();
    mgr.goto(b); // no { fade: true } → instant, same as cold start
    expect(stage.children).toContain(b.container); // no frames needed
  });

  it('an instant goto cancels an in-flight fade outright instead of queuing another cross-fade', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene()); // cold
    const b = makeScene({ destroy: vi.fn() });
    mgr.goto(b, { fade: true }); // starts fading out toward b (not yet mounted)
    const c = makeScene();
    mgr.goto(c); // instant: drop b, swap straight to c
    expect(b.destroy).toHaveBeenCalledTimes(1);
    expect(stage.children).toContain(c.container);
    expect(stage.children).not.toContain(b.container);
  });
});

describe('SceneManager fade transition ({ fade: true })', () => {
  it('cold start swaps instantly regardless of fade; a later faded goto defers the swap', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene();
    mgr.goto(a, { fade: true }); // nothing to cross-fade from yet → still instant
    expect(stage.children).toContain(a.container); // first scene mounts same-frame

    const b = makeScene();
    mgr.goto(b, { fade: true });
    // Still mid-fade: the outgoing scene is up, the incoming is not yet mounted.
    expect(stage.children).toContain(a.container);
    expect(stage.children).not.toContain(b.container);

    expect(frameUntil(frame, () => stage.children.includes(b.container))).toBe(true);
    expect(stage.children).not.toContain(a.container);
  });

  it('a faded goto arriving during fade-out retargets the incoming (never mounts the dropped one)', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene());       // cold
    const b = makeScene({ destroy: vi.fn() });
    mgr.goto(b, { fade: true }); // starts fade-out (b constructed, not mounted)
    const c = makeScene();
    mgr.goto(c, { fade: true }); // retargets during fade-out → b dropped
    expect(b.destroy).toHaveBeenCalledTimes(1); // the superseded incoming is disposed
    settle(frame);
    expect(stage.children).toContain(c.container);
    expect(stage.children).not.toContain(b.container);
  });
});

describe('SceneManager input gating', () => {
  function makeGate(): InputGate & {
    suppress: ReturnType<typeof vi.fn>;
    swallowNextUp: ReturnType<typeof vi.fn>;
    fireSuppressedDown: () => void;
  } {
    let hook: (() => void) | null = null;
    return {
      suppress: vi.fn(),
      onSuppressedInput: (fn) => { hook = fn; },
      swallowNextUp: vi.fn(),
      fireSuppressedDown: () => hook?.(),
    };
  }

  it('freezes input for the span of a fade and releases it once settled', () => {
    const { app, stage, frame } = makeApp();
    const gate = makeGate();
    const mgr = new SceneManager(app, stage, gate);

    mgr.goto(makeScene());              // cold → instant, input stays live
    expect(gate.suppress).toHaveBeenLastCalledWith(false);

    mgr.goto(makeScene(), { fade: true }); // fade → freeze
    expect(gate.suppress).toHaveBeenLastCalledWith(true);

    settle(frame);
    expect(gate.suppress).toHaveBeenLastCalledWith(false); // released after the fade
  });

  it('a default (non-fade) swap never freezes input', () => {
    const { app, stage } = makeApp();
    const gate = makeGate();
    const mgr = new SceneManager(app, stage, gate);
    mgr.goto(makeScene());
    gate.suppress.mockClear();
    mgr.goto(makeScene()); // no { fade: true } → instant
    expect(gate.suppress).not.toHaveBeenCalledWith(true);
    expect(gate.suppress).toHaveBeenLastCalledWith(false);
  });

  it('the first tap aborts the fade: target mounts at once and input is released', () => {
    const { app, stage } = makeApp();
    const gate = makeGate();
    const mgr = new SceneManager(app, stage, gate);
    const a = makeScene({ destroy: vi.fn() });
    mgr.goto(a);                        // cold
    const b = makeScene();
    mgr.goto(b, { fade: true });        // fade — b not yet mounted
    expect(stage.children).not.toContain(b.container);

    gate.fireSuppressedDown();          // simulate a tap landing during the fade
    expect(stage.children).toContain(b.container);      // jumped straight to target
    expect(stage.children).not.toContain(a.container);
    expect(a.destroy).toHaveBeenCalledTimes(1);
    expect(gate.suppress).toHaveBeenLastCalledWith(false); // input live again
    expect(gate.swallowNextUp).toHaveBeenCalledTimes(1);   // the aborting tap's release is eaten
  });
});

describe('SceneManager overlays (pushOverlay/popOverlay)', () => {
  it('pushOverlay mounts on top of current and pauses it; popOverlay tears it down and resumes current', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    const base = makeScene({ destroy: vi.fn() }) as Scene & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
    base.pause = vi.fn();
    base.resume = vi.fn();
    mgr.goto(base);

    const overlay = makeScene({ destroy: vi.fn() });
    mgr.pushOverlay(overlay);
    expect(stage.children).toContain(base.container);
    expect(stage.children).toContain(overlay.container);
    expect(base.pause).toHaveBeenCalledTimes(1);

    mgr.popOverlay();
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(overlay.container);
    expect(stage.children).toContain(base.container);
    expect(base.resume).toHaveBeenCalledTimes(1);
  });

  it('pushOverlay while an overlay is already mounted replaces it cleanly (no stale container left on stage)', () => {
    // Regression: DefenseEditorScene's onBack rebuilds the City overlay it was opened over — a
    // second pushOverlay landing on top of an existing one, not a pop-then-push. The old overlay
    // must be detached from the display list before it's destroyed, or the destroyed container
    // lingers as a stage child and the next render walking into it throws (frozen screen, see
    // SceneManager.pushOverlay).
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene());

    const first = makeScene({ destroy: vi.fn() });
    mgr.pushOverlay(first);
    expect(stage.children).toContain(first.container);

    const second = makeScene({ destroy: vi.fn() });
    mgr.pushOverlay(second); // no popOverlay() in between
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(first.container);
    expect(stage.children).toContain(second.container);
  });
});

describe('SceneManager DialogGate (2026-08-08: FeedbackDialog Close landing on a random level/SLG)', () => {
  // Background: FeedbackDialog is mounted directly on app.stage, outside this manager entirely, so
  // it can be opened from (only) the lobby without any SceneManager wiring. A background nav firing
  // while it's open (a pushed match starting, an async world-shard resolve racing a fast double-tap
  // on the World button) used to swap the scene underneath it silently — the dialog's Close button
  // then revealed whatever that background nav landed on instead of the Lobby it was opened from.
  // DialogGate.close() is called at the very top of every goto(), same "hard swap means done with
  // this whole area" reasoning goto() already applies to its own overlayScene.
  function makeDialogGate(): DialogGate & { close: ReturnType<typeof vi.fn> } {
    return { close: vi.fn() };
  }

  it('goto() closes the dialog gate on an instant (non-fade) swap', () => {
    const { app } = makeApp();
    const gate = makeDialogGate();
    const mgr = new SceneManager(app, undefined, undefined, gate);
    mgr.goto(makeScene());
    expect(gate.close).toHaveBeenCalledTimes(1);
  });

  it('goto() closes the dialog gate immediately when a fade is requested — not deferred until the fade settles', () => {
    const { app, frame } = makeApp();
    const gate = makeDialogGate();
    const mgr = new SceneManager(app, undefined, undefined, gate);
    mgr.goto(makeScene()); // cold, instant
    gate.close.mockClear();

    mgr.goto(makeScene(), { fade: true }); // starts fading out; swap hasn't happened yet
    expect(gate.close).toHaveBeenCalledTimes(1); // already closed — not waiting for settle()

    settle(frame);
    expect(gate.close).toHaveBeenCalledTimes(1); // settling the fade doesn't call it again
  });

  it('a mid-fade retarget calls close() again for the new goto(), not just the first', () => {
    const { app } = makeApp();
    const gate = makeDialogGate();
    const mgr = new SceneManager(app, undefined, undefined, gate);
    mgr.goto(makeScene()); // cold
    mgr.goto(makeScene(), { fade: true }); // fade-out in flight
    mgr.goto(makeScene(), { fade: true }); // retargets mid-fade-out
    expect(gate.close).toHaveBeenCalledTimes(3); // once per goto() call
  });

  it('pushOverlay/popOverlay do NOT call the dialog gate — only a hard goto() does', () => {
    // FeedbackDialog is only ever reachable from the Lobby, which never sits under a pushOverlay
    // panel — scoping the gate to goto() (not pushOverlay) keeps it from firing on unrelated SLG
    // panel opens that have nothing to do with the lobby-only dialog.
    const { app } = makeApp();
    const gate = makeDialogGate();
    const mgr = new SceneManager(app, undefined, undefined, gate);
    mgr.goto(makeScene());
    gate.close.mockClear();
    mgr.pushOverlay(makeScene());
    mgr.popOverlay();
    expect(gate.close).not.toHaveBeenCalled();
  });

  it('goto() works with no dialogGate configured at all (optional, backward-compatible)', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app); // no 4th arg
    const scene = makeScene();
    expect(() => mgr.goto(scene)).not.toThrow();
    expect(stage.children).toContain(scene.container);
  });
});

describe('SceneManager × InputManager (integration)', () => {
  it('a tap during a fade aborts it, its release is swallowed, and the next tap reaches the new scene', () => {
    const { app, stage } = makeApp();
    const input = new InputManager();
    const mgr = new SceneManager(app, stage, input);

    const a = makeScene();
    mgr.goto(a);       // cold → instant

    // Subscribe an up-handler on behalf of the *incoming* scene to prove the aborting
    // tap's release does not activate it.
    const bUp = vi.fn();
    input.onUp(bUp);
    const b = makeScene();
    mgr.goto(b, { fade: true }); // fade begins → input frozen

    // A tap that lands during the fade: down aborts the fade (b mounts now)...
    input._emitDown(5, 5);
    expect(stage.children).toContain(b.container);
    expect(stage.children).not.toContain(a.container);

    // ...and the matching release is swallowed, so it never fires as a real tap.
    input._emitUp(5, 5);
    expect(bUp).not.toHaveBeenCalled();

    // The NEXT tap is delivered normally — input is fully live again.
    input._emitUp(6, 6);
    expect(bUp).toHaveBeenCalledTimes(1);
  });
});

// ── BGM: which bed the frame asks for (AUDIO_DESIGN.md §7 step 7) ──────────────────────────────
//
// `onTick` derives the desired track every frame from `current.music` rather than being told on a
// scene change. These cases pin the things that derivation gets wrong if written carelessly, and
// every one of them is SILENT in the shipped game:
//
//   * a `??` fallback swallowing an explicit `null` — a scene asking for silence gets the lobby bed;
//   * an overlay hijacking the bed — a City overlay opened over a match would stop the battle music,
//     even though `current` is still alive and simulating underneath;
//   * the music frame stopping when a scene throws — the bed freezes mid-crossfade, which reads as
//     broken audio rather than as the broken scene it actually is.
//
// Driven through the real `setAudioBus` seam rather than a module mock: that is the seam production
// uses, so a case here cannot pass against a shape the game does not have.
describe('SceneManager — the per-frame BGM derivation', () => {
  function recordingAudio(): (MusicTrack | null)[] {
    const asks: (MusicTrack | null)[] = [];
    // Spelled out rather than spread over a `NullAudioBus` — its methods live on the prototype, so
    // a spread would produce an object that type-checks as nothing and throws at the first call.
    const bus: AudioBus = {
      preload: async () => {},
      play: () => {},
      setSfxVolume: () => {},
      setMusicVolume: () => {},
      resume: () => {},
      updateMusic: (desired) => { asks.push(desired); },
    };
    setAudioBus(bus);
    return asks;
  }
  afterEach(() => { setAudioBus(new NullAudioBus()); });

  const last = <T,>(a: T[]): T | undefined => a[a.length - 1];

  it('a scene that declares nothing gets the default bed', () => {
    const asks = recordingAudio();
    const { app, frame } = makeApp();
    new SceneManager(app).goto(makeScene());
    frame();
    expect(last(asks)).toBe('bgm.lobby');
  });

  it('`music: null` means SILENCE and is not swallowed into the default', () => {
    // The declared value that matters today: `bgm.battle` has no master, so the three match
    // scenes declare `null` (see `GameScene.music`). `??` would read that as "omitted" and hand
    // back the lobby bed — music under a match, which is exactly what the union's absence is
    // meant to prevent. Only `undefined` may fall back.
    const asks = recordingAudio();
    const { app, frame } = makeApp();
    new SceneManager(app).goto({ ...makeScene(), music: null } as Scene);
    frame();
    expect(last(asks)).toBeNull();
  });

  it('an overlay does NOT change the bed — `current` is still the situation', () => {
    const asks = recordingAudio();
    const { app, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto({ ...makeScene(), music: null } as Scene);
    mgr.pushOverlay(makeScene());        // declares nothing, i.e. would default to the lobby bed
    frame();
    expect(last(asks)).toBeNull();
  });

  it('keeps asking every frame even while the scene update is throwing', () => {
    const asks = recordingAudio();
    const { app, frame } = makeApp();
    new SceneManager(app).goto({
      ...makeScene({ update: () => { throw new Error('boom'); } }), music: null,
    } as Scene);
    frame();
    frame();
    expect(asks.filter((a) => a === null).length).toBeGreaterThanOrEqual(2);
  });
});
