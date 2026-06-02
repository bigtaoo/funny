# Stickman Animation Editor — Requirements

> 版本 v0.2 · 2026-06（在 v0.1 基础上更新，对齐当前实现）

---

## 1. 产品定位

基于浏览器的火柴人骨骼动画编辑工具：
- 给 Notebook Wars 游戏角色制作关键帧骨骼动画
- 导入 sprite atlas，将帧绑定到骨骼，预览实际游戏效果
- 导出自定义 JSON，游戏引擎运行时直接消费

**核心设计原则**：编辑器与游戏引擎共用同一套插值代码（`interpolate.ts`），编辑器里看到的效果 = 游戏里播放的效果，零格式差异。

---

## 2. 功能规格

### 2.1 骨骼系统

- **固定 11 根骨骼**（修改需改代码，无运行时增删）
  - `root`（髋部，FK 锚点，不可选）
  - `spine`、`head`
  - `r/l_upper_arm`、`r/l_lower_arm`（共 4 根）
  - `r/l_upper_leg`、`r/l_lower_leg`（共 4 根）
- **选择**：点击高亮，右侧面板显示属性
- **旋转**：左键拖拽，相对 pivot 点计算 delta
- **Pan**：右键拖拽画布

### 2.2 动画片段（Clip）管理

| 操作 | 入口 |
|---|---|
| 新建 | 左侧 "+ New" |
| 重命名 | "✎" 按钮 |
| 删除 | "🗑" 按钮 + 确认 |
| 切换 | 点击列表项（自动同步 Duration / Loop 输入框） |
| 加载预设 | 底部 "📋 Preset…"（idle / walk / attack / hurt / death / spawn） |

### 2.3 关键帧系统

关键帧是**稀疏的**：只记录有变化的骨骼；其余骨骼从相邻帧插值；不同属性各自独立插值。

#### 关键帧属性（per bone, per keyframe）

| 属性 | 类型 | 缺省值 | 说明 |
|---|---|---|---|
| `rotation` | `number` | `0` | 相对 rest pose 的旋转 delta（度） |
| `scaleX/Y` | `number` | `1` | 缩放 |
| `translateX/Y` | `number` | `0` | 相对骨骼 pivot 的位移（px） |
| `alpha` | `number` | `1` | 透明度 0–1 |
| `frameId` | `string \| null` | `undefined` | sprite 帧切换；null=隐藏；undefined=沿用 binding |
| `easing` | `EasingType` | `'linear'` | 出口插值曲线 |

**t=0 关键帧特殊意义**：定义初始姿态，同时承担精灵方向/位置校正（相当于其他工具的 baseRotation + offset）。绑定精灵时自动创建。

#### Easing 类型

| 类型 | 描述 |
|---|---|
| `linear` | 匀速（默认） |
| `ease-in` | 慢入快出 |
| `ease-out` | 快入慢出 |
| `ease-in-out` | 慢入慢出 |
| `step` | 瞬间跳变（用于 sprite 帧切换） |

#### 关键帧操作

| 操作 | 快捷键 / 入口 |
|---|---|
| 添加（当前时间+当前姿态） | `K` / 工具栏 "+ Keyframe" |
| 删除 | `Delete` / `Backspace` |
| 跳转前/后关键帧 | "⏮" / "⏭" 按钮 |
| 拖动改时间 | 时间轴菱形左键拖拽 |
| 设置 easing | 时间轴右键菜单 |
| 复制 / 粘贴 | 时间轴右键菜单 |

### 2.4 时长管理

- **手动**：工具栏 Duration 数字输入框
- **自动**：点 "Auto" 按钮，设为最后一个关键帧时间
- 切换 clip 时 Duration / Loop 自动同步

### 2.5 播放控制

| 控制 | 入口 |
|---|---|
| 播放/暂停 | `Space` / "▶ Play" |
| 停止（回 0） | "⏹ Stop" |
| 速度 | 0.25× / 0.5× / 1× / 2× |
| 循环 | Loop 复选框 |

### 2.6 Atlas 管理

#### 导入

- 支持 TexturePacker JSON Hash 格式（`.json` + 图片）
- 图片可选：若 `meta.image` 为 data URL 或 HTTP URL，自动使用；相对路径需手动选图片文件
- 同时支持 Array 格式（`frames` 为数组）

#### 多 Atlas

- 可同时加载多个 atlas，帧 ID 全局唯一
- 可删除 atlas（同时解绑相关 sprite binding）

### 2.7 Sprite 绑定

每根骨骼最多绑定一个精灵（one bone → one sprite slot）。

绑定配置（全局，不随动画变化）：

| 属性 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `frameId` | `string` | — | atlas 帧 ID |
| `anchorX/Y` | `number` | `0.5` | 锚点 0–1 |
| `flipX` | `boolean` | `false` | X 轴镜像（对称骨骼复用同一帧） |

绑定后**自动切换到 Sprite 预览模式**，立即可见效果。

精灵的初始旋转校正和位移偏移存在 **t=0 关键帧**的 `rotation` / `translateX/Y` 中，不在 binding 里——绑定时自动创建 t=0 关键帧。

**游戏侧对接**：游戏引擎读取 `bindings` 字段，按相同规则渲染 sprite（anchorX/Y、flipX 均需在游戏侧实现）。

### 2.8 挂点系统（Attachment Points）

挂点是**非动画**的固定标记，跟随指定骨骼移动。世界坐标 = 父骨骼 tip + offset。

#### 内置挂点

| ID | 默认父骨骼 | 默认 offset | 用途 |
|---|---|---|---|
| `shadow` | `root` | (0, +52) | 脚下地面阴影的中心位置 |
| `hit` | `spine` | (0, -30) | 受击特效播放点（胸部附近） |

#### 挂点属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `parentBone` | `string` | 跟随的骨骼（使用其 tip 坐标） |
| `offsetX/Y` | `number` | 相对骨骼 tip 的偏移（px） |
| `shadowW/H` | `number?` | shadow 专用：椭圆半宽/高；省略则从骨骼 rest pose 自动计算 |

#### Shadow 尺寸默认计算

`Skeleton.computeDefaultShadowSize()` 从 rest pose FK 计算两脚间距 + 骨骼宽度，得出合理椭圆尺寸。用户可在面板中覆盖。

#### 编辑器显示

- shadow → 蓝色半透明椭圆 + 中心点
- hit → 红色准星

#### 游戏侧对接

- shadow：每帧在挂点世界坐标渲染阴影精灵，尺寸使用 `shadowW/H`
- hit：受击时在挂点坐标播放特效

### 2.9 预览模式

| 模式 | 说明 |
|---|---|
| Skeleton（骨架） | 只显示骨骼线框，无需 atlas |
| Sprite（精灵） | 骨骼上渲染绑定的 atlas 精灵 |

`Tab` 键切换；绑定 sprite 后自动切换到 Sprite 模式。

辅助选项：
- Show joints（关节圆圈）
- Onion skin（相邻帧半透明叠加）
- Guide lines（中心垂直参考线）

### 2.10 时间轴

- 每根可动骨骼一行（共 10 行：spine / head / 4 臂 / 4 腿）
- 关键帧菱形，颜色区分属性类型：
  - 灰色：仅旋转
  - 白色：sprite 帧切换
  - 橙色：translateX/Y
  - 蓝色：scale
- 选中时高亮青色
- 左键拖拽菱形改时间
- 拖拽 ruler 或 scrub

### 2.11 Undo / Redo

`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`，上限 100 步。

计入 Undo：骨骼旋转、关键帧增删改、sprite 绑定、挂点编辑。  
不计入：播放控制、预览模式切换、scrub、视图选项。

### 2.12 导出 / 导入

- 导出：`animation.animator.json`（animations + bindings + attachmentPoints）
- 导入：同格式 JSON，合并到当前会话

---

## 3. 导出格式（animation.animator.json）

```jsonc
{
  "version": 1,

  // 全局 sprite 绑定（不随动画变化）
  "bindings": {
    "spine":       { "frameId": "body.png",      "anchorX": 0.5, "anchorY": 0,   "flipX": false },
    "head":        { "frameId": "head.png",       "anchorX": 0.5, "anchorY": 0.5, "flipX": false },
    "r_upper_arm": { "frameId": "arm_upper.png",  "anchorX": 0.5, "anchorY": 0,   "flipX": false },
    "l_upper_arm": { "frameId": "arm_upper.png",  "anchorX": 0.5, "anchorY": 0,   "flipX": true  }
  },

  // 动画片段
  "animations": {
    "walk": {
      "duration": 0.5,
      "loop": true,
      "keyframes": [
        {
          "time": 0.0,
          "bones": {
            "spine":       { "rotation": 5, "translateY": -2 },
            "r_upper_arm": { "rotation": 22, "easing": "ease-in-out" },
            "r_upper_leg": { "rotation": -28 }
          }
        },
        {
          "time": 0.25,
          "bones": {
            "spine":       { "rotation": 5 },
            "r_upper_arm": { "rotation": -18, "easing": "ease-in-out" },
            "r_upper_leg": { "rotation": 22 }
          }
        }
      ]
    }
  },

  // 挂点（跟随骨骼，世界坐标 = parentBone.tip + offset）
  "attachmentPoints": [
    { "id": "shadow", "label": "🔵 Shadow", "parentBone": "root",  "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "label": "✦ Hit",     "parentBone": "spine", "offsetX": 0, "offsetY": -30 }
  ]
}
```

---

## 4. 插值规则（编辑器与游戏侧共用）

```
给定时间 t，找到某骨骼的左侧帧 kf1 和右侧帧 kf2：
  f = applyEasing((t - kf1.time) / (kf2.time - kf1.time), kf1.easing)

  rotation   = lerp(kf1.rotation,   kf2.rotation,   f)
  scaleX     = lerp(kf1.scaleX,     kf2.scaleX,     f)
  scaleY     = lerp(kf1.scaleY,     kf2.scaleY,     f)
  translateX = lerp(kf1.translateX, kf2.translateX, f)
  translateY = lerp(kf1.translateY, kf2.translateY, f)
  alpha      = lerp(kf1.alpha,      kf2.alpha,      f)
  frameId    = kf1.frameId   （step 语义：到达 kf2 时间才切换）
```

t 在第一帧之前 → 使用第一帧；在最后帧之后 → 使用最后帧。

源文件：`src/animation/interpolate.ts`（无外部依赖，可直接复制到游戏引擎）。

---

## 5. 游戏侧对接规格

### 5.1 共享代码策略

计划将 `interpolate.ts` 和相关类型移至 monorepo 共享目录，两侧都从同一文件编译：

```
funny/
├── shared/
│   ├── animation/interpolate.ts   ← 唯一来源
│   └── types.ts                   ← 共享类型子集
├── tools/animator/                tsconfig paths: @shared → ../../shared
└── code/                          tsconfig paths: @shared → ../shared
```

> **当前状态**：game 侧尚无动画代码，共享目录结构待实现（见 §8.1）。

### 5.2 游戏侧 Runtime 需实现

```ts
class StickmanRuntime {
  async load(animDataUrl: string, atlasJsonUrl: string, atlasImageUrl: string): Promise<void>

  play(clipName: string, opts?: { loop?: boolean; onComplete?: () => void }): void
  pause(): void
  stop(): void
  setSpeed(v: number): void

  // 每帧更新（在游戏主循环中调用）
  update(dt: number): void

  destroy(): void
}
```

内部逻辑：`sampleClip(clip, t)` → 对每根骨骼：
1. 设置 `PIXI.Container.rotation`（骨骼旋转）
2. 设置 sprite `scale / position / alpha`
3. 若 `frameId` 变化，更新 `PIXI.Sprite.texture`

### 5.3 挂点游戏侧使用方式

每帧从 runtime 获取挂点世界坐标：

```ts
const shadowPos = runtime.getAttachmentPoint('shadow');
// shadowPos = { x: worldX, y: worldY, w?: halfWidth, h?: halfHeight }

// shadow：在 shadowPos 渲染椭圆阴影精灵
// hit：受击时在 hitPos 播放特效 particle
```

---

## 6. 界面布局

```
┌─────────────────────────────────────────────────────────┐
│  Toolbar（播放控制 / Duration Auto / Undo / 预览模式）   │
├──────────┬────────────────────┬────────┬────────────────┤
│ 动画列表 │     Canvas          │ 骨骼   │  Atlas         │
│          │                    │ 属性   │  面板          │
│          │   骨架 / 精灵预览   │ ────── │                │
│ 播放控制 │   + 挂点标记        │ View   │                │
│ 时间显示 │                    │ ────── │                │
│          │                    │ 挂点   │                │
├──────────┴────────────────────┴────────┴────────────────┤
│  Timeline（ruler + 骨骼行 + 菱形 + 播放头）              │
├─────────────────────────────────────────────────────────┤
│  Bottom Bar（导出 / 导入 / Reset Pose / 状态栏）         │
└─────────────────────────────────────────────────────────┘
```

---

## 7. 预设动画

| 名称 | 时长 | Loop |
|---|---|---|
| idle | 1.5s | ✓ |
| walk | 0.5s | ✓ |
| attack | 0.6s | ✗ |
| hurt | 0.4s | ✗ |
| death | 0.8s | ✗ |
| spawn | 0.35s | ✗ |

---

## 8. 待实现 / 待确认

### 8.1 共享代码策略（已决策：两份独立代码）
- `interpolate.ts` 逻辑稳定，改动频率极低
- 编辑器和游戏侧各维护一份，不引入共享目录
- 若日后出现行为差异，再考虑 path alias 方案

### 8.2 游戏侧 Runtime（待实现）
- `StickmanRuntime` 类，实现 `load / play / pause / update`
- `getAttachmentPoint(id)` 返回当前帧挂点世界坐标

### 8.3 游戏侧 Sprite Binding 渲染（待实现）
- 读取 `bindings` 字段，按 anchorX/Y、flipX 渲染 sprite
- 支持关键帧 `frameId` 运行时切换贴图

---

## 9. 不在范围内

- IK / 骨骼权重 / 蒙皮
- 多角色支持
- 音效时间轴
- Spine 格式导出
- 曲线编辑器（贝塞尔可视化）
- 网格变形
