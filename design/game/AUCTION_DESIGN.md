# Notebook Wars — 拍卖行设计（Auction House）

> 状态：主干 ✅ + 反 RMT 闸门 C/E/G + 竞拍 B + **装备交易 A** + **异常审计 D（admin G7 已接，已切到 auctionsvc）** 全 ✅；**双入口（大厅 + SLG 世界地图）已接**；**去 SLG/worldId 耦合 + 独立 auctionsvc 拆分（见 §9，2026-07-06 拍板；任务1-9 全部完成，任务10（2026-07-27）补完 client codegen 最后一步——Caddy/compose/CI 已切流量到 auctionsvc，worldsvc 旧拍卖代码已删，client 拍卖方法已去 `worldId` 依赖，`AuctionView` 类型也已真正切到 `openapi-auction.yml` 自己的契约）** · 权威：本文（拍卖行**机制**单一来源） · 更新：2026-07-27
>
> 配套阅读：[`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)（金币钱包 spend/grant，拍卖结算走它）、[`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md)（货币政策/反通胀哲学）、[`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)（数值演算）、[`SERVER_API.md`](SERVER_API.md)（接口契约）、[`OPS_DESIGN.md`](OPS_DESIGN.md)（反 RMT 审计工单复用）、[`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md)/[`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)（装备/角色卡实例定义）、[`SLG_DESIGN.md`](SLG_DESIGN.md)（仅材料 `scrap/lead/binding` 的产出侧定义共享，拍卖机制本身与 SLG 世界/赛季生命周期无关，见 §9 拍板说明）。
>
> **本文是拍卖行机制权威**：数值不在本文定——常量在 `server/shared/src/slg.ts`（`AUCTION_*`），本文只引用并注 DRAFT。

---

## 0. TL;DR

- **拍卖行 = 和角色卡/装备/材料/皮肤四类养成物品绑定的大区内全服市场**：与 SLG 的 worldId/赛季生命周期无关（2026-07-06 拍板定稿，详见 §9），单一机制覆盖「公开市场」与「点对点定向交易」（挂单时指定受拍人）。
- **可交易品 = 材料 + 装备（A ✅）+ 角色卡（CC-5 ✅）+ 皮肤（meta 托管能力 ✅ 已实现，`itemType='skin'` 拍卖流程已在 auctionsvc 接入，见 §9 任务4）**（PvE/SLG 统一养成材料 `scrap/lead/binding` + 锻造装备实例/角色卡实例/皮肤，整件托管转移）；**SLG 赛季资源（粮/铁/木）本就不在拍卖标的范围内**（那是大世界内政资源，随赛季重置，从未支持挂拍）。
- **计价货币 = 金币（coins，跨季留存的 premium 货币）**；系统抽 **10% 手续费**；**禁止以赛季资源/局内 ink 计价**（防与天梯/付费体系串味）。
- **承重墙**：拍卖行不碰战斗/地图，是纯经济子系统——挂存与发放走 **meta 材料库 + 装备库 + 角色卡库 + 皮肤库**（幂等 orderId），扣款/收款走 **commercial 金币钱包**，状态机权威在独立服务 `auctionsvc`（见 §9）。
- **反 RMT 是持续对抗**（R3）：10% 高税 + 并发挂单上限 + 每日限额（C ✅）+ 绑定材料禁挂（E ✅，清单暂空）+ 价格护栏动态滑窗（G ✅）+ 异常模式 admin 审计（D ✅ admin G7 已接，pull 式扫描）。
- **当前状态**（2026-07-06 复核）：**A/B/C/D/E/G 六轨道全实跑** + 一口价主干（`auctionsvc` `auctionService.ts` + e2e；装备库存后端 meta `equipment.ts`；异常审计 admin `service.ts`）；**客户端双入口已接**（大厅右侧功能条 + SLG 世界地图工具栏，均通向 `AuctionScene`，见 §6）；**F（原"季末冻结/结算"）已废弃**，拍卖单只按自身 72h 到期正常流转，不受任何赛季事件影响；**去耦合拆分（§9）任务1-7 全部完成**：独立服务 `auctionsvc` 已上线并接管全部流量，worldsvc 侧旧拍卖代码已删，client 拍卖方法已去 `worldId` 依赖、大厅入口不再经过 `resolveWorldShard`。

---

## 1. 定位与边界

> **2026-07-06 拍板定位**：拍卖行不是「SLG 大世界的交易子系统」，而是和角色卡/装备/材料/皮肤四类**养成物品**绑定的**全服（大区内）市场**，性质上和 matchsvc 一样是全服行为，与 SLG 的 worldId/赛季生命周期无关。此前文档里"按 worldId 隔离""随赛季结算清算"等表述均属误定位，已随本次改写作废（详见 §9 拆分任务清单）。

| 维度 | 决策 | 来源 |
|---|---|---|
| 唯一交易机制 | 全游戏交易只走拍卖行；无独立「邮寄/转账/摆摊」系统 | 拍板 |
| 点对点交易 | = 挂单时填 `designatedBuyerId`，仅该账号可拍下；市场浏览层同步隐藏——`listAuctions` 只对卖家本人和被指定买家可见（其余账号完全看不到该挂单），被指定买家的视图里该挂单置顶并带「专属」标签；无独立转移系统 | 拍板（2026-07-18 补：浏览层隐藏 + 置顶） |
| 可交易品 | 材料（scrap/lead/binding）+ 装备 + 角色卡 + 皮肤（拍卖流程已在 auctionsvc 接入，见 §2.1/§9 任务4）；**SLG 赛季资源（粮/铁/木）从不在拍卖标的范围** | §2.1 |
| 计价 | 仅金币 coins（跨季 premium 货币）；禁赛季资源/ink 计价 | ECONOMY_BALANCE |
| 手续费 | 成交价 10%（coin），系统回收（sink） | 拍板 |
| 进程归属 | 拍卖是**独立服务 `auctionsvc`**（meta 层，全服单实例，欧美/中国各自部署一份）；扣发金币→commercial；挂发材料/装备/角色卡/皮肤→meta。**已迁移完成，见 §9 任务3-6** | 2026-07-06 拍板 |
| 大区范围 | 拍卖是**大区内全服市场**：与 worldId/SLG shard 无关，同一大区所有玩家自由流通，不跨大区；中国区是完全独立部署栈，物理隔离不属于本文档讨论范围（架构设计只需覆盖西方大区） | 2026-07-06 拍板 |

**信任边界**：成交全在服务器权威（客户端只读挂单列表 + 发起意图）；价格/库存/扣发全服务器校验，伪造无效（§11 反作弊）。

> **皮肤交易**：metaserver 托管能力（`escrowSkin`/`grantSkin`）已实现（2026-07-06，§9 任务2）；`auctionsvc` 的 `auctionService` 已接入 `itemType='skin'` 分支（§9 任务4，2026-07-06）；worldsvc 旧实现从未接入 skin，且已随 §9 任务6 整体下线。

---

## 2. 交易模型

### 2.1 标的（item）

| itemType | item 载荷 | 挂存（扣） | 发放（给买方 / 退卖方，均经系统邮件） | 状态 |
|---|---|---|---|---|
| `material` | `{material: 'scrap'\|'lead'\|'binding'\|…}` | meta `deductMaterial(seller, mat, qty, orderId)` | 系统邮件附件 `{kind:'material', id, count}` | ✅ 实跑 |
| `equipment` | 挂单入参 `{instanceId}`；存储 `{instance: 完整快照}`（qty 恒 1） | meta `escrowEquipment(seller, instanceId, orderId)`（移出库存回快照） | 系统邮件附件 `{kind:'equipment', instance}`（领取按 id 写回 `equipmentInv`） | ✅ 实跑（A） |
| `card` | 挂单入参 `{instanceId}`；存储 `{instance: 完整快照}`（qty 恒 1） | meta `escrowCard(seller, instanceId, orderId)`（校验 gear 全空后移出 cardInv） | 系统邮件附件 `{kind:'card', instance}`（领取按 id 写回 `cardInv`） | ✅ 实跑（CC-5） |
| `skin` | 挂单入参 `{skinId}`；存储 `{skinId}`（qty 恒 1，皮肤无等级/词条，无需实例快照——挂单契约保持不变，见下方 2026-08-08 更新） | meta `escrowSkin(seller, skinId, orderId)`（校验拥有 + 若装备中则要求还剩 ≥1 份未挂出的实例才放行，`ITEM_IDENTITY_DESIGN.md` 任务1起从"完全禁止"放宽为"只保护最后一份"） | 系统邮件附件 `{kind:'skin', skinId}`（领取按 id `$addToSet` 写回 `inventory.skins`） | meta 托管能力 ✅ 已实现（2026-07-06，§9 任务2）；auctionsvc 拍卖流程 ✅ 已接入（2026-07-06，§9 任务4） |

- **挂单即托管 + escrow-out 邮件出账**：挂单时立刻从卖方库存移出标的（托管在挂单文档里，拍卖期间背包不可见/不可用），避免「挂着卖但库存已被花掉」的超卖。**所有出账——成交发给买家、撤单/过期/季末退回卖家——一律通过系统邮件附件下发，收件人领取后才入库**（装备/卡附件携带完整实例快照）。金币侧（卖方收款、竞拍退款）仍直接走 commercial。设计依据见 EQUIPMENT_DESIGN §13。
- **qty/price**：`price` = 每件单价（金币），`totalPrice = price × qty`；材料按堆叠数量挂，装备 v1 单件挂（qty=1，A 节细化）。

### 2.2 货币与税

- 计价 = `coins`（commercial 钱包，服务器权威，跨季留存）。
- 成交：`tax = floor(totalPrice × AUCTION_TAX_RATE)`，`sellerReceives = totalPrice − tax`；税进系统（coin sink，反通胀）。
- **免费玩家路径**（最低生活保障）：零充值玩家经任务/活动/关卡赚 coin 参与基本交易；可挂自产极品装备/材料换 coin（§7.1）。

### 2.3 成交流程（一口价，已实跑；竞拍见 §4.B）

```
买方 buyAuction（2026-08-24 起：先认领、后扣款）
  ├─ 校验：存在 / status=open / 非自买 / 未过期 / （若定向）== designatedBuyerId
  ├─ 0. 结算账本落意图（auctionOrders，key = auction_buy:{id}:{buyerId}）
  ├─ 1. 原子 findOneAndUpdate {status:open, rev}→sold        防并发重复购买；抢失败→无任何扣款，直接报错
  ├─ 2. commercial.spend(buyer, totalPrice, 账本步骤 key)    扣买方金币（明确不足→回滚 sold→open；超时未知→挂账重试）
  ├─ 3. mail.sendSystemMail(buyer, `…:item`, …)             标的走系统邮件发给买方（领取后入库）
  └─ 4. mail.sendSystemMail(seller, `…:seller`, coins attach) 卖方收款（税后）走系统邮件，领取后 commercial.grant 入账
```

- **2026-07-18 拍板**：卖方收款、竞价被超/拍卖被抢的**所有**退款一律走系统邮件（`kind:'coins'` 附件，领取时 metaserver `claimMail` 才调 `commercial.grant`），`auctionsvc` 不再有任何路径直接 `commercial.grant` 到账——只有真实充值（Paddle webhook）才直接进钱包。`AuctionCommercialClient` 因此只剩 `spend`（扣买方款），`grant` 方法已删除。
- **2026-08-24 拍板：一口价改「先认领、后扣款」**（U13 收口）。原顺序是先扣款再认领，因此存在「已扣款却被抢走 → 发退款邮件」这条补偿路径；而那笔退款的 dispatchKey 派生自**挂单**、不含买家，两个抢失败的买家会去重成一封，第二个人的钱直接消失。倒过来之后这条路径整体不存在：没抢到就没扣过钱。代价是余额不足的买家会让该挂单瞬时不可购买（补偿把 `sold→open` 撤回），可自愈。
  - **竞拍出价刻意保持相反顺序**（先扣款、后写 `topBid`）：`topBid` 是日后结拍付给卖家的依据，绝不能存在「有出价、没托管款」的中间态。退款路径因此在竞拍侧保留，但改由账本驱动重试，不再是一次性 best-effort。
- **幂等键**：全部由 `auctionService/journalPlans.ts` 统一铸造（`flowKey`/`stepKey`），**代码里其它任何地方不许手写 `auction_…` 字面量**，由 `npm run check:auctionjournal` 门禁强制。账本行 id 是「去重身份」（同一 (挂单, 账号[, 金额]) 的重复提交撞在一起），下游 orderId/dispatchKey 再带上账本的 `cycle`——所以「上一次尝试已退款后的真实重试」是一次真实扣款，而不是被 commercial 当成重放白送。
- **失败补偿**：见下 §2.4。「运维凭 orderId 手动补发」已由自动重试取代。

### 2.4 跨集合结算账本（U13 收口，2026-08-24）

一次成交要原子的三件事落在**三个进程、四个库**里：金币在 commercial（`notebook_wars_commercial`，HTTP `/internal/spend`）、挂单状态在 auctionsvc（`notebook_wars_auction`）、标的与卖家收款在 metaserver（`notebook_wars`，系统邮件）。Mongo 事务只覆盖单个 client/session，最多能包住 `auctions`+`auctionDaily`+`auctionPrices`——**钱和货一个都不在里面**。因此不引入事务，改用 commercial 的 `orders` 集合早就在用的形状：**幂等键 + 持久化待办 + 可重驱动**。

- **`auctionOrders` 集合**（auction 库）：一次跨服务流程一行。`steps`（欠着的副作用，仅 `$push`）/`done`（点路径 `$set` 记完成）/`started`（前缀步骤已发起）/`compensation`（走不下去时撤什么，`requires` 指明依赖哪个正向步骤真落地了）/`decided`（请求路径是否越过了分叉点）/`prefix`（分叉前有几个步骤）/`cycle`（重开次数，用于给下游换键）。
- **能跑通的关键前提**：下游本来就都幂等了——commercial 按 `orderId` 去重且绑定首个使用它的账号，系统邮件按 `dispatchKey` 去重，meta 库存端点按 `orderId` 去重。所以账本**不需要实现分布式原子性**，只需要记住「还欠谁什么」并能重跑。
- **失败分两类，处置相反**（整个引擎的核心）：**业务拒绝**（`SlgError`：余额不足 / 装备已装备 / 卡有配装…）是下游真的判过并拒了，证明什么都没动，可以立刻回滚；**传输失败**（超时 / 连接重置 / 502）什么都不证明，请求可能已经完全生效，此时回滚就是凭空造币或复制道具——这类一律按下游自己的幂等键重试到拿到确定答案，再决定要撤什么。
- **两个驱动**（`scheduler.ts` 每 10s，`journalSweep.ts`）：`resumePending` 续跑请求路径半途死掉、或交付被 meta 抖断的行（每行自带 2s 倍增至 5min 的退避，**永不放弃**——欠的是真资产）；`repairUnsettled` 补那个顺序关不掉的缺口——结拍/撤单/过期这三个流程是「先认领、后写账本行」（交付方向单一，且赢家要认领成功才知道），崩在中间没有行可续，但会留下「终态挂单 + 无 `settledAt`」，这本身就是欠账凭证，plan 是文档的纯函数所以能重建。
- **`AuctionDoc.settledAt`**：交付真正完成才写。它的**缺失**就是 `repairUnsettled` 的扫描条件，因此 `purgeClosedListings` 也加了「不删还欠着交付的挂单」——否则会把唯一的欠账凭证删掉。
- **历史数据**：启动期迁移（`db.ts::runMigrations`，服务收流量前跑完）给所有**已终态**挂单补 `settledAt`。旧代码关掉的那些要么已发邮件、要么已静默丢失，数据里分不出来；重驱动它们会按账本的新 dispatchKey 再发一遍附件，把一次不可挽回的旧丢失变成一次新的复制。
- **系统邮件不再吞异常**：`HttpAuctionMailClient` 配置可用时发送失败**抛错**（未配置的 null client 仍静默 no-op）。旧的「记日志后返回」是生产上最可能真丢资产的一条：meta 抖一个 500，卖家的钱或买家的货就没了，只留一行日志，而且没有任何东西会去重试。
- **ops 可见性（同日补齐）**：欠账原先只体现在日志里（`settlement step still owed after many retries`），也就是「没人发现，直到玩家来投诉」。现在两处能看：
  - `AuctionListingAdminView` 增加 `settledAt`，ops 挂单查询多一列「Settled」——**已结束的挂单没有 `settledAt` 就是还欠着交付**（open 挂单本来就没什么可交付，显示 `—`，不算欠账）。
  - 新端点 `GET /internal/audit/settlements` → admin `GET /admin/slg/audit/settlements`（能力沿用 `slg.audit.view`，未新增能力）→ ops「SLG Audit」页新增「Unfinished settlements」区块。每行给出：账本行 id（= 该次结算所有下游键的前缀，直接拿去 commercial/meta 查）、流程与方向（`buy · delivering` / `bid · unwinding`）、**还欠谁什么**（`seller: alice ← 1080 coins`）、已完成到哪一步、重试次数（≥ `AUCTION_SETTLEMENT_STUCK_ATTEMPTS`=10 标 `stuck`）、重开次数、以及「欠了多久 / 下次何时重试」。
  - **刻意只读，没有「立即重试」按钮**：扫描器本来就在按自己的退避永不放弃地重试，手动戳只会和它抢；真正有用的下一步动作（去修那个一直失败的 meta 端点、开补偿工单）都在这个服务之外。
  - `accountId` 过滤同时匹配 `actorId` **和任何被某个步骤欠着的账号**——被超价的出价者不是那笔出价流程的 actor，只按 actorId 过滤会对「玩家说没收到退款」这个问题回答「没有欠账」。

---

## 3. 挂单生命周期与状态机

```
                 createAuction
                      │
                      ▼
   ┌──────────────► open ──────────────┐
   │                 │                  │
   │ buyAuction      │ cancelAuction    │ 过期扫描器
   ▼                 ▼                  ▼
  sold           cancelled           expired
 (买方得标的       (退还卖方标的)       (退还卖方标的)
  卖方得税后款)
```

- **状态**：`AuctionStatus = open | sold | expired | cancelled`（`shared/slg.ts`）。
- **时长**：`AUCTION_DURATIONS_SEC = [72h]`（固定，2026-07-05 起客户端不再提供时长选择）；`expireAt = createAt + durationSec`。
- **过期不走 Mongo TTL**：TTL 自删会在结算前丢掉托管物（U13）→ 故意用**普通索引 `{expireAt:1}` + scheduler 扫描器**（每 2s tick，每批 ≤50 条，原子 `open→expired` + 退还卖方）。`§14.3` 表里「TTL {expireAt}」按此实现期决定改为普通索引。
- **并发**：所有终态转移走 `findOneAndUpdate` 原子认领 + `rev` 自增，防双花/重复结算。**2026-08-24 起 filter 一律带 `rev`**（原先 `settleAuctionWin` 与过期分支只有 `{status:'open'}`）：状态不变的并发写（一笔新出价）不会被 status 过滤挡住，结拍会按**陈旧 `topBid`** 成交——标的发给刚被退款的上一位出价者，新出价者的托管款孤立。带上 `rev` 后这一跳直接失败，扫描器下一 tick 用新快照重算。
- **终态时间戳 `closedAt`**（2026-07-14）：每次 `open→sold/cancelled/expired` 转移都写 `closedAt=now`（`sold` 另留 `soldAt` 供审计向后兼容）。用途见下「我的挂单历史保留」。
- **「我的挂单」历史 + 保留清理**（2026-07-14）：`getMyListings` 返回该卖家**所有状态**的挂单（`open` 按 `expireAt` 倒序在前，其后是保留期内的已结束历史），拉取上限 `MY_LISTINGS_FETCH_LIMIT=100`（大于 open 上限 `AUCTION_MAX_LISTINGS=20`，给历史留位）。客户端「我的挂单」行：`open` 显示「取消」按钮；`sold/cancelled/expired` 改显状态徽标（已售/已取消/已过期·已退回），不显倒计时、无可点区域。已结束挂单超过保留期（`AUCTION_CLOSED_RETENTION_SEC=30d`，≥ `AUDIT_WINDOW_SEC=7d` 以免误删审计窗口内的成交单）由 scheduler 每 1h 一次 `purgeClosedListings` 物理删除（`status≠open` 且 `closedAt`——旧文档回退 `expireAt`——早于 cutoff），防列表无限增长。`open` 挂单永不清理（仍持托管物/活跃竞价）。

---

## 4. A–G 缺口设计决策

> 主干（挂/买/撤/过期/材料/金币/税/定向/并发）已实跑（§6）。以下各项本文给出**建议决策**；标 ⚠️ 的是需你拍板的产品/数值分叉，标 DRAFT 的是上线后调参。**F（原"季末冻结/结算"）已于 2026-07-06 整节废弃**，见 §9 拍板背景——拍卖与 SLG 赛季生命周期无关，不受任何赛季事件影响。

### A. 装备交易 ✅ 已实现（2026-06-21）

> 实现：先建**装备库存后端**（EQUIPMENT_DESIGN E2）解阻塞——meta `equipment.ts`（`craftEquipment` 合成 faucet + `escrowEquipment`/`grantEquipment` 托管转移）+ 内部端点 `/internal/equipment/{escrow,grant}`；worldsvc `auctionService` 接 A 全链路。e2e：meta 12 条 + worldsvc 装备 8 条。

- **挂单入参** `{instanceId}`；服务器 `escrowEquipment` 校验后**移出卖方库存**、回完整实例快照存进挂单 `item.instance`（**qty 强制 1**——装备是非堆叠唯一实例，传 99 也归 1）。
- **托管 = 移出库存；发放/退回 = 经系统邮件**：挂存调 meta `escrowEquipment`（orderId 幂等，账本存快照）；成交给买方、撤单/过期/季末清算退回卖方，**均由 worldsvc `deliverItem` 发系统邮件**（附件携带完整实例快照），收件人领取时 metaserver 按 `instance.id` 写回 `equipmentInv`（覆盖写即幂等）。
- **禁挂闸门**（meta escrow 侧拒绝，错误码透传 worldsvc）：`locked`（防误用为燃料）→ `EQUIP_LOCKED`；**穿戴中**（`gear.global`/`gear.byUnit` 引用）→ `EQUIP_IN_USE`；不存在 → `EQUIP_NOT_FOUND`。绑定装备禁挂（`equipBound`）与 E 同源，待经济运营填规则。
- **价格护栏（G）按 `equip:{defId}:{level}` 品类**（2026-07-19 起按强化等级分桶，此前 `equip:{defId}` 不分等级，导致 +9 装备的护栏价与 +0 装备共用同一中位数/上限，系统定价长期低于强化材料的期望投入——见 `equipEnhanceExpectedCost`）：冷启动参考价 = 稀有度基准价（`EQUIP_AUCTION_REF_PRICE_BY_RARITY`，DRAFT）+ 强化到该等级的**期望材料/金币成本**（`equipEnhanceExpectedCost`，按 `enhanceCost`×`1/enhanceSuccessRate` 期望重试次数折算，材料按 `AUCTION_STATIC_REF_PRICE` 计价）；滑窗样本足后转中位数（每个等级独立滑窗）；越界拒绝（拒绝后退还托管实例，不吞）。
- **满仓口径**：成交/退回**不卡 300 库存上限**——escrow-out 后一律经系统邮件下发，领取时才入库（邮件即持有缓冲，满仓不资损、也不突破硬上限，EQUIPMENT_DESIGN §13 已落地）；上限只在 craft/掉落 faucet 侧卡。
- **遗留**：E3 强化/分解、E4 穿戴、E5 UI、关卡掉落 faucet 仍待做（EQUIPMENT_DESIGN §14）；本切片只交付「能合成 → 能上拍卖交易」闭环。

### B. 竞拍（出价）✅ 拍板：v1 做 · ✅ 已实现（2026-06-21）

> 实现：`saleMode='auction'` 与一口价并存。`placeBid(amount=出价单价)` → commercial 托管 `amount×qty` → rev 守卫原子写 `topBid` → 退还前一出价者 → 防狙击顺延 `expireAt`（`AUCTION_ANTI_SNIPE_WINDOW_SEC`）→ 达/超 `buyoutPrice` 立即结拍。到期扫描器命中竞拍单且有 `topBid` → `settleAuctionWin`（金币已托管，发标的 + 卖方收税后款）；无人出价 → 同 expired 退还卖方。有出价的竞拍单不可撤。`AUCTION_MIN_INCREMENT_RATIO` 控最小加价。

- **现状**：§7.1 写「买方竞拍或一口价」，实现只做了一口价（buy-now）。**拍板（2026-06-21）：v1 接入竞拍，与一口价并存。**
- **设计**（两种售卖形态，挂单时由卖方选）：
  - **一口价单**（已实跑）：`price` 即成交价，先到先得。
  - **竞拍单**：卖方设 `startPrice`（起拍）+ 可选 `buyoutPrice`（一口价保底，可不设）。
- **竞拍数据**：`auctions` 加 `saleMode('fixed'|'auction')`、`startPrice`、`buyoutPrice?`、`topBid?{bidderId, amount, ts}`、`minIncrement`（最小加价幅度，DRAFT）。
- **出价流程**（异步安全，全服务器权威）：
  1. `placeBid(auctionId, amount)`：校验 `amount ≥ max(startPrice, topBid+minIncrement)` → **commercial 托管出价金币**（`escrow`，从买方钱包扣到挂单托管）。
  2. 被更高价超越 → **自动退还前一出价者托管金币**（best-effort + orderId 幂等）。
  3. 设了 `buyoutPrice` 且有人出到/一口价买 → 立即结拍。
  4. **防狙击**：到期前 `ANTI_SNIPE_WINDOW_SEC`（DRAFT）内有新出价 → `expireAt` 顺延同等窗口（封末段秒杀）。
- **结拍**（过期扫描器命中竞拍单且有 `topBid`）：走 §2.3 结算（标的给最高出价者、卖方收税后款、税进系统）；**无人出价** → 同 expired 退还卖方标的。
- **定向受拍 + 竞拍**：定向单仍可设竞拍（仅指定账号可出价），覆盖「定向但走加价」场景。
- **反 RMT 加压**（竞拍是搬砖重灾区，与 §4.D 联动）：自买自抬（seller 关联账号出价抬价）、串拍进异常审计；出价计入每日限额（C）。
- **优先级**：中（主干一口价已闭环；竞拍是体验增强 + §7.1 兑现，可独立切片）。

### C. 每日限额（反搬砖）✅ 已实现（2026-06-21，2026-07-06 起 key 去 worldId）

> 实现：`auctionDaily` 集合按 `${accountId}:${dayKey}`（UTC 日界，全服统一计数，不再按大区/worldId 拆分）计数，`lists`/`buys` 两计数器，`expiresAt`（Date）TTL 自清（`AUCTION_DAILY_TTL_SEC`）。挂单占 `lists`、购买/出价占 `buys`，先占名额（超限回滚 + 抛 `AUCTION_LIMIT_REACHED`）。上限 `AUCTION_DAILY_LIST_CAP=30` / `AUCTION_DAILY_BUY_CAP=30`（DRAFT）。

- **现状**：只有并发上限 `AUCTION_MAX_LISTINGS=20`（同时 open 的挂单数），无「每日挂单/成交次数」上限。
- **建议设计**：
  - 复用 `RETENTION_DESIGN` 的 `dayKey`（服务器日界）模式，按账号计数：
    - `AUCTION_DAILY_LIST_CAP`（每日新挂单数上限，DRAFT）
    - `AUCTION_DAILY_BUY_CAP`（每日购买次数上限，DRAFT）
    - 可选 `AUCTION_DAILY_COIN_FLOW_CAP`（每日成交金币总额上限，压大额搬砖，DRAFT）
  - 计数器存 Redis（`auction:day:{dayKey}:{accountId}` HASH，到日界自然过期）或 Mongo `playerWorld` 镜像；超限抛 `AUCTION_LIMIT_REACHED`（错误码已有）。
- **优先级**：中高（反 RMT 第一道量化闸门，工作量小）。

### D. 反 RMT 异常审计 ✅ 已实现（2026-07-02 复核，admin G7 已接）

- **落地形态**：**pull 式离线扫描**（非实时事件推送）——最终采用「worldsvc 聚合 + admin 拉取 + ops 展示」，比原「成交即埋点」方案更省埋点面、无热路径开销。
  - **worldsvc**：`auctionService.ts` `scanAnomalies(worldId, windowSec)`（只读，不改状态），底层 `detectAuctionAnomalies`（`@nw/shared`）在 `AUDIT_WINDOW_SEC` 窗口内聚合可疑 seller↔buyer 对。
  - **admin**：`clients.ts` `listAuctionAnomalies()` 拉 worldsvc 结果 → `service.ts` `slgScanAnomalies()`（capability `slg.audit.view`）→ `httpApi.ts` 暴露给 ops 后台；worldsvc 不可达时优雅返回空。测试 `server/admin/test/season-audit.e2e.test.ts`。
  - **ops 后台**：审计页展示异常队列，人工复核（对敲/定向异价/大额单向）。
  - **⚠️ 历史 bug（2026-08-04 修复）：换向对敲能绕过聚合，从未真正命中规则**——`detectAuctionAnomalies` 原先按**有向** `${sellerId}→${buyerId}` 分桶聚合成交记录，"同一对 seller↔buyer 短期高频成交"这条规则的实现却隐含假设了双向都该算同一对。两个串通账号只要**交替互换买卖方向**（A 卖给 B、下一单 B 卖给 A、再下一单 A 卖给 B……）就能让每个方向各自的成交次数都低于 `minTrades` 阈值，天然规避检测——这恰恰是"对敲洗钱"最基础的规避手法，而这条规则从一开始就没能真正拦住它。修复：聚合键从有向 `${sellerId}→${buyerId}` 改为**排序后的无向对** `[sellerId,buyerId].sort()` 拼接（`${lo}:${hi}`），双向成交无论谁扮演卖家都落进同一个桶。回归见 `server/shared/test/auction.test.ts`——交替换向的成交序列必须被正确聚合触发 `repeated`/`high_value`，此前（有向分桶）会被错误拆成两个各自不达标的独立桶。
- **命中规则**：同一对 seller↔buyer 短期高频成交（对敲洗钱，无向聚合）；定向挂单 + 远离参考价（RMT 交付通道）；单账号短期大额单向流出/流入。
- **失败补发工单**（§2.3）：扣款成功但发放失败的 `sold` 单凭 orderId 进工单队列（复用 S7 补偿基建）。

### E. 绑定材料禁挂 ✅ 机制已实现（2026-06-21，清单暂空）

> 实现：`createAuction` 校验材料 ∈ `AUCTION_BANNED_MATERIALS`（`shared/slg.ts`，初期空集）→ 抛 `MATERIAL_NOT_TRADEABLE`。机制位就绪，禁挂清单随经济运营填。

- **现状**：所有材料都可挂；SLG9 要「部分绑定材料禁挂」。
- **建议设计**：
  - `shared/slg.ts` 加 `AUCTION_BANNED_MATERIALS: ReadonlySet<string>`（DRAFT，初期可空或放赛季活动专属/账号绑定材料）。
  - `createAuction` 校验：材料 ∈ 禁挂集 → 抛 `BAD_REQUEST`（或新错误码 `MATERIAL_NOT_TRADEABLE`）。
  - 与 A 的「绑定装备禁挂」同源——「绑定」是统一的不可交易标记。
- **优先级**：低（先有机制位，禁挂清单随经济运营填）。

### F. ~~季末冻结 / 结算~~ ❌ 已废弃（2026-07-06，误定位）

> 本节此前把拍卖行当成 SLG 大世界赛季生命周期的附属物（随 `world.status='settling'` 冻结挂单、随 `/admin/world/reset` 强制清算所有 open 挂单）。**2026-07-06 拍板：这是误定位**——拍卖行与 SLG worldId/赛季无关，不应因任何赛季事件被冻结或清算。拍卖单只按自身 72h 到期正常流转（§3 状态机），赛季重置对拍卖行无任何影响。原实现里的 `assertWorldAcceptsListings`/`clearWorldOnReset` 调用随本次拆分作废，不迁移到新服务（见 §9 拍卖任务4）。

### G. 价格护栏 / 反通胀 ✅ 拍板：动态滑窗 · ✅ 已实现（2026-06-21，2026-07-06 起改按大区全局维护）

> 实现：每品类（`material:{mat}`）滑窗存近 `AUCTION_PRICE_WINDOW_N=20` 笔成交单价于 `auctionPrices` 集合（`$push $slice`）；`refPrice` = 样本 ≥ `AUCTION_PRICE_WINDOW_MIN_SAMPLES=5` 时取**中位数**（抗极端值），否则回退 `AUCTION_STATIC_REF_PRICE`（scrap=10/lead=30/binding=80，DRAFT），都无则放行（冷启动不误杀）。挂单/出价单价须落 `[refPrice×0.5, refPrice×2.0]`（`AUCTION_PRICE_FLOOR_RATIO/CEIL_RATIO`），越界抛 `PRICE_OUT_OF_RANGE`。滑窗**按大区全局维护**（同一大区所有玩家共享同一份 `refPrice`，不再按 worldId/shard 拆分；旧实现按 worldId 隔离 + 随 `clearWorldOnReset` 清空的做法随 F 一并作废）。

> **历史 bug（2026-08-04 修复）：竞拍单的 `buyoutPrice`（一口价买断）挂单时从未过护栏**——`createAuction` 只校验了 `unitPrice`/`startPrice` 落在 `[floor,ceil]` 区间，`buyoutPrice` 完全未经 `checkPriceGuard`。但 `placeBid` 对**每一笔出价金额**（含买断价）都无条件跑同一套护栏校验——一旦卖家设的 `buyoutPrice` 超出挂单时刻的护栏上限，这个买断价就永久触发不了（任何人出价到该价位都会撞 `PRICE_OUT_OF_RANGE`），卖家的一口价功能对自己静默失效，直到有人正常竞拍抬价追上（若能追上的话）。修复：`createAuction` 的 material/equipment 两个分支都在校验 `unitPrice` 之后，对非空 `buyoutPrice` 追加同一品类的 `checkPriceGuard` 调用，与挂单价用同一套区间/同一时刻的护栏值。回归见 `server/auctionsvc/test/auction.e2e.test.ts`。

- **现状**：`price > 0` 之外无任何区间限制，可挂任意天价/地板价 → 洗钱（高价定向）/倾销温床。
- **拍板（2026-06-21）：用动态滑窗护栏**（随市场自适应，而非运营手调静态值）。
- **设计**：
  - **每品类（材料种类 / 装备品类）维护近期成交均价**：滑动窗口取近 `PRICE_WINDOW_N` 笔成交（或近 `PRICE_WINDOW_SEC` 时间窗）的成交单价，算参考价 `refPrice`（DRAFT：算术均值或中位数抗极端值）。
  - **挂单/出价校验区间** `[refPrice × PRICE_FLOOR_RATIO, refPrice × PRICE_CEIL_RATIO]`（DRAFT 浮动带，如 ±50%）；越界抛 `PRICE_OUT_OF_RANGE`（新错误码）。
  - **冷启动**：某品类成交样本 < `PRICE_WINDOW_MIN_SAMPLES` 时回退到 ECONOMY_NUMBERS 静态估值区间（无历史不裸奔）。
  - **存储**：每品类滑窗成交价 + `refPrice` 缓存（Redis HASH `auction:price:{category}` 或服务内存 + Mongo 兜底，key 不再带 worldId），每笔 `sold` 更新窗口。
  - **大区全局**：refPrice 按大区维护一份（不按 worldId/shard 拆分），同大区市场共享同一参考价。
- **与定向单**：定向受拍单仍受护栏约束（防「高价定向」洗钱通道，与 §4.D 异常审计互补）。
- **优先级**：中高（反洗钱主力；冷启动回退静态值，可先上静态、滑窗增量接）。

---

## 5. 数据模型 / 契约（引用，权威在代码）

### 5.1 Mongo 集合 `auctions`（auctionsvc 独立库 `notebook_wars_auction` ✅ 已落地，§9 任务4；worldsvc 库 `notebook_wars_world` 的旧集合定义已随 §9 任务6 worldsvc 瘦身删除——遗留的历史数据仍物理存在于 Mongo 里，未做迁移/清空，只是代码不再读写）

```
_id: auctionId(sellerId, ts, seq)   // 进程内 seq 防同毫秒撞键，不再含 worldId 分量
sellerId, itemType, item, qty, price, currency('coins'),
designatedBuyerId?, expireAt(ms), status, buyerId?, rev,
soldAt?, closedAt?, settledAt?          // settledAt = 跨服务交付真正完成（§2.4）
saleMode?, startPrice?, buyoutPrice?, topBid?
```

索引（`auctionsvc/src/db.ts ensureIndexes` ✅ 已去 worldId）：
- `{itemType, status}` — 浏览挂单（原 `{worldId, itemType, status}`）
- `{sellerId}` — 我的挂单
- `{designatedBuyerId}` — 定向收件
- `{expireAt}` — **普通索引（非 TTL，故意）**，过期扫描器用
- `{status, settledAt}` — 结算账本的修复扫描（终态但还没交付完，§2.4）

另一个集合 **`auctionOrders`**（跨集合结算账本，§2.4；字段权威在 `auctionsvc/src/db.ts` 的 `AuctionOrderDoc`）：`{status, nextAttemptAt}` 驱动续跑扫描，`{auctionId}` 反查，`{purgeAt}` TTL（**只在行终结时才写 `purgeAt`**——pending 行是未结的欠账，绝不能被 TTL 清掉）。

第三个集合 **`auctionBids`**（出价参与记录，2026-08-27；字段权威 `AuctionBidDoc`）：`_id = ${auctionId}|${bidderId}`，一个（挂单，出价人）一行、每次出价 upsert，`amount` 存**我自己出过的最高价**（不是挂单当前价）、`total` 存对应托管金额、`bids` 计次。索引 `{bidderId, ts:-1}`（唯一查询形状：我的出价，最新在前）+ `{purgeAt}` TTL。
- **为什么不挂在 `auctions` 上**：挂单文档是每次出价都要 CAS 的热文档（`rev` 守卫），往上加不封顶的 `bidders` 数组等于把出价吞吐押在同一个文档的体积和竞争上；分开存也让历史读完全不碰出价写路径。
- **为什么要有**：`topBid` 只记**当前领跑者**，被反超的瞬间挂单上就再没有那个人的痕迹了。所以「我的竞拍」不可能从市场档数据推出来——旧实现按 `topBid.bidderId===me` 客户端过滤，结果只能显示我正在赢的单子，一被反超就整条消失（这正是玩家最需要看见的时候）。
- **TTL 锚点是挂单的 `expireAt` + `AUCTION_CLOSED_RETENTION_SEC`，不是出价时间**：锚在出价上会让记录比 `purgeClosedListings` 清挂单早最多一整个挂单时长过期，出现「我的拍卖」还看得到这笔交易、「我的竞拍」已经空了的裂缝。

### 5.2 REST 端点（独立服务 `auctionsvc` `/auction/*`，端口 18086，✅ 已落地；Caddy/compose 已切 `/auction*` → `auctionsvc:18086`（§9 任务5）；worldsvc 侧的旧 `auctionService.ts` 及 `/auction/*` 路由已删（§9 任务6））

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/auction/list?itemType&limit` | 浏览 open 挂单（按 price 升序，limit ≤50）；鉴权 accountId 隐式传入 `listAuctions(itemType, limit, accountId)`：过滤掉别人的 `designatedBuyerId` 定向挂单（卖家自己和被指定买家除外），并把当前账号被指定的挂单排到本页最前（2026-07-18） |
| GET | `/auction/mine` | 我的挂单（全状态，≤20） |
| GET | `/auction/myBids` | **我的竞拍**（2026-08-27）：我出过价的全部挂单——正在领跑的、已被反超的、已中拍的、已落败的。返回 `AuctionBidView[]`（挂单快照 + 我自己的 `myBid`/`myTotal`/`myBidCount`/`myBidTs` + `outcome: leading\|outbid\|won\|lost`）。排序：未结束的在前（按 `expireAt` 升序，快结束的先看），然后已结束的按我最后一次出价倒序。出价记录先于挂单被清掉时那一行直接丢弃，不返回残缺占位。 |
| GET | `/auction/refprice?category` | **G 参考价带**：返回该品类（`material:{mat}`/`equip:{defId}:{level}`）的 `{ ref, floor, ceil }`（floor/ceil = ref×0.5/×2.0，与 checkPriceGuard 同界），无护栏/冷启动放行时返回 `null`。挂单界面据此在提交前展示允许区间，避免只在提交后撞 `PRICE_OUT_OF_RANGE`。 |
| POST | `/auction/create` | 挂单（material；equipment 待 A；`saleMode=fixed`→price / `auction`→startPrice+可选 buyoutPrice；可带 designatedBuyerId） |
| POST | `/auction/{id}/buy` | 一口价购买（仅 fixed 单） |
| POST | `/auction/{id}/bid` | 竞拍出价（仅 auction 单，amount=出价单价；达 buyoutPrice 立即结拍） |
| POST | `/auction/{id}/cancel` | 撤单（仅卖方，open；竞拍单有出价不可撤） |

> 鉴权复用 meta JWT（worldsvc 仅验签，§14.1 P1）。SERVER_API.md 契约同步。

### 5.3 shared 常量 / 错误码（`shared/slg.ts`，数值权威）

- 常量（DRAFT，均已落 `shared/slg.ts`）：`AUCTION_TAX_RATE=0.1`、`AUCTION_MAX_LISTINGS=20`、`AUCTION_DURATIONS_SEC=[72h]`（2026-07-05 起固定，客户端不再提供时长选择）；**C** `AUCTION_DAILY_LIST_CAP=30`/`AUCTION_DAILY_BUY_CAP=30`/`AUCTION_DAILY_TTL_SEC`；**E** `AUCTION_BANNED_MATERIALS`（空集）；**B** `AUCTION_MIN_INCREMENT_RATIO=0.05`/`AUCTION_ANTI_SNIPE_WINDOW_SEC=5min`；**G** `AUCTION_PRICE_WINDOW_N=20`/`AUCTION_PRICE_WINDOW_MIN_SAMPLES=5`/`AUCTION_PRICE_FLOOR_RATIO=0.5`/`AUCTION_PRICE_CEIL_RATIO=2.0`/`AUCTION_STATIC_REF_PRICE`。
- 错误码（均已落 `shared/api.ts`）：`AUCTION_NOT_FOUND`、`AUCTION_CLOSED`、`NOT_DESIGNATED_BUYER`、`AUCTION_LIMIT_REACHED`、`NO_PERMISSION`、`INSUFFICIENT_RESOURCES`、`NOT_IMPLEMENTED`、`BAD_REQUEST`、`PRICE_OUT_OF_RANGE`（G）、`MATERIAL_NOT_TRADEABLE`（E）、`BID_TOO_LOW`（B）。`WORLD_CLOSED` 随 F 废弃已不再用于拍卖行（2026-07-06）。
- 新增集合：`auctionDaily`（C，TTL `{expiresAt}`，`_id`/key 为 `${accountId}:${dayKey}`，不带 worldId）、`auctionPrices`（G，`_id=category`，大区全局，不按 worldId 拆分）、`auctionBids`（B，出价参与记录，§5.1）；`auctions` 加 `saleMode/startPrice/buyoutPrice/topBid`（B）。

---

## 6. 实现状态（S8-5）

**✅ 已实跑**（`server/worldsvc/src/auctionService.ts` + `test/auction.e2e.test.ts` 28 条全绿 + 142 条 worldsvc 全绿；装备库存后端 meta `equipment.ts` + `test/equipment.e2e.test.ts` 12 条 + 167 条 metaserver 全绿）：
- 挂单 / 我的挂单 / 一口价购买 / 撤单 / 过期回收全套 CRUD
- 材料交易（meta deduct/grant 托管+发放，orderId 幂等）
- 金币计价 + 10% 税（commercial spend/grant）
- 指定受拍人（定向交易）
- 并发安全（原子状态转移 + rev + 买方失败退款）
- 过期扫描器（scheduler 每 2s，非 TTL，退还卖方挂存 / 竞拍结拍）
- 挂单上限 20、时长固定 72h
- **C 每日限额**（auctionDaily TTL 计数）/ **E 绑定禁挂机制**（空清单）/ **G 价格护栏动态滑窗**（中位数 + 静态回退）/ ~~**F 季末冻结+清算**~~ ❌ 已废弃（2026-07-06，拍卖与赛季无关；`settling 拒挂`/`clearWorldOnReset` 逻辑已删，见 §4.F）/ **B 竞拍**（起拍/加价/托管/防狙击/买断/结拍）
- **A 装备交易**（2026-06-21）：先建装备库存后端（meta `equipment.ts`：`craftEquipment` 合成 + `escrowEquipment`/`grantEquipment` 托管转移 + `/internal/equipment/{escrow,grant}` + 玩家 `POST /equipment/craft`）→ worldsvc `auctionService` 装备分支（挂/买/竞拍结拍/撤/过期/季末退回全转移实例；按 `equip:{defId}:{level}` 稀有度+强化等级价格护栏；穿戴中/locked 禁挂）。新增 `equipmentIdem` 集合（合成/托管幂等）。
- 契约同步：`openapi-world.yml` + 客户端 `openapi-world.ts`/`WorldApiClient`（createAuction saleMode/placeBid）；meta `openapi.yml` 新增 `/equipment/craft`。

**D 异常审计 ✅（2026-07-02 复核）**：admin G7 已接，pull 式离线扫描（worldsvc `scanAnomalies` → admin `listAuctionAnomalies` → ops 审计页），见 §4.D。

**客户端入口 ✅ 双入口（2026-07-02）**：拍卖行属 meta 系统，要求大厅 + SLG 双入口，现已齐备，均通向 `client/src/scenes/AuctionScene.ts`。
- **SLG 世界地图**：`WorldMapScene` 工具栏「拍卖」按钮 → `onOpenAuction` → `createAppCore.goAuctionHouse(worldApi, worldId)`（onBack 回世界地图）。
- **大厅**：`LobbyScene` 右侧功能条新增「拍卖」格（online-only，`onOpenAuction`）→ `createAppCore.goAuctionFromLobby()`。市场为**赛季全局**（无需建基地），故入口先经 `resolveWorldShard` 解析当前赛季 shard（与世界地图入口共用该 helper，3s 超时回退 shard 0），再开 `AuctionScene`（onBack 回大厅）；首次进入复用 `guide.auction.*` 功能引导。

**客户端契约对齐 ✅（2026-06-21）**：`AuctionScene` 既存错配已修——挂单 item 改发 `{material}`（原 `{mat}` 服务端读不到）、展示改读 `item.material`（原把 itemType 当材料名）、时长改 `[6h/12h/24h]` 对齐 `AUCTION_DURATIONS_SEC`（原 `[1h/4h/24h]` 2/3 选项触 BAD_REQUEST），i18n `dur1h/dur4h`→`dur6h/dur12h`。一口价挂单/展示链路打通。

**客户端竞拍 UI ✅（2026-06-21）**：`AuctionScene` 接入竞拍全链路，B 功能端到端打通。
- **挂单表单**：加售卖方式切换（一口价/竞拍）——竞拍模式下 `price` 输入替换为 `startPrice`（起拍）+ 可选 `buyoutPrice`（买断，0=无）；表单改顺序游标布局 + 按模式动态算高度（多一行价格）。`doCreate` 按模式分发 `createAuction({saleMode:'auction', startPrice, buyoutPrice?})`。
  - **价格步进器可直接输入（2026-07-16）**：`addNumInput` 增 `{ editKey, clamp? }`——价格字段（起拍价/一口价）值区变为可点输入框（隐藏 DOM input，复用买家字段的游标模式），支持手输数字；失焦提交时经 `clampToBand` 自动吸附回参考价带（低于 `floor` → `ceil(floor)`，高于 `ceil` → `floor(ceil)`，无价带/冷启动品类原样放行）。表单整体高度 +20%（垂直步进 `VA = SCALE×1.2`，仅纵向行距变宽，元素本身尺寸不变）。
- **市场列表**：竞拍行显示 `[竞拍]` 标记 + 当前出价（`auc.price`，无出价回退起拍价）+ 买断价行；操作按钮一口价=「购买」、竞拍=「出价」。
- **出价弹层**：`openBidForm` 显示标的/当前价/买断价 + 数字步进器（默认最低出价：有出价则 `max(price+1, ceil(price×1.05))`，服务端权威校验加价）→ `confirmBid` 二次确认 → `placeBid`。
- **错误码映射**：`errorMsg` 补 `BID_TOO_LOW`/`PRICE_OUT_OF_RANGE`/`MATERIAL_NOT_TRADEABLE`/`WORLD_CLOSED`/`EQUIP_LOCKED`/`EQUIP_IN_USE`/`AUCTION_NOT_FOUND`/`NO_PERMISSION`/`INSUFFICIENT_RESOURCES`。i18n 三语补 ~20 键。
- **遗留**：装备挂单 UI（item type 选择装备实例）仍待 E5；竞拍单有出价时撤单按钮仍显示，点击由服务端拒绝（toast 提示）。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**客户端装备 / 角色卡挂单 UI ✅（E5 + CC-5，2026-07-02）**：`AuctionScene` 挂单表单支持三类标的（材料 / 装备实例 / 角色卡），装备/角色卡挂单闭环打通（后端 `escrowEquipment`/`escrowCard` 早已就绪，本切片只补客户端 UI + `createAuction` 加 `'card'` itemType）。
- **类别选择器**：创建表单顶部加 `material/equipment/card` 三选一（`ITEM_CLASSES`）；装备/角色卡两类需 `getSave` 回调读库存（未注入时——如 UI 测试——仅提供材料档，两格灰显）。
- **实例选择器**：装备/角色卡档不显示材料按钮与数量（唯一实例，qty 服务端强制 1），改显「已选实例」字段；点击进入**场景级 picker 覆盖层**（`pickerKind`，复用列表拖拽滚动），选中回创建表单。可挂过滤镜像服务端 escrow 守卫——装备排除已锁定 + 已被任意角色卡穿戴；角色卡要求 gear 全空（锁定卡仍可挂，picker 标 🔒）。
- **挂单流转**：`doCreate` 按类别分发 `createAuction(itemType, {instanceId})`；装备/角色卡成交后 escrow 已从 meta save 移除该实例，故 `reloadSave()`（`saveManager.refresh()`）重拉权威 save 使 picker 不再列出该件。
- **市场/我的/出价展示**：`auctionLabel(auc)` 按 `itemType` 读 `item.instance` 快照渲染名（材料沿用 `×qty`；装备/角色卡等级展示方式历经 2026-08-08 两轮修复，见下方对应条目，现均为裸名字 + 独立金色星星行/文字星星）；市场筛选条加 `card` 档。
- **错误码映射**：补 `CARD_HAS_GEAR`（角色卡仍有装备）/`CARD_NOT_FOUND`/`EQUIP_NOT_FOUND`。i18n 三语补 `itemClass`/`class*`/`filterCard`/`pick*`/`tapChoose`/`no{Equip,Cards}`/`err.cardHasGear`。

**挂单表单简化 + 统一选品器（2026-07-05）**：按用户反馈重做挂单表单——
- **界面放大**：弹层宽度 320→360、行距 40→46，各字段字号/控件相应放大。
- **类别选择器 + 材料按钮合并为统一「物品」字段**：原顶部 `material/equipment/card` 三选一 + 材料/实例两套子选择器，合并成一个「物品」输入框，点击弹出**统一选品器**（`renderItemPicker`，替换原 `pickerKind:'equipment'|'card'` 的双态覆盖层），一次性列出三类可挂物品（材料固定三档 + 可挂装备 + 可挂角色卡），按**估值降序**排列。装备/角色卡估值用客户端本地镜像的稀有度/等级档位（因客户端 `@nw/shared` 路径映射仅到 `slg/index.ts`，够不到 `equipment.ts` 的 `EQUIP_AUCTION_REF_PRICE_BY_RARITY`，改在 `picker.ts` 内维护一份同数值的本地表，纯排序用，不作为实际参考价）；材料估值仍读 `AUCTION_STATIC_REF_PRICE`。同时去重了旧代码里材料分支下的重复 Qty 步进器（原表单材料档会渲染两次「数量」控件）。
- **移除时长选择**：`AUCTION_DURATIONS_SEC` 收窄为 `[72h]`（`shared/slg/auction.ts`），客户端不再渲染时长按钮行，`createAuction` 固定传 72h（`AUCTION_DURATION_SEC` 常量，`AuctionScene/base.ts`）。
- i18n 三语删 `itemClass`/`class*`/`duration`/`dur6h/12h/24h`/`pickEquip`/`pickCard`/`noEquip`/`noCards`，新增 `pickItem`/`noItems`。
- **入口接线**：`createAppCore.goAuctionFromLobby` + `goAuctionHouse` 两处 `showAuction` 均注入 `getSave`/`reloadSave`。验证：client `tsc --noEmit`（含 tsconfig.test）+ webpack 生产构建全绿。

**客户端布局重排 + 我的竞拍 ✅（2026-07-05）**：`AuctionScene` 顶部横条 [市场|我的拍卖] 原满宽跨过页边线红线（notebook 装饰线），改走 `HubTabs.drawSidebarTabs` 竖排进 `marginLineX` 页边线内的左侧栏（复用 StatsScene/EquipmentScene 既定模式），列表/筛选条/发布按钮起始 x 让到页边线外侧；顺带把行高（56→76）、图标（22→30）、字号（12/13→15/17）整体放大，信息更易读。
- **新增「我的竞拍」第三档**：无独立后端端点——client 侧从已拉取的 `/auction/list`（市场档数据）按 `saleMode==='auction' && topBid.bidderId===myAccountId` 过滤，展示当前正在领跑的竞拍（该档只读，无操作按钮，仅「领先中」徽标；成交/流拍后随之从开放列表消失，无历史留存）。
- **`myAccountId` 接入**：`AuctionSceneCallbacks` 新增可选 `myAccountId`；`goAuctionFromLobby`/`goAuctionHouse` 均从 `platform.storage.getItem('nw_account_id')` 注入（复用 FamilyHub/SectHub 既有取法）。
- ~~**遗留**：「我的竞拍」无落地/流拍历史（仅展示仍开放且我在领跑的单子）；如需完整出价历史需后端补 `/auction/myBids` 端点。~~ ✅ 已补齐（2026-08-27，见本文末条）。i18n 三语补 `tabBids`/`bidsEmpty`/`leading`。验证：client `tsc --noEmit`（含 tsconfig.test）+ webpack 生产构建全绿。

**统一选品器改图标卡网格（2026-07-06）**：`renderItemPicker`（`picker.ts`）按用户反馈从满宽行列表改为响应式图标卡网格——列数按 `CARD_W_TARGET=130` 目标宽自适应（`EquipmentScene/inventory.ts` 既定的 gridMetrics 模式），每卡 `CARD_H=104`：图标居中顶部、名称居中于下（超宽自动缩放）、锁徽标右上角、整卡可点。移除不再使用的 `ROW_H` 导入。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**挂单表单整体放大 1.5x（2026-07-06）**：按用户反馈，`createForm.ts` 里挂单弹窗（物品字段、售卖方式切换、数量/价格步进器、指定买家字段、税后提示、确认/取消按钮）新增 `SCALE=1.5` 常量，全部尺寸/字号/间距统一乘系数（原 320→360 那次放大是弹层整体尺寸，这次是弹层内部所有控件）。共享的数量步进器组件 `addNumInput`（`base.ts`）新增可选 `scale` 形参（默认 1），拍卖单出价弹窗（`bid.ts`）复用同一组件但不传 scale，故不受影响、维持原尺寸。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**挂单参考价前置展示 + 标题栏统一（2026-07-08）**：按用户反馈修两处——
- **参考价带前置**：原先卖家只有在提交后撞 `PRICE_OUT_OF_RANGE` 才知道价格越界，看不到允许区间。新增后端只读端点 `GET /auction/refprice?category`（`auctionService.getRefBand` 复用 `refPrice`，返回 `{ ref, floor, ceil }`，floor/ceil=ref×0.5/×2.0 与 `checkPriceGuard` 同界；无护栏/冷启动放行→`null`）。客户端 `createForm.ts` 在价格输入下方展示一行参考价：加载中→`auction.refLoading`；有护栏→`auction.refRange`（当前价越界时整行转红，与服务端判定同式 `price<floor||price>ceil`）；角色卡/冷启动无护栏→`auction.refUnrestricted`。品类由 `base.currentListingCategory()` 按当前选品映射（镜像服务端 `categoryOf`：材料→`material:{mat}`、装备→`equip:{defId}`、角色卡→null），`ensureRefBand` 每次选品仅拉一次（按 category 去重缓存）。`WorldApiClient.getAuctionRefBand`；i18n 三语补 `refRange`/`refLoading`/`refUnrestricted`。
- **标题栏统一**：拍卖行标题栏原用 `headerH: HUD_H(50) + titleSize:18`，比多数二级界面（`sceneHeaderHeight`=设计高 12%）矮一截、显得局促。改为不再覆写 `headerH`/`titleSize`，走 `drawSceneHeader` 标准高度与标题字号（仅保留 SLG 红 accent），与 Shop/Gacha/成就/排行榜等一致。`HUD_H` 常量降为默认占位，实际布局锚点改用实例字段 `this.headerH = sceneHeaderHeight(this.h)`（构造时取，`build()` 用返回值回填），`list.ts`/`picker.ts` 内所有 `HUD_H` 引用改 `this.headerH`。验证：client `tsc --noEmit` + webpack 生产构建全绿；auctionsvc e2e 41 例全绿（含 2 例新增 `getRefBand`）。

**市场列表改卡片网格 + 发布按钮 2x（2026-07-15）**：按用户反馈修两处——
- **市场/我的拍卖/我的竞拍列表改卡片式**：`list.ts` 的 `renderList` 从单列文字行（`ROW_H=76`）改成响应式卡片网格（`AUC_CELL_GAP=14`/`AUC_CELL_H=190`/`AUC_CELL_W_TARGET=340`，`base.ts`；列数按目标宽自适应，同 `CardScene`/`EquipmentScene` 既定的 gridMetrics 模式），新拆出 `renderAuctionCell` 渲染单张卡：左侧方形图标框（品类图标居中，右上角售卖方式徽标 tag/gavel）、右侧信息列（品名/价格/买断价/倒计时），卡片右下角固定操作按钮或状态徽标（原三档 all/mine/bids 的按钮·徽标逻辑原样迁入，未改变行为）。`ROW_H` 常量随之移除（仅 `list.ts` 引用，已确认无其他调用点）。
- **「+ 发布」按钮放大 2x**：`renderCreateButton` 尺寸 200×44→400×88，字号 16→32；`renderList` 预留高度相应从 52 调到 100。
- 验证：client `tsc --noEmit` 全绿。本机浏览器预览环境当次未能启动（应用停在启动画面，`document.title`/`globalThis` 探针均未执行，与本次改动无关的既有环境问题，未继续深挖），未能截图肉眼核对；改动仅限渲染层坐标/尺寸计算，逻辑迁移未改变。

**分类栏/卡片 1.5x + 真实物品图 + 顶栏金币（2026-07-15）**：按用户截图反馈修五处——
- **分类栏放大 1.5x**：`FILTER_H`（`base.ts`）44→66；`list.ts` 的 `renderFilterBar` 图标 20→30、字号 14→21；标签宽度超出格子时按比例缩小兜底（不再假设固定字号必然放得下）。
- **卡片高度放大 1.5x**：`AUC_CELL_H`（`base.ts`）190→285；图片框上限收在 180px（不跟着整高线性放大），避免挤爆右侧文字列。
- **物品显示真实图片**：新增 `list.ts` 私有方法 `renderItemPicture`（镜像 `GachaScene.drawEntryPicture` 的做法）——装备按 `defId` 取真实 slot/rarity 走 `drawEquipmentGlyph` 程序化图标，角色卡按 `defId→unitType` 取真实立绘 PNG（`cardArt.ts`），材料维持原有品类图标；此前三类物品在卡片左侧统一显示同一个「品类」占位图标（如所有装备都是同一个盾牌），现在装备/角色卡按具体物品区分。纹理未加载完成时挂 `artHooked` 一次性 `loaded` 回调触发重渲染（同 Gacha 模式）。
- **文字不出框**：价格行、买断价行补上 `wordWrap`（品名行此前已有，价格/买断价此前没有，卡片变高后风险更明显）。
- **顶栏右上角显示金币**：`base.ts` 新增 `headerOverlayLayer`（叠在静态 header chrome 之上）+ `renderHeaderCurrency()`，每次 `render()` 调用，走共享 `drawHeaderCurrency` 组件（与 Shop/Gacha/Equipment 同款），读 `cb.getSave().wallet.coins`；`doBuy` 成交后并行 `reloadSave()`，余额立即反映新扣款。
- 验证：client `tsc --noEmit` 全绿。真机截图当次仍受本机既有 Browser-pane 渲染卡死问题阻塞（见「WorldMap standalone debug render」系列记忆），改走「无登录临时挂 `__NW_DEBUG` 钩子 + 手造 fixture + 直接 `new AuctionScene(...)` 挂载」的技术路线：走完整登录/世界解析链路太慢，用 PIXI 树内省核对——分类栏字号 21、卡片高度按倒计时 y 坐标反算确认 285、价格/买断价 `wordWrap` 宽度落在文字宽之外（无溢出）、顶栏金币文本 `"12,345"` 存在、角色卡出现真实立绘 `Sprite`（`.png` 纹理 URL 命中）而非占位图标，均核对通过。

**倒计时显示天/时/分/秒 + 卡片紧凑化（2026-07-16）**：按用户截图反馈修两处——
- **倒计时格式**：原来只显示剩余分钟数（如 `4321m`），拍卖最长 72h，看不出到底还剩几天。新增 `auction.timeLeft` i18n key（`'{d}天{h}时{m}分{s}秒'`，en/de 对应 `'{d}d {h}h {m}m {s}s'` / `'{d}T {h}Std {m}Min {s}Sek'`），`list.ts` 的 `renderAuctionCell` 从 `auc.expireAt - now` 拆算 d/h/m/s 四段传参渲染，替代原先的纯分钟数。
- **卡片紧凑化**：上一版 1.5x 放大把 `AUC_CELL_H` 拉到 285，但内容（品名/价格/买断价）只占前 100px 左右，价格行与底部固定的倒计时/购买按钮之间留出大片空白，用户反馈"看起来太乱了"。给了两个重排方案（紧凑卡片 / 横向条状列表）由用户选定**紧凑卡片**：`AUC_CELL_H` 285→180，图片框上限 180→130px（让右侧文字列更宽，减少换行）；倒计时不再绝对定位在卡片底部，改成紧跟在价格/买断价文字块下方顺流排布（`ay` 累加），只有操作按钮仍固定卡片右下角——消除了原来倒计时和按钮各自独立锚定造成的中间大片留白。
- 验证：client `tsc --noEmit` 全绿；沿用同款「临时挂 `__NW_DEBUG` 钩子（含 `setLocale`）+ 手造 fixture + 直接 `new AuctionScene(...)` 挂载」路线，独立 dev-server 端口（9099，避开另一并发会话占用的 9090）截图核对：英文/中文两种 locale 下卡片紧凑、倒计时完整显示四段单位、买断价+倒计时+按钮均未溢出或重叠。
- **新增回归测试**（`auctionScene.ui.ts`，`describe('AuctionScene — market cell countdown')`，4 条）：倒计时按 `{d,h,m,s}` 完整格式渲染（非纯分钟数）；已关闭挂单（sold/expired/cancelled）不显示倒计时；倒计时随价格/买断价文字块顺流堆叠而非钉死在卡片底部固定偏移（有买断价行时 y 坐标显著大于无买断价，防止改动回退到旧的"钉底"写法）；倒计时文字块与购买/出价按钮（96×40 hit rect）任何情况下都不发生垂直重叠。均用 `vi.useFakeTimers()`/`setSystemTime` 固定时钟，避免真实时间流逝导致的秒数抖动。

**出价弹层加一口价买断 + 加价步进 + 统一弹窗放大一倍（2026-07-18）**：按用户截图反馈修三处——
- **一口价买断按钮**：`bid.ts` 的 `openBidForm` 新增：有 `buyoutPrice` 时在弹层内加一条整宽按钮「一口价购买 {price}」（`auction.buyoutNow`，i18n 三语补齐）。服务端 `placeBid` 已支持出价达到/超过 `buyoutPrice` 立即结拍（`auctionService.ts` §B），故按钮直接把 `bidAmount` 设为 `buyoutPrice` 并走既有 `confirmBid`→`placeBid` 链路，未新增接口——`buyAuction` 端点对 `saleMode='auction'` 的单子会 `BAD_REQUEST`（只认 `fixed` 单），一口价买断竞拍单必须走 `placeBid`。
- **加价步进按钮 +1/+5/+10**：数字步进器（`addNumInput`，仅有 -1/+1）下方新增一排三个快捷加价按钮，点击在当前出价基础上 `+1`/`+5`/`+10`（仍夹在 `minBidFor` 算出的最低出价之上）。
- **统一弹窗 + 放大一倍**：`bid.ts` 里手写的确认弹窗调用（`confirmBid`→`showConfirmModal`）此前是 `base.ts` 里一份独立手绘实现（尺寸/按钮与其他场景已迁移的共享 `confirmDialog.ts` 不一致），本次把 `AuctionSceneBase.showConfirmModal` 改为直接调用 `drawConfirmDialog`（`FamilyScene`/`SectScene`/`EquipmentScene` 同款，OK/Cancel 文字按钮），消除又一处重复弹窗实现。出价弹层本身（`openBidForm`）保留自绘（内容是表单，非纯确认对话，`drawConfirmDialog` 不适用），尺寸整体翻倍（`mw` 300→600、`mh` 184→276/356，随 buyoutPrice 是否存在浮动）以容纳新增的买断按钮 + 加价步进行；Bid/Cancel 按钮尺寸与统一弹窗的 126×42 对齐（原 80×28），Cancel 从 ✕ 图标改文字，与 `drawConfirmDialog` 视觉统一。
- 验证：client `tsc --noEmit` 全绿；沿用「临时挂 `__NW_APP`/`__NW_AuctionScene` 钩子（已移除）+ 手造 fixture + 直接 `new AuctionScene(...)` 挂载」路线截图核对：买断按钮/加价步进渲染正确，点击 `+10`×3 出价从 600→630（模拟 `handleDown`/`handleUp` 命中对应 hit rect 验证），点击买断按钮出价直跳 2400（=`buyoutPrice`）并弹出统一确认对话框「Place bid of 2400 coins?」。

**「我的收购」改名「我的竞拍」（2026-08-27）**：按用户截图反馈——zh 侧 `auction.tabBids` 原文案「我的收购」易被读成"我买到的东西"，与该档实际内容（我参与出价、当前领跑的竞拍单）不符；改为「我的竞拍」。en/de 侧原本就是 `My Bids`/`Meine Gebote`，无需改动。纯文案改动，无逻辑变更。上面 2026-07-05 条的**遗留**仍成立：被反超后该单会从本档消失（客户端只按 `topBid.bidderId===me` 过滤，`auctionsvc` 的 `db.ts` 只存 `topBid`、无出价历史），要做成"所有我出过价的单子"需后端补出价记录 + `/auction/myBids`。

**出价记录 + `/auction/myBids`：「我的竞拍」终于名副其实（2026-08-27）**：接着上一条——改完名字后这一档的**内容**仍然对不上名字：它只列我正在领跑的单子，被反超就整条消失。根因是 `topBid` 只记当前领跑者，挂单文档上不留任何"谁出过价"的痕迹，客户端再怎么过滤市场档也变不出来。
- **服务端**：新集合 `auctionBids`（§5.1，`AuctionBidDoc`），`placeBid` 在 topBid 写入落地之后 upsert 一行——**只在托管真的发生之后写**，所以 CAS 输掉、escrow 被补偿退回的那种出价不会留下记录（e2e 用 `findOneAndUpdate` 代理插入一次竞态出价来钉这条）。写入用聚合管道而非 `$max`+`$set`：`amount` 和 `total` 必须一起动，否则会出现"金额是高价、托管数是低价"的自相矛盾行。这行是纯历史、背后没有资产，所以写失败只记日志不抛——出价本身已经成功、金币已经托管，为一行历史报错等于谎报失败。
- **读**：`AuctionServiceListing.getMyBids(accountId)`，两次查询（出价行 → 批量 `_id: {$in}` 取挂单）而不是 `$lookup`；`outcome` 由挂单状态推导（open → 我是否领跑；sold → 我是否买家；cancelled/expired → `lost`，虽然带出价的单子按流程走不到这两个终态）。
- **契约/客户端**：`openapi-auction.yml` 加 `AuctionBidView` schema + `GET /auction/myBids`，`npm run rest:gen` 重生成；`WorldApiClient.getMyBids()`；`AuctionSceneCore.myBids`/`myBidIndex` 随 loadData/pollRefresh 一起拉（poll 的变更签名加 `bidSig`——`outcome` 会在结拍时 won→lost 翻转，光看挂单签名看不出来）；`ListPanel.myBids()` 从"过滤 allAuctions"改成"直接用服务端结果"；卡片右下角徽标按 outcome 分四态（`auction.leading`/`outbid`/`bidWon`/`bidLost`，领先/中拍用 accent、被超越/落败用灰），价格下方在**我的出价与当前价不同时**多一行「我的出价: N」（领先时两者相等，重复印一遍看着像渲染 bug）。i18n 三语补 `outbid`/`bidWon`/`bidLost`/`myBid`，`bidsEmpty` 从"暂无在拍的出价"改成"你还没有参与过竞拍"（这一档现在含历史）。
- **验证**：auctionsvc 253 例全绿（新增 `auction-mybids.e2e.test.ts` 12 例 + `auction-fulllink.e2e.test.ts` 走真实 `WorldApiClient` 过 HTTP 断言 leading→lost/won）；client UI `auctionScene.ui.ts` 85 例全绿（「我的竞拍」一组重写为服务端数据驱动）；client `tsc --noEmit`（含 tsconfig.test / fulllink）+ webpack 生产构建全绿。

---

## 7. 反 RMT 总览（持续对抗 R3）

| 闸门 | 机制 | 状态 |
|---|---|---|
| 高税 | 10% 成交手续费（coin sink） | ✅ |
| 并发上限 | 同时 open 挂单 ≤20 | ✅ |
| 每日限额 | 日挂单/购买（含出价）次数上限 | ✅ C |
| 绑定禁挂 | 账号绑定材料/装备不可交易（清单暂空）；装备 locked/穿戴中拒挂 | ✅ E（机制）+ A |
| 价格护栏 | 单价限定动态滑窗参考区间（中位数 + 静态回退），封天价洗钱；装备按 defId/稀有度品类 | ✅ G + A |
| 异常审计 | 对敲/定向异价/大额单向 → ops 审计队列 | ✅ D（admin G7 已接，pull 式扫描） |
| 货币隔离 | 仅 coin 计价，禁赛季资源/ink，防体系串味 | ✅ |
| 服务器权威 | 库存/扣发/状态全服务器，客户端只读 | ✅ |

---

## 8. 开放问题

> **无剩余机制级开放问题（2026-06-21 复核）**：B（竞拍=做）/ G（价格护栏=动态滑窗、中位数+近20笔）均已拍板，见 §4。以下全部降为**实现期调参/时序依赖**，不需产品再拍。

- **DRAFT 数值**：每日限额、竞拍最小加价/防狙击窗口、滑窗护栏（窗口大小/浮动带/最小样本）、绑定材料清单、季末冻结提前量——上线后随经济运营调参（数值落 `shared/slg.ts`，演算去 ECONOMY_NUMBERS）。
- ~~**G 算法**：refPrice 用均值还是中位数、滑窗按笔数还是时间~~——已定：**中位数 + 按笔数（近 20 笔）**。
- ~~**A 时序**：装备交易依赖 EQUIPMENT_DESIGN 库存系统落地节奏。~~——已实现（2026-06-21）：随本切片把装备库存后端 E2（合成 + 托管转移）一并建好。装备的**深度养成**（E3 强化/分解、E4 穿戴、E5 UI、关卡掉落 faucet）仍待做，但不阻塞拍卖交易闭环。
- ~~**D 时序**：异常审计依赖 §15.1 G7「admin SLG 接入」。~~——已实现（2026-07-02）：admin G7 已接，pull 式离线扫描，见 §4.D / §6。

---

---

## 9. 拆分任务清单（去 SLG/worldId 耦合 + 独立服务）

→ 已拆出到 [`AUCTION_DESIGN_SPLIT_TASKS.md`](AUCTION_DESIGN_SPLIT_TASKS.md)（2026-07-06 拍板，逐任务执行记录，已完成）。
本文（§0–§8）是拍卖行的**机制权威**；数值仍在 `server/shared/src/slg.ts` 的 `AUCTION_*`。
