// CardScene/feedAutoTarget.ts's findAutoTarget — direct unit coverage of the ranking algorithm
// itself (pure function, no PIXI/CardScene wiring). Until now this logic was only ever exercised
// indirectly through cardFusePanel.ui.ts's full CardScene flow, which never isolated the four
// ranking dimensions from each other or their interaction with the eligibility filters.
//
// Ranking (see feedAutoTarget.ts's doc comment, 2026-08-10 order), most-significant first:
//   (1) currently deployed to an SLG team (via `candidateOf`, inverted — see below)
//   (2) same defId as `preferDefId`
//   (3) same faction as `preferDefId`'s card
//   (4) highest level
// Eligibility: unlocked, below MAX_CARD_LEVEL, known defId, >= FUSION_MATERIAL_COUNT same-faction
// same-level unlocked materials on hand (materials must satisfy `candidateOf`, the target itself
// need not — a deployed card can still be the fusion *target*, only never a *material*).
import { describe, it, expect } from 'vitest';
import { findAutoTarget } from '../src/scenes/CardScene/feedAutoTarget';
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

describe('findAutoTarget', () => {
  it('returns null when no card has enough materials', () => {
    const inv = invOf([card('t1', 'lichuang', 3)], fillers('m', 'lichuang', 3, FUSION_MATERIAL_COUNT - 1));
    expect(findAutoTarget(inv, candidateOf(new Set()))).toBeNull();
  });

  it('dimension 4 (level): among otherwise-tied cards, picks the highest level', () => {
    const inv = invOf(
      [card('low', 'lichuang', 3)], fillers('lowm', 'lichuang', 3),
      [card('high', 'lichuang', 5)], fillers('highm', 'lichuang', 5),
    );
    expect(findAutoTarget(inv, candidateOf(new Set()))!.id).toBe('high');
  });

  it('dimension 1 (deployed) beats level: a deployed low-level target outranks a bench high-level one', () => {
    const inv = invOf(
      [card('deployedLow', 'lichuang', 1)], fillers('dm', 'lichuang', 1),
      [card('benchHigh', 'lichuang', 8)], fillers('bm', 'lichuang', 8),
    );
    const deployed = new Set(['deployedLow']); // deployed cards fail candidateOf, so rank higher on dim 1
    expect(findAutoTarget(inv, candidateOf(deployed))!.id).toBe('deployedLow');
  });

  it('a deployed target is still eligible even though deployed cards can never be materials themselves', () => {
    // The target's own candidateOf status is never checked for eligibility, only its materials'.
    const inv = invOf([card('deployedTarget', 'lichuang', 4)], fillers('m', 'lichuang', 4));
    const deployed = new Set(['deployedTarget']);
    expect(findAutoTarget(inv, candidateOf(deployed))!.id).toBe('deployedTarget');
  });

  it('dimension 2 (preferDefId) beats level when deployment ties', () => {
    const inv = invOf(
      [card('sameChar', 'lichuang', 2)], fillers('sm', 'lichuang', 2),
      [card('otherChar', 'chenshou', 8)], fillers('om', 'chenshou', 8), // same faction (tao), higher level
    );
    expect(findAutoTarget(inv, candidateOf(new Set()), undefined, 'lichuang')!.id).toBe('sameChar');
  });

  it('dimension 3 (faction) beats level when no card matches preferDefId directly', () => {
    const inv = invOf(
      [card('sameFaction', 'chenshou', 2)], fillers('sf', 'chenshou', 2),   // tao, not lichuang
      [card('otherFaction', 'max', 8)], fillers('of', 'max', 8),           // anna, higher level
    );
    // preferDefId 'lichuang' (tao) is absent from inv entirely — only its faction matters here.
    expect(findAutoTarget(inv, candidateOf(new Set()), undefined, 'lichuang')!.id).toBe('sameFaction');
  });

  it('requireLevel filters candidates down to an exact level', () => {
    const inv = invOf(
      [card('lvl2', 'lichuang', 2)], fillers('l2m', 'lichuang', 2),
      [card('lvl4', 'lichuang', 4)], fillers('l4m', 'lichuang', 4),
    );
    expect(findAutoTarget(inv, candidateOf(new Set()), 2)!.id).toBe('lvl2');
    expect(findAutoTarget(inv, candidateOf(new Set()), 4)!.id).toBe('lvl4');
    expect(findAutoTarget(inv, candidateOf(new Set()), 7)).toBeNull();
  });

  it('excludes locked cards', () => {
    const inv = invOf([card('locked', 'lichuang', 3, true)], fillers('m', 'lichuang', 3));
    expect(findAutoTarget(inv, candidateOf(new Set()))).toBeNull();
  });

  it('excludes cards already at MAX_CARD_LEVEL', () => {
    const inv = invOf([card('maxed', 'lichuang', MAX_CARD_LEVEL)], fillers('m', 'lichuang', MAX_CARD_LEVEL));
    expect(findAutoTarget(inv, candidateOf(new Set()))).toBeNull();
  });

  it('excludes cards with an unknown defId (not in CARD_DEFS)', () => {
    const inv = invOf([card('ghost', 'no-such-def', 3)], fillers('m', 'no-such-def', 3));
    expect(findAutoTarget(inv, candidateOf(new Set()))).toBeNull();
  });

  it('only counts materials that pass candidateOf (deployed materials do not count toward the threshold)', () => {
    // Group of exactly FUSION_MATERIAL_COUNT same-faction same-level cards: 't' + 1 deployed filler +
    // (FUSION_MATERIAL_COUNT - 2) free fillers. From 't's perspective the deployed filler is excluded,
    // leaving only FUSION_MATERIAL_COUNT - 2 eligible materials (one short of the threshold). The
    // deployed filler itself must ALSO fall short as a competing target (its own pool, seen from its
    // perspective, is 't' + the free fillers = FUSION_MATERIAL_COUNT - 1, still one short) — otherwise
    // this test would just be re-proving the "deployed cards are still eligible targets" case above.
    const inv = invOf(
      [card('t', 'lichuang', 3)],
      [card('df0', 'lichuang', 3)],
      fillers('m', 'lichuang', 3, FUSION_MATERIAL_COUNT - 2),
    );
    expect(findAutoTarget(inv, candidateOf(new Set(['df0'])))).toBeNull();
  });
});
