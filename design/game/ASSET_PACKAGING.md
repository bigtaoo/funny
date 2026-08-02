# 资源分包与加载策略（ASSET_PACKAGING）

> 状态：实现中 · 权威：本文（资源分层/加载/分包的单一来源）· 更新：2026-07-29（§9 新增 Web/App 资源分级）

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
| `client/src/assets/bootManifest.ts` | **L0 启动清单单一来源** + `preloadBoot(onProgress)` |
| `client/src/ui/LoadingOverlay.ts` | PIXI 手绘加载界面（进度条） |
| `client/src/app.ts` | `startApp` 内嵌 L0 闸门（构造 overlay → `await preloadBoot` → 销毁 → 进首屏） |
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
