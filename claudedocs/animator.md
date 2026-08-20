# 动画编辑器（tools/animator）

设计文档：`design/tools/animator/REQUIREMENTS.md`（§2 §3 §8）、`ARCHITECTURE.md`（§1 §2 §5 §3）。`WORKSPACE_SYNC.md` 描述的 Supabase 云工作区 + `anim-sync` 每日同步 CI 已于 2026-08-02 移除（方向已被 desktop-shell 取代，见 ADR-055），该文档仅存历史参考

```bash
cd tools/animator && npm run start   # 端口 9091
```

## 测试（2026-08-13 新增，此前 tools/ 全零测试基建）

`npm test`（vitest，node 环境）+ `npm run typecheck`（`tsconfig.test.json`，把 `test/**` 拉进同一个 tsc program，同 `client/tsconfig.test.json` 的漂移防护）。54 条用例覆盖 `io/{fileIO,clipSerialization,editorProject,taoExport}.ts`（IOController 拆分出的四个模块，见下方"主要源文件"）：

- **`clipSerialization.test.ts`**（6 条）：纯函数，直接跑，无需任何 stub。
- **`fileIO.test.ts`**（24 条）：`clamp01`/`basename`/`deriveTaoPath` 纯函数直测；`isDesktop`/`saveWithPicker`/`canvasToBlob`/`loadImageFromBlob` 用 `vi.stubGlobal` 桩 `window`/`document`/`Image`/`URL`（同 `client/test/anomaly-chain.test.ts` 的桩全局驱动真实函数体思路），驱动真实实现而非 mock 掉整个函数。
- **`editorProject.test.ts`**（13 条）/**`taoExport.test.ts`**（11 条）：`AppState`/`AnimationController`/`CommandManager`/`EventBus` 全部用**真实类实例**（零 PIXI 依赖）；`JSZip` 也是**真实包**，跑真 zip round-trip（不是断言"调用了 JSZip.xxx"）。唯一的假对象是 `ImageController` 的手搓替身（只覆盖 `getBlob`/`setBlob` 两个签名）——真实类会触达 `pixi.js` 纹理创建，animator 没有 client 那套 `pixiHeadless.ts` headless PIXI 适配层，这次不新建。`window.nwDesktop.fs`（桌面壳）/`window.showSaveFilePicker`（浏览器 File System Access）两条路径都覆盖。
  - **JSZip 在纯 Node 读 Blob 需要 `FileReader` 桩**：`generateAsync({type:'blob'})` 产出的是真 Blob，但 `JSZip.loadAsync(blob)`/`zip.file(name, blob)` 内部走 `utils.js`'s `prepareContent`，只有全局 `FileReader` 存在时才会读 Blob 内容——纯 Node 没有这个全局。两个测试文件都用一个基于 Node 原生 `Blob.arrayBuffer()` 的极简 `FileReader` 桩类解决，不需要 mock JSZip 本身。改用 `blob.arrayBuffer()` 喂给 `JSZip.loadAsync` 可以绕开这个桩，但 production 代码的公开签名就是收 `Blob`，桩 `FileReader` 更贴近真实调用路径。

**其余 4 个 `tools/`（level-editor/vfx-editor/map-editor/ops）同批加了同款 `vitest.config.ts`+`tsconfig.test.json`+`npm test`/`npm run typecheck`**（map-editor 此前已有全套，7 文件 125 条，未改动）。level-editor/vfx-editor/ops 目前只各补了 1 个纯逻辑模块的真实覆盖（`units.ts`/`color.ts`/`pages/shared.ts` 的 ms↔本地时间helper），作为"先搭基建"而非地毯式覆盖——这几个工具其余代码几乎全是 PIXI 构造期取纹理 / DOM 挂载期 `getElementById`，同 animator 一样没有 headless 适配层，具体测试内容留给各自后续任务按需补，不在这轮无边界展开（决策记录见 `MEMORY.md` 对应会话）。`.github/workflows/ci.yml` 的 "tools:" job 已同步改成对全部 5 个跑 `typecheck`+`test`（原来只有 map-editor/ops 有 typecheck、只有 map-editor 有 test）。

**逐步补测试 Phase 1（2026-08-13 同日追加）**：按"纯逻辑、零 PIXI/DOM 依赖"优先级，补了三个工具里逻辑密度最高、此前 0 覆盖的模块（决策：`MEMORY.md` 对应会话）：

- `animator`：`interpolate.test.ts`（18 条，`applyEasing` 四种曲线 + `interpolateBone` 的 identity-default 兜底 + `sampleClip` 的"每根骨骼独立找最近前/后关键帧"两遍扫描——骨骼可以只出现在部分关键帧里，属于合法的稀疏 delta 格式，専門测了"更远的关键帧也提到同一根骨骼但不能被误选中"这个边界）、`presets.test.ts`（9 条，6 个内置预设的时间轴单调性 + `clonePreset` 深拷贝）、`unitSize.test.ts`（6 条，`TARGET_SCREEN_PX`/`SUPERSAMPLE`/`SIZE_TIER_LABELS` 三个跟 `client/src/render/unitSize.ts` 手动同步的镜像常量，只钉自身内部一致性，跨包漂移测不到）。累计 87 条。
- `level-editor`：`EditorState.test.ts`（32 条）——关卡编辑核心状态机：波次/护送路径/地块遮罩/车道开关的全部增删改，以及每个 mutator 自带的归一化规则（清空默认值时把容器字段整个删掉，导出 JSON 才不会留 `cellMask: {}` 之类的空壳）。同批把 `vitest.config.ts` 头注释更新为反映新范围。
- `vfx-editor`：`EffectModel.test.ts`（34 条）+ `paramHints.test.ts`（10 条）——特效数据模型的 undo/redo（含 `HISTORY_CAP=80` 溢出丢弃最旧快照的边界）、layer/param CRUD 及各自的条件默认值（如 `setLayerType` 只在字段缺失时才补默认值，不会覆盖已有的）、`metrics()` 的四类性能预算 warning。`paramHints.ts` 钉住 `COUNT_PRIMITIVES`/`POINTS_PRIMITIVES`/`EMITTER_PRIMITIVES` 三个集合的成员关系（`emitter` 是唯一同时属于两个集合的类型）。`vitest.config.ts` 新增 `@vfx` alias（指向 `client/src/render/vfx`，`EffectModel.ts` 的数据类型源头）。

四者其余部分（`core/{AppState,CommandManager,EventBus}.ts`、`interaction/`、`rendering/`、`ui/*`、ops 的 18 个 `pages/*.ts`、level-editor 的 `board/`/`inspector/`/`timeline/`）留给后续 Phase，按"状态管理类→业务页面→渲染/交互层"的性价比顺序推进。

**逐步补测试 Phase 2（2026-08-13 同日追加）**：状态管理类的直接契约测试（此前只被 IO 测试当真实依赖捎带跑过，从未钉过自己的边界）：

- `animator`：`EventBus.test.ts`（10 条，`on`/`off`/`emit` 的 Set 去重、void-payload 事件、mid-emit 自退订不影响其他订阅者）+ `CommandManager.test.ts`（12 条，真实 `EventBus<AppEvents>` 实例；execute/undo/redo 的 LIFO 顺序、`undoLabel`/`redoLabel` 兜底文案、`clear()` 恒发事件、**`MAX_STACK=100` 溢出边界**——push 101 条命令后 undo 100 次，最早一条已被挤出栈，最终停在第 2 条的状态而非第 1 条）。累计 109 条。
- `vfx-editor`：`ProjectStore.test.ts`（7 条）+ `Library.test.ts`（25 条）。`ProjectStore.ts` 新增 `fake-indexeddb`（`^6.2.5`，仅 vfx-editor 的 devDependency）驱动真实（内存态）IndexedDB，不是手搓 store API 的假对象——同 animator 用真 JSZip 的思路。**踩坑记录**：最初用 `indexedDB.deleteDatabase()` 做每测试重置，六个用例集体挂死——`ProjectStore` 从不 `close()` 它开的连接，delete 请求撞上仍存活的连接只会触发 `onblocked` 从不真正 `onsuccess`，而 fake-indexeddb 会把同名 db 后续的每个 `open()`/事务排到这个"卡住的 delete"后面，一直挂到 hook 超时（用一个不建立在 `ProjectStore` 之上的最小复现脚本单独钉死了这个成因）；换成"开一条短命连接、`clear()` 该 object store、立即 `close()`"就不再卡死。`Library.test.ts` 为了能用 `vi.useFakeTimers()`（否则要真等 `DEBOUNCE_MS=1200ms`）又踩了第二个坑：**fake timers 和 `fake-indexeddb` 混用会直接挂死**（`fake-indexeddb` 内部异步模拟自己也是靠计时器排队的，被接管后再也不会被排到）——单独脚本复现确认后，`Library.test.ts` 改用一个只实现 `list/get/put/delete/count` 五个方法的内存态 `FakeStore`（`ProjectStore` 本身的正确性已经在它自己的测试文件里用真 IndexedDB 钉过了），`window`/`document`/`localStorage` 走 `vi.stubGlobal`（同 `fileIO.test.ts` 先例）。覆盖 `bootstrap`（seed builtins/恢复 lastId/回退最新一条）、`switchTo`/`createNew`/`duplicateActive`/`removeActive` 的真实状态转移、**`suspended` 标志**（`loadFresh` 期间 model 自己的 `emit()` 不能反过来把刚加载的项目标脏——这条防护只有在"切换到另一个已经激活过的项目"时才可观察，第一次 switchTo 因为 `currentId` 还是 `null` 会被另一条 guard 掩盖，写检验测试时专门补了这个区分）、debounce 合并连续编辑为一次落盘 + 显式 `clearTimeout` 重排（对每条关键断言都做了 red-then-green 实测：临时删掉对应源码行确认测试真的会红，再还原）、tab hide/close 时的兜底 flush。累计 89 条。

**逐步补测试 Phase 3（2026-08-13 同日追加）**：`ops/pages/*.ts` 的纯函数抽取（18 个 page 文件里挑计算/格式化密度高的，DOM 拼装 `h()` 不测）。原计划点名的 `pvpBalance.ts`/`suspicions.ts` 确实有值得测的纯函数（`winRate`/`fmtStats`），但 `slgSeason.ts`/`auctionAudit.ts` 翻开一看只是内嵌在 DOM 行构建函数里的 status→CSS-class 单行查表，没有独立纯逻辑；于是改从 `tickets.ts`（`describeTarget`/`describeAttachments`）、`events.ts`（`eventStatus`，时间相关，`vi.setSystemTime`）、`flags.ts`（`parseList`）、`gachaPools.ts`（`emptyDraft`/`draftFromPool`/`poolStatus`）、`appeals.ts`（`fmtSnapshot`，期望值用同样的 `toLocaleString()` 生成，不写死本地化字符串）、`analytics.ts`（`pct`）里补。9 个文件各加 `export`（零行为变更）+ 同名测试文件，共 51 条，`tsc --noEmit -p tsconfig.test.json` 干净。`vitest.config.ts` 头注释同步更新。

**逐步补测试 Phase 4（2026-08-13 同日追加）**：渲染/交互层——决定不建 headless-PIXI harness（成本高、`client/test/harness/pixiHeadless.ts` 本身也明确不建 `PIXI.Renderer`/`Application`，animator 用的还是非 `-legacy` 的 `pixi.js`，适配成本更高），改为只抽取"虽然身处 PIXI/DOM 重文件、但实际零 `this`/canvas/window 依赖"的纯逻辑seam：
- `vfx-editor/rendering/Playback.ts`——预览时钟，本来就 100% 纯（无 PIXI/DOM import），直接补测试，`Playback.test.ts`（10 条：`advance` 的时长比例推进/wrap-around 循环/暂停短路/duration≤0 兜底，`scrubTo` 的 [0,1] 钳制，`toggle`/`setPlaying`）。
- `vfx-editor/ui/ParamPanel.ts`——`formOf`/`firstValue`/`lastValue`/`sortKfs` 从模块私有加 `export`，`ParamPanel.test.ts`（15 条：三种 track 形态识别、常量/两点/关键帧互转的取值兜底、`sortKfs` 不修改入参）。
- `animator/timeline/TimelineView.ts`——`getKfColors`（REQUIREMENTS.md §2.6 配色图例：平移橙/缩放蓝/仅旋转或全空灰，可叠加）加 `export`，`TimelineView.test.ts`（10 条）。
- `animator/interaction/InteractionController.ts`——`pointToSegmentDist`（模块级几何函数，加 `export`）+ `findBoneAt`（原是 private 方法但方法体完全不读 `this`，等价提成模块级自由函数，类里留一行委托）。`InteractionController.test.ts`（9 条）用**真实** `Skeleton.computeFK(0,0,new Map())` 静息姿势坐标（而非手造坐标）验证 head 命中圈、骨骼线段命中、脱靶返回 null。
- `level-editor/board/BoardPanel.ts` + `timeline/TimelinePanel.ts`——这两个文件其实完全没用 PIXI（`level-editor` 压根没这个依赖，只有原始 `canvas.getContext('2d')`），是这轮最大的一块：`rowToY`/`cellAt`/`laneHeaderAt`/`cellCenter`/`hitHandle`/`baseTint`（`BoardPanel.test.ts`，24 条）与 `tickToX`/`xToTick`/`laneIndex`/`yToLaneIndex`/`entryEndTick`/`hitTest`（`TimelinePanel.test.ts`，16 条）从读 `this.cell`/`this.header`/`this.pxPerSec`/`this.scrollX` 的 private 方法，改造成显式传参的模块级纯函数（行为不变，每个调用点同步改成委托），`Handle`/`C`（调色板）/`GUTTER_W`/`RULER_H`/`LANE_H` 一并导出供测试直接比对，不写死字面量。**收尾前额外做了真实 dev-server 抽查**（不是只信单测）：起 `level-editor` 起 `npm run start`，加载示例关卡后用 `dispatchEvent` 模拟真实鼠标点击（因为这个环境的 Browser pane 不支持截图，退化成读 canvas 像素而非看图）——点一个 attack-lane 格子命中的颜色精确匹配 `C.attack`（`#26263c`），刷成 no-build 笔刷后混色结果和 `rgba(249,226,175,0.22)` 叠加公式手算的期望值只差 1 个色阶（抗锯齿舍入），车道开关的 header 点击也从 `C.laneOn` 精确翻到 `C.laneOff`——证明"点击→命中测试→改状态→重渲染"整条链路和重构前完全一致；`animator` 同样起了 dev server 做多点位点击回归，未见任何运行时异常。四工具其余部分（`Renderer.ts`/`ContextMenu.ts`/`ui/*` 面板类的构造与拖拽拼装、`PreviewRenderer.ts` 的 `new PIXI.Application`、`BoardPanel`/`TimelinePanel` 类本身、`index.ts`/`inspector/*`）仍是纯 DOM/PIXI 构造期胶水代码，留白，无 headless 适配层可用。

累计：animator 128 条、vfx-editor 114 条、level-editor 77 条（以上均含 Phase 1-4）、ops 51 条（Phase 3，含此前 bootstrap 的 `shared.test.ts` 6 条）。

## 删除重构前的扁平死模块（2026-08-20）

`src/` 根目录下重构前的一整套同名扁平模块被删除，共 **13 个文件 / 1424 行**：`animation.ts`(182)、`events.ts`(42)、`interaction.ts`(147)、`io.ts`(102)、`presets.ts`(80)、`renderer.ts`(217)、`skeleton.ts`(81)、`state.ts`(97)、`timeline.ts`(190)、`types.ts`(43)、`ui.ts`(239)，加两个只有 `export {}` 的空壳 `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`（注释自称已被 `images/ImageController.ts`/`ui/ImagePanel.ts` 取代）。这批文件只互相 import，从 webpack 唯一入口 `./src/index.ts` 完全不可达——`renderer.ts` 里的 `from './skeleton'` 按 Node 解析规则命中 `src/skeleton.ts`（`src/skeleton/` 下没有 `index.ts`），而不是活代码用的 `src/skeleton/Skeleton.ts`，于是整批构成一张自闭合的死图。范式也完全不同：死图是"模块单例 `state` + payload 为 `unknown` 的字符串常量事件总线"，活代码是"类 + `EventBus<AppEvents>` 强类型总线"。

**可达性是独立复核过的，不是照抄清单**：写了一次按 tsconfig 解析规则（相对路径 + `baseUrl: ./src` 非相对路径，候选序 `X.ts` → `X/index.ts`）的 import 图遍历，起点取全部三类入口——`src/index.ts`（webpack 唯一 entry）、`runtime/StickmanRuntime.ts`（**不在 `src/` 下，是单独产物，必须单独当根**）、`test/**/*.test.ts` 全部 11 个文件；43 个活文件全部可达，剩下的正好是这 13 个 + `src/globals.d.ts`（ambient 声明文件，无人 import 但 tsc 需要，**保留**）。另外全库 grep 过这批路径名与 `AtlasController`/`AtlasPanel`，命中的全是目录版（`src/io/**`、`src/skeleton/Skeleton.ts`），无一处指向扁平版。

**最硬的一条证据**：删除前后跑 `npm run build`，production bundle 的 contenthash 与文件名完全一致（`bundle.04a1b40b5390a85f7d41.js`，653357 字节）——即这些文件从未进入产物，删除对线上零影响。`npm run typecheck` / `npm test`（128 条）/ `npm run build` 三项删除后全绿，用例数与删除前一致（这批死文件本来就没有测试）。

**dev server 抽查**：起 9091（本次为避端口冲突起在 9191）加载编辑器，与主检出未修改版本（起在 9192）跑同一段 DOM 事件驱动脚本逐步对比——新建 clip（含 `Undo: Create clip "…"` 标签）、打/删关键帧、`Ctrl+Z`/`Ctrl+Shift+Z`、改 duration、切动画、重命名、删 clip 后回落 `idle`，两侧**每一步的 status 文案与列表状态完全一致**，双方 `errors` 均为空。**注意这个环境的坑**：Browser pane 不 compositing，页面 `document.visibilityState === 'hidden'` 且 `requestAnimationFrame` 永不触发，于是 PIXI ticker 冻结 → 主 canvas 停在 0×0、`#tl-labels` 一行不渲染（`TimelineView.render()` 只在主循环里被调用）。这**不是**回归——未修改的主检出版本表现一模一样；同样原因截图也拿不到（同 Phase 4 的记录），可见性验证只能退化成 DOM 事件驱动 + 与基线逐步比对。

**覆盖率变化**（同一 `@vitest/coverage-v8` provider，`--no-save` 装的，不改 `package.json`）：

| 统计范围 | 删除前 | 删除后 |
|---|---|---|
| whole-package（coverage 默认 include，含 `runtime/StickmanRuntime.ts`） | 21.92% | **27.53%** |
| 仅 `src/**` | 22.70% | **28.77%** |
| ADR-070 committed scope（`src/{core,skeleton,animation,io}/**`） | 61.37% | 61.37%（不变） |

前两行涨的就是这 1424 行 0% 死码退出分母；第三行不动，因为死文件全在那份 whitelist 之外——**ADR-070 的 CI 门禁数字不受本次删除影响**，别指望它变。ADR-070 会话里提到的"删除前 23.53%"在本分支复现不出来（本分支基于 `main`），因为那份 worktree 还带着未提交的 Phase 4d `interaction/InteractionController.ts` + 其测试改动，分母/分子都跟 `main` 不同；上表三行都是同一棵树上前后两次实测，自洽可比。


## 参数两层模型

**Binding（静态，所有帧共用）**：`anchorX/Y`（挂点比例，允许超出 0–1）、`rotation`（静态偏移）、`scaleX/Y`、`flipX`、`zOrder`

**Keyframe（动态，逐帧）**：`rotation`（delta）、`translateX/Y`、`scaleX/Y`、`alpha`

渲染公式：`sprite.rotation = bone_FK_angle + binding.rotation`（bone_FK_angle 已含 keyframe.rotation，不可重复叠加）

## 架构要点

- **11 根固定骨骼**：root → spine → head / 4 臂 / 4 腿
- **FK**：`Skeleton.computeFK(rootX, rootY, transforms, lengthScales?)` 纯函数；hit-test 须传 `state.boneLengthScales`
- **关键帧插值**：`sampleClip(clip, t)` 无外部依赖，可复制到游戏引擎
- **导出格式**：`.tao`（JSZip + spritesheet.png + animation.json v2）；`.tao.editor`（保留原始图 + 编辑状态）。Load 记住文件身份（桌面壳路径 / 浏览器 File System Access handle），Save 直接覆盖、Export 直接落到同目录，都不重复弹框；"导入 .tao" 已移除，换成"另存为"（存一份新 `.tao.editor` 并把之后的 Save/Export 目标切过去）
- **多工程自动保存**：IndexedDB 库 `nw-animator`（`meta`+`blobs` 两 store），脏事件停手 1.5s debounce 静默存当前工程，启动恢复上次工程；底部栏工程下拉 + 增删改复制 + 状态点。编排见 `AutoSaveController`，存储见 `ProjectStore`，UI 见 `ProjectPanel`（设计 §11）。**注意**：浏览器本地存储，换浏览器/清缓存即失；重要成果仍需 `Save .editor` 导磁盘。`Load .editor` 会覆盖当前选中工程
- **骨骼长度**：`AppState.boneLengthScales`（稀疏 Map）序列化进两种格式
- **编辑器模式**：`'skin'`（静息姿调 Binding）/ `'animate'`（关键帧编辑）；快捷键 `S`
- **静息姿约定**：角色朝右，`r_`（解剖右）= 屏幕左，`l_`（解剖左）= 屏幕右

## 快捷键

| 键 | 动作 |
|---|---|
| `Space` | 播放 / 暂停 |
| `K` | 打关键帧 |
| `Delete`/`Backspace` | 删选中关键帧 |
| `Tab` | 切换 Skeleton / Sprite 预览 |
| `S` | 切换 Skin / Animate 模式 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |

## 事件总线（核心事件）

`bone:select`、`bone:rotate`、`time:change`、`play:state`、`anim:select`、`anim:list`、`kf:change`、`images:change`、`binding:change`、`attachment:change`、`rig:change`、`preview:mode`、`editor:mode`、`history:change`、`status`、`error`、`pose:reset`

**消息分流**：`status`=低风险进度提示（Saving…/Loaded/Ready）→ 底部 `StatusBar`（3s 自动清）；`error`=失败/被阻止的操作（保存/载入/导出失败、版本不支持、未选动画、重名等）→ 顶部居中红色浮层 `ErrorToast`（可手动 ✕，8s 自动消，多条堆叠）。新增错误务必发 `error` 而非 `status`，避免被一闪而过淹没；原生 `alert()` 一律改走 `error`。

渲染层级（从下到上）：`gridGfx → onionGfx → boneGfx → spriteLayer → overlayGfx → selGfx`

## 主要源文件

| 文件 | 职责 |
|---|---|
| `src/App.ts` | 组合根，连接所有模块，主循环 |
| `src/rendering/Renderer.ts` | PixiJS 渲染（骨骼 + sprite + 挂点） |
| `src/skeleton/Skeleton.ts` | 骨骼定义 + FK 计算 |
| `src/animation/AnimationController.ts` | clip CRUD + 播放 + 关键帧操作 |
| `src/animation/interpolate.ts` | `sampleClip` 插值（无依赖，游戏侧共享） |
| `src/images/ImageController.ts` | 逐张 PNG 导入、Blob + PIXI.Texture 管理 |
| `src/io/IOController.ts` | 装配壳（2026-08-13 起，`单文件 500 行收敛` form①，771→123）：只留 `editorFilePath`/`editorFileHandle`/`taoFileHandle` 三个磁盘身份字段 + 两个 host builder，逻辑全下沉到 `src/io/{fileIO,clipSerialization,editorProject,taoExport}.ts` |
| `src/io/fileIO.ts` | 磁盘 / File System Access API 工具函数（`isDesktop`/`saveWithPicker`/`basename`/`deriveTaoPath` 等），纯函数，无需 host |
| `src/io/clipSerialization.ts` | clip↔JSON 互转（`serializeClip`/`deserializeClip`），纯函数，无需 host |
| `src/io/editorProject.ts` | `.tao.editor` 存档读写（`buildEditorBlob`/`loadEditorBlob` 复用），`EditorProjectHost` |
| `src/io/taoExport.ts` | `.tao` 导出 + 贴图烘焙 + 精灵表打包，`TaoExportHost`；桌面壳 `window.nwDesktop.fs` / 浏览器 File System Access API 双路径 |
| `src/io/ProjectStore.ts` | IndexedDB 工程库（`meta`+`blobs` 两 store） |
| `src/io/AutoSaveController.ts` | 多工程自动保存 + 切换 + 启动恢复 |
| `src/ui/ProjectPanel.ts` | 底部栏工程下拉 + 增删改复制 + 自动保存状态点 |
| `src/ui/StatusBar.ts` | 底部低风险进度提示（`status` 事件，3s 自动清） |
| `src/ui/ErrorToast.ts` | 顶部居中错误浮层（`error` 事件，红色卡片，可 ✕，8s 自动消） |
| `src/timeline/TimelineView.ts` | Canvas 时间轴渲染 + 交互 |
| `src/interaction/InteractionController.ts` | 鼠标拖拽 + 键盘快捷键 |
