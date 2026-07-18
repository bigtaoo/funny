# 装备系统设计 — Equipment

> 状态：E0 数据模型 ✅ + E1 引擎注入 ✅ + E2 合成 ✅ + E2.5 拍卖托管转移 ✅（解锁拍卖行 A）+ E3 强化/分解 ✅ + E4 穿戴 ✅（2026-06-21）+ E5 客户端 UI ✅（2026-06-22）+ E6 词条/洗练 ✅（2026-06-22）+ E7 抽卡/保护道具 ✅（2026-06-22）+ E8 SLG 接入 ✅（2026-06-22）· 权威：**本文（装备系统机制单一来源）**；数值见 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §5（数字权威）、战斗运行值见 `@nw/engine` config.ts · 更新：2026-06-22

本文是装备子系统的**机制设计基准**：数据模型、槽位、获取/强化/洗练、稀有度、战力挂钩、引擎注入、服务器权威、UI、经济联动、实现拆解。
**数字不在本文定**——成功率/成本/掉率等去 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §5；本文只镜像并标注权威指针。

---

## 0. 一句话定位

装备是 **PvE 的主成长曲线 + 最深氪点**，叙事上是「用**文具材料**合成、画到角色身上的装束」。
它**只在 PvE（现在）+ SLG（将来）说话**，**永不进天梯 / 知己 PvP**（公平电竞红线）。

---

## 1. 设计铁律（不可违背）

| # | 铁律 | 出处 |
|---|---|---|
| L1 | **公平红线**：装备战力只作用于 PvE + SLG；天梯/知己 PvP 永走 `buildPvpBlueprints()`（签名无养成参，编译期不可串味，硬墙单测守护）。 | ECONOMY_BALANCE §5、SLG7、`pveUpgrades.ts` |
| L2 | **服务器权威**：装备影响 SLG PvP（真钱相邻），全链路（拥有/强化/洗练/穿戴生效）服务器权威，客户端只读/只发意图。复用 PVE_INTEGRITY 方案 B。 | SLG_DESIGN §6.3、PVE_INTEGRITY_PLAN |
| L3 | **PvE+SLG 同一棵养成树**：PvE 攒的装备直接是 SLG 战力，PvE 是 SLG 的免费 on-ramp。SLG 不另造装备体系。 | SLG7/SLG8 |
| L4 | **有限回收**（[ADR-012](DECISIONS.md) 取代旧"无销毁渠道"）：强化失败不掉级、不碎；**装备可分解回收 70% 打造材料**（强化投入不返还），但**+5 及以上不可分解**（已具价值，出口转拍卖/穿戴）。低级冗余件有回收阀治理膨胀；金币/材料 sink 仍主要来自"反复强化的失败损耗"。 | §6.3、ECONOMY_NUMBERS §5.1 / §5.3、ADR-009 / ADR-012 |
| L5 | **数值活在代码/数字文档**：本文不复述具体数字，引用 ECONOMY_NUMBERS §5 与 config.ts。 | README §0 三铁律 |

---

## 2. 叙事外壳（文具皮，diegetic）

> 美术口径权威：[`design/product/art-direction.md`](../product/art-direction.md) §9.2。

- **材料 = 文具**：铅笔 / 橡皮 / 尺子 / 订书钉 / 回形针 / 胶带…（数据上复用 PvE 材料 `scrap / lead / binding`，见 §5.4）。
- **合成 = 把装备"画"到角色身上**（叙事隐喻）：视觉上装备以独立 AI 图标展示于背包/loadout UI，不再叠加到角色骨骼（§20.4 已移除，角色本身有武器立绘）。
- **稀有度映射媒材**（与皮肤共用同一套文具稀有度语言）：

  | 稀有度 | 媒材皮 | 词条数（细化见 §7.2） | 体感 |
  |---|---|---|---|
  | 普通 Common | 铅笔（灰） | 1 | 关卡常掉 |
  | 精良 Fine | 钢笔（绿） | 1–2 | 中期 |
  | 稀有 Rare | 马克笔（蓝） | 3 | 后期/Boss |
  | 史诗 Epic | 荧光笔 / 烫金（紫） | 3 + 特技 | 极稀有，鲸鱼向 |

  > 稀有度色改为灰→绿→蓝→紫的递进序（2026-07-06，见下方"稀有度配色+图标卡走查修复"）：此前 rare 用橙、epic 用紫，橙比紫更抓眼，读起来 rare 反而比 epic 更"高级"，与稀有度顺序相悖。具体取值见 `client/src/scenes/EquipmentScene/base.ts` 的 `RARITY_COLOR`，本文不写死。

  > 注：**抽卡结果卡的展示稀有度另有一套映射**（有意的 jackpot 展示），装备 epic 在抽卡里展示为 legendary 金——见 `GACHA_DESIGN.md` §9.5 物品目录 / §11.2 展示稀有度映射（装备 fine→rare、rare→epic、epic→legendary）。此处装备系统本身的稀有度色（epic=紫）不受影响，两者并行，勿混淆。

数值骨架（§6 的 9 级强化）与外壳解耦：文具只是它的"皮"。

---

## 3. 数据模型

### 3.1 存档结构（现状 + 演进）

当前 `SaveData.equipped: Record<string, string>`（`server/shared/src/types.ts:45`）。
为承载实例化装备（强化等级 / 词条 / 稀有度），需扩展为「**库存 + 穿戴**」两段：

```ts
// 新增：装备实例库存（服务器权威段，PUT /save 不可写，仅 /equipment/* 写）
equipmentInv: Record<string, EquipmentInstance>;   // instanceId → 实例

interface EquipmentInstance {
  id: string;          // 实例 id（服务器生成）
  defId: string;       // 装备定义 id（决定基础属性/槽位/媒材）
  rarity: Rarity;      // common | fine | rare | epic
  level: number;       // 强化等级 0..9
  affixes: Affix[];    // 词条（洗练可改）
  locked?: boolean;    // 防误用为强化燃料
}

// 穿戴：从「全局 loadout」起步，结构预留「按兵种独立装备」
equipped: {
  global?: SlotMap;                       // 阶段一：全军共享 loadout
  byUnit?: Partial<Record<UnitType, SlotMap>>;  // 阶段二/SLG：按兵种
};
type SlotMap = Partial<Record<EquipSlot, string /*instanceId*/>>;
```

- **`defId` 锁定三件事**：槽位 + 稀有度 + 媒材皮（见 §17 定义表）。**稀有度不可洗、不可升**——想要更高稀有度只能从更高级来源获得另一件 `defId`（强化只在同一件内升 +级）。实例上的 `rarity` 字段是 `defId` 的去规范化缓存，便于查询/排序。
- **迁移**：现 `equipped: Record<string,string>` 视为空 `{}`（无人在用，见 `makeNewSave`），直接换结构，`SAVE_VERSION` +1 带迁移。
- **`SyncPatch` 收窄**：装备实例段**移出** `PUT /save` 可写范围，全部由 `/equipment/*` 服务器权威端点写（与 progress/materials/pveUpgrades 同 §L2）。`PUT /save` 仅留 `flags`（穿戴意图也走专用端点，防客户端伪造战力）。

### 3.2 槽位

每套 loadout 三槽（ADR-009）：

| 槽位 `EquipSlot` | 文具隐喻 | 主属性方向 |
|---|---|---|
| `weapon` 武器 | 笔（攻击媒介） | 攻击 |
| `armor` 护具 | 封皮/书套 | 生命/护甲 |
| `trinket` 饰品 | 书签/贴纸 | 速度/特技 |

> 阶段一：`global` 一套（影响全军，轻量、美术少）。阶段二 / SLG：`byUnit` 每兵种一套（深度 + SLG 用）。结构已在 §3.1 预留。

### 3.3 库存管理（膨胀治理 + 容量上限）

合成/掉落持续产出 + 高级件不可分解（§6.3）→ 实例会增长，必须硬性治理存档体积：

- **重复件堆叠**：**0 级、无副词条**的同 `defId` 装备**按数量堆叠**（存 `Record<defId, count>`，不开实例 id），只有"被强化过 / 已 roll 副词条 / 已穿戴 / `locked`"的才升格为独立 `EquipmentInstance`。绝大多数低级重复件走堆叠，不占实例槽。
- **背包容量硬上限 = 300 独立实例**（[ADR-012](DECISIONS.md)，DRAFT [可调]）。堆叠件**不计入**。逼近上限时提示，引导拿低级件去**分解（§6.3）/ 强化燃料 / 洗练燃料**消耗（这也是 §6/§7.8 sink 的需求侧）。满仓时**禁止再获得新实例**（掉落转为材料补偿，见 §4）。
- **穿戴单独计、不占 300**：被穿戴的实例存在 `equipped`，不计入 300 库存上限。但**穿戴数不另设 1000 之类的大上限**——它**结构性自限 = 3 槽 × loadout 套数**（global 阶段最多 3；byUnit 阶段 = 3 × 兵种数），远低于任何人为上限。⚠️ **堵漏洞**：穿戴既不计库存，就不能成为"靠给一堆兵穿戴囤货"的后门——穿戴上限恒等于槽位结构，多余装备无处可穿，只能留库存（受 300 约束）或走分解/拍卖出口。
- **存储落点**：v1 把 `equipmentInv` 内嵌进 SaveData 文档（300 实例 × ~150B ≈ 45KB，可接受）；若实测膨胀，迁独立集合 `equipment`（`accountId + instanceId` 索引），见 §18。

### 3.4 穿戴规则

- **战斗中锁定**：进入关卡/围攻后 loadout 冻结，结算前不可换装（防中途调参数）。
- **战斗外自由换**：大厅内换装免费、即时（纯状态，走 `/equipment/equip`，§18）。
- **穿戴即占用**：被穿戴的实例标记占用，不能同时作强化/洗练燃料（与 `locked` 同效）。

---

## 4. 获取渠道（faucet）

> **解锁时机（DRAFT [可调]）**：装备系统在战役**第 2 章**开放（首章作纯玩法教学，不引入养成），开放时给一段强制引导（合成首件 → 穿戴 → 试打一关）。早期关卡用地板战力即可通（§8），装备从中期才成为门槛——解锁点须早于"无装备打不动"的关卡。最终章节号待战役节奏定（§15）。


> **获取口径（[ADR-012](DECISIONS.md)）= 材料为主、打造为骨干 + 低概率直掉成品做"彩头"**。常规掉落主体是**文具材料**（叠加、不爆仓，配合 §3.3 的 300 实例上限）；成品装备主要靠**玩家合成**（确定性、想要啥造啥、无垃圾词条堆积）。仅 **Boss/精英/后期关**保留**低概率直掉一件成品**当 jackpot 爽点——频率压低，实例增量可控，偶发的垃圾件用分解（§6.3）清掉。纯"满地掉装备"会和库存上限 + 仓鼠苦役正面打架，故弃。

| 渠道 | 产出 | 门控 | 权威 |
|---|---|---|---|
| 关卡掉落 | **文具材料为主** + **低概率成品装备**（Boss/精英/后期关） | 体力 / 每日次数 | 服务器 `pveRewards` |
| **合成 / 锻造（主成品来源）** | 用文具材料造**基础装备**（见下） | 材料 | 服务器 `/equipment/craft` |
| 抽卡 | 材料为主 + 装备成品低概率彩头（**与皮肤共池**，ADR-017） | coins / 充值 | commercial + meta |
| 拍卖行（SLG） | 玩家挂单的材料/装备 | coins，10% 税 | worldsvc |

> **满仓补偿**：库存达 300 实例上限（§3.3）时，本应直掉的成品装备**转为等值材料补偿**发放（材料走 999 堆叠，不受实例上限约束），不凭空丢失奖励。

> ⚠️ **口径取代（[ADR-010](DECISIONS.md)，2026-06-21）**：旧稿（ECONOMY_BALANCE §5.5 / META_DESIGN §11.4）把「9 级」定义为**5 个同种装备确定性合成升级**，已作废。本文据 ADR-009/ADR-010：
> - **合成（craft）= 获得渠道**：文具材料 → 一件 **0 级基础装备**（确定性，配方/成本见 ECONOMY_NUMBERS §5，对齐"一件=5 铅笔+1 橡皮"的体感）。
> - **升级一律走 §6 概率强化**，不再用"5 件吃 1 件"的确定性合成做升级。
> 两处旧稿（ECONOMY_BALANCE §5.5 / META_DESIGN §11.4）已加指针指向本文与 ADR-010。

---

## 5. 材料（文具）

复用既有 PvE 养成材料，**不另造装备货币**（SLG8 口径）：

| 材料 id | 文具 | 档位 | 主来源 |
|---|---|---|---|
| `scrap` 碎屑 | 铅笔屑/橡皮 | 低 | 关卡常掉 |
| `lead` 铅芯 | 笔芯 | 中 | 中期关 |
| `binding` 装订线 | 订书钉/线 | 高（稀有） | Boss/后期 |

材料同时是单位升级（`PVE_UPGRADE_DEFS`）与装备合成/强化的共用燃料，PvE↔SLG 统一流转、可上拍卖行（赛季资源粮/铁/木**不可**上拍卖）。

---

## 6. 强化系统（核心 sink，可失败）

> 成功率/成本表权威：[`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §5.2。下表为**镜像**。

### 6.1 机制

- 强化等级 **+1 → +9**（与单位卡同深度，但走**概率**，区别于单位合成 100%）。
- 每次强化消耗**材料 + 金币**。
- **成功率每往上一级降 10%**：

  | 升级 | +1 | +2 | +3 | +4 | +5 | +6 | +7 | +8 | +9 |
  |---|---|---|---|---|---|---|---|---|---|
  | 成功率 | 90%* | 80% | 70% | 60% | 50% | 40% | 30% | 20% | **10%** |

  > \* 起点档以 ECONOMY_NUMBERS §5.2 为准（该表从 +1→+2 起列 80%…10%）；本文不锁死起点，调参时只动这一行、不动机制。
- **失败后果（俗套温和档）**：**不掉级、不碎**，只损耗本次材料/金币（强化失败不毁装备；分解才是唯一销毁口，见 §6.3 / L4）。
- **+8→9 仅 10%** → 平均 ~10 次/级；整套 3 件 +9 ≈ **鲸鱼级**稀有（"几万人里一个"）。

### 6.2 sink 逻辑

金币/材料的主 sink **靠高级低成功率的持续失败损耗**维持（§L4）。辅以：
- **保护道具**（氪点）：强化失败保底/不损材料 —— 大 R 向，**只 PvE/SLG**，不碰公平 PvP。
- **分解回收**（§6.3）：低级冗余件回收，兼作库存阀；70% 返还 → 30% 损耗本身也是温和 sink。

### 6.3 分解回收 Salvage（[ADR-012](DECISIONS.md)）

库存治理（§3.3）+ 温和 sink 的回收口，**取代旧"无销毁渠道"**：

| 规则 | 值 | 说明 |
|---|---|---|
| **返还** | **70% 打造材料** | 只返还该 `defId` **打造基础成本**的材料；**强化投入的材料/金币不返还**（强化失败损耗是核心 sink，不能靠分解漏回） |
| **等级门槛** | **+5 及以上不可分解** | +5 起已具价值，作为一种保护；出口转为**拍卖 / 穿戴**（§13） |
| **可分解范围** | +0 ~ +4 | 含堆叠的 0 级冗余件（堆叠件可直接批量分解） |
| **权威** | 服务器 `/equipment/salvage` | 扣实例、入材料，服务器权威（§10） |

- **30% 损耗**是设计的：分解不是无损循环，避免"造了分、分了造"刷材料；它的主职是**清库存**，sink 是副产物。
- 与"满仓禁获得"（§3.3）配合：玩家撞 300 上限时，分解 +0~+4 冗余件腾位，或拿去强化燃料/拍卖。
- +5 以上想清掉只能**上拍卖**（§13，受同时挂拍上限约束）——给高投入件一个**有偿出口**而非销毁。

---

## 7. 词条池（Affix）与洗练

> 命名：装备触发效果叫 **特技**；与**单位养成特性（trait，T3 暴击/T6 吸血/T9 +1出兵，ADR-009）**、**里程碑（成就系统专用词）** 三者互不撞。
> 数字（各档区间/权重）权威 = ECONOMY_NUMBERS §5；本文定**结构与池子构成**，数值列 **DRAFT [可调]**。

### 7.1 三层词条模型

| 层 | 每件数量 | 来源 | 随强化变化 | 洗练可改 |
|---|---|---|---|---|
| **主词条** | 恒 1 条 | 槽位锁定（§7.4） | **是**（唯一随 +1→9 确定性放大） | 否 |
| **副词条** | 0~2 条（按稀有度） | 开出时随机（§7.5） | 否（固定在 roll 值） | **是** |
| **特技** | 0 或 1 条（仅史诗） | 触发型 proc（§7.6） | 否 | **是** |

- 设计意图：**强化 = 平民变强线**（放大主词条，可失败，§6）；**洗练 = 大 R 赌词条线**（重洗副+特技，§7.7）。两条线目的不重叠。
- **所有词条只在 PvE + SLG 蓝图生效**（经 §9 `applyEquipment` 注入），天梯/知己 PvP 永不读（L1）。

### 7.2 稀有度 → 词条数（细化 §2 表，本节为准）

| 稀有度 | 主 | 副 | 特技 | 合计 |
|---|---|---|---|---|
| 普通 Common | 1 | 0 | — | 1 |
| 精良 Fine | 1 | 0~1 | — | 1~2 |
| 稀有 Rare | 1 | 2 | — | 3 |
| 史诗 Epic | 1 | 2 | 1 | 3 + 特技 |

> 高稀有 = 更多副词条槽 + 更高 roll 上限 + 解锁特技。普通/精良不开洗练（不值当）。

### 7.3 强化如何放大主词条

- 主词条最终值 = `base × (1 + 强化系数 × 强化等级)`，每次**成功**强化 +1 级（失败不变，§6）。
- DRAFT：强化系数 ≈ **0.10/级** → +9 ≈ `base × 1.9`（约翻倍）。系数权威见 ECONOMY_NUMBERS §5。
- 副词条/特技**不随强化变**——只有洗练能改它们。

### 7.4 主词条池（按槽位，映射引擎字段）

| 槽位 | 主词条候选（开出时定 1 个） | 引擎字段 | 算法 |
|---|---|---|---|
| 武器 weapon | 攻击 +X% / 攻速 +X% | `attack` / `attackInterval` | 乘算 |
| 护具 armor | 生命 +X% / 护甲 +N（flat） | `hp` / `armor` | 生命乘算、护甲加算 |
| 饰品 trinket | 移速 +X% / 暴击率 +X% | `speed` / `critPct` | 乘算 / 概率 |

> **暴击已落地**（B 方案）：`m_crit` 主词条 = 暴击**率**（`critPct`，0–100 概率点，随强化放大）；暴击**倍率**由副词条 `s_critmult` 提供（见 §7.5）。二者复用 ADR-009「单位养成特性 T3 暴击」的引擎机制（`critPct`/`critMult` + `CombatSystem` 确定性 `combatPrng`）。饰品开出时在「移速 / 暴击率」二候选中定 1 个（`MAIN_AFFIX_BY_SLOT`）。当单位无 T3 时，`m_crit` 会同时把暴击倍率立到 T3 基础值（1.5×），保证饰品单独也能打出有效暴击。
> 护甲为 flat 加算（引擎 `armor` 已存在，最小伤害 1），不走乘算，避免后期减伤溢出。

### 7.5 副词条池（rare/epic 才有，洗练重洗）

**战力类**（计入 §8 的 35% 战力上限）：

| 副词条 | 引擎字段 | 备注 |
|---|---|---|
| 攻击 +X% | `attack` | 乘算 |
| 攻城值 +X% | `siegeValue` | 乘算（ADR-026，`s_siege`）；只放大拆家伤害，与 attack 正交，与 §7.7 攻城值上限求和后钳 |
| 生命 +X% | `hp` | 乘算 |
| 护甲 +N | `armor` | flat |
| 移速 +X% | `speed` | 乘算 |
| 攻速 +X% | `attackInterval` | 乘算（降低间隔） |
| 吸血 +X% | `lifestealPct` | 小数值，与 trait T6 **求和后钳**（§7.7①） |
| 生命回复 +N/s | `regenPerSec` | flat |
| 暴击伤害 +X% | `critMult` | flat 加算（引擎 `value/100` 加到暴击倍率基础上）；仅在有暴击率来源（T3 / `m_crit`）时才有意义，与 §7.7 暴击倍率上限求和后钳 |

**功能类**（养成收益，**不计入战力上限**——战力预算安全阀）：

| 副词条 | 作用 | 说明 |
|---|---|---|
| 材料掉落 +X% | 关卡材料产出 | 服务器 `pveRewards` 结算时读，**不进战斗蓝图** |
| 体力返还 +X% | 通关返体力 | 同上，纯养成加速 |

> 功能类词条让"非战力史诗"也有价值，且因不进蓝图、不受 35% 上限约束 —— 给预算腾空间。

### 7.6 特技池（仅史诗，触发型 proc，洗练重洗）

DRAFT 池，全部映射到已有引擎机制或标注待扩展：

| 特技 | 效果（DRAFT） | 引擎落点 |
|---|---|---|
| 开刃 | 开战前 N 秒攻击 +X% | 定时 buff（参考 `summonOnTimer`/`berserker` 定时机制，需 proc 框架） |
| 护壁 | HP < X% 时护甲 +N | 复用 `berserkerThreshold` 的血量阈值机制 |
| 嗜血 | 击杀时回复 X% 最大生命 | 条件版 `lifestealPct`（需 on-kill proc） |
| 回响 | 出兵时 X% 概率额外 +1 兵 | 概率版 `spawnCount`（需 proc） |
| 倒刺 | 受击反弹 X% 伤害 | 需引擎反伤 proc |
| 韧命 | 首次致命一击存活于 1 HP | 复用引擎 `undying`（PvE 已有） |

见 §7.7 跨系统叠加封顶（特技与单位养成特性共存的防爆规则）。

### 7.7 跨系统叠加与封顶（防数值爆炸）⚠️

装备（主词条 + 副词条 + 特技）与**单位养成特性（trait，ADR-009：T3 暴击 / T6 吸血 / T9 +1出兵）会作用于同一批效果**。三处来源若线性相加会爆。统一规则：

**① 连续型效果 = 全来源求和后钳到全局硬上限**（不做"取大+小×0.5"那类易错的递减公式）：

| 效果 | 可能来源 | 钳制方式 | 全局硬上限（DRAFT [可调]） |
|---|---|---|---|
| 吸血% | trait T6 + 副词条「吸血」+ 特技「嗜血」 | Σ 后 clamp | ≤ 30% |
| 暴击率% | trait T3 + 饰品主词条 `m_crit` | Σ 后 clamp | ≤ 50%（引擎 `EFFECT_CAPS.critPct`） |
| 暴击倍率 | trait T3 基础 1.5× + 副词条 `s_critmult` | Σ 后 clamp | ≤ 2.5×（引擎 `EFFECT_CAPS.critMult`，DRAFT） |
| 攻击% | 主/副词条（多件） | Σ 后 clamp | ≤ +60% |
| 攻城值% | 副词条 `s_siege`（多件；主词条 `m_siege` 已登记词表，暂无主槽产出） | Σ 后 clamp | ≤ +60%（引擎 `EFFECT_CAPS.siegePct`，镜像攻击%） |
| 生命% | 主/副词条（多件） | Σ 后 clamp | ≤ +60% |
| 攻速% | 主/副词条 | Σ 后 clamp | ≤ +40% |
| 护甲（flat） | 主/副词条 + 特技「护壁」 | Σ 后 clamp | ≤ 引擎单位基础攻击的某比例（防免伤） |

> 上限数字归 ECONOMY_NUMBERS §5，且必须与**单位养成特性的数值同表管理**（trait 与装备共享同一组上限，不各管各的——这是防爆的关键）。

**② 离散/质变型效果 = 最高级一件生效，永不叠**：
- 韧命（undying）、其他"有/无"型 → 多源只取一个，不叠层。
- 同名特技多件 → 取最高，不叠（逼玩家追词条多样，而非堆同一 proc）。

**③ 概率/出兵型 = 独立机制并存，但各设触发上限**：
- trait T9「+1出兵」是**确定性**基础值；特技「回响」是**概率**额外出兵——二者机制不同可并存，但「回响」设**内置 CD + 每次出牌额外出兵数封顶**，避免和 T9 叠出整屏。
- 概率特技统一走引擎确定性随机（seed 派生），不破坏录像重播/服务器复算。

**④ 落点单一**：上述钳制在 §9 注入末尾**统一执行一次**（`applyPveUpgrades`→`applyEquipment`→`clampEffectCaps`），不散落在各 proc 里。

**⑤ 池子门控（防语义矛盾）**：装备副词条/特技池**只收数值型与 proc 型效果**，**绝不收身份关键字**（`taunt` / `stealth` / `flying` / `piercing` 这类定义单位身份、且可能与单位自带特性语义打架的 boolean）。身份关键字只由单位基础蓝图（identity 层，见 ECONOMY_NUMBERS §4.4 分类）持有，**装备永不授予**——既杜绝"给隐身单位贴嘲讽"这类自相矛盾，也守住"装备只放大、不改变单位身份"的设计边界。新增词条入池前先过这条门控。

### 7.8 洗练 Reforge（面向大 R）

- **技能槽数（ADR-017）**：每件装备最多 **2 个技能词条**——**多数 0 条、部分 1 条、极少 2 条**（稀有度越高越可能有，2 条为顶级稀有）。技能槽数随实例生成时定，洗练只重洗已有槽的内容、不改变槽数。
- **重洗对象**：副词条 + 技能词条（主词条永不变，靠强化）。
- **成本（ADR-030 深化，2026-07-03）**：每次消耗**一件低一级的同类装备**（持续吞装备的 sink，不影响免费玩家基础体验）+ **每次收基础金币**（不止 2 技能锁定费）——洗练整体做成可无限重复的**深水 coin sink**：付的是尝试次数、买不到确定结果，不破公平红线。数字落 ECONOMY_NUMBERS §5.3。⚠️ **代码缺口**：`metaserver/src/equipment.ts reforgeEquipment()` 现仅扣材料、未扣基础金币（2026-07-03 核查），落地时补上基础金币扣费。
- **门槛**：仅 rare/epic 开放（有副词条/技能才有的可洗）。
- **模式（ADR-017 已拍板）**：
  - **0 或 1 个技能**：直接全部随机重洗。
  - **2 个技能**：玩家可二选一——①**花金币锁定其中 1 条**、只重洗另一条（更贵、更可控）；②**全部随机**（更便宜）。锁定费是又一温和 coin sink。
  - 落地：洗练接口加 `lockAffixIndex?`（仅 2 技能实例可传），服务器校验槽数 + 收锁定费。

---

## 8. 战力挂钩（PvE 难度曲线绑定）

> 权重权威：ECONOMY_BALANCE §5.5.1。

| 战力来源 | 占比 | 角色 |
|---|---|---|
| 基地升级 + 卡组 + 操作 | **~65%** | 无装备玩家的"地板"，稳过早/中期关 |
| 装备（合成/强化养成） | **上限 ~35%** | 后期关"门槛"；满装 vs 无装战力差封顶 **≈ 1.5×** |

- **设计目标**：早/中期靠地板即可通；**后期关按"需大部分可得装备战力才能稳过"调**——"无装备过不了后期硬关"成立，但封顶 35% 保证不归零（打得动、过不去，不是 0 输出死局）。
- **作用对象**：阶段一挂玩家**全局 loadout**（影响全军）；`equipped.byUnit` 预留按兵种（后期深度 + SLG）。
- **鲸鱼天花板**：装备战力绝对上限 = **整套（3 槽）史诗 +9 + 满词条**，且受 §7.7 全局封顶钳制。**到顶后氪金买不到更高战力**（呼应 ECONOMY_BALANCE 鲸鱼天花板原则）——氪金只**加速到顶**，不突破天花板；天梯/知己永远归一，与天花板无关。

---

## 9. 引擎注入（红线落地）

装备加成的注入点与单位升级**同一处**，物理隔离 PvP：

```
buildPvpBlueprints()              ← 天梯/知己：无参，永不接装备（硬墙）
buildCampaignBlueprints(levels, equipped, inv)
buildSiegeBlueprints(levels, equipped, inv)
   两者 PvE/SLG 路径统一三步：
     applyPveUpgrades(bp, levels)   // 单位养成（含 trait）
     applyEquipment(bp, equipped, inv)  // 装备主/副/特技
     clampEffectCaps(bp)            // §7.7 跨系统封顶，统一执行一次
```

- 新增 **`applyEquipment(bp, equipped, equipmentInv)`**：把穿戴装备的词条以乘/加算叠到蓝图（同 `applyPveUpgrades` 的原地改风格），放在 `@nw/engine/balance/`。
- 新增 **`clampEffectCaps(bp)`**：在 trait + 装备**都叠完后**统一钳制（§7.7 ①②③）——这是防数值爆炸的唯一落点，trait 与装备共享同一组上限，不各管各。
- `buildPvpBlueprints()` **签名里永远不出现 equipped/equipmentInv** → 编译期不可能串味；扩展 `hardwall.test.ts`：满装备存档下 `buildPvpBlueprints()` 仍与 `UNIT_BLUEPRINTS` 逐字相等。
- 新增单测：**战力单调性**（装备等级↑ → campaign/siege 蓝图战力↑，SLG_DESIGN §6.2 同款）+ **封顶生效**（trait+装备三源同效果叠加后不超 §7.7 上限）。

#### E1 实现记录（2026-06-21，✅）

落地 = `server/engine/src/balance/equipment.ts`（注入逻辑）+ `pveUpgrades.ts`（三步链）+ `GameConfig.equipment`（管线）+ `client/test/equipment.test.ts`（17 项）。三条关键工程决策：

1. **engine 零依赖红线**：客户端 webpack 直接 alias 打包 `@nw/engine` **源码**，而 `@nw/shared` 依赖 mongodb/jsonwebtoken。故 `applyEquipment` **绝不 import `@nw/shared`**——用结构化等价的引擎本地输入类型（`EngineEquipmentInput` = `{ gear, inv }`）接收，调用方直接把 `SaveData.gear`/`equipmentInv` 传进来（TS 结构化子类型，多余字段无害）。词条→引擎字段映射（`AFFIX_FIELD_MAP`）+ 强化系数 + 封顶都活在本模块，是「数值活在 engine」的兑现。
2. **词条 id 命名空间判主/副**：E0 的 `EquipmentInstance.affixes` 是扁平 `Affix[]`，无主/副标记。约定用 id 前缀自描述——`m_*` 主词条（**唯一随强化等级放大**，`base × (1 + 0.1×level)`，DRAFT 系数）/ `s_*` 副词条（固定 roll 值）/ `k_*` 特技（proc 框架未落地 → 识别但 no-op）/ 未知 id 安全忽略。新增词条入 `AFFIX_FIELD_MAP` 即可，无需动实例结构。
3. **封顶两段落点**：乘算百分比（atk/hp/atkspd）的**装备贡献**在 `applyEquipment` 累加阶段钳（烘焙进绝对值后不可反算）；绝对字段（lifestealPct/armor）由 `clampEffectCaps` 在注入末尾**统一钳一次**，实现 §7.7④「trait + 装备求和后钳」的跨源语义。
   - ✅ **暴击已落地**（B 方案）：`m_crit` → `critPct`（加算、§7.7 ≤50 钳）、`s_critmult` → `critMult`（加算、≤2.5× 钳），复用 T3 引擎机制。⚠️ **仍待办**：trait 的攻速/攻击/生命增益走 TraitSystem **运行期**、不在蓝图烘焙阶段 → 乘算类的「trait+装备求和封顶」尚未完全合一；proc 框架（`k_*` 特技）仍空转（§7.6）。待与 trait 数值同表时收口（上限归 ECONOMY_NUMBERS §5）。
   - **作用范围**：与 `applyPveUpgrades` 一致，只加成玩家发牌兵种（`PLAYER_EQUIPPABLE_UNITS` = Infantry/ShieldBearer/Archer）的**共享蓝图表**；siege 攻防共用同一张表的既有语义原样保留（§9「同一处注入」），攻防分离不在 E1 扩大。`gear.byUnit` 优先于 `gear.global`（阶段二按兵种已可用）。

---

## 10. 服务器权威与反作弊（L2）

- 所有装备状态（库存/强化结果/洗练结果/穿戴）由 **meta 服务**写，复用 PVE_INTEGRITY 方案 B（权威迁服务器 + 录像抽检复算）。
- **强化的随机数服务器生成**（防客户端"重试到成功"）：`/equipment/enhance` 在服务器掷骰、扣料、落库、回执。
- SLG 围攻复算（`runSiegeJudge`）已带**攻方权威养成快照**；装备纳入该快照，客户端篡改本地穿戴改不了"这套装备能否破城"。
- 拍卖成交、跨账号流转走 worldsvc + 反 RMT 审计（SLG_DESIGN §9）。

---

## 11. 客户端 UI

> UI 规格归属：菜单/元系统 → [`UI_DESIGN.md`](UI_DESIGN.md)；配色引 art-direction。本节只列装备专属界面，细化进 UI_DESIGN。

| 界面 | 内容 |
|---|---|
| 背包 / 库存 | 实例列表，按稀有度/槽位/等级筛选，`locked` 防误用 |
| 锻造台（合成） | 文具材料 → 基础装备配方，进度/成本 |
| 强化界面 | 选目标 + 燃料，显示**当前成功率**、消耗、失败提示（不碎）、保护道具入口 |
| 洗练界面（大 R） | 重洗词条，消耗低级同类，前后对比 |
| 穿戴 / loadout | 三槽拖拽；阶段二按兵种切换 |

视觉：装备绘制走 bone slot 程序叠加（§2），换装即时反映在角色立绘。

### 11.1 入口（两条）——按卡编辑 vs 独立背包

`EquipmentScene` 有两种进入上下文，由 `activeCardInstanceId` 是否为空区分：

| 入口 | `activeCardInstanceId` | 组标签 | 顶部 loadout | 「穿戴」行为 |
|---|---|---|---|---|
| **按卡编辑**（CC-1）：养成→点卡→详情三槽 | = 该卡 id | 无（plain back） | 显示该卡三槽 | 直接装到该卡 |
| **独立背包**（LOBBY_IA）：养成 `[卡牌\|装备]` 组标签 → 装备 | `''` | `[卡牌\|装备]`（`peerTab`） | 隐藏（无单卡上下文） | 弹「选卡」子视图，选卡后装上 |

- **组标签泛化**：`EquipmentScene` 原 `openCollection`（图鉴组 `[图鉴|装备]`）泛化为 `peerTab: { labelKey, onSelect }`，图鉴组与养成组共用一套 `HubTabs`；`CardScene` 同样注入 `[卡牌|装备]` 组标签（`openEquipmentBag`）。
- **背包「选卡」子模式**（`assign`）：背包里点某件装备的「穿戴」→ 整屏**图标卡网格**（每行 5 张，窄屏自动收缩；照搬英雄名册 `CardScene/list.ts` 的卡片：满高立绘 + 阵营色点 + 名字 + 等级金星 + 战力；按战力降序，复用主 scrollY 拖动），每张卡底部显示该槽当前占用件（空槽 `Slot free` / 已装金色 `Now: <件>`），点卡即装（占用则替换，旧件回库）；卸下则回扫佩戴该件的卡。此前为一行一卡的窄列表，2026-07-18 改为网格以与角色界面统一视觉。`合成 / 洗练 / 强化 / 分解` 都无需选卡，照常在背包/详情里用。
- **术语**：现有 zh 标签把 craft 叫「锻造」、enhance 叫「强化」；产品口径的「合成 / 洗练 / 锻造(=强化+级)」与之有出入，标签对齐待定（本次未改）。

> **i18n**：装备名 / 词条 / 特技 / 稀有度 一律走 i18n key（`equip.<defId>.name`、`affix.<id>.desc`、`skill.<id>.*`），不硬编码中文（项目 i18n 纪律，见 UI_DESIGN）。

---

## 12. 经济联动

| 维度 | 内容 | 权威 |
|---|---|---|
| faucet | 关卡掉落 + 合成 + 抽卡 + 拍卖 | §4 |
| sink | 合成耗材 + **强化失败损耗（主 sink）** + 洗练吞装备 + 强化金币 + **分解 30% 损耗** | §6.2 / §6.3、ECONOMY_NUMBERS §5.3 |
| 变现点 | 抽卡、材料/体力直购加速、强化保护道具、（SLG）拍卖税/科技直购、（可选）扩挂拍位 | ECONOMY_NUMBERS §7 |
| 反通胀 | 分解回收（§6.3，+0~4，70% 返）治理低级膨胀 + 300 库存硬上限封顶；高级件靠失败损耗维持金币 sink | §L4 / §6.3 / §3.3 |

---

## 13. SLG 预留（现在就按"将来进 SLG"设计）

- 决策 **(b)**：SLG 装备战力**暂不单独做**，但 `equipmentInv` / `equipped` / `applyEquipment` 结构**现在就按能进 SLG 设计**，不写死纯 PvE。
- SLG 上线后：装备即 SLG PvP 战力（养成=付费战力），**与天梯/知己分开匹配、分开榜**（SLG_DESIGN §1/§6）。
- 赛季重置：**保**装备/材料（养成跨季留存），清赛季资源（粮/铁/木）。
- **拍卖流转**（SLG_DESIGN §9）：可挂单的装备**带完整状态**（`defId` + 强化等级 + 词条 + 特技）成交转移；赛季资源不可挂。计价 coin、10% 税。
- **同时挂拍上限 = 5 件**（[ADR-012](DECISIONS.md)，DRAFT [可调]）：单玩家同时在架的挂单数封顶 5，防刷屏/对敲/RMT 洗单 + 控 worldsvc 负载。可做**软变现杠杆**（VIP/付费扩挂拍位，仅 SLG 经济、不碰公平 PvP）。
- **挂单时效 + 流拍退回（escrow-out 模型，✅ 已落地）**：每个挂单有时效（DRAFT 24–48h）。**放弃"溢出暂存区"方案**——改为统一 escrow-out：挂单时物品即从背包移出（托管），拍卖期间背包不可见、不可用；**所有离开拍卖的物品（成交给买家 / 流拍·取消·季末退卖家）一律通过系统邮件附件下发，玩家领取附件后才回背包**。这样天然规避满仓资损（邮件即持有缓冲，领取时再入库，不突破 300 硬上限），且退回="寄存物取回"的清晰语义。装备/角色卡附件携带**完整实例快照**（词条/强化/暴击随实例走）。实现见下方 §13 实现记录。
- **反 RMT**：高价/高强化装备成交进 worldsvc 审计流（异常低价大额、对敲、新号秒收高价件），与社交/补偿同一风控面；服务器权威转移，禁止线下私下转移。

#### §13 交割/退回实现记录（2026-07-02，✅）— escrow-out + 系统邮件

放弃"溢出暂存区"，统一为 escrow-out：拍卖物品的**一切出账**（成交给买家 + 流拍/取消/季末退卖家）都经**系统邮件附件**下发，领取后入库。落地：

1. **邮件附件携带实例快照**：`@nw/shared` `MailAttachmentDoc`/`social.ts MailAttachmentView` 与 `contracts/openapi.yml MailAttachmentView` 新增 `kind: 'equipment' | 'card'` + `instance` 字段（携带完整 `EquipmentInstance`/`CardInstance`，词条/暴击/强化/gear 随实例走）。材料仍走 `kind:'material'`。
2. **领取投递**：metaserver `mail.ts splitAttachments` 增 `equipment`/`cards` 桶；`service.ts claimMail` 领取时按 `instance.id` 写回 `equipmentInv`/`cardInv`（复用 `equipment.ts grantEquipment` + 抽到 `cards.ts` 的 `grantCard`，二者按 id 覆写天然幂等，无 300 上限检查）。领取原子性由 socialsvc `claimMailAtomic` 单发保证。
3. **worldsvc 出账改邮件**：`auctionService.ts deliverItem` 不再直接 `meta.grant*`，改 `mail.sendSystemMail`（dispatchKey=各调用点已幂等的 orderId，`auction_buy/settle/cancel/expire/reset:*`），附件类型按物料/装备/卡分派；subject/body 用 i18n key（`auction.mail.sold.*`/`auction.mail.returned.*`，客户端解析，同季末结算邮件机制）。`createAuction` 内 escrow 后的**同步失败回滚**仍走直接 grant（挂单未成立的即时回退，非出账语义）。
4. **客户端**：`FriendsScene` 邮件详情渲染 equipment/card 附件（名称+等级，`mail.attEquip`/`mail.attCard`，三语），领取流程复用既有 `claimMail`（回新 save 刷库存）。

---

## 14. 实现拆解（建议里程碑，待排期）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| E0 数据模型 ✅ | `EquipmentInstance` / `equipmentInv` / `gear` 新结构（types/SaveData/openapi）+ 存档 v1→v2 迁移 + `SyncPatch` 收窄（装备段不进 `PUT /save`） | types/contracts |
| E1 引擎注入 ✅ | `applyEquipment` + `clampEffectCaps` + campaign/siege 三步链接入 + `GameConfig.equipment` 管线 + 硬墙/单调性/封顶单测（`client/test/equipment.test.ts` 17 项）。见 §9 实现记录 | @nw/engine |
| E2 获取 ✅ | **合成 `/equipment/craft` ✅**（扣材料→roll 主+副词条→入库[300 上限]，idemKey 幂等）；**关卡掉落 faucet ✅**（`pveRewards` 12 Boss/精英关配置 + `grantClearReward` 外部 roll + `makeDropInstance`，满仓静默跳过，pveClear/pveVerify 回 `grantedEquipment`） | metaserver |
| E2.5 拍卖托管 ✅ | meta `escrowEquipment`/`grantEquipment` + `/internal/equipment/{escrow,grant}`（worldsvc 拍卖 A 调用：移出库存托管 / 转移归属 / 退回；穿戴中·locked 拒挂）。见下方实现记录 | metaserver + worldsvc |
| E3 强化/分解 ✅ | `/equipment/enhance` 服务器掷骰 + 成功率表 + 材料/金币损耗（commercial 走币）；`/equipment/salvage` 分解回收（70%/+5 锁定，§6.3，批量）。见下方实现记录 | metaserver |
| E4 穿戴 ✅ | `/equipment/equip` + loadout（global/byUnit）+ 客户端 ApiClient 方法。见下方实现记录 | metaserver + client |
| E5 UI ✅ | 背包/锻造/强化/分解/穿戴界面（`EquipmentScene`，从战役地图进入，仅在线）。见下方实现记录 | client + UI_DESIGN |
| E6 词条/洗练 ✅ | Affix 池 + `/equipment/reforge`（大 R）+ 客户端选材 UI + i18n 三语。见下方实现记录 | metaserver + client |
| E7 抽卡/保护道具 ✅ | 装备池 + 强化保护（变现）。见下方实现记录 | commercial |
| E8 SLG 接入 ✅ | 装备进 `buildSiegeBlueprints` + 拍卖挂装备。见下方实现记录 | worldsvc + engine |

> 接口/DB/幂等草图见 §18，埋点见 §19；落地时正式契约进 SERVER_API.md（craft/enhance/equip/reforge + `equipment` 集合）。

#### E2 + E2.5 实现记录（2026-06-21，✅）— 解锁拍卖行 A

落地 = `server/metaserver/src/equipment.ts`（服务层）+ `service.ts` `craftEquipment` handler + `internal.ts` `/internal/equipment/{escrow,grant}` + `contracts/openapi.yml` `POST /equipment/craft` + `@nw/shared`（`rollCraftedAffixes`/`MAIN_AFFIX_BY_SLOT`/`SUB_AFFIX_POOL`/`CRAFT_SUB_AFFIX_COUNT`/`equipmentInvCount`/`EQUIP_AUCTION_REF_PRICE_BY_RARITY` + `equipmentIdem` 集合）+ `equipment.e2e.test.ts`（12 条）。关键决策：

1. **合成 roll 确定性**：实例 id（`eq_${idemKey}`）+ 词条值均由 idempotencyKey 派生（mulberry32 + FNV-1a 种子）。重试/重放产同一件，杜绝"网络重试改命"。主词条按槽位从候选定 1 个（§7.4：weapon→`m_atk`/armor→`m_hp`/trinket→`m_spd` 或 `m_crit` 二选一；单候选槽位不消耗随机流，保证既有 roll 确定性不变），副词条按稀有度从池抽 N 条不重复（common 0 / fine 1 / rare·epic 2，池含 `s_critmult`）。洗练保留实例现有主词条（不因候选随机而翻转），只重洗副词条。数值 DRAFT，权威终点 ECONOMY_NUMBERS §5。
2. **幂等闸门**：`equipmentIdem` 集合（TTL 7 天）。合成先抢占 idemKey 唯一 _id（dup → 重放首次结果，不二次扣料）；托管按 orderId 记快照（重放返回同实例，防二次移出）；转移按 `instance.id` 覆盖写天然幂等。扣料/移实例走乐观锁 rev 守卫 + 重试（同 internal.ts 材料范式）。
3. **库存权威 + 拍卖托管语义**：`equipmentInv` 仅 `/equipment/*` + `/internal/equipment/*` 写（PUT /save 不可写，SyncPatch 已收窄）。挂拍 = `escrowEquipment` 移出卖方库存回快照（拍卖单存整件快照）；成交 = `grantEquipment` 转移给买方；撤单/过期/季末 = 退回卖方。**穿戴中（gear 引用）/ locked 拒挂**（`EQUIP_IN_USE`/`EQUIP_LOCKED`）。
4. **满仓口径**：300 上限只卡 craft（faucet 侧）；**成交/退回不卡**（escrow-out 后一律经系统邮件下发，领取时才入库，邮件即持有缓冲——满仓不会资损、也不突破硬上限，见 §13 实现记录）。
   - ⚠️ **本切片范围**：只交付「合成 → 上拍卖交易」闭环以解锁拍卖行 A。**关卡掉落 faucet + E3 强化/分解 + E4 穿戴 + E5 UI 仍待做**（见上表）。

#### E3 + E4 实现记录（2026-06-21，✅）— 强化/分解 + 穿戴

落地 = `server/metaserver/src/equipment.ts`（`enhanceEquipment`/`salvageEquipment`/`equipEquipment` 三函数）+ `service.ts` 三 handler + `contracts/openapi.yml` `POST /equipment/{enhance,salvage,equip}` + `@nw/shared`（`enhanceSuccessRate`/`enhanceCost`/`rollEnhanceSuccess`/`salvageRefund` + `EquipmentIdemDoc.op` 扩 `enhance`/`salvage` + 错误码 `ENHANCE_MAX_LEVEL`/`NOT_SALVAGEABLE`/`INVALID_SLOT`）+ `client/src/net/ApiClient.ts`（`craft`/`enhance`/`salvage`/`equip` 四方法，E4 客户端部分）+ `equipment.e2e.test.ts`（共 30 条）。关键决策：

1. **强化掷骰服务器权威 + 确定性绑 idemKey**：`rollEnhanceSuccess(idemKey, fromLevel)`（mulberry32 + FNV-1a，种子混入 fromLevel）→ 同 key 重放结果固定，杜绝"网络重试改命"（§18.2）。成功率 `(9 - fromLevel)/10`：0→1=90%…8→9=10%（§6.1 起点 90%，与 ECONOMY_NUMBERS §5.2 的 +1→2=80%…+8→9=10% 衔接）。成本 `enhanceCost(fromLevel)` 随级递增（低级 scrap、+3 起 lead、+6 起 binding + 金币）DRAFT，权威终点 ECONOMY_NUMBERS §5.2。
2. **金币走 commercial 权威（关键架构约束）**：`save.wallet.coins` 仅镜像（economy.ts §0），强化的金币部分必须经 `commercial.spend`（orderId=idemKey 天然幂等）→ 故 **enhance 依赖 commercial 在线**（不可用 → 503，同 shop/gacha）。排序取**玩家安全**：先原子改存档（扣材料 + 成功则 level+1，rev 守卫 + fromLevel guard）**再**扣金币——改档失败时金币未动可安全释放幂等抢占重来；改档成功后扣币环节中断由重放路径幂等补扣（spend(idemKey) + 镜像），杜绝漏扣。失败掷骰仍扣材料 + 金币（核心 sink，§6.2），不掉级不碎（温和档）。
3. **分解整批原子 + 校验前置**：`salvageEquipment` 全批先校验（存在 / 未锁 / 未穿戴 / level ≤ +4），任一不合规整批拒（不留半完成态），再单 `findOneAndUpdate` 移实例 + 入材料（rev 循环内复查）。返还 `salvageRefund(defId)` = 打造成本 × 70% 向下取整（强化投入不返还，§6.3）；不可合成件（无 craftCost）返还空。idemKey 幂等。
4. **穿戴纯状态、无幂等键**：`equipEquipment` 无随机、无资源消耗 → 天然幂等，不收 idemKey。校验 `def.slot === slot`（不符 → INVALID_SLOT；openapi `slot` enum 在契约层先拦非法槽名为 BAD_REQUEST）。`unitType` 缺省写 `gear.global`（阶段一全军），给定写 `gear.byUnit[unitType]`（阶段二预留已可用）；`instanceId=null` 卸下。穿戴中实例经既有 `isEquipped` 守卫，自动挡住挂拍（escrow）/分解（salvage）。
   - ⚠️ **本切片范围**：交付 E3 强化/分解 + E4 穿戴的**服务器权威端点 + 客户端 API 方法**。**E5 背包/锻造/强化/穿戴 UI 仍待做**（ApiClient 已就绪供其调用）；关卡掉落 faucet（E2 剩余）、E6 洗练、暴击/proc 框架（§7.4/§7.6 注）不在本切片。

#### E5 实现记录（2026-06-22，✅）— 客户端 UI

落地 = `client/src/scenes/EquipmentScene.ts`（689 行，单场景双 Tab）+ `client/src/game/meta/equipmentDefs.ts`（目录/数值客户端镜像）+ 视图接线（`AppViews.showEquipment` / `app.ts` PixiAppViews / `createAppCore.goEquipment` / `HeadlessAppViews`）+ 入口（`CampaignMapScene` 顶栏「装备」按钮，仅在线）+ i18n 三语（zh/en/de，`equip.*` / `campaign.equipment` / `affix.*` / `rarity.fine`）。`platform/uuid.ts` 的 `genUuid` 导出供 idempotencyKey 生成。关键决策：

1. **客户端目录镜像（不 import `@nw/shared`）**：客户端 webpack 只 alias `@nw/engine`（零依赖），`@nw/shared` 带 mongodb/jsonwebtoken 无法打包。故 UI 展示所需的「目录 EQUIPMENT_DEFS / 合成成本 craftCost / 强化成功率·成本 enhanceSuccessRate·enhanceCost / 分解返还 salvageRefund / 上限常量」在 `equipmentDefs.ts` 镜像一份（与 `SaveData.ts` 同纪律：**改字段三处同步** 本文件 ↔ `server/shared/src/equipment.ts`）。主词条放大系数 `ENHANCE_COEFF_PER_LEVEL` 直接从 `@nw/engine` 取，不重复。**服务器仍是唯一权威**：UI 据镜像**预览**成本/成功率，真实扣费/掷骰以回推 SaveData 为准。
2. **单场景双 Tab（背包/锻造）**：仿 `AuctionScene` 结构——静态 header + `bodyLayer` 重绘 + 拖拽滚动 + modal 叠层 + toast + 错误码映射。背包 tab 顶部三槽 global loadout 带 + 实例列表（按稀有度色 §2/2026-07-06 稀有度色统一：common 灰 / fine 绿 / rare 蓝 / epic 紫）；点实例开详情 modal（强化预览成功率+成本 / 穿戴·卸下 / 分解，受 +5·穿戴·锁定门控）。锻造 tab 列可合成 12 件中有 craftCost 者 + 成本 + 合成按钮（满仓/材料不足置灰）。
3. **服务器权威贯穿（L2）**：场景只发意图、读回执；每动作后 `saveManager.adoptServer(save)` 重读重绘（被分解的实例自动关详情）。错误码 → i18n 全映射（INSUFFICIENT_MATERIALS/FUNDS、INVENTORY_FULL、ENHANCE_MAX_LEVEL、NOT_SALVAGEABLE、INVALID_SLOT、EQUIP_LOCKED、EQUIP_IN_USE → `equip.err.*`）。每个 craft/enhance/salvage 自生成 `genUuid()` idempotencyKey（穿戴 equip 纯状态无 key）。
4. **入口门控 + 埋点**：从战役地图进入（装备是 PvE 成长线，§0），**仅 `api` 在线时挂入口**（强化掷骰/扣费/库存皆服务器权威，离线无意义）。埋点对齐 §19：`equip_craft`/`equip_enhance`（含 from_level/success）/`equip_salvage`/`equip_equip` + `screen_view`。
   - ⚠️ **本切片范围**：交付 E5 背包/锻造/强化/分解/穿戴 UI（单件分解；批量分解走同端点但 UI 暂单选）。**关卡掉落 faucet（E2 剩余）、E6 洗练 UI、E7 抽卡/保护道具、E8 SLG 接入、按兵种 loadout（§3.1 byUnit，UI 暂只 global）、装备 bone-slot 立绘叠加（§2/§11，占位文字）不在本切片**。验证：client `tsc --noEmit` + webpack 生产构建全绿。

#### 背包图标卡网格改版（2026-07-03，✅）

库存 tab 的物品由整行列表改为**图标卡网格**（充分利用 1920 横屏）：按画布宽度自动算列数（目标 ~320px/格），每格约 92px 高。卡片布局＝**顶部名字 `+等级`**（过长自动缩放）／**左侧品质描边的装备图标**（复用 `addGlyph`，贴图或程序化字形）／**右侧品质·`[已装备]`·`×堆叠数`**／右下角 `装备 ›` 提示、右上角锁定图标。装备栏（loadout）、槽位筛选、「已装备/背包」分区标题保留——分区标题占整行并重置列游标，物品在其下按列铺开。**锻造 tab 同步改为图标卡网格**（每格约 116px 高，多出的高度放成本 chips + 制作按钮，`renderCraftCell` 复用库存格视觉语言）。滚动/命中/详情弹窗逻辑不变，仅命中矩形改为按格。角色卡背包（`CardScene`）同步改版，见 `CHARACTER_CARDS_DESIGN §10.1`。

**网格左起点右移过红边线**（2026-07-03 追加）：两个网格（库存 + 锻造，及 `CardScene` 卡背包）的图标卡起点从 `CELL_GAP` 改为 `marginLineX(w) + CELL_GAP`——`marginLineX(w)=round(w*0.09)`（`sketchUi` 新导出，与 `buildPaperBackground` 红边线同一 x），列宽/列数按缩减后的可用宽重算，右侧仍留一个 `CELL_GAP`。避免图标卡压在红色竖边线上。整行元素（资源/筛选条、分区标题、loadout）保持整宽不动。同时 `hubTabsHeight` 由 `h*0.05` 提到 `h*0.066`，顶部分组 tab（如 `[卡背包|装备]`）更醒目。

**头部按红边线拆左右两栏**（2026-07-04 追加）：上条只挪了网格起点，头部（分组 tab / 背包·锻造 tab / 资源条 / 槽位筛选）此前仍整宽横条。改为新的 `renderHeaderRow`：**左栏**（红线左侧，`marginLineX(w)` 宽）纵向堆叠「`[卡背包\|装备]` 分组 tab」+「`背包/锻造` 内容 tab」；**右栏**（红线右侧）放大 2 倍（`RES_SCALE`）的金币+材料资源条、整体右对齐停靠右上角，下接「全部/武器/护具/饰品」槽位筛选条（仅背包 tab 显示，锻造 tab 无筛选，右栏只剩资源条）。`renderHeaderRow` 返回左右两栏中较高一栏的 y 作为正文（loadout/网格）起始位置，两栏高度不一致时不会重叠。`renderSlotFilter` 签名从 `(y)` 改为 `(x,y,w)` 以支持限定在右栏宽度内绘制。loadout 三槽条仍整宽不受影响。

**图标放大 + 已装备可读性修复**（2026-07-05 追加）：走查截图发现三处问题并修复：① 库存格图标偏小——`EQUIP_CELL_H` 92→118，图标框（`imgBox = EQUIP_CELL_H - pad*2 - 24`）随之从 52px 放大到 78px（1.5 倍），列数/列宽仍按常量动态算，无需改布局逻辑；② 「已装备/背包」分区标题字号 10px 浅灰在纸纹背景下辨识度太低，改 12px 加粗深色，分隔线加粗加深；③ 已装备格只显示 `[已装备]`，同名同稀有度的武器/护具/饰品并排时分不清各自槽位，改为 `[已装备 · 武器]` 等带槽位名。三处均在 `EquipmentScene/base.ts` + `EquipmentScene/inventory.ts`，`tsc --noEmit` 验证。

**分区标题错位修复**（2026-07-06 追加）：`renderSectionHeader`（`EquipmentScene/inventory.ts`）此前把「已装备/背包」分区标题硬编码在 `x=14`，紧贴屏幕最左侧、压在侧栏导航上；改为与物品网格同一起点 `marginLineX(w) + CELL_GAP`，分区标题与其下的图标卡网格左对齐。`tsc --noEmit` 验证。

**稀有度配色 + 图标卡放大 + 资源条加标签**（2026-07-06 追加）：走查截图发现四处问题并修复：① 稀有度色 `RARITY_COLOR`（`EquipmentScene/base.ts`）此前 rare 用橙 `#e08a2c`、epic 用紫，橙比紫更抓眼，读起来 rare 反而"高级感"超过 epic；改为灰→绿→蓝→紫的递进序（common 灰不变 / fine 绿 `#4a9e4a` / rare 蓝 `#4477cc` / epic 紫不变），恢复稀有度视觉层级；② 背包格 `renderInstanceCell` 此前只有已装备的格子描边用稀有度色，未装备格退回中性灰，同一套颜色语言在背包区断掉；改为描边始终用稀有度色；③ **图标卡尺寸统一+放大 1.5x**：装备格 `EQUIP_CELL_H/EQUIP_CELL_W_TARGET`（118×320）与角色卡 `CardScene` 的 `CARD_CELL_H/CARD_CELL_W_TARGET`（118×360）此前不一致，且都偏小；统一改为 177×480（=118×1.5，两个常量目标宽都取 480），背包材料格复用同一装备格组件，无需单改；④ **头部资源条加标签+放大 2x**：`drawHeaderCurrency`（`ui/widgets/SceneHeader.ts`）此前只有图标+裸数字，新玩家看不出图标含义；每个 chip（金币/碎屑/铅芯/装订线）加短文字标签，并给 Equipment/CardScene 两处调用传新增的 `scale=2` 参数把图标/字号/间距整体放大（栏高不变，仍在 50px 头部内居中；`FriendsScene` 等其余调用方 `scale` 默认 1，不受影响）。四处均 `tsc --noEmit` 验证，未起 preview 截图。

**角色卡装备槽边框同步稀有度色**（2026-07-18 追加）：`CardScene/detail.ts` 的 `renderDetailGearSlots`（角色详情弹窗里武器/护甲/饰品三个装备槽）边框此前固定为「已装备用 `C.accent`（蓝）/ 空槽用灰」，与②修复的库存格描边规则不一致——同一件史诗装备在库存格是紫框，装到卡上却变蓝框。改为复用同一个 `RARITY_COLOR`（从 `EquipmentScene/base.ts` 导入），空槽仍为中性灰。用临时调试钩子（`__NW_DEBUG` 暴露 `app/PIXI/CardScene`，验证后已移除）离屏渲染 common/rare/epic 三档截图核对，`tsc --noEmit` 通过。

**锻造图标卡对齐背包尺寸**（2026-07-08 追加）：上条把背包/角色卡格统一到 177 高，却漏了锻造格 `CRAFT_CELL_H` 仍停在 116，锻造 tab 的图标框（`imgBox = CRAFT_CELL_H - pad*2 - 22`）明显小于背包。改 `CRAFT_CELL_H = EQUIP_CELL_H`（177），锻造图标框随之从 78px 放大到 ~139px，与背包 ~137px 一致；成本 chips + 制作按钮布局按格高动态定位不变。`tsc --noEmit` 验证。

**从角色卡槽进入直接定位对应筛选页签**（2026-07-14 追加）：`EquipmentCallbacks` 新增可选 `initialFilterSlot?: EquipSlot`，`EquipmentSceneBase` 构造时若有则播种 `filterSlot`（否则仍默认 `'all'`）。链路：`CardScene` 卡详情点某装备槽 → `openEquipment(cardId, slot)` → `goEquipment(..., initialFilterSlot=slot)` → `showEquipment`。让「给角色穿某类装备」直接落到该类页签而非「全部」。不带 slot 的入口（大厅装备背包 `openEquipmentBag`）不受影响。测试：`scenes.ui.ts`（三槽播种 + 默认 all + 带筛选重渲染不抛错）+ `cardRoster-offline.test.ts`（nav 层 slot 透传断言）。

**标题居中 + loadout 三槽条移过红边线**（2026-07-15 追加）：走查截图发现两处问题并修复：① 头部标题此前 `titleAlign:'left'`（避免与右侧资源条碰撞的历史遗留，但资源条早已瘦身到仅金币+容量，横屏/竖屏均有 ~100px+ 净空——用 `EquipmentScene` 独立实例验证过两种朝向的包围盒不重叠），改回默认 `'center'`，与其余场景标题一致。② §2026-07-04 记录里"loadout 三槽条仍整宽不受影响"是当时的遗留，实际视觉上三槽条（`renderLoadout`）从 `x=8` 起铺满整行，压在侧栏导航/红边线之上，与其上方已收进右栏的资源条/筛选条/物品网格不一致——`renderInventory` 新增 `left = sidebarNavW(w,h,landscape)` 并透传给 `renderLoadout(save,y,left)`，三槽条起点、格宽随之收进红边线右侧，与筛选条同一起点。用临时 `__NW_DEBUG` 钩子（见 `client-run-and-visual-verify` 记忆）直接 new 一个 `EquipmentScene` 读子节点坐标数值验证，未起 webpack 截图。`tsc --noEmit` 验证。

**堆叠格补「全部分解」+ 分解文案说明**（2026-07-18 追加）：玩家反馈"分解装备之后，装备并没有消失"——排查后确认是 §6.3/§482 早已标注的已知缺口：库存网格把同 `defId`+`rarity` 的 +0/未穿戴/未锁定件合并成一个 `×N` 堆叠格（`inventory.ts buildDisplayEntries`），点开只代表其中**一个**实例，`分解`按钮（`detail.ts confirmSalvage`/`doSalvage`）也只删这一个——数据链路（服务端 `salvageEquipment` 原子删除 → `adoptServer`/`reconcile` → 重渲染，`equipment.ts`/`SaveManager.ts`/`inventory.ts` 三处均验证正确）没有 bug，只是堆叠计数 `×50→×49`，格子本身不消失，玩家误以为没生效。修复两处：① `EquipmentSceneBase` 新增 `stackSiblingIds(save, inst)`（`base.ts`），复用与 `buildDisplayEntries` 相同的分组条件（+0/未穿戴/未锁定同 `defId+rarity`），供详情弹窗判断当前实例是否属于 >1 的堆叠；② 详情弹窗（`detail.ts`）堆叠数 >1 时在原「分解」旁新增「全部分解」按钮，走既有批量端点 `cb.salvage(stackIds)` 一次性分解整堆（`confirmSalvageAll`/`doSalvageAll`），且两个确认弹窗文案都改为明确写出"分解 1 件（共 N 件）"vs"分解全部 N 件"，避免误解（`equip.confirmSalvageOne`/`equip.confirmSalvageAll`/`equip.salvagedAll`，zh/en/de 三语）。堆叠数=1（没有重复件）时行为不变，仍是单一「分解」按钮。测试：`scenes.ui.ts` 新增堆叠分解流程用例（97 项全绿），`tsc --noEmit` 通过。

**图标卡网格间距 3 倍**（2026-07-16 追加）：走查截图发现 Equipped/Backpack 网格卡片间贴得太紧；`CELL_GAP`（`EquipmentScene/base.ts`）从 12 改为 36（3x），该常量同时驱动网格外边距、行列间距、分区标题左对齐基准，无需改动引用点。起 `npm run start` 真实渲染 `EquipmentScene`（构造假 save/cb，两次 `app.renderer.render` 后 `toDataURL` 截图）验证间距变化，`tsc --noEmit` 通过。

**"+0" 噪音清理 + 背包格空白填充 + Equip/详情视觉分级**（2026-07-15 追加）：真人吐槽走查（真实账号，dev server 指向正式服 `api.gamestao.com` 实测，见 `client-run-and-visual-verify` 记忆新增的"指向正式服 VPS 实测"用法）发现三处问题并修复：① 几乎所有未强化过的装备标题都带一个没有信息量的 `+0`（`Marker +0`/`Pencil +0`…），只有 `Foil Cover +6` 这种真正强化过的才有意义——`EquipmentSceneBase` 新增共享方法 `itemLabel(defId, level)`（`level>0` 才拼 `+N`），替换掉 `inventory.ts`/`detail.ts`/`assign.ts`/`reforge.ts` 五处硬编码的 `` `${itemName} +${level}` ``，全场景统一生效。② 背包格 `renderInstanceCell` 右侧列此前只有稀有度一行文字，格子下半区大片空白——稀有度/已装备标签/堆叠数字字号统一放大（16/14/16→18/16/18）+ 行距拉开，并新增底部满宽的操作区。③ 该操作区顺带解决"箭头 vs Equip 按钮权重分不清"：未装备格给一个真正的按钮外观（`sketchPanel` 描边填充 + 居中文案，取代原来贴在右下角的小字提示），已装备格保留安静的 `› 查看详情`（新 i18n key `equip.viewDetails`，三语言都加了）——两者其实都是同一个"打开详情"点击（整格命中区不变），但视觉上现在清楚区分"这是主操作"和"这只是查看"。原先怀疑的头部 `42/300` 容量数字截断问题实测**未复现**（1280px/1568px 均完整显示），代码里 `drawHeaderCurrency` 本就是量出总宽度后从右边界反推起点，结构上不会裁字，判断是旧版本或更窄分辨率下的截图，未做改动。`tsc --noEmit` + 生产 webpack 构建全绿，真实账号截图逐项核对过。

**分区标题放大+可折叠 + 图标卡再放大 50% + 去除宽度空白**（2026-07-16 追加）：真人截图走查发现三处问题并修复：① 「已装备/背包」分区标题字号 12→24（2 倍）+ 左边距再加 20px 右移，`SECTION_H` 20→36 容纳大字；② 分区标题新增点击折叠：整行（`x=0` 到画布右边界）可点，`▼`/`▶` 箭头指示状态，`InventoryMixin` 新增 `collapsedSections: Set<'equipped'|'bag'>` 实例态，折叠的分区其下图标卡在布局阶段直接跳过（不占垂直空间），`DisplayEntry`/`Placed` 的 header 变体新增 `key` 字段区分两个分区。③ 图标卡 `EQUIP_CELL_H` 再 +50%（177→266，同步带动 `CRAFT_CELL_H`）；`renderInventory` 里的 `cellW` 此前把整行可用宽度平均分给列数，导致格子比设计目标宽（480）撑得更宽、内部大片空白，改为 `cellW = min(480, 平均列宽)` 封顶，多余宽度留在网格右侧当边距，不再撑大卡片本身。`tsc --noEmit` 验证；因端口 9090 dev server 被同目录另一并发会话占用，未起浏览器截图核对（未注入调试钩子以免打断对方热更新）。

**下拉遮挡筛选条修复 + 图标卡横向间距翻倍**（2026-07-17 追加）：真人截图走查发现两处问题并修复：① 网格滚动到某一行与筛选条/资源条边界跨骑（straddle）时，该行此前会整格照常绘制、视觉上盖住上方的「All/Weapon/Armor/Trinket」筛选条与资源条——原本的裁剪逻辑（`renderInventory`/`renderCraft`）只跳过完全落在可视区外的行，不裁剪跨骑行。改为把网格绘制进一个临时子容器（`gridLayer`），套一个对齐可视区 `[listY, listY+listH)` 的矩形 `mask`，跨骑行现在被硬裁剪，不再盖住上方内容。② 图标卡之间的横向间距翻倍：新增 `CELL_GAP_X = CELL_GAP * 2`，仅用于同一行内卡片间的水平间隙（`Inventory`/`Craft` 两个网格都改用），网格外边距、行间距（垂直）仍用原 `CELL_GAP`，未受影响。（同批次另有并发会话把 `EQUIP_CELL_W_TARGET` 480→360 收窄，见对应 commit，非本条修复范围。）用 `__NW_APP`/`__NW_PIXI`/`__NW_EquipmentScene` 临时钩子起真实 `npm run start` 渲染 + `toDataURL` 截图核对（多组 `scrollY` 下筛选条不再被盖住），验证后移除钩子；`tsc --noEmit` 通过。新增回归测试 [equipmentGridLayout.ui.ts](../../client/test/ui/equipmentGridLayout.ui.ts)：同行横向间距＝`CELL_GAP_X`、行间距＝`CELL_GAP`不变、网格渲染进一个裁剪到可视列表带（非全屏）的 mask 层内。

**已装备标签文字溢出格子修复**（2026-07-17 追加）：真人截图走查发现 Equipped 分区图标卡右列的「[Equipped · Weapon]」绿色标签文字比格子本身还宽，溢出格子右边界、盖住相邻卡片文字——`renderInstanceCell`（`inventory.ts`）此前只对顶部的名称文字做了「超宽则缩放」处理，右列的稀有度/已装备标签/堆叠数字没有同样的宽度约束。修复：已装备标签超出可用列宽 `colW` 时 `e.scale.set(colW / e.width)` 等比缩小，与名称文字用同一模式。用临时 `__NW_DEBUG` 钩子（`app.ts` 里挂 `{PIXI, app, EquipmentScene}`）直接 new 一个装了 3 件已装备道具的 `EquipmentScene`，遍历 `container` 找 `[Equipped · ...]` 文字节点核对 `scale`/`x`/`width` 不再越出格子右边界（验证后移除钩子）；`tsc --noEmit` 通过。新增回归测试 [equipmentEquippedTagOverflow.ui.ts](../../client/test/ui/equipmentEquippedTagOverflow.ui.ts)：反向验证过（去掉 scale 修复后测试确实失败），已装备标签的渲染右边界始终 ≤ 所在格子的右边界。

#### E2 掉落 faucet + E6 洗练 实现记录（2026-06-22，✅）

**E2 关卡掉落 faucet**

落地 = `server/shared/src/equipment.ts`（`makeDropInstance` / `REFORGE_MATERIAL_RARITY` / `rollReforgedAffixes`）+ `server/shared/src/pveRewards.ts`（`EquipmentDropConfig` 接口 + 12 个 Boss/精英关 `equipmentDrop` 配置，Ch1–Ch6 lv5/lv10）+ `server/metaserver/src/service.ts`（`grantClearReward` 外部 roll + `pendingDrop` 写入 `mutateSave` + `grantedEquipment` 回执）+ `server/contracts/openapi.yml`（`/pve/clear` + `/pve/verify` 响应增 `grantedEquipment?`）+ 客户端 `ApiClient.pveClear/pveVerify` 返回类型。关键决策：

1. **drop 在 mutateSave 外 roll**：`Math.random()` 在事务外调用（committed 即原子，不需要 determinism），避免事务内随机性。
2. **满仓静默跳过**：背包 300 上限时不报错、不补偿材料（ADR-012 已拍板）；`grantedEquipment` 仅在实际写入时回。
3. **`makeDropInstance` 用 instanceId 作种子**：`seededRng(hashSeed('drop:${instanceId}'))` 保证同 id 重放同槽，满足幂等性要求。

**E6 洗练 Reforge**

落地 = `server/metaserver/src/equipment.ts`（`reforgeEquipment` 函数：幂等抢占 + 校验 + 原子 rev 守卫写）+ `service.ts`（`reforgeEquipment` handler）+ `contracts/openapi.yml`（`POST /equipment/reforge`）+ `client/src/net/ApiClient.ts`（`reforgeEquipment` 方法）+ `client/src/scenes/EquipmentScene.ts`（`openReforgeSelect` 选材 modal + `confirmReforge` 确认 + `doReforge` 执行）+ `client/src/game/meta/equipmentDefs.ts`（`REFORGE_MATERIAL_RARITY` 镜像）+ i18n zh/en/de（`equip.reforge*` / `equip.err.notReforgeEligible` / `equip.err.invalidRarity`）+ `createAppCore.goEquipment`（`reforge` 回调 + `equip_reforge` 埋点）。关键决策：

1. **主词条锁定**：`rollReforgedAffixes` 先 push main affix（固定 id/base 值），再全量重 roll sub affixes；结果绑 `idempotencyKey` 种子，重放不变。
2. **素材校验三层**：同槽 slot 匹配 → 稀有度恰低一档（`REFORGE_MATERIAL_RARITY`）→ 都未穿戴/未锁定；`common` 直接拒（无副词条）。
3. **客户端预检灰化**：`openDetail` 读当前 save 确认有符合条件的素材件（`hasMaterials`），无素材则按钮灰化；服务端仍做完整校验。

#### E7 抽卡/保护道具 实现记录（2026-06-22，✅）

**抽卡 — 装备入标准抽奖池（与皮肤共池，ADR-017）**

落地 = `server/shared/src/economy.ts`（`GACHA_MATERIAL_GRANTS` 新导出：mat_scrap→{scrap:10} / mat_lead→{lead:3} / mat_binding→{binding:1}；标准池 `STANDARD_POOL.itemsByRarity` 更新四档：common 7 项加 mat_scrap×3 / rare 8 项加 mat_lead×2 + wp_pen/ar_cardstock/tk_bookmark / epic 6 项加 mat_binding + wp_marker/ar_leather/tk_sticker / legendary 4 项加 wp_highlighter/ar_foil/tk_seal）+ `server/shared/src/equipment.ts`（`makeGachaEquipInstance(defId, instanceId)` 新函数：按指定 defId 生成 +0 实例，affixes 绑 instanceId 种子）+ `server/metaserver/src/economy.ts`（`deliverGrant` 扩签名加 `materialInc?`/`equipInstances?` 参数，原子写合并 `$inc` 材料 + `$set` 各装备键 + `$addToSet` 皮肤；`deliverOrder` 重写路由分类：`mat_*` → materialInc via `GACHA_MATERIAL_GRANTS`、`EQUIPMENT_DEFS[id]` → equipInstances 上限 `EQUIPMENT_INV_CAP`、其余 → skins；instanceId 格式 `eq_gacha_${orderId}_${i}` 确定性幂等）+ `server/contracts/openapi.yml`（无需新端点，原有 gacha 接口覆盖）+ `client/src/game/meta/equipmentDefs.ts`（`PROTECT_ENHANCE_ITEM_ID = 'protect_enhance'`）。关键决策：

1. **三类产出单次原子写**：皮肤（`$addToSet skins`）、材料（`$inc save.materials.*`）、装备（`$set save.equipmentInv.${id}`）合入同一 `findOneAndUpdate`，杜绝部分成功。
2. **装备满仓静默截断**：与关卡掉落 faucet 同口径（ADR-012）——`equipInstances` 在 `deliverOrder` 时检 `equipmentInvCount(save) < EQUIPMENT_INV_CAP`，满则跳过，不阻塞同批材料/皮肤入账。
3. **装备 instanceId 绑 orderId + 结果下标**：`eq_gacha_${order._id}_${i}` 使同一订单重放产同一套实例（idempotency）。

**保护道具 — `protect_enhance` 消耗品**

落地 = `server/shared/src/economy.ts`（`SHOP_ITEMS` 新增 `{id:'protect_enhance', cost:500, kind:'item', grants:'protect_enhance', rarity:'rare'}`；同步修正 `kind='item'` 购买路由：`deliverOrder` 里 `kind='item'` 商品经 `deliverMailGrant` 写 `inventory.items[grants]++`，而非走皮肤路径）+ `server/metaserver/src/equipment.ts`（`enhanceEquipment` 加 `useProtect?: boolean` 参数；`hasProtect = useProtect && items[PROTECT_ENHANCE_ITEM_ID] > 0`；`skipMaterials = hasProtect && !success`；idem result 增 `skipMaterials` 字段；原子写循环：`skipMaterials=true` 时跳过材料扣费改为 `nextItems[PROTECT_ENHANCE_ITEM_ID]--`；save 写入 `inventory.items: nextItems`）+ `server/metaserver/src/service.ts`（enhance handler 读 `useProtect?: boolean`）+ `server/contracts/openapi.yml`（`/equipment/enhance` 请求 schema 加 `useProtect: {type: boolean}` 可选字段）+ `client/src/net/ApiClient.ts`（`enhanceEquipment` 加 `useProtect?: boolean` 参数，条件展开）+ `client/src/scenes/EquipmentScene.ts`（详情 modal 增保护石行：读 `protectCount`，checkbox 切换 `useProtectEnhance`；`doEnhance` 传 `useProtect`）+ `client/src/app/createAppCore.ts`（`enhance` 回调签名加 `useProtect?`，透传 `enhanceEquipment`；埋点增 `use_protect`）+ i18n zh/en/de（`equip.protect` 三语）。关键决策：

1. **`skipMaterials` 持久化进 idem record**：重放路径读 `idem.result.skipMaterials` 决定是否补扣材料，防止服务器在 idem 写后、save 写前崩溃导致保护石白消耗。
2. **金币仍照扣**：保护道具仅保材料，sink 不完全免除；`commercial.spend` 路径不变。
3. **只 PvE/SLG，不碰 PvP 公平**：保护道具入口仅在 `EquipmentScene`（战役入口），不暴露于 PvP 战前 loadout 界面。
4. **顺带修 `kind='item'` 路由 bug**：商店出售消耗品的 `deliverOrder` 此前误走皮肤路径，E7 一并修正（`inventory.items` 正确写入）。

**共享修复**：`server/shared/src/mongo.ts` `EquipmentIdemDoc.op` 联合类型补 `'reforge'`（E6 遗留 tsc 报错，E7 顺手修）。

**商城卡片文案补漏（2026-07-16）**：`ShopScene`（`client/src/scenes/ShopScene/shop.ts` `buildShopCards`）此前把 `SHOP_ITEMS` 里所有条目都当皮肤画（`brush` 图标 + `"皮肤 · {id}"` 标题 + 皮肤 owned 判定），`protect_enhance`（`kind='item'`）因此显示成裸 id、无说明文案，且错误复用了皮肤的"已拥有"判定（消耗品应可反复购买）。改为按 `item.kind` 分支：`kind==='item'` 走 `armor` 图标 + 专属 i18n 名称/说明（`shop.item.protect_enhance.{name,desc}`）+ 恒可购买（无 owned 态）；`kind==='skin'` 保持原逻辑不变。新增回归测试 [shopScene.ui.ts](../../client/test/ui/shopScene.ui.ts)。

#### E8 SLG 接入 实现记录（2026-06-22，✅）

落地 = `server/engine/src/index.ts`（导出 `EngineEquipmentInput` 类型，供 worldsvc 引用）+ `server/metaserver/src/internal.ts`（新增 `GET /internal/save-fields?accountId=`，返回 `pveUpgrades/unitLevels/gear/equipmentInv`；账号不存在返回空默认，不 404，避免冻结行军）+ `server/worldsvc/src/metaClient.ts`（新增 `SaveFields` 接口 + `getSaveFields()` 方法，失败返回 `null` 降级）+ `server/worldsvc/src/siegeEngine.ts`（`SiegeBattleInput` 扩展 `pveUpgrades?/unitLevels?/equipment?`，传入 `runHeadless` config）+ `server/worldsvc/src/service.ts`（`applySiege` + `applyStrongholdSiege` 两处 `runSiegeBattle` 前调 `meta.getSaveFields(m.ownerId)`，组装 `EngineEquipmentInput`，传入 `runSiegeBattle`）+ `server/worldsvc/src/auctionService.ts`（清理装备挂单过期 TODO 注释，E2.5 时已实现）。关键决策：

1. **失败降级不阻断行军**：`getSaveFields` 网络/超时异常 → `catch(() => null)` → 引擎以无装备蓝图跑，不影响行军结算。
2. **stronghold 亦接入**：险地 PvE 围攻（`applyStrongholdSiege`）同样是攻方 vs NPC，装备战力应生效。
3. **replay 暂不存装备快照**：`SiegeDoc` 未扩展 `attackerEquipment/unitLevels` 字段——replay 重播时单位显示基础数值（视觉误差），服务端权威已正确。replay 精确度留后续可选优化。
4. **拍卖行装备挂单已有（E2.5）**：`auctionService` 的 `escrowEquipment/grantEquipment` 流程在 E2.5 时随拍卖行一起落地，E8 无需新增。**客户端装备/角色卡挂单选择器 UI 于 2026-07-02 补齐**（`AuctionScene` 三类标的选择器 + 实例 picker，详见 AUCTION_DESIGN §6「客户端装备 / 角色卡挂单 UI」）。

---

## 15. 开放问题

- [ ] 词条数值区间/权重定档（结构已定 §7，数字归 ECONOMY_NUMBERS §5）。
- [x] ~~洗练模式：全部重 roll vs 锁定 1 条重洗其余~~ → **技能槽 0–2（多数0/部分1/极少2）；2 条时可花金币锁 1 条重洗另一条，或全随机更便宜**（ADR-017，§7.8）。
- [x] 暴击引擎机制（trait T3 / 饰品主词条 `m_crit` / 副词条 `s_critmult` 共用）已落地（B 方案，feat/equip-crit）。
- [ ] 特技 proc 框架（开刃/嗜血/回响/倒刺需 on-kill / on-spawn / on-hit 钩子）引擎工作量评估。
- [x] ~~抽卡：装备独立池 vs 与皮肤共池~~ → **与皮肤共池，且主产出是材料**（装备成品仅低概率彩头，ADR-017，§6）；保底（pity）规则待定。
- [ ] 是否加"掉级/碎裂"硬档（更狠氪向）+ 保护道具——现为温和"只损材料"基线（ECONOMY_NUMBERS §10 待办）。
- [ ] 分解/转化渠道（缓解满级膨胀），后期视通胀加。
- [ ] 阶段二「按兵种独立装备」的开启时机与 UI 成本。
- [ ] 装备系统**解锁章节号**（暂定第 2 章，§4）+ 引导脚本，待战役节奏定档。
- [x] ~~背包上限具体值~~ → **硬上限 300 实例**（ADR-012，§3.3）；逼近上限的引导/清理 UX 待细化。
- [ ] 分解 70% 返还的"打造基础成本"口径需与 ECONOMY_NUMBERS §5 配方表对齐（§6.3）。
- [x] ~~流拍溢出暂存区的领取 UI~~ → **改为 escrow-out + 系统邮件退回**（放弃暂存区），✅ 已落地（见 §13 实现记录）。剩：拍卖挂单时效（24–48h）落地。
- [x] ~~装备定义 `defId` 表~~ → 已补 §17。

---

## 16. 可调参数集中表（指针）

| 参数 | 权威位置 |
|---|---|
| 强化成功率曲线 | ECONOMY_NUMBERS §5.2 |
| 合成配方/成本 | ECONOMY_NUMBERS §5 |
| 关卡装备掉率 | `server/shared/pveRewards.ts` |
| 战力占比上限 35% / 1.5× | ECONOMY_BALANCE §5.5.1 |
| 词条池结构（主/副/特技、稀有度档） | 本文 §7（机制权威） |
| 词条加成数值/区间/权重、强化系数 | ECONOMY_NUMBERS §5（待铺） |
| 装备基础属性 / `applyEquipment` 乘加算 | `@nw/engine/balance/`（待建） |
| 装备定义目录（defId/槽位/稀有度/媒材） | 本文 §17（机制权威；属性区间→ECONOMY_NUMBERS §5） |
| 库存硬上限 / 分解返还% / 分解等级门槛 | 300 / 70% / +5（本文 §3.3 / §6.3，ADR-012） |
| 同时挂拍上限 / 挂单时效 | 5 件 / 24–48h（本文 §13，ADR-012） |

---

## 17. 装备定义表（defId 目录）— DRAFT

> 机制权威 = 本节（每件基础装备"是什么"）；具体属性区间/掉率/配方 = ECONOMY_NUMBERS §5 + `pveRewards`。
> **模型**：`defId` = 一件固定 (槽位 × 稀有度 × 媒材) 的基础装备模板（§3.1）。**稀有度写死在 defId 上**，开出后只能强化 +级、洗练副词条，不能变稀有度。

### 17.1 命名规范

`<slot 前缀>_<媒材>`，前缀：`wp_` 武器 / `ar_` 护具 / `tk_` 饰品。媒材即稀有度皮（§2）。

### 17.2 v1 目录（3 槽 × 4 稀有度 = 12 件）

| defId | 槽位 | 稀有度 | 媒材皮（文具） | 主词条候选（§7.4） | 主来源 |
|---|---|---|---|---|---|
| `wp_pencil` | weapon | 普通 | 铅笔 | 攻击% | 关卡常掉 / 合成 |
| `wp_pen` | weapon | 精良 | 钢笔 | 攻击% / 攻速% | 中期关 / 合成 |
| `wp_marker` | weapon | 稀有 | 马克笔 | 攻击% / 攻速% | Boss / 后期关 / 抽卡 |
| `wp_highlighter` | weapon | 史诗 | 荧光笔（烫金） | 攻击% / 攻速% | 抽卡 / 极后期 |
| `ar_draft` | armor | 普通 | 草稿纸 | 生命% | 关卡常掉 / 合成 |
| `ar_cardstock` | armor | 精良 | 卡纸 | 生命% / 护甲 | 中期关 / 合成 |
| `ar_leather` | armor | 稀有 | 皮面封皮 | 生命% / 护甲 | Boss / 后期关 / 抽卡 |
| `ar_foil` | armor | 史诗 | 烫金封皮 | 生命% / 护甲 | 抽卡 / 极后期 |
| `tk_clip` | trinket | 普通 | 回形针 | 移速% | 关卡常掉 / 合成 |
| `tk_bookmark` | trinket | 精良 | 书签 | 移速% / 攻速% | 中期关 / 合成 |
| `tk_sticker` | trinket | 稀有 | 贴纸 | 移速% / 暴击% | Boss / 后期关 / 抽卡 |
| `tk_seal` | trinket | 史诗 | 火漆印 | 暴击% / 移速% | 抽卡 / 极后期 |

> 饰品主词条在「移速 / 暴击率」二候选中开出时定 1 个（§7.4）。暴击机制已落地（trait T3 同款引擎字段 `critPct`/`critMult`）。
> 媒材皮 ↔ bone slot 绘制映射见 [`art-direction.md`](../product/art-direction.md) §9.2 + animator 骨架；本表只定数据侧 `defId`。

### 17.3 扩展位（后期，不进 v1）

- **同槽多 variant**：同稀有度多套外观（如史诗武器荧光笔/烫金笔/钢制笔尖），`defId` 加 variant 后缀，纯美术差异、共用数值骨架。
- **套装效果（set bonus）**：同媒材族 2/3 件触发额外加成——大 R 深度，需进 §7.7 同一套封顶管理（防套装+词条+trait 叠爆）。
- **SLG 专属媒材**：赛季限定文具皮，复用同骨架。

---

## 18. 接口与工程契约（草图，落地进 SERVER_API.md）

> 全部走 **meta 服务、服务器权威**（L2）；客户端只发意图、读回执。正式契约（字段/错误码/proto/DB）落地时进 [`SERVER_API.md`](SERVER_API.md)。

### 18.1 端点（REST，需鉴权）

| 端点 | 入参 | 回执 | 服务器职责 |
|---|---|---|---|
| `POST /equipment/craft` ✅ | `{ defId, idempotencyKey }` | `{ save, instance }` | 校验+扣材料，产 0 级基础装备（本切片产独立实例；堆叠优化待 E 后续） |
| `POST /equipment/enhance` ✅ | `{ instanceId, idempotencyKey }` | `{ success, instance, save }` | **服务器掷骰**（成功率表）、扣材料 + 金币（commercial.spend），成功则 level+1、回执 |
| `POST /equipment/salvage` ✅ | `{ instanceIds[], idempotencyKey }` | `{ refunded, save }` \| `NOT_SALVAGEABLE` | 分解回收：返 70% 打造材料，+5↑ 拒（§6.3，ADR-012）；批量整批校验、穿戴/锁定拒 |
| `POST /equipment/reforge` | `{ instanceId, fuelInstanceId, lockedIndex?, idempotencyKey }` | `{ instance, consumed }` | 校验燃料（低一级同类）、扣金币、重 roll 副词条/特技（E6 待做） |
| `POST /equipment/equip` ✅ | `{ slot, instanceId\|null, unitType? }` | `{ save }` | 改穿戴状态（纯状态，无随机，无 idem）；槽位与 def 不符 → INVALID_SLOT |

- 穿戴 `/equip` 因影响 SLG 战力，**不并进 `PUT /save`**（§3.1 `SyncPatch` 已收窄）。

### 18.2 幂等与事务（防资损，最深氪点必备）⚠️

- **所有变更类端点带 `idempotencyKey`**（客户端生成）：服务器记最近 (key→结果) 账本，**重复请求重放首次结果**，不二次扣料、不二次掷骰。范式借 commercial `deliveredOrders`（`$addToSet` + `$ne` 守卫，META_DESIGN §S5-5）。
- **enhance 的随机数绑定到首次执行**：同一 key 的成功/失败结果固定，杜绝"网络重试改命"。掷骰用服务器种子，不接受客户端随机源。
- **扣料 + 改实例 + 写账本单事务**（Mongo 事务或乐观锁 + `rev` 守卫），失败整体回滚，不留半完成态。

### 18.3 存储

- v1：`equipmentInv` 内嵌 SaveData 文档（小体量）。
- 膨胀后：迁独立集合 `equipment`（索引 `accountId`、`accountId+instanceId`），堆叠件存计数表（§3.3）。
- 幂等账本：账号维度 TTL 集合或 capped map（保留近 N 条/24h）。

---

## 19. 埋点与可观测（analyticsvc）

> 强化是**最深氪点**，调平衡与防资损都靠数据 —— 第一版就埋。事件走 analyticsvc（`ANALYTICS_DESIGN.md` 事件规约）。

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `equip_craft` | `defId, rarity, materials_spent` | 合成 faucet 流量 |
| `equip_enhance` | `defId, from_level, success, materials_spent, coins_spent` | **核心**：各级成功率实测 vs 配置、失败损耗、各级停留分布、金币 sink 量 |
| `equip_reforge` | `defId, coins_spent, fuel_defId` | 大 R 行为、洗练吞装备量 |
| `equip_equip` | `slot, defId, rarity` | 穿戴率/最热配置 |

- **运营看板**：强化漏斗（+N→+N+1 实际成功率）、金币/材料 sink 总量、背包逼近上限比例、装备战力分布 vs 35% 目标。
- **风控联动**：异常强化频率、拍卖对敲（§13）入 ops 风控面（OPS_DESIGN）。

---

## 20. 美术资源需求（盘点）

> **2026-06-29 方向调整**：图标由「程序绘制」改为「AI 生成位图 + 程序叠加稀有度边框 / 等级指示器」；战斗内 bone-slot 装备叠加（§20.4）**已移除**（角色本身已有武器视觉，再叠装备 glyph 会冲突）。下文以新方向为准，§20.3 / §20.4 保留为历史实现记录。

### 20.1 装备规模

3 槽 × 4 稀有度 = **12 个 `defId`**（§17.2）。每个 defId 对应一件具体文具（铅笔 / 钢笔 / 马克笔 / 荧光笔 / 草稿纸 / 卡纸 / 皮封皮 / 烫金封皮 / 回形针 / 书签 / 贴纸 / 火漆印），文具本身视觉差异足够大，**AI 逐件出图 12 张**，不走「3 张 + 参数」路线。

### 20.2 资源清单（新方向）

| 项目 | 性质 | 说明 | 落点 |
|---|---|---|---|
| 12 件装备图标 | **AI 生成位图** | 每件文具独立插画，扁平手绘风，见 [`EQUIPMENT_ICON_PROMPTS.md`](EQUIPMENT_ICON_PROMPTS.md) | `client/assets/equipment/` |
| 稀有度边框 | **程序绘制** | 图标外围彩色边框 + 背景底色（4 档色见下），SketchPen 笔触，复用 `RARITY_COLOR` | `EquipmentScene` / `equipmentGlyph.ts` |
| 强化等级指示器 | **程序绘制** | 图标下方单符号 3 阶系统（见 §20.6） | `equipmentGlyph.ts` 扩展 |
| 词条统计 / 材料 / 金币图标 | **程序绘制（✅ 已落地 §20.5）** | 8 个手绘小图标 | `client/src/render/icons.ts` |
| 战斗内装备叠加 | ~~程序绘制~~ **已移除** | bone-slot glyph 叠加与角色武器视觉冲突，取消 | ~~`StickmanRuntime`~~ |

**稀有度边框色**（沿用现有编码）：

| 稀有度 | 边框色 | 背景底色 |
|---|---|---|
| Common 普通 | `#9aa0a6` 铅笔灰 | 透明/极浅灰 |
| Fine 精良 | `#4477cc` 墨蓝 | 极浅蓝 |
| Rare 稀有 | `#e08a2c` 马克橙 | 极浅橙 |
| Epic 史诗 | `#aa55cc` 荧光紫 + `#d9b44a` 烫金 双色边框 | 极浅紫 |

### 20.6 强化等级指示器设计（3 阶 × 3 级）

图标下方预留约 1/5 高度的小条区域，放置单个符号。**阶段跳变用形态区分（圆→星→印章），阶内进度用填充程度区分**：

| 阶段 | 等级 | 符号形态 | 填充状态 | 文具隐喻 |
|---|---|---|---|---|
| 初阶 | +1 | 圆圈 ○ | 空心 | 铅笔点 |
| 初阶 | +2 | 圆圈 ◑ | 半实 | |
| 初阶 | +3 | 圆圈 ● | 全实 | |
| 中阶 | +4 | 五角星 ☆ | 空心 | 批改红星 |
| 中阶 | +5 | 五角星 | 半实 | |
| 中阶 | +6 | 五角星 ★ | 全实 | |
| 满阶 | +7 | 六边印章 ◇ | 空心 | 盖章认证 |
| 满阶 | +8 | 六边印章 | 半实 | |
| 满阶 | +9 | 六边印章 ◆ | 全实 + 淡发光 | |

- **0 级**（未强化）：不显示符号，保持空白。
- 符号用 `SketchPen` 程序绘制，保持手绘风；史诗装备 +9 可加极轻描边发光（与边框色同色调）。
- 实现落点：`drawEquipmentGlyph` 新增 `level` 参数，按上表选形/填充。

### 20.3 实现记录（2026-06-24，✅）— UI 装备图标程序化

落地 = 新建 `client/src/render/equipmentGlyph.ts`（`drawEquipmentGlyph(g, slot, rarity, size, seed)` + `MEDIA` 媒材色表，用 `SketchPen` 画 3 类基形：weapon=笔杆+笔尖 / armor=封皮+书脊 / trinket=小配件，稀有度色驱动填充与点缀）+ 接入 `EquipmentScene`（loadout 三槽、背包实例行、锻造行把原"纯文字"替换为程序图标）。零位图资产，`tsc --noEmit` + webpack 构建验证。

### 20.4 实现记录（2026-06-24，✅）— 战斗内 bone-slot 立绘叠加

§2/§11 的「把装备画到角色身上」已在**战斗渲染**层落地，按 `gear` 给 weapon/armor/trinket 槽沿骨骼挂 §20.3 同款 SketchPen glyph。

**渲染（`StickmanRuntime`）**：新增 `gearLayer`（位于骨骼之上、命中描边之下）+ `setGear(specs)`。glyph 几何体按 `${slot}:${rarity}`（12 组合）全局共享一份模板，单位 gear sprite = `new PIXI.Graphics(template.geometry)`（几何体引用计数，销毁单位不毁模板）→ 满屏装备单位只 12 份几何体而非 12×N。定位**复用 `_applyPose` 已算的逐帧 FK**（不额外 `sampleClip`/`computeFK`，不加重 swarm 热路径）：
- 默认骨骼锚点（animator 本地 px）：weapon→右前臂(`r_lower_arm`)末端=持笔的手；armor→脊柱(`spine`)中点=躯干；trinket→头骨(`head`)末端。glyph 仅平移、不随骨骼旋转（盲验路径下最稳，姿态甩动也不会"穿帮"）。
- 美术可在 animator 标注 `gear_<slot>` attachment point（父骨骼+偏移）覆盖默认锚点做精修——当前 .tao 未标注则走默认骨骼，**今天即可见**。
- 无 gear 的单位 `gearSprites` 为空，`_applyPose` 整段跳过 → 不付出任何代价。

**数据流（PvP 硬墙复用）**：`GameScene.opts.equipment`（A5 已是 **PvE-only** 的 `EngineEquipmentInput`）→ `GameRenderer` → `UnitView`。PvP 永不传 equipment → 战斗内永不显装备（与引擎 `buildPvpBlueprints` 无装备参同源）。`UnitView.gearSpecsFor` 按兵种解析 loadout（`byUnit` ∪ `global`）→实例→`defId`→`{slot,rarity}`，仅 `PLAYER_EQUIPPABLE_UNITS`（与 `applyEquipment` §8 同源，避免"哪些兵种吃装备"漂移；为此 `@nw/engine` index 导出该常量）。

**对象池正确性**：池按兵种分桶、不分敌我，同一 runtime 复用时可能换边。故 `setGear` 做**幂等键校验**（`gearKey` 不变即 no-op），`UnitView.applyGear` 在**每次** acquire（新建 + 池复用两条分支）按 `unit.side === localSide` 重申：己方军披玩家 loadout，同型敌军传 `[]` 清掉上一生命残留的装备。常见「同边同型复用」是 no-op，保住池化收益。

**局限（记录待办，非本切片）**：① 精确锚点/旋转需一次有视角的打磨或美术补 `gear_*` 点（本项目不做截图验证，故默认骨骼为保守平移叠加）；② replay/spectator 路径不携带 equipment 输入 → 回放不显装备；③ glyph 不随骨骼旋转（持笔不会随挥击转动），如需"挥笔"需引入随 `wa` 的旋转项。

### 20.5 实现记录（2026-06-27，✅）— 材料/词条图标化

背景：装备页除装备本体 glyph（§20.3）外，材料余额、强化/锻造消耗、词条统计仍是密集纯文本，信息密度高、扫读慢。本切片把这些信息**图标化**，与 §20.3 同走 `SketchPen` 程序绘制 + 纹理缓存，零位图。

落地 = `client/src/render/icons.ts` 扩 8 个手绘图标（沿用现有 `IconKind`/`buildIcon` 缓存框架，headless 自动回退 live draw）：
- **材料**：`scrap`（撕角纸屑+横线）/ `lead`（削尖石墨条）/ `binding`（螺旋装订圈）；金币复用既有 `coin`。
- **词条统计**：`atk`（剑刃）/ `hp`（涂鸦心）/ `armor`（盾）/ `spd`（双向尖角=移速）/ `atkspd`（闪电=攻速）。

接入 `EquipmentScene`（4 处）：
1. 顶部资源条：金币 + 三材料余额 → 图标 + 数量（无 `×`）。
2. 详情模态·强化消耗：`消耗:` + `图标×数量` 链（买不起整体变红，逻辑不变）。
3. 详情模态·词条行：每条属性前置统计图标，主词条墨蓝 / 副词条铅黑（颜色语义沿用）。
4. 锻造行·配方成本：材料文字 → `图标×数量`。

实现细节：① 新增共享方法 `drawCostChips(parent, x, midY, mats, coins, color, size, prefix)` 统一画消耗组，**未知材料/词条自动回退文字标签**（健壮，不因新增材料 id 漏图标而崩）；② 材料墨色 `MAT_COLOR`（纸灰/石墨/墨蓝）+ 映射函数 `matIconKind`/`affixIconKind`；③ i18n（`material.*`/`affix.*`）全保留——图标是文字的前缀增强，词条数值文字仍在；④ 删去因此变成死代码的 `enhanceCostStr()`。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**美术铁律遵守**：装备本体 glyph（§20.3）与角色立绘叠加（§20.4）不动；新图标全部手绘笔触、平面无渐变，符合 art-direction「三笔语言 + 程序优先」。

### 20.7 实现记录（2026-07-02，✅）— 立绘叠加接通 per-card 数据源 + 战斗接线收尾

背景：§20.4（2026-06-24）落地了战斗内 bone-slot 叠加，但当时读的是旧「`byUnit ∪ global`」loadout。角色卡重构（CHARACTER_CARDS_DESIGN CC-1，2026-07-01）把装备移到 `CardInstance.gear`（per-card），引擎 + 存档 + UI + 测试全迁移，**却漏了客户端战斗入口**：`createAppCore.goCampaign` 仍传旧模型 `unitLevels:{} / equipment:{gear:{},inv}`（`gear` 恒空），从不传 `cardInstances`。后果=引擎实跑 `buildCampaignBlueprints([], undefined)` 裸蓝图，**卡等级/装备对战斗数值零作用**，`UnitView.gearSpecsFor` 读废弃字段 → **立绘永远画不出装备**（旧字段靠对象展开绕过 TS 多余属性检查，编译期无警告）。

落地（纯客户端）：
- `cardDefs.ts` 新增 `toEngineCardInstances(cardInv)`：`SaveData.cardInv` → `EngineCardInstance[]`，由 defId 经 `CARD_DEFS` 解析 unitType，转发 level + gear。
- `matchEngine.ts` / `GameScene.ts`：opts 去掉废弃的 `pveUpgrades/unitLevels/equipment(EngineEquipmentInput)`，改 `cardInstances`+`equipmentInv`，一路转发给引擎（数值）与 renderer（叠加）。
- `createAppCore.goCampaign`：传 `cardInstances: toEngineCardInstances(save.cardInv)` + `equipmentInv: save.equipmentInv`（PvE-only；PvP/tutorial/goGame 不传 → 硬墙不变）。
- `GameRenderer` / `UnitView`：字段由 `EngineEquipmentInput` 迁到 `cardInstances`+`equipmentInv`；`gearSpecsFor` **镜像引擎选卡规则**（`buildCampaignBlueprints` 同兵种取最高等级卡）后读该卡 per-card gear → `{slot,rarity}`，保证画出的装备与实际生效的词条一致。仍限 `PLAYER_EQUIPPABLE_UNITS`，仍 memoize。
- 测试 harness `HeadlessAppViews.showGame` 同步转发新字段。

废弃：旧 `byUnit/global` loadout 概念随本切片彻底作废（per-card 取代，穿戴 UI 已在 CC-3 的 CardScene/EquipmentScene）；`EngineEquipmentInput` 仅保留为向后兼容类型别名，新代码不用。验证：client `tsc --noEmit`(含 test) + webpack 生产构建全绿；equipment/hardwall/progression 单测 38 全过。

### 20.8 实现记录（2026-07-17，✅）— 装备图标统一出处（buildEquipIcon）

背景：§20.2 引入了 AI 位图图集（`client/src/assets/equipment/equipment.{png,json}`，12 帧按 defId 命名，boot 时经 `bootManifest.ts` 的 `equip:atlas` 加载），`getEquipIconTexture(defId)` 解析。但各界面**各自决定用图集还是 §20.3 手绘 glyph**：只有 `EquipmentScene`/`CardScene` 走「图集优先→glyph 兜底」，而**抽卡（结果卡+概率表）、拍卖行（列表+挂单选择器）直接调 `drawEquipmentGlyph`**，从不查图集。`drawEquipmentGlyph` 只认 slot+rarity、无视 defId，导致同一件装备在装备包显示专属位图、在抽卡/拍卖显示同槽位同稀有度的通用草图——**同物不同图**。

落地（纯客户端，零新资产）：`render/equipmentAtlas.ts` 新增唯一解析器 `buildEquipIcon(defId, slot, rarity, size, seed): PIXI.Container`——图集就绪且 defId 已知返回 `Sprite`（anchor 0.5、scale `size/128`），否则返回 §20.3 procedural glyph；原点居中，调用方只设 `x/y/alpha`。全部 5 处图标绘制统一走它：`GachaScene.drawEntryPicture`、`AuctionScene` list/picker、`EquipmentScene.addGlyph`、`CardScene` detail（后两者删去各自重复的图集处理代码）。

铁律：今后任何装备图标绘制点**必须调 `buildEquipIcon`**，禁止直接 `drawEquipmentGlyph`。`EquipDef.media` 字段对渲染是死字段（无解析器读它）。验证：client `tsc --noEmit` + webpack 构建全绿（因后端未起未做游戏内截图；渲染路径与既有可用的装备包一致）。

### 20.9 实现记录（2026-07-17，✅）— 锻造格按稀有度分组

背景：`craftableDefs()`（`client/src/game/meta/equipmentDefs.ts`）此前按 `EQUIPMENT_DEFS` 声明顺序返回（先按槽位 weapon/armor/trinket 分组，槽位内再按稀有度），锻造 tab（`EquipmentScene/craft.ts`）不做二次排序、直接按数组顺序铺格子——4 列网格下第一行变成「铅笔(普通/武器)、钢笔(精良/武器)、马克笔(稀有/武器)、稿纸(普通/防具)」，稀有度视觉上没有分组，用户截图指出与预期不符。

落地：`craftableDefs()` 加一次按稀有度的**稳定排序**（`common→fine→rare→epic`，与 `RARITY_COLOR` 键序一致），槽位内原顺序不变。9 件可锻造装备现按 3 普通/3 精良/3 稀有连续输出，4 列网格下每行稀有度一致。新增 `client/test/equipmentDefs.test.ts` 固化排序 + craftCost 过滤两条不变量。验证：client `tsc --noEmit` 全绿 + 新测试通过；因本机会话无后端未做游戏内截图，改动本身是纯数据排序，用脚本直接打印排序结果核对。

### 20.10 实现记录（2026-07-18，✅）— 材料图标位图化（scrap/lead/binding）

背景：§20.5 把材料（scrap/lead/binding）图标做成 `SketchPen` **程序绘制、零位图**。但装备本体早已在 §20.2 换成 AI 位图图集（`buildEquipIcon`，§20.8 统一出处），导致装备页里「装备本体是彩色位图、三个材料余额却是灰扑扑的程序 glyph」的观感割裂——抽卡结果卡/概率表里材料同样只有 glyph。用户走查确认「位图缺失」。

资产：3 张 AI 手绘位图（notebook 风、透明底、墨线描边）——scrap=撕纸+铅笔屑、lead=三根石墨条捆麻绳、binding=紫色螺旋线圈。源图放 `art/ui/material/`，`build-atlas.js`（仿 `art/ui/equipment/build-atlas.js`，`sharp` 先 `.trim()` 去透明边再 `contain` 到 128²）打成 `client/src/assets/material/material.{png,json}`（384×128，3×1，frame 名 = `scrap`/`lead`/`binding`，即 EquipmentScene 短 id、也是 `GachaScene.MATERIAL_ICON` 的目标 kind）。

接线（纯客户端）：新增 `client/src/render/materialAtlas.ts`——`loadMaterialAtlas()`（boot `material:atlas` 步，非致命）+ `getMaterialIconTexture(kind)` + `buildMaterialIcon(kind,size,color)`（图集就绪返回 `Sprite`，否则回退 §20.5 的 `buildIcon` glyph，与 `buildEquipIcon` 同款「位图优先→glyph 兜底」契约，原点为左上角 `size×size`）。三处调用改走它：`GachaScene.drawEntryPicture`（材料分支）、`EquipmentScene/base.ts` 的 `renderMaterialsBand`（顶部余额条）与成本 chip 闭包（coin 仍走 `buildIcon`）。

验证：client `tsc --noEmit` + 生产 webpack 构建全绿；dev server（9090）运行态经 webpack chunk 反射拿到 PIXI `TextureCache`，确认 `scrap/lead/binding` 三帧 `valid` 且 128²、源图 384×128、逐帧非空（scrap 68 色/luma 9–255 证明是真插画非纯色块）。因材料图标深藏抽卡/装备页需登录+后端，用运行态贴图内省替代逐屏截图。

