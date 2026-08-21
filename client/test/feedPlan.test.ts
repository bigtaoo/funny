// CardScene/feedPlan.ts — direct unit coverage of the fuse panel's planning/ranking, all pure
// functions with no PIXI/CardScene wiring (the panel flow itself is test/ui/cardFusePanel.ui.ts).
// Supersedes the former feedAutoTarget.test.ts: findAutoTarget's ranking is unchanged, but it now
// orders the recommendation strip (listFusableTargets) instead of silently deciding the panel's
// target — see CHARACTER_CARDS_DESIGN §3.2 (2026-08-18).
//
// Ranking (2026-08-10 order), most-significant first:
//   (1) currently deployed to an SLG team (via `candidateOf`, inverted — see below)
//   (2) same defId as `preferDefId`
//   (3) same faction as `preferDefId`'s card
//   (4) highest level
// Eligibility: unlocked, below MAX_CARD_LEVEL, known defId, >= FUSION_MATERIAL_COUNT same-faction
// same-level unlocked materials on hand (materials must satisfy `candidateOf`, the target itself
// need not — a deployed card can still be the fusion *target*, only never a *material*).
import { describe, it, expect } from 'vitest';
import {
  PREP_COST_PER_CARD, autoFillMaterials, countPrepRounds, listFusableTargets, pickFeeder, planPrep, planPrepRounds,
} from '../src/scenes/CardScene/feedPlan';
import { FUSION_MATERIAL_COUNT, MAX_CARD_LEVEL } from '../src/game/meta/cardDefs';
import type { CardInstance } from '../src/game/meta/SaveData';

function card(id: string, defId: string, level: number, locked = false): CardInstance {
  return { id, defId, level, gear: {}, locked };
}

/** `count` distinct-id filler cards of `defId`/`level`, satisfying fusionMaterialCandidates'
 *  "same faction, same level, unlocked" test for a target of that faction+level. */
function fillers(prefix: string, defId: string, level: number, count = FUSION_MATERIAL_COUNT): CardInstance[] {
  return Array.from({ length: count }, (_, i) => card(`${prefix}${i}`, defId, level));
}

function invOf(...groups: CardInstance[][]): Record<string, CardInstance> {
  const inv: Record<string, CardInstance> = {};
  for (const c of groups.flat()) inv[c.id] = c;
  return inv;
}

/** All cards are material-eligible (not deployed) unless explicitly listed as deployed. */
function candidateOf(deployed: Set<string>): (id: string) => boolean {
  return (id) => !deployed.has(id);
}

const free = candidateOf(new Set<string>());

describe('listFusableTargets — ranking', () => {
  it('returns nothing when no card has enough materials', () => {
    const inv = invOf([card('t1', 'lichuang', 3)], fillers('m', 'lichuang', 3, FUSION_MATERIAL_COUNT - 1));
    expect(listFusableTargets(inv, free)).toEqual([]);
  });

  it('dimension 4 (level): among otherwise-tied cards, the highest level leads', () => {
    const inv = invOf(
      [card('low', 'lichuang', 3)], fillers('lowm', 'lichuang', 3),
      [card('high', 'lichuang', 5)], fillers('highm', 'lichuang', 5),
    );
    expect(listFusableTargets(inv, free)[0].id).toBe('high');
  });

  it('dimension 1 (deployed) beats level: a deployed low-level target outranks a bench high-level one', () => {
    const inv = invOf(
      [card('deployedLow', 'lichuang', 1)], fillers('dm', 'lichuang', 1),
      [card('benchHigh', 'lichuang', 8)], fillers('bm', 'lichuang', 8),
    );
    const deployed = new Set(['deployedLow']); // deployed cards fail candidateOf, so rank higher on dim 1
    expect(listFusableTargets(inv, candidateOf(deployed))[0].id).toBe('deployedLow');
  });

  it('a deployed target is still eligible even though deployed cards can never be materials themselves', () => {
    // The target's own candidateOf status is never checked for eligibility, only its materials'.
    const inv = invOf([card('deployedTarget', 'lichuang', 4)], fillers('m', 'lichuang', 4));
    expect(listFusableTargets(inv, candidateOf(new Set(['deployedTarget'])))[0].id).toBe('deployedTarget');
  });

  it('dimension 2 (preferDefId) beats level when deployment ties', () => {
    const inv = invOf(
      [card('sameChar', 'lichuang', 2)], fillers('sm', 'lichuang', 2),
      [card('otherChar', 'chenshou', 8)], fillers('om', 'chenshou', 8), // same faction (tao), higher level
    );
    expect(listFusableTargets(inv, free, 'lichuang')[0].id).toBe('sameChar');
  });

  it('dimension 3 (faction) beats level when no card matches preferDefId directly', () => {
    const inv = invOf(
      [card('sameFaction', 'chenshou', 2)], fillers('sf', 'chenshou', 2),   // tao, not lichuang
      [card('otherFaction', 'max', 8)], fillers('of', 'max', 8),            // anna, higher level
    );
    // preferDefId 'lichuang' (tao) is absent from inv entirely — only its faction matters here.
    expect(listFusableTargets(inv, free, 'lichuang')[0].id).toBe('sameFaction');
  });

  it('excludes locked, maxed, and unknown-def cards', () => {
    expect(listFusableTargets(invOf([card('locked', 'lichuang', 3, true)], fillers('a', 'lichuang', 3)), free)
      .map((c) => c.id)).not.toContain('locked');
    expect(listFusableTargets(invOf([card('maxed', 'lichuang', MAX_CARD_LEVEL)], fillers('b', 'lichuang', MAX_CARD_LEVEL)), free))
      .toEqual([]);
    expect(listFusableTargets(invOf([card('ghost', 'no-such-def', 3)], fillers('c', 'no-such-def', 3)), free))
      .toEqual([]);
  });

  it('only counts materials that pass candidateOf (deployed materials do not reach the threshold)', () => {
    // Group of exactly FUSION_MATERIAL_COUNT same-faction same-level cards: 't' + 1 deployed filler +
    // (FUSION_MATERIAL_COUNT - 2) free fillers. From 't's perspective the deployed filler is excluded,
    // leaving one short of the threshold; the deployed filler itself is one short too (its own pool is
    // 't' + the free fillers), so nothing in this inventory is fusable.
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      [card('df0', 'lichuang', 3)],
      fillers('m', 'lichuang', 3, FUSION_MATERIAL_COUNT - 2),
    );
    expect(listFusableTargets(inv, candidateOf(new Set(['df0'])))).toEqual([]);
  });
});

describe('planPrep — the "go make what you are missing" path', () => {
  it('is null when the target can already be fused', () => {
    const inv = invOf([card('t', 'lichuang', 3)], fillers('m', 'lichuang', 3));
    expect(planPrep(inv.t, inv, free)).toBeNull();
  });

  it('is null at Lv.1, where there is no level below to fuse up from', () => {
    const inv = invOf([card('t', 'lichuang', 1)]);
    expect(planPrep(inv.t, inv, free)).toBeNull();
  });

  it('prices the shortfall at 5 materials + 1 feeder per produced card', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('hi', 'lichuang', 3, 2),   // 2 of the 5 needed materials on hand
      fillers('lo', 'lichuang', 2, 18),  // one level down
    );
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.shortfall).toBe(3);
    expect(plan.feederLevel).toBe(2);
    expect(plan.cost).toBe(3 * PREP_COST_PER_CARD); // 18
    expect(plan.avail).toBe(18);
    expect(plan.affordable).toBe(true);
  });

  it('reports an unaffordable plan rather than hiding it — the gap state needs the numbers', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('lo', 'lichuang', 2, 7),
    );
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.cost).toBe(5 * PREP_COST_PER_CARD);
    expect(plan.avail).toBe(7);
    expect(plan.affordable).toBe(false);
  });

  it('prices the level below when feederLevel alone falls short (the ordinary mid-game shape)', () => {
    // Lv.3 target 1 material short ⇒ 6 Lv.2 needed, only 4 owned ⇒ the 2 missing Lv.2 each cost
    // another PREP_COST_PER_CARD in Lv.1 cards ⇒ 12 Lv.1. This is the case that used to dead-end:
    // affordable=false with no explanation, even though the player could plainly get there.
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('hi', 'lichuang', 3, FUSION_MATERIAL_COUNT - 1),
      fillers('mid', 'lichuang', 2, 4),
      fillers('lo', 'lichuang', 1, 12),
    );
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.affordable, 'Lv.2 alone does not cover it').toBe(false);
    expect(plan.chain).toEqual({ level: 1, need: 2 * PREP_COST_PER_CARD, have: 12 });
    expect(plan.fundable, 'but the chain does').toBe(true);
  });

  it('is not fundable when the level below is short too', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('hi', 'lichuang', 3, FUSION_MATERIAL_COUNT - 1),
      fillers('mid', 'lichuang', 2, 4),
      fillers('lo', 'lichuang', 1, 11), // one short of the 12 the chain needs
    );
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.chain!.have).toBe(11);
    expect(plan.fundable).toBe(false);
  });

  it('has no chain to price when the feeder level is already Lv.1', () => {
    const inv = invOf([card('t', 'lichuang', 2)], fillers('lo', 'lichuang', 1, 2));
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.feederLevel).toBe(1);
    expect(plan.chain, 'nothing below Lv.1 to reach for').toBeNull();
    expect(plan.fundable).toBe(false);
  });

  it('reports hasFeeder=false when every copy one level down is geared', () => {
    // Gear disqualifies a card from being the FEEDER (pickFeeder would silently dismantle its
    // loadout) but not from being one of that feeder's five MATERIALS — so the player can own more
    // than enough cards and still have nobody to fuse them into. Kept separate from `affordable`
    // because the UI must withhold the prep button on either one being false; conflating them
    // produced a live button that did nothing when tapped.
    const geared = Array.from({ length: PREP_COST_PER_CARD }, (_, i) =>
      ({ ...card(`g${i}`, 'lichuang', 2), gear: { weapon: 'eq1' } } as CardInstance));
    // 4 of the 5 Lv.3 materials on hand ⇒ shortfall 1 ⇒ cost is exactly PREP_COST_PER_CARD.
    const inv = invOf([card('t', 'lichuang', 3)], fillers('hi', 'lichuang', 3, FUSION_MATERIAL_COUNT - 1), geared);
    const plan = planPrep(inv.t, inv, free)!;
    expect(plan.affordable, 'the raw material is all there').toBe(true);
    expect(plan.hasFeeder).toBe(false);

    inv.clean = card('clean', 'chenshou', 2); // one ungeared copy is enough
    expect(planPrep(inv.t, inv, free)!.hasFeeder).toBe(true);
  });

  it('does not count deployed or locked cards toward what prep has to work with', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('lo', 'lichuang', 2, 6),
      [card('locked', 'lichuang', 2, true), card('deployed', 'chenshou', 2)],
    );
    expect(planPrep(inv.t, inv, candidateOf(new Set(['deployed'])))!.avail).toBe(6);
  });
});

describe('pickFeeder — ranked the OPPOSITE way from the recommendation strip', () => {
  it('never picks a deployed or locked card, however convenient', () => {
    const inv = invOf(
      [card('deployed', 'lichuang', 2), card('locked', 'lichuang', 2, true)],
      // 6 free copies: one becomes the feeder, the other 5 are its materials. The deployed and
      // locked cards are excluded from both roles, so they cannot make up the shortfall either.
      fillers('m', 'lichuang', 2, FUSION_MATERIAL_COUNT + 1),
    );
    const feeder = pickFeeder('tao', 2, inv, candidateOf(new Set(['deployed'])));
    expect(feeder).not.toBeNull();
    expect(['deployed', 'locked']).not.toContain(feeder!.id);
  });

  it('never picks a geared card — fusing it would silently dismantle the loadout', () => {
    const inv = invOf(
      [{ ...card('geared', 'chenshou', 2), gear: { weapon: 'eq1' } } as CardInstance],
      fillers('m', 'lichuang', 2, FUSION_MATERIAL_COUNT),
    );
    expect(pickFeeder('tao', 2, inv, free)!.id).not.toBe('geared');
  });

  it('burns the deepest stack of duplicates first, sparing the last copy of a character', () => {
    // 'lichuang' has 6 copies at this level, 'chenshou' only 1 — the feeder must come from lichuang
    // so the single chenshou survives as a possible SLG bench body.
    const inv = invOf(fillers('lc', 'lichuang', 2, 6), [card('lastChenshou', 'chenshou', 2)]);
    expect(pickFeeder('tao', 2, inv, free)!.defId).toBe('lichuang');
  });

  it('returns null when nothing at that level can be fused yet', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, FUSION_MATERIAL_COUNT - 1));
    expect(pickFeeder('tao', 2, inv, free)).toBeNull();
  });
});

describe('countPrepRounds — the number on the batch button', () => {
  it('counts what can actually be completed, not the arithmetic bound', () => {
    // 12 cards = 2 full rounds of (1 feeder + 5 materials).
    const inv = invOf(fillers('lc', 'lichuang', 2, 12));
    expect(countPrepRounds('tao', 2, inv, free, 9)).toBe(2);
  });

  it('is capped by the caller-supplied limit (what the frame still needs)', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 18));
    expect(countPrepRounds('tao', 2, inv, free, 1)).toBe(1);
  });

  it('is 0 when a single round is unaffordable', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, FUSION_MATERIAL_COUNT));
    expect(countPrepRounds('tao', 2, inv, free, 9)).toBe(0);
  });
});

describe('planPrepRounds — the run the batch endpoint is handed', () => {
  // The plan goes out as ONE POST /cards/fuse-batch, so it has to be executable as written: every
  // round names cards that still exist at that point in the run, and no card is spent twice.
  it('emits one round per completable fusion, spending each card at most once', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 12));
    const plan = planPrepRounds('tao', 2, inv, free, 9);
    expect(plan).toHaveLength(2);
    const spent = plan.flatMap((r) => [r.targetId, ...r.materialIds]);
    expect(new Set(spent).size, 'no card appears in two rounds').toBe(spent.length);
    for (const r of plan) expect(r.materialIds).toHaveLength(FUSION_MATERIAL_COUNT);
  });

  it('never lists a round target as its own material', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 12));
    for (const r of planPrepRounds('tao', 2, inv, free, 9)) {
      expect(r.materialIds).not.toContain(r.targetId);
    }
  });

  it('agrees with the count shown on the button', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 18));
    expect(planPrepRounds('tao', 2, inv, free, 9)).toHaveLength(countPrepRounds('tao', 2, inv, free, 9));
  });

  it('leaves the caller inventory untouched — it plans, it does not apply', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 12));
    const before = Object.keys(inv).length;
    planPrepRounds('tao', 2, inv, free, 9);
    expect(Object.keys(inv)).toHaveLength(before);
  });

  it('is empty when a single round is unaffordable', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, FUSION_MATERIAL_COUNT));
    expect(planPrepRounds('tao', 2, inv, free, 9)).toEqual([]);
  });

  it('never makes a geared card a round target, and spends the gear-free copies first', () => {
    // Two rules that used to be enforced round-by-round, as each request was assembled. The plan is
    // now built in one pass and shipped as ONE request the server executes without re-consulting the
    // client, and the server does NOT check gear — it just deletes materials — so a plan that named
    // a geared card as feeder would silently dismantle a loadout with nothing left to stop it.
    const geared = fillers('g', 'lichuang', 2, 3).map((c) => ({ ...c, gear: { weapon: 'eq1' } }));
    const inv = invOf(fillers('lc', 'lichuang', 2, 9), geared);
    const plan = planPrepRounds('tao', 2, inv, free, 9);
    expect(plan.length).toBeGreaterThan(0);

    const gearedIds = new Set(geared.map((c) => c.id));
    for (const r of plan) expect(gearedIds.has(r.targetId), `${r.targetId} carries gear`).toBe(false);
    // Round 0 has nine gear-free copies to choose five materials from, so it must not touch a geared
    // one — this is autoFillMaterials' ordering, which the pre-2026-08-20 round-count simulation
    // (plain readyMaterials) did not model, so count and run could disagree about what gets spent.
    for (const id of plan[0]!.materialIds) expect(gearedIds.has(id)).toBe(false);
  });

  it('respects a locked card as neither target nor material', () => {
    const inv = invOf(fillers('lc', 'lichuang', 2, 6));
    inv.lc0 = { ...inv.lc0!, locked: true };
    // 6 cards, one locked ⇒ 5 usable, which is one short of a feeder plus its five materials.
    expect(planPrepRounds('tao', 2, inv, free, 9)).toEqual([]);
  });
});

describe('autoFillMaterials — what the ring pre-loads', () => {
  it('loads at most n, and never the target itself', () => {
    const inv = invOf([card('t', 'lichuang', 3)], fillers('m', 'lichuang', 3, 9));
    const picks = autoFillMaterials(inv.t, inv, free, FUSION_MATERIAL_COUNT);
    expect(picks).toHaveLength(FUSION_MATERIAL_COUNT);
    expect(picks.map((c) => c.id)).not.toContain('t');
  });

  it('prefers gear-free copies, so a loadout is the last thing spent', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      [{ ...card('geared', 'chenshou', 3), gear: { weapon: 'eq1' } } as CardInstance],
      fillers('m', 'chenshou', 3, FUSION_MATERIAL_COUNT),
    );
    expect(autoFillMaterials(inv.t, inv, free, FUSION_MATERIAL_COUNT).map((c) => c.id)).not.toContain('geared');
  });

  it('spends the most redundant character first', () => {
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      fillers('many', 'chenshou', 3, FUSION_MATERIAL_COUNT),
      [card('lastSuyuan', 'suyuan', 3)],
    );
    expect(autoFillMaterials(inv.t, inv, free, FUSION_MATERIAL_COUNT).map((c) => c.id)).not.toContain('lastSuyuan');
  });
});
