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
买方 buyAuction
  ├─ 校验：存在 / status=open / 非自买 / 未过期 / （若定向）== designatedBuyerId
  ├─ 1. commercial.spend(buyer, totalPrice, buyOrderId)     扣买方金币（不足→抛错不成交）
  ├─ 2. 原子 findOneAndUpdate {status:open}→sold            防并发重复购买；抢失败→退买方款（走邮件，见下）
  ├─ 3. mail.sendSystemMail(buyer, `${orderId}:item`, …)    标的走系统邮件发给买方（领取后入库）
  └─ 4. mail.sendSystemMail(seller, `…:seller`, coins attach) 卖方收款（税后）走系统邮件，领取后 commercial.grant 入账
```

- **2026-07-18 拍板**：卖方收款、竞价被超/拍卖被抢的**所有**退款一律走系统邮件（`kind:'coins'` 附件，领取时 metaserver `claimMail` 才调 `commercial.grant`），`auctionsvc` 不再有任何路径直接 `commercial.grant` 到账——只有真实充值（Paddle webhook）才直接进钱包。`AuctionCommercialClient` 因此只剩 `spend`（扣买方款），`grant` 方法已删除。
- **幂等**：每步 orderId 派生自 `auctionId`（`auction_buy:{id}` / `:item` / `:seller`），重放安全。
- **失败补偿**：买方已扣款但步骤 3/4 失败 → 标的停在 `sold`，运维后台凭 orderId 查并补发（已在代码注释明确；接 OPS 工单见 §4.D）。

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
- **并发**：所有终态转移走 `findOneAndUpdate({status:'open'})` 原子认领 + `rev` 自增，防双花/重复结算。
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
designatedBuyerId?, expireAt(ms), status, buyerId?, rev
```

索引（`auctionsvc/src/db.ts ensureIndexes` ✅ 已去 worldId）：
- `{itemType, status}` — 浏览挂单（原 `{worldId, itemType, status}`）
- `{sellerId}` — 我的挂单
- `{designatedBuyerId}` — 定向收件
- `{expireAt}` — **普通索引（非 TTL，故意）**，过期扫描器用

### 5.2 REST 端点（独立服务 `auctionsvc` `/auction/*`，端口 18086，✅ 已落地；Caddy/compose 已切 `/auction*` → `auctionsvc:18086`（§9 任务5）；worldsvc 侧的旧 `auctionService.ts` 及 `/auction/*` 路由已删（§9 任务6））

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/auction/list?itemType&limit` | 浏览 open 挂单（按 price 升序，limit ≤50）；鉴权 accountId 隐式传入 `listAuctions(itemType, limit, accountId)`：过滤掉别人的 `designatedBuyerId` 定向挂单（卖家自己和被指定买家除外），并把当前账号被指定的挂单排到本页最前（2026-07-18） |
| GET | `/auction/mine` | 我的挂单（全状态，≤20） |
| GET | `/auction/refprice?category` | **G 参考价带**：返回该品类（`material:{mat}`/`equip:{defId}:{level}`）的 `{ ref, floor, ceil }`（floor/ceil = ref×0.5/×2.0，与 checkPriceGuard 同界），无护栏/冷启动放行时返回 `null`。挂单界面据此在提交前展示允许区间，避免只在提交后撞 `PRICE_OUT_OF_RANGE`。 |
| POST | `/auction/create` | 挂单（material；equipment 待 A；`saleMode=fixed`→price / `auction`→startPrice+可选 buyoutPrice；可带 designatedBuyerId） |
| POST | `/auction/{id}/buy` | 一口价购买（仅 fixed 单） |
| POST | `/auction/{id}/bid` | 竞拍出价（仅 auction 单，amount=出价单价；达 buyoutPrice 立即结拍） |
| POST | `/auction/{id}/cancel` | 撤单（仅卖方，open；竞拍单有出价不可撤） |

> 鉴权复用 meta JWT（worldsvc 仅验签，§14.1 P1）。SERVER_API.md 契约同步。

### 5.3 shared 常量 / 错误码（`shared/slg.ts`，数值权威）

- 常量（DRAFT，均已落 `shared/slg.ts`）：`AUCTION_TAX_RATE=0.1`、`AUCTION_MAX_LISTINGS=20`、`AUCTION_DURATIONS_SEC=[72h]`（2026-07-05 起固定，客户端不再提供时长选择）；**C** `AUCTION_DAILY_LIST_CAP=30`/`AUCTION_DAILY_BUY_CAP=30`/`AUCTION_DAILY_TTL_SEC`；**E** `AUCTION_BANNED_MATERIALS`（空集）；**B** `AUCTION_MIN_INCREMENT_RATIO=0.05`/`AUCTION_ANTI_SNIPE_WINDOW_SEC=5min`；**G** `AUCTION_PRICE_WINDOW_N=20`/`AUCTION_PRICE_WINDOW_MIN_SAMPLES=5`/`AUCTION_PRICE_FLOOR_RATIO=0.5`/`AUCTION_PRICE_CEIL_RATIO=2.0`/`AUCTION_STATIC_REF_PRICE`。
- 错误码（均已落 `shared/api.ts`）：`AUCTION_NOT_FOUND`、`AUCTION_CLOSED`、`NOT_DESIGNATED_BUYER`、`AUCTION_LIMIT_REACHED`、`NO_PERMISSION`、`INSUFFICIENT_RESOURCES`、`NOT_IMPLEMENTED`、`BAD_REQUEST`、`PRICE_OUT_OF_RANGE`（G）、`MATERIAL_NOT_TRADEABLE`（E）、`BID_TOO_LOW`（B）。`WORLD_CLOSED` 随 F 废弃已不再用于拍卖行（2026-07-06）。
- 新增集合：`auctionDaily`（C，TTL `{expiresAt}`，`_id`/key 为 `${accountId}:${dayKey}`，不带 worldId）、`auctionPrices`（G，`_id=category`，大区全局，不按 worldId 拆分）；`auctions` 加 `saleMode/startPrice/buyoutPrice/topBid`（B）。

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

**客户端布局重排 + 我的收购 ✅（2026-07-05）**：`AuctionScene` 顶部横条 [市场|我的拍卖] 原满宽跨过页边线红线（notebook 装饰线），改走 `HubTabs.drawSidebarTabs` 竖排进 `marginLineX` 页边线内的左侧栏（复用 StatsScene/EquipmentScene 既定模式），列表/筛选条/发布按钮起始 x 让到页边线外侧；顺带把行高（56→76）、图标（22→30）、字号（12/13→15/17）整体放大，信息更易读。
- **新增「我的收购」第三档**：无独立后端端点——client 侧从已拉取的 `/auction/list`（市场档数据）按 `saleMode==='auction' && topBid.bidderId===myAccountId` 过滤，展示当前正在领跑的竞拍（该档只读，无操作按钮，仅「领先中」徽标；成交/流拍后随之从开放列表消失，无历史留存）。
- **`myAccountId` 接入**：`AuctionSceneCallbacks` 新增可选 `myAccountId`；`goAuctionFromLobby`/`goAuctionHouse` 均从 `platform.storage.getItem('nw_account_id')` 注入（复用 FamilyHub/SectHub 既有取法）。
- **遗留**：「我的收购」无落地/流拍历史（仅展示仍开放且我在领跑的单子）；如需完整出价历史需后端补 `/auction/myBids` 端点。i18n 三语补 `tabBids`/`bidsEmpty`/`leading`。验证：client `tsc --noEmit`（含 tsconfig.test）+ webpack 生产构建全绿。

**统一选品器改图标卡网格（2026-07-06）**：`renderItemPicker`（`picker.ts`）按用户反馈从满宽行列表改为响应式图标卡网格——列数按 `CARD_W_TARGET=130` 目标宽自适应（`EquipmentScene/inventory.ts` 既定的 gridMetrics 模式），每卡 `CARD_H=104`：图标居中顶部、名称居中于下（超宽自动缩放）、锁徽标右上角、整卡可点。移除不再使用的 `ROW_H` 导入。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**挂单表单整体放大 1.5x（2026-07-06）**：按用户反馈，`createForm.ts` 里挂单弹窗（物品字段、售卖方式切换、数量/价格步进器、指定买家字段、税后提示、确认/取消按钮）新增 `SCALE=1.5` 常量，全部尺寸/字号/间距统一乘系数（原 320→360 那次放大是弹层整体尺寸，这次是弹层内部所有控件）。共享的数量步进器组件 `addNumInput`（`base.ts`）新增可选 `scale` 形参（默认 1），拍卖单出价弹窗（`bid.ts`）复用同一组件但不传 scale，故不受影响、维持原尺寸。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**挂单参考价前置展示 + 标题栏统一（2026-07-08）**：按用户反馈修两处——
- **参考价带前置**：原先卖家只有在提交后撞 `PRICE_OUT_OF_RANGE` 才知道价格越界，看不到允许区间。新增后端只读端点 `GET /auction/refprice?category`（`auctionService.getRefBand` 复用 `refPrice`，返回 `{ ref, floor, ceil }`，floor/ceil=ref×0.5/×2.0 与 `checkPriceGuard` 同界；无护栏/冷启动放行→`null`）。客户端 `createForm.ts` 在价格输入下方展示一行参考价：加载中→`auction.refLoading`；有护栏→`auction.refRange`（当前价越界时整行转红，与服务端判定同式 `price<floor||price>ceil`）；角色卡/冷启动无护栏→`auction.refUnrestricted`。品类由 `base.currentListingCategory()` 按当前选品映射（镜像服务端 `categoryOf`：材料→`material:{mat}`、装备→`equip:{defId}`、角色卡→null），`ensureRefBand` 每次选品仅拉一次（按 category 去重缓存）。`WorldApiClient.getAuctionRefBand`；i18n 三语补 `refRange`/`refLoading`/`refUnrestricted`。
- **标题栏统一**：拍卖行标题栏原用 `headerH: HUD_H(50) + titleSize:18`，比多数二级界面（`sceneHeaderHeight`=设计高 12%）矮一截、显得局促。改为不再覆写 `headerH`/`titleSize`，走 `drawSceneHeader` 标准高度与标题字号（仅保留 SLG 红 accent），与 Shop/Gacha/成就/排行榜等一致。`HUD_H` 常量降为默认占位，实际布局锚点改用实例字段 `this.headerH = sceneHeaderHeight(this.h)`（构造时取，`build()` 用返回值回填），`list.ts`/`picker.ts` 内所有 `HUD_H` 引用改 `this.headerH`。验证：client `tsc --noEmit` + webpack 生产构建全绿；auctionsvc e2e 41 例全绿（含 2 例新增 `getRefBand`）。

**市场列表改卡片网格 + 发布按钮 2x（2026-07-15）**：按用户反馈修两处——
- **市场/我的拍卖/我的收购列表改卡片式**：`list.ts` 的 `renderList` 从单列文字行（`ROW_H=76`）改成响应式卡片网格（`AUC_CELL_GAP=14`/`AUC_CELL_H=190`/`AUC_CELL_W_TARGET=340`，`base.ts`；列数按目标宽自适应，同 `CardScene`/`EquipmentScene` 既定的 gridMetrics 模式），新拆出 `renderAuctionCell` 渲染单张卡：左侧方形图标框（品类图标居中，右上角售卖方式徽标 tag/gavel）、右侧信息列（品名/价格/买断价/倒计时），卡片右下角固定操作按钮或状态徽标（原三档 all/mine/bids 的按钮·徽标逻辑原样迁入，未改变行为）。`ROW_H` 常量随之移除（仅 `list.ts` 引用，已确认无其他调用点）。
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

## 9. 拆分任务清单（去 SLG/worldId 耦合 + 独立服务，2026-07-06 拍板）

> **拍板背景**：拍卖行的定位被之前的文档写错了——它不是"SLG 大世界的交易子系统"，而是和角色卡/装备/材料/皮肤四类**养成物品**绑定的**全服（大区内）市场**，和 SLG 的 worldId/赛季生命周期没有关系，性质上和 matchsvc 一样是全服行为。旧文档 §1/§4.F/§4.G 里所有"大区内按 worldId 隔离""赛季结算清算"的表述均为**误定位，本节起全部作废**。
>
> **执行约定**：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成，按编号顺序做（任务2 依赖任务1 的语义定稿，任务4 依赖任务2/3，任务6/7 必须在任务4 上线后才能删旧代码——不能反过来，否则拍卖功能会中断）。新会话直接说「开始拍卖任务N」即可定位到本节对应条目。约定见 [`claudedocs/worktrees.md`](../../claudedocs/worktrees.md)：本清单每个任务在独立 worktree + 独立分支做。

### 拍卖任务1：重写 AUCTION_DESIGN.md 语义（去耦合定稿）✅（2026-07-06）

- [x] **依赖**：无（本次对话的拍板结论落笔）。
- **主要文件**：`design/game/AUCTION_DESIGN.md`（本文件自身）。
- **改动范围**：
  - §1「定位与边界」：删除"跨大区隔离/不跨大区流通"表述为 SLG 属性的暗示，改写为——拍卖是**大区内全服市场**（与 worldId/SLG shard 无关，同大区玩家自由流通）；中国区是完全独立部署栈，物理隔离不属于本文档讨论范围（架构设计只需覆盖西方大区）。
  - §2.1「标的」表：新增 `itemType='skin'`（依赖任务2 的皮肤托管能力落地才能转 ✅，本任务先写设计）。
  - §4.F「季末冻结/结算」：整节删除（`clearWorldOnReset`/`assertWorldAcceptsListings` 逻辑作废，拍卖单只按自己 72h 到期正常流转，不受任何赛季事件影响）。
  - §4.G「价格护栏」：滑窗范围从"按 worldId 独立维护"改为"按大区全局维护"（同一大区所有玩家共享同一份 refPrice，不再按 shard 拆分）。
  - §4.C「每日限额」：key 从 `${worldId}:${accountId}:${dayKey}` 改为 `${accountId}:${dayKey}`。
  - §5「数据模型」：`auctions` 集合定义去掉 `worldId` 字段，索引 `{worldId,itemType,status}` 改为 `{itemType,status}`；`auctionId` 生成函数去掉 worldId 分量。
  - §1「进程归属」：改为"拍卖是独立服务 `auctionsvc`（meta 层，全服单实例，欧美/中国各自部署一份）"，不再挂靠 worldsvc。
  - 新增小节说明"皮肤交易需要的托管能力目前不存在，见任务2"。
- **验收**：文档内部无残留 worldId/大区隔离/赛季结算相关表述；`grep -n worldId design/game/AUCTION_DESIGN.md` 应无命中（除本任务清单本身的历史说明性文字外）。

### 拍卖任务2：metaserver 新增皮肤托管能力 ✅（2026-07-06）

- [x] **依赖**：任务1 定稿（皮肤交易范围以任务1的 §2.1 为准）。
- **主要文件**：新建 `server/metaserver/src/skin.ts`；`server/metaserver/src/internal/economyRoutes.ts`；`server/shared/src/mongo.ts`（复用 `equipmentIdem` 集合，`op` 联合类型加 `'skin_escrow'`）；`server/shared/src/api.ts`（新增错误码）。`SaveData.inventory.skins` 未改动，仍是 `string[]`。
- **实现**：
  - `escrowSkin(cols, now, accountId, skinId, orderId)`：校验 `inventory.skins` 包含该 id 且未装备中（`equipped` 各槽值均不等于该 skinId）→ rev 守卫原子写回去掉该 id 的数组 + `equipmentIdem` 记录 `orderId`（`op:'skin_escrow'`）幂等，重放直接返回首次结果。
  - `grantSkin(cols, now, accountId, skinId)`：已拥有则直接返回（`$addToSet` 等价的天然幂等），否则 rev 守卫原子追加。
  - 新增内部路由 `POST /internal/skins/escrow`、`POST /internal/skins/grant`（`server/metaserver/src/internal/economyRoutes.ts`），鉴权复用 `x-internal-key`，照抄 equipment 两个 handler 的写法。
  - 错误码：`SKIN_IN_USE`（409，装备中禁挂）、`SKIN_NOT_FOUND`（404，未拥有）。
- **未做的**：幂等表复用已有 `equipmentIdem` 集合（未新建 `skinIdem`），因为其结构（`_id/accountId/op/result/expireAt` + TTL）与皮肤场景完全一致，新建纯属重复；不影响 §9 任务4 迁移（迁移时随其余 idem 表一起搬到 auctionsvc 库）。
- **验收**：`server/metaserver/test/skin.e2e.test.ts` 新增 6 条用例（挂存移除/发放写回/两者幂等/未拥有 404/装备中 409）；`npm test --workspace @nw/metaserver` 全绿（41 files / 513 tests）。

### 拍卖任务3：新建 `server/auctionsvc/` 服务骨架 ✅（2026-07-06）

- [x] **依赖**：无（可与任务2 并行）。
- **主要文件**：`server/auctionsvc/package.json`（`@nw/auctionsvc`）、`src/config.ts`（`NW_AUCTION_PORT`，默认 **18086**）、`src/index.ts`、`src/db.ts`（独立 Mongo 库 `notebook_wars_auction`，不挂 `notebook_wars_world`）、`src/httpApi.ts`（仅 `/health`）。
- **改动范围**：照抄 `server/analyticsvc` 的轻量骨架结构（config/db/httpApi 三层分离，无 Redis/gateway 依赖，比 worldsvc 骨架更贴合"无业务逻辑的空壳"这一诉求），只搭空壳 + health check，不含业务逻辑（业务逻辑在任务4）。`server/package.json` workspaces 新增 `auctionsvc`（+ `dev:auction` 脚本）。
- **验收**：`npm run build` / `tsc --noEmit` 过；`server/auctionsvc/test/skeleton.e2e.test.ts`（mongodb-memory-server 起独立 mongod，验证 db 连接 + `/health` 200，模式照抄 analyticsvc 的 e2e harness）全绿。

### 拍卖任务4：迁移拍卖业务逻辑到 auctionsvc ✅（2026-07-06）

- [x] **依赖**：任务2（皮肤托管）+ 任务3（服务骨架）。
- **主要文件**：新建 `server/auctionsvc/src/auctionService.ts`（从 `server/worldsvc/src/auctionService.ts` 整体迁移改造）、`src/metaClient.ts`/`src/commercialClient.ts`/`src/mailClient.ts`/`src/scheduler.ts`（同样迁移，接口改名 `Auction*Client`）、`src/httpApi.ts`（`/auction/*` 路由 + `/internal/audit/anomalies`）、`src/db.ts`（`AuctionDoc`/`AuctionDailyDoc`/`AuctionPriceDoc` 三集合落地，此前任务3只搭空壳）、`src/config.ts`（补 `metaInternalUrl`/`commercialInternalUrl`）、`src/index.ts`（接线）。`server/shared/src/internalAuth.ts` 的 `InternalCaller` 联合类型新增 `'auctionsvc'`。新建 `server/contracts/openapi-auction.yml` + `contracts/scripts/gen-openapi-auction.mjs`（照抄 `gen-openapi-world.mjs`，自包含 spec，不跨文件 `$ref`）+ `auctionsvc/package.json` 的 `gen:api:auction[:check]` 脚本。测试：新建 `server/auctionsvc/test/auction.e2e.test.ts`（30 例，含新增 skin 用例）+ `test/auction-audit.e2e.test.ts`（6 例，D/G7 审计迁移）；`test/skeleton.e2e.test.ts` 同步改造以适配新 `startHttpApi` 签名。
- **改动范围**：
  - 所有方法签名去掉 `worldId` 参数；`auctionId` 格式从 `a:{worldId}:{sellerId}:{ts}:{seq}` 改为 `a:{sellerId}:{ts}:{seq}`（auctionsvc 本地生成，不复用 `@nw/shared` 的 `auctionId()`——那个签名仍带 worldId，专供 worldsvc 旧实现用，任务6 随旧代码一并删除）；`auctionDaily` 的 `_id` 从 `${worldId}:${accountId}:${dayKey}` 改为 `${accountId}:${dayKey}`；`auctionPrices` 的 `_id` 从 `${worldId}:${category}` 改为 `${category}`。
  - **未迁移**：`assertWorldAcceptsListings`/`clearWorldOnReset`（F 季末清算，任务1 定稿已判定作废，不迁移，也不在 auctionsvc 出现）。
  - 新增 `itemType='skin'` 分支：挂单调 `meta.escrowSkin`，成交/撤单/过期走系统邮件下发（`kind:'skin'`，只带 `id`，无 `instance` 快照——皮肤无等级/词条）。
  - 新增 `itemType='card'` 的 `meta.escrowCard`/`grantCard`（worldsvc 旧版已支持，一并迁移，非本任务新增能力）。
  - D/G7 异常审计 `scanAnomalies` 一并迁移，新增 `GET /internal/audit/anomalies`（X-Internal-Key 鉴权，无 worldId 参数）。**admin 后端 `clients.ts` 仍指向 worldsvc 的 `/admin/world/audit/anomalies`，未切换**——见下方遗留项。
  - `contracts/openapi-world.yml` **未改动**（`/auction/*` 段仍保留，供 worldsvc 旧服务与现有 client codegen 使用，避免 client 提前失联）；`contracts/openapi-auction.yml` 是全新自包含文件，与前者暂时并行，等任务5/7 切流量后再从 `openapi-world.yml` 删除、由 client 改指向新文件（任务7 范围）。
- **遗留（不阻塞验收，留给后续任务）**：~~admin 的异常审计客户端尚未指向 auctionsvc~~——已在任务5 一并处理（新增 `AuctionClient`/`HttpAuctionClient`/`NW_AUCTION_INTERNAL_URL`，`slgScanAnomalies` 改读 auctionsvc 全局扫描，`worldId` 参数保留仅为路由/前端签名兼容不再使用）；client 端 `WorldApiClient`/`AuctionScene` 仍打 worldsvc（任务7 范围，符合"先双跑验证对等，再切流量"的既定顺序）。
- **验收**：`npm run build` + `npm run typecheck --workspace @nw/auctionsvc` 全绿；`npm test --workspace @nw/auctionsvc`（37 例，3 文件）全绿；`npm test --workspace @nw/worldsvc`（221 例）/`npm test --workspace @nw/metaserver`（513 例）/`npm test --workspace @nw/shared`（535 例）无回归；此时 worldsvc 和 auctionsvc 的 `/auction/*` **同时存在**，验证了新服务功能对等，下一步（任务5）再切流量。

### 拍卖任务5：接入部署（Caddy + compose + CI）✅（2026-07-06）

- [x] **依赖**：任务4 验收通过。
- **主要文件**：`server/Caddyfile`、本地（`docker/docker-compose.local.yml` + `client/nginx.conf`）/`server/docker-compose.prod.yml`/`server/docker-compose.cloud.yml` 三份部署文件（[[project_social_system]] 提过新进程要三处同步）、`.github/workflows/ci.yml`（`server-deploy.yml` 本身是泛化的 `docker compose up -d --build`，不按服务列举，故不用改）。顺带处理了任务4遗留：`server/admin/src/{clients,config,index}.ts`/`src/service/base.ts`/`src/service/slgAudit.ts` + 对应测试。
- **改动范围**：
  - `Caddyfile`：`handle /auction* { reverse_proxy worldsvc:18084 }` 改成 `reverse_proxy auctionsvc:18086`。
  - `docker/docker-compose.local.yml`：新增 `auctionsvc` 服务块（`NW_META_INTERNAL_URL`/`NW_COMMERCIAL_INTERNAL_URL`/`NW_INTERNAL_KEY` 等，照抄 worldsvc 配法，但不需要 Redis/gateway 依赖）；`nginx` 的 `depends_on` 加 `auctionsvc`；`admin` 加 `NW_AUCTION_INTERNAL_URL`。`client/nginx.conf` 的 `/auction` location 改代理到 `auctionsvc:18086`。
  - `server/docker-compose.prod.yml` / `server/docker-compose.cloud.yml`：同样新增 `auctionsvc` 服务块（cloud 用 Atlas `NW_MONGO_URI`，prod 用本地 mongo 容器）；`caddy`/`nginx` 的 `depends_on` 加 `auctionsvc`；`admin` 加 `NW_AUCTION_INTERNAL_URL`。
  - `.github/workflows/ci.yml`：`tsc -b` 包列表加 `auctionsvc`；新增 auctionsvc openapi codegen staleness check 步骤（`npm run gen:api:auction:check`，仿 worldsvc 的对应步骤）。
  - **任务4遗留一并处理**：admin 新增独立 `AuctionClient`/`HttpAuctionClient`/`nullAuctionClient`（`clients.ts`），从 `WorldClient` 里移除 `listAuctionAnomalies`（该方法本就该跟着拍卖状态机搬家）；`slgScanAnomalies(worldId, windowSec?)` 签名不变（前端/路由不用改），但内部改调 `this.auction.scanAnomalies(windowSec)`——`worldId` 参数保留仅为签名兼容，auctionsvc 的扫描是全局的，不再按 worldId 过滤（ops 前端「输入 worldId」的框暂时留着但已不生效，属可接受的过渡期粗糙点，不阻塞验收）。
  - 顺带发现但**不在本任务修**的预置 bug（已 spawn_task 跟踪）：三份部署文件里 admin 从未配过 `NW_WORLD_INTERNAL_URL`，意味着 admin 的 SLG 赛季运维/审计能力在所有环境下一直是 degraded 状态（`world.available=false`），与本次拍卖迁移无关，是更早遗留的独立问题。
- **验收**：`docker compose -f <各文件> config -q`（注入占位环境变量）解析通过；`npx tsc -b shared engine metaserver gateway matchsvc gameserver commercial worldsvc auctionsvc admin analyticsvc` 全绿；`npm run gen:api:auction:check --workspace @nw/auctionsvc` 通过；`npm run typecheck --workspace @nw/admin` 通过。本地 Docker 环境是 Windows 容器模式，无法起 Linux mongo/redis 跑 e2e，故 admin `season-audit.e2e.test.ts`（已改用 `FakeAuction` 桩）未能在本机实跑，留给下次能起 Linux 容器的环境或 VPS 上验证；VPS 上 `docker ps` 能看到 auctionsvc 容器且健康、实际调用 `/auction/create` 走到新服务（查 auctionsvc 日志而非 worldsvc 日志）待下次 push 触发 `server-deploy.yml` 后确认。

### 拍卖任务6：worldsvc 瘦身 ✅（2026-07-06）

- [x] **依赖**：任务5 上线且稳定运行一段时间（**不要在切流量当天就删旧代码**，留几天观察期方便回滚）——**拍板：本任务未等观察期，用户明确要求跳过**，接受当天回滚风险。
- **主要文件**：`server/worldsvc/src/auctionService.ts`（删除）、`src/httpApi.ts`（删 `/auction/*` 三个路由块：公开 `/auction/*`、内部 `/admin/world/audit/anomalies`、`/admin/world/reset` 里的 `clearWorldOnReset` 调用）、`src/metaClient.ts`（删 `deductMaterial`/`escrowEquipment`/`grantEquipment`/`escrowCard`/`grantCard`，`grantMaterial` 仍被据点掉落使用故保留）、`src/mailClient.ts`（`WorldMailAttachment.kind` 去掉 `equipment`/`card`，季末结算只用 coins/skin/material）、`src/scheduler.ts`（去掉 `auctionSvc`/`processExpiredAuctions` 分支）、`src/db.ts`（删 `AuctionDoc`/`AuctionDailyDoc`/`AuctionPriceDoc` 三个接口 + collections + 索引）、`src/index.ts`/`src/config.ts`/`src/mapTemplateService.ts`（去引用/改注释）、`server/worldsvc/test/auction*.e2e.test.ts`（删，已迁到任务4）、`test/map-template.e2e.test.ts`（`startHttpApi` 调用少了一个已删的 `auctionSvc` 位置参数，同步改签名）。`commercialClient.ts` 的 `spend`/`grant` 是通用方法（建筑加速/帮派创建/世界频道/卡牌找回/迁城都在用），未删，只改了头注释。
- **未动**（有意，任务7 范围）：`src/generated/routes.gen.ts`（`server/contracts/openapi-world.yml` 未改，client 仍靠它 codegen，改动会连带影响 client，按既定顺序留给任务7 一并做）——故本任务验收的 `grep -rn auction` 排除该生成文件。
- **踩坑**：worktree 建在 `main` 上时任务5的提交（daily branch `06.07.2026`）还没合并，导致 admin 侧任务5声称已做的 `AuctionClient` 迁移在 worktree 里完全不存在——本任务据此改建在 `06.07.2026` 分支上重跑（先 `git worktree add -b ... main` 再 `git rebase 06.07.2026`），之后确认 admin 侧确已正确指向 auctionsvc。**结论**：跨会话的多阶段任务链，若前序任务只在当日分支未合 main，续做的 worktree 必须基于当日分支而非 main，否则会静默丢失前序改动。
- **验收**：`npx tsc -b shared engine metaserver gateway matchsvc gameserver commercial worldsvc auctionsvc admin analyticsvc socialsvc` 全绿；`npm test --workspace @nw/worldsvc`（188 例）、`npm test --workspace @nw/admin`（27 例）全绿；`grep -rn auction server/worldsvc/src`（排除 `generated/`）仅剩迁移说明注释，无业务代码命中。

### 拍卖任务7：client 端清理 ✅（2026-07-06）

- [x] **依赖**：任务5 上线（client 改动和后端切流量应在同一次发布，避免旧客户端 + 新后端的过渡期兼容问题——反代路径不变，理论上无兼容问题，但 `worldId` 参数被服务端忽略时行为需确认）。
- **主要文件**：`client/src/net/WorldApiClient.ts`（`listAuctions`/`getMyListings`/`createAuction`/`buyAuction`/`placeBid`/`cancelAuction` 六个方法去掉 `worldId` 入参，请求体/查询串不再带 `worldId`）；`client/src/scenes/AuctionScene/base.ts`（`AuctionSceneCallbacks` 去掉 `worldId` 字段，`loadData()` 调用同步）、`bid.ts`/`tradeActions.ts`/`createForm.ts`（对应调用点去掉 `this.cb.worldId` 实参）；`client/src/app/nav/world.ts`（`goAuctionFromLobby` 整段删掉 `resolveWorldShard` 前置解析，直接 `views.showAuction`；`goAuctionHouse` 自身签名不变——从世界地图打开时仍需 `worldId` 供 `onBack` 返回同一张地图，只是不再把 `worldId` 转发进 `AuctionSceneCallbacks`）。测试同步：`test/ui/auctionScene.ui.ts`/`test/ui/caretRegression.ui.ts`/`test/ui/scenes.ui.ts` 里构造 `AuctionScene`/断言 `worldApi.*` 调用参数的地方去掉 `worldId`。
- **未动**（有意，超出本任务范围）：`AuctionView` 类型仍从 `client/src/net/openapi-world.ts`（由未改动的 `server/contracts/openapi-world.yml` 生成）导入，而非任务4新建的 `openapi-auction.yml`——两者 schema 字段目前一致（`openapi-world.yml` 的 `/auction/*` 段本身也未删，见 §9 任务6 备注），故类型检查不受影响；但这意味着 client 尚未真正"改指向新文件"（任务4/5 遗留的最后一句表述）。若后续要彻底切断 client 对 `openapi-world.yml` 拍卖段的依赖，需要：① `client/scripts/gen-openapi.mjs` 新增 `openapi-auction.yml → openapi-auction.ts` 流水线，② `WorldApiClient.ts` 的 `AuctionView` 改从新文件导入，③ 确认无回归后再从 `openapi-world.yml` 删除 `/auction/*` 段并重新生成 `openapi-world.ts`/`server/worldsvc/src/generated/routes.gen.ts`（§9 任务6 里同样留白的那份）。不阻塞当前验收（功能已完全跑通 auctionsvc）。
- **验收**：`npm run typecheck`（`tsc --noEmit -p tsconfig.test.json`）绿；`npm run build:web`（webpack production）绿；`npx vitest run --config vitest.ui.config.ts`（14 文件 185 例，含 `auctionScene.ui.ts` 23 例）全绿；大厅入口（`goAuctionFromLobby`）和 SLG 世界地图入口（`goAuctionHouse`）都能直接打开拍卖行，前者不再经过 `resolveWorldShard`。

### 拍卖任务8：补 auctionsvc 测试覆盖 ✅（2026-07-06）

- [x] **依赖**：任务4-7（服务已迁移落地）。纯补测试，零 `src/` 改动。
- **背景**：任务4 迁移时 `auction.e2e.test.ts` 的 fakeMeta 把 `escrowCard` 桩成 `throw 'unused'`——**角色卡（CC-5）拍卖全链路无任何覆盖**（装备/皮肤各有整组，唯独已上线的角色卡漏测）；C 每日购买上限、B 竞拍防抢拍延时/未达买断价不结拍三处边界也缺用例。
- **改动**（`server/auctionsvc/test/auction.e2e.test.ts`，+9 例 30→39，全文件 37→46）：
  - **CC-5 角色卡 6 例**：给 fakeMeta 补真实 `cardInv` + `escrowCard`（校验 gear 全空→否则 `CARD_HAS_GEAR`；不存在→`CARD_NOT_FOUND`）/`grantCard`；覆盖挂单（escrow 移出库存 + 存实例快照 + qty 强制 1）/购买（实例经邮件发买家含 level·xp 快照 + 卖家税后到账）/取消退回/过期退回/带装备拒挂/未拥有拒挂。
  - **C 每日购买上限 1 例**：买满 `AUCTION_DAILY_BUY_CAP`（30）后再买 → `AUCTION_LIMIT_REACHED`（镜像已有的每日挂单上限用例）。
  - **B 竞拍边界 2 例**：防抢拍——到期前落在 `AUCTION_ANTI_SNIPE_WINDOW_SEC` 窗口内出价，`expireAt` 顺延一个窗口；未达买断价——出价 ≥ 起拍价但 < 买断价不立即结拍，单子保持 `open`。
- **未覆盖（有意）**：`MATERIAL_NOT_TRADEABLE`（E 绑定材料禁挂）——`AUCTION_BANNED_MATERIALS` 当前是**空集**（无任何禁挂材料），该闸门为潜伏逻辑，无法在不改数值配置的前提下从真实 config 触发，故不加桩测。若将来往禁挂集里放材料，需同步补一条 `MATERIAL_NOT_TRADEABLE` 用例。
- **验收**：`npm run typecheck --workspace @nw/auctionsvc`（`tsc --noEmit`）绿；`npm test --workspace @nw/auctionsvc`（3 文件 46 例）全绿。
- **踩坑记**：主仓 `server/node_modules/@nw/shared` 被并行 worktree 污染成**过期物理副本**（缺 `SKIN_NOT_FOUND` 等新错误码），导致 `skin not owned` 用例在主仓 `code:undefined` 假失败；本任务全程在独立 worktree + `npm install` 干净依赖里做，`node -e require.resolve('@nw/shared')` 落地在 worktree 自己的 `shared/dist`。见 [[feedback_worktree]]。

### 拍卖任务9：客户端→服务端全链路 e2e + 修错误信封 bug ✅（2026-07-06）

- [x] **依赖**：任务4-8。背景：此前拍卖测试分两层各测各的——auctionsvc 直接 new `AuctionService` 调服务层（`auction.e2e.test.ts`），client 只 mock `WorldApiClient` 测 UI（`auctionScene.ui.ts`）；**没有任何测试把真实客户端网络层真实打到拍卖服务**，中间 HTTP + JWT + 信封 + DTO 契约那一段是空的。
- **改动**（`server/auctionsvc/test/auction-fulllink.e2e.test.ts`，新建 5 例）：起真实 auctionsvc HTTP（`startHttpApi`，端口 0 取临时口）+ mongodb-memory-server，只桩下游 commercial/meta/mail；用**真实的 `client/src/net/WorldApiClient`**（设 `globalThis.__NW_WORLD_BASE__` 指向临时服务）跑 create→list→mine→buy 全流程、竞拍出价+买断、卖家取消退回、错误码映射、无 JWT→`UNAUTHENTICATED`。`WorldApiClient` 运行时只依赖纯函数 `./config`（DTO 是 type-only），跨包 import 干净；auctionsvc typecheck 只 include `src/**`，测试文件的跨包引用不进类型门。
- **发现并修复的真 bug**（`client/src/net/WorldApiClient.ts`）：`req()` 读的是顶层 `json.code`/`json.message`，但 `@nw/shared` 的 `ApiResp` 错误信封是 `{ ok:false, error:{ code, message } }`（metaserver 的 `ApiClient` 读法正确，world 客户端当初抄漏了）。后果：**生产环境 worldsvc/auctionsvc/socialsvc 的所有错误码都被吞成 `UNKNOWN`**，`AuctionScene.errorMsg()` 那张 `PRICE_OUT_OF_RANGE`/`AUCTION_CLOSED`/`INSUFFICIENT_FUNDS`→本地化提示的码表在真机上全部走 fallback 形同虚设。UI 单测没抓到是因为它直接 `new WorldApiError('CODE',...)` 造码，不经过 `req`。改为读 `json.error?.code`。
- **验收**：`npm test --workspace @nw/auctionsvc`（4 文件 51 例，含新增 5 例）全绿；auctionsvc `tsc --noEmit` 绿；client `tsc --noEmit` 绿；client `test:ui`（14 文件 185 例）无回归。
- **补全（2026-07-06 续）**：原 5 例只覆盖**材料**类目全链路（其余类目 meta 桩里 `escrowEquipment`/`escrowCard` 直接 `throw notNeeded`）。新增 3 例（现 8 例）把**装备**与**角色卡**也真打过 `WorldApiClient`：meta 桩改为带模拟库存的 `escrowEquipment`/`grantEquipment`/`escrowCard`/`grantCard`（镜像 `auction.e2e.test.ts` 的 seam），验证 ①装备 create→list→mine→buy 全链路 + 实例/词缀快照过线不丢 ②角色卡 create→buy（level/xp 快照）+ 卖家取消回邮 ③meta 侧 escrow 拒绝 `EQUIP_LOCKED`/`CARD_HAS_GEAR` 经 `{ok:false}` 信封映射为带码的 `WorldApiError`。**皮肤有意不覆盖**：客户端 `AuctionScene` 的 `ItemClass = material|equipment|card`（无皮肤 picker），真实 `WorldApiClient.createAuction` 类型签名也不含 `'skin'`，皮肤交易是 auctionsvc 服务端能力、无客户端入口，故全链路（真客户端网络层）无法也无需覆盖，皮肤仅由服务层 e2e（`auction.e2e.test.ts`）保证。auctionsvc 全套 54 例全绿。
- **接入 client live-stack e2e（2026-07-06 续）**：上面两处（auctionsvc-local）用的都是 ad-hoc `startHttpApi` + hand-signed JWT + 桩下游；最后一段缺口——**真 app core → 真 HTTP → 活的 auctionsvc（连真 commercial/meta/mail 跨服务调用）**——现补进 `client/test/e2e/full-link.e2e.ts`（那条 `npm run test:e2e` 跑真·live-stack 的用例）：
  - `HeadlessAppViews.showAuction` 改为**捕获** `AuctionSceneCallbacks`（原来丢弃）；测试经 `lobby.onOpenAuction()`（真 `goAuctionFromLobby`：token 门 + 用登录后的 `platform.storage` token 造 `WorldApiClient`）拿到 `views.auction.worldApi` 那个真客户端实例。
  - 新增 `describe('auction full-link', …)`：注册 seller/buyer 真账号 → 经 meta `/internal/materials/grant`（`NW_INTERNAL_KEY=dev-internal-key`）给 seller 播种 scrap（新账号无库存）→ buyer 真充值拿币 → seller `createAuction` → mine/list 可见性 → buyer `buyAuction` → 成交后市场消失 → 卖家买自己挂单 `BAD_REQUEST` 经 `{ok:false}` 信封映射为带码 `WorldApiError`（task9 信封修复的**活线回归护栏**）。
  - **base 路由**：`/auction/*` 走 `getWorldBaseUrl()`（同源时 Caddy 代理到 auctionsvc:18086）；该 describe 的 `beforeAll` 把 `globalThis.__NW_WORLD_BASE__` 指到 `NW_AUCTION_BASE`（默认 `http://127.0.0.1:18086`），`afterAll` 还原。auctionsvc 探活失败则**整块 skip + warn**（它是 dev-up 额外进程，非本文件其余用例的硬前置）。
  - **基础设施**：`server/dev-up.ps1` 加 `auction` 进程（`NW_AUCTION_PORT=18086` + meta/commercial internal URL）+ health 探测；`client/vitest.e2e.config.ts` 补 `@nw/shared` alias（引 `AUCTION_DURATIONS_SEC`/`AUCTION_TAX_RATE`）。
  - **验收**：client `tsc --noEmit -p tsconfig.test.json` 绿；`test:e2e -t "auction full-link"` 在本机（无 auctionsvc）按预期 skip 且文件加载无误。真·live-stack 全绿验证需 `npm run dev:all`（现已含 auctionsvc）后跑。

### 拍卖任务10：补完任务7遗留缺口——client 真正切到 `openapi-auction.yml` ✅（2026-07-27）

- [x] **依赖**：任务7（当时有意搁置，见其"未动"条目）。背景：socialsvc 契约任务（`SOCIAL_SVC_DESIGN.md` §9）收尾时顺带巡查其它服务的 client codegen 接线情况，发现 `AuctionView` 一直是任务7遗留的半成品——`client/scripts/gen-openapi.mjs` 从未加过 `openapi-auction.yml` 的流水线，`WorldApiClient.ts` 的 `AuctionView` 仍从 `openapi-world.ts`（`server/contracts/openapi-world.yml` 手工复制的过期副本）导入。
- **发现的真 drift（先于接线本身）**：diff 两份契约发现 `openapi-world.yml` 的 `AuctionView` 是 2026-07-06 拆分前的旧快照——多余的 `worldId`（早已从 `auctionsvc` 去耦合，见 §9 拍板）、`itemType` 枚举缺 `skin`；而**当前**的 `server/contracts/openapi-auction.yml` 反而漏了 `topBid` 字段——`auctionService.ts`/`docToView()` 一直有条件返回 `topBid`，且 client `AuctionScene/list.ts`/`bid.ts` 早就在读 `auc.topBid`（显示"当前最高出价" vs "起拍价"），只是因为 client 类型来源一直没切过去，这个契约 bug 从未在 `tsc` 里现形。
- **改动**：① `server/contracts/openapi-auction.yml`：`AuctionView` 补回 `topBid?: {bidderId, amount, ts}`（与 `openapi-world.yml` 旧副本、`auctionService.ts` 内部接口对齐）；② `client/scripts/gen-openapi.mjs` 新增第三条流水线 `openapi-auction.yml → src/net/openapi-auction.ts`；③ `WorldApiClient.ts`：`AuctionView` 改从 `auctionComponents['schemas']['AuctionView']`（新文件）导入，去掉对 `openapi-world.ts` 里那份的依赖，文件头注释同步说明 `AuctionView` 是唯一例外（源自 auctionsvc 自己的契约）；④ `server/contracts/openapi-world.yml` 删除整段死代码——`AuctionView` schema + `/auction/{list,mine,create,{auctionId}/buy,{auctionId}/bid,{auctionId}/cancel}` 六个 path（worldsvc 早已不服务 `/auction/*`，Caddy 直接转发到 `auctionsvc:18086`，`worldsvc/src/httpApi.ts` 注释也明确写"已迁移"——纯遗留，无运行时影响）；⑤ 连带重新生成两个服务的 `routes.gen.ts`（`auctionsvc` 因 schema 加字段、`worldsvc` 因删 path+schema 都变"stale"）。
- **范围之外（已于任务11补上）**：`createAuction`/`AuctionScene` 的 `itemType` 当时仍不支持 `'skin'`——皮肤交易只有服务端能力（`auctionsvc`），UI 从未接入 picker，任务9 已记录过同样的结论；本任务只是切换类型来源，不新增功能。`sellerName`/`totalPrice`/`currency` 等字段在两份契约里 required 标注的细微差异（均非新引入）未动，不影响生成的 TS 类型（本来就是 optional）。
- **验收**：client `tsc --noEmit`（`tsconfig.json` + `tsconfig.test.json`）绿；`npm run build:web` 绿（仅预期内的 asset-size 警告）；client `vitest run`（110 文件 781 例）全绿；`auctionsvc`/`worldsvc` 各自 `npm run gen:api:*:check` 绿、`typecheck` 绿、`test`（分别 5 文件 71 例 / 44 文件 338 例）全绿。
- **踩坑记**：worktree 内 `client/node_modules` 无 `@nw/*` 依赖，直接 junction 到主仓即可省掉一次安装；`server/node_modules` 含 `@nw/shared`/`@nw/engine` 等 workspace 包，按 [[worktrees]] 的陷阱说明老实 `npm install` + 分别 `npm run build`（两个包的 `dist/` 不存在会导致下游 `tsc` 报 `Cannot find module '@nw/shared'`，和本次改动无关，纯粹是新 worktree 的构建顺序问题）。

### 拍卖任务11：client 拍卖 Picker 接入皮肤（`itemType='skin'`）✅（2026-08-04）

- [x] **依赖**：任务2（皮肤托管能力）+ 任务10（client 已切到 `openapi-auction.yml`，`itemType` 枚举早已含 `skin`）。**触发原因**：用户反馈"抽到的多余皮肤没出现在拍卖列表里"，排查后发现根因不是过滤条件写错，而是任务7/任务10两次都把"皮肤 UI"记成"范围之外"——服务端 `escrowSkin`/`grantSkin`（`server/metaserver/src/skin.ts`）、`auctionService.ts` 的 `itemType==='skin'` 分支、`openapi-auction.yml` 的 `itemType` 枚举全部早已就绪，纯粹是 client picker 从未读取 `save.inventory.skins`。
- **改动范围**（全部 client-only，服务端/契约零改动）：
  - `client/src/scenes/AuctionScene/base.ts`：`ItemClass`/`FILTERS` 加 `'skin'`；新增 `createSkinId` 状态字段；`itemKind()` 加 `skin→'brush'`（复用 GachaScene 已用的 IconKind，不新增枚举值）；`auctionLabel()` 加皮肤分支（`skinDisplayName(item.skinId)`）；`errorMsg()` 补 `SKIN_IN_USE`/`SKIN_NOT_FOUND` 错误码映射。
  - `client/src/scenes/AuctionScene/picker.ts`：新增 `listableSkins()`（读 `save.inventory.skins`，用 `allEquippedSkins(save.equipped)` 过滤已装备的，镜像服务端 `isSkinEquipped` 判定）；`buildPickEntries()`/`renderPickIcon()`/`renderPickerSidebar()` 各加皮肤分支——图标复用 `GachaScene/odds.ts` 已有的皮肤立绘取图写法（`unitPortraitUrl(SKIN_TARGET_UNIT[skinId], skinId)` + `getArtTexture` 异步纹理，无立绘则 fallback `'brush'` 图标）。
  - `client/src/scenes/AuctionScene/createForm.ts`：`doCreate()` 加 `itemType='skin', item={skinId}, qty=1` 分支。
  - `client/src/scenes/AuctionScene/list.ts`：分类栏 + `renderItemPicture()` 同步加皮肤分支（市场挂单列表也要能正确显示皮肤图标/标题，不只是 picker）。
  - `client/src/net/WorldApiClient.ts`：`createAuction()` 的 `itemType` 参数字面量类型加 `| 'skin'`（`AuctionView` 类型本身早已含 skin，仅这一处手写封装层缺失）。
  - i18n 三语言文件补 `auction.filterSkin`/`auction.err.skinInUse`。
- **未改动（截至本任务11当时）**：皮肤本身没有实例id（`inventory.skins: string[]` 去重集合，"拥有一份"="拥有全部"），拍卖只按 `skinId` 字符串托管/归还，与装备/角色卡的 instanceId 模型不同，这是既有设计（`skin.ts` 头部注释），不在本任务范围内调整（相关的"是否要给皮肤也上实例id"的讨论见 [[item-identity-audit]] / `ITEM_IDENTITY_DESIGN.md`）。**2026-08-08 更新**：`ITEM_IDENTITY_DESIGN.md` 任务1已给皮肤加上服务端实例（`skinInstances` 集合），但拍卖挂单的**外部契约**仍是 `{skinId}` 不变——`escrowSkin`/`grantSkin` 对 auctionsvc 而言接口没变，只是内部实现换成了"挑一份实例操作"，本段描述的"拍卖只按 skinId 字符串托管"在挂单接口这一层依然成立。
- **已知限制（未修复，属于更深的经济系统缺口，不在本任务范围）**：gacha 抽到"重复"皮肤（账号已拥有过）目前是纯 no-op（`markDuplicates`，`economy.ts`），不会产生任何新库存或补偿——即使补上本任务的 picker UI，一个**真正重复**的皮肤仍然不会出现在拍卖列表里，只有"未装备但从未拍卖过的唯一一份"才会。设计文档里"重复转化待S5"的待办（本节 §9 任务2 引用）尚未排期。
  > **2026-08-08 更新：以上限制已解决**，见 `ITEM_IDENTITY_DESIGN.md` 任务1——皮肤实例化落地，gacha 重复皮肤现在会生成真实第二份实例（不再是 no-op），"装备中不可挂拍"也从"完全禁止"放宽为"只保护最后一份"，多余的那份现在能正常出现在拍卖 picker 里；同时新增玩家主动发起的"出售给系统换金币"入口（`/skins/sell`），与自动转币的原设想不同。挂单契约本身（`{skinId}`）刻意保持不变，见任务1的说明。
- **验收**：`server/metaserver`（67 文件 804 例）、`server/shared`（35 文件 678 例）、`server/auctionsvc`（9 文件 91 例）全绿；client `tsc --noEmit` 绿；`npm run build:web` 绿（仅预期内 asset-size 警告）；client `vitest run` + `vitest run --config vitest.ui.config.ts`（合计 259 文件 2077 例）全绿。测试覆盖分两批：首批 5 条 `auctionPickerDedupe.ui.ts` 皮肤专项用例（未装备过滤、entry 生成、pick 后 `doCreate` 请求体、分类 tab 渲染）；用户要求"全部加测试"后追加：`auctionScene.ui.ts` 补齐此前完全无覆盖的 `itemKind()`/`auctionLabel()`（含 skin 分支）+ `SKIN_IN_USE`/`SKIN_NOT_FOUND` 错误映射，`equipment.test.ts`（shared）补 `makeGachaEquipInstance`/`makeDropInstance` 的溯源字段透传单测（详见 `ITEM_IDENTITY_DESIGN.md` §2 的溯源字段验收清单）。
- **未验证**：本次会话 Browser 预览面板未能渲染帧（环境限制），且触达真实 AuctionScene 需要登录态 + 跑起来的 metaserver/auctionsvc 后端，故**没有做浏览器截图验证**，只有 headless PIXI 单测覆盖（真实 PIXI 场景树、无渲染器）+ 生产构建通过。下次有可用预览环境时应补一次真实截图核对。

### 出售物品选择页：左侧类目栏 + 图标卡放大 1.5x（2026-07-09，2026-08-04 追加放大）

- **改动**（`client/src/scenes/AuctionScene/picker.ts`）：`PickEntry` 加 `cls` 字段（material/equipment/card），选择页装订线左侧新增全部/装备/角色卡/材料四个类目 tab（复用 `HubTabs.drawSidebarTabs`，与市场列表页 `renderSidebar` 同一视觉语言），点击按 `cls` 过滤右侧网格；网格改用 `marginLineX(w)` 让出左栏。图标卡尺寸/字号整体 ×1.5（`CARD_GAP` 10→15、`CARD_W_TARGET` 130→195、`CARD_H` 104→156，图标 26→39、名称字号 12→18、`Select ›` 提示 10→15）。
- **状态**：新增 `AuctionSceneBase.pickerFilter`（`AucFilter`，复用市场页的类型），`openItemPicker()` 时重置为 `''`。
- **2026-08-04 追加**：用户反馈图标偏小、名称贴图标太近——`renderPickCard()` 图标尺寸 39→56、名称 y 偏移 78→88（`CARD_H` 156 不变，"Select ›" 提示位置 `y+148` 不变，与新名称位置净空 22px+，不重叠）。
- **验收**：`tsc --noEmit` 绿；`webpack --mode production` 绿。

### 修复：拍卖退回邮件标题/正文显示为原始 i18n key（2026-07-12）

- **问题**：`auctionsvc.deliverItem()`（`server/auctionsvc/src/auctionService.ts`）按设计把 `subject`/`body` 发成 i18n key（如 `auction.mail.returned.subject`），注释写明"resolved client-side"，但 `client/src/scenes/FriendsScene/mail.ts` 的邮件列表行/详情页直接渲染 `m.subject`/`m.body` 原始字符串，从未过 `t()`，导致玩家看到裸 key 而非"拍卖物品退回"这类本地化文案。
- **修复**：`mail.ts` 新增 `mailText(raw)` 辅助函数（复用文件里已有的 `defDisplayName` 同款"能查到就翻译、查不到就原样返回"模式）：`t(raw as TranslationKey)` 结果等于 key 本身则判定为玩家自撰的纯文本邮件（好友/家族消息），直接展示原文；否则展示译文。列表行 subject、详情页 subject 与 body 三处调用点均改用该函数。
- **验收**：client `tsc --noEmit` 绿；dev server HMR 重编译无报错。未做登录态下的真实拍卖退回邮件截图验证（需要后端账号/拍卖数据造数据，超出本次修复范围）。

### 修复：拍卖退回/成交邮件领取报"Claim failed"（2026-07-12）

- **问题**：玩家反馈拍卖过期退回的物品无法从邮件里领取，点 Claim 报通用失败提示。真机复现（起本机整套后端 + 真实 Mongo，走真实 `/auction/create` → `/auction/:id/cancel` → `/mail` → `/mail/:id/claim` 全链路，绕开任何 mock）定位：socialsvc 的 `mailId = ${dispatchKey}:${to}`；拍卖邮件的 `dispatchKey` 内嵌完整 `auctionId`（`a:{sellerId-uuid}:{ts}:{n}`），再拼上收件人 `to`（另一个 UUID）后，`mailId` 长度轻松超过 100 字符。Fastify 路由器（find-my-way）`:id` 参数默认 `maxParamLength=100`，超长直接在路由匹配这一步 404（"Route not found"，连 `claimMail` handler 都没进），前端只能吞成通用"Claim failed"，玩家/客服完全看不出问题出在 mailId 长度上。**成交邮件（`auction_buy`/`auction_settle`）用同一套 `deliverItem`，同样会踩坑**，不止退回。
- **修复**：`server/metaserver/src/app.ts` 构造 Fastify 实例时加 `routerOptions: { maxParamLength: 200 }`（Fastify 5 起 `maxParamLength` 顶层字段已废弃，需放 `routerOptions` 下），200 对现实中最长的 mailId 有约 2 倍余量。
- **顺带修复的环境问题**：
  1. `server/dev-up.ps1` 从未把 `socialsvc` 纳入进程列表（`npm run dev:all` 因此永远不会启动它），且 meta 进程的 env 里也没配 `NW_SOCIALSVC_INTERNAL_URL`——P2 迁移后邮件全链路依赖 socialsvc，标准 dev 流程实际上从未真正跑起来过。已补上 `social` 进程条目 + `NW_SOCIALSVC_INTERNAL_URL`，并把 `social`/`auction` 加进健康检查列表（`dev-up.ps1` 和根 `package.json` 的 `dev:health` 都补了）。
  2. `dev-up.ps1` 本身缺 UTF-8 BOM，文件里的全角箭头/破折号在本机 Windows PowerShell 5.1 + 代码页 850 下会被错误解码，导致整个脚本解析失败（"missing string terminator"），`npm run dev:all` 在本机此前一直连窗口都开不出来。已给文件加 BOM。
- **验收**：`server/metaserver/test/mail-claim.e2e.test.ts`（真实 Mongo + 真实跨服务 HTTP，mailId 特意造到超 100 字符，card/equipment 各一例，回归前会 404，回归后 200）；metaserver 全量单测 42 files / 518 tests 绿；真实起满整套后端（含修复后的 dev-up.ps1）+ 真实 Mongo，走 `/auction/create` → `/auction/:id/cancel` → `/mail` → `/mail/:id/claim` 完整复现并确认修复生效（`{"ok":true}`，material 正确回背包）。

### 修复：拍卖行返回按钮点在背景区无效（2026-07-15）

- **问题**：玩家反馈拍卖行标题栏"← Back"看起来和其它场景一样宽，但点在返回文字右侧的"背景"上没反应。根因：`AuctionSceneBase.build()`（`client/src/scenes/AuctionScene/base.ts`）用共享组件 `drawSceneHeader()` 返回的标准返回热区（`hdr.backRect`，宽度是统一常量 `BACK_HIT_W=160`）建头部，但 `render()` 每次都会清空 `hitRects` 重建，重建时却硬编码了一个**只有一半宽（`w:80`）**的热区（item-picker 遮罩层同样硬编码）——视觉上和商店等场景一致的返回条，实际可点区域只有左半边。
- **修复**：把 `hdr.backRect` 缓存到实例字段 `backRect`，`render()` 里两处硬编码的 `{w:80}` 都改成复用它，和 `ShopScene` 等场景的写法统一。
- **验收**：`tsc --noEmit` 绿；headless 实例化 `AuctionScene` 读取渲染后的 `hitRects` 确认宽度恢复为 160；新增回归测试 `client/test/ui/auctionBackButtonHitWidth.ui.ts`（4 例：初始/多次 render 后宽度不变、右半区点击触发 onBack、item-picker 遮罩下右半区点击取消 picker）——摘掉修复重跑 4 例全部按预期失败，验证测试能真正捕获这个回归。

### 修复：出售物品选择页图标错误 + 重复堆叠（2026-07-16）

- **问题**：`picker.ts`（出售物品选择页）里，装备类目的所有条目一律画成同一个盾牌图标（`itemKind()` 硬编码 `'armor'`），角色卡类目一律画同一个书本图标（硬编码 `'cards'`）——市场列表页 `list.ts`/`renderAuctionCell` 早已有真实的按槽位/稀有度程序化图形（装备）与真实立绘（角色卡）的画法（`renderItemPicture`），选择页却从未接上。此外装备/角色卡的库存实例是**逐个实例**枚举的（`listableEquipment()`/`listableCards()`），玩家抽到几十个同款低阶装备（Marker/Pencil 等）或多张同名 Lv.1 卡时，选择页会把同一件物品重复铺满整页网格。
- **修复**：`renderPickCard` 改调用新增的 `renderPickIcon`（镜像 `list.ts` 的 `renderItemPicture` 画法）——装备用 `getEquipDef(defId)` 取槽位/稀有度走 `drawEquipmentGlyph` 程序化图形，角色卡用 `CARD_DEFS[defId].unitType` 取 `UNIT_ART_URLS` 真实立绘（异步加载沿用既有 `artHooked` 去重+加载完成后 `render()` 的机制），材料保留原有专属图标兜底。`buildPickEntries()` 里装备/角色卡改为按 `defId+level` 分组（`Map`）而非逐实例枚举，标签追加 `×N`（如"Marker +0 ×3"）；`onPick` 落在分组代表实例上——反正每次挂单服务端强制只拿走 1 个实例（qty=1），组内实例本就等价，拍到哪个都一样。角色卡分组时优先选未上锁的实例作代表，避免把可挂的库存"锁"在一个恰好被选为代表的已锁实例背后。
- **验收**：`tsc --noEmit` 绿；headless 灌入含重复装备/卡片的假 save（5×Pencil、3×Marker、4×Su Yuan Lv.1 + 各一件独立高阶装备/卡）实例化 `AuctionScene` 并调用 `buildPickEntries()`，确认重复项正确合并为单条 `×N` 标签、非重复项维持原样；`toDataURL()` 截图确认装备显示各自独立图形、角色卡显示真实立绘，不再是统一占位图标。

### 客户端：打开的拍卖行界面自动刷新 + 并发抢购处理（2026-07-17）

- **问题**：玩家反馈「拍卖行里的物品被别人买走后，我已经打开的界面不会主动刷新」。根因：`AuctionScene` 打开时只在构造函数里 `loadData()` 拉一次，之后只有**本人**下单/出价/取消/改筛选才重拉；`auctionsvc` 是纯 REST 独立服务（独立库、端口 18086，**未接** gateway `/gw` 推送、无 Redis），成交只给买卖双方发系统邮件，不广播给其它在线客户端——所以别人买走后本地缓存一直是旧的。
- **方案选型：定时拉取（非服务器广播）**。理由：① 改动自包含（纯客户端一处），镜像 `WorldMapNet` 既有的 `setInterval` 刷新模式；② 服务器广播要动四层（给 auctionsvc 加 gatewayClient + 新 `PushMsg`/proto `ServerMsg` 类型 + `NetSession` 路由 + 场景订阅），且 auctionsvc 是刻意做成孤立服务的；③ 项目既有推送一贯被当作「轮询之上的加速器」（`gatewayClient` 注释：gateway 没配时 client relies on polling）；④ 拍卖列表是全服共享数据而非点对点事件，靠推送保鲜需服务器知道「谁开着界面、看哪个筛选」才能精准推，否则等于全服广播每笔成交，不如客户端自轮询。拍卖列表非低延迟刚需，晚几秒看到「已售出」可接受，且成交本就有邮件兜底。
- **实现**：
  - **轮询**（`base.ts`）：常量 `AUCTION_POLL_SEC=5`；`update(dt)` 里累加 `pollTimer`，达阈值调 `pollRefresh()`。`pollRefresh()` 是**静默重拉**——不置 `loading`（无「加载中」闪屏）、保留 `scrollY`；用轻量签名 `auctionSig()`（`auctionId:price:status:expireAt:buyerId` 拼接）比对，**仅当数据真变了才 `render()`**，避免每 5s 无谓 teardown/重建 body（会打断滚动）。护栏：`loading || modalOpen || itemPickerOpen` 时**暂停计时**（绝不在开着的创建/出价表单或选择页上重绘），且 `await` 后再次复查这些标志以防拉取途中弹窗打开。轮询挂在场景自己的 `update(dt)` tick 上而非裸 `setInterval`，`destroy()` 后自动停，无悬挂定时器泄漏。
  - **并发抢购**（`tradeActions.ts` `doBuy`）：两人在轮询间隙同抢一件，失败方的 `buyAuction` 抛 `AUCTION_CLOSED`/`AUCTION_NOT_FOUND` → 弹专用提示 `auction.err.soldOut`（中「手慢了，该物品已被他人买走」/英/德）并 `loadData()` 刷新，让作废的卡片消失；其它错误（如金币不足）维持原有报错、不刷新（挂单仍有效）。`bid.ts` `doBid` 同理：竞拍在间隙被买断/到期时也刷新列表。
- **验收**：`tsc --noEmit` 绿；`client/test/ui/auctionScene.ui.ts` 新增 16 例（共 55 通过）。轮询组：到点重拉并应用变更快照、未到点不拉、modal/picker 打开时暂停+恢复、`loading` 时不拉、dt 分段累加恰好触发一次、沿用当前筛选重拉、签名不变时**只拉不重绘**、有新出价（价格变）时重绘、拉取途中弹窗打开则丢弃该次结果不覆盖表单、离线拉取失败保留上次快照、`destroy()` 后不再拉且在途 `pollRefresh` 安全早退。抢购/竞拍组：`AUCTION_CLOSED`/`AUCTION_NOT_FOUND` 均弹 soldOut+刷新、金币不足不刷新、竞拍在间隙结束弹错+刷新、出价过低不刷新。注：真实并发抢购需两个客户端 + 活的 worldsvc/auctionsvc 后端，preview 单端无法复现，逻辑由驱动真实场景的 headless 测试覆盖。

### ops：新增拍卖挂单查询工具（不限成交，任意状态）（2026-07-18）

- **问题**：ops 后台此前只有 G7 反 RMT 异常扫描器（`GET /admin/slg/audit/anomalies`，见 §4.D）——按 seller→buyer 聚合**已成交**订单统计对敲/定向异价信号，无法回答「这一条在售挂单具体是什么样（含 `designatedBuyerId`）」这类客服/调查场景，且完全看不到 `open`/`cancelled`/`expired` 状态的挂单。
- **改动**：
  - `server/shared/src/slg/auction.ts`：新增 `AuctionListingQuery`（`sellerId`/`itemType`/`status`/`itemName`/`limit`）与 `AuctionListingAdminView`（`AuctionDoc` 的管理视图，含 `designatedBuyerId`/`buyerId`/`soldAt`/`closedAt`/`topBid` 等全字段 + 派生 `itemName`）。
  - `server/auctionsvc/src/auctionService.ts`：新增 `queryListings()`——`sellerId`/`itemType`/`status` 在 Mongo 层过滤，`itemName`（材料名/装备 `defId`/卡牌 `defId`/皮肤 `skinId`，物品类型不同字段不同、无法直接建索引查询）在内存里对一次性拉取的至多 `QUERY_FETCH_CAP=500` 条做子串匹配后再按 `limit`（默认 50，上限 200）截断。
  - `server/auctionsvc/src/httpApi.ts`：新增内部端点 `GET /internal/audit/listings`，鉴权模式照抄既有 `/internal/audit/anomalies`（`X-Internal-Key`，无玩家 JWT）。
  - `server/admin/src/clients/auction.ts`：`AuctionClient` 接口 + `HttpAuctionClient` 新增 `queryListings()`。
  - `server/admin/src/service/slgAudit.ts`：新增 `slgQueryAuctionListings()`（复用既有 capability `slg.audit.view`，只读查询，与异常扫描同一信任级别，未新增 capability）。
  - `server/admin/src/httpApi.ts`：新增路由 `GET /admin/slg/audit/listings`。
  - `tools/ops/src/api.ts` + `tools/ops/src/types.ts`：新增 `slgQueryAuctionListings()` 客户端方法 + 镜像类型。
  - `tools/ops/src/pages/auctionAudit.ts`：在既有「SLG Audit」页顶部新增「Listing lookup」卡片（sellerId / itemType / status / item name 四个筛选框 + 结果表格，展示 Auction ID/Seller/Item/Qty/Price/Sale mode/Status/Designated buyer/Buyer/Expire-closed），复用同一 nav 项与 capability，不新增页面/导航条目。
- **验收**：`tsc --noEmit` 对 `shared`/`auctionsvc`/`admin`/`tools/ops` 四个包全绿。未跑 e2e/UI 截图验证（无新增业务规则或可见渲染回归风险，纯新增只读查询通路）。

### 修复：市场里点自己的挂单报 BAD_REQUEST（2026-07-22）

- **问题**：玩家反馈市场（All 标签）里某个挂单点「Buy」报红 `BAD_REQUEST`（后端 400）。根因：`listAuctions`（`server/auctionsvc/src/auctionService.ts`）的 `$or` 含 `{ sellerId: accountId }`，会把**卖家自己的挂单**也带进市场视图（本是为满足 §「卖家/被指定买家可见定向单」的可见性需求，见 2026-07-18 条），但客户端 `list.ts`/`renderAuctionCell` 的 all 分支不区分归属、一律渲染 Buy/Bid，点下去必然命中服务端自购护栏 `if (doc.sellerId === buyerId) throw BAD_REQUEST`（`buyAuction`/`placeBid` 同）。公开自售单与定向自售单两种情况都会踩。
- **方案**：治根点放在**客户端**。服务端不动——测试 `server/auctionsvc/test/auction.e2e.test.ts`「designated buyer: listAuctions hides… but seller + designated buyer」明确要求卖家在市场能看到自己的定向单，从服务端剔除会破坏该既定行为，且即便剔除公开自售单，定向自售单仍会留在市场触发同一 400，无法根治。
- **改动**：
  - `client/src/scenes/AuctionScene/list.ts`：all 标签下当 `auc.sellerId === this.cb.myAccountId` 时不再画 Buy/Bid 按钮，改为被动标记「你的挂单」（新增 i18n `auction.yourListing`，zh/en/de 三语）。
  - 顺带修文案 bug：`auction.price`（固定价挂单价格标签）此前被误设成与 `auction.startPrice` 同文「起拍价（金币）/ Starting Price (coins) / Startpreis (Münzen)」，固定价单显示为「起拍价」误导玩家。改为「价格（金币）/ Price (coins) / Preis (Münzen)」。
- **验收**：client `tsc --noEmit` 绿 + `webpack --mode development` 构建成功。真实复现需以卖家身份登录且自己的挂单出现在市场（依赖线上账号数据），本地 dev 无此数据，未做浏览器截图验证。

### 修复：余额不足仍能买走拍卖行商品（2026-07-25）

- **问题**：玩家反馈金币只有 300 多，却买走了标价 1200 的紫装，卖家还真收到了税后 1080 金币——买家没扣钱，物权和卖家收益都正常结算。
- **根因**：`commercial` 服务的内部接口 `/internal/spend`（`server/commercial/src/internalHttp.ts`）无论扣款成功还是余额不足，HTTP 状态码永远是 200，业务结果放在响应体 `{ok, error}` 里（`INSUFFICIENT_FUNDS` 走这条路，见 `server/commercial/src/service/shop.ts` 的 `spend()`）。但 `server/auctionsvc/src/commercialClient.ts` 的 `HttpAuctionCommercialClient.spend()` 只检查了 HTTP 层 `res.ok`（2xx 恒真），从没解析响应体的 `ok` 字段——余额不足时钱包压根没扣款，但调用方以为成功，`buyAuction` 照常往下走完「物权判给买家 + 税后打款给卖家」全流程。同款代码（注释写着从 worldsvc 迁移过来）在 `server/worldsvc/src/commercialClient.ts` 里一模一样，SLG 侧建筑加速/商店购买/世界频道发言/宗门创建/卡牌恢复/领地迁移的花费扣款同样能被绕过。metaserver 的对应客户端（`server/metaserver/src/commercialClient.ts`）写法是对的，规范地解析了 `Body<T>` 再判断 `ok`，可以对照。
- **改动**：`auctionsvc`/`worldsvc` 的 `commercialClient.ts` 的 `spend()` 都补上响应体 `ok` 字段校验，`ok:false` 时抛错（携带 `error`），行为对齐 metaserver 侧的实现。
- **测试**：`server/auctionsvc/test/commercial-client.test.ts`、`server/worldsvc/test/commercial-client.test.ts` 新增单测（canned HTTP 服务器模拟 `/internal/spend` 返回 HTTP 200 + `{ok:false, error:'INSUFFICIENT_FUNDS'}`，断言 `spend()` 必须抛错而非静默成功）——这也是此前两个服务的测试都靠内存假客户端打桩、从未真正跑过 `Http*CommercialClient` 网络解析层的覆盖缺口。另在业务层补上等价断言，锁死「commercial 拒绝扣款 → 不成交」这条不变量本身（不只是 HTTP 客户端解析层）：`server/auctionsvc/test/auction.e2e.test.ts`「buy: insufficient funds (commercial rejects spend) → no sale, listing stays open, nothing delivered」、`server/worldsvc/test/city-buildings.e2e.test.ts`「speedupBuild: insufficient coins (commercial rejects spend) → build stays queued, untouched」。
- **验收**：`auctionsvc`/`worldsvc` 两包 `tsc --noEmit` 全绿；`vitest run` 全量跑过（auctionsvc 53/53，worldsvc 317/317）。纯服务端逻辑改动，无可见渲染变化，未做浏览器截图验证。
- **后续排查（同日）**：应用户要求对全站金币相关流程做了一轮排查，发现多处与本次根因不同、但同属"支付/结算竞态或未校验"性质的问题（`commercial.redeemFate` 并发双扣 + 未捕获的重复键异常、`orderDelivered` 并发双退款、`auctionsvc.cancelAuction` 竞态吞没竞拍者已托管金币、`worldsvc` 多处资源扣费为「读-判断-写」而非原子 `findOneAndUpdate` 守卫导致可并发套利、`metaserver.claimEventReward` 的 `maxClaims` 校验非原子且用随机 orderId 削弱了 commercial 侧幂等兜底）。用户确认后已在同日全部修复，见下条及 `COMMERCIAL_DESIGN.md` §6.5 / `SLG_CITY_DESIGN.md`。

### 修复：`cancelAuction` 竞态可吞没竞拍者已托管金币（2026-07-26）

- **问题**：上条排查发现的后续项之一。`cancelAuction`（`server/auctionsvc/src/auctionService.ts`）「不能取消已有出价的拍卖」这条护栏只在读取时检查了一次（`doc.topBid`），写入时的过滤条件只有 `{_id, status:'open'}`，没有重新校验。时序：卖家读到「无出价」时刻 → 此时另一竞拍者出价成功（`commercial.spend` 已托管其金币，`placeBid` 的原子写把 `topBid`/`rev` 写进文档，但不改 `status`）→ 卖家的取消写入照样命中 `status:'open'` 而成功，物品退给卖家，**竞拍者已托管的金币没有任何退款路径被触发**（`cancelAuction` 本身压根没有退款逻辑）。更狠的情形：若这笔出价是一口价（`buyoutPrice`），`placeBid` 会紧接着调用 `settleAuctionWin` 结算，其自身的原子守卫同样只查 `{status:'open'}`；一旦竞态输给了卖家的取消，会**静默返回**当前（已取消）状态而不抛错、不退款、不发货——竞拍者的钱直接消失，没有邮件、没有 ops 可查的痕迹。
- **改动**：把 `cancelAuction` 写入时的过滤条件从 `{_id, status:'open'}` 加上 `rev: doc.rev`（乐观锁守卫，和 `placeBid`/`settleAuctionWin` 已经在用的模式一致）。任何并发写入（出价 / 购买 / 另一次取消）都会先把 `rev` 推进，卖家的取消写入因 `rev` 不匹配而失败、抛 `AUCTION_CLOSED`，卖家需重新读取（此时会读到带 `topBid` 的最新文档，命中读取时的护栏正确拒绝）。无论出价写入和取消写入谁先谁后，两者现在互斥，不再有中间态让竞拍者的托管金币悬空。
- **测试**：`server/auctionsvc/test/auction.e2e.test.ts`「cancel: a bid landing between read and write must not silently succeed and orphan the bidder's escrow」——拦截 `mongo.collections.auctions.findOne` 在返回读取时快照的同时于底层并发写入一笔出价（模拟竞态窗口），断言修复前会静默"成交"取消并留下悬空 `topBid`，修复后必须 `AUCTION_CLOSED` 且挂单保持 `open`、出价不受影响。
- **验收**：`auctionsvc` `tsc --noEmit` 全绿；`vitest run` 71/71（54 in `auction.e2e.test.ts`）。纯服务端逻辑改动，无可见渲染变化，未做浏览器截图验证。

### 修复：全量 code review 发现的 3 处问题（2026-08-04）

用户要求对 `server/auctionsvc` 做一次全量 code review，发现并修复以下 3 处：

- **`readJson` 大小上限形同虚设**：`httpApi.ts` 的 1MB 请求体上限只 `reject()` 了 promise，从没停止底层 socket——超限后 `'data'` 事件继续触发、`body` 字符串继续无界增长，任何已登录玩家往 `/auction/create`/`/auction/:id/bid` 甩一个持续流式的超大请求体就能把 `auctionsvc` 进程内存吃爆。`worldsvc/src/httpApi.ts`（本文件注释自称"migrated from"的源文件）早已带上这个修复（`rejected` 标志位 + `req.destroy()`），auctionsvc 迁移时漏带。现已原样补齐同款修复。
- **`AUCTION_MAX_LISTINGS`（同时 open 挂单 ≤20）不是原子校验**：`createAuction` 里四条 itemType 分支（material/equipment/card/skin）的开局上限检查都是「先 `countDocuments` 读一次、再在函数末尾 `insertOne`」，中间没有任何原子性——同一账号并发发出多个 `createAuction` 请求时，都能读到同一个未过上限的旧计数，全部通过检查并插入，导致 open 挂单数超过 20。这正是 07-26 那条 `cancelAuction` 竞态修复过的同一类 TOCTOU 问题，只是当时没有覆盖到挂单上限本身。改动：在 `insertOne` 之后追加一次权威 recount（`countDocuments({sellerId,status:'open'})`），一旦发现超过上限就删除刚插入的文档并把已托管的材料/装备/卡牌/皮肤原样退回卖家（新增 `returnEscrowedOnCapReject` 直接退回，不走邮件——同一挂单创建流程内的失败回滚，不是"已成交/已过期"的终态转移）、抛 `AUCTION_LIMIT_REACHED`。为此给 `AuctionMetaClient` 补上 `grantMaterial`（对称于已有的 `deductMaterial`，照抄 `worldsvc/src/metaClient.ts` 已有的同名方法）。极端并发下这个 recount 可能让不止一个请求被误判超限（每个都看到"加上自己之后超了"），但绝不会让任何账号真正突破 20 上限，误判的请求重试即可成功。
- **拍卖模式（`saleMode='auction'`）浏览排序用的是过期的起拍价**：`listAuctions` 的 `.sort({price:1})` 排的是数据库里存的原始 `price` 字段，但该字段在创建后只等于 `startPrice`，`placeBid` 的出价原子写从未更新它（只写 `topBid`/`expireAt`/`rev`）——玩家客户端实际显示的「当前价」是 `docToView` 算出来的 `topBid.amount`（`AUCTION_DESIGN.md` §竞拍客户端集成里也写了客户端读的是这个字段）。一旦某条竞拍单被加价推高，市场列表「按价格排序」就会用它冻结在创建时刻的起拍价参与排序，跟玩家眼睛看到的当前价完全对不上。改动：`placeBid` 的原子 `$set` 里新增 `price: amount`，让存储字段跟出价实时同步；`db.ts` 里 `AuctionDoc.price` 字段注释同步更新。
- **测试**：`server/auctionsvc/test/auction.e2e.test.ts` 新增两例——「listing cap: a concurrent insert landing between the pre-check read and this insert is still caught by the post-insert recheck」（拦截 `countDocuments` 首次调用时在其读取结果返回前于底层插入一条竞争文档，模拟并发竞态，断言修复前会让计数突破 20，修复后必须 `AUCTION_LIMIT_REACHED` 且材料退回、真实 open 计数不超过上限）；「B bid keeps the stored price field in sync with topBid so browse sort reflects the current bid」（两条起拍价分别 6/9 的竞拍单，把便宜的一条加价到 19 后断言存储的 `price` 字段与排序结果都反映 19 而非 6）。另补 `readJson` 导出为可测函数 + 新文件 `server/auctionsvc/test/readjson-size-guard.test.ts`（fake `EventEmitter` 模拟 `IncomingMessage`，断言超过 1MB 后 `destroy()` 恰好调一次、后续 `data`/`end` 不再重复触发或吞掉拒绝、正常小 body 不受影响）——临时改回旧版逐 patch 验证过会失败（`destroy` 断言 0 次调用），确认不是假阳性。
- **验收**：`auctionsvc` `tsc --noEmit` 全绿；`vitest run` 90/90（58 in `auction.e2e.test.ts` + 3 in `readjson-size-guard.test.ts`，新增 5 例）。纯服务端逻辑改动，无可见渲染变化，未做浏览器截图验证。

### 修复：装备强化等级显示"+N"文本、皮肤图标/名称显示错误（2026-08-08）

- **问题一：装备类拍卖条目显示"Foil Cover +3"文本，而不是装备背包里的金色星星图标**。星星画法（`buildIcon('star', ...)` 逐颗定位+按 maxW 缩放拟合的那段循环）此前独立重复实现在四处：`EquipmentScene/base.ts`（`buildLevelStars`，图标版，另有 `itemLabel` 的文字 `★.repeat()` 版）、`CardScene/list.ts`/`feed.ts`/`detail.ts`、`EquipmentScene/assign.ts`（后四处都是卡牌等级星，`Math.max(1, Math.min(9, level))`），拍卖行（`AuctionScene`）则完全没有星星逻辑，只有 `auctionLabel()`/`picker.ts` 里手写的 `+${level}` 字符串拼接。
- **修复**：新增 `render/levelStars.ts` 作为唯一实现——`buildLevelStars(count, maxW, size, gap, color)` 画一行金色星标图标并按 maxW 缩放拟合（含最小缩放兜底 `Math.max(0.01, ...)`，避免 maxW≤0 时缩成 0/负值），`levelStarsText(level, maxLevel)` 输出纯文字 `★.repeat()`（用于嵌在翻译句子/挤不下独立图标行的场景，如出价弹窗标题）。`EquipmentScene/base.ts` 的 `buildLevelStars`/`itemLabel`、`CardScene` 三处、`EquipmentScene/assign.ts` 全部改为调用这个共享实现（消除四份重复代码，行为不变）。`AuctionScene`：`base.ts` 的 `auctionLabel()` 装备分支改为只返回裸名字（不再拼 `+N`），新增 `auctionEquipLevel()`（取装备等级，非装备/无实例返回 0）供 `list.ts` 在名字下方画独立的图标星星行；新增 `auctionLabelText()`（`auctionLabel()` 基础上用 `levelStarsText` 把等级折回文字星星）供挤不下图标行的文字场景用（`bid.ts` 出价弹窗标题、`picker.ts` 的 `selectedItemLabel()`/`buildPickEntries()` 装备分支）。等级为 0 的物品不再显示任何后缀（沿用 `EquipmentScene.itemLabel` 早先"到处印 `+0` 纯噪音"的约定）。
- **问题二：拍卖行"出售物品选择页"（picker）里皮肤类目下，部分条目显示原始 id（如 `skin_c3`/`skin_c1`）而不是皮肤名称，图标也是通用画笔图标而不是皮肤图**。排查发现这**不是渲染逻辑 bug**：涉事测试账号（`tao`，VPS `128.140.41.98` 生产环境）的 `save.inventory.skins` 里混入了 17 个不该存在的 id——6 个已下架的占位皮肤 SKU（`skin_c1~c4`/`skin_r2`/`skin_r3`，`GACHA_DESIGN.md` §"上线皮肤目录" 记录已于 2026-07-02 从 `economy.ts` 删除）+ 11 个本不该出现在 `inventory.skins` 里的装备/材料 defId（`wp_pen`/`ar_leather`/`mat_scrap` 等，疑似早期调试/授予脚本的历史遗留）。`skinDisplayName()`/`SKIN_TARGET_UNIT` 对这些 id 查不到映射，兜底返回原始 id + 通用图标——这个兜底行为本身是对的，只是这个账号刚好命中了它。
- **数据清理**：SSH 到 VPS，`docker exec server-metaserver-1` 跑一次性脚本，把该账号 `saves` collection 文档的 `save.inventory.skins` 从 23 个 id 过滤到只保留当前目录里真实存在的 6 个（`skin_shop_c1`/`skin_shop_r1`/`skin_shop_e1`/`skin_e1`/`skin_e2`/`skin_l1`），移除的 17 个 id 全部核对过并非真正拥有的物品（装备/材料本身在各自的 `equipmentInv`/materials 计数里另有正确记录，不受影响）。先 dry-run 打印 before/after 确认无误，再执行真正的 `updateOne`。
- **客户端防护（问题一未来再发生时能快速定位）**：`skinDefs.ts` 新增 `isKnownSkin(skinId)`——查不到 `SKIN_TARGET_UNIT` 映射时，除返回 `false` 外还通过 `netLog('skinDefs').warn(...)` 记一条日志（进 `net/log.ts` 的客户端日志环形缓冲区，可被 `FEATURE_FLAGS_DESIGN` §9.4 的定向采集远程拉取），同一个 id 只记一次，不会刷屏。`AuctionScene/picker.ts` 的 `listableSkins()` 接入这个校验——库存里任何不在当前皮肤目录里的 id（无论是被下架的占位 SKU 还是本不该出现在这里的其它类 id）都会被过滤掉，永远不会出现在选择页里、也永远不能被拿去挂拍卖。
- **验收**：`tsc --noEmit` 全绿；`npm run build:web` 通过（仅预置的资源体积警告，与本次改动无关）；`vitest run --config vitest.ui.config.ts` 全量 128 个文件 1159 例全绿（`test/ui/auctionPickerDedupe.ui.ts` 新增 2 例覆盖未知皮肤 id 被过滤，另外 2 例装备等级为 0 时的标签断言从 `"Pencil +0 ×3"` 更新为 `"Pencil ×3"`）。VPS 数据清理已在生产环境实际执行（dry-run 核对无误后再写），未做浏览器截图验证（该账号的库存已改变，且改动本身是"能否正确过滤/显示"的逻辑问题，headless 测试已充分覆盖）。

### 修复：角色卡拍卖条目仍显示"Lv.N"文本，漏了同一轮星星化改造（2026-08-08 续）

- **问题**：上一条目只把装备分支接进了共享的 `levelStars.ts`，角色卡分支被漏掉——拍卖行「出售物品选择页」（`picker.ts` 的 `buildPickEntries`/`selectedItemLabel`）、市场列表标题（`base.ts` 的 `auctionLabel`）、市场列表名字下方的星星行（`list.ts`，靠 `auctionEquipLevel()` 取等级，该方法对 `itemType==='card'` 直接短路返回 0）三处角色卡仍手写 `` `${cardName} Lv.${level}` ``，跟角色卡背包/详情弹窗（`CardScene/list.ts`、`detail.ts`，早就用 `buildLevelStars` 画金色星星）不一致（用户报告：拍卖行截图里 "Li Chuang Lv.3" 仍是文字，同页装备条目 "Foil Cover ★★★★★" 已经是星星）。
- **修复**：`auctionEquipLevel()` 更名为 `auctionItemLevel()` 并扩展为同时读装备/角色卡实例的 `level`（材料/皮肤仍返回 0），新增 `auctionItemMaxLevel(auc)` 按 `itemType` 返回对应的 `EQUIP_MAX_LEVEL`/`MAX_CARD_LEVEL` 供星星行/文字星星做 clamp。`auctionLabel()` 的角色卡分支去掉 `Lv.${level}` 后缀，改为裸名字（同装备分支）；`auctionLabelText()` 改用 `auctionItemLevel`/`auctionItemMaxLevel` 对任意实例类型折回文字星星；`list.ts` 市场卡片的星星行改用同一对方法，不再局限于装备。`picker.ts` 的 `selectedItemLabel()` 与 `buildPickEntries()` 的角色卡分支均改为 `levelStarsText(level, MAX_CARD_LEVEL)`，与装备分支写法对称。
- **验收**：`tsc --noEmit` 全绿；`vitest run --config vitest.ui.config.ts` 覆盖 `test/ui/auctionScene.ui.ts`（75 例，含新增的角色卡裸名字/文字星星断言，`auctionEquipLevel`→`auctionItemLevel` 改名同步更新调用点，以及市场卡片 `renderAuctionCell()` 真实渲染层面的角色卡星星行断言——一颗星对应等级 1、三颗对应等级 3、渲染文本里再不出现 `Lv.\d`）、`test/ui/auctionPickerDedupe.ui.ts`（23 例，角色卡分组标签断言从 `"Su Yuan Lv.1 ×4"` 更新为 `"Su Yuan ★ ×4"`）、`auctionBackButtonHitWidth.ui.ts`/`auctionActionBusyLock.ui.ts` 全绿，共 117 例。纯 UI 展示层改动，未额外做浏览器截图验证（该场景需要一个挂有真实角色卡拍卖单的活跃账号 + 完整后端才能复现，headless 测试已直接对 PIXI 对象树断言了本次改动前后的确切文本/星星差异）。

### 创建挂单表单：出售物品字段加倍高度 + 视觉重点显示（2026-08-08）

- **问题**：用户对着挂单表单截图画圈反馈——"Item: Scrap"这一栏应该加倍高度、重点显示，让玩家一眼看出当前要卖的是什么；同时确认手动输入价格时是否统一用了带光标的输入框样式。
- **改动**（`client/src/scenes/AuctionScene/createForm.ts`，`openCreateForm()`）：
  - Item 选择字段（`field`）高度从标准输入行的 `30*SCALE` 翻倍到 `itemFieldH = 60*SCALE`；图标从 `16*SCALE` 放大到 `itemIconSize = 32*SCALE`，与字段高度同比放大；图标/文字改用居中定位（图标按 `(itemFieldH - itemIconSize)/2` 垂直居中，文字 `anchor.set(0, 0.5)` + `field.y + fieldH/2`）取代之前按字段旧高度手调的固定像素偏移，避免放大后错位。
  - 已选中物品时（`selLabel` 非空）额外做"重点显示"：字段底色从中性纸色 `0xfaf9f5` 换成浅蓝强调色 `0xeaf1fb`（`ui.accent` 的浅色调）、边框从 2px 加粗到 3px、文字从 `13*SCALE` 常规体放大到 `17*SCALE` 粗体。未选中时（占位提示"点击选择"）维持原有中性样式不变，避免占位态也跟着"抢眼"。
  - `mh`（弹窗总高度）与 `cy`（后续行起始位置）的计算同步加上多出的 `30*SCALE`——弹窗高度公式里原有的 `(...) * VA` 分组是纵向留白系数（`VA=SCALE*1.2`），字段加高是单独的绝对像素增量，两者不能混在一起乘同一个系数，故作为独立加项累加，避免弹窗要么裁切按钮行要么底部留白过多。
  - 手动输入价格的光标输入框：核查后确认**这部分已经是现状**，未改动——`price`/`startPrice`/`buyout` 三个数值字段在 07-27 那次改动（`7751f4f0` "auction listing form — tap-to-type prices with auto-clamp"）里已经统一接入 `editKey` + `caretDisplay()` 机制（点击变成可输入框、输入中光标 `|` 闪烁、失焦按护栏 clamp），与本次改的 Item 字段、以及既有的"指定买家"字段共用同一套输入框视觉语言（`sketchPanel` 同款 fill/border 配色）。数量（Qty）字段沿用原样不加框——它只有 `-`/`+` 步进、无点击输入诉求，用户反馈原文也只提到"价格"，未涉及数量。
- **验收**：`tsc --noEmit` 绿；`npm run build:web` 通过（仅预置的资源体积警告，与本次改动无关）；`vitest run --config vitest.ui.config.ts` 全量回归绿（含既有 `auctionScene.ui.ts` 覆盖的 `openCreateForm` 系列用例）。未做浏览器截图验证：本次会话 Browser 预览面板未能渲染帧（画布尺寸 0×0），排查后发现根因不是面板本身，而是拍卖行等菜单场景需要登录态 + 一整套跑起来的后端（metaserver 等 11 个服务 + Mongo）才能进入，本次会话未拉起后端，仅有 headless PIXI 单测覆盖（真实场景树、无渲染器）+ 生产构建通过。下次有可用登录环境时应补一次真实截图核对本次的字段放大/配色效果。

### 上一条目补专项测试（2026-08-08 续）

- **问题**：上一条目落地时只靠既有的 `openCreateForm` 通用回归用例兜底，没有为"字段加倍高度 + 选中态视觉重点显示"这条具体改动写专项断言——用户随后要求补测试。
- **改动**：
  - `client/src/scenes/AuctionScene/createForm.ts`：`SCALE` 常量加 `export`，供测试按同一个乘数算期望几何值，不需要在测试里重复硬编码 `1.5`。
  - `client/test/ui/auctionScene.ui.ts`：新增 `describe('AuctionScene — create form item field (doubled height + emphasis)')`，5 个用例：① 高度确实是标准输入行的 2 倍（`60*SCALE`），且它始终是 `modalHits[0]`（物品字段的命中矩形永远最先入队，与 `createClass`/`saleMode` 无关），点击命中矩形真的触发 `openItemPicker()`；② 未选中物品（`equipment` 类 + 无 `getSave` 回调 → `selectedItemLabel()` 为 `null`）时高度依旧加倍，只是视觉样式不同；③ 已选中物品时文字节点的 `style.fontSize`/`style.fontWeight` 分别是加大字号（经 `snapFont()` 吸附后的值，不是裸算的 `17*SCALE`）+ `'bold'`；④ 未选中占位提示的字号/字重则是普通档位（`snapFont(13*SCALE)` + `'normal'`）；⑤ 高度加倍后紧跟着的 Qty 步进器命中矩形的 y 坐标仍然严格在物品字段下方，没有因为这次布局调整而重叠。
  - 新增测试辅助函数 `findTextNode()`（`findLabelPos()` 的姊妹函数，返回节点本身而非仅返回坐标，用于断言 `.style` 而非仅位置）。
  - **踩坑记录**：字号断言最初直接写死 `17 * SCALE`/`13 * SCALE`（25.5/19.5），实际渲染值是 24/20——`txt()` 的字号要过 `snapFont()` 吸附到一套固定字号档位，不是原始像素值；改为用 `snapFont()` 本身计算期望值后通过。
- **验收**：`tsc --noEmit`（含 `tsconfig.test.json`）全绿；`npm run build:web` 通过；`vitest run --config vitest.ui.config.ts` 对 `auctionScene.ui.ts`（80 例，新增 5 例）单独绿，再跑 `auctionScene.ui.ts`/`auctionActionBusyLock.ui.ts`/`auctionPickerDedupe.ui.ts`/`auctionBackButtonHitWidth.ui.ts`/`caretRegression.ui.ts`/`scenes.ui.ts` 六个拍卖/UI 相关文件合计 254 例全绿。纯测试新增，未改变任何渲染行为，不涉及浏览器截图。

### 修复：拍卖行材料名自成一套，与背包/商店对不上（2026-08-15）

- **问题**：用户对着「出售物品选择页」的材料一行截图画圈——"拍卖行里物品的名字是另外一套吗？为何和背包里的名字不一致"。核查确认属实：拍卖行三种材料读的是自己的一组 i18n key `auction.scrap|lead|binding`（中文"废料/铅块/绑线"），而背包（`EquipmentScene`）、商店（`ShopScene`）、抽卡（`GachaScene`）、统计（`StatsScene`）全都读共享的 `material.*`（中文"旧纸片/铅笔芯/装订线"，见 `EQUIPMENT_DESIGN.md` §材料命名定稿）。同一堆材料在两个界面叫两个名字。英文侧 `Scrap` vs `Tatter`、德文侧 `Schrott` vs `Fetzen` 同样对不上；`lead`/`binding` 的英德文恰好撞车，所以只有中文和英文 scrap 一栏能被肉眼看出来。这是拍卖行落地时另起一套 key、没有复用既有材料命名留下的分叉，不是后来改名漏改。
- **改动**：
  - `client/src/scenes/AuctionScene/itemLabels.ts`（`auctionLabel()` 材料分支）、`itemPickerRender.ts`（`selectedItemLabel()` + `buildPickEntries()`）三处改读 `material.${mat}`。
  - `client/src/i18n/locales/{zh,en,de}.ts`：删掉 `auction.scrap`/`auction.lead`/`auction.binding` 三条同义 key（已无任何引用），避免以后又被人捡回去用。
  - `client/test/ui/auctionScene.ui.ts` 两处断言里的 `t('auction.lead')`/`t('auction.scrap')` 同步换成 `material.*`。
- **验收**：`tsc --noEmit` 全绿；新增 `client/test/ui/auctionMaterialNames.ui.ts`（4 例：选择页条目标签、创建表单已选标签、市场列表行 `"<名字> ×qty"`、以及三种语言下 `auction.*` 同义 key 确实已消失——`t()` 对缺失 key 会原样回显，正好用作断言），连同 `auctionScene.ui.ts`/`auctionPickerDedupe.ui.ts` 共 105 例全绿。未做浏览器截图：本次会话没有跑起后端（9090/18086/18080 均无监听），拍卖行需登录态 + 完整后端才能进入；headless UI 测试跑的是真实 PIXI 场景树 + 真实 i18n，已直接断言渲染出的文本。

---

*本文为拍卖行机制权威，DRAFT/⚠️ 处随实现与拍板细化；数值以 `server/shared/src/slg.ts` 为准。*
