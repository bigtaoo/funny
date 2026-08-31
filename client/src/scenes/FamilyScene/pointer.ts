// Pointer/wheel dispatch for FamilyScene: tap-vs-drag, per-column scroll routing, and the
// modal-vs-page interception order.
//
// Split out of ./core.ts (2026-08-25, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) to bring it back under the 500-line
// convention after the modal lists became scrollable — it reads and writes core's gesture/scroll
// fields only, with no state of its own. Same seam FriendsScene/input.ts already has.
//
// Core wires these onto the InputManager through four one-line delegates (handleDown/Move/Up/Wheel);
// nothing else calls them.
import { wheelScrollY } from '../../ui/wheelScroll';
import type { FamilySceneCore } from './core';
import type { ScrollCol } from './repaint';
import { runHit } from '../../ui/hits';

/**
 * Which column a pointer at screen `x` scrolls. The landscape split view shows both columns side
 * by side (routed by the divider); portrait shows one at a time, so the active tab decides. Modes
 * other than 'myFamily' have neither column, and a scroll there falls back to a full render anyway.
 */
export function scrollColAt(core: FamilySceneCore, x: number): ScrollCol {
  if (core.mode !== 'myFamily') return 'members';
  if (core.landscape) return x >= core.chatColX ? 'channel' : 'members';
  return core.activeTab;
}

/** Which scroll field a column's position lives in — mirrors the `scrollKey` every render path
 *  passes to renderMembers/renderChannel: unlike the sect page, both orientations map the roster to
 *  `scrollY` and the channel to `scrollYChannel`. */
export function scrollKeyFor(core: FamilySceneCore, col: ScrollCol): 'scrollY' | 'scrollYChannel' | 'modalScrollY' {
  if (col === 'modal') return 'modalScrollY';
  return col === 'channel' ? 'scrollYChannel' : 'scrollY';
}

/** Scroll extent of a column, as of its last build — the clamp handleMove/handleWheel apply. */
function maxFor(core: FamilySceneCore, col: ScrollCol): number {
  return col === 'modal' ? core.modalMax : col === 'channel' ? core.channelMax : core.membersMax;
}

/** Is screen `y` inside a column's viewport? See handleDown for why a hit needs core. */
function inViewport(core: FamilySceneCore, col: ScrollCol, y: number): boolean {
  if (col === 'modal') return y >= core.modalRegionTop && y <= core.modalRegionBottom;
  return col === 'channel'
    ? y >= core.channelRegionTop && y <= core.channelRegionBottom
    : y >= core.membersRegionTop && y <= core.membersRegionBottom;
}

export function onPointerDown(core: FamilySceneCore, x: number, y: number): void {
  if (core.profilePopup.isOpen) return;
  if (core.modalOpen) {
    // Reverse order: the full-screen dim-to-close rect is always pushed first, so checking
    // in push order made it win over every button drawn on top of it (approve/reject, pick
    // rows, ...) — clicks looked like they did nothing because they just closed the modal.
    //
    // A list modal scrolls now, so its taps go through the same tap-vs-drag gesture the page uses
    // (fired on pointer-UP, dropped if the pointer dragged) and its in-layer rects are mapped by
    // the applied translate, exactly like the page columns.
    let modalHit: (() => void) | null = null;
    for (let i = core.modalHits.length - 1; i >= 0; i--) {
      const h = core.modalHits[i]!;
      const { rect, scroll } = h;
      const py = scroll ? y + core.repaint.appliedDelta(scroll) : y;
      if (x < rect.x || x > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      if (scroll && !inViewport(core, scroll, y)) continue;
      modalHit = (): void => runHit(h); break;
    }
    core.dragCol = 'modal';
    core.gesture.down(core.modalScrollY, y, modalHit);
    return;
  }
  // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
  // scroll and the tap is dropped, so a drag starting on a cell scrolls instead of firing it.
  //
  // A rect tagged `scroll` was recorded in its column's build space, and that layer may since have
  // been translated by a cheap scroll — so map the tap into the same space, deliberately by the
  // APPLIED delta rather than the pending one (see FamilyRepaint.appliedDelta).
  let hit: (() => void) | null = null;
  for (const h of core.hitRects) {
    const { rect, scroll } = h;
    const py = scroll ? y + core.repaint.appliedDelta(scroll) : y;
    if (x < rect.x || x > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
    // Rows are built one viewport beyond the region in each direction, so a hit rect alone no
    // longer implies "on screen" — a tap outside the column's viewport must miss.
    if (scroll && !inViewport(core, scroll, y)) continue;
    hit = (): void => runHit(h); break;
  }
  core.dragCol = scrollColAt(core, x);
  core.gesture.down(core[scrollKeyFor(core, core.dragCol)], y, hit);
}

export function onPointerMove(core: FamilySceneCore, y: number): void {
  const raw = core.gesture.move(y);
  if (raw === null) return;
  const col = core.dragCol;
  // Clamp to the column's extent HERE, not just at the next rebuild — see SectScene/core.ts's
  // handleMove for the full note: the cheap-scroll path translates whatever the scroll field says,
  // so an over-drag past the end would otherwise scroll the list into blank space and stay there.
  const next = Math.min(raw, maxFor(core, col));
  core[scrollKeyFor(core, col)] = next;
  // Dragging to the bottom re-pins to the latest; scrolling up releases the pin so incoming
  // messages don't yank the reader back down (the "channel jumps while I'm reading" complaint).
  if (col === 'channel') core.channelStick = next >= core.channelMax - 1;
  core.scrollDirtyCol = col;
}

export function onPointerUp(core: FamilySceneCore, x: number, y: number): void {
  // Popup taps never reach `gesture` (handleDown returned before arming it while open) — route
  // them through the popup's own manual hit-test instead of trusting its PIXI-native pointertap
  // alone (see ProfilePopup.handleTap doc comment: safe even if that native path also fires).
  if (core.profilePopup.isOpen) { core.profilePopup.handleTap(x, y); return; }
  // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
  core.gesture.up()?.();
}

/** PC-only mouse-wheel scroll (see wheelScroll.ts). Mirrors handleMove's routing: in the landscape
 *  split view the roster/channel columns scroll independently (routed by chatColX, same as
 *  handleDown); portrait's single-column tab view scrolls whichever tab is active (members ↔
 *  scrollY, channel ↔ scrollYChannel — see renderTabbedView). */
export function onWheel(core: FamilySceneCore, x: number, y: number, deltaY: number): void {
  if (core.profilePopup.isOpen) return;
  if (core.modalOpen) {
    // Wheel over an open list modal scrolls the modal (and only inside its own viewport, which is
    // what wheelScrollY's region check enforces).
    const next = wheelScrollY(core.modalRegionTop, core.modalRegionBottom, y, deltaY, core.modalScrollY, core.modalMax);
    if (next === null) return;
    core.modalScrollY = next;
    core.scrollDirtyCol = 'modal';
    return;
  }
  if (core.mode !== 'myFamily') return;
  const col = scrollColAt(core, x);
  const key = scrollKeyFor(core, col);
  const channel = col === 'channel';
  const top = channel ? core.channelRegionTop : core.membersRegionTop;
  const bottom = channel ? core.channelRegionBottom : core.membersRegionBottom;
  const max = channel ? core.channelMax : core.membersMax;
  const next = wheelScrollY(top, bottom, y, deltaY, core[key], max);
  if (next === null) return;
  core[key] = next;
  if (channel) core.channelStick = next >= core.channelMax - 1;
  core.scrollDirtyCol = col;
}
