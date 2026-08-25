// Coverage for `client/src/app/assetGate.ts` — the shared "warm behind a loading screen, then
// build" primitive that `battleGate.enterBattle` and `PixiAppViews.showGacha` both sit on
// (ASSET_PACKAGING §10; generalised out of battleGate on 2026-08-25 when gacha got a gate).
//
// battleGate.ui.ts already covers the faded path end to end through `enterBattle`. This file
// covers the primitive directly, and specifically the NON-faded path that the gacha gate uses —
// where nothing else releases the input freeze, so the gate has to do it itself. That asymmetry
// is the one thing about this module that is easy to get wrong and impossible to notice by
// reading: an unreleased freeze leaves the player on a live-looking screen that ignores taps.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { Scene, SceneManager } from '../../src/scenes/SceneManager';
import type { InputManager } from '../../src/inputSystem/InputManager';
import { enterWithAssets } from '../../src/app/assetGate';

function makeApp(): PIXI.Application {
  return { screen: { width: 800, height: 600 }, stage: new PIXI.Container() } as unknown as PIXI.Application;
}
function makeManager(): SceneManager { return { goto: vi.fn() } as unknown as SceneManager; }
function makeInput(): InputManager { return { suppress: vi.fn() } as unknown as InputManager; }
function makeScene(): Scene {
  return { container: new PIXI.Container(), update: () => {}, destroy: () => {} };
}

/** A warm step whose completion the test controls, so ordering can be asserted step by step. */
function controllableWarm(): { warm: (cb: (d: number, t: number) => void) => Promise<void>; finish: () => void } {
  let finish = (): void => {};
  const warm = (onProgress: (d: number, t: number) => void): Promise<void> => {
    onProgress(0, 2);
    return new Promise<void>((resolve) => { finish = () => { onProgress(2, 2); resolve(); }; });
  };
  return { warm, get finish() { return finish; } };
}

const flushMicrotasks = (): Promise<void> => Promise.resolve().then().then();

describe('enterWithAssets', () => {
  it('freezes input and withholds the scene until the warm step resolves', async () => {
    const manager = makeManager();
    const input = makeInput();
    const build = vi.fn(makeScene);
    const gate = controllableWarm();

    const done = enterWithAssets({ app: makeApp(), manager, input }, gate.warm, build);
    await flushMicrotasks();
    expect(input.suppress).toHaveBeenCalledWith(true);
    expect(build).not.toHaveBeenCalled();
    expect(manager.goto).not.toHaveBeenCalled();

    gate.finish();
    await done;
    expect(build).toHaveBeenCalledTimes(1);
  });

  // The reason this file exists. On the faded path SceneManager's own transition un-suppresses;
  // here nothing does, so the gate must — otherwise every gacha entry ends with a dead screen.
  it('releases the input freeze itself on the un-faded path, and gotos without fade opts', async () => {
    const manager = makeManager();
    const input = makeInput();
    const gate = controllableWarm();
    const scene = makeScene();

    const done = enterWithAssets({ app: makeApp(), manager, input }, gate.warm, () => scene);
    gate.finish();
    await done;

    expect(manager.goto).toHaveBeenCalledWith(scene);
    expect(input.suppress).toHaveBeenLastCalledWith(false);
  });

  it('leaves un-suppressing to the fade transition when fading', async () => {
    const manager = makeManager();
    const input = makeInput();
    const gate = controllableWarm();
    const scene = makeScene();

    const done = enterWithAssets({ app: makeApp(), manager, input }, gate.warm, () => scene, { fade: true });
    gate.finish();
    await done;

    expect(manager.goto).toHaveBeenCalledWith(scene, { fade: true });
    expect(input.suppress).toHaveBeenCalledTimes(1); // only the initial suppress(true)
  });

  it('tears the loading overlay down before the scene is gotoed', async () => {
    const app = makeApp();
    const manager = makeManager();
    const childrenAtGoto: number[] = [];
    (manager.goto as ReturnType<typeof vi.fn>).mockImplementation(() => {
      childrenAtGoto.push(app.stage.children.length);
    });
    const gate = controllableWarm();

    const done = enterWithAssets({ app, manager, input: makeInput() }, gate.warm, makeScene);
    await flushMicrotasks();
    expect(app.stage.children.length).toBe(1); // overlay mounted
    gate.finish();
    await done;
    expect(childrenAtGoto).toEqual([0]);
  });

  // The warm callbacks are all contractually non-rejecting, but "stranded behind a loading screen
  // with input frozen" is bad enough that the gate defends against it anyway.
  it('does not strand the player behind the overlay if the warm step rejects', async () => {
    const app = makeApp();
    const input = makeInput();
    const build = vi.fn(makeScene);

    await expect(
      enterWithAssets({ app, manager: makeManager(), input }, () => Promise.reject(new Error('boom')), build)
    ).rejects.toThrow('boom');

    expect(app.stage.children.length).toBe(0); // overlay gone
    expect(build).not.toHaveBeenCalled();
  });
});
