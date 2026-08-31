/**
 * uiTapSoundCoverage.test.ts — every tappable thing in the client must go through one of the two
 * sanctioned outlets, so that adding a button cannot silently add a SILENT button.
 *
 * Why a source-level guard rather than a behaviour test: a button with no cue renders correctly,
 * hit-tests correctly, fires its action correctly, and passes every other kind of test we have.
 * The only symptom is that a human notices the game got quieter — which is exactly what happened
 * on the first pass of AUDIO_DESIGN.md §7 step 4: the shared hit table (`ui/hits.ts`) covered the
 * 40 scenes that keep a rect list, and the step was called done while 22 PIXI-native
 * `on('pointertap', …)` buttons stayed mute — including every button on ResultScene, i.e. the
 * screen the player lands on seconds after the victory/defeat stinger.
 *
 * The two outlets, and nothing else:
 *   1. `ui/hits.ts`'s `runHit` — reached via `dispatchHit` / `hitAction` / `runHit`, for the rect
 *      tables the scenes maintain themselves.
 *   2. `ui/hits.ts`'s `tapHandler` — for display objects that carry their own PIXI listener.
 *
 * Both funnel into `runHit`, so "which cue" stays one decision in one file (§2.2's 出口 column).
 *
 * Same shape as the repo's other convention guards (`pageBakeCallSites.test.ts`,
 * `no-debug-hooks-in-src.test.ts`): it enumerates call sites and compares them against an explicit
 * expectation, so a NEW one fails until its author states which bucket it belongs in.
 *
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..', 'src');

/**
 * PIXI tap listeners deliberately NOT wrapped in `tapHandler`, keyed by file + the listener call as
 * written (so reformatting the handler body does not invalidate the entry).
 *
 * Every entry needs a reason, because the default answer is "wrap it": a PIXI listener that reacts
 * to a tap is a button to the player no matter what the code calls it.
 */
const UNWRAPPED_TAP_ALLOWLIST: Record<string, string> = {
  "scenes/ResultScene.ts::this.container.once('pointerdown'":
    'The outro story overlay full-screen "tap to continue" — an advance, not a control. No button ' +
    'chrome, covers the whole screen, fires once per paragraph, so a tap cue there would read as ' +
    'the story itself clicking. IntroScene has the same surface and is silent for the same reason ' +
    '(it routes through InputManager, so this scan does not even see it).',
};

/**
 * Files allowed to call `playSfx` with a `sfx.ui.*` cue directly, i.e. outside `runHit`.
 *
 * Each is an outlet that genuinely is not a tap, with the reason (see AUDIO_DESIGN.md §2.2). Adding
 * a line here should feel expensive: every entry is a second place someone has to look when asking
 * "why did that make a noise".
 */
const DIRECT_UI_CUE_ALLOWLIST: Record<string, string> = {
  'ui/hits.ts':
    'The outlet itself — runHit is where the default sfx.ui.tap is applied.',
  'net/log.ts':
    'sfx.ui.error rides showToastMessage: a failure arrives from an async result, often seconds ' +
    'after the tap that started it, and this function is the choke point every failure already ' +
    'passes through.',
  'scenes/GachaScene/core.ts':
    'sfx.ui.gacha.reveal.* is raised on the draw RESPONSE, not on a tap, and is tiered per pull.',
};

/**
 * Hand-written rectangle containment (`x >= r.x && x <= r.x + r.w && …`) outside `ui/hits.ts`.
 *
 * This is the shape the SECOND miss hid in. After the PIXI-native family was fixed, LobbyScene —
 * the game's home screen — turned out to route all eighteen of its buttons through a hand-rolled
 * `if (x >= rect.x && …) { …; return; }` chain that no hit table and no PIXI listener ever saw, so
 * every one of them was still silent. Nothing about that code looks wrong; it just is not on any
 * of the paths a cue flows through. So the containment test itself is now the tripwire.
 *
 * Entries are legitimate non-button uses, each with a reason.
 */
const HAND_ROLLED_CONTAINMENT_ALLOWLIST: Record<string, string> = {
  'scenes/CardCodexScene.ts':
    'Scroll-layer remap: the tap y is shifted by scrollY before the test and clamped to the region, ' +
    'so it cannot use hitTest. It does call runHit, which is the part that matters.',
  'scenes/ChatScene.ts':
    'Same scroll-layer remap as CardCodexScene, and likewise ends in runHit.',
  'scenes/FriendsScene/input.ts':
    'Same again, against repaint.appliedScrollDelta rather than scrollY; ends in runHit.',
  'scenes/worldmap/WorldMapInput.ts':
    'infoScrollRect is a VIEWPORT test ("is this press inside the scrollable list"), not a button — ' +
    'the buttons inside it go through hitAction on the next line.',
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
 * Strip comments before scanning — several of these files *document* the convention in prose, and
 * a doc comment quoting `on('pointertap', …)` is indistinguishable from a call site to the regex
 * below. (`pageBakeCallSites.test.ts` found this the hard way; same fix.)
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Site { rel: string; line: number; text: string; wrapped: boolean }

/**
 * Deliberately wider than `pointertap`: `on`/`once` × `pointertap`/`pointerdown`/`pointerup` all
 * produce a button as far as the player is concerned, and scanning only the one spelling today's
 * code happens to use is how the next silent button gets in.
 */
const TAP_LISTENER = /\.(?:on|once)\(\s*'(?:pointertap|pointerdown|pointerup)'/;
const WRAPPED = /'(?:pointertap|pointerdown|pointerup)'\s*,\s*tapHandler\s*\(/;

function tapListenerSites(rel: string, input: string): Site[] {
  const source = stripComments(input);
  // CRLF-safe: the repo has mixed line endings, and a stray \r has broken anchored source scans
  // here before (see the crlf-breaks-source-scanning-tests note).
  const lines = source.split(/\r?\n/);
  const out: Site[] = [];
  lines.forEach((text, i) => {
    if (!TAP_LISTENER.test(text)) return;
    out.push({ rel, line: i + 1, text: text.trim(), wrapped: WRAPPED.test(text) });
  });
  return out;
}

/** Allowlist key: file + everything up to and including the event name. Stable across edits to the
 *  handler body, specific enough that two listeners on the same object stay distinct. */
function keyOf(s: Site): string {
  const call = TAP_LISTENER.exec(s.text);
  const end = call ? s.text.indexOf(call[0]) + call[0].length : 0;
  return `${s.rel}::${s.text.slice(0, end).trim()}`;
}

const FILES = walk(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join('/'),
  src: readFileSync(path, 'utf8'),
}));

describe('every PIXI-native tap button routes through tapHandler', () => {
  const sites = FILES.flatMap((f) => tapListenerSites(f.rel, f.src));

  it('finds the call sites at all (guards the scan against matching nothing)', () => {
    // Without this canary a regex that stopped matching would make the assertions below pass
    // vacuously, which is the exact failure this whole file exists to prevent one level up.
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.some((s) => s.wrapped)).toBe(true);
  });

  it('has no unwrapped handler outside the allowlist', () => {
    const unwrapped = sites
      .filter((s) => !s.wrapped && UNWRAPPED_TAP_ALLOWLIST[keyOf(s)] === undefined)
      .map((s) => `${s.rel}:${s.line}  ${s.text}`);
    expect(
      unwrapped,
      'A PIXI listener that reacts to a tap is a button to the player. Wrap it:\n' +
      "  node.on('pointertap', tapHandler(fn))                → sfx.ui.tap\n" +
      "  node.on('pointertap', tapHandler(fn, 'sfx.ui.back')) → close / cancel / back\n" +
      "  node.on('pointertap', tapHandler(fn, null))          → deliberately silent\n" +
      'See AUDIO_DESIGN.md §2.2. If this really is not a button, add it to ' +
      'UNWRAPPED_TAP_ALLOWLIST with the reason.',
    ).toEqual([]);
  });

  it('the allowlist has no stale entries, and every entry states why', () => {
    const seen = new Set(sites.filter((s) => !s.wrapped).map(keyOf));
    for (const [key, reason] of Object.entries(UNWRAPPED_TAP_ALLOWLIST)) {
      expect(seen.has(key), `${key} is allowlisted but is wrapped (or gone) now`).toBe(true);
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe('sfx.ui.* is raised in one place', () => {
  const offenders = FILES
    .filter((f) => DIRECT_UI_CUE_ALLOWLIST[f.rel] === undefined)
    .filter((f) => /playSfx\(\s*'sfx\.ui\./.test(stripComments(f.src)))
    .map((f) => f.rel);

  it('finds the sanctioned outlets (canary)', () => {
    const outlets = FILES.filter((f) => /playSfx\(\s*'sfx\.ui\./.test(stripComments(f.src)));
    expect(outlets.map((f) => f.rel)).toContain('net/log.ts');
  });

  it('no scene calls playSfx with a UI cue directly', () => {
    expect(
      offenders,
      'UI cues belong on the hit (`sound:` next to `fn`) or on tapHandler, not at the call site — ' +
      'otherwise "why did that make a noise" means grepping 40 scenes. See AUDIO_DESIGN.md §2.2.',
    ).toEqual([]);
  });

  it('the direct-outlet allowlist has no stale entries', () => {
    for (const [rel, reason] of Object.entries(DIRECT_UI_CUE_ALLOWLIST)) {
      expect(FILES.some((f) => f.rel === rel), `${rel} is allowlisted but no longer exists`).toBe(true);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

describe('the hit table stays the only Hit shape', () => {
  it('no scene re-declares its own `interface Hit` / `ModalHit` / `LocalHit`', () => {
    // The 22 duplicates this refactor removed grew back one scene at a time; the cheapest way to
    // keep them gone is to notice the 23rd on the day it is written. Aliases (`type Hit =
    // BaseHit<boolean>`) are fine and deliberately not matched — those still point at ui/hits.ts.
    const dupes = FILES.filter((f) => f.rel !== 'ui/hits.ts')
      .filter((f) => /^\s*(export\s+)?interface\s+(Hit|ModalHit|LocalHit)\b/m.test(stripComments(f.src)))
      .map((f) => f.rel);
    expect(
      dupes,
      'Import `Hit` from ui/hits.ts instead. A parallel declaration compiles (the shapes are ' +
      'structurally identical) and then quietly opts that scene out of the `sound` field.',
    ).toEqual([]);
  });

  it('finds the real declaration (canary)', () => {
    const hits = FILES.find((f) => f.rel === 'ui/hits.ts');
    expect(hits).toBeTruthy();
    expect(/export interface Hit<S = never>/.test(hits!.src)).toBe(true);
  });
});
describe('no hand-rolled rectangle containment outside ui/hits.ts', () => {
  // Matches `<anything> >= r.x && <anything> <= r.x + r.w`, with the backreference pinning both
  // halves to the SAME rect variable so unrelated comparisons do not trip it.
  const CONTAINMENT = /\w+\s*>=\s*(\w+)\.x\s*&&\s*\w+\s*<=\s*\1\.x\s*\+\s*\1\.w/;
  const hasContainment = (src: string): boolean =>
    stripComments(src).split(/\r?\n/).some((l) => CONTAINMENT.test(l));

  const offenders = FILES.filter((f) => f.rel !== 'ui/hits.ts').filter((f) => hasContainment(f.src)).map((f) => f.rel);

  it('finds containment tests at all (canary — the regex must still match ui/hits.ts itself)', () => {
    const self = FILES.find((f) => f.rel === 'ui/hits.ts');
    expect(self).toBeTruthy();
    expect(hasContainment(self!.src)).toBe(true);
  });

  it('every remaining one is an allowlisted non-button', () => {
    const unlisted = offenders.filter((rel) => HAND_ROLLED_CONTAINMENT_ALLOWLIST[rel] === undefined);
    expect(
      unlisted,
      'Use `inRect` / `hitTest` / `dispatchHit` from ui/hits.ts. A hand-rolled containment test is ' +
      'how LobbyScene kept eighteen silent buttons through a whole pass of AUDIO_DESIGN.md §7 step 4 ' +
      '— it is invisible to both the hit-table and the PIXI-listener scans above. If this really is ' +
      'not a button (a viewport/region test, a scroll-space remap), add it to ' +
      'HAND_ROLLED_CONTAINMENT_ALLOWLIST with the reason.',
    ).toEqual([]);
  });

  it('the allowlist has no stale entries, and every entry states why', () => {
    for (const [rel, reason] of Object.entries(HAND_ROLLED_CONTAINMENT_ALLOWLIST)) {
      expect(offenders, `${rel} is allowlisted but has no hand-rolled containment any more`).toContain(rel);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
