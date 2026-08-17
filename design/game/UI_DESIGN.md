# Notebook Wars — 客户端 UI 设计文档

> 创建：2026-06-13。本文件是元系统 / 联机相关**客户端 UI** 的设计基准（场景、组件、导航、网络态、美术资产、i18n）。
> 配套：`META_DESIGN.md`（系统/数据）、`META_TASKS.md`（任务）、`DESIGN.md`（引擎/渲染）。
> 现有场景参考：`src/scenes/LobbyScene.ts`（笔记本风格基准实现）、`SceneManager.ts`、`layout/ILayout.ts`。

---

## 分册索引

本文件 2026-08-17 从 1090 行拆分。**所有小节编号保持不变**——源码注释里的 `UI_DESIGN.md §N` 引用照旧有效，按下表找到所在分册即可。

| 内容 | 小节 | 文件 |
|---|---|---|
| 设计原则 / 通用组件 / 导航 / 返回约定 | §1–§3.1 | **本文** |
| 战斗内 UI 增量 / 网络态 / 美术清单 / 实现约定 / 开放问题 / 头像系统 | §5–§11 | **本文** |
| 菜单场景规格（Lobby/Room/Shop/Gacha/Collection/Profile/Campaign/Prep/Stats/Result） | §4.1–§4.10 | [`UI_DESIGN_SCENES.md`](UI_DESIGN_SCENES.md) |
| 变更记录 2026-06 / 2026-07 | §4.9.1、§4.11–§4.28、§12–§25 | [`UI_DESIGN_LOG_2026-06_07.md`](UI_DESIGN_LOG_2026-06_07.md) |
| 变更记录 2026-08 | §26–§34 | [`UI_DESIGN_LOG_2026-08.md`](UI_DESIGN_LOG_2026-08.md) |

> **写新内容放哪**：改的是「当前应该长什么样」→ 改本文或 `UI_DESIGN_SCENES.md` 的对应小节；记的是「某天改了什么、为什么」→ 追加到最新的 `UI_DESIGN_LOG_*.md` 末尾。两者都要动时，规格里写结论、log 里写来由并互相指一下。

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **笔记本/手绘风** | 米色纸底 + 横线 + 红色页边线 + 等宽字体（monospace）。沿用 `LobbyScene` 的 `C` 调色板，不另起视觉体系 |
| **设计空间 + Contain 缩放** | 所有坐标用设计空间；`ScalingManager` 单比例映射到真机。场景内用 `layout.designWidth/Height` 的**百分比**布局（见 `LobbyScene.build()`）。**竖屏设计高度是动态的**（2026-07 改）：宽度固定 1080，高度 = `round(1080 × 安全区高/安全区宽)`，下限 1920——即竖屏设计空间的**长宽比跟随设备安全区**，故 iPhone 13（~9:19.5）等高瘦屏用 fit-to-width 铺满、**不再上下留米色黑边**（此前固定 1080×1920 在高屏被 Contain 居中，上下各浪费 ~18%）。**横屏同理动态化**（2026-07 改）：高度固定 1080，宽度 = `round(1080 × 安全区宽/安全区高)`，下限 1920——即横屏长宽比也跟随安全区，高瘦屏横握用 fit-to-height 铺满、不再左右留黑边；棋盘水平居中，底部条左/右锚定、中间手牌区随宽度伸缩。详见 [`design/game/DESIGN.md` 渲染/布局节] 与 `layout/{PortraitLayout,LandscapeLayout}.ts` |
| **安全区（刘海/灵动岛/Home 指示条）** | `IPlatform.getSafeAreaInsets()`（Web 读 `env(safe-area-inset-*)`，需 `viewport-fit=cover`）返回 CSS px 内边距；`createLayout` 用它缩小竖屏"可绘制区"来算设计高度，`ScalingManager` 把整个 `gameLayer` 平移进安全区内——**所有场景（战斗+菜单）统一避开刘海/指示条，无需各场景单独处理**。`bgLayer` 仍 Cover 铺满整屏（含安全区外的窄带），故边缘露的是背景纸而非硬边。**冷启动竞态**（2026-07-28 修）：WebKit 在页面刚加载时首次同步读 `env(safe-area-inset-*)` 可能仍返回 0（`viewport-fit=cover` 还没生效完），导致 iPhone 13 等设备竖屏首屏顶部 HUD（金币/返回按钮）贴到 `y=0` 而非贴到刘海/状态栏下方，与系统状态栏重叠、返回按钮命中区也跟着偏移；`startApp()`（`app.ts`）在资源预加载 `await` 完成、首个场景构建前会**重新读一次**安全区，值有变化就重建 `layout` 并 `scaling.resize()`，构建首个场景时已用上稳定后的正确值 |
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

> **按钮背景统一（2026-07-15）**：全屏菜单场景（登录/大厅/设置/…）早已共享 `render/sketchUi.ts` 的 `sketchPanel()` + `ui` 调色板（§7.5：手绘描边按钮，非透明/纯白/纯黑各自为政）；本次审计发现真正的缺口在**战斗内 HUD**（`HUDView`/`ProfilePopup`/`TutorialDirector`），此前各自写死十六进制色值（`0x2c2c2a`/`0xf0ece0`/`0x3a6ea5`/`0x999999`…）。新增 `ui/widgets/hudButton.ts` 导出 `drawHudButton(g, w, h, variant)` + `hudButtonText(variant)`，5 个语义变体：`primary`（主操作，暂停恢复/关闭/升级/教程跳过）、`accent`（同权重次操作，靠色相区分，刷新手牌/教程下一步）、`secondary`（低权重操作，退出大厅/设置齿轮）、`danger`（拉黑/移除等破坏性操作）、`disabled`。颜色源自 `theme.ts` 的 `palette`，换肤只改一处。同时把两处历史遗留的场景本地 `const C = {...}`（`SettingsScene.ts`/`IntroScene.ts`，与 `sketchUi.ui` 完全重复的调色板）改为直接 `import { ui } from '../render/sketchUi'`，消除并行调色板。

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
> - **EventScene 补迁**：`EventScene` 此前完全绕开 `SceneHeader`，自绘标题（`h*0.045`）与返回文字（`h*0.032`，位置 `x=w*0.05,y=h*0.04`，私有 i18n key `event.back`），是唯一未接入共享组件的二级场景。本次改用 `drawSceneHeader(this.container, w, h, t('event.title'))`，回退按钮/标题/栏高与其余场景完全一致；`event.back` i18n key 不再使用（**2026-08-16 审计已删**，见 §33——"供未来复用"三周内没人复用，返回文案统一走 `common.back`）。
> - **未动**：Card/Equipment 的 `drawHeaderCurrency` 紧凑 scale（`100/headerH`，见上「栏高统一」条目）——两场景互为对开页且有明确的溢出规避理由，不属于本次"跨页不一致"的范畴，维持现状。

---

## 4. 菜单场景规格

→ 已拆出到 [`UI_DESIGN_SCENES.md`](UI_DESIGN_SCENES.md)（§4.1–§4.10，各菜单场景的布局/组件/交互基准）。
其历史变更记录（§4.9.1、§4.11–§4.28）在 [`UI_DESIGN_LOG_2026-06_07.md`](UI_DESIGN_LOG_2026-06_07.md)。

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

## 11. 头像系统（2026-06-28；2026-07-20 重做：新美术 + 服务端同步 + 多品类头像；2026-08-15 二次重做：胸像美术 + 品类精简）

**结论**：已实现。当前 4 个品类可选作头像——预设（20 张免费原创角色胸像）/称号/角色（6 张专属日常胸像）/皮肤，未解锁（从未拥有过）置灰 + 点击提示解锁方式，解锁判定为**终身制**（历史上拥有过一次即永久解锁，即使当前背包已无该物品）。`装备`/`材料`两个品类已于 2026-08-15 整个删除——这两类会随平衡性调整持续增删，头像跟着补图是填不完的坑（见 [`design/product/avatar-art-prompts.md`](../product/avatar-art-prompts.md) 完整改造记录）。

### avatarId 数据格式

复合字符串 `"<category>:<key>"`：`preset:<key>`（20 个原创角色 slug，如 `preset:gogetter`）/ `title:<titleId>` / `hero:<unitType>` / `skin:<skinId>`。旧的纯数字字符串（`'0'`~`'7'`，2026-07 改造前 localStorage 里已有的值，对应彼时 8 种预设图标）按 `preset:<n>` 兼容解析（`render/avatar.ts` 的 `parseAvatarId`），并**位置迁移**到新 20 键列表上（`resolvePresetArtUrl` 按 `n % 20` 取键）——存量账号仍能落到一张真实胸像，而不是退化成首字母兜底。`equip:*`/`material:*`（2026-08-15 前设过的头像）现在解析不到分类，客户端自动退化到首字母兜底；服务端另有一道读时净化（见下方「服务端同步」）。

### 预设头像美术（20 张，2026-08-15 二次重做）

不再是白线图标+染色圆盘：20 张全新原创角色**全彩胸像**（涛方简笔卡通脸画风，按情绪基调分 A~D 四组各 5 个，见 `avatar-art-prompts.md` §二），作为独立 PNG（不打包图集——数量小、且圆形裁切要求原图干净无相邻帧串色）存在 `client/src/assets/avatars/preset/preset_<key>.png`，`client/src/render/presetAvatarArt.ts`（仿 `cardArt.ts` 的 `UNIT_ART_URLS` 写法）导出 `PRESET_AVATAR_KEYS`/`PRESET_AVATAR_ART_URLS`。渲染统一走 `buildPortraitIcon()`（原来 hero/skin 已用的运行时圆形裁切），不再有专属底色——`avatar.ts` 的 `CATEGORY_BG` 里 `preset` 现在也是单一中性色（`palette.inkBlue`），与 title/hero/skin 三个分类同一套视觉处理。旧的 8 图标白线管线（`art/ui/head/pack_avatar_atlas.cjs` + `client/src/render/atlas/avatarAtlas.ts`）已整体删除；旧源图归档 `art/leftover/`。

### 角色头像美术（6 张，2026-08-15 新增）

此前"角色"分类直接裁战斗/卡面立绘（`cardArt.ts` 的 `UNIT_ART_URLS`）当头像，三套画风打架（涂鸦火柴人 vs 写实数位画）。现改为 6 张专属**日常/便装**胸像（无武器、无战斗姿态，代表"这个角色本身"，人设发型延续 `skin-art-prompts.md` 的辨识三件套），独立 PNG 存 `client/src/assets/avatars/hero/hero_<key>.png`，`client/src/render/heroAvatarArt.ts` 导出 `HERO_AVATAR_KEYS`/`HERO_AVATAR_ART_URLS`（key 沿用 `UNIT_ART_URLS` 的 unit-id 命名：`infantry`/`archer`/`shieldbearer`/`max`/`lena`/`mara`）。`avatar.ts` 的 `categoryIcon('hero', ...)` 查这张新表，不再查 `UNIT_ART_URLS`。

> **已知遗留 bug**（未在本次修复）："皮肤"分类目前仍查 `UNIT_ART_URLS[SKIN_TARGET_UNIT[key]]`（即角色的战斗立绘，跟皮肤本身的配色完全无关），因为专属皮肤胸像裁切表要等 `skin-art-prompts.md` 里还没定稿的 2 款皮肤重绘完才能做（见 `avatar-art-prompts.md` §三）。

### 服务端同步（Phase B，2026-08-15 更新）

- `save.equipped.avatar`（复用既有 `equipped: Record<string,string>` 通用装配袋，同 `equipped.title` 的写法，无需 schema 迁移）。
- `PUT /avatar/equip`（`server/metaserver/src/service/liveops/profile.ts` 的 `equipAvatarHandler`，仿照 `equipTitleHandler` 结构）：`preset:*` 恒许可；`title`/`hero`/`skin` 校验 `titles[]`/`everOwned.*`/`inventory.skins`，不满足 → 403。**`equip`/`material` 已整体从 `isAvatarOwned`（`save.ts`）的 switch 里删除，落到 `default: return false`**——无论是否曾经拥有过该装备/材料，尝试设置这两类头像一律 403（不再是"未拥有则 403、拥有则放行"，而是分类本身不再存在）。客户端自 ADR-056（2026-07-28）起直接调用此端点——`onSetAvatar` 走 `saveManager.equipAvatar(id)`（先写本地镜像即时反馈，再后台调用 `PUT /avatar/equip` 确认）。
- **存量 `equip:*`/`material:* ` avatarId 的读时净化**（`save.ts` 的 `sanitizeEquippedAvatar`，接进 `app.ts` 的 `preSerialization` 钩子——与 `equipmentInv`/`cardInv`/`skinCounts` 的读时回填同一约定）：账号历史上装配过的 `equip:*`/`material:*` 头像，字符串本身永久留在存档里；每次任意接口把 `save` 序列化回客户端时，这个钩子检测到分类不在 `preset`/`title`/`hero`/`skin` 白名单内，就把它换成 `preset:0`（位置迁移到新 20 键表的第一张）——只读不改库，幂等，不需要一次性迁移脚本。
- `ProfileView`/`FriendView`（`server/shared/src/social.ts` + `openapi/schemas.yml`）加 `avatarId?`；`profileOf()`/`getProfile()`（metaserver `social.ts`/`accounts.ts`）比照 `equippedTitle` 读取 `equipped.avatar`；`FamilyMemberView`（socialsvc `familyService.ts`）、`getFriends()`（socialsvc `friendService.ts`）同步透传。
- 对战对手信息：`opponentAvatarId` 沿 `opponentTitle` 的既有链路整条打通——`gateway/metaClient.ts` → `Gateway.ts` → `matchsvc`（`Matchmaking.ts`/`Matchsvc.ts`/`internalHttp.ts`）→ `TicketClaims`（`server/shared/src/ticket.ts`）→ `gameserver`（`RoomManager.ts`/`Room.ts`）→ `transport.proto`（`MatchStart.opponent_avatar_id = 11`）→ 客户端 `NetInputSource.ts`/`nav/result.ts`。
- 客户端展示：`ProfilePopup.ProfileData.avatarId`、`FriendsScene`/`FamilyScene` 的成员行头像。

### 终身拥有记录 everOwned（Phase C）

`SaveData.everOwned?: { hero?, equipment?, material?, skin? }`（`server/shared/src/types.ts` + 客户端镜像 `game/meta/SaveData.ts`），全部 `$addToSet` 追加、永不删除：

- 称号不需要：`titles[]` 本来就是终身记录。
- 角色：`grantCards`/`grantCard`（`cards.ts`）写入 `everOwned.hero`。
- 装备：`grantEquipment`（`equipment.ts`）+ PvE 装备掉落（`service/pve.ts`）写入 `everOwned.equipment`。
- 材料：签到/邮件/PvE 奖励/gacha 交付（`liveops.ts`/`economy.ts` 的 `deliverGrant`/`deliverMailGrant`）+ 内部经济路由（`internal/economyRoutes.ts`）写入 `everOwned.material`。
- 皮肤：`grantSkin`（`skin.ts`）+ gacha/mail 交付写入 `everOwned.skin`；`escrowSkin`（拍卖行寄售）**不**从 `everOwned.skin` 删——只有这个类别的"当前拥有"和"终身拥有"会分叉。

> **2026-08-15 更新**：`equipment`/`material` 两个子字段**没有被删除、也没有停止写入**——它们仍在为 gacha 重复检测（`economy/duplicates.ts` 等）服务，跟头像无关的另一套用途。改动只是头像相关代码（`isAvatarOwned`/`SettingsSceneCallbacks`）不再读这两个子字段。

### 选择器 UI（Phase D，2026-08-15 更新）

`client/src/scenes/SettingsScene.ts` 的 `drawAvatarPickerOverlay()`：**4** 个分类 tab（预设/称号/角色/皮肤，复用 `HubTabs.drawHubTabs`；`装备`/`材料`两个 tab 已删除）+ 可滚动网格（`ScrollTapGesture` 拖动手势 + `ScrollIndicator` 滚动条，同 `CardScene/list.ts` 的范式）。未解锁项整体降低透明度并叠加锁形图标（`buildIcon('lock', ...)`），点击弹出 2.2 秒的解锁提示 toast（场景本地状态，非全局 `showToastMessage`）。`buildAvatar()`（`render/avatar.ts`）按 category 分派图标来源：预设→`presetAvatarArt.ts`（20 张原创胸像），称号→`titleArt.ts`，角色→`heroAvatarArt.ts`（6 张专属日常胸像），皮肤→`cardArt.ts` 的 `UNIT_ART_URLS`（仍是遗留 bug，见上方「角色头像美术」小节）。四类均经 `buildPortraitIcon()`/`buildIcon()` 统一走圆形裁切。

### 上线次日修复（2026-07-20 补丁）

上线当天即发现老账号（功能上线前就已拥有角色/装备/材料的账号）角色与装备 tab 全部显示未解锁，另外角色头像立绘明显被截断（看不到头部）。三处根因 + 修复：

- **`everOwned` 未回填历史数据**：账号在功能上线前已拥有的角色/装备/材料，从未经过 `grantCard`/`grantEquipment`/`deliverGrant` 等写入点，`everOwned` 里自然是空的——不是数据丢失，是这些账号的物品从未被"记录"过。没有加服务端迁移脚本，而是让客户端解锁判定同时看"当前持有"（`save.cardInv`/`equipmentInv`/`materials`）和"终身记录"（`everOwned`）的并集——`nav/auth.ts` 新增 `ownedHeroes`/`ownedEquipment`/`ownedMaterials` 三个 prop 传给 `SettingsScene`，与已有的 `ownedSkins` 是同一模式。
- **角色解锁 key 对不上**：`everOwned.hero`/`cardInv` 按 `CARD_DEFS` 的 `id`（如 `lichuang`）记录，但 `pickerItems()` 的判定却拿去和 `unitType`（如 `infantry`）比对——两个命名空间不一致，导致 `lichuang`/`chenshou`/`suyuan` 无论如何都解锁不了（`max`/`lena`/`mara` 因为 `id === unitType` 才凑巧能过）。改成按 `d.id` 判定，`makeAvatarId` 仍用 `d.unitType`（美术查找用的 key）不变。
- **角色立绘截断**：`buildPortraitIcon`（`render/avatar.ts`）原来"铺满裁圆再放大 1.6 倍、锚点在图片纵向 42% 处"，对 max/lena/mara 这类又高又窄的全身立绘（宽高比低至 0.4）会把可视窗口顶到腰部——头完全看不到。改为单纯按宽度铺满 + 顶部对齐（`anchor.set(0.5, 0)`），因为六张立绘都是头部紧贴画布顶边的全身图，这样任何宽高比都稳定露出头部，牺牲的只是下半身（符合头像"半身/胸像"裁剪的预期）。

---

## 变更记录（§12 起）

按时间分册，见上方[分册索引](#分册索引)：
- §12–§25（2026-06/07）→ [`UI_DESIGN_LOG_2026-06_07.md`](UI_DESIGN_LOG_2026-06_07.md)
- §26–§34（2026-08）→ [`UI_DESIGN_LOG_2026-08.md`](UI_DESIGN_LOG_2026-08.md)
