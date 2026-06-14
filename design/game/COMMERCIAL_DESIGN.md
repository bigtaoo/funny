# Notebook Wars — commercial 商业服务设计文档

> 创建：2026-06-14。本文件是**第 6 个服务 `commercial`**（钱包 / 充值 / 消费 / 盲盒 RNG / 流水）的设计基准。
> 配套：`META_DESIGN.md`（总架构，§1.1/§6.1 拓扑已扩为 6 组件）、`SERVER_API.md`（§9 commercial 内部契约）、`ECONOMY_BALANCE.md`（数值）、`ACCOUNT_DESIGN.md`（账号）。
> 状态：**设计稿，未实现**。任务编号见 `META_TASKS.md` S5-*。

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
  meta ──POST /internal/gacha/draw {accountId,poolId,count,orderId}──→ commercial
     commercial(单文档原子):
        1) wallets 扣币(coins>=cost 守卫) + 更新 pity        ┐ 一个 findOneAndUpdate
        2) crypto 真随机按 weight + 保底 → results           ┘ 同文档
        3) 写 ledger(delta=-cost, orderId) + gachaHistory + orders(status:'charged')
        ← { orderId, coinsAfter, pityAfter, results }
  meta:
        4) 据 results 把物品写进 saves.inventory（幂等：若 save 已记录该 orderId 已发则跳过）
        5) ──POST /internal/order/delivered {orderId}──→ commercial (orders.status:'delivered')
        6) save.wallet.coins = coinsAfter；save.gacha.pity = pityAfter（镜像）
  客户端 ← { save: SaveData, results }（播开箱动画）
```

**崩溃恢复（对账）**：
- meta 在第 3 步后、第 4 步前崩 → commercial 有 `status:'charged'` 但未 `delivered` 的订单。**对账兜底**：玩家下次 `GET /save` 时 meta 调 commercial 拉「该账号未发货订单」→ 补发物品 → 标 delivered。订单含完整 `result`，发货可重放且幂等。
- 第 4 步成功、第 5 步失败 → 订单停在 `charged`，下次对账重发 delivered（meta 发货幂等，不会重复给物品）。
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

---

## 7. 服务形态与部署

- **包**：新增 workspace `server/commercial`（CJS，结构对齐 gameserver：`config.ts` / `index.ts` / `service.ts` / `db.ts`）。
- **端口**：`NW_COMM_PORT`（默认 18082；避开 Windows 保留段 8082）。
- **库**：`NW_COMM_MONGO_URI`（默认复用同一 Mongo 实例）+ `NW_COMM_MONGO_DB`（默认 `notebook_wars_commercial`）。**库名独立、实例可同可分**——前期同实例不同库，涨了整库迁独立实例。
- **鉴权**：`NW_INTERNAL_KEY`（meta 与 commercial 共享；缺失则拒绝所有 `/internal/*`）。
- **契约**：内部 RPC 走 JSON（低频、便于调试），契约登记在 `SERVER_API.md §9`；**不进 protobuf**（protobuf 只管 WS 热路径，`M12`）。
- **索引**：`ledger(accountId,ts↓)`、`orders(accountId,status)`、`orders(status,ts)`（对账扫描未发货）、`recharges` `_id` 天然唯一。
- **零依赖游戏逻辑**（`M12`）：commercial 不 import `code/src/game`。

---

## 8. 与现状的差异与迁移要点

1. **shared/src/mongo.ts**：从 meta 库集合表移除 `gachaHistory`/`walletLog`/`iapReceipts`；新增 commercial 库工厂（或在 commercial 包内建自己的 `createCommercialMongo`）。
2. **SaveData**：`wallet.coins`/`gacha.pity` 改注释为「只读镜像，权威在 commercial」；同步段白名单不变（本就排除 wallet/gacha）。需加迁移步骤（version bump）——但因字段形状不变，主要是语义变更，迁移可能无操作。
3. **meta service.ts**：`/shop/buy`、`/gacha/draw`、`/ads/reward`、`/iap/verify` 从 501 占位改为「校验 + 调 commercial + 写 inventory + 回推」编排实现；`GET /save` 加余额镜像拉取。
4. **客户端**：基本零改动（继续读 `save.wallet.coins`、调 meta 端点）。新增 ShopScene/GachaScene（`UI_DESIGN §4.3/§4.4`）属 S2 客户端，与本服务并行。

---

## 9. 开放问题（实现前需拍板）

- [ ] **同实例 vs 同库**：前期 commercial 库与 meta 库同 Mongo 实例（省成本）确认 OK？还是一开始就独立实例？（默认：同实例不同库）
- [ ] **对账触发**：未发货订单对账放在 `GET /save` 顺带做，还是独立定时扫 `orders(status:'charged', ts<now-30s)`？（默认：GET /save 顺带 + 兜底定时扫）
- [ ] **充值平台**：首期接哪些渠道（微信虚拟支付 / Web 第三方）？验票据逻辑依赖具体平台。
- [ ] **余额镜像新鲜度**：客户端长时间不操作时镜像会旧——是否需要在进商店前强制 `GET /save` 刷新？（默认：进 ShopScene 前刷新一次）
