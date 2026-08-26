# Notebook Wars — 野外城池攻占设计（宗门级攻城）

> 状态：**P0/P1/P2 已落地（2026-08-25）**，P3（守方 + §8 三条收益接线）未开工。数值已经 econ-sim 实测标定；机制原案有三处被实测否掉，见 §5。· 权威：本文（野外城池机制基准）· 创建：2026-08-25
> 上级：[`SLG_DESIGN.md`](SLG_DESIGN.md)（大世界总纲，§3.1 城池节点 / §5 攻防模型）。本文把 SLG §3.1 里长期挂着「城池的驻军/耐久数值仍是 §5 待定项，本轮只做视觉」的那个缺口补完，并把它从「贴图」升级成一个有数据模型、有归属、有收益的玩法实体。
> 配套：[`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md)（**主城**内政，勿混淆——本文是**野外 NPC 城池**）、[`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md)（数字登记，本系统落 §13-SLG-CITYSIEGE）、[`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)（核验流程）、[`SOCIAL_DESIGN.md`](SOCIAL_DESIGN.md)（家族/宗门层级）。数值真源：`server/shared/src/slg/siege.ts`。
> 拍板：[ADR-074](../DECISIONS.md)（2026-08-25，用户当场四问四答）。

---

## 0. TL;DR

- **要解决的问题（用户 2026-08-25 报）**：「野外城池，只有加入帮会的人可以攻打。另外你验证一下城池的难度，别让一个玩家就打下来了。」
- **诊断结论比预想严重**：野外城池现在**完全是一张贴图**，不是「太容易打」而是**根本没有城池这个实体**。而且顺带查出一条更严重的：**一个中期玩家用一次普通 `occupy` 就能拿下整个州府并建国**（§1.4）。
- **一句话方案**：城池升级成实体，攻打门槛 = **有宗门**，难度靠**「耐久大 + 回复快」**——回复速度压住**单人持续输出**、耐久压住**单人一次性倾池**（两条判据都必须过，见 §6.2），于是单人在数学上永远打不下来；13 人（Lv.3）到 43 人（州府）同时打才在一小时内攻陷。
- **关键设计点**：单次攻城伤害 = `teamSiegeValue`（队内 12 张卡攻城值之和），**不随兵力放大**。这个既有特性是「人多才打得下」能成立的前提——否则一个大号堆兵就能顶几十人。
- **数值已实测标定**（2026-08-25，`server/tools/econ-sim/src/citySiegeRun.ts`，五道门禁全过）。**顺带否掉三条机制原案**：守军共享+10 分钟重生（会造成零成本白进）、波数随等级增长（高级城变成谁都打不动）、每波守军借用 `1180×等级`（会掉进廉价线性分流且无人能清完）。stronghold 就因为跳过模拟直接拍数值翻过一次车（`ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5），本系统不重犯——而这一轮证明「跑一遍模拟」抓到的不止是数字。

---

## 1. 现状诊断（代码事实，2026-08-25 实查）

### 1.1 城池只有锚点一格是「城池地面」，其余全是普通资源地

`mapgen/cities.ts` 的程序化生成里，州府和分级城**只把锚点那一格**标成 `familyKeep`：

```ts
// server/shared/src/slg/mapgen/tileGen.ts (proceduralTile)
const capIdx = capitalIdxAt(x, y, caps);          // ← 精确匹配 cx===x && cy===y
if (capIdx >= 0) return { type: 'familyKeep', level: PROVINCE_CAPITAL_LEVEL, resType: biomeAt(x, y, seed) };
for (const node of _worldCityNodes(mapW, mapH, seed)) {
  if (node.x === x && node.y === y) return { type: 'familyKeep', level: node.level, ... };
}
```

而客户端按 `cityFootprint(level)` = 3/5/7/9 铺一张大精灵（`WorldMapRenderer/city.ts refreshCityLayer`）。于是**一座 Lv.8 城 = 1 格城池地面 + 48 格普通资源地被贴图盖住**。用户截图点到城墙内部的 (50,1098)，弹出的就是普通占领框：`墨水 · Lv.2 · 建议兵力 240`（= `npcGarrison(2)` = `NPC_GARRISON_PER_LEVEL(120) × 2`）——**一个新手一次出征就能吃掉城墙里面的地**。

> 唯一例外是世界中心：`proceduralTile` 对它做了真正的 9×9 `center` 块判定，所以只有它的 footprint 是完整的。

### 1.2 两条地图生成路径对同一座城的结论不一致（真 bug）

地图编辑器发布路径 `rasterizeMapEdits()`（`mapEdit.ts`）是**整块 footprint** 刷成 `familyKeep`/`center` 的：

```ts
for (const city of cities) {
  const half = Math.floor(city.footprint / 2);
  for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) { ... overrides.set(...) }
}
```

程序化生成只刷锚点（§1.1）。所以**同一座城，走编辑器发布的世界和走纯程序生成的世界，地形语义不同**——前者城内不可占、后者城内是资源地。这不是设计取舍，是两处实现漂移。

### 1.3 `familyKeep` 在服务端没有任何玩法分支

`combatMarch/startMarchValidation.ts` 对 `center`/`stronghold`/`bridge`/`plankway` 都有专门拦截（各自 4 个 `kind` 分支），**`familyKeep` 一次都没出现**。全 `worldsvc` 搜 `familyKeep` 只命中 `generated/routes.gen.ts` 里的 enum。后果：连锚点那一格都能被 `occupy` 直接占，而且它带 `resType`，占下来正常产出。

### 1.4 ⚠️ 一个玩家现在就能拿下整个州府并建国

`nations` 系统已经落地，触发条件是**占领州府锚点那一格**：

```
combatSiege/occupation.ts:472  settleOccupation() → core.applyNationChange(worldId, x, y, d.ownerId, d.familyId)
core/nation.ts:41              applyNationChange() → capitalIdxAt(x,y) ≥ 0 → 写 nations.ownerId
```

那一格的 PvE 守军是 `npcGarrison(10)` = **1,200 兵**、象征血量 `npcBaseHp(10)` = 600。也就是说：一个中期玩家凑够 1,200+ 兵、挨着连地、走一次普通 `occupy`、等 5 分钟占领倒计时 → **建国成功**，拿到全省 `NATION_BONUS_PRODUCTION`（+10% 产量）+ `NATION_BONUS_DEFENSE`（+15% 守军防御）。且归属写的是 `ownerId`（个人账号）+ `familyId`（家族），**跟宗门无关**。

**这条是本轮最严重的问题**，优先级高于 §1.1——§1.1 是「城里的地被零散啃」，本条是「一个人拿走一个省」。

---

## 2. 目标 / 非目标

**目标**
1. 野外城池只有**有宗门**的玩家能攻打。
2. 单人**在数学上**打不下任何一座野外城池（不是「很难」，是「输出永远追不上回复」）。
3. 几十名玩家协同，能在**约一小时**内攻陷一座城。
4. 城池成为宗门资产：有归属、有产量收益、有战略价值。

**非目标（本轮明确不做）**
- 不做攻城时段限制（24 小时开放，ADR-074 决策 4）。
- 不做城池内政/建造（野外城池不是第二个主城，`SLG_CITY_DESIGN.md` 那套建筑系统不进本文）。
- 不改战斗引擎：每一波仍是现成的 `runSiegeBattle` 确定性引擎战，本文只编排波次与耐久。

---

## 3. 攻打门槛：必须有宗门（ADR-074 决策 1）

- **判据**：`playerWorld.sectId` 存在。`sectId` 已在 `joinWorld` 时镜像到 `PlayerWorldDoc`（`core/vision.ts` 的 comm-audit batch F item 8b），无需跨服查询。
- ✅ **拦截点**：`validateMarchTarget` 的 `attack` 分支，城池目标判定后的第一道检查，抛 `SlgError('NOT_IN_SECT')`（复用既有的 403 错误码，而非新造 `NO_SECT`——客户端已经有它的 i18n）。**顺序刻意在连地判定之前**，理由见 §10-P1 第 3 条。
- **为什么是宗门而不是家族**：ADR-039 连地判定本来就是**按宗门领地**算的（`isConnectedToSectTerritory`）。如果门槛放到家族级，会出现「能打但连不上地」的割裂——同一层级才自洽。本项目 zh 文案 `profile.sect` 即「帮会」= 宗门，且 `social.sect.noFamily` 说明加宗门前必须先有家族，所以宗门门槛天然包含家族门槛。
- ✅ **客户端**：无宗门玩家点城，面板说明「须先加入帮会才能围攻城池」且不给出征按钮（与占领按钮同一约定：不满足的前置条件隐藏按钮而不是置灰）。

---

## 4. 数据模型

### 4.1 footprint 归属：整块不可分割

对齐主城的「九格一体不可分割」（ADR-025）：

- `proceduralTile` 改为**按 footprint 判定**（复用 `_inCityBackBands` 已有的 `r = (footprint-1)/2` 半径写法），与 `rasterizeMapEdits` 对齐，消除 §1.2 的漂移。
- footprint 内所有格子：`type = familyKeep`（世界中心 `center`）、`level = 城池等级`、**不带 `resType`**（城池地面不产出，产出改由 §8 的宗门加成承担——避免「占了城还能一格格收租」的双份收益）。
- `validateMarchTarget` 对 `familyKeep`：`occupy` / `sweep` / `move` **全禁**，只允许 `attack`。

**经济影响可忽略**：全图城池 footprint 合计**实测 2,276 格 / 2,250,000 格 = 0.101%**（P0 落地后用 `allCityNodes` 去重实测；朴素算式给 2,592，差额来自相邻城 footprint 重叠与贴边裁剪）。且这些格子本来就被城池贴图挡着、`RESOURCE_LEVEL_CAP_NEAR_CITY` 已经把它们周边压到 5 级以下。

### 4.2 `CityDoc`（新集合 `cities`）

```ts
interface CityDoc {
  _id: string;              // `city:${worldId}:${nodeId}`
  worldId: string;
  nodeId: string;           // MapEditorCityNode.id（'worldCenter' / 'capital-N' / 'garrison-N'）
  kind: 'capital' | 'worldCenter' | 'garrison';
  x: number; y: number;     // 锚点（footprint 中心）
  level: number;
  footprint: number;
  provinceIdx?: number;

  ownerSectId?: string;     // 归属宗门（无 = NPC 持有）
  capturedAt?: number;
  protectedUntil?: number;  // 易主后保护期

  durability: number;       // 当前耐久
  durabilityMax: number;    // = cityDurabilityMax(level, kind)
  durabilityRegenAt: number;// 惰性回复基准时刻（惰性回复的「上次结算时刻」）
  regenPerHour: number;     // = cityRegenPerHour(level, kind)，快照下来省一次重算

  ownerSectName?: string;   // 归属宗门名快照（地图标注无需再查宗门）

  // 守军波次状态。NPC 波次是**每次行军各打完整 3 波**（§5），所以这里不存 NPC 波次；
  // 本字段留给 P3 的宗门驻防队：被打败的驻防队锁定 CITY_WAVE_RESPAWN_MS 不能再上阵。
  defenderLock?: Record<string, number>; // teamId → injuredUntil

  siegeLog?: Record<string, number>; // sectId → 本轮围攻累计伤害（见 §7）
  rev: number;
}
```

- ✅ 世界开季 / 世界重置时 `initCities(worldId)` 按**模板下发的** `cities` 节点表建档（照 `initNations` 的形，幂等）。几何与耐久上限每次重刷、**已受的伤不重置**、归属/保护期/围攻日志每次清空——理由见 §10-P1 第 2 条。
- ✅ 索引：`{ worldId: 1 }`、`{ worldId: 1, ownerSectId: 1 }`（§8 宗门加成聚合）、`{ worldId: 1, x: 1, y: 1 }`（footprint 反查的盒查询）。
- ✅ 赛季重置：已进 `season/management.ts` 的清空集合列表（与 `siegeDamage`/`occupations`/`stationed` 同批）。

---

## 5. 攻城机制

> 本节的数值列已在 2026-08-25 由 `citySiegeRun.ts` 实测定案（§6）。其中**三项原案被实测否掉**（守军波数、每波守军量、守军共享重生），逐条理由见本节末与 [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md) §13-SLG-CITYSIEGE.2/.3。数值真源：`server/shared/src/slg/citySiege.ts`。

| 项 | 定案 | 复用的既有底座 |
|---|---|---|
| 攻打方式 | 只能 `attack`（围攻）。`occupy`/`sweep`/`move` 全禁 | `validateMarchTarget` |
| 连地要求 | 保留 ADR-039：目标 footprint 任一格需邻接本宗门领地 | `isConnectedToSectTerritory` + `targetFootprintCells` |
| 守军波数 | **各等级固定 3 波**（`CITY_WAVE_COUNT`），**每次行军都打完整 3 波** | 波次编排照 `applyBaseSiege` 的 t1→t5 循环 |
| 每波守军 | `CITY_WAVE_GARRISON_PER_LEVEL(210) × 等级`（Lv.3 = 630，Lv.10 = 2,100） | `synthesizeArmy` 合成 NPC 阵型 |
| 每波基地血量 | `CITY_WAVE_BASE_HP_PER_LEVEL(45) × 等级`（Lv.3 = 135，Lv.10 = 450） | `buildSiegeBattle` 的 `defenderBaseHp`（同 `npcBaseHp` 的接法） |
| 单次伤害 | `teamSiegeValue(army, cardInv)` = 队内 12 张卡攻城值之和 | 现成，**不随兵力放大** |
| 结算延迟 | 清完守军后挂 5 分钟再扣耐久 | `SLG_SIEGE_DAMAGE_DELAY_MS` + `siegeDamage` 管道 |
| 耐久 | `H = 26,000 + 900 × 等级`（`CITY_DURABILITY_BASE`/`_PER_LEVEL`） | 形如 `baseDurabilityMax` |
| 耐久回复 | `R = 12,000 + 500 × 等级` /小时，惰性计算 | 形如 `regenDurability`（无需定时器） |
| 世界中心 | 耐久与回复均 **×2**（`CITY_WORLD_CENTER_MULT`） | — |
| 宗门驻防队锁定 | 被打败的驻防队 **10 分钟**不能再上阵（`CITY_WAVE_RESPAWN_MS`，P3） | 对齐 `SLG_TEAM_INJURY_MS` |
| 开放时间 | 24 小时，无时段限制 | — |

**为什么「回复快」是正确的闸门**：单次伤害不随兵力放大（12 张卡的攻城值之和：新手队 136、中期 174、基准档 206、满级攻城卡组 300），所以单人每小时输出有硬上限。只要 `R > 单人持续输出上限`，单人就**永远**打不下来——不是「打很久」，是「耐久回得比掉得快，进度恒为负」。这比「把血量堆到很高」干净得多：血量高只是拖时间，挂机就能过；回复快是把单人这条解法从解空间里删掉。**但回复只封住持续输出**，还需要耐久封住「站着的兵池一次倾完」的爆发——两条判据见 §6.2。

**为什么每次行军都要重打全部 3 波（否掉「守军共享 + 10 分钟重生」）**：原案是把波次存成城池的共享状态，单波战败后 10 分钟重生。实测（代码事实）不成立——共享波次一旦被清空，重生窗口内到达的每一次行军都面对「零守军」，而 `applyBaseSiege` 在 `defenders.length === 0` 时**照样安排整份耐久伤害**。一个人 5 支队伍、打邻格城约 24 秒往返，每个 10 分钟窗口能拿到几十次**零成本**命中，「单人每小时输出有硬上限」当场失效。改成每次行军各打完整波次梯后，「每次攻城都得真打一场」才字面成立，而那一次的兵耗（实测 631~2,870）就是限制单人输出的唯一闸门。`CITY_WAVE_RESPAWN_MS` 保留，语义改为 P3 宗门驻防队的锁定期。

**为什么波数固定 3、不随等级增长（否掉 `3 + floor(等级/3)`）**：12 卡队规模固定，波间残兵按存活率**乘性**衰减，所以波数是最狠的杠杆。实测 Lv.10 加到第 4 波，**游戏能产出的任何配置都清不完**（练家子 Lv.8 满装 3 波过、4 波挂）——一座谁都打不动的州府比一座打得动的更糟。等级缩放交给每波守军量 + 每波基地血量，抬的是「价格」而不是「可行性」。

**为什么每波守军是 210/等级、不是 1180/等级（否掉借用 `STRONGHOLD_GARRISON_PER_LEVEL`）**：两条硬墙。①`1180×9 = 10,620` 超过 `SIEGE_SYNTH_ARMY_MAX_TROOPS`（9,600），`shouldUseCheapSiege` 会把 9/10 级城的每一波扔给廉价线性 `resolveSiege`——攻方恰好损失守军规模、卡组质量完全不计，正是 `STRONGHOLD_GARRISON_PER_LEVEL` 文档注释里警告过的那类分流陷阱。②Lv.10 整梯 `6×11,800 = 70,800` 兵，而一支 12 卡队的兵额上限只有 4,800（`cardTroopCap`，`satchel` 的 20,000 根本不生效）——没有任何人能打完。副作用是一座城的守军总量（Lv.10 = 6,300）**小于**一座险地的单份守军（11,800）；这不是意图反转，险地是一次性攻占，城池是 3 波 + 一面回得比单人快的耐久墙。

**为什么每波必须显式给基地血量**：`applyBaseSiege` 对主城波次钉 `defenderBaseLevel: 0` 且不传 `defenderBaseHp`，回落到引擎平坦的 `BASE_HP = 100`；而 ADR-069 之后单位攻城值随携带兵力放大，**一张带 300 兵的盾兵卡一击就砸掉 100 血基地**——波次在第一个攻方单位摸到基地时就结束，守军根本没开火。实测同一支满配队伍打 4,500 兵守军：基地 100 血损耗 **99 兵**，基地 600 血损耗 **730 兵**。不给基地血量，整条波次梯是免费的。

---

## 6. 难度曲线（✅ 已经 econ-sim 实测标定，2026-08-25）

> 数值真源：`server/shared/src/slg/citySiege.ts`。标定工具：`server/tools/econ-sim/src/citySiege.ts` + `citySiegeRun.ts`（`npm run --workspace @nw/econ-sim city-siege`），结论由 `citySiege.test.ts`（28 例）钉成 CI 回归。完整演算过程、被否掉的原案、残余风险：[`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md) §13-SLG-CITYSIEGE（实际落在分册 `ECONOMY_VERIFICATION_LOG_CAPACITY.md`）。

### 6.1 本节此前两版纸面推导都是错的（保留记录，勿再照抄）

§6.1 曾用「一小时兵力预算 ÷ 每次攻城兵耗 × 单次伤害」推单人每小时伤害 `p`：第一版按 `TROOP_CAP_BASE=10000` 得 `p≈1000`，ADR-075 换掉兵力曲线后重算得 `p_max≈3400`，并据此判定「单人封死已失效」。**两版的分子和分母都用错了**，所以「失效」这个结论本身也不成立：

1. **分子错——兵池不是单次投送量。** `attack` 行军带的是 12 张卡的队伍，每张卡的兵额受 `cardTroopCap` 约束：Lv.9 满编 `4×600 + 8×300 = 4,800` 兵，Lv.1 只有 1,600。`satchel` / `drillYard` 的 20,000 上限**永远不生效**。兵池决定的是「能补多少次」，不是「一次多大」。
2. **分母错——「每次兵耗 ~2,000」是猜的。** 实测在 **631**（满配打 Lv.3）到 **2,870**（基准档打 Lv.10）之间，随城池等级涨约 2.7 倍。它是引擎测量量：一支 12 卡队打赢一波守军的损耗远小于守军自身规模，倍率由卡等级/装备/波间残兵共同决定，无法纸面估。
3. **少了一条判据。** 只比「持续输出 vs 回复」不够，真正更紧的是**一次性倾池**：满配账号站着的 20,000 兵池在几分钟内能换出 30+ 次攻城，回复根本来不及作用。本节此前从未提这条。

### 6.2 单人封死（门禁 ①，`citySiegeRun.ts` 门禁 ③）

最坏情况取**游戏能给一个账号的一切**：练兵场/书包满级、卡 Lv.9、装备四项加成全部顶到 `EFFECT_CAPS`、开着商店训练加速（`TRAIN_SPEEDUP_BUFF_MULT`=×2）、并用**攻城值最高的卡组**（全 `siegeValueBase:14`）。对最弱野城（Lv.3，耐久 28,700 / 回复 13,500/时 / 波次梯 3×630）：

| 口径 | 兵耗/次 | 首小时次数 | 伤害/次 | 持续伤害/时 | vs 回复 | 倾池爆发 | vs 耐久 |
|---|---|---|---|---|---|---|---|
| 现行代码（只有 `teamSiegeValue`） | 631 | 45.4 | 300 | 4,110 | 回复 **3.28×** ✅ | 9,514 | 耐久 **3.02×** ✅ |
| 再叠上两条**尚未实现**的通道（装备 +60%、§8.3 宗门 +32%） | 631 | 45.4 | 634 | 8,680 | 回复 **1.56×** ✅ | 20,093 | 耐久 **1.43×** ✅ |

**两条判据都必须过**：

- **持续率 < 回复** —— 否则一个人磨几天也能拿下。这条由 `CITY_REGEN_*` 负责。
- **倾池爆发 < 耐久** —— 否则站着的兵池一坐就打下来了，回复没有作用窗口。这条由 `CITY_DURABILITY_*` 负责，**且它是两条里更紧的那条**。

余量刻意留在 1.4× 以上，这样别处一次小幅重调（卡兵额、训练吞吐、装备上限）不会静默把门禁翻红——`citySiege.test.ts` 直接断言这两个余量，每次提交都跑。

### 6.3 一小时攻陷所需人数（门禁 ②，`citySiegeRun.ts` 门禁 ⑤）

口径是**基准档**：练兵场 L6 + 卡 Lv.6 + 满装。它是**能清完所有城池等级的最弱档位**——用更强的档位算会得出一张现实里凑不出人的表，用更弱的档位算则那些人根本打不动高级城（见 §6.4）。

| 城池种类 | 等级 | 耐久 H | 回复 R /时 | 单人伤害/时（首小时） | **1 小时攻陷所需人数** | 完全停滞线（打不动） | 单人 |
|---|---|---|---|---|---|---|---|
| 分级城 | 3 | 28,700 | 13,500 | 3,219 | **13** | ≤25 人（持续口径） | **永远打不下** |
| 分级城 | 4 | 29,600 | 14,000 | 2,602 | 17 | ≤33 人 | 永远打不下 |
| 分级城 | 5 | 30,500 | 14,500 | 1,983 | 23 | ≤44 人 | 永远打不下 |
| 分级城 | 6 | 31,400 | 15,000 | 1,749 | 27 | ≤52 人 | 永远打不下 |
| 分级城 | 7 | 32,300 | 15,500 | 1,480 | 32 | ≤63 人 | 永远打不下 |
| 分级城 | 8 | 33,200 | 16,000 | 1,267 | 39 | ≤76 人 | 永远打不下 |
| 州府 | 10 | 35,000 | 17,000 | 1,204 | 43 | ≤86 人 | 永远打不下 |
| 世界中心 | 10（×2） | 70,000 | 34,000 | 1,204 | 86 | ≤171 人 | 永远打不下 |

**两列的区别很重要，别只看第一列**：

- 「1 小时攻陷所需人数」是**首小时**口径——每人把站着的兵池 + 一小时训练产出全部倾出去。
- 跨过第一小时，所有人退化到「停滞线」列：低于该人数，持续输出永远追不上回复，围攻**再久也打不完**（不是慢，是永不）。
- 所以**城池攻防由开场那一波倾池决定**。约不齐人、拖成消耗战 = 白送兵。这条性质是设计想要的：它逼出「宗门约时间、一次性压上」的玩法，而不是挂机磨。

行军往返不是约束：5 支队伍打邻格城约 1 分钟一轮，理论上限每小时约 300 次，实测需要的是 45 次以内 —— **兵力是唯一瓶颈**。

### 6.4 谁打得动哪一级城（实测门槛，非设定）

| 档位 | 能清完波次梯的最高城池等级 | 每次兵耗（L3 → 可达上限） |
|---|---|---|
| 新手（练兵场 L0，卡 Lv.1，裸装） | **无**（一级都打不动） | — |
| 中期（L4，卡 Lv.4，裸装） | 3 | 2,513 |
| 中期 + 满装（L4，卡 Lv.4，满装） | 5 | 1,698 → 2,583 |
| **基准档（L6，卡 Lv.6，满装）** | **10** | 1,073 → 2,870 |
| 练家子（L8，卡 Lv.8，满装） | 10 | 1,015 → 2,742 |
| 满配（L10，卡 Lv.9，满装 + 加速） | 10 | 631 → 1,915 |

三条结论，都是实测而非设计取舍：

1. **城池不是前期内容。** 新手档在任何等级都清不完波次梯，一次伤害都造不成。
2. **第一道门是装备，不是兵力。** 同样的练兵场 L4 + 卡 Lv.4，裸装只能碰 Lv.3，满装直接推到 Lv.5。
3. **「几十人围攻」的「人」有下限。** 是几十个练兵场 L6 + 卡 Lv.6 + 满装的成员，不是几十个任意成员。§8.2 说「城池收益是宗门招人筹码」仍然成立，但新人是**享受**收益，不是**参与**攻城。

### 6.5 为什么耐久/回复是「大基数 + 小步长」而不是正比于等级

`H = 26,000 + 900×等级`、`R = 12,000 + 500×等级`（世界中心两者 ×2）。看起来违反直觉——一座 Lv.10 州府的耐久只比 Lv.3 分级城高 22%。原因是被测量逼出来的：

- 单次攻城兵耗随城池等级涨约 **2.7 倍** → 同一档位的每小时伤害随等级**降**同样倍数。
- 若耐久正比于等级，所需人数会按约 **L²** 增长：Lv.3 要 13 人，Lv.10 州府要 **100+ 人**。
- 大基数 + 小步长把人数曲线压回 13 → 43 的形状。玩家实际感受到的等级缩放放在**波次梯**（谁打得动、每次多贵）而不是墙的厚度上。

**UI 影响（P1 必须照做）**：城池血条要显示**绝对值**（含 `28,700 / 28,700` 这种），不能只显示百分比——否则「3 级城和 10 级城血条一样长」会被读成 bug。

---

## 7. 归属判定：最后一击（ADR-074 决策 2）

- 耐久归零那一刻，城池归**最后一击那名玩家所属的宗门**。实现沿用主城易主逻辑（`settleSiegeDamage` 的 HP≤0 分支）。
- **同时写 `siegeLog`**：每次伤害结算按 `sectId` 累加到 `CityDoc.siegeLog`，城池易主或耐久回满时清零。
- **为什么留 `siegeLog`**：最后一击必然催生「蹲最后一击抢城」的战术，与「几十人协同」的设计目标相冲。用户已知此风险并拍板选最后一击（简单、与主城一致）。`siegeLog` 让后续想改成「累计伤害最高的宗门得城」时**无需数据迁移**，也顺带给客户端提供「本轮各宗门贡献」面板的数据源。
- 易主后 `protectedUntil` 给保护期（时长复用主城 `protectedUntil` 那套口径），并发系统邮件 + 宗门频道公告；世界中心易主发全服公告。

---

## 8. 占领收益（ADR-074 决策 3）

### 8.1 资源产量（绝对值，每名宗门成员各自获得）

系数：**每种地块资源 = `CITY_YIELD_FLAT_PER_LEVEL`(50) × 等级 /小时；铜币 = `CITY_STICKER_FLAT_PER_LEVEL`(20) × 等级 /小时**

| 城池种类 | 等级 | 全图座数 | 墨水 | 纸张 | 石墨 | 金属 | 铜币 |
|---|---|---|---|---|---|---|---|
| 分级城 | 3 | 12 | +150 | +150 | +150 | +150 | +60 |
| 分级城 | 4 | 12 | +200 | +200 | +200 | +200 | +80 |
| 分级城 | 5 | 12 | +250 | +250 | +250 | +250 | +100 |
| 分级城 | 6 | 6 | +300 | +300 | +300 | +300 | +120 |
| 分级城 | 7 | 6 | +350 | +350 | +350 | +350 | +140 |
| 分级城 | 8 | 6 | +400 | +400 | +400 | +400 | +160 |
| 州府 | 10 | 9 | +500 | +500 | +500 | +500 | +200 |
| 世界中心 | 10（×2） | 1 | +1,000 | +1,000 | +1,000 | +1,000 | +400 |

**上限**：`CITY_YIELD_FLAT_CAP` = 每种地块资源 **+6,000/时**，铜币 **+2,400/时**（= 120 级度）。

### 8.2 为什么是绝对值而不是百分比（平衡性测算）

基线（`tileYield` = `RESOURCE_YIELD_BASE`(100)/时 × 等级，每格只产一种资源）：

| 档位 | 地块数 | 均等级 | 总产出/时 | 单种资源/时 |
|---|---|---|---|---|
| 新人 | 32 | 4 | 12,800 | ~3,200 |
| 中期 | 60 | 5 | 30,000 | ~7,500 |
| 大号 | 150 | 7 | 105,000 | ~26,000 |

打满自己一个省（9 座分级城等级和 3+3+4+4+5+5+6+7+8 = 45，加本省州府 10 = **55 级度**）→ 每人 **+2,750/种、+1,100 铜币**：

| 档位 | 相对增幅 |
|---|---|
| 新人 | **+86%** |
| 中期 | +37% |
| 大号 | +11% |

这条曲线是绝对值方案的核心性质，也是选它而非百分比的理由：**它是宗门的招人筹码**——把新成员产出直接翻近一倍，对大号只是零头。百分比方案恰好相反（地多者拿得多，强者愈强）。

**为什么必须有上限**：全图 64 座城等级和 = 270（分级城）+ 90（州府）+ 20（世界中心）= **380 级度**。不设限时霸主宗门每人 +19,000/种、+7,600 铜币 = 中期玩家自身产出的 2.5 倍，等于「打完图就不用占地了」。封在 120 级度（≈ 自己一个省 + 一个邻省 + 一座州府）意味着**继续扩张的收益从经济转为战略遏制**——这正是 `SLG_DESIGN.md` §3 想要的「解释为何要夺关键城池」。

**兵力口径复核**：吃满上限的 +6,000 墨水/时 = 600 兵/时的墨水（`TROOP_TRAIN_INK_COST` = 10），而训练队列吞吐上限 1,440 兵/时需要 14,400 墨水/时 —— **满上限成员的城池收益只供得起 42% 的满速练兵**。加速战争机器，但拿不掉「必须占地」这个前提。

**结构性好处**：地块产出是偏科的（每格只产一种资源，`biomeAt` 还有省份偏向），城池是**四种均等 + 铜币**。所以城池实际解决的是「我这省不产金属」的短板，而不只是加量——百分比方案只会把偏科放大。

### 8.3 全域 buff（按城池种类分工，不做百分比大杂烩）

| 城池种类 | 除产量外的加成 |
|---|---|
| 分级城（Lv.3-8） | 无。保持「数量型经济资产」的单一定位 |
| 州府（Lv.10） | 攻城值 **+3%/座**（9 座 → 上限 +27%）+ 出兵锚点 |
| 世界中心 | 攻城值 **+5%**、行军耗时 **−10%**、全服公告 + 宗门称号 |

- 攻城值加成是**独立通道**，与装备的 `EFFECT_CAPS.siegePct_fp`(+60%) 分开计算、分开封顶——不共用一个累加器，避免宗门加成把装备通道顶到上限后失效。
- ⚠️ 攻城值加成会**直接放大单人每小时输出**（满图控制 = 9 座州府 +27% + 世界中心 +5% = ×1.32）。已算进 P2 门禁 ③ 的最坏情况（连同装备的 +60% 一起叠），余量仍有 1.43×~1.56×，所以 P3 接线不会破平衡。**但注意接线位置**：这两条通道今天都不进 `teamSiegeValue()`（它只读卡的 `defId`+`level`），要生效必须显式改那个函数，见 §11。

### 8.4 出兵锚点

- **只有州府 + 世界中心提供锚点**（9 + 1 座）。64 座城都能出兵，前线就不存在了。
- **不是传送**：宗门成员把队伍 `move`（驻扎）到自家城池，驻扎在城里的队伍可以**从该城直接出征**，行军起点 = 城池，士气按「从城池出发」重算（`marchMorale` 照常吃路径长度）。复用现有 `stationed` 系统，不新增传送管道。
- 兵力仍从本人兵池扣、伤兵仍回本人主城恢复——**锚点只省行军时间，不省兵力**，所以它不影响 §6 的 `p`。

### 8.5 防跳会刷收益

产量加成需**入会满 24 小时**（`CITY_BONUS_MEMBERSHIP_DELAY_MS`）才生效。否则「打城前一小时集体跳进大宗门吃产量」是必然出现的操作。这条不加也能上线，但会被玩家发现。

### 8.6 落地注入点（顺序有要求）

`core/yield.ts` 的 `recomputeYield` 现行顺序是：`Σ地块 × 国家加成 → × 资源建筑(buildingYieldMult) + stickerShop自产 → × 战令(BP_YIELD_MULT)`。

**城池 flat 必须接在战令之后、作为最后一步加法**。否则会被资源建筑（+10%/级）和战令（+10%）二次放大，§8.1 的上限就守不住了。

宗门维度聚合值 `cityBonus: Record<ResourceType, number>` 缓存在 `sects` 文档上，城池易主时重算；`recomputeYield` 多读一次 sect 文档（该路径本来已有 2-3 次读，可接受）。

---

## 9. `nations` 处理：直接清空（ADR-074 决策 3 附带）

§1.4 的漏洞修掉后，「占一格建国」这条路径消失，现存 `nations` 数据全部是通过该漏洞产生的，语义上不再有效。

- ✅ **`applyNationChange` 已整个删除**（P0，2026-08-25；不只是从 `occupy` 路径摘除——两个调用点与两层门面一起清掉）。州府归属改由 §7 的城池易主逻辑承担，归属主体从 `ownerId`(账号)+`familyId`(家族) 改为 **`ownerSectId`(宗门)**。
- ✅ **`nations` 归属清空已落地**（用户拍板，不做赛季内迁移）：`initNations` 现在会 `$unset` 既有文档的 `ownerId`/`familyId`/`nationName`/`foundedAt`。已建国玩家会失去国家 —— 可接受，因为该状态本身来自漏洞。**注意生效时机**：只在赛季开启 / 世界重置时跑，**已经开着的世界要跑一次 `/admin/world/reset` 或手动清 `nations`**，否则旧归属（及其 +10%/+15% 加成）会一直留着。刻意没做「玩家进世界时自愈」。
- **`NATION_BONUS_PRODUCTION`(+10% 全省产量) 移除**：州府的经济收益已并入 §8.1 的产量表，保留就是双计。
- **`NATION_BONUS_DEFENSE`(+15% 守军防御) 保留**：作为州府的军事身份，且它是防守侧、不参与 §6 的攻方模型。
- `nations` 集合本身是否保留取决于 P3 实现：若城池 `CityDoc` 能完全承载州府语义（省份归属 + 防御加成查询），则整个集合与 `NationService` 一并删除；这个判断留到 P3 动手时做，不在本文预先拍。

---

## 10. 分期落地

### P0 止血 ✅ 已落地（2026-08-25）

目标：让「一个人吃掉城池」当天不可能，不等完整实体落地。

1. ✅ **`proceduralTile` 按 footprint 判定城池地面**（§4.1）——新增 `_cityGroundNodeAt()`/`_inCityFootprint()`（`mapgen/cities.ts`），替掉旧的 `capitalIdxAt` + `node.x===x && node.y===y` 精确锚点匹配；`proceduralCityGroundTiles()` 同步改为枚举整块 footprint，§1.2 的两路径漂移消除。**城池地面不再带 `resType`**（`mapEdit.ts` 一并对齐，否则每座城的 footprint 会永久变成对基线的 diff）。
2. ✅ **`validateMarchTarget` 给 `familyKeep` 加拦截**：`occupy`/`sweep`/`move` 全禁；`attack` 抛显式的 `City siege is not implemented yet`（不落到 ownerless 分支那句已经错了的「use occupy/sweep」）。直接占领路径 `territory.ts occupyTile` 同样补上。
3. ✅ **`applyNationChange` 整个删除**（不只是从 occupy 路径摘掉）——两个调用点（`settleOccupation`、`settleSiegeDamage`）连 `core`/`service` 两层门面一起清掉。`initNations` 改为**同时清空既有文档的归属字段**（`ownerId`/`familyId`/`nationName`/`foundedAt`），赛季开启与世界重置都会生效。
4. ✅ 客户端点城弹「城池 · Lv.N · 需加入帮会后合力围攻」信息框（只有关闭按钮，不给出征入口），替掉普通占领框；i18n zh/en/de 三份。
5. ✅ **P0 顺带修掉两处此前没察觉的漏洞**：①落主城/自动出生**从来没有排除城池地面**（`spawn.ts` 四处内联的 `center/obstacle/bridge/plankway/stronghold` 列表都漏了 `familyKeep`）——footprint 化后这个洞会从「每城 1 格」放大到「每城最多 81 格」，现收敛为单一谓词 `isReservedBaseTerrain()`；②手动落主城（`territory.ts` 内部/测试路径）同样没有拦截。
6. ✅ 回归测试：新建 `server/worldsvc/test/city-ground.e2e.test.ts`（11 例）+ `client/test/ui/worldMapCityClick.ui.ts`（6 例），改写 `server/shared/test/{cities,slg}.test.ts` 的锚点断言为 footprint 断言、`review-fixes-2026-08-03.e2e.test.ts` 的 `applyNationChange` 用例换成 `initNations` 清空用例。

7. ✅ **补测一轮（同日第二刀）**：`_inCityFootprint`/`_cityGroundNodeAt` 的边界直测（四种 footprint 的「边上 vs 边外一格」、核心省州府不得被当作 `familyKeep` 认领）、**整块 81 格 footprint 逐格不出图**（配对反证：同样 81 格换成资源地必须出 81 个精灵）、**被拖走的城要交还整块旧 footprint**（原用例只查锚点一格）、**发布未改动的节点表必须是零 diff**、以及**到达时二次校验**（在途 occupy/move 落到城池地面）。

> **⚠️ 补测过程中发现并修掉一个真 bug（不在 P0 原计划内）**：`rasterizeMapEdits` 画城是**后写覆盖**、顺序取决于调用方数组（分级城在最后），而 `_cityGroundNodeAt` 是**州府优先、首个命中即返回**。两座城 footprint 重叠时（贴边城的锚点被夹回图内，plot 就会伸进邻城）二者结论不同——一个 Lv.8 分级城会盖掉 Lv.10 州府的格子，于是**发布出来的模板和生成器对同一格的 level 不一致**，而这个 level 从 P1 起就是城池的耐久/守军规模。现已改为按 `worldCenter > capital > garrison` 优先级绘制、先占者胜，与生成器对齐。是「发布未改动节点表 = 零 diff」这条断言在 (1499, 328) 抓出来的。
>
> **变异验红（5 处，逐一实测）**：M1 把分级城改回锚点匹配、M2 摘掉 occupy 的 `familyKeep` 拦截、M3 摘掉 `initNations` 的清空、M4 关掉客户端城池分支、M5 把两处到达时校验改回只认 `center`——各自都让对应用例转红。**其中三次暴露了测试自身的问题**：
> - **M1 第一轮没红**：`city-ground.e2e.test.ts` 的取城辅助函数原本「取第一座能用的城」，实际总是取到**州府**（另一条生成分支），于是把分级城分支改坏了整个套件仍然全绿。现在按 `kind` 取城、且要求格子 level 等于该城自身 level（否则会拿到邻近州府 9×9 footprint 吞掉的格子，实测踩到过）。
> - **M5 第一轮没红**：两条「到达时」用例其实**从没走到被测的那道校验**——occupy 在 ADR-039 连地检查处就退了、move 在缺队伍处就退了。补上「先占下城墙外一格」和「带真队伍」的前置后，M5 才现出真形：旧校验下 occupy **会占下城池地面**、move **会把队伍驻扎进城墙里**。两条各配一个「同样的行军打城墙外的地就该成功」的反证，避免「什么都没发生」被读成通过。
> - **重叠用例原本是空跑**：`city-ground-test`/`s99-0`/`w1` 三个种子实测**零重叠**，用例等于什么都没验。现钉在 `s1-cityground`（实测 15 格重叠）并断言命中数，种子一变就会失败而不是静默变空。
>
> **另一处坑记一笔**：worldsvc 的测试吃的是 `@nw/shared` 的 **`dist/`**，不是 `src/`。改完 shared 源码不 `npm run build` 就跑 worldsvc 测试，验的是上一次的编译产物——M1 的第一轮结论就是这么被污染的。

**P0 明确留下的临时状态**：`nations` 没有任何写入方了，所以 `NATION_BONUS_PRODUCTION`(+10%) 与 `NATION_BONUS_DEFENSE`(+15%) 双双**空转**，直到 P1 把州府归属改成宗门后重新接线（§9）。读取路径刻意保留未删——先删机制再建替代品没有意义。另外 `initNations` 只在**赛季开启 / 世界重置**时跑，所以**已经开着的世界会保留旧的建国归属**（含通过该漏洞建的国），需要跑一次 `/admin/world/reset` 或手动清一次 `nations` 集合。

### P1 城池实体 ✅ 已落地（2026-08-25）

P2 的标定先于 P1 跑完，所以 P1 实现的是**已实测定案**的机制，不是本文最初写下的那版（三条机制原案被否，见 §5）。

1. ✅ **`CityDoc` + 新集合 `cities`**（`worldsvc/src/db/cityDocs.ts`）：每世界约 64 个文档，归属主体 `ownerSectId`（宗门），索引 `{worldId}` / `{worldId, ownerSectId}` / `{worldId, x, y}`。**不是**挂在锚点格子的 `TileDoc` 上——footprint 有 9~81 格且不可分割，耐久/归属/围攻日志是**城池**的属性；挂在格子上还会跟主城与建筑路径已经在用的 `hp`/`durability` 撞名。
2. ✅ **`CitySiegeService`**（`worldsvc/src/core/citySiege.ts`，`core/nation.ts` 的对位物，组合而非继承）：`initCities`（幂等，赛季开启/世界重置各跑一次）、`getCityStates`/`getCity`/`cityAt`（footprint 反查）、`requireSect`（攻打门槛）、`getCityViews`（带惰性回复的视图）。
   - **节点表来源是 `core.getCities(worldId)`**（世界文档上从地图模板克隆下来的那份），不是 `allCityNodes(worldId)`：后者会把城池的血量放在贴图**不在**的位置（模板地形按 templateId 的种子生成，且设计师可能拖过城）。
   - `initCities` **每次都重刷**几何与耐久上限（`$set`），但**不重置已受的伤**（`durability` 只在 `$setOnInsert`）。所以地图编辑器改了城池等级、或常量重调过，下次开季会重新缩放城墙，而正在被围攻的城不会被治好。归属/保护期/围攻日志则每次 `$unset`——赛季级状态不能被「同 worldId 重开」继承（`initNations` 关的是同一个洞）。
3. ✅ **attack 分支 + 宗门门槛**（`combatMarch/startMarchValidation.ts`）：顺序刻意是**先宗门、后连地**——两者都不满足时，玩家能行动的是前者，报连地错误会让人跑去打一片他还是用不上的地。复用既有 `NOT_IN_SECT`(403) 而不是新造 `NO_SECT`。另外拦「本宗门已持有」（`ALLY_TILE`）与「保护期内」（`PROTECTED`）。连地判定按**整块 footprint**（`targetFootprintCells` 只认主城 3×3，城池自带一份）。
4. ✅ **波次梯 + 耐久**（`combatSiege/arrival/citySiege.ts`）：每次行军各打完整 3 波，残兵按每波真实存活率（ADR-069 的分母）在波间衰减；清完全梯 → 走既有 `siegeDamage` 管道挂 5 分钟延迟，伤害 = `teamSiegeValue`；被击退 → 零伤害、残兵走真实返程。
   - **到达时也重新判一遍连地**，而且必须用城池 footprint：`applySiege` 原本用 `targetFootprintCells`，城池地面没有 `TileDoc`，那个 helper 会退化成「只有落地那一格」——一座 5×5 城的锚点离攻方真正持有的边界地有 3 格，于是**每一次城池围攻都会在到达时被判成「补给线被切断」而原地驻扎**。实测抓到的（e2e 一开始 8 例红）。
5. ✅ **耐久结算 + 易主**（`combatSiege/cityDamage.ts`，由 `settleSiegeDamage` 按 `SiegeDamageDoc.cityId` 分流）：惰性回复 → 扣伤害 → 累加 `siegeLog[sectId]`；归零则**最后一击那名玩家所属宗门**得城（ADR-074 决策 2），写 `capturedAt`/`protectedUntil`，耐久**重置为满**（否则刚付了整场代价的宗门拿到一座任何人下一击就能翻走的空城），清 `siegeLog`。
   - 并发用 rev CAS + 有界重试（与格子路径同款），而 CAS 顺带充当「谁先到」的裁决者：同一 `rev` 只有一次更新能匹配，所以**易主与公告都只可能发生一次**。
   - 公告三路 + 一封邮件：新主宗门频道、原主宗门频道（城池归宗门所有，没有单个 defender 可推 `under_attack`，原主频道那条**就是**通知）、世界中心易主发全服频道；邮件只发给**落下最后一击的那名玩家**。刻意不按宗门（≤900 人）扇出邮件——64 座城每次易主群发一遍是邮件水龙头，频道公告已经覆盖在线成员且有 7 天 TTL。
   - **⚠️ 这四条公告一开始整套都是以原始 key 发出去的（2026-08-26 补）**：`slg.city.captured{,.subject,.mail}` / `slg.city.lost` / `slg.city.worldCenterCaptured` 五个 key 在三份词典里**一个都没有**，玩家收到的邮件标题就是字面的 `slg.city.captured.subject`。只有那一条字面写成 `subject: 'slg.city.captured.subject'` 的被 `client/test/i18n-server-mail-keys.test.ts` 抓红；另外三条写成 `body: body('…')` / `postSect(id, '…')`，那个扫描器只认「`subject:`/`body:` 紧跟引号」，**看不见**它们（扫描器已补第二块，见 §9）。
   - **公告的参数必须逐个具名（`name=value`）**：客户端 `i18n/systemText.ts` 按 `=` 取参，**没有 `=` 的管道段会被静默丢弃**。`body()` 原本发的是位置参数 `key|kind|nodeId|level|x|y|sect=名`，于是等级和坐标全部消失在路上——一条说不出「打下了哪座城」的易主公告。现已改成 `kind=…|node=…|level=…|x=…|y=…|sect=…`（e2e 用的是 `toContain`，格式没被钉住，改动不破测试）。`node=` 目前不进文案，留着给以后「点公告跳到该城」用。
   - **⚠️ 频道那几条的长度上限不是 `maxBodyChars`，是列宽（截图才看出来的）**：`drawChatLine` 单行不换行，`maxBodyChars=60` 只是**字数**上限，真正先裁掉文字的是所在列的宽度。第一版德文写到 55 字，60 字断言照样绿，但在宗门频道里是**半个词被切掉**的样子。
     - **✅ 已根治（2026-08-26 当天晚些时候）**：`drawChatLine` 不再收字数，改收 `maxW`（调用方传入本行可用宽度），名字牌与正文两半都经 `ui/widgets/truncateText.ts` 的 `fitToWidth` 按**真实宽度**截断并补 `…`。三个调用点（`SectScene/lists.ts` / `FamilyScene/lists.ts` 传 `colW - 12*2`，`FriendsScene/worldChat.ts` 传 `rw - inset*2`）随之改掉。**顺带修掉的两件事**：①玩家自己打的长消息此前同样被硬切且**没有省略号**，现在一律有；②名字牌（`[称号][宗门][家族]名字`，两个 org 名各可占 `ORG_NAME_WIDTH_MAX`）此前能把正文挤到没有空间，现在按行宽 50% 上限截断，正文拿名字牌**实际**占用后的剩余（短名字仍拿满）。
     - **那对 34/41 的字数上限是错的，两个数不可能同时描述同一列**：同一字号下 monospace 汉字步进约为拉丁的 1.82 倍（实测 24px：13.2px / 24.0px），34 个汉字 ≈ 62 个拉丁位宽，跟 41 差得远。现在的上限写在 `client/test/i18n-system-text.test.ts` 里，单位换成 `orgNameWidth` 的**显示宽度**（全角计 2、其余计 1），一个数管三种语言。
     - **上限的来源（Playwright 实测，`npm run start:e2e` + `window.__nwE2E`，视口 1600x900 → 落到 landscape **最窄**的设计宽 1920，即最坏情况）**：`system` 发送者的行，正文可用宽度 —— **宗门频道 700px = 53.0 位宽**、**世界频道 1386px = 105.0 位宽**（都含 `drawChatLine` 那个 `": "` 前缀的 2 位宽，词典串本身不含，故词典串预算为 51 / 103）。留一点余量后取 `SECT_BUDGET = 48`、`WORLD_BUDGET = 96`。当前文案最宽的是德文 `slg.city.lost`（40 位宽）和德文 `worldCenterCaptured`（55 位宽），**都还有余量——上一版把文案压到 41 字是压过头了**，以后要加字可以按这个预算来。`test:ui` 的 headless harness 量不了这个（它的 `measureText` 是每个 UTF-16 码元固定 7px，不看字号也不看字种），所以宽度预算只能靠真浏览器实测，见 `claudedocs/client-testing.md`。
   - **系统公告的翻译发生在 `drawChatLine` 里**：此前**没有任何**聊天面板会翻译 i18n key（`SectScene/lists.ts` 与 `FriendsScene/worldChat.ts` 都是直接渲染 `msg.body`），所以光加词典条目对这三条公告是无效的。现在把 mail 那份解析逻辑提成公用的 `i18n/systemText.ts`，在 `drawChatLine` 这一个收口处翻译——玩家自己打的字照原样透传（key 查不到就回退原串），所以不必按发送者是否为 `system` 分流。
6. ✅ **契约面**（直接编辑 `openapi-world.yml`；ADR-040 的 `openapi/` 分域片段只管 `openapi.yml`）：`WorldCityNodeView` 加 `ownerSectId`/`ownerSectName`/`durability`/`durabilityMax`/`regenPerHour`/`protectedUntil`/`siegeLog`；`PlayerWorldView` 加 `sectId`（客户端据此决定是否给围攻按钮）；新增 `GET /world/cities`。
   - **刻意不做推送**：一座城每小时会被命中几十次，按宗门扇出每一击是推送水龙头。城池面板打开时刷一次（`WorldMapNet.refreshCities`），地图上的血条只需大致正确；易主才走频道公告。
7. ✅ **客户端**（`WorldMapInput.showCityPanel` + `WorldMapRenderer/city.ts`）：城池精灵上方的耐久条（只在受损时画，跟主城血条同一套克制）；面板显示**绝对值**耐久 + 每小时回复量 + 归属宗门 + 保护期倒计时 + 本轮各宗门贡献；围攻按钮仅在服务端所有前置条件都已满足时出现（无宗门/保护期内/本宗门已持有 → 隐藏并说明原因，与占领按钮 2026-08-02 的约定一致）。
   - **耐久必须显示绝对值**：曲线是「大基数 + 小步长」（§6.5），Lv.3 与 Lv.10 只差约 22%，只给百分比会被当成 bug。
   - **⚠️ 血条锚点踩过一次（截图核对抓到的，代码审读抓不到）**：血条第一版锚在 `-sprite.height`（精灵单元格的顶边）。但 `citySpriteTiles` 是按 footprint 定精灵尺寸的，而每张城池图上方都有透明留白——一座 7×7 的 Lv.6 城，单元格顶边比屋顶高出几百像素，血条直接飘到视口外，看起来像「没做」。改用 `getCityContentTopFracForLevel(level)`（该函数的文档注释里点名的调用方就是 `WorldMapRenderer/city.ts`，而紧挨着的主城血条早在 2026-07-22 就因为矮建筑的同一症状修过一次）。**教训：这类缺陷只有真跑起来看一眼才会现形。**
8. ✅ 赛季生命周期：`openSeason`/`resetWorld` 各调一次 `initCities`；`cities` 进重置清空集合列表（与 `siegeDamage`/`occupations`/`stationed` 同批）。
9. ✅ 回归测试：`worldsvc/test/city-siege.e2e.test.ts`（**26** 例，真 Mongo）+ `shared/test/citySiege.test.ts`（**20** 例纯函数）+ `client/test/ui/worldMapCityClick.ui.ts`（15 例面板，P0 的 5 条保留 + P1 的 10 条）+ `client/test/ui/worldMapCityDurabilityBar.ui.ts`（**6** 例血条几何）+ `httpApiActionSiegeMapGaps.e2e.test.ts` / `season-ops.e2e.test.ts` 各 +2。P0 的 `city-ground.e2e.test.ts` 里那条 attack 用例从「未实现」改成断言宗门门槛。补测过程见下方第三刀。
   - **公告文案（2026-08-26 补）**：`client/test/i18n-server-mail-keys.test.ts` 加第二块扫描——不再去认「承载 key 的语法」，而是直接扫**非 admin 服务端源码里所有玩家命名空间下的 key 字面量**，因此 `body: body('…')` / `postSect(id, '…')` 这两种形态也进网。排除 admin 是必须的：后台的 RBAC 权限位和审计动作 id 拼写跟 i18n key 一模一样（`slg.season.open` 等 21 个）却永不示人，而且**要按 admin 模块排除、不能只排 `admin/` 目录**——那 21 个的权威定义在 `shared/src/admin.ts`。新增 `client/test/i18n-system-text.test.ts`（14 例）钉住 `systemText` 的参数契约（具名存活 / 位置参数被丢弃）、玩家原话透传、缺 key 回退，以及上面那条 60 字上限。


> **补测一轮（同日第三刀，用户问「有没有可以加的测试」后按 `sectService` 那次的规矩复查）**：`claudedocs/server-audits.md` 记着上一次同样一句话查出了 `/sect/*` 全部 10 条路由零 wire-level 覆盖。这次按同一套「不看方法名、看路由字符串 / 看机制的每条分支」复查，找出 4 个缺口并补齐，**其中一个缺口背后是真 bug**。
>
> **⚠️ 补测抓出一个真 bug（P1 原计划外，且严重）：世界中心根本没法围攻。** `validateMarchTarget` 的 `attack` 分支里有一条 ADR-074 之前就存在的拦截——`if (proc.type === 'center') throw 'World center is contested by sects and cannot be sieged'`——它排在我新加的城池分支**之前**。而 `isCityGroundTile` 覆盖 `center` 和 `familyKeep` 两种，世界中心的地面是 `center`，于是**全图最重要的那一座城（§8.3：攻城值 +5%、行军 −10%、全服公告）是 P1 唯一一座打不了的城**，`settleCityDamage` 里那段世界中心的全服频道公告成了死代码。原来的 21 条 e2e 全部用分级城，一条都没碰到。修法是把城池分支移到该拦截之前（那条拦截在「城池只是贴图」的年代是对的，ADR-074 恰好把它变成了错的）。
>
> **新增覆盖（4 处缺口）**：
> - **`GET /world/cities` 的路由分派零覆盖**（`httpApiActionSiegeMapGaps.e2e.test.ts` +2 例）。那个文件的唯一职责就是把 `mapRoutes.ts` 里每一条 `if (method===X && path===Y)` 走一遍真 HTTP，我加路由时没加进去——正是「方法名出现在测试里 ≠ 路由被覆盖」那个坑。断言不止 `Array.isArray`：逐条检查 `durability`/`durabilityMax`/`regenPerHour`，否则一个返回裸节点表的路由也能过（血条就画不出来了）。
> - **赛季生命周期零覆盖**（`season-ops.e2e.test.ts` +2 例）：`cities` 进了 resetSeason 的清空列表、`initCities` 挂进了 openSeason/resetWorld，两件都没有任何东西看着。**验红时发现断言写得不准**：去掉清空后「归属被清」的断言仍然绿，因为 `initCities` 每次都会 `$unset` 归属——清空真正独有的作用是删掉**节点表里已不存在的孤儿文档**（地图模板改过之后的残留）。已按这个改断言并记在用例注释里。
> - **`initCities` 是否跟随「发布的」节点表**（`city-siege.e2e.test.ts`）：这是 ADR-074 自己的核心 bug 类型（种子 vs 发布），却只测了种子回退路径。新用例把城拖走 11/7 格并改等级，断言文档跟着走、`durabilityMax` 按新等级重算、footprint 反查认新锚点。
> - **到达时的三条重新校验 + 一条陈旧分支**（`city-siege.e2e.test.ts`）：在途中退出宗门、在途中城池进入保护期、结算时城池文档已被世界重置删掉。这三条都是「出发侧对、到达侧错」的形状——P1 已经踩过一次（连地判定），所以值得逐条钉。
> - **客户端血条的几何**（新建 `client/test/ui/worldMapCityDurabilityBar.ui.ts`，6 例）：见下条。
>
> **⚠️ 另一处：血条那个 bug 是截图发现的，15 条 UI 测试全绿——因为它们断言的是面板的**文案和按钮**，不是**位置**。** 新用例把 `getCityContentTopFracForLevel` mock 成 0.5（真图有留白时才能区分两种写法），断言「血条与美术顶边的间距是个小常数、且不随 footprint 增长」。验红：把代码回滚成 `-sprite.height`，两条几何用例立刻红（间距 437px vs 允许的 16px）。**这条教训比这个 bug 本身值钱：渲染层的回归测试要断言几何，只断言内容会漏掉整类「画在屏幕外」的缺陷。**
>
> **顺手消掉一处重复**：`rasterizeMapEdits` 里的 `CITY_PAINT_RANK` 是城池优先级的**第三份拷贝**（另两份是 `_cityGroundNodeAt` 的遍历顺序和 P1 新增的 `cityNodeCovering`）。P0 那个「Lv.8 分级城盖掉 Lv.10 州府」的 bug 就是这三份漂移出来的。改成 import 共享的 `CITY_KIND_RANK`，并加一条**行为**断言（不是常量相等断言——那条抓不到当年那个 bug）：真实重叠格上，生成器、`cityNodeCovering`、以及「发布未改动节点表必须零 diff」三者必须一致。
>
> **变异验红 6 处，逐一实测**：M-A 反转 rasterizer 的城池优先级、M-B 让 `/world/cities` 返回裸节点表、M-C 从 resetSeason 删掉 `cities`、M-D 从 openSeason 删掉 `initCities`、M-E 把那条 `center` 拦截加回城池分支之前、M-F 把血条锚点回滚成 `-sprite.height`——各自都让对应用例转红。
>
> **登记一条没测的**（不是漏，是刻意）：`settleCityDamage` 的 rev-CAS 重试循环与 `MAX_ATTEMPTS` 耗尽分支。要确定性地制造 5 次连续 rev 冲突需要往结算里插测试钩子，成本高于收益；并发正确性目前靠「同一 `rev` 只有一次更新能匹配」这个结构性质 + 「本宗门已持有则作废」那条用例间接覆盖。

**P1 明确留下的临时状态**：
- `CityDoc.defenderLock` 已建字段但 P1 无写入方——它是 P3 宗门驻防队的锁定期（`CITY_WAVE_RESPAWN_MS`），NPC 波次是每次行军重打的，不需要。
- `nations` 的两条加成仍然空转：`NATION_BONUS_PRODUCTION`/`NATION_BONUS_DEFENSE` 的读取路径还在，但 P1 只把**城池**归属改成了宗门，没有把州府的省级加成重新接到 `CityDoc.ownerSectId` 上（§9 与 §8 的收益接线都在 P3）。
- §8 的三条收益（产量 / 全域 buff / 出兵锚点）一条都没接：P1 只做「打得下来、守得住、看得见」。

### P2 数值核验（上线门禁）✅ 已落地（2026-08-25，先于 P1 跑完）

新建 `server/tools/econ-sim/src/citySiege.ts`（模型）+ `citySiegeRun.ts`（报告/门禁，`npm run --workspace @nw/econ-sim city-siege`）+ `citySiege.test.ts`（28 例 CI 回归）。**刻意排在 P1 前面**：这一轮定的不只是数字，还否掉了 §5 的三条机制原案（守军共享重生、波数随等级、每波守军 1180/等级），P1 若先写代码会照着错的机制实现一遍。

五道门禁，全部 PASS：

| 门禁 | 内容 | 结果 |
|---|---|---|
| ① 档位表 | 各档位单次投送量/兵池/训练吞吐/单次伤害 | 实测发现单次投送受 `cardTroopCap` 钉死在 ≤4,800，`satchel`/`drillYard` 的 20,000 永不生效 |
| ② 单次兵耗 | 6 档位 × 7 城池等级的清梯成功率与兵耗 | 631~2,870，随等级单调上升 |
| ③ **单人封死** | 满配单人（含装备 +60%、宗门 +32% 两条假想通道）对最弱野城 | ✅ 持续输出 1.56× 余量、倾池爆发 1.43× 余量 |
| ④ 结构不变式 | 每波守军 ≤ `SIEGE_SYNTH_ARMY_MAX_TROOPS`（不掉进廉价线性分流）+ 兵耗单调 + 基准档能清完所有等级 | ✅ |
| ⑤ **人数表** | §6.3 每一档「1 小时攻陷所需人数」实测 vs 本文表值 | ✅ 全部落在 ±25%（+5% ~ +21%） |

两条原始必过断言的落地形态：

1. **「单人进度恒为负」拆成了两条判据**，而不是一条。原文只写了「持续输出 < 回复」；实测发现更紧的是「**倾池爆发 < 耐久**」——满配账号站着的兵池能在几分钟内换出 30+ 次攻城，回复来不及作用。两条都进了 `citySiege.test.ts`，并各留 ≥1.3× 余量断言，防止别处一次小重调静默把门禁翻红。
2. **「与文档表值偏差 ≤±25%」成了双向的钉子**：`citySiegeRun.ts` 和 `citySiege.test.ts` 各存一份 §6.3 的人数表。改常量不改文档 → 红；改文档不重跑脚本 → 红。

**同时登记的两条代码事实**（设计假设与实现相反，见 §6 与 ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE.6）：`teamSiegeValue()` 只读卡的 `defId`+`level`，**装备攻城值 +60% 根本不进耐久伤害**；§8.3 的宗门加成同样未实现。门禁 ③ 是带着这两条假想倍率测的，所以 P3 真去接线也在余量内。

### P3 守方与收益接线

宗门驻防队接入波次防守（拥有方的 `stationed` 队伍替代 NPC 波次）、§8 三条收益（产量/buff/锚点）接线、州府 `nations` 语义迁移收口（§9 末条）。

---

## 11. 未决 / 待验证

| 项 | 状态 |
|---|---|
| **单人封死的余量** | ✅ **已实测封死**（2026-08-25，P2）。满配单人（练兵场/书包满级 + 卡 Lv.9 + 装备顶到 `EFFECT_CAPS` + 商店训练加速 + 攻城值最高卡组 + 两条尚未实现的假想通道全叠）对最弱野城：持续输出 8,680/时 vs 回复 13,500/时（**1.56×**）、倾池爆发 20,093 vs 耐久 28,700（**1.43×**）。ADR-075 引发的「已失效」判定源于纸面推导用错了分子和分母，见 §6.1 |
| §6 全部数值 | ✅ **已实测标定**，不再是 DRAFT。真源 `server/shared/src/slg/citySiege.ts`，演算 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-CITYSIEGE |
| **金币加速训练（新增，未闭合）** | ⚠️ `TROOP_SPEEDUP_SECS_PER_COIN=60` 是无上限的钱→兵通道。单人要追平最弱野城的回复需额外 13,437 兵/时 ≈ **1,120 金币/时** 连续 2 小时以上 + 134,375 墨水/时 支撑，实践中被资源侧掐住（大号约 26,000 墨水/时 → 2,600 兵/时），原理上不封顶。若上线后真出现单人破城，**正解不是继续抬回复**（会把所有档位的所需人数一起抬高），而是加一条「每人对单座城的每小时伤害硬上限」 |
| **新手对城池零贡献（新增）** | 实测新手档（练兵场 L0 + 卡 Lv.1 + 裸装）在**任何**城池等级都清不完波次梯，一次伤害都造不成。§8.2「城池收益是宗门招人筹码」仍成立，但新人是**享受**收益不是**参与**攻城；「几十人围攻」的人指几十个练兵场 L6 + 卡 Lv.6 + 满装的成员 |
| **`teamSiegeValue` 不读装备（新增）** | 代码事实：`EFFECT_CAPS.siegePct_fp`(+60%) 只作用于引擎蓝图的 `siegeValue_fp`（战斗中对象征性基地的伤害），**不影响落到耐久上的那一下**。是否要把它接进耐久伤害是个待拍板的设计问题——门禁已按「接了」测过，接线不会破平衡，但会让装备成为城战的第二个主要门槛 |
| `nations` 集合是否整体删除 | 留到 P3 判断（§9 末条）。P1 只把**城池**归属改成了宗门，州府的省级加成（`NATION_BONUS_*`）仍未重新接线，两条加成继续空转 |
| **§8 三条收益一条未接（P1 后新增）** | 产量 / 全域 buff / 出兵锚点全在 P3。P1 只做「打得下来、守得住、看得见」，所以现在打下一座城**除了战略遏制没有任何收益**——不是遗漏，是分期 |
| **`CityDoc.defenderLock` 是空字段（P1 后新增）** | 建好了但 P1 无写入方：它是 P3 宗门驻防队的锁定期（`CITY_WAVE_RESPAWN_MS`）。NPC 波次每次行军重打，不需要锁定 |
| 城池易主保护期时长 | ✅ 已定 `CITY_CAPTURE_PROTECTION_MS = 2 小时`，**刻意短于**主城的 `PROTECTION_SEC`(8 小时)：城池易主时耐久同时重置为满，重夺本就要再打一整场；主城没有这个重置（它是搬迁），护盾是它唯一的保护 |
| ~~世界中心打不了~~ | ✅ 已修（补测抓出）：`attack` 分支里 ADR-074 之前的 `center` 拦截排在城池分支之前，把全图最重要的那座城变成唯一打不了的城，`settleCityDamage` 的全服公告成了死代码。现已把城池分支移到它之前 |
| ~~四条易主公告全是原始 key~~ | ✅ 已修（2026-08-26）：五个 key 三份词典全缺 + 参数是位置式（等级/坐标丢失）+ 聊天面板从不翻译 key。详见 §10 P1 第 5 条的四条补注 |
| **`world.city*` 那 6 条把宗门写成「帮会」（新增，未改）** | zh 词典里 `宗门` 40 处 vs `帮会` 6 处，后者全在 ADR-074 新加的 `world.city*` 块（`world.cityHint`/`cityNeedSect`/`cityOursHint` 等），与 `sect.title = 宗门` 不一致。玩家可见术语统一是产品拍板，不在本次 i18n 补漏范围内；本次新增的五条公告一律用 `宗门` |
| **公告没有「点进去看那座城」** | `body()` 已经在发 `node=<nodeId>`（`cityDamage.ts`），但 `systemText` 只做字符串插值，公告目前不可点。要做的话客户端得把 `node` 参数接到 `WorldMapInput.showCityPanel`；参数已经在线上，属于纯客户端增量 |
| 城池血条 UI 必须显示绝对值 | §6.5：耐久是「大基数 + 小步长」，Lv.3 与 Lv.10 只差 22%，只显示百分比会被读成 bug |
| 宗门人数上限对 §8.1 总 faucet 的影响 | 宗门 ≤900 人（`GW_PUSH_REDIS_CHANNEL` 注释口径）；满编宗门吃满上限时的全服 faucet 总量待 `SLG_ECONOMY_CHECK.md` 轨道 2（赛季资源）核算 |
| §8.1 城池产量 vs 训练资源消耗（新增） | 满配档 8,640 兵/时 的训练吞吐需要 86,400 墨水/时，远超单人产出上限。P2 的持续输出率因此是**乐观上界**（假设有存货可倾，对门禁而言方向安全）；P3 接产量时要在轨道 2 里连带复核 |
