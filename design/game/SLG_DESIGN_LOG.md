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
| **V1 迷雾模型** | 永久黑雾 vs 战争迷雾 | **2a**：地形层（程序化、确定性）**全图始终可见**；动态层（归属/驻军/防守/保护罩/行军）仅当前视野内可见，视野外**退回 `proceduralTile` 底层地形**（连「已被占领」信号都不泄露——type 不返 `territory`/`base`）。不做持久化 explored-set 黑雾——地形不是秘密，机密是动态层。**资源图案（含等级细节）归地形层，全图始终可见（2026-07-07 拍板，见 §18.6 客户端渲染条）——原「视野外只显资源类型、隐等级」的收窄已作废。** **⚠️ 2a 的「动态层整层藏雾」已于 2026-07-24 让位给模型 2b（§18.10）：归属/base/占领等静态结构改为全图公开，迷雾只藏情报字段（驻军/耐久/瞭望塔）与行军。** |
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
  - **标记色**（沿用全局阵营色铁律「敌红我蓝」ADR-003；2026-08-08 订正——此前本节曾写成「敌蓝我红」并据此实现，见 DECISIONS ADR-024 订正记录）：自己=蓝（`MINE_*`）、**家族盟友=绿（新 `ALLY_TINT/ALLY_BASE_TINT`，友方第三色）**、敌方=红（`ENEMY_*`）、中立=纸面。`tileColor` 加 `ally→绿` 分支（在 mine 之后、occupied 之前）。
  - **敌军行军**：march 箭头 `march.mine===false` → 统一敌色（红）+ 更粗描边 + 更大终点点，突出威胁；己方按 kind 上色。HUD 行军列表过滤为 `mine!==false`（敌方行军不可撤、不进列表）。
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

### 18.8.1 scout 暂时下线（2026-07-21）

> 玩家反馈「行军中的队伍被拉去侦察」；排查代码（见下）未能在当前实现里找到该路径的直接复现——scout 从设计上就不携带 `teamId`（`doScout` 固定从主城派 1 名斥候，不走队伍选择器；服务端 `startMarch` 只在 `kind==='attack'||'occupy'` 时才把 `teamId` 落库/纳入 `TEAM_BUSY` 校验，scout 分支完全绕开）。根因未定位前先按用户要求下线入口，避免继续造成困惑；底层结构（`MarchKind`、`MarchDoc`、契约 enum、i18n、图标映射）原样保留，方便定位后快速恢复。

- **client**：`WorldMapInput.ts` 的四处菜单（敌方格/据点/据点保持中/中立格）移除「侦察」按钮；`doScout()`（`WorldMapNet.ts`）保留但已无入口可触发。
- **worldsvc**：`combatMarch.ts` `startMarch()` 在 `MARCHABLE_KINDS` 校验后新增 `if (kind === 'scout') throw NOT_IMPLEMENTED`，即便有客户端直连 API 也会拒绝；原 scout 分支（无战斗/无占领/无 `defenderId`）随之移除（已不可达）。
- **测试**：`scout.e2e.test.ts` 由「验证 scout 正常工作」的 3 例改为「验证 scout 被拒绝」的 1 例；client 新增 `worldMapScoutDisabled.ui.ts`（5 例）断言四种菜单均不再出现侦察按钮。
- **验收**：server `tsc -b` + worldsvc 全量 e2e（33 files / 282 tests）全绿；client `tsc --noEmit` + `build:web` + 全量 UI 测试（79 files / 721 tests）全绿。
- **遗留**：真正的「行军队伍被误派侦察」根因仍未查明（怀疑是旧版本客户端，或 `showTeamPicker` 的 `busyTeamIds` 读到过期数据导致误判空闲）——待用户提供具体复现步骤后再排查；此前 §18.8 记录的 scout 功能设计/实现细节仍作为恢复参考保留不动。

#### 18.8.1a scout 彻底删除（2026-07-30）

audit-followup-fixes-0730 复查时重新核实了 §18.8.1 的"根因未定位"结论：`doScout()` 现在零调用方（四处菜单按钮早已移除，且没有其它入口能到达它），服务端也没有任何除 `startMarch` 显式参数之外的路径能把某个 march 的 `kind` 设成 `'scout'`——结构上"行军队伍被误拉去侦察"这个原始 bug 机制已经不可能复现了，但当时真正的根因仍然没有查清楚。问用户是否要重新开放，用户回复"目前不需要侦察了，当时留着只是觉得要删的代码太多"——于是这次不是恢复，而是彻底删除整个功能，不再保留"方便快速恢复"的底层结构：

- **shared**：`MarchKind` 去掉 `'scout'`；`VISION_SCOUT_RADIUS` 常量整个删除（连带从 `VISION_MAX_RADIUS` 的 `Math.max(...)` 里去掉）。
- **worldsvc**：`MARCHABLE_KINDS` 去掉 `'scout'`；`combatMarch.ts` 删掉 §18.8.1 加的 `kind==='scout'` 拒绝分支（`MARCHABLE_KINDS.has(kind)` 的通用校验已经足够）+ 到达点分发分支 + `autoReturnScout()` 整个方法；`core/helpers.ts` 的 `marchVisionRadius()` 包装函数删除（唯一调用方 `core/vision.ts` 改为直接引用 `VISION_MARCH_RADIUS`）。
- **契约**：`openapi-world.yml` 两处 `kind` enum 去掉 `scout`；`transport.proto` 的 `MarchUpdate.kind` 注释同步；`gen:api:contracts`/`gen:api:world`/`gen:api:server`/`proto:gen`（client + botsvc/gameserver/gateway/metaserver 四份各自的生成产物）全部重跑。
- **client**：`DeployKind` 去掉 `'scout'`；`WorldMapNet.ts` 的 `doScout()` 整个方法删除；`WorldMapPanels.ts`/`WorldMapRenderer/fog.ts` 里的 scout 图标/配色分支删除；i18n 三语言（zh/en/de）去掉 `world.actScout`/`world.scoutSent`；连带清理了专为 scout 画的 `scope`（望远镜）图标（`IconKind`/`icons.ts`/`icons/slg.ts` 的 `drawScope`），确认零消费者后整个删除。
- **测试**：`server/worldsvc/test/scout.e2e.test.ts`（只剩"验证被拒绝"的 1 例）+ `client/test/ui/worldMapScoutDisabled.ui.ts`（验证菜单不再出现侦察按钮的 5 例）整个删除——两者都是在守护一个现在已经从类型层面就不可能发生的状态，`tsc` 本身就是更强的保证。顺带发现并修复了 `client/test/ui/modalScaleAndBackButton.ui.ts` 里 3 个断言仍用今天已修复的landscape 弹窗缩放旧公式（`(h*0.8)/mh`）算期望值的用例——这是 2026-07-30 landscape modal overscale 修复（见本文档另一节/`modal-scale-landscape-overscale-2026-07-22` memory）暴露出的遗留断言，一并更新为新公式。
- **验收**：server 12 个 workspace `tsc -b` 全绿；worldsvc 全量 e2e 46/47 文件绿（唯一失败 `field-encounter.e2e.test.ts` 单独重跑绿，判定为并发跑测的偶发波动，与本次改动无关，文件本身零 scout 引用）；client `tsc --noEmit` 全绿 + 全量 vitest（124 files/903 tests）+ 全量 UI vitest（96 files/824 tests）全绿。

### 18.9 瞭望塔（Watchtower）实现记录（2026-06-21，§18.1 V2 最后余项）

> 把 §18.1 V2「瞭望塔建筑——固定半径持久视野源」从「列 v2」兑现：在**己方领地**花资源建塔，该格升级为**最大半径**（`VISION_WATCHTOWER_RADIUS=8` > 主城 5）持久视野源。区别于 scout（一次性照路后回师）：瞭望塔是**主动布点扩视野**的永久手段——「想看哪、就在哪建塔守着」。落库随 `TileDoc`（丢地即随格子消失，无单独退还），符合 V3「vision 零落库，但塔标记本身落库、视野仍读时实时算」。

- **shared（`slg.ts`）**：`VISION_WATCHTOWER_RADIUS=8`（DRAFT，最大视野源）；`VISION_MAX_RADIUS=max(全部视野半径)`（外扩查询 pad 统一用，须覆盖最大半径源以免漏照视区边缘）；`WATCHTOWER_COST={food:0,iron:2000,wood:3000}`（DRAFT，资源非金币——视野扩张是建造行为）。
- **worldsvc（`db.ts`/`service.ts`）**：`TileDoc.watchtower?:boolean`。新 helper `tileVisionRadius(t)` = watchtower→8 / base→5 / 其余领地→2，`computeVisionSources` 与反向 `visionObservers` 的静态源半径统一走它（两处 pad `VISION_BASE_RADIUS`→`VISION_MAX_RADIUS`，否则瞭望塔半径外的塔照不亮视区边缘 / 反向漏查塔观察者）。新 `buildWatchtower(worldId,accountId,x,y)`：校验己方领地（`TILE_NOT_OWNED`）+ 非主城（`BAD_REQUEST`，主城自带视野）+ 结算后资源充足（`INSUFFICIENT_RESOURCES`，不足不动地图）；扣 `WATCHTOWER_COST` → `$set tile.watchtower=true` → 推 `tile_update`（owner refetch 触发新视野下次 getMap 生效）+ `pushTileToObservers`（塔是可见结构，视野内观察者亦见）。幂等：已有塔直接返回视图、不重复扣费。`tileDocView` 透出 `watchtower`。
- **契约**：`openapi-world.yml` `WorldTileView.watchtower` + `POST /world/watchtower`（返 `WorldTileView`）；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（建塔走 REST，视野扩张走既有 getMap/tile_update 读推路径）。
- **client（`WorldMapScene.ts`）**：己方领地（非主城）菜单加「建瞭望塔」按钮（已有塔则隐去、改在标题显「🗼 已建瞭望塔」）→ `confirmWatchtower`（展示资源花费二确认）→ `doWatchtower`（建塔 → 刷新 me 资源 + 清 tileCache 整块重拉显形扩张视野 + toast）；地图渲染：可见格 `tile.watchtower` 画手绘小塔（米白塔身 + 深墨三角顶）。`WorldApiClient.buildWatchtower`。i18n `world.actWatchtower`/`hasWatchtower`/`watchtowerTitle`/`watchtowerConfirm`/`watchtowerBtn`/`watchtowerBuilt`（zh/en/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿 + 312 测试通过（1 例 `headless-nav` 因 S9 成就 stub 缺 `applyAchievementBadge` 预先失败，与本片无关）；worldsvc **141 e2e**（新增 `watchtower.e2e.test.ts` 6 例：建塔扣资源+置标记+视图透出 / 扩视野原迷雾远格建塔后可见且超半径仍迷雾 / 非己方拒绝 / 主城拒绝 / 资源不足拒绝不动地图 / 幂等不重复扣费；既有 135 不破）。

> **G5 视野/迷雾全 ✅（2026-06-21）**：读路径门控（G5-1）+ 反向视野推送（G5-2）+ 客户端渲染（G5-3）+ 联盟领地黄标（§18.7）+ scout 侦察行军（§18.8）+ **瞭望塔建筑（§18.9）**。「加家族才守得住」的视野维度**完整闭环**——地形全见、敌情藏雾、家族共享、侦察行军照路（含深探斥候）、瞭望塔主动布点固定视野、敌军进视野即现、联盟领地黄描边勿攻。V2 余项全部兑现。

### 18.10 迷雾模型 2a → 2b：静态层全图公开、迷雾只藏情报与行军（2026-07-24 用户拍板）

> **动机**：三档缩放曾走两条服务端读路径——L1 详情 `getMap`（做 G5 视野门控）、L2/L3 概览 `getMapSparse`（**为性能跳过视野计算**，返回全部有主格）。结果：**同一片地图在 L2/L3 满是别人的基地，切到 L1 却全消失**（视野外的 base 被 `getMap` 退回程序化地形、type 不再是 `base`，客户端 `refreshCityLayer` 画不出；且 `getMap` 逐格覆盖会把 L2 缓存的稀疏 base 覆写成迷雾地形）。这是信息泄露式的不一致：战略概览泄露了详情视图刻意隐藏的占领信息。
>
> **拍板**：迷雾**只对地图上的行军队伍生效**，对建筑/基地不生效——玩家随时可以看到其他玩家**在什么位置**（位置/归属/名字/等级/占领状态全图公开），只是看不到别人**队伍的行军**，以及**未进视野的情报**（守军兵力/耐久/瞭望塔）。这与率土之滨一致（静态政治地图恒可见、行军藏雾）。

- **server（`core/map.ts`）**：
  - 新 helper `gateIntel(view, inVision)`：视野内原样返回；视野外只**剥离情报字段** `garrison` / `hp` / `maxHp` / `watchtower`（结构照常返回）。行军已在 `getMarches`（己方 + 视野内敌方）门控，无需改。
  - `getMap`：删掉「视野外退回程序化地形 + `visible:false`」的整段——现在逐格恒返回完整 `tileDocView`（归属/base/occupied），只过 `gateIntel(view, vis(x,y))`，`visible` 恒 `true`。`ally`/`allySect` 标记也改为**不分视野**计算（派生自现已公开的归属 + 自己已知的宗盟关系，视为公开的政治色）。他人档案（名字）拉取去掉 `vis()` 过滤（归属公开→名字全图显）。
  - `getTile`：同口径——结构公开、`gateIntel` 只藏情报。
  - `WorldTileView.visible` 语义：自此**恒为 true**（静态层不再整格门控），保留字段仅为客户端兼容（客户端只在 `=== false` 时变暗，故恒 true → 不变暗，正合「静态地图无雾」）。见 `worldTypes.ts` 注释。
- **client**：**零改动**。`visible:true` 使 `pool.ts` 的 `fogged` 恒 false → 底图不再变暗；`city.ts refreshCityLayer` 本就不看 `visible`，base 精灵按 `type==='base'` 恒绘。
- **验收**：worldsvc `tsc --noEmit` 绿；`fog.e2e`（5）/`watchtower.e2e`（6）/`alliance-mark.e2e`（3）全绿。三处**视野探针从 `visible` 改为情报（`maxHp`）**：`fog` 视野外敌 base 现断言 `type:base + occupied + visible:true` 但 `garrison/hp/maxHp/watchtower` 全 undefined、march 照亮改测敌 base 的 `maxHp` 显形；`watchtower` 扩视野改测敌领地 `maxHp` 由 undefined→>0；`alliance` 远处联盟领地现 `allySect` 标记公开、仅 `maxHp` 藏雾。（`pathfinding.test.ts` 2 例失败为既有 seed-pool flake，与本改无关。）

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
- **⚠️ 未解决 gap：核心州永远 0 险地（2026-07-22 体检发现）**：`mapgen.ts:465` 生成险地的门控是 `distToCap > SLG_GEN.strongholdMinDistRatio`（=0.25，`core.ts:277`，距最近州府的归一化距离）。但**核心州**（core province）的州府就在地图中心，核心州半径 `PROVINCE_CORE_RADIUS_RATIO=0.11`（`province.ts`）< 0.25 → 核心州内所有格子 `distToCap ≤ 0.11` 恒不满足门控 → **核心州永不生成险地**。这与「核心州是终局争夺焦点」的设计意图相悖（本该险地更密）。修复方向：门控改为「距**本州州府**的距离」或对核心州单列阈值。**尚未修复**，登记待办。

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

**背景**：`server/shared/src/slg.ts` 已按 ADR-034「角度扇区+地形+城池」模型整体重写（`provinceIdxAt()`/`provinceCapitalPositions()`/环形地形带+墨河弦+支脉/州府+世界中心+关隘城池+分级城池节点/按环等级分布表，替换旧的 `CAPITAL_FRACTIONS`/`NATION_KIND_BY_IDX`(hegemony→core)/`proceduralTile()`/`nearestCapitalIdx()`），worldsvc 受影响的消费方（`core/kernel`/`core/nation`/`core/yield`/`combatSiege`）与 e2e 测试已同步修完，`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+test 全绿。城池驻军/耐久数值、资源州/核心州分级城池梯度、`tools/map-editor` 编辑器工程本身仍是开放项，留后续任务（见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §5/§6）。本节继续记录地图存储/编辑器架构，供编辑器工程落地时遵循。

**两层分离**：
- **Layer A「地图模板」（设计期产物，低频改动）**：程序生成的原始地形/城池布局只是初稿，不一定符合要求，允许人工在编辑器里精修定稿——这是权威数据源，不是运行时状态。
- **Layer B「世界实例状态」（运行时，高频改动）**：占领/建筑/驻军等玩家行为，沿用现有的稀疏 `TileDoc` 覆盖机制（S8-0 起就有），只是覆盖对象要从「程序生成结果」改成「引用某个 `templateId` 的模板基线」。

**Layer A 落地方案**：
- 模板做成**按格子可寻址的集合**（类似 TileDoc 但用于模板而非运行时）。
- **首包生成走服务器端**：admin 加一个「生成模板」endpoint，内部按 size 跑 `proceduralTile()` 批量写入模板集合种子数据；`proceduralTile()` 之后只用于这个一次性种子生成，不再作为运行时合并路径。
- **编辑器工作流**：每次打开从数据库取最新地形（不是每次重新生成，也不是本地文件）；保存时**只上发本次改动的格子（diff）**，做 upsert，不整图重传。
- **多尺寸模板并存**（现 1500×1500，ADR-049 起从 500×500 放大）：模板集合按 `templateId`（含 size/版本）区分；一个 world 实例创建时引用某个 `templateId` 作为地图基线。
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
  2. ~~`mapBaselines` 只是被写入，读取路径尚未接入~~——已接线（2026-07-06）：`WorldCoreMap.getMap`/`getTile`（`server/worldsvc/src/core/map.ts`）在 TileDoc 未命中时先查该世界的 `mapBaselines`（键 `worldId:x:y`）作为地形基线，只有无基线行时才回退 `proceduralTile()`。`getMap` 沿用 viewport bbox 批量拉基线（与 tiles 拉取同形状，不走逐格查询）；`getTile` 单格 `findOne` 与 override 并行取。视野/迷雾门控不变（地形层从不被雾隐藏）。这样编辑器发布并激活的模板改动（画的河/山、移动的城池），经世界开局克隆后即在运行时地图可见。e2e 见 `server/worldsvc/test/map-template.e2e.test.ts`（已被克隆世界的改动可读回；无基线世界回退 `proceduralTile`）。art-parity 的 `obstacleKind`（river/mountain 美术区分）已随本次一并打通端到端：`MapTemplateTileDoc`/`MapBaselineTileDoc` 加字段，`mapTemplateService` 四处 doc 映射（generate/getTiles/saveTilesDiff/clone）+ `core/map.terrainView` + `WorldTileView` + `openapi-world.yml`（含 worldsvc/client 两侧 codegen）全部带上；客户端 `WorldMapRenderer` 改为**优先用服务端 tile.obstacleKind**，只有服务端没给（无基线行）才回退本地 `proceduralTile`——修正了原先"障碍恒为程序化、无需过网"的假设（基线编辑后该假设不成立）。日后若再给 `MapTemplateTile` 增地形字段，按同一条链补齐即可。
  3. ~~编辑器前端（真正的地图编辑 UI 工具）尚未开工~~——已接线（2026-07-05，见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"栅格化 + 发布到服务端模板"/"模板列表 + Activate/Delete"）：`tools/map-editor` 新增 `src/api.ts`（Bearer token 登录）调用本节列出的全部 6 个 endpoint（list/generate/get-tiles 未用/save-tiles-diff/activate/delete）。编辑器侧的地形格子（2026-07-06 起河流/山脉是直接格子笔刷，不再是矢量路径——见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"矢量路径笔刷改为直接格子笔刷"）/城池图层通过 `server/shared/src/slg/mapEdit.ts::rasterizeMapEdits()` 一次性栅格化成 tile diff 再发布——单向烘焙，不做"从模板读回图层"的反向同步（模板存储不区分"原始生成值"和"编辑覆盖值"，物理上无法可靠反推）；模板列表面板目前只展示元数据（`getMapTemplateTiles` 的 viewport 读取暂未接线，非当前需要）。
  4. **✅ 2026-07-27 存储重设计（行程编码，2026-07-27 Mongo/Redis 审计中期项第 2 项）**：本节 992 行原设计"逐格可寻址集合"在 1500×1500（ADR-049）尺度下意味着 `generateTemplate()` 一次性物化 225 万文档（`mapTemplateTiles`），`cloneActiveTemplateInto` 每次开服/重置又把这份稠密数据原样搬一遍到 `mapBaselines`（再 225 万条）——真正的病根是"首包生成即物化"这条 992 行当初拍板的设计，不是克隆本身。地形有大量连续同值的横向条带（河/山是连续带，资源/中立地块之间只稀疏散落特殊格），于是改行程编码（RLE）：`server/shared/src/slg/mapRle.ts` 新增 `encodeRow`/`decodeRow`/`tileAtX`/`sliceRuns`/`applyEditsToRow` 纯函数；存储从"每格一个文档"改成"每**行**一个文档、行内一组 `{x0,x1,type,level,resType?,obstacleKind?}` 压缩区间"——集合改名 `mapTemplateTiles`→`mapTemplateRows`、`mapBaselines`→`mapBaselineRows`（**改名而非原地换 shape**：旧文档 `_id` 是 `id:x:y`、新文档是 `id:y`，同名同 collection 里新旧格式共存会让新代码的 `{worldId,y:范围}` 查询意外命中旧的稠密文档而在解 `.runs` 时崩——用新集合名彻底避免这个陷阱）。外部契约（`MapTemplateTile` 单格 `{x,y,type,level,...}`、`getTiles`/`saveTilesDiff` 的 API 形状、`tileCount` 统计口径）完全不变，压缩/解压全部封装在 `mapTemplateService.ts`/`core/map.ts` 内部——读路径本来就是 viewport 批量查询（不是逐格 N+1），只是查询维度从"按 x+y 范围"简化成"按 y 范围"，行内 x 范围在内存里切片。迁移脚本 `server/worldsvc/scripts/migrateMapBaselinesToRle.ts`（幂等、可重跑，**不删旧集合**，留給 ops 确认新集合读取正常后手动清理）——若从未真正激活过自定义模板（`mapBaselines`/`mapTemplateTiles` 本来就是空的），无需迁移，新代码在"无激活模板"分支下行为不变。验证：`server/shared/test/mapRle.test.ts`（14 例，纯函数覆盖）+ `server/worldsvc/test/map-template.e2e.test.ts`（9 例，重写了直接查裸集合形状的断言，新增一条"10×10 模板只落地 10 行文档而非 100 个格子文档"的回归锁定）；shared 647/647、worldsvc 341/341 全绿。

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
- 服务端：`TerritoryService.listTerritories()`（`territory.ts`）复用 `core/yield.ts` 已有的 `cols.tiles.find({worldId, ownerId, type:{$ne:'base'}})` 查询模式，经 `service.ts` 委托、`httpApi.ts` `GET /world/territories` 暴露；`openapi-world.yml` 新增端点定义（复用既有 `WorldTileView` schema，未新建 schema），`gen:api:world` + `gen:api:contracts` + 客户端 `rest:gen` 三步codegen 全部重跑同步。
- 客户端：`WorldMapContext` 新增 `territoryPanelOpen`/`territoryTab`/`territories`/`territoryHiddenLevels`/`resClusterRect`；`beginScrollList()` 顺带泛化出 `ctx.infoScrollRerender` 回调（原先滚动拖拽/滚轮硬编码调 `renderInfoPanel()`，现在按打开的是哪个面板调用对应的渲染函数，World-info 和 Territory Overview 两个弹层共用同一套滚动输入代码不用分叉）；等级过滤 checkbox 直接注册为普通 `modalBtnRects` 项（勾选即 toggle + 重渲染），不需要新的命中判定分支；跳转复用 `centerAt` 并额外 `closeModal()`（列表在弹层里，跳转后应看地图）；放弃改走新增的 `WorldMapNet.doAbandonFromList()`（区别于原 `doAbandon()`：不 `closeModal()`，放弃后原地刷新列表，不打断玩家继续处理其他行）。
- 测试：`server/worldsvc/test/territories.e2e.test.ts`（5 例，真实 Mongo）——未入世界拒绝、已加入无领地返回空、领地行字段正确且排除 3×3 主城 footprint、跨玩家隔离、放弃后从列表消失。`client/test/ui/worldMapTerritoryPanel.ui.ts`（12 例，PIXI headless）——开面板守卫（未入世界→toast 不开面板）、总览页无滚动区、切到列表 Tab 触发一次性拉取、等级 checkbox 勾选/取消的行数变化（按 `modalBtnRects` 长度断言，不深入渲染内容）、跳转关闭弹层+居中地图、放弃调用 `net.doAbandonFromList` 且不关弹层。另修了 `worldMapHeaderInset.ui.ts` 手搭假 ctx 缺 `resClusterRect` 字段导致的 3 例失败（`zeroRect()` 补齐）。`tsc --noEmit` + `webpack --mode production` + worldsvc 全套（31 文件 235 例）+ client `test:ui` 全套（52 文件 490 例）均绿；浏览器截图人工核对总览/列表/过滤/跳转/放弃交互，细节见会话记录。

**World-info 合并进第三 Tab + 面板加高（2026-07-16）**：用户截图标注反馈两点——右上角单独的 World 按钮/弹层和领地总览面板功能重叠，应合并；面板偏矮，内容常需要滚动。改动：`renderHud()` 删除原独立的 World 按钮渲染块与 `ctx.infoBtnRect` 命中矩形，`WorldMapInput.ts` 对应的点击分支一并移除；`renderTerritoryPanel()` 的 Tab 数组新增第三项 `world`（`territoryTab` 类型相应扩为 `'overview' | 'list' | 'world'`），点击后渲染原 `renderInfoPanel()` 的 nations/season/shop 三个二级 Tab——抽成新的私有方法 `renderWorldTabBody()`，直接画进总览面板已有的弹层区域（不再单独起 dim/panel/title/关闭按钮）；`openInfoPanel()` 整个方法删除，原先「首次打开时懒加载 shop 目录 + nations」的逻辑搬进新增的 `loadWorldTabData()`，由 `switchTerritoryTab('world')` 触发；`doBuyShopItem`/`doRename`（`WorldMapNet.ts`）刷新面板的判断条件相应改成 `territoryPanelOpen && territoryTab === 'world'`。面板高度从固定 `min(460, …)` 改为页面高度的 80%（`h * 0.8`，仍 cap 到不遮挡底部 HUD）。验证：`tsc --noEmit` + `webpack --mode development` 全绿；用临时 `__NW_WorldMapPanels` 调试钩子（挂在 `app.ts`，验证后已移除）在真实 dev server 里手搭最小 ctx 直接调 `renderTerritoryPanel()`，截图确认三个 Tab（总览/领地/World）+ World Tab 下 nations/season/shop 二级 Tab 正常显示、面板高度明显变高。

**总览可读性放大（2026-07-16）**：用户反馈资源界面偏窄偏小。`renderTerritoryPanel()` 面板宽度上限从 `min(420, w-20)` 提到 `min(840, w-20)`（窄屏仍钳到 `w-20`，真机不溢出）；总览页文字约 2×——资源行/赛季·人口行用 `FS.label`（24）、强调的兵力/领地行用 `FS.heading`（28），行距同步加倍（20→40、22→44、26→52、18→36）以免重叠。仅影响总览 Tab；列表/World 两个 Tab 共用同一 `pw` 会一起变宽，内部字号未动。验证：`tsc --noEmit` 绿；临时 `?terrpanel` 调试入口（构造真实 `WorldMapScene` + 假数据，`forceCanvas` 抓图，验证后已移除）截图确认字号翻倍、面板加宽、无重叠裁切。

**领地列表排序/驻军可读性/放弃二次确认（2026-07-18）**：用户截图指出列表 Tab 的等级过滤按钮与实际行序对不上——过滤按钮是勾选开关，行序却是原始拉取顺序，Lv.1/Lv.2 交替出现，读起来像分组渲染 bug。同时解决 §26 遗留的「未决」排序问题。改动（均在 `renderTerritoryPanel()`）：
1. 列表改为按 `level` 升序、同级按坐标排序，与过滤按钮的等级分组语义对齐。
2. 等级过滤按钮标签加计数，如 `Lv.1 (12)`，勾选前就能看到该等级有多少格，不用逐个数。
3. 驻军数值低于当前过滤结果集中位数一半时文字变红——阈值取当次列表的中位数而非写死绝对值，避免不同账号规模下失真。
4. 「放弃」不再直接调用 `doAbandonFromList`，先弹二次确认（复用 `panelButton` 在 `ctx.territoryAbandonConfirm` 非空时整体替换面板内容，避免遮挡态下误触底层按钮）；确认态复用面板已有的 dim+panel 外框，只替换正文为提示语 + 确定/取消。`WorldMapContext` 新增 `territoryAbandonConfirm: {x,y} | null` 字段；`world.abandonConfirm` i18n key（zh/en/de）。验证：`tsc --noEmit` 绿；临时 `?territorydbg` 调试入口（`territoryDebug.ts`，直接构造 `WorldMapScene` + reject-fast `WorldApiClient` stub + 18 行假数据，验证后已移除）在真实 dev server 里截图确认排序分组正确、过滤按钮计数、驻军红字、确认弹窗文案与按钮布局，以及 Cancel 能正确清空确认态回到列表。

**过滤按钮换行策略 + 红字驻军提示语（2026-07-20）**：用户截图反馈两点——① 等级过滤按钮固定拆两行（`perRow = ceil(levels/2)`），账号等级种类少（如只有 Lv.1/Lv.2）时每个按钮被拉伸到几乎占满一整行；② 领地行坐标标红（低驻军预警，见上条 #3）在面板上没有任何文字说明，用户看不出红色代表什么。改动（`renderTerritoryPanel()`）：
1. 过滤按钮改为每行最多 5 个（`perRow = min(5, levels.length)`），超过 5 个等级才换到下一行，行数按实际等级数动态算（`rows = ceil(levels.length / perRow)`），不再写死 2 行。
2. 列表区顶部加一行灰色提示文字（`world.weakGarrisonHint`，`FS.tiny`/`C.mid`）："红色坐标：驻军低于列表中位数一半，建议增兵"，zh/en/de 三语。验证：`tsc --noEmit` 对改动文件绿；`SceneManager.ts` 当时有另一会话在建的 overlay 重构导致编译错误，未能启动 dev server 截图核实，用户确认按已知在建 WIP 处理、跳过截图。

---

## 27. 险地/关隘战力模拟补测（2026-07-16，DRAFT 数值收尾）

> 背景：项目体检发现 `STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL`/`CROSSING_GARRISON_PER_LEVEL` 四个常量仍带 DRAFT 标记（§15.3/§19.5）。前三者中，`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL` 的经济面早已被 `strongholdRun.ts`（§13-SLG-STRONGHOLD.2-4）核验过，只是源码注释没跟着更新；真正从未验证过的是「这些守军数值到底能不能打下来」——原注释只是一段手估 HP 对比，没有真跑过引擎。

**新增战力模拟脚本**（`server/tools/econ-sim/src/strongholdCombat.ts` + `strongholdCombatRun.ts`，`npx tsx src/strongholdCombatRun.ts`）：复用真实 `@nw/engine` 攻城引擎（自成一体，标准同 `client/test/pvpSim.ts`——独立于 worldsvc 直接调用 `@nw/engine` 原语，而非 import worldsvc 内部模块，因为后者会把 `tsc --noEmit` 的 rootDir 拉出包边界）。

**关键发现**：
1. **险地/关隘实际等级是固定值，不是文档暗示的 1..5 区间**：险地恒生成于 `SLG_MAP_MAX_LEVEL`（现 10，ADR-032 起从 5 涨上来的）→ 守军恒 3,600 兵；自动关隘恒生成于 `max(2, SLG_MAP_MAX_LEVEL-1)`（现 9）→ 守军恒 1,800 兵。`siege.ts` 旧注释仍写"满级 5→1800"，是地图上限上调后没跟着改的过时描述，本轮已订正。
2. **战力校验通过**：险地——新手（troopCap=2000）0% 胜率，小额投入（troopCap≈4500，练兵场约 3 级）100% 胜率；关隘——新手 0%，练兵场仅 1 级（troopCap=3000）即 100%（比险地更早开放，符合"较轻关卡"设计意图）。两个常量**均保持不变**，DRAFT 标记已从 `shared/src/slg/siege.ts` 源码注释移除，换成本次核验依据（详见 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5）。
3. **⚠️ 新发现的独立 gap（非本轮数值范围）**：单次出征兵力超过约 9,600（= 10 攻击车道 × 16 可生成行 × 60 血/兵，棋盘纵深耗尽）时，`synthesizeArmy` 轮转铺兵会让胜负变得非单调（例如 9,000 兵败、9,600 兵胜、10,000 兵又败），根源是兵力在车道内拥堵导致战斗超时，与守军强度无关。`SIEGE_CHEAP_RATIO`（`shared/slg/siege.ts`）本该把这种悬殊对局挡在真实引擎之外，但 `combatSiege/arrival.ts` 的险地/关隘围攻从未做这个比率检查，无条件跑 `runSiegeBattle`——满练兵场+满行囊（satchel，均可堆到 12,000）玩家单次出征在生产环境就可能撞上这个问题。这是路由/工程缺口，不是「调大调小某个常量」能解决的，已登记为独立后续任务（不在本轮范围内处理）。

**结论**：`STRONGHOLD_GARRISON_PER_LEVEL=360`、`CROSSING_GARRISON_PER_LEVEL=200`、`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4` 三处 DRAFT 标记均已清除（前者战力实测通过，后者经济稀释早已通过只是注释未同步）；`STRONGHOLD_LOOT_PER_LEVEL=5000` 本就非 DRAFT（季内一次性、已有 sanity check）。四项收尾完成，SLG 待调参数值清单清空。

> **⚠️→✅ 已按新基线重跑（2026-07-27）**：上文第 2 点「新手（troopCap=2000）0% 胜率」的前提确认已失效——`strongholdCombatRun.ts` 的 `SCENARIO_BASE.troops` 直接 import `TROOP_CAP_BASE`，无需改代码即反映新基线，重跑结果：新手（troops=10,000）对险地（守军 3,600）和关隘（守军 1,800）**均 100% 胜率**，"几乎打不过，小额投入即可攻克"的设计意图（§3.1）在当前常量组合下完全不成立——`STRONGHOLD_GARRISON_PER_LEVEL=360`/`CROSSING_GARRISON_PER_LEVEL=200` 需要重新拍板（数量级参考：若要恢复原设计手感，两者大致都需要与 `TROOP_CAP_BASE` 同倍数放大）。第 3 点/Follow-up 中「satchel 可堆到 12,000」现为 **20,000**（`SATCHEL_CARRY_BASE=10000 + 10×1000`）、`SIEGE_SYNTH_ARMY_MAX_TROOPS=9,600` 的 cheap-siege 兜底相应更常触发（未变）。详细数据见 [`ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5](ECONOMY_VERIFICATION_LOG.md) 重跑记录；已 `spawn_task` 登记为独立后续项。旧版 troopCap=2000 战力结论按历史记录保留，不要再引用为当前结论。

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

### 28.6 修复：转区/合区未清理 `stationed` 集合 + Redis occ/cover 索引（2026-07-27，design-doc-audit-2026-07）

> §28.4 的 TRANSFER_BUSY 阻挡只查了 `marches`/`occupations` 两个集合，`vacatShard`（经 `purgePlayerWorld`）也只删 `tiles`/`playerWorld` 两个集合——`stationed`（2026-07-23 新增的"停留在外"字段部队，`combatMarch.ts`）从一开始就不在两条路径的视野内，本次审计逐代码核实后确认是真实 bug，非误报：

- **玩家主动转区（`transferShard`）此前完全不受 stationed 阻挡**：一名有队伍停留在外（`StationedDoc`）的玩家可以直接转区离开，走后留下的 `StationedDoc` 变成**永久幽灵**——没有 `playerWorld` 文档认领它，玩家自己也再摸不到这个已离开的 shard 去调用 `recallStationed`；该队伍站的格子按"一格一队"规则被永久占用（`combatMarch.ts` 的 `TILE_OCCUPIED` 检查），其他任何人都不能再在那格停留部队；若该队伍是 `garrison` 模式，Redis `cover` 9 格反向索引里的驻防区也一并变成永久幽灵，理论上会一直"拦截"路过的行军。
- **合区（`mergeShard`）同理**：强制清场时只 `deleteMany` 了 `marches`/`occupations`，`stationed` 文档连同它们的 Redis `occ`/`cover` 条目完全没清——虽然源 shard 随后 `closed`（不再路由新加入，游戏性影响较小），但幽灵文档会一直堆在数据库里，且如果同一 worldId 字符串未来被复用（当前代码未见复用保护），幽灵索引可能对新 shard 产生数据污染。
- **修复**：`server/worldsvc/src/transfer.ts`——① `transferShard` 的忙碌检查从"march+occupation"扩到"march+occupation+stationed"（`Promise.all` 并发查询，三者任一存在即 `TRANSFER_BUSY`，与既有 march/occupation 阻挡语义一致：玩家必须先 `recallStationed` 再转区）；② `mergeShard` 的强制清场块新增：先查出该玩家在源 shard 的全部 `StationedDoc`，`deleteMany` 前逐条调用 `core.clearOccupancy`（清 Redis occ 条目）+ `mode==='garrison'` 时额外调用 `core.removeCover`（清 9 格反向索引），再删 Mongo 文档——顺序与 `recallStationed`（正常玩家自己触发的清理路径）保持一致，只是这里是批量强制版本。
- **回归测试**：`server/worldsvc/test/transfer.e2e.test.ts` 新增两例——「stationed 队伍阻挡转区，recall（删除文档）后放行」+「合区强制清理 stationed，源 shard 里不留幽灵文档」；两例改动前跑会失败（转区不受阻挡 / 合区后文档仍在），改动后随全量 20 例（含原 18 例）绿。`@nw/shared` 633 例 + worldsvc 339 例全量无回归。
- **未覆盖**：本次测试环境 `redis: null`（沿用既有 e2e 约定，`clearOccupancy`/`removeCover` 对 `redis: null` 静默降级不报错），故只在 Mongo 层面断言了 `StationedDoc` 确实被清空；Redis occ/cover 条目的清理调用路径与 `recallStationed`（已在生产验证过的正常清理路径）完全一致，逻辑上可信，但没有专门起一个真实 Redis 的 e2e 去断言 hash 条目消失——如果未来要做，需要一个带 `ioredis-mock` 或真实 Redis 容器的测试环境。

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

**验收**：shared/engine/worldsvc/client `tsc` 全绿；shared siege 单测 39/39（+npcBaseHp/defenderBaseHp 用例）；engine 66/66（+siege defenderBaseHp 初始化用例）；worldsvc occupy/base-siege/siege/stronghold/passage/cheap-fallback e2e 全绿（无结果翻盘）；econ-sim `tsc --noEmit` 通过。

**2026-07-22 更正**：上面"数值仍 DRAFT"已过期——`occupyBaseHpRun.ts` 补测了装备/学院攻城 hp 加成（0%/10%/20% 三档）叠加后曲线依然逐级单调、不溢出棋盘容量，且敏感度复测证实这个力量比区间下 hp 加成对胜负确无可测量影响（不是步进粒度掩盖）。`40×level` 系数**转正，DRAFT 标记已从 `siege.ts` 源码注释移除**，详见 `ECONOMY_VERIFICATION_LOG.md §13-SLG-NPC-BASEHP`。

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

## 31. 出征队伍保存必现校验失败修复 + 旧格式兼容代码删除（2026-07-18）

**背景（用户报告的错误）**：`DefenseEditorScene`（attack 模式）保存队伍时必现 `Team formation is invalid: level.attackerArmy[0].unitType: expected a string, got undefined`。

**根因**：卡牌迁移（commit `a91bb018`）之后 `DefenseEditorScene.buildArmy()` 只发送 `{cardInstanceId, col, row}`（无 `unitType`），但 `server/worldsvc/src/city.ts` 的 `setTeams` 从未跟着改——`validateAttackerArmy(team.army)` 把这个原始数组直接打包进 `level.attackerArmy` 走引擎 `parseLevelDefinition` 校验，而该校验要求每条 entry 必须有字符串 `unitType`。也就是说**卡牌迁移之后，任何带卡牌的出征队伍保存都必现此错误**，且校验发生在 `pw`（含 `cardInv` 所需的 `cardState`）取出**之前**，根本没机会解析 `cardInstanceId → unitType`。

**修复**（用户拍板：错误数据直接丢弃+把卡牌还给玩家空闲状态，不保留旧格式兼容代码）：
- `server/worldsvc/src/siegeEngine.ts`：新增 `sanitizeCardArmy(army, cardInv)`——过滤掉任何无法解析出真实卡牌的 entry（无 `cardInstanceId`，或引用了玩家已不再拥有的卡牌），返回净化后的 `ArmyEntry[]` + 已解析的 `{unitType,col,row}[]`；`validateAttackerArmy` 改为只接收已解析好的 `{unitType,col,row}`（不再检查 `initialHp`——0 兵力的新分配卡牌是合法状态，不该在保存时被当成格式错误拒绝）。`resolveCardArmy` 里"无 `cardInstanceId` 走 legacy unitType"的兼容分支整个删除。
- `server/worldsvc/src/city.ts`：`setTeams` 改为先取 `pw` + `meta.getSaveFields()`（拿不到 `cardInv` 就报 `INTERNAL` 重试，而不是把队伍当空处理——防止 metaserver 抖动时误删真实数据）→ 净化每个队伍的 `army` → 校验净化后的数据 → 保存。被丢弃的卡牌复用已有的"移出队伍"逻辑（`buildCardRemovalPatch`）自动清空 `teamId`、扣空 `currentTroops`、退 80% 训练资源——即"空闲状态"。`getTeams` 同步做一次自愈：读取时净化数据库里已存在的脏数据（如迁移前遗留的旧队伍）并回写一次，之后不再重复触发；`meta` 不可用时原样返回，不做破坏性清空。
- 客户端 `client/src/game/meta/teamTroops.ts` 的 `isLegacyTeam`（已是死代码，生产 UI 早已无引用——`TeamsScene.ts` 在更早的重构里被删掉了）连同测试一并删除。

**测试**：`server/worldsvc/test/teams.e2e.test.ts` + `card-slg.e2e.test.ts` 里引用旧原始 `{unitType,initialHp}` 格式的用例（迁移后从未更新过）改成卡牌格式；新增 3 例覆盖本次修复的实际行为——`setTeams` 丢弃失效 `cardInstanceId`（卡牌已被消耗/喂卡）并释放退款、`getTeams` 自愈直接写入数据库的脏数据并释放退款（幂等，不重复退款）、`meta` 不可用时 `setTeams`/`getTeams` 均不破坏已存数据。worldsvc 全量 e2e 串行跑通（33 文件 / 284 例）；client/server `tsc --noEmit` 全绿。

## 32. 空闲队伍门禁的并发竞态加固（同一队伍被派出两次）（2026-07-22）

**背景（用户报告）**：只有两支队伍，`Marches (3)` 却出现三条行军单，队伍 2 被派出了两次。§16.9「空闲队伍校验」（2026-07-15，见 §上）本应保证「一支队伍同时只能有一个状态、不能重复出征」，但仍被绕过。

**根因**：`combatMarch.ts` 的 `startMarch` 是**先查后插**——先 `findOne(marches)`+`findOne(occupations)` 判队伍是否忙碌（无命中才继续），最后才 `insertOne` 落行军单。两步之间隔着多个 `await`，Node 事件循环会把两个几乎同时到达的同队伍出征请求交错处理：两者的 `findOne` 都在对方 `insertOne` 之前返回"空闲"，于是双双插入 → 同一队伍两条行军单。触发路径是客户端的在途窗口：玩家给格子 A 选了队伍 2 出征，服务端还没返回、`ctx.marches` 未刷新前，又给格子 B 选同一支队伍 2——`showTeamPicker` 的忙碌灰显只看 `ctx.marches`/`ctx.occupations`，此刻两者都还不含这笔在途单。

**修复（双层）**：
- **客户端**（`client/src/scenes/worldmap/WorldMapNet.ts`）：新增 `pendingTeamIds` 集合，`doMarchTeam` 在发请求前把 `teamId` 记为 in-flight、`finally` 里移除；`showTeamPicker` 的 `busyTeamIds` 并入 `pendingTeamIds`，`doMarchTeam` 开头也再挡一道（命中直接提示 `team.busy`）。堵住"响应回来前二次派同一队伍"的人类快速点击窗口。
- **服务端**（权威兜底，`server/worldsvc/src/db.ts` + `combatMarch.ts`）：`marches` 集合加 `{worldId,ownerId,teamId}` **partial-unique 索引**（`partialFilterExpression: {teamId:{$exists:true}}`）。带队行军单是集合里**唯一**带 `teamId` 的文档——散兵行军无 `teamId`、撤军是改写同一 `_id` 成 return 腿、到点行军单 `findOneAndDelete`——所以该索引原子地禁止「同队伍第二条在途行军单」，正好补上先查后插关不掉的竞态。`startMarch` 的 `insertOne` 捕获 E11000 → 抛 `TEAM_BUSY`（此时尚未扣兵力池，玩家状态无副作用）。索引构建 best-effort try/catch 包裹：万一线上已存在本 bug 造成的重复在途单导致建索引失败，只告警不 crash 启动（行军单几分钟内到点消解，下次重启即可建成；期间靠 `findOne` 预检 + E11000 兜底）。

**验证**：client + worldsvc `tsc --noEmit` 全绿。竞态本身依赖并发时序、preview 无法稳定复现，改动为逻辑门禁层。

## 33. 占领无主地误报「领地失守」修复（2026-07-22）

**背景（用户报告）**：每次占领（occupy）一块**本就不属于自己**的地块时，屏幕都会闪一次「领地失守」（`world.defendLost`）的提示。

**根因**：自 ADR-037 起，occupy 到达会先与目标格的 NPC 守军打一场权威 PvE 战斗（`combatSiege/occupation.ts` `applyOccupy`），打赢即进入占领驻守倒计时（`startOccupationHold`），并向**占领者本人**推送一条 `SiegeResult`（`outcome:'attacker_win'`，`pushSiege(m.ownerId,…)`）。但客户端 `WorldMapNet.applySiegeResult` 只凭 `myAttackTiles.has(tile)` 区分「这仗是我打的还是我在被打」，而 `myAttackTiles` 只在 `kind==='attack'` 时记录目标格（`doMarch`/`doMarchTeam`）——**occupy 从未登记**。于是玩家自己的占领结果落进「我是防守方」分支，看到 `attacker_win` 就弹「领地失守」；占领失败时同样错判成「守土成功」（`world.defendHeld`）。

**修复（纯客户端）**：
- `WorldMapContext` 新增 `myOccupyTiles` 集合，与 `myAttackTiles` 并列但语义分开（占领是「我主动去打」而非「敌人打我」）。
- `doMarch`/`doMarchTeam` 在 `kind==='occupy'` 时把目标格记入 `myOccupyTiles`。
- `applySiegeResult` 增加 occupy 分支：命中 `myOccupyTiles` → 轻量 toast（打赢 `world.occupyWin`「占领得手，驻守中」/ 未赢 `world.occupyLoss`「占领失败」），收到即从集合移除；**不弹**围攻复盘弹窗（占领是高频扩张动作，不像 PvP 围攻值得每次弹窗+复盘）。三语文案齐备。

**验证**：client `tsc --noEmit` 全绿；新增 `worldMapSiegeResultToast.ui.ts`（6 例：占领胜/败分类、消费后不复触发，及 attack/防守两条原路径回归），占领选队测试补 `myOccupyTiles` mock。preview 无法稳定复现（需完整 worldsvc + 连地相邻 + NPC 战斗），改动为纯分类/展示层，靠单测覆盖。

## 34. 地图尺寸放大 500×500 → 1500×1500（ADR-049，2026-07-22）

**背景（用户报告）**：最远缩放档（L3，一屏约 96×50 格）下整张 500×500 地图约只有三屏大小，10 个州（ADR-034 环形布局：6 外围+3 资源+1 霸业）+ 险地/州府/城池等 PvE 关卡内容"展示不开"，视觉上过于局促。用户拍板对齐主流 SLG 常见量级 **1500×1500**。

**改动本体**：`server/shared/src/slg/core.ts` 的 `SLG_MAP_W`/`SLG_MAP_H` 由 500 → **1500**（225 万格）。这是唯一的"内容"改动——全部下游几何均为比率制（州环半径 `PROVINCE_*_RADIUS_RATIO`、州府 `provinceCapitalPositions` 用 `halfDiag`、地块等级 `_normRadius`、险地/资源密度逐格 Bernoulli），随尺寸**等比缩放**：密度不变，只是画布变大。险地数（p≈0.003）~750 → ~6750，州府/城池节点仍固定 10/54 个（角度环形，与面积无关）。

**为什么无性能回归（改前已核实）**：① 地块**稀疏落库**（只存被占/改动格），`proceduralTile` 按视口即时算，DB 不会凭空多出 225 万文档；② 视野/渲染均为**视口 bbox 限定的 Mongo 查询 + clamp 循环**，无 O(mapW·mapH) 全图遍历——`core/vision.computeVisionSources`（含 getMarches 传全图范围时也只按 `ownerId` 索引返回自己/家族格）、客户端 `occupyFrontier`/`fog` 循环均 clamp 到视口；③ `_worldCityNodes` 固定 54 节点带缓存；④ A\* 行军 `findMarchPath` 有 `MAX_NODES=500_000` 安全帽（1500² 下=全图 22%，合法长途行军够用；触顶 → `null` → `combatMarch` 干净抛 `PATH_BLOCKED`，不挂起）。U14 A\* 关注点在更大图上略升但受帽约束，登记为监控项（SLG_DESIGN §U14）。

**运维生效路径（关键陷阱）**：`mapW/mapH` 在 `openSeason` 经 `$setOnInsert` **写死进 world 文档**，`getSeason` 返回存库值——故仅改常量**不会自动改变现有世界**（旧世界 `w.mapW` 仍冻结在 500，而生成/出生点/边界用常量 1500，会不一致）。本轮顺带让 `resetSeason` 的 `$set` **re-stamp `mapW/mapH`**（`server/worldsvc/src/season.ts`，与它早已 re-pin 的 `engineVersion` 同理：reset 清空全部 tiles/nations 并按 `deps` 重建州府，回收世界必须采用当前尺寸）。因此现有大区经正常「结算→重置」即可采用新尺寸；全新 worldId 天然拿到 1500；dev 直接起新库（`local-up.ps1 -Fresh`）。

**客户端零改动**：`WorldMapScene` 全程用 `getSeason` 返回的 `mapW/mapH`、渲染视口化；`constants.ts` 的 `DEFAULT_MAP_SIZE` 早已是 1500 且仅为加载前占位（注释此前写"server default 1500"是历史错位，现与实际一致）。

**验证**：`server/shared`+`worldsvc` `tsc --noEmit` 全绿；worldsvc **285 e2e**（在新 1500 尺寸下真实生成地图）全绿；`season-ops.e2e.test.ts` 新增 1 例（seed 一个 `mapW=500` 的旧世界 → settle → reset → 断言 `mapW/mapH` 被 re-stamp 成 `SLG_MAP_W`），共 10 例全绿。可见效果需完整 worldsvc + 新开世界 + 登录入图，本会话未起全栈截图核对。

**未处理/留待**：① 更大图放大了"孤立据点四周空白"观感（§1008 既知），如需改善从中立地装饰密度/初始镶机位入手；② 横断行军实时时长约 ×3，属 SLG 类型常态，用户已认可；③ "一屏俯瞰全图的最远战略档（L4）"本轮**不做**（用户拍板暂缓），但地图越大越需要，登记为后续候选。

## 35. 出征队伍编辑器：兵力读数 + Fill/Clear/Save 移入标题栏（2026-07-22，用户请求）

**背景（用户请求）**：`DefenseEditorScene`（attack 模式，即出征队伍编辑器「Edit Team N」）此前把两组信息放在**底部页脚**——左下角兵力读数（`Garrison / Troops(committed) / Troop pool`）+ 右下角 `Fill troops / Clear / Save` 三键。用户在截图上画箭头，要求这两组"放到上面去"。

**实现（仅改 attack 模式）**：
- 页脚整条取消（`renderFooter` 收窄为 defense 专用：建筑/驻军计数 + 提示 + Clear/Save）。attack 模式改为把两组控件画进**标题栏空白区**（叠在已 bake 的 header chrome 上，与 defense 的 base-level stepper / 通用货币读数同一套路）：兵力读数居左（back pill 右侧，按需缩放避让居中标题）、`Fill/Clear/Save` 三键居右，均在 header 内垂直居中。
- 抽出 `renderActionButtons(rightEdge, top, rowH)` 共享右对齐按钮簇（Fill 仅 attack；defense 页脚与 attack 标题栏共用），并抽 `titleText()` 供标题与读数避让测量复用。
- 页脚消失后棋盘/名册 `gridBottom` 由 `h - FOOTER_H - 4` 放宽到 `h - 4`；按卡分兵 stepper（`renderAllocateStepper`）锚点由 `h - FOOTER_H` 改为 `h`（贴屏底）。defense 模式布局完全不变（其 header 右上角已被 base-level stepper 占用）。

**验证**：client `tsc --noEmit` 全绿；`defenseEditorFillTroops`/`defenseEditorAttackCards` 共 17 例 UI 测试全绿（均直调方法/读私有几何，不依赖按钮坐标）。另用临时 headless 用例读回 `this.hits`：attack 三键落在 header 带内（headerH=230 下 y=100，左→右 Fill/Clear/Save），defense 两键仍贴底（y≈1876），验证后删除。真实入图需完整 worldsvc + 登录 + 进城，未起全栈截图。

## 36. 地图基地血条悬空过高修复（2026-07-22，用户截图报告）

**背景（用户截图报告）**：地图上敌方基地受损时头顶的 HP 血条，离建筑本体（帐篷营地）明显偏高，飘在半空、靠近路过的行军单位，看不出是这座基地的血条。

**根因**：`WorldMapRenderer/city.ts` 的城市图层血条（ADR-026 §1，专为遮住地块层血条的 3×3 建筑精灵补画一份）把纵向偏移写死为 `-sprite.height * 0.9`——即"整格画布高度的 90% 处"。但 `city_atlas`/`playerbase_atlas` 每格固定 256px 正方画布，各档位建筑素材实际占高差异极大（`pack_city_atlas.js` 底对齐合成，素材上方留白不等）：一级营地（帐篷+旗）实测只填满画布底部约 50%（`contentTop≈0.50`），十级大城几乎填满整格（`contentTop≈0.02`）。血条按固定 90% 高度定位，对矮建筑就飘在素材实际顶部之上一大截空白里；等级越低越明显——恰是截图里的一级营地。

**修复**：
- `art/ui/slg-building/pack_city_atlas.js` + `art/ui/slg-playerbase/pack_playerbase_atlas.js`：合成时已经算出内容在格内的实际高度（`fm.height`），顺手算出 `contentTop = (CELL - fm.height) / CELL` 写进各自 `*_atlas.json` 每帧的自定义字段（PIXI Spritesheet 解析器会忽略未知字段，不影响正常纹理加载）。跑了两个脚本重新生成两份 atlas（图像字节不变，只多了 JSON 字段）。
- `cityAtlasLoader.ts`/`playerBaseAtlasLoader.ts` 新增 `getCityContentTopFracForLevel`/`getPlayerBaseContentTopFracForLevel`，直接读原始 JSON（不经过 `sheet.textures`，因为 Texture 对象不带这个自定义字段）解析出对应帧的 `contentTop`；旧 atlas（无该字段）回退 0。
- `WorldMapRenderer/city.ts`：血条纵向偏移由 `-sprite.height*0.9` 改成 `-sprite.height*(1-contentTopFrac) - barH - gap`——即素材实际顶边再加一点小间隙，取代整格画布的固定比例；同时按 `tile.mine ? playerbase 纹理来源 : city 纹理` 的既有 fallback 逻辑镜像选取对应的 `contentTopFrac` 来源。

**验证**：client `tsc --noEmit` 全绿。真实入图需完整登录+一个正被围攻的敌方基地，未起全栈；改用离线渲染核对——直接截取重新生成的 `city_atlas.png` 对应帧，套用代码里的公式画出 OLD/NEW 两条血条位置对比：一级营地（`city_lv1`）新位置紧贴帐篷/旗帜顶部，旧位置飘在空白画布上方一大截，与截图里的 bug 完全吻合；三级/四级（`city_lv3`/`city_lv4`）新位置也更贴合尖塔顶端，无回归。

**测试**：新增 `cityAtlasContentTop.ui.ts`（7 例，用真实打包好的 atlas JSON，不 mock）——逐级/逐帧核对 `getCityContentTopFracForLevel`/`getPlayerBaseContentTopFracForLevel` 与 JSON 里的 `contentTop` 完全一致、无级图退回三级图的 fallback 分支、越界等级 clamp 到 [1,10]，以及直接断言"一级营地 `contentTop` 明显大于十级大城"（即 bug 的形状本身）；`cityAtlasContentTopFallback.ui.ts`（2 例，mock 一份不含 `contentTop` 字段的旧版 atlas JSON）验证回退到 0 而非 `undefined`/`NaN`（血条公式会直接乘这个值）。`worldMapBaseHpBar.ui.ts` 补 1 例：mock `getCityContentTopFracForLevel` 返回值分别代表"矮建筑"和"高建筑"，断言矮建筑的血条落点更靠近地面而非固定处——即 city.ts 确实用上了这个值，而不只是数据层算对了。两个 getter 顺手去掉了不必要的 `!sheet` 门（该值来自 bundle 内 JSON，不依赖 PNG 解码完成，门控只是抄了纹理 getter 的套路，且挡住了脱离场景直接单测）。UI 测试套件全量跑一遍：764/766 通过，另 2 例失败（`modalScaleAndBackButton.ui.ts` 的 EquipmentScene 弹窗缩放）与本次改动无关——同一共享检出里另一会话正在合并的 in-flight WIP（`server/metaserver/src/equipment.ts` 等仍处于 `MERGE_HEAD` 未提交状态）。

## 37. 占领面板补充资源类型/等级 + 建议兵力（2026-07-22，用户截图请求）

**背景（用户截图请求）**：中立地块的 Occupy 确认弹窗（`WorldMapInput.onTileClick` 中立地块分支）只有标题+坐标，玩家看不到这块地的资源类型、等级，也不知道该派多少兵才够打赢系统驻军，只能凭感觉出兵。

**实现**：`WorldMapInput.ts` 该分支的弹窗行新增两行——① 资源类型 + 等级（`world.resLevel` = `'{res} · Lv.{lv}'`，资源名复用既有 `world.ink/paper/graphite/metal/sticker` 词条；`SLG_GEN.resourceDensity=1.0` 下几乎所有中立地都带 `resType`，无该字段则跳过这行）；② 建议兵力（`world.recommendTroops` = `'建议兵力 {n}'`，取 `@nw/shared` 的 `npcGarrison(level)` = `NPC_GARRISON_PER_LEVEL(120) × level`——占领结算走 `combatSiege/occupation.ts` 时，未被占过的中立地系统驻军就是现算的这个值，同一份口径，不是另起一套估算）。三语言词条（zh/en/de）同步补齐。真实战斗走完整引擎模拟（卡牌/装备加成），这个数字是无卡牌情况下的参考线，不是精确胜负保证。

**验证**：client `tsc --noEmit` + webpack build 全绿；`worldMapOccupyConnectivity.ui.ts` 新增 1 例断言两行文案的具体内容（含 `npcGarrison(3)=360` 的数值）。真实入图同样需要完整 worldsvc + 登录 + 找到一块未占中立地，本会话未起全栈截图核对。

## 38. 部队「移动/驻留」+ 占领后就地驻守（新 `move` 行军种别 + `autoReturn` 开关，2026-07-23，用户拍板）

**背景（用户需求）**：三国志战略版式的「队伍出去后留在原地」体感。此前 SLG 的行军全是「解决即消失」——`MarchKind = attack|reinforce|occupy|sweep|scout|return`，到达即结算（战斗/占领/侦察），地图上的行走 stickman 到点即销毁；占领成功后生存兵化为该地块的 `garrison` 统计、`OccupationDoc` 结算删除 → 队伍被释放（等于「回家空闲」）。用户澄清心智模型：**队伍站在格子上时本来就是空闲，只是「在家空闲」还是「在外空闲」的区别**；三战里是留在原地，且留在原地更合理。

**拍板（两个决定）**：
1. **占领后默认就地驻守**：占领结算后，夺地的队伍默认**留在该格子站立待机（idle）**，持续「占用」该队伍，直到玩家移动或召回；只有队伍勾选了 `autoReturn` 才恢复旧行为（队伍释放=回家空闲，"和现在那样"）。
2. **新 `move` 行军**：点格子 → 弹窗「移动到此」→ 选队伍（team picker，与占领同流程，从主城出发）→ 队伍走过去、**无战斗**、到达后就地驻守。目标允许：**自己的领地/城**，或**空的中立地**（不占领、不宣示归属，只是站在那）。

**新概念「驻留（stationed）」**：一支队伍停在某格子站立 idle，跨重载存活，移动/召回前一直「使用中」。持久化于新 `stationed` 集合（键=tileId，与 `occupations` 同型），部分唯一索引 `{worldId,ownerId,teamId}` 与 marches 的同名索引一起保证「一支队伍同时只处于一种活动态：在途行军 / 占领 hold / 驻留」。

**实现（服务端）**：
- `@nw/shared` `MarchKind += 'move'`；worldsvc `MARCHABLE_KINDS += 'move'`。
- `db.ts`：`TeamTemplate.autoReturn?: boolean`（默认 false）；新增 `StationedDoc` + `stationed` 集合 + 索引。
- `combatMarch.ts`：`startMarch` 加 `move` 分支（要求 teamId；目标必须自有地块或空中立地，非 center/stronghold/bridge/plankway/mid-hold，且该格无他人驻留）；team-based army 抽取 & 空闲门禁 & MarchDoc.teamId 记录三处均纳入 `move`；空闲门禁 `Promise.all` 增查 `stationed`。到达 `applyArrival → applyMove` 写 `StationedDoc`（无战斗）。新增 `recallStationed`（删 stationed → 发 `return` 腿回城，flat army 到达退兵力池、card army 携 0 不重复入账 → 队伍解放）+ `getStationed`。
- `combatSiege/occupation.ts` `settleOccupation`：领有写入后，若有 `teamId` 且队伍 `autoReturn` 非真 → 写 `StationedDoc`（队伍就地驻守）；`autoReturn=true` → 不做额外动作（OccupationDoc 已在 `processDueOccupations` claim-delete，队伍即释放=旧行为）。
- `territory.ts` `abandonTile`：放弃地块顺带 `stationed.deleteOne` 释放该格驻留队伍。
- 门禁 `TEAM_BUSY` 文案更新为「marching, occupying, or stationed」（两处 throw 点 + E11000 catch）。
- `service.ts`/`combat.ts` 转发 `getStationed`/`recallStationed`；`httpApi.ts` 加 `GET /world/stationed` + `POST /world/team/{teamId}/recall-stationed`；`openapi-world.yml` 加 `move` 到两处 kind enum、`Team.autoReturn`、`StationedView` schema + 两个端点。

**实现（客户端）**：`rest:gen` 重生成 `openapi-world.ts`；`WorldApiClient` 加 `getStationed`/`recallStationed`（`startMarch` 的 `MarchKind` 自动含 `move`）；`WorldMapContext` 加 `stationed` 状态 + `stationedTokenRuntimes`；`WorldMapNet` 轮询增拉 stationed、team picker/busy 门禁纳入 stationed、`doRecallStationed`；`WorldMapInput` 自有地块与中立地块弹窗新增「移动到此」（有驻留时改显「召回驻军」）；`WorldMapRenderer/fog.ts` 新增 `syncStationedTokens`——在每个我方驻留格子上放一个 idle StickmanRuntime（播 idle clip，**到达后不销毁**，直到移动/召回），lifecycle 的持续重绘条件与销毁清理同步纳入；`DefenseEditorScene` 攻击队伍编辑加「占领后回城」toggle（存于 `TeamTemplate.autoReturn`）。三语言词条补齐（`world.actMove`/`world.actRecallStation`/`world.stationRecalled`/`world.team.pickTitleMove`/`world.team.noTeamsMove`/`world.team.autoReturn`）。

**已知限制（v1，留作后续）**：① 驻留在**未占领中立地**上的队伍不参与该格防御——他人占领/攻打该地仍只打系统 NPC 驻军，我方驻留队伍不自动应战（玩家可随时召回；召回始终可用，不会永久卡住）；② 他人夺取我方驻留所在地块时不自动清理 stationed（sprite 会留到玩家召回）；③ `autoReturn=true` 采「队伍即释放」旧语义，不额外播放一段回城行军（对齐用户「和现在那样」的参照）。

**验证**：`server/shared` build + worldsvc `tsc --noEmit` 全绿；worldsvc vitest **全绿**，`teams.e2e.test.ts` 新增 2 例（`move`→驻留→召回→再可用；`occupy autoReturn=true`→领有但队伍不驻留）并修正 1 例旧断言（占领结算后队伍现在默认**仍占用**而非释放）；client `tsc --noEmit` + webpack build 全绿。真实入图需完整 worldsvc + gateway + meta + 登录入世 + 派队，本会话未起全栈截图核对（服务端权威逻辑以 e2e 覆盖）。

## 39. 队伍领队图标 + 兵力 carried/cap 显示（2026-07-25，用户截图请求）

**背景（用户截图请求）**：城内 Teams 面板五张队伍卡只靠「Team 1..5」文字区分，用户截图圈出 `Troops 150` 问一句「兵力显示为 当前/最大」，同时问能不能给每支队伍配一张图便于识别，并提了个候选方案——在编队地图上标一个特殊格子，放进去的角色就是该队图标。

**方案取舍（AskUserQuestion 拍板）**：特殊格子方案被否——它把「战术站位」和「身份标识」绑死，换头像要动阵型（阵型是要打仗的），格子空着还得设计回退，且防守编辑器共用同一份场景代码，会平白多出一个没意义的格子。拍板为**显式「设为领队」+ 自动兜底**：`TeamTemplate` 新增 `leaderCardId?: string`（放队伍上而非某个格子，天然唯一）；编队编辑器里选中已上阵的卡即可设为领队（★ 角标 + 金框），不设也没关系——客户端自动回退到全队战力最高的卡，五支现有队伍无需任何操作立刻就有图标。`Garrison N`（其实是卡牌张数，与旁边 `Troops N` 挤在一起容易读成两份兵力）一并改名 `Heroes N` / `武将 N`。

**实现（契约 + 服务端）**：
- `openapi-world.yml` `TeamTemplate` 加 `leaderCardId`（string，可选）；`server/worldsvc/src/db.ts` 镜像该字段，注释写明"必须在 army 中出现，否则被清空"。
- `city.ts` 新增 `withValidLeader(team, army)`：`getTeams`（自愈）与 `setTeams`（保存）都过一遍——`leaderCardId` 若不在当前 `army` 里（卡被卖掉/挪去别队/从阵型里删掉）就整字段删除（不是置 null，避免存量文档里躺一个 null），不因领队失效而拒绝整次保存。
- `rest:gen`/`gen:api:world` 重生成 `openapi-world.ts`/`routes.gen.ts`。

**实现（客户端共享逻辑）**：`teamTroops.ts` 新增两个函数：`teamTroopCap(army, cardInv)` = 各卡 `troopCap()` 求和（把 `DefenseEditorScene.teamCapacity()` 的私有实现提出来共用，避免城内/编辑器/后续新增页面各自重算再次踩"两套账本"的历史坑）；`teamLeaderCard(team, cardInv, equipmentInv)` = 显式 `leaderCardId`（仍在本队 army 里才生效）优先，否则按 `cardPower` 取本队最强卡，同战力按 `cardInstanceId` 排序兜底（避免并列时图标在渲染间跳动）。`cardArt.ts` 新增 `cardInstanceArtUrl(card)`：`defId → CARD_DEFS.unitType → UNIT_ART_URLS` 一步到位，城内团队卡/编辑器统一走它取头像，不会各画各的。

**实现（编队编辑器）**：`DefenseEditorScene` 新增 `Tool.kind:'leader'`——工具栏新增「★ 领队」按钮（与既有「擦除」同一排、同一套 armed/hint 机制），激活后点击已上阵的格子即把该卡设为 `this.leaderCardId`（点空格子提示"请点击有武将的格子"）；`doSave`/`persistTeam` 落盘时校验领队仍在本次保存的 army 里，否则该字段整个不发；`Clear` 顺带清空领队。渲染：`effectiveLeaderId()`（复用 `teamLeaderCard` 的同一套优先级逻辑）算出的领队格子画金色描边 + 右上角 ★，包括从未手动选过、纯靠战力兜底选中的那张——玩家能在编辑器里直接看到"如果现在保存，谁会是图标"。

**实现（团队卡列表）**：`CitySceneCallbacks` 新增 `getSave` 回调（`app/nav/world.ts` 接入 `saveManager.get()`），团队卡右侧新画一个金框头像（`teamLeaderCard` 选出的卡 → `cardInstanceArtUrl` → 复用 `DefenseEditorScene` 的懒加载纹理重绘套路），有头像时名字/状态/子标签文字列宽度收窄让位；兵力子标签从裸数字改成 `carried/cap`（`teamTroopCap` 撑不出上限时——没有 `getSave` 回调——退化回裸数字，向后兼容）；`Garrison N` 文案改用新词条 `world.team.cards`（"Heroes N"/"武将 N"）。`WorldMapNet`/`WorldMapPanels` 的选队弹窗暂未加头像（超出本次截图请求范围，留作后续，弹窗本身的 committed 文案不变）。

**i18n 新增**：`world.team.cards`（复用位替代旧 `world.defense.garrison` 在攻击模式下的调用点）、`world.team.leader`、`world.team.leaderHint`、`world.team.leaderNeedsCard`，三语言（zh/en/de）齐备；`world.defense.garrison` 词条本身保留给防守编辑器（防守模式的建筑/驻军统计与本次改动无关）。

**验证**：`server/worldsvc tsc --noEmit` 全绿；worldsvc `teams.e2e.test.ts` 新增 2 例（`leaderCardId` 随保存/领队离队清空往返；`getTeams` 自愈直接写入文档、army 里不存在的幽灵领队）+ 修正 1 处集合访问器笔误，15 例全绿（需 `docker compose up -d` 起 Mongo）；client `tsc --noEmit -p tsconfig.test.json` 全绿；`teamTroops.test.ts` 新增 `teamTroopCap`/`teamLeaderCard` 8 例；`defenseEditorAttackCards.ui.ts` 新增领队工具 5 例；`cityScene.ui.ts` 更新兩例文案改名断言 + 新增 1 例 carried/cap 断言；全量 `vitest.ui.config.ts`（88 文件）除 5 个与本次改动无关的既有失败（`worldMapBaseClick`/`worldMapScoutDisabled`/`marchTokenAnimation`/`modalScaleAndBackButton`/`worldMapOccupyTeamPicker` 各自的既有断言，主分支同样失败，已核实非本次改动引入）外全部通过。真实入图截图未做——本次纯代码改动，无可交互 dev server 场景需要截图核对（团队卡布局改动细小，头像资源已在编辑器验证过渲染管线）。

## 40. 「我的基地」进图后一闪即消失修复（2026-07-27，用户截图报告）

**背景（用户截图报告）**：进入 SLG 世界地图后地图区域整体空白，右侧 Troops/Territory 状态卡（HUD，不依赖地块缓存）数据正常，唯独玩家自己的基地建筑精灵短暂显示一下就消失，此后不再出现。

**根因**：`WorldMapRenderer/pool.ts` 的 `isBaseAnchor(tx,ty)`——用来判定一格是否是 3×3 基地的中心锚点，从而只画一次城市精灵——要求该格及其 4 个正交邻格**当次调用时**都能在 `tileCache` 里读到 `type:'base'` 且同一 owner。`refreshCityLayer()`（`city.ts`）每次重绘（5s 行军轮询、地块推送、切换缩放级别……）都会重新跑一遍这个判定；判定失败的格子不会被加进当次 `seen` 集合，紧随其后的清理逻辑就会把它已经画出来的城市精灵整个销毁。问题在于：`loadMapViewport()`/`getMap()` 对同一 3×3 的多次刷新之间没有互斥（不像 `WorldMapNet` 别处用 `pendingTeamIds` 挡重复派单那样），一旦两次视口取图请求乱序落地，或某次推送只重取了部分格子，中心格明明还稳稳缓存着「这是我的基地」，某个邻格却可能读到瞬时缺失/陈旧的数据——邻格判定一失手，整座已经画出来的基地精灵就被拆掉，直到某次刷新凑巧四邻格又同时一致才会重新出现。这与截图里「一闪就没」的现象完全吻合。

**修复**：`isBaseAnchor` 新增一条快速通道——命中的地块若 `tile.mine` 为真，直接用 `ctx.me.mainBaseTile`（服务端权威、随 `getMe`/`joinWorld` 一起下发，不依赖邻格缓存是否刚好新鲜）核对坐标是否吻合；吻合就直接判定为锚点，不再逐邻格重新验证。只对「我自己的基地」生效——其他玩家/NPC 的基地没有这份权威坐标可用，仍走原来的四邻格一致性检查，故意保留的"数据不一致就不画"语义没有被放宽。

**验证**：`client tsc --noEmit -p tsconfig.test.json` 全绿。真实入图需要完整登录 + worldsvc 全栈，本会话起 `dev-up.ps1` 时撞上本机另一个遗留问题（各服务 `node --watch` 进程卡在启动阶段、既不监听端口也不写日志，与本次改动无关，已清理掉卡住的进程）——转而用项目里现成的"离线直构 `WorldMapScene`"调试手法（临时在 `entries/web.ts` 加 `?wmdebug` 分支，套一个立即 resolve 的假 `WorldApiClient`，绕开后端）复现了根因并验证了修复：① 正常渲染出「我的基地」后，手动从 `tileCache` 里删掉锚点的一个邻格（模拟乱序/部分刷新留下的瞬时缺口），修复前的逻辑会让 `isBaseAnchor` 返回 false 从而拆除精灵，修复后精灵原样保留（`citySprites` 仍含 `50:50`，`isBaseAnchor` 仍为 true）；② 用同样手法在假地块里放一个敌方基地，人为弄脏它的一个邻格，确认 `isBaseAnchor` 依旧正确判定为 false、精灵不画——快速通道没有波及非本人基地的既有校验语义。调试分支验证完已从 `entries/web.ts` 撤回，代码库里只留下 `pool.ts` 的正式改动。

## 41. 险地/关隘 NPC 守军常量按 TROOP_CAP_BASE=10000 新基线重新拍板（2026-07-27，修复 §27 因 ADR-048 产生的门槛失效）

**背景**：§27（2026-07-16）用真实引擎核验通过的 `STRONGHOLD_GARRISON_PER_LEVEL=360`/`CROSSING_GARRISON_PER_LEVEL=200` 是围绕"新手 `troopCap=2000`"校准的。2026-07-22 ADR-048（兵力池统一）把 `TROOP_CAP_BASE` 从 2000 一次性提到 10000，但这两个守军常量没有同步调整。2026-07-27 重跑 `strongholdCombatRun.ts`（该脚本 import 常量，无需改代码即反映新基线）确认：新手（troops=10000）对险地（守军仍是旧值 3600）和关隘（守军仍是旧值 1800）都已 100% 胜率——"几乎打不过，小额投入即可攻克"的设计意图完全失效，详见 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5。

**一次绕远路（记录下来避免重复踩）**：第一轮重新拍板直接用真实 `@nw/engine` 攻城引擎（`strongholdCombat.ts` 的 `simulateCapture`）扫描阈值，试图找一个能在"新手必败、投入 2-3 级必胜"之间稳定的守军值。扫描发现这个安全窗口极窄（仅约 100-175 兵），因为 `synthesizeArmy` 的棋盘容量上限（10 车道 × 16 行 × 60 血 ≈ 9,600 兵，见 `strongholdCombat.ts`/`siegeEngine.ts` 注释）现在几乎正好卡在新的 `TROOP_CAP_BASE=10000` 上——任何在这附近的攻防双方都会撞上引擎"棋盘拥堵导致非单调胜负"的老毛病。

排查后发现这条弯路本可以完全避免：2026-07-16 当天**晚些时候**的另一个提交（`13a7af86`，同一天下午）其实已经把 `SIEGE_CHEAP_RATIO`/`shouldUseCheapSiege` 的棋盘溢出保护接入了 `combatSiege/arrival.ts`——只要防守方（或攻击方）的合成兵力超过棋盘容量上限，生产环境就会**直接跳过真实引擎**，改用便宜的线性公式 `resolveSiege`（纯粹比较 `攻方兵力 > 守方兵力`）。但独立于 worldsvc 之外的 `server/tools/econ-sim/src/strongholdCombat.ts`（用于校准这两个常量的核验脚本）从未同步这个分流逻辑，所以第一轮拍板用的模拟工具其实测的是生产环境**根本不会走到**的一条路径，得出的"极窄安全窗口"结论对生产无意义。

**修复**：①在 `strongholdCombat.ts` 里镜像 `shouldUseCheapSiege`/`SIEGE_SYNTH_ARMY_MAX_TROOPS`（与 `siegeEngine.ts` 保持同步，不能 import，因为 econ-sim 不能依赖 worldsvc 服务包），用真实分流逻辑重新扫描；②确认只要守军值本身就超过棋盘容量（~9,600），生产环境**永远**走线性公式，校准退化为一个舒适、以千为单位留有余量的线性不等式问题，不再需要围绕引擎棋盘拥堵调参；③重新拍板：`STRONGHOLD_GARRISON_PER_LEVEL: 360→1180`（守军 11,800 @ level 10，新手必败，练兵场 +2 级必胜）、`CROSSING_GARRISON_PER_LEVEL: 200→1150`（守军 10,350 @ level 9，新手必败，练兵场 +1 级必胜，如设计意图"比险地更早开放"），且保持"关隘常量 < 险地常量"（避免同等级比较时反直觉地反转，`worldsvc/test/passage.e2e.test.ts` 对此有断言）。

**验证**：`strongholdCombatRun.ts` 重跑两个常量均 PASS；`server/shared/test/siege.test.ts`（39）、`server/tools/econ-sim` 的 `strongholdCombat.test.ts`（11，已改写为验证线性分流不变量而非真实引擎胜率）、`server/worldsvc` 全量 e2e（44 文件/338 用例，含 `stronghold.e2e.test.ts`/`passage.e2e.test.ts`/`siege-cheap-fallback.test.ts`）全绿；`tsc --noEmit` 在 `@nw/shared`/`@nw/econ-sim`/`@nw/worldsvc` 三包均通过。`worldsvc` 两组 e2e 测试里假设"6,000 兵吊打旧守军"的用例已按新守军（11,800/10,350）提到 15,000 兵，"12,000 兵满行囊撞棋盘上限"用例的过时注释（"12,000 是满级练兵场+行囊上限"）一并订正为当前真实上限 20,000（ADR-048 同一次改动带来的）。

**遗留跟进（非本轮范围）**：①`STRONGHOLD_GARRISON_PER_LEVEL`/`CROSSING_GARRISON_PER_LEVEL` 现在的"安全余量"是几百到上千兵的线性比较，不再是引擎棋盘拥堵那种脆弱窗口，但尚未针对装备/学院加成（文档记载最高 +20%）做过鲁棒性复核——如果有人把这个门槛当作"精确卡点"而非"大致正确、后续可微调"来依赖，建议先补测；②`shouldUseCheapSiege` 本身已经解决了"棋盘容量 vs 引擎"的根因问题，但这次踩坑说明**校准工具（`strongholdCombat.ts`）和生产分流逻辑（`siegeEngine.ts`）存在重复实现、容易脱节**——两处未来任何一处改动都需要人工同步另一处，值得考虑做成共享模块或加一个"两者行为一致"的跨包契约测试。

## 42. 进 SLG 世界地图的 9 跳请求瀑布合并为单次 `POST /world/enter`（2026-07-27/28，comm-audit-2026-07-27 P1-5）

> 状态：**已实现**。承 2026-07-27 前后端通信全审计（4 个子代理并行扫 meta/world/auction/social 的 REST/WS/契约，产出 15 P0 + P1/P2 backlog，用户拍板"按顺序全部修复"）。本条是 P1 优先级的第 5 项；同批 P1 的 P1-1（`serverClock.ts` 时钟纠偏）、P1-2（世界地图删除 5s 轮询定时器）、P1-3（`startMarch`/`buildWatchtower`/`buildStructure` 响应挂 `me`，顺带修正 `abandonTile`/`buySlgShopItem` 契约错报）已在 `ea8f569c` 提交；本条完成收尾。

**背景**：`WorldMapNet.loadData()`（进 SLG 地图时唯一入口，`WorldMapScene` 构造函数里 `void ctx.net.loadData()`）原本依次/半并行发 9 个请求：`getSeason`→`getNations`→`getMe`→`joinWorld`→（据 `me.mainBaseTile` 定位相机后）`getMap`/`getMapSparse`→`Promise.all([getMarches, getOccupations, getStationed])`→`getWorldChannel`。前 6 跳里 `getMap` 真正依赖 `joinWorld` 的结果（相机需先按 `mainBaseTile` 居中才能算出视口窗口 `cx/cy`），其余请求彼此独立、只是凑巧写成了顺序代码。

**方案**：把「先解出 base tile 再决定地图窗口」这一步整体挪到服务端——worldsvc 新增 `WorldService.enterWorld(worldId, accountId, r, zoom)`（`server/worldsvc/src/service.ts`）：内部先 `getMe`→`joinWorld`（复用既有 ADR-025 heal-on-entry 语义不变），从解出的 `mainBaseTile` 直接算 `cx/cy`（无基地/世界满员兜底为地图几何中心），再用 `Promise.all` 并发拉 `season`/`nations`/`map`或`mapSparse`（按 `zoom` 二选一）/`marches`/`occupations`/`stationed`。`r`（视口半径）由客户端自己算好传入——它只取决于画布尺寸，不依赖尚未知道的相机中心，`WorldMapRenderer/viewport.ts` 的 `viewportCenter()` 本来就把这两者分开算。`nation/channel`（世界频道，本就没有 openapi-world.yml 契约声明，遗留缺口记为 P2）由 `httpApi.ts` 的 `/world/enter` 路由处理器并行拉取后拼进最终响应——保持 `WorldService` 的组合逻辑不依赖兄弟服务 `NationChannelService`，方便独立单测。`justJoined`（是否本次首次落户，用于"这是你的新家"欢迎 toast）改由服务端算好回传——原客户端逻辑靠"先读一次 getMe 存 wasJoined，再读一次 joinWorld 结果比较"，一旦两次读并成一次就再也看不到中间态，故服务端在 `joinWorld` 调用前后各取一次快照算出该布尔值直接下发。

**未改动**：`WorldMapNet` 的 `loadMapViewport()`/`refreshMarches()`/`refreshWorldChat()`/`refreshMe()` 四个方法本身保留不动——它们在平移换视口、点击后局部刷新、5s 行军轮询（P1-2 已删的是*进图时*那次，其余轮询点未受影响）等场景下仍被独立调用；只有 `loadData()`（进图那一次性入口）改为调用新的 `enterWorld()` 单次聚合请求。

**契约**：`server/contracts/openapi-world.yml` 新增 `POST /world/enter`（`worldId` + `r` + `zoom` 请求体；响应聚合 `season`/`nations`/`me`(含 `justJoined`)/`map`或`mapSparse`/`marches`/`occupations`/`stationed`/`worldChannel`）。`season` 字段声明为 `nullable`（世界文档未建时 `getSeason` 本就返回 `null`，客户端相应地保留旧代码"season 拉取失败则维持默认 mapW/mapH"的降级路径，没有像 P0 那批 bug 一样对 null 解引用）。worldsvc 路由仍是手写 `if (method/path)` 分派（无 fastify-openapi-glue），故契约变更需分别跑 `gen:api:world`（重生成 `routes.gen.ts`，CI diff 用，httpApi.ts 路由本身仍手写）与 client 的 `rest:gen`（`openapi-world.ts`）。

**测试**：`server/worldsvc/test/enter-world.e2e.test.ts`（新增，4 例，真实 Mongo）——首次进入即 join 且 `justJoined:true`、地图窗口覆盖新基地锚点；二次进入 `justJoined:false`；`zoom` 2/3 出 `mapSparse` 不出 `map`；未建世界文档时 `season` 为 `null`（契约可空分支的回归覆盖）。

**验证**：`server/worldsvc`、`server/metaserver`、`client`（`tsc --noEmit`）三包全绿；`server/worldsvc` 全量 vitest 45 文件/345 例全绿；`client` 单元 112/794 + UI 92/807 全绿；contract codegen（`bundle-openapi.mjs --check` / `gen-openapi-server.mjs --check` / `gen-openapi-world.mjs --check`）三者均 check-passed，无漂移；`client` 生产 webpack 构建（`build:web`）成功。未做真人截图走查——本机 Docker Desktop 的 Linux engine 未起（`docker ps` 报 npipe 不可达），也没有原生 Mongo/Redis，无法拉起完整后端栈；改以贴近生产路径的真实 e2e/单元测试作为验证证据（同 §40 一次遇到 dev-up.ps1 卡住时的既有先例）。

## 43. comm-audit-2026-07-27 P2 契约治理清理项——分拣结果（2026-07-28）

> P1 全部收尾（§42）后，按原审计留下的 8 项 P2 backlog（契约治理/死代码清理，优先级低于 P0/P1，原计划"有时间再做"）逐项核实现状再决定取舍，而非照单全收地全改——8 项里有 2 项审计当时的判断本身已经不成立，动手前先核实省下了返工。

**已修复（2 项，风险小、范围明确）**：
- **协议字段 `world_event`（`transport.proto`）确认死代码**：字段设计于 `SLG_DESIGN.md`§一个"赛季事件推送"草案，但 `Gateway.ts` 的推送分派 `switch`（`toServerMsg`）从未加过对应 `case`，client 也没有任何地方读 `message.worldEvent`——从 `nation_msg` 上线后就被后者取代，纯遗留占位。按本仓既有先例（`JudgeRequest reserved 7,9`，2026-07-26 移除 `pve_upgrades`/`unit_levels` 时立的规矩）在 `ServerMsg` 内加 `reserved 22;` + 说明注释，删除 `world_event` 字段本体与整个 `WorldEvent` message 定义，`metaserver`/`gateway`/`gameserver`/`botsvc`/`client` 五处各自 `npm run proto:gen` 重新生成。
- **`progression.ts` 错误码/HTTP 状态错配**：`claimBattlePass` 的 `PASS_REQUIRED`（付费轨未购买）分支原写成 `reply.code(403).send(err(ErrorCode.NOT_FOUND, ...))`——HTTP 403 配了语义为"未找到"的 `ErrorCode.NOT_FOUND`，与本仓共享的 `ERROR_HTTP_STATUS[NOT_FOUND]=404` 映射表不一致（worldsvc/auctionsvc/socialsvc 都统一走这张表，metaserver 因为手写 `reply.code(N)` 才会在个别点位跟表脱节）。改用语义相符、同样映射到 403 的 `ErrorCode.NO_PERMISSION`（`economy.ts:446` 的"growth pack window closed"已是同一用法的先例）。

**核实后判定无需修复（2 项，原审计误判）**：
- **`defense_json`"死字段"判定不成立**：该字段其实是 SLG 攻城 headless 判定重放的活跃载荷（`judgeRunner.ts` 的 `runSiegeJudge` 分支），2026-07-26 的提交还专门把新字段类比它的"opacity contract"——原审计这条结论有误，予以撤销，不做任何改动。
- **"meta/socialsvc 社交端点重复实现"判定不成立**：`server/metaserver/src/service/social.ts` 除 `claimMail`（文件头注释已说明：socialsvc 原子标记领取态，meta 负责实际发货，职责分工非重复）外，其余全部是纯代理转发，未发现重复业务逻辑。

**明确推迟（4 项，需要独立会话，本轮不动）**：
- **`world`/`auction`/`social` 三份 openapi 契约缺 4xx/5xx 错误响应声明**：核实属实（三份契约 100% 路径都只声明了 `'200'`，且均无 `ErrorResp` 组件），添加本身对代码生成零风险（生成脚本对无 `content` 的 `$ref` 响应本就静默跳过），但体量不小（约 90 个 path，需逐个补两三行），留作下一轮契约治理任务单独做，不跟这次的 P1 收尾混在一起。
- ~~`/pve/upgrade` 死代码清理~~ **已于 2026-07-30 完成**：契约片段（`openapi/paths/pve.yml`）删除该 path → 重跑 `gen:api:contracts`/`gen:api:server` 更新两处生成产物 → 服务端 `pve.ts` 删 handler + `PveHandlers`/`MetaHandlers` 类型收窄 → 顺手清掉 `@nw/shared/pveRewards.ts` 里同样孤儿的 `PVE_UPGRADE_COSTS`/`findPveUpgrade`/`pveUpgradeCost`（唯一调用方就是这个 handler）→ client `ApiClient`/`SaveManager` 删对应方法 → 两侧既有 e2e/单测改写。`SaveData.pveUpgrades` 字段本身保留（L0 反作弊比对只读用途），只是再也没有写入路径。`tsc -b`/`tsc --noEmit` 两端全绿，metaserver 相关 e2e（pve/achievements/internal-economy/pve-verify 共 60 例）+ client `save-manager.test.ts`（43 例）+ shared `pveRewards.test.ts`（24 例）全部转绿。
- ~~`SERVER_API.md` §3/§8.4 与实现严重漂移~~ **已于 2026-07-30 完成**：逐条核对 `transport.proto`（而非 `Gateway.ts`，proto 本身就是文档头部声明的单一真源）重写 §3.1（补 4 个遗漏的 `ClientMsg` case）、§3.2（9→24 个 `ServerMsg` case 全量）、§8.4（protobuf-only 订正 + 用真实消息集替换掉从未实现过的 `mm_enqueue`/`mm_cancel`/`mm_status`/`presence`）。纯文档改动，无代码变更。
- **`GET /save` 响应瘦身**：`EQUIPMENT_DESIGN.md`§已有明确记录——"阶段二"瘦身已在 2026-07-26 为五个装备操作端点做过，`GET /save` 当时就被**有意排除**在外（该响应本来就要带材料/金币/进度等大量必需字段，瘦身收益不如那五个纯装备接口），本轮若要重新动它等于推翻两天前才做的、有理有据的决定，需要重新论证再改，不在本轮范围内。

**验证**：`server/metaserver`/`server/gateway`/`server/gameserver`/`server/botsvc`/`client` 五包 `tsc --noEmit` 全绿；对应 vitest 全量分别为 metaserver 56/697、gateway 3/27、gameserver 3/46、botsvc 9/39、client 单元 112/794，均绿（worldsvc 未受本轮 P2 改动影响，沿用 §42 的 45/345）。`grep WorldEvent` 确认五处生成产物均已清除。

## 44. 队伍槽默认名被冻结成保存当时的语言——`Team N`/`队伍 N` 混排（2026-08-01）

> 用户截图反馈 Home City 的 5 个队伍槽里，Team 1/2/4/5 显示英文、队伍 3 显示中文，同一存档混排两种语言。

**根因**：`teamSlotName(i)`（[`teamTroops.ts`](../../client/src/game/meta/teamTroops.ts)，§227 提到的"v1 不做自定义命名"槽位默认名）本是纯展示层的实时兜底——`CityScene/render.ts` 一直用 `team?.name || teamSlotName(i)`，理应随语言切换即时变化。但 `DefenseEditorScene/data.ts` 的 `persistTeam()`（编队编辑器"保存"路径）此前把打开编辑器那一刻算出的 `teamName`（即当时语言下的 `teamSlotName(i)` 快照）当成字面字符串写进 `TeamTemplate.name` 并持久化。这个字面字符串此后再也不会重新翻译——玩家在中文界面下保存过某个槽，该槽就永久定格成"队伍 N"，即使后来把语言切回英文；不同槽第一次保存时界面语言不同，就会出现同一存档里几个槽中文、几个槽英文的混排。

**修复**：`persistTeam()` 不再把 `teamName` 写入 `name` 字段，固定写 `''`（[`data.ts:136`](../../client/src/scenes/DefenseEditorScene/data.ts)）。`TeamTemplate.name` 契约上仍是必填 `string`（`openapi-world.yml` `TeamTemplate.required` 含 `name`），空串是合法值；`render.ts` 的 `team?.name || teamSlotName(i)` 把空串当"无自定义名"处理，因此永远走 live 翻译。`teamName`（`cb.target.teamName`）继续保留，仅用于编辑器头部标题（`base.ts:229` `world.team.editTitle`），不再被写回存档。产品决策（AskUserQuestion 拍板）：暂不做自定义命名 UI——队伍槽本身只是编队容器，领队头像（§`leaderCardId`，见上文"设为领队"条目）已经解决辨识度问题，自定义命名的收益不足以覆盖输入框+敏感词过滤的成本；固定格式+ 永远随语言实时渲染即可。

**遗留**：已经写坏的旧存档（字面存了 `Team N`/`队伍 N`）不会自动愈合，要等玩家下次打开该槽的编队编辑器并保存才会清空为 `''` 转回实时渲染；未做批量数据迁移（本轮判定收益不足以覆盖风险，属于"自愈式"轻量修复）。

**验证**：`client` `tsc --noEmit` 全绿；新增 2 例回归——`defenseEditorAttackCards.ui.ts`「save 不把 teamName 冻结进 `TeamTemplate.name`」（存入自定义 `teamName='队伍 1'` 断言存档 `name` 仍为 `''`）+ `cityScene.ui.ts`「`name:''` 的队伍回退到实时槽位名而非空白」；连同既有 `teamTroops.test.ts`（14）/`defenseEditorAttackCards.ui.ts`（12）/`defenseEditorFillTroops.ui.ts`（10）/`cityScene.ui.ts`（32）共 68 例全绿。

## 45. 战报列表坐标可点跳转（2026-08-01）

> 用户截图反馈「Battle replays (last 100)」列表两个问题：①部分占领/攻城失败的行没有录像按钮；②行首坐标 `(x,y)` 不可点，无法快速跳到该地块。

**① 为什么有的战斗没有录像**：`hasReplay`（[`combatDefense.ts:147`](../../server/worldsvc/src/combatDefense.ts)）只在 `recordSiege` 落库时 `seed`+`attackerArmy` 都存在才为真。这两个字段何时缺失有两种设计内因果，均非 bug：
  - **引擎真的崩溃**（`try { runSiegeBattle(...) } catch`，六处调用点各自 `console.error('[worldsvc] ... siege engine failed — fallback to cheap resolve', ...)` 后把 `replay` 置 `null`）——查了 VPS `server-worldsvc-1` 近 48h 日志（覆盖截图里"0m/10m 前"的时间窗）无一条匹配，排除。
  - **`shouldUseCheapSiege`（[`siegeEngine.ts:107`](../../server/worldsvc/src/siegeEngine.ts)）主动短路**：领地/据点/渡口三类攻城（`arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege`）在进引擎前先判断「攻守比过于悬殊（≥`SIEGE_CHEAP_RATIO`=10 倍）」或「合成兵拼版超出 `synthesizeArmy` 的板面摆放上限（`SIEGE_SYNTH_ARMY_MAX_TROOPS`，与实际强弱无关，纯粹是拼版占用车道数溢出）」，命中则直接走线性公式 `resolveSiege`，`replay` 恒为 `null`——这条路径**不打日志**，是刻意的静默设计（省一次~18600 tick 的引擎运算，见 `siegeWorkerPool.ts` 顶部性能注释）。占领类 `applyOccupy`/`applyOccupationExpulsion`（[`occupation.ts`](../../server/worldsvc/src/combatSiege/occupation.ts)）**不走这条短路**，只有引擎异常时才会没录像。由于崩溃已被日志排除，截图里的无录像行大概率是攻城/据点/渡口类走了 `shouldUseCheapSiege`；具体是哪一类需要该玩家的实际行军数据才能坐实（`sieges` 落库时未存 army 明细，事后无法反推），暂未做代码改动——按设计运作，非缺陷。

**② 坐标可点跳转**：[`WorldMapPanels.renderReplayPanel`](../../client/src/scenes/worldmap/WorldMapPanels.ts) 原来整行 `(sx,sy) Lv.N 角色·结果 时间` 是一个不可交互的 `txt()`。拆成两段：坐标 `(sx,sy)` 单独一个 `C.accent` 加粗文本 + 注册进 `ctx.modalBtnRects` 的命中矩形（同 Territory Overview 列表 `territoryJump` / 行军列表已有的 `centerAt(tx,ty)+renderMap()+closeModal()` 跳转模式），其余文字保持原有胜负配色（`C.dark`/`C.red`），紧跟在坐标文本右侧。

**验证**：`client` `tsc --noEmit` 全绿；新增 `worldMapReplayPanel.ui.ts`（2 例：点击第一行/第二行坐标分别精确带各自的 `(x,y)` 调用 `centerAt` 并关闭弹窗）；`test/ui/worldMap*` 全量 15 文件/112 例全绿；`client` 生产 `webpack --mode production` 构建成功（仅预存的资源体积告警，与本次改动无关）。

**追加（用户拍板，同日）**：用户反馈"为了省一点算力却导致无法排查问题本身就得不偿失，希望这类问题永远可以追溯"——把 ①里 `shouldUseCheapSiege` 短路分支的 `replay = null` 全部改为**保留**已经算好的 `{ seed, attackerArmy, defenderConfig, tileLevel }`，四处调用点全改（`arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege` + `encounter.ts` 的字段遭遇战）；`recordSiege` 落库时这些字段本来就已经在 if/else 分支之前算好，只是原来在 cheap 分支里被覆盖成 `null`，改动本身零性能成本。

**再追加（用户进一步拍板，同日）**：用户接着要求"崩溃也全部存，这样才便于查找和复现问题"——原计划里唯一保留 `replay = null` 的引擎真崩溃分支（`catch`）也改成不再置空，六处 `catch` 全改（上面四处 + `occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion`，后两者没有 `shouldUseCheapSiege` 短路，唯一的 `replay=null` 来源就是这个 `catch`）。改动前担心"崩溃输入拿去重放，客户端大概率原样崩溃"，核实后发现风险比想的小：`getSiegeReplay` 的调用链两端都有兜底——服务端 `httpApi.ts` 顶层 `try/catch`（767 行）把任何未捕获异常转成干净的 `500 INTERNAL`，不会打垮 worldsvc 进程；客户端 `world.ts` 的 `goSiegeReplay`（141 行）同样整段包 `try/catch`，拉取/重建失败直接 `goWorldMap` 退回地图，不会崩客户端场景。也就是说存下崩溃现场的输入去复现问题，最坏情况只是"点开录像悄悄退回地图"，换来的是这批输入可以离线喂给引擎单测复现服务端崩溃——对调试价值明显更高，遂采纳。

副作用（已知且接受）：`db.ts` `SiegeDoc.seed`、`combatDefense.ts` `listSieges` 的 `hasReplay`、`combatSiege/helpers.ts` `recordSiege` 三处注释均已更新——现在只有两种情况仍是 `replay=null`：①`applySweep`（无 owner 中立地块清剿，从不构造 army 编队，纯兵力数字过线性公式，没有可存的东西）；②`occupation.ts` 里 `npcGarrison<=0` 的纯"无战斗即时占领"分支（同样没有 army 可存）。除此之外的战报（cheap 路径、真实引擎崩溃 fallback）现在都会存 replay 输入；重放出来的胜负/表现可能跟当时落地结算的 `outcome` 不一致，甚至可能重建失败——都已判定为可接受的既有风险类别（`db.ts:409` 早就写明客户端重放"pure presentation, not authoritative"），不是新引入的 bug。另确认 `applyBaseSiege`（主基地按波次结算，[`arrival.ts`](../../server/worldsvc/src/combatSiege/arrival.ts) 229 行起）本来就无条件存最后一波 replay，跟这轮"全存"策略天然一致，未改动。

**验证（追加两轮）**：`server/worldsvc` `tsc --noEmit` 全绿；更新 4 处受影响的既有 e2e 断言（`siege.e2e.test.ts` ×2、`stronghold.e2e.test.ts`、`passage.e2e.test.ts`——原先断言 cheap 路径"不存 seed/attackerArmy"，现改为断言"存"）；受影响的 6 个测试文件（`siege`/`stronghold`/`passage`/`base-siege`/`field-encounter`/`siege-cheap-fallback`）44 例、`server/worldsvc` 全量 47 文件/373 例两轮均全绿。

**新增专项测试（同日）**：崩溃分支此前没有任何自动化覆盖——真实触发 `runSiegeBattle` 抛异常需要伪造引擎内部状态，现有 e2e 套件没有这类 harness，之前只是读代码+类型检查确认。补了 `test/siege-crash-replay.e2e.test.ts`：文件级 `vi.mock('../src/siegeEngine', ...)` 只把 `runSiegeBattle` 换成永远 `throw` 的假实现，其余导出原样透传（`importOriginal()` 保留 `shouldUseCheapSiege`/`synthesizeArmy` 等真实逻辑）——`vi.mock` 按文件生效，不影响其它测试文件里跑真实引擎的用例。3 个用例：①领地攻城胜（引擎崩溃→线性公式仍判出 `attacker_win`，`sieges` 落库有 `seed`/`attackerArmy`/`defenderConfig`/`tileLevel`，`listSieges` 端到端返回 `hasReplay:true`，`getSiegeReplay` 真的能拉到可重建的 `level`）；②占领进军 PvE（`occupation.ts` 本来就没有 `shouldUseCheapSiege` 短路，触发 cheap resolve 的唯一途径就是这次 mock 的引擎崩溃——验证占领流程本身仍正常进入占领倒计时）；③领地攻城败（崩溃分支下的败仗战报同样可追溯）。三例均全绿，且跑过全量 `server/worldsvc` 48 文件/376 例确认 `vi.mock` 没有泄漏影响其它文件（真实引擎胜负测试都还是走真实引擎，非本文件的 mock）。

## 46. §44 遗漏了世界地图选队弹窗——`占领/移动/驻扎`选队时队伍名整体消失（2026-08-01）

> 用户截图反馈"选择占领队伍"弹窗里 5 个队伍按钮只有一个显示名字（`Team 5`），其余 4 个都只剩 `· Troops NNNN`，名字整段空白。

**根因**：§44 把 `persistTeam()`（[`DefenseEditorScene/data.ts:140`](../../client/src/scenes/DefenseEditorScene/data.ts)）改成永远持久化 `name: ''`，并让 `CityScene/render.ts` 的两处读取点补上 `team?.name || teamSlotName(i)` 兜底，但漏改了另一个直接读 `TeamTemplate.name` 的地方——世界地图行军选队弹窗 [`WorldMapNet.showTeamPicker`](../../client/src/scenes/worldmap/WorldMapNet.ts)（`占领`/`移动`/`驻扎`/`攻击` 共用同一个弹窗）之前直接拼 `` `${tm.name} · ...` ``，从不兜底。§44 落地当天起，任何重新在编队编辑器里保存过的队伍槽 `name` 都变成 `''`，这个弹窗里就直接显示空白；用户截图里唯一显示名字的"Team 5"是尚未在 §44 之后重新保存过、还留着旧的字面 `"Team 5"` 字符串的槽位——同一存档里几个槽有名几个槽空白，是 §44 遗留问题的延续，不是新 bug。

**修复**：把"`name` 为空时按 `t{n}` id 换算实时槽位名"这段逻辑从 `CityScene/render.ts` 提炼成 [`teamTroops.ts`](../../client/src/game/meta/teamTroops.ts) 的共享 helper `teamDisplayName(team)`（`team.name || teamSlotName(parseInt(id 中的 n) - 1)`），`WorldMapNet.showTeamPicker` 改用它而不是裸 `tm.name`。`CityScene/render.ts` 的两处 `team?.name || teamSlotName(i)` 逻辑等价（`i` 本来就是正确的槽位序号），未改动，避免无谓改动已工作的代码。

**验证**：`client` `tsc --noEmit` 全绿；新增回归 `worldMapOccupyTeamPicker.ui.ts`「`name:''` 的队伍（id `t3`）在占领选队弹窗里回退显示实时槽位名 `Team 3`」；`--config vitest.ui.config.ts` 全量 102 文件/862 例全绿。

## 47. 行军「回城需要时间」统一改造 + 卡牌部队磨零漏洞修复（2026-08-01）

> 承 §45：用户又发现一条 "(33,293) Atk·Loss 0m 无回放"。查 VPS 生产库 `sieges` 集合，`seed`/`defenderConfig` 齐全但 `attackerArmy` 长度为 0——不是 §45 修的两条已知空路径，是新根因。

**根因**：卡牌部队真实战力活在 `cardState.currentTroops`，行军途中每赢一次 ADR-051 野战遭遇，`combatMarch.ts` 的 `advanceMarch` 只判断"这一次遭遇本身赢没赢"就放行部队继续前进，从不回头核对卡牌被磨损后的真实战力。反复磨损后如果全队归零，部队带着空壳阵容走到终点再打一场必输的仗，而不是在磨零那一刻就判定"全灭"。

**修复**（`combatMarch.ts` `advanceMarch`）：赢了野战遭遇、`m.troops`/`m.army` 落盘之后，对卡牌军用 `pw.cardState` 重新核算——`cardArmy.every(e => (pw.cardState?.[e.cardInstanceId]?.currentTroops ?? 0) <= 0)`——归零则视同 `!enc.marcherContinues`，走现成的"全灭删除"分支（不新建返程，已确认全灭恒为 0 幸存者）。

**借机的更大设计诉求**：用户确认必须修，同时指出"全灭"（野战遭遇/箭塔打空）和"占领格子后 autoReturn"都是瞬间处理，与玩家主动"召回"（已经是走时间的返程行军）不一致，要求统一成**任何"回城"默认都走返程行军时间（地图上有行走动画），玩家可以额外花金币瞬间完成**。用户进一步明确两个边界：①行军半路目标失效（连通性断/已被占/己方抢占中）——**原地停留，不算回城**，不套返程也不再瞬间退回；②瞬间回城的计费——**服务端按剩余路程时间全额算成金币**，不接受客户端指定部分抵扣（区别于 `speedupTraining` 的"可部分抵扣"）。

**三种行为模型分工**：

| 场景 | 改造后 |
|---|---|
| 主动召回（`recallMarch`/`recallStationed`） | 不变——本来就是返程行军，作为参照模板 |
| 行军到达终点才发现目标失效（8 处 miss/blocked） | 原地停留成 `StationedDoc`（复用 `settleOccupation` 已有的"占领后默认原地驻留"逻辑），push `status:'arrived'` |
| 占领格子后 `autoReturn=true` / 战败退回幸存者（~15 处） | 新建一条 `kind:'return'` 返程行军 |
| 返程行军抵达家门（`applyArrival` 的 `kind==='return'`） | 不变——这本来就是终点，理应瞬间入账 |
| 野战遭遇中途全灭（箭塔打空/`marcherContinues:false` 恒 0 幸存者） | 不变——没有可送回的部队 |

**新增共享原语**（`server/worldsvc/src/combatShared.ts`，与既有的 `refundTroops` 同伴——这三个都是自由函数而非某个 Service 的方法，因为 `combatSiege/*.ts` 的 mixin 只有 `this.core`，没有 `MarchService` 实例可用，而 `MarchService` 反过来已经依赖 `SiegeService`，不能反向注入）：
- **`computeMarchPath`**：从 `combatMarch.ts` 原私有方法原样搬出（函数体只用 `core.deps`/`core.coordX/Y`，零行为变化），`startMarch`/`recallStationed` 改为调用这个自由函数。
- **`startReturnMarch(core, {worldId,ownerId,fromTile,x,y,troops,army?,teamId?,leaderUnitType?}, t)`**：照抄 `recallStationed` 构造返程 `MarchDoc` 的写法——查 `pw.mainBaseTile` 当家（查不到就退化成原地 `refundTroops`）、`computeMarchPath` 算路径、插入 `kind:'return'` 文档、`pushMarch`。**内部整段包 `try/catch`，任何失败（最常见是 `computeMarchPath` 找不到路径）都退化成 `refundTroops` 即时入账**——这个原语被安插在很多更大的结算流程中段（主基地夺取→宗主惩罚→passiveRelocate→系统邮件、延迟建筑伤害结算等），寻路失败绝不能打断这些后续步骤（`field-structure-attack.e2e.test.ts` 的 `passiveRelocate` 测试在开发阶段实测踩过这个坑——不包 try/catch 时一次 `PATH_BLOCKED` 会让邮件和强制搬迁全部消失，因为 `processDueSiegeDamage` 外层只是 catch-and-log，不会重试或告警）。
- **`parkMarchInPlace(core, m, survivors, t)`**：照抄 `settleOccupation` 里"队伍默认原地驻留"那段写 `StationedDoc`+`setOccupancy`。只在 `m.teamId` 存在时可用（`StationedDoc` 按 teamId 建档，散兵没有队伍身份可停）；调用方在 `m.teamId` 缺失时保留旧的瞬间 `refundTroops`。

**改造调用点**（机械式替换，把 `refundTroops(...)` 换成上面两个原语之一，逐一文件不单独设计）：
- **改 `parkMarchInPlace`**（8 处到达终点发现目标失效）：`arrival.ts` 的 `applySiege`×2、`applyStrongholdSiege`、`applyCrossingSiege`、`applySweep`；`occupation.ts` 的 `applyOccupy`×2（第三处"己方抢占中"race **没有**转，见下）；`combatMarch.ts` 的 `applyArrival` reinforce-miss 分支（原先遗漏的第 9 处，人工审计时补上）。
  - **例外未转**：`applyOccupy` 里"己方已有一条待结算的占领 hold，第二条 occupy march 撞上"这条 race——不能原地驻留，因为 `StationedDoc` 按 tileId 一档一份，这个 tile 马上要被第一条 hold 结算（`settleOccupation`）写入它自己的 StationedDoc/所有权，两者会互相覆盖导致第二支部队静默消失。保留原有瞬间退回。
- **改 `startReturnMarch`**（~15 处战败/被击退幸存者 + autoReturn）：`arrival.ts` 的 `applyBaseSiege`/`applyStrongholdSiege`/`applyCrossingSiege`/`landSiege`(3 分支)/`applySweep`战后；`occupation.ts` 的 `applyOccupy` PvE 战败、`applyOccupationExpulsion` 战败、`settleOccupation` 的 `autoReturn` 分支（`troops:0` 恒定——`d.garrison` 已经变成新占地块自身的永久驻防，再送回去会重复计数）；`damage.ts` 的 `settleSiegeDamage`(3 分支，用 `this.core.coordX/Y(d.tile)` 求坐标，因为 `SiegeDamageDoc` 不带 x/y 且 `tile` 文档在 stale 分支可能已经不存在)；`encounter.ts` 的 `resolveFieldEncounter` 平民/卡牌军战败。
  - **踩过的坑（已修复）**：`resolveFieldEncounter` 内部原本直接调用 `startReturnMarch`（用同一个 `teamId`），但此时旧的 outbound `MarchDoc`（同一 teamId，仍是 `status:'marching'`）还没被删——撞上 `{worldId,ownerId,teamId}` 唯一索引，`E11000` 报错（`field-encounter.e2e.test.ts` 两例实测复现）。改法：`FieldEncounterResult` 新增 `returnTroops?: number` 字段（卡牌军恒 0，平民军为真实幸存数，`undefined`=全灭无需送回），`resolveFieldEncounter` 只返回这个字段，实际调用 `startReturnMarch` 挪到 `advanceMarch` 的 `!enc.marcherContinues` 分支里、**紧跟在 `findOneAndDelete` 之后**（先删旧的，再建新的）。
- **新增根因修复**：`advanceMarch` 卡牌军磨零检测（见上）。

**「花金币瞬间回城」**：`server/shared/src/slg/core.ts` 新增 `MARCH_RETURN_SPEEDUP_SECS_PER_COIN=60`（与 `TROOP_SPEEDUP_SECS_PER_COIN` 同档位，独立常量便于日后单独调）；`MarchService.instantReturnMarch(worldId,accountId,marchId,clientPlatform?)` 服务端自算 `coins=ceil(剩余秒数/60)`（不接受客户端传的金额），`this.core.commercial.spend(...)`（照抄 `speedupTraining` 的调用方式），再原样执行 `applyArrival` 的 `kind==='return'` 分支同款逻辑（`findOneAndDelete`+`refundTroops`+push）。`POST /world/march/{marchId}/instant-return`（`openapi-world.yml` 新增声明，`gen:api:world`/客户端 `rest:gen` 两端重生成）。

**客户端**：`WorldMapPanels.ts` 的行军列表原本 `kind==='return'` 的行只显示文字、无按钮——新增"花{coins}金币立即回城"按钮（`world.instantReturn` i18n key，三语言），`WorldMapContext.ts` `marchRowRects` 加 `instantReturnRect` 字段，`WorldMapInput.ts` 点击接入 `WorldMapNet.doInstantReturn`（新增，照抄 `doRecall` 的写法，成功后刷新 `ctx.me`+marches+toast `world.instantReturnDone`）。march 行走动画（`WorldMapRenderer/fog.ts`）本来就通用（不区分 kind，`'return'` 已有专属绿箭头），`parkMarchInPlace` 产生的 `StationedDoc` 复用既有驻留渲染——两处均无需新代码。

**已知不在本轮范围**：`combatMarch.ts` `applyMove` 的 `blocked` 分支（目的地被抢占/驻扎/contested）目前既不退回也不驻留——只是把行军删掉、什么都不写，队伍凭空消失，无处可查。这是独立于本轮"回城模型"之外的另一个缺口（`move` 是重新部署已就位的队伍，不是从家出发，语义上不完全等同于本轮改的"回城"），已 `spawn_task` 记录留待单独会话处理，未在本轮改动（后续已在 §48 修复：目的地被抢占时改为原地驻留在出发点，无法驻留才回退瞬间退款）。

**验证**：`tsc --noEmit`（`@nw/shared`/`@nw/worldsvc`/`client` 三包）全绿。`server/worldsvc` 全量 vitest 48 文件/376 例全绿（含更新 3 处受行为改动直接影响的既有断言——`siege.e2e.test.ts` 的 sweep-win 用例改为断言"幸存者以返程行军形式在途，非瞬间入账"；`teams.e2e.test.ts` 的 idle-team-gate 与 autoReturn 用例改为断言"结算后队伍仍 busy，直到返程行军抵达才可接新单"；均为预期的行为变化，非回归）。`server/shared` 全量 35 文件/666 例全绿（2 例因本机无 Redis 跳过，与本次改动无关）。`client` 全量 126 文件/918 例全绿。

**追加专项测试（同日，用户要求"加测试"）**：上面这轮验证只跑了既有套件+按需更新了受影响的断言，没有为新行为单独立新用例——补了两个新文件：
- `test/field-encounter-card-zero.e2e.test.ts`：专测根因修复本身。`resolveSiege` 的线性公式在防守方赢时恒为 0 幸存者（`atk<def` 意味着差值天然为负截断到 0），无法用来构造"赢了但磨零"场景；真引擎又难以靠兵力配比精确调出"attackerSurvivors 恰好 0 的惨胜"，遂 `vi.mock('../src/siegeEngine', ...)` 强制 `runSiegeBattle` 返回确定的 `{outcome:'attacker_win', attackerSurvivors:0}`（其余导出走 `importOriginal()` 保持真实，`computeCardStateUpdates`/`CARD_BASE_SURVIVAL` 等逻辑照跑）——2 例：①每张卡 2 兵、`CARD_BASE_SURVIVAL=0.2` 精算出 `round(2*0.2)=0` 全员归零，断言行军在遭遇战当场被删、目的地从未记录战报、也没有生成返程行军（全灭恒无幸存者可送）；②对照组每张卡 10 兵（`round(10*0.2)=2`，未归零），断言这次全灭检测不误伤，行军照常继续前进。
- `test/march-return-travel-time.e2e.test.ts`：专测本轮新行为本身（此前只是间接被既有测试的断言覆盖到，没有专门断言过新行为的具体形状）——同样 `vi.mock` 强制 `defender_win` + 固定非零幸存者（cheap 线性公式的 defender_win 分支恒为 0 幸存者，同样没法用来测"输了但有幸存者送回家"）。7 例：①目标行军途中被他人抢占（race）、带队伍的占领行军 → 落地为 `StationedDoc`，不退回、无返程行军；②同场景不带队伍 → 退回旧行为的瞬间退款，无 `StationedDoc`（对照组，确认 teamless 分支未被误改）；③PvE 战败 → 不是瞬间入账，而是生成一条 `kind:'return'` 返程行军，`toTile` 指向玩家主基地而非战场，兵力只在返程行军自己抵达时才真正入账；④`instantReturnMarch` 按服务端算出的 `ceil(剩余秒数/60)` 金币扣费，成功后立即结算（无需再等一次 `processDueArrivals`）；⑤扣费失败（`commercial.spend` 拒绝）时返程行军原封不动，没有半途扣了钱却没到账的情况；⑥⑦`instantReturnMarch` 对不存在的行军 id、以及对一条仍在途的非 `return` 类行军，均正确拒绝（`MARCH_NOT_FOUND`），不产生任何扣费。

两个新文件 9 例 + 原有全量 50 文件/385 例，全部一轮跑绿；`tsc --noEmit` 复核仍绿。
## 48. `move` 行军到达时目的地被抢占——队伍连人带兵直接消失，无驻扎、无退款（2026-08-01，代码审计发现）

> 审计 `combatMarch.ts` `MarchService.applyMove` 时发现：目的地在派出到抵达之间被别人占领/驻扎/进入争夺态（`blocked` 分支命中）时，代码只 `pushMarch(..., {status:'recalled'})` 就 `return`——不写 `StationedDoc`，不 `refundTroops`，而调用方 `advanceMarch`/`processDueArrivals` 在调用 `applyMove` 之前早已把 `MarchDoc` `findOneAndDelete` 掉了。结果是这支队伍连人带兵凭空消失：地图上没有行军、没有驻扎，兵力池也没有拿回一分——纯粹的资产丢失 bug，而不是"仅退款没实现"这种小疏漏。

**根因**：`move`（2026-07-23 新增，§38）语义上和 `attack`/`occupy`/`reinforce` 不同——它从不进入战斗结算，成功只是把队伍原样"放"在目的地（`StationedDoc`），没有"战损幸存兵力"这个概念可退。`applyMove` 最初只处理了"到达时目的地仍然合法"这一条路径，`blocked` 分支被当成跟 `reinforce`/`occupy` 的战败/目标失效一样的"退款+recalled"来写，但漏写了退款调用；而且退款语义本身也不贴切——`move` 的兵力/编队并没有战损，直接摔回抽象兵力池，跟"这支队伍应该出现在地图某处"的既有设计（ADR-051 P3a 停留/驻扎、idle-team 重新派遣）不一致。

**排查澄清**：`move` 在正常（非卡牌、非 P3c 就地重派）派出时确实会从兵力池扣兵（`startMarch` 里 `troops = team.army.reduce(...)` 之后走跟 `attack`/`occupy` 相同的 `$inc: {troops: -troops}` 原子扣减，见 `combatMarch.ts:411-424`），所以"是否曾扣兵池"不是本 bug 成立与否的前提——即使某些分支（卡牌编队 / idle 重派）不扣兵池，"目的地被抢占后队伍应该落在某处"这条不变量对所有分支都成立，只是没有兵力池要还的场景不需要额外退款。

**修复**（[`combatMarch.ts`](../../server/worldsvc/src/combatMarch.ts)）：`applyMove` 到达时优先尝试把队伍停驻在**目的地**（原有逻辑，抽成 `tryParkTeam` 私有方法，返回 `boolean` 表示是否成功写入）；目的地被抢占则退而求其次，用同一套 `tryParkTeam` 尝试停驻在**出发地**（`m.fromTile`）——等效于"这次移动没发生，队伍原地不动"，符合 `move` 本身"无战斗，纯粹是位置变更"的语义，且完全复用既有的 StationedDoc/occupancy/cover 写入与合法性校验（世界中心/已被占用/别家地块/争夺中）。只有当出发地也在此期间失效（例如队伍在外时出发地被第三方攻占）才真的无处可去，此时才回落到 `refundTroops`（卡牌编队照旧跳过，强度活在 `cardState` 里）。`!m.teamId` 分支保留（`startMarch` 保证 `move` 必有队伍，理论不可达，只为类型安全兜底）。

**验证**：`server/worldsvc` `npm install`（本 worktree 未预装 `node_modules`）+ `npm run build --workspace @nw/shared` / `@nw/engine`（首次无 `dist/`）后 `tsc --noEmit` 全绿。新增回归 `teams.e2e.test.ts`「move: destination becomes blocked between dispatch and arrival — the team parks back at its origin instead of vanishing」：派出后用 `setupDefender` 抢占目的地模拟竞态，断言到达后队伍以原兵力数出现在**出发地**的 `getStationed` 里、目的地地块归属未被误改，且停驻后仍可正常 `recallStationed`；先 `git stash` 掉修复代码单独跑这个新用例，确认它在修复前必现失败（`expected [] to have length 1 but got 0`，即队伍彻底消失）；`git stash pop` 恢复后转绿，坐实这确实是本次要修的 bug 而非误报。全量 `server/worldsvc` 跑了 48 文件/377 例，唯一 1 例失败（`siege-crash-replay.e2e.test.ts` 的崩溃回放用例）单独重跑该文件（无论是否带本次改动）均通过——只在全量并发跑所有文件时才偶发失败，跟本次改动的文件（`combatMarch.ts`/`teams.e2e.test.ts`）没有引用关系，判定为已有的全量并发/共享库竞态导致的既有 flaky，非本次改动引入。

**追加测试（同日，用户要求"加测试"）**：上面那一例只覆盖了`tryParkTeam`的"目的地被别家地块占领"这一种 `blocked` 成因，且没有触碰 `stationMode:'garrison'`、双端皆废的兜底、以及 idle-重派（ADR-051 P3c）这几条独立分支。补了 4 例，分布在三个文件（各自复用该文件既有的 harness，不新开文件）：
- `teams.e2e.test.ts` 「move: destination is blocked by ANOTHER team already stationed there (not tile ownership)」——用直接写入 `StationedDoc` 的方式构造"目的地无主但已被别家队伍驻扎"，专测 `blocked` 判定里 `stationedHere` 那一半（跟已验证的 `ownerId` 不匹配那一半是独立分支）；断言 `getStationed` 需按 `mine` 过滤（enemy-in-vision 也会被一并返回，踩了一次坑：断言写成 `length(1)` 首次跑出 2 条失败，修成 `.filter(s=>s.mine)` 后才对）。
- `teams.e2e.test.ts` 「move: BOTH destination and origin become unavailable」——专测三级兜底的最后一级（真退款）。CC-3 之后 `setTeams` 只接受卡牌编队（强度活在 `cardState`，从不扣兵池），没法用正常 API 构造一支会真正扣兵池的 `move` 队伍；改用直接写 `pw.teams`（绕过 `setTeams` 的校验，`startMarch` 读队伍走的是原始 `pw.teams`，不经过 `getTeams` 的自愈清洗）种一支**非卡牌**（`unitType`+`initialHp`）编队，这样 `hasCardArmy=false`，`move` 按 `attack`/`occupy` 同款 `$inc:{troops:-troops}` 真扣兵池；派出后同时用 `setupDefender` 占目的地、直接改写出发地（玩家自己基地那格）`TileDoc.ownerId` 模拟"队伍在外时老家也被端了"，断言到达后 `getStationed` 空、兵池金额精确退回原值。
- `field-garrison.e2e.test.ts` 「a garrison move whose destination is blocked mid-flight parks back at the origin STILL as a garrison」——专测 `stationMode:'garrison'` 分支：目的地被抢占后，落回出发地要求① `mode` 仍是 `'garrison'`（不能悄悄降级成 `'idle'`）、②`this.core.addCover` 的 3×3 覆盖区跟着落到**出发地**的九宫格（而不是目的地，或两头都不写），复用该文件已有的 `FakeRedis`（`teams.e2e.test.ts` 用的 `redis:null`，addCover/getCover 是 no-op，测不出覆盖区）逐格核对 `coverAt`。
- `field-redispatch.e2e.test.ts` 「re-dispatch move whose new destination becomes blocked mid-flight parks the team back at its ORIGINAL station cell」——专测 idle 重派（ADR-051 P3c）路径：一支已经"停留"在字段格 A 的队伍被重新派往 B（不经过recall），B 中途被抢占，落回**A**（不是玩家基地），且全程（原始停留、重派、失败落回）兵池分毫未动——idle 重派从设计上就不摸兵池，这是它跟"从基地新出发"分支唯一的、值得单独断言的差异点。

四例 + 原有 1 例，`teams.e2e.test.ts`/`field-garrison.e2e.test.ts`/`field-redispatch.e2e.test.ts` 三个文件单独跑通；`tsc --noEmit` 复核仍绿；`server/worldsvc` 全量重跑 50 文件/390 例全绿（先前那例 `siege-crash-replay.e2e.test.ts` flaky 这次也没有复现）。

## 49. 战令（Battle Pass）重复购买无限扣币、UI 无「已生效」提示（2026-08-01，用户截图报告）

用户截图报告：SLG 商城「Battle pass 9800 coins」无购买次数限制，点了很多次 Buy。追查确认这是真实缺口——`buySlgShopItem`（[`shop.ts`](../../server/worldsvc/src/shop.ts)）对 `kind:'battle_pass'` 只是把 `hasBattlePass` 字段重新设成 `true`，已经是 `true` 再设一次没有任何叠加效果；`SLG_SHOP_ITEMS`（[`shop.ts`](../../server/shared/src/slg/shop.ts)）里这一档商品也没配 `dailyLimit`（其余训练加速/资源包都有每日限购），代码注释原先写的假设是"战令本来就该一季只买一次"，但没有任何强制限制去兑现这条假设——纯粹的钱包漏洞，跟 §46/§48 那类"审计发现的资产/体验缺口"同构。

**战令当前效果**（确认无误，用户问"买了有什么效果"）：`trainTroops`/`speedupTraining`/`speedupBuild` 训练+建造均 ×0.8 时长、加速货币折扣 15%（[`city.ts`](../../server/worldsvc/src/city.ts)）；`recomputeYield` 资源产出 +10%（`BP_YIELD_MULT`，[`core/yield.ts`](../../server/worldsvc/src/core/yield.ts)）；赛季结算时持有战令的玩家额外收一封材料奖励邮件，与持有期间买了几次无关（[`season.ts`](../../server/worldsvc/src/season.ts)）——这几条增益本身在 S8-8（见 §15.1 G4/C6）已经落地生效，本次缺口只是"重复购买"这一层没有防护。

**修复**（单档商品的"单槽位"防重复购买，复刻月卡/年卡既有的 `ALREADY_ACTIVE` 单槽位门禁模式，见 `commercial/src/service/base.ts`）：
- 服务端 [`shop.ts`](../../server/worldsvc/src/shop.ts)：`buySlgShopItem` 在扣币前新增守卫——`item.kind==='battle_pass' && pw.hasBattlePass` 时直接 `throw new SlgError('ALREADY_ACTIVE', ...)`，币不会被扣（守卫先于 `commercial.spend` 调用）。
- 契约 [`openapi-world.yml`](../../server/contracts/openapi-world.yml)：`PlayerWorldView` 补 `hasBattlePass?: boolean` 字段（此前这个服务端早就在写、但从未在任何契约里暴露给客户端——`getMe` 也补了这一行，[`core/map.ts`](../../server/worldsvc/src/core/map.ts)），`npm run rest:gen` 重生成 `client/src/net/openapi-world.ts`。
- 客户端 [`WorldMapPanels.ts`](../../client/src/scenes/worldmap/WorldMapPanels.ts)：商城战令行读 `ctx.me?.hasBattlePass`，已生效时按钮走既有的"禁用态"配色（`panelButtonIn` 新增 `disabled` 参数，复刻本文件顶部 tile-action 弹窗禁用按钮"点了也弹 toast 解释原因、而不是读起来像个死点击"的既有约定），文案从「购买」换成「已生效」，点击弹 toast 而不是发起购买请求。服务端如果仍因竞态（客户端 `me` 未刷新）拒绝，`WorldMapNet.errorMsg` 也把 `ALREADY_ACTIVE` 映射到同一句 toast 文案，三语 i18n key `world.shopActive`/`world.shopAlreadyActive` 补全 zh/en/de。

**验证**：`tsc --noEmit`（server `worldsvc`/`shared`，client `tsconfig.test.json`）全绿；`npm run build:web` 生产构建通过。`server/worldsvc` 新增 e2e「battle pass: repeat purchase while already active → ALREADY_ACTIVE, coins never deducted twice」，`shop.e2e.test.ts` 全 7 例过、`worldsvc` 全量 50 文件/391 例过。`client` 新增 UI 用例覆盖「未持有时点击行仍正常触发购买」「已持有时点击行不再调用 `doBuyShopItem`、改为弹 toast」，`worldMapInfoScroll.ui.ts` 全 20 例过，`worldMap*` 全套 17 文件/124 例过。未启动完整后端栈（metaserver/worldsvc/gateway 等 11 服务）做真实登录后截图验证——UI 交互路径已通过驱动真实 `WorldMapPanels`/`WorldMapInput` 类的无头 PIXI 测试覆盖，视为等效验证。

**追加测试（同日，用户要求"加测试"）**：`shop.e2e.test.ts` 补 3 例——① 持有战令不影响购买其它商品（守卫只针对 `kind:'battle_pass'`，不误伤 `slg_res_s`/`slg_shield_8h`）；② 守卫按账号隔离——A 持有战令不阻挡 B 首次购买（读的是各自 `playerWorld` 文档，不是全局标记）；③ `hasBattlePass` 被清空后（模拟 `resetSeason` 的 playerWorld 清档路径）可以再次购买，门禁不会永久卡死。`worldMapErrorMsg.ui.ts`（专门收录 `WorldMapNet.errorMsg` 码→文案映射回归的文件）补 1 例，断言 `ALREADY_ACTIVE` 映射到 `world.shopAlreadyActive`。`shop.e2e.test.ts` 全 10 例过、`worldMapErrorMsg.ui.ts` 全 7 例过、`worldMap*` 全套 19 文件/139 例过；`tsc --noEmit` 复核仍绿（`worldMapDrawPrimitives.ui.ts`/`worldMapOwnerBorder.ui.ts` 各有 1/2 处 PIXI `lineStyle`/`beginFill` 重载类型报错，经核对在主目录未改动前就已存在，跟本次改动无关，不在此修）。

## 50. 围攻战斗：进攻方全灭后提前结束，不再耗到超时（2026-08-02，用户提出）

用户提出：SLG 攻城验证时，如果场上进攻方已经没有存活单位了，战斗应该直接结束判负，不需要等 `SIEGE_BATTLE_TIMEOUT_TICKS`（10 分钟/18000 tick，§16.5）跑完。核对 `checkWinCondition`（`server/engine/src/engine/winCondition.ts`）发现 `destroy_base` 目标此前只有两条硬性超时兜底——`battleTimeoutTicks` 与目标自带的 `durationTicks`——进攻方（Bottom）全灭后既打不掉基地也没有任何提前判负分支，只能干等到超时才由防守方（Top）胜出；`survive` 目标已有对称机制（`hasLivingEnemyUnits()`，`campaign.ts`），但那是查 Top 侧、服务 PvE 波次防守场景，跟围攻的攻防方向相反，没有覆盖到 `destroy_base`。

**修复**：`campaign.ts` 新增 `hasLivingAttackerUnits()`（对称于既有 `hasLivingEnemyUnits()`，查 Side.Bottom 是否还有存活单位）；`winCondition.ts` 在 `destroy_base` 分支的超时判定之前插入早退检查——`!hasLivingAttackerUnits()` 时立即 `GameOver`，`winner=Side.Top`（防守方胜，判负事件与超时分支完全一致，只是不用等满 tick）。攻方军队在引擎构造时（`base.ts` 读 `level.attackerArmy`）就已一次性同步入场，无逐 tick 补兵的活指令输入，因此该检查不会误杀"部队还没上场"的中间态。围攻仅用于 worldsvc 无实时输入的 headless 结算（`siegeEngine.ts`）与 econ-sim 模拟工具，不涉及客户端实时对战，不影响其它模式。

**验证**：`server/engine` `tsc --noEmit` 绿 + 全量 `npm test`（76 例，含围攻相关用例）全过，其中含一例攻方军队为空（`attackerArmy` 未设置）走 `destroy_base` 的既有用例，验证提前判负不影响该用例原有断言；`server/worldsvc` `tsc --noEmit` 绿，`siege-cheap-fallback.test.ts`（10 例）+ `siegeWorkerPool.test.ts`（11 例）全过。

**追加测试（同日，用户要求"加测试"）**：`gameEngine.test.ts` 新增「destroy_base ends immediately once the attacker army is wiped, without waiting for battleTimeoutTicks」——`attackerArmy` 放一个 `initialHp:1` 的濒死步兵，紧挨着（隔 1 行、同列）一个满血 `garrison` 步兵，`battleTimeoutTicks` 照抄真实值 18000，`runHeadless(maxTicks:100)`；断言 `winner===Side.Top`、`topPlayer.isDead===false`（排除"打穿基地获胜"这条已有分支）、`elapsedTicks<100`（远早于 18000 的超时线）。先 `git show <fix前一提交>` 把 `winCondition.ts`/`campaign.ts` 换回本次改动前的版本单独跑这一例，确认必现失败（不会在 100 tick 内结束，而是要跑到超时才会 GameOver）；换回修复后的版本复跑，转绿——坐实测试确实在验证本次新加的早退分支，而非误报。`server/engine` 全量 `npm test` 77 例全过，`tsc --noEmit` 复核仍绿。

## 51. §33 修复留了个尾巴——占领结算仍会误报「领地失守」，改成服务端下发身份而非客户端瞎猜（2026-08-02，用户截图报告）

**背景（用户报告）**：SLG 里刚战斗完、进入占领阶段时，会闪一次「领地失守」（`world.defendLost`）提示——玩家自己刚打赢的占领被读成了被人抢地。

**根因**：§33 的修复（`myOccupyTiles`）是纯客户端方案——`WorldMapNet.doMarch`/`doMarchTeam` 派出占领军时把目标格记进 `WorldMapContext` 上一个**仅存在于内存里**的 `Set`，`applySiegeResult` 收到推送时查这个 `Set` 判断"这是不是我自己干的"。问题是 `WorldMapScene`（连带它的 `WorldMapContext`）只在**每次进入 SLG 时**重新创建一次（`app.ts showWorldMap`）——City/拍卖行/社交面板都是叠加在它上面的 overlay，不会重建它，但只要玩家**退出 SLG 再回来**（或刷新页面），一次全新的 `WorldMapContext` 就带着一个空 `Set` 出现。占领行军往往要走几十秒到几分钟，只要这段时间内场景被重建过，占领打赢的 `siege_result` 推送一到，`myOccupyTiles` 里早就没有这块地了，直接落进 `else` 分支的「防守方」文案——和 §33 描述的现象一模一样，只是触发路径从"从没记过"变成了"记过又被清空"。

**修复（服务端下发身份，彻底去掉客户端猜测）**：`SiegeResult`（`transport.proto`）新增两个字段——`attacker_id`（派出这次进攻/占领行军的账号，直接来自 `SiegeDoc.attackerId`）与 `march_kind`（那次行军的 `MarchKind`，新增到 `SiegeDoc`，`recordSiege` 写入 `m.kind`）。`core/push.pushSiege` 把两个字段一并推给客户端；`WorldMapNet.applySiegeResult` 改用 `s.attackerId === ctx.cb.accountId` 判断"这是不是我的行动"，`s.marchKind` 判断"攻城"（复盘弹窗）还是"占领"（轻量 toast）——不再依赖任何客户端记忆，`myAttackTiles`/`myOccupyTiles` 两个 Set 连同它们的写入点一并删除。字段全程走 `buf generate`（`server/contracts/transport.proto` → gateway/metaserver/gameserver/botsvc/client 五处 `npm run proto:gen`），gateway 内部还有一份手写的 `ServerMsg`/`PushMsg` 镜像类型（`matchsvcClient.ts`/`proto.ts`/`Gateway.ts`）需要同步补字段。`move`（战场遭遇战）行军目前仍会落进"防守方"分支——这是一个独立于本次报告的既有问题（遭遇战里获胜方的提示也读反了），本次刻意不顺手扩大范围，留了行内注释标注。

**验证**：`server/worldsvc`、`server/gateway`、`client` 三处 `tsc --noEmit` 全绿；`server/worldsvc` 攻城/占领/遭遇战相关 e2e（`siege`/`occupy-march`/`stronghold`/`field-encounter*`，共 28 例）全过，确认新字段不破坏既有推送断言；`worldMapSiegeResultToast.ui.ts` 按新字段重写（6 例：占领胜/败分类、**同一结果重复投递仍分类正确**——直接命中本次修复的场景、attack/防守两条原路径回归），`worldMapOccupyTeamPicker.ui.ts` 去掉不再需要的 `myAttackTiles`/`myOccupyTiles` mock 字段复跑仍全过（19 例）。preview 无法稳定复现（需要完整 worldsvc + 连地相邻 + NPC 战斗 + 场景重建时序），改动靠单测覆盖。

**追加测试（同日，用户要求"加测试"）**：① 客户端新增「surviving a WorldMapScene rebuild」一例——用两个完全独立、互不共享状态的 `WorldMapContext`/`WorldMapNet` 实例模拟"派兵时的场景已经不在了"，直接对应根因描述的触发路径；先把 `applySiegeResult` 里的 `amInitiator` 临时改死为 `false`（模拟"服务端字段被忽略，退回瞎猜"的回归）复跑这批用例，**5/7 例转红**（含这个新场景 + 原本 4 例），换回真实实现后复跑 **7/7 转绿**——坐实新用例确实在验证本次分类逻辑，不是形同虚设。② 服务端三个 e2e 文件（`siege`/`occupy-march`/`field-encounter`）在既有场景里追加 `attackerId`/`marchKind` 断言而非新增用例：`occupy-march.e2e.test.ts` 三处占领胜/败推送改用 `pushes.find(...)` 精确断言 `{attackerId:'a', marchKind:'occupy'}`（占领场景是本次报告的重灾区）；expulsion 用例额外验证 b 用 `attack` 行军抢地成功时自己收到的推送是 `marchKind:'attack'`（不是 `'occupy'`）——锁定"攻城行军打赢占领中的地"这条跨路径交互不受影响；`siege.e2e.test.ts` 攻城/扫荡用例补 `marchKind:'attack'`/`'sweep'` 断言；`field-encounter.e2e.test.ts` 两个 `scenario 1`（胜/负）补 `attackerId:'a'`、`marchKind:'move'` 断言——为 §51 遗留的 `move` 遭遇战分类跟进任务预先钉住服务端数据契约。`server/worldsvc` 全量 `tsc --noEmit` 复核仍绿，三个 e2e 文件共 20 例全过。

## 52. 行军请求稳定超时（`AbortError`）——`computeMarchPath` 的敌方主城扫描在老世界上退化成近乎全表扫描（2026-08-02，用户报告）

**背景（用户报告）**：SLG 里每次占领领地都弹 `TypeError: world api POST /world/march failed: AbortError: signal is aborted without reason`。追问确认：报错之后地块**其实占领成功了**（`Marches`/领地都有记录）——服务端调用没有失败，只是客户端等不到响应先弃权了。

**排查**：worldsvc/socialsvc/caddy/cloudflared 全部健康、CPU/内存正常、日志无报错，直接 curl 生产接口也是毫秒级——初步怀疑是用户本地网络抖动。但用户反馈"每次占领都必现"，于是拿到账号信息（`publicId 233784986`，世界 `s1-0`）在生产库上直接复现：`computeMarchPath`（[`combatShared.ts`](../../server/worldsvc/src/combatShared.ts)）里为 A* 寻路收集"敌方主城会挡路"用的查询——

```js
cols.tiles.find({ worldId, type: 'base', ownerId: { $nin: excludeOwners } })
```

——实测耗时 **12.4 秒**。根因：`s1-0` 是个老世界，注册过的玩家主城（`type:'base'`，每个 3×3=9 格，且从不删除）已经攒到约 2584 个，`tiles` 集合总共 23325 条记录里 **23257 条**（99.7%）都是 `type:'base'`。2026-07-29 那次审计（[`db.ts`](../../server/worldsvc/src/db.ts) §索引注释）给这条查询配了 `{worldId,type}` 索引，但当时的假设——"`type:'base'` 命中的数量远小于整个集合"——在世界玩得越久、注册主城越多之后逐渐失效，最终这条"应该很窄"的查询变成了近乎全表扫描。同函数里另外两条查询（crossing 通道、玩家建的 blocker）结构相同，存在同样的潜在风险。这条查询单独就超过了客户端 [`WorldApiClient.ts`](../../client/src/net/WorldApiClient.ts) 的 10 秒超时——不是代码在这天变了，是这个世界的主城数量自然增长跨过了当年那个假设成立的临界点，跟"服务器今天没更新"完全对得上。

**修复**：给 `computeMarchPath` 的 3 条障碍物查询（gate/敌方主城/blocker）都加上按行军起止点算出的坐标包围盒过滤（`legBox()` + 60 格 padding，复用已有的 `{worldId,x,y}` 索引），把"扫全图"收窄成"只看行军路线附近"。Padding 选取 60（远大于 3×3 主城/普通障碍物聚簇的尺寸）而非精确到 A* 实际探索边界——短途行军（占领要求目标与自己领地相邻、士气机制也软性限制了远途行军的实际收益，见 §22/§27）绝大多数场景下包围盒会大幅收窄；只有起止点本身相距很远的行军，包围盒才会接近全图，此时退化为跟修复前一样的开销，不引入正确性风险（不会漏查真正卡在路线附近的障碍物）。

**验证**：`server/worldsvc` `tsc --noEmit` 全绿。定向重跑占领/围攻/寻路相关测试（`occupy-march`/`passage`/`field-tower`/`field-blocker`/`base-siege`/`stronghold`/`field-encounter*`/`field-redispatch`/`field-occupancy`/`field-structure-attack`/`base-integrity`/`march-return-travel-time`/`teams`/`enter-world`，共 12 文件/88 例，含「blocker 绕路」「crossing 通行」「长途占领士气衰减」等直接触碰寻路的用例）全过；随后跑了 `server/worldsvc` 全量 50 文件/399 例，同样全绿。生产库上直接验证：本地起了一个带 `rs0` 的 standalone mongod 复现原查询耗时（12.4s），但此次改动未部署到生产（未触碰线上代码），仅在本地代码 + 测试环境验证；建议下次常规发布时带上。

**追加测试（同日，用户要求"加测试"）**：`territory-connectivity.e2e.test.ts` 新增一例，直接命中本次修复本身而非仅靠既有用例侧面兜底——种下 50 条远离本次行军路线（地图另一角）的模拟"历史累积主城"`type:'base'` 噪声数据，临时给 `m.collections.tiles.find` 打一层 spy 拦截调用参数，断言敌方主城扫描那次调用的 filter 里带有 `x`/`y` 坐标区间（`$gte`/`$lte`），且区间紧贴行军起止点、离噪声所在的地图角落很远；再用捕获到的 filter 原样重新查一遍，断言噪声数据一条都不会被查出来。为确认这条断言不是形同虚设：先用 `git show HEAD~1:combatShared.ts` 把该文件换回修复前版本单独跑这一例，**必现失败**（`expected undefined to be defined`——旧查询压根没有 x/y 键）；`git checkout HEAD --` 换回修复后版本复跑转绿。`territory-connectivity.e2e.test.ts` 全 12 例过，`server/worldsvc` 全量重跑 50 文件/400 例全绿。

## 53. §51 遗留的 `move` 遭遇战分类跟进——胜负 toast 补齐（2026-08-02）

**背景**：§51 把 `SiegeResult` 分类改成服务端权威的 `attackerId`/`marchKind`，但明确留了一句"`move`（战场遭遇战）行军目前仍会落进防守方分支"——`field-encounter.e2e.test.ts` 当时就已经预先钉住了 `siege.attackerId`/`siege.marchKind==='move'` 这两个服务端数据契约（连带注释直接写"field-encounter classification is not yet wired client-side"），专等这次跟进。

**现象**：野战遭遇（ADR-051 §2.2，[`encounter.ts`](../../server/worldsvc/src/combatSiege/encounter.ts) 的 `resolveFieldEncounter`——一支 `move` 行军中途撞上敌方停留队伍/另一支行军/驻扎守军，就地开打）没有专属分支，`amInitiator && marchKind==='move'` 落进 `applySiegeResult` 的 `else`（防守方/旁观者）兜底：打赢一场遭遇战显示"领地失守"，打输了反而显示"守土成功"——两边都反了，而且遭遇战本身不涉及任何 tile 归属变化（那是 occupy 的事）。

**修复**：`WorldMapNet.applySiegeResult`（[`WorldMapNet.ts`](../../client/src/scenes/worldmap/WorldMapNet.ts)）在 `attack`/`occupy` 两个分支之后新增 `amInitiator && marchKind==='move'` 分支——胜负与 `outcome` 直接对应的轻量 toast（不弹复盘弹窗，遭遇战跟 occupy 一样是高频事件）。新增三语 i18n key `world.encounterWin`/`world.encounterLoss`（zh/en/de），英文措辞刻意避开"Territory secured"这类字眼——遭遇战不改变任何地块归属，纯粹是一场遭遇战的胜负。服务端字段（`attackerId`/`marchKind`）§51 已经全部就绪并测过，本次是纯客户端改动，不涉及 proto/`SiegeDoc`/推送链路。

**验证**：`server`（12 workspace）+ `client` 的 `tsc --noEmit` 全绿；`worldMapSiegeResultToast.ui.ts` 补 3 例（遭遇战赢/输的正确 toast + 他人遭遇战不受影响的回归），全 10 例过；`client` UI 全量 112 文件/961 例、非 UI 全量 129 文件/944 例两套全绿；`server/worldsvc` 定向重跑 `field-encounter*`/`siege`/`occupy-march`/`stronghold` 共 5 文件/28 例全绿（复用 §51 已经钉住的 `attackerId`/`marchKind` 断言，无需新增服务端用例）。

**追加测试（同日，用户要求"加测试"）**：① 补 2 例——「输的遭遇战同样不弹复盘弹窗」（跟赢的分支对称，之前只在赢分支断言过 `showModal` 未调用）；「自己发起的行军但 `marchKind` 是识别不到的种类（如 `sweep`）」不会被误判成遭遇战——钉死这个分支专门 keyed on `marchKind==='move'`，不是"任何自己发起、非 attack/occupy 的动作"的宽松判断（跟已有的"别人发起的 move"用例互补，一个测"kind 对但不是我方"，一个测"是我方但 kind 不对"）。② 证伪测试不是形同虚设：把 `applySiegeResult` 里 `s.marchKind === 'move'` 临时改成一个不可能匹配的字符串，复跑本文件——**2/12 例转红**（恰好是"自己赢/输一场遭遇战"这两例，读回旧的"领地失守"/"守土成功"反向文案；"别人发起的 move"与"自己发起但 kind 不对"两例保持绿，因为它们本就该走兜底分支，没被这次改动影响，符合预期），换回真实实现后复跑 **12/12 转绿**。`worldMapSiegeResultToast.ui.ts` 全 12 例过，`client` UI 全量 112 文件/963 例仍全绿。

**顺带发现（超出本次范围，已 spawn_task 转出）**：全量非 UI `vitest run` 有 7 例失败（`campaign-knobs`/`garrison`/`siege-battle.test.ts`），主检出（`02.08.2026` 分支当前 tip）同样复现，与本次改动无关——疑似近期 `destroy_base` 提前结束修复（`ad01a623`/`5de02ba9`）在这几个既有场景里判定过宽，已转出独立任务跟进，不在本次范围内处理。

## 54. §53 遗留的 `destroy_base` 提前结束误判——收窄到仅 `attackerArmy` 剧本场景（2026-08-02）

**背景**：§53 末尾记录的 7 例失败（`campaign-knobs.test.ts`×4、`garrison.test.ts`×2、`siege-battle.test.ts`×1）跟进排查。

**根因**：`ad01a623`（§50）加的早退检查——`objective.kind==='destroy_base' && !hasLivingAttackerUnits()` 立即判防守方胜——隐含前提是"进攻方军队在引擎构造时一次性同步入场，没有逐 tick 补兵的活指令输入"（§50 原文），只对 `level.attackerArmy` 剧本化铺兵场景成立。但 `destroy_base` 目标同时也用于普通 PvE 战役/玩家出牌驱动的围攻（`campaign-knobs`/`garrison`/`siege-battle` 三个测试文件覆盖的就是这类场景）——这类场景里 Bottom 方是靠手牌/灵墨经济逐 tick 出卡，`attackerArmy` 从未设置，`board.units` 里查不到 Side.Bottom 单位只是"这一刻还没打出牌"的正常瞬时状态，不是"全灭"。`hasLivingAttackerUnits()` 对这两类场景一视同仁地查 board 上的 Bottom 单位，导致普通出牌流程在第 0/1 tick（尚未打出第一张牌）就被误判成"进攻方已全灭"，立即 `GameOver`。

**修复**：`winCondition.ts` 的早退条件追加 `this.level!.attackerArmy && this.level!.attackerArmy.length > 0` 前置守卫——只有关卡确实配置了剧本化 `attackerArmy` 时才允许 `hasLivingAttackerUnits()` 生效判负；普通出牌驱动的 `destroy_base` 关卡（无 `attackerArmy`）不再受这条早退影响，跟修复前一样只由 `battleTimeoutTicks`/`durationTicks`/破基地三条既有分支收尾。`hasLivingAttackerUnits()`/`hasLivingEnemyUnits()` 本身不改。

**验证**：`server/engine` `npm test`（`tsc -b` + `node --test`）77 例全过，含 §50 新增的 `attackerArmy` 剧本化早退用例（确认加了守卫之后该用例仍然早退，未被误伤）；`client` 非 UI 全量 129 文件/944 例、UI 全量 112 文件/963 例两套全绿，此前失败的 `campaign-knobs.test.ts`/`garrison.test.ts`/`siege-battle.test.ts` 三文件单独重跑（64 例）全绿。

**追加测试（同日，用户要求"加测试"）**：`gameEngine.test.ts` 新增「destroy_base does NOT early-exit on a card/ink-driven level with no attackerArmy, even with zero Bottom units on board」——专门钉死本次守卫本身：`destroy_base` 关卡不设 `attackerArmy`，全程不喂任何 `play_card` 指令（因此 board 上永远查不到 Side.Bottom 单位），跑 50 tick 后断言 `phase` 仍是 `Playing`。证伪测试不是形同虚设：临时把守卫条件改回 §50 原始版本（`objective.kind==='destroy_base' && !hasLivingAttackerUnits()`，去掉 `attackerArmy` 前置判断）单独跑这一例——**必现失败**（`AssertionError`：断言信息原样命中"no attackerArmy configured → the wipeout early exit must not fire"，证明确实是本次守卫在拦这个误判）；换回修复后的版本复跑，转绿，且与 §50 已有的「`attackerArmy` 剧本化早退」用例互补（一个测"该早退时早退"，一个测"不该早退时不早退"）。`server/engine` 全量 `npm test` 78 例全过，`client` 非 UI 129 文件/944 例、UI 112 文件/963 例两套复跑仍全绿。

## 55. 编辑队伍网格：基地列加基地图标，去掉没人注意到的「出兵」文字（2026-08-02，用户看截图提出）

**背景**：用户看着"编辑队伍"（`DefenseEditorScene` 攻击模式，玩家给出征队伍布阵的界面）截图提出——网格里基地所在的两列（`BASE_COLS=[5,6]`，只有底色区分）方向感弱，建议在地图上把自己基地画出来，让玩家更直观理解哪些格子在前面、哪些在后面。追问范围后用户明确：只改这一个界面（不涉及防守布阵编辑器、也不涉及大地图 worldmap 主图）；图标直接复用 PvP 对战里的基地图标（`BoardView.ts` 用的 `game_base.png`），不用新画；顺带把那句"出兵"文字去掉——用户说自己从来没注意到过这行字。

**实现**：`DefenseEditorScene/render.ts` 的 `renderGrid()`——攻击模式（`!hasBuildingRow`）专属分支：base 列（`isBaseCol`）在最靠近出征边缘的那一行（`dr === rows-1`，往下一格就是玩家自己的主城，只是不在这 8 行显示范围内）画一次 `game_base.png`（沿用 `drawArtFit` 的按比例居中缩放，跟画英雄/建筑同一套逻辑），宽度铺满两个基地列（`cellW*2`）。原本"defense → 建造行 / attack → 出兵"那句左侧文字标签，attack 分支直接整体去掉（defense 模式的"建造行"标签不受影响，照常保留）；`i18n` 里的 `world.team.frontRow` 键（zh/en/de 三份）一并删除，因为已经没有代码引用。

**验证**：`client` `tsc --noEmit`（含 `test/**`）全绿。可视化验证走了标准的"启动整个客户端"路径，但主检出当前有其它会话的未提交 WIP（`WorldMapPanels.ts`/`WorldMapInput.ts` 缺了 `infoTab`/`openShopPanel`），导致 webpack 编译直接失败，且这次会话里 Browser pane 一直 "not displayed, so the page is not compositing frames"（`client-run-and-visual-verify` 备忘录里记过的已知环境限制，不是本次改动引入的）——两条路都走不通，遂改用备忘录推荐的 headless `test:ui` 场景构造验证：`test/ui/defenseEditorAttackCards.ui.ts` 新增一例，直接构造 `DefenseEditorScene`（攻击模式，无需登录/后端），`spy` 住 `drawArtFit`，断言基地图标那次调用的坐标/尺寸精确落在"基地列×最后一行"，且 `bodyLayer` 里不再有文字节点显示旧的 `'Deploy'` 标签。全量 `npm run test:ui`（112 文件/961 例）跑过，除本次新增这例外只有 1 例失败（`worldMapInfoScroll.ui.ts`，指向前述 WorldMapPanels 的 WIP 缺口，`document is not defined`，与本次改动无关，未去动那份 WIP）。

**追加测试（同日，用户要求"加测试"）**：补了一条防守模式的回归用例——`DefenseEditorScene defense mode — buildRow label + base icon untouched by the attack-mode change`：新搭一个 `mode:'defense'` harness（`getDefense` mock 返回 `null`，`applyConfig` 走"离线/未设置"分支，够用来验证纯渲染），断言"建造行"文字标签仍然渲染、且从没触发过基地图标那次 `drawArtFit` 调用（同样按"调用宽度 ≈ 2 格"的形状去找，跟 attack 模式那条测试用同一种识别方式）——这条锁的是本次改动把行标签渲染从无条件三元改成 `if(this.hasBuildingRow)`、基地图标又额外挂了 `!this.hasBuildingRow` 守卫，两处改动对防守模式互不误伤。证伪测试确认不是形同虚设：把 `git show <本次改动前>:render.ts` 换回改动前的版本单独跑这两条新用例——attack 模式那条**必现失败**（`expected undefined to be truthy`，因为改动前代码压根没有基地图标这条分支）；defense 模式回归那条按预期保持通过（防守模式渲染逻辑改动前后本来就没变，这条测的是"以后别改坏"，不是"这次改动修了什么"）。换回改动后的版本复跑，两条都转绿。`npx vitest run --config vitest.ui.config.ts test/ui/defenseEditorAttackCards.ui.ts` 18 例全过，`npm run typecheck` 复核仍绿。

## 56. Shop 面板独立化 + 物品卡样式 + World 下 Nation/Season 合并（2026-08-02，用户看截图提出）

**背景**：用户看着 Territory Overview 面板截图提出三点：①Shop 单独拎出来做一个独立界面，入口按钮放到拍卖行（Auction）左边；②Shop 里的商品用"物品卡"样式展示（参考装备卡 `EquipmentScene/inventory.ts` 的 `renderInstanceCell`：图标框在左、名称/成本在右、操作按钮占满卡片底部一条），而不是当时的纯文字行；③World 标签下的 Nation 和 Season 两个子 tab 合并，一起展示，不再来回切换。

**实现**（均在 [`WorldMapPanels.ts`](../../client/src/scenes/worldmap/WorldMapPanels.ts)/[`WorldMapContext.ts`](../../client/src/scenes/worldmap/WorldMapContext.ts)/[`WorldMapInput.ts`](../../client/src/scenes/worldmap/WorldMapInput.ts)）：
- **入口按钮**：`renderHeaderHud()` 里在 Auction 按钮左侧新增一个同高度/同风格的 Shop 按钮（图标 `coinSack`），资源产量 cluster 的 `rightBound` 从 `aucBtn.x-8` 改成 `shopBtn.x-8` 让出位置；新增 `ctx.shopBtnRect`，`WorldMapInput.handleDown` 里点击它调用新的 `panels.openShopPanel()`。
- **独立 Shop 面板**：新增 `openShopPanel()`/`renderShopPanel()`（结构照抄 `renderReplayPanel` 的独立弹窗模式：dim 背景 + `sketchPanel` + 标题 + Close，走同一套 `modalDimRect`/`modalBtnRects` 通用点击路由）+ 新的 `renderShopItemCard()`：每个商品一张卡（`sketchPanel` 边框 + 左侧图标框 `buildIcon` 按 `kind` 选图标：`troop_speedup→spd`/`resource_pack→coinChest`/`protection→armor`/`battle_pass→trophy` + 右侧名称/成本 + 底部整宽 Buy/Active 按钮带），2 列网格、`beginScrollList` 支持滚动。原来 World 标签下的 Shop 子 tab 连同它的纯文字行渲染整段删除；`ctx.shopItems`/`shopLabel()`/battle-pass 已购买灰化逻辑原样保留，只是搬进了新面板。
- **Nation+Season 合并**：`renderWorldTabBody()` 去掉三个子 tab 按钮（原来是 `nations`/`season`/`shop` 横排三个 `panelButton`），改成固定顺序：Season 摘要（静态文案，不参与滚动）在上，Nations 列表（可滚动，行渲染逻辑不变：★ + 名称 + 坐标 + 我的国家显示 Rename、别人的显示 Held/Free）在下，一次性全部展示。`ctx.infoTab` 字段整个删除（不再需要子 tab 状态）。
- `world.shopTitle`（en/zh/de 三份，独立面板标题，复用 `world.tabShop` 的文案）新增；`world.tabNations`/`world.tabSeason`/`world.tabShop` 三个既有 key 复用为按钮/小节标题，未新增冗余文案。

**测试改动**：`worldMapInfoScroll.ui.ts` 整体重写——去掉 `infoTab`/shop 相关的全部用例，nations 的滚动/拖拽/滚轮覆盖保留但去掉了 `infoTab` 选项，"in-list 按钮 tap-vs-drag" 那组回归（防止在滚动列表里按钮被 pointer-down 直接触发而不是等 pointer-up）改用 Nation 的 Rename 按钮验证（`openRenameInput` 走 `document.createElement`，测试环境没有全局 `document`，改成 `vi.spyOn` 到 `panels.openRenameInput` 而不是断言真实 DOM 副作用）；另加一组季节摘要内容断言（`modalTexts()` 直读 `modalLayer` 的直属 `PIXI.Text` 子节点）——季号/状态/人口文案、有/无 `resetAt` 时的倒计时文案、无数据时的占位横线、以及"国家列表为空但季节摘要仍显示"的组合态。新增 `worldMapShopPanel.ui.ts`（15 例）覆盖独立面板：`openShopPanel` 的 joined 门槛/首次拉取缓存、卡片 Buy 按钮点击触发 `doBuyShopItem`、长列表滚动、Close 按钮、battle-pass 已购买灰化、原来挂在 shop 子 tab 上的 tap-vs-drag 回归，以及卡片内容本身（`allModalTexts()` 递归进滚动列表的遮罩子容器读文本）——每张卡的本地化名称+成本文案、面板顶部的实时余额文案。`worldMapHeaderProduction.ui.ts` 补两条断言：Shop 按钮紧贴在 Auction 左边、资源 cluster 右边界让给 Shop 按钮而不是 Auction 按钮。`worldMapTerritoryPanel.ui.ts` 新增一组"header Shop 按钮"路由回归（命中 `shopBtnRect` 调 `openShopPanel`、命中区域外不调、Shop 按钮不会吞掉紧邻的 Auction 按钮点击），`worldMapHeaderInset.ui.ts` 的手搭 ctx 补上 `shopBtnRect`（否则 `WorldMapInput.handleDown` 新增的 Shop 按钮命中判断会读到 `undefined.w` 直接抛错）。

**验证**：`client` `tsc --noEmit` 全绿；`npx vitest run --config vitest.ui.config.ts`（113 文件/984 例）全绿。可视化验证：本机 Browser pane 对这个 WebGL 应用一贯需要走 `client-run-and-visual-verify` 备忘录里"TEMP `globalThis.__NW_DEBUG` 钩子 + 手搭 ctx + `renderer.render()` 两次 + `toDataURL()` + POST 到本地 collector"的标准路径（`showModal()` 那条记录）——本轮成功复现：起 `game`（9090）dev server，在 `app.ts` 里临时挂 `{app, PIXI, WorldMapPanels}`，一次 `javascript_exec` 里手搭最小 `WorldMapContext` 分别调 `openShopPanel()`（6 个商品，2×3 卡片网格，Shop/Auction 按钮并排）和 `renderTerritoryPanel()`（`territoryTab:'world'`，Season 摘要 + 3 条 Nation 混合 mine/held/free 状态）两张截图，确认排版符合预期后把临时钩子从 `app.ts` 里完整移除（`git diff` 确认该文件恢复干净）。

**协作备注**：本次改动期间 `git status` 显示同一份主检出里还有另一个会话在并行改 `DefenseEditorScene`/`sketchUi.ts`/`CityScene` 等文件（见上一条 §55 记录），以及本文件本身也带着他们尚未提交的 §55 条目——两边改动的文件集合没有重叠，属于预期内的共享检出场景（`claudedocs/worktrees.md`），提交时务必只 `git add` 本次任务改动的具体文件路径。

---

## 57. 玩家自己的基地贴图盖住后方一大片格子——打包脚本拆出独立的高度预算（2026-08-02，用户看截图提出）

**背景**：用户截图圈出世界地图上自己的基地和旁边一个 NPC 营地对比——NPC 营地严丝合缝落在自己的 3×3 地块里，自己的基地却明显"高出一截"，把后方约两排格子压在下面，同时也看不出它到底占哪几格。用户问"图片是不是要重新生成，并且做一些限制"。

**根因**：不是画风问题，是构图和一条隐含的长宽比假设。世界地图是 2:1 等轴测（`ISO_RATIO = 0.5`），3×3 地块屏幕上**宽 3 tile、高只有 1.5 tile**；而 [`WorldMapRenderer/city.ts`](../../client/src/scenes/worldmap/WorldMapRenderer/city.ts) 把图集 cell 画成 `BASE_SPRITE_TILES = 3.2` tile 的**正方形**（`sprite.width = sprite.height = baseSpriteTiles * tp`）。`city_atlas` 的美术自带一块等于地块的等轴测地台、建筑矮宽，`contentTop` 大（lv1 营地 0.50）→ 实绘高度约 1.6 tile ≈ 地块高度，正好贴合；`playerbase_atlas` 这套"文具堡垒"没有地台、物体铺满方形画幅（prompt 还把等级递进写成"越来越高"），`contentTop` 只有约 0.20 → 实绘高度约 2.5 tile，比地块高出整整 1 tile。`cityPlotMaskPoints` 只裁**横向**溢出（上方是 `tallPx` 故意放行，免得切掉塔尖），所以纵向没有任何约束。原来 `pack_playerbase_atlas.js` 里那个正方形 `CONTENT_SCALE = 0.8` 宽高同缩，改不了导致问题的长宽比，只能整体变小。

**实现**（[`art/ui/slg-playerbase/pack_playerbase_atlas.js`](../../art/ui/slg-playerbase/pack_playerbase_atlas.js)）：`CONTENT_SCALE` 拆成两个独立预算，`fit: 'inside'` 取先触底的那个——`CONTENT_W_FRAC = 0.8`（宽度照旧，从没溢出过）+ `CONTENT_H_FRAC = BASE_FOOTPRINT × ISO_RATIO × HEIGHT_BUDGET_K / BASE_SPRITE_TILES`，由地块真实屏幕高推出，`HEIGHT_BUDGET_K = 1.2` 是留给旗杆塔尖的余量。对现有这批近正方形的图触底的永远是高度：10 帧的 `contentTop` 全部从 0.20~0.35 变成 0.44，绘制高度 2.5 → 1.8 tile。刻意保持等比、不做非等比拉伸（那会把手绘等轴测透视压变形），代价是宽度跟着缩到约 1.75 tile，在 3 tile 宽的地块上略显瘦——明确记录为权宜之计，彻底解决要靠按新构图硬规重出的美术。

**打包链路的坑**（顺带修掉）：2026-07-27 的资源重组（`072131d8`）把源 atlas 合并进 `world_atlas` 后**把源文件从仓库删了**，`art/scripts/mergeAssetAtlases.js` 因此已经跑不起来（`Input file is missing`），重跑 `pack_playerbase_atlas.js` 的产物根本进不了客户端真正读的合并页。新增 [`art/scripts/patchMergedAtlas.js`](../../art/scripts/patchMergedAtlas.js)：把某个子图集的帧**原位重新盖印**回合并页（帧尺寸不变 → 坐标一个不动，只换像素 + `contentTop` 等自定义字段；尺寸变了直接报错要求整页重打）。合并页是 blend 合成，盖印前必须先把目标矩形清零，否则旧图会从新帧的透明区透出来。

**美术侧**：[`design/product/player-base-image-prompts.md`](../product/player-base-image-prompts.md) 新增"构图硬规"一节并按它重写了 10 条 prompt——必须画等轴测地台、内容外接框宽高比约 10:7、建筑高度不超过地台菱形高度的 1.2 倍、等级递进从"越来越高"改成"占地/圈层/密度越来越满"。旧版 prompt 移除（git 历史里可查）。

**测试**：`cityAtlasContentTop.ui.ts` 新增两条断言，从 `contentTop` 反推绘制高度（美术底对齐，故绘制高度 = `(1 - contentTop) × BASE_SPRITE_TILES` tile）——既不许超过 `BASE_FOOTPRINT × ISO_RATIO × 1.2` 的预算（防止将来重打包又回到正方形缩放），也不许小于地块自身高度（防止缩没了）。

**验证**：`client` `tsc --noEmit` 全绿；`cityAtlasContentTop` / `cityAtlasContentTopFallback` / `worldMapBaseHpBar` 三个 UI 测试文件 17 例全绿。可视化：本机 Browser pane 这次连 `computer{action:"screenshot"}` 都直接报"pane is not displayed, so the page is not compositing frames"（见 `worldmap-standalone-debug-render` 备忘录记的同一限制），改用离线几何核对——用 `city.ts` 原样的摆放公式（底部中心锚点落在地块前顶点、`cityGroundFwdPx` 前移量、`BASE_SPRITE_TILES` 正方形）把真实图集帧合成到等轴测网格上，逐个比对 `HEIGHT_BUDGET_K` 取 1.2/1.35/1.5/1.67 的效果并与 `city_lv1` 营地并排作参照，据此定下 1.2。**像素级的真机核对没有做**，需要用户在自己开着的客户端里刷新确认。

---

## 58. 驻扎（驻守）目标收紧为「己方 + 盟友」，中立/敌方一律不可驻扎；不支持的菜单选项直接隐藏而非置灰（2026-08-02，用户截图报告）

**背景**：用户截图一块中立资源地（Ink Lv.1）的占领弹窗，红圈圈出「移动并驻扎」按钮，指出：①驻守（驻扎，§38/ADR-051 P3a 的「busy 且主动防守 3×3」态）只应该能驻守自己和盟友的领地，敌人的和中立的地都不该能驻守；②弹窗里不支持的选项（截图里灰掉的「占领」）应该直接不显示，而不是置灰。逐代码核对后发现现状比截图更宽：`combatMarch/command.ts` 的 `move` 校验对 `停留 idle` 和 `驻扎 garrison` 两种意图一视同仁（§38 落地时的既有测试 `field-garrison.e2e`/`field-redispatch.e2e` 明确把 garrison 派到中立地并断言成功），而**盟友领地**在 `WorldMapInput.onTileClick` 里完全没有专属分支——落入 `tile?.occupied` 的通用"敌方"分支，只提供一个必定被服务端 `ALLY_TILE` 拒绝的"进攻"按钮。判定这不是照抄既有设计的误报，而是用户在收紧一条已实现但从未明确拍板过边界的规则，遂据此改服务端校验 + 补client 盟友分支，而非仅做客户端隐藏。

**规则（新拍板）**：`停留 idle`（无防御声明）保持原样——只能停自己的地或空地（中立），从不落到别人（含盟友）的地上。`驻扎 garrison`（主动防守 3×3、算 busy）收紧为**只能落在自己的地，或一个"友方"账号（家族 / 本宗门 / 结盟宗门——即 `WorldCoreVision.friendlyAccountIds` 用来拦截"进攻友方"的同一个集合）的地上**——不再接受中立地，也从未接受非友方的地。

**实现**：
- **服务端**（[`combatMarch/command.ts`](../../server/worldsvc/src/combatMarch/command.ts) 的 `move` 分支 + [`combatMarch/arrival.ts`](../../server/worldsvc/src/combatMarch/arrival.ts) 的 `tryParkTeam`，两处各自独立校验：前者是派发时的快速失败，后者是到达时因途中地块归属变化而必须的二次核验，同一条规则改两遍）：`toTile.ownerId !== accountId` 时，只有 `stationMode==='garrison'` 且 `friendlyAccountIds(worldId, accountId).has(ownerId)` 才放行（否则维持原有 `TILE_OCCUPIED`「用进攻」报错）；`!toTile.ownerId`（中立）分支新增 `if (isGarrison) throw TILE_OCCUPIED` 前置检查，`停留 idle` 不受影响。
- **客户端**（[`WorldMapInput.ts`](../../client/src/scenes/worldmap/WorldMapInput.ts)）：`onTileClick` 在 `tile?.mine` 分支之后、`tile?.occupied`（敌方）分支之前插入新的 `tile?.ally || tile?.allySect` 分支——盟友领地（家族同盟或结盟宗门成员）显示业主名 + 结构/耐久信息，按钮只给「移动并驻扎」（已驻扎则显示「召回驻军」），不给进攻，不给"停留"（idle 在盟友地上没有意义，规则也没要求）；中立地分支的 `else` 只保留「移动到此（停留）」，去掉「移动并驻扎」。同一批顺手把三处"不支持就置灰"（占领连通性 `occupyConnected`、就地占领、迁城 `canRelocate`）改成不满足条件时**整个按钮不 push**，而不是 `disabled:true` 灰显——用户在同一张截图里提的第二点，`WorldMapPanels/base.ts` 的 `disabled` 灰显渲染代码本身没删（其它场景仍可能用），只是这三处调用点不再传它。
- **i18n**：新增 `world.allyTile`（"盟友领地"/"Ally Territory"/"Verbündetes Gebiet"，zh/en/de 三份），复用既有 `world.actGarrison`/`world.actRecallStation`。

**测试改动**：`field-garrison.e2e.test.ts` 三个既有用例（garrison 到中立地的 3×3 覆盖注册/召回、中途目的地被抢占后回退原地）改为先把目标格预置为 `ownerId:'a'`（己方地），验证的覆盖/occ 机制本身与地块归属无关；新增 3 例：garrison 派中立地必拒（`/own or allied territory/`，同一目标改 `停留 idle` 仍成功）、garrison 派同家族盟友的地必成功（覆盖注册在目标格、地块 `ownerId` 保持盟友不变，驻扎队伍仍是 `mine`）、garrison 派非盟友对手的地仍必拒（`/use attack/`，等同任意敌方地）。`field-redispatch.e2e.test.ts` 的"驻扎锁死需先召回"用例同样预置目标格为己方地。客户端新增 [`worldMapGarrisonAllyRules.ui.ts`](../../client/test/ui/worldMapGarrisonAllyRules.ui.ts)（6 例：中立地只给 Move 不给 Garrison、敌方地只给 Attack、家族盟友地/结盟宗门盟友地都只给 Garrison 不给 Attack、点 Garrison 派发 `move+garrison`、已驻扎盟友地显示 Recall）；`worldMapOccupyConnectivity.ui.ts`/`worldMapRelocateGate.ui.ts` 的"灰显"断言改「按钮整体不存在」，删掉两处"点击灰按钮弹 toast"的用例（按钮已经不存在，点不到）；`worldMapBaseClick.ui.ts` 的"落单 mine 格子仍走通用菜单"用例补齐周围 8 格同为 mine（否则新的 `footprintAllMine` 门槛会让 Relocate 按钮从预期的标签列表里消失）。
- **验证**：worldsvc `tsc --noEmit` 全绿，`npx vitest run`（50 文件/403 例，含以上改动）全绿；client `tsc --noEmit` 全绿，`npx vitest run --config vitest.ui.config.ts`（114 文件/988 例）+ `test/i18n.test.ts`（三语 key 齐全）全绿。可视化验证：中立地弹窗截图确认「移动并驻扎」按钮已消失、仅剩「移动到此（停留）」（本机单账号 dev world 可直接复现）；盟友领地分支需要第二个同家族/同宗门账号才能在真实地图上点出来，本轮未做实机截图，逻辑由上述 e2e / UI 单测覆盖。

**追加测试（同日，用户要求"加测试"）**：合入后发现 `field-garrison.e2e.test.ts` 的「盟友」覆盖只测了同家族一种，`friendlyAccountIds` 其实还认「结盟宗门」（不同家族、宗门互相结盟）这条更宽的路径，且到达时的二次核验（`tryParkTeam` 的 friendly 重判）此前只覆盖了"全程没变化"的happy path，没有"派发时是友方、途中变敌方"的对抗性场景。补两例：①仿 `alliance-mark.e2e.test.ts` 的 `FakeSocialsvc`（精简版，只实现 `friendlyAccountIds` 实际读的 `getFamiliesBySect`，其余接口方法留空实现满足类型）+ 两个不同家族但互相结盟的宗门（`sects` 集合直插 `allySectIds` 双向），验证跨宗门结盟（非同家族）同样能成功 garrison 到对方地块；②派发时目标是友方地块（校验通过），行军途中该地块被真正的敌对玩家攻占（直接 `$set ownerId:'rival'`），到达时 `tryParkTeam` 必须重新判定为非友方并拒绝落地——回退到出发地，而不是信任派发时的判定就地落到已经易主的敌方地块上。`npx vitest run test/field-garrison.e2e.test.ts`（9 例，含原 7 例）+ 全量 `npx vitest run`（52 文件/419 例，另一并行会话新增的用例也一并跑过）全绿。

---

## 59. Territory Overview 面板从纯文字堆叠改成资源表格 + 统计卡片（2026-08-02，用户看截图提出）

**背景**：用户截图圈出 Territory Overview 面板的 Overview 分页，指出五种资源、Troops/Territory、Season/Pop 全部是同样字号左对齐堆叠的文字行，"看起来就是一堆信息堆在一起"，要求整理成表格或更清晰的呈现形式。

**实现**（[`WorldMapPanels/territory.ts`](../../client/src/scenes/worldmap/WorldMapPanels/territory.ts) 的 `renderTerritoryPanel()` overview 分支）：
- **资源表格化**：Ink/Paper/Graphite/Metal/Sticker 五行改成图标（复用 HUD 顶部产量条同一套 `getResTexture`）+ 名称左对齐、数量右对齐（列位 `pw*0.62`）、产量右对齐三栏，行下加一条 `C.light` 细分隔线（`PIXI.Graphics.lineStyle`），读起来是表格而不是五条独立文字。
- **Troops / Territory 改成统计卡**：两张等宽 `sketchPanel`（红边框），左侧图标（`swords`/`castle`）+ 小号灰字标签 + 大号红字数值，替换原来两行加大字号的纯红字——给这两个"标题级"数字单独的视觉容器，不再只是字号更大的同一堆栈。
- **Season/Pop 收成一行**：合并成单行灰色小字放最下面，跟上面的表格/卡片留出额外间距，作为次要信息收尾，不再单独占两行跟 Troops/Territory 抢视觉权重。
- 以上改动都是纯渲染重排——没有新增按钮/交互，`modalBtnRects` 数量（3 个 tab + Close）不变。

**测试改动**：[`worldMapTerritoryPanel.ui.ts`](../../client/test/ui/worldMapTerritoryPanel.ui.ts) 的 Overview 分组新增 6 例：资源表格每行的 label/amount/yield 文本断言、Troops/Territory 两张卡各自的 label/value 文本断言、确认表格+卡片不引入额外按钮（仍是 4 个）、Season 数据存在时的合并行文案、Season 数据缺失时该行完全不渲染。

**验证**：`client` `tsc --noEmit` 全绿；`npx vitest run --config vitest.ui.config.ts test/ui/worldMapTerritoryPanel.ui.ts`（20 例）全绿。可视化验证：本机 Browser pane 对这个 WebGL 应用一贯的"pane 未显示，无法合成帧"限制（`client-run-and-visual-verify` 备忘录）这次同样命中，改走该备忘录记录的标准替代方案——临时在 `app.ts` 挂 `globalThis.__NW_DEBUG = {app, PIXI, WorldMapPanels}`，一次 `javascript_exec` 里手搭最小 `WorldMapContext`（数值照抄用户截图）直接调 `renderTerritoryPanel()`、`renderer.render()` 两次、`toDataURL()`、POST 到本地 collector 落盘截图，确认排版符合预期后把临时钩子从 `app.ts` 完整移除（`git diff` 确认该文件恢复干净）。资源图标格在这条离线渲染路径下是空的（未走正常图集预加载），属于验证路径本身的限制，不是代码问题——真实游戏流程里图标会正常显示。

**2026-08-03 续**：用户按 §57 的构图硬规重出了 10 张图（`art/ui/slg-playerbase/`，AI 出图 UUID 命名 + 一张备用）。全部带等轴测地台、矮宽、按密度递进，外接框宽高比 1.19~1.89（旧图约 1.0，脚本目标 1.43）——10 张里 7 张宽于目标，改由**宽度**预算触底，高度自动落在预算内，`HEIGHT_BUDGET_K` 只对 Lv.8/Lv.10 轻微生效。等级 ↔ 源图的对应关系（按能对上哪条 prompt 的特征物判定）和已知小瑕疵列在 [`player-base-image-prompts.md`](../product/player-base-image-prompts.md) 的"接入现状"表里。源图 `playerbase_l1..l10` 统一改成 `.png`（原 l6~l9 的 `.webp` 删除，避免打包脚本的 `.png` 优先解析留下同名死文件）。测试改动：§57 加的下界断言（"绘制高度不低于地块自身高度"）在新图上必然失败——它默认了每帧都由高度预算触底，而够宽的稀疏营地（Lv.1，宽高比 1.89）是宽度触底、本来就该比地块矮；下界放宽到地块高度的一半，注释说明为什么不能收紧。验证：`tsc --noEmit` 全绿，UI 测试 114 文件 / 1009 例全绿，10 个等级逐个真机截图核对（`?worldmap&desk=N` 临时调试分支 + Playwright，截完已清理）。

---

## 60. `openapi-social.yml` 补 Error schema + ErrorResp（comm-audit-p2-remaining §43 遗留的第 4 项，2026-08-03，AI 主动推进）

**背景**：comm-audit-2026-07-27 fix arc 的 P2 尾巴里，`world`/`auction` 两份契约已经在 2026-08-02 补上了 `Error` schema + `ErrorResp` 响应（逐 operationId 核对真实 handler 抛出的 `ErrorCode`），`social` 当时明确排除在外。本次按同一套方法补齐 `server/contracts/openapi-social.yml`。

**实现**：`components.schemas.Error`（`{code, message}`）+ `components.responses.ErrorResp`（envelope，`ok:false` + `error`），与 world/auction 完全一致的写法。逐个 operationId 追踪 `server/socialsvc/src/httpApi.ts`（705 行，唯一的请求分发入口，所有 `/social/*` 路由共享同一个 try/catch，未捕获的 `SlgError` 由 catch 块统一转成对应状态码）+ `familyService.ts`（`SlgError` 直接 throw）+ `friendService.ts`/`mailService.ts`（返回 `{kind:'error', error}`/布尔值，由 `httpApi.ts` 里的 `sendSocialErr`/内联判断转换）三个 service 文件，给 35 个 operation 各自标注准确的状态码（不是无脑给所有路径贴同一组 400/401/500）——例如 `getMyFamily`/`getFamily`/`browseFamilies` 这类纯查询、内部从不 throw 的接口只有 401/500 兜底；`createFamily` 有 400（tag 格式/宽度/敏感词）+ 409（重复入会）；`sendChatMessage` 除 400/403/404 外还有 429（`allowChat` 速率限制）。

**副发现**（追踪过程中顺手发现的两处契约缺口，随手一并修掉）：
1. **`/social/friends/report` 完全没进契约**——`httpApi.ts` 里举报接口本身在 2026-07-27 那轮就已实现（design-doc-audit-2026-07 记过），但没人把它加进 `openapi-social.yml`，contract-first 的口径一直是假的。本次一并补上 `operationId: reportFriend`（`POST /social/friends/report`，400/401/404/500）。
2. **`/social/player/{accountId}/rank`（`getPlayerRank`）声明了但从未实现**——契约里一直有这条路径，`routes.gen.ts` 也照常生成了类型，但 `httpApi.ts` 里根本没有匹配这条 path 的分支，实际调用会落到兜底的 `endpoint not found`（404），永远不会走到契约里描述的 200 成功响应。客户端也从未调用过它（`getProfileExtra` 是实际在用的等价接口）。这不是本次任务能单方面拍板修的东西（是该补实现，还是该把这条路径从契约里删掉，是产品/契约治理层面的决定），只在 yml 里加了行内 `summary` 注释记录现状，留给用户决定。

**验证**：`server/socialsvc && npm run gen:api:social`（regen `routes.gen.ts`）+ `gen:api:social:check`（drift check，35 operations / 18 schemas，通过）；`server` 全量 `npm run typecheck`（11 个 workspace 全绿，其中 `@nw/shared`/`@nw/engine` 在这个新 worktree 里之前没 build 过，顺手 build 了一次，跟本次改动无关）；`client && npm run rest:gen` + `npx tsc --noEmit` 全绿；`socialsvc` `npx vitest run`（7 文件 / 89 例）全绿。未做可视化验证——纯契约/类型层改动，不影响任何渲染路径。

---

## 61. §60 遗留的 `getPlayerRank` 死路由——拍板删除，而非补实现（2026-08-03，用户要求拍板）

**背景**：§60 记录时把 `/social/player/{accountId}/rank`（`getPlayerRank`）标成"留给用户决定"；用户随后明确要求"拍板一下"，把决定权交回来。

**调查**：追了 `getPlayerRank` 这条链路的完整历史，而不是只看当前状态——`SOCIAL_DESIGN.md`"资料卡统一改造（2026-07-23）"那段记录着：ProfilePopup 曾经在好友列表/家族成员/世界频道三处各自手动拼 rank/elo/family/sect 字段，其中家族场景是"手动异步 `getPlayerRank`"；2026-07-23 那次改造把三处全部收敛进统一的 `GET /social/profile/:publicId/extra`（`getProfileExtra`），三处手动调用（含家族场景的 `getPlayerRank`）当时就都删掉了。`server/socialsvc/src/metaClient.ts` 里的 `getPlayerRank(accountId)`（供 socialsvc 内部调用 meta `/internal/player?accountId=` 的封装方法）在这轮统一改造之后就已经没有任何调用点——`grep '\.getPlayerRank('` 全仓库零命中，是个从 2026-07-23 起就孤立的方法；契约里的 `/social/player/{accountId}/rank` 路由则是更早遗留、从未真正对接到 `httpApi.ts` 的路由声明。也就是说 `getPlayerRank` 提供的能力（按 accountId 查 rank/elo）不是"还没做"，而是"做过、后来被 `getProfileExtra` 整体取代、旧路径没人回来清理"。

**拍板：删除，不补实现**。理由：①功能已被 `getProfileExtra` 完整覆盖（后者是 rank/elo 的超集 schema，外加 familyName/sectName）；②补实现等于把一条已经被验证多余的旧接口复活，纯增加维护面、零消费方；③其内部依赖的 `metaClient.getPlayerRank(accountId)` 本身已是孤儿代码，实现它还得先把这段孤儿代码找回意义——不划算。

**实现**：从 `openapi-social.yml` 删除 `/social/player/{accountId}/rank` 路径 + 未再被引用的 `PlayerRankView` schema（确认 `ProfileExtraView` 是独立 schema，不 `$ref` 它，删除安全）；`server/socialsvc/src/metaClient.ts` 删除 `SocialMetaClient.getPlayerRank` 接口方法 + `HttpSocialMetaClient`/`nullSocialMetaClient` 两处实现（保留 `getPlayerRankByPublicId`，这条仍是 `getProfileExtra` 的唯一数据来源）；`server/socialsvc/test/harness.ts` 的 `FakeSocialMetaClient` 同步删除假实现。`metaserver` 的 `/internal/player?accountId=|publicId=` 端点本身不动——`grep 'internal/player'` 确认 `gateway/src/metaClient.ts`（自己的 ELO 查询用途）和 `admin/src/clients/player.ts` 仍在用 accountId 变体，只是 socialsvc 自己的封装方法是孤儿，不影响这条端点对其它服务的价值。

**验证**：`gen:api:social`（34 operations / 17 schemas，比 §60 的 35/18 各少 1）+ `gen:api:social:check` 通过；`server` 全量 `npm run typecheck`（11 workspace 全绿，含 gateway/admin 未受影响）；`client` `npm run rest:gen` + `npx tsc --noEmit` 全绿；`socialsvc` `npx vitest run`（7 文件 / 89 例，用例数不变——`getPlayerRank` 本来就没有专属测试，删的是从未被测过的死代码）全绿。未做可视化验证——纯契约/死代码清理，不涉及任何渲染路径。

---

## 62. §60 ErrorResp 追踪的状态码补测试（2026-08-03，用户要求"全部改动加测试"）

**背景**：§60 给 35 个 operation 标的状态码是靠**读代码逐条追踪**出来的，不是跑出来的——用户要求给本次会话的改动统一补测试，借这个机会把追踪结果和真实运行结果对一遍账。

**盘点**：对照现有 `server/socialsvc/test/*.test.ts`（`family.e2e`/`friend.e2e`/`mail.e2e` 是 service 层直调，`familyHttp`/`mailHttp`/`chatRegionHttp` 是真实 `startHttpApi` + 真实 Mongo 的 wire-level 测试），逐个 operation 核对后发现 **15 条错误路径此前在任何层级都没有测试覆盖**：`searchFamilyByTag` 400、`respondFamilyJoinRequest` 404、`leaveFamily` 400/403、`kickFamilyMember` 400/403/404、`setFamilyMemberRole` 400/403/404、`disbandFamily` 403、`setFamilyAnnouncement` 400/403、`getFamilyChannel` 403、`searchFriend` 400/404、`blockFriend` 400/404、`reportFriend` 400/404（§60 新加进契约的那个端点，此前压根没测过）、`getChatMessages` 404、`sendChatMessage` 429、`markConversationRead` 400、`readMail` 404。其余 20 个 operation 的错误码已经被 `family.e2e`/`friend.e2e`/`mail.e2e`/`familyHttp.e2e` 等既有测试直接或间接覆盖，不重复补。

**实现**：新增 `server/socialsvc/test/socialErrorsHttp.e2e.test.ts`（照抄 `familyHttp.e2e.test.ts` 的 real-server-real-Mongo 写法），31 个用例逐一对上面 15 条路径发真实 HTTP 请求，断言 wire-level 状态码 + `error.code`。其中 `sendChatMessage` 429 那条实测验证了 `allowChat()` 的滑动窗口限速——`CHAT_SEND_RATE_PER_MIN=30` 用的是真实 `Date.now()`，不是可注入的假时钟，所以测试直接连发 31 条消息（都落在同一个 60s 窗口内）而不需要伪造时间。`reportFriend` 补了三种场景（缺参/目标不存在/举报自己）+ 一次成功举报并断言 Mongo 里落地的 `reports` 文档字段。

**结果**：31 个新用例**首次运行全部一次通过**——说明 §60 逐行追踪 `httpApi.ts`/`familyService.ts`/`friendService.ts`/`mailService.ts` 得出的状态码全部准确，没有因为静态追踪漏看分支而记错。`getPlayerRank`（§61 已删）没有补回归测试——它从来没工作过，删除不存在"防止行为倒退"的需求，跳过。

**验证**：`socialsvc` `npx tsc --noEmit` 全绿；`npx vitest run`（8 文件 / 120 例，89 旧 + 31 新）全绿。未做可视化验证——纯 server 测试改动。

## 63. §56 Shop 面板图标细节不足——`troop_speedup` 拆出专属沙漏图标 + `armor` 补铆钉细节（2026-08-04，用户看截图提出）

**背景**：用户看 §56 做的 Shop 面板截图反馈"所有物品看起来一样，但是功能上却差别很大"。复核 `SHOP_KIND_ICON`（[`worldmap/WorldMapPanels/shop.ts`](../../client/src/scenes/worldmap/WorldMapPanels/shop.ts)）四个图标：`coinChest`/`trophy` 本身笔画较多（箱体+锁扣+溢出金币；奖杯+双耳+底座），但 `troop_speedup→spd`（仅两道 `>>` 折线）和 `protection→armor`（素框+一道中线）明显单薄，且 `spd` 是复用 `EquipmentScene` 的「移速」词条图标——训练加速与移动速度本是两个不相干的概念，共用箭头符号纯属望文生义的巧合。

**实现**：
- `render/icons/slg.ts` 新增 `drawHourglass` + `IconKind.hourglass`：沙漏木框（顶/底横杠）+ 顶部/底部沙堆填充 + 颈部两粒下落沙砾 + 右侧三道渐隐"加速刻度"短线，专门表达"时间被压缩"，不再借用移速箭头。`worldmap/WorldMapPanels/shop.ts` 的 `troop_speedup` 改指向 `'hourglass'`；`EquipmentScene` 的移速词条继续用原 `'spd'`，两者不再共用一套语义。
- `render/icons/equipment.ts` 的 `drawArmor` 补细节：肩部十字横带 + 左上内嵌棱线（emboss）+ 两颗顶角铆钉圆点，外轮廓/尺寸不变——`armor` 复用面很广（装备槛位 tab、驻防行军图标、City HQ 建筑图标等），只加细节不改剪影，全部复用点视觉一致收益、零语义风险。

**追加（同日）**：用户接着问同一 `kind` 内的分档（`troop_speedup` 1h/8h/24h、`protection` 8h/24h）图标怎么区分——三档沙漏 / 两档盾牌本来就共用同一张 `buildIcon` 输出，图标层面完全一样，靠卡片里的名称文字分档。用户明确偏好"直接看图"而非读数字文案，因此没有走金币档位那套"图案随档位递增复杂度"的老路（沙漏/盾牌的细节量递增不如金币数量递增直观，且卡片图标框只有 ~74px，细微差异难辨认），改为在 `renderShopItemCard`（`worldmap/WorldMapPanels/shop.ts`）新增 `shopBadgeLabel()`：仅对有 `duration_sec` 的两个 kind（`troop_speedup`/`protection`）在图标框右上角贴一个 `1H`/`8H`/`24H` 角标（`txtOutlined`，白描边保证压在图标线稿上依然可读，风格照抄 `EquipmentScene/inventory.ts` 现有的库存数量角标惯例）；`resource_pack`（按数量分档，无 `duration_sec`）和 `battle_pass`（无分档）不加角标，维持原样。

**验证**：`client` `npx tsc --noEmit` 全绿。可视化验证：`app.ts` 临时挂 `globalThis.__NW_DEBUG={app,PIXI,buildIcon}` / `{app,PIXI,WorldMapPanels}`（完成后均已还原，diff 归零），起 `game-verify2`（9290）dev server；第一轮直接 `buildIcon()` 四个图标渲染到 160px 网格核对细节；第二轮用 `new WorldMapPanels(fakeCtx).renderShopPanel()`（fakeCtx 只填 `renderShopPanel`/`renderShopItemCard` 读到的字段）灌入 1h/8h/24h speedup + 8h/24h shield + resource_pack + battle_pass 的假数据，渲染整个 Shop 面板——沙漏（时间+加速刻度）、宝箱（资源）、铆钉盾（防御）、奖杯（通行证）四者剪影与细节量级明显区分开；`1H`/`8H`/`24H` 角标在实际卡片尺寸下清晰可读，不再需要读文字才能分档。均通过本机 collector（`fetch POST` → 落盘 PNG）拿到真实像素核对，而非手抄 dataURL。

**追加2（同日，用户明确要求角标之外也要做图标级区分）**：用户反馈角标不够——即使只看图标本身（不看角标/文字），也不想让同 `kind` 内的档位共用一张完全相同的图。等于是把上一条追加里刚放弃的"金币档位式递增复杂度"路子捡回来，但两者不冲突：角标继续保留，图标本身再叠加一层区分。
- `render/icons/slg.ts` 把 `drawHourglass` 拆成 `hourglassCore(g,s,color,pile,ticks)` + 三个导出档位 `drawHourglassSm`/`Md`/`Lg`（`pile` 0.65/1.0/1.35 控制沙堆填充比例，`ticks` 1/2/3 同时控制颈部下落沙砾数和右侧加速刻度线数）——沙子多少、刻度多少都随档位递增，不再是同一张图。
- `render/icons/equipment.ts` 加 `drawArmorHeavy`：内部先调 `drawArmor` 铺基础层，再叠一道第二横带 + 两颗侧边铆钉，作为 `protection` 24h 档的"更厚重"版本；8h 档继续用原 `armor`（本来就复用最广，不动它的默认视觉）。
- `render/icons.ts` 新增 `IconKind`：`hourglassSm`/`hourglassMd`/`hourglassLg`（取代原来单一的 `hourglass`，该 kind 除本处外无其它引用，直接改名不留兼容层）、`armorHeavy`。
- `worldmap/WorldMapPanels/shop.ts`：`SHOP_KIND_ICON` 精简为只保留无分档的两个 kind（`resource_pack`/`battle_pass`）；新增 `SPEEDUP_ICON_TIERS`/`PROTECTION_ICON_TIERS` 两个档位数组 + `shopIcon(it)`——对 `troop_speedup`/`protection`，按 `duration_sec` 把同 kind 的 `ctx.shopItems` 排序，取 `it` 的名次索引进对应档位数组；其它 kind 走原来的扁平映射。

**验证（追加2）**：`client` `npx tsc --noEmit` 全绿。可视化验证按同一套"临时挂 `__NW_DEBUG` + collector 落盘"流程做了两轮：①整版 Shop 面板截图（假数据同上）确认卡片实际尺寸下也能看出差异；②160px 单独渲染 `hourglassSm/Md/Lg` + `armor`/`armorHeavy` 五张图核对细节——沙漏三档的刻度数（1/2/3）和沙堆大小肉眼可数清楚，`armorHeavy` 的第二道横带清晰可辨，侧边铆钉在小尺寸下偏不明显（贴着盾牌边线，容易和描边混在一起）但不影响整体可读性，双横带已经是足够的区分信号。全程复用 [[client-run-and-visual-verify]] 记录的"图为纯 buildIcon 输出，不牵扯登录/后端"路径；本轮额外遇到共享主目录里另一个会话正在写 `client/src/i18n/locales/zh.ts`（`CAMPAIGN_STORY.md` 相关文案，一度处于语法未完成的中间态导致整个 webpack bundle 编译失败），用 `git stash push --keep-index -- <单个文件>` 把这一个文件临时隔离出来验证、验证完立刻 `git stash pop` 还原，全程没有碰这个文件的实际内容，也没有影响另一会话的工作。

**追加3（同日，用户要求"全部加测试"）**：
- `worldMapShopPanel.ui.ts` 新增两组 `describe`：`shopIcon` 用手写的 `(panels as unknown as {...})` cast（项目里测私有方法的既有惯例，见 `claudedocs/client-testing.md`）直接调私有方法，断言：三档 speedup 不管 catalog 数组顺序如何都按 `duration_sec` 排出正确档位、同 kind items 数超过档位数组长度时最高档 clamp 不越界、单条目 catalog 不会算出越界索引、`resource_pack`/`battle_pass` 完全不受名次影响、未知 kind 兜底 `tag`；`shopBadgeLabel` 覆盖 1H/8H/24H 格式化 + 无分档 kind 返回 `null`。
- `icons.test.ts`（`test:render`，`environment:'node'`，无 canvas）本来就没真的构造过 `PIXI.Graphics`——想加"画图不报错"的烟雾测试时踩了一次坑：`new PIXI.Graphics()` 走到 `FillStyle→Texture.WHITE→createCanvas` 会因为没有 `document` 直接抛错，`test:render` 这层环境撑不住真实构造。改成新增 `test/ui/icons.ui.ts`（`test:ui`，走 `pixiHeadless.ts` 装的 headless ADAPTER，能安全构造真实 PIXI 对象）：对全部 `IconKind` 在 16px/64px 各画一遍断言不抛；再加两条几何断言——`hourglassSm/Md/Lg` 的 `graphicsData.length` 严格递增、`armorHeavy` 严格多于 `armor`——这两条是本次真正要守住的行为（"确实画了更多东西"，不是"角标贴上去看起来不一样"）。`icons.test.ts` 本身只加了 `ALL_KINDS` 里补齐 4 个新 `IconKind`（否则 `Record<IconKind,true>` 编译不过）。
- 全部改动跑通：`npx tsc --noEmit -p tsconfig.test.json` 全绿；`npx vitest run test/render/icons.test.ts --config vitest.render.config.ts`（2 例）+ `npx vitest run test/ui/icons.ui.ts test/ui/worldMapShopPanel.ui.ts --config vitest.ui.config.ts`（26 例）全绿。
- **共享检出事故记录**：为了在隔离 `zh.ts` 语法未完成态时跑测试，对 `zh.ts`/`en.ts`/`de.ts` 三个文件反复 `git stash push --keep-index -- <这三个文件>` 又 `pop`；有一轮 pop 时另一会话已经在 stash 期间（文件被临时还原到 HEAD 的窗口内）往 `de.ts` 写入了一行新改动（`campaign.epilogue` 文案重写），导致 `git stash pop` 因为"working tree 有未暂存改动会被覆盖"直接拒绝执行，没有静默丢内容。处理方式：确认 `git diff` 显示的是 EOL 差异导致原始 `diff`/`git merge-file` 误判整份文件冲突（`core.autocrlf=true`，working tree CRLF vs `git show` 输出 LF），把 `git show HEAD:` 和 `git show stash@{0}:` 取出的两份内容转成 CRLF 后再 `git merge-file` 三方合并，干净合并出"两次改动都保留"的结果（`campaign.epilogue` 新文案 + stash 里的 ch1–ch6 早期改动都在），`zh.ts`/`en.ts`（当时working tree等于HEAD，没有新改动）直接 `git checkout stash@{0} -- <path>` 取回，再 `git stash drop`。全程没有执行任何 `--force`/`git checkout --` 丢弃操作，最终提交只 `git commit -- <本任务自己的文件>`，`zh.ts`/`en.ts`/`de.ts`/`CAMPAIGN_STORY.md`/`world.md` 原样留在 working tree 未提交，交还给另一会话。

## 2026-08-08：玩家基地地台没填满 3×3 菱形——`pack_playerbase_atlas.js` 宽度预算修正

用户截图反馈：自己基地（Lv.1）的地台明显窄于地图上画出的绿色虚线 3×3 边界，两侧留了一截空地，怀疑是"贴图导出时已经是斜45度，又被代码二次处理"导致的。

排查过程（详见 [`player-base-image-prompts.md`](../product/player-base-image-prompts.md) § 2026-08-08）：先用 `Explore` 子任务扫过 `WorldMapRenderer/city.ts`/`isoGrid.ts`/`core.ts` 确认渲染链路**没有**对基地贴图做任何二次旋转/skew——`tileToScreen` 只是错切摆放坐标，不改变贴图角度，怀疑方向本身不成立。转向打包脚本 `pack_playerbase_atlas.js`：`CONTENT_W_FRAC = 0.8` 是 2026-08-02 那批**无地台**旧图（今已替换）遗留的经验值，本意是"留余量"，不是"贴图应有宽度"——正确值应该是 `BASE_FOOTPRINT / BASE_SPRITE_TILES ≈ 0.9375`（跟 `city_atlas` 的"贴满整格、`cityPlotMaskPoints` 裁多出 ~7%"是同一套逻辑，`playerbase` 应该一致却少设了这一步）。用标准渲染公式（`tileToScreen`/`citySpriteTiles`/`cityPlotMaskPoints`）在 Node 里离线复现"地台 sprite + 裁剪菱形"几何，叠加真实图集像素核对，确认 10 级里 Lv.1/2/3/9（外接框比目标更宽的几档）受这个预算收窄；其余等级本来就是高度预算先触底，不受影响。

修复：只改 `CONTENT_W_FRAC`（0.8 → `BASE_FOOTPRINT/BASE_SPRITE_TILES`），`HEIGHT_BUDGET_K`/`CONTENT_H_FRAC` 不动——试算过把两个预算都调宽到能让 Lv.10 满宽，Lv.10 的绘制高度会从 1.8 tile 涨到 2.5+ tile，重新踩回 2026-08-02 那次修的"压住后排格子"的坑，所以刻意只动宽度这一维。

**验证**：重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 更新 `world_atlas.{png,json}`；`client/test/ui/cityAtlasContentTop.ui.ts`（9 例）+ `tsc --noEmit` 全绿。可视化验证走 [[worldmap-standalone-debug-render]] 记录的套路：`entries/web.ts` 临时加 `?worldmap&desk=N` 分支（reject-fast 的 `worldApi` stub + 手填 3×3 `tileCache`/`ctx.me.mainBaseTile`），起 `game` dev server，因为本机 Browser pane 这次又是"未显示无法合成帧"，改用 `client/` 下临时 `.mjs` 直接 Playwright 截图落盘（[[client-run-and-visual-verify]]）：Lv.1 真机截图确认地台边缘正好顶到绿色虚线 3×3 边界；Lv.10 仍能看到两侧留白（预期内，高度预算触底的档位这次没动，跟 2026-08-03 记的已知瑕疵是同一件事，留给后续美术地台加宽的返工）。验证完把临时 `?worldmap` 分支从 `web.ts` 完整 `git checkout` 还原，`.mjs` 截图脚本删除。
**共享检出提醒**：这次会话期间主目录里另一个会话在并发改 `app.ts`/`SceneManager.ts`/`AuctionScene`/`CardScene`/`EquipmentScene`/`WorldMapRenderer/city.ts`/`tileStyle.ts`/`tileGraphics.ts`（HMR 日志能看到 `tileStyle.ts` 的改动通过 `fog.ts→WorldMapRenderer.ts→WorldMapScene.ts` 一路冒泡到 `web.ts`）——最终 `git add` 只精确列了本任务自己改的 3 个文件（`pack_playerbase_atlas.js` + `world_atlas.png/json`）+ 这两份设计文档，没有 `git add -A`，没有碰上述任何一个别人正在改的文件。
