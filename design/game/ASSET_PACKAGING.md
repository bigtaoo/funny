# 资源分包与加载策略（ASSET_PACKAGING）

> 状态：实现中 · 权威：本文（资源分层/加载/分包的单一来源）· 更新：2026-06-29

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

微信小游戏有主包体积红线（历史主包 ≤ 4 MB、可分包、总量上限以**上线当时官方文档为准**），全量 ~9.4 MB 塞不进主包。**采用方案 A**（大型微信小游戏标准做法，且远程资源更新免过审）：

- **主包只打 L0**（代码 + 开局必需资源）。
- **L1 资源托管在 CDN**（白名单 `downloadFile` 合法域名）。运行时按需 `wx.downloadFile` 拉取，落 `wx.env.USER_DATA_PATH` 本地缓存，命中缓存即不再下载。
- 资源更新只换 CDN 文件，主包不动、无需重新过审。

### 4.1 代码抽象：`AssetIO`

所有资源字节/纹理源的获取，统一经平台无关接口 `client/src/assets/assetIO.ts`：

```ts
interface AssetIO {
  loadBinary(url: string): Promise<ArrayBuffer>;   // .tao ZIP / JSON 等
  textureSource(url: string): Promise<string>;     // PIXI BaseTexture 的 source（url 或本地路径）
}
```

- **Web / CrazyGames（默认 `WebAssetIO`）**：`loadBinary = fetch().arrayBuffer()`；`textureSource = 原样返回`。**行为与现状完全一致（零回归）**。
- **微信（`WechatAssetIO`，`entries/wechat.ts` 注入）**：把 webpack 发出的文件名（contenthash basename，跨构建稳定）映射到 `CDN_BASE/<basename>`：
  - `loadBinary`：缓存未命中则 `downloadFile` → `saveFile` 进 `USER_DATA_PATH/nwassets/`，再 `readFile` 返回 `ArrayBuffer`；命中直接 `readFile`。
  - `textureSource`：缓存未命中则下载落地，返回本地路径（PIXI-legacy 微信适配可直接当图片源加载）。

调用点改造：`StickmanRuntime._parse` 用 `loadBinary`；三组装饰 atlas 用 `textureSource`；`bootManifest` 的卡图预热用 `textureSource`。**CDN 基址经构建期注入** `__NW_ASSET_CDN__`（`webpack.DefinePlugin`，来自 `NW_ASSET_CDN`）；**未配置则微信回退到打包内资源**（identity 行为），dev/早期可整包先跑。

### 4.2 本期落地范围与遗留

- ✅ `AssetIO` 抽象 + `WebAssetIO`（默认）+ `WechatAssetIO`（CDN+缓存）。
- ✅ 把 **L0 路径**（开局三兵 `.tao` + 三组 atlas + 开局卡图预热）全部路由经 `AssetIO` —— 微信下这部分即可走 CDN。
- ⏳ **遗留（依赖 CDN 端点拍板 + 构建产物分流）**：
  1. **L1 场景美术**（gacha/英雄/法术）目前经 `PIXI.Texture.from(url)` **同步调用点**取纹理；微信下需把这些调用点改成"先 `await textureSource` 再 `Texture.from`"。本期未改（属各场景内部，量大且需逐场景验收）。
  2. **构建分流**：微信 prod 包需把 L1 文件**排除出包**并上传 CDN（webpack 产物筛选脚本 / 单独 `manifest`）。
  3. 选定并备案 CDN 域名（须在微信后台 `downloadFile` 合法域名白名单内）。

---

## 5. 手机套壳 —— 全量打包

若以 Capacitor/WebView 套壳或离线包发布：**所有资源随包本地化**，`AssetIO` 用默认 `WebAssetIO`（或一个指向本地目录的实现），无网络流式、L0/L1 区分对它无意义，整包 ~10 MB 完全可接受。无需额外机制，仅确保 asset base 指向本地。

---

## 6. 关键文件

| 文件 | 职责 |
|---|---|
| `client/src/assets/assetIO.ts` | `AssetIO` 接口 + `WebAssetIO` 默认实现 + 模块级单例（`setAssetIO`/`assetIO`） |
| `client/src/assets/WechatAssetIO.ts` | 微信 CDN 下载 + `USER_DATA_PATH` 本地缓存实现 |
| `client/src/assets/bootManifest.ts` | **L0 启动清单单一来源** + `preloadBoot(onProgress)` |
| `client/src/render/LoadingOverlay.ts` | PIXI 手绘加载界面（进度条） |
| `client/src/app.ts` | `startApp` 内嵌 L0 闸门（构造 overlay → `await preloadBoot` → 销毁 → 进首屏） |
| `client/src/render/stickman/StickmanRuntime.ts` | `_parse` 经 `assetIO().loadBinary` 取字节 |
| `client/src/render/{decorAtlas,labelDecor,decorCAtlas}.ts` | atlas 纹理源经 `assetIO().textureSource` |
| `client/webpack.config.js` | 注入 `__NW_ASSET_CDN__`（`NW_ASSET_CDN`） |
| `client/src/entries/wechat.ts` | 配了 CDN 则 `setAssetIO(new WechatAssetIO(cdn))` |
| `client/public/web/index.html` | 预 boot CSS 加载占位 |

---

## 7. 后续（按优先级）

1. **微信 L1 闭环**：L1 场景纹理调用点改 async 解析 + prod 构建分流脚本 + CDN 域名备案（§4.2 遗留）。
2. **Web JS code-split**：`splitChunks` vendor + 重场景 `import()`，首屏代码包 ~1.5 MB → ~0.8 MB（§3 注）。
3. **L0 瘦身复核**：定期核对 `bootManifest`，把"非首局必现"的项降级回 L1。
