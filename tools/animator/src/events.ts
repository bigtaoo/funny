/**
 * Minimal event bus. Payload is typed as `unknown` so callers must cast.
 * Kept intentionally simple — no typed event maps needed for a dev tool.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (payload?: any) => void;

const registry: Record<string, Listener[]> = {};

export function on(event: string, fn: Listener): void {
  (registry[event] ??= []).push(fn);
}

export function off(event: string, fn: Listener): void {
  registry[event] = (registry[event] ?? []).filter(f => f !== fn);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emit(event: string, payload?: any): void {
  (registry[event] ?? []).forEach(fn => fn(payload));
}

// ── Typed event names used across the codebase ──────────────────────────────

/** Emitted when the active animation changes (name in payload). */
export const ANIM_SELECT  = 'anim:select';

/** Emitted when the animation list changes (create/rename/delete). */
export const ANIM_LIST    = 'anim:list';

/** Emitted when the selected bone changes. */
export const BONE_SELECT  = 'bone:select';

/** Emitted during playback / scrubbing to refresh time display + timeline. */
export const TIME_CHANGE  = 'time:change';

/** Emitted to update the status bar text. */
export const STATUS       = 'status';

/** Emitted when play/pause state changes. */
export const PLAY_STATE   = 'play:state';
