// ADR-074 wild-city siege — the numeric authority for the 野外城池 subsystem (`design/game/
// SLG_CITY_SIEGE_DESIGN.md`). Split out of siege.ts (which the design doc originally named as the
// source of truth) once the subsystem grew its own durability curve, wave ladder and ownership rules:
// siege.ts is already 500 lines of *tile*-scale settlement, and mixing a second, differently-shaped
// combat model into it would make both harder to calibrate.
//
// ⚠️ Every number in this file was measured by `server/tools/econ-sim/src/citySiegeRun.ts`, not derived
// on paper. The stronghold constants next door were hand-tuned twice against a model production does not
// actually use (see STRONGHOLD_GARRISON_PER_LEVEL's doc comment and ECONOMY_VERIFICATION_LOG.md
// §13-SLG-STRONGHOLD.5); that is the failure mode this file's calibration gate exists to prevent. The
// design doc's own DRAFT derivation was wrong twice for the same reason — see CITY_WAVE_GARRISON_PER_LEVEL.
//
// Re-run `npm run --workspace @nw/econ-sim city-siege` after touching ANY constant here, and after any
// change to TROOP_CAP_BASE / DRILL_TROOPCAP_STEP / DRILL_QUEUE_LEVEL_THRESHOLDS / TROOP_TRAIN_TIME_SEC /
// TRAIN_SPEEDUP_BUFF_MULT / card `troopCapBase`-`troopCapGrowth`-`siegeValueBase` / EFFECT_CAPS /
// SIEGE_SYNTH_ARMY_MAX_TROOPS — the whole model hangs off those.

import { SLG_MAP_MAX_LEVEL } from './core';
import { OUTER_GRADED_CITY_TIERS } from './mapgen/cities';

/** The three city node kinds that can be besieged (mirrors `MapEditorCityNode['kind']`). */
export type CityKind = 'capital' | 'worldCenter' | 'garrison';

/**
 * Lowest level any wild city generates at — the city the single-player-proof invariant is measured
 * against. It is the WEAKEST city that is dangerous, not the strongest: a low-level city has the
 * cheapest wave ladder, so it is where one player's damage-per-hour comes closest to the regen rate.
 */
export const WILD_CITY_MIN_LEVEL = Math.min(...OUTER_GRADED_CITY_TIERS);
/** Highest level any wild city generates at (province capitals + world center are always map-max). */
export const WILD_CITY_MAX_LEVEL = SLG_MAP_MAX_LEVEL;

// ── Wave ladder ──────────────────────────────────────────────────────────────────────────────────
/**
 * NPC defender waves one attacking march must fight through, at every city level.
 *
 * **Flat, not `3 + floor(level/3)` as the design doc drafted.** A march carries a fixed 12-card team and
 * its survivors carry over between waves scaled by each wave's survival ratio, so wave count compounds
 * multiplicatively: measured, a 4th and 5th wave at level 10 push the ladder past what ANY roster the
 * game can produce clears (a geared Lv.7 roster clears 3 waves at level 10 and fails at 4). A level-10
 * city that literally cannot be damaged by anyone is worse than one that can — the level scaling lives
 * in {@link CITY_WAVE_GARRISON_PER_LEVEL} and {@link CITY_WAVE_BASE_HP_PER_LEVEL} instead, which raise the
 * ladder's *price* smoothly rather than its clearability as a cliff.
 *
 * **Every attacking march faces the full ladder.** The design doc's original model — waves are shared
 * city state, a defeated wave respawns after {@link CITY_WAVE_RESPAWN_MS} — is unimplementable: once the
 * shared ladder is empty, every march arriving inside the respawn window meets no defenders, and
 * `applyBaseSiege` schedules the FULL durability hit when `defenders.length === 0`. One player with
 * `SIEGE_TEAM_CAP` = 5 teams and a ~24-second round trip to an adjacent city would land dozens of
 * zero-cost hits per window, which removes the only bound on solo damage per hour that exists.
 */
export const CITY_WAVE_COUNT = 3;
/**
 * NPC troops per defender wave, per city level. This is the constant that sets the **troop cost of one
 * siege**, hence how many sieges an attacker's hourly troop budget buys, hence the whole
 * single-player-proof margin. Far more sensitive than {@link CITY_DURABILITY_PER_LEVEL}.
 *
 * **Why 210 and not the design doc's DRAFT 1180** (borrowed from `STRONGHOLD_GARRISON_PER_LEVEL`), which
 * would make a level-10 city's total ladder 70,800 troops:
 *
 *  1. **Hard ceiling at `SIEGE_SYNTH_ARMY_MAX_TROOPS` (9,600).** Above it, worldsvc's
 *     `shouldUseCheapSiege` routes the wave to the cheap linear `resolveSiege`, where the attacker loses
 *     EXACTLY the garrison's troop count and card quality is irrelevant. 1180/level crosses that line at
 *     level 9. `citySiegeRun.ts` gate ③ pins the ceiling.
 *  2. **A card team's troop ceiling is ~4,800, not the troop pool.** An `attack` march carries a 12-card
 *     team and each card's allotment is capped at `cardTroopCap` — 4×600 + 8×300 at Lv.9. The
 *     `satchel`/`drillYard` caps (20,000) never bind. The design doc derived its `p` by dividing the
 *     whole POOL by an assumed ~2,000-troop cost per siege; the pool bounds how many sieges you can
 *     REFILL, never how big one is.
 *  3. Consequence of (1)+(2): the per-wave garrison cannot exceed what a 12-card team grinds through
 *     {@link CITY_WAVE_COUNT} times over. At 210/level a level-10 wave is 2,100 troops (6,300 for the
 *     whole ladder) — comfortably engine-decided at every level, and clearable by a geared Lv.6 roster.
 *     At 300/level a geared Lv.7 roster already fails level 10 outright (measured).
 *
 * A city's total ladder (6,300 at level 10) is therefore *smaller* than a stronghold's single garrison
 * (11,800). That is not an inversion of intent: a stronghold is a one-shot capture, a city is three
 * waves plus a {@link cityDurabilityMax}-deep wall that regenerates faster than one player can chip it.
 */
export const CITY_WAVE_GARRISON_PER_LEVEL = 210;
/**
 * Engine base-HP ceiling (`defenderBaseHp`) of each defender wave, per city level — **the dominant
 * attrition lever**, and the one number that makes the wave ladder cost anything at all.
 *
 * A wave's engine "base" is a battle terminator, not a real structure (the city's real durability is
 * `CityDoc.durability`, drained separately on the delayed `siegeDamage` path). But its size decides how
 * long the attacking team has to stand inside the garrison's fire before the wave ends, and therefore
 * how many troops the wave costs. `applyBaseSiege` omits it entirely for main-base waves, falling back
 * to the engine's flat `BASE_HP = 100` — and since ADR-069 made a unit's siege value scale with the
 * troops it carries, a single 300-troop shieldbearer one-shots a 100-HP base, ending the wave before the
 * garrison ever engages. Measured (citySiegeRun.ts): a maxed team clears a 4,500-troop wave losing ~99
 * troops at baseHp=100 versus ~730 at baseHp=600. A city ladder with no explicit base HP is FREE.
 *
 * Deliberately a different slope from `SLG_NPC_BASE_HP_PER_LEVEL` (60/level, the ordinary tile-capture
 * value): a city wave is fought {@link CITY_WAVE_COUNT} times per march with survivors carrying over, so
 * 60/level compounds into an unclearable ladder from level 10 down (measured — a geared Lv.7 roster
 * fails level 10 at 60/level and clears it at 45/level).
 */
export const CITY_WAVE_BASE_HP_PER_LEVEL = 45;
/**
 * How long a *defeated defender team* is locked out of a city's wave ladder (P3: when a sect owns the
 * city, its stationed teams take the front wave slots ahead of the NPC ladder). Mirrors
 * `SLG_TEAM_INJURY_MS` deliberately — it is the same "your team is spent, come back later" rule the
 * main-base siege already applies to defenders. **It does not apply to the NPC ladder**, which is
 * per-march and always at full strength; see {@link CITY_WAVE_COUNT} for why.
 */
export const CITY_WAVE_RESPAWN_MS = 10 * 60 * 1000;

/** Defender wave count for a city level (flat — see {@link CITY_WAVE_COUNT}). */
export function cityWaveCount(_level: number): number {
  return CITY_WAVE_COUNT;
}
/** NPC troops in one defender wave of a city at `level`. */
export function cityWaveGarrison(level: number): number {
  return CITY_WAVE_GARRISON_PER_LEVEL * Math.max(1, Math.floor(level));
}
/** Engine base-HP ceiling of one defender wave of a city at `level`. */
export function cityWaveBaseHp(level: number): number {
  return CITY_WAVE_BASE_HP_PER_LEVEL * Math.max(1, Math.floor(level));
}
/** Total NPC troops one attacking march must fight through to reach the wall (the full ladder). */
export function cityLadderGarrison(level: number): number {
  return cityWaveCount(level) * cityWaveGarrison(level);
}

// ── Durability + regen ───────────────────────────────────────────────────────────────────────────
//
// Both curves are `base + step × level`, and the BASE dominates. That shape is forced by measurement,
// not chosen for taste:
//
//   · The solo-proof floor is set at the WEAKEST city (level 3) — the cheapest ladder, where one
//     player's damage rate peaks. That floor is a large absolute number (~28,700 durability / ~13,500
//     regen per hour), independent of level.
//   · Per-siege troop cost RISES with city level (garrison and wave base HP both scale), so a given
//     roster's damage per hour FALLS with city level — measured ~2.7× from level 3 to level 10. With
//     purely level-proportional durability the attackers-needed curve would therefore grow as ~L², and
//     a level-10 capital would need >100 developed players against a level-3 city's 13.
//
// A large base plus a small per-level step keeps the attackers-needed curve close to the design's
// intended 12→40 shape while still clearing the solo-proof floor at level 3. The level scaling that
// players actually feel lives in the wave ladder (who can even land a hit), not in the wall's depth.

/** Durability floor every wild city has, before its level bonus. */
export const CITY_DURABILITY_BASE = 26_000;
/** Durability added per city level. */
export const CITY_DURABILITY_PER_LEVEL = 900;
/**
 * Regen floor every wild city has, per hour — **the single-player 闸门**. A lone attacker's sustained
 * damage rate is bounded by troop-training throughput divided by per-siege troop cost; as long as this
 * exceeds that bound with every purchasable multiplier stacked, a solo player's progress is永远 negative
 * rather than merely slow. Measured margin at the weakest city: ~2× over a fully maxed, geared,
 * speedup-buffed solo attacker (citySiegeRun.ts gate ①).
 *
 * Do not substitute durability for this: durability only buys time (a solo player grinding for a week
 * still wins), regen deletes the solo solution outright.
 */
export const CITY_REGEN_BASE = 12_000;
/** Regen added per city level, per hour. */
export const CITY_REGEN_PER_LEVEL = 500;
/**
 * Post-capture protection window for a wild city (§7). Deliberately much shorter than the main base's
 * `PROTECTION_SEC` (8h): a captured city ALSO resets to full durability for its new owner, so retaking it
 * already costs a second complete assault. The main base gets no such reset (it relocates instead), which
 * makes its shield the only protection it has. This window exists only to stop a losing sect from flipping
 * the city back with a second wave it had already staged a few minutes behind the first.
 */
export const CITY_CAPTURE_PROTECTION_MS = 2 * 60 * 60 * 1000;

/** Durability + regen multiplier for the world center (the single contested core-province objective). */
export const CITY_WORLD_CENTER_MULT = 2;

/** Multiplier applied to a city's durability and regen for its kind. */
export function cityKindMult(kind: CityKind): number {
  return kind === 'worldCenter' ? CITY_WORLD_CENTER_MULT : 1;
}
/** Full durability of a city. */
export function cityDurabilityMax(level: number, kind: CityKind): number {
  const lvl = Math.max(1, Math.floor(level));
  return Math.round((CITY_DURABILITY_BASE + CITY_DURABILITY_PER_LEVEL * lvl) * cityKindMult(kind));
}
/** Durability a city regenerates per hour. */
export function cityRegenPerHour(level: number, kind: CityKind): number {
  const lvl = Math.max(1, Math.floor(level));
  return Math.round((CITY_REGEN_BASE + CITY_REGEN_PER_LEVEL * lvl) * cityKindMult(kind));
}
/**
 * Lazy durability regen — `current` healed by the hours elapsed since `regenAt`, clamped to `max`. Pure,
 * no timers, no I/O (the same shape as `regenDurability` for main bases; the rate is per-city here rather
 * than a global constant, so it takes an explicit `ratePerHour`).
 */
export function regenCityDurability(current: number, max: number, regenAt: number, now: number, ratePerHour: number): number {
  if (current >= max) return max;
  const elapsedHours = Math.max(0, now - regenAt) / 3_600_000;
  return Math.min(max, current + elapsedHours * ratePerHour);
}

// ── City-node lookup + doc identity ──────────────────────────────────────────────────────────────
/** Mongo `_id` of a city document (mirrors `playerWorldId`'s shape). */
export function cityDocId(worldId: string, nodeId: string): string {
  return `city:${worldId}:${nodeId}`;
}

/**
 * Rank used to break footprint overlaps: world center beats a province capital beats a graded city.
 * Must stay identical to `CITY_PAINT_RANK` in mapEdit.ts and to the capitals-first order
 * `_cityGroundNodeAt` walks — two cities' plots DO overlap in practice (a map-edge city has its anchor
 * clamped back inside the map), and from ADR-074 P1 on the winner decides the cell's level, which is the
 * besieged city's durability and garrison scale.
 */
export const CITY_KIND_RANK: Record<CityKind, number> = { worldCenter: 0, capital: 1, garrison: 2 };

/** The minimal city-node shape this lookup needs (structurally satisfied by `MapEditorCityNode` and by worldsvc's `CityDoc`). */
export interface CityFootprintNode {
  kind: CityKind;
  x: number;
  y: number;
  footprint: number;
}

/**
 * The city whose footprint covers (x,y), or null. Overlaps resolve by {@link CITY_KIND_RANK} so this
 * agrees with `rasterizeMapEdits` and `_cityGroundNodeAt` about which city owns a contested cell — the
 * three must not drift (a 2026-08-25 P0 bug was exactly that drift, see SLG_CITY_SIEGE_DESIGN §10-P0).
 *
 * Shared rather than duplicated per caller because three call sites need the same answer: the server's
 * siege validation ("which city is this march attacking"), the server's arrival settlement, and the
 * client's map click ("which city's panel do I open").
 */
export function cityNodeCovering<T extends CityFootprintNode>(nodes: readonly T[], x: number, y: number): T | null {
  let best: T | null = null;
  for (const node of nodes) {
    const r = (node.footprint - 1) / 2;
    if (Math.abs(x - node.x) > r || Math.abs(y - node.y) > r) continue;
    if (!best || CITY_KIND_RANK[node.kind] < CITY_KIND_RANK[best.kind]) best = node;
  }
  return best;
}
