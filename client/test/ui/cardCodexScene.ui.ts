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
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS } from '@nw/engine/config';
import { CardType, UnitType } from '@nw/engine/types';
import { fromFp } from '@nw/engine/math/fixed';

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
    const lenaHp = String(fromFp(UNIT_BLUEPRINTS[UnitType.Lena].hp_fp));
    expect(countText(scene.container, lenaHp)).toBeGreaterThan(0);
  });

  // Same pass, the type/cost subtitle: it used to be one `type · cost N` string with no icon at all.
  // Now it is two iconned pieces (helmet/castle/scroll + ink bottle) and the `·` is gone. Indent
  // again, for the reason in the locked-label test below.
  it('draws the card type and the cost behind icons of their own', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(['lena', 'max']));
    const wanted = new Set([
      t('collection.cardType.unit' as never),
      t('collection.cardType.building' as never),
      t('collection.cardType.spell' as never),
    ]);
    const found: PIXI.Text[] = [];
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text) {
        if (wanted.has(node.text)) found.push(node);
        // The cost piece keeps its own label in the same row: "<cost> <n>".
        if (node.text.startsWith(`${t('collection.stat.cost' as never)} `)) found.push(node);
      }
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(scene.container);
    expect(found.length).toBeGreaterThan(0);
    for (const lbl of found) expect(lbl.x).toBeGreaterThan(0);
    // The separator the icons replaced must be gone — no label still carries it.
    const withDot: string[] = [];
    const walkDot = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text && node.text.includes(' · ')) withDot.push(node.text);
      for (const c of node.children) walkDot(c as PIXI.Container);
    };
    walkDot(scene.container);
    expect(withDot).toEqual([]);
  });

  // 2026-08-27 (user feedback on a codex screenshot): the stat row used to be half icons and half
  // words — `hp`/`atk` drew their icon only, `range` (no icon art) drew its name only. Every chip now
  // spells its stat out, so the icons read as a cue on top of the name rather than as the name itself.
  it('spells out every stat chip in words, not only the one whose icon art is missing', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb(['lena', 'max']));
    for (const key of ['collection.stat.hp', 'collection.stat.atk', 'collection.stat.range']) {
      expect(countText(scene.container, t(key as never))).toBeGreaterThan(0);
    }
  });

  // The locked line got the same treatment (2026-08-27): a padlock in front of the words, not just
  // the big one over the illustration next to it. Asserted as an INDENT rather than by looking for
  // the icon node — a headless ink icon never decodes, so `buildIcon` hands back an empty container
  // and its presence is unobservable; `drawIconTextRow` offsets the label by the icon's width, and
  // that offset is 0 when no icon is drawn.
  it('puts a padlock in front of the locked label, not only over the art', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb([]));
    const labels: PIXI.Text[] = [];
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text && node.text === t('collection.locked' as never)) labels.push(node);
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(scene.container);
    expect(labels.length).toBeGreaterThan(0);
    for (const lbl of labels) expect(lbl.x).toBeGreaterThan(0);
  });

  it('never locks buildings/spells regardless of owned unit types', () => {
    const totalDistinctNames = new Set(CARD_DEFINITIONS.map((c) => c.nameKey)).size;
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb([])); // owns no characters at all
    // Only unit entries can lock; buildings/spells always render as if unlocked.
    expect(countText(scene.container, t('collection.locked' as never))).toBe(DISTINCT_UNIT_TYPES.length);
    expect(countText(scene.container, t('collection.locked' as never))).toBeLessThan(totalDistinctNames);
  });
});
