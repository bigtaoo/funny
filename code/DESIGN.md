# Notebook Wars — Game Technical Design

> 版本 v0.1 · 2026-06

---

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 渲染 | `pixi.js-legacy`（兼容微信小游戏 WebGL 环境） |
| 游戏逻辑 | 纯 TypeScript，固定点数（`math/fixed.ts`），与渲染完全解耦 |
| 输入 | `InputManager` + 平台适配器（Web / WeChat），手动 hit-test |
| 平台 | Web（开发）/ 微信小游戏（发布）/ CrazyGames（发布） |
| 构建 | Webpack，多入口（`web.ts` / `wechat.ts` / `crazygames.ts`） |

---

## 2. 目录结构

```
src/
├── game/                  游戏逻辑（纯 TS，无 PIXI 依赖）
│   ├── math/              fixed.ts（定点数）、prng.ts
│   ├── systems/           MovementSystem, CombatSystem, AISystem,
│   │                      ResourceSystem, BuildingProductionSystem, SpellSystem
│   ├── GameEngine.ts      主循环入口
│   ├── GameState.ts       全量可序列化状态
│   ├── Board.ts           单位/建筑空间查询
│   ├── Unit.ts / Building.ts / Card.ts / Player.ts
│   ├── types.ts           所有共享枚举/接口/事件类型
│   └── config.ts          平衡数值常量
│
├── render/                渲染层（PIXI.js）
│   ├── GameRenderer.ts    顶层渲染协调器 + 输入处理
│   ├── BoardView.ts       棋盘网格 + 高亮层 + 陨石特效
│   ├── UnitView.ts        单位精灵池 + HP 条（Swordsman 用 StickmanRuntime）
│   ├── BuildingView.ts    建筑精灵池
│   ├── HandView.ts        手牌 UI
│   ├── HUDView.ts         HUD（资源 / 暂停）
│   ├── VFXSystem.ts       程序特效系统（见 §5）
│   └── stickman/          骨骼动画 Runtime（见 §8）
│       ├── types.ts        共享类型（BoneDef / BoneKeyframe / SpriteBinding 等）
│       ├── interpolate.ts  sampleClip 插值（与 animator 共享逻辑）
│       ├── skeleton.ts     Skeleton.computeFK（FK 正向运动学）
│       └── StickmanRuntime.ts  加载 .tao / 驱动 PIXI Sprite / shadow 处理
│
├── layout/                响应式布局
│   ├── ILayout.ts         坐标转换接口
│   ├── PortraitLayout.ts  竖屏
│   ├── LandscapeLayout.ts 横屏
│   └── ScalingManager.ts  屏幕缩放
│
├── inputSystem/           输入抽象
├── assetsManager/         资源加载（Web / WeChat 适配）
├── platform/              平台抽象（IPlatform）
├── scenes/                SceneManager / GameScene / LobbyScene / ResultScene
└── app.ts                 应用入口
```

---

## 3. 游戏循环

```
SceneManager.tick(dt)             ← PIXI ticker，dt = ms/1000
  → GameScene.update(dt)
    → GameRenderer.update(dt)
      → engine.tick(dt)           ← 游戏逻辑（固定步长内部累积）
      → for event in state.events → handleEvent(event, state)
      → vfxSystem.update(dt)      ← 特效推进
      → unitView.sync(board, dt)   ← dt 用于推进骨骼动画时钟
      → buildingView.sync(board)
      → handView.sync(player)
      → hudView.sync(state)
```

游戏逻辑与渲染解耦：`engine.tick()` 内部用固定点数推进物理，输出 `GameEvent[]`；渲染层消费事件驱动视觉反馈。

---

## 4. 坐标系

- **设计空间**（design space）：逻辑分辨率，布局和输入统一用这套坐标
- **棋盘坐标**：`(col, row)`，整数格子；`(colExact, rowExact)` 为 float，移动中连续变化
- **固定点数**：`y_fp: Fp = row × 1000`（`FP_SCALE = 1000`），游戏逻辑内部使用，渲染层用 `fromFp()` 转换

坐标转换链：`grid(col, rowExact)` → `boardView.gridToScreen()` → `ILayout.gridToScreen()` → design-space px

---

## 5. VFX 系统（VFXSystem）

### 设计原则

- **纯程序绘制**，不依赖任何外部图片资源，符合 notebook ink 美术风格
- 资源占位：上线后可将同名效果替换为序列帧实现，`GameRenderer` 调用接口不变
- 内置 `PIXI.Graphics` 对象池，避免 GC 压力

### 接口

```ts
vfxSystem.play(effectId, worldX, worldY, color?);
vfxSystem.update(dt);   // dt in seconds, call each frame
vfxSystem.destroy();
```

### 内置效果

| effectId | 时长 | 触发事件 | 描述 |
|---|---|---|---|
| `hit` | 0.25s | `unit_attack_hit` | 白色扩散环 + 6 条冲击线 |
| `death_unit` | 0.45s | `unit_died` | 8 条放射线扩散 + 中心点消失 |
| `death_building` | 0.55s | `building_destroyed` | 大号爆炸环 + 12 条线 + 4 个碎片 |
| `spawn` | 0.3s | （可选） | 内聚环 + 4 条内向线 |

### 渲染层级

```
boardView.container      ← 棋盘网格
unitView.container       ← 单位
buildingView.container   ← 建筑
vfxSystem.container      ← 特效（单位/建筑上方）
handView.container       ← 手牌
hudView.container        ← HUD（最顶层）
```

### 后续扩展

- 新增效果：在 `VFXSystem.ts` 的 `EFFECTS` 对象里添加新 `EffectDef` 即可
- 替换为序列帧：创建新类实现相同 `play/update/destroy` 接口，在 `GameRenderer` 中替换实例

---

## 6. 建筑

### 视觉效果

建筑不使用骨骼动画，只用补间：

| 事件 | 效果 |
|---|---|
| 放置 | scale 0→1，duration 0.3s，ease-out cubic（`BuildingView.acquireSprite`） |
| 受击 | `BuildingView.playDestroyEffect` 旋转+淡出 |
| 摧毁 | `death_building` VFX |

建筑精灵资源（`src/assets/`）：

| 建筑类型 | 文件 |
|---|---|
| `Barracks`（兵营） | `game_infantry_barracks.png` |
| `ArrowTower`（箭塔） | `game_archer_barracks.png` |
| 基地（双方） | `game_base.png`，敌方按朝向镜像（横屏左右翻、竖屏上下翻） |

### 箭塔攻击范围

箭塔对 **`attackRange`（当前=2）格 Chebyshev 距离**内的所有敌方单位全向攻击，不区分方向：

- 按距离环由近到远查找目标，优先打最近的敌人
- 覆盖正面纵向、侧面横向（含 Crossing 状态单位）、斜向，统一处理
- 实现位置：`CombatSystem.findTargetForBuilding`

---

## 7. 待实现

| 功能 | 位置 | 说明 |
|---|---|---|
| Guardian / Archer 骨骼动画 | UnitView + 对应 .tao | 目前仍用占位圆形 |
| 受击特效位置 | StickmanRuntime | 使用挂点 hit 坐标 |

---

## 8. 骨骼动画 Runtime（StickmanRuntime）

### 文件位置

`src/render/stickman/`

### 加载流程

```
StickmanRuntime.loadAsset(url)       ← 静态方法，结果按 URL 缓存
  → fetch(url) → ArrayBuffer
  → JSZip.loadAsync()
  → 解析 animation.json（clips / bindings / boneLengthScales / attachmentPoints）
  → 解析 spritesheet.json + spritesheet.png → Map<boneId, PIXI.Texture>
  → 返回 TaoAsset（共享，所有单位实例共用同一套纹理）
```

### 每帧渲染流程

```
runtime.syncState(unit.state)        ← 映射 UnitState → 动画片段名
runtime.update(dt)
  → time += dt（looping / clamped）
  → sampleClip(clip, time) → Map<boneId, ResolvedBoneTransform>
  → Skeleton.computeFK(0, 0, transforms, boneLengthScales) → WorldPositions
  → 骨骼 sprite：sprite.x/y/rotation/scale = bone_pivot + kf + binding
  → shadow sprite：_applyShadowPose()（见下）
```

### Shadow 渲染（`_applyShadowPose`）

shadow 是 `AttachmentPoint`，不在 `bindings` 中，需专项处理：

```
position  = parentBone.tip (ex, ey) + (offsetX, offsetY)
scaleX    = (shadowW * 2) / tex.width
scaleY    = (shadowH * 2) / tex.height
rotation  = 0，anchor = (0.5, 0.5)，zOrder = -Infinity（始终最底层）
```

`shadowW`/`shadowH` 来自 `.tao` 的 `attachmentPoints[shadow]` 字段。

### UnitView 集成

- Swordsman 单位：若 `infantryAsset` 已加载，`acquireSprite` 创建 stickman 容器；否则退回占位圆形
- 敌方（`Side.Top`）：`mirrorX: true`，`scaleX *= -1`
- `sync(board, dt)` 中对每个有 runtime 的单位调用 `runtime.syncState` + `runtime.update(dt)`
- 单位死亡时 `runtime.play('death')` 后在淡出动画结束时 `runtime.destroy()`

### 资源文件

| 文件 | 说明 |
|---|---|
| `src/assets/infantry.tao` | Swordsman 骨骼动画包（ZIP）|
| webpack：`/\.(tao)$/i` → `asset/resource` | .tao 按二进制资源处理，emit 后由 fetch 加载 |
