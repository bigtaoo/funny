/**
 * 近战兵不应「穿过」前方可攻击的敌人（修复回归测试）。
 *
 * 背景 bug：MovementSystem 推进用连续 fp 坐标，CombatSystem 交战判定用整数格
 * 切比雪夫距离。两名同列对冲的近战兵会各自向相反方向取整 —— 例如 Bottom 在
 * y=5.49（第 5 行）、Top 在 y=6.51（第 7 行），连续间距只有 ~1.0 格，格距却读成
 * 2，range-1 近战不交战；下一 tick 两者都进到 y≈6.0 → 同一格（格距 0），而
 * findTarget 从 dist=1 起扫永远扫不到距离 0，于是穿过彼此继续前进。
 *
 * 修复：moveForward 在推进前钳制 —— 与前方可攻击敌军的中心间距不得小于 1 格，
 * 保证两者始终保持格距 ≥ 1，下一 tick CombatSystem 必然交战。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { Unit } from '../Unit';
import { CombatSystem } from '../systems/CombatSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { fp } from '../math/fixed';
import { Side, UnitState, UnitType } from '../types';

/** Run one engine sim step in the real system order: combat → movement. */
function step(state: GameState, combat: CombatSystem, movement: MovementSystem): void {
  combat.tick(state);
  movement.tick(state);
  state.elapsedTicks++;
}

test('melee units engage instead of walking through each other (rounding-adverse approach)', () => {
  const state    = new GameState(1);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 5;

  // Bottom infantry (moves toward higher rows). Rounds DOWN to row 5.
  const bottom = new Unit(UnitType.Infantry, Side.Bottom, COL, 5);
  bottom.y_fp = fp(5490); // row = round(5.49) = 5

  // Top infantry (moves toward lower rows). Rounds UP to row 7.
  const top = new Unit(UnitType.Infantry, Side.Top, COL, 7);
  top.y_fp = fp(6510); // row = round(6.51) = 7

  // Sanity: continuous gap is ~1 cell, but the integer cell distance reads as 2,
  // so CombatSystem (range 1) will NOT engage on the first tick — the exact window
  // where the old code let them slip through.
  assert.equal(bottom.row, 5);
  assert.equal(top.row, 7);
  assert.equal(Math.abs(bottom.row - top.row), 2);

  // Add AFTER positioning so the grid cell + sorted column list match y_fp.
  state.board.addUnit(bottom);
  state.board.addUnit(top);

  // Drive several steps — more than enough for them to meet and fight.
  let engaged = false;
  for (let i = 0; i < 30; i++) {
    step(state, combat, movement);

    // Invariant: the Bottom unit must never cross past the Top unit. If it ever
    // walks through, bottom.y_fp would exceed top.y_fp.
    assert.ok(
      bottom.y_fp < top.y_fp,
      `tick ${i}: bottom (y=${bottom.y_fp}) walked through top (y=${top.y_fp})`,
    );

    if (bottom.state === UnitState.Attacking || top.state === UnitState.Attacking) {
      engaged = true;
    }
    if (bottom.isDead || top.isDead) break;
  }

  // They must have actually fought (someone took damage / a kill happened),
  // proving the unit didn't sail past a target it should attack.
  assert.ok(engaged, 'melee units never engaged — one walked past the other');
});

test('melee unit clamps to one cell behind an enemy ahead in its lane', () => {
  const state    = new GameState(2);
  const combat   = new CombatSystem();
  const movement = new MovementSystem();

  const COL = 4;

  const bottom = new Unit(UnitType.Infantry, Side.Bottom, COL, 5);
  bottom.y_fp = fp(5490);
  const top = new Unit(UnitType.Infantry, Side.Top, COL, 7);
  top.y_fp = fp(6510);

  state.board.addUnit(bottom);
  state.board.addUnit(top);

  // First step: combat sees cell-distance 2 → no engage; movement must clamp the
  // bottom unit so it stays at least one full cell (1000 fp) behind the top unit
  // instead of advancing into / past its cell.
  step(state, combat, movement);

  assert.ok(
    bottom.y_fp <= top.y_fp - 1000,
    `bottom (y=${bottom.y_fp}) not kept >= 1 cell behind top (y=${top.y_fp})`,
  );
  // After the clamp they sit exactly one cell apart, so the next step engages.
  step(state, combat, movement);
  assert.ok(
    bottom.state === UnitState.Attacking && top.state === UnitState.Attacking,
    'units did not engage on the tick after clamping to 1-cell distance',
  );
});
