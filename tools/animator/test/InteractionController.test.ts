// InteractionController.ts's pure geometry/hit-test helpers — point-to-segment distance and
// nearest-bone-at-a-point (used to pick a bone on mousedown). Both were private class members
// with no actual dependency on controller/canvas/window state, so they're exported as free
// functions (behavior unchanged) rather than exercised through the class, whose constructor
// wires up real canvas/window listeners. `findBoneAt` is tested against the REAL rest-pose
// geometry from Skeleton.computeFK (itself pure, already used this way by computeDefaultShadowSize)
// rather than hand-rolled coordinates, so it doesn't hardcode bone-geometry constants that
// belong to Skeleton.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pointToSegmentDist, findBoneAt, findSpriteAt, findSkinHandleAt, unwrapAngleStep,
  InteractionController,
} from '../src/interaction/InteractionController';
import { RotateBoneCommand, SetLengthScaleCommand, SetBindingPropCommand } from '../src/interaction/commands';
import { Skeleton } from '../src/skeleton/Skeleton';
import {
  bindingToSpriteFrame, rotationHandlePos, localPixelToWorld, MIN_HIT_ALPHA, type AlphaMask,
} from '../src/rendering/spriteGeometry';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { CommandManager } from '../src/core/CommandManager';
import type { SpriteBinding } from '../src/core/types';

const DEG = Math.PI / 180;

describe('unwrapAngleStep', () => {
  it('returns the plain difference for a small step with no wrap', () => {
    expect(unwrapAngleStep(10 * DEG, 30 * DEG)).toBeCloseTo(20 * DEG, 10);
    expect(unwrapAngleStep(30 * DEG, 10 * DEG)).toBeCloseTo(-20 * DEG, 10);
  });

  it('unwraps a step that crosses the +180°/-180° seam forward', () => {
    // 170° -> -170° is a 20° step forward across the seam, not a 340° step back.
    expect(unwrapAngleStep(170 * DEG, -170 * DEG)).toBeCloseTo(20 * DEG, 10);
  });

  it('unwraps a step that crosses the seam backward', () => {
    expect(unwrapAngleStep(-170 * DEG, 170 * DEG)).toBeCloseTo(-20 * DEG, 10);
  });

  it('accumulates a continuous multi-turn drag without snapping back at the seam', () => {
    // Simulate a drag sweeping steadily counter-clockwise past 180° twice, sampled
    // every 10°, the way onMouseMove would. Regression for the atan2-wrap bug: the
    // old "current - drag-start" math would jump by a full turn right at each seam
    // crossing instead of keeping the sweep continuous.
    let prev = 0;
    let accumDeg = 0;
    for (let deg = 10; deg <= 720; deg += 10) {
      const wrapped = ((deg + 180) % 360) - 180; // simulate atan2's (-180°,180°] range
      accumDeg += unwrapAngleStep(prev * DEG, wrapped * DEG) / DEG;
      prev = wrapped;
    }
    expect(accumDeg).toBeCloseTo(720, 5);
  });
});

// RotateBoneCommand is where a drag's accumulated `dragAccumDeg` (see unwrapAngleStep
// above) actually gets written into a keyframe on mouseUp. It has zero PIXI/DOM
// dependency — same real-instance approach as editorProject.test.ts — so it's exercised
// directly rather than only implicitly through IO round-trip tests.
function makeAnimCtrl() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  return { animCtrl, state };
}

describe('RotateBoneCommand', () => {
  it('does nothing when there is no current clip selected', () => {
    const { animCtrl } = makeAnimCtrl();
    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 90, 0, false);
    expect(() => cmd.execute()).not.toThrow();
    expect(animCtrl.currentClip).toBeNull();
  });

  it('creates a keyframe at the given time when none exists yet, holding only the rotated bone', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 45, 0, /* hadKeyframe */ false);
    cmd.execute();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0);
    expect(kf).toBeDefined();
    expect(kf!.bones.get('spine')?.rotation).toBe(45);
  });

  it('patches only the target bone on an existing keyframe, leaving sibling bones untouched', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0, new Map([
      ['spine', { rotation: 10 }],
      ['head',  { rotation: -5 }],
    ]));

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 10, 400, 0, /* hadKeyframe */ true);
    cmd.execute();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0)!;
    expect(kf.bones.get('spine')?.rotation).toBe(400);
    expect(kf.bones.get('head')?.rotation).toBe(-5);
  });

  it('round-trips a large, unbounded rotation unchanged — no wrap/clamp on write', () => {
    // Regression guard for the drag-angle fix: a multi-turn drag can legitimately
    // accumulate past 360°, and that raw value must survive storage untouched.
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 22, 758.7, 0, false);
    cmd.execute();

    expect(animCtrl.currentClip!.keyframes[0].bones.get('spine')?.rotation).toBe(758.7);
  });

  it('undo removes the keyframe it created when there was none before', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 45, 0, /* hadKeyframe */ false);
    cmd.execute();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(1);

    cmd.undo();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
  });

  it('undo restores the previous rotation on a keyframe that already existed', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0, new Map([['spine', { rotation: 10 }]]));

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 10, 400, 0, /* hadKeyframe */ true);
    cmd.execute();
    cmd.undo();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0)!;
    expect(kf.bones.get('spine')?.rotation).toBe(10);
  });
});

describe('pointToSegmentDist', () => {
  it('is 0 for a point exactly on the segment', () => {
    expect(pointToSegmentDist(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('measures perpendicular distance to the segment interior', () => {
    expect(pointToSegmentDist(5, 3, 0, 0, 10, 0)).toBe(3);
  });

  it('clamps to the nearer endpoint when the point projects before the segment start', () => {
    expect(pointToSegmentDist(-4, 0, 0, 0, 10, 0)).toBe(4);
  });

  it('clamps to the nearer endpoint when the point projects past the segment end', () => {
    expect(pointToSegmentDist(14, 0, 0, 0, 10, 0)).toBe(4);
  });

  it('degenerates to point-to-point distance for a zero-length segment', () => {
    expect(pointToSegmentDist(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('findBoneAt', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());

  it('hits "head" when clicking exactly on the head joint', () => {
    const head = restPose.get('head')!;
    expect(findBoneAt(head.ex, head.ey, restPose)).toBe('head');
  });

  it('hits the spine when clicking its exact midpoint', () => {
    const spine = restPose.get('spine')!;
    const mx = (spine.sx + spine.ex) / 2;
    const my = (spine.sy + spine.ey) / 2;
    expect(findBoneAt(mx, my, restPose)).toBe('spine');
  });

  it('returns null far away from every bone', () => {
    expect(findBoneAt(100000, 100000, restPose)).toBeNull();
  });

  it('never returns "root" (excluded from SELECTABLE_BONES, zero-length anyway)', () => {
    const root = restPose.get('root')!;
    expect(findBoneAt(root.sx, root.sy, restPose)).not.toBe('root');
  });
});

// findSkinHandleAt: skin mode's per-bone handle hit-test (length tip / rotation knob
// for the CURRENTLY selected bone). Uses the real rest-pose geometry (same rationale
// as findBoneAt above); the rotation-handle expectation is computed via the real
// bindingToSpriteFrame/rotationHandlePos rather than a hand-derived coordinate, so
// this doesn't duplicate spriteGeometry's own math as a second, driftable copy.
describe('findSkinHandleAt', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());
  const binding: SpriteBinding = {
    anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1,
  };
  const texture = { width: 40, height: 100 };

  it('hits "length" exactly at the bone tip, regardless of preview mode', () => {
    const spine = restPose.get('spine')!;
    expect(findSkinHandleAt(spine.ex, spine.ey, 'spine', restPose, 'skeleton', undefined, undefined)).toBe('length');
    expect(findSkinHandleAt(spine.ex, spine.ey, 'spine', restPose, 'sprite', undefined, undefined)).toBe('length');
  });

  it('never hits "length" for the head (isHead, no length handle drawn)', () => {
    const head = restPose.get('head')!;
    expect(findSkinHandleAt(head.ex, head.ey, 'head', restPose, 'skeleton', undefined, undefined)).toBeNull();
  });

  it('hits "rotate" exactly at the real rotation-handle position, only in Sprite preview', () => {
    const spine = restPose.get('spine')!;
    const frame  = bindingToSpriteFrame(spine.sx, spine.sy, spine.wa, binding, texture.width, texture.height);
    const handle = rotationHandlePos(frame);

    expect(findSkinHandleAt(handle.x, handle.y, 'spine', restPose, 'sprite', binding, texture)).toBe('rotate');
    // Same point, Skeleton preview mode: the rotation knob isn't drawn/clickable there.
    expect(findSkinHandleAt(handle.x, handle.y, 'spine', restPose, 'skeleton', binding, texture)).toBeNull();
  });

  it('never hits "rotate" without a binding or a loaded texture, even in Sprite preview', () => {
    const spine = restPose.get('spine')!;
    const frame  = bindingToSpriteFrame(spine.sx, spine.sy, spine.wa, binding, texture.width, texture.height);
    const handle = rotationHandlePos(frame);

    expect(findSkinHandleAt(handle.x, handle.y, 'spine', restPose, 'sprite', undefined, texture)).toBeNull();
    expect(findSkinHandleAt(handle.x, handle.y, 'spine', restPose, 'sprite', binding, undefined)).toBeNull();
  });

  it('returns null far from every handle', () => {
    expect(findSkinHandleAt(100000, 100000, 'spine', restPose, 'sprite', binding, texture)).toBeNull();
  });

  it('returns null for a bone id absent from the world pose', () => {
    expect(findSkinHandleAt(0, 0, 'not_a_bone', restPose, 'skeleton', undefined, undefined)).toBeNull();
  });
});

// findSpriteAt: skin mode's "click the image directly" hit-test. Uses the real rest-pose
// geometry (same rationale as findBoneAt above) with hand-built bindings/textures.
describe('findSpriteAt', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());

  const binding = (zOrder: number): SpriteBinding => ({
    anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder, rotation: 0, scaleX: 1, scaleY: 1,
  });

  it('hits a bone whose sprite quad (centered anchor) covers its pivot point', () => {
    const spine = restPose.get('spine')!;
    const bindings = new Map([['spine', binding(0)]]);
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(spine.sx, spine.sy, restPose, bindings, getTexture)).toBe('spine');
  });

  it('returns null when the point is nowhere near any bound sprite', () => {
    const bindings = new Map([['spine', binding(0)]]);
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(100000, 100000, restPose, bindings, getTexture)).toBeNull();
  });

  it('skips a bone with a binding but no loaded texture', () => {
    const spine = restPose.get('spine')!;
    const bindings = new Map([['spine', binding(0)]]);
    expect(findSpriteAt(spine.sx, spine.sy, restPose, bindings, () => undefined)).toBeNull();
  });

  it('prefers the frontmost (highest zOrder) sprite when quads overlap at the same pivot', () => {
    const spine = restPose.get('spine')!;
    // Two bindings both centered on spine's own pivot (fabricated overlap — real
    // rigs never share a pivot, but the hit-test only cares about quad geometry).
    const bindings = new Map<string, SpriteBinding>([
      ['spine', binding(0)],
      ['head',  { ...binding(5), anchorX: 0.5, anchorY: 0.5 }],
    ]);
    // Force head's quad onto spine's pivot by using head's own pose is wrong for a
    // real overlap test — instead assert ordering directly via a same-pivot pair.
    const samePivot = new Map(restPose);
    samePivot.set('head', { ...spine });
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture)).toBe('head');
  });

  // The two overlap rules that make a real rig clickable. The spine's texture rectangle
  // covers both shoulders, and it outranks the arms on zOrder, so a quad-only front-first
  // test made every part under it unreachable — from the canvas AND after picking it in the
  // bone list, since selection played no part in the hit-test at all.
  describe('overlapping sprites', () => {
    // spine and head forced onto the same pivot, same texture size: a total overlap where
    // head (zOrder 5) is in front of spine (zOrder 0) everywhere.
    const spine     = restPose.get('spine')!;
    const samePivot = new Map(restPose);
    samePivot.set('head', { ...spine });
    const bindings = new Map<string, SpriteBinding>([
      ['spine', binding(0)],
      ['head',  binding(5)],
    ]);
    const getTexture = () => ({ width: 40, height: 100 });

    /** A mask that is uniformly `alpha` everywhere — 1x1 is enough, since alphaAt scales
     *  mask resolution through the texture size. */
    const uniform = (alpha: number): AlphaMask => ({ w: 1, h: 1, data: new Uint8Array([alpha]) });

    it('sees through a frontmost sprite that is transparent at the click point', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: id => (id === 'head' ? uniform(0) : uniform(255)),
      });
      expect(hit).toBe('spine');
    });

    it('still takes the frontmost sprite where its pixels are actually painted', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: () => uniform(255),
      });
      expect(hit).toBe('head');
    });

    it('treats near-zero alpha (anti-aliasing halo) as transparent', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: id => (id === 'head' ? uniform(MIN_HIT_ALPHA - 1) : uniform(255)),
      });
      expect(hit).toBe('spine');
    });

    it('returns null when every sprite covering the point is transparent there', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: () => uniform(0),
      });
      expect(hit).toBeNull();
    });

    it('falls back to the plain quad for a sprite whose mask is missing', () => {
      // head's mask hasn't been built (or failed to decode) — it keeps its old
      // quad-shaped, zOrder-ranked behaviour rather than becoming unclickable.
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: id => (id === 'head' ? undefined : uniform(255)),
      });
      expect(hit).toBe('head');
    });

    it('keeps the already-selected bone when the click also lands on a frontmost one', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: () => uniform(255),
        preferBone:   'spine',
      });
      expect(hit).toBe('spine');
    });

    it('does NOT keep the selected bone where the click misses its painted pixels', () => {
      // Sticky selection is a tie-break between sprites the click actually hits, not a
      // lock: clicking a part the selected bone doesn't cover must still move on.
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: id => (id === 'spine' ? uniform(0) : uniform(255)),
        preferBone:   'spine',
      });
      expect(hit).toBe('head');
    });

    it('ignores a preferBone that no sprite under the point belongs to', () => {
      const hit = findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture, {
        getAlphaMask: () => uniform(255),
        preferBone:   'r_lower_leg',
      });
      expect(hit).toBe('head');
    });

    it('samples the mask at the clicked pixel, not just per-sprite', () => {
      // 2x1 mask on head: left half transparent, right half solid. Clicking left of the
      // pivot falls through to spine; clicking right of it stays on head.
      const halfMask: AlphaMask = { w: 2, h: 1, data: new Uint8Array([0, 255]) };
      const opts = { getAlphaMask: (id: string) => (id === 'head' ? halfMask : uniform(255)) };
      // The two probe points are derived through the sprite's own frame rather than
      // written as pivot±10: the sprite inherits the bone's world angle, so texture-left
      // is not world-left.
      const frame = bindingToSpriteFrame(spine.sx, spine.sy, spine.wa, binding(5), 40, 100);
      const inTransparentHalf = localPixelToWorld(frame, 10, 50);
      const inPaintedHalf     = localPixelToWorld(frame, 30, 50);
      expect(findSpriteAt(inTransparentHalf.x, inTransparentHalf.y, samePivot, bindings, getTexture, opts)).toBe('spine');
      expect(findSpriteAt(inPaintedHalf.x,     inPaintedHalf.y,     samePivot, bindings, getTexture, opts)).toBe('head');
    });
  });
});

describe('SetLengthScaleCommand', () => {
  it('execute sets the new scale, undo restores the old one', () => {
    const bus   = new EventBus<AppEvents>();
    const state = new AppState(bus);
    state.setLengthScale('spine', 1.5);

    const cmd = new SetLengthScaleCommand(state, 'spine', 1.5, 2.0);
    cmd.execute();
    expect(state.getLengthScale('spine')).toBe(2.0);

    cmd.undo();
    expect(state.getLengthScale('spine')).toBe(1.5);
  });
});

describe('SetBindingPropCommand', () => {
  function makeBoundState() {
    const bus = new EventBus<AppEvents>();
    const state = new AppState(bus);
    state.setBinding('spine', {
      anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1,
    });
    return state;
  }

  it('execute/undo round-trip a single prop without touching the rest of the binding', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(state, 'spine', { rotation: 0 }, { rotation: 30 });
    cmd.execute();
    expect(state.getBinding('spine')?.rotation).toBe(30);
    expect(state.getBinding('spine')?.anchorX).toBe(0.5);   // untouched

    cmd.undo();
    expect(state.getBinding('spine')?.rotation).toBe(0);
  });

  it('round-trips a multi-prop change (anchorX + anchorY together)', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(
      state, 'spine',
      { anchorX: 0.5, anchorY: 0.5 },
      { anchorX: 0.8, anchorY: 0.2 },
    );
    cmd.execute();
    expect(state.getBinding('spine')?.anchorX).toBe(0.8);
    expect(state.getBinding('spine')?.anchorY).toBe(0.2);

    cmd.undo();
    expect(state.getBinding('spine')?.anchorX).toBe(0.5);
    expect(state.getBinding('spine')?.anchorY).toBe(0.5);
  });

  it('is a no-op when the binding has since been removed', () => {
    const state = makeBoundState();
    state.removeBinding('spine');
    const cmd = new SetBindingPropCommand(state, 'spine', { rotation: 0 }, { rotation: 30 });
    expect(() => cmd.execute()).not.toThrow();
    expect(state.getBinding('spine')).toBeUndefined();
  });

  it('defaults its label to the bone label when none is given', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(state, 'spine', {}, {});
    expect(cmd.label).toContain('Spine');
  });
});

// ── The class itself, driven through its real mousedown handler ───────────────────────────
//
// Everything above tests the hit-test as a free function. That leaves one thing untested and
// it is precisely where this feature can break silently: the WIRING in `onMouseDown` — whether
// the alpha masks and the current selection are actually handed to `findSpriteAt`. Drop either
// argument and every pure test above still passes while the editor goes back to picking the
// spine every time. So this block builds the real controller and calls the real handler.
//
// Only the two PIXI-backed collaborators get stand-ins (Renderer, ImageController — the same
// surface this package has no headless harness for); AppState / AnimationController /
// CommandManager / EventBus are the real classes.
describe('InteractionController skin-mode click wiring', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());

  const binding = (zOrder: number): SpriteBinding => ({
    anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder, rotation: 0, scaleX: 1, scaleY: 1,
  });
  const uniform = (alpha: number): AlphaMask => ({ w: 1, h: 1, data: new Uint8Array([alpha]) });

  /** Build the controller over fake canvas/window listeners and return the handlers it
   *  registered, so a test can invoke `mousedown` the way the browser would. Stage coords are
   *  passed through 1:1, so a test can hand the handler stage-space numbers directly. */
  function makeController(masks: Record<string, AlphaMask | undefined>) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const canvas = { addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; } };
    vi.stubGlobal('window', { addEventListener: () => {} });

    const bus       = new EventBus<AppEvents>();
    const state     = new AppState(bus);
    const animCtrl  = new AnimationController(bus, state);
    const cmdManager = new CommandManager(bus);

    const renderer = {
      pixiApp:       { view: canvas },
      toStageCoords: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
    };
    // A 400x400 texture on every slot: head's quad then reaches well past its own pivot and
    // covers spine's, while head (zOrder 5) is drawn in front of spine (zOrder 0) — the shape
    // the real rig has, where spine.png's rectangle swallows the bones beside it.
    const imageCtrl = {
      getTexture:   (id: string) => (id in masks ? { width: 400, height: 400 } : undefined),
      getAlphaMask: (id: string) => masks[id],
    };

    const spine = restPose.get('spine')!;
    state.setRootPos(0, 0);
    state.setBinding('spine', binding(0));
    state.setBinding('head',  binding(5));
    state.setEditorMode('skin');
    state.setPreviewMode('sprite');

    // The two casts are the PIXI-backed collaborators: the fakes above implement exactly the
    // members onMouseDown reaches for, which the real types can't express structurally.
    new InteractionController(renderer as any, bus, state, animCtrl, cmdManager, imageCtrl as any);

    const click = (x: number, y: number) => handlers.mousedown({ button: 0, clientX: x, clientY: y });
    return { state, cmdManager, handlers, click, at: { x: spine.sx, y: spine.sy } };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the alpha masks through, so a transparent front sprite is clicked past', () => {
    const c = makeController({ head: uniform(0), spine: uniform(255) });
    c.state.setSelectedBone(null);
    c.click(c.at.x, c.at.y);
    expect(c.state.selectedBone).toBe('spine');
  });

  it('still selects the frontmost sprite where its pixels are painted', () => {
    const c = makeController({ head: uniform(255), spine: uniform(255) });
    c.state.setSelectedBone(null);
    c.click(c.at.x, c.at.y);
    expect(c.state.selectedBone).toBe('head');
  });

  it('passes the current selection through, so a click on it does not jump to the front sprite', () => {
    const c = makeController({ head: uniform(255), spine: uniform(255) });
    c.state.setSelectedBone('spine');
    c.click(c.at.x, c.at.y);
    expect(c.state.selectedBone).toBe('spine');
  });

  it('arms the anchor drag on the bone it actually selected, not on the frontmost one', () => {
    // The selection and the drag target must not disagree: dragging after a sticky click has
    // to move the selected bone's image, or the click looks right and the drag edits the
    // wrong sprite.
    const c = makeController({ head: uniform(255), spine: uniform(255) });
    c.state.setSelectedBone('spine');
    c.click(c.at.x, c.at.y);
    c.handlers.mousemove({ clientX: c.at.x + 20, clientY: c.at.y });
    c.handlers.mouseup({});
    expect(c.state.selectedBone).toBe('spine');
    // Which anchor axis moves depends on the bone's world angle (spine rests pointing up, so a
    // horizontal drag lands on anchorY) — assert the anchor moved at all, not a chosen axis.
    const spineB = c.state.getBinding('spine')!;
    const headB  = c.state.getBinding('head')!;
    expect(Math.hypot(spineB.anchorX - 0.5, spineB.anchorY - 0.5)).toBeGreaterThan(0);
    expect([headB.anchorX, headB.anchorY]).toEqual([0.5, 0.5]);
    expect(c.cmdManager.undoLabel).toContain('Spine');
  });

  it('leaves the sprite path alone in Skeleton preview, falling back to bone-segment picking', () => {
    // The sprites aren't on screen in Skeleton preview, so the click must go through the bone
    // SEGMENTS instead — and the two paths genuinely disagree at this point, which is what
    // makes the assertion mean something: by sprite it is 'head', by segment it is not.
    const c = makeController({ head: uniform(255), spine: uniform(255) });
    c.state.setPreviewMode('skeleton');
    c.state.setSelectedBone(null);
    c.click(c.at.x, c.at.y);
    const bySegment = findBoneAt(c.at.x, c.at.y, Skeleton.computeFK(0, 0, new Map()));
    expect(bySegment).not.toBe('head');
    expect(c.state.selectedBone).toBe(bySegment);
  });

  it('clears the selection when the click lands on nothing at all', () => {
    const c = makeController({ head: uniform(255), spine: uniform(255) });
    c.state.setSelectedBone('spine');
    c.click(100000, 100000);
    expect(c.state.selectedBone).toBeNull();
  });
});
