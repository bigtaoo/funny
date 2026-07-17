import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { Building } from '../src/game/Building';
import { Side, UnitType, BuildingType } from '../src/game/types';

// Buildings take ids [0, 1000) and units take [1000, ∞). The two namespaces must
// never overlap, and each GameState owns its own counters (allocBuildingId /
// allocUnitId) so the id stream is reproducible across engine instances
// (required for deterministic replay) without a mid-match second GameState
// clobbering a live match's ids — see GameState.ts for the ghost-entity history.
describe('entity id namespaces', () => {
  it('buildings start at 0 and units at 1000 (non-overlapping ranges)', () => {
    const gs = new GameState(1);
    const b0 = new Building(BuildingType.Barracks, Side.Bottom, 0, 0, undefined, gs.allocBuildingId());
    const b1 = new Building(BuildingType.ArrowTower, Side.Bottom, 1, 0, undefined, gs.allocBuildingId());
    const u0 = new Unit(UnitType.Infantry, Side.Bottom, 0, 1, undefined, undefined, gs.allocUnitId());
    const u1 = new Unit(UnitType.Infantry, Side.Bottom, 1, 1, undefined, undefined, gs.allocUnitId());

    expect(b0.id).toBe(0);
    expect(b1.id).toBe(1);
    expect(u0.id).toBe(1000);
    expect(u1.id).toBe(1001);
    expect(b1.id).toBeLessThan(u0.id);
  });

  it('each GameState owns its own id counters, independent of other instances', () => {
    const gsA = new GameState(1);
    const firstUnitOfGameA = new Unit(UnitType.Infantry, Side.Bottom, 0, 1, undefined, undefined, gsA.allocUnitId());
    new Unit(UnitType.Infantry, Side.Bottom, 0, 1, undefined, undefined, gsA.allocUnitId());
    new Unit(UnitType.Infantry, Side.Bottom, 0, 1, undefined, undefined, gsA.allocUnitId());

    const gsB = new GameState(2); // separate instance → its own counter, starting fresh
    const firstUnitOfGameB = new Unit(UnitType.Infantry, Side.Bottom, 0, 1, undefined, undefined, gsB.allocUnitId());

    expect(firstUnitOfGameB.id).toBe(firstUnitOfGameA.id);
    expect(firstUnitOfGameB.id).toBe(1000);
  });
});
