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
  handleUp(): void;
};

function internals(scene: CardScene | EquipmentScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

function buildCardScene(w: number, h: number) {
  const save = makeNewSave();
  save.cardInv['c1'] = { id: 'c1', defId: 'lichuang', level: 3, gear: {}, locked: false };
  const calls = { back: 0 };
  const cb: CardCallbacks = {
    onBack: () => { calls.back++; },
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
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
    // but still centered) panel. Modal hits now fire on pointer-UP (press-drag-release), so a tap
    // is down+up with no drag in between.
    internals(scene).handleDown(internals(scene).w - 2, internals(scene).h - 2);
    internals(scene).handleUp();

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

    // Natural size copied from EquipmentScene/detail.ts: 1 affix, not maxed →
    // mh0 = 44 + affixCount*20 + (maxed ? 24 : 58 + 40) + 12 (the +40 is the enhance confirm
    // button's gap/row, added 2026-07-22b alongside the protect-toggle-before-enhance flow).
    const mh0 = 44 + 1 * 20 + (58 + 40) + 12;
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

    // Natural size copied from EquipmentScene/reforge.ts's icon-card grid (2026-07-reforge-material-grid
    // rewrite — no longer a row list). Only 'i2' (common) qualifies as a reforge material for a 'fine'
    // target, so stacks.length === 1 → cols=3 (maxModalW=420 for both LANDSCAPE/PORTRAIT's w here),
    // rows=1: mw0 = pad*2 + cols*cardW + (cols-1)*gap = 14*2+3*96+2*10 = 336;
    // mh0 = titleH + pad + rows*cardH + closeAreaH = 30+14+120+44 = 208 (both < h-80, so unclamped).
    const mw0 = 336;
    const mh0 = 208;

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

// Regression for the 2026-07-17 press-drag-release fix extended to EquipmentScene's modal path:
// modal hits (e.g. reforge material-picker rows) now fire on pointer-UP, and a drag past the
// threshold drops the pending hit — mirroring CardScene. Drives the real handleDown/Move/Up path
// via a retained InputManager rather than calling private handlers directly.
describe('EquipmentScene modal — press-drag-release', () => {
  function buildWithInput(w: number, h: number): { scene: EquipmentScene; input: InputManager } {
    const save = makeNewSave();
    save.equipmentInv['i1'] = { id: 'i1', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }] };
    const cb: EquipmentCallbacks = {
      onBack() {}, getSave: () => save,
      craft: async () => ({ ok: true }), enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }), equip: async () => ({ ok: true }), reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const input = new InputManager();
    return { scene: new EquipmentScene(createLayout(w, h), input, cb), input };
  }

  it('a clean tap outside the panel (down+up, no drag) closes the modal on release', () => {
    const { scene, input } = buildWithInput(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('i1');
    expect(internals(scene).modalOpen).toBe(true);

    input._emitDown(internals(scene).w - 2, internals(scene).h - 2);
    expect(internals(scene).modalOpen, 'must not close on pointer-DOWN').toBe(true);
    input._emitUp(internals(scene).w - 2, internals(scene).h - 2);

    expect(internals(scene).modalOpen).toBe(false);
    scene.destroy();
  });

  it('a drag started outside the panel does NOT close the modal', () => {
    const { scene, input } = buildWithInput(...LANDSCAPE);
    (scene as unknown as { openDetail(id: string): void }).openDetail('i1');

    const x = internals(scene).w - 2;
    const y = internals(scene).h - 2;
    input._emitDown(x, y);
    input._emitMove(x, y - 40); // past DRAG_THRESHOLD
    input._emitUp(x, y - 40);

    expect(internals(scene).modalOpen).toBe(true);
    scene.destroy();
  });
});
