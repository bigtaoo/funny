# Notebook Wars — SLG 大世界实现记录（SLG_DESIGN_LOG）

> 本文承接 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 锁定的核心设计，登记 §15 起按时间顺序追加的收尾清单/功能落地/实现记录/bug 修复；章节号延续主文档编号（§15 起），**不重新编号**，外部引用把文件名从 `SLG_DESIGN.md` 换成本文件即可定位到同一节。核心设计决策、契约、架构仍以 `SLG_DESIGN.md` 为准。

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

## 16. G3 围攻重构：预布兵自动战斗（SLG11 承重墙，2026-06-20 拍板）

> 用户拍板（2026-06-20）：**放弃手操**（不符 SLG 异步习惯 + 海量并发：一个玩家可同时进攻 5–6 个目标、到达错峰且常在离线时，逐场手操不可承受；且手操会用手速稀释「SLG=卖战力」定位）。关键围攻 = **双方预布兵的确定性自动战斗**；**服务器跑引擎算权威结果即时落地**，客户端凭 `seed + 双方布阵` 本地重播观战。本节是重构基准与分片计划，作废上一版「延迟落地/judge 复算/手操复盘」方案。

### 16.1 战斗模型（锁定）

- **兵力 = 单位血量（HP）**：每兵种按等级有满血容量（如 L3 盾兵 = 100）；布兵时给某单位分配 X 兵 → 它以 X 血出战（X ≤ 满血容量）；一支军队各单位分配之和 ≤ 携带兵力（行军预算）。**伤害**由兵种/等级定、**v1 不随兵力缩放**（兵力只决定耐久）。战后**残存血量折回兵力池**，阵亡兵力**永久损失** → 靠地图资源重新练兵（兑现资源 sink 闭环：资源→练兵→战损→再练）。
- **双方各有基地，破敌基地者胜**（沿用现有 `objective: destroy_base`）；**超时 / 同归于尽（双基地皆存）→ 进攻方负**（防守占优；含「两单位互射同归于尽、基地皆存」的特例）。
- **复用现有 12×18 双基地引擎**（PvP/campaign/netplay 同款）；唯一战斗改动 = 攻方从「实时出牌」改「开局预布兵」（攻方下半场预布、首 tick 起步推进，与防守方 garrison 同机制）。无 waves、无 live 指令 → 战斗由 `seed + 双方布阵` 唯一确定。

### 16.2 队伍与布阵（锁定）

- **5 支队伍**（前期上限）= 5 个可保存的**进攻布阵模板** + **并发上限**。点队伍直接进布阵编辑器；出征挂一支队，committed 兵力从池扣除，队伍占用至回师。
- **防守布阵**：点地图格 → 「布阵」选项 → 进该领地布阵编辑器；**可在任意盟军领地布阵**（互助协防，§4「代守」）。
- **布阵编辑器**：DefenseEditorScene 推广为通用半场布兵 UI（攻方半场 = 进攻队伍；守方半场 = 领地防守）；调色板取**已收集兵种**（U8）+ 每单位兵力分配滑杆（≤ 满血容量，总和 ≤ 预算）。

### 16.3 战斗接入与权威

- **Battle level** = 攻方预布军（下半场 owner0）+ 守方预布军（上半场 owner1，沿用 garrison）+ 双方基地 + `objective:destroy_base` + **时间上限**（DRAFT ~10min 游戏时间，安全网 + 算力封顶）。
- **worldsvc 跑引擎**（M12 §14.1「裁判」例外，设计允许）：import 确定性引擎 headless 跑到终局 → 权威胜负 + 真实残存血量 → `landSiege`（G3-1 已抽出）即时落地。代价 = worldsvc 绑 `engineVersion`（U9，赛季中途升级须 pin）。
- **算力**：单场约几千 tick、几十实体 ≈ 10–100ms CPU，可忽略；规模化用队列/worker 节流。
- **客户端**：收 `siege_result` + `seed + 双方布阵` → `ReplayInputSource` 本地重播观战（非权威，纯演出）。

### 16.4 分片（可独立验收）

- **G3-1 落地逻辑抽取（纯重构）✅（2026-06-20）**：`applySiege` 的写库块抽成 `landSiege(m, pw, target, defenderId, defender, res, t)`，行为零变化、e2e 全绿。judge/兜底/引擎三路共用此唯一落地点。
- **G3-2a shared + 引擎 ✅（2026-06-21）**：army layout schema（`GarrisonEntry.initialHp` 复用于攻守两军 + `LevelDefinition.attackerArmy`/`battleTimeoutTicks`，`levelSchema` 校验）；troops=HP（`Unit` 构造 `this.hp = min(initialHp ?? 满血, 满血)`，maxHp 恒为蓝图满血）；`buildSiegeBattle`（shared/slg.ts，**复用 `buildSiegeLevel` 守方规整 + 叠攻方军 + `battleTimeoutTicks`**；`buildSiegeLevel` 暂留供 worldsvc，G3-2b 再切换以守「不碰 worldsvc」）；引擎镜像 garrison 初始化到 `attackerArmy`（owner0/Bottom，首 tick spawn+move 向 `TOP_BUILDING_ROW`）+ 超时双基皆存判 owner1（防守方）胜；headless 跑通；**确定性 battle 单测**（`client/test/siege-battle.test.ts`：同布阵 + seed → 逐 tick 双基 HP 序列逐字一致；破基地 / 超时两路胜负；红线不破）。client tsc + 293 测试全绿、server tsc -b shared worldsvc 绿。
- **G3-2b-0 引擎抽包 `@nw/engine` ✅（2026-06-21）**：确定性模拟内核从 `client/src/game` 抽成独立 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式），worldsvc/gateway 直接 import；client 经 webpack alias + tsconfig paths + vitest alias 引 `../server/engine/src`，旧 `client/src/game/*` 留 27 个再导出 shim 保 client/测试逐字不变。详见 §16.7「实现记录」。**这是 G3-2b 的前半截**——做完后 worldsvc 接引擎、gateway 去 peer-judge 那跳自复算都顺理成章。
- **G3-2b worldsvc ✅（2026-06-21）**：承重墙合龙——worldsvc 直接 import `@nw/engine` headless 跑权威围攻。`applySiege` 关键战斗（攻领地/攻主城）改为「跑引擎 → 真实残存折兵力 → `landSiege`」即时落地；非关键 sweep/NPC 维持廉价 `resolveSiege`。详见 §16.8「实现记录」。
- **G3-2c 客户端 ✅（2026-06-21）**：5 队伍布阵编辑器（攻）+ 领地布阵（守，盟军可布）+ 出征挂队 + `seed` 重播观战；i18n。四阶段全落地——Phase 1 服务端+契约 / Phase 2 客户端编辑器+队伍 UI / Phase 3 重播观战改造 / Phase 4 删 judge 死路径，详见 §16.9。
- **删除 ✅（G3-2c Phase 4）**：S8-3b 的录像上传 / `getSiegeDefense` / `resolveSiegeWithJudge` / worldsvc→gateway `judge` 客户端复算路径（手操不再存在，引擎给真实残存）。
- **空闲队伍校验修复 ✅（2026-07-15）**：玩家反馈——配置 5 支队伍后，出征仍固定挂第一支队伍，即使那支队伍已在行军/占领中也照样再派，等同"抢占"而非报错。根因：`combatMarch.ts` 的 `startMarch` 只校验 `teamId` 对应的队伍存在且非空，从未检查该队伍是否已挂在一个非 `recalled` 的行军单（`marches` 集合）或占领倒计时（`occupations` 集合，ADR-037 §5.4）上——两者都是队伍"外出中"的持久化标记（前者行军途中，march 到点即 `findOneAndDelete`；后者胜后进 5 分钟占领倒计时）。修复：新增 `TEAM_BUSY` 错误码，出征前并发查询这两个集合，命中即拒（`server/worldsvc/src/combatMarch.ts`，`teams.e2e.test.ts` 两个新用例覆盖"行军中二次出征被拒→落地后恢复空闲"与"占领倒计时中二次出征被拒→倒计时结束后恢复空闲"）。客户端 `showAttackTeamPicker`（出征选队弹窗，唯一已接线的队伍挑选入口）据同一 `marches`（新增 `MarchView.teamId` 字段随行军单下行）灰显忙碌队伍并提示"行军/占领中"，避免玩家点了也白点。**范围说明**：占地弹窗（`showDeployDialog(...,'occupy')`）仍是纯兵力输入，未接队伍选择（见上文"客户端 UI 待补"一节）——本次只治好了"选中忙碌队伍会怎样"，没有新增占地选队入口。
- **队伍管理"取消指令"（强制回空闲）✅（2026-07-15）**：上一条把忙碌队伍锁死到行军落地/占领倒计时结束，但玩家没有主动解锁的手段——本次补上。行军中：沿用既有 `recallMarch`（撤军，兵力按已耗时间折返、全额退回，非即时——队伍到达原点才真正空闲），只是把入口从地图 HUD 行军列表挪到「队伍管理」（`TeamsScene`）里，与队伍卡片放在一起。占领倒计时中：新增 `cancelOccupation`（`server/worldsvc/src/combatSiege/occupation.ts`），**立即**原地释放队伍（删 `OccupationDoc`，即 `TEAM_BUSY` 门禁查询的同一张表）+ **驻守部队全部作废、不退兵**（与撤军的"全额退兵"刻意不同——没有"归途"可言，直接原地放弃）+ 目标格子的 `contestedBy/contestedUntil/contestedGarrison` 字段清空、退回无主状态（不判给取消者，也不留给任何人捡）。新路由 `POST /world/team/{teamId}/cancel-occupation` + `GET /world/occupations`（客户端此前完全不知道自己的占领倒计时列表，`WorldMapNet.ts` 的忙碌队伍灰显逻辑此前也只查过 `marches`，漏了 `occupations`——顺手一并修复）。`TeamsScene` 每张队伍卡新增状态标签（行军中/占领中剩 Xs）+ 对应按钮；占领的"放弃"按钮是二次确认（先变红瞪眼"确认放弃?"，3 秒内再点一次才真正执行——因为不退兵是不可逆操作），撤军按钮维持原单击（本就全额退兵，风险低）。`teams.e2e.test.ts` 新增用例覆盖：倒计时中途取消→队伍立即可接新单、兵力池不变（未退兵）、格子回到无主、重复取消报错。

### 16.5 数值调参记录（A7，2026-06-22）

**每单位兵力滑杆（DefenseEditorScene）**：

| 常量 | 值 | 含义 |
|---|---|---|
| `SIEGE_UNIT_HP_MIN_FRACTION` | 0.25 | 最低可出 25% 满血（= 省 75% 兵力） |
| `SIEGE_UNIT_HP_STEPS` | 4 | 四档：25% / 50% / 75% / 100% |

攻方布阵编辑器（attack 模式）点击已有同类型单位 → 兵力循环升档（100%→25%→50%→75%→100%...），底部显示 HP 分数条（比例段，占格宽）。守方布阵不暴露滑杆（防守不需要兵力配额管理）。

**Anna 侧三角色 PvP 卡牌（A6 遗留，A7 补录）**：

| 单位 | 卡 id | 费用 | 特性 |
|---|---|---|---|
| Max | max_1 / max_2 | 5 | burstOnSingle（末敌双倍） |
| Lena | lena_1 / lena_2 | 7 | armor 8（高平甲）|
| Mara | mara_1 / mara_2 | 5 | markEnemies（命中标记 +25%，持续 3s）|

六张卡加入 `CARD_DEFINITIONS`；i18n 三语全补（zh/en/de）。

**数值基准（不变约定）**：

- **生还折回**：战后各残存单位 HP 之和回兵力池（封顶 troopCap）；阵亡永久损失。
- **队伍兵力 vs 共享池**：队伍 = 布阵模板（含每单位兵力分配）；出征即从共享池扣 min(模板需求, 可用)；不足默认**拒发**（v1）。
- **伤害不随兵力缩放（v1）**；若平衡需要再议伤害/兵力联动。
- **时间上限**：围攻战斗 10 分钟（`SIEGE_BATTLE_TIMEOUT_TICKS = 10 * 60 * 30`，30 Hz），超时进攻方负。
- **满血容量表**：各兵种以 `UNIT_BLUEPRINTS[type].hp` 为满血，`SIEGE_UNIT_HP_MIN_FRACTION=0.25` 四档递增；险地/首府系统默认布阵沿用 §3.3「按等级派生」。
- **僵局兜底**：时间上限 + 超时攻方负（全盾兵 DPS≈0 等极端情形）。

**SLG DRAFT 数值拍板（§14.10 U6/U7，2026-06-22 拍板）**：

| 常量 | 值 | 说明 |
|---|---|---|
| `NATION_BONUS_PRODUCTION` | **0.10**（+10%） | 本国 Voronoi 区资源产出加成；适中，不破坏赤裸状态下的经济平衡 |
| `NATION_BONUS_DEFENSE` | **0.15**（+15%） | 本国 Voronoi 区防御 HP 加成；实战中约等于守军多出 1–2 单位，有感 |
| `SECT_FOUND_PROSPERITY_MIN` | **2000** | 建宗门繁荣度门槛；30人+30地≈1800基础，需约40活跃点（可达但有门槛） |
| `GARRISON_PER_TILE` | **500** | 每格驻军兵力（S8-1 拍板不变） |
| `SIEGE_CHEAP_RATIO` | **10** | 攻方兵力/守方有效驻军 ≥ 10 时跳过引擎走廉价 `resolveSiege`；U7「100:1 极端碾压」对应实际安全下限 |
| `SIEGE_BATTLE_TIMEOUT_TICKS` | **18000**（10 min） | 围攻硬时限；超时防守方胜（防守占优原则） |

`shared/slg.ts` 已同步（DRAFT 注释去除；`SIEGE_CHEAP_RATIO` 新增）。

### 16.6 引擎落地锚点（G3-2a 实现指引，2026-06-20 探查）

> 已摸清确定性引擎现状（`client/src/game/`，纯 TS 无 PIXI），G3-2a 据此实现，新会话不必重新探查。

- **棋盘**（`config.ts:22–39`）：12 列 × 18 行；owner0=下方（基地 row0，spawn row1）、owner1=上方（基地 row17，spawn row16）；战斗区 row2–15；攻击车道 col 0–4 / 7–11，基地列 5–6（不可攻）。
- **garrison 现成可镜像**（`GameEngine.ts:182–212` 构造预布 + `:480–498` 首 tick 发 `unit_spawned`+`unit_move_start`）：防守方（Top）单位已能中场预布 + 自动推进。**攻方预布 = 把这套镜像到 owner0/Bottom 半场**，不新建 director。`GarrisonEntry{unitType,col,row}`（`campaign/LevelDefinition.ts:159–173`）。
- **兵力=血量**：单位 HP 恒取 `blueprint.hp`（`Unit.ts:145–170`，`UNIT_BLUEPRINTS` in `config.ts:131–257`），无覆写口。→ 给布兵项加 `initialHp?`，构造改 `this.hp = initialHp ?? blueprint.hp`，其余战斗逻辑不动。
- **模式分支**（`GameEngine.ts:118–130`）：siege→`buildSiegeBlueprints(pveUpgrades)`；攻方现为 live 出牌（`:540–649`），改为预布后**无 live 指令**。
- **胜负判定**（`GameEngine.ts:750–867`）：先判 Bottom 基地 HP≤0→Top 胜；`destroy_base` 可带 `durationTicks` 超时。**改动点**：加战斗时限 → 超时（双基地皆存）判 owner1（防守方）胜。
- **headless 跑法现成**（`net/judgeRunner.ts:44–69,119–153`：`createGameEngine(config, ReplayInputSource)` + `while phase!==GameOver tick(1/30)`）：双方纯预布、喂空输入源跑到终局取 `winnerSide`。`maxTicks` 兜底防死循环。
- **不可破的确定性护栏**：`buildPvpBlueprints()` 无养成参签名（编译期硬墙，`test/hardwall.test.ts`）；PRNG 注入（`math/prng.ts`，三 seed XOR）；定点数 `Fp`（`math/fixed.ts`）；实体 ID 重置（`Unit.ts:7–17`/`Building.ts:8–17`，每局 reset）；金回放/`siege.test.ts` 确定性。

**G3-2a 改动清单**：①`LevelDefinition.ts` `GarrisonEntry.initialHp?` + `attackerArmy?: GarrisonEntry[]` + `battleTimeoutTicks?`；②`GameEngine.ts` 镜像 garrison 初始化到 `attackerArmy`（owner0，首 tick spawn+move）+ spawn 套 `initialHp` + 超时判防守胜；③`shared/slg.ts` `buildSiegeLevel`→`buildSiegeBattle`（双军+双基地+timeout）；④`levelSchema` 校验新字段；⑤`client/test` 确定性 battle 单测（同布阵+seed→同终局；破基地/超时两路；硬墙不破）。**只动引擎+shared+单测，不碰 worldsvc/客户端**（G3-2b/2c）。

### 16.7 引擎抽包 `@nw/engine`（G3-2b-0 设计，2026-06-21 拍板）

> **背景探查（2026-06-21）**：确认现状——确定性引擎只存在于 `client/src/game` 一份；服务端**无引擎副本**，worldsvc 围攻走 `@nw/shared` 的廉价公式 `resolveSiege`，gateway 的 `/gw/judge` 靠 **peer-judge**（挑在线玩家客户端跑 `judgeRunner` 回报 hash），引擎从不在服务端进程内运行。client 与 server **零代码共享**（手抄镜像 + openapi/proto codegen 对齐，client tsconfig 无 `paths`、webpack 无 `alias`）。引擎是最吃「两端逐字一致」（确定性）的逻辑，手抄镜像在此是定时炸弹 → 抽成单一来源包。

**目标**：worldsvc / gateway 能像 import `@nw/shared` 一样 import 引擎，headless 跑权威围攻 / 自复算比赛；从根上杜绝「未来出现第二份引擎」的确定性裂缝。

**方案：新 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式）**
- **服务端消费**：worldsvc / gateway 加 `"@nw/engine": "*"` 依赖，`tsc -b` 项目引用，CJS dist。零新机制。
- **客户端消费**：client 是独立 webpack 项目（无 workspace），经 **webpack alias + tsconfig `paths`** 把 `@nw/engine` 指向 `../server/engine/src`，ts-loader 直编源码进 bundle（不依赖 engine 的 CJS dist）。这是 client 的**首个跨边界桥**，net-new 但很小。

**边界划线（什么进包）**

| 进 `@nw/engine` | 留在 client |
|---|---|
| `config` / `math/*`（`fixed`/`prng`）/ `Card` | `meta/*`（SaveManager/SaveStore/ReplayStore 持久化） |
| `GameEngine` / `GameState` / `Unit`/`Building`/`Player`/`EscortUnit` | `net/NetInputSource`（联机传输，依赖 proto） |
| `systems/*` / `campaign/WaveDirector` / `LevelDefinition` + `levelSchema` | `campaign/maps/ChapterMap`（UI/i18n） |
| `balance/pveUpgrades`（三套 blueprints，**含天梯红线**）| `i18n` 本体；PIXI 渲染层全部 |
| `net/InputSource`（Local/Replay/Recording，纯逻辑）| `judgeRunner` 的 proto 解码外壳 |
| **新增 `runHeadless(seed, level, frames, source)`**（从 `judgeRunner` 抽出的引擎跑动核心）| — |

> `runHeadless` 吃**已解码输入**，proto 解码留各调用方边缘（client / gateway / worldsvc 各自把自己的 proto frames 解成统一形状再喂）——这就是让 **gateway 自复算** 与 **worldsvc 权威跑** 共用一条引擎路径的关键。

**三个已知坑**
1. **strict 不一致**：server base 开 `noUncheckedIndexedAccess` / `noImplicitOverride`，比 client 严。引擎进 server 包要清掉新报的索引/override 错（可能几十处）。**拍板：清干净**（引擎是命根子代码，不给 engine 包开宽松特例）。
2. **`TranslationKey` 外泄**：`types.ts` / `LevelDefinition.ts` type-only 引 `../i18n` 的 `TranslationKey` → engine 内降级为 `string`（显示用 key，模拟不关心），i18n 校验留 client。
3. **`engineVersion` pin（U9）**：engine 包打版本号常量，worldsvc 跑围攻 / 录像复算时校验，赛季中途升引擎须 pin。抽包时落进 `@nw/engine` 导出。

**验收**：`@nw/engine` 建包 + 迁移 + strict 清理后 → server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + 现有 293 测试（含 `siege-battle.test.ts` / 硬墙 / 金回放确定性）全绿 + `build:web` 通过——**测试逐字不变全绿 = 抽包行为零变化的证明**。完成后方启 G3-2b（worldsvc 接引擎）。

**实现记录（2026-06-21 落地）**
- **包**：`server/engine/`（`@nw/engine`，`package.json` + `tsconfig.json` composite/CJS dist，加入 `server/package.json` workspaces 第二位）。`server/engine/src/index.ts` barrel 导出公共面（`createGameEngine`/`runHeadless`/输入源/类型/枚举/定点工具/`GameState` type/`LevelDefinition` 全族 + `parseLevelDefinition` + `ENGINE_VERSION`），内部类（Unit/Building/Board/GameState 类/Player/EscortUnit）不进 barrel——深层消费（测试）走子路径 shim。
- **迁移**：`git mv` 27 个源文件进 `server/engine/src`（含 `math/` `balance/` `campaign/{LevelDefinition,levelSchema,WaveDirector}` `net/{InputSource,ReplayInputSource}` `systems/*`）。**留 client**：`meta/*`、`net/NetInputSource`、`campaign/{levels.ts+levels/*.json,maps/*,progress.ts}`、`game/index.ts` barrel、`net/judgeRunner.ts`。
- **client 接线**：webpack `resolve.alias`（`@nw/engine$`→`src/index.ts`、`@nw/engine`→`src/`，ts-loader 直编源码进 bundle）；`client/tsconfig.json` 加 `baseUrl`+`paths`（`@nw/engine`/`@nw/engine/*`）、`include` 加 `../server/engine/src/**/*`、**删 `rootDir`**（避免 TS6059 跨 root）；4 份 vitest config 各加 `resolve.alias`（rollup-alias 前缀匹配覆盖裸名 + 子路径）。旧 `client/src/game/<path>.ts` 留一行 `export * from '@nw/engine/<path>'` shim（27 个）→ client 应用代码 + 293 测试 import 逐字不变。
- **三坑**：①strict 实际只新报 5 处（Board `addBuilding`/`removeBuilding` 写格用 `!`、Card `tickTimers` 槽位判 `if(!slot)`、GameEngine `spawnEnemyUnit` laneLen 提取 const 收窄）；②`TranslationKey` 在 engine 两文件改本地 `type TranslationKey = string`，client 11 处消费点（createAppCore×3/GameRenderer/HandView/CollectionScene×2 + Set 改 `Set<string>` 收 2 处/DefenseEditorScene×2）`as TranslationKey` 再收窄；③`ENGINE_VERSION=1` 原就在 `types.ts`，barrel 显式再导出标注 U9 用途。
- **`runHeadless(config,input,maxTicks)`**：`server/engine/src/runHeadless.ts`，吃已解码 `GameConfig`+`InputSource`，建引擎跑 tick 到 GameOver/maxTicks，返回 `{ok,ticks,engine}` 供调用方读 `state.winner`/`snapshotStats()`；proto 解码留各调用方边缘。client `judgeRunner` 三路（netplay/pve/siege）改用之（去三份重复 tick-loop），由 `judge-runner`/`pve-judge` 测试覆盖证明等价。worldsvc 接入是 G3-2b。

### 16.8 worldsvc 接引擎（G3-2b 实现记录，2026-06-21 落地）

> **承重墙合龙**：worldsvc 成为史上第一个在进程内直接 import 确定性引擎、headless 跑权威围攻的服务端（M12「裁判例外」延伸）。关键围攻不再走廉价线性公式，而是双方预布兵确定性自动战斗的真实结果即时落地。

- **新模块 `server/worldsvc/src/siegeEngine.ts`**：
  - `synthesizeArmy(troops, role)`：把扁平兵力数铺成确定性 `GarrisonEntry[]` 布阵——默认步兵（满血 60 = 兵力当量），每单位 `initialHp ≤ 满血`（兵力=血量，§16.1），按 `ATTACK_LANES` 轮转铺开（attacker 从 row 1 升、defender 从 row 16 降）。这是**布阵编辑器（G3-2c）落地前的 v1 桥**：现行数据模型仍存扁平 `march.troops`/`tile.garrison`，编辑器接入后真实布阵从 `tile.defense`/`playerWorld.teams[]` 读，此合成退为「未设布阵」兜底。
  - `runSiegeBattle({attackerArmy,defenderConfig,tileLevel,seed})`：`buildSiegeBattle`（攻军+守军+双基地+时限）→ `parseLevelDefinition` 校验（P2，引擎侧 `levelSchema`）→ `runHeadless` siege 模式跑到终局/时限 → 读 `state.winner` 定胜负、累加 `board.units` 各侧存活 HP 定真实残存兵力 → 返回 `SiegeResolution`。winner=Bottom(owner0)=攻方破基地夺地。
- **`applySiege` 改造**：关键围攻调 `runSiegeBattle`（seed=`siegeSeedFromId(march._id)`，守方布阵 `buildDefenderConfig`——自定义 `tile.defense` 优先、否则按有效守军兵力合成；国民加成 v1 只作用合成路径）；坏布阵/引擎异常 try/catch 兜底回退廉价 `resolveSiege`，绝不卡死行军。`landSiege`（G3-1 唯一落地点）行为不变，新增 defender_win 时攻方残存撤退折回兵力池（§16.5；廉价兜底 survivors=0 时天然无回师）。**非关键 `applySweep`（NPC 扫荡）仍走廉价 `resolveSiege`**（§5.3）。
- **引擎侧两处小改**：①`@nw/engine` barrel 增导 `UNIT_BLUEPRINTS`/`ATTACK_LANES`/`BOARD_*`/`BOTTOM_SPAWN_ROW`/`TOP_SPAWN_ROW`/`UnitBlueprint`，让 worldsvc 合成布阵读「与引擎模拟同源」的棋盘几何 + 兵种 HP（不抄常量）；②`levelSchema.parseWaves` 放宽——siege 战斗（含 `attackerArmy`/`battleTimeoutTicks`）为纯预布无脚本波次，允许空 `waves.entries`（战役关仍要求 ≥1 波）。
- **engineVersion pin（U9）**：`runSiegeBattle` 喂 `ReplayInputSource` 空帧（纯预布无 live 指令），其构造按 `ENGINE_VERSION` 校验；worldsvc 随引擎版本重构建（D0+P2 代价）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` + 293 测试全绿（levelSchema 放宽不破金回放/硬墙/确定性）；worldsvc e2e（`siege.e2e` 6 + `nation-bonus.e2e` 4）改断言为「方向+结构效应」（易主/残存>0/减员）并按引擎真实断点重校准国民加成用例（同 march seed 下 820 兵破 500 守军、破不了加成后 575 → 反证加成来自国籍），全绿。引擎单场约几千 tick≈10–100ms CPU（§16.3）。
- **未尽（移交 G3-2c）**：①布阵编辑器写真实 `tile.defense`/`playerWorld.teams[]` 取代 `synthesizeArmy` 兜底；②自定义布阵的国民加成；③客户端 `seed+双方布阵` 重播观战（`siege_result` 带 seed/布阵）；④删 S8-3b 残留 judge/peer 复算路径（`resolveSiegeWithJudge`/`getSiegeDefense` 等，手操方案作废后无调用方时清理）。

### 16.9 G3-2c：闭合围攻闭环（分四阶段，2026-06-21 起）

> 围攻承重墙（引擎权威）已合龙，但玩家侧入口/观战仍缺。G3-2c 闭合「玩家定布阵 → 出征 → 看战斗」闭环。分四阶段，每阶段 tsc + 测试验证后提交。

**Phase 1 — 服务端数据模型 + 契约 ✅（2026-06-21）**

兑现 §16.8 未尽 ①②③的服务端半截（④留 Phase 4）。逐函数核对落地：

- **数据模型（`worldsvc/src/db.ts`）**：新增 `ArmyEntry`（GarrisonEntry 可序列化镜像：unitType/col/row/initialHp）、`TeamTemplate`（`{id,name,army}`）；`PlayerWorldDoc.teams?`（≤ `SIEGE_TEAM_CAP`=5 支进攻布阵模板）、`MarchDoc.army?`（attack 挂队时的攻方布阵快照，出征后队伍可改不影响在途军）、`SiegeDoc.{seed,attackerArmy,defenderConfig,tileLevel}?`（关键围攻持久化重播输入）。
- **队伍 CRUD（`service.ts`）**：`getTeams`/`setTeams`——保存时校验「≤5 支 + id 唯一 + 每支 army 过引擎 `levelSchema`」（`siegeEngine.validateAttackerArmy`，非法即整组拒不落库）。`GET/PUT /world/teams`。
- **围攻挂队**：`startMarch` 加 `teamId?` 参数——attack 挂队 → committed 兵力 = 队伍各单位 `initialHp` 之和（覆盖 body `troops`）、army 快照随 `MarchDoc` 落库；池不足默认拒发（`NO_TROOPS`，§16.5 v1）。`applySiege` 用 `m.army ?? synthesizeArmy`（真实布阵优先，合成退为兜底）。`POST /world/march` 加 `teamId`。
- **自定义布阵国民加成（item②）**：`buildDefenderConfig(target, effGarrison, inOwnNation)`——自定义守方布阵在己方首府 Voronoi 区时，各单位 `initialHp` ×(1+`NATION_BONUS_DEFENSE`)（`siegeEngine.scaleArmyHp`，引擎 Unit 构造封顶满血，故未满血单位受益；合成路径仍走 `effGarrison` 多铺单位）。两路各只施加一次加成。
- **重播观战（item③ 服务端）**：`landSiege`/`recordSiege` 持久化 seed + 双方布阵 + 格等级到 `SiegeDoc`（廉价兜底/NPC 扫荡 `replay=null` → 无重播）。`getSiegeReplay`——攻守双方可读（旁观者拒），用持久化输入 `buildSiegeBattle` 重建 `level`（含 `attackerArmy`），客户端凭同 seed 空 `ReplayInputSource` headless 重跑逐字复现。`GET /world/siege/{id}/replay`。
- **代守（盟军可布）**：`setDefense` 放宽——己方领地或**同家族盟军**领地（`sameFamily`，与 `computeMarchPath` 关隘通行盟友判定一致；盟友宗门待联盟系统）均可布防；并加保存期 `validateDefenseConfig` 校验。
- **契约**：`openapi-world.yml` 加 `ArmyEntry`/`TeamTemplate`/`SiegeReplayView` schema + `/world/teams`(GET/PUT) + `/world/siege/{id}/replay`(GET) + march `teamId`；`rest:gen` 重生 `client/src/net/openapi-world.ts`。**proto 无改动**（重播按 siegeId 拉取，`SiegeResult` 推送字段不变）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc e2e 88 全绿（新增 `teams.e2e.test.ts` 3 例：队伍 CRUD 校验 / 挂队 committed+快照+权威围攻+可重播 / 兵力不足拒发；既有 siege/nation/march e2e 不破）。

**Phase 2 — 客户端布阵编辑器 + 队伍管理 ✅（2026-06-21）**

兑现 §16.8 未尽 ①的客户端半截（玩家可视化编辑攻方布阵 + 出征选队）：

- **`DefenseEditorScene` 推广为通用半场 UI**：加 `target` 判别联合（`{mode:'defense',tileKey}` | `{mode:'attack',teamId,teamName}`）。攻方模式 = 下半场出兵行（`ATTACK_ROWS=[8..1]`，1=出兵行在底）、调色板只列单位（无建筑/无基地强化）、footer 显 committed 兵力。守方模式行为逐字不变（建筑行 + garrison 16..9 + 基地步进）。攻方 load 走 `getTeams` 找槽位 → `applyArmy`；save 走 `getTeams`→替换该槽→`setTeams`。
- **每单位兵力**：v1 每单位以**满血容量**出战（`initialHp = UNIT_BLUEPRINTS[type].hp` = 兵力当量，§16.1）；committed 兵力 = 单位数 × 满血。**每单位兵力分配滑杆暂缓**（§16.2 提及，列为后续打磨——当前靠「摆多少兵种」控制军队规模已闭环）。
- **`TeamsScene`（新）**：列 5 槽位（committed 兵力 / 空），点槽位进编辑器；槽位 id/名固定 `t1..t5`（v1 不做自定义命名）。`TEAM_CAP=5` UI 常量（服务端 `SIEGE_TEAM_CAP` 权威）。
- **`WorldMapScene` 出征选队**：围攻入口从「派兵数对话框」改为 `showAttackTeamPicker`——列可用队伍（含 committed 兵力）+「管理队伍」入口；选队 → `doMarchTeam`（`startMarch` 挂 `teamId`，troops=1 占位由服务端覆盖）。空队伍 → 引导去管理。主城菜单加「管理队伍」入口。
- **接线**：`WorldApiClient` 加 `getTeams`/`setTeams`/`getSiegeReplay` + `startMarch` `teamId`；`AppViews`/`app.ts` 加 `showTeams`；`createAppCore` 加 `goTeams`/`goTeamEditor`，`goDefenseEditor` 改传 `target`；i18n `world.team.*` + `world.teams` zh/en/de。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿；server 不动。

**Phase 3 — seed 重播观战改造 ✅（2026-06-21）**

兑现 §16.8 未尽③（客户端凭 seed + 双方布阵重播观战）：

- **`goSiegeReplay` 改纯演出**：从「跑 live 局 + 上传录像 judge 复算」（旧 S8-3b 模型）改为——拉 `getSiegeReplay`（seed + 双方布阵重建的 LevelDefinition）→ 构造 siege 模式空帧 `Replay`（无 live 指令）→ `views.showReplay` spectator 重跑，逐字复现 worldsvc 跑过的权威战斗。**无录像上传、无 judge**（引擎权威已在 worldsvc 落地）。攻守双方均可观战。
- **`ReplayScene` 推广**：构造加可选 `providedLevel` 参数——siege 重播的 level 含双方军（攻方 `attackerArmy` + 守方 garrison），不能由 campaign id 派生，直接传入；campaign 重播仍走 `getLevel(meta.levelId)`。endFrame = 战斗时限 + 余量（实际由 game-over 先停）。
- **接线**：`AppViews`/`app.ts` `showReplay` 加可选 `level`；createAppCore 去 `replayToUploadFrames` 死 import；`analytics.track('siege_replay')`。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

**Phase 4 — 删 S8-3b judge/peer 死路径 ✅（2026-06-21）**

兑现 §16.8 未尽④（手操方案作废后清理无调用方的录像 judge 复算路径）：

- **worldsvc service.ts**：删 `getSiegeDefense` / `siegeDefenseConfig` / `resolveSiegeWithJudge`（C2 复盘 + S8-3b 录像复算）；去 `buildSiegeLevel` / `WorldJudgeArgs` import（`buildSiegeLevel` 仍在 shared 内部供 `buildSiegeBattle`）。保留 `getSiegeReplay`（新）。
- **worldsvc gatewayClient.ts**：删 `WorldJudgeArgs` / `WorldJudgeResult` / `judge()`（interface + `HttpWorldGatewayClient` impl + `nullWorldGatewayClient` + 4 个 e2e fakeGateway 桩）——worldsvc 不再调 gateway `/gw/judge`（关键围攻已在进程内跑引擎）。gateway 服务端 `/gw/judge` 基建保留（PvP/netplay peer-judge 仍用）。
- **httpApi.ts**：删 `GET /world/siege/{id}/defense` + `POST /world/siege/{id}/resolve` 路由。
- **客户端**：`WorldApiClient` 删 `getSiegeDefense` / `resolveSiege` / `SiegeResolvePayload` + `SiegeDefenseView`/`SiegeResolveResult` 别名；`WorldMapScene.onReplaySiege` 注释更新为「纯演出观战」。
- **契约**：`openapi-world.yml` 删两路径 + `SiegeDefenseView`/`SiegeResolveResult` schema；`rest:gen` 重生。proto 无改动（`SiegeResult.replayRef` 字段保留为空，无害遗留）。
- **验收**：server `tsc -b shared engine worldsvc gateway` + worldsvc e2e 88；client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

> **G3-2c 四阶段全 ✅（2026-06-21）**：围攻闭环合龙——玩家可视化编辑攻守布阵、挂队出征、seed 重播观战，权威结果全程由 worldsvc 进程内引擎跑。承重墙 SLG11 至此完整兑现。剩 §16.5 DRAFT 数值调参（满血容量表/兵种当量/时限）+ 每单位兵力滑杆打磨。

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

---

## 18. G5 视野 / 迷雾系统（2026-06-21 拍板，§8.2 / §2.1 / §15.2 G5）

> 兑现「加家族才守得住」留存逻辑的关键拼图：服务端此前整图全可见（grep `fog/vision/scout` 零命中）。本节定基准并记录实现。**拍板（2026-06-21，用户）见下表**；G5-1 服务端读路径门控已 ✅。

### 18.1 五项拍板

| # | 决策 | 结论 |
|---|---|---|
| **V1 迷雾模型** | 永久黑雾 vs 战争迷雾 | **2a**：地形层（程序化、确定性）**全图始终可见**；动态层（归属/驻军/防守/保护罩/行军）仅当前视野内可见，视野外**退回 `proceduralTile` 底层地形**（连「已被占领」信号都不泄露——type 不返 `territory`/`base`）。不做持久化 explored-set 黑雾——地形不是秘密，机密是动态层。**资源图案（含等级细节）归地形层，全图始终可见（2026-07-07 拍板，见 §18.6 客户端渲染条）——原「视野外只显资源类型、隐等级」的收窄已作废。** |
| **V2 视野来源 + 共享** | 半径来源 / 共享到哪一级 | 己方领地半径 `VISION_TERRITORY_RADIUS=2` + 主城 `VISION_BASE_RADIUS=5` + 在途行军 `VISION_MARCH_RADIUS=2`（侦察行军价值）。**共享 = 家族级（≤30）**，复用 `sameFamily`/`familyMembers` 反查。**§8.2 字面「宗门级共享」降级为家族级**——宗门 900 人并集近乎整图，迷雾名存实亡；宗门/联盟只做领地颜色标记不并视野。`scout` 侦察行军 kind 已落地（§18.8，半径 `VISION_SCOUT_RADIUS=4`、不打不占自动回师）；瞭望塔建筑已落地（§18.9，`VISION_WATCHTOWER_RADIUS=8` 固定半径持久视野源）。 |
| **V3 计算/存储** | 实时算 vs 落库 | **实时算 + 短 TTL 缓存（缓存留后续），vision 零落库**（避 U11 规模爆炸）。视区半径有 `MAP_VIEW_MAX_RADIUS=40` 上限，计算量有界；源领地查询复用 `{ownerId}` 索引。 |
| **V4 推送门控** | 读路径门控 / 反向视野推送 | **v1 即做反向视野推送**（用户拍板，覆盖初版「仅读路径」建议）。工程化:反向查询**只在「行军发起 / 格易主」两个低频事件点做一次**（查路径沿途半径内有视野源的玩家 → 一次性推完整 `march_update`/`tile_update`，客户端在自己视野内的路径段渲染），**不逐 tick 反向扇出**（避 U11）。`under_attack` 仍无条件发防守方（§16 布阵预设=反应窗口）。→ G5-2。 |
| **V5 客户端表现** | 雾渲染 + 标记色 | 视野外铅笔灰雾半透明覆盖（手绘风，SketchPen 烘焙）、去动态层；标记色对齐「我蓝敌红」v0.3：自己=蓝、家族/同盟友=青/绿（第三友方色）、联盟宗门=黄描边标记（不共享视野，§8.2）、敌方=红、中立=纸面本色。→ G5-3。 |

### 18.2 视野原语（`shared/slg.ts`）

- 常量 `VISION_TERRITORY_RADIUS` / `VISION_BASE_RADIUS` / `VISION_MARCH_RADIUS`（DRAFT）。
- `VisionSource{x,y,radius}`；`isInVision(sources, x, y)`：Chebyshev（方形）距离判可见，纯函数双端可算。
- `marchInterpPos(fromX,fromY,toX,toY,departAt,arriveAt,now)`：行军当前位置线性插值（路径绕障故为近似，足够圈视野）。

### 18.3 分片

- **G5-1 shared 原语 + 服务端读路径门控 ✅（2026-06-21）**：见 §18.4。
- **G5-2 反向视野推送 ✅（2026-06-21）**：`startMarch` / 格易主（occupy/landSiege/relocate）做一次反向视野查询 → 给视野内观察者推 `march_update`/`tile_update`（敌方行军进我视野即推，V4）。见 §18.5。
- **G5-3 客户端渲染 ✅（2026-06-21）**：`WorldMapScene` 灰雾覆盖 + 友/敌标记色 + 视野内敌军渲染（含 server 侧 `ally`/`getMarches` 视野门控）。见 §18.6。
- **联盟（宗门）领地黄描边标记 ✅（2026-06-21）**：`WorldTileView.allySect` + `allySectMemberIds`（family→sect→allySectIds→成员链路），客户端金琥珀内描边；联盟不共享视野、仅标记（§8.2 V5）。见 §18.7。

### 18.4 G5-1 实现记录（2026-06-21）

- **shared**：§18.2 原语（`VISION_*` 常量 + `VisionSource` + `isInVision` + `marchInterpPos`）。
- **worldsvc `service.ts`**：
  - `computeVisionSources(worldId,accountId,x0,x1,y0,y1)`：视野源主人 = 自己 ∪ 同家族成员（`familyMembers` 反查；**注意 `occupyTile` 不写 `tile.familyId`，故不能靠 tile.familyId，必须按 `ownerId:{$in: 成员}` 取源格**）。源领地在视区按 `VISION_BASE_RADIUS` 外扩查询（半径外的领地照亮视区边缘）；`type:'base'` 给大半径、其余领地小半径；在途己方/家族 `marching` 行军按 `marchInterpPos` 插值当前位置 + `VISION_MARCH_RADIUS`。
  - `getMap`：建可见集 → 逐格门控。视野外 push `{...proceduralView, visible:false}`（隐去动态层 + 占领信号）；视野内 `{...tileDocView/proceduralView, visible:true}`。**profile 拉档仅对「可见的他人领地」**（视野外不显归属，省 meta 负载）。
  - `getTile`：同口径门控（视野外 `{...proceduralView, visible:false}`），防 getTile 绕过迷雾。
  - `WorldTileView.visible?:boolean`（仅 getMap/getTile 视区读填充；occupy 等单格响应不带）。
- **契约**：`openapi-world.yml` `WorldTileView.visible`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（G5-1 不动推送）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc **93 e2e**（新增 `fog.e2e.test.ts` 5 例：视野内动态可见 / 视野外退程序化地形隐占领 / getTile 同口径 / 家族共享远处领地 / 在途行军照亮路径 + 对照迷雾；既有 88 不破，因视野外退回 `proceduralView` 与原程序化默认逐字一致，且正向动态断言均落在请求者己方格=恒在视野）。

### 18.5 G5-2 实现记录（2026-06-21）

- **反向视野查询（`service.ts`）**：
  - `visionObservers(worldId, cells, exclude)`：找出视野半径罩住 `cells` 中任一格的「领地/主城主人」账号集（`type:'base'` 用 `VISION_BASE_RADIUS`、领地用 `VISION_TERRITORY_RADIUS`，Chebyshev）。在 cells 包围盒按 `VISION_BASE_RADIUS` 外扩查有主格，逐格判命中即收。**只在低频事件点调用一次（非逐 tick）**，避 U11 反向扇出爆炸。**v1 只取领地主人本人**（家族成员实时扇出留后续——他们经家族共享 getMap 轮询亦可见）。
  - `pushTileToObservers(tile, exclude)`：包一层，对单格变更推 `tile_update` 给观察者。
- **事件点接入**：
  - **行军发起 `startMarch`**：复用已算出的 `path`（A* 全路径，比直线包围盒更准）反向查观察者 → 推 `march_update`。守方（attack）已单独收 `under_attack`，连同行军主一起从观察者集排除（避重复）。`march_update` 载荷无 troops 字段——敌方观察者看得见行军路线/ETA/类型但**不知兵力**，合理的侦察信息粒度。
  - **格易主/新领地**：直占 `occupyTile`、行军到点占领、围攻 `landSiege` 易主、主动/被动迁城新主城——五处在原 owner/defender `pushTile` 之后加 `pushTileToObservers`（排除已单独推过的当事人）。增援不接（garrison 不在 `tile_update` 载荷，无观察者价值）。
- **关键修复（async 时序）**：观察者推送内含 DB 查询（`visionObservers` await），不能 `void` fire-and-forget——否则事件函数返回时推送尚未发出（owner 的同步 `pushTile`/`pushMarch` 不受影响，但观察者推送会丢）。五处 `pushTileToObservers` 与 startMarch 的观察者推送全部 **`await`**，确保 `processDueArrivals`/`startMarch` 返回时推送已落。
- **契约**：proto / openapi 均无改动——`march_update`/`tile_update` 推送通道既有，G5-2 纯服务端逻辑（推送给更多收件人，载荷不变）。
- **验收**：server `tsc -b` 全绿；worldsvc **96 e2e**（新增 `vision-push.e2e.test.ts` 3 例：行军进观察者视野推 march_update + 远端不推 / 直占新领地推 tile_update + 占领者不重复推 + 远端不推 / 围攻易主对第三方观察者推；既有 93 不破——awaited 观察者推送不改既有 owner/defender 推送断言）。

### 18.6 G5-3 实现记录（2026-06-21）

> 客户端把迷雾「画出来」+ 友/敌正确上色 + 让 G5-2 反向推送的敌军真正显形。为正确性需配套两处小 server 改动（家族盟友领地原本会显示为敌色；`getMarches` 原只返己方行军，敌军推送后客户端 refetch 拿不到）。

- **server（小补）**：
  - `WorldTileView.ally?:boolean`——`getMap` 用家族成员集（`familyMemberIds`，从 `computeVisionSources` 抽出复用）标记「可见、非己方、同家族」的格。解决家族共享视野后盟友领地显示为敌色的正确性 bug（`tile.familyId` 占领不写，靠成员集判定）。
  - `MarchView.mine?:boolean` + `getMarches` 扩展：己方行军（mine:true）+ **视野内的非家族敌方在途行军**（mine:false，按 `marchInterpPos` 当前位置过 `isInVision`，视野源取全图 `computeVisionSources(0,mapW-1,0,mapH-1)`）。这是 G5-2 反向 `march_update` 推送在客户端「refetch-on-push」模型下真正显形的数据源。家族友军行军不计入（友方靠家族集）。
  - 契约 `openapi-world.yml`：`WorldTileView.ally` + `MarchView.mine`；`rest:gen` 重生。proto 无改动。
- **client `WorldMapScene.ts`**：
  - **灰雾（2026-07-07 调浅）**：`tile.visible===false` 的格画底层地形后罩一层 `FOG_COLOR=0xc9c2b2 @0.3` 浅暖纸灰（原 `0x6b6458 @0.4` 铅笔灰太深、进图几乎看不见，改浅色 + 30% 不透明的薄罩；地形可见、局势看不清，对齐迷雾模型 2a）；视野外不画等级点/城池图标/瞭望塔/联盟描边等动态标记（不暴露细节）。L1(`drawTileL1`)/L2(`drawTileL2`) 两级缩放同 α0.3；L3 远景仍走 `WorldMapRenderer` 内的底色变暗（另一路，未随此次调整）。
  - **资源图案（terrain，非动态层）一直全绘 ✅（2026-07-07 拍板）**：resType 属地形层，**迷雾不改变资源美术的绘制**——`drawTileL1` 无论视野与否都以 `drawResMotif(..., fogged=false)` 画**完整**资源图案（现为单张 per-level 图，`res_{resType}_l{level}`；早期的 abundance 数量复制/防御框/危险角等叠加已于 `2a85a917`、`5794b8ea` 移除，等级信息全由分级美术自身承载），浅灰雾罩画在 `Graphics` 自身多边形上、而资源图案是 `addChild` 的 sprite 子节点恒渲染其上，故雾罩不遮资源。**这偏离原迷雾模型 2a「视野外只显资源类型、隐等级细节」——2a 那条按用户拍板作废：资源（含等级）一直可见。** 历史：此前雾中传 `fogged=true` 只显单个 @0.35 淡化类型图案；更早还有灰雾块 `return` 早于资源绘制导致雾区资源不显。**反复：`0f26b4a7`（2026-07-07 晚）曾整体注释掉 `drawResMotif` 调用改用生态染色地表；`2026-07-08` 按用户「每格都画」拍板恢复调用（两端 `tileGraphics.ts`，`resourceDensity=1.0` 故整图铺满资源图案属预期，见 map-editor DESIGN.md）。**
  - **`parseTileId` tileId 格式**：tileId 全库为 `{worldId}:{x}:{y}`（`mainBaseTile`/`march.fromTile`/`toTile`/`tile_update.tile` 皆带 worldId 前缀，worldId 不含 `:`）→ **取末两段** 为 x/y。修复：此前 `split(':')` 取前两段，把 worldId 当成 x（→0），进图后地图中心落在 x≈0 而非主城 x → 视区整片在视野外（全灰雾、无主城、无资源），是「大地图不显示主城/资源」的根因（另配合上一条雾中资源渲染）。
  - **标记色**（沿用本场景既有「敌蓝我红」约定）：自己=红（`MINE_*`）、**家族盟友=绿（新 `ALLY_TINT/ALLY_BASE_TINT`，友方第三色）**、敌方=蓝（`ENEMY_*`）、中立=纸面。`tileColor` 加 `ally→绿` 分支（在 mine 之后、occupied 之前）。
  - **敌军行军**：march 箭头 `march.mine===false` → 统一敌色（蓝）+ 更粗描边 + 更大终点点，突出威胁；己方按 kind 上色。HUD 行军列表过滤为 `mine!==false`（敌方行军不可撤、不进列表）。
  - **行军动画（2026-07-12）**：此前箭头是全长静态直线，全程不变，占领/围攻是否真的"在路上"只能靠 HUD 倒计时文字判断。现按 `frac=(now-departAt)/(arriveAt-departAt)` 在起终点间插值出一个沿路径滑动的菱形兵力 token（朝向随行军方向），原满长直线降 alpha 保留为路线淡描，终点箭头保留但同样调淡。`WorldMapRenderer/fog.ts renderOverlay()` 计算插值；`WorldMapRenderer/lifecycle.ts update()` 在 `ctx.marches.length>0 && zoom<3` 时每帧重绘 overlay 驱动动画（无行军时不额外重绘，避免空耗）。
  - **地块操作弹窗放大 2 倍（2026-07-12）**：`showModal()`（占领/侦查/迁城/驻防/攻击等所有地块点击弹窗共用）尺寸整体 ×2——宽度上限 300→600、高度 140→280、标题字号 13→26、按钮高度 28→56、按钮字号 12→24；按钮间距用局部 `modalMargin`，不改共用 `MARGIN` 常量（避免连带影响训练面板等其他 UI）。
  - **弹窗再放大 1.5 倍 + 文字自动换行 + 迁城 3×3 前置校验（2026-07-12 二次修复）**：迁城确认弹窗（`world.relocateConfirm` 长文案）此前固定 600×280，长文案不换行导致溢出面板。`showModal()` 改为：宽度上限 600→900；文本改用 `txt(..., wordWrapWidth)` 换行；面板高度由内容动态撑开（`Math.max(CONFIRM_H*1.5, 实际文本高+按钮高+边距)`），不再固定裁切。同时补上迁城的 3×3 校验缺口——此前"迁城到此"按钮只检查被点格子本身类型，未检查完整 3×3 地基（ADR-025），导致对着实际放不下地基的格子也弹出确认框，点击后收到含糊的"该地已被占领"报错。`WorldMapInput.footprintFree()`（镜像服务端 `footprintFree`，用 `@nw/shared` 的 `baseFootprintCells`/`baseFootprintInBounds` + 本地 `tileCache` 判断地形/占用）现在前置校验整块地基，条件不满足时直接不显示按钮；万一客户端缓存过期导致仍提交到服务端被拒，`errorMsg()` 按服务端报错文案中的"3×3"关键字匹配出新 `world.err.footprintBlocked` 文案，不再复用含糊的 `world.err.occupied`。
  - **弹窗按钮多行换行（2026-07-18）**：己方地块菜单最多 6 个按钮（增援/驻防/瞭望塔/迁城/放弃/✕）挤在同一行时，单个按钮宽度过窄，文字溢出与相邻按钮的文字重叠。`showModal()` 现按最小可读宽度（150px）算出每行最多列数，超出的按钮自动换到下一行（面板高度按行数动态撑开）；每个按钮标签也改为按自身按钮宽度 `wordWrapWidth` 换行，杜绝任何按钮数下文字溢出邻格。
  - **点击选中相邻格子修复（2026-07-12）**：`render/isoGrid.ts` 的 `tileToScreen(tx,ty)` 把格子(tx,ty)的**中心**映射到投影坐标（见其注释），因此其精确反函数 `screenToTileF` 返回的连续坐标空间里，一个格子的真实范围是 `[tx-0.5, tx+0.5)`，不是 `[tx, tx+1)`。而 `screenToTile` 此前对反函数结果直接 `Math.floor`——只对"整数=左上角"的映射成立，对"整数=中心"的映射会把每次点击命中判定整体偏移半格（朝 tx/ty 增大方向），表现为点击某格却选中了它左上方（iso 屏幕坐标里 tx/ty 减小的方向）的相邻格。修复：`screenToTile` 改 `Math.floor(f.x + 0.5)`（即四舍五入），使命中范围重新对齐到以格子中心为界的 `[tx-0.5, tx+0.5)`。新增 `client/test/isoGrid-screenToTile.test.ts`（5 例：格心点击、偏心点击、菱形四顶点内侧点击、旧 bug 回归断言、相邻格无缝/无重叠边界）锁定该不变量；`visibleTileBounds` 的 floor/ceil 保持不变（那是视口覆盖范围的外接矩形计算，不需要精确到格，不受影响）。
  - 既有 `applyMarchUpdate`→`refreshMarches()` / `applyTileUpdate`→`loadMapViewport()` 的 refetch-on-push 通道不变——G5-2 推送触发 refetch，新 `getMarches`/`getMap` 门控返回视野内敌情，自动显形。
- **scout 行军**：已落地（§18.8，2026-06-21）。**瞭望塔**：已落地（§18.9，2026-06-21）——己方领地建固定半径（8）持久视野源。
- **验收**：client `tsc --noEmit` + **293 测试** + `build:web` 全绿；server `tsc -b` 全绿；worldsvc **97 e2e**（vision-push +1：`getMarches` 己方 mine:true / 视野内敌方 mine:false / 视野外不返回；fog 家族用例加 `ally:true` 断言）。

### 18.7 联盟（宗门）领地黄描边标记实现记录（2026-06-21，§8.1 V5 余项）

> §8.2「盟友不共享视野、仅地图颜色标记区分」：联盟宗门成员的领地**不并入视野**（看不见远处联盟领地），只在它**恰好落进请求者自身/家族视野**时打一个标记 → 客户端黄描边。与家族盟友（`ally`，绿色满涂、共享视野）正交且互斥。

- **server（`service.ts`）**：
  - `WorldTileView.allySect?:boolean`——可见、非己方、非家族、且归「本宗门联盟宗门」成员所有的格。
  - `allySectMemberIds(worldId, accountId)`：链路 `accountId → familyMembers → family.sectId → sect.allySectIds（≤2）→ 各联盟宗门成员家族 → 成员 accountId 集`。无宗门/无联盟 → 空集；不含自己/同家族（那些归 `familyMemberIds`）。**不参与 `computeVisionSources`**（联盟不照亮视野，仅标记）。
  - `getMap`：算 `allySect` 集一次；逐格 `allied = !ally && 可见他人格 && allySect.has(owner)` → 置 `allySect:true`（家族 `ally` 优先，二者互斥）。`getTile`/`occupy` 等单格响应不带（同 `ally`/`visible`，仅视区读填充）。
  - 每次 getMap 多 3~4 次小查询（familyMember/family/sect/成员家族+成员），V3 短 TTL 缓存仍列后续。
- **契约 `openapi-world.yml`**：`WorldTileView.allySect`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（标记走 getMap 读路径，不动推送）。
- **client `WorldMapScene.ts`**：`ALLY_SECT_BORDER=0xe6a817`（金琥珀）内描边（`px+1.5, TILE_PX-4`，1.5px）——刻意区别于首府星标/选区的亮黄 `0xffcc00`（满边+填充）。填充仍走 `tileColor`（联盟领地是他人占领格，底色保持敌色蓝，黄描边叠加区分「勿攻」）；视野外（fogged）不画描边。~~**联盟「禁止进攻/夺地」的战斗约束属联盟系统专项，非 G5 视野范围，不在本片实现**~~ **✅ 已实现（R-3，2026-07-02）**：`startMarch` attack 分支加友军拦截 `friendlyAccountIds`（自己 + 本家族 + 本宗门全家族 + 联盟宗门 `allySectIds`）→ 命中抛 `ALLY_TILE`（新错误码，403）。检查置于保护罩校验之前，故友军基地即便有保护罩也先报 `ALLY_TILE`。见 §21.2 R-3。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿；worldsvc **100 e2e**（新增 `alliance-mark.e2e.test.ts` 3 例：视野内联盟领地标 `allySect`、敌方/家族不标 / 联盟不共享视野远处仍迷雾不标 / 解盟后视野内他人领地不再标；既有 97 不破）。

### 18.8 scout 侦察行军实现记录（2026-06-21，§18.1 V2 余项）

> 把 §18.1 V2「scout 行军 kind」从「列 v2」兑现：新增**不打不占的侦察行军**——派少量兵到任意非障碍格（含敌方/中立/保护中/中心），沿途 + 抵达点照亮一片**更大**视野后**自动回师**。普通行军已是视野源（半径 2），scout 的差异价值 = 更深的视野半径 + 不触发战斗。

- **shared（`slg.ts`）**：`MarchKind` 加 `'scout'`；新常量 `VISION_SCOUT_RADIUS = 4`（DRAFT，> 普通行军 `VISION_MARCH_RADIUS=2`，「探得更深」）。
- **worldsvc（`service.ts`）**：
  - `MARCHABLE_KINDS` 加 `'scout'`；新 helper `marchVisionRadius(kind)` = scout→4 / 其余→2，`computeVisionSources` 在途行军视野源按此取半径（`getMarches` 的全图视野源同步生效，敌方 scout 进我视野亦显形）。
  - `startMarch`：新 scout 分支——无归属/中心/保护期限制（仅上方拦掉障碍地形），不设 `defenderId`（**不发 `under_attack` 预警**，侦察非进攻）。反向视野推送仍照常（敌方观察者沿路看得见斥候，载荷无兵力，合理侦察粒度）。
  - `applyArrival`：新 scout 分支 → `autoReturnScout(m,t)`：到点不打不占，自动生成一条 `kind:'return'` 返程腿（target→origin、原兵力、返程耗时 = 去程耗时对称近似），途中继续提供视野，到点 `return` 退兵回池。
- **契约**：`openapi-world.yml` 两处 enum（`MarchView.kind` + `startMarch.kind`）加 `scout`，`rest:gen` 重生 `openapi-world.ts`；`transport.proto` `MarchUpdate.kind` 注释补 `scout`（string 字段，无需重生 proto）。`WorldApiClient.startMarch` 的 `MarchKind = Exclude<MarchView['kind'],'return'>` 自动纳入 scout。
- **client（`WorldMapScene.ts`）**：`DeployKind` 加 `'scout'`；敌方格 + 中立/未知格菜单加「侦察」按钮 → `doScout(tx,ty)` **直接派 1 名斥候**（不走派兵数对话框，侦察讲究轻量、不锁大军）；行军箭头 scout=紫 `0x9b59b6`、HUD 图标 `🔭`。i18n `world.actScout` / `world.scoutSent`（en/zh/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + **293 测试** + `build:web` 全绿；worldsvc **103 e2e**（新增 `scout.e2e.test.ts` 3 例：侦察敌方格不占不发预警归属不变 / 视野深度 chebyshev≤4 可见 >4 迷雾 / 到点自动回师且全程不占地兵力归池；既有 100 不破）。

### 18.9 瞭望塔（Watchtower）实现记录（2026-06-21，§18.1 V2 最后余项）

> 把 §18.1 V2「瞭望塔建筑——固定半径持久视野源」从「列 v2」兑现：在**己方领地**花资源建塔，该格升级为**最大半径**（`VISION_WATCHTOWER_RADIUS=8` > 主城 5）持久视野源。区别于 scout（一次性照路后回师）：瞭望塔是**主动布点扩视野**的永久手段——「想看哪、就在哪建塔守着」。落库随 `TileDoc`（丢地即随格子消失，无单独退还），符合 V3「vision 零落库，但塔标记本身落库、视野仍读时实时算」。

- **shared（`slg.ts`）**：`VISION_WATCHTOWER_RADIUS=8`（DRAFT，最大视野源）；`VISION_MAX_RADIUS=max(全部视野半径)`（外扩查询 pad 统一用，须覆盖最大半径源以免漏照视区边缘）；`WATCHTOWER_COST={food:0,iron:2000,wood:3000}`（DRAFT，资源非金币——视野扩张是建造行为）。
- **worldsvc（`db.ts`/`service.ts`）**：`TileDoc.watchtower?:boolean`。新 helper `tileVisionRadius(t)` = watchtower→8 / base→5 / 其余领地→2，`computeVisionSources` 与反向 `visionObservers` 的静态源半径统一走它（两处 pad `VISION_BASE_RADIUS`→`VISION_MAX_RADIUS`，否则瞭望塔半径外的塔照不亮视区边缘 / 反向漏查塔观察者）。新 `buildWatchtower(worldId,accountId,x,y)`：校验己方领地（`TILE_NOT_OWNED`）+ 非主城（`BAD_REQUEST`，主城自带视野）+ 结算后资源充足（`INSUFFICIENT_RESOURCES`，不足不动地图）；扣 `WATCHTOWER_COST` → `$set tile.watchtower=true` → 推 `tile_update`（owner refetch 触发新视野下次 getMap 生效）+ `pushTileToObservers`（塔是可见结构，视野内观察者亦见）。幂等：已有塔直接返回视图、不重复扣费。`tileDocView` 透出 `watchtower`。
- **契约**：`openapi-world.yml` `WorldTileView.watchtower` + `POST /world/watchtower`（返 `WorldTileView`）；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（建塔走 REST，视野扩张走既有 getMap/tile_update 读推路径）。
- **client（`WorldMapScene.ts`）**：己方领地（非主城）菜单加「建瞭望塔」按钮（已有塔则隐去、改在标题显「🗼 已建瞭望塔」）→ `confirmWatchtower`（展示资源花费二确认）→ `doWatchtower`（建塔 → 刷新 me 资源 + 清 tileCache 整块重拉显形扩张视野 + toast）；地图渲染：可见格 `tile.watchtower` 画手绘小塔（米白塔身 + 深墨三角顶）。`WorldApiClient.buildWatchtower`。i18n `world.actWatchtower`/`hasWatchtower`/`watchtowerTitle`/`watchtowerConfirm`/`watchtowerBtn`/`watchtowerBuilt`（zh/en/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿 + 312 测试通过（1 例 `headless-nav` 因 S9 成就 stub 缺 `applyAchievementBadge` 预先失败，与本片无关）；worldsvc **141 e2e**（新增 `watchtower.e2e.test.ts` 6 例：建塔扣资源+置标记+视图透出 / 扩视野原迷雾远格建塔后可见且超半径仍迷雾 / 非己方拒绝 / 主城拒绝 / 资源不足拒绝不动地图 / 幂等不重复扣费；既有 135 不破）。

> **G5 视野/迷雾全 ✅（2026-06-21）**：读路径门控（G5-1）+ 反向视野推送（G5-2）+ 客户端渲染（G5-3）+ 联盟领地黄标（§18.7）+ scout 侦察行军（§18.8）+ **瞭望塔建筑（§18.9）**。「加家族才守得住」的视野维度**完整闭环**——地形全见、敌情藏雾、家族共享、侦察行军照路（含深探斥候）、瞭望塔主动布点固定视野、敌军进视野即现、联盟领地黄描边勿攻。V2 余项全部兑现。

## 19. G8 险地（Stronghold）实现记录（2026-06-21，§3.1 / §15.2 G8）

高战略价值 PvE 格补齐。险地 = 系统超强 NPC 驻守的程序化格，**不可直占/扫荡，只能围攻 attack 攻克**；攻克即占为领地（高产出 + 战略要点），并得一次性丰厚资源奖励。复用既有围攻确定性引擎（§16），无新战斗模型。

### 19.1 `@nw/shared`（`slg.ts`）

- **类型**：`TileType` 新增 `'stronghold'`。
- **生成**（`proceduralTile`）：在 `familyKeep` 之前判定（优先级更高）。**逐格哈希门** `rand2(x,y, seed^0x0555) > strongholdThreshold(0.997)` 且 `dr > strongholdMinDistRatio(0.25)` → `{ type:'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(...) }`。固定满级 + 带资源种类（攻克后产出丰厚）。**逐格 Bernoulli(p=0.003)**：全图 ~236 格中位（0.26%，CV 0.07、0% 零险地），孤立点、比 familyKeep（5.4%）稀疏 ~20×。⚠️ **不用平滑 value-noise**：300×300 图上低频噪声只 ~18 格点，`noise>阈值` 会让险地数种子间 0→6,436 剧烈波动并聚成大块 blob（详见 §19.5 + ECONOMY_NUMBERS §13-SLG-STRONGHOLD）。
- **数值**：`STRONGHOLD_GARRISON_PER_LEVEL=360`（满级 1800 兵力当量，远超 `GARRISON_PER_TILE=500`/`npcGarrison` 满级 600）；`strongholdGarrison(level)`；`STRONGHOLD_LOOT_PER_LEVEL=5000`（攻克一次性奖励，按格等级 × 资源种类）。**1800 守军经合成步兵 ≈60 单位（纵深 ~6），叠加攻方 ≤2000 兵 ≈67 单位（纵深 ~7）< 棋盘 16 行 → 正常规模权威引擎可跑**；仅鲸鱼级超大军（>5000 兵）溢出走廉价兜底。零充值玩家满兵也因防守占优（基地 + 超时判守方胜）几乎打不过，须养成强军（科技/装备布阵）方可攻克——兑现 SLG7 卖战力 / U7 碾压级 / §3.1「非常难攻占」。

### 19.2 worldsvc（`service.ts`）

- **`startMarch` 门控**：occupy 无主险地 → `TILE_OCCUPIED`（须围攻）；sweep 险地 → `TILE_OCCUPIED`（须围攻）；attack 放行**无主险地**（PvE，`defenderId` 留空 → 不推 `under_attack`，NPC 无预警）；落城（`joinWorld`/`relocateBase`）险地 → `BAD_REQUEST`；被动迁城重生候选格扫描跳过险地。
- **`applyStrongholdSiege`**（attack 到点，`applySiege` 顶部拦截「无主 + 程序化 stronghold」分支）：按格等级派生系统守军 `synthesizeArmy(strongholdGarrison(level),'defender')` + 高基地（`buildSiegeLevel` 按 tileLevel 派生），走权威 `runSiegeBattle`（坏布阵/异常 → 廉价 `resolveSiege` 兜底，replay=null）。
  - **攻克胜**：写 `territory` TileDoc（`ownerId`=攻方，`garrison`=残存折回，level/resType 沿用程序化）+ 一次性奖励并入攻方资源池（封顶 `RESOURCE_CAP`）+ `recomputeYield` + `applyNationChange`（首府格易主立国）+ `bumpFamilyActivity` + `recordSiege`（attacker_win，无 defenderId，replay 可观战重播）+ 推 `march_update`/`siege_result`/`tile_update` + 对视野观察者可见。
  - **攻克败**：攻方残存撤退回师折回兵力池（出征已扣兵，阵亡永久损失）；NPC 守军不持久（程序化层不落库，下次攻打重置满守军）；`recordSiege`（defender_win）+ 推送。防守方全程为 NPC，无掠夺玩家、无保护罩。

### 19.3 契约 + 客户端

- **契约**：`openapi-world.yml` `WorldTile.type` enum 加 `stronghold`；客户端 `openapi-world.ts` 重新生成（`npm run rest:gen`）。proto `type` 本就是 string 字段（非 enum），无需 proto 再生成。
- **客户端**（`WorldMapScene.ts`）：`TERRAIN_COLORS.stronghold=0x8a4a4a`（暗红石垒）；点击未占领险地 → 弹「险地」面板（围攻挂队 `showAttackTeamPicker` + 侦察 + 关闭，无直占/扫荡）；占领后转 territory 走既有 mine 分支。i18n `world.stronghold`/`world.strongholdHint` 三语（zh/en/de）。

### 19.4 测试

- `worldsvc/test/stronghold.e2e.test.ts`（5 例）：生成（满级 + resType + 守军 >500）/ 直占·扫荡拦截 / 落城拦截 / 攻克胜（大军 → 占领 territory + mine + 残存驻军 + 奖励到账 + sieges attacker_win 无 defenderId + siege_result/tile_update 推送 + territoryCount+1）/ 攻克败（不占领 + 残兵回师 + sieges defender_win + 无奖励）。全 worldsvc 套件 127+5 绿。

### 19.5 DRAFT / 后续

- ~~数值调参：`STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL` 待战力模拟细化~~ **✅ 战力模拟已补测 CLOSED（2026-07-16）**：见 §27。生成密度已定案（见下）。**✅ 生成密度已修复 CLOSED（2026-07-02，econ-sim 险地轨）**：原 `strongholdFreq=1/70` value-noise 在 300×300 图上只 ~18 格点，险地数种子间 **0→6,436**（CV 1.02，14% 零险地，聚成 blob 均值 862 格），占领发的持久 `binding` 在高数量种子破 A 轨 15% 稀释判据。**修复**：生成层换逐格哈希 `rand2(x,y,seed^0x0555) > 0.997`（`shared/slg.ts`，merge-first 已合 main），删 `strongholdFreq`。**修复后实测**：236 中位（197→282，CV 0.07、0% 零险地、0.26% 命中意图）、平均 blob 1.0 格（孤立点）、binding 稀释 max 世界×100% 占领仅 2.8% ≪ 15%——①②③全 PASS。守军/掠夺量本身 sane。详见 [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) §9 险地轨 + [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md) §13-SLG-STRONGHOLD。
- **攻克奖励材料 ✅（2026-06-21，随 G4 §15.6 落地）**：除单资源即时入袋，额外掉落养成材料 `binding`（`strongholdMaterialLoot(level)` 按等级线性，**DRAFT** `STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4`）——攻克胜经 `meta.grantMaterial` 发到 `SaveData.materials` 养成统一池（跨进程 best-effort，orderId=`stronghold_loot:{worldId}:{toTile}:{arriveAt}` 幂等），攻克败不掉。复用 G4 打通的材料通道，险地养成价值兑现。装备掉落仍待装备库 E2~E4。worldsvc `stronghold.e2e` 加掉落断言（胜掉/败不掉/orderId 幂等键）。
- 险地系统守军当前为合成步兵；后续可换更强兵种/自定义系统布阵 config（§16.5 满血容量表/兵种当量调参后）。

---

## 20. G6 多 shard 运行时调度实现记录（2026-06-21，§2.2/§17.8 收口）

> §17.8 只到「数据地基 + 纯算法」（`allocateSectsToShards` + `seasonResults`）。本节兑现 §17.12 单列的**运行时调度**：多 shard 实际开区编排、按宗门强弱均衡分配落库、玩家 join 自动路由（宗门>家族>单随）、人口溢出开新区、跨区隔离巡检。**契约前提（2026-06-21 拍板）**见 §20.1。

### 20.1 三项契约前提（消解 §17.8 鸡生蛋）

| # | 问题 | 结论 |
|---|---|---|
| **R1 sect 赛季作用域** | sects `_id=s:{worldId}:{TAG}` 赛季级，`resetSeason` 删 `sects` + unset `families.sectId` → 新赛季 open 时**无 sect 可分配**。 | 跨季持久社交单位 = **family**（`resetSeason` 保编制只清赛季态）。均衡分配在**上季 settle 时快照**，落 `shardAllocations.familyShard`（上季 familyId→本季 shardIndex），下季 join 时按账号上季家族查表路由。`allocateSectsToShards` 仍按 sect 强弱分配，但展开到**成员家族粒度**落库（同宗门家族同 shard）。 |
| **R2 分配输入数据源** | 上季 sect 成员家族名单 `seasonResults.ranking` 此前不记。 | `settleSeason` 扩展：sect scope 排名条目记 `memberFamilyIds`（settle 时 families 仍带 sectId，免二次查）。下季 `allocateNextSeason` 读上季 `seasonResults`（跨 shard）构造 `SectStrength[]` + 展开 familyShard。 |
| **R3 join 路由入口** | 客户端硬编码 `worldId`（`world:1:0`，格式都不对），无「按赛季选服」入口。 | 新增玩家端 `POST /world/season/join {season,x,y}` → 服务端 `resolveShardForJoin` 解析 worldId（粘性>家族查表>最空开区>溢出开新区）→ joinWorld。`PlayerWorldView` 加 `worldId` 字段回传解析结果（客户端据此进图）。`worldShardId(season,shard)=s{season}-{shard}` 统一 id 格式。 |

### 20.2 数据模型

- **新集合 `shardAllocations`**（world 库）`ShardAllocationDoc`：
  ```
  _id: `s{season}`          // 本赛季分配（下季 join 路由查表）
  season, shardCount, capacity
  familyShard: Record<familyId, shardIndex>   // 上季 familyId → 本季 shardIndex（同宗门家族同区；散家族补位）
  createdAt
  ```
  索引 `{season:1}`。`shardCount` 可因溢出**递增**（`allocateNextSeason` 写初值，`resolveShardForJoin` 溢出时 `$inc`）。
- **`SeasonResultDoc.ranking[]` 扩展**：sect scope 条目加 `memberFamilyIds?: string[]`（R2）。

### 20.3 `@nw/shared`（`slg.ts`）

- `worldShardId(season, shard) = `s${season}-${shard}``（id 格式权威，替客户端硬编码 + 与 `WorldDoc._id` 对齐）。
- `shardCountForPopulation(totalPlayers, capacity) = max(1, ceil(total / max(1,capacity)))`（§17.8 第 2 步抽函数，可单测）。
- 复用既有 `sectStrengthScore` / `allocateSectsToShards`（蛇形均衡）。

### 20.4 worldsvc（`service.ts`）

- **`settleSeason` 扩展**：sect scope 排名条目落 `memberFamilyIds`（复用已查的 `memberFams`，无新查询）。family/solo scope 不记（无需展开）。
- **`allocateNextSeason(season, capacity)`**（admin 编排开区）：
  1. 读上季 `season-1` 全 shard `seasonResults`；sect 条目 → `SectStrength[]`（`lastSeasonRank`=rank、`memberFamilyCount`=memberFamilyIds.length、`prosperity`）+ 收集每 sect 成员 familyIds。
  2. `totalPlayers` = 上季全 shard `familyMembers` 计数（首季无 → 0 → shardCount=1）。`shardCount = shardCountForPopulation(totalPlayers, capacity)`。
  3. `assignment = allocateSectsToShards(SectStrength[], shardCount)`（sect→shardIdx）。
  4. 展开 `familyShard`：sect 成员家族随 sect 进同 shard；散家族（上季有族无门）按**最少家族数 shard 补位**（确定性贪心，均摊）。
  5. upsert `shardAllocations` `s{season}`；对 `i∈[0,shardCount)` 调 `openSeason(worldShardId(season,i), season, i, capacity)`。
  6. 返回 `{ shardCount, worldIds, allocatedFamilies }`。幂等：openSeason `$setOnInsert` + alloc upsert，重调不重复建。
- **`resolveShardForJoin(season, accountId)`**（私有）：
  1. **粘性**：账号已在某 `s{season}-*` 有 `playerWorld` → 返回该 worldId（防跨 shard 双开）。
  2. **家族查表**：`shardAllocations[s{season}].familyShard[上季家族]` 命中 → `worldShardId(season, idx)`（须该 world 已 open/active 且未满；满则落溢出）。账号上季家族 = `familyMembers`（`s{season-1}-*` 内 accountId）。
  3. **最空开区**：`s{season}-*` 中 open/active 且 `population<capacity` 的最空者。
  4. **溢出开新区**：无可用 → `idx=shardAllocations.shardCount`（无 alloc 则 = 现有 world 数），`openSeason(worldShardId(season,idx),…)` + `$inc shardCount`，返回新 worldId。
- **`joinSeason(season, accountId, x, y)`**：`resolveShardForJoin` → `joinWorld(worldId,…)`；回传 `PlayerWorldView`（含 `worldId`）。`WORLD_FULL` 兜底再解析一次（并发满员重试一跳）。
- **`patrolShardIsolation()`**（admin 只读巡检）：扫描跨区泄漏 →
  - `crossWorldMarches`：`marches` 中 `fromTile`/`toTile` 前缀 ≠ `worldId` 的（行军引用他区格）。
  - `multiShardPlayers`：同 season 跨多个 `worldId` 有 `playerWorld` 的账号（双开）。
  - `orphanTiles`：`tiles._id` 前缀 ≠ `worldId` 字段。
  返回 `{ scannedWorlds, crossWorldMarches, multiShardPlayers, orphanTiles }`（各含 count + ≤20 样本）。纯读不改。
- **`getMe` / `joinWorld` 视图**：补 `worldId`（解析结果回传客户端，未进入时也带所查 shard）。
- **`openSeason` upsert 修复（顺带）**：原 `status:'open'` 同时写 `$setOnInsert` 与 `$set` → Mongo upsert 报 `Updating the path 'status' would create a conflict`（既有潜伏 bug，此前无测试跑 openSeason 真实 upsert 路径，G6 多 shard 开区首次密集触发）。修为 `status` 仅入 `$set`（首插 + 重开都置 open），`$setOnInsert` 留不可变初始字段。

### 20.5 契约 + 客户端

- **`openapi-world.yml`**：`PlayerWorldView` 加 `worldId: string`（join-season 回传解析 shard，客户端进图依据）；`npm run rest:gen` 重生成 `openapi-world.ts`。新端点路径不入 openapi（`WorldApiClient` 手写路径，仅 DTO 类型来自契约）。
- **`WorldApiClient`**：`resolveSeason(season): Promise<{worldId}>`（`POST /world/season/resolve`，**只解析不落城**，进图前拿 worldId）+ `joinSeason(season,x,y): Promise<PlayerWorldView>`（`POST /world/season/join`，解析+落城，读回 `.worldId`）。**两步分离**：客户端浏览地图须先有 worldId（`WorldMapScene` 用 `worldId` 拉图 + tile pick 时 `joinWorld` 落城），故进图走 resolve；落城仍走既有 `joinWorld(worldId,x,y)`（落城在解析出的同一 shard）。`joinSeason`=resolve+落城一体原语（自动落城/API 完整性 + e2e 覆盖）。
- **`createAppCore.ts`**：去 `worldId='world:1:0'` 硬编码 → `goWorldEntry` 先 `resolveSeason(CURRENT_SEASON)` 拿真实 `s{season}-{shard}` → `goWorldMap(worldApi, worldId)`；解析失败兜底 `s{CURRENT_SEASON}-0`。`CURRENT_SEASON` 暂客户端常量（赛季元数据下发待 S11 天梯赛季打通后接，§20.8）。

### 20.6 httpApi 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /admin/world/allocate {season,capacity}` | X-Internal-Key | `allocateNextSeason`，开 N 区 + 落 familyShard（admin 新赛季操作） |
| `GET /admin/world/patrol` | X-Internal-Key | `patrolShardIsolation` 巡检报告 |
| `POST /world/season/resolve {season}` | 玩家 JWT | `resolveSeasonShard` 只解析不落城（进图前拿 worldId） |
| `POST /world/season/join {season,x,y}` | 玩家 JWT | `joinSeason` 自动路由进区（解析+落城一体） |

### 20.7 测试（`shard.e2e.test.ts`）

- `shardCountForPopulation` / `allocateSectsToShards` 已有纯函数单测（§17.11）；本节加 `worldShardId`。
- **e2e（真实 Mongo）**：
  - allocate 首季（无上季 results）→ shardCount=1 + 开 `s{season}-0`。
  - allocate 次季：造上季两 shard `seasonResults`（两 sect 强弱差），断言 `familyShard` 同宗门家族同 shard + 蛇形均衡（强弱搭配）+ 开足 shardCount 个 world。
  - join 路由：①粘性（重 join 同 shard）②家族查表（上季同族两账号 → 同 shard）③散人最空开区 ④溢出（填满 → 自动开新区 + shardCount $inc）。
  - patrol：植入跨区 march / 双开 playerWorld → 巡检命中；干净库 → 全 0。
  - admin 端点 X-Internal-Key 门控（无 key 401，JWT 玩家调 allocate 被拒）。

### 20.8 DRAFT / 后续

- **散家族补位 + 单随路由**当前为「最少家族数/最空开区」确定性贪心；大规模下家族大小方差大时可换按成员数加权（待压测 U12）。
- **赛季元数据下发**：`CURRENT_SEASON` 客户端暂常量；待 S11 天梯赛季打通后由 metaserver 下发当前赛季号（SLG 赛季与天梯赛季是否同步另议）。
- ~~**跨区迁移（赛季中）**：本节只做 join 时一次性路由；赛季中主动转区/合区（人口骤降合并低活 shard）仍待规模化运营专项。~~ ✅ **已设计+落地（2026-07-16，§28）**：个人转区 + 运营合区。
- **`resolveShardForJoin` 单点**：高并发开服瞬时大量 join 经 worldsvc 单进程，与 U12 march 调度单点同源，规模化需选主/分片。

---

## 21. 剩余工作总览（2026-06-30 盘点）

> 核心循环已闭合：落城 → 看图(迷雾/视野) → 占资源点(惰性产出) → 练兵 → 编布阵 → 行军(A*绕障) → 围攻(worldsvc 进程内引擎权威即时落地) → 易主/掠夺/残兵折回 → 加家族连地共守 → 宗门/联盟/立国 → 拍卖行 → 赛季结算大比 → 多大区分配 → 重置。承重墙（SLG11）+ 留存发动机（守不住→加家族）+ 视野/迷雾（G5）+ 险地（G8）+ 国民加成（G1）+ 繁荣度（G2）+ 材料统一（G4）+ 多 shard 运行时（G6）+ 赛季运维（G7 大部）全 ✅。
>
> 本节盘点**循环跑通后仍欠的部分**，按优先级。逐函数核对 `worldsvc`/`shared` 实现 + §15 缺口表 + §17.12 后续清单得出。

### 21.1 第一档——功能洞（影响经济循环完整性）

> **✅ 本档已清零（2026-07-02）**：R-1（主城内政/建筑）+ R-2（资源格渲染）两个功能洞均已实现并合 main。经济循环完整性不再有代码缺口，剩余全是规则补漏（§21.2）/ 运营规模化（§21.3）/ 数值调参（§21.4）。

| # | 缺口 | 现状 | 计划 |
|---|---|---|---|
| ~~**R-1**~~ | ~~建筑 / 主城内政系统整块缺失~~ **✅ CLOSED（2026-06-30~07-02）** | ~~worldsvc 唯一「建筑」是瞭望塔；无资源/军事/城防建筑；`troopCap` 死值；graphite/sticker 空转。~~ **已实现并验证**：[`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md) **P1（server 刀 `7da7e891` + client 刀 `9febdba0`）+ P2（`bcb48a9c` wall/cabinet/academy）全合 main**。`biomeAt` 三分→四分给 graphite 地图 faucet；stickerShop 自产 sticker faucet；4 资源建筑产率乘数 + cabinet 仓储 + drillYard troopCap 成长 + desk 门控 + buildQueue 调度 + coin 加速。CityScene 端到端接通（`createAppCore`/`WorldMapScene` Enter Desk）。 | **✅ 完成**。`city-buildings.e2e.test.ts` **8/8 real-Mongo 全绿（2026-07-02）**——faucet+sink 闭环经实测证实。数值仍 DRAFT（终态=上线后实测对账，§21.4）。 |
| ~~**R-2**~~ | ~~资源格地图渲染未接入~~ **✅ CLOSED（2026-06-30，commit `b8b726c0`）** | ~~地图资源点仍是程序色块。~~ **已实现**：`resAtlasLoader.ts`（懒加载图集，色块兜底）+ `WorldMapScene.drawResMotif`（L1）= 母题加载 + 丰度轴（lv1→4 精灵成簇）+ 守备轴（lv4+ 栅栏 / lv7+ 桩 / lv8–10 红角）+ 10 级合成；5 母题全就位（2026-07-01）。 | **✅ 完成**（client `tsc --noEmit` 全绿 2026-07-02）。L2/L3 仍走色块占用层（按设计，非缺口）。 |

### 21.2 第二档——规则 / 体验补漏

| # | 缺口 | 现状 | 计划 |
|---|---|---|---|
| ~~**R-3**~~ | ~~联盟「禁止进攻/夺地」战斗约束未实现~~ **✅ CLOSED（2026-07-02）** | ~~§18.7 只做了黄描边标记；理论上能打盟友地。~~ **已实现**：`startMarch` attack 分支新增 `friendlyAccountIds`（自己 + 本家族 + 本宗门全家族 + 联盟宗门 `allySectIds`）拦截 → 命中抛新错误码 `ALLY_TILE`（403）。范围比原计划宽：不止联盟宗门，连本家族/本宗门也纳入（只挡联盟而放任同宗门互殴会自相矛盾）。检查置于保护罩校验之前。 | **✅ 完成**。`shared`+`worldsvc` `tsc -b` 全绿；新增 `alliance-attack.e2e.test.ts` **6/6 real-Mongo 全绿**（联盟/家族/同宗门基地 → ALLY_TILE；非联盟敌方过友军闸→PROTECTED；保护罩过期后进攻真启动；解盟后前盟友可打）。既有 e2e 无回归。 |
| **R-4** | **国民加成数值未调参** | G1 已落地（`NATION_BONUS_PRODUCTION=0.10`/`DEFENSE=0.15` 生效），但数值未过经济/战力模拟实测平衡。 | 随 §16.5 数值批次 + 经济模拟。 |

### 21.3 第三档——运营 / 规模化专项（赛季正交，可延后）

| # | 缺口 | 现状 |
|---|---|---|
| ~~**R-5**~~ | ~~赛季中主动转区 / 合区（人口骤降合并低活 shard）~~ | ✅ **已设计+落地（2026-07-16）**：§28，个人转区（`POST /world/season/transfer`）+ 运营合区（`POST /admin/world/merge`）。 |
| **R-6** | 赛季元数据下发 | §20.8：`CURRENT_SEASON` 暂客户端常量；待 S11 天梯赛季打通后由 metaserver 下发（SLG 赛季是否与天梯同步另议）。 |
| ~~**R-7**~~ | ~~异常交易审计 ops 前端 + 自动处置~~ | ✅ **已落地（2026-07-16）**：§17.13，ops 前端审计页 + 确认违规后自动封禁（不含追缴）。 |
| ~~**R-8**~~ | ~~商品价格可调后台~~ | ✅ **已落地（2026-07-13）**：G7，admin `slg.shop.manage` + ops `pageSlgShop`，见 G7 行 / OPS_DESIGN §4.2/§8。 |
| **R-9** | `resolveShardForJoin` / march 调度单点 | §20.8：高并发开服经 worldsvc 单进程，规模化需选主/分片（U12 压测后）。 |

### 21.4 第四档——DRAFT 数值（待经济模拟统一过一遍）

> **核验方法权威 = [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)**：定义这批数怎么核（6 条轨道：持久经济聚合 / 赛季资源 / 围攻 difficultySim / 分区方差 / 节奏可达性 / 运维容量）、判据、签字人、登记到 §13-SLG 的流程。下面只是清单。

- 繁荣度权重 `PROSPERITY_W_*`/`PROSPERITY_DECAY_PER_DAY`、建宗门门槛 `SECT_FOUND_PROSPERITY_MIN`；`SETTLE_REWARDS` 各档材料/皮肤量 + `CENTER_CAPITAL_MULT`；`sectStrengthScore` 权重；`WORLD_CAPACITY`/`RESET_DELETE_BATCH`；险地 `STRONGHOLD_*` 密度/守军/奖励；碾压级廉价结算阈值（U7）；围攻满血容量表/兵种当量/时限（§16.5）。
- **进度（2026-07-02）**：A/B/C/D/E/F 六轨均已过 econ-sim 核验（`server/tools/econ-sim/`，SLG_ECONOMY_CHECK §9，常量未动、终态待上线实测）。**险地轨已补建并跑出唯一实质缺陷**：`SLG_GEN.stronghold*` 生成参数使险地数种子间 0→6,436、聚成 blob、持久 `binding` 掠夺破 15% 稀释——建议生成层换逐格哈希（[§13-SLG-STRONGHOLD](ECONOMY_VERIFICATION_LOG.md)）。**这是 R-4 剩的唯一 actionable 项**：一个独立的 `@nw/shared` 生成修复（merge-first），非纯调参。
- settle 若发 coin（>0）须经经济总预算批准（SEASON_OVERVIEW §3.3）。
- 全部 → [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §13-SLG 登记后统一模拟调参。

### 21.5 优先级建议

1. ~~**R-1 建筑系统** / **R-2 资源格美术接入** / **R-3 联盟攻击约束**~~ **✅ 三者均 CLOSED（2026-07-02）**——功能洞档 + 唯一功能性规则缺口均已清（R-1: P1+P2 合 main + e2e 8/8；R-2: `b8b726c0` 母题渲染 + client tsc；R-3: `friendlyAccountIds` 友军拦截 + e2e 6/6）。**已无功能/规则代码缺口。**
2. **R-4 数值调参**：现在是最高优先剩项——city / 国民加成数值仍 DRAFT（§21.4），须经济模拟批处理，非代码洞。
3. **R-5~R-9**：运营/规模化，赛季正交可延后。

---

## 22. 宗门功能修复：worldsvc 家族镜像死集合清理（2026-07-01）

**背景**：P4 家族→socialsvc 迁移（2026-06-29）删除了 worldsvc 本地 `familyService.ts`（写入方），但 `sectService.ts`/`service.ts`（约 40 处调用点）仍在读写 worldsvc 自己的 `families`/`familyMembers` 集合（`db.ts` 旧定义）。由于没有任何生产代码路径再向这两个集合写入数据，**宗门创建/加入/退出/发言/联盟/罢免全部在生产环境静默失效**（族长权限检查恒 `NOT_IN_FAMILY`），同族视野共享、出生点找同族、A* 同族通行门、宗门长阵亡惩罚扇出、赛季结算按宗门聚合、G6 跨赛季分片分配也同样静默降级为「视同无家族」。详细排查过程见 `SOCIAL_SVC_DESIGN.md` §6「宗门功能修复」。

**修复方案**：删除 worldsvc 本地 `families`/`familyMembers` 集合（`FamilyDoc`/`FamilyMemberDoc` 类型一并删除），改为：

1. 家族身份/名册/族长权限查询 → worldsvc 通过 `WorldSocialsvcClient` 实时调 socialsvc 新增内部接口（`getMember`/`getFamiliesByIds`/`getFamiliesBySect`）。
2. 同世界内成员定位（视野共享/出生点/A*同族门/罢免惩罚扇出）→ 改用 `PlayerWorldDoc.familyId`（SS7 镜像）按 `worldId+familyId` 查询，不需要新集合。
3. `sectId` 归属 → worldsvc 仍是权威写者（宗门保留在 worldsvc，赛季级概念不变），但写回 socialsvc 的 `FamilyDoc.sectId` 镜像字段（新增 `POST /internal/family/:familyId/sect`），供客户端 `fam.sectId` 读到。
4. 繁荣度/活跃度 → 委托 socialsvc 新增的 `/internal/family/:familyId/prosperity/refresh`（worldsvc 只算 `territoryCount`）与既有的 `/internal/family/activity`（此前从未被调用）；赛季重置新增 `/internal/family/:familyId/slg-reset` 一次性清零。

**影响文件**：`server/socialsvc/src/{db,familyService,httpApi}.ts`、`server/worldsvc/src/{db,socialsvcClient,prosperity,sectService,service}.ts`、`server/worldsvc/test/sect.e2e.test.ts`（fixture 改用内存假 socialsvc client）、`client/src/scenes/SectScene.ts` + `client/src/app/createAppCore.ts`（恢复 `fam.sectId` 读取路径）、`client/src/net/WorldApiClient.ts`（`FamilyView` 补 `sectId?`/`territoryCount?`）。

**未变**：宗门本身（`SectDoc`/`sects`/`sectMessages` 集合）仍留在 worldsvc（SS6 不变）；家族身份/成员关系（谁在哪个家族）跨赛季保留在 socialsvc，不受 SLG 赛季重置影响。

---

## 23. 客户端「创建家族后未切换成员态」修复（2026-07-04）

**背景**：§22 迁移后，`PlayerWorldDoc.familyId` 被明确定义为「入世界时一次性写入的只读镜像」（`territory.ts` `joinWorld()` 注释：subsequent family changes are not written back，客户端应改读 `/social/family/mine`）。但客户端三处仍直接读 `WorldApiClient.getMe(worldId)` 返回的 `familyId` 来判断「是否已加入家族」：`app/nav/social.ts` 的 `loadSLGStatus()`（好友页「家族」tab）、`FamilyScene.ts`（家族主界面）、`SectScene.ts`（宗门界面）。凡是「先进过 SLG 地图（已产生 `playerWorld` 文档）、后创建/加入家族」的玩家，镜像永不刷新，三处 UI 全部卡在「未加入任何家族」，即使 socialsvc 一侧家族已建成。

**修复**：`WorldApiClient` 新增 `getMyFamily()`，直连 socialsvc `GET /social/family/mine`（权威实时数据，不经 worldsvc 镜像）；`listFamilies()` 改为委托它。上述三处调用点全部改用 `getMyFamily()` 判断家族状态，不再读 `getMe().familyId`。

**测试**：`client/test/world-family-status.test.ts` 钉住该契约——`getMyFamily()`/`listFamilies()` 的请求/返回行为，以及一条回归用例：模拟「`/world/me` 镜像未更新但 `/social/family/mine` 已知晓」的场景，断言 `getMyFamily()` 全程不会调用 `/world/me`。

**影响文件**：`client/src/net/WorldApiClient.ts`、`client/src/app/nav/social.ts`、`client/src/scenes/FamilyScene.ts`、`client/src/scenes/SectScene.ts`、`client/test/world-family-status.test.ts`（新增）。

---

---

## 24. 地图模板与编辑器（2026-07-05 拍板；ADR-034 代码重写已完成 2026-07-05）

**背景**：`server/shared/src/slg.ts` 已按 ADR-034「角度扇区+地形+城池」模型整体重写（`provinceIdxAt()`/`provinceCapitalPositions()`/环形地形带+墨河弦+支脉/州府+世界中心+关隘城池+分级城池节点/按环等级分布表，替换旧的 `CAPITAL_FRACTIONS`/`NATION_KIND_BY_IDX`(hegemony→core)/`proceduralTile()`/`nearestCapitalIdx()`），worldsvc 受影响的消费方（`coreKernel`/`coreNation`/`coreYield`/`combatSiege`）与 e2e 测试已同步修完，`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+test 全绿。城池驻军/耐久数值、资源州/核心州分级城池梯度、`tools/map-editor` 编辑器工程本身仍是开放项，留后续任务（见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §5/§6）。本节继续记录地图存储/编辑器架构，供编辑器工程落地时遵循。

**两层分离**：
- **Layer A「地图模板」（设计期产物，低频改动）**：程序生成的原始地形/城池布局只是初稿，不一定符合要求，允许人工在编辑器里精修定稿——这是权威数据源，不是运行时状态。
- **Layer B「世界实例状态」（运行时，高频改动）**：占领/建筑/驻军等玩家行为，沿用现有的稀疏 `TileDoc` 覆盖机制（S8-0 起就有），只是覆盖对象要从「程序生成结果」改成「引用某个 `templateId` 的模板基线」。

**Layer A 落地方案**：
- 模板做成**按格子可寻址的集合**（类似 TileDoc 但用于模板而非运行时）。
- **首包生成走服务器端**：admin 加一个「生成模板」endpoint，内部按 size 跑 `proceduralTile()` 批量写入模板集合种子数据；`proceduralTile()` 之后只用于这个一次性种子生成，不再作为运行时合并路径。
- **编辑器工作流**：每次打开从数据库取最新地形（不是每次重新生成，也不是本地文件）；保存时**只上发本次改动的格子（diff）**，做 upsert，不整图重传。
- **多尺寸模板并存**（现 500×500，半年后可能 1000×1000/1500×1500）：模板集合按 `templateId`（含 size/版本）区分；一个 world 实例创建时引用某个 `templateId` 作为地图基线。
- **删除接口**：需要，但要挡一个安全检查——不能删除当前被设为「创建新世界用」配置的 `templateId`；已创建的历史世界实例不受影响（见下一条克隆语义），删除顾虑只针对「未来创建会引用」这一种。
- **关键：世界创建时对模板是"克隆"而非"实时引用"**：worldsvc 创建世界实例时把模板整份**拷贝**成该实例自己的基线数据，之后编辑器再改模板**不会回溯影响已经在跑的世界**（不会出现玩家脚下地形突然变化），只影响此后新建的世界实例。
- **编辑器需要「模板列表」接口**：按 size/templateId 选择打开哪一份模板，不能假设只有一份。
- **Endpoint 归属**：放 **admin** 后端（员工态工具面，非玩家态 meta REST），职责与 ops 后台一致。
- **并发编辑冲突不做锁**：内部工具、使用人少，接受"后保存者覆盖"的风险，暂不上锁机制。

**落地状态（2026-07-05，本节 endpoint 已实现）**：

- **数据**：模板归属 worldsvc 自己的库（`mapTemplates` 元数据 + `mapTemplateTiles` 逐格），不归 admin 库——admin 只做代理+审计，与现有 season ops（`WorldMixin` 代理 `/admin/world/*`）同一套路。`mapBaselines`（按 `worldId` 克隆出的世界基线）也建在 worldsvc。
- **worldsvc 内部 endpoint**（`X-Internal-Key`，`server/worldsvc/src/httpApi.ts` `/admin/world/map-templates/*` 分支，独立于 `worldId` 必填门禁）：`GET /admin/world/map-templates` 列表、`POST .../generate` 生成种子、`GET/PUT .../{id}/tiles` 读viewport/diff存、`POST .../{id}/activate` 设为创建新世界用、`DELETE .../{id}` 删除（激活中的拒绝）。业务逻辑在新增的 `server/worldsvc/src/mapTemplateService.ts`。
- **克隆时机**：`/admin/world/open` 处理完 `svc.openSeason()` 后，立即调用 `mapTemplateSvc.cloneActiveTemplateInto(worldId)`——没有激活模板时是空操作，不改变现有行为。
- **admin 代理**：`server/admin/src/service/mapTemplates.ts`（新 mixin，接入 `service.ts` 装配链）+ `httpApi.ts` 新增 `/admin/slg/map-templates/*` 路由（JWT + `slg.map.view`/`slg.map.manage` 两个新权限点，写操作全部走 `audit()`）。
- **已知限制，非本次范围**：
  1. `proceduralTile()` 目前仍硬编码 `SLG_MAP_W`×`SLG_MAP_H`（模块级 Voronoi 首府预计算），`generateTemplate()` 因此实际上只能正确生成当前固定尺寸；"多尺寸模板并存"在 schema/CRUD 层已经就位（`templateId`+`width`/`height`已入库），但要等 ADR-034 重写把 `proceduralTile` 参数化到任意尺寸后才能真正生成第二种尺寸。
  2. ~~`mapBaselines` 只是被写入，读取路径尚未接入~~——已接线（2026-07-06）：`WorldCoreMap.getMap`/`getTile`（`server/worldsvc/src/coreMap.ts`）在 TileDoc 未命中时先查该世界的 `mapBaselines`（键 `worldId:x:y`）作为地形基线，只有无基线行时才回退 `proceduralTile()`。`getMap` 沿用 viewport bbox 批量拉基线（与 tiles 拉取同形状，不走逐格查询）；`getTile` 单格 `findOne` 与 override 并行取。视野/迷雾门控不变（地形层从不被雾隐藏）。这样编辑器发布并激活的模板改动（画的河/山、移动的城池），经世界开局克隆后即在运行时地图可见。e2e 见 `server/worldsvc/test/map-template.e2e.test.ts`（已被克隆世界的改动可读回；无基线世界回退 `proceduralTile`）。art-parity 的 `obstacleKind`（river/mountain 美术区分）已随本次一并打通端到端：`MapTemplateTileDoc`/`MapBaselineTileDoc` 加字段，`mapTemplateService` 四处 doc 映射（generate/getTiles/saveTilesDiff/clone）+ `coreMap.terrainView` + `WorldTileView` + `openapi-world.yml`（含 worldsvc/client 两侧 codegen）全部带上；客户端 `WorldMapRenderer` 改为**优先用服务端 tile.obstacleKind**，只有服务端没给（无基线行）才回退本地 `proceduralTile`——修正了原先"障碍恒为程序化、无需过网"的假设（基线编辑后该假设不成立）。日后若再给 `MapTemplateTile` 增地形字段，按同一条链补齐即可。
  3. ~~编辑器前端（真正的地图编辑 UI 工具）尚未开工~~——已接线（2026-07-05，见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"栅格化 + 发布到服务端模板"/"模板列表 + Activate/Delete"）：`tools/map-editor` 新增 `src/api.ts`（Bearer token 登录）调用本节列出的全部 6 个 endpoint（list/generate/get-tiles 未用/save-tiles-diff/activate/delete）。编辑器侧的地形格子（2026-07-06 起河流/山脉是直接格子笔刷，不再是矢量路径——见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"矢量路径笔刷改为直接格子笔刷"）/城池图层通过 `server/shared/src/slg/mapEdit.ts::rasterizeMapEdits()` 一次性栅格化成 tile diff 再发布——单向烘焙，不做"从模板读回图层"的反向同步（模板存储不区分"原始生成值"和"编辑覆盖值"，物理上无法可靠反推）；模板列表面板目前只展示元数据（`getMapTemplateTiles` 的 viewport 读取暂未接线，非当前需要）。

---

## 25. WorldMapScene HUD 重排（2026-07-05 拍板+落地）

**背景**：现状底部 `HUD_H` 横栏把返回/缩放/状态文字/行军列表/Train/Family/Auction/World-info 全部平铺成一整条，纯文字堆砌、按钮风格不统一，且早期孤立据点视野内几乎全是空地，底栏又占满全部横向空间——判定为整体重排而非局部修补。

**新布局**（四区，取代原单一横栏）：

| 区域 | 内容（自上而下/自外而内） | 取代的旧元素 |
|---|---|---|
| 左上（浮层） | Back（`SceneHeader.drawFloatingBackButton`，`§3.1` 统一返回按钮迁移，2026-07-05 与本节并行落地）→ Zoom → Auction 竖排，后两者紧贴在 Back 下方 | 原 backRect（原底栏自绘）+ zoomBtnRect（原左上）+ aucBtnRect（原右下） |
| 右上竖排 | 状态卡（部队/领地/资源，卡片化分组）→ 行军角标（默认收起，点开展开列表）→ World/info | 原资源行文字平铺 + 常驻 Marches 表头/列表 + infoBtnRect |
| 底部 | 常驻聊天条（点击展开 FriendsScene 世界频道），也是家族管理入口 | 无（新增，原底栏无聊天入口） |
| 点击主城弹窗 | 进城 / **训练**（新增）/ 防御 / 编队 | 原 HUD 常驻 `trainBtn`（`openTrainPanel()` 改由此处触发） |

**拍板要点**：
- 左右分区心智模型：**左=离开当前视图去做别的事**（返回、缩放档位、拍卖行），**右=留在原地看状态**（部队/领地/资源/行军/世界信息）。
- **Family 按钮整体删除**——查证 `FriendsScene`（`orgForm.ts` `drawFamilyTab`）已有该逻辑：玩家已加入家族时自动 `cb.openFamilyHub?.()` 跳转到独立的 `FamilyScene`（成员/宗门内政管理）；未加入时展示创建/加入表单。即家族聊天 tab 本身就是家族管理的唯一入口，无需在世界地图额外开一个入口。
- **Train 从常驻 HUD 移除**，改挂到点击自家主城时已有的弹窗（`WorldMapInput.ts` 的 `isBase` 分支，进城/训练/防御/编队四项）——训练本就是主城行为，不该占永久屏幕面积。
- 地图空地问题（孤立据点四周大片空白）判定为**地图内容/装饰密度问题，非 HUD 布局问题**，本次不处理；若要改善需从中立地块程序化装饰密度或初始镶机位偏移入手，留后续任务。

**落地状态（2026-07-05，已实现）**：
- `client/src/scenes/worldmap/constants.ts`：`HUD_H` 100→56（底栏只剩聊天条，地图可视区相应变大）。
- `client/src/scenes/worldmap/WorldMapPanels.ts`：`renderHud()` 重写为四区绘制；`aucBtn`/`zoomBtn` 挪到左上、紧贴 `ctx.backRect`（读取其 y+h 做垂直接续，不硬编码坐标）；状态卡/行军角标改为卡片化子面板（`marchBadgeRect` 命中后走 `ctx.marchesExpanded` 布尔开关展开/收起列表）；底部聊天条渲染（当前只有静态文案，**末条消息/未读数预览仍是占位，未接数据**，留后续任务）。
- `client/src/scenes/worldmap/WorldMapInput.ts`：删 Train/Family 命中分支；新增 `marchBadgeRect` 切换 + `chatBarRect` 命中 → `cb.onOpenChat()`；`isBase` 分支弹窗加「训练」项直接调 `panels.openTrainPanel()`。
- `client/src/scenes/worldmap/WorldMapContext.ts`：`onOpenFamily` → `onOpenChat`；删 `famBtnRect`/`trainBtnRect`，加 `marchBadgeRect`/`chatBarRect`/`marchesExpanded`。
- `client/src/app/nav/world.ts`：`onOpenChat()` 调 `nav.goFriends({ defaultTab: 'world', onBack: () => goWorldMap(...) })`——返回时回到世界地图而非大厅。
- `client/src/app/nav/social.ts` + `client/src/app/appCtx.ts` + `client/src/scenes/FriendsScene/base.ts`：`goFriends`/`FriendsSceneCallbacks.defaultTab` 从 `'friends' | 'mail'` 放宽到完整 `Tab`（`'friends' | 'family' | 'sect' | 'world' | 'mail'`）+ `goFriends` 新增可选 `onBack` 覆盖（默认仍是 `nav.goLobby()`），使世界地图能指定"返回世界地图"而非硬编码回大厅。
- i18n 新增 `world.chat`（zh/en/de 三语）；`world.family` key 保留未删（其他场景仍可能引用，只是世界地图不再用它做按钮文案）。
- **跟 §3.1 撞车**：本节开发期间，另一次改动（commit `f3e237ce`）恰好也在同步把 WorldMapScene 的返回按钮从底栏自绘迁移到 `SceneHeader.drawFloatingBackButton`（统一 22 个场景的返回按钮规格），两者改的是同一批文件（`WorldMapContext.ts`/`WorldMapPanels.ts`）。两次改动语义不冲突（各改各的字段），已核对合并后 `tsc --noEmit` + `webpack --mode production` 全绿，未丢内容。
- **两个已知缺口已收尾（2026-07-05）**：
  - 聊天条接数据：`WorldMapNet.refreshWorldChat()`（新增，随 5s march 轮询一并调用，`worldApi.getWorldChannel(worldId, {limit: 20})`）把最新一条消息存到 `ctx.worldChatLatest`；未读数用客户端本地"已读水位"计算——`WorldMapContext.markWorldChatSeen()` 把 `worldChatLatest.ts` 写入 `localStorage`（key 按 `worldId+accountId` 隔离，避免多号共享已读位），点击聊天条（`WorldMapInput.ts`）时调用；`renderHud()` 显示 `发送者: 正文前28字` + 超过已读水位的条数角标（封顶 `9+`）。未走服务端已读接口，因为 worldsvc 目前没有为世界频道维护已读状态（对比 `mail.unread` 是服务端字段）——纯本地近似,足够 HUD 预览用途。
  - 行军列表数量上限：`renderHud()` 里加 `MAX_VISIBLE_MARCHES = 5`，超出部分显示 `+N more`（新 i18n key `world.marchMore`，zh/en/de 三语），面板高度按可见行数算，不再随行军数无上限增高。

**World-info 弹层（国家/商城 Tab）列表滚动（2026-07-13）**：

**背景**：`WorldMapPanels.renderInfoPanel()` 的国家 Tab（`ctx.nations`）和商城 Tab（`ctx.shopItems`）此前平铺渲染、面板高度写死，超出可视区的条目直接跳过渲染（`if (ly > bodyBottom) break`）——列表一长就看不到、也点不到后面的条目。

**方案**：PIXI mask + 拖拽/滚轮双输入，未引入独立的可复用 `ScrollList` 组件（沿用本项目"每个场景各自实现"的惯例，参考 `FriendsSceneBase.scrollRegion()`/`AuctionScene` 的 `scrollY`+拖拽模式，但额外加了 mask 做像素级裁切，前两者都没有）：
- `WorldMapPanels.beginScrollList(x, y, w, h, contentH)`：新增辅助方法，建一个 `PIXI.Graphics` 遮罩 + 一个 `mask` 过的 `PIXI.Container`，同时把可视区矩形写入 `ctx.infoScrollRect`、算出 `ctx.infoMaxScroll = max(0, contentH - h)` 并 clamp 当前 `ctx.infoScrollY`。国家/商城两个分支各自在这个 container 里画行（含 icon/文字/按钮），只渲染与可视区有重叠的行。
- `WorldMapPanels.panelButtonIn(layer, ...)`：`panelButton()` 的变体，按钮画进传入的 scroll layer 而非直接进 `modalLayer`，命中矩形仍推入全局 `ctx.modalBtnRects`（与遮罩范围无关——如果一行按钮恰好卡在可视区上下边界被半裁切，其命中区域理论上仍可能有几像素落在裁切掉的空白处被点到；这跟 `AuctionScene`/`FriendsSceneBase` 现有列表的行为一致，未特殊处理，可接受）。
- 切 Tab（`nations`/`season`/`shop`）、每次 `openInfoPanel()` 时都把 `ctx.infoScrollY` 重置为 0；`closeModal()` 里把 `ctx.infoScrollRect` 清空，避免关闭弹层后残留的命中矩形误吞下一次点击。
- **拖拽输入**：`WorldMapContext` 新增 `infoScrollRect`/`infoScrollY`/`infoMaxScroll`/`infoScrollDragging`/`infoScrollDragMoved`/`infoScrollDragStartY`/`infoScrollDragStartScroll`。`WorldMapInput.handleDown()` 在 `modalDimRect` 分支里，命中 `modalBtnRects` 之后、`closeModal()` 之前，新增"落点在 `infoScrollRect` 内则开始拖拽"的判断（否则原逻辑——点弹层空白处关闭——保留）；`handleMove`/`handleUp` 顶部各加一段 `infoScrollDragging` 分支，按住上下拖动换算并 clamp 新的 `infoScrollY`，触发 `renderInfoPanel()` 重绘。
- **滚轮输入**：项目里此前完全没有滚轮支持（`InputManager` 只有 down/move/up）。新增 `InputManager.onWheel`/`_emitWheel`，`WebAdapter` 监听 canvas 的原生 `wheel` 事件转发（微信小游戏没有鼠标滚轮，这条只在浏览器生效，触屏走上面的拖拽路径，两端都能用）。`WorldMapScene` 订阅 `input.onWheel` 转发到新增的 `WorldMapInput.handleWheel(x, y, deltaY)`，同样只在落点位于 `infoScrollRect` 内时生效。
- 验证：`tsc --noEmit` + `webpack --mode production` 全绿；用临时调试钩子（`app.ts` 挂 `globalThis.__NW_WorldMapPanels`/`__NW_WorldMapInput`，验证后已移除）直接构造假 `ctx`（20 条国家 / 15 件商品）单测 `renderInfoPanel()`，截图确认顶部/底部裁切干净、无溢出面板；再直接调用真实的 `WorldMapInput.handleWheel()`/`handleDown+handleMove+handleUp` 驱动滚动，截图确认滚轮和拖拽都能正确改变 `infoScrollY` 并触发重绘。
- 回归测试：`client/test/ui/worldMapInfoScroll.ui.ts`（`npm run test:ui`，PIXI headless）——手搭一个只含 `renderInfoPanel`/`handleDown/Move/Up/Wheel` 实际读取字段的假 `WorldMapContext`（不构造完整 `WorldMapScene`，省去 tile cache/net/zoom 依赖），覆盖：滚动区域随内容量的建立/不建立（国家 20 条 vs 2 条、商城 15 件、Season Tab 无滚动区）、内容变短后 `infoScrollY` 重新 clamp、滚轮在区域内/外的移动与双向 clamp、拖拽滚动 + 阈值内不触发、区域内点按不误关闭弹层 vs 区域外点按仍正常关闭（回归此前"点列表任意空白处关闭弹层"的旧行为）、`closeModal()` 清空 `infoScrollRect`、切 Tab 重置 `infoScrollY`。共 15 例，随 `npm run test:ui` 全绿一并跑通。**副带修复**：`test/ui/scenes.ui.ts` 此前在本机因 `@nw/shared` 桶文件（`index.ts`）连带引入 `jsonwebtoken`/`mongodb` 等仅服务端依赖而在 Vite 转换时报 "Failed to load url" 直接挂掉（[[client-run-and-visual-verify]] 已记录的已知环境缺口）；本次把 `server/node_modules` 第三方包（非 `@nw/*`）整体 junction 进 worktree、`@nw/shared`+`@nw/engine` 单独 junction 回 worktree 自身源码目录后一并修好，`scenes.ui.ts` 77 例、`test:ui` 全套 18 文件 241 例、默认 `npm test` 76 文件 594 例均转绿。

**顶部改为完整 SceneHeader 标题栏（2026-07-13）**：

**背景**：关卡（`CampaignMapScene`/`LevelPrepScene`）已用 `SceneHeader.drawSceneHeader()` 的完整标题栏（含默认 `sceneHeaderHeight(h)` 高度），SLG 世界地图之前只用最轻量的 `drawFloatingBackButton()`（裸返回按钮胶囊，无栏体/无标题），三个"也需要通用功能"的场景（对战/关卡/SLG）里关卡已经统一、SLG 还没有。战斗场景（`GameScene`/`HUDView`）交互模型是暂停/退出而非返回、顶部内容是实时倒计时/敌方血条而非静态货币快照，判定为继续保持自绘（不套 SceneHeader）。

**改动**：
- `WorldMapRenderer/build.ts`：`drawFloatingBackButton` 换成 `drawSceneHeader(topLayer, w, h, t('world.title'), { accent: HEADER_ACCENT.slg })`——标题栏高度用与关卡完全相同的 `sceneHeaderHeight(h)`（12% 屏高），accent 用已预留的 `HEADER_ACCENT.slg`（红色，SLG/竞技类目）。`WorldMapContext` 新增 `topInset` 字段记录这个高度。
- 地图可视区、相机居中/夹取（`viewport.ts` 的 `viewportCenter`/`setZoom`/`centerAt`/`clampPan`）、地图裁切遮罩（`build.ts` 的 `mapClip.mask`）、Loading 遮罩转圈中心点全部从"从 y=0 到 h-HUD_H"改成"从 topInset 到 h-HUD_H"，否则相机会把地图内容居中/停靠到实际被标题栏遮住的那条带里。
- `WorldMapInput.ts`：开始拖拽 / 松手判定点击瓦片的两处 `y < h - HUD_H` 判断加上 `y > topInset` 下界，避免点在标题栏范围内的点按穿透到地图瓦片（原浮层返回按钮不挡地图交互，现在整条标题栏是不透明纸面，得同步收紧命中区）。
- `WorldMapPanels.renderHud()`：右上角状态卡/行军角标/World-info 竖排原来固定从 `y=8` 起画，现在改成 `topInset + 8`——否则会被新标题栏整个盖住。左上 Zoom/Auction 竖排本来就用 `ctx.backRect.y + backRect.h` 接续，`drawSceneHeader` 返回的 `backRect.h` 现在是整条标题栏高度而非胶囊高度，天然接在标题栏下方，未改代码。
- 验证：`tsc --noEmit -p tsconfig.test.json` + `webpack --mode production` 全绿；用临时调试钩子（`app.ts` 挂 `globalThis.__NW_APP`/`__NW_SceneHeader`/`__NW_WorldMapPanels`，验证后已移除）单独构造假 `ctx` 调 `drawSceneHeader`+`WorldMapPanels.renderHud()`，截图确认标题栏高度与关卡一致、右上状态卡/左上 Zoom-Auction 都清晰落在标题栏下方、无重叠。
- 回归测试：`client/test/worldMapCameraTopInset.test.ts`（纯逻辑，走默认 `npm test`，`ViewportMixin` 混进一个不依赖 `@nw/shared` 的假 base 类以避开默认 vitest 配置的 game-logic-only 别名范围）5 例，覆盖 `clampPan`（小地图居中到 `[topInset, bottom]` 中点、大地图夹到 `[topInset, bottom]` 而非 `[0, bottom]`）、`centerAt`、`viewportCenter`、`setZoom` 四处相机数学在 `topInset` 变化时确实跟着变（而非被悄悄忽略）。`client/test/ui/worldMapHeaderInset.ui.ts`（PIXI headless，走 `test:ui`）7 例，覆盖 `WorldMapInput` 的拖拽起始/点击判定在标题栏范围内（`y<topInset`）不再穿透到地图、`WorldMapPanels.renderHud()` 右列状态卡随 `topInset` 等量下移。随 `npm test`（78 文件 603 例）+ `npm run test:ui`（20 文件 261 例）全绿一并跑通。

**标题栏改为资源产量 + 拍卖行移至右上角（2026-07-14）**：

**背景**：标题栏此前只显示静态的 `world.title`（"大世界"文案），信息密度低；拍卖行入口则挤在左上角 Zoom 下方的竖排里，跟"离开当前视图"心智模型（返回/缩放）语义不完全贴合——拍卖行是频繁访问的经济入口，更适合放在寸土寸金的标题栏本身。

**改动**：
- `WorldMapRenderer/build.ts`：`drawSceneHeader(topLayer, w, h, t('world.title'), …)` 的标题参数改传 `null`（不画标题文字，但保留栏体/纸纹/accent 底线/返回按钮胶囊）。新增 `ctx.headerHudLayer`——加在 `topLayer` 之后（渲染顺序在其上方，否则会被标题栏的不透明纸面遮住），专门承载"随数据刷新"的标题栏内容，区别于只画一次的 `topLayer` 静态栏体。
- `WorldMapPanels.ts` 新增私有方法 `renderHeaderHud()`，随 `renderHud()`（原有的 ~5s 行军轮询节奏）一并 `tearDownChildren` + 重绘到 `ctx.headerHudLayer`：
  - 拍卖行按钮：从原左上 Zoom 下方的竖排移除，改画在标题栏最右侧（`x = w - aucW - 10`，垂直居中于 `topInset` 高度内），复用同一个 `ctx.aucBtnRect` 命中矩形（`WorldMapInput.ts` 命中逻辑不用改，矩形坐标改了但读取方式没变）。左上竖排只剩 Zoom 一项。
  - 资源产量：读 `ctx.me.yieldRate`（原本只在训练弹窗里显示过的"存量 (+产量/回合)"数据源，本次复用同一字段），五种资源 `ink/paper/graphite/metal/sticker` 各画一个 `res_atlas` 图标 + `+产量` 文字，水平居中在"返回按钮胶囊右侧"到"拍卖行按钮左侧"之间的空当，替代原来的标题文字。
- 验证：`tsc --noEmit` + `webpack --mode development` 全绿；用临时调试分支（`entries/web.ts` 加 `?worldmap` 查询参数分支，直接 `new WorldMapScene(...)` + reject-fast 的 `WorldApiClient` Proxy 桩，跳过登录/后端，参考 [[worldmap-standalone-debug-render]] 的既有 recipe；额外踩坑：debug 分支里手搭的 `PIXI.Application` 没有走 `ScalingManager` 的 `gameLayer` 缩放变换，场景容器的 design-space 坐标会 1:1 落到物理画布上——标题栏最右侧的拍卖行按钮因此一度被误判"渲染缺失"，实际是设计坐标超出画布物理宽度；修复为手动 `scene.container.scale.set(w/layout.designWidth, h/layout.designHeight)` 复现真实 App 的缩放后，拍卖行按钮回到画布内可见），截图确认标题栏不再显示"大世界"文字、五个资源产量图标+数值居中显示、拍卖行按钮清晰落在标题栏右上角、返回按钮与左上 Zoom 不受影响；验证后临时分支已移除。
- 回归测试：`client/test/ui/worldMapHeaderProduction.ui.ts`（PIXI headless，走 `test:ui`）7 例，手搭假 `WorldMapContext`（含新增的 `headerHudLayer`）单独驱动 `WorldMapPanels.renderHud()`：拍卖行按钮落在屏幕右半区、贴右边缘、垂直居中于 `topInset` 高度内（含 `topInset` 变化时按钮高度跟着变）；`ctx.me.yieldRate` 五个资源各生成一条 `+<rate>` 文本（含缺省值回退 `+0`）；产量读数水平居中在返回按钮和拍卖行按钮之间、不重叠任一方；`renderHud()` 反复调用（模拟 5s 轮询）不泄漏子节点。同时修了 `worldMapHeaderInset.ui.ts` 已有测试的假 ctx 缺 `headerHudLayer` 字段的问题（`renderHud()` 新调用 `renderHeaderHud()` 后会读到 `undefined.removeChildren`，两个测试文件现在都手搭这个字段）。随 `npm run test:ui`（29 文件 305 例）全绿一并跑通。

**标题栏/右上信息栏可读性微调（2026-07-15）**：

**背景**：用户截图标注反馈五处问题——资源产量条无背景直接浮在标题栏纸面上，不易辨认；`res_atlas` 图标在头部/状态卡里显示得发糊；拍卖行按钮贴右边缘太紧、在窄屏上容易被裁掉；左上 Zoom 按钮和右上部队/领地/行军竖排整体偏小。

**改动**：
- `WorldMapPanels.renderHeaderHud()`：资源产量簇新增独立背景 `sketchPanel`（`C.paper`/`C.mid`，按簇实际宽度 + 10px 内边距动态量），插在簇本身下方，与标题栏共享的纸面区分开。
- `resAtlasLoader.ts`：`res_atlas` 的 `BaseTexture` 构造显式传 `scaleMode: LINEAR` + `mipmap: ON`——图集 128px 长边在头部/状态卡里被缩到 15-34px 显示（约 4-8 倍降采样），没有显式 trilinear 采样时线稿发糊；这是最可能的成因，受限于本机后端服务当次会话未起，没能截图肉眼复核，后续实机确认。
- `renderHeaderHud()`：拍卖行按钮右边距从 10 增到 30，避免窄屏/贴边裁切；`tag` 图标本来就有，一并确认可见。
- `renderHud()`：左上 Zoom 按钮 88×34 → 176×68（图标/文字同比放大）；右上部队/领地状态卡 + 行军角标/列表 + World-info 按钮整个右列宽度 160 → 320，所有子元素（字号、图标、召回按钮、行高）同步 2 倍缩放。
- 验证：`tsc --noEmit` + `webpack --mode production` 全绿；未能起本机后端跑通完整登录→世界地图流程做截图核对（`/bootstrap` 网络失败，是已知未解决的本机开发环境问题，非本次改动引入），代码改动本身逻辑清晰、走查过一遍无遗漏，但视觉效果待后续实机确认。

## 26. 领地总览面板（点击标题栏资源条打开，设计阶段，2026-07-16）

**背景**：`renderHeaderHud()`（§25 2026-07-14）画出的标题栏资源产量条目前只是静态展示，不可点击；右上状态卡的 `territoryCount` 也只是一个聚合数字，玩家看不到自己占的具体是哪些格、也无法从 HUD 直接跳转/放弃某块领地。占地规模到中后期可达 200~300 格，需要一个专门面板承载"总览 + 逐格管理"。

**拍板要点**：
- **点击入口**：标题栏资源产量簇（`renderHeaderHud()` 已有的命中矩形范围）新增点击 → 打开新面板，复用 `WorldMapPanels` 现有的弹层机制（`openInfoPanel()`/`modalLayer`/`modalDimRect` 关闭逻辑），而非另起一个 Scene。
- **一屏两 Tab**，不做成两次跳转的独立页面：
  1. **总览 Tab**：资源产量/仓库（当前标题栏资源条的完整版，含存量+上限）、Troops、Territory 计数、World 摘要（原右上 World-info 弹层内容收纳一份精简摘要，保留原入口跳转完整页）。纯展示，无分页。
  2. **领地列表 Tab**：逐格一行——坐标 `(x,y)`、等级、驻军，行内两个按钮「跳转」「放弃」。
- **不做成两屏/两个独立页面的理由**：总览部分内容量小且强相关（同一决策上下文：家底够不够、要不要扩张），拆开需要来回切换对比，增加认知负担；领地列表因为可能有 200~300 行、且是"列表+逐行操作"这一功能形态，与总览的纯展示不同，值得单开一个 Tab，但仍在同一弹层内即可，不需要跳转到独立 Scene。
- **等级过滤**：领地列表 Tab 顶部加两排 checkbox（按等级分两行，例如 1-5 一排、6-10 一排，取决于实际等级上限），勾选决定显示哪些等级的领地行；默认全选。纯客户端过滤，不需要服务端参数化。
- **规模应对（200~300 行）**：不能一次性铺开全部行，沿用 §25 2026-07-13 `beginScrollList()`/`panelButtonIn()` 的 PIXI mask 滚动列表模式（而非新增分页组件），按等级过滤后的行数决定 `contentH`；每行按钮沿用 `ctx.modalBtnRects` 命中登记方式。
- **复用清单（已在代码里现成、直接调用即可）**：
  - 跳转：`viewport.ts` 的 `centerAt(tx, ty)`（marches 列表点击跳转已是同一模式，见 `WorldMapInput.ts:314`）。
  - 放弃：`WorldMapNet.doAbandon(tx, ty)` → `WorldApiClient.abandonTile()` → 服务端 `httpApi.ts` `/world/abandon`（已end-to-end 实现，直接对列表行调用）。
- **新增缺口（需要实现）**：
  - **服务端**：worldsvc 目前没有"枚举玩家全部占地"的接口——`getOccupations()`/`/world/occupations` 只返回行军中的临时捕获态,不是全部持有的领地集合。需要在 `server/worldsvc/src/territory.ts`（或等价位置）新增聚合查询 + `httpApi.ts` 新路由（如 `GET /world/territories`），返回 `{x, y, level, garrison}[]`。
  - **契约**：`openapi-world.yml` 补新端点 + 类型；`client/src/net/WorldApiClient.ts` 补对应方法。
  - **客户端 UI**：`WorldMapPanels.ts` 新增总览/领地列表两个 Tab 渲染分支 + 等级过滤 checkbox 渲染与状态；`WorldMapContext.ts` 补面板开关状态、等级过滤勾选集合、Tab 切换状态；`WorldMapInput.ts` 补标题栏资源条点击入口 + 过滤 checkbox/跳转/放弃按钮命中分支。
- **未决**：等级上限具体是多少（决定 checkbox 两排怎么分）、领地列表默认排序（等级降序 or 离主城距离）——待实现前确认或按现有惯例（等级降序）先定一版，暂不阻塞开工。

**落地状态（2026-07-16，已实现）**：
- 服务端：`TerritoryService.listTerritories()`（`territory.ts`）复用 `coreYield.ts` 已有的 `cols.tiles.find({worldId, ownerId, type:{$ne:'base'}})` 查询模式，经 `service.ts` 委托、`httpApi.ts` `GET /world/territories` 暴露；`openapi-world.yml` 新增端点定义（复用既有 `WorldTileView` schema，未新建 schema），`gen:api:world` + `gen:api:contracts` + 客户端 `rest:gen` 三步codegen 全部重跑同步。
- 客户端：`WorldMapContext` 新增 `territoryPanelOpen`/`territoryTab`/`territories`/`territoryHiddenLevels`/`resClusterRect`；`beginScrollList()` 顺带泛化出 `ctx.infoScrollRerender` 回调（原先滚动拖拽/滚轮硬编码调 `renderInfoPanel()`，现在按打开的是哪个面板调用对应的渲染函数，World-info 和 Territory Overview 两个弹层共用同一套滚动输入代码不用分叉）；等级过滤 checkbox 直接注册为普通 `modalBtnRects` 项（勾选即 toggle + 重渲染），不需要新的命中判定分支；跳转复用 `centerAt` 并额外 `closeModal()`（列表在弹层里，跳转后应看地图）；放弃改走新增的 `WorldMapNet.doAbandonFromList()`（区别于原 `doAbandon()`：不 `closeModal()`，放弃后原地刷新列表，不打断玩家继续处理其他行）。
- 测试：`server/worldsvc/test/territories.e2e.test.ts`（5 例，真实 Mongo）——未入世界拒绝、已加入无领地返回空、领地行字段正确且排除 3×3 主城 footprint、跨玩家隔离、放弃后从列表消失。`client/test/ui/worldMapTerritoryPanel.ui.ts`（12 例，PIXI headless）——开面板守卫（未入世界→toast 不开面板）、总览页无滚动区、切到列表 Tab 触发一次性拉取、等级 checkbox 勾选/取消的行数变化（按 `modalBtnRects` 长度断言，不深入渲染内容）、跳转关闭弹层+居中地图、放弃调用 `net.doAbandonFromList` 且不关弹层。另修了 `worldMapHeaderInset.ui.ts` 手搭假 ctx 缺 `resClusterRect` 字段导致的 3 例失败（`zeroRect()` 补齐）。`tsc --noEmit` + `webpack --mode production` + worldsvc 全套（31 文件 235 例）+ client `test:ui` 全套（52 文件 490 例）均绿；浏览器截图人工核对总览/列表/过滤/跳转/放弃交互，细节见会话记录。

**World-info 合并进第三 Tab + 面板加高（2026-07-16）**：用户截图标注反馈两点——右上角单独的 World 按钮/弹层和领地总览面板功能重叠，应合并；面板偏矮，内容常需要滚动。改动：`renderHud()` 删除原独立的 World 按钮渲染块与 `ctx.infoBtnRect` 命中矩形，`WorldMapInput.ts` 对应的点击分支一并移除；`renderTerritoryPanel()` 的 Tab 数组新增第三项 `world`（`territoryTab` 类型相应扩为 `'overview' | 'list' | 'world'`），点击后渲染原 `renderInfoPanel()` 的 nations/season/shop 三个二级 Tab——抽成新的私有方法 `renderWorldTabBody()`，直接画进总览面板已有的弹层区域（不再单独起 dim/panel/title/关闭按钮）；`openInfoPanel()` 整个方法删除，原先「首次打开时懒加载 shop 目录 + nations」的逻辑搬进新增的 `loadWorldTabData()`，由 `switchTerritoryTab('world')` 触发；`doBuyShopItem`/`doRename`（`WorldMapNet.ts`）刷新面板的判断条件相应改成 `territoryPanelOpen && territoryTab === 'world'`。面板高度从固定 `min(460, …)` 改为页面高度的 80%（`h * 0.8`，仍 cap 到不遮挡底部 HUD）。验证：`tsc --noEmit` + `webpack --mode development` 全绿；用临时 `__NW_WorldMapPanels` 调试钩子（挂在 `app.ts`，验证后已移除）在真实 dev server 里手搭最小 ctx 直接调 `renderTerritoryPanel()`，截图确认三个 Tab（总览/领地/World）+ World Tab 下 nations/season/shop 二级 Tab 正常显示、面板高度明显变高。

**总览可读性放大（2026-07-16）**：用户反馈资源界面偏窄偏小。`renderTerritoryPanel()` 面板宽度上限从 `min(420, w-20)` 提到 `min(840, w-20)`（窄屏仍钳到 `w-20`，真机不溢出）；总览页文字约 2×——资源行/赛季·人口行用 `FS.label`（24）、强调的兵力/领地行用 `FS.heading`（28），行距同步加倍（20→40、22→44、26→52、18→36）以免重叠。仅影响总览 Tab；列表/World 两个 Tab 共用同一 `pw` 会一起变宽，内部字号未动。验证：`tsc --noEmit` 绿；临时 `?terrpanel` 调试入口（构造真实 `WorldMapScene` + 假数据，`forceCanvas` 抓图，验证后已移除）截图确认字号翻倍、面板加宽、无重叠裁切。

---

## 27. 险地/关隘战力模拟补测（2026-07-16，DRAFT 数值收尾）

> 背景：项目体检发现 `STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL`/`CROSSING_GARRISON_PER_LEVEL` 四个常量仍带 DRAFT 标记（§15.3/§19.5）。前三者中，`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL` 的经济面早已被 `strongholdRun.ts`（§13-SLG-STRONGHOLD.2-4）核验过，只是源码注释没跟着更新；真正从未验证过的是「这些守军数值到底能不能打下来」——原注释只是一段手估 HP 对比，没有真跑过引擎。

**新增战力模拟脚本**（`server/tools/econ-sim/src/strongholdCombat.ts` + `strongholdCombatRun.ts`，`npx tsx src/strongholdCombatRun.ts`）：复用真实 `@nw/engine` 攻城引擎（自成一体，标准同 `client/test/pvpSim.ts`——独立于 worldsvc 直接调用 `@nw/engine` 原语，而非 import worldsvc 内部模块，因为后者会把 `tsc --noEmit` 的 rootDir 拉出包边界）。

**关键发现**：
1. **险地/关隘实际等级是固定值，不是文档暗示的 1..5 区间**：险地恒生成于 `SLG_MAP_MAX_LEVEL`（现 10，ADR-032 起从 5 涨上来的）→ 守军恒 3,600 兵；自动关隘恒生成于 `max(2, SLG_MAP_MAX_LEVEL-1)`（现 9）→ 守军恒 1,800 兵。`siege.ts` 旧注释仍写"满级 5→1800"，是地图上限上调后没跟着改的过时描述，本轮已订正。
2. **战力校验通过**：险地——新手（troopCap=2000）0% 胜率，小额投入（troopCap≈4500，练兵场约 3 级）100% 胜率；关隘——新手 0%，练兵场仅 1 级（troopCap=3000）即 100%（比险地更早开放，符合"较轻关卡"设计意图）。两个常量**均保持不变**，DRAFT 标记已从 `shared/src/slg/siege.ts` 源码注释移除，换成本次核验依据（详见 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5）。
3. **⚠️ 新发现的独立 gap（非本轮数值范围）**：单次出征兵力超过约 9,600（= 10 攻击车道 × 16 可生成行 × 60 血/兵，棋盘纵深耗尽）时，`synthesizeArmy` 轮转铺兵会让胜负变得非单调（例如 9,000 兵败、9,600 兵胜、10,000 兵又败），根源是兵力在车道内拥堵导致战斗超时，与守军强度无关。`SIEGE_CHEAP_RATIO`（`shared/slg/siege.ts`）本该把这种悬殊对局挡在真实引擎之外，但 `combatSiege/arrival.ts` 的险地/关隘围攻从未做这个比率检查，无条件跑 `runSiegeBattle`——满练兵场+满行囊（satchel，均可堆到 12,000）玩家单次出征在生产环境就可能撞上这个问题。这是路由/工程缺口，不是「调大调小某个常量」能解决的，已登记为独立后续任务（不在本轮范围内处理）。

**结论**：`STRONGHOLD_GARRISON_PER_LEVEL=360`、`CROSSING_GARRISON_PER_LEVEL=200`、`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4` 三处 DRAFT 标记均已清除（前者战力实测通过，后者经济稀释早已通过只是注释未同步）；`STRONGHOLD_LOOT_PER_LEVEL=5000` 本就非 DRAFT（季内一次性、已有 sanity check）。四项收尾完成，SLG 待调参数值清单清空。

**Follow-up（2026-07-16，独立 gap 已修复）**：第 3 点记录的路由缺口已在同日修复。`server/worldsvc/src/siegeEngine.ts` 新增 `SIEGE_SYNTH_ARMY_MAX_TROOPS`（=10 车道×16 行×60 血=9,600，`synthesizeArmy` 不发生车道碰撞的兵力上限）与 `shouldUseCheapSiege(...)`：当任一方是 `synthesizeArmy` 铺兵且兵力超过该上限（无论比率是否达到 `SIEGE_CHEAP_RATIO`），或攻守比率达到 `SIEGE_CHEAP_RATIO` 时，一律跳过真实引擎改走 `resolveSiege` 线性结算。已接入 `combatSiege/arrival.ts` 的全部三条路径——`applySiege` 普通地块围攻、`applyStrongholdSiege`、`applyCrossingSiege`——以及 `applyBaseSiege` 主城逐波围攻的每一波（防守方队伍恒为真实编队，从不铺兵，故只需查攻方）。真实卡牌编队（位置由关卡校验器约束、不会车道碰撞）不受影响，只有"无编队、纯兵力数"的旧式出征会命中该守卫。新增单测 `worldsvc/test/siege-cheap-fallback.test.ts`（纯函数，覆盖上限/比率/双向判定）+ `stronghold.e2e.test.ts`、`passage.e2e.test.ts` 各一条回归用例（12,000 兵出征验证 `attacker_win` 且 `siege.seed`/`attackerArmy` 缺失，证明走的是 cheap 路径而非拥堵的真实引擎）。

---

## 28. G6 赛季中转区/合区（设计 + 实现，2026-07-16）

> 收尾 §17.12/§21.4 遗留的最后一项：G6 运行时调度（§20）只做了赛季开局的一次性路由分配；赛季中途「玩家主动转区」「运营合并低活 shard」此前完全没有设计（§17.8/§17.12 只写了"运营专项，待定"）。本节补齐设计并实现。

### 28.1 架构前提（决定了方案为什么这么简单）

调研确认两个关键事实，把原本设想的"复杂跨区数据迁移"问题大幅简化：

1. **所有 shard 共享同一套 Mongo 集合**（`playerWorld`/`tiles`/`marches`/`families` 等），按 `worldId` 字段区分,不是一区一库。转区因此是**同集合内**的操作,不是跨库迁移。
2. **`joinWorld`（首次加入）与 `purgePlayerWorld`（清空某玩家在某 shard 的全部数据,含主城）两个函数早已存在**（分别用于正常加入、corrupt 存档修复重建）,且都是"对单一 (worldId, accountId) 操作,与其在其他 shard 的状态无关"——直接复用,零新建迁移逻辑。

### 28.2 转区（个人转移）—— "刻意的退出+重新加入"

**模型**：转区 = 放弃源 shard 全部 shard 内数据(城市/领地/兵力,经 `purgePlayerWorld`)+ 在目标 shard 全新加入(经 `joinWorld`)。**不做属性迁移**——account 级进度(卡牌/装备/金币,存在 meta SaveData)本来就不是 shard 数据,天然不受影响。

**家族/宗门不受影响**：调研确认「家族」（family）是 socialsvc 的账号级概念，不按 shard 存储；「宗门」（sect）虽是 worldId 域概念，但挂在**家族**（不是账号）上，一个成员单独转区不涉及宗门变更。因此转区**不触碰**家族/宗门成员关系——这是刻意的设计简化，不是遗漏。

**守卫**：
- 目标 shard 必须存在、同赛季、`open`/`active`、未满员，否则 `TRANSFER_TARGET_INVALID`。
- 源 shard 内有在途行军(非 `recalled`)或占领倒计时 → `TRANSFER_BUSY`（先撤军/等结算）——避免刚离开的 shard 里留下悬空的跨区引用（正是 `patrolShardIsolation` 的 `crossWorldMarches` 巡检要抓的那类东西）。
- 每账号冷却 `SHARD_TRANSFER_COOLDOWN_DAYS=7`（防止反复横跳/侦察对手 shard），冷却计时存在独立的新集合 `shardTransfers`（`_id=accountId`,不挂靠任何一个 shard,故不会被 `purgePlayerWorld` 清掉）。

**已知残余风险(接受)**:目标容量在"转区前检查"和"joinWorld 内原子检查"之间的极窄窗口耗尽,会让玩家短暂"两边都不在"——本项目全程无跨集合事务(`shared/mongo.ts` 明确写单节点副本集只解锁事务能力,但代码里从未真正用过,全靠单文档 CAS),与既有惯例一致,不引入 the-first transaction。恢复路径:玩家可直接调用普通 `joinWorld` 进任意其他 open shard(无历史依赖,不是卡死状态)。

### 28.3 合区（运营触发）—— 复用转区,不做地图合并

**关键简化**：不做"两张活地图的瓦片所有权对账"——那是原调研认定的真正难题。合区改为：把源 shard 剩余的**每一个玩家**都用同一套转区核心操作搬到目标 shard,搬完后关闭源 shard。因为源 shard 上没有玩家了,自然不存在"两边地图重叠"的问题——从头到尾没有发生"地图合并"这件事。

- **与个人转区的区别**：合区是运营强制操作，不检查冷却/繁忙——先强制清空该玩家的在途行军/占领(`marches.deleteMany`/`occupations.deleteMany`),再走同一个"退出+加入"核心,逐账号 best-effort(单个账号失败只记日志跳过,不中断整个合区)。
- **前置容量检查**：合区前一次性校验目标 shard 剩余容量 ≥ 源 shard 全部玩家数,不足直接拒绝——避免在循环中途撞见 28.2 提到的"两边都不在"窗口。
- **收尾**：全部搬完后源 shard 置 `status:'closed'`——`resolveShardForJoin`/`joinWorld` 本来就按 `status in [open,active]` 过滤(§17.3),`closed` 天然被未来加入路由排除,无需额外清理路由表。

### 28.4 实现落地

- **`@nw/shared`**：`slg/transfer.ts`（新文件）——`SHARD_TRANSFER_COOLDOWN_DAYS=7` + `parseWorldId`；`api.ts` 新增错误码 `TRANSFER_COOLDOWN`/`TRANSFER_TARGET_INVALID`/`TRANSFER_SAME_SHARD`/`TRANSFER_BUSY`。
- **`worldsvc`**：新模块 `transfer.ts`（`TransferService`，同 `TerritoryService`/`SeasonService` 的领域服务范式）——`listTransferTargets`/`transferShard`/`mergeShard`；`db.ts` 新增 `ShardTransferDoc` + `shardTransfers` 集合（`_id=accountId`）；`service.ts` 接线委托方法。
- **契约**：`openapi-world.yml` 新增 `GET /world/season/transfer/targets` + `POST /world/season/transfer`（玩家侧，JWT）+ `ShardTransferTargetView` schema；`POST /admin/world/merge`（X-Internal-Key，运维侧，未入 openapi-world.yml——与其余 `/admin/world/*` 端点一致，属内部分支不进公开契约）。client `rest:gen` 重生 `openapi-world.ts`。
- **客户端**：`WorldApiClient.getTransferTargets`/`transferShard` 已接入（数据层）。**UI 场景本轮暂缓**——给时间预算判断，玩家侧转区选择/确认界面留作后续任务，不阻塞服务端能力落地。
- **admin 后端**：`WorldClient.mergeWorld` 代理 + `AdminService.slgMergeShard`（复用既有 `slg.season.manage` 能力，新增审计动作 `slg.season.merge`）+ httpApi 路由 `POST /admin/slg/season/merge`。
- **ops 前端**：`tools/ops/src/pages/slgSeason.ts` 季世界列表新增「Merge into…」按钮（危险操作二次确认 + 目标 worldId 输入）。**顺带修复一处相邻小 bug**：原按钮判断只覆盖 `status==='open'`，遗漏了 `'active'`（世界一旦有玩家加入就从 open 变成 active，§17.3）——导致进行中的世界在 ops 页面上其实**没有** Settle/Close 按钮可点。改为 `open || active` 都显示操作按钮，这是本次改动顺带修的，不是范围外改动。
- **验收**：`server/worldsvc/test/transfer.e2e.test.ts`（11 例，真实 Mongo）——转区成功（源清空含主城+人口计数扣减、目标全新加入+人口计数+3×3 主城 footprint）/ 同 shard 拒绝 / 跨赛季目标拒绝 / 不存在目标拒绝 / 满员目标拒绝 / 在途行军阻挡（recalled 后放行）/ 占领倒计时阻挡 / 同赛季冷却生效+跨赛季不冷却 / 合区搬空全部玩家+强制清行军占领+关闭源 shard+未来加入路由自动跳过 / 合区目标容量不足拒绝 / 合区同 shard 与跨赛季目标拒绝。worldsvc 全量 246 测试无回归；`tsc -b`（shared/engine/worldsvc/admin/metaserver/gateway/commercial）+ client `tsc --noEmit` + ops `tsc --noEmit` 全绿。

### 28.5 明确排除的范围（不是遗漏，是拍板）

- **不做真正的地图/瓦片合并**：两个 shard 各自独立地图从未需要对账，因为合区前置为"先搬空玩家再关闭"，任何时刻只有一张地图有活跃玩家在上面。
- **不做家族/宗门整体转移**：转区是纯个人操作；一个家族想集体换 shard，需要每个成员各自转区（家族本身跟着任一成员走，不会"卡住"，因为家族不是 shard 数据）。
- **不做玩家侧 UI**：服务端能力+契约+admin 运维入口已完整；玩家自助转区的选择/确认场景留作后续任务（数据层 `WorldApiClient` 方法已就绪，UI 是纯前端工作，不依赖任何未决的服务端设计）。

## 29. NPC 地块基地血量随等级缩放（2026-07-17，方案 2，用户拍板）

**背景/病灶**：用户实测「打一级地，打败了敌方所有的兵，但自己的兵不足以摧毁基地」。根因：**NPC 地块**（占地 `applyOccupy` / 驱逐 `applyOccupationExpulsion` / 领地 `buildDefenderConfig` / 据点 `applyStrongholdSiege` / 关口）走**单场** `runSiegeBattle`（objective=`destroy_base`），其引擎内象征基地血量此前恒为 `BASE_HP=100`，**与地块等级无关**。而基地不是"慢慢磨"——每个走到基地格的单位一次性造成自己的 `siegeValue`（合成步兵=11）后当场消失（`MovementSystem`）。于是一级地驻军仅 `npcGarrison(1)=120`（=2 步兵）微不足道，但要凑够 ~10 个幸存步兵抵达基地才推得平 100 血；`OCCUPY_MIN_TROOPS=500` 的最小占地兵力清完守军后幸存不足 → 超时 → 守方胜（防守方偏置）。**玩家主城/领地侧本无此问题**：走 ADR-026 分波，象征基地钉死 `defenderBaseLevel:0` 只当终结器，真实血量是 `TileDoc.hp = baseDurabilityMax(墙等级)`——已随基地等级缩放。缺口只在 NPC 单场路径。

**方案（用户在三选项中选"缓坡 40×等级"）**：新增 `npcBaseHp(level) = SLG_NPC_BASE_HP_PER_LEVEL × max(1,level)`，`SLG_NPC_BASE_HP_PER_LEVEL = 40`（L1=40、L10=400）。低级更软、高级更硬，与玩家城侧 `baseDurabilityMax` 形成对称。

**实现（跨 4 包，显式传参、无隐式推导）**：
- **`@nw/shared`**（`slg/siege.ts`）：`SLG_NPC_BASE_HP_PER_LEVEL` + `npcBaseHp()`；`buildSiegeLevel`/`buildSiegeBattle` 的 config 加 `defenderBaseHp` 透传（>0 才写；**不**从 tileLevel 隐式推导，分波路径不传即保持默认）。
- **`@nw/engine`**：`Player.maxBaseHp`（默认 `BASE_HP`）；`LevelDefinition.defenderBaseHp` + `levelSchema` 校验（1..100000 脏数据兜底）；`base.ts` 开局把 `topPlayer.baseHp=maxBaseHp=defenderBaseHp`；`MovementSystem` 的 `base_hp_changed.maxHp` 改发 `opponent.maxBaseHp`（原写死 `BASE_HP`）。
- **`worldsvc`**：占地/驱逐/据点/关口/领地单场五处 `defenderConfig` 显式加 `defenderBaseHp: npcBaseHp(tileLevel)`；分波路径（`defenderBaseLevel:0`）**不加**；config 类型（`siegeEngine.ts`/`worldTypes.ts`/`combatSiege/base.ts`）补字段。回放走持久化 `defenderConfig`，确定性保持。
- **client**：`GameRenderer/base.ts` 的 critical 阈值从 `BASE_HP×ratio` 改为各玩家 `maxBaseHp×ratio`（血条 max 本就走事件 `maxHp`，replay `baseMaxHp` 从首帧 `baseHp` 锚定，均自动正确）。

**econ-sim 复核**（`tools/econ-sim/src/occupyBaseHpRun.ts` + `npm run --workspace @nw/econ-sim occupy-base-hp`，真实 `@nw/engine` 单场，合成步兵，每级 5 seed 全胜的最小兵力）：

| 地块 | 驻军 | 旧(基地=100) 最小取胜 | 新(=40×L) 最小取胜 | 新基地血量 |
|---|---|---|---|---|
| 1 | 120 | 660 (11 步兵) | **300 (5 步兵)** | 40 |
| 2 | 240 | 660 | 660 | 80 |
| 3 | 360 | 720 | 720 | 120 |
| 4 | 480 | 780 | 960 | 160 |
| 5 | 600 | 900 | 1140 | 200 |
| 6 | 720 | 960 | 1500 | 240 |
| 7 | 840 | 1140 | 2160 | 280 |
| 8 | 960 | 1260 | 2340 | 320 |
| 9 | 1080 | 1320 | 2640 | 360 |
| 10 | 1200 | 1560 | **2940** | 400 |

L1 从需 660 兵降到 300（最小占地 500 现稳赢，直击病灶）；L2/L3 基本不变；L4+ 显著变硬，高级地成为真正的战力门槛。

**验收**：shared/engine/worldsvc/client `tsc` 全绿；shared siege 单测 39/39（+npcBaseHp/defenderBaseHp 用例）；engine 66/66（+siege defenderBaseHp 初始化用例）；worldsvc occupy/base-siege/siege/stronghold/passage/cheap-fallback e2e 全绿（无结果翻盘）；econ-sim `tsc --noEmit` 通过。**数值仍 DRAFT**（README §0 铁律：只调常数不改公式）。

## 30. 出征队伍编辑器：左右分栏布局（2026-07-18，用户拍板）

**背景**：`DefenseEditorScene`（attack 模式，`client/src/scenes/DefenseEditorScene.ts`）此前把卡牌调色板做成顶部一条可翻页的横向卡片带（`cardPage` 分页 + 左右箭头），棋盘格铺满整个屏幕宽度。用户反馈配队应该"左半屏布阵、右半屏选卡"，两者同屏可见，不必来回翻页。

**实现**：仅改 attack 模式（defense 模式的兵种/建筑调色板不变，仍是顶部横条）：
- `renderAttackBody()`：屏幕对半分——左半宽度内画棋盘格（`renderGrid()` 加了 `areaX`/`areaW` 参数，defense 模式沿用默认值=全宽不受影响），右半宽度内画卡牌名册。
- `renderAttackToolbar()`：原顶部横条只剩提示文案 + 删除工具切换按钮，收窄到左半宽度上方一条。
- `renderCardRosterPanel()` / `renderRosterCell()`：卡牌名册改为**竖直可滚动的肖像卡片网格**（列数按右半宽度自适应），复用 `TeamsScene.ts` 的花名册卡片视觉语言（肖像+等级+兵力+"已在队伍中"标签）与 `ScrollTapGesture` 拖拽/点击消歧（防止在名册上拖动滚动时误触发选卡）。
- 移除了原分页横条 `renderCardPalette()`/`cardPage` 字段（不再需要翻页）。
- 选卡→点格子放置的既有交互（含跨队伍互斥、`CARD_TEAM_MAX_SIZE` 上限、卡牌只能占一格）逻辑未改动。

**验证**：`client/test/ui/defenseEditorAttackCards.ui.ts`（6 例，纯逻辑，不测布局像素）+ `teamsScene.ui.ts`（11 例）全绿，`tsc --noEmit` 全绿；另用临时 `?teamEditor` 调试入口（构造假 `WorldApiClient` + 假 `SaveData`，跳过登录/后端，验证后已删除，未随功能保留）在 Browser 截图核对了实际渲染效果——左侧棋盘 + 右侧卡牌网格、已部署卡牌高亮 + "已在队伍中"标签、选卡后点格子放置生效。

### 30.1 棋盘格已布置单位改用卡牌肖像（2026-07-18）

**背景**：左侧棋盘上已放置的单位此前只画一个纯色圆点（按 unitType 分 4 色）+ 兵力数字，与右侧名册的肖像卡片视觉不一致，用户反馈应显示卡牌图片。

**实现**：`drawUnit()`（`DefenseEditorScene.ts`）改为复用 `renderRosterCell()` 同款素材管线——`UNIT_ART_URLS[type]` 取到肖像 URL 时画一个 `sketchPanel` 方框 + `drawArtFit()`（与名册肖像同一 `getArtTexture`/`artHooked` 缓存与异步加载回调），取不到时保留原纯色圆点兜底（理论上不会触发，因为可布置单位均来自 `CARD_DEFINITIONS` 已收集兵种，均有肖像）。兵力数字标签位置从"圆心+半径"改为"方框底部"。

**验证**：`tsc --noEmit` 全绿；用临时 `__NW_APP`/`__NW_DefenseEditorScene` 调试钩子（`Object.create(DefenseEditorScene.prototype)` 假实例直调 `drawUnit`，跳过登录/WorldApiClient，验证后已删除）截图确认 Max/Lena/Archer 三种兵种均正确显示肖像图（非圆点）。
