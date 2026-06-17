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
**已实装 trait（见上方 Ironclad / Runner）**

**计划 trait 全表（2026-06-17 拍板）：**

#### 4.4b 飞行系统（PvP + PvE，优先级高）

| 字段 | 类型 | 说明 |
|---|---|---|
| `UnitBlueprint.flying` | `boolean` | 单位是飞行单位，地面单位寻敌时跳过飞行目标 |
| `UnitBlueprint.canTargetFlying` | `boolean` | 单位可以打飞行目标（弓箭手 = true，步兵 / 盾兵 = false） |
| `Building.canTargetFlying` | `boolean` | 建筑可打飞行目标（箭塔 = true，兵营 = false） |

**飞行机制规则（已拍板）：**
- 飞行单位穿越 `blocked` 格（飞越障碍）
- 飞行单位有独立碰撞层（飞行间互相碰撞，不与地面单位碰撞排队）
- 飞行单位正常横穿（crossing 机制不变）
- 飞行单位可以攻击地面单位；地面单位**无法**攻击飞行单位
- 飞行单位也可打飞行单位（`canTargetFlying` 双方通用）
- **PvP 收录**：朱雀（东）/ 哈耳庇厄（西）作为飞行牌，详见 `MYTHOLOGY_DESIGN.md §4`
- 引擎改动：`CombatSystem.findTarget` + `findTargetForBuilding` 加 `flying` 过滤；`MovementSystem.moveForward` 跳过 blocked 格检测；飞行碰撞层独立处理

**数值草案（朱雀 / Harpy，PvP 卡）：**  
HP 45 / 速度 1.4 / 攻击 12 / 攻击间隔 1.0s / 射程 1 / 费用 11 墨

#### 4.4c Trait 系统全表

> 所有随机效果必须走注入 `Prng`（确定性约束，见 §9）。
> 「PvP」= 可进 PvP 牌池；「PvE 专属」= 只在 PvE 关卡敌方 / 关卡限定 loadout 出现。

**进攻修饰**

| Trait | 字段 | PvP / PvE | 效果 | 引擎改动量 |
|---|---|---|---|---|
| 死亡分裂 | `onDeathSpawn?: {type: UnitType, count: number}` | PvE 专属 | 死亡时在周边生成 N 个弱小单位（BOSS 死裂首选） | 中：`CombatSystem` 死亡钩子，注入 Prng 定坐标 |
| 溅射 | `splashRadius?: number`（Chebyshev 圈数） | PvE 专属 | 攻击命中周边额外目标，克制 Runner 鱼群 | 中：`CombatSystem` 命中后二次伤害循环 |
| 穿透 | `piercing?: boolean` | PvE 专属 | 攻击穿过同列前方所有单位（弓箭兵进阶形态） | 小：`findTarget` 改返回列表而非单一目标 |
| 减速 | `slowOnHit?: {mult: number, durationSec: number}` | PvE 专属 | 命中后目标速度 × mult 持续 N 秒 | 中：`Unit` 加临时速度修正 + tick 倒计时 |

**防御修饰**

| Trait | 字段 | PvP / PvE | 效果 | 引擎改动量 |
|---|---|---|---|---|
| 护甲 | `armor?: number` | PvP + PvE | 每次受击减少固定伤害，克制低伤多次攻击（弓箭） | 小：`CombatSystem` 伤害计算加减法 |
| 嘲讽 | `taunt?: boolean` | PvP + PvE | 敌方 `findTarget` 优先以此单位为目标 | 小：寻敌排序权重 |
| 不死一次 | `undying?: boolean` | PvE 专属 | 首次致死时以 1 HP 存活，清除标记 | 小：死亡判定加特判 |
| 狂热 | `berserkerThreshold?: number` | PvP + PvE | HP < threshold% 时攻速 × 1.5 | 小：攻击间隔公式加 HP 判断 |

**持续效果（PvE 专属，关卡 / 波次限定）**

| Trait | 字段 | 效果 | 备注 |
|---|---|---|---|
| 再生 | `regenPerSec?: number` | 每 tick 回 HP，拖延战斗节奏 | 精英怪 / Boss 常用 |
| 吸血 | `lifestealPct?: number` | 造成伤害的 % 回 HP | 不进 PvP（无限续航破局） |
| 治疗光环 | `traits: [{type:'aura_heal', radius, hps}]` | 每秒治疗周边友军 | 不进 PvP（同上） |

**隐匿 / 召唤（PvE 专属）**

| Trait | 字段 | 效果 | 引擎改动量 |
|---|---|---|---|
| 隐身 | `stealth?: boolean` | 距离 > 2 格时 `findTarget` 不选中；进入攻击范围显身 | 中：寻敌加距离门控 |
| 召唤 | `summonOnTimer?: {type: UnitType, intervalSec: number}` | 每 N 秒在周边刷出弱小单位（Summoner BOSS） | 中：`tick` 计时钩子 + 注入 Prng |

#### 4.4d 新计划单位类型（PvP 候选）

| 单位 | 定位 | 关键机制 | 状态 |
|---|---|---|---|
| 朱雀 / 哈耳庇厄 | 飞行脆皮 | `flying=true`，只有弓箭 / 箭塔能打 | 设计完成，待实现 |
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

## 4.8 旋钮落地设计（2026-06-16 拍板，**待实现**）

> 本节把 §4.1 / §4.2 / §4.6 / §4.7 里「纸面有、引擎 pass-through」的旋钮设计到**落地颗粒度**（具体接入点 + 改动量），是下一批战役引擎工作的实现基准。字段名以此节为准（修正历史漂移：经济用 `startInk` / `inkRegenMult`，**非** `startCoins` / `coinRegenMult`——局内货币是 ink，§3 经济文档为准）。
>
> **当前真正接入引擎的只有 `cellMask.noBuild` + `startInk`**（`GameEngine` 构造，line ~108）。本节其余旋钮实现前**勿在关卡里依赖**。

### 4.8.1 核心原语：车道中途横移（MidCross）

读 `MovementSystem` 后的关键发现：单位**只沿车道 y 直线前进**，横移（`Crossing`）**只发生在终点**（敌方建造行 → 冲基地列 5/6），中途拐弯机制不存在。`blocked` 绕行与 `crossWaypoints` 变道是**同一个新原语**——建一次两个旋钮都通。

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

### 4.8.2 objective 扩展（survive / timed_defense → +3 种）

`ObjectiveSpec` 联合从 2 种扩到 **5 种**（`multi_objective` 本批不做，见末尾）：

| objective | 配置 | 胜负判定（`GameEngine.checkWinCondition` campaign 分支加 case） | 量 |
|---|---|---|---|
| `survive`（已实现） | — | 波次放完且无存活敌军 + 基地存活 → 胜 | — |
| `timed_defense`（已实现） | `durationTicks` | 计时归零基地存活 → 胜 | — |
| **`leak_limit`** | `maxLeaks` | `GameState` 加 `enemyLeaks`，敌方单位 `moveCrossing` 到达玩家基地时 +1；`enemyLeaks > maxLeaks` → **败**；胜利条件叠加在 survive 之上（撑完且漏过 ≤ 上限） | 小 |
| **`destroy_base`（限时进攻）** | `durationTicks` | `topPlayer.isDead`（已有逻辑）在计时内 → 胜；`elapsedTicks ≥ durationTicks` 且敌基未拆 → **败** | 小 |
| **`boss`** | — | `WaveEntry.isBoss` 单位出生时把 id 记入 `GameState.bossUnitIds`；已出生 boss 全部 `isDead` 且非空集 → 胜；基地死 / 漏过仍判负 | 小 |

> `boss` 的 `isBoss` 已在 `WaveEntry` 预留，`WaveDirector` 出兵时把标记透到 `Unit.isBoss` 并登记 id。
> **`escort`（原 `multi_objective`）**：重新定义为「护送单位到达终点」，已完整设计，见 §4.9。

### 4.8.3 activeLanes（禁用车道）

- 出兵校验：`GameEngine.processCommand` 的 unit 放置分支加 `col ∈ level.board.activeLanes`（缺省 = 全 `ATTACK_LANES`）。
- `WaveDirector` 只在活跃车道刷兵；`levelSchema` 校验所有 `wave.col ⊆ activeLanes`，否则带字段路径报错。
- 渲染：禁用列灰显 / 加遮罩（`BoardView` 读 `activeLanes`，非逻辑改动）。
- **量：小**。

### 4.8.4 经济 / 编成（inkRegenMult / loadout / bannedCards）

- `inkRegenMult`：`ResourceSystem` 玩家 regen 乘该系数（读 level，缺省 1.0）；`startInk` 已接，顺手对齐字段名。**小**。
- `loadout` / `bannedCards`：接入点 = `Card.ts` 的 `UniformCardDrawPolicy`——现从全量 `CARD_DEFINITIONS` 抽。改为 `UniformCardDrawPolicy(prng, pool?)` 可注入池；campaign 模式下 `GameEngine` 构造时 `pool = (loadout ?? 全卡) 过滤掉 bannedCards`。`levelSchema` 校验 id 存在于卡牌定义。**中**。

### 4.8.5 schema + 编辑器 + 测试同步

- `levelSchema.ts`：扩 `ObjectiveSpec` 3 个新 kind 校验；`activeLanes ⊆ ATTACK_LANES` 且 `wave.col ⊆ activeLanes`；`crossWaypoints[].atRow ∈ 0..ROWS`、`toCol ∈ ATTACK_LANES`；`blocked` cell 界内 + 死墙警告；`loadout`/`bannedCards` id 合法。
- 关卡编辑器（`tools/level-editor`）：objective 下拉加 3 项（leak_limit 附 maxLeaks、destroy_base 附秒数）；棋盘面板加 **blocked 画笔**（已有 noBuild/erase，加第三种）；时间线出兵块 Inspector 加 **crossWaypoints 编辑**（解掉 §9 开放问题「hazards/crossWaypoints 何时上可视化」中的 crossWaypoints 一半）。
- Vitest：每个新 objective 一个终局用例；MidCross 绕行 + 变道各一个确定性回放用例；「满级 pveUpgrades 下 PvP 蓝图逐字等于常量」硬墙用例已存在，不受影响。

### 4.8.6 实现顺序（低风险优先）

1. **objective ×3 + activeLanes + 经济/编成**（全是接线，无新原语）→ 先让现有关卡能用上多目标和编成约束。
2. **MidCross 原语**（crossWaypoints 先行验证，纯作者脚本、可控）。
3. **blocked auto-detour**（复用 MidCross + 贪心规则，增量最小）。
4. 编辑器 blocked 画笔 + waypoint 可视化。
5. 用新旋钮重写 / 新增几关验收（chokepoint + 变道 + 限时进攻 + boss 各一关）。

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

**实现顺序（2026-06-17 拍板）：**
1. `laneLength`（最小，复用 blocked 逻辑）
2. `levelSpells`（Rockslide + BridgeCollapse，复用 processCommand 框架）
3. Escort 护送系统（新实体 + EscortSystem + CombatSystem 改动 + 渲染）

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
| P2 | 元系统铺开：解锁链 / PvE 养成（硬墙单测）/ 皮肤 / 广告币 / 章节故事 | 商业化与公平性硬墙验证通过 |
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
