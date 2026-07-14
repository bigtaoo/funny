// Regression coverage for "entering Equipment from the roster dropped the Skins tab" (2026-07-14).
//
// The growth-hub sidebar rail is the [Cards | Equipment | Skins] group (LOBBY_IA_REDESIGN §15).
// CardScene draws all three, but EquipmentScene's renderSidebar only drew [Cards | Equipment] plus
// its own Inventory/Craft sub-tabs — so opening Equipment made Skins vanish entirely instead of
// shifting down below the sub-tabs. Fixed by injecting Skins via EquipmentCallbacks.trailingPeers,
// rendered beneath the Inventory/Craft sub-tabs.
//
// This pins: (1) the Skins peer renders and is tappable, (2) it sits *below* the Craft sub-tab
// (shifted down, not omitted or hoisted above the sub-tabs), and (3) tapping it fires onSelect.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
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

function hitForLabel(scene: { container: PIXI.Container }, label: string): Hit {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hitRects: Hit[] }).hitRects;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under label "${label}"`).toBeDefined();
  return hit!;
}

function buildEquipmentScene(onSkins: () => void): EquipmentScene {
  const save = makeNewSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    peerTab: { labelKey: 'roster.title', icon: 'cards', onSelect() {} },
    trailingPeers: [{ labelKey: 'roster.tab.skins', icon: 'brush', onSelect: onSkins }],
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(390, 844), new InputManager(), cb);
}

describe('EquipmentScene — Skins trailing peer (growth group [Cards | Equipment | Skins])', () => {
  it('renders the Skins peer below the Inventory/Craft sub-tabs (shifted down, not dropped)', () => {
    const scene = buildEquipmentScene(() => {});

    const skins = findLabelPos(scene.container, t('roster.tab.skins'));
    const craft = findLabelPos(scene.container, t('equip.tabCraft'));
    const equip = findLabelPos(scene.container, t('equip.title'));

    expect(skins, 'Skins peer must be rendered in EquipmentScene').not.toBeNull();
    expect(craft, 'Craft sub-tab must be rendered').not.toBeNull();
    expect(equip, 'Equipment tab must be rendered').not.toBeNull();

    // Order down the rail: Equipment (active) → Inventory/Craft sub-tabs → Skins at the bottom.
    expect(skins!.y).toBeGreaterThan(craft!.y);
    expect(craft!.y).toBeGreaterThan(equip!.y);

    scene.destroy();
  });

  it('fires the injected onSelect when the Skins peer is tapped', () => {
    const onSkins = vi.fn();
    const scene = buildEquipmentScene(onSkins);

    hitForLabel(scene, t('roster.tab.skins')).action();

    expect(onSkins).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('omits the trailing peer entirely when none is injected (campaign / per-card entry)', () => {
    const save = makeNewSave();
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(390, 844), new InputManager(), cb);

    expect(findLabelPos(scene.container, t('roster.tab.skins'))).toBeNull();
    scene.destroy();
  });
});
