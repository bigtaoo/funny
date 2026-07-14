// Regression coverage for the card-detail additions from the CollectionScene dissolution
// (LOBBY_IA_REDESIGN §15 / ADR-038): tapping the portrait plays a flip animation that swaps art for
// lore text and back, and — only when the character has an owned skin — a "change skin" badge opens a
// picker whose selection calls back with the right (unitType, skinId) pair.
//
// The flip is driven by PIXI.Ticker.shared (client/src/scenes/CardScene/detail.ts flipDetailPortrait),
// not by the scene's own render() loop, so it can't be advanced via a fake `{deltaMS}` ticker object —
// this test pumps the REAL shared ticker with PIXI.Ticker.shared.update(time) (vitest.ui.config.ts's
// headless adapter stubs requestAnimationFrame but does not mock Ticker itself, so update() still
// synchronously invokes registered listeners; see client/test/render/lobbyRebuildTeardown.test.ts for
// the alternative "mock the whole Ticker" pattern used elsewhere, not needed here since we WANT the
// real add/remove/deltaMS behaviour exercised).
//
// The portrait-flip and change-skin hits have no distinct label of their own to search for (unlike
// tabs/tiles elsewhere), so they're located by their known fixed size (96×96 portrait, 22×22 badge)
// inside the modal's own hit list — robust to layout position changes, coupled only to those two
// size constants in detail.ts.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import type { UnitType } from '../../src/game/types';

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

function hasText(container: PIXI.Container, text: string): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === text) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

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

function bySize(hits: Hit[], w: number, h: number): Hit | undefined {
  return hits.find((hit) => hit.rect.w === w && hit.rect.h === h);
}

function buildScene(cb: CardCallbacks): CardScene {
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

function openDetail(scene: CardScene, cardName: string): void {
  const pos = findLabelPos(scene.container, cardName);
  expect(pos, `card "${cardName}" not found in the roster grid`).not.toBeNull();
  const hits = (scene as unknown as { hitRects: Hit[] }).hitRects;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no roster-grid hit under "${cardName}"`).toBeDefined();
  hit!.action();
}

/** Advance the real PIXI.Ticker.shared by `ms`, firing any listeners added via `.add()` (e.g. the flip). */
function tick(ms: number): void {
  const shared = (PIXI as unknown as { Ticker: { shared: { update(t: number): void; lastTime: number } } }).Ticker.shared;
  shared.update(shared.lastTime + ms);
}

const LENA_LORE = t('card.lena.lore' as never);

function baseCb(overrides: Partial<CardCallbacks>): CardCallbacks {
  return {
    onBack() {},
    getSave: () => ({
      cardInv: { c1: { id: 'c1', defId: 'lena', level: 3, xp: 10, gear: {}, locked: false } },
      equipmentInv: {},
      wallet: { coins: 0 },
    } as unknown as ReturnType<CardCallbacks['getSave']>),
    feedCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
    ...overrides,
  };
}

describe('CardScene detail modal — portrait flip (art ⇄ lore)', () => {
  it('shows no lore before flipping, shows lore after the animation completes, and flips back', () => {
    const scene = buildScene(baseCb({}));
    openDetail(scene, 'Lena');

    expect(hasText(scene.container, LENA_LORE)).toBe(false);

    const modalHits = (scene as unknown as { modalHits: Hit[] }).modalHits;
    const flipHit = bySize(modalHits, 96, 96);
    expect(flipHit, 'no 96×96 portrait-flip hit in the detail modal').toBeDefined();

    flipHit!.action();
    // Before the midpoint, content hasn't swapped yet.
    tick(100);
    expect(hasText(scene.container, LENA_LORE)).toBe(false);
    // Past the midpoint (260ms total duration) the face swaps to the back (lore).
    tick(100);
    expect(hasText(scene.container, LENA_LORE)).toBe(true);
    // Past the full duration the animation settles; nothing further changes without another tap.
    tick(100);
    expect(hasText(scene.container, LENA_LORE)).toBe(true);

    // Tap again to flip back to the front.
    flipHit!.action();
    tick(150);
    tick(150);
    expect(hasText(scene.container, LENA_LORE)).toBe(false);
  });

  it('does not show a change-skin badge when the character has no owned skin', () => {
    const scene = buildScene(baseCb({ getOwnedSkins: () => [] }));
    openDetail(scene, 'Lena');
    const modalHits = (scene as unknown as { modalHits: Hit[] }).modalHits;
    expect(bySize(modalHits, 22, 22)).toBeUndefined();
  });
});

describe('CardScene detail modal — change-skin picker', () => {
  it('opens the picker from the badge and equips the selected skin on the right character', () => {
    const equipCalls: Array<{ unitType: UnitType; skinId: string | null }> = [];
    let equippedNow: string | null = null;
    const scene = buildScene(baseCb({
      getOwnedSkins: () => ['skin_e1'],
      getEquippedSkin: () => equippedNow,
      equipSkin: (unitType, skinId) => { equipCalls.push({ unitType, skinId }); equippedNow = skinId; },
    }));
    openDetail(scene, 'Lena');

    const badgeHit = bySize((scene as unknown as { modalHits: Hit[] }).modalHits, 22, 22);
    expect(badgeHit, 'no 22×22 change-skin badge in the detail modal').toBeDefined();
    badgeHit!.action(); // toggles skinPickerOpen + re-renders the modal

    expect((scene as unknown as { skinPickerOpen: boolean }).skinPickerOpen).toBe(true);
    expect(hasText(scene.container, 'skin_e1')).toBe(true);

    const rowPos = findLabelPos(scene.container, 'skin_e1');
    expect(rowPos).not.toBeNull();
    const rowHit = (scene as unknown as { modalHits: Hit[] }).modalHits.find(({ rect: r }) =>
      rowPos!.x >= r.x && rowPos!.x <= r.x + r.w && rowPos!.y >= r.y && rowPos!.y <= r.y + r.h);
    expect(rowHit, 'no hit rect under the "skin_e1" picker row').toBeDefined();
    rowHit!.action();

    expect(equipCalls).toEqual([{ unitType: 'lena', skinId: 'skin_e1' }]);
    expect((scene as unknown as { skinPickerOpen: boolean }).skinPickerOpen).toBe(false);
    expect(hasText(scene.container, 'skin_e1')).toBe(false);
  });
});
