// Static guard against the TitlesScene leak (fixed in commit f8fa45bb).
//
// Background: TitlesScene called `input.onDown((x, y) => this.handleDown(x, y))`
// without storing the returned unsub function, and never called it in destroy().
// InputManager is long-lived across scene switches (owned by the app, not
// recreated per-scene) — a scene that forgets to unsubscribe leaves a permanently
// live handler bound to a destroyed scene, which then fires on later taps that
// happen to hit its stale hit-rects. Every OTHER scene follows the convention
// `this.unsubs.push(input.onDown(...))` + `this.unsubs.forEach(u => u())` in
// destroy(). This test statically scans all client source files and fails if
// any onDown/onMove/onUp subscription is NOT wrapped in an `unsubs.push(...)`
// call, so the same class of bug can't reappear in a new or edited scene.

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

const SUBSCRIBE_RE = /\.(onDown|onMove|onUp)\(/;
const WRAPPED_RE = /unsubs\.push\(\s*[\w.]*\.(onDown|onMove|onUp)\(/;

describe('InputManager subscription cleanup convention', () => {
  it('every onDown/onMove/onUp subscription in client/src is wrapped in unsubs.push(...)', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!SUBSCRIBE_RE.test(line)) return;
        if (WRAPPED_RE.test(line)) return;
        offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
