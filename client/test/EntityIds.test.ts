import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { Building } from '../src/game/Building';
import { Side, UnitType, BuildingType } from '../src/game/types';

// Buildings take ids [0, 1000) and units take [1000, ∞). The two namespaces must
// never overlap, and the counters must reset each game so the id stream is
// reproducible across engine instances (required for deterministic replay).
describe('entity id namespaces', () => {
  it('buildings start at 0 and units at 1000 (non-overlapping ranges)', () => {
    new GameState(1); // GameState constructor resets both counters
    const b0 = new Building(BuildingType.Barracks, Side.Bottom, 0, 0);
    const b1 = new Building(BuildingType.ArrowTower, Side.Bottom, 1, 0);
    const u0 = new Unit(UnitType.Infantry, Side.Bottom, 0, 1);
    const u1 = new Unit(UnitType.Infantry, Side.Bottom, 1, 1);

    expect(b0.id).toBe(0);
    expect(b1.id).toBe(1);
    expect(u0.id).toBe(1000);
    expect(u1.id).toBe(1001);
    expect(b1.id).toBeLessThan(u0.id);
  });

  it('GameState constructor resets id counters for reproducibility across games', () => {
    new GameState(1);
    const firstUnitOfGameA = new Unit(UnitType.Infantry, Side.Bottom, 0, 1);
    new Unit(UnitType.Infantry, Side.Bottom, 0, 1);
    new Unit(UnitType.Infantry, Side.Bottom, 0, 1);

    new GameState(2); // new game → counters reset
    const firstUnitOfGameB = new Unit(UnitType.Infantry, Side.Bottom, 0, 1);

    expect(firstUnitOfGameB.id).toBe(firstUnitOfGameA.id);
    expect(firstUnitOfGameB.id).toBe(1000);
  });
});
