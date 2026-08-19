// Static guard on the editor's resource-motif renderer staying a thin adapter over @nw/shared.
//
// render/tileGraphics.ts's drawResMotif and the game client's used to be two hand-written bodies of
// the same formula, kept together by a "must stay in lockstep" comment. On 2026-08-19 the shared
// contract changed underneath both of them — width normalisation out, the packer-baked `nw` block in
// (design/product/slg-resource-art.md §6) — and the math moved into @nw/shared's resMotifPlacement so
// there is exactly one body left. server/shared/test/core.test.ts pins the formula;
// client/test/ui/worldMapResMotifLevelRead.ui.ts pins that the client routes through it. This file is
// the editor's half of that: a correct shared function the editor doesn't call renders the editor's
// map differently from the game, which breaks the WYSIWYG promise (DESIGN.md §6.3) silently — both
// versions draw, neither throws.
//
// A source scan rather than a unit test because render/tileGraphics.ts is out of this suite's scope
// by construction (vitest.config.ts: "pure layers only" — it drives PIXI and the editor has no
// headless harness). Same approach as rasterizeCallSites.test.ts and
// client/test/no-debug-hooks-in-src.test.ts.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../src');

/** Source text with comments removed — the file DISCUSSES the contract it implements in prose. */
function codeOf(file: string): string {
  return fs.readFileSync(path.join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of `export function <name>(...)`, balanced to its closing brace. */
function bodyOf(code: string, name: string): string {
  const at = code.indexOf(`export function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf('{', code.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  throw new Error(`unbalanced body for ${name}`);
}

describe('the editor draws resource motifs through @nw/shared, not its own copy', () => {
  const code = codeOf('render/tileGraphics.ts');
  const body = bodyOf(code, 'drawResMotif');

  it('imports resMotifPlacement from @nw/shared/slg', () => {
    expect(code).toMatch(/import\s*\{[^}]*\bresMotifPlacement\b[^}]*\}\s*from\s*'@nw\/shared\/slg'/);
  });

  it('calls it, and takes the sprite transform from what it returns', () => {
    expect(body).toContain('resMotifPlacement(');
    // Every visual property of the sprite comes off the returned placement. Setting even one of them
    // locally is how the two renderers drifted the first time.
    for (const prop of ['scale.set(', 'rotation =', 'alpha =', '.x =', '.y =']) {
      expect(body).toContain(prop);
    }
    expect(body).toMatch(/scale\.set\(\s*\w+\.scale\s*\)/);
    expect(body).toMatch(/\.alpha\s*=\s*\w+\.alpha\b/);
  });

  it('passes the frame\'s baked level read, not a locally derived one', () => {
    expect(body).toMatch(/read:\s*getResFrameRead\(/);
    expect(code).toMatch(/import\s*\{[^}]*\bgetResFrameRead\b[^}]*\}\s*from\s*'\.\/resAtlasLoader'/);
  });

  it('derives nothing from the level itself — no size or alpha arithmetic on `lv`', () => {
    // The retired contract lived here as `(tp * 0.30) / denom` plus `0.55 + 0.45 * ((lv - 1) / 9)`.
    // Both are now the packer's business; anything reintroducing them here re-forks the read.
    expect(body).not.toMatch(/\blv\b\s*[-+*/]/);
    expect(body).not.toMatch(/[-+*/]\s*\blv\b/);
    // The texture's dimensions may be HANDED to resMotifPlacement (it needs them for the
    // no-baked-read fallback); what must not come back is normalising by them here.
    expect(body).not.toMatch(/\/\s*(denom|tex\b|Math\.max\(tex)/);
    expect(body).not.toContain('const denom');
  });

  it('keeps no local jitter twin either', () => {
    // resMotifJitter moved to @nw/shared with the rest; a local re-implementation would put the two
    // renderers' per-tile wobble back out of step, which is invisible until someone compares screenshots.
    expect(code).not.toContain('function motifJitter');
    expect(code).not.toContain('43758.5453');
  });
});
