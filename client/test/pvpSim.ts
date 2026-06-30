// ─────────────────────────────────────────────────────────────────────────────
// PvP unit-balance simulator (PVP_LOADOUT_DESIGN §5, P4)
//
// The PvE difficulty sim (difficultySim.ts) cannot answer PvP cost questions: it
// runs ONE defensive baseline AI against scripted waves, and that AI has no
// offensive macro, so a PvP mirror would just stall to a forced draw.
//
// Instead we reuse the **siege auto-battle** engine (mode:'siege') — a fully
// deterministic two-army battle with both bases — as a head-to-head duel rig.
// For a given ink budget we field floor(budget/cost) CARDS of unit A on the
// Bottom half and the same ink of unit B on the Top half (each card spawns
// `spawnCount` units), let them march and collide mid-field, and record who
// razes whose base. Every matchup is run BOTH ways (A-as-bottom and A-as-top)
// so the siege "timeout → defender(Top) wins" advantage cancels out.
//
// A card whose unit wins far more than half of its equal-ink duels is
// undercosted; far fewer means overcosted. Combined with the analytical
// stat-budget table (combatPowerTable), this lets us calibrate the 6 new
// units' costs and the Medic PvP override.
//
// IMPORTANT — PvP stats: siege uses buildSiegeBlueprints (== UNIT_BLUEPRINTS,
// no upgrades). The only unit whose PvP stats differ from PvE is the Medic
// (buildPvpBlueprints adds a token melee attack). So before running we overlay
// buildPvpBlueprints() onto UNIT_BLUEPRINTS for the duration of the sim and
// restore afterwards (see withPvpBlueprints) — making every duel use the exact
// stats a real PvP match would.
// ─────────────────────────────────────────────────────────────────────────────

import { createGameEngine } from '../src/game/GameEngine';
import { Side, GamePhase, UnitType, CardType, BuildingType } from '../src/game/types';
import type { GameConfig, IGameEngine } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { UNIT_BLUEPRINTS, CARD_DEFINITIONS } from '../src/game/config';
import { buildPvpBlueprints } from '../src/game/balance/pveUpgrades';

const TICK_DT = 1 / 30;
const TICK_RATE = 30;

// ─── PvP card roster (Unit cards only) ──────────────────────────────────────────
// The 12 unit cards reachable in PvP: 6 base/Anna anchors + 6 tier-unlock units.
// Cost is read live from CARD_DEFINITIONS so editing config.ts re-tunes the sim.

export interface PvpUnitCard {
  cardId: string;
  unitType: UnitType;
  cost: number;
  spawnCount: number;
}

/** Returns the PvP unit roster with current costs (one card id per unit type), optionally overriding costs. */
export function pvpUnitRoster(costOverrides: Record<string, number> = {}): PvpUnitCard[] {
  const wanted: Array<{ id: string; t: UnitType }> = [
    { id: 'infantry_1', t: UnitType.Infantry },
    { id: 'shieldbearer_1', t: UnitType.ShieldBearer },
    { id: 'archer_1', t: UnitType.Archer },
    { id: 'max_1', t: UnitType.Max },
    { id: 'lena_1', t: UnitType.Lena },
    { id: 'mara_1', t: UnitType.Mara },
    { id: 'runner', t: UnitType.Runner },
    { id: 'ironclad', t: UnitType.Ironclad },
    { id: 'berserker', t: UnitType.Berserker },
    { id: 'splitter', t: UnitType.Splitter },
    { id: 'harpy', t: UnitType.Harpy },
    { id: 'medic', t: UnitType.Medic },
  ];
  return wanted.map(({ id, t }) => {
    const def = CARD_DEFINITIONS.find((c) => c.id === id);
    if (!def) throw new Error(`pvpSim: missing card ${id}`);
    if (def.cardType !== CardType.Unit) throw new Error(`pvpSim: ${id} is not a unit card`);
    const cost = costOverrides[id] ?? def.cost;
    return { cardId: id, unitType: t, cost, spawnCount: UNIT_BLUEPRINTS[t].spawnCount };
  });
}

// ─── PvP blueprint overlay (Medic override) ─────────────────────────────────────

/**
 * Runs `fn` with UNIT_BLUEPRINTS temporarily overlaid by buildPvpBlueprints()
 * (only the Medic differs). Restores the originals afterwards so the hard-wall
 * test in other files is unaffected.
 */
export function withPvpBlueprints<T>(fn: () => T): T {
  const pvp = buildPvpBlueprints();
  const saved = {} as Record<UnitType, ReturnType<typeof clone>>;
  const clone = (t: UnitType) => ({ ...UNIT_BLUEPRINTS[t] });
  for (const key of Object.keys(UNIT_BLUEPRINTS) as UnitType[]) {
    saved[key] = clone(key);
    Object.assign(UNIT_BLUEPRINTS[key], pvp[key]);
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(UNIT_BLUEPRINTS) as UnitType[]) {
      Object.assign(UNIT_BLUEPRINTS[key], saved[key]);
    }
  }
}

// ─── Army placement ─────────────────────────────────────────────────────────────

type ArmyEntry = NonNullable<LevelDefinition['attackerArmy']>[number];

/**
 * Central collision arena (avoids the base-race artifact): both armies are
 * packed into a few central lanes near mid-field, just short of touching, so
 * they march one row and immediately engage — the fight resolves long before
 * any survivor walks the 7+ rows back to a base. Bottom fills rows 8→2 (downward
 * tiers), Top fills rows 9→15 (upward tiers). The duel winner is then decided by
 * which army still has units standing, NOT by which base falls (see duel()).
 *
 * Using 4 lanes keeps each lane a dense melee rather than 10 thin parallel races
 * that mostly miss the 2-column base.
 */
const ARENA_LANES = [3, 4, 7, 8] as const;

function fieldArmy(unitType: UnitType, count: number, side: 'bottom' | 'top'): ArmyEntry[] {
  const out: ArmyEntry[] = [];
  const lanes = ARENA_LANES;
  const rowStart = side === 'bottom' ? 8 : 9;
  const rowStep = side === 'bottom' ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const lane = lanes[i % lanes.length]!;
    const tier = Math.floor(i / lanes.length);
    let row = rowStart + tier * rowStep;
    row = Math.max(2, Math.min(15, row));
    out.push({ unitType, col: lane, row });
  }
  return out;
}

type DefBuilding = NonNullable<LevelDefinition['defenderBuildings']>[number];

function duelLevel(
  seed: number,
  attacker: ArmyEntry[],
  defender: ArmyEntry[],
  timeoutTicks: number,
  defenderBuildings?: DefBuilding[],
): LevelDefinition {
  return {
    id: `pvp_duel_${seed}`,
    chapter: 0,
    seed,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
    attackerArmy: attacker, // Bottom (owner 0)
    garrison: defender,     // Top (owner 1)
    defenderBuildings,
    battleTimeoutTicks: timeoutTicks,
  };
}

interface ArmyCensus {
  bottomHp: number;
  topHp: number;
  bottomCount: number;
  topCount: number;
}

function census(engine: IGameEngine): ArmyCensus {
  let bottomHp = 0, topHp = 0, bottomCount = 0, topCount = 0;
  for (const u of engine.state.board.units.values()) {
    if (u.isDead) continue;
    if (u.side === Side.Bottom) { bottomHp += u.hp; bottomCount++; }
    else { topHp += u.hp; topCount++; }
  }
  return { bottomHp, topHp, bottomCount, topCount };
}

/**
 * Drive a siege battle until a decision: a base falls, OR one army is wiped, OR
 * the tick cap. Returns the engine plus the army census at the stopping tick (so
 * the caller can judge the combat trade by surviving HP rather than base race).
 */
function runArena(level: LevelDefinition, maxTicks: number): { engine: IGameEngine; ticks: number; census: ArmyCensus } {
  const config: GameConfig = { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level };
  const engine = createGameEngine(config);
  let i = 0;
  let last = census(engine);
  for (; i < maxTicks && engine.state.phase !== GamePhase.GameOver; i++) {
    engine.tick(TICK_DT);
    // Re-census only every few ticks to bound cost; checked after the army has had a chance to fight.
    if (i % 5 === 0) {
      last = census(engine);
      if (last.bottomCount === 0 || last.topCount === 0) { i++; break; }
    }
  }
  return { engine, ticks: i, census: census(engine) };
}

// ─── Single duel ────────────────────────────────────────────────────────────────

export interface DuelResult {
  /** Combat-trade winner = the side with units still standing when the fight resolves. */
  winner: 'bottom' | 'top' | 'draw';
  ticks: number;
  bottomHp: number;
  topHp: number;
}

export interface DuelOptions {
  /** Total ink each side spends fielding its army. */
  budget?: number;
  seed?: number;
  /** Hard tick ceiling. Kept below the 13-min (23400-tick) global attack-×2 threshold. */
  timeoutTicks?: number;
}

const DEFAULT_BUDGET = 48;
const DEFAULT_TIMEOUT = 9000; // 300 s cap, well below the 13-min attack-doubling threshold

/** A combat trade is "decisive" once one side keeps ≥ this share of the surviving HP. Otherwise a draw. */
const DRAW_BAND = 0.06;

/** Field `budget` ink of A (Bottom) vs `budget` ink of B (Top) in the collision arena; winner = who has army left. */
export function duel(a: PvpUnitCard, b: PvpUnitCard, opts: DuelOptions = {}): DuelResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const timeout = opts.timeoutTicks ?? DEFAULT_TIMEOUT;
  const seed = opts.seed ?? 0x9e3779b9;

  const nCardsA = Math.max(1, Math.floor(budget / a.cost));
  const nCardsB = Math.max(1, Math.floor(budget / b.cost));
  const attacker = fieldArmy(a.unitType, nCardsA * a.spawnCount, 'bottom');
  const defender = fieldArmy(b.unitType, nCardsB * b.spawnCount, 'top');

  const { ticks, census: c } = runArena(duelLevel(seed, attacker, defender, timeout), timeout);
  // Decide by which side still has units; if both linger (timeout) compare surviving HP.
  let winner: 'bottom' | 'top' | 'draw';
  if (c.bottomCount > 0 && c.topCount === 0) winner = 'bottom';
  else if (c.topCount > 0 && c.bottomCount === 0) winner = 'top';
  else {
    const total = c.bottomHp + c.topHp;
    const diff = total > 0 ? (c.bottomHp - c.topHp) / total : 0;
    winner = diff > DRAW_BAND ? 'bottom' : diff < -DRAW_BAND ? 'top' : 'draw';
  }
  return { winner, ticks, bottomHp: c.bottomHp, topHp: c.topHp };
}

// ─── Round-robin tournament ──────────────────────────────────────────────────────

export interface UnitTourneyRow {
  cardId: string;
  cost: number;
  /** Games played (each opponent twice: once as bottom, once as top). */
  games: number;
  /** Duels won. */
  wins: number;
  winRate: number;
}

/**
 * Every unit duels every other unit at equal ink, both as attacker (Bottom) and
 * defender (Top), so the siege defender-timeout bias cancels. Returns a win-rate
 * row per unit — the central balance signal (≈50% = fairly costed for raw combat).
 */
export function roundRobin(roster: PvpUnitCard[], opts: DuelOptions = {}): UnitTourneyRow[] {
  const wins = new Map<string, number>();
  const games = new Map<string, number>();
  for (const u of roster) { wins.set(u.cardId, 0); games.set(u.cardId, 0); }

  const credit = (winnerCard: string) => wins.set(winnerCard, wins.get(winnerCard)! + 1);
  const played = (card: string) => games.set(card, games.get(card)! + 1);

  return withPvpBlueprints(() => {
    for (let i = 0; i < roster.length; i++) {
      for (let j = 0; j < roster.length; j++) {
        if (i === j) continue;
        const a = roster[i]!, b = roster[j]!;
        // a as Bottom vs b as Top
        const r = duel(a, b, opts);
        played(a.cardId); played(b.cardId);
        if (r.winner === 'bottom') credit(a.cardId);
        else if (r.winner === 'top') credit(b.cardId);
      }
    }
    return roster.map((u) => {
      const g = games.get(u.cardId)!;
      const w = wins.get(u.cardId)!;
      return { cardId: u.cardId, cost: u.cost, games: g, wins: w, winRate: g > 0 ? w / g : 0 };
    });
  });
}

// ─── Targeted experiments (Harpy guardrail + Medic value) ────────────────────────

export interface BattleOutcome {
  winner: 'bottom' | 'top' | 'draw';
  ticks: number;
  bottomHp: number;
  topHp: number;
  bottomCount: number;
  topCount: number;
}

/** Run one arbitrary army-vs-army (+ optional Top arrow towers) battle under the PvP overlay. */
export function battle(
  attacker: ArmyEntry[],
  defender: ArmyEntry[],
  opts: { seed?: number; timeoutTicks?: number; defenderTowers?: number[] } = {},
): BattleOutcome {
  const timeout = opts.timeoutTicks ?? DEFAULT_TIMEOUT;
  const seed = opts.seed ?? 0x9e3779b9;
  const buildings: DefBuilding[] | undefined = opts.defenderTowers?.map((col) => ({
    buildingType: BuildingType.ArrowTower,
    col,
  }));
  return withPvpBlueprints(() => {
    const { ticks, census: c } = runArena(duelLevel(seed, attacker, defender, timeout, buildings), timeout);
    let winner: 'bottom' | 'top' | 'draw';
    if (c.bottomCount > 0 && c.topCount === 0) winner = 'bottom';
    else if (c.topCount > 0 && c.bottomCount === 0) winner = 'top';
    else {
      const total = c.bottomHp + c.topHp;
      const diff = total > 0 ? (c.bottomHp - c.topHp) / total : 0;
      winner = diff > DRAW_BAND ? 'bottom' : diff < -DRAW_BAND ? 'top' : 'draw';
    }
    return { winner, ticks, bottomHp: c.bottomHp, topHp: c.topHp, bottomCount: c.bottomCount, topCount: c.topCount };
  });
}

function cardsForBudget(card: PvpUnitCard, budget: number): number {
  return Math.max(1, Math.floor(budget / card.cost)) * card.spawnCount;
}

/**
 * Harpy guardrail probe. A pure-Harpy attacker (Bottom) vs several defender
 * profiles (Top). The §5 question: at cost 7, is flying oppressive when the
 * opponent lacks anti-air, and is it hard-countered by towers/archers?
 */
export function harpyReport(budget = 48): string {
  const roster = pvpUnitRoster();
  const card = (id: string) => roster.find((r) => r.cardId === id)!;
  const harpy = card('harpy');
  const lines = ['scenario                         winner   ticks  harpyLeft  defLeft'];
  const run = (label: string, defender: ArmyEntry[], towers?: number[]) => {
    const atk = fieldArmy(UnitType.Harpy, cardsForBudget(harpy, budget), 'bottom');
    const o = battle(atk, defender, { defenderTowers: towers });
    lines.push(
      `${label.padEnd(30)} ${o.winner.padEnd(7)} ${String(o.ticks).padStart(6)}  ${String(o.bottomCount).padStart(8)}  ${String(o.topCount).padStart(7)}`,
    );
  };
  const army = (c: PvpUnitCard) => fieldArmy(c.unitType, cardsForBudget(c, budget), 'top');
  run('harpy vs infantry (no AA)', army(card('infantry_1')));
  run('harpy vs shieldbearer (no AA)', army(card('shieldbearer_1')));
  run('harpy vs archer (AA)', army(card('archer_1')));
  run('harpy vs mara (AA)', army(card('mara_1')));
  run('harpy vs infantry + 2 towers', army(card('infantry_1')), [4, 7]);
  run('harpy vs infantry + 1 tower', army(card('infantry_1')), [5]);
  return lines.join('\n');
}

/**
 * Medic value-add probe. Compare a pure army vs the same ink with one card
 * swapped for a Medic, both attacking an identical reference defender. If the
 * medic-augmented army does better (more enemy base damage / a win), the aura
 * is providing real value for its cost.
 */
export function medicReport(budget = 48): string {
  const roster = pvpUnitRoster();
  const card = (id: string) => roster.find((r) => r.cardId === id)!;
  const infantry = card('infantry_1');
  const medic = card('medic');
  const shield = card('shieldbearer_1');

  const lines = ['composition                       winner   ticks  botHpLeft  defLeft'];
  const ref = () => fieldArmy(shield.unitType, cardsForBudget(shield, budget), 'top');

  // Pure infantry @ budget.
  const pureN = cardsForBudget(infantry, budget);
  const pure = fieldArmy(infantry.unitType, pureN, 'bottom');
  const o1 = battle(pure, ref());
  lines.push(`pure infantry (${String(pureN).padStart(2)} bodies)`.padEnd(33) + ` ${o1.winner.padEnd(7)} ${String(o1.ticks).padStart(6)}  ${String(o1.bottomHp).padStart(8)}  ${String(o1.topCount).padStart(7)}`);

  // Infantry + 1 medic for (budget - medicCost).
  const infN = cardsForBudget(infantry, budget - medic.cost);
  const mixed: ArmyEntry[] = [
    ...fieldArmy(infantry.unitType, infN, 'bottom'),
    ...fieldArmy(medic.unitType, medic.spawnCount, 'bottom'),
  ];
  const o2 = battle(mixed, ref());
  lines.push(`infantry(${String(infN).padStart(2)}) + 1 medic`.padEnd(33) + ` ${o2.winner.padEnd(7)} ${String(o2.ticks).padStart(6)}  ${String(o2.bottomHp).padStart(8)}  ${String(o2.topCount).padStart(7)}`);
  return lines.join('\n');
}

/** Re-run the full round-robin with one card's cost overridden; report just that card's win rate. */
export function costSweep(cardId: string, costs: number[], opts: DuelOptions = {}): string {
  const lines = [`${cardId} cost sweep (win rate across the full field):`];
  for (const cost of costs) {
    const roster = pvpUnitRoster({ [cardId]: cost });
    const rows = roundRobin(roster, opts);
    const r = rows.find((x) => x.cardId === cardId)!;
    lines.push(`  cost ${cost}: ${(r.winRate * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}

// ─── Analytical stat-budget table (transparent cross-check) ──────────────────────

export interface CombatPowerRow {
  cardId: string;
  unitType: UnitType;
  cost: number;
  spawnCount: number;
  hp: number;
  armor: number;
  dps: number;
  /** Combat power of one CARD = sqrt(EHP × DPS) × spawnCount (Lanchester-style duel proxy). */
  cardCp: number;
  /** cardCp / cost — value per ink. Anchors cluster ~1.0 after normalisation. */
  cpPerInk: number;
}

/**
 * Analytical "combat power per ink" using current blueprints (PvP overlay applied).
 * EHP folds armor against a reference 12-damage hit (Infantry's attack) — a
 * realistic average attacker — so armored units (Ironclad/Lena/Max) get credit.
 * cpPerInk is normalised so Infantry == 1.0.
 */
export function combatPowerTable(roster: PvpUnitCard[], refHit = 12): CombatPowerRow[] {
  return withPvpBlueprints(() => {
    const raw = roster.map((u) => {
      const bp = UNIT_BLUEPRINTS[u.unitType];
      const armor = bp.armor ?? 0;
      const perHit = Math.max(1, refHit - armor);
      const ehp = bp.hp * (refHit / perHit); // hits-to-kill × refHit
      const dps = bp.attack > 0 && bp.attackInterval > 0 ? bp.attack / bp.attackInterval : 0.5; // medic token
      const cardCp = Math.sqrt(ehp * dps) * u.spawnCount;
      return { u, bp, armor, ehp, dps, cardCp };
    });
    const inf = raw.find((r) => r.u.cardId === 'infantry_1')!;
    const norm = inf.cardCp / inf.u.cost; // infantry cpPerInk → 1.0
    return raw.map((r) => ({
      cardId: r.u.cardId,
      unitType: r.u.unitType,
      cost: r.u.cost,
      spawnCount: r.u.spawnCount,
      hp: r.bp.hp,
      armor: r.armor,
      dps: Math.round(r.dps * 100) / 100,
      cardCp: Math.round(r.cardCp * 10) / 10,
      cpPerInk: Math.round((r.cardCp / r.u.cost / norm) * 100) / 100,
    }));
  });
}

// ─── Report formatting ───────────────────────────────────────────────────────────

export function formatTourney(rows: UnitTourneyRow[]): string {
  const sorted = [...rows].sort((a, b) => b.winRate - a.winRate);
  const lines = ['card           cost  games  wins  winRate', '-'.repeat(42)];
  for (const r of sorted) {
    lines.push(
      `${r.cardId.padEnd(14)} ${String(r.cost).padStart(3)}  ${String(r.games).padStart(5)}  ${String(r.wins).padStart(4)}   ${(r.winRate * 100).toFixed(1)}%`,
    );
  }
  return lines.join('\n');
}

export function formatCombatPower(rows: CombatPowerRow[]): string {
  const sorted = [...rows].sort((a, b) => b.cpPerInk - a.cpPerInk);
  const lines = ['card           cost  spawn   hp  armor    dps   cardCP  cp/ink(infantry=1)', '-'.repeat(70)];
  for (const r of sorted) {
    lines.push(
      `${r.cardId.padEnd(14)} ${String(r.cost).padStart(3)}  ${String(r.spawnCount).padStart(4)}  ${String(r.hp).padStart(4)}  ${String(r.armor).padStart(4)}  ${r.dps.toFixed(2).padStart(6)}  ${r.cardCp.toFixed(1).padStart(6)}   ${r.cpPerInk.toFixed(2)}`,
    );
  }
  return lines.join('\n');
}

export { TICK_RATE };
