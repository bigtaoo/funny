# 客户端 UI — 菜单场景规格（§4）

> 从 [`UI_DESIGN.md`](UI_DESIGN.md) §4 拆出（2026-08-17，原文件 1090 行）。**小节编号沿用原文**，源码里的 `UI_DESIGN.md §4.x` 引用仍然有效。
> 通用原则 / 组件 / 导航 / 网络态见 [`UI_DESIGN.md`](UI_DESIGN.md)；本节的历史变更记录见 [`UI_DESIGN_LOG_2026-06_07.md`](UI_DESIGN_LOG_2026-06_07.md)（§4.9.1、§4.11–§4.28）。

---

## 4. 菜单场景规格

> 以下用竖屏（1080×1920）描述，横屏为左右分栏变体。坐标均为百分比示意。

### 4.1 LobbyScene（大厅，扩展现有）
现状已有：标题栏 / 三 feature 块 / 匹配按钮 / 战役 1-4 选关 / NavBar / VS 遮罩。**扩展**：
- 顶部加 `CurrencyBar`。
- "战役"按钮改为跳 `CampaignMapScene`（替代当前直接 1-4 数字选关；旧选关可保留为 debug）。
- 加「好友对战」入口 → `RoomScene`。
- （S2 后）加「每日奖励」红点入口。
- **匹配按钮氛围装饰（2026-07-05）**：右侧已有淡化交叉铅笔图腾（`heroMotif`，alpha 0.22）；左侧对称加一个随机角色剪影——`build()` 时从 6 个可战斗角色（infantry/archer/shieldbearer + max/lena/mara，复用 `render/UnitView.ts` 同款 `.tao` 骨骼动画包，池子见 `render/heroSilhouette.ts`）随机抽一个，用新增的 `StickmanRuntime.setSilhouette(color)`（`render/stickman/StickmanRuntime.ts`：把每根骨骼贴图的 RGB 乘成纯黑、只留原透明度）渲染成纯黑剪影，同样 alpha 0.22；`update(dt)` 里每 1.6–3.2 秒从该角色的 clip 列表随机切一个动作循环播放，纯装饰不影响任何交互/命中区。
  - **尺寸/居中的三次迭代与最终方案（2026-07-06 定稿）**：横向位置从"贴左边"改为"按钮左边界 → 文字左边界"距离的 1/3 处，此项一直保留。尺寸与垂直居中前两次均失败，根因是**都没量到真正画在屏幕上的像素框**——
    1. 第一次（`0d7f90df`）用 `getLocalBounds()` 二次缩放，方向对但：① 在 `new StickmanRuntime()` 之后立刻测量，此时构造函数只 `play('idle')` 设了动画指针、`_applyPose()` 尚未运行，所有 sprite 仍堆在原点，量出的是乱框；② 框里混进了 shadow；③ 只改缩放没重算居中，仍用"脚=原点"假设。看起来更乱，遂回退。
    2. 第二次（`4cb446fb`）据此判定"`getLocalBounds` 不可靠"，退回纯 `targetHeight / naturalHeight`。但 `naturalHeight` 是**骨骼关节跨度**（`skeleton.ts` `computeNaturalHeight`，只看 FK 关节不看贴图），头/脚/武器超出关节的量每个 rig 都不同 → "六角色大小不一致" + "脚=原点居中"两个原始 bug 原样保留。
    3. 最终方案（本次）：新增 `StickmanRuntime.getRenderedLocalBounds()`——**在姿势已应用、排除影子（新增构造参数 `showShadow:false`）、跨所有 clip 全部关键帧取并集**的前提下测量真实渲染像素框；再经纯函数 `render/fitToBox.ts` `fitContentToBox(bounds, box, 0.90)` 拟合：渲染高度 = 按钮高度的 **90%**，且缩放与居中**全部基于实测框、绝不假设原点**，故六角色同高且真正上下居中于黑色按钮框内。拟合数学有单测兜底 `test/fitToBox.test.ts`（含"原点两侧不对称溢出仍 90%+居中""不同框同高"两条针对上述回归的断言）；`getRenderedLocalBounds` 对真实 `.tao` 的测量需真 PIXI 渲染器，本项目 node 测试环境 mock 掉了 PIXI，故该半仅靠 webpack 构建 + 肉眼确认。

- **标题栏改双行（2026-07-11）**：原单行标题栏把「左上头像 chip + 居中 logo+品牌标题 lockup + 右上登录/段位 chip」全挤在同一水平带，品牌 lockup 比左右两 chip 之间的空隙宽，在窄竖屏（1080 设计宽）下会左右裁切/压到两侧 chip——高瘦屏动态设计高度把按 `h` 缩放的字号进一步放大后更明显。改为上下两带：**上带 chipBandH=`h*0.16`**（头像 chip + 账号 chip，几何与旧单行完全一致）+ **下带 brandRowH=`h*0.09`**（居中 logo+品牌标题+副标题，独占一行不与 chip 争水平带）；品牌 lockup 只在超过宽度 90% 时才缩放（`title.scale`），故任意宽度都不裁边。深色标题栏背景高度 = 两带之和；下方主内容栈起点 `usableTop=tbH` 随之下移，用回竖屏多出来的纵向空间。见 `LobbyScene/build.ts`。
- **双行仅限竖屏（2026-07-11 修正）**：上述两带改造起初**无条件对所有朝向生效**，导致横屏（空间充裕、单行本就成立）也被套上两行——logo 从 `tbH*0.9` 缩到 `brandRowH*0.9`（约小 44%）、品牌带下沉、标题栏更高，属回归。现按 `layout.orientation` 分支：**横屏走原单行**（`chipBandH===tbH`、logo `tbH*0.9`、中线 `tbH*0.45`，与两带改造前逐值一致），**竖屏走两行**。几何计算抽成 PIXI-free 纯函数 `LobbyScene/format.ts` `headerMetrics(w,h,portrait)`，单测 `test/lobbyHeader.test.ts`（横屏单带、横屏还原大 logo、竖屏两带、竖屏取舍 4 例）。教训：竖屏专项修复必须按朝向分支，勿无条件套到横屏。
- **竖屏两带顺序对调 + 身份信息并排（2026-08-09）**：产品反馈竖屏头部"logo 该单独置顶，头像/金币/排行该并排"。改动仅限 `portrait` 分支，横屏不变：
  1. **两带顺序对调**：`headerMetrics()` 现在**品牌带（logo+标题）在上、身份 chip 带在下**（此前反过来）。新增 `chipBandY` 字段（横屏恒为 0，竖屏为 `brandRowH`）供 `build.ts` 定位身份带；身份带本身从 `chipBandH=h*0.16` 收窄到 `h*0.12`——金币/排行不用再竖着叠两小行，收窄的高度让给了下面的英雄按钮。
  2. **金币/排行改并排**：原来堆在右上角的两个 chip（金币在上、排行在下，`0.26/0.70` of `chipBandH`）改成**同一行左右并排**，右对齐到与账号 chip 一致的右边距（`w-w*0.04`），互不重叠；头像+名字仍在同一行左侧。横屏因为要跟居中的 logo+标题共用一条带、宽度富余，**继续保留原来的竖直堆叠**，未改。
  3. **英雄/pillar 按钮借用收窄出的高度略微放大**：`heroH` 竖屏 `h*0.165→0.175`、`pillarH` 竖屏 `h*0.155→0.165`（横屏不变）；内容区宽度 `fullContentW` 竖屏 `w*0.90→0.93`（横屏仍 `0.82`），三个大按钮实际更宽更高一点，但左边距计算方式不变（仍是左对齐）。右侧 Daily/Mail/Feedback/拍卖行四个小条本来就与内容区左边距对称右对齐，未再改。
  几何全在 `LobbyScene/format.ts`（新字段单测见 `test/lobbyHeader.test.ts`）+ `LobbyScene/build.ts`（身份带按 `this.portrait` 分岔出并排 vs 堆叠两套绘制），行为回归见 `test/ui/scenes.ui.ts` 的 `LobbyScene — identity chip row` / `LobbyScene — hero/pillar button size follows orientation` / 更新后的 `content column width follows orientation`（竖屏预期改成 93%）。
- **LoginScene 离线提示换行（2026-07-11）**：`auth.offlineHint`（EN/DE 较长，monospace 下超 1080 设计宽）改用 `txt(..., wordWrapWidth=w*0.86)` + 居中对齐，两行排版，不再左右裁切。
- **账号 chip 配色/间距修正（2026-07-19）**：右上角金币 chip 与段位 chip 用户反馈"配色突兀、贴太近"——两者本是不同信息（金币 vs 天梯段位+积分），此前段位徽章却用纯白 `C.light` 文字+边框、无图标，视觉上不成一套。新增 `LobbyScene/base.ts` 的 `TIER_COLORS`（按 `pvp.rank` 取色：unranked 灰、bronze/silver/gold/platinum/diamond/master 各自色），段位 chip 边框+文字改用该色，并加奖杯图标（`buildIcon('trophy', ...)`）与金币图标对称；两 chip 垂直间距从 `chipBandH*0.26/0.58` 拉开到 `0.20/0.74`。见 `LobbyScene/build.ts`。

#### 4.1.1 右侧竖条：成就入口 → 反馈入口（2026-08-04）

右侧竖条（`Daily / Mail / Events / Achievements`，§3 导航结构一节，`onOpenAchievements` 回调，`build.ts` 的 `hasAchieve`/`achieveStripRect`）使用率低，替换为**游戏内反馈入口**（`onOpenFeedback`），常驻可用、不设任何前置条件：

- **视觉**：复用原成就格的位置/尺寸/交互（`achieveStripRect` 重命名为 `feedbackStripRect`，strip tag 由 `'achieve'` 改 `'feedback'`），标签沿用其它格子的短文字风格（`t('lobby.strip.feedback')`），不新增图标图集。不设红点（无"未读"概念，提交即结束，无需玩家再次关注）。
- **面板**：点击后打开 `FeedbackDialog`（`client/src/ui/dialogs/FeedbackDialog.ts`）——一个 stage 级覆盖层（zIndex 9000，不经 SceneManager，不打断当前场景），结构复用 `AppealDialog` 的隐藏 `<input>` 文本采集技术：标题 + 说明文案 + 三行高输入框（镜像显示自动换行，见下方 2026-08-08 条目）+「提交」/「关闭」按钮。触发走 `net/log.ts` 新增的 `setFeedbackSink`/`requestFeedbackDialog`（与既有 `AppealPrompt` 同一 sink 模式，让 `nav/lobby.ts` 不必引入 PIXI 依赖）。提交成功后**不关闭面板**，原地清空输入框并提示「已收到，谢谢」，允许再次提交（不限制"只能提交一次"）。
- **输入框统一 + 3 行高度（2026-08-08）**：用户反馈"点击输入框没有光标显示，应该用统一的输入框；高度加大到至少三行"。原实现只是把 `feedbackText` 直接塞进 `feedbackLabel.text`，没有接入项目已有的统一光标闪烁约定（`ui/inputDisplay.ts` 的 `caretDisplay()`，`SettingsScene` 改名字段等多处在用）。改为：聚焦时 `caretDisplay(text, active&&caretOn, placeholder)` 追加闪烁 `|`（0.5s 周期，`update(dt)` 驱动，与 `SettingsScene` 同一节奏），有字/闪烁时文字色 `C.dark`、纯占位态 `C.mid`；输入框高度从单行 `0.13×unit` 改为 `padY×2 + lineHeight×3`（约 `0.2×unit`），标签从垂直居中改为顶部对齐，随文字向下填充，效果与其它段落字段一致。
- **反馈/申诉弹窗关闭后落地页错乱（2026-08-08 修复）**：用户反馈"点击关闭没有回到大厅，有时落在关卡，有时落在 SLG"。根因：`FeedbackDialog` 是绕过 `SceneManager` 直接挂在 `app.stage` 的覆盖层（见上）,只在大厅可打开，但大厅仍在监听后台推送（好友/系统发起的对战 `onMatchStart`）与异步分服解析（`resolveWorldShard`，最长 3s 窗口，`onOpenWorld` 快速二次点反馈可撞上）；这些都会无条件调用 `SceneManager.goto()` 直接换场景，而反馈弹窗对此完全无感——用户在弹窗里打字的这段时间背后场景已经悄悄换成关卡/SLG，点「关闭」揭开的自然就是换后的新场景，而不是原来的大厅。修复：`SceneManager` 新增 `DialogGate`（`goto()` 一开始就调用 `dialogGate.close()`，与既有"硬切场景=甩掉 overlayScene"同一套逻辑，只是延伸到它看不到的 stage 级弹窗），`app.ts` 把 `closeFeedbackDialog` 接进去——背后一旦真的换场，弹窗立刻可见地消失（哪怕正在打字），不再等到手动关闭才暴露"猜出来"的落地页。**故意没有**同样接 `AppealDialog`——申诉弹窗的设计前提就是"可能从任意场景触发、不该被换场打断"（见其文档注释），接了反而会在被封禁玩家正填申诉理由时把内容冲掉，风险大于收益。
- **光标一直是实心竖线、不闪烁（2026-08-08 修复）**：用户反馈"点了输入框，光标没有闪烁，一直就是一条竖线"。根因不在 `caretDisplay()`/`update(dt)` 本身（§上条已验证按 0.5s 周期切换 `caretOn` 逻辑正确），而是**根本没人调用它**：`FeedbackDialog`（和 `AppealDialog`）是绕过 `SceneManager` 直接挂在 `app.stage` 的覆盖层（同上条根因），`SceneManager.onTick` 只驱动它自己管理的 `current`/`overlayScene`，从不知道这两个游离的舞台级弹窗存在；`app.ts` 里创建它们后也没有另起一个 ticker 去驱动，`FeedbackDialog.update()`（闪烁计时器所在处）因此是死代码，从未被调用过——光标永远停在 `openInput()` 那一帧的初始状态（`caretOn=true`），看起来就是一条不会闪的实心竖线。修复：`app.ts` 补一个 `app.ticker.add(...)`，仿照 `GlobalToast.tick()` 已有的"舞台级覆盖层自驱动"写法，逐帧调用 `feedbackDialog?.update(dt)`（连带 `appealDialog?.update()`，它目前是 no-op，但同样接上以防将来长出计时器又被漏挂）。验证：无法用真实后端跑通整条登录链路截图（本机 Browser 面板对该 WebGL 页面持续 "not displayed" 不合成帧，另见 `claudedocs`/记忆里对此问题的多次记录），改用临时 headless 单测直接复刻 `app.ts` 这行接线（`new PIXI.Ticker()` + 同样的箭头函数 + 真实 `setTimeout` 推进 wall-clock）驱动真实 `FeedbackDialog` 实例，断言 `openInput()` 后光标在场（同步，不依赖 ticker）→ 真实经过 0.5s+ 的 tick 后光标必须已经闪烁掉（证明接线生效）；对照组（不挂 ticker，纯等 0.6s）复现"光标永远不变"的原 bug 现象。验证通过后按用户"加测试"要求转成两层永久覆盖（临时文件删除）：① `client/test/ui/caretRegression.ui.ts` 追加一例，把上面验证用的"真实 `PIXI.Ticker` + 真实 wall-clock"搬进永久测试，证明"照 `app.ts` 这个形状接线，光标确实会闪"；② 新增 `client/test/appTickerDialogWiring.test.ts`（纯源码文本扫描，仿照既有 `input-subscription-cleanup.test.ts` 的静态防护写法）——因为①测的是"接上了就会闪"，并不能证明 `app.ts` 真的接了；`startApp()` 需要真实 canvas/后端整链路，没有可行的端到端单测入口（见 `HeadlessPlatform.ts` 注释：它替 `createAppCore` 跑，不替 `app.ts` 这层 PIXI shell 跑），只有靠扫描 `app.ts` 源码断言 `app.ticker.add(...)` 块里确实同时调了 `feedbackDialog?.update(`/`appealDialog?.update(` 才能在有人日后删掉这行接线时报警；本地手动删掉该接线验证过这个新测试真的会红、加回后变绿。`tsc --noEmit` + `caretRegression.ui.ts`（27 例）/`sceneManager.ui.ts`（20 例）/新文件（3 例）全绿。用户追加"加测试"（要求补更多角度）后再补三例（同放 `caretRegression.ui.ts`，新开一个 describe）：③ `AppealDialog.update()`（零参、目前 no-op）接进同款真实 Ticker 跑三帧，断言不抛——它此前只被①的静态扫描覆盖过，从没被真实 tick 驱动验证过；④ 模拟 `closeFeedbackDialog()` 的真实关闭顺序（`dlg.destroy()` 再把外层 `let feedbackDialog` 置 `null`）后，同一个（`app.ts` 里只注册一次、永不移除的）ticker 回调继续跑 5 帧不能抛——覆盖"关闭后 ticker 还在跑"这个生产环境里真实存在但此前完全没测过的时序；⑤ 模拟 `setFeedbackSink()` 的重新赋值（先以 `null` 起步跑几帧确认是无害 no-op，再把新建的 `FeedbackDialog` 实例赋给同一个外层变量），验证新实例照样能被同一个已注册的 ticker 回调驱动闪烁——因为回调闭包捕获的是外层 `let` 变量本身而不是某个固定实例，这一点在①③④都只用一个实例贯穿始终的写法下从未被验证过。`caretRegression.ui.ts` 累计 30 例，全绿。
- **测试覆盖（用户要求"全部加测试"，2026-08-08）**：两处改动都补了 headless PIXI 冒烟层（`npm run test:ui`）——① `client/test/ui/caretRegression.ui.ts` 新增 `FeedbackDialog` 一整个 describe 块（7 例）：未聚焦不出光标、`openInput()`（模拟点击）后空值/有字两种状态下的闪烁、`update(dt)` 按 0.5s 周期驱动闪烁（同 `SettingsScene` 节奏）、未聚焦时 `update(dt)` 是纯 no-op、模拟 blur 后光标消失且之后的 `update()` 不会复活、输入框高度回归（`feedbackLabel.style.lineHeight` 从此前未设置的 0 变成一个正数本身就是"box 按行高重新量过"的信号；再断言 `statusLabel.y - feedbackLabel.y` 这段可见跨度 ≥ 3×行高，不用额外导出内部 `inputH` 字段）；② `client/test/ui/sceneManager.ui.ts` 新增 `DialogGate` 一整个 describe 块（5 例）：即时 `goto()` 触发一次 `close()`、`{fade:true}` 请求下 `close()` 立即触发（不等淡入完成才触发）、fade 中途被二次 `goto()` 改道时 `close()` 每次调用各触发一次、`pushOverlay`/`popOverlay` 完全不触碰这个 gate（scope 只在硬切换，不含 SLG 面板开合）、不传 `dialogGate`（原有调用方式）依然正常工作不抛错。两个文件跑通均需 worktree 内单独对 `server/` 执行一次 `npm install`（`@nw/shared` 的 vitest alias 指到 `server/shared/src`，其 `jwt.ts` 依赖 `jsonwebtoken`——见 `claudedocs/worktrees.md` 的 workspace 陷阱条目），`npm run typecheck`/`npm run test:ui`/`npm test` 全绿。
- **点击穿透到大厅（2026-08-09 修复）**：用户反馈"竖屏下点反馈弹窗仍会穿透到背后大厅"（此前 2026-08-08 那轮修复只覆盖了光标闪烁/关闭落地页，没碰这个）。根因：`build()` 里遮住全屏、本该挡住大厅点击的半透明 `dim`（`PIXI.Graphics`，紧跟纸面背景之后第二个 child）从落地起就没设过 `eventMode`/`hitArea`，PIXI 默认不对它做命中测试——点在 `dim` 上（卡片之外的任意位置）的 tap 直接穿透到 `app.stage` 上仍在运行的 Lobby。这个缺陷本身与横竖屏无关（`build()` 唯一的 `landscape` 分支只决定卡片尺寸，从不碰命中测试），只是横屏时卡片背后那片区域恰好没有可点控件、竖屏时正好挡在 Lobby 底部导航前面，才让穿透在竖屏被点出来。修复：给 `dim` 补 `eventMode = 'static'` + `hitArea = new PIXI.Rectangle(0, 0, w, h)`，与 `SceneManager.showOverlay()` 现成的"吞掉淡入淡出期间点击"套路完全一致。`AppealDialog`/`ConsentDialog`/`ReconnectPromptDialog` 这几个同款"自绘全屏遮罩弹窗"目前共享同一个写法缺陷，本次未动——按用户这次反馈的范围先只修 Feedback，其余留待下次一并核对。测试：`client/test/ui/caretRegression.ui.ts` 新增一个 describe（横屏 1280×800 / 竖屏 800×1280 各一例），断言 `dim.eventMode`/`dim.hitArea` 覆盖整个画布；临时回退修复验证过两例确实先红后绿。`tsc --noEmit`/`npm run typecheck`/`npm run test:ui`（该文件 32 例）全绿。
- **同族弹窗排查（2026-08-09，用户要求"其他的也都检查一下"）**：上条留的尾巴——排查 `AppealDialog`/`ConsentDialog`/`ReconnectPromptDialog` 这三个同款"自绘全屏遮罩弹窗"（`dim`+卡片，`app.ts` 分别用 `import` 名定位）。结论不完全一致：
  - **`AppealDialog`**：和 `FeedbackDialog` 一样是真实存在的穿透漏洞——`app.ts` 把它直接 `app.stage.addChild(dlg.container)`（第 552 行），与 `SceneManager` 当前管理的场景（可能是任意场景，因为它由网络层 `ACCOUNT_BANNED`/`ACCOUNT_MUTED` 错误从任意调用点触发，不限于大厅）**同时挂在舞台上**，`dim` 不拦截命中测试意味着背后那个场景自己的输入照样能被点到。同款修复：`dim.eventMode='static'` + 全屏 `hitArea`。
  - **`ConsentDialog`/`ReconnectPromptDialog`**：走的是 `manager.goto()`（`app.ts` 145/150 行），不是舞台级独立覆盖层——`SceneManager`（见其类注释）保证"never keeps two scenes mounted at once"，且淡入淡出期间的输入是在 `InputGate`（DOM 事件源头）层面整体挂起，不经过 PIXI 命中测试，所以**目前没有另一个活着的场景可供穿透**，`dim` 缺 `eventMode` 现状下不构成真实可利用的 bug（`ConsentDialog` 文档注释本就写明"backdrop tap does NOT dismiss"，没挂处理器时点了也确实什么都不会发生）。仍然按同款写法补上 `eventMode`/`hitArea`，是**防御性**修复：与 Feedback/Appeal 两个兄弟保持一致，防着日后有人把它们从 `goto()` 改造成 `pushOverlay`/舞台级覆盖层时，这个漏洞跟着复活却没人想起来查。
  - 确认排除在外、且理由记录下来避免以后又被重新怀疑的两个近似写法：**`ProfilePopup`**——虽然也是"全屏 dim + 卡片"，但它从落地起 `dim` 就设了 `eventMode='static'`（还接了 `pointertap` 关闭），本就是这条模式该有的样子；**`confirmDialog.ts` 的 `drawConfirmDialog`**（FamilyScene/SectScene/EquipmentScene/AuctionScene/FriendsScene 共用的 OK/Cancel 弹窗）——这些宿主场景用的是自定义 `InputManager` 广播式派发，不经 PIXI 原生事件系统，各自在派发前先查 `this.modalOpen` 拦下所有其它点击（`FamilyScene/base.ts` 393/447 行等），命中测试从一开始就发生在 JS 逻辑层而非 PIXI 层——给 `dim` 加 `eventMode` 对这套输入管线毫无意义，真正的"锁"从来就是 `modalOpen` 这个标志位，且它已经存在且工作正常，未改动。
  - 测试：`caretRegression.ui.ts` 原先只测 `FeedbackDialog` 的 describe 扩成四个子 describe（Feedback/Appeal/Consent/Reconnect），横竖屏各一例，共 8 例（累计 38 例）；临时回退 Appeal/Consent/Reconnect 三处修复验证过对应 6 例先红（Feedback 2 例本就还是红/绿都测过一轮，见上条），加回后全绿。`tsc --noEmit`/`npm run typecheck`/`npm run test:ui` 全绿。
- **点击穿透（真正的根因，2026-08-10 修复；同一现象的第三次报修）**：用户反馈"打开并发送一次反馈，再次打开后直接点关闭，没有退回大厅，而是退回到更早时的界面"。前两轮修复（2026-08-08 的 `DialogGate`、2026-08-09 的 `dim.eventMode`）都没修到点子上：
  - **根因**：`dim` 补的 `eventMode`/`hitArea` 只挡得住 **PIXI 原生命中测试**，而这恰恰是次要通路。Lobby 的所有点击走的是 `InputManager` 广播式派发（`LobbyScene/base.ts` 的 `input.onDown(...)` → `build.ts` 的 `handleDown(x,y)` 按矩形自己分发），事件由 `WebAdapter` 从 **DOM 监听器直接喂进来、完全不经过 PIXI**——任何 display object 都拦不住它（`InputManager.suppressed` 的注释早就写明了这一点，`SceneManager` 的淡入淡出正是因此才要在源头挂起输入）。而 `FeedbackDialog`/`AppealDialog` 是舞台级覆盖层，底下那个场景**依然活着、依然订阅着 `InputManager`**。结果：点弹窗自己的控件，同一个坐标上的 Lobby 命中矩形也照样被触发。重叠是精确且可复现的（新测试里逐一钉死）：输入框正压在**开始对战大按钮**上、「提交」压在**战役柱**上、「关闭」压在**世界地图柱**上，横竖屏皆然。所以点「关闭」实际同时触发了 `onOpenWorld()` → `nav.goWorldEntry()` → `goto()` → `DialogGate` 顺手关掉弹窗，玩家看到的就是"关闭后落在 SLG/战役，而不是大厅"。（2026-08-09 那轮排查其实已经写到"这套广播式派发不经 PIXI、真正的锁是 `modalOpen` 标志位"——见上条最后一点——但只针对场景内的 `confirmDialog` 讨论，没意识到舞台级弹窗底下的 **Lobby 自己**就是那个"没上锁的宿主场景"。）
  - **为什么"发送过一次之后"才容易撞出来**：第一次点关闭撞到的可能是首次功能引导层（`guideLayer`，任意一点先吞掉）或世界柱的软门槛提示（`worldLocked` → 只弹气泡不换场），场景没换，看起来"正常回到大厅"；引导消失后再点同一个位置才真的换场。这也解释了为何前两轮按"关闭时机/命中测试"去查都对不上。
  - **修复**：在输入源头加一道与淡入淡出（`suppress`）互不干扰的**模态闸门**——`InputManager` 新增 `holdForModal(on)`（内部 `modals` 计数，`_emitDown/_emitMove/_emitUp/_emitWheel` 一律在 `modals>0` 时直接丢弃），`app.ts` 在挂载/销毁两个舞台级弹窗时各抬起/放下一次。计数而非布尔：申诉弹窗可能压在已打开的反馈弹窗之上，先关掉的那个不能把闸门整个放掉；与 `suppressed` 分开两个字段：两道闸门谁也不能把对方清掉。弹窗自己的按钮是纯 PIXI `pointertap`，闸门碰不到。`AppealDialog` 一并接上（它能出现在**任意**场景之上，穿透面更大）；`ConsentDialog`/`ReconnectPromptDialog` 走 `manager.goto()`，旧场景已被销毁并退订，天然无此问题。为保证"每次打开只放下一次"，`AppealDialog` 的内联 teardown 也抽成 `closeAppealDialog()`，与 `closeFeedbackDialog()` 一样带 `if (!dlg) return;` 早退（后者还会被 `DialogGate` 在每次 `goto()` 时重复调用）。
  - **测试**（用户要求"加测试"后补到 25 例，分两个文件）：
    - ① `client/test/ui/dialogModalInputGate.ui.ts`（新增，20 例），四层：
      - **单点重叠（横竖屏各 3 例）**：真实 `LobbyScene` + 真实 `InputManager` 订阅 + 真实 `FeedbackDialog`，先钉死"没有闸门时三个控件分别撞到 `onStartRanked`/`onOpenCampaign`/`onOpenWorld`"（bug 本身；写死具体入口名，日后 Lobby 布局挪动导致重叠消失时这个测试会红、逼人重读，而不是悄悄空转），再断言抬闸后三次点击一个都不落到 Lobby、放闸后恢复。
      - **报修流程端到端（横竖屏各 2 例 + 3 例）**：把生产接线整套搭出来——真实 `SceneManager`（含 `DialogGate`/`InputGate`）+ 大厅回调真的 `goto()` + `app.ts` 那对 sink/close helper——原样重放"打开→点输入框→输入→提交→关闭→再打开→关闭"，断言全程 `fired` 为空、最后仍停在 Lobby；**每例都配一个反向对照**（`gated:false` 的修复前构建），断言同一串操作在修复前第一下点输入框就已经 `onStartRanked` → `goto()` → `DialogGate` 顺手关掉弹窗、根本走不到提交。另加三个失败模式：背景换场（好友对战推送/分服解析）经 `DialogGate` 关掉弹窗时**必须把闸门放下**（否则整个游戏对点击永久失聪，比原 bug 更糟——用"换场后新挂一个真实 Lobby 再点一次"来证明）、手动关闭后背景换场**不能重复放闸**（覆盖 `if (!dlg) return;` 早退；此时若另有模态压着会被误放）、闸门**不影响弹窗自身控件**（提交/关闭走 PIXI `pointertap`，抬闸期间照样生效）。"点一下"在这里同时发两条通路（`InputManager._emitDown` + 该 display object 的 `pointertap`）——只驱动其中一条正是此 bug 熬过前两轮修复的原因。
      - **`AppealDialog`（横竖屏各 1 例）**：它由传输层从**任意场景**触发（不像 Feedback 只在大厅），穿透面更大；用一个订阅 `onDown/onMove/onUp` 的桩场景代表 `src/scenes` 下约 20 个同样广播订阅的场景，同样先证明无闸门时三个控件全部漏过去，再断言抬闸后一个都不漏。
      - **`InputManager` 闸门语义（6 例）**：move/up/wheel 一并拦、计数（申诉压在反馈之上时先关的那个不能整个放闸）、不会被多余的 `false` 拉成负数、与 `suppress` 双向互不影响、模态不触发 `suppressedDownHook`（模态不是淡入淡出，没有可中断的转场）。
    - ② `client/test/appDialogInputGate.test.ts`（新增，5 例，纯源码扫描，理由同 `appTickerDialogWiring.test.ts`：`startApp()` 需要真实 canvas/后端整链路，没有可行的端到端单测入口）——两处 `holdForModal(true)`、两个 teardown helper 里各有 `holdForModal(false)` 且都带早退、两个弹窗的 `onClose` 确实走 helper，外加两条前瞻性守卫：`app.stage.addChild(` 的次数必须与 `holdForModal(true)` 相等（日后再挂第三个交互式舞台级弹窗而忘了接闸门时报警），以及 `app.ts` 不得直接碰 `input.suppress(`（那是 `SceneManager` 淡入淡出专用的另一道闸门，混用会互相清除）。
    - **红/绿验证**：临时把 `InputManager` 的 `modals` 判断去掉，20 例里 12 例转红（其余 8 例是刻意写的对照/前置断言，本就该两边都绿）；临时删掉 helper 里的 `holdForModal(false)`，"背景换场必须放闸"那例单独转红；两次都改回后全绿。截图验证仍不可行（Browser 面板对该 WebGL 页面持续 "not displayed" 不合成帧，同 2026-08-08 条目记录）。`tsc --noEmit`/`npm test`（1275 例）/`npm run test:ui`（1403 例）全绿。
- **`ConsentDialog` 正文溢出屏幕（2026-08-11 修复）**：用户反馈首屏隐私弹窗正文文字左右都穿出屏幕，不换行。根因与上面几条"同族弹窗"缺陷是另一类——`body` 的 PIXI 文字样式只设了 `wordWrap: true`，没配 `breakWords: true`。PIXI 的 `TextMetrics.wordWrap` 按空白/换行分词（`tokenize`），中文这段正文全是全角标点、零空格，整段被当成**一个 token**；`canBreakWords()` 直接返回 `style.breakWords`（默认 `false`），token 本身宽度超过 `wordWrapWidth` 时不会被拆，直接整行吐出——纯 CJK 长段落场景下 `wordWrap:true` 单独存在等于没生效。这不是本次才引入的回归：`consent.body` 文案与该样式从功能落地起就没变过，只是此前没在这个卡片宽度下测出来。仓库里其它所有包中文的 `wordWrap` 调用点（`DailyScene`/`ChatScene`/`LevelPrepScene`/`FriendsScene/mail.ts`/`sketchUi.ts`）都早已配对 `breakWords: true`，`ConsentDialog` 是唯一漏掉的一处。修复：补上 `breakWords: true`。测试（用户要求"加测试"）：新增 `client/test/ui/consentDialogWrap.ui.ts`（headless PIXI 层，4 例）——用 zh locale（其 `consent.body` 恰好零空白，是复现条件本身）构造真实 `ConsentDialog`，断言 body 样式 `breakWords===true`，并直接跑 `PIXI.TextMetrics.measureText` 断言真实换行结果确实拆成多行、每行宽度不超过 `wordWrapWidth`（横屏 1280×800、竖屏 375×812 各一例）。临时改回缺 `breakWords` 验证过 4 例里 3 例先红（`expected 1 to be greater than 1` 等），加回后全绿；`tsc --noEmit`/`npm run test:ui`（155 文件/1409 例）全绿。
- **`FeedbackDialog` 正文/输入回显溢出屏幕（2026-08-30 修复）**：用户反馈弹窗说明文字左右都穿出背景卡片，与 2026-08-11 条目里 `ConsentDialog` 那次是同一类缺陷——`body` 的 PIXI 文字样式只设了 `wordWrap: true`，没配 `breakWords: true`，中文 `feedback.body` 全是无空格连续汉字，被当成一个 token，超宽不拆直接吐出整行。排查时顺带发现第二处同款遗漏：输入框里镜像玩家输入的 `feedbackLabel`（含 placeholder）同样只设了 `wordWrap`，没设 `breakWords`——玩家打一长串无空格中文反馈时，回显文字会同样冲出输入框，只是没在截图里报出来。两处一并补 `breakWords: true`。测试（用户要求"加测试"）：新增 `client/test/ui/feedbackDialogWrap.ui.ts`（headless PIXI 层，5 例，同 `consentDialogWrap.ui.ts` 写法）——zh locale 下断言 `feedback.body`/`feedback.placeholder` 零空白（复现前提）、对话框里恰好两个 `wordWrap` 节点且都 `breakWords===true`；由于该 headless 环境的 `measureText` 是按字符数线性估算（非真实字形宽度），`feedback.body` 本身较短，在两种测试视口下不足以触发换行，故换行断言改用「该节点的真实 `style` 对象 + 构造的超长无空格 CJK 串」去跑 `PIXI.TextMetrics.measureText`（横屏 1280×800、竖屏 375×812 各一例，另加一例模拟玩家真的在输入框里打长文字后 `refreshLabel()`），断言确实拆成多行且每行不超 `wordWrapWidth`——这样测试锚定在活的 `style` 对象上，日后谁再删掉 `breakWords` 会直接测红，不依赖某句文案恰好够长这个偶然条件。临时去掉两处 `breakWords: true` 验证过对应 4/5 例先红，加回后全绿；`tsc --noEmit` 全绿。
- **成就墙访问路径不受影响**：成就墙本就还能通过 Career hub（`StatsScene`/`TitlesScene`/`CardCodexScene` 共享的 `CareerTabs`）以及成就解锁 toast（`build.ts` 的 `toastRect` 点击直达）访问，拿掉这一个侧栏入口不影响可达性。
- **接口**：`POST /feedback`（见 [`SERVER_API.md`](SERVER_API.md) §2.13），提交中禁用按钮防重复点击；失败（限流/网络）原地提示失败原因，不清空输入内容（方便重试）。
- **测试覆盖**（用户要求"全部加测试"后追加，2026-08-05）：落地时只有 `server/metaserver` 的 `feedback.e2e.test.ts`（7 例）+ `pve.e2e.test.ts` 的欢迎邮件一例；本次补齐此前完全无覆盖的三层——① `client/test/feedback-prompt.test.ts`（7 例）：`net/log.ts` 的 `setFeedbackSink`/`requestFeedbackDialog` sink（含"无 sink 已注册"/"sink 抛异常被吞"）、`ApiClient.submitFeedback`（`POST /feedback` 请求体 + 429 等错误透传）、`createAppCore().submitFeedback`（离线为 `undefined`／在线委托 `ApiClient`），镜像既有 `appeal-prompt.test.ts` 对申诉功能的覆盖方式；② `client/test/lobby-feedback-nav.test.ts`（2 例）：`nav/lobby.ts` 的 `onOpenFeedback` 只在 `online` 时才挂上（与 `onOpenAchievements`/`onOpenAuction` 同一门槛），点击触发 `analytics.click('lobby.feedback')` + sink；③ `server/admin`：新增 `test/feedback.e2e.test.ts`（5 例，镶 `FeedbackMixin.listFeedback` 代理/审计/503/`limit` 转发/`feedback.view` 角色矩阵，`contentModerationBridge.e2e.test.ts` 同款写法），并修了 `test/clients-barrel.test.ts` 漏掉的 `HttpFeedbackClient`（barrel 已导出但守卫列表没跟上，功能本身没问题，纯测试盖口）；同时给 `server/metaserver/test/feedback.e2e.test.ts` 补 3 例（未登录 401、`X-NW-Platform` 头透传/缺省两种 `clientPlatform` 落库情况），`pve.e2e.test.ts` 补 1 例（见 [`ONBOARDING_DESIGN.md`](ONBOARDING_DESIGN.md) §5.1 的邮件 best-effort 一例）。PIXI 强耦合的 `build.ts` 侧栏渲染/命中区（`feedbackStripRect` 改名、tap 分发）沿用既有约定未加专项单测——项目里同类渲染逐字段布局代码历来只在 `badges.ts` 这类轻量文件上做过 mock 覆盖，`build.ts` 本身的资源依赖图很重，性价比低，未纳入本次范围。

### 4.2 RoomScene（好友房，S1）
```
┌──────────────────────────────┐
│  ← 返回         好友对战        │  标题
├──────────────────────────────┤
│   ┌────────┐    ┌────────┐    │
│   │ 创建房间 │    │ 加入房间 │    │  两大按钮（idle 态）
│   └────────┘    └────────┘    │
├──────────────────────────────┤
│  房间码:  [ A 7 K 9 ]  📋复制   │  建房后显示
│                                │
│  房主: 你          ✓ ready     │  双方槽位
│  对手: (等待加入…) ○            │
│                                │
│        [ 准备 / 开始对战 ]       │  双方 ready 后房主可开
└──────────────────────────────┘
加入态：输入 4 位房间码（数字键盘/字母）→ 连接中 spinner → 进房
```
- 状态机：`idle → creating/joining → in-room(waiting) → both-ready → countdown → GameScene`。
- 网络态：连接中 spinner、加入失败（房间不存在/已满）Toast、对手掉线提示。
- i18n：`room.*`。

### 4.3 ShopScene（商店，S2）
```
┌──────────────────────────────┐
│ ← 返回   商店      💰 1,250 ＋  │  CurrencyBar
├──────────────────────────────┤
│ [皮肤] [道具] [盲盒] [充值]     │  分类 Tab
├──────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐    │
│ │ 皮肤A │ │ 皮肤B │ │ 道具C │    │  商品网格（ScrollList）
│ │ rarity│ │       │ │       │    │  RarityFrame 描边
│ │ 💰 300│ │ 💰 500│ │ 💰 80 │    │  价格；已拥有显示"已有"
│ └──────┘ └──────┘ └──────┘    │
└──────────────────────────────┘
点商品 → Modal 购买确认（预览 + 价格 + 余额够否）→ 服务器扣币 → Toast + 余额刷新
余额不足 → Modal 引导去「充值/看广告」
```
- 商品来自服务端 `shopItems`；购买走 `EconomyClient`（服务器权威，§META S2-2）。
- i18n：`shop.*`。
- **充值码 overlay**：Canvas 画伪输入框，背后挂隐藏 `<input>` 捕获键盘。光标用 `|` 以 0.5s 交替闪烁；空输入时光标-on 显示 `|`、光标-off 显示 placeholder，确保聚焦即可见光标（不依赖已有字符才显示）。
- **充值档位图标**：每档左侧画随金额升级的宝藏图标（`coin`→`coins`→`coinStack`→`coinSack`→`coinChest`，见 `render/icons.ts`），越贵越有料，替代千篇一律的 `◎` 文字提升转化诱惑。手绘 SketchPen 笔触 + 金币扁平淡金填充（守三笔风、无渐变），走 `buildIcon` 贴图缓存。
- **充值档位金币数量字号**：卡片内「图标+金币数」是转化关键信息，字号 `ch*0.20`（`drawCard` 内 `coinAmount` 分支）；改版后随标题一起收进右上角「右对齐纵向列」（badge → 金币数+图标 → 元价），不再与标题同一行水平排列——标题改左侧、超宽自动换行（`txt()` 新增 `wordWrapWidth` 参数），避免长标题挤压价格列。赠送量（`+N`）等副行仍在下方 icon 右侧。
- **卡片竖向布局改「按剩余空间反推」，杜绝 icon/文字压中按钮（2026-07-06）**：`drawCard` 曾用写死的 `ch` 比例摆放 icon 和加成文字行（`y+ch*0.30` 起、每行 `ch*0.14`），跟底部 Buy 按钮的位置无关；充值档位卡同时要塞标题+金额+icon+2 行加成文字（`+N` 与"首充双倍"——后者按 `ECONOMY_BALANCE.md` 规定所有档位常驻，非 bug），内容总高超过卡片高度，icon 和第二行文字会压进/被 Buy 按钮挡住。改法：先算按钮占的 `btnH/btnY`，再用 `midTop`（标题/右侧列结束处）到 `midBottom`（按钮上沿留白）之间的实际空隙反推 icon 尺寸与每行行高（`Math.min(理想值, 可用空间)`），几何上保证不会溢出到按钮；同时把 `gridMetrics()` 里 `cellH` 从 `h*0.22` 调到 `h*0.27` 给内容多留余量。
- **横屏商品卡由 4 列改 3 列，杜绝标题换行把价格顶到按钮上（2026-07-17）**：图标卡改版成「大方图在上、标题/价格/按钮竖向堆叠」后，`gridMetrics()` 横屏目标宽度取 `w*0.16` → 一行约 4 张，卡片太窄；"Monthly Card"、"Skin · skin_shop_c1" 等标题被折成 2–3 行，把下面的价格行（`¥30`/金币 `300`）往下顶。而价格行（`coinAmount`/`yuanPrice` 两个分支）**没有像状态行 `lines` 那样做 `bandBottom` 钳制**，标题一高价格就压到底部按钮（"Claimed today"/"Owned"）上。改法：横屏目标宽度 `0.16 → 0.24`（`ShopScene/base.ts` `gridMetrics()`），一行 3 张、与竖屏一致；卡片变宽后标题回单行，价格行不再被顶下去。数值几何核对（横屏 1920 无头渲染）：确为 3 列，`¥30` 底边远在按钮上沿之上（留白约 230px）；`tsc --noEmit` + shop UI 套件 29 例全绿。
- **皮肤卡标题用真名，不再显示原始 id（2026-07-17）**：`buildShopCards()` 皮肤分支的标题原为 ``${t('shop.skinLabel')} · ${item.id}``，直接把目录 id（`skin_shop_c1` 等）当标题显示。`ShopItem`（openapi）只带 `id/cost/kind/grants`，不带名字，所以名字得在客户端从皮肤所属角色卡反推。新增共享 `skinDisplayName(skinId)`（`game/meta/skinDefs.ts`）：经 `SKIN_TARGET_UNIT` → 该 unitType 对应的角色卡 → `card.<id>.name`，产出 `{角色名}·{皮肤}`（如「李川·皮肤」），无映射时回退原 id。这套解析原本内联在 `GachaScene.displayName()` 里，本次抽成 skinDefs 的单一来源，Gacha 改调同一函数（去重）。皮肤**真美术仍是占位**（借用基础兵种 PNG，`.tao` 皮肤资源未产出，且 lichuang/suyuan/chenshou 角色本身也复用基础兵种图），属资源阻塞，不在本次范围。
- **光标约定是硬性契约，不是 ShopScene 专属实现**：任何「隐藏 `<input>` + canvas 画字段」的输入框都必须调用共享的 `caretDisplay()`（`ui/inputDisplay.ts`）产出显示文本，禁止再手写 `text || ' '` / `text || placeholder`。2026-06-23 那次修复只顺手改了 ShopScene/SettingsScene/ChatScene 三处，遗漏了 FamilyScene/SectScene/FriendsScene（好友页内嵌的家族/宗门/世界频道输入框）/AuctionScene（指定买家字段，另外还漏了逐键刷新），2026-07-04 补齐。`test/ui/caretRegression.ui.ts` 对每个受影响输入框做了聚焦-闪烁回归断言；新增任何同类输入框必须在该文件补一组用例，而不是仅凭肉眼过一遍。
- **2026-07-06 续修：`caretDisplay()` 接了但点开仍无光标**——FriendsScene 的点击处理器都是「先设激活标志（`worldChatActive`/`familyActiveInput`/`sectActiveInput`）再调 `openHiddenInput()`」，而 `openHiddenInput()` 第一行调的 `clearHiddenInput()` 会把这三个标志全部复位，等于把刚设好的标志立刻擦掉 → 光标判据与 `update()` 闪烁循环双双关闭，点开后既不闪也不显示 `|`。2026-07-04 的回归测试是手动 `scene.worldChatActive = true` 后直接 `render()`，绕过了「点击 → openHiddenInput」这条真实路径，所以测试全绿而 bug 依旧。**修复**：`openHiddenInput()` 只拆上一个 DOM 元素（`this.hiddenInput?.remove()`），不再整体调 `clearHiddenInput()`；`clearHiddenInput()` 仍用于真正的销毁路径（切 Tab / 取消 / destroy）。回归测试新增「走 hit 点击路径」的用例（需最小 `document` stub），杜绝再次只测手动状态。

### 4.4 GachaScene（盲盒，S2）
```
┌──────────────────────────────┐
│ ← 返回   盲盒       💰 1,250 ＋ │
├──────────────────────────────┤
│        ╔════════════╗          │
│        ║  盲盒大图    ║          │  当前池
│        ╚════════════╝          │
│   保底进度: ▓▓▓▓░░░░ 42/90     │  pity 条
│                                │
│  [ 单抽 💰100 ]  [ 十连 💰900 ] │  十连折扣
├──────────────────────────────┤
│  开箱动画：卡片翻转 → rarity 光  │  legendary 特效更炫
│  结果列表：本次获得 / 重复转化    │
└──────────────────────────────┘
```
- 抽卡走服务端（扣币 + 真随机 + 落库 + 保底，§META S2-3）；客户端只播动画 + 展示结果。
- 重复物品按 `dupePolicy` 显示"转碎片/退币"。
- i18n：`gacha.*`。
- **结果卡片可读性 + 图标化（2026-07-15，已上线验证）**：epic/legendary 卡背是深紫/金色纹理，id 文字直接叠上去看不清；改为文字区加一块半透明纸色底板（`C.paper` alpha 0.92）再叠字。同时结果卡此前只显示 `itemId` 纯文字，看不出实物——改为复用赔率详情面板既有的 `drawEntryPicture`（材料图标/装备字形/卡牌真实立绘/皮肤画笔图标/兜底稀有度星）在卡片上方画出物品图标，id 文字缩小做说明文字放图标下方。上线后实测（本地 dev 直连生产后端 + 调试钩子渲染验证）：图标/底板本身生效良好；但 NEW/重复徽标原先固定在 `h*0.85`，恰好落在稀有度边框图（`frame_epic/legendary.png`）的底边装饰带内，被边框颜色顶脏——上移到 `h*0.78` 修复，紫色卡背本身无需换色/换图。

### 4.5 CollectionScene（收集册/衣柜，S3）
```
┌──────────────────────────────┐
│ ← 返回   收集册                 │
├──────────────────────────────┤
│ [普通兵] [弓箭兵] [盾兵] [...]  │  按单位 Tab
├──────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
│ │皮肤1│ │皮肤2│ │ 锁 │ │ 锁 │  │  皮肤网格；未拥有灰显/锁
│ │已装备│ │    │ │    │ │    │  │
│ └────┘ └────┘ └────┘ └────┘  │
├──────────────────────────────┤
│   ┌──────────┐                │
│   │  大预览    │  [ 装备 ]      │  选中皮肤大图 + 装备按钮
│   └──────────┘                │
└──────────────────────────────┘
```
- 装备写 `SaveData.equipped`（纯外观，客户端同步段）；渲染层 `UnitView`/`StickmanRuntime` 按 equipped 选贴图。
- i18n：`collection.*`。
- **滚动（2026-06-27）**：三个 Tab（卡牌图鉴 / 皮肤衣柜 / 单位卡）内容数量都会超出一屏，原先平铺无裁剪导致超出部分看不到。改为 tab 栏以下整块内容画进带 mask 的 `layer` 容器，拖拽改变 `scrollY` 平移 `layer`（模式同 `ChatScene`）；`maxScroll` 由内容实际高度算出并夹紧、底部留 padding。命中检测：点击改在 pointer-up 触发，拖动 > 8px 视为滚动不点；内容命中（装备 / 合成）标记 `scroll: true`，命中时对指针 y 做滚动偏移补偿并忽略落在 tab 栏区域的误触。切 Tab 时 `scrollY` 归零。
- **内容图标化（2026-06-27）**：三个 Tab 原先纯文字，既累眼又「和游戏内容对不上」。改为：
  - **卡牌图鉴**：卡片标题左侧显示**真实卡牌立绘**（与战斗手牌 `HandView` 同一张 png），名称/类型行右移让位。立绘 url 映射 + `cardArtKey()` 从 HandView 抽到 `render/cardArt.ts` 作单一真源，两端 import 同一份，杜绝「图标和游戏里对不上」的困惑。法术立绘已烤红马克笔重点，显示**不 tint**。
  - **单位卡**：每行最左侧显示**单位立绘**（`cardArt.UNIT_ART_URLS`：infantry/archer/shieldbearer + Anna 的 max/lena/mara，六张 png 齐全），名称/等级右移。
  - **皮肤衣柜**：皮肤是服务器侧 id、无立绘数据，保留**手绘图标**（`icons.ts`：默认外观=铅笔 `pencils`，已拥有皮肤=笔刷 `brush`，已装备转绿）。
  - 立绘纹理异步解码、本场景是静态渲染：`drawArtFit()` 在纹理未 valid 时跳过本帧并挂一次性 `baseTexture.once('loaded', render)`，加载完重绘（战斗通常已暖共享纹理缓存，少触发）。
- **属性行图标化（2026-07-03）**：图鉴卡片的关键属性原是一行 `HP 100 · ATK 20 · Range 3` 纯文字。改为 glyph+数值 chip 行：HP=心形（`icons.ts` `hp`）、ATK=刀刃（`atk`），Range 无对应字形保留短文字标签兜底。`cardStatsLine()`（拼字符串）重构为结构化 `cardStats()` + `drawStatChips()`（整行超宽等比缩放塞进 tile）。

### 4.6 ProfileScene（档案，S0/S3）
- 账号信息（匿名 id / 昵称）、云同步状态（已同步/同步中/离线，含「手动同步」按钮）、成就墙（后续）、设置入口（语言/音量，复用 i18n）。
- i18n：`profile.*` + 复用现有 `settings.*`。

### 4.7 CampaignMapScene（选关地图，S3）
```
┌──────────────────────────────┐
│ ← 返回   第一章 · 剑士的来历     │  章节标题
├──────────────────────────────┤
│        (1)───(2)───(3)         │  关卡节点图（ScrollList 可滚）
│         ★★★   ★★    ★          │  StarRow
│                │               │
│              (4 锁)            │  未解锁锁态
├──────────────────────────────┤
│  [ 章节故事 ▶ ]                 │  播 IntroScene 风格叙事
└──────────────────────────────┘
点已解锁关 → LevelPrepScene
```
- 节点解锁/星级读 `SaveData.progress`；章节故事复用 `IntroScene` 逐行淡入模式（`story.*`）。

### 4.8 LevelPrepScene（关前编成，S3）
- 关卡目标摘要、关前 loadout（若关卡限定卡池）、PvE 养成等级预览、`[开打]`。
- 进 `GameScene`（campaign 模式）。

**内容区排版 + 字号（2026-07-15）**：三个面板自上而下依次为 **Objective**（2× 字号，label+desc 改为上下堆叠 + `wordWrap`，避免长文案如 `leak_limit` 溢出面板）→ **Rewards**（1.5× 字号）→ 故事简介 `brief`（1.5× 字号，原有 wordWrap 不变）。三者仍是单向 flow-down、无滚动，下方 stamina 条位置固定不随内容高度变化——已核对现有关卡数据，`leak_limit`（多行 objective）与长 `brief`（最长 700 字）不会同时出现在同一关，暂不需要滚动兜底。

### 4.10 StatsScene（生涯/战绩）

**朝向自适应布局（2026-06-28）**：用 `layout.orientation` 分支。

**横屏（1920×1080）— 左右两列**：
```
外边距 pad = w*4%，列间距 colGap = w*2.5%
左列 54%：排位对战 / 战役进度（上下堆叠）
右列 46%：收集 / 对战历史（上下堆叠）
```

**竖屏（1080×1920）— 单列**：
```
外边距 pad = w*4%，四个 section 纵向堆叠
```

各 section 用 `drawSection()`：手绘面板 + 左侧色条（`sketchAccentBar`）+ 标题 + label:value 行。  
行高 `h*3%`，标题高 `h*3.4%`，文字大小随高度比例，命中区 `InputManager.onDown` 统一处理（可点行注册至 `hits[]`）。

### 4.9 ResultScene（结算，扩展现有）
现状已有。**扩展**：评星动画（StarRow 逐颗点亮）、奖励发放（材料/物品 Toast）、解锁弹窗（新关/新皮肤 Modal）、（联机）胜负 + 段位变化。

**胜利页边饰**（2026-07-05）：`addMoodDeco('win')` 撒 12 颗手绘五角星，随机范围放宽为全屏（上下左右各留 3%~5% 页边距，避免溢出画布），并加最小间距保底（拒绝采样，相邻星最小间距 = 屏幕短边 10%，最多重试 20 次防止死循环）避免扎堆。每次进入用 `Math.random()` 重新随机 x/y/大小/透明度，非固定 seed。此前（2026-07-03，见 4.18）为避开中间徽章列而限制在左右边距，实测挤在一起不好看，且中间列已不怕遮挡，故放开为全屏。

