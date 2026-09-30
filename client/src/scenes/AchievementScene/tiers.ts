import type { Achievement } from '../../net/ApiClient';
import { ui as C, txt } from '../../render/sketchUi';
import type { IconKind } from '../../render/icons';
import { measuredWidth } from '../../render/pixiText';

// Category and tier constants for AchievementScene, split out to keep the scene under 500 lines.

// collection/progression moved off 'brush'/'trophy' to their own AI icons (AI art batch 2 dedupe,
// design/product/tab-icon-art-prompts.md §batch2) — 'brush' meant "皮肤" elsewhere (now skinIcon), not
// "收藏进度", and 'trophy' stays reserved for Career's Achievements tab (the parent of this category strip).
// pve/pvp moved off 'book'/'swords' to their own AI icons too (AI art batch 3): batch 2's judgment
// table missed that 'book' had a 3rd usage here (Career's "stats" tab reuses statsTabIcon instead, see
// CareerTabs.ts, so 'book' was never actually free) — pve gets a treasure-map scroll, distinct from the
// book/stats-chart glyphs elsewhere in this same Career hub; pvp gets a crossed-swords AI icon as a pure
// recognizability upgrade (no reuse conflict — 'swords' elsewhere is only ever a content badge/action icon).
/** Category → hand-drawn tab glyph (pve = treasure map, pvp = crossed swords, collection = jigsaw puzzle piece, progression = stacked chevrons). */
export const CATEGORY_ICON: Record<Achievement['category'], IconKind> = {
  pve: 'pveTabIcon',
  pvp: 'pvpTabIcon',
  collection: 'collectionTabIcon',
  progression: 'progressTabIcon',
};

/** Category tab order (categories with no achievements are auto-hidden). */
export const CATEGORY_ORDER: Achievement['category'][] = ['pve', 'pvp', 'collection', 'progression'];

export const TIER_LABELS = ['I', 'II', 'III'];

/** Width of the widest tier label at `fontSize`, cached per size (every row of every card asks). */
const tierLabelW = new Map<number, number>();
export function widestTierLabelW(fontSize: number): number {
  let w = tierLabelW.get(fontSize);
  if (w === undefined) {
    w = 0;
    for (const lbl of TIER_LABELS) {
      const probe = txt(lbl, fontSize, C.dark, true);
      w = Math.max(w, measuredWidth(probe));
      probe.destroy({ texture: true, baseTexture: true });
    }
    tierLabelW.set(fontSize, w);
  }
  return w;
}
