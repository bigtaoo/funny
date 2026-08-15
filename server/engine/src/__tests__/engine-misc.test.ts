/**
 * Two unrelated single-branch gaps, grouped in one small file:
 *
 *  - GameState.snapshotSummary(): the `e.maxHp_fp > 0 ? ratio : 0` ternary's `: 0` arm is
 *    never taken by any real escort (EscortUnit's maxHp_fp always mirrors a positive
 *    EscortSpec.hp) — covered here with a directly-constructed zero-HP escort.
 *  - runHeadless(): the `cmds === null` early-break is never taken by
 *    LocalInputSource/ReplayInputSource (neither ever stalls) — covered with a minimal
 *    stalling InputSource stub, matching the doc comment's "a source that DOES stall...
 *    has no business driving an authoritative recompute" note.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GameState } from '../GameState';
import { EscortUnit } from '../EscortUnit';
import { runHeadless } from '../runHeadless';
import type { InputSource } from '../net/InputSource';
import type { GameConfig, PlayerCommand } from '../types';

test('GameState.snapshotSummary treats a zero-maxHp escort as 0% (not NaN/Infinity)', () => {
  const state = new GameState(1);
  const escort = new EscortUnit({ id: 'e0', hp: 0, speed: 0, startCol: 0, startRow: 0 });
  state.escorts.push(escort);

  const summary = state.snapshotSummary();
  assert.equal(summary.escortMinHpPct, 0, 'a 0-maxHp escort contributes a 0% ratio via the ternary\'s false arm');
});

test('runHeadless stops (without a "GameOver") the first tick its InputSource stalls (take() returns null)', () => {
  class StallingInputSource implements InputSource {
    submit(): void {}
    take(): readonly PlayerCommand[] | null {
      return null; // always stalled — never confirms a frame
    }
  }

  const config: GameConfig = { seed: 1, players: [{ id: 0 }, { id: 1 }] };
  const outcome = runHeadless(config, new StallingInputSource(), 100);

  assert.equal(outcome.ticks, 0, 'the loop breaks on tick 0 before stepping the engine');
  assert.equal(outcome.ok, false, 'the match never reaches GameOver when input never confirms');
});
