# Notebook Wars — 特效编辑器设计文档

> 创建：2026-06-21。状态：设计中 · 权威：本文 · 工具形态见 §1。
> 配套阅读：`../../product/art-direction.md`（美术方向，墨线/SketchPen/boil 的权威）、`../animator/ARCHITECTURE.md`（同类工具工程化参照）、`../level-editor/DESIGN.md`（独立 Web 工具范式）、`../../product/logic-architecture.md`（坐标系/录像/确定性）、根 `../../../CLAUDE.md`。
> 实现真源（运行时）：`client/src/render/VFXSystem.ts` + `client/src/render/vfx/`（解释器/图元/校验）；特效数据 JSON 在 `client/src/effects/`（编辑器导出落点，手动放入）。

---

## 0. TL;DR

- 一个**独立 Web 工具** `tools/vfx-editor`（端口 **9094**），可视化编辑游戏战斗特效，产出 / 回读 **JSON**。
- 把现在 `VFXSystem.ts` 里**硬编码的 `draw(gfx,t,color)` 函数**升级为**声明式数据**：特效 = 图层(layer)列表，每个图层 = 一种**矢量图元** + 若干**参数轨道**（值随归一化进度 `t` 0→1 变化）。
- 范围锁定 **方案 A：墨线矢量程序特效**（与现有手绘风一致，零位图资产）。**不做**位图粒子——但数据模型给 `emitter` 图层类型留好扩展位（§13）。
- 关键增强：把 `boil.ts`（手抖沸腾线）与 `@nw/engine` 的 `prng`（种子随机）作为**图元能力**纳入数据模型，让纯矢量特效有"活的"有机感，且**不破坏锁步/回放的确定性**。
- 运行时改动很小：`VFXSystem` 的 `play/update/对象池`不动，只把硬编码 `EFFECTS` 换成"读 JSON → 通用 `interpret(layers,t,gfx)` 解释器"。
- 交付方式：编辑器导出 JSON → 提交进仓库 → 游戏 webpack 构建时打包（仿 level-editor 关卡 JSON 流程）。

---

## 1. 定位与边界

| 维度 | 说明 |
|---|---|
| 解决什么 | 让设计/美术**不写代码**就能调出新战斗特效，并把现有 4 个特效从命令式代码迁为可编辑数据。 |
| 工具形态 | 独立 Web 工具，`tools/vfx-editor`，端口 **9094**（animator 9091 / level-editor 9092 / ops 9093 已占）。 |
| 用什么渲染 | **PixiJS**（与游戏/animator 同栈），因为特效就是 `PIXI.Graphics` 矢量绘制，预览必须像素级一致；不像 level-editor 用纯 Canvas。 |
| 范围（本期） | 仅**墨线矢量程序特效**（方案 A）。覆盖现有战斗事件 + 全部法术/Trait 表（§5）。 |
| 不做什么（本期） | 不做位图/纹理**粒子发射器**（方案 B，留扩展位见 §13）；不做 `text` 拟声词图元（i18n 成本高，本期删除，见 §3.4）；不做带音频的"特效+音效"复合编排（音频归 `AUDIO_DESIGN.md`，仅在数据里留 `sfxKey` 占位）；不做运行时玩家导入（走"提交进仓库、构建打包"）。 |
| 数据来源真值 | 特效图元/解释器/校验的**单一来源在游戏侧**（`client/src/render/vfx/`），编辑器经 webpack alias import，绝不维护第二份易漂移的解释器；特效数据 JSON 在 `client/src/effects/`。 |

---

## 2. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| V1 | 独立 Web 工具（仿 animator/level-editor），TS + webpack，端口 9094 | 复用现有工程化心智，职责单一 |
| V2 | 范围 = **方案 A 墨线矢量程序特效**；**不上位图粒子** | 整个游戏是手绘墨线风，"火/烟"本就是笔触＝矢量；位图粒子会与手绘棋盘/UI 打架（`art-direction.md`）。方案 A 是方案 B 的真子集，不返工 |
| V3 | 特效 = **图层列表**，图层 = **图元 + 参数轨道**；参数轨道先做 `{from,to,ease}` 二点 | 现有 4 个特效全是单调插值，二点足够，省掉完整时间轴复杂度；进阶可升级多关键帧（§3.3） |
| V4 | **图元解释器单一来源在游戏侧** `client/src/render/vfx/interpret.ts`，编辑器与运行时共用 | 丢了编译期保护后，运行时解释是唯一可信源，必须只有一份（仿 level-editor L5） |
| V5 | 特效产出 / 回读 **JSON**，构建时打包 | 热迭代、可往返读写；与 level-editor L2/L4 一致 |
| V6 | `boil`（手抖）与**种子随机**作为图元能力进数据模型；随机一律**种子化** | 给矢量"活的"有机感；种子化保证锁步/回放确定性（§6） |
| V7 | 现有 4 个特效（hit/death_unit/death_building/spawn）用新模型**1:1 复刻**作回归基线 | 迁移正确性的硬验收（§4） |

---

## 3. 数据模型

### 3.1 顶层结构

```jsonc
{
  "schemaVersion": 1,
  "id": "hit",              // 唯一键，运行时 vfx.play(id, x, y, color) 用
  "duration": 0.25,         // 秒；t = elapsed / duration，封顶 1
  "loop": false,            // 见 §3.5：true = 循环播放（haste/aura 等持续特效），由调用方停
  "defaultColor": "0x222222", // 可被 play(...) 的 color 实参覆盖
  "sfxKey": null,           // 占位：将来与 AUDIO_DESIGN 联动，本期不消费
  "layers": [ /* LayerDef[] */ ]
}
```

### 3.2 图层（LayerDef）

```jsonc
{
  "type": "ring",           // 图元类型，见 §3.4
  "count": 1,               // 该图元重复个数（spokes/dots/burst 用）
  "z": 0,                   // 可选：层内绘制顺序，小=先画(在下层)；缺省=数组下标（§3.7）
  "boil": { "variants": 3, "fps": 8 }, // 可选：手抖沸腾，缺省=不抖（§6）
  "seed": 1234,             // 可选：固定本图层随机量的种子（缺省由实例 baseSeed+下标派生，见 §6）
  "params": { /* 每个数值参数一条 ParamTrack，见 §3.3 */ }
}
```

### 3.3 参数轨道（ParamTrack）

每个数值参数取以下两种形态之一：

```jsonc
// 形态 A：二点 + 缓动
"radius": { "from": 0, "to": 26, "ease": "linear" }

// 形态 B：多关键帧（每段可带 ease）
"radius": [ { "t": 0, "v": 0, "ease": "easeOut" }, { "t": 0.6, "v": 30 }, { "t": 1, "v": 26 } ]
```

- 常量值直接写数字（如 `"lineWidth": 2`），解释器视作 `{from:v,to:v}`。
- `ease` 取值：`linear | easeIn | easeOut | easeInOut`（解释器内置；`spawn` 用的就是 `easeOut`）。
- 解释器与编辑器**两种形态都支持**：编辑器 ParamPanel 提供 from/to 双框，可一键"加关键帧"切到多关键帧曲线编辑（V3 决议：本期就开多关键帧 UI，不留到后期）。
- 采样函数 `sampleParam(track, t)` 与 animator 的 `sampleClip` 同构、**无外部依赖**，可在游戏侧与编辑器共享。

### 3.4 图元库（≈8 种，覆盖现有全部 + 法术/Trait 表）

> 每个图元在原点 `(0,0)` 绘制（实例位置由 `play(x,y)` 决定）；解释器按 `params` 在进度 `t` 求值后调用对应绘制。

| `type` | 含义 | 关键参数 | 典型用途 |
|---|---|---|---|
| `ring` | 圆环 | `radius, alpha, lineWidth` | hit 扩张环、aura_heal 脉动、spawn 内爆 |
| `arc` | 圆弧（带起止角） | `radius, startAngle, sweep, alpha, lineWidth` | shield 护盾括号、半月斩 |
| `spokes` | 均布辐条组 | `count, innerR, outerR, rotation, alpha, lineWidth` | hit 冲击、爆裂放射 |
| `dots` | 散点群 | `count, spreadR, dotSize, alpha, jitter` | 碎屑、debris、落石碎块 |
| `burst` | 放射线爆发 | `count, nearR, farR, rotation, alpha, lineWidth` | death_unit 放射线 |
| `polyline` | 自由折线（点序列 + 缩放/旋转/位移轨道） | `points, scale, rotation, translateX/Y, alpha, lineWidth` | Meteor 拖影、地裂、Haste 速度线、闪电、HEAL 上浮十字 |
| `emitter` | 矢量粒子群（**纯程序，非位图**，2026-08-03 实现） | `count, emitter{lifetime,velocity,gravity,startAlpha/endAlpha,startScale/endScale,spawnSpread}, rotation, size, alpha` | 史诗大招、碎屑喷射 |

> **已删除 `text` 图元（决议 V8）**：漫画拟声词（"BAM!"/"HEAL"）涉及 i18n key/字面量两难、字体资产、PIXI.Text 子节点等额外复杂度，本期不做。需要"HEAL/上浮符号"用 `polyline`（十字/箭头矢量）替代，与墨线风更统一。将来若做，再在本表登记重新引入。
>
> 图元库的"全集是否够"以 §4/§5 两张映射表为验收：能 1:1 复刻现有 4 个特效、能给法术/Trait 表每项落地，即视为足够。新增图元须在本表登记并在 `interpret.ts` 实现。

### 3.5 循环语义（loop）

`one-shot`（默认 `loop:false`）：`hit/death/spawn/meteor` 这类，`t` 跑到 1 即结束、回收（现有 `VFXSystem.update` 行为）。

`loop:true`：`haste/aura_heal/shield` 这类**持续特效**——`t` 在 `[0,1]` 间循环往复（`elapsed % duration`），**不自动回收**，由调用方显式停止。`VFXSystem` 需新增：
- `play()` 对 `loop` 特效返回一个**句柄**（数字 id），one-shot 仍可忽略返回值；
- `stop(handle)` 移除并回收该实例；
- 持续特效通常绑定到某单位/状态（haste buff 存续期间），调用方在状态结束时 `stop()`。
- 与挂点（§3.6）配合：loop 特效一般 `follow` 单位。

### 3.6 挂点与缩放（attach / scale）

**决议（V4 答复 4）：特效本身不带缩放参数。** 缩放与"贴在单位上随其移动/缩放"是**单位侧挂点**的职责，不是特效数据的字段。

- 特效图元一律在自身原点系按设计像素绘制；`play(id, x, y, color)` 只给世界坐标与颜色。
- "贴单位"的特效（speed line、shield、aura）由调用方提供一个**跟随目标**：`VFXSystem` 实例可记一个 `followTarget`（提供 `{x,y,scale}` 的取值器），每帧把实例的 `gfx.position/scale` 同步到目标。挂点偏移/缩放沿用单位渲染侧（`UnitView`/挂点系统）的既有参数，特效不重复定义。
- 因此 `play()` 不新增 `scale` 形参；跟随通过可选参数 `play(id, x, y, color, { follow })` 传入目标取值器（one-shot 也可用，用于死亡特效跟随尸体的短暂场景，通常不需要）。

### 3.7 绘制顺序（z）

**决议 V9：层内绘制顺序可编辑，缺省=数组顺序。** 每个图层可选带 `z`（数字，小=先画＝在下层），缺省取数组下标。解释器按 `z` 升序、相同 `z` 退回数组下标稳定排序后绘制；**随机种子仍绑定原始数组下标**（排序不影响 boil/jitter 的确定性）。多特效之间的 z 仍由 `VFXSystem.container` 的全局层级（units 之上、HUD 之下）决定，单特效内部顺序由本字段控制。

### 3.8 颜色约定（V10）

- 特效自带 `defaultColor`（编辑时的占位色），**运行时由客户端调用方 `play(id, x, y, color)` 传入颜色覆盖**——通常是"施法方颜色"（我蓝敌红，见 `art-direction.md`），由调用点按发起方阵营取色后传入；特效数据本身不感知阵营。
- 编辑器侧提供**颜色盘 = 固定几种游戏内常用色**（我方蓝 / 敌方红 / 中性墨黑 / 治疗绿 / 警示橙等，取自美术规范），一键切换预览颜色，验证特效在各阵营色下都成立；编辑器不做任意取色器（避免调出游戏里不会出现的颜色）。

---

## 4. 现有 4 特效 → 新模型的 1:1 复刻（迁移基线）

> 数值取自当前 `VFXSystem.ts`，作为回归对照（像素级一致是迁移验收）。

**hit**（duration 0.25）：
```jsonc
"layers": [
  { "type": "ring",   "params": { "radius": {"from":0,"to":26}, "alpha": {"from":1,"to":0}, "lineWidth": 2 } },
  { "type": "spokes", "count": 6, "params": {
      "innerR": {"from":0,"to":11.7}, "outerR": {"from":0,"to":23.92},
      "alpha": {"from":1,"to":0}, "lineWidth": 2 } }
]
```

**death_unit**（0.45）：`burst`(count 8, nearR 0→8, farR 8→32, alpha 1→0) + `dots`(count 1, dotSize 5→0 中心点)。

**death_building**（0.55）：`ring`(radius 0→42, alpha 0.75→0) + `spokes`(count 12, 内外 0.28r/0.92r，每 3 根加粗——用两个 spokes 图层或 `lineWidth` 周期表达) + `dots`(count 4，固定角 debris)。

**spawn**（0.3，`easeOut` 内爆）：`ring`(radius 20→0, alpha 1→0, ease easeOut) + `spokes`(count 4，向内 r*1.3→r*0.8)。

> 说明：death_building 的"每 3 根辐条加粗"。实现采用 **`spokes` 的 `emphasisEvery`/`emphasisLineWidth` 参数**（而非拆两层）——因为拆两层无法精确复刻细辐条的 8 个角度（count 8 均布 ≠ 12 取余的剩余 8 根），用 emphasis 参数才能像素级一致。同理 debris 的 4 个固定角用 `dots` 的 `angleOffset`（4 点均布、起始偏移 0.63 rad），与原 `[0.63,2.19,3.77,5.34]` 误差 <0.6°，视觉等价。

---

## 5. 法术 / Trait 表的覆盖映射（表现力验收）

> 特效需求全集来自引擎（`SpellSystem.ts` / `TraitSystem.ts` / `CombatSystem`），不是凭空想象。

| 触发 | 来源 | 图元组合（草案） |
|---|---|---|
| 命中 | combat hit | ✅ 已迁移（§4） |
| 单位/建筑死亡、生成 | combat | ✅ 已迁移（§4） |
| **Meteor**（2×2 砸落） | SpellType.Meteor | `polyline` 下坠拖影（translateY + 运动线）→ `ring`+`spokes` 砸地冲击 → `polyline`×N 地裂；范围罩 `ring`(2 格宽) |
| **Rockslide**（整列落石，PvE） | SpellType.Rockslide | 多个 `dots`/`polyline` 石块沿列 translateY 下落 + 着地小 `spokes` |
| **BridgeCollapse**（整列封锁） | SpellType.BridgeCollapse | `polyline` 桥面裂纹扩展 + `dots` 坠落碎块 |
| **Haste**（加速 buff） | SpellType.Haste | 单位身上 `polyline` 速度线（漫画母语，矢量最强项）+ 可循环 |
| **aura_heal** | Trait aura_heal | `ring` 脉动 + 十字 `polyline` 上浮（替代原拟声词，§3.4） |
| **slow** | Trait slow | 下垂/沉重标记（`arc` + 慢速 alpha） |
| **summon** | Trait summon | spawn 变体（复用） |
| **shield** | ShieldBearer | `arc` 护盾括号 + 受击 `ring` 闪 |

> 结论：方案 A 的图元库可覆盖当前**全部**已知特效需求。真正受限的只有"软体积/辉光/上百火星"这类连续介质效果——而手绘墨线风**刻意不要**这些，故不构成短板。

---

## 6. 手绘有机感与确定性（V6 展开）

游戏的"灵魂"是手抖线条（`boil.ts`：用不同 `Prng` 种子烘焙 N 份同一笔画、8fps 轮播）。特效编辑器把它作为**图层级开关**：

- 图层带 `boil: {variants, fps}` 时，解释器为该图层烘焙 `variants` 份（每份用 `seed + 变体下标` 派生的 `Prng` 给顶点加抖动），运行时按 `fps` 轮播显示，**不逐帧重画**（沿用 boil 的零开销做法）。
- 所有随机（dots 的 `jitter`、polyline 顶点抖动、boil 变体）一律走**种子化 `prng`**（`@nw/engine` 已有 `math/prng.ts`）。每个图层每帧用**同一**种子重建 `Prng` → 帧间抖动一致（不闪烁）。

**每实例随机 vs 固定随机（决议 V11）**：种子分两层——
- **实例级 `baseSeed`**：`play()` 时确定。**默认 = 真随机**（`Math.random` 取一个 32 位种子），于是每次命中/爆裂的朝向、抖动略有不同，更有生气。
- **可选固定**：调用方传 `play(id, x, y, color, { seed })` 时，`baseSeed = seed`（通常由游戏初始化种子派生）→ 该实例**回放/旁观重跑画面完全一致**。需要录像视觉逐帧对齐的场合用它，其余默认真随机。
- **图层级 `seed`**：图层显式带 `seed` 则固定该层随机量，否则由 `baseSeed + 图层下标` 派生。

**确定性红线**：特效是**纯表现层**，永不进入引擎模拟、不影响 `GameState`、不参与锁步同步。因此即便默认用真随机，也**不会破坏锁步/对局一致性**——它影响的只是画面观感；只有"录像逐帧视觉对齐"这个弱需求才需要 `{seed}` 固定。这也是不上位图粒子的另一理由——粒子的实时随机模拟一旦想固定就得专门种子化，成本更高。

---

## 7. 运行时改造（`client/src/render/`）

最小侵入，公开 API 不变：

```
client/src/
├── effects/              // 特效数据 JSON（编辑器导出落点，手动放入；每特效一文件）
│   ├── hit.json
│   ├── death_unit.json
│   ├── death_building.json
│   └── spawn.json
└── render/
    ├── VFXSystem.ts      // 保留 play()/update()/对象池/destroy()；EFFECTS 改为从 registry 读
    └── vfx/              // 数据驱动核心（编辑器经 alias 共享）
        ├── types.ts          // EffectDef / LayerDef / ParamTrack 类型
        ├── interpret.ts      // interpret(layers, t, gfx, color, baseSeed)：通用绘制（单一来源）
        ├── sampleParam.ts    // 参数轨道采样（无依赖，可共享）
        ├── primitives.ts     // 图元的绘制实现（ring/arc/spokes/dots/burst/polyline/emitter）
        ├── parseEffectDef.ts // 校验+归一化 JSON → EffectDef（运行时唯一可信门，仿 parseLevelDefinition）
        └── registry.ts       // 汇总 ../../effects/*.json（经 parseEffectDef）→ Record<id, EffectDef>
```

- 决议（答复 2）：**每特效一个 JSON 文件**放 `client/src/effects/`，由 `registry.ts` 合并成注册表（便于 diff、并行编辑，仿 level-editor 关卡 JSON）；不用单一大文件。
- 决议（V12 路径）：特效 JSON 从 `render/vfx/effects/` 上移到 `client/src/effects/`——编辑器（浏览器工具，不能直接写仓库）导出 JSON 下载到本地，用户**手动放进该目录**；目录浅、好找。
- `VFXSystem.play(id,...)` 从 registry 查 `EffectDef`，`update()` 里把原来的 `inst.def.draw(gfx,t,color)` 换成 `interpret(def.layers, t, gfx, prng)`。
- `update()` 新增 `loop` 分支（§3.5）：loop 实例 `t = (elapsed % duration)/duration`、不回收；维护句柄表供 `stop()`。
- 对象池、回收、`container` 层级（units 之上、HUD 之下）全部不动。
- 验收：现有 4 特效迁为 JSON 后，游戏内表现与迁移前**像素级一致**（§4 基线）。

---

## 8. 编辑器模块划分（`tools/vfx-editor/`，仿 animator）

| 文件 | 职责 |
|---|---|
| `src/App.ts` | 组合根 + 主循环（每帧推进预览 `t` 或循环播放） |
| `src/rendering/PreviewRenderer.ts` | PixiJS 预览：调用游戏侧 `interpret()` 实时绘制；可叠"参考单位"剪影看相对尺寸 |
| `src/ui/EffectListPanel.ts` | **特效列表**：项目内全部特效的浏览/切换/新建/复制/删除/改 id（registry 里有 N 个特效，需可逐个编辑） |
| `src/model/EffectModel.ts` | 当前特效的图层/参数状态 + CRUD + undo/redo（仿 animator history） |
| `src/ui/LayerPanel.ts` | 图层列表（增删改排序、选图元类型、boil 开关、seed、z 顺序） |
| `src/ui/ParamPanel.ts` | 选中图层的参数表：每参数 from/to 数字框 + ease 下拉；「+ 关键帧」按钮切到多关键帧曲线编辑（答复 1：本期就开多关键帧 UI） |
| `src/ui/ColorPalette.ts` | **颜色盘**：固定几种游戏内常用色（我蓝/敌红/墨黑/治疗绿/警示橙），切换预览 `color`，验证各阵营色下都成立（§3.8） |
| `src/ui/Timeline.ts` | 一条 `t`(0→1) 拖动条 + 播放/暂停/循环 + duration 输入 |
| `src/io/IOController.ts` | 导出/导入单个特效 JSON（见下方"回写流程"）；可批量导出全集 |
| `src/io/ProjectStore.ts` + `AutoSaveController.ts` | IndexedDB 自动保存（直接搬 animator 的 `nw-animator` 套路，库名 `nw-vfx`） |

**回写仓库流程（决议 V12）**：编辑器是浏览器工具，**不能直接写仓库文件**。流程 = 编辑器「导出」→ 浏览器下载 `<id>.json` 到本地（或用户指定目录）→ 用户**手动放进** `client/src/effects/` → webpack 构建打包。与 level-editor 关卡 JSON 同款心智（同步靠网盘/手动，必要时可为该目录单建网盘同步）。编辑器侧自动保存仅用 IndexedDB 作工作副本，仓库 JSON 始终是真源。

复用要点：解释器/类型/采样/**校验（`parseEffectDef`）从游戏侧 import**（webpack alias，仿 level-editor `@game`），编辑器导出前用同一 `parseEffectDef` 校验，保证导出的 JSON 运行时一定能解析；自动保存、undo/redo、PIXI 预览的工程化直接照搬 animator（见 `animator/ARCHITECTURE.md`）。

---

## 9. 性能预算（微信小游戏为下限基准）

游戏要跑微信小游戏，矢量特效虽轻量，但编辑器能做出过重的特效，故定**软约束**（编辑器超限给黄色警告，不硬禁；运行时不强制裁剪）：

| 维度 | 预算 | 说明 |
|---|---|---|
| 单特效图层数 | ≤ **8** | 现有 4 特效 ≤ 2 层，8 层足够史诗级组合 |
| 单图层 `count`（spokes/dots/burst） | ≤ **32** | 32 条线/点对矢量批绘是小开销；超 32 视觉也糊 |
| 单特效估算顶点总数 | ≤ **~400** | `Σ(count × 每图元顶点)`；polyline 顶点数计入 |
| 同屏并发特效实例 | ≤ **24** | 由 `VFXSystem` 对象池约束；超过时旧 one-shot 可被回收（本期先靠自然过期，不主动裁剪） |
| boil 烘焙变体 `variants` | ≤ **4**，`fps` ≤ **12** | 每变体一份烘焙几何，4 份是内存/观感平衡点 |
| 单特效 `duration` | 建议 ≤ **2s**（loop 除外） | one-shot 过长占用实例槽 |

> 编辑器在 `EffectModel` 上实时算这些指标并在面板角标提示；导出不因超限阻断（设计权衡可破例），但会在导出确认里列出超限项。

---

## 10. 校验与容错（`parseEffectDef`）

丢了编译期保护后，**运行时唯一可信门 = `vfx/parseEffectDef.ts`**（仿 level-editor `parseLevelDefinition`，V4）。registry 合并每个 JSON 时都过它；编辑器导出前也用同一函数校验。

- **硬错误（throw，构建期暴露）**：缺 `id`、`duration ≤ 0`、`layers` 非数组、参数轨道结构非法（`{from}` 缺 `to`、keyframe 缺 `t/v`、空 keyframe 数组）、`points` 非 `[number,number][]`。
- **可恢复（warn + 降级，不中断）**：未知图元 `type` → 丢弃该图层；未知 `ease` → 退回 `linear`；`emitter` → 运行时 no-op（§13）。
- 归一化输出：补 `schemaVersion`（缺省 1）、`loop`（缺省 false）、`sfxKey`（缺省 null），narrow `ease: string` → `Ease` 联合。
- 运行时 `interpret`/`primitives` 仍各自带兜底（未知 type 跳过、参数缺省值），即"双保险"。

---

## 11. 测试策略

纯函数优先、render 层走目视回归（与 `client/vitest.config.ts` "只测 `src/game/**` 纯核心、render 层不入单测"的约定一致）。

- **单测（`client/test/vfx.test.ts`，已建）**：`sampleParam`（常量/二点 ramp/缓动/多关键帧/越界 clamp）+ `applyEase`（端点稳定）+ `parseEffectDef`（合法归一化、硬错误 throw、未知图元丢弃、未知 ease 降级、z 保留）。这两个文件无 PIXI 依赖，可在 node 环境跑。
- **render 层（`interpret`/`primitives`）**：依赖 PIXI.Graphics，按项目约定不入 node 单测，靠**游戏内目视回归**——迁移前后现有 4 特效像素级一致（§4 基线）。
- **编辑器（P2 落地后）**：导出 → `parseEffectDef` 往返一致性可加 e2e；预览渲染目视。

---

## 12. schemaVersion 与迁移

- 顶层 `schemaVersion`（当前 `1`）。**原则：默认向下兼容**——加字段一律可选、给缺省，老 JSON 不动照常解析。
- **不兼容改动**（极少，如重命名/语义改字段）：由**改动者负责把仓库内全部特效重新导出**为新版，并 bump `schemaVersion`；`parseEffectDef` 可对低于当前版本的 JSON 给一次性 warn 提示需重导。不做运行时自动迁移器（特效数量小，重导成本低于维护迁移代码）。

---

## 13. `emitter`：矢量粒子群（2026-08-03 实现，方案 A2）

原计划的"位图粒子"（方案 B：贴图发射器）需要美术方向拍板 + 新资产管线，本期不做。改为**纯矢量模拟**：每个粒子只是 `gfx.drawCircle` 画的一个小圆点，零新增美术资产，与现有墨线风格一致，且与"方案 A：不做位图粒子"的既定决议不冲突——只是把 emitter 这个保留位从"以后可能要位图"改为"现在就用矢量实现"。

**确定性**：不做逐帧状态累积。每个粒子的出生时刻/角度/速度/寿命由 `interpret.ts` 每帧用同一 seed 重建的 `Prng`（与 `boil`/`dots` 同一套机制）按固定顺序抽取，因此对同一个 `t` 永远解出同一个粒子群——重播/回放确定性成立（§6 红线）。粒子位置是 `t` 的解析函数（弹道公式），不是"上一帧位置 + 本帧速度"的累加。

**`LayerDef.emitter: EmitterSpec`**（`types.ts`）：
- `lifetime: {from, to}` —— 每个粒子寿命，效果总时长的比例，个体在此区间内随机取值
- `velocity: {min, max, angleSpread}` —— 出生速度大小范围 + 绕 `rotation` 的角度散布半宽
- `gravity`（默认 0）—— 竖直方向加速度
- `startAlpha/endAlpha`（默认 1/0）、`startScale/endScale`（默认 1/0.3）—— 粒子自身生命周期内的线性衰减
- `spawnSpread`（默认 0）—— 0 = 全部粒子在 t=0 同时出生（爆裂/burst，史诗大招典型用法）；1 = 出生时刻均匀撒满整个 `[0,1)`（持续喷射）

层级参数（走 `params`，可动画）：`rotation`（发射基准方向）、`size`（粒子基础半径）、`alpha`（整层透明度倍数）。`count`（沿用既有 layer-level 字段）= 粒子总数。

**校验**（`parseEffectDef.ts`）：`type: 'emitter'` 的图层缺少或形状不对的 `emitter` 字段视为硬错误（throw），因为无法给出合理默认弹道。

**编辑器**：`emitter` 已加入 `ALL_PRIMITIVES`/`COUNT_PRIMITIVES`；新建图层自动种一份"12 点、0.2–0.5s 寿命、40–100 速度、360° 散布"的可见默认值；结构字段（lifetime/velocity/gravity/…）走 JSON pane 直接编辑（与 `polyline` 的 `points` 同一约定，不为每个 emitter 子字段单开控件）。

若未来仍要"史诗大招 + 美术方向确认接受位图"，方案 B（贴图粒子）依旧可以作为独立扩展叠加：新增一个 `texture` 可选字段，`primitives.ts` 按有无 `texture` 分流到 Sprite 而非 `drawCircle`，不影响本节的矢量实现。

---

## 14. 分期与开放问题

**分期**
- ✅ P1：游戏侧 `vfx/` 核心（types/interpret/sampleParam/primitives/parseEffectDef）+ 现有 4 特效迁 JSON + `VFXSystem` 接解释器（**纯运行时重构，已落地**，§15）。
- ✅ P2：编辑器脚手架（端口 9094）+ 预览 + **特效列表面板** + 图层/参数面板 + **颜色盘** + JSON 往返 + 自动保存（**已落地**，§15）。
- ✅ P3：补齐法术/Trait 特效（§5，8 个新特效 JSON）+ boil 烘焙轮播图元能力（解释器/全图元接 boil + 编辑器预览轮播）（**已落地**，§15）。

**已决问题**

_2026-06-21：_
1. **多关键帧 UI 本期就开** —— ParamPanel 提供 from/to 双框 +「加关键帧」切多关键帧曲线编辑（§3.3 / §8）。
2. **每特效一文件 + 构建合并** —— `registry.ts` 合并（§7）。
3. **加 `loop` 语义** —— 顶层 `loop:boolean`，loop 实例 `t` 往复、不自动回收、`play()` 返句柄、`stop(handle)` 停止（§3.5 / §7）。
4. **特效不带缩放参数** —— 缩放/挂点是单位侧职责，`play()` 不加 `scale`；贴单位通过可选 `follow` 取值器同步位置（§3.6）。

_2026-06-24（补全施工细节）：_
5. **删 `text` 图元** —— i18n/字体成本高，HEAL 等用 `polyline` 矢量替代（§3.4 V8）。
6. **回写路径 = 手动放盘** —— 特效 JSON 移到 `client/src/effects/`；编辑器导出→下载→手动放入→构建打包（§7 V12 / §8 回写流程）。
7. **加特效列表面板 + 颜色盘** —— 多特效浏览切换；颜色盘=固定游戏常用色，运行时颜色由调用方传入（§3.8 V10 / §8）。
8. **z 绘制顺序可编辑** —— 图层可选 `z`，缺省=数组顺序（§3.7 V9）。
9. **每实例默认真随机，可选固定种子** —— `baseSeed` 默认 `Math.random`，`play(...,{seed})` 固定以求回放视觉一致（§6 V11）。
10. **校验 = `parseEffectDef`** —— 仿 `parseLevelDefinition`，硬错误 throw / 可恢复降级（§10）。
11. **必加单测** —— `sampleParam`/`parseEffectDef` 纯函数单测（§11），render 层走目视回归。
12. **性能软预算** —— 图层/`count`/顶点/并发/boil 上限，编辑器警告不硬禁（§9）。
13. **schemaVersion 默认向下兼容** —— 不兼容时改动者重导全部特效、bump 版本，不做自动迁移器（§12）。

---

## 15. 实现记录

### P1 — 运行时数据驱动重构（2026-06-21，已完成，`tsc --noEmit` 通过）

游戏侧新增 `client/src/render/vfx/`，`VFXSystem` 从硬编码改为数据驱动，公开 API 向后兼容（现有 `play('hit', x, y, 0xffffff)` 调用点不变）。

- `vfx/types.ts` —— `EffectDef`/`LayerDef`/`ParamTrack`（含三形态：常量/二点 ramp/多关键帧）/`Ease`/`BoilSpec`。
- `vfx/sampleParam.ts` —— `sampleParam(track,t)` + `applyEase`（linear/easeIn/easeOut/easeInOut），无依赖、可与编辑器共享。
- `vfx/primitives.ts` —— 图元绘制：`ring/arc/spokes/burst/dots/polyline/emitter` 均已实现（`emitter` 矢量粒子群，2026-08-03，见 §13）；`text` 当时为占位，P1.1 已删。`spokes` 支持 `emphasisEvery`/`emphasisLineWidth`，`dots` 支持 `angleOffset`/`jitter`（种子随机）。
- `vfx/interpret.ts` —— `interpret(layers,t,gfx,color,baseSeed)` 单一来源；每层按 `seed`（或 effect id 哈希派生）建 `Prng`，逐帧同种子重建→无闪烁且回放确定。
- `vfx/registry.ts` —— 每特效一 JSON（`effects/*.json`）合并为注册表。
- `VFXSystem.ts` —— 接 registry + interpret；新增 `loop` 分支（`t` 往复、不自动回收）、`play()` 返句柄 + `stop(handle)`、`follow` 取值器（每帧同步位置，返 null 自动停）；对象池/层级/`destroy` 不变。
- `effects/{hit,death_unit,death_building,spawn}.json` —— 1:1 复刻原 `VFXSystem.ts` 数值（hit innerR=11.7、death_building 用 emphasisEvery=3 + debris angleOffset=0.63）。

**未做（后续）**：boil 烘焙轮播（P3）、编辑器（P2）、法术/Trait 新特效（P3）。
**验收备忘**：像素级回归需在游戏内目视对比迁移前后（本项目约定不截图，留待手动）；编译验证已过。

> 工程备注：worktree 无 node_modules，本次用目录 junction 链接主目录 node_modules 后跑 `client` 的 `tsc --noEmit`（合并回 main 前此 junction 不影响仓库）。

### P1.1 — 施工细节补全（2026-06-24，已完成，`tsc --noEmit` + 12 单测通过）

落实 §14 已决问题 5–13 中可在运行时立即落地的部分（其余属 P2 编辑器）：

- **目录迁移**：`client/src/render/vfx/effects/` → `client/src/effects/`（`git mv`），`registry.ts` 改为 `import '../../effects/*.json'`。
- **删 `text` 图元**：`PrimitiveType` 去 `text`、`LayerDef.content` 删除、`primitives.ts` 去 `text` stub 与 `PRIMITIVES` 映射项。
- **新增 `vfx/parseEffectDef.ts`**：校验+归一化（硬错误 throw、未知图元丢弃、未知 ease 降级、补缺省），`registry.ts` 每个 JSON 过它。
- **z 绘制顺序**：`LayerDef.z?`，`interpret` 按 `z`（缺省数组下标）升序绘制；**随机种子仍绑原始下标**保确定性。
- **每实例随机**：`VFXSystem.play()` 默认 `baseSeed = Math.random` 派生（每实例不同）；`PlayOpts.seed` 可固定为回放一致。原 `hashId(id)`（恒定同一）废弃。
- **单测 `client/test/vfx.test.ts`**：12 例覆盖 `sampleParam`/`applyEase`/`parseEffectDef`（含 z 保留、未知图元丢弃、未知 ease 降级）。

**仍属 P2（编辑器）**：特效列表面板、颜色盘、性能预算角标警告、导出回写 UI。

### P2 — 独立 Web 编辑器（2026-06-24，已完成，`tsc --noEmit` + webpack 生产构建通过）

新增 `tools/vfx-editor/`（端口 **9094**，仿 animator/level-editor 工程化）。解释器/类型/采样/校验**全部经 webpack alias + tsconfig paths 从游戏侧 import**（`@vfx`→`client/src/render/vfx`、`@game`→`client/src/game`、`@nw/engine`→`server/engine/src`，prng 走 engine 重导出 shim），绝无第二份解释器；预览用同款 `pixi.js-legacy`，所见即运行时。

**工程骨架**
- `webpack.config.js`：transpileOnly ts-loader（游戏文件由 client CI 类型把关）；`resolve.modules` 含本工具 node_modules，使游戏子树里的 `pixi.js-legacy` 裸导入也能解析（worktree 无 client/node_modules）；`@nw/engine` 别名同 level-editor。
- `tsconfig.json`：`paths` 映射 `@vfx`/`@game`/`@nw/engine`/`pixi.js-legacy`，独立 `tsc --noEmit` 可全量类型检查（含游戏侧共享源）。
- `public/index.html`：三栏布局（左=特效库+图层；中=预览+时间轴+JSON；右=特效属性+颜色盘+参数+性能），复用 level-editor 暗色主题；可拖分隔条。

**核心/IO（`src/model`、`src/io`、`src/rendering`）**
- `model/EffectModel.ts`：当前特效可变工作副本 + 图层/参数 CRUD + 快照式 undo/redo（Ctrl+Z / Ctrl+Shift+Z，cap 80）+ 性能预算指标计算（§9）。
- `model/paramHints.ts`：各图元参数名提示（ParamPanel「+ 参数」下拉用，仅 UI 提示，非解释真源，需与 `primitives.ts` 同步）。
- `model/color.ts`：固定颜色盘（默认/我蓝/敌红/墨黑/治疗绿/警示橙）+ `0xRRGGBB` 解析。
- `io/ProjectStore.ts` + `io/Library.ts`：IndexedDB（库名 `nw-vfx`）工作副本；首次运行从仓库内置 4 特效（`@vfx/registry`）播种，去抖自动保存，记忆上次打开。**仓库 JSON 始终是真源**。
- `io/IOController.ts`：导出/导入单特效 JSON，导出前经同一 `parseEffectDef` 校验；导出后提示「手动放入 `client/src/effects/` 并构建」（§8 回写流程 V12）。
- `rendering/PreviewRenderer.ts`：PixiJS 预览，调游戏侧 `interpret()` 实时绘制 + 原点网格/十字 + 可选参考单位剪影（≈28px）。
- `rendering/Playback.ts`：预览时钟（编辑器恒循环预览，独立于特效 `loop` 字段）；可拖拽 scrub 定帧。

**UI 面板（`src/ui`）**
- `EffectListPanel`：特效库浏览/切换/复制/删除（内置项标记，内部 id 稳定跨改名）。
- `LayerPanel`：图层列表（增删改排序/复制），选中层展开结构字段（图元类型/count/z 顺序/seed/boil 开关；polyline 的 points 提示去 JSON 面板编辑）。
- `ParamPanel`：参数三形态（常量/二点 ramp/多关键帧）+「形态」下拉互转 + 关键帧增删 + ease 选择（§3.3 多关键帧 UI 本期就开）。
- `ColorPalette`：固定预览色切换（「默认色」解析特效 `defaultColor`），仅验证各阵营色，不做任意取色器（§3.8）。
- JSON 面板：实时映射状态，手改后「应用」经游戏侧 `parseEffectDef` 校验回写（points 等复杂字段的逃生口）。
- 性能预算面板：图层/count 峰值/估算顶点/时长对照软预算，超限黄色警告不阻断（§9）。

**未做（后续）**：boil 烘焙轮播预览（数据已可编辑，渲染轮播待 P3）；法术/Trait 新特效素材（P3，§5）；导出→仓库的自动同步桥（沿用手动放盘，§8）。
**验收备忘**：`tsc --noEmit` 干净、`webpack --mode production` 构建成功（仅 bundle 体积警告，PIXI 工具正常）；预览目视回归按项目约定不截图，留待手动 `npm run start`。

### P3 — boil 烘焙轮播 + 法术/Trait 新特效素材（2026-06-24，已完成，`tsc --noEmit` ×2 + 16 单测 + webpack 生产构建通过）

落实 §14 分期 P3：把 `BoilSpec`（P1 起仅声明、未消费）接入解释器与全部图元，并按 §5 映射表补齐 8 个法术/Trait 特效 JSON。

**boil 烘焙轮播（§6 兑现）**
- `interpret(layers, t, gfx, color, baseSeed, boilTime)` 新增第 6 参 `boilTime`（墙钟秒）。带 `boil` 的图层按 `floor(boilTime*fps) % variants` 选当前变体，并把变体折进种子（`seed ^ imul(variant+1, 0x9e3779b1)`）——于是抖动图样**每 1/fps 跳变一次、帧内恒定**，正是手抖沸腾节奏（非逐帧噪点）。`variant` 用 `boilTime`（非进度 `t`）驱动，故 loop 特效与暂停 scrub 时也照常沸腾。
- `primitives.ts`：新增 `boilAmp(layer,t)`（仅当层带 `boil` 时取 `boilAmp` 参，默认 1.5px）与 `wob(prng,amp)`（种子化 ±amp 偏移，amp≤0 时不抽 prng）。全部图元接 boil：`ring`/`arc` 带 boil 时改画**分段抖动多边形/弧线**（`strokeBoilCircle`/`strokeBoilArc`，段数随半径/弧长，圆首尾复用首段半径精确闭合）；`spokes`/`burst`/`polyline`/`dots` 对每个顶点加 `wob`。**无 boil 时 amp=0、走原 `drawCircle`/精确顶点路径——现有 4 特效逐像素不变（向后兼容）**。
- `VFXSystem.update` 传 `inst.elapsed` 作 `boilTime`；编辑器 `PreviewRenderer.render(..., boilTime)` + rAF 传 `now/1000`（自由钟，暂停/scrub 仍轮播）。
- 编辑器 `paramHints`：各 boil 适配图元补 `boilAmp` 提示项（默认 1.5），ParamPanel「+ 参数」下拉可见。

**8 个新特效 JSON（`client/src/effects/`，经 `parseEffectDef` 入 registry）**
- 一次性：`meteor`（下坠拖影 polyline→延时砸地 ring+spokes+debris dots，关键帧延时触发）、`rockslide`（多石块 polyline 沿列 translateX 错位 + translateY 下落 + 落地 dust dots）、`bridge_collapse`（桥面裂纹 polyline scale 扩展 + 坠块 dots）、`summon`（spawn 外爆变体：ring+spokes+sparkle dots）。
- 循环（调用方持句柄 `stop()`）：`haste`（3 条速度线 polyline 横扫，漫画母语）、`aura_heal`（脉动 ring + 十字 polyline 上浮，绿；替代原拟声词 §3.4）、`slow`（下垂 arc 括号 + 沉重 V 标记下沉，慢 boil fps6）、`shield`（前后两道 arc 护盾括号 + 微光 ring，蓝）。
- 多数线条层带 `boil` 展示沸腾；颜色用 `defaultColor` 占位（运行时由调用方按阵营传色 §3.8）。
- 单测加 `parseEffectDef` boil 保留/类型校验 + registry 12 特效 id 全集与 loop 标志回归（共 16 例）。

**未做（后续）**：8 个新特效尚未接入游戏战斗渲染层（`SpellSystem`/`TraitSystem` 当前不出特效，本期只产「素材」备用，待法术演出层开工时 `vfx.play(id,...)` 接入）；位图粒子 `emitter`（§13 扩展位，仍 no-op）。
**验收备忘**：client `tsc --noEmit` + 16 vitest 通过；vfx-editor `tsc --noEmit` + `webpack --mode production` 通过（仅 PIXI bundle 体积警告）；boil 轮播 / 新特效观感目视回归按项目约定不截图，留待手动 `npm run start`（编辑器）或游戏内播放。
> 工程备注：worktree 无 node_modules，本次 junction 主目录 `client`/`server`/根 node_modules 跑 client 校验，`tools/vfx-editor` 内 `npm install` 后跑工具校验（均 gitignore，不入提交）。

### P4 — 接通 one-shot 法术特效到战斗渲染层（2026-06-24，已完成，client `tsc --noEmit` 通过）

落实 P3「未做」尾的第一块：把 P3 产出的法术素材真正在游戏内播出来。

- **范围 = 3 个 one-shot 空间法术**：`meteor` / `rockslide` / `bridge_collapse`。引擎对全部法术只发**唯一**事件 `spell_cast { spellType, owner, center }`（`server/engine/src/systems/SpellSystem.ts`：meteor 的 center=2×2 落点，rockslide/bridge_collapse 的 center=整列 col），三者 `loop:false`，与 one-shot VFX 完美对应。
- **接入点**：`client/src/render/GameRenderer.ts` `handleEvent` 新增 `case 'spell_cast'`——模块常量 `SPELL_VFX`（`SpellType→vfx id`）查表，`event.center` 经 `boardView.gridToScreen(col, fromFp(y_fp))` 转屏幕坐标，颜色按 `event.owner === localOwner ? factionInk.friend : factionInk.enemy`（我蓝敌红 §3.8，特效数据的 `defaultColor` 仅编辑占位）。
- **haste 不接（归 P5）**：haste 是 `loop:true` 的**逐单位 buff 速度线**，单个 `spell_cast` 无 buff 结束信号、无法管理 loop 句柄生命周期；它和 aura_heal/shield/slow/summon 同属「需要 buff/trait 生命周期事件」的一组。
- **`StatePlayerScene`（哑状态回放器）不接**：它从相邻状态帧 diff 合成特效，状态流只载 units/buildings/bases，不含 spell_cast，法术无法重建——保持现状。

**P5（后续，需先做引擎/渲染支撑）**：4 个 Trait/buff 特效（`haste`/`aura_heal`/`shield`/`slow`）的逐单位 loop 接入 + `summon` 接 `unit_spawned`/`building_spawned_unit`。前者需引擎补 buff 起止事件，或渲染层按单位 trait 状态轮询并维护 `play()` 句柄随单位存续/销毁。

### 部署 — Cloudflare 自动发布（2026-06-24，本地 `npm ci && npm run build` 通过）

编辑器作为纯静态前端站，复用 animator/ops 那套 **GitHub Action + npx wrangler + repo variable 开关**模式自动发布到 Cloudflare Workers（static assets，无 Worker 脚本）。

- **`wrangler/vfx.jsonc`（仓库根）**：Worker 名 `nivara-vfx`，`assets.directory` 指向 `./tools/vfx-editor/dist`，`not_found_handling: single-page-application`。
- **`.github/workflows/vfx-deploy.yml`**：push 到 main 命中 `tools/vfx-editor/**`（或 `wrangler/vfx.jsonc` / 本 workflow）触发，亦可 Actions 页手动 Run；`npm ci → npm run build → npx -y wrangler@4.104.0 deploy -c wrangler/vfx.jsonc`。`concurrency: vfx-deploy` 新跑取消旧跑。
- **secret 复用**：账号级 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（与 ops/client/animator 同值，无需新建）。vfx 编辑器**无 Supabase/后端依赖**，构建期不注入任何变量。
- **启用开关**：repo variable `VFX_DEPLOY_ENABLED = true`（未设则整个 job 跳过，避免配好前每次 push 报红）。设好后即随 vfx 改动自动发布。

### 覆盖率门禁 + 模块分层（ADR-070 Phase 4c，2026-08-20，已完成：typecheck / 136 单测 / production 构建三绿）

编辑器的覆盖率**百分比**从此受仓库 90% 门禁约束（此前只有「必须产出 coverage/」受门禁）。口径见 [ADR-070](../../DECISIONS_ADR-070-onward.md#adr-070-tools-覆盖率口径-scoped-include-与-reported-not-gated-过渡--accepted--2026-08-20) 与 [`claudedocs/tools-testing.md`](../../../claudedocs/tools-testing.md)；这里只记与本编辑器结构有关的部分。

- **`Playback` 从 `rendering/` 移进 `model/`**。§8 的设计期表把播放控制画在 UI 那侧（`ui/Timeline.ts`），实际落地时时钟单独成类、住在 `rendering/`——但它只有 `t`/`playing`/`duration` 三个字段加 `Math` 运算，无 PIXI、无 canvas、无 DOM；rAF 循环从外面读它，它从不反向伸手。**它不是渲染器，是编辑器状态**，所以现在是 `src/model/Playback.ts`。副作用是 `src/rendering/` 只剩 `PreviewRenderer.ts`，均质地是 PIXI 那一半，依赖方向单向 `model/ ← rendering/`。
- **实际落地的四层**（与 §8 设计期表的差异一并记在这里，那张表按当时的设想写着 `App.ts`/`ui/Timeline.ts`/`io/AutoSaveController.ts`）：

  | 层 | 文件 | 性质 |
  |---|---|---|
  | `src/model/` | `EffectModel.ts`（状态 + CRUD + undo/redo + 预算 metrics）、`Playback.ts`（预览时钟）、`color.ts`、`paramHints.ts` | **无 DOM**，纯逻辑/状态 |
  | `src/io/` | `IOController.ts`（导入/导出单个特效 JSON）、`ProjectStore.ts`（IndexedDB `nw-vfx`）、`Library.ts`（工作副本 + 选中项 + 防抖自动保存，即设计期表里的 `AutoSaveController`） | 用浏览器 API，但**能 headless 跑**（`fake-indexeddb` / `vi.stubGlobal` / Node 自带 `Blob`+`URL`） |
  | `src/rendering/` | `PreviewRenderer.ts` | 真 `new PIXI.Application`，无 headless harness |
  | `src/ui/` + `src/index.ts` | 四个面板 + 组合根（即设计期表里的 `App.ts`）、rAF 循环、splitter | `document.createElement` 装配 |

  前两层是 `coverage.include`（`['src/model/**','src/io/**']`，**100%：529/529 行、函数 76/80**），后两层出界。
- **`test/pureLayerBoundary.test.ts` 守这条边界**，且判据跟 map-editor/level-editor 那两份**不同**：本编辑器的 `src/io/**` 在门禁范围内，而它**理应**用 `window`/`document`/`localStorage`/`indexedDB`/`Blob`/`URL`——照抄「一律禁 DOM」要么是假话，要么得把 io/ 挤出 scope。所以判据是**能不能 headless 跑**，落成两层一套机制：`model/` 一律禁 DOM，`io/` 只许一份显式白名单的 global（`HTML*Element`、canvas/rAF/observer 一族、`performance` 照禁——io/ 可以跟浏览器说话，但不许造 UI）。另外两条：依赖方向 `io/ → model/` 单向；`coverage.include` 不许再出现逐文件项（4c 刚去掉最后一个）。往 io/ 加浏览器 API 就得改白名单，那正是该说清「它怎么 headless 测」的时刻。
- **导入/导出的行为契约（`IOController`，此前 0 测试，现 100%）**：导出前用游戏侧同一个 `parseEffectDef` 复核（§10 回写流程的那句「保证导出的 JSON 运行时一定能解析」现在有断言了），文件名取**校验后**的 id；有 File System Access 就走它、用户取消**不许**掉头去下载一个他刚拒绝保存的文件；没有就 `<a download>` + `URL.revokeObjectURL`。导入时「文件不是 JSON」（`JSON parse failed:`）与「JSON 不是合法特效」（`parse error in import`）是两条不同的消息，因为要修的东西不同；校验失败必须两条消息（解析器的具体抱怨 + 「Export blocked」的原因），只留后者会让美术不知道改哪儿。

**9094 实开做数值核对（不是截图）**：浏览器窗格不 composite，截图 5s 超时——但这个编辑器的预览是 **rAF 驱动**的，而隐藏的标签页里 `requestAnimationFrame` **根本不触发**（实测：注册一个回调后同步读回 `rafFired=0`；WebGL2 帧缓冲 600×400 全是清屏黑，非背景像素 **0** 个）。所以对本工具来说 `getImageData`/`readPixels` 采样这条退路也不成立，能核对的是 DOM 与数据这一侧（都是 rAF 无关路径，逐条通过）：

- `scrubTo` 契约：滑块 0/1/500/999/1000 → `t=clamp(v/1000,0,1)`、读数 `t=…` 两位小数、回写滑块 `round(t*1000)`，且每次都**暂停**（按钮回到 `▶ Play`）——纯模块「拖动即暂停，帧停住」那条契约。
- 真 `MouseEvent` 派到播放键 → `⏸ Pause` / `▶ Play` 往返；派到「+ 图层」→ JSON 面板 `layers` 3 → 4、新层类型等于下拉框选中值、metrics 的 `Layers` 行同步到 4；改 `duration` → JSON 面板 `duration=2` + metrics `Duration (s)2 / 2`。随后两次 Undo 把工作副本还原（3 层 / duration 1）。
- 导出两条路都在真浏览器里跑通，**逐字节**对上 JSON 面板内容（`JSON.stringify(def,null,2)+'\n'`）：File System Access 路径 `suggestedName=shield.json`、write 1 次、close 1 次、状态 `✓ Saved shield.json …`；删掉 `showSaveFilePicker` 后走 `<a download>`，`download=shield.json`、href 是 `blob:`、blob 类型 `application/json`、`revokeObjectURL` 收到的正是同一个 URL、状态 `✓ Downloaded …`。
- 三条失败/取消分支：JSON 面板 Apply 一个合法 JSON 但非法特效 → `✗ VFX parse error in json: duration must be > 0`；Apply 一段非 JSON → `JSON parse error:`（index.ts 自己的守卫，与上一条刻意不同源）；导入一个内容非 JSON 的文件 → `✗ JSON parse failed:`（`IOController` 自己的前缀）；用户取消打开对话框 → 状态不变，且**没有**创建任何 `<input type=file>` 回退（不会弹第二个对话框）。控制台与 dev server 日志无报错。
