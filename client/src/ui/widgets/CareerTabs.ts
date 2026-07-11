/**
 * CareerTabs.ts — the [Stats|Titles|Achievements] peer-tab strip shared by StatsScene, TitlesScene, and
 * AchievementScene (the "Career" hub). Each member scene draws this same strip with itself marked
 * active, mirroring the EquipmentScene/CollectionScene peerTab convention documented in HubTabs.ts:
 * before this, Titles/Achievements were wired as plain launchers with no return strip, so opening
 * one from StatsScene made the *other* tab vanish entirely instead of reading as a sibling of one hub.
 */
import * as PIXI from 'pixi.js-legacy';
import type { Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { drawSidebarTabs, type HubTab } from './HubTabs';

export type CareerTabKey = 'stats' | 'titles' | 'achievements';

export interface CareerNavCallbacks {
  onOpenStats(): void;
  onOpenTitles(): void;
  onOpenAchievements(): void;
  /** Red dot on the achievements tab when any tier is claimable. */
  hasClaimableAchievement?: boolean;
}

export function drawCareerTabs(
  container: PIXI.Container,
  sidebarW: number,
  y: number,
  h: number,
  active: CareerTabKey,
  cb: CareerNavCallbacks,
): { hits: Array<{ rect: Rect; fn: () => void }>; bottom: number } {
  const tabs: HubTab[] = [
    { label: t('stats.title'), active: active === 'stats', icon: 'book' },
    { label: t('stats.titles'), active: active === 'titles', icon: 'medal' },
    { label: t('stats.achievements'), active: active === 'achievements', icon: 'trophy', badge: !!cb.hasClaimableAchievement },
  ];
  return drawSidebarTabs(container, sidebarW, y, h, tabs, (i) => {
    if (i === 0) cb.onOpenStats();
    else if (i === 1) cb.onOpenTitles();
    else cb.onOpenAchievements();
  });
}
