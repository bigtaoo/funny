# commercial — 客户端充值入口 + 钱包渠道隔离（§10 起）

> 从 [`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md) 拆出（2026-08-17，原文件 594 行）。**小节编号沿用原文**，`COMMERCIAL_DESIGN.md §N` 引用照旧有效。
> 本册内容：§10 分平台路由（IAP client）、§11 钱包按支付渠道隔离（ADR-020）。总览与在先小节见 [`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)。

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
