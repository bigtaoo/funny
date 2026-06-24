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
| `emitter` | **（保留，本期不实现）** 位图粒子发射器 | 见 §13 | 将来史诗大招 |

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

## 13. 扩展位：位图粒子（方案 B，本期不实现）

数据模型已为粒子留好 `type: "emitter"` 图层类型。将来若出现"史诗大招 + 美术方向确认接受位图"的需求，只需：

1. 在 `primitives.ts`/`interpret.ts` 增 `emitter` 分支（发射、速度/重力积分、生命周期、批渲染）。
2. 引入 `art/vfx/*` 粒子贴图资产管线。
3. 编辑器加发射器参数面板 + 资产导入 + 实时模拟预览。
4. **种子化粒子随机**以维持确定性（§6 红线）。

emitter 参数草案（占位，未冻结）：`texture, rate, lifetime{from,to}, velocity{min,max,angleSpread}, gravity, startAlpha/endAlpha, startScale/endScale`。

> 在此之前，emitter 在解释器中是 no-op + 警告，编辑器不暴露该图元类型。

---

## 14. 分期与开放问题

**分期**
- ✅ P1：游戏侧 `vfx/` 核心（types/interpret/sampleParam/primitives/parseEffectDef）+ 现有 4 特效迁 JSON + `VFXSystem` 接解释器（**纯运行时重构，已落地**，§15）。
- P2：编辑器脚手架（端口 9094）+ 预览 + **特效列表面板** + 图层/参数面板 + **颜色盘** + JSON 往返 + 自动保存。
- P3：补齐法术/Trait 特效（§5）+ boil/种子随机图元能力打磨。

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
- `vfx/primitives.ts` —— 图元绘制：`ring/arc/spokes/burst/dots/polyline` 已实现；`text` 占位（需 PIXI.Text，留 P2/P3）；`emitter` no-op + 一次性警告（§13 保留位）；`text` 当时为占位，P1.1 已删。`spokes` 支持 `emphasisEvery`/`emphasisLineWidth`，`dots` 支持 `angleOffset`/`jitter`（种子随机）。
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
