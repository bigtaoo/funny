# Notebook Wars — Game Technical Design

> 版本 v0.1 · 2026-06

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `DESIGN.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Notebook Wars — Game Technical Design | **本文** |
| §8 待实现、§9 StickmanRuntime、§10 i18n、§11 IntroScene、§12 Vitest、§13 AISystem | [`DESIGN_SUBSYSTEMS.md`](DESIGN_SUBSYSTEMS.md) |

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 渲染 | `pixi.js-legacy`（兼容微信小游戏 WebGL 环境） |
| 游戏逻辑 | 纯 TypeScript，固定点数（`math/fixed.ts`），与渲染完全解耦 |
| 输入 | `InputManager` + 平台适配器（Web / WeChat），手动 hit-test；卡牌支持拖拽与 tap-select 双模式 |
| 平台 | Web（开发）/ 微信小游戏（发布）/ CrazyGames（发布） |
| 构建 | Webpack，多入口（`web.ts` / `wechat.ts` / `crazygames.ts`） |
| 多语言 | `i18n/`，`zh`/`en`/`de`，键唯一来源 + 编译强制全翻，平台声明支持集合（见 §10） |

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
│   ├── UnitView.ts        单位精灵池 + HP 条（Infantry 用 StickmanRuntime）
│   ├── BuildingView.ts    建筑精灵池
│   ├── HandView.ts        手牌 UI
│   ├── HUDView.ts         HUD（资源 / 暂停）
│   ├── VFXSystem.ts       程序特效系统（见 §5）
│   └── stickman/          骨骼动画 Runtime（见 §9）
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
├── cache/                 ObjectPool（精灵对象池，BoardView / UnitView / BuildingView / HandView 复用）
├── platform/              平台抽象（IPlatform，含 getLanguage / supportedLocales）
├── i18n/                  多语言（见 §10）
│   ├── index.ts           t() 取词 + 插值 + initI18n/setLocale/...
│   └── locales/           zh.ts（键唯一来源）/ en.ts / de.ts
├── scenes/                SceneManager / IntroScene / GameScene / LobbyScene / ResultScene
└── app.ts                 应用入口
```

---

## 3. 游戏循环

```
SceneManager.tick(dt)             ← PIXI ticker，dt = ms/1000
  → GameScene.update(dt)
    → GameRenderer.update(dt)
      → engine.tick(dt)           ← 游戏逻辑（固定步长内部累积；`accumulatedTime` 上限 5 tick，锁步停步时回落到 1 tick，避免帧批集中补跑造成的卡顿）
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

### Idle 动画

每帧通过 `BuildingView.update(dt)` 累积时间，`sync()` 内 `updateIdleAnim()` 驱动：

| 类型 | 效果 | 参数 |
|---|---|---|
| 全部建筑 | 精灵垂直 bob（`sprite.y`） | ±1.5px，周期 0.9s，各建筑随机相位偏移 |
| 兵营 | 旗帜波动（`flagGfx` Graphics） | 旗杆 + 3 条 quadratic bezier 波浪线，频率 ~1.4Hz |
| 箭塔 | 精灵微旋转（`sprite.angle`） | ±0.5°，周期 ~1.3s |

### 基地动画

由 `BoardView.update(dt)` 驱动：

| 效果 | 参数 |
|---|---|
| Alpha 脉冲（"呼吸"） | 0.65–1.0，周期 4s；双方基地相位差 1.2 rad |
| 受击裂缝 | `base_hp_changed` 事件触发 `playBaseCrackEffect()`；HP > 85% 不显示；每次受击追加 1–2 条随机折线（3 段，铅笔灰 `#333`，`alpha 0.65`）；HP < 40% 每次追加 2 条 |
| 升级瞬间闪光 | `base_upgraded` 事件触发 `playBaseUpgradeEffect()`：金色手绘描边框（`fx.upgrade` `#ffcc00`，`SketchPen` 一次性描边）绕基地占位、0.6s 内向外扩散 1.5×并淡出，同时整个基地容器弹跳一次（sin 曲线峰值 +12%，0.3s 归位）。**注意**：持久的升级贴图（tier）由 `setBaseUpgradeLevel` 每帧从 `player.upgradeLevel` 对账（见下方资源表），此事件仅负责这一次性庆祝闪光——与受击裂缝的分工一致（持久态轮询对账 / 瞬时特效走事件）。指令链路同 `upgrade_base`：引擎 `commands.ts` 升级成功后 `pushEvent({type:'base_upgraded', owner, level})`。因是新增事件、老录像回放会重新推导事件流，不影响确定性，无需 bump `ENGINE_VERSION`。 |

### 基地受击全屏晕影

`base_hp_changed`（owner=0，己方基地）触发全屏边缘红色晕影（`GameRenderer.vignetteGfx`）：

- 12 层边框矩形叠加，宽度 42–140px、alpha 0.009–0.063，模拟由边缘向内的径向渐变
- `vignetteAlpha` 从 1.0 线性衰减，0.55s 内完全淡出
- `vignetteGfx` 挂在 container 最顶层（HUD 之上），`interactiveChildren = false`，不影响任何点击事件

建筑精灵资源（`src/assets/`）：

| 建筑类型 | 文件 |
|---|---|
| `Barracks`（兵营） | `game_infantry_barracks.png` |
| `ArrowTower`（箭塔） | `game_archer_barracks.png` |
| 基地（双方） | `game_base.png`（0 级，L0 预载），敌方按朝向镜像（横屏左右翻、竖屏上下翻）。1/2 级升级贴图打包在 `assets/base_upgrade_atlas.{png,json}`（`base_lv1`=城池 → upgradeLevel 1，`base_lv2`=宫殿 → upgradeLevel 2/最高级），懒加载见 `render/atlas/baseUpgradeAtlasLoader.ts`，源图+打包脚本在 `art/ui/game/pack_base_atlas.js` |

### 箭塔攻击范围

箭塔对 **`attackRange`（当前=2）格 Chebyshev 距离**内的所有敌方单位全向攻击，不区分方向：

- 按距离环由近到远查找目标，优先打最近的敌人
- 覆盖正面纵向、侧面横向（含 Crossing 状态单位）、斜向，统一处理
- 实现位置：`CombatSystem.findTargetForBuilding`

---

## 6b. 投射物系统（弓箭手 / 箭塔）

远程攻击（弓箭手、箭塔）不再瞬时扣血，而是**发射一枚归属引擎状态的投射物**，飞抵目标那一刻才结算伤害。近战（range=1）攻击不变，仍当场结算。

### 触发与配置

- 蓝图显式标记：`UnitBlueprint.projectile` / `BuildingBlueprint.projectile = { speed, kind }`（`server/engine/src/config.ts`，权威数值源）。
  - 当前：弓箭手 / 箭塔均 `{ speed: 14, kind: 'arrow' }`（14 格/秒，≤2 格射程约 0.15s 飞行）。
- 有 `projectile` → 发射投射物；无 → 瞬时命中（旧近战行为）。

### 机制（确定性）

- 投射物存于 `GameState.projectiles[]`（push 序 = 发射序 = 确定性迭代），实体类 `server/engine/src/Projectile.ts`。
- **跟踪制导·必中**：每 tick 用定点数（整数开方 `isqrt`，无浮点）朝目标**当前**位置推进 `speed`；箭速远高于任何单位移速，必然追上。
- **伤害开火瞬间冻结**：暴击（PvP 恒不触发，`combatPrng` 不前进）+ 全部进攻特性（溅射/穿刺/吸血/减速）在发射时快照进载荷 `ProjectilePayload`，落点用同一套 `CombatSystem.resolveAttackHit` 结算——与近战逐字共用，事件顺序不变，故旧近战回放字节一致。
- **真实玩法变化**：射手开火后立即死亡，箭仍在飞并生效；目标在箭落地前死亡/到达/消失 → 箭 **fizzle 消失**（无伤害）；两名射手在箭落地前可同时锁定同一目标 → overkill 浪费。
- 投射物推进在 `CombatSystem.tick` 的两个开火循环之后、清死单位之前——本 tick 发射的箭立即推进一步，箭杀的单位与近战杀的同 tick 清除。

### 事件协议（引擎 → 渲染，沿用 `escort_moved` 范式）

| 事件 | 时机 | 渲染响应 |
|---|---|---|
| `projectile_fired` | 发射 | 在 `from` 生成 arrow 精灵（`GameRenderer.buildProjectileSprite`） |
| `projectile_moved` | 每 tick | 跟随权威坐标 + 按方向旋转 |
| `projectile_hit` | 命中 | 移除箭精灵（命中 VFX 由同 tick 的 `unit_attack_hit` 播 `hit` 效果） |
| `projectile_expired` | fizzle | 移除箭精灵 |

> 渲染层级：arrow 图层在单位之上、VFX 之下（`GameRenderer.projectileLayer`）。

### 围攻 / 回放

- worldsvc 围攻（`siegeEngine.ts` 经 `runHeadless`）跑同一套引擎，自动套用，无需改。
- 远程伤害时序变化使旧回放发散 → **`ENGINE_VERSION` 1→2**（`server/engine/src/types.ts`），版本不符的回放会直接报错而非播放出错结果。

---

## 6c. 单位车道交战与移动钳制

单位沿所在列（车道）单文件推进，`CombatSystem.findTarget` 按 **Chebyshev 距离环由近到远**（`dist = 1…effectiveRange`）查找目标，命中即切 `Attacking`、`MovementSystem` 当 tick 跳过该单位 → 站定攻击。优先级：嘲讽 > 敌方单位 > 护送目标 > 敌方建筑。

### 「近战兵略过可攻击单位」修复（2026-06-27）

**问题**：移动用连续 fp 坐标推进，交战判定用整数格距，两套精度不一致。两名同列对冲的近战兵会各自向相反方向取整 —— 例如 Bottom 在 `y=5.49`（第 5 行）、Top 在 `y=6.51`（第 7 行），连续间距只有 ~1.0 格，**格距却读成 2**，range-1 近战这一 tick 不交战；下一 tick 两者都进到 `y≈6.0` → **同一格（格距 0）**，而 `findTarget` 从 `dist=1` 起扫**永远扫不到距离 0**，于是穿过彼此继续前进（单格 `unitGrid` 还会被进一步写坏）。表现为近战兵略过前面本可攻击的敌人、继续往前走。

**修复**：`MovementSystem.moveForward` 推进前钳制 —— 调用新增的 `Board.getEnemyUnitAhead(unit)`（同列、前方、本单位**能打到的**最近敌军，飞行可达过滤沿用 `findTarget`），把与该敌军的中心间距钳到 **≥ 1 格**。这保证两者始终保持格距 ≥ 1，下一 tick `CombatSystem` 必然交战。

- 钳制只对**非 `Attacking`** 单位生效（`MovementSystem` 开头就 `continue` 跳过 `Attacking` 单位）—— 即正是「战斗系统本 tick 漏判」那一窗口；正常交战完全不受影响。
- 钳到 1 格中心距可证明取整后行距恒为 1（`round(a)` 与 `round(a+1)` 必差 1），故下一 tick `findTarget` 的 `dist=1` 环必然命中，不会卡死。
- 回归测试：`server/engine/src/__tests__/melee_engage.test.ts`（构造取整不利的对冲位置，断言不穿过 + 必交战）。

---

## 7. 卡牌放置交互

`GameRenderer` 支持两种互不冲突的放置方式：

### 拖拽模式（原有）

按下卡牌后移动超过 **8px（`DRAG_THRESHOLD`）** → 自动进入拖拽模式，ghost 跟随指针，松手时放置。

### Tap-select 模式（新增）

按下卡牌后原地松手 → 卡牌进入选中态（上移 `CARD_LIFT = 14px`，棋盘列高亮），再点击棋盘列放置。

| 操作 | 效果 |
|---|---|
| 点击未选中卡牌 | 卡牌上移，列高亮；若已有其他卡牌选中则切换 |
| 再次点击同一张卡牌 | 取消选中 |
| 点击棋盘列 | 放置（与拖拽使用同一 `commitCardPlay` 函数） |
| Meteor 法术 hover | tap-select 态下悬停棋盘实时更新落点预览 |
| 点击升级/设置按钮 | 自动取消选中 |

**状态机关键字段：**

```ts
tapSelect: { handIndex, cardType, spellType? } | null   // tap-select 激活状态
pendingCardDown: { x, y, handIndex } | null             // 按下卡牌后，判定 tap vs drag 的中间状态
```

按下卡牌时先记入 `pendingCardDown`；`handleMove` 检测是否超过阈值，超过则升为拖拽并清除 pending；`handleUp` 中 pending 未转化为拖拽则激活 tap-select。

### 群体伤害法术的受击单位描边预览（2026-08-08）

用户反馈：PvP/PvE 里群体伤害法术（尤其高频使用的 2×2 Meteor）只看得到落点方框，看不出方框里到底会命中哪些单位，经常打偏。修复：`GameRenderer/input.ts` 的 `updatePlacementHighlights` 在算出落点方框（`showMeteorTargetHighlight`/`showColumnTargetHighlight`）的同时，额外算出方框内**实际会被打到**的单位 id 集合，交给 `UnitView.setSpellTargetPreview(unitIds)` 对这些单位描边高亮：

- **判定逻辑与引擎侧伤害判定同源**（避免 UI 预览和实际命中结果不一致）：
  - Meteor（`meteorTargetUnits`）：镜像 `SpellSystem.castMeteor`——只描边 2×2 内的**敌方**单位，己方单位（法术只伤敌方）不描边。
  - Rockslide（`columnTargetUnits`，PvE-only）：镜像 `SpellSystem.castRockslide`——描边整列**双方**单位（该法术无阵营过滤）。
  - BridgeCollapse（PvE-only）：只是封路、不造成伤害，没有"命中单位"概念，不描边。
- **描边实现**：复用 `UnitView` 已有的 hit-flash 描边贴图机制（`StickmanRuntime.setOutlineFlash(color, alpha)`，此前只用于受击闪光），改为悬停/拖拽期间**持续**点亮（不淡出），颜色复用 `fx.meteor`（与落点方框同色，读作同一个信号）。每次 `updatePlacementHighlights` 重算时做 diff（新增点亮、消失的清除），与棋盘方框刷新同一节奏（指针移动 + 10Hz 的 `refreshPlacementHighlights` 兜底刷新）。取消拖拽/取消 tap-select 时一并清空。
- **已知限制**：只有走 `.tao` 骨骼动画的单位（绝大多数正式单位类型）会描边；`.tao` 资源尚未加载完成时的圆点占位单位没有描边贴图，不描边——与既有受击闪光的降级行为一致。
- **回归测试**（两层）：
  - `client/test/ui/gameRendererSpellTargetPreview.ui.ts`——经 `InputManager` 走真实 `handleDown/handleMove/handleUp`，直接断言 `unitView.previewUnitIds`（`setSpellTargetPreview` 内部 diff 用的 id 集合，不依赖 `.tao` 异步加载即可验证）：Meteor 2×2 敌我过滤（含已死亡单位排除）、悬停点位切换时新增/清除、取消拖拽/取消 tap-select 清空、Meteor tap-select 态下悬停实时预览、从 Meteor 切到其它卡牌后残留描边被清空、Rockslide 整列双方描边（含已死亡单位排除）。
  - `client/test/ui/unitViewSpellTargetPreview.ui.ts`——绕过 `.tao` 异步加载（headless 环境里资源必定加载失败），直接向 `UnitView` 私有的 `stickmanRuntimes` 塞入假 runtime（同 `marchTokenAnimation.ui.ts` 手法），断言 `setSpellTargetPreview` 真的调用了 `setOutlineFlash`：点亮用的颜色/新掉出集合的单位被 `setOutlineFlash(null)`、无 runtime 的单位 id 静默跳过不抛错、同一个 Set 引用重复调用是真正的 no-op（10Hz 刷新在未选中法术时高频复用同一个空集合常量）。

### 卡面渲染（`HandView`）

每个卡槽自上而下：类型字符（U/B/S，左上）→ 插画（`art` 精灵）→ 名称（底部居中加粗 13px）→ 费用圆（右下）。

| 卡牌 | 插画资源 |
|---|---|
| 普通兵（Infantry） | `infantry.png` |
| 弓箭兵（Archer） | `archer.png` |
| 盾兵（ShieldBearer） | `shieldbearer.png` |
| 兵营（Barracks） | `game_infantry_barracks.png`（与场上建筑同图） |
| 箭塔（ArrowTower） | `game_archer_barracks.png`（与场上建筑同图） |
| 法术（Haste / Meteor / Rockslide / BridgeCollapse） | `spell_haste.png` / `spell_meteor.png` / `spell_rockslide.png` / `spell_bridge_collapse.png`（2026-08 起真图，见 `render/cardArt.ts` `CARD_ART_URLS`；后两张为 PvE 关卡专属法术） |

- 插画等比缩放居中于类型行与名称行之间，不被费用圆遮挡
- 纹理按 key 懒加载缓存在 `Map`；异步加载完成时清空 `lastSyncKey` 触发重 sync
- 对象池回收时重置 `art`为空纹理并隐藏
- 卡牌名走 i18n：`CardDefinition.nameKey` → `t(card.nameKey)`（见 §10）
- **刷新倒计时进度条**：每张牌底部一条 3px 横条（`bar` Graphics），显示距下次自动刷新的剩余比例（`refreshRemainingTicks / refreshDurationTicks`）。颜色随剩余秒数变化：>10s 绿色 → ≤10s 黄色 → ≤5s 红色；最后 3 秒进度条 alpha 做 sin 波脉冲（0.6–1.0）。卡牌被自动刷新时触发 `card_expired` 事件，`GameRenderer` 调用 `handView.notifyCardExpired(slotIndex)`，令该槽渲染 250ms 白色淡出叠加层（`flash` Graphics）作为刷新反馈。倒计时时长由 `config.CARD_REFRESH_TICKS`（900 ticks = 30 s）控制；发牌时随机错峰 [0, 15 s]（`CARD_REFRESH_INITIAL_OFFSET_MAX`）防止所有槽同时刷新。
- **手动刷新全牌（`refresh_hand` 指令）**：升级按钮旁的「⟳ 刷新」按钮，花费 `HAND_REFRESH_COST=10` 墨水立即重抽全部 6 个卡槽，每槽计时器用 `timerPrng` 随机错峰 [0, 15 s] 重置——与进场发牌完全同款逻辑（`和刚进入时一样`）。引擎侧 `GameEngine.processCommand` 处理 `refresh_hand`：墨水不足则忽略；成功则逐槽 `drawIntoSlot(随机 stagger)` + 发 `resource_changed`（不发 `card_expired`，故无逐槽白闪）。指令链路同 `upgrade_base`：`PlayerCommand` 联合 / `IGameEngine.refreshHand()` / `game.proto` `RefreshHand`（oneof 字段 3）/ `NetInputSource`·`replayUpload`·`judgeRunner`·`serverReplay` 四处 `toProto`/`fromProto` 各加分支。因是旧录像里不存在的新指令，老录像回放不受影响，无需 bump `ENGINE_VERSION`。
- **手牌与 HUD 层级**：`HUDView` 的底部条带背景（`botBg`，全宽 alpha 0.92）拆到独立的 `backgroundContainer`，由 `GameRenderer` 挂在 `handView` **之前**渲染；HUD 前景（金币 / HP / 升级按钮 / 暂停 / 结算遮罩）仍在 `handView` **之后**。层级：`vfx → HUD底栏背景 → 手牌 → HUD前景/遮罩`。否则横屏下底栏背景会盖住中段手牌（仅选中卡牌抬升的顶部冒出上沿）
- **底部动作按钮（升级 / 刷新）布局**：两个按钮放在 `hudBottomRightRect` 内，比顶栏齿轮键（`BTN_W/BTN_H`=88×30）明显加大并按方向自适应——竖屏并排（各 ~160×52），横屏上下叠放（各 ~176×67），尺寸由 `actionBtnW/actionBtnH` 在 `build()` 内按朝向算出。升级键与刷新键均为单击即触发（`GameRenderer.handleDown` 命中 `getUpgradeRect()`/`getRefreshRect()` 直接调 `engine.upgradeBase()`/`engine.refreshHand()`，不再需要拖到己方基地）。两键均按当前墨水余额置灰（`upgradeEnabled` / `refreshEnabled`，`sync()` 每帧更新）。2026-07-12：移除了原先「按下升级键→拖出幻影→松手需落在基地矩形内才生效」的拖拽判定（`startUpgradeDrag`/`UpgradeDragState`/`showBaseUpgradeHighlight`），因为松手判定要求落在基地上，普通点击（原地按下松手）永远落在按钮而非基地，导致点击升级键实际不生效——修复为按下时直接按 `canUpgradeBase()` 判定后调用引擎方法。

---


---

**接下页** → [`DESIGN_SUBSYSTEMS.md`](DESIGN_SUBSYSTEMS.md)：§8 待实现、§9 StickmanRuntime、§10 i18n、§11 IntroScene、§12 Vitest、§13 AISystem。
