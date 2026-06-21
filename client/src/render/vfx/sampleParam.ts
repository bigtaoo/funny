/**
 * vfx/sampleParam.ts — evaluate a ParamTrack at progress t ∈ [0,1].
 *
 * No external dependencies — shared verbatim between the game runtime and the
 * vfx-editor. Mirrors the spirit of animator's sampleClip.
 */
import { Ease, Keyframe, ParamTrack } from './types';

/** Apply an easing curve to a normalized 0→1 input. */
export function applyEase(ease: Ease | undefined, t: number): number {
  switch (ease) {
    case 'easeIn':    return t * t;
    case 'easeOut':   return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'linear':
    default:          return t;
  }
}

function isKeyframes(track: ParamTrack): track is Keyframe[] {
  return Array.isArray(track);
}

/**
 * Resolve a parameter value at progress t.
 * @param track  number | {from,to,ease} | Keyframe[]
 * @param t      clamped to [0,1] by caller; not re-clamped here.
 */
export function sampleParam(track: ParamTrack | undefined, t: number, fallback = 0): number {
  if (track == null) return fallback;
  if (typeof track === 'number') return track;

  // Two-point ramp
  if (!isKeyframes(track)) {
    return track.from + (track.to - track.from) * applyEase(track.ease, t);
  }

  // Multi-keyframe curve
  const kfs = track;
  if (kfs.length === 0) return fallback;
  if (kfs.length === 1 || t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const local = span <= 0 ? 0 : (t - a.t) / span;
      // `ease` on the keyframe ENDING the segment governs that segment.
      return a.v + (b.v - a.v) * applyEase(b.ease, local);
    }
  }
  return last.v;
}
