# Notebook Wars — SLG 大世界实现记录（SLG_DESIGN_LOG）

> 本文承接 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 锁定的核心设计，登记 §15 起按时间顺序追加的收尾清单/功能落地/实现记录/bug 修复；章节号延续主文档编号（§15 起），**不重新编号**，外部引用把文件名从 `SLG_DESIGN.md` 换成本文件即可定位到同一节。核心设计决策、契约、架构仍以 `SLG_DESIGN.md` 为准。

> **2026-08-17 拆分**：原文件 2011 行，已按「规格 / 时间」拆成下列分册，本文只保留 §15 收尾清单和索引。小节编号一律未变。

## 分册索引

源码注释里写 `SLG_DESIGN_LOG.md §N` 的，按 §N 落在哪个区间去对应文件：

| 小节 | 内容 | 文件 |
|---|---|---|
| §15 | 已知缺口 / 收尾清单（2026-06-20 盘点） | **本文**（下方） |
| §16、§18–§20 | **系统规格**：G3 围攻预布兵、G5 视野迷雾、G8 险地、G6 多 shard 调度 | [`SLG_LOG_SPEC_SYSTEMS.md`](SLG_LOG_SPEC_SYSTEMS.md) |
| §17 | **赛季规格**：大区赛季可编码实现（含 §17.15 赛季字段事故） | [`SLG_LOG_SPEC_SEASON.md`](SLG_LOG_SPEC_SEASON.md) |
| §21–§33 | 实现记录 2026-06-30 ~ 2026-07-22（含 §26 领地总览面板） | [`SLG_LOG_S21-S33.md`](SLG_LOG_S21-S33.md) |
| §34–§49 | 实现记录 2026-07-22 ~ 2026-08-01 | [`SLG_LOG_S34-S49.md`](SLG_LOG_S34-S49.md) |
| §50–§63 | 实现记录 2026-08-02 ~ 2026-08-04（含 §63 商店图标细节） | [`SLG_LOG_S50-S63.md`](SLG_LOG_S50-S63.md) |
| 日期式 | 2026-08-08 起，放弃顺序编号改用日期标题 | [`SLG_LOG_2026-08.md`](SLG_LOG_2026-08.md) |

> **写新记录放哪**：改的是「系统当前该怎么运作」→ 改 `SLG_LOG_SPEC_*.md` 的对应小节；记的是「某天改了什么、为什么」→ 追加到 [`SLG_LOG_2026-08.md`](SLG_LOG_2026-08.md) 末尾，用日期式标题、**不要再续顺序编号**（并行 worktree 会撞号，见 [`claudedocs/worktrees.md`](../../claudedocs/worktrees.md)）。

---

## 15. 已知缺口 / 收尾清单（2026-06-20 盘点）

> S8-0~S8-9 主干切片全部 ✅（地图/领地/行军/围攻/家族/宗门/拍卖/赛季/变现框架/客户端全量 UI）。本节盘点「设计已承诺、任务已标 ✅，但代码里仍空转或暂缓」的缺口，按"该不该补"分三档。盘点依据：逐函数核对 `worldsvc`/`shared` 实现与本文档 §2~§9 承诺。

### 15.1 第一档——已定义但没接通（最该补，目前是死代码/空转）

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| **G1** | **国民加成未生效** | `NATION_BONUS_PRODUCTION=0.10`/`NATION_BONUS_DEFENSE=0.15`（`shared/slg.ts`）仅 import、worldsvc 全程未使用；`resolveSiege` 与 `recomputeYield` 都不读 | 国家系统沦为「占国数计分牌」，对产出/战斗零影响，违背 SLG2 / §2.4「国民加成」 |
| **G2** | ~~**繁荣度系统是死字段**~~ ✅ **已落地（2026-06-21，§17.1/§17.4）** | `FamilyDoc` 补 `prosperity/prosperityUpdatedAt/activity`；`familyProsperity`/`decayProsperity` 纯函数 + 读时惰性衰减（`prosperity.ts`）；占领/围攻 `$inc activity` 并刷新；`SectDoc.prosperity` = 成员家族聚合；建宗门繁荣度门槛已移除（2026-07-13，见 §17.4）——任何族长任何时候可建门 | §8.1 繁荣度循环兑现；G6 分配基础数据就位 |
| **G3** | ~~**围攻反作弊判负翻转未启用**~~ ✅ **已由 G3-2b 解决（2026-06-21）** | 围攻重构为「服务器跑引擎权威即时落地」（§16/§16.8），从根上不存在「先信客户端再复算翻转」——客户端无战报上传通道，伪造无从谈起 | 承重墙 SLG11 兑现：关键战斗权威在 worldsvc 进程内 |
| **G4** | **养成统一的「材料流转」**（材料流转 ✅ **2026-06-21，§15.6**；战令增益仍延后） | `buildSiegeBlueprints(养成)` 注入装备/科技战力已通；PvE↔SLG 材料（scrap/lead/binding）经 **单一 `SaveData.materials` 池**贯通——PvE 产出 / 装备合成 / PvE 升级 / 拍卖行买卖（S8-5 `meta.deduct/grantMaterial`）全读写同池，赛季奖励经新增邮件 `kind:'material'` 附件入此池（§15.6）。**仍缺** 战令 `hasBattlePass` 增益效果（属 S8-8 战令专项，§17.12 待定） | SLG7/SLG8「养成统一」材料侧闭环已合；战令增益随专项 |

### 15.2 第二档——系统级整块缺失

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| **G5** | ~~**地图迷雾 / 侦察视野 / 宗门视野共享 / 盟友土地标记**~~ ✅ **四片全落地（2026-06-21，§18）** | G5-1 读路径门控 + G5-2 反向视野推送 + G5-3 客户端渲染（灰雾/友敌色/敌军显形）+ 联盟领地黄标（§18.7）全 ✅；共享降级为家族级（§18.1 V2）。scout 侦察行军（§18.8）+ 瞭望塔建筑（§18.9）全 ✅，V2 余项全部兑现 | §8.2 视野共享 + 盟友标记、§2.1 视野订阅核心战略玩法已兑现 |
| **G6** | **多大区 + 赛季分配规则**（数据地基+纯算法 ✅ **2026-06-21，§17.8**；**多 shard 运行时调度 ✅ 2026-06-21，§20**） | 数据地基：`seasonResults` 落库宗门排名 + 繁荣度快照（C2 闭）；`sectStrengthScore`/`allocateSectsToShards`（蛇形均衡）纯函数 + 单测。运行时（§20）：`allocateNextSeason` 编排开 N 区 + 落 `shardAllocations.familyShard`；`joinSeason`/`resolveShardForJoin` 自动路由（粘性>家族查表>最空开区>溢出开新区）；`patrolShardIsolation` 跨区隔离巡检。~~剩赛季中主动转区/合区（运营专项）~~ ✅ **已设计+落地（2026-07-16，§28）**；赛季元数据下发（待 S11） | 规模化数据/算法地基 + 运行时调度 + 赛季中迁移全部兑现 |
| **G7** | **admin 运营后台 SLG 接入**（赛季运维 ✅ **2026-06-21，§17.7**；商品价格可调 ✅ **2026-07-13**） | worldsvc `/admin/world/*` 迁出 JWT 改 X-Internal-Key（**C4 安全洞已堵**，任意玩家不再可清区）+ 新增 `GET /admin/world/list`；admin 后端加 `worldClient` + `POST /admin/slg/season/{open,settle,reset,close}` + `GET /admin/slg/worlds`（能力 `slg.season.view/manage`，reset 前必 settle 约束 + 审计）。**商品价格可调**（能力 `slg.shop.manage`）：`slgShopPrices` 集合 DB 覆盖 + 代码默认 fallback，worldsvc 轮询 admin 内部端点合并生效，ops `pageSlgShop` 面板可编辑 9 件商品（详见 OPS_DESIGN §4.2/§8） | S8-8 赛季运维 + 商城定价均兑现 |
| **G8** | ~~**险地（Stronghold）格子类型**~~ ✅ **已落地（2026-06-21，§19）** | 新增 `'stronghold'` TileType + `proceduralTile` 稀疏生成（~0.3%，比 familyKeep 稀疏 ~16×）+ `strongholdGarrison` 系统超强守军 + worldsvc `applyStrongholdSiege`（无主险地 PvE 围攻：权威引擎跑系统守军，攻克占为领地 + 一次性丰厚奖励，攻败残兵撤退）；occupy/sweep/落城/重生全拦截险地；契约 enum + 客户端渲染/交互/i18n。worldsvc 5 e2e | 高战略价值 PvE 格兑现（§3.1） |

### 15.3 第三档——DRAFT 数值 / 打磨

- 拍卖行与赛季解耦，无季末冻结/清算（原策略已废弃 2026-07-06，见 AUCTION_DESIGN §4.F）；国民加成/碾压级廉价结算具体数值待调参（§14.10 U6）。繁荣度建宗门阈值已拍板+核验（§14.10 U6 表 2026-06-22 拍板 / ECONOMY_NUMBERS §13-SLG-E 2026-06-30 核验闭环），不再计入本档待调参清单。
- 首府改名服务端已校验 ownerId；商城金币余额展示已接 SaveData 镜像。

### 15.4 收尾优先级建议

1. ~~**G1（国民加成）+ G3（判负翻转）**~~ ✅：「承诺了但空转」，先收口。
2. ~~**G5（视野系统）**~~ ✅：「加家族才守得住」留存逻辑的关键拼图，四片全落地（§18，含联盟黄标 §18.7）。
3. **G2/G4/G6/G8**：随对应经济/运营/规模化专项推进。~~G7~~ ✅ 全部收口（含 ops 前端 + 自动处置，2026-07-16）。

> **进度**：**G1 国民加成已落地（2026-06-20）**——见 §15.5。**G5 视野/迷雾四片全落地（2026-06-21，含联盟黄标）**——见 §18。**G7 异常审计 ops 前端 + 自动处置已落地（2026-07-16）**——见 §17.13。

### 15.5 G1 国民加成实现记录（2026-06-20）

- **shared**：新增纯函数 `nationDefenseStrength(garrison, inOwnNation)`（己方 Voronoi 区守军强度 ×(1+`NATION_BONUS_DEFENSE`)，否则原值；`Math.floor` 整数化、双端可算）。
- **归属判定**（无逐玩家国籍字段，v1 取「首府占领者即国民代表」）：瓦片落在「由瓦片主人自己占领的首府」的 Voronoi 区内 → 享加成。
- **生产加成**：`recomputeYield` 先取该玩家占领的首府集合（`nations.find({worldId, ownerId})` → `capitalIdx` Set），逐格 `nearestCapitalIdx` 命中集合则该格 `tileYield` ×(1+`NATION_BONUS_PRODUCTION`)；聚合后 `Math.floor` 保持整数产率。占领/放弃/围攻易主等所有改产率路径均经 `recomputeYield`，天然覆盖。
- **防御加成**：`applySiege` 围攻到点结算前，查目标格 Voronoi 首府，若 `nation.ownerId === defenderId` → 守军经 `nationDefenseStrength` 放大后再喂 `resolveSiege`。NPC 扫荡（`applySweep`）不享（无国籍）。
- **测试**：`worldsvc/test/nation-bonus.e2e.test.ts`（生产加成产率提升、防御加成抬高破城门槛、非己方区无加成）。

### 15.6 G4 材料统一流转实现记录（2026-06-21）

> SLG8「PvE 与 SLG 材料统一流转、可上拍卖行」的材料侧闭环。盘点（2026-06-20）时 G4 标「半截」；逐路径核对后实为**两条**：①拍卖行买卖——S8-5 已接（`auctionService` 经 `meta.deductMaterial/grantMaterial` 读写 `SaveData.materials`），无需补；②赛季奖励发材料——本刀修。

- **病灶（孤儿桶）**：养成材料统一池是 `SaveData.materials`（PvE 通关 `/pve/clear` 产、装备合成 `/equipment/craft` + PvE 升级 `/pve/upgrade` 耗、拍卖行买卖均读写它）。但赛季结算奖励（`SETTLE_REWARDS` 的 scrap/lead/binding）走系统邮件 `kind:'item'` 附件 → 领取经 `deliverMailGrant` 落 `save.inventory.items.{id}`——一个**无任何消费者**的泛用桶。结果：SLG 赛季产出的材料养成/装备/拍卖全读不到，材料流转断在「SLG→养成池」这一段。
- **修法（新增 `'material'` 附件类型，分桶直发统一池）**：
  - **契约**：`MailAttachmentKind`（shared `social.ts`）/ `MailAttachmentDoc`（`mongo.ts`）/ openapi `MailAttachmentView` enum 增 `'material'`；client `openapi.ts` 重生。`'material'` → `SaveData.materials`；`'item'` 仍 → `inventory.items`（刻意分桶，材料不混入泛用物品）。
  - **metaserver**：`splitAttachments` 多拆一个 `materials` 桶；`deliverMailGrant` 增 `materialInc` 形参，`$inc save.materials.{id}`；`claimMail` 透传 `split.materials`。`/internal/mail/system/send` 的 body 附件类型由 `CompAttachment[]`（仅 coins/item/skin）放宽为 `MailAttachmentDoc[]`（含 material）。
  - **worldsvc**：`settleSeason` 发奖材料附件由 `kind:'item'` 改 `kind:'material'`；`WorldMailAttachment` 类型同步加 `'material'`。
  - **客户端**：`attachmentLabel` 加 `material` 分支 + i18n `mail.attMaterial`（zh/en/de）。
- **测试**：`metaserver/social-mail.e2e`（内部直投材料 → 领取后 `save.materials.scrap=1000` 且 `inventory.items.scrap` 不增）；`worldsvc/season-ops.e2e`（断言改 `kind:'material'`）。`tsc -b shared metaserver worldsvc gateway commercial admin` + client `tsc --noEmit` 全绿。
- **未尽**：~~战令 `hasBattlePass` 增益效果仍空~~ **✅ 已实现（2026-06-22，S8-8）**：`trainTroops` hasBattlePass → 训练时长 ×0.8（+20%），`speedupTraining` → 每币加速 ÷0.85（-15%）；OPS 补偿工单若需发材料，`CompAttachmentKind` 可同样扩 `'material'`（随 OPS 专项）。

---

