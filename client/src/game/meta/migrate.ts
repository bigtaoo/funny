// Save migration chain (S0-2). Accepts any incomplete / outdated object and fills it up to the current SAVE_VERSION.
// META_DESIGN.md §3.2: embed version + migration chain from day one; otherwise field changes will invalidate old saves.
//
// Convention: MIGRATIONS[i] upgrades a version-i object to version i+1 (mutates in place and returns it).
// A trailing fillDefaults pass defensively backfills any missing fields (tolerates cross-version gaps), then pins the version.


import { makeNewSave, SAVE_VERSION, type SaveData } from './SaveData';

type AnyObj = Record<string, unknown>;

/**
 * Version migration steps. Currently only v0→v1 (v0 = pre-history objects with no version field, or incomplete objects).
 * When adding a new field: write a vN→vN+1 step that supplies the field's default value, and increment SAVE_VERSION by 1.
 */
const MIGRATIONS: Array<(d: AnyObj) => AnyObj> = [
  // v0 → v1: normalize any pre-history object into v1 shape (missing fields backfilled by fillDefaults).
  (d) => {
    d.version = 1;
    return d;
  },
  // v1 → v2: equipment system E0. equipmentInv / gear are additive-only fields; fillDefaults backfills them
  // from makeNewSave defaults ({}), so no explicit write is needed here — just pin the version number.
  (d) => {
    d.version = 2;
    return d;
  },
  // v2 → v3: unit progression rework (S12). unitLevels / cardInventory are additive-only fields; fillDefaults backfills them with {};
  // the game is not yet live and there are no real saves, so old pveUpgrades are not converted to unitLevels (progression restarts from L1). Just pin the version number.
  (d) => {
    d.version = 3;
    return d;
  },
];

/** Deep-merge defaults: keys missing from obj are filled from def; existing keys are kept (objects recurse, arrays/scalars are kept as-is). */
function fillDefaults<T>(obj: unknown, def: T): T {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    // scalar / array: use the default only if the value is missing (undefined)
    return (obj === undefined ? def : (obj as T));
  }
  const src = (obj && typeof obj === 'object' ? obj : {}) as AnyObj;
  const out: AnyObj = {};
  for (const k of Object.keys(def as AnyObj)) {
    out[k] = fillDefaults(src[k], (def as AnyObj)[k]);
  }
  // Preserve extra keys beyond those in def (e.g. dynamic levelId entries in best, custom flags)
  for (const k of Object.keys(src)) {
    if (!(k in out)) out[k] = src[k];
  }
  return out as T;
}

/**
 * Migrates a raw object (from localStorage / cloud / null) to a complete SaveData at the current version.
 * - null / non-object → brand-new save
 * - old version → upgrade sequentially through MIGRATIONS
 * - any missing fields → backfilled by fillDefaults
 */
export function migrate(raw: unknown): SaveData {
  if (!raw || typeof raw !== 'object') {
    return makeNewSave();
  }
  let d = { ...(raw as AnyObj) };
  let v = typeof d.version === 'number' ? d.version : 0;

  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break; // no corresponding step (should not happen) — let fillDefaults handle it
    d = step(d);
    v = typeof d.version === 'number' ? d.version : v + 1;
  }

  // Defensive backfill + pin current version (tolerates future rollbacks / incomplete saves).
  const filled = fillDefaults<SaveData>(d, makeNewSave());
  filled.version = SAVE_VERSION;
  return filled;
}
