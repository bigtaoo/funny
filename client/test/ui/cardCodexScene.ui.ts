// Regression coverage for CardCodexScene (LOBBY_IA_REDESIGN §15 / ADR-038): the read-only card
// compendium folded into the Career hub when CollectionScene was retired. Unit cards the player has
// no owned Hero Roster instance of render greyed + "Locked"; buildings/spells have no roster-ownership
// concept and always render unlocked regardless of `getOwnedUnitTypes()`.
//
// Locked-count assertions are computed from CARD_DEFINITIONS itself (deduped by nameKey, same rule the
// scene uses) rather than hardcoded, so the test doesn't rot if the card pool changes.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardCodexScene, type CardCodexCallbacks } from '../../src/scenes/CardCodexScene';
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS } from '../../src/game/config';
import { CardType, UnitType } from '../../src/game/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function countText(container: PIXI.Container, text: string): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === text) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

function baseCb(owned: string[]): CardCodexCallbacks {
  return {
    onBack() {},
    getOwnedUnitTypes: () => new Set(owned),
  };
}

/** Distinct unit-type codex entries (one per nameKey, mirroring CardCodexScene's own dedup rule). */
const DISTINCT_UNIT_TYPES = [...new Set(
  CARD_DEFINITIONS.filter((c) => c.cardType === CardType.Unit).map((c) => c.unitType),
)] as string[];

describe('CardCodexScene — locked/unlocked card compendium', () => {
  it('locks every unit character the player owns none of', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb([]));
    expect(countText(scene.container, t('collection.locked' as never))).toBe(DISTINCT_UNIT_TYPES.length);
  });

  it('unlocks exactly the owned characters, leaving the rest locked', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(['lena', 'max']));
    expect(countText(scene.container, t('collection.locked' as never))).toBe(DISTINCT_UNIT_TYPES.length - 2);
    // An unlocked entry shows its stat-chip row (HP value text); locked entries never draw it.
    const lenaHp = String(UNIT_BLUEPRINTS[UnitType.Lena].hp);
    expect(countText(scene.container, lenaHp)).toBeGreaterThan(0);
  });

  it('never locks buildings/spells regardless of owned unit types', () => {
    const totalDistinctNames = new Set(CARD_DEFINITIONS.map((c) => c.nameKey)).size;
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb([])); // owns no characters at all
    // Only unit entries can lock; buildings/spells always render as if unlocked.
    expect(countText(scene.container, t('collection.locked' as never))).toBe(DISTINCT_UNIT_TYPES.length);
    expect(countText(scene.container, t('collection.locked' as never))).toBeLessThan(totalDistinctNames);
  });
});
