# client/ 关键约束与核心模块

## 关键约束

- **渲染**：`pixi.js-legacy`，兼容微信小游戏 WebGL
- **游戏逻辑**：纯 TS，固定点数（`game/math/fixed.ts`），与渲染解耦
- **平台适配**：Web / 微信小游戏 / CrazyGames，多入口 webpack 构建
- **骨骼动画 Runtime**：`StickmanRuntime`（`src/render/stickman/`），加载 `.tao` ZIP，驱动 PIXI Sprite
- **确定性约束**：游戏逻辑（`client/src/game/`）内严禁 `Math.random()`，必须用 `Prng`（`game/math/prng.ts`）
- **多语言（i18n）**：`zh.ts` 为键唯一来源（`TranslationKey`），`en`/`de` 声明为 `Record<TranslationKey, string>` 漏翻报错；`t(key, params?)` 取词，支持 `{param}` 插值
- **网络协议 codegen**：`transport.proto`/`game.proto` → ts-proto via buf → `src/net/proto/`；`openapi.yml` → openapi-typescript → `src/net/openapi.ts`；改契约须重跑 `npm run proto:gen` / `npm run rest:gen`
- **统一输入管线（M13）**：`InputSource` 接口，`LocalInputSource`（单机）/ `NetInputSource`（联机锁步）/ `RecordingInputSource`（录制）/ `ReplayInputSource`（回放）
- **⚠️ 渲染层销毁契约（防内存泄漏）**：每个战斗视图（`GameRenderer` 及子视图 `BoardView`/`UnitView`/`BuildingView`/`HandView`）**必须**实现 `destroy()`：①注销所有挂在 `PIXI.Ticker.shared` 上的一次性特效 tick（`Ticker.shared` 是 GC 根，漏一个就钉住整局场景图+纹理）；②`pool.drain()` 销毁池内已 `removeFromParent` 的游离对象；③`container.destroy({children:true})`。**共享纹理（spritesheet/`bake()`/`Texture.from`）只解引用不销毁。** 详见 **[`client-memory-leak.md`](client-memory-leak.md)**（事故复盘 + 完整契约 + heap snapshot 验证法）—— 2026-06 一次因六个视图全无 `destroy()` 导致每局退场泄漏整张场景图、2 小时涨到 16GB 的事故。
- **⚠️ 高频 `render()` 场景的文本纹理销毁（2026-06-27 事故）**：画布场景用「`container.removeChildren()` + 全量重画」模式重渲。`removeChildren()` **不销毁**子对象——而 `sketchUi.txt()` 每次 `new PIXI.Text`，**每个 Text 自带一张 GPU 纹理**，孤儿纹理要等 PIXI 纹理 GC（默认 ~60s）才回收。`LoginScene` 尤其致命：**每次按键** + 光标闪烁 **每 0.5s** 都全量 render，连打字时纹理瞬间堆满 → iPad Safari WebGL 内存预算极小 → 上下文丢失 → Safari 刷新页面（用户反馈「注册输昵称一直崩溃」）。**修复契约**：用 `sketchUi.tearDownChildren(container)`（共享单一实现）代替裸 `removeChildren()`——遍历返回的子对象，`PIXI.Text` 走 `destroy({texture:true,baseTexture:true})` 释放自有纹理，其余（Graphics/包 `bake()` 共享纹理的 Sprite）走 `destroy({children:true})`（缺省 `texture:false`，**不碰共享烘焙纹理**）。
  - **关键依赖（已被测试钉死）**：`destroy({children:true})` 会递归销毁子树，故**嵌套**的 Text（如聊天气泡 `container→layer→node→body`）也会被命中——`PIXI.Text.destroy()` 会与它自带的 `defaultDestroyOptions(texture:true,baseTexture:true)` 合并，即便经 `{children:true}` 递归也会释放自有纹理；而嵌套的非 Text Sprite 因 `texture` 缺省 false 保住共享纹理。PIXI 升级若改动该默认值会悄悄复发泄漏。
  - **审计结论（2026-06-27）**：命中并已套用契约 = `LoginScene`（逐键+光标 0.5s）/ `ChatScene`（逐键+光标 0.5s，含嵌套气泡）/ `ShopScene`（充值码逐键+光标 0.5s+按钮补间逐帧）/ `SettingsScene`（改名逐键+光标 0.5s）/ `SectScene`·`FamilyScene`（创建表单逐键→`bodyLayer`）/ `WorldMapScene`（HUD 每 ~5s 行军轮询 + 行军面板每 1s 倒计时）。**豁免** = `AuctionScene`：input 仅存字符串不触发 render，`update()` 仅 toast 计时，render 全是事件驱动（切页/滚动/拉取），无逐键/逐帧/定时 Text 重建。`WorldMapScene` 的 `renderMapL3`/`renderOverlay` 用单个 Graphics + `g.clear()`、无 Text，不在此列。
  - **回归测试**：`client/test/ui/textTeardown.ui.ts`（headless PIXI，`npm run test:ui`）—— 锁定顶层/嵌套 Text 释放、共享 bake 纹理保留、裸 `removeChildren()` 确实泄漏、ChatScene 反复重渲不跨代堆积。
- **内存看护（MemoryMonitor）**：`app.ts` 启动时 `new MemoryMonitor().install(app.ticker)`，跨场景常驻。每 5 秒采样 `performance.memory.usedJSHeapSize`，超阈值（默认 400MB，`localStorage 'nw_mem_warn_mb'` 可调）即 `console.warn`（`netLog('mem')`）并 dump 各对象池的空闲对象数 + 粗估占用，30 秒内不重复刷屏；微信侧另接 `wx.onMemoryWarning`（移动端真预算闸门，微信运行时常无 `performance.memory`）立即同样 dump。各池经 `cache/poolRegistry.ts` 登记/注销：4 个 `ObjectPool`（unit.circle/building/hand.slot/fx.meteor）由 `ObjectPool` 构造自注册、`drain()` 注销；3 个手工池（unit.stickman/fx.vfx/projectile）在各拥有者构造登记、`destroy()` 注销。**注意：`usedJSHeapSize` 只含 JS 堆、不含 GPU 纹理显存**——故"堆高但池都小"多为泄漏的场景图/闭包（同上次事故），某池 idle 只涨不回落才是池侧泄漏，两类靠这份 dump 区分。**池化范围**：仅战斗内高频生灭对象（stickman 是关键热路径）池化；HP 条/护卫 sprite、HUD 等常驻或低频对象按需 new/destroy，不入池。

## 核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理；每 tick 从 `InputSource` 消费指令；tick 顺序：resource→production→**trait**→combat→escort→hazard→movement→spell。**联机追帧**：`tick()` 按 `confirmedLead` 积压选倍速（>30s→5×/>10s→3×/>1s→2×/否则1×）缩短 `stepDt`，让暂停/最小化（rAF 停摆）落后的客户端加速排帧追上水位线；只重定时 step 不改帧序，确定性不变 |
| `game/net/InputSource.ts` | 统一输入管线接口 + `LocalInputSource` |
| `game/net/ReplayInputSource.ts` | `RecordingInputSource`（捕获确认帧，`snapshot()→Replay`）+ `ReplayInputSource`（喂 Replay，永不停步） |
| `game/net/NetInputSource.ts` | 联机锁步：`submit`→opaque `cmd_submit`；`frame_batch`→解码→`take(frame)`；未确认返 `null` 停步；`confirmedLead(frame)` 报告播放头之后的已确认积压帧数（供引擎追帧倍速） |
| `game/meta/ReplayStore.ts` | 本地录像：key `nw_replays_v1`，最近 12 局 ring |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（威胁驱动三段式；注入 Prng + 难度档） |
| `game/systems/TraitSystem.ts` | 被动 trait tick：regen / aura_heal（fp 累加→整数 HP）；slow 倒计时到期 resetSpeed；summonOnTimer 倒计时到期出兵；在 combat 前执行 |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |
| `i18n/index.ts` | `t()` 取词 + 插值；`initI18n`/`setLocale`/`onLocaleChange` |
| `game/meta/SaveData.ts` | 元系统单一权威根；`makeNewSave`/`SyncPatch`/`SAVE_VERSION` |
| `game/meta/migrate.ts` | `migrate(raw)→SaveData`：顺序升级 + fillDefaults；改字段必加迁移步 |
| `game/meta/SaveManager.ts` | 云同步：离线优先→bootstrap→防抖 push→409 reconcile；PvE 通关/升级走 `/pve/*` API。后台 push 连续失败达阈值（3 次）触发一次 `onSyncError`（接 `showToastMessage`，提示进度可能未上云），一次成功上行即复位，不刷屏 |
| `net/ApiClient.ts` | metaserver REST 客户端（fetch + ApiResp 包络） |
| `net/NetClient.ts` | WS 连接/重连（退避+代次）/ts-proto 编解码 |
| `net/NetSession.ts` | 联机会话：gateway(控制面 `/gw`) + game(数据面 `?ticket=`) 双连接；跨场景存活；含社交 + **SLG 实时 push** 路由（`onMarchUpdate/onTileUpdate/onUnderAttack/onSiegeResult/onFamilyMsg`，worldsvc→gateway 下发） |
| `net/WorldApiClient.ts` | **SLG worldsvc REST 客户端**（第四公网面，独立 base URL）；DTO 由 `server/contracts/openapi-world.yml` → `npm run rest:gen` → `net/openapi-world.ts` 生成（勿手改）；覆盖 world/march/troops/siege/defense/nations/season/shop/family/auction 全端点。**⚠️ `checkHealth()` 网络失败→true（inconclusive）**：dev 环境 `/health` 常缺 CORS 头而 fetch 抛错，但实际 feature 路由（`/world*`）完全正常——返回 false 会误标大世界离线。故所有 catch（连接被拒/超时/CORS）均视为"不确定"返 true，只有 HTTP 4xx/5xx 才返 false。单测断言需对应 true。 |
| `scenes/WorldMapScene.ts` + `scenes/worldmap/` | **SLG 大世界地图**（视口裁剪+拖拽平移；瓦片类型对齐服务端 8 类型；敌蓝我红；首府星标；行军连线；地图尺寸从 `getSeason` 动态取）；HUD「练兵」面板（训练队列倒计时+招募预设+金币加速，C4）+ 右上「世界」面板（国家/赛季/商城三 Tab，C5）。**已按 MVC 拆分**：`WorldMapScene.ts`=瘦编排壳（仅构造/生命周期/推送委派）；`worldmap/WorldMapContext.ts`=共享状态+类型出口（`WorldMapCallbacks`/`WorldMapView`/`DeployKind`）；四协作类持 ctx——`WorldMapRenderer`(地图/瓦片渲染+视图变换)、`WorldMapPanels`(HUD/弹窗/toast/练兵+世界面板等 chrome UI)、`WorldMapNet`(worldsvc API+行军动作+实时 push)、`WorldMapInput`(拖拽+瓦片点击派发)；纯 helper `constants.ts`/`tileStyle.ts`/`zoom.ts`/`tileGraphics.ts`(无状态绘制原语) |
| `scenes/FamilyScene.ts` / `scenes/AuctionScene.ts` | SLG 家族 / 拍卖行场景 |
| `net/proto/{transport,game}.ts` | ts-proto 生成（勿手改） |
| `scenes/RoomScene.ts` | 好友房 UI：idle→codeEntry→connecting→inRoom |
| `render/sketch.ts` | `SketchPen`：确定性 Prng 抖动的手绘笔触 |
| `render/sketchUi.ts` | 共享手绘 UI 原语（纸底/手绘按钮/面板/色板单一来源） |
| `ui/GlobalToast.ts` | **全局兜底 toast**：浮在所有场景之上（挂 `app.stage` 屏幕坐标，不受 Contain 缩放/场景切换影响，跟随 resize），手绘风格梯形淡入淡出。专供漏网错误兜底，各场景仍用自身 `showToast`——「有提示则跳过、漏了才兜底」 |
| `net/apiErrorMessage.ts` | `uncaughtErrorMessage(reason)`：未捕获 reason→玩家可读文案。duck-type（`err.name`+`err.code`，避免与 ApiClient 循环依赖）识别 `ApiError`/`WorldApiError`（按 code 映射 `common.err.*`，未知码→`common.actionFailed`）/ `TypeError`（fetch 网络失败→`common.networkError`）/ 超时；普通 JS 异常→`null`（不弹，不拿 bug 吓玩家） |
| `net/log.ts` | 网络日志 + **全局错误兜底中枢**：`installGlobalErrorHandlers` 在 window `error`/`unhandledrejection` 把漏网错误经 `apiErrorMessage` 归类后弹 toast；`setToastSink`（app.ts 注入 `GlobalToast.show`）/ `showToastMessage`（定点本地化提示出口，供 SaveManager 云同步失败复用） |
| `game/campaign/levels.ts` + `levelSchema.ts` | 关卡注册（`CAMPAIGN_LEVELS`/`CAMPAIGN_LEVEL_ORDER`，61 关 JSON 单一来源）+ `parseLevelDefinition` 运行时校验，加载即 fail-fast。⚠️ 出兵/`activeLanes` 的 col 必为 `ATTACK_LANES=[0,1,2,3,4,7,8,9,10,11]`（5/6 是中央基地列，非攻击道——棋盘 6→12 列迁移后的历史坑） |
| `game/campaign/maps/` | 章节地图（CAMPAIGN_DESIGN §12）：`ChapterMap` 类型 + `parseChapterMap` 校验（节点 `levelId` 必在 `CAMPAIGN_LEVELS`，坐标 0..1 越界软告警）+ `CHAPTER_MAPS`/`getChapterMap` 注册；`chN.json` 存节点归一化坐标/`path`/`decor`，**只引 levelId**，与关卡数值分离 |
| `scenes/LevelPrepScene.ts` | **关卡准备界面**（CAMPAIGN_DESIGN §10 P1）：故事摘要面板（`brief`，`breakWords:true` 支持 CJK 自动换行，面板高度自适应文字行数）+ 关卡目标条（`objective?: ObjectiveSpec`，金色 accent 条，支持 survive/boss/destroy_base/timed_defense/leak_limit/escort 6 种，中英德均译）+ 单位卡牌 2 列网格（6 张卡排 3 行×2 列，垂直占用减半，合成按钮 + T3/T6/T9 特质标签保留）+ 体力条 + 开打按钮。`LevelPrepCallbacks.objective` 由 `createAppCore.goLevelPrep` 从 `LevelDefinition.objective` 透传。 |
| `scenes/CampaignMapScene.ts` | **战役笔记本**（PvE 正门，CAMPAIGN_DESIGN §12）：两类页——目录页（6 章卡片 + 进度/星数 + 锁章胶带遮罩）/ 章节页（节点按 `maps/chN.json` 归一化坐标摆放，`SketchPen` 铅笔虚线路径串联，已通关金圈星章 / 当前关蓝圈脉冲 / 未解锁淡铅笔轮廓 / decor 涂鸦）。进场落目录页→自动翻到「当前可打关」那章；翻页 = 横向 slide+fade（`update(dt)` 驱动，0.42s），左右箭头切章（下一章须通关方亮）；整章通关盖「第 N 章 · 通关」红章。章节页顶栏标题（「第 N 章 · 场地名」）下方补一行淡色叙事者归属「陶的笔记本 / Anna 的笔记本」（奇数章=陶/偶数章=Anna，对应 CAMPAIGN_STORY.md 框架表；`buildHeader` 的可选 `subtitleStr` 参数，TOC 页不传）。全程序绘制，零美术资产；回调 `CampaignMapCallbacks` 与旧扁平列表版同构。解锁/落点判断全走 `game/campaign/progress.ts`（不再内联） |
| `game/campaign/progress.ts` | 战役进度纯逻辑（PIXI 无关，可单测）：`isLevelUnlocked`（前一关通关才解锁）/ `currentChapter`（第一个未通关关所在章）/ `currentLevelIdInChapter`（该章首个解锁未通关关=脉冲当前关）/ `parseLevelId`。节点 levelId 与 `CAMPAIGN_LEVEL_ORDER` 1:1 → 所见即所玩 |
| `game/meta/campaignRewards.ts` | `computeStars(starThresholds, 剩余HP%)`：**通关保底 1★**（HP>0 即 ≥1★，门槛只升级 2★/3★；HP≤0=基地打爆=0★）+ `remainingHpPct`。客户端报星 + 裁判复算同口径。⚠️ 0★ 不算通关（不入账/不解锁）——故胜利必须保底 1★ |

## 测试 harness（test/harness/）

> 测试分层总览（单元 / UI 冒烟 / 渲染泄漏 / E2E）+ headless PIXI 适配 + 上线前浏览器冒烟方案：见 [`client-testing.md`](client-testing.md)。

| 文件 | 说明 |
|---|---|
| `pixiHeadless.ts` | UI 冒烟（`test:ui`）的 PIXI DOM adapter 桩：纯 JS canvas/context + 全局 `Image`/`HTMLImageElement`/`HTMLCanvasElement` 桩，让真实场景在 Node 里构建 PIXI 树、量文字，**不创建 Renderer**（不碰 WebGL）。配合 `vitest.ui.config.ts` 的 `stubBinaryAssets` 插件（`*.png`/`*.tao` import → 1×1 PNG data URI）跑通含完整 GameRenderer 的对战场景。 |
| `HeadlessPlatform.ts` | 无渲染 IPlatform（E2E + headless 单测共用）。**⚠️ 默认预埋 `tutorial_done:true`**（via `nw_save_v1` JSON flags）：`goLobby()` 有 FTUE 一次性门控（`firstLobbyHandled`），首次进大厅若 `tutorial_done` 未置位会跳转 `goTutorial()` → screen='game'，绕过 lobby。headless 测试不跑 FTUE，故默认预埋；若需测 FTUE 路径可 `opts.storage={nw_save_v1:'{}'}` 覆盖。 |
| `HeadlessAppViews.ts` | AppViews 空实现，记录当前 screen + callbacks；`driveToEnd()` / `driveReplayToEnd()` 无 ticker 驱动引擎到结束；`showGame()` 用 `createLocalMatch` 建本地引擎（`screen='game'`），`showGameNet()` 注入服务端引擎（`screen='gameNet'`）。 |
