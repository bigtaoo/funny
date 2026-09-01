// Player-owned volume + mute, and the one place that turns them into bus gains
// (AUDIO_DESIGN.md §4 "混音与设置").
//
// Shape copied from `assets/prefetchPolicy.ts`, which solves the same problem: a player preference
// that boot installs once, that a scene reads and writes directly, and that has no server side.
// Like `nw_locale` and `nw_data_saver` this is **local only** — there is nothing to cheat and
// nothing another device needs to know, so paying a `PUT /flags` round trip for it would buy
// nothing (AUDIO_DESIGN.md §4 "不上云权威").
//
// The three channels are a matrix, not three switches: the effective gain of a channel is
// `master × channel`, and `muted` overrides both with 0 (rather than zeroing `master`, so
// unmuting restores the sliders the player set instead of leaving them at the bottom).
import type { IStorage } from '../platform/IPlatform';
import { audioBus } from './audioBus';

/** Storage key. One JSON blob rather than four keys: these four values are only ever read and
 *  written together, and a partial write (say, volume saved but mute lost) has no useful meaning. */
export const AUDIO_SETTINGS_KEY = 'nw_audio';

export interface AudioSettings {
  /** 0..1, multiplies both channels. */
  master: number;
  /** 0..1, BGM channel. Persisted and wired now even though no BGM track exists yet
   *  (AUDIO_DESIGN.md §7 step 7) — `AudioBus.setMusicVolume` accepts and ignores it. */
  bgm: number;
  /** 0..1, SFX channel. */
  sfx: number;
  /** Hard mute, independent of the sliders. */
  muted: boolean;
}

/** AUDIO_DESIGN.md §4 "默认": BGM on but modest, SFX loud, nothing muted. */
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = { master: 1, bgm: 0.5, sfx: 0.8, muted: false };

let storage: IStorage | null = null;
let current: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

/** Parse a stored blob, falling back per-field. A hand-edited or truncated value must degrade to
 *  the default, never to a silent game — "the audio broke" is the hardest bug class to attribute. */
function parse(raw: string | null): AudioSettings {
  if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
  try {
    const o = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      master: clamp01(o.master, DEFAULT_AUDIO_SETTINGS.master),
      bgm: clamp01(o.bgm, DEFAULT_AUDIO_SETTINGS.bgm),
      sfx: clamp01(o.sfx, DEFAULT_AUDIO_SETTINGS.sfx),
      muted: o.muted === true,
    };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

/** Push the current settings onto the installed bus. Safe before any bus is installed — the
 *  default `NullAudioBus` accepts and drops both calls. */
function apply(): void {
  const gain = current.muted ? 0 : current.master;
  const bus = audioBus();
  bus.setSfxVolume(gain * current.sfx);
  bus.setMusicVolume(gain * current.bgm);
}

/**
 * Load the saved settings and apply them. Called once at boot, next to `installPrefetchPolicy`,
 * and **after** the entry has installed its `AudioBus` — otherwise the gains land on the null bus
 * and the real one starts at its own defaults.
 *
 * Uninstalled (unit tests, the headless harness) this module still works: reads return the
 * defaults and writes are dropped, which is the same degradation prefetchPolicy has.
 */
export function installAudioSettings(deps: { storage: IStorage }): void {
  storage = deps.storage;
  current = parse(storage.getItem(AUDIO_SETTINGS_KEY));
  apply();
}

/** Test seam: forget the installed storage and go back to defaults. */
export function resetAudioSettingsForTest(): void {
  storage = null;
  current = { ...DEFAULT_AUDIO_SETTINGS };
}

export function getAudioSettings(): Readonly<AudioSettings> {
  return current;
}

function persist(): void {
  try {
    storage?.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(current));
  } catch {
    // A full or blocked storage must never break the settings screen. Losing the write costs the
    // player one re-adjust next launch, which is strictly better than a thrown tap.
  }
}

/** Set one channel (0..1), apply it to the bus, and persist. */
export function setAudioVolume(channel: 'master' | 'bgm' | 'sfx', v: number): void {
  current = { ...current, [channel]: Math.max(0, Math.min(1, v)) };
  apply();
  persist();
}

export function setAudioMuted(muted: boolean): void {
  current = { ...current, muted };
  apply();
  persist();
}
