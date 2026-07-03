# IAP / 广告凭据上线手册（L2-3）

> 创建：2026-06-23（上线收口 Track 2 L2-3）。
> 适用：`server/commercial`（IAP 验单）+ `server/metaserver`（广告验签）。
> 验签逻辑权威：[`server/commercial/src/iap.ts`](../../server/commercial/src/iap.ts)（IAP）、[`server/metaserver/src/ads.ts`](../../server/metaserver/src/ads.ts)（广告）。
> 环境变量样板：[`server/.env.example`](../../server/.env.example)。

## 0. 核心安全约定（务必先读）

- **无凭据 = fail closed**：任一平台缺凭据时，该平台验单/验签返失败（充值请求收 `INVALID_RECEIPT`），**绝不发币**。
- **dev 桩仅本地**：`NW_IAP_DEV=true` 或「所有 IAP 凭据均缺失」时启用 dev 桩（`tier:xxx` / `platform=dev` 收据免验签直接给币），**只供本地联调**。
- **生产双保险（L2-3 加固）**：
  1. `commercial` 进程引导期检测 `NODE_ENV=production && NW_IAP_DEV=true` → **拒启**（`index.ts`，fail fast）。
  2. `createReceiptVerifier` 在 `NODE_ENV=production` 下**强制关闭** dev 桩——既不因 `NW_IAP_DEV=true` 误开，也不因缺凭据自动回退（`iap.ts` 第二道防线）。
- 充值幂等键 = `${platform}:${receipt}`，由 `commercial.rechargeVerify` 守卫（重复回调不重复发币）。

## 1. IAP 平台凭据

| 平台 | 环境变量 | 申请位置 | receipt 格式 |
|---|---|---|---|
| Apple App Store | `NW_APPLE_PASSWORD` | App Store Connect →「App 内购买项目」→ App 专用共享密钥 | base64 receipt data |
| Google Play | `NW_GOOGLE_SERVICE_ACCOUNT_JSON`（整串）+ `NW_GOOGLE_PACKAGE_NAME` | GCP 创建服务账户 JSON；Play Console 授予该账户「查看财务数据/管理订单」权限 | `${productId}:${purchaseToken}` |
| 微信支付 V3 | `NW_WX_PAY_MCH_ID` + `NW_WX_PAY_API_KEY_V3` | 微信商户平台「API 安全」→ V3 APIKey（32 字节） | `transaction_id` |
| Stripe（Web） | `NW_STRIPE_SECRET_KEY` | Stripe Dashboard → API keys（`sk_live_*` 生产 / `sk_test_*` 沙盒） | `payment_intent_id`（`pi_*`） |

### 产品 ID / 金额 → 档位映射

- `NW_IAP_PRODUCT_MAP`（可选，Apple/Google）：`productId:tier,...`；不填用默认约定 `${NW_IAP_BUNDLE}.coins.<tierId>`，其中 `<tierId>` 为 `IAP_TIERS` 的键（`t099/t199/t499/t999/t1999/t4999/t9999`），例如 `com.nw.coins.t499`。
- `NW_IAP_BUNDLE`（默认 `com.nw`）：默认产品 ID 的前缀。
- `NW_IAP_AMOUNT_MAP`（可选，微信/Stripe）：`amount:tier,...`；不填时内置默认按 `IAP_TIERS_LIST.usdCents` 匹配 **Stripe 美元价（cents）→ 档位**（99→t099 … 9999→t9999）。**微信按人民币分（fen）计价，经济配置中无对应人民币锚点价，微信渠道必须显式配置 `NW_IAP_AMOUNT_MAP`**，否则金额匹配不到档位（fail closed，发失败）。

档位金币数与档位 ID 均以 `@nw/shared` 的 `IAP_TIERS` / `IAP_TIERS_LIST` 为准。

### 1.1 Paddle（Web 充值通道）

Web 端充值走 Paddle（非上面的 `/iap/verify`，而是 `metaserver/src/paddle.ts` 的 `/shop/paddle/checkout` + `/paddle/webhook`）。验签/加币逻辑权威见该文件。

| 环境变量 | 说明 | 缺省行为 |
|---|---|---|
| `NW_PADDLE_API_KEY` | Paddle 密钥（`sk_live_*` / `sk_test_*`），服务端创建 transaction 用 | 缺失 → `/shop/paddle/checkout` 返 `PADDLE_ERROR` |
| `NW_PADDLE_WEBHOOK_SECRET` | Webhook 签名密钥（Paddle 后台） | 缺失 → `/paddle/webhook` 返 503 |
| `NW_PADDLE_CLIENT_TOKEN` | Paddle.js **客户端** token（`ptok_`/`live_`/`test_`，客户端安全） | 缺失 → **`/bootstrap` 不下发**，web 客户端无法发起 checkout（Coins tab 点击提示 `shop.rechargeError`） |
| `NW_PADDLE_PRICE_IDS` | 档位→Paddle price ID 映射 `t499:pri_xxx,...` | 缺失 → 对应档位 `INVALID_TIER` |
| `NW_PADDLE_SANDBOX` | `true` = 用沙盒 API | 默认生产 |

> **客户端 token 下发路径（本轮新增）**：`NW_PADDLE_CLIENT_TOKEN` 配置后，`metaserver.MetaService.bootstrap` 在 `GET /bootstrap` 响应里附带 `paddleClientToken`；web 客户端 `FeatureFlags` 缓存并交给 `ShopScene` 的 Paddle checkout。token 前缀 `test_` 时客户端自动切 Paddle sandbox 环境。详见 `COMMERCIAL_DESIGN.md §10`。

## 2. 广告验签凭据（激励视频，C2）

| 平台 | 环境变量 | 说明 | 缺省行为 |
|---|---|---|---|
| AdMob 客户端 | `NW_ADMOB_CLIENT_KEY` | adToken = HMAC-SHA256(transactionId, key) | 留空 → 放行（靠凭证唯一性 + 每日 cap 防刷） |
| 微信激励视频客户端 | `NW_WECHAT_ADS_CLIENT_KEY` | 同上 | 同上 |
| 微信广告 SSV 回调 | `NW_WECHAT_ADS_KEY` | 服务端回调验签 | 留空 → 放行 |

> AdMob SSV 服务端回调用 Google 公开验证密钥（`gstatic.com/admob/reward/verifier-keys.json`），无需配置环境变量。

## 3. 上线前 checklist

> **iOS 专项**：Apple 渠道的商店/证书/云构建全流程见 [`IOS_RELEASE.md`](IOS_RELEASE.md)。要点：App Bundle 为 `com.gamestao.nivara`，commercial 必须设 `NW_IAP_BUNDLE=com.gamestao.nivara`（默认 `com.nw` 匹配不到商品，fail closed），并在 ASC 建 7 个消耗型商品 `com.gamestao.nivara.coins.t099…t9999`。

- [ ] 至少配齐目标渠道的真实 IAP 凭据（海外：Apple + Google + Stripe；中国：微信支付）。
- [ ] 生产环境 `NW_IAP_DEV` **不设或设为 `false`**（设 `true` 会被 commercial 拒启）。
- [ ] 生产进程 `NODE_ENV=production`（确保 dev 桩双保险生效）。
- [ ] 各平台后台已创建对应内购商品（productId 与 `NW_IAP_PRODUCT_MAP` / 默认前缀一致）。
- [ ] 用沙盒账号（Apple Sandbox / Google 测试轨道 / Stripe `sk_test_`）走通一次充值→发币→钱包镜像对账。
- [ ] 广告：配齐 `NW_ADMOB_CLIENT_KEY` / 微信广告密钥（若上激励视频变现）。

## 4. 故障排查

- 充值返 `INVALID_RECEIPT`：对应平台凭据缺失或验签失败 → 查 commercial 日志的平台分支返回值。
- 生产 commercial 启动即退出并打印 `FATAL: NW_IAP_DEV=true`：移除该环境变量或设 `false`。
- 本地联调收 `INVALID_RECEIPT`：确认未误设 `NODE_ENV=production`，且用 `tier:<tierId>`（如 `tier:t499`）形式的 dev 收据。
