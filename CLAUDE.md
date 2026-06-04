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
- **FK 计算**：`Skeleton.computeFK(rootX, rootY, transforms)` → `WorldPositions`（纯函数）
- **关键帧插值**：`sampleClip(clip, t)` → `Map<boneId, ResolvedBoneTransform>`（无外部依赖，可复制到游戏引擎）；无 `frameId`，骨骼隐藏用 `alpha:0`
- **图片导入**：每骨骼一张 PNG（10 骨骼 + 1 阴影 = 11 张），按文件名自动映射；`ImageController` 管理 Blob + PIXI.Texture
- **Sprite 层级**：`SpriteBinding.zOrder` 控制骨骼精灵遮挡顺序；`binding:change` 或图片加载时对 `spriteLayer.children` 排序一次，渲染期间不重排
- **导出格式**：`.tao`（JSZip ZIP）内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing + canvas.toBlob）+ `spritesheet.json`（boneId→rect）
- **事件总线**：`EventBus<AppEvents>` 强类型，核心事件见 `src/core/EventBus.ts`；`images:change: string` 携带 slotId
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
| `src/io/IOController.ts` | `.tao` 导출（JSZip + shelf bin-packing + canvas.toBlob）/ 导入 |
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

## 导出格式

`.tao` 文件（ZIP 压缩包），内含：
- `animation.json`（version 2，bindings 无 frameId，每骨骼固定 1 张图）
- `spritesheet.png`（shelf bin-packing 合并图，canvas.toBlob PNG，JSZip DEFLATE 二次压缩）
- `spritesheet.json`（boneId → rect 映射，TexturePacker Hash 兼容）

```json
// animation.json
{
  "version": 2,
  "bindings": { "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6 } },
  "animations": { "walk": { "duration": 0.5, "loop": true, "keyframes": [...] } },
  "attachmentPoints": [
    { "id": "shadow", "parentBone": "root",  "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "parentBone": "spine", "offsetX": 0, "offsetY": -30 }
  ]
}
```

## 会话说明

- **权限**：Read / Write / Edit / Bash 全部直接执行，无需确认。`rm` / `rmdir` / `git rm` 需确认。
- **上下文提醒**：会话接近 200k token 上限时提醒切换新会话。
