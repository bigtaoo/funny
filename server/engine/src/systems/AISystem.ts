import {
  ATTACK_LANES,
  BOARD_COLS,
  BOARD_ROWS,
  CARD_DEFINITIONS,
  INK_CAP,
  TOP_BUILDING_ROW,
} from '../config';
import { Prng } from '../math/prng';
import { GameState } from '../GameState';
import {
  AIDifficulty,
  BuildingType,
  CardDefinition,
  CardType,
  OwnerId,
  PlayerCommand,
  Side,
  SpellType,
  UnitBlueprint,
  UnitType,
} from '../types';

export type { AIDifficulty };

interface DifficultyParams {
  /** Decision pacing in integer ticks (lower = acts more often). Floor is 12 ticks
   *  (0.4 s) — a professional-player reaction cadence, never frame-perfect. */
  thinkIntervalTicks: number;
  /** Enemy units at row ≥ this (closer to the AI base at row 17) trigger defense. */
  dangerRow: number;
  /** Own base HP ≤ this is treated as an emergency. */
  lowBaseHp: number;
  /** Spend meteor on enemy clusters (defensively near base / offensively anywhere). */
  useMeteor: boolean;
  /** Place arrow towers to defend pressured lanes. */
  useTowers: boolean;
  /** Build barracks for sustained pressure. */
  useBarracks: boolean;
  /** Minimum units inside the 2×2 footprint to justify an offensive meteor. */
  meteorOffenseCluster: number;
  /** Cast Haste on a push instead of only ever using Meteor (tempo play). */
  useHaste: boolean;
  /** Score every affordable unit card against the enemies actually on the board
   *  (config-driven matchup math) instead of a fixed species preference order. */
  useCounterPicking: boolean;
  /** Gate offensive AOE by ink-value (only nuke a cluster worth more than the spell). */
  useValueTrades: boolean;
  /** Track a short rolling window of per-lane threat to reinforce a lane that is
   *  building up pressure, instead of reacting only once it is already dangerous. */
  useThreatMemory: boolean;
}

/**
 * 10-level difficulty curve, L1 (passive punching bag) → L10 (professional-level
 * play). Every axis is continuous/monotonic across levels; new capabilities
 * (counter-picking, value trades, threat memory) unlock at the level where a
 * human opponent would start noticing that kind of play — they don't appear as
 * a single "hard mode" cliff.
 */
const DIFFICULTY: Record<AIDifficulty, DifficultyParams> = {
  1:  { thinkIntervalTicks: 75, dangerRow: 16, lowBaseHp: 20, useMeteor: false, useTowers: false, useBarracks: false, meteorOffenseCluster: 99, useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  2:  { thinkIntervalTicks: 65, dangerRow: 15, lowBaseHp: 24, useMeteor: false, useTowers: true,  useBarracks: true,  meteorOffenseCluster: 99, useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  3:  { thinkIntervalTicks: 55, dangerRow: 14, lowBaseHp: 30, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 5,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  4:  { thinkIntervalTicks: 48, dangerRow: 13, lowBaseHp: 35, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 4,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  5:  { thinkIntervalTicks: 42, dangerRow: 12, lowBaseHp: 40, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 4,  useHaste: false, useCounterPicking: false, useValueTrades: false, useThreatMemory: false },
  6:  { thinkIntervalTicks: 36, dangerRow: 11, lowBaseHp: 45, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 3,  useHaste: false, useCounterPicking: true,  useValueTrades: false, useThreatMemory: false },
  7:  { thinkIntervalTicks: 30, dangerRow: 10, lowBaseHp: 50, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 3,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: false },
  8:  { thinkIntervalTicks: 24, dangerRow: 8,  lowBaseHp: 53, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
  9:  { thinkIntervalTicks: 18, dangerRow: 6,  lowBaseHp: 56, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
  10: { thinkIntervalTicks: 12, dangerRow: 4,  lowBaseHp: 60, useMeteor: true,  useTowers: true,  useBarracks: true,  meteorOffenseCluster: 2,  useHaste: true,  useCounterPicking: true,  useValueTrades: true,  useThreatMemory: true  },
};

/** At most this many AI barracks at once (also bounded by the 2 barracks cards). */
const MAX_BARRACKS = 2;

/** How many past decideTick snapshots {@link DifficultyParams.useThreatMemory} keeps to detect a rising lane. */
const THREAT_HISTORY_LEN = 5;

/** Legacy fallback preference order for levels below {@link DifficultyParams.useCounterPicking}. */
const LEGACY_DEFENSE_PREFERENCE = [UnitType.ShieldBearer, UnitType.Infantry, UnitType.Archer];
const LEGACY_OFFENSE_PREFERENCE = [UnitType.Infantry, UnitType.Archer, UnitType.ShieldBearer];

/**
 * AISystem — reads game state, returns PlayerCommand[] for this tick.
 * Does NOT mutate state; commands are processed by GameEngine.processCommand().
 * Uses integer tick counts for decision pacing — no floating-point timers.
 *
 * The AI plays the Top side (owner 1, base at row {@link TOP_BUILDING_ROW}).
 * Enemy units are Side.Bottom advancing toward row 17 — the higher an enemy's
 * row, the closer it is to the AI base, the greater the threat.
 *
 * ── Fair-play invariant (replays are reviewable — this must never break) ──
 * The AI only reads `state.topPlayer` (its own hand/ink/base) and public board
 * state (`state.board.units` / `state.board.buildings`, visible to both
 * players). It NEVER reads `state.bottomPlayer.hand` or peeks at future card
 * draws — every decision must be explainable as "what a human could infer from
 * the visible board", because match replays are reviewed by players. Speed is
 * bounded too: `thinkIntervalTicks` never drops below 12 ticks (0.4 s), so even
 * L10 reacts at a fast-but-human cadence, not frame-perfect.
 *
 * Decision pipeline (one action per think interval, highest priority wins):
 *   1. Emergency defense — meteor a cluster near the base, drop an arrow tower
 *      in the most-pressured lane, or block with a counter-picked unit.
 *   2. Upgrade planning — bank toward / buy a base upgrade when it is safe and
 *      actually reachable (guarded by INK_CAP).
 *   3. Economy & offense — seed barracks, nuke fat enemy clusters (gated by
 *      ink-value at higher levels), haste a push, then push a counter-picked
 *      unit down the least-defended (or fastest-rising, L8+) lane.
 *
 * Determinism: every branch reads only game state + the injected {@link Prng},
 * so the same seed + command stream reproduces identically (golden replay).
 */
export class AISystem {
  private thinkTick: number = 0;
  private readonly params: DifficultyParams;
  /** Rolling window of per-column threat snapshots, most recent last (useThreatMemory). */
  private readonly threatHistory: number[][] = [];

  constructor(
    private readonly rng: Prng,
    readonly difficulty: AIDifficulty = 5,
  ) {
    this.params = DIFFICULTY[difficulty];
  }

  decideTick(tick: number, state: GameState): PlayerCommand[] {
    this.thinkTick++;
    if (this.thinkTick < this.params.thinkIntervalTicks) return [];
    this.thinkTick = 0;
    return this.makeDecision(tick, state);
  }

  // ─── Top-level decision ────────────────────────────────────────────────────

  private makeDecision(tick: number, state: GameState): PlayerCommand[] {
    const player = state.topPlayer;
    const owner: OwnerId = 1;

    const threat = this.computeThreatByCol(state);
    if (this.params.useThreatMemory) this.recordThreatHistory(threat);
    const totalThreat = threat.reduce((a, b) => a + b, 0);
    const imminent = this.countNearBaseEnemies(state);
    const underPressure = imminent > 0 || player.baseHp <= this.params.lowBaseHp;

    // ── 1. Emergency defense ─────────────────────────────────────────────────
    if (underPressure) {
      const defense = this.tryDefend(state, owner, tick, threat);
      if (defense) return [defense];
    }

    // ── 2. Upgrade planning (only when reachable and safe) ───────────────────
    if (this.upgradeReachable(player) && totalThreat === 0) {
      if (player.canUpgradeBase()) {
        return [{ type: 'upgrade_base', owner, tick }];
      }
      // Close to affording the next upgrade — bank ink instead of spending.
      const next = player.nextUpgradeCost!;
      if (player.ink >= Math.floor(next * 0.6)) return [];
    }

    // ── 3. Economy & offense ─────────────────────────────────────────────────

    // Seed barracks early for a steady unit stream (placed in a safe lane).
    if (this.params.useBarracks && this.countOwnBarracks(state) < MAX_BARRACKS) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Building && c.buildingType === BuildingType.Barracks);
      if (idx !== null) {
        const lane = this.freeBuildingLane(state, threat, /*preferSafe*/ true);
        if (lane !== null) {
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: lane }];
        }
      }
    }

    // Offensive meteor on a fat enemy cluster anywhere on the board (ink-value
    // gated at higher levels so the AI doesn't trade a 12-cost spell for scraps).
    if (this.params.useMeteor) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
      if (idx !== null) {
        const meteorCost = this.params.useValueTrades ? player.hand.cards[idx]!.cost : 0;
        const target = this.findMeteorTarget(state, this.params.meteorOffenseCluster, false, meteorCost);
        if (target) {
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row }];
        }
      }
    }

    // Haste a push when a friendly wave is already advancing — a tempo tool the
    // AI previously never touched.
    if (this.params.useHaste) {
      const haste = this.tryHaste(state, owner, tick);
      if (haste) return [haste];
    }

    // Push a counter-picked (or, below the threshold, preference-ordered) unit
    // down the least-defended lane — or the fastest-rising one, at L8+.
    const lane = this.chooseOffenseLane(threat);
    if (lane !== null) {
      const unitIdx = this.pickUnitCard(state, player.hand.cards, player.ink, lane, /*forDefense*/ false);
      if (unitIdx !== null) {
        return [{ type: 'play_card', owner, tick, handIndex: unitIdx, col: lane }];
      }
    }

    return [];
  }

  // ─── Emergency defense ─────────────────────────────────────────────────────

  private tryDefend(
    state: GameState,
    owner: OwnerId,
    tick: number,
    threat: number[],
  ): PlayerCommand | null {
    const player = state.topPlayer;

    // a) Meteor the densest cluster pressing the base (defense is never value-gated —
    //    saving the base is always worth the spell).
    if (this.params.useMeteor) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
      if (idx !== null) {
        const target = this.findMeteorTarget(state, 2, /*preferNearBase*/ true, 0);
        if (target) {
          return { type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row };
        }
      }
    }

    // b) Arrow tower in the most-pressured open building lane.
    if (this.params.useTowers) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Building && c.buildingType === BuildingType.ArrowTower);
      if (idx !== null) {
        const lane = this.freeBuildingLane(state, threat, /*preferSafe*/ false);
        if (lane !== null) {
          return { type: 'play_card', owner, tick, handIndex: idx, col: lane };
        }
      }
    }

    // c) Block the most-threatened lane with a counter-picked (or preference-order) body.
    const lane = this.pickLane(threat, /*mostThreatened*/ true);
    if (lane !== null) {
      const unitIdx = this.pickUnitCard(state, player.hand.cards, player.ink, lane, /*forDefense*/ true);
      if (unitIdx !== null) {
        return { type: 'play_card', owner, tick, handIndex: unitIdx, col: lane };
      }
    }

    return null;
  }

  // ─── Tempo: Haste ──────────────────────────────────────────────────────────

  /**
   * Cast Haste on an already-advancing friendly push — a pure tempo tool, only
   * considered once emergency defense has already been ruled out for this tick.
   * Targets the column with the most friendly (Top) units (an active push worth
   * accelerating); requires at least 2 units there so it's never wasted solo.
   */
  private tryHaste(state: GameState, owner: OwnerId, tick: number): PlayerCommand | null {
    const player = state.topPlayer;
    const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
      c.cardType === CardType.Spell && c.spellType === SpellType.Haste);
    if (idx === null) return null;

    const perCol = new Map<number, number>();
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Top || unit.isDead) continue;
      perCol.set(unit.col, (perCol.get(unit.col) ?? 0) + 1);
    }
    if (perCol.size === 0) return null;

    let bestCol: number | null = null;
    let bestCount = 1; // require at least 2 friendly units to justify the spell
    for (const [col, count] of perCol) {
      if (count > bestCount) { bestCount = count; bestCol = col; }
    }
    if (bestCol === null) return null;
    return { type: 'play_card', owner, tick, handIndex: idx, col: bestCol };
  }

  // ─── Threat assessment ─────────────────────────────────────────────────────

  /**
   * Per-column threat from Bottom units, weighted by proximity to the AI base.
   * A unit one step from the base (row 16) weighs far more than one just spawned.
   */
  private computeThreatByCol(state: GameState): number[] {
    const threat = new Array(BOARD_COLS).fill(0);
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom || unit.isDead) continue;
      const col = unit.col;
      if (col < 0 || col >= BOARD_COLS) continue;
      // row 0..17 → weight 1..18; closer to row 17 (AI base) = heavier.
      threat[col] += unit.row + 1;
    }
    return threat;
  }

  /** Count of enemy units that have advanced into the danger zone near the base. */
  private countNearBaseEnemies(state: GameState): number {
    let count = 0;
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom || unit.isDead) continue;
      if (unit.row >= this.params.dangerRow) count++;
    }
    return count;
  }

  /** Push the latest snapshot into the rolling window, keeping at most {@link THREAT_HISTORY_LEN}. */
  private recordThreatHistory(threat: number[]): void {
    this.threatHistory.push(threat);
    if (this.threatHistory.length > THREAT_HISTORY_LEN) this.threatHistory.shift();
  }

  /**
   * Lane whose threat has climbed the most since the oldest snapshot still held
   * (only meaningful once the window has a few samples). Lets L8+ reinforce a
   * lane that's visibly building up before it becomes an emergency, purely from
   * its own past public-state computations — no lookahead, no hidden info.
   */
  private mostRisingLane(): number | null {
    if (this.threatHistory.length < 3) return null;
    const oldest = this.threatHistory[0]!;
    const latest = this.threatHistory[this.threatHistory.length - 1]!;
    let bestLane: number | null = null;
    let bestDelta = 0;
    for (const lane of ATTACK_LANES) {
      const delta = latest[lane]! - oldest[lane]!;
      if (delta > bestDelta) { bestDelta = delta; bestLane = lane; }
    }
    return bestLane;
  }

  // ─── Lane selection ────────────────────────────────────────────────────────

  /**
   * Pick an attack lane by threat. `mostThreatened` chooses the lane with the
   * heaviest enemy presence (defense); otherwise the lightest (offensive push).
   * Ties are broken with the injected PRNG for unpredictability.
   */
  private pickLane(threat: number[], mostThreatened: boolean): number | null {
    let best = mostThreatened ? -Infinity : Infinity;
    const tied: number[] = [];
    for (const lane of ATTACK_LANES) {
      const t = threat[lane]!;
      const better = mostThreatened ? t > best : t < best;
      if (better) {
        best = t;
        tied.length = 0;
        tied.push(lane);
      } else if (t === best) {
        tied.push(lane);
      }
    }
    if (tied.length === 0) return null;
    return tied[this.rng.nextInt(tied.length)]!;
  }

  /** Offense lane pick: fastest-rising lane at L8+ (if one exists), else the least-threatened lane. */
  private chooseOffenseLane(threat: number[]): number | null {
    if (this.params.useThreatMemory) {
      const rising = this.mostRisingLane();
      if (rising !== null) return rising;
    }
    return this.pickLane(threat, /*mostThreatened*/ false);
  }

  /**
   * Pick an open building lane (no own building at the building row).
   * `preferSafe` puts barracks where they survive (lowest threat); otherwise
   * towers go where the pressure is highest.
   */
  private freeBuildingLane(state: GameState, threat: number[], preferSafe: boolean): number | null {
    let bestLane: number | null = null;
    let bestScore = preferSafe ? Infinity : -Infinity;
    for (const lane of ATTACK_LANES) {
      if (state.board.hasBuildingAt(lane, TOP_BUILDING_ROW)) continue;
      const t = threat[lane]!;
      if (preferSafe ? t < bestScore : t > bestScore) {
        bestScore = t;
        bestLane = lane;
      }
    }
    return bestLane;
  }

  private countOwnBarracks(state: GameState): number {
    let count = 0;
    for (const b of state.board.buildings.values()) {
      if (b.side === Side.Top && b.buildingType === BuildingType.Barracks && !b.isDead) count++;
    }
    return count;
  }

  // ─── Card selection ────────────────────────────────────────────────────────

  /** First affordable hand slot matching `pred`, or null. */
  private findCardIndex(
    cards: (CardDefinition | null)[],
    ink: number,
    pred: (c: CardDefinition) => boolean,
  ): number | null {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!card || ink < card.cost) continue;
      if (pred(card)) return i;
    }
    return null;
  }

  /**
   * Choose an affordable unit card for `lane`. Below {@link DifficultyParams.useCounterPicking}
   * this keeps the original fixed species-preference order (deliberately unsophisticated,
   * mirrors a beginner always reaching for the same card). At/above the threshold it scores
   * every affordable unit card generically from public {@link UnitBlueprint} stats against
   * whatever enemy units are actually sitting in that lane — no hardcoded per-unit-id table,
   * so it scales to the whole card pool (including units the legacy preference list never
   * touched: Max/Lena/Mara/Runner/Ironclad/Berserker/Splitter/Harpy/Medic).
   */
  private pickUnitCard(
    state: GameState,
    cards: (CardDefinition | null)[],
    ink: number,
    lane: number,
    forDefense: boolean,
  ): number | null {
    if (!this.params.useCounterPicking) {
      const preference = forDefense ? LEGACY_DEFENSE_PREFERENCE : LEGACY_OFFENSE_PREFERENCE;
      for (const want of preference) {
        const idx = this.findCardIndex(cards, ink, (c) =>
          c.cardType === CardType.Unit && c.unitType === want);
        if (idx !== null) return idx;
      }
      return null;
    }

    const enemyBps = this.enemyBlueprintsInLane(state, lane);
    let bestIdx: number | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!card || card.cardType !== CardType.Unit || !card.unitType) continue;
      if (ink < card.cost) continue;
      const bp = state.unitBlueprints[card.unitType];
      const score = this.counterScore(bp, enemyBps) / card.cost;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  /** Public {@link UnitBlueprint}s for enemy (Bottom) units currently standing in `lane`. */
  private enemyBlueprintsInLane(state: GameState, lane: number): UnitBlueprint[] {
    const out: UnitBlueprint[] = [];
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom || unit.isDead || unit.col !== lane) continue;
      out.push(state.unitBlueprints[unit.unitType]);
    }
    return out;
  }

  /**
   * Generic matchup score for `candidate` against a set of enemy blueprints,
   * derived only from stats every player can see on both units (HP / attack /
   * attack interval / range / armor / flying). Higher = candidate trades better.
   * With no enemies present this returns 0 (any unit is fine to send).
   */
  private counterScore(candidate: UnitBlueprint, enemies: UnitBlueprint[]): number {
    if (enemies.length === 0) return 0;
    let score = 0;
    for (const enemy of enemies) {
      const dmgToEnemy = Math.max(1, candidate.attack - (enemy.armor ?? 0));
      const dmgFromEnemy = Math.max(1, enemy.attack - (candidate.armor ?? 0));
      const candidateDps = dmgToEnemy / candidate.attackInterval;
      const enemyDps = dmgFromEnemy / enemy.attackInterval;
      const timeToKill = enemy.hp / Math.max(0.01, candidateDps);
      const timeToDie = candidate.hp / Math.max(0.01, enemyDps);
      score += timeToDie - timeToKill;
      // Range advantage: hits before the enemy can reply.
      score += (candidate.range - enemy.range) * 2;
      // Can't touch a flyer without canTargetFlying — a hard counter, not a soft one.
      if (enemy.flying && !candidate.canTargetFlying) score -= 50;
    }
    return score / enemies.length;
  }

  // ─── Meteor targeting ──────────────────────────────────────────────────────

  /**
   * Find the best 2×2 anchor for a meteor over enemy (Bottom) units.
   * Returns the top-left cell of the footprint, or null if no cluster reaches
   * `minCount` — or, when `minCostForValue > 0` ({@link DifficultyParams.useValueTrades}),
   * if the enemies' own card cost (public knowledge: every unit type has a known
   * ink cost) doesn't clear that many times the spell's own cost. That keeps the
   * AI from nuking a lone 3-ink Runner with a 12-ink Meteor.
   * With `preferNearBase`, ties favour the footprint closest to the AI base
   * (highest row) so defensive nukes land on the most urgent threat.
   */
  private findMeteorTarget(
    state: GameState,
    minCount: number,
    preferNearBase: boolean,
    minCostForValue: number,
  ): { col: number; row: number } | null {
    // Count enemy units (and index by cell for footprint scans) per integer cell.
    const cell: Map<number, number> = new Map();
    const unitsByCell: Map<number, UnitType[]> = new Map();
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom || unit.isDead) continue;
      const key = unit.row * BOARD_COLS + unit.col;
      cell.set(key, (cell.get(key) ?? 0) + 1);
      const list = unitsByCell.get(key);
      if (list) list.push(unit.unitType); else unitsByCell.set(key, [unit.unitType]);
    }
    if (cell.size === 0) return null;

    let best: { col: number; row: number } | null = null;
    let bestCount = minCount - 1;
    let bestRow = -1;
    const at = (c: number, r: number) =>
      (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) ? 0 : (cell.get(r * BOARD_COLS + c) ?? 0);
    const unitsAt = (c: number, r: number): UnitType[] =>
      (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) ? [] : (unitsByCell.get(r * BOARD_COLS + c) ?? []);

    // Anchor scan: footprint covers cols [c, c+1], rows [r, r+1].
    for (let r = 0; r <= BOARD_ROWS - 2; r++) {
      for (let c = 0; c <= BOARD_COLS - 2; c++) {
        const count = at(c, r) + at(c + 1, r) + at(c, r + 1) + at(c + 1, r + 1);
        if (count < minCount) continue;
        if (minCostForValue > 0) {
          const units = [...unitsAt(c, r), ...unitsAt(c + 1, r), ...unitsAt(c, r + 1), ...unitsAt(c + 1, r + 1)];
          const totalCost = units.reduce((sum, t) => sum + this.estimateUnitCost(t), 0);
          if (totalCost < minCostForValue * 1.3) continue;
        }
        if (count > bestCount || (count === bestCount && preferNearBase && r > bestRow)) {
          bestCount = count;
          bestRow = r;
          best = { col: c, row: r };
        }
      }
    }
    return best;
  }

  /** Public knowledge: the ink cost of the cheapest pool card that spawns `type` (0 if none). */
  private estimateUnitCost(type: UnitType): number {
    let min = Infinity;
    for (const c of CARD_DEFINITIONS) {
      if (c.unitType === type && c.cost < min) min = c.cost;
    }
    return Number.isFinite(min) ? min : 0;
  }

  // ─── Economy ───────────────────────────────────────────────────────────────

  /**
   * Whether a base upgrade is even reachable under the current ink cap.
   * BASE_UPGRADE_COSTS can exceed INK_CAP, in which case upgrade planning is
   * dead weight — this guard keeps the AI from stalling forever to bank ink
   * it can never accumulate.
   */
  private upgradeReachable(player: GameState['topPlayer']): boolean {
    const next = player.nextUpgradeCost;
    return next !== null && next <= INK_CAP;
  }
}
