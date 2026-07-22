# 客户端测试架构（client/test）

> 快查：客户端有几层测试、各测到哪一层、headless PIXI 怎么跑、上线前补浏览器冒烟（缺口 B）的方案。

## 四层测试

| 套件 | 命令 | include | 环境 | 测什么 | 真 PIXI？ |
|---|---|---|---|---|---|
| 单元 | `npm test` | `test/**/*.test.ts` | node | 纯游戏逻辑（无 PIXI 依赖） | 否 |
| UI 冒烟 | `npm run test:ui` | `test/ui/**/*.ui.ts` | node + `pixiHeadless` | **真实场景构造 / update / destroy + 命中矩形回归** | 真对象树，**无渲染器** |
| 渲染泄漏 | `npm run test:render` | `test/render/**/*.test.ts` | node（每文件 `vi.mock` PIXI） | BaseTexture 监听器 / blob URL 泄漏回归 | mock |
| 全链路 E2E | `npm run test:e2e`（opt-in） | `test/e2e/**/*.e2e.ts` | node | `createAppCore` 全链路对接活服务器（meta+gateway+matchsvc+game+commercial+mongo） | headless orchestration |

`npm test` 只跑 `*.test.ts`；`*.ui.ts` / `*.e2e.ts` 用各自命名后缀隔离，默认套件不会误收。

## 静态类型检查（`npm run typecheck` / CI）

vitest 走 esbuild、webpack 也不做类型检查，且 `client/tsconfig.json` 的 `include` 只有 `src/**`——**`test/**` 从不被类型检查**。历史上这让 test 里对 `GameConfig` / DTO / proto 形状的引用可以运行期侥幸通过（esbuild 擦掉类型），却是潜伏 bug（典型：CC-1 把 `GameConfig.unitLevels` 换成 `cardInstances`、`JudgeRequest` 新增必填 `unitLevels` 后，多个 test 仍用旧形状）。

`client/tsconfig.test.json`（extends 主 tsconfig，`include` 追加 `test/**`）把 `src` + `test` 拉进同一个 program 做 `tsc --noEmit`。`npm run typecheck` 跑它，CI `build-test` job 在单测前执行——**test 层的蓝图/DTO 漂移现在会让 CI 红**。改了引擎/网络层的类型后，本地先 `npm run typecheck` 再提交。

## UI 冒烟层（test:ui）—— 价值与边界

**思路**：`test/harness/pixiHeadless.ts` 把 PIXI 的 DOM adapter 换成纯 JS 桩（canvas/context/measureText 都是 no-op 但返回 real-ish 尺寸），让真实场景代码在纯 Node 里构建 PIXI 树、量文字、布局。**从不创建 Renderer**，所以 WebGL/GPU 全程不碰。

这是 **启动 / 回归冒烟层**，不是像素级视觉回归层。它能抓的是「场景构造抛异常 / 读到 undefined 布局矩形 / 命中矩形溢出或重叠」这类一进功能就崩的故障。

覆盖范围：
- `scenes.ui.ts` —— 几乎所有菜单/弹层场景（Intro/Login/Lobby/Settings/Shop/Gacha/Campaign/LevelPrep/Collection/Stats/Room/Friends/Chat/Result/World/Family/Sect/Auction），横竖屏各跑「建得起 / update 不炸 / destroy 不炸」+ 一批命中矩形回归。
- `gameScenes.ui.ts` —— **对战场景 GameScene / ReplayScene**（缺口 A，见下）。
- `statsScene.ui.ts` / `textTeardown.ui.ts` —— 专项回归（Text 释放、共享 bake 纹理保留等）。
- `cardFeedPaging.ui.ts` —— `CardScene/feed.ts` 携手成长素材弹窗专项回归：相同卡（同 defId+同等级）折叠为一行并带数量步进器（`[−] n / 总数 [+]`，行体点击 +1 循环）、Confirm 计数为各组数量之和、Confirm 只喂选中数量的 id；溢出时 Confirm/Cancel 仍在屏幕内且出现滚动条（无翻页箭头）；按住拖动列表使 `feedScrollPx` 增大；拖动起始于行上不触发步进。

## 缺口 A（已补）：GameScene / ReplayScene 冒烟

对战场景驱动**完整 GameRenderer**（board/units/buildings/HUD/VFX）跑真 `IGameEngine`，是「逻辑对、一进去就崩」的高发区。`gameScenes.ui.ts` 把它纳入 headless 冒烟：

- **GameScene** 三条路径：PvP-vs-AI（`{seed}`）、战役 survive（`getLevel('ch1_lv1')`）、战役 boss（`ch1_lv10`，触发 `BOSS` battle label 分支）。建 → step 8 帧（tick 0 会喷初始 spawn 事件，正是构造期渲染接线爆炸点）→ destroy。
- **ReplayScene** 两条路径：用 `createLocalMatch` 跑 ~60 帧后 `buildReplay()` 产出**真 Replay**（顺带验证「录制→回放」round-trip），PvP + 战役（经 `getLevel` 重建）各一；外加「播放推进到 endFrame 后停」「transport overlay 绘出」专项断言。

让 GameScene 在 headless 跑通需要的三处 harness 适配（都在 `vitest.ui.config.ts` + `pixiHeadless.ts`）：

1. **二进制资产桩插件**（`vitest.ui.config.ts` 的 `stubBinaryAssets`）：webpack 把 `import url from '*.png/*.tao'` 当 asset/resource 解析成 URL 字符串，vitest 没这个 loader。插件把所有二进制资产 import resolve 成一个 **1×1 透明 PNG 的 `data:` URI**。
   - 选 `data:` 而非 `.png` 文件路径：`PIXI.Texture.from()` 走 `autoDetectResource → ImageResource`，其 crossOrigin 路径对 `data:` URL **提前 return**（否则要碰 `document`）。
2. **全局 `Image` / `HTMLImageElement` 桩**（`pixiHeadless.ts`）：`ImageResource.test` 是 `typeof HTMLImageElement !== 'undefined' && typeof source === 'string'`，构造时 `new Image()` 并赋 `.src`。提供一个惰性桩类（src setter 永不真加载）即可，bytes 从不解码上传。
3. **bake 无渲染器回落**：`bake.ts` 在没 `setBakeRenderer()` 时返回 null，调用方改 live draw —— headless 不调它，自动走纯 CPU 路径。

> 运行时会看到 `[UnitView] xxx .tao failed to load` 的 warn：这是 `StickmanRuntime.loadAsset` fire-and-forget fetch 那个 data URI（非真 zip）失败被 `.catch` 吞掉的**预期噪声**，不影响断言。骨骼动画美术在 headless 下本就不加载。

## 缺口 B（实施中，2026-07-22）：浏览器冒烟（Playwright，两账号）

UI 冒烟层够不着的硬故障——只有**真渲染器 / 真 WebGL** 才暴露：

- shader 编译失败、GPU 上下文丢失 → 真机白屏
- 资源 atlas 加载 / 解码失败
- 双人交互路径（好友房/组队/PvP 对战/社交频道）只有两个真实会话互相看见对方才会炸的时序 bug

原方案写于 UI 未定型时（"现在跑性价比低"），2026-07-22 起除 SLG 外 UI 已定型，转为实施。**个人项目没有专职测试，此前每次改动靠人工登两个号点一遍——不可持续**，故把"两账号走一遍核心路径"固化成脚本。

### 与 `full-link.e2e.ts` 的分工

`test/e2e/full-link.e2e.ts` 已经是 A/B 双客户端（`createAppCore` + `HeadlessAppViews`），但**不过真 PIXI 渲染器**——只验证编排/网络逻辑，抓不到 shader/atlas/白屏类故障。浏览器冒烟只补这一层，**不重复**已有 e2e 的逻辑覆盖面：单账号纯菜单路径（抽卡/商店/装备…）继续归 headless `test:ui`；只有"必须两个真会话互相可见"或"必须真 WebGL 渲染"的路径才收进浏览器冒烟。

### 驱动方式：`window.__nwE2E`，不用像素坐标点击

游戏全屏单 `<canvas>`，没有 DOM 按钮可供 Playwright selector 定位（唯一 DOM 存在是每个文本输入场景各自的隐藏 `<input>`，无 `id`/`data-testid`，见 `LoginScene.ts`/`ChatScene.ts` 等的 `setupHiddenInput`）。像素坐标点击对分辨率/布局变化太脆。

方案：新增**测试专用入口** `client/src/entries/web-e2e.ts`（webpack `--env TARGET=web-e2e`，与 `entries/web.ts` 平级，生产入口不引用它，产物互不相干）。它调用真实 `startApp()`（真 `PIXI.Application`/真 WebGL，和线上完全一致的渲染路径），但通过 `startApp` 新增的可选 `wrapViews` 钩子，在 `createAppCore` 拿到 `views` **之前**用反射通用包一层：

- 拦截所有 `show*` 方法（`AppViews` 接口按 `showXxx(cb, opts?): void|Handle` 的统一约定），记录 `state.screen`（`showLobby` → `'lobby'`）与 `state.<screen>Cb`（即 `LoginSceneCallbacks`/`RoomSceneCallbacks` 等，与 `HeadlessAppViews`/`full-link.e2e.ts` 里 `c.views.login`/`c.views.room` 同名同用法）。
- 对返回句柄（`RoomView`/`LobbyView`/`NetGameView`…）的 `apply*` 推送方法同样通用包一层，记录 `state.last<Xxx>`（`applyRoomState` → `state.lastRoomState`）供 Playwright `waitFor` 轮询。
- 挂到 `window.__nwE2E = { views, state }`，真实渲染完全不受影响（原方法照常调用，只是多一层记录）。

这**不是** `no-debug-hooks-in-src.test.ts` 守的那种临时 `__NW_DEBUG` 一次性调试钩子（那个测试专门拦截 `__NW_DEBUG`/`TEMP DEBUG HOOK` 字样，`__nwE2E` 不触发）——它是永久基础设施，只活在从不被生产 entry 引用的 `web-e2e.ts` 里，随 webpack `TARGET` 变量隔离，不会进 `web`/`wechat`/`mobile`/`crazygames` 产物。

### 断言与用例

目标：**两条 happy-path**，专抓白屏/断连级事故，不做逐像素比对。

1. **单账号 PvE**：走 intro → consent → register → lobby → 进离线/战役战斗 → 断言 canvas 非空白 + 控制台 0 error + 0 uncaught pageerror。覆盖 shader/atlas 上传路径。
2. **双账号交互**：两个 `browserContext`（各自独立 cookie/storage，互不干扰）各登一个账号 → A 建好友房 → B 用房间码加入 → 双方 ready → 进入真联机对战（`showGameNet`，双方各自真渲染器同时跑）→ 断言双方 0 error。这条路径同时验证：登录 UI、房间 UI、真实网络握手、双人对战真渲染、（后续可加）结算页。是"个人项目两账号手测"里最高密度的一条路径，优先自动化它而不是逐功能补齐。
3. 用例序列直接照抄 `full-link.e2e.ts` 的 `registerAndEnterLobby` / 友房测试的调用序列（`onRegister`→`onOpenRoom`→`createRoom`/`joinRoom`→`setReady`），只是通过 `window.__nwE2E.state.<screen>Cb` 而非 headless `views` 直接调。

### 落地

- `client/playwright.config.ts`：`webServer` 拉起 `npm run start:e2e`（`webpack serve --env TARGET=web-e2e`，独立端口 9096，避免和 `npm start` 的 9090 撞车）。
- 测试文件：`client/test/browser/*.spec.ts`。
- `package.json` 新增 `test:browser`，**不进默认 `npm test`**（避免拖慢本地/CI 快路径；这条本身需要真浏览器 + 真后端）。
- 范围红线：不做截图 diff / 视觉回归（UI 未定型部分——SLG——暂不纳入，等它定型后再补对应路径）。只保「能不能起来 + 两号能不能真联上 + 不报错」。

### 触发时机：日分支→main 的 PR，不是每个 feature 分支

需要拉起全套后端（mongo/redis + 9 个服务进程），每个小 PR 都跑一次太重；两账号真联机路径本身偶发性 flaky（网络时序），跑太频繁容易拖慢日常合并。选在**日分支合并进 main 的 PR**这一档——`.github/workflows/ci.yml` 的 `pull_request`/`push: main` 触发本来就精确对应这个节点（feature→日分支是本地 `git merge`，只有日分支→main 才开 GitHub PR，见 `claudedocs/worktrees.md`）。

`.github/workflows/ci.yml` 已有的 `e2e` job 本来就用 `docker compose -f docker-compose.prod.yml -f docker-compose.ci.yml up -d --wait` 拉起过一次全栈（供 headless `test:e2e`/`test:load` 用），浏览器冒烟**复用同一次拉起**，不再单独起一次 docker（省 CI 分钟数），只加两步：`npx playwright install --with-deps chromium` + `npm run test:browser`。

**2026-07-22 新加，`continue-on-error: true`**：CI 环境（ubuntu-latest）尚未跑过，先观察几轮 PR 确认稳定后再去掉这个 flag、转成真正卡合并的硬门槛（`steps.browser_smoke.outcome` 用来在失败时上传 Playwright HTML report，`continue-on-error` 会让 `if: failure()` 失效，故直接判 `outcome`）。

大版本发布前另加一轮**人工**四平台真机检查（[`release/acceptance-smoke.md`](../design/game/release/acceptance-smoke.md)），测的是 IAP/审核合规/真机性能，这条 Chromium-only 冒烟测不到，两者互补不重复。

> 微信小游戏入口（`entries/wechat`）不能用 Playwright，需微信开发者工具的自动化（minium / 小程序自动化 SDK）单列，超出本冒烟范围，按需另立。

## E2E / 冒烟 harness 维护红线：HeadlessAppViews 必须实现 AppViews 全接口

`test/harness/HeadlessAppViews.ts` 是 `AppViews` 的 headless 实现，E2E（`createAppCore` 全链路）与导航冒烟都靠它。**`AppViews`（含 `showLobby` 返回的 `LobbyView` 句柄）新增方法时，必须同步在 HeadlessAppViews 补桩**。两类漏补的暴露时机不同：

- **顶层 `AppViews` 方法**（如 `showTitles`/`showDaily`/`showCity`）：`HeadlessAppViews implements AppViews`，漏补现在被 `npm run typecheck` 编译期抓到（CC-1 清理时补齐了这批）。
- **句柄对象方法**（`showLobby` 返回的 `LobbyView`、`showRoom` 返回的 `RoomView` 等匿名对象字面量）：结构子类型 + 可能没被 core 调用点静态命中，**TS 不一定报**，漏补会在运行期抛 `xxx is not a function`。这类仍需手动对照接口补桩。

典型坑（2026-06-27）：onboarding §4.1 的首次功能引导 `lobby.showFeatureGuide(...)` 加进 `AppViews.LobbyView` + 真 `LobbyScene`，但 headless `showLobby` 返回的句柄漏补，导致一切 guide-gated 入口（onOpenShop/social/cards/world/daily）E2E 一点就崩。headless 补桩约定：引导类方法**直接调 `onDismiss()`**（模拟玩家立刻关掉引导卡继续导航），不真渲染卡片。
