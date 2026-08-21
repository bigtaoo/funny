/**
 * Playback.ts — the preview clock (normalized progress t over the effect duration).
 *
 * Holds play/pause + current t; the editor always loops the preview so the
 * artist sees the effect repeat (independent of the effect's own `loop` flag,
 * which only governs runtime auto-recycling). Scrubbing pauses and sets t
 * directly. `advance(dt)` is driven by the index rAF loop.
 *
 * Lives in model/ (not rendering/) because it is editor STATE, not a renderer:
 * no PIXI, no canvas, no DOM — the rAF loop reads it, it never reaches back.
 * ADR-070 Phase 4c moved it here so `coverage.include` could name whole
 * directories instead of listing this one file out of rendering/; see
 * vitest.config.ts and test/pureLayerBoundary.test.ts.
 */
export class Playback {
  t = 0;
  playing = true;
  /** seconds; kept in sync with the model's duration by the caller. */
  duration = 1;

  private onChange: () => void;
  constructor(onChange: () => void) { this.onChange = onChange; }

  advance(dtMs: number): void {
    if (!this.playing || this.duration <= 0) return;
    this.t += (dtMs / 1000) / this.duration;
    if (this.t >= 1) this.t -= Math.floor(this.t); // wrap; loop the preview
    this.onChange();
  }

  setPlaying(p: boolean): void { this.playing = p; this.onChange(); }
  toggle(): void { this.setPlaying(!this.playing); }

  /** Scrub to a value in [0,1]; pauses so the frame stays put. */
  scrubTo(t: number): void {
    this.t = Math.min(1, Math.max(0, t));
    this.playing = false;
    this.onChange();
  }
}
