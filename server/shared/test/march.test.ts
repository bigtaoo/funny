import { describe, expect, it } from 'vitest';
import {
  MARCH_MORALE_MAX,
  MARCH_MORALE_COMBAT_FLOOR,
  marchMoraleFromPath,
  moraleCombatMultiplier,
  type PathCell,
} from '../src/slg';

function pathOfLength(n: number): PathCell[] {
  // Content doesn't matter to marchMoraleFromPath, only path.length (tiles moved = length - 1).
  return Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));
}

describe('marchMoraleFromPath', () => {
  it('same-tile path (length 1, 0 tiles moved) costs no morale', () => {
    expect(marchMoraleFromPath(pathOfLength(1))).toBe(MARCH_MORALE_MAX);
  });

  it('costs 1 morale per tile moved', () => {
    expect(marchMoraleFromPath(pathOfLength(2))).toBe(MARCH_MORALE_MAX - 1); // 1 tile moved
    expect(marchMoraleFromPath(pathOfLength(51))).toBe(MARCH_MORALE_MAX - 50); // 50 tiles moved
  });

  it('floors at 0 for paths longer than MARCH_MORALE_MAX tiles — never goes negative', () => {
    expect(marchMoraleFromPath(pathOfLength(MARCH_MORALE_MAX + 1))).toBe(0); // exactly 100 tiles moved
    expect(marchMoraleFromPath(pathOfLength(500))).toBe(0); // far beyond the cap
  });

  it('an empty path (defensive edge case) does not go negative', () => {
    expect(marchMoraleFromPath([])).toBe(MARCH_MORALE_MAX);
  });
});

describe('moraleCombatMultiplier', () => {
  it('full morale → full combat power (1.0)', () => {
    expect(moraleCombatMultiplier(MARCH_MORALE_MAX)).toBe(1);
  });

  it('zero morale → the combat-power floor (0.7), never worse', () => {
    expect(moraleCombatMultiplier(0)).toBe(MARCH_MORALE_COMBAT_FLOOR);
  });

  it('scales linearly between the floor and full strength', () => {
    expect(moraleCombatMultiplier(50)).toBeCloseTo(0.85, 10); // 0.7 + 0.3 * 0.5
    expect(moraleCombatMultiplier(80)).toBeCloseTo(0.94, 10); // 0.7 + 0.3 * 0.8
  });

  it('clamps out-of-range input instead of extrapolating past the floor/ceiling', () => {
    expect(moraleCombatMultiplier(-20)).toBe(MARCH_MORALE_COMBAT_FLOOR); // negative morale clamps to 0
    expect(moraleCombatMultiplier(MARCH_MORALE_MAX + 50)).toBe(1); // over-cap morale clamps to MARCH_MORALE_MAX
  });

  it('composes with marchMoraleFromPath end-to-end: a 50-tile march fights at 85% strength', () => {
    const morale = marchMoraleFromPath(pathOfLength(51));
    expect(moraleCombatMultiplier(morale)).toBeCloseTo(0.85, 10);
  });
});
