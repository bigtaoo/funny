/**
 * Animation clip management + playback engine.
 * Responsible for: CRUD on clips, keyframe ops, interpolation, play/pause/stop.
 */
import type { AnimationClip, Keyframe, BoneDeltas } from './types';
import { state, currentDeltas, applyDeltas, snapshotDeltas } from './state';
import { emit, STATUS, TIME_CHANGE, PLAY_STATE } from './events';

// ── Helpers ──────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linear interpolation between two keyframes at time t. */
export function sampleAnimation(clip: AnimationClip, t: number): BoneDeltas {
  const kfs = clip.keyframes;
  if (kfs.length === 0) return {};
  if (kfs.length === 1) return { ...kfs[0].bones };

  let kf1 = kfs[0];
  let kf2: Keyframe | null = null;

  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i].time <= t) kf1 = kfs[i];
    if (kfs[i].time > t && !kf2) kf2 = kfs[i];
  }
  if (!kf2) return { ...kf1.bones };

  const f = (t - kf1.time) / (kf2.time - kf1.time);
  const result: BoneDeltas = {};
  const keys = new Set([...Object.keys(kf1.bones), ...Object.keys(kf2.bones)]);
  keys.forEach(id => {
    result[id] = lerp(kf1.bones[id] ?? 0, kf2!.bones[id] ?? 0, f);
  });
  return result;
}

// ── Accessors ────────────────────────────────────────────────────────────────

export function getCurrentClip(): AnimationClip | null {
  return state.animations[state.currentAnim] ?? null;
}

export function getDuration(): number {
  const fromClip = getCurrentClip()?.duration;
  if (fromClip != null) return fromClip;
  const raw = (document.getElementById('inp-duration') as HTMLInputElement | null)?.value;
  return parseFloat(raw ?? '0.5') || 0.5;
}

/** Apply the animation at time t to currentDeltas. */
export function applyAnimationAtTime(t: number): void {
  const clip = getCurrentClip();
  if (!clip || clip.keyframes.length === 0) return;
  applyDeltas(sampleAnimation(clip, t));
}

// ── Keyframe Operations ───────────────────────────────────────────────────────

/** Add or update a keyframe at the current playhead time using the current pose. */
export function addKeyframeAtCurrentTime(): void {
  const clip = getCurrentClip();
  if (!clip) { emit(STATUS, 'No animation selected'); return; }

  const t = Math.round(state.currentTime * 1000) / 1000;
  const bones = snapshotDeltas();

  const existing = clip.keyframes.find(k => Math.abs(k.time - t) < 0.001);
  if (existing) {
    Object.assign(existing.bones, bones);
    emit(STATUS, `Updated keyframe @ ${t.toFixed(3)}s`);
  } else {
    clip.keyframes.push({ time: t, bones });
    clip.keyframes.sort((a, b) => a.time - b.time);
    emit(STATUS, `Added keyframe @ ${t.toFixed(3)}s`);
  }
  state.selectedKfTime = t;
}

/** Delete the keyframe at the currently selected (or playhead) time. */
export function deleteKeyframeAtCurrentTime(): void {
  const clip = getCurrentClip();
  if (!clip) return;

  const t = state.selectedKfTime ?? state.currentTime;
  const idx = clip.keyframes.findIndex(k => Math.abs(k.time - t) < 0.001);
  if (idx >= 0) {
    clip.keyframes.splice(idx, 1);
    state.selectedKfTime = null;
    emit(STATUS, `Deleted keyframe @ ${t.toFixed(3)}s`);
  } else {
    emit(STATUS, 'No keyframe at current time');
  }
}

/** Return the keyframe just before the current time, or null. */
export function getPrevKeyframe(): Keyframe | null {
  const kfs = getCurrentClip()?.keyframes ?? [];
  return kfs.filter(k => k.time < state.currentTime - 0.001)
            .sort((a, b) => b.time - a.time)[0] ?? null;
}

/** Return the keyframe just after the current time, or null. */
export function getNextKeyframe(): Keyframe | null {
  const kfs = getCurrentClip()?.keyframes ?? [];
  return kfs.filter(k => k.time > state.currentTime + 0.001)
            .sort((a, b) => a.time - b.time)[0] ?? null;
}

// ── Playback ──────────────────────────────────────────────────────────────────

let lastTimestamp: number | null = null;
let rafId = 0;

function tick(ts: number): void {
  if (!state.isPlaying) return;

  if (lastTimestamp !== null) {
    const dt = ((ts - lastTimestamp) / 1000) * state.playSpeed;
    state.currentTime += dt;
    const dur = getDuration();

    if (state.currentTime >= dur) {
      if (state.looping) {
        state.currentTime = state.currentTime % dur;
      } else {
        state.currentTime = dur;
        pausePlayback();
        applyAnimationAtTime(dur);
        emit(TIME_CHANGE);
        return;
      }
    }
    applyAnimationAtTime(state.currentTime);
    emit(TIME_CHANGE);
  }

  lastTimestamp = ts;
  rafId = requestAnimationFrame(tick);
}

export function startPlayback(): void {
  if (!state.currentAnim) { emit(STATUS, 'Select an animation first'); return; }
  state.isPlaying = true;
  lastTimestamp = null;
  rafId = requestAnimationFrame(tick);
  emit(PLAY_STATE, true);
}

export function pausePlayback(): void {
  state.isPlaying = false;
  lastTimestamp = null;
  cancelAnimationFrame(rafId);
  emit(PLAY_STATE, false);
}

export function stopPlayback(): void {
  pausePlayback();
  state.currentTime = 0;
  applyAnimationAtTime(0);
  emit(TIME_CHANGE);
}

export function togglePlayback(): void {
  state.isPlaying ? pausePlayback() : startPlayback();
}

// ── Clip Management ───────────────────────────────────────────────────────────

/** Set the current clip's duration (clamped). */
export function setDuration(seconds: number): void {
  const clip = getCurrentClip();
  if (clip) clip.duration = Math.max(0.1, seconds);
}

/** Set the current clip's loop flag. */
export function setLoop(loop: boolean): void {
  const clip = getCurrentClip();
  if (clip) clip.loop = loop;
  state.looping = loop;
}
