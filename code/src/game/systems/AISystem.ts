import {
  ATTACK_LANES,
  BASE_HP,
  BOARD_COLS,
  BOARD_ROWS,
  INK_CAP,
  TOP_BUILDING_ROW,
} from '../config';
import { TICK_RATE } from '../math/fixed';
import { Prng } from '../math/prng';
import { GameState } from '../GameState';
import {
  BuildingType,
  CardDefinition,
  CardType,
  OwnerId,
  PlayerCommand,
  Side,
  SpellType,
  UnitType,
} from '../types';

/** AI skill tiers. Tunes pacing, reactivity, and which tools the AI uses. */
export type AIDifficulty = 'easy' | 'medium' | 'hard';

interface DifficultyParams {
  /** Decision pacing in integer ticks (lower = acts more often). */
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
}

const DIFFICULTY: Record<AIDifficulty, DifficultyParams> = {
  easy: {
    thinkIntervalTicks: Math.round(2.0 * TICK_RATE), // 60 — sluggish
    dangerRow: TOP_BUILDING_ROW - 2,                 // reacts only at the doorstep
    lowBaseHp: Math.round(BASE_HP * 0.25),
    useMeteor: false,
    useTowers: false,
    useBarracks: false,
    meteorOffenseCluster: 99,
  },
  medium: {
    thinkIntervalTicks: Math.round(1.5 * TICK_RATE), // 45
    dangerRow: TOP_BUILDING_ROW - 4,                 // row 13
    lowBaseHp: Math.round(BASE_HP * 0.4),
    useMeteor: true,
    useTowers: true,
    useBarracks: true,
    meteorOffenseCluster: 3,
  },
  hard: {
    thinkIntervalTicks: Math.round(1.0 * TICK_RATE), // 30 — twice as responsive
    dangerRow: TOP_BUILDING_ROW - 6,                 // row 11 — reacts earlier
    lowBaseHp: Math.round(BASE_HP * 0.5),
    useMeteor: true,
    useTowers: true,
    useBarracks: true,
    meteorOffenseCluster: 2,
  },
};

/** At most this many AI barracks at once (also bounded by the 2 barracks cards). */
const MAX_BARRACKS = 2;

/**
 * AISystem — reads game state, returns PlayerCommand[] for this tick.
 * Does NOT mutate state; commands are processed by GameEngine.processCommand().
 * Uses integer tick counts for decision pacing — no floating-point timers.
 *
 * The AI plays the Top side (owner 1, base at row {@link TOP_BUILDING_ROW}).
 * Enemy units are Side.Bottom advancing toward row 17 — the higher an enemy's
 * row, the closer it is to the AI base, the greater the threat.
 *
 * Decision pipeline (one action per think interval, highest priority wins):
 *   1. Emergency defense — meteor a cluster near the base, drop an arrow tower
 *      in the most-pressured lane, or block with a Guardian.
 *   2. Upgrade planning — bank toward / buy a base upgrade when it is safe and
 *      actually reachable (guarded by INK_CAP).
 *   3. Economy & offense — seed barracks, nuke fat enemy clusters, then push a
 *      cost-effective unit down the least-defended lane.
 *
 * Determinism: every branch reads only game state + the injected {@link Prng},
 * so the same seed + command stream reproduces identically (golden replay).
 */
export class AISystem {
  private thinkTick: number = 0;
  private readonly params: DifficultyParams;

  constructor(
    private readonly rng: Prng,
    readonly difficulty: AIDifficulty = 'medium',
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

    // Offensive meteor on a fat enemy cluster anywhere on the board.
    if (this.params.useMeteor) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
      if (idx !== null) {
        const target = this.findMeteorTarget(state, this.params.meteorOffenseCluster, false);
        if (target) {
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row }];
        }
      }
    }

    // Push a cost-effective unit down the least-defended lane.
    const unitIdx = this.pickUnitCard(player.hand.cards, player.ink,
      [UnitType.Swordsman, UnitType.Archer, UnitType.Guardian]);
    if (unitIdx !== null) {
      const lane = this.pickLane(threat, /*mostThreatened*/ false);
      if (lane !== null) {
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

    // a) Meteor the densest cluster pressing the base.
    if (this.params.useMeteor) {
      const idx = this.findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
      if (idx !== null) {
        const target = this.findMeteorTarget(state, 2, /*preferNearBase*/ true);
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

    // c) Block the most-threatened lane with a body (Guardian tanks best).
    const unitIdx = this.pickUnitCard(player.hand.cards, player.ink,
      [UnitType.Guardian, UnitType.Swordsman, UnitType.Archer]);
    if (unitIdx !== null) {
      const lane = this.pickLane(threat, /*mostThreatened*/ true);
      if (lane !== null) {
        return { type: 'play_card', owner, tick, handIndex: unitIdx, col: lane };
      }
    }

    return null;
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
   * Choose an affordable unit card following a preference order (best first).
   * This is the "economy awareness" lever — the AI deliberately favours the
   * preferred unit instead of blindly playing the first affordable slot.
   */
  private pickUnitCard(
    cards: (CardDefinition | null)[],
    ink: number,
    preference: UnitType[],
  ): number | null {
    for (const want of preference) {
      const idx = this.findCardIndex(cards, ink, (c) =>
        c.cardType === CardType.Unit && c.unitType === want);
      if (idx !== null) return idx;
    }
    return null;
  }

  // ─── Meteor targeting ──────────────────────────────────────────────────────

  /**
   * Find the best 2×2 anchor for a meteor over enemy (Bottom) units.
   * Returns the top-left cell of the footprint, or null if no cluster reaches
   * `minCount`. With `preferNearBase`, ties favour the footprint closest to the
   * AI base (highest row) so defensive nukes land on the most urgent threat.
   */
  private findMeteorTarget(
    state: GameState,
    minCount: number,
    preferNearBase: boolean,
  ): { col: number; row: number } | null {
    // Count enemy units per integer cell.
    const cell: Map<number, number> = new Map();
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom || unit.isDead) continue;
      const key = unit.row * BOARD_COLS + unit.col;
      cell.set(key, (cell.get(key) ?? 0) + 1);
    }
    if (cell.size === 0) return null;

    let best: { col: number; row: number } | null = null;
    let bestCount = minCount - 1;
    let bestRow = -1;
    const at = (c: number, r: number) =>
      (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) ? 0 : (cell.get(r * BOARD_COLS + c) ?? 0);

    // Anchor scan: footprint covers cols [c, c+1], rows [r, r+1].
    for (let r = 0; r <= BOARD_ROWS - 2; r++) {
      for (let c = 0; c <= BOARD_COLS - 2; c++) {
        const count = at(c, r) + at(c + 1, r) + at(c, r + 1) + at(c + 1, r + 1);
        if (count > bestCount || (count === bestCount && preferNearBase && r > bestRow)) {
          bestCount = count;
          bestRow = r;
          best = { col: c, row: r };
        }
      }
    }
    return best;
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
