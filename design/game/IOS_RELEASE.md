# iOS 上架手册（iPhone + iPad 通用 App）

> 创建：2026-07-03。适用：`client/`（Capacitor iOS 壳）+ GitHub Actions 云构建。
> 关联：[`IAP_CREDENTIALS.md`](IAP_CREDENTIALS.md)（Apple 验单凭据）、[`../product/release/store-assets-checklist.md`](../product/release/store-assets-checklist.md)（上架素材）、[`COMMERCIAL_DESIGN.md`](COMMERCIAL_DESIGN.md)（IAP 客户端契约）。
> 构建流水线：[`.github/workflows/release-ios.yml`](../../.github/workflows/release-ios.yml)。

## 0. 不可变身份（永久锁定，改了 = 新 App / 现有用户全丢）

以下值一旦上架就**永久不能改**。App 的身份 = Bundle ID + Apple 账号（Team），与签名证书无关。

| 项 | 值 | 说明 |
|---|---|---|
| **Bundle ID** | `com.gamestao.nivara` | App 唯一身份。改它 = 全新 App，老用户/存档/内购全断 |
| **App Store 名** | `Nivara: Notebook Wars` | ⚠️ 纯 `Nivara` 已被他人在 App Store Connect 占用（名称全局唯一、先到先得、与商标/是否发布无关），故商店标题加副标题规避。游戏内品牌名仍为 Nivara（内部代号 Notebook Wars）。≤30 字符（本名 21 字符 OK）。注：display name 本身其实可后改，此处锁的是"用哪个名"这一决策 |
| **设备族** | 通用（iPhone+iPad，`TARGETED_DEVICE_FAMILY = "1,2"`） | |
| **IAP Product ID 前缀** | `com.gamestao.nivara.coins.<tier>` | 由 Bundle ID 派生，见 §4.1 |
| **Apple 账号 / Team ID** | 你的 Developer 账号 | App 归属主体，守住账号 + 2FA 即可 |

**心智模型（放宽心用）**：真正不可逆的只有"丢了 Apple 账号本身"。除此之外——
- **签名证书 `.p12` / 描述文件 / ASC API Key `.p8`** 全部可**吊销后重新签发**，重签**不影响任何已发布版本和用户**（证书只是签章，不是身份）。
- 重签后唯一要做的：更新对应 GitHub Secret，下次构建照常。已在商店里的旧包用旧证书签、Apple 已收下，永久有效，不用动。

即：出任何证书/密钥事故 → 按 §2 重导一份就好，游戏还是那款游戏，无需额外担心。

## 0.1 架构（先读）

**一套 web 包 = 原生 App。** `webpack --env TARGET=mobile` 产出 `client/dist`，Capacitor 把它塞进 WKWebView 打包成原生 App。区别于 web 构建：

- 后端地址烘焙成**绝对生产地址**（`api.gamestao.com`），因为原生没有同源后端（`webpack.config.js` 的 `isMobile` 分支，含 `__NW_SOCIAL_BASE__`）。
- 入口 `src/entries/mobile.ts`：不做 web 版那种 `/version.json` 前台轮询 + `location.reload()`（原生 WKWebView 不能整页远程重载）。**JS/资源级的自动更新改由 OTA 热更新负责**（Capgo，见 §11），与 App Store 二进制更新解耦。
- **支付走 Apple IAP**：原生壳在 WKWebView 注入 `window.NWBilling`（`ios/App/App/AppDelegate.swift` 的 `NWBridgeViewController`），客户端 `WebPlatform.iapKind()` 检测到后把充值路由到 Apple（而非 web 的 Paddle）。收据 → `POST /iap/verify` → `server/commercial` 的 `appleVerify`（StoreKit 1 `verifyReceipt`，已实现）。

**关键身份**：Bundle ID `com.gamestao.nivara`，App Store 名 `Nivara: Notebook Wars`（纯 `Nivara` 被占，见 §0），通用（iPhone+iPad，`TARGETED_DEVICE_FAMILY = "1,2"`）。

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
- **3.3.1 热更新边界**：若启用 OTA（§11），热更只能改 JS/资源、不得改变主要用途或新增站外支付，否则违规可下架。原生改动一律走二进制发布。

## 11. OTA 热更新（Capgo 自托管，路线 B）

> 目标：改 JS / web 资源（战斗逻辑、UI、数值、美术）后，玩家**下次冷启动即自动拿到新版**，无需过 App Store 审核；同时保留本地包做离线兜底。**只能热更 web 层**——任何原生改动（新增 Capacitor 插件、`Info.plist`、`AppDelegate.swift` 的 IAP 桥、图标/启动图）仍必须走 §5 的二进制发布。

### 11.0 合规边界（先读，别踩线）

- 依据 **App Review Guideline 3.3.1**：解释型代码（JS）可远程更新，但**不得改变 App 的主要用途、不得新增需重新审核的功能**。热更只用于修 bug / 调平衡 / 换资源 / 迭代已审核过的玩法，OK。
- **严禁**通过 OTA 引入站外支付入口或绕过 Apple IAP 的充值路径（违反 3.1.1，可下架）。充值必须始终走 `window.NWBilling` → Apple（§6）。
- OTA 包 = `build:mobile` 产物（mobile 入口，Apple IAP、无 Paddle/web-only 逻辑），**不是** `a.gamestao.com` 上的 web 包。两者后端都烘焙到 `api.gamestao.com`，但入口与支付分支不同，别混用。

### 11.1 架构

```
玩家冷启动
  └─ WKWebView 加载「当前生效 bundle」(首装=App 内置本地包；之后=Capgo 下载的最新包)
       └─ mobile.ts 启动后 void checkOtaUpdate() (src/platform/ota.ts):
            1) CapacitorUpdater.notifyAppReady()   ← 必须, 否则 Capgo 判本包启动失败, 自动回滚上一版
            2) 拉 https://ota.gamestao.com/manifest.json
            3) 比对 manifest.version 与「当前运行 JS 里烘焙的 __NW_BUILD_VERSION__」
               (不是 Capgo 的 current().bundle.version——那对内置包返回 'builtin', 丢失真实版本;
                运行中的 JS 无论内置还是 OTA 包都带自己的 __NW_BUILD_VERSION__, 是最准的当前版本)
               且 manifest.minNativeVersion ≤ 本壳原生版本 current().native
            4) 若有更新 → 后台 download({url, version, checksum}) → next({id}) 排到下次冷启动生效
```

- **兜底与回滚**：Capgo 内置。下载校验失败、或新包启动后没调 `notifyAppReady()` → 自动回滚，不会把用户卡在坏版本。
- **生效时机**：用 `next()` 而非 `set()`——排到下次冷启动生效，**不当场重载**（不打断对局）。
- **健壮性**：`checkOtaUpdate()` 全程 try/catch + 8s 超时，dev 包（`__NW_BUILD_VERSION__==='0.0.0'`）与非原生环境（无插件）直接 no-op；任何失败静默留在当前包，网络差也不白屏。

### 11.2 客户端接入（已实现）

1. 依赖：`client/package.json` 已加 `@capgo/capacitor-updater ^6.0.0`（配 Capacitor 6）。装后需 `cap sync ios`（CI 的 `release-ios.yml` 已含 `cap sync`，会自动装原生插件）。
2. `capacitor.config.ts`：保持 `webDir: 'dist'`（本地包仍是首装兜底），**不设** `server.url`（那是路线 A）；已加手动模式插件配置：
   ```ts
   plugins: {
     CapacitorUpdater: { autoUpdate: false, resetWhenUpdate: true },
   },
   ```
3. OTA 逻辑在 [`src/platform/ota.ts`](../../client/src/platform/ota.ts) 的 `checkOtaUpdate()`，由 [`src/entries/mobile.ts`](../../client/src/entries/mobile.ts) 在 `startApp` 后 `void checkOtaUpdate()` 触发：`notifyAppReady()` → 拉 manifest → 版本 + `minNativeVersion` 比对 → `download()` → `next({id})`。
4. **首个带插件的壳必须先走一次 App Store 发布**（§5）——OTA 无法给自己引导安装。此后纯 JS 改动才能走 OTA。

### 11.3 版本号与产物

- 沿用 `NW_BUILD_VERSION`（`webpack.config.js` 注入 `__NW_BUILD_VERSION__`）。OTA bundle 版本 = 这个值，需**单调递增**（如 `1.2.3`）。CI 从 tag `ota-v<version>` 解析后烘焙进包。
- OTA bundle = `build:mobile` 的 `client/dist` 整目录打成 zip。
- `checksum`：manifest 里可选字段。**首版先不带**——Capgo 各大版本校验算法不同（v5 CRC32、v6 起 sha256），填错会让所有下载被拒、更新彻底卡死。上线跑通后，确认当前插件版本的算法再补，属硬化项而非阻塞项。

### 11.4 托管（Cloudflare R2，自定义域 `ota.gamestao.com`）

zip 包适合走 CDN 边缘缓存分发，而 Workers 静态资源不适合堆积多版本 zip，故用 **R2 桶 + 自定义域**（单层子域，被免费 `*.gamestao.com` 通配证书覆盖）：

| URL | 内容 |
|---|---|
| `https://ota.gamestao.com/manifest.json` | `{ "version": "1.2.3", "url": "https://ota.gamestao.com/1.2.3.zip", "minNativeVersion": "1.0.0" }`；**no-cache**（上传时 `--cache-control`） |
| `https://ota.gamestao.com/<version>.zip` | 对应版本 `dist` 打包；版本化文件名，**可长缓存** |

一次性设置（Cloudflare 后台）：建 R2 桶（默认名 `nivara-ota`）→ 桶 Settings 绑定自定义域 `ota.gamestao.com`（自动建 DNS + 边缘证书）→ 建一个有该桶写权限的 API Token。

> `minNativeVersion` 是关键闸门：当某次 web 改动依赖了新的原生能力时，把它抬到「含该能力的壳版本」（改 `ota-publish.yml` 的 `MIN_NATIVE`），老壳就不会误拉到跑不起来的包，直到用户从 App Store 升级原生壳。

### 11.5 发布流程（两条独立管线）

| 场景 | 触发 | 管线 | 是否过审 |
|---|---|---|---|
| **原生二进制**（新插件 / Info.plist / IAP 桥 / 图标 / 首个 OTA 壳） | tag `ios-v*` | `release-ios.yml`（§5，macOS runner） | 是 |
| **OTA 热更**（纯 JS/资源迭代） | tag `ota-v*`（或手动 workflow_dispatch 填版本） | [`ota-publish.yml`](../../.github/workflows/ota-publish.yml)：`build:mobile`（烘焙版本）→ zip → `wrangler r2 object put` 传 zip，再传 manifest（**顺序：先 zip 后 manifest**，避免 manifest 指向尚未上传的包） | **否** |

OTA 管线**不需要 macOS runner**（无原生编译），`ubuntu-latest` 即可，几十秒完成。需 repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`。发 OTA 前务必确认改动**不含**任何原生依赖，否则老壳会拿到跑不起来的包（靠 `minNativeVersion` 兜底，但仍应人工确认）。

### 11.6 落地待办

**已完成（本分支代码）**
- [x] `client/package.json` 加 `@capgo/capacitor-updater ^6.0.0`
- [x] `capacitor.config.ts` 加 `plugins.CapacitorUpdater`（手动模式）
- [x] 新建 `src/platform/ota.ts`（`notifyAppReady` / 拉 manifest / 版本 + `minNativeVersion` 比对 / `download` / `next`）+ `mobile.ts` 接入
- [x] 新建 `.github/workflows/ota-publish.yml`（tag `ota-v*` → build:mobile → zip → R2）

**待你操作（基础设施 / 发布）**
- [x] Cloudflare 建 R2 桶 `nivara-ota` + 绑自定义域 `ota.gamestao.com` + 建写权限 API Token（**2026-07-21 确认**：`ota-publish.yml` 跑通，实际发布 1.0.1，manifest + zip 均可公网访问；bucket 已加 180 天对象过期规则）
- [x] repo secrets 加 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
- [ ] 合并本分支后，`cap sync ios` 确认插件进原生工程；首个带插件的壳走一次 §5 二进制发布（`ios-v*`）
- [ ] 真机验证 `notifyAppReady` 生效、无回滚误触
- [ ] 端到端演练：发一个 `ota-v` 小改动 → 真机冷启动两次 → 确认自动更新到新版；断网启动 → 确认落回当前包不白屏
- [ ] （硬化）确认插件 checksum 算法后，给 `ota-publish.yml` 的 manifest 补 `checksum` 字段

## 12. 待办 checklist

- [ ] Apple Developer：建 App ID（勾 IAP）+ ASC App 记录
- [ ] 生成 Distribution 证书 `.p12` / App Store 描述文件 / ASC API Key `.p8`
- [ ] 配齐 §3 的 9 个 GitHub Secrets
- [ ] ASC 建 7 个消耗型 IAP 商品（§4.1）+ 填 App 专用共享密钥
- [ ] VPS commercial 设 `NW_IAP_BUNDLE=com.gamestao.nivara` + `NW_APPLE_PASSWORD`，重启
- [ ] 美术：iPhone 6.7"/6.5" + iPad 12.9" 截图
- [ ] 填隐私标签 + App 描述（三语）
- [ ] 推 `ios-v1.0.0` 触发构建 → TestFlight 沙盒账号走通一次充值→发币对账
- [ ] 提交审核
