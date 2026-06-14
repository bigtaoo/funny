# funny — Notebook Wars

## 项目概况

浏览器 + 微信小游戏的回合制策略游戏，配套骨骼动画编辑器。

## 目录结构

```
funny/
├── client/          主游戏（TypeScript + PixiJS）
│   ├── src/
│   │   ├── game/          游戏逻辑（纯 TS，无 PIXI 依赖）
│   │   ├── render/        渲染层（PixiJS）
│   │   ├── layout/        响应式布局
│   │   ├── scenes/        场景管理
│   │   └── entries/       多平台入口（web / wechat / crazygames）
│   └── webpack.config.js
│
├── tools/
│   ├── animator/          骨骼动画编辑器（TypeScript + PixiJS，主力版本）
│   │   ├── src/           源码（见下方架构）
│   │   └── public/        HTML 模板（webpack-html-plugin 用）
│   ├── level-editor/      战役关卡编辑器（TypeScript + 纯 Canvas，端口 9092）
│   │   ├── src/           源码（board / timeline / inspector / state）
│   │   └── public/        HTML 模板
│
├── art/
│   ├── maps/              地图资源
│   ├── units/             角色概念图
│   └── index.html         静态资源索引
│
└── design/                ★ 所有设计文档集中于此（2026-06-13 起）
    ├── game/              游戏主文档：DESIGN / IMPROVEMENT_PLAN / CAMPAIGN_DESIGN
    │                      / CAMPAIGN_P0_PLAN / META_DESIGN / META_TASKS / UI_DESIGN
    │                      / SERVER_API / ECONOMY_BALANCE
    ├── tools/             工具文档：animator/{ARCHITECTURE,REQUIREMENTS}、level-editor/DESIGN
    └── product/           产品/美术文档：world / characters / market-analysis / ui-design …
```

> **文档约定（2026-06-13 起）**：所有设计文档统一放 `design/` 下，按模块分子目录（`game` / `tools` / `product`）。`CLAUDE.md`、`README.md` 是例外，保留在仓库根。

## 动画编辑器（tools/animator）

### 外部文档导航

> 文档位置：`design/tools/animator/`（`ARCHITECTURE.md` / `REQUIREMENTS.md`）。

| 想查的内容 | 文件 | 章节 |
|---|---|---|
| 典型工作流 / 功能规格 / UI 布局 / 导出格式规范 | `design/tools/animator/REQUIREMENTS.md` | §2 工作流、§3 功能规格、§8 界面布局 |
| 目录结构 / 数据模型 / 渲染流程 / 事件总线 / 命令模式 | `design/tools/animator/ARCHITECTURE.md` | §1 目录、§2 数据模型、§5 渲染、§3 事件总线 |
| 插值算法细节 | `design/tools/animator/ARCHITECTURE.md` | §4 插值算法 |
| 游戏侧对接规格 / StickmanRuntime | `design/tools/animator/REQUIREMENTS.md` | §7 游戏侧对接 |
| 性能注意事项 / 已知局限 | `design/tools/animator/ARCHITECTURE.md` | §9 性能、§10 局限 |

### 启动

```bash
cd tools/animator
npm run start   # webpack dev server，端口 9091
npm run build   # 生产构建
```

### 参数两层模型

骨骼动画参数分两层，**不可混淆**：

**第一层：Binding（静态，设定一次，所有帧共用）**

| 字段 | 含义 |
|---|---|
| `anchorX/Y` | 图片上的挂点比例（图片本地坐标，0=左/上，1=右/下，**允许超出 0–1 范围**）；PIXI `sprite.anchor`；随图片旋转，在所有动画帧中保持骨骼与图片的对齐 |
| `rotation` | 图片静态旋转（度），叠加在骨骼 FK 角度上；用于修正图片朝向 |
| `scaleX/Y` | 图片静态缩放，与动画 scaleX/Y 相乘；用于匹配骨骼长度（**不自动绑定，需手动设置**） |
| `flipX` | 水平镜像 |
| `zOrder` | 渲染层级，高 = 在前；shadow 固定为 -∞（最底层） |

**第二层：Keyframe（动态，逐帧，可动画化）**

| 字段 | 含义 |
|---|---|
| `rotation` | 叠加在骨骼 FK 角度上的旋转 delta（度）；图片跟随骨骼转 |
| `translateX/Y` | 移动骨骼 pivot（图片跟随），叠加在 FK 计算之上 |
| `scaleX/Y` | 缩放骨骼（与 binding.scaleX/Y 相乘） |
| `alpha` | 显隐（0 = 隐藏） |

**渲染合成公式：**
```
sprite.rotation = bone_FK_angle + binding.rotation   （bone_FK_angle 已含 keyframe.rotation，不可重复叠加）
sprite.x        = bone_pivot.x  + keyframe.translateX
sprite.scale    = keyframe.scaleX × binding.scaleX
```

Binding 参数在动画期间不变；动画只控制骨骼，图片跟随骨骼。

### 架构要点

- **11 根固定骨骼**：root → spine → head / r_upper_arm → r_lower_arm / l_upper_arm → l_lower_arm；root → r_upper_leg → r_lower_leg / l_upper_leg → l_lower_leg
- **FK 计算**：`Skeleton.computeFK(rootX, rootY, transforms, lengthScales?)` → `WorldPositions`（纯函数）；`lengthScales` 为可选的每骨骼长度倍率 Map，缺省全为 1.0；**交互控制器的 hit-test 和旋转轴心计算必须传入 `state.boneLengthScales`，否则骨骼拉伸后无法点击**
- **关键帧插值**：`sampleClip(clip, t)` → `Map<boneId, ResolvedBoneTransform>`（无外部依赖，可复制到游戏引擎）；无 `frameId`，骨骼隐藏用 `alpha:0`
- **图片导入**：每骨骼一张 PNG（10 骨骼 + 1 阴影 = 11 张），按文件名自动映射；`ImageController` 管理 Blob + PIXI.Texture；**加载任意一张图片即自动切换到 Sprite 预览模式**
- **Sprite 层级**：`SpriteBinding.zOrder` 控制骨骼精灵遮挡顺序；`binding:change` 或图片加载时对 `spriteLayer.children` 排序一次，渲染期间不重排；shadow 图片 zOrder 硬编码为 `-Infinity`（始终最底层）
- **Shadow 图片渲染**：shadow 是挂点（`AttachmentPoint`），不在 `bindings` Map 里；`Renderer.updateSprites` 单独处理，位置 = `parent.ex + offsetX/Y`，尺寸由 `shadowW/H`（椭圆半轴）换算为 sprite scale：`scaleX = (shadowW*2)/tex.width`
- **Sprite Binding**：`SpriteBinding` 含 `anchorX/Y`（图片本地挂点，允许超出 0–1，随骨骼旋转保持对齐）、`rotation`（度，静态修正图片朝向）、`scaleX/Y`（乘以动画缩放，匹配骨骼长度）；**无 offsetX/Y**，图片位置完全由 anchor 控制
- **Anchor 可视化**：Sprite 模式下，每个有图片的骨骼在其 anchor 世界坐标处绘制红色实心圆（r=4，选中时 r=6 + 十字线）
- **关键帧复制**：右键时间轴关键帧菱形 → Copy keyframe；移动时间指针到目标时刻 → 右键 Paste keyframe
- **导출格式**：`.tao`（JSZip ZIP）内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing + canvas.toBlob）+ `spritesheet.json`（boneId→rect）
- **编辑器存档格式**：`.tao.editor`（JSZip ZIP）内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始图，无损，不合并 spritesheet）；Chrome/Edge 通过 File System Access API 弹出原生保存对话框（`suggestedName` 不含扩展名，由 API 自动追加）；Firefox 等不支持的浏览器退回 `window.prompt()` 询问文件名再 `<a download>` 触发下载
- **骨骼长度（Rig 设置）**：`AppState.boneLengthScales: Map<boneId, number>` 存每根骨骼的长度倍率（稀疏，1.0 不存储）；Inspector 面板「Length (px)」输入框以实际像素显示，内部换算为倍率；序列化进 `.tao.editor` 和 `.tao`；每个角色设置一次，不影响关键帧动画数据
- **事件总线**：`EventBus<AppEvents>` 强类型，核心事件见 `src/core/EventBus.ts`；`images:change: string` 携带 slotId；`rig:change` 触发骨骼长度变更后的重绘
- **命令模式**：所有数据变更封装为 `Command`，支持 Undo/Redo（上限 100）
- **时间轴骨骼行**：`Skeleton.TIMELINE_BONES` = 10 根（spine + head + 4 臂 + 4 腿），每行 26px，标尺 20px，共需 280px
- **编辑器模式（Skin / Animate）**：`AppState.editorMode: 'skin' | 'animate'`（默认 `'animate'`，不序列化）；工具栏 🎨 Skin / 🎬 Animate 按钮切换，快捷键 `S`；**Skin 模式**：渲染静息姿（empty transforms），Inspector 只显示 SpriteBinding 参数，拖拽旋转骨骼被禁用；**Animate 模式**：正常动画播放 + 关键帧编辑，Inspector 只显示 Keyframe 变换，SpriteBinding 显示只读摘要
- **静息姿朝向约定**：骨骼 `rwa`（rest world angle）按**角色朝右**设定——`r_`（解剖右）= 屏幕左，`l_`（解剖左）= 屏幕右；手臂水平展开（r_upper_arm 180°，l_upper_arm 0°），腿向外下方 30° 展开（r_upper_leg 120°，l_upper_leg 60°）

### 已知修复（2026-06）

| 文件 | 问题 | 修复 |
|---|---|---|
| `public/index.html` | `.timeline { height: 190px }` 太小，10 根骨骼行（280px）被截断 | 改为 `285px` |
| `src/App.ts` | `ResizeObserver` 读 `renderer.logicalSize`（旧 PIXI 尺寸）而非容器新尺寸，导致 resize 后骨架位置错误 | 改读 `entries[0].contentRect`，并保留 pan offset |
| `src/timeline/ContextMenu.ts` | 构造函数注册的 `mousedown`/`keydown` 文档级监听器从未移除，`destroy()` 只删 DOM 不清监听器 | 提取为类成员箭头函数，`destroy()` 中 `removeEventListener` |
| `public/index.html` | `.timeline { height: 285px }` 漏算 `.timeline-header`（约 23px），导致 L. Lower Leg 行被截断 | 改为 `308px` |
| `src/rendering/Renderer.ts` | `transform?.frameId !== undefined` 判断有误（旧 frameId 机制，已随 2026-06 重构移除） | — |
| 全局重构（2026-06） | 导入方式从 sprite atlas 改为逐张图片；导出从 `.json` 改为 `.tao`（ZIP）；新增 `zOrder` 骨骼层级控制 | 见下方架构要点 |
| `src/App.ts` | 只有全部 10 张图片加载完才切换 Sprite 模式，绑定部分图片时预览不显示 | 改为加载任意一张图片即切换 Sprite 模式 |
| `src/core/types.ts` + `Renderer.ts` | `SpriteBinding` 缺少静态旋转/缩放偏移，无法在不修改关键帧的情况下修正图片朝向 | 新增 `rotation`/`scaleX`/`scaleY` 字段；渲染时与动画变换叠加 |
| `src/io/IOController.ts` | 无编辑器存档功能，每次需重新导入图片和动画 | 新增 `.tao.editor` 格式（保留原始图 + 编辑器状态）；保存用 File System Access API 弹出原生对话框 |
| `tsconfig.json` | 未指定 `lib`，webpack ts-loader 缺少 DOM 类型 | 显式加 `"lib": ["ES2020","DOM","DOM.Iterable"]`；安装 `@types/wicg-file-system-access` |
| `src/io/IOController.ts` | `.tao` 导出直接调用 `triggerDownload`，无法选取保存路径和文件名 | 改为 `saveWithPicker`；Firefox fallback 用 `prompt()` 询问文件名 |
| `src/io/IOController.ts` | `suggestedName` 含扩展名（如 `project.tao.editor`），Chrome 会再追加一次扩展名导致重复 | `suggestedName` 改为不含扩展名（`project` / `animation`），扩展名由 `accept` 类型自动附加 |
| `src/rendering/Renderer.ts` + `AppState.ts` | Sprite 模式下骨骼线框渲染在 sprite 上方；`showSkeletonOverlay` 默认 `true` | 调整层级为 `boneGfx → spriteLayer → overlayGfx`；骨骼叠加显示改走独立 `overlayGfx` 层；`showSkeletonOverlay` 默认改为 `false` |
| `src/core/types.ts` + `Renderer.ts` + `BoneInspectorPanel.ts` | `SpriteBinding` 缺少像素偏移，厚实的身体图片无法将胳膊图片整体平移到正确位置 | 新增 `offsetX`/`offsetY` 字段；渲染时叠加在骨骼世界坐标上；Inspector 面板加 Offset X/Y 输入框 |
| `src/ToolbarPanel.ts` | Sprite 模式下无快捷按钮切换骨骼叠加显示，`chk-overlay` 藏在侧边栏 | 工具栏新增 🦴 Bones 切换按钮；Sprite 模式激活，Skeleton 模式禁用；与侧边栏 checkbox 双向同步 |
| 多文件 | 无法为每个角色单独设置骨骼长度，骨骼和图片比例不一致导致动画调整困难 | 新增 `AppState.boneLengthScales`（稀疏 Map）；`Skeleton.computeFK` 加 `lengthScales?` 参数；Inspector 加 Length (px) 输入框；序列化进 `.tao.editor` 和 `.tao` |
| `src/interaction/InteractionController.ts` | 骨骼长度改变后无法旋转骨骼：`onMouseDown`/`onMouseMove` 的 `computeFK` 未传 `lengthScales`，hit-test 和旋转轴心与实际渲染位置不一致 | 两处 `computeFK` 均加 `this.state.boneLengthScales` 参数 |
| `src/rendering/Renderer.ts` | shadow 挂点图片不显示：`updateSprites` 只遍历 `bindings`（骨骼），shadow 作为 `AttachmentPoint` 从未渲染 | 单独处理 shadow slot；位置取 `parent.ex + offsetX/Y`；尺寸由 `shadowW/H` 半轴换算为 sprite scale |
| `src/rendering/Renderer.ts` | shadow 图片未应用 `shadowW/H` 尺寸 | `scaleX = (shadowW*2)/tex.width`，`scaleY = (shadowH*2)/tex.height` |
| `src/rendering/Renderer.ts` | Sprite 模式下看不出图片 anchor 与骨骼 pivot 的对应关系 | 新增 `drawAnchorPoints`：每个有图片的骨骼在 anchor 世界坐标处画红点；选中骨骼加十字线 |
| `src/rendering/Renderer.ts` | `sprite.rotation` 重复叠加 keyframe.rotation：`pose.wa` 已含该值，渲染器再加一次导致动画中图片多转一倍关键帧角度，关节断开 | 渲染公式改为 `pose.wa + binding.rotation`，去掉多余的 `transform.rotation` |
| `src/core/types.ts` + `Renderer.ts` + `BoneInspectorPanel.ts` + `App.ts` | `SpriteBinding.offsetX/Y` 是屏幕空间偏移，不随骨骼旋转，蒙皮时对齐后动画中仍断开；anchor 允许范围 0–1 导致无法将挂点放到图片边界外 | 删除 `SpriteBinding.offsetX/Y`；`anchorX/Y` 输入框去掉 min/max 限制，允许超出 0–1；旧 `.tao.editor` 中的 offsetX/Y 字段加载时自动忽略 |
| 多文件 | 蒙皮参数（SpriteBinding）在动画帧上调整，骨骼已移动，操作混乱 | 新增 `editorMode: 'skin' \| 'animate'`（`AppState` + `EventBus`）；Skin 模式渲染静息姿、Inspector 只显示 Binding 参数、禁止拖拽旋转；工具栏加 🎨/🎬 切换按钮，快捷键 `S` |
| `src/skeleton/Skeleton.ts` | 静息姿 `rwa` 未按朝右角色约定设定：手臂朝下（82°/98°），左右腿在错误一侧 | 手臂改为水平展开（r 180°/195°，l 0°/−15°）；腿改为向各自外侧下方展开（r 120°/130°，l 60°/50°） |
| `src/ui/ResizablePanels.ts` | `atlasPanel`（`#atlas-panel`）不存在于 DOM，`right | atlas` 分割条初始化时读 `null.offsetWidth` 崩溃 | 加 `if (atlasPanel)` null guard，不存在时跳过该分割条 |
| `src/timeline/TimelineView.ts` + `public/index.html` | 时间轴面板缩小后骨骼行被截断，无法滚动查看 | 新增垂直滚动：`scrollY` 状态 + `applyScroll()`；canvas `drawRows` 加 `clip()` + scrollY 偏移，跳过不可见行；`getRowFromY`/`findKfAt` 点击坐标加 scrollY 修正；右侧自定义滚动条（`#tl-vscroll` / `#tl-vscroll-thumb`）支持拖拽 thumb、点击轨道跳转；canvas wheel 事件驱动滚动；labels 隐藏原生滚动条，`scrollTop` 由 JS 同步；面板高度足够时 thumb 自动隐藏 |
| `src/io/IOController.ts` | 导出 `.tao` 体积偏大：骨骼图在编辑器里被 `binding.scale` 缩小显示，spritesheet 却存全分辨率原图，浪费像素 | 导出端新增烘焙（约 -1/3 体积）：`buildExportImages` 按每骨骼 `\|binding.scale\| × 最大关键帧 scale × 1.5 余量`（`clamp01` 封顶 ≤1，永不放大源图）canvas 高质量缩小，并把 `animation.json` 的 `binding.scaleX/Y` 除以同比例补偿；shadow 与源分辨率无关，缩到 `shadowW/H 显示尺寸 ×1.5`；`computeMaxKeyframeScale` 取全 clip 最大放大倍数防糊。runtime `sprite.scale=关键帧×binding.scale` 纯乘法 → 像素级一致、零改动；仅作用于 `.tao`，`.tao.editor` 仍存无损原图 |

### 快捷键

| 键 | 动作 |
|---|---|
| `Space` | 播放 / 暂停 |
| `K` | 当前时间打关键帧 |
| `Delete` / `Backspace` | 删除选中关键帧 |
| `Tab` | 切换 Skeleton / Sprite 预览模式 |
| `S` | 切换 Skin / Animate 编辑器模式 |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| 左键拖骨骼 | 旋转（mouseUp 提交 Command） |
| 右键拖画布 | Pan |
| 时间轴右键菱形 | easing 切换 / Copy / Paste / Delete keyframe |
| 时间轴滚轮 | 垂直滚动骨骼行 |

### 事件总线（核心事件）

| 事件 | payload | 触发时机 |
|---|---|---|
| `bone:select` | `string \| null` | 选中 / 取消骨骼 |
| `bone:rotate` | `{id, delta}` | 拖拽中 live delta |
| `time:change` | `number` | 播放 / 拖动时间轴 |
| `play:state` | `boolean` | 播放 / 暂停 |
| `anim:select` | `string` | 切换当前动画 |
| `anim:list` | void | 列表增删改 |
| `kf:change` | void | 关键帧数据变化 |
| `images:change` | `string`(slotId) | 骨骼图片加载 / 移除 |
| `binding:change` | `string`(boneId) | sprite 绑定变化 |
| `attachment:change` | void | 挂点数据变化 |
| `rig:change` | void | 骨骼长度倍率变化 |
| `preview:mode` | `'skeleton'\|'sprite'` | 预览模式切换 |
| `editor:mode` | `'skin'\|'animate'` | 编辑器模式切换 |
| `history:change` | `{canUndo,canRedo,label}` | Undo/Redo 栈变化 |
| `status` | `string` | 状态栏消息 |
| `pose:reset` | void | 重置为 rest pose |

### 渲染层级（PixiJS stage，从下到上）

```
gridGfx      — 背景网格
onionGfx     — Onion skin（alpha 0.2）
boneGfx      — 骨骼线框（Skeleton 模式）
spriteLayer  — PIXI.Sprite（Sprite 模式，盖住 boneGfx）
overlayGfx   — 骨骼叠加线框（Sprite 模式 + showSkeletonOverlay=true）
selGfx       — 选中高亮 + 挂点标记 + Guide
```

### 典型工作流

```
1. npm run start → http://localhost:9091
2. [蒙皮] 导入骨骼图片 → 切换 🎨 Skin 模式
           → 在静息姿下逐骨骼调 Binding（anchor / offset / rotation / scale）
3. [动画] 切换 🎬 Animate 模式 → 选 / 新建动画片段
           → 拖骨骼调姿态 → K 打帧 → Space 预览 → 反复调整
4. 💾 Save .editor（保留图片 + 编辑状态）
5. ⬇ Export .tao（游戏引擎读取）
```

### 预设动画

| 名称 | 时长 | Loop |
|---|---|---|
| idle | 1.5s | ✓ |
| walk | 0.5s | ✓ |
| attack | 0.6s | ✗ |
| hurt | 0.4s | ✗ |
| death | 0.8s | ✗ |
| spawn | 0.35s | ✗ |

### 主要源文件

| 文件 | 职责 |
|---|---|
| `src/App.ts` | 组合根，连接所有模块，主循环 |
| `src/rendering/Renderer.ts` | PixiJS 渲染（骨骼 + sprite + 挂点） |
| `src/skeleton/Skeleton.ts` | 骨骼定义 + FK 计算（静态类） |
| `src/animation/AnimationController.ts` | clip CRUD + 播放 + 关键帧操作 |
| `src/animation/interpolate.ts` | `sampleClip` 插值（无依赖，游戏侧共享） |
| `src/images/ImageController.ts` | 逐张 PNG 导入、bone slot 映射、Blob + PIXI.Texture 管理 |
| `src/ui/ImagePanel.ts` | 图片导入面板（骨骼 slot 列表 + zOrder 输入） |
| `src/io/IOController.ts` | `.tao` 导出（JSZip + shelf bin-packing + canvas.toBlob）/ 导入；`.tao.editor` 编辑器存档保存 / 加载 |
| `src/timeline/TimelineView.ts` | Canvas 时间轴渲染 + 交互 |
| `src/interaction/InteractionController.ts` | 鼠标拖拽 + 键盘快捷键 |
| `src/core/AppState.ts` | 全局可变状态（写时 emit 事件） |
| `src/core/CommandManager.ts` | Undo/Redo 命令栈 |

## 关卡编辑器（tools/level-editor）

战役关卡（PvE）可视化编辑器，产出运行时加载的 JSON。设计基准见 `design/tools/level-editor/DESIGN.md`（单一文档）。

### 启动

```bash
cd tools/level-editor
npm run start   # webpack dev server，端口 9092
npm run build   # 生产构建
```

### 要点

- **形态**：独立 Web 工具，TypeScript + **纯 Canvas/DOM**（不依赖 PixiJS）。
- **数据单一来源**：编辑器经 webpack `@game` alias（→ `client/src/game`）直接 import 游戏侧的 `LevelDefinition` / `parseLevelDefinition` / 棋盘常量 / `UnitType` / `CARD_DEFINITIONS`，**绝不在编辑器内维护第二份 schema**；ts-loader `transpileOnly` 避免把 i18n `TranslationKey` 大联合拖进编辑器构建。
- **关卡为 JSON 单一来源**：所有战役关卡（含内置 CH1_LV1~3 + stress）是 `client/src/game/campaign/levels/*.json`，由 `parseLevelDefinition` 运行时校验加载（见下方游戏侧改动）。编辑器导入/导出走这套 JSON。
- **四区布局**：棋盘格（左，绘 blocked/noBuild + activeLanes）/ 波次时间线（中上，横=秒/纵=10 攻击车道，拖块改 atTick/col、右键删、滚轮平移、Ctrl+滚轮缩放）/ 实时 JSON（中下，双向）/ 右栏「关卡 / 波次」双 Tab Inspector。
- **中心状态** `EditorState`：持有正在编辑的 `LevelDefinition` + 变更广播；所有 mutator **规范化**（删空数组/对象、留空可选字段从 JSON 删除），保证导出 JSON 与手写关卡逐字等价。
- **源文件**：`src/state/EditorState.ts`（状态 + 广播）、`src/board/BoardPanel.ts`（棋盘 Canvas）、`src/timeline/TimelinePanel.ts`（时间线 Canvas）、`src/inspector/InspectorPanel.ts`（波次表单）、`src/inspector/LevelFormPanel.ts`（关卡表单）、`src/units.ts`（单位显示元数据）、`src/index.ts`（组合根 + IO）。
- **可调面板**：三个分隔条（`.vsplit` / `.hsplit`，`index.ts` 的 `dragSplit`）——棋盘列↔中栏（拖宽棋盘，画布按宽度选格子尺寸 16–56px 并放大，clamp 260–820px）、中栏↔Inspector（200–560px）、时间线↔JSON（纵向，调 JSON 高度 90–520px）；棋盘分隔条拖动时直接调 `board.resize()`，另加 `window.resize` 监听（不仅依赖 `ResizeObserver`）。
- **棋盘画布动态尺寸**：`BoardPanel` 的格子尺寸 `cell`/`header` 是实例状态（非模块常量），按 mount 宽度选取，**backing store 与显示尺寸严格 1:1**，点击坐标始终精确命中格子（与 `TimelinePanel` 同款 `ResizeObserver` 模式）。
- **已知局限（待修）**：截图工具在预览里抓帧超时（不影响功能）；初始视口极窄时时间线 canvas 退到最小宽度，需 resize 后重载。

### 已知修复（2026-06）

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/board/BoardPanel.ts` | 棋盘点击命中的格子与点击位置不符：`CELL`/`HEADER` 是模块级常量、画布固定 312px 渲染，画布显示尺寸一旦与内部分辨率不一致（DPI/缩放/面板可调宽后）`getBoundingClientRect` 映射就偏 | cell/header 改为实例状态，画布按面板宽度动态选格子尺寸（16–56px），backing store 与显示尺寸严格 1:1；`resize()` 改 public 供分隔条同步调用；顺手删 `drawNoBuild` 中一段无 `stroke` 的死代码 hatch 循环 |
| `public/index.html` + `src/index.ts` | 三列宽度写死、无分隔条，棋盘 / JSON 窗口无法拖动调整大小 | 加 3 个可拖拽分隔条（`dragSplit`）：棋盘列↔中栏 / 中栏↔Inspector / 时间线↔JSON；棋盘分隔条拖动直接调 `board.resize()` + `window.resize` 监听，纯布局改动不触碰 `EditorState` |

## 美术资产分工（程序绘制 vs AI 图）

> 2026-06-14 拍定。详见 `design/product/art-direction.md`「资产分工」节。

经实测：**程序笔触能画好抽象 UI，画不好角色**。据此分两条管线（同属手绘笔记本视觉语言，混用不打架）：

- **程序绘制（SketchPen，`client/src/render/sketch.ts`）**：棋盘 / 网格 / UI 框 / HUD / 纸纹磨损 / 特效 / 简单装饰——抽象几何元素，程序画出来*就是*设计本身，无"匹配参考图"问题。已落地（见美术第一~三刀）。
- **AI 图（位图资产，`art/units/*`）**：角色 / 兵种 / 有个性的建筑 / 卡牌图 / 插画式地图元素——人对脸/身材/造型极敏感，程序复刻达不到质感。流程：AI 出图 → 用户在 GIMP 切件/润色 → animator 绑骨做动画（Skin 模式 + anchor 红点已支持）。
- **不引入中间生成/模板工具**：切件走 GIMP、绑骨走 animator，链路已齐全。（曾试 `tools/sketch-gen` 程序生成角色，质感够不着 AI 图，已废弃删除。）

## 游戏主代码（client/）

- **渲染**：`pixi.js-legacy`，兼容微信小游戏 WebGL
- **游戏逻辑**：纯 TS，固定点数（`game/math/fixed.ts`），与渲染解耦
- **平台适配**：Web / 微信小游戏 / CrazyGames，多入口 webpack 构建
- **骨骼动画 Runtime**：`StickmanRuntime`（`src/render/stickman/`），加载 `.tao` ZIP，解析 spritesheet + animation.json，驱动 PIXI Sprite 播放骨骼动画；Infantry 单位使用 `infantry.tao`
- **确定性约束**：游戏逻辑（`client/src/game/`）内严禁使用 `Math.random()`，必须使用 `Prng`（`game/math/prng.ts`）。`GameState` 构造函数以 seed 派生各 PRNG；新增需要随机性的系统，在 `GameEngine` 中用 `new Prng(seed ^ 唯一常量)` 注入。
- **多语言（i18n）**：`src/i18n/`，支持 `zh`/`en`/`de`。**所有面向玩家的文案严禁硬编码**，必须在 `locales/zh.ts` 加键（键的唯一来源），再用 `t(key, params?)` 取词；`zh.ts` 的 `TranslationKey` 联合类型 + `en.ts`/`de.ts` 声明为 `Record<TranslationKey, string>`，漏翻任一语言会编译报错。游戏逻辑层（如 `CardDefinition`）只存 `nameKey`/`descKey` 等键，不存文案。`t()` 支持 `{param}` 插值（如 `t('hud.upgradeCost', { cost })`），缺词回退 zh → 键名，不会崩溃。语言选择优先级：玩家保存的选择（持久化到 `storage` 的 `nw_locale`）> 系统语言 > 平台首个支持语言。**平台声明支持语言**：`IPlatform.supportedLocales`，Web/CrazyGames = `['zh','en','de']`，微信 = `['zh']`（小游戏只需中文）；`initI18n` 把激活语言钳制到该集合。`setLocale`/`onLocaleChange` 支持运行时切换 + 订阅重绘。
- **网络协议 codegen（C-2 客户端侧）**：联机线协议从 `server/contracts/{transport,game}.proto`（**与 gameserver 同一份单一来源**）经 **ts-proto via buf** 生成到 `src/net/proto/{transport,game}.ts`（产物提交进仓库）。工具链：`buf.gen.yaml`（buf v2，`local: ["node", ts-proto 插件]` argv 形式绕开 Windows `.cmd`/shebang exec）+ `scripts/gen-proto.mjs`（跨平台），跑 `npm run proto:gen`。**buf 自带静态编译器（无需系统 protoc，无 DLL 依赖）**——本机 grpc-tools 的 `protoc.exe` 缺 VC++ 运行时（0xC0000135）跑不起，故弃用 grpc-tools 改 buf。生成码运行时依赖 `@bufbuild/protobuf/wire`（Google 官方，比 protobufjs 小、无 `long`；`forceLong=number` 因 `seed` 钳在 2^48 内）。**线兼容回归**：`test/proto-wire-compat.test.ts` 用服务端 protobufjs 产出的权威字节向量（`test/_proto_vectors.json`）双向断言 ts-proto ↔ protobufjs 互操作（默认值标量 proto3 省略 vs 显式 0 字节可不同但解回同一消息，用「双方字节解回同一逻辑消息」断言）；18 用例。改 `.proto` 后须 `npm run proto:gen` + 重生向量。
- **首次进入引导**：`IntroScene`（`src/scenes/IntroScene.ts`），讲述背景故事；`app.ts` 启动时检查 `storage` 的 `nw_seen_intro` 标记，首次进入先播引导（逐行淡入 + 点击推进 + 右上角跳过），看完写标记后进大厅，之后启动直达大厅。文案在 i18n `story.*` 命名空间。当前是骨架，后续做正式动画时保留"逐段推进 + 跳过"流程，往每段挂 PIXI 容器或 `StickmanRuntime` 即可。

### 已知修复（2026-06）

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/layout/ILayout.ts` | 缺少 `enemyBaseRect()` 接口 | 新增该方法，`PortraitLayout` / `LandscapeLayout` 均已实现 |
| `src/render/BoardView.ts` | 基地无视觉图片，仅靠高亮矩形标识 | 用 `game_base.png` 渲染双方基地精灵；敌方按朝向镜像（横屏左右翻、竖屏上下翻） |
| `src/render/BuildingView.ts` | 建筑用占位矢量图（矩形/多边形）渲染 | 替换为 PNG 精灵（`game_infantry_barracks.png` / `game_archer_barracks.png`）；`acquireSprite` 添加 scale 0→1 ease-out cubic 弹出动画（约 0.3s） |
| `src/game/systems/CombatSystem.ts` | 箭塔 `findTargetForBuilding` 仅做前向列扫描，无法命中横穿（Crossing）的敌军 | 改为 Chebyshev 距离全向扫描，按距离环由近到远查找，覆盖纵向/横向/斜向所有敌人 |
| `src/render/stickman/`（新增） | 骨骼动画 Runtime 缺失，Infantry 单位用占位圆形 | 新增 `StickmanRuntime`：加载 `.tao` ZIP，解析 `animation.json` + `spritesheet`，按帧驱动 PIXI Sprite；`UnitView` 为 Infantry 创建 runtime 实例，`sync()` 接收 `dt` 参数推进动画时钟；`GameRenderer` 将 `dt` 透传给 `unitView.sync()` |
| `src/render/stickman/StickmanRuntime.ts` | shadow 挂点图片位置/尺寸错误：`_applyPose()` 以骨骼逻辑处理 shadow，未读取 `shadowW`/`shadowH` | `TaoAsset` 新增 `attachmentPoints` 字段；shadow sprite zOrder 硬编为 `-Infinity`，anchor `(0.5,0.5)`；`_applyShadowPose()` 专项处理：位置取 `parentBone.tip + offset`，scale 用 `(shadowW*2)/tex.width × (shadowH*2)/tex.height`，与 animator Renderer.ts 一致 |
| `src/render/BoardView.ts` | 基地静止无生气，受击无裂缝反馈 | 新增 `update(dt)`：基地 sprite alpha 脉冲（0.65–1.0，周期 4s，双方相位差 1.2 rad）；新增 `playBaseCrackEffect()`：`base_hp_changed` 事件驱动，HP > 85% 不显示裂缝，每次追加 1–2 条随机 3 段折线（铅笔灰），HP < 40% 追加 2 条 |
| `src/render/BuildingView.ts` | 建筑 idle 完全静止 | 新增 `update(dt)` + `updateIdleAnim()`：全部建筑精灵垂直 bob（±1.5px，0.9s，随机相位）；兵营追加 `flagGfx` 旗帜 quadratic bezier 波动（~1.4Hz）；箭塔精灵微旋转（±0.5°，1.3s） |
| `src/render/GameRenderer.ts` | `base_hp_changed` 事件无处理；`boardView`/`buildingView` 无 per-frame update | 新增 `base_hp_changed` 分支调用 `playBaseCrackEffect()`；`update()` 中加 `boardView.update(dt)` 和 `buildingView.update(dt)` |
| `src/render/GameRenderer.ts` + `HandView.ts` | 卡牌只能拖拽放置，触屏/小屏操作不便 | 新增 tap-select 交互模式：点击卡牌进入选中态（卡牌上移 14px，列高亮显示），再点棋盘列放置；再次点击同一张卡牌取消选中；`pendingCardDown` 延迟拖拽判定（移动 > 8px 才升级为拖拽），两种模式共存；`HandView.hitTestCardIndex` 上边界扩展 `CARD_LIFT` 覆盖抬升后的点击区；`commitCardPlay` 提取为公共放置函数供两种模式共用 |
| `src/render/HandView.ts` | 卡牌仅有文字（U/B/S + 名称），难以辨认 | 每个卡槽新增 `art` 精灵（背景之上、文字之下）：普通兵→`infantry.png`、弓箭兵→`archer.png`、盾兵→`shieldbearer.png`、兵营→`game_infantry_barracks.png`、箭塔→`game_archer_barracks.png`（与场上建筑贴图一致），法术牌无图；插画等比缩放居中于类型行与名称/费用行之间，不被费用圆遮挡；名称改为底部居中加粗 13px；纹理按 key 懒加载缓存在 `Map`，异步加载完成时清空 `lastSyncKey` 触发重 sync；对象池回收时重置 `art` 为空纹理并隐藏 |
| `src/i18n/`（新增）+ 多文件 | 文案硬编码（中文写死），无多语言支持 | 新增 i18n 模块（`zh`/`en`/`de`，`zh.ts` 为键唯一来源，`en`/`de` 为 `Record<TranslationKey,string>` 编译强制全翻）；`t(key, params?)` 取词 + `{param}` 插值；LobbyScene / HUDView / ResultScene / GameRenderer 拖拽幻影所有硬编码字符串改走 `t()`；`CardDefinition.name` → `nameKey`+`descKey`（每卡预留描述文案）；徽章文案改为渲染时取词 |
| `src/platform/IPlatform.ts` + 三平台 | 各平台支持语言不同（微信只需中文） | `IPlatform` 新增 `getLanguage()`（系统语言标签）+ `supportedLocales`（Web/CrazyGames=`['zh','en','de']`，微信=`['zh']`）；`initI18n(lang, store, supported)` 把激活语言钳制到平台集合，玩家选择持久化到 `nw_locale` |
| `src/scenes/IntroScene.ts`（新增）+ `app.ts` | 缺少首次进入的背景故事引导 | 新增 `IntroScene`（背景故事逐行淡入 + 点击推进 + 跳过，文案在 i18n `story.*`）；`app.ts` 按 `storage` 的 `nw_seen_intro` 标记决定首启走引导还是直达大厅（当前为骨架，预留正式动画扩展点） |
| `src/render/HUDView.ts` + `GameRenderer.ts` | 横屏下底部 HUD 背景（`botBg` 全宽 alpha 0.92）盖住中段手牌，买得起的卡牌发灰，只有选中卡牌抬升的顶部冒出上沿是亮的 | `botBg` 拆到独立 `backgroundContainer`，`GameRenderer` 挂在 `handView` 之前渲染；HUD 前景（金币/HP/升级按钮/暂停/结算遮罩）仍在 `handView` 之后。层级改为 `vfx → HUD底栏背景 → 手牌 → HUD前景/遮罩` |
| `src/game/Board.ts` + `MovementSystem.ts` | 一列上多个单位排队前进时，最前面的单位进入 Crossing（横向移动）后仍留在原车道的 `columnUnits` 列表中（`y_fp` 冻结），后面的单位永远把它当作"前方单位"判定碰撞，即使前者已经走远也一直 `Waiting` | `Board.updateUnitCell` 新增 `oldCol` 参数，`col` 变化时把单位从旧列的 `columnUnits` 移到新列；`MovementSystem.tick` 记录 `prevCol` 并传入 |
| `src/game/Unit.ts` + `MovementSystem.ts` | 前方单位移动很慢时，后面单位每帧在"前方空隙刚好为正可以挪一点"和"挪完后又重叠被推回 Waiting"之间反复横跳，动画不停切换 Moving/Waiting | 新增 `Unit.crossingBlocked` 标记；一旦因前方单位停下（lane 内为 `UnitState.Waiting`，Crossing 内为 `crossingBlocked=true`），需等前方空隙 ≥ 自身体积（`2 × radius_fp`）才恢复移动，而不是空隙刚 >0 就动 |
| `src/`（清理）+ `design/game/DESIGN.md` | 旧实现遗留死代码与现 `entries → app.ts → scenes` 构建并存，无人引用却被跟踪，干扰阅读/搜索 | 删除 15 个孤立文件（根 `index.ts`/`wechatIndex.ts`/`GameRunner.ts`、`platform/crazygames.ts`、`game/` 下 `logic`/`gameScene`/`grid`/`effect`/`effectManager`/`consts`/`enums`/`header`/`display`/`numbers`/`helper`）；**保留** `game/index.ts`（公共 API barrel，`from '../game'`）和 `game/Card.ts`（被 `GameEngine`/`Player` 引用）；`design/game/DESIGN.md` §2 补 `cache/`、章节编号补连续（原缺 §8）、修正交叉引用 |
| `client/.gitignore` | 构建产物 `client/dist/` 被 git 跟踪，每次构建污染 diff（单 `index.js` 即数万行） | `.gitignore` 加 `/dist`；`git rm -r --cached dist` 取消跟踪 |
| `src/game/config.ts` | 卡牌自动刷新间隔 2 分钟，游戏节奏过慢 | `CARD_REFRESH_TICKS` 改为 900（30 s）；`CARD_REFRESH_INITIAL_OFFSET_MAX` 改为 450（15 s 错峰） |
| `src/render/HandView.ts` + `GameRenderer.ts` | 手牌无视觉提示，玩家不知道卡牌何时自动刷新 | 每张牌底部新增 3px 进度条（`bar` Graphics）：>10s 绿色、≤10s 黄色、≤5s 红色；最后 3 秒 sin 波 alpha 脉冲；`card_expired` 事件触发 `notifyCardExpired()` 渲染 250ms 白色淡出闪白（`flash` Graphics）；移除旧 `eraser` 遮罩 |
| `src/render/GameRenderer.ts` | 己方基地受击时无全局视觉反馈，容易忽视 | `base_hp_changed`（owner=0）触发全屏边缘红色晕影（`vignetteGfx`，12 层渐变矩形边框，宽 42–140px，alpha 叠加模拟径向渐变），0.55s 线性淡出；挂在 container 最顶层不影响输入 |
| `test/`（新增）+ `Unit.ts`/`Building.ts`/`GameState.ts` | 逻辑内核零自动化测试；且 `Unit`/`Building` 用模块级全局 `nextId`，跨 engine 实例 ID 不可复现，破坏 replay | 引入 **Vitest**（`vitest.config.ts` 仅扫 `test/**`，不进 webpack；`npm test`/`test:watch`），33 用例覆盖 fixed/prng/Resource/Movement/Combat + 同 seed 黄金回放结构全等；新增 `resetUnitIds()`/`resetBuildingIds()`，`GameState` 构造时调用使每局 ID 从固定基址开始；ID 命名空间调整为 **building 从 0、unit 从 1000**（建筑数受棋盘格封顶 <1000，单位高频增长取上段，永不冲突） |
| `src/game/systems/AISystem.ts` + `test/AISystem.test.ts`（新增） | AI"无脑出第一张可用牌"，无经济意识 / 防守 / 威胁评估 | 重写为**威胁驱动三段式决策**：①紧急防守（陨石清近基地敌群 → 威胁最高车道放箭塔 → ShieldBearer 肉盾）②升级规划（`upgradeReachable` 守卫，`nextUpgradeCost ≤ COIN_CAP` 才升级/攒钱）③经济进攻（按偏好挑性价比牌推最弱车道、安全车道补兵营、大团进攻陨石）；`computeThreatByCol` 按敌军接近 AI 基地程度加权；新增难度分级 `'easy'\|'medium'\|'hard'`（默认 medium）；仅依赖 state + 注入 Prng，黄金回放确定性不变；+5 测试（共 38 全绿）。配套把 `COIN_CAP` 30→**300**（≥ 首档升级费 50），让基地升级对人机双方均可达（此前 `[50,100,200]` 全 > 30 永远升不了级）；`upgradeReachable` 守卫保留为防御性代码 |
| `src/game/GameEngine.ts` | `processCommand` 的 Unit/Building/Haste/Meteor 四个分支各自重复「扣币/记账/清槽/发 card_played/补牌/发 resource_changed」样板 | 抽 `consumeCardSlot(player, owner, handIndex, card, effect)` 收敛重复，各分支只留校验 + 专属效果闭包（约 -50 行）；事件顺序逐字不变，黄金回放确定性测试通过 |
| `src/game/systems/MovementSystem.ts` | `tick()` 每帧 `Array.from(board.units.values())` 全量快照分配（仅为迭代中安全删除）；横穿寻敌扫描过滤顺序非最优 | 改为**直接迭代 `board.units` Map**（唯一删除是 `moveCrossing` 删当前单位，删当前项对 Map 迭代器良定义；本系统不新增单位）省掉每帧分配；清理 pass 同样直接迭代删 `isDead`、去掉 `has()` 守卫；`getFriendlyUnitAheadInCrossing` 把最具区分度的 `state !== Crossing` 判断提前。行为逐字不变，38 测试 + 黄金回放通过 |
| `src/game/campaign/levels.ts` + `levels/*.json`（新增）+ `levelSchema.ts`（新增） | 战役关卡是手写 TS 对象，无法被关卡编辑器读写，且无运行时校验 | 关卡迁为 **JSON 单一来源**（`campaign/levels/{ch1_lv1,ch1_lv2,ch1_lv3,ch_stress}.json`，用与原 TS 相同公式生成、逐字等价）；新增 `parseLevelDefinition`（`levelSchema.ts`）运行时校验：objective 类型 / `unitType ∈ UnitType` / `col ∈ ATTACK_LANES` / cellMask 界内 / starThresholds 单调，带字段路径报错，预留字段（hazards/crossWaypoints/story）原样保留；`levels.ts` 改为 import JSON → 过校验 → 建注册表；+14 测试（52 全绿），黄金回放确定性不变。配套关卡编辑器见上方「关卡编辑器」节 |
| `src/game/types.ts` + `config.ts` + `render/UnitView.ts` + `levels/ch1_lv{1,2,3}.json` + 编辑器 `units.ts` | 前三关与打 AI 体感无差（只用 PvP 的 3 兵种、单调出兵），且往单列堆兵因碰撞排队只拉长队伍不增压力 | 加 **2 个 PvE 专属怪种**（无 `CardDefinition` → 永不进 PvP 池，公平硬墙不破）：`UnitType.Ironclad`（重甲 hp260/spd0.5/radius520，抗箭逼陨石/近战）、`UnitType.Runner`（疾行 hp26/spd1.9/radius250，小半径真正成团）；`UNIT_BLUEPRINTS` / `UNIT_COLORS`（圆形渲染色）/ 编辑器调色板 META 各补 2 项。三关按**「压力 = 宽度（多列同 tick 齐射）× 混编质量，不是单列纵深」**重写：重甲打头吸塔火、弓箭排其后越肉盾射击（`CombatSystem.findTarget` 不受 Moving/Waiting 门控，只按同列前方射程扫描，故成立）、疾行兵海做密集多列冲锋；lv3 终盘近 8 列多兵种齐压。**注意**：关卡旋钮目前仅 `noBuild`+`startCoins` 真接入引擎（`GameEngine` line ~89），`board.blocked`（阻挡移动）/`activeLanes`/`hazards`/`crossWaypoints`/`leak_limit` 均未实现、schema 只 pass-through，勿在关卡里依赖。tsc 干净 + 52 测试全绿（确定性回放/关卡校验不破）+ web 与编辑器构建通过 |
| `src/game/net/InputSource.ts`（新增）+ `GameEngine.ts` + `game/index.ts`（C-4）| 命令入口是「UI 直接 `processCommand`」（`pendingCommands` 缓冲），无法接联机/回放 | 引入统一输入管线（M13）：`InputSource` 接口（`submit(cmd)` / `take(frame)→cmds｜null`，`null`=该帧未确认即停步，为 S1-7 net 缓冲留口）+ `LocalInputSource`（DELAY 0 自转发，行为等价原 `pendingCommands`）；`createGameEngine(config, input?)` 可选注入（缺省 Local）；`playCard`/`upgradeBase`→`input.submit`，`tick(dt)`→`input.take(currentTick)`；AI(PvP)/WaveDirector(PvE) 仍在 `step` 内按原序消费（注释标为 tick 内输入源）。`NetInputSource`(S1-7)/`ReplayInputSource`(S1-RP) 是同接口的另两个实例。tsc 干净 + 63 测试全绿（黄金回放/campaign 确定性不破）+ web 构建通过 |
| `src/game/meta/`（新增）+ `net/`（新增）+ `platform/{IPlatform,uuid,web,wechat,crazygames}` + `app.ts`（S0-1~5）| 客户端无存档底座 / 云同步 / 匿名账号 | 新增元系统存档模块：`meta/SaveData.ts`（镜像服务端 SaveData，纯数据）、`meta/migrate.ts`（迁移链 + 兜底，含单测）、`meta/SaveStore.ts`（`LocalSaveStore`，key `nw_save_v1`，收编旧 `nw_seen_intro`→`flags.seen_intro`）、`meta/SaveManager.ts`（离线优先 + 防抖 2s push + 409 pull-merge reconcile）；`net/ApiClient.ts`（REST，If-Match 乐观锁）+ `net/config.ts`（`getApiBaseUrl`，缺省纯本地）；`IPlatform.getAuthCredential()`（device UUID / wx.login code）三平台实现 + `platform/uuid.ts`；`app.ts` 构建 SaveManager、非阻塞 `bootstrap()`、Intro 门控改读 `flags.seen_intro`。**注**：`nw_locale` 仍由 i18n 自管（字符串，`flags` 仅布尔），未收编。tsc 干净 + 11 新测试（共 63 绿）+ web 构建通过。**微信 rollup 构建预存在 PNG 资源 loader 缺失问题（与本改动无关）** |
| `src/net/{NetClient,BrowserGameSocket}.ts`（新增）+ `net/config.ts` + `net/proto/*`（codegen）+ `platform/{IPlatform,web,crazygames,wechat}`（S1-6）| 客户端无 gameserver 联机通道 | 新增 `NetClient`（WS 连接/重连/协议编解码）：`IPlatform.connectSocket(url, handlers)→IGameSocket` 抽象（Web/CrazyGames=`BrowserGameSocket` 全局 WebSocket，微信=`WechatGameSocket` 包 `wx.connectSocket`）；NetClient 退避重连 + 代次（gen）作废滞后回调（微信 socket 无法摘回调）、首次 open 与重连 open 区分（仅后者触发 `onReconnect`，由上层发 conn_resume 续局）、应用层心跳、未 open 丢弃发送；用 C-2 ts-proto 编解码 `Envelope`。验证：tsc 干净 + 6 单测（假 socket 连接/重连/代次/解码/丢弃）+ 端到端真 NetClient↔真 gameserver 跑通整局 friendly（同 seed / 空闲节拍 +3 / 出牌同帧 opaque / base 结算）+ web 构建通过（共 87 测试绿） |
| `src/game/net/NetInputSource.ts`（新增）+ `game/types.ts` + `GameEngine.ts` + `game/index.ts` + `server/contracts/game.proto`（S1-7）| 联机锁步缺少把 gameserver `frame_batch` 接到确定性引擎的输入源；引擎只有 `pvp`(AI)/`campaign`(波次) 两档，无「双人都是真人」模式 | 实现 `NetInputSource`（`InputSource` 的联机实例，与 `LocalInputSource` 并列）：出牌即 `submit`→`game.proto` `PlayerCommands` opaque bytes→`cmd_submit`（不预算帧号，owner/tick 占位由服务器派定 side+帧）；消费 `frame_batch`→`FrameCmds` 解码回 `PlayerCommand[]`（owner=`SideCmd.side`、tick=`FrameCmds.frame`，保服务器排序）；`take(frame)` 释放已确认帧，未确认返回 `null` 让引擎停步（锁步、无预测/回滚）。**缓冲**：播放头落在最新水位后 `bufferFrames`（默认 1 批=3 帧≈100ms），吸收 <100ms 抖动；服务器停发→水位冻结→引擎暂停；突进/重连 `conn_resync` 跳水位→引擎快进追帧；水位单调（陈旧批次不回退）。新增 `GameMode 'netplay'`（双方真人、不跑本地 AI/波次，`step` 只处理确认指令集）。`game.proto` `PlayCard` 加 `row`（field 3，陨石目标行；单位/建筑/加速忽略）——`npm run proto:gen` 重生 `net/proto/game.ts`（transport 向量不受影响，无需重生）。验证：tsc 干净 + 19 新测试（take/缓冲/水位/解码/no-rollback/resync + 双客户端同 seed 同流逐 horizon fingerprint 全等 + 停发暂停/重连追帧/抖动吸收）+ web 构建通过（共 106 测试绿）。**注**：双引擎单进程跑会因模块级 unit/building id 计数器交错而 id 错位（真机各自进程不会），测试改为录制合流帧流后顺序回放两引擎对拍 |
| `src/scenes/RoomScene.ts`（新增）+ `net/NetSession.ts`（新增）+ `app.ts` + `scenes/GameScene.ts` + `scenes/LobbyScene.ts` + `i18n/locales/{zh,en,de}.ts`（S1-8）| 网络层（NetClient/NetInputSource）已就位但无玩家可点的房间界面，friendly 联机链路接不通 | 新增 **RoomScene**（canvas 绘制，视图机 `idle → codeEntry → connecting → inRoom`；输码键盘 charset 同服务端去 `0O1IL`，6 位；命中走 hit-list 即时模式重绘；i18n `room.*` 36 键 zh/en/de 全翻）+ **NetSession**（绑 NetClient+NetInputSource：`route(ServerMsg)` 全量喂 input + room 级消息抛 UI、重连 `onReconnect`→`resume(roomId, resumeFrame())`、`onMatchStart` 抛 app 建引擎，跨场景存活）。`app.ts` 懒建 NetSession（须 REST 基址 + WS 端点齐备，否则 `available:false` 房间 UI 仍可开但 create/join 弹「联机服务不可用」）、大厅底栏「社交」格 → `goRoom()`、`match_start` → `createGameEngine({seed, mode:'netplay'}, session.input)` → `GameScene`、局末 `reportResult(FNV-1a(winner+stats))`（S1-5 握手，两端确定性同串）。`GameScene` 加 `engine?` 选项接预建引擎；`LobbyScene` 加 `onOpenRoom` + 社交格命中区（金点示活）。验证：tsc 干净 + 100 测试全绿 + web 构建通过 + 浏览器实测 idle/codeEntry 两视图（社交入口→创建/加入→输码键盘逐字填充、填充槽蓝框）。**注**：`inRoom` 全貌（双槽/ready/start/房间码）需活 gameserver 推 `room_state` 才显示，留 S1-9 双机验收 |
| `layout/ScalingManager.ts` + `app.ts` + `render/{GameRenderer,HUDView,BoardView,NetStatusView(新增)}.ts` + `scenes/{GameScene,ResultScene}.ts` + `i18n/locales/{zh,en,de}.ts`（S1-9 客户端）| ①`GameRenderer` 固定 owner-0（下方）视角，joiner（localSide 1）看到不翻转的棋盘、控制顶部却显示在底部；②锁步停步（等待对手帧）时棋盘冻结，玩家以为卡死 | **①换边视角**：`createLayout(w,h,localSide?)` 加 `localSide` 参数（缺省 Bottom；joiner=Top → 180° 翻转，自家基地/手牌/HUD 落屏幕底部）；`app.goGameNet` 按 `info.localSide` 建 netLayout 传 GameScene。引擎本身已完全 owner 感知（服务器派 side，`processCommand` 按 owner 选 BOTTOM/TOP 行），故只改渲染层：`GameRenderer` 从 `layout.localSide` 推 `localOwner` + 本地建造/出兵行，手牌/升级/拖拽取本地玩家、`event.owner === localOwner` 判己方（受击红晕/出牌/弃牌）、出牌校验用本地行；`HUDView.sync`/`showGameOver`、`BoardView.playBaseCrackEffect`、`ResultScene`（stats[localOwner] + 胜负判定）均按 `localOwner` 映射。**②战斗内网络态薄层**：新增 `NetStatusView`（顶部居中胶囊 + 动画省略号，优先级 peerDc>reconnecting>waiting，非交互）；`GameRenderer` 比对每帧 `elapsedTicks` 是否推进检测停步（>0.3s 且 Playing 非暂停 → 显「等待对手」spinner，帧恢复即清并清 peerDc）；`NetState 'reconnecting'`→重连 toast、`peer_dc`→对手掉线横幅；服务器 `match_over`（disconnect/mismatch、本地未结束）经 `GameScene.applyMatchOver`→`onNetMatchOver` 直接进结算（不上报 hash）。i18n `net.{waiting,reconnecting,peerDc}` zh/en/de 全翻。验证：tsc 干净 + 100 测试全绿 + web 构建通过。**留 S1-9 双真机联调**（逐 tick 一致 + conn_resync 续打） |
| `src/game/net/ReplayInputSource.ts`（新增）+ `game/types.ts` + `game/index.ts`（S1-RP）| 统一输入管线缺第三个实例：录制 + 回放。无法把一局（PvE/PvP）落成「seed + 输入流」并逐 tick 还原 | 实现客户端录制/回放（M13，与 `LocalInputSource`/`NetInputSource` 同接口）：`RecordingInputSource` 透明包装任一 `InputSource`，捕获引擎每 tick 经 `take()` 确认的指令集（稀疏只存非空帧、帧号单调单次捕获、深拷贝防后续 live 对象变更污染录像），`snapshot()` 产出 `Replay`；`ReplayInputSource` 喂录像 `Replay` 驱动新引擎——`take(frame)` 返回该帧录制指令（空帧返回空集、**永不停步**）、`submit()` 忽略（回放固定、不让 live UI 注入）、构造时校验 `engineVersion` 不符抛 `ReplayVersionError`（可关）。`Replay` 类型扩展镜像 `replay.proto`（`engineVersion`/`mode`/`seed`/`configRef`/`frames`/`endFrame`/`meta`；命令保留 TS 对象、JSON 可序列化，非 opaque bytes——v1 本地录制）+ `ENGINE_VERSION=1`。**关键**：PvE 录像天然只含玩家(owner 0)指令——敌方 `WaveDirector` 不走输入管线，回放时由 seed+level 重算；PvP 录确认流双方都含。验证：tsc 干净 + 10 新测试（`test/replay-input-source.test.ts`：PvP-vs-AI + campaign(PvE) 录制→回放终局指纹全等、JSON round-trip、engineVersion 拒绝、take/submit/sparse 语义）+ 共 110 测试全绿 + web 构建通过。**待办**：`replay.proto` + gameserver PvP 输入日志持久化到 `matches.replayRef`；回放播放器 UI |
| `scenes/{GameScene,ReplayScene(新增),ResultScene}.ts` + `render/GameRenderer.ts` + `game/meta/ReplayStore.ts(新增)` + `app.ts` + `server/{contracts/replay.proto(新增),gameserver/src/{Room,RoomManager},shared/src/mongo}.ts` + i18n（S1-RP A+B）| 录制/回放底座（`ReplayInputSource`/`RecordingInputSource`）已就位但无场景接它（录不下、放不出），且 PvP 录像未落服务端 | **A 接录制 + 回放 UI**：`GameScene` 自建局（campaign / PvP-vs-AI）改用 `RecordingInputSource` 包 `LocalInputSource`，捕获 seed/mode/levelId，局末 `onGameEnd(winner, stats, replay?)` 透出录像（联机注入引擎无 recorder→undefined）；`app.ts` 建 `ReplayStore`（key `nw_replays_v1`，最近 12 局 ring + 损坏退化）落盘并把录像传 `ResultScene`；`ResultScene` 有录像即显「观看回放」按钮→`app.goReplay`→新增 `ReplayScene`（`ReplayInputSource` 驱动 + `GameRenderer` 新增 `spectator` 构造参数[跳过 input 接线，纯观看] + 自绘 transport 覆盖层：播放/暂停、1×/2×/4× 变速、进度条、退出、结束/版本错误提示）；`GameRenderer` 加 `get currentTick` 供进度。i18n `replay.*`+`result.watchReplay` zh/en/de 全翻。**B 服务端持久化**：`replay.proto`（复用 transport `FrameCmds`）；gameserver 局末把重连用的非空帧日志零成本内嵌进 `matches.replay`（`Room.buildReplay`→`MatchArchive.replay`→`RoomManager.archive` 写 BSON binary，opaque 不解码；M12 逻辑无关→`engineVersion=0` 客户端回放自校验）；`MatchDoc.replay?: MatchReplayDoc`。验证：client tsc + 116 测试全绿（+6 `test/replay-store.test.ts`）+ web 构建；server `tsc -b` 全绿。**待办**：大局录像转对象存储 `replayRef` + 分享；服务端 opaque bytes 录像→客户端 `Replay` 解码回放适配 |
| `scenes/{ShopScene,GachaScene}.ts`（新增）+ `net/ApiClient.ts` + `game/meta/SaveManager.ts` + `scenes/LobbyScene.ts` + `app.ts` + `i18n/locales/{zh,en,de}.ts`（S2-5/6）| 经济后端（S5 commercial + meta 编排）全齐，但客户端无任何花钱界面——商店/盲盒/充值入口为空，玩家花不出金币 | **客户端商店 + 盲盒 + 虚拟充值**：`ApiClient` 加 6 个经济方法（`getShopItems`/`shopBuy`/`getGachaPools`/`gachaDraw`/`adsReward`/`iapVerify`）+ DTO（`ShopItem`/`GachaPool`/`GachaResultEntry`），对接已有 meta 端点，回推权威 SaveData；余额不足→`ApiError('INSUFFICIENT_FUNDS')`。`SaveManager.adoptServer(save)` 吃经济回执（钱包/库存/盲盒/pvp 以服务器为准，复用 `reconcile`，同步段合并本地）。新增 **ShopScene**（canvas，render+hit-list 模式；商品行已拥有标记/余额校验、购买 toast、底部「🎁 盲盒」「💎 充值」入口；充值用隐藏 `<input>` 收码的模态浮层，hit-list 清空保证模态独占）+ **GachaScene**（单抽/十连、保底进度条、稀有度图例、抽后结果揭示层：稀有度配色卡 + NEW/重复徽章、点任意处继续）。**虚拟充值**：`app.rechargeTier()` 把 `taowang`→mid 档（`-s`/`-l`→small/large）→ `iapVerify('dev-'+Date.now(), 'tier:xxx')` 命中服务端 dev 桩，platform 带时间戳保票据唯一可重复充值，**零服务端改动**，上线换平台 SDK。`LobbyScene` 底栏「商店」格（i===3）点亮接入、离线模式路由登录（花服务器权威币需账号）。i18n `shop.*`/`gacha.*`/`rarity.*` zh/en/de 全翻。验证：tsc 干净 + web 构建 + 128 测试全绿 |
| `render/{theme,sketch,bake,sketchDemo}.ts`（新增）+ `BoardView.ts` + `scenes/LobbyScene.ts` + `entries/web.ts` + `app.ts`（美术第一刀）| 美术纲领（`design/product/art-direction.md` v0.3「程序绘制 + 烘焙缓存」）零落地：棋盘是拉伸 `map.png`，永远对不上运行时动态网格 | 程序绘制底座：`theme.ts`（调色板 paper/pencil/inkBlue/inkRed/marker/ruleLine + 笔触参数）+ `sketch.ts`（`SketchPen` 类：确定性 `Prng` 抖动的 `stroke/line/rect/circle/hatch`，收笔变细 taper + 双描边 ghost；`drawSketchDemo`）+ `bake.ts`（`setBakeRenderer`/`bake(key,obj,w,h)`：`renderer.render`→RenderTexture 按 `board:orient:WxH:cell` 缓存）。`BoardView` 删拉伸 `map.png`，`drawBoard()` 本地坐标画纸底 + 手绘 ruled 网格（用 layout.cellSize 与动态层对齐）+ 涂鸦边框 → bake 成 Sprite（headless 无 renderer 回退 live）。`app.ts` `setBakeRenderer(app.renderer)`；`?sketch` URL 走 `sketchDemo.ts`（dynamic import，不进主 bundle）。大厅背景 + 功能块（feature/campaign/start/VS 卡）全改 `SketchPen`，左侧红钢笔 margin 线。删无引用 `src/assets/map.png` |
| `render/theme.ts` + `UnitView.ts` + `BoardView.ts`（美术第二刀，本次）| ①单位阵营色没真正落地：body 按兵种硬编码色、阵营只靠一圈描边，违反 §3.2「兵种不靠颜色区分（颜色已被阵营占用）」；②`theme.ts` 自称单一来源但 UnitView/BoardView 高亮色全各自硬编码；③基地裂缝用裸 `lineStyle` 非手绘笔；④`sketch.ts` 缺 §5.2 承诺的 circle 原语 | ①`theme.ts` 加 `factionInk{friend:inkBlue,enemy:inkRed}` + `fx{lane*/buildingValid/meteor/upgrade/noBuild/hp*}`（§3.3 功能色不受蓝红约束）；②`UnitView` 占位圆改 **faction ink 填充为主**（蓝=我/红=敌）+ 兵种小 marker 点（次要可辨识）+ 铅笔描边 ring；HP 色取 `fx`；③`BoardView` 高亮/no-build/meteor/upgrade 全引 `theme.fx`，`playBaseCrackEffect` 改 `SketchPen.stroke` + `palette.pencil`（按 `crackSeed` 递增，每击一道手绘裂缝）；④`SketchPen.circle`（闭合 wobble 多边形 + 起点过冲）。同步 `art-direction.md §5.2` API 命名（`sketchLine/Rect/Circle`→`SketchPen.stroke/line/rect/circle/hatch`）。tsc 干净 + 131 测试 + web 构建绿 |
| `render/{wearOverlay,boil,stickmanDraft,castle}.ts`（新增）+ `UnitView.ts` + `BoardView.ts` + `GameRenderer.ts` + `scenes/LobbyScene.ts`（美术第三刀：future work 全落地）| 纲领四项 future 未实现：grain/磨损 overlay、呼吸线、角色沿骨骼草稿、基地 2×2 手绘城堡 | ①`wearOverlay.ts`「翻了一年的笔记本」静态 overlay（§3.1）：确定性 Prng grain 颗粒 + 折痕 + 暗角（嵌套低 alpha 角三角，非渐变）+ 马克笔透印，bake 缓存 per (w,h)，大厅 + 战场各铺一层（alpha~0.5，非交互，在 HUD 之下）。②`boil.ts` 呼吸线（§5.4）：`BoilingSprite` bake N 个不同 seed 变体、~8fps 循环切 visible（只翻可见性零重画）；大厅标题下马克笔下划线用之。③`stickmanDraft.ts` 角色沿骨骼草稿（§5.5 北极星）：沿真实 `.tao` 11 骨骼（复用 `render/stickman/skeleton.ts` 的 `computeFK` 静息姿）用 SketchPen 画收笔变细管状肢 + 关节圆 + 潦草头 + 铅笔眼点，faction ink 染色；`UnitView` 占位圆（Ironclad/Runner + .tao 加载前回退）改画此草稿，按兵种 `DRAFT_HEIGHT` 高度差给剪影区分（§3.2 类型靠剪影），ring 改铅笔地面投影。④`castle.ts` 基地 2×2 手绘城堡（§6.3）：垛口墙 + 拱门 + 三角旗，faction ink + 铅笔结构线，bake per (size,side)；`BoardView.buildBaseRef` 删 `game_base.png` 改 `buildCastle`（色彩载阵营，无需镜像）。删无引用 `src/assets/game_base.png`。tsc 干净 + 131 测试 + web 构建绿 |
| `webpack.config.js` + `scenes/LoginScene.ts` + `i18n/locales/{zh,en,de}.ts` | ①注册「没有网络请求」：`net/config.getApiBaseUrl` 读 `globalThis.__NW_API_BASE__`，但 webpack `DefinePlugin` 只定义了 `TARGET`，从未注入该全局 → `getApiBaseUrl` 恒返 null → `app.ts` 不建 `ApiClient`（`api=undefined`）→ `doAuth` 直接返回 `auth.err.network`，`fetch` 从未发出（服务端 `/auth/register`、CORS 均已就绪）；②注册页缺确认密码 | ①`DefinePlugin` 注入 `globalThis.__NW_API_BASE__` / `__NW_GATEWAY_WS__`：取 env `NW_API_BASE`/`NW_GATEWAY_WS`（CI/生产，如 `https://host/api`），dev 缺省 `http://localhost:18080`（metaserver `NW_META_PORT`）+ `ws://localhost:8082/gw`（gateway `NW_GW_PORT`），开箱即可注册/联机；生产未配留空 → null → 纯本地离线（行为不变）。②`LoginScene` 加 `confirmPassword` 字段（masked，仅 register 视图，password 与 displayName 之间）；`onSubmit` 校验非空 + 与 password 一致，否则 `auth.err.passwordMismatch`；hidden input 对 confirmPassword 同样走 `type=password`。i18n 加 `auth.confirmPasswordLabel`/`auth.err.passwordMismatch` zh/en/de 全翻。tsc 干净 + dev 构建注入 URL 已验证（dist 含 `localhost:18080`/`8082/gw`）。③注册页加实时合规提示（`drawHint`：✓ 绿/• 灰，随输入每帧重绘，镜像服务端 `MIN_PASSWORD_LEN=6`/`MIN_LOGIN_ID_LEN=3`）+ 提交前客户端预校验（loginId 至少 3 位 / 密码至少 6 位 / 两次一致），不合规不发请求；i18n 加 `auth.hint.{loginId,password,match}`。④`doAuth`/`LoginScene` 把真实错误打到 console + 错误行下方显示 `code: message`（之前只映射成笼统 `auth.err.network`）；submit Promise 加 `.catch`，任何 outcome/rejection 都还原回表单，避免异常令 render 半途清空 hits 停在无按钮的 submitting 态。**注**：webpack `DefinePlugin` 改动需重启 `npm run start`（dev server 不热读配置）；临时绕过可 `localStorage.setItem('nw_api_base','http://localhost:18080')` |
| `scenes/LoginScene.ts` + `design/product/art-direction.md §7.5.1` | 注册/登录按钮无状态表现：可用/不可用/按下长得一样，密码不一致时点提交「看着像卡死」——其实按钮命中矩形固定、点击确实调到 `onSubmit`，只是重新校验后又显示同一条 mismatch 错误（实时提示那行灰色 `• Passwords match` 已说明 `pw!==cpw`），屏幕无变化故像点不动；且错误「黏性」，改输入也不清除 | ①编辑任一字段即清除残留 `errorKey`/`errorDetail`（绿色 ✓ 提示本就每帧刷新，红字现在同步消失），表单保持「活」的；②新增 `submitEnabled(isRegister)`（登录=两框非空；注册=账号≥3+密码≥6+确认非空且一致，**与 `onSubmit` 校验逐字一致**）驱动提交按钮可用/不可用；③`addButton` 加 `enabled` 参：不可用=淡灰底 `C.btnDis`+灰字+细边+alpha 0.55+点击 inert，可用=原深底/金蓝边/白粗字；每次输入重绘，密码补齐瞬间按钮即由灰变亮；④`press` 状态：点可用按钮以中心快速放大回弹（1.0→1.12→1.0，0.12s，正弦），动画结束才触发动作，放大期间 `handleDown` 吞掉其它点击防误触/重复提交（按钮在自有居中 `PIXI.Container` 内绘制以正确缩放）。按钮三态规范沉淀进 `art-direction.md §7.5.1`（修订旧「按下=下压」口径为「中心放大+延迟触发」）。tsc 干净 |
| `scenes/SettingsScene.ts`（新增）+ `render/avatar.ts`（新增）+ `LobbyScene.ts` + `app.ts` + i18n | 大厅无个人资料入口；展示名注册后显示为「访客」 | ①大厅左上角加个人资料 chip（头像 + 名字，盖在深色 header 上），点击进 **SettingsScene**（个人设置：头像/名字/段位 + 语言切换 zh/en/de + 账号登录/登出 + 改名）。`render/avatar.ts` 程序绘制头像（手绘墨水圆圈 + 名字首字母，faction 蓝，确定性 per name+seed）。②展示名持久化到 `nw_player_name`（注册存 displayName / 登录存 loginId）。③`LobbySceneCallbacks` 加 `playerName`/`onOpenProfile`。i18n `settings.*` zh/en/de 全翻 |
| `net/ApiClient.ts` + `game/meta/SaveManager.ts` + `app.ts` + 服务端 auth/save | 注册时填的展示名只写进库、auth/save 响应从不返回 → 客户端永远拿不到，显示「访客」；且 token 续登不重新 auth，无从恢复名 | 服务端 `AuthResult`（register/login/device/wx）+ `GET /save` 均回带 `displayName`（有才带）：accounts.ts `resolveByDevice/Openid`/`registerWithPassword`/`loginWithPassword` 带出 + 新增 `getDisplayName`；service.ts 各 auth + `getSave` 附 `displayName`。客户端 `ApiClient.getSave` 返回 `{save,displayName}`；`SaveManager` 加 `onProfile` 回调（bootstrap/refresh 拉到名即回调）；`app.ts` 持久化名 + 名字变化且在大厅时重建大厅 → **token 续登自动恢复展示名，无需重登** |
| `scenes/SettingsScene.ts` + `net/ApiClient.ts` + `app.ts` + 服务端 commercial/meta + i18n | 无改名功能 | **改名消耗 500 金币**（`RENAME_COST`，`shared/economy.ts`）：commercial 加通用金币 sink `spend()`（原子 `$gte` 扣币 + orderId 幂等 + `OrderDoc.kind:'sink'` 落库即 `delivered`，对账 `undeliveredOrders` 不拾取）+ `/internal/spend`；meta `POST /profile/rename`（先扣币→不足 402 名不变→写新名 `setDisplayName`→钱包镜像回推；名长 1–24 `validateDisplayName`，空名 400）；客户端 SettingsScene 改名按钮（余额不足置灰）+ 模态改名弹层 + `ApiClient.rename`；`app.doRename` 采纳回推存档 + 持久化新名。i18n `settings.rename*` 全翻。验证：server `tsc -b` 六包 + commercial 21（+spend）/ meta 44（+3 rename e2e + 2 auth displayName）/ client 132（+onProfile）测试 + web 构建全绿 |
| `scenes/LobbyScene.ts` + `app.ts` + `scenes/RoomScene.ts` | 大厅「开始对战」按钮恒打 AI（`matchFound()` 直接 `randomAiName()` 开本地局，从不连服务器），登录与否一样；真人排位埋在底栏「社交」→ RoomScene→「排位赛」里，玩家以为登录后 match 就该匹配真人 | **登录后 match 走真人排位**：`LobbySceneCallbacks` 加 `online`(=登录+`api`+`gatewayUrl`) + `onStartRanked?()`；`onStartPressed()` 在 `online` 时调 `onStartRanked()`（→ `app.goRoom({autoRanked:true})`）否则回退原 AI 快速练习。`goRoom` 接 `autoRanked`：RoomScene 直接落 `searching` 视图，app 在 **gateway WS `open` 后**才发 `createRanked()`（连接握手未完发送会被 NetClient 丢弃；老连接已 open 则立即发），取消搜索重置 `rankedQueued` 守卫。离线/未登录/无 gateway → match 原样 AI 局不变。tsc 干净 + client 132 测试全绿。**注**：真人对战需 gateway+matchsvc+game(+meta) 四进程在跑且有第二玩家排队，否则点 match 卡「搜索中」是预期（无对手），非 bug |
| `server/dev-up.ps1` | 排位匹配恒卡「搜索中」：dev:all 启动脚本把 gateway 起在 `NW_GW_PORT=8085`，但客户端硬连 `ws://localhost:8082/gw`（webpack 默认 + gateway 自身默认都是 8082）→ 浏览器报「can't establish connection」，`createRanked` 在 WS open 前被 NetClient 丢弃；且 gateway 缺 `NW_META_BASE_URL` → `enqueueRanked` 因 `meta.available=false` 直接 `RANKED_UNAVAILABLE`，取 ELO 失败 | gateway env `NW_GW_PORT` 8085→8082、补 `NW_META_BASE_URL=http://127.0.0.1:18080`；meta env 补 `NW_GATEWAY_PUBLIC_WS_URL`（见下行） |
| `metaserver/{config,app,index,service}.ts` + `contracts/openapi.yml` + `client/{net/ApiClient,game/meta/SaveManager,app}.ts` + `dev-up.ps1` | 客户端 gateway 地址走 webpack 静态注入 / 由 API 基址推导，与服务端实际端口易不一致（上行 8082/8085 即此类）；架构上客户端应只硬编码 meta 地址，其余实时获取 | **gateway 地址改由服务器下发**：meta 加环境变量 `NW_GATEWAY_PUBLIC_WS_URL`→`config.gatewayPublicUrl`，四个 auth 回包 + `GET /save`（token 续登无 auth 回包）均带 `gatewayUrl`；`openapi.yml` 的 `AuthResult` + save 响应 schema 加 `gatewayUrl`（否则 `fast-json-stringify` 剥字段）。客户端 `ApiClient.AuthResult`/`getSave` + `SaveManager.onProfile` 带出 `gatewayUrl`；`app.ts` 的 `gatewayUrl` 改可变 + `applyGatewayUrl()`（服务器值覆盖构建期 fallback、丢弃旧 NetSession 重建、刷新大厅 `online`），`doAuth`(登录/注册) 与 `onProfile`(续登) 两路径接入。`getGatewayWsUrl` 保留为 fallback（生产同源 `/api`→`/gw` 推导）。game 地址本就由 `match_found` 下发。tsc 六包 + client tsc 干净 |
| `server/dev-up.ps1` + `client/webpack.config.js` | gateway 启动崩溃 `Error: listen EACCES: permission denied 0.0.0.0:8082`（**非** EADDRINUSE，即没有进程占用），浏览器随后 `ws://localhost:8082/gw` 全部「can't establish connection」/401 重试。根因：**本机 Windows 把 8082（及 8083）划进了 TCP 排除端口段**（`netsh interface ipv4 show excludedportrange protocol=tcp` 可见 `8082-8082`/`8083-8083`，无 `*` 即非管理员手设，是 WinNAT/Hyper-V/Docker Desktop 动态保留）——排除段内的端口任何进程 `listen` 都被 OS 拒绝（EACCES），且重启后可能复现。`8081`(gameserver) 不在排除段故正常，说明 `808x` 非系统性封禁。 | gateway 公网端口从 8082 改到 **8086**（`netsh` 排除段外、实测空闲），三处保持一致：`dev-up.ps1` 的 gateway `NW_GW_PORT` + meta `NW_GATEWAY_PUBLIC_WS_URL`（meta 下发给客户端的权威地址）+ `webpack.config.js` 的 `gatewayWs` 登录前 fallback 默认。**排查口诀**：联机连不上先 `netsh ... show excludedportrange` 看端口是否落进排除段，撞上就换端口（换 8086 这类段外端口最省事，无需管理员）；或管理员 `net stop winnat; netsh int ipv4 delete excludedportrange protocol=tcp startport=8082 numberofports=2; net start winnat` 释放（但重启后可能再被保留，故首选换端口）。改 `webpack.config.js`/`DefinePlugin` 须重启 `npm run start`（dev server 不热读配置）；改 `dev-up.ps1` 须重启对应服务窗口。 |

### 游戏核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理；每 tick 从注入的 `InputSource` 消费玩家确认指令集（M13） |
| `game/net/InputSource.ts` | 统一输入管线（M13）：`InputSource` 接口 + `LocalInputSource`（单机 DELAY 0 自转发） |
| `game/net/ReplayInputSource.ts` | 录制/回放（S1-RP）：`RecordingInputSource`（透明包装任一 `InputSource`，捕获每 tick 确认指令集，稀疏存非空帧，`snapshot()→Replay`）+ `ReplayInputSource`（喂 `Replay` 驱动引擎，`take` 永不停步、`submit` 忽略、校验 `engineVersion`）。PvE 录像只含玩家指令，敌方波次回放时由 seed+level 重算 |
| `game/meta/ReplayStore.ts` | 本地录像持久化（S1-RP）：key `nw_replays_v1`，最近 12 局 ring（save/load/list/latest/clear），损坏退化为空；与 `SaveData` 分离（录像是本地产物，非云同步段） |
| `scenes/ReplayScene.ts` | 回放播放器（S1-RP）：`ReplayInputSource` 驱动新引擎 + `GameRenderer` spectator 模式（无交互）+ 自绘 transport 覆盖层（播放/暂停、1×/2×/4× 变速、进度条、退出）；版本不符显错误提示 |
| `game/net/NetInputSource.ts` | 联机锁步输入源（S1-7）：`submit`→`game.proto` opaque bytes `cmd_submit`；消费 `frame_batch`/`conn_resync`、解码回 `PlayerCommand[]`、按水位 + `bufferFrames`(默认 3) 释放、未确认 `take()→null` 停步；配 `GameMode 'netplay'`（双方真人、无本地 AI） |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（注入 `Prng` + 难度档；威胁驱动三段式：紧急防守 / 升级规划 / 经济进攻；只读 state，返回 `PlayerCommand[]`） |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |
| `i18n/index.ts` | `t()` 取词 + 插值；`initI18n`/`setLocale`/`getLocale`/`getSupportedLocales`/`onLocaleChange`/`detectLocale` |
| `i18n/locales/{zh,en,de}.ts` | 词条字典；`zh.ts` 为键唯一来源（`TranslationKey`），`en`/`de` 编译强制全翻 |
| `game/meta/SaveData.ts` | 元系统单一权威根（纯数据，镜像 `server/shared/src/types.ts`）；`makeNewSave`/`SyncPatch`/`extractSyncPatch`/`SAVE_VERSION`/`SAVE_STORAGE_KEY=nw_save_v1` |
| `game/meta/migrate.ts` | `migrate(raw)→SaveData`：MIGRATIONS 顺序升级 + `fillDefaults` 兜底（保留动态键）+ 钉死 version；改字段必加迁移步骤 |
| `game/meta/SaveStore.ts` | `LocalSaveStore`：本地存档读写（迁移/损坏退化/`nw_seen_intro`→`flags.seen_intro` 收编），零网络依赖 |
| `game/meta/SaveManager.ts` | 云同步编排（S0-5）：loadLocal 即玩 → bootstrap auth+pull+reconcile → update() 改同步段立即落本地+防抖 2s push → 409 reconcile 重试；无 api 时退纯本地 |
| `net/ApiClient.ts` | metaserver REST 客户端（fetch + ApiResp 包络）：auth/device·auth/wx·GET/PUT save（If-Match 乐观锁，409 不抛返回 conflict） |
| `net/config.ts` | `getApiBaseUrl`（REST 基址）+ `getGatewayWsUrl`（控制面 `/gw`：`__NW_GATEWAY_WS__` > localStorage `nw_gateway_ws` > 由 API 基址推导 `/api→/gw`；null=无联机，S1-M4）+ `getGameWsUrl`（旧 `/ws` 推导，保留；数据面 game_url 现由 `match_found` 下发，不再静态配置） |
| `net/NetClient.ts` | WS 客户端（S1-6）：连接/重连（退避 + 代次作废滞后回调）/ ts-proto 编解码；`queryParam`(默认 `token`，game 数据面传 `ticket`，S1-M4) typed send（createRoom/joinRoom/setReady/startMatch/submitCmd/reportResult/resume/ping）+ `onServerMsg`/`onReconnect`/`onStateChange`；只管消息管道，gateway 与 game 各用一个实例 |
| `net/BrowserGameSocket.ts` | 浏览器二进制 WS（Web/CrazyGames 共用，`binaryType=arraybuffer`）；微信侧 `WechatGameSocket`（`wx.connectSocket`，在 `WechatPlatform.ts`） |
| `net/NetSession.ts` | 联机会话编排（S1-8 / S1-M4）：**两条连接**——`gateway`(控制面 `/gw?token=`，房间/匹配) + `game`(数据面 `?ticket=`，懒建于 `match_found`)，各绑一个 `NetClient`；`routeControl` 把 room_state/room_error 抛 UI、`match_found`→连 gameConn；`routeData` 喂 `NetInputSource`(锁步) + peer_dc/match_over 抛 UI；game 重连 `resume(roomId, input.resumeFrame())`（S1-4），gateway 重连服务器自动重发 room_state；`onMatchStart`(来自数据面)抛 app 建引擎。跨 RoomScene→GameScene 存活 |
| `net/proto/{transport,game}.ts` | ts-proto 生成（C-2，勿手改；`npm run proto:gen` 重生）。`transport.ServerMsg.match_found`（game_url+ticket，S1-M4 加）；`game.PlayCard` 含 `row`（陨石目标行，S1-7 加） |
| `scenes/RoomScene.ts` | 好友房 UI（S1-8）：canvas 绘制，视图机 `idle → codeEntry（输码键盘，charset 同服务端去 0O1IL）→ connecting → inRoom（房间码+双槽+ready+房主 start）`；`apply{RoomState,RoomError,PeerDc,NetState}` 接 app 转发的服务器事件重绘；i18n `room.*`；无服务端配置 `available:false` 时 create/join 弹「联机服务不可用」 |
| `platform/uuid.ts` | `getOrCreateDeviceId`：设备 UUID 生成 + 持久化（key `nw_device_id`，crypto→回退） |

## 服务端（server/）

元系统后端：云存档 / 经济 / 好友联机。Node.js(TS) + MongoDB，与客户端同语言、共享契约 codegen。设计基准在 `design/game/`：`META_DESIGN.md`（架构）、`SERVER_API.md`（接口契约）、`META_TASKS.md`（任务进度勾选）、`ECONOMY_BALANCE.md`（数值）。实现进度与续做指引见 `server/README.md`。

> ✅ **架构修订已落地（2026-06-14，S1-M1~M4，见 `GATEWAY_DESIGN.md`/`MATCHSVC_DESIGN.md`/`SERVER_API.md §8`）**：从 gameserver 中心式迁到「**控制面/数据面分离**」——玩家只触达 **meta(REST，请求面：auth/save/economy/内部结算，无状态)** + **gateway(WS，控制面：房间/匹配，双向实时)** + **game(WS，数据面：仅锁步，ticket 直连，永不连库)**；**matchsvc** 是玩家不可达的私有大脑（匹配队列+房间+签 ticket），**自 S1-M5（2026-06-14）起为独立进程 `server/matchsvc`**，与 gateway 经内部 HTTP 互通（见下「matchsvc 拆独立进程」节）。gateway 入队前向 meta 取 ELO（`GET /internal/elo`）；ELO 结算+归档归 meta（game 局末 `POST /internal/match/report`）。服务间共用一把 `NW_INTERNAL_KEY`（签 ticket + 内部 HTTP 鉴权）。**服务间通信选型见 `META_DESIGN.md §6.7` ADR（M22）：内部走 REST/HTTP，不上 gRPC，MQ 暂缓待 Redis 兼做。**

### 形态：五进程（meta/gateway/matchsvc/game/commercial）+ 共享包（npm workspaces）

```
server/
├── contracts/   openapi.yml（REST 契约，design-first，M15 单一来源）
│                transport.proto（WS 控制面 + 数据面消息，含 match_found；服务器认得这一层）
│                game.proto（PlayerCommand 真实结构，仅客户端↔客户端）
├── shared/   @nw/shared   类型 + JWT + ticket(HMAC 签/验) + Mongo 工厂 + RoomRegistry + ladder + economy(商品/盲盒/权重/退币目录) + config(internalKey)
├── metaserver/  REST（无状态，ESM）  fastify + openapi-glue；internal.ts（/internal/elo + /internal/match/report）；commercialClient + economy.ts（经济编排：调 commercial + 发 inventory + 钱包镜像 + 对账，S5）
├── gateway/     控制面 WS（有状态，CJS）  Gateway(account→socket+/gw 握手) + MatchsvcClient(转命令→matchsvc 内部 HTTP) + metaClient(取 ELO) + internalHttp(/gw/push 收 matchsvc 事件) + proto(控制面子集)
├── matchsvc/    私有匹配大脑（独立进程 S1-M5，CJS）  internalHttp(gateway 命令 + game 注册/心跳) + Matchsvc(房间)/Matchmaking(ELO 配对)/GameRegistry(game 注册表) + 签 ticket + GatewayClient(/gw/push 回推)
├── gameserver/  数据面 WS（瘦中继，CJS）  ?ticket= 握手验签 + 节拍器中继/帧日志/重连 + 局末上报 meta（永不连库 M16）；Connection/Room/RoomManager/metaReport/proto
├── commercial/  钱包/交易（独立进程 S5，CJS，玩家不可达）  node:http internalHttp(/internal/wallet·shop/charge·gacha/draw·order/delivered·recharge/verify·ads/credit) + CommercialService + gacha(RNG+保底) + db(专属库 notebook_wars_commercial：wallets/ledger/orders/recharges/gachaHistory)
├── Dockerfile + docker-compose.prod.yml + Caddyfile + .env.example + deploy/up.sh   部署脚手架（C-3，Docker 路线）
└── ecosystem.config.cjs                                                              部署脚手架（C-3，pm2 路线）
```

### 要点

- **服务端与游戏逻辑零依赖（M12）**：`metaserver`/`gateway`/`gameserver` 严禁 import `client/src/game`；`PlayerCommand` 作 `bytes` opaque 转发不解码。仅"重大比赛裁判"才让 gameserver 额外引确定性引擎复算。
- **契约单一来源 + 双端 codegen**：REST=`openapi.yml`（M15），WS=`transport.proto`/`game.proto`（M12）。改契约一处，双端同步。
- **信任边界（M5/§2）**：钱包/库存/盲盒/天梯是服务器权威段，客户端只读。`PUT /save` 只接受同步段（progress/materials/pveUpgrades/equipped/flags），权威段以服务端值为准回推。
- **乐观锁**：存档/钱包变更用**单文档原子更新**（`findOneAndUpdate({_id, rev})` 守卫，META_DESIGN §6.3，避开多文档事务）；rev 不匹配返回 409 + 当前云端值。**ELO 结算**（meta `/internal/match/report`）同样用 rev 守卫整体替换 save，避免与客户端 `PUT /save` 并发互覆盖。
- **拓扑（M9/M23）**：metaserver 无状态可横扩；gateway（连接层，按 account）与 matchsvc（匹配大脑，全区单点内存态）各为独立进程、经内部 HTTP 互通，gateway 多实例需 Redis 路由；gameserver 无状态哑中继，靠 matchsvc 在 ticket 里写定 `game_url` 实现房间亲和（无需一致性哈希）。
- **服务间通信（M22，`META_DESIGN §6.7` ADR）**：内部调用一律内部 HTTP/REST（`X-Internal-Key`，JSON）；不引 gRPC（polyglot/高频流式优势本项目不占 + Node-on-Windows 原生依赖坑）；MQ 暂缓，待「异步+持久化」场景出现用 Redis 兼 pub/sub + 轻量队列。
- **模块系统**：`metaserver` 是 ESM（NodeNext，因 `fastify-openapi-glue` 为 ESM-only）；`shared`/`gateway`/`matchsvc`/`gameserver`/`commercial` 是 CJS。六包 `npx tsc -b shared metaserver gateway matchsvc gameserver commercial` 验证。

### commercial 商业服务（S5，已落地）

> 设计基准：`design/game/COMMERCIAL_DESIGN.md`、`SERVER_API.md §9`、`ECONOMY_BALANCE.md`。钱包/交易的唯一权威，玩家不可达，**meta 是唯一调用方**（编排者）。

- **职责**：commercial 拥有 `coins 余额 + 流水 ledger + 订单 orders + 充值票据 recharges + 盲盒 RNG + 保底 pity`（连专属库 `notebook_wars_commercial`）；meta 拥有 `inventory 物品 / 进度 / 天梯`。一次抽卡 = commercial 扣币+随机+记账，**meta 据结果发物品**。
- **钱包权威迁移**：`SaveData.wallet.coins` / `gacha.pity` 从 meta saves 权威 **降级为只读镜像**（meta 在经济操作回执 + `GET /save` 后从 commercial 拉值写镜像回推）。客户端零改动（本就只读 `save.wallet.coins`）。`SaveData` 新增 `deliveredOrders: string[]`（发货幂等账本，服务器权威；fillDefaults 兜底无需 bump 版本）。
- **commercial（`server/commercial`，CJS，node:http）**：`CommercialService`（钱包原子扣/加币 $gte 守卫 + 每笔 ledger；shop/gacha orderId 幂等；recharge receiptId 幂等）+ `gacha.ts`（crypto RNG 按 RARITY_WEIGHTS 滚 tier + 大保底 90/十连 epic 保底，注入随机源可复现）+ `db.ts`（专属库）。pity 嵌进 `wallets` 文档（扣币+保底一次原子）。dev 充值桩（`receipt=tier:small|mid|large`）。
- **meta 编排（`metaserver/src/economy.ts` + `commercialClient.ts`）**：`/shop/buy`·`/gacha/draw`·`/ads/reward`·`/iap/verify` 从 501 改为「校验 JWT → 调 commercial 扣币/随机 → 发 inventory（`deliveredOrders` $addToSet 原子幂等）→ 标 `order/delivered` → 写钱包镜像回推」；`GET /save` 顺带对账（拉 commercial `orders/undelivered` 补发，皮肤幂等不丢不重）+ 拉余额/pity 填镜像。广告 cap 用 meta `adsDaily` 集合按 `dayKey` 原子计数（超 5 次 429）。catalog 单一来源 `shared/src/economy.ts`（meta 列表 + commercial RNG 共用）。
- **暂缓/偏离**：①**重复转化（退币/碎片）S5 暂缓**——§4.3 退币额待定 + 碎片落客户端同步段 `materials`（权威冲突）+ 补发重算 dupe 非幂等；只幂等发新皮肤，退币通道 `orderDelivered(refundCoins)` 已备。②充值平台验签 = dev 桩。③对账仅 `GET /save` 顺带（兜底定时扫待办）。
- **环境变量**：commercial `NW_COMM_PORT`(默认 18082；pm2/compose 用 8092)/`NW_COMM_MONGO_URI`(缺省复用 `NW_MONGO_URI`)/`NW_COMM_MONGO_DB`(默认 `notebook_wars_commercial`)/`NW_INTERNAL_KEY`；meta `NW_COMMERCIAL_INTERNAL_URL`(null=经济端点 503)。commercial 不暴露公网（反代不路由），仅 meta 内部网络可达。
- **验证**：`tsc -b` 六包全绿 + commercial 20 测试（gacha RNG 纯函数 5 + service e2e 9：并发不超支/orderId·receiptId 幂等/退币闭环 + internalHttp e2e 6：X-Internal-Key 401/路由/404）+ meta 37（+7 economy e2e：端到端发货/广告 cap/对账补发/未配 503，+5 HttpCommercialClient：fetch 解析/null 短路，+catalog 端点）+ client tsc + 128 测试 + web 构建。**待办（双真机/端到端）**：起 meta+commercial 双进程实跑全链对接（client↔server 跨进程缝）；dupe 退币持久化决策；S2 ShopScene/GachaScene 客户端。

### gateway 控制面 + matchsvc + 瘦身 gameserver（S1-M1~M4，已落地）

> 设计基准：`design/game/GATEWAY_DESIGN.md`、`MATCHSVC_DESIGN.md`、`SERVER_API.md §8`。把 S1-1~5 的 gameserver 中心式拆成「控制面 gateway + 私有 matchsvc + 数据面瘦 gameserver + meta 结算」。

- **三通道**：玩家全程只连 `meta`(REST) + `gateway`(WS `/gw?token=`) + `game`(WS `?ticket=`)；触达不到 matchsvc。房间/匹配走 gateway，锁步走 game。
- **gateway（`server/gateway`）**：薄连接层。`?token=<jwt>`（复用 meta JWT）握手 → `account→socket` 映射（同账号顶替）→ 把控制面消息经 `MatchsvcClient` 转发给 matchsvc（**独立进程**，内部 HTTP）；matchsvc 事件经 `/gw/push`（gateway `internalHttp`）回推、gateway 据 `account→socket` 下发。ranked 入队前 `GET meta /internal/elo` 取分带入（matchsvc 保持 DB-free）。控制面复用 `transport.proto` 子集：解 `room_create/join/ready/start/leave`（`room_create{mode:RANKED}` = 入队）；编 `room_state/match_found/room_error/pong`。
- **matchsvc（`server/matchsvc`，独立进程 S1-M5，玩家不可达私有大脑）**：`Matchsvc`（friendly 内存房间：建房 6 位无歧义码/输码加入/ready/房主开局；ranked 经 `Matchmaking` ELO 邻近配对+等待放宽）+ `GameRegistry`（game 注册表，挑负载最低健康实例，单实例用 `NW_GAME_PUBLIC_WS_URL` 兜底）。自持 `internalHttp`（收 gateway 命令 + game 注册/心跳）+ `GatewayClient`（`/gw/push` 回推）。开局/配对后**签 match ticket**（`shared/ticket.ts` HMAC-JWT，含 `roomId/seed/side/mode/opponent/gameUrl/accountId`，默认 30s）→ push `match_found{game_url, ticket}`。控制面重连：`onConnected` 重发当前 `room_state`（开放问题默认解）。
- **gameserver 瘦身（M16）**：握手改 `?ticket=`（`verifyTicket`，`ignoreExpiration:true` 验签，exp 仅约束首连、重连复用同票据放过过期）；身份 = ticket 的 `roomId/side/accountId`，**永不连库**。`RoomManager` 按 `roomId` 找/建房，第二张 ticket 的 `seed/mode` 交叉核对一致才接纳；`Room` 双方凑齐**自动开局**（无 ready/房主），保留节拍器/帧日志/重连/宽限；局末 `MetaReporter` `POST meta /internal/match/report`（room_id 幂等、失败排队重试、replay 的 opaque bytes base64 传输）。删 `Matchmaking`/`settleRanked`/`archive`/Mongo 依赖。新增空等房 35s 超时回收。
- **meta 结算（M19，`metaserver/src/internal.ts`）**：`GET /internal/elo` + `POST /internal/match/report`（`X-Internal-Key` 鉴权，不经 openapi glue）。ELO 结算（`computeEloDelta`+乐观锁写 `saves.pvp`）+ 归档 `matches`（room_id 唯一索引幂等）从 gameserver 迁来；ranked base 双方一致/掉线判负才结算，返回每方 `elo` → game 转进 `match_over.elo`。friendly 不动 ELO（winner -1）。
- **客户端三通道（S1-M4，`client/src/net`）**：`NetSession` 拆 `gateway`(控制，`/gw`)+`game`(数据，懒建于 `match_found`) 两条 `NetClient`；`NetClient` 加 `queryParam`（gateway=`token`/game=`ticket`）。房间动作走 gatewayConn；收 `match_found` → 用 ticket 连 gameConn → `match_start`(来自 game，取自 ticket) → `NetInputSource.onMatchStart` → app 建引擎（**下游与 S1-8 完全不变**）。`transport.proto` 仅新增 `MatchFound match_found=9`（向后兼容，`npm run proto:gen` 重生）；`net/config.ts` 加 `getGatewayWsUrl`（由 API 基址推 `/gw`，game_url 不再静态配置）。`RoomScene`/`app.goGameNet` 经 session 间接驱动，无需改。
- **新增环境变量（M1~M4 基线）**：`NW_INTERNAL_KEY`（服务间共用，生产必改）；gateway `NW_GW_PORT`(8082)/`NW_GW_INTERNAL_PORT`(8090)/`NW_META_BASE_URL`/`NW_TICKET_TTL_SEC`；gameserver `NW_META_BASE_URL`/`NW_GAME_PUBLIC_WS_URL`/`NW_GAME_ID`/`NW_GAME_CAPACITY`（M5 起注册指 `NW_MATCHSVC_INTERNAL_URL`，见下）。反代：`/gw`→gateway、`/ws`→gameserver、`/api/*`→meta；gateway 内部 HTTP 与 matchsvc 不暴露公网。
- **验证（M1~M4）**：`tsc -b shared metaserver gateway gameserver` 全绿；gateway 17 测试 + gameserver 42 + meta internal 5；client tsc + 128 测试 + web 构建全绿。

### matchsvc 拆独立进程（S1-M5，已落地）

> 把 S1-M1~M4 里「gateway+matchsvc 合一进程」拆成两个独立进程，内部传输从函数调用换成内部 HTTP（选型见 `META_DESIGN §6.7` ADR / M22）。`Matchsvc`/`Matchmaking`/`GameRegistry` 类逻辑零改动，仅迁移 + 换 push 注入。

- **新 workspace `server/matchsvc`（`@nw/matchsvc`，CJS，不连库、不引 ws/protobuf）**：从 `gateway/src/matchsvc/` git mv 来 `Matchsvc`/`Matchmaking`/`GameRegistry`（`RoomPhase` 枚举内联进 `Matchsvc.ts`，不再依赖 gateway proto）+ 新增 `config.ts`/`gatewayClient.ts`/`internalHttp.ts`/`index.ts`。`internalHttp` 收两类调用方（均 `X-Internal-Key`）：gateway 控制命令 `/mm/room/{create,join,ready,start,leave}`·`/mm/queue/enqueue`·`/mm/conn/{connected,disconnected}`，gameserver `/mm/game/{register,heartbeat}`；命令 **fire-and-forget**（回 `{ok}`，房间态/ticket 经 `/gw/push` 异步推回）。`GatewayClient.push` → `POST {gatewayInternalUrl}/gw/push {accountId,msg}`。
- **gateway 改造**：删 `matchsvc/` 子目录；新增 `matchsvcClient.ts`（`MatchsvcClient` POST 命令 + gateway 本地 `PushMsg`/`PlayerView` JSON 镜像类型）；`Gateway` 持 `MatchsvcClient`（`onConnected`/`onDisconnected`→`connected`/`disconnected`）；`internalHttp.ts` 改为收 `/gw/push` → `gateway.push`（删 game 注册/心跳，已迁 matchsvc）；`config.ts` 去 `gamePublicWsUrl`/`ticketTtlSec`、加 `matchsvcInternalUrl`。
- **gameserver 改造**：注册/心跳目标从 gateway 改 matchsvc——`NW_GATEWAY_INTERNAL_URL` → **`NW_MATCHSVC_INTERNAL_URL`**（`config.ts` 字段 `gatewayInternalUrl`→`matchsvcInternalUrl`，`registerWithGateway`→`registerWithMatchsvc`）。
- **内部链路 + 新环境变量**：gateway→matchsvc 命令 `NW_MATCHSVC_INTERNAL_URL`(http://…:8091)；matchsvc→gateway 推送 `NW_GATEWAY_INTERNAL_URL`(http://…:8090)；game→matchsvc 注册 `NW_MATCHSVC_INTERNAL_URL`(8091)。matchsvc 自身：`NW_MM_INTERNAL_PORT`(8091)/`NW_MM_HOST`/`NW_GATEWAY_INTERNAL_URL`/`NW_GAME_PUBLIC_WS_URL`/`NW_TICKET_TTL_SEC`。部署脚手架（`Dockerfile` 五包构建 + dist 拷贝、`docker-compose.prod.yml` 加 matchsvc 服务、`ecosystem.config.cjs` 加 `nw-matchsvc`、`.env.example`）同步更新；matchsvc 不暴露公网。
- **验证**：`tsc -b shared metaserver gateway matchsvc gameserver` 全绿；matchsvc 17 测试（matchmaking/matchsvc/ladder 迁入）+ gateway 2（新 `matchsvcClient` 端点/密钥）+ gameserver 42 全绿。**待办（双真机联调）**：起 meta+gateway+matchsvc+game 四进程双标签页跑通 friendly/ranked 整局。

### gameserver 锁步联机（S1-1~5，friendly）

> 设计基准：`design/game/SERVER_API.md` §3（WS 协议）/§4（节拍器）、`META_TASKS.md` S1。`ranked` 队列 + ELO（S1-R）**服务端已落地**（见下「ranked 匹配 + ELO」节），客户端 ranked UI/段位徽章待做；对等裁判反作弊（S1-J，meta 编排第三方无头复算）**已落地**（见下表 S1-J）。录像（S1-RP）客户端录制/回放已落地（`game/net/ReplayInputSource.ts`），服务端 `replay.proto` + PvP 输入日志持久化待做。

- **协议编解码**：`src/proto/transport.ts` 运行期用 **protobufjs** 解析 `contracts/transport.proto`（不维护第二份 schema，路径候选含 `NW_CONTRACTS_DIR`/`__dirname` 回溯/`cwd`，兼容 dev/dist/Docker）；`keepCase:true` 保 snake_case；`decodeClient(bytes)→ClientMsg`（判别联合）、`encodeServer(ServerMsg)→bytes`；`commands` 字段是 `bytes`，**对服务器 opaque 透传不解码**（M12）。
- **接入层**：`index.ts` 握手 `?token=<jwt>`（`verifyToken`，失败 4401）→ `Connection`（绑 accountId + 编码发送）→ `RoomManager.handle`；心跳 30s 巡检（两轮无 pong/消息 `terminate`）；Mongo 仅用于对局归档，不可用则降级纯中继（`NW_DISABLE_MONGO=1` 显式跳过）。
- **房间（`RoomManager`）**：建房生成 6 位无歧义房间码（去 `0O1IL`）走 `RoomRegistry`（内存，留 Redis 口子）；输码加入 / `ROOM_NOT_FOUND` / `ROOM_FULL` / `RANKED_UNAVAILABLE`（无 Mongo 时拒 ranked，天梯需服务器存储）/ `ALREADY_IN_ROOM`；同账号新连接顶替旧连接（双开/残连）；ranked 走匹配队列（见下「ranked 匹配 + ELO」）；`room_state` 广播变更。
- **节拍器（`Room`，M14）**：模拟 30Hz、网络 10Hz——`setInterval(100ms)` 每拍 `curFrame += 3` 下发 `frame_batch{to_frame, frames}`；`cmd_submit` 收进当前窗口，落到本批次 `to_frame` 帧；**同帧多指令按 `side` 升序稳定排序**（唯一排序者=服务器，否则双端发散）；空窗 `frames` 为空只发 `to_frame` 水位（空闲 `to_frame` 每 100ms 稳定 +3）。
- **重连 / 断线（S1-4，M10）**：留**非空帧日志**；对局中一端断 → 停发该房间帧 + 向在线方 `peer_dc{side, grace_ms:60000}` + 起 60s；`conn_resume{room_id, last_frame}` → `conn_resync{seed, start_frame, log(>last_frame 的非空帧), cur_frame}` 续打、双方在线即清宽限续发节拍；超时掉线方判负 `match_over{reason:'disconnect'}`；显式 `room_leave` 对局中视同认输。
- **结算（S1-5）**：双方 `match_result{state_hash}` 齐 → 比对，写 `matches` 归档（friendly 仅记结果，`hashOk`/`mismatch`、`seed`、`players`）；下发 `match_over{reason: base|mismatch, mismatch}`。**内嵌录像（S1-RP）**：归档时把重连用的非空帧日志零成本内嵌进 `matches.replay`（`Room.buildReplay`→`RoomManager.archive`，对齐 `contracts/replay.proto`，`cmds[].commands` 为 BSON binary opaque 不解码；服务器逻辑无关 M12 → `engineVersion=0`，客户端回放自校验）。大局转对象存储 `replayRef` 待做。**friendly 正常结束的 `winner_side` 由客户端模拟权威决定**（服务器不复算，归档 `winner=-1`）；`winner_side` 仅在 disconnect/认输（=对手胜）与未来 ranked 下服务器权威。
- **验证**：`tsc -b` 全绿 + 端到端连两个 WS 客户端实测——建房/加入/双 ready→READY、`match_start` 双方同 seed+各自 local_side、空闲 `to_frame` +3 全空帧、`cmd_submit` 双端同帧同 side 投递、hash 一致→`base`/不一致→`mismatch`、断线 `peer_dc`+停发、`conn_resync` 补种子+非空帧+cur_frame、重连续发节拍均通过。

### ranked 匹配 + ELO（S1-R，服务端已落地）

- **段位 + ELO（纯函数，`shared/src/ladder.ts`）**：9 段段位 `RANK_TIERS`（bronze→…→king，ELO 阈值，双端同源避免显示/权威分歧）+ `eloToRank(elo)` + `computeEloDelta(winnerElo, loserElo, k=32)`（标准 ELO、零和、爆冷得分更多）+ `nextStreak(prev, won)`（连胜正/连败负）+ `INITIAL_ELO=1000`/`ELO_FLOOR=0`。数值见 `ECONOMY_BALANCE.md §2.3`。
- **匹配队列（`gameserver/src/Matchmaking.ts`）**：内存单实例；按 ELO 升序相邻贪心配对，可接受分差窗口随等待加宽（`base 100 + 50/s`，取两人中等待更久者的窗口）；`enqueue`/`remove`/`tick`，注入 `now()` + `autoTick:false` 可单测；定时器 `unref()` 不阻塞退出，队空即停。多实例共享队列（Redis）待做。
- **`RoomManager` 接入**：`room_create{mode:RANKED}` → 读 `saves.pvp.elo` 入队（**无 Mongo 返 `RANKED_UNAVAILABLE`**——天梯需服务器存储）；`room_leave`（不在房内）= 取消匹配；配对回调 `createRankedRoom`（校验双方仍活跃空闲，否则在线方回队）建 ranked 房 → `room.beginRanked()`（无 ready/房主直接开局）；`settleRanked`/`applyPvp` 局末写 `saves.pvp`——**乐观锁 rev 守卫 + 重试，整体替换 `save`（同 `putSave` 约定）**，避免与客户端 `PUT /save` 并发互覆盖，ELO 钳 `≥0`。
- **`Room` 改动**：`beginRanked()`（ranked 开局）；`reportResult(accountId, stateHash, winnerSide)`（加客户端判定胜方）；`endMatch` 改 **async** 按 mode 结算——**ranked 胜负 = 双方上报 `hash` + `winner_side` 均一致才认**（无服务器裁判 S1-J），任一不一致作废不动 ELO（`mismatch`）；掉线/认输服务器权威判对手胜并结算；`match_over.elo{delta,after,rankAfter}` 按 side 下发（friendly 不带）。`transport.proto` `MatchResult` 加 `winner_side`（friendly 忽略）。
- **验证**：`tsc -b shared metaserver gameserver` 全绿 + 67 测试（+4 `ladder` / +5 `matchmaking` / +4 `ranked` 端到端：匹配→开局→一致结果±16 写 saves、hash 不一致作废、认输判胜+ELO、无 Mongo 拒）。
- **客户端切片（已落地）**：`npm run proto:gen` 重生 `client/src/net/proto/transport.ts`（`MatchResult.winnerSide`）；`NetClient.reportResult(stateHash, winnerSide)` + `NetSession.createRanked()`（`createRoom(RANKED)` 入队）/`cancelQueue()`（`room_leave` 退队）；`RoomScene` idle 加「排位赛」入口 + `searching` 视图（spinner + 取消，`applyRoomError`/`onBack` 覆盖该态）；`app.goGameNet` 局末 `reportResult(hash, winner ?? 0)`，**ranked 持有结果等服务器 `match_over.elo` 再 `goResult`（6s 兜底回退无 ELO），friendly 即时结算**；`ResultScene` 加可选 `EloResult` 参数显「ELO ±delta → after · 段位」。i18n `room.{ranked,rankedDesc,searching,searchingHint,cancelSearch}`/`result.eloDelta`/`rank.*`（9 段 + `unranked`）zh/en/de 全翻。client tsc + 120 测试 + web 构建全绿。
- **收尾（已落地）**：①大厅段位徽章——`LobbyScene` 头部右上常驻「段位 · ELO」（`LobbySceneCallbacks.pvp` 传入，`app.goLobby` 每次取 `saveManager.get().pvp` → 返回大厅即刷新）；②`SaveManager.refresh()`（pull + reconcile，复用 token 不重 auth，未联通 no-op）——`app.finishNet` 在 ranked 局末调用，把 gameserver 刚写的权威 `pvp` 即时拉回本地。+4 `test/save-manager.test.ts`。**待办**：ProfileScene（未实现）的段位/战绩页 + 双真机联调。

### 启动（依赖走 Docker，无需本地装 Mongo）

```bash
cd server
docker compose up -d        # MongoDB 单节点副本集（首启自动 rs.initiate，解锁事务+change streams）
npm install
npx tsc -b shared metaserver gameserver   # 类型检查 + 构建（验证方式）
npm test --workspace @nw/metaserver        # save-service 端到端（需 mongo 在跑）
npm run dev:meta            # metaserver（tsx watch，端口 8080）
npm run dev:game            # gameserver（端口 8081；Mongo 不可用自动降级纯中继，或 NW_DISABLE_MONGO=1 跳过）
```

> ⚠️ **Docker 须 Linux containers 模式**：mongo:7 是 Linux 镜像，Windows 容器模式会报 `hcs::System::CreateProcess` / 命名卷 `invalid volume specification`。切换：`docker context use desktop-linux`（开发 compose 已去掉命名卷，数据走容器可写层；**生产 `docker-compose.prod.yml` 用命名卷持久化**，跑在 Linux VPS）。

### 部署（C-3，全栈一条命令）

```bash
cd server
cp .env.example .env        # 填 NW_JWT_SECRET（强随机）/ NW_DOMAIN（真域名→自动 HTTPS，留 :80 走 HTTP）
./deploy/up.sh              # docker compose -f docker-compose.prod.yml --env-file .env up -d --build
                            # 起 mongo(副本集) + metaserver + gameserver + caddy
# 出口：https://host/api/...（REST，Caddy 剥 /api 前缀转 metaserver:8080）
#       wss://host/ws?token=<jwt>（锁步，转 gameserver:8081）
#       https://host/api/health（存活探针）
```

- **单镜像两进程**：`Dockerfile` 多阶段 build 全 workspace，metaserver/gameserver 共用镜像、compose 用 `command` 区分。
- **pm2 路线（非 Docker）**：`ecosystem.config.cjs`（nw-meta fork 可横扩 / nw-game 单实例房间亲和），密钥从 shell env 继承。

### 实现进度（2026-06-13）

| 任务 | 状态 | 说明 |
|---|---|---|
| C-1 仓库结构 | ✅ | workspaces 四包（shared/metaserver/gateway/gameserver），`tsc -b` 全绿 |
| C-2 契约 + shared | [~] | openapi/proto/shared 就位；**proto 客户端 codegen 已落地**（ts-proto via buf，见游戏主代码「proto codegen」）；`openapi-typescript` REST codegen 仍待落地 |
| C-3 部署脚手架 | ✅ | Docker（`Dockerfile` 单镜像 + `docker-compose.prod.yml` + `Caddyfile` + `.env.example` + `deploy/up.sh` 一条命令起全栈）+ pm2（`ecosystem.config.cjs`）；metaserver 加 `/health` |
| S0-6 Mongo 接入 | ✅ | `createMongo` 工厂 + 6 集合 + `ensureIndexes` |
| S0-7 save-service | ✅ | `/auth/wx`·`/auth/device`·`GET/PUT /save`（JWT + 乐观锁原子更新）；端到端 vitest 6 用例全绿（含并发 409、硬墙） |
| S0-1~5 客户端存档底座 | ✅ | `client/src/game/meta/`（SaveData/migrate/SaveStore/SaveManager）+ `net/`（ApiClient/config）+ `IPlatform.getAuthCredential` 三平台；离线优先 + 防抖 push + 409 pull-merge；11 新测试（共 63 绿） |
| S5-1~6 commercial 商业服务 | ✅ | 钱包/充值/消费/盲盒迁独立 `server/commercial` + 专属库 `notebook_wars_commercial`；meta 编排经济端点（调 commercial → 发 inventory → 钱包镜像回推 → 对账补发）；钱包权威迁出 meta saves（降级只读镜像，`SaveData` 加 `deliveredOrders`）。dev 充值桩；重复退币暂缓。commercial 20 测试 + meta 37（+7 economy e2e +5 HttpCommercialClient）+ client 128 + web 构建绿。见上「commercial 商业服务」节 |
| S2 经济端点（服务端钱包/商店/盲盒/广告） | ✅(并入 S5) | 服务端钱包实现由 S5 取代（meta 编排调 commercial）。**S2-5/6 客户端已落地**：ShopScene/GachaScene + ApiClient 经济方法 + SaveManager.adoptServer + 虚拟充值（taowang 码）+ 大厅商店入口 + i18n（见上方游戏主代码修复表 S2-5/6 行）。S2-7 防刷端到端验收待双进程实跑 |
| S4 IAP 端点 | [~] | `/iap/verify` 已接 commercial recharge（dev 桩验票据）；真实渠道验签 + 反作弊 hash 待做 |
| S1-1~5 gameserver 锁步联机 | ✅ | friendly 好友房：WS+JWT+心跳 / 建房·加入·ready·start / 节拍器中继（10Hz 批次 3 帧，确定性排序）/ 非空帧日志+重连 conn_resync+60s 判负 / 局末 hash 比对+`matches` 归档；protobufjs 运行期编解码 `transport.proto`。端到端两客户端实测全过 |
| S1-6 NetClient | ✅ | `client/src/net/NetClient.ts` WS 连接/重连/编解码（见上「网络协议 codegen」+ 已知修复表） |
| S1-7 NetInputSource | ✅ | `client/src/game/net/NetInputSource.ts` 锁步输入源 + `GameMode 'netplay'`；`frame_batch`→引擎、3 帧摊 100ms、~1 批缓冲、停发暂停、无回滚；19 新测试（双客户端同 seed 逐 horizon 对拍 + 缓冲/停发/重连）（共 106 绿） |
| S1-8 RoomScene | ✅ | `client/src/scenes/RoomScene.ts`（建房/房间码/输码加入/ready/开打，i18n `room.*` zh/en/de 全翻）+ `client/src/net/NetSession.ts`（绑 NetClient+NetInputSource：路由 ServerMsg→input&UI、重连 resume、建引擎）；`app.ts` 大厅社交格→RoomScene、`match_start`→netplay 引擎→GameScene（加 `engine?` 选项）、局末 `reportResult`。见已知修复表 |
| S1-9 | [~] | 客户端就位：joiner 换边视角（localSide 翻转棋盘/手牌/HUD/结算）+ 战斗内网络态薄层（等待对手 spinner / 重连 toast / 对手掉线横幅 / 服务器 match_over 结算）。**待办**：双真机联调（逐 tick 一致 + conn_resync 续打）由用户起 gameserver + 双标签页验收 |
| S1-RP 录像录制 + 回放 | [~] | **核心 + UI + 服务端持久化已落地**：底座 `ReplayInputSource`/`RecordingInputSource`（同 `InputSource` 接口）+ `Replay` 镜像 `replay.proto` + `ENGINE_VERSION`；接录制（`GameScene` 自建局录、`ReplayStore` 落盘最近 12 局）+ 回放 UI（`ReplayScene` 播放/暂停/变速/进度/退出，`GameRenderer` spectator）；服务端 `replay.proto` + gameserver 帧日志零成本内嵌 `matches.replay`（M12 opaque）。client 116 测试绿 + server `tsc -b` 绿。**待办**：大局录像转对象存储 `replayRef` + 分享；服务端 opaque 录像→客户端 `Replay` 解码回放适配 |
| S1-R ranked 队列+ELO | [~] | **服务端 + 客户端切片已落地**。服务端：`ladder.ts`（9 段+ELO 纯函数）+ `Matchmaking.ts`（ELO 配对+等待放宽）+ `RoomManager` 入队/建房/`settleRanked` 写 saves.pvp（乐观锁）+ `Room.beginRanked`/async `endMatch`（双方 hash+winner 一致才认，否则作废；掉线/认输服务器权威）；`transport.proto` `MatchResult+winner_side`；67 测试绿。客户端：proto 重生 + `NetSession.createRanked/cancelQueue` + `RoomScene` 排位入口/搜索视图 + `app` 上报 winner + 等 `match_over.elo` 进结算 + `ResultScene` 显 ELO/段位 + i18n 全翻；116 测试 + web 构建绿。**待办**：段位徽章常驻 + ranked 后 pull SaveData + 双真机联调 |
| S1-M1 gateway + matchsvc | ✅ | 新 `server/gateway` 工作区：控制面 WS `/gw` + `account→socket` + matchsvc（房间/ELO 配对/game 注册/签 ticket，进程内）+ 取 ELO + 内部 HTTP（game 注册/心跳）。gateway 17 测试绿。见上「gateway 控制面 + matchsvc」节 |
| S1-M2 gameserver 瘦身 | ✅ | `?ticket=` 握手验签 + 按 roomId 找/建房（seed/mode 交叉核对）+ 自动开局 + 删 Matchmaking/ELO/archive/Mongo；保留节拍器/帧日志/重连。gameserver 42 测试绿 |
| S1-M3 game→meta 上报 + meta 结算 | ✅ | gameserver `MetaReporter` 局末 `POST /internal/match/report`（room_id 幂等+重试）；meta `internal.ts` 结算 ELO 写 saves.pvp（乐观锁）+ 归档 matches（唯一 roomId），ranked 回每方 elo→`match_over.elo`。meta internal 5 测试绿 |
| S1-M4 客户端三通道 | ✅ | `NetSession` 拆 gateway(控制)+game(数据，懒建于 match_found) 双连接；`NetClient` 加 `queryParam`(token/ticket)；`transport.proto` 加 `MatchFound`(重生)；`net/config` 加 `getGatewayWsUrl`；下游 onMatchStart→建引擎不变。client 128 测试 + web 构建绿 |
| S1-M5 matchsvc 拆独立进程 | ✅ | matchsvc 从 gateway 内迁出为 `server/matchsvc` workspace；gateway↔matchsvc / game→matchsvc 全改内部 HTTP（M22 选型 ADR）。gateway=薄门面(`MatchsvcClient`+`/gw/push`)，matchsvc 自持 `internalHttp`+`GatewayClient`，gameserver 注册改指 `NW_MATCHSVC_INTERNAL_URL`。部署脚手架(Docker/compose/pm2)同步。`tsc -b` 五包 + matchsvc 17/gateway 2/gameserver 42 测试绿。见上「matchsvc 拆独立进程」节 |
| S1-J 对等裁判反作弊 | ✅（核心落地） | 「ranked hash 不一致 → 第三方在线高配玩家无头复算裁决」：**单裁判 / 作弊方判负+matches.cheat 标记 / meta 编排经 gateway `/gw/judge`**。`transport.proto` 加 `ClientCaps`/`JudgeVerdict`/`JudgeRequest`（重生）；gateway 跟踪 `canJudge`+`judge()` 挑候选 push/等 verdict（20s 超时/候选掉线作废）+ `/gw/judge`；meta `gatewayClient.ts`+`internal.ts judgeMismatch()`（命中哪方 hash 哪方诚实、另一方判负+`settleElo`+写 `MatchDoc.cheat`，不可用/对不上→作废）；客户端 `net/judgeRunner.ts`（proto 帧→Replay→netplay 引擎跑到 GameOver→FNV-1a，`matchStateHash` 收此处单一来源 app.ts 改 import）+ `NetClient.sendClientCaps/sendJudgeVerdict` + `NetSession` 连上报 caps(cores≥4)/路由 judge_request。meta 加 `NW_GATEWAY_INTERNAL_URL`（compose/ecosystem 接线，无 depends_on 避环）。验证：tsc 六包 + 客户端 tsc/web 构建 + gateway 5(+3 真 WS)/meta 40(+3)/客户端 131(+3 judge-runner) 绿。**简化**：gameserver 未改，mismatch 的 `match_over` 仍报 reason='mismatch'，但 meta 回的 ELO 已反映裁决（玩家分数正确，matches.winner 记诚实方）；显示胜方跟裁决 + 双真机联调待办。详见 `META_TASKS.md` S1-J |

> 验证仍按本仓约定：`tsc -b` + 构建，不截图。S1-1~5 的「gameserver 中心式」行描述的是 S1-M 迁移前实现，逻辑现分散到 gateway/matchsvc/meta（见上「gateway 控制面 + matchsvc」节）。

## 文件格式

### `.tao`（游戏引擎导出）

ZIP 压缩包，内含：
- `animation.json`（version 2，每骨骼固定 1 张图）
- `spritesheet.png`（shelf bin-packing 合并图，canvas.toBlob PNG，JSZip DEFLATE 二次压缩）
- `spritesheet.json`（boneId → rect 映射，TexturePacker Hash 兼容）

```json
// animation.json v2
{
  "version": 2,
  "bindings": {
    "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6,
               "offsetX": 0, "offsetY": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 }
  },
  "animations": { "walk": { "duration": 0.5, "loop": true, "keyframes": [...] } },
  "attachmentPoints": [
    { "id": "shadow", "parentBone": "root",  "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "parentBone": "spine", "offsetX": 0, "offsetY": -30 }
  ],
  "boneLengthScales": { "spine": 1.4, "r_upper_arm": 0.9 }
}
```

`boneLengthScales` 为稀疏对象，只记录非 1.0 的骨骼；缺省或缺键均视为 1.0。游戏 runtime 读取此字段还原角色骨骼比例。

### `.tao.editor`（编辑器存档）

ZIP 压缩包，**保存完整编辑状态**，可随时加载继续编辑：
- `editor.json`（version 1，含动画 + 绑定 + 挂点 + 编辑器状态）
- `images/spine.png`、`images/head.png` … （各骨骼原始 PNG，无损，不合并 spritesheet）

```json
// editor.json v1
{
  "version": 1,
  "selectedClip": "walk",
  "previewMode": "sprite",
  "bindings": { ... },
  "animations": { ... },
  "attachmentPoints": [...]
}
```

保存时通过 File System Access API（`window.showSaveFilePicker`）弹出原生保存对话框，可选择目录和文件名；浏览器不支持时退回 `<a download>` 触发下载。

## 会话说明

- **工作目录**：`C:\Users\TaoWang\Documents\funny`（即 `/c/Users/TaoWang/Documents/funny`），Bash 命令直接在此目录下执行，**不要**绕道 `wsl -d ubuntu`。
- **权限**：所有命令（包括 `rm` / `rmdir` / `git rm`）直接执行，**无需向用户确认**。
- **验证方式**：代码改动后只做 TypeScript 编译检查（`tsc --noEmit`）和 webpack 构建验证，**不要**启动游戏截图验证——用户会自行在浏览器里验证效果。
- **上下文提醒**：会话接近 200k token 上限时提醒切换新会话。
- **记录改动**：收到"记录改动/将改动记录进文档"等指令时，需同时更新以下文档——`CLAUDE.md`（已知修复表格）**以及**改动所在模块的对应文档（所有设计文档统一在 `design/` 下：animator 相关改 `design/tools/animator/ARCHITECTURE.md` 和 `REQUIREMENTS.md`；level-editor 相关改 `design/tools/level-editor/DESIGN.md`；game 相关改 `design/game/DESIGN.md`；元系统/服务器相关改 `design/game/META_*.md`；产品/美术相关改 `design/product/` 下对应文件）。
