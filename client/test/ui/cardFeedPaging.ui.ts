// Regression coverage for the feed-modal paging fix: with more same-faction material cards than fit
// in six rows, the panel used to grow past the screen and push the Confirm/Cancel buttons off-screen
// (unreachable). client/src/scenes/CardScene/feed.ts now caps visible rows and pages through the rest
// via up/down arrow hits — this asserts the buttons always stay on-screen and the pager behaves.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
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

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container, worldX: number, worldY: number, worldScale: number): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: worldX, y: worldY }; return; }
    for (const c of node.children) {
      const child = c as PIXI.Container;
      walk(child, worldX + child.x * worldScale, worldY + child.y * worldScale, worldScale * child.scale.x);
    }
  };
  walk(container, 0, 0, 1);
  return found;
}

function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

/** The two pager arrows are the only square hits of this fixed size (see feed.ts's `arrowSz`). */
function pagerHits(hits: Hit[]): Hit[] {
  const ARROW_SZ = 66; // (28 - 6) * S, S=3
  return hits
    .filter((h) => Math.abs(h.rect.w - ARROW_SZ) < 1e-6 && Math.abs(h.rect.h - ARROW_SZ) < 1e-6)
    .sort((a, b) => a.rect.y - b.rect.y);
}

function buildScene(cb: CardCallbacks): CardScene {
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

function buildSceneWithInput(cb: CardCallbacks): { scene: CardScene; input: InputManager } {
  const input = new InputManager();
  return { scene: new CardScene(createLayout(1920, 1080), input, cb), input };
}

/** True once a row is selected: the Confirm button only renders its `(N)` count when N > 0. */
function isRowSelected(scene: CardScene): boolean {
  return findLabelPos(scene.container, `${t('roster.feedBtn')} (1)`) !== null;
}

function makeCard(id: string, defId: string, overrides: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level: 1, xp: 0, gear: {}, locked: false, ...overrides };
}

function baseCb(cardInv: Record<string, CardInstance>, overrides: Partial<CardCallbacks> = {}): CardCallbacks {
  return {
    onBack() {},
    getSave: () => ({
      cardInv,
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

function openFeed(scene: CardScene, target: CardInstance): void {
  (scene as unknown as { openFeedSelect: (c: CardInstance) => void }).openFeedSelect(target);
}

function modalHitsOf(scene: CardScene): Hit[] {
  return (scene as unknown as { modalHits: Hit[] }).modalHits;
}

function screenHeightOf(scene: CardScene): number {
  return (scene as unknown as { h: number }).h;
}

function feedScrollIdxOf(scene: CardScene): number {
  return (scene as unknown as { feedScrollIdx: number }).feedScrollIdx;
}

describe('CardScene feed modal — paging when candidates overflow the panel', () => {
  it('keeps Confirm/Cancel fully on-screen and shows a pager with 12 same-faction candidates', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 12; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    const h = screenHeightOf(scene);
    const hits = modalHitsOf(scene);

    const cancelPos = findLabelPos(scene.container, t('equip.cancel'));
    expect(cancelPos, 'Cancel label not found').not.toBeNull();
    const cancelHit = hitUnder(hits, cancelPos!);
    expect(cancelHit, 'no hit rect under Cancel').toBeDefined();
    expect(cancelHit!.rect.y + cancelHit!.rect.h).toBeLessThanOrEqual(h);

    // Select one row so the Confirm button is enabled and hittable too.
    const matNamePos = findLabelPos(scene.container, `${t('card.max.name' as never)} Lv.1`);
    expect(matNamePos, 'no visible material row label').not.toBeNull();
    const rowHit = hitUnder(hits, matNamePos!);
    expect(rowHit, 'no hit rect under the material row').toBeDefined();
    rowHit!.action(); // toggles selection + redraws

    const hits2 = modalHitsOf(scene);
    const confirmPos = findLabelPos(scene.container, `${t('roster.feedBtn')} (1)`);
    expect(confirmPos, 'Confirm label not found after selecting a row').not.toBeNull();
    const confirmHit = hitUnder(hits2, confirmPos!);
    expect(confirmHit, 'no hit rect under Confirm').toBeDefined();
    expect(confirmHit!.rect.y + confirmHit!.rect.h).toBeLessThanOrEqual(h);

    // 12 candidates overflow the panel ⇒ a pager must be present (at the top, only "down" is enabled).
    const pagers = pagerHits(hits2);
    expect(pagers.length, 'expected at least a down pager arrow').toBeGreaterThan(0);
  });

  it('pages forward and back through candidates, disabling the arrow at each end', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 12; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    expect(feedScrollIdxOf(scene)).toBe(0);
    expect(pagerHits(modalHitsOf(scene)).length).toBeGreaterThan(0);

    // Page all the way down. "down" (present whenever scrollIdx < scrollMax) is always the hit
    // with the larger y once sorted ascending; a lone hit while scrollIdx > 0 unambiguously means
    // "down" has been disabled (only "up" remains) — i.e. we've reached the bottom.
    let idx = feedScrollIdxOf(scene);
    let guard = 0;
    for (;;) {
      const hits = pagerHits(modalHitsOf(scene));
      if (hits.length === 1 && idx > 0) break;
      hits[hits.length - 1].action();
      const newIdx = feedScrollIdxOf(scene);
      expect(newIdx).toBeGreaterThan(idx);
      idx = newIdx;
      expect(++guard).toBeLessThan(20);
    }
    const bottomIdx = idx;
    expect(bottomIdx).toBeGreaterThan(0); // did actually page forward

    // Page all the way back up: click "up" (the arrow with the smaller y) until scrollIdx hits 0.
    guard = 0;
    while (feedScrollIdxOf(scene) > 0) {
      pagerHits(modalHitsOf(scene))[0].action();
      expect(++guard).toBeLessThan(20);
    }
    expect(feedScrollIdxOf(scene)).toBe(0);
  });

  // Regression for the 2026-07-17 press-drag-release fix: feed-select rows fire their toggle on
  // pointer-UP now, and a drag that starts on a row must NOT toggle it (it's a scroll-intent gesture,
  // even though this paged list doesn't itself scroll). Drives the real handleDown/Move/Up path via
  // the InputManager rather than calling hit.action() directly.
  describe('press-drag-release on a feed-select row', () => {
    function openWithRow(): { scene: CardScene; input: InputManager; rowCx: number; rowCy: number } {
      const target = makeCard('target', 'lena');
      const cardInv: Record<string, CardInstance> = { target, mat0: makeCard('mat0', 'max') };
      const { scene, input } = buildSceneWithInput(baseCb(cardInv));
      openFeed(scene, target);
      const rowPos = findLabelPos(scene.container, `${t('card.max.name' as never)} Lv.1`);
      expect(rowPos, 'no visible material row label').not.toBeNull();
      const rowHit = hitUnder(modalHitsOf(scene), rowPos!);
      expect(rowHit, 'no hit rect under the material row').toBeDefined();
      return {
        scene, input,
        rowCx: rowHit!.rect.x + rowHit!.rect.w / 2,
        rowCy: rowHit!.rect.y + rowHit!.rect.h / 2,
      };
    }

    it('a clean tap (down+up, no drag) toggles the row selection', () => {
      const { scene, input, rowCx, rowCy } = openWithRow();
      expect(isRowSelected(scene)).toBe(false);

      input._emitDown(rowCx, rowCy);
      input._emitUp(rowCx, rowCy);

      expect(isRowSelected(scene)).toBe(true);
    });

    it('a drag that starts on the row does NOT toggle it', () => {
      const { scene, input, rowCx, rowCy } = openWithRow();
      expect(isRowSelected(scene)).toBe(false);

      input._emitDown(rowCx, rowCy);
      input._emitMove(rowCx, rowCy + 40); // past DRAG_THRESHOLD
      input._emitUp(rowCx, rowCy + 40);

      expect(isRowSelected(scene)).toBe(false);
    });

    it('sub-threshold jitter still counts as a tap', () => {
      const { scene, input, rowCx, rowCy } = openWithRow();
      input._emitDown(rowCx, rowCy);
      input._emitMove(rowCx, rowCy + 3); // within DRAG_THRESHOLD (6)
      input._emitUp(rowCx, rowCy + 3);

      expect(isRowSelected(scene)).toBe(true);
    });
  });

  it('shows no pager and keeps Cancel on-screen when candidates fit without scrolling', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      mat0: makeCard('mat0', 'max'),
      mat1: makeCard('mat1', 'max'),
      mat2: makeCard('mat2', 'max'),
    };

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    const hits = modalHitsOf(scene);
    expect(pagerHits(hits).length).toBe(0);

    const cancelPos = findLabelPos(scene.container, t('equip.cancel'));
    expect(cancelPos).not.toBeNull();
    const cancelHit = hitUnder(hits, cancelPos!);
    expect(cancelHit).toBeDefined();
    expect(cancelHit!.rect.y + cancelHit!.rect.h).toBeLessThanOrEqual(screenHeightOf(scene));
  });
});
