# Notebook Wars — 野外城池攻占设计（宗门级攻城）

> 状态：设计中（**数值 DRAFT，未经模拟核验**）· 权威：本文（野外城池机制基准）· 创建：2026-08-25
> 上级：[`SLG_DESIGN.md`](SLG_DESIGN.md)（大世界总纲，§3.1 城池节点 / §5 攻防模型）。本文把 SLG §3.1 里长期挂着「城池的驻军/耐久数值仍是 §5 待定项，本轮只做视觉」的那个缺口补完，并把它从「贴图」升级成一个有数据模型、有归属、有收益的玩法实体。
> 配套：[`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md)（**主城**内政，勿混淆——本文是**野外 NPC 城池**）、[`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md)（数字登记，本系统落 §13-SLG-CITYSIEGE）、[`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)（核验流程）、[`SOCIAL_DESIGN.md`](SOCIAL_DESIGN.md)（家族/宗门层级）。数值真源：`server/shared/src/slg/siege.ts`。
> 拍板：[ADR-074](../DECISIONS.md)（2026-08-25，用户当场四问四答）。

---

## 0. TL;DR

- **要解决的问题（用户 2026-08-25 报）**：「野外城池，只有加入帮会的人可以攻打。另外你验证一下城池的难度，别让一个玩家就打下来了。」
- **诊断结论比预想严重**：野外城池现在**完全是一张贴图**，不是「太容易打」而是**根本没有城池这个实体**。而且顺带查出一条更严重的：**一个中期玩家用一次普通 `occupy` 就能拿下整个州府并建国**（§1.4）。
- **一句话方案**：城池升级成实体，攻打门槛 = **有宗门**，难度靠**「耐久大 + 回复快」**——让**每小时回复速度 > 单人每小时输出上限**，于是单人在数学上永远打不下来，几十人同时打才在一小时内攻陷。
- **关键设计点**：单次攻城伤害 = `teamSiegeValue`（队内 12 张卡攻城值之和），**不随兵力放大**。这个既有特性是「人多才打得下」能成立的前提——否则一个大号堆兵就能顶几十人。
- **数值全部是 DRAFT 推导值**，必须经 `server/tools/econ-sim/src/citySiegeRun.ts`（P2 新建）实测后才能上线。stronghold 就因为跳过模拟直接拍数值翻过一次车（`ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5），本系统不重犯。

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
- **拦截点**：`validateMarchTarget` 的 `attack` 分支，新增城池目标判定后第一道检查，抛 `SlgError('NO_SECT')`。
- **为什么是宗门而不是家族**：ADR-039 连地判定本来就是**按宗门领地**算的（`isConnectedToSectTerritory`）。如果门槛放到家族级，会出现「能打但连不上地」的割裂——同一层级才自洽。本项目 zh 文案 `profile.sect` 即「帮会」= 宗门，且 `social.sect.noFamily` 说明加宗门前必须先有家族，所以宗门门槛天然包含家族门槛。
- **客户端**：无宗门玩家点城，弹「城池 · 需加入帮会」信息框（不给出征按钮），而不是当前的普通占领框。

---

## 4. 数据模型

### 4.1 footprint 归属：整块不可分割

对齐主城的「九格一体不可分割」（ADR-025）：

- `proceduralTile` 改为**按 footprint 判定**（复用 `_inCityBackBands` 已有的 `r = (footprint-1)/2` 半径写法），与 `rasterizeMapEdits` 对齐，消除 §1.2 的漂移。
- footprint 内所有格子：`type = familyKeep`（世界中心 `center`）、`level = 城池等级`、**不带 `resType`**（城池地面不产出，产出改由 §8 的宗门加成承担——避免「占了城还能一格格收租」的双份收益）。
- `validateMarchTarget` 对 `familyKeep`：`occupy` / `sweep` / `move` **全禁**，只允许 `attack`。

**经济影响可忽略**：全图城池 footprint 合计 = 分级城（12×5² + 12×5² + 12×5² + 6×7² + 6×7² + 6×7²）+ 州府（9×9²）+ 世界中心（9²）≈ **2,592 格 / 2,250,000 格 = 0.12%**，且这些格子本来就被城池贴图挡着、`RESOURCE_LEVEL_CAP_NEAR_CITY` 已经把它们周边压到 5 级以下。

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
  durabilityMax: number;    // = cityDurabilityMax(level)
  durabilityRegenAt: number;// 惰性回复基准时刻

  waves: { idx: number; defeatedUntil?: number }[];  // 守军波次状态（defeatedUntil 到点即重生）

  siegeLog?: Record<string, number>; // sectId → 本轮围攻累计伤害（见 §7）
  rev: number;
}
```

- 世界开季时 `initCities(worldId)` 按模板下发的 `cities` 节点表批量 `$setOnInsert`（照 `initNations` 的形，幂等）。
- 索引：`{ worldId: 1 }`、`{ worldId: 1, ownerSectId: 1 }`（§8 宗门加成聚合）、`{ _id }`。
- 赛季重置：进 `season/management.ts` 的清空集合列表（与 `siegeDamage`/`occupations`/`stationed` 同批）。

---

## 5. 攻城机制

| 项 | 定案 | 复用的既有底座 |
|---|---|---|
| 攻打方式 | 只能 `attack`（围攻）。`occupy`/`sweep`/`move` 全禁 | `validateMarchTarget` |
| 连地要求 | 保留 ADR-039：目标 footprint 任一格需邻接本宗门领地 | `isConnectedToSectTerritory` + `targetFootprintCells` |
| 守军 | `3 + floor(等级/3)` 波，每波 `1180 × 等级` 兵 | `strongholdGarrison` 的量级；波次编排照 `applyBaseSiege` 的 t1→t5 |
| 守军重生 | 单波战败后 **10 分钟**重生（`CITY_WAVE_RESPAWN_MS`） | 对齐 `SLG_TEAM_INJURY_MS` |
| 单次伤害 | `teamSiegeValue(army, cardInv)` = 队内 12 张卡攻城值之和 | 现成，**不随兵力放大** |
| 结算延迟 | 清完守军后挂 5 分钟再扣耐久 | `SLG_SIEGE_DAMAGE_DELAY_MS` + `siegeDamage` 管道 |
| 耐久 | `H = CITY_DURABILITY_PER_LEVEL(3000) × 等级` | 形如 `baseDurabilityMax` |
| 耐久回复 | `R = CITY_REGEN_PER_LEVEL(1000) × 等级` /小时，惰性计算 | 形如 `regenDurability`（无需定时器） |
| 世界中心 | 耐久与回复均 **×2**（`CITY_WORLD_CENTER_MULT`） | — |
| 开放时间 | 24 小时，无时段限制 | — |

**为什么「回复快」是正确的闸门**：单次伤害不随兵力放大（12 张卡的攻城值之和，新手队 ~132、中期 ~185、满级盾兵队 ~280），所以单人每小时输出有硬上限。只要 `R > 单人每小时输出上限`，单人就**永远**打不下来——不是「打很久」，是「耐久回得比掉得快，进度恒为负」。这比「把血量堆到很高」干净得多：血量高只是拖时间，挂机就能过；回复快是把单人这条解法从解空间里删掉。

**为什么守军必须重生**：如果守军清一次就没了，第一个攻城的人付了全部兵力代价，后面所有人零损耗白进——单人每小时输出就不再受兵力再生约束，§6 的模型当场失效。重生把「每次攻城都得真打一场」钉死。

---

## 6. 难度曲线测算（DRAFT，待 econ-sim 核验）

### 6.1 单人每小时输出上限 `p` 的推导

`p` 的真实约束是**兵力再生**，不是冷却：

| 环节 | 值 | 出处 |
|---|---|---|
| 兵池上限 | 10,000（+1,000/练兵场级） | `TROOP_CAP_BASE` / `DRILL_TROOPCAP_STEP` |
| 训练吞吐 | 2 队列 × 720 兵/时 = **1,440 兵/时**（练兵场加速最多到 ×2） | `TROOP_TRAIN_QUEUE_MAX=2`、`TROOP_TRAIN_TIME_SEC=5`、`DRILL_TRAIN_SPEED_FLOOR=0.5` |
| 队伍数 | 5 | `SIEGE_TEAM_CAP` |
| 每次攻城兵耗 | ~2,000（对一波 1180×L 的守军） | §5 守军设计 |
| 一小时兵力预算 | 10,000（满池起手）+ 1,440（再生）≈ 11,400 |  |
| → 每小时成功攻城次数 | ~5 次 |  |
| → **每小时伤害 `p`** | 5 × 150 ≈ **750**（中期）～ 5 × 280 = **1,400**（满配） |  |

**设计取 `p = 1000`**（中位）。

### 6.2 曲线

`攻陷耗时 T = H / (N·p − R)`，`N` = 同时攻城人数。

| 城池种类 | 等级 | 耐久 H | 回复 R /时 | 1 小时攻陷所需人数 | 完全停滞线（打不动） | 单人 |
|---|---|---|---|---|---|---|
| 分级城 | 3 | 9,000 | 3,000 | 12 人 | ≤3 人 | **永远打不下** |
| 分级城 | 4 | 12,000 | 4,000 | 16 人 | ≤4 人 | 永远打不下 |
| 分级城 | 5 | 15,000 | 5,000 | 20 人 | ≤5 人 | 永远打不下 |
| 分级城 | 6 | 18,000 | 6,000 | 24 人 | ≤6 人 | 永远打不下 |
| 分级城 | 7 | 21,000 | 7,000 | 28 人 | ≤7 人 | 永远打不下 |
| 分级城 | 8 | 24,000 | 8,000 | 32 人 | ≤8 人 | 永远打不下 |
| 州府 | 10 | 30,000 | 10,000 | 40 人 | ≤10 人 | 永远打不下 |
| 世界中心 | 10（×2） | 60,000 | 20,000 | 80 人 | ≤20 人 | 永远打不下 |

以 Lv.8 城为例的完整梯度：32 人 → 1 小时；20 人 → 2 小时；16 人 → 3 小时；12 人 → 6 小时；8 人及以下 → 永不。

**单人封死的余量**：最弱的野城（Lv.3）回复 3,000/时，单人满配输出 1,400/时 —— **2.1 倍余量**。这条余量是本设计的命门，`citySiegeRun.ts` 必须优先验证它，且要覆盖装备攻城值加成（`EFFECT_CAPS.siegePct_fp` = +60%）叠满的极端个体。

> ⚠️ 上表全部是**推导值**。`p` 的推导里「每次攻城兵耗 ~2,000」是按守军设计反推的估计，不是实测；`teamSiegeValue` 的真实分布也依赖玩家卡组等级。P2 的 econ-sim 若测出 `p` 显著偏离 1000，`CITY_REGEN_PER_LEVEL` 是首选调节杆（它直接决定单人封死余量），`CITY_DURABILITY_PER_LEVEL` 次之（它只决定人数-耗时曲线的斜率）。

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
- ⚠️ 攻城值加成会**直接放大 §6 的 `p`**（州府满配 +27% → `p` 从 1000 涨到 1270）。econ-sim 必须把这条算进单人封死余量的最坏情况。

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

- **`applyNationChange` 从 `occupy` 路径摘除**（`combatSiege/occupation.ts:472`）。州府归属改由 §7 的城池易主逻辑承担，归属主体从 `ownerId`(账号)+`familyId`(家族) 改为 **`ownerSectId`(宗门)**。
- **现存 `nations` 集合直接清空**（用户拍板，不做赛季内迁移）。已建国玩家会失去国家 —— 可接受，因为该状态本身来自漏洞。
- **`NATION_BONUS_PRODUCTION`(+10% 全省产量) 移除**：州府的经济收益已并入 §8.1 的产量表，保留就是双计。
- **`NATION_BONUS_DEFENSE`(+15% 守军防御) 保留**：作为州府的军事身份，且它是防守侧、不参与 §6 的攻方模型。
- `nations` 集合本身是否保留取决于 P3 实现：若城池 `CityDoc` 能完全承载州府语义（省份归属 + 防御加成查询），则整个集合与 `NationService` 一并删除；这个判断留到 P3 动手时做，不在本文预先拍。

---

## 10. 分期落地

### P0 止血（doc-only 之后第一刀，可独立交付）

目标：让「一个人吃掉城池」当天不可能，不等完整实体落地。

1. `proceduralTile` 按 footprint 判定城池地面（§4.1），同时消除 §1.2 的两路径漂移。
2. `validateMarchTarget` 给 `familyKeep` 加拦截：`occupy`/`sweep`/`move` 全禁。
3. **`applyNationChange` 从 occupy 路径摘掉**（§1.4），清空 `nations`。
4. 客户端点城弹「城池 · 需攻城」信息框，替掉现在的普通占领框。
5. 回归测试：`proceduralTile` footprint 覆盖、`familyKeep` 四个 `kind` 全拦、州府 occupy 不再建国。

### P1 城池实体

`CityDoc` + `initCities` + attack 分支 + 宗门门槛 + 守军波次与重生 + 耐久/回复 + 易主（保护期/邮件/公告/`siegeLog`）+ 客户端血条与攻城面板。契约面：`openapi-world.yml` 加城池视图字段（走 ADR-040 的 `openapi/` 分域片段，勿直接编辑 `openapi.yml`）。

### P2 数值核验（**上线门禁**）

新建 `server/tools/econ-sim/src/citySiegeRun.ts`，照 `strongholdCombatRun.ts` / `occupyCardTeamRun.ts` 的形，扫「同时攻城人数 N × 卡组档位 × 城池等级 × 装备攻城值叠满与否」，输出攻陷耗时矩阵。必须钉成回归断言的两条：

1. **单人（含装备攻城值 +60% 叠满、练兵场满级）对最弱野城（Lv.3）进度恒为负。**
2. **§6.2 表里每一档「1 小时攻陷所需人数」的实测值与表值偏差在 ±25% 内**，否则回调 `CITY_REGEN_PER_LEVEL` / `CITY_DURABILITY_PER_LEVEL` 并更新本文 + `ECONOMY_VERIFICATION_LOG.md` §13-SLG-CITYSIEGE。

### P3 守方与收益接线

宗门驻防队接入波次防守（拥有方的 `stationed` 队伍替代 NPC 波次）、§8 三条收益（产量/buff/锚点）接线、州府 `nations` 语义迁移收口（§9 末条）。

---

## 11. 未决 / 待验证

| 项 | 状态 |
|---|---|
| §6 全部数值 | **DRAFT 推导值**，P2 econ-sim 前不得上线 |
| `p = 1000` 里「每次攻城兵耗 ~2,000」 | 估计值，由守军设计反推，未实测 |
| `nations` 集合是否整体删除 | 留到 P3 判断（§9 末条） |
| 城池易主保护期时长 | 沿用主城口径，未单独定数 |
| 宗门人数上限对 §8.1 总 faucet 的影响 | 宗门 ≤900 人（`GW_PUSH_REDIS_CHANNEL` 注释口径）；满编宗门吃满上限时的全服 faucet 总量待 `SLG_ECONOMY_CHECK.md` 轨道 2（赛季资源）核算 |
