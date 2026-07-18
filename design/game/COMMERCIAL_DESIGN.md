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
