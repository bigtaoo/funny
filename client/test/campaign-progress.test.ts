// 战役进度/解锁纯逻辑回归（CampaignMapScene 用同一套函数）。
// 重点守护用户报的两个症状：
//   ① 「点第一小关却进了后面的关」——节点显示顺序与 levelId 必须 1:1 对齐全局顺序，
//      否则点 A 节点会进入 B 关。
//   ② 「通关后 UI 仍只解锁第一关」——cleared 集合驱动的顺序解锁与当前可玩关推导必须正确。

import { describe, it, expect } from 'vitest';
import { CAMPAIGN_LEVEL_ORDER, CHAPTER_ORDER, getChapterMap } from '../src/game';
import {
  isLevelUnlocked,
  currentChapter,
  currentLevelIdInChapter,
  parseLevelId,
} from '../src/game/campaign/progress';

describe('节点 → levelId 对齐（点哪关进哪关）', () => {
  it('每章地图节点的 levelId 严格等于该章在全局顺序中的切片，顺序一致', () => {
    for (const ch of CHAPTER_ORDER) {
      const map = getChapterMap(ch);
      expect(map, `chapter ${ch} has a map`).toBeTruthy();
      const nodeIds = map!.nodes.map((n) => n.levelId);
      const globalSlice = CAMPAIGN_LEVEL_ORDER.filter((id) => parseLevelId(id)?.chapter === ch);
      // 同集合 + 同顺序 → 第 i 个节点就是全局第 i 关；不会点 ch1_lv1 进了 ch1_lv3。
      expect(nodeIds).toEqual(globalSlice);
    }
  });

  it('点中的节点进入的就是它自身的 levelId（无错位）', () => {
    // CampaignMapScene 给每个解锁节点挂的 hit = onSelectLevel(node.levelId)，
    // 这里直接断言节点 id 即「进入的关」，配合上面的顺序对齐 = 所见即所玩。
    const ch1 = getChapterMap(1)!;
    expect(ch1.nodes[0]!.levelId).toBe('ch1_lv1');
    expect(ch1.nodes[1]!.levelId).toBe('ch1_lv2');
    expect(ch1.nodes[2]!.levelId).toBe('ch1_lv3');
  });
});

describe('顺序解锁 isLevelUnlocked', () => {
  it('空进度：只有第一关解锁', () => {
    const cleared = new Set<string>();
    expect(isLevelUnlocked('ch1_lv1', cleared)).toBe(true);
    expect(isLevelUnlocked('ch1_lv2', cleared)).toBe(false);
  });

  it('通关第一关 → 第二关解锁、第三关仍锁', () => {
    const cleared = new Set(['ch1_lv1']);
    expect(isLevelUnlocked('ch1_lv2', cleared)).toBe(true);
    expect(isLevelUnlocked('ch1_lv3', cleared)).toBe(false);
  });

  it('章末通关 → 下一章首关解锁', () => {
    const cleared = new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10)); // 整章 ch1 通关
    expect(isLevelUnlocked('ch2_lv1', cleared)).toBe(true);
  });
});

describe('当前可玩关 / 落地章（tao 通关到第二关的状态）', () => {
  const clearedThroughL2 = new Set(['ch1_lv1', 'ch1_lv2']);

  it('cleared=[L1,L2] 时：L1/L2 已通、L3 解锁且为当前可玩关、L4 仍锁', () => {
    expect(isLevelUnlocked('ch1_lv2', clearedThroughL2)).toBe(true);
    expect(isLevelUnlocked('ch1_lv3', clearedThroughL2)).toBe(true);
    expect(isLevelUnlocked('ch1_lv4', clearedThroughL2)).toBe(false);
    expect(currentLevelIdInChapter(1, clearedThroughL2)).toBe('ch1_lv3');
  });

  it('currentChapter 跟随第一个未通关的关', () => {
    expect(currentChapter(new Set())).toBe(1);
    expect(currentChapter(clearedThroughL2)).toBe(1);
    expect(currentChapter(new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10)))).toBe(2);
  });

  it('整章通关后该章无当前可玩关（返回 null）', () => {
    const allCh1 = new Set(CAMPAIGN_LEVEL_ORDER.slice(0, 10));
    expect(currentLevelIdInChapter(1, allCh1)).toBeNull();
  });
});
