// Coverage for `client/src/app/PixiAppViews.ts` — the AppViews implementation split out of app.ts
// on 2026-08-17 (see claudedocs/client-modules.md's dated entry). It had no tests before that split
// and could not have had any: the class was a non-exported local inside app.ts, reachable only by
// running the whole startApp() boot sequence (PIXI runtime + watchdogs + L0 asset gate). Exporting
// it from its own module is what made these assertions possible, so the tests land with the split.
//
// What's asserted here is the wiring PixiAppViews owns and nothing else — the lobby-only resize
// listener's lifetime, the resize-driven-rebuild-never-fades rule, the ADR-044 overlay-vs-goto
// branch in mountSlg, the recordConstructSample timing hook, and showGameNet's flipped joiner
// layout + pre-gate push buffering. The scenes themselves are mocked: their real constructors are
// smoke-tested by their own *.ui.ts files, and what matters here is which one got built, with what
// layout, and how it was handed to SceneManager.
//
// battleAssets is mocked the same way battleGate.ui.ts does it (a gate the test resolves by hand),
// so the async enterBattle path can be stepped rather than raced.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

// vi.mock factories run while this file's imports are still being resolved — before any top-level
// `const` here would initialize — so the shared capture arrays go through vi.hoisted (same reason
// as worldMapBaseTextureSelection.ui.ts).
const { built, samples, gate, sceneBase } = vi.hoisted(() => {
  const built: Array<{ name: string; args: unknown[] }> = [];
  const samples: Array<{ name: string; ms: number }> = [];
  const gate = { resolve: (): void => {} };
  /** Minimal stand-in for a Scene: records its ctor args so tests can read the layout it got. */
  const sceneBase = (name: string) =>
    class {
      readonly args: unknown[];
      readonly container = { destroy: (): void => {} };
      constructor(...args: unknown[]) {
        this.args = args;
        built.push({ name, args });
      }
      update(): void {}
      destroy(): void {}
    };
  return { built, samples, gate, sceneBase };
});

vi.mock('../../src/scenes/LobbyScene', () => ({
  LobbyScene: class extends sceneBase('LobbyScene') {
    applySocialBadge = vi.fn();
    applyAchievementBadge = vi.fn();
    applyShopBadge = vi.fn();
    applyRetentionBadge = vi.fn();
    applyEventsAvailable = vi.fn();
    applyWorldAvailable = vi.fn();
    showAchievementToast = vi.fn();
    showSeasonSettlement = vi.fn();
    showFeatureGuide = vi.fn();
  },
}));
vi.mock('../../src/scenes/SettingsScene', () => ({ SettingsScene: sceneBase('SettingsScene') }));
vi.mock('../../src/scenes/FamilyScene', () => ({ FamilyScene: sceneBase('FamilyScene') }));
vi.mock('../../src/scenes/WorldMapScene', () => ({
  WorldMapScene: class extends sceneBase('WorldMapScene') {
    applyMarchUpdate = vi.fn();
    applyTileUpdate = vi.fn();
    applyUnderAttack = vi.fn();
    applySiegeResult = vi.fn();
    applyNationMsg = vi.fn();
    refreshMe = vi.fn();
  },
}));
vi.mock('../../src/scenes/GameScene', () => ({
  GameScene: class extends sceneBase('GameScene') {
    applyNetState = vi.fn();
    applyPeerDc = vi.fn();
    applyMatchOver = vi.fn();
  },
}));

// Everything else in net/anomaly stays real (other modules in this import graph use it) — only the
// scene-construction timing hook is diverted so the samples are observable.
vi.mock('../../src/net/anomaly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/net/anomaly')>()),
  recordConstructSample: (name: string, ms: number): void => { samples.push({ name, ms }); },
}));

// enterBattle's asset gate: hand the test the resolver instead of firing real rig/card-art loads.
vi.mock('../../src/assets/battleAssets', () => ({
  ensureBattleAssets: (_opts: unknown, onProgress?: (done: number, total: number) => void) => {
    onProgress?.(0, 1);
    return new Promise<void>((resolve) => { gate.resolve = () => { onProgress?.(1, 1); resolve(); }; });
  },
}));

// Imported after the mocks (vitest hoists mock registration above all imports regardless of order).
import { PixiAppViews } from '../../src/app/PixiAppViews';
import { createLayout } from '../../src/layout/ScalingManager';
import { Side } from '../../src/game';
import type { ILayout } from '../../src/layout/ILayout';
import type { IPlatform } from '../../src/platform/IPlatform';
import type { ScalingManager } from '../../src/layout/ScalingManager';
import type { SceneManager } from '../../src/scenes/SceneManager';
import type { InputManager } from '../../src/inputSystem/InputManager';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene';
import type { GameSceneCallbacks, GameSceneOptions } from '../../src/scenes/GameScene';

/**
 * `window` stub with DOM add/removeEventListener semantics (a Set, so re-adding the same listener
 * reference is a no-op exactly like the real thing). The harness runs in plain Node with no window
 * global — installed per test rather than at import time so no module in this graph can take a
 * "we're in a browser" branch while it loads.
 */
function installWindow(): { count(type: string): number; fire(type: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  const stub = {
    addEventListener(type: string, cb: () => void): void {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type: string, cb: () => void): void {
      listeners.get(type)?.delete(cb);
    },
  };
  (globalThis as unknown as { window?: unknown }).window = stub;
  return {
    count: (type) => listeners.get(type)?.size ?? 0,
    fire: (type) => { for (const cb of [...(listeners.get(type) ?? [])]) cb(); },
  };
}

interface Harness {
  views: PixiAppViews;
  manager: { goto: ReturnType<typeof vi.fn>; pushOverlay: ReturnType<typeof vi.fn>; popOverlay: ReturnType<typeof vi.fn> };
  renderer: { resize: ReturnType<typeof vi.fn> };
  scaling: { resize: ReturnType<typeof vi.fn> };
  screen: { width: number; height: number };
  win: ReturnType<typeof installWindow>;
  /** The scene instance the Nth mocked constructor produced, in build order. */
  lastGoto(): { scene: { args: unknown[] } & Record<string, unknown>; opts?: { fade?: boolean } };
}

const NO_CB = {} as LobbySceneCallbacks;

function setup(): Harness {
  const win = installWindow();
  const screen = { width: 1280, height: 720 };
  const platform = {
    getScreenSize: () => ({ width: screen.width, height: screen.height }),
    getSafeAreaInsets: () => undefined,
  } as unknown as IPlatform;
  const renderer = { resize: vi.fn() };
  const app = { screen: { width: 1280, height: 720 }, stage: new PIXI.Container(), renderer } as unknown as PIXI.Application;
  const scaling = { resize: vi.fn() };
  const manager = { goto: vi.fn(), pushOverlay: vi.fn(), popOverlay: vi.fn() };
  const input = { suppress: vi.fn() } as unknown as InputManager;
  const layout: ILayout = createLayout(screen.width, screen.height, Side.Bottom);
  const views = new PixiAppViews(
    platform,
    app,
    scaling as unknown as ScalingManager,
    manager as unknown as SceneManager,
    input,
    layout,
  );
  return {
    views, manager, renderer, scaling, screen, win,
    lastGoto: () => {
      const call = last(manager.goto.mock.calls as unknown[][], 'SceneManager.goto call');
      return { scene: call[0], opts: call[1] } as ReturnType<Harness['lastGoto']>;
    },
  };
}

/** Lets an already-resolved promise's .then() callbacks run, without real timers. */
const flushMicrotasks = (): Promise<void> => Promise.resolve().then().then();

/** `arr.at(-1)`, which this project's ES2020 lib doesn't have; throws rather than returning
 *  undefined so a test asserting on "the last thing built" fails loudly if nothing was. */
function last<T>(arr: readonly T[], what: string): T {
  if (arr.length === 0) throw new Error(`expected at least one ${what}, got none`);
  return arr[arr.length - 1];
}

beforeEach(() => {
  built.length = 0;
  samples.length = 0;
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('PixiAppViews — lobby resize listener lifetime', () => {
  it('subscribes on showLobby and unsubscribes on the next non-lobby screen', () => {
    const h = setup();
    expect(h.win.count('resize')).toBe(0);

    h.views.showLobby(NO_CB);
    expect(h.win.count('resize')).toBe(1);

    h.views.showSettings({} as never);
    expect(h.win.count('resize')).toBe(0);
  });

  it('keeps the listener alive across an overlay mount (ADR-044: the lobby is not what is being left)', () => {
    const h = setup();
    h.views.showLobby(NO_CB);
    h.views.showFamily({} as never, { overlay: true });
    expect(h.win.count('resize')).toBe(1);
  });
});

describe('PixiAppViews — resize-driven lobby rebuild', () => {
  // The rebuild is deferred behind REBUILD_COALESCE_MS as of 2026-08-24 (see onResize), so every
  // case here drives timers by hand. The canvas re-fit stays synchronous and is asserted as such.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Longer than REBUILD_COALESCE_MS — "the viewport has settled". */
  const SETTLE = 200;

  it('re-fits the canvas synchronously, then rebuilds through onResized once settled', () => {
    const h = setup();
    const rebuilds: number[] = [];
    h.views.onResized = () => { rebuilds.push(1); h.views.showLobby(NO_CB); };
    h.views.showLobby(NO_CB);

    h.screen.width = 800;
    h.screen.height = 1200;
    h.win.fire('resize');

    // Immediate half: the canvas must track the viewport or it visibly lags a rotation.
    expect(h.renderer.resize).toHaveBeenCalledWith(800, 1200);
    expect(h.scaling.resize).toHaveBeenCalledTimes(1);
    // Deferred half: the expensive scene rebuild has not run yet.
    expect(rebuilds).toEqual([]);

    vi.advanceTimersByTime(SETTLE);
    expect(rebuilds).toEqual([1]);
    // The rebuilt lobby is built against the NEW size, not the boot-time one.
    const rebuilt = last(built.filter((b) => b.name === 'LobbyScene'), 'LobbyScene build');
    expect((rebuilt.args[0] as ILayout).designHeight).toBeGreaterThan((rebuilt.args[0] as ILayout).designWidth);
  });

  it('collapses a whole rotation into ONE rebuild, not one per event', () => {
    // A device rotation fires `resize` repeatedly as iOS reports the viewport progressively through
    // the animation. Rebuilding the lobby on each one meant N full scene teardowns — N rounds of
    // texture churn at the exact moment the WebView is already paying for a drawing-buffer
    // reallocation. On a memory-capped in-app WebView that is a plausible way to get killed outright.
    const h = setup();
    const rebuilds: number[] = [];
    h.views.onResized = () => { rebuilds.push(1); h.views.showLobby(NO_CB); };
    h.views.showLobby(NO_CB);

    for (const [w, hh] of [[900, 1100], [1000, 1000], [1150, 850], [1200, 800]] as const) {
      h.screen.width = w; h.screen.height = hh;
      h.win.fire('resize');
      vi.advanceTimersByTime(40); // mid-animation: inside the coalescing window
    }
    expect(rebuilds).toEqual([]);

    vi.advanceTimersByTime(SETTLE);
    expect(rebuilds).toEqual([1]);
    // Every intermediate size still reached the canvas — only the rebuild was coalesced.
    expect(h.renderer.resize).toHaveBeenCalledTimes(4);
    expect(h.renderer.resize).toHaveBeenLastCalledWith(1200, 800);
  });

  it('ignores a resize event that reports no actual size change', () => {
    // Mobile browsers fire `resize` for things that are not resizes: chrome bars sliding, the
    // on-screen keyboard, scroll-driven toolbar hiding. Each used to rebuild the lobby for nothing.
    const h = setup();
    const rebuilds: number[] = [];
    h.views.onResized = () => { rebuilds.push(1); h.views.showLobby(NO_CB); };
    h.views.showLobby(NO_CB);

    h.win.fire('resize'); // same 1280x720 the harness booted with
    vi.advanceTimersByTime(SETTLE);

    expect(h.renderer.resize).not.toHaveBeenCalled();
    expect(h.scaling.resize).not.toHaveBeenCalled();
    expect(rebuilds).toEqual([]);
  });

  it('cancels a pending rebuild when the player navigates away first', () => {
    // Load-bearing now that the rebuild is deferred: rotate, then immediately tap into another
    // screen, and a queued showLobby() would otherwise fire ~180ms later and yank the player back
    // to the lobby from wherever they had just gone.
    const h = setup();
    const rebuilds: number[] = [];
    h.views.onResized = () => { rebuilds.push(1); h.views.showLobby(NO_CB); };
    h.views.showLobby(NO_CB);

    h.screen.width = 800; h.screen.height = 1200;
    h.win.fire('resize');
    h.views.showSettings({} as never); // leaves the lobby before the rebuild lands

    vi.advanceTimersByTime(SETTLE);
    expect(rebuilds).toEqual([]);
    expect(last(built, 'scene build').name).toBe('SettingsScene');
  });

  it('swaps the rebuilt lobby instantly even when the caller asks for a fade', () => {
    const h = setup();
    h.views.onResized = () => { h.views.showLobby(NO_CB, { fade: true }); };
    h.views.showLobby(NO_CB);
    h.screen.width = 800; h.screen.height = 1200;
    h.win.fire('resize');
    vi.advanceTimersByTime(SETTLE);
    expect(h.lastGoto().opts).toEqual({ fade: false });
  });

  it('honours a fade requested outside a resize', () => {
    const h = setup();
    h.views.showLobby(NO_CB, { fade: true });
    expect(h.lastGoto().opts).toEqual({ fade: true });
  });
});

describe('PixiAppViews — SLG panel mounts', () => {
  it('pushes an overlay instead of gotoing when opts.overlay is set', () => {
    const h = setup();
    h.views.showFamily({} as never, { overlay: true });
    expect(h.manager.pushOverlay).toHaveBeenCalledTimes(1);
    expect(h.manager.goto).not.toHaveBeenCalled();
  });

  it('gotos as a full scene swap without opts.overlay', () => {
    const h = setup();
    h.views.showFamily({} as never);
    expect(h.manager.goto).toHaveBeenCalledTimes(1);
    expect(h.manager.pushOverlay).not.toHaveBeenCalled();
  });

  it('hideOverlay pops the overlay', () => {
    const h = setup();
    h.views.hideOverlay();
    expect(h.manager.popOverlay).toHaveBeenCalledTimes(1);
  });

  it('cross-fades into the world map (one of the few faded transitions)', () => {
    const h = setup();
    h.views.showWorldMap({} as never);
    expect(h.lastGoto().opts).toEqual({ fade: true });
  });

  it('returns a view that forwards to the live WorldMapScene instance', () => {
    const h = setup();
    const view = h.views.showWorldMap({} as never);
    const scene = h.lastGoto().scene as unknown as { refreshMe: ReturnType<typeof vi.fn>; applyNationMsg: ReturnType<typeof vi.fn> };
    view.refreshMe();
    view.applyNationMsg({ kind: 'x' } as never);
    expect(scene.refreshMe).toHaveBeenCalledTimes(1);
    expect(scene.applyNationMsg).toHaveBeenCalledWith({ kind: 'x' });
  });
});

describe('PixiAppViews — scene construction is timed for the ANR channel', () => {
  it('reports every built scene to recordConstructSample under its own name', () => {
    const h = setup();
    h.views.showLobby(NO_CB);
    h.views.showSettings({} as never);
    expect(samples.map((s) => s.name)).toEqual(['LobbyScene', 'SettingsScene']);
    for (const s of samples) expect(Number.isFinite(s.ms)).toBe(true);
  });
});

describe('PixiAppViews — showGameNet', () => {
  const OPTS = {} as GameSceneOptions;
  const CB = {} as GameSceneCallbacks;

  it('builds the joiner a flipped layout and the host an unflipped one', async () => {
    const joiner = setup();
    joiner.views.showGameNet(1, CB, OPTS);
    gate.resolve();
    await flushMicrotasks();
    expect((last(built, 'scene build').args[0] as ILayout).localSide).toBe(Side.Top);

    built.length = 0;
    const host = setup();
    host.views.showGameNet(0, CB, OPTS);
    gate.resolve();
    await flushMicrotasks();
    expect((last(built, 'scene build').args[0] as ILayout).localSide).toBe(Side.Bottom);
  });

  it('buffers server pushes that land while the asset gate is still open, then flushes them in order', async () => {
    const h = setup();
    const view = h.views.showGameNet(0, CB, OPTS);
    await flushMicrotasks();
    expect(built).toHaveLength(0); // gate still open — no GameScene yet

    view.applyNetState({ tag: 'a' } as never);
    view.applyPeerDc({ tag: 'b' } as never);

    gate.resolve();
    await flushMicrotasks();

    const scene = h.lastGoto().scene as unknown as {
      applyNetState: ReturnType<typeof vi.fn>;
      applyPeerDc: ReturnType<typeof vi.fn>;
      applyMatchOver: ReturnType<typeof vi.fn>;
    };
    expect(scene.applyNetState).toHaveBeenCalledWith({ tag: 'a' });
    expect(scene.applyPeerDc).toHaveBeenCalledWith({ tag: 'b' });

    // Post-gate pushes go straight through to the same scene.
    view.applyMatchOver({ tag: 'c' } as never);
    expect(scene.applyMatchOver).toHaveBeenCalledWith({ tag: 'c' });
  });
});
