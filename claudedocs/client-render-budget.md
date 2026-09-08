# 客户端每帧预算 —— 画多少次、画多少三角

> 拍板记录：[ADR-083](../design/DECISIONS_ADR-070-onward.md#adr-083-渲染循环三级节流dpr-上限-2maxfps-60菜单场景按需重绘含派生式变更检测--重绘地板--accepted--2026-09-08)。
> 本文是**快查**：新增场景/新增手绘几何前先看「§2 给新场景选 paint 模式」和「§3 别在场景里实时描边框」两节。

## 1. 起因与数字

2026-09-08 owner 报「手机上很快就没电了，mac 上让电脑的风扇都加速了，而且电脑发热严重」，追加「slg 里，地图甚至卡顿到影响体验了」。

真浏览器实测（Windows / Intel Arc Pro / dpr 1.5 / 画布 1280×631 CSS = 1920×947 设备像素）：

| | 修复前 | 修复后 |
|---|---|---|
| 空闲大厅 · 索引/帧 | **253,737** | **4,794** |
| 空闲大厅 · draw call/帧 | 23 | 8 |
| 空闲大厅 · GPU/帧 | 0.77 ms | — （不再每帧画） |
| 空闲大厅 · 整 tick 主线程 | ~0.8 ms | **0.084 ms** |
| 空闲大厅 · 重绘次数/秒 | 60（120 Hz 设备 120） | **~5–12** |
| 战斗（VS AI 开局） | 120/120 帧全画 | **120/120 帧全画**（不变） |
| 世界地图 · 一条行军在途 60 帧 | 叠加层重建 60 次 | **0 次**（token 仍 60 次） |

修复前那 253,737 里 82% 是四块手绘面板边框：`SketchPen.trace` 为了 taper 每段都换一次 `lineStyle`，配 round cap/join，**一块 976×105 的面板 = 735 条不可合批 primitive + 68,496 个索引**。

绝对值在桌面上都不大——问题是**这笔账一秒付 60~120 次、永不停止**，设备一刻进不了低功耗态。

## 2. 给新场景选 paint 模式

`Scene.paint?: 'live' | 'reactive'`（`scenes/SceneManager.ts`），**缺省 `'live'` = 每 tick 都画**，也就是这条 ADR 之前所有场景的行为。所以一个什么都不声明的新场景不会因为这套机制变得奇怪。

- **`'reactive'`** —— 菜单/外壳屏。画面只在玩家碰它、或网络推送落地时变。**加这个字段不需要审计场景内部**：变更检测读的是显示树，不是场景自己的记账（见 §4）。当前 28 个场景是这一类。
- **`'live'`** —— 每帧都在动的：`GameScene` / `ReplayScene` / `StatePlayerScene` / `WorldMapScene` / `IntroScene` / `IllustratedInterludeScene`。按需重绘在这些场景上省不到东西，还白付一趟遍历。

`SceneManager.paintMode` 对组合**取悲观**：只有 `current` 与 `overlayScene` **都**声明 `'reactive'` 才算 reactive（reactive 的城池面板压在 live 的世界地图上仍然是 live——地图在下面继续动，那是 `pushOverlay` 的全部意义），fade 期间一律 `'live'`。

### 动画要报速率吗？不用，但要控制自己的步长

按需重绘不需要动画「申报」，签名会看到它动。但**动得多快就画得多快**，所以装饰性动画该自己限速：

- `render/boil.ts` 沸腾线本来就 8 fps。
- 菜单里的火柴人剪影传 `poseFps: MENU_POSE_FPS`（12，`render/stickman/constants.ts`）。缺省不限速，战斗单位不受影响。**clip 时间照常按全量 `dt` 前进**，只是采样点变少——否则动画整体变慢。
- 世界地图护盾气泡 10 fps（`WorldMapRenderer/lifecycle.ts` 的 `SHIELD_ANIM_FPS`）。

art-direction §5.4 本来就要「帧率保留手绘的跳跃感，不必追求丝滑流畅」——限速在这套画风里是**更对**，不是妥协。

## 3. 别在场景里实时描边框

**面板边框走 `render/sketchUi.ts` 的 `sketchPanel()`**（内部是 `render/panelFrame.ts` 的烘焙图集：长边条 + 四个圆角块，全是同一张 baseTexture 上的 sprite）。要在面板上再画自己的墨（accent 条、分隔线）用 `inkLayer(panel)` 拿一个 `Graphics`——面板现在是 sprite 的容器，没有单一 `Graphics` 可以描。

历史：大厅曾有**自己一份** `sketchPanel`/`drawBtn`（实时 `SketchPen.rect`），这就是 §1 那 82% 的来源。世界地图 HUD 2026-08 已经搬过一次（132,300 顶点 → 704），大厅只是没跟上。`render/avatar.ts` 的铅笔圆环同理已烘焙（46 px 圆环 6,048 索引，而成员列表/聊天/地图 token 会同屏摆几十个）；它的 **seed 量化到 8 个变体**，否则按 `publicId`/行号播种会给每个见过的玩家永久留一张 RenderTexture。

仍然在实时描边、且**故意不改**的：`CampaignMapScene/drawing.ts` 的地图涂鸦（胶带、圈注——不是矩形边框，图集帮不上）、`SettingsScene` 的几个按钮框（同一形状，值得搬，但不在热路径上；搬的时候连带把 §5 的预算数字更新）。

`bake()` 有自己的门禁：新增 bake 站点必须在 `test/pageBakeCallSites.test.ts` 里登记 `pageScale` 的取值（ADR-073）。

## 4. 为什么变更检测是「派生」，以及地板为什么必须有

显式 `markDirty()` 协议在这个仓库是**已知会烂的形状**：40 个场景各自在输入/网络推送/贴图迟到解码上重建，漏一次就是画面冻住，而那正是本客户端出过的最严重故障（「切 UI 卡死，只有刷新能救」）。`SceneManager.onTick` 每帧重新推导 BGM 而不是靠通知，理由一模一样。

所以 `render/renderPolicy.ts` 的 `stageSignature()` 每 tick 走一遍舞台，只读渲染器输出真正依赖的字段：`visible` / `renderable` / `alpha` / `tint` / `transform._localID` / `zIndex` / `baseTexture.uid` + frame + `dirtyId` / `geometry.dirty` / `text` / 子节点数与顺序。空闲大厅 89 个对象，整 tick 0.084 ms。

**派生仍可能不完整**，所以有两个安全阀：

- `IDLE_FLOOR_MS = 500`：签名没变也每 500 ms 强制画一帧。
- `ACTIVE_AFTER_INPUT_MS = 400`：任何指针事件后 400 ms 内维持满帧。`InputManager` 的四个 emit 漏斗在**网关之前**调 `holdRenderActive()`——被 modal/fade 吞掉的那一下同样改变画面（弹窗走 PixiJS 自己的事件系统，根本不到这些订阅者）。

于是**漏检的最坏情况是「一帧晚了半秒」，不是「一帧永远不来」**。这是这套机制敢上的唯一理由；改动 `renderPolicy.ts` 时不要把地板优化掉。

三个具体的坑，都是变异测试挖出来的（详见 §5）：

- **`PIXI.Texture` 没有 `uid`**，只有 `BaseTexture` 有。第一版哈希的是 `undefined`，图集换帧检测不到。现在读 `baseTexture.uid` + frame 矩形。
- **`sortDirty` 会被无关的 `addChild` 提前置真**，光靠它漏得掉 zIndex 重排。现在直接哈希 `zIndex` 的值。
- **`document.hidden` 短路要不得**：第一版有，结果「窗口被完全遮挡但合成器仍为截图唤醒一帧」时整块画布**全黑**。浏览器真后台时早就停发 rAF，这个判断只能在它唯一还生效的场合里制造 bug。

世界地图的叠加层墨线用同一套思路的第二个签名 `overlayInkSignature(ctx)`（`WorldMapRenderer/fog.ts`）：摘要相机 + 服务端状态，因为写 `ctx.marches`/`occupations`/`stationed`/`nations` 的站点散在 `net/` 与 `WorldMapPanels/` 共约 15 处。格子归属这一维靠 `VersionedTileCache`（`Map` 子类，`set`/`delete`/`clear` 各自 `version++`）——**覆写三个 mutator 而不是改 10 个调用点，是因为前者不可能忘**。

## 5. 四份门禁（都在既有 `npm run test:ui` / `npm test` 里）

| 文件 | 钉住什么 |
|---|---|
| `test/ui/renderPolicy.ui.ts`（33 例） | dpr 上限、`maxFPS`、**接管 PIXI 自己的渲染监听**（行为断言，否则每条 skip 都是假的）、**每一类变更都必须重绘**（移动/缩放/旋转/alpha/隐藏/显示/renderable/tint/重画/改字/图集换帧/贴图解码/子节点增删/zIndex 重排/嵌套深处）、hold/floor/invalidate 三个阀 |
| `test/ui/worldMapOverlayCoalescing.ui.ts`（13 例） | 「一条行军在途 60 帧 → 墨线 0 次、token 60 次」；墨线依赖的每个输入都触发**正好一次**重建；拖动 6 次 pointermove 只重建一次 |
| `test/ui/sceneGeometryBudget.ui.ts`（3 例） | 大厅一帧**索引预算 25,000**（实测 15,582 headless）。计数直接调 `GraphicsGeometry.updateBatches()`（PIXI 三角化是纯 JS），CI 无 GPU 也能拿到精确三角数；`bake()` 喂 stub renderer，量的是**上线路径** |
| `test/ui/renderLoopWiring.ui.ts`（15 例） | 中间那层接线（ADR-072 的教训）：app.ts 真的装了 policy、真的过了 dpr 上限、四条指针路径都 hold、`paintMode` 对 overlay/fade 悲观 |

**每一条关键断言都做过变异验证**（删掉签名里对应那行 / 把 lifecycle 改回每帧重建 / 把大厅那份 `sketchPanel` 改回旧实现 → 报 271,110 索引，红得很响）。
`stageSignature` 里 `visible` 与 `children.length` 两个字段是遍历形状本身的分隔符，**无法单独钉死**——注释和测试里都写了，别当成没覆盖顺手「清理」。其余无法单独生效的冗余字段（`graphicsData.length` / `baseTexture.valid` / `mask` 存在位）当时**直接删了**，而不是留着假装被覆盖。

## 6. 怎么再测一遍

**诊断口子**：`localStorage.setItem('nw_render_debug','1')` 后重载，`globalThis.__nwRenderStats` 给 `{ticks, painted, skipped}`。同 `nw_mem_warn_mb`/`nw_fps_warn` 一类，默认不发布任何全局。

真浏览器测量配方（本机 Chrome 标签页被遮挡时 rAF 会挂起，这套绕过它）：

1. 抢 webpack require 拿 PIXI：`window.webpackChunkpixigame.push([["probe"],{},r=>req=r])`，再 `req.c[<key ending in pixi.js-legacy/lib/index.mjs>].exports`。
2. **拿 app 的 ticker**：包 `PIXI.Ticker.prototype.update`，第一帧（截图会强制一帧）把 `this !== Ticker.shared` 的那个存下来；之后 `tk.update(t += 16.7)` 就能**手动驱动整个循环**（场景 update + policy 决策），配合 `__nwRenderStats` 直接读出重绘率。
3. **拿舞台**：`app.renderer.render` 在 `app.ts` 里被 `.bind()` 过，patch 原型抓不到它；改 patch `PIXI.Graphics.prototype._render` 抓任意实例，再顺 `parent` 爬到根。
4. 几何/draw call：包 `gl.drawElements`/`drawArrays`/`bufferData`/`texImage2D` 按 `count` 累加；单帧的 count 序列直接暴露「哪几个物件是大头」，再用 `getBounds()` 认屏上位置。
5. 真 GPU 时间：`EXT_disjoint_timer_query_webgl2`，但**结果不会同步就绪**——beginQuery/render N 次/endQuery 放一次 JS 调用，`QUERY_RESULT` 放**下一次**调用里读。
6. ⚠️ **不要 hook `requestAnimationFrame` 再手动重放回调**：回调会重新注册，同步重放 120 帧后队列指数爆炸（实测涨到 9,363 万条，页面卡死）。用第 2 步的 ticker 驱动。

## 7. 还没做的

1. **`WorldMapScene` 本身仍是 `'live'`**——它的池子有数千个对象，签名遍历成本还没实测；没有数字就不改。ADR-083 决策五/六已经把它每帧的 CPU 拿掉了。
2. **SLG 地图的真机验证还欠一次**：本机能起 docker 全栈（`docker/local-up.ps1`，:8088），但客户端进世界地图要账号，需要 owner 自己登录一次；单元门禁覆盖的是逻辑，画面还得看一眼。
3. **iOS / 微信两个宿主上的实测数字没取**：dpr 上限的收益是按面积比算出来的，不是量出来的（微信侧 `WechatPlatform.devicePixelRatio` 本来就是 1，只有 iOS/web 吃这条）。
