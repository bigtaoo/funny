/**
 * bakeFractionalResolution.ui.ts — a bake is never allocated smaller than it was asked for, so an
 * atlas cut out of one never overruns it (2026-09-28).
 *
 * PIXI rounds a base texture to whole device pixels, which at a fractional resolution can land up
 * to half a device pixel SHORT of the requested point size. The panel-frame atlas's last row then
 * overran its base texture and PIXI threw — at 180 of the 251 resolutions from 0.5 to 3.0,
 * including 1.1 and 1.33 (browser zoom 110% / 133%), from app boot since ADR-098's prewarm.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { bake, clearBakeCache, setBakeRenderer, setDesignScale, resetDesignScaleForTest } from '../../src/render/bake';
import { prewarmPanelFrame, resetFrameAtlas } from '../../src/render/panelFrame';
import { buildPaperBackground } from '../../src/render/sketchUi';
import { resetPaperRules } from '../../src/render/paperRules';

const RESOLUTIONS = Array.from({ length: 251 }, (_, i) => (50 + i) / 100);

function wire(resolution: number): void {
  clearBakeCache(); resetFrameAtlas(); resetPaperRules();
  setBakeRenderer({ resolution, render: () => {} } as unknown as PIXI.IRenderer);
}

afterEach(() => {
  clearBakeCache(); resetFrameAtlas(); resetPaperRules(); resetDesignScaleForTest();
  setBakeRenderer(null as unknown as PIXI.IRenderer);
});

describe('bake at a fractional resolution', () => {
  it('allocates at least the requested point size', () => {
    for (const res of RESOLUTIONS) {
      wire(res);
      const tex = bake(`t${res}`, new PIXI.Container(), 1024, 34)!;
      expect(tex.baseTexture.width, `res ${res}`).toBeGreaterThanOrEqual(1024);
      expect(tex.baseTexture.height, `res ${res}`).toBeGreaterThanOrEqual(34);
    }
  });

  it('builds the panel-frame atlas at every renderer resolution from 0.5 to 3.0', () => {
    const bad: number[] = [];
    for (const res of RESOLUTIONS) {
      wire(res);
      try { prewarmPanelFrame(); } catch { bad.push(res); }
    }
    expect(bad).toEqual([]);
  });

  it('builds the paper-rule atlas at every page resolution', () => {
    const bad: number[] = [];
    for (const scale of [0.25, 0.3, 0.37, 0.5625, 0.7, 0.8125, 1]) {
      for (const res of [1, 1.1, 1.33, 1.5, 2]) {
        wire(res);
        setDesignScale(scale);
        try { buildPaperBackground('t', 1024, 768); } catch { bad.push(res * scale); }
      }
    }
    expect(bad).toEqual([]);
  });
});
