// Regression coverage for the Hero Roster level presentation (2026-07-18):
//   1. Cards are sorted highest-level-first (level is the headline stat), so the strongest heroes
//      float to the top-left of the grid.
//   2. A card's level is drawn as a row of gold stars (one star per level, capped at 9) instead of a
//      small "Lv.N" number that was too easy to overlook.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
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
  return { id, defId, level, xp: 0, gear: {}, locked: false };
}

function buildScene(cards: CardInstance[]): CardScene {
  const save = makeNewSave();
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    feedCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

/** Every named star-row container in the rendered tree, in scene-graph (paint) order. */
function starRows(container: PIXI.Container): PIXI.Container[] {
  const out: PIXI.Container[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node.name === 'levelStars') out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** True if any Text node in the tree still renders a legacy "Lv.N" number. */
function hasLvText(container: PIXI.Container): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && /^Lv\./.test(node.text)) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

describe('CardScene — level shown as stars, sorted highest-level-first', () => {
  it('renders one star per level (capped at 9) and no "Lv.N" text', () => {
    const scene = buildScene([
      makeCard('a', 'max', 3),
      makeCard('b', 'lichuang', 7),
      makeCard('c', 'chenshou', 1),
      makeCard('d', 'suyuan', 9),
    ]);
    const rows = starRows(scene.container);
    // One star row per card, each with `min(level, 9)` gold stars.
    const counts = rows.map((r) => r.children.length).sort((x, y) => x - y);
    expect(counts).toEqual([1, 3, 7, 9]);
    // The old lone number is gone.
    expect(hasLvText(scene.container)).toBe(false);
    scene.destroy();
  });

  it('caps the star row at 9 even if a card somehow exceeds max level', () => {
    const scene = buildScene([makeCard('a', 'max', 12)]);
    const rows = starRows(scene.container);
    expect(rows).toHaveLength(1);
    expect(rows[0].children.length).toBe(9);
    scene.destroy();
  });

  it('places the highest-level card first (top-left of the grid)', () => {
    // The star rows are emitted per-card in sorted order, so the first row belongs to the top-left
    // card. Highest level must come first.
    const scene = buildScene([
      makeCard('lo', 'max', 2),
      makeCard('hi', 'lichuang', 8),
      makeCard('mid', 'chenshou', 5),
    ]);
    const rows = starRows(scene.container);
    // First-painted star row = highest level card = 8 stars.
    expect(rows[0].children.length).toBe(8);
    scene.destroy();
  });
});
