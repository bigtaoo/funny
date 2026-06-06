# Stickman Animation Editor — Architecture

> 当前实现（2026-06），已完成重构。旧版重构规划存档于 git history。

---

## 1. 目录结构

```
src/
├── index.ts                   入口：DOMContentLoaded → new App()
├── App.ts                     组合根（Composition Root）
│
├── core/
│   ├── types.ts               所有共享类型（无外部依赖）
│   ├── EventBus.ts            强类型事件总线
│   ├── AppState.ts            全局可变状态（写时 emit 事件）
│   └── CommandManager.ts      Undo/Redo 命令栈（max 100）
│
├── skeleton/
│   └── Skeleton.ts            骨骼定义、FK 计算（纯函数）
│                              computeDefaultShadowSize() 从 rest pose 估算阴影尺寸
│
├── animation/
│   ├── AnimationController.ts clip CRUD、播放循环、关键帧操作
│   ├── interpolate.ts         sampleClip（纯函数，无外部依赖，可复用到游戏引擎）
│   └── presets.ts             内置预设动画
│
├── images/
│   └── ImageController.ts     逐张 PNG 导入、bone slot 映射、PIXI.Texture 管理
│
├── rendering/
│   └── Renderer.ts            PixiJS 渲染（骨骼线框 + sprite 层 + 挂点标记）
│
├── interaction/
│   └── InteractionController.ts  鼠标拖拽旋转骨骼、键盘快捷键、Pan
│
├── timeline/
│   ├── TimelineView.ts        Canvas 时间轴（dirty flag 驱动重绘）
│   └── ContextMenu.ts         右键菜单（easing 切换等）
│
├── io/
│   └── IOController.ts        .tao 导出（JSZip + shelf bin-packing + canvas PNG）/ 导入
│
└── ui/
    ├── AnimListPanel.ts        左侧动画列表
    ├── BoneInspectorPanel.ts   右侧骨骼属性 + sprite 绑定
    ├── ImagePanel.ts           图片导入面板（bone slot 映射）
    ├── AttachmentPanel.ts      挂点编辑面板（parentBone + offset + shadow size）
    ├── ToolbarPanel.ts         顶部工具栏
    └── StatusBar.ts            底部状态栏
```

### 依赖方向（单向）

```
types ← skeleton ← animation ← rendering
types ← core ← images
types ← core ← interaction
ui → (animation, images, core, skeleton)
App → everything
```

`interpolate.ts` 无任何外部依赖——是编辑器与游戏引擎的共享核心（见 §7）。

---

## 2. 数据模型

### 骨骼（Skeleton）

11 根骨骼，父子树：

```
root (len=0，hip pivot)
├── spine
│   ├── head
│   ├── r_upper_arm → r_lower_arm
│   └── l_upper_arm → l_lower_arm
├── r_upper_leg → r_lower_leg
└── l_upper_leg → l_lower_leg
```

每根骨骼：
- `rwa`：rest world angle（degrees，0=右，顺时针/向下为正）；按**角色朝右**约定设定，`r_` 骨骼在屏幕左，`l_` 骨骼在屏幕右（手臂水平 r=180°/l=0°，腿向外下方 r=120°/l=60°）
- `rla`：rest local angle = rwa − parent.rwa（FK 计算用）
- `len`：骨骼长度（px）

FK 结果（`WorldPose`）：pivot 点 `(sx,sy)`、tip 点 `(ex,ey)`、世界角 `wa`。

### 关键帧

```ts
interface Keyframe {
  time:  number;
  bones: Map<string, BoneKeyframe>;
}

interface BoneKeyframe {
  rotation?:   number;        // delta degrees，缺省 0
  scaleX?:     number;        // 缺省 1
  scaleY?:     number;        // 缺省 1
  translateX?: number;        // px，缺省 0
  translateY?: number;        // px，缺省 0
  alpha?:      number;        // 0-1，缺省 1
  easing?:     EasingType;    // 出口曲线，缺省 linear
}
```

关键帧是**稀疏的**：只记录有变化的骨骼，其余从相邻帧插值。

### Sprite 绑定（SpriteBinding）

```ts
interface SpriteBinding {
  anchorX:  number;  // 0–1，图片内 pivot X（0=左边，1=右边），默认 0.5
  anchorY:  number;  // 0–1，图片内 pivot Y（0=上边，1=下边），默认 0.5
  flipX:    boolean; // 水平翻转
  zOrder:   number;  // 渲染层次（数值越大越靠前），全局固定，不随动画变化
  offsetX:  number;  // 像素偏移 X，叠加在骨骼世界坐标上，默认 0
  offsetY:  number;  // 像素偏移 Y，叠加在骨骼世界坐标上，默认 0
  rotation: number;  // 静态旋转偏移（度），叠加在动画旋转上，默认 0
  scaleX:   number;  // 静态缩放，与动画 scaleX 相乘，默认 1
  scaleY:   number;  // 静态缩放，与动画 scaleY 相乘，默认 1
}
```

`offsetX`/`offsetY` 用于处理图片相对骨骼位置的整体平移（如身体很宽时胳膊图片需要向侧面偏移），与关键帧动画中的 `translateX`/`translateY` 互不干扰。旧存档缺少该字段时渲染器以 `?? 0` 安全回退。

### 编辑器模式（EditorMode）

```ts
// AppState
editorMode: 'skin' | 'animate'   // 默认 'animate'，不序列化到存档
setEditorMode(mode: 'skin' | 'animate'): void  // emit 'editor:mode'
```

- **skin**：渲染静息姿（空 transforms → FK 得到纯 rest pose）；Inspector 只显示 SpriteBinding 参数；骨骼拖拽旋转禁用（仍可点击选择骨骼）
- **animate**：正常动画帧渲染；Inspector 只显示关键帧变换；SpriteBinding 只读摘要
- 快捷键 `S` / 工具栏 🎨/🎬 按钮切换；切换不计入 Undo

### 骨骼长度缩放（BoneLengthScales）

```ts
// AppState
boneLengthScales: ReadonlyMap<string, number>  // 稀疏；1.0 不存储
getLengthScale(boneId: string): number          // 未设置时返回 1.0
setLengthScale(boneId: string, scale: number): void  // emit 'rig:change'
setAllLengthScales(scales: Record<string, number>): void
```

- **用途**：每个角色设置一次，让骨骼可视长度与美术图片比例对齐，方便动画调整。与关键帧动画数据完全独立（旋转关键帧不受骨骼长度影响）。
- **生效位置**：`Skeleton.computeFK(..., lengthScales?)` — 每根骨骼的 `len` 乘以对应倍率后再计算 tip 坐标；sprite 跟随 FK 位置，因此也随骨骼伸缩。
- **Inspector UI**：选中骨骼后（root 和 head 除外），顶部显示 **Length (px)** 输入框，输入实际像素值，内部换算为 `px / bone.defaultLen`。
- **序列化**：`.tao.editor` 和 `.tao` 均含 `boneLengthScales` 字段（稀疏对象，仅含非 1.0 的骨骼）；旧文件缺失时安全回退为全 1.0。

### 挂点（AttachmentPoint）

```ts
interface AttachmentPoint {
  id:         string;        // 'shadow' | 'hit'
  label:      string;
  parentBone: string;        // 跟随的骨骼（使用该骨骼 tip 坐标）
  offsetX:    number;        // 相对骨骼 tip 的偏移（世界空间 px）
  offsetY:    number;
  shadowW?:   number;        // shadow 专用：椭圆半宽（省略则从 rest pose 自动计算）
  shadowH?:   number;        // shadow 专用：椭圆半高
}
```

世界坐标 = `bone.tip + (offsetX, offsetY)`，每帧跟随父骨骼移动。

---

## 3. 事件总线

| 事件 | payload | 触发时机 |
|---|---|---|
| `bone:select` | `string \| null` | 选中/取消骨骼 |
| `bone:rotate` | `{id, delta}` | 拖拽中（live delta） |
| `time:change` | `number` | 播放/拖动时间轴 |
| `play:state` | `boolean` | 播放/暂停 |
| `anim:select` | `string` | 切换当前动画 |
| `anim:list` | void | 列表增删改 |
| `kf:change` | void | 关键帧数据变化 |
| `images:change` | void | 骨骼图片加载/移除 |
| `binding:change` | `string` (boneId) | sprite 绑定变化 |
| `attachment:change` | void | 挂点数据变化 |
| `rig:change` | void | 骨骼长度倍率变化（触发 Inspector 刷新 + 下一帧 FK 重算） |
| `preview:mode` | `'skeleton'\|'sprite'` | 预览模式切换 |
| `editor:mode` | `'skin'\|'animate'` | 编辑器模式切换（Inspector + 渲染流程分流） |
| `history:change` | `{canUndo, canRedo, label}` | Undo/Redo 栈变化 |
| `status` | `string` | 状态栏消息 |
| `pose:reset` | void | 重置为 rest pose |

---

## 4. 插值算法（interpolate.ts）

`sampleClip(clip, t)` → `Map<boneId, ResolvedBoneTransform>`

**两次线性 pass，O(bones × keyframes)：**
1. Pass 1 正向扫描：每个 bone 记录最后一个 `time ≤ t` 的帧（kf1）。`time > t` 时提前 break。
2. Pass 2 逆向扫描：每个 bone 记录第一个 `time > t` 的帧（kf2）。
3. 用 `kf1.easing` 插值。

easing：`linear` | `ease-in` | `ease-out` | `ease-in-out` | `step`

---

## 5. 渲染流程

每帧（PixiJS ticker）：

```
// Skin 模式：空 transforms → 静息姿；Animate 模式：animCtrl.getCurrentFrame()
frame = editorMode === 'skin' ? new Map() : animCtrl.getCurrentFrame()
  ↑ Animate 模式下叠加 liveDelta（drag 中实时预览）
Skeleton.computeFK(rootX, rootY, frame, boneLengthScales) → WorldPositions
renderer.draw({ worldPose, boneTransforms, bindings, attachmentPoints, ... })
```

渲染层级（PixiJS stage，从下到上）：

```
gridGfx      — 背景网格
onionGfx     — Onion skin（alpha 0.2）
boneGfx      — 骨骼线框（skeleton 模式专用；sprite 模式下清空）
spriteLayer  — PIXI.Sprite（只在 sprite 模式可见，盖住骨骼）
overlayGfx   — 骨骼叠加线框（sprite 模式 + showSkeletonOverlay 时使用，位于 sprite 上方）
selGfx       — 选中高亮 + 挂点标记 + Guide
```

`showSkeletonOverlay` 默认 `false`；skeleton 模式下骨骼绘入 `boneGfx`，sprite 模式下骨骼叠加绘入 `overlayGfx`，两者互斥。

**Sprite 缓存**：`spriteCache: Map<boneId, PIXI.Sprite>`，通过 `visible` 控制显示，不反复创建。

**Sprite 层级**：`zOrder` 全局固定，不随动画变化。`binding:change` 或图片加载完成时，按 `zOrder` 对 `spriteLayer` 的 children 重新排序一次（`spriteLayer.children.sort(...)`），此后渲染期间不再排序，无运行时开销。

**挂点渲染**：shadow → 蓝色椭圆（尺寸优先 shadowW/H，否则 `Skeleton.computeDefaultShadowSize()`）；hit → 红色准星。

---

## 6. 命令模式（Undo/Redo）

所有数据变更封装为 `Command`（`execute/undo/label`），通过 `CommandManager.execute()` 提交，推入 undo 栈（上限 100）。

**例外**：拖拽骨骼时写入 `liveDelta`（不入栈），mouseUp 时创建 `RotateBoneCommand` 一次性提交。

快捷键：`Ctrl+Z` undo，`Ctrl+Shift+Z` / `Ctrl+Y` redo。

---

## 7. 编辑器与游戏引擎共享代码

**目标**：同一套插值代码，编辑器预览效果 = 游戏运行效果。

**共享范围**：
- `animation/interpolate.ts`（`sampleClip`、`applyEasing`、`interpolateBone`）
- `core/types.ts` 中的 `BoneKeyframe`、`AnimationClip`、`ResolvedBoneTransform`、`AttachmentPoint`

**策略（已决策）**：两份独立代码，不引入共享目录。

`interpolate.ts` 逻辑稳定，改动频率极低。游戏侧直接复制该文件和必要 types，各自编译。若日后频繁改动导致两侧出现行为差异，再迁移到 path alias 方案。

> **当前状态**：game 侧尚无动画代码。

---

## 8. 导出格式（.tao）

`.tao` = ZIP 压缩包（JSZip），内含三个文件：

**animation.json**（version 2，bindings 含 zOrder / offsetX / offsetY，无 frameId）：
```jsonc
{
  "version": 2,
  "bindings": {
    "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6,
               "offsetX": 0, "offsetY": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 }
  },
  "boneLengthScales": { "spine": 1.4, "r_upper_arm": 0.9 },
  "animations": {
    "walk": {
      "duration": 0.5,
      "loop": true,
      "keyframes": [
        { "time": 0, "bones": { "spine": { "rotation": 5 }, "r_upper_leg": { "rotation": -28, "easing": "ease-in-out" } } }
      ]
    }
  },
  "attachmentPoints": [
    { "id": "shadow", "parentBone": "root",  "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "parentBone": "spine", "offsetX": 0, "offsetY": -30 }
  ]
}
```

**spritesheet.json**（TexturePacker Hash 兼容，key = boneId）：
```jsonc
{
  "frames": {
    "spine": { "frame": { "x": 0, "y": 0, "w": 20, "h": 60 }, "sourceSize": { "w": 20, "h": 60 } }
  },
  "meta": { "size": { "w": 256, "h": 128 } }
}
```

**spritesheet.png**：shelf-packing（按高度降序排列）合并至 1024px 宽 canvas，`canvas.toBlob('image/png')` 导出，JSZip DEFLATE 二次压缩。

**导出流程**（`IOController.exportTao`）：
1. 从 `ImageController` 取各骨骼 Blob，`loadImageFromBlob` 并行加载为 `HTMLImageElement`
2. Shelf-packing 算法计算各图 rect，绘制到 canvas
3. `canvas.toBlob` → PNG Blob；`JSZip` 打包三个文件 → 下载 `.tao`

**导入流程**（`IOController.importTao`）：
1. `JSZip.loadAsync` 解包 `.tao`
2. 解析 `spritesheet.json`，从 `spritesheet.png` 按 rect 逐帧 canvas 抠图 → 各骨骼独立 Blob
3. `ImageController.setBlob` 存储骨骼 Blob + 创建 `PIXI.Texture`
4. `animation.json` → 恢复 bindings / animations / attachmentPoints

---

## 9. 性能注意事项

- **TimelineView**：`dirty`/`labelsDirty` 两个 flag，canvas 重绘和 label DOM 重建各自按需触发
- **AttachmentPanel**：DOM 建一次，`attachment:change` 只更新 input value，跳过 focused 元素
- **sampleClip**：两次线性 pass，keyframes 有序，pass 1 提前 break
- **hit-test**：`DRAW_ORDER_REVERSED` 懒初始化缓存

---

## 10. 已知局限

- `RotateBoneCommand.undo(!hadKeyframe)` 删整个 keyframe，若该帧有多骨骼数据会一并删除
- 暂无 IK / 骨骼权重 / 蒙皮，纯 FK
- 右键 Pan 的 `window` 事件监听无 destroy 入口

---

## 11. 快捷键

| 键 | 动作 |
|---|---|
| `Space` | 播放/暂停 |
| `K` | 当前时间添加关键帧 |
| `Delete` / `Backspace` | 删除选中关键帧 |
| `Tab` | 切换 Skeleton / Sprite 预览模式 |
| `S` | 切换 Skin / Animate 编辑器模式 |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| 左键拖骨骼 | 旋转（mouseUp 提交 Command） |
| 右键拖画布 | Pan |
