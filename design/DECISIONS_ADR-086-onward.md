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

这是决策一自己到不了的另一半：大厅沸腾线（8 fps）、火柴人剪影（12 fps）、世界地图护盾气泡（10 fps，**2026-09-22 起 30**）各自按自己的节奏改变签名，**既是空闲重绘 5–12/s 的全部来源，也是让 tick 静默窗口永远走不完的原因**。它们保持当前帧之后，未被触碰的屏幕只在 500 ms 地板上重绘（2 次/秒），决策一的节流也才咬得住。

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

> **已被 ADR-095（2026-09-28）取代**：fps 改为只统计满速段，降频段不进样本，夹阈值机制删除；`render_profile.maxFps` 也改了语义。下面两段是历史。

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
- **决策二：先加设备上的读数，再谈修复。** 上一次失败的唯一原因是没有真机数字就动手——桌面 Chrome 里 inset 恒为 0、视口撑满，这类 bug 一个都复现不了，`tsc` + build + 单测全绿证明不了任何事。新增 `client/src/layout/viewportGeometry.ts`（纯函数、无 DOM —— `app.ts` 在微信可达图上，所以读数本身走 `IPlatform.getViewportGeometry()`，只有 `platform/web` 碰 DOM）：`innerW/H`、`screen`、`visualViewport`、四个 `env()`、`dpr`、是否原生壳，外加一个**一词判定** `inset-eaten` / `env-reported` / `no-inset` / `browser`。两条出口：`app.ts` 的 boot 日志（也进客户端日志环形缓冲，可被定向收集捞走）+ **设置页底部两行可见文本**。后者是刻意放在 shipped UI 里而不是 debug flag 后面的：受影响的包是别人手机上的 TestFlight，没有 DevTools 可接，一张截图是唯一的通道。也刻意**不本地化**——翻译过的诊断信息等于要先翻回来才能读。**2026-09-17 收窄到只在原生壳画**（`UI_DESIGN_LOG_2026-09.md` §56.1）：浏览器里判定恒为 `browser`、本来就不下结论，那行字对网页玩家纯属噪声；壳里一字不改，本 ADR 的真机验收口径不变。
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

### 补记二（同日晚些）：门关上了 —— 线上建号、一次自己造出来的故障、以及兜底的最终形态

**① 控制面凭证**：在 Atlas 组织级建了 Admin API key（新 UI 里入口叫 **Applications**，不叫 Access Manager；必须选 API Keys 页签而不是 Service Accounts —— 后者是 OAuth2，脚本实现的是 HTTP Digest），组织权限只给 `Organization Member`，再把这把 key 加进 `Project 0` 并授 `Project Database Access Admin`。**只建 key 不加项目**时脚本会拿到 `USER_CANNOT_ACCESS_GROUP`，而 `GET /groups` 返回空列表 —— 这两个现象一起出现就是「key 是好的，只是没进项目」。

凭证存在 `D:\secrets` 的 `secrets/infra/atlas.yaml`（`infra` 项目 `machines: []`，`.sops.yaml` 只封给 admin key）。**不能放 `funny/prod.yaml`**：`bin/push-env.py` 是把整个解密后的项目文件原样推成 VPS 的 `.env`，控制面管理凭证会直接落到游戏服务器上 —— 正是这个 ADR 要消灭的那种过度授权。同一个文件里还存了 `NW_MONGO_ADMIN_URI`（原来那个 `gamestao`/`atlasAdmin@admin` 串），因为它被挤出 `prod.yaml` 之后总得有个地方放，而那个地方不该是任何容器。

**② 7 个用户已建、已验**：`--atlas-api` 一次建成，7 条连接串写进 `funny/prod.yaml` 推上 VPS，容器内跑 `--verify` 得到 **7/7「reads its own, refused on all 6 others」**。另外实测了金币写入链路：经 commercial `/internal/grant` 发 7 金币返回 `{ok:true,coinsAfter:7}`，随后把测试账号的 wallet/ledger/order 清掉。

**③ 一次自己造出来的线上故障，值得单独记**：`.env` 换成最小权限凭据之后，除 metaserver 外 6 个服务全部起不来，报的是

```
AtlasError 8000: user is not allowed to do action [createIndex] on [notebook_wars_commercial.ledger]
```

这条消息把我带偏了两次。**它看起来像「角色给窄了」，实际是「拿到了别人的连接串」**：VPS 上的检出还停在 `main@766f58b4`（10.09.2026），用的是 ADR-090 之前的 compose —— 那份文件把 `${NW_MONGO_URI}` 发给全部 7 个服务块。于是 commercial 容器里的 `NW_COMM_MONGO_URI` 装的是 `nw_meta` 的凭据，而 `nw_meta` 确实写不动 commercial 的库。**报错本身是隔离生效的证据。**

沿途排除掉的两个错误假设，都做了对照实验，留在这里免得下次再走一遍：

- **不是「Atlas 角色传播延迟」**。给 `nw_commercial` 加 `dbAdmin` 之后探针通过，看起来像是 `readWrite` 不够；把角色改回 `readWrite` 单角色、等 75 秒再探，`createIndex` 照样成功。**`readWrite` 足够建索引，`dbAdmin` 不需要**，7 个用户最终都是单角色。
- **不是 compose 的嵌套 `${A:-${B:?…}}` 语法失效**。最小复现里嵌套解析完全正常（Compose v5.1.4）。

**先看容器实际拿到了什么，再去动任何 Atlas 角色**：

```bash
docker compose -f docker-compose.cloud.yml --env-file .env config | grep MONGO_URI
```

**④ 部署耦合**：VPS 从 `main` 拉代码，而 ADR-090 的两个提交在当日分支上还没合进 main。恢复服务是把本地 `docker-compose.cloud.yml` 直接拷上去做的（只有那 6 行有实际差异，无需重建镜像），所以在 12.09.2026 合进 main 之前，**VPS 的工作区相对它的 HEAD 是脏的**，下次 `git pull` 会拒绝合并 —— 届时先 `git checkout -- server/docker-compose.cloud.yml` 再拉。

**⑤ 兜底的最终形态**：各服务 `config.ts` 的 `?? base.mongoUri` 全部删除，`docker-compose.cloud.yml` 六个块改成硬性 `${自己的:?…}`，门禁里 `NW_MONGO_URI` 的豁免一并删掉（并补了一条变异测试：某服务读 `NW_MONGO_URI` 要报错）。

但**没有**改成「变量缺失就抛异常」，而是 `requiredEnv('NW_X_MONGO_URI', DEV_MONGO_URI)` —— 缺省值是 `mongodb://127.0.0.1:27017/?replicaSet=rs0` 这个**主机**，不是别人的变量。理由：`npm run dev:*` 不经过 compose、仓库里也没有 dotenv，硬抛会把本地开发整条路打死；而要拦的从来不是「没有值」，是「值是别人的凭据」。回退到 localhost 借不到任何人的授权 —— 在开发机之外那个地址上什么都没有，服务死在连接拒绝上，而不是安静地读到别人的数据。线上这一层由 compose 的 `:?` 兜着。

**⑥ `docker-compose.prod.yml` 不在本次范围内**：它的兜底是 `mongodb://mongo:27017/?replicaSet=rs0`（自带的 mongo 容器，**没开认证**），从来就不是 `NW_MONGO_URI`。对它硬性要求各服务凭据会直接打死那套栈和 `docker-compose.ci.yml`（CI 叠加在 prod 之上）。要给它开认证是另一件事，本地栈 `docker/docker-compose.local.yml` 已经是那个样子了。

---

## ADR-091 文档里的代码路径也进门禁：一次扫掉 164 处指向不存在文件的引用 — Accepted — 2026-09-15

- **决策**：`scripts/checkDocLinks.mjs` 加第 4 项检查——正文里点名的源码路径（`server/<svc>/src/<模块>.ts` 这种，通常写在反引号里）必须能解析，否则 CI 红。两张豁免表，每条都必须写理由：`PATH_ALLOW`（写法本来就对但解析不了：生成物、别的仓库、每个 workspace 各有一份的脚本）、`PATH_ALLOW_HISTORICAL`（带日期的日志条目，它的主题**就是**这个文件被删掉——改路径反而会把条目写成假话）。
- **背景**：ADR-067 那道门禁只看 **markdown 链接**，而这个仓库几乎不用链接指代码，是**在正文里用反引号写路径**。于是它一直在门禁的盲区里烂：全仓 2 573 处路径引用，**164 处指向不存在的文件**（6.4%）。两次没人扫尾的大重构贡献了绝大多数：
  - **服务端单体拆成 workspaces**：`server/src/<x>.ts` → `server/metaserver/src/<x>.ts`（单体那部分变成了 metaserver），约 50 处；
  - **场景 mixin 链改组合**：`XScene/base.ts` → `XScene/core.ts`（`7536fbece` 等），10 个场景 + `ApiClient` 全中。

  其余是资源图集合并（`terrain/res/building/city_bld/playerbase_atlas` → 一张 `world_atlas`）、图标模块合并（`icons/{titles,equipment}.ts` → `inkIconRaster.ts`）、以及根目录 `scripts/` 其实住在某个 workspace 里。
- **一个反直觉的正则坑，值得记**：`gameserver` 这个词以 `server` 结尾，于是 `gameserver/index.ts` 的后半截本身就是一条以 `server/` 开头、看起来完全合法的路径（这里不把它原样写出来，否则本条自己就会触发门禁）。少了前置边界 `(?<![A-Za-z0-9_\-./@])`，每个服务的入口文件都会被报成死路径；同理 `metaserver/socialsvcClient.ts` 会被读成一条以 `server/` 开头的死路径。第一版正是这么写的，误报 7 条。**改写时更危险**：没有这条边界，把单体写法的 `Room.ts` 路径替换成 `server/gameserver/src/Room.ts` 会把**已经正确**的那条二次改写成 `server/gamegameserver/...`。
- **另一件必须做对的事：路径也要相对文档自己解析**。`design/README.md` 里写 `tools/map-editor/DESIGN.md` 指的是 `design/tools/map-editor/DESIGN.md`，是对的。只按仓库根解析会误报 7 条。
- **「不存在」不等于「过期」——这条是这次最大的收获**。164 处里逐条读上下文后，**19 处引用的文件确实没了，但文档本来就是在讲它被删掉这件事**，写得清清楚楚（`equipmentFormulaParity.test.ts` 当天加当天删，见 ADR-087；`scout.e2e.test.ts` 随侦察行军整个功能删除；`compliance.test.ts` 因断言全是假的被删）。**机械修掉这些，会把正确的历史改成错的现状。**真正过期、需要动正文的只有一份：[`design/product/client-rendering-cache.md`](product/client-rendering-cache.md)（2026-07-03 的草案，`AssetCache`/`assetManifest`/`unitSpritePool` 三个文件从没按那个名字建过，且「已加载资源永不移除」这条原则已被 `MemoryMonitor` 的主动释放推翻）——给它加了状态头，指向真正落地的那几个文件。
- **影响**：`scripts/checkDocLinks.mjs`（第 4 项检查 + 两张豁免表）；47 份文档共 96 处路径改写；`design/product/client-rendering-cache.md` 加状态头；`design/tools/level-editor/DESIGN.md` §5 加订正说明（该节写于 campaign 代码还在 `client/` 的年代，类型与 schema 已迁进 `@nw/engine`，关卡数据仍在 client，路径改了但「在 `client/` 里做」的框架只对一半成立）。CI 无需改动——`ci.yml` 早就在跑 `checkDocLinks.mjs`，新检查自动搭车。
- **验证**：门禁绿（192 份 md / 1 725 条链接 / 2 573 处路径）。两个变异逐个验红/验绿：往 `claudedocs/README.md` 塞一条单体写法的 `ads.ts` 路径 → **红**；同一行的 `gameserver/index.ts` → **不报**（前置边界生效）。
- **后续（2026-09-16，CI 上才发现）**：这条检查的 canary 写成了 `files.length === 0 || linksChecked === 0 || pathsChecked === 0`，而兄弟守卫测试 [`server/shared/test/guardScripts.test.ts`](../server/shared/test/guardScripts.test.ts) 是 spawn 真 CLI 跑在三五个文件的 fixture 树上的——那些树里一处源码路径都没有，于是**每棵树都踩 canary**，6 例全红。本轮只跑了真仓库的门禁、没跑 server 测试，所以红在 PR 的 `server test (rest)` 上才暴露。**修 fixture 而不是放宽 canary**：`docTree()` 默认往 CLAUDE.md 追加一句、点名一个同时建出来的 `.mjs` 文件，测 canary 自身的用例用 `{ sourcePaths: false }` 退出这条默认；另补一例钉住新增的那半条 canary（链接全部解析、路径扫到 0 → 红），并做了变异验证（从 canary 里去掉 `pathsChecked === 0` → 该例转红）。

### 同轮量过、但决定不做的事：「压体积」

这轮本来还要照 2026-09-14 那次**记忆**整理的做法压文档体积——删掉逐文件账目、只留约定与教训。**量完之后放弃了，理由值得记下来，免得下次有人再跑一遍同样的调查。**

- **文档里几乎没有字面重复可删**。全量扫 183 份 `design/` + `claudedocs/`（7.8 MB）里长度 ≥160 字符的段落：跨文件重复 **2 处**（都是三语法务文件共用的「适用范围」声明，本来就该各存一份），文件内重复 **1 处 246 字节**。**7.8 MB 里冗余不到 1 KB** —— 这些文件大，是因为记的东西多，不是因为说了两遍。
- **记忆能删账目，恰恰因为文档不能删**。那次整理的原话是「它们本来就能从 `claudedocs/` 和 git 历史重读」。也就是说记忆把耐久副本**委托**给了这里；在这里删同一批内容，等于把委托的对方也删了。
- **所以「压体积」这轮只做了无损的那一半**：把唯一一个离谱的异常值（`UI_DESIGN_LOG_2026-08.md`，1597 行 = 上限的 3.2 倍）按语义接缝滚成两册。滚完之后全仓再没有超过 1200 行的文档。
- **真要再压，剩下的只有语义冗余**（同一条教训换个说法又写一遍），那个机器测不出来，只能靠读；**代价是逐字读 7.8 MB，收益未经证实**。要做就单独立项，别夹在别的任务里顺手做。

---

## ADR-092 单大区容量目标改为 3000 人（取代 ADR-032 的 500）；代码常量等服务端扩容验证后再改 — Accepted — 2026-09-26

- **决策（用户 2026-09-26 拍板）**：单大区（一个 `worldId` = 一张 1500×1500 地图）的人口上限目标为 **3000 活跃玩家**。
  ADR-032 的 500 是按 500×500 地图推出来的（「500 人 × 人均 200 块 5 级+地 ÷ 50% 占比 ≈ 20 万格」），
  ADR-049 把地图放大到 1500×1500（面积 ×9）时**没有同步容量**，500 一直残留在代码和文档里。
- **代码现状（刻意未改）**：`WORLD_CAPACITY`（`server/shared/src/slg/prosperity.ts`）与 `SLG_WORLD_CAPACITY_MIN/TARGET/MAX`
  （`server/shared/src/slg/core.ts`，300/400/500）**仍是旧值**，已开的世界文档里也存着 `capacity: 500`（`resolveShardForJoin` 按文档字段判满）。
  **这是有意的**：
  1. **服务端还没证明扛得住**。容量常量一改，新玩家就不再溢出开新区，而是全部灌进同一个世界。
     worldsvc 目前单进程、同一世界的到达结算必须串行（`WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md` §6.1 / §12.5），
     唯一的负载数据是 200 bot ≈ 75 指令/秒；3000 人一个世界的指令率、推送扇出、结算吞吐都没量过。
     先改常量等于让线上替我们做压测。
  2. **ADR-032 自己记着同一个坑**：2026-06-18 文档写了「U4 大区容量 ✅ 1 万玩家」，代码从未改，事后经济核验在错误的假设上打了「已过核验」。
     所以本条**不打 ✅**，所有现行文档写成「目标 3000（ADR-092），代码仍 500，待实施」。
- **改常量之前必须完成的事（按顺序）**：
  1. **服务端容量验证**：在干净的专用测试世界上压 3000 人量级，确认单世界的指令率、`arrivals.deferred`、推送扇出、`getMap` 出口在预算内；
     不够就先做扩容（审计文档 §12.5 起的后续章节）。
     **2026-09-26 第一轮实测（审计文档 §12.8）：不够。** 真人节奏 500 人时 Mongo 已是 Atlas M0 配额的 2.5 倍；
     1000 人时主线程利用率 84%，单个计算 worker 让寻路排队到秒级，结算吞吐封顶在 8~10 条/秒且积压持续增长。
     这一条仍未满足，常量继续保持 500。
  2. **经济重跑**，三处直接吃这个常量：
     - 险地 binding 稀释（`ECONOMY_VERIFICATION_LOG_CAPACITY.md` §13-SLG-STRONGHOLD）：分母 `SLG_WORLD_CAPACITY_TARGET` 从 400 变大，
       人均稀释会**大幅下降**（ADR-054 当初是为把 65% 压回 13% 才把每级掉落从 4 降到 0.8）——要重新校准，方向可能是把掉落调回去；
     - econ-sim 三个场景 JSON 的 `topSectMembers` 是按容量比例缩放的（`ECONOMY_NUMBERS_LIVEOPS.md` §13-SLG.6），要按 3000 重缩；
     - F 轨工程估算（§13-SLG-F）原本就是按 10000 人估的文档量/内存，3000 在其包络内，但它**只估了文档量，没估指令吞吐**。
  3. **定 MIN/TARGET**：MAX=3000 已定；MIN/TARGET 两档（现 300/400）尚未拍板。TARGET 是险地稀释的分母，跟第 2 条一起定。
  4. 改常量 + 已开世界的 `capacity` 字段如何处理（新赛季自然生效，还是运营改当季）。
- **影响**：本次只改文档——`SLG_DESIGN.md` §1、`SLG_DESIGN_CONTRACTS.md` U4/U11/U12、`DEPLOY_TOPOLOGY.md`、`SLG_LOG_SPEC_SEASON.md` §17.8、
  `SLG_ECONOMY_CHECK.md` §7/§8、`ECONOMY_NUMBERS_LIVEOPS.md` `WORLD_CAPACITY` 行、`ECONOMY_VERIFICATION_LOG_CAPACITY.md` 头注、
  ADR-032 加被取代说明、`WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md` §12.5。

## ADR-093 本城基础产量：纸 / 石墨 / 金属各保底 50/小时 — Accepted — 2026-09-27

- **问题**：练兵一个兵要 墨 10 + 纸 5 + 石墨 5 + 金属 5 + 贴纸 1，五种缺一不可。本城以前**只产墨**（`tileYield('base')` = `{ ink: 100 }`），其余四种全靠地块。
  金属只来自金属地块，约占 L1–2 资源格的 1/5；开局资源全是 0。前线恰好一块金属地都没有的玩家**一个兵也造不出来**。
  兵力耗完就占不了新地，也就永远拿不到金属，形成死锁。
  - 机器人：线上 s2-0 已有机器人卡在这里（BOTSVC_DESIGN §3.4），它们从不放弃地块。
  - 真人：可以放弃地块退回驻军来自救，但那是「软卡死」——新手根本想不到这一步。
- **决策（用户 2026-09-27 拍板）**：本城在墨 100/h 之外，再给**纸、石墨、金属各 `BASE_FLOOR_YIELD` = 50/h**。
  - **贴纸不给**：`stickerShop` 本来就在主城自产贴纸。
  - **保底吃加成**：它就是本城产量的一部分，和本城的墨走同一条路径，同样乘资源建筑、战令、城池收益。实现上就是 `tileYield('base')` 多返回三项，`recomputeYieldAndCount` 一行没改。
  - 量级：50/h 约等于每小时 10 个兵、每天约 240 个。只够把人从死锁里拉出来，不替代地图作为主产——一块 L1 地就是 100/h。
- **否决的方案：每天白送 1 万兵**。
  - 它绕过了「资源 → 练兵 → 战损 → 再练」这条 sink 闭环（SLG_LOG_SPEC_SYSTEMS 兵力章）。
  - 1 万兵等于满兵力池，相当于每天免费回满一次，会直接改变 SLG 的战损经济。
  - 保底产量只补上缺的那一环：资源仍然要自己攒、兵仍然要自己造。
- **存量修复**：`yieldRate` 是存下来的值，只在占地、弃地、建筑完成、围攻这几条路径重算。
  老玩家要等下一次触发才能拿到保底，而卡死的玩家恰好永远不会触发。
  - 办法：worldsvc 启动时跑 `backfillBaseFloorYield()`，对每个 open/active 世界重算一次全部玩家，与 `backfillMissingCities` 并列。
  - 写入前先按**旧速率**结算（`settleExpr`），所以保底**不追溯**到修复之前。
  - 速率没变的玩家不写。
  - 跑完在世界文档上打 `baseFloorYieldAt`，重启不再扫描；中途崩了没打标记，下次启动接着做。
- **连带改动：机器人占地排序**。BOTSVC_DESIGN §3.4 规则 3 ① 原来用「`yieldRate` 为 0」判断「还不产这种资源」，有了保底后这一条永远不成立。
  改为：产量 ≥ 本城产量 + 一块 L1 地（加成前）才算「已经有地在产」（`producesFromTiles`）。
  - 本城单独最多是 50 × 2（资源建筑满级）× 1.1（战令）= 110，低于 150。
  - 有一块地至少 150。
  - 两者不重叠。
- **修订 ADR-025**：该条写的是「只有锚点贡献本城的**墨**」。锚点仍然是唯一贡献者（8 个环格照旧跳过），只是贡献的从墨扩成了四种。
- **经济核验**：econ-sim 收入模型原先完全没算本城产出，现已补上（`city.ts` `hourlyIncome`）。
  casual 档建筑 + 练兵合算最慢的纸 29.8 → 29.0 天，仍在 60 天赛季窗口内，节奏结论不变。
  详见 [`ECONOMY_VERIFICATION_LOG.md`](game/ECONOMY_VERIFICATION_LOG.md) §13-SLG-CITY 常量已改 ⑤。
- **影响**：
  - `@nw/shared`：`slg/core.ts` 新增 `BASE_FLOOR_YIELD`；`slg/march.ts` 改 `tileYield`。
  - `worldsvc`：`season/management.ts` 新增 `backfillBaseFloorYield`，由 `index.ts` 启动时调用；`WorldDoc.baseFloorYieldAt`；e2e `base-floor-backfill.e2e.test.ts`。
  - `botsvc`：`expansion.ts` 新增 `producesFromTiles`。
  - `tools/econ-sim`：`city.ts` 的收入模型。
  - 客户端不用改：资源栏读的是服务端下发的 `yieldRate`。

## ADR-094 帧率上限改由 vsync 整数分频实现，两个 ticker 共用一个节拍（取代 PIXI `maxFPS`） — Accepted — 2026-09-28

- **问题**：用户要求各界面帧率稳定、抖动 ≤ 3。2026-09-28 在本机真 Chrome（有头、60 Hz）逐屏测了 53 个界面：
  - 浏览器的 rAF 本身完全均匀，但 `app.ticker` 在**每个界面**都每 3 秒丢约 4 帧，每次留下一个 33 ms 空档。
  - 原因在 PIXI `Ticker.update` 的节流：`delta = (t - lastFrame) | 0` 先取整再和 `1000 / maxFPS` 比。60 Hz 下的 16.67 ms 被截成 16，小于 16.67，于是这一帧被跳过。线上 `render_profile` 的 `fpsP50` 常年是 59 而不是 60，就是这个。
  - 同一套「按毫秒比较」的节流在 75 / 90 / 144 Hz 屏上会得到 1 拍、2 拍交替的不均匀节奏。
  - `Ticker.shared`（沸腾线和 14 处战斗 / 卡牌 fx）与 `app.ticker` 各自节流、各自一条 rAF 循环，互不同步：空闲压到 20 时，101 次 shared tick 里 101 次和主画面落在不同的 vsync 上。
- **决策**：`render/framePacer.ts` 接管两个 ticker 的 rAF 循环。
  - 两个 ticker 的 `maxFPS` 置 0、`autoStart` 关掉并 `stop()`，由 pacer 自己的**一条** rAF 循环驱动；每次决定跑，就先 `Ticker.shared.update(t)` 再 `app.ticker.update(t)`，同一个时间戳。先 shared 后 app，这样 fx 本帧的改动能赶上本帧的绘制。
  - 上限按 **vsync 整数分频**实现：`N = max(1, round(刷新率 / 上限 − 0.1))`，每 N 个 vsync 跑一次。60 Hz 屏：上限 60 → 每拍都跑，上限 20 → 每 3 拍跑一次；120 Hz → 60；144 Hz → 72；165 Hz → 55；90 Hz → 90。节奏永远是均匀的，代价是实际帧率只能取刷新率的整数分之一，可能比上限高或低一点（四舍五入而不是 `ceil`：75 Hz 屏跑 75 比跑 37.5 更符合「稳定」）。
  - 那个 −0.1 是把分频的翻转点从 x.5 挪到 x.6：90 Hz / 60、30 Hz / 20 恰好等于 1.5，翻转点压在常见刷新率上时，刷新率估计抖动百分之一 Hz 就会让 N 逐帧在两个值之间跳，节奏反而乱掉。挪到 x.6 后，常见刷新率（60/75/90/100/120/144/165/240）对 60 和 20 两档上限都离翻转点 0.05 以上（有测试钉住）。
  - 刷新率由最近 16 个 rAF 间隔的中位数估计，所以偶尔掉一帧不会拉偏；设备本身只给 30 Hz 时 N 自然落到 1。
  - 浏览器漏掉 vsync（长帧）时按实际经过的 vsync 数累计，不会因为一次卡顿再多等一轮。
  - 上限（60 / 20）的切换点、`holdRenderActive()` 同步拨回 60 的行为都不变（ADR-086），只是写的是 pacer 而不是 `ticker.maxFPS`。
- **遥测跟着改**：`ticker.maxFPS` 现在恒为 0，`PerfMonitor` 改从 `render/renderStats.ts` 的 `framePacing()` 读当前上限（`windowMinCap` 与 `render_profile.maxFps` 语义不变），`render_profile` 顺带新增 **`hz`**（估计的显示刷新率）——那台常年 `fpsMax 30` 的 dpr2 设备，这个字段能直接说它是不是 30 Hz 屏。
- **A/B 实测**（同页、大厅有输入、6 秒）：迟到帧 9 → 0，最大帧间隔 34.0 → 17.4 ms，每秒 fps 58–59 → 60，shared 与主画面错拍 9 → 0–1。
- **不在本条范围**：空闲 60 → 20 的降频本身。用户 2026-09-28 选了「保留 20 省电，改帧率统计口径——只统计画面真在变的帧」，另行实施。
- **影响**：`client/src/render/framePacer.ts`（新）、`render/renderPolicy.ts`、`render/renderStats.ts`、`cache/PerfMonitor.ts`；测试 `test/ui/framePacer.ui.ts`（新）、`test/ui/renderPolicy.ui.ts`、`test/PerfMonitor.test.ts`、`test/renderProfile.test.ts`；文档 `claudedocs/client-render-budget.md`、`design/game/ANALYTICS_DESIGN.md`。

## ADR-095 帧率只统计「满速段」：静止降频的时段不计入 fps，另报 `idlePct` — Accepted — 2026-09-28

- **问题**：ADR-094 修好之后，有人操作 / 有东西在动时各界面都稳在 60 ± 1。剩下唯一让「抖动 ≤ 3」超标的是 ADR-086 的空闲降频：菜单静止 2 秒后 tick 从 60 降到 20，按窗口算的 fps 直接差出 40。这 20 fps 的时段里画面**根本没有在变**（降频的触发条件就是「2 秒内签名没变、没有输入、不是 `live` 场景」，任何变化都会在同一 tick 拨回 60），所以肉眼看不到卡顿，只是统计口径把「故意不画」当成了「画得慢」。
  - 同一个口径问题已经被修过两次补丁：ADR-086 决策六把 watchdog 阈值夹到 `maxFPS − 5`，2026-09-12 又改成「窗口内见过的最小上限」（`windowMinCap`）。补丁只挡住了假告警，`render_profile.fpsP50` 仍然会读出 20，还得靠人去对 `maxFps`。
- **决策**（用户 2026-09-28 选定：保留 20 fps 省电，改统计口径）：
  - `RenderPolicy` 在 `renderStats` 里多发布一个 `idle` 标志——pacer 被压在 `IDLE_FPS` 时为真，和上限在同一处（`setMaxFps`）改，所以输入同步拨回 60 时它也同步变假。
  - `PerfMonitor` 的帧率只由**满速帧间隔**算：一个间隔（上一 tick → 这一 tick）只有在两端观察到的都不是 `idle` 才计入。于是：进入降频的那一段、降频中的每一段、以及从降频醒来的那一段（半截是 50 ms 的空闲间隔）都不算；醒来后第二个间隔起照常计入。醒来时如果是策略自己发现画面变了（而不是输入），会多扔掉一个本来是满速的间隔——宁可少算一帧，也不把 50 ms 算进满速段。
  - 一个 2 秒窗口里满速时长不足 500 ms 就**不产出 fps 样本**（几帧算出来的速率噪声太大）；这个窗口对卡顿 watchdog 是中性的——既不累加连续低帧计数，也不清零。
  - 因为 fps 现在永远是在满速上限下量的，**`windowMinCap` / `FPS_WARN_HEADROOM` 整套夹阈值的机制删除**，阈值回到固定的 `nw_fps_warn`（默认 25）。30 Hz 屏满速也是 30，仍在 25 之上。
  - `render_profile`：
    - `fpsP50 / fpsMin / fpsMax` 改为满速段的分布；整段 span 都在降频时这三个字段**缺省**，而不是报 0 或 20。
    - `maxFps` 改为 span 内满速帧见过的最高上限（即那段时间实际要求的天花板，正常就是 60）；没有满速帧时退回上报时刻的上限。不再会出现「`maxFps: 20` 要先读它再读 `fpsP50`」的情况。
    - 新增 **`idlePct`**：span 内处于降频的时间占比（0–100）。省电效果看它，流畅度看 `fpsP50`，两件事不再搅在一个数里。
    - `tickPerSec` / `paintPerSec` / `skipPct` 口径不变（仍按全部 tick 算），它们本来就是省电指标。
  - 卡顿异常（`cpu`）里的 `fps` 同样是满速段的值。
- **不改的**：`IDLE_FPS = 20`、`IDLE_QUIET_MS`、降频的触发与唤醒逻辑（ADR-086 / ADR-094）完全不动；本条只改「怎么数」。
- **读旧数据**：2026-09-28 之前的 `render_profile` 行，`fpsP50` 混着降频段，`maxFps` 是上报时刻的上限；没有 `idlePct` 字段即为旧口径。
- **影响**：`client/src/render/renderStats.ts`、`render/renderPolicy.ts`、`cache/PerfMonitor.ts`；测试 `test/PerfMonitor.test.ts`、`test/renderProfile.test.ts`、`test/ui/renderPolicy.ui.ts`；文档 `design/game/ANALYTICS_DESIGN.md`、`claudedocs/client-render-budget.md`。

## ADR-096 切屏卡顿：兵种立绘分两档（640 px 缩略图 + 抽卡揭示用原图）、图鉴贴图到齐不再整屏重建、`live` 帧不再走签名 — Accepted — 2026-09-28

- **问题**：ADR-094/095 之后稳态各界面都是 60 ± 1，剩下的抖动全在**切屏第一帧**。有头 Chrome、1366×768、dev 构建，用 LoAF + `texImage2D` 包装 + CDP Profiler 按帧聚合定位：
  - 图鉴（`cardCodex`）首次进入 LoAF 52 / 81 / 183 ms，其中 GL 上传 113 ms——12 张兵种立绘都是最长边 ~2200 px 的原图，在 ~110 px 的格子里显示。
  - 在世界地图停留 70 s 后再回图鉴 162 ms，其中 120 ms 是重新上传：PIXI `TextureGC` 把 3600 帧没用过的纹理从显存逐出，回来就得再传一次。
  - 图鉴每张图解码完成都触发整屏 `render()`，12 张图 = 12 次重建（慢机上是连续卡顿，测试里还会无限重建）。
  - 主城屏主线程时间约四分之一花在 `RenderPolicy` 每帧画完后的 `stageSignature` 遍历——`live` 场景（战斗、世界地图、主城）每帧都画，签名根本用不上。
  - 家族屏 `applyFamily` 先 `render()` 一次，频道和入会申请各自回来又各 `render()` 一次，申请又排在频道后面串行等。
- **决策**：
  1. **立绘两档**：`client/src/assets/units/thumb/<name>.png`，最长边 640 px（= 320 逻辑 px × `MAX_RENDER_RESOLUTION` 2），由 `art/scripts/exportUnitCardArt.mjs` 从已提交的原图派生；原图本身不超过 640 × 1.25 的兵种（archer / infantry / shieldbearer）不出缩略图。`CARD_ART_URLS` / `UNIT_ART_URLS` / `L1_CARD_ART_URLS` 一律交出缩略图。
  2. 唯一需要大图的是抽卡单抽揭示（`picSize = 0.68 × cellW`，宽屏约 780 设计 px）：`artUrlForBox(url, boxLongEdge)` 在 `boxLongEdge × devicePxPerDesignUnit() > 640` 时换成原图，否则原样返回；`GachaScene/odds.ts` 的 `drawEntryPicture`（概率表与揭示共用）走它。`devicePxPerDesignUnit = renderer.resolution × designScale`，新增在 `render/bake.ts`。
  3. **图鉴贴图到齐不重建**：`CardCodexScene/tile.ts` 改用 `buildFittedSprite`（先隐藏、`loaded` 时自己 fit + 显示），外面包一层 slot 容器（它会改写自己的 x/y）。`artHooked` / `onArtLoaded` 整套删掉。
  4. **`live` 帧不走签名**：`RenderPolicy.tick` 只在非 `live` 的重绘后才算 `stageSignature`；`live` 帧把 `lastSignature` 记为 `-1`（签名是 `>>>0` 的无符号数，`-1` 永远不会匹配），切回 reactive 时第一帧必然判为变化、画一次，然后照常跳帧。
  5. **家族屏只画两次**：`applyFamily` 末尾 `await Promise.all([loadChannel(), loadJoinRequests()])`（并行），`loadJoinRequests` 不再自己 `render()`，由 `loadMyFamily` 在最后统一 `render()` 一次。
- **实测**（有头 Chrome 1366×768）：图鉴首访 183 → 77 ms（GL 113 → 18 ms），被 TextureGC 逐出后回访 162 ms → 无 LoAF；家族首访 159 ms 一帧 → 97 / 57 ms；所有屏 1 分钟内回访无 ≥ 50 ms 的帧。明细见 `claudedocs/client-render-budget.md` §16。
- **放大审计**：各 `STOPS` × {桌面 1366 dpr1、retina 1920 dpr2、手机 390 dpr3}，缩略图的最大显示倍率 0.76（retina 卡组），没有任何地方被放大。审计没覆盖到的抽卡揭示走原图（上面第 2 条）。
- **不改的**（首帧成本还在，面太广，另立项）：PIXI.Text 创建 / `measureText` / `getContext`；`buildPaperBackground` 里 `SketchPen` 逐段圆头线（每个新 bake key 约 27 ms）；世界地图程序化地块；`world_atlas.png` 1960×1827 上传（29–42 ms）；卡组（`cardRoster`）JS 构建（`renderCardCell`、`txtFit`、字形图集）。
- **影响**：`art/scripts/exportUnitCardArt.mjs`、`client/src/assets/units/thumb/*`、`render/{bake,cardArt,renderPolicy}.ts`、`scenes/CardCodexScene{,/tile}.ts`、`scenes/GachaScene/odds.ts`、`scenes/FamilyScene/data.ts`；测试 `test/cardArt.test.ts`、`test/ui/renderPolicy.ui.ts`、`test/ui/cardCodexScene.ui.ts`、`test/familyLoadDecouple.test.ts`；文档 `claudedocs/client-render-budget.md` §16、`claudedocs/file-formats.md`。

## ADR-097 世界地图 / 主城空闲不再满帧重绘：行军小人 12 fps 步进、被全屏覆盖层盖住的地图停摆、战役图与每日页的脉动相位量化 — Accepted — 2026-09-28

- **问题**：2026-09-28 帧率普查里，世界地图、主城（及其上的弹窗）、战役图、每日页、`friends+world`、布防编辑空闲时一直 58–59 次/秒重绘，`IDLE_FPS` 降频永远触发不了。逐节点对比相邻两帧的签名字段（有头 Chrome、1366×768、seed 过的世界）定位到四个来源：
  - 世界地图：行军 / 占领 / 驻扎小人每帧推进骨骼姿势（7 个小人 × 10 根骨头），行军位置每帧按实时时钟插值——一格路程走几十秒，每帧不到 1 px，却让整张地图 60 次/秒重画。ADR-085 当时特意把「行军在途时每帧都画」钉成测试。
  - 主城（以及好友、聊天、家族、门派、拍卖、布防这些 SLG 覆盖层）是 `pushOverlay` 压在地图上的，下面的地图照样每帧动，覆盖层虽然是 reactive、铺满了不透明纸张，也跟着 60 次/秒重画看不见的动画；地图 HUD 还在下面每秒整片重建一次。
  - 战役图「下一关」脉动圈、每日页可领格子的呼吸：直接用 sin 每帧改 `scale` / `alpha`。
  - 引导圈早已按 10 fps 量化相位（`GuideOverlay` RING_PULSE_FPS），是这次的现成做法。
- **决策**：
  1. **地图小人 12 fps 步进**（`MAP_TOKEN_ANIM_FPS = MENU_POSE_FPS`，`WorldMapRenderer/lifecycle.ts`）：一个共用时钟同时驱动骨骼姿势（`update(tokenDt)`，非步进帧传 0）和行军插值用的时间（`ctx.tokenNowMs`，只在步进帧取 `Date.now()`），两者在同一帧变。**只量化时间输入**，`syncTokens` 仍每帧执行，所以拖动 / 缩放时小人与地图同帧移动，不会落后一个步长。ADR-085 的「行军在途每帧都画」改为「每秒约 12 次、绝不冻住」。
  2. **被覆盖的地图停摆**：`WorldMapScene.pause()` 置 `ctx.covered = true`，`resume()` 复位并把 HUD 倒计时设为立即到期。covered 时 `lifecycle.update` 在伤害闪红之后直接返回（引导圈、护盾、L3 / 覆盖墨迹刷新、小人全跳过），HUD 每秒重建也暂停；脏标记和小人位置在第一帧未遮挡时补上。地图容器**不隐藏**、照常随覆盖层的重绘一起画——隐藏会让 `world_atlas` 这些大纹理在城里待满 3600 帧后被 TextureGC 逐出，回地图又是 29–42 ms 的重新上传（ADR-096 同一机制）。
  3. **脉动相位量化**：新增 `render/steppedTime.ts`（`PULSE_STEP_FPS = 10`、`steppedTime(t, fps)`），战役图圈、每日页格子、引导圈共用。量化的是相位不是调用方，所以同一步长内调多少次都落在同一个值上。
- **不改的**：护盾 `SHIELD_ANIM_FPS = 30`（2026-09-22 因「护盾动画不连贯」特意从 10 调上来），所以视野里有护盾时地图仍约 35 次/秒（护盾 30 + 小人 12 两个时钟不同相）；30 s 无操作后护盾停（`decorationsQuiet`），小人不停（位置是信息，不是装饰）。地图 HUD 每秒整片重建本身（护盾倒计时精确到秒，每秒确实要变）未改成增量。
- **实测**（空闲 4 s 后采 4 s，`painted / ticks`）：世界地图 240/240 → 138/240（无护盾时约 12/s），主城 241/241 → 40/240（剩下的是城内引导圈 10/s），战役图 241 → 40，每日页 240 → 41。明细见 `claudedocs/client-render-budget.md` §17。
- **影响**：`client/src/render/{steppedTime,GuideOverlay}.ts`、`scenes/{WorldMapScene,CampaignMapScene,DailyScene}.ts`、`scenes/worldmap/WorldMapContext.ts`、`scenes/worldmap/WorldMapRenderer/{lifecycle,tokens}.ts`；测试 `test/ui/worldMapOverlayCoalescing.ui.ts`、`test/ui/ambientPulseRate.ui.ts`、`test/ui/dailySceneCheckinFocus.ui.ts`；文档 `claudedocs/client-render-budget.md` §17。

## ADR-098 手机首启卡顿：`render_profile` 拆开最长那一帧、边框图集挪到启动加载阶段；地图小人改为跟护盾共用 30 Hz 节拍 — Accepted — 2026-09-28

- **问题**：
  1. 线上 `render_profile` 里 iPhone 原生壳的 IntroScene `rndMax` 是 735–2006 ms，是全表最差的一项。四行全来自同一个测试号 09-23/24 重装后的首次启动，都在第一个 30 s 窗口里，而 `fpsP50` 同时还有 54–58——PIXI ticker 把单帧 `deltaMS` 截到 100 ms，一次 2 s 的卡顿在帧率里只占 100 ms，所以只有 `rndMax` 看得见它。桌面 Chrome 同一段最慢一帧 19 ms。`rndMax` 只有一个数，分不出是冷 Metal 着色器缓存、首次使用的字体、还是 `texImage2D` 触发的图片解码。
  2. 本机探针（390×844、dpr 3、CPU 降速 6 倍）在同一段里找到一处能复现的：进入年龄 / 同意门那一帧 256 ms，其中 216 ms 是**一个** Graphics 的三角化——`panelFrame` 边框图集（约 6200 个 SketchPen 图形、41 万顶点），整局第一次调 `sketchPanel` 时在烘焙渲染里现建。新玩家撞在打断开场故事的年龄门上，老玩家撞在大厅第一帧。这一帧线上记在 IntroScene 名下（门是盖在 Intro 上的弹窗，`activeScene` 没变）。
  3. ADR-097 之后，视野里有护盾时地图仍约 35 次/秒重绘：护盾 30 fps 累加器和小人 12 fps floor 两个时钟不同相，小人的步进大多落在护盾不动的帧上。
- **决策**：
  1. **`render/renderCostProbe.ts`**：包住 GL 上下文实例的 `texImage2D` / `texSubImage2D` / `compressedTexImage2D`（上传）、`compileShader` / `linkProgram` / `getShaderParameter` / `getProgramParameter`（着色器；有 `KHR_parallel_shader_compile` 时等待落在状态查询上），以及 `PIXI.Text#updateText`、`PIXI.GraphicsGeometry#updateBatches`（只计脏对象，干净的在读时钟之前就返回）。`app.ts` 的 render 包装每帧清零、结束后把分项交给 `recordRenderSample`；只有刷新最大值的那次才留下分项。`rndMax ≥ 50 ms` 的 `render_profile` 行带 `rndMaxTex` / `rndMaxSh` / `rndMaxTxt` / `rndMaxGeo`（ms）、`rndMaxScene`、`rndMaxAt`（启动后秒数）。
  2. **`prewarmPanelFrame()`**：`app.ts` 在发出 `preloadBoot` 的请求之后、`await` 之前调用，在加载画面后面、等网络的空档里建好图集。放在请求之前会拖慢请求，放在 `await` 之后就回到关键路径上。
  3. **地图共用节拍**：`MAP_ANIM_FPS = 30` 一个累加器（`ctx.mapAnimAcc` / `mapAnimBeats`），护盾每拍一步（`decorationsQuiet` 时只是不用这一拍，节拍本身照走），小人每 `MAP_TOKEN_BEATS = 3` 拍一步，即 **10 fps**。每个小人步进帧都是护盾帧：有护盾 30 次/秒，没护盾 10 次/秒。选 10 不选 ADR-097 的 12，是因为 12 除不尽 30；选 10 不选 15，是因为 15 会让没护盾时从 12 次/秒涨到 15 次。
- **不改的**：
  - IntroScene 那 2 秒的根因没有定论，桌面复现不出来。本次只加仪器，等一份新报告：`rndMaxSh` 占大头就是冷着色器缓存（预热着色器到启动阶段），`rndMaxTxt` 就是字体，`rndMaxTex` 就是图片解码。
  - 边框图集本身的顶点数（圆头笔画逐段三角化）没动，改它就要改画风。
- **实测**：
  - 进年龄门那一帧，CPU 降速 6 倍时 256 ms → 边框图集移出之后桌面 24.7 ms（剩下的是 12 个文字纹理上传）；探针端到端读到 `rndMaxGeo 215.7`、`rndMaxScene IntroScene`、`rndMaxAt 12.1`。
  - 世界地图（seed 世界、视野里有护盾和行军，空闲 4 s 后采 4 s）：138 / 240 → 123 / 240（约 31 次/秒 = 护盾 30 + HUD 每秒 1 次）。
- **影响**：`client/src/render/{renderCostProbe,panelFrame}.ts`、`src/app.ts`、`src/net/anomaly{.ts,/anrContext.ts}`、`src/cache/PerfMonitor.ts`、`src/scenes/worldmap/WorldMapContext.ts`、`src/scenes/worldmap/WorldMapRenderer/{lifecycle,shieldFx,tokens}.ts`；测试 `test/renderCostProbe.test.ts`、`test/ui/renderCostProbe.ui.ts`、`test/renderProfile.test.ts`、`test/appAssetGateWiring.test.ts`、`test/ui/panelFrameAssembly.ui.ts`、`test/ui/worldMapOverlayCoalescing.ui.ts`、`test/ui/worldMapShieldBubble.ui.ts`；文档 `claudedocs/client-render-budget.md` §18。

## ADR-099 首次进屏卡顿：纸背景改用线条条带图集、文字只光栅化一次、世界图集在大厅空闲时上传；烘焙纹理不再比请求的小 — Accepted — 2026-09-28

- **问题**（有头 Chrome、1366×768 dpr 1 与 dpr 2，按屏首次进入时 CPU 采样的包含耗时，探针见 `claudedocs/client-render-budget.md` §19）：
  1. **纸背景**：`buildPaperBackground` 每遇到一种新的 `(w, h, 红线 x)` 就把约 28 条整页宽的 SketchPen 线烘焙成一张整页 RenderTexture，三角化 20–27 ms / 次。弹窗尺寸各不相同、侧栏宽度不同、地图页不画红线，于是设置、抽卡、世界地图、反馈、结算、主城弹窗首次打开各付一次（布防编辑、训练弹窗两次，54–67 ms）；每张还是一整张后缓冲大小的显存，留到会话结束。大厅自己还有一份一模一样的拷贝，另占一张。
  2. **文字光栅化两次**：`PIXI.Text` 从 `settings.RESOLUTION`（1）起步，第一次渲染时才切到渲染器分辨率并重画。几乎所有标签都在布局时读过 `width`（这一读就光栅化了），所以在分辨率 2 的渲染器上（所有手机、所有 retina 屏）每个这样的标签画两遍。
  3. **`txtFit` 试字号**：为判断放不放得下读 `probe.width`（光栅化一次），放不下就丢掉、按新字号再建一个（再光栅化一次，还多一个 canvas）。卡牌列表首建 86 ms 里它占 43 ms。
  4. **世界图集上传**：`world_atlas.png` 1960×1827 的 `texImage2D` 在世界地图第一帧里单次 34 ms（桌面）。大厅空闲预取只解码不上传。
  5. **（顺带发现）烘焙纹理比请求的小**：PIXI 把基础纹理尺寸存成 `round(size × res) / res`，小数分辨率下最多短 `0.5 / res` 点。图集按请求尺寸切片，最后一行越界，PIXI 的 frame setter 直接抛异常。边框图集在 0.5–3.0 之间 251 个分辨率里的 180 个会抛（含 1.1、1.33，即浏览器缩放 110% / 133%），而 ADR-098 刚把它挪进了启动阶段。线上 14 天 Loki 里没有这条异常，目前没有玩家碰到。
- **决策**：
  1. **`render/paperRules.ts`**：同一支笔、同样参数，只画 4 条 1024 px 的横线条带和 1 条红线条带，按 `pageBakeResolution()` 烘焙一次（按分辨率记忆，旋转换比例时重烘一张小图）。一页 = 一个纯色矩形 + 每条线若干条带窗口 sprite（按种子取条带和偏移，首尾相接；笔的端点几乎不动，接缝看不出）。（ADR-104 起 WebGL 下这些窗口并成两个 Mesh，Canvas 回退仍是 sprite。）不再有任何整页烘焙。条带不做首尾渐细：原来的渐细只落在每条线最外 10%，即侧栏下面和内容区右边之外。大厅的 `buildBackground` 改为直接调用共用页。
  2. **`setTextResolution(renderer.resolution)`**（`render/pixiText.ts`，`app.ts` 启动时调用）：设 `PIXI.Text.defaultResolution`，新建的文字从一开始就是渲染器分辨率。`autoResolution` 保留，所以分辨率变化（ADR-100）时屏上的文字仍会按新值重画。
  3. **`measuredWidth(text)`**：用同一个 `TextMetrics` 调用、同样的整设备像素取整算出 `width`，不光栅化。`txtFit` 只建一个 Text，量、改字号、再量、必要时截断，全程不光栅化；真正的光栅化只在它被显示时发生一次。
  4. **`uploadToGpu(baseTexture)`**（`render/bake.ts`）：经 `renderer.texture.bind` 立刻上传。`idlePrefetch` 的 `slg:world` 波次在解码完成后等下一个空闲时段再上传（不和解码挤在同一个时段）。`bind` 会盖上使用时间戳，TextureGC 按常规空闲预算处理；玩家在大厅待得比那更久，进地图时就照旧上传。
  5. **`bake` / `bakeLazy` 按「覆盖尺寸」分配**：`ceil(ceil(size) × res) / res`，保证分配出来的点尺寸不小于请求值。所有图集（边框、纸线、HUD 血条等）一处修好。
- **实测**（桌面 dpr 1，全部 44 个站点）：纸背景每屏 20–67 ms → ≤ 1.8 ms；世界地图首帧不再有 > 8 ms 的纹理上传；卡牌列表首建 `renderCardCell` 86 → 36 ms（`txtFit` 43 → 13）。dpr 2 下 `updateText` 包含耗时：卡牌列表 41 → 17–24、主城 60 → 47、家族 65 → 52、每日 33 → 22（其余几屏在噪声范围内）。LoAF 最大值在这台机器上两版都会跳到 400 ms 以上且帧内无脚本，是环境噪声，不作为指标。
- **不改的**：卡牌格子的「屏幕外一行」分帧建（做完上面几项后收益约 25%，不值得引入逐帧构建的状态）；`measureText` 本身的成本；`numTxt` 字形图集首建（每会话一次，约 16 ms）；从未打开过地图的玩家（不在预取范围里）首次进地图仍在第一帧上传。
- **影响**：`client/src/render/{paperRules,sketchUi,pixiText,bake}.ts`、`src/render/atlas/spriteAtlas.ts`、`src/assets/idlePrefetch.ts`、`src/scenes/LobbyScene/core.ts`、`src/app.ts`；测试 `test/ui/paperRules.ui.ts`、`test/ui/textRasterOnce.ui.ts`、`test/ui/bakeFractionalResolution.ui.ts`、`test/uploadToGpu.test.ts`、`test/idlePrefetch.test.ts`、`test/appRenderResolutionWiring.test.ts`、`test/pageBakeCallSites.test.ts`、`test/liveStrokedInkCallSites.test.ts`、`test/ui/sceneGeometryBudget.ui.ts`；删除 `test/paperBakeSharing.test.ts`（它钉的是已不存在的整页烘焙键）。

## ADR-100 慢设备自动降分辨率：对战撑不住 24 fps 时渲染分辨率 2 → 1.5 — Accepted — 2026-09-28

- **问题**：一台 iPad（768×1024 CSS、dpr 2、后缓冲 2048×1308）对战时报 16–20 fps。分辨率 2 每帧要填 CSS 像素数的 4 倍，1.5 是 2.25 倍，着色像素少 44%。画面是 1–3 px 的墨线，差别看起来是「稍软」而不是「糊」。
- **决策**（`render/adaptiveResolution.ts`，`app.ts` 在 `RenderPolicy` 之后安装）：
  1. **只看 live 场景**（战斗）。reactive 界面本来就在跳帧，帧间隔说明不了设备能力。切到非 live 或页面隐藏就重置窗口。
  2. **进入 live 3 s 后开始，5 s 一个窗口取中位数**：场景构建的首帧、零星卡顿自然被排除（中位数要半个窗口都慢才会变）；超过 250 ms 的间隔算停顿，不计入（降分辨率治不了停顿）；样本不足 50 个的窗口不判。
  3. **中位间隔 > 41.7 ms（低于 24 fps）才降**。rAF 被锁在 30 Hz 的浏览器（低电量模式的 Safari，那台 iPad 报过 `fpsMax 30`）稳定在 33 ms，不会误触；60 Hz 设备掉到 30 也不会。
  4. **每会话最多一次、只降一级、只往下**：渲染器分辨率 ≤ 1.5 的（dpr 1、微信恒为 1）根本不挂监听。
  5. **切换**：`renderer.resolution = 1.5` + `resize(原 CSS 尺寸)`，只重建后缓冲；`setTextResolution(1.5)`；屏上文字在下一次渲染时按新分辨率重画，页面级烘焙按新 `pageBakeResolution()` 重新取键——切换那一帧一次性付出。
  6. **上报**：`render_res_down {from, to, fps, scene}`（analyticsvc 全采样）；之后的 `render_profile` 里 `res` / `canvasW/H` 是降后的值，另带 `resFrom`。
- **不改的**：不跨会话记忆（低电量模式这类临时原因会把画质锁死好几天；先看线上触发频率再定）；不回升；不细分 GPU 与 CPU 瓶颈（CPU 瓶颈时降了也无害，只是没收益——`render_res_down` 之后那条 `render_profile` 的 `fpsP50` 会说明有没有用）。
- **实测**：有头 Chrome 1024×768 dpr 2 人机对战，每帧注入 50 ms 忙等（中位 19 fps），6.9 s 后切换：后缓冲 2048×1536 → 1536×1152，CSS 尺寸不变，截图布局对齐、只是略软。CPU 降速 12 倍在这台机器上对战仍有 57 fps，触发不了，所以用注入负载验证整条链路。
- **影响**：`client/src/render/adaptiveResolution.ts`、`src/app.ts`、`src/cache/PerfMonitor.ts`（`resFrom`）、`server/analyticsvc/src/service/eventConfig.ts`；测试 `test/adaptiveResolution.test.ts`、`test/renderProfile.test.ts`、`test/appRenderResolutionWiring.test.ts`；文档 `design/game/ANALYTICS_DESIGN.md` §4.2。

## ADR-101 变化检测少走冤枉路：被覆盖层盖住的场景不遍历、画完后的基线能沿用就不重走 — Accepted — 2026-09-29

- **问题**（有头 Chrome、1366×768 dpr 1、dev 构建、带种子数据的账号，每项 5 s CPU 采样，新旧交替各 3 轮，探针见 `claudedocs/client-render-budget.md` §20）：`stageSignature` 在世界地图静止时每 5 s 占 256–338 ms，是主线程忙碌时间的 35–42%；主城静止时占 260–372 ms（43–68%）；拖动时两屏都还有 170–285 ms。两个来源：
  1. **主城下面整张地图照样被遍历**：主城（以及好友、聊天、家族、门派、拍卖、布防、装备这些覆盖层）是 `pushOverlay` 叠在活场景上的。ADR-097 让被盖住的地图停摆，但签名遍历仍然每个 tick 走完它的 1,500–2,100 个节点，而覆盖层是铺满全屏的不透明纸张，下面的任何变化都看不见。
  2. **每次重画后都要重走一遍整棵树**建立基线（`render()` 自己会改签名读的字段：文字光栅化、容器排序）。拖动时每帧都画、下一帧根本不看基线，这次遍历全白走；静止时护盾 30 fps、tick 60 Hz，每两个 tick 三次遍历，其中一次是这个。
- **决策**：
  1. **`setSignatureCovered(root, covered)`**（`render/renderPolicy.ts`）：被标记的子树在签名里折成一个常数、不下探。`SceneManager` 每个 tick 推导一次：有覆盖层、并且覆盖层在显示列表里确实排在 `current` 之上时，标记 `current.container`；push / pop / 硬切换时也立即推导一次。**是推导不是在 push 时记录**：淡入途中叠上的覆盖层，那一刻的 `current` 是正在淡出的旧场景，随后被销毁，新场景反而排在覆盖层之上（e2e 探针就是这样进主城的，记录式的第一版因此一直在遍历真地图）。只改签名、**不隐藏**地图：隐藏会让大纹理被 TextureGC 逐出（ADR-097 同一理由），而且渲染成本另当别论。
  2. **画完后的基线**（`RenderPolicy.baselineAfterPaint`）：
     - `hold` 且下一个 tick 仍在 hold 之内（剩余 > 50 ms，即一个 `IDLE_FPS` 周期）→ 不走，基线置 -1。只有手势最后一帧才走。
     - `changed` → 画前 `decide` 刚走过一次。如果那次遍历没看到 render 会改的东西（`Text` / `BitmapText` 的 `dirty`、`sortableChildren && sortDirty`），直接沿用它的签名。
     - **兜底**：沿用之后紧接着的那个 tick 如果又是 `changed`，这次画完真走一遍。于是 render 端还有别的、这张清单不知道的改动时，代价是多画一帧然后稳定，绝不会让静止画面一直满帧重画；中间隔一个 skipped tick 就解除（护盾那种隔帧变化能一直沿用）。
     - `floor`、以及即将结束的 hold → 照常走。
  3. 顺带：遍历改成模块级递归函数（不再每次建闭包），`visible` 每节点只读一次。离线基准 1,875 节点 147 → 约 100 ns / 节点。
- **实测**（每 5 s，基线三轮 → 新三轮）：
  - 世界地图静止：签名 256 / 282 / 272 → 140 / 165 / 191 ms，主线程忙碌约 698 → 552 ms。
  - 世界地图拖动：签名 171 / 187 / 206 → < 1 ms。
  - 主城静止：签名 301 / 260 / 358 → 52 / 26 / 52 ms，忙碌约 457 → 207 ms。
  - 主城拖动：签名 219 / 238 / 272 → 0。
  - 重画次数不变（同一轮里 painted 数一致），省的只是判断。
- **不改的**：世界地图自己的 650 个格子有一半在屏幕外（317 个、845 个节点），视口裁剪能再砍掉地图静止时一半的遍历和一部分渲染，但要改地图的格子管理，风险另算，这次没做。（2026-09-29 已做，见 ADR-102。）`render` 本身（地图静止约 330 ms / 5 s）没动。
- **影响**：`client/src/render/renderPolicy.ts`、`src/scenes/SceneManager.ts`；测试 `test/ui/renderPolicy.ui.ts`（新增「covered subtrees」「the baseline after a paint」两组，8 处变异均验红）、`test/ui/sceneManager.ui.ts`（新增「overlays and the change detector」，淡入途中叠覆盖层的顺序保护和逐 tick 推导各验红一次）。

## ADR-102 世界地图格子池视口裁剪：屏幕外的格子隐藏、滚进来才画 — Accepted — 2026-09-29

- **问题**：格子池（`WorldMapRenderer/pool.ts`）是屏幕矩形在格子坐标里的外接框。2:1 等距投影下屏幕矩形投到格子坐标是个菱形，外接框的四个角——约一半的格子——根本到不了屏幕，却照样被渲染器画、被变化检测（ADR-101）逐节点遍历。顺带发现一个原有的差一错误：`poolW = visW + 2`，但平移到非整数位置时 ceil−floor 的跨度是 `visW + 1`，加上起点前的一格缓冲，最后一列/一行没有自己的格子，屏幕右下角会缺一个格子的边角（原代码同样复现）。
- **决策**：
  1. `refreshPool` 每次平移时逐格判断：格子中心加上它可能画到的范围（地标建筑 tp×1.3 高、最宽 1.52:1，底座在中心下方 0.72×hh → 横向 ±1.05 tp、向上 1.2 tp、向下 0.3 tp，取整留余量）完全落在地图可见带（header 与底部 HUD 之间）之外的，`visible = false` 并**跳过重画**，`tx/ty` 保持旧值——等它滚回屏幕，下一次 `refreshPool` 发现坐标对不上就会重画。回到屏幕但格子没变的，直接恢复可见（地图外的仍隐藏）。
  2. `poolW/poolH = vis + 3`（`logic/zoom.ts`）。多出来的一行一列几乎都在屏幕外，被裁掉，成本可忽略。
- **实测**（ADR-101 同一探针，世界地图，1366×768 dev 构建，每 5 s，基线三轮 → 新三轮；种子账号每轮不同，节点数本身波动 ±20%）：
  - 舞台节点：1,699 / 2,110 / 2,137 → 1,448 / 1,658 / 1,449。L1 格子池 702 个里隐藏 359 个（51%）；L2 4,032 个里只显示 945 个。
  - 静止：签名 150 / 215 / 193 → 196 / 144 / 152 ms（均值 186 → 164），渲染 268 / 408 / 450 → 358 / 283 / 320 ms（均值 375 → 320），忙碌均值 649 → 570 ms。
  - 拖动：渲染均值 1,107 → 973 ms，忙碌均值 1,526 → 1,414 ms。重画次数不变。
  - 比预期的「砍一半」小：屏幕外那一半本来就是「瘦」格子（多数没有等级标签、没有母题建筑），被裁掉的主要是一个 Graphics 一个节点。
  - **订正（2026-09-29 当天复核）**：当初这里写「剩下的节点大头是 `Lv.N` BitmapText 的每字形 Sprite」，**不对**。Pixi 7.4 的 BitmapText 是一个容器加每个字体页一个 Mesh（这张字体只有一页），一个标签 2 个节点，不是每字一个 Sprite；种子账号上屏幕内可见的标签只有 13–24 个。按节点类型数（可见节点，三轮）：格子 Graphics 213–352、格子上的母题/建筑 Sprite 153–210、格子池之外的 Sprite 226–258（城池层、雾、护盾、HUD 等）、Container 55–77、Graphics 46–100、Text 28–34，标签连容器带 Mesh 只有 26–48。把标签换成「每种文案一张共享纹理 + 一个 Sprite」试做过、A/B 三轮：每屏只省约 20 个节点，耗时差异完全淹没在种子账号之间的波动里（同版本不同轮能差一倍），**没有合进来**。
- **不改的**：`Lv.N` 标签（见上面的订正：不是节点大头，改了也量不出来），L3 批量 Graphics 路径（本来就不走格子池）。再往下降要先弄清格子池之外那 ~250 个 Sprite 分别属于哪一层。
- **影响**：`client/src/scenes/worldmap/WorldMapRenderer/pool.ts`、`logic/zoom.ts`；测试新增 `test/ui/worldMapPoolCulling.ui.ts`（在多个平移位置、两档缩放和竖屏下断言「每个菱形碰到可见带的格子都有一个显示着、且最后一次画的正是它的格子」，并用包装 `drawTileSlot` 独立记录每个格子实际画了谁；去掉裁剪 / 回来不恢复可见 / 横向或向下边距归零 / 被裁时只记坐标不重画 / 池尺寸退回 +2，五处变异均验红），`test/ui/worldMapPoolDepthOrder.ui.ts`（zIndex 只比对显示着的格子），`test/worldmapZoom.test.ts`（+3）。

## ADR-103 世界地图城池层：空的特效层隐藏，不留在可见树上 — Accepted — 2026-09-29

- **问题**：ADR-102 之后格子池之外还有 ~250 个 Sprite 没拆开。按「场景层 + 构造器名」数可见节点（种子账号，1366×768，同一轮两次一致）：纸面背景横线 76 个 Sprite、行军小人 70 个 Sprite + 15 个容器、底部 HUD 62、顶栏产量 43、主城横幅 2——这些都是画面上真有的东西。真正的空转在**城池层**：每座玩家城一个容器 13 个节点（建筑图、名字、血条、护盾罩、护盾光环子树（虚线环 + 装闪光点的容器 + 4 个闪光点）、破盾闪光），17 座城 221 个节点，其中 136 个 Graphics 里 110 个是空的——没受损就没有血条，没护盾就没有罩子和光环，破盾闪光只活 0.4 秒。空 Graphics 照样被渲染器和变化检测（ADR-101）逐个走一遍。
- **决策**：四个特效层（`hpbar`、`shieldFx`、`shieldGlowFx`、`shieldBreakFx`）建出来就 `visible = false`；画的地方才显示：血条在「受损」分支里、护盾罩和光环跟 `protectedUntil` 同步、破盾闪光在入队时显示、`lifecycle.update` 里过期清掉时再隐藏。NPC 城的耐久条同样处理。节点不销毁（容器是跨刷新复用的，同一座城可能再次上护盾）。
- **实测**：没护盾、没受损的城从 13 个可见节点降到 3 个（容器、建筑图、名字）。这一轮种子 9 座城（3 座带护盾、2 座受损）：城池层 117 → 53 个可见节点；17 座城那一轮按同样算法约 221 → 70–90。耗时没做 A/B——ADR-102 订正里说过，这个探针对几十到一百多个节点的差异量不出来。claude-in-chrome 看过：护盾罩、虚线环、闪光点、受损城的血条都在。
- **不改的**：纸面背景的 76 条横线（所有场景共用 `buildPaperBackground`，静态、同一张纹理能合批；要降就得烘成一张图，影响面是全部场景，单独立项——已由 ADR-104 并成两个 Mesh，没有烘图）；行军小人（动画本身，每个 ~14 个节点）；HUD / 顶栏（都是真控件）。
- **影响**：`client/src/scenes/worldmap/WorldMapRenderer/city.ts`、`lifecycle.ts`；测试 `test/ui/worldMapShieldBubble.ui.ts` 新增一组（普通城四层都隐藏 / 血条随受损显隐 / 护盾罩与光环随护盾显隐、破盾闪光活到寿命结束再隐藏；去掉破盾隐藏、去掉光环同步两处变异均验红），`test/ui/worldMapCityDurabilityBar.ui.ts` 补 `visible` 断言。

## ADR-104 纸背景横线并成网格：每页约 80 个 Sprite 变成 2 个 Mesh — Accepted — 2026-09-29

- **问题**：ADR-099 之后，纸背景（`buildPaperBackground`，约 40 个场景共用）= 纯色底 + 条带图集上截出的窗口 Sprite。横屏一页 27 条横线、每条 2–3 段，加红线 2 段：1920×911 窗口下大厅 / 扭蛋 88 个、世界地图（无红线）86 个 Sprite。它们同一张纹理、本来就合批，但渲染器和变化检测（ADR-101）每帧都逐个走一遍。ADR-103 时把这件事留作「单独立项」。另查过「只在世界地图缩放 1 级隐藏横线」：缩放 2、3 级横线会从半透明格子里透出来（记忆 `fps-pacing-sweep-2026-09-28`），只能省一个缩放级，不如直接减节点。
- **决策**：`render/paperRules.ts` 在 WebGL 下把所有横线窗口写成**一个** `PIXI.Mesh` 的四边形，红线另一个 Mesh（两者颜色不同，Mesh 没有逐顶点颜色）。每个四边形的四个角和纹理坐标与原来那个 Sprite 完全一样（竖线把 Sprite 的 90° 旋转折进顶点顺序），纹理是图集整张。几何按「页宽 × 页高 × 红线 x」缓存 24 个（LRU），同尺寸重建直接复用；Mesh 销毁时几何引用归零只释放 GPU 缓冲，下次画会重新上传，所以共享安全，没销毁的旧页也只占有限几份。**Canvas 回退**（`bakeRendererIsCanvas()`）保留原来的 Sprite 窗口：pixi 的 canvas 网格渲染按三角形逐个画，会出缝。
- **实测**（claude-in-chrome，1920×911，e2e 构建，新旧两个 dev server 同一账号）：大厅、扭蛋（带左侧标签栏的红线位置）、世界地图三种页面，把背景节点单独渲染到纹理里取像素做 FNV 哈希——原尺寸、0.7371 倍 + 亚像素偏移、0.5 倍、1.3333 倍四种变换，新旧**逐字节相同**。节点：页面子节点 89 → 3（地图 87 → 2）。背景单独渲染一次（dev 构建）约 19–41 µs → 5.5–12.5 µs；加上变化检测少走的 ~86 个节点（§20 的 0.3–0.7 µs / 节点），每帧省约 0.05–0.08 ms，用户感觉不到，是减少常驻遍历成本的整理。多了 1 次绘制调用（横线 Mesh 顶点超过 `Mesh.BATCHABLE_SIZE`，单独画；红线 8 个顶点仍进批）。
- **没测**：竖屏、真机 Canvas 回退（只有单元测试覆盖）。
- **影响**：`client/src/render/paperRules.ts`、`render/bake.ts`（`bakeRendererIsCanvas`）、`render/sketchUi.ts`（注释）；测试 `test/ui/paperRules.ui.ts` 改成按网格顶点检查，新增「Mesh 与 Sprite 逐四边形顶点 / 纹理坐标一致」（四种尺寸与分辨率）、「同尺寸共享几何、销毁后可复用」、「Canvas 下仍是 Sprite」；`test/ui/sceneGeometryBudget.ui.ts` 设置页断言改为 2 个 Mesh。变异检查：竖线顶点左右写反、去掉 Canvas 分支、去掉几何复用，三处各自验红。

## ADR-105 竖屏设计宽度跟着屏宽走：手机 720–860，平板及以上仍是 1080 — Accepted — 2026-10-01

- **问题**：竖屏设计宽钉死 1080，390 宽 iPhone 整屏 0.36×、360 宽安卓 0.33×。字号已由可读性下限（§49）+ 手机放大系数（§72）按 CSS px 补回来，但**图标、格子、内边距、等级星都是写死的设计 px**，在手机上只有三分之一大；单独调大常数也没用——按宽度排的容器会原样缩回去（记忆 `icon-legibility-gate-2026-09-14`）。§72.2 当时列过这条路，判为「61 个场景竖屏重排、战斗棋盘重做」，没选；2026-10-01 用户改选这条。
- **决策**：`client/src/layout/designSize.ts#portraitDesignWidth(availW) = clamp(偶数(availW / 0.5), 720, 1080)`——目标缩放 0.5，540 CSS px 及以上（平板、桌面竖窗）仍是 1080，一个像素不动；手机 360→720、390→780、430→860。横屏不动（它的定轴是 1080 高）。
  - **战斗棋盘按 `k = 设计宽 / 1080` 等比缩**：格子 `floor(84k)`、顶/底 HUD、手牌区、卡牌尺寸都乘 k，棋盘在屏幕上占的比例和以前一样；四条带的取整误差由手牌区吸收，保证设计高 = `max(round(1920k), 宽×长宽比)`，和巡检的预测（`test/browser/lib/auditBox.ts` 直接 import 同一个函数）逐像素一致——差 1px 就会让缩放比和字号下限跟着偏，巡检会报一屏假的「字太小」（实测 360×640 一次 59 条）。
  - **`snapFont` 的封顶随短边缩**（`fontScale.ts#snapCeilFor`）：按格高算出来的字号，以前在 2337 高的设计里一律被 `display`(60) 截住 ≈ 21 CSS px，这道截断其实一直在替许多窄格子兜底；设计变窄后同一个 60 = 30 CSS px，德语任务名、结算页按钮、顶栏金币全撑破了宽度没变的盒子。封顶 = 最近档(60 × 短边/1080)，手机上是 42（≈ 原来的 21 CSS px），短边 1080 的地方（全部横屏、平板、桌面）仍是 60。
- **结果**：卡牌/装备/拍卖格子、图标、等级星在手机竖屏上约大 1.4×；文字基本不变（下限和放大系数本来就瞄 CSS px，缩放到 0.5 后补得少了）。逐站修掉的溢出见 `UI_DESIGN_LOG_2026-10.md` §73。
- **代价**：手机竖屏一屏能看到的格子变少；拍卖格在最窄的手机上缩小商品图来保住两列；主城建造格最窄 0.7× 目标列宽，再窄就滚动。
- **没做**：真机没跑过。（原写「手机横屏仍是 0.36×」——同日补做，见下条。）
- **补充（同日，横屏）**：横屏的定轴是设计**高度**，套同一条规则：`landscapeDesignHeight(availH) = clamp(偶数(availH / 0.5), 720, 1080)`，宽度仍随安全区长宽比、上下界 1920 / 2592 同乘 `k = 设计高 / 1080`（`landscapeDesignWidth`）。≥ 540 CSS px 高（平板横、桌面窗口）一个像素不动；手机横握 844×390 → 1688×780，缩放 0.361 → 0.5；360 高 → 720 下限。棋盘格 `floor(70k)`、顶 HUD、左右栏、卡牌 ×k，底条吸收取整误差，三条带严格叠成设计高（巡检 `auditBox.ts` 直接调同两个函数）。逐站账见 `UI_DESIGN_LOG_2026-10.md` §73.6。
- **影响**：`client/src/layout/{designSize,PortraitLayout,LandscapeLayout}.ts`、`layout/ScalingManager.ts`、`render/fontScale.ts`（`snapCeilFor`/`snapFontDown`）、`test/browser/lib/auditBox.ts`，以及 §73 列的各场景。
- **补充（2026-10-07，横屏和竖屏脱钩）**：横屏改用自己的目标缩放和下限：`landscapeDesignHeight(availH) = clamp(偶数(availH / 0.62), 640, 1080)`（`LANDSCAPE_TARGET_SCALE` / `LANDSCAPE_MIN_H`），竖屏仍是 0.5 / 720 不动。
  - **为什么**：CrazyGames 审核员的真实画布是 1100×574——574 / 0.5 = 1148 被截到 1080，整屏 0.53×，正文 9.6 CSS px、小字 8.5；门户预览格 722×406 是 0.50×。横屏窗口离眼睛更远，而且长轴跟着长宽比走、宽度有富余；竖屏的宽度是每个格子网格挤着排的那条轴，放不起。0.62 是让 1100×574 正文到 ≈ 11 CSS px、同时 ≥ ~670 CSS px 高（1280×720、1366×768、1920×1080、平板横）仍得 1080 的那个数；640 下限是 360 高横握时棋盘两侧 `300k`/`200k` 栏还装得下字面尺寸文字的地方（再低就让缩放降下去：360 → 0.56×）。
  - **前后对比**（棋盘格 `floor(70k)`，所以棋盘在屏幕上的占比基本不变；字号和单位身高是字面设计 px，跟着缩放走）：

    | 视口 | 设计矩形 前 → 后 | 缩放 前 → 后 | 正文 CSS px | 小字(tiny) CSS px | 中号单位身高 CSS px（单位/格） | 棋盘占宽 / 占高 |
    |---|---|---|---|---|---|---|
    | 1100×574（CG 审核画布） | 2070×1080 → 1775×926 | 0.531 → 0.620 | 9.6 → 11.2 | 8.5 → 8.1 | 28.7 → 33.5（0.77 → 0.90） | 60.9% / 77.8% → 60.8% / 77.7% |
    | 722×406（CG 预览格） | 1444×812 → 1163×654 | 0.500 → 0.621 | 10.0 → 11.2 | 8.0 → 8.1 | 27.0 → 33.5（1.04 → 1.29） | 64.8% / 76.8% → 65.0% / 77.1% |
    | 844×390（手机横握） | 1688×780 → 1385×640 | 0.500 → 0.609 | 10.0 → 11.0 | 8.0 → 7.9 | 27.0 → 32.9（1.08 → 1.32） | 53.3% / 76.9% → 同 |
    | 640×360 | 1280×720 → 1138×640 | 0.500 → 0.562 | 10.0 → 10.1 | 8.0 → 7.3 | 27.0 → 30.4（1.17 → 1.32） | 64.7% / 76.7% → 64.9% / 76.9% |
    | 1280×720 / 1366×768 / 1920×1080 | 1920(1921)×1080 不变 | 0.667 / 0.711 / 1.0 不变 | 12.0 / 12.8 / 18.0 不变 | 不变 | 36.0 / 38.4 / 54.0 不变（0.77） | 65.6% / 77.8% 不变 |

    小字略降（8.5 → 8.1）是因为可读性下限按缩放取档：0.53× 时下限被抬到 `small`(16)，0.62× 时落在 `tiny`(13)；仍在 7 CSS px 下限之上。正文的手机放大系数在 0.62× 时为 1（只在 < 0.556× 时介入）。
  - **单位相对格子变大**：单位身高（`render/unitSize.ts`）是字面设计 px，不乘 k；722×406 上中号单位从 1.04 格高变成 1.29 格高（1100×574 是 0.90）。实拍 1100×574 的战斗画面不挤；更矮的横屏上单位开始压到邻车道，要不要让单位身高也乘 k 留给单位渲染那条线决定（本轮没动 `UnitView`）。→ 已于 2026-10-08 处理，见本 ADR 末条补充。
  - **随之修掉的横屏布局**（实拍 + 巡检，`test/ui/landscapeSmallScale.ui.ts` 守其中五条）：战斗左下十颗心超出屏幕左缘 → 允许占用棋盘左侧整条纸边、放不下才等比缩；顶栏「投降 / 退出关卡」按钮 44 高塞不进 36 高的顶条 → 按钮高不超过顶条；它的标签缩到下限（8 CSS px）时先加宽按钮再缩字；拖拽幽灵卡上的长卡名（Meteor Strike / Shield Bearer）伸出 64 宽的卡 → 先缩字号、到下限再折行；战役地图顶栏的 Chapters / Gear 胶囊挂到顶栏下沿外 → 先收内边距再上移；大厅「战役 / 世界」卡的标题与副标题框相叠 → 副标题收进卡内、标题让开；邮件详情的附件行按 `h` 比例排距叠在一起 → 取比例与行高的较大者；家族页公告条比公告字矮、压到「成员 / 家族频道」栏头 → 条高不低于一行；登录页底部条款说明越过红色装订线 → 换行宽度避开装订线；战斗右下刷新/升级标签出框 → 按按钮宽高适配；大厅顶栏副标题被标题划线压住 → 副标题落到划线下；设置页头像角标盖住首字 → 角标外移。逐站账见 `UI_DESIGN_LOG_2026-10.md` §76。
  - **影响**：`client/src/layout/designSize.ts`（`LANDSCAPE_TARGET_SCALE`、`LANDSCAPE_MIN_H`、`landscapeDesignHeight`）；`test/browser/lib/auditBox.ts` 直接调同一个函数，自动同步；巡检视口表加了 `landscape-1100x574`、`landscape-722x406` 两行。
- **补充（2026-10-08，单位身高按格子封顶）**：所有身高档统一乘 `min(1, 格子 / 54)`（`render/unitSize.ts#unitSizeScale` / `boardUnitHeight`，阈值常量 `UNIT_SIZE_FULL_CELL = 54`，即中号身高本身——格子小于 54 时中号恰好一格高）。
  - **为什么是 54**：1100×574 的格子是 60（`floor(70 × 926/1080)`），≥ 54，所以审核画布和所有更大的画布逐字节不变；横屏 CSS 高 ≥ 517 px 时格子 ≥ 54，都不缩。竖屏格子 `floor(84k)` 最小 56（720 设计宽），一律不缩——竖屏 / 微信竖屏不受影响；微信横握走同一个 `createLayout`，和网页一样缩。
  - **一处取值**：战斗棋盘上所有按单位身高定尺寸的地方都从 `boardUnitHeight(type, cellSize)` 取：骨骼 / 帧图运行时的 `targetHeight`（含对象池复用的 `reset`）、占位草图、HP 条 Y（`stickmanHpBarY(高度)`）、拖拽落点预览。命中点（`getHitPoint`）、阴影、阵营色块、装备贴花挂在运行时容器缩放上，自动跟随。`UnitView` 经 `BoardView.cellSize` 拿格子大小，一个视图内不变（布局改了整场重建）。`StickmanRuntime.loadAsset` 仍传未缩放的档高：它只用来校准按 URL 全局缓存的受击轮廓，缩小的单位轮廓随之按比例变细，可接受。世界地图行军小人、单位实验室不在棋盘上，不动。
  - **前后对比**（设计 px，括号内为格高倍数）：

    | 视口 | 格子 | 系数 | S | M | L | XL |
    |---|---|---|---|---|---|---|
    | 1100×574（CG 审核画布） | 60 | 1 | 46（0.77）不变 | 54（0.90）不变 | 64（1.07）不变 | 81（1.35）不变 |
    | 722×406（CG 预览格） | 42 | 0.778 | 46 → 35.8（1.10 → 0.85） | 54 → 42（1.29 → 1.00） | 64 → 49.8（1.52 → 1.19） | 81 → 63（1.93 → 1.50） |
    | 844×390 / 640×360（手机横握，640 设计高） | 41 | 0.759 | 46 → 34.9（1.12 → 0.85） | 54 → 41（1.32 → 1.00） | 64 → 48.6（1.56 → 1.19） | 81 → 61.5（1.98 → 1.50） |
    | 390×844 竖屏（780 设计宽） | 60 | 1 | 不变 | 不变 | 不变 | 不变 |
    | 360×640 竖屏（720 设计宽） | 56 | 1 | 不变 | 不变 | 不变 | 不变 |

    722×406 上中号单位的 CSS 高 33.5 → 26.1 px（缩放 0.621）。档间比例 0.85 / 1 / 1.18 / 1.5 不变。
  - **影响**：`client/src/render/unitSize.ts`、`render/BoardView.ts`（`cellSize` getter）、`render/UnitView.ts`、`render/UnitView/{build,assets}.ts`、`render/GameRenderer/dragGhost.ts`；测试 `test/render/unitSize.test.ts`（各画布格子与系数、722×406 中号 ≤ 1 格、360–1080 高横屏扫一遍中号都 ≤ 1 格）、`test/render/unitViewBoardSize.test.ts`（运行时 / 草图 / HP 条 / 池复用都取同一个高度）、`test/ui/dragLandingPreview.ui.ts`（722×406 落点预览随之缩小）。没有实拍，合并后由协调者看画面。

## ADR-106 `render_profile` 隐藏时补发：短会话里出现过慢帧也报一条 — Accepted — 2026-10-01

- **问题**：首条 `render_profile` 要攒满 15 个可见窗口（约 30 s）才发，页面隐藏时不补发。2026-09-30 测试 iPhone 重装后首启：2.4 s 跳过开场，不到 1 分钟就换了会话，**一条都没发**。ADR-098 加拆分仪器要等的正是这份「冷首启」报告，而只要玩家跳过开场就走，这种会话永远收不到。
- **决策**：会话第一次隐藏时（web 的 `visibilitychange→hidden` / `beforeunload`、微信的 `wx.onHide`，统一走 `platform/appLifecycle.ts`），如果这次会话**还没发过** profile、并且见过 **`rndMax ≥ 50 ms`**（即 `RND_MAX_DETAIL_MS`，带拆分的门槛）的一帧，就把目前为止的跨度提前报出去，带 `trigger: 'hide'`。
  - 正在采样的那个窗口先并进去：它到这一刻为止都是可见的，而 2 s 内就隐藏的会话只有这一个窗口，boot 的第一帧就在里面。并完之后清零，切回来不会重复计。
  - 没有慢帧的短会话不报：没有要解释的东西，否则每次跳出都要多一行。
  - 提前报的这一条计入每会话 6 条的上限，但**不算**那条约 30 s 的定时报告：切回来的会话仍在约 30 s 后发它，而不是约 5 分钟后。每个会话最多提前报一次。
  - 监听要在把窗口锁存为隐藏的那个监听**之前**注册，也要在 `analytics.init()` 之前（`app.ts` 里 PerfMonitor 本来就装在前面）：这样才判断得出当前窗口是否可见，事件也才能在分析队列自己的隐藏刷新之前入队。两种宿主上监听都按注册顺序执行。
- **影响**：`client/src/cache/PerfMonitor.ts`；测试 `test/renderProfile.test.ts`（新增「early report on hide」四条，桩 `document` 加了 `visibilityState`）。Grafana 里 `trigger` 字段缺失 = 定时报告，`'hide'` = 提前报的那条，算 `fpsP50` 时它的跨度可能只有零点几秒。

## ADR-107 边框图集预烘焙挪到第一次上屏之后，`first_frame` 只认上屏的那次 render — Accepted — 2026-10-01

- **问题**：2026-10-01 巡检里，测试 iPhone 登录页两条 `render_profile` 的 `rndMax` 是 108 / 116 ms，其中 `rndMaxGeo` 占 91 / 101，`rndMaxAt 0.4`、`rndMaxScene ""`。这一帧就是 ADR-098 的 `prewarmPanelFrame()`（约 41 万顶点的边框图集烘焙）：
  - `bake()` 调的是 `app.renderer.render`，而 `app.ts` 已经把这个属性换成了计时包装，所以烘焙也会被计成一次 render。
  - 它在 `startApp` 里同步执行，那时 ticker 一帧都还没跑，所以它是整个会话的**第一次 render**，`first_frame`（「白屏到第一帧」）记的其实是这次离屏烘焙的结束时刻。
  - 在 iPhone 上，加载画面因此晚了约 100 ms 才画出来，这段时间屏幕是空白的。
- **决策**：
  1. 只有不带 `renderTexture` 的 render 才算上屏。`first_frame` 只在上屏的 render 上打点；烘焙仍记入 `rndMs` / `rndMax`，因为它确实占了主线程。
  2. `prewarmPanelFrame` 不再同步调用，改为登记到 `afterFirstPaint`：第一次上屏 render 结束后，用 `setTimeout(…, 0)` 放到下一个任务里跑。代价从「加载画面晚 100 ms 出现」变成「进度条晚一帧更新」。
  3. 如果资源先到、第一个面板先建好（缓存热，或标签页在后台打开、不出帧），图集就由那个面板按需烘焙，之后的预热调用什么也不做。这跟 ADR-098 之前的行为一样，只是不再提前。
- **不改的**：烘焙仍然记在 `rndMax` 里。iPhone 会话的首个跨度大概率仍是约 100 ms、`rndMaxScene ""` 的这一次，所以 ADR-106 的 `rndMax ≥ 50 ms` 门槛几乎总会触发。读数时要按 `rndMaxScene` 区分；IntroScene 真正的首启卡顿（735–2006 ms）比它大得多，不会被它盖住。
- **核对**：桌面 Chrome 测不到前台路径，因为这台机器上自动化用的窗口一直是 `visibilityState hidden`，不出帧。测到的是后台路径（第 3 条）：第一次上屏发生在年龄门建好之后，预热耗时 0 ms。前台路径的效果，以下次 iPhone 冷启动的 `first_frame` 为准：应比 375–442 ms 小约 100 ms，`rndMaxAt` 应落在 0.4 s 之后。
- **影响**：`client/src/app.ts`；测试 `test/appAssetGateWiring.test.ts`（预热登记在发请求和 `await` 之间；离屏烘焙在 `first_frame` 打点之前就返回；`afterFirstPaint` 在打点之后执行）。文档 `design/game/ANALYTICS_DESIGN.md` §5.1b、`claudedocs/client-render-budget.md` §18。

## ADR-108 兑换码整体移除，奖励改走邮件 — Accepted — 2026-10-04

- **背景**：B-PROMO（META_TASKS.md）让玩家在商店金币页输入一串码换金币。2026-09-29 Apple 以 3.1.1 拒了 build 12（IOS_RELEASE.md §9.2），当时只在 iOS 上把入口藏起来、服务端对 `x-nw-platform: ios` 回 403。其它平台（Web / 微信 / CrazyGames / Android）照旧开着。
- **决策**：全平台移除兑换码，不留开关。理由（用户 2026-10-04）：各平台都不喜欢这种绕过充值拿货币的入口，iOS 拒审只是第一个表态的；要给玩家发奖励，用已有的邮件附件（admin 补偿工单 → 邮件）就够了，而且邮件是逐个账号定向发的，不会被转卖或公开传播。
- **删掉的**：
  - 客户端：金币页的兑换行（输入框 + 兑换按钮）、`ShopSceneCallbacks.redeemPromo` / `openTextInput`（商店里只有它用）、`ApiClient.redeemPromoCode`、`shop.promo*` 五条文案、`promo_redeem` 埋点。
  - metaserver：`POST /promo/redeem`（契约 + 生成路由，93 → 92 个 operation）、`/admin/promo/codes`；`economy/adsPromo.ts` 改名 `adsIap.ts`，`internal/promoGachaRoutes.ts` 改名 `gachaPoolRoutes.ts`。
  - commercial：`PromoService`、`/internal/promo/{redeem,codes}`、`promoCodes` / `promoRedemptions` 两个集合的类型和索引、账号清除里对 `promoRedemptions` 的删除、`PROMO_*` 错误码。
  - admin / shared / ops：`promo.manage` 能力点、`promo.create` 审计动作、发码页和它的 client / service。
  - analyticsvc：`promo_redeem` 事件配置。
- **没动的**：生产库里已有的 `promoCodes` / `promoRedemptions` 文档还在（代码不再读写）；要不要 drop 由用户决定。历史账本行里 reason 为 `promo` 的记录保持原样。
- **影响**：旧客户端如果还画着兑换行，点下去会拿到 404，按通用失败 toast 处理。iOS build ≤ 12 早就不画了，Web 发版即生效。微信本来就没有金币页（`iapKind() === null`），兑换行在那里从来不可见，所以这次移除并没有让微信少一条充值路径。
