// Guards against the return of the 2026-08-27 `test:ui` flake, which was not a bug in the product
// but a bug in how the UI tests fake a texture load.
//
// The setup that makes it possible: `vitest.ui.config.ts`'s `stubBinaryAssets` resolves EVERY `*.png`
// import to one 1x1 data URI, and `render/cardArt.ts`'s `getArtTexture(url)` caches by url — so in
// that harness every portrait, avatar bust and skin bust is the same `PIXI.Texture` object. Tests
// simulate "the art finished streaming in" by mutating that shared BaseTexture in place, and the
// mutation outlives the `it()` that made it. Vitest's per-file isolation does not help; the leak is
// from one test to the next INSIDE a file.
//
// Two rules came out of the fix, and neither is discoverable from reading a single test:
//
//   1. A file that fakes a load must reset the shared texture per test — `beforeEach` +
//      `resetSharedStubTexture()` from `test/harness/sharedStubTexture.ts`. Otherwise every test in
//      it whose premise is "not loaded yet" passes only because of declaration order.
//   2. `valid = true` must come BEFORE `setRealSize(...)`. `BaseTexture.setRealSize()` runs
//      `update()` only while valid, and that update is what fires the PERSISTENT `'update'` listener
//      that resyncs `Texture.frame`. The `'loaded'` listener PIXI would otherwise use for this is a
//      ONE-SHOT (`baseTexture.once('loaded', this.onBaseTextureUpdated, this)` in Texture's
//      constructor) and is spent by the first test that emits it — after which `emit('loaded')`
//      alone leaves the frame holding the PREVIOUS test's dimensions, and app code reading
//      `tex.width` silently reads a stale size.
//
// Rule 2 in particular is invisible: the wrong order still passes on its own and fails only once a
// second test in the run has emitted 'loaded'. Hence a static check rather than trusting a comment.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const UI_DIR = path.resolve(__dirname, 'ui');
const HELPER = 'resetSharedStubTexture';

interface File { rel: string; text: string; lines: string[] }

function uiFiles(): File[] {
  return fs.readdirSync(UI_DIR)
    .filter((n) => n.endsWith('.ui.ts'))
    .map((n) => {
      const text = fs.readFileSync(path.join(UI_DIR, n), 'utf8');
      return { rel: `test/ui/${n}`, text, lines: text.split(/\r?\n/) };
    });
}

/** Files that fake a texture load by flipping `valid` on a baseTexture. */
function loadFakers(files: File[]): File[] {
  return files.filter((f) => /\.baseTexture\.valid\s*=\s*true/.test(f.text));
}

describe('UI tests that fake a texture load', () => {
  const files = uiFiles();

  it('finds the UI suite at all (canary: a move must not empty this guard)', () => {
    expect(files.length).toBeGreaterThan(100);
    // And there is at least one load-faker to check. If this ever hits zero, the two rules below
    // stopped being exercised and this file is passing for the wrong reason — same failure shape the
    // guard exists to prevent.
    expect(loadFakers(files).length).toBeGreaterThan(0);
  });

  it('each one resets the shared stub texture per test', () => {
    const offenders = loadFakers(files)
      .filter((f) => !(f.text.includes(HELPER) && /beforeEach\s*\(/.test(f.text)))
      .map((f) => f.rel);
    expect(
      offenders,
      'a file that flips `baseTexture.valid = true` leaks that into every later test in it. Add\n' +
      "  import { resetSharedStubTexture } from '../harness/sharedStubTexture';\n" +
      `  beforeEach(${HELPER});\n` +
      'to:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('sets `valid` BEFORE setRealSize, so Texture.frame actually resyncs', () => {
    // Scan each `setRealSize(` line and look back a few lines for the `valid = true` that must
    // precede it. Looking BACK rather than parsing: these are hand-written test bodies where the two
    // statements sit adjacent, and the failure mode of over-reporting here is a loud, fixable red.
    const offenders: string[] = [];
    for (const f of loadFakers(files)) {
      f.lines.forEach((line, i) => {
        if (!/\.setRealSize\s*\(/.test(line)) return;
        const before = f.lines.slice(Math.max(0, i - 4), i).join('\n');
        const after = f.lines.slice(i + 1, i + 4).join('\n');
        const validBefore = /\.valid\s*=\s*true/.test(before);
        const validAfter = /\.valid\s*=\s*true/.test(after);
        if (validAfter && !validBefore) {
          offenders.push(
            `${f.rel}:${i + 1} sets valid AFTER setRealSize — swap them, or Texture.frame keeps the ` +
            'previous size once the one-shot \'loaded\' listener has been spent',
          );
        }
      });
    }
    expect(offenders, offenders.join('\n  ')).toEqual([]);
  });

  it('the helper it points at is real and does what its name says', () => {
    // Cheap coupling check: a rename that leaves the two checks above matching a dead string would
    // make them pass over nothing.
    const helperPath = path.resolve(__dirname, 'harness/sharedStubTexture.ts');
    expect(fs.existsSync(helperPath), 'test/harness/sharedStubTexture.ts is gone').toBe(true);
    const helper = fs.readFileSync(helperPath, 'utf8');
    expect(helper).toContain(`export function ${HELPER}`);
    // It must end cold. A reset that left `valid` true would be worse than no reset at all: every
    // "still loading" test in the file would then fail instead of one of them flaking.
    expect(helper).toMatch(/valid\s*=\s*false\s*;?\s*}?\s*$/m);
  });
});
