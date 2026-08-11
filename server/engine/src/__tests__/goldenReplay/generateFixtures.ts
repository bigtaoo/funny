// Golden replay harness — ONE-OFF baseline recorder, not part of the test suite (not a
// *.test.ts, not in package.json's `test` script). Run this manually only when you
// INTEND to change the engine's simulation output (recording a new, deliberately
// different baseline) — never to "make a failing test pass" without understanding why
// it failed first. Regenerating fixtures after an unexplained mismatch defeats the
// entire point of this harness.
//
//   cd server/engine && npx tsx src/__tests__/goldenReplay/generateFixtures.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenarios';
import { runScenario, toFixtureJson, fixtureFileName } from './runScenario';

const FIXTURES_DIR = join(__dirname, 'fixtures');

for (const scenario of SCENARIOS) {
  const result = runScenario(scenario);
  const path = join(FIXTURES_DIR, fixtureFileName(scenario.name));
  writeFileSync(path, toFixtureJson(result), 'utf8');
  console.log(`wrote ${scenario.name}: ${result.ticksRun} ticks, finalStateHash=${result.finalStateHash.slice(0, 12)}…`);
}
console.log(`${SCENARIOS.length} fixtures written to ${FIXTURES_DIR}`);
