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
import type { SaveData } from '../../src/game/meta/SaveData';
import { teamSlotId } from '../../src/game/meta/teamTroops';

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

type Rect = { x: number; y: number; w: number; h: number };
type Hit = { rect: Rect; fn: () => void };

type CoreInternals = {
  w: number; h: number;
  container: PIXI.Container;
  paint: {
    staticLayer: PIXI.Container;
    pageLayer: PIXI.Container;
    modalLayer: PIXI.Container;
    busyLayer: PIXI.Container;
  };
  guide: { currentAction(): Hit | null };
  selectedBuilding: BuildingKey | null;
  selectedTrain: boolean;
  hits: Hit[];
  bt: { busy: boolean; loadingVisible: boolean };
  render(): void;
  paintModal(): void;
  doUpgrade(key: BuildingKey): Promise<void>;
  doSpeedup(key: BuildingKey): Promise<void>;
  doTrain(qty: number): Promise<void>;
  doSpeedupTraining(coins: number): Promise<void>;
  doFillAllTeams(): Promise<void>;
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
 * A scene whose `endpoint` never resolves, so the in-flight window stays open for as long as the
 * test needs it. Everything else answers immediately. `extraMe` lets a case add whatever `me`
 * fields its action checks before it reaches the network (a queue entry, a troop pool, …).
 */
function buildForAction(endpoint: string, extraMe: Record<string, unknown> = {}): Harness {
  const hang = (): Promise<never> => new Promise<never>(() => {});
  const me = meFixture(extraMe as Partial<PlayerWorldView>);
  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([
      { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] },
    ]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: hang, speedupBuild: hang, trainTroops: hang,
    speedupTraining: hang, distributeTroops: hang,
  } as unknown as Record<string, unknown>;
  // Only the endpoint under test hangs; the rest would be a bug to reach anyway.
  for (const k of ['upgradeBuilding', 'speedupBuild', 'trainTroops', 'speedupTraining', 'distributeTroops']) {
    if (k !== endpoint) worldApi[k] = () => Promise.resolve(me);
  }
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi: worldApi as unknown as WorldApiClient,
    worldId: 'world:1:0',
    getCoins: () => 99999,
    refreshWallet: async () => {},
    getSave: () => ({
      cardInv: { c1: { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false } },
      equipmentInv: {},
    } as unknown as SaveData),
    getFlag: () => true,
    setFlag: () => {},
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  return {
    scene, inner: internals(scene),
    resolveUpgrade: () => {}, refreshWalletCalls: () => 0, fireSaveChanged: () => {},
  };
}

/** A scene whose guide flags are backed by `seen`, so the opening-guide chain is live. */
function buildWithFlags(seen: Set<string>): Harness {
  const me = meFixture();
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi: {
      getMe: () => Promise.resolve(me),
      getTeams: () => Promise.resolve([]),
      getMarches: () => Promise.resolve([]),
      getOccupations: () => Promise.resolve([]),
      getStationed: () => Promise.resolve([]),
      upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    } as unknown as WorldApiClient,
    worldId: 'world:1:0',
    getCoins: () => 99999,
    getSave: () => ({ cardInv: {}, equipmentInv: {} } as unknown as SaveData),
    getFlag: (k) => seen.has(k),
    setFlag: (k, v) => { if (v) seen.add(k); else seen.delete(k); },
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  return {
    scene, inner: internals(scene),
    resolveUpgrade: () => {}, refreshWalletCalls: () => 0, fireSaveChanged: () => {},
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

// ── The pre-flight-paint contract, across ALL five network actions ───────────────────────────
//
// The coalescing block above exercises doUpgrade only. That left the other four free to grow a
// pre-flight paint back without anything going red — mutation-checked: adding `requestRender()`
// after `bt.start()` in doTrain passed all 2439 UI tests. The contract is per-action, so the test
// is too.
describe('CityScene actions never paint before the server has answered', () => {
  interface ActionCase {
    name: string;
    /** Endpoint this action calls; the harness makes it hang so the in-flight window stays open. */
    endpoint: string;
    /** Extra `me` fields the action needs to get past its own guards. */
    me?: Record<string, unknown>;
    run(inner: CoreInternals): Promise<void>;
  }

  const CASES: ActionCase[] = [
    { name: 'doUpgrade', endpoint: 'upgradeBuilding', run: (i) => i.doUpgrade('inkPot') },
    {
      name: 'doSpeedup',
      endpoint: 'speedupBuild',
      // Needs a queue entry with time left, or doSpeedup returns before it ever starts.
      me: { buildQueue: [{ key: 'inkPot', toLevel: 3, completeAt: Date.now() + 3600_000 }] },
      run: (i) => i.doSpeedup('inkPot'),
    },
    { name: 'doTrain', endpoint: 'trainTroops', run: (i) => i.doTrain(100) },
    { name: 'doSpeedupTraining', endpoint: 'speedupTraining', run: (i) => i.doSpeedupTraining(5) },
    {
      name: 'doFillAllTeams',
      endpoint: 'distributeTroops',
      // Needs a placed card with a troop gap and a non-empty pool, or it toasts and returns before
      // `bt.start()` — see doFillAllTeams's early "nothing to allocate" branch.
      me: { troops: 500, cardState: { c1: { currentTroops: 0 } } },
      run: (i) => i.doFillAllTeams(),
    },
  ];

  for (const c of CASES) {
    it(`${c.name} paints nothing while its request is in flight`, async () => {
      const h = buildForAction(c.endpoint, c.me);
      await flush();
      const before = h.inner.paint.pageLayer.children.slice();
      expect(before.length).toBeGreaterThan(0);

      void c.run(h.inner);
      await flush();
      expect(h.inner.bt.busy).toBe(true); // the request really is open

      // Frames keep arriving while it is open. None of them may repaint, and none may raise the
      // dim either (this is all well inside BusyTracker's 1 s threshold).
      for (let i = 0; i < 8; i++) h.scene.update(0.016);
      expect(isSameTree(h.inner.paint.pageLayer, before)).toBe(true);
      expect(before.every((x) => !x.destroyed)).toBe(true);
      expect(h.inner.paint.busyLayer.children.length).toBe(0);
      h.scene.destroy();
    });
  }
});

// ── The guide ring's replay closure ──────────────────────────────────────────────────────────
//
// cityGuideChain.ui.ts covers the ring across a full `render()`. It cannot cover THIS: a real
// dismissal goes through `paintModal()` alone and repaints nothing else, so the ring has to come
// back from `paint.guideRestore` rather than from a page paint that happens to re-decide it.
// Mutation-checked: moving the restore call into paintPage (so the ring returns only on a page
// repaint) passed all 2439 UI tests.
describe('CityScene guide ring survives a modal-only open/dismiss', () => {
  /** The grid-tile hit, identified by the closure it was pushed with (render.ts's tile handler). */
  function tileHit(inner: CoreInternals): Hit {
    const h = inner.hits.find((x) => x.fn.toString().includes('selectedBuilding = tile.key'));
    expect(h).toBeDefined();
    return h!;
  }

  it('comes back on dismissal without repainting the page underneath', async () => {
    const seen = new Set<string>(['guide.world.step2']); // step2 done → step3 (Back) is pending
    const h = buildWithFlags(seen);
    await flush();

    expect(h.inner.guide.currentAction()).not.toBeNull(); // step3 ring is up
    const page = h.inner.paint.pageLayer.children.slice();

    // Open through the real grid-tile hit, which calls paintModal() — not render().
    tileHit(h.inner).fn();
    expect(h.inner.selectedBuilding).not.toBeNull();
    expect(h.inner.guide.currentAction()).toBeNull(); // a modal supersedes the ring outright
    expect(isSameTree(h.inner.paint.pageLayer, page)).toBe(true);

    // Dismiss through the modal's own tap-outside hit — also paintModal() alone.
    h.inner.hits[h.inner.hits.length - 1]!.fn();
    expect(h.inner.selectedBuilding).toBeNull();
    expect(h.inner.guide.currentAction()).not.toBeNull(); // ring is back…
    expect(isSameTree(h.inner.paint.pageLayer, page)).toBe(true); // …and the page never moved
    expect(page.every((x) => !x.destroyed)).toBe(true);
    h.scene.destroy();
  });

  it('re-decides which step to ring, rather than replaying a stale one', async () => {
    const seen = new Set<string>(); // nothing seen → step2 rings the first grid card
    const h = buildWithFlags(seen);
    await flush();
    const step2Rect = { ...h.inner.guide.currentAction()!.rect };

    // Opening a card marks step2 seen (the hit does it), so the ring that comes back on dismissal
    // must be step3's on Back — not the grid-card ring the closure was originally built against.
    tileHit(h.inner).fn();
    expect(seen.has('guide.world.step2')).toBe(true);
    h.inner.hits[h.inner.hits.length - 1]!.fn(); // dismiss

    const back = h.inner.hits[0]!.rect;
    const now = h.inner.guide.currentAction();
    expect(now).not.toBeNull();
    expect(now!.rect).not.toEqual(step2Rect);
    expect(Math.abs(now!.rect.y - back.y)).toBeLessThan(400); // anchored to the header, not the grid
    h.scene.destroy();
  });
});

// ── Modal churn must not leak Text textures ──────────────────────────────────────────────────
//
// `beginModal()` uses tearDownChildren, not removeChildren: a plain remove leaves each Text's
// baseTexture orphaned — the §mem-leak class this scene already pays for once per close, and the
// modal layer is now the thing that churns most (opening and dismissing no longer rebuilds the
// page, so this teardown is the only one that runs). Asserted on the outcome
// (`baseTexture.destroyed`), like campaignMapTextTeardown.ui.ts, so it holds regardless of which
// helper does the freeing. Mutation-checked: swapping in removeChildren() passed all 2439 UI tests.
describe('CityScene modal teardown frees its Text textures', () => {
  function textTextures(root: PIXI.Container): PIXI.BaseTexture[] {
    const out: PIXI.BaseTexture[] = [];
    (function walk(c: PIXI.Container): void {
      for (const ch of c.children) {
        if (ch instanceof PIXI.Text) out.push(ch.texture.baseTexture);
        if (ch instanceof PIXI.Container) walk(ch);
      }
    })(root);
    return out;
  }

  it('frees the outgoing modal textures on dismissal, on every open/close round', async () => {
    const h = build();
    await flush();
    const pageTextures = textTextures(h.inner.paint.pageLayer);
    expect(pageTextures.length).toBeGreaterThan(0);

    for (let round = 0; round < 3; round++) {
      h.inner.selectedBuilding = 'inkPot';
      h.inner.paintModal();
      const modalTextures = textTextures(h.inner.paint.modalLayer);
      expect(modalTextures.length).toBeGreaterThan(0);
      expect(modalTextures.some((t) => t.destroyed)).toBe(false);

      h.inner.hits[h.inner.hits.length - 1]!.fn(); // tap-outside dismiss
      expect(h.inner.paint.modalLayer.children.length).toBe(0);
      expect(modalTextures.every((t) => t.destroyed)).toBe(true);
      // The page standing behind it keeps every one of its own — it was never torn down.
      expect(pageTextures.some((t) => t.destroyed)).toBe(false);
    }
    h.scene.destroy();
  });
});
