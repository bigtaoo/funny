// SLG siege settlement (S8-3, §5.3), vision/fog of war (G5, §8.2/§2.1/§15.2), playable siege defense level (S8-3b/C2),
// CC-3 card-based troop system (CHARACTER_CARDS_DESIGN §6/§7/§8), and ADR-026 building HP + siege value.
// Split out of slg.ts (god-file split, [[project_godfile_split_pattern]]).
// worldsvc does not import the deterministic engine (M12); the cheap linear numeric settlement below is used at arrival time to immediately resolve
// siege outcomes (territory transfer / home-city looting / NPC sweep); this is the design-sanctioned "non-critical / cheap numeric settlement" path (§5.3).
// The engine-replay path for "critical battles" (real player vs. player city assault) (buildSiegeBlueprints + judgeRunner siege branch) is already
// implemented and unit-tested on the client; S8-3b wires this in via worldsvc→gateway /gw/judge to replace the cheap settlement.

import { cardSiegeValue } from '../cards';
import type { CardInstance } from '../types';
import type { SiegeOutcome } from './core';
import { NATION_BONUS_DEFENSE } from './province';

/** NPC garrison strength for neutral / resource tiles (defensive strength for the sweep march kind; linear by tile level). */
export const NPC_GARRISON_PER_LEVEL = 120;
/** Fraction of the target's resources looted on a successful siege (transferred from the defeated side to the attacker on territory transfer / home-city looting). */
export const SIEGE_LOOT_RATE = 0.25;
/** One-time resource captured from an NPC tile on a successful sweep (per tile level, per resource type). */
export const SWEEP_LOOT_PER_LEVEL = 200;

/** NPC garrison for a single tile (sweep defensive strength). */
export function npcGarrison(level: number): number {
  return NPC_GARRISON_PER_LEVEL * Math.max(1, level);
}

// ── G8 stronghold (§3.1) values (combat-power calibrated 2026-07-16, RE-calibrated 2026-07-27 for ADR-048
// TROOP_CAP_BASE=10000 baseline, see SLG_DESIGN_LOG §21.4 follow-up + ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5) ────
/**
 * Stronghold system NPC garrison strength per level. Strongholds always generate at `SLG_MAP_MAX_LEVEL` (currently
 * 10, stronghold.ts), so the garrison a player actually faces is fixed at 11800 troops, not a hypothetical 1..5 range
 * (an earlier version of this comment assumed max level 5 / 1800 — stale; the map's max level moved to 10 without
 * updating this note). Far stronger than ordinary tile garrison (GARRISON_PER_TILE=500) and sweep NPCs
 * (NPC_GARRISON_PER_LEVEL=120); "extremely hard to conquer" (§3.1). **Combat-power confirmed, not just asserted**
 * (`server/tools/econ-sim/src/strongholdCombatRun.ts`): a fresh player (troopCap=TROOP_CAP_BASE=10000) loses
 * outright; a modestly-invested one (troopCap=12000, 2 drillYard levels) reliably wins — delivering on SLG7
 * selling combat power / U7 overwhelming tier as a real, not free, gate.
 *
 * **2026-07-27 re-calibration note (ADR-048 TROOP_CAP_BASE 2000→10000).** This garrison (11800) is comfortably
 * above `SIEGE_SYNTH_ARMY_MAX_TROOPS` (~9,600 troops, worldsvc/src/siegeEngine.ts — the board-depth capacity of
 * `synthesizeArmy`'s round-robin placement, 10 attack lanes × 16 spawnable rows × 60 HP/unit). That matters
 * because worldsvc's `shouldUseCheapSiege` (wired into combatSiege/arrival.ts since commit 13a7af86, 2026-07-16)
 * routes ANY siege where a synthesized side's troops exceed that capacity to the cheap linear `resolveSiege`
 * (attacker wins iff troops > garrison) instead of the real `@nw/engine` auto-battle — and both stronghold and
 * crossing garrisons are always synthesized. So in production this gate is, and must be calibrated as, a plain
 * linear comparison against `TROOP_CAP_BASE`/`DRILL_TROOPCAP_STEP`, not a real-engine combat simulation: fresh
 * (10000) < 11800 < drillYard+2 (12000), giving comfortable several-hundred-troop margins on both sides of the
 * threshold — nothing like the "razor-thin band you must dodge the engine's board-depth cliff to find" that a
 * naive real-engine-only simulation would suggest (and that an earlier same-day recalibration pass of this
 * constant mistakenly optimized for, before the `shouldUseCheapSiege` mirror was added to strongholdCombat.ts —
 * see that file's header and ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.5 for the full incident writeup).
 * The per-level value (1180) is deliberately kept above {@link CROSSING_GARRISON_PER_LEVEL} (1150) so a
 * same-level comparison still holds "stronghold garrison > crossing garrison" (worldsvc/test/passage.e2e.test.ts
 * asserts this) even though crossings spawn one level lower (9 vs. 10) — the two constants' *totals* (11800 vs.
 * 10350) already differ from the level gap alone, but keeping the per-level ordering too avoids a surprising
 * inversion. Re-run `strongholdCombatRun.ts` after any future change to TROOP_CAP_BASE, DRILL_TROOPCAP_STEP, or
 * SIEGE_SYNTH_ARMY_MAX_TROOPS rather than assuming a proportional rescale holds.
 */
export const STRONGHOLD_GARRISON_PER_LEVEL = 1180;
/** Stronghold system garrison (linear by tile level; §3.1 overwhelmingly strong default defensive config). */
export function strongholdGarrison(level: number): number {
  return STRONGHOLD_GARRISON_PER_LEVEL * Math.max(1, level);
}
/** One-time resource reward on stronghold conquest (per tile level, per resource type; §3.1 "large resource yield"). Season-internal, capped by RESOURCE_CAP — sanity-checked in strongholdRun.ts §④. */
export const STRONGHOLD_LOOT_PER_LEVEL = 5000;

// ── Crossing buildings (bridge / plankway) garrison (gate→bridge/plankway migration) ────────────
/**
 * NPC garrison per level for a crossing building (bridge/plankway). Auto-crossings always generate at
 * `max(2, SLG_MAP_MAX_LEVEL-1)` (currently 9, mapgen.ts), so the garrison actually faced is fixed at 10350 troops.
 * A crossing is a strategic choke — harder than an ordinary tile (NPC_GARRISON_PER_LEVEL=120) but well below a
 * stronghold (11800), so an early player can force a passage but still needs a real army: a siege-to-pass gate,
 * not a free arc. **Combat-power confirmed** (strongholdCombatRun.ts): a fresh player (troopCap=TROOP_CAP_BASE=10000)
 * loses outright; a single drillYard level (troopCap=11000) opens it — lighter investment than the stronghold's 2
 * levels, as intended. Re-calibrated 2026-07-27 alongside {@link STRONGHOLD_GARRISON_PER_LEVEL} for the same
 * ADR-048 TROOP_CAP_BASE=10000 baseline — **see that constant's doc comment for why this is a plain linear
 * calibration** (this garrison also exceeds `SIEGE_SYNTH_ARMY_MAX_TROOPS`, so `shouldUseCheapSiege` routes it to
 * the cheap path too): fresh (10000) < 10350 < drillYard+1 (11000), ~350/650-troop margins either side. Kept
 * below STRONGHOLD_GARRISON_PER_LEVEL (1150 < 1180) so the two buildings' per-level toughness still orders the
 * same way as their totals — see that constant's doc comment for why the ordering is asserted explicitly.
 */
export const CROSSING_GARRISON_PER_LEVEL = 1150;
/** Crossing-building (bridge/plankway) NPC garrison (linear by tile level). */
export function passageGarrison(level: number): number {
  return CROSSING_GARRISON_PER_LEVEL * Math.max(1, level);
}

/**
 * Additional progression material drop on stronghold conquest (§19.5 "unified with G4 progression material flow"): single rare material `binding`
 * (gates rare/epic equipment; scarce through normal map routes), linear by tile level, delivered to SaveData.materials unified progression pool
 * (not a season resource; persists across seasons, SLG4). Economic-simulation validated (`strongholdRun.ts` §③): persistent-faucet dilution vs.
 * regular grind stays ≤15% even at full-world capture.
 * **Re-tuned 2026-07-27 (ADR-054)**: ADR-049's map enlargement (500×500→1500×1500) kept per-tile stronghold density constant by design, but
 * that meant the world's absolute stronghold COUNT grew with map area (median ~567→~2,817, max ~636→~3,286) while `SLG_WORLD_CAPACITY_TARGET`
 * (the dilution denominator, a server-population design constant unrelated to map area) stayed at 400 — pushing dilution from a safe 12.6% up to
 * 65.2% at the worst-case seed. Lowering this constant (was 4) is the correct lever: it leaves the ADR-049 map-size/density decision and the
 * ADR-032 world-capacity decision both untouched, and directly re-caps the one thing that actually grew unboundedly — the persistent faucet's
 * per-capture size. 0.8×level10 = 8/capture restores ~13.0% worst-case dilution, matching the old design's safety margin (see
 * ECONOMY_VERIFICATION_LOG.md §13-SLG-STRONGHOLD.2b).
 */
export const STRONGHOLD_LOOT_MATERIAL = 'binding';
export const STRONGHOLD_LOOT_MATERIAL_PER_LEVEL = 0.8;
/** Stronghold material drop (pure function, computable on either end): {material, qty}; qty is linear by tile level. */
export function strongholdMaterialLoot(level: number): { material: string; qty: number } {
  return { material: STRONGHOLD_LOOT_MATERIAL, qty: STRONGHOLD_LOOT_MATERIAL_PER_LEVEL * Math.max(1, level) };
}

export interface SiegeResolution {
  outcome: SiegeOutcome;
  /** Attacker surviving troops (on attacker_win, can become new garrison or return; on defender_win = 0, wiped out). */
  attackerSurvivors: number;
  /** Defender surviving troops (on defender_win, remaining garrison; on attacker_win = 0). */
  defenderSurvivors: number;
  /**
   * Attacker strength actually committed to this battle, in the SAME unit as
   * {@link SiegeResolution.attackerSurvivors} — so `attackerSurvivors / attackerDeployed` is a
   * meaningful survival ratio (ADR-069). The cheap linear path deals in raw troops, so this is
   * simply the attacker's troop count; the engine path deals in per-unit HP clamped to each
   * unit's blueprint capacity, so this is that clamped sum (`GameState.preplacedAttackerHp_fp`),
   * which for a card team is typically only 40-60% of the nominal troop total. Post-battle card
   * bookkeeping MUST divide by this, never by the nominal troops: the mismatched denominator
   * used to shave 40-60% off a team's troops on every battle, including won ones.
   */
  attackerDeployed: number;
  /**
   * Defender counterpart of {@link SiegeResolution.attackerDeployed} — the defending force actually
   * committed, in the same unit as `defenderSurvivors`. Field encounters (ADR-051) pit two real card
   * armies against each other, so the defending side needs the same honest denominator (ADR-069).
   */
  defenderDeployed: number;
}

/**
 * Linear (Lanchester-lite) siege settlement: if attacker troops > defender strength → attacker wins, survivors = difference;
 * otherwise defender wins (ties go to defender, consistent with "defender advantage"). Pure function, deterministic, computable on either end.
 */
export function resolveSiege(attackerTroops: number, defenseStrength: number): SiegeResolution {
  const atk = Math.max(0, Math.floor(attackerTroops));
  const def = Math.max(0, Math.floor(defenseStrength));
  if (atk > def) {
    return { outcome: 'attacker_win', attackerSurvivors: atk - def, defenderSurvivors: 0, attackerDeployed: atk, defenderDeployed: def };
  }
  return { outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: def - atk, attackerDeployed: atk, defenderDeployed: def };
}

/**
 * Nation defense bonus (S8-6.5 / §2.4): when the defending garrison is within the Voronoi zone of a capital controlled by the defender's nation,
 * effective defense strength is ×(1+NATION_BONUS_DEFENSE); otherwise unchanged. Pure function, deterministic, integer result, computable on either end.
 */
export function nationDefenseStrength(garrison: number, inOwnNation: boolean): number {
  const g = Math.max(0, Math.floor(garrison));
  return inOwnNation ? Math.floor(g * (1 + NATION_BONUS_DEFENSE)) : g;
}

// ── Vision / fog of war (G5, §8.2 / §2.1 / §15.2) ─────────────────────────────────────
// Decision (2026-06-21): fog model 2a — terrain layer (procedural, deterministic) is always fully visible;
// dynamic layer (ownership / garrison / defense / protection shield / marches) is only shown within "current vision";
// tiles outside vision revert to the base terrain from proceduralTile (not even "this tile is occupied" is leaked).
// Vision is not persisted: computed live from vision sources at read time + short TTL cache.
// Vision sources = own territory (radius VISION_TERRITORY) + home city (radius VISION_BASE) + own/family marches in transit
// (radius VISION_MARCH, position linearly interpolated from departAt/arriveAt) + same-family member territories (shared, ≤30 members;
// §8.2 decision: downgraded to family-level rather than sect-level, to avoid 900-person union making fog of war meaningless). Vision shape uses Chebyshev
// (square) distance — simplest on a tile grid, computable on either end.

/** Own territory vision radius (Chebyshev, DRAFT). */
export const VISION_TERRITORY_RADIUS = 2;
/** Home city vision radius (larger than territory, DRAFT). */
export const VISION_BASE_RADIUS = 5;
/** In-transit march vision radius (DRAFT). */
export const VISION_MARCH_RADIUS = 2;
/**
 * Watchtower vision radius (§18 G5 V2 remaining item, DRAFT). The largest fixed persistent vision source — farther than the home city (5);
 * building a tower on own territory upgrades that tile to a large-radius observation point, illuminating a deep area — the primary mechanism for proactively expanding vision.
 */
export const VISION_WATCHTOWER_RADIUS = 8;
/** Maximum radius across all vision sources (used as query pad for outward expansion; must cover the largest-radius source to avoid missing vision zone edges). */
export const VISION_MAX_RADIUS = Math.max(
  VISION_TERRITORY_RADIUS,
  VISION_BASE_RADIUS,
  VISION_MARCH_RADIUS,
  VISION_WATCHTOWER_RADIUS,
);

/** Vision source: a center point + radius (Chebyshev). */
export interface VisionSource {
  x: number;
  y: number;
  radius: number;
}

/**
 * Whether tile (x,y) falls within the Chebyshev radius of any vision source. Pure function, computable on either end.
 * The number of sources is bounded within the view area (own/family territory + home city + marches in transit); per-tile call cost is acceptable.
 */
export function isInVision(sources: readonly VisionSource[], x: number, y: number): boolean {
  for (const s of sources) {
    if (Math.abs(x - s.x) <= s.radius && Math.abs(y - s.y) <= s.radius) return true;
  }
  return false;
}

/**
 * Current march position (linear interpolation from fromTile to toTile; used for G5 vision — approximate since the actual path may detour around obstacles, but sufficient for vision circles).
 * frac is clamped to [0,1] from (now-departAt)/(arriveAt-departAt); degenerate case (arriveAt≤departAt) returns the destination.
 */
export function marchInterpPos(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  departAt: number,
  arriveAt: number,
  now: number,
): { x: number; y: number } {
  const span = arriveAt - departAt;
  const frac = span > 0 ? Math.max(0, Math.min(1, (now - departAt) / span)) : 1;
  return {
    x: Math.round(fromX + (toX - fromX) * frac),
    y: Math.round(fromY + (toY - fromY) * frac),
  };
}

// ── Playable siege defense level (S8-3b / C2) ─────────────────────────────────────────────
// Normalizes the stored defense config (DefenseConfig subset: garrison/defenderBuildings/defenderBaseLevel) into a
// complete LevelDefinition-shaped object "ready for the attacker to play" (objective=destroy_base, no scripted waves).
// The client uses it for live play / replay in GameScene siege mode; worldsvc re-computation (resolveSiegeWithJudge) uses the same object as
// the judge's defenseJson — both ends must be byte-for-byte identical for deterministic re-computation, hence centralized here as single source of truth.

/** Derives a deterministic seed from siegeId (FNV-1a 32-bit); shared by the siege level and re-computation. */
export function siegeSeedFromId(sid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sid.length; i++) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Keep in sync with MAX_BASE_LEVEL (= BASE_UPGRADE_COSTS.length) in server/engine/src/campaign/levelSchema.ts —
// this package can't import @nw/engine, so the bound is duplicated here.
function clampBaseLevel(n: number): number {
  return Math.max(0, Math.min(2, Math.floor(n) || 0));
}

/**
 * Siege battle hard time limit (ticks, §16.5 A7 decision): 10 minutes of game time × 60 × 30 Hz = 18000 ticks.
 * If both bases survive the timeout → defender wins (defender advantage) + headless re-computation compute budget cap.
 */
export const SIEGE_BATTLE_TIMEOUT_TICKS = 10 * 60 * 30;

/**
 * Overwhelming-tier cheap settlement ratio (§14.10 U7, §16.5 A7 decision): when attacker troops / effective defender garrison ≥ this value,
 * skip the deterministic engine and go directly to the cheap linear resolveSiege (outcome is guaranteed attacker_win; saves compute).
 * 10 corresponds to "attacker has 10× garrison" — under Lanchester linear, the gap is so large the outcome is nearly certain.
 * U7 "100:1 fully-equipped overwhelming" is the extreme upper bound; 10:1 is already safe enough to skip the engine.
 */
export const SIEGE_CHEAP_RATIO = 10;

/** Maximum number of attack lineup templates (teams) (§16.2; initial phase: 5 = number of saveable templates + concurrency cap). */
export const SIEGE_TEAM_CAP = 5;

// ── CC-3: card-based SLG troop system (CHARACTER_CARDS_DESIGN §6/§7/§8) ────────────────────

/** Maximum number of card instances per attack team (CHARACTER_CARDS_DESIGN §8.2). */
export const CARD_TEAM_MAX_SIZE = 12;

/** Minimum surviving troop fraction when a card's HP reaches zero in battle (baseSurvival, CHARACTER_CARDS_DESIGN §7.1). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_BASE_SURVIVAL = 0.2;

/** Injury lock duration (ms) applied when a card's HP reaches zero in battle (CHARACTER_CARDS_DESIGN §7.2). */
export const CARD_INJURY_DURATION_MS = 5 * 60 * 1000;

/** Coins required for immediate card injury recovery (CHARACTER_CARDS_DESIGN §7.2). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_RECOVER_COIN_COST = 50;

/** Fraction of training resources refunded when a card is removed from a team (CHARACTER_CARDS_DESIGN §6.3). */
export const CARD_TROOP_REFUND_RATE = 0.8;
/** Paper cost per card troop trained into the base troop pool (grain, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_PAPER_COST = 2;
/** Graphite cost per card troop (wood, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_GRAPHITE_COST = 2;
/** Metal cost per card troop (iron, CHARACTER_CARDS_DESIGN §6). [DRAFT → ECONOMY_NUMBERS §6] */
export const CARD_TROOP_METAL_COST = 1;

// ── Per-unit troop slider (§16.5 A7 tuning) ────────────────────────────────────────────
/**
 * Minimum HP fraction per unit in the lineup editor (§16.5): at least 25% of the blueprint's full HP must be assigned,
 * ensuring every unit contributes meaningful damage output and preventing the "1HP tile-filler abuse" exploit. The editor rounds this value up (≥1).
 */
export const SIEGE_UNIT_HP_MIN_FRACTION = 0.25;
/**
 * Number of HP steps per unit in the lineup editor (§16.5): 4 tiers (25% / 50% / 75% / 100%).
 * Each click on a tile cycles through the tiers; committed troops = sum of all unit HP values.
 */
export const SIEGE_UNIT_HP_STEPS = 4;

// ── ADR-026: building HP + wave defenders + siege-value delayed settlement ────────────────
//
// Universal building-attack model (main base / level / city / stronghold): every attackable building has HP;
// in-base, non-injured teams defend in waves (t1→t5) with attacker survivor carry-over; clearing all defenders
// (or none present) schedules a delayed HP hit equal to the attacking team's siege value; HP→0 captures the building.
// Numbers below are DRAFT placeholders (siege-value detail deferred to a dedicated session; economy pass pending).

/** Building max HP per level: `maxHp = level × SLG_BASE_HP_PER_LEVEL` (main base lv1 = 100 ⇒ ~3–4 sieges at ~30/hit). [DRAFT → economy pass] */
export const SLG_BASE_HP_PER_LEVEL = 100;

/**
 * siege value is a per-card attribute, same tier as attack / move-speed (owner decision 2026-07-02).
 * A team's siege value = sum of each of its cards' siege value ({@link cardSiegeValue}, resolved from CARD_DEFS + level).
 * A real team always has cards → value is always > 0; the only "no building damage" case is the attacker being wiped,
 * which is already a defender win (no hit scheduled). This uniform constant is the FALLBACK for card-less entries
 * (legacy/synthesized armies used only in tests) and the catalogue average target for per-card tuning. [DRAFT]
 */
export const SLG_SIEGE_VALUE_PER_CARD = 10;

/** Delay (ms) between an attacker clearing the garrison and the building-HP hit being settled (ADR-026 §4; "5-minute" rule). [DRAFT] */
export const SLG_SIEGE_DAMAGE_DELAY_MS = 5 * 60 * 1000;

/** Team-level injury lock (ms) applied to a defending team that loses a wave; injured teams never defend until healed (ADR-026 §5). [DRAFT] */
export const SLG_TEAM_INJURY_MS = 10 * 60 * 1000;

/** Building max HP from its level (ADR-026 §1). Floors at 1 so every building is destructible in finite hits. */
export function buildingMaxHp(level: number): number {
  return Math.max(1, Math.floor((Math.max(0, Math.floor(level)) || 0) * SLG_BASE_HP_PER_LEVEL) || SLG_BASE_HP_PER_LEVEL);
}

/**
 * NPC-tile symbolic base HP, scaled by tile level (2026-07-17 owner decision, option 2 "缓坡";
 * re-calibrated 40 → 80 on 2026-08-19 by ADR-069, see below):
 * the single-battle NPC capture paths (occupy / sweep / territory tile / stronghold / crossing) run one
 * `runSiegeBattle` whose in-engine defender base HP was originally a flat {@link BASE_HP}=100 regardless of
 * tile level — a low-level tile with a trivial garrison (npcGarrison(1)=120 = 2 infantry) still needed ~10
 * surviving infantry (siegeValue 11 each) to batter a 100-HP base, so "clear the garrison, fail to destroy
 * the base, time out → defender wins" was the common outcome. Scaling base HP with tile level makes low tiles
 * genuinely soft and high tiles a real wall, mirroring the player-city side where the base gate already scales
 * with wall level via {@link baseDurabilityMax}.
 *
 * NOT applied to the ADR-026 main-base WAVE path (arrival.ts pins defenderBaseLevel:0 and keeps the symbolic
 * base a minimal terminator — the real durability there is TileDoc.hp = baseDurabilityMax). Callers opt in by
 * passing `defenderBaseHp: npcBaseHp(tileLevel)` explicitly; {@link buildSiegeLevel} does no implicit
 * derivation.
 *
 * **2026-08-19 re-calibration (ADR-069), 40 → 60 per level.** The original 40/level was verified with
 * `tools/econ-sim/src/occupyBaseHpRun.ts`, which attacks with a SYNTHESIZED infantry army — one 60-HP unit
 * per 60 troops, so its unit count (and therefore its total base damage) grew with troops. Real marches
 * carry a card TEAM: at most {@link CARD_TEAM_MAX_SIZE} = 12 units regardless of troop count. Since base
 * damage was a flat per-unit `siegeValue` paid once on arrival, a card team's ENTIRE base damage was capped
 * around 150-190 — so 40/level made every tile from level 5 up (200+) unbreakable by any card team at any
 * troop count, while `SIEGE_CHEAP_RATIO` handed those very tiles over for free at 10× garrison. ADR-069
 * fixed the mechanism (siege value now scales with the troops a unit carries), which turned this constant
 * into a real, scalable gate for the first time — and at 40/level a mid-tier roster could then take level-10
 * land with ~24% of its troop capacity, i.e. tile level stopped gating anything. 60/level was picked with
 * `tools/econ-sim/src/occupyCardTeamRun.ts` (card-team model, the numbers 40/level never could produce)
 * against the ADR-034 §4 outer-ring level distribution, where 60% of neutral land is level 1-2 and 76% is
 * level 1-3: a starter (Lv.1, no gear) roster filled to capacity takes level 1-2 land, a mid (Lv.4) roster
 * reaches level 7 (the resource ring), and a veteran (Lv.8) roster reaches level 10 (the core ring) — with
 * the engine route staying well under the cheap-path shortcut at every level, so massing troops is never
 * the cheapest way in. Equipment (up to +60% siege value, EFFECT_CAPS.siegePct) shifts each tier roughly
 * one ring further, so the tables are the pessimistic edge of the band.
 *
 * **Why 60 and not 80** (both give the same tier→ring shape): the FLAT/synthesized attacker path — an
 * occupy march sent without a team — must keep satisfying the 2026-07-17 regression invariant that
 * `OCCUPY_MIN_TROOPS` (= GARRISON_PER_TILE = 500) captures a level-1 tile, i.e. the "cleared the garrison
 * but couldn't destroy the base" failure this constant was introduced to remove must not come back at the
 * lowest tile level. Measured minimum flat force for level 1: 420 troops at 60/level (comfortable margin)
 * vs 540 at 80/level — which broke that invariant outright. See `occupy-march.e2e.test.ts`'s
 * "base HP scales with tile level" case, which pins it.
 * [Econ-sim verified 2026-07-17 (base curve) + 2026-07-22 (robust to equipment/academy attacker hp bonuses up
 * to +20% — see ECONOMY_VERIFICATION_LOG.md §13-SLG-NPC-BASEHP) + 2026-08-19 (card-team re-calibration,
 * §13-SLG-NPC-BASEHP.2).]
 */
export const SLG_NPC_BASE_HP_PER_LEVEL = 60;

/** NPC-tile symbolic base HP for a given tile level (floors at one level so every tile has a destructible base). */
export function npcBaseHp(level: number): number {
  return SLG_NPC_BASE_HP_PER_LEVEL * Math.max(1, Math.floor(level) || 1);
}

// ── D-CITY-8: main-base durability (SLG_CITY_DESIGN §8.2, 锁定 2026-07-15) ─────────────────────────
// Replaces the old "wall temporarily buffs garrison HP during battle" mechanic (former WALL_DEFENSE_STEP/
// wallDefenseMult in city.ts, now removed): the main base's durability cap is instead driven persistently
// by the `wall` building level (not tile.level, unlike buildingMaxHp above), drained by siege value on the
// same delayed-hit path as ordinary building HP, and slowly self-heals between attacks. Numbers below are
// DRAFT placeholders pending an economy pass (doc's own admission, §8.2 "未决").

/** Durability floor for a main base with wall level 0. [DRAFT] */
export const BASE_DURABILITY_BASE = 300;
/** Durability added per `wall` building level. [DRAFT] */
export const BASE_DURABILITY_WALL_STEP = 200;
/** Passive durability regen, flat amount per hour, independent of max. [DRAFT] */
export const BASE_DURABILITY_REGEN_PER_HOUR = 50;

/** Main-base durability cap from the account's `wall` building level (D-CITY-8). */
export function baseDurabilityMax(wallLevel: number): number {
  return BASE_DURABILITY_BASE + Math.max(0, Math.floor(wallLevel) || 0) * BASE_DURABILITY_WALL_STEP;
}

/** Lazy linear-time regen: `current` healed by elapsed hours since `regenAt`, clamped to `max`. Pure — no I/O, no persistence. */
export function regenDurability(current: number, max: number, regenAt: number, now: number): number {
  if (current >= max) return max;
  const elapsedHours = Math.max(0, now - regenAt) / 3_600_000;
  return Math.min(max, current + elapsedHours * BASE_DURABILITY_REGEN_PER_HOUR);
}

/**
 * A team's siege value = sum of each card's siege-value attribute (ADR-026 §4; a per-card stat, same tier as attack/speed).
 * Only entries with a cardInstanceId count. When `cardInv` is provided, each card's value is resolved per-card/per-level
 * via {@link cardSiegeValue}; a card whose instance is missing from `cardInv` (and any call omitting `cardInv`, e.g. legacy
 * tests) falls back to the uniform SLG_SIEGE_VALUE_PER_CARD. Real teams always contain cards → value is always > 0.
 */
export function teamSiegeValue(
  army: ReadonlyArray<{ cardInstanceId?: string }>,
  cardInv?: Record<string, CardInstance>,
): number {
  let total = 0;
  for (const e of army) {
    if (!e.cardInstanceId) continue;
    const card = cardInv?.[e.cardInstanceId];
    total += card ? cardSiegeValue(card) : SLG_SIEGE_VALUE_PER_CARD;
  }
  return total;
}

/** Deterministic per-wave seed (ADR-026 §3): folds the wave index into the march's siege seed so each wave is uniquely and reproducibly determined. */
export function waveSeed(marchId: string, waveIndex: number): number {
  return siegeSeedFromId(`${marchId}#${waveIndex}`);
}

/**
 * Normalizes a defense config into a complete siege level object. `config` is the defender's customization (nullable); `tileLevel` is used to
 * derive a symbolic base-level defense when no customization is provided. Returns an object shaped like the client's LevelDefinition (loose object; avoids duplicating the engine schema in shared).
 * Pure function, deterministic, computable on either end.
 */
export function buildSiegeLevel(
  config: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
): Record<string, unknown> {
  const level: Record<string, unknown> = {
    id: `siege:${seed}`,
    chapter: 0,
    seed,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
  };
  if (config) {
    if (Array.isArray(config.garrison) && config.garrison.length > 0) level.garrison = config.garrison;
    if (Array.isArray(config.defenderBuildings) && config.defenderBuildings.length > 0) {
      level.defenderBuildings = config.defenderBuildings;
    }
    if (typeof config.defenderBaseLevel === 'number') {
      level.defenderBaseLevel = clampBaseLevel(config.defenderBaseLevel);
    }
  } else {
    // No custom defense → derive a symbolic base defense from tile level (deterministic; attacker wins by destroying the base).
    level.defenderBaseLevel = clampBaseLevel(Math.floor(tileLevel) - 1);
  }
  // Explicit per-level base HP (2026-07-17): honored regardless of the config/no-config branch above so the NPC
  // single-battle capture paths can scale the defender base with tile level (see {@link npcBaseHp}). No implicit
  // derivation from tileLevel here — the ADR-026 wave path deliberately omits it to keep its symbolic base minimal.
  if (config && typeof config.defenderBaseHp === 'number' && config.defenderBaseHp > 0) {
    level.defenderBaseHp = Math.max(1, Math.floor(config.defenderBaseHp));
  }
  return level;
}

/**
 * Siege auto-battle level (G3-2a, §16.3): extends {@link buildSiegeLevel} (defender lineup + dual bases +
 * objective:destroy_base) with the **attacker's pre-deployed army** (`attackerArmy`, owner0 in the bottom half) +
 * **hard battle time limit** (`battleTimeoutTicks`; timeout = defender wins). No live commands → battle outcome is
 * uniquely determined by `seed + both lineups` (worldsvc runs authoritatively headless; client replays with the same seed for spectating).
 *
 * Pure function, deterministic, computable on either end. Returns a loose object shaped like the client's LevelDefinition
 * (including attackerArmy / battleTimeoutTicks, validated by levelSchema).
 *
 * @param attacker Attacker lineup (`army` = GarrisonEntry[]; each unit has initialHp = allocated troops).
 * @param defender Defender config (garrison / defenderBuildings / defenderBaseLevel); same as buildSiegeLevel.
 * @param tileLevel Used to derive a symbolic base level when no defender customization is present.
 * @param seed Level seed (same seed for siege + re-computation/replay; ensures consistency).
 * @param battleTimeoutTicks Hard battle time limit; defaults to {@link SIEGE_BATTLE_TIMEOUT_TICKS}.
 */
export function buildSiegeBattle(
  attacker: { army?: unknown } | null | undefined,
  defender: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
  battleTimeoutTicks: number = SIEGE_BATTLE_TIMEOUT_TICKS,
): Record<string, unknown> {
  // Reuse the defender normalization (dual bases + destroy_base already included); then layer on the attacker army + time limit.
  const level = buildSiegeLevel(defender, tileLevel, seed);
  level.battleTimeoutTicks = Math.max(1, Math.floor(battleTimeoutTicks));
  if (attacker && Array.isArray(attacker.army) && attacker.army.length > 0) {
    level.attackerArmy = attacker.army;
  }
  return level;
}
