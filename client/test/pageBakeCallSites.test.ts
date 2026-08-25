/**
 * pageBakeCallSites.test.ts — every `bake()`/`bakeLazy()` call site must have DECIDED whether it is
 * page-sized.
 *
 * ADR-073 made `pageScale` opt-in on purpose (page layers want device-exact sizing; small chrome
 * would visibly soften at it), and opt-in flags rot silently in both directions:
 *   - a new full-page bake added without the flag is another 111 MB texture on a phone, and nothing
 *     goes red — the 2026-08-25 crash, reintroduced;
 *   - the flag deleted from one of the seven existing sites is the same thing, one screen at a time.
 *
 * So this is a source-level guard, not a behaviour test: it enumerates the call sites and compares
 * them against an explicit expectation below. A NEW call site fails the test until it is listed,
 * which is the whole point — the author has to state which bucket it belongs in.
 *
 * Same shape as the repo's other convention guards (`no-debug-hooks-in-src.test.ts`, the
 * drawHeaderCurrency leftBound sweep in `headerCurrencyReserve.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..', 'src');

/**
 * Expected `pageScale` for every call site, keyed by `file::key-expression`.
 *
 * `true`  = laid out 1:1 in design space, never magnified → device-exact sizing (ADR-073).
 * `false` = small shared chrome, and/or rides on a container that animates above scale 1, where a
 *           device-exact texture would visibly soften. These are kilobytes; leave them alone.
 */
const EXPECTED: Record<string, boolean> = {
  // ── page-sized: the seven ADR-073 converted ────────────────────────────────
  'render/sketchUi.ts::paper background (all ~30 scenes)':      true,
  'render/wearOverlay.ts::worn-page overlay':                   true,
  'render/decorCLayer.ts::C-group background doodles':          true,
  'render/decorLayer.ts::battle side-band doodles':             true,
  'render/BoardView.ts::board sheet + ruled grid':              true,
  'scenes/LobbyScene/core.ts::lobby notebook background':       true,
  'scenes/ResultScene/builders.ts::result page margin':         true,
  // ── deliberately NOT page-sized ────────────────────────────────────────────
  'render/boil.ts::per-frame boil offsets':                     false,
  'render/panelFrame.ts::panel frame atlas':                    false,
  'ui/widgets/uiCache.ts::shared UI chrome (getCachedTexture)': false,
  'ui/widgets/uiCache.ts::shared UI chrome (sized variant)':    false,
};

/** Human label per (file, occurrence index) — keeps the map above readable. */
const LABELS: Record<string, string[]> = {
  'render/sketchUi.ts':             ['paper background (all ~30 scenes)'],
  'render/wearOverlay.ts':          ['worn-page overlay'],
  'render/decorCLayer.ts':          ['C-group background doodles'],
  'render/decorLayer.ts':           ['battle side-band doodles'],
  'render/BoardView.ts':            ['board sheet + ruled grid'],
  'scenes/LobbyScene/core.ts':      ['lobby notebook background'],
  'scenes/ResultScene/builders.ts': ['result page margin'],
  'render/boil.ts':                 ['per-frame boil offsets'],
  'render/panelFrame.ts':           ['panel frame atlas'],
  'ui/widgets/uiCache.ts':          ['shared UI chrome (getCachedTexture)', 'shared UI chrome (sized variant)'],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip comments before scanning.
 *
 * Not optional: several of these very files *document* the convention in prose, and a doc comment
 * reading "statically baked (`bake()`, zero runtime cost)" is indistinguishable from a call site to
 * the regex below. Found the hard way — decorCLayer.ts reported two call sites and has one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block + JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, without eating `https://`
}

/**
 * Find `bake(`/`bakeLazy(` calls and whether each passes `pageScale`.
 *
 * Scans forward from the call's opening paren to its matching close, so a call split across lines
 * (sketchUi and ResultScene both are) is read whole. Deliberately crude — this only has to be right
 * about the handful of call sites that exist, and a parse it cannot make sense of shows up as a
 * missing/extra entry rather than as a silent pass. `bakeResolution(`/`bakeStats(` do not match:
 * the `\s*\(` has to follow the name immediately.
 */
function callSites(input: string): boolean[] {
  const source = stripComments(input);
  const found: boolean[] = [];
  const re = /\b(?:bake|bakeLazy)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) break; }
    }
    found.push(source.slice(m.index, i + 1).includes('pageScale'));
  }
  return found;
}

describe('bake() call sites — pageScale is a decision, not a default', () => {
  const files = walk(SRC)
    .filter((f) => !f.endsWith(`render${sep}bake.ts`))       // the definition, not a call site
    .map((f) => ({ path: f, rel: relative(SRC, f).split(sep).join('/'), src: readFileSync(f, 'utf8') }))
    .map((f) => ({ ...f, sites: callSites(f.src) }))
    .filter((f) => f.sites.length > 0);

  it('finds the call sites at all (guards against the scan silently matching nothing)', () => {
    // A regex that stops matching would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(5);
    expect(files.reduce((n, f) => n + f.sites.length, 0)).toBe(Object.keys(EXPECTED).length);
  });

  it('every call site is listed with the pageScale it is expected to pass', () => {
    const actual: Record<string, boolean> = {};
    for (const f of files) {
      const labels = LABELS[f.rel];
      expect(labels, `${f.rel} has bake() calls but no label — add it to LABELS + EXPECTED`).toBeDefined();
      expect(labels!.length, `${f.rel} has ${f.sites.length} bake() call(s) but ${labels!.length} label(s)`)
        .toBe(f.sites.length);
      f.sites.forEach((pageScale, i) => { actual[`${f.rel}::${labels![i]}`] = pageScale; });
    }
    // One object comparison rather than a loop of assertions: the diff on failure names exactly
    // which site changed direction, and an unlisted new site shows up as an extra key.
    expect(actual).toEqual(EXPECTED);
  });

  it('all seven page-sized layers really are the full-page ones', () => {
    // Cheap sanity check that the map above did not get its buckets swapped: a page-sized bake is
    // handed the whole design rect, which in this codebase always reads as a bare `w, h` /
    // `this.w, this.h` / `rect.w, rect.h` pair — never a literal pixel size the way chrome does.
    const pageFiles = Object.entries(EXPECTED).filter(([, v]) => v).map(([k]) => k.split('::')[0]);
    expect(new Set(pageFiles).size).toBe(7);
    for (const rel of new Set(pageFiles)) {
      const f = files.find((x) => x.rel === rel)!;
      expect(f.src, `${rel} should size its bake from a layout rect`).toMatch(/bake\([\s\S]{0,200}?\b(?:w|h|rect\.[wh]|r\.[wh])\b/);
    }
  });
});
