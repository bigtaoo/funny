// spriteGeometry.ts — pure math shared by Renderer (drawing skin-mode handles) and
// InteractionController (hit-testing + drag math). Zero imports, zero PIXI, so every
// case here is a direct value assertion against hand-worked expectations rather than
// anything that needs a real Sprite/Texture.
import { describe, it, expect } from 'vitest';
import {
  rotateVec, bindingToSpriteFrame, localPixelToWorld, spriteCorners, rotationHandlePos, pointInQuad,
  computeAnchorDrag,
  type SpriteFrame,
} from '../src/rendering/spriteGeometry';

describe('rotateVec', () => {
  it('is identity at 0 radians', () => {
    expect(rotateVec(3, 4, 0)).toEqual({ x: 3, y: 4 });
  });

  it('rotates (1,0) to (0,1) at +90°', () => {
    const r = rotateVec(1, 0, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(1, 10);
  });

  it('rotating forward then backward round-trips', () => {
    const r = rotateVec(7, -3, 1.234);
    const back = rotateVec(r.x, r.y, -1.234);
    expect(back.x).toBeCloseTo(7, 10);
    expect(back.y).toBeCloseTo(-3, 10);
  });
});

describe('bindingToSpriteFrame', () => {
  it('sums pose world angle and binding rotation into rotationRad', () => {
    const f = bindingToSpriteFrame(0, 0, 30, { anchorX: 0.5, anchorY: 0.5, rotation: 15 }, 10, 10);
    expect(f.rotationRad).toBeCloseTo((45 * Math.PI) / 180, 10);
  });

  it('defaults rotation/scale to identity when absent', () => {
    const f = bindingToSpriteFrame(1, 2, 0, { anchorX: 0.5, anchorY: 0.5 }, 10, 20);
    expect(f.rotationRad).toBe(0);
    expect(f.scaleX).toBe(1);
    expect(f.scaleY).toBe(1);
    expect(f.pivotX).toBe(1);
    expect(f.pivotY).toBe(2);
  });

  it('flipX flips the sign of scaleX only', () => {
    const f = bindingToSpriteFrame(0, 0, 0, { anchorX: 0.5, anchorY: 0.5, scaleX: 2, scaleY: 3, flipX: true }, 10, 10);
    expect(f.scaleX).toBe(-2);
    expect(f.scaleY).toBe(3);
  });
});

describe('localPixelToWorld', () => {
  const base: SpriteFrame = {
    pivotX: 10, pivotY: 20, rotationRad: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, texW: 100, texH: 50,
  };

  it('places the anchor pixel exactly at the pivot', () => {
    const w = localPixelToWorld(base, base.anchorX * base.texW, base.anchorY * base.texH);
    expect(w.x).toBeCloseTo(10, 10);
    expect(w.y).toBeCloseTo(20, 10);
  });

  it('places the top-left pixel offset by -anchor*size when unrotated/unscaled', () => {
    const w = localPixelToWorld(base, 0, 0);
    expect(w.x).toBeCloseTo(10 - 50, 10);
    expect(w.y).toBeCloseTo(20 - 25, 10);
  });

  it('scale multiplies the offset from the anchor pixel', () => {
    const scaled: SpriteFrame = { ...base, scaleX: 2, scaleY: 0.5 };
    const w = localPixelToWorld(scaled, 100, 50); // bottom-right corner
    // unscaled local offset from anchor = (50, 25); scaled = (100, 12.5)
    expect(w.x).toBeCloseTo(10 + 100, 10);
    expect(w.y).toBeCloseTo(20 + 12.5, 10);
  });

  it('a negative scaleX (flipX) mirrors the offset', () => {
    const flipped: SpriteFrame = { ...base, scaleX: -1 };
    const w = localPixelToWorld(flipped, 100, 25); // right-mid edge
    expect(w.x).toBeCloseTo(10 - 50, 10); // mirrored to the left instead of the right
    expect(w.y).toBeCloseTo(20, 10);
  });
});

describe('spriteCorners', () => {
  it('returns an unrotated, unscaled, top-left-anchored rect in TL→TR→BR→BL order', () => {
    const f: SpriteFrame = {
      pivotX: 0, pivotY: 0, rotationRad: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, texW: 10, texH: 20,
    };
    const [tl, tr, br, bl] = spriteCorners(f);
    expect(tl).toEqual({ x: 0, y: 0 });
    expect(tr).toEqual({ x: 10, y: 0 });
    expect(br).toEqual({ x: 10, y: 20 });
    expect(bl).toEqual({ x: 0, y: 20 });
  });

  it('a centered anchor produces a rect straddling the pivot symmetrically', () => {
    const f: SpriteFrame = {
      pivotX: 5, pivotY: 5, rotationRad: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, texW: 4, texH: 4,
    };
    const [tl, , br] = spriteCorners(f);
    expect(tl).toEqual({ x: 3, y: 3 });
    expect(br).toEqual({ x: 7, y: 7 });
  });
});

describe('rotationHandlePos', () => {
  it('sits `distance` above the top-edge midpoint when unrotated', () => {
    const f: SpriteFrame = {
      pivotX: 0, pivotY: 0, rotationRad: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, texW: 10, texH: 10,
    };
    const handle = rotationHandlePos(f, 22);
    // top edge midpoint is (0, -5) for a centered 10x10 quad at the origin
    expect(handle.x).toBeCloseTo(0, 10);
    expect(handle.y).toBeCloseTo(-5 - 22, 10);
  });

  it('stays exactly `distance` from the top-edge midpoint under rotation', () => {
    const f: SpriteFrame = {
      pivotX: 3, pivotY: -4, rotationRad: 1.1, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, texW: 10, texH: 10,
    };
    const [tl, tr] = spriteCorners(f);
    const midX = (tl.x + tr.x) / 2, midY = (tl.y + tr.y) / 2;
    const handle = rotationHandlePos(f, 22);
    expect(Math.hypot(handle.x - midX, handle.y - midY)).toBeCloseTo(22, 8);
  });
});

describe('pointInQuad', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('is true for a point well inside', () => {
    expect(pointInQuad(5, 5, square)).toBe(true);
  });

  it('is false for a point well outside', () => {
    expect(pointInQuad(50, 50, square)).toBe(false);
    expect(pointInQuad(-5, 5, square)).toBe(false);
  });

  it('handles the reversed winding order flipX can produce', () => {
    const reversed = [...square].reverse();
    expect(pointInQuad(5, 5, reversed)).toBe(true);
    expect(pointInQuad(50, 50, reversed)).toBe(false);
  });
});

describe('computeAnchorDrag', () => {
  it('moving the mouse toward +X/+Y with no rotation decreases the anchor (image follows the cursor)', () => {
    const anchor = computeAnchorDrag(
      { x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 0,
      1, 1, 100, 50,
      30, 10,
    );
    // unrotated, unscaled: delta (30,10) in texture-pixel units = (30/100, 10/50) of anchor,
    // subtracted (dragging the image toward the cursor moves the anchor the OTHER way).
    expect(anchor.x).toBeCloseTo(0.5 - 0.3, 10);
    expect(anchor.y).toBeCloseTo(0.5 - 0.2, 10);
  });

  it('reproduces the exact Spine rig numbers hand-verified live in Chrome (2026-08-29) — a real regression guard', () => {
    // Spine's rest world angle is -90° (RAW_DEFS), binding.rotation was 0 at drag
    // start, so rotationRad = -π/2 — NOT 0. This is what an unrotated-looking drag
    // (mousedown mid-canvas, no visible spin) actually drags against, and is exactly
    // the thing a naive hand-calculation forgets (see claudedocs/animator.md's
    // 2026-08-29 section: the live-verification session got this wrong the first
    // time for the same reason).
    const anchor = computeAnchorDrag(
      { x: 400, y: 480 }, { x: 0.5, y: 0.5 }, -Math.PI / 2,
      1, 1, 195, 226,
      430, 460, // dragged (+30, -20)
    );
    expect(anchor.x).toBeCloseTo(0.3974358974358977, 10);
    expect(anchor.y).toBeCloseTo(0.3672566371681416, 10);
  });

  it('a negative scaleX (flipX) flips which way the X anchor moves', () => {
    const normal  = computeAnchorDrag({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 0, 1, 1, 100, 100, 20, 0);
    const flipped = computeAnchorDrag({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 0, -1, 1, 100, 100, 20, 0);
    expect(flipped.x).toBeCloseTo(1 - normal.x, 10); // mirrored around the 0.5 center
    expect(flipped.y).toBeCloseTo(normal.y, 10);      // Y untouched by an X-only flip
  });

  it('non-uniform scale divides each axis independently', () => {
    const anchor = computeAnchorDrag(
      { x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 0,
      2, 4, 100, 100,
      20, 20,
    );
    // scaled texture-pixel delta = worldDelta / scale = (10, 5); anchor units = /100
    expect(anchor.x).toBeCloseTo(0.5 - 0.1, 10);
    expect(anchor.y).toBeCloseTo(0.5 - 0.05, 10);
  });

  it('zero mouse movement leaves the anchor unchanged', () => {
    const anchor = computeAnchorDrag({ x: 50, y: 60 }, { x: 0.3, y: 0.7 }, 1.234, 1.5, 0.8, 80, 40, 50, 60);
    expect(anchor).toEqual({ x: 0.3, y: 0.7 });
  });
});
