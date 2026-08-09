# 留存系统设计 — Daily Retention（签到 / 每日任务 / 周常）

> 状态：**P0 已实现（2026-06-22）**，签到奖励表 + Tab 改版见 §10.4（2026-07-05）；签到去体力 + 里程碑加金币（R1b）见 §10.5（2026-08-01）；顶部标题跟随子 Tab 修复见 §10.7、周常宝箱 tier-3 皮肤→传说卡调整见 §10.8（均 2026-08-08） · 权威：**本文（留存系统机制单一来源）**；数值（奖励/上限/曲线）镜像并最终落 [`ECONOMY_NUMBERS.md §12`](ECONOMY_NUMBERS.md)（DRAFT 初值）· 更新：2026-08-08
>
> **实现记录（B5 2026-06-22）**：
> - `server/shared/src/retention.ts` — 纯函数 + 类型（`RetentionSave`, `CHECKIN_REWARDS[30]`, `DAILY_TASKS[3]`, `accrueRetentionTask`, `claimCheckinDay`, `claimDailyReward`）
> - `server/shared/src/types.ts` — `SaveData.retention?: RetentionSave`
> - `server/metaserver/src/service.ts` — `getRetention` / `claimCheckin` / `claimDailyReward` + PvE/ads 打点
> - `server/metaserver/src/internal.ts` — PvP 结算时 `pvp.match` 打点（内嵌 `applyPvp`）
> - ✅（2026-07-28 修复）PvE 打点此前只在 `pveClear` 的 normal-clear 路径调用，spot-check 分支（`pveVerify`/
>   `deliverVerifiedClearReward`）从未打点——当天首通任意关卡必进 spot-check（`shouldSpotCheck` 对 `isFirstClear`
>   短路 true），导致"通关任意 PvE 关卡"每日任务对正常推图玩家经常无法完成。详见 [`PVE_INTEGRITY_PLAN.md §9`](PVE_INTEGRITY_PLAN.md)。
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
它的**奖励主体是软通货**（养成材料 / 单位卡 / 抽卡碎片；**不再发体力**，见 §10.5），**金币绝大部分走每日任务且严格日上限**，整体收敛进 [`ECONOMY_NUMBERS.md §6.1`](ECONOMY_NUMBERS.md) 既有的"日常任务 ~150/月"预算（5 coins/天 ×30）；签到里程碑格（4 格/月）另加一笔小额金币（**R1b**，200/月合计，§10.5）——**不再是零，但仍是主账本之外可忽略的小量**，不算新开一条实质龙头。

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
| R1 | **不新增大额金币龙头**：签到/任务的金币产出全部计入 ECONOMY_NUMBERS §6.1「日常任务 ~150/月」预算（5 coins/天 ×30），月度严格收敛；金币主要从「每日任务满点」一次性出且有日上限。 | 留存是唯一的持续 faucet，反通胀红线（ECONOMY_BALANCE §1） |
| R1b | **（2026-08-01 修订）** 签到里程碑格（7/14/21/30，4 格/月）**额外**各带一笔小额 `bonusCoins`（30/40/50/80，合计 200/月），与主奖励（材料包/卡包/材料包/装备）同格发放、独立交付路径。量级远小于既有金币龙头（日常任务 150/月、战令 960/月、排位赛最高 5,400/赛季），未跑 econ-sim，判断为"小到可忽略"的产品决策，不是重新拍板 R1。若后续再加大此额度，必须回来跑 econ-sim。 | 产品诉求：签到常规格去体力后仍需要"手感更好"的里程碑奖励（§10.5） |
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
| **每日签到** | 登录即领，**月历式**累进（本月累计第 7/14/21/30 格给大奖），跨月重置 | 损失厌恶 + 累计成就感 | 材料 / 卡 / 装备为主，**不发体力**；里程碑格另加小额金币（R1b） | **P0** |
| **每日任务** | 当日 3~4 条轮换（打 1 局 PvP / 刷 3 关 / 合成 1 次 / 看 1 条广告 / 围攻 1 次） | 目标驱动，引导核心循环 | **任务点** → 当日满点一次性发金币（计入 ~150/月） | **P0** |
| **周常活跃宝箱** | 周内累计活跃度（=每日任务点周累计）达档解锁宝箱，跨周重置 | 把"补漏"心理拉成周维度，容错单日漏做 | 装备 / 高级材料 / 限定 | P1（缓做） |

### 2.1 每日签到曲线（月历式）`[可调 → §12]`

- **形态**：30 格月历，每自然日（服务器时区）可领当月「下一未领格」一格。
- **累进**：第 7 / 14 / 21 / 30 格为里程碑大奖（材料包 / 卡包 / 中级材料包 / 月末压轴装备，**各加小额金币**，R1b）。
- **断签**：漏签只是当天不点亮，**累计格数不回退**；可选「补签」道具（金币/广告购买，劝退价，[可调]，前期不做）。
- **跨月**：每月 1 号格位与已领记录重置（`monthKey`）。
- **实现（2026-07-05）**：`CHECKIN_REWARDS[30]` 落定（`server/shared/src/retention.ts`）——常规格在体力（+30）间穿插材料滴灌（约每 3 格一次 scrap/lead/binding，全月覆盖，非只挂里程碑格）；里程碑格：第 7 天体力包（+100）、第 14 天卡包（**随机**从抽卡卡池均匀抽 1 张角色卡）、第 21 天中级材料包（lead ×5）、第 30 天月末压轴（**随机**从 equip_t1 抽 1 件装备）。卡/装备**不做**权重池抽取（commercial 的 `rollCustomGacha` 属于跨服务边界，metaserver 不依赖 `@nw/commercial`），改为 `@nw/shared` 内新增的 `pickRandomCatalogItem(category)`——同一份抽卡目录（`GACHA_CATALOG`）内均匀随机，纯函数、无 DB。签到本体自此**不再发金币**（`kind:'coins'` 只留兼容旧存档解析），符合 R1。
- **修订（2026-08-01，R1b，详见 §10.5）**：常规格的体力（+30/+100）**全部改成材料**——体力上限 120、自然回复 10/小时（12 小时回满），玩家习惯一上线看到红点就领，固定体力奖励常态性溢出浪费，不是"有感"的奖励；材料不会溢出，全月每天都发。里程碑格（7/14/21/30）主奖励不变（7 号原体力包改成材料包），**各自额外加一笔 `bonusCoins`**（30/40/50/80，合计 200/月）。

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
- [ ] 每日任务「满点」阈值与金币额（当前 5/天 → 月度 ~150）→ §12 + ECONOMY §9 模拟验证。
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
- **DailyScene 侧栏 Tab 红点补齐（2026-07-12）**：竖排 Tab 侧栏（月历/任务）此前只有大厅入口红点，两个 Tab 本身没有红点，玩到 3/3 任务点满但未领取时侧栏看不出还有奖励可领。`DailyScene.drawSidebarTabs` 现在把 `nextCheckinDay`/`dailyRewardClaimable` 结果传给 `HubTab.badge`（`HubTabs.ts` 早已支持该字段，只是没接上）。测试见 `client/test/retention.test.ts`。同组页签（Shop/Gacha/BattlePass）的同类漏洞排查见 [`LOBBY_IA_REDESIGN.md` §12 追记](LOBBY_IA_REDESIGN.md)。
- **i18n**：新增 `retention.*`（签到/任务/周常/领取/已领/进度/大奖），中英双语；**禁韩文**（见 memory）。
- 离线/未登录：显「登录后查看」（同 StatsScene 既有处理）。

---

## 8. 经济联动（与 ECONOMY 对齐）

- **数字权威**：奖励表/阈值/上限 = [`ECONOMY_NUMBERS.md §12`](ECONOMY_NUMBERS.md)（DRAFT）。
- **反通胀**：金币只从「每日任务满点」出，日上限 5/天 × 30 天 = ~150/月，**整体并入 §6.1「日常任务」格不另立龙头**（R1）。软通货受体力闸门/养成树自然约束，不计入金币通胀推演。
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

### 10.5 签到去体力 + 里程碑加金币（R1b，2026-08-01）

**背景（用户反馈）**：玩家习惯一上线看到签到红点就领，常规格固定 +30/+100 体力因此几乎总在体力接近/顶到上限（120，自然回复 10/小时，12 小时回满）时被领取——对活跃玩家是常态性溢出浪费，"感觉没用"。用户建议：去掉体力，常规格至少发材料；里程碑格可以加金币，但一次性发"免费抽卡机会"（按当前定价约合 150 金币）又感觉太贵；参照里程碑 7/14/21/30（近似每周一次）的既有节奏，四格都发一点金币，`留存为主，多给点奖励没坏处`。

**改动**：
- 常规格（26 格，非里程碑）**全部改成材料**（scrap/lead 轮换，量级与此前的材料滴灌格基本一致，只是覆盖到每一天，不再穿插体力）。
- 里程碑格（7/14/21/30）主奖励结构不变（原 7 号体力包改成材料包 lead×5），**新增 `bonusCoins` 字段**，与主奖励同格发放：7→30、14→40、21→50、30→80，合计 200/月。
- `CheckinReward` 新增可选字段 `bonusCoins?: number`；`kind:'stamina'` 保留类型定义（仅用于旧存档兼容解析），`CHECKIN_REWARDS` 表内不再出现。
- 交付路径：`liveops.ts#claimCheckin` 在主奖励交付完成后，若 `bonusCoins` 非空且 commercial 可用，额外调用一次 `commercial.grant`（独立 `orderId: checkin:bonus:...`），与主奖励的交付路径解耦——commercial 不可用时静默跳过 bonusCoins（不影响主奖励，也不 503 掉整个请求）。
- **R1 修订为 R1b**（见 §1）：这是对"签到本体几乎不发金币"的**明确松口**，不是悄悄违反——200/月的量级远小于既有金币龙头（日常任务 150/月、战令 960/月、排位赛最高 5,400/赛季），判断为可忽略，未跑 econ-sim；若后续要继续加大此额度，必须回来跑一次。
- 客户端：`DailyScene.ts` 在里程碑格右上角加一个小号「金币图标 + 数额」角标，与主奖励图标并存；签到 toast 在主奖励描述后追加 `+ N 金币`（新 i18n key `daily.checkin.bonusCoins`，zh/en/de）。
- 契约：`openapi/paths/liveops.yml` 的 `defs.rewards[]` 与 `/retention/checkin` 的 `reward` 都加可选 `bonusCoins: integer`；`gen:api:contracts` / `gen:api:server` / 客户端 `rest:gen` 均已重新生成。

### 10.6 修复：大厅红点漏周常宝箱 + 签到/周常/每日的发放失败弹性（2026-08-05）

**背景**：T9 traits + 周常宝箱功能（§2.3，见 a15eca1d/52801680）落地测试收尾时发现两处遗留缺口：大厅"每日"入口红点没跟上周常宝箱，以及装备/皮肤发放失败缺服务端弹性测试；本条一次性补齐。

**缺口一：大厅红点漏周常宝箱**。`hasRetentionClaimable`（`server/shared/src/retention.ts`，客户端镜像 `client/src/game/meta/retention.ts`）本身已经在 §2.3 落地时正确纳入了 `weeklyClaimableTiers`，但从未真正接进大厅链路——`getLobbyBadges`（`server/metaserver/src/service/liveops.ts`）手写了 `retentionClaimable: {checkin, daily}`，漏了 weekly；客户端 `lobby.ts` 也只 OR 了这两个。结果：玩家已领完当天签到/每日任务、但周常宝箱有格子可领时，大厅"每日"图标上的红点完全不亮。

**修复**：`getLobbyBadges` 补 `weekly: weeklyClaimableTiers(retention, tsMs).length > 0`；`openapi/paths/liveops.yml`（`GET /lobby/badges` 200 响应 `retentionClaimable`）补 `weekly: boolean` 必填字段，`bundle-openapi.mjs` + `gen-openapi-server.mjs` + 客户端 `rest:gen` 重新生成；`client/src/app/nav/lobby.ts` 的 `applyRetentionBadge` 调用改为三者 OR。回归测试：`server/metaserver/test/lobby-badges.e2e.test.ts` 新增一条「已达标未领的周常 tier 应让 `retentionClaimable.weekly` 变 true」的用例。

**缺口二：签到/周常/每日的发放失败弹性**。`claimCheckin`/`claimWeeklyChest`/`claimDailyReward` 的实现形状都是「先把领取状态原子落库（`mutateSave` 的 rev-guard，天然给并发重复请求排出唯一赢家），再调用装备/卡牌/皮肤/金币的发放」——这个先后顺序本身是对的（不能倒过来，否则并发双击会双发），但发放这一步失败时代码此前是静默吞掉错误：领取状态永久标记为"已领"，实际道具/金币却从未到账，且客户端重试会一直撞在"已领取"上，永远拿不到东西。三处路径共性同一个 bug，一次修完：

- **装备/卡牌类**（签到第 14 格卡包、第 30 格装备压轴；周常宝箱 tier2 装备、tier3 皮肤）：新增 `deliverRetentionReward` 辅助方法，复用 `equipment.ts` 里 craft/enhance/salvage 已有的 `cols.equipmentIdem` 幂等台账 + `committed` 标志套路（`EquipmentIdemDoc.op` 新增 `checkin_reward`/`weekly_chest` 两个取值）：具体抽中的道具（哪个 defId、哪个 instance/skinId）在真正调用发放前先落台账（`committed:false`），发放调用用的是这条已落台账的记录，而不是每次都重新随机——发放失败后，下一次请求撞到"已领取"时不再直接 409，而是查表恢复：台账里有记录就照着同一件道具重试发放（`committed:true` 则直接回放已发结果），保证补发的是**同一件**道具，不会丢也不会因为重随而重复发第二件。卡牌类新增了 `cards.ts#grantCard`（单实例、按 id 幂等）路径供签到复用（原 `grantCards` 每次都随机生成新 id，跨请求重试不天然幂等，不适合这里；`grantCard` 镜像 `equipment.ts#grantEquipment` 的写法）。
- **纯金币类**（签到里程碑 bonusCoins、每日任务金币）：`commercial.grant` 本身已经用确定性 `orderId` 做幂等（`commercial/src/service/shop.ts`），不需要额外台账——修复只是把"撞到已领取就直接 409"改成"撞到已领取就用同一个 orderId 重试一次发放"，失败了就还是 409/502，成功了就正常返回，重试安全（`orderId` 相同 → 重复调用只回放，不重复入账）。
- **边界**：`claimCheckinDay`（`server/shared/src/retention.ts`）的纯函数里 `nextSlot > CHECKIN_TOTAL_DAYS`（月满）判断先于 `lastClaimedDayKey === 当前日`（今日已领）判断，导致"当月最后一格（第30格）当天重试"报的是 `MONTH_FULL` 而不是 `ALREADY_CLAIMED_TODAY`——两者本质是同一种可恢复场景，`claimCheckin` 的恢复分支据此把两个错误码合并处理，用 `lastClaimedDayKey` 而不是错误码本身来判断"是不是今天这次领取"。

**回归测试**（`server/metaserver/test/retention.e2e.test.ts`，新增 `describe('retention delivery resilience (2026-08-05 fix)')`）：镜像 `pve.e2e.test.ts` 的手法——包一层 `saves.findOneAndUpdate`，让发放调用自己内部的 rev-guard 写入必输，验证（a）领取状态照样落库、（b）失败响应是 502 不是静默 200、（c）解除拦截后重试补发**同一件**道具/发放**同一笔**金币，且再重试一次也不会变成两件/两笔。覆盖周常装备 tier、周常皮肤 tier、签到第 30 格装备+bonusCoins、每日任务金币四条路径。

### 10.7 修复：Daily 顶部标题不跟随子 Tab（2026-08-08）

**背景**：用户反馈截图——在"周常宝箱"子 Tab 下，页面顶部 `SceneHeader` 仍显示固定的 `t('daily.title')`（"Daily"/"每日"），与左侧高亮的"周常宝箱" Tab、内容区自己的"周常宝箱"小标题不一致，读起来像是标题没跟上当前子 Tab（`client/src/scenes/DailyScene.ts` 原 `drawSceneHeader(..., t('daily.title'))` 不随 `activeTab` 变化，四个子 Tab 下顶部永远是同一行字）。

**修复**：顶部标题改为按 `activeTab` 取对应 Tab 自己的 i18n key（`TAB_TITLE_KEY: Record<DailyTab, TranslationKey>`，映射到 `daily.checkin.title` / `daily.tasks.title` / `daily.weekly.title` / `daily.ads.title`，与左侧 Tab 文案、内容区小标题同源，不新增翻译）。大厅入口按钮（`LobbyScene` "每日" 图标）与引导文案仍用原来的 `daily.title`，不受影响——那是整个留存功能的入口标签，不是本页内部标题，语义不同不合并。

**回归测试**：`client/test/ui/dailySceneWeeklyTab.ui.ts` 新增 `describe('DailyScene — header title follows the active tab')`，断言切到 `weekly`/`tasks` Tab 时找不到 `t('daily.title')` 文本、能找到对应 Tab 自己的标题文本。

### 10.8 调整：周常宝箱 tier-3 奖励由「商城皮肤」改为「随机传说卡（橙卡）」（2026-08-08）

**背景**：用户反馈——周常宝箱最高档（21 点，7 天满勤/满周）此前发一件商城普通皮肤（`skin_shop_c1`/`skin_shop_r1` 二选一，见 §10.7 前 WEEKLY_CHEST_TIERS 注释），对需要满周活跃才够到的顶档奖励而言分量偏轻；改为随机发一张**传说品阶（Anna 阵营，界面上呈"橙色"）**的角色卡。

**实现**：
- `server/shared/src/gachaCatalog.ts#pickRandomCatalogItem` 新增可选第三参 `rarity?: Rarity`，把同一个类目内的候选池按展示稀有度再筛一层——`pickRandomCatalogItem('card', rng, 'legendary')` 只在 Anna 阵营卡（`max`/`lena`/`mara`）里随机，checkin 第 14 天里程碑仍用不带 `rarity` 的调用（全品阶都能抽到，含史诗 Tao 卡）。
- `server/shared/src/retention.ts`：`WeeklyChestRewardKind` 去掉 `'skin'`，加 `'card'`；`WEEKLY_CHEST_TIERS[2].reward` 改为 `{ kind: 'card', count: 1 }`；随之删除只服务于旧 skin 分支的 `WEEKLY_CHEST_SKIN_POOL` / `pickWeeklyChestSkin`（无其它调用点，未保留兼容垫片）。
- `server/metaserver/src/service/liveops.ts#settleWeeklyChestReward`：`'skin'` 分支换成 `'card'` 分支，镜像 `settleCheckinReward` 的 card 分支写法（`deliverRetentionReward` → `grantCard`），只是随机池收窄到 `rarity: 'legendary'`；`RetentionItemPick`/`deliverRetentionReward` 同步去掉 `'skin'` 变体（checkin 从未用过它，收窄后 `grantSkin` 在这条发放路径上彻底不可达，导入一并删除）。
- 契约：`openapi/paths/liveops.yml` 两处 `reward.kind` 的 enum 从 `[material, equipment, skin]` 改为 `[material, equipment, card]`，`gen:api:contracts` / `gen:api:server` / 客户端 `rest:gen` 重新生成。
- 客户端：`DailyScene.ts` 的 `singleItem`（装备/卡是单件展示，不带 `+N`）判断、领取 toast 文案分支同步从 `'skin'` 改判 `'card'`；i18n key `daily.weekly.rewardSkin` 复用改名为 `daily.weekly.rewardCard`（zh/en/de 三语同步改文案，未新增/遗留 key）。

**回归测试**：
- `server/shared/test/gachaCatalog.test.ts` 新增 `describe('pickRandomCatalogItem')`：不带 `rarity` 时全品阶可抽到；带 `rarity: 'legendary'` 时只抽到 Anna 阵营卡；类目/稀有度组合为空池时返回 `undefined`。
- `server/metaserver/test/retention.e2e.test.ts`：tier-3 用例改为断言 `reward.kind === 'card'` 且 `CARD_DEFS[id].faction === 'anna'`；发放弹性用例（原 `failsOnSkinGrant`）改为 `failsOnCardGrant`（比对 `save.cardInvCount` 而非 `inventory.skins`），断言与 checkin day-14 card 用例同款——账号自带 3 张 Tao 阵营新手卡（`auth.ts#maybeGrantStarterCards`），`cardInv` 从不为空，因此用「相对于领取前快照的新增卡」而非绝对数量判定，避免把新手卡误判成本次发放的卡。
- `client/test/ui/dailySceneWeeklyTab.ui.ts`：weekly-claim-toast 用例的 tier-3 分支改判 `kind: 'card'` + `t('daily.weekly.rewardCard')`。

### 10.9 修复：Daily 页红点亮但打开后三个 Tab 都没有可领取项（2026-08-09）

**背景**：用户截图反馈——大厅"每日"图标红点亮着，点进去后"每日签到"月历 Tab 里 1-7 天已打勾、后面全是灰色锁定格，没有任何一格是可领的高亮态，`Daily Tasks`/`Weekly Chest` 两个子 Tab 也没有能点的领取按钮，像是红点在骗人。

**根因**：`DailyScene` 的日历/任务/周常三个 Tab 全都读本地 `save.retention.*`（`this.cb.getSave()`，即 `saveManager.get()` 的内存镜像），只有 defs/ads 这两块读服务器新拉的 `this.retention`（`getRetention()`）。而大厅"每日"红点走的是完全独立的一条链路——`lobby.ts` 每次进大厅都重新 `GET /lobby/badges`，服务端当场读库算 `retentionClaimable`，天然新鲜。两条链路唯一的粘合点是 `goDaily()` 里的 `void saveManager.refresh()`：进 Daily 页时顺手触发一次后台刷新，让"刚打完一局"带来的签到/任务/周常进度尽快体现在本地镜像里——但这是个**无等待的 fire-and-forget** 调用，跟 `getRetention()` 各走各的网络请求，谁先回来不确定。核对了 `SaveManager.ts` 才发现真正缺的一环：**其它所有大厅后续场景**（ShopScene/GachaScene/CardScene/EquipmentScene/FriendsScene/SectScene/CityScene/... 全部）都在场景挂载时接了 `cb.onSaveChanged`（`saveManager.subscribe(...)`，本地写入/reconcile 后同步触发监听器），本地镜像事后刷新到位时能自己重渲染一次；唯独 `DailyScene` 从建立起就没有接这根线——如果 `refresh()` 比场景自己的首帧渲染晚回来，`render()` 再也不会被谁触发第二次，玩家看到的永远是挂载那一瞬间的旧 `save` 快照，红点亮着但页面上什么都点不动，直到手动退出再重进（新的一次 `getSave()` 读取碰巧已经是新值）才会"自愈"。

**修复**：`DailyCallbacks` 新增可选的 `onSaveChanged?(listener): () => void`，构造函数里 `if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));`——与 ShopScene 等场景完全同款写法；`client/src/app/nav/shop.ts#goDaily()` 补上 `onSaveChanged: (listener) => saveManager.subscribe(listener)` 这一行实参。不改三个 Tab 本身读 `save` 的既有设计（`renderCheckin`/`renderDailyTasks`/`renderWeekly` 都不动——"挂载即刻用本地镜像先渲染，不等网络"仍是对的，缺的只是"镜像事后刷新到位要能通知场景重渲染"这一步）。

**回归测试**：新增 `client/test/ui/dailySceneSaveChanged.ui.ts`（4 例）——① 用可篡改的 `save` 引用挂载场景，先渡过一帧确认 `Daily Tasks` Tab 停在 0/3、没有领取热区；随后原地改写同一个 `save.retention.daily`（模拟 `saveManager.refresh()` 晚到）、手动触发保存下来的 `onSaveChanged` 监听器，断言页面自己刷成 3/3 且多出一个可点的领取热区；② `destroy()` 后监听器要被解绑，且残留引用被误调用也不能抛异常；③④ 同款手法各补一例覆盖另外两个 Tab——「月历」从"今天已领、下一格锁定"翻到"下一格可领"（`lastClaimedDayKey` 回退一天）多出一个 hit 且点击真的调到 `onCheckin`；「周常宝箱」从 5 分翻到 9 分（跨过第一档门槛）多出一个 hit 且点击调到 `onClaimWeekly(9)`——不止测"订阅生效"，也测三个 Tab 各自的读数确实跟着刷新，不会出现"改完签到 Tab 好了，任务/周常 Tab 还是各自另一套 bug"的假阳性。改回修复前的代码（去掉 `DailyCallbacks.onSaveChanged` 接线）复测确认前 2 例会失败，加回修复后转绿。

再新增 `client/test/dailyNav-saveChanged.test.ts`（2 例，`shopNav-peerBadges.test.ts` 同款 `createShopNav()` + 真实 `SaveManager` 集成手法，不经 PIXI）——UI 测试给场景喂的是手写 mock `onSaveChanged`，测的是 `DailyScene` 自己接线对不对，测不出 `client/src/app/nav/shop.ts#goDaily()` 里那一行真实接线（`onSaveChanged: (listener) => saveManager.subscribe(listener)`）本身被删掉/写错的情况；这个测试文件直接跑真实 `createShopNav()`，验证 `nav.goDaily()` 交给场景的 `onSaveChanged` 确实接到了真实 `SaveManager.subscribe`——`saveManager.adoptServer()`/`.update()` 触发的通知能传到监听器，`unsub()` 后不再传；另一例覆盖 `!api`（离线）分支直接 `goLobby()`、从不到达 `showDaily()`。临时删掉 `shop.ts` 里那一行接线复测确认第一例失败（`onSaveChanged` 读到 `undefined`），加回后转绿。

### 10.10 修复：竖屏月历 5 行挤在页面顶部三分之一，下方大片空白（2026-08-09）

**背景**：用户截图反馈——竖屏「每日签到」月历 Tab，30 格（6 列 × 5 行）全部挤在内容区顶部，第 25-30 行下面到底部导航栏之间是一大片空白，整体看起来"没铺满"。横屏这个 Tab 此前已经是对的，用户特别强调这次只改竖屏，不能碰横屏。

**根因**：`renderCheckin` 的格子高度 `cellH = Math.min(areaH*0.78/5, cellW*0.8)` 由宽高比封顶（`cellW*0.8`），行间距却固定用 `h*0.006`。竖屏内容列比横屏窄很多，`cellW` 小 → `cellW*0.8` 这个上限总是小于按 `areaH` 算出的另一路上限，于是 `cellH` 被钳制在一个跟屏幕实际高度无关的小值上；固定的行间距又只有 `h*0.006`（几像素），5 行叠起来自然远够不到内容区底部。横屏反过来——`areaH` 本身就跟 `ROWS*cellH` 接近，这个钳制几乎从不生效，所以横屏一直没这个问题。

**修复**：`client/src/scenes/DailyScene.ts#renderCheckin` 只在 `!this.landscape` 分支里，把内容区剩余的可用高度（`gridAvailH - ROWS*cellH`）算出来均分成 4 段行间距，让 5 行整体松散地铺到内容区底部；格子本身大小不变。横屏分支的行间距原样保留 `h*0.006`，逐字节未改动。

**回归测试**：新增 `client/test/ui/dailySceneCheckinRowSpread.ui.ts`（3 例）——① 竖屏单次渲染断言 5 行行距彼此相差 <1px（不会一边挤一边空）；② 竖屏同宽不同高两次渲染（`PortraitLayout.designWidth` 是固定常量，两次渲染 `cellW`/`cellH` 完全相同）断言行距差 >50px——旧的固定 `h*0.006` 公式在这个高度差下只会长约 13px，验证行距确实随可用高度铺开而非停留在旧公式的量级；③ 横屏两组不同绝对尺寸但同宽高比的配置（`LandscapeLayout.designHeight` 是固定常量）断言两次渲染算出的行距数组逐项相等，证明横屏这条路径完全没被这次改动碰到。临时把修复 revert 回旧公式复测，确认用例②会红（实测差值 17.5px，卡在 50 的门槛下），加回修复后转绿。

`tsc --noEmit`、`npm run typecheck`、`npm run lint`、`npm run build:web` 均绿；`test/ui/dailySceneWeeklyTab.ui.ts`（11 例）、`test/ui/scenes.ui.ts`（112 例）、`test/retention.test.ts`（24 例）、`test/shopNav-peerBadges.test.ts`（8 例）全量复跑无回归。
