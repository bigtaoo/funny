// decorCLayer.ts — the contracts its own file-header states in prose, turned into assertions.
//
// Why this file exists. On 2026-08-27 a real-Chrome pixel pass found the header comment promising
// "faint alpha (0.06–0.15) never competes with foreground" while the constants said 0.25–0.38 — the
// value was raised on 2026-06-28 for the lobby's look and the comment was never updated (and had
// ALREADY been stale before that: the raise commit says the previous value was 0.10–0.22, not
// 0.06–0.15). Nothing noticed for two months, across 27 scenes, and the visible cost was the
// Leaderboard's "My rank" readout sitting on an ink blot.
//
// That was the SECOND prose-drift defect found the same day — CardScene/logic/types.ts claimed its
// roster cell was "deliberately taller" than the equipment cell when both had been 266 since
// 2026-07-16 (see cardSceneCellGeometry.test.ts). Both are the same failure: a cross-cutting design
// constraint stated only in a comment, with no check. So the alpha range is pinned here in the one
// way that actually holds: the module carries a machine-readable `@alpha-range lo-hi` tag and this
// file requires it to equal what the constants produce. Prose-matching was tried first and was not
// enough — see the tag case below for why.
//
// Source-text assertions rather than imported values because the tuning constants are deliberately
// module-private (nothing outside should be able to read or set them). Same technique as
// cardSceneTabSwitchGuard / headerCurrencyReserve / textureLoadedGuardCallSites.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../src');
const DECOR = path.join(SRC_ROOT, 'render/decorCLayer.ts');
const src = fs.readFileSync(DECOR, 'utf8');

/** Read a `const NAME = <number>;` tuning constant out of the module source. */
function constant(name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)\\s*;`).exec(src);
  expect(m, `${name} is no longer a plain numeric const — update this guard`).not.toBeNull();
  return Number(m![1]);
}

describe('decorCLayer tuning constants vs. the prose that describes them', () => {
  it('finds the file and its alpha constants at all (canary)', () => {
    // Without this, a rename turns every check below into a vacuous pass over an empty string.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('buildDecorCLayer');
    expect(constant('ALPHA_MIN')).toBeGreaterThan(0);
    expect(constant('ALPHA_RANGE')).toBeGreaterThan(0);
  });

  it('the @alpha-range tag equals what the constants actually produce', () => {
    // The whole point. `ALPHA_MIN` .. `ALPHA_MIN + ALPHA_RANGE` is the real range and the tag must
    // state it. A TAG, not a sentence: the first draft of this guard looked for the right numbers
    // "somewhere in the header" and passed with the stale 0.06–0.15 claim still sitting in it,
    // because the corrected paragraph quoted both. Mutation-verified in both directions now.
    const lo = constant('ALPHA_MIN');
    const hi = +(lo + constant('ALPHA_RANGE')).toFixed(4);
    const tag = /@alpha-range\s+([0-9.]+)\s*-\s*([0-9.]+)/.exec(src);
    expect(tag, 'decorCLayer.ts must carry an `@alpha-range lo-hi` tag in its header').not.toBeNull();
    const [, tagLo, tagHi] = tag!;
    expect(
      [Number(tagLo), Number(tagHi)],
      `@alpha-range says ${tagLo}-${tagHi} but ALPHA_MIN/ALPHA_RANGE produce ${lo}-${hi}. ` +
      'If you retuned the alpha, retype the tag in the same commit — it is what tells the next ' +
      'reader whether this layer may sit under text, and 27 scenes use it.',
    ).toEqual([lo, hi]);
  });

  it('the alpha the header describes as "faint" is not silently strong', () => {
    // A soft ceiling, deliberately above the CURRENT 0.38 rather than at it: this is not trying to
    // force an art decision (retuning is an open call — UI_DESIGN_LOG §39), it is here so that a
    // future bump into "obviously opaque" territory has to be argued for rather than typed.
    // 0.5 is the line: past that the doodle is no longer background at all.
    const hi = constant('ALPHA_MIN') + constant('ALPHA_RANGE');
    expect(hi, 'decor doodles are background ambience; >=0.5 alpha is a foreground element').toBeLessThan(0.5);
  });

  it('placement is still "dense at edges, sparse at centre", the way the header explains it', () => {
    // These two constants are skip PROBABILITIES, so the denser band is the one with the SMALLER
    // number — easy to invert while "fixing" density and end up with doodles massed behind panels.
    // Worth pinning together with the note below, because the model itself is the open question:
    // the header justifies edge-density with "the main UI content occupies the central vertical
    // band", which holds for the lobby and NOT for a list scene whose header, season label and
    // my-rank readout all live at the top edge — exactly where this puts the most doodles.
    expect(constant('EDGE_SKIP')).toBeLessThan(constant('CENTER_SKIP'));
  });

  it('the scatter is deterministic — a fixed seed, not Math.random', () => {
    // The header promises "identical layout on every build", which is what lets bake() cache by
    // size. A stray Math.random() would make every rebuild a fresh texture and a fresh cache miss.
    expect(src).toMatch(/const\s+SEED\s*=/);
    expect(src, 'decorCLayer must not use Math.random — it breaks the bake cache key').not.toMatch(/Math\.random/);
  });
});

describe('buildDecorCLayer callers', () => {
  it('returns null when the atlas is not ready, which is the documented contract', () => {
    // True in this suite: nothing loads the decor atlas, so isDecorCReady() is false. Every caller
    // depends on this being a null rather than a throw — see the call-site check below.
    // Imported lazily so the 27-caller scan above still runs if the render layer fails to load.
    return import('../src/render/decorCLayer').then(({ buildDecorCLayer }) => {
      expect(buildDecorCLayer(1920, 1080)).toBeNull();
    });
  });

  it('every call site null-guards the result', () => {
    // 27 scenes call this, all currently `const x = buildDecorCLayer(...); if (x) parent.addChild(x)`.
    // The 28th is the one to worry about: `addChild(null)` throws inside PIXI, and it would only
    // throw on the cold path where the atlas has not decoded yet — i.e. not on a warm dev reload.
    const offenders: string[] = [];
    const walk = (rel: string): string[] =>
      fs.readdirSync(path.join(SRC_ROOT, rel), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${rel}/${e.name}`) : e.name.endsWith('.ts') ? [`${rel}/${e.name}`] : []);

    let callSites = 0;
    for (const rel of walk('.')) {
      if (rel.endsWith('render/decorCLayer.ts')) continue;
      const text = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes('buildDecorCLayer(')) return;
        callSites++;
        // The assignment and the guard are conventionally adjacent; look a couple of lines ahead so
        // a blank line or a comment between them is fine.
        const window = lines.slice(i, i + 4).join('\n');
        const varName = /(?:const|let)\s+(\w+)\s*=\s*buildDecorCLayer\(/.exec(line)?.[1];
        if (!varName) {
          // Called inline — `addChild(buildDecorCLayer(...))` — which cannot be guarded.
          offenders.push(`${rel}:${i + 1} calls buildDecorCLayer inline, so the null can reach addChild`);
          return;
        }
        if (!new RegExp(`if\\s*\\(\\s*${varName}\\s*\\)`).test(window)) {
          offenders.push(`${rel}:${i + 1} does not null-guard \`${varName}\``);
        }
      });
    }

    expect(callSites, 'canary: found no buildDecorCLayer call sites at all').toBeGreaterThan(20);
    expect(offenders, 'buildDecorCLayer returns null when its atlas has not decoded:\n  ' + offenders.join('\n  ')).toEqual([]);
  });
});
