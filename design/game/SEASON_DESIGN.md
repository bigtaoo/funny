# 天梯赛季 + 战令 + 排行榜设计 — Ranked Season / Battle Pass / Leaderboard

> 状态：设计中 · 权威：**本文（天梯赛季 / 战令 / 排行榜机制单一来源）** · 更新：2026-06-21
>
> 本文是天梯运营层的**机制设计基准**：赛季时钟、软重置、段位首达金币补齐、赛季峰值追踪与结算奖励、排行榜、战令（Battle Pass）、惰性迁移、接口契约、UI、经济联动、实现拆解。
> **数值不在本文拍死**：ELO/段位/首达金币 → [`ECONOMY_BALANCE.md §2.3`](ECONOMY_BALANCE.md)；赛季重置基准/赛季奖励/战令奖励曲线 → [`ECONOMY_NUMBERS.md §13`](ECONOMY_NUMBERS.md)。
> **与 SLG 大区赛季的边界/对照** → [`SEASON_OVERVIEW.md`](SEASON_OVERVIEW.md)（两套赛季独立性契约的单一来源；本文是其中「天梯」一侧的机制权威）。
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

- **数字权威**：软重置基准/赛季峰值金币/战令奖励曲线 → `ECONOMY_NUMBERS §13`（已铺）；段位首达/分段胜利金币 → `ECONOMY_BALANCE §2.3`（已有）。
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
| **SE-6** ✅ | 客户端：赛季横幅 + 排行榜面板 + 赛季结算弹层 + i18n（`season.*`/`leaderboard.*`）（2026-06-22：`LeaderboardScene`/`StatsScene` 横幅/`LobbyScene.showSeasonSettlement`/i18n zh+en+de） | SE-5、UI_DESIGN | P0 |
| **SE-7** | `@nw/shared` `BATTLEPASS_DEFS` + `battlePass` 块入 SaveData 权威段；赛季经验在留存/ranked 结算点累加 | SE-1、RETENTION | P1 |
| **SE-8** | meta：`POST /battlepass/claim`（双轨二次校验 + 幂等）+ `/buy`（commercial 发货置 hasPass）+ 迁移点补发未领（§9） | SE-7、S5 | P1 |
| **SE-9** ✅ | 客户端：战令面板（双轨/四态/红点/购 Pass）+ i18n `battlepass.*`（2026-06-22：`BattlePassScene`/`battlepassDefs.ts`/`AppViews.showBattlePass`/i18n） | SE-8、UI_DESIGN | P1 |
| **SE-10** ✅ | 数值校准：赛季峰值金币 + 战令金币入 ECONOMY_NUMBERS §13，跑总产出模拟（`ECONOMY §9`）（2026-06-22：`BP_XP_PER_RANKED_LOSS` 60→40；总产出模拟留 ECONOMY §9 后续） | SE-4、SE-8 | P1 |

---

## 13A. 可编码实现规格（P0：A 块赛季时钟/软重置 + B 块排行榜，SE-1~SE-6）

> 本节把 §13 的 SE-1~SE-6 细化到**字段/常量/函数签名/端点伪代码**级别，对齐现行代码（`@nw/shared` ladder.ts/types.ts、`metaserver` internal.ts/save.ts/mail.ts、`commercial` 钱包权威）。C 块战令（SE-7~SE-9）的同级细化留下一轮。

### 13A.0 与初稿的代码对齐修正（实现前必读，4 处）

逐文件核对现行代码后，§4 初稿有 4 处与现状冲突，**以本节为准**：

| # | 初稿表述 | 现状 | 修正 |
|---|---|---|---|
| **C1** | §4.3「首达金币**直接记账**」、§4.2 峰值金币「走邮件」 | `wallet.coins` 自 S5 起是 **commercial 权威只读镜像**，`saves` 里改 coins 会被对账覆盖 | **首达金币** = ranked 结算内联调 `commercial.grant({orderId:'lf:{acct}:{rank}', reason:'ladder_first_reach'})`（幂等、不限每日、best-effort，同 victoryCredit 失败不阻断结算）；**峰值金币** = 系统邮件 `{kind:'coins',count}` 附件，玩家领邮件时经现有 `splitAttachments`→commercial 入账。两者都**不写 `saves.wallet`**。 |
| **C2** | `seasonPeakRank: string`、首达按 `rank` 推导 | `pvp.rank` 新号初值是 `'unranked'`（**不在 `RankId`**）；`eloToRank` 最低只返回 `'bronze'`（minElo 0），永不返回 `'unranked'` | 段位类型统一用 `RankId | 'unranked'`。峰值/首达**一律按 `eloToRank(elo)` 推导**（与 `applyPvp` 现有 `rank=eloToRank(after)` 同源），不读存储的 `rank` 字段。`reachedRanks ⊆ RankId`（9 段，无 unranked）。 |
| **C3** | 新字段「新号初值…」 | 存量存档无新字段；`makeNewSave` 也要补 | `makeNewSave` 补 4 个新字段初值；**存量存档惰性补默认**——`getOrCreateSave` 读回后若 `pvp.seasonNo===undefined` 则 backfill（`seasonNo=当前赛季, seasonPeakElo=elo, seasonPeakRank=eloToRank(elo), reachedRanks=[]`）再走迁移。 |
| **C4** | §4.2「调 `grantTitle` 授段位称号」 | 称号系统 = `TITLE_DESIGN` S10，**未实现**（全 server grep `grantTitle` 零命中） | SE-4 本轮**只发峰值金币邮件**；`grantTitle` 留 TODO 占位 + 在邮件正文写明峰值段位（仪式感先到位），称号待 S10 接。 |

### 13A.1 SE-1 — `@nw/shared` 新增（纯函数 + 常量 + 类型）

**`ladder.ts` 追加**（紧挨现有 `RANK_TIERS`/`eloToRank`）：
```ts
/** 天梯赛季时长（6 周，ms）。展示用「预计结束」，非硬切换闸（§3.1 admin 手动）。 */
export const SEASON_DURATION_MS = 6 * 7 * 24 * 60 * 60 * 1000;

/** 软重置基准（§4.1，黄金下限）。高于此向基准回归一半，低于不动。 */
export const SEASON_RESET_BASELINE = 1200;

/** softReset：只压不抬，向基准回归。 */
export function softReset(elo: number): number {
  return elo > SEASON_RESET_BASELINE ? Math.round((elo + SEASON_RESET_BASELINE) / 2) : elo;
}

/** 段位首达金币（ECONOMY_BALANCE §2.3a，终身一次/段）。 */
export const FIRST_REACH_COINS: Record<RankId, number> = {
  bronze: 100, silver: 200, gold: 350, platinum: 600, diamond: 900,
  star: 1300, master: 1800, grandmaster: 2500, king: 3500,
};

/** 赛季峰值金币（每季可重复，§4.2；初定 ≈首达 35%，待经济模拟，→ ECONOMY_NUMBERS §13）。 */
export const SEASON_PEAK_COINS: Record<RankId, number> = {
  bronze: 40, silver: 70, gold: 120, platinum: 210, diamond: 320,
  star: 460, master: 630, grandmaster: 880, king: 1230,
};

/** ≤ 给定段位的所有段位 id（含自身），用于「一次升多段补发各段首达」。 */
export function ranksAtOrBelow(rank: RankId): RankId[] {
  const max = RANK_TIERS.find((t) => t.id === rank)!.minElo;
  return RANK_TIERS.filter((t) => t.minElo <= max).map((t) => t.id);
}
```

**`types.ts` — `pvp` 段扩字段 + `makeNewSave` 初值**：
```ts
pvp: {
  elo: number; rank: string; wins: number; losses: number; streak: number;
  // —— SE-1 新增（服务器权威，PUT /save 不可改）——
  seasonNo: number;          // 该 pvp 数据所属赛季号
  seasonPeakElo: number;     // 本季峰值 ELO
  seasonPeakRank: string;    // RankId | 'unranked'，由 seasonPeakElo 推导
  reachedRanks: string[];    // 终身首达段位 id 集合（首达金币幂等账本）
};
// makeNewSave: pvp 初值（INITIAL_ELO=1000，eloToRank(1000)='bronze' 但新号未打 ranked → rank 仍 'unranked'）
pvp: { elo: 1000, rank: 'unranked', wins: 0, losses: 0, streak: 0,
       seasonNo: 1, seasonPeakElo: 1000, seasonPeakRank: 'unranked', reachedRanks: [] }
```
> `seasonNo` 初值用常量 1；真实当前赛季在 reconcile 时由迁移对齐到时钟值（新号 elo 1000 ≤ 基准，软重置不动，无副作用）。

**新类型 `LadderSeasonDoc`（types.ts 或 mongo.ts）**：
```ts
export interface LadderSeasonDoc {
  _id: 'current';
  seasonNo: number; startAt: number; endAt: number;
  state: 'active' | 'settling';
}
```

**纯迁移规划函数（可单测，不碰 DB / 不发邮件）**：
```ts
export interface SeasonSettlement { settledSeasonNo: number; peakRank: RankId | 'unranked'; peakCoins: number; }
/** pvp 落后于时钟 → 返回 {软重置后的新 pvp, 上季结算载荷}；已是本季 → null。 */
export function planSeasonMigration(pvp: SaveData['pvp'], currentSeasonNo: number):
  { nextPvp: SaveData['pvp']; settlement: SeasonSettlement } | null;
//  实现：seasonNo===current → null；否则
//  peakRank = peak==='unranked'? 'unranked' : eloToRank(seasonPeakElo)（防御：直接 eloToRank(seasonPeakElo)）
//  peakCoins = peakRank==='unranked'? 0 : SEASON_PEAK_COINS[peakRank]
//  nextPvp = {...pvp, elo:softReset(elo), rank:eloToRank(softReset(elo)) 或保 'unranked' 若从未打,
//             seasonPeakElo:newElo, seasonPeakRank:同, seasonNo:current, streak:0}（wins/losses 不清）
```

### 13A.2 SE-2 — meta 接入（集合 + 迁移挂载 + applyPvp 改造）

**`mongo.ts`**：`Collections` 加 `ladderSeasons: Collection<LadderSeasonDoc>`；建集合；`saves` 加复合索引 `{ 'save.pvp.seasonNo': 1, 'save.pvp.elo': -1 }`（B 块用）。

**新模块 `metaserver/src/ladderSeason.ts`**：
```ts
getOrCreateCurrentSeason(cols, now): Promise<LadderSeasonDoc>   // 懒创建 {seasonNo:1,startAt:now,endAt:now+DUR,state:'active'}
migrateSaveIfStale(cols, commercial, now, doc): Promise<SaveData>
//   = backfill 缺省（C3）→ planSeasonMigration → 若有迁移：持久化 nextPvp（rev+1，整档替换，乐观锁重试）
//     + settleSeasonForPlayer（§13A.4，发峰值邮件）；返回最新 save
```
**挂载点**（3 处，每处「读到玩家 pvp」即先迁移）：
1. `getOrCreateSave` 返回前（GET /save reconcile 的源头）。
2. `settleElo` 读双方 elo **之前**（`internal.ts`，避免拿陈分算 ELO）。
3. `GET /leaderboard` 命中查询者自己时（§13A.5）。

**`applyPvp` 改造（internal.ts，§4.3）**——签名加 `commercial`，结算后追加峰值追踪 + 首达金币：
```ts
const after = Math.max(ELO_FLOOR, pvp.elo + delta);
const rank = eloToRank(after);
const seasonPeakElo = Math.max(pvp.seasonPeakElo, after);
const seasonPeakRank = eloToRank(seasonPeakElo);
const newReached = ranksAtOrBelow(rank).filter((r) => !pvp.reachedRanks.includes(r));
// next.pvp 写入 seasonPeakElo/seasonPeakRank/reachedRanks=[...pvp.reachedRanks,...newReached]
// 落库成功后（best-effort，不阻断）：
for (const r of newReached) {
  void commercial.grant({ accountId, amount: FIRST_REACH_COINS[r],
    reason: 'ladder_first_reach', orderId: `lf:${accountId}:${r}` }); // orderId 幂等终身一次
}
```
> 首达金币**不入 victory 每日上限**（用 `grant` 而非 `victoryCredit`）。结算前已由挂载点②迁移，故 `pvp` 必为本季。

### 13A.3 SE-3 — admin 开新赛季（CAS 幂等）

走现有 `/internal/*` 模式（admin 后端 X-Internal-Key 调 meta）：
```
POST /internal/ladder/season/roll   (X-Internal-Key)
  doc = ladderSeasons.findOneAndUpdate({_id:'current',state:'active'}, {$set:{state:'settling'}})
  if !doc: return 当前赛季（CAS 失败=并发/重入，不重复推进）
  → updateOne({_id:'current'}, {$set:{seasonNo:doc.seasonNo+1, startAt:now, endAt:now+DUR, state:'active'}})
  → return 新赛季
```
ops 前端（S7）加「开启新赛季」按钮 + 临近/已过 `endAt` 高亮（不自动切）。**只写时钟单文档，不碰任何存档**（玩家侧迁移惰性发生）。

### 13A.4 SE-4 — settleSeasonForPlayer（峰值金币邮件，幂等）

```ts
function settleSeasonForPlayer(cols, now, accountId, s: SeasonSettlement): Promise<void>
//  if s.peakCoins<=0: return（unranked/无对局季不发）
//  insertSystemMail(cols, dispatchKey=`ladder-settle:s${s.settledSeasonNo}`, accountId, {
//    subject: i18n key 'season.settle.subject', body: 含峰值段位 s.peakRank,
//    attachments: [{kind:'coins', count:s.peakCoins}], expireDays: 30 }, now)
//  → mailId = `ladder-settle:s{N}:{acct}`，$setOnInsert 幂等（跨多季只发存档记录那季，§4 简化口径）
//  TODO(S10): grantTitle(accountId, `ladder.s${s.settledSeasonNo}.${s.peakRank}`)
```
新插入时 `gateway.push(mail_new)`（复用现有）。称号本轮不发（C4）。

### 13A.5 SE-5 — `GET /leaderboard`（Top100 + 我的名次）

openapi 新增（JWT）：
```
GET /leaderboard → {
  season: { seasonNo, endAt },
  top: [{ rank, publicId, displayName?, elo, rankId }],   // ≤100，本季有效，ELO 降序
  me:  { rank, elo, rankId } | null
}
```
实现：
- `season = getOrCreateCurrentSeason`。
- **Top100**：进程内缓存 60s；查 `{'save.pvp.seasonNo': season.seasonNo}` sort `{'save.pvp.elo':-1, 'save.pvp.wins':-1}` limit 100，join profile（publicId/displayName）。
- **me**：先 `migrateSaveIfStale` 自己 → 若 `pvp.seasonNo===season.seasonNo` 且打过本季：`rank = countDocuments({'save.pvp.seasonNo':season, 'save.pvp.elo':{$gt:myElo}}) + 1`；否则 `me=null`。
- 称号 join 待 S10（先不返回 `equippedTitle`）。

### 13A.6 SE-6 — 客户端（信息结构，UI 规格归 UI_DESIGN）

- 读 `GET /save` 带回的 `season`（需在 save 响应里附 `{seasonNo,endAt}`）+ `GET /leaderboard`。
- 赛季横幅（大厅/StatsScene）、排行榜面板（Top100＋我的名次，点行复用 `ProfilePopup`）、赛季结算弹层（跨季首登一次，前端 `flags['season.read.s{N}']` 防重弹）。
- i18n `season.*` / `leaderboard.*`（中英德，禁韩文）。

### 13A.7 测试要点（always-run 纯逻辑 + e2e）

- 纯函数单测：`softReset`（边界 1200/上下）、`ranksAtOrBelow`、`planSeasonMigration`（同季 null / 跨季软重置 + 结算载荷 / unranked 不发）。
- e2e：roll CAS 幂等（连点两次只进一季）；迁移触发一次结算邮件（同 dispatchKey 重入不重复）；首达金币 `grant` orderId 幂等（重复结算不重复发）；leaderboard 只含本季 + 我的名次计数。

---

## 13B. 可编码实现规格（C 块战令 Battle Pass，SE-7~SE-9）

> 平行 §13A 把 SE-7~SE-9 细化到可编码。战令**复用 §13A 的赛季时钟**（同一 `ladderSeasons.seasonNo`，不另起时钟）。

### 13B.0 实现前必读（依赖现状 + 2 处对齐修正）

| # | 事项 | 现状核查结论 | 处置 |
|---|---|---|---|
| **D1（硬依赖）** | §7 经验来源含「每日任务点 / 每日全清 / 周常宝箱」 | **RETENTION 未实现**（server 无 `/retention`、SaveData 无 `daily/weekly/taskPoints`；grep 命中的 "retention" 全是 analyticsvc cohort，无关） | **本轮经验唯一来源 = `settleElo`（ranked 对局，胜/负均给）**，是现成服务器权威结算点。任务/周常经验挂载点**留 TODO**，待 `RETENTION_DESIGN` 落地后在其结算事务内同步累加（同 §3.1「一批结算点一起推进」）。**战令不因此阻塞**——ranked 玩家正常打就能升级。 |
| **D2（金币路径）** | §8「发奖（金币直记账…同 RETENTION §5）」 | 同 §13A-C1：`wallet.coins` 是 commercial 权威；RETENTION §5「直接 `coins +=`」本身也与现状冲突且未实现 | 战令**金币奖励走 `commercial.grant`**（orderId `bp:{acct}:s{N}:{track}:{level}` 幂等）；**皮肤/物品**走 meta 直接 rev 守卫写 `inventory.skins`/`inventory.items`（先例：`internal.ts` materials grant 已这样直写服务器权威段）。**不写 `wallet.coins`**。 |
| **D3（迁移扩展）** | §9 赛季末补发 + 清零 | §13A 的 `migrateSaveIfStale` 目前只处理 `pvp` | SE-8 **扩展 `migrateSaveIfStale`**：迁移时若 `battlePass.seasonNo` 落后 → 先补发已达未领（免费轨全发；付费轨若当季 `hasPass`），走系统邮件附件（同 §13A.4 邮件通道），再清零 `battlePass`。 |

### 13B.1 SE-7 — `@nw/shared` 战令定义 + SaveData 扩展

**`battlePass` 块（types.ts，服务器权威，`SyncPatch` 白名单不含它）**：
```ts
battlePass?: {
  seasonNo: number;      // 所属赛季（= ladderSeasons.seasonNo）；落后即随迁移补发+清零
  xp: number;            // 本季累计赛季经验（权威）
  hasPass: boolean;      // 是否购付费 Pass（commercial 发货置 true）
  claimedFree: number[]; // 已领免费轨等级 ⊆ [1..MAX_LEVEL]
  claimedPaid: number[]; // 已领付费轨等级（仅 hasPass 可领）
};
```
> **不存 `level`**（设计初稿存了 level 缓存）——`level` 由 `xp` 经曲线**现算**（`battlePassLevel(xp)`），与 RETENTION「不存可领状态、现算」一致，改曲线不需迁移玩家数据。缺省（`undefined`）= 本季未参与，懒创建。

**`battlepass.ts`（新文件，@nw/shared）— 定义表 + 纯函数**：
```ts
export const BP_MAX_LEVEL = 30;                 // [可调→ECONOMY_NUMBERS §13]
export const BP_XP_PER_LEVEL = 1000;            // 等差直线初版（每级等量）；非线性曲线后置
export const BP_XP_RANKED_WIN = 120;            // ranked 胜一局经验 [待模拟]
export const BP_XP_RANKED_LOSS = 40;            // ranked 负一局经验 [待模拟]

export interface BpReward { coins?: number; skin?: string; item?: { id: string; count: number }; }
export interface BpLevelDef { level: number; free?: BpReward; paid?: BpReward; }
export const BATTLEPASS_DEFS: BpLevelDef[] = [ /* 1..30，免费/付费每档奖励，占位值→§13 */ ];

/** xp → 当前等级（封顶 BP_MAX_LEVEL）。 */
export function battlePassLevel(xp: number): number {
  return Math.min(BP_MAX_LEVEL, Math.floor(xp / BP_XP_PER_LEVEL));
}
/** ranked 一局战令经验。 */
export function bpMatchXp(won: boolean): number {
  return won ? BP_XP_RANKED_WIN : BP_XP_RANKED_LOSS;
}
```
> 经验曲线须满足 `ECONOMY_BALANCE §2.6`「免费玩家 6 周可打满免费轨」：`BP_MAX_LEVEL*BP_XP_PER_LEVEL / 经验日均 ≈ 42 天`，数值在 ECONOMY_NUMBERS §13 校准。

**经验累加（SE-7，挂 `applyPvp`/`settleElo`）**：ranked 结算时 `battlePass.xp += bpMatchXp(won)`（若 `battlePass` 缺省则懒创建 `{seasonNo:current, xp, hasPass:false, claimedFree:[], claimedPaid:[]}`）。与 §13A 的 `pvp` 峰值/首达写在**同一次** `applyPvp` 整档替换里（避免多次 rev 冲突）。

### 13B.2 SE-8 — meta：claim / buy / 迁移补发

**`POST /battlepass/claim`（JWT）`{ track:'free'|'paid', level:int }` → `{ save, granted }`**：
```
migrateSaveIfStale 自己（D3）→ bp = save.battlePass（缺省视为未参与→无可领）
校验链（任一不过返对应错误）：
  bp.seasonNo === current               否则 BAD_REQUEST（已被迁移清零，前端刷新）
  1 ≤ level ≤ battlePassLevel(bp.xp)     否则 NOT_REACHED
  track==='paid' ⟹ bp.hasPass            否则 PASS_REQUIRED
  level ∉ bp.claimed{Track}              否则 ALREADY_CLAIMED
发奖（D2）：def = BATTLEPASS_DEFS[level-1][track]
  coins → commercial.grant(orderId=`bp:{acct}:s{N}:{track}:{level}`)
  skin  → $addToSet inventory.skins ；item → inventory.items[id]+=count（rev 守卫整档替换）
  claimed{Track} ∪= {level}（同一次写入，$addToSet 语义）
错误码：NOT_REACHED | ALREADY_CLAIMED | PASS_REQUIRED | BAD_REQUEST
```
**`POST /battlepass/buy`（JWT）**：commercial 下单（对标 §2.2 小档 ¥6）→ 发货回执置 `hasPass=true`（复用 `deliveredOrders` 幂等）；购后已挣得付费档可立即回领（claim 自然支持）。

**迁移补发（D3，扩 `migrateSaveIfStale`）**：`battlePass.seasonNo` 落后 → 收集免费轨所有 `level ≤ battlePassLevel(xp)` 且 `∉ claimedFree` 的奖励（付费轨同理且 `hasPass`）→ 汇总成一封系统邮件附件（`dispatchKey=bp-settle:s{oldN}`，与 §13A.4 赛季结算邮件可合并为一封）→ 清零 `battlePass`（`{seasonNo:current, xp:0, hasPass:false, claimed*:[]}`）。**已挣得不没收**（S6）。

### 13B.3 SE-9 — 客户端战令面板（信息结构）

- 读 `GET /save`（`battlePass` 块）+ defs（随 save 静态下发 + 版本号缓存，同 retention defs 约定）。
- 等级进度条（`xp` / 当前级阈值，现算）；双轨奖励轨（免费/付费并列），每档四态：**已领 / 可领（红点）/ 未达 / 付费锁**。
- 「购买 Pass」按钮（走 commercial 下单流程，复用商店购买 UI）。
- 红点聚合：任一档可领即亮（复用社交/成就红点聚合）。
- i18n `battlepass.*`（中英德，禁韩文）。

### 13B.4 测试要点

- 纯函数：`battlePassLevel`（边界 0 / 满级封顶）、`bpMatchXp`。
- e2e：claim 四态校验 + `commercial.grant` orderId 幂等（重复领不重复发币）；`PASS_REQUIRED`（未购付费轨拦截）；ranked 结算累加经验且与 pvp 峰值/首达**同一次 rev 写入**；跨季迁移补发未领一封邮件 + 清零（`bp-settle` dispatchKey 幂等）。

---

## 14. 待定项（实现前需拍 / 数值待铺）

- [~] `SEASON_RESET_BASELINE` = **1200**（§13A.1 已定为常量；调高则强者保留更多）→ 仍需 ECONOMY_NUMBERS §13 登记。
- [~] 赛季峰值金币各段额度：§13A.1 `SEASON_PEAK_COINS` 已给提案（≈首达 35%：40/70/120/210/320/460/630/880/1230），**待经济模拟确认**（高段每季可重复，是最需控量的新 faucet）→ ECONOMY_NUMBERS §13 + `ECONOMY §9` 总产出验证。
- [~] 战令：`BP_MAX_LEVEL`(初定 30) / `BP_XP_PER_LEVEL`(初定 1000 等差) / 双轨每档奖励 / 付费 Pass 定价 → §13B.1 已给结构与占位，数值待 ECONOMY_NUMBERS §13 校准（须满足「免费玩家 6 周打满免费轨」）。
- [~] 赛季经验各来源数额：§13B.1 已定每局 `BP_XP_RANKED_WIN/LOSS`(120/40 待模拟)。**任务点→XP 系数等其余来源硬依赖 `RETENTION_DESIGN` 落地**（未实现，§13B.0-D1），本轮战令仅 ranked 产经验。
- [ ] 是否新增「赛季战绩」`seasonWins/seasonLosses`（当前 wins/losses 终身累计跨季不清；赛季战绩为 P1 增强，暂不做）。
- [ ] 跨多季未登录的结算口径细化（§4 简化为「只结算存档记录的那一季 peak」，是否需要补中间季——倾向不补，空赛季无对局无奖励）。
- [ ] 赛季结算弹层是否在掉线/多端登录下重复弹（用 `seasonNo` 已迁移做幂等，前端再加本地已读标记）。
- [x] 赛季切换触发：**已定 = admin 手动开启新赛季**（运维 ops 后台按钮，meta 不自带定时器，§3.1）。

---

## 15. 实现记录

> （待实现后追加：完成阶段、实际字段/端点形态、与设计的差异。）

### 15.1 L2-1 赛季收束自动结算闭环（2026-06-23，上线收口 Track 2）

补齐唯一断裂链路：此前赛季奖励只在玩家**回归打 ranked**（`getSave`/`applyPvp` → `migrateIfStale` → `settleSeasonForPlayer`）时惰性发放，从不回归的玩家拿不到上季奖励/称号。

**改动**：
- `rollSeason(cols, commercial, now)`（`ladderSeason.ts`，签名加 `commercial`）：CAS 进入 `settling` 后，**先主动结算上一季全部参与者**（`settleSeasonParticipants`），再推进时钟到下一季。`POST /admin/ladder/season/roll`（ops 现有按钮）即闭环触发点。
- `settleSeasonParticipants(cols, commercial, seasonNo, now)`：游标遍历 `save.pvp.seasonNo === seasonNo` 的存档，逐个 `settleSeasonForPlayer`（发段位奖励邮件 + 授赛季段位称号）+ 写结算快照。
- `settleSeasonForPlayer` 返回值由 `void` 改为 `SeasonSettleSummary {peakRank, peakElo, coins, titleId}`（供写快照），逻辑不变；惰性迁移路径忽略返回值。
- 新增集合 `ladderSeasonSnapshots`（`LadderSeasonSnapshotDoc`，`mongo.ts`）：`_id=${seasonNo}:${accountId}`，存 `{seasonNo, accountId, peakElo, peakRank, coins, titleId, ts}`，兼作幂等账本。索引 `{seasonNo:1}`、`{accountId:1,seasonNo:-1}`。

**幂等（重复 close 同 seasonId 不双发）**：结算邮件 `dispatchKey=ladder.season.${seasonNo}.${accountId}` + 称号 `$addToSet` + 快照 `$setOnInsert` 三重去重。主动批量与玩家回归惰性迁移两条路径并行执行也不会双发。

**软重置不在 close 做**：ELO 软重置 / 战令重置仍由玩家下次 pvp 读写的 `migrateIfStale` 惰性执行（季末批量改全表风险高且无必要；close 只读 + 写邮件/称号/快照）。

测试：`metaserver/test/season-close.test.ts`（结算 + 幂等 + 快照一致性 + CAS 防双推）。
