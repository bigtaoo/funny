// Regression coverage for the "Skins" tab folded into CardScene when CollectionScene was retired
// (LOBBY_IA_REDESIGN §15 / ADR-038): tapping the Skins sidebar tab switches content, and tapping an
// owned skin tile calls back with the correct (unitType, skinId) pair — not the old single global slot.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); tabs/tiles are located by
// their rendered label text (not by hit-array index), same convention as shopGroupTabs.ui.ts.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import { UnitType } from '../../src/game/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: node.x, y: node.y }; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function tap(scene: { container: PIXI.Container }, label: string): void {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hitRects: Hit[] }).hitRects;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under label "${label}"`).toBeDefined();
  hit!.action();
}

describe('CardScene — Skins tab (folded in from the retired CollectionScene)', () => {
  it('switches to the skins tab and equips a skin on the correct character', () => {
    const save = makeNewSave();
    let equipped: Record<string, string> = {};
    const equipCalls: Array<{ unitType: UnitType; skinId: string | null }> = [];
    const cb: CardCallbacks = {
      onBack() {},
      getSave: () => save,
      feedCards: async () => ({ ok: true }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => ['skin_e1'],
      getEquippedSkin: (unitType) => equipped[unitType] ?? null,
      equipSkin: (unitType, skinId) => {
        equipCalls.push({ unitType, skinId });
        if (skinId === null) delete equipped[unitType]; else equipped[unitType] = skinId;
      },
    };
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);

    tap(scene, t('roster.tab.skins'));
    tap(scene, 'skin_e1');

    expect(equipCalls).toEqual([{ unitType: UnitType.Lena, skinId: 'skin_e1' }]);
  });
});

// Regression coverage for the 2026-07-15 redesign: the Skins tab used to stack one full-width row
// per character top-to-bottom (leaving most of a wide screen empty) with no scroll clipping at all.
// It's now a 2-column masonry card grid (CardScene/skins.ts) reusing the base class's scrollY/
// drawScrollIndicator plumbing (same pattern as the roster grid in list.ts).
describe('CardScene — Skins tab card grid layout', () => {
  function buildSkinsScene(input: InputManager, layout = createLayout(1920, 1080)): CardScene {
    const cb: CardCallbacks = {
      onBack() {},
      getSave: () => makeNewSave(),
      feedCards: async () => ({ ok: true }),
      setCardLock: async () => ({ ok: true }),
      // One owned skin per character — every character's card renders exactly 2 tiles
      // (default + owned skin), so all 6 cards are the same height and pack deterministically.
      getOwnedSkins: () => ['skin_shop_c1', 'skin_shop_r1', 'skin_shop_e1', 'skin_e1', 'skin_e2', 'skin_l1'],
      getEquippedSkin: () => null,
      equipSkin: () => {},
      initialTab: 'skins',
    };
    return new CardScene(layout, input, cb);
  }

  it('packs characters into 2 columns, alternating column per character in CARD_DEFS order', () => {
    const scene = buildSkinsScene(new InputManager());
    // CARD_DEFS order: lichuang, chenshou, suyuan, max, lena, mara (client/src/game/meta/cardDefs.ts).
    // Masonry ties resolve to the lowest column index first, so with all-equal card heights this
    // alternates col0/col1/col0/col1/col0/col1 — matching the reviewed screenshot's 2x3 layout.
    const lichuang = findLabelPos(scene.container, 'skin_shop_c1')!;
    const chenshou = findLabelPos(scene.container, 'skin_shop_e1')!;
    const suyuan = findLabelPos(scene.container, 'skin_shop_r1')!;
    const max = findLabelPos(scene.container, 'skin_l1')!;
    const lena = findLabelPos(scene.container, 'skin_e1')!;
    const mara = findLabelPos(scene.container, 'skin_e2')!;
    for (const p of [lichuang, chenshou, suyuan, max, lena, mara]) expect(p).not.toBeNull();

    // Column 0: lichuang/suyuan/lena share an x; column 1: chenshou/max/mara share a different x.
    expect(lichuang.x).toBe(suyuan.x);
    expect(suyuan.x).toBe(lena.x);
    expect(chenshou.x).toBe(max.x);
    expect(max.x).toBe(mara.x);
    expect(lichuang.x).not.toBe(chenshou.x);

    // Row order within each column follows CARD_DEFS order (top to bottom).
    expect(lichuang.y).toBeLessThan(suyuan.y);
    expect(suyuan.y).toBeLessThan(lena.y);
    expect(chenshou.y).toBeLessThan(max.y);
    expect(max.y).toBeLessThan(mara.y);
    scene.destroy();
  });

  it('is scrollable on a short viewport, and dragging clamps scrollY to [0, scrollMax]', () => {
    const input = new InputManager();
    // createLayout() floors landscape designWidth/Height at a large reference size (1920x1080),
    // so no real screen size can be made short enough to overflow this fixed 6-character catalogue.
    // A plain ILayout object (same pattern as familySceneSplitView.ui.ts) sidesteps that floor to
    // exercise the actual overflow/scroll path: at designHeight=400 the 3-row-deep (2-col) masonry
    // grid (~562px tall) doesn't fit the ~344px content area.
    const layout = { designWidth: 1920, designHeight: 400, orientation: 'landscape' } as unknown as
      Parameters<typeof buildSkinsScene>[1];
    const scene = buildSkinsScene(input, layout);
    const s = scene as unknown as { scrollY: number };
    expect(s.scrollY).toBe(0);

    // chenshou's tile (column 1, row 0) stays on-screen both before and after the drag below.
    const before = findLabelPos(scene.container, 'skin_shop_e1')!;
    expect(before).not.toBeNull();

    // (150, 150) sits in the column-0 card's portrait area, clear of every tile's hit rect (tiles
    // sit further right, past the portrait) — so this starts a drag instead of tapping a tile.
    input._emitDown(150, 150);
    input._emitMove(150, 150 - 100);
    expect(s.scrollY).toBeGreaterThan(0);

    const after = findLabelPos(scene.container, 'skin_shop_e1')!;
    expect(after.y).toBeLessThan(before.y); // content shifted up as scrollY increased

    // Dragging far past the bottom must clamp, not scroll indefinitely.
    input._emitMove(150, 150 - 100000);
    const clampedScrollY = s.scrollY;
    input._emitMove(150, 150 - 200000);
    expect(s.scrollY).toBe(clampedScrollY);
    input._emitUp(150, 150 - 200000);

    // Dragging back up past the top must clamp to 0.
    input._emitDown(150, 150);
    input._emitMove(150, 150 + 100000);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });

  it('does not scroll on a tall viewport where all cards already fit', () => {
    const input = new InputManager();
    const scene = buildSkinsScene(input, createLayout(1920, 1080));
    const s = scene as unknown as { scrollY: number };

    input._emitDown(600, 400);
    input._emitMove(600, 400 - 1000);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });
});
