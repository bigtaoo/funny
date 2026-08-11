// Golden replay harness — runs one scenario to completion and reduces it to a
// comparable result: a hash per tick's event batch (fine-grained diff target)
// plus a hash of the final state snapshot. `snapshots` (human-readable, only
// sampled every few ticks to keep fixtures small) rides along for debugging a
// hash mismatch without having to re-run anything.
import { createGameEngine } from '../../GameEngine';
import { TICK_RATE } from '../../math/fixed';
import type { GameEvent, PlayerCommand } from '../../types';
import type { Scenario } from './scenarios';
import { snapshotState } from './snapshot';
import { sha256, stableStringify } from './hash';

export interface ScenarioResult {
  name: string;
  /** sha256 of each tick's event batch, in order — the fine-grained determinism signal. */
  tickHashes: string[];
  /** sha256 of the full concatenated event log — one number to eyeball for "did anything change". */
  eventLogHash: string;
  /** sha256 of the final GameState snapshot. */
  finalStateHash: string;
  /** Human-readable final snapshot, for diffing a hash mismatch. */
  finalSnapshot: unknown;
  /** Tick count actually run (== scenario.maxTicks; kept for a quick sanity check in fixtures). */
  ticksRun: number;
}

function applyViaPublicApi(engine: ReturnType<typeof createGameEngine>, cmd: PlayerCommand): void {
  // Mirrors what the render layer does — routes through IGameEngine's render-facing
  // API (not raw step()) so the tick()-driven scenario also exercises playCard/
  // upgradeBase/refreshHand's self-forwarding through the InputSource.
  if (cmd.type === 'play_card') engine.playCard(cmd.handIndex, cmd.col ?? 0, cmd.row);
  else if (cmd.type === 'upgrade_base') engine.upgradeBase();
  else if (cmd.type === 'refresh_hand') engine.refreshHand();
}

export function runScenario(scenario: Scenario): ScenarioResult {
  const engine = createGameEngine(scenario.config);
  const tickHashes: string[] = [];
  const allEvents: GameEvent[] = [];

  if (scenario.driveMode === 'step') {
    for (let tick = 0; tick < scenario.maxTicks; tick++) {
      const cmds = scenario.scriptedCommands?.(tick) ?? [];
      const events = engine.step(tick, cmds);
      tickHashes.push(sha256(events));
      allEvents.push(...events);
    }
  } else {
    // tick(dt) with dt exactly 1/TICK_RATE and LocalInputSource (zero delay, no
    // confirmedLead) advances exactly one sim step per call — frameIndex lines up
    // 1:1 with the engine's internal currentTick, so commands submitted just
    // before frame N's tick() land on sim tick N, same as the step-mode scenarios.
    const dt = 1 / TICK_RATE;
    for (let frame = 0; frame < scenario.maxTicks; frame++) {
      for (const cmd of scenario.scriptedCommands?.(frame) ?? []) applyViaPublicApi(engine, cmd);
      engine.tick(dt);
      const events = engine.state.events;
      tickHashes.push(sha256(events));
      allEvents.push(...events);
    }
  }

  const finalSnapshot = snapshotState(engine.state);
  return {
    name: scenario.name,
    tickHashes,
    eventLogHash: sha256(allEvents),
    finalStateHash: sha256(finalSnapshot),
    finalSnapshot,
    ticksRun: scenario.maxTicks,
  };
}

/** Fixture shape written/read on disk — same as ScenarioResult but explicit about intent. */
export type ScenarioFixture = ScenarioResult;

export function fixtureFileName(scenarioName: string): string {
  return `${scenarioName}.json`;
}

export function toFixtureJson(result: ScenarioResult): string {
  // Pretty-printed + stable key order so fixture diffs in review are readable and
  // don't spuriously flag on object-key reordering.
  return JSON.stringify(JSON.parse(stableStringify(result)), null, 2) + '\n';
}
