# Notebook Wars — 单机战役模式设计文档

> 创建：2026-06-12。本文件是战役（PvE）模式的设计基准，随实现推进同步更新。
> 配套阅读：`DESIGN.md`（引擎/系统）、`IMPROVEMENT_PLAN.md`（迭代进度）、根 `CLAUDE.md`。

---

## 0. TL;DR

- 在**现有车道推进引擎**之上叠加一套 PvE 战役，不另造塔防内核。
- 战役定位：**离线可玩**（无网络 / 弱网络时的体验）+ **角色故事探索**。
- 借鉴《保卫萝卜》的**元结构**（波次 / 守护 / 星级 / 关前编成 / 主题关 / 怪种克制），而非它的迷宫路径几何。
- 商业化：**只卖外观；可卖数值但仅影响 PvE；竞技绝对公平**。看广告产出游戏币（只用于 PvE / 皮肤）。
- 接入点：PvE 敌方由 **WaveDirector** 驱动，替换 `GameEngine` 中 `AISystem` 在 owner 1 上的角色；确定性内核与渲染层不变。

---

## 1. 背景与定位

| 维度 | 说明 |
|---|---|
| 为什么做 | 现有对战已支持玩家互打（暂用 AI 顶替对手）。战役解决「无网络 / 弱网络」也能玩，扩大受众；塔防受众本身成熟。 |
| 核心体验 | 关卡用来**探索人物故事**：每章 ≈ 一个单位的来历，打通解锁该单位剧情。叙事 + 新手引导合一。 |
| 玩法骨架 | 车道推进（columns）+ 建筑（兵营 / 箭塔）+ 卡牌 + 基地，**完全复用现有引擎**。 |
| 时长目标 | ~80 小时。**不靠堆线性关卡**（纯 50 关线性约 10–15h），靠**元系统 + 章节故事 + 无尽 / 挑战变体**撑起来。 |
| 与对战联动 | 通过**外观**联动（战役解锁皮肤可带进竞技露脸），不通过数值。详见 §3。 |

---

## 2. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 保留车道内核，移植《保卫萝卜》元结构，**不做迷宫路径塔防** | 全复用现有引擎、风险最低；车道的「动态变道」反而比静态路径更活（见 §4.2） |
| D2 | **竞技绝对公平**：PvP 卡池 / 数值来自固定平衡表，不读任何 PvE 升级 / 购买 / 货币 | 刚起步要口碑，公平是底线 |
| D3 | **只卖外观**；可卖数值但**仅作用于 PvE**；皮肤纯外观（带进竞技也只是外观） | 付费点全在 PvE，产出炫耀性资产，竞技零影响 |
| D4 | 「关卡卖数值」= 变相卖皮肤：**通关奖励对应主角专属皮肤** | 付费转化与外观收集挂钩 |
| D5 | 看广告 → 游戏币，**只能花在 PvE 养成 / 皮肤** | 与 D2/D3 自洽 |
| D6 | 路径塔防子模式（如确有需要）作为**后期特殊关卡类型**，核心战役仍走车道 | 给「一眼看穿迷宫」那种谜题留后门，但不进 v1 |

---

## 3. 商业化与公平性架构硬墙（最重要，须在写代码前埋好）

竞技公平不能靠「记得别串味」，要靠**数据来源隔离**强约束：

```
                 ┌─────────────────────────────┐
   固定平衡表 ───▶│ PvP 引擎 (GameConfig.pvp)   │  ← 永不读取下面任何东西
 (CARD_DEFINITIONS,│  roster / 数值 写死        │
  UNIT_BLUEPRINTS) └─────────────────────────────┘

   玩家存档 ───────▶ campaignProgress {
     购买的 PvE 升级、关卡解锁、货币、皮肤
   } ──▶ 只注入 PvE 引擎 (GameConfig.campaign)
```

**规则：**
- 绝不存在单一「玩家拥有的强度」字段被两个模式共用。PvP 的单位 / 卡牌数值在进入引擎时从**常量表**取，PvE 的从 `campaignProgress` 派生的**修饰层**取。
- 皮肤是**纯外观资产**：只影响渲染（贴图 / 特效），逻辑层（`game/`）不读皮肤。带进 PvP 仅换贴图。
- 货币（含广告币）只写进 `campaignProgress`，PvP 引擎构造时**不接受**该来源。
- 建议加一条单测：构造 PvP 引擎时传入「满级 campaignProgress」，断言其 `UNIT_BLUEPRINTS` 实际生效值与默认常量逐字相等，回归守护公平性。

---

## 4. 关卡变化系统（「旋钮箱」）

车道损失的只是「静态迷宫一眼看穿」，用下列**多轴变化**替代并超过它。每个旋钮标注：① 对应关卡配置字段 ② 需要的引擎改动量。

### 4.1 棋盘形态（替代「路径走向」这一个轴）

| 旋钮 | 配置字段 | 引擎改动 |
|---|---|---|
| 车道数量 / 长度不对称 | `LevelDef.activeLanes: number[]`、`LevelDef.laneLength?: Record<col, rows>` | 中：`Board` 支持禁用部分车道、缩短战斗区 |
| **不可建造 / 不可通行格**（石 / 水 / 岩浆）= 塔位覆盖谜题 | `LevelDef.cellMask: { blocked[], noBuild[] }` | 中：`Board` 加 per-cell 掩码；`processCommand` 建筑分支校验 `noBuild`；`MovementSystem` 绕过 `blocked` |
| 车道汇流（近基地收束成 chokepoint） | 用 `blocked` 格塑形即可 | 复用上一条 |

### 4.2 动态变道（用现有 Crossing 找回「蜿蜒」，且是车道相对路径 TD 的**优势**）

| 旋钮 | 配置字段 | 引擎改动 |
|---|---|---|
| 怪在指定行变道 / 绕行 / 佯攻后切路 | `WaveEntry.crossWaypoints?: { atRow, toCol }[]` | 小–中：`MovementSystem` 已有 Crossing；新增「脚本化变道航点」触发（单位到 `atRow` 时进入 Crossing 朝 `toCol`） |

> 路径会拐 → 在车道里表现为**活的、可变的进攻路线**，逼玩家动态重新分配防守。

### 4.3 塔位 + 箭塔范围（覆盖最优化）

箭塔已是 Chebyshev 全向扫描（见 `CombatSystem.findTargetForBuilding`）。配合 §4.1 的 `noBuild` 掩码，「在哪一行 / 哪一路放塔、前压还是守家」即空间决策。**无需引擎改动**，纯靠关卡布局产生深度。

### 4.4 怪种与特性（TD 深度的真正大头）

| 特性 | 实现 | 引擎改动 |
|---|---|---|
| 重甲（抗箭）/ 快攻 / 高血精英 / 海量小兵 | 新增 `UnitType` + `UNIT_BLUEPRINTS` 条目（仅 PvE 池） | 小：扩 enum + 蓝图 |
| 飞行（只有某些塔能打） | `UnitBlueprint.flying` + `Building.canTargetFlying` | 中：`CombatSystem` 寻敌过滤 |
| 死亡分裂 | `UnitBlueprint.onDeathSpawn?: { type, count }` | 中：`CombatSystem` 死亡钩子（用注入 Prng 定坐标） |
| 带盾 / 治疗 / buff 光环 | 后续扩展，预留 `traits: string[]` | 中–大：按需 |

> 怪种组合 + 克制是每关「不一样」的主力来源，**单这一项就能撑几十关新鲜感**。所有随机必须走注入 `Prng`（确定性约束，见 §9）。

### 4.5 环境机关 / 关卡修饰符（对应保卫萝卜的魔法球 / 天气 / 机关）

| 机关 | 配置字段 | 引擎改动 |
|---|---|---|
| 某路加速带 / 减射程迷雾 / 岩浆格掉血 | `LevelDef.hazards: { col, rowRange, effect }[]` | 中：新增 `HazardSystem`（每 tick 对覆盖单位施加效果），事件透传渲染 |
| 可触发滚石 / 可炸桥（玩家主动技） | `LevelDef.levelSpells?: SpellType[]`（关卡专属技能） | 中：复用 `SpellSystem` 扩新 spell |

### 4.6 目标多样化（别总是「撑过 N 波」）

| 目标类型 `LevelDef.objective` | 胜负判定 |
|---|---|
| `survive`（撑过全部波次，基地存活） | 波次放完且基地 HP>0 → 胜 |
| `timed_defense`（限时守护） | 计时器归零基地存活 → 胜 |
| `leak_limit`（漏过不超过 X 个） | 漏过计数超阈值 → 败 |
| `destroy_base`（限时拆敌方基地） | 现有胜负逻辑 + 计时 |
| `boss`（击杀 Boss 单位） | Boss `isDead` → 胜 |
| `multi_objective`（分路保护多个子目标） | 任一子目标失守 → 败 |

> `GameEngine.checkWinCondition` 需参数化为按 `objective` 分支（当前硬编码为「基地 HP 归零」）。

### 4.7 经济 / 编成约束（puzzle 式）

| 约束 | 配置字段 |
|---|---|
| 起始币 / 收入速率倍率 | `LevelDef.startCoins`、`LevelDef.coinRegenMult` |
| 禁某类卡（如「本关禁兵营」） | `LevelDef.bannedCards: cardId[]` |
| 限卡槽 / 限定卡池（关前编成） | `LevelDef.loadout: cardId[]`（覆盖默认 `CARD_DEFINITIONS`） |

---

## 5. 数据结构草案

> 与现有类型对齐：`PlayerCommand`、`UnitType`、`col/row`、tick 计时。字段名最终以实现为准。
>
> **已实现（2026-06）**：所有关卡已迁为 **JSON 单一来源**（`game/campaign/levels/*.json`），由 `game/campaign/levelSchema.ts` 的 `parseLevelDefinition` 运行时校验后注册；`game/campaign/levels.ts` 改为 import JSON。配套可视化关卡编辑器见 `tools/level-editor/DESIGN.md`。

```ts
// game/campaign/LevelDefinition.ts  （纯数据，无 PIXI）
interface LevelDefinition {
  id: string;                 // 'ch1_lv3'
  chapter: number;            // 章节（= 故事线 / 主角）
  seed: number;               // 关卡固定随机种子（确定性 + 可做同种子挑战）
  objective: ObjectiveSpec;   // §4.6
  board: {
    activeLanes: number[];                  // §4.1
    cellMask?: { blocked?: Cell[]; noBuild?: Cell[] };
  };
  hazards?: HazardSpec[];      // §4.5
  startCoins?: number;
  coinRegenMult?: number;      // §4.7
  loadout?: string[];          // 关前编成（覆盖默认卡池）
  bannedCards?: string[];
  waves: WaveScript;           // §6
  rewards: LevelRewards;       // §7
  story?: { introKey?: string; outroKey?: string }; // i18n story.* 键
}

interface WaveScript {
  entries: WaveEntry[];
}

interface WaveEntry {
  atTick: number;              // 相对开局的 tick（确定性）
  unitType: UnitType;          // 含 PvE 专属新怪种
  col: number;                 // 出生车道
  count: number;
  spacingTicks?: number;       // 同批间隔
  crossWaypoints?: { atRow: number; toCol: number }[]; // §4.2 脚本化变道
  isBoss?: boolean;
}

interface LevelRewards {
  coins?: number;
  unlockSkinId?: string;       // 通关送主角专属皮肤（D4）
  unlockStoryKey?: string;
  starThresholds: [number, number, number]; // 基地剩余 HP% → 1/2/3 星
}
```

---

## 6. 引擎接入点（WaveDirector）

**核心思路：PvE 敌方（owner 1 / top side）不再由威胁 AI 驱动，而由脚本化 WaveDirector 驱动。**

现状（`GameEngine.step`）：
```ts
const aiCmds = this.ai.decideTick(tick, this.state);   // ← owner 1 的指令来源
```

战役改造：
- `GameConfig` 增加可选 `mode: 'pvp' | 'campaign'` 与 `level?: LevelDefinition`。
- `campaign` 模式下，把 owner 1 的指令来源换成 `WaveDirector.tick(tick, state, level)`。
- WaveDirector 按 `WaveScript.entries` 在对应 `atTick` **直接出兵**（绕过敌方手牌 / 金币经济——PvE 敌人按脚本刷，不受卡牌限制），但仍走 `Board.addUnit` + 发相同的 `unit_spawned` / `unit_move_start` 事件，**渲染层零改动**。
- 玩家（owner 0）侧逻辑完全不变（出牌 / 建筑 / 升级 / 卡刷新）。

**需要参数化的现有逻辑：**

| 位置 | 现状 | 战役需要 |
|---|---|---|
| `GameEngine` 构造 | 固定 `new AISystem(...)` 驱动 owner 1 | 按 `mode` 选 `AISystem`（PvP/练习）或 `WaveDirector`（PvE） |
| `checkWinCondition` | 硬编码「基地 HP 归零」 | 按 `LevelDef.objective` 分支（§4.6） |
| `Board` | 全车道可走 / 全格可建 | 读 `cellMask`（§4.1） |
| `MovementSystem` | Crossing 由对局逻辑触发 | 支持 `crossWaypoints` 脚本化变道（§4.2） |
| 时间加速 / 强制平局 | 对战节奏（3/6/10/15/17 min） | 战役可关闭或改为按波次推进 |

> WaveDirector 与 AISystem 并列放在 `game/systems/` 或新建 `game/campaign/`。**只读 state + 注入 Prng**，保持黄金回放确定性。

---

## 7. 元系统（撑起 80 小时与留存）

| 系统 | 说明 | 数据落点 |
|---|---|---|
| 星级评分 | 按基地剩余 HP%（`starThresholds`），驱动三星重玩 | `campaignProgress.stars[levelId]` |
| 关卡解锁链 | 通关解锁下一关 / 下一章 | `campaignProgress.cleared[]` |
| 单位 / 卡牌解锁 | 章节通关解锁主角单位（仅外观 / 故事，竞技不受益） | 同上 |
| **PvE 养成（卖数值）** | 升级 PvE 单位数值，**只注入 campaign 引擎** | `campaignProgress.pveUpgrades`（硬墙，§3） |
| **皮肤** | 纯外观；通关奖励 / 付费 / 广告币兑换 | `campaignProgress.skins` |
| **广告币** | 看广告产出，只花在 PvE / 皮肤 | `campaignProgress.coins` |
| 无尽 / 挑战变体 | 同种子挑战、难度层（噩梦 / 地狱）、每关随机修饰符 | 复用 LevelDef + 修饰符 |
| 章节故事 | 复用 `IntroScene` 模式（逐行淡入 + 推进 + 跳过）+ i18n `story.*` | `story.*` 键 |

---

## 8. 关卡与章节组织（50 关骨架）

- **章节 = 主角故事线**：每章 ~8–10 关，围绕一个单位（剑士 / 弓箭兵 / 盾兵 / 后续新单位）展开来历，章末解锁该单位剧情 + 专属皮肤。
- **新机制引入节奏**：每章引入 1–2 个新怪种 / 新机关 / 新目标类型，避免第 15 关就重复。
- **难度曲线**：章内递增，章首回落引入新机制，Boss 关压轴。
- **教学合一**：解锁某单位的章节顺带教玩家在对战里怎么用它。

> 文案全部走 i18n（`zh.ts` 为键唯一来源，`en`/`de` 编译强制全翻），严禁硬编码（见 `CLAUDE.md`）。

---

## 9. 确定性约束（不可妥协）

- 战役逻辑同样在 `game/`（纯 TS），**严禁 `Math.random()`**，所有随机走注入 `Prng`（`new Prng(level.seed ^ 唯一常量)`）。
- WaveDirector / 怪种死亡分裂 / 机关随机均用 Prng，保证同 seed 关卡可复现 → 支持同种子挑战、回放、排行榜。
- 新增系统须纳入 Vitest 黄金回放测试（参照 `test/replay-determinism.test.ts`）。

---

## 10. 分期实施路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 数据结构 + WaveDirector 骨架 + `mode` 分流 + `objective=survive` | 一关「纯防守撑过 N 波」能跑通，确定性测试绿 |
| P1 | **10 关垂直切片**：cellMask + 1–2 新怪种 + 1 机关 + 星级 + 关卡选择场景 + 存档 | 完整「选关 → 编成 → 打 → 评星 → 解锁」闭环 |
| P2 | 元系统铺开：解锁链 / PvE 养成（硬墙单测）/ 皮肤 / 广告币 / 章节故事 | 商业化与公平性硬墙验证通过 |
| P3 | 扩到 50 关 + 无尽 / 挑战 / 难度层 | 内容量达标 |
| P4（可选） | §4.6 全目标类型 + 路径塔防特殊关（D6） | — |

> 先做 P0/P1 验证「好玩 + 留存」，再投入 P3 的大规模内容生产，避免一上来铺 50 关。

---

## 11. 开放问题（待定）

- [ ] PvE 养成数值的上限与曲线（既要有付费爽感，又不能让关卡失去挑战）。
- [ ] 广告币产出 / 消耗经济模型（每日上限、皮肤定价）。
- [x] 关卡编辑工作流：已定为**独立 Web 关卡编辑器**（仿 `tools/animator`），关卡统一为 JSON 单一来源、提交进仓库构建打包。设计基准见 **`tools/level-editor/DESIGN.md`**。
- [ ] 章节数量与单位扩充计划（现有 3 单位，撑 50 关需新增多少 PvE 怪种 / 玩家单位）。
- [ ] 时间加速机制在战役里保留 / 关闭 / 改造。
