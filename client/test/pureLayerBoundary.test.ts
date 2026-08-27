// Guards the boundary of the client's PURE layers — the directories `vitest.config.ts` gates wholesale
// (ADR-071 4b, 2026-08-27). The client half of what map-editor / level-editor / vfx-editor already have.
//
// **Why the 90% percentage cannot do this job.** The gate's headroom is `covered / 0.9 - total`: with a
// directory at, say, 97%, dozens of uncovered lines can be added before the number crosses the bar — and
// the headroom GROWS as the tests in it improve. So a DOM/PIXI file dropped into a gated pure directory
// lands inside the include glob, adds untested lines, and the gate stays green. Measured on the sibling
// tools when they graduated: map-editor had 13 lines of slack, level-editor 10. That is the whole reason
// every graduating package needs a copy of this file rather than trusting its percentage.
//
// What "pure" means here, operationally, has TWO halves, and the second was missing until 2026-08-27:
// **(a) no runtime import may reach a module that touches a global, and (b) the file may not touch one
// itself.** (a) alone is a hole you can drive through — a module needs no imports at all to call
// `document.createElement`, and the motivating example was real: `SectScene/input.ts` builds hidden DOM
// `<input>` overlays and imports nothing but `@nw/shared` plus a type, so the import-graph check alone
// called it pure. It is not, and dropping it into a gated directory would have made this guard a lie in
// exactly the way it exists to prevent. See the browser-globals case below.
// Type-only imports are exempt — they are erased before the bundle exists, so a `import type { Foo } from
// '../pixiThing'` costs nothing and is genuinely common in these files. The check therefore parses import
// forms rather than grepping for the word "pixi": a `import type` of pixi is fine, a bare `import * as
// PIXI` is not, and neither can be told apart by substring.
//
// Deliberately shallow-but-transitive: it walks the relative import graph from each gated pure directory,
// so re-exporting a PIXI module through an innocuous-looking barrel does not get past it. Non-relative
// specifiers are judged by an allow-list of packages known to be environment-free (`@nw/shared`, `@nw/engine`)
// — anything else non-relative fails and has to be classified here, which is the point: adding a dependency
// to a pure layer should require saying so out loud.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../vitest.config';

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The gated pure directories. One entry per scene group as 4b works through them
 * (worldmap > CardScene > Friends/Family/Sect > ui/dialogs); each must also appear as a directory glob
 * in vitest.config.ts's `coverage.include`, which the final case below checks.
 */
const PURE_DIRS = ['src/scenes/worldmap/logic', 'src/scenes/CardScene/logic'] as const;

/** Non-relative specifiers a pure module may import: environment-free by construction. */
const ALLOWED_PACKAGES = new Set([
  '@nw/shared',
  '@nw/shared/cards',
  '@nw/engine',
  // Added with CardScene/logic (2026-08-27): its two logic modules reach `game/meta/cardDefs`, whose
  // own imports include this one. It is the engine's numeric config table (UNIT_BLUEPRINTS, tuning
  // constants) — plain data, no global, same standing as '@nw/engine' itself, which is already here.
  '@nw/engine/config',
]);

/**
 * Runtime globals whose presence means the file needs a browser (or WeChat) to run — the (b) half of
 * "pure" above. Deliberately NOT a list of everything ambient: `setTimeout`, `performance` and
 * `console` all exist in node too, so a pure module using them still loads and still tests, and
 * banning them would buy noise instead of safety. `Math.random`/`Date.now` are nondeterminism rather
 * than environment dependence — a different problem, handled per-test where it matters (see
 * worldmapZoom.test.ts). What is listed is what makes a module unloadable or untestable off a page.
 */
const BROWSER_GLOBALS = [
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Image', 'Audio', 'alert', 'wx',
] as const;

/**
 * Source with comments and string/template literals blanked out, so a global's NAME appearing in prose
 * ("...the document is torn down...") or in a message string does not fail the check. Blanks rather
 * than deletes, to keep byte offsets — and therefore reported line numbers — honest.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src.slice(i, i + 2);
    if (c2 === '//') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c2 === '/*') {
      while (i < n && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** Every .ts file under `dir`, recursively, repo-relative with forward slashes. */
function walk(dir: string): string[] {
  const abs = join(CLIENT_ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

interface Imp {
  spec: string;
  typeOnly: boolean;
}

/**
 * The module's import specifiers, each flagged type-only. Regex rather than a real parser on purpose:
 * these files are hand-written ES modules with one import per line, and a parser dependency for a guard
 * is a worse trade than a check that would over-report on exotic syntax (over-reporting fails loudly and
 * gets fixed; under-reporting is the failure mode that matters).
 */
function importsOf(relPath: string): Imp[] {
  const src = readFileSync(join(CLIENT_ROOT, relPath), 'utf8');
  const out: Imp[] = [];
  // `import ... from 'x'` / `export ... from 'x'` / bare `import 'x'`
  const re = /(?:^|\n)\s*(import|export)(\s+type)?\b([^'"\n;]*?)\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const bareSpec = m[5];
    if (bareSpec) { out.push({ spec: bareSpec, typeOnly: false }); continue; }
    const spec = m[4]!;
    // `import type { A } from` — whole clause is types. Also treat a clause whose every named binding
    // carries an inline `type` marker as type-only (`import { type A, type B } from`).
    const clause = m[3] ?? '';
    const wholeClauseType = !!m[2];
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    const allNamedAreType = !!named && named.split(',').filter((x) => x.trim()).every((x) => /^\s*type\s+/.test(x));
    out.push({ spec, typeOnly: wholeClauseType || allNamedAreType });
  }
  return out;
}

/** Resolve a relative specifier against the importing file, to a repo-relative .ts path (or null). */
function resolveRelative(fromRel: string, spec: string): string | null {
  const base = resolve(join(CLIENT_ROOT, dirname(fromRel)), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(CLIENT_ROOT, cand).split('\\').join('/');
  }
  return null;
}

describe('pure-layer boundary', () => {
  it('finds the pure directories at all (canary: a rename must not empty this suite)', () => {
    // Without this, moving `logic/` elsewhere makes every check below pass over zero files and the guard
    // retires itself silently — the exact shape checkFileLength/checkWorkspaceCoverage's canaries exist for.
    expect(PURE_DIRS.length).toBeGreaterThan(0);
    for (const dir of PURE_DIRS) {
      expect(existsSync(join(CLIENT_ROOT, dir)), dir).toBe(true);
      expect(walk(dir).length, `${dir} file count`).toBeGreaterThan(2);
    }
  });

  it('no pure module has a RUNTIME import that reaches a global-touching module', () => {
    const offences: string[] = [];
    for (const dir of PURE_DIRS) {
      for (const entry of walk(dir)) {
        // Breadth-first over runtime edges only, starting at the gated file.
        const seen = new Set<string>([entry]);
        const queue: Array<{ file: string; via: string[] }> = [{ file: entry, via: [] }];
        while (queue.length > 0) {
          const { file, via } = queue.shift()!;
          for (const imp of importsOf(file)) {
            if (imp.typeOnly) continue;                       // erased at build time — costs nothing
            if (!imp.spec.startsWith('.')) {
              if (!ALLOWED_PACKAGES.has(imp.spec)) {
                offences.push(`${entry}: runtime import of package "${imp.spec}"${via.length ? ` (via ${via.join(' -> ')})` : ''}`);
              }
              continue;
            }
            const target = resolveRelative(file, imp.spec);
            if (!target) {
              offences.push(`${entry}: unresolvable relative import "${imp.spec}" from ${file}`);
              continue;
            }
            if (seen.has(target)) continue;
            seen.add(target);
            queue.push({ file: target, via: [...via, target] });
          }
        }
      }
    }
    expect(
      offences,
      'a gated pure directory must stay pure — the 90% bar has headroom and cannot catch this:\n  ' + offences.join('\n  '),
    ).toEqual([]);
  });

  it('no pure module touches a browser/WeChat global DIRECTLY (the half the import graph cannot see)', () => {
    // The check above walks imports, and a file needs no import at all to reach `document`. Verified
    // by mutation when this was added: appending `export const probe = () => document.title;` to a
    // gated file passed every other case in this file and failed only this one.
    const offences: string[] = [];
    for (const dir of PURE_DIRS) {
      for (const file of walk(dir)) {
        const code = stripCommentsAndStrings(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
        for (const g of BROWSER_GLOBALS) {
          // Two exclusions, both marking a PROPERTY position rather than a global read:
          //  * a leading dot — `core.window`, `opts.location` is somebody else's field;
          //  * a trailing colon — `{ location: string }` in a type, or an object-literal KEY.
          //    `location`/`history`/`document` are ordinary field names, so without this the guard
          //    fires on a plain interface. A real read never has a colon after it (`document.title`,
          //    `typeof window`, `{ window }` shorthand — all still caught, mutation-verified).
          // Residual over-reporting, accepted deliberately per this file's header: destructuring a
          // field that shares a global's name (`const { location } = props`) still fires. If that ever
          // bites, rename the local — the alternative is a parser dependency, and under-reporting is
          // the failure mode that actually costs something here.
          const re = new RegExp(`(^|[^.\\w$])${g}(?![\\w$])(?!\\s*:)`, 'm');
          const m = re.exec(code);
          if (!m) continue;
          const line = code.slice(0, m.index).split('\n').length;
          offences.push(`${file}:${line} touches the global \`${g}\``);
        }
      }
    }
    expect(
      offences,
      'a gated pure directory must not need a browser to run:\n  ' + offences.join('\n  '),
    ).toEqual([]);
  });

  it('type-only imports of PIXI-bearing modules are allowed, and actually present', () => {
    // Not a formality: if this ever finds none, the check above has stopped distinguishing `import type`
    // from `import`, and would then be passing for the wrong reason.
    const typeOnlyEdges = PURE_DIRS.flatMap((dir) =>
      walk(dir).flatMap((f) => importsOf(f).filter((i) => i.typeOnly).map((i) => `${f} -> ${i.spec}`)),
    );
    expect(typeOnlyEdges.length).toBeGreaterThan(0);
  });

  it('every pure directory is gated as a DIRECTORY glob, not file by file', () => {
    // The point of 4b: a directory entry also covers whatever lands in it next, where a per-file list
    // silently omits it. Reads the real config so there is no second copy of the list to drift.
    const include = (config as { test?: { coverage?: { include?: string[] } } }).test?.coverage?.include ?? [];
    for (const dir of PURE_DIRS) {
      expect(include, `${dir} must be gated as a directory`).toContain(`${dir}/**`);
      // ...and no leftover per-file entry for anything inside it.
      const strays = include.filter((e) => e.startsWith(`${dir}/`) && e !== `${dir}/**`);
      expect(strays, `${dir} still has per-file entries`).toEqual([]);
    }
  });
});
