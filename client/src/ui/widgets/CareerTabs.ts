/**
 * CareerTabs.ts — the [Stats|Titles|Codex|Achievements] peer-tab strip shared by StatsScene,
 * TitlesScene, AchievementScene, and CardCodexScene (the "Career" hub). Each member scene draws this
 * same strip with itself marked active, mirroring the EquipmentScene/CollectionScene peerTab
 * convention documented in HubTabs.ts: before this, Titles/Achievements were wired as plain launchers
 * with no return strip, so opening one from StatsScene made the *other* tab vanish entirely instead of
 * reading as a sibling of one hub. Codex (the read-only card compendium) joined the hub when
 * CollectionScene was retired (LOBBY_IA_REDESIGN §15) — it's "my goals/collection", the same family as
 * titles/achievements, not an operation on my roster (that stays in CardScene/"Develop").
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from './HubTabs';

export type CareerTabKey = 'stats' | 'titles' | 'achievements' | 'codex';

export interface CareerNavCallbacks {
  onOpenStats(): void;
  onOpenTitles(): void;
  onOpenAchievements(): void;
  onOpenCodex(): void;
  /** Red dot on the achievements tab when any tier is claimable. */
  hasClaimableAchievement?: boolean;
}

/**
 * Landscape draws this as the left-rail peer strip at `sidebarNavW(w,h,true)`, positioned at `y`
 * (below the header). Portrait draws it as the bottom nav bar instead (LOBBY_IA_REDESIGN.md §18);
 * `y` is unused there since the bar is always pinned to the screen edge. `bottom` in the portrait
 * case is the bar's own top edge (`h - bottomNavH(h)`) — nothing stacks below a bottom nav bar, but
 * callers that used the landscape `bottom` to place a nested sub-strip still get a sane value.
 */
export function drawCareerTabs(
  container: PIXI.Container,
  w: number,
  h: number,
  landscape: boolean,
  y: number,
  active: CareerTabKey,
  cb: CareerNavCallbacks,
): { hits: Array<{ rect: Rect; fn: () => void }>; bottom: number } {
  // Order note: Achievements sits LAST so its own category sub-tabs (pve/pvp/collection/progression,
  // drawn by AchievementScene directly beneath this strip in landscape / in a header strip in
  // portrait) read as nested under the Achievements cell. When Achievements was 3rd and Collection
  // 4th, those sub-tabs appeared below the Collection cell and looked like they belonged to
  // Collection instead (reported 14.07.2026).
  const tabs: HubTab[] = [
    { label: t('stats.title'), active: active === 'stats', icon: 'book' },
    // 'medal' freed up for LeaderboardScene's tinted rank-1/2/3 glyph only (AI art batch 2 dedupe) —
    // this tab gets its own new icon (laurel wreath) instead.
    { label: t('stats.titles'), active: active === 'titles', icon: 'honorTabIcon' },
    // 'cards' generic glyph → rosterIcon (AI art pilot batch 2, design/product/tab-icon-art-prompts.md
    // §batch2): the codex is a card compendium, same "卡" concept the roster tab's AI icon already draws.
    { label: t('collection.title'), active: active === 'codex', icon: 'rosterIcon' },
    { label: t('stats.achievements'), active: active === 'achievements', icon: 'trophy', badge: !!cb.hasClaimableAchievement },
  ];
  const onSelect = (i: number) => {
    if (i === 0) cb.onOpenStats();
    else if (i === 1) cb.onOpenTitles();
    else if (i === 2) cb.onOpenCodex();
    else cb.onOpenAchievements();
  };

  if (!landscape) {
    const barH = bottomNavH(h);
    const barY = h - barH;
    const { hits } = drawBottomNavTabs(container, w, barY, barH, tabs, onSelect);
    return { hits, bottom: barY };
  }

  const sidebarW = sidebarNavW(w, h, true);
  return drawSidebarTabs(container, sidebarW, y, h, tabs, onSelect);
}
