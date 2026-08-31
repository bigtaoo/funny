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
import { CRUMB_U, GAP_U, STRIP_U } from '../../src/scenes/CardScene/feedGap';
import { PREP_COST_PER_CARD } from '../../src/scenes/CardScene/logic/feedPlan';
import * as log from '../../src/net/log';
import { SaveManager } from '../../src/game/meta/SaveManager';
import { LocalSaveStore } from '../../src/game/meta/SaveStore';
import { cardInstanceArtUrl } from '../../src/render/cardArt';
import { skinEquipKey } from '../../src/game/meta/skinDefs';
import { UnitType } from '@nw/engine/types';

// Every export passes through untouched except cardInstanceArtUrl, wrapped in vi.fn (keeping its
// real implementation) so the 2026-08-01-scoping spec below can inspect call arguments.
vi.mock('../../src/render/cardArt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/cardArt')>();
  return { ...actual, cardInstanceArtUrl: vi.fn(actual.cardInstanceArtUrl) };
});

/** Fresh in-memory IStorage — a new instance per call so SaveManagers in different tests never share state. */
function freshStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void } {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
}
initI18n('en', freshStorage(), ['zh', 'en', 'de']);

const W = 1920;
const H = 1080;

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

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

/** Star count of the ring's target-level indicator (feed.ts draws it as one 'levelStars' container
 * under the center portrait — see the roster-grid convention in cardSceneLevelStars.ui.ts). The fuse
 * panel has exactly one such container (candidate rows no longer show their own, 2026-07-25). */
function ringStarCount(container: PIXI.Container): number {
  let found: PIXI.Container | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node.name === 'levelStars') { found = node; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found ? (found as PIXI.Container).children.length : 0;
}

function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

function modalHitsOf(scene: CardScene): Hit[] {
  return (scene as unknown as { core: { modalHits: Hit[] } }).core.modalHits;
}

/** The fuse panel draws everything into modalLayer, which sits on top of (and independent from) the
 * background roster grid (bodyLayer) — but both hang off the same scene.container tree. Since the
 * grid can easily own other cards sharing a candidate's defId (e.g. the 'max' materials used
 * throughout this file), searching scene.container for a bare card name like "Max" can match a
 * background grid cell instead of (or in addition to) the fuse row. Restricting the search to
 * modalLayer sidesteps that collision entirely. */
function modalLayerOf(scene: CardScene): PIXI.Container {
  return (scene as unknown as { core: { modalLayer: PIXI.Container } }).core.modalLayer;
}

/** Coin balance + capacity readout (renderHeaderCurrency) lives here — separate from bodyLayer/modalLayer. */
function headerOverlayLayerOf(scene: CardScene): PIXI.Container {
  return (scene as unknown as { core: { headerOverlayLayer: PIXI.Container } }).core.headerOverlayLayer;
}

function feedScrollPxOf(scene: CardScene): number {
  return (scene as unknown as { core: { feedScrollPx: number } }).core.feedScrollPx;
}

function modalOpenOf(scene: CardScene): boolean {
  return (scene as unknown as { core: { modalOpen: boolean } }).core.modalOpen;
}

function detailIdOf(scene: CardScene): string | null {
  return (scene as unknown as { core: { detailId: string | null } }).core.detailId;
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
 * the left column, not centered on the whole panel width. `blocks` names the optional rows the panel
 * reserves height for on that frame (gap notice / batch button, recommendation strip, prep crumb) —
 * they change S and the ring's Y, so a caller must pass whichever ones its fixture triggers.
 */
function slotZeroPos(
  scene: CardScene,
  groupsCount: number,
  blocks: { action?: boolean; strip?: boolean; crumb?: boolean } = {},
): { x: number; y: number } {
  const headerH = (scene as unknown as { core: { headerH: number } }).core.headerH;
  const topLimit = headerH + 4;
  const availH = Math.max(0, (H - 8) - topLimit);
  const listRows = Math.min(Math.max(groupsCount, 1), 4);
  const headerBlockU = 52; // landscape header block (see feed.ts drawFusePanel)
  const ringU = 130, rowU = 40, footerBlockU = 52;
  const crumbU = blocks.crumb ? CRUMB_U : 0;
  const actionU = blocks.action ? GAP_U : 0;
  const stripU = blocks.strip ? STRIP_U : 0;
  const leftU = headerBlockU + ringU + 8;
  const rightU = listRows * rowU + actionU + stripU + footerBlockU + 8;
  const S = Math.min(H * 0.8, availH) / (crumbU + Math.max(leftU, rightU));
  const headerBlockH = headerBlockU * S;
  const ringH = ringU * S;
  const crumbH = crumbU * S;

  const gap = 12 * S;
  let leftW = 180 * S;
  let rightW = 220 * S;
  const maxTotal = W - 24;
  if (leftW + gap + rightW > maxTotal) {
    const k = Math.max(0, maxTotal - gap) / (leftW + rightW);
    leftW *= k; rightW *= k;
  }
  const mw = leftW + gap + rightW;
  const mh = Math.min(crumbH + Math.max(leftU, rightU) * S, availH);
  const mx = (W - mw) / 2;
  const my = topLimit + (availH - mh) / 2;

  const ringCx = mx + leftW / 2;
  const ringCy = my + crumbH + headerBlockH + ringH / 2;
  const orbit = 46 * S;
  return { x: ringCx, y: ringCy - orbit };
}

/**
 * Center of recommendation-strip chip `index`, mirroring feedGap.drawRecommendStrip's own layout
 * inside feed.ts's landscape right column. The chips carry no text (portrait + stars only), so a
 * label search cannot find them — same reason slotZeroPos exists for the ring.
 */
function stripChipPos(
  scene: CardScene,
  groupsCount: number,
  blocks: { action?: boolean; strip?: boolean; crumb?: boolean },
  index: number,
): { x: number; y: number } {
  const headerH = (scene as unknown as { core: { headerH: number } }).core.headerH;
  const topLimit = headerH + 4;
  const availH = Math.max(0, (H - 8) - topLimit);
  const listRows = Math.min(Math.max(groupsCount, 1), 4);
  const headerBlockU = 52;
  const ringU = 130, rowU = 40, footerBlockU = 52;
  const crumbU = blocks.crumb ? CRUMB_U : 0;
  const actionU = blocks.action ? GAP_U : 0;
  const stripU = blocks.strip ? STRIP_U : 0;
  const leftU = headerBlockU + ringU + 8;
  const rightU = listRows * rowU + actionU + stripU + footerBlockU + 8;
  const S = Math.min(H * 0.8, availH) / (crumbU + Math.max(leftU, rightU));

  const gap = 12 * S;
  let leftW = 180 * S;
  let rightW = 220 * S;
  const maxTotal = W - 24;
  if (leftW + gap + rightW > maxTotal) {
    const k = Math.max(0, maxTotal - gap) / (leftW + rightW);
    leftW *= k; rightW *= k;
  }
  const mw = leftW + gap + rightW;
  const mh = Math.min(crumbU * S + Math.max(leftU, rightU) * S, availH);
  const mx = (W - mw) / 2;
  const my = topLimit + (availH - mh) / 2;

  const colX = mx + leftW + gap;
  const stripY = (my + mh) - footerBlockU * S - stripU * S;
  const chipW = 34 * S, chipGap = 4 * S, chipH = 22 * S;
  return { x: colX + 6 * S + index * (chipW + chipGap) + chipW / 2, y: stripY + 11 * S + chipH / 2 };
}

/** A fuseCards stub mirroring the real server: consumes the materials and levels the target up, so
 *  the panel re-evaluates against post-fuse state exactly like production would. */
function mutatingFuseCards(
  cardInv: Record<string, CardInstance>,
  calls: { targetId: string; ids: string[] }[],
): CardCallbacks['fuseCards'] {
  return async (targetId: string, ids: string[]) => {
    calls.push({ targetId, ids });
    for (const id of ids) delete cardInv[id];
    cardInv[targetId].level += 1;
    return { ok: true };
  };
}

/** Batch-fuse counterpart of mutatingFuseCards: applies the whole planned run in one call. */
function mutatingFuseBatch(
  cardInv: Record<string, CardInstance>,
  calls: { targetId: string; ids: string[] }[],
): CardCallbacks['fuseCardsBatch'] {
  return async (rounds) => {
    for (const r of rounds) {
      calls.push({ targetId: r.targetId, ids: r.materialIds });
      for (const id of r.materialIds) delete cardInv[id];
      cardInv[r.targetId].level += 1;
    }
    return { ok: true, completed: rounds.length };
  };
}

/** Tap a full ring's Confirm and let the doFuse chain settle. */
async function confirmFuse(scene: CardScene): Promise<void> {
  hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
  await flushAsync();
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
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
    ...overrides,
  };
}

function openFuse(scene: CardScene, target: CardInstance): void {
  (scene as unknown as { feed: { openFuseSelect: (c: CardInstance) => void } }).feed.openFuseSelect(target);
  // The placeholder fusion animation drives itself off requestAnimationFrame, which the headless
  // PIXI test harness stubs to a no-op that never re-invokes its callback (see pixiHeadless.ts) —
  // any test that taps Confirm on a fully-filled ring must stub this first, or the awaited
  // doFuse()/playFusionAnim() promise chain hangs forever.
  (scene as unknown as { feed: { playFusionAnim: () => Promise<void> } }).feed.playFusionAnim = async () => {};
}

const MAX_NAME = t('card.max.name' as never);
const MARA_NAME = t('card.mara.name' as never); // also faction 'anna', like max/lena

describe('CardScene fuse panel — candidate grouping + filtering', () => {
  it('collapses N identical-defId materials into ONE row showing "xN"', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    // 8 identical materials: 5 are pre-loaded into the ring on open (autoFillMaterials), so the
    // single collapsed row reports the 3 still sitting in the pool.
    for (let i = 0; i < 8; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max'); // all max Lv.1

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(countLabels(modalLayerOf(scene), MAX_NAME)).toBe(1);
    expect(findLabelPos(modalLayerOf(scene), 'x3')).not.toBeNull();
  });

  it('excludes the target itself, locked, cross-faction, different-level, and deployed cards', () => {
    const target = makeCard('target', 'lena', { level: 2 }); // faction anna
    const cardInv: Record<string, CardInstance> = {
      target,
      ok0: makeCard('ok0', 'max', { level: 2 }),                          // eligible
      ok1: makeCard('ok1', 'max', { level: 2 }),                          // eligible
      ok2: makeCard('ok2', 'max', { level: 2 }),                          // eligible
      ok3: makeCard('ok3', 'max', { level: 2 }),                          // eligible
      ok4: makeCard('ok4', 'max', { level: 2 }),                          // eligible
      ok5: makeCard('ok5', 'max', { level: 2 }),                          // eligible
      lockedCard: makeCard('lockedCard', 'max', { level: 2, locked: true }), // excluded: locked
      taoCard: makeCard('taoCard', 'lichuang', { level: 2 }),            // excluded: faction tao ≠ anna
      wrongLevel: makeCard('wrongLevel', 'mara', { level: 1 }),          // excluded: level 1 ≠ target's 2
      deployed: makeCard('deployed', 'mara', { level: 2 }),              // excluded: on an SLG team
    };

    const scene = buildScene(baseCb(cardInv, {
      getCardState: () => ({ deployed: { teamId: 'team-1' } }),
    } as unknown as Partial<CardCallbacks>));
    openFuse(scene, target);

    // Only 'max' is eligible ⇒ exactly one candidate row; 5 of the 6 went into the ring, so it reads x1.
    expect(findLabelPos(modalLayerOf(scene), MAX_NAME)).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), 'x1')).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('card.lichuang.name' as never))).toBeNull();
    expect(findLabelPos(modalLayerOf(scene), MARA_NAME)).toBeNull();
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

    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseEmpty'))).not.toBeNull();
    const confirmPos = findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (0/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)?.fn();
    expect(fused).toBe(false);
  });
});

describe('CardScene fuse panel — filling the ring', () => {
  it('opens with the ring pre-filled, and a returned card can be re-picked from the row', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    // Exactly 5 eligible materials ⇒ all of them are pre-loaded, so Confirm is live immediately and
    // the candidate row is empty. This is the 2026-08-18 auto-fill: the ring always shows the true
    // readiness of whichever card is centered, rather than starting blank.
    expect(findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), MAX_NAME)).toBeNull();

    // Put slot 0's card back: Confirm drops to 4/5 and the row reappears with that one card.
    hitUnder(modalHitsOf(scene), slotZeroPos(scene, 1, { action: false }))!.fn();
    expect(findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT - 1}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
    const rowPos = findLabelPos(modalLayerOf(scene), MAX_NAME);
    expect(rowPos, 'returned card must show up as a candidate row again').not.toBeNull();

    // Picking it puts it straight back into the free slot.
    hitUnder(modalHitsOf(scene), rowPos!)!.fn();
    expect(findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
  });

  it('Confirm is not tappable (no-op) until all 5 slots are filled', () => {
    const target = makeCard('target', 'lena');
    const cardInv: Record<string, CardInstance> = { target };
    // One short of a fusion: auto-fill loads all 4 it can find and the ring sits at 4/5.
    for (let i = 0; i < FUSION_MATERIAL_COUNT - 1; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    let fused = false;
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => { fused = true; return { ok: true }; } }));
    openFuse(scene, target);

    const confirmPos = findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT - 1}/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    // At this position there's only the panel's whole-area no-op backdrop hit (Confirm itself
    // registers no hit while disabled) — tapping it must not trigger a fuse.
    hitUnder(modalHitsOf(scene), confirmPos!)?.fn();
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

    const confirmPos = findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
    expect(confirmPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), confirmPos!)!.fn();
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

    // Both cards were pre-loaded into slots on open, so the candidate list starts empty.
    expect(findLabelPos(modalLayerOf(scene), MAX_NAME)).toBeNull();

    // Tap slot 0 to return its card — the gap notice is on screen (2 of 5 materials), so the panel
    // reserves the action row and the ring sits lower than it would without it.
    const slotPos = slotZeroPos(scene, 1, { action: true });
    const slotHit = hitUnder(modalHitsOf(scene), slotPos);
    expect(slotHit, 'no hit rect at the filled ring slot').toBeDefined();
    slotHit!.fn();

    expect(findLabelPos(modalLayerOf(scene), 'x1')).not.toBeNull();
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
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 6; i++) cardInv[`m${i}`] = makeCard(`m${i}`, 'max');
    for (let i = 0; i < 6; i++) cardInv[`r${i}`] = makeCard(`r${i}`, 'mara');

    const { scene, input } = buildSceneWithInput(baseCb(cardInv));
    openFuse(scene, target);
    expect(feedScrollPxOf(scene)).toBe(0);
    expect((scene as unknown as { core: { feedScrollMax: number } }).core.feedScrollMax).toBe(0);

    // A drag over the (non-overflowing) list is a no-op, not a crash.
    const startPos = findLabelPos(modalLayerOf(scene), MAX_NAME)!;
    input._emitDown(startPos.x, startPos.y);
    input._emitMove(startPos.x, startPos.y - 120);
    input._emitUp(startPos.x, startPos.y - 120);
    expect(feedScrollPxOf(scene)).toBe(0);
  });
});

// ── Target intent (2026-08-18 redesign) ───────────────────────────────────────────────────────
// These replace the former "auto-retarget" and "auto-continue" suites, which pinned down the exact
// opposite behaviour: the panel used to silently swap in a different card when the tapped one had
// no materials, and to hop onward after every low-level fuse. Both were dropped — a target the
// player did not choose is the confusion the whole redesign exists to remove
// (CHARACTER_CARDS_DESIGN §3.2). The ranking those patches used survives as the recommendation
// strip's sort order (feedPlan.listFusableTargets, unit-tested in test/feedPlan.test.ts).
describe('CardScene fuse panel — the target only changes when the player taps', () => {
  /** A starved Lv.1 lena, alongside a Lv.3 mara that IS fusable — the exact shape that used to
   *  trigger an automatic swap. Stars on the ring disambiguate which card is centered. */
  function starvedTargetInv(): { target: CardInstance; cardInv: Record<string, CardInstance> } {
    const target = makeCard('target', 'lena', { level: 1 }); // faction anna, zero Lv.1 materials
    const cardInv: Record<string, CardInstance> = { target, alt: makeCard('alt', 'mara', { level: 3 }) };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 3 });
    return { target, cardInv };
  }

  it('keeps the tapped card centered and states the shortfall, instead of swapping to a fusable one', () => {
    const { target, cardInv } = starvedTargetInv();
    const toastSpy = vi.spyOn(log, 'showToastMessage');
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(ringStarCount(modalLayerOf(scene)), 'ring must still show the Lv.1 card the player tapped').toBe(1);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseNeedMore', { n: FUSION_MATERIAL_COUNT, lv: 1 }))).not.toBeNull();
    expect(toastSpy, 'no toast: nothing was decided on the player behalf').not.toHaveBeenCalled();
    toastSpy.mockRestore();
  });

  it('surfaces the fusable cards in the recommendation strip and retargets only on a tap', () => {
    const { target, cardInv } = starvedTargetInv();
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseReadyList'))).not.toBeNull();
    expect(ringStarCount(modalLayerOf(scene))).toBe(1);

    // The Lv.3 mara leads the strip (highest level among the fusable cards), so chip 0 is it.
    const chipHit = hitUnder(modalHitsOf(scene), stripChipPos(scene, 1, { action: true, strip: true }, 0));
    expect(chipHit, 'no hit rect on the first recommendation chip').toBeDefined();
    chipHit!.fn();

    expect(ringStarCount(modalLayerOf(scene)), 'tapping a chip is the ONLY way the target moves').toBe(3);
  });

  it('hides the strip while a prep run is open, so the crumb is the only offer on screen', () => {
    const target = makeCard('target', 'lena', { level: 2 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT - 1; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 2 });
    for (let i = 0; i < PREP_COST_PER_CARD; i++) cardInv[`lo${i}`] = makeCard(`lo${i}`, 'max', { level: 1 });

    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseReadyList')), 'strip is on before prep').not.toBeNull();

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))!)!.fn();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseReadyList'))).toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))).not.toBeNull();
  });
});

describe('CardScene fuse panel — a successful fuse stays on the same card', () => {
  it('leaves the panel open on the SAME card, now one level higher', async () => {
    const target = makeCard('target', 'lena', { level: 1 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    await confirmFuse(scene);

    expect(calls).toHaveLength(1);
    expect(calls[0].targetId).toBe('target');
    expect(modalOpenOf(scene), 'panel stays open so the player can see the result').toBe(true);
    expect(ringStarCount(modalLayerOf(scene)), 'still the same card, now Lv.2').toBe(2);
  });

  it('does not hop to another fusable card once the upgraded one runs dry', async () => {
    const target = makeCard('target', 'lena', { level: 1 });
    const cardInv: Record<string, CardInstance> = { target, other: makeCard('other', 'mara', { level: 1 }) };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max');
    // 'other' keeps its own 5 materials, so it stays fusable after the target's fuse consumes theirs.
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`spare${i}`] = makeCard(`spare${i}`, 'max');

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    await confirmFuse(scene);

    expect(calls).toHaveLength(1);
    // Lv.2 ⇒ still the original target. A hop to the Lv.1 'other' would read as 1 star.
    expect(ringStarCount(modalLayerOf(scene))).toBe(2);
    // ...but the strip now offers it, one tap away.
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseReadyList'))).not.toBeNull();
  });

  it('a Lv.3 target also stays open (the old level-3+ auto-close is gone)', async () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    await confirmFuse(scene);

    expect(calls).toHaveLength(1);
    expect(modalOpenOf(scene)).toBe(true);
    expect(ringStarCount(modalLayerOf(scene))).toBe(4);
  });
});

describe('CardScene fuse panel — prep: making the missing materials as an explicit sub-task', () => {
  /** Lv.2 lena missing `shortfall` of its 5 Lv.2 materials, with `lowN` Lv.1 anna cards to prep from. */
  function prepInv(shortfall: number, lowN: number): { target: CardInstance; cardInv: Record<string, CardInstance> } {
    const target = makeCard('target', 'lena', { level: 2 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT - shortfall; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 2 });
    for (let i = 0; i < lowN; i++) cardInv[`lo${i}`] = makeCard(`lo${i}`, 'max', { level: 1 });
    return { target, cardInv };
  }

  const startPrep = (scene: CardScene): void => {
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))!)!.fn();
  };

  it('offers prep, with its cost stated, when the cards one level down cover it', () => {
    // 3 short ⇒ 3 x (5 materials + 1 feeder) = 18 Lv.1 cards; the player has exactly that.
    const { target, cardInv } = prepInv(3, 18);
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseNeedMore', { n: 3, lv: 2 }))).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCost', { avail: 18, lv: 1, cost: 18 }))).not.toBeNull();
  });

  it('states the concrete gap instead of a dead end when prep is unaffordable', () => {
    const { target, cardInv } = prepInv(3, 5); // 5 owned vs 18 needed
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))).toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepShort', { cost: 18, lv: 1, avail: 5 }))).not.toBeNull();
  });

  it('starting prep pins the original goal to a breadcrumb and moves the ring to a feeder', () => {
    const { target, cardInv } = prepInv(1, 6);
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    startPrep(scene);

    expect(ringStarCount(modalLayerOf(scene)), 'ring moved to a Lv.1 feeder').toBe(1);
    expect(
      findLabelPos(modalLayerOf(scene), t('roster.fusePrepCrumb', { name: t('card.lena.name' as never), lv: 2, done: 0, need: 1 })),
      'the card the player actually wants must stay on screen',
    ).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))).not.toBeNull();
  });

  it('completing the run pops back to the original target with its ring full', async () => {
    const { target, cardInv } = prepInv(1, 6);
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    startPrep(scene);
    await confirmFuse(scene); // one feeder fuse produces the single missing Lv.2 material

    expect(calls).toHaveLength(1);
    expect(calls[0].targetId, 'the feeder was fused, not the goal').not.toBe('target');
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel')), 'crumb gone once the run completes').toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'back on the Lv.2 goal').toBe(2);
    expect(findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
  });

  it('Stop prep abandons the run and returns to the original target', () => {
    const { target, cardInv } = prepInv(1, 6);
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    startPrep(scene);
    expect(ringStarCount(modalLayerOf(scene))).toBe(1);

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))!)!.fn();
    expect(ringStarCount(modalLayerOf(scene))).toBe(2);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))).toBeNull();
  });

  it('batches the remaining rounds behind one authorized tap', async () => {
    // 2 short at Lv.3 ⇒ 2 rounds x 6 Lv.2 cards = 12.
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 3 });
    for (let i = 0; i < 12; i++) cardInv[`mid${i}`] = makeCard(`mid${i}`, 'max', { level: 2 });

    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: mutatingFuseCards(cardInv, calls),
      fuseCardsBatch: mutatingFuseBatch(cardInv, calls),
    }));
    openFuse(scene, target);
    startPrep(scene);

    const batchPos = findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 2 }));
    expect(batchPos, 'batch button must state how many rounds are left').not.toBeNull();
    hitUnder(modalHitsOf(scene), batchPos!)!.fn();
    await flushAsync();

    expect(calls, 'both rounds ran from the single tap').toHaveLength(2);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))).toBeNull();
    expect(ringStarCount(modalLayerOf(scene))).toBe(3);
    expect(findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)).not.toBeNull();
  });
});

describe('CardScene fuse panel — animation is not torn down by the busy re-render', () => {
  it('mid-fuse update() ticks do not rebuild the modal (which would destroy the live VFX)', async () => {
    const target = makeCard('target', 'lena', { level: 3 }); // level 3 ⇒ no auto-continue, closes on settle
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    const scene = buildScene(baseCb(cardInv));
    priv(scene).feed.openFuseSelect(target);
    priv(scene).core.detailId = target.id; // the fuse is always reached from the detail modal in production
    // Hold the animation open so the fuse stays in flight while we pump update().
    let releaseAnim: () => void = () => {};
    priv(scene).feed.playFusionAnim = () => new Promise<void>((r) => { releaseAnim = r; });

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    await flushAsync(); // doFuse → fuseCards resolves → parks on the awaited playFusionAnim

    expect(priv(scene).core.fuseInProgress).toBe(true);
    const openDetailSpy = vi.spyOn(priv(scene).detail, 'openDetail');

    // Cross the 1s loading threshold, then several dot cycles — the OLD bug rebuilt the modal here.
    priv(scene).update(1.2);
    for (let i = 0; i < 5; i++) priv(scene).update(0.45);

    expect(openDetailSpy).not.toHaveBeenCalled();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseTitle'))).not.toBeNull(); // fuse ring still standing

    releaseAnim();
    await flushAsync();
    expect(priv(scene).core.fuseInProgress).toBe(false); // flag released so the scene isn't stuck busy
    openDetailSpy.mockRestore();
  });

  // Regression: onSaveChanged (wired to SaveManager.subscribe, which "fires synchronously and with no
  // payload" — see SaveManager.ts) used to call this.render() unconditionally. fuseCards's real
  // implementation resolves via saveManager.adoptServer(save), which fires that listener SYNCHRONOUSLY,
  // before the awaited fuseCards() promise settles and therefore before playFusionAnim ever runs.
  // render() rebuilds the modal (detailId stays set through the whole fuse ⇒ openDetail() ⇒
  // tearDownChildren(modalLayer)), replacing the fuse ring with an ordinary card-detail panel — so by
  // the time playFusionAnim draws its animation onto modalLayer, the ring is gone and the fuse panel
  // reads as "closed" with the animation floating over whatever render() drew instead. Root-cause fix:
  // the onSaveChanged callback now respects fuseInProgress, same as the busy re-render in update().
  it('a save-changed listener firing synchronously mid-fuse (adoptServer\'s real behavior) does not tear down the ring', async () => {
    const target = makeCard('target', 'lena', { level: 3 }); // level 3 ⇒ no auto-continue, simpler to assert
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    let savedListener: (() => void) | null = null;
    const scene = buildScene(baseCb(cardInv, {
      onSaveChanged: (listener) => { savedListener = listener; return () => {}; },
      fuseCards: async () => {
        // Mirrors SaveManager.adoptServer: fires the save-changed listener synchronously, before this
        // promise resolves and before doFuse ever reaches playFusionAnim.
        savedListener?.();
        return { ok: true };
      },
    }));
    priv(scene).feed.openFuseSelect(target);
    priv(scene).core.detailId = target.id; // the fuse is always reached from the detail modal in production
    // Hold the animation open so we can inspect the modal right after fuseCards resolves.
    let releaseAnim: () => void = () => {};
    priv(scene).feed.playFusionAnim = () => new Promise<void>((r) => { releaseAnim = r; });

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    await flushAsync(); // doFuse → fuseCards fires the listener and resolves → parks on playFusionAnim

    // Still standing: the OLD bug replaced this with an ordinary detail panel (no fuseTitle) here.
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseTitle'))).not.toBeNull();
    expect(modalOpenOf(scene)).toBe(true);

    releaseAnim();
    await flushAsync();
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
      priv(scene).feed.openFuseSelect(target); // real playFusionAnim
      priv(scene).feed.fuseRingGeom = null; // skip the converge phase → straight to the burst phase

      const p = priv(scene).feed.playFusionAnim() as Promise<void>;
      expect(rafQueue.length).toBe(1); // burst phase registered its first frame synchronously

      // Destroy the burst/flash out from under the loop — exactly what the busy re-render used to do.
      tearDownChildren(priv(scene).core.modalLayer);
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
      priv(scene).feed.openFuseSelect(target); // REAL playFusionAnim, driven by the controllable rAF + clock
      priv(scene).core.detailId = target.id;

      hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
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
      expect(priv(scene).core.bt.busy).toBe(false);  // fuse settled — didn't hang on an unresolved promise
      expect(priv(scene).core.fuseInProgress).toBe(false);
      expect(modalOpenOf(scene)).toBe(true);    // 2026-08-18: settling never closes the panel any more
      expect(detailIdOf(scene)).toBe(target.id); // ...and the detail id it was opened from survives
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
    priv(scene).core.detailId = target.id;

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    await flushAsync();

    expect(priv(scene).core.fuseInProgress).toBe(false); // finally cleared it even though the fuse failed
    expect(priv(scene).core.bt.busy).toBe(false);
    // The busy re-render is no longer suppressed, and normal update() ticks still work.
    expect(() => priv(scene).update(0.1)).not.toThrow();
  });

  // These two guard the fuseInProgress check itself doesn't overreach: the whole point of wiring
  // onSaveChanged in the first place (pre-dating the fuse feature) is that ANY save mutation from
  // anywhere — not just fuseCards — refreshes the roster (e.g. coins spent/gained by another
  // concurrently-mounted scene, mirroring saveManagerAutoRerender.ui.ts's Gacha/BattlePass coverage
  // for the same SaveManager.subscribe wiring). A too-broad guard (e.g. one that never re-enables)
  // would silently break that outside of fuse.
  it('onSaveChanged still triggers a normal re-render when nothing is mid-fuse', () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(freshStorage()) });
    mgr.update((s) => { s.wallet.coins = 100; });

    const scene = buildScene({
      onBack() {},
      getSave: () => mgr.get(),
      onSaveChanged: (fn) => mgr.subscribe(fn),
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [],
      getEquippedSkin: () => null,
      equipSkin() {},
    });

    expect(findLabelPos(headerOverlayLayerOf(scene), (100).toLocaleString())).not.toBeNull();
    expect(priv(scene).core.fuseInProgress).toBe(false);

    // Nobody calls scene.render() themselves — this must be the onSaveChanged listener alone.
    mgr.update((s) => { s.wallet.coins = 250; });
    expect(findLabelPos(headerOverlayLayerOf(scene), (250).toLocaleString())).not.toBeNull();

    scene.destroy();
  });

  it('after a fuse settles, a later onSaveChanged fire renders again — the guard is not permanently stuck', async () => {
    const mgr = new SaveManager({ store: new LocalSaveStore(freshStorage()) });
    mgr.update((s) => {
      s.wallet.coins = 100;
      const target = makeCard('target', 'lena', { level: 3 }); // level 3 ⇒ closes on settle, no auto-continue
      s.cardInv[target.id] = target;
      for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) {
        s.cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });
      }
    });
    const target = mgr.get().cardInv.target;

    const scene = buildScene({
      onBack() {},
      getSave: () => mgr.get(),
      onSaveChanged: (fn) => mgr.subscribe(fn),
      // Mirrors the real production shape (app/nav/game.ts): fuseCards resolves by mutating the save
      // and letting adoptServer/mgr.update fire onSaveChanged SYNCHRONOUSLY, mid-doFuse.
      fuseCards: async (targetId, ids) => {
        mgr.update((s) => {
          for (const id of ids) delete s.cardInv[id];
          s.cardInv[targetId].level += 1;
          s.wallet.coins = 500; // also changes on a real fuse (server deducts/awards) — arbitrary here
        });
        return { ok: true };
      },
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [],
      getEquippedSkin: () => null,
      equipSkin() {},
    });
    priv(scene).feed.openFuseSelect(target);
    priv(scene).core.detailId = target.id;
    priv(scene).feed.playFusionAnim = async () => {}; // no rAF driving in this test

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    await flushAsync();

    expect(priv(scene).core.fuseInProgress).toBe(false); // fuse settled, guard released
    expect(modalOpenOf(scene)).toBe(true);           // 2026-08-18: settling leaves the panel open
    expect(findLabelPos(headerOverlayLayerOf(scene), (500).toLocaleString())).not.toBeNull(); // picked up the fuse's own coin change on settle

    // A later, unrelated save mutation (nobody calls render() manually) must still refresh the header —
    // the guard released after the fuse, it didn't get stuck suppressing forever.
    mgr.update((s) => { s.wallet.coins = 999; });
    expect(findLabelPos(headerOverlayLayerOf(scene), (999).toLocaleString())).not.toBeNull();

    scene.destroy();
  });
});

// Regression coverage for the 2026-08-02 "strengthened ending" (see feed.ts playFusionAnim phase 2):
// the shockwave (flash/burst ring/spokes) is a symmetric sin pulse that hits 0 alpha, by design, on
// its own last frame — great mid-animation, but it used to leave the payoff cutting straight to
// nothing. A gold "seal" halo (fixed geometry, alpha-only per frame — no clear+redraw, since its
// radius never changes) now blooms in alongside the shockwave and holds/fades for a beat after it,
// so there's a frame players actually land on. Both tests drive the REAL playFusionAnim via a
// controllable rAF queue + mocked performance.now() (same technique as the "end-to-end" describe
// above), skipping the converge phase (fuseRingGeom = null) to isolate phase 2.
describe('CardScene fuse panel — post-burst halo (2026-08-02 strengthened ending)', () => {
  /** Drives `n` animation frames, each 60ms of mocked clock apart (mirrors the "end-to-end" test's
   * cadence) — enough granularity to land cleanly on either side of the 700ms burst boundary. */
  function driveFrames(rafQueue: FrameRequestCallback[], clock: { v: number }, n: number): void {
    for (let i = 0; i < n && rafQueue.length > 0; i++) {
      const cb = rafQueue.shift()!;
      clock.v += 60;
      cb(clock.v);
    }
  }

  function setup(): { scene: CardScene; rafQueue: FrameRequestCallback[]; clock: { v: number }; restore: () => void } {
    const rafQueue: FrameRequestCallback[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const origRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = (cb: FrameRequestCallback): number => { rafQueue.push(cb); return rafQueue.length; };
    const clock = { v: 1000 };
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock.v);

    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });
    const scene = buildScene(baseCb(cardInv));
    priv(scene).feed.openFuseSelect(target);
    priv(scene).feed.fuseRingGeom = null; // skip the converge phase → straight to the burst/halo phase

    return {
      scene, rafQueue, clock,
      restore: () => { g.requestAnimationFrame = origRaf; nowSpy.mockRestore(); },
    };
  }

  it('keeps something on screen after the burst\'s own ~700ms is over, then fully cleans up', async () => {
    const { scene, rafQueue, clock, restore } = setup();
    try {
      const staticChildCount = priv(scene).core.modalLayer.children.length;
      const p = priv(scene).feed.playFusionAnim() as Promise<void>;
      expect(rafQueue.length).toBe(1); // first frame registered synchronously

      driveFrames(rafQueue, clock, 13); // 13 * 60ms = 780ms elapsed — past the 700ms burst, well before the ~1180ms total
      // The shockwave (flash + burst ring/spokes) has torn itself down by now, but the halo is still
      // standing: one extra transient child beyond whatever the static ring/list panel already had.
      expect(priv(scene).core.modalLayer.children.length).toBeGreaterThan(staticChildCount);
      let resolved = false;
      p.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false); // the hold/fade beat isn't done yet

      driveFrames(rafQueue, clock, 20); // drain the remaining hold + fade-out
      expect(rafQueue.length).toBe(0);
      await p;

      expect(priv(scene).core.modalLayer.children.length).toBe(staticChildCount); // no leaked graphics
    } finally {
      restore();
    }
  });

  it('perf: the halo is drawn once and only its alpha changes — no per-frame clear+redraw during the hold/fade beat', async () => {
    const { scene, rafQueue, clock, restore } = setup();
    const clearSpy = vi.spyOn(PIXI.Graphics.prototype, 'clear');
    try {
      const p = priv(scene).feed.playFusionAnim() as Promise<void>;

      driveFrames(rafQueue, clock, 13); // past the 700ms burst
      const clearCallsAtBurstEnd = clearSpy.mock.calls.length;
      expect(clearCallsAtBurstEnd).toBeGreaterThan(0); // the burst ring/spokes genuinely redrew every frame

      driveFrames(rafQueue, clock, 20); // the halo-only hold + fade-out beat
      await p;

      // No additional Graphics#clear calls once the burst is gone — the extra ~480ms of hold/fade is
      // a single alpha write per frame, not a geometry rebuild.
      expect(clearSpy.mock.calls.length).toBe(clearCallsAtBurstEnd);
    } finally {
      clearSpy.mockRestore();
      restore();
    }
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

    const availH = (1080 - 8) - ((priv(scene).core.headerH as number) + 4);
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

// Regression coverage for the 2026-08-01 scoping decision (UI_DESIGN.md §27 addendum): both the
// ring's target portrait and each candidate-list row's thumbnail must always show the base
// portrait, never whichever skin the account has equipped for that unit type — this panel answers
// "which of my cards can fuse," not "what does my army look like." Asserted on call arguments (not
// the rendered texture — headless PIXI stubs every binary asset to the same 1×1 PNG data URI).
// Regression coverage (2026-08-03 fix): Cancel and the full-screen backdrop-dismiss must not abort
// an in-flight fuse request. Neither is cancellable server-side, so letting the player close the
// panel while a fuse is pending left onFuseSettled's stale closure (currentTarget/slotIds/
// autoContinue) free to fire later and silently clobber whatever the player had since navigated to.
// Both hits are now gated on `!this.bt.busy`, mirroring Confirm's own existing gate.
describe('CardScene fuse panel — Cancel/backdrop do not abort an in-flight fuse (2026-08-03 fix)', () => {
  function fillRing(scene: CardScene, rowLabel: string): void {
  }

  it('Cancel cannot close the panel while a fuse is in flight, but settling still resolves normally', async () => {
    const target = makeCard('target', 'lena', { level: 3 }); // no auto-continue, simplest settle path
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    let releaseFuse: (v: { ok: true }) => void = () => {};
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: () => new Promise((r) => { releaseFuse = r; }),
    }));
    openFuse(scene, target);

    const cancelPos = findLabelPos(modalLayerOf(scene), t('equip.cancel'));
    expect(cancelPos, 'Cancel label must still render (just not be tappable) while busy').not.toBeNull();
    expect(hitUnder(modalHitsOf(scene), cancelPos!)).toBeDefined(); // tappable before Confirm is pressed

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    // doFuse's synchronous prelude (bt.start() + feedRedraw()) has already run by the time .fn()
    // returns — fuseCards itself is still pending (we control its resolution above).
    expect(priv(scene).core.bt.busy).toBe(true);
    const cancelPosBusy = findLabelPos(modalLayerOf(scene), t('equip.cancel'));
    expect(cancelPosBusy, 'Cancel label still present, dimmed').not.toBeNull();
    // Whatever hit (if any) now covers that pixel — the panel's own inert backdrop no-op legitimately
    // sits there too — tapping it must NOT close the panel while busy (the real regression: it used
    // to be Cancel's own live hit, closing the modal and abandoning the in-flight request).
    hitUnder(modalHitsOf(scene), cancelPosBusy!)?.fn();
    expect(modalOpenOf(scene)).toBe(true);

    releaseFuse({ ok: true });
    priv(scene).feed.playFusionAnim = async () => {};
    await flushAsync();
    expect(priv(scene).core.bt.busy).toBe(false);
  });

  it('tapping the backdrop corner while busy does not close the panel (no stale onFuseSettled clobber later)', async () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    let releaseFuse: (v: { ok: true }) => void = () => {};
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: () => new Promise((r) => { releaseFuse = r; }),
    }));
    openFuse(scene, target);
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();

    expect(priv(scene).core.bt.busy).toBe(true);
    // Simulate the player tapping a screen corner (would hit the full-backdrop dismiss if it were
    // still registered) — must be a no-op: the ring stays open, nothing closes.
    const cornerHit = hitUnder(modalHitsOf(scene), { x: 1, y: 1 });
    cornerHit?.fn();
    expect(modalOpenOf(scene)).toBe(true); // still open — the request is still in flight

    releaseFuse({ ok: true });
    priv(scene).feed.playFusionAnim = async () => {};
    await flushAsync();
  });
});

// Regression coverage (2026-08-03 fix): onFuseSettled used to touch modalLayer/detailId/render()
// unconditionally, even after the scene itself was destroyed (player backed out of the roster while
// a fuse was still in flight) — an async completion racing a destroyed scene.
describe('CardScene fuse panel — onFuseSettled destroyed-guard (2026-08-03 fix)', () => {
  it('a fuse that resolves after scene.destroy() does not throw or touch the torn-down modal', async () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    let releaseFuse: (v: { ok: true }) => void = () => {};
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: () => new Promise((r) => { releaseFuse = r; }),
    }));
    openFuse(scene, target);
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`)!)!.fn();
    expect(priv(scene).core.bt.busy).toBe(true);

    // Player backs out of the roster while the request is still in flight.
    scene.destroy();
    expect(priv(scene).core.destroyed).toBe(true);

    // The (now-stale) request finally resolves — must not throw.
    expect(() => releaseFuse({ ok: true })).not.toThrow();
    await expect(flushAsync()).resolves.toBeUndefined();
  });
});

// Regression coverage (2026-08-03 fix, fuseRingOpen): openFuseSelect never clears `detailId`, so
// before this fix, ANY external render() trigger while the ring is open — even before Confirm is
// ever tapped (fuseInProgress was false the whole pre-confirm window) — silently reopened the plain
// detail popup over the still-open ring via render()'s `if (tab==='list' && detailId) openDetail(...)`
// dispatch. `fuseRingOpen` is a strict superset of `fuseInProgress` covering that pre-confirm gap too.
describe('CardScene fuse panel — fuseRingOpen blocks external re-render from swapping out the ring (2026-08-03 fix)', () => {
  it('an onSaveChanged fire while the ring is still open PRE-CONFIRM does not reopen the plain detail popup', () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    let savedListener: (() => void) | null = null;
    const scene = buildScene(baseCb(cardInv, {
      onSaveChanged: (listener) => { savedListener = listener; return () => {}; },
    }));
    priv(scene).feed.openFuseSelect(target);
    priv(scene).core.detailId = target.id; // the fuse is always reached from an already-open detail modal

    expect(priv(scene).core.fuseInProgress).toBe(false); // pre-confirm: no network call in flight yet
    expect(priv(scene).core.fuseRingOpen).toBe(true);     // but the ring itself is still up

    const openDetailSpy = vi.spyOn(priv(scene).detail, 'openDetail');
    // An unrelated save mutation elsewhere (e.g. an overlay scene) fires the listener — this must NOT
    // reopen the plain detail popup over the still-in-progress ring.
    // (Indirected through a closure: reading `savedListener` in the same scope as its `let` declaration
    // makes TS's control-flow analysis miss the reassignment — it happens inside the onSaveChanged
    // callback above — and narrow the read back to the initializer's `null`, i.e. `never` when called.)
    const fireSavedListener = (): void => savedListener?.();
    fireSavedListener();

    expect(openDetailSpy).not.toHaveBeenCalled();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseTitle'))).not.toBeNull(); // ring still standing
    openDetailSpy.mockRestore();
  });

  it('fuseRingOpen is cleared once the ring actually closes (Cancel), so a later onSaveChanged behaves normally again', () => {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'max', { level: 3 });

    const scene = buildScene(baseCb(cardInv));
    priv(scene).feed.openFuseSelect(target);
    expect(priv(scene).core.fuseRingOpen).toBe(true);

    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('equip.cancel')) ?? { x: -1, y: -1 })?.fn();
    // (Cancel's label key in CardScene reuses 'equip.cancel', same shared string as EquipmentScene.)
    expect(priv(scene).core.fuseRingOpen).toBe(false);
    expect(modalOpenOf(scene)).toBe(false);
  });
});

describe('CardScene fuse panel — target + candidate pictures always use the base portrait', () => {
  it('passes only the card/defId, never getSave().equipped, even when the account has a skin equipped', () => {
    const target = makeCard('target', 'lichuang');
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < 3; i++) cardInv[`mat${i}`] = makeCard(`mat${i}`, 'chenshou');
    const cb = baseCb(cardInv, {
      getSave: () => ({
        cardInv,
        equipmentInv: {},
        wallet: { coins: 0 },
        equipped: { [skinEquipKey(UnitType.Infantry)]: 'skin_shop_c1', [skinEquipKey(UnitType.ShieldBearer)]: 'skin_shop_e1' },
      } as unknown as ReturnType<CardCallbacks['getSave']>),
    });
    const spy = cardInstanceArtUrl as unknown as { mock: { calls: unknown[][] } };
    spy.mock.calls.length = 0;
    const scene = buildScene(cb);
    openFuse(scene, target);

    const relevantCalls = spy.mock.calls.filter((call) => {
      const arg = call[0] as { defId?: string } | undefined;
      return arg?.defId === 'lichuang' || arg?.defId === 'chenshou';
    });
    expect(relevantCalls.length).toBeGreaterThan(0);
    for (const call of relevantCalls) expect(call.length === 1 || call[1] === undefined).toBe(true);
  });
});
