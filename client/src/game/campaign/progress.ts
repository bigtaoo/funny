// 战役进度纯逻辑（PIXI 无关，便于单测）。CampaignMapScene 的解锁/落点判断从此处取，
// 保证「显示的关卡节点」与「点它进入的关卡」用同一套 levelId 推导，不会错位。

import { CAMPAIGN_LEVEL_ORDER, CHAPTER_ORDER, getChapterMap } from '../index';

/** Parse chapter number and within-chapter index from a level id like 'ch3_lv7'. */
export function parseLevelId(id: string): { chapter: number; lvIndex: number } | null {
  const m = id.match(/^ch(\d+)_lv(\d+)$/);
  if (!m) return null;
  return { chapter: parseInt(m[1], 10), lvIndex: parseInt(m[2], 10) };
}

/** A level unlocks once the previous one in the global order is cleared (level 0 free). */
export function isLevelUnlocked(levelId: string, cleared: Set<string>): boolean {
  const i = CAMPAIGN_LEVEL_ORDER.indexOf(levelId);
  if (i <= 0) return true;
  return cleared.has(CAMPAIGN_LEVEL_ORDER[i - 1]!);
}

/** Chapter holding the first uncleared level — where the book opens to (§12.2). */
export function currentChapter(cleared: Set<string>): number {
  for (const lid of CAMPAIGN_LEVEL_ORDER) {
    if (!cleared.has(lid)) return parseLevelId(lid)?.chapter ?? CHAPTER_ORDER[0]!;
  }
  return CHAPTER_ORDER[CHAPTER_ORDER.length - 1]!;
}

/**
 * The current playable level id in a chapter = its first unlocked & uncleared node.
 * Returns null when the chapter is fully cleared or has no map. Drives the pulse ring.
 */
export function currentLevelIdInChapter(chapter: number, cleared: Set<string>): string | null {
  const map = getChapterMap(chapter);
  if (!map) return null;
  return map.nodes.find((nd) => isLevelUnlocked(nd.levelId, cleared) && !cleared.has(nd.levelId))?.levelId ?? null;
}
