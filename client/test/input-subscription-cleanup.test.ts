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

// 2026-08-03: onWheel was added to the codebase (PC mouse-wheel scroll, see wheelScroll.ts)
// well after this test was written, and never got added here — every onWheel subscription was
// completely unscanned by this file. Currently all of them happen to be wrapped correctly, but
// that was luck, not enforcement; a future onWheel call that forgets unsubs.push would sail
// through this test. Folded in alongside onDown/onMove/onUp so it can't silently drift again.
//
// 2026-08-25: the array holding the unsubs no longer has to be named exactly `unsubs`. CardScene now
// splits its subscriptions in two (ADR-072) — `inputUnsubs` for the pointer streams, which pause()
// detaches while an overlay covers the scene, and `unsubs` for the save subscription, which must
// survive that span — so the name is matched with a `[\w.]*[Uu]nsubs` prefix instead of literally.
// The convention being enforced is "the unsub is stored and drained", not one particular identifier.
const SUBSCRIBE_RE = /\.(onDown|onMove|onUp|onWheel)\(/;
const WRAPPED_RE = /[\w.]*[Uu]nsubs\.push\(\s*[\w.]*\.(onDown|onMove|onUp|onWheel)\(/;

// 2026-08-03: a file could satisfy WRAPPED_RE (the subscribe call is pushed into `unsubs`) and
// still leak if its destroy() never actually iterates that array — the audit that added this
// check found no live instance of that, but the original test had no way to catch one either.
// Matches both conventions used across the codebase: `unsubs.forEach(u => u())` and
// `for (const u of ...unsubs) u()` (the latter sometimes via a nested path like `this.ctx.unsubs`
// or `ctx.unsubs`, see WorldMapScene.ts).
const DRAIN_RE = /[\w.]*[Uu]nsubs\.forEach\(|for\s*\(\s*const\s+\w+\s+of\s+[\w.]*[Uu]nsubs\s*\)/;

describe('InputManager subscription cleanup convention', () => {
  it('every onDown/onMove/onUp/onWheel subscription in client/src is wrapped in unsubs.push(...)', () => {
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

  it('every file with a wrapped subscription also drains unsubs somewhere (destroy() etc.)', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      const hasWrappedSubscribe = text
        .split('\n')
        .some((line) => SUBSCRIBE_RE.test(line) && WRAPPED_RE.test(line));
      if (!hasWrappedSubscribe) continue;
      if (DRAIN_RE.test(text)) continue;
      offenders.push(path.relative(SRC_ROOT, file));
    }

    expect(offenders).toEqual([]);
  });
});
