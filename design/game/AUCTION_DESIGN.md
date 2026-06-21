# Notebook Wars — 拍卖行设计（Auction House）

> 状态：主干 ✅ + 反 RMT 闸门 C/E/G/F + 竞拍 B + **装备交易 A** 全 ✅；仅 D 异常审计 待依赖（admin G7） · 权威：本文（拍卖行**机制**单一来源） · 更新：2026-06-21
>
> 配套阅读：[`SLG_DESIGN.md`](SLG_DESIGN.md)（§7 经济与交易、§9 架构、§14 契约层——拍卖行是 SLG 大世界的交易子系统）、[`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)（金币钱包 spend/grant，拍卖结算走它）、[`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md)（货币政策/反通胀哲学）、[`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)（数值演算）、[`SERVER_API.md`](SERVER_API.md)（接口契约）、[`OPS_DESIGN.md`](OPS_DESIGN.md)（反 RMT 审计工单复用）。
>
> **本文是从 `SLG_DESIGN §7.1 / §14` 抽出的拍卖行机制权威**：那两节保留指针，结论以本文为准。**数值不在本文定**——常量在 `server/shared/src/slg.ts`（`AUCTION_*`），本文只引用并注 DRAFT。

---

## 0. TL;DR

- **拍卖行 = SLG 大世界唯一交易机制**（SLG9）：单一机制覆盖「公开市场」与「点对点定向交易」（挂单时指定受拍人）。
- **可交易品 = 材料 + 装备（A ✅）**（PvE/SLG 统一养成材料 `scrap/lead/binding` + 锻造装备实例，整件托管转移）；**赛季资源（粮/铁/木）禁挂**（季末清零、防套利、维持 biome 物产差异价值）。
- **计价货币 = 金币（coins，跨季留存的 premium 货币）**；系统抽 **10% 手续费**；**禁止以赛季资源/局内 ink 计价**（防与天梯/付费体系串味）。
- **承重墙**：拍卖行不碰战斗/地图，是纯经济子系统——挂存与发放走 **meta 材料库 + 装备库**（幂等 orderId），扣款/收款走 **commercial 金币钱包**，状态机权威在 **worldsvc `auctions` 集合**。
- **反 RMT 是持续对抗**（R3）：10% 高税 + 并发挂单上限 + 每日限额（C ✅）+ 绑定材料禁挂（E ✅，清单暂空）+ 价格护栏动态滑窗（G ✅）+ 异常模式 admin 审计（D ⛔ 依赖 admin G7）。
- **当前状态**（2026-06-21 实现）：**一口价主干 + 竞拍（B ✅）+ 每日限额（C ✅）+ 绑定禁挂机制（E ✅）+ 价格护栏滑窗（G ✅）+ 季末冻结/清算（F ✅）+ 装备交易（A ✅）全实跑**（worldsvc `auctionService.ts` + 28 条 e2e；装备库存后端 meta `equipment.ts` + 12 条 e2e）；**仅剩 D 异常审计（依赖 admin G7）** 待依赖就位，见 §4。

---

## 1. 定位与边界

| 维度 | 决策 | 来源 |
|---|---|---|
| 唯一交易机制 | 全游戏交易只走拍卖行；无独立「邮寄/转账/摆摊」系统 | SLG9 |
| 点对点交易 | = 挂单时填 `designatedBuyerId`，仅该账号可拍下；无独立转移系统 | SLG9 |
| 可交易品 | 材料（scrap/lead/binding）+ 装备；**赛季资源禁挂** | §7.1 / U1 |
| 计价 | 仅金币 coins（跨季 premium 货币）；禁赛季资源/ink 计价 | U1 / ECONOMY_BALANCE |
| 手续费 | 成交价 10%（coin），系统回收（sink） | U1 |
| 进程归属 | 状态机在 **worldsvc**（公网第四面 `/auction/*`）；扣发金币→commercial；挂发材料→meta | §14.1 P1 |
| 跨大区 | 拍卖行**大区内隔离**（与地图/经济一致）；不跨大区流通 | SLG2 |

**信任边界**：成交全在服务器权威（客户端只读挂单列表 + 发起意图）；价格/库存/扣发全服务器校验，伪造无效（§11 反作弊）。

---

## 2. 交易模型

### 2.1 标的（item）

| itemType | item 载荷 | 挂存（扣） | 发放（给买方） | 状态 |
|---|---|---|---|---|
| `material` | `{material: 'scrap'\|'lead'\|'binding'\|…}` | meta `deductMaterial(seller, mat, qty, orderId)` | meta `grantMaterial(buyer, mat, qty, orderId)` | ✅ 实跑 |
| `equipment` | 挂单入参 `{instanceId}`；存储 `{instance: 完整快照}`（qty 恒 1） | meta `escrowEquipment(seller, instanceId, orderId)`（移出库存回快照） | meta `grantEquipment(buyer, instance, orderId)`（按 id 写入即幂等） | ✅ 实跑（A） |

- **挂单即托管**：挂单时立刻从卖方库存扣除标的（托管在挂单文档里），撤单/过期/未成交时退还卖方——避免「挂着卖但库存已被花掉」的超卖。
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
- **时长**：`AUCTION_DURATIONS_SEC = [6h, 12h, 24h]`（DRAFT）；`expireAt = createAt + durationSec`。
- **过期不走 Mongo TTL**：TTL 自删会在结算前丢掉托管物（U13）→ 故意用**普通索引 `{expireAt:1}` + scheduler 扫描器**（每 2s tick，每批 ≤50 条，原子 `open→expired` + 退还卖方）。`§14.3` 表里「TTL {expireAt}」按此实现期决定改为普通索引。
- **并发**：所有终态转移走 `findOneAndUpdate({status:'open'})` 原子认领 + `rev` 自增，防双花/重复结算。

---

## 4. A–G 缺口设计决策

> 主干（挂/买/撤/过期/材料/金币/税/定向/并发）已实跑（§6）。以下七项是 SLG_DESIGN 承诺但未兑现的，本文给出**建议决策**；标 ⚠️ 的是需你拍板的产品/数值分叉，标 DRAFT 的是上线后调参。

### A. 装备交易 ✅ 已实现（2026-06-21）

> 实现：先建**装备库存后端**（EQUIPMENT_DESIGN E2）解阻塞——meta `equipment.ts`（`craftEquipment` 合成 faucet + `escrowEquipment`/`grantEquipment` 托管转移）+ 内部端点 `/internal/equipment/{escrow,grant}`；worldsvc `auctionService` 接 A 全链路。e2e：meta 12 条 + worldsvc 装备 8 条。

- **挂单入参** `{instanceId}`；服务器 `escrowEquipment` 校验后**移出卖方库存**、回完整实例快照存进挂单 `item.instance`（**qty 强制 1**——装备是非堆叠唯一实例，传 99 也归 1）。
- **托管 = 移出库存**：挂存调 meta `escrowEquipment`（orderId 幂等，账本存快照）；**发放 = 转移实例归属**（成交给买方）；**撤单/过期/季末清算 = 实例退回卖方**——全走 `grantEquipment(account, instance, orderId)`（按 `instance.id` 覆盖写即幂等）。
- **禁挂闸门**（meta escrow 侧拒绝，错误码透传 worldsvc）：`locked`（防误用为燃料）→ `EQUIP_LOCKED`；**穿戴中**（`gear.global`/`gear.byUnit` 引用）→ `EQUIP_IN_USE`；不存在 → `EQUIP_NOT_FOUND`。绑定装备禁挂（`equipBound`）与 E 同源，待经济运营填规则。
- **价格护栏（G）按 `equip:{defId}` 品类**：冷启动静态参考价按稀有度（`EQUIP_AUCTION_REF_PRICE_BY_RARITY`，DRAFT），滑窗样本足后转中位数；越界拒绝（拒绝后退还托管实例，不吞）。
- **满仓口径**：成交转移**不卡 300 库存上限**（买方有意获得，阻断成交会资损；满仓溢出转邮件暂存是 §13 后续）；上限只在 craft/掉落 faucet 侧卡。
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

### C. 每日限额（反搬砖）✅ 已实现（2026-06-21）

> 实现：`auctionDaily` 集合按 `${worldId}:${accountId}:${dayKey}`（UTC 日界）计数，`lists`/`buys` 两计数器，`expiresAt`（Date）TTL 自清（`AUCTION_DAILY_TTL_SEC`）。挂单占 `lists`、购买/出价占 `buys`，先占名额（超限回滚 + 抛 `AUCTION_LIMIT_REACHED`）。上限 `AUCTION_DAILY_LIST_CAP=30` / `AUCTION_DAILY_BUY_CAP=30`（DRAFT）。

- **现状**：只有并发上限 `AUCTION_MAX_LISTINGS=20`（同时 open 的挂单数），无「每日挂单/成交次数」上限。SLG9 明确要每日限额。
- **建议设计**：
  - 复用 `RETENTION_DESIGN` 的 `dayKey`（服务器日界）模式，按账号计数：
    - `AUCTION_DAILY_LIST_CAP`（每日新挂单数上限，DRAFT）
    - `AUCTION_DAILY_BUY_CAP`（每日购买次数上限，DRAFT）
    - 可选 `AUCTION_DAILY_COIN_FLOW_CAP`（每日成交金币总额上限，压大额搬砖，DRAFT）
  - 计数器存 Redis（`auction:day:{dayKey}:{accountId}` HASH，到日界自然过期）或 Mongo `playerWorld` 镜像；超限抛 `AUCTION_LIMIT_REACHED`（错误码已有）。
- **优先级**：中高（反 RMT 第一道量化闸门，工作量小）。

### D. 反 RMT 异常审计

- **现状**：异常交易进 admin 审计未接（§15.1 G7「admin SLG 接入」整体缺失）。
- **建议设计**（复用 OPS 工单 + analyticsvc 埋点）：
  - **成交即埋点**：worldsvc 每笔 `sold` 推一条交易事件到 analyticsvc（seller/buyer/item/price/tax/designated?）。
  - **异常规则**（admin 侧批量扫描或实时规则）：
    - 同一对 seller↔buyer 短期高频成交（疑似对敲洗钱）；
    - 定向挂单 + 远离参考价（疑似 RMT 交付通道）；
    - 单账号短期大额单向金币流出/流入。
  - **命中 → 生成 OPS 审计工单**（复用 S7 补偿/工单基建），人工复核可冻结挂单/标记账号。
  - **失败补发工单**（§2.3）：扣款成功但发放失败的 `sold` 单凭 orderId 自动进工单队列。
- **优先级**：中（依赖 admin SLG 接入 G7；上线前必须有，自由市场必出搬砖 R3）。

### E. 绑定材料禁挂 ✅ 机制已实现（2026-06-21，清单暂空）

> 实现：`createAuction` 校验材料 ∈ `AUCTION_BANNED_MATERIALS`（`shared/slg.ts`，初期空集）→ 抛 `MATERIAL_NOT_TRADEABLE`。机制位就绪，禁挂清单随经济运营填。

- **现状**：所有材料都可挂；SLG9 要「部分绑定材料禁挂」。
- **建议设计**：
  - `shared/slg.ts` 加 `AUCTION_BANNED_MATERIALS: ReadonlySet<string>`（DRAFT，初期可空或放赛季活动专属/账号绑定材料）。
  - `createAuction` 校验：材料 ∈ 禁挂集 → 抛 `BAD_REQUEST`（或新错误码 `MATERIAL_NOT_TRADEABLE`）。
  - 与 A 的「绑定装备禁挂」同源——「绑定」是统一的不可交易标记。
- **优先级**：低（先有机制位，禁挂清单随经济运营填）。

### F. 季末冻结 / 结算 ✅ 已实现（2026-06-21）

> 实现：(1) **冻结**——`createAuction` 校验 `world.status`，`settling`/`closed` 拒新挂单（`WORLD_CLOSED`）；`settleSeason` 置 `settling` 后即自动冻结。买/撤/结拍不受限。(2) **清算**——`/admin/world/reset` 先调 `auctionSvc.clearWorldOnReset`：批量 `open→cancelled` + 退还卖方标的 + 退还竞拍托管出价 + 清空该 world 价格滑窗（新赛季市场重启），再调 `svc.resetSeason` 清地图态。标的（材料/装备）属养成侧退回安全（SLG4）。

- **现状**：§7.3 标 DRAFT；赛季切换（`settleSeason`/`resetSeason`）时拍卖行行为未定。
- **建议设计**（赛季 2 个月，SLG4）：
  1. **结算前 N 小时（DRAFT）冻结新挂单**：worldId `status` 进 `settling` → `createAuction` 拒收（`WORLD_CLOSED`），仅允许买/撤。
  2. **赛季重置时强制清算所有 open 挂单**：批量 `open→cancelled` + 退还卖方标的（材料随养成跨季留存，装备实例跨季留存——退回安全）。
  3. **已成交的金币收益跨季留存**（coins 是跨季货币，卖方所得不清）；税收回的金币消失（sink，无需迁移）。
  - 与 SLG4 重置表一致：领地/兵力/赛季资源清，养成/coins/外观留——拍卖标的（材料/装备）属「养成」侧，退回即可。
- **优先级**：中（首个赛季结算前必须有；MVP 单赛季可暂缓）。

### G. 价格护栏 / 反通胀 ✅ 拍板：动态滑窗 · ✅ 已实现（2026-06-21）

> 实现：每品类（`material:{mat}`）滑窗存近 `AUCTION_PRICE_WINDOW_N=20` 笔成交单价于 `auctionPrices` 集合（`$push $slice`）；`refPrice` = 样本 ≥ `AUCTION_PRICE_WINDOW_MIN_SAMPLES=5` 时取**中位数**（抗极端值），否则回退 `AUCTION_STATIC_REF_PRICE`（scrap=10/lead=30/binding=80，DRAFT），都无则放行（冷启动不误杀）。挂单/出价单价须落 `[refPrice×0.5, refPrice×2.0]`（`AUCTION_PRICE_FLOOR_RATIO/CEIL_RATIO`），越界抛 `PRICE_OUT_OF_RANGE`。滑窗按 worldId 隔离，赛季重置随 `clearWorldOnReset` 清空。

- **现状**：`price > 0` 之外无任何区间限制，可挂任意天价/地板价 → 洗钱（高价定向）/倾销温床。
- **拍板（2026-06-21）：用动态滑窗护栏**（随市场自适应，而非运营手调静态值）。
- **设计**：
  - **每品类（材料种类 / 装备品类）维护近期成交均价**：滑动窗口取近 `PRICE_WINDOW_N` 笔成交（或近 `PRICE_WINDOW_SEC` 时间窗）的成交单价，算参考价 `refPrice`（DRAFT：算术均值或中位数抗极端值）。
  - **挂单/出价校验区间** `[refPrice × PRICE_FLOOR_RATIO, refPrice × PRICE_CEIL_RATIO]`（DRAFT 浮动带，如 ±50%）；越界抛 `PRICE_OUT_OF_RANGE`（新错误码）。
  - **冷启动**：某品类成交样本 < `PRICE_WINDOW_MIN_SAMPLES` 时回退到 ECONOMY_NUMBERS 静态估值区间（无历史不裸奔）。
  - **存储**：每品类滑窗成交价 + `refPrice` 缓存（Redis HASH `auction:price:{worldId}:{category}` 或 worldsvc 内存 + Mongo 兜底），每笔 `sold` 更新窗口。
  - **大区隔离**：refPrice 按 worldId 独立维护（各大区市场独立）。
- **与定向单**：定向受拍单仍受护栏约束（防「高价定向」洗钱通道，与 §4.D 异常审计互补）。
- **优先级**：中高（反洗钱主力；冷启动回退静态值，可先上静态、滑窗增量接）。

---

## 5. 数据模型 / 契约（引用，权威在代码）

### 5.1 Mongo 集合 `auctions`（worldsvc 库 `notebook_wars_world`）

```
_id: auctionId(worldId, sellerId, ts, seq)   // 进程内 seq 防同毫秒撞键
worldId, sellerId, itemType, item, qty, price, currency('coins'),
designatedBuyerId?, expireAt(ms), status, buyerId?, rev
```

索引（`db.ts ensureIndexes`，**实跑**）：
- `{worldId, itemType, status}` — 浏览挂单
- `{sellerId}` — 我的挂单
- `{designatedBuyerId}` — 定向收件
- `{expireAt}` — **普通索引（非 TTL，故意）**，过期扫描器用

### 5.2 REST 端点（worldsvc 公网第四面 `/auction/*`，已实跑）

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

- 常量（DRAFT，均已落 `shared/slg.ts`）：`AUCTION_TAX_RATE=0.1`、`AUCTION_MAX_LISTINGS=20`、`AUCTION_DURATIONS_SEC=[6h,12h,24h]`；**C** `AUCTION_DAILY_LIST_CAP=30`/`AUCTION_DAILY_BUY_CAP=30`/`AUCTION_DAILY_TTL_SEC`；**E** `AUCTION_BANNED_MATERIALS`（空集）；**B** `AUCTION_MIN_INCREMENT_RATIO=0.05`/`AUCTION_ANTI_SNIPE_WINDOW_SEC=5min`；**G** `AUCTION_PRICE_WINDOW_N=20`/`AUCTION_PRICE_WINDOW_MIN_SAMPLES=5`/`AUCTION_PRICE_FLOOR_RATIO=0.5`/`AUCTION_PRICE_CEIL_RATIO=2.0`/`AUCTION_STATIC_REF_PRICE`。
- 错误码（均已落 `shared/api.ts`）：`AUCTION_NOT_FOUND`、`AUCTION_CLOSED`、`NOT_DESIGNATED_BUYER`、`AUCTION_LIMIT_REACHED`、`NO_PERMISSION`、`INSUFFICIENT_RESOURCES`、`NOT_IMPLEMENTED`、`BAD_REQUEST`、`WORLD_CLOSED`（F）、`PRICE_OUT_OF_RANGE`（G）、`MATERIAL_NOT_TRADEABLE`（E）、`BID_TOO_LOW`（B）。
- 新增集合：`auctionDaily`（C，TTL `{expiresAt}`）、`auctionPrices`（G，`_id=worldId:category`）；`auctions` 加 `saleMode/startPrice/buyoutPrice/topBid`（B）。

---

## 6. 实现状态（S8-5）

**✅ 已实跑**（`server/worldsvc/src/auctionService.ts` + `test/auction.e2e.test.ts` 28 条全绿 + 142 条 worldsvc 全绿；装备库存后端 meta `equipment.ts` + `test/equipment.e2e.test.ts` 12 条 + 167 条 metaserver 全绿）：
- 挂单 / 我的挂单 / 一口价购买 / 撤单 / 过期回收全套 CRUD
- 材料交易（meta deduct/grant 托管+发放，orderId 幂等）
- 金币计价 + 10% 税（commercial spend/grant）
- 指定受拍人（定向交易）
- 并发安全（原子状态转移 + rev + 买方失败退款）
- 过期扫描器（scheduler 每 2s，非 TTL，退还卖方挂存 / 竞拍结拍）
- 挂单上限 20、时长 [6h/12h/24h]
- **C 每日限额**（auctionDaily TTL 计数）/ **E 绑定禁挂机制**（空清单）/ **G 价格护栏动态滑窗**（中位数 + 静态回退）/ **F 季末冻结+清算**（settling 拒挂 + clearWorldOnReset）/ **B 竞拍**（起拍/加价/托管/防狙击/买断/结拍）
- **A 装备交易**（2026-06-21）：先建装备库存后端（meta `equipment.ts`：`craftEquipment` 合成 + `escrowEquipment`/`grantEquipment` 托管转移 + `/internal/equipment/{escrow,grant}` + 玩家 `POST /equipment/craft`）→ worldsvc `auctionService` 装备分支（挂/买/竞拍结拍/撤/过期/季末退回全转移实例；按 `equip:{defId}` 稀有度价格护栏；穿戴中/locked 禁挂）。新增 `equipmentIdem` 集合（合成/托管幂等）。
- 契约同步：`openapi-world.yml` + 客户端 `openapi-world.ts`/`WorldApiClient`（createAuction saleMode/placeBid）；meta `openapi.yml` 新增 `/equipment/craft`。

**⛔ 剩余缺口**：**D 异常审计**（依赖 §15.1 G7 admin SLG 接入）。
**客户端契约对齐 ✅（2026-06-21）**：`AuctionScene` 既存错配已修——挂单 item 改发 `{material}`（原 `{mat}` 服务端读不到）、展示改读 `item.material`（原把 itemType 当材料名）、时长改 `[6h/12h/24h]` 对齐 `AUCTION_DURATIONS_SEC`（原 `[1h/4h/24h]` 2/3 选项触 BAD_REQUEST），i18n `dur1h/dur4h`→`dur6h/dur12h`。一口价挂单/展示链路打通。**竞拍 UI（saleMode 切换/出价/买断）仍待补**——API/契约已就绪（`createAuction` saleMode + `placeBid`）。

---

## 7. 反 RMT 总览（持续对抗 R3）

| 闸门 | 机制 | 状态 |
|---|---|---|
| 高税 | 10% 成交手续费（coin sink） | ✅ |
| 并发上限 | 同时 open 挂单 ≤20 | ✅ |
| 每日限额 | 日挂单/购买（含出价）次数上限 | ✅ C |
| 绑定禁挂 | 账号绑定材料/装备不可交易（清单暂空）；装备 locked/穿戴中拒挂 | ✅ E（机制）+ A |
| 价格护栏 | 单价限定动态滑窗参考区间（中位数 + 静态回退），封天价洗钱；装备按 defId/稀有度品类 | ✅ G + A |
| 异常审计 | 对敲/定向异价/大额单向 → OPS 工单 | ⛔ D（依赖 admin G7） |
| 货币隔离 | 仅 coin 计价，禁赛季资源/ink，防体系串味 | ✅ |
| 服务器权威 | 库存/扣发/状态全服务器，客户端只读 | ✅ |

---

## 8. 开放问题

> **无剩余机制级开放问题（2026-06-21 复核）**：B（竞拍=做）/ G（价格护栏=动态滑窗、中位数+近20笔）均已拍板，见 §4。以下全部降为**实现期调参/时序依赖**，不需产品再拍。

- **DRAFT 数值**：每日限额、竞拍最小加价/防狙击窗口、滑窗护栏（窗口大小/浮动带/最小样本）、绑定材料清单、季末冻结提前量——上线后随经济运营调参（数值落 `shared/slg.ts`，演算去 ECONOMY_NUMBERS）。
- ~~**G 算法**：refPrice 用均值还是中位数、滑窗按笔数还是时间~~——已定：**中位数 + 按笔数（近 20 笔）**。
- ~~**A 时序**：装备交易依赖 EQUIPMENT_DESIGN 库存系统落地节奏。~~——已实现（2026-06-21）：随本切片把装备库存后端 E2（合成 + 托管转移）一并建好。装备的**深度养成**（E3 强化/分解、E4 穿戴、E5 UI、关卡掉落 faucet）仍待做，但不阻塞拍卖交易闭环。
- **D 时序**：异常审计依赖 §15.1 G7「admin SLG 接入」。

---

*本文为拍卖行机制权威，DRAFT/⚠️ 处随实现与拍板细化；数值以 `server/shared/src/slg.ts` 为准。*
