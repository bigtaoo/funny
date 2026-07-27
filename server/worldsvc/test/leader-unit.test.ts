// Pure-function unit tests for march-token leader resolution (2026-07-26, no Mongo, always-run).
// See design/game/WORLD_MAP_ART_SPEC.md and leaderUnit.ts::resolveLeaderUnitType. Mirrors the
// client's teamTroops.ts::teamLeaderCard() picking rule (explicit leaderCardId else strongest
// card by cardPower, ties broken by lowest card id) but resolved to a unit-type string server-side.
import { describe, expect, it } from 'vitest';
import type { CardInstance, EquipmentInstance } from '@nw/shared';
import type { ArmyEntry, TeamTemplate } from '../src/db';
import { resolveLeaderUnitType } from '../src/leaderUnit';

function card(id: string, defId: string, level = 1): CardInstance {
  return { id, defId, level, gear: {}, locked: false };
}

function team(army: ArmyEntry[], leaderCardId?: string): Pick<TeamTemplate, 'army' | 'leaderCardId'> {
  return { army, ...(leaderCardId ? { leaderCardId } : {}) };
}

const EMPTY_EQUIP: Record<string, EquipmentInstance> = {};

describe('resolveLeaderUnitType', () => {
  it('no army entries with a resolvable card → undefined', () => {
    const t = team([{ cardInstanceId: 'ghost', col: 0, row: 0 }]);
    expect(resolveLeaderUnitType(t, {}, EMPTY_EQUIP)).toBeUndefined();
  });

  it('single card entry, no explicit leaderCardId → that card\'s unit-type', () => {
    const inv = { c1: card('c1', 'suyuan') }; // archer
    const t = team([{ cardInstanceId: 'c1', col: 0, row: 0 }]);
    expect(resolveLeaderUnitType(t, inv, EMPTY_EQUIP)).toBe('archer');
  });

  it('explicit leaderCardId (present in army) wins over a higher-power teammate', () => {
    const inv = {
      leader: card('leader', 'lichuang', 1), // infantry, low level
      strong: card('strong', 'suyuan', 9),   // archer, max level → higher cardPower
    };
    const t = team(
      [{ cardInstanceId: 'leader', col: 0, row: 0 }, { cardInstanceId: 'strong', col: 1, row: 0 }],
      'leader',
    );
    expect(resolveLeaderUnitType(t, inv, EMPTY_EQUIP)).toBe('infantry');
  });

  it('leaderCardId no longer in army (edited away) → falls back to strongest card', () => {
    const inv = {
      stale: card('stale', 'lichuang', 9),
      strong: card('strong', 'suyuan', 9),
    };
    const t = team([{ cardInstanceId: 'strong', col: 0, row: 0 }], 'stale'); // 'stale' not in army
    expect(resolveLeaderUnitType(t, inv, EMPTY_EQUIP)).toBe('archer');
  });

  it('no explicit leaderCardId → strongest card by cardPower', () => {
    const inv = {
      weak: card('weak', 'lichuang', 1),
      strong: card('strong', 'suyuan', 9),
    };
    const t = team([{ cardInstanceId: 'weak', col: 0, row: 0 }, { cardInstanceId: 'strong', col: 1, row: 0 }]);
    expect(resolveLeaderUnitType(t, inv, EMPTY_EQUIP)).toBe('archer');
  });

  it('exact cardPower tie (same def/level/gear) → deterministic, does not throw', () => {
    const inv = { b: card('b', 'lichuang', 5), a: card('a', 'lichuang', 5) };
    const t = team([{ cardInstanceId: 'b', col: 0, row: 0 }, { cardInstanceId: 'a', col: 1, row: 0 }]);
    expect(resolveLeaderUnitType(t, inv, EMPTY_EQUIP)).toBe('infantry');
  });
});
