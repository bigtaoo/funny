// Guards the PURITY of the two directory-level entries in vitest.config.ts's `coverage.include`
// (`src/state/**`, `src/tiles/**`) — the editor's pure layer, per ADR-070 Phase 4a.
//
// WHY THIS EXISTS, and why the coverage gate is not enough on its own. Phase 4a's write-up claimed
// that once the include is directory-level and the package is gated at 90%, a PIXI/DOM module
// dropped into one of those directories "turns the gate red", because it lands inside an INCLUDED
// directory at ~0%. That is directionally true and quantitatively false: the scope is at 644/652
// lines, so there is `644/0.9 - 652` = 63 lines of headroom, and a 0%-covered file smaller than
// that keeps the gate GREEN. Ten of this package's sixteen PIXI/DOM files are under 63 lines
// (every atlas loader, refresh.ts, citySprites.ts, viewport.ts, status.ts, i18nApply.ts,
// panels.ts), so the "gate catches it" story fails for the majority of the realistic mistakes.
// Worse, the headroom GROWS as the pure layer's coverage improves — the better the tests get, the
// more impurity the gate would tolerate. So the boundary needs an assertion of its own, and this
// is it. The coverage gate still does its own job (the pure layer must stay ≥90% covered); this
// file pins the other half — that the pure layer is still pure.
//
// Scope is deliberately the two DIRECTORY entries only. `src/i18n.ts` and `src/constants.ts` are in
// the include list as whole named files, and you cannot add a file to a file — there is no
// invisible-growth risk there. (i18n.ts also genuinely touches `localStorage`, behind try/catch,
// which is precisely why it is a named file rather than a resident of a pure directory.)
//
// Technique matches this package's other source-scanning tests (rasterizeCallSites.test.ts,
// resMotifCallSite.test.ts): read the real sources off disk rather than importing them, since the
// thing under test is a property of the files, not of any runtime value.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** The pure directories, derived from vitest.config.ts rather than hardcoded — see the
 *  "guards the same set the include list names" test below for why that matters. */
const PURE_DIRS = ['state', 'tiles'];

/** Import specifiers a pure module may use. Default-deny: everything else is a boundary breach.
 *  - `@nw/shared/slg` is the shared pure SLG core (no PIXI, no Node-only deps — that's the whole
 *    reason vitest.config.ts aliases the `/slg` subpath instead of the `@nw/shared` barrel).
 *  - `../constants`, `../i18n` are the other two include entries, i.e. also pure by contract.
 *  - relative paths that stay inside the pure directories. */
function isAllowedSpecifier(spec: string, fromFileDir: string): boolean {
  if (spec === '@nw/shared/slg') return true;
  if (!spec.startsWith('.')) return false; // any other bare package (pixi.js-legacy included)
  const target = resolve(fromFileDir, spec);
  const rel = relative(SRC, target).split(sep).join(posix.sep);
  if (rel === 'constants' || rel === 'i18n') return true;
  return PURE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** Browser/DOM globals a pure module must not reach for. `\b`-anchored and matched against the
 *  comment-stripped source, so a mention inside a doc comment (there are several, explaining what
 *  the PIXI half does with these values) is not a false positive. */
const DOM_GLOBALS = [
  'document', 'window', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'HTMLCanvasElement',
  'CanvasRenderingContext2D', 'Image', 'fetch', 'XMLHttpRequest', 'alert', 'confirm',
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** All `.ts` files under `src/<dir>`, recursively. Returns [] for a missing dir — the canary test
 *  below is what turns that into a failure, so every other test can stay simple. */
function tsFilesIn(dir: string): string[] {
  const root = join(SRC, dir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = join(root, e.name);
    if (e.isDirectory()) out.push(...tsFilesIn(join(dir, e.name)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Every import specifier in a file. `from '...'` covers named/default/type imports including the
 *  multi-line form (the `from` clause is always on one line even when the brace list is not — the
 *  cross-line import that broke an earlier version of the reachability guard's regex); the other
 *  two forms catch bare side-effect imports and dynamic `import()`. */
function importsOf(src: string): string[] {
  const specs: string[] = [];
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

const PURE_FILES = PURE_DIRS.flatMap(tsFilesIn);

describe('pure layer boundary (src/state/**, src/tiles/**)', () => {
  it('imports nothing outside the pure set', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      for (const spec of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        if (!isAllowedSpecifier(spec, dirname(file))) {
          breaches.push(`${relative(PKG, file)} imports ${spec}`);
        }
      }
    }
    // Named explicitly rather than left to the generic message: pixi is the import this whole
    // directory split exists to keep out, and `import type` from a PIXI module counts — that is
    // the exact edge Phase 4a moved TerrainTextureName for (erased at runtime, but it makes the
    // dependency direction unreadable).
    expect(breaches, 'a pure module reached outside src/{state,tiles}/, src/constants.ts, src/i18n.ts or @nw/shared/slg').toEqual([]);
  });

  it('references no DOM or browser global', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const g of DOM_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(src)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches).toEqual([]);
  });

  // ── canaries: a scan that scans nothing prints the same "OK" as a scan that found nothing ──

  it('actually scanned every pure directory, and found imports to check', () => {
    for (const dir of PURE_DIRS) {
      expect(tsFilesIn(dir).length, `src/${dir}/ has no .ts files — moved, renamed, or the walk broke`).toBeGreaterThan(0);
    }
    expect(PURE_FILES.length).toBeGreaterThanOrEqual(6);
    // Without this, an importsOf() regex that matches nothing (the CRLF/multi-line class of bug)
    // would make the boundary test above pass vacuously on every file forever.
    const total = PURE_FILES.reduce((n, f) => n + importsOf(readFileSync(f, 'utf8')).length, 0);
    expect(total, 'importsOf() found zero imports across the whole pure layer — the regex is broken').toBeGreaterThan(0);
  });

  // The load-bearing link between this file and the gate: if someone adds a third directory to
  // coverage.include, the coverage number keeps working but this guard would silently keep
  // checking only the old two. Deriving the expected set from the config makes that a failure.
  it('guards exactly the directory-level entries coverage.include names', () => {
    const cfg = readFileSync(join(PKG, 'vitest.config.ts'), 'utf8');
    // Anchor on the `coverage:` block first. There are TWO `include:` keys in this config and the
    // other one (test.include, `['test/**/*.test.ts']`) comes first in the file — matching it
    // instead yields zero directory entries, which reads exactly like "the include list has no
    // directory entries" rather than "you parsed the wrong list". Caught by writing this test.
    const covAt = cfg.indexOf('coverage:');
    expect(covAt, "no `coverage:` block in vitest.config.ts").toBeGreaterThan(-1);
    const arr = /include:\s*\[([^\]]*)\]/.exec(cfg.slice(covAt));
    expect(arr, "could not find coverage.include's array literal in vitest.config.ts").not.toBeNull();
    const entries = [...arr![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(entries.length, 'parsed zero include entries').toBeGreaterThan(0);
    // Confirms we read the coverage list and not some other `include:` — every coverage entry is
    // a src path, every test-include entry is a test path.
    for (const e of entries) expect(e.startsWith('src/'), `include entry ${e} is not under src/ — wrong include list?`).toBe(true);
    const dirEntries = entries
      .filter((e) => e.endsWith('/**'))
      .map((e) => e.replace(/^src\//, '').replace(/\/\*\*$/, ''));
    expect(dirEntries.sort()).toEqual([...PURE_DIRS].sort());
  });
});
