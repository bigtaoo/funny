# Stickman Animation Editor — Requirements

> 版本 v0.3 · 2026-06

---

## 1. 背景与目标

### 为什么需要这个工具

Notebook Wars 使用程序化骨骼角色（stickman）作为战斗单位，由 11 根骨骼组成，通过关键帧动画驱动。游戏引擎需要在运行时对动画进行插值播放。

- 没有合适的轻量外部工具（Spine 太重，DragonBones 导出格式不可控）
- 需要完全控制导出格式，游戏引擎直接消费
- 需要能预览 sprite 绑定效果（骨骼 + 贴图）

### 设计原则

1. **轻量**：浏览器工具，本地 DevServer，无服务端
2. **格式自主**：导出 `.tao`（ZIP）格式由自己定义，游戏引擎直接读取
3. **可迭代**：骨骼定义和 UI 在代码里，改起来快
4. **够用即可**：不追求 Spine 级功能，只做游戏实际需要的
5. **编辑器 = 游戏**：编辑器与游戏引擎共用同一套插值代码（`interpolate.ts`），预览效果 = 运行效果，零格式差异

---

## 2. 典型工作流

```
1. 打开工具（npm run start，port 9091）
2. [蒙皮阶段] 导入骨骼图片 → 切换到 Skin 模式
              → 在静息姿下逐骨骼调整 Binding（anchor / offset / rotation / scale）
3. [动画阶段] 切换到 Animate 模式 → 选择或新建动画片段（如 "walk"）
              → 拖动骨骼调整姿态 → K 键打关键帧 → 播放预览 → 反复调整
4. 保存 .tao.editor（保留图片 + 编辑状态，下次继续编辑）
5. 导出 .tao（游戏引擎读取）
```

---

## 3. 功能规格

### 3.1 编辑器模式

编辑器分两个**互斥**模式，工具栏切换或快捷键 `S`：

| 模式 | 按钮 | 说明 |
|---|---|---|
| 🎨 **Skin（蒙皮）** | 🎨 Skin | 骨架固定在**静息姿**；只能调整 Sprite Binding 参数；骨骼拖拽禁用 |
| 🎬 **Animate（动画）** | 🎬 Animate | 正常播放与关键帧编辑；Binding 参数只读显示摘要 |

**设计意图**：Binding 参数（图片 anchor / offset / 旋转修正）应在固定姿态下一次设定，与动画关键帧完全解耦，互不干扰。

### 3.2 骨骼系统

- **固定 11 根骨骼**（修改需改代码，无运行时增删）
  - `root`（髋部，FK 锚点，不可选）
  - `spine`、`head`
  - `r/l_upper_arm`、`r/l_lower_arm`（共 4 根）
  - `r/l_upper_leg`、`r/l_lower_leg`（共 4 根）
- **选择**：点击高亮，右侧面板显示属性（两种模式下均可选骨骼）
- **旋转**：左键拖拽（**仅 Animate 模式**；Skin 模式下骨骼拖拽禁用）
- **Pan**：右键拖拽画布

#### 静息姿（Rest Pose）约定

骨骼 `rwa`（rest world angle）按**角色朝右**设定（画布 Y 轴向下，0°=右，90°=下）：

| 骨骼 | rwa | 屏幕方向 | 说明 |
|---|---|---|---|
| spine | −90° | 朝上 | |
| head | −90° | 朝上 | |
| r_upper_arm | 180° | 朝左 | 角色右臂 = 屏幕左 |
| r_lower_arm | 195° | 朝左略偏下 | 自然肘弯 |
| l_upper_arm | 0° | 朝右 | 角色左臂 = 屏幕右 |
| l_lower_arm | −15° | 朝右略偏上 | 对称肘弯 |
| r_upper_leg | 120° | 朝左下 30° | 角色右腿 = 屏幕左 |
| r_lower_leg | 130° | 续左下 | 膝盖微外展 |
| l_upper_leg | 60° | 朝右下 30° | 角色左腿 = 屏幕右 |
| l_lower_leg | 50° | 续右下 | 膝盖微外展 |

### 3.3 动画片段（Clip）管理

| 操作 | 入口 |
|---|---|
| 新建 | 左侧 "+ New" |
| 重命名 | "✎" 按钮 |
| 删除 | "🗑" 按钮 + 确认 |
| 切换 | 点击列表项（自动同步 Duration / Loop 输入框） |
| 加载预设 | 底部 "📋 Preset…"（idle / walk / attack / hurt / death / spawn） |

### 3.4 关键帧系统

关键帧是**稀疏的**：只记录有变化的骨骼；其余骨骼从相邻帧插值；不同属性各自独立插值。

#### 关键帧属性（per bone, per keyframe）

| 属性 | 类型 | 缺省值 | 说明 |
|---|---|---|---|
| `rotation` | `number` | `0` | 相对 rest pose 的旋转 delta（度） |
| `scaleX/Y` | `number` | `1` | 骨骼缩放（与 binding.scaleX/Y 相乘） |
| `translateX/Y` | `number` | `0` | 骨骼 pivot 位移（px），图片跟随 |
| `alpha` | `number` | `1` | 透明度 0–1（0 = 隐藏骨骼精灵） |
| `easing` | `EasingType` | `'linear'` | 出口插值曲线 |

#### Easing 类型

| 类型 | 描述 |
|---|---|
| `linear` | 匀速（默认） |
| `ease-in` | 慢入快出 |
| `ease-out` | 快入慢出 |
| `ease-in-out` | 慢入慢出 |
| `step` | 瞬间跳变 |

#### 关键帧操作

| 操作 | 快捷键 / 入口 |
|---|---|
| 添加（当前时间 + 当前姿态） | `K` / 工具栏 "+ Keyframe" |
| 删除 | `Delete` / `Backspace` |
| 跳转前/后关键帧 | "⏮" / "⏭" 按钮 |
| 拖动改时间 | 时间轴菱形左键拖拽 |
| 设置 easing | 时间轴右键菜单 |
| 复制 / 粘贴 | 时间轴右键菜单 |

### 3.5 时长管理

- **手动**：工具栏 Duration 数字输入框
- **自动**：点 "Auto" 按钮，设为最后一个关键帧时间
- 切换 clip 时 Duration / Loop 自动同步

### 3.6 播放控制

| 控制 | 入口 |
|---|---|
| 播放/暂停 | `Space` / "▶ Play" |
| 停止（回 0） | "⏹ Stop" |
| 速度 | 0.25× / 0.5× / 1× / 2× |
| 循环 | Loop 复选框 |

### 3.7 图片导入

每根骨骼一张独立 PNG，另加一张阴影精灵，共 **11 张**。

#### 导入方式

- 拖入或点选多张 PNG 文件
- **自动映射**：按文件名识别骨骼（`spine.png` → `spine`，`shadow.png` → shadow 挂点图）
- **手动映射**：在 Image 面板中为每个 bone slot 重新选择文件
- **加载任意一张图片即自动切换到 Sprite 预览模式**

#### 文件名约定

| 文件名 | 对应骨骼 |
|---|---|
| `spine.png` | spine |
| `head.png` | head |
| `r_upper_arm.png` / `l_upper_arm.png` | r/l_upper_arm |
| `r_lower_arm.png` / `l_lower_arm.png` | r/l_lower_arm |
| `r_upper_leg.png` / `l_upper_leg.png` | r/l_upper_leg |
| `r_lower_leg.png` / `l_lower_leg.png` | r/l_lower_leg |
| `shadow.png` | shadow 挂点精灵 |

不符合约定的文件名需在面板中手动指定骨骼。

### 3.8 Sprite 绑定（SpriteBinding）

每根骨骼固定绑定一张图片（1 bone : 1 image，无多帧切换）。绑定配置为**静态**，不随动画变化。在 **Skin 模式**下编辑；Animate 模式下只读。

#### Binding 属性

| 属性 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `anchorX/Y` | `number` | `0.5` | 锚点 0–1（图片内对齐骨骼 pivot 的位置） |
| `offsetX/Y` | `number` | `0` | 世界空间像素偏移，叠加在骨骼 pivot 上（整体平移图片） |
| `rotation` | `number` | `0` | 静态旋转修正（度），叠加在动画旋转上（修正图片朝向） |
| `scaleX/Y` | `number` | `1` | 静态缩放修正，与动画 scaleX/Y 相乘（匹配骨骼长度） |
| `flipX` | `boolean` | `false` | X 轴镜像（对称骨骼复用同一图） |
| `zOrder` | `number` | 见下表 | 渲染层级，值越大越靠前 |

**渲染合成公式：**
```
sprite.rotation = bone_FK_angle + keyframe.rotation + binding.rotation
sprite.x        = bone_pivot.x  + keyframe.translateX + binding.offsetX
sprite.scale    = keyframe.scaleX × binding.scaleX
```

#### 层级顺序（zOrder）

推荐默认层级（从后到前）：

| 骨骼 | 默认 zOrder |
|---|---|
| r_lower_leg | 0 |
| r_upper_leg | 1 |
| l_lower_leg | 2 |
| l_upper_leg | 3 |
| r_lower_arm | 4 |
| r_upper_arm | 5 |
| spine | 6 |
| head | 7 |
| l_lower_arm | 8 |
| l_upper_arm | 9 |

`shadow` 不参与 spriteLayer 排序，层级固定在所有骨骼精灵之下。

### 3.9 骨骼长度（Rig 设置）

每个角色可单独设置每根骨骼的视觉长度，让骨骼与美术图片比例对齐，方便动画调整。

- **Inspector**：选中骨骼后（root / head 除外）顶部显示 **Length (px)** 输入框，输入实际像素值
- **内部存储**：`boneLengthScales: Map<boneId, number>`（稀疏，1.0 不存储）
- **生效范围**：FK 计算、hit-test、渲染；与关键帧动画数据完全独立
- **序列化**：写入 `.tao.editor` 和 `.tao`；游戏运行时读取 `boneLengthScales` 还原骨骼比例

### 3.10 挂点系统（Attachment Points）

挂点是**非动画**的固定标记，跟随指定骨骼移动。世界坐标 = 父骨骼 tip + offset。

#### 内置挂点

| ID | 默认父骨骼 | 默认 offset | 用途 |
|---|---|---|---|
| `shadow` | `root` | (0, +52) | 脚下地面阴影的中心位置 |
| `hit` | `spine` | (0, −30) | 受击特效播放点（胸部附近） |

#### 挂点属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `parentBone` | `string` | 跟随的骨骼（使用其 tip 坐标） |
| `offsetX/Y` | `number` | 相对骨骼 tip 的偏移（px） |
| `shadowW/H` | `number?` | shadow 专用：椭圆半宽/高；省略则从骨骼 rest pose 自动计算 |

#### 编辑器显示

- shadow → 蓝色半透明椭圆 + 中心点
- hit → 红色准星

#### 游戏侧对接

- shadow：每帧在挂点世界坐标渲染阴影精灵，尺寸使用 `shadowW/H`
- hit：受击时在挂点坐标播放特效

### 3.11 预览模式

| 模式 | 说明 |
|---|---|
| Skeleton（骨架） | 只显示骨骼线框，无需图片 |
| Sprite（精灵） | 骨骼上渲染绑定的精灵 |

`Tab` 键切换；加载任意一张图片后自动切换到 Sprite 模式。

辅助选项：
- Show joints（关节圆圈）
- Onion skin（相邻帧半透明叠加）
- Guide lines（中心垂直参考线）
- Bones overlay（Sprite 模式下叠加显示骨骼线框，快捷按钮 🦴 Bones）

### 3.12 时间轴

- 每根可动骨骼一行（共 10 行：spine / head / 4 臂 / 4 腿）
- 关键帧菱形，颜色区分属性类型：
  - 灰色：仅旋转
  - 橙色：translateX/Y
  - 蓝色：scale
- 选中时高亮青色
- 左键拖拽菱形改时间
- 拖拽 ruler 或 scrub

### 3.13 Undo / Redo

`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`，上限 100 步。

计入 Undo：骨骼旋转、关键帧增删改、sprite 绑定修改（含 zOrder）、挂点编辑。  
不计入：播放控制、预览模式切换、scrub、视图选项、编辑器模式切换。

### 3.14 导出 / 导入

| 操作 | 文件 | 说明 |
|---|---|---|
| Export .tao | `.tao` | 游戏引擎用：动画 JSON + spritesheet；File System Access API 保存 |
| Save .tao.editor | `.tao.editor` | 编辑器存档：保留原始图片 + 完整编辑状态；随时加载继续编辑 |
| Import .tao | `.tao` | 恢复游戏导出包（从 spritesheet 抠图还原各骨骼 Blob） |
| Load .tao.editor | `.tao.editor` | 恢复完整编辑会话（图片 + 动画 + 绑定 + 骨骼长度） |

---

## 4. 导出格式（.tao 文件）

`.tao` 是 ZIP 压缩包，内含三个文件：

### 4.1 animation.json（version 2）

```jsonc
{
  "version": 2,
  "bindings": {
    "spine": {
      "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6,
      "offsetX": 0, "offsetY": 0, "rotation": 0, "scaleX": 1, "scaleY": 1
    }
  },
  "boneLengthScales": { "spine": 1.4, "r_upper_arm": 0.9 },
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
        }
      ]
    }
  },
  "attachmentPoints": [
    { "id": "shadow", "parentBone": "root",  "offsetX": 0, "offsetY": 52 },
    { "id": "hit",    "parentBone": "spine", "offsetX": 0, "offsetY": -30 }
  ]
}
```

`boneLengthScales` 为稀疏对象，只记录非 1.0 的骨骼；缺省或缺键均视为 1.0。

### 4.2 spritesheet.json（TexturePacker Hash 兼容）

```jsonc
{
  "frames": {
    "spine":  { "frame": { "x": 0,  "y": 0, "w": 20, "h": 60 }, "sourceSize": { "w": 20, "h": 60 } },
    "shadow": { "frame": { "x": 22, "y": 0, "w": 64, "h": 20 }, "sourceSize": { "w": 64, "h": 20 } }
  },
  "meta": { "size": { "w": 256, "h": 128 } }
}
```

`frames` 的 key 即 boneId（或 `"shadow"`），与 `animation.json` 的 `bindings` 键对应。

### 4.3 spritesheet.png

Shelf bin-packing 合并图集，canvas.toBlob PNG，JSZip DEFLATE 二次压缩。

---

## 5. 编辑器存档格式（.tao.editor 文件）

`.tao.editor` 是 ZIP 压缩包，**保存完整编辑状态**，可随时加载继续编辑：

- `editor.json`（version 1）：动画 + 绑定 + 挂点 + boneLengthScales + 编辑器状态（当前 clip、预览模式）
- `images/spine.png`、`images/head.png` … 各骨骼原始 PNG（无损，不合并 spritesheet）

```jsonc
// editor.json v1
{
  "version": 1,
  "selectedClip": "walk",
  "previewMode": "sprite",
  "bindings": { ... },
  "animations": { ... },
  "attachmentPoints": [...],
  "boneLengthScales": { "spine": 1.4 }
}
```

保存通过 File System Access API（`window.showSaveFilePicker`）弹出原生保存对话框；浏览器不支持时退回 `<a download>`。

---

## 6. 插值规则（编辑器与游戏侧共用）

```
给定时间 t，找到某骨骼的左侧帧 kf1 和右侧帧 kf2：
  f = applyEasing((t - kf1.time) / (kf2.time - kf1.time), kf1.easing)
  rotation   = lerp(kf1.rotation,   kf2.rotation,   f)
  scaleX     = lerp(kf1.scaleX,     kf2.scaleX,     f)
  translateX = lerp(kf1.translateX, kf2.translateX, f)
  alpha      = lerp(kf1.alpha,      kf2.alpha,      f)
```

骨骼隐藏通过 `alpha: 0` 关键帧实现（无 frameId 帧切换）。  
t 在第一帧之前 → 使用第一帧；在最后帧之后 → 使用最后帧。  
源文件：`src/animation/interpolate.ts`（无外部依赖，可直接复制到游戏引擎）。

---

## 7. 游戏侧对接规格

### 7.1 共享代码策略

两份独立代码，不引入共享目录（`interpolate.ts` 逻辑稳定，改动频率极低）。游戏侧直接复制该文件和必要 types。

### 7.2 游戏侧 Runtime（待实现）

```ts
class StickmanRuntime {
  async load(taoUrl: string): Promise<void>
  play(clipName: string, opts?: { loop?: boolean; onComplete?: () => void }): void
  pause(): void
  stop(): void
  setSpeed(v: number): void
  update(dt: number): void  // 每帧在游戏主循环中调用
  getAttachmentPoint(id: string): { x: number; y: number; w?: number; h?: number }
  destroy(): void
}
```

### 7.3 渲染注意事项

- 加载完成后按 `boneLengthScales` 还原骨骼比例，传入 FK 计算
- 按 `animation.json` 的 `zOrder` 对 sprites 排序一次，渲染期间不再重排
- shadow 在挂点世界坐标独立渲染，层级固定在所有骨骼精灵之下

---

## 8. 界面布局

```
┌──────────────────────────────────────────────────────────────┐
│  Toolbar（🎨Skin/🎬Animate · 🦴Skeleton/🖼Sprite · 播放控制  │
│           Duration · Auto · Undo/Redo · 🦴Bones）            │
├──────────┬─────────────────────┬────────┬────────────────────┤
│ 动画列表 │      Canvas          │ 骨骼   │  Image             │
│          │                     │ 属性   │  面板              │
│          │  骨架 / 精灵预览    │ ────── │                    │
│ 播放控制 │  + 挂点标记         │ View   │                    │
│ 时间显示 │                     │ ────── │                    │
│          │                     │ 挂点   │                    │
├──────────┴─────────────────────┴────────┴────────────────────┤
│  Timeline（ruler + 骨骼行 + 菱形关键帧 + 播放头）             │
├──────────────────────────────────────────────────────────────┤
│  Bottom Bar（导出 / 导入 / Reset Pose / 状态栏）              │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. 预设动画

| 名称 | 时长 | Loop |
|---|---|---|
| idle | 1.5s | ✓ |
| walk | 0.5s | ✓ |
| attack | 0.6s | ✗ |
| hurt | 0.4s | ✗ |
| death | 0.8s | ✗ |
| spawn | 0.35s | ✗ |

---

## 10. 待实现

- **游戏侧 Runtime**：`StickmanRuntime` 类（load / play / pause / update / getAttachmentPoint）
- **共享代码**：`interpolate.ts` + 必要 types 复制到游戏侧

---

## 11. 不在范围内

- IK / 骨骼权重 / 网格蒙皮
- 多角色骨架支持
- 音效时间轴
- Spine 格式导出
- 曲线编辑器（贝塞尔可视化）
- 网格变形
- 在线协作
