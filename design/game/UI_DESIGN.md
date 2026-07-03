# Notebook Wars — 客户端 UI 设计文档

> 创建：2026-06-13。本文件是元系统 / 联机相关**客户端 UI** 的设计基准（场景、组件、导航、网络态、美术资产、i18n）。
> 配套：`META_DESIGN.md`（系统/数据）、`META_TASKS.md`（任务）、`DESIGN.md`（引擎/渲染）。
> 现有场景参考：`src/scenes/LobbyScene.ts`（笔记本风格基准实现）、`SceneManager.ts`、`layout/ILayout.ts`。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **笔记本/手绘风** | 米色纸底 + 横线 + 红色页边线 + 等宽字体（monospace）。沿用 `LobbyScene` 的 `C` 调色板，不另起视觉体系 |
| **设计空间 + Contain 缩放** | 所有坐标用设计空间：竖屏 1080×1920、横屏 1920×1080；`ScalingManager` 单比例映射到真机。场景内用 `layout.designWidth/Height` 的**百分比**布局（见 `LobbyScene.build()`） |
| **双朝向自适应** | 每个菜单场景都要在竖屏/横屏下成立：竖屏纵向堆叠、横屏左右分栏。用 `layout.orientation` 分支或纯百分比让其自然伸缩 |
| **触屏优先** | 命中区够大（≥ 设计空间 ~80px 高）；列表用滚动而非密集排布；复用 `InputManager.onDown` |
| **零硬编码文案** | 全走 `t(key)`，`zh.ts` 唯一来源，`en`/`de` 编译强制全翻 |
| **网络态可见** | 联机/同步/加载/失败都有明确视觉反馈，不留"卡死"歧义（§6） |
| **返回固定左上**（硬约定） | 所有非大厅场景的返回按钮一律放**左上角标题栏**，坐标/命中区统一（见 §3.1）。禁止各场景自行决定放左下/右上等 |
| **画一次，缓存复用**（硬约定） | 程序绘制的共享部件（返回按钮、NavBar、货币条、卡片框、rarity 边框等）首次绘制后**烘焙为 texture/sprite 缓存**，后续直接 `new PIXI.Sprite(cachedTexture)` 复用，不每次重跑绘制路径（见 §2.1） |

### 调色板（沿用 LobbyScene `C`）
`bg #f5f0e8` / `paper #faf6ee` / `line #c8d8e8` / `margin #ffb3b3` / `dark #2c2c2a` / `mid #888` / `accent #4477cc` / `gold #cc9900` / `red #cc3333`。新增建议：`green #4a9` (成功/可购买)、`rarity` 四色（common 灰 / rare 蓝 / epic 紫 / **legendary 橙** `#e08a2c`）。

---

## 2. 通用组件套件（建议抽到 `src/ui/widgets/`）

复用性强的 PIXI 小部件，各场景共享，避免每个场景重画一遍：

| 组件 | 职责 | 备注 |
|---|---|---|
| `Button` | 圆角矩形 + 居中文字 + enabled/disabled/按下态 | 抽 `LobbyScene.drawBtn` |
| `Panel` | 纸卡（圆角 + 描边 + 左侧 accent 条） | 抽 `buildPlayerCard` 的卡片样式 |
| `CurrencyBar` | 右上角货币余额（图标 + 数字 + "＋"跳转商店） | 全菜单常驻；只读 `SaveData.wallet`（服务器回推） |
| `ScrollList` | 垂直滚动容器（clip + 拖拽/滚轮） | 参考 `tools/animator` TimelineView 的滚动实现 |
| `Modal` | 半透明遮罩 + 居中卡 + 确认/取消 | 购买确认、解锁弹窗、错误提示 |
| `Toast` | 顶部短暂浮条（领奖/错误/同步成功） | 自动淡出 |
| `Spinner` | 加载圈 / "matching..." 点点 | 抽 LobbyScene 的 dots 动画 |
| `StarRow` | ★★★ 星级显示（空/亮） | 选关、结算复用 |
| `RarityFrame` | 按 rarity 上四色描边/光效 | 盲盒、收集册、商店复用 |
| `NavBar` | 底部 5 槽导航 | 已在 LobbyScene，提取为共享组件（§3） |

> 这些组件统一放 `client/src/ui/widgets/`。**已落地（2026-06-25）**：`uiCache.ts`（§2.1 缓存底座）+ `SceneHeader.ts`（§3.1 统一返回/标题栏）。其余组件（Button/Panel/CurrencyBar/…）随后续场景按需沉淀到此目录。

---

## 2.1 组件缓存约定（draw-once → cache → reuse）

**问题**：现状每个场景在 `build()` 里用 `SketchPen`/`sketchUi` 重画一遍返回按钮、卡片框、边框等，既慢又导致同一个部件在不同场景长得不一样。

**约定**：凡是「外观固定、被多处复用」的程序绘制部件，走「画一次 → 烘焙纹理 → 复用 sprite」：

1. **绘制一次**：用 `PIXI.Graphics` 按设计空间尺寸画出部件。
2. **烘焙为纹理**：`renderer.generateTexture(graphics)` 得到 `RenderTexture`，存进**模块级缓存** `Map`，key = `部件名 + 尺寸 + 变体(enabled/disabled/rarity 色等)`。
3. **后续复用**：命中缓存直接 `new PIXI.Sprite(tex)`，只设 `x/y`，不再跑绘制路径。
4. **失效**：缓存按 key 区分尺寸/朝向；`ScalingManager` 设计空间是定值，正常无需失效。仅当部件视觉定义改动时清缓存（开发期可加 `__clearUiCache()`）。

实现建议：在 `ui/widgets/` 下放一个 `uiCache.ts`，导出 `getCachedTexture(key, draw: () => PIXI.Graphics)`：命中返回缓存，未命中则 `draw()` → `generateTexture` → 存表 → 返回。各组件内部统一走它。

> **手绘抖动注意**：笔记本风的手绘抖动（stroke jitter）一旦烘焙就被冻结，同一部件每个实例长一样。这对 UI chrome（按钮/边框）正是我们要的**一致性**，且省 CPU；只有需要"每次不同抖动"的装饰元素才不缓存。
>
> **依赖 renderer**：`generateTexture` 需要 `renderer` 句柄。组件套件初始化时由 `MenuShell`/App 注入一次，缓存模块持有引用即可。

> **已落地（2026-06-25）**：`client/src/ui/widgets/uiCache.ts`，导出 `getCachedTexture(key, draw, w, h)` 与 `getCachedDisplay(key, draw, w, h)`。它是 `render/bake.ts` 新增的 `bakeLazy(key, draw, w, h)` 的薄封装——renderer 仍由 `app.ts` 的 `setBakeRenderer` 一次性注入、纹理 `Map` 仍在 `bake.ts`；与原 `bake()` 的区别是**命中缓存时不调用 `draw()`**（零开销），未命中才 `draw → render → 存表 → 销毁源对象`。headless（无 renderer）自动回退 live draw，调用方无需分支。key 约定 `部件+尺寸+变体`；含文案的部件须把已解析文案折进 key，避免运行时切语言后取到冻结纹理。

---

## 3. 导航结构

底部 `NavBar` 已有 5 槽（`lobby.nav.*`：cards / stats / home / shop / social）。映射到元系统场景：

```
[ Cards ]   [ Stats ]   [ Home ]   [ Shop ]   [ Social ]
  收藏中心     战绩       大厅      商店/盲盒    好友房
Collection  Stats     Lobby    Shop/Gacha    Room
```

> **已落地（2026-06-15）**：五格全部接好。Cards → **收藏中心**（CollectionScene 双 Tab：卡牌图鉴只读 + 皮肤衣柜）；Stats → **StatsScene**（本地存档：排位/战役/收集+材料 + 对战历史占位）。Cards/Stats 读本地存档、离线可用不门控；Shop/Social 花服务器权威币/联机，离线路由登录。对战历史段待第二步服务端 `GET /match/history`。

完整场景流（扩展 `META_DESIGN.md §7.1`）：

```
启动 →(首次)Intro→ LobbyScene ┬─ Home   = 大厅（PvP匹配 + 战役入口 + 每日）
                              ├─ Cards  → CollectionScene  收藏中心（卡牌图鉴 + 皮肤衣柜）
                              ├─ Stats  → StatsScene        战绩（排位/战役/收集 + 对战历史）
                              ├─ Shop   → ShopScene ⇄ GachaScene
                              └─ Social → RoomScene         好友房

大厅「战役」 → CampaignMapScene → LevelPrepScene → GameScene(战斗) → ResultScene
好友房开打   → GameScene(联机锁步) → ResultScene
```

> 切换由 `SceneManager.goto()` 完成。常驻元素（NavBar + CurrencyBar）建议挂在 SceneManager 之上的持久层，或每个菜单场景统一 build，避免切场景闪烁。**推荐**：菜单场景共享一个 `MenuShell` 基类（建 bg + NavBar + CurrencyBar），各场景只填中间内容区。

---

## 3.1 返回按钮硬约定（统一位置）

所有非大厅二级场景（Shop/Gacha/Collection/CampaignMap/Auction/Profile/Friends/…）的返回按钮**一律左上角标题栏**，由共享 `SceneHeader`（或 `MenuShell` 顶栏）统一渲染，**禁止各场景自定义位置**：

| 项 | 规格（竖屏 1080×1920 设计空间；横屏等比） |
|---|---|
| 位置 | 标题栏左端，`x = 10`、垂直居中于标题栏 |
| 文案 | `← ` + `t('common.back')`（统一 key，色 `C.accent`） |
| 命中区 | 左上角 `{ x: 0, y: 0, w: 160, h: HEADER_H }`，比可见文字大以保证触屏好点 |
| 行为 | 调用 `cb.onBack()`；返回上一场景由 `SceneManager` 处理 |
| 标题 | 返回按钮右侧，居中或左对齐于标题栏 |

> 大厅（LobbyScene）用底部 NavBar 切换，不出现返回按钮；战斗内（GameScene）用暂停/退出而非返回，均不受此约定约束。
>
> **落地方式**：返回按钮走 §2.1 纹理缓存（`back` 部件烘焙一次复用）。迁移时各场景删掉自绘返回逻辑，改挂 `SceneHeader`。

> **已落地（2026-06-25）**：`client/src/ui/widgets/SceneHeader.ts`。
> - API：`drawSceneHeader(container, w, h, title, opts?)` → `{ headerH, backRect }`。顶栏 chrome（底 + 左上返回 glyph）作为**整块经 §2.1 缓存**（缓存键含 variant/朝向/语言，同类只烘焙一次复用）；标题为每场景动态文本，live 绘制。返回文案统一 `'← ' + t('common.back')`（色 `C.accent`），命中区固定 `{0,0,160,headerH}`。各场景保留自己的 hit 数组，只把 `hdr.backRect` push 进去（不强求统一 hit 结构）。
> - `title` 传 `null` 时只画 chrome、不画标题（供有副标题需抬升标题的场景自绘，如 CampaignMap）；`opts.titleSize`/`opts.headerH` 用于保真个别场景的大标题/矮栏（如 Settings/Titles 0.042、Chat 0.11 栏高）。
> - `opts.variant`（`'dark'` 默认 / `'paper'`）：`'paper'` = `sketchPanel` 纸面底（`C.paper` 填充 + `C.mid` 手绘边）+ 深色标题，供 SLG/编辑器场景（其正文坐在纸面背景上）使用；返回在左、标题居中，右侧留空可由调用方在 chrome 之上自绘控件（如 DefenseEditor 的基地等级 stepper）。`'dark'` = 实心深色底 + 白色标题。
> - **已迁移（14 个标准深色顶栏菜单场景）**：Achievement / BattlePass / Collection / Gacha / Friends / Leaderboard / Stats / Shop / Settings / Titles / Room / LevelPrep / CampaignMap / Chat。统一新增 i18n `common.back`（原各场景 `xxx.back` 键保留未删，部分仍被未迁场景使用）。
> - **已迁移（6 个 SLG/编辑器纸面顶栏场景，2026-06-25，variant `'paper'`）**：Auction / Equipment / Family / Sect / Teams / DefenseEditor。各自传自己固定的 `HUD_H`/`HEADER_H` 作 `opts.headerH`（正文布局沿用该常量不动）+ `titleSize`（15 / 14）。DefenseEditor 的基地 stepper 仍由场景自绘在 chrome 右侧之上。
> - **仍未迁**：底部 HUD 的 WorldMap（非顶栏）；无深色顶栏的纸面浮动返回（Daily / Event）；LoginScene（返回仅在 password/register 视图条件出现，属登录前流程）。

---

## 4. 菜单场景规格

> 以下用竖屏（1080×1920）描述，横屏为左右分栏变体。坐标均为百分比示意。

### 4.1 LobbyScene（大厅，扩展现有）
现状已有：标题栏 / 三 feature 块 / 匹配按钮 / 战役 1-4 选关 / NavBar / VS 遮罩。**扩展**：
- 顶部加 `CurrencyBar`。
- "战役"按钮改为跳 `CampaignMapScene`（替代当前直接 1-4 数字选关；旧选关可保留为 debug）。
- 加「好友对战」入口 → `RoomScene`。
- （S2 后）加「每日奖励」红点入口。

### 4.2 RoomScene（好友房，S1）
```
┌──────────────────────────────┐
│  ← 返回         好友对战        │  标题
├──────────────────────────────┤
│   ┌────────┐    ┌────────┐    │
│   │ 创建房间 │    │ 加入房间 │    │  两大按钮（idle 态）
│   └────────┘    └────────┘    │
├──────────────────────────────┤
│  房间码:  [ A 7 K 9 ]  📋复制   │  建房后显示
│                                │
│  房主: 你          ✓ ready     │  双方槽位
│  对手: (等待加入…) ○            │
│                                │
│        [ 准备 / 开始对战 ]       │  双方 ready 后房主可开
└──────────────────────────────┘
加入态：输入 4 位房间码（数字键盘/字母）→ 连接中 spinner → 进房
```
- 状态机：`idle → creating/joining → in-room(waiting) → both-ready → countdown → GameScene`。
- 网络态：连接中 spinner、加入失败（房间不存在/已满）Toast、对手掉线提示。
- i18n：`room.*`。

### 4.3 ShopScene（商店，S2）
```
┌──────────────────────────────┐
│ ← 返回   商店      💰 1,250 ＋  │  CurrencyBar
├──────────────────────────────┤
│ [皮肤] [道具] [盲盒] [充值]     │  分类 Tab
├──────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐    │
│ │ 皮肤A │ │ 皮肤B │ │ 道具C │    │  商品网格（ScrollList）
│ │ rarity│ │       │ │       │    │  RarityFrame 描边
│ │ 💰 300│ │ 💰 500│ │ 💰 80 │    │  价格；已拥有显示"已有"
│ └──────┘ └──────┘ └──────┘    │
└──────────────────────────────┘
点商品 → Modal 购买确认（预览 + 价格 + 余额够否）→ 服务器扣币 → Toast + 余额刷新
余额不足 → Modal 引导去「充值/看广告」
```
- 商品来自服务端 `shopItems`；购买走 `EconomyClient`（服务器权威，§META S2-2）。
- i18n：`shop.*`。
- **充值码 overlay**：Canvas 画伪输入框，背后挂隐藏 `<input>` 捕获键盘。光标用 `|` 以 0.5s 交替闪烁；空输入时光标-on 显示 `|`、光标-off 显示 placeholder，确保聚焦即可见光标（不依赖已有字符才显示）。
- **充值档位图标**：每档左侧画随金额升级的宝藏图标（`coin`→`coins`→`coinStack`→`coinSack`→`coinChest`，见 `render/icons.ts`），越贵越有料，替代千篇一律的 `◎` 文字提升转化诱惑。手绘 SketchPen 笔触 + 金币扁平淡金填充（守三笔风、无渐变），走 `buildIcon` 贴图缓存。

### 4.4 GachaScene（盲盒，S2）
```
┌──────────────────────────────┐
│ ← 返回   盲盒       💰 1,250 ＋ │
├──────────────────────────────┤
│        ╔════════════╗          │
│        ║  盲盒大图    ║          │  当前池
│        ╚════════════╝          │
│   保底进度: ▓▓▓▓░░░░ 42/90     │  pity 条
│                                │
│  [ 单抽 💰100 ]  [ 十连 💰900 ] │  十连折扣
├──────────────────────────────┤
│  开箱动画：卡片翻转 → rarity 光  │  legendary 特效更炫
│  结果列表：本次获得 / 重复转化    │
└──────────────────────────────┘
```
- 抽卡走服务端（扣币 + 真随机 + 落库 + 保底，§META S2-3）；客户端只播动画 + 展示结果。
- 重复物品按 `dupePolicy` 显示"转碎片/退币"。
- i18n：`gacha.*`。

### 4.5 CollectionScene（收集册/衣柜，S3）
```
┌──────────────────────────────┐
│ ← 返回   收集册                 │
├──────────────────────────────┤
│ [普通兵] [弓箭兵] [盾兵] [...]  │  按单位 Tab
├──────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
│ │皮肤1│ │皮肤2│ │ 锁 │ │ 锁 │  │  皮肤网格；未拥有灰显/锁
│ │已装备│ │    │ │    │ │    │  │
│ └────┘ └────┘ └────┘ └────┘  │
├──────────────────────────────┤
│   ┌──────────┐                │
│   │  大预览    │  [ 装备 ]      │  选中皮肤大图 + 装备按钮
│   └──────────┘                │
└──────────────────────────────┘
```
- 装备写 `SaveData.equipped`（纯外观，客户端同步段）；渲染层 `UnitView`/`StickmanRuntime` 按 equipped 选贴图。
- i18n：`collection.*`。
- **滚动（2026-06-27）**：三个 Tab（卡牌图鉴 / 皮肤衣柜 / 单位卡）内容数量都会超出一屏，原先平铺无裁剪导致超出部分看不到。改为 tab 栏以下整块内容画进带 mask 的 `layer` 容器，拖拽改变 `scrollY` 平移 `layer`（模式同 `ChatScene`）；`maxScroll` 由内容实际高度算出并夹紧、底部留 padding。命中检测：点击改在 pointer-up 触发，拖动 > 8px 视为滚动不点；内容命中（装备 / 合成）标记 `scroll: true`，命中时对指针 y 做滚动偏移补偿并忽略落在 tab 栏区域的误触。切 Tab 时 `scrollY` 归零。
- **内容图标化（2026-06-27）**：三个 Tab 原先纯文字，既累眼又「和游戏内容对不上」。改为：
  - **卡牌图鉴**：卡片标题左侧显示**真实卡牌立绘**（与战斗手牌 `HandView` 同一张 png），名称/类型行右移让位。立绘 url 映射 + `cardArtKey()` 从 HandView 抽到 `render/cardArt.ts` 作单一真源，两端 import 同一份，杜绝「图标和游戏里对不上」的困惑。法术立绘已烤红马克笔重点，显示**不 tint**。
  - **单位卡**：每行最左侧显示**单位立绘**（`cardArt.UNIT_ART_URLS`：infantry/archer/shieldbearer + Anna 的 max/lena/mara，六张 png 齐全），名称/等级右移。
  - **皮肤衣柜**：皮肤是服务器侧 id、无立绘数据，保留**手绘图标**（`icons.ts`：默认外观=铅笔 `pencils`，已拥有皮肤=笔刷 `brush`，已装备转绿）。
  - 立绘纹理异步解码、本场景是静态渲染：`drawArtFit()` 在纹理未 valid 时跳过本帧并挂一次性 `baseTexture.once('loaded', render)`，加载完重绘（战斗通常已暖共享纹理缓存，少触发）。
- **属性行图标化（2026-07-03）**：图鉴卡片的关键属性原是一行 `HP 100 · ATK 20 · Range 3` 纯文字。改为 glyph+数值 chip 行：HP=心形（`icons.ts` `hp`）、ATK=刀刃（`atk`），Range 无对应字形保留短文字标签兜底。`cardStatsLine()`（拼字符串）重构为结构化 `cardStats()` + `drawStatChips()`（整行超宽等比缩放塞进 tile）。

### 4.6 ProfileScene（档案，S0/S3）
- 账号信息（匿名 id / 昵称）、云同步状态（已同步/同步中/离线，含「手动同步」按钮）、成就墙（后续）、设置入口（语言/音量，复用 i18n）。
- i18n：`profile.*` + 复用现有 `settings.*`。

### 4.7 CampaignMapScene（选关地图，S3）
```
┌──────────────────────────────┐
│ ← 返回   第一章 · 剑士的来历     │  章节标题
├──────────────────────────────┤
│        (1)───(2)───(3)         │  关卡节点图（ScrollList 可滚）
│         ★★★   ★★    ★          │  StarRow
│                │               │
│              (4 锁)            │  未解锁锁态
├──────────────────────────────┤
│  [ 章节故事 ▶ ]                 │  播 IntroScene 风格叙事
└──────────────────────────────┘
点已解锁关 → LevelPrepScene
```
- 节点解锁/星级读 `SaveData.progress`；章节故事复用 `IntroScene` 逐行淡入模式（`story.*`）。

### 4.8 LevelPrepScene（关前编成，S3）
- 关卡目标摘要、关前 loadout（若关卡限定卡池）、PvE 养成等级预览、`[开打]`。
- 进 `GameScene`（campaign 模式）。

### 4.10 StatsScene（生涯/战绩）

**朝向自适应布局（2026-06-28）**：用 `layout.orientation` 分支。

**横屏（1920×1080）— 左右两列**：
```
外边距 pad = w*4%，列间距 colGap = w*2.5%
左列 54%：排位对战 / 战役进度（上下堆叠）
右列 46%：收集 / 对战历史（上下堆叠）
```

**竖屏（1080×1920）— 单列**：
```
外边距 pad = w*4%，四个 section 纵向堆叠
```

各 section 用 `drawSection()`：手绘面板 + 左侧色条（`sketchAccentBar`）+ 标题 + label:value 行。  
行高 `h*3%`，标题高 `h*3.4%`，文字大小随高度比例，命中区 `InputManager.onDown` 统一处理（可点行注册至 `hits[]`）。

### 4.9 ResultScene（结算，扩展现有）
现状已有。**扩展**：评星动画（StarRow 逐颗点亮）、奖励发放（材料/物品 Toast）、解锁弹窗（新关/新皮肤 Modal）、（联机）胜负 + 段位变化。

#### 4.9.1 按钮主次 + 图标 + 背景涂鸦（2026-06-27）
结算页动作区重排为「一个主 CTA + 一行次要入口」，所有按钮配手绘图标：
- **主按钮**：`再来一局`（胜利时文案换 `再战一场`）——大、`ui.gold` 金色填充、白色粗体、配 `swords`(交叉刀) 图标，视觉首位。
- **次按钮**（底部横排一行，纸色幽灵风：描边 + 墨色字 + 小图标）：`观看回放`(`replay`) / `分享`(`share`) / `返回大厅`(`home`)。回放、分享条件性显示；返回大厅仅在「再来一局 ≠ 回大厅」时常驻（见下）。
- **行为：天梯 PvP「再来一局」= 重进匹配**（旧实现里它其实回大厅）。`createAppCore.finishNet`：天梯局 `onPlayAgain = 关 session → goRoom({autoRanked})`（进排队 UI，可取消），并补 `onReturnToLobby = goLobby` 作为显式出口；好友/AI 局维持「再来一局 = 回大厅」，不显示返回大厅次按钮。
- **背景情绪涂鸦**（`addMoodDeco`，低 z 序藏在文字/按钮后）：胜利→暖金四角星点；失败→断铅笔 + 红笔划叉（呼应"红笔批改"美术母题）；平局→角落中性等号。
- 新增图标：`icons.ts` 的 `swords/replay/share/home`（SketchPen 线稿，烘焙缓存）；i18n 新增 `result.toLobby` / `result.playAgainWin`（三语）。

#### 4.9.2 结算页 deco 丰富（2026-06-30）
结算页引入与大厅/对战一致的手绘涂鸦层，解决页面太空旷的问题：
- **C-group 背景散点**（`buildDecorCLayer`）：与大厅 LobbyScene 完全相同的城堡/弹射器/纸飞机/墨迹图集，铺满全屏（alpha 0.25–0.38，bake 静态纹理）。
- **A-group 边距涂鸦**（`buildMarginDeco`，新增私有方法）：左右各 11% 纸边放置对战同款小涂鸦（太阳/星/心等，alpha 0.30–0.50），seed `0xDEADBEEF`，bake key `result-margin:WxH`。
- **战败 mood deco 增强**：原 2 个红叉扩充为 5 个，分布到左上/左下/右下三角，强化「红笔批改」美术母题。
- 两层 deco 均 `interactiveChildren = false`，不干扰按钮点击。

#### 4.11 菜单奖励/属性图标化推进（2026-07-03，批①）

用户反馈「很多界面还是纯文字，更喜欢图标化」。第一批复用**现成** `icons.ts` 字形（零新增图标定义），把养成/成就侧的奖励与属性文字换成手绘 glyph：

- **DailyScene（签到）**：签到日历格子的金币奖励由 `+30c` 文字改为 `coin` 字形 + 数字；体力奖励无对应字形，保留 `+N` 文字。
- **BattlePassScene（战令）**：双轨奖励格由 `rewardCoins/rewardMaterial` 文案改为类型 glyph + `×N`——`coins`→`coin`、`material` 按 `id` 映射 `scrap/lead/binding`、`skin`→`brush`（皮肤为单件，仅 glyph 不带数量）。`drawCell` 的 reward 形参补 `id?`。
- **EventScene（活动）**：兑换奖励条在原文字标签前加类型 glyph 前缀（coin/材料/brush，可映射时），保留文字名，信息不丢。
- **AchievementScene（成就）**：分类 Tab 加类别字形（`pve`→`book` / `pvp`→`swords` / `collection`→`brush` / `progression`→`trophy`）；未达成档位的奖励由「reward N coins」文字改为 `coin` 字形 + 数字。
- **CollectionScene**：见 §4.5 属性行 chip。
- 全部走 `buildIcon` 烘焙缓存共享纹理，销毁经各场景既有 `tearDownChildren`（Sprite 走 `{children:true}`、`texture:false` 不碰共享纹理，符合防泄漏契约）。验证：`tsc --noEmit` + `build:web` + `test:ui`（85 例）全绿。
- **待批②（需新增图标定义或谨慎布局）**：CardScene/TeamsScene 无属性文字、装备槽缺 `trinket` 字形；CityScene/WorldMapScene 的 SLG 资源与 GachaScene 稀有度、`event/battlepass` 的 `pass_required` 🔒 均需新字形。

#### 4.12 CityScene 图标化（2026-07-03，批②）

主城界面此前满屏 emoji（资源条 🖊📄✏️🔩🏷、建筑格 🗂🖊…🏯📚、队列 🔨）。本批全部去 emoji：

- **资源图标**：SLG 的五种资源即五种文具（ink/paper/graphite/metal/sticker，**非**粮/铁/木——那是 `project_currency_canon` 的口头称呼，实际 `ResourceType` 走文具母题）。这五种已有 `res_atlas` 手绘母题（`WorldMapScene` HUD 已复用），故资源条 + 升级消耗行直接复用 `getResTexture`，**零新增资源图标**。emoji 仅作 atlas 解码前的兜底（atlas 为模块单例，进城前通常已由地图加载）。
- **建筑图标**：五座产出建筑（inkPot/paperTray/graphiteMill/metalForge/stickerShop）复用其产出资源的 `res_atlas` 母题（建筑↔资源视觉强关联，零新增）；drillYard→`swords`、wall→`castle`、academy→`book` 复用现成 `icons.ts` 字形；仅 HQ **desk** 与仓库 **cabinet** 两座新增手绘字形。
- **新增 `icons.ts` 字形（3 个）**：`desk`（桌面+左腿+右抽屉柜带把手）、`cabinet`（三抽屉档案柜）、`hammer`（建造队列角标，斜柄+锤头）。
- **升级消耗行**：原 `🌾100✓` 拼字符串改为「文案 + 每资源(母题 + 数量)」横排布局，数量在不足时染红（替代 ✓/✗ 符号）。
- 解析走两个 helper：`resIcon(rt,size)`（atlas sprite 兜底 emoji）、`bldIcon(key,size,color)`（producer→atlas / 其余→`buildIcon` / 兜底 emoji）。`load()` 追加 `loadResAtlas().then(render)`。
- 验证：`tsc --noEmit` + `build:web` 全绿。

#### 4.13 AuctionScene 图标化（2026-07-03，批③-拍卖）

拍卖行的物品类型与挂单模式此前全是文字。本批**零新增图标定义**，复用现成 `icons.ts` 字形：

- **物品类型字形**：equipment→`armor`（盾）、card→`cards`（卡叠，批③-Tab 导航新增）、material→其对应材料字形（`scrap`/`lead`/`binding`）。走 helper `itemKind(itemType, material?)`。
- **挂单模式字形**：fixed（一口价）→`tag`（价签，批③-Tab 导航新增）、auction（竞拍）→`hammer`（复用主城建造锤当拍卖槌）。走 helper `saleModeKind(mode)`。
- **落点**：① 市场列表行左侧加类型字形（标签右移到 x=40，价格/一口价行同步右移）；原 `[竞拍]` 文字标记改为行内模式字形（竞拍红/一口价灰）。② 顶部筛选 chip（材料/装备/角色卡）加字形前缀，`全部` 保持纯文字。③ 创建挂单表单的物品类别选择器 + 挂单模式选择器按钮加左侧小字形。
- 依赖批③-Tab 导航（commit `e3118841`）已落地的 `tag`/`cards` 字形。
- 验证：`tsc --noEmit` + `build:web` 全绿。

#### 4.14 GachaScene 图标化（2026-07-03，批③-抽卡）

抽卡界面的稀有度与卡池类型此前靠纯色圆点 + 文字。本批新增 **1 个** `icons.ts` 字形 `star`（实心五角星 + 细手绘描边，按稀有度色 tint），其余复用现成字形：

- **稀有度星级**：`RARITY_STARS` 映射 common=1 / rare=2 / epic=3 / legendary=4 星。① Banner 下方图例：每档稀有度画 N 颗 tint 星（星尺寸按「4 星一行塞进 82% 组间距」自适应，避免相邻档重叠）。② 赔率详情弹窗每行的稀有度圆点改为单颗 tint 星。
- **卡池类型徽标**：Banner 左上角加类型徽标——限定池→金色 `star`、常驻池→`capsule`（抽卡扭蛋球，复用批③-Tab 导航字形）。
- 全走 `buildIcon` 烘焙缓存；`ⓘ` 详情按钮为排版符号非绘文字，保留。
- 验证：`tsc --noEmit` + `build:web` 全绿。

至此批③（Tab 导航 / 拍卖 / 抽卡）+ 批②（主城）+ 批①（菜单奖励/属性）覆盖：主城、拍卖、抽卡、Tab 导航、养成/成就侧奖励属性全部去 emoji 图标化。

#### 4.15 锁定徽标统一（2026-07-03，批④）

四处「已锁定」状态各自用 🔒 emoji（拍卖挂单选择器的锁定卡 / 装备行锁定标 / 卡组构建未解锁卡 / 战令 `pass_required` 档）。新增 **1 个** `icons.ts` 字形 `lock`（挂锁：拱形锁梁 + 锁体 + 锁孔），四处统一 `buildIcon('lock', …)`：

- AuctionScene 卡片选择器锁定卡、EquipmentScene 装备行锁定标：行内小锁（14px，左上锚点）。
- DeckBuilderScene 未解锁卡：卡片右上角锁徽标（右上锚点→左移一个 lockSz）。
- BattlePassScene `pass_required` 档：格子右下角金锁；原共享文本路径拆成「pass_required 画锁 / 其余画文字」两支，底部右锚点不变。
- 验证：`tsc --noEmit` + `build:web` 全绿。

#### 4.16 排行榜名次奖牌（2026-07-03，批⑤）

LeaderboardScene 前三名用 🥇🥈🥉 emoji。新增 **1 个** `icons.ts` 字形 `medal`（绶带 + 双环奖牌盘），前三名改 `buildIcon('medal', …)` 按名次 tint 金(0xf0c040)/银(0xc2c6cc)/铜(0xcd8a4b)；第 4 名起保留 `#N` 文字。验证：`tsc --noEmit` + `build:web` 全绿。

#### 4.17 收尾去 emoji + 排版符号图标化（2026-07-03，批⑥）

批①–⑤ 的收尾批：清掉剩余彩色 emoji、把文字星 `★/☆` 换成现有 `star` 字形，并把遍布各弹窗的排版符号 `✕/✓/▶` 统一为手绘字形。新增 **5 个** `icons.ts` 字形：`zoom`（放大镜：镜片环 + 斜柄）、`gift`（礼盒 + 缎带蝴蝶结）、`close`（✕ 双斜笔）、`check`（✓ 两段勾）、`play`（▶ 实心三角 + 描边）。

- **彩色 emoji 去除**：WorldMapScene 缩放按钮 🔍→`zoom` 字形 + ×N 文字；训练面板资源 🖋️📄✏️🔩⭐ 改复用 `res_atlas` 母题贴图 + 数值（与 HUD 资源行同款，atlas 解码前退回 emoji 兜底）；FriendsScene 邮件附件 🎁→`gift` 字形前缀。
- **文字星 → `star` 字形**：CampaignMapScene 章节进度 `★ N/M` 与关卡三星行（已得金/未得 `btnOff` 灰）、StatsScene 战役星数行（`Row.valueIcon` 新增可选字段）、WorldMapScene 国家列表首府星标。
- **排版符号 → 字形**：`✕` 关闭键（WorldMapScene `showModal` 按钮渲染器统一特判 11 处；FriendsScene `addButton` 特判；AuctionScene ×3 / FamilyScene ×2 / SectScene ×2 独立按钮）改 `close` 字形；`✓` 勾（DailyScene 签到戳、DeckBuilderScene 选中角标、CardScene/EquipmentScene 的 `[✓]/[ ]` 复选框改「墨框 + 选中叠 `check`」、LoginScene 校验行满足态）改 `check` 字形；`▶` 播放（StatsScene 回放行提示、StatePlayerScene 回放标签）改 `play` 字形。CardScene/EquipmentScene 复选框未选态画空心墨框；LoginScene 未满足态保留 `•` 圆点（非 ✕/✓/▶，跨端正常）。
- **未动**：`res_atlas` 解码兜底的 `RES_EMOJI` 映射（一闪而过、既有模式）；CityScene（批②已处理）；行内 `→` 导航箭头与 `•` 圆点（属正常排版符号，不在本批范围）。
- 验证：`tsc --noEmit` + `build:web` + render/ui 测试全绿。

---

## 5. 战斗内 UI 的联机增量（GameScene/HUD）

战斗 UI 已成熟（HUDView/HandView/GameRenderer）。联机模式只加**薄薄一层网络态**，不动核心玩法 UI：
- 顶部加对手昵称/头像（替代 AI 名）。
- 掉线/等待对手指令时：半透明 `Spinner` 浮层 + "等待对手…/重连中…"，不冻结渲染。
- 重连成功：Toast 一闪即走。
- 锁步卡顿（输入未到）：短暂 pause 指示，避免误以为卡死。

---

## 6. 网络/加载状态规范（贯穿所有联网场景）

| 态 | 视觉 | 触发 |
|---|---|---|
| 加载中 | `Spinner` + 文案 | 拉商店/存档/连房 |
| 同步中 | CurrencyBar 旁小转圈 | 存档 push/pull |
| 成功 | `Toast` 一闪 | 购买/同步/领奖 |
| 失败可重试 | `Modal` + 重试按钮 | 网络错误/超时 |
| 余额不足 | `Modal` 引导充值/广告 | 花币动作被拒 |
| 服务器拒绝 | `Toast` 错误文案 | 校验失败（防刷/越界） |
| 离线 | 顶部条「离线模式」 | 断网；可玩单机/PvE，联网功能置灰 |

> 原则：**任何联网动作都要有 loading→结果 的闭环**，永不留无反馈的点击。

---

## 7. 美术资产清单（新增需求）

| 资产 | 用途 | 备注 |
|---|---|---|
| 货币图标 | CurrencyBar / 价格 | 一张 |
| 盲盒图（开/合/各稀有光效） | GachaScene | 至少 1 套 |
| rarity 边框/光效 | RarityFrame | 四色 |
| 皮肤缩略图 + 大图 | 商店/收集册 | 每皮肤 2 张 |
| 关卡节点图标（解锁/锁/通关） | CampaignMapScene | 3 态 |
| NavBar 图标 | 5 槽 | 现为圆点占位，可后补 |
| 成就图标 | ProfileScene | 后续 |

> 美术风格统一走笔记本手绘（铅笔线/便签贴纸感），与现有 BoardView/HandView 贴图一致。

---

## 8. 实现约定

- 每个场景实现 `Scene` 接口（`container` / `update(dt)` / `destroy()`），构造收 `(layout, input, callbacks)`，参照 `LobbyScene`。
- 输入统一走 `InputManager.onDown(x,y)`（设计空间坐标），命中区存 `Rect` 数组比对。
- 菜单场景建议继承共享 `MenuShell`（bg + NavBar + CurrencyBar），减少重复。
- 文案全 `t()`；新键先加 `zh.ts`，再 `en.ts`/`de.ts`（漏翻编译报错）。
- `destroy()` 必须取消所有 `InputManager`/事件订阅（参照 LobbyScene `unsubs`）。

---

## 9. 与任务的对应

| 场景/组件 | 任务（`META_TASKS.md`） |
|---|---|
| 组件套件 + MenuShell | 随 S1-8 起步，逐场景沉淀 |
| RoomScene | S1-8 ✅（`scenes/RoomScene.ts`，idle/codeEntry/connecting/inRoom；inRoom 全貌 + 换边视角留 S1-9） |
| ShopScene / GachaScene | S2-6 |
| CampaignMapScene / LevelPrepScene / CollectionScene | S3-5 |
| ProfileScene | S0（云同步状态）+ S3 |
| i18n 命名空间 | I-1 |

---

## 10. 开放问题

- ✅ 横屏菜单分栏比例（2026-06-28）：StatsScene 落地为左 54% / 右 46%，`layout.orientation` 分支；其余菜单场景同此惯例。
- ✅ NavBar 图标美术（2026-06-28）：复用 `icons.ts` 手绘字形，无需单独美术资产。
- [ ] 盲盒开箱动画的炫度分级（legendary 特效预算）。

## 11. 头像系统（2026-06-28）

**结论**：已实现，8 种图标头像 + 本地持久化，无服务端依赖。

### 设计决策

- 不用照片/AI 图：保持手绘笔记本风，所有头像由 `icons.ts` 字形 + 背景色圆圈构成。
- 8 种预设 token（索引 `'0'-'7'`），字符串存 `localStorage`（`nw_player_avatar`）。
- 不选时退化字母缩写（旧行为），永远向后兼容。

### 8 种头像一览

| ID | 图标 | 底色 | 别名 |
|----|------|------|------|
| 0 | book | 0x4477cc (inkBlue) | 学者 |
| 1 | trophy | 0xcc9900 (gold) | 冠军 |
| 2 | swords | 0xcc3333 (red) | 战士 |
| 3 | castle | 0x4a9e4a (green) | 王者 |
| 4 | pencils | 0x9955cc (purple) | 创作者 |
| 5 | globe | 0x44aacc (cyan) | 探险家 |
| 6 | coin | 0xcc6633 (orange) | 商人 |
| 7 | home | 0x667788 (grey-blue) | 守护者 |

### 实现记录

- `client/src/render/avatar.ts`：`buildAvatar(size, name, seed, avatarId?)` 新增第 4 参数；`AVATAR_COUNT=8` 导出供 UI picker。
- `client/src/scenes/SettingsScene.ts`：头像不再内联铺在页面上——点左上角个人头像（带 ✎ 蓝色铅笔角标提示可编辑）弹出模态选择器 `drawAvatarPickerOverlay()`：半透明遮罩 + 手绘面板 + 2×4 格（选中金色高亮环），选中即应用并自动关闭，另有「关闭」按钮/点面板外关闭。`SettingsSceneCallbacks` 有 `avatarId?` + `onSetAvatar?(id)`；`onSetAvatar` 缺省时选择器只读（禁点、无铅笔角标）。（2026-07-03 改为弹窗式，原内联 2×4 选择器废弃）
- `client/src/app/createAppCore.ts`：`PLAYER_AVATAR_KEY='nw_player_avatar'` 持久化；`onSetAvatar` 直接 `setItem`（无网络请求）。

### 后续扩展

- 联机对局：对手头像 id 可通过 MatchStartInfo 下发，`ResultScene` / `OpponentView` 渲染。
- 服务端同步：如需跨设备同步，`accountProfile` 加 `avatarId` 字段即可（现为纯本地）。
