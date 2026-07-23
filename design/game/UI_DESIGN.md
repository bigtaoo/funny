# Notebook Wars — 客户端 UI 设计文档

> 创建：2026-06-13。本文件是元系统 / 联机相关**客户端 UI** 的设计基准（场景、组件、导航、网络态、美术资产、i18n）。
> 配套：`META_DESIGN.md`（系统/数据）、`META_TASKS.md`（任务）、`DESIGN.md`（引擎/渲染）。
> 现有场景参考：`src/scenes/LobbyScene.ts`（笔记本风格基准实现）、`SceneManager.ts`、`layout/ILayout.ts`。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **笔记本/手绘风** | 米色纸底 + 横线 + 红色页边线 + 等宽字体（monospace）。沿用 `LobbyScene` 的 `C` 调色板，不另起视觉体系 |
| **设计空间 + Contain 缩放** | 所有坐标用设计空间；`ScalingManager` 单比例映射到真机。场景内用 `layout.designWidth/Height` 的**百分比**布局（见 `LobbyScene.build()`）。**竖屏设计高度是动态的**（2026-07 改）：宽度固定 1080，高度 = `round(1080 × 安全区高/安全区宽)`，下限 1920——即竖屏设计空间的**长宽比跟随设备安全区**，故 iPhone 13（~9:19.5）等高瘦屏用 fit-to-width 铺满、**不再上下留米色黑边**（此前固定 1080×1920 在高屏被 Contain 居中，上下各浪费 ~18%）。**横屏同理动态化**（2026-07 改）：高度固定 1080，宽度 = `round(1080 × 安全区宽/安全区高)`，下限 1920——即横屏长宽比也跟随安全区，高瘦屏横握用 fit-to-height 铺满、不再左右留黑边；棋盘水平居中，底部条左/右锚定、中间手牌区随宽度伸缩。详见 [`design/game/DESIGN.md` 渲染/布局节] 与 `layout/{PortraitLayout,LandscapeLayout}.ts` |
| **安全区（刘海/灵动岛/Home 指示条）** | `IPlatform.getSafeAreaInsets()`（Web 读 `env(safe-area-inset-*)`，需 `viewport-fit=cover`）返回 CSS px 内边距；`createLayout` 用它缩小竖屏"可绘制区"来算设计高度，`ScalingManager` 把整个 `gameLayer` 平移进安全区内——**所有场景（战斗+菜单）统一避开刘海/指示条，无需各场景单独处理**。`bgLayer` 仍 Cover 铺满整屏（含安全区外的窄带），故边缘露的是背景纸而非硬边 |
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
| `ScrollIndicator` | 滚动位置指示条（右缘细圆角轨道 + 滑块，只读不吃指针） | **已落地（2026-07-14）**，见下方说明；所有可滚动页面统一接入 |
| `scrollPeek.peekViewportH` | 视口高度钳制，保证内容溢出时切割线永远停在行中间 | **已落地（2026-07-20）**，见 §25；配合 `ScrollIndicator` 统一接入所有网格/列表页 |
| `Modal` | 半透明遮罩 + 居中卡 + 确认/取消 | 购买确认、解锁弹窗、错误提示 |
| `Toast` | 顶部短暂浮条（领奖/错误/同步成功） | 自动淡出 |
| `Spinner` | 加载圈 / "matching..." 点点 | 抽 LobbyScene 的 dots 动画 |
| `StarRow` | ★★★ 星级显示（空/亮） | 选关、结算复用 |
| `RarityFrame` | 按 rarity 上四色描边/光效 | 盲盒、收集册、商店复用 |
| `NavBar` | 底部 5 槽导航 | 已在 LobbyScene，提取为共享组件（§3） |

> 这些组件统一放 `client/src/ui/widgets/`。**已落地（2026-06-25）**：`uiCache.ts`（§2.1 缓存底座）+ `SceneHeader.ts`（§3.1 统一返回/标题栏）。其余组件（Button/Panel/CurrencyBar/…）随后续场景按需沉淀到此目录。

> **按钮背景统一（2026-07-15）**：全屏菜单场景（登录/大厅/设置/…）早已共享 `render/sketchUi.ts` 的 `sketchPanel()` + `ui` 调色板（§7.5：手绘描边按钮，非透明/纯白/纯黑各自为政）；本次审计发现真正的缺口在**战斗内 HUD**（`HUDView`/`ProfilePopup`/`TutorialDirector`），此前各自写死十六进制色值（`0x2c2c2a`/`0xf0ece0`/`0x3a6ea5`/`0x999999`…）。新增 `render/hudButton.ts` 导出 `drawHudButton(g, w, h, variant)` + `hudButtonText(variant)`，5 个语义变体：`primary`（主操作，暂停恢复/关闭/升级/教程跳过）、`accent`（同权重次操作，靠色相区分，刷新手牌/教程下一步）、`secondary`（低权重操作，退出大厅/设置齿轮）、`danger`（拉黑/移除等破坏性操作）、`disabled`。颜色源自 `theme.ts` 的 `palette`，换肤只改一处。同时把两处历史遗留的场景本地 `const C = {...}`（`SettingsScene.ts`/`IntroScene.ts`，与 `sketchUi.ui` 完全重复的调色板）改为直接 `import { ui } from '../render/sketchUi'`，消除并行调色板。

> **ScrollIndicator（2026-07-14）**：`ui/widgets/ScrollIndicator.ts` 导出 `drawScrollIndicator(parent, view, scrollY, scrollMax, opts?)`——在视口 `view`（= 内容 mask 矩形）右缘画墨黑细圆角轨道 + 位置滑块（长≈视口/内容比、位置≈滚动进度），`scrollMax<=0` 或视口退化时返回 `null` 不画。**只是指示器、不吃指针**，各场景仍自管拖拽/滚轮。约定：在 `render()` 内容+mask 加完后调一行，画进**不随滚动位移**的容器（容器位移型场景用 `this.container`；无 mask 剔除重绘型用 `bodyLayer` 并以 `listY/listH` 局部量作视口）；有拖拽快速路径（BattlePass/CardCodex）的场景在快速路径里也重画一次。已接入全部可滚动页面：BattlePass、CardCodex、Leaderboard、DeckBuilder、Chat、Shop（商城/充值）、Friends（好友/世界/邮件）、Equipment（背包/装配/合成）、Card 花名册、Sect（名册/频道）、Family（名册/频道）、Auction（列表/物品选择）、WorldMap 世界信息面板。纯几何 `scrollThumbGeometry()` 拆出单测。
>
> **鼠标滚轮全面接入（2026-07-23）**：此前"各场景自管拖拽/滚轮"里的滚轮部分只有 WorldMap 一处真正接了（`WorldMapInput.handleWheel`），其余全部只支持触屏拖拽。新增 `ui/wheelScroll.ts` 的 `wheelScrollY(regionTop, regionBottom, y, deltaY, scrollY, maxScroll)` 纯函数判定，铺到上面列出的**全部**可滚动页面（含新增的 Settings 头像选择器、DefenseEditor 出击卡组、Recharge 档位列表——这两个之前没在 ScrollIndicator 清单里）。`InputManager.onWheel` 只在浏览器/PC 派发（微信小游戏无 wheel 事件），场景侧零平台判断代码、不影响触屏。多 Tab/双栏共享同一 `scrollY` 的场景（FriendsScene 五 Tab；Sect/Family 的名册列+频道列）一份 `onWheel` 订阅按当前激活列路由；双栏场景新增了独立的 `xxxRegionTop/Bottom`+`xxxMax` 字段（拖拽本不需要提前知道视口边界，滚轮判定必须要）。同批顺带给 Auction 的价格/出价数字输入框加了「回车=失焦提交」（此前只有失焦提交，聊天类输入框的回车发送早已覆盖 Chat/Family/Friends/Sect）。

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
>
> **补充（2026-07-05）**：返回文字底下新增一个**轻量圆角色块**（`buildBackChip`）——`dark` variant 用白色 12% 透明度，`paper` variant 用墨色 8% 透明度，让返回按钮读成一个「按钮」而不是浮在标题栏上的裸文字；不是 §7.5 那种手绘描边的实体按钮框，只是一个衬底色块。同一改动把 `WorldMapScene` 唯一的例外（原来是左下角 HUD 里 88×34 的手绘按钮框，i18n key 是 `world.back`）迁移成新增的 `drawFloatingBackButton(container, h)`：同款色块 + `common.back` 文案，挪到左上角、同一个 `x=10` 缩进，与其余 22 个场景位置对齐；`floating` variant 用不透明的纸色底（92%）以便在地图任意底色上都能看清。至此返回按钮**位置 + 样式**在全部场景统一，无遗留例外。
> - `title` 传 `null` 时只画 chrome、不画标题（供有副标题需抬升标题的场景自绘，如 CampaignMap）；`opts.titleSize` 保留为 API，但**已无任何场景覆盖**（见下「标题字号统一（2026-07-12）」），一律走默认 `h*0.034`。`opts.headerH` 同理保留为 API 但**已无任何场景覆盖**（见下「栏高统一（2026-07-08）」），一律走默认 `sceneHeaderHeight`。
> - `opts.variant`（`'paper'` 默认 / `'dark'`）：`'paper'` = `sketchPanel` 纸面底（`C.paper` 填充 + `C.mid` 手绘边）+ 深色标题；返回在左、标题居中，右侧留空可由调用方在 chrome 之上自绘控件（如 DefenseEditor 的基地等级 stepper、或 `drawHeaderCurrency` 金币条）。`'dark'`（实心深色底 + 白字）为遗留分支，**已无任何场景使用**，仅保留以防显式传参编译报错。
>
> **顶栏统一（2026-07-07，`feat/header-unify`）**：此前顶栏分「黑底白字」（13 个大厅系菜单，靠默认 `'dark'`）与「纸底深字」（8 个 SLG/编辑器，显式 `'paper'`）两套，观感割裂（玩家只感到"一会儿黑一会儿白"，感知不到当初的分界逻辑）。本次**全部收敛到 `'paper'`**——手绘笔记本风的本体，且这些场景正文本就全坐在 `buildPaperBackground` 纸面上，翻纸底无缝。做法：把 `drawSceneHeader` 默认 variant 从 `'dark'` 改成 `'paper'`，13 个靠默认值的场景**零改动**自动翻新（标题色随 variant 自动 `C.dark`）。
> - **分区靠 accent 细线，不靠底色**：底一律纸面，只在顶栏底边加一条 2px 的 accent 细线（兼作顶栏/正文分隔线，**纯色不加纹**）。三档 `HEADER_ACCENT`：`lobby`=蓝（`C.accent`，默认，信息/社交/大厅系）/ `spend`=金（`C.gold`，花钱养成：Shop/Gacha/BattlePass/Equipment/Card）/ `slg`=红（`C.red`，SLG 对抗：Auction/Family/Sect/Teams/DefenseEditor）。accent 进缓存键。
> - **纸币扭索纹（guilloche，2026-07-07）**：纸面填充之上叠一层极淡的钞票编织纹当水印，增加"官方账本"高级感（契合货币/笔记本主题）。两族镜像的相位错开复合正弦股（`drawGuilloche`），accent 同色染色，`alpha=0.12`、`6 股/族`（交互预览拍板值）；振幅 0.30·栏高、恒在栏内故无需 clip。压在返回/标题/金币之下，不抢读。**随 chrome 一起走 §2.1 `getCachedDisplay` 烘焙——每个 (variant, accent, 宽, 栏高) 只算一次 `PIXI.Graphics`，之后全场景复用同一 sprite，运行时零开销。**
> - **金币读数统一走 `drawHeaderCurrency`**：Shop/Gacha/BattlePass 此前各自手绘「金图标+金数字」，Equipment/Card/Friends 走 `drawHeaderCurrency`（图标+"金币"标签+深色数字），两套不一致。现统一：`drawHeaderCurrency` 的金币金额改成**金色加粗、去掉"金币"文字标签**（图标即单位），三个消费场景删自绘块改调 `drawHeaderCurrency`。金币只挂在花钱/养成场景，纯信息场景（排行/统计/设置/成就等）不挂。材料 chip 仍保留标签+深色数字不变。
> - **各场景 accent 归属**：金 = Shop/Gacha/BattlePass/Equipment/Card；红 = Auction/Family/Sect/Teams/DefenseEditor；其余（Achievement/Collection/Stats/Leaderboard/Titles/Settings/Room/Chat/Friends/DeckBuilder/CampaignMap/LevelPrep）走默认蓝。
> - **DailyScene 迁移（2026-07-07）**：删掉自绘的裸返回文字（`daily.back`），改挂 `drawFloatingBackButton`（无顶栏的纸面浮动返回，与 Result/WorldMap 同款），位置与其余场景对齐。
> - **DailyScene 补齐标准顶栏（2026-07-12）**：浮动返回胶囊本身不带标题条底/分类强调线，与 Shop 等场景仍不一致（同一批反馈见下方 4.9.1 的 ResultScene 记录）。改为标准 `drawSceneHeader(this.container, w, h, t('daily.title'))`——标题回到顶栏里居中显示，不再单独手绘；正文区改从 `hdr.headerH + h*0.02` 起算（原固定 `h*0.12`）。
> - **仍未迁**：底部 HUD 的 WorldMap（非顶栏，用浮动返回）；LoginScene（返回仅在 password/register 视图条件出现，属登录前流程）。
>
> **栏高统一（2026-07-08，`feat/header-height-unify`）**：顶栏 chrome 已在 07.07 统一成纸底，但**高度**仍两套——大厅系菜单走默认 `sceneHeaderHeight`（`h*0.12`，如 Shop/Gacha/Settings…），而养成/SLG 系（Card/Equipment/Family/Sect/Teams/DefenseEditor）与 Chat 各自传固定 `headerH`（46/50px）+ 小 `titleSize`（14/15），栏矮字又小，跨页观感割裂（玩家感到"顶部条一会儿高一会儿矮"）。本次把这些场景的 `headerH`/`titleSize` 覆盖**全部删掉**，回落默认——与 Shop **完全一致**（同栏高、同标题字号，只 accent 细线区分分区）。各场景正文布局改从 `drawSceneHeader` 返回的 `hdr.headerH`（存进 `this.headerH`）起算，不再引模块级 `HUD_H`/`HEADER_H` 常量（已删）。
> - **金币读数保紧凑**：Card/Equipment 的 `drawHeaderCurrency`（金币 + 材料 chip + 容量）用 `scale = 100/headerH` 保持与旧 50px 栏等价的绝对尺寸——栏变高但读数不随之放大，避免 4 个 chip 在 1080 宽竖屏溢出；两者互为 [卡牌|装备] 对开页，取同一 scale 以免切换时读数跳变。单币场景（Shop 等）仍用默认 scale=1。
> - AuctionScene 已于 08.07 先行迁到默认高度（`sceneHeaderHeight`），本次不再重复。
>
> **返回按钮放大 1.5x + 标题字号统一（2026-07-12）**：
> - **返回按钮放大**：`backSize(h)` 从 `h*0.026` 改为 `h*0.039`（1.5×），驱动 `drawSceneHeader`/`drawFloatingBackButton` 两条路径，全场景（含悬浮版）一次性放大，无需逐场景改。
> - **标题字号统一**：此前 5 个场景显式传 `titleSize` 覆盖默认值——`Settings`/`Titles` 0.042、`Room`/`Friends` 0.04、`LevelPrep` 0.032——跨页字号不一致。本次删掉这 5 处覆盖，全部回落默认 `h*0.034`，与 Shop/Gacha/Equipment 等场景完全一致。
> - **EventScene 补迁**：`EventScene` 此前完全绕开 `SceneHeader`，自绘标题（`h*0.045`）与返回文字（`h*0.032`，位置 `x=w*0.05,y=h*0.04`，私有 i18n key `event.back`），是唯一未接入共享组件的二级场景。本次改用 `drawSceneHeader(this.container, w, h, t('event.title'))`，回退按钮/标题/栏高与其余场景完全一致；`event.back` i18n key 不再使用（未删，供未来复用）。
> - **未动**：Card/Equipment 的 `drawHeaderCurrency` 紧凑 scale（`100/headerH`，见上「栏高统一」条目）——两场景互为对开页且有明确的溢出规避理由，不属于本次"跨页不一致"的范畴，维持现状。

---

## 4. 菜单场景规格

> 以下用竖屏（1080×1920）描述，横屏为左右分栏变体。坐标均为百分比示意。

### 4.1 LobbyScene（大厅，扩展现有）
现状已有：标题栏 / 三 feature 块 / 匹配按钮 / 战役 1-4 选关 / NavBar / VS 遮罩。**扩展**：
- 顶部加 `CurrencyBar`。
- "战役"按钮改为跳 `CampaignMapScene`（替代当前直接 1-4 数字选关；旧选关可保留为 debug）。
- 加「好友对战」入口 → `RoomScene`。
- （S2 后）加「每日奖励」红点入口。
- **匹配按钮氛围装饰（2026-07-05）**：右侧已有淡化交叉铅笔图腾（`heroMotif`，alpha 0.22）；左侧对称加一个随机角色剪影——`build()` 时从 6 个可战斗角色（infantry/archer/shieldbearer + max/lena/mara，复用 `render/UnitView.ts` 同款 `.tao` 骨骼动画包，池子见 `render/heroSilhouette.ts`）随机抽一个，用新增的 `StickmanRuntime.setSilhouette(color)`（`render/stickman/StickmanRuntime.ts`：把每根骨骼贴图的 RGB 乘成纯黑、只留原透明度）渲染成纯黑剪影，同样 alpha 0.22；`update(dt)` 里每 1.6–3.2 秒从该角色的 clip 列表随机切一个动作循环播放，纯装饰不影响任何交互/命中区。
  - **尺寸/居中的三次迭代与最终方案（2026-07-06 定稿）**：横向位置从"贴左边"改为"按钮左边界 → 文字左边界"距离的 1/3 处，此项一直保留。尺寸与垂直居中前两次均失败，根因是**都没量到真正画在屏幕上的像素框**——
    1. 第一次（`0d7f90df`）用 `getLocalBounds()` 二次缩放，方向对但：① 在 `new StickmanRuntime()` 之后立刻测量，此时构造函数只 `play('idle')` 设了动画指针、`_applyPose()` 尚未运行，所有 sprite 仍堆在原点，量出的是乱框；② 框里混进了 shadow；③ 只改缩放没重算居中，仍用"脚=原点"假设。看起来更乱，遂回退。
    2. 第二次（`4cb446fb`）据此判定"`getLocalBounds` 不可靠"，退回纯 `targetHeight / naturalHeight`。但 `naturalHeight` 是**骨骼关节跨度**（`skeleton.ts` `computeNaturalHeight`，只看 FK 关节不看贴图），头/脚/武器超出关节的量每个 rig 都不同 → "六角色大小不一致" + "脚=原点居中"两个原始 bug 原样保留。
    3. 最终方案（本次）：新增 `StickmanRuntime.getRenderedLocalBounds()`——**在姿势已应用、排除影子（新增构造参数 `showShadow:false`）、跨所有 clip 全部关键帧取并集**的前提下测量真实渲染像素框；再经纯函数 `render/fitToBox.ts` `fitContentToBox(bounds, box, 0.90)` 拟合：渲染高度 = 按钮高度的 **90%**，且缩放与居中**全部基于实测框、绝不假设原点**，故六角色同高且真正上下居中于黑色按钮框内。拟合数学有单测兜底 `test/fitToBox.test.ts`（含"原点两侧不对称溢出仍 90%+居中""不同框同高"两条针对上述回归的断言）；`getRenderedLocalBounds` 对真实 `.tao` 的测量需真 PIXI 渲染器，本项目 node 测试环境 mock 掉了 PIXI，故该半仅靠 webpack 构建 + 肉眼确认。

- **标题栏改双行（2026-07-11）**：原单行标题栏把「左上头像 chip + 居中 logo+品牌标题 lockup + 右上登录/段位 chip」全挤在同一水平带，品牌 lockup 比左右两 chip 之间的空隙宽，在窄竖屏（1080 设计宽）下会左右裁切/压到两侧 chip——高瘦屏动态设计高度把按 `h` 缩放的字号进一步放大后更明显。改为上下两带：**上带 chipBandH=`h*0.16`**（头像 chip + 账号 chip，几何与旧单行完全一致）+ **下带 brandRowH=`h*0.09`**（居中 logo+品牌标题+副标题，独占一行不与 chip 争水平带）；品牌 lockup 只在超过宽度 90% 时才缩放（`title.scale`），故任意宽度都不裁边。深色标题栏背景高度 = 两带之和；下方主内容栈起点 `usableTop=tbH` 随之下移，用回竖屏多出来的纵向空间。见 `LobbyScene/build.ts`。
- **双行仅限竖屏（2026-07-11 修正）**：上述两带改造起初**无条件对所有朝向生效**，导致横屏（空间充裕、单行本就成立）也被套上两行——logo 从 `tbH*0.9` 缩到 `brandRowH*0.9`（约小 44%）、品牌带下沉、标题栏更高，属回归。现按 `layout.orientation` 分支：**横屏走原单行**（`chipBandH===tbH`、logo `tbH*0.9`、中线 `tbH*0.45`，与两带改造前逐值一致），**竖屏走两行**。几何计算抽成 PIXI-free 纯函数 `LobbyScene/format.ts` `headerMetrics(w,h,portrait)`，单测 `test/lobbyHeader.test.ts`（横屏单带、横屏还原大 logo、竖屏两带、竖屏取舍 4 例）。教训：竖屏专项修复必须按朝向分支，勿无条件套到横屏。
- **LoginScene 离线提示换行（2026-07-11）**：`auth.offlineHint`（EN/DE 较长，monospace 下超 1080 设计宽）改用 `txt(..., wordWrapWidth=w*0.86)` + 居中对齐，两行排版，不再左右裁切。
- **账号 chip 配色/间距修正（2026-07-19）**：右上角金币 chip 与段位 chip 用户反馈"配色突兀、贴太近"——两者本是不同信息（金币 vs 天梯段位+积分），此前段位徽章却用纯白 `C.light` 文字+边框、无图标，视觉上不成一套。新增 `LobbyScene/base.ts` 的 `TIER_COLORS`（按 `pvp.rank` 取色：unranked 灰、bronze/silver/gold/platinum/diamond/master 各自色），段位 chip 边框+文字改用该色，并加奖杯图标（`buildIcon('trophy', ...)`）与金币图标对称；两 chip 垂直间距从 `chipBandH*0.26/0.58` 拉开到 `0.20/0.74`。见 `LobbyScene/build.ts`。

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
- **充值档位金币数量字号**：卡片内「图标+金币数」是转化关键信息，字号 `ch*0.20`（`drawCard` 内 `coinAmount` 分支）；改版后随标题一起收进右上角「右对齐纵向列」（badge → 金币数+图标 → 元价），不再与标题同一行水平排列——标题改左侧、超宽自动换行（`txt()` 新增 `wordWrapWidth` 参数），避免长标题挤压价格列。赠送量（`+N`）等副行仍在下方 icon 右侧。
- **卡片竖向布局改「按剩余空间反推」，杜绝 icon/文字压中按钮（2026-07-06）**：`drawCard` 曾用写死的 `ch` 比例摆放 icon 和加成文字行（`y+ch*0.30` 起、每行 `ch*0.14`），跟底部 Buy 按钮的位置无关；充值档位卡同时要塞标题+金额+icon+2 行加成文字（`+N` 与"首充双倍"——后者按 `ECONOMY_BALANCE.md` 规定所有档位常驻，非 bug），内容总高超过卡片高度，icon 和第二行文字会压进/被 Buy 按钮挡住。改法：先算按钮占的 `btnH/btnY`，再用 `midTop`（标题/右侧列结束处）到 `midBottom`（按钮上沿留白）之间的实际空隙反推 icon 尺寸与每行行高（`Math.min(理想值, 可用空间)`），几何上保证不会溢出到按钮；同时把 `gridMetrics()` 里 `cellH` 从 `h*0.22` 调到 `h*0.27` 给内容多留余量。
- **横屏商品卡由 4 列改 3 列，杜绝标题换行把价格顶到按钮上（2026-07-17）**：图标卡改版成「大方图在上、标题/价格/按钮竖向堆叠」后，`gridMetrics()` 横屏目标宽度取 `w*0.16` → 一行约 4 张，卡片太窄；"Monthly Card"、"Skin · skin_shop_c1" 等标题被折成 2–3 行，把下面的价格行（`¥30`/金币 `300`）往下顶。而价格行（`coinAmount`/`yuanPrice` 两个分支）**没有像状态行 `lines` 那样做 `bandBottom` 钳制**，标题一高价格就压到底部按钮（"Claimed today"/"Owned"）上。改法：横屏目标宽度 `0.16 → 0.24`（`ShopScene/base.ts` `gridMetrics()`），一行 3 张、与竖屏一致；卡片变宽后标题回单行，价格行不再被顶下去。数值几何核对（横屏 1920 无头渲染）：确为 3 列，`¥30` 底边远在按钮上沿之上（留白约 230px）；`tsc --noEmit` + shop UI 套件 29 例全绿。
- **皮肤卡标题用真名，不再显示原始 id（2026-07-17）**：`buildShopCards()` 皮肤分支的标题原为 ``${t('shop.skinLabel')} · ${item.id}``，直接把目录 id（`skin_shop_c1` 等）当标题显示。`ShopItem`（openapi）只带 `id/cost/kind/grants`，不带名字，所以名字得在客户端从皮肤所属角色卡反推。新增共享 `skinDisplayName(skinId)`（`game/meta/skinDefs.ts`）：经 `SKIN_TARGET_UNIT` → 该 unitType 对应的角色卡 → `card.<id>.name`，产出 `{角色名}·{皮肤}`（如「李川·皮肤」），无映射时回退原 id。这套解析原本内联在 `GachaScene.displayName()` 里，本次抽成 skinDefs 的单一来源，Gacha 改调同一函数（去重）。皮肤**真美术仍是占位**（借用基础兵种 PNG，`.tao` 皮肤资源未产出，且 lichuang/suyuan/chenshou 角色本身也复用基础兵种图），属资源阻塞，不在本次范围。
- **光标约定是硬性契约，不是 ShopScene 专属实现**：任何「隐藏 `<input>` + canvas 画字段」的输入框都必须调用共享的 `caretDisplay()`（`render/inputDisplay.ts`）产出显示文本，禁止再手写 `text || ' '` / `text || placeholder`。2026-06-23 那次修复只顺手改了 ShopScene/SettingsScene/ChatScene 三处，遗漏了 FamilyScene/SectScene/FriendsScene（好友页内嵌的家族/宗门/世界频道输入框）/AuctionScene（指定买家字段，另外还漏了逐键刷新），2026-07-04 补齐。`test/ui/caretRegression.ui.ts` 对每个受影响输入框做了聚焦-闪烁回归断言；新增任何同类输入框必须在该文件补一组用例，而不是仅凭肉眼过一遍。
- **2026-07-06 续修：`caretDisplay()` 接了但点开仍无光标**——FriendsScene 的点击处理器都是「先设激活标志（`worldChatActive`/`familyActiveInput`/`sectActiveInput`）再调 `openHiddenInput()`」，而 `openHiddenInput()` 第一行调的 `clearHiddenInput()` 会把这三个标志全部复位，等于把刚设好的标志立刻擦掉 → 光标判据与 `update()` 闪烁循环双双关闭，点开后既不闪也不显示 `|`。2026-07-04 的回归测试是手动 `scene.worldChatActive = true` 后直接 `render()`，绕过了「点击 → openHiddenInput」这条真实路径，所以测试全绿而 bug 依旧。**修复**：`openHiddenInput()` 只拆上一个 DOM 元素（`this.hiddenInput?.remove()`），不再整体调 `clearHiddenInput()`；`clearHiddenInput()` 仍用于真正的销毁路径（切 Tab / 取消 / destroy）。回归测试新增「走 hit 点击路径」的用例（需最小 `document` stub），杜绝再次只测手动状态。

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
- **结果卡片可读性 + 图标化（2026-07-15，已上线验证）**：epic/legendary 卡背是深紫/金色纹理，id 文字直接叠上去看不清；改为文字区加一块半透明纸色底板（`C.paper` alpha 0.92）再叠字。同时结果卡此前只显示 `itemId` 纯文字，看不出实物——改为复用赔率详情面板既有的 `drawEntryPicture`（材料图标/装备字形/卡牌真实立绘/皮肤画笔图标/兜底稀有度星）在卡片上方画出物品图标，id 文字缩小做说明文字放图标下方。上线后实测（本地 dev 直连生产后端 + 调试钩子渲染验证）：图标/底板本身生效良好；但 NEW/重复徽标原先固定在 `h*0.85`，恰好落在稀有度边框图（`frame_epic/legendary.png`）的底边装饰带内，被边框颜色顶脏——上移到 `h*0.78` 修复，紫色卡背本身无需换色/换图。

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

**内容区排版 + 字号（2026-07-15）**：三个面板自上而下依次为 **Objective**（2× 字号，label+desc 改为上下堆叠 + `wordWrap`，避免长文案如 `leak_limit` 溢出面板）→ **Rewards**（1.5× 字号）→ 故事简介 `brief`（1.5× 字号，原有 wordWrap 不变）。三者仍是单向 flow-down、无滚动，下方 stamina 条位置固定不随内容高度变化——已核对现有关卡数据，`leak_limit`（多行 objective）与长 `brief`（最长 700 字）不会同时出现在同一关，暂不需要滚动兜底。

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

**胜利页边饰**（2026-07-05）：`addMoodDeco('win')` 撒 12 颗手绘五角星，随机范围放宽为全屏（上下左右各留 3%~5% 页边距，避免溢出画布），并加最小间距保底（拒绝采样，相邻星最小间距 = 屏幕短边 10%，最多重试 20 次防止死循环）避免扎堆。每次进入用 `Math.random()` 重新随机 x/y/大小/透明度，非固定 seed。此前（2026-07-03，见 4.18）为避开中间徽章列而限制在左右边距，实测挤在一起不好看，且中间列已不怕遮挡，故放开为全屏。

#### 4.9.1 按钮主次 + 图标 + 背景涂鸦（2026-06-27）
结算页动作区重排为「一个主 CTA + 一行次要入口」，所有按钮配手绘图标：
- **主按钮**：`再来一局`（胜利时文案换 `再战一场`）——大、`ui.gold` 金色填充、白色粗体、配 `swords`(交叉刀) 图标，视觉首位。
- **次按钮**（底部横排一行，纸色幽灵风：描边 + 墨色字 + 小图标）：`观看回放`(`replay`) / `分享`(`share`)。均条件性显示。（原有的常驻「返回大厅」`home` 次按钮已于 2026-07-06 移除，见下——现在由左上角统一返回按钮覆盖同一出口。）
- **行为：天梯 PvP「再来一局」= 重进匹配**（旧实现里它其实回大厅）。`createAppCore.finishNet`：天梯局 `onPlayAgain = 关 session → goRoom({autoRanked})`（进排队 UI，可取消），并传 `onReturnToLobby = goLobby` 给 `goResult`（不再渲染成次按钮，只喂左上角 `onBack` 闭包，见下）；好友/AI 局维持「再来一局 = 回大厅」。
- **背景情绪涂鸦**（`addMoodDeco`，低 z 序藏在文字/按钮后）：胜利→暖金四角星点；失败→断铅笔 + 红笔划叉（呼应"红笔批改"美术母题）；平局→角落中性等号。
- 新增图标：`icons.ts` 的 `swords/replay/share/home`（SketchPen 线稿，烘焙缓存；`home` 现仅用于其他场景）；i18n 新增 `result.playAgainWin`（三语）。
- **PvE-vs-AI「再来一局」= 直接重进对局（2026-07-06）**：`nav/game.ts` 的 `goGame().onGameEnd` 不再走默认的「play again = 回大厅」，改为 `onPlayAgain = () => goGame({ difficulty: pickPracticeDifficulty(elo) })`（复用大厅入口同一条难度公式，直接重开一局，跳过大厅）。`pickPracticeDifficulty` 从 `lobby.ts` 导出供 `game.ts` 复用。
- **新增左上角返回按钮，删除重复的次按钮（2026-07-06）**：`ResultSceneCallbacks.onBack()`（必填）——固定回大厅，独立于「再来一局」逻辑（后者现在可能是重进对局而非回大厅）。视觉复用 `SceneHeader.ts` 的 `drawFloatingBackButton`（浮动返回胶囊，左上角同款样式，与其余 22 个场景对齐）；该 helper 只画视觉+返回命中矩形不接交互，`ResultScene` 自己叠一层透明命中区接 `pointertap`。`nav/result.ts` 的 `goResult` 里 `cb.onBack` 复用 `onReturnToLobby`（天梯局关 session）否则回退纯 `goLobby()`。原先天梯局专属的「返回大厅」次按钮是同一个出口的重复入口（天梯结算会同时看到左上角返回 + 底部返回大厅两个按钮），已删除——连同 `ResultSceneCallbacks.onReturnToLobby` 字段和 `result.toLobby` 三语 i18n key；`goResult` 的 `onReturnToLobby` 参数只保留给 `onBack` 闭包内部用，不再对外暴露成独立按钮。

- **改用标准顶栏，不再是浮动返回胶囊（2026-07-12）**：产品反馈胜利/失败页「缺标准顶栏，类似商店的顶部」——2026-07-06 那版只画了浮动返回胶囊，没有纸质顶栏本体（无标题条底、无分类强调线），与 Shop/Gacha/Equipment 等其余场景观感不一致。改为 `drawSceneHeader(this.container, w, h, null)`（`title=null`，因为页面中央已有大号 VICTORY/DEFEAT 大字当标题，复用 CampaignMapScene 的同一模式），拿到的 `hdr.headerH` 用于把大字标题下移（`hdr.headerH + h*0.02`，原来固定 `h*0.07` 会被新顶栏压住）。返回胶囊换成嵌在顶栏里的 back pill（原来悬浮胶囊的透明命中区叠加手法保留，`resultBackChip` 测试钩子不变）。
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
- **AchievementScene 分类 Tab 布局改版（2026-07-04）**：原横排 Tab 条压在页面红色装订线上、Tab 偏小。改为竖排侧栏——三/四个分类 Tab 堆叠在红线**左侧**（图标在上、文字在下，因侧栏窄），每格更大；成就卡片内容整体移到红线**右侧**（`marginLineX(w)` 起算），呼应笔记本纸「装订线 + 正文」的既有分区，不再跨线压字。
- **DailyScene 月历/任务改 Tab（2026-07-05）**：同上一条思路——原「月历+每日任务」左右分栏同屏显示两块，改为「月历」「每日任务」两个 Tab 堆叠在红线**左侧**（纯文字，无图标；沿用 AchievementScene 的 Tab 样式），内容区一次只画一个，整块移到红线**右侧**，不再区分横竖屏两套分栏比例。签到格奖励 glyph 补齐 `material`（scrap/lead/binding，同 EventScene 映射）/`card`（`cards`）/`equipment`（`armor`），单件奖励（card/equipment）只画 glyph 不带数量，同 BattlePassScene 的 skin 奖励。
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

#### 4.18 结算勋章图标化 + mood 星归位（2026-07-03，批⑦）

用户反馈结算页「次要徽章的文字列表不好看，想换图标」，且胜利 mood 星散在中间正好压住徽章列，看着像游离。**零新增图标定义**，全复用现成 `icons.ts` 字形：

- **徽章图标映射**（`BADGES` 补 `icon` 字段）：`TOP_DMG`→`swords`、`IRON_WALL`→`armor`、`FLOOD`→`flag`、`BUILDER`→`castle`、`PRECISION`→`atkspd`(闪电=法术)、`EFFICIENT`→`coin`。
- **列表 → 勋章**：删旧 `buildBadgeCard`（横排文字卡），改 `buildBadgeMedallion`（竖排：字形 + 标题 + 简短数值）。首徽（hero）仍大字形（`ui.gold` 金）+ 标题 + 完整 detail 句；其余徽章排成一行居中小勋章（灰字形 + 标题 + 简短数值）。
- **简短数值**：`BADGES` 补 `value` 取值器，走新增 i18n `badge.*.short`（三语）——如 `55 单位` / `180 秒` / `106 伤害`；完整句仍留在 hero 的 detail。
- **mood 星归位**：`addMoodDeco('win')` 五角星原散布中列（x≈0.27/0.74、y≈0.40/0.45 压住徽章），改全部收进顶部带 + 左右纸边（x≤0.12 或 ≥0.88），不再游离于内容列。战败红叉本就在纸边、未动。
- 验证：`tsc --noEmit` 全绿。

#### 4.19 FriendsScene 家族/宗门 tab 已入会直接进入（2026-07-05）

用户反馈：好友页「家族」「宗门」tab 已加入时，还要先看一遍信息卡再点「进入家族/宗门」按钮才能进——多余一步，因为每个玩家只可能属于一个家族/宗门。`orgForm.ts` 的 `drawFamilyTab`/`drawSectTab` 检测到 `slgStatus.familyId`/`sectId` 已存在时，不再渲染信息面板 + 按钮，直接调 `openFamilyHub()`/`openSectHub()` 跳转；未加入时的创建/加入表单不变。连带清掉两处渲染因此不再使用的 `sketchAccentBar` 引入。验证：`tsc --noEmit` 全绿。

#### 4.20 战斗 HUD 四角靠拢中心 + 齿轮→投降（2026-07-16）

用户反馈（对战截图标注）：计时器/资源条/刷新升级按钮四个 HUD 元素死贴在屏幕四角，宽屏下尤其显眼（`LandscapeLayout` 的 `designWidth` 会按安全区宽高比拉伸到远超 1920 的参考宽度，棋盘居中但四角元素仍钉在 0/designWidth 边缘）；右上角齿轮按钮想改成「投降」。

- **四角靠拢**：`LandscapeLayout.ts` 新增仅在超宽屏生效的 `inset`（= `boardX` 超出 1920 参考宽度下的棋盘左边距的部分，标准 16:9 下恒为 0，不影响既有布局），联动收紧 `hudBottomLeftRect`/`hudBottomRightRect`/`handRect`；`HUDView.ts` 里 ink 计数/血条从贴「列外边缘」改成贴「列内边缘」（靠棋盘/手牌一侧）——这一步在任何分辨率下都让它们更靠中心，不依赖超宽屏；顶栏计时器/投降按钮复用同一个 `inset`。用真实渲染截图在 1920×1080 参考分辨率和超宽分辨率下分别验证：参考分辨率下四角位置与改动前像素级一致（`inset=0`），超宽分辨率下四个元素都贴着棋盘/手牌区域，不再孤悬屏幕边缘。
- **齿轮→投降**：右上角齿轮按钮换成常驻「SURRENDER」文字按钮（`HUDView.showSurrenderConfirm()`，原 `showPause()`/`hidePause()` 重命名并改写文案），点击弹出确认框（取消/确定投降）而非直接暂停浮层；确认后复用原「退出对局」的既有逻辑（该逻辑本就会让对手判负/记录 abandon，语义上就是认输，只是之前藏在暂停菜单第二层且没有二次确认）。新增 i18n key `hud.surrender*`（zh/en/de），移除不再使用的 `hud.paused`/`hud.resume`/`hud.exitToLobby`。
- 验证：`tsc --noEmit` 全绿；`npm run test:ui` 461/502 通过，41 个失败均在 `cityScene.ui.ts`/`worldMap*.ui.ts`（工作区内另一并发会话的未提交改动导致，与本次改动无交集）。

#### 4.21 战斗 HUD 全面锚定棋盘 + 对方名字居中（2026-07-16）

用户反馈（对战准备截图标注）：横屏下即便标准 16:9（§4.20 的 `inset` 恒为 0、不生效），四角元素仍贴屏幕边缘。要求把所有 HUD 元素统一贴到**棋盘本身**的水平范围。

- **锚定棋盘替代 inset**：`LandscapeLayout.ts` 去掉 `inset`，三个 rect 直接按棋盘水平范围定义——`hudBottomLeftRect` 右边缘 = 棋盘左边缘（ink/血条落在左侧页边），`hudBottomRightRect.x` = 棋盘右边缘（刷新/升级按钮落在右侧页边），`handRect` = 棋盘范围本身（手牌铺满棋盘宽度、均匀分布）。因两侧页边各宽 `boardX` 且 `boardX ≥ (1920−1260)/2 = 330` 恒成立，300px 左列与 200px 右列始终放得下。`HUDView.ts` 里计时器锚定棋盘左边缘、投降按钮锚定棋盘右边缘。标准 16:9 下这会把四角从屏幕边缘拉到棋盘边缘（旧布局钉在 0/designWidth），超宽屏下也始终锁在棋盘。
- **对方名字**：`GameRenderer/base.ts` 的 `drawOpponentLabel` 给对手昵称加统一的 `drawHudButton('secondary')` 背景（按文字宽度自适应），并居中放到**对方血条前面**（血条本身仍锚定棋盘正中，`HUDView.getEnemyHpRect()` 新增暴露其 rect）；profile-tap 命中区经 `HUDView.setEnemyInfoRect()` 收紧到该名字按钮。竖屏分支未改动（走各自的 topR/全宽锚定）。
- 验证：`tsc --noEmit` 全绿；`LandscapeLayout.test.ts`「anchors the HUD strips」用例改写为棋盘锚定不变量（17 tests 通过）；用真实 `HUDView` 独立渲染在 1920×1080 下截图核对五处位置。

#### 4.22 关卡内投降按钮改「退出关卡」（2026-07-17）

用户反馈：关卡（PvE）里向「关卡」投降语义很奇怪。改为在**战役关卡**内把投降按钮及其确认框文案换成「退出关卡」；PvP/联机对局保持原「投降」文案不变（对真人认输语义正常）。

- **按 campaign 分支选 i18n key**：`HUDView` 构造函数新增 `campaign` 布尔（默认 `false`），按它在 `hud.surrender`/`hud.exitLevel`、`hud.surrenderTitle`/`hud.exitLevelTitle`、`hud.surrenderConfirm`/`hud.exitLevelConfirm` 之间取字（取消按钮 `hud.surrenderCancel` 共用）。行为逻辑（点击→确认→复用退出对局链路）完全不变，只换文案。
- **接线**：`GameRenderer` 新增 `setCampaignMode()`（`init()` 前调用，`buildSceneGraph` 里传入 `new HUDView(layout, campaignMode)`）；`GameScene` 镜像 `createLocalMatch` 的 mode 解析 `!net && (mode ?? (level ? 'campaign' : 'pvp')) === 'campaign'`——`goCampaign` 只传 `level`（无 mode/net）故为 true，PvP-vs-AI（`goGame` 无 level）与联机（`net`）为 false。新增 i18n key `hud.exitLevel*`（zh/en/de）。
- 验证：`tsc --noEmit` 全绿；新增 `test/render/hudSurrenderLabel.test.ts`（4 用例，含 PvP 不回归锁：默认/显式 `false` 两种构造都仍显示投降文案），render 套件 14/14 通过。

#### 4.23 战斗 HUD 敌我配色 + 低血两级告警 + 墨汁图标（2026-07-17）

用户反馈（对战截图标注）：血条敌我不分色；墨汁只有一个 `⬤` 字符无专属图标；30 金够升级时按钮提示不够醒目；投降按钮偏矮。并追加：敌方基地剩一两滴血时可能被加速突脸瞬间翻盘，低血提示要足够醒目。

- **血条按阵营配色**：`HUDView.drawHpBar` 改为吃 `color`——我方 `factionInk.friend`(蓝)、敌方 `factionInk.enemy`(红)；对方名字文字（`GameRenderer/base.ts drawOpponentLabel`）也改红。
- **低血告警＝动效，不用红**（用户拍板）：色相恒表阵营，危险靠「闪」表达，避免我方低血红与敌方红撞色。两级——**低血（≤3 格）**在自身色相里轻微脉动；**危急（最后一格 / ≤15% 基地血）**升级为快速闪烁 + 血条上方琥珀 ⚠（`drawHpWarning`）＋**棋盘上对应基地城堡四周脉动光环**（敌红催补刀/己蓝催防守，`BoardView.setBaseCritical(owner,on)`＋`applyCriticalRing`，环在 sprite 之下；`GameRenderer` 每帧按 ≤15% 触发）。棋盘光环是关键——突脸发生在棋盘、也是视线焦点，把注意力钉在真正要出事的地方。敌我基地同享此逻辑。
- **墨汁图标**：`render/icons/currency.ts` 新增 `drawInk(g,s,color)`（手绘墨水瓶＋一滴墨，我方蓝），替换 HUD 里裸的 `⬤`；每帧由 `positionInkIcon` 贴在数值左侧（横竖屏皆可）。真图待 AI 立绘替换（prompt 见提交记录）。
- **升级按钮特效**：够钱时除变 `primary` 蓝外，`animateUpgradeFx` 加马克笔黄（`fx.upgrade`）呼吸光环 + 上方跳动 `▼`。
- **投降按钮加高**：`BTN_H` 30 → 44。
- **单位阵营地面标记加强**：`UnitView.drawFactionMarker` 由 0.16/0.22 双椭圆改为 0.22/0.38/0.55 三层，脚下红/蓝更醒目。
- **.tao 瘦身**：`client/src/assets` 里 `infantry/max/shieldbearer` 三个仍残留 `shadow` 帧的旧包，外科式删掉 `spritesheet.json` 的 shadow 帧（保留 shadow 挂点＋PNG，程序阴影照常渲染），见 §file-formats。
- 验证：`tsc --noEmit` 全绿；`gameRenderer` UI 套件除一个**当日分支既有失败**（`gameRendererInput` 的 placement-highlight 用例，纯净当日分支上同样失败，与本改动无关）外全绿；render 套件 14/14。本机 dev-server 不稳（反复重编译挂 + 动画 ticker 卡截图 + WebGL 回读空白），实图未截，待人工在客户端眼看。

#### 4.24 血条格子 → 爱心，边界格按比例填色（2026-07-18）

用户看着战斗截图问：血条能不能换成爱心图标？边界那颗心要能按比例显示（例如三分之一变灰），而不是整格突变。

- **不出新美术**：沿用已有的矢量爱心（`icons/equipment.ts drawHp` 的心形参数曲线，同款几何抽成 `HUDView.ts` 里的 `heartPoints(s)`），因为血条每帧随呼吸闪烁重绘，`drawHp` 本身用 `SketchPen`（手抖笔触，含随机 jitter）画一次性图标就不适用——每帧重算会闪烁噪点，改用纯 `beginFill+drawPolygon` 的静态填色。
- **按比例填色不用 PIXI mask**：项目里从未用过 `.mask`，为避免遮罩在 canvas 回退渲染路径上的不确定行为，改用 **Sutherland–Hodgman 多边形裁剪**（`clipPolygonRight`，裁到 `x ≤ clipX` 半平面）——对边界心形按填充比例裁出左半边多边形再单独填色，纯几何、零遮罩 API 面。
- `HUDView.drawHpBar`：`totalFrac = hp/maxHp*HP_CELLS`，`filledFull = floor`，边界格 `frac = totalFrac - filledFull`（0~1），之前/之后的格子分别恒为 1/0；`drawHeartPip` 每格先画灰底心形，`frac>0` 时再裁色叠上去。低血两级闪烁（`fillAlpha`）、危急 `⚠`（`drawHpWarning`）逻辑不变。
- **验证技巧**：headless Browser 起 dev-server 拿不到真实对战（需登录+匹配），用 `client-run-and-visual-verify` 记忆里"单独渲染某个 Scene/方法"的套路——`app.ts` 临时挂 `__NW_APP/__NW_PIXI/__NW_HUDView`，浏览器里手搭一个只含 `HUDView.build()` 真正读到的字段的假 `ILayout`，直接 `new HUDView(fakeLayout)` + `hud.sync(fakeState)` + 两次 `render()` + `toDataURL()` POST 到本地 collector。踩坑：`baseHp` 得按 `BASE_HP`（=100）量纲给,不是随手填了个 733/1000 那种大数——超出量纲会把 `filledFull` 撑到远超 10 格,10 颗心全红,一度误判「比例填色没生效」。改用 `baseHp=44` 复现出 4 颗满心 + 第 5 颗左 40% 红/右灰 + 后 5 颗全灰的预期效果，截图确认后移除临时钩子。
- **测试**：`heartPoints`/`clipPolygonRight` 改成导出，新增 `test/render/hudHeartHpBar.test.ts`（8 用例）——几何层单测裁剪函数（不裁/全裁/半裁都落在裁剪线上），再用会记录 `beginFill/drawPolygon` 调用的 FakeGraphics 端到端跑 `HUDView.sync()`：满血 10 颗满宽彩色心、零血 0 颗彩色心（只剩灰底）、44/100 血=4 满+1 个约 40% 宽窄心+5 空、危急档（≤1 格）填色 alpha 必须 < 0.9（跟着闪烁，不能一直是满值）。
- 验证：`tsc --noEmit` 全绿；`npm run test:render` 5 个套件 23/23 全绿；浏览器截图确认爱心形状 + 边界格比例填色（4 满 + 1 部分 + 5 空）符合预期。
- **后续（同日）**：用户看图后要求爱心再放大到 1.5 倍。`HP_CELL_W/HP_CELL_H/HP_CELL_GAP`（14/10/2 → 21/15/3）等比放大；`HP_BAR_W` 及所有定位逻辑都是由这三个常量派生的，改常量即可整体缩放+重新居中，未碰任何布局代码。验证：同样的临时钩子单独渲染标准 1920×1080 `HUDView`，截图确认放大后两条血条爱心仍居中、不溢出。

#### 4.25 结算勋章评分归一化修复（2026-07-19）

用户反馈结算页「建造大师」（`BUILDER`）几乎每局必中，怀疑算法有问题。排查 `ResultScene.ts computeBadges()` 确认：6 个徽章按**原始数值**直接排序取最大，但各徽章原始值量纲完全不同——`buildingSurvivalTicks`（每个存活建筑每 tick 累加）一局 96 秒、几栋建筑全场存活就轻松上万，而 `damageDealtToBase`/`unitsSent` 等只有几十到几百，`BUILDER` 因此结构性碾压其余五个，与实际表现无关。顺带发现 `IRON_WALL`（铁壁防御）打分写成 `-damageTakenByBase`，恒 ≤0，被 `score > 0` 过滤条件挡死——**该徽章此前从未真正出现过**。

- **修法**：给每个徽章分数除以一个校准常数，换算到同一可比尺度（~1.0 = 该项"亮眼"水平）：`REF_DAMAGE=150`（TOP_DMG/IRON_WALL，~1.5×BASE_HP）、`REF_UNITS=60`（FLOOD）、`REF_BUILD_S=250`（BUILDER，先把 tick 换算成秒）、`REF_HITS=5`（PRECISION）、`REF_EFFICIENT=5`（EFFICIENT 的 kills/100gold 比率）。同时把 `IRON_WALL` 分数改成 `(REF_DAMAGE - damageTakenByBase) / REF_DAMAGE`，使其能在防守打得好时真正参与排序。
- **不改**：徽章展示逻辑（`buildBadgeMedallion`/hero 大字形）、i18n 文案、`value()`/`detail()` 的显示数值——只改 `score()` 用于排序的口径。
- **校准常数是经验估计**，非精确统计得出；后续如果某个徽章仍明显过冷/过热，应回来调整对应 `REF_*` 常量，而不是重新引入原始值比较。
- 验证：`tsc --noEmit` 全绿；`result-nav-onback.test.ts` + `game-nav-fight-again.test.ts` 全绿（均不依赖徽章排序具体结果）。因需完整对局才能触发真实结算页，未做浏览器截图验证。

#### 4.26 结算勋章 EFFICIENT 校准修复（2026-07-22）

用户反馈结算页「效率之星」（`EFFICIENT`）几乎每局必中，怀疑和自己操作习惯有关。排查确认这是 §4.25 遗留的**校准偏低**：`EFFICIENT` 是六个徽章里**唯一**按「比率」（`unitsKilled/goldSpent*100` = 每 100 ink 击杀数）打分的，且**无上限**；其余五个都是会在 `REF` 处饱和到 ~1.0 的量纲值。实测一局像样的对局约 8-13 kills/100 ink（一张单位卡 ~4-6 ink，通常至少换掉 1 个敌人），而 `REF_EFFICIENT=5` 让它算出 ~1.6-2.6，结构性高于其余徽章的 ~0.9-1.0，于是几乎每局都被它拿走——**对所有玩家都成立，与个人操作习惯无关**。

- **后台统计（2026-07-22 补）**：徽章原本完全是 `ResultScene` 客户端渲染、无埋点，无法从后台核实分布。已新增 `match_badges` 事件 + `badge_dist` 聚合 + ops「Analytics」页透视表，专门盯「是否人人同称号」——详见 `ANALYTICS_DESIGN.md` §5.8。事件里带原始数值（击杀/花费 ink 等），供后续用真实分布**精确重校** `REF_*`（当前值仍是估算）。
- **修法**：`REF_EFFICIENT` 5 → 12，使一局像样对局的效率分数居中到 ~1.0，与 `FLOOD`/`IRON_WALL` 等公平竞争——只在你**确实打得省 ink** 时才拿这个徽章。仅改 `score()` 排序口径，展示（仍显示原始击杀数「Killed N enemy units」）、i18n、`value()`/`detail()` 均不动。
- 验证：`tsc --noEmit` 全绿。完整对局才能触发真实结算页，未做浏览器截图验证。

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

## 11. 头像系统（2026-06-28；2026-07-20 重做：新美术 + 服务端同步 + 多品类头像）

**结论**：已实现。8 种预设头像换成 AI 手绘插画；头像选择跨玩家可见（服务端同步）；新增称号/角色/装备/材料/皮肤共 5 个品类可选作头像，未解锁（从未拥有过）置灰 + 点击提示解锁方式，解锁判定为**终身制**（历史上拥有过一次即永久解锁，即使当前背包已无该物品）。

### avatarId 数据格式

复合字符串 `"<category>:<key>"`：`preset:0`~`preset:7` / `title:<titleId>` / `hero:<unitType>` / `equip:<equipDefId>` / `material:<kind>` / `skin:<skinId>`。旧的纯数字字符串（`'0'`~`'7'`，改造前 localStorage 里已有的值）按 `preset:<n>` 兼容解析（`render/avatar.ts` 的 `parseAvatarId`）。

### 预设头像美术（8 种，Phase A）

`art/ui/head/` 下 8 张 AI 手绘线稿（白线透明底），经 `pack_avatar_atlas.cjs` 打包进 `client/src/assets/avatars/avatars.png`+`.json`；`client/src/render/avatarAtlas.ts`（镜像 `materialAtlas.ts`/`equipmentAtlas.ts` 的加载范式）在 bootManifest L0 阶段加载，`buildAvatarIcon(key, size, color)` 提供纹理，未加载完成前降级到旧的 `buildIcon()` 程序化图标。`AVATAR_DEFS`（icon key + 底色）本身不变：

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

### 服务端同步（Phase B）

- `save.equipped.avatar`（复用既有 `equipped: Record<string,string>` 通用装配袋，同 `equipped.title` 的写法，无需 schema 迁移）。
- `PUT /avatar/equip`（`server/metaserver/src/service/liveops.ts` 的 `equipAvatar`，仿照 `equipTitle` 结构）：`preset:*` 恒许可；其余品类校验 `titles[]`/`everOwned.*`/`inventory.skins`，不满足 → 403。客户端实际走法与 `equipTitle` 一致——`onSetAvatar` 直接 `saveManager.update(d => d.equipped.avatar = id)`，由既有 `PUT /save`（equipped/flags 通用同步段）推送，`equipAvatar` REST 端点作为有实际校验的官方契约保留（同 `equipTitle` 现状，client 暂未直接调用）。
- `ProfileView`/`FriendView`（`server/shared/src/social.ts` + `openapi/schemas.yml`）加 `avatarId?`；`profileOf()`/`getProfile()`（metaserver `social.ts`/`accounts.ts`）比照 `equippedTitle` 读取 `equipped.avatar`；`FamilyMemberView`（socialsvc `familyService.ts`）、`getFriends()`（socialsvc `friendService.ts`）同步透传。
- 对战对手信息：`opponentAvatarId` 沿 `opponentTitle` 的既有链路整条打通——`gateway/metaClient.ts` → `Gateway.ts` → `matchsvc`（`Matchmaking.ts`/`Matchsvc.ts`/`internalHttp.ts`）→ `TicketClaims`（`server/shared/src/ticket.ts`）→ `gameserver`（`RoomManager.ts`/`Room.ts`）→ `transport.proto`（`MatchStart.opponent_avatar_id = 11`）→ 客户端 `NetInputSource.ts`/`nav/result.ts`。
- 客户端展示：`ProfilePopup.ProfileData.avatarId`（此前完全未接，永远走首字母兜底——本次一并修掉）、`FriendsScene`/`FamilyScene` 的成员行头像。

### 终身拥有记录 everOwned（Phase C）

`SaveData.everOwned?: { hero?, equipment?, material?, skin? }`（`server/shared/src/types.ts` + 客户端镜像 `game/meta/SaveData.ts`），全部 `$addToSet` 追加、永不删除：

- 称号不需要：`titles[]` 本来就是终身记录。
- 角色：`grantCards`/`grantCard`（`cards.ts`）写入 `everOwned.hero`。
- 装备：`grantEquipment`（`equipment.ts`）+ PvE 装备掉落（`service/pve.ts`）写入 `everOwned.equipment`。
- 材料：签到/邮件/PvE 奖励/gacha 交付（`liveops.ts`/`economy.ts` 的 `deliverGrant`/`deliverMailGrant`）+ 内部经济路由（`internal/economyRoutes.ts`）写入 `everOwned.material`。
- 皮肤：`grantSkin`（`skin.ts`）+ gacha/mail 交付写入 `everOwned.skin`；`escrowSkin`（拍卖行寄售）**不**从 `everOwned.skin` 删——只有这个类别的"当前拥有"和"终身拥有"会分叉。

### 选择器 UI（Phase D）

`client/src/scenes/SettingsScene.ts` 的 `drawAvatarPickerOverlay()` 从固定 2×4 网格重写为：6 个分类 tab（预设/称号/角色/装备/材料/皮肤，复用 `HubTabs.drawHubTabs`）+ 可滚动网格（`ScrollTapGesture` 拖动手势 + `ScrollIndicator` 滚动条，同 `CardScene/list.ts` 的范式）。未解锁项整体降低透明度并叠加锁形图标（`buildIcon('lock', ...)`），点击弹出 2.2 秒的解锁提示 toast（场景本地状态，非全局 `showToastMessage`）。`buildAvatar()`（`render/avatar.ts`）按 category 分派图标来源：称号→`titleArt.ts`，角色/皮肤→`cardArt.ts` 的 `UNIT_ART_URLS`（人物立绘裁圆，皮肤复用同一角色立绘——皮肤没有独立 2D 美术），装备→`equipmentAtlas.ts`，材料→`materialAtlas.ts`。

### 上线次日修复（2026-07-20 补丁）

上线当天即发现老账号（功能上线前就已拥有角色/装备/材料的账号）角色与装备 tab 全部显示未解锁，另外角色头像立绘明显被截断（看不到头部）。三处根因 + 修复：

- **`everOwned` 未回填历史数据**：账号在功能上线前已拥有的角色/装备/材料，从未经过 `grantCard`/`grantEquipment`/`deliverGrant` 等写入点，`everOwned` 里自然是空的——不是数据丢失，是这些账号的物品从未被"记录"过。没有加服务端迁移脚本，而是让客户端解锁判定同时看"当前持有"（`save.cardInv`/`equipmentInv`/`materials`）和"终身记录"（`everOwned`）的并集——`nav/auth.ts` 新增 `ownedHeroes`/`ownedEquipment`/`ownedMaterials` 三个 prop 传给 `SettingsScene`，与已有的 `ownedSkins` 是同一模式。
- **角色解锁 key 对不上**：`everOwned.hero`/`cardInv` 按 `CARD_DEFS` 的 `id`（如 `lichuang`）记录，但 `pickerItems()` 的判定却拿去和 `unitType`（如 `infantry`）比对——两个命名空间不一致，导致 `lichuang`/`chenshou`/`suyuan` 无论如何都解锁不了（`max`/`lena`/`mara` 因为 `id === unitType` 才凑巧能过）。改成按 `d.id` 判定，`makeAvatarId` 仍用 `d.unitType`（美术查找用的 key）不变。
- **角色立绘截断**：`buildPortraitIcon`（`render/avatar.ts`）原来"铺满裁圆再放大 1.6 倍、锚点在图片纵向 42% 处"，对 max/lena/mara 这类又高又窄的全身立绘（宽高比低至 0.4）会把可视窗口顶到腰部——头完全看不到。改为单纯按宽度铺满 + 顶部对齐（`anchor.set(0.5, 0)`），因为六张立绘都是头部紧贴画布顶边的全身图，这样任何宽高比都稳定露出头部，牺牲的只是下半身（符合头像"半身/胸像"裁剪的预期）。

## 12. 图标卡字号统一放大（2026-07-09）

**问题**：Equipment（Craft/Inventory 两格）与 CardScene（Hero Roster）三处图标卡（`EQUIP_CELL_H`/`CARD_CELL_H` 均 177×480）字号历史上各自为政且偏小（名称 13-14px、副行 10-12px），读起来费力。

**方案**：三处统一放大到同一套字阶——名称 20px（bold）、次级标签（rarity/等级/战力/兵力）16px、三级小标签（equipped/injured/in-team 等状态 tag）13-14px、Craft 按钮 17px。字号不是简单 ×2（会溢出固定格高），而是把格内布局的上部留白从 `pad+22/24/28` 统一加到 `pad+30/32/36`，图标框相应收窄，换出空间给更大字号；Craft 按钮从 80×28 放大到 104×36。

- `client/src/scenes/EquipmentScene/base.ts`：`drawCostChips` 的 cost 数字标签原硬编码 10px，改为随传入的 `size` 参数联动（`size*0.8`），craft/detail 两处调用各自可控。
- `client/src/scenes/EquipmentScene/craft.ts`：`renderCraftCell` 名称/rarity/成本 chip/按钮字号 + 布局偏移同步放大。
- `client/src/scenes/EquipmentScene/inventory.ts`：`renderInstanceCell` 名称/rarity/equipped tag/堆叠数/操作提示字号 + 布局偏移同步放大。
- `client/src/scenes/CardScene/list.ts`：`renderCardCell` 名称/Lv./战力/兵力/状态 tag 字号 + 布局偏移同步放大。
- `EquipmentScene/inventory.ts` 顶部的三格装备槽条（`renderLoadout`）与 `detail.ts` 的详情弹窗不在本次范围内（不是"图标卡"网格，是独立的槛/弹窗控件）。

## 13. Hero Roster 卡片：满高立绘 + 右侧信息（2026-07-14）

**问题**：Hero Roster 图标卡沿用"名称占顶栏 / 方形立绘居左下 / 属性列在右"的布局，格宽 480 太宽，方形立绘（约 121×121）下方与右侧属性列之间留白很大，整张卡显得空。

**方案**：立绘改为占满整格高度的竖长框（左侧，`imgH = CARD_CELL_H - pad*2`，宽取 `imgH*0.72`，贴合单位立绘"高>宽"的比例），所有信息（名称+阵营点、Lv.、战力、兵力、状态 tag、装备三点）统一堆到立绘右侧一列；格宽目标 `CARD_CELL_W_TARGET` 从 480 收窄到 300，卡片排得更密（1854 宽下每行 3→5 张）。仅改角色卡，`EquipmentScene` 的 `EQUIP_CELL_W_TARGET` 独立不受影响。

- `client/src/scenes/CardScene/base.ts`：`CARD_CELL_W_TARGET` 480→300；`drawArtFit` 新增可选 `boxH` 参数，支持把立绘按较紧的一轴等比缩放并居中塞进非正方形框（满高格不裁切、不拉伸）。
- `client/src/scenes/CardScene/list.ts`：`renderCardCell` 重排为"满高立绘居左 + 右侧信息列"；名称按右列可用宽度裁剪，锁标仍在信息列右上。边框色状态（injured 红 / deployed 蓝）与装备三点不变。
- 验证：`tsc --noEmit` 通过；用 `__NW_DEBUG` 临时钩子在 1854×960 landscape 下孤立渲染 CardScene（mock 11 张卡）截图核对，满高立绘/右侧信息/密度/状态色均正确，临时钩子已移除。

## 14. FamilyScene 文字放大 + 加深（2026-07-14）

**问题**：家族界面（名册/频道/信息栏/建家表单/底栏）所有文字用**硬编码绝对字号 10–15px** + 行高固定 `ROW_H=48`，在 1080/1920 高的设计空间里只有标题的约 1/3 大小；加上大量用浅灰 `C.mid`（`0x888888`）画正文，纸底上几乎看不清。社交 Hub 其余场景（FriendsScene 等）早已按设计高度百分比（`h*0.024`~`0.03`）定字号——FamilyScene 是唯一没跟上的。

**方案**：把 FamilyScene 全部字号改为按设计高度比例计算，与 FriendsScene 对齐；正文型浅灰标签改用更深的 `MUTED=0x5a574f`（层级仍低于 `C.dark`）。

- `client/src/scenes/FamilyScene/base.ts`：删除模块级 `export const ROW_H=48`，改为实例 getter——`fs(frac)=round(h*frac)`、`rowH=round(h*0.062)`、`infoBandH=round(h*0.085)`。
- `client/src/scenes/FamilyScene/render.ts`：名称 `fs(0.026)`、家族名 `fs(0.03)`、按钮/标签页 `fs(0.024)`、成员数/繁荣度/占位符 `fs(0.022)`、角色/发送者 `fs(0.019~0.02)`；`MUTED` 替换正文浅灰；繁荣度金色调深到 `0xa9750f`。
- **竖屏因放大暴露的溢出**一并修掉（`h` 远大于 `w`、字号按 `h` 缩放而框宽按 `w`，见 [[ilayout-landscape-design-width-stretches]] 的对偶）：晋升/踢出按钮、底栏 Sect/解散 按钮改按**文字宽度 + padding 自适应**（原固定宽把 "Promote to Elder"/"Dissolve Family" 截断）；成员名与公告按可用宽度省略号截断（新增 `fitSize()` 助手把标签页文字缩到框内）。
- 验证：`tsc --noEmit` + 家族相关 47 项测试通过；用临时 `?family` 调试分支（mock 家族数据，已删除）在 1920×1080 横屏与竖屏两种布局下孤立渲染 FamilyScene 截图核对，字号/对比度/自适应按钮/名称截断均正确。

## 15. 拖拽滚动全场景节流修复（2026-07-15）

**问题**：用户反馈 FamilyScene（帮会/家族界面）拖动列表非常卡顿。排查发现这是一类跨场景的通病，与 §15.3（`SEASON_DESIGN.md`）已修过的 BattlePassScene 拖动卡顿是**同一根因**：`handleMove` 每次位移超过 6px 就直接调用一次完整 `render()`——即 `tearDownChildren` 全场景推倒重来（销毁+重建所有 Text/Graphics，家族/宗门列表每行还带手绘 `sketchPanel` 描边）。而 `InputManager._emitMove` 是直接从原始 DOM `pointermove`/`touchmove` 事件派发，**完全没有节流**——这类事件的触发频率常常远高于屏幕刷新率，一次拖动手势就能在同一帧内触发几十次昂贵的全场景重建。

BattlePassScene 当初是把「滚动定位」和「内容重建」两条路径彻底拆开（`updateScrollPosition()` 只挪 `scrollContainer.y` 不碰 Graphics）；这次为了以最小改动面覆盖全部受影响场景，改用更轻的节流方案：

**改动**：`handleMove` 不再直接调 `render()`，只更新 `scrollY`/`scrollYChannel` 并置位一个 `scrollDirty` 标记；真正的 `render()` 挪到 `update(dt)`（由 `SceneManager` 每渲染帧调用一次）里去消费。这样无论一帧内收到多少次 `pointermove`，最多只触发一次重建，和帧率对齐——而不是像 BattlePassScene 那样完全避免重建，是「限流」而非「消除」，但对这批场景（成员列表/拍卖行/装备/卡牌/商店/组卡）的重建成本而言已经足够。

覆盖场景（`FamilyScene`/`SectScene`/`AuctionScene`/`EquipmentScene`/`CardScene`/`ShopScene`/`DeckBuilderScene` 的 `base.ts` 或场景文件本体）：
- `client/src/scenes/FamilyScene/base.ts`、`client/src/scenes/SectScene/base.ts`
- `client/src/scenes/AuctionScene/base.ts`、`client/src/scenes/EquipmentScene/base.ts`、`client/src/scenes/CardScene/base.ts`
- `client/src/scenes/ShopScene/base.ts`、`client/src/scenes/DeckBuilderScene.ts`

`CardCodexScene`/`BattlePassScene` 已有各自的重定位快速路径，未改动；`WorldMapInput.ts` 的地图内信息面板拖动滚动（作用域比全场景小得多，且相关分支已有未合并的独立测试改动，见 [[worldmap-info-scroll-tests]]）本次未动。

测试：新增 `client/test/ui/scrollDragThrottle.ui.ts`（7 例，覆盖以上全部场景）——断言同一拖拽手势内多次 `pointermove` 只在下一次 `update()` 触发恰好一次 `render()`，无移动的后续帧不再重复渲染。`tsc --noEmit` + 全量 `npm test`/`test:ui`/`test:render` 全绿。

### 15.x LeaderboardScene / FriendsScene / ChatScene 补漏（2026-07-18）

**问题**：用户反馈 Leaderboard（排行榜）界面拖动很卡——本节修复时漏掉了这个场景，`onPointerMove` 仍在每次超过拖拽阈值的位移上直接调 `this.render()`，全量重建 Top-100 的每一行（含奖牌图标/头衔标签）。顺带排查了当时未覆盖的其余 `onMove`/`handleMove` 场景，又发现 **FriendsScene**（好友/frenemy 列表）与 **ChatScene**（1:1 消息列表）是同一根因，同样漏在 2026-07-15 那批之外。

**方案**（两种，视场景选用）：
- **LeaderboardScene**：不采用本节的「置脏 + update() 统一消费」节流方案，改用 §15 已提到的 BattlePassScene 重定位快速路径（更彻底，直接消除重建而非限流到每帧一次）——`render()` 里缓存 `listContainer`/`listTop`/`listH` 与每行的 `rowDefs`（绝对 y/高/点击回调），新增 `updateScrollPosition()` 只挪 `listContainer.y`、重画 `drawScrollIndicator`、按可见范围从 `rowDefs` 重算命中矩形；`onPointerMove` 拖拽分支改调 `updateScrollPosition()`，不再调 `render()`。
- **FriendsScene/base.ts**、**ChatScene.ts**：改用本节的「置脏 + update() 统一消费」节流方案（与改动面更小，两个场景都已有 `update(dt)` 且已在其中 drain 别的脏标记）——新增 `scrollDirty` 字段，`onPointerMove` 拖拽分支把 `this.render()` 换成 `this.scrollDirty = true`，`update(dt)` 顶部补上 `if (this.scrollDirty) { this.scrollDirty = false; this.render(); }`。

测试：
- 新增 `client/test/ui/leaderboardScroll.ui.ts`（5 例）——断言拖拽期间 `render()` 全程不被调用、`listContainer` 实例复用、`y` 精确按 `-dy` 移动、滚出初屏的行命中矩形滚回可视区后仍能触发 `onOpenProfile`。
- 在 `client/test/ui/scrollDragThrottle.ui.ts` 补上 FriendsScene（30 条好友）/ ChatScene（40 条消息）两个用例，复用同一断言契约（同一拖拽手势内多次 `pointermove` 只在下一次 `update()` 触发恰好一次 `render()`）；ChatScene 默认贴底（`scrollY===maxScroll`）而 FriendsScene 默认在顶（`scrollY===0`），拖拽方向相反，故补了一个 `assertScrollDragThrottledUpward` 变体覆盖后者。

`tsc --noEmit` + 全量 `test:ui`（652 例）全绿。

## 16. TeamsScene（Attack Teams）卡片化重排（2026-07-15）

**问题**：5 个进攻编队槽位是 56px 高的细条列表，空槽位只有一行灰字 `(empty)`，看不出编队预览；下方的 Hero Roster 名册是 40px/行的窄条，小字挤在一起且**硬性截断**（`if (y + CARD_ROW_H > h - 8) break`）——超出屏幕的卡直接不画，没有滚动条，和 §13 已经改过的 Roster 满高立绘卡片、Skins masonry 网格视觉语言完全不统一。

**方案**：5 个槽位改成 2 列卡片网格（`TEAM_COLS=2`，`TEAM_CARD_H=132`）——已编队卡片显示部署单位的迷你立绘条（最多 6 个 + `+N` 溢出）与「Garrison n / Troops n」汇总，空槽位改为浅描边 + 居中 `+` 与「Tap to build」提示，与已编队卡片的深色实心描边形成对比；下方 Hero Roster 改用与 §13 Roster 网格同语言的满高立绘卡片（`ROSTER_CELL_H=108`，比 Roster 页更矮，无需装备槽/锁标），并补上 `drawScrollIndicator` + 拖拽滚动（新增 `scrollY`/`scrollDirty`，遵循 §15 的节流模式，`handleMove` 只置脏、`update()` 里统一 drain），替换掉原来的截断行为。

- `client/src/scenes/TeamsScene.ts`：`renderTeamGrid`/`renderTeamCard` 替换原逐行渲染；`renderCardRoster`/`renderCardRosterCell` 改为可滚动网格；新增本地 `drawArtFit`（`getArtTexture` + 首帧未就绪时挂 `loaded` 一次性重渲染，与 `CardScene/base.ts` 的同名方法逻辑一致）。
- `client/src/i18n/locales/{en,zh,de}.ts`：新增 `world.team.tapToBuild`。
- 验证：`tsc --noEmit` + webpack 构建通过；用 `__NW_DEBUG` 临时钩子（`app`/`InputManager`/`TeamsScene`，验证后已移除）孤立渲染 TeamsScene（mock 5 队伍 + 60 张卡的 cardInv/cardState）截图核对：编队卡片迷你立绘/空状态/injured 标签、Roster 网格立绘加载、滚动条 + 拖拽滚动（`scene.handleDown`/`handleMove` 直接调用验证 `scrollY` 正确累积）均正确。

## 17. 隐藏 `<input>` 的 blur 处理程序 removeChild 竞态修复（2026-07-15）

**问题**：生产环境上报的高频 jserror `Failed to execute 'remove' on 'Element': The node to be removed is no longer a child of this node. Perhaps it was moved in a 'blur' event handler?`。根因是 `FamilyScene`/`SectScene` 的 `openInputFor()`（`input.ts`）与 `AuctionScene` 的 `openBuyerInput()`（`createForm.ts`）都会创建一个不可见的 `<input>` 挂到 `document.body`，其 `blur` 监听器用 `document.body.removeChild(inp)` 卸载它；但当玩家在该输入框聚焦状态下切走场景时，场景自身的 `destroy()`（如 `FamilyScene/base.ts`）会先用幂等的 `inp.remove()` 把节点摘掉——摘掉一个聚焦中的节点会触发它自己的 `blur` 事件，此时 blur 处理程序仍会执行，对一个父节点已经不存在的元素调用 `removeChild()` 从而抛出异常（`.remove()` 对已摘除的节点是安全的空操作，`removeChild()` 不是）。

**修复**：三处 `blur` 处理程序内的 `document.body.removeChild(inp)` 统一换成 `inp.remove()`（与场景 `destroy()`、以及同文件里本来就正确的 `openSendInput()` 保持一致的幂等写法）。

- `client/src/scenes/FamilyScene/input.ts`、`client/src/scenes/SectScene/input.ts`：`openInputFor()` 的 blur 处理程序。
- `client/src/scenes/AuctionScene/createForm.ts`：`openBuyerInput()` 的 blur 处理程序。
- 验证：`tsc --noEmit` 通过；纯 DOM 时序 bug，无可视差异，未截图验证。

## 18. 全场景 Toast 放大 2 倍 + 移到底部三分之一高度（2026-07-16）

**问题**：真人截图走查发现 Equipment 场景「Enhance failed (materials spent)」这类错误提示条字号偏小（13px）且几乎贴着屏幕最底边（`h-80`/`h-92`），容易被底部按钮/安全区裁切或忽略。走查代码发现全部场景的 `showToast()` 实现各自为政、彼此重复但数值不一：

- 带底板的三处几乎相同实现（`EquipmentScene/base.ts`、`CardScene/base.ts`、`TeamsScene.ts`）：`txt(msg, 13, ...)` + `padX 14 / padY 8` + `by = h - 92`。
- 纯文字无底板（`AuctionScene/base.ts`、`FamilyScene/base.ts`、`SectScene/base.ts`、`DefenseEditorScene.ts`）：`txt(msg, 13, ...)`，`y` 在 `h-80` 附近。
- 走 `render()` 里 `this.toast` 字段的四处（`CityScene.ts`、`DailyScene.ts`、`EventScene.ts`、`BattlePassScene.ts`）：字号/位置各写各的，只有 `DailyScene` 已经用 `h*(2/3)` 定位（本次改动前唯一符合"底部三分之一"的实现）。
- 全局兜底 `ui/GlobalToast.ts`（无场景自带 toast 时的错误兜底）同样贴底（`h*0.86`）。

**修复**：统一把全部 14 处 `showToast`/toast 渲染的字号翻倍（固定 13px→26px；相对字号 `h*0.028`→`h*0.056`），底板 padding 同步翻倍，定位统一改为**中心落在 `h*(2/3)`**（屏幕底部三分之一的分界线，而不是贴着最底边）：

- `EquipmentScene/base.ts`、`CardScene/base.ts`、`TeamsScene.ts`：`by = Math.round(h*2/3 - bh/2)`。
- `AuctionScene/base.ts`、`FamilyScene/base.ts`、`SectScene/base.ts`、`DefenseEditorScene.ts`：`lbl.y = Math.round(h*2/3)`（anchor 改为 0.5,0.5 居中）。
- `CityScene.ts`：底板 `36→72`，定位 `tg.y = h*2/3 - th/2`。
- `DailyScene.ts`（原本就是 `h*(2/3)`，本次只放大字号/底板）、`EventScene.ts`、`BattlePassScene.ts`：底板/字号翻倍，`toastCy` 统一改为 `h*(2/3)`。
- `ui/GlobalToast.ts`：同步处理（虽不在 14 处场景 toast 之列，但视觉同属一类提示条）。

`worldmap/WorldMapPanels.ts` 的 toast **未改动**——该处此前已被专门放大到 26px 并刻意定位在 `h/3`（上三分之一），是为了避开世界地图底部的操作栏（见 [[worldmap-toast-size-position-2026-07-15]] 记忆），移到下三分之一会重新引入被底部 UI 遮挡的问题。<!-- NOTE §19 起字号已收进 FS 档位表，本节列的 13/26/`h*0.056` 等具体数值现由 `FS`/`snapFont` 表达；语义（翻倍、底部三分之一定位）不变。 -->

`tsc --noEmit` 全绿；用临时 `__NW_APP`/`__NW_PIXI` 调试钩子（改完即移除）复刻了 Equipment 版 toast 的字号/padding/定位公式，截图确认底板中心落在 `h*2/3` 参考线上、字号是原来的 2 倍。

**测试**：新增 `client/test/ui/toastBottomThird.ui.ts`（vitest test:ui），覆盖三种结构里各一个代表性场景——带底板三处之一(EquipmentScene/CardScene/TeamsScene 共享同一实现，各自单独起一个用例)、纯文字三处(AuctionScene/FamilyScene/SectScene)、`render()`-驱动两处(DailyScene/CityScene)，外加 `GlobalToast`，共 9 条用例：断言字号翻倍、面板/文字的纵向中心落在 `Math.round(designHeight*2/3)`（CityScene 的文字非居中锚定，改为断言其面板中心）。`EventScene`/`BattlePassScene`/`DefenseEditorScene` 与已覆盖的姊妹场景公式完全相同，未重复建场景省测。测试过程中发现 landscape 布局的 `designHeight` 固定钉在 1080（`LandscapeLayout.DESIGN_H`），与传入 `createLayout()` 的物理高度无关——测试里必须用 `createLayout(...).designHeight` 反推期望值，而非直接用输入的 H。`npm run test:ui` 全绿（9/9）。

## 19. 字号统一到语义档位表 `FS`（2026-07-16）

**问题**：全客户端字号完全分散、无单一来源。共 ~590 处字号设置（`txt(label, size, …)` 550 处 + 直接 `fontSize: N` ~40 处），跨 61 个文件，且分两套互不相容的风格：
- **固定像素**（约 490 处）：23 个不同数值（9–60px），小字扎堆 `10/11/12/13`、正文 `14–18`、标题散落 `20/26/…/42/60`。
- **响应式比例**（约 100 处）：`Math.round(h * 0.026)` 一类，**48 个不同的比例系数**，基准维度还不统一（有的乘全屏 `h`、有的乘 `cardH`/`btnH`/`ph`/`unit`）。

同一"语义"的文字（例如卡片副标题）在不同场景可能是 12、13、`0.026*h`、`0.024*h`……毫无一致性；想统一调"所有小标签"只能全局 grep。

**方案**：新增单一权威模块 `client/src/render/fontScale.ts`，导出语义档位表 `FS` 与 `snapFont(px)`。所有档位为 **1080 设计坐标空间**的固定 px（横屏 `designHeight`、竖屏 `designWidth` 均为 1080，同一 token 在两种朝向下渲染尺寸一致）。九档＋一超大：

| token | px | 用途 |
|---|---|---|
| `micro` | 11 | 计数、计时、"/cap" 后缀、小徽标 |
| `tiny` | 13 | 次级标签、提示、成本行、密集元信息 |
| `small` | 16 | 紧凑正文 / 密集列表行 |
| `body` | 18 | 默认正文、标准按钮标签 |
| `bodyLg` | 20 | 强调正文、道具/卡牌名 |
| `label` | 24 | 分区标签、小标题、列表分组标题 |
| `heading` | 28 | 面板标题、显眼计数 |
| `title` | 32 | 场景/面板标题 |
| `headline` | 42 | 大标题、Toast、醒目标注 |
| `display` | 60 | 结算/闪屏大数字 |

**迁移规则**（一次性全量迁移 ~590 处，`tsc --noEmit` + 生产构建 `build:web` 全绿，无残留字面量）：
1. **固定整数** → 按档位带映射为 `FS.<token>`：≤11→micro；12–14→tiny；15–16→small；17–18→body；19–21→bodyLg；22–25→label；26–29→heading；30–35→title；36–47→headline；≥48→display。
2. **响应式且基准是整屏维度**（`h`/`height`/`designHeight`/`w`/…）→ 按 `比例×1080` 折算后归入上表档位，落成固定 `FS.<token>`。
3. **响应式但基准是可变控件尺寸**（按钮/卡片/行高等，如 `btnH`/`cardH`/`unit`/`ph`）→ 保留随控件缩放，但用 `snapFont(<原表达式>)` 吸附到最近档位（`snapFont` 平局向大取，重可读性）。`WorldMapPanels.ts` 的 `addText`/`panelButton` 包装函数在内部对 size 统一 `snapFont`，其 `*S`（2×）缩放面板的字号亦随之落到档位上。
4. **例外**：`ui/GlobalToast.ts` 在**真实屏幕像素**空间渲染（非 1080 设计空间），故保留 `snapFont(Math.round(h*0.052))` 以随实际画布高度自适应，而非钉死一个固定档位。

**收益**：把 23 个固定值 + 48 个比例系数收敛成 10 个语义 token；改动幅度对绝大多数站点 ≤±2px（视觉近乎无损），全局重新调字号只改 `fontScale.ts` 一处。三个历史上各自独立的 `txt()` helper（`sketchUi.ts`/`LobbyScene/base.ts`/`SettingsScene.ts`）签名不变，仍收 `size: number`——`FS.*` 只是数值来源，调用点写 `txt(label, FS.body, …)`。

> ⚠️ **本次仅做代码层验证（tsc + webpack 生产构建全绿、脚本扫描确认无残留字面量）**；实时游戏内截图核对因本地未起后端（`/bootstrap` 失败 → canvas 0×0）+ Browser-pane 渲染停顿（已知环境问题）未能完成。后续起完整后端栈时应抽查 CityScene / ResultScene / Equipment / 各 Toast 等信息密集场景确认无溢出/裁切。

## 20. 全场景自绘 Toast 并入 `GlobalToast`（2026-07-17）

**背景**：§18 只统一了各场景自绘 toast 的**字号/位置**，但每个场景仍各自维护一套 toast 机制——`toastLayer`+`toastTimer`（渲染循环里手动倒计时清层）、或 `render()` 里读 `this.toast` 字段重绘、或 `toastKey`/`toastT`。重复、易漏（新场景常忘记加倒计时块），且已存在一个更干净的全局出口 `net/log` 的 `showToastMessage(text, kind)` → `GlobalToast`（ShopScene 早已只用它，不自绘）。

**方案**：把全部 hub/社交场景的自绘 toast 删掉，统一改为调用 `showToastMessage(msg, kind)`。`GlobalToast` 挂在 `app.stage`（z=10000，真实屏幕像素空间），带淡入淡出、自动过期，浮在所有场景之上，居中于 `h*(2/3)`——成为唯一的 toast 渲染器。**配色收敛为两色**：`success`→绿、`error`→红（app.ts 里的 sink 完成 kind→色映射）。各场景保留原 `showToast(msg, color)` 方法签名（内部委托 `showToastMessage`，`color === C.red ? 'error' : 'success'`），或对单色/`toastKey` 场景加一个 `kind` 参数；调用点几乎不动。

- **`toastLayer`+`toastTimer` 类**（删字段/创建/渲染循环倒计时块/绘制体）：`EquipmentScene`、`CardScene`、`AuctionScene`、`SectScene`、`FamilyScene`、`TeamsScene`、`DefenseEditorScene`。
- **`render()`-驱动 `this.toast` 类**（删字段/`drawToast`/`render` 调用，赋值点改为直接 `showToastMessage`）：`GachaScene`、`DailyScene`、`EventScene`、`BattlePassScene`、`CityScene`、`SettingsScene`、`AchievementScene`。
- **`toastKey`/`toastT` 类**（社交，原 toast 定位在顶部避开底部输入框；并入后统一到底部三分之一）：`ChatScene`、`RoomScene`、`FriendsScene`（`base.ts` 的 `toast(key)` + `service.ts` 十余处调用，成功态传 `'success'`，其余默认 `'error'`）。

**刻意保留、未并入**：
- `worldmap/`（`WorldMapPanels.showToast` + `WorldMapNet`/`WorldMapInput` 经 `ctx.panels` 调用）——见 §18 与 [[toast-size-position-unification-2026-07-16]]，其 toast 定位/尺寸是为世界地图专门调过的，仍自绘。
- `LobbyScene` 的 `showAchievementToast`/`showInfoToast`——那是**可点击跳转成就墙、带奖杯/地球图标、定位在顶部**的横幅，不是普通 success/error 提示条；`GlobalToast` 无图标/无点击路由，并入会丢功能，故保留原样。

**验证**：`tsc --noEmit` 全绿。重写 `client/test/ui/toastBottomThird.ui.ts`：旧断言各场景自绘 banner 的几何，现改为断言（1）代表性场景 `showToast()` 经 spy sink 收到正确 `kind`（红→error、绿/中性→success），（2）`GlobalToast` 仍居中于 `h*(2/3)`，（3）`WorldMapPanels`（排除项）仍自绘于 `h*(2/3)`。另修正 `auctionScene.ui.ts`、`mailDeleteAttachmentGuard.ui.ts` 两处原断言 `scene.toastLayer`/`scene.toastKey` 的用例——改为捕获 sink。`npm run test:ui` 全绿。

## 21. 三频道聊天单行 name-tag 展示 + 发送者称号/宗门/家族前缀（2026-07-17）

**背景**：World/Family/Sect 三个聊天频道各自把"发送者名字"和"消息内容"画成两行（`sender.y`/`body.y` 各占一行），且发送者名字没有视觉区分，纯文字混在气泡里。用户要求改为单行 `[称号][宗门][家族]名字: 内容`（方括号内字段缺省则不显示），名字部分加背景色块与内容区分，内容不再单独换行。

**方案**：
- 新增共享渲染 helper `client/src/render/chatRow.ts`：`chatNameLabel(sender)` 拼出 `[title][sectName][familyName]senderName` 前缀（各段缺省即跳过）；`drawChatLine(layer, x, y, sender, body, nameSize, bodySize)` 在同一行画出「名字（背景色块）+ `: ` + 内容（无背景）」，`y` 为整行垂直中心，不再分两行。
- 三处调用点改用该 helper：`FriendsScene/worldChat.ts`（世界频道，行高 `h*0.095`→`h*0.06`，单行够用）、`FamilyScene/render.ts` 的 `renderChannel()`、`SectScene/render.ts` 的 `renderChannel()`。
- **数据链路补齐**（此前三个消息视图只有 `senderName`/`body`，没有称号/宗门/家族字段，UI 单纯拼接会永远只显示裸名字）：
  - `client/src/net/WorldApiClient.ts` 的 `WorldChatMessage`/`FamilyMessageView` 手写接口、`server/contracts/openapi-world.yml` 的 `SectMessageView` schema（连带重新生成 `openapi-world.ts`/`openapi.ts`），均新增可选 `title?`/`sectName?`/`familyName?`。
  - **称号**：`equippedTitle` 本已存在于存档 `equipped.title`（PvP 对手/排行榜早有读取先例），但两条 profile 通路此前都没往外吐——`server/metaserver/src/{accounts.ts, social.ts}` 的 `getProfile`/`profileOf` 补读 `save.equipped.title` 并入返回值（`@nw/shared` 的 `ProfileView` 新增 `equippedTitle?`）；`worldsvc` 的 `PlayerProfile` 类型跟着补字段。
  - **宗门/家族名**：`SectService.sendMessage`（频道本身就是某个宗门内，`mem.name` 即家族名、`cols.sects.findOne` 即宗门自己的 `name`，零额外跨服务调用）与 `FamilyService.sendMessage`（`familyDoc.name` 即家族名；宗门名因需要跨 socialsvc→worldsvc 查询，暂不补，方括号缺省即不显示）在发消息时一并解析、连同 `title` 一起写入 `NationMessageDoc`/`SectMessageDoc`/`FamilyMessageDoc`（新增对应可选字段）与返回视图；`NationChannelService.sendMessage`（世界频道横跨所有宗门/家族）额外调 `socialsvc.getMember`+`getFamiliesByIds`+本地 `cols.sects.findOne` 解析任意发送者的宗门/家族名。
- **落地文件**：`client/src/render/chatRow.ts`（新增）、`client/src/scenes/{FriendsScene/worldChat.ts, FamilyScene/render.ts, SectScene/render.ts}`、`client/src/net/WorldApiClient.ts`、`server/contracts/openapi-world.yml`（连带重新生成的 `client/src/net/{openapi,openapi-world}.ts`）、`server/worldsvc/src/{db.ts, metaClient.ts, nationChannelService.ts, sectService.ts}`、`server/socialsvc/src/{db.ts, familyService.ts, gatewayClient.ts}`、`server/metaserver/src/{accounts.ts, social.ts}`、`server/shared/src/social.ts`。

**验证**：`client`/全部 `server` workspace `tsc --noEmit` 全绿。

**测试覆盖**（补充提交，非一次性验证）：
- `client/test/chatRow.test.ts`：纯逻辑单测 `chatNameLabel()` 的方括号拼接/缺省跳过规则（含空字符串按缺省处理）。
- `client/test/ui/chatRowSingleLine.ui.ts`：headless PIXI 集成测试，分别驱动 `FriendsScene`（世界频道）、`FamilyScene`（家族频道，落地为 landscape 分栏视图）、`SectScene`（宗门频道，`mode='mySect'`+`activeTab='channel'`）三个真实场景，断言名字文本与内容文本同一行（`y` 相同）、内容跟在名字之后（`x` 更大）、至少画出一个背景色块 Graphics、以及全缺省字段时不显示任何方括号。
- `server/worldsvc/test/nation-channel.e2e.test.ts` 新增 `title / sectName / familyName resolution` 一组用例：`sendMessage()`/`getChannel()` 在 meta+socialsvc 均可用时正确解析三个字段；家族未入宗门时 `sectName` 缺省；meta/socialsvc 均未配置时三者全缺省。
- `server/worldsvc/test/sect.e2e.test.ts` 新增两条用例：宗门频道零额外跨服务调用即可解出 `sectName`/`familyName`（複用已有的 `mem`/`sect` 查询），`title` 单独依赖 meta（meta 缺失时仅 `title` 缺省，`sectName`/`familyName` 仍在）。
- `server/socialsvc/test/family.e2e.test.ts` 新增三条用例（`harness.ts` 的 `FakeMeta.add()` 新增可选 `equippedTitle` 参数）：`title`+`familyName` 解析、无称号时仅 `familyName` 解析、meta 未配置时仅 `title` 缺省。
- `server/metaserver/test/internal-accounts.test.ts` 新增 `/internal/account/by-public-id` 与 `/internal/account/batch-profiles` 的 `equippedTitle` 覆盖（此前只有 `/internal/profile` 测过，这两个走的是另一个函数 `profileOf`，本次一并读 `save.equipped.title`）。

全部通过：`client` 单测 698/698、`client` UI 套件本次改动相关部分全绿（另有 2 个 `worldMapOccupyTeamPicker.ui.ts` 失败与本次改动无关，属并发会话对 `WorldMapNet.ts` 的在制修改）、`worldsvc`/`socialsvc`/`metaserver` 对应 e2e/单测全绿。

> ⚠️ 未做真机截图核对：本地 9090 端口被另一会话的 dev server 占用，且触达真实的世界频道/家族频道/宗门频道页面需要登录+加入 SLG 世界+建家族/宗门等多步前置状态，与并发会话冲突风险高于收益，故只做了上述 headless 渲染断言。后续有机会时应实机截图确认三个频道的视觉效果（尤其是名字背景色块的观感）。

## 22. CJK 文字顶部裁切修复 + 统一 `makeText` 文本工厂（2026-07-17）

**现象**：世界频道等处汉字**顶部横笔被截断**。根因：PIXI 按拉丁字形测量字体上沿（ascent），汉字比该上沿高，其顶部落在生成的文字纹理画布第 0 行之外被裁掉。等宽字体（§0 视觉基调）下汉字尤其明显，且此问题对**全场景所有文字**都潜在存在，只是聊天页信息密集最先被发现。

**方案**：新增单一权威模块 `client/src/render/pixiText.ts`，两层保护：
1. **`makeText(text, style)`** —— 规范文本工厂，替代裸 `new PIXI.Text(...)`。按字号比例加 `padding = ceil(fontSize × 0.15)`（`cjkPadding()`）。PIXI 的 `padding` 只放大**底层纹理**，`trim`/`orig` 会补偿偏移，故 `text.width/height` 与屏幕位置**完全不变**（对照 `@pixi/text` `Text.updateTexture` 源码确认）——零布局偏移，永远安全可加。调用方显式给 `padding` 时以调用方为准。
2. **`installTextPaddingFloor()`** —— `app.ts` 启动时把 PIXI 全局默认 `TextStyle.defaultStyle.padding` 抬到下限（8px）。兜底：即便某处漏迁移、或将来新写裸 `new PIXI.Text`，也不会裁切。固定下限而非比例：padding 从不影响布局，小字号上的额外纹理开销可忽略。

**接入**：`sketchUi.ts` 的 `txt()`（全项目文字统一入口）改为委托 `makeText`；`src/` 中全部 ~68 处直接 `new PIXI.Text`（26 个文件，含 `SettingsScene.ts`/`LobbyScene/base.ts` 里的本地 `txt` 工厂）迁移为 `makeText`。除 `pixiText.ts` 自身外 `src/` 零残留 `new PIXI.Text`。

**验证**：PIXI 单体页实测——`padding=0` 时汉字墨迹贴画布 y=0（被裁切），加 padding 后上方留出余白、字形完整。`grep` 零残留、`tsc --noEmit` 通过、`cjkPadding` 单测（`test/pixiText.test.ts`）+ `chatRow` 单测通过。真实运行画面（世界频道）截图核对因需完整后端+登录未做，根因已在 PIXI 单体环境直接验证。

## 23. 回放观看增强：隐投降 + 基地名 + 视角切换（2026-07-17）

面向确定性回放播放器（`ReplayScene`，S1-RP，spectator 模式的 `GameRenderer`）的五项观看体验修复。此前回放直接复用对战 HUD，出现无意义的投降按钮、看不出双方是谁、结束提示与胜负框重叠等问题。

**玩家名进回放数据**：`ReplayMeta` 新增 `players?: { bottom?; top? }`（owner 索引，0=底/1=顶）。录制侧写入——netplay 在 `nav/result.ts` `buildNetReplay` 按 `localOwner` 映射 `playerName()`/`info.opponentName`；本地赛（PvP-AI / campaign）经 `GameSceneOptions.players` → `matchEngine.createLocalMatch` 写入，`nav/game.ts` 传 `{ bottom: playerName(), top: t('replay.aiOpponent') }`。整对象随 `ReplayStore` JSON 自动 round-trip。攻城 / 服务器历史回放无名字数据 → 播放侧兜底 `t('replay.player1/2')`。

**五项**：
1. **隐藏投降按钮** —— `HUDView` 新增 `hideSurrender`；spectator 时不建按钮，`_surrenderRect` 留零（输入永不触发确认框）。
2. **基地旁玩家名** —— `GameRenderer.drawReplayNameLabels()`（spectator + `replayNames` 时调）在 `playerBaseRect`（本方=`localOwner`）/`enemyBaseRect`（对方）上方各画名牌（复用 `drawHudButton` secondary 底）。
3. **结束提示下移 + 通用背景** —— `ReplayScene` 的「回放结束」文字包 `sketchPanel`（同 `GlobalToast` 底），移到 `designHeight*0.66`（胜负框居中于 `dh/2` 之下，不再重叠）；常驻不自动消失。
4. **当前视角玩家名** —— 底部 ink 上方画 `t('replay.viewpoint', {name})`（`localOwner` 名）。
5. **点击基地切换视角（整界面镜像 + 淡入淡出）** —— `ILayout.mirrored()`（两 layout 存 `availW/availH`，返回翻转 `localSide` 的同尺寸实例）；`ReplayScene.buildRenderer(side, ffToTick)` 用**确定性快进**（新引擎 + `ReplayInputSource` 逐帧 `tick(1/30)` 追到当前帧，仅丢失中途瞬时 VFX）；基地透明热区 `pointertap` → `switchViewpoint()` 交叉淡入淡出（旧→0 / 新→1，0.35s，期间冻结），完成后销毁旧渲染器。名字/HP/手牌/基地随 `localOwner` 自动就位。

**验证**：`tsc --noEmit`（client + engine）通过；`hudSurrenderLabel` 单测加 hideSurrender 用例（5 通过）；Landscape/Portrait layout 单测通过。运行验证经临时 `?replaydemo` 单体入口（合入前已删）在真实 `ReplayScene` 上实测场景图：双基地名牌就位、视角标签、无投降文字、结束面板在胜负框下方带背景不重叠、点击基地后新渲染器完整镜像（名字/视角互换）、淡入淡出 α 曲线与 finalize（销毁旧渲染器）逐帧确认。像素截图因 Browser 面板后台 tab（rAF 暂停）+ PIXI WebGL `toDataURL` 空白未取，改以场景图内省确认。

## 24. OK/Cancel 确认弹窗统一 + 放大 1.5x（2026-07-18）

**问题**：`EquipmentScene`、`FamilyScene`、`SectScene` 各自维护一份手写复制的 `showConfirm`（例：装备分解「Salvage all 50 Paper Clip?」弹窗），三份面板尺寸不一（300×130 / 280×110 / 300×120），Cancel 按钮一处是文字一处是 ✕ 图标，OK/Cancel 文案一处走 i18n（`equip.ok/cancel`）一处硬编码英文 `'OK'`——典型的复制粘贴漂移，不是共享组件。

**修复**：新增 `render/confirmDialog.ts` 导出纯函数 `drawConfirmDialog(modalLayer, w, h, msg, onOk, onCancel)`，只画「遮罩 + 面板 + 换行消息 + OK/Cancel 两个按钮」并返回其命中矩形；三个场景的 `showConfirm` 精简为调用该函数 + 各自的 `modalOpen`/`closeModal` 收尾（Equipment 的取消会重渲染回详情弹窗，Family/Sect 只需关闭，逻辑差异保留在调用侧，不进共享函数）。顺带把 Cancel 统一成文字按钮（Family/Sect 原来的 ✕ 图标去掉），OK/Cancel 文案改用新增的 `common.ok`/`common.cancel`（zh/en/de 三语，放在既有的 `common.back`/`common.close` 旁）。

**放大 1.5x**：面板 300×130→450×195，按钮 84×28→126×42，按钮间距/底部留白/消息顶部留白同比例放大（8→12 / 16→24），字号从 `FS.tiny`（13）提到 `FS.bodyLg`（20，`snapFont(13*1.5)` 落点）。

**验证**：`tsc --noEmit` 全绿。用临时 `__NW_DEBUG` 钩子（`app.ts` 暴露 `app/PIXI/drawConfirmDialog`，验证后已移除）直接调用该纯函数离屏渲染截图核对（手绘描边面板、深色 OK / 浅色 Cancel、长文案自动换行居中），未逐一走三个场景的完整业务流程（无后端登录态），但三处调用点结构完全一致，视觉已用同一份绘制代码核对过。

---

## 25. 滚动视口 peek 钳制：保证「下面还有」的可见提示（2026-07-20）

**问题**：Shop 充值页截图里 3 个 Top Up 档位铺满整屏、底部与屏幕边缘齐平——实际上 5 个档位应有 2 行，第 2 行完全被裁没了，玩家只能靠右缘一根细 `ScrollIndicator` 滑块猜还有没有更多，容易漏掉。根因：各场景的行高/列宽是按内容自身算的，和视口高度毫无关系；一旦某一行的高度巧合地约等于可视区高度，下一行的绘制剔除条件（`cy <= h`）就直接把整行跳过，观感是「正好装满」，不是真的溢出裁切。

**修复**：新增 `client/src/ui/widgets/scrollPeek.ts`，导出纯函数 `peekViewportH(availH, unit, contentH, peekFrac = 0.28)`——当内容高度 `contentH` 超出原始可视高度 `availH` 时，把实际视口钳制到「整数行 + `peekFrac` 行」，从不停在整行边界；内容本就装得下时原样返回 `availH`，零副作用。`unit` 是网格的行距（`cellH + gap`）或列表的项距（`itemH + gap`）；masonry 布局（Skins 衣柜）没有固定行距，退化为用平均卡片高度近似。

**接入范围**：ShopScene（商城/充值）打样验证后，同一模式铺到 Equipment（背包/装配/合成）、Gacha（图鉴网格）、Titles（顺带发现该页此前**完全没有滚动机制**，超出一屏的称号彻底不可达——本次一并补上拖拽滚动 + tap-vs-drag 手势）、Card（花名册/衣柜/融合候选列表）、Family（名册/频道）、Sect（名册/频道——同样发现两处此前**没有 mask**，溢出行会真的画穿到别的区域，本次一并补上真裁切）、Auction（列表/物品选择器）、DeckBuilder、BattlePass、CityScene（军团/建筑网格）、DefenseEditorScene 共 12 个场景/文件组。各场景按自身结构接入：已有 mask 的场景（Shop/Titles）把 mask 尺寸挪到算出 peek 高度之后再定；纯剔除无 mask 的场景（多数）只替换视口高度这一个变量即可，下游的滚动钳制/剔除条件/`drawScrollIndicator` 调用早已引用该变量名，无需逐一改。

**验证**：`tsc --noEmit` 全绿（12 个场景文件组逐一 + 最终全量二次确认）。Shop 充值页在真实登录会话下截图核对：档位卡片的 Buy 按钮在视口底边被明确裁出一截（而非齐平），拖拽后第 2 行（$49.99/$99.99 档）可正常滚出；TitlesScene 新增的滚动路径也在同一会话下截图核对了非溢出场景（4 个称号一行，行为不变）。其余场景因需要特定账号状态（家族/宗门成员、拍卖行挂单等）未逐一截图，但改动模式与已验证的 Shop/Titles 完全一致，且全部通过类型检查。

**修正（2026-07-22）：peekViewportH 逻辑写反了，会过度倒缩。** 原实现无条件把视口砍到 `fullRows*unit + peekFrac*unit` 再 `min(availH)`，两个分支都错：
- 自然余量本就足够（如 Craft 合成页 4 列 9 物 3 行、`availH=886`、`unit=302`：第 3 行天然露出 93%，是完美的 peek）时，它反而倒缩到只露 28%，白白在遮罩下方永久空出约 197px——这片空白读作「到底了」，同时最后一行（Sticker）只有滚到最底才完整，玩家看到「下面明明有空位、物品却只显示一半」。
- 自然余量接近 0（真正该处理的「看起来正好装满」情形）时，`cut > availH`，`min()` 直接返回 `availH`，等于**什么都没做**。

新逻辑：只在「自然裁切接近齐平、没有可读半行露出」时才介入（`rem < peekFrac*unit` 且至少能保留一整行时，下缩到上一行边界 + `peekFrac`）；否则原样保留 `availH`。返回值恒 ≥ 旧值，原本能 peek 的仍 peek、首行仍完整。`tsc --noEmit` 全绿；`test/ui/shopScene.ui.ts`（30）、`test/ui/equipment*.ui.ts`（19）全通过。
