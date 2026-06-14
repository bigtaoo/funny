import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { Building } from '../src/game/Building';
import { CombatSystem } from '../src/game/systems/CombatSystem';
import { ATTACK_MULT_THRESHOLD_TICKS, UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../src/game/config';
import { Side, UnitType, BuildingType, UnitState } from '../src/game/types';

describe('CombatSystem — units', () => {
  it('a unit attacks an enemy directly ahead within range', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    const me = new Unit(UnitType.Infantry, Side.Bottom, 0, 5);
    const enemy = new Unit(UnitType.ShieldBearer, Side.Top, 0, 6); // one row ahead, in melee range
    state.board.addUnit(me);
    state.board.addUnit(enemy);

    const enemyHp0 = enemy.hp;
    sys.tick(state); // cooldown starts at 0 → immediate hit
    expect(me.state).toBe(UnitState.Attacking);
    expect(enemy.hp).toBe(enemyHp0 - UNIT_BLUEPRINTS[UnitType.Infantry].attack);
  });

  it('respects the attack cooldown between hits', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    const me = new Unit(UnitType.Infantry, Side.Bottom, 0, 5);
    const enemy = new Unit(UnitType.ShieldBearer, Side.Top, 0, 6);
    state.board.addUnit(me);
    state.board.addUnit(enemy);

    sys.tick(state); // hit 1
    const hpAfter1 = enemy.hp;
    sys.tick(state); // cooldown — no hit
    expect(enemy.hp).toBe(hpAfter1);

    // After attackIntervalTicks (1.0s = 30 ticks) it hits again.
    for (let i = 0; i < me.attackIntervalTicks; i++) sys.tick(state);
    expect(enemy.hp).toBeLessThan(hpAfter1);
  });

  it('kills a unit at 0 HP, removes it, and credits the kill', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    const me = new Unit(UnitType.Archer, Side.Bottom, 0, 5);
    const enemy = new Unit(UnitType.Archer, Side.Top, 0, 6);
    enemy.hp = 1; // one hit kills
    state.board.addUnit(me);
    state.board.addUnit(enemy);

    sys.tick(state);
    expect(state.board.units.has(enemy.id)).toBe(false);
    expect(state.events.some((e) => e.type === 'unit_died')).toBe(true);
    // Killer is Bottom (owner 0).
    expect(state.stats[0].unitsKilled).toBe(1);
  });

  it('late-game attack multiplier doubles damage', () => {
    const normal = new GameState(1);
    const late = new GameState(1);
    const sys = new CombatSystem();

    const mk = (s: GameState) => {
      const me = new Unit(UnitType.Infantry, Side.Bottom, 0, 5);
      const enemy = new Unit(UnitType.ShieldBearer, Side.Top, 0, 6);
      s.board.addUnit(me);
      s.board.addUnit(enemy);
      return enemy;
    };
    const e1 = mk(normal);
    const e2 = mk(late);
    late.elapsedTicks = ATTACK_MULT_THRESHOLD_TICKS;

    sys.tick(normal);
    sys.tick(late);

    const normalDmg = e1.maxHp - e1.hp;
    const lateDmg = e2.maxHp - e2.hp;
    expect(lateDmg).toBe(normalDmg * 2);
  });
});

describe('CombatSystem — arrow tower (Chebyshev all-direction targeting)', () => {
  it('hits a horizontally-adjacent enemy that a forward-only scan would miss', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    // Tower at (col 5, row 5); enemy 2 cols to the right on the SAME row.
    const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 5);
    const enemy = new Unit(UnitType.ShieldBearer, Side.Top, 7, 5); // dist = 2 (within attackRange 2), purely horizontal
    state.board.addBuilding(tower);
    state.board.addUnit(enemy);

    const hp0 = enemy.hp;
    sys.tick(state); // tower cooldown starts at 0 → fires this tick
    expect(enemy.hp).toBe(hp0 - BUILDING_BLUEPRINTS[BuildingType.ArrowTower].attack!);
  });

  it('does not target out-of-range enemies', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 5);
    const enemy = new Unit(UnitType.ShieldBearer, Side.Top, 5, 9); // dist 4 > range 2
    state.board.addBuilding(tower);
    state.board.addUnit(enemy);

    const hp0 = enemy.hp;
    sys.tick(state);
    expect(enemy.hp).toBe(hp0);
  });
});
