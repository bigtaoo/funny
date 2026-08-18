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
  PREP_COST_PER_CARD, autoFillMaterials, countPrepRounds, listFusableTargets, pickFeeder, planPrep,
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
