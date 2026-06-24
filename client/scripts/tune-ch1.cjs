// 一次性调参脚本：把 ch1 lv2..lv10 参数化「人性化」为平滑难度爬升。
// 保留每关的 objective/loadout/rewards/seed/波次结构，只改：
//   startInk / inkRegenMult / enemyScale / 波次 atTick(整体推迟到首波≥4s) / 各波 count(按目标总量缩放)。
// 用法：node client/scripts/tune-ch1.cjs   （直接改写 levels/ch1_lvN.json）
// 系数在 POLICY 里调，反复跑 + npx vitest run difficulty 校准。
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'game', 'campaign', 'levels');

const FIRST_WAVE_TICK = 120; // 首波统一推到 4s，给布防窗口

// 逐关目标（lv2..lv10）。p=(i-2)/8 ∈[0,1] 决定爬升；这里直接写死便于手调。
// startInk/regen：经济 on-ramp，越早给得越多；hp/dmg：更缓的强度爬升；total：目标敌人总量。
// 注：survive 关(要清完场)对 AI 更难，给更多经济/更低 hp 倍率；
//     timed_defense(2/6/9) 与 boss(10) 更易，用更硬参数补偿，才能拼出单调爬升。
// 目标 min通关 平滑爬升：fresh,fresh,T2,T2,T3,T3,T4,T4,T5,T5（lv1..10）。
// survive 关(要清场)对 AI 偏难 → 经济足/血量低；timed(2/6/9)、boss(10)偏易 → 参数更硬补偿。
const POLICY = {
  2:  { startInk: 24, regen: 1.30, hp: 1.00, dmg: 1.00, total: 30 }, // timed,  fresh
  3:  { startInk: 40, regen: 1.55, hp: 1.00, dmg: 1.00, total: 22 }, // surv,   T2
  4:  { startInk: 36, regen: 1.50, hp: 1.02, dmg: 1.02, total: 24 }, // surv,   T2
  5:  { startInk: 36, regen: 1.50, hp: 1.02, dmg: 1.02, total: 24 }, // surv,   T3
  6:  { startInk: 18, regen: 1.25, hp: 1.08, dmg: 1.06, total: 46 }, // timed,  T3
  7:  { startInk: 30, regen: 1.42, hp: 1.06, dmg: 1.05, total: 30 }, // surv,   T4
  8:  { startInk: 28, regen: 1.40, hp: 1.09, dmg: 1.06, total: 34 }, // surv,   T4
  9:  { startInk: 18, regen: 1.25, hp: 1.12, dmg: 1.09, total: 50 }, // timed,  T5
  10: { startInk: 30, regen: 1.42, hp: 1.10, dmg: 1.08, total: 40 }, // boss,   T5
};

for (const [lv, pol] of Object.entries(POLICY)) {
  const file = path.join(dir, `ch1_lv${lv}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = d.waves.entries;

  // 1) 经济 + 强度
  d.startInk = pol.startInk;
  d.inkRegenMult = pol.regen;
  d.enemyScale = { hp: pol.hp, damage: pol.dmg };

  // 2) 整体推迟，使首波落在 FIRST_WAVE_TICK
  const firstTick = Math.min(...entries.map((e) => e.atTick));
  const shift = FIRST_WAVE_TICK - firstTick;
  for (const e of entries) e.atTick += shift;

  // 3) 按目标总量缩放各波 count（boss 波保留原值，最少 1）
  const curTotal = entries.reduce((s, e) => s + e.count, 0);
  const mult = pol.total / curTotal;
  let newTotal = 0;
  for (const e of entries) {
    if (!e.isBoss) e.count = Math.max(1, Math.round(e.count * mult));
    newTotal += e.count;
  }

  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`lv${lv}: startInk=${pol.startInk} regen=${pol.regen} hp×${pol.hp} dmg×${pol.dmg} 首波+${shift}t 兵${curTotal}→${newTotal}`);
}
