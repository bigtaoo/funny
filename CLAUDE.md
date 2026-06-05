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
│   │   └── ARCHITECTURE.md / REQUIREMENTS.md / SPEC.md
│   │
│   └── animation-editor/  旧版单文件 HTML 编辑器（index.html，参考用）
│
├── art/
│   ├── maps/              地图资源
│   ├── units/             角色概念图
│   └── index.html         静态资源索引
│
└── design/                产品/美术设计文档
```

## 动画编辑器（tools/animator）

### 启动

```bash
cd tools/animator
npm run start   # webpack dev server，端口 9091
npm run build   # 生产构建
```

### 架构要点

- **11 根固定骨骼**：root → spine → head / r_upper_arm → r_lower_arm / l_upper_arm → l_lower_arm；root → r_upper_leg → r_lower_leg / l_upper_leg → l_lower_leg
- **FK 计算**：`Skeleton.computeFK(rootX, rootY, transforms, lengthScales?)` → `WorldPositions`（纯函数）；`lengthScales` 为可选的每骨骼长度倍率 Map，缺省全为 1.0
- **关键帧插值**：`sampleClip(clip, t)` → `Map<boneId, ResolvedBoneTransform>`（无外部依赖，可复制到游戏引擎）；无 `frameId`，骨骼隐藏用 `alpha:0`
- **图片导入**：每骨骼一张 PNG（10 骨骼 + 1 阴影 = 11 张），按文件名自动映射；`ImageController` 管理 Blob + PIXI.Texture；**加载任意一张图片即自动切换到 Sprite 预览模式**
- **Sprite 层级**：`SpriteBinding.zOrder` 控制骨骼精灵遮挡顺序；`binding:change` 或图片加载时对 `spriteLayer.children` 排序一次，渲染期间不重排
- **Sprite Binding 静态偏移**：`SpriteBinding` 含 `offsetX`/`offsetY`（像素偏移，叠加在骨骼世界坐标上）、`rotation`（度，叠加在动画旋转上）、`scaleX`/`scaleY`（乘以动画缩放），用于修正图片位置/朝向/尺寸，与关键帧动画互不干扰
- **导출格式**：`.tao`（JSZip ZIP）内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing + canvas.toBlob）+ `spritesheet.json`（boneId→rect）
- **编辑器存档格式**：`.tao.editor`（JSZip ZIP）内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始图，无损，不合并 spritesheet）；Chrome/Edge 通过 File System Access API 弹出原生保存对话框（`suggestedName` 不含扩展名，由 API 自动追加）；Firefox 等不支持的浏览器退回 `window.prompt()` 询问文件名再 `<a download>` 触发下载
- **骨骼长度（Rig 设置）**：`AppState.boneLengthScales: Map<boneId, number>` 存每根骨骼的长度倍率（稀疏，1.0 不存储）；Inspector 面板「Length (px)」输入框以实际像素显示，内部换算为倍率；序列化进 `.tao.editor` 和 `.tao`；每个角色设置一次，不影响关键帧动画数据
- **事件总线**：`EventBus<AppEvents>` 强类型，核心事件见 `src/core/EventBus.ts`；`images:change: string` 携带 slotId；`rig:change` 触发骨骼长度变更后的重绘
- **命令模式**：所有数据变更封装为 `Command`，支持 Undo/Redo（上限 100）
- **时间轴骨骼行**：`Skeleton.TIMELINE_BONES` = 10 根（spine + head + 4 臂 + 4 腿），每行 26px，标尺 20px，共需 280px

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
- **骨骼动画 Runtime**：待实现（`StickmanRuntime`），读取 animator 导出的 JSON
- **确定性约束**：游戏逻辑（`code/src/game/`）内严禁使用 `Math.random()`，必须使用 `Prng`（`game/math/prng.ts`）。`GameState` 构造函数以 seed 派生各 PRNG；新增需要随机性的系统，在 `GameEngine` 中用 `new Prng(seed ^ 唯一常量)` 注入。

### 已知修复（2026-06）

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/layout/ILayout.ts` | 缺少 `enemyBaseRect()` 接口 | 新增该方法，`PortraitLayout` / `LandscapeLayout` 均已实现 |
| `src/render/BoardView.ts` | 基地无视觉图片，仅靠高亮矩形标识 | 用 `game_base.png` 渲染双方基地精灵；敌方按朝向镜像（横屏左右翻、竖屏上下翻） |
| `src/render/BuildingView.ts` | 建筑用占位矢量图（矩形/多边形）渲染 | 替换为 PNG 精灵（`game_infantry_barracks.png` / `game_archer_barracks.png`）；`acquireSprite` 添加 scale 0→1 ease-out cubic 弹出动画（约 0.3s） |
| `src/game/systems/CombatSystem.ts` | 箭塔 `findTargetForBuilding` 仅做前向列扫描，无法命中横穿（Crossing）的敌军 | 改为 Chebyshev 距离全向扫描，按距离环由近到远查找，覆盖纵向/横向/斜向所有敌人 |

### 游戏核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理 |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（注入 `Prng`，每 45 tick 行动一次） |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |

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
- **权限**：Read / Write / Edit / Bash 全部直接执行，无需确认。`rm` / `rmdir` / `git rm` 需确认。
- **上下文提醒**：会话接近 200k token 上限时提醒切换新会话。
