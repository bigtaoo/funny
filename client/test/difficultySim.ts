// ─────────────────────────────────────────────────────────────────────────────
// Level difficulty simulator (PvE balance tool)
//
// Runs a headless campaign battle using the real deterministic combat engine
// (@nw/engine, 30Hz), with a “baseline player AI” that automatically deploys
// units / towers / spells to defend, then reports whether the level is clearable
// at a given progression level and outputs key pressure metrics (minimum base HP,
// peak concurrent enemies, tick of the first base hit).
//
// Use cases:
//   1. Quantify “progression level X → can the player clear level Y”, enabling
//      level difficulty ordering and identification of progression gates.
//   2. After editing level JSON / numeric values, run a pass to check whether
//      the difficulty curve has broken.
//
// Important caveat (keep in mind when interpreting results):
//   The AI uses a **fixed, adequate-but-not-optimal** heuristic strategy
//   (economy → tower skeleton → fill-gap unit deployment → focus-fire spells).
//   Its skill level ≈ a serious but non-expert player. Therefore:
//     · AI clears easily  → level is on the easy side for players.
//     · AI barely clears / fails → level is on the hard side (objective signal
//       that “the first level is too hard”).
//   It measures **relative difficulty** and **progression gates**, not
//   “can the optimal solution clear it”.
// ─────────────────────────────────────────────────────────────────────────────

import { createGameEngine } from '../src/game/GameEngine';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';
import type { GameConfig } from '../src/game/types';
import { Side, UnitType, CardType, GamePhase } from '../src/game/types';
import { ATTACK_LANES, UNIT_BLUEPRINTS } from '../src/game/config';
import { PROGRESSABLE_UNITS } from '../src/game/balance/progression';
import { fromFp } from '../src/game/math/fixed';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { computeStars } from '../src/game/meta/campaignRewards';
import { card } from './cardHelpers';
import type { EngineCardInstance, EngineEquipInv, EngineSlotMap } from '../src/game/balance/equipment';

const TICK_DT = 1 / 30;
const TICK_RATE = 30;

// ─── Unit role classification (generalizes the AI beyond the ch1 trio) ──────────────────
// Derived once from UNIT_BLUEPRINTS' static hp/attack/range so the AI can pick a sane card
// for ANY unit type a level's loadout hands it (ch2+ heroes Max/Lena/Mara, PvE-unlock units),
// not just infantry/shieldbearer/archer.
type UnitRole = 'tank' | 'ranged' | 'melee' | 'support';

function classifyRole(hp: number, attack: number, range: number): UnitRole {
  if (attack === 0) return 'support'; // e.g. Medic — no combat contribution, last-resort pick
  if (range >= 2) return 'ranged';    // e.g. Archer / Mara — main clearing DPS
  if (hp >= 140) return 'tank';       // e.g. ShieldBearer / Ironclad / Lena / Max — holds the line
  return 'melee';                     // e.g. Infantry / Runner / Berserker / Splitter / Harpy
}

const ROLE_MAP: Record<UnitType, UnitRole> = Object.fromEntries(
  (Object.keys(UNIT_BLUEPRINTS) as UnitType[]).map((ut) => {
    const bp = UNIT_BLUEPRINTS[ut];
    return [ut, classifyRole(bp.hp, bp.attack, bp.range)];
  }),
) as Record<UnitType, UnitRole>;

// ─── Progression presets ──────────────────────────────────────────────────────────────
// Each preset upgrades all progressable unit types (the 6 card-issuing heroes: Infantry/
// ShieldBearer/Archer/Max/Lena/Mara — PROGRESSABLE_UNITS) uniformly to level N, and equips a
// tier-appropriate reference gear set (PROGRESSION_GEAR below) so the simulated player looks
// like a real one (card level + equipment), not just a bare card level.

export type ProgressionPreset = 'fresh' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';

// ── Reference equipment per tier (sim-only placeholder values) ──────────────────────────
// NOT authoritative game balance numbers — ECONOMY_NUMBERS §5's equipment ranges are still
// undrafted. This is just a plausible "typical equipped player at tier N" stand-in so the
// simulator's progression axis isn't card-level-only. Affix ids/semantics are the real ones
// from server/engine/src/balance/equipment.ts (AFFIX_FIELD_MAP).
const PROGRESSION_EQUIP_INV: EngineEquipInv = {
  sim_t2_weapon: { defId: 'sim_weapon', level: 0, affixes: [{ id: 'm_atk', value: 8 }] },
  sim_t4_weapon: { defId: 'sim_weapon', level: 3, affixes: [{ id: 'm_atk', value: 8 }] },
  sim_t4_armor: { defId: 'sim_armor', level: 3, affixes: [{ id: 'm_hp', value: 10 }] },
  sim_t6_weapon: { defId: 'sim_weapon', level: 6, affixes: [{ id: 'm_atk', value: 8 }] },
  sim_t6_armor: { defId: 'sim_armor', level: 6, affixes: [{ id: 'm_hp', value: 10 }, { id: 's_armor', value: 2 }] },
  sim_t6_trinket: { defId: 'sim_trinket', level: 6, affixes: [{ id: 'm_crit', value: 5 }] },
};

const PROGRESSION_GEAR: Record<ProgressionPreset, EngineSlotMap> = {
  fresh: {},
  T2: { weapon: 'sim_t2_weapon' },
  T3: { weapon: 'sim_t2_weapon' },
  T4: { weapon: 'sim_t4_weapon', armor: 'sim_t4_armor' },
  T5: { weapon: 'sim_t4_weapon', armor: 'sim_t4_armor' },
  T6: { weapon: 'sim_t6_weapon', armor: 'sim_t6_armor', trinket: 'sim_t6_trinket' },
};

// CC-1: blueprint progression now flows through `cardInstances` (best card per unit type drives its
// level) instead of the dropped `unitLevels` GameConfig field. `fresh` = no cards = all units at base.
export function progressionCards(preset: ProgressionPreset): EngineCardInstance[] {
  if (preset === 'fresh') return [];
  const lvl = { T2: 2, T3: 3, T4: 4, T5: 5, T6: 6 }[preset];
  return PROGRESSABLE_UNITS.map((u) => card(u, lvl, PROGRESSION_GEAR[preset]));
}

// ─── Tunable parameters for the baseline AI ─────────────────────────────────────────────────────

export interface BaselineAiOptions {
  /** Maximum number of arrow towers to maintain (the defensive skeleton). */
  towerCap: number;
  /** Maximum number of barracks to maintain (passive unit stream). */
  barracksCap: number;
  /** Target base upgrade level (0..3); upgrading increases ink regeneration rate. */
  upgradeToLevel: number;
  /** Actions per second available (token bucket, simulating human APM). 6 = tight but not superhuman. */
  actionsPerSecond: number;
  /** “Close-range threat” threshold: how many rows from our base (row 0) the enemy must be to count as urgent. */
  threatRows: number;
  /** Minimum number of friendly blocking units to maintain per incoming enemy lane (field defence line, the primary defensive tool in this game). */
  blockersPerLane: number;
}

export const DEFAULT_AI: BaselineAiOptions = {
  towerCap: 6,
  barracksCap: 1,
  upgradeToLevel: 3,
  actionsPerSecond: 8,
  threatRows: 6,
  blockersPerLane: 2,
};

// ─── Lightweight type aliases for engine/state (avoid deep imports of internal classes) ──────────────────────────

type Engine = ReturnType<typeof createGameEngine>;

interface LaneThreat {
  /** Row of the closest living enemy to our base (smallest row) in this lane; Infinity if none. */
  closestRow: number;
  /** Number of living enemies in this lane. */
  count: number;
  /** Total HP of living enemies in this lane. */
  totalHp: number;
  /** Number of our living units in this lane (used to identify which lane is weakly defended). */
  allyCount: number;
  /** Number of our tanks (shield-bearers) in this lane — standard TD: each incoming lane should have a tank holding the line first. */
  allyTanks: number;
  /** Number of living flying enemies in this lane (e.g. Harpy) — bypasses ground blocking, and only
   *  canTargetFlying-capable units/towers can damage it. Ground units sent here to "hold the line"
   *  can neither stop nor kill it: they park in a permanent no-op Attacking state instead (see
   *  DIFFICULTY_SIM.md's ch5_lv8 diagnosis), silently deadlocking the lane forever. */
  flyingCount: number;
}

/** Whether this unit type can damage flying enemies (only relevant blueprint flag for lane-defense picks). */
function canHitFlying(unitType: UnitType): boolean {
  return UNIT_BLUEPRINTS[unitType]?.canTargetFlying ?? false;
}

// ─── Baseline player AI ────────────────────────────────────────────────────────────

export class BaselinePlayer {
  /** Token bucket: incremented by actionsPerSecond/30 each tick; each action costs 1, modelling real APM. */
  private tokens = 0;

  constructor(private readonly opts: BaselineAiOptions = DEFAULT_AI) {}

  /** Called before engine.tick(): read state and issue commands continuously until tokens or ink run out. */
  act(engine: Engine, _tick: number): void {
    const aps = this.opts.actionsPerSecond;
    this.tokens = Math.min(aps, this.tokens + aps / 30);
    if (this.tokens < 1) return;

    const state = engine.state;
    const player = state.bottomPlayer;

    // Within this tick: the battlefield snapshot (enemies / buildings) does not change until commands resolve, so scan only once.
    const laneThreat = this.scanLanes(engine);
    const occupiedTowerLanes = new Set<number>();
    let towers = 0, barracks = 0;
    for (const b of state.board.buildings.values()) {
      if (b.side !== Side.Bottom) continue;
      if (b.buildingType === 'arrow_tower') { towers++; occupiedTowerLanes.add(b.col); }
      else if (b.buildingType === 'barracks') barracks++;
    }

    // Lane closest to our base (priority lane for blocking / unit concentration).
    let worstLane = -1, worstRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = laneThreat.get(lane)!;
      if (t.closestRow < worstRow) { worstRow = t.closestRow; worstLane = lane; }
    }
    const underThreat = worstLane >= 0 && worstRow <= this.opts.threatRows;
    // Lane with the largest enemy cluster (preferred Meteor target).
    let clusterLane = -1, clusterCnt = 0, clusterRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = laneThreat.get(lane)!;
      if (t.count > clusterCnt || (t.count === clusterCnt && t.closestRow < clusterRow)) {
        clusterLane = lane; clusterCnt = t.count; clusterRow = t.closestRow;
      }
    }

    const slots = player.hand.slots;
    const consumed = new Set<number>();
    let ink = player.ink;
    let meteorFired = false;
    // Units / tanks already queued to each lane this tick (so intra-tick distribution is also accounted for).
    const queued = new Map<number, number>();
    const queuedTanks = new Map<number, number>();
    const reinforce = (lane: number, tank: boolean) => {
      queued.set(lane, (queued.get(lane) ?? 0) + 1);
      if (tank) queuedTanks.set(lane, (queuedTanks.get(lane) ?? 0) + 1);
    };

    const findCard = (pred: (kind: CardType, sub: string, cost: number) => boolean): number => {
      for (let i = 0; i < slots.length; i++) {
        if (consumed.has(i)) continue;
        const s = slots[i];
        if (!s) continue;
        const c = s.card;
        if (c.cost > ink) continue;
        const sub = String(c.unitType ?? c.buildingType ?? c.spellType ?? '');
        if (pred(c.cardType, sub, c.cost)) return i;
      }
      return -1;
    };
    const play = (idx: number, col: number, row?: number): void => {
      ink -= slots[idx]!.card.cost;
      consumed.add(idx);
      engine.playCard(idx, col, row);
      this.tokens -= 1;
    };
    /**
     * Deploy one unit to the given lane using the "standard TD formation": if the lane has no
     * tank yet → a tank-role card to hold the line first; otherwise prefer ranged (high DPS,
     * main clearing force), falling back to melee, then support as a last resort. Role is looked
     * up via ROLE_MAP so this works for ANY unit type a level's loadout deals (Max/Lena/Mara,
     * PvE-unlock units), not just the ch1 trio. Returns whether a card was successfully played.
     *
     * Flying enemies (e.g. Harpy) are a special case: they bypass ground blocking entirely, and
     * only canTargetFlying-capable units/towers can damage them, so a normal ground unit sent
     * there can never win the fight — it parks in a permanent no-op Attacking state instead (see
     * DIFFICULTY_SIM.md's ch5_lv8 diagnosis). If a flying-capable unit card is in hand, prefer it
     * first (it can actually kill the target). No unit in the current roster has that flag today
     * (only ArrowTower does), so this is a no-op in practice until one exists — but critically we
     * still fall through to the ordinary tank/ranged/melee formation below rather than declining
     * the deployment outright: empirically, that stuck ground unit still *aggros* the flyer into
     * melee and halts its advance in place, which is the only thing currently keeping the base
     * safe from a Harpy that would otherwise fly straight past row-0 arrow towers (2-row range)
     * completely unengaged. Verified by reverting an earlier "decline if no counter" version of
     * this fix, which turned ch6_lv9/ch6_lv10 unbeatable and dropped ch3_lv3's stars — removing
     * the stall without another way to intercept mid-lane is strictly worse than the status quo.
     */
    const reinforceLane = (lane: number): boolean => {
      const t = laneThreat.get(lane)!;
      const flyingThreat = t.flyingCount > 0;
      const tanks = t.allyTanks + (queuedTanks.get(lane) ?? 0);
      let idx = -1, isTank = false;
      if (flyingThreat) idx = findCard((k, sub) => k === CardType.Unit && canHitFlying(sub as UnitType));
      if (idx >= 0) { play(idx, lane); reinforce(lane, isTank); return true; }
      if (tanks === 0) { idx = findCard((k, sub) => k === CardType.Unit && ROLE_MAP[sub as UnitType] === 'tank'); isTank = idx >= 0; }
      if (idx < 0) idx = findCard((k, sub) => k === CardType.Unit && ROLE_MAP[sub as UnitType] === 'ranged');
      if (idx < 0) idx = findCard((k, sub) => k === CardType.Unit && ROLE_MAP[sub as UnitType] === 'melee');
      if (idx < 0) idx = findCard((k, sub) => k === CardType.Unit && ROLE_MAP[sub as UnitType] === 'support');
      if (idx < 0) { idx = findCard((k) => k === CardType.Unit); isTank = false; }
      if (idx < 0) return false;
      play(idx, lane); reinforce(lane, isTank); return true;
    };

    // Within the token budget, repeatedly act in priority order (concentrate: stack all units into worstLane).
    while (this.tokens >= 1 && ink > 0) {
      // 1) Meteor AOE (at most one per tick, aimed at the largest enemy cluster)
      if (!meteorFired && clusterLane >= 0 && clusterCnt >= 2) {
        const idx = findCard((k, sub) => k === CardType.Spell && sub === SpellTypeMeteor);
        if (idx >= 0) {
          const row = Math.max(2, Math.min(15, clusterRow === Infinity ? 8 : clusterRow));
          play(idx, clusterLane, row); meteorFired = true; continue;
        }
      }
      // 2) Escort protection (escort objective levels only): proactively hold the escort's
      //    current lane at blockersPerLane, regardless of whether an enemy is already adjacent —
      //    unlike reactive lane defense, a moving friendly target needs its path camped ahead of
      //    time, not defended only once threatened.
      {
        const lane = this.pickUnescortedLane(state, laneThreat, queued, this.opts.blockersPerLane);
        if (lane >= 0 && reinforceLane(lane)) continue;
      }
      // 3) Defence coverage (highest reactive priority): if any incoming enemy lane has fewer
      //    blockers than blockersPerLane, reinforce the most threatened under-defended lane first
      //    — tank-role card to hold, then ranged for DPS. Ensures every lane has coverage, no gaps.
      {
        const lane = this.pickUnderBlockedLane(laneThreat, queued, this.opts.blockersPerLane);
        if (lane >= 0 && reinforceLane(lane)) continue;
      }
      // 4) Defensive skeleton: once all incoming lanes have units, build arrow towers for back-row firepower (prioritise threatened lanes)
      if (towers < this.opts.towerCap) {
        const idx = findCard((k, sub) => k === CardType.Building && sub === 'arrow_tower');
        if (idx >= 0) {
          const lane = this.pickTowerLane(occupiedTowerLanes, laneThreat);
          if (lane >= 0) { play(idx, lane); towers++; occupiedTowerLanes.add(lane); continue; }
        }
      }
      // 5) Barracks: maintain one passive unit stream
      if (barracks < this.opts.barracksCap) {
        const idx = findCard((k, sub) => k === CardType.Building && sub === 'barracks');
        if (idx >= 0) {
          const lane = this.pickTowerLane(occupiedTowerLanes, laneThreat);
          if (lane >= 0) { play(idx, lane); barracks++; occupiedTowerLanes.add(lane); continue; }
        }
      }
      // 6) Spare-ink deployment: distribute remaining ink to the most under-defended incoming enemy lane (same formation logic)
      {
        const lane = this.pickDefenseLane(laneThreat, queued);
        if (lane >= 0 && reinforceLane(lane)) continue;
      }
      // 7) Economy: safe and ink to spare → upgrade base (increases ink regeneration)
      if (!underThreat && player.upgradeLevel < this.opts.upgradeToLevel && player.canUpgradeBase()) {
        const cost = player.nextUpgradeCost ?? Infinity;
        if (ink - cost >= 6) { engine.upgradeBase(); ink -= cost; this.tokens -= 1; continue; }
      }
      break; // nothing left to do
    }
  }

  /** Scan the living enemy threat and friendly unit distribution across each attack lane. */
  private scanLanes(engine: Engine): Map<number, LaneThreat> {
    const m = new Map<number, LaneThreat>();
    for (const lane of ATTACK_LANES) {
      m.set(lane, { closestRow: Infinity, count: 0, totalHp: 0, allyCount: 0, allyTanks: 0, flyingCount: 0 });
    }
    for (const u of engine.state.board.units.values()) {
      if (u.isDead) continue;
      const t = m.get(u.col);
      if (!t) continue;
      if (u.side === Side.Top) {
        t.count++;
        t.totalHp += u.hp;
        if (u.flying) t.flyingCount++;
        // Enemies advance from row 17 toward row 0; smaller row = closer to our base.
        if (u.row < t.closestRow) t.closestRow = u.row;
      } else {
        t.allyCount++;
        if (ROLE_MAP[u.unitType] === 'tank') t.allyTanks++;
      }
    }
    return m;
  }

  /**
   * Pick the lane most in need of reinforcement: among lanes with enemies, choose the one with
   * the fewest friendly blockers (including units already queued this tick), breaking ties by
   * choosing the lane with the closest enemy — ensuring every incoming lane has defenders rather
   * than stacking them all in one lane.
   */
  private pickDefenseLane(threat: Map<number, LaneThreat>, queued: Map<number, number>): number {
    let best = -1, bestAllies = Infinity, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = threat.get(lane)!;
      if (t.count === 0) continue;
      const allies = t.allyCount + (queued.get(lane) ?? 0);
      if (allies < bestAllies || (allies === bestAllies && t.closestRow < bestRow)) {
        best = lane; bestAllies = allies; bestRow = t.closestRow;
      }
    }
    return best;
  }

  /**
   * Among lanes currently occupied by a still-moving escort, return the first one whose
   * friendly blocker count (including this-tick queued units) is below `min` — proactive
   * escort camping, independent of whether an enemy has actually reached that lane yet.
   * Returns -1 if there is no escort objective or all escort lanes are already held.
   */
  private pickUnescortedLane(state: Engine['state'], threat: Map<number, LaneThreat>, queued: Map<number, number>, min: number): number {
    for (const escort of state.escorts) {
      if (escort.status !== 'moving') continue;
      const lane = Math.round(fromFp(escort.col_fp));
      const t = threat.get(lane);
      if (!t) continue; // escort column is not an attack lane (shouldn't happen, but stay safe)
      const allies = t.allyCount + (queued.get(lane) ?? 0);
      if (allies < min) return lane;
    }
    return -1;
  }

  /**
   * Among incoming enemy lanes with fewer than min blockers, return the one with the closest
   * enemy (the under-defended lane). Returns -1 if none.
   *
   * Deliberately still counts raw `allyCount` even on flying-threatened lanes (not just
   * flying-capable allies): with no flying-capable unit in the current roster, gating coverage on
   * `allyFlyingCapable` alone means it can never be satisfied, so the AI would keep dumping units
   * into a dead-end lane every tick instead of distributing ink elsewhere. A tried-and-reverted
   * variant of this fix did exactly that; it strictly wasted ink without fixing anything, since
   * the real defensive value of a ground unit here is the incidental aggro-stall described in
   * `reinforceLane`, which plain `allyCount` already captures correctly.
   */
  private pickUnderBlockedLane(threat: Map<number, LaneThreat>, queued: Map<number, number>, min: number): number {
    let best = -1, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      const t = threat.get(lane)!;
      if (t.count === 0) continue;
      const allies = t.allyCount + (queued.get(lane) ?? 0);
      if (allies < min && t.closestRow < bestRow) { best = lane; bestRow = t.closestRow; }
    }
    return best;
  }

  /**
   * Pick a lane to place a tower: prefer lanes with enemy threat that have no tower yet;
   * otherwise the first empty lane in center-outward order.
   *
   * Flying-threatened lanes jump the queue ahead of plain closest-row urgency: a tower is the
   * *only* way to answer a Harpy the AI has no flying-capable unit card for (ground reinforcement
   * can never resolve it — see `reinforceLane`/`pickUnderBlockedLane`), so leaving it to generic
   * urgency ordering risks losing the tower budget to a merely-urgent ground lane while the
   * flying lane deadlocks forever.
   */
  private pickTowerLane(occupied: Set<number>, threat: Map<number, LaneThreat>): number {
    let best = -1, bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      if (occupied.has(lane)) continue;
      const t = threat.get(lane)!;
      if (t.flyingCount > 0 && t.closestRow < bestRow) { best = lane; bestRow = t.closestRow; }
    }
    if (best >= 0) return best;
    // Otherwise, a lane with enemies but no tower, ordered by threat urgency.
    bestRow = Infinity;
    for (const lane of ATTACK_LANES) {
      if (occupied.has(lane)) continue;
      const t = threat.get(lane)!;
      if (t.count > 0 && t.closestRow < bestRow) { best = lane; bestRow = t.closestRow; }
    }
    if (best >= 0) return best;
    // Otherwise lay a tower in the first empty lane in center-outward order.
    for (const lane of TOWER_PRIORITY) if (!occupied.has(lane)) return lane;
    return -1;
  }
}

// String value of SpellType.Meteor (avoids importing another enum constant).
const SpellTypeMeteor = 'meteor';
// Tower placement priority from center outward (base at columns 5/6, attack lanes on both sides).
const TOWER_PRIORITY = [4, 7, 3, 8, 2, 9, 1, 10, 0, 11];

// ─── Single-level simulation ────────────────────────────────────────────────────────────────

export interface SimResult {
  levelId: string;
  preset: ProgressionPreset;
  /** Whether the level was cleared (defended successfully; winner === Bottom). */
  win: boolean;
  /** Star rating 0..3 (based on final base HP% against level.rewards.starThresholds; 0 if not cleared). */
  stars: 0 | 1 | 2 | 3;
  /** Whether the engine reached GameOver within maxTicks (false = cut off by maxTicks, anomalous). */
  reachedGameOver: boolean;
  ticks: number;
  seconds: number;
  /** Our base HP at the end of the run (starts at 100). */
  finalBaseHp: number;
  /** Minimum base HP throughout the run — closer to 0 means more precarious. */
  minBaseHp: number;
  /** Tick at which the base first took damage (null = base was never hit during the run). */
  firstHitTick: number | null;
  /** Peak number of concurrent enemies on screen at any point during the run. */
  peakEnemies: number;
  /** Peak total HP of concurrent enemies on screen at any point during the run. */
  peakEnemyHp: number;
  /** Minimum HP seen across all escort units during the run (escort objective only); null if the level has no escorts. */
  escortMinHp: number | null;
  /** Enemy units that reached row 0 (leak_limit objective diagnostic); 0 for levels without leaks. */
  enemyLeaks: number;
}

export interface SimOptions {
  preset?: ProgressionPreset;
  ai?: BaselineAiOptions;
  /** Maximum tick count (prevents hang). Defaults to auto-computed last-wave tick + buffer. */
  maxTicks?: number;
  /** Override the level seed (for multi-seed evaluation: different seed = different deal / draw order, smoothing out single-run noise). */
  seed?: number;
}

export function simulateLevel(levelOrId: string | LevelDefinition, opts: SimOptions = {}): SimResult {
  const level = typeof levelOrId === 'string'
    ? CAMPAIGN_LEVELS[levelOrId]
    : levelOrId;
  if (!level) throw new Error(`unknown level: ${String(levelOrId)}`);
  const levelId = level.id;
  const preset = opts.preset ?? 'fresh';
  const ai = new BaselinePlayer(opts.ai ?? DEFAULT_AI);

  const config: GameConfig = {
    seed: opts.seed ?? level.seed,
    players: [{ id: 0 }, { id: 1 }],
    mode: 'campaign',
    level,
    cardInstances: progressionCards(preset),
    equipmentInv: PROGRESSION_EQUIP_INV,
  };
  const engine = createGameEngine(config);

  const maxTicks = opts.maxTicks ?? autoMaxTicks(level);

  let minBaseHp = engine.state.bottomPlayer.baseHp;
  let firstHitTick: number | null = null;
  let peakEnemies = 0;
  let peakEnemyHp = 0;
  let escortMinHp: number | null = engine.state.escorts.length > 0
    ? Math.min(...engine.state.escorts.map((e) => e.hp))
    : null;
  let tick = 0;

  while (engine.state.phase !== GamePhase.GameOver && tick < maxTicks) {
    ai.act(engine, tick);

    // Sample pressure metrics (every 3 ticks to save time).
    if (tick % 3 === 0) {
      let cnt = 0, hp = 0;
      for (const u of engine.state.board.units.values()) {
        if (u.side === Side.Top && !u.isDead) { cnt++; hp += u.hp; }
      }
      if (cnt > peakEnemies) peakEnemies = cnt;
      if (hp > peakEnemyHp) peakEnemyHp = hp;
    }

    engine.tick(TICK_DT);
    tick++;

    const bh = engine.state.bottomPlayer.baseHp;
    if (bh < minBaseHp) minBaseHp = bh;
    if (firstHitTick === null && bh < 100) firstHitTick = tick;
    if (escortMinHp !== null) {
      for (const e of engine.state.escorts) if (e.hp < escortMinHp) escortMinHp = e.hp;
    }
  }

  const win = engine.state.winner === Side.Bottom;
  const finalBaseHp = engine.state.bottomPlayer.baseHp;
  // Star rating: remaining base HP% == finalBaseHp (full HP is 100, no regen). 0 if not cleared.
  const stars = win ? computeStars(level.rewards?.starThresholds, finalBaseHp) : 0;

  return {
    levelId,
    preset,
    win,
    stars,
    reachedGameOver: engine.state.phase === GamePhase.GameOver,
    ticks: tick,
    seconds: Math.round((tick / TICK_RATE) * 10) / 10,
    finalBaseHp,
    minBaseHp,
    firstHitTick,
    peakEnemies,
    peakEnemyHp,
    escortMinHp,
    enemyLeaks: engine.state.enemyLeaks,
  };
}

/** Auto-compute the tick ceiling from the last wave arrival tick plus a buffer (survive levels need time to clear the last unit). */
function autoMaxTicks(level: LevelDefinition): number {
  let last = 0;
  for (const e of level.waves.entries) {
    const span = e.atTick + (e.count - 1) * (e.spacingTicks ?? 0);
    if (span > last) last = span;
  }
  return Math.max(60 * TICK_RATE, last + 60 * TICK_RATE); // at least 60s, or 60s after the last wave
}

// ─── Multi-seed evaluation (smooths out single-run noise for reliable star ratings) ────────────────────────────────

const PRESET_ORDER: ProgressionPreset[] = ['fresh', 'T2', 'T3', 'T4', 'T5', 'T6'];

/** Default evaluation seed set — different seeds produce different deal/draw orders; running multiple and taking the median gives stable results. */
export const EVAL_SEEDS = [65537, 1234567, 99991, 424242, 7777] as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export interface CellEval {
  preset: ProgressionPreset;
  /** Clear rate (fraction of seeds won). */
  winRate: number;
  /** Median star rating (0..3). */
  medianStars: number;
  /** Median final base HP. */
  medianHp: number;
  runs: SimResult[];
}

/** Run multiple seeds for a (level, preset) pair and return a robust clear rate / median star rating. */
export function evalCell(
  levelId: string, preset: ProgressionPreset,
  ai?: BaselineAiOptions, seeds: readonly number[] = EVAL_SEEDS,
): CellEval {
  const runs = seeds.map((seed) => simulateLevel(levelId, { preset, ai, seed }));
  const winRate = runs.filter((r) => r.win).length / runs.length;
  return {
    preset, winRate,
    medianStars: median(runs.map((r) => r.stars)),
    medianHp: median(runs.map((r) => r.finalBaseHp)),
    runs,
  };
}

// ─── Threshold scan: find the lowest progression preset that clears on a majority of seeds ──────────────────────────────

export interface ThresholdResult {
  levelId: string;
  /** Lowest preset that clears reliably (win rate ≥ 50%); null = cannot clear even at T6. */
  minClearPreset: ProgressionPreset | null;
  /** Multi-seed evaluation results for each preset. */
  byPreset: CellEval[];
}

export function findClearThreshold(
  levelId: string, ai?: BaselineAiOptions, seeds: readonly number[] = EVAL_SEEDS,
): ThresholdResult {
  const byPreset: CellEval[] = [];
  let minClearPreset: ProgressionPreset | null = null;
  for (const preset of PRESET_ORDER) {
    const c = evalCell(levelId, preset, ai, seeds);
    byPreset.push(c);
    if (c.winRate >= 0.5 && minClearPreset === null) minClearPreset = preset;
  }
  return { levelId, minClearPreset, byPreset };
}

// ─── Report formatting ──────────────────────────────────────────────────────────────

export function formatThresholdTable(results: ThresholdResult[]): string {
  const lines: string[] = [];
  const head = ['level', ...PRESET_ORDER, 'min_clear'].map((s) => s.padEnd(9)).join('|');
  lines.push(head);
  lines.push('-'.repeat(head.length));
  for (const tr of results) {
    const cells = [tr.levelId.padEnd(9)];
    for (const preset of PRESET_ORDER) {
      const c = tr.byPreset.find((x) => x.preset === preset)!;
      // Majority clear → median stars + win rate (e.g. 3★100%) / otherwise → ✗win rate
      const cell = c.winRate >= 0.5
        ? `${c.medianStars}★${Math.round(c.winRate * 100)}%`
        : `✗${Math.round(c.winRate * 100)}%`;
      cells.push(cell.padEnd(9));
    }
    cells.push((tr.minClearPreset ?? 'unbeatable').padEnd(9));
    lines.push(cells.join('|'));
  }
  return lines.join('\n');
}
