// Pure logic regression tests for campaign progress/unlock (CampaignMapScene uses the same functions).
// Guards against two user-reported symptoms:
//   ① "Tapping the first level enters a later level" — the node display order must be 1:1 aligned with levelId global order;
//      otherwise tapping node A enters level B.
//   ② "UI only unlocks the first level even after completing it" — the sequential unlock driven by the cleared set and the derivation of the current playable level must be correct.

import { describe, it, expect } from 'vitest';
import { CAMPAIGN_LEVEL_ORDER, CHAPTER_ORDER, getChapterMap } from '../src/game';
import {
  isLevelUnlocked,
  currentChapter,
  currentLevelIdInChapter,
  parseLevelId,
} from '../src/game/campaign/progress';

describe('Node → levelId alignment (tap a level, enter that level)', () => {
  it('levelIds of each chapter map node strictly equal the slice of the global order for that chapter, in the same sequence', () => {
    for (const ch of CHAPTER_ORDER) {
      const map = getChapterMap(ch);
      expect(map, `chapter ${ch} has a map`).toBeTruthy();
      const nodeIds = map!.nodes.map((n) => n.levelId);
      const globalSlice = CAMPAIGN_LEVEL_ORDER.filter((id) => parseLevelId(id)?.chapter === ch);
      // Same set + same order → the i-th node is the i-th global level; tapping ch1_lv1 cannot enter ch1_lv3.
      expect(nodeIds).toEqual(globalSlice);
    }
  });

  it('tapping a node enters the level identified by its own levelId (no offset)', () => {
    // CampaignMapScene attaches hit = onSelectLevel(node.levelId) to each unlocked node.
    // Here we assert directly that a node's id is the level entered; combined with the ordering check above, what you see is what you play.
    const ch1 = getChapterMap(1)!;
    expect(ch1.nodes[0]!.levelId).toBe('ch1_lv1');
    expect(ch1.nodes[1]!.levelId).toBe('ch1_lv2');
    expect(ch1.nodes[2]!.levelId).toBe('ch1_lv3');
  });
});

describe('Sequential unlock isLevelUnlocked', () => {
  it('empty progress: only the first level is unlocked', () => {
    const cleared = new Set<string>();
    expect(isLevelUnlocked('ch1_lv1', cleared)).toBe(true);
    expect(isLevelUnlocked('ch1_lv2', cleared)).toBe(false);
  });

  it('clearing the first level → second level unlocked, third level still locked', () => {
    const cleared = new Set(['ch1_lv1']);
    expect(isLevelUnlocked('ch1_lv2', cleared)).toBe(true);
    expect(isLevelUnlocked('ch1_lv3', cleared)).toBe(false);
  });

  it('clearing the final level of a chapter → first level of the next chapter unlocked', () => {
    const cleared = new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10)); // entire chapter ch1 cleared
    expect(isLevelUnlocked('ch2_lv1', cleared)).toBe(true);
  });
});

describe('Current playable level / landing chapter (tao cleared through the second level)', () => {
  const clearedThroughL2 = new Set(['ch1_lv1', 'ch1_lv2']);

  it('cleared=[L1,L2]: L1/L2 already cleared, L3 unlocked and is the current playable level, L4 still locked', () => {
    expect(isLevelUnlocked('ch1_lv2', clearedThroughL2)).toBe(true);
    expect(isLevelUnlocked('ch1_lv3', clearedThroughL2)).toBe(true);
    expect(isLevelUnlocked('ch1_lv4', clearedThroughL2)).toBe(false);
    expect(currentLevelIdInChapter(1, clearedThroughL2)).toBe('ch1_lv3');
  });

  it('currentChapter follows the first level that has not been cleared', () => {
    expect(currentChapter(new Set())).toBe(1);
    expect(currentChapter(clearedThroughL2)).toBe(1);
    expect(currentChapter(new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10)))).toBe(2);
  });

  it('after clearing a full chapter there is no current playable level in that chapter (returns null)', () => {
    const allCh1 = new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10));
    expect(currentLevelIdInChapter(1, allCh1)).toBeNull();
  });
});
