import { describe, it, expect } from 'vitest';
import { GameState } from '../src/game/GameState';
import { Unit } from '../src/game/Unit';
import { Building } from '../src/game/Building';
import { CombatSystem } from '../src/game/systems/CombatSystem';
import { SpellSystem } from '../src/game/systems/SpellSystem';
import { ATTACK_MULT_THRESHOLD_TICKS, UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../src/game/config';
import { Side, UnitType, BuildingType, UnitState, SpellType } from '../src/game/types';
import { achievementStatDelta } from '../src/game';

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
    // S9-3b: per-victim-type tally — the slain unit was an Archer.
    expect(state.stats[0].killsByType[UnitType.Archer]).toBe(1);
    expect(state.stats[0].killsByType[UnitType.ShieldBearer]).toBeUndefined();
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

describe('成就分类型埋点（S9-3b / S9-6）', () => {
  it('castMeteor 累加 castsByType[Meteor]（按释放次数，非命中数）', () => {
    const state = new GameState(1);
    const spells = new SpellSystem();
    // 空场释放两次陨石：0 命中，但 cast 计数 = 2。
    spells.castMeteor(Side.Bottom, 2, 2, state);
    spells.castMeteor(Side.Bottom, 2, 2, state);
    expect(state.stats[0].castsByType[SpellType.Meteor]).toBe(2);
    expect(state.stats[0].spellHits).toBe(0); // 命中数与释放次数解耦
  });

  it('achievementStatDelta 映射：Archer→kill.archer、ShieldBearer→kill.guard、Meteor→cast.meteor', () => {
    const state = new GameState(1);
    const combat = new CombatSystem();
    const spells = new SpellSystem();
    // 杀一个弓箭手 + 一个盾兵（守卫）。
    const archer = new Unit(UnitType.Archer, Side.Bottom, 0, 5);
    const e1 = new Unit(UnitType.Archer, Side.Top, 0, 6); e1.hp = 1;
    const e2 = new Unit(UnitType.ShieldBearer, Side.Top, 1, 6); e2.hp = 1;
    const archer2 = new Unit(UnitType.Archer, Side.Bottom, 1, 5);
    state.board.addUnit(archer); state.board.addUnit(e1);
    state.board.addUnit(archer2); state.board.addUnit(e2);
    combat.tick(state);
    spells.castMeteor(Side.Bottom, 2, 2, state);

    const delta = achievementStatDelta({ owner: 0, ...state.stats[0] });
    expect(delta['kill.archer']).toBe(1);
    expect(delta['kill.guard']).toBe(1);
    expect(delta['cast.meteor']).toBe(1);
    // 零项不出现（懒创建语义）。
    expect(Object.keys(delta).sort()).toEqual(['cast.meteor', 'kill.archer', 'kill.guard']);
  });

  it('achievementStatDelta 空局 → 空增量', () => {
    expect(achievementStatDelta({ owner: 0, ...new GameState(1).stats[0] })).toEqual({});
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

  it('hits an enemy in Crossing state moving horizontally past the tower', () => {
    const state = new GameState(1);
    const sys = new CombatSystem();
    // A Bottom tower on the home building row; a Top unit crosses sideways along it.
    const tower = new Building(BuildingType.ArrowTower, Side.Bottom, 5, 0);
    const crosser = new Unit(UnitType.Runner, Side.Top, 6, 0); // adjacent, mid-crossing
    crosser.state = UnitState.Crossing;
    state.board.addBuilding(tower);
    state.board.addUnit(crosser);

    const hp0 = crosser.hp;
    sys.tick(state);
    // Targeting is grid/Chebyshev-based and state-agnostic — the crossing enemy
    // is hit (the original forward-only scan would have missed it entirely).
    expect(crosser.hp).toBeLessThan(hp0);
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
