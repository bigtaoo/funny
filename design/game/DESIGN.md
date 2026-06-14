# Notebook Wars — Game Technical Design

> 版本 v0.1 · 2026-06

---

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
| 基地（双方） | `game_base.png`，敌方按朝向镜像（横屏左右翻、竖屏上下翻） |

### 箭塔攻击范围

箭塔对 **`attackRange`（当前=2）格 Chebyshev 距离**内的所有敌方单位全向攻击，不区分方向：

- 按距离环由近到远查找目标，优先打最近的敌人
- 覆盖正面纵向、侧面横向（含 Crossing 状态单位）、斜向，统一处理
- 实现位置：`CombatSystem.findTargetForBuilding`

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

### 卡面渲染（`HandView`）

每个卡槽自上而下：类型字符（U/B/S，左上）→ 插画（`art` 精灵）→ 名称（底部居中加粗 13px）→ 费用圆（右下）。

| 卡牌 | 插画资源 |
|---|---|
| 普通兵（Infantry） | `infantry.png` |
| 弓箭兵（Archer） | `archer.png` |
| 盾兵（ShieldBearer） | `shieldbearer.png` |
| 兵营（Barracks） | `game_infantry_barracks.png`（与场上建筑同图） |
| 箭塔（ArrowTower） | `game_archer_barracks.png`（与场上建筑同图） |
| 法术（Haste / Meteor） | 无图，仅文字 |

- 插画等比缩放居中于类型行与名称行之间，不被费用圆遮挡
- 纹理按 key 懒加载缓存在 `Map`；异步加载完成时清空 `lastSyncKey` 触发重 sync
- 对象池回收时重置 `art`为空纹理并隐藏
- 卡牌名走 i18n：`CardDefinition.nameKey` → `t(card.nameKey)`（见 §10）
- **刷新倒计时进度条**：每张牌底部一条 3px 横条（`bar` Graphics），显示距下次自动刷新的剩余比例（`refreshRemainingTicks / refreshDurationTicks`）。颜色随剩余秒数变化：>10s 绿色 → ≤10s 黄色 → ≤5s 红色；最后 3 秒进度条 alpha 做 sin 波脉冲（0.6–1.0）。卡牌被自动刷新时触发 `card_expired` 事件，`GameRenderer` 调用 `handView.notifyCardExpired(slotIndex)`，令该槽渲染 250ms 白色淡出叠加层（`flash` Graphics）作为刷新反馈。倒计时时长由 `config.CARD_REFRESH_TICKS`（900 ticks = 30 s）控制；发牌时随机错峰 [0, 15 s]（`CARD_REFRESH_INITIAL_OFFSET_MAX`）防止所有槽同时刷新。
- **手牌与 HUD 层级**：`HUDView` 的底部条带背景（`botBg`，全宽 alpha 0.92）拆到独立的 `backgroundContainer`，由 `GameRenderer` 挂在 `handView` **之前**渲染；HUD 前景（金币 / HP / 升级按钮 / 暂停 / 结算遮罩）仍在 `handView` **之后**。层级：`vfx → HUD底栏背景 → 手牌 → HUD前景/遮罩`。否则横屏下底栏背景会盖住中段手牌（仅选中卡牌抬升的顶部冒出上沿）

---

## 8. 待实现

| 功能 | 位置 | 说明 |
|---|---|---|
| 受击特效位置 | StickmanRuntime | 使用挂点 hit 坐标 |

---

## 9. 骨骼动画 Runtime（StickmanRuntime）

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

- 凡在 `STICKMAN_ASSETS` 中登记了 `.tao` 的单位类型（Infantry→`infantry.tao`、Archer→`archer.tao`、ShieldBearer→`shieldbearer.tao`），若该类型资源（`assets` Map 内）已加载，`acquireSprite` 创建 stickman 容器；否则退回占位圆形。资源后台加载，按类型各自维护复用池（`stickmanPools`）
- 敌方（`Side.Top`）：`mirrorX: true`，`scaleX *= -1`
- `sync(board, dt)` 中对每个有 runtime 的单位调用 `runtime.syncState` + `runtime.update(dt)`
- 单位死亡时 `runtime.play('death')` 后在淡出动画结束时 `runtime.destroy()`

### 资源文件

| 文件 | 说明 |
|---|---|
| `src/assets/infantry.tao` | Infantry 骨骼动画包（ZIP）|
| `src/assets/archer.tao` | Archer 骨骼动画包（ZIP）|
| `src/assets/shieldbearer.tao` | ShieldBearer 骨骼动画包（ZIP）|
| webpack：`/\.(tao)$/i` → `asset/resource` | .tao 按二进制资源处理，emit 后由 fetch 加载 |

---

## 10. 多语言（i18n）

### 文件位置

`src/i18n/`：`index.ts`（运行时 API）+ `locales/{zh,en,de}.ts`（词条字典）。

### 核心规约

- **所有面向玩家的文案严禁硬编码**，必须先在 `locales/zh.ts` 加键（键的**唯一来源**），再用 `t(key, params?)` 取词。
- `zh.ts` 导出 `TranslationKey = keyof typeof zh` 联合类型；`en.ts` / `de.ts` 声明为 `Record<TranslationKey, string>`，**漏翻任一语言会编译报错**。
- 游戏逻辑层只存键不存文案：`CardDefinition` 用 `nameKey` / `descKey`（每卡预留了描述文案，供以后卡牌详情页使用）。

### API

```ts
t(key, params?)          // 取词 + {param} 插值，如 t('hud.upgradeCost', { cost })
initI18n(lang, store, supportedLocales)   // 启动时调用，须在任何场景构建前
setLocale(locale) / getLocale()           // 运行时切换 + 读取当前语言
getSupportedLocales()                     // 当前平台可选语言集合
onLocaleChange(fn): () => void            // 订阅切换（场景重绘），返回取消订阅
detectLocale(rawTag, allowed?)            // 系统语言标签 → Locale
```

- 取词回退链：当前语言 → `zh` → 键名本身，缺词不会崩溃。
- 插值用 `{param}` 占位，`t()` 内做字符串替换。

### 语言选择优先级

```
玩家保存的选择（storage 'nw_locale'，且仍在支持集合内）
  > 平台系统语言（IPlatform.getLanguage()，经 detectLocale 钳制）
  > 平台支持集合的第一个
```

### 平台支持集合

`IPlatform.supportedLocales` 声明各平台 ship 的语言，`initI18n` 把激活语言钳制到该集合：

| 平台 | supportedLocales |
|---|---|
| Web / CrazyGames | `['zh', 'en', 'de']` |
| 微信小游戏 | `['zh']`（小游戏只需中文） |

`IPlatform.getLanguage()`：Web/CrazyGames 读 `navigator.language`，微信读 `wx.getSystemInfoSync().language`。

### 已接入文案的位置

`LobbyScene` / `HUDView`（暂停、升级、胜负）/ `ResultScene`（标题 + 徽章，徽章文案渲染时取词）/ `GameRenderer` 拖拽幻影 / `HandView` 卡牌名 / `IntroScene` 背景故事。

### 新增语言步骤

1. `i18n/index.ts` 的 `Locale` 类型加一项；2. 新建 `locales/<x>.ts`（`Record<TranslationKey,string>`）；3. 注册进 `DICTS` 与 `ALL_LOCALES`；4. 在需要的平台 `supportedLocales` 里加入。

---

## 11. 首次进入引导（IntroScene）

### 职责

首次启动时讲述背景故事，看完后进大厅；之后启动直达大厅。

### 流程

```
app.ts 启动 → initI18n() → 检查 storage 'nw_seen_intro'
  ├─ 已看过 → goLobby()
  └─ 未看过 → goIntro()
                IntroScene：背景故事逐行淡入 + 点击推进 + 右上角跳过
                onFinish() → storage.setItem('nw_seen_intro','1') → goLobby()
```

### 当前实现（骨架）

- 笔记本纸张背景；故事文案逐行淡入（`FADE_DURATION` 0.8s/行）
- 点击：当前行未淡完则立即完成；已完成则推进下一行；最后一行后任意点击结束
- 右上角"跳过"按钮（带 padding 的点击热区），底部"点击继续"呼吸提示
- 文案全部在 i18n `story.*` 命名空间

### 后续扩展

保留"逐段推进 + 跳过"流程，往每段挂 PIXI 容器或 `StickmanRuntime` 动画即可升级为正式引导动画。

> ⚠️ **内容待对齐**：当前 `story.*` 与 `card.*.desc` 的占位文案为"笔记本涂鸦士兵"主题，与 `../product/world.md`、`../product/characters.md` 的世界观（方家三人试炼：李川/陈守/苏远）不一致，需据设计文档重写。卡牌 `nameKey`（普通兵/盾兵/弓箭兵）已与设定一致。

---

## 12. 测试（Vitest）

### 运行

```bash
cd client
npm test          # vitest run，一次性
npm run test:watch
```

### 范围与原则

- 只测**纯逻辑内核** `src/game/**`（无 PIXI 依赖）；渲染层不在范围。
- `vitest.config.ts` 只扫 `test/**/*.test.ts`，与 webpack 构建完全隔离，不进入打包。
- 测试文件位于 `client/test/`：

| 文件 | 覆盖 |
|---|---|
| `math.test.ts` | 定点数截断语义（`toFp`/`mulFp`/`scaleFp` 等）、`Prng` 同 seed 复现 / 跨实例独立 / Fisher-Yates 置换 |
| `ResourceSystem.test.ts` | 各加速档金币回速、`COIN_CAP` 封顶、基地升级 bonus、`resource_changed` 仅整数变化时发 |
| `MovementSystem.test.ts` | 纵向推进步长、Crossing 切换、抵达基地造成伤害 + despawn、友军半径碰撞不重叠 + Waiting 滞回 |
| `CombatSystem.test.ts` | 近战命中、攻击冷却、击杀移除 + 计分、晚期攻击翻倍、箭塔 Chebyshev 横向命中、超射程不打 |
| `AISystem.test.ts` | 增强 AI 行为守护：近基地集群放陨石、无陨石退化为放箭塔、无威胁时进攻出兵、coin cap < 升级费时不升级、easy 档不用陨石/箭塔 |
| `replay-determinism.test.ts` | **黄金回放**：同 seed 两次运行状态指纹结构全等；异 seed 发散；长局活跃度 sanity |

### 确定性 / 回放保障

黄金回放测试是守护"同 seed + 同命令流 ⇒ 逐位一致"这一核心契约的主测试。它用**运行 vs 运行结构比对**而非硬编码数值，因此平衡数值调整不会让它误报。

> **配套修复**：`Unit`/`Building` 原用模块级全局 `nextId`，跨 engine 实例 ID 不复现。新增 `resetUnitIds()`/`resetBuildingIds()`，由 `GameState` 构造函数调用，使每局实体 ID 从固定基址开始 —— replay 可跨进程复现。
>
> **ID 命名空间**：**building 从 0 起、unit 从 1000 起**。建筑数量受棋盘格子数（12×18=216）封顶，永远到不了 1000；单位是高频增长方，取上段。两个命名空间无论对局多长都不会冲突。渲染层按事件类型（`unit_spawned` / `building_placed`）分池管理 view，不依赖 ID 区间。

---

## 13. AI 系统（AISystem）

### 文件位置

`src/game/systems/AISystem.ts`。AI 操控 **Top 方**（owner 1，基地在 row 17）。敌方单位 = Side.Bottom，朝 row 17 推进——单位 row 越高（越接近 AI 基地）威胁越大。

### 输入 / 输出契约

- `decideTick(tick, state)` 每 tick 调用一次，内部按难度档的 `thinkIntervalTicks` 节流，到点才决策。
- **只读 state，不改 state**：返回 `PlayerCommand[]`（至多一条），由 `GameEngine.processCommand()` 执行。
- **确定性**：所有分支只读游戏状态 + 注入的 `Prng`（仅用于并列 lane 的随机 tie-break）。无 `Math.random` / `Date` / 浮点不确定性，满足黄金回放契约。

### 决策流水线（优先级从高到低，命中即返回）

1. **紧急防守**（`underPressure`：有敌军 row ≥ `dangerRow`，或己方基地 HP ≤ `lowBaseHp`）
   - a) **陨石清团**：扫描 2×2 落点，命中最密的近基地敌群（`preferNearBase` 并列取更高 row）。
   - b) **箭塔**：在威胁最高且空置的建筑车道放箭塔。
   - c) **肉盾拦截**：往威胁最高车道出兵，优先 ShieldBearer（最肉）。
2. **升级规划**（仅当 `upgradeReachable` 且全场无威胁时）
   - 能升级就升级；接近升级费（≥ 60%）时攒钱、本 tick 不乱花。
   - **`upgradeReachable` 守卫**：`nextUpgradeCost ≤ COIN_CAP` 才考虑。当前 `COIN_CAP=300` ≥ `BASE_UPGRADE_COSTS=[50,100,200]`，升级**可达**，AI 安全时会攒钱并升级。守卫仍保留为防御性代码：若日后把升级费调到超过金币上限，该分支会自动静默跳过、不会卡死。
3. **经济 / 进攻**
   - 早期在**安全车道**（威胁最低）补兵营，维持出兵流（上限 `MAX_BARRACKS=2`）。
   - 敌群够大（`meteorOffenseCluster`）时进攻性陨石。
   - 否则按性价比出兵（偏好顺序 Infantry → Archer → ShieldBearer），推**防守最薄弱**车道（威胁最低）打穿。

### 难度分级

`new AISystem(rng, difficulty)`，`difficulty: 'easy' | 'medium' | 'hard'`，默认 `'medium'`（`GameEngine` 当前用默认值，未接 UI 选择器）。

| 档 | think 间隔 | dangerRow | 低血线 | 陨石 | 箭塔 | 兵营 | 进攻陨石阈值 |
|---|---|---|---|---|---|---|---|
| easy | 60t (2s) | 15 | 25% | ✗ | ✗ | ✗ | — |
| medium | 45t (1.5s) | 13 | 40% | ✓ | ✓ | ✓ | 3 |
| hard | 30t (1s) | 11 | 50% | ✓ | ✓ | ✓ | 2 |
