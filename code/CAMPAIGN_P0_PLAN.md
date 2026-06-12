# 战役模式 — P0/P1 验证切片执行计划

> 创建：2026-06-12。目标：用最薄的垂直切片验证三件事——**PvE 守护循环好不好玩 / 旋钮能否造出深度 / 性能扛不扛得住**，再决定全力铺元系统与 50 关。
> 设计基准见 [`CAMPAIGN_DESIGN.md`](./CAMPAIGN_DESIGN.md)。本文件是逐步执行记录，完成一步勾一步。

## 验证目标（这三条是这个切片存在的理由）

1. **PvE 守护循环本身好玩**（≠ 已验证过的 PvP 决斗好玩）。
2. **「旋钮箱」真能造出关卡深度**（cellMask 覆盖谜题 / 动态变道 / 怪种克制玩起来不一样）。
3. **性能天花板**（塔防怪量远大于决斗，低端机 / 微信小游戏稳不稳）。

## 步骤总览

| 步 | 内容 | 验证目标 | 状态 |
|---|---|---|---|
| S1 | 引擎核心：`LevelDefinition`/`WaveDirector` + `GameConfig.mode` 分流 + survive 胜负条件 + 敌方直接出兵 helper | — | ✅ |
| S2 | 第一关定义（`ch1_lv1`，纯 survive、全车道、无机关，逐波递增 + 收尾大波） | ① | ✅ |
| S3 | 启动接线：`GameScene` 接收 level + `app.ts` `goCampaign` + 大厅「战役」按钮 + i18n 键 | ① | ✅ |
| S4 | `tsc --noEmit` + webpack 构建验证；**交付玩家体验第一关** | ① | ✅ 验证通过（tsc 干净 / 38 测试全绿 / build:web 成功），⏳ 待用户体验 |
| S5 | 第 2–3 关：分别用不同旋钮，手感对比 | ② | ✅ |
| S6 | 性能 pass：对象池审计 + 渲染批处理 + swarm 压力测试（用户要求前期引入，后期只优化） | ③ | ☐ 进行中 |

> S1–S4 先把第一关跑通交付，用户玩过确认 ① 之后再做 S5（深度）与 S6（性能）。

---

## S1 引擎核心（已完成）

新增（纯 TS，无 PIXI，纳入确定性约束）：
- `src/game/campaign/LevelDefinition.ts`：`LevelDefinition` / `WaveScript` / `WaveEntry` / `ObjectiveSpec` 等数据类型；前向兼容字段（`board.cellMask` / `startCoins` / `hazards` / `rewards` / `story`）已定义，**S1 仅消费 `seed` / `objective` / `waves`**，其余字段在 S5/S6/元系统阶段接入。
- `src/game/campaign/WaveDirector.ts`：构造时把 `WaveEntry`（含 `count`/`spacingTicks`）展开成「逐 tick 出兵事件」并排序；`tick(tick)` 返回到期的 `{unitType,col}[]`；`exhausted` 表示全部波次已放完。**只读 tick + 静态脚本**，注入 `Prng` 备用（死亡分裂 / 随机车道等后续特性）。
- `src/game/campaign/levels.ts`：`CAMPAIGN_LEVELS` 注册表 + `getLevel(id)`。

引擎改动：
- `GameConfig` 加可选 `mode?: 'pvp' | 'campaign'`（默认 `pvp`）+ `level?: LevelDefinition`。
- `GameEngine`：campaign 模式下 owner 1 由 `WaveDirector` 直接出兵（`spawnEnemyUnit`，绕过手牌/金币经济，但走相同 `unit_spawned`/`unit_move_start` 事件，渲染层零改动）；**PvP 路径逐字保持原样**（`decideTick` 仍在处理玩家命令前调用、拼接顺序不变 → 黄金回放确定性不受影响）。
- `checkWinCondition` 按 `mode` 分支：campaign 下「敌方基地被拆」或「波次放完且场上无存活敌军」判玩家胜，「己方基地被拆」判负，跳过 PvP 的倒计时/强制平局。

## S2 第一关（已完成）

`ch1_lv1`「新兵集结」：纯 survive，固定 seed，~50s 内逐波递增（剑士→弓箭兵→盾兵肉盾→收尾多车道大波），约 44 个单位。验证守护循环手感，不含机关/不可建造格（留给 S5 做深度对比）。

## S3 启动接线（已完成）

- `GameScene` 构造加可选 `opts?: { level?: LevelDefinition }`；有 level 走 campaign 引擎（用 `level.seed`），否则维持原 PvP 随机 seed。
- `app.ts` 加 `goCampaign()`；`LobbyScene` 加 `onStartCampaign` 回调 + 「战役 (试玩)」按钮。
- i18n 加 `lobby.campaign` 键（zh/en/de 全翻，编译强制）。

## S4 验证（待用户体验）

`tsc --noEmit` + webpack 构建通过后，用户在浏览器点大厅「战役 (试玩)」体验第一关，反馈守护循环手感。

---

## S5 第 2–3 关（已完成）

为低风险、视觉自证地验证「不同旋钮 → 不同玩法」，选用以下旋钮（脚本化中途变道因需新增移动模式、风险高，本步未做，留待后续）：

- **`ch1_lv2`「持久防线」— 目标变化 + 经济约束**：`timed_defense`（撑满 55s，波次不清场、持续来），压力集中在中路 4 车道；`startCoins` 给少量启动币。与 lv1「铺开清场」手感明显不同。
- **`ch1_lv3`「残页防御」— 不可建造格覆盖谜题**：撕掉中路四个建造位（`board.cellMask.noBuild` = col 3/4/7/8 @ row 0），逼玩家用边列箭塔射程覆盖中路或用兵填补。渲染层在禁建格画灰底 + ✕ 标记；`commitCardPlay` / 合法建造列 / `processCommand` 三处都排除禁建格。
- **引擎接入**：`Board` 加 `setNoBuild`/`isNoBuild`/`getNoBuildCells`；`GameEngine` campaign 构造时应用 `noBuild` 和 `startCoins`；`checkWinCondition` 已支持 `timed_defense`。
- **测试**：新增 `test/campaign.test.ts`（4 用例）——三关 run-vs-run 确定性、波次确实出敌军、lv3 禁建格生效、放任不管会掉基地血量。全套 42 测试绿。
- **待玩家确认的发现**：箭塔射程 2 + 仅 10 车道，两座塔仍能覆盖较多，lv3 更偏「受压下的受限布置」而非紧致几何最优。S5 的意义之一就是让玩家判断这个旋钮深度够不够。

> 三关均可在大厅「战役 (试玩)」下的 1 / 2 / 3 按钮进入。

## 待用户确认 / 后续

- ① 手感确认后 → S5 做 2–3 关深度对比、S6 性能 pass。
- 元系统（星级/解锁/养成/皮肤/广告币/存档）在切片验证通过后按 `CAMPAIGN_DESIGN.md` §7 铺开。
- 现阶段 campaign 下敌方仍会被发 `card_drawn`（topPlayer 手牌未用，无害）；正式化时再裁剪。
