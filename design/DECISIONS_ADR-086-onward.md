# 决策日志（ADR）— ADR-086 起（2026-09-08 起）

> 从 `DECISIONS_ADR-070-onward.md` 拆出（2026-09-12，原册 625 行，超 ADR-067 的 500 行上限；原册同时更名为 `DECISIONS_ADR-070-085.md`）。上一册见 [`DECISIONS_ADR-070-085.md`](DECISIONS_ADR-070-085.md)，更早的见 [`DECISIONS_ADR-041-069.md`](DECISIONS_ADR-041-069.md) 与 [`DECISIONS_ADR-001-040.md`](DECISIONS_ADR-001-040.md)。**ADR 编号与标题一律未变**，原有 `DECISIONS_ADR-070-onward.md#adr-0NN-...` 深链按编号改指 ADR-070~085 那册或本册即可。
> **新拍板写这里。** 全部 ADR 的索引表在 [`DECISIONS.md`](DECISIONS.md)——新增条目要同时往那张表里加一行。
> 本册再超 500 行时按同样方式开下一册（`DECISIONS_ADR-0NN-onward.md`），并更新 `DECISIONS.md` 的「分册」表与本册页首指引。

---

## ADR-086 空闲功耗第二轮：tick 率降到 20 Hz、装饰动画静默、共用 ticker 也上限、`powerPreference: 'low-power'`、rateGate 定时器改惰性 — Accepted — 2026-09-09

ADR-083/085 把**重绘**降到了空闲 5–12 次/秒，但**帧本身**没降：`SceneManager.onTick`（transition + BGM 派生 + 每个挂载场景的 `update`）和 `stageSignature` 照旧一秒跑 60 遍。2026-09-09 复查（用户「再次检查」）挖出五件事，一起落地。

### 决策一：空闲把 tick 率降到 `IDLE_FPS = 20`

`reactive` 场景连续 `IDLE_QUIET_MS`（2 s）没有「真正的重绘」→ `ticker.maxFPS = 20`；`'live'` / `'hold'` / `'changed'` 任一出现立刻回 `TARGET_FPS`。

- **`'floor'` 故意不算活动。** 500 ms 地板一秒触发两次，如果它算活动，2 秒的静默窗口永远走不完，这条节流一次都不会生效。**这是本条最容易被「顺手清理」掉的一行**，所以门禁里有一例专门喂 6 个地板帧、断言仍然降到 20（并且断言那 6 帧真的画了，否则用例是空的）。
- **指针事件同步回满帧**，不等下一个 tick：降到 20 Hz 后下一 tick 最远 50 ms，第一帧点击反馈不能付这个钱。`holdRenderActive()` / `invalidateRender()` 通过模块级 `onActivity` 回调直接把 `maxFPS` 拨回 60。
- **代价**：没人申报的变化（落在静默屏幕上的网络推送）最坏晚 50 ms 上屏，而不是最坏晚 17 ms。看不出来。

### 决策二：`PIXI.Ticker.shared` 也上限——这个客户端一直有**两个** rAF 循环

`PIXI.Application` 的 `sharedTicker` 默认 **false**，所以 `app.ticker` 是一个新 Ticker；而 `render/boil.ts` 的沸腾线、战斗/卡牌视图的 14 处 fx 回调全挂在 `PIXI.Ticker.shared` 上，**那个 ticker `autoStart = true`，只要有一个监听者就自己起一条 rAF 循环，而 ADR-083 的 `maxFPS = 60` 从来没碰过它**。大厅只要有一条沸腾线，第二条循环就在以屏幕刷新率（ProMotion 上 120 Hz）跑。

`RenderPolicy.setMaxFps` 现在同时写两个 ticker，`uninstall` 把 `Ticker.shared` 还原成安装前的值（它是进程级全局）。

**为什么不把 14 处调用点收敛到一个 seam**：功耗问题是**速率**，而那 14 处每一处都已经在积分 `deltaMS`——降速率只改采样粗细，不改动画时长。收敛 ticker 要动的是 14 条 destroy 路径，而那正是这个仓库出过泄漏的地方，风险与收益不成比例。

### 决策三：装饰动画在长时间无输入后静默（`DECOR_QUIET_AFTER_MS = 30 s`）

这是决策一自己到不了的另一半：大厅沸腾线（8 fps）、火柴人剪影（12 fps）、世界地图护盾气泡（10 fps）各自按自己的节奏改变签名，**既是空闲重绘 5–12/s 的全部来源，也是让 tick 静默窗口永远走不完的原因**。它们保持当前帧之后，未被触碰的屏幕只在 500 ms 地板上重绘（2 次/秒），决策一的节流也才咬得住。

- 机制是 `render/idleQuiet.ts`，**零 import**，理由和 `render/renderStats.ts` 一模一样（读者散、且 `renderPolicy.ts` 是 PIXI 的**值**引入，会把整个 canvas renderer 拖进 plain-node 单测）。只有 `RenderPolicy` 写它，缺省 `false`——animator / 地图编辑器 / 所有测试因此一字不变。
- **可以读它的**：纯观感（沸腾线、菜单火柴人、护盾气泡）。**不可以读它的**：任何玩家会去读数的东西（HUD 倒计时）、任何进度指示（冻住的转圈=像卡死了）、以及游戏自己举起的注意力提示（新手引导圆环）。判据是「冻住时截一张图，是看着不对，还是看着像一张画」。护盾**破盾闪光**也不受管——那是一次性反应，不是氛围。
- 火柴人静默时 **clip 时间照常前进**（和既有 `poseFps` 限速同一个约定），所以恢复时是**跳到本该在的姿势**，不是慢动作接上。
- 30 s 而不是几秒：正在看菜单的玩家应该看到活的画面，这条针对的是 app 被丢在兜里/副屏上好几分钟。

### 决策四：`powerPreference: 'low-power'`

`new PIXI.Application` 一直没传这个选项，@pixi/core 的默认值是 `'default'`（`ContextSystem` 读 `settings.RENDER_OPTIONS`），即把选择权交给浏览器——双 GPU 的 Intel Mac 上这就是一个 2D 铅笔画游戏点起独显、吹起风扇的经典路径。这个客户端最重的一帧约 18k 索引 / 0.5 ms GPU，集显远不到极限，没有东西可换。**单 GPU 硬件（Apple Silicon / 手机 / 多数 PC）上这个提示完全无效，所以它是针对某一类机器的便宜对冲，不是已确诊的病因。**

常量放 `render/renderPolicy.ts`（`POWER_PREFERENCE`），门禁在 `test/ui/renderLoopWiring.ui.ts`：**缺省不是中性的，「没传」才是 bug**，所以断言是「这个选项存在」+「它的值来自那个常量」。

### 决策五：`net/rateGate.ts` 的补桶定时器改惰性

原来构造函数里一个 `setInterval(200ms)`，永不 `clear`，零流量也一秒醒 5 次。ADR-083 之前这笔账被 60 Hz 全量重绘完全盖住；现在空闲重绘只有 5–12/s，它的相对占比反而上来了。桶满且无人排队 → 停表，下一次取 token 再起。**相位因此从「上一个窗口内的任意时刻」变成「花掉 token 之后正好 REFILL_MS」——比原来更严格，不会更松，稳态速率不变。**

### 决策六（被迫的）：卡顿 watchdog 的阈值必须跟着上限走

`cache/PerfMonitor` 的「持续低 fps」阈值是固定 25，而决策一会把 ticker 压到 20——**不动它的话，每一个健康的空闲菜单都会每 10 秒报一条 `cpu` 异常**。和 2026-07-26 那次「后台标签页假 cpu」同一类假阳性，只是从另一个方向来：设备不慢，是我们叫它慢的。现在阈值取 `min(nw_fps_warn, maxFPS - 5)`（`FPS_WARN_HEADROOM`）。20 Hz 上限下 10 fps 仍然会报——搬的是阈值，不是把 watchdog 关掉。

顺带：`render_profile` 的 `maxFps` 字段**不再是常量**，它是上报时刻的上限。`maxFps: 20, fpsP50: 20` 是一个行为正确的空闲菜单，**先读 `maxFps` 再读 `fpsP50`**。

### 更正：ADR-085 那句「下一刀在场景 `update()`（1.4 ms）」是**错的**，作废

那个 1.4 ms 是两次量测相减来的，从没逐项归因过。这次归因了（headless、`vitest.ui` 真 PIXI、2,833 个舞台对象——和浏览器里 L2 的 3,859 同量级）：

| 空闲世界地图一个被跳过的帧 | 耗时 |
|---|---|
| 整个 `scene.update(1/60)` | **16.6 µs** |
| `stageSignature(stage)` | **287.5 µs** |
| `overlayInkSignature(ctx)` | 0.1 µs |

`stageSignature` 的 287.5 µs 与 2026-09-08 在真浏览器里量到的 0.21–0.30 ms **几乎重合**，这是这套归因能迁移过去的证据。结论：**被跳过的帧的成本压倒性地在签名遍历里，不在场景 `update()` 里（差 17 倍）**，「下一刀」瞄错了目标。而签名遍历正是决策一直接砍掉三分之二的东西（0.29 ms × 60 = 17 ms/s → 5.8 ms/s）。**所以 `update()` 里没有下一刀**；剩下的 5.8 ms/s 是全核 0.6%，不值得为它去动那个「画面会冻住」风险最高的检测器。

### 门禁（全部做过变异验证）

| 文件 | 新增钉住什么 |
|---|---|
| `test/ui/renderPolicy.ui.ts`（33 → 45 例） | 共用 ticker 也被上限、`uninstall` 还原它、静默 2 s 后降到 20、**地板帧不算活动**、真变化立刻回 60、**指针事件同步回 60（不等 tick）**、`'live'` 场景永不降；装饰静默的三个方向（30 s 前后、输入复活、`uninstall` 清标志）；沸腾线保持当前变体且能复活 |
| `test/render/idleDecorations.test.ts`（新，5 例） | 火柴人：使用中 ~12 姿势/秒、静默时 **0**、静默期间 clip 时间照走（2 秒后回到 loop 起点）、复活后回到 12、**没有 `poseFps` 的战斗单位一点不受影响（60/60）** |
| `test/ui/worldMapOverlayCoalescing.ui.ts`（21 → 22 例） | 护盾气泡静默后整张地图掉到 ≤2/60（走**真的** `DECOR_QUIET_AFTER_MS` 路径，手动 `setDecorationsQuiet` 会被 policy 每 tick 覆写掉） |
| `test/ui/renderLoopWiring.ui.ts`（15 → 16 例） | `app.ts` 真的传了 `powerPreference`，且值来自 `POWER_PREFERENCE` |
| `test/PerfMonitor.test.ts`（+3 例） | 20 fps 上限下的 20 fps 是沉默；同样上限下的 10 fps 仍然报；60 fps 上限下的 20 fps 仍然报 |
| `test/rate-gate.test.ts`（+3 例） | 桶满时**一个定时器都没有**（`vi.getTimerCount()`）、花掉第一个 token 时上表、桶满后下表、有人排队时继续走 |

七处变异逐一验证转红：删掉三个装饰读点、删掉 policy 发布标志那行、把地板改成算活动、删掉共用 ticker 那一行、删掉同步回满帧的回调、去掉 watchdog 的阈值夹取、rateGate 的两个方向（构造即上表 / 永不下表）。

### 影响

- 新增 `client/src/render/idleQuiet.ts`、`client/test/render/idleDecorations.test.ts`。
- 改 `render/renderPolicy.ts`（三个常量 + `POWER_PREFERENCE` + 活动 seam + `setMaxFps` + `applyIdleThrottles`）、`app.ts`（`powerPreference`）、`render/boil.ts`（抽出 `step(dtSec)` 便于驱动 + 读标志）、`render/stickman/StickmanRuntime.ts`、`scenes/worldmap/WorldMapRenderer/lifecycle.ts`、`cache/PerfMonitor.ts`、`net/rateGate.ts`。
- 文档：`claudedocs/client-render-budget.md` §2/§10 重写 + 新增 §11。
- **ADR-085 的「下一刀在场景 `update()`」自此作废**（见上面的更正）。

---

## ADR-087 `equipment.ts` 也走深别名：客户端那份手抄副本删掉，不再「三处同步」 — Accepted — 2026-09-09

- **决策**：新增 `@nw/shared/equipment` 深别名指向 `server/shared/src/equipment.ts` 源文件，`client/src/game/meta/equipmentDefs.ts` 由**手抄副本**改为**具名 re-export 门面**。同 ADR-041-069 里 `@nw/shared/cards` 那条的做法，理由也同一条：`@nw/shared` **包根 barrel** 会拉入 mongodb/jsonwebtoken 打不进浏览器，但 `equipment.ts` **这一个文件 import 数为零**（连 `import type` 都没有，`seededRng`/`hashSeed` 是文件内私有函数），单独指过去就是浏览器安全的。
  - 落地八处别名：`client/webpack.config.js`、`client/tsconfig.json`、`client/tsconfig.fulllink.json`、`client/vitest.{,e2e.,load.,sim.,ui.}config.ts`。**新增深别名必须一次改齐这八处**，少一处就是「跑测试绿、打包红」或反之。
- **门面只按名字挑，不用 `export *`**：re-export 的 12 个符号全是 UI 预览/按钮门控要用的（目录、上限常量、`enhanceSuccessRate`/`enhanceDemoteChance`/`enhanceCost`/`salvageRefund`/`isSalvageable`/`reforgeCoinCost`/`getEquipDef`/`REFORGE_*`/`PROTECT_ENHANCE_ITEM_ID`）；**掷骰与实例生成故意不 re-export**（`rollEnhanceSuccess`/`rollEnhanceDemote`/`rollCraftedAffixes`/`rollReforgedAffixes`/`makeDropInstance`/`makeGachaEquipInstance`）——服务器仍是唯一权威这条红线，靠「客户端根本拿不到这些函数」来守，比靠注释守可靠。留在客户端的只有两个没有服务端对应物的函数：`craftableDefs()`（锻造网格按稀有度分组的展示序）与 `affixKind()`（词条 id 前缀 → UI 分桶）。
- **先量后动（这是动手前定的前提）**：`npm run build:web` 主 bundle **2 237 372 → 2 237 389 字节（+17 B）**，gzip **633 377 → 633 368（−9 B）**。webpack 的 `usedExports` 把没被 re-export 的那半整段摇掉了，所以「把 437 行的服务端模块接进打包图」并不等于「包体涨 437 行」——**代价实测为零**。以后再遇到同形状的手抄副本，量一次的成本是一次生产构建（~60 s），不该再靠猜。
- **顺带删掉 `client/test/equipmentFormulaParity.test.ts`（同日早些时候刚加的 10 例漂移门禁）**：它守的是「两份副本逐值一致」，而现在只有一份，逐值比对成了自己跟自己比。**留着一条恒真的门禁比没有门禁更坏**——它会让下一个人以为还有两处要同步。镜像那侧原本 63.1% 覆盖率、九个函数里七个从没被调用，现在这批公式的覆盖归 `server/shared/test/equipment.test.ts` 管（那侧一直测得很全）。
- **影响**：`client/src/game/meta/equipmentDefs.ts`（149 → 73 行）、上述八份配置、删 `client/test/equipmentFormulaParity.test.ts`、`client/test/equipmentDefs.test.ts` 抬头注释。文档：`design/game/EQUIPMENT_DESIGN_IMPL.md` E5 决策 1（原「不 import `@nw/shared`」那条标注作废）、`claudedocs/client-testing.md`。验证：`tsc --noEmit -p tsconfig.test.json` + `build:web` 生产构建 + `vitest run`（277 文件 / 3385 例）+ `vitest run --config vitest.ui.config.ts`（264 文件 / 2628 例）全绿。
- **同类候选（尚未做，形状一样）**：`client/src/game/meta/cardDefs.ts` 的 `cardHp`/`cardAttack`/`cardSiegeValue(+Effective)`、`client/src/game/meta/retention.ts` 的日常任务三件。这两处的服务端对应物签名不完全一致（客户端那侧包了一层 `SaveData`），不是纯搬运，要一处一处看。
- **✅ 2026-09-10 的后续：同一条规则又用了三次，客户端的手抄副本清零。** 上面那条候选里的两个都结案了（`cardDefs.ts` 读的本来就是引擎单一来源、`retention.ts` 因为包了一层 `SaveData` 过不来，两个都改成写门禁——见 `claudedocs/client-testing.md` 第七轮）。当晚的函数级覆盖率扫描又翻出**三份真正的手抄副本**，形状与 `equipment.ts` 完全一致，于是照做：
  - `@nw/shared/battlepass`（`battlepassDefs.ts`：`REWARD_ROWS` 32 行 diff 全等）、`@nw/shared/rechargeMilestone`（`rechargeTierDefs.ts`：九档 diff 全等，文件头本来就写着「keep byte-identical to the server table」）、`@nw/shared/titles`（`TITLE_DEFS` 去排版差异后语义相同）。三个服务端文件都是零运行时 import（`titles.ts` 只有一条 `import type { RankId }`，`ladder.ts` 本身也零 import）。仍然是**一次改齐八处**别名。
  - **`titles.ts` 是部分收口，不是整份删除**：数据面（`TITLE_DEFS`/`titleWeight`）来自共享，五个显示层 helper（`getTitleKeys`/`formatLadderTitle`/`formatSlgTitle`/`sortTitlesByWeight`/`allTitleIds`）留在客户端——服务端那侧用不上它们，硬搬过去等于把 i18n 键的知识塞进服务端。门面可以只收一半。
  - **包体代价这次是零**：两次干净构建（`rm -rf dist`）得到**同一个 contenthash**，主 bundle 2 241 724 B / gzip 635 161 B，±0 B。equipment 那次是 +17 B/−9 B，这次连那点都没有——三张表本来就一模一样，服务端专用的那半（`claimBpReward`/`grantTitle`/`claimRechargeReward`…）没被 re-export，整段摇掉。
  - **规则补一条前置动作：先 diff，再决定。** 三份副本都自称「保持同步」，而只有真去 diff 才知道它们此刻确实一致。如果 diff 出差异，那先有一个待答的问题（哪一侧是对的、玩家看到的是哪一份），而不是一次删除。
  - **顺带删掉的死代码**：客户端 `findRechargeTier`（全仓零调用点，服务端同名函数照旧有调用有测试）、`highestTitle`（同上，`TitlesScene` 用的是 `sortTitlesByWeight`）。

## ADR-088 安全区内缩只许有一套（`ios.contentInset: 'never'`）；inset 变化改成事件驱动；画布 re-fit 全局常驻；设备上有可读的几何读数 — Accepted — 2026-09-10

iPhone 13 竖屏「顶部标题栏盖住状态栏 + 底部空出约 80pt 死区」是**第二次**报同一件事。2026-07-28 那次（commit `60c1aba14`）假设是 WebKit 冷启动首次同步读 `env(safe-area-inset-*)` 返回 0 的竞态，在资源门禁之后补了一次重读（`resettledLayout`），**没在任何真机上验证过就发了**，无效。

这轮先做排除法：把两种候选 inset 读数代进 `PortraitLayout` 的 designHeight 公式 + `ScalingManager.applyScaling()`，得到 47/34 → `designHeight 2113`、`gameLayer.y 47`、内容 47→810（正确）；全 0 → `designHeight 2337`、`y 0`、内容 0→844（顶底都不留）。**两种都产生不了观察到的画面**——于是原假设即使成立也修不好这个 bug。能同时产生「顶部不让 + 底部空 81pt」的只有第三种：**布局视口已被减掉 81pt（`innerHeight` 763），而 `env()` 仍读回 0**。

- **决策一：安全区内缩只许有一套，原生那套关掉。** `client/capacitor.config.ts` 的 `ios.contentInset` 从 `'always'` 改成 `'never'`。`'always'` 让 WKWebView 的 scrollView 按 safeArea 缩小布局视口**并把 `env()` 归零**，于是游戏自己那套（`viewport-fit=cover` + `ScalingManager` 按 `env()` 平移 `gameLayer`，ADR 之前就有）拿到全 0、什么都不做；而原生那套又因 `mobile/index.html` 的 `html, body { overflow: hidden }` 滚不动、初始 `contentOffset(-47)` 被 clamp 回 0，画布照旧从物理 y=0 画起。两套机制叠加的结果不是「内缩两次」，是**内缩一次、还缩错了地方**。选择保留自己那套而不是反过来（删 `viewport-fit=cover`、让原生内缩、页面按 100% 排版）的理由：`gameLayer` 那条平移是**全场景统一**的一行，且横屏的左右 inset、`bgLayer` 铺到刘海下的纸底、iPad 的书桌留白全都建立在「设计矩形自己知道安全区」这个前提上；换成原生内缩要把这些逐个重做。**代价说清楚：这条烧在原生壳里，改了必须重新出包，OTA 不生效**（`IOS_RELEASE.md` §5.1）。
- **决策二：先加设备上的读数，再谈修复。** 上一次失败的唯一原因是没有真机数字就动手——桌面 Chrome 里 inset 恒为 0、视口撑满，这类 bug 一个都复现不了，`tsc` + build + 单测全绿证明不了任何事。新增 `client/src/layout/viewportGeometry.ts`（纯函数、无 DOM —— `app.ts` 在微信可达图上，所以读数本身走 `IPlatform.getViewportGeometry()`，只有 `platform/web` 碰 DOM）：`innerW/H`、`screen`、`visualViewport`、四个 `env()`、`dpr`、是否原生壳，外加一个**一词判定** `inset-eaten` / `env-reported` / `no-inset` / `browser`。两条出口：`app.ts` 的 boot 日志（也进客户端日志环形缓冲，可被定向收集捞走）+ **设置页底部两行可见文本**。后者是刻意放在 shipped UI 里而不是 debug flag 后面的：受影响的包是别人手机上的 TestFlight，没有 DevTools 可接，一张截图是唯一的通道。也刻意**不本地化**——翻译过的诊断信息等于要先翻回来才能读。
- **决策三：inset 变化从「被问才读」改成「变了就说」。** `WebPlatform.getSafeAreaInsets()` 原是一个隐藏 div、四个 padding 是四个 `env()`、谁问就 `getComputedStyle` 读一次；问题是**没人问**（boot 一次、资源门禁后一次、之后只有 `window.resize`），而 `window.resize` 对「inset 自己变了」不触发。`platform/web/safeAreaProbe.ts` 把探针改成**由 inset 决定宽高**：两个隐藏盒子（A 量 left/top，B 量 right/bottom）+ 一个 `ResizeObserver`，变了就回调（`IPlatform.onSafeAreaInsetsChanged()`；WeChat/CrazyGames 按缺省不实现 = 没有 inset 可订阅，退回纯 resize 驱动）。三个不显然的约束各有测试钉住：**必须两个盒子**（一个盒子按 top+bottom 定高看不见 47/34 → 34/47 的对调）；**`visibility:hidden` 而不是 `display:none`**（不渲染的元素没有盒子，观察器永远不触发）；**观察器的比较基线只归它自己**，不能和公开读口共用「上次的值」——`ViewportResizer` 每次 resize 都读 insets，一次读数落在「盒子变了」和「异步回调」之间就会把两边比成相等，非确定性地丢掉那条唯一该送出的通知。
- **决策四：画布 re-fit 全局常驻，重建当前场景仍只有大厅。** 此前两半共用一个生命周期，`showLobby()` 挂、`leaveLobby()` 摘，于是**登录页/设置页/整场战斗里转屏或 inset 变化完全不重排**（`renderer.resize` 没被调用，画布保持构建时的 CSS 尺寸，`toDesignSpace` 还按旧变换映射触点）。现在按成本拆：re-fit（`renderer.resize` + `createLayout` + `scaling.resize`）构造时装一次、永不摘；重建（整棵场景图）保留 `armRebuild`/`disarmRebuild` + 180 ms 合并窗口，因为**只有大厅重建得了**（`createAppCore.onResized` 门禁在 `state.inLobby`）。代价：非大厅场景转屏后画布正确、内部仍按构建时的设计矩形排布——比改之前（尺寸错**且**触点错）严格更好；「任意场景按 resize 重建」是另一件大得多的事。同时把 `viewportResize.ts` 的无变化守卫从只比 `width/height` 改成**也比 insets**（复用 `ScalingManager.insetsEqual`，为此 export）：不然「尺寸没变、只有 inset 变了」会被早退吞掉，决策三送达的正是这类事件。
- **门禁**：`test/viewportGeometry.test.ts`（10 例，判定矩阵——含「横屏不许误判成 `inset-eaten`」，iOS 的 `screen.width/height` 不随转屏交换；含「非原生壳一律不下结论」，否则每张桌面截图都像 bug）、`test/safeAreaProbe.test.ts`（8 例，手写 DOM + `ResizeObserver` stub，含无 `ResizeObserver` 的降级）、`test/ui/settingsViewportDiagnostics.ui.ts`（8 例，四种视口的不重叠 + 缩到真机后的字号下限 8 CSS px）、`test/ui/pixiAppViews.ui.ts`（改一条契约 + 新增三条）。变异验证：insets 从守卫里去掉 → 2 例红；re-fit 改回大厅独占 → 3 例红；让公开读口去动观察器基线 → 5 例红。
- **影响**：新增 `client/src/layout/viewportGeometry.ts`、`client/src/platform/web/safeAreaProbe.ts`；改 `client/capacitor.config.ts`（`contentInset`）、`public/mobile/index.html`（注释与实际机制对不上，已改）、`platform/IPlatform.ts`（两个可选口）、`platform/web/WebPlatform.ts`、`platform/{wechat,crazygames}`（写明为什么不实现）、`app.ts`（boot 读数）、`app/viewportResize.ts`、`app/PixiAppViews.ts`、`app/nav/auth.ts`、`layout/ScalingManager.ts`（export `insetsEqual`）、`scenes/SettingsScene{,.ts/panels.ts,types.ts}`。
- **`resettledLayout` 保留不动。** 它对「真·冷启动竞态」仍然对，只是在 `contentInset:'always'` 下 `env()` 恒 0、永远不触发——**它没坏，是不可达**。`app.ts` 现在只在它真的触发时打第二条 `viewport_geometry settled` 日志，于是「有没有触发」本身成了一个诊断位。
- **还没做的**：`contentInset:'never'` 本身**尚未在真机上验证**——要 Mac 上 `cap sync ios` + 重新出包（`IOS_RELEASE.md` §12 已挂 checklist）。`ResizeObserver` 的真实投递也没在真浏览器里验到：本次会话的标签页是后台窗口（`visibilityState: 'hidden'`、`requestAnimationFrame` 停摆），而观察器的投递挂在渲染步骤上，拿一个干净的 `ResizeObserver` 单独试过连初次回调都没有。改用同一处理函数的另一个入口验收了链路的后半段：把探针盒子按真机值改成 47/34，在**设置页（非大厅）**上发一次尺寸未变的 `resize` → `gameLayer.y` 0 → 47、`scale` 0.5842 → 0.5093（改之前这是空操作）。**所以这轮不宣布修好了**——等新包在 iPhone 13 上把设置页那两行从 `inset-eaten` 变成 `env-reported`。这条「先拿读数，再宣布」正是上一次唯一没做对的事。
---

## ADR-089 会话改滑动续期（响应头 `x-nw-token`），token 真失效时强制退回登录页 — Accepted — 2026-09-10

- **起因（真机报告）**：iPhone 13（Capacitor 原生包）在大厅弹红色横幅「登录已失效，请重新登录」，**只弹 toast、不做任何导航**，玩家卡在一个所有请求都 401 的大厅里。排查出两个互相独立的问题：
  1. **根因：token 从来没有续期机制。** `signToken`（`server/shared/src/jwt.ts`，默认 `expiresIn: '30d'`）全仓只有 5 个调用点，全部在 `service/auth/credential.ts`（4 处）+ `oauthBind.ts`（1 处）——**全是显式登录/注册/OAuth 绑定**。客户端把 token 写进 `localStorage`（`nw_token`）后再也不换。于是 30 天是从「上次输密码那天」起算的，**跟活跃度完全无关**：天天上线的玩家一样在第 30 天被踢。
  2. **兜底缺失**：真失效时客户端只有一条 toast（`NetSession.freshToken()` 的 `sessionExpiredNotified` latch）+ REST 401 冒泡到 GlobalToast，没有任何一处导航。
- **决策 1：滑动续期，不引入 refresh token。** 鉴权中间件（`server/metaserver/src/auth.ts` 的 `bearerAuth`）验签成功后看 `exp`：剩余不足 `TOKEN_RENEW_WINDOW_MS`（10 天）就用同一个 accountId 重签一个，塞进响应头 `x-nw-token`；客户端在 `ApiClientCore.fetchRaw()`（所有 REST 请求的唯一收口）读到就换掉并持久化。
  - **为什么不上 refresh token**：refresh token 要多一套存储、撤销表和一条新端点，换来的是「access token 可以做得很短」。这里 access token 本来就是 30 天，续期的**前提是手上那个 token 还有效**，所以泄露的 token 依然被同一个 30 天上界封住——收益不足以抵一套新机制的复杂度。
  - **10 天 / 30 天的比例**：每 20 天之内开一次 app 就能无限续下去（覆盖绝大多数活跃玩家），同时不会退化成「每个请求都重签」。
  - **只在 metaserver 签。** `worldsvc`/`socialsvc`/`auctionsvc`/`analyticsvc` 都只 `verifyToken` 验签、**不连账号库**（见各自 `httpApi.ts` 抬头），没有「这个账号还活着吗」的判断依据；客户端换到新 token 后它们自然受益。
  - **`verifyToken` 签名不动**：新增 `verifyTokenPayload()` 返回完整 payload（`sub`+`exp`+`iat`），`verifyToken` 变成它的一层薄壳。`admin`/`analyticsvc`/`auctionsvc`/`socialsvc`/`worldsvc`/`gateway` 六个既有调用点一行都不用改。
- **决策 2：CORS `exposedHeaders` 是这条方案的成败开关。** `x-nw-token` 不在 CORS 那 7 个安全列表响应头里，`server/metaserver/src/app.ts` 原来是 `cors({ origin: true })`——**不加 `exposedHeaders` 浏览器/WKWebView 根本不允许客户端读这个头，服务端照签、客户端永远看不见，而且没有任何一处会报错**。Capacitor 的 origin 是 `capacitor://localhost`，同样跨域、同样吃这条。已用一条 preflight 测试钉住（`token-renewal.test.ts`）。
- **决策 3：路由生成器把 `reply` 传给 security handler。** `MetaSecurity.bearerAuth` 原来只收 `req`，没法写响应头。改 `server/contracts/scripts/gen-openapi-server.mjs` 让 `preHandler` 变成 `(req, reply) => security.bearerAuth(req, reply)`，`reply` 声明为可选参数——既有的「只要 accountId」的调用点（单测）照旧能只传 `req`。
- **决策 4：真失效时强制退回登录页，对局中也一样。** `net/log.ts` 新增 `sessionExpiredSink` + `notifySessionExpired()`（完全沿用同文件 `appealSink`/`maybePromptAppeal` 那一套），触发点收在传输层三处：`ApiClientCore.request()`、`WorldApiCore` 的 request 助手、`NetSession.freshToken()`；`app.ts` 把 sink 指向 `nav/auth.ts` 新增的 `forceLogout()`——toast 停 1.5 s 让玩家读完 → 复用 `doLogout()` 那整套清理 → `goLogin({ notice: 'auth.err.sessionExpired' })`。**对局中命中就直接踢回登录页**：走到这一步说明连续期都救不回来，gateway 必然也连不上，留在战斗里只会卡死。
  - **三个闸门，少一个就是新 bug**：①一次性 latch（一屏并发请求会连开好几次 forceLogout，只在下次登录成功时重新上膛）；②teardown 窗口（`resetForLogout()` 会拿那个已死的 token 做 best-effort flush，必然再 401，会自我递归——**故意不复用 latch 也不依赖「TOKEN_KEY 那时已经清了」，否则这条正确性就被 `doLogout` 里的语句顺序绑住了**）；③离线模式与「本来就没持久化 token」的游客不触发（匿名 device/wx 会话的 token 只在内存里，那种 401 不是「过期」）。
  - **续期回写同样只覆盖、不新建**：`createAppCore` 里的 `onTokenRenewed` 只在 `TOKEN_KEY` 已有值时才写回。否则匿名 device 会话的内存 token 会被写进 `nw_token`，把游客**静默提升**成「已登录」——`resolveEntry` 不再给登录页、Settings 开始给出登出/改名/删号。
  - **所有权不下沉到传输层**：`nw_token` 的唯一写入方是 app 层（`doAuth` 写、`doLogout` 清），所以续期的持久化是 `ApiClientCore.onTokenRenewed` 这个 outlet 由 `createAppCore` 注册，**传输层不 import `platform`**。
- **顺带修掉一处一直是死的映射**：`client/src/net/apiErrorMessage.ts` 的 `CODE_KEY` 里 `UNAUTHORIZED` / `TOKEN_EXPIRED` / `FORBIDDEN` **三个 code 服务端从来没有发过**（`@nw/shared` 的 `ErrorCode` 里 401 只有 `UNAUTHENTICATED`，权限拒绝是 `NO_PERMISSION`）——真正的 401 一直落到泛用的「操作失败，请稍后重试」。补上 `UNAUTHENTICATED`（三个旧名保留作无害别名），同时把 `FORBIDDEN`/`NO_PERMISSION` 拆到新文案 `common.err.forbidden`：**「权限不足」不是「登录过期」**，告诉玩家会话失效会让他去找一个并不存在的登录问题。zh/en/de 三个语言包同步。
- **影响**：`server/shared/src/jwt.ts`（`verifyTokenPayload` + `TOKEN_RENEW_WINDOW_MS` + `RENEWED_TOKEN_HEADER`）、`server/metaserver/src/auth.ts`、`server/metaserver/src/app.ts`（CORS + 把 `now` 传进 security handler）、`server/contracts/scripts/gen-openapi-server.mjs` + `src/generated/routes.gen.ts`、`server/contracts/openapi/_root.yml`（`securitySchemes.bearerAuth.description` 声明这个响应头——90 个操作逐个挂 `headers:` 不划算，而 bundler 只从 `_root.yml` 带 `securitySchemes`）。客户端：`net/transport.ts`（`NetResponse.headers?`，可选所以既有 `{status,json}` 测试假体一行不改）、`platform/wechat/wechatTransport.ts`（`res.header` 大小写不敏感包装）、`net/ApiClient/core.ts`、`net/ApiClient.ts`、`net/log.ts`、`net/apiErrorMessage.ts`、`net/WorldApiClient/core.ts`、`net/NetSession.ts`、`app.ts`、`app/appCtx.ts`、`app/createAppCore.ts`、`app/nav/auth.ts`、`scenes/LoginScene{,/types,/forms}.ts`（landing 视图第一次有了错误行）、三个语言包。
- **验证**：`server/metaserver/test/token-renewal.test.ts`（10 例：阈值上下边界与恰好边界、已过期照旧 401、`remainingMs<=0` 守卫、无 `exp`、无 `reply`、CORS preflight 真的带上 `access-control-expose-headers`）、`server/shared/test/jwt.test.ts`（+6 例）、`client/test/session-expiry.test.ts`（22 例：续期采纳/下一发请求真的换了头/大小写/错误响应也续/无头不动/回声不触发 outlet、sink 本身、REST+worldsvc 两个触发点、`FORBIDDEN` 与 401 文案不同、forceLogout 导航 + 三个闸门各一条 + 重新上膛）、`client/test/net-session-freshtoken.test.ts` 改断言（那条 toast 改成走 sink）。`tsc --noEmit`（client src+test / 8 个 server 包）+ `build:web` + `vitest run`（client 280 文件 / 3458 例、UI 264 / 2628）全绿。

---

## ADR-090 金币库从「约定隔离」升级为「凭据隔离」：每服务一个最小权限 Mongo 用户 — Accepted — 2026-09-12

- **决策**：7 个连库进程各自用**自己的 Mongo 用户**登录，用户建在自己那个库里、只授 `readWrite` 该库（`authSource` 同库）。`notebook_wars_commercial` 只有 `nw_commercial` 能打开；其它服务拿到的是授权错误，不是评审意见。单一真相表 `server/scripts/mongoDbMap.mjs`（服务 → 库 → 用户 → 环境变量），开号脚本 `server/scripts/provisionMongoUsers.mjs`，漂移门禁 `npm run check:dbisolation`。
- **背景**：`COMMERCIAL_DESIGN` §0 K1/K4 从 2026-06-14 就写着「真钱数据物理隔离、commercial 是唯一权威」，**但从来没有任何机制执行它**。库名确实分开了（`notebook_wars` / `notebook_wars_commercial` / …，7 个服务各开一个库，代码层面也没人跨库），可 `docker-compose.cloud.yml` 把**同一个** `NW_MONGO_URI` 发给全部 7 个容器——同一个 Atlas 账号、权限覆盖整个集群。任何服务写一行 `client.db('notebook_wars_commercial')` 都能直接改钱包。本地栈更彻底：mongo 根本没开认证。
- **为什么是库级用户，而不是在 commercial 加一层校验**：要拦的不是「commercial 自己算错」，是「别的服务绕过 commercial 直接写库」。那条路径**不经过 commercial 的任何代码**，所以任何写在 commercial 里的检查都看不见它；唯一能站在这条路径上的层就是数据库自己的授权。
- **本地栈同构开 auth（`--auth --keyFile`）**：副本集开认证必须有 keyFile（单节点也一样，否则 mongod 拒绝启动），密钥每次启动现生成——只有一个成员，没人需要跟它对齐。本地密码是固定明文写在 compose 里的：这个容器不对宿主机开放端口，**目的不是保密，是让权限配错在本地就炸**，而不是等部署到 Atlas 才发现。
  - **建号顺序有坑**：老数据卷（开 auth 之前建的）里一个用户都没有，compose 的 `MONGO_INITDB_ROOT_*` 只在**空数据目录**上跑，所以 root 也不存在。Mongo 的 localhost 例外**只放行 `createUser` 一条命令**——先 `getUser` 探测就已经 Unauthorized（第一版脚本正是这么写的，结果「0 created」静默什么也没干）。正确顺序：①无认证会话直接 `createUser` 建 root（已存在就吞掉异常）；②**另起**一个 root 会话建 7 个服务用户——root 一存在，localhost 例外当场消失，两段塞进同一个会话必然失败。
- **兜底保留，因此这道门线上还没关**：各服务 `config.ts` 仍有 `?? NW_MONGO_URI`，compose 写成 `${自己的:-${NW_MONGO_URI}}`。**兜底生效时隔离等于不存在**（还是那一个全权限账号）。要真正关上：`node server/scripts/provisionMongoUsers.mjs --atlas --uri=…` 打印 `atlas dbusers create` 命令（Atlas 不允许驱动侧 `createUser`，用户由它自己的托管体系管），建完把打印的 7 条连接串填进 `server/.env` 重启。之后 `NW_MONGO_URI` 的语义从「集群管理员串」变成「metaserver 自己的登录」，集群管理员串不该出现在任何容器里。删掉兜底是后续收尾项。
- **门禁盯两种漂移**：①某服务源码里出现别人的库名字面量或别人的 `NW_*_MONGO_URI`；②compose 里某个服务块拿到不属于它的 Mongo 变量、或变量名对了但**凭据是别人的**（最阴的复制粘贴）；另外还检查「服务块拿着没人认领的 Mongo 变量」（新服务悄悄继承共享凭据）和「map 里声明的变量该服务已经不读了」（规则静默失效）。`NW_MONGO_URI`/`NW_MONGO_DB` 暂时豁免，因为它现在既是 meta 自己的、又是兜底——删掉兜底才能把豁免一并删掉。
- **影响**：新增 `server/scripts/mongoDbMap.mjs` / `provisionMongoUsers.mjs` / `checkDbIsolation.mjs` + `server/commercial/test/check-db-isolation.test.ts`（8 例变异测试）；`docker/docker-compose.local.yml`（mongo 开 auth + 7 个服务各自的凭据）、`docker/local-up.ps1`（先起 mongo→建号→再拉全栈）、`server/docker-compose.cloud.yml`/`prod.yml`（各服务优先读自己的变量）、`server/.env.example`、`.github/workflows/ci.yml`、`COMMERCIAL_DESIGN.md` §3.1、`claudedocs/server.md`。
- **验证**：本地全栈重起后 16 个容器全 running、metaserver `/api/health` 200、device 登录 + `GET /save` 正常、admin 用 `nw_admin` 登录成功、经 commercial `/internal/grant` 发 123 金币后在 `notebook_wars_commercial` 读回 `{coins:123}`（随后清掉）。**隔离正面/反面都实测**：`nw_world` 读自己的库返回 19 个集合，读 `notebook_wars_commercial.wallets` → `not authorized`；`nw_meta` 对 `wallets` 做 `$inc:{coins:999999}` → `not authorized`。

### 补记（同日）：线上实测 + 为什么这道门还没关上

用生产 commercial 容器直连 Atlas 实测（凭证取自 `D:\secrets` 的 `funny/prod.yaml`）：

- **今天 7 个进程共用的那个账号是 `gamestao`，角色 `atlasAdmin@admin`** —— 比「共享凭据」更糟：它不只是能读写所有库，它是集群管理员。
- **`createUser` 被 Atlas 拒绝**：`AtlasError CMD_NOT_ALLOWED: createUser`。Atlas 的 database user 是**控制面对象**，不在 `admin` 库里，所以拿着连接串（哪怕是 atlasAdmin）也建不了用户——必须走 Atlas UI / Admin API / `atlas` CLI。
- `D:\secrets` 里**没有 Atlas 控制面凭证**（只有连接串），VPS 上也没有。所以这一步**卡在一个我造不出来的凭证上**，本次没有落地到线上。

为此把脚本补成「凭证一到手就是一条命令」：

- `--atlas-api`：直接打 Atlas Admin API（HTTP Digest，`ATLAS_PUBLIC_KEY`/`ATLAS_PRIVATE_KEY`/`ATLAS_PROJECT_ID`），已存在则 PATCH 重放角色；digest 的哈希拼装有单测（RFC 2617 向量），因为**拼错的现象和「API key 不对」一模一样**。
- **Atlas 的 `authSource` 必须是 `admin`，不是服务自己的库**——Atlas SCRAM 用户一律建在 `admin`，只有 role 指向具体库；自托管用 `createUser` 建在哪个库、`authSource` 就是哪个。第一版脚本对两种路径印了同一种连接串，**那样 7 个服务会在换凭证后集体「Authentication failed」**。`authDbFor(row, atlas)` 把这条差异显式化，单测钉住两条路径对每个服务都不相等。
- `--verify --env-file=…`：连上每个服务用户，断言**能读自己的库、且被其余 6 个库拒绝**。本地实测 7/7 通过；把其中一条换成 root 串后立刻 `FAIL — nw_world can also read …(roles: root@admin)`，退出码 1——这个验证器自己是能失败的。

**收尾还差两步**（都在拿到 Atlas API key 之后）：① 跑 `--atlas-api` 建号 → 把打印的 7 条串经 `D:\secrets` 的 `bin/push-env.py` 推到 VPS `.env` → 重启 → 跑 `--verify` 确认；② 删掉各服务 `config.ts` 的 `?? NW_MONGO_URI` 兜底与 compose 的 `${…:-${NW_MONGO_URI}}`，同时把 `checkDbIsolation.mjs` 里对 `NW_MONGO_URI` 的豁免一并删掉。
