# 天梯赛季 + 战令 + 排行榜设计 — Ranked Season / Battle Pass / Leaderboard

> 状态：设计中 · 权威：**本文（天梯赛季 / 战令 / 排行榜机制单一来源）** · 更新：2026-06-21
>
> 本文是天梯运营层的**机制设计基准**：赛季时钟、软重置、段位首达金币补齐、赛季峰值追踪与结算奖励、排行榜、战令（Battle Pass）、惰性迁移、接口契约、UI、经济联动、实现拆解。
> **数值不在本文拍死**：ELO/段位/首达金币 → [`ECONOMY_BALANCE.md §2.3`](ECONOMY_BALANCE.md)；赛季重置基准/赛季奖励/战令奖励曲线 → [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)（待铺 §13）。
> 设计同构参照：[`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)（服务器权威 + 边界惰性重置 + 领取流程几乎照搬）、[`TITLE_DESIGN.md`](TITLE_DESIGN.md)（段位称号授予 = 本文赛季结算的下游）、worldsvc `S8-7 赛季`（`open/settle/reset/close` 四段式 admin 编排，本文照此模式但作用于天梯而非大地图）。

---

## 0. 一句话定位

天梯赛季是**让爬梯有终点、让强者每季重新证明、让运营有节律发奖**的周期系统：每 6 周一赛季，赛季末软重置 ELO、按峰值段位发奖与授称号、清零重来；战令把「每天/每周回来」沉淀成一条贯穿整季的奖励主线，是早期主力 sink 与变现脊梁。

**它解决的现状问题**：当前天梯本质是「一个永不结束的赛季」——爬到顶就没动力，无重置、无榜、无赛季奖励、无战令。本文补齐这一整层。

---

## 1. 设计铁律（不可违背）

| # | 铁律 | 出处 / 理由 |
|---|---|---|
| S1 | **天梯赛季独立于 SLG 大区赛季**：天梯赛季 = 6 周（本文）；SLG 大区赛季 = 2 个月（`SLG_DESIGN §SLG3`）。两条周期、两套时钟、互不触发。**SLG 大区重置永不动天梯 ELO/段位**（`SLG_DESIGN §SLG4` 已定「保天梯段位/ELO」），**天梯赛季重置只动 `pvp`，不动 SLG 地图态**。 | 解决 `ECONOMY_BALANCE §2.6`（赛季末天梯重置）与 `SLG_DESIGN §SLG4`（跨季保段位）的表面矛盾——它们说的是两个不同的「赛季」 |
| S2 | **赛季状态服务器权威**：赛季号、ELO、峰值、战令经验/等级/领取全在服务端，客户端只读展示、领取走 API、二次校验。与 `pvp`/钱包同级隔离，刷不动。 | 与 `META_DESIGN §11/§2` 天梯权威一致 |
| S3 | **赛季重置不全表 fan-out**：不在赛季切换瞬间遍历所有玩家存档；用**惰性迁移**（玩家下次访问时按 `pvp.seasonNo` 落后即补结算/重置），全表只动一个赛季时钟文档。 | 1 万级玩家瞬时全表写不可接受；同 `RETENTION_DESIGN` 边界惰性重置策略 |
| S4 | **结算幂等**：段位首达金币只首次发、赛季奖励每季只发一次、称号 `$addToSet`、战令每档只领一次——全部带幂等守卫，重入安全。 | 与 commercial `deliveredOrders` / victoryDaily 幂等同策 |
| S5 | **不破公平红线 + 不新增金币龙头**：赛季/战令奖励能发金币（计入经济预算）、材料、皮肤、称号，**绝不进 PvP 蓝图、绝不卖战力**；金币产出并入 ECONOMY 总预算跑模拟，不另立通胀龙头。 | ADR-009 硬墙、`ECONOMY_BALANCE §1` 反通胀 |
| S6 | **温和档**：赛季软重置（非清零）；战令免费轨已挣得的奖励赛季末不没收（自动补发），付费轨同理。 | 与全经济温和基调一致（`RETENTION_DESIGN R5`） |

---

## 2. 三块拼图总览

| 块 | 机制 | 主奖励 | 优先级 |
|---|---|---|---|
| **A 赛季时钟 + 软重置** | 6 周一季；赛季末按峰值段位发奖 + 授段位称号 + 软重置 ELO | 金币（赛季奖励）+ 永久段位称号 | **P0**（其余两块的前置） |
| **B 排行榜** | 全服 Top100（按 ELO）+ 查询者自己的全服排名 | — | **P0**（依赖少、见效快，可与 A 并行起手） |
| **C 战令（Battle Pass）** | 整季经验主线，免费轨 + 付费 Pass 双轨，逐级解锁奖励 | 金币 / 材料 / 限定皮肤 | **P1**（依赖留存任务系统 `RETENTION_DESIGN`） |

> 同时补齐一个**遗留缺口**：段位首达金币（`ECONOMY_BALANCE §2.3a`，100–3500/段）当前 `settleElo` 只发了分段胜利金币、**没发首达金币**——本文 A 块的峰值追踪顺带把它接上（§4.3）。

---

## A. 赛季时钟 + 软重置

### 3. 赛季时钟（全局单文档）

新增 `ladderSeasons` 集合，只放一个「当前赛季」文档（照 worldsvc 赛季模式，但天梯无大区维度，故全局唯一）：

```ts
// @nw/shared / server mongo
interface LadderSeasonDoc {
  _id: 'current';
  seasonNo: number;        // 当前赛季号 N，从 1 起
  startAt: number;         // 本季开始（epoch ms）
  endAt: number;           // 本季结束 = startAt + SEASON_DURATION（6 周）
  state: 'active' | 'settling';  // settling = 切换中（短暂，防并发重复 roll）
}
```

- **赛季时长** `SEASON_DURATION = 6 周`（常量，可调 → ECONOMY_NUMBERS）；**`endAt` 仅为展示用「预计结束」**，不是硬切换闸——实际开新季由运维手动决定（§3.1）。
- **首次启动**：缺省则懒创建 `{seasonNo:1, startAt:now, endAt:now+6w, state:'active'}`。
- 客户端读 `GET /leaderboard` / `GET /save` 时带回当前 `{seasonNo, endAt}` 供 UI 显示「赛季 N · 预计剩余 X 天」。

### 3.1 赛季切换触发（拍板：admin 手动开启新赛季）

**meta 不自带定时器**（与「gameserver 永不连库、meta 纯编排」一致）。赛季推进 = **运维在 S7 ops 后台手动点「开启新赛季」**，逐玩家结算走惰性迁移（§4）：

```
POST /admin/ladder/season/roll   (X-Internal-Key)   # ops 后台按钮触发
  幂等守卫：state=='active' 才执行（CAS；并发/误点重入返回当前赛季，不重复推进）
  → state='settling'
  → seasonNo += 1; startAt=now; endAt=now+SEASON_DURATION; state='active'
  → 返回新赛季时钟
```

- **谁来调**：运维在 ops 后台手动触发——`endAt` 到点不自动切，由运维结合活动节奏/版本节点决定何时开新季（可提前、可延后）。ops 前端把临近/已过 `endAt` 高亮提示运维「该开新季了」，但**不替运维做决定**。
- roll 只改时钟文档**一次写**；不碰任何玩家存档。玩家的上赛季结算在 §4 惰性发生。
- `state='settling'` 仅为 roll 自身的并发护栏（CAS，防止运维连点两次），毫秒级；玩家侧不感知。

### 4. 惰性迁移 + 软重置（核心机制）

`pvp` 段扩字段（**服务器权威**，`PUT /save` 拒绝客户端改）：

```ts
pvp: {
  elo: number;
  rank: string;
  wins: number;
  losses: number;
  streak: number;
  // —— 本文新增 ——
  seasonNo: number;            // 该 pvp 数据所属赛季号；落后于时钟 current 即触发迁移
  seasonPeakElo: number;       // 本赛季内达到过的最高 ELO（每局结算时取 max）
  seasonPeakRank: string;      // 本赛季峰值段位（由 seasonPeakElo 推导，TITLE_DESIGN 读它授称号）
  reachedRanks: string[];      // 历史首达过的段位 id 集合（首达金币幂等账本，§4.3）
}
```
> 新号初值：`seasonNo = 时钟当前值, seasonPeakElo = elo, seasonPeakRank = rank, reachedRanks = []`。

**迁移判定**（每次读/写 `pvp` 的服务器入口都先过一遍——`GET /save` reconcile、ranked 结算前、`GET /leaderboard` 命中自己时）：

```
migrateIfStale(save, current):
  if save.pvp.seasonNo == current.seasonNo: return  # 已是本季，无操作
  # —— 落后 → 先结算上赛季，再软重置 ——
  settleSeasonForPlayer(save)               # §4.2：发奖 + 授称号（幂等）
  save.pvp.elo        = softReset(save.pvp.elo)   # §4.1
  save.pvp.rank       = eloToRank(save.pvp.elo)
  save.pvp.seasonPeakElo  = save.pvp.elo
  save.pvp.seasonPeakRank = save.pvp.rank
  save.pvp.seasonNo   = current.seasonNo
  save.pvp.streak     = 0                    # 连胜串跨季清零
  # wins/losses 是终身累计，不清；如需「赛季战绩」另开 seasonWins 字段（P1，暂不做）
```

- 跨多个赛季未登录：`seasonNo` 可能落后 ≥2 季。**只按「最后一个有 peak 记录的赛季」结算一次**（中间空赛季无对局、peak=迁移时的 elo，结算额度按当时 peakRank；多季只发一次最高的——实现上每次迁移结算「上一季」即可，因为软重置已把 peak 拉到新基线，连续迁移自然只在第一跳产出有效奖励）。简化口径：**迁移只结算 `save.pvp.seasonNo` 那一季的 peak**，跨多季也只发一次（按存档里记的那季 peak）。

### 4.1 软重置算法（拍板：软重置·向基准回归）

```
softReset(elo) = elo > BASELINE ? round((elo + BASELINE) / 2) : elo
```

- **基准** `SEASON_RESET_BASELINE`（常量 → ECONOMY_NUMBERS，初定 **1200 = 黄金下限**）。
- **只压不抬**：高于基准的向基准回归一半（强者保留部分优势又被拉近）；**低于/等于基准的不动**（弱者无需重置、不平白升分）。
- 示例（基准 1200）：王者 2400→1800（大师）、钻石 1500→1350（铂金）、黄金 1200→1200（不变）、白银 1000→1000（不变）。
- 业界主流做法（强者每季重新证明、生态拉平），具体基准值留 ECONOMY_NUMBERS 调参。

### 4.2 赛季结算奖励（每季一次，幂等）

迁移时对「上赛季 `seasonPeakRank`」发放：

1. **赛季峰值金币**（`ECONOMY_BALANCE §2.3` 留的「赛季重置奖励，按峰值段位重复发、额度小于首达」）：按峰值段位查表（额度 → ECONOMY_NUMBERS §13，初定为首达金币的 ~30–40%，**每季可重复领**，是高段玩家的持续 faucet，须计入经济预算）。
2. **段位称号授予**：调 `grantTitle(accountId, 'ladder.s{oldSeasonNo}.{peakRank}')`（`TITLE_DESIGN §5.1`，`$addToSet` 幂等 + 自动佩戴最高 weight）。掉段不丢、历史永留。
3. **战令未领奖励补发**（若 C 块已上线，§9）。

- **发放路径 = 邮件**：赛季结算是**异步/批量/玩家可能不在场**的事件（结算发生在玩家「跨季后首次登录」的迁移点，但奖励归属于已结束的上赛季）。走邮件给**通知 + 仪式感 + 可审计**（对照 ops 补偿走邮件；留存/成就/称号金币走直接记账——本块的金币因「跨季归属、需通知」选邮件，称号本身仍直接 `grantTitle`）。
- **幂等守卫**：迁移前置条件 `seasonNo` 落后即天然只触发一次（迁移后 `seasonNo` 已推进，重入不再进结算分支）；称号 `$addToSet`；邮件发放复用 social 邮件的去重（同 `seasonNo` 的赛季结算邮件 key 唯一）。

### 4.3 段位首达金币补齐（修现状缺口）

当前 `settleElo`/`applyPvp`（`metaserver/src/internal.ts`）**只发了分段胜利金币、漏了首达金币**。本块在 ranked 结算的 `applyPvp` 内补上：

```
applyPvp 结算后:
  after = max(FLOOR, elo+delta); rank = eloToRank(after)
  # 赛季峰值追踪
  if after > pvp.seasonPeakElo:
      pvp.seasonPeakElo = after; pvp.seasonPeakRank = rank
  # 段位首达金币（§2.3a，一次性、终身、不可刷）
  newlyReached = RANKS_AT_OR_BELOW(rank) \ pvp.reachedRanks
  if newlyReached 非空:
      pvp.reachedRanks ∪= newlyReached
      coins += Σ firstReachCoins(r)   # 直接记账（玩家在场、即时反馈，同成就/称号路径）
```
- `reachedRanks` 是终身账本（跨赛季不清），保证首达金币**整个账号生命周期只发一次/段**（§2.3a「再升降不重复发」）。
- 与「赛季峰值金币」（§4.2，每季可重复领）解耦：首达=终身一次，峰值=每季一次，两条独立账本。

---

## B. 排行榜（拍板：全服 Top100 + 我的排名）

### 5. 形态与查询

```
GET /leaderboard   (JWT) → {
  season: { seasonNo, endAt },
  top: [ { rank:1.., publicId, displayName, elo, rankId, equippedTitle? } ],   // 前 100，ELO 降序
  me:  { rank, elo, rankId } | null                                            // 查询者全服名次
}
```

- **排序键**：当前赛季 `pvp.elo` 降序；并列以 `wins` 次序（稳定）。
- **本季有效性**：只计 `pvp.seasonNo == 当前赛季` 的玩家（避免上榜的是没迁移过来的陈分）。命中查询者自己时顺手 `migrateIfStale`（§4）。
- **我的名次**：`countDocuments({ 'save.pvp.elo': { $gt: myElo }, 'save.pvp.seasonNo': current }) + 1`。未打本季（无有效分）→ `me=null`，UI 显「打 1 场上榜」。
- **称号 join**：每行取该玩家 `equipped.title` 作 `equippedTitle`（`TITLE_DESIGN §8` 榜单展示位），客户端渲染短标签。

### 5.1 性能

- `saves` 加复合索引 `{ 'save.pvp.seasonNo': 1, 'save.pvp.elo': -1 }` 支撑 Top100 与 rank 计数。
- **Top100 缓存**：进程内缓存 60s（榜单非实时无伤）；「我的名次」每次实算（计数轻、且玩家关心自己实时）。
- 量大时（Redis 入场后，`META_DESIGN §10` M22）可迁 Redis `ZSET`（`ZREVRANGE` 取 Top、`ZREVRANK` 取个人名次，O(logN)）——**接口契约不变**，仅换实现。

---

## C. 战令（Battle Pass）

> 通用赛季规则镜像见 `ECONOMY_BALANCE §2.6` / `META_DESIGN §11.2`；**机制权威 = 本节**；奖励曲线数字 → ECONOMY_NUMBERS §13。依赖 `RETENTION_DESIGN`（每日任务点是赛季经验主来源）。

### 6. 数据模型

`SaveData` 新增 `battlePass` 块（服务器权威，`PUT /save` 拒改）：

```ts
battlePass?: {
  seasonNo: number;          // 所属赛季；落后于时钟即随 §4 迁移重置（清 xp/level/claimed）
  xp: number;                // 本季累计赛季经验
  level: number;             // 由 xp 经曲线推导（缓存便于展示，权威仍是 xp）
  hasPass: boolean;          // 是否购买付费 Pass（commercial 发货后置 true）
  claimedFree: number[];     // 已领免费轨等级 ⊆ [1..MAX_LEVEL]，$addToSet 幂等
  claimedPaid: number[];     // 已领付费轨等级（仅 hasPass 可领）
}
```
- 缺省视为「本季未参与」，懒创建。
- 跨季迁移（§4）：`battlePass.seasonNo` 落后 → 先**补发已挣得未领的奖励**（S6 温和：免费轨全发、付费轨若当季 hasPass 则发，走邮件随赛季结算邮件附件），再清零 `xp/level/claimed/hasPass`、`seasonNo` 推进。

### 7. 赛季经验来源（服务器权威累加，复用既有结算点）

**不开客户端写口**（同 `RETENTION_DESIGN R6`）。唯一累加位 = 既有服务器权威结算点：

| 来源 | 结算点 | 经验 |
|---|---|---|
| 完成每日任务 | `RETENTION` 任务点累加同事务 | 每点 → N 赛季经验 |
| 每日任务全清 | 留存满点领取 | 额外一次性经验 |
| ranked 对局 | `settleElo`（胜/负均给，胜更多） | 每局固定 + 胜利加成 |
| 周常宝箱 | `RETENTION` 周常（P1） | 档位经验 |

> 数额 → ECONOMY_NUMBERS §13；总曲线须保证「免费玩家正常活跃可在 6 周打满免费轨、付费 Pass 性价比明显更高」（`ECONOMY_BALANCE §2.6`）。

### 8. 双轨奖励 + 领取

- **定义表** `BATTLEPASS_DEFS`（`@nw/shared` 硬编码，后期挪 admin 可配）：`MAX_LEVEL`、每级 `xpToNext`、每级 `{ free?: Reward, paid?: Reward }`。
- **免费轨**全员可领；**付费轨**需 `hasPass`（`commercial` 购买，对标 `ECONOMY_BALANCE §2.2` 小档 ¥6 区间；购 Pass 后已挣得的付费档可立即回领——损失厌恶变现钩子）。
- 领取 = 解锁 ≠ 发放（`RETENTION_DESIGN R4`），红点驱动：

```
POST /battlepass/claim  (JWT) { track:'free'|'paid', level:int } → { save, granted }
  校验：battlePass.seasonNo==current
      → level ≤ 当前 level（已解锁）
      → track=='paid' ⟹ hasPass
      → level ∉ claimed{Track}      （$addToSet 幂等）
      → 发奖（金币直记账 / 材料/皮肤直改权威字段，同 RETENTION §5）
  错误：NOT_REACHED | ALREADY_CLAIMED | PASS_REQUIRED | BAD_REQUEST
POST /battlepass/buy   (JWT) → commercial 下单 → 发货回执置 hasPass=true（幂等，复用 deliveredOrders）
```

### 9. 赛季末战令补发（温和，S6）

赛季 roll 后玩家首次登录的 §4 迁移：免费轨所有「已达等级但未领」的奖励自动补发（邮件附件）；付费轨同理（若当季 `hasPass`）。然后清零本季战令。**已挣得不没收**。

---

## 10. 接口契约（汇总，落 SERVER_API / openapi.yml）

```
# 赛季时钟（玩家只读，随 save/leaderboard 带回；admin 推进）
GET  /leaderboard                         (JWT) → { season, top[100], me }
POST /admin/ladder/season/roll            (X-Internal-Key) → { season }   # ops 定时/手动

# 战令（C 块）
POST /battlepass/claim   { track, level } (JWT) → { save, granted }
POST /battlepass/buy                      (JWT) → 下单（commercial）
       defs 随 GET /save 静态下发 + 版本号缓存（同 retention defs）
```
- `pvp` 扩字段 + `battlePass` 块随 `GET /save` 下发（客户端只读）。
- **无 increment 端点**：经验/峰值/首达只在服务器结算链累加。
- DB：新增 `ladderSeasons` 集合（单文档）；`saves` 扩 `pvp` 字段 + `battlePass` 块（无独立集合）+ 复合索引（§5.1）。

---

## 11. 客户端 UI

> UI 规格权威 `UI_DESIGN.md`；本文只定信息结构。

- **赛季横幅**：大厅/StatsScene 显「赛季 N · 剩余 X 天」（数据来自 save/leaderboard 的 `season`）。
- **排行榜面板**（新）：Top100 列表（名次/头像/名/称号短标签/段位徽章/ELO）+ 顶部固定「我的名次」行；点行可看资料弹层（复用 `ProfilePopup`）。入口建议大厅或 StatsScene。
- **战令面板**（新，C 块）：等级进度条 + 双轨奖励轨（免费/付费并列），每档「已领/可领/未达/付费锁」四态；「购买 Pass」按钮（走 commercial）；红点聚合（任一可领）。
- **赛季结算弹层**：跨季首次登录弹「上赛季 S{N} 你达到 {峰值段位}」+ 奖励摘要 + 新赛季软重置后段位（一次/季）。
- **i18n**：新增 `season.*` / `leaderboard.*` / `battlepass.*`（中英德三语，**禁韩文**，见 memory）。
- 离线/未登录：显「登录后查看」（同 StatsScene 既有处理）。

---

## 12. 经济联动（与 ECONOMY 对齐）

- **数字权威**：软重置基准/赛季峰值金币/战令奖励曲线 → `ECONOMY_NUMBERS`（待铺 §13）；段位首达/分段胜利金币 → `ECONOMY_BALANCE §2.3`（已有）。
- **新增金币 faucet 需入预算跑模拟**（`ECONOMY_BALANCE §9` 遗留）：本文引入两条新金币产出——①**赛季峰值金币**（每季可重复，高段持续 faucet，是最需控量的一条，初定首达的 ~30–40%）；②**战令免费轨金币**（整季总额须 < 一次十连，`ECONOMY_BALANCE §2.6`）。二者与首达/胜利/成就/留存一起跑总产出验证，**不冲垮金币经济**。
- **变现脊梁**：付费 Pass（¥6 区间）是早期主力变现 + sink（`ECONOMY_BALANCE §2.6`「让买空 90% 物品的鲸鱼金币有去处」）。
- **红线**：所有奖励绝不进 PvP 蓝图、不卖战力（S5）。

---

## 13. 实现拆解（建议任务，落 META_TASKS S11）

> 依赖：S1-R 天梯（已落地，ELO 结算在 meta）；`RETENTION_DESIGN`（战令经验来源，C 块前置）；S6 social 邮件（赛季奖励发放）；S2/S5 金币路径；`TITLE_DESIGN`/S10（段位称号授予下游，可后置——先发金币、称号待 S10）。

| 阶段 | 内容 | 依赖 | 优先级 |
|---|---|---|---|
| **SE-1** | `@nw/shared`：`LadderSeasonDoc` 类型 + `SEASON_DURATION`/`SEASON_RESET_BASELINE` 常量 + `softReset()` / `migrateIfStale()` 纯函数 + `firstReachCoins()`；`pvp` 扩字段（`seasonNo/seasonPeakElo/seasonPeakRank/reachedRanks`）+ `makeNewSave` 初值 | — | P0 |
| **SE-2** | meta：`ladderSeasons` 集合 + 懒创建当前赛季；`migrateIfStale` 接入 `GET /save` reconcile 与 ranked 结算前；`applyPvp` 补**峰值追踪 + 段位首达金币**（修 §4.3 现状缺口） | SE-1 | P0 |
| **SE-3** | meta：`POST /admin/ladder/season/roll`（CAS 幂等）；S7 ops 后台加「开启新赛季」按钮（手动触发）+ 临近 `endAt` 高亮提示 | SE-2、S7 | P0 |
| **SE-4** | meta：`settleSeasonForPlayer`（峰值金币走邮件 + `grantTitle` 段位称号，幂等）；接入迁移点 | SE-2、S6 邮件、S10 | P0 |
| **SE-5** | meta：`GET /leaderboard`（Top100 缓存 60s + 我的名次实算 + 称号 join）+ 复合索引 | SE-2 | P0 |
| **SE-6** | 客户端：赛季横幅 + 排行榜面板 + 赛季结算弹层 + i18n（`season.*`/`leaderboard.*`） | SE-5、UI_DESIGN | P0 |
| **SE-7** | `@nw/shared` `BATTLEPASS_DEFS` + `battlePass` 块入 SaveData 权威段；赛季经验在留存/ranked 结算点累加 | SE-1、RETENTION | P1 |
| **SE-8** | meta：`POST /battlepass/claim`（双轨二次校验 + 幂等）+ `/buy`（commercial 发货置 hasPass）+ 迁移点补发未领（§9） | SE-7、S5 | P1 |
| **SE-9** | 客户端：战令面板（双轨/四态/红点/购 Pass）+ i18n `battlepass.*` | SE-8、UI_DESIGN | P1 |
| **SE-10** | 数值校准：赛季峰值金币 + 战令金币入 ECONOMY_NUMBERS §13，跑总产出模拟（`ECONOMY §9`） | SE-4、SE-8 | P1 |

---

## 14. 待定项（实现前需拍 / 数值待铺）

- [ ] `SEASON_RESET_BASELINE` 具体值（初定 1200=黄金；调高则强者保留更多）→ ECONOMY_NUMBERS §13。
- [ ] 赛季峰值金币各段额度（初定首达 ~30–40%，每季可重复）→ ECONOMY_NUMBERS §13 + 经济模拟。
- [ ] 战令：`MAX_LEVEL` / 每级 `xpToNext` 曲线 / 双轨每档奖励 / 付费 Pass 定价 → ECONOMY_NUMBERS §13。
- [ ] 赛季经验各来源数额（任务点→XP 系数、每局 XP、胜利加成）→ ECONOMY_NUMBERS §13。
- [ ] 是否新增「赛季战绩」`seasonWins/seasonLosses`（当前 wins/losses 终身累计跨季不清；赛季战绩为 P1 增强，暂不做）。
- [ ] 跨多季未登录的结算口径细化（§4 简化为「只结算存档记录的那一季 peak」，是否需要补中间季——倾向不补，空赛季无对局无奖励）。
- [ ] 赛季结算弹层是否在掉线/多端登录下重复弹（用 `seasonNo` 已迁移做幂等，前端再加本地已读标记）。
- [x] 赛季切换触发：**已定 = admin 手动开启新赛季**（运维 ops 后台按钮，meta 不自带定时器，§3.1）。

---

## 15. 实现记录

> （待实现后追加：完成阶段、实际字段/端点形态、与设计的差异。）
