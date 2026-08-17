// Coverage for `client/src/app/battleGate.ts` (ASSET_PACKAGING §10) — the pre-match
// asset-readiness gate extracted out of `PixiAppViews.showGame`/`showGameNet`
// (client/src/app/PixiAppViews.ts, split out of app.ts on 2026-08-17).
//
// Deliberately tests this module in isolation rather than importing PixiAppViews directly: that
// file pulls in ~30 scene classes for its other show* methods (WorldMapScene/FamilyScene/etc.),
// whose import graphs reach `@nw/shared` and would require `server/node_modules` just to
// resolve — battleGate.ts only needs SceneManager/InputManager/LoadingOverlay/battleAssets,
// so this file (and its mocks) stay cheap.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { Scene, SceneManager } from '../../src/scenes/SceneManager';
import type { InputManager } from '../../src/inputSystem/InputManager';

// Controllable in place of the real ensureBattleAssets (which would otherwise fire real
// StickmanRuntime/cardArt loads) — each test grabs `resolveGate`/`rejectGate` to decide when
// the "assets are ready" promise settles, so the suppress→loading→goto ordering can be asserted
// step by step instead of racing a real (fast, cached-after-first-use) load.
let resolveGate: () => void = () => {};
vi.mock('../../src/assets/battleAssets', () => ({
  ensureBattleAssets: vi.fn((_opts: unknown, onProgress?: (done: number, total: number) => void) => {
    onProgress?.(0, 1);
    return new Promise<void>((resolve) => {
      resolveGate = () => { onProgress?.(1, 1); resolve(); };
    });
  }),
}));

// Imported AFTER vi.mock (vitest hoists mock registration above all imports regardless of
// physical order — see marchTokenScale.ui.ts for the same pattern).
import { enterBattle, DeferredSceneCalls } from '../../src/app/battleGate';

/** Fake PIXI.Application exposing just what LoadingOverlay touches. */
function makeApp(): PIXI.Application {
  return { screen: { width: 800, height: 600 }, stage: new PIXI.Container() } as unknown as PIXI.Application;
}

function makeManager(): SceneManager { return { goto: vi.fn() } as unknown as SceneManager; }
function makeInput(): InputManager { return { suppress: vi.fn() } as unknown as InputManager; }

function makeScene(): Scene {
  return { container: new PIXI.Container(), update: () => {}, destroy: () => {} };
}

// Let one microtask tick pass so any already-resolved promise's .then() callbacks run, without
// needing real timers.
const flushMicrotasks = (): Promise<void> => Promise.resolve().then().then();

describe('enterBattle', () => {
  it('suppresses input and does NOT goto before ensureBattleAssets resolves', async () => {
    const manager = makeManager();
    const input = makeInput();
    const build = vi.fn(makeScene);
    const done = enterBattle({ app: makeApp(), manager, input }, {}, build);

    await flushMicrotasks();
    expect(input.suppress).toHaveBeenCalledWith(true);
    expect(build).not.toHaveBeenCalled();
    expect(manager.goto).not.toHaveBeenCalled();

    resolveGate();
    const scene = await done;
    expect(build).toHaveBeenCalledTimes(1);
    expect(manager.goto).toHaveBeenCalledWith(scene, { fade: true });
  });

  it('destroys the loading overlay before gotoing the built scene (no residual cover on top)', async () => {
    const app = makeApp();
    const manager = makeManager();
    const stageChildCountAtGoto: number[] = [];
    (manager.goto as ReturnType<typeof vi.fn>).mockImplementation(() => {
      stageChildCountAtGoto.push(app.stage.children.length);
    });
    const done = enterBattle({ app, manager, input: makeInput() }, {}, makeScene);
    await flushMicrotasks();
    expect(app.stage.children.length).toBe(1); // LoadingOverlay's container is mounted
    resolveGate();
    await done;
    expect(stageChildCountAtGoto).toEqual([0]); // overlay already torn down by the time goto runs
  });

  it('returns the built scene', async () => {
    const scene = makeScene();
    const done = enterBattle({ app: makeApp(), manager: makeManager(), input: makeInput() }, {}, () => scene);
    resolveGate();
    await flushMicrotasks();
    expect(await done).toBe(scene);
  });
});

describe('DeferredSceneCalls', () => {
  it('queues calls made before resolve() and flushes them in order once the scene exists', () => {
    const order: string[] = [];
    const deferred = new DeferredSceneCalls<{ tag: string }>();
    deferred.call(() => order.push('a'));
    deferred.call(() => order.push('b'));
    expect(order).toEqual([]); // not flushed yet — no scene

    deferred.resolve({ tag: 'scene' });
    expect(order).toEqual(['a', 'b']);
  });

  it('applies calls immediately once resolved, with no queuing', () => {
    const order: string[] = [];
    const deferred = new DeferredSceneCalls<{ tag: string }>();
    deferred.resolve({ tag: 'scene' });
    deferred.call(() => order.push('a'));
    deferred.call(() => order.push('b'));
    expect(order).toEqual(['a', 'b']);
  });

  it('passes the resolved scene through to each callback', () => {
    const scene = { tag: 'scene' };
    const seen: unknown[] = [];
    const deferred = new DeferredSceneCalls<typeof scene>();
    deferred.call((s) => seen.push(s));
    deferred.resolve(scene);
    expect(seen).toEqual([scene]);
  });
});
