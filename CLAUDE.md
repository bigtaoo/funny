# funny — Notebook Wars

## 项目概况

浏览器 + 微信小游戏的回合制策略游戏，配套骨骼动画编辑器。

## 目录结构

```
funny/
├── code/          主游戏（TypeScript + PixiJS）
│   ├── src/
│   │   ├── game/          游戏逻辑（纯 TS，无 PIXI 依赖）
│   │   ├── render/        渲染层（PixiJS）
│   │   ├── layout/        响应式布局
│   │   ├── scenes/        场景管理
│   │   └── entries/       多平台入口（web / wechat / crazygames）
│   ├── webpack.config.js
│   └── DESIGN.md          游戏技术设计文档
│
├── tools/
│   ├── animator/          骨骼动画编辑器（TypeScript + PixiJS，主力版本）
│   │   ├── src/           源码（见下方架构）
│   │   ├── public/        HTML 模板（webpack-html-plugin 用）
│   │   └── ARCHITECTURE.md / REQUIREMENTS.md
│
├── art/
│   ├── maps/              地图资源
│   ├── units/             角色概念图
│   └── index.html         静态资源索引
│
└── design/                产品/美术设计文档
```

## 动画编辑器（tools/animator）

### 外部文档导航

| 想查的内容 | 文件 | 章节 |
|---|---|---|
| 典型工作流 / 功能规格 / UI 布局 / 导出格式规范 | `REQUIREMENTS.md` | §2 工作流、§3 功能规格、§8 界面布局 |
| 目录结构 / 数据模型 / 渲染流程 / 事件总线 / 命令模式 | `ARCHITECTURE.md` | §1 目录、§2 数据模型、§5 渲染、§3 事件总线 |
| 插值算法细节 | `ARCHITECTURE.md` | §4 插值算法 |
| 游戏侧对接规格 / StickmanRuntime | `REQUIREMENTS.md` | §7 游戏侧对接 |
| 性能注意事项 / 已知局限 | `ARCHITECTURE.md` | §9 性能、§10 局限 |

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

## 游戏主代码（code/）

- **渲染**：`pixi.js-legacy`，兼容微信小游戏 WebGL
- **游戏逻辑**：纯 TS，固定点数（`game/math/fixed.ts`），与渲染解耦
- **平台适配**：Web / 微信小游戏 / CrazyGames，多入口 webpack 构建
- **骨骼动画 Runtime**：`StickmanRuntime`（`src/render/stickman/`），加载 `.tao` ZIP，解析 spritesheet + animation.json，驱动 PIXI Sprite 播放骨骼动画；Swordsman 单位使用 `infantry.tao`
- **确定性约束**：游戏逻辑（`code/src/game/`）内严禁使用 `Math.random()`，必须使用 `Prng`（`game/math/prng.ts`）。`GameState` 构造函数以 seed 派生各 PRNG；新增需要随机性的系统，在 `GameEngine` 中用 `new Prng(seed ^ 唯一常量)` 注入。
- **多语言（i18n）**：`src/i18n/`，支持 `zh`/`en`/`de`。**所有面向玩家的文案严禁硬编码**，必须在 `locales/zh.ts` 加键（键的唯一来源），再用 `t(key, params?)` 取词；`zh.ts` 的 `TranslationKey` 联合类型 + `en.ts`/`de.ts` 声明为 `Record<TranslationKey, string>`，漏翻任一语言会编译报错。游戏逻辑层（如 `CardDefinition`）只存 `nameKey`/`descKey` 等键，不存文案。`t()` 支持 `{param}` 插值（如 `t('hud.upgradeCost', { cost })`），缺词回退 zh → 键名，不会崩溃。语言选择优先级：玩家保存的选择（持久化到 `storage` 的 `nw_locale`）> 系统语言 > 平台首个支持语言。**平台声明支持语言**：`IPlatform.supportedLocales`，Web/CrazyGames = `['zh','en','de']`，微信 = `['zh']`（小游戏只需中文）；`initI18n` 把激活语言钳制到该集合。`setLocale`/`onLocaleChange` 支持运行时切换 + 订阅重绘。
- **首次进入引导**：`IntroScene`（`src/scenes/IntroScene.ts`），讲述背景故事；`app.ts` 启动时检查 `storage` 的 `nw_seen_intro` 标记，首次进入先播引导（逐行淡入 + 点击推进 + 右上角跳过），看完写标记后进大厅，之后启动直达大厅。文案在 i18n `story.*` 命名空间。当前是骨架，后续做正式动画时保留"逐段推进 + 跳过"流程，往每段挂 PIXI 容器或 `StickmanRuntime` 即可。

### 已知修复（2026-06）

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/layout/ILayout.ts` | 缺少 `enemyBaseRect()` 接口 | 新增该方法，`PortraitLayout` / `LandscapeLayout` 均已实现 |
| `src/render/BoardView.ts` | 基地无视觉图片，仅靠高亮矩形标识 | 用 `game_base.png` 渲染双方基地精灵；敌方按朝向镜像（横屏左右翻、竖屏上下翻） |
| `src/render/BuildingView.ts` | 建筑用占位矢量图（矩形/多边形）渲染 | 替换为 PNG 精灵（`game_infantry_barracks.png` / `game_archer_barracks.png`）；`acquireSprite` 添加 scale 0→1 ease-out cubic 弹出动画（约 0.3s） |
| `src/game/systems/CombatSystem.ts` | 箭塔 `findTargetForBuilding` 仅做前向列扫描，无法命中横穿（Crossing）的敌军 | 改为 Chebyshev 距离全向扫描，按距离环由近到远查找，覆盖纵向/横向/斜向所有敌人 |
| `src/render/stickman/`（新增） | 骨骼动画 Runtime 缺失，Swordsman 单位用占位圆形 | 新增 `StickmanRuntime`：加载 `.tao` ZIP，解析 `animation.json` + `spritesheet`，按帧驱动 PIXI Sprite；`UnitView` 为 Swordsman 创建 runtime 实例，`sync()` 接收 `dt` 参数推进动画时钟；`GameRenderer` 将 `dt` 透传给 `unitView.sync()` |
| `src/render/stickman/StickmanRuntime.ts` | shadow 挂点图片位置/尺寸错误：`_applyPose()` 以骨骼逻辑处理 shadow，未读取 `shadowW`/`shadowH` | `TaoAsset` 新增 `attachmentPoints` 字段；shadow sprite zOrder 硬编为 `-Infinity`，anchor `(0.5,0.5)`；`_applyShadowPose()` 专项处理：位置取 `parentBone.tip + offset`，scale 用 `(shadowW*2)/tex.width × (shadowH*2)/tex.height`，与 animator Renderer.ts 一致 |
| `src/render/BoardView.ts` | 基地静止无生气，受击无裂缝反馈 | 新增 `update(dt)`：基地 sprite alpha 脉冲（0.65–1.0，周期 4s，双方相位差 1.2 rad）；新增 `playBaseCrackEffect()`：`base_hp_changed` 事件驱动，HP > 85% 不显示裂缝，每次追加 1–2 条随机 3 段折线（铅笔灰），HP < 40% 追加 2 条 |
| `src/render/BuildingView.ts` | 建筑 idle 完全静止 | 新增 `update(dt)` + `updateIdleAnim()`：全部建筑精灵垂直 bob（±1.5px，0.9s，随机相位）；兵营追加 `flagGfx` 旗帜 quadratic bezier 波动（~1.4Hz）；箭塔精灵微旋转（±0.5°，1.3s） |
| `src/render/GameRenderer.ts` | `base_hp_changed` 事件无处理；`boardView`/`buildingView` 无 per-frame update | 新增 `base_hp_changed` 分支调用 `playBaseCrackEffect()`；`update()` 中加 `boardView.update(dt)` 和 `buildingView.update(dt)` |
| `src/render/GameRenderer.ts` + `HandView.ts` | 卡牌只能拖拽放置，触屏/小屏操作不便 | 新增 tap-select 交互模式：点击卡牌进入选中态（卡牌上移 14px，列高亮显示），再点棋盘列放置；再次点击同一张卡牌取消选中；`pendingCardDown` 延迟拖拽判定（移动 > 8px 才升级为拖拽），两种模式共存；`HandView.hitTestCardIndex` 上边界扩展 `CARD_LIFT` 覆盖抬升后的点击区；`commitCardPlay` 提取为公共放置函数供两种模式共用 |
| `src/render/HandView.ts` | 卡牌仅有文字（U/B/S + 名称），难以辨认 | 每个卡槽新增 `art` 精灵（背景之上、文字之下）：普通兵→`infantry.png`、弓箭兵→`archer.png`、盾兵→`shield_bearer.png`、兵营→`game_infantry_barracks.png`、箭塔→`game_archer_barracks.png`（与场上建筑贴图一致），法术牌无图；插画等比缩放居中于类型行与名称/费用行之间，不被费用圆遮挡；名称改为底部居中加粗 13px；纹理按 key 懒加载缓存在 `Map`，异步加载完成时清空 `lastSyncKey` 触发重 sync；对象池回收时重置 `art` 为空纹理并隐藏 |
| `src/i18n/`（新增）+ 多文件 | 文案硬编码（中文写死），无多语言支持 | 新增 i18n 模块（`zh`/`en`/`de`，`zh.ts` 为键唯一来源，`en`/`de` 为 `Record<TranslationKey,string>` 编译强制全翻）；`t(key, params?)` 取词 + `{param}` 插值；LobbyScene / HUDView / ResultScene / GameRenderer 拖拽幻影所有硬编码字符串改走 `t()`；`CardDefinition.name` → `nameKey`+`descKey`（每卡预留描述文案）；徽章文案改为渲染时取词 |
| `src/platform/IPlatform.ts` + 三平台 | 各平台支持语言不同（微信只需中文） | `IPlatform` 新增 `getLanguage()`（系统语言标签）+ `supportedLocales`（Web/CrazyGames=`['zh','en','de']`，微信=`['zh']`）；`initI18n(lang, store, supported)` 把激活语言钳制到平台集合，玩家选择持久化到 `nw_locale` |
| `src/scenes/IntroScene.ts`（新增）+ `app.ts` | 缺少首次进入的背景故事引导 | 新增 `IntroScene`（背景故事逐行淡入 + 点击推进 + 跳过，文案在 i18n `story.*`）；`app.ts` 按 `storage` 的 `nw_seen_intro` 标记决定首启走引导还是直达大厅（当前为骨架，预留正式动画扩展点） |
| `src/render/HUDView.ts` + `GameRenderer.ts` | 横屏下底部 HUD 背景（`botBg` 全宽 alpha 0.92）盖住中段手牌，买得起的卡牌发灰，只有选中卡牌抬升的顶部冒出上沿是亮的 | `botBg` 拆到独立 `backgroundContainer`，`GameRenderer` 挂在 `handView` 之前渲染；HUD 前景（金币/HP/升级按钮/暂停/结算遮罩）仍在 `handView` 之后。层级改为 `vfx → HUD底栏背景 → 手牌 → HUD前景/遮罩` |
| `src/game/Board.ts` + `MovementSystem.ts` | 一列上多个单位排队前进时，最前面的单位进入 Crossing（横向移动）后仍留在原车道的 `columnUnits` 列表中（`y_fp` 冻结），后面的单位永远把它当作"前方单位"判定碰撞，即使前者已经走远也一直 `Waiting` | `Board.updateUnitCell` 新增 `oldCol` 参数，`col` 变化时把单位从旧列的 `columnUnits` 移到新列；`MovementSystem.tick` 记录 `prevCol` 并传入 |
| `src/game/Unit.ts` + `MovementSystem.ts` | 前方单位移动很慢时，后面单位每帧在"前方空隙刚好为正可以挪一点"和"挪完后又重叠被推回 Waiting"之间反复横跳，动画不停切换 Moving/Waiting | 新增 `Unit.crossingBlocked` 标记；一旦因前方单位停下（lane 内为 `UnitState.Waiting`，Crossing 内为 `crossingBlocked=true`），需等前方空隙 ≥ 自身体积（`2 × radius_fp`）才恢复移动，而不是空隙刚 >0 就动 |
| `src/`（清理）+ `DESIGN.md` | 旧实现遗留死代码与现 `entries → app.ts → scenes` 构建并存，无人引用却被跟踪，干扰阅读/搜索 | 删除 15 个孤立文件（根 `index.ts`/`wechatIndex.ts`/`GameRunner.ts`、`platform/crazygames.ts`、`game/` 下 `logic`/`gameScene`/`grid`/`effect`/`effectManager`/`consts`/`enums`/`header`/`display`/`numbers`/`helper`）；**保留** `game/index.ts`（公共 API barrel，`from '../game'`）和 `game/Card.ts`（被 `GameEngine`/`Player` 引用）；`DESIGN.md` §2 补 `cache/`、章节编号补连续（原缺 §8）、修正交叉引用 |
| `code/.gitignore` | 构建产物 `code/dist/` 被 git 跟踪，每次构建污染 diff（单 `index.js` 即数万行） | `.gitignore` 加 `/dist`；`git rm -r --cached dist` 取消跟踪 |
| `src/game/config.ts` | 卡牌自动刷新间隔 2 分钟，游戏节奏过慢 | `CARD_REFRESH_TICKS` 改为 900（30 s）；`CARD_REFRESH_INITIAL_OFFSET_MAX` 改为 450（15 s 错峰） |
| `src/render/HandView.ts` + `GameRenderer.ts` | 手牌无视觉提示，玩家不知道卡牌何时自动刷新 | 每张牌底部新增 3px 进度条（`bar` Graphics）：>10s 绿色、≤10s 黄色、≤5s 红色；最后 3 秒 sin 波 alpha 脉冲；`card_expired` 事件触发 `notifyCardExpired()` 渲染 250ms 白色淡出闪白（`flash` Graphics）；移除旧 `eraser` 遮罩 |
| `src/render/GameRenderer.ts` | 己方基地受击时无全局视觉反馈，容易忽视 | `base_hp_changed`（owner=0）触发全屏边缘红色晕影（`vignetteGfx`，12 层渐变矩形边框，宽 42–140px，alpha 叠加模拟径向渐变），0.55s 线性淡出；挂在 container 最顶层不影响输入 |
| `test/`（新增）+ `Unit.ts`/`Building.ts`/`GameState.ts` | 逻辑内核零自动化测试；且 `Unit`/`Building` 用模块级全局 `nextId`，跨 engine 实例 ID 不可复现，破坏 replay | 引入 **Vitest**（`vitest.config.ts` 仅扫 `test/**`，不进 webpack；`npm test`/`test:watch`），33 用例覆盖 fixed/prng/Resource/Movement/Combat + 同 seed 黄金回放结构全等；新增 `resetUnitIds()`/`resetBuildingIds()`，`GameState` 构造时调用使每局 ID 从固定基址开始；ID 命名空间调整为 **building 从 0、unit 从 1000**（建筑数受棋盘格封顶 <1000，单位高频增长取上段，永不冲突） |
| `src/game/systems/AISystem.ts` + `test/AISystem.test.ts`（新增） | AI"无脑出第一张可用牌"，无经济意识 / 防守 / 威胁评估 | 重写为**威胁驱动三段式决策**：①紧急防守（陨石清近基地敌群 → 威胁最高车道放箭塔 → Guardian 肉盾）②升级规划（`upgradeReachable` 守卫，`nextUpgradeCost ≤ COIN_CAP` 才升级/攒钱）③经济进攻（按偏好挑性价比牌推最弱车道、安全车道补兵营、大团进攻陨石）；`computeThreatByCol` 按敌军接近 AI 基地程度加权；新增难度分级 `'easy'\|'medium'\|'hard'`（默认 medium）；仅依赖 state + 注入 Prng，黄金回放确定性不变；+5 测试（共 38 全绿）。配套把 `COIN_CAP` 30→**300**（≥ 首档升级费 50），让基地升级对人机双方均可达（此前 `[50,100,200]` 全 > 30 永远升不了级）；`upgradeReachable` 守卫保留为防御性代码 |
| `src/game/GameEngine.ts` | `processCommand` 的 Unit/Building/Haste/Meteor 四个分支各自重复「扣币/记账/清槽/发 card_played/补牌/发 resource_changed」样板 | 抽 `consumeCardSlot(player, owner, handIndex, card, effect)` 收敛重复，各分支只留校验 + 专属效果闭包（约 -50 行）；事件顺序逐字不变，黄金回放确定性测试通过 |
| `src/game/systems/MovementSystem.ts` | `tick()` 每帧 `Array.from(board.units.values())` 全量快照分配（仅为迭代中安全删除）；横穿寻敌扫描过滤顺序非最优 | 改为**直接迭代 `board.units` Map**（唯一删除是 `moveCrossing` 删当前单位，删当前项对 Map 迭代器良定义；本系统不新增单位）省掉每帧分配；清理 pass 同样直接迭代删 `isDead`、去掉 `has()` 守卫；`getFriendlyUnitAheadInCrossing` 把最具区分度的 `state !== Crossing` 判断提前。行为逐字不变，38 测试 + 黄金回放通过 |

### 游戏核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理 |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（注入 `Prng` + 难度档；威胁驱动三段式：紧急防守 / 升级规划 / 经济进攻；只读 state，返回 `PlayerCommand[]`） |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |
| `i18n/index.ts` | `t()` 取词 + 插值；`initI18n`/`setLocale`/`getLocale`/`getSupportedLocales`/`onLocaleChange`/`detectLocale` |
| `i18n/locales/{zh,en,de}.ts` | 词条字典；`zh.ts` 为键唯一来源（`TranslationKey`），`en`/`de` 编译强制全翻 |

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
- **记录改动**：收到"记录改动/将改动记录进文档"等指令时，需同时更新以下文档——`CLAUDE.md`（已知修复表格）**以及**改动所在子目录的对应文档（animator 相关改 `tools/animator/ARCHITECTURE.md` 和 `REQUIREMENTS.md`；game 相关改 `code/DESIGN.md`；设计相关改 `design/` 下对应文件）。
