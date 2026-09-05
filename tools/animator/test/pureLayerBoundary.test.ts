// Guards the PURITY of the four directory-level entries in vitest.config.ts's `coverage.include`
// (`src/core/**`, `src/skeleton/**`, `src/animation/**`, `src/io/**`) — animator's scoped layer,
// per ADR-070 Phase 4d.
//
// WHY THIS EXISTS, and why the coverage gate is not enough on its own. Graduating a package into
// the 90% gate with directory-level includes makes "someone added a file" visible to the COVERAGE
// ALGORITHM; it does not make it visible to the GATE, because the gate reads one percentage and
// that percentage has headroom: `covered/0.9 - total`. Phase 4a found this in map-editor (72 lines
// of slack; a 13-line PIXI+DOM probe dropped into its pure directory left coverage at 96.98% with
// the gate still green) and Phase 4b reproduced it in level-editor (49 lines). THIS package is the
// worst of the three by a wide margin: 1442 lines in scope means ~142 lines of slack at the
// coverage this suite reaches — enough to absorb a whole mid-sized PIXI panel without the gate
// making a sound. And the slack GROWS as the tests get better, which is the reverse incentive at
// the root of the problem. So the boundary gets assertions of its own; the coverage gate keeps
// doing its own job (this layer stays >=90% covered) and this file pins the other half.
//
// WHAT "PURE" MEANS HERE — and it is NOT what it means in map-editor or level-editor, so do not
// port their lists in. Two facts make animator different:
//
//   • It is the only tool that really depends on pixi.js (`src/rendering/Renderer.ts`,
//     `src/images/ImageController.ts`, `runtime/StickmanRuntime.ts`). So "no PIXI" is load-bearing
//     here in a way it is not in level-editor, which has no such dependency at all.
//   • `src/io/**` is the disk / IndexedDB / File-System-Access layer. It genuinely uses `document`,
//     `window`, `localStorage`, `indexedDB` and `showSaveFilePicker`, and always did. A flat "no
//     DOM globals" rule — level-editor's load-bearing assertion — would be false here on day one,
//     and a guard that has to be suppressed to pass is worth nothing.
//
// So the DOM rule is per-directory and DEFAULT-DENY, with each directory's allowance grepped off
// what it actually uses today (see DIR_GLOBALS). That is strictly stronger than one flat list: it
// keeps `core/` and `skeleton/` at zero browser surface, keeps `animation/` down to the two
// animation-frame calls its playback clock needs, and still stops `io/` from growing a UI surface
// even though it may touch the disk. On top of that sits FORBIDDEN_GLOBALS — the renderer/UI
// surface that must never appear in ANY of the four, so widening one directory's allowance can
// never quietly admit PIXI.
//
// Technique: read the real sources off disk rather than importing them, since the property under
// test belongs to the files, not to any runtime value.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** The pure directories. Derived from vitest.config.ts by the last test in this file rather than
 *  trusted as a literal — see that test for why it is the load-bearing link to the gate. */
const PURE_DIRS = ['animation', 'core', 'io', 'skeleton'];

/** Bare packages a pure module may import AT RUNTIME. `jszip` is the `.tao`/`.taoeditor` archive
 *  format itself — a pure data dependency with no DOM or PIXI of its own, and the io tests drive
 *  the real package rather than a mock. `pixi.js` is deliberately absent: that is the whole point. */
const ALLOWED_PACKAGES = ['jszip'];

/** Out-of-scope modules a pure module may reference with `import type` ONLY, normalised relative
 *  to src/. Exactly one entry, and it is structural rather than convenient: editorProject.ts /
 *  taoExport.ts / IOController.ts describe their host objects in terms of the real ImageController,
 *  and that class reaches into pixi.js for texture creation. The type is erased at build time, so
 *  no PIXI enters the bundle through this layer — which is precisely why it is allowed here and
 *  why a VALUE import of the same module is not (asserted separately below).
 *
 *  Note this is the opposite call from Phase 4a, which MOVED `TerrainTextureName` out of
 *  map-editor's renderer so its pure layer would not `import type` across the line. That was the
 *  right fix there: a colour/atlas-name type has no business living in a PIXI module. Here the
 *  out-of-scope thing being named IS a PIXI-owning class, so there is nothing to move — the host
 *  interface has to name it, and pinning the exception to one specific specifier is what keeps it
 *  from spreading. */
const TYPE_ONLY_ALLOW = ['images/ImageController'];

/** Browser globals each pure directory may use, default-deny, one list per directory. Grepped off
 *  what the sources use today (the scanner strips comments AND string bodies first, so a name
 *  mentioned in prose or in an event-name string is not counted):
 *
 *  • core, skeleton — nothing at all. Pure data + math; the FK solver and the rig definition are
 *    also what runtime/StickmanRuntime.ts and the client's own copy reuse.
 *  • animation — the two animation-frame calls AnimationController's playback clock schedules on.
 *    Nothing else: `sampleClip`/`clonePreset` are pure, and interpolate.ts's own header says so.
 *  • io — the disk / IndexedDB / File-System-Access surface. Long by nature; the point is that it
 *    is CLOSED. `document` is here for `getElementById` on the two file-input/anchor elements and
 *    `createElement('canvas')` in the export bake, not for building UI. */
const DIR_GLOBALS: Record<string, readonly string[]> = {
  core: [],
  skeleton: [],
  animation: ['requestAnimationFrame', 'cancelAnimationFrame'],
  io: [
    'window', 'document', 'localStorage', 'indexedDB', 'crypto', 'prompt',
    'setTimeout', 'clearTimeout',
    'Blob', 'File', 'Image', 'URL', 'DOMException',
    'HTMLCanvasElement', 'HTMLImageElement', 'HTMLInputElement', 'HTMLSelectElement',
    'CanvasImageSource', 'showOpenFilePicker', 'showSaveFilePicker',
  ],
};

/** The renderer/UI surface, forbidden in every pure directory regardless of DIR_GLOBALS. Derived
 *  by differencing what the impure half of src/ uses against what the pure half uses, so each name
 *  is one the editor really reaches for somewhere — just never in here. Keeping this alongside the
 *  per-directory allowances is deliberate: admitting PIXI (or a canvas context, or a mouse event)
 *  into the pure layer then takes two edits in two places, in a file that explains why not to. */
const FORBIDDEN_GLOBALS = [
  'PIXI',
  'CanvasRenderingContext2D', 'ResizeObserver', 'Node', 'confirm',
  'HTMLElement', 'HTMLDivElement', 'HTMLButtonElement',
  'MouseEvent', 'WheelEvent', 'KeyboardEvent',
  // Obvious neighbours of the above — not used anywhere in this tool today, listed so the first
  // appearance of one inside the pure layer is a failure rather than a precedent.
  'PointerEvent', 'DragEvent', 'TouchEvent', 'MutationObserver', 'IntersectionObserver',
  'getComputedStyle', 'matchMedia', 'OffscreenCanvas', 'Path2D',
];

/** Strip comments only. Import specifiers live in strings, so the import scanner needs them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Blank out comments AND the CONTENTS of every string / template literal, leaving code. Needed
 *  because this package's own event names are strings like `'history:change'` and `'preview:mode'`,
 *  and `\b`-anchored global matching over raw source reads those as uses of `history` and so on.
 *
 *  Hand-written character scanner rather than a `"…"|'…'|identifier` regex alternation on purpose:
 *  Phase 4b recorded that the naive alternation cascades out of alignment at the first escaped
 *  quote and reports hundreds of phantom hits. Quotes are replaced by empty pairs so the result is
 *  still syntactically recognisable, and every stripped character becomes a space so line/offset
 *  arithmetic stays usable. */
function codeOnly(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') { out.push(' '); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++; }
      out.push(' ', ' ');
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out.push(c);
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out.push(' ', ' '); i += 2; continue; }
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      out.push(c);
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** All `.ts` files under `src/<dir>`, recursively. Returns [] for a missing dir — the canary
 *  turns that into a failure, so every other test stays simple. */
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

interface Imported {
  spec: string;
  /** True when the whole statement is `import type …` — erased at build time. A per-specifier
   *  inline `type` (`import { x, type T } from …`) does NOT make the statement type-only, since
   *  the module is still pulled in at runtime for `x`. */
  typeOnly: boolean;
}

/** Every import in a file, tagged type-only or not. The `from` clause is always on one line even
 *  when the brace list is not, which is what makes a per-line scan safe here; the bare and dynamic
 *  forms are matched separately. */
function importsOf(src: string): Imported[] {
  const out: Imported[] = [];
  for (const m of src.matchAll(/\bimport\s+type\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[1]!, typeOnly: true });
  }
  const typeOnlySpecs = new Set(out.map((i) => i.spec));
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) {
      const spec = m[1]!;
      // A spec can appear in both a type-only and a value statement; record the value one too.
      const alreadyTypeOnly = typeOnlySpecs.has(spec) && !out.some((i) => i.spec === spec && !i.typeOnly);
      const isTypeStatement = alreadyTypeOnly && /\bimport\s+type\b[^;]*\bfrom\s*['"]/.test(
        src.slice(Math.max(0, m.index! - 400), m.index! + spec.length + 4),
      );
      if (!isTypeStatement) out.push({ spec, typeOnly: false });
    }
  }
  // De-duplicate: the type-only pass and the generic `from` pass can both see one statement.
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = `${i.typeOnly}:${i.spec}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `spec` as a path relative to src/, or null if it is a bare package specifier. */
function normalise(spec: string, fromFileDir: string): string | null {
  if (!spec.startsWith('.')) return null;
  return relative(SRC, resolve(fromFileDir, spec)).split(sep).join(posix.sep);
}

function insidePureDirs(rel: string): boolean {
  return PURE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

const PURE_FILES = PURE_DIRS.flatMap(tsFilesIn);

/** Files of a single pure directory, for the per-directory global check. */
function filesOfDir(dir: string): string[] {
  return tsFilesIn(dir);
}

describe('pure layer boundary (src/{animation,core,io,skeleton}/**)', () => {
  it('imports nothing outside the pure set at runtime', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { spec, typeOnly } of importsOf(src)) {
        if (typeOnly) continue;   // checked by the next test
        const rel = normalise(spec, dirname(file));
        if (rel === null) {
          if (!ALLOWED_PACKAGES.includes(spec)) breaches.push(`${relative(PKG, file)} imports package ${spec}`);
          continue;
        }
        if (!insidePureDirs(rel)) breaches.push(`${relative(PKG, file)} imports ${spec} (→ src/${rel})`);
      }
    }
    // The failure this is really watching for: `pixi.js`, or anything under src/rendering/,
    // src/ui/, src/interaction/, src/timeline/, src/images/ — the impure half.
    expect(breaches, 'a pure module took a runtime dependency outside the pure layer').toEqual([]);
  });

  it('type-only imports reach outside only for the one allowed module', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { spec, typeOnly } of importsOf(src)) {
        if (!typeOnly) continue;
        const rel = normalise(spec, dirname(file));
        if (rel === null) {
          if (!ALLOWED_PACKAGES.includes(spec)) breaches.push(`${relative(PKG, file)} type-imports package ${spec}`);
          continue;
        }
        if (insidePureDirs(rel) || TYPE_ONLY_ALLOW.includes(rel)) continue;
        breaches.push(`${relative(PKG, file)} type-imports ${spec} (→ src/${rel})`);
      }
    }
    expect(breaches, `type-only imports outside the pure layer are limited to: ${TYPE_ONLY_ALLOW.join(', ')}`).toEqual([]);
  });

  // The exception above buys exactly one thing — naming a type. Turning it into a value import
  // would put pixi.js in the bundle behind this layer, which is the outcome the whole split exists
  // to prevent, and it would still read as "we already allow that module".
  it('never VALUE-imports a module that is only allowed as a type', () => {
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { spec, typeOnly } of importsOf(src)) {
        if (typeOnly) continue;
        const rel = normalise(spec, dirname(file));
        if (rel !== null && TYPE_ONLY_ALLOW.includes(rel)) {
          breaches.push(`${relative(PKG, file)} value-imports ${spec}, which is type-only`);
        }
      }
    }
    expect(breaches).toEqual([]);
  });

  it.each(PURE_DIRS)('src/%s/ uses only the browser globals its own tier allows', (dir) => {
    const allowed = new Set(DIR_GLOBALS[dir] ?? []);
    const breaches: string[] = [];
    for (const file of filesOfDir(dir)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const g of [...new Set([...Object.values(DIR_GLOBALS).flat(), ...FORBIDDEN_GLOBALS])]) {
        if (allowed.has(g)) continue;
        if (new RegExp(`\\b${g}\\b`).test(code)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches, `src/${dir}/ may use only: ${[...allowed].join(', ') || '(no browser globals at all)'}`).toEqual([]);
  });

  it('no pure directory touches the renderer/UI surface, whatever its own tier allows', () => {
    // Independent of the per-directory check above so that widening a DIR_GLOBALS list can never
    // silently admit one of these. Two lists, two edits, one explanation.
    const breaches: string[] = [];
    for (const file of PURE_FILES) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const g of FORBIDDEN_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(code)) breaches.push(`${relative(PKG, file)} uses ${g}`);
      }
    }
    expect(breaches).toEqual([]);
  });

  // animator is the only tool with a build product outside src/: runtime/StickmanRuntime.ts, the
  // game-side player, which is also why it is the only package needing `--extra-root=runtime` in
  // tools/scripts/checkUnreachableModules.mjs. It reuses this layer directly (interpolate,
  // Skeleton, core/types), so "the pure layer stays PIXI-free" is not an abstraction preference
  // here — it is what lets a second product compile against it. Pin that the sibling only ever
  // reaches into the guarded layer, so a new reach-in cannot appear without a guard covering it.
  it('the runtime/ sibling product reaches only into the guarded layer', () => {
    const runtimeFile = join(PKG, 'runtime', 'StickmanRuntime.ts');
    const src = stripComments(readFileSync(runtimeFile, 'utf8'));
    const relatives = importsOf(src)
      .map((i) => i.spec)
      .filter((s) => s.startsWith('.'))
      .map((s) => relative(SRC, resolve(dirname(runtimeFile), s)).split(sep).join(posix.sep));

    expect(relatives.length, 'runtime/StickmanRuntime.ts imports nothing from src/ — did it move?').toBeGreaterThan(0);
    for (const rel of relatives) {
      expect(insidePureDirs(rel), `runtime/ reaches src/${rel}, which is outside the guarded layer`).toBe(true);
    }
  });

  // ── canaries: a scan that scans nothing prints the same "OK" as a scan that found nothing ──

  it('actually scanned every pure directory, and found imports to check', () => {
    for (const dir of PURE_DIRS) {
      expect(tsFilesIn(dir).length, `src/${dir}/ has no .ts files — moved, renamed, or the walk broke`).toBeGreaterThan(0);
    }
    expect(PURE_FILES.length).toBeGreaterThanOrEqual(10);

    // Without this, an importsOf() regex that matches nothing (the CRLF / multi-line class of bug)
    // would make the boundary tests above pass vacuously on every file forever.
    const all = PURE_FILES.flatMap((f) => importsOf(readFileSync(f, 'utf8')));
    expect(all.length, 'importsOf() found zero imports across the pure layer — the regex is broken').toBeGreaterThan(0);
    // Both arms of the type-only split must be exercised by the real tree, or the two import tests
    // above are each half-dead: one would be checking an empty set.
    expect(all.some((i) => i.typeOnly), 'no type-only imports seen — the typeOnly tagging is dead').toBe(true);
    expect(all.some((i) => !i.typeOnly), 'no value imports seen — the value-import test is vacuous').toBe(true);
    // And the one standing exception must still be a real import, not a stale entry in a list.
    const outward = all.filter((i) => {
      const rel = i.spec.startsWith('.') ? relative(SRC, resolve(SRC, 'io', i.spec)).split(sep).join(posix.sep) : null;
      return rel !== null && TYPE_ONLY_ALLOW.includes(rel);
    });
    expect(outward.length, `TYPE_ONLY_ALLOW lists ${TYPE_ONLY_ALLOW.join(', ')} but nothing imports it — drop the exception`).toBeGreaterThan(0);
  });

  it('the global scanner sees code and ignores comments and string contents', () => {
    // Both halves matter. Missing real code = a guard that never fires; counting strings/comments =
    // a guard that fires on this very file's own prose, which is how guards get deleted.
    expect(codeOnly("const a = 'PIXI.Sprite';")).not.toMatch(/\bPIXI\b/);
    expect(codeOnly('// mentions PIXI and document\nconst a = 1;')).not.toMatch(/\bPIXI\b/);
    expect(codeOnly('/* PIXI */ const a = 1;')).not.toMatch(/\bPIXI\b/);
    expect(codeOnly('const x = new PIXI.Container();')).toMatch(/\bPIXI\b/);
    // The escaped-quote cascade Phase 4b recorded: a naive alternation loses alignment here and
    // starts reporting code as string and vice versa.
    expect(codeOnly("const a = 'it\\'s ResizeObserver'; const b = new ResizeObserver(f);")).toMatch(/\bResizeObserver\b/);
    expect(codeOnly("const a = 'it\\'s ResizeObserver';")).not.toMatch(/\bResizeObserver\b/);
    // Template literals and their interpolations: the literal text is prose, the `${}` is code.
    expect(codeOnly('const a = `see document`;')).not.toMatch(/\bdocument\b/);
    // And the event-name strings that made this scanner necessary in the first place.
    expect(codeOnly("bus.emit('history:change', p);")).not.toMatch(/\bhistory\b/);
  });

  // Both scanners are regex/scan-over-whole-file, and this repo checks out CRLF on Windows
  // (core.autocrlf=true) while CI checks out LF — exactly the setup where a source scanner works
  // on one and silently matches nothing on the other, since "found no breaches" and "scanned
  // nothing" print identically. Deliberately does NOT assert what the files on disk use, which
  // would flip red depending on which OS ran the checkout.
  it('scans correctly under both LF and CRLF line endings', () => {
    const LF = String.fromCharCode(10);
    const CRLF = String.fromCharCode(13, 10);
    for (const [name, nl] of [['LF', LF], ['CRLF', CRLF]] as const) {
      const src = [
        '// a doc comment mentioning PIXI and ResizeObserver',
        "import type { ImageController } from '../images/ImageController';",
        "import JSZip from 'jszip';",
        '/* block comment naming CanvasRenderingContext2D */',
        'const b = 1;',
      ].join(nl) + nl;

      expect(codeOnly(src), `line comments not stripped under ${name}`).not.toMatch(/\bPIXI\b/);
      expect(codeOnly(src), `block comments not stripped under ${name}`).not.toMatch(/CanvasRenderingContext2D/);

      const imports = importsOf(stripComments(src));
      expect(imports, `imports not found under ${name}`).toEqual([
        { spec: '../images/ImageController', typeOnly: true },
        { spec: 'jszip', typeOnly: false },
      ]);

      // Multi-line import: the `from` clause lands on its own line. src/io/IOController.ts and
      // src/animation/AnimationController.ts both have real ones, and this shape is what broke an
      // earlier version of the reachability guard's import regex.
      const multi = ['import type {', '  AnimationClip,', '  Keyframe,', "} from '../core/types';"].join(nl) + nl;
      expect(importsOf(multi), `multi-line import missed under ${name}`).toEqual([
        { spec: '../core/types', typeOnly: true },
      ]);
    }
  });

  // The load-bearing link between this file and the gate: if someone adds a fifth directory to
  // coverage.include, the coverage number keeps working but this guard would silently keep
  // checking only the old four. Deriving the expected set from the config makes that a failure.
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
    // Every guarded directory needs a DOM tier of its own, or it would fall through to `?? []`
    // and be checked against an accidental "nothing allowed" rather than a decision.
    for (const dir of PURE_DIRS) {
      expect(DIR_GLOBALS, `src/${dir}/ has no DIR_GLOBALS entry`).toHaveProperty(dir);
    }
  });
});
