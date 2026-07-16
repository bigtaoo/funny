# Notebook Wars — SLG 主城内政 / 建筑系统设计（书桌内政）

> 状态：设计中 · 权威：本文（建筑系统机制基准）· 创建：2026-06-30
> 上级：[`SLG_DESIGN.md`](SLG_DESIGN.md)（大世界总纲，§4 兵力/§7 经济/§9 架构）。本文把「点进主城的内政界面 + 建筑升级 + 加成 + 练兵」从 SLG §4/§7 承诺细化到字段/常量/注入点级别。
> 配套：[`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md)（faucet/sink 政策）、[`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md)（数字登记，本系统数值落 §13-SLG-CITY）、[`SERVER_API.md`](SERVER_API.md)（端点契约）、`server/shared/src/slg.ts`（常量真源）。
> 参考原型：三国志·战略版（灵犀互娱）主城内政——君王殿等级门控 + 资源建筑提产量 + 民居产币 + 校场练兵 + 城防提耐久 + 科技建筑加成 + 官职委任。本文取其**结构**，换我们的文具皮 + 5 资源 + 统一养成边界。

---

## 0. TL;DR

- **资源结构（对齐三战的「4 地块 + 1 铜币」，SLG §3.4 五种）**：`ink/paper/graphite/metal` = 三战的**粮/木/石/铁，四种地块资源**（`biomeAt` 地图产）；`sticker`（贴纸）= 三战的**铜币位**，通用流通资源，**由主城产**（民居模型），非地块。
- **要解决的两个真问题**（SLG §15 盘点遗留）：
  1. **`graphite`（石墨=石料）空转的真因 = `biomeAt` 漏了它**——现行 biome 只三分（`ink<t0<paper<t1<metal`，`slg.ts:587`，注释明说「only the three land-mined resources」），graphite 本该是**第 4 种地块资源**却没进 biome → **补成四分即给它地图 faucet**（不是「让主城自产」，我早先方案此处搞反）。`sticker`（铜币位）空转的真因 = 没有「民居」式主城产出 → 由主城 `stickerShop` 自产补 faucet。两者的 sink 都来自**高级建筑升级消耗**。
  2. **`troopCap`（兵力上限）是死值**——恒为 `TROOP_CAP_BASE`，没有成长曲线；练兵（`trainTroops`）已落地但训练速度/队列/上限都没有可升级的来源。
- **方案**：仿三战，**主城点进去 = 独立内政界面（`CityScene`）**，里面摆「书桌（Desk，总等级门控）+ 一排文具建筑」。建筑升级吃**赛季资源 + 时间**（时间 = coin 加速变现点），分别驱动：**4 地块资源产率乘数 / sticker 主城自产 / 仓储上限 / 兵力上限 + 练兵 / 主城城防**。
- **这一刀让经济循环转起来**：①`biomeAt` 补 graphite 第 4 地块 → graphite 有地图 faucet；②主城 `stickerShop`（民居模型）自产 sticker → sticker 有 faucet；③高级建筑升级**消耗** graphite（高阶建材）+ sticker（通用）→ 两者有 sink；④4 个资源建筑给 `ink/paper/graphite/metal` **全局产率乘数**（地图仍是主产）。
- **赛季边界（D-CITY-1，✅ 2026-06-30 拍板：清空）**：建筑/资源/兵力/地图态等 **SLG 赛季内战略态全部赛季重置清空**（对齐 SLG4），是变现发动机「重肝」。**跨季只留 meta 系统资产**——主要是**材料**（scrap/lead/binding，赛季产出经邮件入 `SaveData.materials`，G4 已通），材料再合成装备（meta 主产是材料，**直接发装备的地方很少**）。建筑**不进跨季养成**，**天梯红线不动**（建筑永不喂 `buildPvpBlueprints`）。
- **复用现有地基，零新战斗模型**：`recomputeYield`（产率出口）/ `trainTroops`+`trainingQueue`（练兵）/ `buildSiegeBattle`+`landSiege`（主城围攻）/ `speedupTraining`（加速变现）全是现成的，建筑只是给它们喂参数 + 加一条 `buildQueue` 调度（复刻 `trainingQueue` 模式）。

---

## 1. 借鉴三战的什么（结构），换掉什么（皮与边界）

| 三战做法 | 我们采用 | 我们改动 |
|---|---|---|
| 点进主城 = 独立内政九宫格界面（与大地图分离） | ✅ 主城点进 = `CityScene` 内政界面 | 九宫格摆位换**手绘书桌俯视**（文具摆在桌上，SketchPen 风） |
| 君王殿单一总等级，门控所有建筑可升上限 + 解锁顺序 | ✅ **书桌（Desk）** = 单一总门控 | 命名换文具皮；门控逻辑照搬 |
| 4 地块资源建筑（农田/伐木/冶铁/采石）提对应**地块资源**产量 | ✅ 4 资源建筑对应 `ink/paper/graphite/metal`（粮木石铁） | 资源主产在**地图格**（惰性结算）→ 资源建筑改为**全局产率乘数**；**graphite 须先补进 `biomeAt`**（现行漏产，P1 前置）才有地块可乘 |
| 民居产铜币（+ 税收） | ✅ **贴纸铺（Sticker Shop）= 民居模型** | 「铜币位」由 `sticker` 承担 → 贴纸铺**主城自产 sticker**（sticker 非地块、无 biome）；**绝不产 coin**（coin 是唯一货币、严控通胀，铁律 D-CITY-5） |
| 校场/演武场练兵、提武将属性 | ✅ **练兵场（Drill Yard）** | 只提 `troopCap`/训练速度/队列；**不提单位战力**（战力归统一养成树的装备/科技，避免双注入 + 守红线） |
| 城墙/城防军提城池耐久 + 守军 | ✅ **城墙（Wall）** 注入主城围攻 | 仅增益**主城那一格**（你的命门）；普通领地防守仍靠 garrison + 玩家布阵 |
| 科技建筑（军机营/工程营）给科技树加成 | △ Phase 2 **书院（Academy）** | 只做 **SLG 赛季内**蓝图 buff 叠加层，跨季科技仍归统一养成树 |
| 官职委任（派武将当木材官/练兵使，按政治属性加成） | △ Phase 3 **委任内政官** | 把已养成的**角色卡**（陶3/Anna3/6 单位）派进建筑加成——给角色一条 SLG 内政出路，不碰天梯 |
| 建筑升级吃资源 + 时间，时间可花钱加速 | ✅ 照搬 | 资源 = 5 赛季资源；加速花 **coin**（变现，复用 `speedupTraining` 模式） |

**一句话边界**：三战的「建筑提武将属性=养成」被我们拆走——**战力养成 = 跨季统一树（装备/科技）**，**主城建筑 = 赛季内政（经济/兵力/城防）**。两者都喂 SLG 围攻，但只有装备/科技跨季留存，建筑季末清。天梯永不接二者。

---

## 2. 锁定 / 待拍板的设计决策

| # | 决策 | 结论 / 倾向 | 状态 |
|---|---|---|---|
| **D-CITY-1** | 建筑赛季是否清空 | **✅ 清空（2026-06-30 拍板）**：建筑/资源/兵力/地图态等赛季内战略态全清（对齐 SLG4），= 变现发动机「重肝」。**跨季只留 meta 系统资产**，主要是**材料**（材料合成装备；meta 直接发装备的地方很少）。建筑不进养成树。 | 锁定（待落 ADR） |
| **D-CITY-2** | 资源 faucet 模型（对齐三战 4 地块 + 1 铜币） | `ink/paper/graphite/metal`（粮木石铁，4 地块）= 地图 `biomeAt` 产 + 主城**全局产率乘数**；**`graphite` 须先补进 `biomeAt`**（现行三分漏了它，P1 前置）。`sticker`（铜币位/通用）= 主城 `stickerShop`（民居模型）**自产**，非地块。 | 锁定（修正早先「graphite 主城自产」错案） |
| **D-CITY-3** | 建筑是否影响单位战力 | **否**。战力归统一养成树（装备/科技）。建筑只动经济/兵力上限/主城城防。避免双注入复杂度 + 守红线清晰。书院（Phase 2）是唯一例外（赛季内蓝图 buff，独立注入口）。 | 锁定 |
| **D-CITY-4** | 主城本体命名 | **书桌（Desk）** 作内政中枢隐喻（文具摆桌上）。显示名 DRAFT，最终皮由 [`art-direction`](../product/art-direction.md) 定。 | DRAFT |
| **D-CITY-5** | 建筑升级是否吃 coin | **否**（coin 是唯一货币、跨季、严控通胀；不靠建筑印也不靠建筑烧）。升级吃 5 赛季资源 + 时间；**coin 只用于加速**（变现）。 | 锁定 |
| **D-CITY-6** | 红线 | 建筑**永不**进 `buildPvpBlueprints()`（天梯）。建筑注入只走 SLG 路径（`recomputeYield`/`trainTroops`/主城 `buildSiegeBattle`）。 | 锁定（不可破） |
| **D-CITY-7** | `desk` 等级上限 | **20 → 10（2026-07-15 拍板，修正早先错案，已实现）**：早先 `DESK_MAX_LEVEL=20` 的注释「aligned with Three-Kingdoms 20」未经查证，网络核实三战主城（君王殿）实际满级为 **10 级**（[来源](http://m.7724.com/sggame/news/23083.html)）。改为 10 级对齐。`server/shared/src/slg/city.ts`：`DESK_MAX_LEVEL=10`；所有每级加成 STEP 常量（`BUILD_YIELD_STEP`/`CABINET_CAP_STEP`/`DRILL_TROOPCAP_STEP`/`DRILL_TRAIN_SPEED_STEP`/`WALL_DEFENSE_STEP`/`ACADEMY_*_STEP`/`CABINET_PROTECT_STEP`）翻倍、`STICKER_SELF_BASE` 翻倍，使满级总加成与旧 L20 一致；`BUILD_COST_BASE`/`BUILD_TIME_BASE_SEC` 统一 ×4（sum₂..₂₀lvl / sum₂..₁₀lvl ≈3.87，取整 4×）使总投入量级不变。已用 `econ-sim`（`cityRun.ts`）核对：满级倍率/上限与旧数值一致，总花费/耗时/各画像天数与旧基线同量级，休闲档仍在 60 天赛季窗口内。 | **已实现**（`server/shared/src/slg/city.ts`；econ-sim 核对通过） |
| **D-CITY-8** | 城池耐久（durability）机制 | **新增持久化状态（2026-07-16 服务端已实现）**。上限由 `wall`（城墙）等级决定（`baseDurabilityMax(wallLevel) = BASE_DURABILITY_BASE + wallLevel×BASE_DURABILITY_WALL_STEP`；不采用三战「君王殿本身给耐久」的路数，我们刻意偏离参考，城墙专职耐久；wall 原先「围攻时临时给守军加HP」的 `wallDefenseMult` 机制已移除，全部改走耐久）。攻城结算：**先打赢驻军战斗 → 胜利后 5 分钟宽限期 → 按攻方攻城值（与地图上攻占城池同一套规则）扣减耐久**（`settleSiegeDamage`，`durability`/`durabilityMax` 落在主城 anchor `TileDoc` 上，替代原先复用的 `hp`/`buildingMaxHp(level)`）。耐久随时间**缓慢自愈**（`regenDurability`，`BASE_DURABILITY_REGEN_PER_HOUR` 每小时定量恢复，具体速率待数值模拟；读路径惰性计算展示值、不落库，只有真实结算/城墙升级完成才落库，同 `yieldRate` 的惰性结算风格）。**耐久归零 → 城池被摧毁 → 玩家丢失全部领地 → 服务端强制迁城**（复用既有 `passiveRelocate`，新增系统邮件 `slg.city.durabilityBreached.{subject,body}`，此前玩家对该结果**没有任何通知**）。城墙升级完成时按差值调整 `durabilityMax`（保留已损伤的绝对值，不重置满血）；玩家主动 `relocate` 同样保留已损伤耐久（不是免费回血）。**世界地图 HP 血条 + 被围攻全屏泛红特效仍是 DRAFT，客户端未实现**（服务端 view 字段沿用既有 `hp`/`maxHp` 命名，契约不变，客户端可直接接线）。 | **已实现（服务端）**，`server/shared/src/slg/siege.ts` + `worldsvc/src/combatSiege/{damage,helpers,arrival}.ts` + `city.ts`/`coreSpawn.ts`/`coreHelpers.ts`；客户端血条/泛红特效待后续 |
| **D-CITY-9** | 队伍出征携带兵力上限 | 新建筑（`satchel`，书包，隐喻文具书包能装多少东西，**已实现**）：**只管单支队伍出征时最多携带多少兵**，与 `drillYard`（总兵力上限 + 训练速度 + 训练队列上限）是两个独立维度，不合并。同样受 `desk` 门控。 | **已实现**（`server/shared/src/slg/city.ts` + `combatMarch.ts` 出征校验） |
| **D-CITY-10** | 队伍面板（5 队 t1-t5） | `CityScene` 新增队伍信息栏：5 支队伍（复用现有 `SIEGE_TEAM_CAP=5` / `t1..t5` 数据模型），每队显示当前兵力（`cardState.currentTroops`）/ 状态（驻军在家 / 出征中 / 受伤冷却 `teamState.injuredUntil`）。未指派 march 的队伍 = 驻军，血量与兵力信息同样在这里查看。**委任（角色派进建筑）维持 P1 已拍板的 DROPPED，不恢复**。**已实现（2026-07-16）**：军事页 2 列卡片网格，只读展示（编辑仍走地图入口的 `TeamsScene`），复用其 `teamOrder`/`committedTroops` 判定逻辑；状态优先级 受伤>行军/占领>驻军在家>空。 | **已实现**，`client/src/scenes/CityScene.ts`（`renderTeamPanel`/`renderTeamCard`） |
| **D-CITY-11** | 双屏拆分 | 内容扩容后单屏挤不下，拆两屏、玩家可切换：**屏 1（内政）** = 资源条 + 现有建筑网格（含新 `satchel`）；**屏 2（军事）** = 队伍面板（D-CITY-10）+ 科技树独立面板（`academy` 从建筑网格挪出，见下）+ 耐久状态展示。**切换机制已实现**（`CityScene` 头部下方双 tab，内政/军事）；队伍面板（D-CITY-10）+ 科技树面板（D-CITY-12）均已落地，军事页仅剩耐久状态展示待做。 | **已实现（切换机制 + 队伍面板 + 科技树面板）**，`client/src/scenes/CityScene.ts` |
| **D-CITY-12** | 科技树面板 | `academy` 从「建筑网格里普通一栋楼」升级为**军事屏内独立面板**，给赛季内蓝图 buff 投入应有的仪式感；底层注入逻辑（`buildSiegeBlueprints` 叠加层）不变，只是 UI 呈现独立出来。 | **已实现**（2026-07-16），`client/src/scenes/CityScene.ts`（`renderTechTreePanel` + `DOMESTIC_BUILDING_KEYS`），回归测试 `client/test/ui/cityScene.ui.ts` |

---

## 3. 建筑清单（v1）

> 显示名为 DRAFT 文具皮，code key 为权威（英文）。资源 code = `ink/paper/graphite/metal/sticker`（见 SLG §3.4）。

| code key | 显示名（DRAFT） | 类别 | 作用 | 注入点 | 阶段 |
|---|---|---|---|---|---|
| `desk` | 书桌 | 枢纽 | **总等级门控**：决定其余建筑可升上限（`buildLevel ≤ desk`）+ 解锁顺序；自身升级提主城基础耐久 + 开建造队列槽位 | 门控校验 + `wall` 基线 | P1 |
| `inkPot` | 墨水瓶 | 资源 | **ink 全局产率乘数** ×(1+lvl·step) | `recomputeYield` | P1 |
| `paperTray` | 纸盘 | 资源 | **paper 全局产率乘数** | `recomputeYield` | P1 |
| `graphiteMill` | 石墨坊 | 资源 | **graphite 全局产率乘数**（石料=地块资源，须先补 `biomeAt` 第 4 分区） | `recomputeYield` | P1 |
| `metalForge` | 金属铸坊 | 资源 | **metal 全局产率乘数** | `recomputeYield` | P1 |
| `stickerShop` | 贴纸铺 | 资源（民居模型） | **sticker 主城自产**（铜币位/通用资源 faucet，非地块）→ **激活 sticker faucet**；绝不产 coin | `recomputeYield` 自产项 | P1 |
| `cabinet` | 文件柜 | 仓储 | 提 `RESOURCE_CAP`（仓储上限）+ 被掠夺时保护一部分（三战仓库护粮） | `settleResources` cap + `applySiege` loot | P1 |
| `drillYard` | 练兵场 | 军事 | 提 `troopCap`（**总兵力上限**）+ 训练速度（`trainTroops` 时长）+ 训练队列上限（`TROOP_TRAIN_QUEUE_MAX`）+ 解锁更高兵种训练 | `trainTroops` / `troopCap` | P1 |
| `satchel` | 书包 | 军事 | 提**单支队伍出征携带兵力上限**（与 `drillYard` 的总兵力上限是两个独立维度，D-CITY-9）：`satchelCarryCapFor`=`SATCHEL_CARRY_BASE`(=`TROOP_CAP_BASE`=2000，零级即可单队带满初始兵力池) + `satchel` 每级 `SATCHEL_CARRY_STEP`(=1000)，满级(L10)=12,000，与 `drillYard` 满级总 `troopCap` 相等（满配才能单队打满仓）。 | `server/worldsvc/src/combatMarch.ts` `startMarch`：team 出征时校验实际携带兵力（flat army 用 `troops`；card army 用 `cardState.currentTroops` 求和）不超过该 cap，超限 `SATCHEL_CAP_EXCEEDED` | **已实现** |
| `wall` | 城墙 | 城防 | **主城耐久（durability）上限来源**（D-CITY-8，2026-07-16 已实现，由"围攻时临时给守军加 HP"升级为持久化耐久值）：被围攻战斗获胜后 5 分钟宽限期，按攻方攻城值扣耐久；耐久随时间自愈；归零 = 城池摧毁 + 丢失全部领地 + 强制迁城 + 系统邮件 | 主城 `settleSiegeDamage` + `baseDurabilityMax`/`regenDurability`（`shared/src/slg/siege.ts`） | P2（耐久化改造 P3 已实现，客户端血条/特效待后续） |
| `academy` | 书院 | 科技 | **SLG 赛季内**蓝图 buff（HP/伤害/速度），季末清；UI 独立成军事屏的科技树面板（D-CITY-12） | `buildSiegeBlueprints` 赛季叠加层 | P2 |
| ~~（委任）~~ | ~~内政官~~ | ~~加成~~ | ~~派角色卡进建筑，按角色属性给该建筑额外加成~~ | ~~各建筑乘数~~ | **DROPPED** |

**faucet/sink 闭环（激活 graphite/sticker）**：

```
faucet ── 地图资源点（biome 地块）：ink / paper / metal（已有）
       │                          └ graphite（新：biomeAt 三分→四分，补第 4 地块）★P1 前置
       └─ 主城 stickerShop（民居模型）：sticker（铜币位/通用，主城自产，非地块）
sink ──── 建筑升级消耗赛季资源；高级建筑（cabinet/drillYard/wall/academy 高 lvl）
          吃 graphite（高阶建材，SLG §3.4 定义）+ sticker（通用流通）
          → graphite 有地块产 + sticker 有主城产，两者再被建筑升级消耗 → 空管子转起来
```

> ★ **P1 前置：`biomeAt` 补 graphite 第 4 地块**——现行 `biomeAt`（`slg.ts:587`）三分仅 ink/paper/metal；改为四分（如 `ink < t0 < paper < t1 < graphite < t2 < metal`，阈值待 §7 调参），让 graphite 像其余三种地块资源一样从地图产出。这是「graphite 不再空转」的根，非建筑本身。

---

## 4. 数据模型（`PlayerWorldDoc` 扩展，赛季清）

> 现状（`worldsvc/src/service.ts`/`db.ts`）：`PlayerWorldDoc` 已有 `resources`（5 类）/`troops`/`troopCap`/`trainingQueue`/`yieldRate`/`hasBattlePass`/`lastTickAt`/`familyId`/`mainBaseTile`。建筑系统加两个子文档：

```ts
// PlayerWorldDoc 扩展
buildings?: Partial<Record<BuildingKey, number>>;  // key → level（缺省=1 for desk / 0 未建 for 其余）
buildQueue?: { key: BuildingKey; toLevel: number; startAt: number; completeAt: number }[];
// BuildingKey = 'desk'|'inkPot'|'paperTray'|'graphiteMill'|'metalForge'|'stickerShop'|'cabinet'|'drillYard'|'wall'|'academy'
```

- **赛季清空（D-CITY-1）**：`resetSeason` 的 `clearWorldOnReset` 增清 `buildings`/`buildQueue`（新赛季从 `desk:1` 起步）。落城（`joinWorld`）初始化 `buildings={desk:1}`。
- **`buildQueue` 调度**：复刻 `trainingQueue` 模式——`scheduler.ts` 的 `setInterval` 扫 `buildQueue.0.completeAt ≤ now` → `processDueBuilds` 原子认领 → `$inc buildings.{key}` + shift 队列 + 触发 `recomputeYield`（资源建筑完工即生效）。**v1 建造队列并发=1**（付费/战令开第 2 槽，§6 变现）。
- **`PlayerWorldView`** 透出 `buildings` + `buildQueue`（客户端 `CityScene` 渲染）。

---

## 5. 注入点（复用现有函数，逐一对接）

> 全部 SLG 侧注入，**不碰** `buildPvpBlueprints`（D-CITY-6 红线）。新增纯函数落 `@nw/shared/slg.ts`（双端可算 + 可单测）。

> **⚠️ 状态更新（2026-07-07）**：本节及下文多处「★P1 前置 / 现行三分 / 待补 graphite」是规划期语言。`biomeAt` 四分**已落地**（见 §10 实现进度：`ink<0.30<paper<0.55<graphite<0.78<metal`，代码 `shared/slg.ts` `biomeAt`），graphite 已有地图 faucet。下列「P1 前置」标记视为历史，不再是待办。
>
> **⚠️ 分布机制更新（2026-07-15）**：本节及下文「四分」「阈值 `ink<0.30<paper<0.55<graphite<0.78<metal`」描述的是**分布机制的历史版本**——当时 `biomeAt` 用低频噪声阈值把地图切成四块连续同资源区域。**该机制已重写**（见 [`map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8 2026-07-15 条目）：现在每个格子独立抽样四种地块资源，仅按所在省份的「偏向资源」（`leaningResourceForProvince`）小幅加权（`SLG_GEN.biomeProvinceBias=0.15`），不再有连续同资源区域。**graphite 是第 4 种地块资源、经 `biomeAt` 产出**这个决策本身（ADR-022）不变，变的只是"怎么在空间上分布"；下文提到的具体阈值常量（`biomeInkMax` 等）已随重写删除，不再存在于代码里。

| 注入点 | 现状 | 改动 |
|---|---|---|
| **`biomeAt`**（地图地块资源分区，`slg.ts:587`）✅ 已四分 | ~~三分仅 `ink/paper/metal`~~ → 已四分含 `graphite` | 已改四分加入 `graphite`（粮木石铁四地块），graphite 有地图产出。阈值见 §7。 |
| **`recomputeYield`**（产率唯一出口，所有改产率路径已收口于此） | 聚合领地格 `tileYield` + 国民加成 | 末尾乘 `buildingYieldMult(buildings, rt)`（4 地块建筑 inkPot/paperTray/graphiteMill/metalForge）；加 `buildingSelfYield(buildings,'sticker')` 自产项（stickerShop=民居模型，sticker 非地块）。`Math.floor` 保整。 |
| **`settleResources`**（惰性结算，cap=`RESOURCE_CAP`） | `min(settled, RESOURCE_CAP)` | cap 改 `resourceCap(buildings)` = `RESOURCE_CAP × (1+cabinet·step)`（文件柜提仓储上限）。 |
| **`trainTroops` / `troopCap`** | `troopCap` 恒 `TROOP_CAP_BASE`；训练时长 `TROOP_TRAIN_TIME_SEC × battlePass` | `troopCap = troopCapFor(buildings)` = `TROOP_CAP_BASE + drillYard·step`；训练时长再乘 `drillTrainMult(drillYard)`；队列上限 `TROOP_TRAIN_QUEUE_MAX + drillYard 档`。 |
| **主城 `buildSiegeBattle`/`landSiege`**（仅 `type:'base'` 分支） | 按 tileLevel 派生基地 | 主城被围攻 → 基地等级/守军 HP 乘 `wallDefenseMult(wall)`（P2）。普通领地不受影响。 |
| **`buildSiegeBlueprints`**（SLG 围攻蓝图，统一养成口） | 吃 `pveUpgrades`（装备/科技） | P2 叠加 `academyBuff(academy)` 作**赛季内**临时层（独立形参，季末清）。天梯口 `buildPvpBlueprints` 不动。 |
| **掠夺 `applySiege` loot** | 按 `SIEGE_LOOT_RATE` 比例掠 | 主城被破时 `cabinet` 保护一部分（`lootRate × (1 − cabinetProtect)`）。 |

新增服务方法（worldsvc `service.ts`）：
- `upgradeBuilding(worldId, accountId, key)`：校验 `desk` 门控（`buildings[key]+queue 目标 < desk` 或 key=desk）+ 结算后资源足（`buildCost(key, toLevel)`）+ 队列未满 → 扣资源 + push `buildQueue` → 推 `build_update`/或 me 轮询。
- `speedupBuild(worldId, accountId, key, coins)`：复刻 `speedupTraining`（coin → 时间，`hasBattlePass` 折扣）。

---

## 6. 变现点（SLG = 赚钱区，全走 commercial）

- **建造队列加速**：coin 缩短 `completeAt`（复用 `speedupTraining`，`hasBattlePass` 享 15% 折扣，对齐已有练兵加成）。
- **第 2 建造队列槽位**：默认 1 槽；付费道具 / 战令解锁第 2 槽（并发建造）。
- **资源包**（commercial，已有）：直接补 5 赛季资源缺口。
- **`hasBattlePass`**：建造速度 +X%（对齐已有「练兵 +20%」，数值 §7）。
- 铁律延续：**不卖战力上限的硬突破**——建筑上限由 `desk` 等级门控，desk 升级靠资源+时间，coin 只买**速度**不买**上限**（防 P2W 直接破生态）。

---

## 7. DRAFT 数值（已过 B 轨节奏核验 2026-06-30；登记 → ECONOMY_VERIFICATION_LOG §13-SLG-CITY）

> **已过 B 轨建筑/练兵节奏核验**（2026-06-30，econ-sim `city.ts`）：faucet/sink 与重肝节奏成立（paper 7.7× cap 的资源门控肝、落 60 天窗口、满级乘子合理）——方法/判据见 [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) §4，**完整结论 + 参数表登记在** [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md) **§13-SLG-CITY**。常量真源 = `server/shared/src/slg.ts`，下表是设计侧占位快照（数值仍 DRAFT，终态判据=上线后实测）。

| 常量（占位名） | 占位值 | 说明 |
|---|---|---|
| `DESK_MAX_LEVEL` | 20 | 书桌（总门控）上限，对齐三战 20 级 |
| `BUILDING_MAX_LEVEL` | =desk 当前等级 | 各建筑 ≤ 书桌等级 |
| `biomeGraphiteMax` 等四分阈值 | DRAFT | `biomeAt` 三分→四分（加 graphite 地块）的分区阈值（★P1 前置） |
| `BUILD_YIELD_STEP` | 0.05（+5%/级） | inkPot/paperTray/graphiteMill/metalForge 每级产率乘数（4 地块） |
| `STICKER_SELF_BASE` | DRAFT | stickerShop（民居模型）自产 sticker 基底/h（× lvl）；graphite 走地块产，无自产基底 |
| `CABINET_CAP_STEP` | 0.1（+10%/级） | 文件柜每级仓储上限；满级保护掠夺 X% |
| `DRILL_TROOPCAP_STEP` | DRAFT | 练兵场每级 troopCap 增量 |
| `DRILL_TRAIN_SPEED_STEP` | DRAFT | 练兵场每级训练提速 |
| `WALL_DEFENSE_STEP` | DRAFT | 城墙每级主城基地/守军加成（P2） |
| `BUILD_COST_{key}(level)` | DRAFT | 升级消耗 5 资源曲线；高级吃 graphite+sticker（sink） |
| `BUILD_TIME_{key}(level)` | DRAFT | 建造时长曲线（= coin 加速变现点） |
| `BUILD_QUEUE_SLOTS` | 1（付费 2） | 默认建造并发 |

---

## 8. 客户端 UI（用户要的「点进主城界面」）

- **入口**：`WorldMapScene` 点**自己主城**（`type:'base'` 且 `mine`）→ 菜单「进入主城 / Enter Desk」→ 新场景 **`CityScene`**。
- **`CityScene`**（手绘书桌俯视，SketchPen 风）：
  - 书桌上摆一排文具建筑图标，标等级徽章；底部 5 资源条（当前量/产率/仓储上限）。
  - 点建筑 → 详情卡：当前等级 / 各级加成曲线 / 下一级消耗（5 资源 + 时长）/「升级」按钮（资源不足置灰）。
  - 建造队列条（进行中建筑 + 倒计时 + 「加速」coin 按钮）。
  - **练兵入口并入此处**（三战练兵在校场）：点 `drillYard` → 练兵面板（数量滑杆 + 队列 + 加速），复用现有 `trainTroops`/`speedupTraining` API。
- 返回大地图。i18n 三语（zh/en/de），key 前缀 `city.*`。

### 8.1 卡片网格重设计（2026-07-15）

`CityScene` 是 P1 UI 落地之后唯一一个没并入全局 UI 规范的场景——独立手搓 title/back，10 个建筑挤成固定 4 列小格（10-11px 字号），点击后详情卡贴在屏幕角落，没有滚动指示。对齐 Roster/Skins/Teams 等场景已用的卡片网格语言，重做为：

- **头部**：统一走 `drawSceneHeader`（`HEADER_ACCENT.slg` 红色下划线），废弃自绘 title/back（连带删掉此前仅本场景使用的 `city.back` i18n key）。
- **建筑网格**：从固定 4 列表格改为动态列数卡片网格（目标卡宽 148px，参照 Skins 衣橱 `CARD_W_TARGET` 的算法），卡片放大到 148×128，图标放大到 40px；超出视口时可拖拽滚动 + `drawScrollIndicator`（滚动状态走 `scrollDirty` 标记在 `update()` 里延迟渲染，避免每次 pointermove 都重绘造成卡顿，参见 `client-run-and-visual-verify` 同类教训）。
- **详情卡改为弹窗**：复用 Roster/Equipment 详情卡的「弹窗缩放到屏幕 80%」惯例（横屏按高、竖屏按宽缩放），点击背景空白处关闭；**弹窗打开时清空建筑格/建造队列的旧命中区**，只保留 Back + 弹窗自身命中——否则暗化背景下露出的卡片仍可点中，会在关闭弹窗前意外切换到另一栋建筑。
- **建造队列倒计时**：从裸秒数改用 `formatDuration`（worldmap 车队计时器已用的 mm:ss / h:mm:ss 格式），i18n `city.queueEntry` 模板同步去掉多余的尾随 `s`。
- 验证：`tsc --noEmit` + `webpack build:web` 全绿；headless 注入 `CityScene` 实例（假 `ILayout`/`InputManager`/`WorldApiClient`）在真实 1080×1920（竖）与 1920×1080（横）设计分辨率下截图核对，含建筑网格、建造队列、详情弹窗三态。

### 8.2 P3 扩容：军事屏 + 耐久系统（2026-07-15 讨论；耐久系统服务端 2026-07-16 已实现，军事屏 UI 仍 DRAFT）

> 讨论背景：用户对照三战重新审视这屏承载的功能，结论是当前 `CityScene` 只做了"建筑管理"，缺一整块"主城军事状态仪表盘"。决策见 D-CITY-7~12。

- **双屏拆分**：`CityScene` 拆为可切换的两页——**内政页**（现有资源条 + 建筑网格，含新增 `satchel`）与**军事页**（新增，队伍面板 + 科技树面板 + 耐久状态）。切换方式待 UI 布局阶段定（tab / 左右滑动均可）。
- **队伍面板**（军事页）：5 支队伍（t1-t5）卡片，每卡显示当前兵力（`cardState.currentTroops`）+ 状态（驻军在家 / 出征中 / 受伤冷却）。数据模型已存在（`SIEGE_TEAM_CAP`/`cardState`/`teamState`），本次只是**首次给它一个统一的展示位**，此前分散在出征弹窗里。
- **科技树面板**（军事页）：`academy` 从建筑网格挪出，独立呈现，注入逻辑不变。
- **耐久（durability）系统**（D-CITY-8，2026-07-16 服务端已实现）：
  - 持久化字段：`TileDoc.durability`/`durabilityMax`/`durabilityRegenAt`，仅主城 anchor 使用（`wall` 等级决定上限：`baseDurabilityMax`）；territory/stronghold 不受影响，仍走原有 `hp`/`buildingMaxHp(level)`。
  - 结算流程：驻军战斗胜负照旧 → 攻方获胜后 **5 分钟宽限期** → 按攻方**攻城值**（复用地图占城同一套规则）扣耐久（`settleSiegeDamage`）。
  - 自愈：惰性结算（`regenDurability`，仿 `yieldRate` 风格）——读路径（地图/单格视图）实时算出展示值但不落库；只有真实攻城结算或城墙升级完成才落库。速率 `BASE_DURABILITY_REGEN_PER_HOUR` 待数值模拟。
  - 归零：城池摧毁 → 玩家丢失全部领地 → **服务端强制迁城**（复用既有 `passiveRelocate`：清空领地 + 选新落脚点 + **新增系统邮件** `slg.city.durabilityBreached.{subject,body}`，此前该结果没有任何通知）。
  - 城墙升级完成：按新旧 `durabilityMax` 差值调整当前耐久（保留已损伤的绝对值，不重置满血）。
  - 玩家主动 `relocate`：同样保留已损伤耐久（不是免费回血）；被动迁城后是全新满耐久基地。
  - 表现（**未实现，客户端待后续**）：世界地图基地图块上方常驻血条（耐久不满时显示）；被围攻/耐久被扣时客户端全屏泛红特效。服务端 view 字段沿用既有 `hp`/`maxHp` 命名，客户端契约不变。
- **`satchel`（书包）建筑**（新增，D-CITY-9）：单队出征携带兵力上限，独立于 `drillYard` 的总兵力上限，受 `desk` 门控。
- **`desk` 等级上限改 10**（D-CITY-7）：需重新过 `econ-sim` 数值模拟，本次讨论只定方向，具体曲线延后。
- **未决**：耐久扣减/自愈的具体数值、`satchel` 携带量曲线、双屏切换的具体交互，均待后续数值模拟 + UI 布局阶段细化。

---

## 9. 契约 / 端点（→ SERVER_API + openapi-world）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /world/build/upgrade` `{key}` | 玩家 JWT | `upgradeBuilding`，扣资源入队 |
| `POST /world/build/speedup` `{key, coins}` | 玩家 JWT | `speedupBuild`，coin 加速 |
| `GET /world/me`（扩展） | 玩家 JWT | 返回 `buildings` + `buildQueue` |

- `openapi-world.yml`：`PlayerWorldView.buildings`/`.buildQueue` + 两端点 + `BuildingKey` enum；`rest:gen` 重生 `openapi-world.ts`。
- proto：完工推送可走既有 me 轮询；若要实时，加 `build_update`（同 `march_update` 模式，可后置）。

---

## 10. 分期（可独立验收）

- **P1 — 核心经济闭环（最该先做，解空转 + troopCap 成长）**：
  - **★前置：`biomeAt` 三分→四分加入 graphite**（给 graphite 地图 faucet，根因修复，与建筑解耦但同刀做）。
  - `desk` 门控 + 4 地块资源建筑（inkPot/paperTray/graphiteMill/metalForge，全局产率乘数）+ `stickerShop`（民居模型，自产 sticker faucet）+ `cabinet`（仓储）+ `drillYard`（接 `troopCap`/训练）；高级建筑升级吃 graphite/sticker（**sink**）。
  - `buildQueue` 调度（复刻 `trainingQueue`）+ `upgradeBuilding`/`speedupBuild` + `recomputeYield`/`trainTroops`/`settleResources` 注入。
  - `CityScene` UI（含练兵并入）+ 契约 + i18n。
  - 赛季清空接 `resetSeason`。
  - **验收**：graphite/sticker 有产有耗、troopCap 随 drillYard 成长、建造队列加速可跑；worldsvc e2e（建造扣资源/完工生效/门控拒绝/加速/赛季清空）+ client tsc + build。

> **P1 实现进度（2026-06-30，branch `slg-city-p1`，服务端先行刀）**
> 已落（纯服务端，未碰 client UI）：
> - **biomeAt 四分**（`shared/slg.ts`）：`ink<0.30<paper<0.55<graphite<0.78<metal`，graphite 获地图 faucet；`sticker` 永不进 biome（主城自产）。⚠ ADR-022 确定性注记：改的是程序地图，已占地块持久化 resType 不变；上线后再改须按赛季版本闸门，勿改活动赛季地图。
> - **建筑数据模型 + 纯函数**（`shared/slg.ts`）：`BuildingKey`/`BUILDING_KEYS(_P1)`/常量（DESK_MAX_LEVEL=20、BUILD_YIELD_STEP=0.05、STICKER_SELF_BASE=200、CABINET_CAP_STEP=0.1、DRILL_TROOPCAP_STEP=500、DRILL_TRAIN_SPEED_STEP=0.04、BUILD_QUEUE_SLOTS=1 等，全 DRAFT）+ `buildingYieldMult`/`buildingSelfYield`/`resourceCapFor`/`troopCapFor`/`drillTrainMult`/`trainQueueMaxFor`/`buildCost`/`buildTimeSec`/`buildGateReason`（单测 8 例全绿）。
> - **数据库**（`worldsvc/db.ts`）：`PlayerWorldDoc.buildings`/`buildQueue` + `BuildQueueEntry`。
> - **注入**（`worldsvc/service.ts`）：`recomputeYield`（末乘建筑乘数 + sticker 自产，支持 buildingsOverride 解决完工前算率的写读时序）/`settle`（cap 走 `resourceCapFor`）/`trainTroops`（队列上限 `trainQueueMaxFor` + 时长 ×`drillTrainMult`）/`joinWorld`（初始 `{desk:1}`、troopCap 走 `troopCapFor`）。
> - **服务方法 + 调度**：`upgradeBuilding`/`speedupBuild`/`processCompletedBuilds`/`applyDueBuilds`（复刻 trainingQueue 链式队列）+ scheduler 接入 + httpApi `POST /world/build/upgrade|speedup`。
> - **契约**：`openapi-world.yml` 加 `PlayerWorldView.buildings/buildQueue`、`BuildingKey` enum、两端点。
> - **赛季清空**：`resetSeason` 已整删 `playerWorld` 文档（含 buildings/buildQueue），跨季只留 family/材料，无需额外清理，符合 D-CITY-1。
> - 验证：`@nw/shared` + `@nw/worldsvc` `tsc -b` 全绿；shared 纯函数单测 8/8 绿；worldsvc e2e（`city-buildings.e2e.test.ts`）**✅ 8/8 全绿（2026-07-02，mongodb-memory-server rs0 实跑）**——覆盖 upgrade 扣资源入队+完工生效 / stickerShop sticker faucet 激活 / drillYard 提 troopCap / desk 门控拒绝越级 / 资源不足拒绝 / coin 加速即刻完工 / cabinet 提仓储上限。经济闭环（faucet+sink）已由 real Mongo e2e 证实，非纸面。
> **P1 全部完成（2026-06-30，branch `slg-city-ui`，client UI 刀）**：
> - **`CityScene`**（`client/src/scenes/CityScene.ts`）：手绘书桌俯视风格；顶部 5 资源条（当前值/产率/仓储上限）；建筑网格（8 个 P1 key + 2 个 P2 占位）；点选建筑 → 详情卡（当前等级/加成说明/下级消耗/升级按钮，资源不足置灰）；建造队列条（倒计时 + coin 加速按钮）；drillYard 详情卡展示兵力上限；`goCity` 导航函数（`createAppCore.ts`），从 `onOpenCity` 回调触发，`onBack` 返回大地图。
> - **WorldMapScene**：自己主城弹层新增「进入主城（Enter Desk）」按钮，走 `onOpenCity` 回调。
> - **WorldApiClient**：导出 `BuildingKey` 类型；新增 `upgradeBuilding()` / `speedupBuild()` 方法（`POST /world/build/upgrade|speedup`）。
> - **openapi-world.ts**：手工补丁（非全量重生，保留 family 历史类型）：`PlayerWorldView` 加 `buildings/buildQueue`；加 `BuildingKey` enum 及两端点 operation stub。
> - **i18n**：`city.*` 前缀三语（zh/en/de）——建筑名称、资源标签、加成说明、错误提示、队列显示；`world.actEnterCity` 三语。
> - **验证**：全量 `client tsc --noEmit` 零错误（main + node_modules 环境校验通过）。
> - **建筑数值已过 B 轨节奏核验**（2026-06-30，econ-sim `city.ts`，结论登记 [`ECONOMY_VERIFICATION_LOG §13-SLG-CITY`](ECONOMY_VERIFICATION_LOG.md)）：资源门控的数周肝、落 60 天赛季窗口、满级乘子合理 ✅；两条 informational 注记（drillYard 提速 L13 触底 / sticker 自我门控）。数值仍标 DRAFT（终态判据=上线后实测对账）。
> **P2 全部完成（2026-06-30，branch `slg-city-p2`）**：
> - **`wall`（城墙）**：`wallDefenseMult(buildings)` = 1 + lvl×WALL_DEFENSE_STEP(0.05)；worldsvc `applySiege` 在 `target.type==='base'` 时对 defenderConfig.garrison 调 `scaleArmyHp(garrison, wallMult)`，与国民加成叠乘。defender 提前 fetch（移到 runSiegeBattle 之前）。
> - **`cabinet`（文件柜护掠）**：`cabinetLootProtect(buildings)` = min(0.8, lvl×CABINET_PROTECT_STEP(0.02))；`transferLoot` 中 `effectiveLootRate = SIEGE_LOOT_RATE×(1−protection)` 替代原来的固定率。
> - **`academy`（书院蓝图 buff）**：engine `GameConfig` 加 `siegeAcademy?{hp,damage,siege}` 字段（siege 分量为 ADR-026 补接）；`buildSiegeBlueprints` 4th param 在 `clampEffectCaps` 后叠乘 hp/attack/**siegeValue**（独立注入口，守红线）；worldsvc 从 `pw.buildings` 算 buff 注入 `runSiegeBattle`。`academyBuff()` 返回 `{hp,damage,siege}`，siege 步长 `ACADEMY_SIEGE_STEP=0.015`。
> - **`buildGateReason`**：改用 `BUILDING_KEYS`（全 10 种），wall/academy 按正常 desk 等级门控，不再 'building not buildable yet'。
> - **`CityScene`**：建筑网格从 `BUILDING_KEYS_P1`→`BUILDING_KEYS`（wall/academy 真实可建）；详情卡显示实际数值（DRAFT）。
> - **i18n**：`city.bonusWallHp`/`city.bonusAcademyHp`/`city.bonusAcademyDmg`（zh/en/de）。
> - **单测**：city-buildings.test.ts P2 新增 3 例（wallDefenseMult/cabinetLootProtect/academyBuff），11 例全绿。
> - 验证：shared/engine `tsc -b` 全绿；worldsvc `tsc -b` 全绿；client `tsc --noEmit` 零错误。数值仍 DRAFT（终态判据=上线后实测）。
> - **补丁（2026-07-16）**：P2 收尾时漏改一处 —— `worldsvc httpApi.ts` 的 `POST /world/build/upgrade` 路由校验仍写着 `BUILDING_KEYS_P1`（`buildGateReason` 内部早已用 `BUILDING_KEYS`），导致 wall/academy 在 `CityScene` 网格里可点、一提交就 400。改用 `BUILDING_KEYS`；新增 `httpApi.e2e.test.ts` 覆盖两键的真实升级请求，防止再次静默漏改。

- **P2 ✅ CLOSED（2026-06-30）** — `wall` 注入主城围攻 + `cabinet` 护掠夺 + `academy` 赛季蓝图 buff（独立注入口，守红线）。
- ~~**P3（原案）— 委任内政官**：角色卡派进建筑加成（角色养成接入 SLG 内政），数值按角色属性。~~ **DROPPED**：卡池仅 8 张，无"多余英雄"消耗问题；最优解唯一，决策退化为一次性设置；建筑乘数链在 P2 已自洽，无需此层。
- **P3（2026-07-15 讨论 → 分批实现，详见 §8.2）— 军事屏 + 耐久系统**：
  - `desk` 等级上限 20→10（重算全部曲线，econ-sim 核对）— **已实现**（D-CITY-7）
  - 耐久系统：`wall` 决定上限，攻城值扣减 + 自愈（惰性结算）+ 归零摧毁强制迁城 + 系统邮件，新增持久化字段 + 服务端自动迁城流程 — **已实现（服务端）**（D-CITY-8，2026-07-16）
  - `satchel`（书包）建筑：单队出征携带兵力上限 — **已实现**（D-CITY-9）
  - `CityScene` 双屏拆分（内政/军事可切换 tab，军事页为占位容器）— **已实现**（D-CITY-11，2026-07-16，`client/src/scenes/CityScene.ts`）
  - 队伍面板（5 队 t1-t5，兵力/状态展示，纯 UI 露出既有数据模型）— **已实现**（D-CITY-10，2026-07-16，落进 D-CITY-11 军事页容器，只读展示，编辑仍走 `TeamsScene`）
  - 科技树（`academy`）独立面板 — **已实现**（D-CITY-12，2026-07-16，`client/src/scenes/CityScene.ts`）：`academy` 从内政页建筑网格移出（`DOMESTIC_BUILDING_KEYS` 排除 academy），军事页新增独立可点面板（`renderTechTreePanel`，图标+等级+HP/伤害加成行），点击复用既有 `renderDetailModal` 打开升级弹窗（升级注入逻辑 `buildSiegeBlueprints` 不变，纯 UI 呈现独立）。团队面板占位 `city.military.comingSoon` 文案同步收窄为仅剩耐久展示。
  - 世界地图基地血条 + 全屏泛红特效 — **已实现**（D-CITY-8 表现层，2026-07-16）：契约无需改动——`siegeHpView`（`worldsvc/src/coreHelpers.ts`）已把主城 anchor 的 `durability`/`durabilityMax` 映射进既有 `WorldTileView.hp`/`maxHp` 字段（对 `mine` 无特殊处理），世界地图既有的通用 `drawHpBar`（`client/src/scenes/worldmap/tileGraphics.ts`）因此对受损的自家主城原样生效，无需改客户端。全屏泛红特效为新增：`WorldMapRenderer/vignette.ts`（移植自战斗场景 `GameRenderer/events.ts` 的 base-damage vignette，同一套分层描边算法）+ `WorldMapNet.applyTileUpdate` 对比推送前后自家主城 tileCache 的 `hp` 判断是否被扣耐久（`TileUpdate` 本身不带 hp 字段，见 `transport.proto`），命中即调用 `flashDamageVignette()`。军事页耐久状态展示（D-CITY-12 旁支）仍待做。
  - **验收标准待定**：军事页耐久状态展示尚未进入实现/契约设计（D-CITY-10/12 均已收口）。

---

## 11. 与现有系统咬合 / 红线复核

- **不碰天梯**（SLG7 / D-CITY-6）：建筑注入只走 `recomputeYield`/`trainTroops`/主城 `buildSiegeBattle`/`buildSiegeBlueprints`（SLG 口）。`buildPvpBlueprints` 硬墙单测不受影响，新增「满级建筑喂天梯引擎 → 蓝图逐字等于常量」断言加固。
- **统一养成树不变**：跨季养成仍只有装备/科技/材料（PvE+SLG 共用）。建筑是 SLG 赛季内政叠加层，季末清，不进养成树（避免与 SLG8「材料统一」混淆）。
- **惰性结算不变**：建筑只改 `recomputeYield` 的乘数/自产项 + `settleResources` 的 cap，不引入每格 tick。
- **变现合规**：coin 买速度不买上限（D-CITY-5/§6），对齐 ECONOMY_BALANCE 反 P2W 政策。

---

*本文档为 SLG 主城建筑系统设计基准，状态：设计中。D-CITY-1（赛季清空）待用户拍板后落 ADR；DRAFT 数值随经济模拟细化。*
