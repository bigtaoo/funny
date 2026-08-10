// Split from AISystem.ts (2026-08-10, independent function module range 6, part 2/5).
// Per-column threat scoring, the useThreatMemory rolling window, and lane selection —
// everything that previously read `this.rng`/`this.threatHistory`/`this.params` now
// takes those as explicit AiCtx/array/threat[] arguments.
import { ATTACK_LANES, BOARD_COLS, TOP_BUILDING_ROW } from '../../config';
import { GameState } from '../../GameState';
import { BuildingType, Side } from '../../types';
import { AiCtx, THREAT_HISTORY_LEN } from './types';

/**
 * Per-column threat from Bottom units, weighted by proximity to the AI base.
 * A unit one step from the base (row 16) weighs far more than one just spawned.
 */
export function computeThreatByCol(state: GameState): number[] {
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
export function countNearBaseEnemies(state: GameState, dangerRow: number): number {
  let count = 0;
  for (const unit of state.board.units.values()) {
    if (unit.side !== Side.Bottom || unit.isDead) continue;
    if (unit.row >= dangerRow) count++;
  }
  return count;
}

/** Push the latest snapshot into the rolling window, keeping at most {@link THREAT_HISTORY_LEN}. */
export function recordThreatHistory(threatHistory: number[][], threat: number[]): void {
  threatHistory.push(threat);
  if (threatHistory.length > THREAT_HISTORY_LEN) threatHistory.shift();
}

/**
 * Lane whose threat has climbed the most since the oldest snapshot still held
 * (only meaningful once the window has a few samples). Lets L8+ reinforce a
 * lane that's visibly building up before it becomes an emergency, purely from
 * its own past public-state computations — no lookahead, no hidden info.
 */
export function mostRisingLane(threatHistory: number[][]): number | null {
  if (threatHistory.length < 3) return null;
  const oldest = threatHistory[0]!;
  const latest = threatHistory[threatHistory.length - 1]!;
  let bestLane: number | null = null;
  let bestDelta = 0;
  for (const lane of ATTACK_LANES) {
    const delta = latest[lane]! - oldest[lane]!;
    if (delta > bestDelta) { bestDelta = delta; bestLane = lane; }
  }
  return bestLane;
}

/**
 * Pick an attack lane by threat. `mostThreatened` chooses the lane with the
 * heaviest enemy presence (defense); otherwise the lightest (offensive push).
 * Ties are broken with the injected PRNG for unpredictability.
 */
export function pickLane(ctx: AiCtx, threat: number[], mostThreatened: boolean): number | null {
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
  return tied[ctx.rng.nextInt(tied.length)]!;
}

/** Offense lane pick: fastest-rising lane at L8+ (if one exists), else the least-threatened lane. */
export function chooseOffenseLane(ctx: AiCtx, threat: number[]): number | null {
  if (ctx.params.useThreatMemory) {
    const rising = mostRisingLane(ctx.threatHistory);
    if (rising !== null) return rising;
  }
  return pickLane(ctx, threat, /*mostThreatened*/ false);
}

/**
 * Pick an open building lane (no own building at the building row).
 * `preferSafe` puts barracks where they survive (lowest threat); otherwise
 * towers go where the pressure is highest.
 */
export function freeBuildingLane(state: GameState, threat: number[], preferSafe: boolean): number | null {
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

export function countOwnBarracks(state: GameState): number {
  let count = 0;
  for (const b of state.board.buildings.values()) {
    if (b.side === Side.Top && b.buildingType === BuildingType.Barracks && !b.isDead) count++;
  }
  return count;
}
