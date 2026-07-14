// Regression coverage for two Hero Roster / Equipment popup fixes (2026-07-14, see
// claudedocs/client-modules.md "弹窗按 80% 屏幕轴等比放大"):
//
//   1. The header "← Back" button must stay reachable (call cb.onBack(), for
//      EquipmentScene: cancel an in-flight card assign) even while the detail/reforge modal
//      is open. Before the fix, `handleDown` only consulted `modalHits` while a modal was
//      open, and the modal's own full-screen "tap outside to close" hit swallowed the click
//      first — so tapping the visible Back button just closed the popup instead of leaving
//      the scene.
//   2. Detail/reforge modal panels now scale up to fill 80% of the constrained screen axis
//      (landscape → height, portrait → width) instead of a small fixed pixel size, while
//      keeping their natural (content-driven) aspect ratio. The whole panel is drawn in a
//      local, unscaled frame onto `modalPanelRoot`, then that container is scaled/positioned
//      as one unit (`modalScale`/`modalOriginX`/`modalOriginY`); anything in `modalHits` for
//      content on `modalPanelRoot` is converted to real screen space via `toModalScreen`.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Chosen so ILayout's pinned/stretched axis math (ScalingManager: one axis pegged to
// 1080, the other stretched to the real aspect ratio) resolves to exactly these numbers —
// i.e. `scene.w`/`scene.h` below equal the literal screenW/screenH passed to createLayout,
// so the natural-content-size constants copied from source (mw0/mh0 below) aren't muddied
// by an unrelated layout-stretch factor.
const LANDSCAPE: [number, number] = [1920, 1080];
const PORTRAIT: [number, number] = [1080, 1920];

type Rect = { x: number; y: number; w: number; h: number };
type Hit = { rect: Rect; action: () => void };

type SceneInternals = {
  w: number; h: number; landscape: boolean;
  backRect: Rect;
  modalOpen: boolean;
  modalHits: Hit[];
  modalScale: number; modalOriginX: number; modalOriginY: number;
  modalPanelRoot: PIXI.Container;
  handleDown(x: number, y: number): void;
};

function internals(scene: CardScene | EquipmentScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

function buildCardScene(w: number, h: number) {
  const save = makeNewSave();
  save.cardInv['c1'] = { id: 'c1', defId: 'lichuang', level: 3, xp: 0, gear: {}, locked: false };
  const calls = { back: 0 };
  const cb: CardCallbacks = {
    onBack: () => { calls.back++; },
    getSave: () => save,
    feedCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
  };
  const scene = new CardScene(createLayout(w, h), new InputManager(), cb);
  return { scene, calls };
}

function buildEquipmentScene(w: number, h: number) {
  const save = makeNewSave();
  save.materials = { scrap: 0, lead: 0, binding: 0 };
  save.equipmentInv['i1'] = {
    id: 'i1', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }],
  };
  save.equipmentInv['i2'] = {
    id: 'i2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 10 }],
  };
  const calls = { back: 0 };
  const cb: EquipmentCallbacks = {
    onBack: () => { calls.back++; },
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  const scene = new EquipmentScene(createLayout(w, h), new InputManager(), cb);
  return { scene, calls };
}

function tapCenter(scene: CardScene | EquipmentScene, rect: Rect): void {
  internals(scene).handleDown(rect.x + rect.w / 2, rect.y + rect.h / 2);
}

describe('Back button stays reachable while a detail modal is open', () => {
  it('CardScene: tapping Back with the roster detail modal open calls onBack, not just closes the modal', () => {
    const { scene, calls } = buildCardScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('c1');
    expect(internals(scene).modalOpen).toBe(true);

    tapCenter(scene, internals(scene).backRect);

    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('CardScene: tapping outside the panel (not on Back) still just closes the modal', () => {
    const { scene, calls } = buildCardScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('c1');
    // Bottom-right corner of the screen: outside both the Back rect and the (now-enlarged,
    // but still centered) panel.
    internals(scene).handleDown(internals(scene).w - 2, internals(scene).h - 2);

    expect(calls.back).toBe(0);
    expect(internals(scene).modalOpen).toBe(false);
    scene.destroy();
  });

  it('EquipmentScene: tapping Back with the item detail modal open calls onBack', () => {
    const { scene, calls } = buildEquipmentScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('i1');
    expect(internals(scene).modalOpen).toBe(true);

    tapCenter(scene, internals(scene).backRect);

    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('EquipmentScene: tapping Back with the reforge modal open calls onBack', () => {
    const { scene, calls } = buildEquipmentScene(...LANDSCAPE);
    const save = (scene as unknown as { cb: EquipmentCallbacks }).cb.getSave();
    (scene as unknown as { openReforgeSelect(inst: unknown): void }).openReforgeSelect(save.equipmentInv['i1']);
    expect(internals(scene).modalOpen).toBe(true);

    tapCenter(scene, internals(scene).backRect);

    expect(calls.back).toBe(1);
    scene.destroy();
  });
});

describe('Detail/reforge modal panel scales to 80% of the constrained screen axis (aspect ratio preserved)', () => {
  it('CardScene roster detail: landscape fills 80% of screen height', () => {
    const { scene } = buildCardScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('c1');
    const inner = internals(scene);
    expect(inner.landscape).toBe(true);

    // Natural (unscaled) content size copied from CardScene/detail.ts openDetail() — not
    // injured, so contentH = 12+26+106+4+28+26+82+40.
    const mw0 = 380;
    const mh0 = 12 + 26 + 106 + 4 + 28 + 26 + 82 + 40;
    const expectedScale = (inner.h * 0.8) / mh0;

    expect(inner.modalScale).toBeCloseTo(expectedScale, 10);
    expect(mh0 * inner.modalScale).toBeCloseTo(inner.h * 0.8, 6); // fills 80% height exactly
    // Aspect ratio preserved: both axes carry the SAME scale factor.
    expect(inner.modalPanelRoot.scale.x).toBeCloseTo(inner.modalScale, 10);
    expect(inner.modalPanelRoot.scale.y).toBeCloseTo(inner.modalScale, 10);
    // Centered horizontally.
    const screenW = mw0 * inner.modalScale;
    expect(inner.modalOriginX).toBeCloseTo((inner.w - screenW) / 2, 6);

    scene.destroy();
  });

  it('CardScene roster detail: portrait fills 80% of screen width', () => {
    const { scene } = buildCardScene(...PORTRAIT);
    (scene as unknown as { openDetail(id: string): void }).openDetail('c1');
    const inner = internals(scene);
    expect(inner.landscape).toBe(false);

    const mw0 = 380;
    const expectedScale = (inner.w * 0.8) / mw0;

    expect(inner.modalScale).toBeCloseTo(expectedScale, 10);
    const screenW = mw0 * inner.modalScale;
    expect(screenW).toBeCloseTo(inner.w * 0.8, 6); // fills 80% width exactly
    expect(inner.modalOriginX).toBeCloseTo((inner.w - screenW) / 2, 6);

    scene.destroy();
  });

  it('CardScene roster detail: a modalHits rect drawn on modalPanelRoot converts to real screen space', () => {
    const { scene } = buildCardScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('c1');
    const inner = internals(scene);

    // The portrait-flip hit is a fixed 96×96 box in local (unscaled) panel space (see
    // cardDetailFlipAndSkin.ui.ts) — its screen-space size must equal 96 * modalScale, and it
    // must land fully inside the panel's real on-screen bounds.
    const flipHit = inner.modalHits.find((h) => Math.abs(h.rect.w - 96 * inner.modalScale) < 1e-6);
    expect(flipHit, 'no portrait-flip hit scaled to 96 * modalScale found').toBeDefined();
    expect(flipHit!.rect.h).toBeCloseTo(96 * inner.modalScale, 6);
    expect(flipHit!.rect.x).toBeGreaterThanOrEqual(inner.modalOriginX - 1e-6);
    expect(flipHit!.rect.y).toBeGreaterThanOrEqual(inner.modalOriginY - 1e-6);

    scene.destroy();
  });

  it('EquipmentScene item detail: landscape fills 80% of screen height', () => {
    const { scene } = buildEquipmentScene(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('i1');
    const inner = internals(scene);
    expect(inner.landscape).toBe(true);

    // Natural size copied from EquipmentScene/detail.ts: mw0=min(330,w-24); 1 affix, not
    // maxed → mh0 = 64 + affixCount*20 + (64+22) + 44 + 24.
    const mh0 = 64 + 1 * 20 + (64 + 22) + 44 + 24;
    const expectedScale = (inner.h * 0.8) / mh0;

    expect(inner.modalScale).toBeCloseTo(expectedScale, 10);
    expect(mh0 * inner.modalScale).toBeCloseTo(inner.h * 0.8, 6);

    scene.destroy();
  });

  it('EquipmentScene item detail: portrait fills 80% of screen width', () => {
    const { scene } = buildEquipmentScene(...PORTRAIT);
    (scene as unknown as { openDetail(id: string): void }).openDetail('i1');
    const inner = internals(scene);
    expect(inner.landscape).toBe(false);

    const mw0 = 330;
    const expectedScale = (inner.w * 0.8) / mw0;

    expect(inner.modalScale).toBeCloseTo(expectedScale, 10);
    expect(mw0 * inner.modalScale).toBeCloseTo(inner.w * 0.8, 6);

    scene.destroy();
  });

  it('EquipmentScene reforge picker: landscape fills 80% of screen height, portrait fills 80% of width', () => {
    const build = (w: number, h: number) => {
      const { scene } = buildEquipmentScene(w, h);
      const save = (scene as unknown as { cb: EquipmentCallbacks }).cb.getSave();
      (scene as unknown as { openReforgeSelect(inst: unknown): void }).openReforgeSelect(save.equipmentInv['i1']);
      return scene;
    };

    // Natural size copied from EquipmentScene/reforge.ts: mw0=min(320,w-24); rowH=48;
    // mh0=min(60 + candidates.length*rowH + 40, h-80). Only 'i2' (common) qualifies as a
    // reforge material for a 'fine' target, so candidates.length === 1.
    const mw0 = 320;
    const mh0 = 60 + 1 * 48 + 40;

    const landscape = build(...LANDSCAPE);
    const li = internals(landscape);
    expect(li.landscape).toBe(true);
    const landscapeScale = (li.h * 0.8) / mh0;
    expect(li.modalScale).toBeCloseTo(landscapeScale, 10);
    expect(mh0 * li.modalScale).toBeCloseTo(li.h * 0.8, 6);
    landscape.destroy();

    const portrait = build(...PORTRAIT);
    const pi = internals(portrait);
    expect(pi.landscape).toBe(false);
    const portraitScale = (pi.w * 0.8) / mw0;
    expect(pi.modalScale).toBeCloseTo(portraitScale, 10);
    expect(mw0 * pi.modalScale).toBeCloseTo(pi.w * 0.8, 6);
    portrait.destroy();
  });
});
