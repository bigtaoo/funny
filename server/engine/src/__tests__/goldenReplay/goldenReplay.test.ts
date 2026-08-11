/**
 * Golden replay regression suite for the GameEngine mixin chain
 * (engine/{base,helpers,campaign,commands,winCondition,loop}.ts).
 *
 * Added as the safety net for the setup/sim/driver split documented in
 * claudedocs/server.md ("engine/GameEngine") — every scenario's simulation output
 * is pinned bit-for-bit against a recorded baseline (fixtures/*.json). A failure
 * here means the refactor changed simulation behavior, NOT just moved code —
 * exactly the class of bug this harness exists to catch before it reaches a real
 * match (where it would surface only as replay desync).
 *
 * Do NOT "fix" a failure by regenerating fixtures (generateFixtures.ts) unless you
 * have independently confirmed the behavior change is intentional and understand
 * exactly which line caused it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIOS } from './scenarios';
import { runScenario, fixtureFileName, type ScenarioFixture } from './runScenario';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadFixture(scenarioName: string): ScenarioFixture {
  const raw = readFileSync(join(FIXTURES_DIR, fixtureFileName(scenarioName)), 'utf8');
  return JSON.parse(raw) as ScenarioFixture;
}

for (const scenario of SCENARIOS) {
  test(`golden replay: ${scenario.name}`, () => {
    const fixture = loadFixture(scenario.name);
    const result = runScenario(scenario);

    assert.equal(result.ticksRun, fixture.ticksRun, 'scenario tick count drifted from the fixture — update scenarios.ts and fixtures together');

    // Per-tick hashes first: pinpoints the exact tick where behavior diverged,
    // instead of just "final state differs" (which could be tick 1 or tick 900).
    const firstMismatch = fixture.tickHashes.findIndex((h, i) => h !== result.tickHashes[i]);
    assert.equal(
      firstMismatch,
      -1,
      firstMismatch >= 0
        ? `event batch at tick ${firstMismatch} diverged from the golden fixture (expected ${fixture.tickHashes[firstMismatch]}, got ${result.tickHashes[firstMismatch]})`
        : undefined,
    );

    assert.equal(result.eventLogHash, fixture.eventLogHash, 'full event log hash diverged');
    assert.equal(
      result.finalStateHash,
      fixture.finalStateHash,
      `final state diverged — compare result.finalSnapshot against fixtures/${fixtureFileName(scenario.name)}'s finalSnapshot`,
    );
  });
}
