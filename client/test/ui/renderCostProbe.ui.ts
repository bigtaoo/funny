// renderCostProbe's Text hook: a dirty Text is timed and still rasterized; a clean one never reads the clock.
//
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { installRenderCostProbe, beginRenderCost, readRenderCost } from '../../src/render/renderCostProbe';

describe('renderCostProbe Text hook', () => {
  installRenderCostProbe(null);

  it('runs the original on a dirty text and skips a clean one before timing it', () => {
    const text = new PIXI.Text('hello');
    beginRenderCost();
    text.updateText(true);
    expect(text.dirty).toBe(false); // the original ran and cleared it

    const nowCalls = { n: 0 };
    const origNow = performance.now.bind(performance);
    performance.now = () => { nowCalls.n++; return origNow(); };
    try {
      for (let i = 0; i < 1000; i++) text.updateText(true);
    } finally {
      performance.now = origNow;
    }
    expect(nowCalls.n).toBe(0);

    text.text = 'changed';
    beginRenderCost();
    text.updateText(true);
    expect(text.dirty).toBe(false);
    expect(readRenderCost().txtMs).toBeGreaterThanOrEqual(0);

    text.style.fontSize = 40; // a style change alone re-rasterizes: must not be swallowed by the early-out
    text.updateText(true);
    expect((text as unknown as { localStyleID: number }).localStyleID).toBe(text.style.styleID);
    text.destroy();
  });
});
