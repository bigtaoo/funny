import { ui as C, txt } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import type { IconKind } from '../../render/icons';

// Pure helpers for the equipment detail modal, split out of detail.ts to keep it under 500 lines.

/** Affix id (strip m_/s_/k_ prefix) → stat icon kind; returns null for unknown affixes. */
export function affixIconKind(affixId: string): IconKind | null {
  const stat = affixId.replace(/^[a-z]_/, '');
  if (stat === 'atk' || stat === 'hp' || stat === 'armor' || stat === 'spd' || stat === 'atkspd') return stat;
  // Batch 8: the three that used to fall through to null and draw a bare text line next to five
  // iconned ones (design/product/tab-icon-art-prompts-batch8.md). `s_critmult` strips to
  // `critmult`, matching its art's kind name.
  if (stat === 'siege' || stat === 'crit' || stat === 'critmult') return stat;
  return null;
}

/** Height `label` takes at the modal's fine-print size when wrapped to `width` (layout-only probe). */
export function wrappedHeight(label: string, width: number): number {
  const probe = txt(label, FS.micro, C.dark, false, width);
  const hh = probe.height;
  probe.destroy(true);
  return hh;
}
