/**
 * Playback.ts — the preview clock (normalized progress t over the effect duration).
 *
 * Holds play/pause + current t; the editor always loops the preview so the
 * artist sees the effect repeat (independent of the effect's own `loop` flag,
 * which only governs runtime auto-recycling). Scrubbing pauses and sets t
 * directly. `advance(dt)` is driven by the index rAF loop.
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
