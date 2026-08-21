// Guards the two directory-level entries in vitest.config.ts's `coverage.include`
// (`src/model/**`, `src/io/**`) — the layer this package gates at 90%, per ADR-070 Phase 4c.
//
// WHY THIS EXISTS, and why the coverage gate is not enough on its own. Graduating a package into
// the 90% gate with a directory-level include makes "someone added a file" visible to the COVERAGE
// ALGORITHM; it does not make it visible to the GATE, because the gate reads one percentage and
// that percentage has headroom: `covered/0.9 - total` = 58 lines at 529/529 here, so any 0%-covered
// file smaller than that keeps the gate green. Phase 4a measured this in map-editor (a 13-line
// PIXI+DOM probe left coverage at 96.98%, gate still passing), Phase 4b reproduced it in
// level-editor (a 10-line DOM probe, 97.8%, gate still passing), and the headroom GROWS as the
// scope's coverage improves — the better these tests get, the more impurity the percentage would
// tolerate. Measured here too, third package running: a 5-line DOM probe dropped into src/model/
// left coverage at 99.06% with the gate passing, while this file failed on it. So the boundary
// needs an assertion of its own. The coverage gate still does its own job
// (the gated layer must stay >=90% covered); this file pins the other half — what may live there.
//
// WHAT "PURE" MEANS HERE IS NOT "DOM-FREE", and this is where this package differs from its two
// predecessors. map-editor's guard blacklists pixi.js-legacy; level-editor's has no renderer to
// blacklist and leans entirely on a flat "no DOM globals" list. Neither shape fits: `src/io/**` is
// IN the gated scope and it legitimately reaches for window, document, localStorage, indexedDB,
// Blob and URL — persistence and file exchange are its whole job, and a flat DOM ban would either
// be a lie or would push io/ out of scope, which is exactly the "define the gap away" move ADR-070
// refuses. The line this package actually draws is RUNNABLE HEADLESS: every browser API in scope
// has a real stand-in (fake-indexeddb for IndexedDB, vi.stubGlobal for window/document/localStorage,
// Node's own Blob/URL/resolveObjectURL), whereas `new PIXI.Application` has none.
//
// So the check is two-tier, one mechanism:
//   · src/model/** — DOM-free outright. Nothing on BROWSER_GLOBALS may appear.
//   · src/io/**    — may use the explicitly listed IO_ALLOWED_GLOBALS and nothing else.
// The allow-list is a BUDGET, not a description: adding a browser API to io/ means editing this
// list, which is the moment to say how it will be tested headlessly. It deliberately excludes every
// HTML*Element type and the canvas/rAF/observer family even though `document` itself is allowed —
// an io/ module that starts naming element types is drifting into being a ui/ panel, and that
// should be a conversation rather than a silent commit.
//
// Both include entries are directories, and a test below pins that: removing the last per-file
// entry (`src/rendering/Playback.ts`) was half of what Phase 4c did, on Phase 4a's reading that a
// per-file include is the smell of a missing module boundary. Playback turned out to be editor
// state, not rendering, so it moved to src/model/Playback.ts.
//
// Technique matches the sibling guards: read the real sources off disk rather than importing them,
// since the thing under test is a property of the files, not of any runtime value.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** The gated directories, derived from vitest.config.ts rather than hardcoded — see the
 *  "guards exactly what coverage.include names" test below for why that matters. */
const GATED_DIRS = ['io', 'model'];

/** Bare specifiers a gated module may import. Default-deny: everything else is a breach.
 *  - `@vfx/types` is the game's own effect data model (types only) and `@vfx/parseEffectDef` its
 *    validator — both PIXI-free, which is the whole reason the editor can share them. The other
 *    `@vfx/*` modules are NOT allowed: interpret.ts and primitives.ts import pixi.js-legacy, and
 *    `import type` from them would count too (erased at runtime, but it makes the dependency
 *    direction unreadable, and the direction is the point — Phase 4a moved a type across for
 *    exactly this reason). */
const ALLOWED_BARE = ['@vfx/types', '@vfx/parseEffectDef'];

/** Which gated directory a file lives in. */
function dirOfFile(file: string): string {
  return relative(SRC, file).split(sep)[0]!;
}

/** Relative imports may stay inside the gated set, but only DOWNHILL: io/ may use model/, model/
 *  may not use io/. Nothing in the include list gives that direction away for free — both
 *  directories are gated — so it is asserted here. model/ is the layer with no I/O at all; the day
 *  it imports the IndexedDB store is the day its tests need a database. */
function isAllowedSpecifier(spec: string, fromFile: string): boolean {
  if (ALLOWED_BARE.includes(spec)) return true;
  if (!spec.startsWith('.')) return false; // any other bare package (pixi.js-legacy included)
  const rel = relative(SRC, resolve(dirname(fromFile), spec)).split(sep).join(posix.sep);
  const allowedDirs = dirOfFile(fromFile) === 'io' ? GATED_DIRS : ['model'];
  return allowedDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** Every browser/DOM global that must not appear in a gated module unless explicitly allowed. The
 *  first block is what the impure half of THIS editor actually uses (grepped off index.ts,
 *  rendering/PreviewRenderer.ts and ui/*), so a breach is caught by name; the rest are obvious
 *  neighbours added so the list is not merely a snapshot of today's imports. */
const BROWSER_GLOBALS = [
  'document', 'window', 'requestAnimationFrame', 'ResizeObserver', 'performance', 'prompt',
  'confirm', 'MouseEvent', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLSpanElement', 'HTMLDivElement',
  'HTMLCanvasElement', 'HTMLAnchorElement',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'Blob', 'URL', 'FileReader',
  'navigator', 'location', 'fetch', 'XMLHttpRequest', 'alert', 'cancelAnimationFrame',
  'getComputedStyle', 'Image', 'WheelEvent', 'KeyboardEvent', 'CanvasRenderingContext2D',
  'MutationObserver', 'showOpenFilePicker', 'showSaveFilePicker',
];

/** The subset `src/io/**` may use, each with an established headless stand-in:
 *  - window / document / localStorage → vi.stubGlobal (Library.test.ts, IOController.test.ts)
 *  - indexedDB + the IDB* interface types → fake-indexeddb (ProjectStore.test.ts, real IndexedDB
 *    semantics, not a mock of the store's own API)
 *  - Blob / URL → Node has both for real; IOController.test.ts reads the download blob back
 *    through node:buffer's resolveObjectURL
 *  - crypto → randomUUID, stubbed both present and absent
 *  - showOpenFilePicker / showSaveFilePicker → probed with `in window`, so a window stub without
 *    the key is what selects the fallback path
 *  Note what is NOT here: every HTML*Element type, the canvas/rAF/observer family, and
 *  performance. io/ may talk to the browser; it may not build or drive UI. */
const IO_ALLOWED_GLOBALS = new Set([
  'window', 'document', 'localStorage', 'indexedDB', 'crypto', 'Blob', 'URL',
  'showOpenFilePicker', 'showSaveFilePicker',
]);

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

const GATED_FILES = GATED_DIRS.flatMap(tsFilesIn);

describe('gated layer boundary (src/model/**, src/io/**)', () => {
  it('imports nothing outside the gated set, and only downhill within it', () => {
    const breaches: string[] = [];
    for (const file of GATED_FILES) {
      for (const spec of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        if (!isAllowedSpecifier(spec, file)) breaches.push(`${relative(PKG, file)} imports ${spec}`);
      }
    }
    expect(
      breaches,
      'a gated module reached outside src/{model,io}/ + @vfx/{types,parseEffectDef}, or src/model/ imported src/io/',
    ).toEqual([]);
  });

  it('uses no browser global beyond what its tier allows', () => {
    const breaches: string[] = [];
    for (const file of GATED_FILES) {
      const allowed = dirOfFile(file) === 'io' ? IO_ALLOWED_GLOBALS : new Set<string>();
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const g of BROWSER_GLOBALS) {
        if (allowed.has(g)) continue;
        if (new RegExp(`\\b${g}\\b`).test(src)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches, 'src/model/** must be DOM-free; src/io/** may use only IO_ALLOWED_GLOBALS').toEqual([]);
  });

  // ── canaries: a scan that scans nothing prints the same "OK" as a scan that found nothing ──

  it('actually scanned every gated directory, and found imports to check', () => {
    for (const dir of GATED_DIRS) {
      expect(tsFilesIn(dir).length, `src/${dir}/ has no .ts files — moved, renamed, or the walk broke`).toBeGreaterThan(0);
    }
    expect(GATED_FILES.length).toBeGreaterThanOrEqual(6);
    // Without this, an importsOf() regex that matches nothing (the CRLF/multi-line class of bug)
    // would make the boundary test above pass vacuously on every file forever.
    const total = GATED_FILES.reduce((n, f) => n + importsOf(readFileSync(f, 'utf8')).length, 0);
    expect(total, 'importsOf() found zero imports across the whole gated layer — the regex is broken').toBeGreaterThan(0);
    // Same for the global scan: the allow-list is only meaningful if the scanner can see a global
    // at all, and io/ is known to use several.
    const ioSrc = tsFilesIn('io').map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
    expect(/\bindexedDB\b/.test(ioSrc) && /\bdocument\b/.test(ioSrc), 'the global scanner sees nothing in src/io/ — it cannot be catching anything either').toBe(true);
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
        '// a doc comment mentioning document and requestAnimationFrame',
        "import { a } from './x';",
        '/* block comment naming pixi.js-legacy and HTMLCanvasElement */',
        'const b = 1;',
      ].join(nl) + nl;
      const stripped = stripComments(src);
      expect(stripped, `line comments not stripped under ${name}`).not.toMatch(/\brequestAnimationFrame\b/);
      expect(stripped, `block comments not stripped under ${name}`).not.toMatch(/pixi/);
      expect(importsOf(src), `imports not found under ${name}`).toEqual(['./x']);

      // Multi-line import: the `from` clause lands on its own line. EffectModel.ts has a real one,
      // and it is what broke an earlier version of the reachability guard's import regex.
      const multi = ['import {', '  a,', '  b,', "} from '../model/EffectModel';"].join(nl) + nl;
      expect(importsOf(multi), `multi-line import missed under ${name}`).toEqual(['../model/EffectModel']);
    }
  });

  // The load-bearing link between this file and the gate: if someone adds a third directory to
  // coverage.include, the coverage number keeps working but this guard would silently keep checking
  // only the old two. Deriving the expected set from the config makes that a failure.
  it('guards exactly what coverage.include names, and nothing is listed per-file', () => {
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
    // Every entry must be a whole directory. A per-file entry is how a module ends up gated without
    // this guard covering it (rendering/Playback.ts was one until Phase 4c), so adding one has to
    // come with a decision about the boundary rather than slipping in as a one-liner.
    const dirEntries = entries.filter((e) => e.endsWith('/**'));
    expect(dirEntries, 'coverage.include gained a per-file entry — see this file\'s header before adding one').toEqual(entries);
    expect(dirEntries.map((e) => e.replace(/^src\//, '').replace(/\/\*\*$/, '')).sort()).toEqual([...GATED_DIRS].sort());
  });
});
