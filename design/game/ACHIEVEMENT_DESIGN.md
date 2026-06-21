# 成就系统设计 — Achievements

> 状态：实现中（服务端基座 S9-1/2/4 + PvE 章节计数 S9-3 已落地，见 §11）· 权威：**本文（成就系统机制单一来源）**；数值（阈值/金币）镜像并最终落 [`ECONOMY_BALANCE.md §2.4`](ECONOMY_BALANCE.md)（DRAFT 初值）· 更新：2026-06-21

本文是成就子系统的**机制设计基准**：定位、数据模型、统计来源、解锁/领取流程、服务器权威与防刷、接口契约、UI、经济联动、实现拆解。
**具体阈值/金币不在本文拍死**——初值见 [`ECONOMY_BALANCE.md §2.4`](ECONOMY_BALANCE.md)；本文只镜像示例并标注权威指针，条目/阈值后期慢慢扩。

---

## 0. 一句话定位

成就是**与天梯无关的「统计里程碑」**：累计某类行为到阈值 → 分阶解锁 → **每阶一次性发金币**。
它是金币的 **one-shot faucet**（与广告/IAP/称号/日常并列），**全部一次性、绝不构成持续金币泵**。

与称号系统（机制权威 [`TITLE_DESIGN.md`](TITLE_DESIGN.md)；段位金币数字 [`ECONOMY_BALANCE.md §2.3`](ECONOMY_BALANCE.md)）正交。
> **2026-06-21 补**：成就**部分顶阶/标志性条目**额外授予一枚**永久称号**（`ach.*`），让成就也能变对外名片——定义模型加可选字段 `Achievement.titleId?: string`，达成顶阶时调 meta `grantTitle`（见 `TITLE_DESIGN §7`）。红线不变：成就仍**只发金币 + 称号，绝不发战力**；普通成就仍纯自看。

| | 称号系统（§2.3） | 成就系统（本文 / §2.4） |
|---|---|---|
| 触发 | PvP 天梯**段位首达** | 任意**统计里程碑**（击杀/释放/通关/胜场…） |
| 依赖 | ranked 队列（`S1-R`，未实现） | PvE 结算 + PvP 结算即可，**不依赖天梯** |
| 形态 | 一次性金币 + 分段持续胜利收益 | **纯一次性**金币，无持续收益 |
| 阶数 | 9 段，再升降不重复发 | 每条 3 阶（I/II/III），逐阶领 |

---

## 1. 设计铁律（不可违背）

| # | 铁律 | 出处 |
|---|---|---|
| A1 | **纯一次性**：每条成就每阶金币只发一次（`claimedTiers` 幂等），永不重复、永不可刷。整池封顶 ~8–9k 金币。 | ECONOMY_BALANCE §2.4、§2 顶部「平衡铁律」 |
| A2 | **计数只在服务器结算点写**：累加只发生在 PvE 结算 / PvP `match/report` 落库时，**无客户端直写计数的口子**。PvE 完全权威（方案 B 复算）；PvP 走战报统计**默认信任 + 异常复查 + 抽样审计**（§4.4），不阻塞结算。 | PVE_INTEGRITY_PLAN（方案 B）、SERVER_API §8.3、本文 §4.4 |
| A3 | **不污染公平红线**：成就奖励只发**金币**（可用于皮肤/盲盒），**绝不发战力**；不因 PvE 养成强弱而改变 PvP 结果。 | ECONOMY_BALANCE §5、META_DESIGN §11 总定位 |
| A4 | **解锁 ≠ 发放**：达阈值即「可领」，金币需玩家**主动领取**（红点驱动留存 + 发放仪式感）；领取时服务器二次校验 `stat ≥ threshold`。 | 本文 §4 |
| A5 | **数值活在数字文档**：本文不拍死阈值/金币，引用 ECONOMY_BALANCE §2.4；条目扩充时同步数字文档。 | README §0 三铁律 |

---

## 2. 概念模型

成就 = **统计计数器（stat）** + **分阶阈值/奖励定义** 两部分解耦：

```
行为发生 (击杀/释放/通关/胜利)
   └─► 服务器权威结算点累加 stats[statKey] += n        (A2)
          └─► 据成就定义判定 stats[statKey] ≥ tier 阈值
                 └─► 标记该阶 unlocked（可领，红点）        (A4)
                        └─► 玩家在成就墙点「领取」
                               └─► 服务器校验+发金币+记 claimedTiers   (A1/A4)
```

- **stat（统计量）**：终身累计、单调递增的整数（如「累计击杀弓箭手」）。一个 stat 可被多条成就复用。
- **achievement（成就定义）**：`{ id, statKey, tiers: [{threshold, coins} ×3] }`。纯静态配置，前期硬编码在 `@nw/shared`，后期可挪运营配置。
- **progress（玩家进度）**：`{ achId → claimedTiers }`，存玩家存档。当前阶 = 由 `stats[statKey]` 实时算出，不落库（避免双真源）。

> 设计取舍：**只持久化 stats + claimedTiers，不持久化「已解锁阶」**。解锁阶永远由 `stats` 当场推导 → 改定义/调阈值不需迁移玩家数据，且天然防「解锁了但 stat 对不上」的脏数据。

---

## 3. 数据模型（SaveData 扩展）

服务器权威，落 `saves.save`（主表见 SERVER_API §7）。新增两块：

```ts
// @nw/shared 类型
interface SaveData {
  // …现有字段…
  stats?: Record<StatKey, number>;          // 终身累计统计，服务器权威单调递增
  achievements?: Record<AchId, {
    claimedTiers: number[];                  // 已领阶号子集 ⊆ [1,2,3]，幂等防重领
  }>;
  antiCheat?: {                              // PvP 统计反作弊（§4.4），服务器权威，客户端不下发
    statSuspicion: number;                   // 造假命中累计 → 决定抽查档位
    lastFlaggedTs?: number;
  };
}
```

- `stats` 缺省视为全 0；`achievements[id]` 缺省视为 `{ claimedTiers: [] }`（懒创建，省存储）。
- **不存** `tier`/`unlocked`：客户端与服务器都用 `定义.tiers` + `stats[key]` 现算（§4.1）。
- 规范化：`PUT /save` 入站时 meta **拒绝客户端对 `stats`/`achievements` 的任何修改**（与 `coins`/`pvp` 同列服务器权威字段，客户端写入被忽略/驳回）。

### 3.1 StatKey 注册表（初期，与 §2.4 示例对齐）

> statKey 是稳定标识，一旦上线**只增不改不删**（改名 = 丢历史累计）。命名 `域.主体.动作`。

| StatKey | 含义 | 累加点（权威结算） |
|---|---|---|
| `kill.archer` | 累计击杀弓箭手 | PvE 结算 + PvP `match/report`（**仅 ranked**） |
| `kill.guard` | 累计击杀守卫 | 同上 |
| `cast.meteor` | 释放陨石次数 | PvE 结算 + PvP（**仅 ranked**） |
| `campaign.chaptersCleared` | 通关章节数（去重，取最大达成） | PvE 关卡首通结算 |
| `pvp.wins` | 累计 PvP 胜场 | PvP `match/report`，**仅 ranked**、winner=本方时 +1 |

> 上表 5 条对应 [`ECONOMY_BALANCE.md §2.4`](ECONOMY_BALANCE.md) 的模板示例（~25 条规划，逐步扩）。
> - `campaign.chaptersCleared` 取「最大已通关章节数」而非简单 ++（首通才计、重打不涨），由 PvE 结算用 `$max` 语义维护。
> - **PvP 类 statKey 一律只认 `ranked` 局**（friendly 好友房可串通刷胜/对刷，不计；见 §10 决策①）。friendly 局的 `match/report` 不喂 stats。
> - 每条 statKey 须标注「是否计 PvE 重打」（防刷易关 farming，多数 `kill.*` 接受重打、特殊条目可关）。

---

## 4. 解锁与领取流程

### 4.1 当前阶推导（无状态，客户端/服务器同算）

```ts
function tierState(def: Achievement, stats: SaveData['stats'], claimed: number[]) {
  const v = stats?.[def.statKey] ?? 0;
  return def.tiers.map((t, i) => {
    const tier = i + 1;
    return {
      tier,
      reached: v >= t.threshold,                       // 达阈值
      claimable: v >= t.threshold && !claimed.includes(tier), // 可领（红点源）
      claimed: claimed.includes(tier),
      progress: Math.min(v, t.threshold) + '/' + t.threshold,
    };
  });
}
```

- **红点聚合**：任一成就存在 `claimable` 阶 → ProfileScene/成就墙入口亮红点（复用社交红点聚合机制，见 SOCIAL）。
- 阶严格递增：领取无需按序，但高阶阈值 ≥ 低阶，达高阶必已达低阶。

### 4.2 计数累加（服务器，A2）

唯一写入 `stats` 的位置是**服务器权威结算**，分两条链：

1. **PvP（直接上报，2026-06-21 定）**：**仅 `ranked` 局**——`game→meta` 的 `match/report`（SERVER_API §8.3）扩上报体携带「本方本局 `kill.*`/`cast.*` 统计」，meta **默认信任直接累加**；`pvp.wins` 由 meta 据已校验的 `winner_side` 自增（本就服务器权威）。**friendly 局一概不计**（防串通刷）。**不逐局复算**（锁步局帧日志复算成本高），改用 §4.4 的「异常复查 + 抽样审计 + 作弊者升档」三层兜底。
2. **PvE**：关卡结算走 `server/shared/pveRewards.ts`（PVE_INTEGRITY 方案 B，服务器权威）。结算时一并累加该局 stats，与发奖同一事务，天然防客户端伪造——PvE **无需** §4.4 抽查（已逐局权威）。

> 累加必须**幂等于「同一局」**：PvE/PvP 结算本身已有去重/防重放（方案 B、`hashOk`、order saga 思路），stats 累加挂在其成功提交点之后，不另开口子。

### 4.4 PvP 统计反作弊（轻量三层，不阻塞结算）

> 原则：成就金币池小（~8–9k 一次性、不卖战力），**不值得为它给每局 PvP 上重型复算**；用低成本概率兜底，把作弊的期望收益压到不划算即可。

| 层 | 机制 | 触发 |
|---|---|---|
| L1 **异常复查** | 上报统计若**离谱超界**（单局击杀 > 该局理论上限、`cast.meteor` > 本局法术出牌数等硬边界），meta 当场拒收该局统计（`pvp.wins` 仍照常算）并标记一次嫌疑。硬边界由 `@nw/engine` 已知约束推出（费用上限/帧数/单位数）。 | 每局，廉价（纯比大小，不复算） |
| L2 **随机抽查** | 以基础概率 `p0`（如 1–2%）随机抽取已落库的局，用内嵌 `replay`（`matches.replay` 帧日志，已为重连零成本持久化）服务器侧复算真实 `kill.*`/`cast.*`，与上报值比对。 | 异步离线批，不在结算热路径 |
| L3 **作弊者升档** | 玩家若曾被 L1/L2 实锤过统计造假，其抽查概率从 `p0` 抬到 `p_flagged`（如 25–50%），并**永久保留一个 `suspicionScore`**（命中越多升越高）。复查命中 → 回滚该局 stats + 计入运营审查（OPS 工单）。 | 命中后对该账号长期生效 |

- **存档字段**：`SaveData.antiCheat?: { statSuspicion: number, lastFlaggedTs?: number }`（服务器权威，客户端只读甚至不下发）。`statSuspicion` 决定该账号的抽查档位。
- **回滚**：复查实锤造假 → meta 扣回已多计的 stats（可能导致已领阶变「超领」，但金币**不追回**，只阻止后续阶领取 + 升 suspicion + 严重者走 OPS 封禁流程）。
- **与 OPS 联动**：L2/L3 命中写入运维后台审查队列（OPS_DESIGN），人工可复核/封禁；高 `statSuspicion` 账号在 ops 看板可筛。
- **不做**：逐局强制复算、客户端反作弊 SDK、实时阻断（都与「小金币池」不成比例）。

### 4.3 领取（服务器，A1/A4）

`POST /achievements/claim { achId, tier }`：
1. 取玩家 `stats` + `achievements[achId].claimedTiers`。
2. 校验：定义存在 → `stats[statKey] ≥ tiers[tier-1].threshold`（**二次校验，不信客户端**）→ `tier ∉ claimedTiers`。
3. 通过：`claimedTiers ∪= {tier}`（`$addToSet` 幂等）+ 发金币 `coins += tiers[tier-1].coins`（金币权威路径见 §5）。
4. 任一校验失败：`NOT_REACHED` / `ALREADY_CLAIMED` / `BAD_REQUEST`，不发币。

幂等保证：并发双击同一 (achId,tier) → `$addToSet` + 条件更新（`claimedTiers` 不含 tier 才发币）确保金币只发一次。

---

## 5. 金币发放路径

成就金币是**玩家主动领取的即时反馈**，选**直接发放**（非邮件）：

- meta 在 `claim` 事务内直接 `coins +=`（与称号首达、日常奖励同路径——服务器权威字段直改，回推 `SaveData`）。
- **不走 commercial 充值通道**（那是 IAP/广告等值挂钩）；成就金币是游戏内 faucet，与日常/称号同性质，meta 直接记账即可。
- **不走邮件 fan-out**（邮件用于运营补偿/异步奖励，见 OPS）；成就是同步领取，邮件反而割裂体感。

> 对照：ops 补偿走邮件（异步、批量、可审计）；成就/日常/称号走直接记账（同步、玩家在场、即时反馈）。两条路径不混。

---

## 6. 接口契约（拟新增，落 SERVER_API）

```
GET  /achievements              (JWT) → { defs: Achievement[], stats, achievements }
POST /achievements/claim        (JWT) { achId, tier:1|2|3 }
       → { save: SaveData, granted: number }
       | NOT_REACHED | ALREADY_CLAIMED | BAD_REQUEST
```

- `GET /achievements`：回**定义表 + 我的 stats + 已领进度**，客户端本地算阶（§4.1）。defs 也可随 `GET /save` 静态下发（定义不常变，可缓存 + 版本号）。
- **无 `report` / `increment` 端点**：计数只在 §4.2 两条权威结算链内累加，**不开放客户端任何写计数的口子**（A2）。
- DB：复用 `saves` 主表新增字段（§3），无新集合。

### 6.1 已决（2026-06-21）

- [x] **PvP 计数来源**：**直接上报**——扩 `match/report` 上报体带本局统计，meta 默认信任累加；防刷靠 §4.4 异常复查（L1）+ 随机抽查（L2）+ 作弊者升档（L3），**不逐局复算**。
- [x] **定义存放**：**硬编码**在 `@nw/shared` 常量（此系统变动小，无需运营可配）；改条目 = 发版。
- [x] **离线领取红点**：`claimable` 随 `GET /save`/`GET /achievements` 下发 `stats` 后客户端本地算（§4.1），无需服务端额外推送。

### 6.2 实现前仍需对齐

- [x] **PvE 计数粒度（S9-3 已对齐，2026-06-21）**：PvE **唯一能服务器权威产出**的成就 stat 是 `campaign.chaptersCleared`（由 `levelId` 派生，首通 `$max`，不依赖客户端上报）。`kill.archer`/`kill.guard`/`cast.meteor` 设计上（§3.1）也想由 PvE 喂，但**当前不可权威产出**：① `@nw/engine` 只在 `PlayerStats` 累计聚合 `unitsKilled`/`spellHits`，**无分兵种击杀、无分法术 cast**；② 普通通关服务器**不跑引擎**（只信客户端 stars + 抽样录像复算），裁判 verdict 也只回 `stars`，故无法当场拿到分项计数；③ A2 铁律禁止客户端直写「无法复算的计数」。→ 故 S9-3 只落 `campaign.chaptersCleared`；PvE 的 kill/cast 喂入拆为后续 **S9-3b**：需「引擎分类型埋点（per-victimType kill / per-spellType cast）进 deterministic snapshot → 裁判 verdict 扩展回这些计数 → `/pve/verify` 比对后入账」。在此之前 `kill.*`/`cast.*` 仅由 PvP 上报（S9-6）喂。
- [ ] **L1 硬边界来源**：单局各 statKey 的理论上限怎么从 `@nw/engine` 约束推出（费用/帧数/单位数），需与引擎侧确认可取。

---

## 7. 客户端 UI

> UI 规格权威：[`UI_DESIGN.md`](UI_DESIGN.md)；本文只定信息结构，UI_DESIGN §4.6「成就墙（后续）」据此落地。

- **入口**：ProfileScene（档案）→ 成就墙（UI_DESIGN §4.6 / META_DESIGN §11 ProfileScene 已占位「成就墙（后续）」）。
- **仅自看，不对外展示（2026-06-21 定）**：成就墙只在**自己的**档案出现；**他人资料弹层（PROFILE_POPUP）不显示成就**。对外炫耀走**称号系统**（天梯段位称号才是公开身份标签，§2.3）——成就是「个人收集/金币领取」，称号是「公开战绩名片」，两者分工不混。
- **分类法（taxonomy）**：定义表每条带 `category ∈ { pve, pvp, collection, progression }`，成就墙按此分 tab。
- **成就墙**：每分类下列成就卡，每卡显示三阶进度条（`progress`）+ 各阶状态（已领/可领/未达）+ 可领阶的「领取」按钮。
- **解锁通知（toast）**：达成（非领取）瞬间弹一次性 toast「成就达成：X」。触发时机 = PvE 结算页 / 回到大厅刷新 `stats` 后比对；**一次结算多阶/多条达成只汇总弹一次**（不逐条轰炸），点 toast 跳成就墙领取。
- **红点**：入口 + 分类 tab + 成就卡三级红点，源于任一 `claimable`（§4.1）。
- **i18n**：新增 `achievement.*`（标题/描述/阶位/领取/已领/进度/达成 toast），中英双语；**禁韩文**（见 memory）。
- 离线：未登录显「登录后查看」（同 StatsScene 既有处理）。

---

## 8. 经济联动（与 ECONOMY 对齐）

- **数字权威**：阈值 + 各阶金币 = [`ECONOMY_BALANCE.md §2.4`](ECONOMY_BALANCE.md)（DRAFT）。单条满阶 ~350 金币，~25 条 → **全游戏一次性 ~8–9k 金币池**。
- **反通胀**：纯一次性（A1）→ 不进 §6 持续通胀推演的「每日产出」项，只作为新手期/长线一次性补给，摊薄到月产出 ~10（见 ECONOMY_NUMBERS faucet 摊薄表）。
- **命名约定**：「里程碑 / milestone」一词专留给成就系统（ECONOMY_NUMBERS:109 已与单位养成「trait」脱钩）。
- **待验证**（ECONOMY_BALANCE §9 遗留）：称号 + 成就金币初值需用模拟验证总产出不冲垮金币经济。

---

## 9. 实现拆解（建议任务，落 META_TASKS）

> 依赖：PvE 结算（PVE_INTEGRITY 方案 B，已实现）即可上 PvE 成就；PvP 计数来源已拍板直接上报（§6.1），但 `pvp.wins`/段位类与天梯（`S1-R`）联动更佳。**可先做 PvE 半，PvP 半随上报扩展跟进。**

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **A-1** | `@nw/shared`：`StatKey`/`AchId` 类型 + **硬编码 `Achievement` 定义表**（§3.1 五条初值）+ `tierState` 纯函数 | — |
| **A-2** | SaveData 扩 `stats`/`achievements`/`antiCheat`；`PUT /save` 把三者列入服务器权威只读字段 | A-1 |
| **A-3** | PvE 结算累加 stats（挂 `pveRewards.ts` 成功提交点，与发奖同事务） | A-2、方案 B |
| **A-4** | `GET /achievements` + `POST /achievements/claim`（二次校验 + `$addToSet` 幂等发币） | A-2 |
| **A-5** | 客户端成就墙 UI（ProfileScene）+ 红点聚合 + i18n（`achievement.*`） | A-4、UI_DESIGN §4.6 |
| **A-6** | PvP 计数：扩 `match/report` 上报体带 `kill.*`/`cast.*`；meta 直接累加 + `pvp.wins` 据 winner 自增；L1 异常复查（硬边界拒收） | A-3、§6.2 |
| **A-7** | 反作弊 L2/L3：离线随机抽查（replay 复算比对）+ `statSuspicion` 升档 + OPS 审查队列联动 | A-6、OPS_DESIGN |
| **A-8** | 埋点：解锁/领取事件上报 analyticsvc（成就漏斗/卡点/无人达成条目） | A-4、ANALYTICS_DESIGN |
| **A-9** | 测试守护：claim 幂等 / 未达拒发 / **红线（只发金币不碰战力）** / L1 硬边界 单测 | A-4、A-6 |
| **A-10** | 数值校准：成就金币池跑模拟验证不冲垮经济（ECONOMY §9） | A-4 |

---

## 10. 设计评审决策（2026-06-21 全部拍板）

### 高（正确性/防刷）

1. **PvP 成就仅计 `ranked` 局 ✅**：friendly（好友房）可与好友**串通刷胜/对刷**，故 `pvp.wins` 及所有 PvP 类 `kill.*`/`cast.*` **只认 ranked**，friendly 局 `match/report` 不喂 stats（已落 §3.1 / §4.2）。
2. **新增成就追溯 ✅（接受）**：复用**已统计** statKey 的新条目 → 老玩家凭 lifetime stat **自动追溯解锁**；引入**新 statKey** → 从加入版本起计，历史**不回填**。加成就时知会此语义即可。
3. **PvE 重打 farming ✅（接受）**：关卡可重打刷 `kill.*`，但奖励一次性且小、纯耗时间非作弊，接受；若某 statKey 被滥用再按 §5.2 副本衰减给「重打不计」。逐 statKey 标注「是否计重打」。

### 中（体验/运营）

4. **解锁 toast ✅**：达成瞬间弹一次性「成就达成」toast，一次结算多阶/多条只汇总弹一次，点击跳成就墙（已落 §7）。
5. **成就纯自看、不对外展示 ✅**：他人资料弹层（PROFILE_POPUP）**不显示成就**；**对外炫耀只走称号系统**（天梯段位称号 = 公开身份名片）。成就 = 个人收集/领币，称号 = 公开战绩，两者分工（已落 §7）。
6. **分类法 ✅**：`category ∈ { pve, pvp, collection, progression }`，定义表每条带 `category`，成就墙按此分 tab（已落 §7）。
7. **埋点 ✅**：解锁/领取上报 analyticsvc（漏斗/卡点/无人达成），落 A-8。
8. **与日常任务计数不串 ✅**：日常任务（§2.5）按 `dayKey` 独立计数，**不复用** lifetime `stats`；两套互不干扰、仅行为上叠加触发。实现时确保不串。

### 低（后置，模型已预留）

9. **元/隐藏成就**：「集齐/全领」元成就、彩蛋成就——后期内容扩充再加，定义模型加 `hidden?: boolean` 即可支持。
10. **SLG 成就**：SLG 自有赛季称号（「十冠王」，SLG_DESIGN §U3）。暂定 SLG 行为不喂本系统；将来打通需新 statKey，且成就仍只发金币不发战力（红线不破）。

### 实现前仍需与代码对齐（非决策，技术细节）

- **PvE 计数粒度**（§6.2）：`pveRewards.ts` 结算是否已分兵种 kill / 法术 cast 计数。
- **L1 硬边界来源**（§6.2）：单局各 statKey 理论上限从 `@nw/engine` 约束推出。

---

## 11. 实现记录

### S9-1/2/4 服务端基座（2026-06-21）

落地范围 = 成就系统的**服务端权威纵切**：定义 + 模型 + 读/领端点 + 测试。PvE/PvP 累加（S9-3/6）、客户端 UI（S9-5）、反作弊 L2/L3（S9-7）、埋点（S9-8）留后续会话。

- **S9-1 共享层** `server/shared/src/achievements.ts`（barrel 导出）：
  - 类型 `StatKey`（5 个：`kill.archer`/`kill.guard`/`cast.meteor`/`campaign.chaptersCleared`/`pvp.wins`）/`AchId`/`AchCategory`/`Achievement`/`AchTier`/`TierState`。
  - 硬编码 `ACHIEVEMENTS`（5 条 ×3 阶，阈值/金币 = §2.4 DRAFT；`campaign.chaptersCleared` 顶阶「全部」暂占位 9 章，章节扩充时同步）。`Achievement` 预留 `titleId?`（§0 顶阶发称号）/`hidden?`（§10-9 彩蛋）/`countsReplay?`（§10-3 重打语义，仅审计不影响累加）。
  - 纯函数：`tierState`（§4.1 无状态阶推导）/`hasClaimable`（红点聚合）/`validateClaim`（§4.3 二次校验，返 `BAD_REQUEST`/`NOT_REACHED`/`ALREADY_CLAIMED` 或 `{ok,coins,tier}`）/`findAchievement`。
- **S9-2 模型** `shared/types.ts` `SaveData` 加 `stats?`/`achievements?`/`antiCheat?`（全可选懒创建，缺省视全 0/空；legacy 档不迁移）。`openapi.yml` SaveData 同步加 `stats`/`achievements`（非 required）。
  - **PUT /save 守卫无需新增**：`applySyncPatch` 本就是白名单（仅 `equipped`/`flags`），三段被结构性丢弃，客户端塞了不落库（A2）。
  - **`antiCheat` 刻意不进 wire schema**（§3「服务器侧只读甚至不下发」）；S9-7 前永不写入，故当前不出现在回包。
- **S9-4 端点**（`openapi.yml` + `MetaService`）：
  - `GET /achievements` → `{ defs: ACHIEVEMENTS, stats, achievements }`，客户端本地算阶（§6）。新增 `Achievement` component schema。
  - `POST /achievements/claim {achId,tier}` → 流程：①`mutateSave` 内 `validateClaim` + 原子记 `claimedTiers`（rev 守卫保证本调用是唯一获胜者，并发双击只一个记成功）；②记成功后 `commercial.grant` 发币（**确定性 orderId `ach:{accountId}:{achId}:{tier}` 幂等**，防重复发）；③`mirrorCoins` 回推。错误码 `NOT_REACHED`(400)/`ALREADY_CLAIMED`(409)/`BAD_REQUEST`(400)。
  - **与 §5 的偏离（已确认）**：§5 写「meta 直接记账 coins +=」是 S5 前（钱包在 meta saves）的设想；**S5 起钱包权威迁 commercial、save.wallet 仅镜像**，故成就金币改走 `commercial.grant`（与 mail/ads/victory 同步发币路径一致，仍非邮件 fan-out，体感不变）。§5「同步直接发放、不走邮件」的原则保持。
  - **崩溃窗口**：已记阶但发币失败 → 回 `granted:0`，确定性 orderId 可后续补发（金额小、一次性，可接受，同 PvE 发奖风险等级）。
- **测试**：`metaserver/test/achievements.test.ts`（12 纯函数单测，无 Mongo 总跑）+ `achievements.e2e.test.ts`（7 e2e：GET 回定义+进度 / 未达拒发不发币 / 达阈发该阶币+记阶 / 重复 409 只发一次 / **并发恰一发** / 越界 400 / 逐阶累加）。**meta 全套 132 测试绿**（+19），`tsc -b shared metaserver gameserver commercial gateway` 干净。

### S9-3 PvE 章节通关计数（2026-06-21）

- **范围**：PvE 结算累加 `campaign.chaptersCleared`（§6.2 对齐结论：这是 PvE 唯一可服务器权威产出的 stat；kill/cast 拆 S9-3b）。
- **共享纯函数** `shared/src/pveRewards.ts` `chaptersClearedCount(cleared)`：章节 = 终关 `ch{N}_lv{max}`，终关 id 由 `PVE_LEVELS` 派生（单一来源，不硬编码 lv10）；返回 cleared 中含的终关个数。特殊关 `ch_stress`（无 `_lvN`）不计。cleared 单调增 → 结果单调增。barrel 导出。
- **挂载点** `metaserver/service.ts` `writeClearProgress`：折进既有 `mutateSave` 事务（与 progress/stars 同一 rev 守卫的原子写，**天然权威、与 S9-4 claim 解耦**）。`$max` 语义：`chapters > prev` 才写，且无章节通关+无既有 stats 时不实例化 `stats`（懒创建，省存储）。普通通关 / 抽检通关（`writeClearProgress` 在抽检分支也照写 progress）两路都覆盖。
- **测试**：`chapters-cleared.test.ts`（7 纯函数单测：空/章内非终关不计/终关计 1/多章去重/重复去重/`ch_stress` 不计/单调）+ `pve.e2e.test.ts` 新增 1 e2e（非终关不涨 / 种 9 关后通终关 +1 / 重打不涨 / 二章 +1）。**meta 全套 140 测试绿**（+8），`tsc -b shared metaserver gameserver commercial gateway` 干净。

> **下一会话接续点**：S9-5（客户端成就墙 UI + i18n `achievement.*`，并 `npm run rest:gen` 重生 openapi 客户端类型）→ S9-6（PvP `match/report` 上报 `kill.*`/`cast.*` + meta 累加 + L1 异常复查）→ **S9-3b**（引擎分类型埋点，让 PvE 也能喂 kill/cast，§6.2）→ S9-7/8。任务跟踪见 `META_TASKS.md` S9。
