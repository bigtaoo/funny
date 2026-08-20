// Guards the two directory-level entries in vitest.config.ts's `coverage.include` — `src/logic/**`
// and `src/api/**`, the ops console's pure layer and its transport layer, per ADR-070 Phase 4e.
//
// WHY THIS EXISTS, and why the coverage gate is not enough on its own. Graduating a package into the
// 90% gate with a directory-level include makes "someone added a file" visible to the COVERAGE
// ALGORITHM; it does not make it visible to the GATE, because the gate reads one percentage and that
// percentage has headroom: `covered/0.9 - total` = 168 lines at 1516/1516 here, so any 0%-covered
// file smaller than that can be dropped into either directory and the gate stays green. Phase 4a
// measured this in map-editor (a 13-line DOM probe left coverage at 96.98%, gate passing) and 4b
// again in level-editor (10 lines, 97.8%, passing). This package's headroom is the LARGEST of the
// three, precisely because its pure layer is fully covered — the reward for good tests is more room
// for junk. Hence an assertion instead of a number.
//
// TWO TIERS, which is where this file departs from its 4a/4b ancestors. The include list names two
// directories with genuinely different rules:
//
//   src/logic/**  the pure layer: page decisions over plain data. Touches NO global — not the DOM,
//                 not the network, not storage. Imports only its own siblings and `../types`.
//   src/api/**    the transport layer: the REST client. It legitimately needs exactly three browser
//                 globals (`fetch`, `localStorage`, `location`) and the `Response` type — that is
//                 what a REST client IS, and it is why test/api.test.ts can exercise it under
//                 `environment: 'node'` by installing those three and nothing else. What it must not
//                 do is build DOM or reach into the page layer.
//
// Collapsing those into one rule would either let the DOM into the pure layer (if the union were
// allowed) or make the transport layer untestable-by-fiat (if it were forbidden). The classification
// is derived from the include list, so a THIRD directory added there fails until it is classified.
//
// Technique: read the real sources off disk rather than importing them, since the thing under test is
// a property of the files, not of any runtime value.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** No global at all, no import outside itself and `../types`. */
const PURE_DIRS = ['logic'];
/** May reach for the three network/storage globals below; still no DOM. */
const TRANSPORT_DIRS = ['api'];
const CHECKED_DIRS = [...PURE_DIRS, ...TRANSPORT_DIRS];

/**
 * The only bare-ish import either tier may use. `../types` is the frontend-local view-type mirror of
 * server/shared/admin.ts: pure `export type`/`export interface`, zero measured lines, no runtime code
 * at all. Anything else — `../dom`, `../pages`, a page module, an npm package — is a boundary breach.
 */
const SHARED_TYPES = 'types';

/**
 * Browser globals that mean "this file draws, or listens to, a user interface". None of these may
 * appear in EITHER checked directory. Grepped off the impure half of this console (pages/*, app.ts,
 * index.ts, dom.ts) so a breach is caught by name rather than by category, plus the obvious
 * neighbours a future page would reach for.
 */
const DOM_GLOBALS = [
  'document', 'window', 'navigator', 'sessionStorage', 'alert', 'confirm', 'prompt',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
  'cancelAnimationFrame', 'ResizeObserver', 'XMLHttpRequest',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'HTMLCanvasElement', 'Event', 'EventListener', 'KeyboardEvent',
  'MouseEvent', 'WheelEvent', 'Image', 'Blob', 'FileReader',
];

/**
 * What a REST client is allowed to need. Deliberately a SHORT closed list rather than "anything
 * non-DOM": if src/api/ ever needs a fourth global, that is worth one line of review, because it is
 * also a fourth thing test/api.test.ts has to install.
 */
const TRANSPORT_GLOBALS = ['fetch', 'localStorage', 'location', 'Response'];

/**
 * Comments out, string literals kept (import specifiers live in them).
 *
 * A character scanner, NOT the two-regex strip its 4a/4b ancestors used — that one is unsafe on this
 * package and was caught by this file's own canary. The reason: `//`-comments here talk about the
 * include list, and the phrase `src/api/**` contains `/*`. Stripping block comments first, as those
 * regexes do, starts a "block comment" inside that line comment and runs to the next `*​/` in the
 * file — which in src/api/index.ts is the `/* ignore *​/` inside `logout()`, forty lines below the
 * import block. Result: the whole import list disappears and the scan reports a clean file it never
 * read. Swapping the two regexes just moves the hole (a block comment whose first line contains `//`
 * would then be left half-open), so the state machine is the fix rather than an ordering tweak.
 *
 * Known limit: a regex literal containing a quote or a `/*` would confuse it. There are none in
 * either checked directory (`/[\n,]/` and `/-/g` are the only two), and a real tokenizer is more
 * machinery than a boundary check needs — but that is why the canaries below count what was found
 * instead of trusting that anything was.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue; // leave the newline itself in place, so /m-anchored assertions still line up
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
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

/**
 * Every import specifier in a file. `from '...'` covers named/default/type imports including the
 * MULTI-LINE form (the `from` clause lands on its own line even when the brace list does not) — both
 * checked directories contain real ones today: src/logic/auctionAudit.ts and src/api/index.ts each
 * import a long list of view types across several lines, and a regex that could not span them would
 * report zero imports for those two files and pass the whitelist test vacuously. That exact bug hit
 * an earlier version of the reachability guard's regex, on this very package. The other two forms
 * catch bare side-effect imports and dynamic `import()`.
 */
function importsOf(src: string): string[] {
  const specs: string[] = [];
  // The `(?<!['"])` is load-bearing on THIS package, and was not needed by the 4a/4b ancestors of
  // this file: src/api/index.ts contains `qs.set('from', String(fromMs))`, and a bare
  // `\bfrom\s*['"]` matches the `from` INSIDE that string literal, then swallows everything up to
  // the next quote as a "specifier" — reporting a breach that is not there, on a file that has none.
  // The canary below is what turned that into a visible failure rather than a corrupted scan.
  for (const re of [/(?<!['"])\bfrom\s*['"]([^'"]+)['"]/g, /(?<!['"])\bimport\s+['"]([^'"]+)['"]/g, /(?<!['"])\bimport\s*\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

/** True when `spec`, resolved from `fromFileDir`, stays inside `dirs` or hits `../types`. */
function isAllowedSpecifier(spec: string, fromFileDir: string, dirs: readonly string[]): boolean {
  if (!spec.startsWith('.')) return false; // any bare package, including a relative-looking typo
  const rel = relative(SRC, resolve(fromFileDir, spec)).split(sep).join(posix.sep);
  if (rel === SHARED_TYPES) return true;
  return dirs.some((d) => rel === d || rel.startsWith(`${d}/`));
}

const filesOf = (dirs: readonly string[]): string[] => dirs.flatMap(tsFilesIn);

describe('layer boundary (src/logic/**, src/api/**)', () => {
  it('the pure layer imports nothing but its own siblings and ../types', () => {
    const breaches: string[] = [];
    for (const file of filesOf(PURE_DIRS)) {
      for (const spec of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        if (!isAllowedSpecifier(spec, dirname(file), PURE_DIRS)) breaches.push(`${relative(PKG, file)} imports ${spec}`);
      }
    }
    // `import type` counts too. Phase 4a hit exactly that edge in map-editor: a type defined in a
    // renderer module made the pure layer `import type` from it — erased at runtime, but it makes the
    // dependency direction unreadable, and the direction is the point of the split. Here that means
    // src/logic/ must not `import type` from src/pages/, src/api/ or src/dom.ts either.
    expect(breaches, 'a pure module reached outside src/logic/ or src/types.ts').toEqual([]);
  });

  it('the transport layer imports nothing but its own siblings and ../types', () => {
    const breaches: string[] = [];
    for (const file of filesOf(TRANSPORT_DIRS)) {
      for (const spec of importsOf(stripComments(readFileSync(file, 'utf8')))) {
        if (!isAllowedSpecifier(spec, dirname(file), TRANSPORT_DIRS)) breaches.push(`${relative(PKG, file)} imports ${spec}`);
      }
    }
    // Note the asymmetry, and that it is deliberate: the transport layer may NOT import src/logic/
    // either. Nothing needs it to, and the direction that does exist (pages -> logic, pages -> api)
    // is the one that keeps both halves independently testable.
    expect(breaches, 'a transport module reached outside src/api/ or src/types.ts').toEqual([]);
  });

  it('neither layer references a DOM or UI global', () => {
    const breaches: string[] = [];
    for (const file of filesOf(CHECKED_DIRS)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const g of DOM_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(src)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches).toEqual([]);
  });

  it('the pure layer references no network or storage global either', () => {
    // This is the half that makes "pure" mean something stronger than "not the DOM": a logic module
    // that fetched would be untestable as a plain function, and would move a decision out of the one
    // place this package now keeps them.
    const breaches: string[] = [];
    for (const file of filesOf(PURE_DIRS)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const g of TRANSPORT_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(src)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches, 'a pure module reached for the network or storage').toEqual([]);
  });

  it('the transport layer uses only the three globals a REST client needs', () => {
    // The positive direction of the same rule: not a whitelist that quietly allows everything else,
    // but a check that what src/api/ actually reaches for is still exactly what test/api.test.ts
    // installs. A fourth global appearing here is a real change in what the layer depends on.
    const used = new Set<string>();
    for (const file of filesOf(TRANSPORT_DIRS)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const g of TRANSPORT_GLOBALS) if (new RegExp(`\\b${g}\\b`).test(src)) used.add(g);
    }
    expect([...used].sort()).toEqual(['Response', 'fetch', 'localStorage', 'location']);
  });

  // ── canaries: a scan that scans nothing prints the same "OK" as a scan that found nothing ──

  it('actually scanned every checked directory, and found imports to check', () => {
    for (const dir of CHECKED_DIRS) {
      expect(tsFilesIn(dir).length, `src/${dir}/ has no .ts files — moved, renamed, or the walk broke`).toBeGreaterThan(0);
    }
    expect(filesOf(PURE_DIRS).length, 'the pure layer is one module per page plus two shared ones').toBeGreaterThanOrEqual(20);
    expect(filesOf(TRANSPORT_DIRS).length).toBeGreaterThanOrEqual(2);
    // Without this, an importsOf() regex that matches nothing (the CRLF/multi-line class of bug)
    // would make both whitelist tests above pass vacuously on every file forever.
    const total = filesOf(CHECKED_DIRS).reduce((n, f) => n + importsOf(readFileSync(f, 'utf8')).length, 0);
    expect(total, 'importsOf() found zero imports across both layers — the regex is broken').toBeGreaterThan(20);
  });

  it('finds the multi-line imports that really exist in both checked directories', () => {
    // Stronger than the synthetic multi-line case below, and stronger than a total count: it names
    // the two files whose ONLY import is written across several lines, so a regex that cannot span
    // lines fails here even if it still matches plenty of single-line imports elsewhere.
    for (const file of ['logic/auctionAudit.ts', 'api/index.ts']) {
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src, `${file} no longer has a multi-line import — pick another example or drop this test`)
        .toMatch(/,\s*\n\}\s*from/);
      expect(importsOf(stripComments(src)), `multi-line import missed in ${file}`).toContain('../types');
    }
  });

  // Both scanners are regex-over-whole-file, and this repo checks out CRLF on Windows
  // (core.autocrlf=true) while CI checks out LF — exactly the setup where a source scanner works on
  // one and silently matches nothing on the other, since "found no breaches" and "scanned nothing"
  // print identically. `$` under /m does match before a bare CR (the spec's LineTerminator includes
  // it), so the current strip handles both; that is a property of the regex rather than something the
  // code states, so pin it instead of re-deriving it after the next edit. Deliberately does NOT
  // assert what the files on disk use — that would flip red depending on which OS ran the checkout.
  it('scans correctly under both LF and CRLF line endings', () => {
    const LF = String.fromCharCode(10);
    const CRLF = String.fromCharCode(13, 10);
    for (const [name, nl] of [['LF', LF], ['CRLF', CRLF]] as const) {
      const src = [
        '// a doc comment mentioning document and window and localStorage',
        "import { a } from './x';",
        '/* block comment naming HTMLInputElement */',
        'const b = 1;',
      ].join(nl) + nl;
      const stripped = stripComments(src);
      expect(stripped, `line comments not stripped under ${name}`).not.toMatch(/\bdocument\b/);
      expect(stripped, `block comments not stripped under ${name}`).not.toMatch(/HTMLInputElement/);
      expect(importsOf(src), `imports not found under ${name}`).toEqual(['./x']);

      const multi = ['import {', '  a,', '  b,', "} from '../types';"].join(nl) + nl;
      expect(importsOf(multi), `multi-line import missed under ${name}`).toEqual(['../types']);
    }
  });

  it('strips comments before matching, which both api/ files rely on', () => {
    // src/api/index.ts and src/api/transport.ts both explain, in prose, that callers still write
    // `from './api'` — an unstripped scan reads those as imports of a module outside src/api/ and
    // reports a breach that is not there.
    for (const file of filesOf(TRANSPORT_DIRS)) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripComments(raw);
      for (const spec of importsOf(stripped)) {
        expect(isAllowedSpecifier(spec, dirname(file), TRANSPORT_DIRS), `${spec} in ${relative(PKG, file)}`).toBe(true);
      }
      if (/from '\.\/api'/.test(raw)) expect(importsOf(stripped)).not.toContain('./api');
    }
  });

  // The load-bearing link between this file and the gate: if someone adds a third directory to
  // coverage.include, the coverage number keeps working but this guard would silently keep checking
  // only the old two. Deriving the expected set from the config makes that a failure — and because
  // this package has TWO tiers, the new directory has to be classified into one of them, not merely
  // listed.
  it('guards exactly the directory-level entries coverage.include names', () => {
    const cfg = readFileSync(join(PKG, 'vitest.config.ts'), 'utf8');
    // Anchor on the `coverage:` block first. There are TWO `include:` keys in this config and the
    // other one (test.include, `['test/**/*.test.ts']`) comes first in the file — matching it instead
    // yields zero directory entries, which reads exactly like "the include list has no directory
    // entries" rather than "you parsed the wrong list".
    const covAt = cfg.indexOf('coverage:');
    expect(covAt, 'no `coverage:` block in vitest.config.ts').toBeGreaterThan(-1);
    const arr = /include:\s*\[([^\]]*)\]/.exec(cfg.slice(covAt));
    expect(arr, "could not find coverage.include's array literal in vitest.config.ts").not.toBeNull();
    const entries = [...arr![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(entries.length, 'parsed zero include entries').toBeGreaterThan(0);
    // Confirms we read the coverage list and not some other `include:` — every coverage entry is a
    // src path, every test-include entry is a test path.
    for (const e of entries) expect(e.startsWith('src/'), `include entry ${e} is not under src/ — wrong include list?`).toBe(true);
    const dirEntries = entries
      .filter((e) => e.endsWith('/**'))
      .map((e) => e.replace(/^src\//, '').replace(/\/\*\*$/, ''));
    expect(dirEntries.sort()).toEqual([...CHECKED_DIRS].sort());
    // Every included directory must be in exactly one tier: a directory in both would be held to
    // whichever rule ran last, which is not a rule.
    expect(PURE_DIRS.filter((d) => TRANSPORT_DIRS.includes(d))).toEqual([]);
    // And the include list is directory-level only. `src/api.ts` used to be a whole-file entry
    // candidate; Phase 4e moved it into src/api/index.ts precisely so it would not have to be one,
    // and a file entry here would be a hole this guard cannot see into (you cannot add a file to a
    // file, but you also cannot classify one into a tier).
    expect(entries.filter((e) => !e.endsWith('/**')), 'coverage.include grew a per-file entry').toEqual([]);
  });
});
