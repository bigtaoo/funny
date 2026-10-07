/**
 * uiFontFamily.test.ts — every piece of UI text is drawn in the one family from render/theme.ts.
 *
 * Until 2026-10-07 there were 91 inline `fontFamily:` literals in `src/` — 82 'monospace', 6 'serif'
 * (story pages, result / replay headlines), 2 'sans-serif' (loading overlay, world-map loading
 * label) — and the hand cards, the drag ghost and the ink hint named no family at all, so PIXI drew
 * them in its built-in default, Arial. One battle screen showed three faces. The family now lives
 * in ONE constant, `UI_FONT_FAMILY`, so that swapping in a hand-written face is a one-line change.
 *
 * Same shape as the repo's other convention guards (liveStrokedInkCallSites.test.ts): it scans
 * `src/` for the entry point — a `fontFamily:` written as a string literal — and fails unless the
 * site is listed below with a reason. A family spelled any other way (the constant, a variable that
 * holds it) passes; a literal does not, because a literal is exactly what the swap would miss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { UI_FONT_FAMILY } from '../src/render/theme';
import { installUiFontDefault } from '../src/render/pixiText';

const SRC = join(__dirname, '..', 'src');

/** Raw `fontFamily:` literals that are allowed to stay, keyed by `<file>::<n>` (source order). */
const ALLOWED: Record<string, string> = {
  'scenes/worldmap/tileGraphics/resources.ts::1':
    "the world map's baked BitmapFont (digits + 'Lv.' only, its own glyph atlas) — not live UI text",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Comments may quote the old literals (several headers do); only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Number of `fontFamily: '<literal>'` / `"…"` / `` `…` `` occurrences in a source file. */
function rawFamilyLiterals(source: string): number {
  return (stripComments(source).match(/\bfontFamily\s*:\s*['"`]/g) ?? []).length;
}

describe('UI font family', () => {
  it('no raw fontFamily literal outside the allow-list', () => {
    const found = new Set<string>();
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      const n = rawFamilyLiterals(readFileSync(file, 'utf8'));
      for (let i = 1; i <= n; i++) found.add(`${rel}::${i}`);
    }
    const added = [...found].filter((k) => !(k in ALLOWED)).sort();
    const gone = Object.keys(ALLOWED).filter((k) => !found.has(k)).sort();
    expect(
      added,
      'Raw fontFamily literal(s). Use UI_FONT_FAMILY from render/theme.ts (or txt()/txtOutlined() ' +
        'from render/sketchUi.ts, or makeText() without a family, which fills it in) — a literal ' +
        'is exactly what swapping the UI font would miss.',
    ).toEqual([]);
    expect(gone, 'An allowed literal is gone — delete its ALLOWED entry.').toEqual([]);
  });

  it('the scanner counts literals and ignores the constant and comments', () => {
    expect(rawFamilyLiterals("makeText(s, { fontSize: 12, fontFamily: 'serif' })")).toBe(1);
    expect(rawFamilyLiterals('{ fontFamily: "sans-serif" }')).toBe(1);
    expect(rawFamilyLiterals('{ fontFamily: UI_FONT_FAMILY }')).toBe(0);
    expect(rawFamilyLiterals("// was fontFamily: 'monospace'\n/* fontFamily: 'serif' */")).toBe(0);
  });

  // makeText() needs a canvas, so its fill-in is covered headlessly in test/ui/uiFontFamily.ui.ts.

  describe('installUiFontDefault', () => {
    let before: string | string[];
    beforeAll(() => { before = PIXI.TextStyle.defaultStyle.fontFamily; });
    afterAll(() => { PIXI.TextStyle.defaultStyle.fontFamily = before; });

    it('makes a bare new PIXI.TextStyle use the UI family', () => {
      installUiFontDefault();
      expect(new PIXI.TextStyle({ fontSize: 12 }).fontFamily).toBe(UI_FONT_FAMILY);
    });
  });
});
