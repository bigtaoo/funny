# 客户端测试架构（client/test）

> 快查：客户端有几层测试、各测到哪一层、headless PIXI 怎么跑、上线前补浏览器冒烟（缺口 B）的方案。

## 四层测试

| 套件 | 命令 | include | 环境 | 测什么 | 真 PIXI？ |
|---|---|---|---|---|---|
| 单元 | `npm test` | `test/**/*.test.ts` | node | 纯游戏逻辑（无 PIXI 依赖） | 否 |
| UI 冒烟 | `npm run test:ui` | `test/ui/**/*.ui.ts` | node + `pixiHeadless` | **真实场景构造 / update / destroy + 命中矩形回归** | 真对象树，**无渲染器** |
| 渲染泄漏 | `npm run test:render` | `test/render/**/*.test.ts` | node（每文件 `vi.mock` PIXI） | BaseTexture 监听器 / blob URL 泄漏回归 | mock |
| 全链路 E2E | `npm run test:e2e`（opt-in） | `test/e2e/**/*.e2e.ts` | node | `createAppCore` 全链路对接活服务器（meta+gateway+matchsvc+game+commercial+mongo） | headless orchestration |
| 手动调参脚本 | `npm run test:manual`（opt-in，非回归） | `test/**/*.manual.ts` | node | console.log 输出的难度曲线/A-B 对比表，**零 `expect()`**，人工读表用 | 否 |

`npm test` 只跑 `*.test.ts`；`*.ui.ts` / `*.e2e.ts` / `*.manual.ts` 用各自命名后缀隔离，默认套件不会误收。

**手动调参脚本层（2026-08-05 新增分层）**：`test/diag.manual.ts`（单关卡逐秒时间线 + 出牌统计）和 `test/experiment.manual.ts`（ch1_lv1 难度削减方案 A/B 对比）本质是拿 vitest 当脚本 runner 用来打印表格，从来没有 `expect()` 断言——之前挂着 `.test.ts` 后缀混进 `npm test`，会让"141 passed"的通过数里悄悄含着两条什么都没验证的"测试"。改用独立后缀 + `vitest.manual.config.ts`（同 `vitest.config.ts` 的 `@nw/engine` alias）+ `npm run test:manual`，与 `test:ui`/`test:e2e` 同一模式：需要调参时显式跑，不再计入默认套件的通过率。

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
