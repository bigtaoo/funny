// Pointer/wheel routing for FriendsScene — `FriendsScene/input.ts`, driven with a fake core.
//
// The third scene of the ADR-071 4b "Friends/Family/Sect" group. socialPointerRouting.test.ts covers
// FamilyScene/pointer.ts and SectScene/pointer.ts; this is the one that was still uncovered, and it
// is NOT the same code twice — Friends does the same job with a visibly different implementation,
// which is exactly why it needs its own tests rather than a shared parametrised one:
//
//   * its own drag tracking (pointerActive / downX / downY / dragStartScroll) instead of
//     ScrollTapGesture, so a 2D `Math.hypot` threshold of DRAG_THRESHOLD = 8, not the gesture's 6
//     along the scroll axis only;
//   * modal hits fire on pointer-UP directly, with no drag-cancel — where Family/Sect route modal
//     taps through the gesture and drop them if the pointer moved;
//   * one scroll column, so `onWheel(core, y, deltaY)` takes no x;
//   * it clamps BOTH ends itself (`clamp(..., 0, maxScroll)`) rather than leaning on the gesture for
//     the zero end, which is the arrangement socialPointerRouting.test.ts pins for the other two.
//
// Those four differences are pinned below, because "make the three social scenes consistent" is a
// plausible future refactor and each of them is load-bearing where it stands.
import { describe, it, expect, vi } from 'vitest';
import { onPointerDown, onPointerMove, onPointerUp, onWheel } from '../src/scenes/FriendsScene/input';
import { DRAG_THRESHOLD } from '../src/scenes/FriendsScene/core';
import type { FriendsSceneCore } from '../src/scenes/FriendsScene/core';

interface Hit { rect: { x: number; y: number; w: number; h: number }; fn: () => void; scroll?: boolean }
interface ModalHit { rect: { x: number; y: number; w: number; h: number }; action: () => void }

/** Only the fields input.ts reads or writes. Region is 100..800, maxScroll 300, one column. */
function makeCore(over: Record<string, unknown> = {}) {
  return {
    tab: 'friends',
    popup: { isOpen: false, handleTap: vi.fn() },
    modalOpen: false,
    modalHits: [] as ModalHit[],
    hits: [] as Hit[],
    pointerActive: false,
    dragging: false,
    downX: 0,
    downY: 0,
    dragStartScroll: 0,
    scrollY: 0,
    maxScroll: 300,
    regionTop: 100,
    regionBottom: 800,
    scrollDirty: false,
    worldStick: false,
    repaint: { appliedScrollDelta: 0 },
    ...over,
  } as Record<string, unknown>;
}
const as = (c: Record<string, unknown>) => c as unknown as FriendsSceneCore;

describe('FriendsScene DRAG_THRESHOLD is a 2D distance, not a scroll-axis delta', () => {
  it('a purely HORIZONTAL move past the threshold still becomes a drag, cancelling the tap', () => {
    // `Math.hypot(x - downX, y - downY) > DRAG_THRESHOLD` — Family/Sect measure only along y (via
    // ScrollTapGesture), so a sideways swipe there stays a tap. Here it does not. Deliberate: this
    // scene's rows carry swipe-adjacent affordances, and a sideways drag should not fire a row.
    const fn = vi.fn();
    const core = makeCore({ hits: [{ rect: { x: 0, y: 200, w: 500, h: 60 }, fn }] });
    onPointerDown(as(core), 100, 220);
    onPointerMove(as(core), 100 + DRAG_THRESHOLD + 1, 220); // x only, y unchanged
    expect(core.dragging).toBe(true);
    onPointerUp(as(core), 100 + DRAG_THRESHOLD + 1, 220);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a move inside the threshold stays a tap and fires the hit', () => {
    const fn = vi.fn();
    const core = makeCore({ hits: [{ rect: { x: 0, y: 200, w: 500, h: 60 }, fn }] });
    onPointerDown(as(core), 100, 220);
    onPointerMove(as(core), 103, 222); // hypot ~3.6, under 8
    expect(core.dragging).toBe(false);
    onPointerUp(as(core), 103, 222);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the threshold is 8 here, not the ScrollTapGesture 6 the other two scenes use', () => {
    // Pinned as a value because the two numbers sitting in one feature area invites "unify these",
    // and unifying them silently changes how twitchy every Friends row feels.
    expect(DRAG_THRESHOLD).toBe(8);
  });
});

describe('FriendsScene onPointerMove — clamps both ends itself', () => {
  it('clamps an over-drag to maxScroll', () => {
    const core = makeCore();
    onPointerDown(as(core), 100, 700);
    onPointerMove(as(core), 100, 700 - 5000);
    expect(core.scrollY).toBe(300);
    expect(core.scrollDirty).toBe(true);
  });

  it('clamps at ZERO in this file rather than relying on the gesture, unlike Family/Sect', () => {
    // socialPointerRouting.test.ts pins the opposite arrangement for the other two scenes (their
    // pointer.ts only does Math.min, and ScrollTapGesture.move supplies the Math.max(0, ...)). If
    // these three are ever unified, exactly one of the two clamps must survive — not neither.
    const core = makeCore({ scrollY: 50 });
    onPointerDown(as(core), 100, 100);
    onPointerMove(as(core), 100, 100 + 5000);
    expect(core.scrollY).toBe(0);
  });

  it('does nothing at all when there is nothing to scroll', () => {
    // A short list must not latch scrollDirty on every frame of a drag. Two independent things
    // deliver that — the `core.maxScroll > 0` guard and the `next !== core.scrollY` check below it —
    // so deleting either one alone leaves this green (mutation-verified). Kept anyway: the BEHAVIOUR
    // is what matters here, and it survives whichever of the two a future edit removes. The guard is
    // a redundant early-out, not a load-bearing gate; do not read this test as pinning it.
    const core = makeCore({ maxScroll: 0 });
    onPointerDown(as(core), 100, 700);
    onPointerMove(as(core), 100, 300);
    expect(core.scrollY).toBe(0);
    expect(core.scrollDirty).toBe(false);
  });

  it('ignores a move with no pointer down (no phantom scroll from a stray move)', () => {
    const core = makeCore();
    onPointerMove(as(core), 100, 300);
    expect(core.scrollDirty).toBe(false);
  });

  it('does not re-latch scrollDirty when the clamped value did not change', () => {
    // The `next !== core.scrollY` guard. Dragging further past the end is the common case, and each
    // extra frame would otherwise schedule another repaint for an identical offset.
    const core = makeCore();
    onPointerDown(as(core), 100, 700);
    onPointerMove(as(core), 100, 700 - 5000);
    core.scrollDirty = false;
    onPointerMove(as(core), 100, 700 - 6000); // still pinned at maxScroll
    expect(core.scrollY).toBe(300);
    expect(core.scrollDirty).toBe(false);
  });
});

describe('FriendsScene modal/popup interception order', () => {
  it('pointer-down while the popup is open arms nothing, so no page hit can fire', () => {
    const fn = vi.fn();
    const core = makeCore({
      popup: { isOpen: true, handleTap: vi.fn() },
      hits: [{ rect: { x: 0, y: 0, w: 1920, h: 1080 }, fn }],
    });
    onPointerDown(as(core), 100, 400);
    expect(core.pointerActive).toBe(false);
    onPointerUp(as(core), 100, 400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('pointer-up while the popup is open goes to the popup — checked BEFORE the pointerActive guard', () => {
    // The ordering input.ts calls out in a comment: onPointerDown returned before setting
    // pointerActive, so a `if (!core.pointerActive) return` placed first would swallow the tap and
    // the popup could never be closed by tapping it.
    const handleTap = vi.fn();
    const core = makeCore({ popup: { isOpen: true, handleTap } });
    onPointerUp(as(core), 111, 222);
    expect(handleTap).toHaveBeenCalledWith(111, 222);
  });

  it('fires the LAST matching modal hit, not the first (the dim rect must lose)', () => {
    const dimClose = vi.fn();
    const ok = vi.fn();
    const core = makeCore({
      modalOpen: true,
      modalHits: [
        { rect: { x: 0, y: 0, w: 1920, h: 1080 }, action: dimClose }, // pushed first, underneath
        { rect: { x: 400, y: 400, w: 200, h: 60 }, action: ok },
      ],
    });
    onPointerUp(as(core), 450, 420);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(dimClose).not.toHaveBeenCalled();
  });

  it('a modal tap fires on UP with no drag-cancel — deliberately unlike Family/Sect', () => {
    // Family/Sect route modal taps through the gesture, so a press-drag-release inside a modal
    // button does nothing there. Here it fires. Pinned so the difference is a decision, not a
    // surprise, if the three are ever reconciled.
    const ok = vi.fn();
    const core = makeCore({
      modalOpen: true,
      modalHits: [{ rect: { x: 400, y: 400, w: 200, h: 60 }, action: ok }],
    });
    onPointerDown(as(core), 450, 420);
    onPointerMove(as(core), 450, 420 - 500); // a long drag
    onPointerUp(as(core), 450, 420);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('a modal tap that misses every rect does nothing, and never falls through to the page', () => {
    const pageHit = vi.fn();
    const core = makeCore({
      modalOpen: true,
      modalHits: [{ rect: { x: 400, y: 400, w: 200, h: 60 }, action: vi.fn() }],
      hits: [{ rect: { x: 0, y: 0, w: 1920, h: 1080 }, fn: pageHit }],
    });
    onPointerUp(as(core), 50, 50);
    expect(pageHit).not.toHaveBeenCalled();
  });
});

describe('FriendsScene tap hit-testing against a translated scroll layer', () => {
  it('maps a scroll-tagged rect by the APPLIED delta, not by raw screen y', () => {
    // Rows are recorded in build space; a cheap scroll translates the layer, so a tap has to be
    // judged against what is on screen NOW. Deliberately the applied delta and not scrollY, which
    // moves inline in onWheel/onPointerMove while the layer only follows on the next update() drain.
    const fn = vi.fn();
    const core = makeCore({
      hits: [{ rect: { x: 0, y: 500, w: 500, h: 60 }, fn, scroll: true }],
      repaint: { appliedScrollDelta: 200 },
    });
    onPointerDown(as(core), 100, 300); // row physically at 300 after a 200px translate
    onPointerUp(as(core), 100, 300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a scroll-tagged hit outside the region misses, an untagged one at the same y does not', () => {
    // Rows are built beyond the viewport, so a hit rect alone no longer means "on screen"; chrome
    // (nav, header) is drawn outside the scroll layer and must stay tappable there.
    const tagged = vi.fn();
    const untagged = vi.fn();
    const a = makeCore({ hits: [{ rect: { x: 0, y: 840, w: 500, h: 60 }, fn: tagged, scroll: true }] });
    onPointerDown(as(a), 100, 850);
    onPointerUp(as(a), 100, 850);
    expect(tagged).not.toHaveBeenCalled();

    const b = makeCore({ hits: [{ rect: { x: 0, y: 840, w: 500, h: 60 }, fn: untagged }] });
    onPointerDown(as(b), 100, 850);
    onPointerUp(as(b), 100, 850);
    expect(untagged).toHaveBeenCalledTimes(1);
  });

  it('fires the FIRST matching page hit and stops', () => {
    // Page hits scan in push order (the reverse of modalHits) and return on the first match, so a
    // later overlapping rect must not also fire.
    const first = vi.fn();
    const second = vi.fn();
    const core = makeCore({
      hits: [
        { rect: { x: 0, y: 200, w: 500, h: 60 }, fn: first },
        { rect: { x: 0, y: 200, w: 500, h: 60 }, fn: second },
      ],
    });
    onPointerDown(as(core), 100, 220);
    onPointerUp(as(core), 100, 220);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('clears pointerActive on up so the next stray up cannot re-fire the same hit', () => {
    const fn = vi.fn();
    const core = makeCore({ hits: [{ rect: { x: 0, y: 200, w: 500, h: 60 }, fn }] });
    onPointerDown(as(core), 100, 220);
    onPointerUp(as(core), 100, 220);
    onPointerUp(as(core), 100, 220);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(core.pointerActive).toBe(false);
  });
});

describe('FriendsScene onWheel', () => {
  it('scrolls the single column and latches a repaint', () => {
    const core = makeCore();
    onWheel(as(core), 400, 120);
    expect(core.scrollY as number).toBeGreaterThan(0);
    expect(core.scrollDirty).toBe(true);
  });

  it('ignores a wheel outside the region, and while a popup or modal is open', () => {
    const outside = makeCore();
    onWheel(as(outside), 900, 120); // below regionBottom
    expect(outside.scrollY).toBe(0);

    const popup = makeCore({ popup: { isOpen: true, handleTap: vi.fn() } });
    onWheel(as(popup), 400, 120);
    expect(popup.scrollY).toBe(0);

    const modal = makeCore({ modalOpen: true });
    onWheel(as(modal), 400, 120);
    expect(modal.scrollY).toBe(0);
  });

  it('clamps to maxScroll however long the wheel runs', () => {
    const core = makeCore();
    for (let i = 0; i < 200; i++) onWheel(as(core), 400, 120);
    expect(core.scrollY).toBe(300);
  });
});

describe('FriendsScene worldStick — only the world tab has a stick-to-latest pin', () => {
  it('drag and wheel both re-pin at the bottom and release above it, on the world tab', () => {
    const drag = makeCore({ tab: 'world', worldStick: false });
    onPointerDown(as(drag), 100, 700);
    onPointerMove(as(drag), 100, 700 - 5000);
    expect(drag.worldStick).toBe(true);

    const release = makeCore({ tab: 'world', worldStick: true, scrollY: 300 });
    onPointerDown(as(release), 100, 100);
    onPointerMove(as(release), 100, 100 + 200); // scroll back up
    expect(release.worldStick).toBe(false);

    const wheel = makeCore({ tab: 'world', worldStick: false });
    for (let i = 0; i < 200; i++) onWheel(as(wheel), 400, 120);
    expect(wheel.worldStick).toBe(true);
  });

  it('leaves worldStick alone on every other tab', () => {
    // `core.tab === 'world'` gates it; other tabs never read the flag, so writing it there would be
    // invisible until the user switched to the world channel and found it scrolled somewhere odd.
    for (const tab of ['friends', 'requests', 'family']) {
      const core = makeCore({ tab, worldStick: false });
      onPointerDown(as(core), 100, 700);
      onPointerMove(as(core), 100, 700 - 5000);
      expect(core.worldStick, tab).toBe(false);
    }
  });
});
