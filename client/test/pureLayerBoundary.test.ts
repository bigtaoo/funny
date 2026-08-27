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
// What "pure" means here, operationally: **no runtime import may reach a module that touches a global.**
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
const PURE_DIRS = ['src/scenes/worldmap/logic'] as const;

/** Non-relative specifiers a pure module may import: environment-free by construction. */
const ALLOWED_PACKAGES = new Set(['@nw/shared', '@nw/shared/cards', '@nw/engine']);

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
