// Regression coverage for "Develop page ([Hero Roster|Equipment]) left tab rail was the
// wrong size in landscape" (2026-07-12, see design/game/LOBBY_IA_REDESIGN.md §11).
//
// Root cause: HubTabs.ts's sidebarNavW(w) was a flat `w * 0.2` formula with no orientation
// awareness. ILayout.designWidth/designHeight swap meaning between orientations (portrait:
// 1080x1920, landscape: 1920x1080), so the same formula produced 216px in portrait but
// 384px in landscape — nearly double width for the same two-line labels. Fixed by pegging
// the rail to the phone's short edge in both orientations via an explicit `landscape`
// branch, threaded through CardSceneBase/EquipmentSceneBase (which previously had no
// `landscape` field at all, unlike CityScene/AchievementScene).
//
// This file pins: (1) sidebarNavW itself returns the same short-edge-pegged width in both
// orientations, (2) CardScene's real [Hero Roster|Equipment] rail renders at that width in
// both orientations (not just the pure function), and (3) EquipmentScene's peer-tab rail
// does too — guarding against a future caller reverting to the old signature or passing the
// wrong axis.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
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

// Screen px for each orientation; ILayout maps both down to the same design-space short
// edge (1080), which is exactly the property under test.
const PORTRAIT: [number, number] = [390, 844];
const LANDSCAPE: [number, number] = [844, 390];
const EXPECTED_RAIL_W = 216; // Math.round(1080 * 0.2) — the short edge in both orientations

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

/** Find the (first) PIXI.Text node whose text matches `label` and return its render
 *  position — tab labels are anchored (0.5, 0.5), so .x/.y IS the center (see shopGroupTabs.ui.ts). */
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

/** The hit rect whose bounds contain the rendered `label`'s position — this is how the
 *  tab is actually located (by what a player sees), not by array order/index. */
function hitRectForLabel(container: PIXI.Container, hits: Hit[], label: string): Hit['rect'] {
  const pos = findLabelPos(container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under label "${label}"`).toBeDefined();
  return hit!.rect;
}

describe('sidebarNavW — pure formula', () => {
  it('pegs the rail to the short edge (1080) in both orientations', () => {
    expect(sidebarNavW(1080, 1920, false)).toBe(EXPECTED_RAIL_W); // portrait
    expect(sidebarNavW(1920, 1080, true)).toBe(EXPECTED_RAIL_W);  // landscape
  });

  it('would have been nearly double width in landscape under the old w*0.2 formula', () => {
    // Documents the bug this guards against: reading off `w` unconditionally (1920 in
    // landscape) instead of branching on orientation.
    expect(Math.round(1920 * 0.2)).toBe(384);
    expect(sidebarNavW(1920, 1080, true)).not.toBe(384);
  });
});

function buildCardScene(w: number, h: number): { scene: CardScene } {
  const save = makeNewSave();
  save.cardInv['c1'] = { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false };
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    openEquipmentBag() {},
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
  };
  return { scene: new CardScene(createLayout(w, h), new InputManager(), cb) };
}

describe('CardScene — [Hero Roster|Equipment] rail width by orientation', () => {
  it('renders the Equipment tab at the short-edge-pegged width in portrait', () => {
    const { scene } = buildCardScene(...PORTRAIT);
    const hits = (scene as unknown as { hitRects: Hit[] }).hitRects;
    const rect = hitRectForLabel(scene.container, hits, t('equip.title'));
    expect(rect.w).toBe(EXPECTED_RAIL_W);
    scene.destroy();
  });

  it('renders the Equipment tab at the SAME short-edge-pegged width in landscape (not the old ~2x-wider formula)', () => {
    const { scene } = buildCardScene(...LANDSCAPE);
    const hits = (scene as unknown as { hitRects: Hit[] }).hitRects;
    const rect = hitRectForLabel(scene.container, hits, t('equip.title'));
    expect(rect.w).toBe(EXPECTED_RAIL_W);
    scene.destroy();
  });
});

function buildEquipmentScene(w: number, h: number): EquipmentScene {
  const save = makeNewSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    peerTab: { labelKey: 'roster.title', onSelect() {} },
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(w, h), new InputManager(), cb);
}

describe('EquipmentScene — [<peer>|Equipment] group rail width by orientation', () => {
  it('renders the peer tab at the short-edge-pegged width in both portrait and landscape', () => {
    const portraitScene = buildEquipmentScene(...PORTRAIT);
    const landscapeScene = buildEquipmentScene(...LANDSCAPE);

    const portraitHits = (portraitScene as unknown as { hitRects: Hit[] }).hitRects;
    const landscapeHits = (landscapeScene as unknown as { hitRects: Hit[] }).hitRects;

    const portraitRect = hitRectForLabel(portraitScene.container, portraitHits, t('roster.title'));
    const landscapeRect = hitRectForLabel(landscapeScene.container, landscapeHits, t('roster.title'));

    expect(portraitRect.w).toBe(EXPECTED_RAIL_W);
    expect(landscapeRect.w).toBe(EXPECTED_RAIL_W);

    portraitScene.destroy();
    landscapeScene.destroy();
  });
});
