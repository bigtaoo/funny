/**
 * stickmanAttackScaling.test.ts — regression guard for the attack-animation /
 * real-attack-cadence mismatch (2026-07-19): the 'attack' clip used to loop at
 * its own fixed authored duration regardless of how often the unit actually
 * dealt damage, so a slow attacker (e.g. a 1.4 s attack interval) kept
 * swinging every 0.6 s with no hit to show for most of the swings.
 *
 * Fix: StickmanRuntime.setAttackInterval(seconds) time-scales the 'attack'
 * clip's playback rate so one full playthrough always takes exactly the
 * unit's real attack interval, however long or short the authored clip is.
 * Other clips (walk/idle/death) are left at their natural pace.
 *
 * Run with: npm run test:render
 */

import { describe, it, expect, vi } from 'vitest';

// ── Minimal PIXI stub — StickmanRuntime only needs Container/Sprite/Graphics
// constructed and no-op methods called on them for this test (no textures are
// ever bound, so the sprite-per-bone loop never runs). ───────────────────────
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    removeChild(c: unknown): void { this.children = this.children.filter(x => x !== c); }
    destroy(): void { /* no-op */ }
    position = { x: 0, y: 0, set(_x: number, _y: number): void {} };
    scale     = { x: 1, y: 1, set(_x: number, _y: number): void {} };
    visible   = true;
    alpha     = 1;
    rotation  = 0;
    zIndex    = 0;
  }
  class FakeSprite extends FakeContainer {
    texture: unknown = null;
    anchor = { set(): void {} };
    tint = 0xffffff;
    parent: FakeContainer | null = null;
    constructor(_tex?: unknown) { super(); }
  }
  class FakeGraphics extends FakeContainer {
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this   { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this  { return this; }
    drawRect(): this    { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    arc(): this    { return this; }
    closePath(): this { return this; }
    clear(): this     { return this; }
    generateCanvasTexture(): unknown { return {}; }
  }
  return {
    Container: FakeContainer,
    Sprite:    FakeSprite,
    Graphics:  FakeGraphics,
    Texture:   class { static from(_s: unknown): unknown { return {}; } },
    Rectangle: class { constructor(_x = 0, _y = 0, _w = 0, _h = 0) {} },
    BaseTexture: class {},
    Spritesheet: class {},
    Ticker: class { static shared = { add(): void {}, remove(): void {} }; },
    settings: { ADAPTER: {} },
    LINE_CAP:  { ROUND: 'round', SQUARE: 'square', BUTT: 'butt' },
    LINE_JOIN: { ROUND: 'round', MITER: 'miter', BEVEL: 'bevel' },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
    WRAP_MODES: { CLAMP: 0 },
  };
});

import { StickmanRuntime } from '../../src/render/stickman/StickmanRuntime';
import type { TaoAsset } from '../../src/render/stickman/StickmanRuntime';
import type { AnimationClip } from '../../src/render/stickman/types';

function clip(duration: number, loop: boolean): AnimationClip {
  return { duration, loop, keyframes: [{ time: 0, bones: new Map() }] };
}

/** A bare TaoAsset with no textures/bones — only the clips under test matter. */
function fakeAsset(clips: Record<string, AnimationClip>): TaoAsset {
  return {
    clips:            new Map(Object.entries(clips)),
    textures:         new Map(),
    bindings:         new Map(),
    boneLengthScales: new Map(),
    attachmentPoints: new Map(),
    outlineTextures:  new Map(),
    outlineAnchors:   new Map(),
    naturalHeight:    100,
  };
}

const ATTACK_DUR = 0.6; // authored clip duration, independent of any unit's real attack interval

describe('StickmanRuntime — attack clip time-scaled to real attack interval', () => {
  it('a 1 s attack interval stretches the 0.6 s clip to finish exactly at t=1 s', () => {
    const runtime = new StickmanRuntime(fakeAsset({
      idle:   clip(0.4, true),
      attack: clip(ATTACK_DUR, false),
    }));
    runtime.setAttackInterval(1.0);
    runtime.syncState('attacking'); // switches to 'attack', time = 0

    runtime.update(1.0); // exactly one real attack interval of wall-clock time
    expect(runtime.currentTime).toBeCloseTo(ATTACK_DUR, 5); // clip finished, not overshot

    // Continuing to attack loops the swing — and it should take another full
    // real-time second, i.e. restart to 0 only once the interval has elapsed.
    runtime.syncState('attacking');
    expect(runtime.currentTime).toBe(0);
  });

  it('mid-swing progress matches elapsed-time fraction of the real interval, not the clip', () => {
    const runtime = new StickmanRuntime(fakeAsset({
      idle:   clip(0.4, true),
      attack: clip(ATTACK_DUR, false),
    }));
    runtime.setAttackInterval(2.0); // slower than the authored clip
    runtime.syncState('attacking');

    runtime.update(1.0); // half of the 2 s real interval
    expect(runtime.currentTime).toBeCloseTo(ATTACK_DUR / 2, 5); // half the swing, not 100%
  });

  it('a faster attack interval speeds the same clip up proportionally', () => {
    const runtime = new StickmanRuntime(fakeAsset({
      idle:   clip(0.4, true),
      attack: clip(ATTACK_DUR, false),
    }));
    runtime.setAttackInterval(0.3); // faster than the authored 0.6 s clip

    runtime.syncState('attacking');
    runtime.update(0.15); // half of the 0.3 s real interval
    expect(runtime.currentTime).toBeCloseTo(ATTACK_DUR / 2, 5);
  });

  it('without setAttackInterval, the clip plays at its own authored duration (no scaling)', () => {
    const runtime = new StickmanRuntime(fakeAsset({
      idle:   clip(0.4, true),
      attack: clip(ATTACK_DUR, false),
    }));
    runtime.syncState('attacking'); // attackIntervalSec left at its 0 default

    runtime.update(ATTACK_DUR);
    expect(runtime.currentTime).toBeCloseTo(ATTACK_DUR, 5);
  });

  it('non-attack clips (e.g. walk) are never rate-scaled even with an attack interval set', () => {
    const WALK_DUR = 0.5;
    const runtime = new StickmanRuntime(fakeAsset({
      idle: clip(0.4, true),
      walk: clip(WALK_DUR, true),
    }));
    runtime.setAttackInterval(2.0); // would 3x-slow an 'attack' clip; must not affect 'walk'
    runtime.syncState('moving');    // STATE_ANIM['moving'] === 'walk'

    runtime.update(WALK_DUR); // exactly one natural loop of the walk clip
    expect(runtime.currentTime).toBeCloseTo(0, 5); // wrapped via modulo at its own duration
  });
});
