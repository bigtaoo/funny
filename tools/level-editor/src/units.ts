import { UnitType } from '@game/types';

/**
 * Editor-side display metadata for unit types.
 *
 * The list of valid unit types is owned by the game (`UnitType`); this only adds
 * a label + colour for rendering timeline blocks and the palette. New PvE unit
 * types added to the enum fall back to a neutral colour and their raw value as
 * the label until given an entry here.
 */
export interface UnitMeta {
  type: UnitType;
  label: string;
  color: string;
}

const META: Partial<Record<UnitType, { label: string; color: string }>> = {
  [UnitType.Swordsman]: { label: '剑士', color: '#89b4fa' },
  [UnitType.Archer]: { label: '弓箭', color: '#a6e3a1' },
  [UnitType.Guardian]: { label: '守卫', color: '#f9e2af' },
};

const FALLBACK = { label: '', color: '#bac2de' };

export function unitMeta(type: UnitType): UnitMeta {
  const m = META[type] ?? { ...FALLBACK, label: String(type) };
  return { type, label: m.label, color: m.color };
}

/** All unit types, in enum declaration order — drives the palette / dropdowns. */
export const ALL_UNITS: UnitMeta[] = Object.values(UnitType).map(unitMeta);
