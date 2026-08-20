// Integration coverage for the 2026-08-01 "deployed cards float to the top" Hero Roster fix (see
// design/game/CHARACTER_CARDS_DESIGN.md §10.1 + client/test/cardScene-sort.test.ts for the pure
// sortCards unit coverage). That test file exercises sortCards() directly; this one proves the
// wiring end-to-end — that ListMixin.renderList() actually forwards cb.getCardState() into
// sortCards() and lays the grid out in the resulting order — by constructing a real CardScene and
// reading back each card's on-screen cell position.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';
import type { CardSLGState } from '../../src/net/WorldApiClient';

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
  list: { cellRects: Map<string, { x: number; y: number; w: number }> };
}

/**
 * Card ids in on-screen grid order (row-major: top row left-to-right, then next row), read back
 * from the roster's last renderList() layout pass.
 */
function renderedOrder(scene: CardScene): string[] {
  const { cellRects } = (scene as unknown as SceneInternals).list;
  return [...cellRects.entries()]
    .sort(([, a], [, b]) => (a.y !== b.y ? a.y - b.y : a.x - b.x))
    .map(([id]) => id);
}

/**
 * Builds a scene whose getCardState() returns `cardState` from the very first render — unlike
 * cardRosterApplyCardState.ui.ts's helper, which starts with no SLG data and patches it in later
 * via applyCardState(). This exercises the common path: SLG data already resolved by the time the
 * roster is opened (goCardRoster's worldsvc fetch beat the CARD_ROSTER_SLG_BUDGET_MS give-up).
 */
function buildScene(cards: CardInstance[], cardState: Record<string, CardSLGState>): CardScene {
  const save = makeNewSave();
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    getCardState: () => cardState,
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

describe('CardScene roster grid — deployed cards render first (2026-08-01)', () => {
  it('lays out deployed cards ahead of not-deployed ones, each group by power desc', () => {
    // 'weak-deployed' is deployed but the lowest level of the four — must still lead the grid.
    // 'strong' is the highest-level not-deployed card — must lead the second group, not the first.
    const cards = [
      makeCard('strong', 'max', 9),
      makeCard('weak-deployed', 'suyuan', 1),
      makeCard('mid-deployed', 'lichuang', 5),
      makeCard('mid', 'lena', 3),
    ];
    const cardState: Record<string, CardSLGState> = {
      'weak-deployed': { currentTroops: 1, injuredUntil: 0, teamId: 't1' },
      'mid-deployed': { currentTroops: 1, injuredUntil: 0, teamId: 't1' },
    };
    const scene = buildScene(cards, cardState);

    // Deployed group (power desc: mid-deployed lvl5 > weak-deployed lvl1) precedes the not-deployed
    // group (power desc: strong lvl9 > mid lvl3).
    expect(renderedOrder(scene)).toEqual(['mid-deployed', 'weak-deployed', 'strong', 'mid']);

    scene.destroy();
  });

  it('with no cardState entries at all, falls back to a single power-desc group', () => {
    const cards = [makeCard('low', 'max', 1), makeCard('high', 'lichuang', 8)];
    const scene = buildScene(cards, {});

    expect(renderedOrder(scene)).toEqual(['high', 'low']);

    scene.destroy();
  });
});
