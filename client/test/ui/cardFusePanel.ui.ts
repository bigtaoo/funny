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
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import type { CardInstance } from '../../src/game/meta/SaveData';
import { FUSION_MATERIAL_COUNT } from '../../src/game/meta/cardDefs';

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

/**
 * Ring-slot-0 screen position. Mirrors feed.ts's own layout constants (S=2, headerBlockH=40*S,
 * ringH=130*S, orbit=46*S) — same convention as the old feed-modal test's HANDLE_R replication.
 * Slot 0 sits at angle -90° (straight up from the ring center), so its position needs no cos/sin:
 * (ringCx, ringCy - orbit). ringCx always equals w/2 regardless of panel width (mx + mw/2 = w/2).
 */
function slotZeroPos(scene: CardScene, groupsCount: number): { x: number; y: number } {
  const headerH = (scene as unknown as { headerH: number }).headerH;
  const S = 2;
  const topLimit = headerH + 4;
  const availH = Math.max(0, (H - 8) - topLimit);
  const headerBlockH = 40 * S;
  const ringH = 130 * S;
  const rowH = 40 * S;
  const footerBlockH = 52 * S;
  const listRows = Math.min(Math.max(groupsCount, 1), 4);
  const mh = Math.min(headerBlockH + ringH + listRows * rowH + footerBlockH, availH);
  const my = topLimit + (availH - mh) / 2;
  const ringCx = W / 2;
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
