// Regression coverage for CityScene's render-coalescing / layer-split pass (2026-09-02).
//
// Why: the scene was one immediate-mode tree that every render() tore down and rebuilt — roughly
// 80 `PIXI.Text` re-rastered and re-uploaded per pass. A single "upgrade" or "speed up" tap fired
// three or four of those passes (pre-flight busy overlay → refreshWallet's onSaveChanged → the
// post-stop repaint), and because the in-flight dim was gated on `bt.busy` rather than on
// BusyTracker's own 1-second `loadingVisible` threshold, a 30–80 ms round trip flashed a
// full-screen wash on and back off within two or three frames. The player's report was that the
// whole page blinks on every tap in the build modal.
//
// What is pinned here, in the order it matters:
//   1. no full-screen dim for a fast action, and none until BusyTracker's 1 s threshold;
//   2. one paint per action, not three — asserted on the actual paint, not on a spy of a method
//      the action could stop calling;
//   3. a modal opening/dismissing leaves the page layer's display objects untouched;
//   4. the paper/decor layer is built once for the scene's whole life.
//
// (2) and (3) are the load-bearing ones: they are what makes the tap cheap, and they are stated as
// "these exact display objects are still the ones on screen", which no amount of internal
// refactoring can satisfy accidentally.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];

type CoreInternals = {
  w: number; h: number;
  container: PIXI.Container;
  paint: {
    staticLayer: PIXI.Container;
    pageLayer: PIXI.Container;
    modalLayer: PIXI.Container;
  };
  selectedBuilding: BuildingKey | null;
  selectedTrain: boolean;
  hits: Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
  bt: { busy: boolean; loadingVisible: boolean };
  render(): void;
  paintModal(): void;
  doUpgrade(key: BuildingKey): Promise<void>;
};

function internals(scene: CityScene): CoreInternals {
  return (scene as unknown as { core: CoreInternals }).core;
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

/**
 * `me` with a desk at Lv.10 (clears the desk-level gate, so a building modal reaches its real
 * upgrade row) and enough of every resource to afford the upgrade.
 */
function meFixture(over: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return {
    resources: { ink: 9e6, paper: 9e6, graphite: 9e6, metal: 9e6, sticker: 9e6 },
    buildings: { desk: 10, inkPot: 2 },
    buildQueue: [], trainingQueue: [], cardState: {}, teamState: {},
    yieldRate: {}, troops: 0,
    ...over,
  } as unknown as PlayerWorldView;
}

interface Harness {
  scene: CityScene;
  inner: CoreInternals;
  /** Resolves the pending upgradeBuilding call with a `me` carrying the new queue entry. */
  resolveUpgrade: () => void;
  refreshWalletCalls: () => number;
  /** Fires the SaveManager change listener CityScene subscribes to, as refreshWallet's would. */
  fireSaveChanged: () => void;
}

function build(): Harness {
  let releaseUpgrade: (() => void) | null = null;
  let saveChanged: (() => void) | null = null;
  let walletCalls = 0;
  const worldApi = {
    getMe: () => Promise.resolve(meFixture()),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () =>
      new Promise<PlayerWorldView>((res) => {
        releaseUpgrade = (): void =>
          res(meFixture({
            buildQueue: [{ key: 'inkPot', toLevel: 3, completeAt: Date.now() + 3600_000 }],
          } as unknown as Partial<PlayerWorldView>));
      }),
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi,
    worldId: 'world:1:0',
    refreshWallet: async () => { walletCalls++; saveChanged?.(); },
    onSaveChanged: (l) => { saveChanged = l; return () => { saveChanged = null; }; },
    // Keep the SLG opening guide chain's ring and skip glyph out of the way entirely.
    getFlag: () => true,
    setFlag: () => {},
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  return {
    scene,
    inner: internals(scene),
    resolveUpgrade: () => releaseUpgrade?.(),
    refreshWalletCalls: () => walletCalls,
    fireSaveChanged: () => saveChanged?.(),
  };
}

/**
 * Whether `layer` still holds exactly the display objects in `snapshot`, same order — i.e. it has
 * not been repainted. Compared by identity, deliberately: `expect(children).toEqual(snapshot)`
 * walks a PIXI DisplayObject's circular parent/children/transform graph and, on a FAILING
 * assertion, exhausts the V8 heap building the diff (seen while mutation-testing this file).
 */
function isSameTree(layer: PIXI.Container, snapshot: PIXI.DisplayObject[]): boolean {
  return (
    layer.children.length === snapshot.length &&
    snapshot.every((c, i) => layer.children[i] === c)
  );
}

/** Every full-screen (or near) opaque-ish dim rect currently in the tree, by area. */
function fullScreenDims(inner: CoreInternals): PIXI.Graphics[] {
  const out: PIXI.Graphics[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Graphics) {
        const b = ch.getBounds();
        if (b.width >= inner.w * 0.95 && b.height >= inner.h * 0.95) out.push(ch);
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(inner.container);
  return out;
}

describe('CityScene in-flight dim (the page-blink report, 2026-09-02)', () => {
  it('puts up no dim at all for an action that resolves inside BusyTracker\'s 1 s threshold', async () => {
    const h = build();
    await flush();
    const before = fullScreenDims(h.inner).length;

    const pending = h.inner.doUpgrade('inkPot');
    await flush();
    // The request is still in flight — this is exactly the window that used to flash. Ticking real
    // frames through it is what makes this test bite: the overlay is synced from update(), so
    // gating it back on `bt.busy` only shows up once frames actually arrive mid-flight (as they
    // always do in production; ~130 ms here, well inside BusyTracker's 1 s threshold).
    expect(h.inner.bt.busy).toBe(true);
    for (let i = 0; i < 8; i++) h.scene.update(0.016);
    expect(h.inner.bt.loadingVisible).toBe(false);
    expect(fullScreenDims(h.inner).length).toBe(before);

    h.resolveUpgrade();
    await pending;
    h.scene.update(0.016);
    expect(fullScreenDims(h.inner).length).toBe(before);
    h.scene.destroy();
  });

  it('shows the dim once the request has been in flight for a second, and takes it down on completion', async () => {
    const h = build();
    await flush();
    const before = fullScreenDims(h.inner).length;

    const pending = h.inner.doUpgrade('inkPot');
    await flush();
    h.scene.update(1.1); // crosses BusyTracker's loadingVisible threshold
    expect(h.inner.bt.loadingVisible).toBe(true);
    expect(fullScreenDims(h.inner).length).toBe(before + 1);

    h.resolveUpgrade();
    await pending;
    h.scene.update(0.016);
    expect(fullScreenDims(h.inner).length).toBe(before);
    h.scene.destroy();
  });

  it('keeps blocking input while busy even with no dim on screen (the dim never carried that job)', async () => {
    const h = build();
    await flush();
    const pending = h.inner.doUpgrade('inkPot');
    await flush();

    // A second call is dropped by the bt.busy guard, not by anything the overlay does.
    await h.inner.doUpgrade('inkPot');
    expect(h.inner.bt.busy).toBe(true);
    h.resolveUpgrade();
    await pending;
    h.scene.destroy();
  });
});

describe('CityScene paint coalescing', () => {
  it('repaints the page exactly once for an upgrade, however many requests the action makes', async () => {
    const h = build();
    await flush();
    const firstPass = h.inner.paint.pageLayer.children.slice();
    expect(firstPass.length).toBeGreaterThan(0);

    const pending = h.inner.doUpgrade('inkPot');
    await flush();
    // Frames keep arriving while the request is in flight, so tick a few short of BusyTracker's
    // 1 s threshold — nothing may repaint across them. No pre-flight paint was requested, and the
    // server's answer is not in `me` yet either, so there is nothing new to draw.
    for (let i = 0; i < 8; i++) h.scene.update(0.016);
    expect(isSameTree(h.inner.paint.pageLayer, firstPass)).toBe(true);
    expect(firstPass.every((c) => !c.destroyed)).toBe(true);

    h.resolveUpgrade();
    await pending;
    // Two repaint requests are outstanding here in the speed-up shape of this path (the action's
    // own, plus onSaveChanged's from refreshWallet) — simulate the second explicitly, since
    // upgradeBuilding itself does not touch the wallet.
    h.fireSaveChanged();
    expect(isSameTree(h.inner.paint.pageLayer, firstPass)).toBe(true); // nothing paints outside a frame

    h.scene.update(0.016);
    const afterTick = h.inner.paint.pageLayer.children.slice();
    // One paint happened: the children are all new objects, and the old ones were torn down.
    expect(isSameTree(h.inner.paint.pageLayer, firstPass)).toBe(false);
    expect(firstPass.every((c) => c.destroyed)).toBe(true);

    // A second frame with nothing owed must not paint again — that is the whole coalescing claim.
    h.scene.update(0.016);
    expect(isSameTree(h.inner.paint.pageLayer, afterTick)).toBe(true);
    h.scene.destroy();
  });

  it('does not paint on an idle frame', async () => {
    const h = build();
    await flush();
    const kids = h.inner.paint.pageLayer.children.slice();
    for (let i = 0; i < 10; i++) h.scene.update(0.016);
    expect(isSameTree(h.inner.paint.pageLayer, kids)).toBe(true);
    expect(kids.every((c) => !c.destroyed)).toBe(true);
    h.scene.destroy();
  });
});

describe('CityScene layer split', () => {
  it('leaves the page layer standing when a modal opens and when it is dismissed', async () => {
    const h = build();
    await flush();
    const page = h.inner.paint.pageLayer.children.slice();
    expect(h.inner.paint.modalLayer.children.length).toBe(0);

    h.inner.selectedBuilding = 'inkPot';
    h.inner.paintModal();
    expect(h.inner.paint.modalLayer.children.length).toBeGreaterThan(0);
    // The page behind is the SAME display objects — not a rebuilt look-alike.
    expect(isSameTree(h.inner.paint.pageLayer, page)).toBe(true);
    expect(page.every((c) => !c.destroyed)).toBe(true);

    // Dismiss via the modal's own tap-outside hit (pushed last, covering the screen).
    h.inner.hits[h.inner.hits.length - 1]!.fn();
    expect(h.inner.selectedBuilding).toBeNull();
    expect(h.inner.paint.modalLayer.children.length).toBe(0);
    expect(isSameTree(h.inner.paint.pageLayer, page)).toBe(true);
    expect(page.every((c) => !c.destroyed)).toBe(true);
    h.scene.destroy();
  });

  it('restores the page\'s own hits when a modal is dismissed, Back still first', async () => {
    const h = build();
    await flush();
    const pageHitCount = h.inner.hits.length;
    const backFn = h.inner.hits[0]!.fn;
    expect(pageHitCount).toBeGreaterThan(2);

    h.inner.selectedBuilding = 'inkPot';
    h.inner.paintModal();
    // Modal up: Back plus the modal's own buttons only — every page hit is dropped so a tap on the
    // dimmed page cannot fall through to it.
    expect(h.inner.hits.length).toBeLessThan(pageHitCount);
    expect(h.inner.hits[0]!.fn).toBe(backFn);

    h.inner.hits[h.inner.hits.length - 1]!.fn();
    expect(h.inner.hits.length).toBe(pageHitCount);
    expect(h.inner.hits[0]!.fn).toBe(backFn);
    h.scene.destroy();
  });

  it('builds the paper/decor layer once for the scene\'s whole life', async () => {
    const h = build();
    await flush();
    const paper = h.inner.paint.staticLayer.children.slice();
    expect(paper.length).toBeGreaterThan(0);

    h.inner.render();
    h.inner.render();
    h.inner.selectedBuilding = 'inkPot';
    h.inner.paintModal();
    h.inner.render();

    expect(isSameTree(h.inner.paint.staticLayer, paper)).toBe(true);
    expect(paper.every((c) => !c.destroyed)).toBe(true);
    h.scene.destroy();
  });

  it('keeps the modal layer above the page layer (a modal must not paint under the page)', async () => {
    const h = build();
    await flush();
    const kids = h.inner.container.children;
    expect(kids.indexOf(h.inner.paint.staticLayer)).toBeLessThan(kids.indexOf(h.inner.paint.pageLayer));
    expect(kids.indexOf(h.inner.paint.pageLayer)).toBeLessThan(kids.indexOf(h.inner.paint.modalLayer));
    h.scene.destroy();
  });
});
