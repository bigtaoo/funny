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
| `net/WorldApiClient.ts` | **SLG worldsvc REST 客户端**（第四公网面，独立 base URL）；DTO 由 `server/contracts/openapi-world.yml` → `npm run rest:gen` → `net/openapi-world.ts` 生成（勿手改）；覆盖 world/march/troops/siege/defense/nations/season/shop/family/auction 全端点 |
| `scenes/WorldMapScene.ts` | **SLG 大世界地图**（视口裁剪+拖拽平移；瓦片类型对齐服务端 8 类型；敌蓝我红；首府星标；行军连线；地图尺寸从 `getSeason` 动态取）；HUD「练兵」面板（训练队列倒计时+招募预设+金币加速，C4）+ 右上「世界」面板（国家/赛季/商城三 Tab，C5） |
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
| `scenes/CampaignMapScene.ts` | **战役笔记本**（PvE 正门，CAMPAIGN_DESIGN §12）：两类页——目录页（6 章卡片 + 进度/星数 + 锁章胶带遮罩）/ 章节页（节点按 `maps/chN.json` 归一化坐标摆放，`SketchPen` 铅笔虚线路径串联，已通关金圈星章 / 当前关蓝圈脉冲 / 未解锁淡铅笔轮廓 / decor 涂鸦）。进场落目录页→自动翻到「当前可打关」那章；翻页 = 横向 slide+fade（`update(dt)` 驱动，0.42s），左右箭头切章（下一章须通关方亮）；整章通关盖「第 N 章 · 通关」红章。章节页顶栏标题（「第 N 章 · 场地名」）下方补一行淡色叙事者归属「陶的笔记本 / Anna 的笔记本」（奇数章=陶/偶数章=Anna，对应 CAMPAIGN_STORY.md 框架表；`buildHeader` 的可选 `subtitleStr` 参数，TOC 页不传）。全程序绘制，零美术资产；回调 `CampaignMapCallbacks` 与旧扁平列表版同构。解锁/落点判断全走 `game/campaign/progress.ts`（不再内联） |
| `game/campaign/progress.ts` | 战役进度纯逻辑（PIXI 无关，可单测）：`isLevelUnlocked`（前一关通关才解锁）/ `currentChapter`（第一个未通关关所在章）/ `currentLevelIdInChapter`（该章首个解锁未通关关=脉冲当前关）/ `parseLevelId`。节点 levelId 与 `CAMPAIGN_LEVEL_ORDER` 1:1 → 所见即所玩 |
| `game/meta/campaignRewards.ts` | `computeStars(starThresholds, 剩余HP%)`：**通关保底 1★**（HP>0 即 ≥1★，门槛只升级 2★/3★；HP≤0=基地打爆=0★）+ `remainingHpPct`。客户端报星 + 裁判复算同口径。⚠️ 0★ 不算通关（不入账/不解锁）——故胜利必须保底 1★ |
