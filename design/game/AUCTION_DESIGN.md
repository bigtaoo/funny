# Notebook Wars — 拍卖行设计（Auction House）

> 状态：主干 ✅ + 反 RMT 闸门 C/E/G + 竞拍 B + **装备交易 A** + **异常审计 D（admin G7 已接）** 全 ✅；**双入口（大厅 + SLG 世界地图）已接**；**去 SLG/worldId 耦合 + 独立 auctionsvc 拆分中（见 §9，2026-07-06 拍板；任务1-4 已完成——业务逻辑已在 `auctionsvc` 落地并与 worldsvc 并存，任务5 接入部署后才切流量）** · 权威：本文（拍卖行**机制**单一来源） · 更新：2026-07-06
>
> 配套阅读：[`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)（金币钱包 spend/grant，拍卖结算走它）、[`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md)（货币政策/反通胀哲学）、[`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)（数值演算）、[`SERVER_API.md`](SERVER_API.md)（接口契约）、[`OPS_DESIGN.md`](OPS_DESIGN.md)（反 RMT 审计工单复用）、[`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md)/[`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)（装备/角色卡实例定义）、[`SLG_DESIGN.md`](SLG_DESIGN.md)（仅材料 `scrap/lead/binding` 的产出侧定义共享，拍卖机制本身与 SLG 世界/赛季生命周期无关，见 §9 拍板说明）。
>
> **本文是拍卖行机制权威**：数值不在本文定——常量在 `server/shared/src/slg.ts`（`AUCTION_*`），本文只引用并注 DRAFT。

---

## 0. TL;DR

- **拍卖行 = 和角色卡/装备/材料/皮肤四类养成物品绑定的大区内全服市场**：与 SLG 的 worldId/赛季生命周期无关（2026-07-06 拍板定稿，详见 §9），单一机制覆盖「公开市场」与「点对点定向交易」（挂单时指定受拍人）。
- **可交易品 = 材料 + 装备（A ✅）+ 角色卡（CC-5 ✅）+ 皮肤（meta 托管能力 ✅ 已实现，`itemType='skin'` 拍卖流程已在 auctionsvc 接入，见 §9 任务4）**（PvE/SLG 统一养成材料 `scrap/lead/binding` + 锻造装备实例/角色卡实例/皮肤，整件托管转移）；**SLG 赛季资源（粮/铁/木）本就不在拍卖标的范围内**（那是大世界内政资源，随赛季重置，从未支持挂拍）。
- **计价货币 = 金币（coins，跨季留存的 premium 货币）**；系统抽 **10% 手续费**；**禁止以赛季资源/局内 ink 计价**（防与天梯/付费体系串味）。
- **承重墙**：拍卖行不碰战斗/地图，是纯经济子系统——挂存与发放走 **meta 材料库 + 装备库 + 角色卡库（+ 皮肤库，待建）**（幂等 orderId），扣款/收款走 **commercial 金币钱包**，状态机权威**目前**在 worldsvc `auctions` 集合，**拆分完成后**迁至独立服务 `auctionsvc`（见 §9）。
- **反 RMT 是持续对抗**（R3）：10% 高税 + 并发挂单上限 + 每日限额（C ✅）+ 绑定材料禁挂（E ✅，清单暂空）+ 价格护栏动态滑窗（G ✅）+ 异常模式 admin 审计（D ✅ admin G7 已接，pull 式扫描）。
- **当前状态**（2026-07-06 复核）：**A/B/C/D/E/G 六轨道全实跑** + 一口价主干（worldsvc `auctionService.ts` + e2e；装备库存后端 meta `equipment.ts`；异常审计 admin `service.ts`）；**客户端双入口已接**（大厅右侧功能条 + SLG 世界地图工具栏，均通向 `AuctionScene`，见 §6）；**F（原"季末冻结/结算"）已废弃**，拍卖单只按自身 72h 到期正常流转，不受任何赛季事件影响；**去耦合拆分（§9）代码尚未开工**，当前实现仍挂靠 worldsvc、按 worldId 隔离，本文档已按目标架构定稿，实现落后于文档属预期状态（见 §9 各任务勾选进度）。

---

## 1. 定位与边界

> **2026-07-06 拍板定位**：拍卖行不是「SLG 大世界的交易子系统」，而是和角色卡/装备/材料/皮肤四类**养成物品**绑定的**全服（大区内）市场**，性质上和 matchsvc 一样是全服行为，与 SLG 的 worldId/赛季生命周期无关。此前文档里"按 worldId 隔离""随赛季结算清算"等表述均属误定位，已随本次改写作废（详见 §9 拆分任务清单）。

| 维度 | 决策 | 来源 |
|---|---|---|
| 唯一交易机制 | 全游戏交易只走拍卖行；无独立「邮寄/转账/摆摊」系统 | 拍板 |
| 点对点交易 | = 挂单时填 `designatedBuyerId`，仅该账号可拍下；无独立转移系统 | 拍板 |
| 可交易品 | 材料（scrap/lead/binding）+ 装备 + 角色卡 + 皮肤（拍卖流程已在 auctionsvc 接入，见 §2.1/§9 任务4）；**SLG 赛季资源（粮/铁/木）从不在拍卖标的范围** | §2.1 |
| 计价 | 仅金币 coins（跨季 premium 货币）；禁赛季资源/ink 计价 | ECONOMY_BALANCE |
| 手续费 | 成交价 10%（coin），系统回收（sink） | 拍板 |
| 进程归属 | 拍卖是**独立服务 `auctionsvc`**（meta 层，全服单实例，欧美/中国各自部署一份）；扣发金币→commercial；挂发材料/装备/角色卡/皮肤→meta。**当前实现仍挂靠 worldsvc，迁移中，见 §9 任务3/4** | 2026-07-06 拍板 |
| 大区范围 | 拍卖是**大区内全服市场**：与 worldId/SLG shard 无关，同一大区所有玩家自由流通，不跨大区；中国区是完全独立部署栈，物理隔离不属于本文档讨论范围（架构设计只需覆盖西方大区） | 2026-07-06 拍板 |

**信任边界**：成交全在服务器权威（客户端只读挂单列表 + 发起意图）；价格/库存/扣发全服务器校验，伪造无效（§11 反作弊）。

> **皮肤交易**：metaserver 托管能力（`escrowSkin`/`grantSkin`）已实现（2026-07-06，§9 任务2）；`auctionsvc` 的 `auctionService` 已接入 `itemType='skin'` 分支（§9 任务4，2026-07-06），worldsvc 旧实现未接入（不再补，随 §9 任务6 一并下线）。

---

## 2. 交易模型

### 2.1 标的（item）

| itemType | item 载荷 | 挂存（扣） | 发放（给买方 / 退卖方，均经系统邮件） | 状态 |
|---|---|---|---|---|
| `material` | `{material: 'scrap'\|'lead'\|'binding'\|…}` | meta `deductMaterial(seller, mat, qty, orderId)` | 系统邮件附件 `{kind:'material', id, count}` | ✅ 实跑 |
| `equipment` | 挂单入参 `{instanceId}`；存储 `{instance: 完整快照}`（qty 恒 1） | meta `escrowEquipment(seller, instanceId, orderId)`（移出库存回快照） | 系统邮件附件 `{kind:'equipment', instance}`（领取按 id 写回 `equipmentInv`） | ✅ 实跑（A） |
| `card` | 挂单入参 `{instanceId}`；存储 `{instance: 完整快照}`（qty 恒 1） | meta `escrowCard(seller, instanceId, orderId)`（校验 gear 全空后移出 cardInv） | 系统邮件附件 `{kind:'card', instance}`（领取按 id 写回 `cardInv`） | ✅ 实跑（CC-5） |
| `skin` | 挂单入参 `{skinId}`；存储 `{skinId}`（qty 恒 1，皮肤无等级/词条，无需实例快照） | meta `escrowSkin(seller, skinId, orderId)`（校验拥有且未装备中后 `$pull` 摘除） | 系统邮件附件 `{kind:'skin', skinId}`（领取按 id `$addToSet` 写回 `inventory.skins`） | meta 托管能力 ✅ 已实现（2026-07-06，§9 任务2）；auctionsvc 拍卖流程 ✅ 已接入（2026-07-06，§9 任务4） |

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
  ├─ 2. 原子 findOneAndUpdate {status:open}→sold            防并发重复购买；抢失败→退买方款
  ├─ 3. meta.grantMaterial(buyer, …, `${orderId}:item`)     发标的给买方
  └─ 4. commercial.grant(seller, sellerReceives, `…:seller`) 卖方收款（税后）
```

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

---

## 4. A–G 缺口设计决策

> 主干（挂/买/撤/过期/材料/金币/税/定向/并发）已实跑（§6）。以下各项本文给出**建议决策**；标 ⚠️ 的是需你拍板的产品/数值分叉，标 DRAFT 的是上线后调参。**F（原"季末冻结/结算"）已于 2026-07-06 整节废弃**，见 §9 拍板背景——拍卖与 SLG 赛季生命周期无关，不受任何赛季事件影响。

### A. 装备交易 ✅ 已实现（2026-06-21）

> 实现：先建**装备库存后端**（EQUIPMENT_DESIGN E2）解阻塞——meta `equipment.ts`（`craftEquipment` 合成 faucet + `escrowEquipment`/`grantEquipment` 托管转移）+ 内部端点 `/internal/equipment/{escrow,grant}`；worldsvc `auctionService` 接 A 全链路。e2e：meta 12 条 + worldsvc 装备 8 条。

- **挂单入参** `{instanceId}`；服务器 `escrowEquipment` 校验后**移出卖方库存**、回完整实例快照存进挂单 `item.instance`（**qty 强制 1**——装备是非堆叠唯一实例，传 99 也归 1）。
- **托管 = 移出库存；发放/退回 = 经系统邮件**：挂存调 meta `escrowEquipment`（orderId 幂等，账本存快照）；成交给买方、撤单/过期/季末清算退回卖方，**均由 worldsvc `deliverItem` 发系统邮件**（附件携带完整实例快照），收件人领取时 metaserver 按 `instance.id` 写回 `equipmentInv`（覆盖写即幂等）。
- **禁挂闸门**（meta escrow 侧拒绝，错误码透传 worldsvc）：`locked`（防误用为燃料）→ `EQUIP_LOCKED`；**穿戴中**（`gear.global`/`gear.byUnit` 引用）→ `EQUIP_IN_USE`；不存在 → `EQUIP_NOT_FOUND`。绑定装备禁挂（`equipBound`）与 E 同源，待经济运营填规则。
- **价格护栏（G）按 `equip:{defId}` 品类**：冷启动静态参考价按稀有度（`EQUIP_AUCTION_REF_PRICE_BY_RARITY`，DRAFT），滑窗样本足后转中位数；越界拒绝（拒绝后退还托管实例，不吞）。
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
  - **worldsvc**：`auctionService.ts` `scanAnomalies(worldId, windowSec)`（只读，不改状态），底层 `detectAuctionAnomalies`（`@nw/shared`）在 `AUDIT_WINDOW_SEC` 窗口内聚合可疑 seller→buyer 对。
  - **admin**：`clients.ts` `listAuctionAnomalies()` 拉 worldsvc 结果 → `service.ts` `slgScanAnomalies()`（capability `slg.audit.view`）→ `httpApi.ts` 暴露给 ops 后台；worldsvc 不可达时优雅返回空。测试 `server/admin/test/season-audit.e2e.test.ts`。
  - **ops 后台**：审计页展示异常队列，人工复核（对敲/定向异价/大额单向）。
- **命中规则**：同一对 seller↔buyer 短期高频成交（对敲洗钱）；定向挂单 + 远离参考价（RMT 交付通道）；单账号短期大额单向流出/流入。
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

### 5.1 Mongo 集合 `auctions`（auctionsvc 独立库 `notebook_wars_auction` ✅ 已落地，§9 任务4；**worldsvc 库 `notebook_wars_world` 的旧集合仍并行存在，随 §9 任务6 worldsvc 瘦身一并下线**）

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

### 5.2 REST 端点（独立服务 `auctionsvc` `/auction/*`，端口 18086，✅ 已落地；**worldsvc 公网第四面的旧路由仍并行存在，尚未切流量，见 §9 任务5/6**）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/auction/list?itemType&limit` | 浏览 open 挂单（按 price 升序，limit ≤50） |
| GET | `/auction/mine` | 我的挂单（全状态，≤20） |
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
- **C 每日限额**（auctionDaily TTL 计数）/ **E 绑定禁挂机制**（空清单）/ **G 价格护栏动态滑窗**（中位数 + 静态回退）/ **F 季末冻结+清算**（settling 拒挂 + clearWorldOnReset）/ **B 竞拍**（起拍/加价/托管/防狙击/买断/结拍）
- **A 装备交易**（2026-06-21）：先建装备库存后端（meta `equipment.ts`：`craftEquipment` 合成 + `escrowEquipment`/`grantEquipment` 托管转移 + `/internal/equipment/{escrow,grant}` + 玩家 `POST /equipment/craft`）→ worldsvc `auctionService` 装备分支（挂/买/竞拍结拍/撤/过期/季末退回全转移实例；按 `equip:{defId}` 稀有度价格护栏；穿戴中/locked 禁挂）。新增 `equipmentIdem` 集合（合成/托管幂等）。
- 契约同步：`openapi-world.yml` + 客户端 `openapi-world.ts`/`WorldApiClient`（createAuction saleMode/placeBid）；meta `openapi.yml` 新增 `/equipment/craft`。

**D 异常审计 ✅（2026-07-02 复核）**：admin G7 已接，pull 式离线扫描（worldsvc `scanAnomalies` → admin `listAuctionAnomalies` → ops 审计页），见 §4.D。

**客户端入口 ✅ 双入口（2026-07-02）**：拍卖行属 meta 系统，要求大厅 + SLG 双入口，现已齐备，均通向 `client/src/scenes/AuctionScene.ts`。
- **SLG 世界地图**：`WorldMapScene` 工具栏「拍卖」按钮 → `onOpenAuction` → `createAppCore.goAuctionHouse(worldApi, worldId)`（onBack 回世界地图）。
- **大厅**：`LobbyScene` 右侧功能条新增「拍卖」格（online-only，`onOpenAuction`）→ `createAppCore.goAuctionFromLobby()`。市场为**赛季全局**（无需建基地），故入口先经 `resolveWorldShard` 解析当前赛季 shard（与世界地图入口共用该 helper，3s 超时回退 shard 0），再开 `AuctionScene`（onBack 回大厅）；首次进入复用 `guide.auction.*` 功能引导。

**客户端契约对齐 ✅（2026-06-21）**：`AuctionScene` 既存错配已修——挂单 item 改发 `{material}`（原 `{mat}` 服务端读不到）、展示改读 `item.material`（原把 itemType 当材料名）、时长改 `[6h/12h/24h]` 对齐 `AUCTION_DURATIONS_SEC`（原 `[1h/4h/24h]` 2/3 选项触 BAD_REQUEST），i18n `dur1h/dur4h`→`dur6h/dur12h`。一口价挂单/展示链路打通。

**客户端竞拍 UI ✅（2026-06-21）**：`AuctionScene` 接入竞拍全链路，B 功能端到端打通。
- **挂单表单**：加售卖方式切换（一口价/竞拍）——竞拍模式下 `price` 输入替换为 `startPrice`（起拍）+ 可选 `buyoutPrice`（买断，0=无）；表单改顺序游标布局 + 按模式动态算高度（多一行价格）。`doCreate` 按模式分发 `createAuction({saleMode:'auction', startPrice, buyoutPrice?})`。
- **市场列表**：竞拍行显示 `[竞拍]` 标记 + 当前出价（`auc.price`，无出价回退起拍价）+ 买断价行；操作按钮一口价=「购买」、竞拍=「出价」。
- **出价弹层**：`openBidForm` 显示标的/当前价/买断价 + 数字步进器（默认最低出价：有出价则 `max(price+1, ceil(price×1.05))`，服务端权威校验加价）→ `confirmBid` 二次确认 → `placeBid`。
- **错误码映射**：`errorMsg` 补 `BID_TOO_LOW`/`PRICE_OUT_OF_RANGE`/`MATERIAL_NOT_TRADEABLE`/`WORLD_CLOSED`/`EQUIP_LOCKED`/`EQUIP_IN_USE`/`AUCTION_NOT_FOUND`/`NO_PERMISSION`/`INSUFFICIENT_RESOURCES`。i18n 三语补 ~20 键。
- **遗留**：装备挂单 UI（item type 选择装备实例）仍待 E5；竞拍单有出价时撤单按钮仍显示，点击由服务端拒绝（toast 提示）。验证：client `tsc --noEmit` + webpack 生产构建全绿。

**客户端装备 / 角色卡挂单 UI ✅（E5 + CC-5，2026-07-02）**：`AuctionScene` 挂单表单支持三类标的（材料 / 装备实例 / 角色卡），装备/角色卡挂单闭环打通（后端 `escrowEquipment`/`escrowCard` 早已就绪，本切片只补客户端 UI + `createAuction` 加 `'card'` itemType）。
- **类别选择器**：创建表单顶部加 `material/equipment/card` 三选一（`ITEM_CLASSES`）；装备/角色卡两类需 `getSave` 回调读库存（未注入时——如 UI 测试——仅提供材料档，两格灰显）。
- **实例选择器**：装备/角色卡档不显示材料按钮与数量（唯一实例，qty 服务端强制 1），改显「已选实例」字段；点击进入**场景级 picker 覆盖层**（`pickerKind`，复用列表拖拽滚动），选中回创建表单。可挂过滤镜像服务端 escrow 守卫——装备排除已锁定 + 已被任意角色卡穿戴；角色卡要求 gear 全空（锁定卡仍可挂，picker 标 🔒）。
- **挂单流转**：`doCreate` 按类别分发 `createAuction(itemType, {instanceId})`；装备/角色卡成交后 escrow 已从 meta save 移除该实例，故 `reloadSave()`（`saveManager.refresh()`）重拉权威 save 使 picker 不再列出该件。
- **市场/我的/出价展示**：`auctionLabel(auc)` 按 `itemType` 读 `item.instance` 快照渲染名（装备 `equip.<defId>.name +lv`、角色卡 `card.<defId>.name Lv.n`、材料沿用 `×qty`）；市场筛选条加 `card` 档。
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
- **遗留（不阻塞验收，留给后续任务）**：admin 的异常审计客户端尚未指向 auctionsvc（等任务5 部署落地后，admin 也需要新增 `NW_AUCTION_INTERNAL_URL` 之类的环境变量并切换调用目标——这不在任务4/5 的"主要文件"清单里，任务5 执行时需一并处理，否则 G7 审计会一直读 worldsvc 的旧数据）；client 端 `WorldApiClient`/`AuctionScene` 仍打 worldsvc（任务7 范围，符合"先双跑验证对等，再切流量"的既定顺序）。
- **验收**：`npm run build` + `npm run typecheck --workspace @nw/auctionsvc` 全绿；`npm test --workspace @nw/auctionsvc`（37 例，3 文件）全绿；`npm test --workspace @nw/worldsvc`（221 例）/`npm test --workspace @nw/metaserver`（513 例）/`npm test --workspace @nw/shared`（535 例）无回归；此时 worldsvc 和 auctionsvc 的 `/auction/*` **同时存在**，验证了新服务功能对等，下一步（任务5）再切流量。

### 拍卖任务5：接入部署（Caddy + compose + CI）

- [ ] **依赖**：任务4 验收通过。
- **主要文件**：`server/Caddyfile`、本地/prod/cloud 三份 `docker-compose*.yml`（[[project_social_system]] 提过新进程要三处同步）、`.github/workflows/server-deploy.yml`。
- **改动范围**：`Caddyfile` 的 `handle /auction* { reverse_proxy worldsvc:18084 }` 改成 `reverse_proxy auctionsvc:18086`；三份 compose 加 auctionsvc 服务块（含 `NW_META_INTERNAL_URL`/`NW_COMM_INTERNAL_URL`/`NW_INTERNAL_KEY` 等环境变量，照抄 worldsvc 现有配法）；CI 部署脚本加 auctionsvc 的 build/push/deploy 步骤。
- **验收**：VPS 上 `docker ps` 能看到 auctionsvc 容器且健康；实际调用 `/auction/create` 走到新服务（可查 auctionsvc 日志确认，不再查 worldsvc 日志）。

### 拍卖任务6：worldsvc 瘦身

- [ ] **依赖**：任务5 上线且稳定运行一段时间（**不要在切流量当天就删旧代码**，留几天观察期方便回滚）。
- **主要文件**：`server/worldsvc/src/auctionService.ts`（删除）、`server/worldsvc/src/httpApi.ts`（删 `/auction/*` 路由块）、`server/worldsvc/src/metaClient.ts`/`commercialClient.ts`（删只给拍卖用的方法）、`server/worldsvc/test/auction*.e2e.test.ts`（删，已迁到任务4）、`world.status` 相关的 `settling` 拍卖专用分支。
- **验收**：worldsvc 全测试绿；`grep -rn auction server/worldsvc/src` 应无命中。

### 拍卖任务7：client 端清理

- [ ] **依赖**：任务5 上线（client 改动和后端切流量应在同一次发布，避免旧客户端 + 新后端的过渡期兼容问题——反代路径不变，理论上无兼容问题，但 `worldId` 参数被服务端忽略时行为需确认）。
- **主要文件**：`client/src/net/WorldApiClient.ts`（拍卖相关方法去掉 `worldId` 入参）、`client/src/scenes/AuctionScene/*`（`resolveWorldShard` 前置解析逻辑整段删除——大厅/SLG 双入口都不再需要先解析 shard 才能开拍卖行，直接进）。
- **验收**：`tsc --noEmit` + webpack 构建绿；大厅入口和 SLG 世界地图入口都能直接打开拍卖行（无需先进大世界）。

---

*本文为拍卖行机制权威，DRAFT/⚠️ 处随实现与拍板细化；数值以 `server/shared/src/slg.ts` 为准。*
