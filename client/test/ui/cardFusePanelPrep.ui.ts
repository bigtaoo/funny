// Regression coverage for the fuse panel's prep sub-task and its batch action (2026-08-18,
// CHARACTER_CARDS_DESIGN §3.2 / ADR-068). Split out of cardFusePanel.ui.ts, which already carries
// the ring/candidate/target-intent suites and is long enough.
//
// What this file exists to pin down — every case here is a branch the happy-path suite never
// reaches, and each one can spend real cards if it goes wrong:
//  1. A prep run's progress is credited ONLY by fuses that actually landed.
//  2. A run that is not finished parks on the next feeder, and one that IS finished pops back to
//     the goal — the player must never be left staring at a card that only exists to be consumed.
//  3. doPrepBatch stops at the first failed round and reports what landed, rather than pushing on
//     against a state the client can no longer trust.
//  4. The usual busy/destroyed guards every network action in this codebase carries.
//  5. Prep is not offered when there is no card that could serve as the feeder.
//  6. The chain-funded two-level run end to end, plus the depth bound that stops a third.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import type { CardInstance } from '../../src/game/meta/SaveData';
import { FUSION_MATERIAL_COUNT } from '../../src/game/meta/cardDefs';
import { PREP_COST_PER_CARD } from '../../src/scenes/CardScene/feedPlan';

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

/** Star count under the ring's center portrait = the centered card's level (see feedRing.ts). */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(scene: CardScene): any {
  return scene as unknown as Record<string, unknown>;
}
function modalLayerOf(scene: CardScene): PIXI.Container {
  return priv(scene).core.modalLayer as PIXI.Container;
}
function modalHitsOf(scene: CardScene): Hit[] {
  return priv(scene).core.modalHits as Hit[];
}

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function makeCard(id: string, defId: string, overrides: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level: 1, gear: {}, locked: false, ...overrides };
}

function baseCb(cardInv: Record<string, CardInstance>, overrides: Partial<CardCallbacks> = {}): CardCallbacks {
  return {
    onBack() {},
    getSave: () => ({ cardInv, equipmentInv: {}, wallet: { coins: 0 } } as unknown as ReturnType<CardCallbacks['getSave']>),
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin() {},
    ...overrides,
  };
}

function buildScene(cb: CardCallbacks): CardScene {
  return new CardScene(createLayout(W, H), new InputManager(), cb);
}

function openFuse(scene: CardScene, target: CardInstance): void {
  priv(scene).feed.openFuseSelect(target);
  // The placeholder fusion animation drives itself off requestAnimationFrame, which the headless
  // harness stubs to a no-op that never re-invokes its callback — any test that taps Confirm on a
  // full ring must stub it, or the awaited doFuse()/playFusionAnim() chain hangs forever.
  priv(scene).feed.playFusionAnim = async () => {};
}

/** Server-shaped fuse stub: consumes the materials, levels the target up, records the call. */
function mutatingFuseCards(
  cardInv: Record<string, CardInstance>,
  calls: { targetId: string; ids: string[] }[],
  failOnCall?: number,
): CardCallbacks['fuseCards'] {
  return async (targetId: string, ids: string[]) => {
    if (failOnCall !== undefined && calls.length === failOnCall) {
      return { ok: false as const, key: 'roster.err.generic' as never };
    }
    calls.push({ targetId, ids });
    for (const id of ids) delete cardInv[id];
    cardInv[targetId].level += 1;
    return { ok: true as const };
  };
}

/**
 * A Lv.2 lena short `shortfall` of its five Lv.2 materials, with `lowN` Lv.1 same-faction cards to
 * prep from. `gearedLow` marks every Lv.1 card as carrying gear, which keeps them usable as
 * materials but disqualifies all of them from being the feeder.
 */
function prepInv(shortfall: number, lowN: number, gearedLow = false): { target: CardInstance; cardInv: Record<string, CardInstance> } {
  const target = makeCard('target', 'lena', { level: 2 });
  const cardInv: Record<string, CardInstance> = { target };
  for (let i = 0; i < FUSION_MATERIAL_COUNT - shortfall; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 2 });
  for (let i = 0; i < lowN; i++) {
    cardInv[`lo${i}`] = makeCard(`lo${i}`, 'max', { level: 1, gear: gearedLow ? { weapon: 'eq1' } : {} });
  }
  return { target, cardInv };
}

const startPrep = (scene: CardScene): void => {
  hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))!)!.action();
};
const confirmPos = (scene: CardScene): { x: number; y: number } | null =>
  findLabelPos(modalLayerOf(scene), `${t('roster.fuseBtn')} (${FUSION_MATERIAL_COUNT}/${FUSION_MATERIAL_COUNT})`);
const crumb = (scene: CardScene, done: number, need: number): { x: number; y: number } | null =>
  findLabelPos(modalLayerOf(scene), t('roster.fusePrepCrumb', {
    name: t('card.lena.name' as never), lv: 2, done, need,
  }));

describe('CardScene fuse panel — prep is only offered when it can actually run', () => {
  it('withholds the button when every card one level down is geared, instead of showing a dead one', () => {
    // Enough raw material (6 covers one round) but all of it geared: gear disqualifies a card from
    // being the FEEDER (pickFeeder would silently dismantle its loadout) while leaving it a fine
    // MATERIAL — so `affordable` alone used to light a button that did nothing when tapped.
    const { target, cardInv } = prepInv(1, PREP_COST_PER_CARD, true);
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseNeedMore', { n: 1, lv: 2 }))).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn')), 'no runnable prep ⇒ no button').toBeNull();
    // ...and not the "you need N, you have M" line either: here N and M are both 6, which would
    // read as a contradiction. Point at the acquisition channels instead.
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseNoSource'))).not.toBeNull();
  });

  it('offers it as soon as one ungeared copy exists at that level', () => {
    const { target, cardInv } = prepInv(1, PREP_COST_PER_CARD, true);
    cardInv.free0 = makeCard('free0', 'mara', { level: 1 }); // same faction, no gear
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn'))).not.toBeNull();
  });
});

describe('CardScene fuse panel — prep progress tracks what actually landed', () => {
  it('a failed fuse does not advance the run', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => ({ ok: false, key: 'roster.err.generic' as never }) }));
    openFuse(scene, target);
    startPrep(scene);
    expect(crumb(scene, 0, 2), 'run starts at 0/2').not.toBeNull();

    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();
    await flushAsync();

    expect(crumb(scene, 0, 2), 'a rejected fuse must not be credited').not.toBeNull();
    expect(crumb(scene, 1, 2)).toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'still on the same Lv.1 feeder').toBe(1);
  });

  it('an unfinished run moves to the NEXT feeder, not back to the goal', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    startPrep(scene);

    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(crumb(scene, 1, 2), 'one of two produced').not.toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'parked on another Lv.1 feeder, not the Lv.2 goal').toBe(1);
    expect(confirmPos(scene), 'the new feeder comes with its own five materials').not.toBeNull();
  });

  it('Stop prep is inert while a fuse is still in flight', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    let release: (v: { ok: true }) => void = () => {};
    const scene = buildScene(baseCb(cardInv, { fuseCards: () => new Promise((r) => { release = r; }) }));
    openFuse(scene, target);
    startPrep(scene);
    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();

    expect(priv(scene).core.bt.busy).toBe(true);
    const stopPos = findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'));
    expect(stopPos, 'the label stays drawn, just not tappable').not.toBeNull();
    // The crumb registers no hit of its own while busy, so the only thing under that point is the
    // panel's whole-area swallow rect — tapping it must leave the run exactly where it was.
    hitUnder(modalHitsOf(scene), stopPos!)?.action();
    expect(crumb(scene, 0, 2), 'run untouched').not.toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'still on the feeder, not popped back to the goal').toBe(1);

    release({ ok: true });
    await flushAsync();
    expect(priv(scene).core.bt.busy).toBe(false);
  });
});

describe('CardScene fuse panel — batch prep', () => {
  it('stops at the first failed round and credits only the rounds that landed', async () => {
    // 3 short at Lv.2 ⇒ 3 rounds x 6 Lv.1 cards = 18. The stub rejects the second call.
    const { target, cardInv } = prepInv(3, 3 * PREP_COST_PER_CARD);
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls, 1) }));
    openFuse(scene, target);
    startPrep(scene);

    const batchPos = findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 3 }));
    expect(batchPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), batchPos!)!.action();
    await flushAsync();

    expect(calls, 'the run halted rather than spending cards against untrusted state').toHaveLength(1);
    expect(crumb(scene, 1, 3), 'crumb reports the one round that actually landed').not.toBeNull();
    expect(priv(scene).core.bt.busy).toBe(false);
    expect(priv(scene).core.fuseInProgress).toBe(false);
  });

  it('a rejected FIRST round leaves the run untouched and the panel usable', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls, 0) }));
    openFuse(scene, target);
    startPrep(scene);
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 2 }))!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(0);
    expect(crumb(scene, 0, 2)).not.toBeNull();
    expect(priv(scene).core.bt.busy).toBe(false);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel')), 'run still open, still abandonable').not.toBeNull();
  });

  it('is busy-locked: a second tap while a batch is running is a no-op', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const calls: { targetId: string; ids: string[] }[] = [];
    let release: (v: { ok: true }) => void = () => {};
    const gate = new Promise<{ ok: true }>((r) => { release = r; });
    const scene = buildScene(baseCb(cardInv, {
      fuseCards: async (targetId: string, ids: string[]) => {
        await gate;
        return mutatingFuseCards(cardInv, calls)(targetId, ids);
      },
    }));
    openFuse(scene, target);
    startPrep(scene);

    let firstRounds = 1;
    void priv(scene).core.doPrepBatch(
      () => (firstRounds-- > 0 ? { targetId: 'lo0', materialIds: ['lo1', 'lo2', 'lo3', 'lo4', 'lo5'] } : null),
      () => {},
    );
    await flushAsync();
    expect(priv(scene).core.bt.busy).toBe(true);

    let secondRan = false;
    await priv(scene).core.doPrepBatch(() => { secondRan = true; return null; }, () => {});
    expect(secondRan, 'the second batch must not even ask for a round').toBe(false);

    release({ ok: true });
    await flushAsync();
  });

  it('clears bt.busy / fuseInProgress when a round throws (no permanent render lock)', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const scene = buildScene(baseCb(cardInv, { fuseCards: async () => { throw new Error('boom'); } }));
    openFuse(scene, target);
    startPrep(scene);
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 2 }))!)!.action();
    await flushAsync();

    expect(priv(scene).core.bt.busy).toBe(false);
    expect(priv(scene).core.fuseInProgress).toBe(false);
  });

  it('does not touch the panel when the scene was destroyed mid-run', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    let release: (v: { ok: true }) => void = () => {};
    const scene = buildScene(baseCb(cardInv, { fuseCards: () => new Promise((r) => { release = r; }) }));
    openFuse(scene, target);
    startPrep(scene);

    let settled = false;
    let issued = 0;
    void priv(scene).core.doPrepBatch(
      () => { issued++; return { targetId: 'lo0', materialIds: ['lo1', 'lo2', 'lo3', 'lo4', 'lo5'] }; },
      () => { settled = true; },
    );
    await flushAsync();
    expect(issued).toBe(1);

    scene.destroy();
    expect(priv(scene).core.destroyed).toBe(true);
    expect(() => release({ ok: true })).not.toThrow();
    await expect(flushAsync()).resolves.toBeUndefined();

    expect(settled, 'onSettled must not run against a torn-down scene').toBe(false);
    expect(issued, 'and no further round is issued once the player has left').toBe(1);
    expect(priv(scene).core.bt.busy).toBe(false);
  });
});

describe('CardScene fuse panel — a completed prep hands the goal back ready to fuse', () => {
  it('pops the crumb and returns to the goal with all five slots filled', async () => {
    const { target, cardInv } = prepInv(2, 2 * PREP_COST_PER_CARD);
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    startPrep(scene);
    hitUnder(modalHitsOf(scene), findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 2 }))!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(2);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel'))).toBeNull();
    expect(ringStarCount(modalLayerOf(scene))).toBe(2);
    expect(confirmPos(scene), 'the goal is now fusable in one more tap').not.toBeNull();

    // ...and that tap fuses the GOAL, not a feeder.
    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();
    await flushAsync();
    expect(calls).toHaveLength(3);
    expect(calls[2].targetId).toBe('target');
    expect(ringStarCount(modalLayerOf(scene))).toBe(3);
  });
});

describe('CardScene fuse panel — two-level prep (chain-funded)', () => {
  /**
   * The ordinary mid-game shape, and the one that used to dead-end: a Lv.3 goal one Lv.3 material
   * short, only 4 Lv.2 on the bench (a round needs 6), but a pile of Lv.1 behind them. planPrep
   * prices the chain, so prep is offered; the first frame then centres on a Lv.2 that is itself not
   * fusable, whose own gap state opens the second frame.
   */
  function chainInv(): { target: CardInstance; cardInv: Record<string, CardInstance> } {
    const target = makeCard('target', 'lena', { level: 3 });
    const cardInv: Record<string, CardInstance> = { target };
    for (let i = 0; i < FUSION_MATERIAL_COUNT - 1; i++) cardInv[`hi${i}`] = makeCard(`hi${i}`, 'max', { level: 3 });
    for (let i = 0; i < 4; i++) cardInv[`mid${i}`] = makeCard(`mid${i}`, 'max', { level: 2 });
    for (let i = 0; i < 2 * PREP_COST_PER_CARD; i++) cardInv[`lo${i}`] = makeCard(`lo${i}`, 'max', { level: 1 });
    return { target, cardInv };
  }

  const goalCrumb = (scene: CardScene, done: number, need: number): { x: number; y: number } | null =>
    findLabelPos(modalLayerOf(scene), t('roster.fusePrepCrumb', {
      name: t('card.lena.name' as never), lv: 3, done, need,
    }));

  it('offers prep on the chain and states where the shortfall gets covered from', () => {
    const { target, cardInv } = chainInv();
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);

    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn')), 'chain-funded runs are offered').not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepChain', {
      lv: 2, avail: 4, cost: PREP_COST_PER_CARD, chainHave: 2 * PREP_COST_PER_CARD, chainLv: 1,
    })), 'the cost line names the level the rest comes from').not.toBeNull();
    // The single-level wording must NOT be used here — it would claim Lv.2 covers it on its own.
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCost', {
      avail: 4, lv: 2, cost: PREP_COST_PER_CARD,
    }))).toBeNull();
  });

  it('the first frame centres on a Lv.2 that is not yet fusable, and offers the level below', () => {
    const { target, cardInv } = chainInv();
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    startPrep(scene);

    expect(goalCrumb(scene, 0, 1), 'the goal is pinned to the crumb').not.toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'working card is a Lv.2').toBe(2);
    expect(confirmPos(scene), 'it cannot be fused yet — that is the whole point').toBeNull();
    // 3 other Lv.2 on hand ⇒ 2 short ⇒ 12 Lv.1, which the player has exactly.
    expect(findLabelPos(modalLayerOf(scene), t('roster.fuseNeedMore', { n: 2, lv: 2 }))).not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn')), 'second level offered').not.toBeNull();
  });

  it('bottoms out at Lv.1 rather than offering a level that cannot exist', () => {
    // Two bounds meet here and neither may produce a live-but-inert button: planPrep prices exactly
    // ONE level below the feeder, so a run can open at most two frames (MAX_PREP_DEPTH states that
    // same bound, and drawGapNotice is gated on it), and the second frame's working card is at Lv.1,
    // below which planPrep returns null outright. Whichever bound bites first, the notice must fall
    // through to the acquisition channels.
    const { target, cardInv } = chainInv();
    const scene = buildScene(baseCb(cardInv));
    openFuse(scene, target);
    startPrep(scene); // frame 1 — working card at Lv.2
    startPrep(scene); // frame 2 — working card at Lv.1, the floor

    expect(ringStarCount(modalLayerOf(scene))).toBe(1);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel')), 'still inside a run').not.toBeNull();
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepBtn')), 'no third level on offer').toBeNull();
  });

  it('runs the whole chain through and hands the goal back ready to fuse', async () => {
    const { target, cardInv } = chainInv();
    const calls: { targetId: string; ids: string[] }[] = [];
    const scene = buildScene(baseCb(cardInv, { fuseCards: mutatingFuseCards(cardInv, calls) }));
    openFuse(scene, target);
    startPrep(scene); // frame 1: produce 1 Lv.3 for the goal, centred on a Lv.2
    startPrep(scene); // frame 2: produce 2 Lv.2 for that card, centred on a Lv.1

    expect(ringStarCount(modalLayerOf(scene))).toBe(1);
    // 12 Lv.1 ⇒ exactly 2 rounds, which is what frame 2 owes.
    const batchPos = findLabelPos(modalLayerOf(scene), t('roster.fusePrepAll', { n: 2 }));
    expect(batchPos).not.toBeNull();
    hitUnder(modalHitsOf(scene), batchPos!)!.action();
    await flushAsync();

    // Frame 2 done ⇒ popped back to the Lv.2 working card, now with its five Lv.2 materials.
    expect(calls).toHaveLength(2);
    expect(ringStarCount(modalLayerOf(scene))).toBe(2);
    expect(goalCrumb(scene, 0, 1), 'frame 1 still open, goal still pinned').not.toBeNull();
    expect(confirmPos(scene), 'the Lv.2 is fusable now').not.toBeNull();

    // Fusing it produces the Lv.3 frame 1 owed ⇒ frame 1 completes ⇒ back on the goal, 5/5.
    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();
    await flushAsync();

    expect(calls).toHaveLength(3);
    expect(findLabelPos(modalLayerOf(scene), t('roster.fusePrepCancel')), 'no run left open').toBeNull();
    expect(ringStarCount(modalLayerOf(scene)), 'back on the Lv.3 goal').toBe(3);
    expect(confirmPos(scene)).not.toBeNull();

    hitUnder(modalHitsOf(scene), confirmPos(scene)!)!.action();
    await flushAsync();
    expect(calls[3].targetId, 'and that last fuse is the goal itself').toBe('target');
    expect(ringStarCount(modalLayerOf(scene))).toBe(4);
  });
});
