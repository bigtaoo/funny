// Pure layer for the SLG shop price override page (SLG_DESIGN §8/G7; ADR-070 Phase 4e).
import type { SlgShopItemRow } from '../types';

type ShopKind = SlgShopItemRow['default']['kind'];

/**
 * The single numeric effect field each item kind cares about (duration_sec / each); `battle_pass` has
 * nothing worth editing beyond cost, which is why the value is nullable rather than the key optional
 * — "this kind has no effect field" is a real answer the form needs.
 */
export const EFFECT_FIELD: Record<ShopKind, { key: string; label: string } | null> = {
  troop_speedup: { key: 'duration_sec', label: 'Duration (seconds)' },
  resource_pack: { key: 'each', label: 'Amount per resource' },
  protection: { key: 'duration_sec', label: 'Duration (seconds)' },
  battle_pass: null,
};

export function effectFieldFor(kind: ShopKind): { key: string; label: string } | null {
  return EFFECT_FIELD[kind];
}

/** The effect input's starting value — blank when the effective config has no value for that key. */
export function effectInputValue(row: SlgShopItemRow, field: { key: string }): string {
  return String(row.effective.effect[field.key] ?? '');
}

/**
 * Validate + assemble one item's PUT body. The server re-validates authoritatively; this exists so a
 * typo does not cost a round trip, and because the two bounds differ in a way worth stating: a cost
 * of 0 would make the item free (rejected), while an effect of 0 is merely useless (allowed).
 *
 * Returns the error text rather than throwing so the caller can put it straight in the status slot.
 */
export function shopItemInput(
  kind: ShopKind,
  costRaw: string,
  effectRaw: string,
): { ok: true; input: { cost: number; effect?: Record<string, number> } } | { ok: false; error: string } {
  const cost = Number(costRaw);
  if (!Number.isFinite(cost) || cost <= 0) return { ok: false, error: 'cost must be a positive number' };
  const field = effectFieldFor(kind);
  if (!field) return { ok: true, input: { cost } };
  const effect = Number(effectRaw);
  if (!Number.isFinite(effect) || effect < 0) return { ok: false, error: `${field.label} must be a non-negative number` };
  return { ok: true, input: { cost, effect: { [field.key]: effect } } };
}

/** The provenance line; takes its timestamp formatter for the reason given in logic/flags.ts. */
export function shopMetaText(row: SlgShopItemRow, fmtTime: (ms: number) => string): string {
  return row.doc
    ? `Overridden by ${row.doc.updatedBy || '—'} · ${fmtTime(row.doc.updatedAt)}`
    : `Not overridden, using default (cost ${row.default.cost})`;
}
