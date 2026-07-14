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
