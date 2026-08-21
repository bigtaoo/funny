// Guards vitest.config.ts's `coverage.include` list against rot (2026-08-21).
//
// Why this needs a guard at all: the list is what defines the client's 90%-gated scope, and every
// way it can break is SILENT. A renamed or deleted file leaves a stale entry that matches nothing,
// and v8 coverage simply reports one fewer file — the percentage stays green (usually goes UP, since
// the entries are the well-covered modules), so the scope shrinks without a single red step
// anywhere. That is the same failure shape as scripts/checkFileLength.mjs' and
// checkCoverageThreshold.mjs' canaries: a gate that retires itself by turning green.
//
// It reads the real config module rather than a copy of the list, so there is nothing to keep in
// sync here.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../vitest.config';

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const include = ((config as { test?: { coverage?: { include?: string[] } } }).test?.coverage
  ?.include ?? []) as string[];

/** Recursively: does this directory hold at least one non-test .ts/.tsx file? */
function hasSourceFile(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasSourceFile(abs)) return true;
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

describe('vitest.config.ts coverage.include', () => {
  // The canary: every assertion below iterates `include`, so an emptied (or renamed) list would
  // make this whole file pass while gating nothing.
  it('canary: is a non-trivial list', () => {
    expect(include.length).toBeGreaterThan(10);
    expect(include).toContain('src/game/**');
  });

  it.each(include)('%s matches something that exists on disk', (entry) => {
    if (entry.endsWith('/**')) {
      const dir = join(CLIENT_ROOT, entry.slice(0, -'/**'.length));
      expect(existsSync(dir), `${entry}: directory is gone`).toBe(true);
      expect(statSync(dir).isDirectory(), `${entry}: not a directory`).toBe(true);
      expect(hasSourceFile(dir), `${entry}: directory holds no source file`).toBe(true);
    } else {
      expect(existsSync(join(CLIENT_ROOT, entry)), `${entry}: file is gone (renamed? deleted? ` +
        `update vitest.config.ts — a stale entry silently shrinks the gated scope)`).toBe(true);
    }
  });

  /**
   * The per-file entries are transitional: ADR-070's client half replaces batches of them with one
   * directory entry as each scene's pure logic gets extracted (see the config's own comment). When
   * that happens the file entries it supersedes must GO, not linger underneath the new directory —
   * otherwise the list keeps growing and stops being readable as the remaining to-do.
   */
  it('has no entry already covered by another (a superseded leftover)', () => {
    const dirs = include.filter((e) => e.endsWith('/**')).map((e) => e.slice(0, -'/**'.length));
    const redundant = include.filter(
      (e) => !e.endsWith('/**') && dirs.some((d) => e.startsWith(`${d}/`)),
    );
    expect(redundant, 'these entries are already inside a directory entry above').toEqual([]);
  });
});
