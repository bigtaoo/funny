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
  2. **`troopCap`（兵力上限）曾是死值**——原本恒为 `TROOP_CAP_BASE`，没有成长曲线；练兵（`trainTroops`）已落地但训练速度/队列/上限都没有可升级的来源。**（此为待解问题的原始陈述；P1 后 `troopCapFor(buildings)=TROOP_CAP_BASE+drillYard·step` 已给出成长曲线，见 §5/§6。）**
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
| 官职委任（派武将当木材官/练兵使，按政治属性加成） | △ Phase 3 **委任内政官** | 把已养成的**角色卡**（涛3/Anna3/6 单位）派进建筑加成——给角色一条 SLG 内政出路，不碰天梯 |
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
| **D-CITY-8** | 城池耐久（durability）机制 | **新增持久化状态（2026-07-16 服务端已实现）**。上限由 `wall`（城墙）等级决定（`baseDurabilityMax(wallLevel) = BASE_DURABILITY_BASE + wallLevel×BASE_DURABILITY_WALL_STEP`；不采用三战「君王殿本身给耐久」的路数，我们刻意偏离参考，城墙专职耐久；wall 原先「围攻时临时给守军加HP」的 `wallDefenseMult` 机制已移除，全部改走耐久）。攻城结算：**先打赢驻军战斗 → 胜利后 5 分钟宽限期 → 按攻方攻城值（与地图上攻占城池同一套规则）扣减耐久**（`settleSiegeDamage`，`durability`/`durabilityMax` 落在主城 anchor `TileDoc` 上，替代原先复用的 `hp`/`buildingMaxHp(level)`）。耐久随时间**缓慢自愈**（`regenDurability`，`BASE_DURABILITY_REGEN_PER_HOUR` 每小时定量恢复，具体速率待数值模拟；读路径惰性计算展示值、不落库，只有真实结算/城墙升级完成才落库，同 `yieldRate` 的惰性结算风格）。**耐久归零 → 城池被摧毁 → 玩家丢失全部领地 → 服务端强制迁城**（复用既有 `passiveRelocate`，新增系统邮件 `slg.city.durabilityBreached.{subject,body}`，此前玩家对该结果**没有任何通知**；⚠️ 2026-08-16 发现该邮件的**客户端三语文案从未加过**，玩家收到的标题一直是生 key `slg.city.durabilityBreached.subject`——即这封"补通知"的信自己没送到，已补齐并加 `client/test/i18n-server-mail-keys.test.ts` 防再犯，见 `UI_DESIGN.md` §33.1）。城墙升级完成时按差值调整 `durabilityMax`（保留已损伤的绝对值，不重置满血）；玩家主动 `relocate` 同样保留已损伤耐久（不是免费回血）。**世界地图 HP 血条 + 被围攻全屏泛红特效仍是 DRAFT，客户端未实现**（服务端 view 字段沿用既有 `hp`/`maxHp` 命名，契约不变，客户端可直接接线）。 | **已实现（服务端）**，`server/shared/src/slg/siege.ts` + `worldsvc/src/combatSiege/{damage,helpers,arrival}.ts` + `city.ts`/`core/spawn.ts`/`core/helpers.ts`；客户端血条/泛红特效待后续 |
| **D-CITY-9** | 队伍出征携带兵力上限 | 新建筑（`satchel`，书包，隐喻文具书包能装多少东西，**已实现**）：**只管单支队伍出征时最多携带多少兵**，与 `drillYard`（总兵力上限 + 训练速度 + 训练队列上限）是两个独立维度，不合并。同样受 `desk` 门控。 | **已实现**（`server/shared/src/slg/city.ts` + `combatMarch.ts` 出征校验） |
| **D-CITY-10** | 队伍面板（5 队 t1-t5） | `CityScene` 新增队伍信息栏：5 支队伍（复用现有 `SIEGE_TEAM_CAP=5` / `t1..t5` 数据模型），每队显示当前兵力（`cardState.currentTroops`）/ 状态（驻军在家 / 出征中 / 受伤冷却 `teamState.injuredUntil`）。未指派 march 的队伍 = 驻军，血量与兵力信息同样在这里查看。**委任（角色派进建筑）维持 P1 已拍板的 DROPPED，不恢复**。**已实现（2026-07-16）**：军事页 2 列卡片网格，只读展示（编辑仍走地图入口的 `TeamsScene`），复用其 `teamOrder`/`committedTroops` 判定逻辑；状态优先级 受伤>行军/占领>驻军在家>空。**2026-07-23 单页合并（见 §8.5）**：从军事页 2 列滚动网格改为**贴底固定一行 5 张紧凑卡**，判定逻辑不变。**2026-08-25**：状态优先级补上野外驻扎/停留一档（受伤>行军/占领>野外驻扎·停留>驻军在家>空，见 §8.9）。 | **已实现**，`client/src/scenes/CityScene.ts`（`renderTeamsRow`/`renderTeamCard`） |
| **D-CITY-11** | ~~双屏拆分~~ **已撤销** | 曾拆内政/军事双页（左侧竖排 tab）；**2026-07-23 撤销**——军事页信息量不足以独占一屏，全部并回单页（耐久进标题栏、科技树回建筑网格、五队贴底一行）。详见 §8.5。 | **已撤销**（2026-07-23），`client/src/scenes/CityScene.ts` |
| **D-CITY-12** | ~~科技树独立面板~~ **已撤销** | 曾把 `academy` 从建筑网格挪出成军事屏独立面板；**2026-07-23 随 D-CITY-11 单页合并一并撤销**——`academy` 回到建筑网格当普通卡，点开走通用详情弹窗（加成行本就含其 buff），注入逻辑（`buildSiegeBlueprints`）自始至终不变。详见 §8.5。 | **已撤销**（2026-07-23），`client/src/scenes/CityScene.ts` |
| **D-CITY-13** | 建筑升级成本不得自引用产出物 | **拍板（2026-07-23，用户从 `inkPot` 详情卡发现）**：4 个资源产出建筑原本升级都吃**自己产出的那种资源**（`inkPot`↔ink / `paperTray`↔paper / `graphiteMill`↔graphite / `metalForge`↔metal）——产量最低（最需要该建筑加成）的玩家恰恰付不起，自相矛盾。**新规则**：资源产率建筑**绝不吃自己的产出物**；一切建筑只由两种**建材**建成——`paper`（基础建材）+ `graphite`（高阶建材），且 paper↔graphite 在各自 faucet 上**互为建材**（`paperTray` 用 graphite 建、`graphiteMill` 用 paper 建，均不自引用）；`ink` 净化为**纯练兵资源**（只被 `TROOP_TRAIN_INK_COST` 吃，建筑零消耗）。econ-sim 复核：paper 8.3×cap 仍是承重肝点、graphite 2.4×升为第 2 肝点、三档 days-to-max 全落在 60 天赛季窗内，faucet/sink 闭环与节奏结论不变。 | **已实现**，`server/shared/src/slg/city.ts` `BUILD_COST_BASE`；econ-sim 核对通过（详见 [`ECONOMY_VERIFICATION_LOG §13-SLG-CITY`](ECONOMY_VERIFICATION_LOG.md) 常量已改③） |

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
| `drillYard` | 练兵场 | 军事 | 提 `troopCap`（**总兵力上限**，`5000+1500×lvl`，ADR-075）+ 训练速度（`trainTroops` 时长，每级 -8%，地板 0.5）+ 训练队列槽位（`TROOP_TRAIN_QUEUE_MAX` + `DRILL_QUEUE_LEVEL_THRESHOLDS` → 1/2/3，**槽位并行**，ADR-079）+ 解锁更高兵种训练。**两个 PvE 门槛的实际钥匙**：L4 开关隘、L5 开险地（ADR-075 后移，守军常量不动，见 ECONOMY_VERIFICATION_LOG_CAPACITY §13-SLG-STRONGHOLD.7） | `trainTroops` / `troopCap` | P1 |
| `satchel` | 书包 | 军事 | 提**单支队伍出征携带兵力上限**（与 `drillYard` 的总兵力上限是两个独立维度，D-CITY-9）：`satchelCarryCapFor`=`SATCHEL_CARRY_BASE`(=`TROOP_CAP_BASE`=**5000**，ADR-075；零级即可单队带满初始兵力池) + `satchel` 每级 `SATCHEL_CARRY_STEP`(=`DRILL_TROOPCAP_STEP`=**1500**，ADR-075 改为直接引用而非字面量)，满级(L10)=**20,000**，与 `drillYard` 满级总 `troopCap` 相等（满配才能单队打满仓）——同基数、同步长、同 10 级，该相等现在按构造成立，shared 单测有断言。 | `server/worldsvc/src/combatMarch.ts` `startMarch`：team 出征时校验实际携带兵力（flat army 用 `troops`；card army 用 `cardState.currentTroops` 求和）不超过该 cap，超限 `SATCHEL_CAP_EXCEEDED` | **已实现** |
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
| **`trainTroops` / `troopCap`** | `troopCap` 恒 `TROOP_CAP_BASE`；训练时长 `TROOP_TRAIN_TIME_SEC × battlePass` | `troopCap = troopCapFor(buildings)` = `TROOP_CAP_BASE + drillYard·step`；训练时长再乘 `drillTrainMult(drillYard)`；队列上限 `TROOP_TRAIN_QUEUE_MAX + drillYard 档`，**且槽位并行**（ADR-079：`n` 个占用槽同时训 `n` 批，满级填满兵力池 13.9 h → 6.9 h 墙上时间）。 |
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
| `DESK_MAX_LEVEL` | 10 | 书桌（总门控）上限，对齐三战君王殿 10 级（2026-07-15 由 20 改 10，见 D-CITY-7；STEP 常量翻倍保满级加成一致） |
| `BUILDING_MAX_LEVEL` | 10（= `DESK_MAX_LEVEL`） | **每座建筑的硬上限**（2026-09-02 起是真常量，见 §8.12）。软门控另有一层：目标等级还须 ≤ 书桌**当前**等级（`buildGateReason`）——两层叠起来，书桌满级时所有建筑才能到 10 |
| `biomeGraphiteMax` 等四分阈值 | DRAFT | `biomeAt` 三分→四分（加 graphite 地块）的分区阈值（★P1 前置） |
| `BUILD_YIELD_STEP` | 0.05（+5%/级） | inkPot/paperTray/graphiteMill/metalForge 每级产率乘数（4 地块） |
| `STICKER_SELF_BASE` | DRAFT | stickerShop（民居模型）自产 sticker 基底/h（× lvl）；graphite 走地块产，无自产基底 |
| `CABINET_CAP_STEP` | 0.1（+10%/级） | 文件柜每级仓储上限；满级保护掠夺 X% |
| `TROOP_CAP_BASE` | **5,000**（ADR-075，2026-08-25；原 10,000） | 零级兵力池上限 = 新号开局兵力 |
| `DRILL_TROOPCAP_STEP` | **1,500**（ADR-075；原 1,000） | 练兵场每级 troopCap 增量。满级仍 20,000（`5000+10×1500`），但整条曲线由 **2× 变 4×**、首级由 +10% 变 +30%——练兵场是兵力池成长的唯一来源，旧曲线感知不到等于可跳过 |
| `DRILL_TRAIN_SPEED_STEP` | 0.08（-8%/级，地板 0.5） | 练兵场每级训练提速。**后期收益走这里，不走更大的单批**（见 `TROOP_TRAIN_BATCH_MAX`） |
| `TROOP_TRAIN_BATCH_MAX` | 5,000（2026-07-22 由 500 提升；**刻意不随 troopCap 成长**） | 单批训练人数上限。跟着 troopCap 涨会立刻把死槽变回来（满级 10,000/批 → 只需 2 槽），正是 ADR-075 要消灭的东西 |
| `TROOP_TRAIN_QUEUE_MAX` | **1**（ADR-075；原 2） | 零级训练队列槽位（**并行**，ADR-079）。必须 ≥1——练兵场建成前 troopCap 已非零，0 槽会让新号无法练兵 |
| `DRILL_QUEUE_LEVEL_THRESHOLDS` | **[4, 10]**（ADR-075；原 `DRILL_QUEUE_PER_LEVELS=2`） | 练兵场加槽等级 → 槽位 **1 / 2 / 3**（L0–3 / L4–9 / L10）。有用槽位的天花板是 `ceil(troopCap / TROOP_TRAIN_BATCH_MAX)`（超出的批次会先被 troopCap 校验拒掉，永远占不到槽），旧的 `2+floor(L/2)` 在 batchMax 提到 5000 后满级有 **3 个死槽**。阈值刻意不超过天花板（仅 L0 持平）：每槽都有用，且「空仓填满」在任何等级**不超过 2 次上线**（L0=1 次，L1 起=2 次；测试钉住）。**ADR-079 起槽位并行**：这条「上线次数」的论证依旧成立，但不再是槽位买到的全部——`n` 个槽 = `n` 倍训练吞吐 |
| `SATCHEL_CARRY_STEP` | **= `DRILL_TROOPCAP_STEP`**（ADR-075；原字面量 1,000） | 书包每级单队携带上限。改成直接引用而非恰好相等的字面量，D-CITY-9 的「满级书包 == 满级 troopCap」不变式从此按构造成立 |
| `WALL_DEFENSE_STEP` | DRAFT | 城墙每级主城基地/守军加成（P2） |
| `BUILD_COST_{key}(level)` | DRAFT | 升级消耗 5 资源曲线；高级吃 graphite+sticker（sink） |
| `BUILD_TIME_{key}(level)` | DRAFT | 建造时长曲线（= coin 加速变现点） |
| `BUILD_QUEUE_SLOTS` | 1（付费 2） | 默认建造并发 |

---

## 8. 客户端 UI（用户要的「点进主城界面」）

- **入口**：`WorldMapScene` 点**自己主城**（`type:'base'` 且 `mine`）→ **不再弹菜单**，直接进入 **`CityScene`**（ADR-041，2026-07-18；此前的「进入主城/Train/Defense/Manage team」五按钮弹窗已移除，主城也没有「手动防守配置」这一概念，防守由留守队伍自动构成，见 ADR-026）。
  > ⚠️ **2026-07-18 移除时的误判 + 2026-07-20 补回**：当时的 commit 假设「Train/队伍管理本就在 CityScene 内有完整入口」，但 `drillYard` 详情弹窗实际只渲染了一行「兵力 {cur}/{cap}」静态文本——`trainTroops`/`speedupTraining` 在移除旧练兵面板后**变得完全不可达**（服务端 API、`@nw/shared` 常量、i18n key `city.trainPanel` 均仍在，唯独没有任何 UI 能调用）。真实账号「3 支队伍全部无兵」就是这个空窗期的直接后果。2026-07-20 在 `drillYard` 弹窗里补回 `+10`/`+50`/`Max` 三档训练按钮 + 训练队列倒计时 + 加速按钮（详见 §8.3），`onTrainTroops`/`onSpeedupTraining` 这两个从未被赋值/调用的 `CitySceneCallbacks` 字段一并删除。
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

### 8.3 补回练兵入口（2026-07-20，修复 2026-07-18 移除时的误判）

`drillYard` 详情弹窗在「升级」区块之下新增：

- **训练队列**：逐条列出 `trainingQueue`（数量 + `formatDuration` 倒计时）。
- **训练三档按钮**：`+100` / `+500` / `Max`（`Max` = `min(TROOP_TRAIN_BATCH_MAX, troopCap-troops-已排队, ink/TROOP_TRAIN_INK_COST)`）——用固定档位代替 §8 原设想的「数量滑杆」，与 2026-07-18 之前删除的旧 world-map 练兵面板手感一致，实现更省（复用同一套 `sketchPanel` 按钮 + `this.hits` 命中模式，不需要额外的拖动手势组件）。按钮在训练队列已满 / 兵力已达上限 / 墨水不足时置灰，点击给出对应 toast（`city.err.trainQueueFull`/`city.err.troopCap`/`city.err.noInk`）。**2026-07-22**：档位从 `+10`/`+50` 上调一个数量级，`TROOP_TRAIN_BATCH_MAX` 同步从 500 提到 5000（`server/shared/src/slg/core.ts`）——兵力上限普遍在万级，旧档位点满一次训练队列要点几十次。
- **加速按钮**：队列非空时显示，复用 `city.speedup`/`speedupTraining`（与建造队列加速同一套系数 `TROOP_SPEEDUP_SECS_PER_COIN`）。**2026-09-02（ADR-079）**：报价从「最后一条批次的剩余」改成 **`Σ` 每个槽的剩余**——槽位并行后前者既少收钱又加速不完；批次行同时改为按 `completeAt` 升序显示（数组是入队序，不再等于完成序）。
- 新增 i18n：`city.trainEntry`/`city.trainMax`/`city.err.trainQueueFull`（zh/en/de 三语）；另有历史遗留 key `city.trainPanel`（定义了但从未被任何代码引用），当时留作弹窗标题的候选、未强行塞入布局——**2026-08-16 的 i18n 死 key 审计已删**（见 `UI_DESIGN.md` §33；真要加弹窗标题时重新加一个 key 比养着一个没人用的便宜）。
- 覆盖测试：`client/test/ui/cityTrainTroops.ui.ts`（headless PIXI，驱动真实 `handleDown`/`handleUp` 命中测试，覆盖 +10 训练成功 / 队列已满不下单 / 加速按钮调用）。
- **2026-08-25（ADR-075）补上状态行**：面板此前只有「兵力 {cur}/{cap}」+ 批次行，玩家看到置灰的「最大 +0」时既看不出槽位占用、也看不出兵力上限的余量早已被在训批次预定（`capLeft = cap - troops - 已排队`），更分不清是「槽位满」还是「兵力满」——两者 toast 不同、解法也不同（等 vs 升练兵场）。新增一行 `city.trainQueueStatus`（三语）：`队列 {n}/{max} · 在训 {training} · 可训 {left}`，槽位满或可训为 0 时整行转红。`可训` 直接对上「最大 +N」的数字，置灰原因自解释。UI 测试新增该行的断言（含「可训 = cap - troops - 已排队，不是 cap - troops」）。
- **已知限制**：`CitySceneCallbacks.onTrainTroops`/`onSpeedupTraining` 两个从未被赋值的可选回调字段已删除——`CityScene` 现在直接调 `this.cb.worldApi.trainTroops/speedupTraining`，与 `doUpgrade`/`doSpeedup` 走同一模式，不再经过父级回调层。
- **练兵消耗扩展为五资源（2026-08-01）**：练兵不再只吃 `ink`——每兵额外消耗 `paper`/`graphite`/`metal` 各 5、`sticker` 1（`ink` 每兵 10 不变），新增常量 `TROOP_TRAIN_PAPER_COST`/`TROOP_TRAIN_GRAPHITE_COST`/`TROOP_TRAIN_METAL_COST`/`TROOP_TRAIN_STICKER_COST`（`server/shared/src/slg/core.ts`）+ 汇总函数 `troopTrainCost(qty)`（`server/shared/src/slg/city.ts`）。服务端 `trainTroops`（`server/worldsvc/src/city.ts`）与建筑升级同款「按 `RESOURCE_TYPES` 逐项校验再扣减」写法，任一资源不足即整单拒绝（`INSUFFICIENT_RESOURCES`）。客户端 `Max` 档位与三个预设按钮的可点亮判定同步改为五资源联合校验（不再只看 `ink`），点击禁用态按钮时的 toast 也从「墨水不足」专属文案改回通用 `city.err.noResources`（此前 `capLeft<=0` 判定错位导致误报「兵力已达上限」的 bug 顺带修复，见 2026-08-01 会话）。旧 i18n key `city.err.noInk` 已删除（zh/en/de）。`server/tools/econ-sim` 的 `armyPacing()`/`cityRun.ts` 同步把 `inkToFill` 换成完整五资源 `cost` 打印，避免数值验证工具静默漏算新增的四项 sink。

### 8.4 资源条：真产量 + 客户端实时结算（2026-07-23）

§8 line 171 早就写明资源条应显示「当前量/**产率**/仓储上限」，但实现里第三行一直画的是**建筑乘数** `×110%`（`buildingYieldMult`），既不是真产量，也和 sticker 那格的 `+N/h` 自产文案不统一。且顶部「当前量」是**读取时的服务端快照**，只有升级/加速/练兵这类动作 round-trip 后才刷新——玩家盯着看总量**纹丝不动**（服务端其实在惰性累积，见 §5 `settle`）。本次两处修：

- **真产量**：第三行改画 `me.yieldRate[rt]`（服务端单出口算好的：地块产出 × 建筑乘数 + 自产 + BP），格式统一为 `+{rate}/h`，产率 >0 时染该资源主题色。这才是玩家关心的「产量」，且已含建筑乘数效果，比原来的裸乘数信息量更大。建筑乘数 `×{pct}%` 仍保留在建筑详情弹窗的加成行（`city.bonusYield`），没丢。
- **客户端实时结算（镜像 `settle()`）**：`CityScene` 记录每次拉取 `me` 的 wall-clock（`meLoadedAt`，经统一 `setMe()` 落点），资源条总量按 `min(cap, base + yieldRate·经过小时数)` 客户端外推——与 worldsvc `settle()` 同式。`update(dt)` 累加到 1 秒就 `tickResourceTotals()` 只改总量标签文本（不整屏重渲，避开拖拽滚动/闪烁与 Text 纹理反复重建）。**只客户端模拟，不额外请求**；升级/加速/练兵每次都过 `setMe()`，用服务端消耗后的权威值重置基线——即「消耗时才同步」。达到仓储上限后停止增长（cap 由 `liveResource()` 夹取）。
- 验证：`tsc --noEmit` 全绿、`webpack` 构建成功；深层 SLG 场景需整套后端 + 入世流程，本环境未起后端，未做浏览器内视觉核对。

### 8.5 单页合并：军事屏并回内政（2026-07-23）

D-CITY-11 的内政/军事双页拆分（左侧竖排 tab 切换）本次**撤销**——用户反馈军事页信息量不足以独占一屏，全部并回单页 `CityScene`：

- **无 tab / 无侧栏**：删除 `renderPageTabs`/`switchPage`/`page` 状态与 `sidebarNavW` 侧栏轨；红色装订线回到默认 9%（`marginLineX`），正文 `contentX = marginLineX(w)`，内容紧贴其右。
- **耐久进标题栏**（D-CITY-8）：原军事页的独立耐久面板（`renderDurabilityPanel`）删除，改为标题栏右侧一个紧凑读数 `renderHeaderDurability`——`wall` 图标 + HP 条 + `hp/maxHp`（沿用世界地图 tile 血条的绿/琥珀/红三段色），纯展示不吃命中。标题文案新增 `city.title`（主城 / Home City / Heimatstadt）取代原按页切换的 `city.page.{domestic,military}`。
- **科技树回建筑网格**（撤销 D-CITY-12）：`academy` 不再是独立面板，回到建筑网格里当普通一栋楼（`GRID_BUILDING_KEYS = BUILDING_KEYS`，不再 filter 掉 academy）；点开走的还是通用 `renderDetailModal`，其加成行本就含 academy 的 HP/伤害 buff，注入逻辑（`buildSiegeBlueprints`）不变。
- **五队并排贴底**（D-CITY-10）：原 2 列可滚动队伍面板（`renderTeamPanel`）换成**贴底固定一行 5 张紧凑卡**（`renderTeamsRow` + 重写的 `renderTeamCard`）——队名 + 状态标签（驻军/出征/受伤/空位）+ 已填队伍的驻军/携带兵力；卡片不滚动，只有上方建筑网格滚动（网格 viewport 底边被 `renderTeamsRow` 返回的 `bandTop` 限住，永不压到队伍行）。点卡仍走 `onEditTeam` → 队伍编队编辑器。
- 遗留死 key：`city.page.military`/`city.tab.*`/`city.military.techTree`/`city.military.durability` 已无引用，**2026-08-16 的 i18n 死 key 审计已从三语文件删除**（见 `UI_DESIGN.md` §33）；`city.military.teams`/`teamIdle` 仍在用。
- 覆盖测试：`client/test/ui/cityScene.ui.ts` 按单页布局重写（28 例）——网格 12 格全在屏内不重叠、`contentX = marginLineX`、弹窗命中门控、`academy` 现为网格卡、耐久读数在标题栏、五队贴底单行不重叠且不压网格、`onEditTeam` 命中数。
- 验证：`tsc --noEmit -p tsconfig.test.json` 全绿、`webpack build:web` 构建成功、`test:ui` 全绿（含 `scenes`/`scrollDragThrottle`/`sidebarRailOrientation`）；深层 SLG 场景需整套后端 + 入世流程，本环境浏览器面板未显示，未能截图视觉核对。

### 8.6 建筑网格布局 + 卡片视觉重做（2026-08-01）

背景：用户对着实机截图指出两个问题——超宽屏下 12 格（11 栋建筑 + 练兵合成格）按 `CARD_W_TARGET=222` 动态分列会分到 8 列，第二行只剩 4 格，右侧一大片空白靠背景涂鸦硬撑；以及所有卡片不分「建好没建、等级高低」长得完全一样，只有文字不同，扫一眼分不清主次。

- **列数封顶**：`CityScene/base.ts` 新增 `MAX_GRID_COLS = 6`，`renderBuildingGrid` 的动态列数 `Math.min(MAX_GRID_COLS, ...)` 封顶——12 格在 ≤6 列下总能排成整行（当前 6×2），超宽屏多出的宽度分给卡片本身（变宽），不再多开一列。列数上限与当前 12 格「巧合整除」，建筑数量以后变了需要重新核对是否还整除，不是写死的强保证。
- **未建成 vs 已建成的视觉区分**：`buildingLevel(bld,key)===0` 且非当前建造队列项时判定"未建成"（`unbuilt && !active`，`active` 优先——已入队的 0→1 建造不算"被忽视"）：图标/建筑名/等级文字统一降到半透明（`alpha 0.4/0.55`），右上角徽标从「已入队」的锤子换成一个空心「+」圆圈提示可建造；desk 因 `buildingLevel` 兜底恒 ≥1 天然不会进入这条分支。
- **等级进度条 + 分类强调色**：每张卡片顶部新增一条细进度条，取代"只有一行 Lv.N 文字"——填充比例 = 当前等级 / 当前可升到的上限（`desk` 用 `DESK_MAX_LEVEL`；其余建筑的实际上限是 desk 等级本身，`buildGateReason` 早已如此门控，进度条只是把这层关系可视化），练兵格用「已训兵力 / 兵力上限」代替。颜色按类别区分：五个资源产出建筑复用资源条已有的 `RES_COLORS`（呼应上方资源条同色语言）；`drillYard`/`wall`/练兵格用新增的军事色 `MILITARY_COLOR`（0xb85c38）；其余核心/仓储类建筑用既有 `C.accent`（`bldAccentColor()`，`base.ts`）。三处改动共同让网格从"一排复制粘贴的卡片"变成"能一眼扫出建好没建、投入程度、建筑分类"的信息面板，不新增任何命中区/交互，纯展示层。
- 验证：`tsc --noEmit` + `webpack build:web` 全绿；`npm test`（918 例）+ `test:ui` 全绿（既有 `cityScene.ui.ts` 的 12 格不重叠/命中数断言在本次 viewport 下列数未触发 6 列封顶，未受影响）。视觉核对：`entries/web.ts` 加了一段临时调试分支（`?debugCity`，直接 new 一个 `CityScene` 塞入最小 `PIXI.Application`，绕开登录/后端），配一份贴近截图数值的假 `WorldApiClient`，在 Browser 面板截图确认网格 6×2 整行、未建成卡片变暗+"+"角标、进度条按分类变色后，**该调试分支已完整回退**，不随本次改动合并。

### 8.7 队伍栏「填满所有队伍」批量分兵按钮（2026-08-02）

用户对着实机截图标出队伍栏右上角的空白位置，要求加一个「填满所有队伍」按钮：一键把基地兵力池按 `t1..t5` 槽位顺序分给各队，够填满的队就填满，池子不够时把剩余兵力全部塞给当前排到的这支队伍（不搞"按比例雨露均沾"）。

- **UI**：`renderTeamsRow`（`CityScene/render.ts`）在队名标签行右端新增一个按钮（`fillBtnW=200`，高度精确等于 `TEAM_ROW_LABEL_H`，与其下方紧贴的队伍卡片行齐平不重叠），文案 `city.military.fillAllTeams`。按钮**始终注册命中区**（不像 build-queue 的 Speed Up 按钮那样按条件渲染），点击调用新增的 `doFillAllTeams()`。
- **分配规则**：与 `DefenseEditorScene` 的单队「补满兵力」（§6.5，`CHARACTER_CARDS_DESIGN.md`）同一条底层规则——队伍内按 `cardPower` 降序补至 `troopCap`——只是外层多套了一层"按 `t1..t5` 顺序遍历所有队伍"。因为 `CityScene` 里的队伍都已经是服务端已保存的正式编队，不需要 `persistTeam()` 这一步，直接调 `distributeTroops(worldId, allocations)`（一次请求批量提交所有队伍的分配，不是每队各发一次）。
- **本地状态更新**：成功后不重新拉取 `me`，而是把 `allocations` 直接叠加进本地 `this.me.cardState`/`this.me.troops`（与 `DefenseEditorScene.doFillTroops` 的做法一致），失败则整体不改，可重试。
- 覆盖测试：`client/test/ui/cityFillAllTeams.ui.ts`（15 例）——按槽位顺序分配、单队内多卡按战力降序补满再溢出到下一队、池耗尽后不动后续队伍、跳过已满员的队伍、空池/请求失败时的提示与状态回滚、卡引用缺失（`cardInv` 无此 id）/ 旧版无卡军队条目安全跳过不崩溃、行军中或受伤锁定的队伍照样能补兵（补兵不受队伍状态门控）、`bt.busy` 期间二次点击是 no-op、按钮命中矩形与 5 张队伍卡的命中矩形几何回归（底边贴合队伍行顶边、绝不重叠）。`cityScene.ui.ts`/`cityTrainTroops.ui.ts` 里所有依赖命中区下标/数量的既有断言相应加 1（新按钮始终占一个命中位）。
- 验证：`tsc --noEmit -p tsconfig.test.json` 全绿、`webpack build:web` 构建成功、`test:ui` 全绿（112 文件 / 942 例）。按钮几何位置靠手算 + 命中矩形回归验证（`fillBtnH` 精确等于 `TEAM_ROW_LABEL_H`，底边与队伍卡片行顶边重合但不重叠，见 `cityFillAllTeams.ui.ts`）；本次也临时起了一版 §8.6 同款 `?debugCity` 调试分支想在 Browser 面板截图复核，但受限于本环境截图链路一直取不到画面（canvas 已渲染、`toDataURL` 可导出但 Browser 面板截图工具报"未显示无法合成帧"），**未完成真正的像素级视觉核对**就已按指示叫停——调试分支已完整回退，不随本次改动合并。

### 8.8 队伍栏加载：拆掉 `Promise.all` 栅栏 + 加载占位（2026-08-02）

用户反馈进主城后「队伍信息加载非常慢」，且加载期间五个槽位直接写着「（空）」——那是"你没有队伍"的意思，不是"还没拉到"，读起来像 bug。两处都改：

- **拆栅栏（客户端）**：`CitySceneBase.load()` 原本 `await Promise.all([getMe, getTeams, getMarches, getOccupations])` 后只 render 一次，等于**每一块数据都慢成四者中最慢的那一块**——`/world/teams` 早就回来了，队伍栏还得等 `getMe`/`getMarches`/`getOccupations`。改成四个请求各自 `.then` 各自 `render()`，谁先到谁先画。发起顺序也调了：`getTeams` 排第一，因为 `net/rateGate.ts` 的 5 令牌桶是严格 FIFO，桶被抽干时（刚入世、连点）按发起顺序放行，队伍栏是玩家在这个界面等的东西。
- **加载占位（客户端）**：新增 `teamsLoaded` / `ordersLoaded` 两个标志位 + `tickLoadDots()`（0.4s 一跳的三点动画，与 `BusyTracker.tick` 同契约，由 `update()` 驱动）。`teamsLoaded` 为假时队伍槽画 `renderTeamCardLoading()`——同尺寸同边框、半透明、槽位名 + `city.military.teamLoading` + 动画点，**不注册命中区**（队伍真名还不知道，没法交给编队编辑器）。`ordersLoaded` 单独存在是因为状态标签要同时依赖 `marches` + `occupations`：只有两者都回来才敢写「驻军在家」，否则一支正在行军的队伍会先闪一下「驻军在家」再自我纠正。
- **文案**：新增 `city.military.teamLoading`（加载中 / Loading / Lädt）。**不复用** `world.loading`——那句 zh 是「加载地图中…」（地图专用），且既有 loading 文案都自带省略号，与本处追加的 1–3 个动画点叠在一起会变成「加载中…..」。新 key 刻意不带省略号。
- **服务端摘掉读路径上的整册卡牌重组**：`worldsvc` `getTeams` 的 self-heal 每次都向 metaserver 要**整个 cardInv**（`assembleCardInv` 从 `cardInstances` 拉该账号全部实例，最多 500 张，还顺带自愈 `cardInvCount`），只为验证 ≤5×12 个已被编队引用的 id 还在不在。现在：`/internal/save-fields` 新增可选 `cardIds=a,b,c`（`assembleCardInvSubset`，`_id:{$in}` + 仍按 `accountId` 作用域，故意不做 `cardInvCount` 自愈——过滤过的 `find` 看不到真实册数，写进去反而污染镜像），`getTeams` 只报自己引用的 id；一张卡都没引用时**整个跨服务跳转都跳过**。不传 `cardIds` 时行为与从前完全一致，攻城引擎等既有调用方不受影响。
- 覆盖测试（共 26 例）：
  - `client/test/ui/cityScene.ui.ts` **+14 例**（新 describe「team-row loading state」）。分片独立性：`getTeams` 落地即出队伍不等 `getMe`、反过来 `getMe` 落地即刷建筑等级而队伍栏仍在加载（栅栏是双向的）。状态优先级：`marches`/`occupations` 未双双落地前停在加载态不误报「驻军在家」、只落一个不算数、落地后行军中/受伤都压过加载态。失败路径（全都吊在 `.catch`/`.finally` 上，重构时最容易退化成只挂 `.then`）：`getTeams` 拒绝也要结束加载态回落到真「（空）」、任一 order 端点拒绝也要结算状态。生命周期：`destroy()` 后才 resolve 的请求不得再 render。动画本身：`update()` 推进尾点、三相循环、加载完就不再因它触发 render。结构：加载中五个槽位名都在、加载态与落地态的 `gridHits` 几何完全一致（证明占位卡不改 `bandTop`，上方网格不重排）。
  - `server/worldsvc/test/get-teams-card-lookup.test.ts` **新文件 9 例**（`getTeams` 只碰 `cols.playerWorld.findOne` + `core.meta`，手搓 `CityService` + 假 core 即可，**不需要 Mongo**）：只报被引用的 id 且跨队去重、无卡引用时整个跨服务跳转都跳过、无队伍时更早短路、`withValidLeader` 在跳过查询的路径上照样生效、meta 说没有的卡被剔除并落库、干净编队不写库、meta 不可达时原样返回且绝不写库、未入世抛 `TILE_NOT_OWNED`。self-heal 真正回写那半边仍留在有真库的 `teams.e2e.test.ts`。
  - `server/worldsvc/test/meta-client-save-fields.test.ts` **新文件 5 例**（起一个假 meta HTTP server 断言真实 query string）：`cardIds` 逗号列表、不传时不带该参数、**空数组也不能带**（meta 把缺失读作"整册"，会把查询悄悄放大回去）、每个 id 各自 encode 所以 id 里的 `,`/`&` 伪造不出额外条目、没配 baseUrl 直接返回 `null` 不发请求。
  - `server/metaserver/test/internal-economy.test.ts` **+3 例**：`cardIds` 收窄、仍按账号作用域不泄漏他人实例、不传 `cardIds` 仍返回整册。
  - 既有 stub 里凡是没挂 `getTeams`/`getMarches`/`getOccupations` 的都补齐了（4 个测试文件 5 处）——旧代码里这些缺失被 `Promise.all` 外面那圈 `try/catch` 吞掉，拆栅栏后会真的抛。其中 `scrollDragThrottle.ui.ts` 的 CityScene stub 必须**真 resolve**：留成永不 resolve 会让加载动画一直活着、额外触发 render，打乱它自己的 render 计数断言。
- 变异验证（确认新用例不是摆设）：逐个把源码改坏跑一遍——`getTeams` 去掉 `.catch` → 拒绝用例挂；`paint()` 去掉 `destroyed` 门 → 生命周期用例挂；`ordersLoaded` 改成第一个响应就置位 → 「只落一个不算数」挂；`getMe` 分支去掉 `paint()` → 双向栅栏用例挂；`getTeams` 不传 `referencedIds` → worldsvc 收窄用例挂；路由忽略 `cardIds` → metaserver 收窄用例挂。（另记一笔：把 `getTeams` 的 `.finally` 改成 `.then` **不会**挂——它前面就是 `.catch`，两者在此等价，真正吃重的是那个 `.catch`。）
- 验证：`tsc --noEmit -p tsconfig.test.json` + 三个服务 `tsc --noEmit` 全绿；`webpack --mode production --env TARGET=web` 构建成功；`test:ui` 113 文件 / 1000 例全绿、`npm test` 130 文件 / 949 例全绿、metaserver 477 例 + worldsvc 75 例（均为非 e2e，本机 Docker 未起，`*.e2e.test.ts` 未跑）。视觉核对：沿用 §8.6 的临时 `?cityloading` 调试分支（直接 new `CityScene` + 假 `WorldApiClient`，绕开登录/后端），这次改用 Playwright 直连 dev server 截图落盘绕开 Browser 面板"未显示无法合成帧"的老问题，确认了加载态（五张半透明卡「加载中..」）与落地态（Alpha/Bravo/Charlie 带头像 + 兵力，4/5 槽「（空）」）两张图——**调试分支已完整回退**，不随本次改动合并。

### 8.9 队伍栏漏掉「野外驻扎/停留」：所有外派队伍都被写成「驻军在家」（2026-08-25）

用户报（账号 tao）：主城队伍栏五张卡全写「驻军在家」，实际至少 4 队站在野外地块上。

- **根因**：队伍状态判定 `CityScene/helpers.ts` 的 `teamOrder()` 只看 `marches` + `occupations` 两个数据源，而 **2026-07-23 的野外驻扎（field-stationing）**给出了第三种「不在家」状态——队伍停在某个地块上，既没有 march 文档也没有 occupation 文档，只有 `stationed` 文档（`GET /world/stationed`）。服务端的 TEAM_BUSY 门（`worldsvc/src/combatMarch/command.ts`，报错文案就是 "already marching, occupying, or **stationed**"）早就是三元的，客户端这一处始终是二元的，于是所有 停留/驻扎 队伍都落到最后的 `filled` 分支 = 「驻军在家」。世界地图侧不受影响（`worldmap/net/march.ts` 一直读 `ctx.stationed`），只有主城这一行错。
- **改法**：
  - `CityScene/data.ts` 第五个数据分片：`getStationed()`，与 marches/occupations 同样独立 `.then()`+`paint()`，`ordersPending` 由 2 改 3（`ordersLoaded` 现在要三个端点都结算——少了这条，一支驻扎队伍会先闪一下「驻军在家」再自我纠正，正是 §8.8 立这个标志位要防的事）。
  - `helpers.teamOrder()` 返回类型加第三支 `{ station }`，优先级排在 march/occ 之后（撤军途中两份文档会短暂同时存在，此时应显示「行军中」）；按 `mine !== false` 过滤——ADR-051 P4 起 `/world/stationed` 也返回视野内的**敌方**驻军（`teamId` 被服务端抹掉，但字段形状相同），不过滤会让敌方驻军抢占我方槽位。
  - 文案新增 `world.team.stationedIdle`（野外停留 / In the field / Im Feld）与 `world.team.garrisoned`（野外驻扎 / Field garrison / Stationiert），对应 ADR-051 P3a 的 停留（自由，可原地再指挥）/ 驻扎（锁定，守 3×3）两态；状态色沿用 march/occ 的金色（= 不在家）。**故意不带坐标后缀**：竖屏下领队头像把状态文字列压到 `max(40, …)` 的 40px 下限，现有 4 字标签就已在换行，再挂个 `(x,y)` 会撞到下面的武将/兵力副标签；坐标去地图看。
  - 顺带修英文歧义：`city.military.teamIdle` 英文原文就叫 "Garrisoned"（本意是「在家驻军」），与新的野外驻扎撞车，改成 "At home"（德文 `Garnisoniert` → `Daheim`）。中文「驻军在家」不变。
- **补测 + 顺手修一处自造的闪烁（同日追加）**：审覆盖率时发现 station 分支写在加载态之上，于是「station 先落地、marches 还在飞」的瞬间会直接写「野外驻扎」——而 station 是三源里**最低**的一档（撤军途中 march 与 station 文档并存），下一帧就得自我纠正成「行军中」，正是 §8.8 立 `ordersLoaded` 要防的那种闪烁。改成 `station && core.ordersLoaded`（顺带把三元 union 在开头拆成 `station` / `activeOrder` 两个局部变量——不拆的话未落地的 station 会掉进 march/occ 分支读 `occ.dueAt` 得到 `NaN`）。新增测试：
  - `cityScene.ui.ts` **+4 例**：station 单独落地不算结算（不许提前写「野外停留」）、station 先落地→另两个端点带回撤军 march 时 march 赢且中途从未显示过驻扎、另两个端点空回时立刻显示、`getStationed` 拒绝也要结算状态（第三条失败路径，前两条 §8.8 已有）。
  - `client/test/ui/cityTeamOrder.ui.ts` **新文件 6 例**：直接断言 `helpers.teamOrder()` 这个纯函数（渲染文本只能看出哪个分支赢了，看不出全组合下的排序与归属过滤是否成立）——三源都指同一槽时 march>occ>station、只有别人的槽位有文档时返回 null、station 原样返回且 `mode` 不丢、敌方 march 与敌方 station（`mine:false`）都忽略而无 `mine` 字段的旧文档算自己、敌方 march 不遮住我方 station。同文件另 1 例钉住**取数扇出**：五个分片都发且 `getTeams` 排第一（`net/rateGate.ts` 的 5 令牌桶严格 FIFO，桶抽干时发起顺序就是服务顺序，此前没有任何测试钉这条，少发一个分片或调换顺序都是静默回归）。
  - 变异验证（逐个改坏源码确认用例会挂）：去掉 `ordersLoaded` 门 → 「单独落地不算结算」挂；去掉 `stationed` 的 `mine !== false` → 敌方驻军用例挂；把 station 排到 occ 之前 → 排序用例挂；删掉 `getStationed` 分片 / 把 `getMe` 挪到 `getTeams` 前面 → 扇出用例挂；删掉 stationed 分片的结算钩子 → 拒绝用例挂。（`.catch` 与 `.finally` 在此**互换不会挂**——`.catch` 就在它前面，两者等价，与 §8.8 记的那笔同理。）
- 覆盖测试：`client/test/ui/cityScene.ui.ts` **+5 例**——停留队伍显示「野外停留」且不再出现「驻军在家」、驻扎与停留两态文案可区分、混合场景下只有真在家的那一队保留「驻军在家」、视野内敌方驻军（`mine:false`）不抢我方槽位、撤军途中 march 压过 station。既有「只落一个 order 端点不算数」用例改成三端点口径。另有 9 个测试文件的 `WorldApiClient` stub 补 `getStationed`（拆栅栏后缺方法会真的抛，同 §8.8 那笔）。
- 验证：`tsc --noEmit` 全绿、`test:ui` 226 文件 / 2109 例全绿、`npm test` 190 文件 / 1950 例全绿、`build:web` 构建成功。**未做真机截图**：复现需要一个野外驻扎中的账号，本地 docker 栈里 `stationed` 集合为空、用户报的状态在部署后端上；Browser 面板本次仍取不到画面（同 §8.7 的老问题），按用户指示叫停，视觉侧以 headless UI 用例（真 `PIXI.Text` 节点文本）为准。

### 8.10 建筑详情弹窗内直接加速（2026-08-27）

用户报：打开在建建筑的详情弹窗只能看到一行「建造中」，要加速得先关掉弹窗、去建造队列条点「加速」、再重新打开弹窗看进度——为一个纯确认动作走了三步。

- **根因（不是漏做，是遮挡）**：加速按钮一直只有一个，画在建造队列条上（`CityScene/render.ts` 的 `renderBuildQueue`），而它位于详情弹窗的 dim 层**之下**；弹窗最后压了一条覆盖全屏的 tap-outside 命中（`modals.ts` 末尾）来吃掉一切面板外点击，队列条那颗按钮因此在弹窗打开期间完全不可点。
- **改法**：`renderDetailModal` 的 `inQueue` 分支（原先只有一行 `city.upgrading` 文本）在**同一行右侧**补一颗加速按钮，与「升级」按钮共用那一行本就预留的 36px（`contentH` 不用改）：
  - 复用 `city.speedup` 文案与 `core.doSpeedup(key)`，即与队列条按钮同一条链路、同一套 `BUILD_SPEEDUP_SECS_PER_COIN` 定价；`serverNow()` 而非 `Date.now()` 算剩余秒，与 `actions.ts` 的 `doSpeedup` 口径一致（客户端本地时钟偏了会让展示价与实收价打架，comm-audit-2026-07-27 那笔）。
  - 按钮宽度按 `lbl.width + 16` 量出来后右对齐（`scaledTxt()` 只提 raster 分辨率、不改 fontSize，所以 `lbl.width` 已是面板局部坐标），德文最长的「Beschleunigen (1440 Münzen)」与左侧「Im Bau…」之间仍有明显留白。
  - `secsLeft <= 0` 时不画（队列条同规则）——那一瞬间条目正要被服务端清掉，画一颗 1 金币的按钮只会白扣。
  - **只给队首（head）**：`POST /world/build/speedup` 的请求体只有 `{coins}`——服务端**完全忽略 `key`**，把 `coins × 60s` 从队列**最前面**开始烧，烧不完才溢出到后面的条目（`worldsvc/src/city/buildings.ts`）。所以按队尾条目自己的剩余时间报价 = 收了钱去缩短另一座建筑。`BUILD_QUEUE_SLOTS === 1` 的今天不可达（队列里最多一条），但加速按钮是第一个能让非队首条目被点到的地方，故显式限定 `queue[0]?.key === key`；付费第二格（§6）真上线时回到这里重新设计（大概是「加速整条队列」而非「加速这一座」）。
- 覆盖测试：`client/test/ui/cityModalSpeedup.ui.ts`（新文件 9 例）——同行出现按钮且点击带着「该建筑 key + 金币数」调 `speedupBuild`、**与建造队列条同价**（同一字符串在树里出现两次，两处报价不可能分叉）、**弹窗打开期间它是唯一可点的加速**（队列条那颗被 `hits = [backHit]` 丢掉，且新按钮不在队列条那一带）、**同行不重叠且命中矩形罩住自己的文字**、**连点两次只扣一次**（`bt.busy` 在途门；金币是真钱）、不足 1 分钟向上取整成 1 金币（不给白送）、剩余 0 秒不画、未排队建筑仍是普通「升级」按钮、队尾条目不给按钮（上一条）。
- **变异验证**（逐个改坏源码确认用例会挂）：队首限定改回 `find()` → 队尾用例挂；`secsLeft > 0` 放宽成 `>= 0` → 2 例挂；按钮改左对齐 / 宽度写死 40 → 几何用例挂；删掉 `doSpeedup` 的 `bt.busy` 门 → 连点用例挂；弹窗价改成 `÷120` → 同价用例挂；删掉 `CityScene.render()` 里 `core.hits = [backHit]`（旧的命中泄漏 bug）→ 5 例挂。
- **测试环境的量字限制**：headless `measureText` 是每字 7px 的平铺假值，所以几何断言钉的是**规则**（同行、不重叠、命中罩住文字），不是真实字宽；真实字宽靠中/德两语截图核对（德语 `Beschleunigen (1440 Münzen)` 是最长态）。
- 验证：`tsc --noEmit -p tsconfig.test.json` 全绿、`test:ui` 232 文件 / 2197 例全绿；视觉核对走 Playwright stub-mount 路径（`web-e2e` + `views.showCity()` 喂一个带 `buildQueue` 的假 `worldApi`，无需后端/登录），中德两语各截一张，并用真实鼠标点击（scene 坐标 → CSS px）确认命中矩形落在按钮上：`speedupBuild('graphiteMill', 1440)`。

### 8.11 主城图标太淡：母题墨量 + 产出卡色底 + Lv.0 压暗（2026-08-27）

用户报（带截图，圈了三处）：「主城里的图标，看起来非常淡」——资源条的**石墨**、建筑卡的**纸盘**（Lv.10 满级）和**石墨坊**（Lv.0）。

三个原因叠在一起，分别修：

1. **母题本身墨量不够**（主因）。五张产出建筑卡的图标不是自己的画，是 `BLD_RES` 把 `res_atlas` 的资源母题借过来用（资源↔建筑的视觉绑定，零新美术）。`res_paper` 的感知墨量只有墨水瓶的 1/8。根因与修法见 [`design/product/slg-resource-art.md`](../product/slg-resource-art.md) **§7**（打包期墨量地板，只作用于 5 张无分级母题帧）。**纸盘是 Lv.10 满级却依然淡，正是这条的证据**——与下面第 3 条的压暗无关。
2. **轮廓画在纸背景上没有剪影**（结构性，加多少墨都解决不了）。这些母题全是**中间透明的轮廓**，画在同样是纸的底上：没有色块可抓，眼睛必须先把线读出来才能分辨是哪张卡。加**色底 chip**（`CityScene/icons.ts` 的 `chipped()`）——卡片等级条与资源条早就在用的那个 accent 色，透明度 0.34、圆角 0.26、母题内缩到 0.86。透出来的正是轮廓画自己什么都没有的那块中间。
   - **只给资源母题上 chip**：资源条 + 五张产出卡。实机截图对比过两版：垫在手绘 `bld_*` 后面（desk / cabinet / drillYard / wall / satchel / academy，以及练兵格的 armor）**是负优化**——那些画本来就画满整个框、又密又黑，chip 没有空的中间可填，只会被自己的圆角切掉画的四角、又在细排线底下垫一层色。城墙糊成一块肉粉色方块，练兵场丢了排线。
   - 这个分界**不是妥协，它说了句真话**：有 chip = 这张卡产这种资源，颜色与上面资源条里那一格一致，正好就是 `BLD_RES` 已经划的那条线；没有 chip 的七张，就是不产东西的那七张。
   - **石墨的 chip 单独调暗**（`CHIP_TINT`，`0xb0b0a8` → `0x8f8f86`）：它的 accent 是接近中性的铅笔灰，在 chip 透明度下与纸底只差几个百分点，等于没有。只改 chip；等级条和资源条那两处是画成实心色带的，亮度在那里是够的，跟着改会把整列石墨重新调色。
3. **Lv.0 的额外压暗把前两条乘没了**。未建成的卡走 `icon.alpha = 0.4`（2026-08-01 卡片改版立的，当时每个图标都够黑）。乘在本就最淡的纸/石墨母题上，一张 Lv.0 石墨坊等于**空卡**。改 **0.65**：仍读得出「还没建」，何况右上角的「+」徽章和灰化的名字/等级本来就在说这件事。

验证：`tsc --noEmit` 全绿；`test:ui` 234 文件 / 2214 例全绿；`build:web` 构建通过；**真机截图核对**——用 `web-e2e` 靶子（`window.__nwE2E.views.showCity()` + 桩 `WorldApiClient`，无需后端栈）驱动真 PixiJS 渲染，按用户截图里的等级/资源复现同一座城，改前/改后逐格对比确认：纸盘与石墨坊从「几乎看不见」变成一眼可辨，第二排七张无 chip 的卡逐像素未变。

**覆盖测试**（`client/test/ui/cityIconChip.ui.ts` 新文件 6 例 + `worldMapResMotifLevelRead.ui.ts` 的「成品图集」块 +3 例）：

- **哪几张卡有 chip**（决策本身）：`producerResource()` 的五分/六分切法（连「剩下这六张是谁」也一并钉住，将来加产出建筑会在这里说话）；整页 chip 数恰好 10 = 资源条 5 + 产出卡 5，多一个少一个都挂；**打开升级弹窗后仍是 10**——`resIcon`/`bldIcon` 故意不自带 chip（弹窗里 15px 的消耗图标、顶栏的城墙图标都走它们），把 chip 折进这两个函数是「合并两处调用点」时最顺手的化简，折了之后没有任何东西会挂。
- **chip 不改布局**：容器占满调用方给的 60，母题内缩到 52 并居中——涨了框会把每张卡的图标顶偏，这种「说不上哪儿不对」的偏移最后总是算到美术头上。
- **石墨调暗只作用于 chip**，`RES_COLORS.graphite` 本身不许动。
- **Lv.0 压暗是 0.65**。
- **图集侧**：5 张母题帧全部过 `UI_INK_FLOOR`，且 `res_paper_l1` 必须**仍在地板之下**（防「顺手给所有帧都上地板」——那会抹平分级读数）；**map-editor 的那份 `res_atlas` 与 `art/` 的逐字节一致**（打包器写两份、文档要求字节一致，此前零覆盖，任一份被手改/被当成冗余删掉都是静默漂移）；以及下面这条最要紧的。
- **⚠️ 墨量地板那条断言单独站不住**：去掉 `liftAlpha` 的趾部（`UI_ALPHA_TOE`）后它**照样通过**——雾本身也算墨，求解器反而用更弱的 gamma、零次加粗就够到地板了，然后交出一张中间糊着灰盒子的图。所以另立一条：**被抬到地板上的帧，必须是靠加粗笔画到的，不是靠糊满中间**。用 1..40 alpha 占帧面积的比例判，实测把 `UI_ALPHA_TOE` 改成 0 重跑打包器：纸 1.3% → 87.1%、贴纸 6.3% → 75.4%、石墨 18.3% → 68.0%，阈值 40% 卡在两簇中间。**作用范围靠测量而非硬编码名单**（落在地板上的才算被抬过；墨水瓶 46%、金属 64% 是没被抬过、雾原样留着，硬写成豁免的话哪天纸重画得更满就静默错位了）。
- **变异验证**（逐个改坏源码确认会挂）：grid 里去掉 `producer ?` 判断改成全上 chip → 挂；`0.65` 改回 `0.4` → 挂；`CHIP_INSET` 改 0.8 → 挂；删掉 `CHIP_TINT` 的石墨条目 → 挂；给弹窗消耗图标包上 `chipped()` → 挂（10 → 11）；`UI_ALPHA_TOE` 改 0 重打包 → 只有新加的那条挂（旧的地板断言仍绿，正是它存在的理由）。
- **这层测不到的**：headless 适配器下 res_atlas 不解码，`resIcon`/`bldIcon` 走的是 emoji/线稿回退分支，所以断言看到的是 chip 的**结构**而不是最终画面——只落在 `if (tex)` 分支里的改动这一层看不见。这个切分是对的（决策归测试，观感归截图），但别把它当成「图标好不好看」有覆盖。

---

### 8.12 满级建筑仍在推销 Lv.11：`atMax` 只认书桌（2026-09-02）

用户报（带截图，圈了两处）：书桌最高 10 级，可石墨坊 Lv.10 的详情弹窗照旧写着「→ Lv.11 / 消耗 35k / 时长 1:28:00 / **需书桌 Lv.11**」——一个不可能存在的书桌等级。

- **根因**：`modals.ts` 的判据是 `lvl >= DESK_MAX_LEVEL && key === 'desk'`，**只有书桌**会走「已满级」分支。其余十座建筑到 10 级后落进升级分支，`buildGateReason` 对 `toLevel = 11` 返回 `'desk level too low'`，弹窗于是照着这条理由渲染出「需书桌 Lv.11」。等级上限这件事被写在了一个只描述书桌的条件里，而**每座建筑的实际天花板都是 10**：非书桌建筑的目标等级须 ≤ 书桌当前等级，书桌自己又停在 `DESK_MAX_LEVEL`。
- **改法**（两端各一处，共享层先说清）：
  - `slg/city.ts` 新增 `BUILDING_MAX_LEVEL`（= `DESK_MAX_LEVEL`，**不是冗余别名**：它是由门控*推导*出来的那个天花板，存在的理由就是「这座建筑满了没有」曾经没有名字可问）；`buildGateReason` 补一条 `toLevel > BUILDING_MAX_LEVEL → 'building at max level'`，**排在书桌等级检查之前**——过了天花板以后书桌门控永远满足不了，再说「书桌等级不足」等于叫玩家去升一座已经满级的书桌。
  - 客户端 `atMax` 改成 `lvl >= BUILDING_MAX_LEVEL`（去掉 `key === 'desk'`）。`actions.ts` 的报错映射把 `'max level'` 排到 `'desk'` 之前，理由同上（顺带修掉「书桌满级」原先也被映射成「书桌等级不足」）。
- **顺路扫同类问题**（用户要求）：弹窗里每一行加成都对着共享层的函数核了一遍，只有一处同类——**练兵场「训练提速」**。`drillTrainMult` 有 `DRILL_TRAIN_SPEED_FLOOR = 0.5` 地板，而卡片印的是裸乘积 `lvl × DRILL_TRAIN_SPEED_STEP`，于是从 **L7**（`ceil(0.5 / 0.08)`）起对外承诺一个训练队列根本不会给的提速：满级写「80%」，实际 50%。改成 `Math.round((1 - drillTrainMult(bld)) * 100)`，L1–L6 一字不变。其余各行（产率、仓储、兵力上限、队列槽、城墙耐久、书院加成、书包负重）都是无夹逼的线性式或直接调共享函数，**没有第三处**；装备 `+9`、卡牌满级、战令 30 级三处早就各自有满级分支，不属同类。
- **第三个问题是写测试时掉出来的**（补覆盖比补代码更值的一次）：`doUpgrade` 的报错阶梯共五条分支，此前**零覆盖**（`cityTrainTroops.ui.ts` 只覆盖了练兵那条链）。给它补测试的第一条断言就红了——「资源不足」那条判的是 `msg.includes('resources')`，而服务端抛的是 `Insufficient ${rt}`（"Insufficient paper"，**整句没有 resources 这个词**），于是真正的资源不足（客户端资源快照过期时才走到服务端）一律显示成「操作失败」。改成认**错误码** `INSUFFICIENT_RESOURCES`（码是契约，message 是散文），并保留 `includes('Insufficient')` 与 `doTrain` 同形作兜底。这条阶梯本身是**过期客户端**路径：`me.buildings` 是快照，另一个标签页/设备或刚完成的建造都能让服务端拒掉弹窗还在提供的升级。
- 覆盖测试：`client/test/ui/cityModalCappedNumbers.ui.ts`（新文件 7 例）——石墨坊满级读「已满级」且不出现 `→ Lv.11`/升级按钮/`doUpgrade` 命中；**十一个 key 逐个过**（不可达的「需书桌 Lv.11」、越顶目标、升级按钮、命中数全查）；**满级前一级仍给升级**（别把最后一级吃掉）；小书桌下真门控照旧（`需书桌 Lv.4`）；训练提速满级读 50%、地板前一级仍等于裸乘积、地板级与满级都钉 50%。`server/shared/test/city-buildings.test.ts` +1 例：`BUILDING_KEYS` 逐个在 `BUILDING_MAX_LEVEL` 处放行、`+1` 处以「at max level」拒绝（**不是**「desk level too low」）。

  三处扫的都是**整条曲线而不是采样点**：满级判定扫 L0–L10（任何等级都不许报出超顶目标，且「已满级」与「→ Lv.N」恰好二者之一）、训练提速扫 L0–L10（地板前等于裸乘积、地板起等于地板），将来改 step/floor 这两条仍成立。

  另加 `client/test/ui/cityUpgradeErrorToasts.ui.ts`（新文件 4 例）：五条报错分支各读各的句子、五种资源短缺都读「资源不足」、两条 max-level 理由都读「已满级」而非「书桌等级不足」，以及**断言那些理由字符串就是 `buildGateReason` 真正返回的那几个**（哪天改文案会在这里挂，而不是静默掉进 generic）。用的是真的 `WorldApiError(code, message)`，与 `WorldApiClient/core.ts` 从 `{ok:false,error:{code,message}}` 信封里造出来的那个同一个类。

  服务端 e2e `worldsvc/test/city-buildings.e2e.test.ts` +1 例（需 Mongo）：十一个 key 在满级城里逐个被拒且理由匹配 `/at max level/`、**不**匹配 `/desk level too low/`，并核对拒绝是干净的（资源一分没扣、队列没进条目）——改前那条路径是带着一份已算好的 11 级 cost 走到这里的。
- **变异验证**：`atMax` 改回带 `key === 'desk'` → 前两例挂；训练提速改回裸乘积 → 训练提速两例挂；删掉 `buildGateReason` 里那条 `BUILDING_MAX_LEVEL` 分支重跑 e2e → `inkPot` 起全挂在「got 'desk level too low'」（`desk` 仍走它自己那条，正是预期）。
- **踩到一次本地陷阱**：worldsvc 解析 `@nw/shared` 走 `dist`（`server/.gitignore` 忽略、不入库），所以新导出的 `BUILDING_MAX_LEVEL` 在 `cd server/shared && npm run build` 之前是 `undefined`——e2e 里 `$set` 出一堆 `null` 等级、测试以「升级居然成功了」的形状失败。**跑 worldsvc 测试前先 build shared**；共享层单测因为 import 的是 `../src` 所以看不见这个坑。
- 验证：`tsc --noEmit`（`tsconfig.test.json` + fulllink）全绿、`test:ui` **254 文件 / 2430 例**全绿、worldsvc e2e 19/19（真 Mongo）、`build:web` 构建通过；**真机截图核对**走 §8.10 的 `web-e2e` 桩挂载路径（`__nwE2E.views.showCity()` + 假 `worldApi`，无需后端栈），中文复现用户那座满级城：石墨坊/文件柜/练兵场 Lv.10 均读「已满级」、练兵场读「训练提速 50%」、石墨坊 Lv.9 仍给「→ Lv.10 / 升级」、书桌 Lv.3 时仍给「需书桌 Lv.4」。
- **顺手修掉一处已有的类型门禁失败**（不是本轮引入）：`client/test/wechatInputAdapter.test.ts`（commit `565cb17b8`）里 `globalThis as { wx?: FakeWx }` 是 TS2352 非重叠断言——`wx.d.ts` 声明了真的全局 `wx`。那个提交大概只跑了 vitest 没跑 `tsc`。改成经 `unknown` 的一次转换后本轮才有绿的类型门禁可用。

### 8.13 点建造/加速整页闪一下：立即模式全量重建 + busy 遮罩门控错了（2026-09-02）

用户报（带截图）：「为何在这个弹窗里，点建造或者加速，整个主城页面都被刷新了，晃的人眼花，而且我觉得这样对性能表现上也不好。」两件事都成立，而且是两个独立的根因叠在一起。

**根因 A（晃眼）：遮罩门控在 `bt.busy` 上，而不是 `bt.loadingVisible`。** `CityScene.render()` 末尾按 `core.bt.busy` 铺一层全屏 25% 黑；`actions.ts` 的每个动作又在 `bt.start()` 后**同步**跑一次 `render()`。于是 30–80ms 的局域网往返 = 整页变暗又变亮，2–5 帧，每次点击都闪。`BusyTracker` 本来就有 `loadingVisible`（满 1 秒才亮，注释里明写 `if (bt.loadingVisible) drawLoadingOverlay(...)` 的用法），CityScene 却绕过它读了 `busy`。**遮罩从来不负责挡输入**——`handleDown` 的 `if (this.bt.busy) return` 才是，所以快请求根本不该看见任何遮罩。

**根因 B（性能）：一次点击触发 3–4 次整页 teardown+rebuild。** `render()` 无条件 `tearDownChildren(core.container)` 再重建纸背景、装饰层、页眉、资源条、队列条、12 张建筑卡、5 张队伍卡、弹窗——单次约 55–65 个 `PIXI.Text`（各自一次 canvas 栅格化 + GPU 上传，对照 CardScene 卡背包那次实测的 105 个 ≈ 11ms）。而「加速」一次点击要跑：`bt.start()` 的前置 render → `refreshWallet()` 的 `onSaveChanged` render → `bt.stop()` 后的 render。另有两处纯浪费：`bt.tick` 每 0.4s 为**本场景根本不画的** dots 动画买一次整页重建；点开/关弹窗时页面内容一个字没变，也照样整页重建。

**改法（四层，按依赖顺序）：**

1. **遮罩门控换成 `bt.loadingVisible`，并删掉 `actions.ts` 里 5 处 `bt.start()` 后的前置 `render()`。** 快请求 → 中间零次重绘，只在数据真的变了之后画一次。
2. **遮罩搬进自己的常驻层**（`paint.ts` 的 `busyLayer`），由 `update()` 直接 `syncBusy()` 切换 —— busy 状态从此不经过任何一次 render；`bt.tick()` 的返回值**故意不用**（它也为不画的 dots 动画返回 true）。
3. **合帧渲染**：`core.requestRender()` 置脏标志，`update()` 每帧最多 flush 一次。同一 tick 里的多个请求折叠成一次绘制（加速那条路的 2 次请求 → 1 次绘制）。走这条路的是「一帧内可能触发多次」或「玩家早一帧看不出来」的入口：动作完成、`onSaveChanged`、队列轮询、拖动滚动、头像解码。**`data.ts` 那四片交错加载仍走同步 `render()`**——那是 2026-08-02 刻意做的「哪片先到哪片先画」，合帧会把它抹平。
4. **按变更频率拆层**（`CityScene/paint.ts` 的 `CityPaint`，form ② 组合，同 `SectScene/repaint.ts` 先例）：
   - `staticLayer` — 纸背景 + 装饰。**整个场景生命周期只画一次**（`w`/`h` 固定，无需失效）。
   - `pageLayer` — 页眉/资源条/队列条/建筑网格/队伍行。只在页面数据变了时重建。
   - `modalLayer` — 弹窗。`paintPage()` 从不碰它，反之亦然：**开关弹窗不再重建它背后的页面**。
   - `busyLayer` — 在途遮罩（上面第 2 条）。
   - 子节点顺序就是 z 序，`cityModalSpeedup.ui.ts` 依赖它（「弹窗画在暗掉的队列条之后/之上」，`textNodes(...).pop()`）。
   - **命中表跟着分**：`paint.pageHits` 是页面自己那份，`core.hits` 由 `paintModal()`（唯一知道弹窗开没开的地方）决定 —— 有弹窗时 `[backHit, ...弹窗按钮]`，没弹窗时 `pageHits` + 末尾追加引导命中，与旧的单趟 render 逐位一致（`hits[0] === backHit` 是好几个测试的前提）。
   - **引导环要能重放**：开弹窗会 `guide.hide()`，关弹窗时页面并没有重绘，所以没有别的东西会把环放回去。`paintPage()` 把那个决策存成 `paint.guideRestore` 闭包，`paintModal()` 在关闭分支里重放；step2 的目标矩形由 `renderBuildingGrid` 记到 `paint.guideStep2`（**只记矩形，不再自己调 `showAt`**），决策收拢在一处。

**500 行门禁**：`core.ts` 因此涨到 611 行。按 split-priority order 拆了两刀：绘制机制整块进新的 `CityScene/paint.ts`（form ②，156 行），`checkQueueCompletion` 进 `data.ts` 变成 `refreshOnQueueDue(host)`（form ①，它本来就是一条数据刷新路径）。`core.ts` 回到 489 行。

**覆盖测试**：`client/test/ui/cityRenderCoalescing.ui.ts`（新文件 9 例）——快请求全程零遮罩（**并且要驱动真帧**：遮罩由 `update()` 同步，不驱动帧的话把门控改回 `bt.busy` 也照样过）、满 1 秒才出遮罩且完成即撤、无遮罩期间输入照样被 `bt.busy` 挡住、一次升级只重绘一帧且第二帧不再画、空闲帧不画、开/关弹窗页面层是**同一批对象**（按引用比，不是长得一样）、关弹窗恢复页面命中表且 Back 仍在 `[0]`、纸背景整场只画一次、弹窗层在页面层之上。`textureLoadedGuardCallSites.test.ts` 的扫描器扩到 `paint[A-Z]\w*(): void {`——拆出来的 `paintPage`/`paintModal` 是各自独立的重绘入口，守卫契约必须跟过去，否则拆分本身就是契约上的一个洞。

- **变异验证**（逐个改坏确认用例会挂）：恢复 `bt.start()` 后的前置 render → 合帧那例挂；遮罩门控改回 `bt.busy` → 快请求那例挂；关弹窗改回 `core.render()` → 分层两例挂。
- **⚠️ 写这类断言的坑**：`expect(layer.children).toEqual(snapshot)` 在**失败**时会去遍历 PIXI DisplayObject 的 parent/children/transform 循环图构造 diff，直接把 V8 堆撑爆（本轮变异测试时实测 OOM，看起来像「测试挂了」而不是「断言失败了」）。改成按引用比的 `isSameTree()` 辅助函数。
- 验证：`tsc --noEmit`（`tsconfig.json` + `tsconfig.test.json`）全绿、`eslint src` 无 error、`test:ui` 254 文件 / 2434 例 + 默认套件 241 文件 / 2780 例全绿、`check:filelength` 无新违规、`build:web` 构建通过；**真机核对**走 §8.10 的 `web-e2e` 桩挂载路径（`__nwE2E.views.showCity()` + 假 `worldApi`，无需后端栈），复现用户截图那座城（贴纸铺 Lv.5、队列 48:00、加速 48 金币），并在**四个层的 `addChild`/`removeChildren` 上挂钩子**逐次记录绘制（标签页被遮挡时 rAF 被挂起，用 `app.ticker.update()` 手动驱帧）：
  - 开弹窗：**modal 层 1 次绘制（2 个对象）、page 层 0 次**，背后 55 个 Text 一个没动；
  - 「关弹窗 → 开另一张卡 → 再关」三次交互：**合计 modal 层 1 次绘制、page 层 0 次**；
  - 300ms 往返点「升级」，驱 79 帧：**page 层 1 次、modal 层 1 次、遮罩帧 0**；
  - 1600ms 往返：遮罩 t≈1096ms 升起（只画 busy 层 2 个对象）、t≈1710ms 落下，随后**唯一一次** page 绘制；
  - 引导链：开卡弹窗 → 环消失，关弹窗 → step3 的环出现在 Back 上（`guideRestore` 重放路径，且页面未重绘）。
  - **测出来但不是回归的一处**：加速把 48 分钟的队列直接烧到 0，导致队列条目立刻「到期」，`refreshOnQueueDue` 每秒重新 `getMe` 一次、每次要一帧绘制 —— 桩服务器从不清队列才会这样，真服务端 2s 调度器清掉条目后就停。改前也是这个行为（那时是同步 `render()`），不是本轮引入的。
### 8.14 训练队列槽位改为并行（2026-09-02，ADR-079）

owner 对着自家主城的训练面板问：「队列 3/3、在训 7225，这三个槽位不是并行的吗？顺序的话，三个队列就没意义了啊。」截图里三行倒计时 `1:59:26 / 3:13:32 / 3:13:36` 首尾相接，一秒不差——确实是**串行**。

- **根因是两侧从来没对齐过，不是漏做**：`worldsvc/src/city/training.ts` 的 `trainTroops` 把新批次挂在 `queue[last].completeAt` 上（链式），而 `econ-sim/src/citySiegeRosters.ts` 的 `trainPerHour` 从第一天起就是 `perSlot × trainQueueMaxFor(b)`（并行）。**ADR-074 的攻城门禁是拿并行那一侧标定的**，所以服务端才是错的那边；重跑 `npm run city-siege`，gate ③ 每个数与 ECONOMY_VERIFICATION_LOG_CAPACITY §13-SLG-CITYSIEGE 已登记的值逐字相同，五门全 PASS。
- **改动**：`startAt = t`（入队即开跑）；`trainingQueueOps` 的 `nextTrainingCompleteAt` 镜像从 `queue[0]` 改成 `Math.min(...)`（数组是入队序，并行后不再等于完成序——排在 5,000 兵后面的 2 兵批次先完工，镜像取队头会让它在索引 due-scan 里彻底消失）；`speedupTraining` 逐槽按 `completeAt` 升序烧、删掉 re-link 级联、把已到期 entry 的剩余夹到 ≥0（原来会**倒退钱**）；客户端报价从 `max(剩余)` 改成 `Σ(剩余)`，批次行按完工时间排序。
- **金币定价刻意不变**：一枚币仍只买一个槽的 60 秒，所以 gate ③ 记在案的「金币换兵、原则上无上限」残余风险一分没动。
- **手感**：满级填满 20,000 兵从 13.9 h 变成 **6.9 h**（4 批 ÷ 3 槽 = 2 轮）。ADR-075 定 1/2/3 曲线时的「空仓填满不超过 2 次上线」论证仍然成立，只是不再是槽位买到的全部。
- **存量不迁移**：线上已链式排好的 entry 保持自己的 `completeAt`，排完即自愈。

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
> - **建筑数据模型 + 纯函数**（`shared/slg.ts`）：`BuildingKey`/`BUILDING_KEYS(_P1)`/常量（DESK_MAX_LEVEL=20、BUILD_YIELD_STEP=0.05、STICKER_SELF_BASE=200、CABINET_CAP_STEP=0.1、DRILL_TROOPCAP_STEP=500、DRILL_TRAIN_SPEED_STEP=0.04、BUILD_QUEUE_SLOTS=1 等，全 DRAFT。**⚠️ 此为 2026-06-30 当时值；2026-07-15 D-CITY-7 后 DESK_MAX_LEVEL=10、各 STEP 翻倍：DRILL_TROOPCAP_STEP=1000 等**）+ `buildingYieldMult`/`buildingSelfYield`/`resourceCapFor`/`troopCapFor`/`drillTrainMult`/`trainQueueMaxFor`/`buildCost`/`buildTimeSec`/`buildGateReason`（单测 8 例全绿）。
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
  - 世界地图基地血条 + 全屏泛红特效 — **已实现**（D-CITY-8 表现层，2026-07-16）：契约无需改动——`siegeHpView`（`worldsvc/src/core/helpers.ts`）已把主城 anchor 的 `durability`/`durabilityMax` 映射进既有 `WorldTileView.hp`/`maxHp` 字段（对 `mine` 无特殊处理），世界地图既有的通用 `drawHpBar`（`client/src/scenes/worldmap/tileGraphics.ts`）因此对受损的自家主城原样生效，无需改客户端。全屏泛红特效为新增：`WorldMapRenderer/vignette.ts`（移植自战斗场景 `GameRenderer/events.ts` 的 base-damage vignette，同一套分层描边算法）+ `WorldMapNet.applyTileUpdate` 对比推送前后自家主城 tileCache 的 `hp` 判断是否被扣耐久（`TileUpdate` 本身不带 hp 字段，见 `transport.proto`），命中即调用 `flashDamageVignette()`。军事页耐久状态展示（D-CITY-12 旁支）仍待做。
  - **验收标准待定**：军事页耐久状态展示尚未进入实现/契约设计（D-CITY-10/12 均已收口）。
  - **建筑图标出图（2026-07-17，2026-08-17 补齐 academy）**：`desk`/`cabinet`/`drillYard`/`wall`/`satchel` 五个此前用 `icons.ts` 程序化线稿/emoji 占位的建筑，换成手绘钢笔线稿真图——桌面文具书桌 / 文件柜 / 尺规交叉演武场 / 文具堆砌城墙 / 帆布书包。源图 `art/slg/slg-desk/`（AI 生成 UUID 命名图），`pack_city_bld.cjs` 打包成 `client/src/assets/slg/city_bld_atlas.{png,json}`（近白阈值抠图 + 连通域降噪去除源图背景纸纹杂点 + shelf-pack，同 `slg-map/pack_buildings.cjs` 套路），`client/src/render/atlas/cityBldAtlasLoader.ts` 懒加载，`CityScene.bldIcon()` 新增 `BLD_ATLAS` 映射优先命中，未就绪时仍回落原程序化图标。资源类建筑（inkPot 等）不受影响，继续走 `res_atlas`。**`academy`（书院）当时被漏掉**，一直留着程序化字形，2026-08-17 全量美术审计发现后补了第 6 张（书本堆叠 + 学士帽），详见 [`slg-citybld-icon-prompts.md`](../product/slg-citybld-icon-prompts.md)。
  - 内政/军事 tab 布局改为左侧竖排（装订线左侧，复用 Roster/Equipment 的 `HubTabs.drawSidebarTabs`/`sidebarNavW` 侧栏组件），取代原顶部横排 tab — **已实现**（2026-07-16，`client/src/scenes/CityScene.ts` `renderPageTabs`）：正文内容（资源条/建造队列/建筑网格/军事页各面板）整体右移 `contentX = sidebarNavW(...)`。
  - **⚠️ 2026-07-23 单页合并（撤销 D-CITY-11/12，详见 §8.2 → §8.5）**：军事页并回内政单页——删侧栏 tab、耐久进标题栏、科技树（`academy`）回建筑网格、五队改贴底固定一行。上面几条「双屏 / 侧栏 tab / 科技树独立面板」的实现描述均已**作废**，仅留作历史记录。军事页耐久状态展示的「待做」项因此一并关闭（耐久已在标题栏）。
  - **世界地图"玩家基地"独立美术（2026-07-17）**：此前 `desk`（基地，1-10级）升级只改数值，世界地图上基地贴图沿用和"可攻占城池"同一套 `city_atlas`（其 tier 来自地形生成的 `TileDoc.level`，与 desk 等级无关联，desk 升满10级贴图不变）。现拆成两套完全独立的资源：可攻占城池继续用 `city_atlas`（`getCityTextureForLevel(tile.level)`）；玩家自己的基地（`tile.mine`）新增 `playerbase_atlas`（10张，一级一图，"文具搭建的桌面堡垒"主题，见 `design/product/player-base-image-prompts.md`）。数据链：desk 升级完工时（`worldsvc/src/city.ts` `applyDueBuilds`）把新等级写入 `TileDoc.deskLevel`（新字段，不复用/覆盖既有 `level`），经 `core/map.ts tileDocView` 透出到 `WorldTileView.deskLevel`；客户端 `WorldMapRenderer/city.ts` 按 `tile.mine` 分支取 `getPlayerBaseTextureForLevel(tile.deskLevel)`，取不到（美术未就位）时回落 `getCityTextureForLevel`。**已上线**（`client/src/render/atlas/playerBaseAtlasLoader.ts` + `art/slg/slg-playerbase/pack_playerbase_atlas.js`）：10张正式美术图已生成、打包进 `playerbase_atlas.png/json`。打包脚本的去背算法针对这批白底源图做了调整（`TSEED` 72→0，见 `design/product/player-base-image-prompts.md` 接入现状）。

---

## 11. 与现有系统咬合 / 红线复核

- **不碰天梯**（SLG7 / D-CITY-6）：建筑注入只走 `recomputeYield`/`trainTroops`/主城 `buildSiegeBattle`/`buildSiegeBlueprints`（SLG 口）。`buildPvpBlueprints` 硬墙单测不受影响，新增「满级建筑喂天梯引擎 → 蓝图逐字等于常量」断言加固。
- **统一养成树不变**：跨季养成仍只有装备/科技/材料（PvE+SLG 共用）。建筑是 SLG 赛季内政叠加层，季末清，不进养成树（避免与 SLG8「材料统一」混淆）。
- **惰性结算不变**：建筑只改 `recomputeYield` 的乘数/自产项 + `settleResources` 的 cap，不引入每格 tick。
- **变现合规**：coin 买速度不买上限（D-CITY-5/§6），对齐 ECONOMY_BALANCE 反 P2W 政策。

### 修复：资源/兵力扣费的并发竞态可套利（2026-07-26）

- **问题**：拍卖行余额校验漏洞（`AUCTION_DESIGN.md` 同日条目）修复后，应用户要求对全站金币/资源流程做了一轮排查，发现 SLG 侧内政资源（纸/墨/石墨/金属/贴纸）与兵力的扣费全部是「读取 → JS 里判断够不够 → 写回」，没有一处用 Mongo 原子 `findOneAndUpdate` 加余量守卫（金币走 `commercial.spend()` 的部分本身没问题——已确认扣款始终在状态提交前 await 完成）。命中的具体函数：
  - `city.ts` `distributeTroops`：`$inc:{troops:-totalCost}` 的过滤条件只有 `_id`，没有 `troops:{$gte:totalCost}`——并发调用能把兵力冲成负数。
  - `city.ts` `upgradeBuilding`/`trainTroops`：资源用整对象 `$set`（不是 `$inc`）写回，过滤条件只有 `_id`——并发升级/练兵时，两次调用都读到同一份扣费前快照、都通过够不够的检查，后写的那次把资源字段整体覆盖，等于其中一次白扣。
  - `territory.ts` `buildWatchtower`/`buildStructure`：同款「读-判断-整体 `$set`」模式，且原代码先落地图（瞭望塔/建筑标记）再扣资源——竞态输家会在扣费失败前就已经把地图标记写上，出现「免费建筑」。
- **改动**：以上五处的 `playerWorld` 写入过滤条件统一加上 `rev: pw.rev`（乐观锁守卫，读到的 `rev` 快照），写入失败（`matchedCount===0`）抛 `REV_CONFLICT`（`shared/src/api.ts` 既有错误码，客户端需重试；用法与 metaserver `mutateSave` 的既有约定一致）。`distributeTroops` 额外把兵力扣减和每张卡的 `currentTroops` 累加都改成 `$inc`（而非算好绝对值再 `$set`），配合 `troops:{$gte:totalCost}` 的过滤条件守卫，比单纯 rev 锁更直接。`buildWatchtower`/`buildStructure` 额外调整了写入顺序——资源扣费（rev 守卫）先于地图标记写入，避免"扣费失败但建筑已经落地"的部分应用态。
- **测试**：`server/worldsvc/test/card-slg.e2e.test.ts`「distributeTroops: concurrent calls cannot drive the troop pool negative」、`server/worldsvc/test/city-buildings.e2e.test.ts`「upgradeBuilding: concurrent calls cannot double-queue off a shared stale resource read」、`server/worldsvc/test/watchtower.e2e.test.ts`「concurrent buildWatchtower on two different tiles cannot both deduct from the same stale resource read」——均先在修复前的代码上跑通（确认能复现套利：并发全部成功），修复后断言恰好一次成功、其余 `REV_CONFLICT`/`NO_TROOPS`，资源/兵力最终值正确。
- **验收**：`worldsvc` `tsc --noEmit` 全绿；`vitest run` 全量 320/320。纯服务端逻辑改动，无可见渲染变化，未做浏览器截图验证。

### 修复：练兵/建造调度每 2 秒全表扫描导致 VPS CPU 随时间升高（2026-07-26）

- **问题**：用户反馈线上游戏变卡，登 VPS（Hetzner CX23，2 vCPU）查资源发现 `worldsvc`/`socialsvc` 会周期性一起飙 CPU，且是部署完 19 小时后才逐渐变严重。定位到 `scheduler.ts` 每 2 秒无条件调用的 `processCompletedTraining()`（`city.ts`）查询 `playerWorld.find({'trainingQueue.0.completeAt':{$lte:t}})`——`trainingQueue.0.completeAt` 这个数组下标字段完全没建索引（`db.ts` 的 `ensureIndexes` 只给了 `{worldId,accountId}`/`{familyId}`），每次调用都是对整个 `playerWorld` 集合的全表扫描。线上 `explain()` 实测：1643 篇文档，`totalKeysExamined=0`，全扫。开销跟**文档总数**成正比而非在线人数，越攒越多所以才会"部署完没事、隔天变严重"；又因为所有服务共用同一个 Atlas M0 免费集群（单节点，CPU/IOPS 都很紧），`worldsvc` 这个扫描一贵，`socialsvc` 自己那些几十条数据的查询也跟着排队变慢——这就是"social 服务器本该几乎空闲却一起飙"的真正原因。复查发现 `buildQueue`（建造队列，同一调度器、同一模式、`city.ts` 注释里自己写的"复刻 trainingQueue"）踩了一模一样的坑：`processCompletedBuilds()` 查 `'buildQueue.0.completeAt'`，同样没有支持索引。顺手还发现 `sieges`（机器人攻城记录，`combatDefense.ts` 的 `listSieges`）的 `defenderId` 分支也没索引，且该集合本来就没有 TTL、已经攒了 8650 条会持续变大——这条只加了索引，TTL 是否要引入涉及"要不要保留完整对战历史"的产品决策，本次未动。
- **改动**：`trainingQueue`/`buildQueue` 各自新增一个标量镜像字段（`nextTrainingCompleteAt`/`nextBuildCompleteAt`，见 `db.ts`），值等于队列头（最早的 `completeAt`），队列清空时用 `$unset` 而非置 `null`（缺字段才能配合 partial index 保持索引本身很小，且能被 `$lte` 的范围查询自然排除，不用担心 null 跨类型比较的坑）。`ensureIndexes()` 给这两个字段各建一个 `partialFilterExpression:{$exists:true}` 的索引；`processCompletedTraining`/`processCompletedBuilds` 的查询改用这两个新字段。所有写路径（`trainTroops`/`speedupTraining`/`upgradeBuilding`/`speedupBuild`/`applyDueBuilds`/shop 的 `troop_speedup`）在写 `trainingQueue`/`buildQueue` 的同时原子维护镜像字段，靠 `db.ts` 里新增的 `trainingQueueOps`/`buildQueueOps` 两个纯函数统一计算，避免四五处写入各自算一遍算漏。另外给 `sieges` 补了 `{worldId,defenderId}` 索引（`listSieges` 的 `$or` 分支之一此前全表扫）。
- **测试**：新增 `server/worldsvc/test/city-training.e2e.test.ts`（7 例）+ `city-buildqueue.e2e.test.ts`（5 例），覆盖：入队时镜像字段跟着设置、队列非空时二次入队不误改、`processCompletedTraining`/`processCompletedBuilds` 把镜像字段推进到下一条或清空、`speedupTraining`/`speedupBuild`/商店加速路径清空队列时镜像字段跟着清空、以及用真实 `explain('executionStats')` 断言新查询 `totalKeysExamined>0`（确认真的走了索引而非裸扫）。
- **验收**：`worldsvc` `tsc --noEmit` 全绿；`vitest run` 全量 43 files / 332 tests 通过（含新增 12 例）。纯服务端逻辑改动，无可见渲染变化，未做浏览器截图验证；索引改动已用线上真实 Mongo Atlas 数据做过 `explain()` 验证（修复前 COLLSCAN 1643 篇文档，修复后走索引）。**尚未部署到 VPS**——修复只在 worktree 分支，需要走一次 `docker compose up -d --build` 才能在生产生效。

---

*本文档为 SLG 主城建筑系统设计基准，状态：设计中。D-CITY-1（赛季清空）待用户拍板后落 ADR；DRAFT 数值随经济模拟细化。*
