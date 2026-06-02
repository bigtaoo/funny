> ⚠️ **已重命名** → 请查看 `ARCHITECTURE.md`

# Stickman Animation Editor — Technical Design

> **工具定位**：给 Notebook Wars 游戏角色制作骨骼关键帧动画，导出 JSON 供游戏引擎运行时读取。
> **运行方式**：`npm run dev`（Webpack DevServer，port 9091）

---

## 1. 架构概览

```
src/
├── index.ts                 入口：DOMContentLoaded → new App()
├── App.ts                   组合根（Composition Root）
│
├── core/
│   ├── types.ts             所有共享类型（无依赖）
│   ├── EventBus.ts          强类型事件总线
│   ├── AppState.ts          全局可变状态（读/写通过方法，写时 emit 事件）
│   └── CommandManager.ts    Undo/Redo 命令栈（max 100）
│
├── skeleton/
│   └── Skeleton.ts          骨骼定义、FK 计算（纯函数）
│
├── animation/
│   ├── AnimationController.ts  clip CRUD、播放循环、关键帧操作
│   ├── interpolate.ts          sampleClip（纯函数，可复用到游戏引擎）
│   └── presets.ts              内置预设动画
│
├── atlas/
│   └── AtlasController.ts   图集加载、TexturePacker JSON 解析、PIXI.Texture 管理
│
├── rendering/
│   └── Renderer.ts          PixiJS 渲染（骨骼线框 + sprite 层 + 挂点标记）
│
├── interaction/
│   └── InteractionController.ts  鼠标拖拽旋转骨骼、键盘快捷键、Pan
│
├── timeline/
│   ├── TimelineView.ts      Canvas 时间轴（绘制 + 交互）
│   └── ContextMenu.ts       右键菜单（easing 切换等）
│
├── io/
│   └── IOController.ts      JSON 导出/导入
│
└── ui/
    ├── AnimListPanel.ts      左侧动画列表
    ├── BoneInspectorPanel.ts 右侧骨骼属性 + sprite 绑定
    ├── AtlasPanel.ts         图集导入面板
    ├── AttachmentPanel.ts    挂点编辑面板
    ├── ToolbarPanel.ts       顶部工具栏
    └── StatusBar.ts          底部状态栏
```

### 依赖方向（单向）

```
types ← skeleton ← animation ← rendering
types ← core ← atlas
types ← core ← interaction
ui → (animation, atlas, core, skeleton)
App → everything
```

`interpolate.ts` 有意设计为无外部依赖，可以直接复制到游戏引擎运行时使用。

---

## 2. 数据模型

### 骨骼（Skeleton）

11 根骨骼，父子树：

```
root
├── spine
│   ├── head
│   ├── r_upper_arm → r_lower_arm
│   └── l_upper_arm → l_lower_arm
├── r_upper_leg → r_lower_leg
└── l_upper_leg → l_lower_leg
```

每根骨骼有：
- `rwa`：rest world angle（degrees，0=右，顺时针为正）
- `rla`：rest local angle = rwa - parent.rwa（FK 计算用）
- `len`：骨骼长度（px）

FK 结果（`WorldPose`）：每根骨骼的 pivot 点 `(sx,sy)`、tip 点 `(ex,ey)`、世界角 `wa`。

### 关键帧（Keyframe）

```ts
interface Keyframe {
  time:  number;
  bones: Map<string, BoneKeyframe>;  // boneId → 该帧该骨骼的变换
}

interface BoneKeyframe {
  rotation?:   number;   // delta degrees，缺省 0
  scaleX?:     number;   // 缺省 1
  scaleY?:     number;   // 缺省 1
  translateX?: number;   // px，缺省 0
  translateY?: number;   // px，缺省 0
  alpha?:      number;   // 0-1，缺省 1
  frameId?:    string | null;  // sprite 帧切换；null=隐藏
  easing?:     EasingType;     // 出口曲线，缺省 linear
}
```

关键帧是**稀疏的**：只记录该帧有变化的骨骼，其余骨骼从相邻关键帧插值。

### 动画片段（AnimationClip）

```ts
interface AnimationClip {
  duration:  number;     // 总时长（s）
  loop:      boolean;
  keyframes: Keyframe[]; // 按 time 升序排列
}
```

### Sprite 绑定（SpriteBinding）

```ts
interface SpriteBinding {
  frameId: string;   // 默认图集帧 ID
  anchorX: number;   // 锚点 0-1
  anchorY: number;
  flipX:   boolean;
}
```

绑定存在 `AppState`（非 clip 内），随项目 JSON 导出。

### 挂点（AttachmentPoint）

```ts
interface AttachmentPoint {
  id:      string;   // 'shadow' | 'hit'
  label:   string;
  offsetX: number;   // 相对于 root（hip pivot），px
  offsetY: number;
}
```

不参与动画插值，仅表示固定相对坐标。游戏运行时用 `rootWorldPos + offset` 换算世界坐标。

---

## 3. 事件总线

所有跨模块通信通过 `EventBus<AppEvents>` 完成，避免直接引用。

| 事件 | payload | 触发时机 |
|---|---|---|
| `bone:select` | `string \| null` | 选中/取消骨骼 |
| `bone:rotate` | `{id, delta}` | 拖拽中（live delta） |
| `time:change` | `number` | 播放/拖动时间轴 |
| `play:state` | `boolean` | 播放/暂停 |
| `anim:select` | `string` | 切换当前动画 |
| `anim:list` | void | 列表增删改 |
| `kf:change` | void | 关键帧数据变化 |
| `atlas:change` | void | 图集加载/移除 |
| `binding:change` | `string` (boneId) | sprite 绑定变化 |
| `attachment:change` | void | 挂点数据变化 |
| `preview:mode` | `'skeleton'\|'sprite'` | 预览模式切换 |
| `history:change` | `{canUndo, canRedo, label}` | Undo/Redo 栈变化 |
| `status` | `string` | 状态栏消息 |
| `pose:reset` | void | 重置为 rest pose |

---

## 4. 插值（interpolate.ts）

`sampleClip(clip, t)` 返回 `Map<boneId, ResolvedBoneTransform>`。

算法（两次线性 pass，O(bones × keyframes)）：
1. Pass 1：正向扫描 keyframes，记录每个 bone 最后一个 `time ≤ t` 的帧（kf1）。遇到 `time > t` 可提前 break。
2. Pass 2：逆向扫描，记录每个 bone 第一个 `time > t` 的帧（kf2）。
3. 对每个 bone 用 `kf1.easing` 做插值。

easing 类型：`linear` | `ease-in` | `ease-out` | `ease-in-out` | `step`。

`frameId` 特殊处理：step 行为——easing 到达 1 时才切换到 kf2.frameId。

---

## 5. 渲染流程

每帧（PixiJS ticker）：

```
animCtrl.getCurrentFrame()       → Map<boneId, ResolvedBoneTransform>
  + state.liveDelta（drag 中）
Skeleton.computeFK(rootX, rootY, frame) → WorldPositions
renderer.draw({
  worldPose, boneTransforms,
  bindings, getTexture,
  attachmentPoints,
  previewMode, ...
})
```

渲染层级（PixiJS stage，从下到上）：

```
gridGfx     — 背景网格
onionGfx    — Onion skin（0.2 alpha）
spriteLayer — PIXI.Sprite（只在 sprite 模式）
boneGfx     — 骨骼线框（skeleton 模式 或 showSkeletonOverlay）
selGfx      — 选中高亮 + 挂点标记 + Guide
```

**Sprite 缓存**：`spriteCache: Map<"{boneId}:{frameId}", PIXI.Sprite>`，每帧通过 `visible` 控制显示，不反复创建。

---

## 6. 命令模式（Undo/Redo）

所有会改变动画数据的操作都封装成 `Command`（`execute/undo/label`），通过 `CommandManager.execute()` 执行并推入 undo 栈。

例外：拖拽骨骼时通过 `animCtrl.setBoneDelta()` 写入 live delta（不入栈），mouseUp 时才创建 `RotateBoneCommand` 提交。

快捷键：`Ctrl+Z` undo，`Ctrl+Shift+Z` / `Ctrl+Y` redo。

---

## 7. 导出格式（animation.animator.json）

```jsonc
{
  "version": 1,
  "bindings": {
    "spine": { "frameId": "body", "anchorX": 0.5, "anchorY": 0.5, "flipX": false }
  },
  "animations": {
    "walk": {
      "duration": 0.5,
      "loop": true,
      "keyframes": [
        {
          "time": 0,
          "bones": {
            "spine":       { "rotation": 5 },
            "r_upper_leg": { "rotation": -28, "easing": "ease-in-out" }
          }
        }
      ]
    }
  },
  "attachmentPoints": [
    { "id": "shadow", "label": "🔵 Shadow", "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "label": "✦ Hit",     "offsetX": 0, "offsetY": -80 }
  ]
}
```

---

## 8. 性能注意事项

- **TimelineView** 有 `dirty` / `labelsDirty` 两个 flag。canvas 重绘只在数据变化时触发；label DOM 重建只在骨骼/动画/关键帧结构变化时触发（不含每帧时间刷新）。
- **AttachmentPanel** DOM 只建一次；`attachment:change` 事件只更新 input.value，且跳过当前 focused 元素以保留用户输入。
- **sampleClip** 两次线性 pass（O(n×m)），keyframes 有序，pass 1 可提前 break。
- **hit-test** `DRAW_ORDER_REVERSED` 懒初始化后缓存，mousedown 不再每次新建数组。

---

## 9. 已知局限 / 待改进

- `RotateBoneCommand.undo()` 在 `!hadKeyframe` 时删除整个 keyframe，若该帧有多个骨骼数据会一起删除。
- 右键 Pan 的 `window` 事件监听器没有 destroy 入口（工具关闭时 GC 回收，影响不大）。
- 图集 JSON-only 导入：只支持 `meta.image` 为 data URL 或 HTTP URL；TexturePacker 标准输出（相对文件名）仍需同时提供图片文件。
- 暂无骨骼权重 / IK / 蒙皮，纯 FK。

---

## 10. 快捷键

| 键 | 动作 |
|---|---|
| `Space` | 播放/暂停 |
| `K` | 在当前时间添加关键帧 |
| `Delete` / `Backspace` | 删除选中关键帧 |
| `Tab` | 切换 Skeleton / Sprite 预览模式 |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| 左键拖骨骼 | 旋转（mouseUp 提交 Command） |
| 右键拖画布 | Pan |
