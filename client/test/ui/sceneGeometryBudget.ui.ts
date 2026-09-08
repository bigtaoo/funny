// A per-frame geometry budget for the screen players sit on longest.
//
// The regression this gate exists for (measured 2026-09-08 in real Chrome): the idle lobby was
// submitting 253,737 indices per frame — 82% of it four hand-drawn panel borders that never moved.
// `SketchPen.trace` needs a fresh `lineStyle` per segment for its taper, and with round caps and
// joins one 976x105 panel came out as 735 un-batchable primitives and 68,496 indices. Nothing was
// wrong with the code in review; it just looked like every other `SketchPen` call in the repo.
//
// So the guard is a NUMBER, not a rule about which helper to call. `render/panelFrame.ts`'s baked
// atlas is the cheap way to draw that same wobble, and any future frame drawn the expensive way —
// whichever helper it goes through — pushes this over budget and fails.
//
// How the count is taken: PIXI builds `Graphics` geometry (earcut + `buildLine`) in pure JS inside
// `GraphicsGeometry.updateBatches()`, which the renderer calls during a paint. There is no renderer
// in this harness, so the test calls it directly — that is what makes an exact triangle count
// available in CI with no GPU. `bake()` is given a stub renderer so the shipped (atlas) path is the
// one measured; without one every panel would fall back to live strokes and the budget would be
// measuring the fallback instead of the product.
//
// Run: npm run test:ui

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { SketchPen } from '../../src/render/sketch';
import { clearBakeCache, setBakeRenderer } from '../../src/render/bake';
import { sketchPanel } from '../../src/render/sketchUi';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/**
 * Budget for one lobby paint, in indices (3 per triangle).
 *
 * Measured 15,582 in this harness after the fix. The budget sits above that with room for ordinary
 * UI work, and well below what ONE page-wide live-stroked panel costs (39,786 here — the case below
 * asserts exactly that), so the step change this exists to catch cannot slip under it. Raise it only
 * with a measurement saying the new geometry is genuinely needed.
 */
const LOBBY_INDEX_BUDGET = 25_000;

/** The lobby's own hero panel, as laid out on a 1280x631 desktop canvas — the 68,496-index one. */
const HERO_PANEL = { w: 976, h: 105 } as const;

/** Enough of a renderer for `bake()`: it reads `.resolution` and calls `.render()`. */
function stubBakeRenderer(): void {
  setBakeRenderer({ resolution: 1, render: () => {} } as unknown as PIXI.IRenderer);
}

/** Indices PIXI would submit for this subtree, with every `Graphics` geometry built on the spot. */
function indexCount(root: PIXI.Container): number {
  let total = 0;
  const visit = (o: PIXI.DisplayObject): void => {
    const geom = (o as PIXI.Graphics).geometry as (PIXI.Graphics['geometry'] | undefined);
    if (geom && typeof geom.updateBatches === 'function') {
      geom.updateBatches();
      total += geom.indices.length;
    }
    const kids = (o as PIXI.Container).children;
    if (kids) for (const k of kids) visit(k);
  };
  visit(root);
  return total;
}

function buildLobby(): LobbyScene {
  return new LobbyScene(createLayout(1280, 631), new InputManager(), {
    onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
    onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
    onOpenWorld() {}, onOpenLeaderboard() {},
    pvp: { rank: 'gold', elo: 1425 },
    playerName: 'Tester',
  });
}

beforeEach(() => {
  clearBakeCache();
  stubBakeRenderer();
});

afterEach(() => {
  clearBakeCache();
  setBakeRenderer(null as unknown as PIXI.IRenderer);
});

describe('lobby per-frame geometry', () => {
  it('stays inside the budget', () => {
    const lobby = buildLobby();
    const indices = indexCount(lobby.container);
    // Reported on failure: the number is the whole point of this test.
    expect(indices, `lobby geometry = ${indices} indices (budget ${LOBBY_INDEX_BUDGET})`)
      .toBeLessThan(LOBBY_INDEX_BUDGET);
    lobby.destroy();
  });

  it('would fail if a single page-wide panel went back to live strokes (the gate can fire)', () => {
    // A gate nobody has seen fail is not a gate. This is the exact call the lobby used to make for
    // its hero button, on the exact size it laid out — one of them is over budget on its own.
    const live = new PIXI.Graphics();
    live.beginFill(0x2c2c2a).drawRect(0, 0, HERO_PANEL.w, HERO_PANEL.h).endFill();
    new SketchPen(live, 5).rect(2, 2, HERO_PANEL.w - 4, HERO_PANEL.h - 4, {
      color: 0x4477cc, width: 2.4, jitter: 1.0,
    });
    expect(indexCount(live)).toBeGreaterThan(LOBBY_INDEX_BUDGET);
  });

  it('the baked panel draws the same frame for a rounding error of the cost', () => {
    const baked = sketchPanel(HERO_PANEL.w, HERO_PANEL.h, { fill: 0x2c2c2a, border: 0x4477cc, width: 2.4 });
    // Sprites off the atlas baseTexture, so the only geometry left is the flat fill rect.
    expect(indexCount(baked)).toBeLessThan(100);
    // ...and it is a real frame, not an empty container that trivially costs nothing.
    expect(baked.children.length).toBeGreaterThan(4);
  });

  // There is deliberately no "falls back to live strokes without a bake renderer" case here:
  // panelFrame.ts caches its sliced atlas at module level, so once ANY earlier test in the file has
  // built it, clearing bake.ts's cache no longer forces the fallback. That path is covered anyway —
  // every other test in this suite runs with no bake renderer at all.
});
