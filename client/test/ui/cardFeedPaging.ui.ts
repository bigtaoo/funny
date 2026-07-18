// Regression coverage for the feed-modal material picker (client/src/scenes/CardScene/feed.ts).
//
// Behaviours covered:
//  1. Identical materials (same card def + same level) collapse into ONE row showing "n / total".
//  2. Tapping a row's body cycles its count +1, wrapping back to 0 past the max; dragging the row's
//     quantity slider jumps straight to a value (added 2026-07-18 to replace a +/- stepper — with
//     dozens of owned duplicates, tapping + once per card was too slow).
//  3. The list is drag-scrollable (press-drag pans it), not paged via arrow buttons.
// Plus the still-relevant invariants: Confirm/Cancel stay on-screen, and a drag that starts on a row
// does not toggle/step it (it's a scroll-intent gesture).

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

function countLabels(container: PIXI.Container, label: string): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === label) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

type Slider = { rect: { x: number; y: number; w: number; h: number }; onDrag: (x: number) => void };

function modalSlidersOf(scene: CardScene): Slider[] {
  return (scene as unknown as { modalSliders: Slider[] }).modalSliders;
}

/** The row-body hit is the wide hit whose vertical center sits under the row's name label. */
function bodyHitInRow(scene: CardScene, label: string): Hit {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `row "${label}" not found`).not.toBeNull();
  const hit = modalHitsOf(scene).find(
    (h) => pos!.x >= h.rect.x && pos!.x <= h.rect.x + h.rect.w && Math.abs(pos!.y - (h.rect.y + h.rect.h / 2)) < 70,
  );
  expect(hit, `no row-body hit for "${label}"`).toBeDefined();
  return hit!;
}

/** Tapping a row's body cycles its selected count by +1 (wrapping to 0 past the max). */
function tapRow(scene: CardScene, label: string): void {
  bodyHitInRow(scene, label).action();
}

/** The quantity drag-slider for the row whose vertical center is nearest the row's name label. */
function sliderInRow(scene: CardScene, label: string): Slider {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `row "${label}" not found`).not.toBeNull();
  const slider = modalSlidersOf(scene).find((s) => Math.abs(s.rect.y + s.rect.h / 2 - pos!.y) < 60);
  expect(slider, `no slider for row "${label}"`).toBeDefined();
  return slider!;
}

/** Drags a row's slider so it lands on exactly `n` out of `total` (matches feed.ts's own rounding). */
function dragRowTo(scene: CardScene, label: string, n: number, total: number): void {
  const HANDLE_R = 27; // 9 * S, S=3 — see feed.ts
  const s = sliderInRow(scene, label);
  const trackX0 = s.rect.x + HANDLE_R;
  const trackW = s.rect.w - HANDLE_R * 2;
  s.onDrag(trackX0 + (n / total) * trackW);
}

function buildScene(cb: CardCallbacks): CardScene {
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

function buildSceneWithInput(cb: CardCallbacks): { scene: CardScene; input: InputManager } {
  const input = new InputManager();
  return { scene: new CardScene(createLayout(1920, 1080), input, cb), input };
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

function feedScrollPxOf(scene: CardScene): number {
  return (scene as unknown as { feedScrollPx: number }).feedScrollPx;
}

const MAX_NAME = t('card.max.name' as never);
const MARA_NAME = t('card.mara.name' as never); // also faction 'anna', like max/lena

describe('CardScene feed modal — duplicate grouping + quantity stepper', () => {
  it('collapses N identical materials into ONE row showing "0 / N"', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max'); // all max Lv.1

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    // Exactly one "Max Lv.1" row, and its count reads 0 / 3.
    expect(countLabels(scene.container, `${MAX_NAME} Lv.1`)).toBe(1);
    expect(findLabelPos(scene.container, '0 / 3')).not.toBeNull();
  });

  it('keeps distinct levels as separate rows', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      a: makeCard('a', 'max', { level: 1 }),
      b: makeCard('b', 'max', { level: 1 }),
      c: makeCard('c', 'max', { level: 2 }),
    };

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    expect(findLabelPos(scene.container, '0 / 2')).not.toBeNull(); // the two Lv.1
    expect(findLabelPos(scene.container, '0 / 1')).not.toBeNull(); // the one Lv.2
  });

  it('tapping the row body steps up to the max, then wraps to 0; Confirm shows the running total', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    // Tap up to the max.
    for (let want = 1; want <= 3; want++) {
      tapRow(scene, rowLabel);
      expect(findLabelPos(scene.container, `${want} / 3`)).not.toBeNull();
      expect(findLabelPos(scene.container, `${t('roster.feedBtn')} (${want})`)).not.toBeNull();
    }
    // One more tap past the cap wraps back to 0.
    tapRow(scene, rowLabel);
    expect(findLabelPos(scene.container, '0 / 3')).not.toBeNull();

    // Dragging the slider jumps straight to an exact value.
    dragRowTo(scene, rowLabel, 2, 3);
    expect(findLabelPos(scene.container, '2 / 3')).not.toBeNull();
    expect(findLabelPos(scene.container, `${t('roster.feedBtn')} (2)`)).not.toBeNull();
  });

  it('Confirm feeds exactly the selected quantity of material ids', async () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    let fedIds: string[] | null = null;
    const scene = buildScene(baseCb(cardInv, {
      feedCards: async (_t: string, ids: string[]) => { fedIds = ids; return { ok: true }; },
    }));
    openFeed(scene, target);

    const rowLabel = `${MAX_NAME} Lv.1`;
    tapRow(scene, rowLabel);
    tapRow(scene, rowLabel); // select 2

    const confirmPos = findLabelPos(scene.container, `${t('roster.feedBtn')} (2)`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await Promise.resolve();

    expect(fedIds).not.toBeNull();
    expect(fedIds!.length).toBe(2);
  });
});

describe('CardScene feed modal — layout & scrolling with many rows', () => {
  it('keeps Confirm/Cancel on-screen and shows a scrollbar (no pager arrows) when rows overflow', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    // Distinct levels ⇒ 12 distinct rows that overflow the 6-row panel.
    for (let lv = 1; lv <= 12; lv++) cardInv[`mat${lv}`] = makeCard(`mat${lv}`, 'max', { level: lv });

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    const h = screenHeightOf(scene);
    const hits = modalHitsOf(scene);

    const cancelPos = findLabelPos(scene.container, t('equip.cancel'));
    expect(cancelPos, 'Cancel label not found').not.toBeNull();
    const cancelHit = hitUnder(hits, cancelPos!);
    expect(cancelHit, 'no hit rect under Cancel').toBeDefined();
    expect(cancelHit!.rect.y + cancelHit!.rect.h).toBeLessThanOrEqual(h);

    // Overflow ⇒ scrollable (feedScrollMax > 0), and there are no fixed-size pager-arrow hits anymore.
    expect((scene as unknown as { feedScrollMax: number }).feedScrollMax).toBeGreaterThan(0);
  });

  it('a press-drag pans the list (feedScrollPx increases)', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let lv = 1; lv <= 12; lv++) cardInv[`mat${lv}`] = makeCard(`mat${lv}`, 'max', { level: lv });

    const { scene, input } = buildSceneWithInput(baseCb(cardInv));
    openFeed(scene, target);
    expect(feedScrollPxOf(scene)).toBe(0);

    // Press somewhere in the list area and drag upward to scroll down.
    const startPos = findLabelPos(scene.container, `${MAX_NAME} Lv.1`)!;
    input._emitDown(startPos.x, startPos.y);
    input._emitMove(startPos.x, startPos.y - 120); // past DRAG_THRESHOLD
    input._emitUp(startPos.x, startPos.y - 120);

    expect(feedScrollPxOf(scene)).toBeGreaterThan(0);
  });
});

// Regression for the 2026-07-17 press-drag-release fix, carried forward to the stepper rows: a row's
// hit fires on pointer-UP, and a drag that starts on it must NOT step it (it's a scroll gesture).
describe('press-drag-release on a feed-select row', () => {
  function openWithRow(): { scene: CardScene; input: InputManager; rowCx: number; rowCy: number } {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target, mat0: makeCard('mat0', 'max') };
    const { scene, input } = buildSceneWithInput(baseCb(cardInv));
    openFeed(scene, target);
    const rowPos = findLabelPos(scene.container, `${MAX_NAME} Lv.1`);
    expect(rowPos, 'no visible material row label').not.toBeNull();
    const rowHit = hitUnder(modalHitsOf(scene), rowPos!);
    expect(rowHit, 'no hit rect under the material row').toBeDefined();
    return {
      scene, input,
      rowCx: rowHit!.rect.x + rowHit!.rect.w / 2,
      rowCy: rowHit!.rect.y + rowHit!.rect.h / 2,
    };
  }

  it('a clean tap (down+up, no drag) steps the row selection to 1', () => {
    const { scene, input, rowCx, rowCy } = openWithRow();
    expect(findLabelPos(scene.container, '0 / 1')).not.toBeNull();

    input._emitDown(rowCx, rowCy);
    input._emitUp(rowCx, rowCy);

    expect(findLabelPos(scene.container, '1 / 1')).not.toBeNull();
  });

  it('a drag that starts on the row does NOT step it', () => {
    const { scene, input, rowCx, rowCy } = openWithRow();
    expect(findLabelPos(scene.container, '0 / 1')).not.toBeNull();

    input._emitDown(rowCx, rowCy);
    input._emitMove(rowCx, rowCy + 40); // past DRAG_THRESHOLD
    input._emitUp(rowCx, rowCy + 40);

    expect(findLabelPos(scene.container, '0 / 1')).not.toBeNull();
  });

  it('sub-threshold jitter still counts as a tap', () => {
    const { scene, input, rowCx, rowCy } = openWithRow();
    input._emitDown(rowCx, rowCy);
    input._emitMove(rowCx, rowCy + 3); // within DRAG_THRESHOLD (6)
    input._emitUp(rowCx, rowCy + 3);

    expect(findLabelPos(scene.container, '1 / 1')).not.toBeNull();
  });
});

describe('CardScene feed modal — multiple groups', () => {
  it('tracks each group independently; Confirm total is the sum across groups', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      m0: makeCard('m0', 'max'), m1: makeCard('m1', 'max'),          // Max Lv.1 (2)
      r0: makeCard('r0', 'mara'), r1: makeCard('r1', 'mara'), r2: makeCard('r2', 'mara'), // Mara Lv.1 (3)
    };

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);

    tapRow(scene, `${MAX_NAME} Lv.1`);  // Max → 1
    tapRow(scene, `${MARA_NAME} Lv.1`); // Mara → 1
    tapRow(scene, `${MARA_NAME} Lv.1`); // Mara → 2

    expect(findLabelPos(scene.container, '1 / 2')).not.toBeNull(); // Max row
    expect(findLabelPos(scene.container, '2 / 3')).not.toBeNull(); // Mara row
    expect(findLabelPos(scene.container, `${t('roster.feedBtn')} (3)`)).not.toBeNull();
  });

  it('feeds ids drawn from each selected group', async () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      m0: makeCard('m0', 'max'), m1: makeCard('m1', 'max'),
      r0: makeCard('r0', 'mara'), r1: makeCard('r1', 'mara'),
    };

    let fedIds: string[] | null = null;
    const scene = buildScene(baseCb(cardInv, {
      feedCards: async (_t: string, ids: string[]) => { fedIds = ids; return { ok: true }; },
    }));
    openFeed(scene, target);

    tapRow(scene, `${MAX_NAME} Lv.1`);  // 1 max
    tapRow(scene, `${MARA_NAME} Lv.1`); // 1 mara

    const confirmPos = findLabelPos(scene.container, `${t('roster.feedBtn')} (2)`);
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await Promise.resolve();

    expect(fedIds).not.toBeNull();
    expect(fedIds!.length).toBe(2);
    expect(fedIds!.some((id) => id.startsWith('m'))).toBe(true); // a max id
    expect(fedIds!.some((id) => id.startsWith('r'))).toBe(true); // a mara id
  });

  it('row-body tap cycles the quantity and wraps back to 0 past the cap', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target, m0: makeCard('m0', 'max'), m1: makeCard('m1', 'max'), // Max Lv.1 (2)
    };

    const scene = buildScene(baseCb(cardInv));
    openFeed(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    tapRow(scene, rowLabel); expect(findLabelPos(scene.container, '1 / 2')).not.toBeNull();
    tapRow(scene, rowLabel); expect(findLabelPos(scene.container, '2 / 2')).not.toBeNull();
    tapRow(scene, rowLabel); expect(findLabelPos(scene.container, '0 / 2')).not.toBeNull(); // wrapped
  });
});

describe('CardScene feed modal — candidate filtering', () => {
  function names(scene: CardScene): number {
    // Count how many material rows rendered (each shows a "N / M" count label).
    let n = 0;
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text && /^\d+ \/ \d+$/.test(node.text)) n++;
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(scene.container);
    return n;
  }

  it('excludes the target itself, locked, cross-faction, and deployed cards', () => {
    const target = makeCard('target', 'lena'); // faction anna
    const cardInv: Record<string, CardInstance> = {
      target,
      ok0: makeCard('ok0', 'max'),                       // eligible
      lockedCard: makeCard('lockedCard', 'max', { locked: true }), // excluded: locked
      taoCard: makeCard('taoCard', 'lichuang'),          // excluded: faction tao ≠ anna
      deployed: makeCard('deployed', 'mara'),            // excluded: on an SLG team
    };

    const scene = buildScene(baseCb(cardInv, {
      getCardState: () => ({ deployed: { teamId: 'team-1' } }),
    } as unknown as Partial<CardCallbacks>));
    openFeed(scene, target);

    // Only the one eligible 'max' remains ⇒ exactly one row.
    expect(names(scene)).toBe(1);
    expect(findLabelPos(scene.container, '0 / 1')).not.toBeNull();
  });

  it('shows the empty state and a disabled Confirm (tapping it does not feed) when nothing is eligible', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      taoCard: makeCard('taoCard', 'lichuang'), // wrong faction — nothing eligible
    };

    let fed = false;
    const scene = buildScene(baseCb(cardInv, { feedCards: async () => { fed = true; return { ok: true }; } }));
    openFeed(scene, target);

    expect(findLabelPos(scene.container, t('roster.feedEmpty'))).not.toBeNull();
    // Confirm reads "(0)" and is disabled: the only hit under it is the panel's no-op backdrop,
    // so tapping there does nothing (never calls feedCards, modal stays open).
    const confirmPos = findLabelPos(scene.container, `${t('roster.feedBtn')} (0)`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)?.action();
    expect(fed).toBe(false);
    expect(findLabelPos(scene.container, t('roster.feedEmpty'))).not.toBeNull();
  });
});

describe('CardScene feed modal — scroll clamping', () => {
  function makeOverflowScene(): { scene: CardScene; input: InputManager; startY: number } {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let lv = 1; lv <= 12; lv++) cardInv[`mat${lv}`] = makeCard(`mat${lv}`, 'max', { level: lv });
    const { scene, input } = buildSceneWithInput(baseCb(cardInv));
    openFeed(scene, target);
    const startY = findLabelPos(scene.container, `${MAX_NAME} Lv.1`)!.y;
    return { scene, input, startY };
  }

  it('never scrolls past the bottom (feedScrollPx clamps to feedScrollMax)', () => {
    const { scene, input, startY } = makeOverflowScene();
    const max = (scene as unknown as { feedScrollMax: number }).feedScrollMax;
    expect(max).toBeGreaterThan(0);

    // Drag far upward (huge delta) → would exceed content; must clamp to feedScrollMax.
    input._emitDown(960, startY);
    input._emitMove(960, startY - 5000);
    input._emitUp(960, startY - 5000);

    expect(feedScrollPxOf(scene)).toBe(max);
  });

  it('never scrolls above the top (feedScrollPx clamps to 0)', () => {
    const { scene, input, startY } = makeOverflowScene();

    // Drag downward from the top → offset can't go negative.
    input._emitDown(960, startY);
    input._emitMove(960, startY + 400);
    input._emitUp(960, startY + 400);

    expect(feedScrollPxOf(scene)).toBe(0);
  });

  it('resets the scroll offset each time the modal is (re)opened', () => {
    const { scene, input, startY } = makeOverflowScene();
    input._emitDown(960, startY);
    input._emitMove(960, startY - 300);
    input._emitUp(960, startY - 300);
    expect(feedScrollPxOf(scene)).toBeGreaterThan(0);

    // Close, then reopen — offset back to 0.
    (scene as unknown as { closeModal: () => void }).closeModal();
    const target = makeCard('target', 'lena');
    openFeed(scene, target);
    expect(feedScrollPxOf(scene)).toBe(0);
  });
});
