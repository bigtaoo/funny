/**
 * Lane punish (§4.9.5): the scripted campaign side's one reactive behaviour —
 * answer a sustained player wall in a single column with a column spell.
 *
 * Campaign enemies are a pure wave script (engine/sim/step.ts spawns them and
 * nothing else), so nothing on the board could ever make stacking one lane cost
 * the player anything. These tests pin the trigger (wall size × sustain), the
 * cooldown, the target choice, and — most importantly — that a level which does
 * not opt in behaves exactly as it did before the knob existed.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildEngineCtx } from '../engine/setup/buildCtx';
import { tickLanePunish } from '../engine/sim/campaign';
import { Unit, resetUnitIds } from '../Unit';
import { toFp } from '../math/fixed';
import { Side, UnitType } from '../types';
import type { EngineCtx } from '../engine/ctx';
import type { GameConfig } from '../types';
import type { LanePunishSpec, LevelDefinition } from '../campaign/LevelDefinition';

const SPEC: LanePunishSpec = { units: 4, sustainTicks: 10, cooldownTicks: 100, spell: 'rockslide' };

function ctxWith(lanePunish?: LanePunishSpec): EngineCtx {
  const level: LevelDefinition = {
    id: 'test_lane_punish',
    chapter: 0,
    seed: 7,
    objective: { kind: 'survive' },
    waves: { entries: [] },
  };
  if (lanePunish) level.lanePunish = lanePunish;
  const config: GameConfig = { seed: 7, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
  return buildEngineCtx(config);
}

/** Put `n` player units into `col`, returning them. */
function wall(ctx: EngineCtx, col: number, n: number): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const u = new Unit(UnitType.Infantry, Side.Bottom, col, 2 + i, undefined, undefined, ctx.state.allocUnitId());
    u.y_fp = toFp(2 + i);
    ctx.state.board.addUnit(u);
    units.push(u);
  }
  return units;
}

function run(ctx: EngineCtx, ticks: number, fromTick = 0): void {
  for (let t = fromTick; t < fromTick + ticks; t++) tickLanePunish(ctx, t);
}

test('lane punish: a wall held for sustainTicks takes a rockslide', () => {
  resetUnitIds();
  const ctx = ctxWith(SPEC);
  const units = wall(ctx, 3, 4);

  run(ctx, SPEC.sustainTicks - 1);
  assert.ok(units.every((u) => u.hp_fp === u.maxHp_fp), 'must not fire before the wall has held');

  run(ctx, 1, SPEC.sustainTicks - 1);
  assert.ok(units.every((u) => u.hp_fp < u.maxHp_fp), 'every unit in the walled column is hit');
});

test('lane punish: a column below the wall size is never touched', () => {
  resetUnitIds();
  const ctx = ctxWith(SPEC);
  const units = wall(ctx, 3, SPEC.units - 1);

  run(ctx, SPEC.sustainTicks * 3);

  assert.ok(units.every((u) => u.hp_fp === u.maxHp_fp));
});

test('lane punish: thinning the wall restarts its sustain counter', () => {
  resetUnitIds();
  const ctx = ctxWith(SPEC);
  const units = wall(ctx, 3, 4);

  run(ctx, SPEC.sustainTicks - 1);
  ctx.state.board.removeUnit(units[0]!); // wall drops below `units`
  run(ctx, 1, SPEC.sustainTicks - 1);
  assert.equal(ctx.state.lanePunishSustain.get(3), undefined, 'the column is forgotten once it thins');

  // Rebuilding it has to serve the full sustain again.
  wall(ctx, 3, 1);
  run(ctx, SPEC.sustainTicks - 1, SPEC.sustainTicks);
  assert.ok(units.slice(1).every((u) => u.hp_fp === u.maxHp_fp), 'a rebuilt wall is not punished instantly');
});

test('lane punish: the cooldown holds off a second cast', () => {
  resetUnitIds();
  // bridge_collapse rather than rockslide: a damaging cast can kill the very wall
  // whose second punishment is under test, which would pass for the wrong reason.
  const ctx = ctxWith({ ...SPEC, spell: 'bridge_collapse' });
  wall(ctx, 3, 4);

  run(ctx, SPEC.sustainTicks);
  const firstCastTick = ctx.state.lanePunishReadyTick - SPEC.cooldownTicks;
  assert.ok(ctx.state.tempBlockedCols.has(3), 'precondition: the first cast landed');
  ctx.state.tempBlockedCols.clear();

  // Wall still up, several sustain windows deep — but the cooldown has not run out.
  run(ctx, SPEC.cooldownTicks - SPEC.sustainTicks - 1, firstCastTick + 1);
  assert.equal(ctx.state.tempBlockedCols.size, 0, 'no second cast while on cooldown');

  run(ctx, 1, firstCastTick + SPEC.cooldownTicks);
  assert.ok(ctx.state.tempBlockedCols.has(3), 'fires again once the cooldown expires');
});

test('lane punish: the thickest wall is the target', () => {
  resetUnitIds();
  const ctx = ctxWith(SPEC);
  const thin  = wall(ctx, 2, 4);
  const thick = wall(ctx, 8, 6);

  run(ctx, SPEC.sustainTicks);

  assert.ok(thick.every((u) => u.hp_fp < u.maxHp_fp), 'the thickest column is answered');
  assert.ok(thin.every((u) => u.hp_fp === u.maxHp_fp), 'only one column per cast');
});

test('lane punish: the rockslide spares the scripted side own units', () => {
  resetUnitIds();
  const ctx = ctxWith(SPEC);
  wall(ctx, 3, 4);
  const waveUnit = new Unit(UnitType.Infantry, Side.Top, 3, 9, undefined, undefined, ctx.state.allocUnitId());
  waveUnit.y_fp = toFp(9);
  ctx.state.board.addUnit(waveUnit);

  run(ctx, SPEC.sustainTicks);

  assert.equal(waveUnit.hp_fp, waveUnit.maxHp_fp, 'a punishment that kills your own wave is no punishment');
});

test('lane punish: the bridge_collapse variant blocks the column instead of damaging it', () => {
  resetUnitIds();
  const ctx = ctxWith({ ...SPEC, spell: 'bridge_collapse' });
  const units = wall(ctx, 3, 4);

  run(ctx, SPEC.sustainTicks);

  assert.ok(ctx.state.tempBlockedCols.has(3), 'the walled column is closed');
  assert.ok(units.every((u) => u.hp_fp === u.maxHp_fp), 'bridge_collapse deals no damage');
});

test('lane punish: a level without the knob is completely unaffected', () => {
  resetUnitIds();
  const ctx = ctxWith(undefined);
  const units = wall(ctx, 3, 12);

  run(ctx, 600);

  assert.ok(units.every((u) => u.hp_fp === u.maxHp_fp));
  assert.equal(ctx.state.lanePunishSustain.size, 0);
  assert.equal(ctx.state.tempBlockedCols.size, 0);
});
