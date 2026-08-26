// Determinism gate for the engine's logic layer: no Math.random(), no Date.now(), no `new Date()`.
//
// This replaces an ESLint override, and the story of why is the reason this file exists at all.
// `client/.eslintrc.js` carried a `no-restricted-syntax` block banning exactly these three, scoped
// to `src/game/GameEngine.ts`, `src/game/systems/**`, `src/game/math/**` and five sibling files.
// Two things then happened, neither of which anyone noticed:
//
//   1. 2026-08-02 — the engine moved out of the client into `server/engine/src` (@nw/engine) and the
//      old `src/game/*` re-export shims were deleted. Every path that override named stopped
//      existing, so it matched nothing.
//   2. Separately, ESLint reached v9 and stopped reading `.eslintrc.js` at all, so `npm run lint`
//      had been failing at startup — and no CI step ran it, so nothing said so.
//
// Either one alone would have silently retired this rule. The invariant it protects has not gone
// anywhere: replay, peer-judge arbitration and lockstep all assume that re-running a tick sequence
// from the same seed produces the same result, so a single `Math.random()` in the logic layer is a
// desync that only shows up as a replay that diverges from the match it recorded.
//
// A source scan rather than a lint rule, deliberately: the engine package has no ESLint setup of its
// own, and standing one up to host three rules would put the gate in a place CI does not currently
// run. This suite already runs on every push.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ENGINE_SRC = join(__dirname, '../../server/engine/src');

/** Every .ts file under the engine's src, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Strips comments and string literals before scanning. Without this the gate is worse than useless:
 * `math/fixed.ts` and `math/prng.ts` both *document* the ban in prose ("✗ Math.random() → use Prng"),
 * so a naive grep reports 5 hits on a clean tree and whoever sees that red concludes the scan is
 * broken rather than the code.
 */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments (incl. JSDoc)
    .replace(/\/\/[^\n]*/g, ' ')          // line comments
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
}

const BANNED: Array<{ name: string; re: RegExp; why: string }> = [
  { name: 'Math.random()', re: /\bMath\s*\.\s*random\s*\(/g, why: 'use Prng from math/prng.ts, seeded by GameConfig.seed' },
  { name: 'Date.now()', re: /\bDate\s*\.\s*now\s*\(/g, why: 'time must be supplied externally; the engine counts ticks' },
  { name: 'new Date()', re: /\bnew\s+Date\s*\(/g, why: 'time must be supplied externally; the engine counts ticks' },
];

describe('engine logic layer is deterministic (source scan)', () => {
  const files = walk(ENGINE_SRC);

  it('finds engine sources to scan at all', () => {
    // A canary. If the engine moves again, this fails loudly instead of the whole scan passing
    // vacuously over an empty file list — which is exactly how the ESLint override this replaces
    // died: its globs kept matching nothing and nobody heard about it.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('GameEngine.ts'))).toBe(true);
  });

  it.each(BANNED)('no $name in server/engine/src', ({ re, why }) => {
    const hits: string[] = [];
    for (const file of files) {
      const src = strip(readFileSync(file, 'utf8'));
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) hits.push(`${relative(ENGINE_SRC, file).replace(/\\/g, '/')}:${i + 1}`);
      });
    }
    expect(hits, `non-deterministic call in the logic layer — ${why}`).toEqual([]);
  });

  it('the scan actually looks inside code, not just comments', () => {
    // Non-vacuity check: the strip() above removes prose mentions, so prove the regexes still fire
    // on real code. Without this, a strip() that over-matched would make the gate silently blind.
    const probe = strip('const x = Math.random(); // Math.random() in a comment\nconst s = "Date.now()";');
    expect(/\bMath\s*\.\s*random\s*\(/.test(probe)).toBe(true);      // the real call survives
    expect((probe.match(/Math\s*\.\s*random/g) ?? []).length).toBe(1); // the commented one does not
    expect(/\bDate\s*\.\s*now\s*\(/.test(probe)).toBe(false);         // the string literal does not
  });
});
