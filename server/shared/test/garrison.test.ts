// Unit tests for the two replenishment curves added 2026-09-04 (SLG_DESIGN §4.5 / §5.5):
// `regenGarrison` + `tileGarrisonBaseline` (slg/garrison.ts) and `regenTeamStamina` (slg/siege.ts).
//
// Both are pure lazy-checkpoint functions in the same family as `regenDurability`, and both are read on
// every combat/dispatch path, so the cases below pin the properties the callers actually depend on rather
// than just a couple of midpoints: the clamps at each end, the "surplus is untouched" asymmetry that keeps
// reinforcements meaningful, and the clock-skew guard (a `now` behind the checkpoint must not subtract).
import { describe, expect, it } from 'vitest';
import {
  NPC_GARRISON_PER_LEVEL,
  SLG_TEAM_STAMINA_COST,
  SLG_TEAM_STAMINA_MAX,
  SLG_TEAM_STAMINA_REGEN_PER_MIN,
  TILE_GARRISON_REGEN_MS,
  npcGarrison,
  regenGarrison,
  regenTeamStamina,
  tileGarrisonBaseline,
} from '../src/slg';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe('tileGarrisonBaseline', () => {
  it('is the tile\'s own neutral-state garrison, so ownership does not change what the land resists with', () => {
    for (const level of [1, 3, 5, 10]) {
      expect(tileGarrisonBaseline(level)).toBe(npcGarrison(level));
      expect(tileGarrisonBaseline(level)).toBe(NPC_GARRISON_PER_LEVEL * level);
    }
  });

  it('floors at level 1 (a level-0 or negative row cannot make a tile worth zero)', () => {
    expect(tileGarrisonBaseline(0)).toBe(NPC_GARRISON_PER_LEVEL);
    expect(tileGarrisonBaseline(-4)).toBe(NPC_GARRISON_PER_LEVEL);
  });

  it('a missing / non-numeric level falls back to level 1 instead of producing NaN', () => {
    // TileDoc.level is typed required but absent on real documents (the siege path itself reads it as
    // `?? 1`). Un-guarded this reached `npcGarrison`'s Math.max(1, undefined) → NaN, and a NaN baseline
    // compares false against everything: the heal returned NaN and the defender could not lose. Caught by
    // worldsvc's combatSiege-encounter-arrival-branch-gaps case for a level-less tile.
    expect(tileGarrisonBaseline(undefined as unknown as number)).toBe(NPC_GARRISON_PER_LEVEL);
    expect(tileGarrisonBaseline(NaN)).toBe(NPC_GARRISON_PER_LEVEL);
    expect(tileGarrisonBaseline(Infinity)).toBe(NPC_GARRISON_PER_LEVEL);
  });
});

describe('regenGarrison', () => {
  const BASE = tileGarrisonBaseline(10); // 1200

  it('heals a fully stripped tile back to the baseline over exactly TILE_GARRISON_REGEN_MS', () => {
    expect(regenGarrison(0, BASE, T0, T0)).toBe(0);
    expect(regenGarrison(0, BASE, T0, T0 + TILE_GARRISON_REGEN_MS / 2)).toBe(BASE / 2);
    expect(regenGarrison(0, BASE, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(BASE);
  });

  it('caps at the baseline no matter how long the tile sat untouched', () => {
    expect(regenGarrison(0, BASE, T0, T0 + TILE_GARRISON_REGEN_MS * 100)).toBe(BASE);
    expect(regenGarrison(BASE - 1, BASE, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(BASE);
  });

  it('adds the heal on top of whatever is stored, so a partial loss refills proportionally faster', () => {
    // Half the window heals half a baseline (600) on top of the 500 still standing.
    expect(regenGarrison(500, BASE, T0, T0 + TILE_GARRISON_REGEN_MS / 2)).toBe(1100);
  });

  it('leaves a reinforced surplus alone — it neither regenerates nor decays', () => {
    const surplus = BASE + 5_000;
    expect(regenGarrison(surplus, BASE, T0, T0)).toBe(surplus);
    expect(regenGarrison(surplus, BASE, T0, T0 + TILE_GARRISON_REGEN_MS * 10)).toBe(surplus);
    // Exactly at the baseline is the boundary of that branch: still returned verbatim, never bumped.
    expect(regenGarrison(BASE, BASE, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(BASE);
  });

  it('never subtracts when `now` is behind the checkpoint (clock skew / a stamped future write)', () => {
    expect(regenGarrison(300, BASE, T0, T0 - TILE_GARRISON_REGEN_MS)).toBe(300);
  });

  it('floors the healed figure, so a fraction of a troop is never handed out', () => {
    // 1ms of a 5-minute window against a 1200 baseline is 0.004 troops.
    expect(regenGarrison(0, BASE, T0, T0 + 1)).toBe(0);
  });

  it('a zero baseline (a tile type that does not heal) is a pass-through', () => {
    expect(regenGarrison(250, 0, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(250);
  });

  it('non-finite inputs read as 0 rather than propagating NaN into the garrison', () => {
    // `NaN >= NaN` is false, so without the guard a NaN baseline fell through to the healing branch and
    // returned NaN — silently unbeatable defence. Both operands are guarded, not just the baseline.
    expect(regenGarrison(0, NaN, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(0);
    expect(regenGarrison(NaN, BASE, T0, T0 + TILE_GARRISON_REGEN_MS)).toBe(BASE);
    expect(regenGarrison(undefined as unknown as number, BASE, T0, T0)).toBe(0);
  });
});

describe('regenTeamStamina', () => {
  it('refills SLG_TEAM_STAMINA_REGEN_PER_MIN per minute from the checkpoint', () => {
    expect(regenTeamStamina(10, T0, T0)).toBe(10);
    expect(regenTeamStamina(10, T0, T0 + 5 * MIN)).toBe(10 + 5 * SLG_TEAM_STAMINA_REGEN_PER_MIN);
  });

  it('caps at SLG_TEAM_STAMINA_MAX', () => {
    expect(regenTeamStamina(10, T0, T0 + 1_000 * MIN)).toBe(SLG_TEAM_STAMINA_MAX);
    expect(regenTeamStamina(SLG_TEAM_STAMINA_MAX, T0, T0)).toBe(SLG_TEAM_STAMINA_MAX);
    // A stored value above the cap (a constant lowered mid-season) reads as full, not as an overflow.
    expect(regenTeamStamina(SLG_TEAM_STAMINA_MAX + 50, T0, T0)).toBe(SLG_TEAM_STAMINA_MAX);
  });

  it('never subtracts when `now` is behind the checkpoint', () => {
    expect(regenTeamStamina(30, T0, T0 - 10 * MIN)).toBe(30);
  });

  it('a zero-stamina team recovers enough for one order after SLG_TEAM_STAMINA_COST minutes', () => {
    const needed = SLG_TEAM_STAMINA_COST / SLG_TEAM_STAMINA_REGEN_PER_MIN;
    expect(regenTeamStamina(0, T0, T0 + (needed - 1) * MIN)).toBeLessThan(SLG_TEAM_STAMINA_COST);
    expect(regenTeamStamina(0, T0, T0 + needed * MIN)).toBeGreaterThanOrEqual(SLG_TEAM_STAMINA_COST);
  });

  it('a full bar affords SLG_TEAM_STAMINA_MAX / COST orders before the wall', () => {
    let left = SLG_TEAM_STAMINA_MAX;
    let orders = 0;
    while (left >= SLG_TEAM_STAMINA_COST) {
      left -= SLG_TEAM_STAMINA_COST;
      orders++;
    }
    expect(orders).toBe(Math.floor(SLG_TEAM_STAMINA_MAX / SLG_TEAM_STAMINA_COST));
    expect(left).toBeLessThan(SLG_TEAM_STAMINA_COST);
  });
});
