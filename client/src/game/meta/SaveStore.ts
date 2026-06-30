// Local save persistence (S0-3). Uses IPlatform.storage (key=nw_save_v1).
// loadLocal runs migrate for normalisation + fallback; saveLocal serialises to storage.
//
// pull/push (cloud side) are not part of this interface — they depend on account + network
// and live in ApiClient + CloudSync (S0-5); SaveManager composes both. This keeps local
// persistence network-free and easy to unit-test (in-memory IStorage round-trip).
//
// Legacy key absorption: historically nw_seen_intro was stored as a standalone key.
// loadLocal absorbs it into flags.seen_intro (the old key is still readable for
// compatibility but not deleted). nw_locale is a string managed by i18n (flags holds
// booleans only) and is not absorbed.

import type { IStorage } from '../../platform/IPlatform';
import { migrate } from './migrate';
import { SAVE_STORAGE_KEY, type SaveData } from './SaveData';

/** Legacy key — absorbed into SaveData.flags on first load. */
const LEGACY_SEEN_INTRO_KEY = 'nw_seen_intro';

/** Local key for the offline pending-settlement clear queue (PVE_INTEGRITY_PLAN §8.4, non-sync segment, not uploaded to cloud). */
const PENDING_CLEARS_KEY = 'nw_pending_clears_v1';

/** Offline pending-settlement clear record (flushed on reconnect → POST /pve/clear). */
export interface PendingClear {
  levelId: string;
  stars: number;
  ts: number;
  /** Local replay id (ReplayStore); retrieved and uploaded for re-verification when the flush is sampled by L1 (§8.6). */
  replayId?: string;
}

export interface SaveStore {
  /** Read local save (including migration + fallback + legacy key absorption); returns a fresh save if none exists. */
  loadLocal(): SaveData;
  /** Write local save. */
  saveLocal(save: SaveData): void;
  /** Clear local save (for debug / logout). */
  clearLocal(): void;
  /** Read the offline pending-settlement clear queue (returns empty on corruption). */
  loadPending(): PendingClear[];
  /** Write the offline pending-settlement clear queue. */
  savePending(list: PendingClear[]): void;
}

export class LocalSaveStore implements SaveStore {
  constructor(private readonly storage: IStorage) {}

  loadLocal(): SaveData {
    let raw: unknown = null;
    const text = this.storage.getItem(SAVE_STORAGE_KEY);
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null; // corrupted save → treat as absent, migrate to a fresh save
      }
    }
    const save = migrate(raw);
    this.absorbLegacy(save);
    return save;
  }

  saveLocal(save: SaveData): void {
    this.storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(save));
  }

  clearLocal(): void {
    this.storage.removeItem(SAVE_STORAGE_KEY);
  }

  loadPending(): PendingClear[] {
    const text = this.storage.getItem(PENDING_CLEARS_KEY);
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(
          (e): e is PendingClear =>
            !!e && typeof e.levelId === 'string' && typeof e.stars === 'number',
        )
        .map((e) => ({
          levelId: e.levelId,
          stars: e.stars,
          ts: typeof e.ts === 'number' ? e.ts : 0,
          ...(typeof e.replayId === 'string' ? { replayId: e.replayId } : {}),
        }));
    } catch {
      return []; // corrupted → treat as empty queue
    }
  }

  savePending(list: PendingClear[]): void {
    if (list.length === 0) this.storage.removeItem(PENDING_CLEARS_KEY);
    else this.storage.setItem(PENDING_CLEARS_KEY, JSON.stringify(list));
  }

  /** Absorb legacy standalone keys into flags (only when the flag is not already set). */
  private absorbLegacy(save: SaveData): void {
    if (save.flags.seen_intro === undefined) {
      const legacy = this.storage.getItem(LEGACY_SEEN_INTRO_KEY);
      if (legacy) save.flags.seen_intro = true;
    }
  }
}
