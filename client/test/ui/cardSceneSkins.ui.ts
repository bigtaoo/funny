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
import { skinDisplayName } from '../../src/game/meta/skinDefs';
import { UnitType } from '@nw/engine/types';

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
  const hits = (scene as unknown as { core: { hitRects: Hit[] } }).core.hitRects;
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
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
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
    tap(scene, skinDisplayName('skin_e1'));

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
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
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

  it('packs characters into 3 columns, row-major in CARD_DEFS order', () => {
    const scene = buildSkinsScene(new InputManager());
    // CARD_DEFS order: lichuang, chenshou, suyuan, max, lena, mara (client/src/game/meta/cardDefs.ts).
    // At the 1920x1080 landscape design width, the content-natural cellW cap (2026-07-15 "kill blank
    // width" follow-up, CARD_W_TARGET=440) fits 3 cards per row instead of 2 — masonry ties resolve to
    // the lowest column index first, so with all-equal card heights this fills col0/col1/col2 row-major:
    // row 0 = lichuang/chenshou/suyuan, row 1 = max/lena/mara.
    const lichuang = findLabelPos(scene.container, skinDisplayName('skin_shop_c1'))!;
    const chenshou = findLabelPos(scene.container, skinDisplayName('skin_shop_e1'))!;
    const suyuan = findLabelPos(scene.container, skinDisplayName('skin_shop_r1'))!;
    const max = findLabelPos(scene.container, skinDisplayName('skin_l1'))!;
    const lena = findLabelPos(scene.container, skinDisplayName('skin_e1'))!;
    const mara = findLabelPos(scene.container, skinDisplayName('skin_e2'))!;
    for (const p of [lichuang, chenshou, suyuan, max, lena, mara]) expect(p).not.toBeNull();

    // Column 0: lichuang/max; column 1: chenshou/lena; column 2: suyuan/mara — three distinct x's.
    expect(lichuang.x).toBe(max.x);
    expect(chenshou.x).toBe(lena.x);
    expect(suyuan.x).toBe(mara.x);
    expect(new Set([lichuang.x, chenshou.x, suyuan.x]).size).toBe(3);

    // Row order within each column follows CARD_DEFS order (top to bottom).
    expect(lichuang.y).toBeLessThan(max.y);
    expect(chenshou.y).toBeLessThan(lena.y);
    expect(suyuan.y).toBeLessThan(mara.y);
    scene.destroy();
  });

  it('is scrollable on a short viewport, and dragging clamps scrollY to [0, scrollMax]', () => {
    const input = new InputManager();
    // createLayout() floors landscape designWidth/Height at a large reference size (1920x1080),
    // so no real screen size can be made short enough to overflow this fixed 6-character catalogue.
    // A plain ILayout object (same pattern as familySceneSplitView.ui.ts) sidesteps that floor to
    // exercise the actual overflow/scroll path: at designHeight=400 the 2-row-deep (3-col) masonry
    // grid doesn't fit the ~344px content area.
    const layout = { designWidth: 1920, designHeight: 400, orientation: 'landscape' } as unknown as
      Parameters<typeof buildSkinsScene>[1];
    const scene = buildSkinsScene(input, layout);
    const s = scene as unknown as { core: { scrollY: number } };
    expect(s.core.scrollY).toBe(0);

    // chenshou's tile (column 1, row 0) stays on-screen both before and after the drag below.
    const before = findLabelPos(scene.container, skinDisplayName('skin_shop_e1'))!;
    expect(before).not.toBeNull();

    // (150, 150) sits in the column-0 card's portrait area, clear of every tile's hit rect (tiles
    // sit further right, past the portrait) — so this starts a drag instead of tapping a tile.
    input._emitDown(150, 150);
    input._emitMove(150, 150 - 100);
    (scene as unknown as { update(dt: number): void }).update(1 / 60);
    expect(s.core.scrollY).toBeGreaterThan(0);

    const after = findLabelPos(scene.container, skinDisplayName('skin_shop_e1'))!;
    expect(after.y).toBeLessThan(before.y); // content shifted up as scrollY increased

    // Dragging far past the bottom must clamp, not scroll indefinitely.
    input._emitMove(150, 150 - 100000);
    (scene as unknown as { update(dt: number): void }).update(1 / 60);
    const clampedScrollY = s.core.scrollY;
    input._emitMove(150, 150 - 200000);
    (scene as unknown as { update(dt: number): void }).update(1 / 60);
    expect(s.core.scrollY).toBe(clampedScrollY);
    input._emitUp(150, 150 - 200000);

    // Dragging back up past the top must clamp to 0.
    input._emitDown(150, 150);
    input._emitMove(150, 150 + 100000);
    (scene as unknown as { update(dt: number): void }).update(1 / 60);
    expect(s.core.scrollY).toBe(0);
    scene.destroy();
  });

  it('does not scroll on a tall viewport where all cards already fit', () => {
    const input = new InputManager();
    const scene = buildSkinsScene(input, createLayout(1920, 1080));
    const s = scene as unknown as { core: { scrollY: number }; update(dt: number): void };

    input._emitDown(600, 400);
    input._emitMove(600, 400 - 1000);
    s.update(1 / 60);
    expect(s.core.scrollY).toBe(0);
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-26 fix: the title bar was drawn once in CardSceneCore.build()
// with a hard-coded t('roster.title'), so the wardrobe sat under a header reading "Hero Roster" with
// the roster glyph. It is its own layer now, redrawn per render() from the active tab — which is why
// the assertions below read the title out of `core.headerLayer` rather than searching the whole tree
// (the sidebar rail carries the very same two labels).
describe('CardScene — header title follows the active tab', () => {
  // Every string drawn into the header layer except the back pill's own label (the shared chrome's,
  // not this scene's) — i.e. the title, and nothing else.
  function headerTitle(scene: CardScene): string | null {
    const layer = (scene as unknown as { core: { headerLayer: PIXI.Container } }).core.headerLayer;
    const texts: string[] = [];
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text) { texts.push(node.text); return; }
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(layer);
    const titles = texts.filter((s) => s !== t('common.back'));
    expect(titles).toHaveLength(1);
    return titles[0];
  }

  const cb = (initialTab?: 'list' | 'skins'): CardCallbacks => ({
    onBack() {},
    getSave: () => makeNewSave(),
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => ['skin_e1'],
    getEquippedSkin: () => null,
    equipSkin: () => {},
    ...(initialTab ? { initialTab } : {}),
  });

  it('says "Skins" on the wardrobe and "Hero Roster" on the grid, including after a live switch', () => {
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb());
    expect(headerTitle(scene)).toBe(t('roster.title'));

    tap(scene, t('roster.tab.skins'));
    expect(headerTitle(scene)).toBe(t('roster.tab.skins'));

    tap(scene, t('roster.title')); // back to the roster grid via the rail
    expect(headerTitle(scene)).toBe(t('roster.title'));
    scene.destroy();
  });

  // The other half of the same report: the coin/capacity cluster is drawn into headerOverlayLayer
  // from the same headerCurrencySpec() the title band measures, and the capacity counts CARDS —
  // meaningless over a page of skins.
  it('drops the card-capacity readout on the wardrobe and keeps the coin balance', () => {
    const overlayTexts = (scene: CardScene): string[] => {
      const layer = (scene as unknown as { core: { headerOverlayLayer: PIXI.Container } }).core.headerOverlayLayer;
      const out: string[] = [];
      const walk = (node: PIXI.Container): void => {
        if (node instanceof PIXI.Text) { out.push(node.text); return; }
        for (const c of node.children) walk(c as PIXI.Container);
      };
      walk(layer);
      return out;
    };
    const capacity = t('roster.capacity').replace('{cur}', '0').replace('{cap}', '500');
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb());
    expect(overlayTexts(scene)).toContain(capacity);

    tap(scene, t('roster.tab.skins'));
    expect(overlayTexts(scene)).not.toContain(capacity);
    expect(overlayTexts(scene).length).toBeGreaterThan(0); // the coin balance still reads out

    tap(scene, t('roster.title'));
    expect(overlayTexts(scene)).toContain(capacity);
    scene.destroy();
  });

  it('opens straight into the right title when the wardrobe is the initial tab', () => {
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb('skins'));
    expect(headerTitle(scene)).toBe(t('roster.tab.skins'));
    // showTab() is the EquipmentScene-overlay path onto the same tab state — same title rule.
    scene.showTab('list');
    expect(headerTitle(scene)).toBe(t('roster.title'));
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-27 report: "the Skins tab is blank when first opened; switch
// away and back and it shows". Both tabs shared one `core.scrollY`, and renderSkinsTab drew (and
// draw-culled) its cards BEFORE clamping that offset to the wardrobe's own much shorter extent — so
// arriving from a scrolled roster culled all 6 cards off-screen and painted an empty page. The next
// render() saw the clamped value and drew normally, which is exactly why a round trip "fixed" it.
describe('CardScene — wardrobe first paint after a scrolled roster', () => {
  function buildScene(): { scene: CardScene; core: { scrollY: number; maxScroll: number; render(): void } } {
    const save = makeNewSave();
    save.cardInv = {};
    // Enough cards that the roster grid genuinely overflows a 1080-tall viewport and can hold a
    // scroll offset far past anything the 6-card wardrobe can.
    for (let i = 0; i < 60; i++) {
      save.cardInv[`c${i}`] = { id: `c${i}`, defId: 'max', level: 3, gear: {}, locked: false };
    }
    const cb: CardCallbacks = {
      onBack() {},
      getSave: () => save,
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => ['skin_e1'],
      getEquippedSkin: () => null,
      equipSkin: () => {},
    };
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);
    const core = (scene as unknown as {
      core: { scrollY: number; maxScroll: number; render(): void };
    }).core;
    return { scene, core };
  }

  it('draws the wardrobe on the first paint after the roster was scrolled', () => {
    const { scene, core } = buildScene();
    // Park the roster at its bottom — renderList clamps this to the grid's real maxScroll, so the
    // offset the wardrobe then inherits is a genuine one, not a synthetic out-of-range number.
    core.scrollY = 1e6;
    core.render();
    expect(core.scrollY).toBeGreaterThan(0);

    tap(scene, t('roster.tab.skins'));
    expect(findLabelPos(scene.container, skinDisplayName('skin_e1'))).not.toBeNull();
    scene.destroy();
  });

  it('keeps a per-tab scroll offset: the wardrobe opens at the top, the roster comes back where it was', () => {
    const { scene, core } = buildScene();
    core.scrollY = 1e6;
    core.render();
    const rosterScroll = core.scrollY;

    tap(scene, t('roster.tab.skins'));
    expect(core.scrollY).toBe(0); // the wardrobe is its own list; it starts at its own top

    tap(scene, t('roster.title'));
    expect(core.scrollY).toBe(rosterScroll);
    scene.destroy();
  });

  it('showTab() — the EquipmentScene-overlay path onto the same tab state — behaves identically', () => {
    const { scene, core } = buildScene();
    core.scrollY = 1e6;
    core.render();
    const rosterScroll = core.scrollY;

    scene.showTab('skins');
    expect(core.scrollY).toBe(0);
    expect(findLabelPos(scene.container, skinDisplayName('skin_e1'))).not.toBeNull();

    scene.showTab('skins'); // idempotent — must not throw the parked offset away
    expect(core.scrollY).toBe(0);

    scene.showTab('list');
    expect(core.scrollY).toBe(rosterScroll);
    scene.destroy();
  });
});
