# 资源分包与加载策略（ASSET_PACKAGING）

> 状态：实现中 · 权威：本文（资源分层/加载/分包的单一来源）· 更新：2026-08-17（§11 首屏加载策略优化：preload 提示 + L0 双层 + L1 空闲预取；§11.4 补齐回归测试）

游戏要在 **Web（含 CrazyGames）/ 微信小游戏 / 手机套壳** 三个平台发布，三者对"资源何时进内存"的约束完全不同。本文锁定：

- **资源分几层**（启动必需 / 按需 / 永不进包）以及每层的归属文件；
- **三平台各自的加载机制**（Web 加载界面闸门 / 微信 CDN 远程+本地缓存 / 手机全量打包）；
- **代码侧的注入点与抽象**（`AssetIO` + 启动清单 + 加载界面）。

底线（用户拍板）：**首次加载必须保证 ——「新手引导走完 + 大厅正常显示 + 第一局正常开始」**。第一局任何单位都不允许以占位圆圈出现。

---

## 1. 现状（实测，2026-06-29）

webpack 当前对图片 / `.tao` 用 `asset/resource`，每个资源被发成**独立带 contenthash 的外链文件**，`import` 只换成一个 URL 字符串；真正下载发生在 `PIXI.Texture.from(url)` / `StickmanRuntime.loadAsset(url)`（内部 `fetch`）执行时。

| 项 | 实测 |
|---|---|
| `dist/index.js`（代码包，无 code-split） | ~1.5 MB |
| dist 外链资源（25 文件，未内联进 JS） | ~7.0 MB |
| `client/src/assets/`（打包候选池，含 gacha 3.3 MB） | ~9.4 MB |
| `art/` 下 `.xcf` / `.tao.editor` 等**源文件** | ~47 MB（**从不进包**） |

**结论：**
- **Web 端其实已经是"按场景懒下载"**（gacha 大图只在进抽卡场景才拉）。两个真缺口是：① 没有"启动必需资源"的预加载闸门 → 单位 `.tao` 没加载完时用圆圈占位；② 微信小游戏有主包体积红线，全量塞不下。
- `art/` 源目录不被 `client/src` 引用，天然不进包，无需处理。

---

## 2. 三层分级模型

| 层 | 何时加载 | 归属 | 体量 |
|---|---|---|---|
| **L0 启动必需** | 启动闸门内 `await` 完才进大厅（带加载进度） | 代码核心包 + 大厅/战场装饰三组 atlas（A `decor_atlas` / B `label_*` / C `decor_c_atlas`）+ 开局三兵 `infantry/archer/shieldbearer` 的 `.tao`+卡图 `.png` + `game_base`/兵营卡图 | 代码 ~1.5 MB + 资源 ~1.8 MB |
| **L1 按需** | 进对应场景时懒加载（HTTP/CDN 按 URL 拉） | gacha 全套（卡背/框/banner/月卡 3.3 MB）、英雄单位 `max/lena/mara` 的 `.tao`+`.png`（`max.tao` 单个 ~600 KB）、法术卡图、收集册大图、装饰 C 组之外的氛围图 | ~5 MB |
| **L2 永不进包** | — | `art/` 下全部 `.xcf` GIMP 源、`.tao.editor` 编辑元数据、地图/概念源图 | ~47 MB |

**L0 清单的单一来源 = `client/src/assets/bootManifest.ts`**。新增"开局必现"的资源往该清单加一条；其余一律默认 L1（不进闸门）。**保持 L0 极小**是这套设计的纪律——每加一条都拖慢首屏。

> ⚠ **L0 自 2026-08-17 起内部再分两层**（§11.2）：`STEPS` 阻塞加载进度条，`BACKGROUND_STEPS` 在闸门之后才起、由 `enterBattle` 闸门（§10）重新 await。上表"L0 归属"一列列出的装饰 atlas 和三兵 `.tao` 现在都在**背景层**。往 `bootManifest.ts` 加资源时先问"**玩家必须等它吗**"而不是"它是不是 L0"——大厅不画的一律进背景层，且必须确认 `ensureBattleAssets` 也会 await 它（`bootManifestTiers.ui.ts` 会强制这一点）。

---

## 3. Web / CrazyGames —— 加载界面 + L0 闸门

资源已天然懒下载，只补两件事：

1. **预 boot CSS 闸门**：`public/web/index.html` 内联一个纯 CSS 的"翻开笔记本"加载占位，页面一打开（JS 还在下载/解析时）立即可见，`startApp` 接管后移除。覆盖 JS 下载窗口。
2. **PIXI 加载界面 + L0 预加载闸门**（核心）：`startApp` 创建 PIXI App 后，在进首屏前：
   - 构造 `LoadingOverlay`（手绘进度条，置于 stage 顶层）；
   - `await preloadBoot(onProgress)`——把 L0 清单逐项加载并回报进度；
   - 闸门内 **CrazyGames 的 SDK loading splash 保持到我们的资源就绪**（`platform.onLoadingComplete()` 在闸门之后调用）；
   - 完成后销毁 overlay，再 `core.start()` 进引导/大厅。

`preloadBoot` **永不 reject**：每项各自 try/catch 并照常推进进度——纯装饰项失败只是少点氛围，开局兵 `.tao` 失败则退回占位圆圈（绝不卡死闸门）。

> 代码层 JS 分包（`splitChunks` 抽 vendor + 重场景 `import()` 动态切块）是后续优化项，可把首屏代码包从 ~1.5 MB 压到 ~0.8 MB。**本期未做**（与微信单包打包策略有耦合，单列）。

---

## 4. 微信小游戏 —— 方案 A：主包仅 L0，L1 走 CDN 远程 + 本地缓存

微信小游戏有主包体积红线（历史主包 ≤ 4 MB、可分包、总量上限以**上线当时官方文档为准**），全量 ~9.4 MB 塞不进主包。**采用方案 A**（大型微信小游戏标准做法，且远程资源更新免过审）：主包只打代码，所有美术资源托管在 CDN，运行时按需拉取 + 本地缓存。

### 4.0 构建：微信改用 webpack（ADR：废弃 rollup）

原 `rollup.config.cjs` 流水线**早于 `@nw/engine` 抽离**，缺 alias / 资源插件 / define 注入，已与主代码脱节、整体不可编译，**已删除**。微信改走与 Web 同一份 `webpack.config.js`（`TARGET=wechat` 分支），白嫖 web 已上线验证的 alias + `asset/resource` + `DefinePlugin`：

- **入口**：`src/entries/wechat.ts`（首行 `@pixi/unsafe-eval`，适配微信无 `eval` 运行时）。
- **输出**：单 IIFE → `wechatgame/pixigame.js`（壳层 `game.js` 里 `require('./pixigame.js')` 自执行）；`clean:false` 保住 `game.js/game.json`；`globalObject:'globalThis'` 适配微信运行时。
- **`asyncChunks: false`（"单文件"不是描述而是约束，2026-08-17 补）**：微信运行时**没有动态 import / chunk 加载能力**，壳层也只 `require('./pixigame.js')` 这一个文件、`project.private.config.json` 也只打这一个文件——所以从 wechat 入口可达的任何 `import()` 都必须内联，不能分裂出 `<id>.pixigame.js`。分裂的后果有两层：① 多出来的 chunk 文件既不会被 `game.js` require、也不进主包；② 更要紧的是 webpack 会把 JSONP chunk 加载运行时（`document.createElement('script')` / `importScripts`）打进主包，而微信两者都没有，真去请求 chunk 时是**直接抛错**而非优雅降级。**实测踩过**：`@capacitor/local-notifications` 用 Capacitor 标准的惰性 web 实现写法 `web: () => import('./web')` 注册插件，而 `platform/localReminders.ts` 是**无条件 import**（没按 target 分叉，只在函数体内用 `Capacitor.isNativePlatform()` 兜住调用），于是每次 `build:wechat` 都产出一个 3.5 KB 的 `90.pixigame.js`。该 chunk 当时**确实不可达**（`registerPlugin` 的 web loader 只在插件方法真被调用时才触发，而所有调用点都在 native 判断之后；iOS 上 `platform='ios'` 不在 `{web:...}` 里、走原生桥，也不会加载它）——但"不可达"是**当下调用点**的性质、不是构建的性质，所以改成由 `output.asyncChunks:false` 从构建层面兜死，而不是逐个第三方依赖打补丁。副作用是 web 实现（约 3.5 KB）被内联进主包，同时省掉 chunk 加载运行时，净体积基本持平（这批字节由下一条彻底摘掉）。`client/.gitignore` 里微信产物同步改成 `wechatgame/*pixigame.js*` 通配，万一哪天该保证被绕过也不会变成 untracked 噪声。**回归守卫**：`client/test/wechatSingleBundle.test.ts`（默认 suite，约 0.3s）——`createRequire` 加载 `webpack.config.js` 本体断言 wechat 分支 `asyncChunks:false`（外加"单入口 + 无 splitChunks"，这是另外两条能绕出第二个文件的路），并反向断言 web/crazygames/mobile **不**关分包（那三个跑在真浏览器里、chunk 能正常加载、还落在已 gitignore 的 `dist/`，分包是净收益，别顺手"统一"掉）；ignore 规则那半用 `git check-ignore --no-index` 问 git 本身而不是匹配 pattern 文本，正反都测——既确认 `90.pixigame.js` 被忽略，也确认同目录下**已入库**的 `game.js`/`game.json`/`project.private.config.json` 没被过宽的通配吞掉。不跑真实构建：一次 `build:wechat` 约 20s + 吐 ~23 MiB CDN 资源，而它能证明的东西配置层已经决定了；真正要防的是有人手动删掉/"统一"这个选项。
- **原生插件 stub：非 mobile target 不打 Capacitor（2026-08-17 补，紧接上一条）**：`asyncChunks:false` 只是把 chunk 内联，**字节还在**。根因是 `platform/localReminders.ts` 无条件 import 了两个只在 iOS 套壳里有意义的包——`@capacitor/local-notifications` 以及它 `registerPlugin` 依赖的 `@capacitor/core`。`webpack.config.js` 在**所有非 mobile target**（web / crazygames / wechat / web-e2e）上用一张 `NormalModuleReplacementPlugin` 表把这两个包换成 `client/src/platform/stubs/` 下的空实现，与同文件里 `.hires` 美术替换是同一套 target-conditional 惯例：
  - **计量**（`npm run build:wechat` / `build:web`，production）：微信主包 `pixigame.js` 2,148,531 → **2,135,947 B（−12.3 KB）**；web 主 bundle 2,147,523 → 2,138,362 B，且那个 3,526 B 的死 chunk **整个消失**（合计 −12.4 KB，dist 里只剩 `sketchDemo` 一个真·动态 chunk）。两个包里 `@capacitor/core` 占大头（约 9 KB），插件本体约 3.5 KB。
  - **为什么 stub 是安全的**：非 mobile 包里 `Capacitor.isNativePlatform()` **恒为 false**（套壳只加载 `build:mobile` 产物，`.hires`/绝对后端地址等一整套 mobile 分支也都基于这个前提），所以两个 native 分支本来就是死代码；stub 只把这个常量答案写实。插件方法一律 `throw` 而非静默 resolve——真被调到时落进 `localReminders.ts` 已有的 try/catch，降级成与"权限被拒"完全相同的路径，但日志里看得见，不会假装排程成功。验证：web 构建里 `window.Capacitor` 全局已不存在（真 core 会在 initBridge 里挂上它），游戏照常起、控制台除后端未启动的连接拒绝外无报错。
  - **mobile target 一个替换都不加**，真插件原样保留（实测 `build:mobile` 产物里 `LocalNotificationsWeb` chunk、9001/9002/9003 三个通知 ID 都在，stub 的标记串一处不见）。iOS 的排程链路完全没动。
  - **另外两类原生依赖不需要 stub**：`platform/ota.ts`（`@capgo/capacitor-updater`）靠**可达性**隔离——只有 `entries/mobile.ts` import 它，因此只有 mobile 产物里出现那个 5.4 KB 的 `CapacitorUpdaterWeb` chunk；`platform/nativeAds.ts` / `iap.ts` 背后根本没有包，只是套壳注入的 `window.NWAds` / `window.NWBilling` 全局。
  - **回归护栏** `client/test/capacitorStubs.test.ts`：直接 `require` `webpack.config.js` 取各 target 的替换表来断言——①共享图里出现的每个 native 包在每个非 mobile target 上都有 stub（新包漏配即红）；②mobile 表里一个 stub 都没有（误伤 iOS 即红，这是这里唯一玩家能感知的故障）；③`ota.ts` 的 importer 只有 `entries/mobile.ts`（谁把它拉进共享图就红）；④调用点用到的每个插件方法 stub 都有定义（方法漂移即红）。这层测试是必要的，因为**配错只掉字节、不掉功能**：正常测试全绿、游戏照跑，只有对比包体积的人才会发现。
- **资源 → CDN（方案 A 核心）**：`asset/resource` 的 `publicPath = NW_ASSET_CDN`、`filename = 'cdn/[contenthash][ext]'`。于是每个 `import x from '*.png/.tao'` **在构建期就烘焙成 `<CDN>/cdn/<hash>.png` 绝对 URL**，资源文件发到 `wechatgame/cdn/`（由 `project.private.config.json` 的 `packOptions.ignore` 排除出主包，单独上传 CDN）。主包因此是**纯代码 ~1.5 MB**，远在 4 MB 红线内。
- 资源更新只换 CDN 文件 + 改一处资源（contenthash 变）重传，主包过审周期不受影响。
- `NW_ASSET_CDN` 留空时 `publicPath=''` → 包内相对路径（整包跑，仅本地 IDE 自测用）。

### 4.1 运行时：`AssetIO`（微信无 fetch）

资源字节/纹理源的获取统一经平台无关接口 `client/src/assets/assetIO.ts`：

```ts
interface AssetIO {
  loadBinary(url: string): Promise<ArrayBuffer>;   // .tao ZIP / JSON 等
  textureSource(url: string): Promise<string>;     // PIXI BaseTexture 的 source（url 或本地路径）
}
```

- **Web / CrazyGames（默认 `WebAssetIO`）**：`loadBinary = fetch().arrayBuffer()`；`textureSource = 原样返回`。**与现状零回归**。
- **微信（`WechatAssetIO`，`entries/wechat.ts` 无条件注入）**：微信运行时**没有 `fetch`**，所以一切走 `wx.downloadFile` + `USER_DATA_PATH/nwassets/` 本地缓存（按 contenthash basename 作缓存键，命中即不再下载；并发去重）。URL 已由构建期 `publicPath` 烘焙好，`WechatAssetIO` 不需要再知道 CDN 基址。包内相对路径（无 CDN 构建）则直接 `readFile`/原样返回。

`.tao`（`StickmanRuntime._parse`）和三组装饰 atlas（`decorAtlas`/`labelDecor`/`decorCAtlas`）+ `bootManifest` 卡图预热**全部路由经 `AssetIO`**，微信下这些**已完整走 CDN+缓存**。

### 4.2 本期落地 / 遗留

- ✅ 微信构建迁到 webpack，可编译、产物为纯代码主包 + `cdn/` 资源；`build:wechat` = `webpack --env TARGET=wechat`。
- ✅ `AssetIO` 抽象 + `WebAssetIO`（默认零回归）+ `WechatAssetIO`（downloadFile+缓存）。
- ✅ 全部 `.tao` + 装饰 atlas 经 `AssetIO`（含 L1 英雄 `.tao`，因 UnitView→StickmanRuntime 统一入口）。
- ✅ **L1 PNG 经 AssetIO 落缓存**（2026-06-30）：新建 `client/src/assets/preloadTextures.ts`，`preloadTexture(url)` 通过 `assetIO().textureSource(url)` 取本地路径，并在 PIXI 缓存里**同时注册原始 URL 别名**（`PIXI.BaseTexture.addToCache`）——否则微信下 `PIXI.Texture.from(url)` 查不到缓存、继续拉 CDN。同步修复 `bootManifest.ts` L0 图片（原 `preheatTexture` 有同样 alias 缺失问题）。场景触发：`GachaScene`/`CollectionScene`/`GameScene` 构造时 fire-and-forget 预加载。
- ✅ **立绘 mipmap 开启，消除缩小噪点**（2026-07-22）：独立立绘（英雄/兵种/建筑/logo）都是大图小用——英雄名单里 Anna 阵营 max/lena/mara（约 900×1450）缩到约 177×246、约 6×。PIXI 7 默认 `MIPMAP_MODES.POW2`，这些非 2 幂大图**不生成 mipmap**，大倍率 LINEAR 缩小欠采样 → 边缘走样成白色杂点。`preloadTextures.ts` 导出 `ART_TEX_OPTIONS`（`mipmap: ON` + `scaleMode: LINEAR`），在 `preloadTexture` 统一入口生效；`cardArt.getArtTexture` 兜底同选项，`avatar.buildPortraitIcon` / `HandView` 改走 `getArtTexture`——因 baseTexture 按 url 共享缓存，任一处先建出"无 mipmap"版本会拖累其余复用方。PIXI 仅在 **WebGL2** 上给非 2 幂纹理生成 mipmap（`TextureSystem`：POW2 默认或 WebGL1+非 2 幂自动回落无 mipmap），故微信 WebGL1 路径优雅降级、无破坏。
- ⏳ **遗留**：
  1. **微信后台白名单**：把 CDN 域名加进 `downloadFile` 合法域名（以及远程图片域名白名单）。
  2. **部署**：`build:wechat` 后把 `wechatgame/cdn/*` 上传到 `<CDN>/cdn/`；微信开发者工具上传主包（`pixigame.js`+`game.js`+`game.json`，`cdn/` 已被 packOptions 忽略）。
  3. **运行时验证**：webpack 产物能否在微信运行时跑，需微信 IDE 实测（本地无法验证）。

> CDN 域名：复用现有 gamestao.com 基础设施即可（web 资源已在 a.gamestao.com 的 Cloudflare 边缘）。`cdn/` 上传到某子域（如 `assets.gamestao.com` 或直接挂 a. 的某路径），构建时 `NW_ASSET_CDN=https://<子域>`。

---

## 5. 手机套壳 —— 全量打包

若以 Capacitor/WebView 套壳或离线包发布：**所有资源随包本地化**，`AssetIO` 用默认 `WebAssetIO`（或一个指向本地目录的实现），无网络流式、L0/L1 区分对它无意义，整包 ~10 MB 完全可接受。无需额外机制，仅确保 asset base 指向本地。

手机套壳大部分时候读本地缓存、靠 Capgo OTA（`platform/ota.ts`）定期整包更新，不像 Web/微信每局会话都要经网络下载同一份资源——因此能负担明显更大的源图；详见 §9 的高清/压缩分级机制。

---

## 6. 关键文件

| 文件 | 职责 |
|---|---|
| `client/src/assets/assetIO.ts` | `AssetIO` 接口 + `WebAssetIO` 默认实现 + 模块级单例（`setAssetIO`/`assetIO`） |
| `client/src/assets/WechatAssetIO.ts` | 微信 `downloadFile` + `USER_DATA_PATH` 本地缓存（无 fetch）；含包内相对路径回退 |
| `client/src/assets/bootManifest.ts` | **L0 启动清单单一来源**：`STEPS`（阻塞层）+ `BACKGROUND_STEPS`（背景层）+ `preloadBoot(onProgress)` / `preloadBootBackground()`（见 §11.2） |
| `client/build/preloadBootAssets.js` | webpack 插件：把两层清单写成 `<link rel=preload>` 进 HTML head（见 §11.1）。**清单是副本**，由 `test/bootPreloadManifest.test.ts` 守住不漂移 |
| `client/src/assets/idlePrefetch.ts` | 首屏之后的 L1 空闲预取（串行 + idle 调度 + 计费链路跳过，见 §11.3） |
| `client/src/assets/battleAssets.ts` | `ensureBattleAssets`：进战斗前的资源闸门（§10），同时是背景层的兜底保证（§11.2） |
| `client/src/ui/LoadingOverlay.ts` | PIXI 手绘加载界面（进度条），L0 闸门与 `enterBattle` 闸门共用 |
| `client/src/app.ts` | `startApp` 内嵌 L0 闸门（构造 overlay → `await preloadBoot` → 销毁 → 进首屏）+ 首屏后 `void startIdlePrefetch()` |
| `client/src/render/stickman/StickmanRuntime.ts` | `_parse` 经 `assetIO().loadBinary` 取字节 |
| `client/src/render/atlas/spriteAtlas.ts` | **`createAtlasLoader` 工厂**——每个 PixiJS Spritesheet atlas 的解码/缓存/idempotent-load 单一实现，所有 atlas loader 模块都是它的薄封装 |
| `client/src/render/{decorMergedAtlas,iconsAtlas,worldAtlas}.ts` | 三组合并 atlas 的共享加载实例（见 §8），纹理源经 `assetIO().textureSource` |
| `client/webpack.config.js` | `TARGET=wechat` 分支：单 IIFE→`wechatgame/pixigame.js`、asset `publicPath=NW_ASSET_CDN`+发 `cdn/`；`TARGET=mobile` 分支：`NormalModuleReplacementPlugin` 做 `.hires` 兄弟文件重定向（见 §9） |
| `client/src/entries/wechat.ts` | 无条件 `setAssetIO(new WechatAssetIO())`（微信无 fetch） |
| `client/wechatgame/{game.js,game.json,project.private.config.json}` | 微信壳层 + `packOptions.ignore`（排除 `cdn/`、`.map`） |
| `client/public/web/index.html` | 预 boot CSS 加载占位 |

---

## 7. 后续（按优先级）

1. **微信上线闭环**：上传 `cdn/*` 到 CDN 子域 + 微信后台域名白名单 + 微信 IDE 实测 webpack 产物运行（§4.2 遗留 2/3/4）。
2. ~~**L1 PNG 经 AssetIO**~~：**已完成（2026-06-30）**——见 §4.2 preloadTextures + URL alias 方案。
3. ~~**Web JS code-split**~~：**已决定不做（2026-06-30）**。微信不支持运行时 `import()`、套壳全量本地化，受益平台仅 Web；风险大于收益，正式放弃。
4. **L0 瘦身复核**：定期核对 `bootManifest`，把"非首局必现"的项降级回 L1。

---

## 8. `client/src/assets/` 目录整理 + atlas 合并（2026-07-27）

**目录**：顶层散落的兵种/法术/称号/建筑 PNG+`.tao` 按现有 `avatars/decor/equipment/factions/gacha/material/shop/slg` 子目录范式收进 `units/`（12 兵种立绘+`.tao`）、`spells/`（4 张法术图）、`titles/`（4 张称号图）、`buildings/`（3 张建筑卡图 + `base_upgrade_atlas`）；根目录只留 `logo.png` 和 4 个平台/清单 `.ts` 文件（见 §6）。`.DS_Store` 已清进 `.gitignore`。

**Atlas 合并**：14 组小 atlas 中，"同一时机一起加载"的三组合并成单页，减少 L0/场景入口的并发请求数（不改变加载时机）：

| 合并后 | 原子集 | 触发时机 |
|---|---|---|
| `assets/decor/decor_merged_atlas.{png,json}` | `decor_atlas`(A组) + `decor_c_atlas`(C组) + 4 张 `label_*.png` | L0 启动闸门（原 3 个 boot step 并 1） |
| `assets/icons/icons_atlas.{png,json}` | `equipment` + `material` + `factions` + `avatars` | L0 启动闸门（原 4 个 boot step 并 1） |
| `assets/slg/world_atlas.{png,json}` | `terrain` + `city` + `playerbase` + `res` + `building` + `city_bld` | WorldMapScene 构造的 `Promise.all`（前 5 者）+ CityScene 的 res/city_bld 配对 |

frame 名称互不冲突（合并前用脚本核对过），故直接共享一份 Spritesheet：`decorAtlas.ts`/`decorCAtlas.ts`/`labelDecor.ts` 三个模块的导出函数名/签名完全不变，内部改成读同一个 `decorMergedAtlas` 实例（`decorFrameNames`/`decorCFrameNames` 按 `decor_`/`decoc_` 前缀从共享 sheet 里过滤，避免枚举出对方组的帧）；`equipmentAtlas.ts` 等 4 个模块、以及 6 个 SLG loader 模块同理改读 `iconsAtlas`/`worldAtlas` 共享实例，因为查找都是显式 key（无跨组枚举需求）不需要过滤。

12 个 atlas loader 模块（含合并前后）本身也有大量重复的"解码 BaseTexture + parse Spritesheet + idempotent 缓存"样板，收进 `client/src/render/atlas/spriteAtlas.ts` 的 `createAtlasLoader(url, data, label, texOptions?)` 工厂，各模块只剩薄封装。

**合并脚本**：`art/scripts/mergeAtlasPages.js`（通用 shelf-packing + frame 坐标平移，共享库）+ `art/scripts/mergeAssetAtlases.js`（本次三组任务的具体清单）。每个源 atlas 整页 blit 进新画布（不重新裁切单个精灵），故 `rotated`/`spriteSourceSize` 等字段原样保留；再次运行需要 `NODE_PATH="$(pwd)/client/node_modules" node art/scripts/mergeAssetAtlases.js`。

> ⚠ **合并后源 atlas 被删了，`mergeAssetAtlases.js` 实际已跑不起来**（2026-08-02 发现）：本次重组只保留了合并页，14 组源 `*_atlas.{png,json}` 全部从仓库移除，再跑必然 `Input file is missing`。所以重跑某个 `art/ui/*/pack_*_atlas.js` 之后，产物进不了客户端真正读的合并页。
>
> 补法 `art/scripts/patchMergedAtlas.js <源 atlas.json> <合并页.json>`：把源 atlas 的帧**原位重新盖印**回合并页。前提是帧尺寸没变（各 `pack_*` 脚本的 `CELL` 是常量，通常成立）→ 合并页的 frame 坐标一个都不动，只换像素 + `contentTop` 之类的自定义字段；尺寸变了直接报错，提示需要整页重打（那就得先从 git 历史恢复源 atlas）。合并页是 blend 合成，盖印前会先把目标矩形清零，否则旧图会从新帧的透明处透出来。

---

## 9. Web/App 资源分级：`.hires` 同目录变体（2026-07-29，客户端资源管理审计）

**动机**：手机套壳（mobile target）靠 Capgo OTA 定期整包更新，绝大多数时候直接读本地已下载/已打包的资源，不像 Web/WeChat/CrazyGames 那样每次会话都要经网络传输同一份文件——因此手机端能负担明显更大的源图，而 Web 端应保持偏压缩，避免拖慢首屏（尤其 L0 闸门项）。`logo.png` 是第一个具体案例：原先所有平台共用同一份 512px/497KB 图（占 L0 闸门总体积 ~25%），现拆成 Web/微信/CrazyGames 用的 256px/129KB 压缩默认版 + 手机专属 1024px/1.9MB 高清版。

**机制**（`client/webpack.config.js`，`isMobile` 分支）：任意 `.png`/`.jpg`/`.jpeg`/`.webp` 资源，只要同目录下存在同名 `<name>.hires.<ext>` 兄弟文件，`mobile` 构建会把该 import 自动重定向到这个兄弟文件；其余三个平台（web/wechat/crazygames）不受影响，始终用基础文件。用 `webpack.NormalModuleReplacementPlugin` 在 module resolve 阶段做路径替换，**完全按约定生效、无需改调用方代码**——某个资源要不要分级，纯粹取决于是否存在对应的 `.hires` 兄弟文件；没有就照旧只有一份，两平台共用。

**新增一项资源分级的步骤**：
1. 准备好压缩版（作为该资源现有的默认文件）+ 高清版；
2. 高清版存成同目录 `<原文件名>.hires.<ext>`（例如 `foo.png` → `foo.hires.png`）；
3. 不改任何 import 调用点——`webpack --env TARGET=mobile` 自动选高清版，其余 target 自动选压缩版。

**已应用**：`client/src/assets/logo.png`（256px/129KB，L0 闸门项，见 `bootManifest.ts`）+ `client/src/assets/logo.hires.png`（1024px/1.9MB，均来自既有 `art/logo/derived/` 输出，非新生成美术）。

**后续候选**：其余 L0/常驻大图（如登录/大厅背景类，若未来引入）可按同一约定接入，无需再动 webpack 配置。

---

## 10. PvP / PvE 进场资源闸门（2026-08-08）

**动机**：用户反馈——"进 PvP/SLG/PvE 时，需要的资源要检测一下是否已经加载，没加载就走加载界面，不要进场之后才发现没资源（空着或错误图标）"。审计发现 `GameScene`（PvP-vs-AI / 联机 PvP / 战役 PvE 共用）确实有这个缺口，SLG（`WorldMapScene`）已经有对应机制、不需要改：

| 场景 | 进场前是否等资源就绪 | 缺口 |
|---|---|---|
| **PvP / PvE**（`GameScene`） | ❌ 否——`UnitView` 构造时对全部兵种 `.tao`（含皮肤覆盖）+ `GameScene` 对英雄/法术卡图（`cardArt.preloadL1CardArtTextures`）都是 `void` 掉的 fire-and-forget，未就绪单位画占位圆圈直到某帧异步 resolve | **有**——本节修复对象 |
| **SLG**（`WorldMapScene`） | ✅ 是——构造即铺一层不透明"加载中"封面（`WorldMapRenderer/build.ts` 的 `buildLoadingOverlay`），`bootstrap()` 对 `terrain/city/playerBase/res/building` 五个 atlas 走 `Promise.allSettled` 才 `renderMap()`+`hideLoading()`（外加 8s 兜底超时防卡死） | 无（已有正确模式，本节不改） |

**修复**（`client/src/assets/battleAssets.ts` + `client/src/app.ts`）：

- `ensureBattleAssets(opts, onProgress?)`：预热 `StickmanRuntime.loadAsset` 缓存——覆盖 `UnitView.STICKMAN_ASSETS` 全部兵种（含 PvE 专属神话生物）+ 双方 `resolveSkinOverrides(equippedSkins/opponentSkins)` 皮肤覆盖（去重 URL 后逐个 `loadAsset`）+ `cardArt.preloadL1CardArtTextures()`（英雄/法术卡图）。逐 step try/catch，永不 reject（照抄 `bootManifest.preloadBoot` 的容错写法）——单个资源失败只是继续用已有占位，不卡死闸门。
  - **有意预热全量 `STICKMAN_ASSETS`，不按对局实际阵容裁剪**：PvP 对手是 AI 还是真人、走哪个牌组在进场那一刻不完全可知；集合本身很小（12 兵种，`StickmanRuntime.loadAsset`/`preloadTexture` 都按 URL 幂等缓存，warm 过一次后再调是免费的），全量预热比"精确算出这局到底要哪些资源"更简单也更不容易漏。同一份闸门天然覆盖 PvE（战役关卡神话生物同样在 `STICKMAN_ASSETS` 里）。
- `enterBattle()`（新文件 `client/src/app/battleGate.ts`，2026-08-08 二次提交时从 `app.ts` 私有方法拆出——独立成模块理由见下）：`showGame`/`showGameNet` 共用——`input.suppress(true)` 冻结背后仍在显示的旧场景（**输入不走 PIXI**，纯视觉遮罩挡不住点击，同 client-modules.md §28 fade 闸门的道理）→ 构造 `LoadingOverlay`（复用 L0 闸门那个手绘进度条组件，构造参数只要 `PIXI.Application`，无 i18n 耦合，可以在 L0 之外二次实例化）→ `await ensureBattleAssets(opts, onProgress)` 边等边刷新进度条 → `destroy()` overlay → 真正 `manager.goto(scene, {fade:true})`，返回造好的场景。`goto` 自己的 fade 转场会再次 `suppress(true)`（幂等空操作）并在淡入结束后 `suppress(false)`，闸门等待期与随后的 fade 转场对输入的冻结无缝衔接，没有"loading 遮罩已经收起但输入还没解冻"或反过来的窗口。
  - `showGame`（PvP-vs-AI / 战役 / 教学关，`nav/game.ts` 三个调用点共用）直接 `void enterBattle({app,manager,input}, opts, () => this.timedBuild('GameScene', () => new GameScene(...)))`。
  - `showGameNet`（联机 PvP，`nav/result.ts:goGameNet`）需要在 `enterBattle` 的 Promise resolve **之前**就把 `NetGameView` 同步返回给调用方——调用方紧接着把 `applyNetState/applyPeerDc/applyMatchOver` 挂到 `session.handlers`，而对手的网络推送在 loading 遮罩还没收起时就可能已经到达（socket 早已连上）。解法：`DeferredSceneCalls<GameScene>`（同文件，`battleGate.ts`）——`call(fn)` 在场景还不存在时把 `fn` 排进队列，`resolve(scene)` 拿到真实场景后按顺序 flush；之后的 `call` 直接同步执行。`GameScene` 自身已有的 destroyed-guard 处理的是对称的另一半（"场景销毁后还收到推送"），这里补的是"场景还没造出来就收到推送"。
  - **为什么单独拆一个文件**：`app.ts` 是"瘦 PIXI 壳"，为了 `showX()` 覆盖全部场景，import 了近 30 个场景类（含 `WorldMapScene`/`FamilyScene`/`SectScene`/`AuctionScene` 等），这些场景的 import 链最终会碰到 `@nw/shared`（进而需要 `server/node_modules` 里的 `jsonwebtoken` 才能被 vitest 解析）——直接对 `app.ts` 写单测意味着每次都要在当前 worktree 装一遍 `server/` 依赖。`battleGate.ts` 只依赖 `SceneManager`/`InputManager`/`LoadingOverlay`/`battleAssets.ts`，四者都不碰 `@nw/shared`，独立测试零额外安装成本。
- **幂等性是这个方案免费的前提**：`StickmanRuntime.loadAsset`（按 URL 缓存 Promise）、`preloadTexture`（`assetIO().textureSource` 结果 + PIXI 纹理缓存）都已经是 URL 级幂等——`ensureBattleAssets` 预热完，`UnitView`/`GameScene` 构造时重复调用同一批 loader 完全免费（缓存命中，不重新下载/解析），不需要额外"跳过已加载"的判断逻辑。
- **回归测试**：
  - `client/test/ui/battleAssets.ui.ts`（`ensureBattleAssets` 覆盖全部默认兵种 + 双方皮肤覆盖 + 卡图；单个 `.tao` 失败不 reject；progress 回调 0→total 逐步推进）。放在 `test/ui/` 而非 `test/` 根目录纯粹因为它 import 了 `UnitView.ts`（间接拉进 `.tao`/`.png` 资源 import），只有 `vitest.ui.config.ts` 的 `stubBinaryAssets` 插件能解析。
  - `client/test/ui/battleGate.ui.ts`（mock `ensureBattleAssets` 手动控制 resolve 时机）：`enterBattle` 在资源就绪前不 `build()`/不 `goto()` 但立即 `suppress(true)`；overlay 在 `goto` 前已 `destroy()`（断言 `goto` 触发时 `app.stage.children.length===0`）；resolve 后返回造好的场景。`DeferredSceneCalls`：`resolve()` 前的 `call()` 排队且按序 flush，`resolve()` 后的 `call()` 立即执行，回调都拿到同一个已 resolve 的场景对象。

**未覆盖范围**（有意不做，避免蔓延）：`CityScene`（SLG 内政面板）的 `resAtlas`/`cityBldAtlas` 加载依旧是文档已注明的"有意 fire-and-forget，先用文字/emoji 占位再补图标"渐进增强模式，不属于本次"进大场景"闸门的范围；社交类子面板（Family/Sect/Auction/DefenseEditor）同理未动。

> §11 起 `ensureBattleAssets` 多了一步 `decorMergedAtlas.load()`——该 atlas 从 L0 阻塞层降级成背景层后，本闸门就是"战斗首帧前它一定解码好"的唯一保证（原先靠 L0 闸门顺带保证）。

---

## 11. 首屏加载策略优化（2026-08-17）

**动机**：用户问"要不要加个 splash 多争取点下载时间"。结论是不加——现有遮挡已经无缝（`#boot` CSS 占位 → `LoadingOverlay` 进度条 → 首屏），splash 只是换个底图，**不会凭空多出带宽**，只有主动拖时长才"争取"得到，那等于让玩家多等。真正能省时间的是三件跟遮挡无关的事，本节全部落地。平台相关的 splash（发行商 logo / 微信 / CrazyGames 硬性 splash 期）留到上线时按平台再定，与本节无关。

### 11.1 `<link rel="preload">`：让资源和 bundle 并行下载

**问题**：L0 资源的第一个请求要等到 bundle **下载完 + 解析完 + 执行到** `startApp` 里的 `preloadBoot()` 才发得出去。手机上 ~2 MB bundle 的解析执行本身就是几百 ms，加上一个 RTT，全是白等。

**做法**：新增 webpack 插件 `client/build/preloadBootAssets.js`，构建期把 L0 资源写成 `<link rel="preload">` 塞进 HTML `<head>`（放在 bundle 的 `<script>` **之前**，让预扫描器先看到）。资源名是 contenthash，静态 HTML 里写不了，插件从 webpack 的产物表里按 `assetInfo.sourceFilename`（`asset/resource` 模块会记录源文件相对路径）查出真实文件名。微信没有 HTML 宿主、URL 构建期已烘焙成 CDN 绝对地址，故只对 HTML target 生效。

- `fetchpriority` 区分两层（见 §11.2）：阻塞层 `high`、背景层 `low`，避免背景层抢走玩家真正在等的带宽。不支持该属性的浏览器只是退化成两条普通 preload，仍然优于没有。
- **`mobile` target 要跟着 §9 的 `.hires` 约定走**：该 target 会把有 `<name>.hires.<ext>` 兄弟文件的资源在 resolve 阶段换掉，产物表里记的是兄弟文件的路径，按基础文件名查会扑空（`logo.png` 正是这种情况，第一版实测漏了一条 preload + 一条构建 warning）。插件查不到时按同一约定回退查 `.hires` 兄弟，而不是给每个 target 各维护一份清单。
- 清单里某项查不到产物时**只 warn 不 throw**：清单过期不应该有能力弄挂发布构建。这条 warning 也确实是上面 `.hires` 问题的发现方式。
- **⚠ `crossorigin="anonymous"` 是必需的，漏了整个优化会反向生效**：不带 `crossorigin` 的 preload，credentials mode 是 `include`；而两个消费方要的都是 `same-origin`（PIXI `ImageResource` 会给 `<img>` 赋 `crossOrigin`（空串 ≡ anonymous）；`StickmanRuntime` 用默认 `fetch()`）。两边对不上，浏览器会**丢弃预载结果、把文件重新下一遍**——比不做 preload 更慢。实测第一版就踩了这个坑，Chrome 控制台明确报 `A preload for '...' is found, but is not used because the request credentials mode does not match`，加上 `crossorigin="anonymous"` 后两边都落到 `same-origin`，`performance.getEntriesByType('resource')` 里每个 URL 只剩一条记录（改前是每个都两条）。**验收方法就用这条**：数 resource timing 条目，有重复就是没生效。

### 11.2 L0 拆成"阻塞层 + 背景层"

**问题**：`preloadBoot` 的各 step 是 `Promise.all` 并行的，所以在带宽受限的链路上闸门时长 ≈ **该层总字节数 / 带宽**。于是每一项都该问的不是"它是不是 L0"，而是"**玩家必须等它吗**"。原 L0 共 ~1.65 MB，其中开局三兵的 `.tao`（~0.41 MB）+ decor 合并 atlas（~0.10 MB）**大厅一个像素都不画**——它们进 L0 的理由是 §2 的"第一局不许出现占位圆圈"，而这条早已被 2026-08-08 才加的 §10 进场闸门**重复保证**了一遍。

**做法**：`bootManifest.ts` 拆成两个清单：

| 层 | 内容 | 体量 | 谁在等 |
|---|---|---|---|
| `STEPS`（阻塞） | 三兵卡图 + 3 张建筑卡图 + logo + `icons_atlas` | ~1.14 MB | 加载进度条 |
| `BACKGROUND_STEPS`（非阻塞） | 三兵 `.tao` + `decor_merged_atlas` | ~0.51 MB | 无——`enterBattle` 闸门（§10）再等一次 |

背景层由 `preloadBoot` 在**闸门 resolve 之后**才 `void` 掉（不是同时开跑：同时开跑等于继续跟玩家在等的那批抢带宽，白拆）。配合 §11.1 的 `fetchpriority=low` preload，这一步通常直接命中 HTTP 缓存。

**为什么不会退化**：`StickmanRuntime.loadAsset` / `preloadTexture` / atlas loader 全部按 URL 幂等缓存，`ensureBattleAssets` 会把这两项原样再 await 一遍（`decorMergedAtlas.load()` 是本次为此**新加**的一步）。所以"第一局绝不出现占位圆圈"的保证一点没变，只是改由**真正挨着战斗的那道闸门**兑现，而不是由挨着大厅的那道顺手兑现。**净效果：阻塞闸门 −31% 字节，零可见回归。**

### 11.3 L1 空闲预取

**问题**：L0 之外的资源都是进场景才拉，所以第一次进战斗 / 第一次开世界地图 / 第一次抽卡，各自都要现场等一道闸门——哪怕网速很好，因为**下载是等玩家开口之后才开始的**。而首屏出来之后那几秒几乎纯空闲：玩家在看一个静态界面，socket 也没事干。

**做法**：新增 `client/src/assets/idlePrefetch.ts`，`startIdlePrefetch()` 在 `core.start()` 之后 fire-and-forget。刻意保守——抢了正经请求的预取比不预取更糟：

1. **严格串行**：一波 await 完才起下一波。并行预取会跟玩家接下来真正的操作抢连接。
2. **空闲调度**：每波从 `requestIdleCallback` 起（没有该 API 的环境如微信退化成 timer），主线程忙就自动往后推。首波额外留 3s，避开首屏场景自己的构造和开屏 API 调用。
3. **先便宜后贵**：`boot 背景层` → `battle`（12 兵 `.tao` + 英雄/法术卡图，即 `enterBattle` 要等的全集）→ `icons:reward`（tab 图标 + 金币/材料 atlas）→ `slg:world`（1.2 MB 世界地图 atlas）→ `gacha`（3.3 MB，最大且最不常用，放最后）。
4. **计费链路直接跳过**：`navigator.connection` 的 `saveData` 或 `effectiveType` 为 `2g`/`slow-2g` 时整体不跑（该 API 在 Safari/Firefox/微信不存在，视为普通链路照常预取）。
5. **永不 reject**：单波失败只打 warn，链路继续（同 `preloadBoot` 的容错写法）。

因为所有 loader 都是 URL 幂等的，玩家"抢先"进了某个场景也不亏：场景自己的闸门会 join 到同一个 in-flight promise，不会重复请求。

### 11.4 回归测试

本节三处改动**没有一处会在出错时报错**——preload 属性写错只是悄悄多下一遍、L0 分层出错只在**冷缓存的第一局**露馅、预取没接上只是回到原来的速度。所以测试全部按"这条烂掉了谁会发现"来设计，五个文件各守一层：

| 文件 | 套件 | 守什么 |
|---|---|---|
| `test/bootPreloadManifest.test.ts` | node | 插件的资源**清单**不跟 `bootManifest.ts` 漂移 |
| `test/preloadBootAssetsPlugin.test.ts` | node | 插件生成的**标签属性**正确 |
| `test/appAssetGateWiring.test.ts` | node | `app.ts` 里两个调用点还在、顺序还对 |
| `test/ui/bootManifestTiers.ui.ts` | ui | 闸门只等阻塞层 + **背景层被战斗闸门全覆盖** |
| `test/ui/idlePrefetch.ui.ts` | ui | 预取的调度契约 |

- **清单漂移守卫**（`bootPreloadManifest`）：插件是 JS、不能 import TS + PIXI 资源图，只能自带一份清单副本；副本悄悄烂掉比不做 preload 更糟。该测试从 `bootManifest.ts` 源码文本反推两层清单（含每项属于哪一层，因为层决定 `fetchpriority`），与插件源码里的两个数组比对，另校验文件真实存在、两层不重叠。正则本身有兜底断言（推导结果为空即失败），避免"两个空集合相等"式假绿。
- **插件行为守卫**（`preloadBootAssetsPlugin`）：用假 compiler/compilation 驱动插件（`HtmlWebpackPlugin.getHooks()` 接受任意对象挂 hook；真构建一个 target 要 18s，这样是毫秒级）。断言 `crossorigin=anonymous`（§11.1 那个 bug 的回归锁）、`as` 与消费方一致、`fetchpriority` 高优先在前、publicPath 前缀与 `auto` 处理、`.hires` 重定向、缺项只 warn 不影响其余标签。喂给它的产物表是 `src/assets` 下**全部** png/tao 而非清单副本，所以这个文件跟"当前哪些资源在哪一层"解耦。
- **`app.ts` 接线守卫**（`appAssetGateWiring`）：`startApp()` 需要真 canvas/平台/后端，端到端测不了（同 `appTickerDialogWiring.test.ts` 的理由），所以走源码文本静态检查：闸门被 await、overlay 在首屏前 destroy、`startIdlePrefetch()` 在 `core.start()` **之后**且是 `void` 不是 `await`。
- **分层安全性守卫**（`bootManifestTiers`）：最后一条测试是整个 §11.2 的**安全论证本身**——把 `preloadBootBackground()` 与 `ensureBattleAssets({})` 各自驱动的 loader 记下来，断言前者 ⊆ 后者。将来往 `BACKGROUND_STEPS` 加一项却忘了让战斗闸门也 await，会在这里红，而不是在某个冷缓存玩家的第一局里变成占位图。按 loader **种类**而非 URL 比对：`vitest.ui.config` 的资源桩把所有 `.png`/`.tao` 映射成同一个 data URI，URL 在该环境下没有区分度（`battleAssets.ui.ts` 已记录同一现象）。同文件另测：闸门进度只统计阻塞层、背景层永不阻塞闸门（把背景 loader 挂成永不 resolve，闸门照样 resolve）、背景层在闸门 resolve **之后**才起、两层任一步失败都不 reject。
- **预取调度守卫**（`idlePrefetch`）：5 波全 mock，只测契约——串行顺序、失败不断链、`saveData`/2g 跳过而 3g/4g 不跳过（边界，防止有人把跳过条件放宽成"非 wifi 全跳"）、无 `requestIdleCallback` 时的 timer 回退、重复调用只跑一次。
- `client/test/ui/battleAssets.ui.ts`：补 `decorMergedAtlas.load()` 这一步的断言 + 进度总数 +1。

> 三条关键守卫都做过**反向验证**（把被守护的东西删掉，确认测试变红）：删 `crossorigin` → 插件测试红；从 `ensureBattleAssets` 删掉 `decorMergedAtlas.load()` → 分层测试红且报出 `background-tier loaders not re-awaited by ensureBattleAssets: decor`；删 `app.ts` 里的 `void startIdlePrefetch()` → 接线测试红。

### 11.5 遗留

- `client/public/index.html` 不是任何 target 的 HtmlWebpackPlugin 模板（模板是 `public/<target>/index.html`），疑似历史残留；`public/crazygames/index.html` 也缺 `#boot` 预占位（web/mobile 两个有），但 CrazyGames 有 SDK 自己的 splash 兜底，暂不动。
- §7 的"L0 瘦身复核"由本节 §11.2 执行了一轮；下次复核时同样按"玩家必须等它吗"而不是"它是不是 L0"来判。
