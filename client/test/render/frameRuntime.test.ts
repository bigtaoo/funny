/**
 * frameRuntime.test.ts — the frame-sheet unit runtime (render/frames, art-direction §4.3.1).
 *
 * Pins the two things a frame swap must never get wrong: every frame texture shares one `orig`
 * box with the ground point at the same anchor (so swapping textures never moves the figure),
 * and the clip clock — loops wrap, one-shots hold their last frame, and the attack clip is
 * time-scaled to the unit's real attack interval exactly like StickmanRuntime's.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('pixi.js-legacy', () => {
  class Rectangle {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
  }
  class Texture {
    constructor(public baseTexture: unknown, public frame: Rectangle, public orig: Rectangle, public trim: Rectangle) {}
  }
  class Container {
    children: unknown[] = [];
    scale = { x: 1, y: 1, set(x: number, y: number): void { this.x = x; this.y = y; } };
    position = { x: 0, y: 0, set(x: number, y: number): void { this.x = x; this.y = y; } };
    visible = true;
    alpha = 1;
    addChild(...c: unknown[]): void { this.children.push(...c); }
    destroy(): void { /* no-op */ }
  }
  class Sprite extends Container {
    anchor = { x: 0, y: 0, set(x: number, y: number): void { this.x = x; this.y = y; } };
    tint = 0xffffff;
    width = 0;
    height = 0;
    constructor(public texture: unknown = null) { super(); }
  }
  return {
    Rectangle, Texture, Container, Sprite, BaseTexture: class {},
    MIPMAP_MODES: { ON: 1 }, SCALE_MODES: { LINEAR: 1 },
  };
});
vi.mock('../../src/render/stickman/shadow', () => ({ getShadowTexture: () => ({}) }));
vi.mock('../../src/assets/assetIO', () => ({ assetIO: () => ({}) }));

import type * as PIXI from 'pixi.js-legacy';
import { buildFrameSheet, type FrameSheetJson } from '../../src/render/frames/frameSheet';
import { FrameRuntime } from '../../src/render/frames/FrameRuntime';

type Rect = [number, number, number, number, number, number];
const frame = (ox: number, w: number): { body: Rect; line: Rect } =>
  ({ body: [0, 0, w, 100, ox, -100], line: [0, 0, w + 4, 104, ox - 2, -102] });

const JSON_: FrameSheetJson = {
  version: 1,
  height: 100,
  points: { hit: [0, -0.5] },
  shadow: [0.3, 0.1],
  clips: {
    idle:   { fps: 10, loop: true,  frames: [frame(-20, 40), frame(-22, 44)] },
    attack: { fps: 10, loop: false, frames: [frame(-20, 40), frame(-10, 60), frame(-20, 40), frame(-20, 40)] },
    death:  { fps: 10, loop: false, frames: [frame(-20, 40), frame(-90, 110)] },
  },
};

const sheet = buildFrameSheet({} as PIXI.BaseTexture, JSON_);

describe('buildFrameSheet', () => {
  it('gives every frame one orig box, with the ground point at the shared anchor', () => {
    const textures = [...sheet.clips.values()].flatMap(c => [...c.body, ...c.line]) as unknown as Array<{
      orig: { width: number; height: number }; trim: { x: number; y: number };
    }>;
    const { width, height } = textures[0]!.orig;
    for (const t of textures) expect([t.orig.width, t.orig.height]).toEqual([width, height]);
    // The ground point sits at (anchorX * width, anchorY * height) of the orig box; a frame whose
    // rect starts `ox` left of the ground must be trimmed in at anchor + ox.
    const death = sheet.clips.get('death')!.body[1] as unknown as { trim: { x: number; y: number } };
    expect(death.trim.x).toBeCloseTo(sheet.anchorX * width - 90, 0);
    expect(death.trim.y).toBeCloseTo(sheet.anchorY * height - 100, 0);
  });

  it('derives clip durations from frame count and fps', () => {
    expect(sheet.clips.get('attack')!.duration).toBeCloseTo(0.4);
  });
});

describe('FrameRuntime', () => {
  const bodyOf = (r: FrameRuntime): unknown => (r as unknown as { body: { texture: unknown } }).body.texture;

  it('holds a one-shot clip on its last frame', () => {
    const r = new FrameRuntime(sheet, { targetHeight: 50 });
    r.play('death');
    r.update(5);
    expect(bodyOf(r)).toBe(sheet.clips.get('death')!.body[1]);
  });

  it('time-scales the attack clip to the real attack interval', () => {
    const r = new FrameRuntime(sheet, { targetHeight: 50 });
    r.setAttackInterval(0.8);          // authored 0.4 s → plays at half speed
    r.syncState('attacking');
    r.update(0.2);                     // 0.1 s of clip time → frame 1
    expect(bodyOf(r)).toBe(sheet.clips.get('attack')!.body[1]);
    r.update(0.6);                     // clip done; the state still holds → swings again
    r.syncState('attacking');
    r.update(0);
    expect(bodyOf(r)).toBe(sheet.clips.get('attack')!.body[0]);
  });

  it('scales to the target height and mirrors for the top side', () => {
    const r = new FrameRuntime(sheet, { targetHeight: 50, mirrorX: true });
    expect(r.container.scale.x).toBeCloseTo(-0.5);
    expect(r.container.scale.y).toBeCloseTo(0.5);
    const hit = r.getAttachmentOffset('hit')!;
    expect(hit.x).toBeCloseTo(0);
    expect(hit.y).toBeLessThan(0);    // the torso is above the origin
  });
});
