/**
 * runHeadlessSliced — the background-priority variant of runHeadless that peer judges use
 * (SERVER_API_INTERNAL §8.1): the same deterministic loop, yielding to `pause()` every
 * `sliceTicks` frames. Yielding must never change the outcome — a judge's verdict hash has to
 * equal the one a synchronous recompute (and both honest players) would produce.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { runHeadless, runHeadlessSliced } from '../runHeadless';
import { GamePhase } from '../types';
import type { InputSource } from '../net/InputSource';
import type { GameConfig, OwnerId, PlayerCommand, Side } from '../types';

/** A few cards from each side, so the recompute has real combat to get wrong. */
const SCRIPT: { frame: number; owner: OwnerId; handIndex: number; col: number }[] = [
  { frame: 30, owner: 0, handIndex: 0, col: 1 },
  { frame: 60, owner: 1, handIndex: 0, col: 8 },
  { frame: 200, owner: 0, handIndex: 1, col: 3 },
  { frame: 260, owner: 1, handIndex: 1, col: 5 },
];

class ScriptedSource implements InputSource {
  private readonly byFrame = new Map<number, PlayerCommand[]>();
  constructor() {
    for (const s of SCRIPT) {
      const cmd: PlayerCommand = { type: 'play_card', owner: s.owner, tick: s.frame, handIndex: s.handIndex, col: s.col };
      (this.byFrame.get(s.frame) ?? this.byFrame.set(s.frame, []).get(s.frame)!).push(cmd);
    }
  }
  submit(): void {}
  take(frame: number): readonly PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }
}

const config = (): GameConfig => ({ seed: 0xbeef, players: [{ id: 0 }, { id: 1 }] });
const MAX_TICKS = 40_000;

function fingerprint(o: { ok: boolean; ticks: number; engine: { state: { winner: Side | null; snapshotStats(): unknown } } }) {
  return JSON.stringify({ ok: o.ok, ticks: o.ticks, winner: o.engine.state.winner, stats: o.engine.state.snapshotStats() });
}

test('runHeadlessSliced reaches exactly the synchronous end state, pausing once per slice', async () => {
  const sync = runHeadless(config(), new ScriptedSource(), MAX_TICKS);
  assert.equal(sync.engine.state.phase, GamePhase.GameOver, 'the scripted match terminates');

  for (const slice of [1, 7, 60]) {
    let pauses = 0;
    const sliced = await runHeadlessSliced(config(), new ScriptedSource(), MAX_TICKS, async () => { pauses++; }, slice);
    assert.equal(fingerprint(sliced), fingerprint(sync), `slice=${slice} changes nothing`);
    assert.equal(pauses, Math.floor(sliced.ticks / slice), `slice=${slice} yields once per ${slice} ticks`);
  }
});

test('runHeadlessSliced honours maxTicks like runHeadless', async () => {
  const sliced = await runHeadlessSliced(config(), new ScriptedSource(), 90, async () => {}, 60);
  assert.equal(sliced.ticks, 90);
  assert.equal(sliced.ok, false);
});

test('a pause that throws aborts the run (the caller turns it into ok:false)', async () => {
  let steps = 0;
  const counting: InputSource = { submit() {}, take: () => { steps++; return []; } };
  await assert.rejects(
    runHeadlessSliced(config(), counting, MAX_TICKS, async () => { throw new Error('deadline'); }, 10),
    /deadline/,
  );
  assert.equal(steps, 10, 'no frame is stepped after the refused pause');
});

test('runHeadlessSliced stops the first tick its InputSource stalls, without pausing', async () => {
  let pauses = 0;
  const stalling: InputSource = { submit() {}, take: () => null };
  const out = await runHeadlessSliced(config(), stalling, 100, async () => { pauses++; }, 1);
  assert.equal(out.ticks, 0);
  assert.equal(out.ok, false);
  assert.equal(pauses, 0);
});
