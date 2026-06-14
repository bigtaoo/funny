/**
 * Local replay persistence (S1-RP).
 *
 * Single-player recordings (the player's confirmed command stream) are tiny —
 * a `Replay` is seed + config + a sparse input log — so we keep a small ring of
 * the most recent ones in {@link IStorage} under one key. This is deliberately
 * separate from `SaveData`/`SaveStore`: replays are local artifacts, not a
 * cloud-synced save segment (sharing/upload is a later task).
 *
 * Stored shape (JSON):
 *   { entries: [ { id, recordedAt, mode, levelId?, winner?, replay }, … ] }
 * newest last; on save the oldest are evicted past {@link MAX_REPLAYS}.
 */

import type { IStorage } from '../../platform/IPlatform';
import type { Replay } from '../types';

export const REPLAY_STORAGE_KEY = 'nw_replays_v1';

/** How many recent replays to retain locally (ring buffer). */
export const MAX_REPLAYS = 12;

/** A lightweight index row — enough to list replays without loading every stream. */
export interface ReplayEntry {
  id: string;
  recordedAt: number;
  mode: Replay['mode'];
  levelId?: string;
  /** Winner side (0/1), -1 = draw/unknown. */
  winner?: number;
}

interface StoredEntry extends ReplayEntry {
  replay: Replay;
}

interface StoredFile {
  entries: StoredEntry[];
}

export class ReplayStore {
  constructor(private readonly storage: IStorage) {}

  /** Index of stored replays, newest first. */
  list(): ReplayEntry[] {
    const file = this.read();
    return file.entries
      .map(({ replay: _replay, ...meta }) => meta)
      .reverse();
  }

  /** The most recent replay, or null if none recorded. */
  latest(): Replay | null {
    const file = this.read();
    const last = file.entries[file.entries.length - 1];
    return last ? last.replay : null;
  }

  /** Load a replay by id. */
  load(id: string): Replay | null {
    const file = this.read();
    return file.entries.find((e) => e.id === id)?.replay ?? null;
  }

  /**
   * Persist a replay; returns the assigned id. `recordedAt` doubles as the id
   * (caller supplies it so the deterministic engine never touches Date.now()).
   * Evicts the oldest entries beyond {@link MAX_REPLAYS}.
   */
  save(replay: Replay, recordedAt: number): string {
    const file = this.read();
    const id = `r${recordedAt}`;
    const entry: StoredEntry = {
      id,
      recordedAt,
      mode: replay.mode,
      ...(replay.meta?.levelId !== undefined ? { levelId: replay.meta.levelId } : {}),
      ...(replay.meta?.winner !== undefined ? { winner: replay.meta.winner } : {}),
      replay,
    };
    file.entries.push(entry);
    while (file.entries.length > MAX_REPLAYS) file.entries.shift();
    this.storage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(file));
    return id;
  }

  clear(): void {
    this.storage.removeItem(REPLAY_STORAGE_KEY);
  }

  private read(): StoredFile {
    const text = this.storage.getItem(REPLAY_STORAGE_KEY);
    if (!text) return { entries: [] };
    try {
      const parsed = JSON.parse(text) as Partial<StoredFile>;
      if (parsed && Array.isArray(parsed.entries)) return { entries: parsed.entries };
    } catch {
      /* corrupt → treat as empty */
    }
    return { entries: [] };
  }
}
