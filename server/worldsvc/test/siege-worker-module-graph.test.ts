// Static gate for the siege worker thread's module graph.
//
// siegeWorker.ts runs under tsx inside a `worker_threads` realm, where extensionless relative specifiers do
// not resolve on Linux (2026-08-14 investigation, recorded in siegeWorker.ts and siegeWorkerPool.ts). They
// DO resolve on Windows, which is this project's dev machine — so a violation passes every local run and
// blows up only on CI, as a "siege worker crashed mid-battle: Cannot find module …" with no obvious link to
// the import that caused it.
//
// That has now happened twice. The first time it was siegeWorker.ts's own static import of siegeEngine; the
// second (2026-08-24) was siegeEngine.ts re-exporting the post-battle card-army settlement it had just been
// split into — a one-line re-export that added this module graph's first load-time relative import.
//
// So the rule is pinned here rather than left to CI: walk the worker's graph from its entry, and require
// every relative specifier resolved at load time to spell out its extension. Runs on every machine, in
// milliseconds, with no worker spawned.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');
const ENTRY = 'siegeWorker.ts';

/** Strip comments so prose about imports (these files carry plenty) can't match as code. */
function stripNoise(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

interface Spec {
  /** The specifier as written, e.g. `./cardStateSettlement`, or a template literal ending in an extension hole. */
  raw: string;
  /**
   * True only for specifiers resolved while the module is LOADING — a static `import`/`export … from` with at
   * least one value binding. Those are what crash the worker at boot, and what this gate is for.
   *
   * `import type` / `export type` are erased by the compiler and never resolved at all, which is why
   * siegeEngine.ts's `import type { ArmyEntry } from './db'` was never a problem. A dynamic import inside a
   * function body is deferred, so it is not part of the boot graph either — it is also the escape hatch
   * siegeWorker.ts itself uses. Known limit, stated rather than papered over: a lazy dynamic import on a code
   * path the worker actually reaches would still break at runtime and this gate would not see it.
   */
  eager: boolean;
}

function relativeSpecifiers(src: string): Spec[] {
  const out: Spec[] = [];
  const clean = stripNoise(src);
  // The binding list may contain neither a quote nor a `;`, so a match cannot run across statement
  // boundaries and pair one statement's `import` with a later one's `from './x'` — which the first cut of
  // this file silently did, reporting `import type … from './db'` as a value import because the match had
  // started three statements earlier.
  const STATIC = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\bfrom\s*['"`](\.[^'"`]*)['"`]/g;
  const SIDE_EFFECT = /\bimport\s+['"`](\.[^'"`]*)['"`]/g;
  const DEFERRED = /\bimport\s*\(\s*['"`](\.[^'"`]*)['"`]\s*\)/g;
  for (const m of clean.matchAll(STATIC)) {
    const [, , typeKw = '', bindings = '', raw = ''] = m;
    // `import { type A, type B } from …` is erased too, but only if EVERY binding is type-only.
    const names = bindings.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTypeOnly = names.length > 0 && names.every((n) => /^type\s/.test(n));
    out.push({ raw, eager: !typeKw && !allTypeOnly });
  }
  for (const m of clean.matchAll(SIDE_EFFECT)) out.push({ raw: m[1]!, eager: true });
  // Deferred, or a `typeof import(…)` type position; either way not loaded with the module.
  for (const m of clean.matchAll(DEFERRED)) out.push({ raw: m[1]!, eager: false });
  return out;
}

/** A template hole counts as explicit: siegeWorker.ts spells the extension out, it just computes which one. */
function hasExplicitExtension(raw: string): boolean {
  return /\.(ts|js|mjs|cjs)$/.test(raw) || /\$\{[^}]*\}$/.test(raw);
}

function resolveToFile(fromFile: string, raw: string): string | null {
  const base = path.resolve(path.dirname(path.join(SRC, fromFile)), raw.replace(/\$\{[^}]*\}$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return path.relative(SRC, candidate).split(path.sep).join('/');
  }
  return null;
}

/** Every file the worker loads at boot, and the load-time relative specifiers that would break there. */
function walk(): { violations: string[]; visited: string[] } {
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of relativeSpecifiers(fs.readFileSync(path.join(SRC, file), 'utf8'))) {
      if (spec.eager && !hasExplicitExtension(spec.raw)) {
        violations.push(`${file} -> '${spec.raw}' (extensionless relative import, resolved at load time)`);
        continue;
      }
      // The entry's own hop into siegeEngine is a deferred import on purpose (a static one is exactly what
      // broke in 2026-08-14), so follow it; every other deferred import stops the walk rather than dragging
      // in files the worker never loads — siegeEngine.ts's lazy import of siegeWorkerPool among them.
      if (!spec.eager && file !== ENTRY) continue;
      const target = resolveToFile(file, spec.raw);
      if (target) queue.push(target);
    }
  }
  return { violations, visited: [...visited] };
}

describe('siege worker module graph', () => {
  it('loads only files whose relative imports spell out an extension (tsx worker realm, Linux)', () => {
    expect(walk().violations).toEqual([]);
  });

  it('reaches siegeEngine.ts — i.e. the walk is looking at the graph it claims to', () => {
    // Without this the gate silently passes the day someone renames the entry or changes the deferred-import
    // shape, because an empty graph has no violations either.
    expect(walk().visited).toContain('siegeEngine.ts');
  });

  it('flags a load-time relative import, and exempts the erased and deferred forms', () => {
    // Mutation check on the matcher itself, so "no violations" means the rule is live rather than broken.
    expect(relativeSpecifiers("import { a } from './x';")).toEqual([{ raw: './x', eager: true }]);
    expect(relativeSpecifiers("import type { A } from './x';")).toEqual([{ raw: './x', eager: false }]);
    expect(relativeSpecifiers("import { type A, type B } from './x';")).toEqual([{ raw: './x', eager: false }]);
    expect(relativeSpecifiers("import { type A, b } from './x';")).toEqual([{ raw: './x', eager: true }]);
    expect(relativeSpecifiers("export { a } from './x';")).toEqual([{ raw: './x', eager: true }]);
    expect(relativeSpecifiers("export type { A } from './x';")).toEqual([{ raw: './x', eager: false }]);
    expect(relativeSpecifiers("await import('./x');")).toEqual([{ raw: './x', eager: false }]);
    // The exact 2026-08-24 regression: a value re-export sitting below unrelated non-relative imports.
    const regression = "import { a } from '@nw/engine';\nimport type { B } from './db';\nexport { c } from './y';";
    expect(relativeSpecifiers(regression)).toEqual([
      { raw: './db', eager: false },
      { raw: './y', eager: true },
    ]);
    expect(hasExplicitExtension('./siegeEngine')).toBe(false);
    expect(hasExplicitExtension('./siegeEngine.ts')).toBe(true);
    expect(hasExplicitExtension('./siegeEngine${ext}')).toBe(true);
  });
});
