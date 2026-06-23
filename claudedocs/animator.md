# 动画编辑器（tools/animator）

设计文档：`design/tools/animator/REQUIREMENTS.md`（§2 §3 §8）、`ARCHITECTURE.md`（§1 §2 §5 §3）、`WORKSPACE_SYNC.md`（在线工作区 + 云盘→仓库同步桥，已上线 `animator.tao-wang-go.workers.dev`：Supabase 工作区 + 云端自动同步 + GitHub Action 同步桥）

```bash
cd tools/animator && npm run start   # 端口 9091
```

## 参数两层模型

**Binding（静态，所有帧共用）**：`anchorX/Y`（挂点比例，允许超出 0–1）、`rotation`（静态偏移）、`scaleX/Y`、`flipX`、`zOrder`

**Keyframe（动态，逐帧）**：`rotation`（delta）、`translateX/Y`、`scaleX/Y`、`alpha`

渲染公式：`sprite.rotation = bone_FK_angle + binding.rotation`（bone_FK_angle 已含 keyframe.rotation，不可重复叠加）

## 架构要点

- **11 根固定骨骼**：root → spine → head / 4 臂 / 4 腿
- **FK**：`Skeleton.computeFK(rootX, rootY, transforms, lengthScales?)` 纯函数；hit-test 须传 `state.boneLengthScales`
- **关键帧插值**：`sampleClip(clip, t)` 无外部依赖，可复制到游戏引擎
- **导出格式**：`.tao`（JSZip + spritesheet.png + animation.json v2）；`.tao.editor`（保留原始图 + 编辑状态）
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
| `src/io/IOController.ts` | `.tao` 导出 / 导入；`.tao.editor` 存档（`buildEditorBlob`/`loadEditorBlob` 复用） |
| `src/io/ProjectStore.ts` | IndexedDB 工程库（`meta`+`blobs` 两 store） |
| `src/io/AutoSaveController.ts` | 多工程自动保存 + 切换 + 启动恢复 |
| `src/ui/ProjectPanel.ts` | 底部栏工程下拉 + 增删改复制 + 自动保存状态点 |
| `src/ui/StatusBar.ts` | 底部低风险进度提示（`status` 事件，3s 自动清） |
| `src/ui/ErrorToast.ts` | 顶部居中错误浮层（`error` 事件，红色卡片，可 ✕，8s 自动消） |
| `src/timeline/TimelineView.ts` | Canvas 时间轴渲染 + 交互 |
| `src/interaction/InteractionController.ts` | 鼠标拖拽 + 键盘快捷键 |
