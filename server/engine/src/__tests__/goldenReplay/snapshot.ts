// Golden replay harness — turns a live GameState into a plain, JSON-safe snapshot.
// Only fields that are part of the deterministic simulation (never wall-clock /
// object-identity / Map iteration order) are included, and every collection is
// sorted by a stable key so insertion order can't leak into the hash.
import type { GameState } from '../../GameState';
import type { Unit } from '../../Unit';
import type { Building } from '../../Building';
import type { Player } from '../../Player';

function unitSnapshot(u: Unit) {
  return {
    id: u.id,
    unitType: u.unitType,
    side: u.side,
    col: u.col,
    x_fp: u.x_fp,
    y_fp: u.y_fp,
    hp_fp: u.hp_fp,
    state: u.state,
    isDead: u.isDead,
    isBoss: u.isBoss,
    targetId: u.targetId,
    speed_fp: u.speed_fp,
    attackCooldownTicks: u.attackCooldownTicks,
    detourTargetCol: u.detourTargetCol,
    detourDir: u.detourDir,
  };
}

function buildingSnapshot(b: Building) {
  return {
    id: b.id,
    buildingType: b.buildingType,
    side: b.side,
    col: b.col,
    row: b.row,
    hp_fp: b.hp_fp,
    isDead: b.isDead,
    attackCooldownTicks: b.attackCooldownTicks,
    spawnCooldownTicks: b.spawnCooldownTicks,
  };
}

function playerSnapshot(p: Player) {
  return {
    side: p.side,
    ink: p.ink,
    upgradeLevel: p.upgradeLevel,
    baseHp_fp: p.baseHp_fp,
    maxBaseHp_fp: p.maxBaseHp_fp,
    isDead: p.isDead,
    hand: p.hand.slots.map((s) => (s ? { cardId: s.card.id, refreshRemainingTicks: s.refreshRemainingTicks } : null)),
  };
}

/** Full deterministic snapshot of `state`, safe to JSON.stringify / hash. */
export function snapshotState(state: GameState) {
  return {
    phase: state.phase,
    winner: state.winner,
    elapsedTicks: state.elapsedTicks,
    enemyLeaks: state.enemyLeaks,
    countdownStarted: state.countdownStarted,
    bottomInkRegenMult: state.bottomInkRegenMult,
    bossUnitIds: Array.from(state.bossUnitIds).sort((a, b) => a - b),
    stats: state.snapshotStats(),
    summary: state.snapshotSummary(),
    bottomPlayer: playerSnapshot(state.bottomPlayer),
    topPlayer: playerSnapshot(state.topPlayer),
    units: Array.from(state.board.units.values())
      .map(unitSnapshot)
      .sort((a, b) => a.id - b.id),
    buildings: Array.from(state.board.buildings.values())
      .map(buildingSnapshot)
      .sort((a, b) => a.id - b.id),
    escorts: state.escorts.map((e) => ({ id: e.id, hp_fp: e.hp_fp, col_fp: e.col_fp, row_fp: e.row_fp, status: e.status })),
    projectiles: state.projectiles.map((p) => ({ id: p.id, x_fp: p.x_fp, y_fp: p.y_fp })),
  };
}
