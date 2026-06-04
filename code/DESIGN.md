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
│   ├── UnitView.ts        单位精灵池 + HP 条
│   ├── BuildingView.ts    建筑精灵池
│   ├── HandView.ts        手牌 UI
│   ├── HUDView.ts         HUD（资源 / 暂停）
│   └── VFXSystem.ts       程序特效系统（见 §5）
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
      → unitView.sync(board)
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

## 6. 建筑视觉效果

建筑不使用骨骼动画，只用补间：

| 事件 | 效果 |
|---|---|
| 放置 | scale 0→1，duration 0.3s，ease-out（待实现） |
| 受击 | `BuildingView.playDestroyEffect` 现有旋转+淡出 |
| 摧毁 | `death_building` VFX（已实现） |

---

## 7. 待实现

| 功能 | 位置 | 说明 |
|---|---|---|
| 建筑 spawn 动画 | BuildingView | scale 0→1 弹出 |
| 骨骼角色动画 | 新建 StickmanRuntime | 读取 animator 导出 JSON |
| 阴影渲染 | UnitView / StickmanRuntime | 使用挂点 shadow 坐标 |
| 受击特效位置 | StickmanRuntime | 使用挂点 hit 坐标 |
