// Wardrobe tiles are as wide as the widest label they can show (CardScene/skins.ts skinTileW): the
// status line "Ausgerüstet" is ~121 design px at the floor against 100 inside the old fixed 108
// tile, and ran out of both sides of it (2026-09-29).
//
// The headless adapter measures 7px per character, under which the real German word fits a 108
// tile, so the label is padded here to force the wide case.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';

const LONG_EQUIPPED = 'Ausgerüstet-Ausgerüstet';
vi.mock('../../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n')>();
  return {
    ...actual,
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'collection.equipped' ? LONG_EQUIPPED : actual.t(key as never, params),
  };
});

import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('de', memStore, ['zh', 'en', 'de']);

describe('CardScene wardrobe — tile width follows its labels', () => {
  it('makes every tile wide enough for the status line', () => {
    const scene = new CardScene(createLayout(360, 640), new InputManager(), {
      onBack() {},
      getSave: () => makeNewSave(),
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => ['skin_e1'],
      getEquippedSkin: () => null, // the default look is worn → its tile says LONG_EQUIPPED
      equipSkin: () => {},
      initialTab: 'skins',
    });
    const texts: PIXI.Text[] = [];
    const walk = (n: PIXI.Container): void => {
      if (n instanceof PIXI.Text) texts.push(n);
      for (const c of n.children) walk(c as PIXI.Container);
    };
    walk(scene.container);
    const status = texts.find((l) => l.text === LONG_EQUIPPED)!;
    expect(status).toBeDefined();
    // The skin tile next to it (not worn) is tappable: its hit rect is exactly one tile.
    const skinLbl = texts.find((l) => l.name === 'skinTile:skin_e1')!;
    const hits = (scene as unknown as { core: { hitRects: { rect: { x: number; y: number; w: number; h: number } }[] } }).core.hitRects;
    const tile = hits.find(({ rect: r }) => skinLbl.x >= r.x && skinLbl.x <= r.x + r.w && skinLbl.y >= r.y && skinLbl.y <= r.y + r.h)!;
    expect(tile).toBeDefined();
    expect(status.width).toBeLessThanOrEqual(tile.rect.w - 8 + 0.5);
    scene.destroy();
  });
});
