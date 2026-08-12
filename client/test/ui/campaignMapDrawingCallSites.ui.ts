// Regression coverage for the form① split of CampaignMapScene's drawing helpers into
// CampaignMapScene/drawing.ts (2026-08-12, see claudedocs/client-modules.md). drawNode/drawTrail/
// drawClearStamp/drawDecor all take an explicit `h` param that used to be an implicit `this.h`
// closure read — an easy place for a call site to silently pass the wrong value (e.g. `w` instead
// of `h`) since both are plain numbers and nothing in the type system distinguishes them.
//
// This drives the REAL scene (not the extracted functions directly) with a layout where
// w !== h, and asserts the node circle's drawn radius matches `Math.round(h * 0.032)` per
// drawNode's own contract — not `Math.round(w * 0.032)`, which is what a swapped-parameter bug
// would produce instead. Verified to bite: temporarily changing the call site's `h` argument to
// `w` (CampaignMapScene.ts's buildChapter -> drawNode call) turns this test red while every
// pre-existing CampaignMapScene test (tap detection, teardown, scenes.ui.ts) stays green — this
// gap genuinely wasn't covered before.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Portrait: designWidth/designHeight end up meaningfully different (PortraitLayout grows height),
// so a w<->h swap produces a clearly distinct, non-coincidental radius.
const [W, H] = [800, 1280];

describe('CampaignMapScene drawing call sites — correct h threaded to drawNode (form① split)', () => {
  it("draws the current-chapter's unlocked node circle at radius round(h * 0.032), not round(w * 0.032)", () => {
    const layout = createLayout(W, H);
    const expectedR = Math.round(layout.designHeight * 0.032);
    const wrongR = Math.round(layout.designWidth * 0.032);
    expect(expectedR).not.toBe(wrongR); // sanity: the two candidate values must be distinguishable

    const radii: number[] = [];
    const spy = vi.spyOn(PIXI.Graphics.prototype, 'drawCircle').mockImplementation(function (
      this: PIXI.Graphics, _x: number, _y: number, radius: number,
    ) {
      radii.push(radius);
      return this;
    });

    const scene = new CampaignMapScene(layout, new InputManager(), {
      onBack() {},
      onSelectLevel() {},
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });

    expect(radii).toContain(expectedR);
    expect(radii).not.toContain(wrongR);

    spy.mockRestore();
    scene.destroy();
  });
});
