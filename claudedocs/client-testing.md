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

第二群是这次扩进来的：**已经测好、却不受任何门禁约束**的模块（`net/judgeRunner.ts`、`layout/{Portrait,Landscape}Layout.ts`、`scenes/CardScene/logic/feedPlan.ts`（当时还在 `CardScene/feedPlan.ts`，2026-08-27 随 4b 搬进 `logic/`）、`render/vfx/parseEffectDef.ts`、`ui/busyTracker.ts` …）——它们掉到 50% 也不会有任何一个 CI 步骤变红。扩完 **scope 1924 → 4245 行，行覆盖 91.2% → 94.7%（73 文件）**。scope 翻倍而百分比**上升**，跟「缩 include 抬百分比」正好相反（后者由报表的 `Scope (files)` 列盯着）。

- **≥10 可执行行才列**：barrel 和 1 行 re-export 壳（`net/anomaly.ts`、`app/nav/shop.ts`、`render/atlas/emblemAtlas.ts`、`platform/stubs/**`…）100% 覆盖但守不住任何东西，只会让清单变长。
- **两个大 facade 明确不进**：`net/ApiClient.ts`/`WorldApiClient.ts`（~50%）是一行一个转发，覆盖率说明不了任何事（同一理由让它们在 500 行 baseline 里也是例外条目）。
- **这份逐文件清单是过渡的**，ADR-070 那条「逐文件 include 是缺模块边界的味道」仍然成立：它针对的是逐文件项**收窄** scope（把没测的兄弟藏在好看的数字后面），这里每一项只**增加**受门禁的地盘。清单同时就是 ADR-070 客户端半边（4b）的待办——每抽出一个场景的纯逻辑目录，那个目录替掉它名下的若干逐文件项。
- **`test/coverageScope.test.ts` 钉住它别烂掉**（54 例）：每一项必须还匹配得到真文件（**改名/删文件会让一项静默失配、scope 无声缩小，而百分比通常还会升**，因为掉出去的都是覆盖好的模块——这正是 `checkFileLength`/`checkCoverageThreshold` 两条 canary 防的那种「靠变绿退休」）、清单不许空（canary）、不许有已被目录项覆盖的冗余项。红绿两向都实测过。
- **已graduate的「纯逻辑目录」用目录 glob，另有专门守卫**（ADR-071 4b——**六个优先组已于 2026-08-27 全部处理完，不再是待办**；2026-09-02 订正掉“进行中”——这三个字让另一个会话把它当成头号待办报给了用户，而它当时按“include 里还有逐文件项”这个**错的代理指标**去核，而 4b 的验收条件从来是“有纯逻辑层的地方抽成目录、没有的量过并记下结论”）。每抽完一组场景，`src/scenes/<组>/logic/**` 一条目录项替掉该组的若干逐文件项——目录项的好处正是**它也管住之后落进来的文件**，而逐文件清单会静默漏掉。已完成：`worldmap/logic`（95.83%）、`CardScene/logic`（100%）。**`Friends`/`Family`/`Sect` 与 `ui/dialogs` 量过之后明确不建目录**——`ui/dialogs` 7 个文件全是绘制代码、零个 PIXI-free 模块；三个社交场景里真纯的只有两个纯类型 `types.ts`，其余不带 PIXI 的（`pointer.ts`/`input.ts`/`data.ts`/`network.ts`）全是 Core 协作者。**教训：「行数 × 出 bug 频次」排不出「有没有纯逻辑可抽」**，排计划要另量一列「PIXI-free 模块数」。那两组改为逐文件受门禁（`FamilyScene/pointer.ts`、`SectScene/pointer.ts`，各 100%，见 `test/socialPointerRouting.test.ts` 46 例 fake-core）。
  - **`test/pureLayerBoundary.test.ts` 才是守边界的那个，百分比不是**。门禁余量 = `covered/0.9 - total`，97% 的目录还能塞进几十行未覆盖代码不越线，而且**测试越好余量越大**；所以往受门禁的纯目录里丢一个 PIXI 文件，门禁照样绿。加一组只需在 `PURE_DIRS` 加一行。守卫查**两件事**：
    1. **runtime import 图**（`import type` 豁免——编译后不存在；非相对 specifier 走白名单），判红时打完整链路。
    2. **文件自己有没有直接摸全局**（2026-08-27 补上）。缺了这一半就是个能开车过去的洞：一个模块**不需要任何 import** 就能调 `document.createElement`。发现它的是 `SectScene/input.ts`——建隐藏 DOM `<input>` 浮层，却只 import `@nw/shared` 加一个类型，import 图判它「纯」。现在 `document`/`window`/`localStorage`/`wx` 等 16 个会判红；`setTimeout`/`performance`/`console` 刻意不列（node 里也有，不影响加载与测试）。匹配前先剥注释与字符串，并排除前导 `.` 和后随 `:`（属性位而非全局读）。
  - **哪些文件不该进 `logic/`**：判据是「**它读写 `core.*` 吗**」，不是「它的算术可测吗」。`worldmap/WorldMapRenderer/viewport.ts`（改 `core.ctx`、调 pool/panels/net）保留逐文件项；`CardScene/{input,header}.ts` 同理不进也不单列。放错会让守卫变成一句假话。
  - **第三种 0%，比上面两种都难发现：文件根本不在 `coverage.include` 里，于是没有任何百分比提到过它**（2026-09-02）。上面两种至少会在报表里印出一行 `0%`；这一种连行都没有。**找它的办法不是读报表，是拿模块名去 `client/test/` 里 grep**——一个模块的关键标识符（全局名、导出函数名）在整个测试目录里 **命中零次**，就是它。本轮这么扫出三个（`platform/iap.ts`、`platform/nativeAds.ts`、`inputSystem/WechatAdapter.ts`）：`NWBilling` / `NWAds` / `requestPlatformHeader` 在 `client/test/` 里一次都没出现过，`WechatAdapter` 也从未被任何套件实例化。现已各配用例并入门禁（`test/nativeBridges.test.ts` 16 例、`test/wechatInputAdapter.test.ts` 10 例，三个文件行/分支均 **100%**，客户端 scope 6150 行 / **96.13%**）。
    - **两个判据，不是“多少行”**：① **失败是不是隐形的**——`getNativeBilling()` 的 shape 检查不过时，返回值跟“根本没桥”**一模一样**：一个注入了畸形 `window.NWBilling` 的原生壳不报错，它静静变成一个 **Paddle 构建**（WKWebView 里开网页收银台，苹果直接拒），并且向服务端自称 `web`，也就是从**错的充值池**里扣钱（ADR-020 / `spendChannel.ts`）。② **它是不是第一个环节**——`WechatAdapter` 不是叶子：微信小游戏没有 DOM、PIXI 的 EventSystem 不工作，**那个构建里每一次点击都走这一个文件**；它一声不响（或者把屏幕坐标当设计坐标发出去），整个微信版不能玩，而其余套件全绿——因为 `InputManager` 下游的一切在测试里都是直接 `_emitDown/_emitMove/_emitUp` 驱动的。
    - **`WebAdapter` 同样从未被实例化，但本轮没收**：它要 DOM（`canvas`/`window` 上 `addEventListener`），而这个覆盖率套件是 `environment: 'node'`；它属于 `test/ui`。两者风险不对等的原因也写在用例头里：**WebAdapter 坏了，任何人打开 localhost:9090 当场就看到；微信版在两轮真机测试之间没人手动跑。**
    - **顺手钱下来一条不对称（不是 bug，但是下一个 bug 的形状）**：`WebAdapter` 有 `destroy()` 摘监听，`WechatAdapter` **没有**，也从不调 `wx.offTouch*`。今天无害（`setupInput` 开机只调一次、实例直接丢掉），但它意味着日后任何“画布重建时重接输入”会**每一次触摸双发**而不是报错。已用一条用例把现状钉住（“第二个 adapter 会把四个通道全部变成 2”），`destroy()` 真落地时改那条。
    - **四个变异验红（逐个实测）**：M1 拆掉 `typeof b.purchase === 'function'` → 3 例红；M2 `onTouchCancel` 不发 up → 1 例红；M3 `touchstart` 发原始屏幕坐标 → 4 例红（所以用例里的 `toDesign` 是「坐标除二」而不是恒等，恒等会让这个变异漏过去）；M4 `requestPlatformHeader` 忽略桥 → 2 例红。
  - **⚠️ 看到 0% 先分清两种成因**（两组都遇到过，修法完全不同）：①**测试其实在 `test/ui/`**——那个套件不报覆盖率，把纯用例搬进 `test/` 即可（`worldMapOccupyFrontier.ui.ts` 一个断言没改就解决了）；②**覆盖率套件从未加载过它**——`CardScene/logic/types.ts` 的唯一 importer `core.ts` 引 PIXI，所以谁都没 import 到它，得补真的测试。别一律当成「搬套件」。
- **平台后端那一层（2026-09-02）：`platform/**` 里不是「壳」的文件也要进门禁。** 这是上面「已经测好却不受门禁约束」的**反面**——两个 SFX 后端 `platform/web/WebAudioBus.ts` 与 `platform/wechat/WechatAudioBus.ts` 是**既没测、也不受门禁**，两套件并集下**都是 0%**，而 `vitest.config.ts` 里当时已经写着这个教训（它为此单独圈了两个 music deck）。当初放它们出去的理由是「各自 ~15 行、只回答两个问题」，而 BGM 落地后那两个问题变成了**四个**（上下文 / 手势 / deck / 前后台），其中三个带静默失败分支。补 `test/audio/WebAudioBus.test.ts`（17 例）+ `WechatAudioBus.test.ts`（19 例）后两者 100%，一并进 include。**这轮真找出一个 bug**：`WebAudioBus` 里那句"把当前 `document.hidden` 也报一次"是**空转**的——它在 `ContextAudioBus` 构造函数里执行，那时 `music` 还是 `null`（懒造），值被静默丢掉；`ContextAudioBus.hidden` 字段是承接它的那一半。
  - **判据别用「它是不是平台层」，用「它有没有会静默失败的分支」。** `WebPlatform.ts`/`CrazyGamesPlatform.ts` 那种一行一个转发继续留在门禁外（同上面两个大 facade 的理由）；`canvasTexture.ts`（16 行）进来了，因为它做的事——指名 `CanvasResource` 而不是让 PIXI 嗅探——是「有画面」和「黑屏」的差别。
- **扫描器守卫又添一条：`test/canvasTexture.test.ts`**（14 例，2026-09-02）。形状照抄 `wechatHostSurface.test.ts`：扫 `src/**` 的 `Texture.from(` / `BaseTexture.from(`，要求参数不许长得像 canvas，**外加**扫描器自测 6 例（注释/字符串/行号/误报）。守的是 `wechatHost.ts` 之外的第二道保险——今天三处 canvas→纹理全走 `canvasTexture`，此前没有任何机制维持这个状态，而下一处长出来的症状是**真机黑屏**。做过变异验证（在 `fastText.ts` 塞一处 `PIXI.Texture.from(cvs)`，两条断言都红）。
- **不追整包 90%**：按上表缺口要再覆盖约 3 万行，且相当大比例是 PIXI 绘制代码，测出来的是 mock 的行为。系统性渲染/场景测试仍然是 `test:ui`/`test:e2e` 的活（两者都不产覆盖率）。

## ⚠️ `test:ui` 的共享桩纹理陷阱（2026-08-27 定位并修掉一条 flaky）

`vitest.ui.config.ts` 的 `stubBinaryAssets` 把**每一个** `*.png` import 都解析成同一个 1×1 data URI，而 `render/cardArt.ts` 的 `getArtTexture(url)` 按 url 缓存——所以在这一层里，**所有角色立绘、所有头像胸像、所有皮肤胸像是同一个 `PIXI.Texture` 对象**。而「美术加载完了」这件事，测试是靠**原地改这个共享 BaseTexture** 来模拟的（`valid = true` / `setRealSize(...)` / `emit('loaded')`），改完没人还原。

于是任何前提是「这张图还没加载」的用例（画了 spinner、还在用预加载尺寸猜测）**只是因为它被声明在翻标志位那条之前才通过**。vitest 的按文件隔离救不了——泄漏发生在**同一个文件内，`it()` 到 `it()` 之间**。

- **症状**：`npm run test:ui` 偶发一条红，重跑就绿。默认顺序连跑 6 次全绿，`--sequence.shuffle` **6 次里 5 次红**。
- **真正的两个文件**：`test/ui/avatarPortraitFit.ui.ts`（单文件 shuffle 8 次红 5 次）与 `test/ui/cardArtLoadingSpinner.ui.ts`（一次最多 4 条红）。**跟 `FamilyScene — emblem badge visual presence` 无关**——当时的归因是错的，那条用例根本不碰这张纹理。
- **比 `valid` 更隐蔽的第二条通道，也是真凶：`PIXI.Texture.frame` 和维护它的监听器**。Texture 构造器里 `baseTexture.once('loaded', this.onBaseTextureUpdated, this)` 是**一次性**的，`this.noFrame && baseTexture.on('update', ...)` 是**常驻**的。第一个 `emit('loaded')` 的测试把那个一次性监听器永久消耗掉，之后每个同样靠 `emit('loaded')` 假装加载完的测试就**不会再同步 frame**，于是读 `tex.width` 的业务代码（`avatar.ts` 的 fit 正是如此）拿到的是**上一条用例的尺寸**。实测：baseTexture 说 683，frame 还是 768，scale 算出 0.2258 而不是 0.2333。
- **修法两半，缺一不可**：
  1. 模拟加载必须**先置 `valid = true` 再调 `setRealSize()`**（`setRealSize` 只在 valid 时才跑 `BaseTexture.update()`，而那个 update 才会触发常驻的 `'update'` 监听器去同步 frame）；只有 `emit('loaded')` 是不够的。
  2. `beforeEach(resetSharedStubTexture)`（`test/harness/sharedStubTexture.ts`）把共享纹理还原成冷态（frame 1×1、`valid=false`）。
- **验证**：修前 shuffle 6 次 5 红；修后**全量 shuffle 连跑 6 次 235/235 全绿**，两个文件单独 shuffle 各 10 次全绿。
- **第三个同类文件是新建的守卫自己扫出来的**：`test/ui/shopScene.ui.ts` 也翻共享纹理的 `valid`（作者当时已经意识到一半，注释里写了「全局纹理缓存在本文件内共享」，但只重置了 `valid`、没重置尺寸/frame）。它用的是 `PIXI.Texture.from(url)`而不是 `getArtTexture`——**同一个对象**，`cardArt.ts` 自己就写着「shared with the `PIXI.Texture.from` global cache」。已一并加上 `beforeEach`，shuffle 8 次全绢。
- **新增 `test/sharedStubTextureCallSites.test.ts`（静态守卫，4 例）**，钉住两条规则：①凡翻 `baseTexture.valid = true` 的 `test/ui/**` 文件必须有 `beforeEach` + `resetSharedStubTexture`；②`valid = true` 必须在 `setRealSize()` **之前**。第②条尤其需要机器盯——**写错顺序单跑也是绿的**，只有等同一轮里另一个测试先 emit 过 'loaded' 之后才会红。两条规则都做了变异验证（删 `beforeEach` / 把两行调回去，各判红一次），并带 canary（UI 文件数 >100 且至少有一个 load-faker，否则守卫自己在空跑）。
- **以后写这一层的测试**：只要用例依赖「加载完 / 没加载完」，就 `beforeEach(resetSharedStubTexture)`，别假设「桩 Image 永不 fire loaded，所以整个文件里它一直 invalid」——那句话对单条用例成立，对文件不成立。
- **⚠️ 别把另一种红当成这条**：`test/ui/cityBldIcon.ui.ts` 与 `composition-hooks.ui.ts` 在**机器负载高时**会报 `Test timed out in 5000ms`。那是**负载假阳性**，不是顺序依赖——机器空闲时这两个文件单跑 13/13 绿、最慢用例仅 ~740ms（离 5000ms 很远），而复现时本机同时在跑 Chrome + 多个套件。症状也不同：超时 vs 断言值错。判别法：单文件安静复跑一次，绿就是负载。

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
  - `smoke.spec.ts`：上面那两条 happy-path，**需要全套后端**。
  - `shareReplay.spec.ts`（2026-08-26 加）：分享录像落地页（`?r=<code>`）。**不需要后端** —— 只把 `GET {api}/r/<code>` 用 `page.route` 拦下来喂一份手写状态流（`unpackReplayBlob` 接受未压缩的普通对象，fixture 可以直接内联 JSON），其余照真渲染器跑。所以它是这层里唯一能本地随手跑、也是唯一能验「皮肤/动作/HUD 真的画出来了」的：皮肤靠**差分**断言（webpack 用内容哈希命名资源，URL 里看不出是哪份 rig，但「带皮肤的流比同一条不带皮肤的流多请求 2 个 `.tao`」看得出，且不写死默认 rig 的数量），动作靠**同一 canvas 相隔 0.4s 两帧像素不同**，HUD 靠遍历真 `app.stage` 找可见的纯数字文本（= 两侧墨水读数）。通过时也把那一帧作为 Playwright attachment 附在报告里，供人眼看一遍。
  - `audioDucking.spec.ts`（2026-09-01 加，AUDIO_DESIGN §4）：`sfx.result.victory` → `DUCK_CUES` → 真 `ContextAudioBus.play()` → 真 `MusicPlayer` → 真 `GainNode` 的接线。**也不需要后端**——只到 intro 屏（默认拿 `bgm.lobby`），从不登录/进战斗，靠 `window.__nwAudio`（`entries/web-e2e.ts`）读 `music().duck`/`decks[].gain`。真墙钟等待攻击/保持/释放三段，本地连跑四次无 flaky。`MusicPlayer.test.ts` 原有的包络单测直接调 `player.requestDuck()`，从不经过 `ContextAudioBus.play()`，所以看不见"cue 掉出 `DUCK_CUES`"或"`play()` 里那行 `requestDuck()` 被删"这类接线断裂——这条补的就是那一段。**不做全局 `declare global`**（见上一条的教训）：局部 `interface` + 每个 `page.evaluate`/`waitForFunction` 闭包内就地 `as unknown as {...}`。
    > **2026-09-02 修 flaky**：本机 3 跑 2 挂。原写法是三个 `waitForTimeout` 断言「某时刻 duck 必须是某值」，注释还写着「wide margin either side for CI scheduling jitter」——那句话是这里唯一不成立的。两个成因：①**包络不走墙钟**，`advanceDuck` 吃的是渲染 ticker 累积的 `dtMs`，掉帧就与 `waitForTimeout` 分岔；②**余量只有 100ms 不是"wide"**——`DUCK_HOLD_MS` 是 500 而第二次读瞄准 400，中间还要花掉两次 `page.evaluate` 的 CDP 往返。实测第二次读落在 ticker 时间约 583ms，hold 早过期、release 已开始，duck 读到 0.515（= 0.45 + 0.55×83/700）撞上 `< 0.5`。**这个形状放宽边界修不好**：边界钉死在 500ms，而它前面的开销没有上界。
    >
    > 改成**等状态、不等时钟**：`waitForFunction({polling:'raf'})` 轮到「压到底」和「回到 1」，并直接把命中那一帧的 handle `.jsonValue()` 取回来当快照——于是断言的是**同一帧内的不变量** `deckGain == steadyGain × duck`，而不是「某时刻某个定值」。落在斜坡中间因此无害（不变量在斜坡每一点都成立），而「duck 没接到图上」在每一点都破坏它。两个它真正要防的回归现在以**超时**报出（"timed out waiting for the bed to duck" / "…for the duck to release"），比差一帧的数值边界好读。
    >
    > **移走的时序覆盖没有丢**：80ms 起振 / 400ms 仍压住 / 完整回到 1 由 `test/audio/MusicPlayer.test.ts` 确定性地钉着（用精确 dt 驱动 `update()`）。已验证：把 `DUCK_HOLD_MS` 500→100、或让 hold 永不过期，那边分别红 3 条和 1 条。浏览器这条独有的价值是**接线**（cue 名 → `DUCK_CUES` → `ContextAudioBus.play()` → 真 `GainNode`），三个变异全抓（cue 掉出 `DUCK_CUES`、duck 永不释放、duck 算了但没进 `applyGains`）。改完 6/6 绿，用例本身 6.0s → **4.5s**（不再干等 1700ms）。
  - ⚠️ **两个 spec 不能各自 `declare global` 同一个 `window.__nwE2E`**：`tsconfig.test.json` 把 `src` + `test` 拉进**同一个 program**，两份对同一属性的 augmentation 会互相污染 —— `shareReplay.spec.ts` 一开始声明成 `state: Record<string, unknown>`，结果 `smoke.spec.ts` 里 `state.lobbyCb.onOpenRoom()` 这类调用全变成 `Object is of type 'unknown'`（10 条报错**落在别人的文件里**，很容易误判成那个文件的问题）。新 spec 一律用**局部 type + 就地 cast**，不动全局 `Window`；注意传给 `page.evaluate` 的闭包会被序列化，**只能引用类型（会被擦除），不能引用模块作用域的值**（helper 函数不行）。
  - ⚠️ 客户端 `target`/`lib` 是 ES2020：`Array.prototype.at()` 在 `npm test` 下跑得好好的（esbuild 擦类型），只有 `npm run typecheck` 会红（TS2550）。写测试断言"最后一次调用"要用 `calls[calls.length - 1]`。
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
---

> **本页以下为按日期追加的补测/审计/教训记录（2026-08-03 起）**，已拆到 [`client-testing-log.md`](client-testing-log.md)（ADR-067 单册形态：不建索引表，原位留一条箭头）。标题与正文一字未改，新条目继续往那份文件追加，别再堆回本页。
