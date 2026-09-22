/**
 * Lane punish (§4.9.5), driven through the REAL per-tick loop.
 *
 * `lane-punish.test.ts` calls `tickLanePunish` directly, which proves the rule and proves
 * nothing about whether anything calls it: deleting the one line in `engine/sim/step.ts`
 * leaves all eight of those cases green. This file closes that hole by driving
 * `engine.step()` — the same entry point the game and the difficulty sim use — so the
 * wiring itself is covered, including the two facts that only the call SITE can get wrong:
 * that the punish runs in the PvE branch at all, and that it does not run in PvP.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createGameEngine } from '../GameEngine';
import { Unit, resetUnitIds } from '../Unit';
import { toFp } from '../math/fixed';
import { Side, SpellType, UnitType } from '../types';
import type { GameConfig } from '../types';
import type { LanePunishSpec, LevelDefinition } from '../campaign/LevelDefinition';

const SPEC: LanePunishSpec = { units: 3, sustainTicks: 10, cooldownTicks: 500, spell: 'rockslide' };
const WALL_COL = 3;

function campaignConfig(lanePunish?: LanePunishSpec): GameConfig {
  const level: LevelDefinition = {
    id: 'test_lane_punish_wiring',
    chapter: 0,
    seed: 11,
    objective: { kind: 'survive' },
    // One far-future spawn: `waves.entries` must be non-empty for a campaign level, and a
    // tick-9999 entry keeps the board free of wave units during the window under test.
    waves: { entries: [{ atTick: 9999, unitType: UnitType.Infantry, col: 0, count: 1 }] },
  };
  if (lanePunish) level.lanePunish = lanePunish;
  return { seed: 11, mode: 'campaign', players: [{ id: 0 }, { id: 1 }], level };
}

/** Stand `n` player units in `col`, one row apart starting at row 2. */
function wall(engine: ReturnType<typeof createGameEngine>, col: number, n: number): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const row = 2 + i;
    const u = new Unit(UnitType.ShieldBearer, Side.Bottom, col, row, undefined, undefined, engine.state.allocUnitId());
    u.y_fp = toFp(row);
    engine.state.board.addUnit(u);
    units.push(u);
  }
  return units;
}

/**
 * Rockslide casts, read off the event stream.
 *
 * The long-running cases assert on THIS rather than on the wall's HP, because HP cannot
 * tell the two outcomes apart: a unit that walks the length of the board, crosses, and
 * spends itself on the enemy base ends at `hp_fp = 0, isDead = true` — identical to one
 * the punish killed. An earlier draft asserted "nobody lost HP" and passed only because
 * packing the units one row apart made them queue and never reach the far side; it was
 * green for a reason that had nothing to do with what it claimed to check.
 */
function rockslideCasts(events: readonly { type: string }[]): number {
  return events.filter((e) => e.type === 'spell_cast').length;
}

test('step(): a campaign level with lanePunish answers a sustained wall — the wiring in sim/step.ts is live', () => {
  resetUnitIds();
  const engine = createGameEngine(campaignConfig(SPEC));
  const units = wall(engine, WALL_COL, SPEC.units);

  for (let tick = 0; tick < SPEC.sustainTicks - 1; tick++) engine.step(tick, []);
  assert.ok(
    units.every((u) => u.hp_fp === u.maxHp_fp),
    'precondition: nothing has hit the wall before the sustain window closes',
  );

  engine.step(SPEC.sustainTicks - 1, []);

  assert.ok(
    units.every((u) => u.hp_fp < u.maxHp_fp),
    'every unit in the walled column must have been hit — if this fails with lane-punish.test.ts '
    + 'still green, the tickLanePunish call in engine/sim/step.ts is gone',
  );
});

test('step(): a campaign level without lanePunish is untouched no matter how long the wall stands', () => {
  resetUnitIds();
  const engine = createGameEngine(campaignConfig(undefined));
  wall(engine, WALL_COL, SPEC.units * 3);

  let casts = 0;
  for (let tick = 0; tick < SPEC.sustainTicks * 20; tick++) casts += rockslideCasts(engine.step(tick, []));

  assert.equal(casts, 0, 'opting out must stay a no-op — not one cast in twenty sustain windows');
  assert.equal(engine.state.lanePunishSustain.size, 0, 'no bookkeeping accrues for a level that opted out');
});

test('step(): PvP never runs the lane punish, however the columns are stacked', () => {
  resetUnitIds();
  // No level and no waveDirector: step() takes its PvP branch, where the punish must not exist.
  const engine = createGameEngine({ seed: 11, players: [{ id: 0 }, { id: 1 }] });
  wall(engine, WALL_COL, SPEC.units * 3);

  // The AI casts spells of its own in PvP, so count Rockslides specifically: it is the one
  // spell no PvP deck can hold (PvE-only, §4.9.2), which makes it a clean tell.
  let rockslides = 0;
  for (let tick = 0; tick < SPEC.sustainTicks * 10; tick++) {
    for (const ev of engine.step(tick, [])) {
      if (ev.type === 'spell_cast' && (ev as { spellType: SpellType }).spellType === SpellType.Rockslide) rockslides++;
    }
  }

  assert.equal(engine.state.lanePunishSustain.size, 0, 'PvP must not accumulate lane-punish state');
  assert.equal(rockslides, 0, 'a Rockslide in PvP can only have come from the lane punish leaking out of the PvE branch');
});
