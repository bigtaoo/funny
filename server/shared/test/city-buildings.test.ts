// SLG home-city building system pure-function unit tests (SLG_CITY_DESIGN P1, ADR-022).
// Covers: biomeAt quad-partition (graphite now has a map faucet) + building yield/cap/troop/training helpers + desk gate + cost/time curves.
import { describe, it, expect } from 'vitest';
import {
  proceduralTile,
  RESOURCE_YIELD_BASE,
  TROOP_CAP_BASE,
  RESOURCE_CAP,
  TROOP_TRAIN_QUEUE_MAX,
  DESK_MAX_LEVEL,
  BUILD_YIELD_STEP,
  STICKER_SELF_BASE,
  CABINET_CAP_STEP,
  DRILL_TROOPCAP_STEP,
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
  type BuildingKey,
} from '../src/slg';

describe('biomeAt quad-partition (ADR-022: graphite is the 4th land resource)', () => {
  it('procedurally generates all four land resources across the map (graphite no longer absent)', () => {
    const seen = new Set<string>();
    for (let x = 0; x < 120; x += 2) {
      for (let y = 0; y < 120; y += 2) {
        const t = proceduralTile('s1-0', x, y);
        if (t.resType) seen.add(t.resType);
      }
    }
    expect(seen.has('ink')).toBe(true);
    expect(seen.has('paper')).toBe(true);
    expect(seen.has('graphite')).toBe(true); // the fix: graphite now has a biome faucet
    expect(seen.has('metal')).toBe(true);
    // sticker is never biome-generated (home-city self-produced)
    expect(seen.has('sticker')).toBe(false);
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
  it('stickerShop self-produces sticker (民居模型 faucet); other resources have no self-yield', () => {
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
    expect(trainQueueMaxFor({ drillYard: 5 })).toBe(TROOP_TRAIN_QUEUE_MAX + 1);
  });
});

describe('desk gate (D-CITY-6) + cost / time curves', () => {
  it('desk can grow to its cap; other buildings are gated by desk level', () => {
    expect(buildGateReason({ desk: 1 }, 'desk', 2)).toBeNull();
    expect(buildGateReason({ desk: DESK_MAX_LEVEL }, 'desk', DESK_MAX_LEVEL + 1)).toBe('desk at max level');
    expect(buildGateReason({ desk: 1 }, 'inkPot', 1)).toBeNull();        // desk 1 allows level-1 builds
    expect(buildGateReason({ desk: 1 }, 'inkPot', 2)).toBe('desk level too low');
    expect(buildGateReason({ desk: 5 }, 'inkPot', 5)).toBeNull();
    expect(buildGateReason({ desk: 1 }, 'wall', 1)).toBe('building not buildable yet'); // P2 building
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
