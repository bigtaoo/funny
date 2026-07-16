# 称号系统设计（Title / 公开身份名片）— DRAFT

> **状态**：✅ **已实现**（2026-06-22，`META_TASKS.md S10-1～5` 全 ✅）。ranked 队列（S1-R）已落地；赛季结算（S11-SE-4）已接入称号授予。
> **机制权威 = 本文**。数值（段位首达金币）去 [`ECONOMY_BALANCE.md §2.3`](ECONOMY_BALANCE.md)；成就→称号映射机制基准见 [`ACHIEVEMENT_DESIGN.md`](ACHIEVEMENT_DESIGN.md)。

---

## 1. 定位

称号是游戏唯一的**公开身份名片**：玩家随处展示的「战绩标签」。

- **对外炫耀只走称号**（`ACHIEVEMENT_DESIGN §7` 已定）：成就墙纯自看不对外，对外身份一律靠称号。
- **统一身份容器**（2026-06-21 拍板）：称号是一个**独立的 titleId 集合**，聚合多来源（天梯段位 / SLG 赛季 / 成就 / 运营活动）。玩家**拥有一堆、佩戴其一**，可切换。
- **与经济解耦**：天梯段位首达金币（`ECONOMY_BALANCE §2.3`）是经济 faucet，仅首次发；称号是身份系统，授予规则独立（见 §4）。同一结算事件的两个 side-effect，逻辑分开。

---

## 2. 数据模型（复用现有结构，改动极小）

`SaveData`（`server/shared/src/types.ts`）新增一个**服务器权威**字段；佩戴复用已存在的 `equipped` 通用穿戴位：

```ts
// —— 服务器权威段（客户端只读，与 pvp/wallet 同性质）——
titles: string[];              // 拥有的 titleId 集合,服务端 $addToSet 授予,玩家改不了

// —— 客户端同步段（复用已存在的 equipped: Record<string,string>）——
equipped['title'] = titleId;   // 当前佩戴展示的 titleId
```

- `titles` 进**服务器权威段**：仅由 ranked 赛季结算 / worldsvc SLG 结算 / 成就 claim / admin 授予，玩家无法伪造。
- 佩戴走**已有 `SyncPatch`（`equipped`）**，零新写接口；服务端在 `PUT /save` 校验 **`equipped.title ∈ titles`**，否则拒绝/落回。
- 赛季峰值追踪：`pvp` 段加 `seasonPeakRank`（赛季内最高段位，赛季结算时读它授称号再清零）。
- **定义表**：`@nw/shared` 维护 `TITLE_DEFS: Record<TitleId, { weight: number; source; ... }>`（硬编码，同 `Achievement` 定义表风格），`weight` 即跨来源序的唯一来源（§6.1）。赛季类 titleId 按模板生成（`ladder.s{N}.{rank}` 共用同 `rank` 的 weight）。

---

## 3. titleId 命名 = `<来源>.<赛季?>.<key>`

**赛季快照类**（2026-06-21 拍板）把赛季编号编进 id；永久类不带赛季段。

| 来源 | 形态 | 例 | 永久性 |
|---|---|---|---|
| 天梯段位 | `ladder.s{N}.{rank}` | `ladder.s3.king` → "S3 王者" | 每赛季快照**该季峰值段位**一枚,永久留存 |
| SLG 赛季 | `slg.s{N}.{key}` | `slg.s2.tenwin` → "S2 十冠王" | 同上（`SLG_DESIGN §U3` 既有「十冠王」）|
| 成就 | `ach.{key}` | `ach.meteor_master` | **永久**,无赛季段 |
| 运营/活动 | `event.{key}` | `event.founder`（内测） | **永久** |

`rank` 取值与 `server/shared/src/ladder.ts` 的 `RankId` 同源（bronze…king，9 段）。

---

## 4. 永久性 = 赛季快照（拍板）

段位称号**按赛季快照**，不实时反映当前段位：

- **每赛季末**：按该季 `seasonPeakRank` 授予一枚 `ladder.s{N}.{peakRank}`，**一季最多一枚**（取峰值）。
- **掉段不丢**：称号一旦进 `titles` 即永久保留，赛季重置/掉段都不删除——历史可翻（「S1 黄金 / S2 钻石 / S3 王者」）。
- SLG 赛季称号同理（`slg.s{N}.*`）。成就 / 活动称号为**永久无赛季**。

> 与经济侧的区别（别混）：`ECONOMY_BALANCE §2.3` 首达金币**仅首次发**（控量）；称号**每赛季快照一枚**。两条逻辑独立。

---

## 5. 统一授予接口

meta 内部单点 `grantTitle(accountId, titleId)`：

- `$addToSet` 幂等 + 回推 `SaveData`（与成就金币「直接记账、不走邮件」同路径）。
- **若开启「自动佩戴最高/最新」**（§6），授予时若新称号等级高于当前佩戴位则一并更新 `equipped.title`。
- 四个来源都调它：
  1. **ranked 赛季结算**（meta）：读 `pvp.seasonPeakRank` → `grantTitle(ladder.s{N}.{peakRank})` → 清零峰值。
  2. **SLG 赛季结算**（worldsvc）：赛季奖励事件 → `grantTitle(slg.s{N}.*)`。
  3. **成就 claim**（meta）：**部分顶阶/标志性成就**额外授予一枚永久称号（见 §7）。
  4. **运营/活动**（admin 后台）：走类似补偿的审计路径手动授予 `event.*`。

---

## 6. 自动佩戴（拍板：自动佩戴最高/最新）

- 获得**更高等级**称号时自动换上，玩家无感即享炫耀；仍可在资料页手动改回任意已拥有称号。
- 「最高」= `weight` 最大；并列取**最新获得**（§6.1）。
- 新号**默认佩戴 `event.newbie` 起步称号**（2026-07-16 落地）：`makeNewSave` 建档即 `titles: ['event.newbie']` + `equipped.title = 'event.newbie'`；老号在 `GET /save` 惰性幂等补发（`grantTitleToPlayer`），故所有账号上线即拥有。`event.newbie` 为 T1（weight 1300），永远不会顶掉玩家已挣得的更高称号。

### 6.1 跨来源等级序（`weight` 数据驱动，2026-06-21 定）

**为什么按声望档分带、而非按来源分带**：若整源排序（如「SLG 整源 > 天梯整源」），纯 PvP 玩家的 `王者` 会被一个低阶 SLG 参与称号自动顶掉——体感很糟。改为**按声望档（T1…T6）交错**：每个称号定义带一个整数 `weight`，跨来源同档可比，自动佩戴 = `argmax(weight)`。

**单一序源**：每个称号定义在 `@nw/shared` 的 `TITLE_DEFS` 表里带 `weight: number`。序完全由该字段决定，`grantTitle` / 客户端 / 榜单全读同一字段，**不在任何地方写 source 比较逻辑**。

**weight 公式**：`weight = 档位基数(T*1000) + 来源偏移 + 档内序`。来源偏移仅用于**同档内**给确定性全序（避免并列），不表达「来源谁高」。

| 声望档 | 基数 | 天梯段位 | SLG 赛季 | 成就 | 活动 |
|---|---|---|---|---|---|
| **T6 传奇/唯一** | 6000 | — | 十冠王（连续赛季成就）/ 赛季占国第一门主 | 全成就集齐（元成就） | 内测创始 `event.founder` |
| **T5 顶级** | 5000 | 王者 king | 赛季冠军宗门成员 | 标志性顶阶（如全章节三星通关） | 大型赛事冠军 |
| **T4 高级** | 4000 | 宗师 grandmaster / 大师 master | 赛季高排名（占国前列） | 高阶里程碑（满阶稀有条目） | — |
| **T3 中级** | 3000 | 星耀 star / 钻石 diamond | 赛季中排名 | 中阶里程碑 | — |
| **T2 进阶** | 2000 | 铂金 platinum / 黄金 gold | 赛季参与（达标即得） | 普通满阶 | 节日参与 `event.*` |
| **T1 基础** | 1000 | 白银 silver / 青铜 bronze | — | 入门里程碑 | `event.newbie` 起步 |

> 来源偏移建议：天梯 `+0`、SLG `+100`、成就 `+200`、活动 `+300`（仅决定同档并列时的稳定序，无声望含义）。档内序再 `+0…+9`（如天梯同档两段：钻石 3000，星耀 3009）。

**并列与新鲜度**：`weight` 完全相等时（极少，仅同源同档跨赛季，如 `ladder.s3.king` vs `ladder.s4.king` 都是 5000）取**最新获得**。`titles: string[]` 数组顺序即获得顺序（`$addToSet` 新元素追加末尾），故「最新」= **末位索引更大者**，无需额外时间戳。

**授予时自动佩戴算法**（`grantTitle` 内）：
```
grant(t):
  if t ∉ titles: titles.push(t)              // $addToSet
  cur = equipped.title
  if cur == null
     or TITLE_DEFS[t].weight > TITLE_DEFS[cur].weight
     or (weight 相等 且 t 在 titles 中索引更大):
       equipped.title = t                      // 自动换上更高/更新的
```
> 玩家手动改佩戴后，下次获得**更高 weight** 仍会自动覆盖（符合「自动佩戴最高」语义）；只有获得**同档或更低**的不抢佩戴位。

**段位称号跨赛季**：每季 king 是不同 titleId（`ladder.s{N}.king`）但同 `weight=5000`；获得 S4 king 时与在戴的 S3 king 并列 → 取新（末位索引大）→ 自动戴 S4。展示短标签拼当季 `S{N}`。

---

## 7. 成就 → 称号（拍板：部分里程碑发称号）

- **仅顶阶 / 标志性成就**额外授予一枚永久 `ach.*` 称号（如「陨石大师 III」「全章节通关」），让成就也能变成对外名片。
- 普通成就仍只发金币、纯自看（`ACHIEVEMENT_DESIGN` 不变）。
- 定义模型加可选字段即可支持：`Achievement.titleId?: string`（达成顶阶时 `grantTitle`）。
- 红线不破：成就仍**只发金币 + 称号，绝不发战力**。

---

## 8. 四处展示 + 下发链路（拍板：四处全展示）

每个 titleId 配 i18n **全称 + 短标签**两套文案（`title.<id>.full` / `.short`），赛季段运行期拼 `S{N}`。短标签用于前缀/名牌/榜（需限长，建议 ≤ 4 字）。

| 展示位 | 形态 | 下发链路 |
|---|---|---|
| **资料弹层**（必做） | 佩戴称号 + 可展开「称号墙」看全部 `titles` | meta `GET /internal/profile` 已回 `{displayName, publicId}` → **加 `equippedTitle`**（`archive/PROFILE_POPUP_PLAN` 链路）|
| **对战内名牌** | 对手名旁短标签 | 复用 `archive/PROFILE_POPUP_PLAN` 已建的 ticket→`match_start` opponent 身份链路 → 加 `opponentTitle` |
| **聊天名前缀** | `[王者] 昵称`（短,限长） | social 渲染消息时附 sender 的 `equippedTitle`（`SOCIAL_DESIGN`）|
| **排行榜** | 名字旁短标签 | 天梯 / SLG 榜查询 join `titles`（取 `equippedTitle`）|

---

## 9. 实现记录 / 遗留

- [x] `@nw/shared/src/titles.ts`：`TITLE_DEFS`（4条永久称号）、`grantTitle` 纯函数、`ladderTitleId`、`titleWeight`、`LADDER_RANK_WEIGHTS`
- [x] `@nw/shared/src/types.ts`：`SaveData.titles?: string[]`（服务器权威段）
- [x] `@nw/shared/src/ticket.ts`：`TicketClaims.opponentTitle?: string`
- [x] `server/metaserver/src/titles.ts`：`grantTitleToPlayer` DB 写帮助函数（`$addToSet` 幂等 + 条件 `$set equipped.title`）
- [x] `server/metaserver/src/accounts.ts`：`getProfile` 返 `equippedTitle`
- [x] `server/metaserver/src/service.ts`：`claimAchievement` 顶阶→称号；`getLeaderboard` 含 `equippedTitle`
- [x] `server/metaserver/src/ladderSeason.ts`：`settleSeasonForPlayer` → `grantTitleToPlayer(ladderTitleId(prevSeasonNo, peakRank))`
- [x] `server/metaserver/src/internal.ts`：`POST /admin/grant-title` 活动授予
- [x] matchsvc：`QueueEntry.equippedTitle` → `sign()` → `TicketClaims.opponentTitle`
- [x] gameserver：`match_start` proto field 8（tag 66）`opponentTitle`；`Room.Slot.opponentTitle`；`RoomManager.join` 透传
- [x] 客户端 `client/src/game/meta/titles.ts`：mirror TITLE_DEFS + `titleWeight`/`getTitleKeys`/`formatLadderTitle`/`highestTitle`
- [x] 客户端 `client/src/net/proto/transport.ts`：`MatchStart.opponentTitle` field 8 encode/decode
- [x] 客户端 UI：`ProfilePopup` 称号行 + `LeaderboardScene` 称号芯片 + `TitlesScene` 称号墙 + `StatsScene` 顶栏入口（原设置页入口已于 2026-06-27 迁移至生涯顶栏）
- [x] i18n zh/en/de：`settings.titles`/`titles.*`/`title.*` 全文案
- [x] **L2-2（2026-06-23）独立称号端点**（设计对齐，此前仅靠 SaveData 回推展示）：
  - `GET /titles` → `{ titles: {id, source, seasonNo?}[], equipped }`；`source`/`seasonNo` 由 `parseTitleId` 从 titleId 命名约定派生（与客户端展示同源）。**授予时间 grantedAt 不入库**（`titles` 仅存 id 顺序），故端点不返回 grantedAt。
  - `PUT /title/equip` body `{titleId}` → 仅允许已授予称号（未授予 403）；空串 = 卸下；写 `save.equipped.title` 并回推完整 `SaveData`。
  - `@nw/shared/src/titles.ts`：新增 `parseTitleId(titleId) → {source, seasonNo?}`（纯函数，服务端/客户端可共用）。
  - `openapi.yml` 登记两端点（operationId `getTitles`/`equipTitle`），客户端 codegen 重生（顺带修复了此前累积的 codegen 漂移，使 `openapi.ts` 与 spec 完全同步）。
  - 存储仍复用 `save.titles[]` / `save.equipped.title`（服务器权威，PUT /save 不可写此二字段），未引入新存储。测试 `metaserver/test/titles.test.ts`。
- [x] **新手起步称号自动发放（2026-07-16）**：设计早已定「新号给一枚 `event.newbie` 起步称号」但 grant 一直「实现期定」未接线，导致所有账号称号墙全空（`event.newbie` 只在 `TITLE_DEFS` 有定义，无任何调用发放）。本次补齐：
  - `@nw/shared/src/titles.ts` 新增 `STARTER_TITLE = 'event.newbie'` 常量（单一来源）。
  - `@nw/shared/src/types.ts` `makeNewSave`：建档即 `titles: [STARTER_TITLE]` + `equipped: { title: STARTER_TITLE }`（新号，零额外 DB 开销，原子）。
  - `server/metaserver/src/service/save.ts` `getSave`：在权威读取前 `grantTitleToPlayer(cols, accountId, STARTER_TITLE, now())` 惰性幂等补发（老号，自愈，无需运维脚本；沿用与 `migrateIfStale` 相同的「读时惰性」模式）。补发用 `grantTitle` 纯函数的自动佩戴算法，只在「未佩戴任何称号」时才自动戴上，绝不顶掉玩家已挣得的更高称号（king 等）。
  - 测试：`server/metaserver/test/starter-title.e2e.test.ts`（新号拥有+佩戴、老号补发+自动戴、不抢已挣称号、幂等 4 例）；更新 `titles.test.ts`（新号断言）、`internal-ladder.test.ts`（admin 授予后 titles 含 newbie）。**founder 仍走 admin 手动发放（运营活动），不自动发**。
- [x] **称号墙全目录展示（2026-07-16）**：`TitlesScene` 由"只列已获得"改为展示全部固定称号（`TITLE_DEFS` 4 条，含 event/achievement）+ 已获得的赛季称号；未获得的固定称号灰显 + "未获得"角标、不可点击。是否展示称号完全由玩家决定：点未获得称号无反应，点已获得未佩戴称号→佩戴，再点已佩戴称号→取消佩戴（允许不展示任何称号）。赛季（ladder/slg）未获得的档位不枚举穷举（无固定目录、且跨赛季组合会爆炸），只展示玩家已获得的动态称号。纯客户端改动：`client/src/game/meta/titles.ts`（新增 `allTitleIds`）+ `client/src/scenes/TitlesScene.ts` + i18n `titles.locked`/`titles.tapUnequip`；未触碰 `GET/PUT /titles` 端点或 `save.titles`/`save.equipped` 存储（`TitlesScene` 走 `saveManager` 本地状态，不走该 REST 端点）。展示形式由整行列表改为图标卡网格（勋章 glyph + 短/全称 + 状态角标，每行按可用宽度自适应列数），复用 Equipment/Achievement 等页已有的 icon-card 网格排布手法，纯 `TitlesScene.ts` 内部改动。
- [ ] 社交消息 sender 前缀（`[称号]`）— 待 S6 social 消息体扩展
- [x] **SLG 赛季称号授予（2026-07-16）**：worldsvc 赛季结算早已发称号，但发的是扁平 id `slg.champion`/`slg.top3`（不带 `s{N}` 段）→ `titleWeight`/`parseTitleId` 都不认（权重 0、来源误判 achievement）、无 i18n → 授而不显、不可排序。本次补齐端到端：
  - `@nw/shared/src/slg/prosperity.ts`：`SettleReward.titleId` → `titleKey`（'champion'/'top3'），结算时由 `slgTitleId(season, key)` 戳上赛季号 → `slg.s{N}.champion`；`server/worldsvc/src/season.ts` 授予改用戳号 id。
  - `@nw/shared/src/titles.ts`：新增 `slgTitleId()` + `SLG_TITLE_WEIGHTS`（champion 5500 > top3 4500，T5+/T4，占位待 launch 校准）；`titleWeight`/`titleShortKey` 按 `slg.s{N}.{key}` 的 key 段解析（未知 key 回落 T3 3500）；`parseTitleId` 原已识别 slg。客户端 `client/src/game/meta/titles.ts` 镜像同步 + 新增 `formatSlgTitle`（`getTitleKeys` 返回 per-key `title.slg.{key}.{full,short}`，4 处显示点无需改）。
  - i18n zh/en/de：`title.slg.champion.*`/`title.slg.top3.*` + 结算邮件 `slg.settle.*`（正文 `|rank=|nations=` 参数插值——顺带让 `FriendsScene/mail.ts` 的 `mailText` 支持 `key|k=v` 拆参传 `t(key, params)`，此前整串当 key 查找 → 结算邮件正文显示原始 token）。
  - 测试：`server/shared/test/titles.test.ts`（champion>top3、slgTitleId 往返）、`client/test/titles.test.ts`（镜像）。「十冠王」/连冠等更高阶 SLG 称号仍为设计意图，未落地。
- [ ] `equipped.title` 短标签限长 UI 截断（建议 ≤ 4 字，前端展示截断即可）
- [ ] 成就→称号具体条目清单（§7，与 ACHIEVEMENT_DESIGN 对齐）
