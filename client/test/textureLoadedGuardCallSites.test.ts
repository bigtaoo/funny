// Static guard for the texture-'loaded' half of 菜单场景生命周期契约 (claudedocs/client-modules.md).
//
// Background: a `baseTexture.once('loaded', cb)` callback fires from a PIXI Runner inside the
// ticker. If it throws — which it does the moment it touches a Sprite/Container belonging to a
// scene that was destroyed while the texture was still decoding — PIXI7's `Ticker._tick` aborts
// the update loop and stops re-requesting frames, i.e. the canvas freezes permanently and only a
// page reload recovers. This has now bitten three times (2026-07-07, 2026-08-03, 2026-08-15), and
// each time the fix was the same one line, so this test enforces the shape instead of the instance.
//
// Sibling of input-subscription-cleanup.test.ts, same philosophy: scan the real sources, allow
// only shapes that are known-safe, and force anything new to be reviewed rather than assumed.
//
// Deliberately matches `.once('loaded'` and NOT `baseTexture.once('loaded'`: IntroScene and
// IllustratedInterludeScene hold the base texture in a local (`base.once('loaded', ...)`) so
// destroy() can `base.off(...)` it, and the narrower pattern — the one an audit would reach for
// first — silently skips exactly the two call sites that caused the 2026-08-15 freeze.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Split on /\r?\n/, never '\n': this checkout is CRLF, and JS's `.` does not match `\r`, so a
// trailing CR left on the line makes the `$` anchor below fail on every single line — the scan
// reads as "no call sites anywhere" and the offender assertions pass vacuously. The
// call-site-count assertion in the first test exists to catch exactly that failure mode.
const LOADED_HOOK_RE = /\.once\(\s*'loaded'\s*,\s*(.*)$/;

/** A callback that only settles a Promise touches no display object, so it cannot throw into the ticker. */
const PROMISE_BRIDGE_RE = /^(resolve\b|\(\)\s*=>\s*resolve\()/;
/** `if (!core.destroyed) …` / `if (this.dead) return;` — an actual guard, not merely the word
 *  "destroyed" appearing somewhere (a comment or an unrelated `.destroyed` read must not count). */
const GUARD_STMT_RE = /if\s*\(\s*!?\s*[\w.]*\b(destroyed|dead)\s*\)/;
/** `() => core.render()` / `() => this.render()` — leans on that render()'s own first-line guard,
 *  which the second test below pins down so this delegation stays trustworthy. */
const DELEGATES_TO_RENDER_RE = /^\(\)\s*=>\s*(this|core)\.render\(\)/;

/**
 * Call sites whose callback is a named function this scanner can't follow, each reviewed by hand.
 * Keyed by source path; the value says where the guard actually lives. Adding a row means you
 * checked — not that the scanner gave up.
 */
const REVIEWED_NAMED_CALLBACKS: Record<string, string> = {
  'scenes/IntroScene.ts':
    'fitIllustration() opens with `if (this.destroyed) return`, and destroy() also base.off()s it via unsubs.',
  'scenes/IllustratedInterludeScene.ts':
    'fitIllustration() opens with `if (this.destroyed) return`, and destroy() also base.off()s it via unsubs.',
  'scenes/CardScene/feedList.ts':
    'onArtLoaded is `() => core.feedRedraw?.()`, i.e. drawFusePanel, which opens with `if (core.destroyed) return`.',
  'scenes/CardScene/feedRing.ts':
    'onArtLoaded is `() => core.feedRedraw?.()` from feed.ts, i.e. drawFusePanel, which opens with `if (core.destroyed) return` — needed separately from CardScene.render() because it is also stored as core.feedRedraw, which destroy() never nulls.',
  'scenes/CardScene/feedGap.ts':
    'Same as feedRing.ts: the recommendation strip is drawn with the same `() => core.feedRedraw?.()` from feed.ts.',
  'scenes/CardCodexScene/tile.ts':
    'onArtLoaded is `() => this.render()` from CardCodexScene.ts, whose render() opens with `if (this.destroyed) return`.',
  'render/cardArt.ts':
    'buildFittedSprite\'s fit() opens with `if (sprite.destroyed) return`, and the sprite\'s own `once(\'destroyed\')` base.off()s the hook — the same two halves IntroScene has, minus a scene to hang the unsub on.',
  'render/stickman/assetLoader.ts':
    'Bare `resolve` — settles a Promise, touches no display object.',
  'render/HandView/cellDraw.ts':
    'Writes plain fields only (lastSyncKey via ctx.invalidateSync, slotContentKey.fill) — no display object touched, so it cannot throw.',
};

type CallSite = { rel: string; line: number; text: string; callback: string; body: string };

/** How many lines past the hook to treat as the callback body — enough for the `() => {` form to
 *  show its guard on the next line or two, short enough not to swallow the surrounding function. */
const CALLBACK_BODY_LINES = 4;

function collectCallSites(): CallSite[] {
  const out: CallSite[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = LOADED_HOOK_RE.exec(line);
      if (!m) return;
      const callback = m[1]!.trim();
      out.push({
        rel: path.relative(SRC_ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        text: line.trim(),
        callback,
        // A block callback (`() => {`) puts its guard on the following lines, so the single-line
        // `callback` is not enough to judge it by.
        body: [callback, ...lines.slice(i + 1, i + 1 + CALLBACK_BODY_LINES)].join('\n'),
      });
    });
  }
  return out;
}

describe("texture 'loaded' callbacks cannot throw into Ticker.shared", () => {
  it('scans a plausible number of call sites (guards against the regex silently matching nothing)', () => {
    expect(collectCallSites().length).toBeGreaterThan(15);
  });

  it('every .once(\'loaded\') callback is promise-only, inline-guarded, delegated to a guarded render(), or hand-reviewed', () => {
    const offenders = collectCallSites()
      .filter((site) => {
        if (PROMISE_BRIDGE_RE.test(site.callback)) return false;
        if (GUARD_STMT_RE.test(site.body)) return false;
        if (DELEGATES_TO_RENDER_RE.test(site.callback)) return false;
        return REVIEWED_NAMED_CALLBACKS[site.rel] === undefined;
      })
      .map((site) => `${site.rel}:${site.line}: ${site.text}`);

    expect(offenders).toEqual([]);
  });

  it('the render() every delegating callback leans on really does guard on its first lines', () => {
    // `scenes/ShopScene/card.ts` -> `scenes/ShopScene.ts`: the repo-wide split where a scene
    // directory's `core.render` is the outer assembly's private render(). Same-file `this.render()`
    // (TitlesScene) resolves to the file itself.
    const outerSceneFileFor = (rel: string): string => {
      const m = /^scenes\/([A-Za-z]+Scene)\//.exec(rel);
      return m ? `scenes/${m[1]}.ts` : rel;
    };

    const offenders: string[] = [];
    const delegating = collectCallSites().filter((s) => DELEGATES_TO_RENDER_RE.test(s.callback));
    expect(delegating.length).toBeGreaterThan(5); // sanity: this class must not be empty

    for (const site of delegating) {
      const outerRel = outerSceneFileFor(site.rel);
      const outerAbs = path.join(SRC_ROOT, outerRel);
      if (!fs.existsSync(outerAbs)) {
        offenders.push(`${site.rel}:${site.line}: no outer scene file at ${outerRel}`);
        continue;
      }
      const lines = fs.readFileSync(outerAbs, 'utf8').split(/\r?\n/);
      const defIdx = lines.findIndex((l) => /\brender\(\): void \{/.test(l));
      if (defIdx < 0) {
        offenders.push(`${site.rel}:${site.line}: no render(): void definition in ${outerRel}`);
        continue;
      }
      // The guard is the first statement, but `const core = this.core;` and a comment block
      // routinely precede it — scan a small window rather than the single next line.
      const window = lines.slice(defIdx + 1, defIdx + 8).join('\n');
      if (!/if\s*\(\s*!?\s*(this|core)\.(destroyed|dead)\s*\)\s*return/.test(window)) {
        offenders.push(`${site.rel}:${site.line} delegates to ${outerRel}'s render(), which has no destroyed/dead guard`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

// The contract's own wording: render()'s first line is 「覆盖所有重绘入口的唯一节流点」— the single
// throttle point covering every redraw entry. The suite above only pins the render()s that a
// texture-'loaded' callback happens to delegate to; this one pins ALL of them, which is what makes
// that delegation trustworthy in general and also covers the other deferred-redraw entries a
// texture scan can't see (fetch/await completions, onSaveChanged, timers). 2026-08-16: adding it
// turned up two scenes still missing the guard — SectScene and TitlesScene, neither of which had a
// live async redraw path yet, so this is the rare case of a test landing before its bug.
//
// Deliberately allowlist-free: every scene satisfies it today, so an exemption list would only be
// somewhere for the next regression to hide.
describe('every menu scene render() opens with a destroyed/dead guard', () => {
  const GUARD_RE = /if\s*\(\s*!?\s*(this|core)\.(destroyed|dead)\s*\)\s*return/;

  // `render` plus the `paintX` halves a scene splits its render into once it stops rebuilding one
  // flat tree per pass (CityScene's page/modal layer split, 2026-09-02). Those halves are redraw
  // entry points in their own right — CityScene injects `paintModal` into its Core, which hands it
  // to hit closures — so the guard contract has to reach them too, or the split is a hole in it.
  const RENDER_DEF_RE = /^\s*(private |public )?(render|paint[A-Z]\w*)\(\): void \{/;

  function sceneRenderDefs(): { rel: string; line: number; window: string }[] {
    const out: { rel: string; line: number; window: string }[] = [];
    for (const file of listSourceFiles(path.join(SRC_ROOT, 'scenes'))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (!RENDER_DEF_RE.test(l)) return;
        out.push({
          rel: path.relative(SRC_ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          // `const core = this.core;` plus a comment block routinely precede the guard.
          window: lines.slice(i + 1, i + 9).join('\n'),
        });
      });
    }
    return out;
  }

  it('finds the scene render() definitions at all (regex/CRLF canary)', () => {
    expect(sceneRenderDefs().length).toBeGreaterThan(20);
  });

  it('has no scene render() without a guard', () => {
    const offenders = sceneRenderDefs()
      .filter((d) => !GUARD_RE.test(d.window))
      .map((d) => `${d.rel}:${d.line}`);
    expect(offenders).toEqual([]);
  });
});
