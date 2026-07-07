# 留存系统设计 — Daily Retention（签到 / 每日任务 / 周常）

> 状态：**P0 已实现（2026-06-22）**，签到奖励表 + Tab 改版见 §10.4（2026-07-05） · 权威：**本文（留存系统机制单一来源）**；数值（奖励/上限/曲线）镜像并最终落 [`ECONOMY_NUMBERS.md §12`](ECONOMY_NUMBERS.md)（DRAFT 初值）· 更新：2026-07-05
>
> **实现记录（B5 2026-06-22）**：
> - `server/shared/src/retention.ts` — 纯函数 + 类型（`RetentionSave`, `CHECKIN_REWARDS[30]`, `DAILY_TASKS[3]`, `accrueRetentionTask`, `claimCheckinDay`, `claimDailyReward`）
> - `server/shared/src/types.ts` — `SaveData.retention?: RetentionSave`
> - `server/metaserver/src/service.ts` — `getRetention` / `claimCheckin` / `claimDailyReward` + PvE/ads 打点
> - `server/metaserver/src/internal.ts` — PvP 结算时 `pvp.match` 打点（内嵌 `applyPvp`）
> - `server/contracts/openapi.yml` — `GET /retention` / `POST /retention/checkin` / `POST /retention/daily/claim`
> - `client/src/game/meta/retention.ts` — 客户端镜像纯函数
> - `client/src/game/meta/SaveData.ts` — `retention?` 字段
> - `client/src/net/ApiClient.ts` — `getRetention/claimCheckin/claimDailyReward` + `RetentionView` 类型
> - `client/src/scenes/DailyScene.ts` — 月历 + 每日任务 UI（新建）
> - `client/src/scenes/LobbyScene.ts` — `onOpenDaily` 回调 + 「每日」按钮 + `applyRetentionBadge`
> - i18n `daily.*` / `checkin.*` (zh/en/de)

本文是留存子系统的**机制设计基准**：定位、三层结构、数据模型、dayKey 防刷、解锁/领取流程、服务器权威、接口契约、UI、经济联动、实现拆解。
**具体数额不在本文拍死**——初值见 [`ECONOMY_NUMBERS.md §12`](ECONOMY_NUMBERS.md)；本文只镜像示例并标注权威指针。

设计同构参照：[`ACHIEVEMENT_DESIGN.md`](ACHIEVEMENT_DESIGN.md)（领取流程 / 服务器权威 / 红点 / SaveData 扩展几乎照搬）。

---

## 0. 一句话定位

留存系统是**"每天回来"的钩子**：登录即领（签到）+ 目标驱动（每日任务）+ 容错累计（周常）。
它的**奖励主体是软通货**（体力 / 养成材料 / 单位卡 / 抽卡碎片），**金币只走每日任务且严格日上限**，整体收敛进 [`ECONOMY_NUMBERS.md §6.1`](ECONOMY_NUMBERS.md) 既有的"日常任务 ~60/月"预算——**不新增金币龙头**。

与成就/称号的根本区别：

| | 称号（ECONOMY_BALANCE §2.3） | 成就（ACHIEVEMENT_DESIGN） | **留存（本文）** |
|---|---|---|---|
| 触发 | 天梯段位首达 | 统计里程碑 | **每日 dayKey 刷新** |
| 形态 | 一次性金币 | 纯一次性金币 | **每日重复，受日/月上限** |
| 主奖励 | 金币 | 金币 | **软通货为主，金币极少** |
| 通胀风险 | 低（一次性） | 低（一次性） | **高（唯一的"持续金币泵"）→ 必须硬控** |

---

## 1. 设计铁律（不可违背）

| # | 铁律 | 出处 / 理由 |
|---|---|---|
| R1 | **不新增金币龙头**：签到/任务的金币产出全部计入 ECONOMY_NUMBERS §6.1「日常任务 ~60/月」预算，月度严格收敛；签到本体几乎不发金币，金币只从「每日任务满点」一次性出且有日上限。 | 留存是唯一的持续 faucet，反通胀红线（ECONOMY_BALANCE §1） |
| R2 | **服务器权威 + dayKey**：刷新边界、计数、领取全在服务器；客户端只读展示、领取走 API、服务器按 `dayKey` 二次校验。复用广告金币既有的 `dayKey 计数 + 冷却时间戳`（ECONOMY_NUMBERS §6.2）。 | 防刷（与成就 A2 同构） |
| R3 | **不污染公平红线**：奖励能发养成料/卡/碎片/金币，**绝不直接进 PvP 蓝图**——与 armor/装备/养成同走硬墙。 | ADR-009 硬墙、ACHIEVEMENT A3 |
| R4 | **解锁 ≠ 发放**：达成即「可领」，需玩家**主动领取**（红点驱动留存 + 发放仪式感），领取时服务器二次校验当日状态。 | ACHIEVEMENT A4 |
| R5 | **温和档，断签不惩罚**：漏签**不清零、不扣已得**，只是「当天那格没领到」。用**月历式累计**（本月累计领 N 天解锁大奖）而非脆弱的「连续 N 天」，对休闲玩家友好。 | 与全经济温和基调一致（装备失败不碎、ADR-009）；连续清零会逼走休闲玩家 |
| R6 | **任务计数不开客户端写口**：每日任务进度只在**服务器权威结算点**累加（PvE 结算 / `match/report` / 广告冷却校验点），与成就 A2 一致，绝不信客户端自报。 | 防刷 |
| R7 | **数值活在数字文档**：本文不拍死奖励/曲线/上限，引用 ECONOMY_NUMBERS §12。 | README §0 三铁律 |

---

## 2. 三层结构

由浅到深，钩子原理不同，**优先级 P0 = 前两层**，周常 P1 缓做。

| 层 | 机制 | 钩子原理 | 主奖励 | 优先级 |
|---|---|---|---|---|
| **每日签到** | 登录即领，**月历式**累进（本月累计第 7/14/21/30 格给大奖），跨月重置 | 损失厌恶 + 累计成就感 | 体力 / 材料 / 碎片，**金币极少或无** | **P0** |
| **每日任务** | 当日 3~4 条轮换（打 1 局 PvP / 刷 3 关 / 合成 1 次 / 看 1 条广告 / 围攻 1 次） | 目标驱动，引导核心循环 | **任务点** → 当日满点一次性发金币（计入 ~60/月） | **P0** |
| **周常活跃宝箱** | 周内累计活跃度（=每日任务点周累计）达档解锁宝箱，跨周重置 | 把"补漏"心理拉成周维度，容错单日漏做 | 装备 / 高级材料 / 限定 | P1（缓做） |

### 2.1 每日签到曲线（月历式）`[可调 → §12]`

- **形态**：30 格月历，每自然日（服务器时区）可领当月「下一未领格」一格。
- **累进**：第 7 / 14 / 21 / 30 格为里程碑大奖（体力包 / 卡包 / 中级材料包 / 月末压轴装备）。
- **断签**：漏签只是当天不点亮，**累计格数不回退**；可选「补签」道具（金币/广告购买，劝退价，[可调]，前期不做）。
- **跨月**：每月 1 号格位与已领记录重置（`monthKey`）。
- **实现（2026-07-05）**：`CHECKIN_REWARDS[30]` 落定（`server/shared/src/retention.ts`）——常规格在体力（+30）间穿插材料滴灌（约每 3 格一次 scrap/lead/binding，全月覆盖，非只挂里程碑格）；里程碑格：第 7 天体力包（+100）、第 14 天卡包（**随机**从抽卡卡池均匀抽 1 张角色卡）、第 21 天中级材料包（lead ×5）、第 30 天月末压轴（**随机**从 equip_t1 抽 1 件装备）。卡/装备**不做**权重池抽取（commercial 的 `rollCustomGacha` 属于跨服务边界，metaserver 不依赖 `@nw/commercial`），改为 `@nw/shared` 内新增的 `pickRandomCatalogItem(category)`——同一份抽卡目录（`GACHA_CATALOG`）内均匀随机，纯函数、无 DB。签到本体自此**不再发金币**（`kind:'coins'` 只留兼容旧存档解析），符合 R1。

### 2.2 每日任务池 `[可调 → §12]`

- **池**：一组静态任务定义（`@nw/shared` 硬编码，后期挪 admin 运营可配）。
- **当日选取**：服务器按 `dayKey` 派发 3~4 条（前期可固定全集，不做随机以省复杂度；随机派发后置）。
- **任务点**：每条完成给 N 点；当日累计点数达「满点」时一次性发金币（**金币只在这里出**），点数不跨日累计。
- **任务示例**（statKey 复用成就的累加链，见 §3.1）：

  | 任务 | 计数源（权威结算） | 完成条件 |
  |---|---|---|
  | 打 1 局 PvP | `match/report` | 当日参战 ≥1 |
  | 刷 3 关 PvE | PvE 结算（`pveRewards.ts`） | 当日通关 ≥3 |
  | 合成 1 次 | PvE 养成结算（`/pve/upgrade`） | 当日合成 ≥1 |
  | 看 1 条广告 | 广告冷却校验点（ECONOMY_NUMBERS §6.2） | 当日看广告 ≥1 |
  | 参与 1 次围攻 | worldsvc 围攻结算（SLG_DESIGN §16） | 当日围攻 ≥1（SLG 接通后） |

### 2.3 周常活跃宝箱（P1，结构占位）`[可调 → §12]`

- 周累计活跃点（= 每日任务点的 `weekKey` 累计）达 30/60/100 解锁三档宝箱。
- 主发装备/高级材料/限定皮肤碎片；金币若有也计入月度预算。
- **缓做**：等签到/任务上线后看真实活跃数据再调档位与奖励。

---

## 3. 数据模型（SaveData 扩展）

服务器权威，落 `saves.save`（主表见 SERVER_API §7）。与成就 `stats`/`achievements` 同列**服务器只读权威字段**，`PUT /save` 拒绝客户端修改。

```ts
// @nw/shared 类型
interface SaveData {
  // …现有字段（含 stats / achievements）…
  retention?: {
    checkin?: {
      monthKey: string;       // "2026-06"，跨月重置触发
      claimedDays: number[];  // 本月已领格号子集 ⊆ [1..30]，$addToSet 幂等
    };
    daily?: {
      dayKey: string;         // "2026-06-21"，跨日重置触发
      taskPoints: number;     // 当日累计任务点（由服务器结算点累加）
      rewardClaimed: boolean; // 当日满点金币是否已领（幂等）
    };
    weekly?: {                // P1，先占位
      weekKey: string;        // ISO 周，如 "2026-W25"
      activityPoints: number;
      claimedTiers: number[]; // 已领宝箱档 ⊆ [1,2,3]
    };
  };
}
```

- 缺省视为「未签到/未做任务」（懒创建，省存储）。
- **跨边界重置**：服务器在每次读/写时比对 `monthKey`/`dayKey`/`weekKey`，过期则归零对应块（不依赖定时任务，惰性重置更稳）。
- **不存「可领状态」**：可领与否由 `claimedDays` + 当前 dayKey/monthKey + 任务点现算（§4.1），改定义不需迁移玩家数据（与成就同策略）。

### 3.1 计数复用

每日任务的进度计数**复用成就的 statKey 累加链**（ACHIEVEMENT §3.1 / §4.2），不另开计数口子：

- PvP：`match/report` 落库时同步推进当日任务（`pvp.wins` 等已在累加）。
- PvE：`pveRewards.ts` 结算点（关卡通关 / 升级）。
- 广告：广告冷却校验通过点。
- 围攻：worldsvc 围攻权威结算点（SLG 接通后）。

> 区别：成就累加**终身单调 stats**；留存累加**当日 `daily.taskPoints`**（跨日清零）。两者挂在同一批服务器结算点上，一次结算同时推进，互不另开口子。

---

## 4. 解锁与领取流程

### 4.1 状态推导（无状态，客户端/服务器同算）

```
登录 / GET /retention
  └─► 服务器比对 monthKey/dayKey/weekKey，过期块惰性重置
        └─► 签到：当月「下一未领格」claimable（红点）
        └─► 任务：taskPoints ≥ 满点阈值 && !rewardClaimed → claimable（红点）
        └─► 周常：activityPoints ≥ 某档 && 档 ∉ claimedTiers → claimable（红点）
```

- **红点聚合**：任一 claimable → 大厅/ProfileScene 入口亮红点（复用社交/成就既有红点聚合，见 SOCIAL）。
- 签到「下一未领格」严格按月历顺序（不可跳格领）；任务/周常无序可领。

### 4.2 计数累加（服务器，R2/R6）

唯一写入 `daily.taskPoints` / `weekly.activityPoints` 的位置 = §3.1 的服务器权威结算点，与成就 stats 累加同事务挂载，**不开放任何客户端写计数端点**。

### 4.3 领取（服务器，R4）

三个领取动作，统一「二次校验 + 幂等」：

```
POST /retention/checkin                 → 领当月下一格
  校验：当前 monthKey 匹配 → day ∉ claimedDays → claimedDays ∪= {day}（$addToSet）→ 发奖
POST /retention/daily/claim             → 领当日满点金币
  校验：dayKey 匹配 → taskPoints ≥ 满点阈值 → !rewardClaimed → rewardClaimed=true → 发金币
POST /retention/weekly/claim { tier }   → 领周常宝箱档（P1）
  校验：weekKey 匹配 → activityPoints ≥ tiers[tier] → tier ∉ claimedTiers → 发奖
```

- 任一校验失败：`NOT_REACHED` / `ALREADY_CLAIMED` / `BAD_REQUEST`，不发奖。
- 并发幂等：`$addToSet` + 条件更新（布尔/集合未含才发）确保每格/每档只发一次。

---

## 5. 奖励发放路径

留存奖励是**玩家在场的即时反馈**，选**直接发放**（非邮件）：

- **金币**：meta 在 claim 事务内直接 `coins +=`（与成就/称号/日常同路径，服务器权威字段直改）。**不走 commercial、不走邮件**（同 ACHIEVEMENT §5）。
- **软通货**（体力/材料/卡/碎片）：同事务直改对应服务器权威字段（`stamina`/`materials`/`unitCard`/抽卡碎片）。体力发放尊重 `STAMINA_MAX` 上限（溢出按规则处理，[可调]：可溢出存包或截断，初定截断到上限）。

> 对照：ops 补偿走邮件（异步/批量/可审计）；留存/成就/称号/日常走直接记账（同步/玩家在场/即时反馈）。两条路径不混。

---

## 6. 接口契约（拟新增，落 SERVER_API）

```
GET  /retention                         (JWT) → { checkin, daily, weekly, defs }
POST /retention/checkin                 (JWT) → { save, granted }
POST /retention/daily/claim             (JWT) → { save, granted }
POST /retention/weekly/claim            (JWT) { tier:1|2|3 } → { save, granted }
       共用错误：NOT_REACHED | ALREADY_CLAIMED | BAD_REQUEST
```

- `GET /retention`：回当前三块状态 + 定义表（签到月历奖励表 / 任务池 / 周常档），客户端本地算 claimable（§4.1）。defs 可随 `GET /save` 静态下发 + 版本号缓存。
- **无 `report`/`increment` 端点**：计数只在 §4.2 服务器结算链累加。
- DB：复用 `saves` 主表新增 `retention` 字段（§3），无新集合。

### 6.1 待定项（实现前需拍）

- [x] 签到月历 30 格的具体奖励表（哪些格给体力/材料/卡/装备，里程碑大奖内容）→ 见 §2.1 实现记录（2026-07-05）。
- [ ] 每日任务「满点」阈值与金币额（必须使月度收敛到 ~60）→ §12 + ECONOMY §9 模拟验证。
- [ ] 任务池是否做随机派发（前期倾向固定全集，不随机）。
- [ ] 补签道具是否做（前期不做）。
- [ ] 体力溢出处理（截断 vs 存包）。
- [ ] 周常宝箱（P1）档位与奖励，待签到/任务数据后定。

---

## 7. 客户端 UI

> UI 规格权威：[`UI_DESIGN.md`](UI_DESIGN.md)；本文只定信息结构。

- **入口**：大厅显著位置（每日签到弹层可在登录后首屏弹出，一次/天）；ProfileScene 或独立「每日」面板汇总三层。
- **签到**：月历网格（30 格），已领/可领/未达三态 + 里程碑大奖高亮；「领取」按钮领下一格。
- **每日任务**：任务卡列表 + 当日任务点进度条 + 满点「领取金币」按钮。
- **月历/任务 Tab（2026-07-05）**：DailyScene 原左右分栏同屏显示两块，改为竖排 Tab 侧栏堆叠在笔记本红色装订线**左侧**，内容区（月历 or 任务，二选一）整块移到红线**右侧**，同 AchievementScene 的分类 Tab 布局（呼应纸面装订线+正文分区）。
- **返回按钮统一（2026-07-07）**：DailyScene 原自绘 `daily.back` 文本按钮换成全局统一的浮动返回胶囊（`drawFloatingBackButton`，`common.back`），置于左上角装订线左侧；`daily.back` i18n key 已删（中英德三份）。
- **周常**（P1）：周活跃进度条 + 三档宝箱。
- **红点**：入口 + 各层三级红点，源于任一 claimable（§4.1）。
- **i18n**：新增 `retention.*`（签到/任务/周常/领取/已领/进度/大奖），中英双语；**禁韩文**（见 memory）。
- 离线/未登录：显「登录后查看」（同 StatsScene 既有处理）。

---

## 8. 经济联动（与 ECONOMY 对齐）

- **数字权威**：奖励表/阈值/上限 = [`ECONOMY_NUMBERS.md §12`](ECONOMY_NUMBERS.md)（DRAFT）。
- **反通胀**：金币只从「每日任务满点」出，日上限 × 30 天 ≤ ~60/月，**整体并入 §6.1「日常任务」格不另立龙头**（R1）。软通货受体力闸门/养成树自然约束，不计入金币通胀推演。
- **软通货定位**：签到发体力/材料/卡 = 给"每日刷量"加一点点甜头，受 §2 体力上限 + §3 关卡门控约束，不破坏养成节奏。
- **待验证**（同 ECONOMY §9 遗留）：签到 + 任务金币初值需与称号/成就一起跑模拟，验证总产出不冲垮金币经济。

---

## 9. 实现拆解（建议任务，落 META_TASKS）

> 依赖：PvE 结算（PVE_INTEGRITY 方案 B，已实现）+ 广告冷却（已实现）即可上 P0；PvP/围攻任务随 `match/report`/worldsvc 计数接通跟进。

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **D-1** | `@nw/shared`：`retention` 类型 + 签到月历/任务池/周常定义表（§2 初值）+ 状态推导纯函数（claimable） | — |
| **D-2** | SaveData 扩 `retention`；`PUT /save` 列入服务器只读权威字段；惰性跨边界重置逻辑 | D-1 |
| **D-3** | 服务器结算点累加当日任务点（挂 PvE/广告结算，与成就 stats 同事务） | D-2、方案 B |
| **D-4** | `GET /retention` + `POST /retention/checkin` + `/daily/claim`（二次校验 + 幂等发奖） | D-2 |
| **D-5** | 客户端 UI：签到月历 + 每日任务面板 + 红点聚合 + i18n（P0） | D-4、UI_DESIGN |
| **D-6** | PvP/围攻任务接通（`match/report` / worldsvc 结算推进任务点） | D-3、S1-R/SLG |
| **D-7** | 周常宝箱（P1）+ 数值校准（金币池跑模拟验证不冲垮经济，ECONOMY §9） | D-4 |

---

## 10. 实现记录

> （待实现后追加：完成阶段、实际字段/端点形态、与设计的差异。）

### 10.1 修复：签到月历奖励显示 `+undefined`（2026-06-24）

**现象**：DailyScene 月历每格奖励全部显示 `+undefined`（无 `c` 后缀，说明 `reward.kind` 与 `reward.count` 同时为 undefined）；同页 `+N Münzen` 领取按钮正常。

**根因**：`GET /retention` 经 `fastify-openapi-glue` 注册，Fastify 用 fast-json-stringify 按响应 schema 序列化回包。`openapi.yml` 中 `defs.rewards` / `defs.tasks` 仅声明为 `items: { type: object }`（无 `properties`），fast-json-stringify 对「无 properties 的 object」序列化为 `{}`，把 `kind`/`count`（及 tasks 的 `id`/`points`）全部剥掉。`dailyCoinsReward`（`type: integer`）不受影响，故按钮正常。服务端 `CHECKIN_REWARDS` 数据本身正确。

**修复**：在 `openapi.yml` `/retention` 200 响应里给 `rewards.items` 补 `{ kind: string, count: integer }`、`tasks.items` 补 `{ id: string, points: integer }` 的 `properties`+`required`，序列化即保留字段。纯契约改动，无客户端/服务端逻辑变更。

> 教训：经 openapi-glue 的端点，凡回包数组/对象需要客户端读字段的，schema 必须显式声明 `properties`，否则 fast-json-stringify 静默剥成 `{}`。

**回归测试**（`server/metaserver/test/`）：
- `retention.e2e.test.ts` — GET /retention 断言 `defs.rewards`（30 格、`rewards[0]={stamina,30}`、`rewards[6]={coins,5}`、每格 kind/count 类型正确）+ `defs.tasks` 字段；需真实 Mongo，否则跳过。
- `openapi-response-schema.test.ts` — **契约守卫**（无需 Mongo）：遍历 `openapi.yml` 所有响应 schema（含 $ref 解引用），任何缺 `properties`/`additionalProperties`/组合的 object 节点即判红，钉死整类「序列化剥空字段」bug；新端点漏写会在 CI 直接失败。该守卫已对照修复前 spec 验证能精确命中本次两处。

### 10.2 修复：签到「每次只能领第一天」（2026-06-26）

**现象**：每日签到无论领取多少次，可领/高亮格永远停在第 1 格；领取本身有效（奖励到账），但格子状态不前进。

**根因**：§10.1 同源——`openapi.yml` 的 `SaveData` schema **完全没声明 `retention` 字段**。`POST /retention/checkin`（及 `GET /save`、`/retention/daily/claim` 等所有回 `SaveData` 的端点）经 fast-json-stringify 按 schema 序列化时，把回包 `save.retention` 整段剥掉。客户端 `saveManager.adoptServer(save)` → `reconcile()` 的 `{...cloud}` 把本地 `save.retention` 覆盖成 `undefined`。DailyScene 渲染从 `save.retention.checkin.claimedDays` 取已领格（而非 `GET /retention` 的 checkin 块），claimedDays 永远空 → `nextCheckinDay` 永远返回 `1`。服务端 Mongo 里 `claimedDays` 其实正常累加，只是回包路上被剥掉，客户端看不到。

**修复**：
- 契约：`openapi.yml` `SaveData.properties` 补 `retention`（`checkin{monthKey,claimedDays[]}` + `daily{dayKey,completedTasks{},taskPoints,rewardClaimed}`，均带 `properties`/`additionalProperties`），序列化即保留。
- 客户端（`DailyScene.renderCheckin`）：按用户反馈把格子三态显式化——已领格盖绿色 ✓ 对勾；下一未领格（`claimable`）高亮可点；其余暗格。模型仍是顺序累计（§2.1，不引入日期对齐/打叉，断签不惩罚 R5）。移除随之失效的 `todayNum`/`isFuture` 旧判定。

> 教训：§10.1 的守卫只能抓「object 节点存在但空（无 properties）」，抓不到「字段在 TS/运行时存在、schema 里整段缺失」。凡服务器权威、客户端要读的 SaveData 子块，新增时必须同步进 `openapi.yml` 的 `SaveData` schema，否则回包静默丢字段。

### 10.3 修复：签到可在同一天内连续领多格 + 每日任务卡文字重叠（2026-07-02）

**现象一**：`nextCheckinDay`/`claimCheckinDay`（`server/shared/src/retention.ts`）用「`claimedDays.length` 是否 `>= 当前日历日的日号`」近似判断「今天是否已领」（代码注释自称"lenient mode 近似"）。这只在玩家进度**恰好等于**日历日号时才生效；一旦落后（如 7 月 2 日才补到第 3 格），`claimedDays.length(2) < todayNum(2)`→ 不成立，玩家可在同一次会话里连点到 `claimedDays.length >= todayNum`，把落后的格子一次性刷完——即「今天是 20 号就能连领到第 20 格」。

**修复一**：`CheckinData` 新增 `lastClaimedDayKey`（最近一次领取的日历日 key，如 `"2026-07-02"`），`nextCheckinDay`/`claimCheckinDay` 改为直接比较 `lastClaimedDayKey === 当前 dayKey`，与日历日号完全解耦——不管进度落后多少，每个真实自然日只能领一格；断签不惩罚（R5）不受影响，落后的格子仍按顺序累积模型（§2.1）逐日补领，不能一次刷完。客户端镜像 `client/src/game/meta/retention.ts` 同步改动；`SaveData.retention.checkin` 类型 + `openapi.yml` 两处 `checkin` schema 补 `lastClaimedDayKey`。

**现象二**：`DailyScene.renderDailyTasks` 每日任务卡左侧任务文案（如「通关任意 PvE 关卡」）与右侧状态文案（「进行中」/「完成」）同一行绝对定位、无宽度约束，卡片较窄（横屏右列 45%）时文案变长会与状态文字重叠。

**修复二**：任务文案改用 `wordWrap`（宽度上限卡片宽的 60%），超长自动换行，与右侧状态文案之间留出安全间距，不再重叠。

### 10.4 签到奖励表落定 + 月历/任务 Tab 改版（2026-07-05）

**背景**：`CHECKIN_REWARDS[30]` 里程碑格（7/14/21/30）此前用 `kind:'coins'` 占位（代码注释自称"placeholder"），§2.1 早已规划里程碑给「体力包/卡包/材料包/月末压轴」但一直没补——签到普通格显示的其实是**体力 +30**（不是金币），容易被误读；且 UI 左右分栏同屏挤两块内容，Tab 切换诉求（月历/任务）无处安放。

**奖励表**：`CheckinRewardKind` 扩为 `coins | stamina | material | card | equipment`（`kind:'coins'` 只留兼容旧存档解析，签到本体自此不再发金币，符合 R1）。产品拍板：材料要覆盖全月（不只挂里程碑格）——普通格在体力间穿插材料滴灌（约 8/26 天）；里程碑格：7=体力包（+100）、14=卡包（随机 1 张角色卡）、21=中级材料包（lead×5）、30=月末压轴（随机 1 件 equip_t1 装备）。

**随机抽取**：卡/装备milestone 复用"抽卡权重池"的诉求，落地为 `@nw/shared/gachaCatalog.ts` 新增的 `pickRandomCatalogItem(category)`——同一份 `GACHA_CATALOG` 目录内均匀随机挑 1 项（无 ops 权重表，checkin 没有运营配置的必要）。之所以不直接调 `commercial/gacha.ts` 的 `rollCustomGacha`：metaserver **不依赖** `@nw/commercial`（服务边界，commercial 只通过 `CommercialClient` RPC 接口被引用），跨服务导入内部纯函数会破坏这条边界，故改为在 `@nw/shared` 落一份更简单的均匀抽取。卡通过 `grantCards`（复用花名册满员补币逃生舱）交付；装备通过 `rollCraftedAffixes` 现场滚词条 + `grantEquipment`（trade-transfer 写法，覆盖写入、无 300 上限检查）交付，二者均落 `save.cardInv`/`save.equipmentInv`，PvP 蓝图硬墙自动生效（R3，见 DECISIONS.md）。

**UI**：DailyScene 原「月历+任务」左右分栏同屏，改为竖排 Tab 侧栏（同 AchievementScene 分类 Tab）：两个 Tab 堆叠在笔记本红色装订线**左侧**，内容区（月历 or 任务，一次只显示一个）整块移到红线**右侧**（`marginLineX(w)` 起算），不再区分横竖屏两套分栏比例。

**契约**：`openapi.yml` 的 `/retention` `defs.rewards[].kind` 枚举 + `/retention/checkin` `reward.kind` 枚举都加 `material|card|equipment`，两处都补可选 `id`（材料 id 或抽中的 defId）。`routes.gen.ts` 已用 `gen:api:server` 重新生成。
