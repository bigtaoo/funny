import { INK_CAP } from '../config';
import { Prng } from '../math/prng';
import { GameState } from '../GameState';
import { BuildingType, CardType, OwnerId, PlayerCommand, SpellType } from '../types';
import { AiCtx, AIDifficulty, DIFFICULTY, DifficultyParams, MAX_BARRACKS } from './ai/types';
import {
  chooseOffenseLane,
  computeThreatByCol,
  countNearBaseEnemies,
  countOwnBarracks,
  freeBuildingLane,
  recordThreatHistory,
} from './ai/threatAssessment';
import { findCardIndex, pickUnitCard } from './ai/cardSelection';
import { findMeteorTarget } from './ai/meteorTargeting';
import { tryDefend, tryHaste } from './ai/defense';

export type { AIDifficulty, DifficultyParams };
export { DIFFICULTY };

/**
 * AISystem — reads game state, returns PlayerCommand[] for this tick.
 * Does NOT mutate state; commands are processed by engine/sim/commands.ts's processCommand().
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
 *
 * ── Split (2026-08-10, independent function module range 6) ──
 * The bulk of the decision logic lives in sibling `ai/*.ts` files as plain
 * functions of explicit state (`GameState`, an `AiCtx` carrying `params`/`rng`/
 * `threatHistory`) rather than instance methods — none of it shared mutable
 * class state beyond the few fields kept here. This class is now just the
 * public-API shell: it owns `thinkTick`/`params`/`rng`/`threatHistory` and
 * wires them into `ctx` once, then orchestrates the three-tier decision
 * pipeline by calling into `ai/threatAssessment.ts` (lane/threat scoring),
 * `ai/cardSelection.ts` (hand lookup + counter-picking), `ai/meteorTargeting.ts`
 * (2×2 footprint scan), and `ai/defense.ts` (emergency defense + Haste tempo).
 */
export class AISystem {
  private thinkTick: number = 0;
  private readonly params: DifficultyParams;
  private readonly ctx: AiCtx;

  constructor(
    private readonly rng: Prng,
    readonly difficulty: AIDifficulty = 5,
  ) {
    const params = DIFFICULTY[difficulty];
    if (!params) throw new Error(`AISystem: invalid difficulty level ${difficulty} (must be 1-10)`);
    this.params = params;
    this.ctx = { params, rng, threatHistory: [] };
  }

  decideTick(tick: number, state: GameState): PlayerCommand[] {
    this.thinkTick++;
    if (this.thinkTick < this.params.thinkIntervalTicks) return [];
    this.thinkTick = 0;
    return this.makeDecision(tick, state);
  }

  private makeDecision(tick: number, state: GameState): PlayerCommand[] {
    const player = state.topPlayer;
    const owner: OwnerId = 1;
    const ctx = this.ctx;

    const threat = computeThreatByCol(state);
    if (ctx.params.useThreatMemory) recordThreatHistory(ctx.threatHistory, threat);
    const totalThreat = threat.reduce((a, b) => a + b, 0);
    const imminent = countNearBaseEnemies(state, ctx.params.dangerRow);
    const underPressure = imminent > 0 || player.baseHp <= ctx.params.lowBaseHp;

    // ── 1. Emergency defense ─────────────────────────────────────────────────
    if (underPressure) {
      const defense = tryDefend(ctx, state, owner, tick, threat);
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
    if (ctx.params.useBarracks && countOwnBarracks(state) < MAX_BARRACKS) {
      const idx = findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Building && c.buildingType === BuildingType.Barracks);
      if (idx !== null) {
        const lane = freeBuildingLane(state, threat, /*preferSafe*/ true);
        if (lane !== null) {
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: lane }];
        }
      }
    }

    // Offensive meteor on a fat enemy cluster anywhere on the board (ink-value
    // gated at higher levels so the AI doesn't trade a 12-cost spell for scraps).
    if (ctx.params.useMeteor) {
      const idx = findCardIndex(player.hand.cards, player.ink, (c) =>
        c.cardType === CardType.Spell && c.spellType === SpellType.Meteor);
      if (idx !== null) {
        const meteorCost = ctx.params.useValueTrades ? player.hand.cards[idx]!.cost : 0;
        const target = findMeteorTarget(state, ctx.params.meteorOffenseCluster, /*preferNearBase*/ false, meteorCost);
        if (target) {
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row }];
        }
      }
    }

    // Haste a push when a friendly wave is already advancing — a tempo tool the
    // AI previously never touched.
    if (ctx.params.useHaste) {
      const haste = tryHaste(state, owner, tick);
      if (haste) return [haste];
    }

    // Push a counter-picked (or, below the threshold, preference-ordered) unit
    // down the least-defended lane — or the fastest-rising one, at L8+.
    const lane = chooseOffenseLane(ctx, threat);
    if (lane !== null) {
      const unitIdx = pickUnitCard(state, player.hand.cards, player.ink, lane, /*forDefense*/ false, ctx.params.useCounterPicking);
      if (unitIdx !== null) {
        return [{ type: 'play_card', owner, tick, handIndex: unitIdx, col: lane }];
      }
    }

    return [];
  }

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
