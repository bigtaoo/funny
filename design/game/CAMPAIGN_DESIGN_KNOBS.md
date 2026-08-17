# 战役设计 — 新旋钮 / 数据结构 / 元系统（§4.9 起）

> 从 [`CAMPAIGN_DESIGN.md`](CAMPAIGN_DESIGN.md) 拆出（2026-08-17，原文件 756 行）。**小节编号沿用原文**，`CAMPAIGN_DESIGN.md §N` 引用照旧有效。
> 本册内容：§4.9 新旋钮拍板、§5 数据结构、§6 引擎接入、§7–§12 元系统与路线。总览与在先小节见 [`CAMPAIGN_DESIGN.md`](CAMPAIGN_DESIGN.md)。

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
- **客户端 bug 修复（2026-07-05）**：`GameRenderer/input.ts` 的 `commitCardPlay`/`updatePlacementHighlights` 此前只接了 `Haste`/`Meteor` 两个 case，`Rockslide`/`BridgeCollapse` 从未被 wire 上——选中卡后点列没有任何反应（引擎侧一直是好的）。已补上两个 spell 的 `engine.playCard(handIndex, col)` 调用和列高亮（`BoardView.showColumnTargetHighlight`），并在 `client/test/ui/gameRendererSpellInput.ui.ts` 加了 tap-select/drag 的回归测试。

**地图效果强化（2026-07-23）：** 两法术此前各只有一次性施法 VFX，玩家常注意不到「整列被打」/「这列封了」，故按各自持续时间重做地图表现：
- **炸桥（`bridge_collapse`）持续覆盖层**：施法 VFX 只闪 0.6s 但封锁持续 8s，期间车道无任何持续标记。新增 `BoardView.syncBlockedLanes()`——由 `GameRenderer/base.ts` 每帧从 `state.tempBlockedCols`（col→到期 tick）算出各封锁列剩余秒数并 reconcile：每列建一个红色手绘「✕栅栏 + 交叉阴影」覆盖层（`fx.laneBlocked`，画在 units 之下的 `blockedLaneLayer`），列出现时用固定 seed 的 `SketchPen` 画一次（不逐帧抖动），之后仅调 `alpha`；剩余 <1.6s 时快速闪烁提示即将恢复；列一解封即销毁该覆盖层。
- **滚石（`rockslide`）预警 + 级联扫描**：`BoardView.playRockslideEffect(col)`——先 0.18s 红色预警线贯穿整条车道，再从一端到另一端逐格（`PER_ROW≈0.03s`）落下岩块（手绘碎块 + 飞溅碎屑），读作「整列被砸」而非一处小爆点。纯渲染（伤害仍在引擎侧瞬时结算），单个 `Ticker.shared` tick，`destroy()` 里经 `fxTicks` 注销（GC-root 泄漏契约）。据此把 `rockslide` 从 `events.ts` 的 `SPELL_VFX` 表移除、改路由到该方法，并顺手删掉 `handleEvent` 里那个走不到的重复 `case 'spell_cast'`（meteor 的 `playMeteorEffect` 方框描边死代码，meteor 一直靠 `SPELL_VFX['meteor']` 正常显示）。
- 回归测试：`client/test/ui/spellMapEffects.ui.ts`（封锁覆盖层增删/剩余时间闪烁/滚石 tick 增删与 destroy 注销）+ `gameRendererEvents.ui.ts` 加 rockslide 路由断言。

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

**关卡编辑器：** 护送路径可视化编辑（点击棋盘格生成 waypoints）作为**独立 UI 任务**，三核心功能代码完成后补做。✅ **已落地（2026-06-19，见 §4.9.4）**。

**关卡接入一览（2026-06-18 落地）：**

| 旋钮 | 关卡 | 说明 |
|---|---|---|
| `levelSpells` rockslide×2 | ch1_lv5 | 引导教学：survive 关，法术帮助清 ironclad |
| `levelSpells` rockslide×1+bridge_collapse×1 | ch2_lv5 | inkRegenMult:0.5 经济紧张，法术替代费用 |
| `levelSpells` bridge_collapse×2 | ch4_lv4 | 岩浆+crossWaypoints，桥断强迫更绕路 |
| `escort` required:'all' (1 护送) | ch2_lv3 | bannedCards 禁兵营，需主动清路护送；护送单位 speed 0.38→0.25、hp 180→260（2026-06-28 调参：原值玩家无法通关） |
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
- ✅ **关卡编辑器（2026-06-18 落地）**：`LevelFormPanel` 新增「护送到达 (escort)」objective 选项（required: all/any/N 子表单）；levelSpells 编辑区（card 选择 + initialCount）；escorts 编辑区（id/hp/speed/startCol/startRow + 路径点列表增删）。✅ **BoardPanel 可视化路径拖拽已落地（2026-06-19，见 §4.9.4）**。
- ✅ **Vitest（2026-06-18 落地）**：`campaign-knobs.test.ts` 新增 5 个 escort 用例（spawn 事件、到达胜利、行进中未结束、全员阵亡判负、status 状态转换）。

### 4.9.4 BoardPanel 可视化路径编辑（✅ 2026-06-19 落地）

`crossWaypoints`（波次变道）与 escort `path`（护送路径）此前只能在右侧表单填数字。本批让两者在棋盘上**所见即所得**地点/拖编辑——关卡编辑器最后一块 UI 待办收口。

**交互（沿用画笔工具范式，新增两个工具）：**

| 工具 | 编辑对象 | 操作 |
|---|---|---|
| **变道** (`wp`) | 当前选中波次的 `crossWaypoints` | 点空格 = 追加变道点 `{atRow, toCol}`；拖节点 = 改位置；右键节点 = 删除。须先在时间线选中一条波次。 |
| **护送** (`escort`) | 选中 escort 的 `startCol/startRow` + `path` | 点护送起点/路径节点 = 选中该 escort；选中后点空格 = 追加路径点（须向敌方推进，保持行号严格升序，否则 no-op）；拖节点/起点 = 改位置；右键路径点 = 删除（起点删除走表单）。 |

**渲染（始终叠加，工具激活时高亮）：**
- 变道折线：从 `TOP_SPAWN_ROW` 出生点起 elbow 折线（当前列下行到 `atRow` → 横移到 `toCol`），延伸到基地行；敌方主题粉色，未激活时虚线点缀。
- 护送折线：起点 → 各 waypoint（垂直上行到 row → snap 到 col，与 `EscortSystem` 行为同构）→ 到达 `TOP_BUILDING_ROW`；绿色系，多 escort 用色板区分；选中 escort 加粗。
- 节点 = 圆形手柄（带序号），未激活工具时降为小圆点上下文提示。出生点画三角标travel 方向（敌人向下 / 护送向上）。

**数据约束（落在 `EditorState`，与 schema 对齐）：**
- 列吸附最近**攻击道**、行 clamp 到 `0..ROWS-1`（沿用表单 select 的约束）。
- escort `path` 行号**严格升序**硬约束：拖动时把行 clamp 进相邻节点的开区间，追加时拒绝不推进的点——保证导出永远过 `parseEscorts` 的「strictly ascending」校验。
- 变道折线按**数组顺序**画（与 `MovementSystem` 顺序消费 `pendingWaypoints` 一致），WYSIWYG 对应 JSON。

**接线：** `index.html` 加两个工具按钮 + 图例；`LevelFormPanel` 高亮 `selectedEscort` 并给「◉/◯ 在棋盘编辑路径」按钮做表单↔棋盘双向选中（escort 删除时同步修正 `selectedEscort` 索引）。

**公平墙不破**：纯 campaign 关卡编辑器表现层，不触碰运行时引擎 / PvP。验证：`tsc --noEmit` + webpack 生产构建通过（编辑器无 Vitest 套件，数据层约束在 `EditorState` 方法内保证）。

---

## 4.10 单阵营大关锁定 + 敌人按关缩放（2026-06-23 拍板并实现）

**目的**：第一、二章是玩家认识两位主角与世界观的关键，故把它们做成**单阵营对单阵营**的教学/叙事关：

| 大关（= 章节） | 玩家卡池（`loadout`） | 敌人波次（`waves[].unitType`） |
|---|---|---|
| 第一章 ch1（Tao） | Tao 三卡 `infantry/shieldbearer/archer`（各 _1/_2）+ 建筑/法术 | 只出 Anna 三卡 `max/lena/mara` |
| 第二章 ch2（Anna） | Anna 三卡 `max/lena/mara`（各 _1/_2）+ 建筑/法术 | 只出 Tao 三卡 `infantry/shieldbearer/archer` |
| ch3~ch6 | 不动（保持原设计） | 不动 |

- **建筑/法术不变**：`barracks/tower` + `haste/meteor` 仍进每关 `loadout`；关卡原有的建筑/法术 `bannedCards`（ch2_lv3 禁 barracks、ch2_lv6 禁 tower、ch2_lv10 禁 meteor/haste）与 `levelSpells`（rockslide/bridge_collapse）保留。
- **敌人 5 种收敛为对方 3 卡**（角色对应）：轻/快 `infantry/runner`→先锋（`max`/`infantry`）；重/坦 `shieldbearer/ironclad`→哨卫（`lena`/`shieldbearer`）；远程 `archer`→游击（`mara`/`archer`）。
- **受限 loadout 保意图换阵营**：ch2_lv4（双近战）、ch2_lv8（近战+法术）原是 Tao 受限阵容，按 `infantry→max / shieldbearer→lena` 等价改成 Anna。
- 玩家卡池后期若新增建筑/法术，沿用「整章 `loadout` 白名单」即可继续锁定。

### 敌人按关缩放：`LevelDef.enemyScale?: { hp?: number; damage?: number }`

| 字段 | `enemyScale?: { hp?: number; damage?: number }`（缺省 = 旧行为，ch3~ch6 不受影响） |
|---|---|
| 语义 | 配置后，**波次敌人（Top 侧）改用一套独立的、无玩家养成的基础蓝图**（`buildPvpBlueprints()` 的克隆），再乘以 hp/damage 系数 |
| 解决的问题 | 修复「敌人白嫖玩家养成」漏洞——蓝图按 `unitType` 敌我共享，第二章敌人用的正是玩家第一章练满级的 Tao 卡；独立基础蓝图把敌人强度与玩家养成解耦 |
| 引擎 | `GameEngine` 构造时按 `level.enemyScale` 预算 `enemyWaveBlueprints`；`spawnEnemyUnit()` 改用它（不再用 `state.unitBlueprints`）。仅 `campaign` 模式生效，`siege` 的 garrison/attackerArmy 不受影响 |
| 本期曲线 | ch1/ch2 各 10 关：`hp = 1+(lv-1)*0.07`、`damage = 1+(lv-1)*0.05`（lv1=1.0 基线即享受解耦，lv10 ≈ hp1.63/dmg1.45） |

**接线**：`LevelDefinition`（`enemyScale` 字段）、`levelSchema.ts`（解析+校验 >0）、`GameEngine.ts`（`enemyWaveBlueprints` + 缩放构造 + `spawnEnemyUnit` 改用）。20 个关卡 JSON 经一次性脚本批量改写。**验证**：engine `tsc --noEmit` + `npm test`（16/16）+ 20 关 `parseLevelDefinition` 全通过；client `tsc --noEmit` + `build:web` 生产构建通过。

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
  starThresholds: [number, number, number]; // 复合评分 S×100 的 [1★,2★,3★] 门槛（默认 [1,50,80]）；通关保底 1★，基地被打爆 0★。语义见 STAR_SCORING.md（2026-07-11 起由 HP% 轴改为 hp/speed/leak 复合轴）
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
| 星级评分 | **复合评分轴**（`STAR_SCORING.md`，2026-07-11）：hp/speed/leak 三子分按关型加权成综合分 S，对照 `starThresholds`（S×100 门槛）。**通关保底 1★**，基地被打爆 0★。速度子分让「守得完美」的进攻类通关仍按清场速度分档，解决旧 HP% 轴「通关即 3★、无梯度」。`computeStars(thresholds, ctx)` 单一来源，客户端 + 裁判 + 模拟器同口径（ctx 由各自 `snapshotSummary()`+`snapshotStats()` 组装）| `campaignProgress.stars[levelId]` |
| 关卡解锁链 | 通关（≥1★）解锁下一关 / 下一章。**所见即所玩**：CampaignMapScene 解锁/落点判断走 `game/campaign/progress.ts`（`isLevelUnlocked` / `currentLevelIdInChapter`），节点 levelId 与全局顺序 1:1，点哪关进哪关 | `campaignProgress.cleared[]` |
| 单位 / 卡牌解锁 | 章节通关解锁主角单位（仅外观 / 故事，竞技不受益） | 同上 |
| **PvE 养成（卖数值）** | 升级 PvE 单位数值，**只注入 campaign 引擎** | `campaignProgress.pveUpgrades`（硬墙，§3） |
| **皮肤** | 纯外观；通关奖励 / 付费 / 广告币兑换 | `campaignProgress.skins` |
| **广告币** | 看广告产出，只花在 PvE / 皮肤 | `campaignProgress.coins` |
| 无尽 / 挑战变体 | 同种子挑战、难度层（噩梦 / 地狱）、每关随机修饰符 | 复用 LevelDef + 修饰符 |
| 章节故事 | 复用 `IntroScene` 模式（逐行淡入 + 推进 + 跳过）+ i18n `story.*` | `story.*` 键 |

> **结算只触发一次（2026-06-21 修）**：引擎 `step()` 在 `GameOver` 后提前返回且**不清** `state.events`，
> `game_over` 事件会滞留队列被 `GameRenderer.update` 每帧重读 → 重复 `onGameEnd` → 重复 `recordClear` +
> 重复 `level_complete` 埋点（实测一次通关刷 ~20+ 条）。修复用 `GameRenderer` 的一次性 `gameEnded` 闸门
> 保证 `game_over`/`game_draw` 只结算一次（不在引擎清队列——netplay 追帧一 tick 多 step 时清会让渲染层错过事件）。

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
| LevelPrepScene UI 修缮 | ✅ **已完成（2026-06-30）**：① `brief` 面板 `breakWords:true`，CJK 长句不再溢出右侧，面板高度按实际行数自适应；② 关卡目标条（金色 accent bar，显示 `objective.kind` 对应描述，zh/en/de 均译，`LevelPrepCallbacks.objective` 由 `createAppCore` 透传）；③ 单位卡牌改为 2 列网格（3 行×2 列），垂直占用减约 50%，合成按钮与特质标签保留。 | — |
| LevelPrepScene 版式修复 + 奖励预览 | ✅ **已完成（2026-07-09）**：① `brief`/`objective` 面板左边界改用 `marginLineX(w)` 而非 `w*0.06`，修复面板/accent bar 压在红色装订线上的问题；② 目标条与体力条之间新增奖励预览行（绿色 accent bar，读取 `LevelDefinition.rewards.coins/materials`，复用 `scrap/lead/binding/coin` 图标），填补原先的大片空白，`LevelPrepCallbacks.rewards` 由 `game.ts.goLevelPrep` 透传；zh/en/de 补 `level.rewards.label`。 | 关卡目标区文字不再越过装订线；预备页信息密度提升，玩家进入战斗前可见通关收益 |
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
- [x] **PvE 后期多人副本（co-op）= 已定方向（ADR-030，2026-07-03）**：战役后期加多人合作副本，给**不玩 SLG 的玩家/鲸鱼**一个装备 + 角色卡战力的消耗与展示出口（摊薄「变现压 SLG」偏科）。PvE 性质 → 装备战力生效、**天梯硬墙不受影响**；产出复用 PvE 材料/装备 faucet（受体力闸门 + 反通胀预算，**不新增金币龙头**，ADR-011/014）。波次/组队/匹配/产出规格待铺。

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
3. ✅ **地图数据 + schema**（2026-06-19）：新增 `maps/ChapterMap.ts`（类型）+ `maps/mapSchema.ts`（`parseChapterMap` 运行时校验：节点 `levelId` 必须在 `CAMPAIGN_LEVELS`，坐标越界 `console.warn` 软告警）+ `maps/index.ts`（注册 `CHAPTER_MAPS` / `CHAPTER_ORDER` / `getChapterMap`，模块加载即解析全部 6 章，fail-fast）+ `maps/ch{1-6}.json`（每章 10 节点手摄归一化坐标，`path:'auto'`，decor 含 start/boss/场景物）。i18n 补 `campaign.ch{1-6}.venue`（zh/en/de）。game barrel 导出。新增 `test/mapSchema.test.ts`（6 用例）。
   - **顺带修复**：发现 campaign 关卡数据在棋盘从 6 路（`ATTACK_LANES=[0,1,2,5,6,7]`）迁到 12 列（`[0,1,2,3,4,7,8,9,10,11]`，5/6 变中央基地列）后留下的数据腐烂——`ch2_lv4`/`ch5_lv3` 的 `activeLanes` 含基地列 5/6，`ch6_lv1`/`ch6_lv8`/`ch6_lv10` 的 wave 在 5/6 列出兵。`parseLevelDefinition` 因此**在模块加载即抛错，整章战役崩溃**；因团队验证只跑 tsc+webpack（不跑运行时）一直未暴露。已将 activeLanes 收敛为合法攻击道集，wave 出兵 col 5→4 / 6→7（保留「中央钳形」意图）。全量 267 单测通过（含「每关确定性加载」）。
4. ✅ **章节页渲染**（2026-06-19）：`CampaignMapScene` 由扁平滚动列表整体重写为笔记本页。节点按 `maps/chN.json` 归一化坐标摆进内容区（避开 0.09w 红页边）；**铅笔虚线路径**（`palette.pencilLight` + `SketchPen` 抖动 dash，按 `path`/节点顺序）蜿蜒串联；节点态——已通关=金圈 + `★★★☆☆` 星章 / 当前可打=蓝圈**脉冲**（`update(dt)` sin 驱动 scale+alpha）/ 未解锁=淡铅笔轮廓；程序涂鸦 decor（`start/boss/rack/flag/banner/tent/tree/rock`，未知 kind 前向兼容跳过，零美术资产）。复用 `sketchUi`（`buildPaperBackground`/`sketchPanel`/`seedFor`）+ `SketchPen`。
5. ✅ **目录页 + 进度落点 + 翻页过场 + 章节小结仪式**（2026-06-19）：**目录页 landing**（6 章卡片：「第 N 章 · 场地」+ 通关进度 `{c}/{n} 关` + 累计星数；锁章盖**胶带**遮罩）；**进度落点**——进场停目录页随即自动翻到含「当前可打关」那一章（书自开）；**翻页过场**——横向 slide+fade（easeInOut 0.42s），目录↔章节、章节↔章节（左右翻页箭头，下一章须本章通关方亮），翻页中禁点击；**章节小结印章**——整章通关后标题旁盖旋转「第 N 章 · 通关」红章。回调接口 `CampaignMapCallbacks` 未改，`createAppCore` 接线 + `scenes.ui` 冒烟测试无需改动。i18n 补 `campaign.{notebookTitle,chapterStamp,chapterProgress,markerStart,markerBoss}`（zh/en/de）。验证：tsc + webpack 生产构建 + 273 单测 + 42 UI 测试全绿。
   - **§12 入口改造全部完成**：扁平列表彻底退场，战役正门 = 一本可翻的「战役笔记本」。

6. ✅ **虚线路径穿圈修复**（2026-07-04）：`drawTrail` 此前按节点圆心到圆心画铅笔虚线，穿过节点圆圈本体。改为每段两端各按节点半径（`Math.round(h * 0.032)`，与 `drawNode` 一致）向内收缩后再画 dash，虚线止于圆圈边缘；线段过短（≤ 2 倍半径）时跳过整段。
7. ✅ **章节页返回改直达大厅 + 新增「章节」按钮**（2026-07-14）：章节页的页眉「返回」原先会先翻回目录页（`backToToc`），需再点一次才出战役；现改为直接调 `onBack()` 回大厅，一步到位。目录页/总览的入口因此单独挪到页眉「装备」左侧新增的「章节」文字按钮（`campaign.chapters`，仅章节页渲染，目录页本身不画），点击即翻回目录页。i18n 补 `campaign.chapters`（zh/en/de）。`scenes.ui.ts` 更新「返回」回归测试（直达大厅、无翻页）+ 新增「章节」按钮存在性/翻页测试 + 目录页无该按钮的测试。
8. ✅ **锁章胶带盖字**（2026-07-25）：目录页锁章胶带（`drawTape`）此前是一条纯色斜条，视觉上像空白封条。加一个盖在胶带上的手绘印字（随胶带同角度倾斜、深墨色 60% 透明，读起来像透纸压印而非贴在表面），与右侧原有「🔒 未解锁」文案区分开，强化「封条贴死」的读法。新增 i18n `campaign.lockedStamp`（zh `封` / en `LOCKED` / de `GESPERRT`，沿用 `chapterStamp` 的全大写印章风格）。

> 公平墙不破：章节地图纯属 campaign 前端表现层，不触碰 PvP 引擎 / `campaignProgress` 数据来源隔离（§3）。
