// Regression coverage for the 2026-07-28+1 "SLG data missing" fix (see
// design/game/CHARACTER_CARDS_DESIGN.md §10.1 + roster-hero-card-fixes memory).
//
// goCardRoster's worldsvc fetch (troop count / deployed team) can now resolve *after* the roster
// already opened without it (its give-up timeout fired first). Rather than the data being silently
// dropped (the old behavior — CardScene had no way to be told about it), CardScene.applyCardState()
// patches it into the already-rendered grid. This pins:
//   1. applyCardState() redraws cells' SLG-derived bits (border/troop-count/deployed-tag) in place —
//      per-card containers stay the SAME object instances, and the whole grid's top-level children
//      (sidebar tabs, header currency, scroll indicator, other cells) are untouched, proving no full
//      render() ran.
//   2. A card the late fetch has no entry for stays exactly as before (no phantom state).
//   3. Calling applyCardState() twice does not accumulate duplicate hit rects for the same cell.
//
// Also covers the 2x gear-icon sizing (list.ts renderCardCell): consecutive icon centers are spaced
// ~48px apart (44+4 gap), not the old ~26px (22+4), when the info column has room.
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

interface Rect { x: number; y: number; w: number; h: number; }
interface SceneInternals {
  core: {
    bodyLayer: PIXI.Container;
    hitRects: { rect: Rect; fn: () => void; owner?: string }[];
  };
  applyCardState(): void;
}

/** Named nodes anywhere in the tree, in scene-graph order. */
function findByName(container: PIXI.Container, name: string): PIXI.DisplayObject[] {
  const out: PIXI.DisplayObject[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node.name === name) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** First Text node anywhere in the tree whose content includes `needle`. */
function findText(container: PIXI.Container, needle: string): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text.includes(needle)) { found = node; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

/**
 * Builds a scene backed by a mutable cardState/teamNames pair the test can swap out from under the
 * callback closures — mirrors how game.ts's goCardRoster wires getCardState/getTeamName to `let`
 * variables it reassigns when a late fetch resolves.
 */
function buildScene(cards: CardInstance[], designW = 1920, designH = 1080): {
  scene: CardScene;
  setCardState(next: Record<string, CardSLGState> | undefined): void;
  setTeamNames(next: Record<string, string> | undefined): void;
} {
  const save = makeNewSave();
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
  let liveCardState: Record<string, CardSLGState> | undefined;
  let liveTeamNames: Record<string, string> | undefined;
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    getCardState: () => liveCardState,
    getTeamName: (teamId) => liveTeamNames?.[teamId],
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  const scene = new CardScene(createLayout(designW, designH), new InputManager(), cb);
  return {
    scene,
    setCardState: (next) => { liveCardState = next; },
    setTeamNames: (next) => { liveTeamNames = next; },
  };
}

describe('CardScene.applyCardState — late SLG fetch patches the grid in place (2026-07-28+1)', () => {
  it('patches a card cell\'s troop count + deployed tag once cardState arrives, without a full render()', () => {
    const { scene, setCardState, setTeamNames } = buildScene([
      makeCard('a', 'max', 3),
      makeCard('b', 'lichuang', 2),
    ]);
    const internals = scene as unknown as SceneInternals;

    // Before any SLG data: neither card shows a troop count or deployed tag.
    expect(findText(scene.container, 'Deployed')).toBeNull();
    const bodyChildrenBefore = [...internals.core.bodyLayer.children];
    const cellContainers = (scene as unknown as { list: { cellContainers: Map<string, PIXI.Container> } }).list.cellContainers;
    const containerA = cellContainers.get('a');
    const containerB = cellContainers.get('b');
    expect(containerA).toBeDefined();
    expect(containerB).toBeDefined();

    // Late fetch resolves: card 'a' is deployed to team t1 with 7 troops; 'b' has no entry at all.
    setCardState({ a: { currentTroops: 7, injuredUntil: 0, teamId: 't1' } as CardSLGState });
    setTeamNames({ t1: 'Team 1' });
    internals.applyCardState();

    // 'a' now shows both the troop count and the named deployed tag.
    expect(findText(scene.container, '7/')).not.toBeNull();
    expect(findText(scene.container, 'Deployed: Team 1')).not.toBeNull();

    // Redrawn IN PLACE: same container objects for both cells (proves no full renderList() ran —
    // that always allocates fresh PIXI.Container()s into a fresh cellContainers Map).
    expect(cellContainers.get('a')).toBe(containerA);
    expect(cellContainers.get('b')).toBe(containerB);
    // Top-level bodyLayer children (sidebar tabs, per-cell containers, scroll indicator) are the
    // exact same objects in the exact same order — nothing outside the cells was touched.
    const bodyChildrenAfter = [...internals.core.bodyLayer.children];
    expect(bodyChildrenAfter.length).toBe(bodyChildrenBefore.length);
    expect(bodyChildrenAfter.every((c, i) => c === bodyChildrenBefore[i])).toBe(true);

    scene.destroy();
  });

  it('a card the late fetch has no entry for is left with no troop/deployed state (no phantom data)', () => {
    const { scene, setCardState } = buildScene([makeCard('a', 'max', 3), makeCard('b', 'lichuang', 2)]);
    const internals = scene as unknown as SceneInternals;

    setCardState({ a: { currentTroops: 5, injuredUntil: 0, teamId: 't1' } as CardSLGState });
    internals.applyCardState();

    const cellContainers = (scene as unknown as { list: { cellContainers: Map<string, PIXI.Container> } }).list.cellContainers;
    const containerB = cellContainers.get('b')!;
    expect(findText(containerB, 'Deployed')).toBeNull();
    expect(findText(containerB, '/')).toBeNull(); // no troop cur/cap line either

    scene.destroy();
  });

  it('calling applyCardState() twice does not accumulate duplicate hit rects for the same cell', () => {
    const { scene, setCardState } = buildScene([makeCard('a', 'max', 3)]);
    const internals = scene as unknown as SceneInternals;

    setCardState({ a: { currentTroops: 5, injuredUntil: 0, teamId: 't1' } });
    internals.applyCardState();
    internals.applyCardState();

    const hitsForA = internals.core.hitRects.filter((h) => h.owner === 'a');
    expect(hitsForA).toHaveLength(1);

    scene.destroy();
  });
});

describe('CardScene — gear-slot icons render at 2x the previous 22px size (2026-07-28+1)', () => {
  it('consecutive icon centers are spaced ~48px apart (44px icon + 4px gap), not the old ~26px', () => {
    // Very wide layout (height held fixed — sidebarNavW is h-proportional in landscape, so growing
    // w alone grows the roster grid's available width) so the info column has plenty of room and
    // the defensive gearScale shrink (never below the original 22px, but not guaranteed 44px either
    // — see renderCardCell) doesn't engage.
    const { scene } = buildScene([makeCard('a', 'max', 3)], 3840, 1080);

    const weapon = findByName(scene.container, 'gearIcon:weapon')[0];
    const armor = findByName(scene.container, 'gearIcon:armor')[0];
    const trinket = findByName(scene.container, 'gearIcon:trinket')[0];
    expect(weapon).toBeDefined();
    expect(armor).toBeDefined();
    expect(trinket).toBeDefined();

    const weaponArmorGap = armor.x - weapon.x;
    const armorTrinketGap = trinket.x - armor.x;
    // Old spacing was 22+4=26; new is 44+4=48. Allow a little slack for the defensive gearScale
    // clamp, but it must be well above the old spacing, not merely equal to it.
    expect(weaponArmorGap).toBeGreaterThan(40);
    expect(armorTrinketGap).toBeGreaterThan(40);
    expect(weaponArmorGap).toBeCloseTo(armorTrinketGap, 1);

    scene.destroy();
  });

  it('at a normal desktop landscape size (1920x1080) the info column is narrower than 3 full-size icons need, so gearScale is already engaged — not a rare edge case', () => {
    // LandscapeLayout floors designWidth at REFERENCE_W=1920 (ScalingManager/LandscapeLayout), so
    // 1920x1080 is close to the narrowest real layout the roster ever sees. The portrait (~177px of
    // a ~315px cell) leaves only ~90-130px for the info column — less than 3*44+2*4=140 — so the
    // *common* case already renders somewhat below the full 44px, not just a defensive fallback for
    // unusually narrow windows. Pinning the actual ratio here so a future change to CARD_CELL_H/the
    // portrait-width ratio/ROSTER_GAP that silently pushes this back towards clipping gets caught.
    const { scene } = buildScene([makeCard('a', 'max', 3)], 1920, 1080);

    const weapon = findByName(scene.container, 'gearIcon:weapon')[0];
    const armor = findByName(scene.container, 'gearIcon:armor')[0];
    const gap = armor.x - weapon.x;
    // Old spacing was 22+4=26; unclamped 2x would be 44+4=48. At 1920x1080 it lands in between —
    // meaningfully bigger than the old size, but the defensive shrink keeps it under the full 48.
    expect(gap).toBeGreaterThan(26);
    expect(gap).toBeLessThan(48);

    scene.destroy();
  });
});
