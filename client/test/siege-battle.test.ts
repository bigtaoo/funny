// G3-2a 围攻自动战斗：攻方预布军 + 守方布阵 + 战斗硬时限的确定性引擎（SLG_DESIGN §16）。
//
// 锁定模型（§16.1）：放弃手操，关键围攻 = 双方预布兵的确定性自动战斗。兵力 = 单位血量
// （initialHp），双方各有基地，破敌基地者胜，超时（双基地皆存）进攻方负（防守占优）。
// 战斗由 seed + 双方布阵唯一确定 → 服务器跑权威、客户端 seed 重播观战。
//
// 本测覆盖：①同布阵 + 同 seed → 逐 tick 同终局（双基地 HP 序列逐字一致 + 终局一致）；
//          ②破基地胜（攻方军推平守方基地 → owner0 胜）；
//          ③超时防守胜（无法破基 + battleTimeoutTicks → owner1 胜）；
//          ④硬墙 + 金回放不破（建围攻引擎后 PvP 蓝图仍逐字等于常量；initialHp 不外泄）。
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { Side, GamePhase, UnitType } from '../src/game/types';
import type { GameConfig, IGameEngine, OwnerId } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { buildPvpBlueprints } from '../src/game/balance/pveUpgrades';

const TICK_DT = 1 / 30;
const GameOver = GamePhase.GameOver;

function winnerOf(engine: IGameEngine): OwnerId | null {
  const w = engine.state.winner;
  return w === Side.Top ? 1 : w === Side.Bottom ? 0 : null;
}

/** 跑到终局（pre-placed 双方，无 live 指令）；返回实跑 ticks。 */
function driveToEnd(engine: IGameEngine, maxTicks: number): number {
  let i = 0;
  for (; i < maxTicks && engine.state.phase !== GameOver; i++) engine.tick(TICK_DT);
  return i;
}

/** 逐 tick 采样双基地 HP，作为确定性指纹。 */
function baseHpTrace(engine: IGameEngine, maxTicks: number): string[] {
  const trace: string[] = [];
  for (let i = 0; i < maxTicks && engine.state.phase !== GameOver; i++) {
    engine.tick(TICK_DT);
    trace.push(`${engine.state.bottomPlayer.baseHp}/${engine.state.topPlayer.baseHp}`);
  }
  return trace;
}

/**
 * 一份围攻自动战斗关卡：攻方预布军（Bottom）+ 守方预布军（Top）+ destroy_base + 时限。
 * 直接构造 LevelDefinition（与 buildSiegeBattle 同形态），波次为空——纯预布兵，无脚本。
 */
function battleLevel(opts: {
  seed: number;
  attackerArmy?: LevelDefinition['attackerArmy'];
  garrison?: LevelDefinition['garrison'];
  battleTimeoutTicks?: number;
}): LevelDefinition {
  return {
    id: `siege_battle_${opts.seed}`,
    chapter: 0,
    seed: opts.seed,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    attackerArmy: opts.attackerArmy,
    garrison: opts.garrison,
    battleTimeoutTicks: opts.battleTimeoutTicks,
  };
}

function siegeConfig(level: LevelDefinition): GameConfig {
  return { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level };
}

describe('围攻自动战斗 — 确定性（§16.1，同布阵 + 同 seed）', () => {
  it('逐 tick 双基地 HP 序列逐字一致 + 同终局', () => {
    const SEED = 0x5126ab;
    const level = battleLevel({
      seed: SEED,
      // 攻方军：双 lane 步兵 + 弓手，逼出战斗 RNG（目标选择 / prng）。
      attackerArmy: [
        { unitType: UnitType.Infantry, col: 2, row: 8, initialHp: 50 },
        { unitType: UnitType.Archer, col: 3, row: 7 },
        { unitType: UnitType.Infantry, col: 9, row: 8 },
      ],
      // 守方军：对冲，制造交火。
      garrison: [
        { unitType: UnitType.Infantry, col: 2, row: 11 },
        { unitType: UnitType.ShieldBearer, col: 9, row: 11, initialHp: 120 },
      ],
      battleTimeoutTicks: 18000,
    });

    const a = createGameEngine(siegeConfig(level));
    const b = createGameEngine(siegeConfig(level));
    const traceA = baseHpTrace(a, 18000);
    const traceB = baseHpTrace(b, 18000);

    expect(a.state.phase).toBe(GameOver);
    expect(b.state.phase).toBe(GameOver);
    expect(traceA).toEqual(traceB);
    expect(winnerOf(a)).toBe(winnerOf(b));
    expect(a.state.snapshotStats()).toEqual(b.state.snapshotStats());
  });

  it('initialHp 决定单位出战血量（≤ 满血容量）', () => {
    // 步兵满血 60；分配 50 兵 → 以 50 血出战；分配 999 → 截到满血 60。
    const level = battleLevel({
      seed: 1,
      attackerArmy: [
        { unitType: UnitType.Infantry, col: 2, row: 8, initialHp: 50 },
        { unitType: UnitType.Infantry, col: 3, row: 8, initialHp: 999 },
      ],
      battleTimeoutTicks: 30,
    });
    const eng = createGameEngine(siegeConfig(level)) as unknown as {
      state: { board: { units: Map<number, { unitType: UnitType; hp: number; maxHp: number; col: number }> } };
    };
    const placed = [...eng.state.board.units.values()].filter((u) => u.unitType === UnitType.Infantry);
    const byCol = (c: number) => placed.find((u) => u.col === c)!;
    expect(byCol(2).hp).toBe(50);
    expect(byCol(2).maxHp).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].hp);
    expect(byCol(3).hp).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].hp); // 999 截到满血
  });
});

describe('围攻自动战斗 — 胜负两路（§16.1）', () => {
  it('破基地胜：攻方军推平守方基地 → owner0（攻方）胜', () => {
    // 满 10 lane 步兵贴近守方基地（无守军阻挡）。每兵到基地列扣 attack(12) 并阵亡，
    // 10×12=120 > 100 HP 基地 → 速破，远早于时限。
    const ATTACK_LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    const level = battleLevel({
      seed: 0xbada55,
      attackerArmy: ATTACK_LANES.map((col) => ({ unitType: UnitType.Infantry, col, row: 15 })),
      battleTimeoutTicks: 18000,
    });
    const eng = createGameEngine(siegeConfig(level));
    const ran = driveToEnd(eng, 18000);
    expect(eng.state.phase).toBe(GameOver);
    expect(winnerOf(eng)).toBe(0);
    expect(eng.state.topPlayer.isDead).toBe(true);
    expect(ran).toBeLessThan(18000); // 远早于时限即破基
  });

  it('超时防守胜：双基地皆存到时限 → owner1（防守方）胜', () => {
    // 无攻方军 → 谁也打不到谁；到 battleTimeoutTicks 双基地皆存 → 防守占优。
    const level = battleLevel({
      seed: 0xdefdef,
      attackerArmy: [],
      garrison: [],
      battleTimeoutTicks: 60,
    });
    const eng = createGameEngine(siegeConfig(level));
    const ran = driveToEnd(eng, 18000);
    expect(eng.state.phase).toBe(GameOver);
    expect(winnerOf(eng)).toBe(1);
    expect(eng.state.bottomPlayer.isDead).toBe(false);
    expect(eng.state.topPlayer.isDead).toBe(false);
    expect(ran).toBeGreaterThanOrEqual(60);
    expect(ran).toBeLessThan(80); // 时限即刻判负，不空转
  });
});

describe('围攻自动战斗 — 天梯红线不破（§16.6 护栏）', () => {
  it('建围攻引擎（含 initialHp 攻方军）后，PvP 蓝图仍逐字等于常量', () => {
    const level = battleLevel({
      seed: 7,
      attackerArmy: [{ unitType: UnitType.Infantry, col: 2, row: 8, initialHp: 50 }],
      battleTimeoutTicks: 100,
    });
    createGameEngine(siegeConfig(level));
    // initialHp 只在 Unit 实例上生效，绝不回灌蓝图常量。
    expect(buildPvpBlueprints()).toEqual(UNIT_BLUEPRINTS);
  });
});
