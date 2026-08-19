// Golden replay harness — scenario catalog.
//
// Each scenario is a deterministic (config, scripted commands, driveMode) triple
// covering one corner of the GameEngine mixin chain this harness protects during
// the setup/sim/driver split (claudedocs/server.md "engine/GameEngine"):
//   - pvp / netplay / campaign / siege modes (engine/setup/buildCtx.ts branches)
//   - AI-driven Top (pvp) vs externally-driven-both-sides (netplay/siege)
//   - every WaveDirector objective kind (survive/timed_defense/destroy_base/leak_limit/boss/escort)
//   - scripted play_card / upgrade_base / refresh_hand commands (engine/sim/commands.ts)
//   - hand-refresh timer expiry, base upgrades, spell casts (engine/sim/hand.ts tickHandRefresh)
//   - both drive paths: step()-loop (sim only) and tick(dt)-loop (sim + driver)
import type { GameConfig, PlayerCommand } from '../../types';
import type { LevelDefinition } from '../../campaign/LevelDefinition';
import { ATTACK_LANES, TOP_SPAWN_ROW } from '../../config';
import { BuildingType, UnitType } from '../../types';

export type DriveMode = 'step' | 'tick';

export interface Scenario {
  name: string;
  config: GameConfig;
  /** Ticks to run (step-loop) or render frames at a fixed 1/30s dt (tick-loop). */
  maxTicks: number;
  driveMode: DriveMode;
  /** Scripted external commands, keyed by owner. Pure function of tick — no RNG, no Date. */
  scriptedCommands?: (tick: number) => PlayerCommand[];
}

/**
 * Deterministic "bot hand" — NOT AISystem. Used to script owner 0 (and, for
 * netplay, owner 1 too) so sim/commands.ts's full surface (play_card for all three
 * CardTypes, upgrade_base, refresh_hand) gets exercised every scenario, driven
 * purely by `tick % N` so it's reproducible without consulting engine state.
 */
function scriptedHandCommands(owner: 0 | 1, tick: number): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  const lane = ATTACK_LANES[tick % ATTACK_LANES.length]!;
  if (tick > 0 && tick % 37 === 0) {
    // Try slot 0 first, then walk the hand — processCommand no-ops if unaffordable/empty.
    cmds.push({ type: 'play_card', owner, tick, handIndex: tick % 6, col: lane, row: undefined });
  }
  if (tick > 0 && tick % 131 === 0) {
    cmds.push({ type: 'upgrade_base', owner, tick });
  }
  if (tick > 0 && tick % 281 === 0) {
    cmds.push({ type: 'refresh_hand', owner, tick });
  }
  return cmds;
}

const PVP_TICKS = 900; // 30s @ 30Hz — enough for several card plays + one upgrade + a refresh_hand

const SIEGE_TIMEOUT_LEVEL: LevelDefinition = {
  id: 'golden_siege_timeout',
  chapter: 0,
  seed: 21,
  objective: { kind: 'destroy_base' },
  waves: { entries: [] },
  battleTimeoutTicks: 200,
};

const SIEGE_DESTROY_BASE_LEVEL: LevelDefinition = {
  id: 'golden_siege_destroy_base',
  chapter: 0,
  seed: 22,
  objective: { kind: 'destroy_base' },
  waves: { entries: [] },
  battleTimeoutTicks: 18000,
  attackerArmy: [
    { unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, row: TOP_SPAWN_ROW, initialHp: 60 },
    { unitType: UnitType.Archer, col: ATTACK_LANES[1]!, row: TOP_SPAWN_ROW, initialHp: 40 },
  ],
  defenderBaseHp: 40,
  defenderBaseLevel: 1,
  garrison: [{ unitType: UnitType.Infantry, col: ATTACK_LANES[2]!, row: 15 }],
  defenderBuildings: [{ buildingType: BuildingType.ArrowTower, col: ATTACK_LANES[3]! }],
};

/**
 * ADR-069 pin: ONE attacker unit carrying 10× the SIEGE_TROOPS_PER_UNIT reference load (600 troops)
 * walks an empty board and destroys a 100-HP base with a single arrival hit — 11 × 600/60 = 110 siege
 * damage. Deliberately garrison-free so the base hit is guaranteed to happen: the two pre-existing siege
 * scenarios both end with `damageDealtToBase: 0` (their attackers die en route), so neither can pin
 * troop-scaled base damage at all. Before ADR-069 this same setup ended as a DEFENDER win — the lone unit
 * dealt a flat 11, despawned on arrival, and the "attacker army fully wiped" early-exit fired with the
 * base still at 89 HP.
 */
const SIEGE_TROOP_SCALED_BASE_HIT_LEVEL: LevelDefinition = {
  id: 'golden_siege_troop_scaled_base_hit',
  chapter: 0,
  seed: 28,
  objective: { kind: 'destroy_base' },
  waves: { entries: [] },
  battleTimeoutTicks: 600,
  attackerArmy: [
    { unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, row: 3, initialHp: 600 },
  ],
  defenderBaseHp: 100,
};

const CAMPAIGN_TIMED_DEFENSE_LEVEL: LevelDefinition = {
  id: 'golden_campaign_timed_defense',
  chapter: 0,
  seed: 23,
  objective: { kind: 'timed_defense', durationTicks: 400 },
  waves: { entries: [
    { atTick: 30, unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, count: 3, spacingTicks: 15 },
    { atTick: 120, unitType: UnitType.Archer, col: ATTACK_LANES[4]!, count: 2, spacingTicks: 20 },
  ] },
};

const CAMPAIGN_LEAK_LIMIT_LEVEL: LevelDefinition = {
  id: 'golden_campaign_leak_limit',
  chapter: 0,
  seed: 24,
  objective: { kind: 'leak_limit', maxLeaks: 0 },
  waves: { entries: [{ atTick: 1, unitType: UnitType.Runner, col: ATTACK_LANES[0]!, count: 1 }] },
  board: { laneLength: { [ATTACK_LANES[0]!]: 17 } },
};

const CAMPAIGN_BOSS_LEVEL: LevelDefinition = {
  id: 'golden_campaign_boss',
  chapter: 0,
  seed: 25,
  objective: { kind: 'boss' },
  waves: { entries: [{ atTick: 1, unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, count: 1, isBoss: true }] },
  board: { laneLength: { [ATTACK_LANES[0]!]: 2 } }, // boss spawns right next to the player base
};

const CAMPAIGN_ESCORT_LEVEL: LevelDefinition = {
  id: 'golden_campaign_escort',
  chapter: 0,
  seed: 26,
  objective: { kind: 'escort', required: 'all' },
  waves: { entries: [] },
  escorts: [
    { id: 'e1', hp: 100, speed: 2, startCol: ATTACK_LANES[0]!, startRow: 2 },
    { id: 'e2', hp: 100, speed: 2, startCol: ATTACK_LANES[5]!, startRow: 2 },
  ],
};

const CAMPAIGN_SPELLS_LEVEL: LevelDefinition = {
  id: 'golden_campaign_spells',
  chapter: 0,
  seed: 27,
  objective: { kind: 'survive' },
  waves: { entries: [
    { atTick: 10, unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, count: 4, spacingTicks: 5 },
  ] },
  levelSpells: [
    { cardId: 'rockslide', initialCount: 1 },
    { cardId: 'bridge_collapse', initialCount: 1 },
  ],
};

function spellScript(tick: number): PlayerCommand[] {
  if (tick === 20) {
    return [{ type: 'play_card', owner: 0, tick, handIndex: 0, col: ATTACK_LANES[0], row: TOP_SPAWN_ROW - 1 }];
  }
  if (tick === 40) {
    return [{ type: 'play_card', owner: 0, tick, handIndex: 1, col: ATTACK_LANES[0] }];
  }
  return [];
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'pvp_ai_vs_scripted_bottom',
    config: { seed: 100, mode: 'pvp', difficulty: 7, players: [{ id: 0 }, { id: 1 }] },
    maxTicks: PVP_TICKS,
    driveMode: 'step',
    scriptedCommands: (tick) => scriptedHandCommands(0, tick),
  },
  {
    name: 'pvp_ai_vs_scripted_bottom_tick_driver',
    // Same config as above, driven through tick(dt) instead of step() directly — freezes the
    // real-time accumulator/catch-up wrapper's output, not just the sim layer's.
    config: { seed: 100, mode: 'pvp', difficulty: 7, players: [{ id: 0 }, { id: 1 }] },
    maxTicks: PVP_TICKS,
    driveMode: 'tick',
    scriptedCommands: (tick) => scriptedHandCommands(0, tick),
  },
  {
    name: 'netplay_both_sides_scripted',
    config: { seed: 101, mode: 'netplay', players: [{ id: 0 }, { id: 1 }] },
    maxTicks: PVP_TICKS,
    driveMode: 'step',
    scriptedCommands: (tick) => [...scriptedHandCommands(0, tick), ...scriptedHandCommands(1, tick)],
  },
  {
    name: 'pvp_with_decks',
    config: {
      seed: 102,
      mode: 'pvp',
      players: [{ id: 0 }, { id: 1 }],
      decks: { bottom: ['infantry_1', 'archer_1', 'tower_1'], top: ['infantry_1', 'runner'] },
    },
    maxTicks: 600,
    driveMode: 'step',
    scriptedCommands: (tick) => scriptedHandCommands(0, tick),
  },
  {
    name: 'siege_destroy_base_full',
    config: { seed: 22, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level: SIEGE_DESTROY_BASE_LEVEL },
    // The level's own battleTimeoutTicks (18000, the real 10-min cap) is deliberately NOT
    // used here — the attacker wipeout early-exit resolves this well under 200 ticks (see
    // gameEngine.test.ts's equivalent case), and runScenario doesn't stop early at GameOver
    // (by design — it also pins the idempotent-after-GameOver [] return), so a maxTicks this
    // large would just inflate the fixture with ~18000 near-identical trailing hashes.
    maxTicks: 300,
    driveMode: 'step',
  },
  {
    name: 'siege_timeout_defender_wins',
    config: { seed: 21, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level: SIEGE_TIMEOUT_LEVEL },
    maxTicks: 250,
    driveMode: 'step',
  },
  {
    name: 'siege_troop_scaled_base_hit',
    config: { seed: 28, mode: 'siege', players: [{ id: 0 }, { id: 1 }], level: SIEGE_TROOP_SCALED_BASE_HIT_LEVEL },
    // ~14 rows of walking at 1.4 grid/s ≈ 300 ticks, plus headroom for the post-GameOver idempotence pin.
    maxTicks: 450,
    driveMode: 'step',
  },
  {
    name: 'campaign_timed_defense',
    config: { seed: 23, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: CAMPAIGN_TIMED_DEFENSE_LEVEL },
    maxTicks: 450,
    driveMode: 'step',
    scriptedCommands: (tick) => scriptedHandCommands(0, tick),
  },
  {
    name: 'campaign_leak_limit',
    config: { seed: 24, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: CAMPAIGN_LEAK_LIMIT_LEVEL },
    maxTicks: 150,
    driveMode: 'step',
  },
  {
    name: 'campaign_boss',
    config: { seed: 25, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: CAMPAIGN_BOSS_LEVEL },
    maxTicks: 300,
    driveMode: 'step',
    scriptedCommands: (tick) => scriptedHandCommands(0, tick),
  },
  {
    name: 'campaign_escort',
    config: { seed: 26, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: CAMPAIGN_ESCORT_LEVEL },
    maxTicks: 200,
    driveMode: 'step',
  },
  {
    name: 'campaign_spells',
    config: { seed: 27, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level: CAMPAIGN_SPELLS_LEVEL },
    maxTicks: 200,
    driveMode: 'step',
    scriptedCommands: spellScript,
  },
];

// Sanity: names must be unique (fixture filenames are derived from them).
const seen = new Set<string>();
for (const s of SCENARIOS) {
  if (seen.has(s.name)) throw new Error(`duplicate golden replay scenario name: ${s.name}`);
  seen.add(s.name);
}
