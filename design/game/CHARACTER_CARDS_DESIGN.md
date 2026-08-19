# Notebook Wars — 角色卡系统设计（CHARACTER_CARDS_DESIGN）

> 创建：2026-07-01。本文是角色卡**实例系统**的设计基准，取代 `CHARACTER_DESIGN.md` 中的养成/获取章节（角色外观与机制定义仍见 `CHARACTER_DESIGN.md`）。
> 配套阅读：`EQUIPMENT_DESIGN.md`（装备词条/强化）、`SLG_DESIGN_LOG.md §16`（布阵/队伍）、`ECONOMY_NUMBERS.md §15`（数值权威）、`GACHA_DESIGN.md`（卡池）。
> 拍板日期：2026-07-01。

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `CHARACTER_CARDS_DESIGN.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Notebook Wars — 角色卡系统设计（CHARACTER_CARDS_DESIGN） | **本文** |
| §9 PvE 对接、§10 卡背包 UI、§11–§13 拍卖/抽卡/端点、§14–§17 影响面/迁移/开放问题/进度 | [`CHARACTER_CARDS_DESIGN_IMPL.md`](CHARACTER_CARDS_DESIGN_IMPL.md) |

## 0. TL;DR

- **角色卡是独立实例**（Hero Roster）：每张卡有唯一 ID、独立等级（0–9）、独立装备槽（3 槽）。
- **同种卡可拥有多张**：3 张陈守可同时上阵，各自装备不同。
- **等级靠融合（2026-07-19 重设计）**：选目标卡 + 5 张**同阵营、同等级**卡一次性融合，材料销毁、目标升 1 级；不支持混级/打折顶替，总卡量需求量级与旧连续 XP 曲线相当（改的是交互体验，不是经济节奏）。
- **兵力 = 卡的 HP**：每张卡有带兵上限（随等级增长），出战分配兵力，结算存活率按残存比例计算。
- **受伤规则**：卡的 HP 在战斗中归零 → 该卡受伤（5 分钟）→ 所在队伍整队锁定不可出战。
- **背包上限 500 张**（2026-07-19 由 150 扩容），独立于装备背包（1000 件，ADR-064 2026-08-10 由 300 扩容）。
- **PvP 永不读卡实例**（`buildPvpBlueprints` 硬墙不动）。

---

## 1. 核心决策（已拍板 2026-07-01）

| # | 决策 | 理由 |
|---|---|---|
| CC1 | 角色卡为**独立实例**，不共享等级/装备 | 资源分配策略深度；玩家可集中培养或广泛培养 |
| CC2 | 同种卡可**同时上阵**，无重复限制 | SLG 最多 12 张/队，满足"10 个陈守"的极端策略 |
| CC3 | 融合升级（2026-07-19 重设计），**同阵营+同等级**的 5 张卡一次性融合，材料销毁，目标升 1 级 | 阵营内流通；离散"凑 5 张"比连续攒 XP 更直观，玩家不再被"喂到 6 级要几千张卡"的抽象数字吓到 |
| CC4 | **锁定卡不可作为融合材料**；上阵卡可换装备但不可作为融合材料 | 防误操作；上阵仍可调整养成 |
| CC5 | 兵力 = 血量，结算存活率 = f(残存 HP 比例) | 胜利损耗小、惨胜损耗大，激励高效作战 |
| CC6 | 卡的 HP 在战斗中**归零 → 该卡受伤**（5 分钟冷却）→ 所在队伍整队锁定；与胜负无关 | 惩罚源于真实战损，不是输赢本身 |
| CC7 | 卡背包**硬上限 500 张**（2026-07-19 由 150 扩容），不再自动扩容，满了无法获得新卡（gacha 退回） | 防无限囤积；促流通（融合/拍卖）；容量提高是为了让玩家能多留些卡备战 SLG 队伍，不必把所有重复卡都拿去融合 |
| CC8 | **PvP 永隔离**：`buildPvpBlueprints()` 不接受卡实例参数 | 竞技公平命根子 |
| CC9 | 卡在拍卖行**裸卖**（不带装备），装备需先手动卸下 | 拍卖行每次只卖单一独立 ID 物品 |
| CC10 | PvE 显示固定具名角色外观，属性**自动读该兵种战力最高的卡实例** | 叙事一致 + 养成生效 |

---

## 2. 数据模型

### 2.1 卡定义（CardDef）— 服务端 `@nw/engine`

```ts
type Faction = 'tao' | 'anna'  // 可扩展枚举，预留第三阵营

interface CardDef {
  id: string              // e.g. 'shieldbearer', 'max', 'lena'
  unitType: UnitType      // 引擎兵种（Infantry/ShieldBearer/Archer）
  faction: Faction
  troopCapBase: number    // 1 级带兵上限基础值（各兵种可不同）
  troopCapGrowth: number  // 每级增长（flat）
  skillGrowth: SkillGrowthTable  // 技能随等级成长表，见 §7
  powerWeights: { hp: number; atk: number }  // 战力公式权重
}
```

> 数值权威在 `ECONOMY_NUMBERS.md §15`；本文的数字仅为设计意图占位。

### 2.2 卡实例（CardInstance）— SaveData

```ts
interface CardInstance {
  id: string           // 唯一实例 ID，e.g. 'card_a1b2c3'
  defId: string        // 引用 CardDef
  level: number        // 1–9（MAX_CARD_LEVEL）
  gear: GearSlotMap    // { weapon?, armor?, trinket? } → equipInstanceId
  locked: boolean      // 锁定后不可作为融合材料
  sourceType?: string  // 溯源标签（2026-08-04，ITEM_IDENTITY_DESIGN.md）：'starter'/'checkin'/'pve_anchor:<levelId>'/'pve_drop:<levelId>'/'gacha:<orderId>'；可选，老实例为 undefined，无消费方，纯预留
  obtainedAt?: number  // 获得时间（epoch ms），同上，可选
  // ⚠️ currentTroops / injuredUntil 不在此处——SLG 运行态存 worldsvc（见 §8.4）
  // ⚠️ 无 xp 字段（2026-07-19 融合重设计移除）——升级是离散的"5 张同级卡→+1 级"，不再有级内连续进度
}
```

### 2.3 SaveData 变更（SAVE_VERSION 4）

```ts
// 移除：
//   unitLevels: Record<UnitType, number>
//   gear: GearLoadout（global/byUnit 结构）
// 新增：
cardInv: Record<string, CardInstance>  // key = CardInstance.id，上限 500（2026-07-19 由 150 扩容）
```

> 装备实例仍在 `equipmentInv`，不变。装备的穿戴关系从 `SaveData.gear` 移入 `CardInstance.gear`。

**SAVE_VERSION 5**（2026-07-13，LOBBY_IA_REDESIGN §15 / ADR-038）：`equipped`（皮肤/称号共用的 cosmetic map）新增按角色独立的皮肤槏位 `skin:<UnitType>`（`game/meta/skinDefs.ts` 的 `skinEquipKey()`），取代原先账号级单一全局槏位 `equipped['unit']`。迁移：老档 `equipped['unit']` 按 `SKIN_TARGET_UNIT` 映射搬到对应角色的槏位（`migrate.ts` v4→v5）。皮肤的**拥有关系**不变，仍是账号级库存（`inventory.skins`），只有"装备到哪张卡"这层关系变了。

### 2.4 战力公式

```
战力 = (hp_at_level × w_hp + atk_at_level × w_atk) × (1 + Σ装备加成%)
```

- `hp_at_level` / `atk_at_level`：读引擎蓝图按等级缩放后的值（含技能成长）
- 装备加成：汇总该卡 3 槽装备的所有词缀加成（与 `EQUIPMENT_DESIGN §7.7` 上限对齐）
- 权重 `w_hp` / `w_atk` 按兵种配置（`CardDef.powerWeights`），见 `ECONOMY_NUMBERS §15`

---

## 3. 升级系统（融合，2026-07-19 重设计）

> 原因：旧版连续 XP 曲线下，喂到 6 级理论上需要 3,000+ 张 1 级卡（`5^level` 累积经验、1 级卡喂养固定只算 1 点经验），玩家看到这个数字直接被吓退。本次重设计改的是**交互体验**，不是**经济投放节奏**——见下方"为什么总卡量没变少"。

### 3.1 融合规则

- 升级不再是"喂经验条"，而是**离散的五合一融合**：选中一张目标卡，从背包中选出 **5 张同阵营、同等级**的卡作为材料，一次性消耗后目标卡**升 1 级**（`MAX_CARD_LEVEL` = 9 封顶）。
- 材料卡的等级必须**严格等于目标卡当前等级**——不允许混级、不允许用低等级卡打折顶替。这意味着要凑出高等级材料，得先把更低等级的卡各自独立融合上去，因此**总卡量需求量级与旧版 `5^level` 曲线一致**（本质仍是原来的五合一，只是把"输入数字喂经验"包装成"摆 5 张卡+融合动画"，见 `MEMORY.md` 同名记录 / `design/DECISIONS.md`）。
- **限制**：
  - `locked = true` 的卡不可被选为融合材料
  - 当前在队伍中上阵的卡不可被选为融合材料
  - 已满级（`MAX_CARD_LEVEL`）的卡不可再作为融合目标
  - 材料卡不可与目标卡是同一实例，材料列表内部也不可重复引用同一实例

### 3.2 融合 UI

目标卡居中，5 个材料槽环绕排布（六芒星式布局）；下方候选列表按角色（`defId`）分组、展示与目标同阵营同等级的可用卡（数量徽标）。5 槽全部填满后「融合」按钮才亮起，点击后播放融合动画（当前是程序内占位特效，后续替换为 `vfx-editor` 专门制作的资源：5 张材料卡自身头像错峰沿弧线汇聚到目标、每次到达触发一次涟漪，最后目标卡挤压回弹+金色爆闪+放射线，见下方 2026-08-01 条目），动画结束目标卡升级、材料卡销毁。

#### 目标意图契约（2026-08-18 重设计，取代自动换目标 / 自动连续融合）

> **面板的目标只在玩家点击后才改变；玩家最初点开的那张卡，在他自己改变主意之前必须一直在屏幕上可见。**

**为什么推翻 2026-07-20 ~ 2026-08-10 的那套自动化。** 旧版有两条自动化：①**自动重选目标**——点开的卡凑不齐 5 张材料时，面板静默换成另一张材料充足的卡并 toast 告知（`roster.fuseAutoRetarget`）；②**自动连续融合**——1/2 级目标融合成功后不关面板，继续跳到下一张可融合的卡。两条都是在给**同一个结构性事实**打补丁：严格同级五合一 + `5^(L-1)` 曲线下，「材料不够」从 Lv.3 起就是**常态而非意外**（升到 Lv.4 需要 5 张 Lv.3 = 125 张 Lv.1），而把一张卡推到 Lv.5 需要约 125 次中间融合、其中 124 次不含任何决策。于是①几乎每次打开面板都触发、②几乎每次融合都触发，叠加起来的净效果就是：**玩家点了 A，系统在升 B**。08-02、08-10 两次调整 `findAutoTarget` 的排序（把「已上阵」提到最前）是在调补丁的补丁，治不了根——只要系统还在替玩家选目标，排序调得再准也仍是"我没选的角色"。

取而代之的四件事：

- **缺口态（新增）**：材料不足时**照常显示玩家点开的那张卡**，已有的材料**直接预填进环形槽位**（`feedPlan.autoFillMaterials`，按"最不心疼"排序：无装备优先 → 该 `defId` 冗余副本最多的优先，避免烧掉某角色最后一张 SLG 替补），配文案「还缺 N 张 Lv.X 同阵营卡」。看得见「3/5，还差 2」比 toast 有用得多。旧版从来没有这个状态——它一进面板就被自动换目标吃掉了。
- **备料下钻（新增）**：缺口态在玩家**付得起（含链式，见下）且有炉子可用**时给出「合成所需材料」按钮，并明写代价（`planPrep`：缺 N 张 → 需 `N × (5 材料 + 1 炉子)` 张低一级的卡，附「你有 M 张」）。**两个条件缺一不可**（`affordable` + `hasFeeder`，2026-08-18 补测发现的 bug）：带装备的卡**能当材料、不能当炉子**（`pickFeeder` 会跳过它，否则融合会无声拆掉一套配装），所以存在"卡数够了但那一级全带装备"的情形——旧版只判 `affordable`，结果按钮亮着、点下去 `enterPrep` 因为找不到炉子直接 return，**什么都不发生**。现在这种情况不给按钮，改显示获取渠道提示（此时说"需要 6 张、你有 6 张"是自相矛盾的）。点下去不是"换了个目标"，而是**同一个目标的子任务**：面板顶部常驻面包屑「备料：陈守 Lv.4 · 1/3」，环形移到一张**炉子卡**上；每合成一张就 +1，凑齐后**自动弹回原目标**且槽位已填满 5/5。**链式定价（2026-08-18 当日补做）**：`planPrep` 不只看紧邻的低一级，缺口填不满时会**再往下看一级并给整条链定价**——「缺 1 张 Lv.3 → 需 6 张 Lv.2，只有 4 张 → 差的 2 张各再花 6 张 Lv.1 = 12 张 Lv.1」，`PrepPlan.chain = { level, need, have }`，`fundable = affordable || chain 够`。这条是中期最常见的形态（"我有一堆 Lv.1/Lv.2，就是缺 Lv.3"），补之前它被判为 unaffordable、**原地死路**，尽管玩家明明走得通。链路可行时，缺口态的代价行改用 `roster.fusePrepChain`（"Lv.2 只有 4/6 张，12 张 Lv.1 可补足"），点下去开第一层备料帧、环形落在一张**自己也还不能融合**的 Lv.2 上，由它自己的缺口态再显式开第二层——每一级的代价在被授权前都单独写清楚，不把 108 张卡的消耗塞进一次点击。`enterPrep` 里"pickFeeder 找不到当场可融的炉子就退而求其次挑一张同级可用卡"的兜底正是靠这条才真正可达（统一收口为 `chooseWorking`，三处续帧点共用）。

**深度上限恒为 2 且三处边界必须一致**：`planPrep` 只向下定价一级 → 一次备料最多开 2 帧，`MAX_PREP_DEPTH = 2` 就是这个上限的显式声明，缺口态按钮同时受 `canNest` 约束。**按钮的可见性与 `enterPrep` 的深度守卫必须成对**——只在动作侧拦、不在按钮侧拦，正是本节下面那个"按钮亮着点了没反应"bug 的形状。实际上第二帧的工作卡恒在 Lv.1（`planPrep` 在 Lv.1 返回 null，没有更低一级），所以两道边界与 Lv.1 地板重合、单独都观察不到；改动定价深度时三者要一起改。再深的缺口只显示数字并指向掉落/抽卡/拍卖行，不做无底洞。面包屑随时可「放弃备料」退回原目标。**迷惑感的来源是"我的目标不见了"，不是"目标变了"**——目标可以变，只要原目标一直可见、且是玩家自己点的。
- **两套方向相反的排序**：`listFusableTargets`（推荐用，挑**值得养**的卡）沿用 08-10 那套 `已上阵 > 同 defId > 同阵营 > 等级高`，只是从"决策器"降级为**推荐条的排序**；`pickFeeder`（备料用，挑**不心疼**的卡）方向完全相反——**排除**已上阵/已锁定/**带装备**的卡（服务端融合只删卡不卸装，烧掉带装备的副本等于无声拆掉一套配装），再优先该等级下副本最多的 `defId`。这两套必须分开，否则备料会把上阵主力升上去再当材料烧掉。
- **推荐条**：面板底部一行横向头像 chip，列出「其他可升级的角色」（`roster.fuseReadyList`），**点了才切目标**。备料进行中隐藏（此时面包屑是唯一的去处）。

**融合成功后的行为**：面板**永远停在同一张卡上**，不关闭、不跳卡，就地重新求值——材料还够就直接进可融合态（「融合 (5/5)」亮着，可连点），不够就进缺口态。旧版「Lv.3+ 融合一次就关面板」的特例一并取消。因为面板不再关闭，`onFuseSettled` 里补了一次 `core.render()` 刷新背后的花名册网格与顶栏容量/金币读数（`fuseRingOpen` 期间 `render()` 只重绘背景、不碰模态层，见 `CardScene.ts` 的 render 分发）；同理 `core.ts` 的 `onSaveChanged` 守卫由 `fuseRingOpen` **收窄为 `fuseInProgress`**——旧的宽守卫会在面板开着的整段时间里屏蔽所有存档驱动的刷新，导致顶栏读数一直是陈的。

**批量备料**：备料层内剩余 ≥2 轮时给出「一键合成剩余 (×N)」（`countPrepRounds` 模拟真实库存算出的可完成轮数，不是 `avail / 6` 的算术上界）。这是把那 124 次无决策点击折叠成**一次玩家显式授权**的操作——与"暗中换目标"性质完全不同：只在**同一个备料帧内**批量，绝不跨卡。实现上刻意**不播每轮动画、也不播收尾动画**（环形几何属于开始那一刻的炉子卡，运行中已被消耗/换过多次，任何动画都在展示已经失效的头像），改用汇总 toast 报告实际完成轮数；首轮失败即停并只报已落地的轮数（失败通常是 `REV_CONFLICT`/超时，继续跑等于对着客户端已不可信的状态继续花卡）；循环条件同时判 `core.destroyed`——玩家中途退出花名册后不再发起新一轮，连"规划下一轮"都不做（规划本身就是在读一个已经销毁的面板不再拥有的状态）。

**落地**：`client/src/scenes/CardScene/feedPlan.ts`（纯规划/排序，取代 `feedAutoTarget.ts`）+ `feedGap.ts`（面包屑/缺口通知/批量按钮/推荐条/页脚）+ `feedRing.ts`（环形，从 `feed.ts` 拆出以守 500 行约定）+ `feed.ts`（状态机重写）+ `actions.ts`（`doPrepBatch`）+ `core.ts`（`doPrepBatch` 懒钩子；`sortCards`/`injuryCountdown` 外移到 `cardSort.ts` 腾出行数）。测试：`test/feedPlan.test.ts`（23 例，取代 `feedAutoTarget.test.ts`）+ `test/ui/cardFusePanel.ui.ts`（37 例，两个旧 describe 整体替换）。**服务端零改动**——融合规则、`5^(L-1)` 曲线、`FUSION_MATERIAL_COUNT=5`、`MAX_CARD_LEVEL=9` 全部未动，本次改的只是交互契约。

**明确没有采纳的方案（2026-08-18 拍板）**：曾提出取消"材料必须严格同级"、改用融合当量（一张 Lv.n 卡 = `5^(n-1)` 点，任意等级都能投，配进度条与溢出结转），可把 125 次点击压成 1 次。**否决，两条理由**：①严格同级在做**分层**的活——玩家只面对「还差 2 张 Lv.3」，当量制会把总量摊开成「还差 3125 张 Lv.1」，正是 07-19 重设计好不容易藏起来的那个吓人数字；②当量制 + 进度条会诱导玩家把整个阵营的低级卡一次梭哈，**替补席直接清空**，而 CC7 把背包上限从 150 扩到 500 的本意恰恰是"让玩家能多留些卡备战 SLG 队伍"。

#### 其余 UI 沿革

- **（已废弃 2026-08-18）自动重选目标 / 低等级连续融合 / 自动换卡优先同名 / 自动换目标排序扩展**：这四条 2026-07-20~2026-08-10 的条目已被上面的「目标意图契约」整体取代，保留标题仅为让旧引用能找到去处。
- **横屏布局（2026-07-20）**：竖屏维持单列（标题/提示 → 环形槽位 → 候选列表 → 按钮）不变；横屏改为左右分栏——左列放标题/提示/环形槽位，右列放候选列表 + 融合/取消按钮，充分利用横向空间。
- **等级星星（2026-07-25）**：环形目标卡中心下方的等级展示由 `Lv.N` 文字改为一排金色星星（一星一级，最高 9 星），与花名册网格 / 卡详情 modal（§10.1/§10.2）的星星表示保持一致；候选材料行同步去掉行尾 `Lv.N` 后缀（该行本就恒等于目标当前等级，星星已在环形中心展示一次，行内重复文字数字纯属冗余）。
- **卡详情"融合材料"计数须与环形候选列表同口径（2026-07-25 修复）**：`openFuseSelect`（`feed.ts`）的候选池早就排除了已上阵（`cardState[id].teamId` 非空）的副本——已上阵的卡不能拆去当材料。但卡详情 modal（`detail.ts`）的 `materialsOwned`/进度条只调了 `fusionMaterialCandidates()` 未过滤 `teamId`，把已上阵的副本也计入"可用材料"，导致详情页显示"5/5 已就绪"而实际点开融合面板材料不够（甚至触发自动换目标）。修法：`materialsOwned` 补上与 `feed.ts` 一致的 `!cardState?.[c.id]?.teamId` 过滤。已上阵卡在花名册网格（`list.ts`）本就有醒目的"[已上阵]"标签，两处结合就足够说明"这张副本当前不能作为材料"，无需再加独立的锁形态。
- **融合动画视觉加强（2026-08-01）**：玩家反馈占位动画"表现太弱"——载体是纯色圆点，看不出"大家把力量集中给一个人"的叙事。`playFusionAnim`（`feed.ts`）改为：①5 个材料飞行载体换成各自卡面头像本身（复用环形已加载的纹理，非新增素材），错峰 60ms 起飞，沿弓形弧线（非直线）swoop 入目标，飞行途中带渐隐墨迹拖尾；②每个材料到达目标时触发一次涟漪脉冲，叠出"逐个汇入"的层次感而非一次性瞬移；③终 burst 从单一膨胀圆环升级为金色圆环+阵营色放射线+目标卡自身的挤压回弹（squash/stretch）。`FuseRingGeom` 相应扩展 `centerR`/`slotR`/`slotArtUrl`/`targetArtUrl` 字段供动画读取。性能上刻意只用已缓存纹理+纯矢量 `Graphics` 描边/描线，不引入新贴图或叠加型混合（additive/glow），维持微信小游戏低端机可承受的开销（另见 `claudedocs/client-memory-leak.md` 的 `generated`/`genDelta` 纹理预算告警）。这仍是程序内占位特效，正式方案仍是走 `vfx-editor` 出专属资源。
- **终 burst 收尾帧强化（2026-08-02）**：定稿评审指出终 burst 那个膨胀金圈用的是对称 `sin` 脉冲（0→1→0），动画最后一帧的 alpha 精确为 0——冲击波本身没问题，但收尾"泄了气"，没有一帧可以让玩家的视线落下。方案：在冲击波之外叠加一层固定几何的金色"定格光晕"（半径 `centerR+12`）——随冲击波一起淡入，冲击波结束后再满强度保持 220ms，随后 260ms 缓出，动画总时长从 ~700ms 延到 ~1180ms。**性能**：光晕的 `Graphics` 只在动画开始时 `lineStyle`/`drawCircle` 画一次，此后逐帧只改 `alpha`，不再 `clear()`+重绘（冲击波本身的圆环/放射线半径逐帧变化，仍需 `clear()`+重绘，两者不可比）；`test/ui/cardFusePanel.ui.ts` 新增的「post-burst halo」用例里有一条专门 spy `PIXI.Graphics.prototype.clear` 断言这一点，回归会立刻抓到有人把光晕改回逐帧重绘。

### 3.3 融合换算（服务端权威）

```
FUSION_MATERIAL_COUNT = 5

applyFusion(target) = target.level >= MAX_CARD_LEVEL
  ? target                          // no-op：已满级
  : { ...target, level: target.level + 1 }
```

服务端 `fuseCards(targetId, materialIds[], idempotencyKey)` 校验顺序：材料数量严格等于 `FUSION_MATERIAL_COUNT`（不多不少）、无重复引用、目标非满级、每张材料同阵营、同等级（等于目标**当前**等级）、未锁定——全部通过后原子地移除 5 张材料卡并令目标 `level += 1`；`idempotencyKey` 防止网络重试导致二次消耗（重放返回目标卡当前状态，不再重复扣材料）。

> 旧版连续 XP 系统（`feedXp()`/`LEVEL_CUMULATIVE_XP`/`applyFeedXp()`）与 `CardInstance.xp` 字段已完全移除，不做迁移——存量 `xp` 字段值随读取自然作废（TS 类型层面已不存在该字段）。

---

## 4. 获取渠道

| 渠道 | 产出 | 说明 |
|---|---|---|
| **新手初始** | 李川/陈守/苏远 各 1 张（1 级） | 注册时发放，不占抽卡 |
| **章节通关（专属奖励）** | 对应角色的 **2 级卡** × 1 | 涛侧奇数章、Anna 侧偶数章（见 `CHARACTER_DESIGN §5.1`）。⚠️ 这是**首通某章的专属奖励**，与「每关掉落」（1 级，见下）不同。✅ CC-11 已实装（映射 `pveRewards.CHAPTER_ANCHOR_CARD`；发放 `pve.ts` grantChapterClearCard，仅首通触发一次） |
| **每关掉落** | 随机兵种卡（**1 级**） | PvE 关卡内掉落，与新手/拍卖/抽卡口径一致（1 级），玩家靠喂卡升级 |
| **抽卡（混合池）** | 装备/材料/皮肤/**角色卡**（各稀有度权重见 `GACHA_DESIGN`） | 后期可出限时专属池（单阵营/单兵种） |
| **活动/赛季** | 指定卡实例奖励 | 具体见活动设计 |

### 4.1 背包满时的处理

- 抽卡时若 `cardInvCount >= CARD_INV_CAP`（=500，2026-07-19 由 150 扩容）：**抽卡照常**，不阻塞本次抽卡流程
- **前 10 张溢出卡走邮件**（2026-07-18；常量 2026-07-19 统一改名 `CARD_INV_OVERFLOW_BUFFER`，同时兼任 UI 预警阈值，见 §10.1）：自英雄名录上次有空位起，累计溢出的前 `CARD_INV_OVERFLOW_BUFFER`（=10）张卡作为真实卡实例通过系统邮件发放（`kind:'card'` 附件，与拍卖行邮件认领同一机制，见 §13 装备篇同款设计），领取前需先腾出背包空间；持久计数器 `save.cardMailOverflowCount` 记录已用额度，一旦背包再次出现空位即重置为 0
- 超出前 10 张的溢出卡：转换为等值 coin 补偿（`CARD_FULL_COMPENSATION_COINS`=10/张），不入背包
- 客户端在揭示动画结束后统一弹一条汇总 toast（`gacha.invFull.*`），区分"邮件补偿"与"金币补偿"，避免玩家在背包已满时毫无感知地持续抽卡
- 章节通关奖励：仍走纯 coin 补偿（`grantCards` 不传 `mailCtx`，行为未变——见 §4 CC-11 记录）
- 补偿价值按稀有度/等级计算，见 `ECONOMY_NUMBERS §15`

---

## 5. 装备与卡的关系

### 5.1 穿卸规则

- 装备穿在**卡实例**上（`CardInstance.gear`），不再有全局/按兵种 loadout
- 穿装备端点：`POST /equipment/equip`，参数改为 `{ cardInstanceId, slot, equipInstanceId | null }`
- 上阵中的卡**可以换装备**（不限制）
- 受伤中的卡可以换装备（受伤只影响部署，不影响养成操作）

### 5.2 卖卡前置

- 卡进拍卖行前必须**手动卸下所有装备**（系统检验 `gear` 全空才允许挂单）
- 拍卖行展示：卡种、等级、战力分

### 5.3 引擎注入

`applyEquipment(bp, cardInstance)` 读取 `cardInstance.gear` 中的三件装备，注入该兵种蓝图。每张卡独立注入，同种卡不共享装备加成。

---

## 6. 兵力系统

### 6.1 核心原则：兵力是 SLG 运行态，不是养成数据

兵力相关状态（`currentTroops`、`injuredUntil`）**全部存 worldsvc `PlayerWorldDoc.cardState`**，不进 metaserver `SaveData`。SLG 赛季重置时随 `playerWorld` 一起清除，养成数据（等级/装备/XP）跨赛季保留。

- **只有在队伍中的卡才能持有兵力**
- 新上阵的卡：`currentTroops = 0`，需要玩家手动从基地兵力池分配
- 移出队伍的卡：`currentTroops` 清零，**返还 80% 的训练资源**（粮/铁/木材，不是兵力本身；因训练消耗时间，无法直接返还兵力）
- 战斗后存活的兵：留在卡上，卡可继续出战（残兵状态）
- **分配给某张卡的兵力（`cardState.currentTroops`）不会自动回到基地兵力池（`playerWorld.troops`）**——唯一的释放路径是上面「移出队伍」这一条（且只返还训练资源，不返还兵力本身）。
- **兵力池统一（2026-07-21）**：曾经存在两个互不连通的池子——`playerWorld.troops`（§4 地图池，训练/无卡行军/驻防用）和 `baseTroopStock`（本节的卡牌后备池，入世赠送 10000）。训练写入前者、`distributeTroops` 却从后者扣，导致「训练出的兵永远分不到卡上」。现已**彻底合并为单一字段 `playerWorld.troops`**（退役 `baseTroopStock`）：训练、无卡行军、驻防、卡牌分兵全部共用这一个基地兵力池，上限 = `cityTroopCap`（见下）。存量存档由一次性 boot 迁移把旧 `baseTroopStock` 折叠进 `troops` 并刷新 `troopCap`。

> **合规修复（2026-07-15）**：核验发现 `combatMarch.ts`/`combatSiege/*` 违反了本节的既有铁律——带卡牌布阵的行军出征时仍会额外从 `playerWorld.troops` 扣一份等额兵力、到达/扑空/结算时再退回去，与 `cardState.currentTroops` 的独立结算**同一批存活兵力记了两次账**。已按本节原意修复：卡牌布阵行军全程不触碰 `playerWorld.troops`，兵力只活在 `cardState.currentTroops` 里；同时把占地（`kind:'occupy'`）也接入真实卡牌军队（此前只有 `attack` 才读真实布阵，占地永远用合成的通用步兵，见 `SLG_DESIGN.md` §4.2）。

### 6.2 带兵上限（统率）

每张卡有独立的**带兵上限**（`troopCap`），随等级增长：

```
troopCap(card) = CardDef.troopCapBase + CardDef.troopCapGrowth × card.level
```

> 各兵种基础值和成长率见 `ECONOMY_NUMBERS §15`。

### 6.3 训练场与基地兵力池

训练是**玩家手动发起**的操作（主城桌面上独立的「训练士兵」格子，与练兵场同级；练兵场建筑本身只提供带兵上限/训练加速/队列槽加成），产出的兵力存入**基地兵力池**（`playerWorld.troops`，不自动分配到卡）：

```
cityTroopCap = troopCapFor(buildings) = TROOP_CAP_BASE + drillYard × DRILL_TROOPCAP_STEP   // 见 ECONOMY_NUMBERS §15
playerWorld.troops ≤ cityTroopCap                                                          // 当前存量（新手一开始即装满 TROOP_CAP_BASE=10000）
```

> 参考三国志战略版兵营机制：训练有队列，兵力存基地，分配靠玩家操作。基地池同时也是无卡通用行军/驻防的兵源（统一池，见 §6.1）。

### 6.4 士气加成

```
士气加成 = (currentTroops / troopCap) × 0.2
→ 满员出战：+20% ATK
→ 半员出战：+10% ATK
→ 0 兵力：可出战，但上场即阵亡（系统警告，不强制阻拦）
```

士气加成在引擎蓝图生成时注入（`applyTroopMorale(bp, troopRatio)`）。

### 6.5 分配兵力

从基地兵力池手动分配给队伍中的各卡：

- **一键补满**：按战力降序，依次补至 `troopCap`；池不足则按比例分配剩余
  - **先自动存队伍**：`distributeTroops` 要求每张卡已有 `teamId`（在队伍中），否则报 `Card X is not assigned to a team`。刚拖进格子但未点保存的卡只在客户端本地、server 无 `teamId`，会被拒。因此「补满兵力」在调 `distributeTroops` 前先 `persistTeam()`（= `setTeams` 合并本槽），玩家布阵后直接补兵、无需另点保存（`setTeams` 只对被移出所有队伍的卡清兵/退款，留队的卡兵力不变，先存后补安全）。
- ~~**手动调整（2026-07-21 落地）**：点布阵格里的某张卡打开逐卡分兵浮层（`+100 / +500 / 补满此卡`）~~ **（2026-07-23 移除）** 逐卡分兵浮层已删除——与「一键补满」冗余，且浮层里重复显示了顶栏已有的兵力池数字。分兵现在只有「补满兵力」一条入口（`allocateToCard` 一并删除）。每个上场角色头顶仍有一条血条显示 `currentTroops / troopCap`。分兵仍是**只增**操作（server `distributeTroops` 只加不减；兵力从卡上释放只能靠移出队伍，见 §6.1）
- **战前检查**：布阵中有卡 `currentTroops = 0` → UI 显示警告（不强制阻拦）
- **新玩家**：进入 SLG 时基地兵力池即为满值 `TROOP_CAP_BASE = 10000`，足够初始布阵（统一池后由 `troopCapFor(buildings)` 决定，不再是独立的赠送常量 `BASE_TROOP_STOCK_INITIAL`）

> **客户端缺口修复**（2026-07-18）：server 端 CC-4（`distributeTroops`/`POST /world/troops/distribute`）
> 2026-07-01 已完成，但客户端从未接入——`DefenseEditorScene`（布阵编辑器）只把卡片拖进队伍格子，
> 从没有界面调用这个接口，导致玩家配好队伍后 `cardState.currentTroops` 永远是 0，`teamTroops.ts`
> 的 `carriedTroops()` 算出 0，占地/进攻的队伍选择器（`WorldMapNet.showTeamPicker`）判定为"无可用队伍"
> 直接过滤掉——即使 UI 上"看起来已经配置了两个队伍"。已在 `DefenseEditorScene` 底部加"补满兵力"
> 按钮，实现上述"一键补满"规则（战力降序、补至 troopCap、池不足按顺序分配剩余）。
>
> **手动调整 + 兵力池统一**（2026-07-21）：逐卡分兵浮层（点上场卡 → `+100/+500/补满此卡`）+ 头顶血条落地；
> 同时把训练入口从练兵场弹窗挪成主城桌面独立格子，并把 `baseTroopStock` 与 `playerWorld.troops` 合并为单一
> 基地兵力池（退役 `baseTroopStock`，`TROOP_CAP_BASE` 2000→10000，一次性 boot 迁移折叠存量），使
> 「训练 → 分兵给角色」首次形成闭环（此前训练写 `troops`、分兵读 `baseTroopStock`，两池不通）。
>
> **布阵编辑器 PC 调整**（2026-07-23）：①顶栏兵力读数（Garrison / Troops / Troop pool）字号 `FS.small → FS.title`，右上 `Fill/Clear/Save` 按钮组 `renderActionButtons` 加 `scale` 参数、攻击模式传 `scale=2`（防守页脚仍 1），PC 大屏上不再过小；②删除逐卡分兵浮层（见 §6.5）；③布阵新增**拖拽放置**：在右侧卡池按住某张卡拖到左侧格子即部署，作为「点选→点放」之外的第二种方式。实现：`onDown` 命中卡池格时武装 `dragCardId`，`onMove` 指针越过卡池左边界（`x < rosterX`）时提升为拖拽（同时 `gesture.up()` 取消滚动手势并起一个半透明 ghost 跟随），`onUp` 落点复用 `onGridTap`（先把该卡设为当前 tool，再在落点放置——放置规则单点维护）。ghost 挂在独立 `dragLayer`，不随 `render()` 重建。
>
> **顶栏读数格式 + Fill 按钮置灰**（2026-07-24）：①顶栏 `Troops {n}` 改为 `已分兵/队伍总容量`（新增 `teamCapacity()` = 布阵中各卡 `troopCap()` 求和，只算已上场的卡，不含右侧未部署的卡池）；②队伍满员（`committedTroops() >= teamCapacity()`）时「补满兵力」按钮描边/文字转灰（`C.mid`）且不再注册点击命中区（`hits` 里不再 push 该按钮），避免满员时误触发一次空操作的 `distributeTroops` 往返。覆盖：`test/ui/defenseEditorFillTroops.ui.ts` 新增 `teamCapacity` 计算 + 按钮命中区存在/消失的用例。
>
> **CityScene「填满所有队伍」一键批量分兵（2026-08-02）**：`DefenseEditorScene` 的「补满兵力」一次只操作当前打开的一支队伍——想把 5 支队伍都喂饱得逐个进编队编辑器点一遍。`CityScene`（主城首页）队伍栏（D-CITY-10）右上角新增「填满所有队伍」按钮（`renderTeamsRow`/`doFillAllTeams`，`CityScene/base.ts`），对 `t1..t5` 按槽位顺序依次应用同一条「战力降序、补至 troopCap、池不足则把剩余全部塞进当前队伍」规则：一支队伍补满（或该队已无缺口）就换下一支，直到兵力池耗尽——池耗尽后排在后面的队伍保持原样，不做"按比例雨露均沾"式分配。与单队「补满兵力」的差异仅在于遍历粒度（多队 vs 单队），底层分配算法与 `distributeTroops` 语义完全一致；由于 `CityScene` 里的 5 支队伍都已经是服务端已保存的正式编队（非布阵编辑器里"刚拖入未保存"的临时态），这里不需要 `persistTeam()` 这一步。覆盖：`test/ui/cityFillAllTeams.ui.ts`。

## 7. 战斗结算与受伤

### 7.1 结算存活率

战斗引擎跑完后，每张卡按**残存 HP 比例**计算结算存活兵力，更新 `currentTroops`：

```
survivalRate(card) = baseSurvival + (1 - baseSurvival) × (remainingHp / deployedHp)
card.currentTroops = round(deployedHp × survivalRate)
```

> `baseSurvival`（HP 归零时的最低存活率）= DRAFT，见 `ECONOMY_NUMBERS §15`。
> 示例（baseSurvival=0.2）：出战 10000，HP 归零 → 存活 2000；HP 剩 50% → 存活 6000；HP 全满 → 存活 10000。
>
> **`deployedHp` 的口径（2026-08-19 澄清，见 [ADR-069](../DECISIONS_ADR-041-onward.md#adr-069-slg-攻城值随携带兵力缩放破城不再有12-卡硬顶-npcbasehp-重校准-4060--accepted--2026-08-19)）**：分母是**实际入场的 HP**，不是队伍的名义兵力之和。两者会差很多——每张卡的入场 HP 被截断到该兵种的蓝图单兵血量上限（`min(兵力, 蓝图 hp)`），真实卡队通常只有名义兵力的 40–60% 真正进场。此前代码拿「引擎存活 HP ÷ 名义兵力」当存活率，量纲不一致导致存活率被截断比压顶，**连打赢都要掉一半兵**（生产实例：一场胜仗 402/2510 → 直接触发 20% 保底）。现由 `SiegeResolution.attackerDeployed`/`defenderDeployed` 携带真实入场值，占领/攻地/险地/关口/野战/主城波次六条结算路径统一使用。

### 7.2 受伤规则

受伤**以卡为单位触发**（兵力归零），但**以队伍为单位锁定出战**：

```
战斗中某张卡的 HP 被打到 0
  → 该卡：currentTroops = 结算存活值（baseSurvival 保底）
          injuredUntil = now + 5min

  → 该卡所在的整支队伍：5 分钟内不可出战
    （只要队伍中任意一张卡有 injuredUntil > now，整队锁定）

同一战斗中有剩余 HP 的卡
  → currentTroops = 正常结算值，injuredUntil 不变（健康）
  → 但若同队有受伤卡，整队仍不可出战
```

**示例**：12 张卡的队伍，战斗中 1 张卡兵力归零 → 该卡受伤（结算后仍有 baseSurvival 保底兵力，**不为 0**），整队 5 分钟不可出战；其他 11 张卡的兵力正常结算，但都被连带锁定。

**恢复选项**：
- 等待 5 分钟：所有受伤卡自动恢复，队伍解锁
- 花 coin 立即恢复某张受伤卡：该卡 `injuredUntil` 清空；若队伍所有卡均已健康，队伍立即解锁
- **将受伤卡移出队伍**：受伤卡的 `currentTroops` 永久损失；若移出后队伍内无受伤卡，队伍立即解锁

**受伤期间该卡（仍在队伍中）**：
- 队伍出战时该卡随队参战（带 baseSurvival 保底的残兵）
- 若硬要出战需先解锁队伍（等待/coin/移出受伤卡）
- 可换装备（养成不受限）
- 不可被喂出（防误操作）
- 训练场继续填充该卡的空余名额（受伤不影响补兵）

### 7.3 服务端权威

- 结算在 worldsvc `applySiege` / `landSiege` 中执行，逐卡更新 `currentTroops` 和 `injuredUntil`
- 结果随 `siege_result` 推送客户端（SaveData 增量更新）
- 伤愈判断：客户端拉取时自查 `injuredUntil vs Date.now()`，无需服务端主动 tick

---

## 8. SLG 布阵对接

### 8.1 ArmyEntry 变更

```ts
// 旧
interface ArmyEntry { unitType: UnitType; col: number; row: number; initialHp?: number }

// 新
interface ArmyEntry { cardInstanceId: string; col: number; row: number }
// unitType 由 cardInstanceId → CardDef.unitType 推导
// initialHp 由服务端按兵力分配计算，不存在 ArmyEntry
```

### 8.2 队伍约束

- 每名玩家最多 **5 支队伍**（`SIEGE_TEAM_CAP = 5`，不变）
- 每支队伍最多 **12 张卡**（`SIEGE_CARDS_PER_TEAM = 12`，新增）
- 同张卡（同 `cardInstanceId`）**只能归属一支队伍**，不可同时出现在两支队伍（服务端保存时做全局唯一性校验）
- 同种卡（同 `defId`）可在同一队伍中重复（无限制）
- 受伤卡（`injuredUntil > now`）不可加入任何队伍；从队伍中移出后同样不可重新加入其他队伍，直到伤愈
  - `setTeams` 拒绝时抛 `CARD_INJURED`（2026-07-25 新增错误码，此前复用 `BAD_REQUEST` 导致客户端 `errorMsg()` 兜底把诊断用的原始英文报错——卡实例 id + 毫秒时间戳——原样弹给玩家，参见 `DefenseEditorScene.errorMsg`/`injuredCardMsg` 事故记录）。`DefenseEditorScene` 现在专门识别该错误码：解析出卡 id，查名译名 + 可读倒计时（`msCountdown`），并把这张卡从本次编辑中的编队里移除（该格子的占用本来就已失效，留着只会在下次 Save/Fill 时重复报同一个错）
  - **校验范围仅限"本次新分配"（2026-08-01 修正）**：客户端 `setTeams` 每次都携带**全部队伍**的完整数组（含未改动的队伍）；早期实现对 payload 里出现的每张卡一律做受伤校验，导致编辑一支全新/无关队伍时，只要另一支早已出战、受伤的队伍恰好也在这次 payload 里（它必然在），保存就会连带失败——玩家的解读是"我在配置新队伍，为何被无关卡的受伤状态卡住"。修复：仅当卡的队伍归属**较上次持久化状态发生变化**（对比 `cardState[id].teamId` 与本次分配的 teamId）才校验受伤，未变的既有分配（哪怕受伤）放行，真正的"分配到新/其他队伍"仍照常拦截。见 `city.ts` `setTeams`（`nextTeamOf` 比对）+ 回归测试 `card-slg.e2e.test.ts`「does not re-block a card already (unchanged) on an injured team while editing an unrelated team」。
- **Hero Roster 排序（2026-08-01 新增）**：`DefenseEditorScene.availableCards()`（布阵编辑器右侧可选卡列表）按 `cardPower` 降序排列，战力高的卡排在前面，方便布阵时优先找强卡；此前无排序，只是 `cardInv` 的对象插入序。与 §6.5「一键补满」的战力降序分配规则保持一致的排序方向，但两处是独立实现（前者排 UI 列表，后者排分兵优先级）。

### 8.3 引擎蓝图生成

```ts
// 旧签名
buildSiegeBlueprints(pveUpgrades, gear, equipmentInv)

// 新签名
buildSiegeBlueprints(cardInstances: CardInstance[], equipmentInv: EquipmentInv)
// 每张 CardInstance → 独立蓝图：基础属性(level) + 装备注入 + 士气注入
```

PvP 路径：`buildPvpBlueprints()` 签名**永不改动**（编译期硬墙，`hardwall.test.ts` 扩测）。

### 8.4 worldsvc 卡状态结构

SLG 运行态中，`PlayerWorldDoc` 新增：

```ts
interface CardSLGState {
  currentTroops: number    // 当前兵力（0 ~ troopCap(level)）
  injuredUntil?: number    // 受伤恢复时间戳（ms）；缺省 = 健康
  teamId?: string          // 所属队伍 ID（undefined = 未上阵）
}

// PlayerWorldDoc 新增字段
cardState: Record<cardInstanceId, CardSLGState>  // 赛季重置时随 playerWorld 清除
```

> **`baseTroopStock` 已退役（2026-07-22，见 §6.3 下方"训练→分兵闭环"说明）**：本节最初（2026-07-01，CC-4）把卡牌兵力池单独建模为 `baseTroopStock` 字段，与地图兵力池 `playerWorld.troops` 并存不通；2026-07-22 二者合并为单一 `playerWorld.troops`，`distributeTroops` 改从这里扣款，`baseTroopStock` 字段本身经 boot 迁移折算后 `$unset`。上面代码块按 2026-07-01 落地时的原样保留作历史记录，**当前实际字段是 `playerWorld.troops`，不是 `baseTroopStock`**。

worldsvc 根据 `siege_result` 直接写 `cardState`，无需通知 metaserver。卡的 SLG 状态是 worldsvc 对卡属性的延伸，元系统（metaserver）不感知。

---


---

**接下页** → [`CHARACTER_CARDS_DESIGN_IMPL.md`](CHARACTER_CARDS_DESIGN_IMPL.md)：§9 PvE 对接、§10 卡背包 UI、§11–§13 拍卖/抽卡/端点、§14–§17 影响面/迁移/开放问题/进度。
