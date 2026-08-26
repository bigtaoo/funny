# 动画编辑器（tools/animator）

设计文档：`design/tools/animator/REQUIREMENTS.md`（§2 §3 §8）、`ARCHITECTURE.md`（§1 §2 §5 §3）。`WORKSPACE_SYNC.md` 描述的 Supabase 云工作区 + `anim-sync` 每日同步 CI 已于 2026-08-02 移除（方向已被 desktop-shell 取代，见 ADR-055），该文档仅存历史参考

```bash
cd tools/animator && npm run start   # 端口 9091
```

## 测试（2026-08-13 新增，此前 tools/ 全零测试基建；2026-08-20 接入 90% 门禁）

**当前状态（2026-08-20，ADR-070 Phase 4d）**：`340` 例，受门禁的 scope（`coverage.include` = `src/{core,skeleton,animation,io}/**`）行覆盖 **98.9%（1426/1442）**、函数 191/195，包已从 `NOT_GATED_JSON_SUMMARY_PACKAGES` 移进 `JSON_SUMMARY_PACKAGES`（`scripts/coverageLib.mjs`），**百分比现在真的会判红 CI**。全包 42.9%（`--coverage.include='**'`）。口径与逐工具台账见 [`tools-testing.md`](tools-testing.md)；本轮的取舍细节见下方「Phase 4d」。

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

累计（2026-08-13 收尾时）：animator 128 条、vfx-editor 114 条、level-editor 77 条（以上均含 Phase 1-4）、ops 51 条（Phase 3，含此前 bootstrap 的 `shared.test.ts` 6 条）。**这四个数都已过时**——2026-08-20 的 ADR-070 Phase 4a–4d 分别把 map-editor / level-editor / vfx-editor / animator 推到了 90% 门禁之内（animator 138 → 340 例，见下方「Phase 4d」）；当前值以 [`tools-testing.md`](tools-testing.md) 的台账为准。

## Phase 4d：补满 ADR-070 scope 并接入门禁（2026-08-20）

138 → **340 例**，scope 内 64.3% → **98.9%**。五个工具里未覆盖行最多的一个（515 行），也是唯一**不需要抽模块**的一个——`include` 一直是目录级，缺的纯粹是测试。新增/扩充：

| 文件 | 例数 | 从 → 到 | 关键点 |
|---|---|---|---|
| `test/AnimationController.test.ts` | 57 | 41.3% → 100% | clip/关键帧 CRUD + 播放时钟。`requestAnimationFrame`/`cancelAnimationFrame` 用一个**可控** stub（排队的回调只在测试调 `step(ts)` 时跑，一次一帧），所以 `tick()` 推进的是测试给的时间戳而不是墙上时间；loop 取模、非 loop 夹到 duration 并停止重排、pause 后迟到的一帧什么都不做、pause→play 重新取基线都各有一例 |
| `test/AutoSaveController.test.ts` | 41 | **0% → 100%** | debounce 合并、tab 隐藏/关闭兜底 flush、工程库增删改切、启动恢复。用内存态 `FakeStore` 而不是 `fake-indexeddb`——原因见下 |
| `test/ProjectStore.test.ts` | 14 | **0% → 100%** | 真（内存态）IndexedDB，`fake-indexeddb`。**全文不用 fake timers** |
| `test/IOController.test.ts` | 16 | **0% → 100%** | 工具栏接线 + 两个 host builder 的 getter/setter 对 |
| `test/AppState.test.ts` | 22 | 81.5% → 100% | 每个 setter「发不发事件」——`rig:change`/`binding:change`/`attachment:change` 同时是 `DIRTY_EVENTS` 成员，所以「这次改动发不发事件」就是「这次编辑存不存盘」 |
| `test/Skeleton.test.ts` | 20 | 89.0% → 100% | `computeDefaultShadowSize` 此前 0 覆盖；FK 与 `computeNaturalHeight` 的期望值从 `BONE_MAP`/`computeFK` 反推而不是抄像素数 |
| `test/editorProject.test.ts` | +18 (→31) | 71.4% → 100% | `triggerLoadEditor` 的三路分流 + 首次保存/另存为的磁盘身份路径 |
| `test/fileIO.test.ts` | +1 (→25) | 96.5% → 100% | `primaryExt()` 的「types 里没有扩展名」那条臂 |
| `test/pureLayerBoundary.test.ts` | 13 | 新增 | graduation 要求的边界守卫，见下 |

- **`fake-indexeddb` 与 fake timers 只能二选一，所以两份文件分工**：`ProjectStore.test.ts` 跑真库（照 vfx-editor 先例）；`AutoSaveController` 的每条有意思的行为都绕着 `DEBOUNCE_MS = 1500` 转，**必须** `vi.useFakeTimers()`，而两者混用会挂死到 hook 超时（`fake-indexeddb` 自己的异步模拟也排在真计时器上——本文档上方 Phase 2 那条踩坑记录写的就是这个，vfx-editor 的 `Library.test.ts` 撞过同一面墙），于是换成只实现 `listMeta`/`getBlob`/`put`/`putMeta`/`delete` 的内存态 `FakeStore`，顺带能数写入次数。**这个分工写在两份文件的头注释里**，免得后来人「统一一下」——把 ProjectStore 也换成 FakeStore 就没人测真库了，给 AutoSaveController 换成真库就挂死。
- **`IOController.test.ts` 的 mock 方向跟 `editorProject.test.ts` 是反的，这是故意的**。后者什么都不 mock（真 JSZip、真 `AppState`/`AnimationController`）；前者把 `editorProject`/`taoExport` 两个流程模块整个 mock 掉。因为 2026-08-13 拆分之后（771 → 123 行）这个类只剩三件事：五个 `document.getElementById(...)?.addEventListener(...)`（id 写错就是一个静默死掉的按钮，`?.` 把 miss 吞了）、两个 host builder 的 getter/setter 对（「一次 load 清掉 `editorFilePath`、一次磁盘保存设上它，且真的写回 IOController 自己的字段」的唯一实现方式）、以及「哪个入口把哪个 host 交给哪个流程」。把流程当边界 mock 掉，这三件事才第一次可观测。顺带钉住 `taoExportHost` **比** `editorProjectHost` **窄**（无 `cmdManager`；`editorFilePath`/`editorFileHandle` 只有 getter）。
- **`test/pureLayerBoundary.test.ts`：接门禁不等于边界有人守**。门禁余量 = `covered/0.9 - total` = **142 行**（map-editor 72、level-editor 49、vfx-editor 58），实测把一个 **143 行** 的 0% PIXI+DOM 探针丢进 `src/animation/`，`All files` 90.08%、**门禁照过**，而守卫三条断言当场红。这个包的判据跟前三个都不同：
  - **DOM 四层，默认拒绝**：`core`/`skeleton` 零浏览器 API、`animation` 只许 `requestAnimationFrame`/`cancelAnimationFrame`、`io` 一份 20 项显式清单（磁盘/IndexedDB/File-System-Access，天然长但封闭）。另有一份 `FORBIDDEN_GLOBALS`（`PIXI`、`CanvasRenderingContext2D`、`ResizeObserver`、`MouseEvent`/`WheelEvent`/`KeyboardEvent`…）独立于逐目录白名单再判一次——放宽某个目录也不可能顺带放进 PIXI。清单是把 impure 半边用到的 global 减去 pure 半边用到的**实测**出来的，不是照抄。
  - **值导入与类型导入分开判**：值导入只许 `jszip` + 纯目录内部；类型导入额外允许**恰好一个** specifier `../images/ImageController`（host 接口必须指名这个持有 `pixi.js` 的类，无处可搬——跟 4a 把 `TerrainTextureName` 搬出 map-editor 渲染器不矛盾，那里被指名的是个配色类型），并**专门断言不许把它改成值导入**。
  - **`runtime/` 只许伸进受守目录**：`runtime/StickmanRuntime.ts` import `core/types`/`animation/interpolate`/`skeleton/Skeleton`，所以「纯层保持 PIXI-free」是「第二个产物编得过」的前提，不是抽象偏好。
  - 7 条断言各做过 red-then-green（PIXI 值导入、跨界类型导入、类型导入改值导入、纯目录改名、`coverage.include` 加第五个目录、`runtime/` 伸出界、`codeOnly()` 不再剥字符串）。字符串剥离用逐字符扫描器而不是正则交替——事件名 `'history:change'` 会让 `\bhistory\b` 误报，而正则交替在转义引号处会级联错位（4b 记过）。
- **补完覆盖率之后又抽查了「测试真的会红吗」**：对生产代码做 16 处单点变异、跑对应测试、还原。第一轮 12 红 **4 绿**，四处各有各的原因，都值得记住：
  1. `AutoSaveController.remove()` 的 `clearTimeout` 删掉照绿——两条收尾路径最后都会把 `dirty` 清掉，残留计时器醒来撞上 `if (!this.dirty) return`。改成断言**机制**：`expect(vi.getTimerCount()).toBe(0)`。
  2. `flushNow()` 的 `clearTimeout` 同理。
  3. `pasteKeyframe` 的深拷贝删掉照绿——`copyKeyframe` 进剪贴板时已经拷过一次，所以「改源关键帧不影响粘贴出来的」全都还成立。真正靠第二次拷贝的是「同一份剪贴板粘两次，两个关键帧不共享 bones Map」，补上就红。
  4. `computeDefaultShadowSize` 的 `Math.max(4, …)` 地板**不可达**（w≈54 → `ceil(w*0.3)`≈16）。原断言把整个表达式含地板照抄了一遍，看着像覆盖其实什么都没钉；改成只断言 0.3 比例 + 一句「地板对固定 11 骨骼 rig 不可达」的注释。同 map-editor 的 `clampPan`/`lerpHexColor` 一类。
- **顺手订正两处文档谎，零行为改动**：①`Skeleton.computeNaturalHeight` 的注释说「没有 clip 时返回 0」——不对，`scan(new Map())` 无条件跑，空 clip 列表返回静息姿高度（实测 169.007），`: 0` 那条兜底要求 rig 没有竖直跨度，固定 11 骨骼给不出。**`client/src/render/stickman/skeleton.ts` 那份手抄件抄的是同一句错话**，两份注释各自都写着「与另一份保持同步」，所以一起改。②`vitest.config.ts` 头注释说 Phase 4d 是「抽 `pointToSegmentDist`/`getKfColors`」——ADR-070 的 4d 其实是本轮这个测试缺口，那个抽取没有排期。
- **剩下 16 行不补**：`io/taoExport.ts` 的贴图烘焙（`document.createElement('canvas')` + `ctx.drawImage`），是这个 scope 里唯一真需要 headless canvas 的地方。
- **可见性核对退化成数值核对**（Browser 窗格不 composite、截图 5s 超时，同下一节；dev server 起在 **9191**，默认 9091 被 Docker Desktop 双栈占着）。核对的是跟本轮测试同构、且同时跑真 IndexedDB + 真 JSZip 的那条链路——自动保存往返：空库开机自动建 `Untitled` 并落盘；rename 后 **`meta.name` 变、blob 字节数不变（984 → 984）**（证明真走的是 `putMeta` 而非 `put`）；新建工程 → 新 uuid + 新 blob、旧工程不动、下拉按 `updatedAt` 倒序重排；**1.5s 窗口内连打三次编辑，`updatedAt` 一次都没变，窗口后只变一次**，blob 1034 → 1048；切工程/切回来内容各自恢复、`localStorage` 跟着走；**刷新页面恢复上次工程连新建的 clip 一起**。全程无 `error` 浮层、控制台无 error。主 canvas 仍 0×0（不 composite → rAF 不触发 → PIXI ticker 冻结，未修改版本一样，不是回归）。

## 删除重构前的扁平死模块（2026-08-20）

`src/` 根目录下重构前的一整套同名扁平模块被删除，共 **13 个文件 / 1424 行**：`animation.ts`(182)、`events.ts`(42)、`interaction.ts`(147)、`io.ts`(102)、`presets.ts`(80)、`renderer.ts`(217)、`skeleton.ts`(81)、`state.ts`(97)、`timeline.ts`(190)、`types.ts`(43)、`ui.ts`(239)，加两个只有 `export {}` 的空壳 `atlas/AtlasController.ts`、`ui/AtlasPanel.ts`（注释自称已被 `images/ImageController.ts`/`ui/ImagePanel.ts` 取代）。这批文件只互相 import，从 webpack 唯一入口 `./src/index.ts` 完全不可达——`renderer.ts` 里的 `from './skeleton'` 按 Node 解析规则命中 `src/skeleton.ts`（`src/skeleton/` 下没有 `index.ts`），而不是活代码用的 `src/skeleton/Skeleton.ts`，于是整批构成一张自闭合的死图。范式也完全不同：死图是"模块单例 `state` + payload 为 `unknown` 的字符串常量事件总线"，活代码是"类 + `EventBus<AppEvents>` 强类型总线"。

**可达性是独立复核过的，不是照抄清单**：写了一次按 tsconfig 解析规则（相对路径 + `baseUrl: ./src` 非相对路径，候选序 `X.ts` → `X/index.ts`）的 import 图遍历，起点取全部三类入口——`src/index.ts`（webpack 唯一 entry）、`runtime/StickmanRuntime.ts`（**不在 `src/` 下，是单独产物，必须单独当根**）、`test/**/*.test.ts` 全部 11 个文件；43 个活文件全部可达，剩下的正好是这 13 个 + `src/globals.d.ts`（ambient 声明文件，无人 import 但 tsc 需要，**保留**）。另外全库 grep 过这批路径名与 `AtlasController`/`AtlasPanel`，命中的全是目录版（`src/io/**`、`src/skeleton/Skeleton.ts`），无一处指向扁平版。

**最硬的一条证据**：删除前后跑 `npm run build`，production bundle 的 contenthash 与文件名完全一致（`bundle.04a1b40b5390a85f7d41.js`，653357 字节）——即这些文件从未进入产物，删除对线上零影响。`npm run typecheck` / `npm test` / `npm run build` 三项删除后全绿，用例数与删除前一致（这批死文件本来就没有测试）——任务分支上是 128 条，合并进 `20.08.2026` 后 138 条（多出的 10 条是另一会话同日加的 `RotateBoneCommand` 测试，与本次删除无关）。

**dev server 抽查**：起 9091（本次为避端口冲突起在 9191）加载编辑器，与主检出未修改版本（起在 9192）跑同一段 DOM 事件驱动脚本逐步对比——新建 clip（含 `Undo: Create clip "…"` 标签）、打/删关键帧、`Ctrl+Z`/`Ctrl+Shift+Z`、改 duration、切动画、重命名、删 clip 后回落 `idle`，两侧**每一步的 status 文案与列表状态完全一致**，双方 `errors` 均为空。**注意这个环境的坑**：Browser pane 不 compositing，页面 `document.visibilityState === 'hidden'` 且 `requestAnimationFrame` 永不触发，于是 PIXI ticker 冻结 → 主 canvas 停在 0×0、`#tl-labels` 一行不渲染（`TimelineView.render()` 只在主循环里被调用）。这**不是**回归——未修改的主检出版本表现一模一样；同样原因截图也拿不到（同 Phase 4 的记录），可见性验证只能退化成 DOM 事件驱动 + 与基线逐步比对。

**同日补了闸门**：这类死图原来两条 CI 闸门都发现不了（不超 500 行、又在 coverage scope 外），全靠有人恰好手跑一次遍历。现在那次遍历固化成第三条闸门 `tools/scripts/checkUnreachableModules.mjs`（5 个工具包各跑一次，animator 额外声明 `--extra-root=runtime`），测试在 `server/shared/test/reachabilityGuard.test.ts`（15 例）。口径见 `claudedocs/tools-testing.md`「可达性闸门」。**把这 13 个文件里任意一个 checkout 回来，闸门立刻红**（实测过）。

**覆盖率变化**（在合并进 `20.08.2026`（已含 ADR-070 接线 + 另一会话新增的 `RotateBoneCommand` 测试，共 138 条）之后的同一棵树上，前后各实测一次；"删除前"是把这 13 个文件 `git checkout` 回来再跑）：

| 统计范围 | 命令 | 删除前 | 删除后 |
|---|---|---|---|
| whole-package | `--coverage.include='**'` | 23.53% | **29.54%** |
| 仅 `src/**` | `--coverage.include='src/**'` | 24.37% | **30.87%** |
| ADR-070 scope（`npm run test:coverage`） | `src/{core,skeleton,animation,io}/**` | 64.28% | 64.28%（**不变**）|

前两行涨的就是这 1424 行 0% 死码退出分母；第三行不动，因为死文件全在那份 include whitelist 之外——**ADR-070 的 CI 门禁数字不受本次删除影响，别指望它变**。台账（`claudedocs/tools-testing.md`）的 animator 全包一列已同步改成 29.5%。引用覆盖率数字时务必说明是哪个口径，否则 64.28% 不动和全包涨 6 个点看起来会像自相矛盾。

## 关键帧拖拽终于进 Undo 栈（2026-08-26）

`TimelineView.ts` 里的 `MoveKeyframeCommand` **定义了但从未被 `new` 过**：`onMouseMove` 每一步直接 `animCtrl.moveKeyframe(dragKfTime, newT)` 改模型，再把 `dragKfTime` 覆写成 `newT`，所以走到 `onMouseUp` 时这次拖拽的**起点时间已经被自己冲掉了**，那里只剩一句 "Already mutated via moveKeyframe; commit as Command if time actually changed" 的注释，没有任何代码。用户侧症状：在时间轴上拖动关键帧改时间，`Ctrl+Z` 撤不回来——栈顶是上一条更早的命令，一按就跳过这次拖拽去撤了别的东西（比"什么都没发生"更糟）。

三处改动：

- **`CommandManager.pushExecuted(cmd)`**（新增入口）：只入栈、清 redo、发 `history:change`，**不调 `execute()`**。原有的 `execute()` 在这里用不了——它会先跑一遍 `cmd.execute()`，也就是在**已经移动过**的关键帧上再 `moveKeyframe(oldTime → newTime)` 一次；此时 `oldTime` 那个位置已经没有关键帧了，`moveKeyframe` 里的 `find` 落空直接 return，命令看似"成功"入栈，实际是把一条永远匹配不上的 undo 记录塞进了栈。
- **`TimelineView.dragKfStartTime`**：mousedown 时和 `dragKfTime` 一起记下，全程不被 mousemove 覆写，就是 undo 的目标时间。
- **`TimelineView.endKfDrag()`**：`mouseup` 和 `mouseleave` 共用的收尾——两端时间按 `moveKeyframe` 的口径 round 到毫秒后比较，真的变了才 `pushExecuted(new MoveKeyframeCommand(...))`。挂 `mouseleave` 是顺带补的第二个洞：原来那行只把 `isDraggingKf` 置回 false，拖出画布外的移动同样已经落进模型、却连补记的机会都没有。

**是谁发现的**：同日早些时候给 `tools/` 五个包接 ESLint（此前一个都没有，见 [`tools-testing.md`](tools-testing.md)「ESLint」节），animator 的首跑 4 个问题里就有这条 `@typescript-eslint/no-unused-vars`。当时**刻意没有就地修**——删掉这个类等于抹掉这个功能缺口的唯一痕迹，而接上它要动 `CommandManager` 的公开面，是单独一件事——于是留了一条带完整理由的 `eslint-disable-next-line` 和一段 `NOT WIRED UP` 注释把接法写清楚。本次就是照着那段注释接完，两者一并删除（类头换成一句正常的文档注释）。

**验证**：`npm run lint` / `npm run typecheck` 干净，`npm test` 345 条全绿（`CommandManager.test.ts` 12 → 17 条，新增 `pushExecuted` 一组：不重跑 execute、undo/redo 仍正常、清 redo 栈、发事件、同样受 `MAX_STACK` 约束）。dev server 起在 9191 用 DOM 事件驱动实测：把 0.130s 那帧拖到 0.060s，Undo 按钮 title 变成 `Undo: Move Keyframe 0.130s → 0.060s`；`Undo` 后整条 clip 的关键帧集合精确回到 `[0.13, 0.25, 0.35, 0.38, 0.50]`，`Redo` 后精确变成 `[0.06, 0.25, 0.35, 0.38, 0.50]`——**其余四帧全程一动不动**，这一条就是「没有被应用两次」的证据。另外单独验了 `mouseleave` 分支（拖到一半划出画布，`Undo: Move Keyframe 0.350s → 0.440s` 照样入栈、undo 照样回得去）和零距离拖拽（按下即松开，不产生新栈条目）。

**探针手法**（这个环境拿不到截图、`requestAnimationFrame` 不触发所以画布根本不重绘，见下方 08-20 那条同款记录）：在距目标时间 1.8ms 的位置 mousedown——命中关键帧会把 `#time-display` **吸附**到关键帧的精确时间，没命中就只是 scrub 到点击处，于是「读数等于点击时间」与「读数被拉回某个整毫秒」的差别就是"这里有没有帧"。按 2ms 步长扫完整条 clip 就得到上面那种**完整关键帧集合**，比逐点断言强得多。**踩过一次**：第一轮只点验了拖拽的起终点两处，第二轮重跑时 `0.350s` 那点「本该是空的却命中了」——不是回归，是 animator 的 `AutoSaveController`/IndexedDB 把**上一轮验证留下的关键帧**恢复了回来。所以这类验证要么先扫一遍拿到基线，要么先清 IndexedDB；只比对两个点会把陈旧存档读成 bug。

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
