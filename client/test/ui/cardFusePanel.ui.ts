// Regression coverage for the fusion-ring material picker (client/src/scenes/CardScene/feed.ts,
// rewritten 2026-07-19 for the fusion redesign — CHARACTER_CARDS_DESIGN §3).
//
// Behaviours covered:
//  1. Candidate list groups by defId (level is fixed = target's level, so a group key is just defId),
//     showing a remaining-count badge; target/locked/cross-faction/different-level/deployed cards
//     are excluded from candidates.
//  2. Tapping a candidate row assigns one instance to the next empty ring slot (removing it from the
//     candidate pool); tapping a filled ring slot returns it to the pool.
//  3. Confirm reads "n/5" and only registers a hit (is tappable) once all 5 slots are filled.
//  4. Confirm calls fuseCards with exactly the 5 assigned material ids.
//  5. The list is drag-scrollable when candidate groups overflow the panel.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { tearDownChildren } from '../../src/render/sketchUi';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import type { CardInstance } from '../../src/game/meta/SaveData';
import { FUSION_MATERIAL_COUNT } from '../../src/game/meta/cardDefs';
import * as log from '../../src/net/log';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const W = 1920;
const H = 1080;

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

function modalHitsOf(scene: CardScene): Hit[] {
  return (scene as unknown as { modalHits: Hit[] }).modalHits;
}

function feedScrollPxOf(scene: CardScene): number {
  return (scene as unknown as { feedScrollPx: number }).feedScrollPx;
}

function modalOpenOf(scene: CardScene): boolean {
  return (scene as unknown as { modalOpen: boolean }).modalOpen;
}

function detailIdOf(scene: CardScene): string | null {
  return (scene as unknown as { detailId: string | null }).detailId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(scene: CardScene): any {
  return scene as unknown as Record<string, unknown>;
}

/** Flush every microtask queued by the doFuse → fuseCards → playFusionAnim → onSettled chain. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Ring-slot-0 screen position. Mirrors feed.ts's own layout math — including the dynamic S that
 * scales the whole panel so it fills 80% of the primary viewport axis (2026-07-20). Slot 0 sits at
 * angle -90° (straight up from the ring center), so its position needs no cos/sin: (ringCx, ringCy - orbit).
 *
 * W×H here is 1920×1080 → landscape (see detectOrientation), so this mirrors feed.ts's landscape
 * branch: S is chosen so the taller of the two columns fills 80% of the height, and the ring sits in
 * the left column, not centered on the whole panel width.
 */
function slotZeroPos(scene: CardScene, groupsCount: number): { x: number; y: number } {
  const headerH = (scene as unknown as { headerH: number }).headerH;
  const topLimit = headerH + 4;
  const availH = Math.max(0, (H - 8) - topLimit);
  const listRows = Math.min(Math.max(groupsCount, 1), 4);
  const headerBlockU = 52; // landscape header block (see feed.ts drawFusePanel)
  const ringU = 130, rowU = 40, footerBlockU = 52;
  const S = Math.min(H * 0.8, availH) / Math.max(headerBlockU + ringU + 8, listRows * rowU + footerBlockU + 8);
  const headerBlockH = headerBlockU * S;
  const ringH = ringU * S;
  const rowH = rowU * S;
  const footerBlockH = footerBlockU * S;

  const gap = 12 * S;
  let leftW = 180 * S;
  let rightW = 220 * S;
  const maxTotal = W - 24;
  if (leftW + gap + rightW > maxTotal) {
    const k = Math.max(0, maxTotal - gap) / (leftW + rightW);
    leftW *= k; rightW *= k;
  }
  const mw = leftW + gap + rightW;
  const leftContentH = headerBlockH + ringH + 8 * S;
  const rightContentH = listRows * rowH + footerBlockH + 8 * S;
  const mh = Math.min(Math.max(leftContentH, rightContentH), availH);
  const mx = (W - mw) / 2;
  const my = topLimit + (availH - mh) / 2;

  const ringCx = mx + leftW / 2;
  const ringCy = my + headerBlockH + ringH / 2;
  const orbit = 46 * S;
  return { x: ringCx, y: ringCy - orbit };
}

function buildScene(cb: CardCallbacks): CardScene {
  return new CardScene(createLayout(W, H), new InputManager(), cb);
}

function buildSceneWithInput(cb: CardCallbacks): { scene: CardScene; input: InputManager } {
  const input = new InputManager();
  return { scene: new CardScene(createLayout(W, H), input, cb), input };
}

function makeCard(id: string, defId: string, overrides: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level: 1, gear: {}, locked: false, ...overrides };
}

function baseCb(cardInv: Record<string, CardInstance>, overrides: Partial<CardCallbacks> = {}): CardCallbacks {
  return {
    onBack() {},
    getSave: () => ({
      cardInv,
      equipmentInv: {},
      wallet: { coins: 0 },
    } as unknown as ReturnType<CardCallbacks['getSave']>),
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
    ...overrides,
  };
}

function openFuse(scene: CardScene, target: CardInstance): void {
  (scene as unknown as { openFuseSelect: (c: CardInstance) => void }).openFuseSelect(target);
  // The placeholder fusion animation drives itself off requestAnimationFrame, which the headless
  // PIXI test harness stubs to a no-op that never re-invokes its callback (see pixiHeadless.ts) —
  // any test that taps Confirm on a fully-filled ring must stub this first, or the awaited
  // doFuse()/playFusionAnim() promise chain hangs forever.
  (scene as unknown as { playFusionAnim: () => Promise<void> }).playFusionAnim = async () => {};
}

const MAX_NAME = t('card.max.name' as never);
const MARA_NAME = t('card.mara.name' as never); // also faction 'anna', like max/lena

describe('CardScene fuse panel — candidate grouping + filtering', () => {
  it('collapses N identical-defId materials into ONE row showing "xN"', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max'); // all max Lv.1

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(countLabels(scene.container, `${MAX_NAME} Lv.1`)).toBe(1);
    expect(findLabelPos(scene.container, 'x3')).not.toBeNull();
  });

  it('excludes the target itself, locked, cross-faction, different-level, and deployed cards', () => {
    const target = makeCard('target', 'lena', { level: 2 }); // faction anna
    const cardInv: Record<string, CardInstance> = {
      target,
      ok0: makeCard('ok0', 'max', { level: 2 }),                          // eligible
      lockedCard: makeCard('lockedCard', 'max', { level: 2, locked: true }), // excluded: locked
      taoCard: makeCard('taoCard', 'lichuang', { level: 2 }),            // excluded: faction tao ≠ anna
      wrongLevel: makeCard('wrongLevel', 'mara', { level: 1 }),          // excluded: level 1 ≠ target's 2
      deployed: makeCard('deployed', 'mara', { level: 2 }),              // excluded: on an SLG team
    };

    const scene = buildScene(baseCb(cardInv, {
      getCardState: () => ({ deployed: { teamId: 'team-1' } }),
    } as unknown as Partial<CardCallbacks>));
    openFuse(scene, target);

    // Only the one eligible 'max' remains ⇒ exactly one candidate row.
    expect(findLabelPos(scene.container, `${MAX_NAME} Lv.2`)).not.toBeNull();
    expect(findLabelPos(scene.container, 'x1')).not.toBeNull();
    expect(findLabelPos(scene.container, `${t('card.lichuang.name' as never)} Lv.2`)).toBeNull();
    expect(findLabelPos(scene.container, `${MARA_NAME} Lv.2`)).toBeNull();
  });

  it('shows the empty state and a non-tappable Confirm when nothing is eligible', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = {
      target,
      taoCard: makeCard('taoCard', 'lichuang'), // wrong faction — nothing eligible
    };

    let fused = false;
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => { fused = true; return { ok: true }; } }));
    openFuse(scene, target);

    expect(findLabelPos(scene.container, t('roster.fuseEmpty'))).not.toBeNull();
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (0/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)?.action();
    expect(fused).toBe(false);
  });
});

describe('CardScene fuse panel — filling the ring', () => {
  it('tapping a candidate row fills the next empty slot, and Confirm tracks the count', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    for (let want = 1; want <= FUSION_MATERIAL_COUNT; want++) {
      const pos = findLabelPos(scene.container, rowLabel);
      expect(pos, `row missing before tap ${want}`).not.toBeNull();
      hitUnder(modalHitsOf(scene), pos!)!.action();
      expect(findLabelPos(scene.container, `${t('roster.fuseBtn')} (${want}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
    }

    // All 5 materials consumed into slots ⇒ the candidate row itself is gone.
    expect(findLabelPos(scene.container, rowLabel)).toBeNull();
  });

  it('Confirm is not tappable (no-op) until all 5 slots are filled', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    let fused = false;
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => { fused = true; return { ok: true }; } }));
    openFuse(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    // Fill only 4 of 5.
    for (let i = 0; i < FUSION_MATERIAL_COUNT - 1; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT - 1}/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    // At this position there's only the panel's whole-area no-op backdrop hit (Confirm itself
    // registers no hit while disabled) — tapping it must not trigger a fuse.
    hitUnder(modalHitsOf(scene), confirmPos!)?.action();
    expect(fused).toBe(false);
  });

  it('Confirm fuses exactly the 5 assigned material ids', async () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    let fusedTarget: string | null = null;
    let fusedIds: string[] | null = null;
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: async (targetId: string, ids: string[]) => { fusedTarget = targetId; fusedIds = ids; return { ok: true }; },
    }));
    openFuse(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await Promise.resolve();
    await Promise.resolve(); // let the async doFuse chain (fuseCards → playFusionAnim) settle

    expect(fusedTarget).toBe('target');
    expect(fusedIds).not.toBeNull();
    expect(fusedIds).toHaveLength(FUSION_MATERIAL_COUNT);
    expect(new Set(fusedIds!).size).toBe(FUSION_MATERIAL_COUNT); // no duplicate ids
  });

  it('tapping a filled ring slot returns that card to the candidate pool', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 2; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    const rowLabel = `${MAX_NAME} Lv.1`;

    // Assign one of the two — the candidate row now reads "x1".
    hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    expect(findLabelPos(scene.container, 'x1')).not.toBeNull();

    // Tap the ring slot it landed in (always slot 0, the first assigned) to return it.
    const slotPos = slotZeroPos(scene, 1);
    const slotHit = hitUnder(modalHitsOf(scene), slotPos);
    expect(slotHit, 'no hit rect at the filled ring slot').toBeDefined();
    slotHit!.action();

    expect(findLabelPos(scene.container, 'x2')).not.toBeNull();
  });
});

describe('CardScene fuse panel — candidate list scroll state', () => {
  // Grouping is now by defId alone (level is fixed = target's level), and each faction only has 3
  // defIds — so the candidate list can have at most 3 rows, under the panel's 4-row-before-scroll
  // threshold. Real overflow is therefore structurally unreachable with today's card catalog; this
  // documents that the scroll plumbing (feedScrollPx/feedScrollMax, carried over from the old feed
  // panel) stays inert rather than pretending to exercise a drag-scroll that can't occur.
  it('feedScrollMax is 0 (no overflow) with the current 3-defId-per-faction catalog', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target, m0: makeCard('m0', 'max'), r0: makeCard('r0', 'mara') };

    const { scene, input } = buildSceneWithInput(baseCb(cardInv));
    openFuse(scene, target);
    expect(feedScrollPxOf(scene)).toBe(0);
    expect((scene as unknown as { feedScrollMax: number }).feedScrollMax).toBe(0);

    // A drag over the (non-overflowing) list is a no-op, not a crash.
    const startPos = findLabelPos(scene.container, `${MAX_NAME} Lv.1`)!;
    input._emitDown(startPos.x, startPos.y);
    input._emitMove(startPos.x, startPos.y - 120);
    input._emitUp(startPos.x, startPos.y - 120);
    expect(feedScrollPxOf(scene)).toBe(0);
  });
});

describe('CardScene fuse panel — auto-retarget when the tapped card has too few materials', () => {
  it('swaps in the highest-level fusable card and toasts, when the tapped target has 0 materials', () => {
    const target = makeCard('target', 'lena', { level: 1 }); // faction anna, no materials at all
    const altLow = makeCard('altLow', 'lichuang', { level: 1 });   // faction tao, level 1
    const altHigh = makeCard('altHigh', 'chenshou', { level: 2 }); // faction tao, level 2 — should win (higher level)
    const cardInv: Record<string, CardInstance> = { target, altLow, altHigh };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`loMat${i}`] = makeCard(`loMat${i}`, 'suyuan', { level: 1 });
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`hiMat${i}`] = makeCard(`hiMat${i}`, 'suyuan', { level: 2 });

    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildScene(baseCb(cardInv));
    (scene as unknown as { openFuseSelect: (c: CardInstance) => void }).openFuseSelect(target);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(t('roster.fuseAutoRetarget'));
    // The ring now centers on altHigh (Lv.2), not the tapped target or altLow (both Lv.1).
    expect(findLabelPos(scene.container, 'Lv.2')).not.toBeNull();
    expect(findLabelPos(scene.container, 'Lv.1')).toBeNull();
    spy.mockRestore();
  });

  it('does not retarget or toast when the tapped target already has 5 materials', () => {
    const target = makeCard('target', 'lena', { level: 1 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(spy).not.toHaveBeenCalled();
    expect(findLabelPos(scene.container, 'Lv.1')).not.toBeNull();
    spy.mockRestore();
  });
});

describe('CardScene fuse panel — auto-continue after a successful fuse', () => {
  /** A fuseCards stub that mirrors the real server: removes the consumed materials and levels up
   * the target, so findAutoTarget sees post-fuse state exactly like production would. */
  function mutatingFuseCards(cardInv: Record<string, CardInstance>, calls: { targetId: string; ids: string[] }[]): CardCallbacks['fuseCards'] {
    return async (targetId: string, ids: string[]) => {
      calls.push({ targetId, ids });
      for (const id of ids) delete cardInv[id];
      cardInv[targetId].level += 1;
      return { ok: true };
    };
  }

  it('level-1 target: after Confirm succeeds, auto-loads another level-1 card and keeps the panel open', async () => {
    const target = makeCard('target', 'lena', { level: 1 });        // faction anna
    const target2 = makeCard('target2', 'lichuang', { level: 1 });  // faction tao — never a valid material for `target`
    const cardInv: Record<string, CardInstance> = { target, target2 };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`matA${i}`] = makeCard(`matA${i}`, 'max', { level: 1 });      // anna — target's materials
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`matB${i}`] = makeCard(`matB${i}`, 'chenshou', { level: 1 }); // tao — target2's materials

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);

    const rowLabel = `${MAX_NAME} Lv.1`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0].targetId).toBe('target');
    expect(target.level).toBe(2); // the original target really did level up
    expect(modalOpenOf(scene)).toBe(true); // stayed open instead of closing
    // The ring/list now reflect target2 (still Lv.1) and its own material pool.
    expect(findLabelPos(scene.container, `${t('card.chenshou.name' as never)} Lv.1`)).not.toBeNull();
    expect(findLabelPos(scene.container, rowLabel)).toBeNull(); // old target's material group is gone (consumed)
  });

  it('level-3+ target: after Confirm succeeds, closes the panel like before the auto-continue feature', async () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);

    const rowLabel = `${MAX_NAME} Lv.3`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(modalOpenOf(scene)).toBe(false);
    expect(detailIdOf(scene)).toBeNull();
  });

  it('level-1 target with no other fusable card: falls back to closing instead of continuing forever', async () => {
    const target = makeCard('target', 'lena', { level: 1 }); // the only level-1 card in the roster
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 1 });

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);

    const rowLabel = `${MAX_NAME} Lv.1`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(target.level).toBe(2); // leveled up once, then had nothing left to continue onto
    expect(modalOpenOf(scene)).toBe(false);
  });

  it('prefers continuing with another card of the same defId over an unrelated one inserted earlier', async () => {
    const target = makeCard('target', 'lena', { level: 1 });              // faction anna
    // Inserted before `lena2` so the old first-found-wins tie-break would have picked it instead.
    const otherLine = makeCard('otherLine', 'lichuang', { level: 1 });    // faction tao — unrelated card line
    const lena2 = makeCard('lena2', 'lena', { level: 1 });                // same defId as `target` — the expected pick
    const cardInv: Record<string, CardInstance> = { target, otherLine, lena2 };
    // Enough anna-faction materials to cover both the initial fuse and lena2's own pool afterwards.
    for (let i = 0; i < FUSION_MATERIAL_COUNT * 2; i++) cardInv[`matA${i}`] = makeCard(`matA${i}`, 'max', { level: 1 });
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`matB${i}`] = makeCard(`matB${i}`, 'chenshou', { level: 1 }); // tao — otherLine's materials

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);

    const rowLabel = `${MAX_NAME} Lv.1`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    const confirmPos = findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    hitUnder(modalHitsOf(scene), confirmPos!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(modalOpenOf(scene)).toBe(true); // stayed open, continuing
    // Continued onto lena2 (still anna-faction 'max' materials), not otherLine (tao-faction 'chenshou').
    expect(findLabelPos(scene.container, rowLabel)).not.toBeNull();
    expect(findLabelPos(scene.container, `${t('card.chenshou.name' as never)} Lv.1`)).toBeNull();
  });
});

// Regression: the fusion animation (playFusionAnim) draws flash/burst PIXI.Graphics onto modalLayer
// and animates them over ~1s of requestAnimationFrame ticks. The busy-dots re-render in update()
// (bt.tick → render()) used to fire every 0.4s during that window, and render() rebuilds the modal
// (openDetail → tearDownChildren(modalLayer)) since detailId stays set through the whole fuse. That
// destroyed the live burst graphics; the next rAF tick called burst.clear() on a destroyed Graphics
// → "Cannot read properties of null (reading 'clear')", which also left the fuse promise unresolved
// and bt.busy stuck on forever (permanent "Processing." lock). Root-cause fix: fuseInProgress
// suppresses the busy re-render for the whole fuse. Defensive fix: the animation ticks bail cleanly
// if their graphics were destroyed out from under them.
describe('CardScene fuse panel — animation is not torn down by the busy re-render', () => {
  it('mid-fuse update() ticks do not rebuild the modal (which would destroy the live VFX)', async () => {
    const target = makeCard('target', 'lena', { level: 3 }); // level 3 ⇒ no auto-continue, closes on settle
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    const scene = buildScene(baseCb(cardInv));
    priv(scene).openFuseSelect(target);
    priv(scene).detailId = target.id; // the fuse is always reached from the detail modal in production
    // Hold the animation open so the fuse stays in flight while we pump update().
    let releaseAnim: () => void = () => {};
    priv(scene).playFusionAnim = () => new Promise<void>((r) => { releaseAnim = r; });

    const rowLabel = `${MAX_NAME} Lv.3`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    hitUnder(modalHitsOf(scene), findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.action();
    await flushAsync(); // doFuse → fuseCards resolves → parks on the awaited playFusionAnim

    expect(priv(scene).fuseInProgress).toBe(true);
    const openDetailSpy = vi.spyOn(priv(scene), 'openDetail');

    // Cross the 1s loading threshold, then several dot cycles — the OLD bug rebuilt the modal here.
    priv(scene).update(1.2);
    for (let i = 0; i < 5; i++) priv(scene).update(0.45);

    expect(openDetailSpy).not.toHaveBeenCalled();
    expect(findLabelPos(scene.container, t('roster.fuseTitle'))).not.toBeNull(); // fuse ring still standing

    releaseAnim();
    await flushAsync();
    expect(priv(scene).fuseInProgress).toBe(false); // flag released so the scene isn't stuck busy
    openDetailSpy.mockRestore();
  });

  it('a modal teardown mid-animation does not throw and still settles the fuse (null _geometry guard)', async () => {
    const rafQueue: FrameRequestCallback[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const origRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (cb: FrameRequestCallback): number => { rafQueue.push(cb); return rafQueue.length; };
    try {
      const target = makeCard('target', 'lena', { level: 3 });
      const cardInv: Record<string, CardInstance> = { target };
      for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

      const scene = buildScene(baseCb(cardInv));
      priv(scene).openFuseSelect(target); // real playFusionAnim
      priv(scene).fuseRingGeom = null; // skip the converge phase → straight to the burst phase

      const p = priv(scene).playFusionAnim() as Promise<void>;
      expect(rafQueue.length).toBe(1); // burst phase registered its first frame synchronously

      // Destroy the burst/flash out from under the loop — exactly what the busy re-render used to do.
      tearDownChildren(priv(scene).modalLayer);
      // The next frame must NOT throw "Cannot read properties of null (reading 'clear')".
      expect(() => rafQueue.shift()!(performance.now())).not.toThrow();
      await p; // and the promise resolves instead of hanging forever
    } finally {
      g.requestAnimationFrame = origRaf;
    }
  });

  it('end-to-end: the real animation + busy update() ticks run to completion and close the panel', async () => {
    const rafQueue: FrameRequestCallback[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const origRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (cb: FrameRequestCallback): number => { rafQueue.push(cb); return rafQueue.length; };
    let clock = 1000; // playFusionAnim reads performance.now() (not the rAF timestamp) to advance f
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const target = makeCard('target', 'lena', { level: 3 }); // level 3 ⇒ closes on settle
      const cardInv: Record<string, CardInstance> = { target };
      for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

      const scene = buildScene(baseCb(cardInv));
      priv(scene).openFuseSelect(target); // REAL playFusionAnim, driven by the controllable rAF + clock
      priv(scene).detailId = target.id;

      const rowLabel = `${MAX_NAME} Lv.3`;
      for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
        hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
      }
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.action();
      await flushAsync(); // fuseCards resolves; playFusionAnim registers its first (converge) frame
      expect(rafQueue.length).toBeGreaterThan(0);

      // Drain both animation phases, calling update(0.5) between every frame — that dt crosses the 1s
      // loading gate and cycles the busy dots, i.e. the exact re-render that used to tear the live
      // Graphics down. Advancing the clock 60ms/frame carries f past CONVERGE_MS(380)+DURATION_MS(650).
      let threw: unknown = null;
      for (let guard = 0; guard < 500; guard++) {
        if (rafQueue.length === 0) {
          await flushAsync();               // let a phase→phase await register the next frame
          if (rafQueue.length === 0) break; // both phases done
        }
        const cb = rafQueue.shift()!;
        clock += 60;
        try { cb(clock); } catch (e) { threw = e; break; }
        priv(scene).update(0.5);
      }
      await flushAsync();

      expect(threw).toBeNull();                 // no "reading 'clear'" crash
      expect(priv(scene).bt.busy).toBe(false);  // fuse settled — didn't hang on an unresolved promise
      expect(priv(scene).fuseInProgress).toBe(false);
      expect(modalOpenOf(scene)).toBe(false);   // level-3 target closes the panel after a successful fuse
      expect(detailIdOf(scene)).toBeNull();
    } finally {
      g.requestAnimationFrame = origRaf;
      nowSpy.mockRestore();
    }
  });

  it('a fuse whose network call fails still clears fuseInProgress + bt.busy (no permanent render lock)', async () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    // Server error path: fuseCards throws (playFusionAnim is never reached, so its stub is moot).
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => { throw new Error('network boom'); } }));
    openFuse(scene, target);
    priv(scene).detailId = target.id;

    const rowLabel = `${MAX_NAME} Lv.3`;
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
      hitUnder(modalHitsOf(scene), findLabelPos(scene.container, rowLabel)!)!.action();
    }
    hitUnder(modalHitsOf(scene), findLabelPos(scene.container, `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.action();
    await flushAsync();

    expect(priv(scene).fuseInProgress).toBe(false); // finally cleared it even though the fuse failed
    expect(priv(scene).bt.busy).toBe(false);
    // The busy re-render is no longer suppressed, and normal update() ticks still work.
    expect(() => priv(scene).update(0.1)).not.toThrow();
  });
});

describe('CardScene fuse panel — fills 80% of the primary viewport axis (2026-07-20)', () => {
  // The panel scales its whole layout (dynamic S) so it fills 80% of the primary axis: height in
  // landscape, width in portrait — the secondary axis stays content-driven. m(x,y,w,h) isn't
  // exposed, but drawFusePanel pushes the panel's own box as the penultimate modalHit (the
  // dismiss-on-backdrop no-op), immediately before the full-screen backdrop hit.
  function panelRect(scene: CardScene): { x: number; y: number; w: number; h: number } {
    const hits = modalHitsOf(scene);
    return hits[hits.length - 2].rect;
  }

  function withMaterials(target: CardInstance): Record<string, CardInstance> {
    const inv: Record<string, CardInstance> = { [target.id]: target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) inv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: target.level });
    return inv;
  }

  it('landscape (1920×1080): panel height is 80% of the viewport height', () => {
    const target = makeCard('target', 'lena');
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), baseCb(withMaterials(target)));
    openFuse(scene, target);

    const availH = (1080 - 8) - ((priv(scene).headerH as number) + 4);
    expect(availH).toBeGreaterThanOrEqual(1080 * 0.8); // 80% is reachable, not clamped by the header
    expect(panelRect(scene).h).toBeCloseTo(1080 * 0.8, 0);
  });

  it('portrait (1080×1920): panel width is 80% of the viewport width', () => {
    const target = makeCard('target', 'lena');
    const scene = new CardScene(createLayout(1080, 1920), new InputManager(), baseCb(withMaterials(target)));
    openFuse(scene, target);

    expect(panelRect(scene).w).toBeCloseTo(1080 * 0.8, 0);
  });
});
