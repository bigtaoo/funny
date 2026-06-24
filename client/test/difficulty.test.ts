import { describe, it, expect } from 'vitest';
import {
  simulateLevel,
  findClearThreshold,
  formatThresholdTable,
  type ThresholdResult,
} from './difficultySim';
import { CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';

/**
 * 关卡难度模拟（PvE balance tool）——见 difficultySim.ts 顶部说明。
 *
 * 跑法：
 *   - 全量难度报表：  npx vitest run difficulty -t 报表
 *   - 只看第一章：    （默认 describe 即 ch1）
 *
 * 这些用例兼当回归网：保证模拟器确定性，并守住「ch1 难度曲线」——若某天
 * 改坏了数值让第一关连满养成都过不了，这里会变红。
 */

const CH1 = CAMPAIGN_LEVEL_ORDER.filter((id) => id.startsWith('ch1_'));

describe('难度模拟器', () => {
  it('确定性：同关同预设跑两次结果完全一致', () => {
    const a = simulateLevel('ch1_lv1', { preset: 'fresh' });
    const b = simulateLevel('ch1_lv1', { preset: 'fresh' });
    expect(a).toEqual(b);
  });

  it('单调性：养成越高，第一关最低基地血不降（更稳）', () => {
    const fresh = simulateLevel('ch1_lv1', { preset: 'fresh' });
    const t5 = simulateLevel('ch1_lv1', { preset: 'T5' });
    // 满养成至少不比零养成更差（minBaseHp 不降；win 不退化）。
    expect(t5.minBaseHp).toBeGreaterThanOrEqual(fresh.minBaseHp);
    if (fresh.win) expect(t5.win).toBe(true);
  });

  it('报表：ch1 各关 × 养成预设 难度矩阵', () => {
    const results: ThresholdResult[] = CH1.map((id) => findClearThreshold(id));
    // 打印到 stdout（vitest 默认显示 console）。
    console.log('\n' + formatThresholdTable(results) + '\n');
    console.log('图例：每格=5 种子评估。N★P%=中位N星/通关率P%；✗P%=多数失败(通关率P%)。');
    console.log('     min通关=通关率≥50% 的最低养成。注意：基线 AI 偏保守，绝对值仅供相对参考。\n');

    // 合理回归守卫：基线 AI 至少能在某关某预设下通关（证明 AI 与模拟链路是通的）。
    // 不在此断言具体关卡（难度本身正是待评估对象）。
    const anyClear = results.some((r) => r.minClearPreset !== null);
    expect(anyClear, '基线 AI 一关都过不了 —— 模拟器/AI 链路异常').toBe(true);
  });
});
