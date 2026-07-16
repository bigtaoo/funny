// Static guard against a temp debug hook shipping to production.
//
// Background: verifying a scene's render output without driving the full login →
// lobby → nav chain sometimes uses a throwaway `(globalThis as any).__NW_DEBUG = {...}`
// hook dropped into app.ts right after the PIXI.Application is built (see
// SOCIAL_DESIGN.md's "创建帮会表单改版"/"noSect 页显示建门花费" entries and the
// equipment-header-title-and-loadout-rail-fix memory) so the Browser pane can
// `new SomeScene(...)` directly from javascript_tool. The hook is meant to be removed
// before the change is considered done — this test statically scans client/src so a
// forgotten hook fails CI instead of silently shipping a global debug surface.
//
// Runs under plain vitest (no PIXI needed) — just a source-text scan.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Matches the throwaway hook pattern itself (`__NW_DEBUG` on `globalThis`/`window`) and its
// accompanying "TEMP DEBUG" marker comment — either one left behind is a sign of the same mistake.
const DEBUG_HOOK_RE = /__NW_DEBUG\b|TEMP\s+DEBUG\s+HOOK/i;

describe('no temp debug hooks left in client/src', () => {
  it('no file defines or references a __NW_DEBUG global / "TEMP DEBUG HOOK" marker', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (DEBUG_HOOK_RE.test(line)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
