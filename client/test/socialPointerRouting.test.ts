// Pointer/wheel routing for FamilyScene and SectScene — the two `pointer.ts` modules, driven with a
// fake core.
//
// Why these get a test at all (ADR-071 4b, 2026-08-27). The 4b priority list named
// FriendsScene/FamilyScene/SectScene as a group to extract a pure layer from; the survey found there
// is none to extract — every non-render module in those three is a Core collaborator (form ① free
// functions over `core`), which is the 500-line split axis, not the purity axis. But the survey DID
// find that `FamilyScene/pointer.ts` and `SectScene/pointer.ts` — 140 and 136 lines carrying the
// tap-vs-drag routing, the modal interception order and the per-column scroll clamp for two whole
// scenes — had NO direct test of any kind. `test/ui/socialScrollTranslate.ui.ts` is the nearest
// thing and it drives FriendsScene, whose pointer code is a different file with a different shape.
// So these two are gated per-file, exactly the way worldmap's WorldMapRenderer/viewport.ts is: a
// renderer/Core collaborator whose arithmetic is testable with a fake ctx, NOT pure logic.
//
// Both modules read and write `core` only, so a plain object literal is a complete stand-in. The
// gesture is the REAL ScrollTapGesture (it is already PIXI-free and gated) — faking it would make
// most of these assertions vacuous, since the tap-vs-drag decision lives inside it.
import { describe, it, expect, vi } from 'vitest';
import { ScrollTapGesture, DRAG_THRESHOLD } from '../src/ui/scrollTapGesture';
import * as familyPointer from '../src/scenes/FamilyScene/pointer';
import * as sectPointer from '../src/scenes/SectScene/pointer';
import type { FamilySceneCore } from '../src/scenes/FamilyScene/core';
import type { SectSceneCore } from '../src/scenes/SectScene/core';

interface Hit { rect: { x: number; y: number; w: number; h: number }; action: () => void; scroll?: string }

/**
 * The fields the two pointer modules touch, and nothing else. `listCol` names the roster column,
 * which is the one place the two scenes genuinely differ in vocabulary: FamilyScene calls it
 * `members`, SectScene calls it `families`, and each has its own `<col>Max`/`<col>RegionTop/Bottom`.
 */
function makeCore(listCol: 'members' | 'families', over: Record<string, unknown> = {}) {
  const core: Record<string, unknown> = {
    mode: listCol === 'members' ? 'myFamily' : 'mySect',
    landscape: true,
    activeTab: listCol,
    chatColX: 1000,
    modalOpen: false,
    gesture: new ScrollTapGesture(),
    dragCol: listCol,
    scrollDirtyCol: null,
    scrollY: 0,
    scrollYChannel: 0,
    modalScrollY: 0,
    modalMax: 500,
    modalRegionTop: 100,
    modalRegionBottom: 800,
    channelMax: 400,
    channelStick: false,
    channelRegionTop: 100,
    channelRegionBottom: 800,
    hitRects: [] as Hit[],
    modalHits: [] as Hit[],
    repaint: { appliedDelta: () => 0 },
    // FamilyScene guards on this in three handlers; SectScene has no profile popup at all, so its
    // module never reads it and leaving it here is harmless for the Sect cases.
    profilePopup: { isOpen: false, handleTap: vi.fn() },
    [`${listCol}Max`]: 300,
    [`${listCol}RegionTop`]: 100,
    [`${listCol}RegionBottom`]: 800,
    ...over,
  };
  return core;
}
const asFamily = (c: Record<string, unknown>) => c as unknown as FamilySceneCore;
const asSect = (c: Record<string, unknown>) => c as unknown as SectSceneCore;

/** Drive a full press → drag → release. `dy` is finger travel (negative = finger up = scroll down). */
function drag(mod: { onPointerDown: (c: never, x: number, y: number) => void; onPointerMove: (c: never, y: number) => void; onPointerUp: (c: never, x: number, y: number) => void }, core: Record<string, unknown>, x: number, fromY: number, dy: number) {
  mod.onPointerDown(core as never, x, fromY);
  mod.onPointerMove(core as never, fromY + dy);
  mod.onPointerUp(core as never, x, fromY + dy);
}

describe('scrollColAt — which column a pointer at x scrolls', () => {
  it('landscape routes by the divider (chatColX), for both scenes', () => {
    const fam = makeCore('members', { landscape: true, chatColX: 1000 });
    expect(familyPointer.scrollColAt(asFamily(fam), 999)).toBe('members');
    expect(familyPointer.scrollColAt(asFamily(fam), 1000)).toBe('channel'); // >= is the boundary
    const sect = makeCore('families', { landscape: true, chatColX: 1000 });
    expect(sectPointer.scrollColAt(asSect(sect), 999)).toBe('families');
    expect(sectPointer.scrollColAt(asSect(sect), 1000)).toBe('channel');
  });

  it('portrait ignores x entirely and follows the active tab', () => {
    // The x passed here is deliberately on the far side of chatColX: in portrait there is no divider,
    // so a routing bug that kept using it would show up as the wrong column at this x.
    const fam = makeCore('members', { landscape: false, activeTab: 'channel' });
    expect(familyPointer.scrollColAt(asFamily(fam), 5)).toBe('channel');
    expect(familyPointer.scrollColAt(asFamily(fam), 1900)).toBe('channel');
    const sect = makeCore('families', { landscape: false, activeTab: 'channel' });
    expect(sectPointer.scrollColAt(asSect(sect), 5)).toBe('channel');
  });

  it('falls back to the roster column outside the my-org mode, in either orientation', () => {
    for (const landscape of [true, false]) {
      const fam = makeCore('members', { mode: 'browse', landscape, activeTab: 'channel' });
      expect(familyPointer.scrollColAt(asFamily(fam), 1900)).toBe('members');
      const sect = makeCore('families', { mode: 'browse', landscape, activeTab: 'channel' });
      expect(sectPointer.scrollColAt(asSect(sect), 1900)).toBe('families');
    }
  });
});

describe('scrollKeyFor — the Family/Sect divergence, which is deliberate on both sides', () => {
  // Each module's doc comment claims the other behaves differently. That is a cross-file prose claim
  // of exactly the kind that was silently FALSE in CardScene/logic/types.ts (see
  // cardSceneCellGeometry.test.ts), so both halves are pinned here rather than trusted.
  it('FamilyScene maps the channel to scrollYChannel in BOTH orientations', () => {
    for (const landscape of [true, false]) {
      const fam = makeCore('members', { landscape });
      expect(familyPointer.scrollKeyFor(asFamily(fam), 'channel')).toBe('scrollYChannel');
      expect(familyPointer.scrollKeyFor(asFamily(fam), 'members')).toBe('scrollY');
      expect(familyPointer.scrollKeyFor(asFamily(fam), 'modal')).toBe('modalScrollY');
    }
  });

  it('SectScene maps the channel to scrollYChannel only in LANDSCAPE; portrait shares scrollY', () => {
    const land = makeCore('families', { landscape: true });
    expect(sectPointer.scrollKeyFor(asSect(land), 'channel')).toBe('scrollYChannel');
    const port = makeCore('families', { landscape: false });
    expect(sectPointer.scrollKeyFor(asSect(port), 'channel')).toBe('scrollY');
    expect(sectPointer.scrollKeyFor(asSect(port), 'families')).toBe('scrollY');
    expect(sectPointer.scrollKeyFor(asSect(port), 'modal')).toBe('modalScrollY');
  });
});

describe('modal interception order — the dim-to-close rect must LOSE to buttons drawn on it', () => {
  // The bug both files carry a comment about: the full-screen dim rect is always pushed FIRST, so
  // iterating in push order made it win over every control drawn on top and every click "did nothing"
  // except close the modal. Both scan modalHits in reverse for that reason.
  for (const [name, mod, listCol] of [['FamilyScene', familyPointer, 'members'], ['SectScene', sectPointer, 'families']] as const) {
    it(`${name} fires the LAST matching modal hit, not the first`, () => {
      const dimClose = vi.fn();
      const approve = vi.fn();
      const core = makeCore(listCol, {
        modalOpen: true,
        modalHits: [
          { rect: { x: 0, y: 0, w: 1920, h: 1080 }, action: dimClose },   // pushed first, on the bottom
          { rect: { x: 400, y: 400, w: 200, h: 60 }, action: approve },   // drawn on top
        ],
      });
      // A tap (no drag) inside the approve button, which also lies inside the dim rect.
      mod.onPointerDown(core as never, 450, 420);
      mod.onPointerUp(core as never, 450, 420);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(dimClose).not.toHaveBeenCalled();
    });

    it(`${name} still closes on a tap that hits ONLY the dim rect`, () => {
      const dimClose = vi.fn();
      const approve = vi.fn();
      const core = makeCore(listCol, {
        modalOpen: true,
        modalHits: [
          { rect: { x: 0, y: 0, w: 1920, h: 1080 }, action: dimClose },
          { rect: { x: 400, y: 400, w: 200, h: 60 }, action: approve },
        ],
      });
      mod.onPointerDown(core as never, 50, 50);
      mod.onPointerUp(core as never, 50, 50);
      expect(dimClose).toHaveBeenCalledTimes(1);
      expect(approve).not.toHaveBeenCalled();
    });

    it(`${name} drops a modal tap that turned into a drag`, () => {
      const approve = vi.fn();
      const core = makeCore(listCol, {
        modalOpen: true,
        modalHits: [{ rect: { x: 400, y: 400, w: 200, h: 60 }, action: approve }],
      });
      drag(mod, core, 450, 420, -(DRAG_THRESHOLD + 20));
      expect(approve).not.toHaveBeenCalled();
      expect(core.dragCol).toBe('modal');
    });
  }
});

describe('overscan rows: a hit rect no longer implies "on screen"', () => {
  // Rows are built one viewport beyond the region in each direction, so both files re-check the
  // column viewport for any rect tagged `scroll`. Without that, a tap in the header or the bottom nav
  // could fire the action of a row built just off-screen.
  for (const [name, mod, listCol] of [['FamilyScene', familyPointer, 'members'], ['SectScene', sectPointer, 'families']] as const) {
    it(`${name} ignores a scroll-tagged hit whose y is outside the column viewport`, () => {
      const action = vi.fn();
      const core = makeCore(listCol, {
        // Region is 100..800; this row sits at y=850, i.e. built into the overscan below it.
        hitRects: [{ rect: { x: 0, y: 840, w: 500, h: 60 }, action, scroll: listCol }],
      });
      mod.onPointerDown(core as never, 100, 850);
      mod.onPointerUp(core as never, 100, 850);
      expect(action).not.toHaveBeenCalled();
    });

    it(`${name} fires an UNTAGGED hit at the same y — the viewport check is scroll-only`, () => {
      // Chrome (nav bar, header buttons) is drawn outside the scroll layers and must stay tappable
      // there; tagging is what distinguishes the two.
      const action = vi.fn();
      const core = makeCore(listCol, {
        hitRects: [{ rect: { x: 0, y: 840, w: 500, h: 60 }, action }],
      });
      mod.onPointerDown(core as never, 100, 850);
      mod.onPointerUp(core as never, 100, 850);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it(`${name} applies the same viewport check to the CHANNEL column, with its own bounds`, () => {
      // inViewport has a branch per column, and the roster cases above only exercise the roster one.
      // Not a coverage formality: the channel is the column that actually overscans hardest (chat rows
      // are short, so a viewport's worth of them is a lot of rows), and its bounds differ from the
      // roster's in the landscape split view.
      const action = vi.fn();
      const core = makeCore(listCol, {
        channelRegionTop: 200,
        channelRegionBottom: 600,
        // x spans the channel column, which lives RIGHT of chatColX (1000) in the landscape split —
        // a rect at x 0..500 would miss on x and make this pass for the wrong reason.
        hitRects: [{ rect: { x: 1000, y: 640, w: 500, h: 60 }, action, scroll: 'channel' }],
      });
      mod.onPointerDown(core as never, 1500, 650);           // below channelRegionBottom
      mod.onPointerUp(core as never, 1500, 650);
      expect(action).not.toHaveBeenCalled();

      const core2 = makeCore(listCol, {
        channelRegionTop: 200,
        channelRegionBottom: 600,
        hitRects: [{ rect: { x: 1000, y: 400, w: 500, h: 60 }, action, scroll: 'channel' }],
      });
      mod.onPointerDown(core2 as never, 1500, 420);          // inside it
      mod.onPointerUp(core2 as never, 1500, 420);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it(`${name} checks the MODAL viewport against the modal's own bounds`, () => {
      // The third inViewport branch: a scrollable list modal's rows overscan too.
      const inside = vi.fn();
      const outside = vi.fn();
      const core = makeCore(listCol, {
        modalOpen: true,
        modalRegionTop: 300,
        modalRegionBottom: 500,
        modalHits: [{ rect: { x: 0, y: 550, w: 500, h: 60 }, action: outside, scroll: 'modal' }],
      });
      mod.onPointerDown(core as never, 100, 560);
      mod.onPointerUp(core as never, 100, 560);
      expect(outside).not.toHaveBeenCalled();

      const core2 = makeCore(listCol, {
        modalOpen: true,
        modalRegionTop: 300,
        modalRegionBottom: 500,
        modalHits: [{ rect: { x: 0, y: 400, w: 500, h: 60 }, action: inside, scroll: 'modal' }],
      });
      mod.onPointerDown(core2 as never, 100, 420);
      mod.onPointerUp(core2 as never, 100, 420);
      expect(inside).toHaveBeenCalledTimes(1);
    });

    it(`${name} maps a scroll-tagged rect by the APPLIED delta, not by raw screen y`, () => {
      // The row was built at y=500 in build space; the layer has since been translated up by 200 by a
      // cheap scroll, so the row is physically at y=300. A tap at 300 must hit it.
      const action = vi.fn();
      const core = makeCore(listCol, {
        hitRects: [{ rect: { x: 0, y: 500, w: 500, h: 60 }, action, scroll: listCol }],
        repaint: { appliedDelta: () => 200 },
      });
      mod.onPointerDown(core as never, 100, 300);
      mod.onPointerUp(core as never, 100, 300);
      expect(action).toHaveBeenCalledTimes(1);
    });
  }
});

describe('onPointerMove — the drag clamp, and where each half of it lives', () => {
  for (const [name, mod, listCol] of [['FamilyScene', familyPointer, 'members'], ['SectScene', sectPointer, 'families']] as const) {
    it(`${name} clamps an over-drag to the column max instead of scrolling into blank space`, () => {
      // The 2026-08-25 bug both files document: the cheap-scroll path translates whatever the scroll
      // field says, and the full render that used to re-clamp it no longer happens.
      const core = makeCore(listCol, { dragCol: listCol });
      mod.onPointerDown(core as never, 100, 700);
      mod.onPointerMove(core as never, 700 - 5000);       // drag far past the end
      expect(core.scrollY).toBe(300);                      // = <listCol>Max
      expect(core.scrollDirtyCol).toBe(listCol);
    });

    it(`${name} relies on ScrollTapGesture for the ZERO end — pointer.ts only clamps the top`, () => {
      // Worth pinning because it is a one-sided clamp reading as a bug: `Math.min(raw, max)` with no
      // `Math.max(0, ...)`. It is safe only because ScrollTapGesture.move already returns
      // `Math.max(0, start.scroll - dy)`. If that lower clamp ever moves out of the gesture, these
      // two files silently start scrolling to a negative offset — which parks the list below its own
      // region and leaves it there, the same shape as the over-drag bug above.
      const core = makeCore(listCol, { dragCol: listCol, scrollY: 10 });
      mod.onPointerDown(core as never, 100, 100);
      mod.onPointerMove(core as never, 100 + 5000);        // drag far past the top
      expect(core.scrollY).toBe(0);
      expect(core.scrollY).toBeGreaterThanOrEqual(0);
    });

    it(`${name} does nothing at all while the gesture is still a tap`, () => {
      const core = makeCore(listCol, { dragCol: listCol });
      mod.onPointerDown(core as never, 100, 700);
      mod.onPointerMove(core as never, 700 - (DRAG_THRESHOLD - 1)); // under the threshold
      expect(core.scrollY).toBe(0);
      expect(core.scrollDirtyCol).toBe(null);
    });
  }
});

describe('channelStick — dragging to the bottom re-pins, scrolling up releases', () => {
  // The "channel jumps while I am reading" complaint. channelMax is 400, so the pin engages from 399.
  for (const [name, mod, listCol] of [['FamilyScene', familyPointer, 'members'], ['SectScene', sectPointer, 'families']] as const) {
    it(`${name} pins when a drag lands at the bottom`, () => {
      const core = makeCore(listCol, { dragCol: 'channel', channelStick: false });
      mod.onPointerDown(core as never, 1500, 700);
      mod.onPointerMove(core as never, 700 - 5000);
      expect(core.channelStick).toBe(true);
    });

    it(`${name} releases the pin as soon as the reader scrolls up off the bottom`, () => {
      const core = makeCore(listCol, { dragCol: 'channel', channelStick: true, scrollYChannel: 400, scrollY: 400 });
      mod.onPointerDown(core as never, 1500, 100);
      mod.onPointerMove(core as never, 100 + 100);   // finger down = scroll up 100
      expect(core.channelStick).toBe(false);
    });

    it(`${name} leaves channelStick alone when the dragged column is the roster`, () => {
      const core = makeCore(listCol, { dragCol: listCol, channelStick: true });
      mod.onPointerDown(core as never, 100, 700);
      mod.onPointerMove(core as never, 700 - 5000);
      expect(core.channelStick).toBe(true);
    });
  }
});

describe('onWheel', () => {
  for (const [name, mod, listCol] of [['FamilyScene', familyPointer, 'members'], ['SectScene', sectPointer, 'families']] as const) {
    it(`${name} scrolls the open modal and nothing else`, () => {
      const core = makeCore(listCol, { modalOpen: true });
      mod.onWheel(core as never, 100, 400, 120);
      expect(core.modalScrollY).toBeGreaterThan(0);
      expect(core.scrollDirtyCol).toBe('modal');
      expect(core.scrollY).toBe(0);
    });

    it(`${name} ignores a wheel event outside the modal's own viewport`, () => {
      // wheelScrollY's region check is what enforces this; modalRegion is 100..800.
      const core = makeCore(listCol, { modalOpen: true });
      mod.onWheel(core as never, 100, 900, 120);
      expect(core.modalScrollY).toBe(0);
      expect(core.scrollDirtyCol).toBe(null);
    });

    it(`${name} routes a landscape wheel to the column under the pointer`, () => {
      const core = makeCore(listCol, { landscape: true, chatColX: 1000 });
      mod.onWheel(core as never, 1500, 400, 120);        // right of the divider = channel
      expect(core.scrollDirtyCol).toBe('channel');
      const core2 = makeCore(listCol, { landscape: true, chatColX: 1000 });
      mod.onWheel(core2 as never, 200, 400, 120);        // left = roster
      expect(core2.scrollDirtyCol).toBe(listCol);
    });

    it(`${name} clamps the wheel to the column's own max, not the other column's`, () => {
      // channelMax 400 vs roster max 300 — a wheel over the roster must not be allowed past 300.
      const core = makeCore(listCol, { landscape: true, chatColX: 1000 });
      for (let i = 0; i < 200; i++) mod.onWheel(core as never, 200, 400, 120);
      expect(core.scrollY).toBe(300);
    });

    it(`${name} does nothing outside the my-org mode`, () => {
      const core = makeCore(listCol, { mode: 'browse' });
      mod.onWheel(core as never, 200, 400, 120);
      expect(core.scrollY).toBe(0);
      expect(core.scrollDirtyCol).toBe(null);
    });
  }
});

describe('FamilyScene only: the profile popup swallows pointer input', () => {
  // SectScene has no ProfilePopup at all (grep confirms: no field, no import), which is why its
  // pointer.ts has none of these three guards. That asymmetry is correct, not a missing guard.
  it('pointer-down while the popup is open arms no gesture, so no page hit can fire', () => {
    const action = vi.fn();
    const core = makeCore('members', {
      profilePopup: { isOpen: true, handleTap: vi.fn() },
      hitRects: [{ rect: { x: 0, y: 0, w: 1920, h: 1080 }, action }],
    });
    familyPointer.onPointerDown(asFamily(core), 100, 400);
    expect((core.gesture as ScrollTapGesture).active).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('pointer-up while the popup is open goes to the popup\'s own hit test', () => {
    const handleTap = vi.fn();
    const core = makeCore('members', { profilePopup: { isOpen: true, handleTap } });
    familyPointer.onPointerUp(asFamily(core), 111, 222);
    expect(handleTap).toHaveBeenCalledWith(111, 222);
  });

  it('the wheel is inert while the popup is open', () => {
    const core = makeCore('members', { profilePopup: { isOpen: true, handleTap: vi.fn() } });
    familyPointer.onWheel(asFamily(core), 200, 400, 120);
    expect(core.scrollDirtyCol).toBe(null);
  });
});
