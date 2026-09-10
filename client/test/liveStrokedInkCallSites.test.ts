/**
 * liveStrokedInkCallSites.test.ts — two shapes of hand-rolled ink that must have been decided on.
 *
 * `SketchPen.rect()` is the expensive way to draw a frame. To get its taper the pen changes
 * `lineStyle` per segment, with round caps and joins, so nothing batches: one 976x105 panel comes
 * out as 735 un-batchable primitives and 68,496 indices (ADR-083). The cheap way that looks the
 * same is `render/sketchUi.ts`'s `sketchPanel()`, which pastes sprites off `panelFrame.ts`'s baked
 * atlas.
 *
 * This has now gone wrong twice, and neither time did anything go red:
 *   - 2026-09-08, the lobby: four hand-drawn panel borders, 82% of an idle frame's 253,737 indices.
 *   - 2026-09-09, the settings screen: six control frames plus a third hand-rolled copy of the
 *     notebook page that, alone among the three, never called `bake()`. 590,214 indices per frame,
 *     re-triangulated on every avatar-picker wheel tick and twice a second while the rename caret
 *     blinked. 46,986 of those were the rename field, sitting in an overlay no budget measured.
 *
 * `test/ui/sceneGeometryBudget.ui.ts` guards the COST, which is the thing that actually matters,
 * but it can only guard screens somebody thought to put in it — the settings screen was not in it,
 * which is exactly how that one survived a full day of render-budget work. This guards the ENTRY
 * POINT instead, across all of `src/`: a new live-stroked rectangle anywhere fails until it is
 * listed below with a reason. The two are deliberately different kinds of net, and neither
 * subsumes the other.
 *
 * Two describes, because the settings bug had two halves and only one of them was a rectangle:
 *   1. live-stroked RECTANGLES (the six control frames), and
 *   2. hand-rolled NOTEBOOK PAGES (the 462,420-index background — a `pen.line()` loop, which the
 *      first describe cannot see at all). `pageBakeCallSites.test.ts` cannot see it either: that
 *      one enumerates files that CALL `bake()`, and the whole defect was a file that never did.
 *
 * Same shape as `pageBakeCallSites.test.ts` and the repo's other convention guards: an explicit
 * expectation map, so a new call site cannot pass by merely looking plausible — an author has to
 * say which bucket it is in.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..', 'src');

/**
 * Why each live-stroked rectangle in `src/` is allowed to be one.
 *
 * Keyed by `<file>::<n>`, n being the 1-based occurrence in source order.
 *
 * The buckets, and nothing else is one:
 *   FALLBACK — the atlas is unavailable (no bake renderer: headless UI tests) or the panel is too
 *              small to seat two corner pieces. Sits behind an `addPanelFrame(...)` that declined.
 *   BAKED    — stroked once into a texture via `bake()`; the tree gets a sprite. Costs nothing per
 *              frame, and the call site is separately registered in `pageBakeCallSites.test.ts`.
 *   DOODLE   — not a UI frame. Tape, a boxed chapter label: shapes the atlas cannot supply.
 *   GAMEPLAY — inside the battle renderer, redrawn every frame by design. `GameScene` is
 *              `paint: 'live'` and was deliberately left alone by ADR-083/085/086.
 *   ICON     — a small hand-drawn glyph with no atlas equivalent. NOT free: measured 2026-09-09,
 *              an empty equipment slot costs 2,010–2,922 indices at 44px and 3,720–5,496 at 96px.
 *              They are drawn once per scene build (not per frame) and there is nothing cheaper to
 *              call, which is why they stay — but if an equipment-style screen ever shows up over
 *              budget, this is where to look first.
 *   DEV      — the `?sketch` pen sampler (`entries/web.ts`), which is not the game.
 *
 * A new panel or button frame on a menu screen is none of these. It should call `sketchPanel()`.
 */
const EXPECTED: Record<string, string> = {
  'render/sketchUi.ts::1':                 "FALLBACK — sketchPanel's own, when addPanelFrame() declines",
  'scenes/LobbyScene/core.ts::1':          'FALLBACK — drawBtn, same contract as sketchPanel above',
  'render/BoardView.ts::1':                'GAMEPLAY — blocked-lane marker, drawn with its hatch',
  'render/BoardView.ts::2':                'BAKED — board sheet + ruled grid',
  'render/BoardView/bases.ts::1':          'GAMEPLAY — base pulse ring, a fresh seed every frame',
  'render/BoardView/bases.ts::2':          'GAMEPLAY — the outer half of that same pulse',
  'render/HandView/cellDraw.ts::1':        'GAMEPLAY — selected hand-card outline',
  'scenes/CampaignMapScene/drawing.ts::1': 'DOODLE — the tape strip holding a chapter card down',
  'scenes/CampaignMapScene/drawing.ts::2': 'DOODLE — the boxed chapter label, drawn askew',
  'render/equipmentGlyph.ts::1':           'ICON — empty armor slot',
  'render/equipmentGlyph.ts::2':           'ICON — empty trinket slot',
  'render/equipmentGlyph.ts::3':           'ICON — armor item glyph (a book cover)',
  'render/equipmentGlyph.ts::4':           'ICON — trinket item glyph (a hanging tag)',
  'render/sketch.ts::1':                   'DEV — drawSketchDemo, the ?sketch pen sampler',
  'render/sketch.ts::2':                   'DEV — the second sampler swatch',
  'render/sketchDemo.ts::1':               'DEV — the sampler page\'s board preview frame',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip comments first — this file's own prose would otherwise read as call sites, and so would
 *  the comments in sketchUi.ts and LobbyScene/core.ts that explain the fallback contract. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Offsets of every `.rect(` whose receiver is a `SketchPen`, in the two shapes the codebase writes,
 * returned in source order so the `::n` labels above stay meaningful.
 *
 * Deliberately crude, like the bake scanner next door: it only has to be right about the handful of
 * sites that exist, and anything it cannot parse surfaces as a missing or extra entry rather than
 * as a silent pass.
 *
 * The second shape is matched by NAME, file-wide: any identifier ever assigned `new SketchPen(...)`
 * anywhere in the file makes every `<that name>.rect(` in it count. That is why the four
 * equipmentGlyph.ts sites are found even though they take their pen as a function PARAMETER — the
 * file happens to call it `pen` elsewhere too. A pen parameter named something the file never
 * declares would be missed; there is no such call site today, and if one appears that file's count
 * changes and this test says so.
 */
function liveRectSites(input: string): number[] {
  const source = stripComments(input);
  const at: number[] = [];

  // new SketchPen(...).rect(   — the one-liner
  const inline = /new\s+SketchPen\s*\([^;]*?\)\s*\.\s*rect\s*\(/gs;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(source)) !== null) at.push(m.index);

  // const pen = new SketchPen(...);  ... later ...  pen.rect(
  const pens = new Set<string>();
  const decl = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+SketchPen\s*\(/g;
  let d: RegExpExecArray | null;
  while ((d = decl.exec(source)) !== null) pens.add(d[1]!);
  for (const p of pens) {
    const use = new RegExp(`\\b${p}\\s*\\.\\s*rect\\s*\\(`, 'g');
    let u: RegExpExecArray | null;
    while ((u = use.exec(source)) !== null) at.push(u.index);
  }

  return at.sort((a, b) => a - b);
}

describe('live-stroked rectangles are all accounted for', () => {
  it('matches the expectation map exactly', () => {
    const found = new Set<string>();
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      const n = liveRectSites(readFileSync(file, 'utf8')).length;
      for (let i = 1; i <= n; i++) found.add(`${rel}::${i}`);
    }

    const added = [...found].filter((k) => !(k in EXPECTED)).sort();
    const gone = Object.keys(EXPECTED).filter((k) => !found.has(k)).sort();

    expect(
      added,
      'New live-stroked rectangle(s). If this is a panel or a button on a menu screen, call ' +
        'sketchPanel() from render/sketchUi.ts instead — it draws the same wobble off a baked ' +
        'atlas for a rounding error of the cost. If it genuinely is a fallback, a bake, a doodle, ' +
        'gameplay, an icon or the dev sampler, add it to EXPECTED here saying which and why.',
    ).toEqual([]);

    expect(
      gone,
      'A listed live-stroked rectangle is gone. Good news, probably — delete its EXPECTED entry.',
    ).toEqual([]);
  });

  it('the scanner sees both call shapes and counts them in source order', () => {
    // Without this the map could empty out silently and the case above would pass by finding
    // nothing at all — the same vacuous-gate trap as a stubbed asset loader.
    expect(liveRectSites('new SketchPen(g, 5).rect(2, 2, w - 4, h - 4, { color: c });')).toHaveLength(1);
    expect(liveRectSites('const pen = new SketchPen(g, 5);\npen.rect(0, 0, w, h, { color: c });')).toHaveLength(1);
    // Multi-line arguments, which CampaignMapScene/drawing.ts writes.
    expect(liveRectSites('new SketchPen(box, seedFor(x, y, ch)).rect(\n  x, y, w, h,\n  { color: c },\n);')).toHaveLength(1);
    // Mixed shapes must come back in source order, or the ::n labels point at the wrong thing.
    const mixed = 'const pen = new SketchPen(a, 1);\nnew SketchPen(b, 2).rect(0, 0, 1, 1, {});\npen.rect(0, 0, 1, 1, {});';
    expect(liveRectSites(mixed)).toEqual([mixed.indexOf('new SketchPen(b'), mixed.lastIndexOf('pen.rect')]);
    // And it must not count the cheap calls, or every sketchPanel caller would land in the map.
    expect(liveRectSites('sketchPanel(w, h, { fill, border });')).toHaveLength(0);
    expect(liveRectSites('new SketchPen(g, 5).line(0, y, w, y, { color: c });')).toHaveLength(0);
  });
});

/**
 * Files allowed to draw the notebook page themselves, and whether each bakes it.
 *
 * `render/sketchUi.ts`'s `buildPaperBackground()` is the one every scene should call. Three other
 * files draw their own ruled paper, which is a duplication the repo has decided to live with — but
 * a page drawn live is ~462,000 indices, so the thing that actually matters is that each one
 * ends in a `bake()`. `SettingsScene.drawBackground()` was a fourth copy and the only one that
 * did not, and nothing in the repo could see that: `pageBakeCallSites.test.ts` enumerates files
 * that CALL `bake()`, so a drawer that never calls it is invisible there by construction.
 */
const PAPER_DRAWERS: Record<string, boolean> = {
  'render/sketchUi.ts':          true,  // the shared builder, used by ~30 scenes
  'scenes/LobbyScene/core.ts':   true,  // the lobby's own copy, predates the shared one
  'render/BoardView.ts':         true,  // the battle sheet: same ruling, different geometry
  'render/sketchDemo.ts':        false, // the ?sketch sampler: a dev page, drawn once, not the game
};

describe('every notebook page is baked', () => {
  it('matches the expectation map exactly', () => {
    const drawers: Record<string, boolean> = {};
    for (const file of walk(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // The tell is a pen stroke in `palette.ruleLine` — the faint blue of the ruling, used
      // nowhere else. `render/theme.ts` (which defines it) and `sketchUi.ts`'s `ui` colour map
      // (which re-exports it) name it without stroking anything, so require a `pen`-ish call too.
      if (!/palette\.ruleLine/.test(source)) continue;
      if (!/\.\s*(?:line|stroke)\s*\(/.test(source)) continue;
      const rel = relative(SRC, file).split(sep).join('/');
      drawers[rel] = /\bbake(?:Lazy)?\s*\(/.test(source);
    }

    expect(
      drawers,
      'A file draws the notebook page. Prefer buildPaperBackground() from render/sketchUi.ts; if ' +
        'it really needs its own, it MUST bake() the result — a live page is ~462,000 indices, ' +
        'and SettingsScene shipped exactly that for months. Then list it in PAPER_DRAWERS here.',
    ).toEqual(PAPER_DRAWERS);
  });

  it('the tell actually discriminates (or this test is vacuous)', () => {
    // If either half of the detector stopped matching, PAPER_DRAWERS would empty out and the case
    // above would pass by finding nothing.
    expect(/palette\.ruleLine/.test(readFileSync(join(SRC, 'render', 'sketchUi.ts'), 'utf8'))).toBe(true);
    expect(/palette\.ruleLine/.test(readFileSync(join(SRC, 'render', 'theme.ts'), 'utf8'))).toBe(false);
    // theme.ts DEFINES ruleLine (as a bare property) and must not be counted as a drawer.
    expect(Object.keys(PAPER_DRAWERS)).not.toContain('render/theme.ts');
  });
});
