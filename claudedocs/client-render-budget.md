# 客户端每帧预算 —— 画多少次、画多少三角

> 拍板记录：[ADR-083](../design/DECISIONS_ADR-070-onward.md#adr-083-渲染循环三级节流dpr-上限-2maxfps-60菜单场景按需重绘含派生式变更检测--重绘地板--accepted--2026-09-08)（三级节流）、ADR-085（世界地图也改按需重绘 + 把 8.25 ms 那个数更正成 1.3 ms）。
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
| 世界地图 · 空闲重绘次数/秒（ADR-085） | 60 | **10.0**（skip 82.9%） |
| 世界地图 · 整 tick 主线程 | — | **1.3 ms** p50（**不是 8.25 ms**，那次量在遮挡窗口里，见 §7） |

修复前那 253,737 里 82% 是四块手绘面板边框：`SketchPen.trace` 为了 taper 每段都换一次 `lineStyle`，配 round cap/join，**一块 976×105 的面板 = 735 条不可合批 primitive + 68,496 个索引**。

绝对值在桌面上都不大——问题是**这笔账一秒付 60~120 次、永不停止**，设备一刻进不了低功耗态。

**线上也留了证据（2026-09-09 回查 Loki）。** `{source="client", kind="anomaly"}` 里 14 天共 52 条 `type=cpu`「sustained low fps」，其中 **43 条落在 `buildVersion=e2e307e`**——那是 PR #129（07.09.2026），**修复前的最后一个线上包**。它们来自 2026-09-08 08:09–10:17 UTC 的一段会话，桌面 1680×998 / dpr 2，**几乎每分钟一条，fps 11–16 连续一小时**（同一账号切到平板 1024×654 时是 18–24）。也就是说 owner 那句「风扇加速/发热」在遥测里是一条一小时的直线，不是主观感受。

修复后的两个包（`ab82f49` / `410413c`）**一条 `cpu` 都没有**——但**别把这当成结论**：这两个包在线上只有 ~9 段很短的会话（analytics 里 `session_end` 合计 9 条），曝光量根本不够。而且 `device=phone` 的 `cpu` 报告**从来没有过一条**，手机那半边至今零遥测。查法见 §9 末尾。

## 2. 给新场景选 paint 模式

`Scene.paint?: 'live' | 'reactive'`（`scenes/SceneManager.ts`），**缺省 `'live'` = 每 tick 都画**，也就是这条 ADR 之前所有场景的行为。所以一个什么都不声明的新场景不会因为这套机制变得奇怪。

- **`'reactive'`** —— 菜单/外壳屏，**外加世界地图**（ADR-085）。画面只在玩家碰它、或网络推送落地时变。**加这个字段不需要审计场景内部**：变更检测读的是显示树，不是场景自己的记账（见 §4）。当前 29 个场景是这一类。
- **`'live'`** —— 每帧都在动的：`GameScene` / `ReplayScene` / `StatePlayerScene` / `IntroScene` / `IllustratedInterludeScene`。按需重绘在这些场景上省不到东西，还白付一趟遍历。（`WorldMapScene` 曾经在这一行里——它每帧确实在跑不少 `update()`，但**画面**空闲时一秒只变 ~10 次，见 §7。）

`SceneManager.paintMode` 对组合**取悲观**：只有 `current` 与 `overlayScene` **都**声明 `'reactive'` 才算 reactive（`'live'` 的场景在下面继续动，那是 `pushOverlay` 的全部意义；ADR-085 之后地图本身是 reactive，所以「城池/社交/拍卖 overlay 压在地图上」这一整类组合也跟着变成 reactive——地图的动静照样由签名看到），fade 期间一律 `'live'`。

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

## 5. 五份门禁（都在既有 `npm run test:ui` / `npm test` 里）

每一条都做过变异验证——写完先把源码改坏，确认对应用例转红，再留下来。

| 文件 | 钉住什么 |
|---|---|
| `test/ui/renderPolicy.ui.ts`（33 例） | dpr 上限、`maxFPS`、**接管 PIXI 自己的渲染监听**（行为断言，否则每条 skip 都是假的）、**每一类变更都必须重绘**（移动/缩放/旋转/alpha/隐藏/显示/renderable/tint/重画/改字/图集换帧/贴图解码/子节点增删/zIndex 重排/嵌套深处）、hold/floor/invalidate 三个阀 |
| `test/ui/worldMapOverlayCoalescing.ui.ts`（21 例） | 前 13 例：「一条行军在途 60 帧 → 墨线 0 次、token 60 次」；墨线依赖的每个输入都触发**正好一次**重建；拖动 6 次 pointermove 只重建一次。后 8 例是 ADR-085 的 `paint` 门禁，跑**真 `RenderPolicy` + 真 `WorldMapScene`**、且策略读的是**场景自己声明的** `paint`（写死 `'reactive'` 会让那一行退回去也全绿）：行军在途 **60/60**、落地 ≤2/60、空闲 ≤2/60、**`paint` 就是 `'reactive'`**，外加四条「空闲地图上其实在动的东西」——首屏加载罩 **60/60**（不许有人看着不转的转圈）、护盾气泡 ~10/60（不许冻住）、HUD 倒计时每秒至少一次（`≤2` 的**另一个方向**）、新手引导圆环亮着时 ≤25/60（**修复前就是 60/60**，这条是那个 bug 在真宿主里的回归门禁） |
| `test/ui/sceneGeometryBudget.ui.ts`（3 例） | 大厅一帧**索引预算 25,000**（实测 15,582 headless）。计数直接调 `GraphicsGeometry.updateBatches()`（PIXI 三角化是纯 JS），CI 无 GPU 也能拿到精确三角数；`bake()` 喂 stub renderer，量的是**上线路径** |
| `test/ui/guideOverlay.ui.ts`（19 例） | 引导圆环：`update()` 一秒 60 帧**一次几何重建都不许有**、alpha 仍在动、一秒最多 ~10 个不同 alpha（`update` + 每帧 `showAt` 一起调也一样）、目标移动时几何**必须**重描、**呼吸区间仍是 0.5–0.9**（改的是成本不是观感——把环改暗的「优化」不该靠读重绘计数才发现） |
| `test/ui/renderLoopWiring.ui.ts`（15 例） | 中间那层接线（ADR-072 的教训）：app.ts 真的装了 policy、真的过了 dpr 上限、四条指针路径都 hold、`paintMode` 对 overlay/fade 悲观 |

**每一条关键断言都做过变异验证**（删掉签名里对应那行 / 把 lifecycle 改回每帧重建 / 把大厅那份 `sketchPanel` 改回旧实现 → 报 271,110 索引，红得很响）。
`stageSignature` 里 `visible` 与 `children.length` 两个字段是遍历形状本身的分隔符，**无法单独钉死**——注释和测试里都写了，别当成没覆盖顺手「清理」。其余无法单独生效的冗余字段（`graphicsData.length` / `baseTexture.valid` / `mask` 存在位）当时**直接删了**，而不是留着假装被覆盖。

## 6. 怎么再测一遍

**诊断口子**：`localStorage.setItem('nw_render_debug','1')` 后重载，`globalThis.__nwRenderStats` 给 `{ticks, painted, skipped}`。同 `nw_mem_warn_mb`/`nw_fps_warn` 一类，默认不发布任何全局。

真浏览器测量配方（本机 Chrome 标签页被遮挡时 rAF 会挂起，这套绕过它）：

1. 抢 webpack require 拿 PIXI：`window.webpackChunkpixigame.push([["probe"],{},r=>req=r])`，再 `req.c[<key ending in pixi.js-legacy/lib/index.mjs>].exports`。
2. **拿 app 的 ticker**：包 `PIXI.Ticker.prototype.update`，第一帧（截图会强制一帧）把它存下来；之后 `tk.update(t += 16.7)` 就能**手动驱动整个循环**（场景 update + policy 决策），配合 `__nwRenderStats` 直接读出重绘率。
   ⚠️ 认 ticker 的判据是 **`maxFPS === 60`**，不是 `this !== Ticker.shared`：`Ticker.system`（PIXI 自己用来跑 `BasePrepare` 一类的）也不是 shared，会被先抓到，而它的 `maxFPS` 是 0。2026-09-08 第一次按旧判据测，量了半天量的是 system ticker。
3. **拿舞台**：`app.renderer.render` 在 `app.ts` 里被 `.bind()` 过，patch 原型抓不到它；改 patch `PIXI.Graphics.prototype._render` 抓任意实例，再顺 `parent` 爬到根。
4. 几何/draw call：包 `gl.drawElements`/`drawArrays`/`bufferData`/`texImage2D` 按 `count` 累加；单帧的 count 序列直接暴露「哪几个物件是大头」，再用 `getBounds()` 认屏上位置。
5. 真 GPU 时间：`EXT_disjoint_timer_query_webgl2`，但**结果不会同步就绪**——beginQuery/render N 次/endQuery 放一次 JS 调用，`QUERY_RESULT` 放**下一次**调用里读。
6. ⚠️ **不要 hook `requestAnimationFrame` 再手动重放回调**：回调会重新注册，同步重放 120 帧后队列指数爆炸（实测涨到 9,363 万条，页面卡死）。用第 2 步的 ticker 驱动。
7. ⚠️ **窗口被遮挡时不要量「一帧多少毫秒」**。手动驱动能绕过 rAF 停发，但绕不过合成器：`document.hidden` 为真时同步连打 `render()` 会被逐帧阻塞，实测从 8 ms/帧退化到 ~750 ms/帧（连驱 60 帧直接把 CDP 的 45 s 超时耗光）。**耗时数字必须在窗口可见时取**；只想知道「画面变没变」则不需要可见——把 `PIXI.Renderer.prototype.render` 临时换成空函数再驱动 ticker，场景 update 照跑、GPU 一次不碰，量签名变化率又快又干净（记得 `finally` 里换回来）。
8. ⚠️ **「窗口可见」比想象的难拿到，先读 `document.visibilityState` 再决定信不信数字。** 2026-09-08 想给 §7 的 8.25 ms 重取一次精确值，卡在这里：Chrome 窗口开着、没最小化，但游戏标签页不是它所在窗口的**当前**标签页，于是 `document.hidden` 恒为 `true`（截图照样能出图——扩展抓得到非前台标签页，所以「截图正常」不等于「可以量时间」）。`tabs_create_mcp` 新开标签页、`tabs_context_mcp{createIfEmpty:true}` 新开窗口、Win32 `SetForegroundWindow` 抬窗口，三条都没能把它顶到前台。**结论：要 ms 就得请人手动点一下那个标签页**——2026-09-08 §7「拨开关」那批数字就是这么拿到的，问一句、等一句，比继续找绕路的办法快得多。每次量之前把 `visibilityState` 和读数打印在同一行，不然会拿一个自己都不知道不可信的数去做决定（8.25 ms 那次就是）。
9. **想在同一个页面里做「修复前 vs 修复后」的 A/B，直接 patch 模块的 prototype。** 第 1 步那个 webpack require 不只能拿 PIXI：`req.c['./src/render/GuideOverlay.ts'].exports` 就是那个类本身，`G.prototype.update = <旧实现>` 就把线上代码换回修复前的行为，三次量测之间只差这一处（2026-09-08 §7 的 A/B/C 就是这么做的）。比「切分支重编译再登一次账号」快一个量级，而且排除了「两次量测之间世界变了」这个最难排除的干扰项。记得把原方法存下来在最后还回去。

## 7. 世界地图改成了 `reactive`（ADR-085，2026-09-08 实测）

同一台机器、docker 全栈（`docker/local-up.ps1` :8088）+ dev server 指过去，真账号进世界地图，**空闲**（无行军 / 无驻防 / 未选中）：

| zoom | 舞台对象数 | `stageSignature` | ns/对象 | 签名变化 / 60 帧 |
|---|---|---|---|---|
| L1 详细 | 1,536（Sprite 596 / Graphics 580 / BitmapText 309） | 0.21 ms | 136 | **11** |
| L2 中景 | 3,859（Graphics 3,684 = 池子） | 0.30 ms | 79 | **11** |
| L3 总览 | 199（批量路径，池子空） | 0.016 ms | 80 | 19 |
| （对照）空闲大厅 | 84 | 0.004 ms | 48 | — |

读法：

- **遍历不贵**。最坏 0.30 ms × 60 = **18 ms/s**。对象多的 L2 反而 ns/对象最低——池子是清一色 `Graphics`，没有 `Text` 的字符串哈希，也没有 Sprite 的 frame 矩形。ns/对象随树变大而升是 cache 效应，不是算法问题。
- **能省的很多**。空闲地图**一秒只真的变 11 次**（10 次是护盾气泡的 `SHIELD_ANIM_FPS`，剩下 1 次是 HUD），也就是 60 帧里有 **~49 帧画的是同一张图**。
- ⚠️ **这一批里「整 tick 8.25 ms」那个数是错的，作废**（当时窗口被遮挡——§6 第 7 条自己写过的禁忌，那批数字踩了）。可见窗口重取见下面「拨开关」那节：**1.3 ms**。
- **有行军在途时省不到**：token 每帧动，签名每帧变，那时地图本来就该画。这是「白付一趟遍历」的上界，也就是 0.30 ms/帧。

**那个 bug 已经修了（2026-09-08 下午）**：`render/GuideOverlay.ts` 的 `update()` 每帧调 `drawRing()`（`clear()` + `lineStyle` + `drawRoundedRect`），为了 `0.5 + 0.4 * sin(pulseT * 4)` 这个呼吸 alpha 把圆角矩形每秒重新三角化 60 次，新号进图时签名 **60/60 帧全变**。改法是把「几何」与「呼吸」拆开：

- 几何只在目标 rect **真的移动**时重描（`syncRing` 比对缓存的 rect；`traceRing` 用不透明的 `lineStyle`）。
- 呼吸走 `ring.alpha`，且**量化的是相位、不是调用方**：`Math.floor(pulseT * RING_PULSE_FPS) / RING_PULSE_FPS`（10 fps，同护盾气泡）。这一点是关键——`update()` 与「每帧再调一次 `showAt`」是两个都会跑的调用点（`WorldMapRendererLifecycle.updateGuide` 两个都调），量化相位让它们落在同一个值上，谁都没法把宿主顶回满帧；换成「限流调用方」的写法就挡不住另一个调用点。

**同一个页面里的 A/B/C**（配方 §6 第 9 条：patch `GuideOverlay.prototype` 造出修复前的行为，三次量测之间只差这一处；世界地图 L1、引导 step1 圆环亮着、`Renderer.render` 换空函数、驱 120 帧）：

| | 签名变化 / 120 帧 | ring 几何重建 / 120 帧 | 不同的 alpha 值 / 120 帧 |
|---|---|---|---|
| **修复后** | **39–41**（≈20/s） | **0** | 21（≈10.5/s） |
| 引导整个中和掉（基线） | 22（≈11/s） | 0 | 1 |
| 修复前的行为 | **120**（帧帧变） | **478** | 1（alpha 烘在 `lineStyle` 里） |

读法：引导亮着时，圆环现在**加** ~10 次重绘/秒（10 + 护盾 10 + HUD 1 ≈ 20/s），而不是把 11/s 顶成 60/s；几何一次都不重建了（修复前 478 次/120 帧 = 每帧约 4 次 `geometry.dirty` 递增，因为 `update` 与 `showAt` 各描一次、每次 `clear`+`lineStyle`+`drawRoundedRect`）。

⚠️ **顺带更正本节上一版写的一句话**：当时写「GuideOverlay 还挂在 CityScene 等**已经是 `reactive`** 的场景上，所以这一条今天就在让新手引导期间的菜单以满帧重绘」——**不成立**。CityScene 在 SLG 里永远是 `pushOverlay` 挂在活着的世界地图上（`app/nav/world.ts` 的 `openCity`，ADR-044），而 `paintMode` 对组合取悲观（§2），所以那个组合本来就是 `'live'`。这条 bug 的真实代价是**每秒 60 次白白三角化**（两个宿主都付）＋**把世界地图的签名变化率顶满**（也就是拦住这个开关的那件事）。

### 拨开关（同日下午，可见窗口重取 + 真浏览器验收）

拿到一个真前台标签页后（`document.visibilityState === 'visible'`，怎么拿见 §6 第 8 条）在同机同画布重取，L1、1,844 个舞台对象、引导中和掉：

| 量什么 | 数字 |
|---|---|
| 整 tick（场景 update + 真重绘） | p50 **1.3 ms** / mean 1.41 / max 5.1 |
| 一个**被跳过**的帧仍要付（只有场景 update） | mean **1.51 ms** |
| `stageSignature` 一趟 | mean **0.15 ms** / max 0.3 |
| GPU（`EXT_disjoint_timer_query_webgl2`，20 帧） | **0.708 ms/帧** |
| draw call / 索引（一帧） | **15** / **59,982** |

**这把原来的立论翻了一半，结论仍然是改**：整 tick 1.41 ms 里几乎全是**场景 `update()`**（跳过重绘不跳过它，被跳过的帧照样 1.5 ms），重绘在主线程上的份额低于噪声——所以**主线程这笔账基本是平的**（省 ~5 ms/s 对多付 ~9 ms/s）。真正省下的是 **~49 次/秒的 GL 提交与 present ≈ 35 ms/s 的 GPU 工作**（手机上同一张图的 fill rate 只会更贵）。owner 报的是耗电/发热/风扇而不是帧时间，这个形状正对着那个抱怨。

真浏览器验收（`nw_render_debug=1` 读 `__nwRenderStats`，每档采 3–6 秒）：

| 状态 | tick/s | 重绘/s | skip% |
|---|---|---|---|
| 空闲地图（引导已完成） | 58.5 | **10.0** | **82.9** |
| 空闲地图（引导圆环亮着） | 58.7 | 16.5–18.7 | 68–72 |
| 拖动平移中 | 58.9 | **58.9** | **0** |
| 城池面板（overlay）压在地图上 | 58.6 | 18.0 | 69 |

画面同时确认：拖动时地图/云雾斜边界/引导圆环与气泡全跟着相机走、无残留几何；点空地立刻弹占领面板；进出城池面板正常。最后一行是额外收获——`paintMode` 对组合取悲观，地图变 reactive 之后「overlay 压在地图上」这一整类组合也从 100% 重绘掉到 ~30%。

**代价的上界**：有行军在途、或玩家正在拖动时，那 0.15–0.3 ms/帧的遍历是白付的（那些帧本来就要画）。

## 8. 诊断开关在微信上是瞎的（已修，2026-09-08）

`nw_render_debug` / `nw_fps_warn` / `nw_mem_warn_mb` / `nw_gentex_budget` / `nw_tex_budget_mb` / `nw_cpu_busy_warn` / `nw_net_log` 原本各自直接读 `globalThis.localStorage`，外面套一层 `try {} catch {}` 回落默认值。**微信小游戏没有这个全局**（它走 `wx.getStorageSync`，即 `platform.storage`），于是这些开关在微信上永远停在默认值，而且不报错。`nw_render_debug` 尤其要命：重绘率是「按需重绘到底有没有在工作」的唯一读数，而微信恰恰是 ADR-083 三个旋钮里**只有按需重绘能起作用**的宿主（`WechatPlatform.devicePixelRatio` 硬编码为 1，dpr 上限在那边是空操作）。

现在统一走 `src/debugFlags.ts`（`setDebugFlagStorage(platform.storage)` 在 `app.ts` 里、两个 watchdog 装载**之前**调用），形状照抄 `net/anomaly/reporter.ts` 的 `setAnomalyStorage`。门禁两道，都在 `test/debugFlags.test.ts`：行为一道（注入的 storage 要被读到），**机械一道**（`src/` 下除 `debugFlags.ts` 与 `anomaly/reporter.ts` 两个 shim 外，任何文件都不许 `localStorage.getItem('nw_…')`）——后者做过变异验证。

## 9. 真机数字：`render_profile`（ADR-084）

微信打不开控制台，iOS 要接 Safari Web Inspector 才读得到一个全局——所以真机上的帧数/重绘率不能靠「去读」，只能让设备自己报。`cache/PerfMonitor` 本来就在按 2 秒窗口采样 fps（给卡顿告警用），现在健康会话也把这份采样连同 `render/renderStats.ts` 的重绘计数一起报成 `render_profile` 事件（analytics → analyticsvc → Grafana）。

字段：`scene` / `spanS` / `windows` / `fpsP50` / `fpsMin` / `fpsMax` / `maxFps` / `res` / `dpr` / **`dprCapped`** / `canvasW` / `canvasH` / `tickPerSec` / `paintPerSec` / `skipPct`。
`dprCapped`（`dpr > res`）是「ADR-083 的 dpr 上限在这台设备上到底有没有生效」的那一位；`paintPerSec` vs `tickPerSec` 是「按需重绘有没有在工作」的那一对。

量是有界的：**每会话最多 6 条**（首条约 30 秒，之后每约 5 分钟），且只统计全程可见的窗口——后台被节流的标签页会报出假的 4 fps。服务端 `analyticsvc` 里 `render_profile` 采样率 1.0（不采样，否则跨宿主对比就没意义了）。

**⚠️ 2026-09-09 订正：那三个重绘字段一条都没发出去过（已修）。** 线上 `notebook_wars_analytics.events` 里到 2026-09-09 只有**一条** `render_profile`，`fpsP50`/`dprCapped`/`canvasW` 都在，`tickPerSec`/`paintPerSec`/`skipPct` **全缺**。`app.ts` 先构造 `PerfMonitor`（~97 行）、后装 `RenderPolicy`（~143 行），而计数器是后者发布的，于是 `install()` 里那次 `renderStats()` 恒为 `null`，基线为空 → 静默丢字段；第二条（约 5 分钟后）才带上。修法是 `onTick` 里**迟绑定基线**（不是去调 `app.ts` 的顺序——顺序不该由这个模块依赖）。查这类事的入口：

```bash
ssh funny-vps "docker cp /tmp/q.js server-analyticsvc-1:/app/q.js && docker exec server-analyticsvc-1 node /app/q.js"
```

（脚本必须落在容器的 `/app` 下，`/tmp` 里 node 解析不到 `mongodb`；文档字段名是 **`event`** 不是 `name`。）

## 10. 还没做的

1. **iOS / 微信真机仍然没有人拿着手机跑过。** §9 只是把管子接好了（2026-09-09 才真的接通，见那一节的订正）。线上到 2026-09-09 累计 `render_profile` **1 条**，桌面 web、`SettingsScene`。数字要等真机上线（Grafana 里按 `platform` 切 `fpsP50`、按 `scene` 切 `skipPct`；世界地图现在应该报出 ~80% 的 `skipPct`）。功耗（不是帧数）本来也不在客户端能自测的范围内，要靠设备侧的电池统计。
2. **`SettingsScene` 的几个按钮框还在实时描边**（§3 末尾），不在热路径上，搬的时候连带更新 §5 的预算数字。
3. **世界地图那 1.4 ms/帧的场景 `update()` 没人碰过。** ADR-085 之后它是这一帧里剩下的全部——空闲时也每帧跑：HUD 计时器、护盾遍历、token 同步、vignette、引导判定。真要再往下压，下一刀在这里而不在重绘上。（先量再改：那 1.4 ms 是两次量测相减得来的，逐项归因还没做过——`update()` 里逐条读下来没有一处是 O(池子) 的。）
4. **空闲时 tick 本身仍然是 60 Hz。** 按需重绘省掉的是 `render()`，`SceneManager.onTick`（`stepTransition` + `updateMusic` + 每个挂载场景的 `update()`）与 `stageSignature` 照旧每帧跑。真正把空闲功耗再砍一半的旋钮是**连续 skip 若干帧后把 `ticker.maxFPS` 降到 20~30，任何 paint/hold 立刻回 60**——代价是网络推送最坏晚 50 ms 到画面（看不出来），收益是空闲主线程直接除以二到三。同一方向的第二半是**装饰动画在长时间无输入后静默**（大厅火柴人 12 fps、boil 8 fps、护盾气泡 10 fps 现在就是空闲重绘率 5~12/s 的全部来源；它们停下来，空闲重绘率就只剩 500 ms 地板的 2/s）。
5. **`powerPreference` 没设。** `new PIXI.Application` 没传它，@pixi/core 的默认值是 `'default'`（`ContextSystem` 的 `settings.RENDER_OPTIONS`），也就是把选择权交给浏览器。双 GPU 的 Intel Mac 上这是「风扇加速」的经典嫌疑之一（`'low-power'` 请求集显）；Apple Silicon 单 GPU 上无效，所以这是**便宜的对冲、不是已证实的病因**。这个客户端一帧 18k 索引 / 0.5 ms GPU，集显绰绰有余。
6. **`net/rateGate.ts` 的 200 ms 补桶定时器是常开的**（构造即 `setInterval`，永不 `clear`），零流量时也每秒醒 5 次。ADR-083 之前它被 60 Hz 的重绘完全盖住，现在空闲重绘只有 5~12/s，它的相对占比反而上来了。改成「只在 `tokens < CAPACITY` 或队列非空时才跑」即可，注意别把 `tryAcquire` 的同步语义弄坏。
