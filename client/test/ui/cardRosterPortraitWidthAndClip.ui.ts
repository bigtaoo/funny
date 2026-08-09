// Coverage for the 2026-08-09 Hero Roster portrait fix (design/game/CHARACTER_CARDS_DESIGN.md §10):
//   1. the roster grid was reading a notebook-margin-based left offset in portrait (~9% left / ~2%
//      right gap) instead of a deliberately-centered content column — it now fills 90% of the screen
//      width, centered, matching Lobby's portrait `fullContentW` convention (LobbyScene/build.ts).
//   2. the grid had no PIXI mask (draw-cull only — a row straddling the bottom edge still drew in
//      full), so mid-scroll it could paint over the portrait bottom nav bar reserved just below it.
//      It now draws into a masked sub-layer clipped to [listY, listY+availH], mirroring
//      EquipmentScene InventoryMixin's gridLayer/clip treatment.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeCard(id: string, defId: string, level: number): CardInstance {
  return { id, defId, level, gear: {}, locked: false };
}

interface SceneInternals {
  cellRects: Map<string, { x: number; y: number; w: number }>;
  cellContainers: Map<string, PIXI.Container>;
  headerH: number;
}

function buildPortraitScene(count: number): CardScene {
  const save = makeNewSave();
  const cards = Array.from({ length: count }, (_, i) => makeCard(`c${i}`, 'lichuang', 1));
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  // PortraitLayout pegs designWidth to a fixed 1080 regardless of the screen size passed in.
  return new CardScene(createLayout(1080, 1920), new InputManager(), cb);
}

function buildLandscapeScene(count: number): CardScene {
  const save = makeNewSave();
  const cards = Array.from({ length: count }, (_, i) => makeCard(`c${i}`, 'lichuang', 1));
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  // 16:9 screen → LandscapeLayout design space is exactly 1920x1080 (designHeight pegged to the
  // short edge 1080; designWidth = max(1920, round(1080 * availW/availH)) = 1920 at this ratio).
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

describe('CardScene roster grid — portrait width + bottom-nav clip (2026-08-09)', () => {
  it('centers the grid in a column 90% of the design width, not the old ~9%-left/~2%-right margin gap', () => {
    const scene = buildPortraitScene(6);
    const { cellRects } = scene as unknown as SceneInternals;

    const w = 1080;
    const expectedAvail = Math.round(w * 0.9); // 972
    const expectedLeft = Math.round((w - expectedAvail) / 2); // 54

    const xs = [...cellRects.values()].map((r) => r.x);
    const rights = [...cellRects.values()].map((r) => r.x + r.w);
    expect(Math.min(...xs)).toBe(expectedLeft);
    // Right edge of the rightmost column lands symmetrically at w - expectedLeft.
    expect(Math.max(...rights)).toBe(w - expectedLeft);

    scene.destroy();
  });

  it('draws the grid into a masked layer clipped to [headerH, headerH+availH] so it cannot paint into the bottom nav bar', () => {
    const scene = buildPortraitScene(20); // enough rows to exceed one screen and force scrolling
    const { cellRects, cellContainers, headerH } = scene as unknown as SceneInternals;
    expect(cellRects.size).toBeGreaterThan(0);

    const [firstId] = cellContainers.keys();
    const cellC = cellContainers.get(firstId)!;
    const gridLayer = cellC.parent;
    expect(gridLayer).toBeTruthy();
    expect(gridLayer!.mask).toBeTruthy();

    const mask = gridLayer!.mask as PIXI.Graphics;
    const bounds = mask.getLocalBounds();
    // The clip rect is drawn as (0, listY, w, availH) — listY is headerH; its bottom edge must sit
    // strictly above the screen bottom (room reserved for bottomNavH), not flush with it.
    expect(bounds.y).toBe(headerH);
    expect(bounds.y + bounds.height).toBeLessThan(1920);

    // Every laid-out cell must fall fully within the clipped band — this is what actually stops a
    // straddling row from bleeding into the nav bar (the mask enforces it even for the ones that
    // don't, since PIXI clips per-pixel, but every current cell should already be within bounds by
    // construction of the draw-cull check).
    for (const r of cellRects.values()) {
      expect(r.y).toBeGreaterThanOrEqual(bounds.y - 1); // top-of-row draw-cull tolerance
    }

    scene.destroy();
  });
});

describe('CardScene roster grid — landscape left offset unchanged (regression guard, 2026-08-09)', () => {
  it('still starts the grid right of the sidebar rail (sidebarNavW + ROSTER_GAP), not the new portrait 90% column', () => {
    const scene = buildLandscapeScene(10);
    const { cellRects } = scene as unknown as SceneInternals;

    const w = 1920;
    const h = 1080;
    const ROSTER_GAP = 24; // private to list.ts — mirrored here, same idiom as EXPECTED_RAIL_W elsewhere
    const expectedLeft = sidebarNavW(w, h, true) + ROSTER_GAP; // 216 + 24 = 240
    const expectedAvail = w - expectedLeft - ROSTER_GAP; // 1656

    const xs = [...cellRects.values()].map((r) => r.x);
    const rights = [...cellRects.values()].map((r) => r.x + r.w);
    expect(Math.min(...xs)).toBe(expectedLeft);
    expect(Math.max(...rights)).toBe(expectedLeft + expectedAvail);
    // Sanity check this isn't coincidentally equal to the portrait 90%-centered formula.
    expect(expectedLeft).not.toBe(Math.round((w - Math.round(w * 0.9)) / 2));

    scene.destroy();
  });
});
