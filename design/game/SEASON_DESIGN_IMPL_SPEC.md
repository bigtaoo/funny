# 赛季 / 战令 — 可编码实现规格（§13A 起）

> 从 [`SEASON_DESIGN.md`](SEASON_DESIGN.md) 拆出（2026-08-17，原文件 633 行）。**小节编号沿用原文**，`SEASON_DESIGN.md §N` 引用照旧有效。
> 本册内容：§13A 赛季时钟+排行榜（SE-1~SE-6）、§13B 战令（SE-7~SE-9）、§14 待定、§15 实现记录。总览与在先小节见 [`SEASON_DESIGN.md`](SEASON_DESIGN.md)。

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
- **bugfix（2026-07-05）**：奖励轨为可滚动列表（`scrollContainer` + mask），但构造函数只订了 `input.onDown`，未订 `onMove`/`onUp`，`scrollY` 永远为 0 → 页面无法下拉，30 级奖励只能看到首屏。修复：补 `dragStart`/`handleMove`/`handleUp`，对齐 `EquipmentScene/base.ts` 的拖拽滚动模式，并把 `scrollMax` 存为实例字段供 `handleMove` 内钳制。

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

### 15.2 ELO 结算算法调整：连胜/连败加速 + AI 代打计入日任务（2026-07-04）

**背景**：原 `computeEloDelta` 固定 K=32、零和（胜方+X = 败方-X），不区分连胜连败，也不区分对局来源；AI 代打（30s 排位超时兜底，`MATCHSVC_DESIGN.md §8`）完全走客户端本地对局，不经任何服务器结算——既不计入每日任务，也不影响 ELO。

**改动 1 — 连胜/连败加速（`server/shared/src/ladder.ts`）**：
- `computeEloDelta(winnerElo, loserElo, { winnerK?, loserK? })`：winner/loser 各自独立 K，**默认相同即退化为原零和公式**（向后兼容）。
- `streakMultiplier(streakLen)`：进入本局前的同向连续场次数每多 1 级，K ×(1+`STREAK_K_STEP`=0.3)，封顶 `STREAK_K_CAP`=2.5 倍（streakLen ≤1 不加成）。
- `internal.ts settleElo`：胜方用自己的连胜 streak 算 `winnerK`，败方用自己的连败 streak 算 `loserK`——**故意打破零和**：高手玩新号连胜时加分更快，低分号被高分玩家连败碾压时掉分也更快，两者都更快落到真实分段，互不依赖对方的连胜/连败状态。

**改动 2 — AI 代打计入日任务 + 低分段小幅加减分（`server/shared/src/ladder.ts` + `metaserver/src/service/progression.ts` + `POST /pvp/bot-result`）**：
- 新常量 `BOT_ELO_K`=8（真实对局 K=32 的 1/4）、`BOT_ELO_THRESHOLD`=1200（=黄金段下限，复用 `SEASON_RESET_BASELINE`）。
- 客户端本地 AI 对局结束后（仅限排位超时兜底 `fromBotFallback`，手动选择的练习赛不上报）调用新端点 `POST /pvp/bot-result { won }`（玩家 JWT 鉴权，非 `x-internal-key`——因为压根没有 room_id/gameserver session 可供内部结算接口验证）：
  - 始终 `accrueRetentionTask('pvp.match')`，AI 代打也算一次"参与 PvP 对局"的每日任务。
  - 仅当当前 ELO < `BOT_ELO_THRESHOLD` 时才用 `BOT_ELO_K` 小幅加减分（等价于对手同分 AI，`expWin=0.5` → 每次 ±4）；≥ 阈值只记日任务、ELO 不动，避免 AI 代打替代真实天梯爬分。
  - `pvp.lastBotResultAt` 节流：同账号 15s 内只接受一次加减分（每日任务不受节流，仍按幂等日历计），防止脚本对着 30s 排队超时刷分——即便刷穿也只能刷到 1200（黄金下限），价值有上限。
- 契约：`server/contracts/openapi.yml` `/pvp/bot-result`（`tags: [ranked]`），codegen 生成 `submitBotResult` handler。

测试：`server/shared/test/ladder.test.ts`（streakMultiplier / 非零和 delta）、`server/metaserver/test/internal.test.ts`（连胜加速端到端）、`server/metaserver/test/bot-result.test.ts`（阈值/节流/日任务）。

### 15.3 战令面板拖动卡顿修复（2026-07-06）

**问题**：`BattlePassScene`（SE-9）的奖励轨拖动手感很卡——`handleMove` 每次超过 6px 位移就调用一次完整 `render()`，即 `tearDownChildren` 全场景重建，包含 30 级 × 双轨 = 60 格奖励手绘 `sketchPanel`（带随机种子描边）、图标、文字。拖一次手指等于每帧重建上百个 PIXI 对象。

**改动**（`client/src/scenes/BattlePassScene.ts`）：
- 拆开「滚动位置更新」与「内容重建」两条路径。`render()` 仍按需完整重建（领取/购买/toast/loading 等数据变化时），但把奖励格的位置信息（`x/cellY/w/h` + 点击回调）缓存进 `scrollCellDefs`，不随滚动变化的命中区（返回/购买按钮等）缓存进 `staticHits`。
- 新增 `updateScrollPosition()`：只挪已建好的 `scrollContainer.y`，并从 `scrollCellDefs` 重算命中区拼回 `this.hits`，不碰任何 Graphics。`handleMove` 改为只调这个方法。
- 顺带修了一个由此暴露的正确性问题：`scrollCellDefs` 的可见性过滤原来用"当次渲染时的 scrollY"筛选是否在视口内——但拖动不再触发全量渲染后，这个过滤会导致玩家直接拖到底部时，那些初始渲染时不在视口内的关卡格子永远进不了缓存，滚过去也点不了。改为无条件缓存所有 `claimable` 格子（越界点击本身会被 `handleDown` 的实时坐标判定挡掉，不需要预先过滤）。

测试：`client/test/ui/battlePassScroll.ui.ts`（新增 3 例：拖动复用同一个 `scrollContainer` 实例；`scrollContainer.y` 精确随 `dy` 平移；初始视口外的格子滚动进来后仍可点击领取）。

### 15.4 战令面板：当前等级行独立高亮（2026-07-29）

**问题**：奖励格四态（可领/已领/未达/付费锁）的着色只反映领取状态，玩家自己当前所在等级一旦已领取，视觉上和其它任意已领级别完全一样，找不到"我在第几级"（用户截图标出 Lv.10 行诉求）。

**改动**（`client/src/scenes/BattlePassScene.ts`）：新增 `drawCurrentLevelFrame`，在渲染奖励轨时，若某行 `level === currentLevel`，在该行免费/付费两格外圈描一个跨两列的圆角描边框（`C.accent` 蓝，3px，独立于格子本身的四态填色/描边），与四态着色完全解耦——无论该级是可领/已领，当前等级永远多这一圈框。

测试：沿用既有 `battlePassScroll.ui.ts`/`battlePassClaimOverlay.ui.ts`（19 例全绿）+ `tsc --noEmit` 通过；未加新用例断言描边本身（现有 headless PIXI 适配器不产出像素，只做结构冒烟）。
