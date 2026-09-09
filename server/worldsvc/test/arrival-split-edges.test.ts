// Static gate for the ONE-WAY edge between the arrival tick's two halves (2026-09-09 arrival.ts split,
// WORLDSVC_CONCURRENCY_AUDIT_2026-09-05 §7.6).
//
// §7.2 established that the walking half and the settling half are disjoint — different queries, no shared
// state — and §7.6 turned that into two modules. There is exactly one edge between them, and it points one
// way: arrivalWalk.ts calls applyArrival when a march it is stepping reaches its final cell. arrivalSettle.ts
// must never reach back.
//
// Why a gate and not just a comment. Nothing in the type system stops the back-import, and adding it would
// not fail to compile: it would make the pair a load-time ESM cycle, whose symptom is one of the two module
// bindings still being uninitialised when the other's body runs — an "applyArrival is not a function" from
// inside a scheduler tick, at whichever call site happens to fire first. That reads as a runtime bug in the
// arrival code, not as an import mistake, which is exactly the kind of trail this file exists to shorten.
// (Same reasoning as compute-worker-module-graph.test.ts: pin the module-graph rule where it is cheap to
// check, rather than discovering it from a crash whose message names the wrong thing.)
//
// The second assertion is the reason the edge is one-way at all: the settling half is where the DEFENDER's
// ledger gets written, so it is the half that can be neither batched nor made concurrent (§6.1/§7.1). A
// walk-the-tiles import appearing there would mean stepping logic had migrated into it, which is how the
// 592-line file happened in the first place.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(__dirname, '..', 'src', 'combatMarch');

/** Strip comments — these files are mostly prose, and it names the sibling modules constantly. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Relative specifiers this module resolves at LOAD time. `import type` is erased, so it cannot form a cycle. */
function loadTimeImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\s)([\s\S]*?)\s*from\s*'(\.[^']*)'/gm)) {
    out.push(m[2]!);
  }
  return out;
}

describe('combatMarch arrival split: the edge between the two halves stays one-way', () => {
  it('arrivalWalk.ts imports the settling half (the destination-reached edge), at load time', () => {
    expect(loadTimeImports(code('arrivalWalk.ts'))).toContain('./arrivalSettle');
  });

  it('arrivalSettle.ts never imports the walking half — no cycle, and no stepping logic drifting back in', () => {
    expect(loadTimeImports(code('arrivalSettle.ts'))).not.toContain('./arrivalWalk');
    expect(code('arrivalSettle.ts')).not.toContain('advanceMarch');
  });

  it('arrival.ts is the queue end only: it drives both halves and neither imports it back', () => {
    const shell = loadTimeImports(code('arrival.ts'));
    expect(shell).toContain('./arrivalWalk');
    expect(shell).toContain('./arrivalSettle');
    for (const half of ['arrivalWalk.ts', 'arrivalSettle.ts']) {
      expect(loadTimeImports(code(half))).not.toContain('./arrival');
    }
  });
});
