// The render loop's paint counters, in a module of their own so a reader does not have to import
// the render loop.
//
// `RenderPolicy` (renderPolicy.ts) owns and mutates these; `cache/PerfMonitor` reads them to turn
// "paints since boot" into the per-second paint rate it reports in `render_profile`. They live here
// rather than on the policy for two reasons:
//
//   1. PerfMonitor is constructed independently of the PIXI application and has no handle on the
//      policy object — the same reason `holdRenderActive` is module-level.
//   2. renderPolicy.ts imports PIXI as a *value* (UPDATE_PRIORITY, Ticker), so importing it drags the
//      whole canvas renderer — and its `document.createElement` at module load — into every consumer.
//      PerfMonitor's own `import * as PIXI` is type-only and gets elided, which is precisely why it
//      runs in the plain-node unit suite; a value import of renderPolicy broke that. This file has no
//      imports at all, so reading the counters costs a reader nothing.
//
// The reference is live, not a snapshot: readers diff it across their own sampling windows.

/** Live counters of the installed render policy. */
export interface RenderStats {
  /** Ticks the policy decided on. */
  ticks: number;
  /** Ticks that actually painted. */
  painted: number;
  /** Ticks skipped because the stage signature was unchanged. */
  skipped: number;
}

let live: RenderStats | null = null;

/**
 * Publish (or, with `null`, retract) the installed policy's counters. Called only by
 * `RenderPolicy.install` / `.uninstall`.
 *
 * Not gated on `nw_render_debug`: nothing is written to `globalThis` here, so unlike
 * `__nwRenderStats` there is no debug surface for a production build to grow.
 */
export function setLiveRenderStats(stats: RenderStats | null): void { live = stats; }

/** The installed policy's live counters, or null when no policy is installed (tests, tools). */
export function renderStats(): Readonly<RenderStats> | null { return live; }
