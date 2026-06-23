import { describe, it } from 'vitest';
import { simulateLevel, type SimResult } from './difficultySim';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

/**
 * 调参实验：用模拟器 A/B 测「怎么改才能让第一关对零养成新手公平」。
 * 每个变体都用同一个基线 AI、fresh 养成跑，看能否通关 + 险不险。
 */

function clone(level: LevelDefinition): LevelDefinition {
  return JSON.parse(JSON.stringify(level));
}

// 把所有波次延后 dTick、count 乘以 mult（向下取整，至少 1）
function rescaleWaves(level: LevelDefinition, delayTicks: number, countMult: number): void {
  for (const e of level.waves.entries) {
    e.atTick += delayTicks;
    e.count = Math.max(1, Math.floor(e.count * countMult));
  }
}

describe('ch1_lv1 调参实验（fresh + 基线AI）', () => {
  it('对比各下调方案', () => {
    const base = CAMPAIGN_LEVELS['ch1_lv1']!;

    const variants: { name: string; level: LevelDefinition }[] = [];

    // 0) 原版
    variants.push({ name: '原版(as-is)', level: base });

    // 1) 只给经济：起始墨 + 回墨翻倍
    {
      const l = clone(base);
      l.startInk = 40;
      l.inkRegenMult = 2;
      variants.push({ name: '经济A startInk40/回墨×2', level: l });
    }

    // 2) 经济更猛
    {
      const l = clone(base);
      l.startInk = 60;
      l.inkRegenMult = 2.5;
      variants.push({ name: '经济B startInk60/回墨×2.5', level: l });
    }

    // 3) 只调节奏：开局推迟到 5s，波次数量×0.6
    {
      const l = clone(base);
      rescaleWaves(l, 90, 0.6); // +3s 缓冲 + 砍 40% 兵
      variants.push({ name: '节奏 推迟3s+兵量×0.6', level: l });
    }

    // 4) 只调敌人强度：HP×0.6
    {
      const l = clone(base);
      l.enemyScale = { hp: 0.6, damage: 1 };
      variants.push({ name: '强度 敌HP×0.6', level: l });
    }

    // 探针) 极端经济：起始墨200 + 回墨×5（定位墨水是不是唯一瓶颈）
    {
      const l = clone(base);
      l.startInk = 200;
      l.inkRegenMult = 5;
      variants.push({ name: '探针 极端经济(墨200/×5)', level: l });
    }

    // 5) 温和组合：起始墨30/回墨×1.5 + 兵量×0.75 + 推迟2s
    {
      const l = clone(base);
      l.startInk = 30;
      l.inkRegenMult = 1.5;
      rescaleWaves(l, 60, 0.75);
      variants.push({ name: '组合 经济+节奏(温和)', level: l });
    }

    // 推荐A：只动节奏/兵量（不碰经济数值，最“干净”）——推迟5s + 兵量×0.5
    {
      const l = clone(base);
      rescaleWaves(l, 150, 0.5);
      variants.push({ name: '推荐A 推迟5s+兵量×0.5', level: l });
    }

    // 推荐B：节奏 + 小经济头 + 略降强度（更友好的新手档）
    {
      const l = clone(base);
      l.startInk = 30;
      l.inkRegenMult = 1.3;
      l.enemyScale = { hp: 0.85, damage: 1 };
      rescaleWaves(l, 120, 0.55);
      variants.push({ name: '推荐B 节奏+起手墨30+敌HP0.85', level: l });
    }

    const rows: { name: string; r: SimResult }[] = variants.map((v) => ({
      name: v.name,
      r: simulateLevel(v.level, { preset: 'fresh' }),
    }));

    console.log('\n变体                          | 结果 | 结束血 | 最低血 | 撑时长 | 峰值敌');
    console.log('-'.repeat(78));
    for (const { name, r } of rows) {
      const res = r.win ? '✓通关' : '✗失败';
      console.log(
        `${name.padEnd(30)}| ${res} | ${String(r.finalBaseHp).padStart(5)} | ${String(r.minBaseHp).padStart(5)} | ${String(r.seconds).padStart(5)}s | ${String(r.peakEnemies).padStart(4)}`
      );
    }
    console.log('\n目标：✓通关且最低血有余量(>20)= 公平；✓但最低血很低=偏难但可过；✗=过不了\n');
  });
});
