# Stickman Animation Editor — Product Requirements

> 版本 v0.1 · 2026-05-26

---

## 1. 产品定位

一个基于浏览器的火柴人骨骼动画编辑工具：
- 导入 PixiJS 兼容的 sprite atlas（TexturePacker 格式）
- 将 atlas 帧绑定到骨骼，制作带贴图的骨骼动画
- 定义关键帧，控制骨骼的旋转、缩放、位移、透明度及精灵切换
- 实时预览（骨架模式 / 精灵模式）
- 导出自定义 JSON 格式，附带 PixiJS 播放 runtime

**设计原则**：编辑器预览逻辑与游戏侧 runtime 共用同一套代码。编辑器里看到的效果，游戏里读同一份 JSON 播放结果完全一致，无需格式转换。

---

## 2. 功能模块

### 2.1 Atlas 管理

#### 2.1.1 导入
- 支持导入 PixiJS / TexturePacker JSON hash 格式（`.json` + `.png`）
- JSON 格式参考：
  ```json
  {
    "frames": {
      "head.png": { "frame": {"x":0,"y":0,"w":48,"h":48}, "pivot": {"x":0.5,"y":0.5} },
      "arm_upper.png": { ... }
    },
    "meta": { "image": "sheet.png", "size": {"w":512,"h":512} }
  }
  ```
- 同时接受 TexturePacker array 格式（`frames` 为数组）
- 导入后在 **Atlas 面板** 展示所有帧的缩略图

#### 2.1.2 多 atlas 支持
- 支持同时加载多个 atlas 文件（帧 id 全局唯一，以文件名前缀区分冲突）
- 可删除已导入的 atlas（同时解绑使用该 atlas 帧的骨骼）

---

### 2.2 Sprite 绑定

#### 规则
- 每块骨骼最多绑定 **一个精灵**（one bone → one sprite slot）
- 绑定信息是 **全局配置**（不随动画变化），精灵切换通过关键帧属性实现

#### 绑定属性（per bone，结构性配置，不可动画化）

| 属性 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `frameId` | `string \| null` | `null` | atlas 帧 id，null = 不绑定（显示骨架线） |
| `anchorX` | `number` | `0.5` | 精灵锚点 X（0–1） |
| `anchorY` | `number` | `0.5` | 精灵锚点 Y（0–1） |
| `flipX` | `boolean` | `false` | X 轴镜像，对称骨骼复用同一帧 |

> `anchorX/Y` 决定精灵**以哪个点**对齐到骨骼 pivot，属于结构性参数，整个动画不变。
>
> 精灵的初始旋转校正（`baseRotation`）和位移偏移（`offsetX/Y`）**不在 binding 里**——它们放在 **t=0 关键帧**的 `rotation` 和 `translateX/Y` 字段中。绑定精灵时系统自动在 t=0 创建关键帧（若不存在），用户直接在关键帧里编辑初始姿态。

#### 绑定行为
- 绑定 `frameId` 后，若当前动画在 t=0 **没有该骨骼的关键帧**，自动插入一条默认关键帧（所有属性为默认值）
- 用户可立即在 Inspector 编辑该 t=0 关键帧，调整初始旋转、位移、缩放等
- t=0 关键帧与其他时间点的关键帧完全等价，可正常删除（删除后插值从最近的关键帧推算）

#### 绑定 UI
- 骨骼属性面板（右侧）新增 "Sprite" 区块
- 点击帧选择器 → 弹出 atlas 帧浏览器（缩略图网格）
- 支持锚点可视化调整（精灵上显示十字准星拖拽）
- 支持 flipX 开关
- 绑定后 Inspector 自动跳转到 t=0 关键帧，提示用户调整初始姿态

---

### 2.3 关键帧系统

#### 2.3.1 关键帧属性（per bone, per keyframe）

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `rotation` | `number` | `0` | 相对骨骼 rest pose 的旋转 delta（度）。**t=0 关键帧的 `rotation` 同时承担精灵方向校正（原 baseRotation）的职责** |
| `scaleX` | `number` | `1` | X 轴缩放 |
| `scaleY` | `number` | `1` | Y 轴缩放 |
| `translateX` | `number` | `0` | 精灵相对骨骼 pivot 的 X 位移（像素）。**t=0 关键帧的 translate 同时承担精灵初始位置校正（原 offsetX/Y）的职责** |
| `translateY` | `number` | `0` | 精灵相对骨骼 pivot 的 Y 位移（像素） |
| `alpha` | `number` | `1` | 透明度 0–1（0 = 隐藏，1 = 完全显示） |
| `frameId` | `string \| null` | `undefined` | 覆盖绑定帧（精灵切换），undefined = 沿用 binding.frameId |
| `easing` | `EasingType` | `'linear'` | 到达**下一关键帧**的插值曲线 |

> **t=0 关键帧的特殊意义**：它定义了动画的初始姿态，同时承担精灵校正的职责（方向、位置）。绑定精灵后系统自动创建，用户可自由编辑，也可删除（删除后各属性退回默认值）。

#### 2.3.2 Easing 类型

```ts
type EasingType =
  | 'linear'
  | 'ease-in'       // cubic: t^2
  | 'ease-out'      // cubic: 1-(1-t)^2
  | 'ease-in-out'   // cubic: smooth step
  | 'step'          // 跳变，无插值（用于精灵切换）
```

- Easing 配置在**关键帧出点**（即从该帧到下一帧的过渡曲线）
- 精灵切换（`frameId`）建议使用 `'step'`，其余属性可独立设置

#### 2.3.3 关键帧操作
- 在任意时间点添加关键帧（K 键 / 工具栏按钮）
- 删除关键帧（Delete / Backspace）
- 在时间轴上拖拽移动关键帧位置（横向）
- 选中关键帧后在 Inspector 编辑所有属性
- 多选关键帧（Shift 点击）→ 批量删除 / 批量位移

---

### 2.4 骨骼变换插值

骨骼每帧的实际变换由相邻关键帧插值得出：

```
给定时间 t，找到左侧 kf1 和右侧 kf2：
  f = ease(kf1.easing, (t - kf1.time) / (kf2.time - kf1.time))

  rotation   = lerp(kf1.rotation,   kf2.rotation,   f)
  scaleX     = lerp(kf1.scaleX,     kf2.scaleX,     f)
  scaleY     = lerp(kf1.scaleY,     kf2.scaleY,     f)
  translateX = lerp(kf1.translateX, kf2.translateX, f)
  translateY = lerp(kf1.translateY, kf2.translateY, f)
  alpha      = lerp(kf1.alpha,      kf2.alpha,      f)
  frameId    = kf1.frameId  （step：到达 kf2 时间点才切换）
```

t 在第一个关键帧之前 → 使用第一帧值；在最后一帧之后 → 使用最后一帧值。

---

### 2.5 预览

#### 模式切换
- **骨架模式**：只显示骨骼线条（当前已实现），无需 atlas
- **精灵模式**：骨骼上渲染绑定的 atlas 精灵，应用所有变换
- 快捷键 `Tab` 切换模式；工具栏也有切换按钮

#### 实时预览
- 拖拽骨骼时精灵实时跟随（精灵模式下）
- 播放动画时精灵随关键帧插值变换
- Onion skin 在精灵模式下也支持（半透明显示前后帧精灵）

#### 预览设置
- 显示/隐藏骨架叠加（精灵模式下可叠加骨架线）
- 显示/隐藏 pivot 点
- 背景色切换（便于检查透明区域）

---

### 2.6 时间轴扩展

现有时间轴只显示 rotation 关键帧，需扩展：

- 时间轴行展示：每个骨骼显示一行，关键帧菱形按时间排列
- 关键帧颜色区分属性类型：
  - 灰色 = 仅 rotation
  - 蓝色 = 含 scale
  - 橙色 = 含 translate
  - 白色 = 含 sprite 切换
  - 混合属性 = 多色小点叠加
- 时间轴关键帧可左右拖动（改变 time）
- 右键关键帧 → 上下文菜单：编辑 easing / 复制 / 粘贴 / 删除

---

### 2.7 骨骼属性面板（Inspector）扩展

选中骨骼后，右侧 Inspector 展示：

```
┌─ Bone: R. Upper Arm ──────────────┐
│  Sprite                            │
│    Frame: [arm_upper.png  ▼] 🖼    │
│    Anchor: X [0.50] Y [0.50]       │
│    Offset: X [  0 ] Y [  0 ]       │
│    Base Rot: [  0 °] [↔ Flip]      │
├───────────────────────────────────┤
│  Keyframe @ 0.250s                 │
│    Rotation  [-12.0°] ←——●——→      │
│    Scale X   [ 1.00 ] ←——●——→      │
│    Scale Y   [ 1.00 ] ←——●——→      │
│    Trans X   [  0.0 ] ←——●——→      │
│    Trans Y   [  0.0 ] ←——●——→      │
│    Alpha     [ 1.00 ] ←——●——→      │
│    Easing    [ease-in-out   ▼]     │
│  [Reset] [Copy KF] [Set KF]        │
└───────────────────────────────────┘
```

- 滑块与数值输入框双向绑定
- "Set KF" 将当前面板值写入当前时间点的关键帧
- "Copy KF" 复制当前关键帧，可粘贴到其他时间点

---

### 2.8 导出格式（自定义 JSON）

编辑器使用**完全自定义的 JSON 格式**，同一份数据同时用于：
- 编辑器存档（再次导入继续编辑）
- 游戏/应用侧 runtime 直接消费

> **为什么不用 pixi-spine？**
> pixi-spine 是播放器，不是编辑器基础设施。Spine JSON 格式复杂、坐标系与 PixiJS 相反（Y 轴方向不同），引入它只会增加格式转换负担，且对编辑器的实现毫无帮助。自定义 runtime 核心约 150–200 行，完全可控。Spine 格式导出可作为后期可选适配器实现。

#### 文件格式 `.animator.json`

```jsonc
{
  "version": 1,

  // 骨骼绑定配置（全局，不随动画变化）
  // 结构性绑定：描述精灵如何挂在骨骼上，不含初始旋转/偏移（那些放在 t=0 KF）
  "bindings": {
    "spine":       { "frameId": "body_spine.png", "anchorX": 0.5, "anchorY": 0,   "flipX": false },
    "head":        { "frameId": "head_normal.png","anchorX": 0.5, "anchorY": 0.5, "flipX": false },
    "r_upper_arm": { "frameId": "arm_upper.png",  "anchorX": 0.5, "anchorY": 0,   "flipX": false },
    "l_upper_arm": { "frameId": "arm_upper.png",  "anchorX": 0.5, "anchorY": 0,   "flipX": true  }
    // ...
  },

  // 动画片段
  "animations": {
    "walk": {
      "duration": 0.8,
      "loop": true,
      "keyframes": [
        {
          // t=0 关键帧：初始姿态，同时承担精灵方向/位置校正职责
          "time": 0.0,
          "bones": {
            "spine":       { "rotation": 0,  "translateX": 0, "translateY": -34 },
            "head":        { "rotation": 90, "scaleX": 1, "scaleY": 1 },
            "r_upper_arm": { "rotation": -30, "easing": "ease-in-out" },
            "l_upper_arm": { "rotation": 30 }
          }
        },
        {
          "time": 0.4,
          "bones": {
            "spine":      { "rotation": -5 },
            "r_upper_arm":{ "rotation": 30, "easing": "ease-in-out" },
            "l_upper_arm":{ "rotation": -30 },
            "head":       { "frameId": "head_sweat.png", "easing": "step" }
          }
        }
      ]
    },
    "attack": { ... }
  }
}
```

#### 字段说明

**`bindings[boneId]`**（全局骨骼绑定，可选字段有默认值）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `frameId` | `string` | — | atlas 帧 id |
| `anchorX/Y` | `number` | `0.5` | 精灵锚点（0–1） |
| `offsetX/Y` | `number` | `0` | 相对骨骼 pivot 的像素偏移 |
| `baseRotation` | `number` | `0` | 精灵初始旋转校正（度） |
| `flipX` | `boolean` | `false` | X 轴镜像（对称骨骼复用同一帧） |

**`keyframes[].bones[boneId]`**（关键帧属性，均可选，缺省值见下）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `rotation` | `number` | `0` | 相对 rest pose 的旋转 delta（度） |
| `scaleX/Y` | `number` | `1` | 缩放 |
| `translateX/Y` | `number` | `0` | 相对 pivot 的位移（像素） |
| `alpha` | `number` | `1` | 透明度 0–1 |
| `frameId` | `string` | `undefined` | 覆盖绑定帧（精灵切换），缺省沿用 binding |
| `easing` | `string` | `"linear"` | 出点插值曲线，见 §2.3.2 |

---

### 2.9 Undo / Redo（必要功能）

编辑器标配，所有破坏性操作必须可撤销。

#### 快捷键
- `Ctrl+Z`：撤销
- `Ctrl+Shift+Z` / `Ctrl+Y`：重做

#### 计入 Undo 的操作（需实现 Command）

| 操作 | 说明 |
|------|------|
| 添加关键帧 | 包括绑定精灵时自动创建的 t=0 KF |
| 删除关键帧 | 单条或批量 |
| 修改关键帧属性 | rotation / scale / translate / alpha / frameId / easing |
| 移动关键帧时间点 | 时间轴拖拽 |
| 绑定 / 解绑精灵 | binding.frameId 变更 |
| 修改 binding 配置 | anchorX/Y、flipX |
| 骨骼拖拽旋转 | 鼠标拖拽结束时提交一条 Command |
| 重置姿态 | Reset Pose 按钮 |

#### 不计入 Undo
- 播放 / 暂停 / 停止
- 预览模式切换（骨架 ↔ 精灵）
- 时间轴 scrub（拖动播放头）
- 面板布局、视图选项（show joints 等）

#### 实现方式
使用 **Command 模式**：每个操作封装为 `{ execute(), undo() }` 对象，推入 `undoStack`。Redo 从 `redoStack` 取出。

```ts
interface Command {
  execute(): void;
  undo(): void;
  label: string;   // 显示在状态栏："Undo: Add Keyframe @ 0.250s"
}
```

- Undo 栈上限：100 条（超出时丢弃最旧的）
- 任何新 Command 执行时清空 `redoStack`

---

## 3. 数据模型扩展

### 3.1 骨骼绑定配置（新增）

```ts
// 结构性配置：描述精灵如何挂在骨骼上，整个动画不变，不可关键帧化
interface SpriteBinding {
  frameId: string;    // atlas 默认帧 id
  anchorX: number;    // 0–1，默认 0.5
  anchorY: number;    // 0–1，默认 0.5
  flipX:   boolean;   // X 轴镜像
}

// AppState 中新增
boneBindings: Map<string, SpriteBinding>;   // boneId → binding

// 注：精灵的初始旋转校正和位移偏移存在 t=0 关键帧的
//     rotation / translateX/Y 字段中，不在 SpriteBinding 里
```

### 3.2 关键帧扩展

```ts
// 原来
interface BoneKeyframe {
  rotation: number;
}

// 扩展后
interface BoneKeyframe {
  rotation?:   number;   // delta degrees
  scaleX?:     number;   // default 1
  scaleY?:     number;   // default 1
  translateX?: number;   // px，default 0
  translateY?: number;   // px，default 0
  alpha?:      number;   // 0–1，default 1
  frameId?:    string;   // sprite 切换，undefined = 沿用绑定
  easing?:     EasingType;  // 出点曲线，default 'linear'
}

interface Keyframe {
  time:  number;
  bones: Map<string, BoneKeyframe>;
}
```

### 3.3 Atlas 存储

```ts
interface AtlasFrame {
  x: number; y: number;
  w: number; h: number;
  pivotX: number; pivotY: number;  // TexturePacker pivot，或默认 0.5
}

interface AtlasAsset {
  id:      string;             // 文件名（不含扩展名）
  image:   HTMLImageElement;   // 已加载的贴图
  frames:  Map<string, AtlasFrame>;  // frameId → AtlasFrame
}
```

---

## 4. UI 布局变化

在现有布局基础上新增：

```
┌─────────────────────────────────────────────────────────────┐
│  Toolbar: [▶ Play] [⏹] [Speed ▼] [Loop] [+KF] [✕KF] ...   │
│           [🖼 Skeleton | Sprite] [+ Atlas]  ← 新增          │
├──────────┬──────────────────────────────────┬───────────────┤
│ Anim     │                                  │ Bone Inspector│
│ List     │         Canvas                   │  (扩展后)     │
│          │    骨架 / 精灵 实时预览           │               │
│          │                                  │ ─────────────│
│          │                                  │ Atlas Frames  │
│          │                                  │  (缩略图网格) │
│          │                                  │  ← 新增       │
├──────────┴──────────────────────────────────┴───────────────┤
│  Timeline（扩展：多属性关键帧颜色区分，可拖拽）              │
├─────────────────────────────────────────────────────────────┤
│  Status Bar                                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. PixiJS 游戏侧 Runtime

编辑器的动画播放核心（`AnimationController` + `Renderer`）直接抽取为独立的 runtime 包，供游戏侧使用。

### 游戏侧使用方式（预期 API）

```ts
import { StickmanRuntime } from '@your-project/stickman-runtime';

const runtime = new StickmanRuntime({
  atlasJson: '/assets/sheet.json',
  atlasImage: '/assets/sheet.png',
  animData: '/assets/character.animator.json',
  container: pixiContainer,   // PIXI.Container，由游戏传入
});

await runtime.load();
runtime.play('walk');          // 播放动画，自动循环
runtime.play('attack', { loop: false, onComplete: () => runtime.play('idle') });
runtime.setSpeed(1.5);
runtime.destroy();
```

### Runtime 内部结构（约 200 行）

```
applyFrame(boneId, t):
  1. 在 keyframes 中找到左右邻近帧
  2. 按 easing 函数计算插值因子 f
  3. lerp 所有属性（rotation / scaleX/Y / translateX/Y / alpha）
  4. frameId 用 step 切换（到达右帧时间点才切换）
  5. 对应 PIXI.Container 设置 rotation / scale / position / alpha
  6. 如有 frameId 变化，更新 PIXI.Sprite.texture
```

Runtime 与编辑器共享 `types.ts` 和插值逻辑，**零额外维护成本**。

---

## 6. 超出当前版本的功能（Backlog）

以下功能暂不实现，记录供后续迭代：

| 功能 | 原因 |
|------|------|
| IK（逆向运动学） | 实现复杂，当前 FK 已够用 |
| 骨骼权重蒙皮 | 超出火柴人场景 |
| 曲线编辑器（贝塞尔可视化） | 可用 `ease-in-out` 预设覆盖大部分需求 |
| 多角色同场景 | 超出单角色编辑范围 |
| 音频轨道 | 需要独立 audio 模块 |
| 网格变形（mesh deform） | Spine Pro 特性 |
| Spine JSON 格式导出 | 可作为后期适配器单独实现，不影响核心架构 |
