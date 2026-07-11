// SceneManager containment + fade-transition + input-gating regression tests.
//
// Background (containment): SceneManager.onTick runs on app.ticker AHEAD of PIXI's renderer
// listener. In PIXI 7 a throw from any ticker listener aborts the update loop and prevents the next
// requestAnimationFrame — the whole canvas freezes until a page reload. A scene whose update()
// touched a display object destroyed mid-transition triggered exactly this. onTick isolates
// scene.update() and the swap isolates the outgoing scene.destroy().
//
// Background (fade): scene switches now cross-fade through a full-screen black cover
// (fade-out → swap → fade-in), driven off app.ticker. goto() no longer swaps synchronously — the
// old scene stays mounted until the fade-out completes. Cold start and resize rebuilds pass
// { instant: true } to keep the original same-frame swap.
//
// Background (input gate): pointer input bypasses PixiJS (DOM-fed straight into InputManager), so the
// black cover can't block taps. The manager freezes the InputManager for the span of each fade —
// otherwise a tap mid-fade hits the outgoing scene's still-live hit-rects (the "Store → Career"
// mis-navigation). The first tap ABORTS the fade instead of being swallowed for the full ~280ms.
//
// A fake ticker (deltaMS = 16) is stepped manually; helpers advance frames until the fade settles.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SceneManager, type Scene, type InputGate } from '../../src/scenes/SceneManager';
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

/** Step a generous number of frames — more than enough for one full fade (120ms out + 160ms in). */
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
    mgr.goto(makeScene({ update: () => { throw new Error('update-boom'); } })); // cold start → instant

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
    mgr.goto(healthy);          // fades in over subsequent frames
    settle(frame);
    expect(healthy.update).toHaveBeenCalled();
  });

  it('a throwing scene.destroy() does not block mounting the next scene', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ destroy: () => { throw new Error('destroy-boom'); } }));

    const next = makeScene({ update: vi.fn() });
    expect(() => mgr.goto(next)).not.toThrow();
    settle(frame); // the throwing destroy fires (contained) at the mid-fade swap
    expect(stage.children).toContain(next.container);
    expect(next.update).toHaveBeenCalled();
  });

  it('goto swaps the stage child and destroys the outgoing scene (after the fade)', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene({ destroy: vi.fn() });
    mgr.goto(a); // cold → instant
    expect(stage.children).toContain(a.container);

    const b = makeScene();
    mgr.goto(b);
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
    mgr.goto(b);
    settle(frame); // b becomes current once the fade completes

    (a.update as ReturnType<typeof vi.fn>).mockClear();
    (b.update as ReturnType<typeof vi.fn>).mockClear();
    frame();
    expect(a.update).not.toHaveBeenCalled();
    expect(b.update).toHaveBeenCalledTimes(1);
  });
});

describe('SceneManager fade transition', () => {
  it('cold start swaps instantly (no fade); a later goto defers the swap to the fade', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene();
    mgr.goto(a);
    expect(stage.children).toContain(a.container); // first scene mounts same-frame

    const b = makeScene();
    mgr.goto(b);
    // Still mid-fade: the outgoing scene is up, the incoming is not yet mounted.
    expect(stage.children).toContain(a.container);
    expect(stage.children).not.toContain(b.container);

    expect(frameUntil(frame, () => stage.children.includes(b.container))).toBe(true);
    expect(stage.children).not.toContain(a.container);
  });

  it('{ instant: true } skips the fade and swaps in the same frame', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene());
    const b = makeScene();
    mgr.goto(b, { instant: true });
    expect(stage.children).toContain(b.container); // no frames needed
  });

  it('a goto arriving during fade-out retargets the incoming (never mounts the dropped one)', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene());       // cold
    const b = makeScene({ destroy: vi.fn() });
    mgr.goto(b);                 // starts fade-out (b constructed, not mounted)
    const c = makeScene();
    mgr.goto(c);                 // retargets during fade-out → b dropped
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

    mgr.goto(makeScene());              // fade → freeze
    expect(gate.suppress).toHaveBeenLastCalledWith(true);

    settle(frame);
    expect(gate.suppress).toHaveBeenLastCalledWith(false); // released after the fade
  });

  it('an { instant: true } swap never freezes input', () => {
    const { app, stage } = makeApp();
    const gate = makeGate();
    const mgr = new SceneManager(app, stage, gate);
    mgr.goto(makeScene());
    gate.suppress.mockClear();
    mgr.goto(makeScene(), { instant: true });
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
    mgr.goto(b);                        // fade — b not yet mounted
    expect(stage.children).not.toContain(b.container);

    gate.fireSuppressedDown();          // simulate a tap landing during the fade
    expect(stage.children).toContain(b.container);      // jumped straight to target
    expect(stage.children).not.toContain(a.container);
    expect(a.destroy).toHaveBeenCalledTimes(1);
    expect(gate.suppress).toHaveBeenLastCalledWith(false); // input live again
    expect(gate.swallowNextUp).toHaveBeenCalledTimes(1);   // the aborting tap's release is eaten
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
    mgr.goto(b);       // fade begins → input frozen

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
