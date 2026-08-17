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

## 10. 客户端充值入口与分平台路由（IAP client）

> 状态：✅ **已实现（2026-07-02，feat/iap-client-entry）**。此前服务端验单（§6.2 + `commercial/src/iap.ts`：Apple/Google/微信/Stripe）与 Paddle 通道（`metaserver/src/paddle.ts`）已就绪，但客户端无任何真实充值入口（`ShopScene` 的 Coins tab 是死代码，从未在 `goShop` 接上），仅剩 B-PROMO 兑换码。本节补齐客户端。

### 10.1 分平台路由（一份 web bundle 兼作原生包）

游戏出**同一份 web 构建**：Capacitor 壳（`build:native = build:web && npx cap sync`）把它装进 iOS WKWebView / Android WebView，并注入原生计费桥 `window.NWBilling`。因此**平台层在运行时决定**一次金币充值走哪个商店：

| 运行环境 | `IPlatform.iapKind()` | 充值通道 | 验单 |
|---|---|---|---|
| 普通浏览器（web target） | `'paddle'` | Paddle.js Checkout | `/paddle/webhook`（异步） |
| iOS 原生壳（注入 `NWBilling`） | `'apple'` | StoreKit（原生桥） | `POST /iap/verify {platform:'apple'}` |
| Android 原生壳（注入 `NWBilling`） | `'google'` | Play Billing（原生桥） | `POST /iap/verify {platform:'google'}` |
| 微信小游戏 | `null` | —（`wx.requestPayment` 留 TODO） | — |
| CrazyGames | `null` | —（平台自有变现） | — |

- `ShopScene` 的 Coins tab **仅当 `rechargeCoins` 回调存在时显示**；`createAppCore.goShop` 现在仅在「已登录在线 **且** `platform.iapKind() !== null`」时提供该回调。→ web/原生显示 Coins tab，微信/CrazyGames 不显示（这些平台继续只有 B-PROMO 兑换码）。
- 档位数值权威仍是 `server/shared/src/economy.ts` 的 `IAP_TIERS`（t099..t9999）；`ShopScene.WEB_COIN_TIERS` 只展示 5 档 USD（t499..t9999），web-only 小额档（t099/t199）暂不在 UI 露出。

### 10.2 两条充值流

**Web（Paddle，异步到账）**：
```
ShopScene → rechargeCoins(tierId) → createAppCore.doRechargeCoins
  1) api.paddleCheckout(tierId)  → POST /shop/paddle/checkout → { transactionId }
  2) platform.openPaddleCheckout(transactionId, clientToken)   # 动态加载 Paddle.js + Initialize + Checkout.open(overlay)
     - checkout.completed → completed=true；checkout.closed → resolve({completed})
     - 用户中途关闭 → completed=false → 提示 shop.rechargeCancelled
  3) Paddle 服务器异步回调 /paddle/webhook 给账号加币
  4) 客户端轮询 saveManager.refresh() ~10s（1/1.5/2/2.5/3s）直到 coins 增加
     - 到账 → shop.rechargeSuccess；超时未到账 → shop.rechargePending（币仍会随后到账）
```
Paddle.js 的 **client token**（`ptok_`/`live_`/`test_`，客户端安全）由服务端经 `/bootstrap` 下发（见 §10.3）；token 前缀 `test_` 时客户端 `Paddle.Environment.set('sandbox')`。

**原生（Apple/Google，同步到账）**：
```
ShopScene → rechargeCoins(tierId) → createAppCore.doRechargeCoins
  1) platform.nativeIapPurchase(tierId) → window.NWBilling.purchase(tierId) → { receipt }
  2) api.iapVerify(kind, receipt) → POST /iap/verify → { save }
  3) saveManager.adoptServer(save)   # 同步拿到权威存档，coins 立即刷新 → shop.rechargeSuccess
```

**超时策略（关键）**：充值涉及**用户自定节奏**的支付 UI（Paddle overlay / 原生商店弹窗），可能开着好几分钟——因此 `ShopScene.onRecharge` **不套 `withTimeout`**（与 buy/redeem 不同）。超时只加在 `doRechargeCoins` 内部的**网络调用**上：`paddleCheckout` / `iapVerify` / 轮询里的 `saveManager.refresh` 各套 10s `withTimeout`（`ApiClient` 自身无 fetch 超时，否则挂起的请求会让 busy 转圈卡死）；`openPaddleCheckout` / `nativeIapPurchase` 这两个交互等待**不设超时**。网络超时 → `common.networkTimeout` 提示；回调始终 resolve 出 result key，spinner 必定收起。

### 10.3 `/bootstrap` 下发 Paddle client token

`metaserver` 的 `MetaService.bootstrap` 在 `NW_PADDLE_CLIENT_TOKEN` 配置时，于响应里附带 `paddleClientToken`（未配置则不带）。客户端 `FeatureFlags` 轮询 `/bootstrap` 时缓存它，`getPaddleClientToken()` 供 `doRechargeCoins` 取用。token 缺失（服务端未配置）→ Paddle 充值提示 `shop.rechargeError`，不发起 checkout。

> **⚠️ 踩坑（2026-07-17）**：`paddleClientToken` **必须在 `/bootstrap` 的 OpenAPI 200 响应 schema 里显式声明**（`openapi/paths/telemetry.yml`）。Fastify 用响应 schema 做 fast-json-stringify 序列化，**只输出 schema 声明过的字段**——handler 返回了 token 但 schema 没声明时会被静默剥掉，症状是 env 配好了、代码也返回了，客户端却永远拿到 null、充值秒失败。此规则适用于本仓所有 codegen 路由的任何新增响应字段。

### 10.3.1 Paddle 建交易的两个前置（2026-07-17）

`metaserver/src/paddle.ts` `createPaddleTransaction` 调 Paddle Billing `POST /transactions`：

- **字段必须 snake_case**：`price_id` / `custom_data`（不是 camelCase `priceId`/`customData`，否则 400 `price_id is required` oneOf 校验失败 → `/shop/paddle/checkout` 返 502 `PADDLE_ERROR`）。
- **Paddle 后台须配 Default Payment Link**（Dashboard → Checkout settings）：未配则 400 `transaction_default_checkout_url_not_set`。游戏内 overlay（`Paddle.Checkout.open({transactionId})`）不依赖该页内容，但 Paddle 生成的兜底链接（收据/付款失败重试邮件/「完成付款」）会以 `<Default Payment Link>?_ptxn=<txnId>` 形式跳转。故新增 `client/public/web/pay.html`：加载 Paddle.js + 从 `/api/bootstrap` 取 client token（按 `test_` 前缀切沙盒/生产）+ 读 `_ptxn` 自动开结账浮层，后台默认支付链接填 `https://<host>/pay.html`（已接入 webpack copy）。
  - **⚠️ 踩坑（2026-07-17）**：pay.html 原先用**同源** `fetch('/api/bootstrap')` 取 client token。但游戏站主机（`a.gamestao.com` / `nivara.gamestao.com`）是 Cloudflare Worker 静态站（`wrangler/client.jsonc` `not_found_handling: single-page-application`），`/api/*` **不代理**到后端 → 同源请求返回 SPA 的 `index.html`，`JSON.parse` 抛错，页面显示 "Checkout unavailable (Unexpected token '<')"，浮层永远打不开。修复（commit `8d50c31d`）：pay.html 先试同源、失败再回退到由主机名推导的 `api.<apex>` 源（对齐 webpack `MOBILE_ORIGIN`），并加 `content-type` 判断，避免把 SPA HTML 当 JSON 解析。**通则**：`client/public/web/` 下任何调 REST 的静态页都不能假设 `/api` 同源可用——游戏站是纯静态 CF Worker，须用 `api.<apex>` 回退。注意 pay.html 只随**客户端静态部署**（`client-deploy.yml` → `wrangler deploy`）上线，更新 VPS 不会改到它。

### 10.4 原生计费桥契约（`window.NWBilling`，本仓库外实现）

TS 契约见 `client/src/platform/iap.ts`：
```ts
interface NwBillingBridge {
  readonly kind: 'apple' | 'google';
  purchase(tierId: string): Promise<{ receipt: string }>;  // 跑原生购买 UI，返回商店票据；取消/失败则 reject
}
```
Capacitor 原生插件（Swift/Kotlin）需在 WebView 就绪时把符合此形状的对象挂到 `window.NWBilling`：
- `kind` 标明本机走 Apple 还是 Google；
- `purchase(tierId)` 调 StoreKit / Play Billing 完成购买，把票据（Apple: base64 收据 / StoreKit2 JWS；Google: purchaseToken）经 `resolve({receipt})` 交回。
- `receipt` 直接 `POST /iap/verify {platform: kind, receipt}`，由 `commercial/src/iap.ts` 现成的 Apple/Google 验单校验。

> **暂缓（本轮不做）**：原生 Swift/Kotlin 计费插件 + Capacitor 壳工程本体；微信 `wx.requestPayment`。二者以上述桥契约 / §6.2 服务端验单为对接面，后续单开。

### 10.5 Paddle webhook 非 completed 事件留痕（支持/客服排查，2026-07-16）

> 状态：✅ 已实现。

`transaction.completed` 之外的 Paddle 事件（`transaction.payment_failed`/`canceled`/`past_due` 等）此前被 `/paddle/webhook`
直接丢弃（`return 200 'ignored'`，无任何记录），一旦玩家反馈"充值扣款了但没到账"，客服查不到任何线索。现改为：

```
metaserver /paddle/webhook（HMAC 校验后）
  event_type === 'transaction.completed' → 原有逻辑：commercial.paddleComplete() 发币（走 recharges 表）
  event_type 其它 transaction.* 事件      → commercial.recordPaddleEvent() 留痕（走新增 paddleEvents 表），不发币
```

- **存储**：commercial 库新增 `paddleEvents` 集合（`_id = transactionId:eventType` 天然幂等，Paddle 的 at-least-once
  重投不会重复记录），字段：`transactionId`/`eventType`/`status?`/`accountId?`/`rawEvent`（原始 JSON）/`ts`。索引
  `{accountId,ts↓}` + `{transactionId}`。无 TTL（比照 `recharges`/`orders`/`ledger`，财务类记录长期保留）。
- **查询链路**：与 promo 码管理同一条内部调用链（`admin → metaserver /admin/paddle/events → commercial /internal/paddle/events`），
  两层鉴权：服务间 `X-Internal-Key` + ops 前端的 session+能力位 `paddle.events.view`（`super`/`ops`/`support` 三个角色都有，
  客服排查场景不需要 `ops`/`super`）。
- **ops 前端**：新页面 "Paddle Events"（`tools/ops/src/pages/paddleEvents.ts`），按 accountId/transactionId 搜索，点击一行展开
  原始事件 JSON。

### 10.6 Paddle checkout 数量购买（1–5 份，2026-07-18）

> 状态：✅ 已实现（服务端）。Paddle Dashboard 侧的 checkout overlay 数量选择器（1–5，价格 price 的 "adjustable
> quantity" 设置）由用户在 Paddle 后台配置，不在本仓代码范围内。

此前 `/paddle/webhook` 完全没读 `items[].quantity`：`createPaddleTransaction` 建交易时硬编码 `quantity: 1`，webhook
按 `items[0].price.id` 查一个**固定**金币数直接发币，无论玩家在 overlay 里实际调到几份。若玩家把 19.99 那档调到 10 份
并真的付了 10 份的钱，此前只会拿到 1 份的金币——钱多币少，会引出退款/工单。

修复（`server/metaserver/src/paddle.ts`）：webhook 里读 `items[0].quantity`，四舍五入并 clamp 到
`[MIN_PADDLE_QUANTITY, MAX_PADDLE_QUANTITY] = [1, 5]`（与 Paddle 后台配置的档位对齐；越界值记 warn 日志但仍按夹紧后的
数量发币，不拒绝整笔交易），`coins = coinsForPriceId(priceId) * clampedQuantity` 后原样交给
`commercial.paddleComplete()`——首充 2× 奖励逻辑不变（乘的是发币总额，不关心是 1 份还是 5 份换来的）。
`createPaddleTransaction` 建交易时仍传 `quantity: 1` 作为 overlay 的初始默认值，玩家在浮层里自行调到 Paddle 后台
允许的上限。

### 10.7 月卡/年卡接入真实 Paddle 扣款（2026-07-25）

> 状态：✅ 已实现（web/Paddle）。**原生（Apple/Google）与隐藏渠道（微信/CrazyGames）的"直接授权"缺口已于
> 2026-07-27 关闭，见 §10.8**——本节写完时那条缺口还在，是当时的一个已知范围裁剪，后来被审计发现是真实资损口。

此前 `buyMonthlyCard`/`buyYearCard`（`GACHA_DESIGN.md §5`）无论平台都直接调 `POST /monthly-card/buy` /
`/year-card/buy`，服务端"当作已授权购买"立即生效——玩家点 Buy 就直接拿到卡，网页端从未真的走过 Paddle 扣款
（现象与本节其它小节修的"钱扣了没到账"相反：这里是**根本没扣钱**）。

web 端（`platform.iapKind()==='paddle'`）现在复用 §10.2 同一套 checkout+webhook 通道：

```
ShopScene → buyMonthlyCard()/buyYearCard() → createAppCore.doBuySubscription('monthly_card'|'year_card', ...)
  1) api.paddleCheckout('monthly_card'|'year_card') → POST /shop/paddle/checkout → { transactionId }
     - 服务端先查钱包 subscriptionExpiry：卡生效中 → 400 ALREADY_ACTIVE（挡在扣款之前，不让真钱落在一个
       注定被拒发的请求上）
  2) platform.openPaddleCheckout(transactionId, clientToken)   # 同 §10.2，用户节奏，不设超时
  3) Paddle 服务器异步回调 /paddle/webhook：
       subscriptionForPriceId(priceId) 命中 'monthly'|'year' → commercial.monthlyCardBuy/yearCardBuy
       （orderId = paddle:${transactionId}，天然幂等，同 paddleComplete 的 paddle:${transactionId} 收据键思路）
       → mirrorWalletFrom 把新 expiry + 即赠 coins 一起镜像回 save（不只是 mirrorCoins）
  4) 客户端轮询 saveManager.refresh() 直到 monetization.subscriptionExpiry 变化（同 pollForCoinIncrease 套路）
     - 到账 → shop.bought 提示；超时未到账 → shop.monthlyPending（卡仍会随后生效）
```

- **价格 ID 映射**：`NW_PADDLE_PRICE_IDS` 沿用同一个环境变量，新增两个保留档位键 `monthly_card` / `year_card`
  （不进 `IAP_TIERS`，`coinsForPriceId` 天然查不到会返回 0；`subscriptionForPriceId` 专门查这两个键，两套查找互不
  干扰）。详见 `IAP_CREDENTIALS.md §1.1`。
- **数量语义**：这两个 Paddle Price 应在后台关闭"可调数量"——本仓的订阅 grant 是"买一张卡延长 N 天"，没有"一次
  买 3 张卡"的语义。webhook 侧忽略非 1 的 quantity（只记 warn 日志，不多发），呼应 §10.6 的夹紧思路但方向不同
  （§10.6 是多退少补，这里是干脆不认）。
- **超时/UI 改动**：`ShopScene` 月卡/年卡的 Buy 按钮此前经 `runDeal`（内部 `withTimeout` 包裹 action），会把
  Paddle 弹层这种用户节奏的等待错杀成超时；新增 `runUnboundedDeal`（无 `withTimeout`，语义同 §10.2 提到的
  `ShopScene.onRecharge` 特例）专供这两个按钮使用，其余 `runDeal` 调用点（领取每日奖励、新手包）不受影响。
- **同实例竞态**：`subscriptionCardBuy` 的单卡门控在 webhook 时仍会兜底（极端情况——两个标签页同时下单——checkout
  时的预检查没拦住），此时钱已经真扣了但卡拒发，走 `recordPaddleEvent` 留痕供客服/退款排查（同 §10.5 的落地方式），
  不静默丢弃。
  - **双开门控本身曾是 TOCTOU、可双重延期+双发即赠币（2026-08-04 修复）**：上面这条"兜底"描述的前提原本不成立——
    `finishSubscriptionCardBuy` 原先是"先读一次 `wallet.subscription.expiry` 判断是否已生效，再无条件调
    `applySubscription`"，两次分开的读+写。两个并发请求（不同 `orderId`，如双击/客户端重试，或本条描述的两个
    webhook 交付）能都读到"未生效"、都通过检查，然后都跑 `applySubscription`——不是"钱扣了卡拒发"，而是**卡被
    延了两次、`immediateCoins` 也发了两次**，同一笔真实购买被双倍兑现。修法：新增 `applySubscriptionIfInactive`，
    把"未生效"判断折进 `findOneAndUpdate` 的查询过滤器里，跟延期+发币合并成一次原子操作——两个并发调用只有一个
    能匹配过滤器（输家看到的是赢家已经生效的 `subscription.expiry`，天然不匹配），未命中即返回 `null`，调用方据此
    返回 `ALREADY_ACTIVE`（回退刚占的订单槽），不再有任何一条路径能双重延期/双发币。`monthlyCardBuy`/`yearCardBuy`
    共用同一份 `finishSubscriptionCardBuy`，两者都受益。回归见 `commercial/test/service.e2e.test.ts`「monthly
    card: two concurrent buys with distinct orderIds (double-tap) credit only once, not twice」。

### 10.8 月卡/年卡/新手包关闭原生+隐藏渠道的"直接授权"缺口（2026-07-27 审计）

> 状态：✅ 已实现（server 端全渠道 + web/Paddle 全链路 + 原生客户端接线；微信 Pay 仍是 TODO，见下）。
> **取代 §10.7 状态行"原生/隐藏渠道维持旧的直接授权行为，范围外"这条**——§10.7 只补了 web，原生/微信这条"范围外"
> 遗留正是 2026-07-27 审计发现的资损口：`/monthly-card/buy`、`/year-card/buy`、`/starter/buy` 三个端点对**所有**平台
> （包括原生/微信）都从不校验支付，任何拿到有效登录态的请求直接调用即可免费拿到订阅/新手包。

- **服务器权威结算侧**：三个端点现一律要求请求体带 `platform`+`receipt`，metaserver 先调新增内部端点
  `commercial.verifyNonCoinReceipt`（`server/commercial/src/service/recharge.ts`）——复用 `rechargeVerify` 同一套
  `receiptId` 幂等 + 跨账号防重放模式，但校验的是"这张收据解析出的商品是否等于调用方期望的商品"而非金币数额。
  `iap.ts` 的 `resolveNonCoinProduct`/`resolveNonCoinProductFromAmount` 新增非金币 SKU 解析（apple/google 走
  product_id 约定 `${NW_IAP_BUNDLE}.sub.monthly`/`.sub.year`/`.starter.draw`/`.starter.growth`，与 `NW_IAP_PRODUCT_MAP`
  同一套环境变量；wechat/stripe 走金额匹配，无内置默认——按现有 WeChat 金额映射的先例，未显式配置则拒绝而非放行）。
  校验不过 → `400 INVALID_RECEIPT`，不再"当作已授权"。
- **web（Paddle）**：月卡/年卡不变（§10.7 已覆盖）；**新手包首次接入 Paddle**——`NW_PADDLE_PRICE_IDS` 新增
  `starter_draw`/`starter_growth` 两个保留键，`/shop/paddle/checkout` 加同款预检查（`starterUsed`/成长包 7 天窗口），
  webhook 新分支 `starterProductForPriceId` 命中后调 `commercial.starterBuy` + `deliverOrder`（新手抽走战利品路由，
  成长包只发币/月卡，无实物）。
- **原生（apple/google）客户端**：`client/src/app/nav/shop.ts` 的 `doBuySubscription`/新增 `doBuyStarter` 现在真的调用
  `platform.nativeIapPurchase(productKind)` 拿收据，再把 `(platform, receipt)` 传给
  `monthlyCardBuy`/`yearCardBuy`/`starterBuy`（`ApiClient` 三个方法签名同步加两参）——不再是拿到 `iapKind()!=='paddle'`
  就直接免费发货。真实商店侧的 product id 仍需运营在 App Store Connect/Play Console 建好（`IOS_RELEASE.md` 待办），
  在此之前原生渠道这几个按钮点了会因收据校验失败报错，**不会再误发免费货**（fail-closed，这是本次修复的核心诉求）。
- **微信/CrazyGames（`iapKind()===null`）**：这两个平台目前没有任何支付渠道接入（WeChat Pay 仍是
  `WechatPlatform.iapKind()` 里标注的 TODO；CrazyGames 走自己的 portal 变现，不支持站外支付）——`createShopNav` 现在
  只在 `iapKind()!==null` 时才把 `buyMonthlyCard`/`buyYearCard`/`buyStarter` 三个回调塞进 nav 对象，`ShopScene` 按
  既有"回调不存在就不渲染按钮"惯例（`rechargeCoins`/Coins 页签同款）自动隐藏这三张卡的购买按钮，而不是留一个点了必
  400 的死按钮。`getMonetization`/`claimMonthlyCard`（纯读/纯已购领取，无支付语义）不受影响，登录即可用。
- **客户端价格展示**：`ShopScene` 新手包卡片此前硬编码显示"免费"（`shop.free`），现改为 `yuanPrice`（¥6/¥30，同
  `STARTER_DRAW_YUAN`/`STARTER_GROWTH_YUAN`），与月卡/年卡同一套价格渲染。*（2026-08-11 起改名为 `usdCents`/
  `STARTER_DRAW_USD_CENTS`，展示价改 $0.99/$4.99，见 `GACHA_DESIGN.md §11.1` 该日期条目。）*
- **测试**：`server/metaserver/test/economy.e2e.test.ts`（三端点补 `platform`/`receipt`）、
  `server/metaserver/test/paddle-routes.e2e.test.ts`（新增新手包 checkout+webhook 5 例，含幂等重放）、
  `client/test/shopNav-buySubscription.test.ts`（原生购买+收据传递+取消/拒绝路径+null-iapKind 隐藏按钮断言）、
  `client/test/ui/shopScene.ui.ts`（¥ 价格取代"免费"标签）全部更新并通过。

---

## 11. 钱包按支付渠道隔离（ADR-020，2026-07-27）

> 状态：✅ 已实现（西方大区共享部署内）。解决 [`DECISIONS.md` ADR-020](../DECISIONS_ADR-001-040.md#adr-020-跨平台账号钱包隔离边界--accepted--2026-06-23)
> 遗留的"钱包/充值币按支付渠道隔离"缺口：站外渠道购买的虚拟货币不得在 Apple/Google 内消费（反之亦然），否则违反
> 各平台的 IAP 反绕过条款。触发原因：iOS/Android 原生 IAP 一旦上线（`IOS_RELEASE.md` 记录 7 个 IAP 商品尚未在
> App Store Connect 建好，原生购买尚未真正上线），会与 web(Paddle) 共享**同一套全局部署 + 同一个 `wallets` 集合**
> （§7：commercial 单实例托管，`NW_IAP_BUNDLE` 只是换个环境变量，走的还是这份代码/这份库）——不像微信线是完全独立
> 部署（ADR-019/020），跨渠道混用在这里是真实可能发生的。

### 11.1 两个方案的取舍

评估过两个方向：

1. **钱包按支付渠道拆分可花池**（本方案，已实现）：`wallets.coins` 保持为免费池（广告/胜场/兑换码/退款等非充值
   来源，处处可花），新增 `wallets.recharged: {web?, apple?, google?}` 按渠道标记的充值池，只有请求平台匹配的
   渠道才可花/可见。
2. **iOS/Android 各自独立部署**（照搬微信的隔离模式）：否决。理由——
   - `accounts.ts` 的身份隔离本就是"默认独立 accountId，用户主动 `bind*` 才跨端合并"（ADR-020 原文），**跨平台
     用同一账号是一个活的、有意为之的功能**（例如 web 上用密码注册，之后在 iOS App 用同一账号登录），不是像微信
     那样被 PIPL 强制切断——若原生走独立部署，这个已支持的多端游玩能力会被牺牲，且"同一个逻辑账号分裂在两套库
     里"比"同一个钱包内部按渠道分桶"更难维护一致的天梯/存档体验。
   - `IOS_RELEASE.md §4.2` 的既定计划本就是原生 IAP 复用同一套 VPS commercial 服务（只改 `NW_IAP_BUNDLE`），
     若改独立部署是对已成型上线计划的大改，收益（隔离更彻底）不及成本（部署复杂度、账号体验倒退）。
   - 实际改造范围也比预想小：debit（花费）侧集中在 `shop.ts`/`gachaDraw.ts` 两处原子扣款，credit（充值）侧只有
     `recharge.ts`/`subscription.ts`/`starter.ts` 三处真实来自付费渠道，其余（ads/victory/promo/refund/grant）
     天然是免费池，无需改造。

### 11.2 数据结构

```ts
// server/commercial/src/spendChannel.ts
type RechargeChannel = 'web' | 'apple' | 'google';        // 微信不进这张表——完全独立部署/独立库，天然合规

// server/commercial/src/db.ts WalletDoc 新增字段
recharged?: Partial<Record<RechargeChannel, number>>;       // 按渠道标记的充值余额；缺省/历史钱包 = {} 全 0
```

- **`coins`（既有字段）语义不变**：免费获得的币（广告奖励/胜场奖励/兑换码/退款/邮件补偿/月卡每日签到等），任何
  平台随时可花——这也是**迁移前存量余额的归属**：本功能上线前累积的 `coins` 一律留在免费池，不回溯拆分到具体
  渠道（不可能精确复原历史来源，且上线时 Apple/Google 真实充值余额为 0，这个简化零风险）。
- **`recharged.<channel>`**：只有下列三处真金白银的入账会写入，其余一律进免费池：
  - `recharge.ts` 的 `rechargeVerify`/`paddleComplete`（IAP/Paddle 充值验单成功）——渠道来自验单本身的 `platform`
    参数（`paddle`/`stripe` → `web`；`apple` → `apple`；`google` → `google`），经 `rechargeChannelOf()` 映射。
  - `subscription.ts` 的 `monthlyCardBuy`/`yearCardBuy`、`starter.ts` 的 `starterBuy`（`starter_growth`）——这三个
    端点自 §10.8 起也要求真实验单，其即赠 coins 同理按 `rechargePlatform` 归渠道；Paddle webhook 调用路径硬编码
    `rechargePlatform:'paddle'`（该路径就是 web 专属，无需再猜）。

### 11.3 花费侧：按「请求平台」门控

新增 `X-NW-Platform` 请求头（客户端声明，`ios`/`android`/`web`/`wechat`/`crazygames`）：

```
client/src/net/ApiClient/base.ts  fetchRaw()
  ── 探测 window.NWBilling.kind（原生壳注入，同 §10.2 复用的信号）→ 'ios'/'android'
     否则回退构建期 TARGET → 'web'/'wechat'/'crazygames'
  ── 每次请求都带上，metaserver 用 clientPlatformOf(req) 读取并转发给 commercial 作 clientPlatform 参数
```

commercial 内部把 `clientPlatform` 映射为「本次请求可花的渠道桶」（`spendChannelOf()`：`ios→apple`，
`android→google`，其余（含缺省，兼容还没升级到这版客户端的旧请求）`→web`），**任一花费请求的有效余额 = 免费池
+ 该渠道桶**，扣款顺序**先扣免费池，免费池不够再扣渠道桶**（`base.ts` 的 `debitEffective()`，用 MongoDB 聚合
管道 `$expr` 做原子守卫 + 拆分扣减，同文档一次 `findOneAndUpdate` 完成，与既有扣币模式一致零事务）：

```
effectiveCoins(wallet, channel) = wallet.coins + (wallet.recharged?.[channel] ?? 0)
```

余额展示同理：`GET /internal/wallet` 现在接受可选 `clientPlatform`，返回的 `coins` 就是上面这个"对本次请求平台
而言的有效余额"——**同一个账号在 web 和 iOS 上可能看到不同的 `coins` 数字**，这是设计的直接后果而非 bug：例如
一个绑定了同一账号的玩家，web 端 Paddle 充的钱在 iOS App 里不可见/不可花，反之亦然；免费池部分两端看到的永远
一致。`getSave`（每次登录/刷新的主入口）已接入这套显示逻辑；`grant()` 类纯免费加币的少数边角调用点（邮件补偿、
背包满溢补偿、battlepass_claim 等）暂未逐一穿透 `clientPlatform`，其返回的 `coinsAfter` 在跨渠道场景下可能有
短暂的展示口径偏差（下次任意一次 `getSave`/spend 自动纠正）——不影响可花性，已知取舍，见 §11.5。

### 11.4 落地范围（改了什么）

- `server/commercial/src/spendChannel.ts`（新增）：`RechargeChannel` + `rechargeChannelOf`/`spendChannelOf`/
  `effectiveCoins`/`displayChannelOf` 四个纯函数，全部单测覆盖（`test/spendChannel.test.ts`）。
- `server/commercial/src/db.ts`：`WalletDoc.recharged` 字段。
- `server/commercial/src/service/base.ts`：`credit()`/新增 `debitEffective()`/`getWallet()`/`applySubscription()`/
  `subscriptionCardBuy()` 均加 `channel`（充值目标渠道）+ `clientPlatform`（展示/花费渠道）参数。
- `server/commercial/src/service/{shop,gachaDraw,recharge,subscription,starter,rewards,promo}.ts`：所有扣款/加币
  调用点穿透上述参数；`internalHttp.ts` 对应端点解析 `clientPlatform`/`rechargePlatform` 请求体字段。
- `server/metaserver/src/service/base.ts`：新增 `clientPlatformOf(req)`（读 `X-NW-Platform`）。`economy.ts`/
  `auth.ts`（改名扣币）/`progression.ts`（战令购买）/`pve.ts`（体力购买）/`equipment.ts`（强化/重铸扣币）/
  `save.ts`（`getSave` 余额镜像）/`paddle.ts`（webhook 侧硬编码 `web` 渠道）全部穿透。**未刻意选择不改**的是
  纯免费加币的边角调用点（§11.3 末段），风险已评估为可接受。
- `client/src/net/ApiClient/base.ts`：`fetchRaw()` 加 `X-NW-Platform` 请求头。
- 测试：`server/commercial/test/spendChannel.test.ts`（纯函数单测）+
  `server/commercial/test/walletChannelIsolation.e2e.test.ts`（真实 Mongo e2e：apple/web 充值互相不可见不可花、
  免费池处处可花、扣款先免费池后渠道桶、Paddle webhook 路径同样隔离），随现有 136 条 commercial 用例一起跑绿。

### 11.5 已知取舍 / 后续跟进

- **存量余额不回溯拆分渠道**（§11.2）：接受，见上。
- **少数纯免费 grant 调用点未穿透 `clientPlatform`**（§11.3 末段）：只影响那次响应里 `coinsAfter` 的展示口径，
  不影响可花性/资金安全，下次 `getSave`/任意花费请求自动纠正。若未来发现体验上确有感知，可补齐（清单：
  `liveops.ts` 签到/成就/每日任务、`social.ts` 邮件领取、`progression.ts` 战令领取、根 `economy.ts` 的背包满溢
  币补偿、`ads.ts` 独立广告端点）。
- **月卡/年卡/新手包在原生渠道的真实验单尚未上线**（`IOS_RELEASE.md` 待办：ASC 7 个 IAP 商品未建）：`recharged`
  的 `apple`/`google` 桶目前在生产环境恒为 0，这也是为什么现在改动是安全的——没有真实资金需要迁移，赶在有真实
  资金之前把机制落地正是本次改造的目的（`DECISIONS.md` ADR-020 原文："现在就要记入数据结构设计，避免后期迁移"）。
- **`X-NW-Platform` 是客户端自报的**，不是身份鉴权边界：伪造该头顶多是"在自己的钱包里选错桶"，不构成跨账号越权
  （每个账号的 `wallets` 文档仍按 `accountId` 隔离），且原生 App 二进制里这个值是硬编码派生自 `window.NWBilling`
  /构建期 `TARGET`，普通玩家无法在不修改客户端的情况下伪造；与本仓其余客户端可信边界的处理方式一致（如
  `platform` 字段用于广告奖励的信号验证同样只做签名校验，不做"客户端绝对可信"假设之外的加固）。
