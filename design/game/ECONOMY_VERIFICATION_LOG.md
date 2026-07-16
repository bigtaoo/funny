# 经济数值核验记录（ECONOMY_VERIFICATION_LOG）

> 本文承接 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) 的数值定义，登记 econ-sim 各轨（NATION/CITY/C/D/E/F/STRONGHOLD）的核验过程与结论——均已标注「已过核验」/CLOSED，属一次性验证记录而非持续调参的数值权威。章节号延续主文档编号（§13-SLG-*），**不重新编号**，外部引用把文件名从 `ECONOMY_NUMBERS.md` 换成本文件即可定位到同一节。数值权威（可调参数表本身）仍以 `ECONOMY_NUMBERS.md` 为准。

## 13-SLG-NATION. 国民产出加成核验（B 轨「裸经济不破」·纯季内·不进 §6.1）`[已过核验 2026-07-05，用 500×500 + 三层环带布局重跑]`

> **ADR-032/ADR-033 影响**：本节 §13-SLG-NATION.2 曾在 300×300 地图（`resourceDensity=0.34`，8 周边+1 内环+1 中心的旧布局）上跑；2026-07-04 地图尺寸改定 500×500 + `resourceDensity` 改 1.0（ADR-032），2026-07-05 10 首府改为 6 外围+3 资源+1 霸业三层同心环布局（ADR-033）后，已用 `server/tools/econ-sim` 在新参数上重新核验，见下方 §13-SLG-NATION.2 新数字。`②` 边际损益（纯数学）和 `③` 策略差距的判据结构性只依赖 `NATION_BONUS_PRODUCTION=0.10`，与地图尺寸/布局无关，结论不变；只有 `①` Voronoi 几何（格数/占比）随新布局改变。

> 核验方法：[`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) §4 第 1 条；工具：`server/tools/econ-sim/src/nationBonus.ts` + `nationBonusRun.ts`（纯 TS，import `@nw/shared`，无连库）。跑法 `npx tsx src/nationBonusRun.ts`。
> **铁律**：`NATION_BONUS_PRODUCTION` 只影响赛季资源（粮铁木，季末清零），**零持久沉淀，永不进 §6.1 月度金币预算**（§0.1）。

### 13-SLG-NATION.1 可调参数（`@nw/shared/slg.ts`）

| 常量 | 值 | 作用 |
|---|---|---|
| `NATION_BONUS_PRODUCTION` | **0.10**（+10%） | 玩家自占首府 Voronoi 区内格产率加乘；`recomputeYield` 逐格 `nearestCapitalIdx` 命中己方首府集合则 ×1.10 |
| `NATION_COUNT` | 10 | 首府数 = Voronoi 区数；10 国民 |
| `CAPITAL_FRACTIONS` / `NATION_KIND_BY_IDX` | 见 slg.ts | ADR-033 三层同心环：6 外围（正六边形，半径 0.40，idx 0-5）+ 3 资源（正三角形，半径 0.20，交错 30°，idx 6-8）+ 1 霸业（地图中心，idx=9，赛季争夺目标，即 `CENTER_CAPITAL_IDX`） |

### 13-SLG-NATION.2 演算（econ-sim B 轨「裸经济不破」，2026-07-05 用新布局重跑）

**① Voronoi 几何（代码导出，零假设）**

500×500 地图 = 250,000 格；资源格 250,000（`resourceDensity=1.0`，ADR-032 起无纯空地）。各国面积：

| 首府 idx | 类型 | 分位 | 格数 | 坐标 |
|---|---|---|---|---|
| 0 | 外围 | 10.3% | 25,635 | (0.50,0.10) |
| 1 | 外围 | 13.4% | 33,531 | (0.85,0.30) |
| 2 | 外围 | 13.4% | 33,532 | (0.85,0.70) |
| 3 | 外围 | 10.3% | 25,633 | (0.50,0.90) |
| 4 | 外围 | 13.4% | 33,527 | (0.15,0.70) |
| 5 | 外围 | 13.4% | 33,600 | (0.15,0.30) |
| 6 | 资源 | 6.9% | 17,325 | (0.60,0.33) |
| 7 | 资源 | 6.9% | 17,235 | (0.60,0.67) |
| 8 | 资源 | 7.0% | 17,477 | (0.30,0.50) |
| 9 | 霸业 | **5.0%** | **12,505** | (0.50,0.50) ← 最小国，赛季争夺目标 |

范围：12,505–33,600 格/国（均值 25,000）；最小国（霸业，idx=9）= 均值 50%，最大国（外围）= 均值 134%。资源格密度 100%，故"每国资源格"= 每国总格数。

**② 边际损益（纯数学，零假设）**

```
本国格 yield = RESOURCE_YIELD_BASE × level × 1.10
他国格 yield = RESOURCE_YIELD_BASE × foreignLevel × 1.00
跨国扩张收支相等条件：foreignLevel > homeLevel × 1.10
```

| homeLevel | 损益平衡 foreignLevel | 含义 |
|---|---|---|
| 2 | **2.20** | 他国格只需比本国高 10% 即值得扩张 |
| 3 | **3.30** | 均值 3 的地图中，L4 他国格（+33%）轻松超此门槛 |
| 4 | **4.40** | 已接近地图最高级（L5），仅最顶级格才有优势 |
| 5 | **5.50** | 超出 L5 上限 → 满级本国格永远优于满级他国格 |

**③ 策略差距（显式假设驱动；等格数比较）**

两种策略持相同格数（tileCap=50）；homeAvgLevel=3；差距 = (本国策略产出 − 跨国策略产出) / 跨国策略产出。

| 场景 | 本国 /h | 跨国 /h | 差距 | 结论 |
|---|---|---|---|---|
| 等级持平 / 50-50 分割 | 16,500 | 15,750 | **+4.8%** | ✅ PASS |
| 等级持平 / 20-80 分割 | 16,500 | 15,300 | **+7.8%** | ✅ PASS |
| 等级持平 / 全跨国 | 16,500 | 15,000 | **+10.0%** | ✅ PASS |
| 他国 +10% 等级 / 50-50 | 16,500 | 16,500 | **+0.0%** | ✅ PASS |
| 他国 +10% 等级 / 全跨国 | 16,500 | 16,500 | **+0.0%** | ✅ PASS |
| 他国 +20% 等级 / 50-50 | 16,500 | 17,250 | **−4.3%** | ✅ PASS（跨国反胜）|
| 他国 +20% 等级 / 全跨国 | 16,500 | 18,000 | **−8.3%** | ✅ PASS（跨国反胜）|

### 13-SLG-NATION.3 结论与注记

1. **B 轨裸经济不破 ✅ PASS（结构性保证）**：本国策略最大优势 = `NATION_BONUS_PRODUCTION = 10%`，恒低于判据阈值 20%。11 个场景全 PASS，差距范围 −8.3%（跨国反胜）到 +10.0%（等级持平满跨国），**加成永远不可能超过 20%**。
2. **设计意图达成**：+10% 加成足够让本国格有价值（激励防守），但他国高等级格（地图 L4–5 抢手区域 vs 本国均值 L3）可轻松超过损益平衡点（+10%），使跨国扩张在经济上成立。加成「引导回家」但「不锁死玩家」，大世界争夺动机完整。
3. **小国（idx=9，霸业中心，12,505 格）压力最大——ADR-033 后与旧布局相反**：三层同心环下最小国变成了地图正中心的霸业国（均值 50%），不再是旧布局里的内环角落国；霸业国玩家更早被迫跨国扩张——属设计意图内的差异化张力，且霸业首府本就是赛季争夺目标，高密度竞争会进一步压低个人实际持格数，与"小国压力大"是同一件事的两面，不构成问题。
4. **外围国（idx 0-5）领地最大**：正六边形外环 6 国占地 10.3-13.4%（均值 134%），资源国（idx 6-8）居中（均值 69%）——三层环带天然形成"外围地广人稀、中环适中、中心地窄兵凶"的梯度，符合三战式版图直觉。
5. **零持久影响**：赛季资源季末全清，本核验与 §6.1 月度金币预算完全解耦。

### 13-SLG-NATION.4 经济约束（红线复述）

- `NATION_BONUS_PRODUCTION` 只作用于赛季资源产出，不作用于 `coins` / 持久材料 → **永不进 §6.1**。
- 加成判定在 `recomputeYield`（生产侧）和 `applySiege`（防御侧），皆不读 `buildPvpBlueprints` → **PvP 红线完整**。
- 数值 DRAFT：上线后盯紧「本国格占比 vs 跨国格占比」分布（analyticsvc），若本国占比 >70% 且争夺动机明显萎缩，考虑调低加成（inertia：下季生效）。

---

## 13-SLG-CITY. SLG 主城建筑 / 练兵节奏数值（B 轨·纯季内·不进 §6.1）`[已过 B 轨建筑节奏核验 2026-06-30]`

> 机制权威：[`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md)；核验方法 = [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) §4（B 轨第 2 条「建造/练兵节奏」）；本节为 **SLG_CITY DRAFT 数字单一源** + econ-sim 结论。常量真源 = `server/shared/src/slg.ts`。
> **铁律**：主城建筑/兵力/赛季资源**季末全清**（D-CITY-1 / SLG4），**零持久 faucet/sink**——本节是**纯季内节奏**，**永不进 §6.1 月度金币预算**，建筑**绝不喂 `buildPvpBlueprints`**（天梯红线 D-CITY-6）。coin 只买**速度**（加速变现）不买**上限**（防 P2W）。

### 13-SLG-CITY.1 可调参数表（`@nw/shared/slg.ts`，全 DRAFT）

| 常量 | 默认 | 作用 |
|---|---|---|
| `DESK_MAX_LEVEL` | 20 | 书桌总等级门控（其余建筑 ≤ desk）|
| `BUILD_YIELD_STEP` | 0.05 | inkPot/paperTray/graphiteMill/metalForge 每级 +5% 该地块产率 |
| `STICKER_SELF_BASE` | 200 | stickerShop 每级自产 sticker/h（民居模型，sticker 无地块）|
| `CABINET_CAP_STEP` | 0.10 | cabinet 每级 +10% 仓储上限 |
| `DRILL_TROOPCAP_STEP` | 500 | drillYard 每级 +500 troopCap |
| `DRILL_TRAIN_SPEED_STEP` / `_FLOOR` | 0.04 / 0.5 | drillYard 每级 −4% 训练时长，乘子下限 0.5 |
| `DRILL_QUEUE_PER_LEVELS` | 5 | drillYard 每 5 级 +1 训练队列槽 |
| `BUILD_QUEUE_SLOTS` | 1（付费 2）| 建造并发槽 |
| `BUILD_TIME_BASE_SEC` / `DESK_BUILD_TIME_MULT` | 120 / ×5 | 建造时长 = base × toLevel（desk ×5）|
| `BUILD_SPEEDUP_SECS_PER_COIN` | 60 | coin 加速率（对齐 `TROOP_SPEEDUP_SECS_PER_COIN`）|
| `BUILD_COST_BASE[key]` | 见 slg.ts | 每建筑 5 资源基底，`buildCost(toLevel)=base×toLevel` 线性曲线 |
| `RESOURCE_CAP` / `RESOURCE_YIELD_BASE` | 200,000 / 100 | 单资源仓储上限 / 每格每级每小时基底产 |
| `TROOP_TRAIN_INK_COST` / `_TIME_SEC` | 10 / 5 | 每兵 ink 成本 / 训练秒 |

### 13-SLG-CITY.2 演算（econ-sim B 轨，2026-06-30）

工具：`server/tools/econ-sim/src/city.ts` + `cityRun.ts`（纯 TS，import `@nw/shared` 建筑常量/纯函数，**与代码永不脱节**）。跑法 `npx tsx src/cityRun.ts`。**硬结论靠代码导出的总量/比值/成长量；income 档是显式假设**（领地格数设计未 pin，同 A 轨人口口径）。

**① 满建全 8 个 P1 建筑到 L20 的总成本（代码导出，零假设）**：

| 资源 | 总需 | ÷RESOURCE_CAP | 含义 |
|---|---|---|---|
| paper | 1,546,600 | **7.7×** | **承重肝点**：远超仓储上限 → 必须长线攒、攒不住 |
| graphite | 334,400 | 1.7× | 次肝点（高级建筑 sink）|
| sticker | 188,100 | 0.9× | 仅自产（无地块）+ 同时是 sink → 自我门控 |
| metal | 146,300 | 0.7× | drillYard/metalForge |
| ink | 62,700 | 0.3× | 仅 inkPot 吃，几乎不构成 gate |

**② 建造时长（串行 queue=1）**：满建全城 **83.6 h ≈ 3.5 天**；全程 coin 跳过 = **5,016 coins**。→ 时间是**次要门控**（真门控是资源），coin 加速建造是**温和杠杆**，更深变现走资源包（commercial，§7.2）。

**③ 满级成长量（乘子合理性）**：产率 1→2.0×；仓储 200k→600k；troopCap 2,000→12,000（6×）；训练时长 1→0.5×（下限，**drillYard L13 起触底**）；训练队列 →6；sticker 自产 →4,000/h。

**④ days-to-max（按 income 档，假设驱动·示意）**：

| 档 | paper | graphite | sticker | metal | ink |
|---|---|---|---|---|---|
| casual | 30.5 | 13.2 | 19.6 | 5.8 | 2.5 |
| active | 7.5 | 3.8 | 9.8 | 1.6 | 0.7 |
| hardcore | 2.4 | 1.3 | 6.5 | 0.6 | 0.3 |

> 三档满城关键资源均落在 **60 天赛季窗口内**：casual 半季、active ~1–1.5 周、hardcore 数日。casual 的**慢点是 paper(~30d) 与 sticker(~20d)**——sticker 因无地块、靠 stickerShop 自产又被 sink 吃，是低活跃玩家的节奏瓶颈（设计意图内的 faucet/sink 张力）。

**⑤ 练兵节奏**：drillYard L20 满 troopCap 12,000 → 填满需 **120,000 ink、连续 8.3 h，或 500 coins 跳过**。落在赛季窗口内、与 ink 几乎不 gate 的产出匹配。

### 13-SLG-CITY.3 结论与注记

1. **B 轨建筑节奏 ✅ PASS**：建筑成本是**资源门控**（paper 7.7× cap，必须长线攒）而非时间门控——满城 = 数周持续季内肝，落在 60 天「重肝」窗口内（casual 半季 / active 周级 / hardcore 数日），成长乘子全部有界合理。coin 加速建造是温和时间杠杆（全跳 5,016c），更深变现归资源包。**符合「重肝变现发动机」设计，无数量级错误。**
2. **注记 a（informational）·drillYard 提速 L13 触底**：`DRILL_TRAIN_SPEED_STEP=0.04` × L13 = −52% 已撞 `_FLOOR=0.5`，**L13–20 七级不再提速**（只加 troopCap/队列）。非 bug，但高级 drillYard 的「提速」价值悬崖——后续若想让满级提速更顺，降 floor 或减小 step；当前可接受（高级靠 cap/队列出价值）。
3. **注记 b（informational）·sticker 自我门控**：sticker 唯一 faucet = stickerShop 自产、且被 desk/cabinet/drillYard 当 sink 吃，低活跃档是第二慢资源（~20d）。设计意图内的 faucet/sink 张力，盯上线实测。
4. **B 轨另一半「裸经济不破」✅ 已核（2026-06-30）**：`NATION_BONUS_PRODUCTION=0.10` 本国全占 vs 跨国扩张产出差最大 10%（≤ 判据阈值 20%），属国民加成、非城建数值，结论见 [§13-SLG-NATION](ECONOMY_VERIFICATION_LOG.md)；SLG_ECONOMY_CHECK §9 B 轨已全打 ✅。
5. **免费 vs 满氪节奏差距（2026-07-15 补，用户要求量化）**：给 `SLG_SHOP_ITEMS` 补每日购买上限后（SLG_DESIGN §7.2），`cityRun.ts` §4b 量化了"每天氪到封顶"能把 casual 档的建城天数压缩多少——每天最多买满 `slg_res_s/m/l` 各 5 次共 **21,500 coins/日**，换来**每种资源 +1,500,000/日**（叠加在免费产出上）。casual 档最慢的 paper（免费 30.5 天）压到 **1.0 天**；graphite/metal/sticker 全部压到 **≤0.2 天**。**这条差距本身不是"破防"**（赛季资源无持久沉淀，§0.1 红线不适用；花的是充值币不是白嫖），是"付费=省时间"设计意图的量化确认，量级合理（不是"1 分钱通关"级别的失控）。**未覆盖的口子**：`speedupTraining`/建造用 `BUILD_SPEEDUP_SECS_PER_COIN` 直接拿币换时间，这条**没有购买次数上限**（本次只加了 §7.2 的商品购买次数上限，没有改这条直接换算接口），理论上币多就能无限跳过训练/建造时间——留作后续（若要补，思路是给 `speedupTraining`/建筑加速也上每日总秒数上限，而不是每次购买次数）。

### 13-SLG-CITY.4 经济约束（红线复述）

- 建筑/兵力/赛季资源**季末全清**，零持久沉淀 → **不进本节金币账本、不进 §6.1**。
- coin 只买**建造/练兵速度**（`*_SPEEDUP_SECS_PER_COIN`），**不买上限**（上限由 desk 等级门控、desk 靠资源+时间，P2W 硬墙 D-CITY-6）。
- 建筑产出**绝不喂 `buildPvpBlueprints`**（天梯零养成参，§9 硬墙）。
- 数值 DRAFT：终态判据 = 上线后 analyticsvc 实测（满城天数 / 各资源攒速 / drillYard 分布）对账，偏差回 SLG_ECONOMY_CHECK §10 重跑（惰性下季生效）。

---

## 13-SLG-C. 围攻均衡性 & SIEGE_CHEAP_RATIO 核验（C 轨）`[已过核验 2026-06-30]`

> 脚本：`server/tools/econ-sim/src/siegeRun.ts`；模型：Lanchester 线性（`resolveSiege + nationDefenseStrength`，与 worldsvc `applySiege` 生产路径一致）。

### 13-SLG-C.1 NATION_BONUS_DEFENSE 攻方胜率

| 参数 | 值 | 来源 |
|---|---|---|
| `NATION_BONUS_DEFENSE` | 0.15 | `@nw/shared/slg.ts` |
| 攻方胜率（模拟，U[100,2000]）| **43.0%** | 5 seeds × 20k 样本 |
| 攻方胜率（模拟，U[100,500]）| **40.4%** | 5 seeds × 20k 样本 |
| 理论上限（连续 U[0,∞]）| 1/(2×1.15) ≈ **43.5%** | 解析 |
| 验收区间 | 40–55% | SLG_ECONOMY_CHECK §5 |

**结论**：本国防御 +15% 有效驻军带来适度主场优势，攻方以「等兵」仍有约 43% 胜率——不使本国土地坚不可摧。U[500,2000]（窄范围，信息性）因分布宽幅比约束跌至 39.4%（有界分布效应），不计入门控判据。

### 13-SLG-C.2 SIEGE_CHEAP_RATIO 阈值分类

| 参数 | 值 | 说明 |
|---|---|---|
| `SIEGE_CHEAP_RATIO` | 10 | `@nw/shared/slg.ts`（当前未在生产路径触发） |
| 误判率（4 基准值 × 391 样本）| **0%** | 结构性保证 |
| 验收标准 | ≤ 1% | SLG_ECONOMY_CHECK §5 |

**结构性证明**：`atk/defEff ≥ 10 ⇒ atk > defEff ⇒ resolveSiege = 'attacker_win'`（Lanchester 线性确定性，无随机）。正常激战（ratio < 10）样本结果混合（非总为攻方胜）→ 引擎路径正确执行。

---

## 13-SLG-D. 宗门实力分配公平性核验（D 轨）`[已过核验 2026-06-30]`

> 脚本：`server/tools/econ-sim/src/sectorRun.ts`；验证 `allocateSectsToShards`（蛇形选秀）+ `sectStrengthScore`（`@nw/shared`）。

### 13-SLG-D.1 蒙特卡洛结果

| 配置 | seeds | 判据 | 结果 |
|---|---|---|---|
| sects=10, shards=2 | 10 | 极差 ≤ 最强单体 | **10/10 ✅** |
| sects=50, shards=3 | 10 | 同上 | **10/10 ✅** |
| sects=100, shards=4 | 10 | 同上 | **10/10 ✅** |
| sects=200, shards=5 | 10 | 同上 | **10/10 ✅** |
| sects=500, shards=8 | 10 | 同上 | **10/10 ✅** |
| sects=1000, shards=10 | 10 | 同上 | **10/10 ✅** |

典型极差约为最强宗门得分的 **10–15%**（远 < 单体上限）。

### 13-SLG-D.2 权重灵敏度

`sectStrengthScore = rankScore(0–9900) + memberFamilyCount×50 + floor(prosperity/100)`

- **基准（全权重）**：极差 1,401，最大单体 11,160 → **✅ PASS（门控）**
- `rank-only`（单排名维度）：极差 7,953 < 9,800 → ✅（排名单独仍可维持保证）
- `members-only` / `prosperity-only`：极差 >> 最大单体 → 信息性 ❌（预期：去掉排名主稳定器后退化；**证明了多维权重设计的必要性**）

**结论**：蛇形选秀在全权重下保证任意 shard 对总实力极差 ≤ 最强宗门分值；排名维度是公平分配的主稳定器。

---

## 13-SLG-E. 繁荣度可达性与衰减核验（E 轨）`[已过核验 2026-06-30]`

> 脚本：`server/tools/econ-sim/src/prosperityRun.ts`；纯函数 `familyProsperity + decayProsperity`（`@nw/shared`）。
> 设计注记（`slg.ts`）：30 成员 + 30 地块 ≈ 1800 基础分，需 ~40 活跃值。

### 13-SLG-E.1 活跃中位家族建宗门天数

| 档位 | 起始成员 | 占地速率 | 活跃速率 | 建宗门天 | 结果 |
|---|---|---|---|---|---|
| active-median（门控）| 20 → 35（14d） | 3.5 地/天 | 4 点/天 | **第 9 天** | ✅ 7–14 窗口 |
| casual | 8 → 18（14d） | 1.5 地/天 | 1.5 点/天 | **第 49 天** | 📌 休闲节奏（设计内） |
| hardcore | 30 → 45（14d） | 6 地/天 | 8 点/天 | **第 4 天** | 📌 偏快（可接受） |

活跃中位家族（20 人起/每天招募/中等占地）**第 9 天**可触发建宗门，在 7–14 天设计窗口内。

### 13-SLG-E.2 繁荣度权重比

| 维度 | 权重 | 第 9 天占比 |
|---|---|---|
| `PROSPERITY_W_MEMBER=50` | member×50 | **75%** |
| `PROSPERITY_W_TERRITORY=10` | territory×10 | **16%** |
| `PROSPERITY_W_ACTIVITY=5` | activity×5 | **9%** |

member ≫ territory > activity — "人比地重要"设计意图 ✅。

### 13-SLG-E.3 零活跃衰减

| 起始分 | 跌破门槛天数 | 说明 |
|---|---|---|
| 2000（刚达线） | **1 天** | 预期行为：刚够线必须持续活跃才能建 |
| 2500 | 5 天 | 📌 信息性（4 天周末缓冲）|
| 3000（门控） | **8 天** ✅ | ≥ 7 天判据通过 |
| 4000 | 14 天 ✅ | |
| 5000+ | 18+ 天 ✅ | |

**门控判据**：从 ≥3000 分（活跃家族运营分）开始，≥7 天零活跃才跌破门槛 → ✅。
`decayProsperity` 惰性结算：家族有任意新动作（占地/入队/战斗）时**重新满分计算**，衰减仅在完全无操作期间积累。周常活跃玩家不观测到衰减。

---

## 13-SLG-F. WORLD_CAPACITY / RESET_DELETE_BATCH 工程估算（F 轨）`[已过核验 2026-06-30]`

> 脚本：`server/tools/econ-sim/src/capacityRun.ts`；工程估算（非经济门控），待预发压测确认。
> **2026-07-05 复核**：脚本此前把地图尺寸/资源密度硬编码成 `300×300`/`0.34`（未跟 ADR-032 的 500×500/1.0 同步），已改为 import `SLG_MAP_W/H`/`SLG_GEN.resourceDensity`。重跑后下方数字**没有变化**——文档数量估算按"每玩家territory/march/family 数"（`TILES_PER_PLAYER_*` 等）乘 `WORLD_CAPACITY`，不依赖地图总格数（稀疏存储的必然结果：地图大小只影响格子密度体验，不影响持久化文档量），所以本节结论在旧硬编码下碰巧仍然正确，`已过核验 2026-06-30` 标签维持有效。

### 13-SLG-F.1 单 shard 文档量（WORLD_CAPACITY=10000）

| 文档类型 | 中位数量 | 峰值数量 |
|---|---|---|
| PlayerWorldDoc | 10,000 | 10,000 |
| TileDoc（已占地块） | 200,000 | 500,000 |
| FamilyDoc | 500 | 500 |
| FamilyMemberDoc | 10,000 | 10,000 |
| MarchDoc（在途） | 20,000 | 40,000 |
| SiegeDoc（录像） | 5,000 | 20,000 |
| NationDoc | 10 | 10 |
| SectDoc | 50 | 50 |
| AuctionDoc | 500 | 1,000 |
| **合计** | **246,060** | **581,560** |

TileDoc 占大头（20–50×/玩家），`proceduralTile()` 按需计算未占地块，只持久化已主张/修改地块。

### 13-SLG-F.2 关键查询

| 查询 | 扫描文档 | 索引 | 估算延迟 |
|---|---|---|---|
| 家族繁荣度排名（季末一次） | ~500 | worldId + prosperity | < 5ms |
| 视口地块范围查 | ~2,000 | worldId + (x,y) | < 5ms |
| 行军到达轮询 | ~20,000 | worldId + arriveAt | < 10ms |
| 玩家状态点查 | 1 | _id | < 2ms |
| 全 shard 产出重算（国改时，罕见） | ~200,000 | worldId | < 50ms |

所需索引：`(worldId+x+y)` / `(worldId+arriveAt)` / `(worldId+prosperity)`。

### 13-SLG-F.3 RESET_DELETE_BATCH 清档估算

| 场景 | 文档数 | 批次 | 清档时间 |
|---|---|---|---|
| 中位活跃度 | 246,060 | 124 | **1.9s** |
| 峰值活跃度 | 581,560 | 291 | **4.4s** |

`BATCH=2000`：减少往返次数（124 次中位），单次写操作短（< 20ms），避免长时间锁竞争。最坏情况 < 5s，远在赛季重置离线窗口内。

### 13-SLG-F.4 内存占用

活跃层缓存（20% 在线率，2000 活跃玩家）：**≈ 36 MB / shard**。单 VPS 实例（2–4 GB RAM）可承载 28–56 个 shard → ✅ 充裕。

**注**：F 轨为工程估算，正式压测在预发布阶段：对 staging 注入 10k 合成玩家，`explain()` 对账上述查询延迟。

---

## 13-SLG-STRONGHOLD. 险地生成 / 掠夺数值核验（§21.4 STRONGHOLD_*）`[已修复·CLOSED 2026-07-02，已用 500×500+等级10 重跑 2026-07-05]`

> 脚本：`server/tools/econ-sim/src/stronghold.ts` + `strongholdRun.ts`（`npx tsx src/strongholdRun.ts`）。用**真实生成器** `proceduralTile` 在真实地图（`SLG_MAP_W×SLG_MAP_H`，动态 import，随 ADR-032/033 自动跟新）跨 100 个世界种子实测，非手估密度。**2026-07-05 用 500×500 + `SLG_MAP_MAX_LEVEL=10`（ADR-032）+ 三层环带布局（ADR-033）重跑**，下表已更新为新数字；结论（PASS/CLOSED）不变。
>
> **为何单列**：险地占领发**持久**养成材料 `binding`（`applyStrongholdSiege` → `strongholdMaterialLoot` → `meta.grantMaterial`，`worldsvc/src/service.ts:1789-1790`）——这是 A 轨聚合（`index.ts`，只数 `SETTLE_REWARDS`+细水）**从未计入**的一条持久龙头。故按 A 轨 §2.3 15% 人均稀释判据核。季资源掠夺（`5000×level` 到单一 resType）与 NPC 守军（`360×level`）属季内/战斗面，一并 sanity。
>
> **修复（2026-07-02）**：险地判定从平滑 value-noise 换成**逐格哈希** `rand2(x,y,seed^0x0555) > strongholdThreshold`（`shared/slg.ts`，merge-first / rule 4），阈值 `0.92 → 0.997`，删去无用的 `SLG_GEN.strongholdFreq`。①②③三项由 FAIL/CONDITIONAL 全转 **PASS**（下表 = 修复后实测）。

### 13-SLG-STRONGHOLD.1 可调参数（`@nw/shared/slg.ts`）

| 参数 | 现值 | 含义 |
|---|---|---|
| `SLG_GEN.strongholdThreshold` | `0.997` | **逐格** hash `rand2(x,y,seed^0x0555)` > 此值 → 险地；= 逐格 Bernoulli(p=1−0.997=0.003) 抽样 |
| `SLG_GEN.strongholdMinDistRatio` | `0.25` | 中心 25% 半径内不生成（护新手） |
| ~~`SLG_GEN.strongholdFreq`~~ | ~~`1/70`~~ | **已删**：逐格哈希不用频率（旧平滑噪声遗留） |
| `STRONGHOLD_GARRISON_PER_LEVEL` | `360` | 每级 NPC 守军 → level **10**（地图上限，ADR-032 起 5→10）险地 = **3,600 兵** |
| `STRONGHOLD_LOOT_PER_LEVEL` | `5000` | 每级季资源掠夺 → level 10 = **50,000**（单 resType，一次性，季末清零） |
| `STRONGHOLD_LOOT_MATERIAL(_PER_LEVEL)` | `binding` / `4` | 每级持久材料掠夺 → level 10 = **40 binding**（进 SaveData，**持久**） |

### 13-SLG-STRONGHOLD.2 演算（100 种子，2026-07-05 用 500×500+等级10 重跑）

**① 险地数量分布**（250,000 格地图）：

| 统计 | min | p10 | 中位 | 均值 | p90 | max |
|---|---|---|---|---|---|---|
| 险地数 | 504 | 527 | 567 | 565 | 603 | 636 |
| 占图比 | 0.202% | — | 0.227% | — | 0.241% | 0.254% |

- **变异系数 CV = 0.05**（≤ 0.50 ✅）；**0% 零险地世界**（≤ 5% ✅）；中位密度 0.23% 命中"~0.3% 极稀疏"意图（2 倍以内）。
- **② blob 聚团**：连通域分析（4 邻）平均 blob **= 1.0 格**（< 2 ✅）——险地为孤立战略点，符合设计。
- 逐格哈希机制不变（`rand2(x,y,seed^0x0555) > 0.997`），地图从 90,000 格扩到 250,000 格，绝对数量按比例从 ~236 涨到 ~567（密度 0.23-0.26% 基本持平，CV/blob 结论不受地图尺寸影响，符合逐格 Bernoulli 抽样的数学期望）。

**③ 持久 binding 龙头 vs A 轨稀疏（判据 15%）**：单季人均稀释 = 世界 binding ÷ 400 人 ÷ 季常规刷量（504 binding/季）；等级上限 5→10 使单次掠夺 binding 从 20 翻倍到 **40**：

| 世界 | 占领率 25% | 50% | 100% |
|---|---|---|---|
| 中位（567） | 2.8% ✅ | 5.6% ✅ | 11.3% ✅ |
| p90（603） | 3.0% ✅ | 6.0% ✅ | 12.0% ✅ |
| max（636） | 3.2% ✅ | 6.3% ✅ | **12.6% ✅** |

> 占领率 = 一季内被打下的险地比例（受养成门控：base 2000 兵"几乎必败"，`slg.ts:1055`，实际 ≤ 50%）。人均按全服 400 人摊；binding 实际集中在少数能破 3,600 守军的 raider 手里，其个人稀释**高于**此摊薄值——即便 max 世界 × 100% 占领的摊薄峰值 **12.6%**（等级上限翻倍后比旧版 2.8% 高得多，但仍 < 15% 红线，余量收窄，值得后续留意）。

**④ 季资源掠夺 & 守军 sanity**：单次季资源掠夺 50,000 = `RESOURCE_CAP`(200,000) 的 25%（等级 10 后翻倍，仍封顶、季内、零持久）。守军 3,600 兵（level 10）+ 基地防守优势把险地锁在养成后段，是占领率 ≤ 50% 的天然限速器 ✅。

### 13-SLG-STRONGHOLD.3 结论

- **判决（500×500+等级10 重跑后）**：①密度/方差 **✅ PASS**（中位 0.23%，CV 0.05，0% 零险地，504→636 跨度）；②blob 聚团 **✅ PASS**（平均 blob 1.0 格）；③持久龙头 **✅ PASS**（全种子 × 满占领率稀释 ≤ 12.6% ≪ 15%，但比旧版 2.8% 余量明显收窄——等级上限翻倍是主因，非地图尺寸）；④季资源/守军 **✅ sane**。**STRONGHOLD TRACK 仍 CLOSED**，但 ③ 的红线余量值得记一笔，供未来再涨等级上限时参考。
- **修复历史**：`shared/slg.ts` 逐格哈希 + 阈值 0.997（2026-07-02，公共依赖，已按 rule 4 先合 main）；`p=0.003` 目标密度经经济负责人确认。
- **回归**：`stronghold.e2e.test.ts` 动态扫描险地格，逐格哈希下每世界 ≈567 险地、≥1 概率≈1，天然存活，已复验通过（worldsvc 210 例全绿）。

### 13-SLG-STRONGHOLD.4 经济约束（红线复述）

- 险地 binding 是**持久** faucet（进 SaveData.materials），与 §6.1 材料龙头同池——2026-07-05 用新地图/等级重跑后，最终密度（~567/世界）+ 等级10 翻倍单次掠夺下，binding 稀释峰值 **12.6%**，仍稳在 15% 内但余量比旧版窄了不少。
- 季资源掠夺季末清零、禁挂（[[project-currency-canon]]），不入持久经济。

