// SLG home-city building system pure-function unit tests (SLG_CITY_DESIGN P1+P2, ADR-022).
// Covers: biomeAt provincial-bias per-tile draw (graphite now has a map faucet) + building yield/cap/troop/training helpers + desk gate + cost/time curves
//         + P2: cabinet loot protect / academy buff. (wall's siege effect moved to durability, D-CITY-8 — see shared/test/siege.test.ts.)
import { describe, it, expect } from 'vitest';
import {
  proceduralTile,
  RESOURCE_YIELD_BASE,
  TROOP_CAP_BASE,
  RESOURCE_CAP,
  TROOP_TRAIN_QUEUE_MAX,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_TRAIN_INK_COST,
  TROOP_TRAIN_PAPER_COST,
  TROOP_TRAIN_GRAPHITE_COST,
  TROOP_TRAIN_METAL_COST,
  TROOP_TRAIN_STICKER_COST,
  troopTrainCost,
  DESK_MAX_LEVEL,
  BUILD_YIELD_STEP,
  STICKER_SELF_BASE,
  CABINET_CAP_STEP,
  CABINET_PROTECT_STEP,
  ACADEMY_HP_STEP,
  ACADEMY_DAMAGE_STEP,
  ACADEMY_SIEGE_STEP,
  DRILL_TROOPCAP_STEP,
  DRILL_QUEUE_LEVEL_THRESHOLDS,
  SATCHEL_CARRY_BASE,
  SATCHEL_CARRY_STEP,
  buildingLevel,
  deskLevel,
  buildingYieldMult,
  buildingSelfYield,
  resourceCapFor,
  troopCapFor,
  drillTrainMult,
  trainQueueMaxFor,
  buildCost,
  buildTimeSec,
  buildGateReason,
  cabinetLootProtect,
  academyBuff,
  satchelCarryCapFor,
  type BuildingKey,
} from '../src/slg';

describe('biomeAt provincial-bias per-tile draw (ADR-022: graphite is the 4th land resource)', () => {
  it('procedurally generates all four land resources across the map (graphite no longer absent)', () => {
    const seen = new Set<string>();
    let stickerBelow6 = 0;
    for (let x = 0; x < 300; x += 2) {
      for (let y = 0; y < 300; y += 2) {
        const t = proceduralTile('s1-0', x, y);
        if (t.resType) {
          seen.add(t.resType);
          if (t.resType === 'sticker' && t.level < 6) stickerBelow6++;
        }
      }
    }
    expect(seen.has('ink')).toBe(true);
    expect(seen.has('paper')).toBe(true);
    expect(seen.has('graphite')).toBe(true); // ADR-022: graphite now has a biome faucet
    expect(seen.has('metal')).toBe(true);
    // copper mine: sticker IS on the map now, but ONLY on level ≥6 tiles (Three-Kingdoms-Strategy rule, SGZ_LAND_REFERENCE §3).
    // The art ships sticker frames l6–10 only, so a sub-l6 sticker tile would break the level gate.
    expect(seen.has('sticker')).toBe(true);
    expect(stickerBelow6).toBe(0);
  });
});

describe('building level defaults', () => {
  it('desk defaults to 1, others to 0', () => {
    expect(buildingLevel(undefined, 'desk')).toBe(1);
    expect(buildingLevel(undefined, 'inkPot')).toBe(0);
    expect(deskLevel({ desk: 7 })).toBe(7);
    expect(buildingLevel({ inkPot: 3 }, 'inkPot')).toBe(3);
  });
});

describe('resource building yield multiplier + sticker self-production', () => {
  it('each resource building boosts only its matching land resource', () => {
    const b: Partial<Record<BuildingKey, number>> = { inkPot: 2, graphiteMill: 4 };
    expect(buildingYieldMult(b, 'ink')).toBeCloseTo(1 + 2 * BUILD_YIELD_STEP);
    expect(buildingYieldMult(b, 'graphite')).toBeCloseTo(1 + 4 * BUILD_YIELD_STEP);
    expect(buildingYieldMult(b, 'paper')).toBe(1);   // no paperTray
    expect(buildingYieldMult(b, 'sticker')).toBe(1); // sticker is never a multiplier target
  });
  it('stickerShop self-produces sticker (residential-model faucet); other resources have no self-yield', () => {
    expect(buildingSelfYield({ stickerShop: 3 }, 'sticker')).toBe(3 * STICKER_SELF_BASE);
    expect(buildingSelfYield({ stickerShop: 3 }, 'ink')).toBe(0);
    expect(buildingSelfYield(undefined, 'sticker')).toBe(0);
  });
});

describe('storage / troop / training derived caps', () => {
  it('cabinet raises the storage cap', () => {
    expect(resourceCapFor(undefined)).toBe(RESOURCE_CAP);
    expect(resourceCapFor({ cabinet: 5 })).toBe(Math.floor(RESOURCE_CAP * (1 + 5 * CABINET_CAP_STEP)));
  });
  it('drillYard raises troopCap, speeds training, and adds queue slots', () => {
    expect(troopCapFor(undefined)).toBe(TROOP_CAP_BASE);
    expect(troopCapFor({ drillYard: 3 })).toBe(TROOP_CAP_BASE + 3 * DRILL_TROOPCAP_STEP);
    expect(drillTrainMult(undefined)).toBe(1);
    expect(drillTrainMult({ drillYard: 2 })).toBeLessThan(1);
    expect(drillTrainMult({ drillYard: 100 })).toBeGreaterThanOrEqual(0.5); // floored
    expect(trainQueueMaxFor(undefined)).toBe(TROOP_TRAIN_QUEUE_MAX);
    // 1 slot at L0-L3, 2 at L4-L9, 3 at L10 (DRILL_QUEUE_LEVEL_THRESHOLDS = [4, 10]).
    expect(trainQueueMaxFor({ drillYard: 3 })).toBe(TROOP_TRAIN_QUEUE_MAX);
    expect(trainQueueMaxFor({ drillYard: 4 })).toBe(TROOP_TRAIN_QUEUE_MAX + 1);
    expect(trainQueueMaxFor({ drillYard: 9 })).toBe(TROOP_TRAIN_QUEUE_MAX + 1);
    expect(trainQueueMaxFor({ drillYard: DESK_MAX_LEVEL })).toBe(TROOP_TRAIN_QUEUE_MAX + DRILL_QUEUE_LEVEL_THRESHOLDS.length);
  });
  /**
   * The 2026-08-25 re-tune's whole point: a slot beyond `ceil(troopCap / TROOP_TRAIN_BATCH_MAX)` can never be
   * filled (the troopCap check in worldsvc trainTroops rejects the batch first), so granting one is dead value
   * — which is exactly what `2 + floor(level/2)` did after TROOP_TRAIN_BATCH_MAX went 500 → 5000. Asserted
   * across the whole level range so any future move of TROOP_CAP_BASE / DRILL_TROOPCAP_STEP /
   * TROOP_TRAIN_BATCH_MAX / the thresholds fails here instead of silently re-growing dead slots.
   */
  it('never grants a training queue slot that troopCap cannot fill', () => {
    for (let lvl = 0; lvl <= DESK_MAX_LEVEL; lvl++) {
      const buildings = { drillYard: lvl };
      const usable = Math.ceil(troopCapFor(buildings) / TROOP_TRAIN_BATCH_MAX);
      expect(trainQueueMaxFor(buildings)).toBeLessThanOrEqual(usable);
      expect(trainQueueMaxFor(buildings)).toBeGreaterThanOrEqual(1); // training must be reachable at every level
    }
  });
  /** D-CITY-9: a maxed satchel carries a maxed drillYard's whole pool in one team (same base, same step). */
  it('maxed satchel carry cap equals maxed troopCap', () => {
    expect(satchelCarryCapFor({ satchel: DESK_MAX_LEVEL })).toBe(troopCapFor({ drillYard: DESK_MAX_LEVEL }));
  });
});

describe('desk gate (D-CITY-6) + cost / time curves', () => {
  it('desk can grow to its cap; other buildings are gated by desk level', () => {
    expect(buildGateReason({ desk: 1 }, 'desk', 2)).toBeNull();
    expect(buildGateReason({ desk: DESK_MAX_LEVEL }, 'desk', DESK_MAX_LEVEL + 1)).toBe('desk at max level');
    expect(buildGateReason({ desk: 1 }, 'inkPot', 1)).toBeNull();        // desk 1 allows level-1 builds
    expect(buildGateReason({ desk: 1 }, 'inkPot', 2)).toBe('desk level too low');
    expect(buildGateReason({ desk: 5 }, 'inkPot', 5)).toBeNull();
    expect(buildGateReason({ desk: 1 }, 'wall', 1)).toBeNull();   // P2: wall now buildable (desk gate applies normally)
    expect(buildGateReason({ desk: 1 }, 'wall', 2)).toBe('desk level too low');  // desk still gates level
    expect(buildGateReason(undefined, 'badkey' as BuildingKey, 1)).toBe('unknown building');
  });
  it('cost scales with target level; high-tier buildings sink graphite/sticker', () => {
    const c1 = buildCost('cabinet', 1);
    const c2 = buildCost('cabinet', 2);
    expect((c2.paper ?? 0)).toBe((c1.paper ?? 0) * 2);
    expect((c1.graphite ?? 0)).toBeGreaterThan(0); // graphite sink
    expect((c1.sticker ?? 0)).toBeGreaterThan(0);  // sticker sink
    expect(buildTimeSec('desk', 2)).toBeGreaterThan(buildTimeSec('inkPot', 2)); // desk is slower
    expect(buildTimeSec('inkPot', 2)).toBe(buildTimeSec('inkPot', 1) * 2);
  });
});

describe('troopTrainCost (2026-08-01: training spends all five resources, not ink alone)', () => {
  it('scales linearly with qty across ink/paper/graphite/metal/sticker', () => {
    const c1 = troopTrainCost(1);
    expect(c1).toEqual({
      ink: TROOP_TRAIN_INK_COST,
      paper: TROOP_TRAIN_PAPER_COST,
      graphite: TROOP_TRAIN_GRAPHITE_COST,
      metal: TROOP_TRAIN_METAL_COST,
      sticker: TROOP_TRAIN_STICKER_COST,
    });
    const c100 = troopTrainCost(100);
    expect(c100).toEqual({
      ink: 100 * TROOP_TRAIN_INK_COST,
      paper: 100 * TROOP_TRAIN_PAPER_COST,
      graphite: 100 * TROOP_TRAIN_GRAPHITE_COST,
      metal: 100 * TROOP_TRAIN_METAL_COST,
      sticker: 100 * TROOP_TRAIN_STICKER_COST,
    });
  });
  it('floors fractional qty and clamps negative qty to 0 (never a negative or partial-unit cost)', () => {
    expect(troopTrainCost(2.9)).toEqual(troopTrainCost(2));
    expect(troopTrainCost(-5)).toEqual({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 });
    expect(troopTrainCost(0)).toEqual({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 });
  });
});

describe('P2 building functions: cabinetLootProtect / academyBuff', () => {
  it('cabinetLootProtect: no cabinet → 0; scales with CABINET_PROTECT_STEP; capped at 0.8', () => {
    expect(cabinetLootProtect(undefined)).toBe(0);
    expect(cabinetLootProtect({ cabinet: 1 })).toBeCloseTo(CABINET_PROTECT_STEP);
    expect(cabinetLootProtect({ cabinet: 10 })).toBeCloseTo(10 * CABINET_PROTECT_STEP);
    // capped at 0.8 even at max level (L40 would exceed)
    expect(cabinetLootProtect({ cabinet: 100 })).toBe(0.8);
  });
  it('academyBuff: no academy → hp=0, damage=0, siege=0; scales per level', () => {
    expect(academyBuff(undefined)).toEqual({ hp: 0, damage: 0, siege: 0 });
    expect(academyBuff({ academy: 0 })).toEqual({ hp: 0, damage: 0, siege: 0 });
    expect(academyBuff({ academy: 1 })).toEqual({ hp: ACADEMY_HP_STEP, damage: ACADEMY_DAMAGE_STEP, siege: ACADEMY_SIEGE_STEP });
    expect(academyBuff({ academy: 10 }).hp).toBeCloseTo(10 * ACADEMY_HP_STEP);
    expect(academyBuff({ academy: 10 }).damage).toBeCloseTo(10 * ACADEMY_DAMAGE_STEP);
    expect(academyBuff({ academy: 10 }).siege).toBeCloseTo(10 * ACADEMY_SIEGE_STEP);
  });
});

describe('P3 building function: satchel per-march troop-carry cap (D-CITY-9)', () => {
  it('satchelCarryCapFor: no satchel → SATCHEL_CARRY_BASE; each level adds SATCHEL_CARRY_STEP', () => {
    expect(satchelCarryCapFor(undefined)).toBe(SATCHEL_CARRY_BASE);
    expect(satchelCarryCapFor({ satchel: 0 })).toBe(SATCHEL_CARRY_BASE);
    expect(satchelCarryCapFor({ satchel: 1 })).toBe(SATCHEL_CARRY_BASE + SATCHEL_CARRY_STEP);
    expect(satchelCarryCapFor({ satchel: 10 })).toBe(SATCHEL_CARRY_BASE + 10 * SATCHEL_CARRY_STEP);
  });
});
