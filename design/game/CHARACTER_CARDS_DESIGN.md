# Notebook Wars — 角色卡系统设计（CHARACTER_CARDS_DESIGN）

> 创建：2026-07-01。本文是角色卡**实例系统**的设计基准，取代 `CHARACTER_DESIGN.md` 中的养成/获取章节（角色外观与机制定义仍见 `CHARACTER_DESIGN.md`）。
> 配套阅读：`EQUIPMENT_DESIGN.md`（装备词条/强化）、`SLG_DESIGN_LOG.md §16`（布阵/队伍）、`ECONOMY_NUMBERS.md §15`（数值权威）、`GACHA_DESIGN.md`（卡池）。
> 拍板日期：2026-07-01。

---

## 0. TL;DR

- **角色卡是独立实例**（Hero Roster）：每张卡有唯一 ID、独立等级（0–9）、独立装备槽（3 槽）。
- **同种卡可拥有多张**：3 张陈守可同时上阵，各自装备不同。
- **等级靠融合（2026-07-19 重设计）**：选目标卡 + 5 张**同阵营、同等级**卡一次性融合，材料销毁、目标升 1 级；不支持混级/打折顶替，总卡量需求量级与旧连续 XP 曲线相当（改的是交互体验，不是经济节奏）。
- **兵力 = 卡的 HP**：每张卡有带兵上限（随等级增长），出战分配兵力，结算存活率按残存比例计算。
- **受伤规则**：卡的 HP 在战斗中归零 → 该卡受伤（5 分钟）→ 所在队伍整队锁定不可出战。
- **背包上限 500 张**（2026-07-19 由 150 扩容），独立于装备背包（300 件）。
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

目标卡居中，5 个材料槽环绕排布（六芒星式布局）；下方候选列表按角色（`defId`）分组、展示与目标同阵营同等级的可用卡（数量徽标），点选填入下一个空槽，点已填槽位可撤回。5 槽全部填满后「融合」按钮才亮起，点击后播放融合动画（当前是程序内占位特效，后续替换为 `vfx-editor` 专门制作的资源），动画结束目标卡升级、材料卡销毁。

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
| **章节通关（专属奖励）** | 对应角色的 **2 级卡** × 1 | 陶侧奇数章、Anna 侧偶数章（见 `CHARACTER_DESIGN §5.1`）。⚠️ 这是**首通某章的专属奖励**，与「每关掉落」（1 级，见下）不同。✅ CC-11 已实装（映射 `pveRewards.CHAPTER_ANCHOR_CARD`；发放 `pve.ts` grantChapterClearCard，仅首通触发一次） |
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
- **分配给某张卡的兵力永远不会回到地图兵力池（`playerWorld.troops`）**——本节这套账本与 §4 的地图兵力池是两个完全独立的池子，唯一的释放路径是上面「移出队伍」这一条。

> **合规修复（2026-07-15）**：核验发现 `combatMarch.ts`/`combatSiege/*` 违反了本节的既有铁律——带卡牌布阵的行军出征时仍会额外从 `playerWorld.troops` 扣一份等额兵力、到达/扑空/结算时再退回去，与 `cardState.currentTroops` 的独立结算**同一批存活兵力记了两次账**。已按本节原意修复：卡牌布阵行军全程不触碰 `playerWorld.troops`，兵力只活在 `cardState.currentTroops` 里；同时把占地（`kind:'occupy'`）也接入真实卡牌军队（此前只有 `attack` 才读真实布阵，占地永远用合成的通用步兵，见 `SLG_DESIGN.md` §4.2）。

### 6.2 带兵上限（统率）

每张卡有独立的**带兵上限**（`troopCap`），随等级增长：

```
troopCap(card) = CardDef.troopCapBase + CardDef.troopCapGrowth × card.level
```

> 各兵种基础值和成长率见 `ECONOMY_NUMBERS §15`。

### 6.3 训练场与基地兵力池

训练是**玩家手动发起**的操作，产出的兵力存入**基地兵力池**（不自动分配到卡）：

```
cityTroopCap = f(主城等级, 兵营科技等级)   // 基地可容纳的总兵力上限，见 ECONOMY_NUMBERS §15
baseTroopStock ≤ cityTroopCap              // 当前存量
```

> 参考三国志战略版兵营机制：训练有队列，兵力存基地，分配靠玩家操作。

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
- **手动调整**：可在一键后逐卡修改
- **战前检查**：布阵中有卡 `currentTroops = 0` → UI 显示警告（不强制阻拦）
- **新玩家**：进入 SLG 时系统赠送 10000 兵力，足够初始布阵

> **客户端缺口修复**（2026-07-18）：server 端 CC-4（`distributeTroops`/`POST /world/troops/distribute`）
> 2026-07-01 已完成，但客户端从未接入——`DefenseEditorScene`（布阵编辑器）只把卡片拖进队伍格子，
> 从没有界面调用这个接口，导致玩家配好队伍后 `cardState.currentTroops` 永远是 0，`teamTroops.ts`
> 的 `carriedTroops()` 算出 0，占地/进攻的队伍选择器（`WorldMapNet.showTeamPicker`）判定为"无可用队伍"
> 直接过滤掉——即使 UI 上"看起来已经配置了两个队伍"。已在 `DefenseEditorScene` 底部加"补满兵力"
> 按钮，实现上述"一键补满"规则（战力降序、补至 troopCap、池不足按顺序分配剩余）；"手动调整"逐卡改量
> 仍未做，留作后续。

## 7. 战斗结算与受伤

### 7.1 结算存活率

战斗引擎跑完后，每张卡按**残存 HP 比例**计算结算存活兵力，更新 `currentTroops`：

```
survivalRate(card) = baseSurvival + (1 - baseSurvival) × (remainingHp / deployedHp)
card.currentTroops = round(deployedHp × survivalRate)
```

> `baseSurvival`（HP 归零时的最低存活率）= DRAFT，见 `ECONOMY_NUMBERS §15`。
> 示例（baseSurvival=0.2）：出战 10000，HP 归零 → 存活 2000；HP 剩 50% → 存活 6000；HP 全满 → 存活 10000。

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
baseTroopStock: number   // 基地兵力池当前存量（≤ cityTroopCap）
```

worldsvc 根据 `siege_result` 直接写 `cardState`，无需通知 metaserver。卡的 SLG 状态是 worldsvc 对卡属性的延伸，元系统（metaserver）不感知。

---

## 9. PvE 战役对接

- PvE 关卡要求特定兵种出场（叙事固定）
- 引擎自动从 `cardInv` 中选取**同兵种战力最高**的卡实例（`selectBestCard(unitType, cardInv)`）
- 卡外观/名字：渲染固定具名角色（李川/陈守/苏远/Max/Lena/Mara），不跟着实例变
- PvE 中兵力消耗：**不计入全局兵力池**（PvE 不是 SLG 资源竞争场景），战斗结算后兵力无变化

---

## 10. 卡背包 UI

### 10.1 展示

- 独立于装备背包（EquipmentScene），入口并列
- 默认排序：**先按等级降序**（2026-07-18：等级是最重要的信息，强卡永远浮到网格最前），同等级内再按英雄分组（`CARD_DEFS` 声明顺序）→ 组内战力降序 → id 稳定（英雄分组保留 2026-07-16 的诉求：同名英雄的多张卡聚在一起、不散乱）
- **图标卡网格**（2026-07-03 起，不再用整行列表）：网格左起点为 `marginLineX(w) + ROSTER_GAP`（图标卡起点右移到红边线右侧，与 `EquipmentScene` 一致）。**列数固定为一行 5 张**（`ROSTER_COLS=5`，2026-07-16：此前按可用宽自动算列数，横屏 1920 下会排到 6 张、卡片偏窄且间隙偏挤；改为固定 5 列后格子更宽、留白更均匀，窄屏时才会自动降到更少列），格间距用 roster 专属的 `ROSTER_GAP=24`（比共享 `CELL_GAP=12` 更宽松，只影响花名册网格，不动装备/衣柜网格），每格约 266px 高（2026-07-06：与 `EquipmentScene` 的装备/材料图标卡统一尺寸，并整体放大 1.5x，此前为 360px/118px）。卡片布局＝**顶部名字**（+阵营点，过长自动缩放）／**左侧兵种立绘**（`UNIT_ART_URLS[unitType]`，贴图异步加载后自动重绘）／**右侧竖排属性**（**等级＝一排金色星星**，一星一级、最高 9 星，塞不下信息栏宽度时整排缩放到一行内；2026-07-18：此前是 `Lv.N` 小字号数字，太容易被忽略，改用星星更醒目、更易一眼对比、战力分、兵力 `cur/cap`、出战·负伤状态）／右下角三装备槽圆点，右上角锁定图标。边框色编码：负伤=红、出战=蓝
  - **卡高再放大 1.5x（2026-07-14）**：`CARD_CELL_H` 177 → 266（=177×1.5），让全高兵种立绘有更多纵向空间、更耐看。此处**不再**与 `EquipmentScene` 的 `EQUIP_CELL_H`（仍 177）统一——角色卡带立绘、装备格只有小图标，故意分开。宽度不变（仍窄，保持花名册密度）
- 背包容量计数：`已有 / 500`（2026-07-19 由 150 扩容），剩余槽位 ≤ `CARD_INV_OVERFLOW_BUFFER`（=10）时高亮提示（原阈值是独立的 `CARD_INV_WARN`=140 常量，现与满仓溢出邮寄上限合并成一个常量复用）

### 10.2 卡详情 Modal

- 基础属性（按等级展示）、技能描述（含当前等级效果值）、带兵上限
- 装备 3 槽（点击进装备选择流）——**点某一槽直接跳到该槽对应的筛选页签**（武器/护具/饰品），而非停在「全部」（2026-07-14）：被点的 `slot` 经 `openEquipment(cardId, slot)` → `goEquipment(...,initialFilterSlot)` → `EquipmentScene` 构造时播种 `filterSlot`。不带 slot（如从大厅装备背包入口）仍默认「全部」
- 融合入口（2026-07-19 重设计，取代原"携手成长"喂卡流程）：中心卡+5 材料槽环绕布局，见 §3.2；未满级时详情页显示"材料 n/5"进度条（已拥有的同阵营同等级材料数，不是旧版的 XP 进度）
- 锁定/解锁切换
- 挂拍卖行（需先卸下所有装备）
- **视觉化改版（2026-07-05）**：原纯文字布局改为「左侧兵种立绘（96×96，与网格同一张图）＋右侧属性列」；装备 3 槽从纯文字 `+N` 改为实际图标（`equipmentAtlas` 的 AI 位图，未加载时回退 `equipmentGlyph` 程序化图形，按 rarity 着色；空槽以 30% 透明度提示槽位类型）；modal 高度改为按内容动态计算，不再固定尺寸留白
- **阵营改用图腾（2026-07-18）**：角色名旁不再显示阵营**文字**（`陶方`/`Anna方`）——阵营以主角命名，文字紧挨角色名会被误读成"第二个名字"。改为**图腾图标**：陶方＝东方盘龙、Anna 方＝西方纹章鹰（呼应两方中/西名字的花名册）。图腾来自 `assets/factions/` 双帧图集（白线透明，运行时按 `FACTION_COLOR` tint；打包脚本 `art/ui/camps/pack_faction_atlas.js`），开机 L0 预载，程序化 glyph 为解码前兜底。因是精细线稿（≥48px 清晰、≤20px 发糊），**只有卡详情 modal 展示完整图腾**（`buildFactionIcon`，28px）；花名册网格 / 衣柜 / 喂卡等密集小行仍保留纯色**阵营点**（`FACTION_COLOR`，小尺寸靠颜色区分即可）。色值只在 `FACTION_COLOR` 一处定义，任何调用点不会漂移。
- **喂卡选材料改为拖动条（2026-07-18，已被 2026-07-19 融合重设计取代）**：材料行原为 `[−] n/total [+]` 点按步进器——若玩家拥有几十张重复卡，逐张点加号太慢。改为水平拖动条：`n / total` 数字显示在条前，拖动手柄或直接点条上任意位置跳转到对应数量；行左侧点按仍保留原「循环 +1，超上限归 0」的快捷方式。实现上新增 `CardSceneBase.modalSliders`（独立于 `modalHits` 的实时拖拽轨迹，按下即生效，不像普通 modal 命中要等松手）。**2026-07-19 起该"数量拖动条"整套 UI 被 §3.2 的环形融合槽位取代**——融合固定消耗 5 张，不再需要"选几张"这个维度，只剩"选哪几张"，故不再需要拖动条这类数量输入控件；`modalSliders` 基础设施仍保留供其他弹层复用。

### 10.3 受伤状态

- 卡面显示红色受伤遮罩 + 倒计时
- 花 coin 立即恢复按钮（价格见 `ECONOMY_NUMBERS §15`）
- 受伤期间不可被拖入布阵编辑器

### 10.4 皮肤 + 背景故事 + 全卡图鉴（2026-07-13，LOBBY_IA_REDESIGN §15 / ADR-038）

废弃 `CollectionScene`（纯图鉴+衣柜页，功能与养成/生涯页重复度低但布局/风格自成一套），拆解并入既有页面：

- **卡详情 Modal 新增翻转**：点击卡面立绘播放翻转动画（scaleX 1→0→1 的挤压翻转，中点切换正反面内容，`CardScene/detail.ts` 的 `flipDetailPortrait`/`drawDetailFace`），背面展示背景故事文案（新 i18n 字段 `card.<defId>.lore`，与既有 `card.<defId>.desc`——**技能效果说明**——是两个不同槏位，不能共用）。再次点击翻回卡图。
- **换皮肤入口在卡详情**：卡面右下角出现"更换皮肤"角标（仅当该角色有 ≥1 张已拥有的皮肤，`skinsForUnitType()` 非空时才显示），点击弹出可穿戴皮肤选择弹层；确认后该卡的立绘换成皮肤形象展示（皮肤实际美术资源仍未产出——见 `render/UnitView.ts` "Art-blocked"——本次只接好数据/UI 管线）。
- **养成页新增「皮肤」侧栏页签**：`[卡背包|装备|皮肤]`（`CardScene/skins.ts`），按角色分区展示默认外观 + 已拥有皮肤，点击直接装备（客户端同步字段写入，不需要联网，见 §2.3 SAVE_VERSION 5）。
- **衣柜卡片网格改版（2026-07-15）**：原先每个角色一整行纵向堆叠、色卡固定 96px，整屏可用宽度基本没用上（右侧大片空白，且无滚动裁剪，皮肤多时会直接溢出屏幕）。改为每个角色一张卡片——左侧全高立绘（沿用 roster 网格的 0.72 立绘比例）、右侧姓名+阵营点 + 横向铺开的皮肤色卡（超出卡片宽度自动换行）；卡片本身按自适应列数（`CARD_W_TARGET` 决定列宽目标）masonry 网格排列，每列独立追踪当前高度，卡片自身高度随皮肤数量变化。同时补上 `drawScrollIndicator`（此前完全没有滚动裁剪）。**1.5x 收窄跟进（同日）**：卡片整体放大 1.5x 的同时，把 `CARD_W_TARGET` 从 620 降到 440（贴合"立绘+2 张色卡"这一常见内容宽度，而不是撑满列宽留大片空白），副作用是横屏 1920px 宽下从 2 列变为 3 列——空间利用更充分，视为预期行为而非回归。
- **衣柜卡片高度 1.5 倍 + 收紧留白（2026-07-15 二次调整）**：卡片整体尺寸（立绘、色卡、间距）等比放大到约 1.5 倍（`PORTRAIT_MAX_H` 150→225、`TILE_W/H` 84→108 等）；`CARD_W_TARGET` 从 620 收紧到 440（按最常见的 2 张色卡一行的实际所需宽度定），并将 `cellW` 按 `CARD_W_TARGET*1.15` 封顶而非把整行可用宽度平均拉伸，消除了色卡右侧大片留白。
- **全卡图鉴移入生涯组**：新场景 `CardCodexScene`，作为生涯（Career）hub 第 4 个侧栏页签 `[生涯统计|称号|成就|图鉴]`（`CareerTabs.ts`），展示 `CARD_DEFINITIONS` 全池，未拥有角色（`getOwnedUnitTypes()` 判定，无对应 Hero Roster 实例）灰显+锁图标；建筑/法术类卡没有"拥有"概念，恒不锁。
- **离线兜底改为读本地缓存**：原 `CollectionScene` 承担的"养成页离线兜底"角色不再需要——`CardScene` 本身已支持离线只读（喂卡/锁定/挂拍卖等服务器权威操作离线时优雅失败，读 `roster.err.offline`；换皮肤本就是本地操作，离线一样可用）。首次登录、本地无缓存的新玩家展示空态视为正常。

---

## 11. 拍卖行扩展

- 新增 `listingType: 'card'`，`itemId = CardInstance.id`
- 挂单前校验：`card.gear` 全空（含 weapon/armor/trinket 均为 null）
- 买家看到：卡种名称、等级、战力分（空装备状态的战力）
- 税率：10%（与装备/材料一致）
- 卡在拍卖行期间：从 `cardInv` 移入 escrow，不计入 `CARD_INV_CAP`（=500）上限；撤单归还

---

## 12. 抽卡池扩展

- 现有 `standard` 池新增角色卡条目（各等级各兵种权重见 `GACHA_DESIGN`）
- 后期限时活动池：可配置只出某阵营、某兵种、或只出材料
- 抽到的卡直接入 `cardInv`（1 级实例，XP=0）
- 背包满时：卡转等值补偿（coin/材料），不阻塞本次抽卡流程

---

## 13. 服务端端点变更

| 端点 | 变更 |
|---|---|
| `POST /equipment/equip` | 参数 `unitType?` → `cardInstanceId?`（必填之一） |
| `POST /cards/fuse`（2026-07-19 取代 `/cards/feed`） | `{ targetId, materialIds[]（恰好 5 个）, idempotencyKey }` → 校验同阵营同等级+未锁定+未满级，扣除 5 张材料，目标 `level+1`，返回新 SaveData |
| `POST /cards/lock` / `POST /cards/unlock` | 新增（2026-07-14 补齐，CC4 锁定/解锁）：`{ cardInstanceId }` → 翻转 `locked` 标志，返回新 SaveData。幂等（已是目标状态则不 bump rev）。此前客户端 `setCardLock` 已调用但服务端从未注册路由 → 线上一直 404「Action failed」 |
| `GET /cards` | 新增（可选）：返回 `cardInv`（SaveData 推送已覆盖，作补充拉取） |
| `PUT /world/teams` | `ArmyEntry` 字段变：`unitType` → `cardInstanceId` |
| auction 挂单 | 新增 `listingType: 'card'` 分支，校验装备全空 |

---

## 14. 重构影响范围

### 服务端

| 文件 | 变更 |
|---|---|
| `server/shared/src/types.ts` | 删 `unitLevels`/`gear`，加 `cardInv`；`SAVE_VERSION→4` |
| `server/shared/src/cards.ts` | 新文件：`CARD_DEFS`、`cardPower()`、`selectBestCard()`（2026-07-19：`feedXp()`/`LEVEL_CUMULATIVE_XP` 移除，改 `applyFusion()`/`FUSION_MATERIAL_COUNT`/`MAX_CARD_LEVEL`/`CARD_INV_OVERFLOW_BUFFER`） |
| `server/engine/src/balance/equipment.ts` | `applyEquipment` 签名改：接 `CardInstance` 而非 `GearLoadout` |
| `server/engine/src/balance/pveUpgrades.ts` | `buildSiegeBlueprints` / `buildCampaignBlueprints` 签名改 |
| `server/metaserver/src/equipment.ts` | `equipEquipment` 改 `cardInstanceId` 参数 |
| `server/metaserver/src/cards.ts` | `fuseCards()` handler（2026-07-19 取代 `feedCards()`） |
| `server/metaserver/src/service.ts` | 路由 `/cards/fuse`（2026-07-19 取代 `/cards/feed`）；装备穿戴路由参数更新 |
| `server/worldsvc/src/db.ts` | `ArmyEntry` 改 `cardInstanceId`；`CardInjuryDoc` 结算写入 |
| `server/worldsvc/src/siegeEngine.ts` | `buildSiegeBattle` 读 `cardInv` 推导兵种+装备 |
| `server/contracts/openapi.yml` | 新增 Card schema；更新 equip/team 路由 |

### 客户端

| 文件 | 变更 |
|---|---|
| `client/src/game/meta/SaveData.ts` | 同步类型变更 |
| `client/src/game/meta/cardDefs.ts` | 客户端镜像 CARD_DEFS（同 equipmentDefs 纪律）；2026-07-19：容量/等级上限常量改为通过 webpack/vitest/tsconfig 的 `@nw/shared/cards` 别名直接导入 `server/shared/src/cards.ts`（该文件零运行时依赖，浏览器安全），不再镜像 |
| `client/src/scenes/CardScene.ts` | 卡背包 UI（列表+详情+融合）；2026-07-19：`feed.ts` 改为环形融合槽位 UI（见 §3.2），取代原喂经验流程 |
| `client/src/scenes/EquipmentScene.ts` | 穿卸装备改接 `cardInstanceId` |
| `client/src/scenes/TeamsScene.ts` | 布阵调色板从兵种列表改为卡花名册 |
| `client/src/net/ApiClient.ts` | `fuseCards()`（2026-07-19 取代 `feedCards()`）；更新 `equip()` 签名 |
| `client/src/net/openapi-world.ts` | 重生（rest:gen） |

---

## 15. 迁移（存量 SaveData）

v3 → v4 **直接丢弃冲突字段**，不做数据转换：

- 删除 `unitLevels`（按兵种等级，与新模型不兼容）
- 删除 `gear`（全局/按兵种 loadout，已迁入 CardInstance）
- 新增 `cardInv: {}`（空背包）
- `SAVE_VERSION = 4`

玩家首次进入新版本时，触发**新手引导**（送初始 3 张卡 + SLG 赠送 10000 兵力），体验与全新玩家一致。旧养成数据不保留——此次是系统性重构，不是渐进升级。

---

## 16. 开放问题

> 数值权威已全部登记进 [`ECONOMY_NUMBERS §15`](ECONOMY_NUMBERS.md)（角色卡数字单一源）。以下 DRAFT 占位值已随 CC-1~5 落地代码；终态判据 = 上线后 analyticsvc 实测对账、惰性下版本生效。

- [x] 各兵种 `troopCapBase` / `troopCapGrowth` 数值 —— DRAFT 已定（`ECONOMY_NUMBERS §15.1`，真源 `cards.ts`）
- [x] `baseSurvival` 存活率基准值 —— DRAFT 0.2（`ECONOMY_NUMBERS §15.4`，真源 `slg.ts` `CARD_BASE_SURVIVAL`）
- [x] 技能成长表各卡具体数值 —— DRAFT 已定（`ECONOMY_NUMBERS §15.1`，真源 `cards.ts` `skillGrowth`）
- [x] 受伤立即恢复的 coin 价格 —— DRAFT 50（`ECONOMY_NUMBERS §15.4`，真源 `slg.ts` `CARD_RECOVER_COIN_COST`）
- [x] 卡进抽卡池的各稀有度/兵种权重 —— DRAFT 已定（`ECONOMY_NUMBERS §15.5`，真源 `economy.ts` standard 池）
- [x] 背包满时卡的补偿价值表 —— DRAFT 10 coins/张（`ECONOMY_NUMBERS §15.3`，真源 `cards.ts` `CARD_FULL_COMPENSATION_COINS`）
- [ ] 第三阵营设计（→ 未来独立文档，本期不做）
- [ ] 羁绊系统（→ `CHARACTER_DESIGN §3.7`，本期不做）

> 上述 DRAFT 数值均为工程占位、未经数值核验（econ-sim / 实测）；正式调平衡时改 `ECONOMY_NUMBERS §15` 引用的真源常量。

---

## 17. 实现进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| **CC-1 共享类型层** | ✅ 2026-07-01 | `cards.ts`（CARD_DEFS/feedXp/cardPower/selectBestCard）+ `types.ts`（CardInstance/SaveData v4）+ engine 签名更新 |
| **CC-2 metaserver CRUD** | ✅ 2026-07-01 | `cards.ts`（grantCards/feedCards）+ `equipment.ts`（cardInstanceId）+ `service.ts`（cardsFeed/maybeGrantStarterCards/grantClearReward）+ `internal.ts` + `openapi.yml`（CardInstance schema/cards/feed/equip） |
| **CC-3 客户端 UI** | ✅ 2026-07-01 | `CardScene.ts`（卡列表/详情/喂卡流程/锁定/倒计时）+ `cardDefs.ts`（客户端镜像 CARD_DEFS）+ `SaveData.ts`（v4 CardInstance/cardInv）+ `TeamsScene.ts`（卡花名册调色板/补满兵力）+ `EquipmentScene.ts`（activeCardInstanceId）+ `ApiClient.ts`（feedCards/setCardLock/equipEquipment(slot,id,cardId)）+ `WorldApiClient.ts`（distributeTroops/recoverCard/CardSLGState）+ `openapi-world.ts`（PlayerWorldView.cardState/baseTroopStock）+ i18n（roster.*/card.*）|
| **CC-4 SLG 兵力** | ✅ 2026-07-01 | worldsvc cardState + 受伤锁队 + 兵力分配；`db.ts`（CardSLGState/ArmyEntry CC-3/baseTroopStock）+ `siegeEngine.ts`（resolveCardArmy/toEngineCardInstances/computeCardStateUpdates）+ `service.ts`（setTeams CC-3 validation/distributeTroops/recoverCard/landSiege cardState write）+ `httpApi.ts`（distribute/recover routes）+ `openapi-world.yml`（CardSLGState schema/distribute/recover endpoints）|
| **CC-5 拍卖行 & 抽卡扩展** | ✅ 2026-07-01 | `auctionService.ts`（itemType:'card' escrow/grant/cancel/expire/reset）+ `metaClient.ts`（escrowCard/grantCard）+ `internal.ts`（/internal/cards/escrow·grant）+ `economy.ts`（标准池 epic+Tao 卡/legendary+Anna 卡）+ `economy.ts`-metaserver（deliverOrder CARD_DEFS 分支→grantHeroCards+背包满补偿）+ `api.ts`（CARD_NOT_FOUND/CARD_HAS_GEAR 错误码）+ `openapi-world.yml`（AuctionView/createAuction itemType enum） |
| **CC-6 客户端战斗接线** | ✅ 2026-07-02 | CC-1~CC-5 迁移了引擎 + 存档 + UI + 测试，但**真实客户端战斗入口未收尾**：`goCampaign` 仍传旧模型 `unitLevels:{} / equipment:{gear:{},inv}`，从不传 `cardInstances` → 引擎实跑 `buildCampaignBlueprints([], undefined)` = 裸蓝图，**卡等级/装备对战斗零作用、gear 也画不出**（旧字段经对象展开绕过多余属性检查被静默丢弃）。本切片把 `save.cardInv` → `EngineCardInstance[]` 接进战斗:`cardDefs.ts`（`toEngineCardInstances`，defId→unitType）+ `matchEngine.ts`/`GameScene.ts`（opts 去 `pveUpgrades/unitLevels/equipment`，改 `cardInstances`+`equipmentInv`）+ `createAppCore.goCampaign`（传新字段）→ 数值生效；同时 `GameRenderer`/`UnitView` 由 `EngineEquipmentInput` 迁到 `cardInstances`+`equipmentInv`，`gearSpecsFor` 镜像引擎「同兵种取最高等级卡」选卡后读 per-card gear 画立绘叠加（§20.4 数据源接通）。旧 `byUnit/global` loadout 概念作废（per-card 取代，UI 已在 CC-3）。验证：client `tsc --noEmit`(含 test) + webpack 生产构建全绿。 |
| **CC-7 花名册入口 + 旧 UI 清理** | ✅ 2026-07-02 | CC-1~6 建好了 `CardScene`（Hero Roster）却**从未接入任何导航**——玩家进不去。本切片：① 大厅「卡」槽 `onOpenCards` → 新 `goCardRoster`（在线进花名册；离线/未登录回退到离线可用的 Collection＝图鉴+皮肤，Collection 仍可从战役地图达）。链路 `AppViews.showCardRoster` + `app.ts`(`CardScene`) + `HeadlessAppViews`(`cardRoster` 屏) + `createAppCore.goCardRoster`（`feedCards`/`setCardLock`/`openEquipment`→`goEquipment(cardInstanceId)`，server-authoritative 经 `adoptServer`）。② 清掉旧 S12「按兵种等级 + 5合1 merge」死 UI：`LevelPrepScene`（去兵种行/traits/merge，只剩 brief/objective/stamina/start）、`CollectionScene`（删 Units tab，只剩 Cards 图鉴 + Skins）、`createAppCore` 去 `goLevelPrep`/`goCollection` 的 `getUnitLevels/getCardInventory/isOnline/tryMerge` 空 stub、`scenes.ui.ts` 测试同步。验证：client `tsc --noEmit`(src) + `npm run typecheck`(test) + webpack `build:web` 全绿。**遗留**（CC-8 已清）：`saveManager.merge` + `ApiClient.pveMerge` + 生成物 `openapi.ts` 的 `/pve/merge` 曾是孤儿 plumbing，已于 CC-8 连同服务端契约一并退役。 |
| **CC-8 `/pve/merge` 契约退役** | ✅ 2026-07-02 | 清掉 S12 collect-and-merge 遗留链路（超出 CC-7「客户端」范围的服务端活）：`openapi.yml` 删 `/pve/merge` 端点 → `gen:api:server` + `rest:gen` 重生成 `routes.gen.ts`/`openapi.ts`（生成物不手改）；`metaserver/service.ts` 删 `pveMerge` handler + `applyCardMerge` import；`@nw/shared unitCards.ts` 删 `applyCardMerge`/`MERGE_COPIES`/`MergeError`（仅 merge 端点使用；`deriveUnitLevels`/`cardInventory`/`unitLevels` 系 Hero Roster 现役字段，保留）；`pve.e2e.test.ts` 删已 skip 的 S12 merge describe；客户端删 `ApiClient.pveMerge` + `SaveManager.merge` 孤儿方法（`@deprecated` 交叉引用改指向 Hero Roster）。验证：`gen:api:server:check` 零差异 + metaserver/client/shared `tsc --noEmit` + webpack 构建全绿。 |
| **CC-9 关卡掉卡回归修复 + `unitLevels` 退役** | ✅ 2026-07-03 | metaserver e2e 首次真跑（内存 mongo harness）暴露 CC-2 `grantClearReward` 的**关卡掉卡从未真正入 `cardInv`**：`levelCardReward` 返回的是 cardKey（`infantry:1`），而 grantClearReward 拿整条 key 去 `CARD_DEFS.find(d=>d.unitType===key)` 匹配 → 永不命中 → 只返 `grantedCards` 却零卡入花名册（掉卡对玩家彻底失效）。修复：先 `parseCardKey(key).unitId` 再按 `unitType` 匹配 CARD_DEFS（key 里的 tier 仅信息性，实例按 **level 1** 发放——**指的是「每关掉落」**，与新手卡/拍卖/抽卡等所有其它发卡口径一致，§12；玩家靠喂卡升级而非掉落 tier。原 CC-2 代码误传 level=2，因掉卡从未真正执行故从未被观测/校验，随此修复一并归一为 1）。

> **⚠️ 与 §4 的区别（2026-07-07 澄清）**：上述 level 1 只针对**每关掉落**。§4「章节通关（专属奖励）」= 首通某章送对应锚点角色的 **2 级卡**，是一条**独立奖励路径**（已于 CC-11 实装，见下）。同时纠正 CC-8 的误判——`unitLevels` 在 SaveData v4 已删、openapi response schema 会剥离、`/internal/save-fields` 也已改返 `cardInv`，故 `deliverCardGrant`（gacha units 池，仍写 deprecated `cardInventory`）里 `save.unitLevels` 写入是死代码，连同 `economy.ts` 的 `deriveUnitLevels` import 一并退役（`cardInventory` 保留：gacha units 池尚未迁 Hero Roster，`economy.e2e` reconciliation 用例现役）。守卫：`pve.e2e`（掉卡→`cardInv` lichuang/chenshou 实例计数）+ `economy.e2e`（gacha units→`cardInventory`，去 `unitLevels` 断言）。 |
| **CC-10 喂卡请求体字段错配修复 + 契约测试补全** | ✅ 2026-07-04 | 客户端 `ApiClient.feedCards()` 一直发 `{ targetCardId, materialCardIds }`（且不带 `idempotencyKey`），但 `openapi.yml`/`routes.gen.ts` 早已要求 `{ targetId, materialIds, idempotencyKey }`（本文档 §13 也曾误记旧字段名，一并订正）——花名册喂卡升级在生产环境每次都 400。修复：`ApiClient.feedCards()` 补 `idempotencyKey` 参数并映射为契约字段名；`app/nav/game.ts` 调用点补 `genUuid()`。新增测试防止此类客户端-服务端字段名漂移再次发生：① `client/test/api-client.test.ts` 新增卡/装备类接口的请求体断言（feedCards/reforgeEquipment/craftEquipment/enhanceEquipment/salvageEquipment/equipEquipment/setCardLock，逐字段核对 wire body）；② 新增 `server/metaserver/test/openapi-request-schema.test.ts`，遍历 `openapi.yml` 全部 76 个操作的 requestBody schema，用真实 ajv 校验「仅含 required 字段的最小 payload 能通过」+「去掉任一 required 字段必失败且报错指名该字段」，防 spec/codegen 的 `required` 与 `properties` 脱节（已用故意注入 stale required 字段验证会失败，随后复原）。**已知局限**：后者只守服务端契约自洽性，不能替代①对客户端实际发送字段名的断言——两者互补，缺一不可。 |
| **CC-11 章节通关专属奖励（§4 送 2 级锚点卡）** | ✅ 2026-07-07 | 补上 §4「章节通关（专属奖励）」缺失实现——首通某章送对应锚点角色的 **2 级卡**（独立于每关掉落的 level 1）。`@nw/shared pveRewards.ts` 新增权威映射 `CHAPTER_ANCHOR_CARD`（ch1→lichuang / ch2→max / ch3→chenshou / ch4→lena / ch5→suyuan / ch6→mara，陶奇 Anna 偶，按兵种位配对，见 CHARACTER_DESIGN §5.1）+ `chapterOf`/`chapterAnchorCard`/`CHAPTER_ANCHOR_CARD_LEVEL=2`。`pve.ts`：`writeClearProgress` 在同一 rev 事务内检测「章节 finale 首通」（比较前后 `chaptersClearedCount`，与 `campaign.chaptersCleared` 同触发点、天然幂等：重放不变、并发重复失 rev 竞争后重读已含 finale），回报 `newlyClearedChapter`；新增 `grantChapterClearCard` 用 `grantCards(...,level=2)` 发卡，背包满走 `commercial.grant`（`reason:'chapter_card_inv_full'`，确定性 orderId，与 gacha CC-5 同路径补偿）。发放点：常规路径在 `grantClearReward` **之前**（使返回 save 反映新卡）；spot-check 路径与进度一并发放（一次性、不可farm，不随物资奖励延到 /pve/verify）。守卫：`pve.e2e`（首通 finale→level-2 锚点卡实例、重放不重复、偶数章→Anna 锚点、spot-check 路径亦发）+ `pveRewards` 单测（映射覆盖全章 + 解析 + 每章有锚点）。 |
| **CC-13 融合升级重设计 + 背包 500 扩容** | ✅ 2026-07-19 | 玩家反馈旧版连续 XP 曲线下"喂到 6 级要几千张卡"直接吓退新玩家。改为离散五合一融合（§3）：`server/shared/src/cards.ts` 删 `feedXp`/`LEVEL_CUMULATIVE_XP`/`CardInstance.xp` 字段，新增 `applyFusion()`/`FUSION_MATERIAL_COUNT`(=5)/`MAX_CARD_LEVEL`(=9，原散落各处字面量 9 收拢成命名常量)；`server/metaserver/src/cards.ts` `feedCards()`→`fuseCards()`，校验材料数量恰好 5、同阵营同等级、未锁定、目标未满级；契约 `POST /cards/feed`→`POST /cards/fuse`（`server/contracts/openapi/paths/inventory.yml`+`schemas.yml`，重跑 `gen:api:contracts`/`gen:api:server`/client `rest:gen`）。背包容量 `CARD_INV_CAP` 150→500，且 client `cardDefs.ts` 不再镜像该常量与 `MAX_CARD_LEVEL`/`FUSION_MATERIAL_COUNT`，改由新增的 `@nw/shared/cards` webpack/vitest/tsconfig 别名直接指向 `server/shared/src/cards.ts`（零运行时依赖，浏览器安全）导入，是本仓库首次为 client 打破"镜像纪律"、走真正去重。满仓预警阈值 `CARD_INV_WARN`(140) 与溢出邮寄上限 `INV_FULL_MAIL_COUNT`(10) 合并成一个复用常量 `CARD_INV_OVERFLOW_BUFFER`(10)。客户端 `CardScene/feed.ts` 重写为环形融合槽位 UI（中心卡+5 材料槽，§3.2），融合动画为程序内占位特效（`playFusionAnim`），后续接入 `vfx-editor` 专门制作的资源即可替换，改动局部在 `feed.ts` 内。新增 `test/ui/cardFusePanel.ui.ts`（取代 `cardFeedPaging.ui.ts`，覆盖候选分组过滤/填槽/撤槽/Confirm 门控/滚动状态 8 用例）+ `fuseBtnWidth.ui.ts`（取代 `feedBtnWidth.ui.ts`，三语言按钮宽度自适应）；`vitest.ui.config.ts` 补 `@nw/shared/cards` 别名（`cardDefs.ts` 现在从这里导入常量）。验证：server `shared`(30 文件/595 测试)+`metaserver`(47 文件/632 测试) 全绿；client `tsc --noEmit`+`typecheck`(test 层)+`vitest run`(105 文件/737 测试)+`test:ui`(72 文件/658 测试) 全绿；webpack 生产构建成功。 |
| **CC-12 标准池抽卡未真正发到花名册 + shopBuy 同类 bug 修复** | ✅ 2026-07-15 | 玩家反馈抽到的角色卡（如 `suyuan`）在 Hero Roster 里完全不显示。根因：`gachaDraw`（`service/economy.ts`）从未调用 CC-5 建立的按类型分发逻辑（materials/equipmentInv/cardInv/skins），而是把所有抽奖结果无差别塞进 `inventory.skins`——CC-5 落地时只接进了 `deliverOrder`（shop/mail/reconcile 复用），gachaDraw 走的是一条独立的、更早的「纯皮肤」代码路径，两条路径此后没有同步。修复：把 `deliverOrder` 的战利品分类逻辑抽成共享函数 `deliverLootBox`（`economy.ts`），`gachaDraw` 改为调用它（保留原有的 `orderDelivered` fire-and-forget 延迟优化）。审计同类问题时又发现 `shopBuy`（商城直购 handler）同样从未按 `SHOP_ITEMS.kind` 路由——`protect_enhance`（kind='item'，装备强化保护道具）被当皮肤存进 `inventory.skins`，从未真正写入其消费点读取的 `inventory.items`；连带发现**reconciliation 路径本身也有同一缺陷**（`deliverOrder` 的 shop 分支按 itemId 正则/装备表猜测类型而非查目录 `kind`，`protect_enhance` 同样被猜成皮肤，是死代码从未生效）——一并改为 `findShopItem(itemId)?.kind` 查目录。审计过程顺带发现并修复一个 schema 截断类 bug（与历史 `subscriptionLastClaimDay` 同类）：`claimBattlePass` 响应 openapi schema 漏了 `reward.id` 字段，服务端算对了但被 ajv 响应校验静默丢弃（客户端目前不读该字段，未造成可见问题，仍按同类修复补上）。**生产数据修复**：脚本化扫描 `inventory.skins` 里误存的角色卡 id / `protect_enhance`，dry-run 确认后对 3 个真实账号执行了一次性补发迁移（角色卡→`cardInv`、`protect_enhance`→`inventory.items`，从 `skins` 移除；因原 bug 用 Set 去重、无法还原真实抽卡/购买次数，卡/道具补发按「每种 id 补 1 份」保守处理）。新增/补全测试：`economy.e2e.test.ts`（gacha 卡/shop item 两个回归用例）、`retention.e2e.test.ts`（签到 day-4 材料/day-14 卡/day-30 装备三个里程碑首次覆盖真实 claim 端点，此前只测过 schema）、`battlepass.e2e.test.ts`（全新文件，`/battlepass/buy`+`/claim` 此前零测试覆盖）、`mail-claim.e2e.test.ts`（补 coins/item/material/skin 四种附件类型混合场景）。全量回归：metaserver 45 个测试文件/566 个测试、shared 29/574 个测试全绿。 |

> **收尾**（2026-07-01）：任务期间遗留的 `gateway`/`gameserver` 两条 `tsc --noEmit` 报错（`Cannot find module '@bufbuild/protobuf/wire'`）经排查与角色卡任务无关——`server/node_modules` 缺失 `@bufbuild/protobuf`（package-lock.json 已声明但磁盘未装，node_modules 陈旧），`server/` 下 `npm install` 重装后两包 `tsc --noEmit` 转绿，无源码改动。

> **CI 修复**（2026-07-01）：CC-4/CC-5 改了 `openapi-world.yml`（新增 `distributeTroops`/`recoverCard` 路由、`cardState`/`baseTroopStock` 响应字段、`cardInstanceId`/`itemType: card` 枚举）但未重新生成 `worldsvc/src/generated/routes.gen.ts`，导致 `gen:api:world:check` 失败。跑 `npm run gen:api:world`（47 operations）重生成即修复。生成物勿手改，改契约后必跑一次生成。

> **测试类型漂移清理 + CI 类型检查**（2026-07-01）：CC-1 把 `GameConfig.unitLevels`→`cardInstances`、`JudgeRequest` 加必填 `unitLevels`，但 `client/test` 从不被类型检查（`tsconfig.json` include 只有 `src/**`，vitest 走 esbuild），旧形状运行期侥幸通过。迁移的 test：`diag.test.ts`/`difficultySim.ts`（`progressionUnitLevels`→`progressionCards`，走 `cardHelpers.card()`）、`siege.test.ts`+`pve-judge.test.ts`（`JudgeRequest` 补 `unitLevels`/`defenseJson`）、`hardwall.test.ts`（`players` tuple 类型）。顺带清了同层历史漂移（`HeadlessAppViews` 补 `showTitles/showDaily/showEvents/showCity`、`stateReplay`/`judge-runner`/`scenes.ui`/`net-input-source`/`saveData`）。**根治**：新增 `client/tsconfig.test.json` + `npm run typecheck`，CI `build-test` job 单测前跑，test 层漂移从此编译期红。详见 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md) 静态类型检查节。
