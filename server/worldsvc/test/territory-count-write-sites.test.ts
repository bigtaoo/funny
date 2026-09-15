// Static gate: `territoryCount` must be written wherever `yieldRate` is (2026-09-15, audit doc §10.1).
//
// The mirror's whole correctness argument is that it has NO maintenance point of its own: every path that
// can change tile ownership must already refresh `yieldRate` (or the player's production is wrong, which
// they notice in minutes), so pinning the count's write sites to the yield's write sites means the two
// cannot drift apart independently.
//
// That argument holds for the eight sites that exist today, and the e2e tests cover them. What it does NOT
// survive is the ninth: someone adds a new ownership-changing path six months from now, writes `yieldRate`,
// forgets `territoryCount` — and every behavioural test in this repo stays green, because none of them
// exercises a path that does not exist yet. The symptom would be a slowly drifting number in the HUD with
// no failing test anywhere.
//
// So the invariant is pinned as source text rather than left to reviewer memory. Two rules, both narrow:
//   ① any `$set` block that writes `yieldRate` must also write `territoryCount`;
//   ② every `recomputeYieldAndCount` call must destructure `count` — a caller that takes only `rate` has
//      silently opted out of rule ① while still looking like a yield refresh.
//
// Pure text analysis: runs in milliseconds, needs no database.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');

/** Strip comments — these files carry a lot of prose about `yieldRate`, and none of it is a write site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !p.includes(`${path.sep}generated${path.sep}`)) out.push(p);
  }
  return out;
}

/**
 * Every `$set: { … }` block in `src`, returned as its brace-balanced body text.
 *
 * Brace counting rather than a regex: these blocks nest (`{ $set: { resources: this.core.settleExpr(…),
 * troops: { $subtract: [...] } } }`), and a non-greedy match would stop at the first inner `}`.
 */
function setBlocks(src: string): string[] {
  const out: string[] = [];
  const marker = /\$set:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

const FILES = walk(SRC).map((file) => ({ file: path.relative(SRC, file), src: stripComments(fs.readFileSync(file, 'utf8')) }));

describe('territoryCount is written wherever yieldRate is (mirror invariant, audit doc §10.1)', () => {
  it('finds the write sites at all — the gate is worthless if its own parser stops matching', () => {
    const withYield = FILES.flatMap(({ file, src }) => setBlocks(src).filter((b) => /\byieldRate\b/.test(b)).map(() => file));
    // Eight as of 2026-09-15. Asserting a floor, not the exact number: adding a ninth write site is allowed
    // (the rule below is what constrains it), but dropping to zero means `$set` blocks stopped being found
    // and every assertion here would pass vacuously.
    expect(withYield.length).toBeGreaterThanOrEqual(8);
  });

  it('no $set writes yieldRate without territoryCount', () => {
    const offenders: string[] = [];
    for (const { file, src } of FILES) {
      for (const block of setBlocks(src)) {
        if (!/\byieldRate\b/.test(block)) continue;
        if (!/\bterritoryCount\b/.test(block)) offenders.push(`${file}: ${block.trim().slice(0, 120)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every recomputeYieldAndCount caller destructures `count`', () => {
    const offenders: string[] = [];
    for (const { file, src } of FILES) {
      if (file === path.join('core', 'yield.ts') || file === 'core.ts') continue; // the definition and its forwarder
      for (const line of src.split('\n')) {
        if (!line.includes('recomputeYieldAndCount(')) continue;
        if (!/count:\s*\w+/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
