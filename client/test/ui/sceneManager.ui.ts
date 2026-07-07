// SceneManager containment regression tests.
//
// Background: SceneManager.onTick runs on app.ticker AHEAD of PIXI's renderer
// listener. In PIXI 7 a throw from any ticker listener aborts the update loop and
// prevents the next requestAnimationFrame from being scheduled — the whole canvas
// freezes permanently until a page reload. A scene whose update() touched a display
// object destroyed mid-transition (`this.transform is null`) triggered exactly this.
//
// onTick now isolates scene.update() in try/catch, and goto() isolates the outgoing
// scene.destroy() so a throwing teardown can't block mounting the next scene. These
// tests pin both behaviors with a fake ticker we step manually.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { SceneManager, type Scene } from '../../src/scenes/SceneManager';

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

describe('SceneManager containment', () => {
  it('a throwing scene.update() is contained — the tick never throws (would kill the ticker)', () => {
    const { app, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ update: () => { throw new Error('update-boom'); } }));

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
    mgr.goto(healthy);
    frame();
    expect(healthy.update).toHaveBeenCalledTimes(1);
  });

  it('a throwing scene.destroy() does not block mounting the next scene', () => {
    const { app, stage, frame } = makeApp();
    const mgr = new SceneManager(app);
    mgr.goto(makeScene({ destroy: () => { throw new Error('destroy-boom'); } }));

    const next = makeScene({ update: vi.fn() });
    expect(() => mgr.goto(next)).not.toThrow();
    expect(stage.children).toContain(next.container);
    frame();
    expect(next.update).toHaveBeenCalledTimes(1);
  });

  it('goto swaps the stage child and destroys the outgoing scene', () => {
    const { app, stage } = makeApp();
    const mgr = new SceneManager(app);
    const a = makeScene({ destroy: vi.fn() });
    mgr.goto(a);
    expect(stage.children).toContain(a.container);

    const b = makeScene();
    mgr.goto(b);
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
    frame();
    expect(a.update).not.toHaveBeenCalled();
    expect(b.update).toHaveBeenCalledTimes(1);
  });
});
