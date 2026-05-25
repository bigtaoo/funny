/**
 * Global mutable app state and current bone deltas.
 * All modules share the same object references (module singleton pattern).
 */
import type { AnimationStore, BoneDeltas } from './types';
import { BONE_DEFS } from './skeleton';

export interface AppState {
  animations: AnimationStore;
  currentAnim: string;
  currentTime: number;
  isPlaying: boolean;
  playSpeed: number;
  looping: boolean;

  /** Currently selected bone id, or null. */
  selectedBone: string | null;
  /** Time of the selected keyframe in the timeline, or null. */
  selectedKfTime: number | null;

  /** Hip root position on canvas. */
  rootX: number;
  rootY: number;
  /** Pan offset (added to default root position). */
  panOffsetX: number;
  panOffsetY: number;

  showJoints: boolean;
  showOnion: boolean;
  showGuide: boolean;

  // ── Drag tracking ─────────────────────────────────────────────────────────
  isDragging: boolean;
  dragType: 'bone' | 'pan' | null;
  dragBoneId: string | null;
  /** Parent bone's world angle at drag start (for computing delta). */
  dragParentAngle: number;
  /** Bone pivot position at drag start. */
  dragPivotX: number;
  dragPivotY: number;
  /** Pan reference: mouse position minus current pan offset at drag start. */
  dragPanRefX: number;
  dragPanRefY: number;
}

export const state: AppState = {
  animations: {},
  currentAnim: '',
  currentTime: 0,
  isPlaying: false,
  playSpeed: 1,
  looping: true,
  selectedBone: null,
  selectedKfTime: null,
  rootX: 0,
  rootY: 0,
  panOffsetX: 0,
  panOffsetY: 0,
  showJoints: true,
  showOnion: false,
  showGuide: false,
  isDragging: false,
  dragType: null,
  dragBoneId: null,
  dragParentAngle: 0,
  dragPivotX: 0,
  dragPivotY: 0,
  dragPanRefX: 0,
  dragPanRefY: 0,
};

/** Live bone rotation deltas (degrees) relative to the rest pose. */
export const currentDeltas: BoneDeltas = Object.fromEntries(
  BONE_DEFS.map(b => [b.id, 0]),
);

/** Reset all deltas to 0 (rest pose). */
export function resetDeltas(): void {
  for (const key of Object.keys(currentDeltas)) {
    currentDeltas[key] = 0;
  }
}

/** Overwrite currentDeltas from a partial record (missing keys stay at 0). */
export function applyDeltas(source: BoneDeltas): void {
  resetDeltas();
  for (const [id, val] of Object.entries(source)) {
    if (id in currentDeltas) currentDeltas[id] = val;
  }
}

/** Capture a snapshot of non-zero deltas. */
export function snapshotDeltas(): BoneDeltas {
  return Object.fromEntries(
    Object.entries(currentDeltas).filter(([, v]) => Math.abs(v) > 0.01),
  );
}
