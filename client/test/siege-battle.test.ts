// G3-2a Siege auto-battle: attacker pre-placement + defender garrison + hard time-limit deterministic engine (SLG_DESIGN §16).
//
// Lock model (§16.1): no live commands; key siege = deterministic auto-battle from both sides' pre-placed units.
// Troop strength = unit HP (initialHp); each side has a base — whoever destroys the enemy base wins;
// timeout (both bases still standing) → attacker loses (defender advantage).
// Battle is uniquely determined by seed + both army layouts → server runs authoritatively; client replays with seed.
//
// Test coverage: ① same layout + same seed → identical per-tick result (both-base HP trace matches byte-for-byte + same outcome);
//               ② base-destruction win (attacker army razes defender's base → owner0 wins);
//               ③ timeout defender win (cannot destroy base + battleTimeoutTicks → owner1 wins);
//               ④ hard guardrail: after creating siege engine, PvP blueprints still equal constants byte-for-byte; initialHp does not leak back.
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

/** Run to game-over (pre-placed both sides, no live commands); returns the actual tick count. */
function driveToEnd(engine: IGameEngine, maxTicks: number): number {
  let i = 0;
  for (; i < maxTicks && engine.state.phase !== GameOver; i++) engine.tick(TICK_DT);
  return i;
}

/** Sample both bases' HP every tick as a determinism fingerprint. */
function baseHpTrace(engine: IGameEngine, maxTicks: number): string[] {
  const trace: string[] = [];
  for (let i = 0; i < maxTicks && engine.state.phase !== GameOver; i++) {
    engine.tick(TICK_DT);
    trace.push(`${engine.state.bottomPlayer.baseHp}/${engine.state.topPlayer.baseHp}`);
  }
  return trace;
}

/**
 * A siege auto-battle level: attacker pre-placed army (Bottom) + defender garrison (Top) + destroy_base + time limit.
 * Directly constructs a LevelDefinition (same shape as buildSiegeBattle); waves are empty — pure pre-placement, no script.
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

describe('Siege auto-battle — determinism (§16.1, same layout + same seed)', () => {
  it('per-tick both-base HP trace matches byte-for-byte + same game outcome', () => {
    const SEED = 0x5126ab;
    const level = battleLevel({
      seed: SEED,
      // Attacker army: infantry + archers on two lanes, forcing combat RNG (target selection / prng).
      attackerArmy: [
        { unitType: UnitType.Infantry, col: 2, row: 8, initialHp: 50 },
        { unitType: UnitType.Archer, col: 3, row: 7 },
        { unitType: UnitType.Infantry, col: 9, row: 8 },
      ],
      // Defender garrison: counter-charge to force an engagement.
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

  it('initialHp sets the unit starting HP (capped at max capacity)', () => {
    // Infantry max HP is 60; assign 50 troops → enters battle at 50 HP; assign 999 → capped to max 60.
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
    expect(byCol(3).hp).toBe(UNIT_BLUEPRINTS[UnitType.Infantry].hp); // 999 capped to max HP
  });
});

describe('Siege auto-battle — win/loss paths (§16.1)', () => {
  it('base-destruction win: attacker army razes defender base → owner0 (attacker) wins', () => {
    // 10 infantry placed on all 10 lanes adjacent to the defender's base (no garrison blocking).
    // Each unit deals attack(12) upon reaching the base column then dies; 10×12=120 > 100 HP base → fast destroy, well before timeout.
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
    expect(ran).toBeLessThan(18000); // base destroyed well before the timeout
  });

  it('timeout defender win: both bases survive to time limit → owner1 (defender) wins', () => {
    // No attacker army → nobody can hit anyone; at battleTimeoutTicks both bases still stand → defender advantage.
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
    expect(ran).toBeLessThan(80); // defeat declared immediately at timeout, no idle spinning
  });
});

describe('Siege auto-battle — ladder guardrail must not break (§16.6)', () => {
  it('after creating the siege engine (with initialHp attacker army), PvP blueprints still equal constants byte-for-byte', () => {
    const level = battleLevel({
      seed: 7,
      attackerArmy: [{ unitType: UnitType.Infantry, col: 2, row: 8, initialHp: 50 }],
      battleTimeoutTicks: 100,
    });
    createGameEngine(siegeConfig(level));
    // initialHp only takes effect on the Unit instance; it must never be written back into blueprint constants.
    expect(buildPvpBlueprints()).toEqual(UNIT_BLUEPRINTS);
  });
});
