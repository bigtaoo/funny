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
