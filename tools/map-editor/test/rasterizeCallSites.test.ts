// Static guard on the editor's TWO rasterizeMapEdits() call sites agreeing with each other.
//
// The editor's WYSIWYG promise (DESIGN.md §6.2/§6.3, and render/baseMap.ts's own file header: "the
// same rasterizeMapEdits() that the Publish button uploads, so the WYSIWYG preview and what gets
// published can never drift apart") rests on the live preview and Publish rasterizing IDENTICALLY:
//
//   render/baseMap.ts  → what the designer SEES
//   ui/publish.ts      → what actually gets UPLOADED
//
// Since 2026-08-19 that call takes an options object (`citiesAreComplete`, which hands a dragged
// city's vacated procedural anchor back to the terrain). Passing it at one site and not the other
// silently breaks the promise in the worst possible direction — the preview would show clean terrain
// where the published map keeps a phantom city plot, or vice versa — and nothing would fail: both
// calls are valid, both render, both publish.
//
// Neither module is unit-testable here (both are excluded by vitest.config.ts's "pure layers only"
// scope: baseMap.ts drives PIXI, publish.ts reads getElementById at import time), so this is a source
// scan — same approach as client/test/no-debug-hooks-in-src.test.ts.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../src');
const CALL_SITES = ['render/baseMap.ts', 'ui/publish.ts'] as const;

/** Source text with comments removed — both files MENTION rasterizeMapEdits in their prose (that is
 *  how the WYSIWYG promise is documented), and a prose mention is not a call site. */
function codeOf(file: string): string {
  return fs.readFileSync(path.join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `rasterizeMapEdits(...)` call in a file, as source text (balanced to the closing paren). */
function rasterizeCalls(file: string): string[] {
  const src = codeOf(file);
  const calls: string[] = [];
  const needle = 'rasterizeMapEdits(';
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    // The named import reads `rasterizeMapEdits,` with no paren, so it never matches the needle.
    let depth = 0;
    let end = i + needle.length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')') { depth--; if (depth === 0) break; }
    }
    calls.push(src.slice(i, end + 1));
  }
  return calls;
}

describe('map-editor rasterizeMapEdits call sites (preview vs publish parity)', () => {
  it('both the preview and the publish path actually call it', () => {
    for (const file of CALL_SITES) {
      expect(rasterizeCalls(file), file).toHaveLength(1);
    }
  });

  it('both pass citiesAreComplete — the editor always holds the full node list', () => {
    // cityStore.nodes IS every city (the City tool can drag nodes but not add or remove any), so both
    // sites must opt in. If a future editor feature makes the list partial, the flag has to come off
    // BOTH sites together, and this test is where you will be reminded.
    for (const file of CALL_SITES) {
      expect(rasterizeCalls(file)[0], file).toMatch(/citiesAreComplete:\s*true/);
    }
  });

  it('both pass the same city source (cityStore.nodes), not a locally filtered copy', () => {
    for (const file of CALL_SITES) {
      expect(rasterizeCalls(file)[0], file).toContain('cityStore.nodes');
    }
  });

  it('publish uploads the city node list unconditionally, not only when the tile diff is non-empty', () => {
    // The tiles are just the ground under a city; the node list is what the game draws sprites from.
    // An early `if (diffs.length === 0) return` before the cities upload (which is what the pre-2026-08-19
    // "nothing to publish" guard did) would silently skip publishing a pure city-drag.
    const src = codeOf('ui/publish.ts');
    const citiesCall = src.indexOf('saveMapTemplateCities(');
    expect(citiesCall).toBeGreaterThan(-1);
    const before = src.slice(0, citiesCall);
    expect(before).not.toMatch(/diffs\.length\s*===\s*0[\s\S]*?return/);
  });
});
