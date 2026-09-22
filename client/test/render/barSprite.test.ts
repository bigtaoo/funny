/**
 * barSprite.test.ts — regression test for `render/barSprite.ts` (2026-09-22).
 *
 * Zero coverage existed for this module even though every unit and building HP bar in the battle
 * screen now goes through it (`BuildingView.ts`, `UnitView/assets.ts`, `UnitView.ts`) — see
 * `claudedocs/client-render-budget.md` §13. Two things are worth pinning directly, not just via the
 * scenes that happen to call it:
 *
 *   1. `setBarRatio()` clamps its ratio into [0, 1] — an out-of-range HP fraction (a heal-over-max
 *      spell, or a fill sampled mid-tick before clamping upstream) must not stretch or invert the
 *      bar.
 *   2. `setBarRatio()` deliberately never touches `.visible` — the doc comment calls this out
 *      explicitly (the caller owns fade-in/fade-out timing), and that is exactly the kind of
 *      "doesn't do the obvious thing on purpose" contract that silently rots without a test.
 *
 * Uses the real `pixi.js-legacy` (via `harness/pixiHeadless`, imported first so `PIXI.Texture.WHITE`
 * doesn't need a real `document`) rather than a hand-rolled Graphics stub: `barSprite.ts` is a thin
 * wrapper around real `PIXI.Sprite` properties (`width`/`tint`/`alpha`), so the property reads here
 * are only meaningful against the real class.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */
import '../harness/pixiHeadless';
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { barSprite, setBarRatio } from '../../src/render/barSprite';

describe('barSprite()', () => {
  it('places the sprite at (x, y) with the given size, tint and alpha', () => {
    const s = barSprite(10, -20, 40, 4, 0x44cc44, 0.7);
    expect(s.x).toBe(10);
    expect(s.y).toBe(-20);
    expect(s.width).toBe(40);
    expect(s.height).toBe(4);
    expect(s.tint).toBe(0x44cc44);
    expect(s.alpha).toBe(0.7);
  });

  it('defaults alpha to 1 when omitted', () => {
    const s = barSprite(0, 0, 10, 2, 0xffffff);
    expect(s.alpha).toBe(1);
  });

  it('draws from the shared PIXI.Texture.WHITE baseTexture, not a per-bar texture', () => {
    const a = barSprite(0, 0, 10, 2, 0xff0000);
    const b = barSprite(0, 0, 10, 2, 0x0000ff);
    expect(a.texture).toBe(PIXI.Texture.WHITE);
    expect(b.texture).toBe(PIXI.Texture.WHITE);
    // Same baseTexture despite different tints — this is what keeps every bar in one batch.
    expect(a.texture.baseTexture).toBe(b.texture.baseTexture);
  });
});

describe('setBarRatio()', () => {
  it('scales width to ratio * fullW and sets tint', () => {
    const s = barSprite(-20, 0, 40, 4, 0x44cc44);
    setBarRatio(s, 0.5, 40, 0xcc4444);
    expect(s.width).toBe(20);
    expect(s.tint).toBe(0xcc4444);
  });

  it('clamps a ratio above 1 to full width', () => {
    const s = barSprite(-20, 0, 40, 4, 0x44cc44);
    setBarRatio(s, 1.5, 40, 0x44cc44);
    expect(s.width).toBe(40);
  });

  it('clamps a negative ratio to zero width, not a negative one', () => {
    const s = barSprite(-20, 0, 40, 4, 0x44cc44);
    setBarRatio(s, -0.3, 40, 0xcc4444);
    expect(s.width).toBe(0);
  });

  it('never touches .visible — showing/hiding the bar stays the caller\'s job', () => {
    const shown = barSprite(-20, 0, 40, 4, 0x44cc44);
    shown.visible = true;
    setBarRatio(shown, 0, 40, 0xcc4444); // an empty bar is still a "shown, but zero-width" bar
    expect(shown.visible).toBe(true);

    const hidden = barSprite(-20, 0, 40, 4, 0x44cc44);
    hidden.visible = false;
    setBarRatio(hidden, 1, 40, 0x44cc44); // pre-computing width for a bar not yet faded in
    expect(hidden.visible).toBe(false);
  });
});
