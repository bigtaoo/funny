# 战役星级评分：复合评分轴（Composite Star Scoring）

> 关联：`CAMPAIGN_DESIGN.md §星级评分`、`DIFFICULTY_SIM.md`、`PVE_INTEGRITY_PLAN.md §8`。
> 代码单一来源：`client/src/game/meta/campaignRewards.ts`（`computeStars`），
> 客户端结算 / 裁判复算 / 难度模拟器三处共用同一函数、同一 ctx 构造口径。

## 为什么要换轴

旧评分以**基地剩余 HP%** 为唯一轴（`starThresholds = [1★,2★,3★]` 的 HP% 门槛，
3★ 恒为 100% = 无失血）。塔防里「防线成立 = 一个不漏 = 基地满血」，于是
**一旦能守住就等于 3★**，2★(65–99%)/1★(1–64%) 帯几乎为空——星级分布二极化，
体感「通关即三星、三星之间没有梯度」。数字调门槛救不了：只要轴是 HP%，分布就二极化。

**根因还与「关卡太简单」耦合**：敌人啃不到基地 → HP 恒 100% → 二极化被进一步放大。
所以本次同时**上调难度**（让 HP 重新变成活梯度）+ **换成复合轴**（进攻类关卡即便守得
完美也按通关速度分档）。

## 复合评分模型

星 = 归一化综合分 `S ∈ [0,1]` 映射到档位。**通关保底 1★**（基地未被打爆），
基地被打爆 = 失败 = 0★（不入账、不解锁）——与旧逻辑一致。

### 三个子分（各归一到 [0,1]，越大越好）

| 子分 | 公式 | 数据来源 |
|---|---|---|
| `hpScore` | `remainingHpPct / 100` | `stats[0].damageTakenByBase`（护送关改用护送单位残血% `escortHpPct`）|
| `speedScore` | `clamp((parTicks − elapsedTicks) / (parTicks − floorTicks), 0, 1)` | `elapsedTicks` + 从 `waves` 推导的 par |
| `leakScore` | `1 − clamp(enemyLeaks / leakBudget, 0, 1)` | `enemyLeaks` + `objective.maxLeaks` |
| `killScore` | `clamp(unitsKilled / totalEnemies, 0, 1)` | `stats[0].unitsKilled` + `countEnemies(level)`（timed_defense 只算计时内应刷的敌人）|

**为什么 timed_defense 需要 `killScore`**：这类关时长固定 → 用时恒 = `durationTicks`，speed 无意义；
而基地不回血，所有 HP 类指标都塌成同一个「终局残血」→ 偏易时又是二极化。歼灭率（清掉整波的
比例）是唯一能在「基地满血」时仍区分「压制清场 vs 勉强堵住」的技术轴，故 timed_defense 用
hp + kill 各半。`unitsKilled` 已在 `PlayerStats`，三处调用点都拿得到，**无需额外引擎 plumbing**。

### par-time 推导（纯从 waves 推，无需 authored 字段）

```
lastSpawnTick = max over waves of (atTick + max(0, count-1) * (spacingTicks ?? 0))
floorTicks    = lastSpawnTick * SPEED_FLOOR_MULT   // ≤ 此用时 → speedScore 1.0
parTicks      = lastSpawnTick * SPEED_PAR_MULT     // ≥ 此用时 → speedScore 0
```

- 相对倍率（不是固定常数）→ 长关自动获得成比例的清场宽限，跨 61 关鲁棒。
- `destroy_base` 可在 `lastSpawnTick` 之前抢攻破敌方本阵 → `elapsedTicks < floorTicks`
  → speedScore 夹到 1.0（奖励速攻），符合直觉。
- 初值 `SPEED_FLOOR_MULT = 1.05`、`SPEED_PAR_MULT = 1.60`，随难度重调用 `DIFFICULTY_SIM`
  校准到星级真正散开。

### 按关型加权（权重和 = 1）

| 关型 | wHp | wSpeed | wLeak | wKill | 说明 |
|---|---|---|---|---|---|
| `survive` | 0.5 | 0.5 | — | — | 守稳 + 清快 |
| `destroy_base` | 0.35 | 0.65 | — | — | 主看多快攻破敌方本阵 |
| `boss` | 0.4 | 0.6 | — | — | 速杀 boss |
| `timed_defense` | 0.5 | — | — | 0.5 | 时长固定、速度无意义；hp + 歼灭率各半，守稳且清场压制才 3★ |
| `leak_limit` | 0.4 | — | 0.6 | — | 漏得越少越高 |
| `escort` | 0.6 | 0.4 | — | — | hp 分 = 护送单位残血%，再叠通关速度 |

### 档位映射

```
S100 = round(S * 100)
3★  if S100 ≥ thresholds[2]   (默认 80)
2★  if S100 ≥ thresholds[1]   (默认 50)
1★  通关保底（S100 ≥ thresholds[0]，默认 1）
0★  基地被打爆
```

`rewards.starThresholds` 数组形状不变（schema / 编辑器 / 存档零结构改动），
**语义从「HP% 门槛」改为「综合分 ×100 门槛」**。全 61 关统一重设为 `[1, 50, 80]`；
每关差异化交给 par-time（波次推导）+ 难度旋钮，不再每关手填 HP 档。

## ctx 构造（三处调用点同口径）

`computeStars(thresholds, ctx)`，`ctx = StarContext`：

```ts
interface StarContext {
  objectiveKind: ObjectiveSpec['kind'];
  remainingHpPct: number;   // 100 - damageTakenByBase（clamp 0..100）
  elapsedTicks: number;
  floorTicks: number;       // 从 level.waves 推
  parTicks: number;         // 从 level.waves 推
  enemyLeaks: number;
  leakBudget: number;       // leak_limit → objective.maxLeaks，其余给一个非零占位
  escortHpPct: number | null; // escort 关：min(escort.hp/maxHp)*100；否则 null
  unitsKilled: number;      // timed_defense 歼灭率分子（stats.unitsKilled）
  totalEnemies: number;     // timed_defense 歼灭率分母（countEnemies(level)，计时内应刷敌人数）
}
```

- **裁判**（`judgeRunner.ts`，权威）：直接从 `engine.state` 读全部字段（`elapsedTicks` /
  `enemyLeaks` / `escorts` / `snapshotStats`）。
- **模拟器**（`difficultySim.ts`）：`SimResult` 已带 `ticks` / `finalBaseHp` /
  `escortMinHp` / `enemyLeaks`，直接组装。
- **客户端结算**（`app/nav/game.ts`）：`onGameEnd` 只有 `stats`，缺 `elapsedTicks` /
  `enemyLeaks`；故扩展 `game_stats` 引擎事件附带比赛级摘要
  `{ elapsedTicks, enemyLeaks, escortMinHpPct }` 透传（对 PvP `matchStateHash` 无影响——
  哈希只含 `{winner, stats}`，摘要不进 `PlayerStats`）。

`floorTicks` / `parTicks` 由 `deriveParTicks(level)` 从 `level.waves` 计算，三处共用。

## 与难度重调的关系

难度上调（`enemyScale` / 经济 / 波次量，沿用 `tune-*.cjs` + `difficulty.test.ts`）
与本轴改动**一起做**：前者让 `hpScore`（防御类）重新分散，后者让进攻类按 `speedScore`
分档。目标是 `difficulty.test.ts` 全 61 关矩阵里星级**真正散开**（同一养成档下不再一律 3★，
出现干净的 1★→2★→3★ 阶梯）。
