# Notebook Wars — 角色卡系统设计（CHARACTER_CARDS_DESIGN）

> 创建：2026-07-01。本文是角色卡**实例系统**的设计基准，取代 `CHARACTER_DESIGN.md` 中的养成/获取章节（角色外观与机制定义仍见 `CHARACTER_DESIGN.md`）。
> 配套阅读：`EQUIPMENT_DESIGN.md`（装备词条/强化）、`SLG_DESIGN.md §16`（布阵/队伍）、`ECONOMY_NUMBERS.md §15`（数值权威）、`GACHA_DESIGN.md`（卡池）。
> 拍板日期：2026-07-01。

---

## 0. TL;DR

- **角色卡是独立实例**（Hero Roster）：每张卡有唯一 ID、独立等级（0–9）、独立装备槽（3 槽）。
- **同种卡可拥有多张**：3 张陈守可同时上阵，各自装备不同。
- **等级靠喂卡**：喂同阵营卡涨 XP，70% 效率，×5 指数曲线，9 级需 ~48 万 XP。
- **兵力 = 卡的 HP**：每张卡有带兵上限（随等级增长），出战分配兵力，结算存活率按残存比例计算。
- **受伤规则**：卡的 HP 在战斗中归零 → 该卡受伤（5 分钟）→ 所在队伍整队锁定不可出战。
- **背包上限 150 张**，独立于装备背包（300 件）。
- **PvP 永不读卡实例**（`buildPvpBlueprints` 硬墙不动）。

---

## 1. 核心决策（已拍板 2026-07-01）

| # | 决策 | 理由 |
|---|---|---|
| CC1 | 角色卡为**独立实例**，不共享等级/装备 | 资源分配策略深度；玩家可集中培养或广泛培养 |
| CC2 | 同种卡可**同时上阵**，无重复限制 | SLG 最多 12 张/队，满足"10 个陈守"的极端策略 |
| CC3 | 喂卡升级，**同阵营**任意卡可喂，70% 效率损耗 | 阵营内流通；损耗防止无限套娃 |
| CC4 | **锁定卡不可被喂**；上阵卡可换装备但不可被喂 | 防误操作；上阵仍可调整养成 |
| CC5 | 兵力 = 血量，结算存活率 = f(残存 HP 比例) | 胜利损耗小、惨胜损耗大，激励高效作战 |
| CC6 | 卡的 HP 在战斗中**归零 → 该卡受伤**（5 分钟冷却）→ 所在队伍整队锁定；与胜负无关 | 惩罚源于真实战损，不是输赢本身 |
| CC7 | 卡背包**硬上限 150 张**，不扩容，满了无法获得新卡（gacha 退回） | 防无限囤积；促流通（喂卡/拍卖） |
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
  level: number        // 0–9
  xp: number           // 当前等级内已积累 XP（升级后清零）
  gear: GearSlotMap    // { weapon?, armor?, trinket? } → equipInstanceId
  locked: boolean      // 锁定后不可被喂
  // ⚠️ currentTroops / injuredUntil 不在此处——SLG 运行态存 worldsvc（见 §8.4）
}
```

### 2.3 SaveData 变更（SAVE_VERSION 4）

```ts
// 移除：
//   unitLevels: Record<UnitType, number>
//   gear: GearLoadout（global/byUnit 结构）
// 新增：
cardInv: Record<string, CardInstance>  // key = CardInstance.id，上限 150
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

## 3. 升级系统

### 3.1 XP 曲线

| 目标等级 | 单次升级 XP | 累计 XP |
|---|---|---|
| 1→2 | 5 | 5 |
| 2→3 | 25 | 30 |
| 3→4 | 125 | 155 |
| 4→5 | 625 | 780 |
| 5→6 | 3 125 | 3 905 |
| 6→7 | 15 625 | 19 530 |
| 7→8 | 78 125 | 97 655 |
| 8→9 | 390 625 | 488 280 |

> 公式：`cost(n→n+1) = 5^n`。9 级满级累计约 48.8 万 XP。数值最终以 `ECONOMY_NUMBERS §15` 为准。

### 3.2 喂卡规则

- **素材来源**：任意**同阵营**卡实例（tao → tao，anna → anna）
- **效率**：70%（喂 1 级卡 = 1 × 0.7 = 0.7 XP；喂 3 级卡 = 30 × 0.7 = 21 XP）
- **限制**：
  - `locked = true` 的卡不可被喂出
  - 当前在队伍中上阵的卡不可被喂出
  - 被喂的目标卡需先**手动卸下装备**（系统不自动卸）
- **XP 显示**：UI 只显示升级进度条，不直接暴露 XP 数字给玩家

### 3.3 喂卡 XP 换算

一张卡的"喂出价值" = 该卡升级到当前等级的**累计 XP 成本 + 当前 xp 字段值**。

```
feedXp(card) = levelCumulativeXp[card.level] + card.xp
receiverXp  += feedXp(card) × 0.7
```

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

- 抽卡时若 `cardInvCount >= 150`：**抽卡照常**，但卡转换为等值材料/coin 补偿，不入背包
- 章节通关奖励：同上，转材料
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

---

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
- 默认排序：战力降序 → 等级降序
- **图标卡网格**（2026-07-03 起，不再用整行列表）：网格左起点为 `marginLineX(w) + CELL_GAP`（图标卡起点右移到红边线右侧，与 `EquipmentScene` 一致），按缩减后的可用宽自动算列数（目标 ~480px/格 → 横屏约 3-4 列），每格约 177px 高（2026-07-06：与 `EquipmentScene` 的装备/材料图标卡统一尺寸，并整体放大 1.5x，此前为 360px/118px）。卡片布局＝**顶部名字**（+阵营点，过长自动缩放）／**左侧兵种立绘**（`UNIT_ART_URLS[unitType]`，贴图异步加载后自动重绘）／**右侧竖排属性**（`Lv.`、战力分、兵力 `cur/cap`、出战·负伤状态）／右下角三装备槽圆点，右上角锁定图标。边框色编码：负伤=红、出战=蓝
  - **卡高再放大 1.5x（2026-07-14）**：`CARD_CELL_H` 177 → 266（=177×1.5），让全高兵种立绘有更多纵向空间、更耐看。此处**不再**与 `EquipmentScene` 的 `EQUIP_CELL_H`（仍 177）统一——角色卡带立绘、装备格只有小图标，故意分开。宽度不变（仍窄，保持花名册密度）
- 背包容量计数：`已有 / 150`，逼近时（>140）高亮提示

### 10.2 卡详情 Modal

- 基础属性（按等级展示）、技能描述（含当前等级效果值）、带兵上限
- 装备 3 槽（点击进装备选择流）——**点某一槽直接跳到该槽对应的筛选页签**（武器/护具/饰品），而非停在「全部」（2026-07-14）：被点的 `slot` 经 `openEquipment(cardId, slot)` → `goEquipment(...,initialFilterSlot)` → `EquipmentScene` 构造时播种 `filterSlot`。不带 slot（如从大厅装备背包入口）仍默认「全部」
- 喂卡入口（被选中的卡被消耗，进度条显示升级进度）
- 锁定/解锁切换
- 挂拍卖行（需先卸下所有装备）
- **视觉化改版（2026-07-05）**：原纯文字布局改为「左侧兵种立绘（96×96，与网格同一张图）＋右侧属性列」；装备 3 槽从纯文字 `+N` 改为实际图标（`equipmentAtlas` 的 AI 位图，未加载时回退 `equipmentGlyph` 程序化图形，按 rarity 着色；空槽以 30% 透明度提示槽位类型）；modal 高度改为按内容动态计算，不再固定尺寸留白

### 10.3 受伤状态

- 卡面显示红色受伤遮罩 + 倒计时
- 花 coin 立即恢复按钮（价格见 `ECONOMY_NUMBERS §15`）
- 受伤期间不可被拖入布阵编辑器

### 10.4 皮肤 + 背景故事 + 全卡图鉴（2026-07-13，LOBBY_IA_REDESIGN §15 / ADR-038）

废弃 `CollectionScene`（纯图鉴+衣柜页，功能与养成/生涯页重复度低但布局/风格自成一套），拆解并入既有页面：

- **卡详情 Modal 新增翻转**：点击卡面立绘播放翻转动画（scaleX 1→0→1 的挤压翻转，中点切换正反面内容，`CardScene/detail.ts` 的 `flipDetailPortrait`/`drawDetailFace`），背面展示背景故事文案（新 i18n 字段 `card.<defId>.lore`，与既有 `card.<defId>.desc`——**技能效果说明**——是两个不同槏位，不能共用）。再次点击翻回卡图。
- **换皮肤入口在卡详情**：卡面右下角出现"更换皮肤"角标（仅当该角色有 ≥1 张已拥有的皮肤，`skinsForUnitType()` 非空时才显示），点击弹出可穿戴皮肤选择弹层；确认后该卡的立绘换成皮肤形象展示（皮肤实际美术资源仍未产出——见 `render/UnitView.ts` "Art-blocked"——本次只接好数据/UI 管线）。
- **养成页新增「皮肤」侧栏页签**：`[卡背包|装备|皮肤]`（`CardScene/skins.ts`），按角色分区展示默认外观 + 已拥有皮肤，点击直接装备（客户端同步字段写入，不需要联网，见 §2.3 SAVE_VERSION 5）。
- **全卡图鉴移入生涯组**：新场景 `CardCodexScene`，作为生涯（Career）hub 第 4 个侧栏页签 `[生涯统计|称号|成就|图鉴]`（`CareerTabs.ts`），展示 `CARD_DEFINITIONS` 全池，未拥有角色（`getOwnedUnitTypes()` 判定，无对应 Hero Roster 实例）灰显+锁图标；建筑/法术类卡没有"拥有"概念，恒不锁。
- **离线兜底改为读本地缓存**：原 `CollectionScene` 承担的"养成页离线兜底"角色不再需要——`CardScene` 本身已支持离线只读（喂卡/锁定/挂拍卖等服务器权威操作离线时优雅失败，读 `roster.err.offline`；换皮肤本就是本地操作，离线一样可用）。首次登录、本地无缓存的新玩家展示空态视为正常。

---

## 11. 拍卖行扩展

- 新增 `listingType: 'card'`，`itemId = CardInstance.id`
- 挂单前校验：`card.gear` 全空（含 weapon/armor/trinket 均为 null）
- 买家看到：卡种名称、等级、战力分（空装备状态的战力）
- 税率：10%（与装备/材料一致）
- 卡在拍卖行期间：从 `cardInv` 移入 escrow，不计入 150 上限；撤单归还

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
| `POST /cards/feed` | 新增：`{ targetId, materialIds[], idempotencyKey }` → 扣除素材，加 XP，返回新 SaveData |
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
| `server/shared/src/cards.ts` | 新文件：`CARD_DEFS`、`feedXp()`、`cardPower()`、`selectBestCard()` |
| `server/engine/src/balance/equipment.ts` | `applyEquipment` 签名改：接 `CardInstance` 而非 `GearLoadout` |
| `server/engine/src/balance/pveUpgrades.ts` | `buildSiegeBlueprints` / `buildCampaignBlueprints` 签名改 |
| `server/metaserver/src/equipment.ts` | `equipEquipment` 改 `cardInstanceId` 参数 |
| `server/metaserver/src/cards.ts` | 新文件：`feedCards()` handler |
| `server/metaserver/src/service.ts` | 新路由 `/cards/feed`；装备穿戴路由参数更新 |
| `server/worldsvc/src/db.ts` | `ArmyEntry` 改 `cardInstanceId`；`CardInjuryDoc` 结算写入 |
| `server/worldsvc/src/siegeEngine.ts` | `buildSiegeBattle` 读 `cardInv` 推导兵种+装备 |
| `server/contracts/openapi.yml` | 新增 Card schema；更新 equip/team 路由 |

### 客户端

| 文件 | 变更 |
|---|---|
| `client/src/game/meta/SaveData.ts` | 同步类型变更 |
| `client/src/game/meta/cardDefs.ts` | 新文件：客户端镜像 CARD_DEFS（同 equipmentDefs 纪律） |
| `client/src/scenes/CardScene.ts` | 新文件：卡背包 UI（列表+详情+喂卡） |
| `client/src/scenes/EquipmentScene.ts` | 穿卸装备改接 `cardInstanceId` |
| `client/src/scenes/TeamsScene.ts` | 布阵调色板从兵种列表改为卡花名册 |
| `client/src/net/ApiClient.ts` | 新增 `feedCards()`；更新 `equip()` 签名 |
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

> **收尾**（2026-07-01）：任务期间遗留的 `gateway`/`gameserver` 两条 `tsc --noEmit` 报错（`Cannot find module '@bufbuild/protobuf/wire'`）经排查与角色卡任务无关——`server/node_modules` 缺失 `@bufbuild/protobuf`（package-lock.json 已声明但磁盘未装，node_modules 陈旧），`server/` 下 `npm install` 重装后两包 `tsc --noEmit` 转绿，无源码改动。

> **CI 修复**（2026-07-01）：CC-4/CC-5 改了 `openapi-world.yml`（新增 `distributeTroops`/`recoverCard` 路由、`cardState`/`baseTroopStock` 响应字段、`cardInstanceId`/`itemType: card` 枚举）但未重新生成 `worldsvc/src/generated/routes.gen.ts`，导致 `gen:api:world:check` 失败。跑 `npm run gen:api:world`（47 operations）重生成即修复。生成物勿手改，改契约后必跑一次生成。

> **测试类型漂移清理 + CI 类型检查**（2026-07-01）：CC-1 把 `GameConfig.unitLevels`→`cardInstances`、`JudgeRequest` 加必填 `unitLevels`，但 `client/test` 从不被类型检查（`tsconfig.json` include 只有 `src/**`，vitest 走 esbuild），旧形状运行期侥幸通过。迁移的 test：`diag.test.ts`/`difficultySim.ts`（`progressionUnitLevels`→`progressionCards`，走 `cardHelpers.card()`）、`siege.test.ts`+`pve-judge.test.ts`（`JudgeRequest` 补 `unitLevels`/`defenseJson`）、`hardwall.test.ts`（`players` tuple 类型）。顺带清了同层历史漂移（`HeadlessAppViews` 补 `showTitles/showDaily/showEvents/showCity`、`stateReplay`/`judge-runner`/`scenes.ui`/`net-input-source`/`saveData`）。**根治**：新增 `client/tsconfig.test.json` + `npm run typecheck`，CI `build-test` job 单测前跑，test 层漂移从此编译期红。详见 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md) 静态类型检查节。
