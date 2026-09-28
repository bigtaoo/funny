// Phase quantization for ambient animation on demand-painted screens.
//
// A `reactive` scene (render/renderPolicy.ts) is repainted whenever a field its stage signature reads
// changes — and a pulse driven straight off a sine changes `alpha` / `scale` on every tick, which on
// its own pins an otherwise still screen at the full frame rate. Quantizing the animation's CLOCK
// rather than throttling its caller keeps the call idempotent within a step (any number of calls in
// the same step land on the same value), so a screen paints at most `fps` times a second for it.
//
// No imports on purpose: the readers are scenes that the plain-node unit suite loads.

/**
 * Step rate for attention pulses and breathing highlights (the guide ring, the campaign map's next
 * level, the daily check-in cell). 10 is art-direction §5.4's "hand-drawn does not need to be
 * smooth" applied to a slow sine: a ~1.5 s breath sampled at 10 steps still reads as a breath.
 */
export const PULSE_STEP_FPS = 10;

/** `t` (seconds) rounded down to the last whole step of `fps`. */
export function steppedTime(t: number, fps: number = PULSE_STEP_FPS): number {
  return Math.floor(t * fps) / fps;
}
