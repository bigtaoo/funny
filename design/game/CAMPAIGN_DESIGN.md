# Notebook Wars — 单机战役模式设计文档

> 创建：2026-06-12。本文件是战役（PvE）模式的设计基准，随实现推进同步更新。
> 配套阅读：`DESIGN.md`（引擎/系统）、`IMPROVEMENT_PLAN.md`（迭代进度）、根 `../../CLAUDE.md`。

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

> **已实现（2026-06）**：`UnitType.Ironclad`（重甲 hp260/spd0.5/radius520，抗箭逼陨石/近战）、`UnitType.Runner`（疾行 hp26/spd1.9/radius250，小半径真正成团）已落地——纯加 enum + 蓝图 + 渲染色 + 编辑器调色板 META，**无 `CardDefinition` 故永不进 PvP 池**（公平硬墙不破）。前三关已按 §4.4a 原则重写。
>
> **已实现（2026-06-18，新 4 种 PvE 专属单位）**：
> - `UnitType.Harpy`（flying hp22/spd2.2/radius210，只有箭塔+弓手能打，绕过 blocked 格）→ 首入 ch3_lv3；后续复用：ch6_lv4/ch6_lv5/ch6_lv7/ch6_lv9/ch6_lv10（+ch5_lv8 末段）
> - `UnitType.Berserker`（hp95/spd1.1/radius420，berserkerThreshold:0.4 — HP<40% 攻速×1.5）→ 首入 ch3_lv7；后续复用：ch5_lv6/ch6_lv2/ch6_lv4/ch6_lv8/ch6_lv9/ch6_lv10
> - `UnitType.Splitter`（hp55/spd0.8/radius470，onDeathSpawn:Runner×2）→ 首入 ch4_lv5；后续复用：ch5_lv8/ch6_lv7/ch6_lv10
> - `UnitType.Medic`（hp90/spd0.55/radius440，aura_heal radius:2 hps:8，无攻击）→ 首入 ch4_lv9；后续复用：ch5_lv9/ch6_lv5/ch6_lv6/ch6_lv8/ch6_lv10

#### 4.4b 飞行系统（PvP + PvE）

> **已实现（2026-06-18）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `UnitBlueprint.flying` | `boolean` | 单位是飞行单位，地面单位寻敌时跳过飞行目标 |
| `UnitBlueprint.canTargetFlying` | `boolean` | 单位可以打飞行目标（弓箭手 = true，步兵 / 盾兵 = false） |
| `BuildingBlueprint.canTargetFlying` | `boolean` | 建筑可打飞行目标（箭塔 = true，兵营 = false） |

**实现细节：**
- `MovementSystem.moveForward`：`unit.flying` 时跳过 blocked 格检测（直接飞越）
- `Board.getFriendlyUnitAhead`：`other.flying !== unit.flying` 时跳过（飞行/地面分层碰撞）
- `CombatSystem.findTarget`：`enemy.flying && !unit.canTargetFlying` 时跳过
- `CombatSystem.findTargetForBuilding`：`unit.flying && !building.canTargetFlying` 时跳过
- 箭塔 `canTargetFlying = true`；兵营 = false（默认）
- 待接入：朱雀 / 哈耳庇厄 PvP 卡（数值草案：HP 45 / 速度 1.4 / 攻击 12 / 攻击间隔 1.0s / 射程 1 / 费用 11 墨）

#### 4.4c Trait 系统全表

> **已全量实现（2026-06-18）**  
> 所有随机效果（onDeathSpawn 坐标 / summonOnTimer）设计为无需 Prng（同列出兵），确定性约束满足。

**进攻修饰**

| Trait | 字段 | PvP / PvE | 实现位置 |
|---|---|---|---|
| 死亡分裂 | `onDeathSpawn?: {type: UnitType, count: number}` | PvE 专属 | `CombatSystem` 死亡循环；spawned 单位 emit `unit_spawned` + `unit_move_start` |
| 溅射 | `splashRadius?: number` | PvE 专属 | `CombatSystem.performUnitAttack`：命中后对 Chebyshev dist ≤ radius 的敌方单位补发伤害 |
| 穿透 | `piercing?: boolean` | PvE 专属 | `CombatSystem.performUnitAttack`：命中同列所有其他敌方单位 |
| 减速 | `slowOnHit?: {mult: number, durationSec: number}` | PvE 专属 | 命中写 `target.slowRemainingTicks` + `speed_fp`；`TraitSystem` 倒计时到 0 → `resetSpeed()` |

**防御修饰**

| Trait | 字段 | PvP / PvE | 实现位置 |
|---|---|---|---|
| 护甲 | `armor?: number` | PvP + PvE | `Unit.takeDamage`：`effective = max(1, raw - armor)`，对所有伤害来源透明 |
| 嘲讽 | `taunt?: boolean` | PvP + PvE | `CombatSystem.findTarget`：全范围扫描，任何 dist 的 taunt 目标优先于非 taunt 近距目标 |
| 不死一次 | `undying?: boolean` | PvE 专属 | `Unit.takeDamage`：首次致死改为 HP=1 + `undyingTriggered=true` |
| 狂热 | `berserkerThreshold?: number` | PvP + PvE | `Unit.effectiveAttackIntervalTicks` getter：HP < threshold 时 interval × 2/3（≈ 攻速 ×1.5） |

**持续效果（PvE 专属）**

| Trait | 字段 | 实现位置 |
|---|---|---|
| 再生 | `regenPerSec?: number` | `Unit.regenFpPerTick`（构造时转换）；`TraitSystem`：每 tick 累加 `healAccFp` → 满 1000fp 扣整数 HP |
| 吸血 | `lifestealPct?: number` | `CombatSystem.performUnitAttack`：实际伤害 × pct/100 → `attacker.hp` |
| 治疗光环 | `traits: [{type:'aura_heal', radius, hps}]` | `TraitSystem`：每 tick 向 Chebyshev dist ≤ radius 的友方单位 `healAccFp` 累加 |

**隐匿 / 召唤（PvE 专属）**

| Trait | 字段 | 实现位置 |
|---|---|---|
| 隐身 | `stealth?: boolean` | `CombatSystem.findTarget`：dist > 2 时跳过 stealth 目标 |
| 召唤 | `summonOnTimer?: {type: UnitType, intervalSec: number}` | `Unit.summonCooldownTicks`（构造时设为 intervalTicks）；`TraitSystem` 倒计时到 0 → 同列 emit `unit_spawned` + `unit_move_start`，重置计时 |

#### 4.4d 新计划单位类型（PvP 候选）

| 单位 | 定位 | 关键机制 | 状态 |
|---|---|---|---|
| 朱雀 / 哈耳庇厄 | 飞行脆皮 | `flying=true`，只有弓箭 / 箭塔能打 | 引擎已就绪，待加 UnitType + 卡牌 |
| 枪骑兵 Lancer | 一次性冲锋 | 到达敌方基地前方时触发 `onArrival` 高额伤害后立即死亡 | 草案 |
| 蜂群 Swarm | 数量压制 | 一张牌放出 3 个 hp=15 radius=150fp 的极小单位，1 费 / 个 | 草案 |

**PvE 专属单位（不进 PvP 池）：**

| 单位 | 定位 | 关键 Trait |
|---|---|---|
| 医疗兵 Medic | 无攻击支援 | `traits: aura_heal`，单独放必死 |
| 巨灵 Golem | 2 列宽 BOSS 形态 | 占双列 `blocked`，需特殊寻敌逻辑 |

> 怪种组合 + 克制是每关「不一样」的主力来源，**单这一项就能撑几十关新鲜感**。详见神话世界观框架：`MYTHOLOGY_DESIGN.md`。

### 4.4a 关卡难度设计原则（2026-06 实战发现，写关卡前必读）

车道引擎有**碰撞排队**：同列单位单行排队，往一列堆 `count` 不增加瞬时压力、只拉长队伍（防守逐个点掉队首）。因此：

> **压力 = 宽度（多列同 tick 齐射）× 混编质量，不是单列纵深。**

三条可立即用、零引擎改动的难度杠杆：

1. **宽度**：同一 `atTick` 跨多列出兵，制造 N 个同时到达的「队首」，超出玩家用有限建筑覆盖的能力（单位只在本列前方寻敌，箭塔才是 Chebyshev 全向，故宽攻迫使分散布防）。
2. **混编**：`CombatSystem.findTarget` **不受 Moving/Waiting 状态门控**，只按同列前方 `range` 扫描——远程兵排在肉盾（重甲/盾兵）身后，只要敌人进它射程就能越过肉盾开火。坦克前 + 弓箭后 = 队伍本身变威胁，而非送菜。
3. **密度**：小半径单位（疾行 radius 250 = 0.5 格）同列能塞 ~2× 密，把「单行排队」变成真正成团的兵海。

**当前真正接入引擎的关卡旋钮只有 `noBuild` + `startCoins`**（`GameEngine` line ~89）。`board.blocked`（阻挡移动）、`activeLanes`、`hazards`、`crossWaypoints`、`leak_limit` objective **均未实现**，`levelSchema` 只 pass-through 不消费——**勿在关卡里依赖它们**。要做 chokepoint / 变道 / 机关需先补 `Board`（blocked 移动阻挡）、`MovementSystem`（crossWaypoints）、`HazardSystem`（§4.5）、`checkWinCondition`（§4.6）。

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
> **落地设计见 §4.8.2**：本批实现 `leak_limit` / `destroy_base` / `boss`（`survive` / `timed_defense` 已实现）；`multi_objective` 推迟（需"被保护子实体"系统）。

### 4.7 经济 / 编成约束（puzzle 式）

| 约束 | 配置字段 |
|---|---|
| 起始币 / 收入速率倍率 | `LevelDef.startCoins`、`LevelDef.coinRegenMult` |
| 禁某类卡（如「本关禁兵营」） | `LevelDef.bannedCards: cardId[]` |
| 限卡槽 / 限定卡池（关前编成） | `LevelDef.loadout: cardId[]`（覆盖默认 `CARD_DEFINITIONS`） |

---

## 4.8 旋钮落地设计（✅ 已全量实现，2026-06-19 复核）

> 本节把 §4.1 / §4.2 / §4.6 / §4.7 里各旋钮设计到落地颗粒度。所有旋钮均已在引擎中实现；唯一后补项是 `destroy_base.durationTicks`（2026-06-19）。
>
> **当前接入引擎的旋钮**：`cellMask.noBuild` / `cellMask.blocked` / `activeLanes` / `startInk` / `inkRegenMult` / `loadout` / `bannedCards` / `laneLength` / `levelSpells` / `crossWaypoints`（波次变道）/ `blocked` auto-detour（MidCross）/ `escort`（护送）/ objective 全 6 种（survive / timed_defense / leak_limit / destroy_base[+durationTicks] / boss / escort）。

### 4.8.1 核心原语：车道中途横移（MidCross）✅

`MovementSystem` 已实现 `UnitState.Detour` + `moveDetour()`，`Unit` 持久字段 `detourTargetCol / detourDir / pendingWaypoints`，`Board.isBlocked / setBlocked / getBlockedCells`。触发源：

**实现：**
- `Unit` 加字段：`detourTargetCol: number | null`（横移目标列）、`detourDir: 1 | -1 | 0`（当前横移方向，防 ping-pong）、`pendingWaypoints: { atRow; toCol }[]`（出生时从 `WaveEntry.crossWaypoints` 拷入）。
- `UnitState` 加 `Detour`（与终点 `Crossing` 区分，**不碰** `moveCrossing` 的到基地伤害逻辑）。
- `Board` 加 `isBlocked(col,row)` + `setBlocked(cells)` + `getBlockedCells()`，镜像现有 `isNoBuild` 实现。
- `MovementSystem.moveForward` 在前进前判定进入 Detour（优先级：waypoint > blocked）：
  1. **waypoint**：单位 y 越过某 `pendingWaypoints[i].atRow` → `detourTargetCol = toCol`，消费该 waypoint，`state = Detour`。
  2. **blocked**：前方格 `(col, nextRow)` 被 blocked → 贪心选相邻空列（见下方确定性规则）→ `detourTargetCol`，`state = Detour`。
- 新增 `moveDetour(unit)`：沿 x 朝 `detourTargetCol` 移动（复用 `moveCrossing` 的友军碰撞 + 目标列 blocked 检查，**不含**到基地伤害）；到达目标列 → `state = Moving`，清 `detourTargetCol`，下一 tick 恢复前进。

**贪心绕行确定性规则（auto-detour，用户拍板）：**
- 前方 blocked 时选向:① 先按 `detourDir`（保持上一横移方向，防来回横跳）；② `detourDir===0`（首次）时优先朝棋盘中心（基地列 5/6 方向），即 `col < 5.5 → +1`，否则 `-1`；③ 选定方向的相邻列若也 blocked，**继续同方向**找下一空列，**绝不立即反向**（反向只在撞棋盘边界时发生）。
- 单步只横移一列；下一 tick 仍 blocked 则再绕一列（同向）。
- 死局（两侧到边界都 blocked、无路）→ 单位 `Waiting` 卡住。`levelSchema` 加**构建期警告**：检测「活跃车道某行被 blocked 横切且无 waypoint 绕开」→ 打印 warn（不阻断，作者可故意造死墙做谜题）。
- 所有判定纯整数 / 定点，无 `Math.random`，纳入黄金回放确定性测试。

**横移途中遇敌（2026-06-16 拍板）= 停下交战**：与现有机制天然契合——`CombatSystem` 在敌人进射程时置单位 `Attacking`，`MovementSystem` 跳过 `Attacking` 单位，故横移中遇敌**自动停下**，无需新代码。关键设计约束：`detourTargetCol` 必须是**持久字段**（非瞬态）——交战打断（`Attacking` interlude）结束后，`CombatSystem` 清 `Attacking`，`MovementSystem` 凭仍在的 `detourTargetCol` **恢复 `moveDetour`** 把没走完的横移走完。地形绕障因此会在车道中段自然形成交战点（涌现式战术深度）。

**触发源解耦（为后续英雄重定向留缝）**：`moveForward` 进入 Detour 的本质动作就是「给 unit 设 `detourTargetCol`」。把这一步设计成**与触发源无关**——waypoint / blocked 是引擎内部触发，将来玩家英雄的 `RedirectUnit` 指令（**本批不做**，待英雄系统）只是「指令 handler 给存量单位设 `detourTargetCol`」，复用同一套 `moveDetour`，零额外移动逻辑。

**公平墙不破**：PvP / netplay 关卡**永不含** `blocked` / `crossWaypoints`（无关卡定义），故 Detour 代码路径在 PvP 中**永不触发**，PvP 单位移动逐字不变。MidCross 是 campaign / 英雄专属能力，§3 数据来源隔离硬墙完整。

**改动量：中**（一个新 movement 分支 + Unit 字段 + waypoint 触发 + Board.isBlocked）。这是本批唯一的"硬"改动。

### 4.8.2 objective 扩展（✅ 全量已实现）

`ObjectiveSpec` 联合共 **6 种**（含 escort，见 §4.9.3）：

| objective | 配置 | 胜负判定 |
|---|---|---|
| `survive` ✅ | — | 波次放完且无存活敌军 + 基地存活 → 胜 |
| `timed_defense` ✅ | `durationTicks` | 计时归零基地存活 → 胜 |
| `leak_limit` ✅ | `maxLeaks` | `enemyLeaks > maxLeaks` → 败 |
| `destroy_base` ✅ | `durationTicks?` | `topPlayer.isDead` → 胜；`durationTicks` 指定时：超时 → 败 |
| `boss` ✅ | — | 所有 boss 单位死亡 → 胜 |
| `escort` ✅ | `required` | 见 §4.9.3 |

> `boss` 的 `isBoss` 已在 `WaveEntry` 预留，`WaveDirector` 出兵时把标记透到 `Unit.isBoss` 并登记 id。
> **`escort`（原 `multi_objective`）**：重新定义为「护送单位到达终点」，已完整设计，见 §4.9。

### 4.8.3 activeLanes（禁用车道）✅

`GameEngine.processCommand` 限制玩家出兵列，`WaveDirector` 构造时跳过非活跃列，`Board.setActiveLanes / getActiveLanes`。

### 4.8.4 经济 / 编成（inkRegenMult / loadout / bannedCards）✅

- `inkRegenMult`：`GameState.bottomInkRegenMult`，`ResourceSystem` 每 tick 乘该系数（仅底部玩家）。
- `loadout` / `bannedCards`：`GameEngine` 构造时注入过滤后的 `UniformCardDrawPolicy(prng, pool)`。

### 4.8.5 schema + 编辑器 + 测试 ✅

- `levelSchema.ts`：全部旋钮严格校验，`destroy_base.durationTicks` 2026-06-19 补入。
- 关卡编辑器：objective 下拉含 6 种；blocked 画笔；crossWaypoints / levelSpells / escorts 编辑；BoardPanel 可视化路径拖拽**待做**。
- Vitest：objective×3（+timed-loss 2026-06-19）/ escort×5 / MidCross / hardwall / loadout / inkRegenMult / activeLanes — 267 用例全绿。

---

## 4.9 新旋钮设计（2026-06-17 拍板）

### 4.9.1 laneLength（非对称车道长度）

| 字段 | `LevelDef.board.laneLength?: Record<number, number>` |
|---|---|
| 含义 | 每列的有效行数（从玩家侧算起）；未指定的列默认全长 `ROWS` |
| 出生行 | `spawnRow = ROWS - laneLength[col]`（出生点上移，敌军更快逼近） |
| 引擎 | `GameEngine` 初始化时把 `row < spawnRow` 的格子全部 `board.setBlocked()`；`WaveDirector` 出兵时读 `laneLength` 决定出生行 |
| 渲染 | `BoardView` 把被截断的顶部格子渲染为不可通行地形（灰色/岩石，复用 inactive lane 逻辑） |
| 量 | 小 |

> **已部署（2026-06-19）**：ch2_lv4（cols 2/9 缩短为 10 行）、ch5_lv3（cols 4/7 缩短为 11 行）、ch6_lv6（cols 1/9 缩短为 11 行，配合 4-activeLanes 布局）。

### 4.9.2 levelSpells（关卡专属玩家主动技 → 加进卡牌）

**设计约束：**
- 关卡开局**固定给若干张**在手牌；用完后进入随机刷新池（可再抽到）
- 只存在于关卡指定的牌池中，**永不进全局 `CARD_DEFINITIONS` / PvP 池**（公平硬墙）
- 新增 `SPELL_CARD_DEFS`（独立 Map），关卡通过 `levelSpells` 字段引用

**配置字段：**
```ts
LevelDef.levelSpells?: { cardId: string; initialCount: number }[]
```

**本期两种法术（2026-06-17 拍板）：**

| 法术 | cardId | 效果 | 费用 | 量 |
|---|---|---|---|---|
| 滚石 | `rockslide` | 对目标**列**所有敌方单位造成固定伤害（Meteor 的列版） | 3 | 小 |
| 炸桥 | `bridge_collapse` | 使目标**列**变为临时 `blocked` N 秒，单位被迫绕路 | 4 | 小 |

**引擎接入点：**
- `GameEngine.init`：强制把 `initialCount` 张发入玩家手牌，同时把该 cardId 加入刷新池
- `processCommand`：新增 `Rockslide`（遍历目标列所有 owner=1 单位扣血）和 `BridgeCollapse`（写 `GameState.tempBlockedCols: Map<col, expiresAtTick>`）分支
- `GameEngine.step`：每 tick 清理过期 `tempBlockedCols`
- `MovementSystem`：前进检查时把 `tempBlockedCols` 里的列视同 `isBlocked`（触发 MidCross 绕路）

**卡牌 UI：**
- 滚石 / 炸桥打出后选列（同单位/建筑出牌选列，复用现有拖拽逻辑）

### 4.9.3 escort 护送目标（原 `multi_objective`，2026-06-17 拍板）

**核心玩法：** 玩家侧有一个（或多个）友方护送单位，沿设定路径从玩家端向敌方端移动；到达终点 = 胜利条件之一。玩家用手牌和建筑为护送单位清路/护卫。

**设计决策（全部拍板）：**

| 问题 | 决策 |
|---|---|
| 移动方向 | 从 `startRow`（玩家侧）向上走到 `row 0`（敌方侧）；有显式 `path` 则按 path |
| 有无显式路径 | 关卡可选 `path: Waypoint[]`；缺省 = 沿 `startCol` 直线到 `row 0` |
| 护送单位能否攻击 | 否，纯被动目标 |
| 被攻击时行为 | **继续前进**（只扣血不停步），玩家需预清路上的敌军 |
| 敌军行为 | 进入射程即停下攻击，护送单位走出射程后敌军恢复前进 |
| 多目标胜负 | `required: 'all' \| 'any' \| number`（全部/任一/至少 N 个到达） |

**配置字段：**
```ts
// LevelDef 新增
escorts?: EscortSpec[]

interface EscortSpec {
  id: string
  hp: number
  speed: number          // 格/秒
  startCol: number
  startRow: number
  path?: { col: number; row: number }[]   // 显式路径；缺省走 startCol 直到 row 0
}

// ObjectiveSpec 新 variant
{ kind: 'escort'; required: 'all' | 'any' | number }
```

**运行时实体（GameState.escorts）：**
```ts
interface EscortUnit {
  id: string
  hp: number; maxHp: number
  col_fp: number; row_fp: number    // 定点数，平滑移动
  remainingPath: { col: number; row: number }[]
  speed_fp: number
  status: 'moving' | 'arrived' | 'dead'
}
```

**新增系统 `EscortSystem`：**
- 每 tick 推进 `col_fp`/`row_fp` 朝下一 waypoint 移动
- 到达 waypoint → 弹出，继续下一段
- 全路点走完 → `status = 'arrived'`

**CombatSystem 改动：**
- `findTarget` 把射程内的 `EscortUnit`（`status === 'moving'`）也列为候选目标
- 按 Chebyshev 距离与普通单位/建筑混排，取最近目标
- 敌军不会为追护送单位后退（天然满足：`MovementSystem` 前进逻辑不变，`EscortUnit` 不作为「前方障碍」阻塞移动）

**checkWinCondition 新分支：**
```ts
// 'escort' objective
const arrived = escorts 中 status==='arrived' 的数量
const dead    = escorts 中 status==='dead'    的数量
const needed  = required==='all' ? total : required==='any' ? 1 : required

if (arrived >= needed) → 玩家胜
if (total - dead < needed - arrived) → 无法完成，玩家败
基地死亡仍判负（现有逻辑不变）
```

**关卡编辑器：** 护送路径可视化编辑（点击棋盘格生成 waypoints）作为**独立 UI 任务**，三核心功能代码完成后补做。

**关卡接入一览（2026-06-18 落地）：**

| 旋钮 | 关卡 | 说明 |
|---|---|---|
| `levelSpells` rockslide×2 | ch1_lv5 | 引导教学：survive 关，法术帮助清 ironclad |
| `levelSpells` rockslide×1+bridge_collapse×1 | ch2_lv5 | inkRegenMult:0.5 经济紧张，法术替代费用 |
| `levelSpells` bridge_collapse×2 | ch4_lv4 | 岩浆+crossWaypoints，桥断强迫更绕路 |
| `escort` required:'all' (1 护送) | ch2_lv3 | bannedCards 禁兵营，需主动清路护送 |
| `escort` required:'any' (2 护送) | ch3_lv4 | activeLanes 5 路，任一到达即胜 |
| `escort` required:'all' (2 护送) | ch5_lv5 | loadout 受限，双护送全部到达才胜 |
| `harpy` 末段波次 | ch3_lv3 | 末段引入飞行单位，逼玩家前期有箭塔 |
| `berserker` 穿插波次 | ch3_lv7 | timed_defense 中盘开始出现，越打越猛 |
| `splitter` 穿插波次 | ch4_lv5 | speed 加速道上分裂，死了更多 runner |
| `medic` 穿插波次 | ch4_lv9 | 迷雾关里的隐藏治疗者，必须优先击杀 |
| `berserker` 中段波次 | ch5_lv6 | destroy_base + 速度道，狂热兵越打越猛逼快攻 |
| `splitter`+`harpy` 末段 | ch5_lv8 | 分裂兵加剧岩浆道压力，飞行单位作末段考验 |
| `medic` 末段波次 | ch5_lv9 | timed_defense 中藏治疗者，先杀医再守时 |
| `laneLength` cols 2/9 = 10 | ch2_lv4 | 编成受限关（仅步兵/盾兵），短道让敌军更快逼近 |
| `laneLength` cols 4/7 = 11 | ch5_lv3 | lava+crossWaypoints 关，短道强化岩浆列压力 |
| `laneLength` cols 1/9 = 11 | ch6_lv6 | 4-activeLanes 关，短道使 4 路宽度各异 |
| hazard speed ch3 | ch3_lv5 | activeLanes 6 路+速度道，窄道变快道 |
| hazard fog ch3 | ch3_lv9 | activeLanes 6 路+迷雾，视野缩减加窄道难度 |
| hazard speed ch2 | ch2_lv4 | loadout 受限关 + 速度道，首次引入环境机关 |
| hazard fog ch2 | ch2_lv6 | 禁箭塔关加迷雾，射程缩减倒逼近战 |
| ch6 全章 PvE 单位补全 | ch6_lv1–lv10 | infantry/shieldbearer 加入早期关；harpy/berserker/splitter/medic 分散覆盖 ch6_lv2–lv10，最终关集齐四种 |

**实现顺序（2026-06-17 拍板）：**
1. ✅ `laneLength`（已实现 2026-06）
2. ✅ `levelSpells`（已实现 2026-06）
3. ✅ Escort 护送系统（已实现 2026-06-18，见下方实现记录）
4. ✅ **关卡内容接入（2026-06-18）**：escort、levelSpells、新单位类型全部首次在关卡中使用——见 §4.4 新单位说明及下表。

**实现记录（2026-06-18 落地）：**
- `EscortUnit.ts`：类实体（hp/col_fp/row_fp/speed_fp/status/remainingPath），numericId 5000+ 避免与 Unit/Building ID 冲突
- `EscortSystem.ts`：每 tick 前进 speed_fp × TICK_DT_FP；到路点行时 snap col；到 TOP_BUILDING_ROW → `arrived`；hp=0 → `dead`
- `CombatSystem`：`findTarget` 对 Top-side 单位扫 `state.escorts`（Chebyshev 混排，unit > escort > building），`performUnitAttack` 分发 `escort_hp_changed`
- `LevelDefinition`：`EscortSpec` 接口 + `escorts?` 字段 + `ObjectiveSpec` escort variant
- `levelSchema`：`parseEscorts` 严格校验（path 行号严格升序）+ escort objective 解析
- `GameState`：`escorts: EscortUnit[]` + `resetEscortIds()`
- `types.ts`：`escort_spawned/moved/hp_changed/died/arrived` 五个事件
- `GameEngine`：构造器创建实例，`emitInitialEvents` 发 `escort_spawned`，step 插 EscortSystem，`checkWinCondition` 处理 arrived≥needed → 胜 / total-dead < needed-arrived → 败
- ✅ **渲染层（2026-06-18 落地）**：`GameRenderer` 新增 `escortLayer`（Buildings 之上）；消费 `escort_spawned/moved/hp_changed/died/arrived` 五个事件；绿色菱形精灵 + HP 条，death 淡出 0.5s，arrived 闪烁消失。
- ✅ **关卡编辑器（2026-06-18 落地）**：`LevelFormPanel` 新增「护送到达 (escort)」objective 选项（required: all/any/N 子表单）；levelSpells 编辑区（card 选择 + initialCount）；escorts 编辑区（id/hp/speed/startCol/startRow + 路径点列表增删）。BoardPanel 可视化路径拖拽仍为待做（独立 UI 任务）。
- ✅ **Vitest（2026-06-18 落地）**：`campaign-knobs.test.ts` 新增 5 个 escort 用例（spawn 事件、到达胜利、行进中未结束、全员阵亡判负、status 状态转换）。

---

## 5. 数据结构草案

> 与现有类型对齐：`PlayerCommand`、`UnitType`、`col/row`、tick 计时。字段名最终以实现为准。
>
> **已实现（2026-06）**：所有关卡已迁为 **JSON 单一来源**（`game/campaign/levels/*.json`），由 `game/campaign/levelSchema.ts` 的 `parseLevelDefinition` 运行时校验后注册；`game/campaign/levels.ts` 改为 import JSON。配套可视化关卡编辑器见 `../tools/level-editor/DESIGN.md`。

```ts
// game/campaign/LevelDefinition.ts  （纯数据，无 PIXI）
interface LevelDefinition {
  id: string;                 // 'ch1_lv3'
  chapter: number;            // 章节（= 故事线 / 主角）
  seed: number;               // 关卡固定随机种子（确定性 + 可做同种子挑战）
  objective: ObjectiveSpec;   // §4.6 / §4.9.3
  board: {
    activeLanes: number[];                          // §4.1
    laneLength?: Record<number, number>;            // §4.9.1 col→有效行数
    cellMask?: { blocked?: Cell[]; noBuild?: Cell[] };
  };
  hazards?: HazardSpec[];      // §4.5
  levelSpells?: { cardId: string; initialCount: number }[];  // §4.9.2
  escorts?: EscortSpec[];      // §4.9.3 护送目标
  startCoins?: number;
  coinRegenMult?: number;      // §4.7
  loadout?: string[];          // 关前编成（覆盖默认卡池）
  bannedCards?: string[];
  waves: WaveScript;           // §6
  rewards: LevelRewards;       // §7
  story?: { introKey?: string; outroKey?: string }; // i18n story.* 键
}

// ObjectiveSpec 完整联合（§4.6 + §4.9.3）
type ObjectiveSpec =
  | { kind: 'survive' }
  | { kind: 'timed_defense'; durationTicks: number }
  | { kind: 'leak_limit'; maxLeaks: number }
  | { kind: 'destroy_base'; durationTicks: number }
  | { kind: 'boss' }
  | { kind: 'escort'; required: 'all' | 'any' | number }

// EscortSpec（§4.9.3）
interface EscortSpec {
  id: string
  hp: number
  speed: number          // 格/秒
  startCol: number
  startRow: number
  path?: { col: number; row: number }[]  // 显式路径；缺省沿 startCol 到 row 0
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

> **详细设计已独立成文：`META_DESIGN.md`**（存档 / 云存档 / 经济 / 养成 / 盲盒 / 服务器架构 / 锁步联机 / 信任边界 / 成本 / 分期）。下表为高层索引，细节以 `META_DESIGN.md` 为准。

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

- **章节 = 主角故事线**：每章 ~8–10 关，围绕一个单位（普通兵 / 弓箭兵 / 盾兵 / 后续新单位）展开来历，章末解锁该单位剧情 + 专属皮肤。
- **新机制引入节奏**：每章引入 1–2 个新怪种 / 新机关 / 新目标类型，避免第 15 关就重复。
- **难度曲线**：章内递增，章首回落引入新机制，Boss 关压轴。
- **教学合一**：解锁某单位的章节顺带教玩家在对战里怎么用它。

> 文案全部走 i18n（`zh.ts` 为键唯一来源，`en`/`de` 编译强制全翻），严禁硬编码（见 `../../CLAUDE.md`）。

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
| P1 前端闭环 | ✅ **已完成（2026-06-18）**：`ResultScene` 通关后返回 CampaignMapScene（含 backToMap 按钮）；`LevelPrepScene` intro 改为 IntroScene 逐行淡入动画；`ch{1-6}_lv1.json` + `ch{1-6}_lv10.json` 加 `story.introKey` / `story.outroKey`；zh/en/de 补 `campaign.ch{1-6}.intro/outro` + `result.backToMap` 共 13 键 | 场景层「选关 → 故事 → 打 → 结果 → 地图」完整闭环 |
| P2 | 元系统铺开：解锁链 / PvE 养成（硬墙单测）/ 皮肤 / 广告币 | 商业化与公平性硬墙验证通过 |
| P3 | 扩到 50 关 + 无尽 / 挑战 / 难度层 | 内容量达标 |
| P4（可选） | §4.6 全目标类型 + 路径塔防特殊关（D6） | — |

> 先做 P0/P1 验证「好玩 + 留存」，再投入 P3 的大规模内容生产，避免一上来铺 50 关。

---

## 11. 开放问题（待定）

- [ ] PvE 养成数值的上限与曲线（既要有付费爽感，又不能让关卡失去挑战）。
- [ ] 广告币产出 / 消耗经济模型（每日上限、皮肤定价）。
- [x] 关卡编辑工作流：已定为**独立 Web 关卡编辑器**（仿 `tools/animator`），关卡统一为 JSON 单一来源、提交进仓库构建打包。设计基准见 **`../tools/level-editor/DESIGN.md`**。
- [ ] 章节数量与单位扩充计划（现有 3 单位，撑 50 关需新增多少 PvE 怪种 / 玩家单位）。
- [ ] 时间加速机制在战役里保留 / 关闭 / 改造。

---

## 12. 战役入口与章节地图（2026-06-19 拍板，待实现）

> 关卡内容骨架（61 关 JSON + 全旋钮引擎）已齐，本节定**玩家从哪里进入、怎么在章节间推进**的入口形态。
> 形态由美术总纲（`../product/art-direction.md`）的 diegetic「会动的涂鸦本」框架直接导出——入口不是奇幻世界地图，而是**一本翻开的「战役笔记本」**。

### 12.1 现状与问题（重构前）

战役曾有**两个并存且割裂**的入口：

| 入口 | 位置 | 问题 |
|---|---|---|
| A · 大厅快捷按钮 | `LobbyScene` 主开始键下方，硬编码 4 个编号按钮（`CAMPAIGN_LEVEL_COUNT=4`），文案「战役 (试玩)」 | 绕过解锁链 / 星级 / 章节叙事，是 demo 遗留；与正式入口两套逻辑 |
| B · 选关地图 | `CampaignMapScene`，61 关一根**扁平滚动列表**按章分组 | 功能齐（解锁/星级/收集册）但「表格感」，无战役空间叙事；每次从 ch1 顶部渲染，不落到当前关 |

### 12.2 拍板形态：一本翻开的「战役笔记本」

全程序绘制（`SketchPen` + `render/sketchUi.ts` 现有原语：`buildPaperBackground` / `sketchPanel` / `seedFor`），diegetic 翻页过场——同时推进美术总纲 §十二待办 `笔记本封面主菜单 + 手绘翻页过场`。

| 维度 | 决策 | 理由 |
|---|---|---|
| **大厅入口** | 砍掉 4 个编号快捷按钮，大厅只留**单一「战役」主入口** → 进战役笔记本；`lobby.campaign` 文案去「试玩」改正式「战役」 | 61 关内容已齐，试玩定位退场；PvE 只留一扇正门，解锁链/星级/叙事一套逻辑 |
| **落地层级** | 进战役落在**目录页**（6 章 + 各章进度星数）→ **自动翻到当前可打的那一章**，定位到当前节点 | 进度落点，不再从 ch1 顶部 |
| **章节页** | 一章 = 笔记本一页；10 关为**手摄位置**的手绘节点，由**铅笔虚线路径**蜿蜒串起；通关盖星章 / 当前关脉冲高亮 / 未解锁淡铅笔轮廓 | 空间叙事；手摄位置每章地形不同，最「设计过」 |
| **背景美术** | **程序涂鸦点缀**：纸底 + 每章几笔手绘场景物（演武场枪架、比试场旗…），零 AI 资产依赖 | 现在就能上、完全贴笔记本风；AI 插画底图以后可再叠（总纲允许「插画式地图元素」走 AI 图） |
| **章节门槛** | **纯线性**：打通本章最后一关 → 解锁下一章；门槛靠**章节小结仪式**（本章星数 + outro 剧情 + 「第 N 章 通关」印章）+ **翻页动画**揭开下一章，不加星星 grind 门槛 | 仪式给真实门槛感，又不卡住休闲玩家 |

形态示意：

```
┌─ 目录页（landing）──────────┐      ┌─ 第 1 章 · 演武场 ────────┐
│  战役笔记本                   │      │  ✸start                   │
│  第一章 演武场   ★★★☆☆ 7/15  │翻页  │   ╲                       │
│  第二章 训练场   （胶带封住）🔒│ ──► │    ●1✓─ ●2✓               │
│  第三章 比试场   （折角未翻）  │      │         ╲   手绘铅笔虚线路径│
│  ...                         │      │    ●4 ──●3✓               │
│  ▸ 自动翻到「当前可打」那章    │      │     ◉ 当前关(脉冲)         │
└──────────────────────────┘      └──[BOSS]→ 翻页解锁下一章 ───┘
```

### 12.3 数据模型（新增）

章节地图与关卡数据**分离**：节点只引 `levelId`，关卡数值仍单一来源于 `game/campaign/levels/*.json`，互不重复。坐标归一化（`0..1`）以适配横竖屏 / 任意分辨率。

```ts
// game/campaign/maps/chN.json  （纯数据，手摄坐标）
interface ChapterMap {
  chapter: number;
  venueKey: string;                              // i18n 场景名（页眉「第 N 章 · 演武场」）
  nodes: { levelId: string; x: number; y: number }[];  // x/y ∈ 0..1，页面内归一化位置
  path?: 'auto' | { x: number; y: number }[];    // 路径；'auto' = 按 nodes 顺序连线
  decor?: { kind: string; x: number; y: number }[];    // 程序涂鸦点缀（枪架/旗/[START]/[BOSS]…）
}
```

配套：`maps/index.ts` 注册 + `mapSchema.ts` 运行时校验（节点 levelId 必须存在于 `CAMPAIGN_LEVELS`、坐标越界警告）。

### 12.4 实现切片（顺序）

1. ✅ **本节落文档**（2026-06-19）。
2. ✅ **大厅收口**（2026-06-19）：删 `LobbyScene` 4 个编号快捷按钮 + `CAMPAIGN_LEVEL_COUNT`，回调 `onStartCampaign(levelIndex)` → `onOpenCampaign()`，单一金边「战役」正门（左缘金墨竖描，呼应特性块）；`lobby.campaign` 文案去「试玩 / Beta」改正式「战役 / CAMPAIGN / KAMPAGNE」（zh/en/de）。`createAppCore` / headless-nav / scenes.ui 同步改名。
3. **地图数据 + schema**：`maps/chN.json` 格式 + `mapSchema` 校验 + 6 章节点坐标手摄。
4. **章节页渲染**：替换 `CampaignMapScene` 扁平列表为节点 / 铅笔虚线路径 / 星章 / 当前脉冲；复用 `sketchUi` 原语。
5. **目录页 + 进度落点 + 翻页过场 + 章节小结仪式**：目录页 landing、自动定位当前章/关、翻页转场、章末「第 N 章 通关」印章 + outro。

> 公平墙不破：章节地图纯属 campaign 前端表现层，不触碰 PvP 引擎 / `campaignProgress` 数据来源隔离（§3）。
