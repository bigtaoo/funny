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

> 这些组件统一放 `client/src/ui/widgets/`（当前尚未建，**首个落地场景负责开目录**）。

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

### 4.9 ResultScene（结算，扩展现有）
现状已有。**扩展**：评星动画（StarRow 逐颗点亮）、奖励发放（材料/物品 Toast）、解锁弹窗（新关/新皮肤 Modal）、（联机）胜负 + 段位变化。

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

- [ ] 横屏菜单的具体分栏比例（竖屏为主，横屏待定稿）。
- [ ] NavBar 图标美术（现圆点占位）。
- [ ] 盲盒开箱动画的炫度分级（legendary 特效预算）。
- [ ] 头像系统是否需要（联机对手展示）。
