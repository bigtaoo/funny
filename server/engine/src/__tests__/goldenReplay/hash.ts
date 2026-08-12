// Golden replay harness — hashing utilities.
//
// The refactor this protects (base+5-mixin GameEngine chain → setup/sim/driver split,
// see claudedocs/server.md "engine/GameEngine") must not change simulation output by
// even one bit. Comparing raw JSON fixtures would work but makes the fixture files
// enormous (every scenario runs hundreds of ticks); instead each scenario's full
// per-tick event log + final-state snapshot is reduced to a short hash, with the
// human-readable snapshot kept alongside for when a hash mismatch needs a diff.
import { createHash } from 'node:crypto';

/** Deterministic JSON.stringify — sorts object keys so field-order refactors
 *  (e.g. reordering an interface) never change the hash, only value changes do. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
