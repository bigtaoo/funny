# 引擎技术设计 — 骨骼动画 / i18n / 引导 / 测试 / AI（§8 起）

> 从 [`DESIGN.md`](DESIGN.md) 拆出（2026-08-17，原文件 551 行）。**小节编号沿用原文**，`DESIGN.md §N` 引用照旧有效。
> 本册内容：§8 待实现、§9 StickmanRuntime、§10 i18n、§11 IntroScene、§12 Vitest、§13 AISystem。总览与在先小节见 [`DESIGN.md`](DESIGN.md)。

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

> **实体 ID 分配（2026-07-16 修正为每实例计数器）**：**unit ID 现由 `GameState` 实例字段 `_nextUnitId`（从 1000 起）经 `allocUnitId()` 分配**，所有真实出兵点（`commands.ts` 出牌、`BuildingProductionSystem` 兵营、`CombatSystem` onDeathSpawn、`TraitSystem` summon、`engine/base.ts` garrison/attackerArmy、`campaign.ts` 波次）都走它。每个 `GameState` 从 1000 起 ⇒ 同 seed 仍逐位复现（ID 本就不进 `matchStateHash`，只哈希 `{winner, stats}`）。`Unit.ts` 保留的模块级 `nextId` 仅作**独立构造（单测/工具，无宿主 GameState）**的兜底，基址抬到 900_000，与每实例区间（1000+）隔离，避免同一 board 上混用时撞号。
>
> ⚠️ **为什么必须每实例**：曾用模块级全局 `nextId` 且由 `GameState` 构造函数 `resetUnitIds()` 归零。联机对战中 `judgeRunner` 会在**对局进行中**新建第二个 `GameState`（hash 争议重算），把共享计数器重置回 1000 —— 主引擎下一个出兵**复用了仍存活的 ID**，`Board.units`（`Map<id,Unit>`）里 `addUnit` 直接**覆盖**旧单位；旧单位从 `board.units` 消失却仍留在 `columnUnits`，`MovementSystem` 遍历 `board.units.values()` 再也碰不到它 —— 成了一个**看不见、冻结、永久挡路的"幽灵兵"**，后面出的兵全堆在它身后 `waiting`（前方无可见敌人）。回归测试见 `__tests__/unit-id-per-instance.test.ts`。
>
> **building ID 同样改为每实例（2026-07-16，unit 修复的姊妹项）**：building ID 现由 `GameState` 实例字段 `_nextBuildingId`（从 0 起）经 `allocBuildingId()` 分配，两个真实放置点（`commands.ts` 出建筑牌、`engine/base.ts` defenderBuildings）都走它。`Building.ts` 保留的模块级 `nextId` 仅作独立构造（单测/工具）的兜底，基址抬到 **500**（仍 <1000）与每实例区间（0+）隔离，避免同一 board 上混用时撞号。回归测试见 `__tests__/building-id-per-instance.test.ts`。修复前同 unit：`judgeRunner` 对局中重算新建第二个 `GameState` 会把共享全局重置回 0，主引擎下一次放塔复用仍存活的 ID，在 `Board.buildings`（`Map<id,Building>`，见 `addBuilding`）里覆盖旧建筑 —— 旧建筑从 Map 消失（`BuildingProductionSystem`/`CombatSystem` 遍历 `board.buildings.values()` 再也碰不到）却仍留在 `buildingGrid` 占格，成了不再 tick、却仍挡位的"幽灵建筑"。
>
> **ID 命名空间**：**building 从 0 起（模块兜底 500，均 <1000）、unit 从 1000 起**。建筑数量受棋盘格子数（12×18=216）封顶，永远到不了 1000；单位是高频增长方，取上段。两个命名空间无论对局多长都不会冲突。渲染层按事件类型（`unit_spawned` / `building_placed`）分池管理 view，不依赖 ID 区间。
>
> ⚠️ **仍未处理（判定为良性）**：`EscortUnit`/`Projectile` 仍用模块级全局 `nextId`，但它们存于数组（push 序，非 id-keyed Map），撞号仅造成事件歧义、不产生覆盖幽灵，暂不处理。

---

## 13. AI 系统（AISystem）

### 文件位置

`@nw/engine/systems/AISystem.ts`。AI 操控 **Top 方**（owner 1，基地在 row 17）。敌方单位 = Side.Bottom，朝 row 17 推进——单位 row 越高（越接近 AI 基地）威胁越大。

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
   - **`upgradeReachable` 守卫**：`nextUpgradeCost ≤ COIN_CAP` 才考虑。当前 `INK_CAP=100` ≥ `BASE_UPGRADE_COSTS=[30,50]`，升级**可达**，AI 安全时会攒钱并升级。守卫仍保留为防御性代码：若日后把升级费调到超过金币上限，该分支会自动静默跳过、不会卡死。
3. **经济 / 进攻**
   - 早期在**安全车道**（威胁最低）补兵营，维持出兵流（上限 `MAX_BARRACKS=2`）。
   - 敌群够大（`meteorOffenseCluster`）时进攻性陨石。
   - 否则按性价比出兵（偏好顺序 Infantry → Archer → ShieldBearer），推**防守最薄弱**车道（威胁最低）打穿。

> **规则统一（2026-06-15）**：放置/金币校验是**引擎单一权威**，AI 与人类同规则。`GameEngine.processCommand` 对出兵格 `isCellOccupiedByUnit(col, spawnRow)` 守卫（行满则该指令被丢弃，AI 也不能越格堆兵）；金币不足（`player.ink < card.cost`）本就在 `processCommand` + `AISystem.findCardIndex` 双重拦。**netplay 不跑任何 AI / 波次**（`decideTick` 仅 pvp 分支、只产 owner 1 指令），引擎从不替人类自动出牌。
>
> **平衡（2026-06-15）**：兵营出兵间隔 4s→6s（`BARRACKS_SPAWN_INTERVAL_TICKS`，−33% 产出）+ 卡费 10→14，收敛「约 20s 回本后无限产出」的过强问题。

### 难度分级

`new AISystem(rng, difficulty)`，`difficulty: 'easy' | 'medium' | 'hard'`，默认 `'medium'`（`GameEngine` 当前用默认值，未接 UI 选择器）。

| 档 | think 间隔 | dangerRow | 低血线 | 陨石 | 箭塔 | 兵营 | 进攻陨石阈值 |
|---|---|---|---|---|---|---|---|
| easy | 60t (2s) | 15 | 25% | ✗ | ✗ | ✗ | — |
| medium | 45t (1.5s) | 13 | 40% | ✓ | ✓ | ✓ | 3 |
| hard | 30t (1s) | 11 | 50% | ✓ | ✓ | ✓ | 2 |
