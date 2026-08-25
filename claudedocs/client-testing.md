# 客户端测试架构（client/test）

> 快查：客户端有几层测试、各测到哪一层、headless PIXI 怎么跑、上线前补浏览器冒烟（缺口 B）的方案。

## 四层测试

| 套件 | 命令 | include | 环境 | 测什么 | 真 PIXI？ |
|---|---|---|---|---|---|
| 单元 | `npm test` | `test/**/*.test.ts`（**含 `test/render/**`**） | node | 纯游戏逻辑；外加 `test/render/**` 那批渲染层窄回归（BaseTexture 监听器 / blob URL 泄漏、HUD 几何、图标 dispatch 表…） | 多数文件 `vi.mock` 掉 PIXI；`icons`/`rewardIcon` 真 import `pixi.js-legacy` |
| UI 冒烟 | `npm run test:ui` | `test/ui/**/*.ui.ts` | node + `pixiHeadless` | **真实场景构造 / update / destroy + 命中矩形回归** | 真对象树，**无渲染器** |
| 全链路 E2E | `npm run test:e2e`（opt-in） | `test/e2e/**/*.e2e.ts` | node | `createAppCore` 全链路对接活服务器（meta+gateway+matchsvc+game+commercial+mongo） | headless orchestration |
| 手动调参脚本 | `npm run test:manual`（opt-in，非回归） | `test/**/*.manual.ts` | node | console.log 输出的难度曲线/A-B 对比表，**零 `expect()`**，人工读表用 | 否 |

`npm test` 只跑 `*.test.ts`；`*.ui.ts` / `*.e2e.ts` / `*.manual.ts` 用各自命名后缀隔离，默认套件不会误收。

**⚠️ 2026-08-15：`test:render` / `vitest.render.config.ts` 已删除**。`test/render/**` 曾经额外挂着一份独立配置（`npm run test:render`），但它的存在理由——"把主套件跟 PIXI 依赖隔开"——从来就没成立过：`vitest.config.ts` 的 include 是 `test/**/*.test.ts`，本来就把 `test/render/**` 全收了，两边跑的是同一批文件。真正的问题是**没有任何东西引用 `test:render`**（CI 没有这一步，`test`/`test:coverage` 的链里也没有），于是它的 `resolve.alias` 悄悄落后于 `vitest.config.ts`：后者陆续补上了 `@nw/shared/cards` 和 `@nw/shared`，前者始终只有 `@nw/engine`。到删除前实测，11 个文件里有 4 个在这份配置下**加载即失败**（`Failed to load url @nw/shared/cards … in src/game/meta/cardDefs.ts`），而同样这 11 个文件在 `npm test` 里一直全绿——腐烂了多久没人知道，因为没人跑过。

修法选了"删"而不是"补齐 alias + 接进 CI"：后者要补的不只是两条 alias，还得反过来在 `vitest.config.ts` 的 `exclude` 里排掉 `test/render/**` 才能兑现它自称的隔离，再加一条 CI 步骤——**配置面更大，覆盖面一模一样**。删掉之后 `test/render/**` 只有一个运行入口，alias 只有一份，没有第二处可腐烂。各文件头部的 `Run with: npm run test:render` 注释同步改成 `npm test`；`icons.test.ts`/`rewardIcon.test.ts` 里那两条"NOT `npm run test:render`"的警告（发现问题时手写的）也一并删掉。

> 顺带纠正两条当时被这份配置带偏的注释：①它的头部注释称二进制资产"由各测试文件的 `vi.mock()` 打桩"，对 `icons.test.ts` 并不成立——那个文件靠的是 Vite 内置的 `.png` → URL 字符串处理，从没 mock 过资产（真正做资产打桩的是 `vitest.ui.config.ts` 的 `stubBinaryAssets` 插件）。②`icons.test.ts` 里"调色板值内联而非 import，因为本配置没有 `@nw/shared/cards` / `.tao` 的 loader/alias"——这描述的是那份已删配置；在默认配置下 `render/sketchUi` 和 `scenes/LobbyScene/core` 都能正常 import（2026-08-15 实测），内联现在纯粹是"不让这条 dispatch 表回归拖进更重的场景/调色板模块图"的主动取舍。

**手动调参脚本层（2026-08-05 新增分层）**：`test/diag.manual.ts`（单关卡逐秒时间线 + 出牌统计）和 `test/experiment.manual.ts`（ch1_lv1 难度削减方案 A/B 对比）本质是拿 vitest 当脚本 runner 用来打印表格，从来没有 `expect()` 断言——之前挂着 `.test.ts` 后缀混进 `npm test`，会让"141 passed"的通过数里悄悄含着两条什么都没验证的"测试"。改用独立后缀 + `vitest.manual.config.ts`（同 `vitest.config.ts` 的 `@nw/engine` alias）+ `npm run test:manual`，与 `test:ui`/`test:e2e` 同一模式：需要调参时显式跑，不再计入默认套件的通过率。

## 测试覆盖率百分比（`npm run test:coverage`，2026-08-13 新增）

`vitest.config.ts`（即 `npm test` 用的默认配置，`test/**/*.test.ts`）加了 `coverage: { provider: 'v8', reporter: ['text','lcov','html','json-summary'], include: ['src/game/**'] }`——`include` 特意收窄到 `src/game/**`，跟本文档开头"四层测试"表里写的这套件本身的范围（纯游戏逻辑，无 PIXI 依赖）对齐：不设 `include` 的话 v8 provider 默认会把整个 `src/**`（含从不被这套件加载的 render/scene/UI 层）都算进分母，拉出一堆虚假的 0% 噪声。`package.json` 新增 `"test:coverage": "vitest run --coverage"`。

本地跑 `npm run test:coverage`，产物在 `client/coverage/`（`index.html` 逐行高亮）。`@nw/engine`（`server/engine/src`，本套件通过 alias 直接引用其源码）的覆盖率不计入这份报告——它有自己独立的 `test:coverage`（见 `claudedocs/server.md` "测试覆盖率百分比工具"一节），避免同一份源码在两份报告里重复计数。

**首次实测基线（2026-08-13）**：行覆盖 91.2% / 分支 87.8% / 函数 84.4%——`src/game/**` 范围内已经相当健康，主要缺口是 `game/meta/skinDefs.ts`（64%）、`equipmentDefs.ts`（59%）、`rechargeMilestone.ts`（33%）三个数值表模块，没有阻塞性问题，留作后续按需补测的候选。全部 14 个包（client+13 个 server workspace）的完整基线表见 `claudedocs/server.md` 同一节。

CI（`.github/workflows/ci.yml`）的 `client unit tests` 步已切到 `npm run test:coverage`；job 最后一步汇总所有 client+server 包的覆盖率百分比写进 GitHub Actions 运行摘要，细节见 `claudedocs/server.md` 同一节（该聚合脚本是仓库根 `scripts/coverageSummary.mjs`，两侧共用同一份）。

**⚠️ 2026-08-15：模拟类套件拆出去了（`vitest.sim.config.ts`）**。`test/difficulty/**`（ch1-6 + core）和 `test/pvpSim.test.ts` 跑的是整场无头战斗模拟，占这套件 188s 里的 ~175s，且插桩税按引擎 tick 线性叠加——带 `--coverage` 时整套从 188s 涨到 668s，几乎全部由它们贡献。实测把它们排除后 **client 行覆盖只掉 0.05 个百分点（91.20% → 91.15%）**：它们碰到的 `src/game/**` 早被单元测试覆盖了，它们的真实价值是行为/平衡回归（"第 6 章还打得过吗"），不是覆盖率来源。所以：`vitest.config.ts` 的 `exclude` 排掉这两处，新增 `vitest.sim.config.ts` 专收它们（不带 coverage），`package.json` 里 `test` 和 `test:coverage` **都在末尾链一条 `npm run test:sim`**——一个测试文件都没少跑，只是不再给最贵的那批插桩。带 coverage 的那半从 668s 掉到 ~13s，这才让 CI 有条件在 **PR 和 push-to-main 两端都跑 coverage**（此前 PR 上不跑，导致覆盖率回归和时序 flake 只能在合并后的 main 上暴露，连带挡掉部署——见 `claudedocs/server.md` "CI 稳定性"节）。新增只跑模拟的入口：`npm run test:sim`。

### 覆盖率 scope 扩到「已经被测到的模块」（2026-08-21，ADR-071）

`include` 不再只有 `src/game/**`。起因是一次全仓库门禁体检：`src/game/**` 只有 **1924 可执行行**，是 `client/src` 全部 **55143 行**的 3.5%——数字诚实，但门禁管的地盘很小。

**先把实情量出来再决定**（把 include 临时放宽到 `src/**` 跑一遍现有 409 个测试文件）：全树行覆盖 **30.6%**（16897/55143），去掉生成代码（`net/proto` 4204 行、`i18n/locales` 4425 行）约 **21%**。但这个数是两群完全不同的代码叠出来的：

| 分层 | 行数 | 覆盖 |
|---|---|---|
| `scenes/worldmap` | 4548 | 1.9% |
| `scenes/CardScene` | 2070 | 10.9% |
| `scenes/FriendsScene` | 1888 | 2.9% |
| `scenes/CityScene` / `AuctionScene` | 1486 / 1363 | 0% / 0% |
| `render/GameRenderer` | 901 | 0% |
| `ui/dialogs` | 898 | 2.7% |
| —— 而另一群 —— | | |
| `src/game/**` 之外已 ≥90% 的模块（47 个，≥10 行的） | 2336 | **97.8%** |

第二群是这次扩进来的：**已经测好、却不受任何门禁约束**的模块（`net/judgeRunner.ts`、`layout/{Portrait,Landscape}Layout.ts`、`scenes/CardScene/feedPlan.ts`、`render/vfx/parseEffectDef.ts`、`ui/busyTracker.ts` …）——它们掉到 50% 也不会有任何一个 CI 步骤变红。扩完 **scope 1924 → 4245 行，行覆盖 91.2% → 94.7%（73 文件）**。scope 翻倍而百分比**上升**，跟「缩 include 抬百分比」正好相反（后者由报表的 `Scope (files)` 列盯着）。

- **≥10 可执行行才列**：barrel 和 1 行 re-export 壳（`net/anomaly.ts`、`app/nav/shop.ts`、`render/atlas/emblemAtlas.ts`、`platform/stubs/**`…）100% 覆盖但守不住任何东西，只会让清单变长。
- **两个大 facade 明确不进**：`net/ApiClient.ts`/`WorldApiClient.ts`（~50%）是一行一个转发，覆盖率说明不了任何事（同一理由让它们在 500 行 baseline 里也是例外条目）。
- **这份逐文件清单是过渡的**，ADR-070 那条「逐文件 include 是缺模块边界的味道」仍然成立：它针对的是逐文件项**收窄** scope（把没测的兄弟藏在好看的数字后面），这里每一项只**增加**受门禁的地盘。清单同时就是 ADR-070 客户端半边（4b）的待办——每抽出一个场景的纯逻辑目录，那个目录替掉它名下的若干逐文件项。
- **`test/coverageScope.test.ts` 钉住它别烂掉**（48 例）：每一项必须还匹配得到真文件（**改名/删文件会让一项静默失配、scope 无声缩小，而百分比通常还会升**，因为掉出去的都是覆盖好的模块——这正是 `checkFileLength`/`checkCoverageThreshold` 两条 canary 防的那种「靠变绿退休」）、清单不许空（canary）、不许有已被目录项覆盖的冗余项。红绿两向都实测过。
- **不追整包 90%**：按上表缺口要再覆盖约 3 万行，且相当大比例是 PIXI 绘制代码，测出来的是 mock 的行为。系统性渲染/场景测试仍然是 `test:ui`/`test:e2e` 的活（两者都不产覆盖率）。

## 静态类型检查（`npm run typecheck` / CI）

vitest 走 esbuild、webpack 也不做类型检查，且 `client/tsconfig.json` 的 `include` 只有 `src/**`——**`test/**` 从不被类型检查**。历史上这让 test 里对 `GameConfig` / DTO / proto 形状的引用可以运行期侥幸通过（esbuild 擦掉类型），却是潜伏 bug（典型：CC-1 把 `GameConfig.unitLevels` 换成 `cardInstances`、`JudgeRequest` 新增必填 `unitLevels` 后，多个 test 仍用旧形状）。

`client/tsconfig.test.json`（extends 主 tsconfig，`include` 追加 `test/**`）把 `src` + `test` 拉进同一个 program 做 `tsc --noEmit`。`npm run typecheck` 跑它，CI `build-test` job 在单测前执行——**test 层的蓝图/DTO 漂移现在会让 CI 红**。改了引擎/网络层的类型后，本地先 `npm run typecheck` 再提交。

**`npm run typecheck` 现在跑两个 program（2026-08-20 起）**：除上面那个，还有 `client/tsconfig.fulllink.json`（`npm run typecheck:fulllink`，链在后面）。它装的是**反方向**的东西——import 了 client 源码的 *server* 测试，今天只有 `server/auctionsvc/test/auction-fulllink.e2e.test.ts`（真实 `WorldApiClient` 打真实 auctionsvc HTTP）。这个文件被 auctionsvc 自己的 `tsconfig.test.json` 排除掉了（它会把 DOM/pixi 拖进一个 Node-only 程序），而 client 这边是全仓库唯一同时装了 `client/node_modules` 和 `server/node_modules` 的 CI job，所以由它接管。两处覆盖：`paths` 里 `@nw/shared` 从 slg 子集换成完整 barrel（那个测试要 `signToken`；完整 barrel 是超集，不影响 client 源码的解析，而"客户端只看 slg 子集"这条边界照旧由 `tsconfig.test.json` 把关），以及 `types`/`typeRoots` 指到 `server/node_modules/@types` 拿 node 类型——**故意不把 `@types/node` 装进 client devDependencies**，否则浏览器代码引用 `process`/`Buffer` 也能过主程序。加新的跨包测试时，往它的 `include` 里加一行（server 侧的守卫脚本会强制这件事，见 [`server-testing-typecheck.md`](server-testing-typecheck.md)）。

### ⚠️ 坑：零参 `vi.fn(() => …)` 会把 `mock.calls` 类型推成空元组 `[]`（2026-08-15 实测踩过）

`test/render/rewardIcon.test.ts` 用 `const buildIcon = vi.fn(() => ({ kind: 'drawn' }))` 声明替身，**没写参数**。vitest 从这个签名推断"这个函数被调用时收到的实参元组"，零参就推成 `[]`；于是文件里每一处 `buildIcon.mock.calls[0][0]`（读回"它被传了哪个 IconKind"，正是这批断言的全部意义）都成了 `error TS2493: Tuple type '[]' of length '0' has no element at index '0'`。

**为什么危险**：esbuild 擦类型，所以 `npm test` 一路全绿（该文件 11 个渲染测试文件里跑得好好的），**只有 `npm run typecheck` 看得见**——而它在 CI `build-test` 里跑在单测之前。结果就是"测试全过、CI 却红在一个测试全过的文件上"，且症状容易被误判成当次 PR 引入的回归。这份文件从 2026-08-15 加进来那天起就是红的，一天后才被发现（当时在做另一件事：删除失效的 `vitest.render.config.ts`）。

**写法**：替身要照抄被替代函数的参数表，`vi.fn((_kind: string, _size: number, _color: number) => …)`。顺带好处是 `vi.mock` 工厂里那些 `(...a: unknown[]) => fn(...(a as []))` 的强转也可以一并删掉，直接按真实签名转发。**加新替身时记得本地先跑一次 `npm run typecheck`**——单测绿不代表这层绿。

## UI 冒烟层（test:ui）—— 价值与边界

**思路**：`test/harness/pixiHeadless.ts` 把 PIXI 的 DOM adapter 换成纯 JS 桩（canvas/context/measureText 都是 no-op 但返回 real-ish 尺寸），让真实场景代码在纯 Node 里构建 PIXI 树、量文字、布局。**从不创建 Renderer**，所以 WebGL/GPU 全程不碰。

这是 **启动 / 回归冒烟层**，不是像素级视觉回归层。它能抓的是「场景构造抛异常 / 读到 undefined 布局矩形 / 命中矩形溢出或重叠」这类一进功能就崩的故障。

覆盖范围：
- `scenes.ui.ts` —— 几乎所有菜单/弹层场景（Intro/Login/Lobby/Settings/Shop/Gacha/Campaign/LevelPrep/Collection/Stats/Room/Friends/Chat/Result/World/Family/Sect/Auction），横竖屏各跑「建得起 / update 不炸 / destroy 不炸」+ 一批命中矩形回归。
- `gameScenes.ui.ts` —— **对战场景 GameScene / ReplayScene**（缺口 A，见下）。
- `statsScene.ui.ts` / `textTeardown.ui.ts` —— 专项回归（Text 释放、共享 bake 纹理保留等）。
- `cardFeedPaging.ui.ts` —— `CardScene/feed.ts` 携手成长素材弹窗专项回归：相同卡（同 defId+同等级）折叠为一行并带数量步进器（`[−] n / 总数 [+]`，行体点击 +1 循环）、Confirm 计数为各组数量之和、Confirm 只喂选中数量的 id；溢出时 Confirm/Cancel 仍在屏幕内且出现滚动条（无翻页箭头）；按住拖动列表使 `feedScrollPx` 增大；拖动起始于行上不触发步进。
- `battlePassClaimOverlay.ui.ts` / `rechargeScene.ui.ts`（claim 遮罩 describe 块）/ `eventScene.ui.ts` —— **"Processing..." 遮罩卡死**回归（2026-07-26）：`update()` 只在 `BusyTracker.busy` 为 true 时才重绘（`bt.tick()` 一旦 `stop()` 就直接短路），所以领取/购买请求的每一条落地路径（成功、失败、超时）都必须在 `bt.stop()` 后**显式再调一次 `render()`**——BattlePassScene/RechargeScene 的 `doClaim` 曾经只在"非金币奖励"分支补了这次重绘，金币奖励分支和两个场景的 catch 分支、外加 BattlePassScene 的 `onBuy` catch、EventScene 的 `doClaim` catch 都漏了，遮罩会永久卡在屏幕上（背后请求其实已经成功）。三个测试文件断言遮罩层在每条分支落地后确实消失。

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

需要拉起全套后端（mongo/redis + prod compose 全部 11 个服务进程），每个小 PR 都跑一次太重；两账号真联机路径本身偶发性 flaky（网络时序），跑太频繁容易拖慢日常合并。选在**日分支合并进 main 的 PR**这一档——`.github/workflows/ci.yml` 的 `pull_request`/`push: main` 触发本来就精确对应这个节点（feature→日分支是本地 `git merge`，只有日分支→main 才开 GitHub PR，见 `claudedocs/worktrees.md`）。

`.github/workflows/ci.yml` 已有的 `e2e` job 本来就用 `docker compose -f docker-compose.prod.yml -f docker-compose.ci.yml up -d --wait` 拉起过一次全栈（供 headless `test:e2e`/`test:load` 用），浏览器冒烟**复用同一次拉起**，不再单独起一次 docker（省 CI 分钟数），只加两步：`npx playwright install --with-deps chromium` + `npm run test:browser`。

**2026-07-22 新加，`continue-on-error: true`**：CI 环境（ubuntu-latest）尚未跑过，先观察几轮 PR 确认稳定后再去掉这个 flag、转成真正卡合并的硬门槛（`steps.browser_smoke.outcome` 用来在失败时上传 Playwright HTML report，`continue-on-error` 会让 `if: failure()` 失效，故直接判 `outcome`）。

**2026-08-05 修复：`registerAndEnterLobby` 补上 FTUE 跳过步骤**——这条 flag 一直没摘掉的真实原因大概率就是这个：2026-07-29 那次 `HeadlessAppViews.showGame` 修复（commit `e5093451`，ADR-056 的 `reconcile()` 重写后，本地种的 `tutorial_done` flag 撑不过首次云同步，全新账号一律先进新手引导关）只动了 `test/harness/HeadlessAppViews.ts`——`test/e2e/full-link.e2e.ts` 的 `registerAndEnterLobby` 因为走的正是这层 headless views，`showGame()` 自动 `onExitToLobby()` 跳关，测试代码完全不用感知这件事。但 `smoke.spec.ts` 走真实浏览器 + 真实 `entries/web-e2e.ts`（没有这层 mock 拦截），它自己那份 `registerAndEnterLobby` 从写下来那天起就没处理过这个重定向——注册成功后 `goLobby()` 内部一查 `tutorial_done` 没设直接转 `goTutorial()`，`state.screen` 落地在 `'game'`（新手关卡），永远等不到 `'lobby'`，`screenIs(page,'lobby')` 20s 超时——这份预测比 `2026-07-29` 那次修复晚了一周，从来没同步过。修复：`registerAndEnterLobby` 注册后先等 `'lobby'` 或 `'game'` 二者之一，落在 `'game'` 就调 `window.__nwE2E.state.gameCb.onExitToLobby()`（跟玩家点"跳过新手引导"完全同一路径，`app/nav/game.ts`'s `goTutorial()` 里定义），再继续等 `'lobby'`。

> 本次修复仅做了源码级追踪验证（`goLobby`→`goTutorial`→`showGame`→`onExitToLobby` 全链路读过一遍，`entries/web-e2e.ts` 的通用 `instrumentViews` 包装确认会把 `GameSceneCallbacks` 存到 `state.gameCb`）+ `tsc --noEmit`，**没有跑一次真实 Playwright**——`test:browser` 需要拉起全套后端（mongo/redis + 11 个服务进程）+ web-e2e dev server，这次会话时间/篇幅上不划算再起一整套。摘掉 CI 里的 `continue-on-error: true` 之前，应该先让下一轮真实 CI 跑一次确认这条修复本身生效。

大版本发布前另加一轮**人工**四平台真机检查（[`release/acceptance-smoke.md`](../design/game/release/acceptance-smoke.md)），测的是 IAP/审核合规/真机性能，这条 Chromium-only 冒烟测不到，两者互补不重复。

> 微信小游戏入口（`entries/wechat`）不能用 Playwright，需微信开发者工具的自动化（minium / 小程序自动化 SDK）单列，超出本冒烟范围，按需另立。

## E2E / 冒烟 harness 维护红线：HeadlessAppViews 必须实现 AppViews 全接口

`test/harness/HeadlessAppViews.ts` 是 `AppViews` 的 headless 实现，E2E（`createAppCore` 全链路）与导航冒烟都靠它。**`AppViews`（含 `showLobby` 返回的 `LobbyView` 句柄）新增方法时，必须同步在 HeadlessAppViews 补桩**。两类漏补的暴露时机不同：

- **顶层 `AppViews` 方法**（如 `showTitles`/`showDaily`/`showCity`）：`HeadlessAppViews implements AppViews`，漏补现在被 `npm run typecheck` 编译期抓到（CC-1 清理时补齐了这批）。
- **句柄对象方法**（`showLobby` 返回的 `LobbyView`、`showRoom` 返回的 `RoomView` 等匿名对象字面量）：结构子类型 + 可能没被 core 调用点静态命中，**TS 不一定报**，漏补会在运行期抛 `xxx is not a function`。这类仍需手动对照接口补桩。

典型坑（2026-06-27）：onboarding §4.1 的首次功能引导 `lobby.showFeatureGuide(...)` 加进 `AppViews.LobbyView` + 真 `LobbyScene`，但 headless `showLobby` 返回的句柄漏补，导致一切 guide-gated 入口（onOpenShop/social/cards/world/daily）E2E 一点就崩。headless 补桩约定：引导类方法**直接调 `onDismiss()`**（模拟玩家立刻关掉引导卡继续导航），不真渲染卡片。

## 补测试本身也会抓到新 bug（2026-08-03 全批次回归测试）

对 2026-08-03 那次全代码审查修复的 30 项问题逐一补测试时，`test/net-session-game-nulled.test.ts` 的"资源回收类"回归测试（4409 致命关闭后 `NetSession.game` 应置空）直接跑出一个新 bug：`NetSession.connectGame` 的 `onStateChange` 判空逻辑当时还写的是 `else if (s === 'closed')`，是**本次审查更早修复的另一条**（`NetClient` 把致命关闭码的 `NetState` 从 `'closed'` 改名成独立的 `'disconnected'`，见 client-modules.md 同日条目）落地之后的遗留——两条修复本身各自都对，但没同步，导致致命关闭时 `this.game` 其实从未被置空。测试写完直接跑红，当场发现，顺手修了（`else if (s === 'closed' || s === 'disconnected')`）。

**教训**：多条关联修复之间的交互点（尤其是"改了一个状态机的取值集合，另一处 switch/if 分支硬编码了旧取值"这种模式）光靠人工 review 容易漏，补充回归测试时哪怕是给"已经修好的东西"补测试，也该老老实实跑一遍断言，而不是假定源码一定对——这次要不是测试断言用了真实的 `expect(s.game).toBeNull()` 而不是"不抛错就行"这种弱断言，这个漏洞会一直潜伏到下次真机联机被踢才暴露。

## 全量覆盖审计（2026-08-05）

对 `client/test/` 全部 277 个文件做了一轮遗漏/冗余审计（按子系统拆成并行审计，覆盖 net/session/replay/proto、engine/campaign/difficulty、UI 菜单场景、社交+SLG、渲染/布局/平台/nav、E2E/浏览器/负载 六大块）。落地的改动：

- **删除**：`test/EntityIds.test.ts`——是 `server/engine/src/__tests__/{unit,building}-id-per-instance.test.ts` 的严格子集（同一份 `@nw/engine` 源码，server 侧覆盖更深，含 mid-match 第二个 GameState 的幽灵实体历史回归），client 侧没有独有价值。
- **改名+新分层**：`test/diag.test.ts` / `test/experiment.test.ts` → `test/diag.manual.ts` / `test/experiment.manual.ts`（见上方"手动调参脚本层"）——两者零断言，之前混在 `*.test.ts` 里虚增通过计数。
- **修了两条名实不符的弱测试**：
  - `test/garrison.test.ts` 的"arrow tower attacks attacker units"用例之前从未真正生成攻击方单位，注释里承认"No further assertion needed"——现在真的用一张手牌卡在塔的射程内落子，断言塔确实造成了伤害。
  - `test/ui/mailUnreadBadge.ui.ts` 的"连续打开两次不会变负数"用例断言是 `toBeGreaterThanOrEqual(0)`，被源码自身的 `Math.max(0, …)` 兜底掩盖成一个恒真断言——现在断言 `markMailRead` 确实被调用了两次、且钳制后精确等于 0。
- **补了 7 个此前零覆盖的模块**（均为多个独立子审计一致标记为高价值缺口）：`net/replayCompress.ts`（分享回放 gzip pack/unpack round-trip）、`net/judgeRunner.ts` 的 `runSiegeJudge`（SLG 攻城反作弊重算，此前只测过 PvP/PvE 两条分支）、`cache/ObjectPool.ts` + `cache/poolRegistry.ts`（`drain()` teardown 契约 + 内存监控快照聚合，§4/§8.3 内存泄漏修复依赖的收口点）、`analytics/queue.ts`（`MAX_QUEUE_SIZE=200` 静默丢弃上限 + flush 重试/退避 + `flushSync` 双路径）、`i18n/index.ts` 本体（`detectLocale`/`initI18n` 优先级/`setLocale` 持久化通知/`t()` 回退链，此前 `i18n.test.ts`/`i18n-t.test.ts` 只测了词典内容，从不碰这个模块自身逻辑）、`platform/ota.ts` 的 `isNewer()`（补 `export` 使其可直接单测，同 `judgeRunner.ts` 导出 `matchStateHash` 的先例）、`platform/uuid.ts`（三条 UUID 生成路径 + 设备 id 持久化）。

审计发现的缺口远多于本次修补的量（尤其是 Sect 侧几乎整体空白、大量场景的"网络动作方法被 mock 绕过从未跑真实现"、`app/nav/lobby.ts` 枢纽模块几乎零覆盖等）——本次只挑了确认度最高、性价比最好的一批处理，其余留作后续任务的输入，不在此文档展开（避免与代码脱节，按需去问当次审计的完整清单）。

## Sect 测试补齐（2026-08-05 审计 backlog 第 1 项）

补了审计标记的"Sect 几乎整体空白"缺口（对比 Family 侧覆盖详尽形成的最大不对称）——结盟/解盟、罢免投票、加入宗门、频道发送四类动作方法此前只在 `sectActionBusyLock.ui.ts` 里被 doLeave/doDissolve"代表性"跑过 busy-lock 机制，四者自身的网络请求体、成功/失败分支从未真正执行过一次：

- **`test/sectActions.test.ts`**（纯 node 单测，`ActionsMixin(FakeBase)` 直接挂载，无需 PIXI——跟 `familySendButton.test.ts`/`familyChannelInput.test.ts` 同一模式）：28 个用例覆盖 `doJoin`/`openBrowseList`（真实 joinSect 请求体 + 失败不落地 + busy-lock）、`doAlly`/`openAllyList`（候选过滤——排除自己的宗门和已结盟的宗门）、`doUnally`/`openManageAllies`（已结盟列表解析、失联宗门 id 静默丢弃不崩）、`openAlliesView`（只读，不接 onPick）、`doVote`/`confirmVote`（passed/未 passed 两条 toast 分支、失败分支、busy-lock）、`doSendChannelMessage`（trim + 双发防抖 + 失败时草稿保留以便重试 + destroy 后不二次 render）。
- **`test/ui/sectRemovalVoteGate.ui.ts`**（headless PIXI，真渲染树）：罢免投票按钮的权限门（`renderFamiliesList` 的 `isFamilyLeader && !isLeaderFam`）——家族族长在**除当前宗主家族外的每一家**（包括自己的家族，即"自我提名"是合法路径）都能看到 Vote 按钮，普通成员完全看不到；投票进行中的 banner 文案（含票数/所需票数）；提名对象已离开宗门时 banner 落回原始 familyId 而不崩。

两个新文件加起来 33 个用例，均驱动真实 mixin 方法体（不是断言"UI 调用了 net.xxx"）。跑通需要 worktree 里对 `server/` 单独 `npm install`（`@nw/shared` 经 vitest alias 直接指到 `server/shared/src`，其 `jwt.ts` 依赖 `jsonwebtoken` 走 node_modules 解析，client 侧整体 junction 挂不到这个包——见 `claudedocs/worktrees.md` 的 workspace 陷阱条目）。

## 网络动作方法真实实现补测（2026-08-05 审计 backlog 第 2 项）

补了审计标记的"大量场景把网络动作方法 mock 掉、测试只断言'UI 调用了 net.xxx'、从未跑过方法自身的请求体/成功/失败分支"缺口。按场景拆成 7 个新/扩文件，每个都直接驱动真实方法体：

- **`test/friendsWorldChatAndClaim.test.ts`**（纯 node 单测，`NetworkMixin(FakeBase)`，spy 掉同 mixin 内的 `loadWorldMessages`/`refresh` 隔离目标方法）：12 个用例覆盖 `doSendWorldChat`（空/纯空格/双发防抖/无 cb 四类 guard；成功路径的 trim+清空+重新置底+成功 toast+refreshWallet+重拉；失败路径草稿保留、`refreshWallet()` 拒绝也算失败但因清空发生在 await 之前不回滚）、`doClaim`（成功置 `claimed=true`+toast、`ok:false` 软失败不置位但仍 `refresh()`、`ALREADY_CLAIMED` 专用 toast、无 code 兜底）。
- **`test/ui/worldMapNetActions.ui.ts`**（headless PIXI 套件下的纯逻辑用例，`new WorldMapNet(ctx)` 对纯对象 `ctx`，同 `worldMapErrorMsg.ui.ts`/`worldMapOccupyTeamPicker.ui.ts` 先例——WorldMapNet 本身不摸 PIXI）：17 个用例覆盖 `loadData`（destroyed 短路、season/mapW/mapH/nations/me 落地、`map` vs `mapSparse` 两种 tile 合成、`justJoined` toast 门、worldChatUnread 按 seenTs 过滤、enterWorld 拒绝时"offline OK"静默吞掉但仍重渲染、请求期间被 destroy 则跳过重渲染）、`doRelocate`/`doWatchtower`（成功清 tileCache+重新定位+`loadMapViewport()`+成功 toast，`doWatchtower` 响应缺 `me` 时防御性保留旧值，失败分支两者都不落地重拉/不出成功 toast）、`doAbandon`（成功只删目标 tile 不动其余缓存、**无成功 toast**——跟 relocate/watchtower 不同、失败分支连 delete 都不执行）。
- **`test/shopActions.test.ts`**（纯 node 单测，`ActionsMixin(FakeBase)`）：16 个用例补上 Shop 侧此前完全没有的 busy-lock 覆盖（`onBuy` 双发防抖）+ `onRedeem`/`onRecharge` 的全部guard/成功/失败/超时分支——此前两者在所有测试里只被当"构造期回调占位"喂给场景，从未被真正点击/调用过；`onRecharge` 专门验证它**没有** `withTimeout` 包裹（用户支付节奏不该被杀）。
- **`test/gachaDrawAndFateActions.test.ts`**（纯 node 单测，`Object.create(GachaSceneBase.prototype)`——`onDraw`/`onRedeemFate` 是裸类方法非导出的 mixin 工厂，不能直接 `ActionsMixin(FakeBase)`，改用原型链挂载让 `pool` getter 和两个方法真跑）：10 个用例补 Gacha 侧此前**零覆盖**的 busy-lock（两个方法都补）+ `onRedeemFate` 的全部分支（此前从未被任何测试真正调用过一次）+ `onDraw` 的 catch/timeout 分支。
- **`test/ui/auctionActionBusyLock.ui.ts`**（扩展既有文件）：新增 `doCancel` 的成功（真实 cancelAuction 请求体 + toast + 两个 listing feed 一起重拉）/失败/超时三个分支——此前这个文件只证明了 doCancel 第二次调用是 no-op，从未跑过第一次调用自己的请求体。
- **`test/ui/auctionScene.ui.ts`**（扩展既有文件）：新增 `doBid` 成功路径（此前只有两条 catch 分支——`AUCTION_CLOSED`/`BID_TOO_LOW`——被覆盖，成功路径完全没测过）。
- **`test/defenseEditorDataActions.test.ts`**（纯 node 单测，`DataMixin(FakeBase)`，同 `familyLoadDecouple.test.ts` 先例）：18 个用例覆盖 `applyConfig` 的全部容错分支（合法/非法 unitType、越界 col/row、非法 buildingType、`defenderBaseLevel` 钳制/floor/非数字兜底、重复调用先清空）+ `doSave` 防守模式的真实 `setDefense` payload 组装（**确认了审计的前提：`doSave`/`applyConfig` 自身不做任何"最少兵力/预算/必填槎位"校验，空编队也能直接存**）+ busy-lock + `TILE_NOT_OWNED`/`CARD_INJURED`（真的从 garrison 里删掉受伤卡）/兜底三条失败分支 + 攻击模式委托 `persistTeam`/`setTeams` 的成功路径。
- **`test/ui/defenseEditorDragPlacement.ui.ts`**（headless PIXI，真实 `DefenseEditorScene` + 真实 `render()`，同 `defenseEditorAttackCards.ui.ts` 先例）：6 个用例是这批里唯一需要真渲染树的——之前所有摆放测试都是直接改 `this.tool` 调 `onGridTap()`，完全跳过了 `handleDown`/`handleMove`/`handleUp` 这层"到底是点选/是拖拽/是滚动"的判定逻辑，零覆盖。新覆盖：卡池按下只是"武装候选"不落子、越过卡池左边界才真正升级成拖拽、松手在合法格子落子并清空拖拽态、松手在非法列（不在 ATTACK_LANES）不落子但仍清拖拽态、同一张卡二次拖拽到新格子会移动（老格清空）、卡池内纯竖直拖动只触发滚动不触发拖拽。

跑通同样需要 worktree 里对 `server/` 单独 `npm install`（见上一节同一条 workspace 陷阱）。

## `app/nav/lobby.ts` + `nav/room.ts` 枢纽补测（2026-08-05 审计 backlog 第 3 项）

审计标记这两个文件"几乎零覆盖"——之前唯一碰过 `nav/lobby.ts` 的 `lobby-feedback-nav.test.ts` 只测了 `onOpenFeedback` 一个入口的门控，`lobbyFormat.test.ts`/`lobbyHeader.test.ts` 只测纯格式/几何函数；`nav/room.ts` 一个单测都没有。

- **`test/lobbyNavBadgesGuideRanked.test.ts`**：手搓 `views.showLobby`（不用 `HeadlessAppViews`——它的 `showFeatureGuide` 会立刻自动调 `onDismiss()`，没法区分"还没显示引导卡"和"引导卡显示中等待关闭"两种状态），驱动真实 `createLobbyNav()`/`goLobby()`。18 个用例：
  - `refreshLobbyBadges`：`getLobbyBadges` 成功落地 social/achievement/retention/events 四类红点、2026-08-05 那次 weekly-only 红点修复的回归、首次刷新只打基线不弹 toast、第二次刷新真的检测到新达成的成就 tier 才弹 toast+`achievement_unlock_toast`、拉取失败静默吞掉（**但 `applySocialBadge` 仍会被 goLobby() 自身的"先画缓存值"那行同步调用一次，不是这次拉取的成功路径**——踩了一次这个坑才发现）、离线/resize 不拉取。
  - `withGuide`（借 `onOpenSocial` 代表所有被这层包过的入口）：首次点击显示引导卡+立刻标记已读（不是等 dismiss 后才标记）+ `feature_guide_shown` 埋点，导航推迟到真正调用 `onDismiss` 之后才发生；已读过则直接导航，引导卡完全不出现。
  - `onStartRanked`：解锁池 = `PVP_DECK_SIZE` 时跳过组卡器直接 `goRoom`，已有合法卡组不重复 `patchLocal`（省一次写），已有非法卡组会被覆盖；解锁池 > `PVP_DECK_SIZE` 时改走 `goDeckBuilder`，其 onSave 回调才是真正触发排位的地方。
  - 赛季结算弹窗：首次进入只记录当前赛季号不弹窗；同赛季号重进不弹；赛季号变大才弹（`peakRank` 兜底到当前 `rank`）；`fromResize` 完全跳过这段（连 storage 都不写）。
- **`test/roomNav.test.ts`**：手搓 `NetSession`（只实现 `room.ts` 真正摸到的那几个方法）+ `HeadlessAppViews` 驱动真实 `createRoomNav()`/`goRoom()`。18 个用例覆盖 `createRoom`/`joinRoom`/`setReady`/`startMatch`/`createRanked`/`cancelQueue` 的直通转发、`onBack` 收尾（关会话+ handlers 收窄到只剩 `onMatchStart` + 回大厅）、无 session 时 `available:false`、房间状态/错误推送落地；autoRanked 分支（网关已开时同步立即排位、未开时等 `onNetState('open')` 才排、同一个 open 事件重复推送不二次排位、`cancelQueue()` 之后下一次 open 能重新排位、无 session 时只警告不抛错）；`onMatchBot` 兜底（合法/非法难度字符串解析、排位标志复位后能再排）；`goDeckBuilder`（真实持久化 `pvpDeck` + 转发 `onSave`、无存档时兜底默认卡组）。

两个新文件加起来 36 个用例。跑通同样需要 worktree 里对 `server/` 单独 `npm install`。

## `proto-wire-compat.test.ts` 向量补全（2026-08-05 审计 backlog 第 4 项）

审计标记这个文件的字节级向量落后于 `transport.proto` 演进——只覆盖最初的 9 个 `ClientMsg` + 9 个 `ServerMsg` oneof 分支，之后新增的 `duel_invite`/`duel_respond`/`client_caps`/`judge_verdict`（client 侧）和 `judge_request`/`friend_*`/`chat_message`/`mail_new`/`march_update`/`tile_update`/`under_attack`/`siege_result`/`family_msg`/`sect_msg`/`nation_msg`/`match_bot`/`duel_invited`/`duel_cancelled`/`queue_state`/`pre_match_lost`/`match_found`（server 侧，19 个）全部零向量，尽管文件头部注释本身就写着"改了 proto 就要重新生成向量"。

**更根本的问题**：这个"重新生成"步骤其实从来没有过脚本——`_proto_vectors.json` 是某次手工跑出来的产物，此后没人跑过第二次。新增：

- **`client/scripts/gen-proto-vectors.mjs`**：独立加载 `server/contracts/transport.proto`（用 protobufjs，`keepCase:true`——跟 `server/gameserver/test/transport.test.ts` 交叉校验服务端手写编解码器用的是同一套机制），对每个 `ClientMsg`/`ServerMsg` oneof 分支各构造一条样例消息，`Envelope.encode()` 后转 hex，写回 `_proto_vectors.json`。protobufjs 是 server workspace 的依赖，client 侧没装——脚本用 `createRequire(server/package.json)` 从 server 的 node_modules 借，不为了一个一次性脚本给 client 加依赖。新增 `npm run proto:vectors`（`client/package.json`）。跑出来的旧 9+9 条向量跟仓库里原有的逐字节相同，验证了这个构造方式跟原作者当年用的是同一套。
- **`test/proto-wire-compat.test.ts`**：client 侧新增 4 条（塞进现有 `clientCases` 循环，自动走 encode+decode round-trip 比对，不用额外写断言）；server 侧新增 19 条 `it('decodes X', …)`，逐字段断言（`match_found`/`judge_request`——含 `frames`/`topDeck`/`bottomDeck`/`cardInstancesJson` 等 PvE/攻城重算专用字段/`friend_presence`/`friend_request`/`friend_update`（`REMOVED` enum 值）/`chat_message`/`mail_new`/`march_update`/`tile_update`/`under_attack`/`siege_result`（含 2026-08-02 那次 `attackerId`/`marchKind` 归属修复的字段）/`family_msg`/`sect_msg`/`nation_msg`/`match_bot`（uint64 seed + 十进制字符串 difficulty）/`duel_invited`/`duel_cancelled`/`queue_state`（无字段消息）/`pre_match_lost`）。41 个用例全绿（13 client + 28 server）。

以后改 `transport.proto` 新增/改动 oneof 分支：先 `npm run proto:gen`（生成 TS），再 `npm run proto:vectors`（重跑权威字节向量），最后在 `proto-wire-compat.test.ts` 补对应的 `clientCases` 条目或 `it('decodes X', …)` 断言——三步缺一都会让这层"client ts-proto ↔ server protobufjs 字节级互通"回归测试形同虚设。

## 组合化 lazy hook / merge 行为回归（2026-08-12）

2026-08-11/08-12 那批 client 端 `XMixin(Base)` 继承链 → 组合（独立类 + composition）转换里，每条链的双向依赖都是用 **lazy hook** 解开的：`XSceneCore` 上声明一个**默认 no-op** 的字段，外层 assembly 在真正的兄弟类构造出来之后立刻覆写成 `() => this.sibling.method()`。已有的 `test/ui/composition-wiring.ui.ts` 只钉住这件事的**身份**一半（`expect(core.someHook).not.toBeUndefined()`、`expect(a.sibling).toBe(scene.sibling)`）——但 hook 字段**永远**是 defined 的（no-op 默认值的全部意义就在这儿），所以 assembly 哪怕完全漏掉某一行 `this.core.xHook = ...`，这些断言照样全绿。

逐个 boundary 做了"删掉 assembly 里的 hook 赋值、看现有全量套件红不红"的实测，结论分成两半：

**已被现有测试真实覆盖（不重复补）**——删掉 hook 赋值后立刻变红：

- CardScene `core.doFuse`（feed 的确认按钮 → `ActionsPanel.doFuse` → `FeedPanel.playFusionAnim`）：`test/ui/cardFusePanel.ui.ts` 红 14 条，含它自己那条 "end-to-end: the real animation + busy update() ticks run to completion" 全链路。
- EquipmentScene `core.doEquipHook`（AssignPanel 卡片选择器 → `DetailPanel.doEquip`）：`test/ui/scenes.ui.ts` 的 "bag mode: instanceActions(Equip) → … → core.doEquipHook → …" 变红。
- EquipmentScene `core.refreshInstanceCellHook`（`DetailPanel.doEnhance` → InventoryPanel 单格增量重绘）：`test/ui/equipmentEnhanceIncrementalRedraw.ui.ts` 第一条变红——no-op 默认值返回 `false`，`doEnhance` 退化成整屏 `render()`，把该测试按身份钉住的 cell container 全换掉了。（默认 worker pool 下这条退化路径会先把 worker 堆吃爆再报断言，`--pool=threads` 才看到干净的 `Object.is` 失败；两种情况都是红。）
- GameRenderer `core.input` / `core.events` 反向引用：gameRendererInput / SpellInput / SurrenderRace / gameScenes 合计红 14 条。

**完全零行为覆盖（本轮新补）**：

- **`test/ui/worldMapRefreshBundle.ui.ts`（5 条，本批风险最高）** —— WorldMapRenderer 转换没用 lazy hook，而是把 `pool.invalidatePool()` 里那捆 "pool + city + fog 全刷" 的编排**上提到了 assembly**，再以 `refreshMap: () => void` 闭包注入给 `build.ts`/`viewport.ts`/`lifecycle.ts`。于是这三处各自成了一根可以被悄悄拔掉的线：`build.ts` 改回调 `this.pool.invalidatePool()`（转换前的方法名在 pool 兄弟类上**仍然真实存在**），瓦片池照样完美刷新，而城市精灵原地冻结、交互 overlay 变陈旧——正是转换前那条 pool↔city 环存在的意义。5 条用例分别驱动 `build()` / `setZoom()` / `renderMap()` / `refreshPool()` / `lifecycle.bootstrap()`（走它自己的 8s 安全网 reveal，因为 headless 下 atlas 的 `Promise.allSettled` 永远不落地），每条都用真实可观察状态而非 spy 计数断言三个域都真干了活：pool 看 `ctx.pool` 槽位的 `tx/ty` 是否从哨兵值被重新赋值、city 看 `ctx.citySprites` 容器的屏幕 x/y 是否跟住当前 pan/zoom、fog 看 `ctx.fogGfx` 的 PIXI geometry 是否非空（`renderFog()` 只可能经由 `fog.renderOverlay()` 到达，所以画过的 fogGfx 就是这半边跑过的证据）。
- **`test/ui/composition-hooks.ui.ts`（13 条）** —— `composition-wiring.ui.ts` 的**行为**对照件：
  - AuctionScene `core.reopenCreateForm`（3 条）：删掉这行赋值，275 条 auction/scene 测试全绿——物品选择结果照样落在 Core 上（`auctionPickerDedupe.ui.ts` 的断言全通过），但玩家被丢回普通市场列表，刚才填了一半的上架表单直接从屏幕上消失。新用例走真实路径（打开创建表单 → 点 `modalHits[0]` 物品字段 → 选中条目 / 点 header Back 取消 / ref-band 请求迟到回调），断言表单真的回到屏幕上、且渲染出刚选中物品的标签（证明是选完之后重新 render 的，不是选之前的旧画面）。
  - EquipmentScene `core.cancelAssignHook`（1 条）：此前没有任何测试碰过 `backAction()`。新用例进入 assign 子模式后点 header Back，断言选卡器被取消且 `cb.onBack()` **没**被调用（no-op 默认值会让 Back 在选卡器里彻底失灵）。
  - LobbyScene `core.buildHook`（3 条）：删掉赋值后全量 163 文件 / 1491 条全绿——因为 assembly 构造函数是**直接**调 `this.build.build()` 的，首屏绘制根本不经过 hook。而 `rebuild()` 是先把整个 container 拆掉再调 hook 重绘，所以 hook 一死，任何 rebuild（活动窗口开启、`onSaveChanged` 钱包写入、coin-icon atlas 首屏后就绪）都会把大厅刷成**全白**。新用例走 `applyEventsAvailable(true/false)` → `BadgesPanel` → `core.rebuild()` → `buildHook()` → `build()`，断言 container 重新有子节点、且 `eventsBtnRect` 真的出现/消失；另加一条钉住"assembly 自己那个 `unsubs` 数组在 destroy() 时真被 drain"（LobbyScene 是本批唯一 update/destroy/`input.onDown` 不归 Core 的链，`core.destroy()` 单独跑并不会解开这个订阅——`test/input-subscription-cleanup.test.ts` 只静态扫同文件里有没有 push+drain 这一对，不验证运行时）。
  - GameRenderer `EventsPanel` 经 `core.input` 取消拖拽/点选（6 条）：`card_played`/`card_expired`/`game_over`/`game_draw` 这 4 个事件此前只被单独测过，从没有一条测试是**拖拽真的在进行中**的时候把事件投进去的——也就是这几个分支之所以需要 `core.input` 的那半边跨域调用从未被执行。新用例用真实 `_emitDown/_emitMove` 起一个未松手的拖拽（或 down+up 起一个 tap-select），再 `events.handleEvent(...)`，并各配一条反例（对手的 `card_played`、别的手牌槽位的 `card_expired`）证明不是无脑清空。
- **`test/familySendButton.test.ts` 新增 "the merged text-entry + send unit" describe（3 条）** —— FamilyScene 的双向依赖是用**合并类**（不是 hook）解的：`doSendMsg`/`submitMessage` 从 actions.ts 搬到了 `InputPanel`，和 `openSendInput`/`openInputFor` 同居。原有测试两半各测一边，而且"还没有草稿 → 打开输入框"那条**把 `openSendInput` mock 掉了**，所以两半从来没在真实类上互相驱动过一次。新用例跑完整往返（第一次点 Send 打开真实隐藏 input → 输入 → blur（真实点击时 blur 先把 `core.sendInput` 置空）→ 第二次点 Send 提交刚输入的内容），外加 Enter 键这另一张脸。合并**新引入**的风险就是两条路径共享 Core 上的 `sendText`/`sendInput` 且**动作顺序是有意义的**：`doSendMsg()` 必须在移交给 `openSendInput()` **之前**清 `sendText`（后者用它给新 DOM input 播种），把这两句换个顺序，重开的输入框就会带着刚发出去的旧草稿——用例特意用"纯空格草稿"入场把这个顺序变得可观测（实测：不用空格草稿的话换顺序不变红）。

**每一条新用例都做了 red-then-green 实测**（逐个临时破坏对应接线/断言目标，确认变红，再还原）——具体破坏点见各文件头部注释。收尾验证：`tsc --noEmit` 干净，`npm run test:ui` 163 文件 / 1491 条绿，`npm test` 161 文件 / 1283 条绿，`npm run build:web` OK。

## `rewardIcon.test.ts` 补测（2026-08-16）

修上面那条 TS2493 时顺手审了一遍 `render/rewardIcon.ts` 的覆盖面（9 → 21 条）。原有用例只断言"每种 reward 走到哪个 IconKind"，剩下的契约全是空白：

- **`preloadRewardIconArt()` 此前零覆盖**，而它的全部价值就在失败路径：六个场景都是 `void preloadRewardIconArt().then(() => this.render())` 这样 fire-and-forget 调的，一旦它往外抛，单个 atlas 404 就会变成六块不相干屏幕上的 unhandled rejection——而这个失败本来只该表现为"程序化 glyph 多画一两帧"。撑住这件事的是 `Promise.allSettled`，改成 `Promise.all` 是一个词的编辑，此前没有任何测试会发现。新增 5 条：三个 loader 各失败一次 + 三个全失败，都断言仍然 resolve，且**其余 loader 照样被调用**（不因一个坏源短路）。
- **`size` / `color` 透传此前零覆盖**——只断言过实参 0（kind），所以任何一条路线把尺寸/墨色丢掉或调换顺序都没人管。新用例给四条路线（tab-icon / coin / material / 裸材质 kind）各喂一组不同的 size+color，串线也能抓。
- **`materialFallback` 不得盖过已识别的 id**：源码是 `materialKind(id) ?? fallback`，两者顺序调换会让 EventScene 的 `materialFallback: null` 把**所有**材质行都清空（而不只是不认识的那些）。
- 另补 `count` 缺失时的 `?? 0` 分支、`material` 无 id 时回落 scrap、以及 `coinIconTier` 各档**阈值下方一格**（原有用例正好压在阈值上，只钉住 `>=`→`>`，钉不住"阈值被悄悄调低"）。
- **一条"测试自己的测试"**：原有断言把期望值写成字面量 `'rosterIcon'`，而 `buildIcon` 在本文件里是被 mock 掉的——也就是说把源码和期望表**一起**改回程序化的 `'cards'`/`'armor'`/`'brush'`（这正是 2026-08-15 那个 bug 的原貌），整份文件照样全绿。新用例用 `vi.importActual` 读真实 `icons.ts`，断言这三个 IconKind **不在导出的 `DRAW` 表里**——`DRAW` 的 key 恰是 `DrawableIconKind`，而 `IconKind = DrawableIconKind | RasterIconKind` 两半互斥（2026-08-18 拆出 `icons/tabIconRaster.ts` 前写成 `DrawableIconKind = Exclude<IconKind, RasterIconKind>`，等价），所以"是 DRAW 的 key"等价于"是程序化 glyph"。实测：把 card 改回 `'cards'` 并同步改期望表，只有这一条变红。

六条新断言全部做了 red-then-green 实测（逐个破坏源码确认变红再还原，破坏点见上）。收尾验证：`npm run typecheck` 干净，`npm test` 158 文件 / 1335 条绿。

**第二轮（同日，21 → 25 条）**，补的是"mock 看不见的那一半"——上面那批断言全都盯着实参字符串，而三个 builder 在本文件里是假的，所以**字符串本身是否对应真实素材**、以及**服务端会不会送来没人处理的 kind**，两处都没人看：

- **coin / material 两条路线的"素材表交叉校验"**（对应上一轮给三种道具做的 `DRAW` 校验）：`coinIconTier` 能返回的 5 个 tier 必须在 `assets/shop/coins.json` 的 frame 名里，`materialKind` 认的 3 个 id 必须在 `assets/icons/icons_atlas.json` 里（材质走共享 L0 icons atlas）。改名一档或加第六档而没配图，此前整份文件照样全绿，运行时静默退回程序化 glyph——正是 08-15 那个 bug 的形态，只是换到 mock 遮住的那条路线上。实测把 `coinChest` 改成 `coinChestX`：该条变红。
- **`opts.coinKind` 不得泄漏到非 coin 路线**：RechargeScene 是对一档里的**每个** reward 都传 `{ coinKind }`（不只 coins），所以把这个 lookup 提到 kind dispatch 之上会把它的卡牌/材质行画成钱堆。实测把 card 路线改成 `buildIcon(opts?.coinKind ?? 'rosterIcon', …)`：只有这条变红。
- **服务端 kind 全集的编译期穷举**：`RewardLike.kind` 是裸 `string`，类型上跟喂它的五个服务端联合类型（`CheckinRewardKind` / `WeeklyChestRewardKind` / `BpRewardKind` / `RechargeRewardKind` / `MailAttachmentKind`）没有任何连接——服务端加一种 kind，客户端编译照过，六块屏幕上静默渲染成无图行。新用例用 `Record<五个联合, 'picture' | 'text'>` 把这条线接上：少一个成员就 `npm run typecheck` 报 TS2741（实测删掉 `skin:` 一行确实报），逼人显式给新 kind 做决定；运行时再断言这个决定跟 resolver 的实际行为一致（实测删掉 skin 路线：该条 + 对应 each 用例变红）。表里 `stamina`/`item` 标 `'text'` 是**有意无图**（调用方画 capsule 或裸 "+N"），不是待办。
  - 这四个联合是 `import type` 直接从 `../../../server/shared/src/*` 拿的，不走 `@nw/shared`——那个 alias 在 `vitest.config.ts` 里只指向浏览器安全的 SLG 切片。type-only 导入运行时被擦除，不会把服务端模块拉进测试进程。

四条新断言同样逐条 red-then-green 实测。收尾验证：`npm run typecheck` 干净，`npm test` 159 文件 / 1341 条绿（本机另有一个别的会话未提交的 `test/textureLoadedGuardCallSites.test.ts` 在红，与本次无关，已排除计数）。

### ⚠️ 坑：唯一一条真导入的用例卡在默认 5s `testTimeout` 上（2026-08-19 实测踩过）

上面那条"测试自己的测试"（`vi.importActual('../../src/render/icons')`）是**全文件唯一一处真正加载 icons 模块**的地方——其余用例都被顶部的 `vi.mock` 挡住了。它要付的代价是完整 transform/collect 一遍 `pixi.js-legacy` + 光栅图标 atlas 依赖图，而这个代价**波动极大**（同一棵树上实测 vitest `collect` 合计 223s–498s），刚好压在 vitest 默认的 5s `testTimeout` 边上：

- 单跑该文件 ~2s 稳过；
- `npx vitest run` 全量跑、且机器上同时有别的负载（并发的另一个 suite、一次 webpack 构建）时，间歇性 `Test timed out in 5000ms`；机器空闲时连跑三轮全绿。
- 与任何源码改动无关（有/无其它未提交改动都复现过）。

**修法**：给这**一条**用例显式加 `}, 30_000)`，不要调高全局 `testTimeout`——冷导入的代价只有它在付，全局放宽等于把别处真卡死的用例也一起放过。这也是本仓库既有的约定：`campaign-clear-pipeline` / `campaign-real-layer-interlude-nav` / `judge-runner` 用 `30_000`，`capacitorStubCompile` 用 `60_000`，`pvpSim` 用 `60_000`–`180_000`，全部是**逐用例第三参**；只有 e2e / load 这类整份都慢的 config 才在 `vitest.*.config.ts` 里设 `testTimeout`。另一种可行做法是把 `importActual` 提到 `beforeAll` 里（代价只付一次、且不算进用例预算），但那样反而要额外解释"为什么这个文件有个 beforeAll"，逐用例超时更贴合现状。

验证：`npm run typecheck` 干净，`npx vitest run` 172 文件 / 1460 条绿。

## 性能契约怎么测：拿「重绘次数」当断言，并用 mutation 验证它不是空转（2026-08-20，社交页签卡顿修复）

`design/game/SOCIAL_DESIGN.md` 同日那行修的是三处「本来不该发生的整树重建 / 网络请求」。这类修复的麻烦在于**它没有可见产出**——页面长得一模一样，只是少做了事，所以断言必须直接钉住「做了多少次」，而不是「结果对不对」。三条经验：

- **重绘次数：替换 `core.render`，不要 `vi.spyOn(scene, 'render')`。** 场景自己的 `render` 是 private，且真正被各面板/`NetworkPanel` 调用的是构造时注入的 `core.render` 回调；spy 外层那个既拦不全，`vi.spyOn` 拿到的包装函数在 `scene.core.render = () => spy()` 这种转写里还会丢 `this`（`Cannot read properties of undefined (reading 'core')`，本次实测踩过）。直接 `scene.core.render = vi.fn()` 最稳，`socialTabSwitchCost.ui.ts` 的 `countRenders()` 就是这个形状。
- **网络次数：让每个 callback 自增一个计数器，然后整体 `toEqual` 一个字面量对象。** 只断言「某一项没涨」很容易在别处偷偷多打一个请求；`expect(calls).toEqual({friends:1, requests:1, mail:1, conversations:1, world:1})` 把「切世界频道只该拉世界频道」这句话完整钉住。
- **⚠️ 「只平移不重建」这类优化，光断言「没重建」是不够的——必须再断言「平移后东西在对的位置」。** `expect(layer.y).toBe(-60)` 只说明图层挪了正确的距离，**不说明图层里的行当初是按正确原点排的**：漏一次 `markScrollBuilt()` 重新基准、或 build 空间算错一个像素，这条照样绿。补法是**几何等价性用例**——拖一个别扭的距离（137px，避免凑巧对齐），记下逐行屏幕 y，再 `scene.render()` 在同一 `scrollY` 上强制整树重建一次，两个列表必须 `toEqual`。**并且要 mutation 验一遍**：把 `layer.y = -delta` 改成 `-delta + 1`，确认这两条用例会同时红（本次验过，会红）——不验的话很容易写出一条恒绿的假测试，正是本文件「审计 backlog」几条老坑的同一种形状。

顺带一条接线坑：这次把 `FriendsScene` 的指针分发从 `core.ts` 的方法挪成了 `input.ts` 的自由函数，`test/ui/socialTabRail.ui.ts` 里直接调 `scene.core.onPointerDown(...)` 的地方随之全部失败（`is not a function`）。**改文件结构前先 `grep -rn "core\.\(onPointer\|handle\)" client/test`**——`client-modules.md` 第 19 条早就记过「改链会牵连测试接线」，挪方法到自由函数是同一类破坏，只是更隐蔽（`tsc` 拦不住 `as any` 的测试）。

### 「少做事」的优化会顺手撤掉别处的**意外兜底**——A/B 逐像素比对能把它抓出来（2026-08-25，宗门页签同款修复）

`SectScene` 这轮把「滚动逐帧 / 光标 0.5s / 按键 / `bt.tick()` 0.4s」四条整树重建全部换成增量路径后，多出两条上一轮没有的经验：

- **双栏场景的增量滚动，必须断言「另一栏没动」。** 一个共享的 `scrollDirty` 布尔配上「按当前列取 scrollY」的老写法，在横屏两栏并列时会把两栏一起平移，而单栏用例全绿。改成按列（band）存状态后，用例里每次拖一栏都顺带 `expect(otherLayer.y).toBe(<原值>)`——这是唯一能钉住路由没串的断言。
- **⚠️ 减少重绘 = 撤掉别处「靠重绘兜底」的东西。** `buildRasterTabIcon`（AI 图标）在纹理还没解码时**画一个空容器**，且没有任何 `loaded` 回调；这个页面以前每秒好几次的多余重建，恰好把解码完的图标「意外补上」了。删掉那些重建后，冷缓存路径下 rail/表头图标会一直空着——修法是装配壳补一行 `preloadTabIconTextures().then(() => this.render())`（CardScene/EquipmentScene 早就这么写）。**推论**：动手删「多余重绘」之前，先想一遍「有谁在偷偷指望它」（异步解码的纹理、外部推送、时间相关的文案）。
- **这类「长得一模一样、只是少做事」的改动，其实可以逐像素 A/B——不需要后端账号。** `TARGET=web-e2e` 暴露的 `window.__nwE2E.views.showSect(cb)` 能直接用桩数据挂载单个场景（`worldApi` 传字面量对象即可，`preloadedFamily`/`preloadedSect` 连 loading 都省了），于是一份 Playwright 脚本分别打**改前的主检出**和**改后的 worktree** 两个 dev server，`sharp` 原始像素相减即可。本轮结果：首帧逐像素完全一致；滚动后那帧差 0.36%，全在手绘边框上（`seedFor(cy, ...)` 的种子取自行的 build 空间 y，平移保留原种子、重建才换抖动）——**这个 0.36% 本身就是有用的信息**：它说明「滚动时手绘边框每帧重新抖动」以前是真在发生的，现在反而稳了。Browser 面板依旧不合成帧（`screenshot` 超时），走的是 `memory/playwright-screenshot-recipe` 那条路。

**同日第五轮：清单第 3 项（「快速路径会不会泄漏」）第一次真正兑现。** 之前两轮我都把它当成形式化的一条（拖 8 帧数一下子节点），这次它直接抓出一个 bug：`drawBar()` 的父容器硬编码 `bodyLayer`，于是弹窗平移时滑块被重画到**页面图层**上——弹窗的滚动条没了，页面上多出一条每帧重画的。**为什么「数子节点」能抓到它**：泄漏和「画错容器」在计数上是同一种症状（某个容器的子节点数不该变却变了），所以断言要**同时数两个容器**——内容所在的那个（不该增）和不该被碰的那个（也不该增）。只数一个就只能看见一半。教训推广：任何「每帧 destroy + 重建一个小对象」的快速路径，都要把「它被放回了正确的父容器」和「数量没涨」一起钉住。

**同日第四轮（弹窗列表统一）两条**：①**「可达性」类断言必须按屏幕位置判定，不能按「有没有被建出来」**——overscan 会把视口外一屏的行也建进图层，所以「最后一项不在屏上」写成 `layer` 里找不到那段文字是**假的**（我第一版就这么写，直接假红）。补了 `visibleModalTexts()`：只算 `y + layer.y` 落在 `modalRegion` 内的 Text。②改动把**弹窗点击从 pointer-down 挪到 pointer-up**（跟页面统一，拖列表不再误触行），而绝大多数弹窗测试是直接调 `hit.action()` 的，所以没被影响——**这正好说明「直接调 action」的测试写法在这类交互改动下更稳，但它也测不到 down/up 语义**；真正需要钉住 down/up 的用例要走 `input._emitDown/_emitUp`。另外 `modalLayer.children` 的一层扫描又踩了一次（同上一轮 `bodyLayer` 那条），两处测试改成递归 walk。

**同日第三轮（被问「还有测试可以加吗」，照清单自查又抓到一个真 bug）**：`ScrollTapGesture` 返回的是未截顶的手指位移，旧代码靠**每帧那次整树 render 里的 clamp** 把它拉回 `max`——增量重绘把那次 render 删掉后，clamp 也没了，拖过末端会把图层平移出内容之外、露出一条不会回弹的空白。**教训比 bug 本身重要：删掉一次「多余的重绘」时，要顺着问「这次 render 里除了画东西，还顺手做了什么」**——lists.ts 那句 `core[scrollKey] = Math.max(0, Math.min(...))` 就是躲在渲染代码里的**状态修正**，不是绘制。这类「渲染副作用」在本仓很常见（clamp、`channelStick` 的 pin、`peekViewportH` 的视口收缩都在 render 里算），迁到增量路径时必须逐个盘一遍，而不是只盯着「画得对不对」。本轮同时补齐了清单里此前空着的几项：滚轮未排空就点击（applied vs pending 窗口，宗门/家族两条都 mutation 验证过）、平移一行后同一点命中下一行、滚动条重画不累积子节点、图层被 destroy / 根本没建图层两种回落、竖屏只建一列、频道列的几何等价性、名册遮罩边界。

**同日续，家族页同款修复又多两条**：

- **A/B 像素差的「读图」也会读错——先按 y 分段统计，再看图。** 家族页首帧差 2.2%，叠成红色蒙层后「每行边框都红」，看着像行渲染变了；按 100px 分段数一遍才发现差异 99% 集中在 y 0–299（图标）和 y 1300–1499（底部），行区间（300–1300）**一个像素都不差**——我在蒙层里把未变化的像素画成了淡灰底，行的墨线本来就是灰的，被我读成了红。**先出数字（分段计数 / >60 / >150 / >300 的分桶），再出图**，顺序反了就会给自己讲一个错的故事。
- **这类改动会顺手暴露真 bug：** 家族名册的行原本直接画在 `bodyLayer` 上、没有遮罩，滚到底那一行整个溢出视口、**盖在底部导航条上**（`peekViewportH` 的本意是「露一截被裁开的行」，没有遮罩就成了「露一整行画在别人身上」）。给名册加遮罩层是为了能平移，但同时把这个存在很久的溢出修掉了——**逐像素 A/B 的价值不只是「证明没变」，它会把这种一直在眼前、没人报的错位摆到你面前**。

### ⚠️ 「少做事」的优化：先问「做完之后还有什么能悄悄错掉」，而不是只钉住「少做了」（2026-08-20 同日续，实测抓到自己的回归）

上一节那批断言全绿之后，被追问「有测试可以加吗」，回头审一遍才发现钉住的全是**「省掉了」这一半**（没重拉、没重建、只动了一个 `Text`），而**「省掉之后还照样对」这一半**几乎是空的。写第一条补测的过程中就撞出一个真回归：

`FriendsScene` 的行命中矩形记在 build 空间，`onPointerUp` 要加回图层的位移才能判定。我第一版用的是 `scrollY - builtScrollY` —— **待应用**的差值。但 `onWheel`/`onPointerMove` 是**同步**改 `scrollY` 的，图层却要等下一帧 `update()` 排掉 `scrollDirty` 才真的平移。于是「滚轮滚一下、下一帧还没到就点击」这一帧窗口里，屏幕没动而换算按已动来算，**点击整整错一行**（点第 3 行打开第 7 行）。改动前没有任何偏移，所以这纯粹是优化自己引入的。

**修法**是把两个概念拆开：`pendingScrollDelta`（逻辑意图，只给「平移还是重建」的判断用）与 `appliedScrollDelta`（`-layer.y`，屏幕上**实际**的位移）。**命中判定一律用「实际」那个** —— 点击必须按玩家真正看到的画面判，不能按尚未生效的意图判。这条推广得很开：任何「状态同步改、画面下一帧才跟上」的优化，都会多出一个两者不一致的窗口，而**输入处理正好落在这个窗口里**。

由此总结出的补测清单（`test/ui/socialScrollTranslate.ui.ts`），下次做同类优化可以照抄这几个角度：

1. **输入还能不能打中**——最容易漏，也最容易被用户发现。既有用例只断言了「拖拽不触发点击」，那是**反向**断言，永远不检验「点对了」。要正向断言到具体对象（这里用 `friendIndex(opened[1]) === friendIndex(before) + 1`）。
2. **不一致窗口里的输入**——刻意在「状态已改、画面未动」时触发一次点击。
3. **重画的东西会不会累积**——快速路径里每帧 `destroy()` 旧的再画新的，漏一次 `destroy` 就是每次手势泄漏一个对象。断言 `container.children.length` 拖 N 帧不变。
4. **同类面板里最特殊的那一个**——世界频道是唯一在 `scrollRegion()` 之后才定 `scrollY` 的（stick-to-latest），缺 `markScrollBuilt()` 重新基准会整列表错位；只测好友列表测不到它。
5. **没享受到优化的路径必须保持原样**——家族浏览列表直接画进 `container`（无遮罩），所以 `overscan` 必须是 0，否则行会画到区域外。这条原本只存在于我的注释推理里。
6. **回落路径**——每条增量路径在目标对象被 `destroy()` 后必须回落整树重建且不抛。
7. **「没变就不重画」的判据要逐字段钉**——`refreshSignature` 少覆盖一个字段，就是那类改动永远不上屏。12 个会渲染的字段各一条用例，比一条「代表性」用例可靠得多；并且**每条都先断言「同样数据不重画」再断言「改了要重画」**，否则后半句可能是因为它总是重画才过的。

**⚠️ 两个 harness 坑**（都实测踩过）：①`createLayout(800, 1280)` **不等于**设计空间是 800×1280 —— `ScalingManager` 会映射到更大的空间（这组输入下 `regionTop≈431`、`cW≈1026`），硬编码的 `regionTop + 80` 会落在第一行**上方** 6px 处，测试表现为「点了但没命中」。一律从 `core.hits`/`core.regionTop` 等活布局里读坐标。②headless `measureText` 是 `字符数 * 7`，跟字号无关 —— 想测「文字溢出后右对齐」得给足字符数（80 个字符只有 560px，不够；用字段自己的 `maxLength` 200 才稳），别按真实字号估。

**另**：`git checkout -- <file>` 会把**未提交的修复**跟 mutation 一起冲掉（本轮踩过：验完 mutant 用 `git checkout` 还原，结果把同文件里还没提交的 `appliedScrollDelta` 修复也还原了，`git diff --stat` 才看出来）。验 mutation 优先用 Edit 精确改回那一行，或者验之前先提交。

## `__nwE2E.app`：用真实显示树量几何，而不是肉眼看截图（2026-08-24）

`src/entries/web-e2e.ts` 的 `window.__nwE2E` 现在除了 `views`/`state` 还挂了 **`app`**（那个真实的 `PIXI.Application`），于是 Playwright 脚本可以 `walk(__nwE2E.app.stage)` 读每个节点的 `getBounds()`，把「标题有没有压到金币数上」变成一个数字而不是一次目测。`app` 是从 `PixiAppViews` 的 `private readonly app` 上读的（TS 的 private 在运行时不存在）——`wrapViews` 是唯一的注入点而它只拿到 views，为一个纯测试需求在 `startApp` 上开生产接缝更不划算；`web-e2e.ts` 本来就是永不发布的测试专用入口（同文件头注释，跟 `no-debug-hooks-in-src.test.ts` 扫的那种临时 hook 不是一回事）。

**为什么非得用真实浏览器**：本套件的 headless `measureText` 是恒定 `7px/字符`且**与字号无关**（见本文档上面那条 2026-08-09 的记录）。页头重叠这个 bug 正好是字号驱动的——mock 下货币簇量出来 171px，还小于旧的 216px 预留，**bug 在 headless 里根本不存在**。所以那次的分工是：机制在单元层测（`test/ui/sceneHeaderCurrencyFit.ui.ts`，用长标题 + 放大 scale 按比例还原条件后做红绿对照）、接线用静态扫描守（`test/headerCurrencyReserve.test.ts`，正是它抓出 grep 漏掉的三个场景）、**像素结论只由浏览器给**。写这类测试前先问一句「这个 bug 在 mock 下复现得出来吗」，能省掉一整轮自欺欺人的绿。

**用起来**：`npx webpack serve --mode development --port <port> --env TARGET=web-e2e`，Playwright `waitForFunction(() => window.__nwE2E?.app)`，`page.evaluate` 里遍历 `app.stage`。别在 `newPage()` 之后再 `setViewportSize()`——场景只在构造时读一次 `ILayout`，事后改视口只会把旧布局拉变形（第一次试的时候就是这样拍出一张假的「竖屏坏了」）。

---

## 补测的三个盲区，都是「测了旁边、没测中间」（2026-08-25，ADR-073 后续）

ADR-073 首轮跟着修复落了 26 例测试，然后做变异验红，发现其中相当一部分**在修复被撤销后依然全绿**。三个盲区各有一类普适性：

### 1. 参数化的测试测不到「谁来传参」这条接线

`bakePageResolution.test.ts` 20 例把 `pageBakeResolution()` 的算术钉得很死——但它自己调 `setDesignScale()` 设缩放。而生产里唯一调它的地方是 `ScalingManager.applyScaling` 里的一行。**把那一行删掉，20 例全绿，111 MB 的纹理原样回来**。

补的是 `test/ui/bakeDesignScaleWiring.ui.ts`：构造**真的** `ScalingManager`（UI 套件有 headless PIXI，能跑真 `Graphics`/`Container`），**全程不碰 `setDesignScale`**，直接断言 `pageBakeResolution()` 已经是那个 layout 的 contain 缩放。变异 M1 验证：这个文件红、`bakePageResolution.test.ts` **保持绿**——盲区的存在本身被记录下来了。

> 与 ADR-072 那条「首轮测试全在场景层和视图层，漏了中间那层导航接线，而原 bug 恰恰只长在那里」是同一条。**规律**：凡是测试自己能"注入"的东西，就是生产代码里某处在注入的东西，那个注入点需要单独一例。

### 2. opt-in 的 flag 需要调用点守卫，否则两个方向都会静默腐烂

`pageScale` 是刻意 opt-in 的（整页要 device-exact，小 chrome 不能）。这种 flag 的腐烂是双向的：新加的整页 bake 忘带 → 又一张百 MB 纹理；从现有 7 处删掉一处 → 一个屏一个屏地退回去。两种都没有任何一处会红。

`test/pageBakeCallSites.test.ts` 扫源码枚举所有 `bake(`/`bakeLazy(` 调用点，跟一份显式期望表比对。**新调用点会让测试红**，直到作者把它归类——这就是目的。两个实现细节值得记：

- **必须先剥注释**。这几个文件本身就在注释里*描述*这个约定（"Statically baked (`bake()`, zero runtime cost)"），正则区分不了。实测撞到：`decorCLayer.ts` 报了 2 个调用点，实际 1 个。
- **要有一例守住"扫描本身没扫空"**。正则一旦失配，底下所有断言都会空转通过。

### 3. 冷却/去抖会让"应该保持安静"的测试**因为错误的原因**通过

`MemoryMonitor` 的字节闸是「超预算 **且** 仍在涨」。直觉写法：触发一次 → 同样字节再 tick → 断言安静。**这个写法在 latch 被删掉后照样绿**，因为 `REWARN_EVERY_MS`（30s）把第二次报告挡掉了。变异 M8 抓到的正是这个。

修法不是去伪造 `performance.now()`，而是**换一个不依赖时间的隔离手法**：第一次 tick 把预算调到没人能越过（于是记下 `lastSampledTexMB` 却从不上报、rewarn 闸也没被碰过），第二次 tick 才把预算调低——此时决定结果的**只有** latch。

> **规律**：任何带冷却/去抖/节流的逻辑，"断言它保持安静"的测试都要先确认安静**是被测的那个条件**造成的，而不是被冷却造成的。判定方法只有变异验红。

### 顺带：把两个已测文件搬进覆盖率门禁（ADR-071 那份过渡清单的用法）

`src/render/bake.ts` 和 `src/cache/MemoryMonitor.ts` 此前都不在 `coverage.include` 里——测了但不受门禁，能腐烂到 50% 也没人红。补完后两个都是 **100% 行覆盖**，一并加进清单：client 整体 94.77% → **95.12%**，而 scope 变宽了两个文件（"scope 翻倍而百分比上升"那个方向）。

门禁是**按文件**的，所以把新的字节代码纳入门禁，就得连它的邻居一起覆盖——于是顺手补上了 ANR context provider、`wx.onMemoryWarning`、`uninstall()`、JS 堆触发分支、`countNodes` 走真 stage。其中 **ANR 报告带 `texMB`/`largestMB` 是 ADR-073 里写下的声明，却一例没测**（那个 provider 只在 install 时注册、只由 ANR 看门狗调用）。

**14 个变异逐一验红**（M1–M14，覆盖三项修复 + 新增的报告路径），全部红在该红的那一例上。harness 上的两个坑：vitest 的 reporter 输出**带 ANSI 转义**，`/FAIL\s+(\S+\.test\.ts)/` 这类正则匹配不到（表现为"所有变异都没被抓到"，看起来像测试全废）；多行锚点要兼容 **CRLF**，否则在 Windows 检出上静默 skip。
