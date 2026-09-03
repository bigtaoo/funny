# Notebook Wars — commercial 商业服务设计文档

> 创建：2026-06-14。本文件是**第 6 个服务 `commercial`**（钱包 / 充值 / 消费 / 盲盒 RNG / 流水）的设计基准。
> 配套：`META_DESIGN.md`（总架构，§1.1/§6.1 拓扑已扩为 6 组件）、`SERVER_API.md`（§9 commercial 内部契约）、`ECONOMY_BALANCE.md`（数值）、`ACCOUNT_DESIGN.md`（账号）。
> 状态：✅ **已实现（2026-06-14，S5-1~6）**。`server/commercial` 独立进程 + 专属库；meta 编排；钱包权威迁出 meta saves。验证：`tsc -b` 六包 + commercial 20 / meta 37 测试 + client tsc/128 测试 / web 构建全绿。任务编号见 `META_TASKS.md` S5-*。
>
> **实现偏离/暂缓（与本设计的差异）**：
> 1. **内部端点用 node:http**（非 fastify，对齐 matchsvc），业务错误以 HTTP 200 + `{ok:false,error}` 返回供 meta 映射。
> 2. **重复转化（退币/碎片）S5 暂缓**：§4.3 退币额「待定」+ 碎片落在客户端同步段 `materials`（权威冲突）+ 补发重算 dupe 非幂等。S5 只幂等发新皮肤（`SaveData.deliveredOrders` $addToSet 去重）；退币通道在 commercial `orderDelivered(refundCoins)` 已备，待决策可持久化后接。`DUPE_REFUND_COINS`（shared/economy.ts）已统一退币（common/rare 小额占位）。
> 3. **充值平台验签：四平台验签已落地**（S4-1，2026-06-22，见 §9/§10）；早期 dev 桩（`receipt` 形如 `tier:<tierId>`，如 `tier:t499`，按档发币）仅保留作本地/测试回退。（状态标签校正 2026-07-07）
> 4. **对账**目前仅 `GET /save` 顺带（拉 commercial `orders/undelivered` 补发）；兜底定时扫描待办。
> 5. **新增 `GET /internal/orders/undelivered`**（对账拉单）+ `order/delivered` 加 `refundCoins`，已登记 `SERVER_API §9`。
> 6. **catalog 单一来源 `shared/src/economy.ts`**（商品/盲盒池/权重/退币/广告/IAP 档），meta 列表 + commercial RNG 共用，避免漂移。
> 7. **`SaveData.deliveredOrders` 改为封顶 200 条（2026-07-26 卡顿排查）**：该字段本意是幂等发货记录（§2 提到的 `$addToSet` 去重），但全代码库排查后确认**没有任何地方读它做判断**——真正的幂等保护是 commercial `orders` 集合的 orderId 唯一键 / meta `equipmentIdem`。无限增长的 `$addToSet` 让长期测试的重度账号这个数组堆到 900+ 条，单账号存档文档涨到 81KB，在 Atlas M0 这种共享/带宽受限的免费档上，每次读写这条存档（几乎所有玩法操作都会触发）多花约 1 秒。改为 `$push` + `$slice:-200`（`deliverGrant`/`deliverMailGrant`，`server/metaserver/src/economy.ts`），只保留最近 200 条，牺牲掉从未被依赖的 Set 去重语义。

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `COMMERCIAL_DESIGN.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Notebook Wars — commercial 商业服务设计文档 | **本文** |
| §10 分平台路由（IAP client）、§11 钱包按支付渠道隔离（ADR-020） | [`COMMERCIAL_DESIGN_IAP.md`](COMMERCIAL_DESIGN_IAP.md) |

## 0. TL;DR

- **commercial = 钱包与交易的唯一权威**：玩家所有「钱」相关动作（充值 / 消费 / 抽盲盒）都在这里发生并落库。
- **独立 Mongo 数据库**（`notebook_wars_commercial`，与 meta 的 `notebook_wars` 物理隔离），独立进程、独立部署。
- **玩家不直接触达 commercial**：客户端只对 meta 发 REST（请求面单一入口），**meta 作为编排者经内部 RPC 调 commercial**。commercial 只暴露内部端点 + 内部密钥鉴权，不绑公网。
- **职责切分**：commercial 拥有 `coins 余额 + 流水 + 订单 + 充值票据 + 盲盒 RNG + 保底`；meta 拥有 `inventory 物品 / 进度 / 天梯`。一次抽卡 = commercial 扣币+随机+记账，**meta 据结果发物品**。
- **一致性**：跨服务的「扣币 + 发货」用 **orderId 幂等 + 待发货对账**（saga，非分布式事务），任一端崩溃可重放收敛。

---

## 1. 为什么单拆 commercial（相对原设计的偏离）

原 `META_DESIGN.md` 把经济/盲盒/IAP 全放在 meta 内（请求面），并留了一句「以后好拆」。本设计**正式拆出**，理由：

| # | 决策 | 理由 |
|---|---|---|
| K1 | 钱包权威从 meta 的 `saves` 迁到 commercial **独立库** | 真钱数据物理隔离：meta（玩家高频读写存档）被攻破/出 bug 也碰不到余额与充值流水；审计/对账/合规边界清晰 |
| K2 | commercial 玩家不可达，**meta 当其唯一调用方（编排者）** | 保持「玩家只触达 meta(REST)+gateway(WS)+game(WS)」三入口不变（`META_DESIGN §1.1`）；客户端零改动地继续只认 meta 的 economy 端点 |
| K3 | 盲盒 RNG（`crypto` 真随机 + 保底）落在 commercial | 抽卡是「扣币 → 随机 → 记账」的原子交易，随机与扣币同库才能在一个文档/一次操作里保证不超扣、不重抽（`M7`）；产出的物品 id 交给 meta 发货 |
| K4 | commercial 用**独立数据库名**而非独立集合 | 便于将来整库迁移到独立 Mongo 实例 / 加密卷 / 单独备份策略，不牵动 meta 数据 |

> **与 `M16/M17` 的一致性**：commercial 同 matchsvc 一样是「玩家不可达的内部服务」，但 commercial **连 Mongo**（matchsvc 不连）。它是 meta 之外**唯一**连库的另一服务，连的是**自己专属的库**。

---

## 2. 拓扑中的位置（6 组件）

```
                请求面 REST(无状态)            内部 RPC(内部密钥)
客户端 ───────────→ metaserver ───────────────────────────→ commercial
  │ auth/save          │  charge/refund/draw/recharge/balance      │
  │ /shop /gacha       │  grant 回执                                │
  │ /ads  /iap         ↓                                            ↓
  │              MongoDB(notebook_wars)              MongoDB(notebook_wars_commercial)
  │              saves/accounts/matches…            wallets/ledger/orders/recharges/gachaHistory
  │
  ├──→ gateway(WS 控制面)  ──→ matchsvc(私有)
  └──→ gameserver(WS 数据面)
```

- 客户端**永远只对 meta** 发经济请求（`/shop/buy`、`/gacha/draw`、`/ads/reward`、`/iap/verify`）。
- meta 校验 JWT、解出 accountId，再以**内部密钥**调 commercial 完成扣币/随机/记账，拿回结果后写 inventory（meta 库）并回推 `SaveData`。
- commercial **不解析 JWT**、不认玩家身份语义，只信 meta 传来的 accountId（内部信任边界，和 matchsvc 信 gateway 传的 elo 同理）。

---

## 3. 数据模型（commercial 独立库 `notebook_wars_commercial`）

### 3.1 集合一览

| 集合 | _id | 关键字段 | 用途 | 权威 |
|---|---|---|---|---|
| `wallets` | accountId | `coins:number`, `rev:number`, `updatedAt` | 余额（单文档原子更新 + 乐观锁） | commercial |
| `ledger` | 自增/ObjectId | `accountId`, `delta`, `balanceAfter`, `reason`, `orderId`, `ts` | **不可变流水**（每笔加减一条，审计/对账） | commercial |
| `orders` | orderId(UUID) | `accountId`, `kind`('shop'\|'gacha'), `cost`, `status`, `result`, `deliveredAt`, `ts` | 消费订单（幂等键 + 待发货对账） | commercial |
| `recharges` | receiptId | `accountId`, `platform`, `amount`, `coinsGranted`, `status`, `rawReceipt`, `ts` | 充值票据（幂等 + 防重复发币） | commercial |
| `paddleEvents` | `transactionId:eventType` | `transactionId`, `eventType`, `status?`, `accountId?`, `rawEvent`, `ts` | Paddle webhook 非 completed 事件留痕（客服排查，§10.5） | commercial |
| `gachaHistory` | ObjectId | `accountId`, `poolId`, `orderId`, `results[]`, `pityBefore/After`, `ts` | 抽卡历史（逐抽落库，`M7`） | commercial |

> `gachaHistory`/`walletLog`/`iapReceipts` 现在挂在 meta 的 `shared/src/mongo.ts`（见 `CLAUDE.md` 集合表）——迁移时从 meta 库**移除**，在 commercial 库重建为 `gachaHistory`/`ledger`/`recharges`。meta 不再持有这三张表。

### 3.2 wallets 文档

```ts
interface WalletDoc {
  _id: string;          // accountId
  coins: number;        // 当前余额，>= 0
  rev: number;          // 乐观锁修订号
  updatedAt: number;
}
```

- 新账号首次操作时 upsert（`coins:0, rev:0`）。
- 扣币：`findOneAndUpdate({_id, coins:{$gte:cost}}, {$inc:{coins:-cost}, ...})`——`$gte` 守卫防超扣（`META_DESIGN §6.3`）。
- 加币（充值/广告）：`$inc:{coins:+amount}`。
- 每次余额变更**必写一条 `ledger`**（同 reason + orderId/receiptId 关联）。

### 3.3 保底（pity）落位

`gacha.pity` 从 meta 的 `SaveData` 迁到 commercial。两个放法择一（设计默认 **A**）：

- **A（默认）**：pity 计数嵌进 `wallets` 文档的 `gacha.pity: Record<poolId, number>`，与扣币同文档 → 一次抽卡的「扣币 + 更新保底」落在一个文档原子更新里，零事务。
- B：单独 `pity` 集合。仅当 pity 逻辑复杂到需独立时再拆。

> meta 的 `SaveData.gacha` 字段**降级为只读镜像**（展示保底进度），由 commercial 在 draw 回执里带回、meta 写进 save 镜像段（见 §6）。

---

## 4. 钱包权威迁移（coins 不再在 meta saves）

| 项 | 迁移前（现状） | 迁移后（本设计） |
|---|---|---|
| coins 余额 | meta `saves.wallet.coins`（权威） | commercial `wallets.coins`（权威） |
| `SaveData.wallet.coins` | 权威字段 | **只读镜像**：meta 在 auth/经济操作回执后从 commercial 取最新值写入，供客户端离线展示 |
| 扣币/加币 | meta `findOneAndUpdate` saves | commercial `findOneAndUpdate` wallets + 写 ledger |
| 抽卡历史/流水/票据 | meta 库 gachaHistory/walletLog/iapReceipts | commercial 库 gachaHistory/ledger/recharges |
| inventory 物品 | meta `saves.inventory`（权威） | **不变**，仍 meta 权威 |
| pvp 天梯 | meta `saves.pvp` | **不变**，仍 meta 权威 |

**镜像同步时机**（meta 把 commercial 余额写进 `SaveData.wallet.coins`）：
1. 玩家 auth 后 `GET /save`：meta 顺带向 commercial 取 balance 填镜像。
2. 任何经济操作（buy/draw/ads/iap）回执里 commercial 带回新 balance，meta 写镜像并回推。
3. 客户端**永不写** `wallet.coins`（同步段白名单已排除 wallet，现状即如此，无需改）。

> 客户端代码几乎零改动：它本就把 `save.wallet.coins` 当只读余额显示（见 `ECONOMY_BALANCE` CurrencyBar）。改的是「谁填这个字段」。

---

## 5. 内部契约（meta → commercial，REST + 内部密钥）

> 完整契约同步进 `SERVER_API.md §9`。鉴权：HTTP 头 `X-Internal-Key: <NW_INTERNAL_KEY>`（与 gateway↔matchsvc、game→meta 共用同一把内部密钥体系，`M18/M19`）。commercial 只接受内网/带密钥请求，不暴露公网。

```
# 查询余额（meta 填 SaveData.wallet 镜像 / 拉取保底进度）
GET  /internal/wallet?accountId=<id>
  → { coins, pity: {poolId:count} }

# 商店直购：扣币（commercial），物品由 meta 发
POST /internal/shop/charge
  { accountId, itemId, cost, orderId }            # orderId 由 meta 生成(UUID)，幂等键
  → { ok, orderId, coinsAfter, status:'charged' }
  | INSUFFICIENT_FUNDS | ALREADY_PROCESSED(幂等重放，返回原结果)

# 盲盒：扣币 + RNG + 记账（commercial），物品由 meta 发
POST /internal/gacha/draw
  { accountId, poolId, count:1|10, orderId }
  → { ok, orderId, coinsAfter, pityAfter, results:[{itemId, rarity, dupeConverted?}] }
  | INSUFFICIENT_FUNDS | ALREADY_PROCESSED

# 标记订单已发货（meta 发完物品回调，幂等闭环）
POST /internal/order/delivered
  { orderId }
  → { ok }

# 充值验单 + 加币（commercial 自己验平台票据）
POST /internal/recharge/verify
  { accountId, platform, receipt, receiptId }     # receiptId 幂等键
  → { ok, coinsAfter, coinsGranted } | INVALID_RECEIPT | ALREADY_PROCESSED

# 广告奖励加币（meta 已校验广告凭证 + 当日 cap，commercial 只加币记账）
POST /internal/ads/credit
  { accountId, amount, dayKey }
  → { ok, coinsAfter }
```

---

## 6. 关键流程（saga 一致性）

### 6.1 抽盲盒（扣币在 commercial，发货在 meta）

```
客户端 ──POST /gacha/draw {poolId,count}──→ meta
  meta: 校验 JWT→accountId；orderId = uuid()
  meta: getOrCreateSave(accountId) 与下面的 commercial 调用**并发发起**（互不依赖，2026-07-15 起）
  meta ──POST /internal/gacha/draw {accountId,poolId,count,orderId}──→ commercial
     commercial(2026-07-15 起并行化幂等前置读):
        0) Promise.all[ orders.findOne(orderId) 幂等检查, resolvePool(poolId), ensureWallet(accountId) ]
           （三者互不依赖；命中幂等重放时 resolvePool/ensureWallet 的结果被丢弃，代价换取非重放路径的两次 round-trip）
        1) wallets 扣币(coins>=cost 守卫) + 更新 pity        ┐ 一个 findOneAndUpdate
        2) crypto 真随机按 weight + 保底 → results           ┘ 同文档
        3) 写 ledger(delta=-cost, orderId) + gachaHistory + orders(status:'charged')
        ← { orderId, coinsAfter, pityAfter, results }
  meta:
        4) 据 results 把物品写进 saves.inventory（幂等：若 save 已记录该 orderId 已发则跳过）
        5) ──POST /internal/order/delivered {orderId}──→ commercial (orders.status:'delivered')
           **fire-and-forget（2026-07-15 起）**：不 await，失败只记日志——是纯 bookkeeping，
           丢单由下面的崩溃恢复对账兜底，不应卡住给客户端的响应
        6) save.wallet.coins = coinsAfter；save.gacha.pity = pityAfter（镜像）
        7) bumpRetentionTask('gacha.draw') 同样 fire-and-forget（2026-07-15 起）：返回给客户端的
           retention 字段由本地纯函数 accrueRetentionTask 计算，不依赖这次 DB 写落地
  客户端 ← { save: SaveData, results }（播开箱动画）
```

> **2026-07-15 延迟重构**：原链路是 2 次同步跨服务 HTTP + 10-13 次串行 Mongo round-trip，在 2vCPU VPS 上叠加 CPU 争抢后感觉到 ~1s 延迟（诊断过程见 `gacha-draw-latency-2026-07-15` 记忆，排除了慢查询/缺索引/N+1）。本次只做上面三处并发化/异步化，**不改动 insert-first 占槽幂等模式本身**。回归覆盖：
> - `commercial/test/service-idempotency.e2e.test.ts`「gachaDraw: concurrent duplicate orderId...」（已有，6 路并发同 orderId，断言只扣一次币）+ 新增「gachaDraw: N concurrent DISTINCT draws...」（10 路并发不同 orderId，断言各自扣款/各自入账，互不干扰）。
> - `metaserver/test/economy.e2e.test.ts` 新增「gacha: fire-and-forget orderDelivered failure...」：模拟 delivered 回执失败，断言响应仍正常返回物品/扣款，订单留在 `charged` 可被下次 `GET /save` 对账补发、不重复发放。
> - 已知与本次改动无关的既存竞态（未修，仅记录）：`wallet.gacha.pity` 用非原子 `$set`（基于扣币前读到的 `prevPity` 计算），同账号真并发的多笔**不同** orderId 抽卡可能丢失保底计数递增——这在并行化之前就存在（读 pity 本就发生在扣币之前），不在本次任务范围内。

**崩溃恢复（对账）**：
- meta 在第 3 步后、第 4 步前崩 → commercial 有 `status:'charged'` 但未 `delivered` 的订单。**对账兜底**：玩家下次 `GET /save` 时 meta 调 commercial 拉「该账号未发货订单」→ 补发物品 → 标 delivered。订单含完整 `result`，发货可重放且幂等。
- 第 4 步成功、第 5 步的 fire-and-forget 请求失败或丢失 → 订单停在 `charged`，下次对账重发 delivered（meta 发货幂等，不会重复给物品）——这与之前同步失败的兜底路径完全一致，只是现在这条路径更容易被触发（不再阻塞等待网络成功）。
- commercial 扣币本身原子，**绝不会扣了币随机结果丢失**（结果在扣币同一次操作里生成并落库）。

### 6.2 充值（纯加币，无 meta 发货）

```
客户端 ──POST /iap/verify {platform,receipt}──→ meta
  meta: 校验 JWT→accountId；receiptId = 平台票据唯一 id
  meta ──POST /internal/recharge/verify {accountId,platform,receipt,receiptId}──→ commercial
     commercial:
        1) 向平台(微信支付/渠道)验票据；失败 → INVALID_RECEIPT
        2) recharges upsert(receiptId 幂等：已存在且 granted 直接返回原结果)
        3) wallets $inc 加币 + 写 ledger
        ← { coinsAfter, coinsGranted }
  meta: save.wallet.coins = coinsAfter（镜像）→ 回推
  客户端 ← { save, granted }
```

> 充值不涉及 inventory，meta 只做镜像更新。**未验单不发币、重复票据幂等**（`S4-1`）。

### 6.3 商店直购

同 §6.1 但无 RNG：commercial 扣币 + 记 orders(kind:'shop')，meta 发对应皮肤/道具进 inventory，闭环同 §6.1。

### 6.4 广告奖励

广告凭证校验 + 当日 cap 计数留在 **meta**（属请求面、与平台广告回调耦合，`S2-4`），meta 校验通过后调 `/internal/ads/credit` 让 commercial 加币记账。

### 6.5 幂等落位不变量（先占槽后动账）

`orderId` / `receiptId` 由**调用方（meta）透传**（`internalHttp` 直接 `str(b.orderId)`），meta 超时重试 / 客户端双击都可能把**同一 id 并发**打到 commercial。所有涉及余额变更的路径必须遵守同一不变量：

> **先用唯一 `_id` 占幂等槽（`orders.insertOne` / `recharges.insertOne`），捕获 E11000 短路返回已有结果；再动钱包余额并回填 `coinsAfter`。**

- **入账路径**（`grant` / `monthlyCardBuy` / `rechargeVerify` / `paddleComplete`）本就如此。
- **扣款路径**（`shopCharge` / `spend` / `gachaDraw`）同样先占槽：占槽成功后再做 `$gte` 守卫的原子扣币；若扣币因余额不足失败，**回滚删除刚占的槽**并返回 `INSUFFICIENT_FUNDS`（保证后续充值后可用同 orderId 重放）。E11000（并发同 orderId）短路返回已有订单结果，**不再二次扣币**。
  - 历史 bug（已修）：扣款路径曾「先扣币、后 `insertOne` 且无 catch」，两个并发同 orderId 请求会**双重扣款**、第二个 `insertOne` 抛 E11000 冒泡成 400。**顺序重放安全，并发重放不安全**。
- **返回值仅供参考**：并发竞争的败者走 E11000 分支读订单时，赢者可能尚未回填 `coinsAfter`（读到占位 0）。余额权威以 `getWallet` / 后续镜像为准，`coinsAfter` 非权威。
- **首充 2× 奖励时序**：`rechargeVerify` / `paddleComplete` 均须在 `claimFirstPurchaseBonus()` **之前** `ensureWallet`——`claim` 的 `findOneAndUpdate({firstPurchasedAt:{$exists:false}})` 无 upsert，钱包不存在时匹配不到会把 2× 漏到第二笔。
- **首充状态回传（客户端徽标门控）**：`WalletView.firstPurchaseUsed`（= `wallets.firstPurchasedAt != null`）经 `meta` `mirrorWalletFrom` 写入 `save.monetization.firstPurchaseUsed`。客户端充值档位仅在 `firstPurchaseUsed !== true` 时展示「首充双倍」徽标——老玩家用掉首充后不再显示（否则会误导：徽标在，实际不再翻倍）。离线/无镜像时默认视为可用（仍显示）。
- **历史 bug（2026-07-26 修）：`redeemFate`（命定池兑换）曾未遵守本节的先占槽再动账顺序**——直接原子扣 `fatePoints`，**之后**才 `orders.insertOne` 且无 E11000 catch。并发同 orderId 请求都能通过「无已有订单」检查、都扣一次 `fatePoints`（余额够两次时双扣），败者的 `insertOne` 抛 E11000 冒泡成未捕获异常。已改为与 `gachaDraw` 一致的先占槽后扣款顺序。
- **历史 bug（2026-07-26 修）：`orderDelivered`（发货回调，含 gacha 重复保底退款）曾未检查幂等 `updateOne` 的匹配结果**——`{_id, status:'charged'}` 守卫的状态翻转写入之后无条件执行退款 `credit()`。并发重复的发货回调（如 meta 超时重试同一订单的 delivered 回调）都能读到 `status:'charged'`、都执行退款，导致**保底金币重复入账**。已改为检查 `matchedCount`，只有真正翻转状态的那次调用才退款。
- **历史 bug（2026-07-26 修）：`paddleRefund`（Paddle 退款事件扣减 `totalRechargeCents`）曾是 check-then-act**——读 `doc.refundedAt` 判断后分两次非原子写（钱包扣减 + `recharges.updateOne` 标记 `refundedAt`）。Paddle 保证 webhook 至少投递一次，并发重复的退款事件都能通过预检查、都执行扣减，`totalRechargeCents`（首充/进度门槛统计）被多扣。已改为先原子 `updateOne({_id, refundedAt:{$exists:false}})` 抢占标记位，只有抢到的那次才继续扣减钱包。
- **历史 bug（2026-09-03 修）：`orderDelivered` 的 verify-and-heal 探针把订单自己的扣款账本误当成「退款已落地」**——07-29 那轮补的 `healOrderRefund`（崩溃发生在「状态翻成 delivered」与「退款 `credit()`」之间时补发退款）用 `ledger.findOne({ accountId, orderId })` 判断退款到底入没入账，但**同一个 orderId 上本来就有一行扣款账本**（`shopCharge` 写 `reason:'shop'`、`gachaDraw` 写 `reason:'gacha'`）。于是对 shop/gacha 订单探针恒为真、heal 永远不触发——而 gacha 的重复品退款正是这套机制的主要服务对象，等于该路径上崩溃丢掉的退款永远补不回来（**少发**，不是多发，所以既有的并发/幂等回归全绿也发现不了）。已给探针补上 `reason: 'gacha_refund'`（退款那笔 `credit` 是唯一写这个 reason 的地方）。姊妹探针 `healRechargeCredit` 的 `{ accountId, receiptId }` 排查后确认**没有同类缺陷**：`receiptId` 全仓只被充值贷记路径写进账本，不存在共用同一 receiptId 的扣款行。回归见 `server/commercial/test/serviceGuards.e2e.test.ts`「heals a dropped refund on a shop order, whose own debit row shares the orderId」（改代码前红）。
- **三处修复均补了 `server/commercial/test/service-idempotency.e2e.test.ts` 里的并发回归测试**（`Promise.all` 打并发请求，断言业务效果只发生一次），对照当前唯一遵守本节写对的 `gachaDraw` 主抽奖路径 / `shopCharge` / `spend` 作为参照实现。
- **历史 bug（2026-08-04 修）：先占槽这套幂等模式只查过"这个 orderId 有没有订单"，从未查过"这个订单是不是本账号的"**——`orderId` 是调用方（meta）透传的裸字符串，跟调用者没有任何结构性绑定；本节其余不变量假设它对每次真实请求都是新铸的 UUID，实践中目前也确实如此，但没有任何代码强制这一点。一旦某个未来调用点没铸新 id 就复用了旧值，撞上另一个账号先前用过的同一个 orderId，`existing`/E11000 短路分支会把**那个账号**的余额/发放结果原样读出返回给当前调用者——本质与 07-29 修过的 `recharge.ts` receiptId 跨账号回放是同一类漏洞，只是这次出现在幂等槽这套通用模式本身。已给所有走"先占槽"模式的入账/扣款/订阅路径补上 `existing.accountId !== callerAccountId → BAD_REQUEST` 校验（`existing` 分支和 E11000 分支各一次）：`shopCharge`/`spend`/`grant`（`shop.ts`）、`subscriptionCardBuy`（`base.ts`，两处：初次 `existing` 分支 + E11000 分支）、`starterBuy`（`starter.ts`）。回归见 `service-idempotency.e2e.test.ts` 六条新增用例（`shopCharge`/`spend`/`grant`/`monthlyCardBuy`/`starterBuy` 各一条 owner-vs-thief 顺序场景 + `shopCharge` 一条并发场景）。

### 6.6 金币异常离线审计（反 RMT，2026-07-26）

> 承接 §6.5 修复带出的排查需求：账号一天内非充值入账超过阈值，视为可疑，进 OPS 人工审核队列——不自动处理，人来判断是不是真的 bug/漏洞产出还是正常玩法奖励堆叠。

- **数据源**：commercial 自己的 `ledger` 集合已经记录**每一笔**余额变更（`accountId, delta, reason, ts`，见 §3.1），`credit()`/`spend()`/`shopCharge()` 等所有改余额的路径都无条件写一条，不存在漏记的口子（详见 [[commercial-internal-http-always-200-check-body-ok]] 审计里逐路径核实的记录）。审计只需按 UTC 自然日聚合，不需要新建任何数据管道。
- **判定口径**：`reason !== 'recharge'` 且 `delta > 0` 的行，同一 `accountId` 同一 UTC 天求和 ≥ `COIN_ANOMALY_DAILY_THRESHOLD`（`shared/src/economy.ts`，默认 3000）即命中。**只看非充值的毛入账**，不扣当天的消费（哪怕当天净值是负的，只要非充值入账单项已经超阈值就该被人看一眼——真金白银充值买的钱不算异常，这条是唯一排除项）。`monthly_card`（月卡首充即时到账）虽标记非 `recharge`，但本质是已在 Paddle webhook 验证过的真实付费——目前仍计入统计（判定口径偏保守，宁可多审一眼），产品如需精细化排除需再拍板。
- **实现**：
  - `server/commercial/src/service/audit.ts`（`AuditMixin.auditCoinGains(dayKey, minGain)`）：纯读聚合（`$match ts 范围 + delta>0 + reason≠recharge` → `$group` 按 accountId 求和 → `$match gain≥minGain` → `$sort` 降序），不改任何数据。内部端点 `GET /internal/audit/coin-gains?dayKey=&minGain=`（X-Internal-Key 鉴权，与其余 commercial 内部端点同款）。
  - `server/metaserver/src/coinAnomalyAudit.ts`（`auditCoinAnomaliesOnce`）：每 24h 跑一次（`index.ts` 里的 `setInterval`，与既有「回放归档每日清扫」同款节奏，不新增环境变量），扫「昨天」（相对 `now()` 已完整结束的最近一个 UTC 天）——只扫已完结的整天，避免当天还在累积时被半截数据误判。命中账号逐个写入 `AntiCheatReviewDoc`（`kind:'coin_anomaly'`，`_id=coin:{accountId}:{dayKey}` 天然幂等，重复扫描不会重复入队，已解决的记录也不会被扫描覆盖）——复用 S9-7 反作弊审核队列（同一张表、同一套 OPS 页面、同一条 dismiss/ban 流程），不新建通道。
  - `AntiCheatReviewDoc.kind` 新增 `'coin_anomaly'` 分支，字段 `dayKey`/`nonRechargeGain`/`threshold`（`server/shared/src/mongo.ts`）。OPS 页面 `tools/ops/src/pages/suspicions.ts` 新增第三种 kind 的展示分支（`Coin` 标签 + `{dayKey}: 入账 {nonRechargeGain}（阈值 {threshold}）` 详情文案），admin 后端/内部路由无需改动——本就是按 `AntiCheatReviewDoc` 原样透传，不区分 kind。
- **测试**：`server/commercial/test/audit.e2e.test.ts`（真实 Mongo 聚合：日窗口边界正确性、charge 类型排除、debit 不冲抵、多账号降序排序、非法 dayKey 不抛错）+ `server/metaserver/test/coin-anomaly-audit.e2e.test.ts`（假 commercial 客户端 + 真实 `antiCheatReviews`：正确入队/幂等重扫不重复/已处理记录不被覆盖/commercial 不可用时空跑不抛错）。
- **验收**：`shared`/`commercial`/`metaserver`/`tools/ops` 四包 `tsc --noEmit` 全绿；`vitest run` commercial 120/120、metaserver 663+4/663+4（新增 4 个）。纯后台离线扫描 + OPS 内部页面改动，未做浏览器截图验证（ops 页面无本地可跑的开发预览环境，且改动只是给既有表格加一个 kind 分支，风险低）。

---

## 7. 服务形态与部署

- **包**：新增 workspace `server/commercial`（CJS，结构对齐 gameserver：`config.ts` / `index.ts` / `service.ts` / `db.ts`）。
- **端口**：`NW_COMM_PORT`（默认 18082；避开 Windows 保留段 8082）。
- **库**：`NW_COMM_MONGO_URI`（默认复用同一 Mongo 实例）+ `NW_COMM_MONGO_DB`（默认 `notebook_wars_commercial`）。**库名独立、实例可同可分**——前期同实例不同库，涨了整库迁独立实例。
- **鉴权**：`NW_INTERNAL_KEY`（meta 与 commercial 共享；缺失则拒绝所有 `/internal/*`）。
- **契约**：内部 RPC 走 JSON（低频、便于调试），契约登记在 `SERVER_API.md §9`；**不进 protobuf**（protobuf 只管 WS 热路径，`M12`）。
- **索引**：`ledger(accountId,ts↓)`、`orders(accountId,status)`、`orders(status,ts)`（对账扫描未发货）、`recharges` `_id` 天然唯一、`paddleEvents(accountId,ts↓)` + `paddleEvents(transactionId)`（`_id` 天然唯一，§10.5）。
- **零依赖游戏逻辑**（`M12`）：commercial 不 import `client/src/game`。

---

## 8. 与现状的差异与迁移要点

1. **shared/src/mongo.ts**：从 meta 库集合表移除 `gachaHistory`/`walletLog`/`iapReceipts`；新增 commercial 库工厂（或在 commercial 包内建自己的 `createCommercialMongo`）。
2. **SaveData**：`wallet.coins`/`gacha.pity` 改注释为「只读镜像，权威在 commercial」；同步段白名单不变（本就排除 wallet/gacha）。需加迁移步骤（version bump）——但因字段形状不变，主要是语义变更，迁移可能无操作。
3. **meta service.ts**：`/shop/buy`、`/gacha/draw`、`/ads/reward`、`/iap/verify` 从 501 占位改为「校验 + 调 commercial + 写 inventory + 回推」编排实现；`GET /save` 加余额镜像拉取。
4. **客户端**：基本零改动（继续读 `save.wallet.coins`、调 meta 端点）。新增 ShopScene/GachaScene（`UI_DESIGN §4.3/§4.4`）属 S2 客户端，与本服务并行。

---

## 9. 开放问题（实现时的拍板）

- [x] **同实例 vs 同库**：按默认——同 Mongo 实例不同库（`NW_COMM_MONGO_URI` 缺省复用 `NW_MONGO_URI`，`NW_COMM_MONGO_DB=notebook_wars_commercial`）。涨了改这两个 env 即迁独立实例。
- [x] **对账触发**：S5 先做 `GET /save` 顺带（拉 `orders/undelivered` 补发）；**兜底定时扫待办**。
- [x] **充值平台**：**S4-1 已落地（2026-06-22）**：`commercial/src/iap.ts` 实现微信支付 V3（HMAC-SHA256 简化鉴权，`NW_WX_PAY_MCH_ID/API_KEY_V3`）+ Stripe（`GET /v1/payment_intents/{id}`，`NW_STRIPE_SECRET_KEY`）；金额→档位映射可 `NW_IAP_AMOUNT_MAP` 覆盖；两者均未配置时自动降级 dev 桩（`NW_IAP_DEV=true` 可强制开启）。`CommercialService.verifyReceipt` 已改 async。
- [ ] **余额镜像新鲜度**：默认「进 ShopScene 前 `GET /save` 刷新」——待 S2 ShopScene 落地时接（场景尚未实现）。

---


---

**接下页** → [`COMMERCIAL_DESIGN_IAP.md`](COMMERCIAL_DESIGN_IAP.md)：§10 分平台路由（IAP client）、§11 钱包按支付渠道隔离（ADR-020）。
