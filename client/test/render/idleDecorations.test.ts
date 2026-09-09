/**
 * idleDecorations.test.ts — the readers of `render/idleQuiet.ts`.
 *
 * `test/ui/renderPolicy.ui.ts` proves the policy raises the flag at the right moment. This proves
 * the three decorations actually consult it, which is the ADR-072 shape all over again: a flag
 * nobody reads costs nothing and saves nothing, and every test on either side stays green.
 *
 * The two things this pins beyond "it stops":
 *   1. clip TIME keeps advancing while a stickman holds its pose, so reviving snaps to where the
 *      animation should be instead of resuming in slow motion (the same call the existing
 *      `poseFps` rate cap makes);
 *   2. a figure with no `poseFps` — i.e. every battle unit — is not affected at all.
 *
 * Run with: npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same minimal PIXI stub as stickmanAttackScaling.test.ts: the runtime only needs display objects
// constructed, and no textures are ever bound, so the per-bone sprite loop never runs.
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

// Count real pose evaluations without stubbing them out: `applyPose` writing bone transforms IS the
// per-frame cost being avoided, so the assertion has to be on how often it runs.
const poseCalls = { n: 0 };
vi.mock('../../src/render/stickman/pose', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/render/stickman/pose')>();
  return {
    ...real,
    applyPose: (host: Parameters<typeof real.applyPose>[0]): void => { poseCalls.n += 1; real.applyPose(host); },
  };
});

import { StickmanRuntime } from '../../src/render/stickman/StickmanRuntime';
import type { TaoAsset } from '../../src/render/stickman/StickmanRuntime';
import type { AnimationClip } from '../../src/render/stickman/types';
import { MENU_POSE_FPS } from '../../src/render/stickman/constants';
import { decorationsQuiet, setDecorationsQuiet } from '../../src/render/idleQuiet';

function clip(duration: number, loop: boolean): AnimationClip {
  return { duration, loop, keyframes: [{ time: 0, bones: new Map() }] };
}

function fakeAsset(): TaoAsset {
  return {
    clips:            new Map<string, AnimationClip>([['idle', clip(1.0, true)]]),
    textures:         new Map(),
    bindings:         new Map(),
    boneLengthScales: new Map(),
    attachmentPoints: new Map(),
    outlineTextures:  new Map(),
    outlineAnchors:   new Map(),
    naturalHeight:    100,
  };
}

/** One second of ticks at `fps`, the way the render loop drives `update(dt)`. */
function runSecond(runtime: StickmanRuntime, fps = 60): void {
  for (let i = 0; i < fps; i++) runtime.update(1 / fps);
}

beforeEach(() => {
  poseCalls.n = 0;
  setDecorationsQuiet(false);
});

afterEach(() => {
  setDecorationsQuiet(false);
});

describe('idleQuiet', () => {
  it('defaults to off, so anything running without a render policy animates as before', () => {
    expect(decorationsQuiet()).toBe(false);
  });
});

describe('menu stickman silhouettes', () => {
  it('samples ~MENU_POSE_FPS poses a second while the screen is in use', () => {
    const runtime = new StickmanRuntime(fakeAsset(), { poseFps: MENU_POSE_FPS });
    runtime.syncState('waiting');
    poseCalls.n = 0;
    runSecond(runtime);
    // The cap is a "at least this much time since the last sample" gate, so the count lands on the
    // rate, not above it.
    expect(poseCalls.n).toBeLessThanOrEqual(MENU_POSE_FPS + 1);
    expect(poseCalls.n).toBeGreaterThanOrEqual(MENU_POSE_FPS - 2);
  });

  it('holds its pose entirely once decorations are quiet', () => {
    const runtime = new StickmanRuntime(fakeAsset(), { poseFps: MENU_POSE_FPS });
    runtime.syncState('waiting');
    setDecorationsQuiet(true);
    poseCalls.n = 0;
    runSecond(runtime);
    expect(poseCalls.n).toBe(0);
  });

  it('keeps clip time honest while held, so reviving snaps forward instead of resuming late', () => {
    const runtime = new StickmanRuntime(fakeAsset(), { poseFps: MENU_POSE_FPS });
    runtime.syncState('waiting');
    setDecorationsQuiet(true);
    runSecond(runtime);              // a full second of a 1.0s looping clip, held
    runSecond(runtime);
    // Two seconds of a 1s loop: back at the start, i.e. time advanced through both.
    expect(runtime.currentTime).toBeCloseTo(0, 3);

    // Reviving resumes at the menu rate. It is not instant: `poseAcc` was not accumulated while
    // held, so the first sample lands up to one pose interval (~83ms) later — which is the same
    // latency the rate cap has always had, not something quiescence added.
    setDecorationsQuiet(false);
    poseCalls.n = 0;
    runSecond(runtime);
    expect(poseCalls.n).toBeGreaterThanOrEqual(MENU_POSE_FPS - 2);
  });

  it('leaves a battle unit (no poseFps) alone — it must animate whether or not anyone is touching', () => {
    const runtime = new StickmanRuntime(fakeAsset());  // no poseFps: every tick samples
    runtime.syncState('waiting');
    setDecorationsQuiet(true);
    poseCalls.n = 0;
    runSecond(runtime);
    expect(poseCalls.n).toBe(60);
  });
});
