// Pointer/wheel input dispatch for FriendsScene: drag-scroll, tap hit-testing, and the popup/modal
// interception order. Split out of ./core.ts (2026-08-20, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) to bring core.ts back under the 500-line
// convention — it reads and writes core's gesture fields only, with no state of its own, so free
// functions taking `core` explicitly rather than another class (same shape as ./chrome.ts, and the
// same seam FamilyScene/input.ts already has).
//
// Core's constructor wires these onto the InputManager; nothing else calls them.
import { wheelScrollY } from '../../ui/wheelScroll';
import { clamp, DRAG_THRESHOLD, type FriendsSceneCore } from './core';

export function onPointerDown(core: FriendsSceneCore, x: number, y: number): void {
  if (core.popup.isOpen || core.modalOpen) return;
  core.pointerActive = true;
  core.dragging = false;
  core.downX = x;
  core.downY = y;
  core.dragStartScroll = core.scrollY;
}

export function onPointerMove(core: FriendsSceneCore, x: number, y: number): void {
  if (!core.pointerActive || core.popup.isOpen) return;
  if (!core.dragging && Math.hypot(x - core.downX, y - core.downY) > DRAG_THRESHOLD) {
    core.dragging = true;
  }
  if (core.dragging && core.maxScroll > 0) {
    const next = clamp(core.dragStartScroll + (core.downY - y), 0, core.maxScroll);
    if (next !== core.scrollY) {
      core.scrollY = next;
      // World channel: dragging back to the bottom re-pins to the latest; scrolling up releases the
      // pin so a re-fetch (e.g. after posting) doesn't yank the reader down. Other tabs ignore it.
      if (core.tab === 'world') core.worldStick = next >= core.maxScroll - 1;
      core.scrollDirty = true;
    }
  }
}

export function onPointerUp(core: FriendsSceneCore, x: number, y: number): void {
  // onPointerDown returns before setting pointerActive while the popup/modal is open, so this must
  // be checked before the pointerActive guard below — otherwise a popup/modal tap-up short-circuits
  // with "no gesture in progress" and never reaches its own hit-test.
  if (core.popup.isOpen) { core.popup.handleTap(x, y); return; }
  if (core.modalOpen) {
    // Reverse order: the full-screen dim rect is pushed first, so checking in push order would
    // let it win over the OK/Cancel buttons drawn on top of it (see FamilyScene/base.ts precedent).
    for (let i = core.modalHits.length - 1; i >= 0; i--) {
      const { rect, action } = core.modalHits[i]!;
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { action(); return; }
    }
    return;
  }
  if (!core.pointerActive) return;
  core.pointerActive = false;
  if (core.dragging) { core.dragging = false; return; }
  // Hits inside the scroll layer were recorded in build space; the layer may since have been
  // translated by applyScroll(), so map the tap into that space. Non-scroll hits and the region
  // clamp below stay in screen space. (CardCodexScene's handleUp does the same.)
  const scrollDelta = core.repaint.scrollDelta;
  for (const hit of core.hits) {
    const r = hit.rect;
    const py = hit.scroll ? y + scrollDelta : y;
    if (x >= r.x && x <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
      if (hit.scroll && (y < core.regionTop || y > core.regionBottom)) continue;
      hit.fn();
      return;
    }
  }
}

export function onWheel(core: FriendsSceneCore, y: number, deltaY: number): void {
  if (core.popup.isOpen || core.modalOpen) return;
  const next = wheelScrollY(core.regionTop, core.regionBottom, y, deltaY, core.scrollY, core.maxScroll);
  if (next === null) return;
  core.scrollY = next;
  // World channel: scrolling up releases the "stick to latest" pin, same as drag — see onPointerMove.
  if (core.tab === 'world') core.worldStick = next >= core.maxScroll - 1;
  core.scrollDirty = true;
}
