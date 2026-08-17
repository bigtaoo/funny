# SLG 大区赛季可编码实现规格（§17，S8-7 + G2/G6/G7 收口）

> 从 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 拆出（2026-08-17，原文件 2011 行）。**小节编号沿用原文，不重新编号**——源码注释里的 `SLG_DESIGN_LOG.md §N` 引用照旧有效。
> 核心设计以 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 为准；分册总览见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)。
> 本册是**当前状态的赛季规格**，不是流水账。`§17.15`（赛季字段静默 no-op 事故）等子节被 worldsvc 源码直接引用。

---

## 17. SLG 大区赛季可编码实现规格（S8-7 + G2/G6/G7 收口）

> **✅ 已落地（2026-06-21）**：§17.1–§17.9 全部实现并测试通过（worldsvc 122 / admin 18 / metaserver 140 测试绿，全量 `tsc -b` 0 错）。
> - **§17.1 `@nw/shared`**（`slg.ts`/`api.ts`）：繁荣度常量 + `familyProsperity`/`decayProsperity` + `settleTier`/`SETTLE_REWARDS` + `sectStrengthScore`/`allocateSectsToShards`（蛇形均衡）+ `WORLD_CAPACITY`/`RESET_DELETE_BATCH`；`WorldStatus` 加 `resetting`；`PROSPERITY_TOO_LOW` 错误码。
> - **§17.2 `worldsvc/db.ts`**：`FamilyDoc` 补 `prosperity/prosperityUpdatedAt/activity`；`WorldDoc` 补 `engineVersion`；新集合 `seasonResults`（C2）+ 索引。
> - **§17.3 状态机**：`joinWorld` open→active CAS；settle 守卫 active/settling；reset 守卫 settling/resetting（dev/test 无 world 文档时容量守卫口径放行）。
> - **§17.4 繁荣度**：`prosperity.ts`（refresh/effective/aggregate）；占领/围攻 `bumpFamilyActivity`（$inc + 刷新）；建宗门门槛（`sectService`）。
> - **§17.5 发奖+落库**：worldsvc `mailClient`（复用 meta `/internal/mail/system/send`，meta 加 `accountId` 直投分支）；`settleSeason` 落 `seasonResults`（$setOnInsert 幂等）+ 逐主体 `expandToAccounts` 发奖（中原首府材料 ×2，dispatchKey 幂等）。
> - **§17.6 resetSeason**：resetting 中间态 + 幂等续跑 + `deleteInBatches` 分批删 + 家族赛季态归零 + `engineVersion` 重 pin。
> - **§17.7 admin（C4/G7）**：worldsvc `/admin/world/*` 迁出 JWT 改 `X-Internal-Key` + `GET /admin/world/list`；admin 后端 `worldClient` + `/admin/slg/season/*` + `/admin/slg/worlds`（能力 `slg.season.view/manage`，reset 前必 settle + 审计）。
> - **§17.9 engineVersion pin**：`openSeason`/`resetSeason` pin `ENGINE_VERSION`；`applySiege` 跑前漂移告警（不阻断）。
> - **§17.13 异常交易审计（D/G7 反 RMT）✅（2026-06-21）**：`detectAuctionAnomalies` 检测 + worldsvc 扫描端点 + admin `tradeAuditTickets` 审计队列（立单/去重/裁定/留痕）+ 能力 `slg.audit.view|manage`。
> - **DRAFT/后续（§17.12）**：数值待经济模拟；SLG 战令增益、称号 grantTitle(S10) 仍待；~~G6 赛季中转区/合区运营专项~~ ✅ 已设计+落地（§28）；~~G7 异常审计 ops 前端页 + 确认违规自动处置外联~~ ✅ 已落地（§17.13）。
>
> 本节把 §2.3 / §8.3 / S8-7 + 缺口 G2（繁荣度）/ G6（多大区分配）/ G7（admin 接入）细化到**字段/常量/函数签名/端点伪代码**级别，对齐现行 `worldsvc`（`service.ts` 1657–1837 五个赛季函数 + `db.ts` schema + `commercialClient`/`metaClient`）与 `metaserver`（`mail.ts`/`internal.ts`）代码。
> **范式同源**：与天梯 [`SEASON_DESIGN §13A/§13B`](SEASON_DESIGN.md)（commit 1c3f46cf）并列；天梯那轮逐文件核对发现 4 处代码冲突，本节核对 worldsvc 发现 **7 处**（§17.0）。
> **边界铁律**：本节任何实现**不得**触碰 meta `saves.pvp.*`（OVERVIEW §3.1 写入域隔离）——§17.10 给出代码层自检证明「无需改动即合规」。
> **本节作用域**（2026-06-21 拍板）：发奖走系统邮件；G6 只到「数据地基 + 算法规格」，多 shard 运行时调度单列后续任务；繁荣度家族+宗门双层（宗门 = 成员家族聚合）。

### 17.0 与现状的代码对齐修正（实现前必读，7 处）

逐函数核对现行 `worldsvc`/`metaserver` 后，§2.3/§8.3/S8-7 初稿有 7 处与现状冲突或缺口，**以本节为准**：

| # | 缺口/冲突 | 现状 | 修正（本节基准） |
|---|---|---|---|
| **C1 结算零发奖** | `settleSeason`（`service.ts:1728`）只算排名 `return`，**不发任何材料/皮肤/称号**；worldsvc **无邮件能力**（`metaClient` 仅 deduct/grantMaterial/getProfile） | meta 已有 `POST /internal/mail/system/send`（X-Internal-Key，OPS 补偿用，`internal.ts:163`）+ `insertSystemMail`/`bulkInsertSystemMail`（dispatchKey 幂等，`mail.ts:180/199`）+ `splitAttachments`（`coins`/`skin`/`item` 三 kind，`mail.ts:83`） | worldsvc 新增 `mailClient` 复用 meta `/internal/mail/system/send`；settle 发奖 = 邮件附件（材料=`item`、皮肤=`skin`、coin=`coins`）；**称号** = grantTitle TODO(S10) + 邮件正文写明（同天梯 §13A.0-C4），本轮不发 |
| **C2 排名不落库** | 排名仅 HTTP 响应返回，**12 集合无历史表**；G6「按宗门强弱平衡分配」所需历史排名**无数据源**（=天梯「战令依赖 RETENTION 未落地」同构） | `WorldCollections` 无 `seasonResults` | 新增 `seasonResults` 集合（§17.2），`settleSeason` 落库本季宗门排名 + 繁荣度快照，作为下季 G6 分配输入 |
| **C3 繁荣度死字段 + 定位错位** | `prosperity` 实际在 **`SectDoc`**（`db.ts:134`，建宗门设 0、永不更新）；**`FamilyDoc` 根本没有 prosperity 字段**（仅 `territoryCount`）。设计 §8.1/§15.1 G2 却都写「FamilyDoc.prosperity」 | `sectService.ts:164` 建门设 `prosperity:0`，无评分/衰减 | `FamilyDoc` 补 `prosperity` + `prosperityUpdatedAt`；`SectDoc.prosperity` 改为「成员家族繁荣度聚合」（§17.4）；建宗门门槛读家族繁荣度 |
| **C4 admin 端点未鉴权** | `/admin/world/{open,settle,reset,close}`（`httpApi.ts:515–541`）在 **JWT handler 内、无 X-Internal-Key**——任意登录玩家可调 `/admin/world/reset` 清整个大区。代码自认「生产应加 X-Internal-Key，P2 补」 | 天梯 roll 走 `/internal/*`+X-Internal-Key+admin 后端 | 四端点迁出 JWT 分支、改 `X-Internal-Key` 门控（§17.7）；admin 后端加 SLG 赛季运维代理（G7） |
| **C5 reset 非原子/非分批** | `resetSeason`（`service.ts:1795`）7×`deleteMany` 并发 `Promise.all`+2×update，万人级无分批、无幂等键、无中途失败保护；`status` 无中间态 | U13 列了原子性风险，未处理 | status 加 `resetting` 中间态 + 幂等守卫（settling→resetting→open）；大集合分批删（§17.6） |
| ~~**C6 battlePass 死增益**~~ **✅ 已实现（2026-06-22）** | `buySlgShopItem`（`service.ts:1908`）写 `hasBattlePass:true`，~~全代码无处读取给增益~~ → `trainTroops`/`speedupTraining` 已读取并应用增益（S8-8）；reset 删 playerWorld 时随之清除，路径正确 | G4/S8-8 | `trainTroops` ×0.8 训练时长；`speedupTraining` 每币加速 ÷0.85 |
| **C7 engineVersion 未 pin** | `WorldDoc` 无 `engineVersion`；`SiegeDoc` 存 seed+布阵未记引擎版本，赛季中途升引擎重播/权威围攻一致性无锚点（U9） | `@nw/engine` 已导出 `ENGINE_VERSION`（§16.7） | `WorldDoc.engineVersion` 开服时 pin = `ENGINE_VERSION`；worldsvc 跑围攻校验 world pin vs 进程版本（§17.9） |

**死状态值修正**：`WorldStatus` 四段 `open/active/settling/closed` 中 **`active` 从无写入点**（join 接受 `open|active` 但从不置 `active`）。本节定义完整状态机（§17.3），首次有玩家 join 后 `open→active`。

### 17.1 `@nw/shared` 新增（`slg.ts`，常量 + 纯函数 + 类型）

紧挨现有 `SEASON_LENGTH_DAYS=60`（`slg.ts:164`）、`NATION_BONUS_*` 追加：

```ts
// ── 繁荣度（G2，§8.1）──────────────────────────────────────
/** 繁荣度评分权重（已核验：ECONOMY_NUMBERS §13-SLG-E，econ-sim E 轨 2026-06-30 CLOSED）。 */
export const PROSPERITY_W_TERRITORY = 10;   // 每块领地
export const PROSPERITY_W_MEMBER    = 50;   // 每个成员
export const PROSPERITY_W_ACTIVITY  = 5;    // 每点赛季活跃（新占领数+战斗场次，§17.4 来源）
/** 长期无活跃衰减：每自然日衰减比例（读时惰性结算，类比资源 yield）。 */
export const PROSPERITY_DECAY_PER_DAY = 0.05; // 5%/日
/** 建宗门繁荣度中等门槛（§8.2，§16.5 A7 拍板；2026-06-22 §14.10 U6 表定值）。
 *  可达性/衰减已核验：econ-sim E 轨（server/tools/econ-sim/src/prosperityRun.ts）——ECONOMY_NUMBERS §13-SLG-E，
 *  2026-06-30 CLOSED：活跃中位家族（20 起始成员、3.5 地/天、4 活跃/天）第 9 天建宗门（7–14 天窗口内）。 */
export const SECT_FOUND_PROSPERITY_MIN = 2000;

/** 家族繁荣度纯函数：可单测、双端可算、整数化。activity = 赛季累计活跃点（§17.4）。 */
export function familyProsperity(territoryCount: number, memberCount: number, activity: number): number {
  return Math.floor(
    territoryCount * PROSPERITY_W_TERRITORY +
    memberCount * PROSPERITY_W_MEMBER +
    activity * PROSPERITY_W_ACTIVITY,
  );
}
/** 衰减：base 经过 dtDays 天后的衰减值（无活跃则缩水），floor 整数。 */
export function decayProsperity(base: number, dtDays: number): number {
  return Math.floor(base * Math.pow(1 - PROSPERITY_DECAY_PER_DAY, Math.max(0, dtDays)));
}

// ── 赛季结算奖励（§8.3，DRAFT → ECONOMY_NUMBERS §13-SLG）─────
/** 大比档位（按宗门占国数排名名次切档）。 */
export type SettleTier = 'champion' | 'top3' | 'top10' | 'participant';
export function settleTier(rank: number): SettleTier {
  if (rank === 1) return 'champion';
  if (rank <= 3) return 'top3';
  if (rank <= 10) return 'top10';
  return 'participant';
}
/** 各档奖励（材料 item / 皮肤 skin / 称号 titleId）。占位数值待经济模拟。 */
export interface SettleReward {
  items: Record<string, number>;     // 材料：{ scrap: N, lead: M, binding: K }
  skins: string[];                   // 皮肤 id（限定）
  titleId?: string;                  // 称号（grantTitle TODO S10，本轮仅邮件正文）
  coins?: number;                    // 可选 coin（须并入经济总预算，OVERVIEW §3.3）
}
export const SETTLE_REWARDS: Record<SettleTier, SettleReward> = {
  champion:    { items: { scrap: 500, lead: 200, binding: 50 }, skins: ['slg_champion_frame'], titleId: 'slg.champion', coins: 0 },
  top3:        { items: { scrap: 300, lead: 120, binding: 25 }, skins: [], titleId: 'slg.top3' },
  top10:       { items: { scrap: 150, lead: 60,  binding: 10 }, skins: [] },
  participant: { items: { scrap: 50,  lead: 20,  binding: 0  }, skins: [] },
};
/** 中原首府（capitalIdx 9，§2.4）占领加权：该档奖励材料 ×CENTER_CAPITAL_MULT。 */
export const CENTER_CAPITAL_IDX = 9;
export const CENTER_CAPITAL_MULT = 2;

// ── 引擎版本 pin（C7/U9）────────────────────────────────────
// ENGINE_VERSION 由 @nw/engine 导出；worldsvc 开服时写入 WorldDoc.engineVersion。
```

**G6 分配算法（纯函数，可单测，不碰 DB）**：

```ts
/** 一个宗门的「综合实力」输入（来自上季 seasonResults + 当前规模/繁荣度）。 */
export interface SectStrength {
  sectId: string;
  lastSeasonRank?: number;   // 上季大比名次（无 = 新宗门）
  memberFamilyCount: number;
  prosperity: number;        // 当前繁荣度聚合
}
/** 实力评分（越高越强）：历史排名为主（名次越小越强），规模/繁荣度为辅。
 *  权重敏感性已核验：ECONOMY_NUMBERS §13-SLG-D，2026-06-30 CLOSED。 */
export function sectStrengthScore(s: SectStrength): number {
  const rankScore = s.lastSeasonRank ? Math.max(0, 100 - s.lastSeasonRank) * 100 : 500; // 新宗门给中位
  return rankScore + s.memberFamilyCount * 50 + Math.floor(s.prosperity / 100);
}
/**
 * 蛇形（snake）均衡分配：按 score 降序，蛇形发牌到 shardCount 个大区，
 * 使各区强弱总和尽量持平（强宗门与弱宗门搭配，SLG3）。返回 sectId→shardIndex。
 * shardCount 由「∑成员人数 / 单区容量 向上取整」预先算出（§17.8）。
 */
export function allocateSectsToShards(sects: SectStrength[], shardCount: number): Map<string, number>;
//  实现：sort by score desc；蛇形游标 0,1,..,n-1,n-1,..,1,0,0,..；同宗门成员随宗门进同一 shard（成员粒度由调用方按 sectId 展开）。
```

**类型/枚举**：`WorldStatus` 扩 `'resetting'`（`shared/slg.ts` 枚举 + `db.ts` 引用同步）。

### 17.2 worldsvc 数据模型扩展（`db.ts`）

```ts
// FamilyDoc 补（C3）：
prosperity: number;            // 家族繁荣度（familyProsperity 算，读时惰性衰减）
prosperityUpdatedAt: number;   // ms，衰减锚点
activity: number;              // 赛季累计活跃点（新占领数 + 战斗场次，§17.4）

// SectDoc.prosperity 语义改为「成员家族繁荣度之和」（settleSeason / 建宗门门槛时聚合刷新）。

// WorldDoc 补（C7）：
engineVersion: number;         // 开服时 pin = ENGINE_VERSION

// 新集合 seasonResults（C2）——赛季结算历史，G6 分配输入：
export interface SeasonResultDoc {
  _id: string;                 // `${worldId}:s${season}`（幂等键）
  worldId: string;
  season: number;
  settledAt: number;
  ranking: Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    id: string;                // sectId / familyId / ownerId
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
    prosperity?: number;       // 结算时繁荣度快照（sect scope 才有意义）
    tier: SettleTier;
  }>;
}
// WorldCollections 加 seasonResults: Collection<SeasonResultDoc>;
// ensureIndexes 加：seasonResults.createIndex({ worldId: 1, season: -1 });
//                  families.createIndex({ worldId: 1, prosperity: -1 });  // 建宗门门槛/分配查询
```

### 17.3 赛季状态机（修正 `active` 死值 + 加 `resetting`）

```
open ──(首位玩家 join)──▶ active ──(POST /admin/world/settle)──▶ settling
                                                                    │
                          ┌──(POST /admin/world/reset)─────────────┘
                          ▼
                      resetting ──(清档完成)──▶ open ──(再开季 join)──▶ active
                          │
  active/settling ──(POST /admin/world/close)──▶ closed（归档，不再 join）
```

- `joinWorld`（`service.ts:320`）：进入时若 `status==='open'` → CAS 置 `active`（`updateOne({_id,status:'open'},{$set:{status:'active'}})`，幂等）。
- `settleSeason` 守卫：仅 `active`/`settling` 可结算（重入安全）。
- `resetSeason` 守卫：仅 `settling`/`resetting` 可重置（防越过结算直接清档丢历史；先 settle 落 `seasonResults` 再 reset）。

### 17.4 繁荣度评分 + 衰减 + 建宗门门槛（G2 / C3）

**活跃点累加（`activity`，服务器权威，无客户端写口）**——挂既有结算点 `$inc`：

| 触发点 | 现有函数 | 累加 |
|---|---|---|
| 占领新领地 | `occupyTile` / march `applyArrival` occupy | `families.$inc({activity: 1})`（占领者所属家族） |
| 围攻战（攻/守，关键战斗落地） | `landSiege`（`service.ts` G3-1） | 双方家族各 `$inc({activity: 1})` |

**繁荣度读时惰性结算**（类比资源 yield，不每日 tick）：读 `FamilyDoc` 时
`current = decayProsperity(familyProsperity(territoryCount, memberCount, activity), (now - prosperityUpdatedAt)/86400_000)`；
显式刷新点（占领/丢地/成员变动/settle）回写 `prosperity` + `prosperityUpdatedAt=now`。

**建宗门门槛（`sectService` 建门校验）**：仅扣 5000 coin（`sectService.ts`）+ 要求发起人是家族族长（`requireFamilyLeader`）；~~繁荣度门槛 `prosperity ≥ SECT_FOUND_PROSPERITY_MIN`（`PROSPERITY_TOO_LOW`）~~ **已移除（2026-07-13）**——任何族长任何时候都可自行建门，不再要求家族活跃度/繁荣度达标。

**宗门繁荣度聚合**：`SectDoc.prosperity = ∑ 成员家族.prosperity`，在 settle / 建门 / G6 分配采集时刷新（`families.find({sectId}).reduce`）。

### 17.5 `settleSeason` 发奖改造（C1）+ 排名落库（C2）

**新增 worldsvc `mailClient`（复用 meta `/internal/mail/system/send`）**：

```ts
export interface WorldMailClient {
  readonly available: boolean;
  /** 系统邮件（dispatchKey 幂等，附件 coins/skin/item）。best-effort，失败 log 不阻断结算。 */
  sendSystemMail(accountId: string, dispatchKey: string, content: {
    subject: string; body: string;
    attachments?: Array<{ kind: 'coins' | 'skin' | 'item'; id?: string; count?: number }>;
    expireDays?: number;
  }): Promise<void>;
}
// HttpWorldMailClient → POST {baseUrl}/internal/mail/system/send (X-Internal-Key)
//   body: { accountId, dispatchKey, subject, body, attachments, expireDays }
// nullWorldMailClient: available=false, no-op（未配 NW_META_INTERNAL_URL）
```

**`settleSeason` 改造**（追加在现有排名计算之后，`service.ts:1777` return 前）：

```ts
async settleSeason(worldId) {
  // ...（现有 status→settling + 按 宗门→家族→个人 聚合排名，不变）...
  const ranking = [...agg.entries()].sort(...).map((e,i)=>({rank:i+1, ...}));

  // ① 落库历史（C2，幂等：_id = `${worldId}:s${season}`，$setOnInsert）
  const w = await cols.worlds.findOne({ _id: worldId });
  await cols.seasonResults.updateOne(
    { _id: `${worldId}:s${w.season}` },
    { $setOnInsert: { worldId, season: w.season, settledAt: now(),
        ranking: ranking.map(r => ({ ...r, tier: settleTier(r.rank),
          ...(r.scope==='sect' ? { prosperity: aggSectProsperity(r.familyId) } : {}) })) } },
    { upsert: true },
  );

  // ② 发奖（C1）——逐排名主体展开到「该主体下所有玩家账号」发邮件附件
  for (const r of ranking) {
    const tier = settleTier(r.rank);
    let reward = SETTLE_REWARDS[tier];
    if (r.capitalIdxs.includes(CENTER_CAPITAL_IDX)) {              // 中原加权（§2.4）
      reward = { ...reward, items: mapValues(reward.items, v => v * CENTER_CAPITAL_MULT) };
    }
    const accounts = await expandToAccounts(worldId, r.scope, r.familyId); // sect→成员家族成员 / family→成员 / solo→ownerId
    for (const acct of accounts) {
      void this.mail.sendSystemMail(acct, `slg-settle:${worldId}:s${w.season}`, {
        subject: 'slg.settle.subject',                            // i18n key
        body: `slg.settle.body|rank=${r.rank}|tier=${tier}|nations=${r.nationCount}`, // 含名次/段位/称号占位
        attachments: [
          ...Object.entries(reward.items).filter(([,n])=>n>0).map(([id,count])=>({kind:'item' as const, id, count})),
          ...reward.skins.map(id=>({kind:'skin' as const, id})),
          ...(reward.coins ? [{kind:'coins' as const, count:reward.coins}] : []),
        ],
        expireDays: 30,
      });
      // TODO(S10): if (reward.titleId) grantTitle(acct, reward.titleId)  —— 称号系统未实现（同天梯 §13A.0-C4）
    }
  }
  return ranking;
}
```

> **dispatchKey = `slg-settle:{worldId}:s{N}`**（同主体同账号幂等，重入不重复发——但注意：同一玩家若属多个排名主体不会发生，scope 互斥）。**coin 默认 0**（SLG settle 奖励以材料/皮肤为主，OVERVIEW §3.3 经济总预算口径；任何 coin 须经经济模拟批准）。

### 17.6 `resetSeason` 原子/分批/幂等改造（C5 / U13）

```ts
async resetSeason(worldId) {
  // ① 状态守卫 + 中间态（幂等：已 resetting 直接续跑）
  const w = await cols.worlds.findOneAndUpdate(
    { _id: worldId, status: { $in: ['settling', 'resetting'] } },
    { $set: { status: 'resetting' as const } },
  );
  if (!w) throw new SlgError('WORLD_CLOSED', '须先 settle 再 reset'); // 防跳过结算丢历史

  // ② 分批删大集合（tiles/marches/playerWorld/sieges 可能万级；每批 BATCH=2000，让出事件循环）
  const deleted = {};
  for (const c of ['tiles','marches','playerWorld','nations','sieges','sects','sectMessages']) {
    deleted[c] = await deleteInBatches(cols[c], { worldId }, RESET_DELETE_BATCH); // 循环 deleteMany(limit) / 游标删
  }
  // ③ 家族编制保留（成员关系/coin/养成跨季留存）但清赛季态：繁荣度/活跃/territory/宗门归属归零
  await cols.families.updateMany({ worldId },
    { $set: { territoryCount: 0, prosperity: 0, activity: 0, prosperityUpdatedAt: now() }, $unset: { sectId: '' } });

  // ④ 重开（engineVersion 重新 pin 当前进程版本，C7）
  await cols.worlds.updateOne({ _id: worldId },
    { $set: { status: 'open' as const, population: 0, resetAt: now(), engineVersion: ENGINE_VERSION }, $inc: { rev: 1 } });
  await this.initNations(worldId);
  return { deleted };
}
```

> **新常量** `RESET_DELETE_BATCH = 2000`（`shared/slg.ts`）。**幂等**：`resetting` 中途崩溃 → 重调从 `resetting` 续跑（删已删的是 no-op，最终一致）。**赛季资源清零原子性（U13）**：playerWorld 整文档删除 = 粮/铁/木一并清，无「半清」中间值可被惰性结算读到（删后玩家 re-join 走 `joinWorld` 重建初始态）。

### 17.7 admin 鉴权 + admin 后端 SLG 接入（C4 / G7）

**worldsvc 侧**：`/admin/world/{open,settle,reset,close}` 四端点**迁出 JWT 分支**，改 `X-Internal-Key` 门控（与 commercial/meta `/internal/*` 同模式）。在 `httpApi.ts` JWT 鉴权之前加内部分支：

```ts
// 内部运维分支（X-Internal-Key，不走 JWT）
if (path.startsWith('/admin/world/')) {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) return sendErr(res, ErrorCode.UNAUTHORIZED);
  // open / settle / reset / close（逻辑不变，鉴权升级）
}
```

**admin 后端侧（G7，`server/admin/src` 当前 SLG 零命中）**：新增 worldsvc 代理 + 工单：
- `worldClient`（admin→worldsvc 内部 HTTP，X-Internal-Key）：`openWorld/settleWorld/resetWorld/closeWorld/listWorlds`。
- admin REST（管理员鉴权，OPS 复用）：`POST /admin/slg/season/{open,settle,reset,close}` + `GET /admin/slg/worlds`（列各大区 status/population/resetAt）。
- **运维序列约束**（admin 后端 enforce）：reset 前必须 settle（否则丢 `seasonResults`），UI 按钮顺序 open→（运营期）→settle→reset→close；临近 `openAt + SEASON_LENGTH_DAYS` 高亮（不自动切，同天梯手动 roll）。
- **异常交易审计工单 ✅（2026-06-21，反 RMT，G7）**：见 §17.13。

### 17.13 异常交易审计（D / G7 反 RMT，2026-06-21 落地）

> C/E/F/G 闸门是「下单时的硬护栏」（限流/禁挂/冻结/价格带），但绕不过「两个合谋账号在价格带内反复定向倒货」这类事后才显形的洗钱/搬砖。本节加**离线检测层 + admin 审计队列**：worldsvc 扫已成交记录聚合可疑配对，运维在 admin 立工单单人裁定。与补偿工单平行但独立（补偿=发奖、双人审批；审计=核查违规、单人裁定+留痕，处置封禁/扣回走外联）。

- **检测（`@nw/shared`，纯函数可调参可单测）**：`detectAuctionAnomalies(trades, thresholds?)` 把成交记录按「卖家→买家」**有向配对**聚合，命中任一信号即报异常——`repeated`（配对成交 ≥ `AUDIT_PAIR_MIN_TRADES`=5，反复对敲）/ `designated`（定向受拍成交 ≥ `AUDIT_PAIR_MIN_DESIGNATED`=3，定向倒货）/ `high_value`（累计金币 ≥ `AUDIT_PAIR_MIN_COINS`=50000，大额转移）；`severity=high` 当 designated+high_value 同时命中（最像真钱 RMT），否则 medium。常量 + `AUDIT_WINDOW_SEC`=7 天 DRAFT，待 ECONOMY_NUMBERS 调参。
- **worldsvc**：`AuctionDoc.soldAt`（status→sold 时写；旧档回退解析 `auctionId` 内挂单 ts）；`AuctionService.scanAnomalies(worldId, windowSec?, thresholds?)` 拉近期 sold 投影成 `AuctionTradeRecord[]` 跑检测；内部端点 `GET /admin/world/audit/anomalies?worldId=&windowSec=`（X-Internal-Key，并入既有 `/admin/world/*` 内部分支）。只读，不改状态。
- **admin**：`WorldClient.listAuctionAnomalies` 代理 worldsvc；新集合 `tradeAuditTickets`（独立库 `notebook_wars_admin`，`pairKey` 去重 + status/filedAt 索引）；`AdminService` 加 `slgScanAnomalies`/`slgFileAuditTicket`（冻结快照 + pairKey 同配对 open 去重幂等）/`slgListAuditTickets`/`slgResolveAuditTicket`（open→dismissed|actioned 原子守卫，审计 `slg.audit.file`/`slg.audit.resolve`）；REST `GET /admin/slg/audit/anomalies`·`GET|POST /admin/slg/audit/tickets`·`POST /admin/slg/audit/tickets/{id}/resolve`。能力 `slg.audit.view`（super/ops/viewer）/ `slg.audit.manage`（super/ops）。
- **验收**：server `tsc -b`（10 包）全绿；worldsvc e2e 167（+6 `auction-audit`：repeated/designated+high_value/正常无异常/窗口外不计/soldAt 回退/方向区分）；admin e2e 24（+6 `season-audit`：扫描代理/立单 pairKey 去重/裁定 open→actioned+重复裁定拒/结案后可重立/无效裁定+无效快照拒/审计留痕）。
- **ops 前端审计页 ✅（已随后续 ops 拆分落地，未在本节记录过）**：`tools/ops/src/pages/auctionAudit.ts`（`pageAuctionAudit`，nav id `slg-audit`，能力 `slg.audit.view/manage`）——扫描表单 + 异常表（File ticket 按钮）+ 工单队列（状态筛选 + Dismiss/Action 按钮），沿用与 `pageSlgShop` 相同的 `pageXxx(ctx)` 模板。**本节盘点（2026-07-16）时发现这行"未尽"记录是过时的**——UI 早已存在，只是本文档没跟着更新。
- **确认违规后自动处置 ✅（2026-07-16）**：`slgResolveAuditTicket` 裁定为 `actioned` 时，自动对买卖双方调用既有 `suspiciousPve.banAccount`（与反作弊页同一 metaserver `/internal/accounts/{id}/ban` 端点）——先原子状态迁移（`open→actioned`，赢得并发裁定竞争的那次调用才执行封禁，杜绝双重封号），再对双方发起封禁（best-effort、互相独立、失败不阻断工单裁定），结果写回 ticket 的 `enforcement: {sellerBanned, buyerBanned}` 字段（`TradeAuditTicketDoc`/`TradeAuditTicketView` 新增，admin/ops 两侧类型同步）；每次成功封禁额外记 `account.ban` 审计条目。ops 页面工单行展示 `Enforcement: seller banned/ban failed, buyer banned/ban failed`。**范围说明**：只做封号（冻结账号，阻止后续登录/交易），不做「追缴」——回收违规交易涉及的金币/物品需要单独判定该退给谁、是否已被二次转手，属于更复杂的资产清算逻辑，本轮不做。**验收**：`server/admin/test/season-audit.e2e.test.ts` 新增用例（actioned 双方被封 + enforcement 字段 + 2 条 `account.ban` 审计；dismissed 不触发任何封禁）；`tsc -b shared admin` + `tools/ops` `tsc --noEmit` 全绿。

### 17.8 G6 多大区 + 按宗门强弱平衡分配（数据地基 + 算法规格，运行时延后）

> 本轮拍板：**只做数据地基 + 纯算法规格**（§17.1 `allocateSectsToShards` + §17.2 `seasonResults`）；**多 shard 运行时调度**（按人口开新区、跨区迁移玩家/宗门、行军/拍卖跨区隔离巡检）单列后续任务。

**分配触发时机**：新赛季 open 前（admin 操作），读上季 `seasonResults` + 当前 `sects`/`families`：

```
1. 采集 SectStrength[]：每宗门 { sectId, lastSeasonRank(从上季 seasonResults.ranking 查 scope==='sect'),
                                 memberFamilyCount, prosperity(成员家族聚合) }
2. shardCount = ceil(∑所有宗门成员人数 / WORLD_CAPACITY)   // WORLD_CAPACITY 默认 500（openSeason capacity 参数）
3. assignment = allocateSectsToShards(SectStrength[], shardCount)   // 蛇形均衡
4. 同宗门成员随 sectId 进同一 shard；散家族/散人按家族强弱补位（次轮）
5. 对每个 shardIndex 调 openSeason(`s{season}-{shardIndex}`, season, shardIndex, WORLD_CAPACITY)
```

**数据源缺口确认**（=天梯「战令依赖 RETENTION」同构）：在 `seasonResults` 落库（§17.5 ①）**之前**，G6 分配**无任何历史排名可读** → 首季所有宗门 `lastSeasonRank=undefined`（`sectStrengthScore` 给中位 500，纯按规模/繁荣度分配）；第二季起 `seasonResults` 提供历史。**这是为什么 §17.5 的排名落库是 G6 的硬前置**。

**新常量** `WORLD_CAPACITY = 500`（`shared/slg.ts`，替代 `openSeason` 硬编码默认；上限即 `SLG_WORLD_CAPACITY_MAX=500`）。

### 17.9 engineVersion pin（C7 / U9）

- `openSeason` 写 `WorldDoc.engineVersion = ENGINE_VERSION`（`@nw/engine` 导出，§16.7）；`resetSeason` 重 pin（§17.6 ④）。
- `applySiege`/`runSiegeBattle`（`siegeEngine.ts`，§16.8）跑围攻前校验：`world.engineVersion === ENGINE_VERSION`？不一致 → log 警告（赛季中途引擎升级未重开区），**v1 仍按当前进程版本跑**（不阻断），但 `getSiegeReplay` 重播在版本漂移时标注「可能不一致」。
- **赛季中途升引擎的运维口径**：优先「赛季结束后再升引擎 + 重开区重 pin」；紧急修复须升级时，已落地 `SiegeDoc` 重播可能逐帧漂移（D0+P2 已知代价，U9）。

### 17.10 互不干涉契约自检（OVERVIEW §3，确认无需改动即合规）

逐写集合核对，证明 SLG 赛季重置/结算**天然不触碰天梯**：

| 操作 | 写集合 | 触碰 `saves.pvp.*`？ |
|---|---|---|
| `settleSeason` | world 库 `worlds`/`seasonResults` + meta `/internal/mail/system/send`（邮件，附件领取才入账，**不写 saves.pvp**）+ commercial.grant（coin，**不写 saves.wallet**） | **否** ✓ |
| `resetSeason` | world 库 7 集合 deleteMany + `families` updateMany + `worlds` | **否** ✓（养成/段位/coin/皮肤全在 meta saves，worldsvc 物理无连接） |
| 繁荣度/活跃累加 | world 库 `families.$inc` | **否** ✓ |

> **结论**：与天梯侧不同（天梯软重置就写在 `saves.pvp` 同档，须小心隔离），**SLG worldsvc 进程从不连 meta saves 库**——隔离是架构级保证，本节实现无需额外隔离代码。唯一共享触点 = 发奖（邮件/coin 经 meta/commercial 内部 HTTP），且都走「玩家领取才入账」或「commercial 权威」，不直写跨季资产（OVERVIEW §3.2/§3.3）。

### 17.11 测试要点

- **纯函数单测（always-run）**：`familyProsperity`/`decayProsperity`（边界 0/无活跃衰减）、`settleTier`（名次切档边界 1/3/10/11）、`sectStrengthScore`（新宗门中位/有历史）、`allocateSectsToShards`（蛇形均衡：各 shard 强弱总和差 ≤ 最强单体；同宗门不拆分）。
- **worldsvc e2e**：
  - settle 发奖一次性（同 `slg-settle` dispatchKey 重入不重复发，fakeMailClient 断言收件人 × 附件）；中原首府占领者材料 ×2。
  - settle 落 `seasonResults`（幂等 `_id`，重入不覆盖）；下季 G6 `allocateSectsToShards` 读到上季 rank。
  - reset 幂等（`resetting` 中途模拟崩溃后重调，最终各集合清空 + status=open + engineVersion 重 pin）；reset 前未 settle → `WORLD_CLOSED` 拒绝。
  - ~~建宗门繁荣度门槛（`PROSPERITY_TOO_LOW` 拦截不足者）~~ 已移除（2026-07-13，任何族长任何时候可建门）；繁荣度活跃累加（占领/围攻 `$inc activity`）。
  - admin 端点 X-Internal-Key 门控（无 key 401，有 key 通）；JWT 玩家调 `/admin/world/reset` 被拒。
  - **隔离回归**：settle/reset 后断言 meta `saves.pvp` 不变（OVERVIEW §3.1，跨进程 e2e 或桩断言 worldsvc 无 saves 写）。

### 17.12 DRAFT 数值 / 后续任务（待拍板/调参/单列）

- **数值（→ ECONOMY_NUMBERS §13-SLG 登记 + 经济模拟）**：`PROSPERITY_W_*`/`PROSPERITY_DECAY_PER_DAY`/`SECT_FOUND_PROSPERITY_MIN`；`SETTLE_REWARDS` 各档材料/皮肤量 + `CENTER_CAPITAL_MULT`；`sectStrengthScore` 权重；`WORLD_CAPACITY`/`RESET_DELETE_BATCH`。settle coin 若 >0 须经经济总预算批准（OVERVIEW §3.3）。**核验方法（怎么算「过没过」、判据、签字、登记）见 [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)**——这批数分 6 条轨道分流核（只有 `SETTLE_REWARDS` 动持久经济），不是笼统「跑一遍经济模拟」。
- **G6 运行时 ✅（2026-06-21，§20；转区/合区 ✅ 2026-07-16，§28）**：多 shard 实际开区编排（`allocateNextSeason`）、人口溢出开新区（`resolveShardForJoin`）、玩家 join 自动路由（宗门>家族>单随）、跨区隔离巡检（`patrolShardIsolation`）、赛季中个人转区+运营合区（§28）均已落地。剩赛季元数据下发（待 S11）。
- **SLG 战令增益（C6/G4，S8-8）✅（2026-07-01，全档完成）**：`hasBattlePass` 全四档已接线——① `trainTroops` 训练时长 ×0.8（+20%）；② `speedupTraining` / `speedupBuilding` 每币加速时长 ÷0.85（消耗 -15%）；③ **产率加成档**：`recomputeYield` 末尾 ×`BP_YIELD_MULT`=1.1（+10% 所有资源产率），`buildingsOverride` 路径同步透传 `hasBattlePass`；④ **额外结算奖励档**：`settleSeason` 结算后额外查 `{hasBattlePass:true}` 全列，对每名持有者发 `slg-settle-bp:{world}:s{season}`（`BP_SETTLE_EXTRA`：scrap 50 / lead 20 / binding 5），dispatchKey 幂等防重发；与天梯战令独立（OVERVIEW §2/§4）。
- **称号（C1）✅（2026-06-22 接线；2026-07-16 修正戳号/权重/i18n）**：`settleSeason` 发奖循环 best-effort 调 `meta.grantTitle`，经 `WorldMetaClient` → `POST /internal/title/grant`（metaserver）。**2026-07-16 修正**：此前发的是扁平 id `slg.champion`/`slg.top3`（不符 `slg.s{N}.{key}` 约定 → 权重 0、来源误判、无 i18n）；改为 `SETTLE_REWARDS.titleKey` + 结算时 `slgTitleId(season, key)` 戳赛季号，并补 `SLG_TITLE_WEIGHTS`（champion>top3）+ 三语 `title.slg.*`/`slg.settle.*` 文案。详见 [`TITLE_DESIGN.md §9`](TITLE_DESIGN.md)。
- **异常交易审计工单 ✅（2026-06-21，G7；ops 前端 + 自动处置补记 2026-07-16）**：检测层 + admin 审计队列 + ops 前端审计页 + 确认违规自动封禁（不含追缴）均已落地（§17.13）。G7 全部收口。
- **G5 视野系统 / G8 险地**：与赛季正交，各自专项（§15.2）。G5 已启动 → §18。

### 17.14 赛季自动结算（auto-settle，2026-07-16）

> 背景：§17.7 落地时 settle/reset/close 全走 admin 手动四段式（同天梯 §3.1「不自带定时器」）。用户拍板 SLG 侧改为**结算自动触发**（reset/close 仍手动——清图破坏性、需运维择时，与 G6 转合区一致）。

- **季钟字段**：`WorldDoc.settleAt?`（`= openAt + SLG_SEASON_DURATION_MS`，60 天，`@nw/shared/slg/prosperity.ts`，[可调→ECONOMY_NUMBERS §13-SLG]）。`openSeason`（含 reset 后 reopen 的 ⑤）写入，故大区回收/新季均获新钟。legacy 无 `settleAt` 的世界永不自动结算。
- **调度**：`scheduler.ts` 每 tick（2s）在 `autoSettleSeasons` 开时调 `processDueSeasonSettlement`——查 `{status:'active', settleAt:{$lte:now}}`（新增复合索引 `{status:1,settleAt:1}`，无到期项时零成本），对每个到期世界调 `settleSeason`（CAS 仅 active→settling、幂等；单区失败不阻断其余）。
- **边界**：只做 active→settling（发奖/落库/发称号），**不自动 reset/close**。开关 `NW_SLG_AUTO_SETTLE`（默认开；`=0` 退回纯 admin）。`getSeason`/`listWorlds`/admin 列表回带 `settleAt` 供 ops 展示「预计结束」。
- 测试：`season-ops.e2e.test.ts` auto-settle 用例（未到点不结算 / 到点结算一次 / settling 不重入）。

### 17.15 赛季推进静默失败 + ops 缺口修复（2026-08-10，生产事故）

> 用户报告：在 ops 上依次点了「结束当前赛季」（Settle）和「开启新赛季」（Open a new world），赛季奖励也正常收到了，但账号登录后依然进入旧地图。

**根因（两层）**：
1. ops「Open a new world」表单填了 `worldId`（沿用旧值或手滑）+ 新的 `season` 时，落到 `openSeason`（`worldsvc/src/season/management.ts`）的 Mongo upsert：`season`/`shard`/`mapW`/`mapH`/`capacity` 全放在 `$setOnInsert` 里——**这段只在真正插入新文档时生效**。命中已存在的 `worldId` 时是一次普通 update，`season` 字段完全不写，接口却仍返回 200 成功。生产实测：运营在已有的 `s1-0` 之外新填了 `worldId="s1-1"`、`season` 却仍填了旧值 `1`——虽然这次是插入新文档（不是 `$setOnInsert` 失效），但本质是同一类操作失误：ops 表单没有任何机制防止「新开的世界 season 号没有真正推进」，`getActiveSeasonNo()`（选 `open/active` 里 season 最高的世界）看到的最高 season 仍是 1，所有账号继续被路由回 `s1-0`。
2. 真正会推进 season 号的 `allocateNextSeason`（`worldsvc/src/season/shard.ts`，§20.4 雪花分片分配）**从未被 admin/ops 暴露过**——只能带 `X-Internal-Key` 直连 worldsvc 内部端口 `POST /admin/world/allocate`，运营完全不知道、也点不到。

**修复**：
- **`openSeason` 加显式守卫**（`management.ts`）：reopen 一个已存在的 `worldId` 时，若传入的 `season`/`shard` 和库里已有值不一致，直接抛 `SlgError('BAD_REQUEST', …)`，不再静默按 `$setOnInsert` 丢弃——同 season/shard 的幂等 reopen 仍然放行。
- **补齐 `allocateNextSeason` 缺的地图模板克隆**（`httpApi/admin.ts` 的 `/admin/world/allocate` 路由）：`allocateNextSeason` 内部按 shard 调 `openSeason` 建世界文档，但从不触发 `cloneActiveTemplateInto`——只有 `/admin/world/open`、`/admin/world/reset` 两条路由在 HTTP 层单独补了这一步（§24）。之前只能靠运维手动再补一次 `open` 调用侧面触发，现在 `/admin/world/allocate` 自己在每个新建的 worldId 上补齐克隆。
- **`allocateNextSeason` 正式接入 admin/ops**（此前完全没有代理链路）：`admin/src/clients/world.ts` 加 `WorldClient.allocateNextSeason` → `admin/src/service/world.ts` 加 `slgAllocateNextSeason`（审计 `slg.season.allocate`，新增 `AuditAction` 枚举值）→ `admin/src/httpApi/slgRoutes.ts` 加 `POST /admin/slg/season/allocate`（能力 `slg.season.manage`）→ ops `tools/ops/src/pages/slgSeason.ts` 新增「Allocate next season」卡片（Season + Capacity 两个输入框），放在「Open a new world」表单上方并注明后者只是补开单个分片/重开已关闭世界的低级接口，推进赛季一律走前者。
- **应急处理**：VPS 上直接调用内部 `/admin/world/allocate`（`season:2`）+ 补一次 `/admin/world/open` 触发模板克隆，生成 `s2-0` 并确认它成为新的 active season——玩家侧无需任何操作，下次登录自动路由到新图。

**测试**（`server/worldsvc/test/shard.e2e.test.ts`）：
- `openSeason` reopen 守卫：同 season/shard 幂等放行；season 不同 / shard 不同均拒绝且不修改已有文档。
- `/admin/world/allocate` 配合已激活的地图模板：断言新开的 worldId 在 `mapBaselineRows` 里真的拿到了克隆的行数据（不是只看 200/worldIds，那样测不出克隆有没有发生）。
- 顺带修了 `shard.e2e.test.ts`/`season-ops.e2e.test.ts` 里 `startHttpApi(...)` 测试夹具缺第 6 个参数 `mapTemplateSvc`（一直传的是 5 个参数，`mapTemplateSvc` 是 `undefined`）——`allocate` 路由过去从不touch这个依赖所以一直没暴露，这次修复引入的调用让它在测试里直接抛 `Cannot read properties of undefined`，顺手在两个测试文件里补了一个真实的 `MapTemplateService`（无激活模板时是安全 no-op）。
- **补记（同日）**：`server/admin` 层此前对整条 SLG 赛季生命周期（open/settle/reset/close/merge/allocate）**零测试覆盖**——`season-audit.e2e.test.ts` 只测异常审计工单流程，`FakeWorld` 把这几个方法全部桩成空操作。新增 `server/admin/test/season-ops.e2e.test.ts`（真实 Mongo）：逐方法断言转发给 `WorldClient` 的确切参数、返回值、写入 `auditLog` 的 `AuditAction`/`target`/`summary`；`slgResetSeason` 的「必须先 settle 才能 reset」409 守卫正反两个方向都覆盖；`slg.season.manage`/`slg.season.view` 两个能力的角色矩阵（support 都没有、viewer 只有 view、super 都有）。9 例全绿，admin 全量套件（10 文件 92 例）随之全绿。

**遗留**：ops「Open a new world」表单仍保留作为低级 escape hatch（重开已关闭的世界、单独补一个分片），没有删除，只是在 UI 文案上标注了优先用「Allocate next season」。

---

