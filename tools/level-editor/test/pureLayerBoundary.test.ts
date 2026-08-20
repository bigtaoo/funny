// Guards the PURITY of the two directory-level entries in vitest.config.ts's `coverage.include`
// (`src/state/**`, `src/layout/**`) — the editor's pure layer, per ADR-070 Phase 4b.
//
// WHY THIS EXISTS, and why the coverage gate is not enough on its own. Graduating a package into
// the 90% gate with a directory-level include makes "someone added a file" visible to the COVERAGE
// ALGORITHM; it does not make it visible to the GATE, because the gate only reads one percentage
// and that percentage has headroom: `covered/0.9 - total` = 49 lines at 445/445, and a 0%-covered
// file smaller than that keeps the gate green. Phase 4a discovered this the hard way in map-editor
// (a 13-line DOM probe dropped into its pure directory left coverage at 96.98% with the gate still
// passing) and its guard is the direct ancestor of this file.
//
// This package's own numbers make the point differently but not more safely: its five out-of-scope
// files are 196-477 lines, all far past 49, so dropping an EXISTING one in really would turn the
// gate red. That is an accident of how big those files happen to be, not a property of the gate — a
// new small DOM helper would sail through, and the headroom GROWS as the pure layer's coverage
// improves. So the boundary gets an assertion of its own. The coverage gate still does its own job
// (the pure layer must stay >=90% covered); this file pins the other half — that it is still pure.
//
// NOTE on what "pure" means HERE: unlike map-editor, this editor has no pixi.js dependency at all.
// board/BoardPanel.ts and timeline/TimelinePanel.ts draw with a raw `canvas.getContext('2d')`, so
// there is no renderer package to blacklist; the barrier is the DOM itself, which makes the
// DOM_GLOBALS list below the load-bearing half of this file rather than the import whitelist.
//
// Scope is deliberately the two DIRECTORY entries only. `src/units.ts` is in the include list as a
// whole named file, and you cannot add a file to a file — there is no invisible-growth risk there.
//
// Technique: read the real sources off disk rather than importing them, since the thing under test
// is a property of the files, not of any runtime value.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** The pure directories, derived from vitest.config.ts rather than hardcoded — see the
 *  "guards the same set the include list names" test below for why that matters. */
const PURE_DIRS = ['state', 'layout'];

/** Import specifiers a pure module may use. Default-deny: everything else is a boundary breach.
 *  - `@nw/engine/*` is the game's own pure core (board geometry constants, fixed-point math, level
 *    definition types) — no DOM, no Node-only deps, and the whole reason vitest.config.ts aliases
 *    it straight at server/engine/src.
 *  - `../units` is the third include entry, i.e. also pure by contract.
 *  - relative paths that stay inside the pure directories. */
function isAllowedSpecifier(spec: string, fromFileDir: string): boolean {
  if (spec === '@nw/engine' || spec.startsWith('@nw/engine/')) return true;
  if (!spec.startsWith('.')) return false; // any other bare package
  const target = resolve(fromFileDir, spec);
  const rel = relative(SRC, target).split(sep).join(posix.sep);
  if (rel === 'units') return true;
  return PURE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** Browser/DOM globals a pure module must not reach for. This is the list the impure half of THIS
 *  editor actually uses (grepped off index.ts / the two panels / inspector/*), plus the obvious
 *  neighbours, so a breach is caught by name rather than by category. `\b`-anchored and matched
 *  against the comment-stripped source, so a mention inside a doc comment — and there are several,
 *  explaining what the canvas half does with these values — is not a false positive. */
const DOM_GLOBALS = [
  'document', 'window', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement',
  'HTMLCanvasElement', 'HTMLInputElement', 'HTMLSelectElement', 'CanvasRenderingContext2D',
  'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'Image', 'Blob', 'FileReader', 'fetch',
  'XMLHttpRequest', 'alert', 'confirm', 'showOpenFilePicker', 'showSaveFilePicker',
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

describe('pure layer boundary (src/state/**, src/layout/**)', () => {
  it('imports nothing outside the pure set', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      for (const spec of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        if (!isAllowedSpecifier(spec, dirname(file))) {
          breaches.push(`${relative(PKG, file)} imports ${spec}`);
        }
      }
    }
    // `import type` counts too. Phase 4a hit exactly that edge in map-editor: a type defined in a
    // renderer module made the pure layer `import type` from it — erased at runtime, but it makes
    // the dependency direction unreadable, and the direction is the point of the split. The same
    // applies here to anything under src/board/, src/timeline/ or src/inspector/.
    expect(breaches, 'a pure module reached outside src/{state,layout}/, src/units.ts or @nw/engine').toEqual([]);
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
    expect(PURE_FILES.length).toBeGreaterThanOrEqual(3);
    // Without this, an importsOf() regex that matches nothing (the CRLF/multi-line class of bug)
    // would make the boundary test above pass vacuously on every file forever.
    const total = PURE_FILES.reduce((n, f) => n + importsOf(readFileSync(f, 'utf8')).length, 0);
    expect(total, 'importsOf() found zero imports across the whole pure layer — the regex is broken').toBeGreaterThan(0);
  });

  // Both scanners are regex-over-whole-file, and this repo checks out CRLF on Windows
  // (core.autocrlf=true) while CI checks out LF — exactly the setup where a source scanner works on
  // one and silently matches nothing on the other, since "found no breaches" and "scanned nothing"
  // print identically. `$` under /m does match before a bare CR (the spec's LineTerminator includes
  // it), so the current strip handles both; that is a property of the regex rather than something
  // the code states, so pin it instead of re-deriving it after the next edit. Deliberately does NOT
  // assert what the files on disk use — that would flip red depending on which OS ran the checkout.
  it('scans correctly under both LF and CRLF line endings', () => {
    const LF = String.fromCharCode(10);
    const CRLF = String.fromCharCode(13, 10);
    for (const [name, nl] of [['LF', LF], ['CRLF', CRLF]] as const) {
      const src = [
        '// a doc comment mentioning document and window and ResizeObserver',
        "import { a } from './x';",
        '/* block comment naming HTMLCanvasElement */',
        'const b = 1;',
      ].join(nl) + nl;
      const stripped = stripComments(src);
      expect(stripped, `line comments not stripped under ${name}`).not.toMatch(/\bdocument\b/);
      expect(stripped, `block comments not stripped under ${name}`).not.toMatch(/HTMLCanvasElement/);
      expect(importsOf(src), `imports not found under ${name}`).toEqual(['./x']);

      // Multi-line import: the `from` clause lands on its own line. Both layout modules have real
      // ones, and it is what broke an earlier version of the reachability guard's import regex.
      const multi = ['import {', '  a,', '  b,', "} from '../layout/board';"].join(nl) + nl;
      expect(importsOf(multi), `multi-line import missed under ${name}`).toEqual(['../layout/board']);
    }
  });

  // The load-bearing link between this file and the gate: if someone adds a third directory to
  // coverage.include, the coverage number keeps working but this guard would silently keep
  // checking only the old two. Deriving the expected set from the config makes that a failure.
  it('guards exactly the directory-level entries coverage.include names', () => {
    const cfg = readFileSync(join(PKG, 'vitest.config.ts'), 'utf8');
    // Anchor on the `coverage:` block first. There are TWO `include:` keys in this config and the
    // other one (test.include, `['test/**/*.test.ts']`) comes first in the file — matching it
    // instead yields zero directory entries, which reads exactly like "the include list has no
    // directory entries" rather than "you parsed the wrong list".
    const covAt = cfg.indexOf('coverage:');
    expect(covAt, 'no `coverage:` block in vitest.config.ts').toBeGreaterThan(-1);
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
