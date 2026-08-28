// Pointer plumbing for the CardScene composition — split out of ./core.ts (2026-08-25) when the
// pause/resume pair ADR-072 needs (see CardSceneCore.pause) pushed that file back over the 500-line
// convention. Form① free functions taking `core` explicitly, the same shape EquipmentScene/cells.ts
// has: the STATE these read and write (gesture, modalSliders, scrollY, …) stays on Core, because
// every other domain class writes it too — only the handlers moved.
//
// The one caller is CardSceneCore itself (its constructor subscribes, pause/resume/destroy detach),
// so nothing here is part of the scene's outward surface.
import type { InputManager } from '../../inputSystem/InputManager';
import { wheelScrollY } from '../../ui/wheelScroll';
import type { Rect } from './logic/types';
import type { CardSceneCore } from './core';

function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Subscribe the four pointer streams, pushing each unsub onto {@link CardSceneCore.inputUnsubs}. */
export function subscribeInput(core: CardSceneCore, input: InputManager): void {
  core.inputUnsubs.push(input.onDown((x, y) => handleDown(core, x, y)));
  core.inputUnsubs.push(input.onMove((x, y) => handleMove(core, x, y)));
  core.inputUnsubs.push(input.onUp(() => handleUp(core)));
  // Desktop mouse-wheel scroll (browser only — see wheelScroll.ts); the detail/feed modal doesn't
  // scroll via this path, so a wheel event while one is open is ignored, mirroring handleMove's
  // modalOpen guard below.
  core.inputUnsubs.push(input.onWheel((x, y, deltaY) => {
    if (core.modalOpen) return;
    const next = wheelScrollY(core.scrollRegionTop, core.scrollRegionBottom, y, deltaY, core.scrollY, core.maxScroll);
    if (next !== null) { core.scrollY = next; core.scrollDirty = true; }
  }));
}

export function unsubscribeInput(core: CardSceneCore): void {
  for (const u of core.inputUnsubs) u();
  core.inputUnsubs.length = 0;
}

function handleDown(core: CardSceneCore, x: number, y: number): void {
  if (core.bt.busy) return;
  if (core.modalOpen) {
    // The header Back button must stay reachable even with the detail modal open — otherwise a
    // tap there falls through to the modal's own dim-to-close catch-all and just closes the
    // modal instead of leaving the scene (LOBBY_IA_REDESIGN back-button-always-works fix, 2026-07-14).
    if (inRect(x, y, core.backRect)) { core.cb.onBack(); return; }
    // A slider (feed quantity drag bar) must track the pointer live, not defer to up like a tap —
    // check it first and, if hit, jump the value to the press point immediately.
    for (const { rect, onDrag } of core.modalSliders) {
      if (inRect(x, y, rect)) { core.activeModalSlider = onDrag; onDrag(x); return; }
    }
    // Defer the modal hit to pointer-UP and drop it if the pointer drags past the threshold, same
    // as the grid behind it — so a press-drag-release on a feed-select row (or any modal row) only
    // toggles on release, and a drag away doesn't accidentally toggle it (2026-07-17).
    let modalHit: (() => void) | null = null;
    for (const { rect, action } of core.modalHits) {
      if (inRect(x, y, rect)) { modalHit = action; break; }
    }
    // The feed modal is drag-scrollable: track from its own scroll base so a drag pans the list
    // (see handleMove). Other modals don't scroll — feedRedraw is null and the returned delta is ignored.
    core.gesture.down(core.feedScrollPx, y, modalHit);
    return;
  }
  // Don't fire the hit action here — capture it and start gesture tracking. If the pointer then
  // drags past the threshold it becomes a scroll and the tap is dropped on up; otherwise the tap
  // fires on up. This lets a drag that starts *on a card cell* scroll the grid instead of instantly
  // opening that card's detail.
  let hit: (() => void) | null = null;
  for (const { rect, action } of core.hitRects) {
    if (inRect(x, y, rect)) { hit = action; break; }
  }
  core.gesture.down(core.scrollY, y, hit);
}

function handleMove(core: CardSceneCore, x: number, y: number): void {
  if (core.activeModalSlider) { core.activeModalSlider(x); return; }
  // Feed the move to the gesture even while a modal is open: the modal doesn't scroll, but this
  // latches `moved` once the pointer crosses the drag threshold so the pending modal tap is dropped on up.
  const scroll = core.gesture.move(y);
  if (core.modalOpen) {
    // Only the feed modal scrolls; apply the drag delta to its pixel offset (clamped on redraw)
    // and latch a dirty flag so update() redraws the panel at most once per frame.
    if (scroll !== null && core.feedRedraw) {
      core.feedScrollPx = Math.max(0, Math.min(scroll, core.feedScrollMax));
      core.feedScrollDirty = true;
    }
    return;
  }
  if (scroll !== null) { core.scrollY = scroll; core.scrollDirty = true; }
}

function handleUp(core: CardSceneCore): void {
  if (core.activeModalSlider) { core.activeModalSlider = null; return; }
  // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
  core.gesture.up()?.();
}
