// Campaign progress pure logic (no PIXI dependency, easy to unit-test). CampaignMapScene's
// unlock / landing-page decisions are derived from here, ensuring that the displayed level
// node and the level entered on tap use the same levelId derivation — no mismatch.

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

/**
 * SLG world-map soft gate: whether the first chapter has been cleared (all ch1 levels done).
 * This is the only feature-unlock gate (ONBOARDING_DESIGN §4).
 * The tutorial level ch0_tutorial is not in CAMPAIGN_LEVEL_ORDER and is not counted.
 */
export function isFirstChapterCleared(cleared: Set<string>): boolean {
  const ch1 = CAMPAIGN_LEVEL_ORDER.filter((id) => parseLevelId(id)?.chapter === 1);
  return ch1.length > 0 && ch1.every((id) => cleared.has(id));
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
