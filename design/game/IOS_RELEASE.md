# iOS 上架手册（iPhone + iPad 通用 App）

> 创建：2026-07-03。适用：`client/`（Capacitor iOS 壳）+ GitHub Actions 云构建。
> 关联：[`IAP_CREDENTIALS.md`](IAP_CREDENTIALS.md)（Apple 验单凭据）、[`../product/release/store-assets-checklist.md`](../product/release/store-assets-checklist.md)（上架素材）、[`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)（IAP 客户端契约）。
> 构建流水线：[`.github/workflows/release-ios.yml`](../../.github/workflows/release-ios.yml)。

## 0. 架构（先读）

**一套 web 包 = 原生 App。** `webpack --env TARGET=mobile` 产出 `client/dist`，Capacitor 把它塞进 WKWebView 打包成原生 App。区别于 web 构建：

- 后端地址烘焙成**绝对生产地址**（`api.gamestao.com`），因为原生没有同源后端（`webpack.config.js` 的 `isMobile` 分支，含 `__NW_SOCIAL_BASE__`）。
- 入口 `src/entries/mobile.ts`：不做 `/version.json` 前台轮询重载（原生包随 App Store 更新，不能远程重载）。
- **支付走 Apple IAP**：原生壳在 WKWebView 注入 `window.NWBilling`（`ios/App/App/AppDelegate.swift` 的 `NWBridgeViewController`），客户端 `WebPlatform.iapKind()` 检测到后把充值路由到 Apple（而非 web 的 Paddle）。收据 → `POST /iap/verify` → `server/commercial` 的 `appleVerify`（StoreKit 1 `verifyReceipt`，已实现）。

**关键身份**：Bundle ID `com.gamestao.nivara`，App 名 `Nivara`，通用（iPhone+iPad，`TARGETED_DEVICE_FAMILY = "1,2"`）。

## 1. 前置准备（Apple Developer）

1. **Apple Developer Program**（$99/年）已加入。
2. **App ID**：在 [developer.apple.com](https://developer.apple.com) → Certificates, IDs & Profiles → Identifiers 新建 App ID `com.gamestao.nivara`，勾选 **In-App Purchase** 能力。
3. **App Store Connect 记录**：[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Apps → 新建 App，选上面的 Bundle ID，平台 iOS，可用性含 iPhone + iPad。

> 无 Mac 也能全程走完：证书/描述文件在 Apple 后台在线生成，构建在 GitHub Actions 的 macOS runner 上跑。**只有本地调试才需要 Mac**（§8）。

## 2. 签名材料（三样，转 base64 进 GitHub Secrets）

| 材料 | 从哪来 | 说明 |
|---|---|---|
| **Distribution 证书 `.p12`** | Developer 后台 → Certificates → **Apple Distribution**（或 iOS Distribution）；导出为 `.p12` 时设密码 | CI 用它签名 |
| **App Store 描述文件 `.mobileprovision`** | Developer 后台 → Profiles → **App Store** 类型，绑定 `com.gamestao.nivara` + 上面的证书 | 记住它的 **Name** |
| **App Store Connect API Key `.p8`** | ASC → Users and Access → Integrations → App Store Connect API → 新建 Key（角色 App Manager 即可） | 用于 `altool` 上传，记住 Key ID + Issuer ID |

> `.p12` 无法直接在线导出：需在一台 Mac（或借用）用「钥匙串」导出一次，或用 Apple 后台生成 CSR 流程。这是唯一可能需要 Mac 摸一下的点；证书三年有效，做一次即可。若完全没有 Mac，可用在线 CSR 工具生成密钥对后在后台签发，再打包成 `.p12`。

转 base64（在任意机器）：
```bash
base64 -i dist_cert.p12 -o cert.b64
base64 -i nivara_appstore.mobileprovision -o profile.b64
base64 -i AuthKey_XXXX.p8 -o asckey.b64
```

## 3. GitHub Secrets 清单

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 |
|---|---|
| `BUILD_CERTIFICATE_BASE64` | `cert.b64` 内容 |
| `P12_PASSWORD` | 导出 `.p12` 时设的密码 |
| `KEYCHAIN_PASSWORD` | 任意字符串（runner 临时钥匙串口令） |
| `BUILD_PROVISION_PROFILE_BASE64` | `profile.b64` 内容 |
| `PROVISIONING_PROFILE_NAME` | 描述文件的 Name（后台所示） |
| `APPLE_TEAM_ID` | 10 位 Team ID |
| `ASC_API_KEY_ID` | API Key 的 Key ID |
| `ASC_API_ISSUER_ID` | API 的 Issuer ID |
| `ASC_API_KEY_CONTENT_BASE64` | `asckey.b64` 内容 |

## 4. IAP 商品配置（充值发币的前提）

### 4.1 App Store Connect 建商品
在 ASC → 你的 App → **App 内购买项目** 新建 **7 个消耗型（Consumable）**，Product ID 用 `<bundle>.coins.<tier>`：

| Product ID | 金币 | 参考美元价 |
|---|---|---|
| `com.gamestao.nivara.coins.t099`  | 100   | $0.99 |
| `com.gamestao.nivara.coins.t199`  | 210   | $1.99 |
| `com.gamestao.nivara.coins.t499`  | 550   | $4.99 |
| `com.gamestao.nivara.coins.t999`  | 1150  | $9.99 |
| `com.gamestao.nivara.coins.t1999` | 2400  | $19.99 |
| `com.gamestao.nivara.coins.t4999` | 6500  | $49.99 |
| `com.gamestao.nivara.coins.t9999` | 13500 | $99.99 |

金币数以 `server/shared/src/economy.ts` 的 `IAP_TIERS` 为唯一权威（此表随之为准）。iOS 提供全 7 档（web/Paddle 仅 t499 起）。

### 4.2 服务端环境变量（VPS commercial）
- `NW_IAP_BUNDLE=com.gamestao.nivara` —— **必须改**（默认 `com.nw` 会匹配不到商品，fail closed 发失败）。
- `NW_APPLE_PASSWORD=<App 专用共享密钥>` —— ASC →「App 内购买项目」→ App 专用共享密钥。
- 生产必须 `NODE_ENV=production` 且 **不设** `NW_IAP_DEV`（详见 [`IAP_CREDENTIALS.md`](IAP_CREDENTIALS.md) §0）。

> 客户端请求的 Product ID 由 `AppDelegate.swift` 自动派生自 App 的 Bundle ID（`<bundleId>.coins.<tierId>`），与上表一致，无需额外配置。

## 5. 构建与发布

**自动**：推一个 tag 触发。
```bash
git tag ios-v1.0.0 && git push origin ios-v1.0.0
```
**手动**：Actions → “iOS - Build & Release” → Run workflow（可选 testflight / appstore）。

流水线做的事（`release-ios.yml`）：`npm ci` → `build:mobile` → `cap sync ios`（回填 `dist`→`ios/.../public` + `pod install`）→ `agvtool` 用 run number 写 build 号 → 导入证书/描述文件 → `xcodebuild archive` + `-exportArchive` → `altool --upload-app` 传到 App Store Connect。产物 `.ipa` 也作为 artifact 留档。

上传后进入 ASC 的 TestFlight（处理约 5–15 分钟），再在 ASC 提交审核发布。

## 6. StoreKit 桥（实现说明）

- JS 契约：`client/src/platform/iap.ts` 的 `NwBillingBridge`（`window.NWBilling.purchase(tierId) → { receipt }`）。
- 原生实现：`ios/App/App/AppDelegate.swift` 的 `NWBridgeViewController`（`CAPBridgeViewController` 子类，经 `Main.storyboard` 挂载，**不新增工程文件**，随 App target 编译）。StoreKit 1：`SKProductsRequest` 取商品 → `SKPaymentQueue` 下单 → 成功后读 `appStoreReceiptURL` 的 base64 收据回传 JS。
- 校验：客户端把 `{ platform:'apple', receipt }` POST 到 `/iap/verify`；`server/commercial/src/iap.ts` 的 `appleVerify` 打 Apple `verifyReceipt`（生产返 21007 自动回退 sandbox），读 `in_app[]` 最新 `product_id` 映射金币。

## 7. 上架素材（素材清单见 store-assets-checklist）

- **App 图标**：已生成 `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`（1024²，无 alpha，笔记本三笔纹章）。
- **启动图**：已生成 Splash（2732²，纸面 + logo）。
- **截图**（仍待美术，规格）：iPhone 6.7"（1290×2796）、iPhone 6.5"（1242×2688）、**iPad 12.9"（2048×2732，通用 App 必需）**，各 ≥3 张。
- 隐私标签（Privacy Nutrition Label）：按 [`store-assets-checklist.md`](../product/release/store-assets-checklist.md) §0.3 与隐私政策一致填写（设备 ID / 账号 / 埋点 / 支付）。
- 出口合规：`Info.plist` 已设 `ITSAppUsesNonExemptEncryption=false`，免每次填问卷。

## 8. 本地开发者路径（有 Mac 时可选）

```bash
cd client
npm ci
npm run deploy:ios     # build:mobile + cap sync ios
npm run cap:open:ios   # 打开 Xcode（真机调试 / 手动 Archive）
```
Windows 上可做的验证仅限 `tsc --noEmit` + `webpack --env TARGET=mobile`；原生编译与 IAP 沙盒联调在 CI 或 Mac 上完成。

## 9. 审核注意（避免拒审）

- **4.2 最低功能**：本 App 是完整可玩游戏（非套壳网站），有本地战役/联机/养成，满足。
- **3.1.1 数字商品必须走 IAP**：已实现（原生检测 `window.NWBilling` 走 Apple；Paddle 仅 web 生效，原生包无 Paddle 入口）。切勿在原生内出现引导站外支付的文案/链接。
- **登录**：匿名设备登录（`getAuthCredential` device），无强制第三方登录 → 无需 Sign in with Apple。
- **iPad 必测**：通用 App 审核会在 iPad 上跑，务必补 iPad 截图且 iPad 上无布局破裂。

## 10. 待办 checklist

- [ ] Apple Developer：建 App ID（勾 IAP）+ ASC App 记录
- [ ] 生成 Distribution 证书 `.p12` / App Store 描述文件 / ASC API Key `.p8`
- [ ] 配齐 §3 的 9 个 GitHub Secrets
- [ ] ASC 建 7 个消耗型 IAP 商品（§4.1）+ 填 App 专用共享密钥
- [ ] VPS commercial 设 `NW_IAP_BUNDLE=com.gamestao.nivara` + `NW_APPLE_PASSWORD`，重启
- [ ] 美术：iPhone 6.7"/6.5" + iPad 12.9" 截图
- [ ] 填隐私标签 + App 描述（三语）
- [ ] 推 `ios-v1.0.0` 触发构建 → TestFlight 沙盒账号走通一次充值→发币对账
- [ ] 提交审核
