import { describe, expect, it } from 'vitest';
import {
  NATION_BONUS_DEFENSE,
  SLG_BASE_HP_PER_LEVEL,
  SLG_SIEGE_VALUE_PER_CARD,
  buildSiegeBattle,
  buildSiegeLevel,
  buildingMaxHp,
  isInVision,
  marchInterpPos,
  nationDefenseStrength,
  npcGarrison,
  resolveSiege,
  siegeSeedFromId,
  strongholdGarrison,
  strongholdMaterialLoot,
  teamSiegeValue,
  waveSeed,
  type VisionSource,
} from '../src/slg';
import type { CardInstance } from '../src/types';

describe('resolveSiege', () => {
  it('attacker wins when troops exceed defense; survivors = difference', () => {
    expect(resolveSiege(100, 60)).toEqual({ outcome: 'attacker_win', attackerSurvivors: 40, defenderSurvivors: 0 });
  });

  it('defender wins ties (defender advantage)', () => {
    expect(resolveSiege(100, 100)).toEqual({ outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 0 });
  });

  it('defender wins when defense exceeds attacker troops; survivors = difference', () => {
    expect(resolveSiege(60, 100)).toEqual({ outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 40 });
  });

  it('clamps negative inputs to 0', () => {
    expect(resolveSiege(-5, -5)).toEqual({ outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 0 });
  });
});

describe('nationDefenseStrength', () => {
  it('applies the nation defense bonus when in own nation', () => {
    expect(nationDefenseStrength(1000, true)).toBe(Math.floor(1000 * (1 + NATION_BONUS_DEFENSE)));
  });

  it('leaves garrison unchanged outside own nation', () => {
    expect(nationDefenseStrength(1000, false)).toBe(1000);
  });
});

describe('npcGarrison / strongholdGarrison / strongholdMaterialLoot', () => {
  it('is linear by level, floored at level 1', () => {
    expect(npcGarrison(0)).toBe(npcGarrison(1));
    expect(npcGarrison(3)).toBe(120 * 3);
    expect(strongholdGarrison(5)).toBe(360 * 5);
  });

  it('material loot scales linearly by level', () => {
    expect(strongholdMaterialLoot(2)).toEqual({ material: 'binding', qty: 8 });
  });
});

describe('isInVision', () => {
  const sources: VisionSource[] = [{ x: 10, y: 10, radius: 2 }];

  it('is true within the Chebyshev radius', () => {
    expect(isInVision(sources, 11, 12)).toBe(true);
    expect(isInVision(sources, 8, 8)).toBe(true);
  });

  it('is false outside the radius', () => {
    expect(isInVision(sources, 13, 10)).toBe(false);
  });

  it('is false with no sources', () => {
    expect(isInVision([], 10, 10)).toBe(false);
  });
});

describe('marchInterpPos', () => {
  it('interpolates linearly by elapsed fraction', () => {
    expect(marchInterpPos(0, 0, 10, 0, 0, 100, 50)).toEqual({ x: 5, y: 0 });
  });

  it('clamps before departure to the origin', () => {
    expect(marchInterpPos(0, 0, 10, 0, 100, 200, 0)).toEqual({ x: 0, y: 0 });
  });

  it('clamps after arrival to the destination', () => {
    expect(marchInterpPos(0, 0, 10, 0, 0, 100, 1000)).toEqual({ x: 10, y: 0 });
  });

  it('returns the destination for a degenerate span (arriveAt <= departAt)', () => {
    expect(marchInterpPos(0, 0, 10, 0, 100, 100, 100)).toEqual({ x: 10, y: 0 });
  });
});

describe('siegeSeedFromId / waveSeed', () => {
  it('is deterministic for the same id', () => {
    expect(siegeSeedFromId('g:s1-0:acc:1:0')).toBe(siegeSeedFromId('g:s1-0:acc:1:0'));
  });

  it('differs across different ids', () => {
    expect(siegeSeedFromId('a')).not.toBe(siegeSeedFromId('b'));
  });

  it('varies per wave index for the same march but stays deterministic', () => {
    const s0 = waveSeed('m:1', 0);
    const s1 = waveSeed('m:1', 1);
    expect(s0).not.toBe(s1);
    expect(waveSeed('m:1', 0)).toBe(s0);
  });
});

describe('buildingMaxHp', () => {
  it('scales linearly with level', () => {
    expect(buildingMaxHp(3)).toBe(3 * SLG_BASE_HP_PER_LEVEL);
  });

  it('floors at SLG_BASE_HP_PER_LEVEL for level 0 or negative', () => {
    expect(buildingMaxHp(0)).toBe(SLG_BASE_HP_PER_LEVEL);
    expect(buildingMaxHp(-5)).toBe(SLG_BASE_HP_PER_LEVEL);
  });
});

describe('teamSiegeValue', () => {
  const card: CardInstance = { id: 'c1', defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false };

  it('falls back to SLG_SIEGE_VALUE_PER_CARD when no cardInv is given', () => {
    const army = [{ cardInstanceId: 'inst1' }, { cardInstanceId: 'inst2' }];
    expect(teamSiegeValue(army)).toBe(2 * SLG_SIEGE_VALUE_PER_CARD);
  });

  it('resolves the per-card value from cardInv when present', () => {
    expect(teamSiegeValue([{ cardInstanceId: 'inst1' }], { inst1: card })).toBe(11); // lichuang siegeValueBase at level 1
  });

  it('falls back per-entry when a cardInstanceId is missing from cardInv', () => {
    expect(teamSiegeValue([{ cardInstanceId: 'unknown' }], { inst1: card })).toBe(SLG_SIEGE_VALUE_PER_CARD);
  });

  it('skips entries without a cardInstanceId', () => {
    expect(teamSiegeValue([{}, { cardInstanceId: undefined }])).toBe(0);
  });
});

describe('buildSiegeLevel / buildSiegeBattle', () => {
  it('derives a symbolic defenderBaseLevel from tileLevel when no config is given', () => {
    const level = buildSiegeLevel(null, 3, 123);
    expect(level.defenderBaseLevel).toBe(2);
    expect(level.objective).toEqual({ kind: 'destroy_base' });
    expect(level.seed).toBe(123);
  });

  it('clamps the derived defenderBaseLevel into [0,2]', () => {
    expect(buildSiegeLevel(null, 0, 1).defenderBaseLevel).toBe(0);
    expect(buildSiegeLevel(null, 99, 1).defenderBaseLevel).toBe(2);
  });

  it('carries through explicit garrison/defenderBuildings/defenderBaseLevel when provided', () => {
    const level = buildSiegeLevel({ garrison: [{ x: 1 }], defenderBuildings: [{ id: 'wall' }], defenderBaseLevel: 2 }, 5, 1);
    expect(level.garrison).toEqual([{ x: 1 }]);
    expect(level.defenderBuildings).toEqual([{ id: 'wall' }]);
    expect(level.defenderBaseLevel).toBe(2);
  });

  it('buildSiegeBattle layers attackerArmy + battleTimeoutTicks on top of buildSiegeLevel', () => {
    const battle = buildSiegeBattle({ army: [{ initialHp: 500 }] }, null, 3, 42, 999);
    expect(battle.attackerArmy).toEqual([{ initialHp: 500 }]);
    expect(battle.battleTimeoutTicks).toBe(999);
    expect(battle.defenderBaseLevel).toBe(2);
  });

  it('omits attackerArmy when the attacker has no army', () => {
    const battle = buildSiegeBattle(null, null, 3, 42);
    expect(battle.attackerArmy).toBeUndefined();
  });
});
