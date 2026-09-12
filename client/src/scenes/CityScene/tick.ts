// The per-frame and once-per-second work behind CitySceneCore.update() (see ./core.ts).
//
// Split out of core.ts on 2026-09-12. It is the one cluster in that file with a life of its own:
// three independent timers whose whole job is deciding when something on screen is stale enough to
// be worth a repaint, as opposed to the delegate-to-a-sibling-module lines that make up most of the
// class. Free functions over `core`, the same shape ./render.ts and ./modals.ts take it in — every
// field read here is one core already exposes to its sibling domains.
import * as data from './data';
import type { CitySceneCore } from './core';

/**
 * One frame. Order matters at both ends: the guide animation and the busy tracker run before
 * anything can ask for a paint, and paint.flush() runs last so everything that did ask gets folded
 * into a single repaint rather than one each.
 */
export function update(core: CitySceneCore, dt: number): void {
  // SLG opening guide chain (ONBOARDING_DESIGN §4.2) — advance the ring's breathing animation
  // every frame regardless of whether a full render() fires this tick (render() decides *what* to
  // show; this just keeps whatever is showing animated).
  core.guide.update(dt);
  // The in-flight dim lives in its own permanent layer, so busy state is a layer toggle rather
  // than a reason to rebuild the scene. bt.tick's return value is deliberately ignored: it also
  // goes true every 0.4s for the dot animation this scene's overlay does not draw, which used to
  // buy a full teardown-and-rebuild that changed nothing on screen.
  core.bt.tick(dt);
  core.paint.syncBusy(core.bt.loadingVisible);
  if (tickLoadDots(core, dt)) core.requestRender();
  core.simTimer += dt;
  if (core.simTimer >= 1) {
    core.simTimer = 0;
    tickResourceTotals(core);
    data.refreshOnQueueDue(core.dataHost());
  }
  // Last in the tick, so everything above that asked for a paint gets folded into this one.
  core.paint.flush();
}

/** Advances the team-row loading placeholders' trailing dots while their fetches are in flight.
 *  Returns true when a re-render is needed (same contract as BusyTracker.tick). */
function tickLoadDots(core: CitySceneCore, dt: number): boolean {
  if (core.teamsLoaded && core.ordersLoaded) return false;
  core.loadDotTimer += dt;
  if (core.loadDotTimer < 0.4) return false;
  core.loadDotTimer = 0;
  core.loadDots = (core.loadDots + 1) % 3;
  return true;
}

/** Advance the resource-bar total labels in place (no full render). Mirrors worldsvc settle():
 *  displayed total = min(cap, base + yieldRate·elapsedHours). Cheap enough to run every second. */
function tickResourceTotals(core: CitySceneCore): void {
  for (const { rt, lbl } of core.resTotalLbls) {
    const next = core.fmtNum(core.liveResource(rt));
    if (lbl.text !== next) lbl.text = next;
  }
}
