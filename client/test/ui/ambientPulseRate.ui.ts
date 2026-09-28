// Attention pulses on demand-painted screens step at PULSE_STEP_FPS, not at the tick rate (ADR-097).
//
// Both of these rewrote a transform field off an unquantized sine on every tick, and the render
// policy hashes those fields — so the campaign map (its next-level ring) and the daily check-in tab
// (its claimable cell) were repainted 60 times a second for as long as they sat on screen untouched.
// Same assertion shape as guideOverlay.ui.ts: distinct values over one second of frames == the
// paints the policy will see.
//
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';
import { PULSE_STEP_FPS } from '../../src/render/steppedTime';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

describe('campaign map next-level ring', () => {
  it(`changes at most ~${PULSE_STEP_FPS} times a second, and does not freeze`, () => {
    // Nothing cleared: chapter 1's first level is the playable one, so the ring exists.
    const scene = new CampaignMapScene(createLayout(1080, 1920), new InputManager(), {
      onBack() {}, onSelectLevel() {}, onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    const ring = (scene as unknown as { page: { pulse: PIXI.Graphics | null } }).page.pulse;
    expect(ring, 'the playable node has a pulse ring').not.toBeNull();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      scene.update(1 / 60);
      seen.add(`${ring!.scale.x}:${ring!.alpha}`);
    }
    // +1 for the step boundary a one-second loop can straddle. Un-quantize the phase and this is 60.
    expect(seen.size).toBeLessThanOrEqual(PULSE_STEP_FPS + 1);
    expect(seen.size).toBeGreaterThan(1);
    scene.destroy();
  });
});
