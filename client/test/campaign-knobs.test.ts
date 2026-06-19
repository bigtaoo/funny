/**
 * Tests for §4.8.6 priority-1 campaign knobs:
 *   objective×3 (destroy_base / leak_limit / boss)
 *   activeLanes
 *   inkRegenMult
 *   loadout / bannedCards
 */

import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { CARD_DEFINITIONS, ATTACK_LANES } from '../src/game/config';
import type { GameConfig } from '../src/game/types';
import { Side, UnitType, GamePhase } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

const TICK_DT = 1 / 30;

function makeCampaignConfig(level: LevelDefinition): GameConfig {
  return {
    seed: level.seed,
    players: [{ id: 0 }, { id: 1 }],
    mode: 'campaign',
    level,
  };
}

/** Run the engine for `ticks` steps with no player commands. */
function runTicks(cfg: GameConfig, ticks: number) {
  const engine = createGameEngine(cfg);
  for (let i = 0; i < ticks; i++) engine.tick(TICK_DT);
  return engine;
}

// ── Shared mini-level builder ─────────────────────────────────────────────────

function baseLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'test',
    chapter: 0,
    seed: 1,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// leak_limit objective
// ─────────────────────────────────────────────────────────────────────────────

describe('objective: leak_limit', () => {
  it('game ends (Top wins) once enemyLeaks exceeds maxLeaks', () => {
    // Spawn 3 fast Runners on col 0.  maxLeaks=1 → game should end after
    // the second unit reaches the bottom base.
    const level = baseLevel({
      objective: { kind: 'leak_limit', maxLeaks: 1 },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Runner, col: 0, count: 3, spacingTicks: 60 },
        ],
      },
    });
    // Runners are fast — 600 ticks (20 s) is more than enough.
    const engine = runTicks(makeCampaignConfig(level), 600);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.winner).toBe(Side.Top);
  });

  it('game does NOT end with Top winning when leaks stay at or below maxLeaks', () => {
    // Single Runner with maxLeaks=1 — one leak is allowed, so Top should NOT win
    // solely on that leak.
    const level = baseLevel({
      objective: { kind: 'leak_limit', maxLeaks: 1 },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Runner, col: 0, count: 1 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 900);
    if (engine.state.phase === GamePhase.GameOver) {
      // If the game ended it must be because the base died, not leak_limit.
      expect(engine.state.winner).not.toBe(Side.Top);
    }
  });

  it('enemyLeaks counter increments for every Top unit that reaches the base', () => {
    const level = baseLevel({
      objective: { kind: 'leak_limit', maxLeaks: 100 },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Runner, col: 0, count: 5, spacingTicks: 60 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 1200);
    expect(engine.state.enemyLeaks).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// destroy_base objective
// ─────────────────────────────────────────────────────────────────────────────

describe('objective: destroy_base', () => {
  it('wave exhaustion alone does NOT end the game', () => {
    // Empty wave script → wave director exhausted immediately, no enemies ever
    // spawn → bottom player can never win via wave clearance with destroy_base.
    const level = baseLevel({
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 300);
    expect(engine.state.phase).toBe(GamePhase.Playing);
  });

  it('timed loss: Top wins when durationTicks expires and the enemy base is still standing', () => {
    const level = baseLevel({
      objective: { kind: 'destroy_base', durationTicks: 30 },
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 31);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.winner).toBe(Side.Top);
  });

  it('no timed loss when durationTicks is absent — game stays playing', () => {
    const level = baseLevel({
      objective: { kind: 'destroy_base' },
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 300);
    expect(engine.state.phase).toBe(GamePhase.Playing);
  });

  it('a single enemy that leaks does NOT trigger a Bottom win with destroy_base', () => {
    // After the single enemy walks off the board the wave director is exhausted,
    // but since the objective is destroy_base the engine should still be Playing.
    const level = baseLevel({
      objective: { kind: 'destroy_base' },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 1 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 900);
    // Game must not end with Bottom winning (wave cleared but base not destroyed).
    if (engine.state.phase === GamePhase.GameOver) {
      expect(engine.state.winner).not.toBe(Side.Bottom);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boss objective
// ─────────────────────────────────────────────────────────────────────────────

describe('objective: boss', () => {
  it('boss units are tracked in bossUnitIds after spawning', () => {
    const level = baseLevel({
      objective: { kind: 'boss' },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Ironclad, col: 0, count: 1, isBoss: true },
        ],
      },
    });
    // Run 30 ticks — the boss spawns at tick 5.
    const engine = runTicks(makeCampaignConfig(level), 30);
    expect(engine.state.bossUnitIds.size).toBeGreaterThan(0);
  });

  it('non-boss units are NOT added to bossUnitIds', () => {
    const level = baseLevel({
      objective: { kind: 'boss' },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 2 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    expect(engine.state.bossUnitIds.size).toBe(0);
  });

  it('game does not end while the boss is still alive', () => {
    // Ironclad has very high HP — it should survive 60 ticks without the
    // player dealing any damage.
    const level = baseLevel({
      objective: { kind: 'boss' },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Ironclad, col: 0, count: 1, isBoss: true },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 60);
    expect(engine.state.phase).toBe(GamePhase.Playing);
    expect(engine.state.bossUnitIds.size).toBeGreaterThan(0);
  });

  it('bossUnitIds tracks each individual boss by unit id', () => {
    // Spawn two boss units in different lanes.
    const level = baseLevel({
      objective: { kind: 'boss' },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Ironclad, col: 0, count: 1, isBoss: true },
          { atTick: 5, unitType: UnitType.Ironclad, col: 2, count: 1, isBoss: true },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    expect(engine.state.bossUnitIds.size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inkRegenMult
// ─────────────────────────────────────────────────────────────────────────────

// Level that never auto-ends: destroy_base requires the player to demolish the
// enemy base, so an idle run stays in Playing indefinitely.
function perpetualLevel(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return baseLevel({ objective: { kind: 'destroy_base' }, waves: { entries: [] }, ...overrides });
}

describe('inkRegenMult', () => {
  it('multiplier > 1 makes the bottom player regen ink faster than baseline', () => {
    const engineBase    = createGameEngine(makeCampaignConfig(perpetualLevel()));
    const engineBoosted = createGameEngine(makeCampaignConfig(perpetualLevel({ inkRegenMult: 2.0 })));

    // 90 ticks (3 s) — baseline accrues ~6 ink, boosted ~12.
    for (let i = 0; i < 90; i++) {
      engineBase.tick(TICK_DT);
      engineBoosted.tick(TICK_DT);
    }

    expect(engineBase.state.phase).toBe(GamePhase.Playing);
    expect(engineBoosted.state.bottomPlayer.ink).toBeGreaterThan(
      engineBase.state.bottomPlayer.ink,
    );
  });

  it('multiplier does NOT affect the top (enemy) player', () => {
    const engineBase    = createGameEngine(makeCampaignConfig(perpetualLevel()));
    const engineBoosted = createGameEngine(makeCampaignConfig(perpetualLevel({ inkRegenMult: 3.0 })));

    for (let i = 0; i < 90; i++) {
      engineBase.tick(TICK_DT);
      engineBoosted.tick(TICK_DT);
    }

    expect(engineBoosted.state.topPlayer.ink).toBe(engineBase.state.topPlayer.ink);
  });

  it('multiplier < 1 slows bottom player ink regen', () => {
    const engineBase   = createGameEngine(makeCampaignConfig(perpetualLevel()));
    const engineSlowed = createGameEngine(makeCampaignConfig(perpetualLevel({ inkRegenMult: 0.5 })));

    for (let i = 0; i < 90; i++) {
      engineBase.tick(TICK_DT);
      engineSlowed.tick(TICK_DT);
    }

    expect(engineSlowed.state.bottomPlayer.ink).toBeLessThan(
      engineBase.state.bottomPlayer.ink,
    );
  });

  it('bottomInkRegenMult is stored on GameState', () => {
    const engine = createGameEngine(makeCampaignConfig(perpetualLevel({ inkRegenMult: 1.5 })));
    expect(engine.state.bottomInkRegenMult).toBe(1.5);
  });

  it('default bottomInkRegenMult is 1 when not specified', () => {
    const engine = createGameEngine(makeCampaignConfig(perpetualLevel()));
    expect(engine.state.bottomInkRegenMult).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activeLanes
// ─────────────────────────────────────────────────────────────────────────────

describe('activeLanes', () => {
  it('enemy spawns are limited to activeLanes — entries on other lanes are ignored', () => {
    const level = baseLevel({
      board: { activeLanes: [0] },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 2 },
          { atTick: 5, unitType: UnitType.Infantry, col: 1, count: 2 },
          { atTick: 5, unitType: UnitType.Infantry, col: 2, count: 2 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    const enemies = Array.from(engine.state.board.units.values())
      .filter((u) => u.side === Side.Top);

    // Only the two col-0 entries should have spawned.
    expect(enemies.length).toBe(2);
    for (const u of enemies) {
      expect(u.col).toBe(0);
    }
  });

  it('no enemies spawn at all when activeLanes is empty (edge case)', () => {
    const level = baseLevel({
      board: { activeLanes: [] },
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 3 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    const enemies = Array.from(engine.state.board.units.values())
      .filter((u) => u.side === Side.Top);
    expect(enemies.length).toBe(0);
  });

  it('all waves spawn normally when activeLanes is not set', () => {
    const level = baseLevel({
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 2 },
          { atTick: 5, unitType: UnitType.Infantry, col: 1, count: 2 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    const enemies = Array.from(engine.state.board.units.values())
      .filter((u) => u.side === Side.Top);
    // Both lanes should have spawned.
    expect(enemies.length).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadout / bannedCards
// ─────────────────────────────────────────────────────────────────────────────

describe('loadout / bannedCards', () => {
  it('loadout restricts the card pool to the given card ids', () => {
    // Use a single-card loadout.
    const onlyCard = CARD_DEFINITIONS[0]!;
    const level    = baseLevel({ loadout: [onlyCard.id] });
    // Run 600 ticks for many automatic card refreshes.
    const engine = runTicks(makeCampaignConfig(level), 600);

    for (const slot of engine.state.bottomPlayer.hand.slots) {
      if (slot !== null) {
        expect(slot.card.id).toBe(onlyCard.id);
      }
    }
  });

  it('bannedCards removes the specified card from the pool', () => {
    const bannedCard = CARD_DEFINITIONS[0]!;
    const level      = baseLevel({ bannedCards: [bannedCard.id] });
    // Run long enough for a large number of refresh cycles.
    const engine = runTicks(makeCampaignConfig(level), 1800);

    for (const slot of engine.state.bottomPlayer.hand.slots) {
      if (slot !== null) {
        expect(slot.card.id).not.toBe(bannedCard.id);
      }
    }
  });

  it('banning all cards falls back to the full pool without crashing', () => {
    const allIds = CARD_DEFINITIONS.map((c) => c.id);
    const level  = baseLevel({ bannedCards: allIds });
    expect(() => runTicks(makeCampaignConfig(level), 30)).not.toThrow();
  });

  it('no loadout/bannedCards — engine draws from the full pool', () => {
    // The draw policy should not crash and cards should appear.
    const engine = runTicks(makeCampaignConfig(baseLevel()), 600);
    const hasCards = engine.state.bottomPlayer.hand.slots.some((s) => s !== null);
    expect(hasCards).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// escort objective
// ─────────────────────────────────────────────────────────────────────────────

describe('objective: escort', () => {
  it('escort_spawned events are emitted on the first tick for each escort', () => {
    const level = baseLevel({
      objective: { kind: 'escort', required: 'any' },
      escorts: [
        { id: 'e1', hp: 100, speed: 1, startCol: 0, startRow: 1 },
        { id: 'e2', hp: 100, speed: 1, startCol: 2, startRow: 1 },
      ],
      waves: { entries: [] },
    });
    const engine = createGameEngine(makeCampaignConfig(level));
    engine.tick(TICK_DT);
    const spawned = engine.state.events.filter((e) => e.type === 'escort_spawned');
    expect(spawned).toHaveLength(2);
  });

  it('game ends (Bottom wins) when a required escort reaches the enemy base', () => {
    // Escort placed 1 row from TOP_BUILDING_ROW (row 17), speed=5 → arrives in ~7 ticks.
    const level = baseLevel({
      objective: { kind: 'escort', required: 'any' },
      escorts: [{ id: 'e1', hp: 100, speed: 5, startCol: 0, startRow: 16 }],
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.winner).toBe(Side.Bottom);
  });

  it('game is still Playing while the escort has not yet arrived', () => {
    // Very slow escort starting far from the enemy base.
    const level = baseLevel({
      objective: { kind: 'escort', required: 'any' },
      escorts: [{ id: 'e1', hp: 100, speed: 0.05, startCol: 0, startRow: 0 }],
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 10);
    expect(engine.state.phase).toBe(GamePhase.Playing);
  });

  it('game ends (Top wins) when all escorts die before arriving (required=all)', () => {
    // Infantry spawns at TOP_SPAWN_ROW (row 16), escort at row 15 (1 row below) →
    // Infantry range=1 can target the escort. Escort hp=1 dies in one hit.
    const level = baseLevel({
      objective: { kind: 'escort', required: 'all' },
      escorts: [{ id: 'e1', hp: 1, speed: 0.01, startCol: 0, startRow: 15 }],
      waves: {
        entries: [
          { atTick: 5, unitType: UnitType.Infantry, col: 0, count: 1 },
        ],
      },
    });
    const engine = runTicks(makeCampaignConfig(level), 120);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.winner).toBe(Side.Top);
  });

  it('escort status transitions: moving → arrived', () => {
    const level = baseLevel({
      objective: { kind: 'escort', required: 'all' },
      escorts: [{ id: 'e1', hp: 100, speed: 5, startCol: 0, startRow: 16 }],
      waves: { entries: [] },
    });
    const engine = runTicks(makeCampaignConfig(level), 30);
    const escort = engine.state.escorts[0]!;
    expect(escort.status).toBe('arrived');
  });
});
