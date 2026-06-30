/**
 * Library.ts — owns the effect library + active selection + debounced autosave.
 *
 * On boot it seeds the IndexedDB store from the repo's built-in effects (once),
 * restores the last-open effect, and silently persists model edits back to the
 * store. The repo JSON files remain the real source of truth; this is only the
 * in-browser working copy (DESIGN §8 write-back flow). Export writes JSON to disk; the
 * user drops it into client/src/effects/ manually.
 */
import { EffectDef } from '@vfx/types';
import { EffectModel } from '../model/EffectModel';
import { EffectRecord, ProjectStore } from './ProjectStore';

const LS_ACTIVE = 'nw-vfx:activeId';
const DEBOUNCE_MS = 1200;

export type AutosaveState = 'saved' | 'dirty' | 'saving';

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Library {
  private currentId: string | null = null;
  private dirty = false;
  private suspended = false;
  private timer: number | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly model: EffectModel,
    private readonly builtins: EffectDef[],
    private readonly onAutosave: (s: AutosaveState) => void,
    private readonly onListChange: () => void,
  ) {
    this.model.on(() => this.scheduleSave());
    window.addEventListener('beforeunload', () => { void this.flushNow(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushNow();
    });
  }

  get activeId(): string | null { return this.currentId; }

  // ── Startup ─────────────────────────────────────────────────────────────────
  async bootstrap(): Promise<void> {
    if ((await this.store.count()) === 0) {
      for (const def of this.builtins) {
        await this.store.put({ id: `builtin:${def.id}`, def, updatedAt: Date.now() });
      }
    }
    const list = await this.store.list();
    const lastId = localStorage.getItem(LS_ACTIVE);
    const target = list.find((r) => r.id === lastId) ?? list[0];
    if (target) await this.switchTo(target.id);
    this.onListChange();
  }

  async list(): Promise<EffectRecord[]> { return this.store.list(); }

  // ── Selection ─────────────────────────────────────────────────────────────
  async switchTo(id: string): Promise<void> {
    if (id === this.currentId) return;
    await this.flushNow();
    const rec = await this.store.get(id);
    if (!rec) return;
    this.suspended = true;
    this.model.loadFresh(rec.def);
    this.suspended = false;
    this.setActive(id);
    this.onAutosave('saved');
  }

  async createNew(def: EffectDef): Promise<void> {
    await this.flushNow();
    const id = genId();
    await this.store.put({ id, def, updatedAt: Date.now() });
    this.suspended = true;
    this.model.loadFresh(def);
    this.suspended = false;
    this.setActive(id);
    this.onListChange();
  }

  async duplicateActive(): Promise<void> {
    if (!this.currentId) return;
    await this.flushNow();
    const dup: EffectDef = JSON.parse(JSON.stringify(this.model.effect));
    dup.id = `${dup.id}_copy`;
    await this.createNew(dup);
  }

  async removeActive(): Promise<void> {
    if (!this.currentId) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
    await this.store.delete(this.currentId);
    this.currentId = null;
    const list = await this.store.list();
    if (list[0]) await this.switchTo(list[0].id);
    this.onListChange();
  }

  // ── Autosave ──────────────────────────────────────────────────────────────
  private setActive(id: string): void {
    this.currentId = id;
    this.dirty = false;
    localStorage.setItem(LS_ACTIVE, id);
  }

  private scheduleSave(): void {
    if (this.suspended || !this.currentId) return;
    this.dirty = true;
    this.onAutosave('dirty');
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush(); }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (!this.currentId || !this.dirty) return;
    this.onAutosave('saving');
    try {
      await this.store.put({
        id: this.currentId,
        def: JSON.parse(JSON.stringify(this.model.effect)),
        updatedAt: Date.now(),
      });
      this.dirty = false;
      this.onAutosave('saved');
      this.onListChange();
    } catch {
      /* leave dirty; next edit reschedules */
    }
  }

  private async flushNow(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) await this.flush();
  }
}
