# Notebook Wars — 关卡编辑器设计文档

> 创建：2026-06-12。本文件是关卡编辑器（`tools/level-editor`）的设计基准，随实现推进同步更新。
> 配套阅读：`code/CAMPAIGN_DESIGN.md`（战役模式 / 数据模型来源）、`code/DESIGN.md`（引擎/系统）、`tools/animator/ARCHITECTURE.md`（工程化参照）、根 `CLAUDE.md`。

---

## 0. TL;DR

- 一个**独立 Web 工具**（仿 `tools/animator` 的工程化），可视化编辑战役关卡 `LevelDefinition`，产出 / 回读 **JSON**。
- 所有战役关卡（含现有内置 CH1_LV1~3 + stress）统一为 **JSON 单一来源**，提交进仓库，由游戏 webpack 构建时打包。
- MVP 三件套：**波次时间线**（主菜）+ **棋盘格掩码绘制** + **表单字段**。MVP **不内嵌试玩**。
- schema / 棋盘常量**单一来源**在游戏侧，编辑器直接 import，不镜像副本。
- 渲染用**纯 Canvas / DOM**，不拉 PixiJS（无内嵌真实棋盘预览的需求前）。

---

## 1. 定位与边界

| 维度 | 说明 |
|---|---|
| 解决什么 | `LevelDefinition` 里真正"难手写"的两块——① **波次时间线**（多车道 × 多批次 × 时序）② **棋盘格掩码**（blocked/noBuild 坐标数组，脑内映射 12×18 易错）——给可视化编辑；其余是简单表单。 |
| 工具形态 | 独立 Web 工具，`tools/level-editor`，端口 **9092**（animator 占 9091）。 |
| 不做什么（MVP） | 不内嵌引擎试玩；不做运行时玩家导入（关卡走"提交进仓库、构建打包"流程）。 |
| 数据来源真值 | 数据模型与校验在**游戏侧**（`code/src/game/campaign/`），编辑器复用，绝不在编辑器内维护第二份易漂移的 schema。 |

---

## 2. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| L1 | 独立 Web 工具（仿 animator），TS + webpack | 复用现有工程化经验，与 animator 一致的心智模型 |
| L2 | 关卡产出 / 回读 **JSON**，运行时加载 | 热迭代快、可外部分发、编辑器可往返读写 |
| L3 | **所有关卡迁为 JSON 单一来源**（含现有内置 TS 关卡） | 避免"内置 TS + 编辑器 JSON"两套代码路径；编辑器能直接打开/编辑内置关卡 |
| L4 | 交付方式：**提交进仓库、构建打包** | 关卡随 app 发布，是正式内容流程；运行时玩家导入推迟到后续 |
| L5 | schema / 棋盘常量**单一来源在游戏侧**，编辑器 import | schema 不漂移；丢了编译期类型保护后，运行时校验是唯一兜底，必须只有一份 |
| L6 | 渲染用**纯 Canvas / DOM**，不上 PixiJS | MVP 无内嵌真实棋盘预览需求，纯 Canvas 更轻；将来需要真实预览再引 Pixi |

---

## 3. 棋盘几何（编辑器网格必须镜像，来源 `code/src/game/config.ts`）

| 常量 | 值 | 含义 |
|---|---|---|
| `BOARD_COLS` | 12 | 列 0–11 |
| `BOARD_ROWS` | 18 | 行 0–17 |
| `BASE_COLS` | [5, 6] | 基地列（双方基地占这两列） |
| `ATTACK_LANES` | [0,1,2,3,4,7,8,9,10,11] | 攻击车道（出兵只能落在这些列） |
| `BOTTOM_BUILDING_ROW` | 0 | 玩家建造行 |
| `BOTTOM_SPAWN_ROW` | 1 | 玩家出生行 |
| `TOP_SPAWN_ROW` | 16 | 敌方（PvE）出生行 |
| `TOP_BUILDING_ROW` | 17 | 敌方建造行 |

> 朝向：敌方从**顶部**（row 16 出生）向**底部**玩家基地推进。编辑器网格按此朝向绘制（顶=敌方，底=玩家）。
> 单位池：当前 `UnitType` = Swordsman / Archer / Guardian；未来扩 PvE 专属怪种，调色板从游戏侧枚举动态取，不硬编。

---

## 4. 数据模型（来源 `code/src/game/campaign/LevelDefinition.ts`）

编辑器编辑的就是 `LevelDefinition`，不复述完整字段（以游戏侧类型为准），编辑器对各字段的处理：

| 字段 | 编辑器交互 | MVP |
|---|---|---|
| `id` / `chapter` / `seed` | 表单输入框 | ✓ |
| `objective` | 下拉（`survive` / `timed_defense`），后者附 `durationTicks`（以秒输入，内部 ×30） | ✓ |
| `waves.entries[]` | **波次时间线**（§6.2 核心） | ✓ |
| `board.cellMask.blocked` / `noBuild` | **棋盘格绘制**（§6.1） | ✓ |
| `board.activeLanes` | 棋盘面板上禁用/启用整条车道 | ✓ |
| `startCoins` / `coinRegenMult` | 表单输入框 | ✓ |
| `loadout` / `bannedCards` | 卡牌多选（从游戏侧卡牌定义取列表） | ✓ |
| `rewards`（coins / starThresholds / unlockSkinId / unlockStoryKey） | 表单；`starThresholds` 三档 HP% | ✓ |
| `story.introKey` / `outroKey` | 文本框输入 i18n 键（**不校验是否存在于 zh.ts**，MVP 自由文本，留警示） | ✓ |
| `hazards[]` | 预留，MVP 不做可视化（可原样 JSON 透传保留） | ✗ |
| `crossWaypoints`（WaveEntry 内脚本化变道） | 预留，MVP 不做可视化 | ✗ |

> 原则：**MVP 不编辑的字段也不能丢**——读取时原样保留，导出时回写，避免编辑一次就抹掉预留数据。

---

## 5. 游戏侧改造（编辑器前置依赖，先于编辑器实现）

> 这部分在 `code/` 里做，是 L2/L3/L5 的落地，也是编辑器复用 schema 的基础。

1. **关卡迁为 JSON**：新建 `code/src/game/campaign/levels/`，把 `levels.ts` 里的 `CH1_LV1~3` + `CH_STRESS` 转成 `ch1_lv1.json` 等；`CAMPAIGN_LEVEL_ORDER` 保留（可用 `index.json` 列顺序，或 TS 常量数组）。
2. **运行时校验加载器** `code/src/game/campaign/levelSchema.ts`：
   - `parseLevelDefinition(raw: unknown): LevelDefinition`，逐字段校验：
     - `objective.kind ∈ {survive, timed_defense}`；`timed_defense` 需正 `durationTicks`。
     - `waves.entries[].unitType ∈ UnitType` 值集；`col ∈ ATTACK_LANES`；`count > 0`；`atTick / spacingTicks ≥ 0`。
     - `cellMask` 的每个 cell 在 `0..BOARD_COLS-1 × 0..BOARD_ROWS-1` 内。
     - `starThresholds` 单调、在 0–100。
   - 校验失败：抛带字段路径的明确错误（构建期 / 加载期都能定位）。
   - **丢了编译期类型保护，这个函数是唯一兜底**——schema 真值在此。
3. `levels.ts` 改为 import JSON → 过 `parseLevelDefinition` → 建注册表 `CAMPAIGN_LEVELS`。
4. `tsconfig.json` 开 `resolveJsonModule`（webpack JSON import）。
5. **Vitest**：加"所有内置 JSON 都能 `parseLevelDefinition` 通过"用例；黄金回放确定性测试不变（JSON 还原出的 `LevelDefinition` 与原 TS 逐字等价，同 seed 回放结果全等）。

---

## 6. 编辑器架构（`tools/level-editor/`）

### 6.1 棋盘格面板

- 12 列 × 18 行网格（纯 Canvas）。按 §3 朝向：顶部敌方、底部玩家。
- 底图分区着色：攻击车道 / 基地列（5,6）/ 双方建造行 / 出生行 用不同底色区分，一眼看清布局语义。
- 交互：点击/拖拽涂格 → 在 `blocked` / `noBuild` 之间切换（工具按钮选当前画笔）；整列开关 → `activeLanes`。
- 与时间线联动：选中某车道时高亮，方便对照该列的出兵。

### 6.2 波次时间线（核心）

- 横轴 = 时间（秒，刻度），纵轴 = 攻击车道（10 行）。参照 animator 时间线的渲染/交互模式。
- 每个 `WaveEntry` 是时间线上一个"出兵块"：起点 = `atTick`，块内 `count` 个单位按 `spacingTicks` 排开（可视化为 count 个小标记）。
- 单位类型用**带美术缩略图的调色板**（`infantry.png` / `archer.png` / `shield_bearer.png`，未来怪种动态扩）。
- 交互：拖动改 `atTick`、改车道改 `col`；选中块 → 侧栏编辑 `unitType / count / spacingTicks / isBoss`；右键删除 / 复制。
- 时间标尺可缩放/滚动（关卡时长可达 ~60s+）。

### 6.3 表单面板

- §4 表中标 ✓ 的简单字段，常规表单控件。
- 列表型（`loadout` / `bannedCards`）从游戏侧卡牌定义动态取选项。

### 6.4 导入 / 导出

- **导出 .json**：跑同一套 `parseLevelDefinition` 校验，通过才允许导出；File System Access API 弹原生保存对话框（仿 animator，Firefox fallback `<a download>`）。
- **导入 .json**：读文件 → `parseLevelDefinition` → 填充编辑器状态；能直接打开内置关卡（L3）。

### 6.5 与游戏侧共享（L5 落地）

- 编辑器 webpack `resolve` 加一条指向 `code/src/game/campaign/`（及 `config.ts` 棋盘常量、`types.ts` 的 `UnitType`、卡牌定义）的路径别名。
- 直接 import：`LevelDefinition` 类型、`parseLevelDefinition`、`UnitType`、棋盘常量、卡牌列表。
- 这些都是**纯数据 / 纯函数**（无 PIXI、无 DOM 依赖），跨项目 import 安全。若构建出现耦合问题，回退方案：把这批纯数据抽到一个共享子目录两边都 import（不在编辑器里手抄）。

---

## 7. 启动

```bash
cd tools/level-editor
npm run start   # webpack dev server，端口 9092
npm run build   # 生产构建
```

---

## 8. 分期实施路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P-A** ✅ | 游戏侧 JSON 化：迁移 4 个内置关卡 + `levelSchema.ts` + `levels.ts` 改加载 + Vitest（`resolveJsonModule` 本已开启） | 已完成：`tsc --noEmit` 0 错、`build:web` 通过、52 测试全绿（含校验器 9 例）；黄金回放确定性不变 |
| **P-B** ✅ | 编辑器骨架：webpack/tsconfig/html/端口 9092 + 共享 import 打通 + JSON 读写往返（裸 textarea 验证 loader） | 已完成：`@game/*` alias 直接 import `parseLevelDefinition`（ts-loader `transpileOnly`，bundle 仅 10.3 KiB 无 PIXI 膨胀）；浏览器内载入 ch1_lv1 → 校验 → 输出与输入深度相等；非法 unitType 触发带字段路径的错误 |
| **P-C** ✅ | 棋盘格面板：12×18 网格 + 分区着色 + 涂 blocked/noBuild + activeLanes | 已完成：中心化 `EditorState`（变更广播 + 规范化）；Canvas 网格（顶敌底己、分区着色、车道头开关）；noBuild/blocked/erase 画笔（点击 toggle + 拖拽）；实时双向 JSON。浏览器内验证三种画笔 + 车道开关产出排序/规范化 JSON，清空后 `board` 键自动消失 |
| **P-D** | 波次时间线（主菜）：时间轴 + 车道行 + 出兵块增删改 + 单位调色板 | 能可视化搭出一关完整波次并导出 |
| **P-E** | 表单字段 + 打磨（objective/经济/rewards/story/loadout/bannedCards） | 完整关卡编辑闭环 |

> P-A 独立且能立刻验证，先做。P-B 之后编辑器即可读写真实关卡，再按 P-C→P-D→P-E 加可视化深度。

---

## 9. 开放问题（待定）

- [ ] `CAMPAIGN_LEVEL_ORDER` 用 `index.json` 还是 TS 常量数组维护？（影响新增关卡是否要改 TS）
- [ ] story 键能否在编辑器侧做存在性校验（import zh.ts 的 `TranslationKey`）？还是保持自由文本。
- [ ] 时间线纵轴用"攻击车道"还是"波次组"分行——多车道同批次的可读性权衡。
- [ ] `hazards` / `crossWaypoints` 何时上可视化（当前原样透传保留）。
- [ ] 将来若要内嵌真实棋盘预览 / 试玩，是否引 PixiJS + 复用 `GameRenderer`。
