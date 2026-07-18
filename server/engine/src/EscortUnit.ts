import { toFp, type Fp } from './math/fixed';
import type { EscortSpec } from './campaign/LevelDefinition';

// Real match spawns get their id from the owning GameState's per-instance counter
// (GameState.allocEscortId, range 5000+, well above unit 1000+ and building 0–999
// ranges so they can be used in GameEvent.targetId without collision). This
// module-level counter is ONLY a fallback for standalone construction that has no
// owning GameState — i.e. tests.
//
// ⚠️ It must NOT be shared as the live-match id source: a second GameState built
// mid-match (e.g. judgeRunner's hash recompute) used to reset a shared global back to
// 5000, so the live engine's next escort reused a still-live id — the same
// ghost-entity bug fixed for Unit/Building ids (see GameState._nextUnitId). Hence the
// counter now lives on GameState, per instance.
let nextNumericId = 5000;

/** Reset the standalone/test-only escort id fallback (see above). Not used by real matches. */
export function resetEscortIds(): void {
  nextNumericId = 5000;
}

/**
 * Runtime state for a campaign escort unit (§4.9.3).
 *
 * Escort units are friendly (player-side) targets that:
 *  - Move automatically from startRow toward the enemy base.
 *  - Keep moving even while under attack.
 *  - Can be targeted by enemy units (CombatSystem checks state.escorts).
 *  - Trigger win / loss conditions when arrived / dead (EscortSystem + checkWinCondition).
 */
export class EscortUnit {
  readonly kind = 'escort' as const;
  /** Integer id used in GameEvents and unit.targetId (stays in number domain). */
  readonly numericId: number;
  /** Matches EscortSpec.id — stable string key for renderer and JSON. */
  readonly id: string;
  hp: number;
  readonly maxHp: number;
  /** Fixed-point column position (cells). Updated each tick by EscortSystem. */
  col_fp: Fp;
  /** Fixed-point row position (cells). Increases each tick (toward enemy side). */
  row_fp: Fp;
  /** Speed in cells/second as fixed-point, used with TICK_DT_FP. */
  readonly speed_fp: Fp;
  status: 'moving' | 'arrived' | 'dead';
  /**
   * Remaining waypoints the escort must pass through in order.
   * Empty means: advance straight ahead to TOP_BUILDING_ROW.
   */
  remainingPath: { col: number; row: number }[];

  constructor(
    spec: EscortSpec,
    // Explicit id from the owning GameState (GameState.allocEscortId). Omitted only
    // by standalone construction (tests), which falls back to the module counter.
    id?: number,
  ) {
    this.numericId = id ?? nextNumericId++;
    this.id        = spec.id;
    this.hp        = spec.hp;
    this.maxHp     = spec.hp;
    this.col_fp    = toFp(spec.startCol);
    this.row_fp    = toFp(spec.startRow);
    this.speed_fp  = toFp(spec.speed);
    this.status    = 'moving';
    this.remainingPath = spec.path
      ? spec.path.map(w => ({ col: w.col, row: w.row }))
      : [];
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
  }
}
