# 大厅信息架构 — 变更记录（2026-07-05 起）

> 从 [`LOBBY_IA_REDESIGN.md`](LOBBY_IA_REDESIGN.md) 拆出（2026-08-17，原文件 579 行）。**小节编号沿用原文**，`LOBBY_IA_REDESIGN.md §N` 引用照旧有效。
> 本册内容：重排落地后的逐条改动：竖排导航、竖屏适配、红点、页签宽高统一等。总览与在先小节见 [`LOBBY_IA_REDESIGN.md`](LOBBY_IA_REDESIGN.md)。

---

## 8. 养成组（卡背包/装备）改左侧竖排导航（2026-07-05）

> 状态：**已实现**。范围只覆盖 `CardScene`/`EquipmentScene` 这一组；商城组 `[商城|盲盒|战令]` 等其余分组当时仍用 §7/P1.5 的水平 `drawHubTabs` 条。**2026-07-05 追加**：`ShopScene` 自身也已改为侧栏（见 §9），但 `GachaScene`/`BattlePassScene` 的分组条暂未跟进，三场景当前混用两种样式（跳转体验不一致，待后续统一）。

### 8.1 起因

真人用红笔在两屏截图上批注「布局完全错误」，来回三轮拖拽定稿 + 代码走查后，定位到两类问题：

1. **真 bug**：`EquipmentScene.renderGroupTabs()` 把 `drawHubTabs` 的宽度参数传成了 `leftW`（`marginLineX(w)`，约等于屏宽 9%），而不是 `CardScene` 那样传 `this.w`（全屏宽）。组合 tab 因此被塞进红色装订线以左那条 9% 宽的窄缝里，挤成一小块——纯粹传错变量，不是"设计成这样"。
2. **设计问题**：即便修好 bug 让组合 tab 恢复满宽，`EquipmentScene` 头部同时还有「背包/锻造」二级切换（`equip.tabInv`/`equip.tabCraft`）挤在同一条窄左列里，两条窄 tab 条叠在一起，读起来仍然乱。

### 8.2 拍板方案

把 `[卡背包|装备]` 分组 tab（原水平满宽条）和 `[背包|锻造]` 二级 tab（原头部左列横条）都改成**贴在红色装订线以内、竖直堆叠的侧栏**：

```
┌──┬──────────────────────────────┐
│卡 │                              │
│背 │        （容量条 + 卡片网格）   │  CardScene
│包 │                              │
├──┤                              │
│装 │                              │
│备 │                              │
└──┴──────────────────────────────┘

┌──┬──────────────────────────────┐
│卡 │           货币/材料+计数 →    │
│背 ├──────────────────────────────┤
│包 │  全部/武器/护具/饰品(占满宽)   │
├──┤ ─ 已装备 ──────────────────── │  EquipmentScene
│装 │  [格][格][格]                │
│备 │ ─ 背包 ──────────────────────│
├──┤  [格][格][格][格]             │
│背 │                              │
│包 │                              │
├──┤                              │
│锻 │                              │
│造 │                              │
└──┴──────────────────────────────┘
```

- 侧栏宽度 = `marginLineX(w)`（既有的红色笔记本装订线位置），**不新增留白**——内容区左边界完全没变，卡片网格/装备网格/货币栏/过滤条一律照旧从 `marginLineX(w)+CELL_GAP` 或 `marginLineX(w)` 起算。
- `[卡背包|装备]` 一级项目在上（仅分组语境注入，即 `openEquipmentBag`/`peerTab` 存在时才画）；`EquipmentScene` 独有的 `[背包|锻造]` 二级项目紧跟其后堆叠在同一侧栏里（不论是否分组语境都画，因为这是场景自身的 tab，不是跨场景导航）。
- 顶部标题栏（`SceneHeader`：返回 + 「卡背包」/「装备」标题）维持不动，侧栏只占标题栏以下的左侧区域。标题文字和侧栏一级项目文字重复（都叫「卡背包」/「装备」）这件事本轮**没有处理**，留作后续小项。
- 货币栏本轮定稿仍在右上角（不挪到左侧），过滤条撑满内容区全宽（侧栏右边界到屏幕右边）。
- 「已装备/背包」维持原样，是**列表内滚动的分区标题**，不进侧栏——曾在拖拽稿里试过挪进侧栏，用户确认不改。

### 8.3 实现记录

- **`client/src/ui/widgets/HubTabs.ts`** 新增 `sidebarItemHeight(h) = round(h*0.09)` 和 `drawSidebarTabs(container, sidebarW, y, h, tabs, onSelect)`：在给定 x=0 起、宽 `sidebarW` 的竖直列里，从 `y` 起把 `tabs` 逐个堆叠（每格 `sidebarItemHeight(h)` 高，格间距 `h*0.015`），图标居上/文字居下（沿用底部大厅 tab 的排布习惯）。返回未选中格的命中矩形 + 最后一格底部 y（供调用方在同一列继续往下堆内容）。原有 `drawHubTabs`/`hubTabsHeight`（水平满宽条）不变，继续给商城组等用。
- **`CardScene.ts`**：`groupH: number` 改名 `showSidebar: boolean`；`renderGroupTabs()` 改名 `renderSidebar()`，改调 `drawSidebarTabs`；`renderCapacityBar()`/`renderList()` 的纵向偏移去掉 `groupH` 加项（侧栏不再占垂直空间），`renderCapacityBar()` 的背景条改从 `sidebarW` 画到 `w`（避免盖住侧栏）。
- **`EquipmentScene.ts`**：`groupH: number` 改名 `showGroup: boolean`；原 `renderGroupTabs(leftW)`（那个传错宽度的 bug 现场）删除，改为 `renderSidebar()`——先画分组一级项（仅 `showGroup` 时），再紧接着画 `[背包|锻造]` 二级项（恒画）；`renderHeaderRow()` 不再画头部左列的二级 tab，只保留右列货币块+过滤条，纵向偏移同样去掉 `groupH` 加项；`renderAssign()`/`renderAssignRow()`（装备指派卡片选择器）原先按 `HUD_H+groupH` 起算、且横向占满整个 `w`，现改为横向也让出 `marginLineX(w)` 侧栏列（否则会被侧栏盖住）。
- 已用 `tsc --noEmit -p tsconfig.test.json` + `webpack --mode production --env TARGET=web` 验证通过；未跑游戏截图（按仓库约定，视觉验收留给人工）。

### 8.4 跟进：货币栏对齐头部 + `CardScene` 补显示 + 二级 tab 视觉降级（2026-07-05）

> 状态：**已实现**。真人看 `EquipmentScene` 截图后反馈三点：① 右上角货币/材料条和最上面「装备」标题栏没对齐（各画各的、看起来是两条独立的横条）、且切到 `CardScene`（卡背包）时货币条整个消失；② 金币图标要统一到一个来源；③ 左侧「背包/锻造」二级 tab 视觉上应比「卡背包/装备」一级 tab 小一号，标出层级。逐条处理：

1. **货币栏对齐**：新增 `client/src/ui/widgets/SceneHeader.ts` 的 `drawHeaderCurrency(container, w, headerH, coins, chips, capacity?)`，把金币+材料+容量算成一个整体右对齐簇，画在 headerH 范围内、垂直居中——不再自带背景条单独占一行。`EquipmentScene/base.ts` 新增 `headerOverlayLayer`（`build()` 里紧跟 `drawSceneHeader` 之后 `addChild`，确保盖在头部图案之上），`renderHeaderCurrency()` 每次 `render()` 都会画（含 `assign` 模式），`renderHeaderRow()` 只剩过滤条逻辑。`CardScene.ts` 同款接入：原来只有容量文字的 `renderCapacityBar()` 换成同一个 `renderHeaderCurrency()`，新增金币显示，容量数字并入同一簇尾部——修正了 §8.2 「货币栏本轮定稿仍在右上角」遗留的“卡背包页完全没有货币栏”缺口。
2. **金币图标**：核实后确认代码里本来就只有一处来源——`client/src/render/icons.ts` 的 `buildIcon('coin', size, color)`，`EquipmentScene`/`LobbyScene`/`GachaScene`/`BattlePassScene`/`AchievementScene` 全部调用同一个函数，没有另画一套。反馈成因是视觉观感（不同场景图标尺寸/颜色不同），不是真的存在第二套图标资源；未改代码。
3. **二级 tab 视觉降级**：`drawSidebarTabs()` 新增第 7 个可选参数 `opts?: { sub?: boolean }`——`sub: true` 时格高缩到 `sidebarItemHeight(h)*0.76`、整体从左侧内缩 `sidebarW*0.14`（`cellW`/命中矩形同步收窄），读起来是「装备」下面嵌套的二级项而非并列项。`EquipmentScene/inventory.ts` 的 `[背包|锻造]` 调用改传 `{ sub: true }`；`[卡背包|装备]` 一级组合 tab 不传，维持满宽原样。

已用 `tsc --noEmit` + `webpack --mode production` 验证通过；未跑游戏截图。

---

## 9. 商城页 `ShopScene` 分组条改左侧竖排导航 + 兑换码搬到充值 tab（2026-07-05）

> 状态：**已实现**（覆盖 `ShopScene`/`GachaScene`/`BattlePassScene` 三场景）。用户看到商城页截图后要求把 `[商店|充值|盲盒|战令]` 分组条从满宽水平条改成 §8 同款「贴红色装订线竖直堆叠」的侧栏；顺带把兑换码输入行从商店 tab 挪到充值 tab，盲盒页顶栏金币改「图标+数字」（去掉「金币：」文字），战令页顶栏补上金币显示。`ShopScene` 本轮先落地，`GachaScene`/`BattlePassScene` 自身的分组条随后（同日）跟进统一，三场景不再混用两种样式。

- **`ShopScene.ts`**：`drawGroupTabs(tbH)` 改调 `drawSidebarTabs`（侧栏宽 `marginLineX(w)`，起点 `(0, tbH)`），不再消耗垂直高度，返回值退化为 `tbH`；`gridMetrics()` 的 `listX` 从 `w*0.04` 改为 `marginLineX(w)+gap`，网格/促销行整体右移到装订线外侧。
- **兑换码行**（B-PROMO）从 `drawShopGrid`（商店 tab）搬到 `drawCoinsGrid`（充值 tab），画在充值档位网格下方，逻辑不变（`onRedeem`/`promoCode`/`hiddenInput` 都在 scene 级，不随 tab 切换重置）。
- **`GachaScene.ts`** 顶栏金币显示：`t('gacha.coins',{coins})`（"金币：{coins}" 文案）改成图标+数字（复用 `ShopScene.drawHeader` 的写法，`buildIcon('coin',...)` + `toLocaleString()`），删掉三语 `gacha.coins` 词条（已无引用）。
- **`BattlePassScene.ts`** 顶栏新增金币显示（原来没有）：`BattlePassCallbacks` 新增必填 `getCoins(): number`，`createShopNav.goBattlePass` 注入 `() => saveManager.get().wallet.coins`（离线/未登录也能读到本地钱包，不额外判空）。
- **`GachaScene.ts`/`BattlePassScene.ts` 分组条统一**（同日跟进）：两场景的 `drawGroupTabs(tbH): number` 改名 `drawSidebar(tbH): void`，改调 `drawSidebarTabs`（不再消耗垂直空间，仅在 `openShop` 注入的分组语境下画；独立入口无 `openShop` 时跳过，同 §8 的 `showSidebar`/`showGroup` 降级逻辑）。新增 `contentBounds(): { x0, w }`：有分组语境时把正文列收窄到 `marginLineX(w)+gap` 到 `w-gap`（原来居中/靠左对齐整屏 `w` 的元素——盲盒 banner、奇率/保底进度条、抽卡按钮、命运点兑换；战令 XP 条、购买战令按钮、双轨奖励网格的 `pad`/`barW`/`freeX`/`paidX`——改用这个收窄后的列），否则占满全屏（`x0=0`）。`client/test/ui/shopGroupTabs.ui.ts` 未改动——该测试按渲染出的 tab 标签文字定位命中矩形，不依赖具体几何布局，侧栏化后 8 例照样全绿。
- 已用 `tsc --noEmit` + `vitest run --config vitest.ui.config.ts`（170 例全绿，另有 13 条与本改动无关的 `.tao` 测试资产 unhandled-rejection 噪声）+ `npm run build:web` 验证通过；未跑游戏截图（按仓库约定，视觉验收留给人工）。

**`FamilyScene.ts` 补齐装订线规范**（2026-07-06 追加）：该场景此前完全没接入 `marginLineX`，Members/Family channel 两个 tab 及其内容（成员行、频道消息、发言输入框、底部 宗门/退出 按钮）全部从屏幕最左 `x=0` 起画，横跨红色装订线。改为统一从 `marginLineX(w)` 右侧起算（tab 栏、`renderMembers`、`renderChannel` 三处），底部居中按钮的中点也从 `w/2` 改成 `(marginLineX(w)+w)/2`，右侧留白/按钮位置不变。`tsc --noEmit` 验证。

---

## 10. 战役地图头部「Gear」/「Collection」双入口合并为单一「装备」入口（2026-07-09）

> 状态：**已实现**。用户看战役地图截图报了两个问题：① 头部标题白字在改成纸色底（`SceneHeader` 07.07.2026 统一为 `paper` 变体）后几乎不可读；② `CampaignMapScene` 头部同时挂了独立的「Collection」和「Gear」两个文字入口，而大厅侧「养成」组早已把 `CollectionScene`/`EquipmentScene` 用 `[收藏|装备]` peer-tab 统一成一屏可左右切换的体验（见 §8）——两条路都能到 `EquipmentScene`，framing 却不一样（一个带 peer-tab 能切回收藏，一个是裸页面直接退回战役地图），读起来不一致。

- **白字修复**：`CampaignMapScene.buildHeader()` 自画的标题/副标题颜色从 `0xffffff`/`C.light` 改成 `C.dark`/`C.mid`，与 `SceneHeader.ts` 里 `paper` 变体的标题色（`variant === 'paper' ? C.dark : 0xffffff`）保持一致——这条自画标题路径（`title=null` 场景）在 07.07.2026 的 header 纸色统一改造里被漏掉了。
- **入口合并**：删除头部单独的「Collection」文字链接，只保留一个「装备」（`campaign.equipment` 词条，原「Gear」文案，`campaign.collection` 词条随之删除——三语 zh/en/de 都已无其他引用）。`CampaignMapCallbacks.onOpenCollection()` + 可选 `onOpenEquipment?()` 合并为单一必填 `onOpenEquipment(): void`。
- **导航行为**：`app/nav/game.ts` 的 `goCampaignMap()` 里，新 `onOpenEquipment` 复用 `goCollection` 内部给「装备」launcher 用的同一条登录判定（`!state.offlineMode && !!platform.storage.getItem(TOKEN_KEY)`）：在线已登录时直接 `goEquipment(() => goCollection(goCampaignMap,'skins'), 'collection')`——落地就在 Equipment 标签页，带 `[收藏|装备]` peer-tab，点收藏能切回去；离线/未登录时降级为 `goCollection(goCampaignMap,'skins')`（皮肤衣柜本地可用，不因为装备系统需要联网就连带不可达）。
- `client/test/ui/scenes.ui.ts` 里 5 处 `CampaignMapScene` 测试夹具的 `onOpenCollection() {}` 同步改名为 `onOpenEquipment() {}`。
- **新增回归测试** `client/test/headless-nav.test.ts`：离线场景下点战役地图「装备」入口，断言落地 `collection` 屏（不是卡死在不可达的 `equipment` 屏），且 `CollectionScene` 本身也不出现「装备」peer-tab launcher（同一条 `equipLoggedIn` 门槛两处一致）。在线直达 `EquipmentScene` 的分支未覆盖——该文件头部注释写明联网流程留给 `full-link.e2e.ts`（对接真实服务端），而该 e2e 目前没有任何 collection/equipment 覆盖，超出本次修复范围。
- 已用 `tsc --noEmit` + `vitest run --config vitest.ui.config.ts -t CampaignMapScene`（8 例全绿）+ `vitest run test/headless-nav.test.ts`（5 例全绿）验证；未跑游戏截图。

**金币图标来源勘误**（2026-07-06 追加）：§8.4 第 2 条「核实后确认只有一处来源」的结论已过时——`client/src/render/atlas/coinIconAtlas.ts` 后来新增了 `buildCoinIcon()`（AI 位图图集，`coin`/`coins`/`coinStack`/`coinSack`/`coinChest` 五档，`ShopScene`/`LobbyScene`/`EquipmentScene`/`CardScene`/`FriendsScene` 均已切过去，文件头注释自称"the single source of truth"），但 `GachaScene.ts`/`BattlePassScene.ts` 顶栏金币图标当时仍直接调 `buildIcon('coin',...)`（程序绘制矢量字形），两页因此显示的是与其它页不同的图标资产。修复：两场景顶栏改调 `buildCoinIcon('coin', balIcon, C.gold)`；`BattlePassScene.ts` 奖励行的金币阶梯图标（`coinIconTier` 返回值）同步改走 `buildCoinIcon`，材料类奖励（`brush`/`lead`/`binding`/`scrap`）仍用 `buildIcon`。`tsc --noEmit` + `webpack --mode development` 验证通过；未跑游戏截图。

**金币图标架构收口，`coinIconAtlas.ts` 整体删除**（2026-08-25 追加）：上一条勘误说明"靠每个调用点自己记得挑对函数"这条路不成立——`buildIcon()` 本身对 `coin`/`coins`/`coinStack`/`coinSack`/`coinChest` 完全不知情（`icons.ts` 的 `DRAW` 表仍留着这 5 个的矢量兜底画法），谁不小心直接调 `buildIcon('coin',...)` 而不是 `buildCoinIcon(...)`，编译器不会报错，会悄悄退化回旧矢量图——历史上 `GachaScene.ts`/`BattlePassScene.ts` 正是这样踩过。这次把这 5 个 kind 直接注册进 `render/icons/tabIconRaster.ts` 的 `TAB_ICON_RASTER` 表（与页签图标同一套分发机制），`buildIcon()` 自己就能返回 AI 图，`coinIconAtlas.ts` 这层包装连同 `icons/currency.ts` 里的 5 个矢量画法（`drawCoin`/`drawCoins`/`drawCoinStack`/`drawCoinSack`/`drawCoinChest`）、`icons/primitives.ts` 的 `inkCoin` 辅助函数一并删除——从架构上锁死，不用再靠"记得调用哪个函数"这种约定。

与页签图标不同的一点：这 5 张是成品全彩 AI 图（金币/币堆/钱袋/宝箱，带明暗渲染），不是可运行时着色的单色墨线稿，所以不需要 `active`/`inactive`/`content` 三档预烤墨色区分——`TAB_ICON_RASTER` 表里这 5 个 kind 的三个 slot 都指向同一张图（`client/src/assets/shop/{coin,coins,coinStack,coinSack,coinChest}.png`，源图在 `art/ui/coins/`，`client/scripts/prepare-coin-icons.mjs` 从 5 张 AI 源图各裁出一张 128×128 透明底图，不再打包成 spritesheet）。所有原 `buildCoinIcon(...)` 调用点（`SceneHeader/currency.ts`、`LobbyScene/header.ts`、`AchievementScene.ts`、`DailyScene/panels.ts`、`EquipmentScene/core.ts`、`ShopScene/card.ts`、`render/rewardIcon.ts`）改调 `buildIcon(...)`，视觉结果不变（同一份图）。`tsc --noEmit` + `webpack --mode production` + 全量 `vitest run`（1947 例）+ `npm run test:ui`（2094 例）+ `npm run test:e2e`（网络依赖用例本就因无后端而失败，与本次改动无关）验证通过；顺带修了 3 个 `worldmap` UI 测试里"按 `c.constructor === PIXI.Container` 找资源汇总容器"的脆弱写法——商店入口按钮的 `coinSack` 图标现在也是裸 `PIXI.Container`（`buildRasterTabIcon` 的包装方式），会被同一个判断误命中，改成额外要求"容器里有 `PIXI.Text` 子节点"来排除图标格子。开发服务器里确认过编译通过、无控制台报错；当前环境screenshot 工具暂时无法渲染 Browser 面板，未能截图人工比对像素效果。

---

## 11. 横屏下 `[卡背包|装备]` 侧栏尺寸修正（2026-07-12）

> 状态：**已实现**。用户报「Develop」页（`CardScene`/`EquipmentScene`）横屏下左侧选项卡尺寸不对，并要求横竖屏分开处理、不要顾此失彼。

- **根因**：`HubTabs.ts` 的 `sidebarNavW(w)` 一直是 `w*0.2` 的纯公式，没有任何朝向分支。`ILayout.designWidth`/`designHeight` 在竖屏是 1080×1920，横屏是 1920×1080（含义互换），所以同一条公式在竖屏算出 216px 侧栏，横屏却算出 384px——几乎是竖屏的两倍宽，侧栏占屏比例明显失衡，把正文区域挤窄。`CardSceneBase`/`EquipmentSceneBase` 此前也完全没有 `landscape` 字段（`CityScene`/`AchievementScene` 早就有 `this.landscape = layout.orientation === 'landscape'`，这两个场景没跟上）。
- **修复**：`sidebarNavW` 改签名为 `(w, h, landscape)`，显式 `if/else` 分支——横屏时按 `h`（横屏下等于短边 1080）算 20%，竖屏时仍按 `w`（竖屏下同样是短边 1080）算 20%，两个分支结果都钉在「手机短边的 20%」，横屏不再借用长边算出双倍宽度；不是共享公式凑合，是两条显式分支分别落在正确的轴上。`CardSceneBase`/`EquipmentSceneBase` 补上 `this.landscape = layout.orientation === 'landscape'`，两者所有调用 `sidebarNavW` 的地方（`CardScene/list.ts`、`EquipmentScene/{base,inventory,craft,assign}.ts`，共 8 处）同步传入 `h`/`landscape`。
- **验证**：`tsc --noEmit` 通过；另在浏览器里把真实 `CardScene` 单独实例化并渲染（临时在 `app.ts` 挂 `globalThis.__NW_*` 钩子，提交前已移除），分别截图横屏（844×390）与竖屏（390×844）「Hero Roster」页——竖屏截图与用户原始反馈截图一致（未受影响，侧栏 216px 未变），横屏截图侧栏收窄到与竖屏同等比例，`[Hero Roster|Equipment]` 两格都正常成框、不再又宽又扁。
- **新增回归测试** `client/test/ui/sidebarRailOrientation.ui.ts`（`npm run test:ui`，5 例）：① `sidebarNavW` 纯函数在两种朝向下都钉在短边 20%；② 实例化真实 `CardScene`（`showSidebar` 注入），按渲染出的「Equipment」标签文字定位命中矩形（而非假设数组下标——同 `shopGroupTabs.ui.ts` 的 `findLabelPos`/命中矩形定位法），断言横竖屏下矩形宽度一致；③ 同法覆盖 `EquipmentScene` 的 `[<peer>|Equipment]` 分组栏。验证方法：临时把 `sidebarNavW` 改回旧的纯 `w*0.2` 公式重跑这份测试，4/5 例应声失败（验证测试真的在盯防这个回归，而非碰巧通过）后已还原。同时意外发现：`ILayout` 横屏下的 `designWidth` 并非恒定 1920，会按设备实际宽高比拉伸（只有 `designHeight`=1080 是钉死的短边）——这让"按短边计算"的修复思路比"按 1920 的 20% 硬编码"更正确，因为旧公式在宽高比越极端的设备上会算出比 384 更夸张的侧栏宽度。

---

## 12. 商店红点指向 Gacha 而非真正的月卡领取入口 + 分组页签返回绕经 Shop（2026-07-12）

> 状态：**已实现**。用户报「领取月卡奖励后大厅商店入口红点仍在，点进去啥都没有」；紧接着又报「Shop 分组内任意页签点返回都会先落到 Shop 页签，而不是直接回大厅」。

- **红点误指根因**：大厅商店导航图标 `onOpenShop`（`client/src/app/nav/lobby.ts`）判定红点用的是 `computeShopCardClaimable()`（月卡今日奖励是否可领，见 §? 的 `state.shopCardClaimable`），但点击后实际调用 `nav.goGacha({})` 跳转到 **GachaScene**（抽卡场景），并非真正挂着月卡领取卡片的 **ShopScene**。GachaScene 侧栏虽有一个可跳回 Shop 的「Shop」peer-tab，但该 tab 之前不携带红点——红点判定和红点落地的页面对不上，用户点进去自然看不到任何可领取内容。
- **红点修复**：`GachaSceneCallbacks` 新增可选 `getShopBadge?(): boolean`；`GachaScene.drawSidebar()` 的 Shop tab 读它决定 `badge`（`client/src/scenes/GachaScene.ts`）。`app/nav/shop.ts` 的 `goGacha()` 在 `inGroup` 时按月卡状态（`subscriptionExpiry`/`subscriptionLastClaimDay`，与 `ShopScene.monthlyCardStatus()` 同一套字段）计算并注入该回调，红点从此跟着真正能领取的地方走。
- **返回导航根因**：Shop/Coins/Gacha/BattlePass 是同一分组下的平级页签（peer tabs），不是导航栈，但 `goGacha()`/`goBattlePass()` 的物理返回按钮此前统一硬编码 `onBack() { goShop(shopBack); }` —— 不管当前在哪个 peer tab，返回都先跳回 ShopScene 的 Shop 页签，而不是分组的真正来源（大厅/关卡准备页）。且大厅入口 `nav.goGacha({})` 本身没有把来源（`shopBack`）传下去，即使返回按钮直连来源也无处可去。
- **返回修复**：`app/nav/shop.ts` 的 `goGacha`/`goBattlePass` 的 `onBack` 改为直接调用 `shopBack?.()`（缺省兜底 `goShop()`/`nav.goLobby()`），不再经过 Shop 屏幕；`app/nav/lobby.ts` 的 `onOpenShop` 改为 `nav.goGacha({ shopBack: () => goLobby() })`，把真正的来源（大厅）显式穿透进去。
- **新增回归测试**：`client/test/ui/shopGroupTabs.ui.ts` 补一条「`getShopBadge` 正确转发到 Gacha 侧栏 Shop tab」的用例（数 `PIXI.Graphics` 节点数佐证徽章确实画出来了）；新增 `client/test/shopNav-backNavigation.test.ts`（4 例，直接驱动真实 `createShopNav`，不经 PIXI/网络）覆盖：大厅直入 Gacha 后返回直连来源而非落在 Shop、从 Shop 打开 Gacha/BattlePass 后返回同样直连来源、`goBattlePass()` 单独调用时的兜底回大厅。`test/harness/HeadlessAppViews.ts` 的 `showBattlePass` 顺带补上和 `showShop`/`showGacha` 一致的回调捕获（之前直接丢弃回调，测试没法按它的返回按钮）。
- 已用 `tsc --noEmit` + `webpack --mode=production` + 相关 UI/nav 测试（新增两批共 13 例）+ 全量 `vitest run`（68 文件 546 例）验证；纯导航/数据流改动，未跑游戏截图。
- **追记（2026-07-12）：BattlePass 方向仍缺红点，DailyScene 侧栏 Tab 漏洞排查带出的连锁修复**——排查 `DailyScene` 侧栏 Tab 从未接 `HubTab.badge` 的漏洞（见 `RETENTION_DESIGN.md`）时，顺带把本条修的 `getShopBadge` 模式推广到全部同组页签，发现同样的"字段存在但没接上"缺口还有两处：`BattlePassScene` 的 Shop 页签（`GachaScene` 早已正确接线，`BattlePassScene` 从未跟进）、以及 `ShopScene`/`GachaScene` 的 BattlePass 页签（战令有等级奖励可领时同样应该红点，但两边都从没算过这个状态）。
  - 新增 `client/src/game/meta/battlepass.ts::hasBattlePassClaimable(bp)`（`achievements.ts` 同构的纯函数镜像）：判断"当前已达等级中，是否有免费档（或已购战令时的付费档）未领"。
  - `app/nav/shop.ts` 内的月卡判定原来只在 `goGacha()` 里内联实现一份，现提成 `shopCardBadgeClaimable()` 共享；新增同构的 `battlePassBadgeClaimable()`；`goShop()`/`goGacha()`/`goBattlePass()` 三处都注入 `getShopBadge`/`getBattlePassBadge`（各自只注入"别人的"红点，自己的 tab 是 `active` 不需要）。
  - `ShopSceneCallbacks`/`GachaSceneCallbacks`/`BattlePassCallbacks` 三个接口相应新增 `getBattlePassBadge?`/`getShopBadge?` 可选字段；三个场景各自的 `drawSidebar()`/`drawGroupTabs()` 把它们接到对应 `HubTab.badge`。
  - **测试**：`client/test/battlepass.test.ts`（8 例，纯函数）+ `client/test/shopNav-peerBadges.test.ts`（8 例，`createShopNav` 导航层接线，验证三个场景互相看到的红点状态一致）+ `client/test/ui/shopGroupTabs.ui.ts` 追加 3 例（真实 PIXI 渲染树里数 `Graphics` 节点佐证红点确实画出）。
  - 排查过其余同类页签（`CardScene`/`EquipmentScene` 的 Cards/Equipment、`CollectionScene` 的 Collection/Equipment 及 Cards/Skins、`AuctionScene` 各 Tab）：均无可领取/未读状态可接，非漏洞——`CollectionScene` 的 Collection/Equipment 分组条另外还在用不支持 `badge` 的水平 `drawHubTabs`（见 §7/§8），如果未来要给它加红点需要先给 `drawHubTabs` 补上绘制逻辑（`drawSidebarTabs` 早已支持，两者未同步）。

---

## 13. 统一全游戏左侧（装订线一侧）页签栏的宽度与高度（2026-07-12）

> 状态：**已实现**。用户发现不同界面左侧纵向页签栏尺寸不统一，要求分析后统一宽度与格高。

- **现状盘点**：全游戏左侧纵向页签栏当时有 4 套互不相通的实现——① `HubTabs.ts` 宽版（`sidebarNavW`=短边20%、`sidebarItemHeight`=h×9% 固定），覆盖 Cards/Equipment/Shop/Gacha/BattlePass/Auction；② Career hub（Stats/Titles/Achievements，经 `CareerTabs.ts`）调的是同一个 `drawSidebarTabs()`，但误传 `marginLineX(w)`（w×9%）当宽度——本节 §8/§11 加宽到 20% 的 `sidebarNavW` 从未migrate到这三个页面；③ `ui/widgets/socialTabRail.ts` 是完全独立手写的实现（Friends/Family/Sect 五页签），宽度也用 `marginLineX(w)`，格高按 `(可用高度-top)/5` 撑满，不是固定值；④ `DailyScene` 内联手写，宽度、格高都是另一套独立公式。
- **收敛方案**：把①的 `sidebarNavW`/`sidebarItemHeight` 定为唯一标准，②③④ 全部改接 `HubTabs.drawSidebarTabs()`：
  - Career hub 三个场景（`StatsScene.ts`/`TitlesScene.ts`/`AchievementScene.ts`）把误传的 `marginLineX(w)` 改成 `sidebarNavW(w,h,landscape)`（`TitlesScene` 之前没有 `landscape` 字段，补上），紧跟着的 `contentX`/`padX` 内容偏移同步换算，成就页二级分类 sidebar（`sub:true`）同一处改。
  - `ui/widgets/socialTabRail.ts` 的 `drawSocialTabRail()` 重写为对 `HubTabs.drawSidebarTabs()` 的薄封装：新增 `landscape` 形参，宽度改 `sidebarNavW`，格高改用其内部固定的 `sidebarItemHeight(h)`；5 个页签叠起来后不再撑满剩余高度，栏位下方留白——这是本次统一确认接受的取舍（用户选定），不做二次拉伸处理。`FriendsScene/base.ts` 原有的 `railW` getter 直接改公式；`FamilyScene`/`SectScene` 原本没有集中的 rail 宽度 getter（`render.ts` 里散落多处 `marginLineX(w)`），仿照 `FriendsScene` 各自新增 `landscape` 字段 + `railW` getter 统一替换。
  - `DailyScene.ts` 的私有手写 `drawSidebarTabs()`（两页签：签到/日常任务）删除，改成组装 `HubTab[]` 调共享的 `drawSidebarTabs()`。
  - 视觉副作用（预期内）：社交 hub 的 active 页签样式从「纸色底+右侧强调条」变成和其它 hub 一致的「深色底+强调色描边」——这是统一到位后的应有结果。
- **验证**：`tsc --noEmit` + `npm run build:web`（webpack production）通过。真人截图验证：临时在 `app.ts` 挂 `globalThis.__NW_DEBUG` 钩子暴露 `app`/场景类/`makeNewSave`（提交前已移除），在 390×844 竖屏视口下分别直接实例化 `EquipmentScene`（基线）、`AchievementScene`（Career hub + 二级分类嵌套）、`TitlesScene`、`FriendsScene`（社交 5 页签）、`DailyScene`，逐一渲染两遍后 `toDataURL` 截图核对：Career hub 三页签栏宽度与 Equipment 基线一致、二级分类正确内缩嵌套；社交 hub 五页签改为固定格高、栏位下方按预期留白、命中区域随新宽高正确更新；DailyScene 两页签栏同款对齐。未逐一截图横屏，但四个场景改动均直接复用已在 `sidebarNavW` 里验证过的横竖屏分支逻辑（见 §11），风险低。

---

## 14. 横屏下红色装订线改贴侧栏边缘 + 补齐 Shop/Gacha/BattlePass/Auction 的宽度 bug（2026-07-12）

> 状态：**已实现（仅横屏）**。用户看 §13 的截图后发现红色装订线从中间穿过页签栏，追问是否要处理；确认这不是新引入的问题——`buildPaperBackground` 的红线固定画在 `marginLineX(w)`（9% 宽度），而 §8/§11 已经把 Equipment/Cards 等页面的侧栏宽度改到 `sidebarNavW`（短边 20%），红线从此卡在侧栏中间而非边缘，§13 统一宽度后这个现象从 2 个页面扩散到了 9 个页面。用户拍板：先只修横屏（该现象在横屏下因宽高比巧合而不明显，但并非设计上的对齐——见下），竖屏是否要整体换成底部导航栏另开一条讨论记录，不在本次处理。

- **横屏"看起来没事"的真实原因（已用 `LandscapeLayout`/`PortraitLayout` 源码核实，非目测）**：`PortraitLayout.designWidth` 恒为 1080（短边钉死，不随设备拉伸），所以竖屏下 `marginLineX(1080)=97` vs `sidebarNavW(1080,...)=216`——红线永远卡在侧栏 45% 处，所有竖屏设备一致。`LandscapeLayout.designHeight` 恒为 1080（短边），但 `designWidth = max(1920, round(1080 * availW/availH))` 随设备宽高比拉伸：手机类横屏宽高比越极端（如 iPhone 类 ~2.16:1），`designWidth` 越大，`marginLineX(w)` 跟着变大，恰好逼近 `sidebarNavW` 的 216——两者只差几个单位，视觉上贴边；换成标准 16:9 设备（`designWidth` 钉在 1920），`marginLineX=173`，红线仍会卡在侧栏 80% 处，只是不如竖屏的 45% 夸张。即：横屏"没问题"是这台设备宽高比的巧合，不是两条公式设计上对齐。
- **顺带发现的另一个宽度 bug**：核实 Shop/Gacha/BattlePass/Auction（`ShopScene/base.ts`、`GachaScene.ts`、`BattlePassScene.ts`、`AuctionScene/{list,picker}.ts`）时发现它们从未接入 §8/§11 的 `sidebarNavW`——`drawGroupTabs`/`drawSidebar`/`renderSidebar`/`renderPickerSidebar` 全部还在用 `marginLineX(w)`（9% 宽度），比 Equipment/Cards 等页面明显更窄，是同一个"忘记同步宽度"的 bug，只是分布在 §13 覆盖范围之外的另一批页面。这次一并修：4+2 处调用改 `sidebarNavW(w,h,landscape)`（`ShopScene`/`GachaScene`/`BattlePassScene`/`AuctionSceneBase` 原本都没有 `landscape` 字段，补上），依赖侧栏宽度的内容偏移（`ShopScene.gridMetrics()`、`GachaScene`/`BattlePassScene` 的 `contentBounds()`）同步换算。
- **红线修复**：`render/sketchUi.ts` 的 `buildPaperBackground()` 新增可选 `railX?: number`，传入时覆盖默认的 `marginLineX(w)` 作为红线 x 坐标（`bake()` 缓存 key 带上 `railX` 避免不同取值串用同一张烘焙纹理）。全部 13 个带侧栏的场景（Cards/Equipment/Shop/Gacha/BattlePass/Auction/Stats/Titles/Achievements/Friends/Family/Sect/Daily）的背景绘制处，按 `landscape ? sidebarNavW(w,h,true) : undefined` 传入——**只在横屏生效**，竖屏保持旧的 `marginLineX` 位置不变（等待 §「竖屏是否改底部导航」的讨论结果，避免现在改了将来又要跟着重做）。侧栏并非恒定显示的场景（Career hub 的 `hasSidebar`、`CardScene` 的 `showSidebar`）额外判断是否真的画了侧栏，没画侧栏时红线维持默认位置。
- **验证**：`tsc --noEmit` + `npm run build:web` 通过。真人截图（临时 `__NW_DEBUG` 钩子，验证后移除）：竖屏 390×844 下 `EquipmentScene` 与 §13 截图一致（红线仍穿过侧栏中间，未受影响）；横屏 844×390（`LandscapeLayout` 实际公式换算 `designWidth`，按 `availH/designHeight` 缩放渲染）下 `EquipmentScene`/`ShopScene` 的红线均贴到侧栏右边缘，`ShopScene` 侧栏宽度也从窄变宽、与 Equipment 对齐。

### 待讨论：竖屏是否该把左侧页签栏换成底部导航

用户提出：竖屏下侧栏绝对宽度局促（`design/game/portrait-issues` 一类记录已提过 Equipment 侧栏标签裁切风险），横屏因为空间富余暂时没这个问题；是否该在竖屏下把红色装订线画到底部、页签也挪到屏幕底部，而不是继续用左侧竖直侧栏？这涉及 Cards/Equipment/Shop/Gacha/BattlePass/Auction/Stats/Titles/Achievements/Friends/Family/Sect/Daily 十几个屏幕的布局范式，比本节的尺寸/红线修正大得多，**尚未实现，需要单独立项讨论**，本次只记录问题不动代码。

---

## 15. 废弃 `CollectionScene`，图鉴/皮肤/背景故事并入养成组（角色卡）（2026-07-13）

> 状态：**设计中**（先文档后实现，见 ADR-038）。用户看 `CollectionScene`（Cards/Skins 两 tab 的纯图鉴+衣柜页）截图后质疑「这个页面还有存在的必要吗，是否和 Develop 页面功能重复」。调研结论：**不重复但确实自成一套**——`CollectionScene` 是纯只读展示（图鉴全集 + 全局单槏位皮肤切换），真正的养成（升级/合成）在 `CardScene`（Hero Roster，§8 起已并入「养成」组 `[卡背包|装备]` 侧栏），二者视觉/布局风格不统一，容易读成"两个功能重复的页面"。用户拍板：整页废弃，功能拆解揈并进养成组。

### 15.1 拍板方案

1. **`CollectionScene` 整页删除**，不保留独立入口。原「养成」组侧栏 `[卡背包|装备]` 维持两格不变，功能改为分布进这两个已有场景：
2. **图鉴全集 → `CareerScene`（生涯组）新增第 4 个侧栏页签**：`[生涯统计|称号|成就|图鉴]`（复用 §7 `CareerTabs.ts`）。展示全部 `CARD_DEFINITIONS`（含未拥有），**未拥有的卡改为灰显+锁图标占位**（`CollectionScene` 原版没有区分已获得/未获得，此次顺带补上，语义更像正经图鉴而非纯 wishlist）。选择放生涯组而非养成组：图鉴是"目标/收集进度"性质，与成就/称号同类，养成组留给"操作我已有的东西"。
3. **背景故事（lore）→ 并入 `CardScene` 角色卡详情弹窗**：点击卡图播放翻转动画，背面展示 lore 文案（原 `CollectionScene` 的 `descKey` 简介），再点一下翻回卡图正面。`detail.ts` 现有的 `desc` 字段语义是"技能效果说明"（`skillGrowth` 驱动），**与 lore 是两个不同字段**，需新开一个展示位（卡背），不能复用现有槏位。
4. **皮肤衣柜 → `CardScene`（养成组）新增第 3 个侧栏页签「皮肤」**：`[卡背包|装备|皮肤]`，展示玩家拥有的全部皮肤及当前装备情况（数据源仍是 `inventory.skins`）。
5. **皮肤装备关系改为逐卡独立（架构变更，非纯 UI 重排）**：现状 `SaveData.equipped: Record<slot, skinId>` 是**账号级单一全局槏位**（`EQUIP_SLOT` 常量，见 `app/equipSlot.ts`），不区分是哪张角色卡。改为**每张角色卡各自的皮肤槏位**——角色卡详情弹窗若该卡有可替换皮肤，显示「更换皮肤」按钮，点击弹出可穿戴皮肤列表，确认后**该卡的卡图**改用皮肤形象展示（而不是影响一个与卡无关的全局展示位）。
   - 存档结构：`equipped` 从 `Record<slot, skinId>` 改为按角色卡 id 索引（如 `Record<cardDefId, skinId>`），服务端装备校验接口同步跟进。
   - 皮肤的**拥有关系不变**（仍是账号级库存 `inventory.skins`，购买/抽卡获取渠道不变，见 `ECONOMY_NUMBERS.md` §7），只有"装备到哪"这层关系从单槏位变成逐卡。
6. **翻转动画为新组件**：项目基于 pixi.js-legacy，全仓搜索确认没有现成的 3D 透视翻转（`rotationY`）可复用（现有 "flip" 命中都是别的语义：`StickmanRuntime` 左右镜像、`CampaignMapScene` 横向 slide 翻页过渡），需要新写一个卡牌翻转动画组件。
7. **离线兜底改为读缓存**：`CollectionScene` 原来承担"离线时的兜底展示页"角色（§6 决策 6：离线整 tab 灰显，但养成组读本地档正常可用）。废弃后，`CardScene`/`AchievementScene`(图鉴 tab) 离线时直接读本地缓存的 `save` 数据展示（不能操作，仅浏览）；首次登录、本地无缓存的新玩家展示空态，视为正常（无需特殊兜底文案）。

### 15.2 影响范围（实现前盘点，供拉 worktree 时核对）

- **删除**：`client/src/scenes/CollectionScene.ts` 及其测试/导航接线（`app/nav/*` 里的 `goCollection`/`onOpenCollection` 相关分支，含 §10 记录的战役地图头部「装备」入口降级路径——离线态原先降级到 `goCollection`，需要改指向新的养成组落地页）。
- **`CardScene`**：新增「皮肤」侧栏页签；详情弹窗（`detail.ts`）新增翻转动画 + lore 展示位 + 「更换皮肤」按钮。
- **`CareerTabs.ts` / `CareerScene` 三件套**（`StatsScene`/`TitlesScene`/`AchievementScene`）：`CareerTabKey` 联合类型新增 `'collection'`，`drawCareerTabs()` 数组与点击分支从 3 格扩到 4 格，三个场景的 callbacks 接口各自补 `onOpenCollection?()`；`app/nav/game.ts` 导航接线同步。
- **存档结构**：`SaveData.equipped` 单槏位 → 逐卡映射（需要写档迁移逻辑，老存档的全局皮肤在迁移时落到哪张卡上需要定一个默认规则，未在本次拍板范围内，实现时另拍）。
- **`design/game/CHARACTER_CARDS_DESIGN.md`**：需补一节角色卡皮肤/lore 字段的机制描述（现状该文档未提及皮肤，是空缺）。
- **`design/game/ECONOMY_NUMBERS.md` §7**：皮肤获取矩阵（拥有关系/定价）不变，不需要改数字，但装备关系的机制描述如果该文档有提及需要同步措辞。

（实现记录留待落地后补充，本节先定方向。）

## 16. 图鉴 tile 重构（整高卡图 + 独立信息面板 + 点击翻转看故事）与生涯组页签顺序修正（2026-07-14）

> 状态：**已实现**。承 §15 图鉴落地后的首轮打磨。用户看图鉴（Collection）截图报了两点：① 成就页的二级分类页签视觉上跑到了「图鉴」格下面，读起来像归属图鉴；② 卡牌 tile 想要更像"卡牌"——卡图占满整高、信息独立成块、点击翻面看背景故事。

- **生涯组页签顺序改为 `[生涯统计|称号|图鉴|成就]`**（成就挪到末位）。根因：`AchievementScene` 的二级分类 sidebar（pve/pvp/collection/progression，`sub:true`）紧跟 Career strip 下方绘制；成就原为第 3 格、图鉴第 4 格（最底），这些二级分类因此出现在「图鉴」格正下方，视觉上像归属图鉴而非成就。把成就移到 strip 末位后，其二级分类正确嵌套其下。改动集中在 `CareerTabs.ts`（`tabs` 数组与点击分支同步调序）；跨场景导航按**命名回调**分发而非数组下标，`careerNav-backNavigation`/`headless-nav` 回归测试不受影响。
- **图鉴 tile 重构**（`CardCodexScene.drawCardTile`）：卡图占满整卡高度居左；名称 / 类型·费用 / 属性 chips 移入右侧**独立绘制**的信息面板（`sketchPanel` + 自带 `sketchAccentBar` 强调条，按卡类型着色）。未拥有卡灰显 + 卡图上锁图标；暂无插画的卡（PvP 池 runner/ironclad/berserker/… 及部分建筑/法术）显示淡化首字母占位，避免空框读成坏图。tile 高度从 `h*0.155` 提到 `h*0.19` 给整高卡图 + 属性行留出空间。
- **点击翻转看故事**：点未解锁卡的卡图播放 squash-flip（`scaleX 1→0→1`，260ms，中点换面），把卡图就地替换为该卡故事文案，再点翻回。故事文案取舍：有 `*.lore` 词条的（Anna 三英雄 max/lena/mara）取 lore，否则回退到 `descKey` 简介（`t()` 缺键返回键名本身，据此判断词条是否存在）。复用 `CardScene/detail.ts` `flipDetailPortrait` 同款 `PIXI.Ticker.shared` 驱动；per-tile 翻转态存于 `flipped: Set<nameKey>`，跨（异步卡图加载 / resize 触发的）整屏 re-render 保持；`render()` 起始 `cancelAllFlips()` 取消在途 tick，避免它继续改已 detach 的容器。
  - 注：§15 决策 3 原计划把 lore 翻转放进 `CardScene` 角色卡详情弹窗（已实现，见 `cardDetailFlipAndSkin.ui.ts`）；本次按用户要求在图鉴 tile 内也做了**等价的就地翻转**，两处独立并存，故事文案就地展示在原卡图位置。
- **测试**：新增 `client/test/ui/cardCodexFlip.ui.ts`（2 例，`npm run test:ui`）——泵真实 `PIXI.Ticker.shared` 断言翻转前无故事文案、过中点后出现、settle 后保持、再点翻回消失；并断言锁定卡不注册翻转命中。翻转命中无独立标签，按目标卡所在行的正方形（`w===h`，即卡图框）命中矩形定位（同 `cardDetailFlipAndSkin.ui.ts` 的按尺寸/`findLabelPos` 定位法）。既有 `cardCodexScene.ui.ts`（锁定计数 + 属性 chips）保持绿。
- **验证**：`tsc --noEmit -p tsconfig.test.json` 仅报一处**无关的既有未跟踪 WIP** 测试（`baseUpgradeEvent.test.ts` 的 `GameMode "skirmish"`），本次两文件干净；`npm run test:ui` 全绿（32 文件 / 317 例）。未做真人截图——该游戏为 WebGL/PIXI canvas 且本地无后端（`/bootstrap` 网络失败），in-app 浏览器无法抓取 canvas 画面，改以本仓既有 headless 场景图测试作为验证路径（同 §12/§13 的约定）。
- **涉及文件**：`client/src/ui/widgets/CareerTabs.ts`、`client/src/scenes/CardCodexScene.ts`、`client/test/ui/cardCodexFlip.ui.ts`（新增）。

## 17. 商城消耗品卡排到皮肤之前（2026-07-17）

> 状态：**已实现**。用户看商城截图报：「Enhance Protection Stone（护佑石，消耗品）」排在两张皮肤（Su Yuan / Chen Shou Skin）之后，希望把石头排到皮肤前面。

- 根因：`ShopMixin.buildShopCards()`（`client/src/scenes/ShopScene/shop.ts`）原来在同一个循环里按 `this.items` 的**原始数组顺序**遍历，`kind==='item'` 的消耗品与皮肤混在一起，后端返回皮肤在前时石头就落到最后。
- 修复：拆成两遍——先遍历所有 `kind==='item'` 的消耗品（护佑石）压卡，再遍历皮肤压卡。这样无论 `this.items` 内部顺序如何，消耗品恒排在皮肤之前。卡片渲染几何（`drawShopGrid` 的网格分页）不变。
- **测试**：`client/test/ui/shopScene.ui.ts` 新增 1 例——故意把皮肤放在 `loadItems` 数组前面、石头在后，断言石头在渲染树里按行主序位于皮肤之前（更靠上，或同行更靠左）。既有 23 例（含消耗品命名/永远可买）保持绿。
- **验证**：`tsc --noEmit` 干净；`test/ui/shopScene.ui.ts` 全绿（23 例）。纯排序逻辑，headless 场景图测试直接断言坐标顺序，未另开 dev server。
- **涉及文件**：`client/src/scenes/ShopScene/shop.ts`、`client/test/ui/shopScene.ui.ts`。

## 18. 大厅顶栏/底栏与 START MATCH 按钮的黑色分层（2026-07-26）

> 状态：**已实现**。用户看大厅首页截图后问：顶栏、START MATCH 主按钮、底部导航三处全用同一纯黑 `C.dark`（`0x2c2c2a`），会不会让玩家审美疲劳？

- **诊断**：三块黑色视觉权重完全相同，`START MATCH`（本该是最高优先级的 CTA）反而被两侧同色的顶栏/底栏衬得像普通 chrome，层级被磨平。
- **第一版尝试（金色 CTA，已否）**：把 `drawBtn`（`client/src/scenes/LobbyScene/base.ts`）的启用态填充从 `C.dark` 换成 `C.gold`，配深色文字。真人截图反馈：大面积纯金色**太晃眼**，且原本"藏在按钮里的跳舞小人剪影"（`heroFigure`，黑色 22% 透明度，专为深色底设计）在浅色底上直接被"吃掉"，看不见了。已回滚。
- **拍板方案（顶栏/底栏改色，CTA 保持纯黑）**：反过来做——`START MATCH` 按钮保留 `C.dark` 填充 + 原有蓝色描边（找回小人剪影），顶栏和底部导航改用新色 `C.cover`（`0x3a352f`，比 `C.dark` 暖一丝、亮一丝的深棕灰，定义于 `base.ts` 的 `C` 调色板）。差值刻意选得小：肉眼能分辨"这两条是外框、中间是按钮"，但不会像金色那样跳出来抢戏。真人截图确认效果满意，未再调整。
- **涉及文件**：`client/src/scenes/LobbyScene/base.ts`（`C.cover` 常量）、`client/src/scenes/LobbyScene/build.ts`（顶栏 `titleBg`、底栏 `navBg` 两处填充色改用 `C.cover`）。
- **验证**：`tsc --noEmit` 干净；真人在本地 dev server（`localhost:9090`）截图确认两版效果（金色版 → 否决；`cover` 版 → 通过）。未新增自动化测试（纯配色调整，无行为变化）。

## 19. 大厅 4 个红点请求合并为单次 `GET /lobby/badges`（2026-07-27/28，comm-audit-2026-07-27 P1-4）

> 状态：**已实现**。承 2026-07-27 前后端通信全审计（详见 `SLG_DESIGN_LOG.md` §42 开头说明），本条是 P1 优先级的第 4 项，纯网络层改动，不涉及视觉。

**背景**：`goLobby()`（`client/src/app/nav/lobby.ts`）每次在线进大厅（非 resize 重绘）都会并发发出 4 个独立请求刷新红点：`getSocialBadges`（社交总红点，本身已经是 socialsvc 内部聚合好友请求/未读会话/未读邮件的产物）、`getAchievements`（算「是否有可领成就」+ 顺带做已达成 tier 差分弹 toast）、`getRetention`（算签到/日常任务是否可领 + 顺带排 iOS 本地提醒）、`getEvents`（算「是否有进行中活动」，实际只用了 `length>0`）。

**方案**：metaserver 新增聚合端点 `GET /lobby/badges`（`server/metaserver/src/service/liveops.ts` 的 `getLobbyBadges`，挂在 `LiveOpsMixin`，此前已持有 achievements/retention/events 的读取逻辑）：内部用 `Promise.all` 并发——本地读一次 `save`（achievements/retention 复用同一份，省一次 `getOrCreateSave`）、`getEventsForAccount`、以及（若 socialsvc 已配置）代理一次 `/social/badges`；socialsvc 未配置或非 200 时 `social` 降级为全零对象而不是整个响应失败，对齐旧客户端每个红点各自 try/catch 的"尽力而为"语义。响应体：`{ social, achievements:{defs,stats,achievements}, retentionClaimable:{checkin,daily}, eventsAvailable }`——`achievements` 特意保留完整 `defs`/`stats`/`achievements`（而非只给一个布尔）因为客户端的 tier 差分 toast 逻辑需要完整数据；`retentionClaimable`/`eventsAvailable` 则只给红点真正消费的布尔，不搬未用到的日历/任务/广告详情。客户端 `refreshLobbyBadges()`（原 `refreshAchievementBadge`/`refreshRetentionBadge`/`refreshEventsAvailable` 三个函数合并，`refreshSocialBadge` 保留独立——它还服务于好友请求/聊天/邮件的实时推送刷新，不适合并进"进大厅一次性聚合"这条路径）原样保留成就 tier 差分 toast、每日提醒排程两处业务逻辑，只是把数据源从 4 次网络请求换成 1 次聚合响应里的字段。

**契约**：`server/contracts/openapi/paths/liveops.yml` 新增 `/lobby/badges`（复用既有 `SocialBadges`/`Achievement` schema）；`bundle-openapi.mjs`/`gen-openapi-server.mjs` 重生成（metaserver 走 fastify-openapi-glue 自动路由，无需手写分派，与 worldsvc 手写路由不同）。

**测试**：`server/metaserver/test/lobby-badges.e2e.test.ts`（新增，3 例，真实 Mongo + fastify `app.inject`）——覆盖 socialsvc 未配置（全零降级）、socialsvc 正常代理（数值透传）、socialsvc 配置但返回非 200（同样降级为全零而非整体失败）三种场景，且逐字段断言 `achievements.defs`/`stats`/`achievements` 未被 fastify-openapi-glue 按 schema 序列化时静默裁掉（P0 审计里 B2/B3 那批"契约漏声明字段被吞"bug 的同类回归防护）。

**验证**：`server/metaserver`、`client`（`tsc --noEmit`）全绿；`server/metaserver` 全量 vitest 56 文件/697 例全绿；`client` 单元 112/794 + UI 92/807 全绿；contract codegen check 无漂移；`client` 生产 webpack 构建成功。未做真人截图走查——本次红点数值/toast/提醒逻辑完全复用旧代码路径未改变，只换了数据来源，真正的行为验证靠 e2e 断言具体字段值而非肉眼看红点是否显示，比截图更精确；且本机当时无法起完整后端栈（同 `SLG_DESIGN_LOG.md` §42 verification 一节的说明）。
- **涉及文件**：`server/contracts/openapi/paths/liveops.yml`、`server/metaserver/src/service/liveops.ts`、`server/metaserver/test/lobby-badges.e2e.test.ts`（新增）、`client/src/net/ApiClient/{misc,types}.ts`、`client/src/net/ApiClient.ts`、`client/src/app/nav/lobby.ts`。

## 20. 竖屏左侧页签栏改底部导航栏（2026-07-30，承 §14 的「待讨论」）

> 状态：**已实现**。承 §14 末尾「待讨论：竖屏是否该把左侧页签栏换成底部导航」——用户当时提出竖屏下侧栏绝对宽度局促（短边就是整个屏幕宽度），但那次范围太大（涉及十几个屏幕的布局范式），先记录问题不动代码。这次拍板执行：竖屏改底部导航栏，横屏左侧栏保持不变。实现前重新核实范围：`sidebarNavW` 实际被 24 个文件引用（比 §14 提到的"十几个"略多，另含 `CardCodexScene`、`RechargeScene`、`socialTabRail.ts`、`sketchUi.ts` 等），工作量与本文档其它大节相当，独立一次会话完成。

### 20.1 新增共享组件（`client/src/ui/widgets/HubTabs.ts`）

- `bottomNavH(h)`：竖屏底部栏高度，直接复用 `sidebarItemHeight(h)` 的量级（同一套字号/图标缩放比例已经调好，不单独发明新常数）。
- `drawBottomNavTabs(container, w, y, barH, tabs, onSelect, opts?)`：横向铺满 `w` 的页签行，视觉延续 notebook 素描面板风格（`sketchPanel` 每格一个面板+手绘描边），单元格内部排版（图标在上/文字在下/右上角红点）直接照抄 `drawSidebarTabs` 的做法，只是从纵向堆叠改成横向等分——刻意不做 `sub`/嵌套/`.bottom` 链式返回：竖屏每屏只有唯一一条底部栏，原来靠左侧栈叠两层 `drawSidebarTabs` 的场景（见 20.3）改成"顶层页签走底部栏、二级页签挪到 header 下横条"。
- `drawHubTabs`（原有的 header 下横条组件）补上 `HubTab.badge` 红点绘制——之前只有 `drawSidebarTabs` 支持画红点（§7/§8 遗留的不同步），这次挪二级页签过去要用到。

### 20.2 转换范式

每个场景的竖屏分支做的是同一件事：
- 内容区不再 `w - sidebarNavW(...)`（横屏），竖屏直接用满宽 `w`（或原有的 flat-margin 兜底逻辑）。
- 竖屏可用高度改成 `h - bottomNavH(h)`（仅当该场景确实画了底部栏时才减）。
- 原本 `drawSidebarTabs(...)` 画页签的地方，竖屏分支改调 `drawBottomNavTabs(..., y = h - bottomNavH(h), w, ...)`。
- 装饰性红色装订线（§14 的 `railX`）本来就已经是横屏专属（`landscape ? sidebarNavW(...) : undefined`），竖屏从来没画过这条线，这次不用动。

### 20.3 各类场景的处理

- **单页签组场景**（`DailyScene`、`CardScene`、`ShopScene`、`EquipmentScene`/craft·assign、Family/Friends/Sect 三个社交场景）：直接套用上面的范式。Family/Friends/Sect 的 `railW` getter 改成竖屏返回 0，`socialTabRail.ts`（Friends/Family/Sect 共用的 5 页签绘制入口）内部按 `landscape` 分流到 `drawSidebarTabs`/`drawBottomNavTabs`。
- **受业务上下文门控**（`GachaScene`/`BattlePassScene`/`RechargeScene`，页签是否出现取决于 `cb.openShop` 而非朝向）：是否减 `bottomNavH` 挂在原有 `cb.openShop` 判断上；这三个场景的页签内容不是被遮罩裁剪的（无 mask，纯 draw-cull），竖屏下把底部栏的绘制挪到 body 内容画完之后（否则底部栏可能被超长内容盖住），同时把底部栏对应的 hit rect 用 `unshift`（而非 `push`）插到 `hits` 数组最前——保证"视觉上盖在最上层"和"命中测试优先命中"两件事一致，避免万一发生的矩形重叠时点到底部栏却触发了下面盖住的内容。
- **嵌套二级页签**（`AchievementScene` 的成就分类子页签、`EquipmentScene/inventory.ts` 的 Cards/Equipment 顶层 peer + Inventory/Craft 子页签 + `trailingPeers`）：顶层 peer 页签（含 `trailingPeers`）合并成一条底部栏；二级子页签挪到 header 下方，改用刚补完红点支持的 `drawHubTabs` 横条。`EquipmentScene` 新增 `hasGroupNav` getter 判断顶层 peer 栏是否真的会画（无 peerTab 且无 trailingPeers 时不画，也就不占竖屏高度）。
- **`hasSidebar` 兜底 margin + 滚动区高度**（`CardCodexScene`/`TitlesScene`/`StatsScene`）：竖屏"有侧栏"分支不再减宽度、改减高度；三者各自的滚动/裁剪区域（`h - contentTop` 之类）同步减去 `bottomNavH(h)`，否则底部栏会盖住/裁切最后一行内容。
- **`AuctionScene`**：`list.ts`/`picker.ts` 的 `renderSidebar()`/`renderPickerSidebar()` 竖屏下返回 `0`（不占宽度）；`list.ts` 的 "+ List Item" 创建按钮原来钉死在 `h - btnH - 12`（屏幕最底部），刚好是新底部栏的位置，竖屏下上移 `bottomNavH(h)`，连带 `renderList` 的可用高度一起收窄。

### 20.4 已有测试的连带更新

跑现有 UI 测试套件发现 4 个文件、6 个用例专门钉死了"竖屏 = 左侧栏"这个即将废弃的旧行为（`sidebarRailOrientation.ui.ts`、`equipmentHeaderAlignment.ui.ts`、`equipmentSkinsPeer.ui.ts`、`shopScene.ui.ts`）——按新的竖屏布局改写断言（底部栏的 y 应接近屏幕底部、cell 宽度应明显大于旧侧栏宽度、Equipment/Skins 应与 peerTab 同处一行等），横屏相关断言未改动。

### 20.5 验证

- `tsc --noEmit` 逐批次全绿；`npm run build:web` 生产构建成功（仅预置的资源体积告警，与本次无关）。
- `npm run test:ui` 全量跑过：修好的 6 个用例转绿；其余约 50 个测试文件失败均为本 worktree 未 `npm install` 过 `server/`（`server/node_modules` 不存在）导致的 `Failed to load url jsonwebtoken` 环境问题，与本次改动无关（`git stash` 前同样会失败，只是本次任务未去装 `server/` 依赖来验证这一点，而是核实了失败原因与改动内容无关联）。
- **未做真人截图走查**：本地 Browser 预览面板在验证阶段未显示（工具报 "pane not displayed"），已用脚本确认 dev server 正常挂载、竖屏视口渲染（375×812 canvas 存在），但无法截图核对像素级效果；用户知情后选择跳过截图、仅凭代码审查 + 类型检查 + 全量 UI 测试收尾。如后续发现竖屏视觉细节问题（尤其是 §20.3 提到的"无 mask 场景内容是否会跟底部栏抢位置"这类需要肉眼判断的边界情况），按本节记录的文件列表定位。

## 21. 竖屏首页内容区宽度 82%→90%（2026-08-09）

> 状态：**已实现**。用户反馈竖屏大厅（`LobbyScene`）整体内容没铺满页面，要求竖屏下占页面宽度 90%；横屏不受影响。

**问题**：`build.ts` 的 `fullContentW = Math.round(w * 0.82)`（见本文档第 212 行「contentW 收窄」一节）竖横屏共用同一条 82% 宽度公式。竖屏设计宽度固定 1080（`PortraitLayout.DESIGN_W`），本身就是整屏宽度；横屏设计宽度通常远大于 1080。同样 18% 的留白比例，横屏因为绝对宽度大，两侧留白只是常规边距，竖屏则显得内容"缩在中间没铺满"。

**方案**：`fullContentW = Math.round(w * (this.portrait ? 0.90 : 0.82))`——竖屏放宽到 90%，横屏保持原来的 82% 不变。`this.portrait` 是 `LobbySceneBase` 已有字段（`layout.orientation === 'portrait'`），不需要新增状态。hero「START MATCH」按钮（`btnRect`）、Campaign/World 两个 pillar、右侧 Daily/Mail/Feedback/Auction 竖条全部共用这个收窄后的宽度，所以竖屏下整条内容列一起变宽，横屏公式路径完全没碰。

**测试**：`client/test/ui/scenes.ui.ts` 新增 `describe('LobbyScene — content column width follows orientation')`，portrait/landscape 各一条 `it`：不接 `onOpenDaily`（不生成侧竖条，`contentW === fullContentW`，不必处理侧栏扣减），直接构造真实 `LobbyScene` 读取 `btnRect.w`，断言等于 `Math.round(layout.designWidth * frac)`（portrait 0.90 / landscape 0.82）。

**验证**：`tsc --noEmit` 全绿；`npm run test:ui -t "LobbyScene"` 15/15 通过（含新增 2 例）。**未做真人截图走查**：本次会话 Browser 预览面板同样未显示（"pane not displayed"），额外尝试过 canvas 像素读取（`drawImage`+`getImageData`）也拿不到真实像素——WebGL 默认不 `preserveDrawingBuffer`，非合成状态下读到的是清空后的纯黑缓冲区，并非真实渲染结果。用户知情后选择跳过截图，仅凭比例数值改动的低风险 + 类型检查 + UI 测试收尾。
- **涉及文件**：`client/src/scenes/LobbyScene/build.ts`（`fullContentW` 一行）、`client/test/ui/scenes.ui.ts`（新增 describe 块）。
- **涉及文件**（24 个原引用 `sidebarNavW` 的文件 + 4 个测试文件，逐一见 §20.1–20.4）。

## 22. GachaScene 竖屏内容区补齐 90%，底部页签栏加可见背景（2026-08-09）

> 状态：**已实现**。用户看着 Gacha 页面截图反馈"竖屏占满宽度的90%"+"下面的页签加背景"；同一 shop group 的 `BattlePassScene`/`RechargeScene` 早就是 90%（§20 落地时就写成 `rightPad`），只有 `GachaScene` 是例外。

**问题 1（内容区宽度）**：`GachaScene/base.ts` 的 `contentBounds()` 竖屏分支写的是 `if (!this.cb.openShop || !landscape) return { x0: 0, w }`——横屏非 shop-group 和竖屏共用同一条"满宽"分支，唯独竖屏没有像 `BattlePassScene.contentBounds()`/`RechargeScene.contentBounds()` 那样留 5%×2 边距。翻页书 banner（`page.ts` `bannerW = cw*0.78`）、单/十连按钮（`cw*0.78`）、pity 条、奖池选择条（`cw*0.9`）全部派生自这个 `cw`，所以竖屏下整页看起来比同组其它页面窄。

**方案**：拆开竖屏/横屏两条分支——竖屏单独算 `pad = Math.round(w*0.05)` 返回 `{x0:pad, w:w-2*pad}`（=90%），横屏分支（含 `!openShop` 时的满宽兜底）原样保留，一行没动。

**问题 2（底部页签栏背景）**：`HubTabs.ts` 的 `drawBottomNavTabs`（Shop/Gacha/BattlePass/Recharge 竖屏共用的底部页签栏）当天早些时候已经加过一条整条通栏背景（修「格间露底」的透光问题），但填色用的是 `C.paper`（0xfaf6ee）——跟页面纸底色 `ui.bg`（0xf5f0e8）几乎同色，背景条视觉上"画了但看不见"，跟用户反馈的"没背景"是同一回事。

**方案**：填色从 `C.paper` 换成 `C.dark`（0x2c2c2a）+ 0.9 透明度，对齐 `LobbyScene` 自己底部导航栏（`build.ts` 的 `navBg.beginFill(C.cover, 0.9)`）已验证过的深色通栏做法，去掉原来意义不大的单像素顶边线。未接入的 inactive 页签格仍用浅色 `sketchPanel`（paper 底+描边），叠在深色通栏上读成"卡片贴在深色底栏上"，与 active 格（深底+强调色描边+白字）区分明显。`drawSidebarTabs`（横屏侧栏）完全没碰。

**验证**：`tsc --noEmit` 全绿；`npm run build:web` 生产构建成功（仅预置体积告警）；`npm run test:ui -- shopGroupTabs sidebarRailOrientation scenes.ui`（4 文件 166 例）全绿，无回归。**未做真人截图走查**：本次会话 Browser 预览面板同样报 "pane not displayed"（同 §20.5/§21 的已知环境限制），已确认 dev server 正常起、竖屏视口挂载；用户知情后可自行在实机/浏览器里核对最终视觉效果。
- **涉及文件**：`client/src/scenes/GachaScene/base.ts`（`contentBounds`）、`client/src/ui/widgets/HubTabs.ts`（`drawBottomNavTabs` 背景条）。

## 23. Hero Roster 竖屏三连修：网格 90% 宽 + mask 裁剪 + 底部导航栏加背景（2026-08-09）

> 状态：**已实现**。用户反馈 Hero Roster（`CardScene`）竖屏截图三处问题：①卡片网格没铺满屏宽 90%；②卡片列表会盖住底部页签栏；③底部页签栏没有背景（透传出后面内容）。①②是 `CardScene`（`client/src/scenes/CardScene/list.ts`）自身的问题，③出在两者共用的 `HubTabs.drawBottomNavTabs`（`client/src/ui/widgets/HubTabs.ts`），后者被 14 个场景复用，一并修好对全部竖屏底部导航栏生效。

**①网格宽度**：`renderList()` 里竖屏左起点此前和横屏共用一行三元表达式，读的是 `marginLineX(w) + ROSTER_GAP`（页边线右侧起排，右边只留一个 `ROSTER_GAP`≈24px）——不是本文档 §21 那种"整列居中收窄"，而是一个偶然形成的、左宽右窄的不对称留白。改成竖屏专属分支：`avail = round(w*0.9)`，`left = round((w-avail)/2)`，与 §21 `LobbyScene.fullContentW` 竖屏 90% 同一约定。横屏分支（`sidebarNavW(w,h,true) + ROSTER_GAP`）未动。副作用：`avail` 从 935 变成 972（`w=1080`），跨过 `ROSTER_COLS` 的一个列数分界点，竖屏默认从 2 列变 3 列（`CARD_CELL_W_TARGET=300` 时仍能整除排下 3 列且格宽略增至 308px）——判定为期望内的行为，铺满宽度本来就该让贪心分列算法多塞一列，而非保留旧列数、只加空白边距。

**②mask 裁剪**：`renderList()` 原先明确写了"网格不上 mask，行级 draw-cull（整行画/整行跳过，从不裁切）"，理由是 2026-07-23 的教训——`peekViewportH` 式收缩可视区配合真 mask 才有意义，套在没有真 mask 的地方只会让本该露出一角的行整行消失。但没有 mask 也意味着：滚动到中间态时，一行只要**顶部**还在 `[listY, listY+availH]` 内就整行画出来，即使它的**底部**已经越过 `availH` 边界、画进了 `bottomNavH(h)` 预留区，盖住后画的底部导航栏。解法不是引入 `peekViewportH`（教训依旧适用），而是给卡片套一层裁剪到 `[listY, listY+availH]` 的 `gridLayer`/`clip` 子层——`EquipmentScene` InventoryMixin 早就是这么做的（`inventory.ts` 的同名 `gridLayer`/`clip` 写法），照抄即可，两者本来就该一致。

**③底部导航栏背景**：`drawBottomNavTabs` 每个 tab 格子本身有 `sketchPanel` 实心填充，但格子之间的 `gap` 和两端的 `pad` 从未画任何背景——透明，滚动内容能透出来贴到屏幕底边，读起来像"导航栏是半透明/没铺满"而不是一条实体导航栏。补一条铺满 `(0,y)`–`(w, y+barH)` 的背景层，画在所有 tab 格子之前（`container.addChild` 顺序最先，天然被格子盖在下面）。

**测试**：新增 `client/test/ui/cardRosterPortraitWidthAndClip.ui.ts`（两条 `it`）：①用真实 `createLayout(1080,1920)` 构造竖屏 `CardScene`，读 `cellRects` 断言网格最左/最右边缘精确落在 `round((w-round(w*0.9))/2)` / `w - 同值`；②构造 20 张卡片触发滚动，读 `cellContainers` 找到某张卡的容器，沿 `.parent` 找到 `gridLayer`，断言其 `.mask` 存在且 `getLocalBounds()` 的 y/height 精确等于 `[headerH, headerH+availH]`（严格小于屏幕高度，即确实给底部导航栏让出了空间）。

**验证**：`tsc --noEmit` 全绿；`npm run build:web` 生产构建成功（仅预置的资源体积告警，与本次无关）；`npm run test:ui`（全量 140 个文件 / 1303 例）全绿，无回归。**未做真人截图走查**：本次会话 Browser 预览面板同样报 "pane not displayed"（`preview_start` 能起服务、`document.querySelectorAll('canvas').length === 1` 证明页面真渲染了，但 `computer{action:"screenshot"}`/点击交互全部因面板未显示而超时/拒绝）——延续 §20.5/§21 记录的同一环境限制，改用上面两条读取真实 PIXI 场景几何坐标的 UI 测试做数值级验证，未肉眼核对最终像素效果。
- **涉及文件**：`client/src/scenes/CardScene/list.ts`（`renderList()` 竖屏 left/avail 分支 + `gridLayer`/mask）、`client/src/ui/widgets/HubTabs.ts`（`drawBottomNavTabs()` 背景层）、`client/test/ui/cardRosterPortraitWidthAndClip.ui.ts`（新增）、`design/game/CHARACTER_CARDS_DESIGN.md` §10.1（网格左起点/mask 说明同步更新）。

## 24. Collection（`CardCodexScene`）竖屏三处修复：内容区 90% 宽 + 卡名裁切 + 底部导航栏背景（2026-08-09）

> 状态：**已实现**。用户看着竖屏 Collection（图鉴）页面截图反馈三点：①内容没铺满屏宽 90%；②角色名称没显示完全（如「Infantry」显示成「Infa」）；③底部页签栏没有背景。③当天早些时候已经在 `HubTabs.ts` 的 `drawBottomNavTabs` 里统一修过（§22/§23 同一处改动，覆盖全部竖屏 Career/Shop 类底部导航栏），Collection 页无需再动；本节只处理①②，两个都在 `CardCodexScene.ts` 自身。

**问题 1（内容区宽度）**：`render()` 里竖屏分支写的是 `contentX = Math.round(w * 0.06)`、`avail = w - contentX - Math.round(w * 0.03)`——左 6%/右 3% 的不对称留白，总宽约 91%，既不是本文档 §21/§23 那种居中 90% 的约定，也不是刻意设计，只是历史遗留的一组数字。

**问题 2（卡名裁切，真正的根因）**：`renderCards()` 的 `tileH = Math.round(h * 0.19)` 直接用 `this.h`（design canvas 高度）算 tile 高度，而 `drawCardTile()` 把插画画成边长 = tileH 的正方形（`imgBox = h`）。竖屏 design canvas 是 1080×1920，`h`=1920 是**长边**；横屏是 1920×1080，`h`=1080 才是**短边**——`sidebarNavW()` 的文档注释早就讲过这个坑（design 坐标轴在两个方向上互换含义，短边有时读 `w` 有时读 `h`），`tileH` 这行显然没套用同一约定。结果竖屏下插画正方形边长 365px（`round(1920*0.19)`），而 tile 总宽只有约 470px（91% 宽两栏），右侧信息面板被挤到只剩 ~85px——不管整体宽度改不改 90%，这点空间都塞不下任何角色名。横屏因为 `h`=1080 恰好是短边，插画只有 205px，一直没暴露这个 bug。

**方案**：
1. `contentX`/`avail`：竖屏改成 `fullContentW = Math.round(w * 0.9)`、`contentX = Math.round((w - fullContentW) / 2)`、`avail = fullContentW`，与 §21/§23 同一约定；横屏分支（含"无侧栏"兜底）保持原公式一字不动。
2. `tileH`：改成 `Math.round((this.landscape ? h : w) * 0.19)`——横屏继续读 `h`（短边，数值不变），竖屏改读 `w`（短边，1080），插画正方形从 365px 缩到 205px，信息面板宽度从 ~85px 恢复到 ~250px+。
3. 另外给卡名文字加了一道 shrink-to-fit 兜底（`if (name.width > maxNameW) name.scale.set(...)`），照抄 `HubTabs.ts` 的 nav 标签同款写法——tileH 修正是真正的解法，这道只是防将来某个本地化长名字仍然溢出。

**测试**：`client/test/ui/cardCodexPortraitWidthAndText.ui.ts`（9 条 `it`）：竖屏六条——①用真实 `createLayout(1080,1920)` 构造场景，从私有 `hits`（`scroll:true` 的插画点击热区）读两栏的 x，断言最左边等于居中 90% 公式、两栏间距等于 `tileW+gap`；②断言热区 `w===h===round(1080*0.19)`（新公式），而不是旧的 `round(1920*0.19)=365`；③遍历场景找出所有卡名 `PIXI.Text` 节点，断言 `scale.x` 全部 `≈1`（没有一个需要靠 shrink-to-fit 兜底才能塞下，证明 tileH 修正本身就够）；④在③的 scale 代理断言之外另加一条直接几何证明——按最靠近的列起点算出每个卡名所在 tile 的右边界，断言 `name.x + name.width <= tileRight`（不依赖"没缩放==没溢出"这个假设本身成立）；⑤同一条几何断言重跑在"一个角色都没解锁"（锁定条目没有插画热区，靠列起点分组而非 hits）；⑥同一断言重跑在"解锁两个、其余锁定"的真实混合场景。横屏三条 regression guard——插画热区仍是 `round(1080*0.19)`（`h`，公式路径没变数值也没变）、左起点不等于竖屏 90% 居中公式（防止两条分支被误合并）、卡名 `scale.x` 同样全部 `≈1`（横屏在修之前本来就没这个问题，补一条防将来回归）。

**验证**：`tsc --noEmit` 全绿；`npm run build:web` 生产构建成功（仅预置体积告警）；`npm run test:ui -t "CardCodexScene"`（含新增 9 例）16/16 通过，无回归。**未做真人截图走查**：本次会话 Browser 预览面板同样报 "pane not displayed"（同 §20.5/§21–23 的已知环境限制）；这次额外确认了根因——`requestAnimationFrame` 在该 tab 里完全不触发（`window.__capture` 调度后多次轮询仍是 `not ready`），即该 tab 处于未合成/未渲染状态，浏览器根本没有在跑动画帧，不是 WebGL `preserveDrawingBuffer` 时序问题那么简单，是这个环境下该面板此刻就没有被真正显示出来。改用上面的 UI 测试读取真实 PIXI 几何坐标做数值级验证，未肉眼核对最终像素效果。
- **涉及文件**：`client/src/scenes/CardCodexScene.ts`（`render()` 的 `contentX`/`avail` 竖屏分支、`renderCards()` 的 `tileH`、`drawCardTile()` 的卡名 shrink-to-fit）、`client/test/ui/cardCodexPortraitWidthAndText.ui.ts`（新增）。

## 25. 商城「强化保护石」Buy 上方加一键 ×10 购买按钮（2026-08-09，2026-08-10 改服务端批量）

> 状态：**已实现**。用户看商城截图圈出保护石卡的 Buy 按钮，反馈大量购买时一件件点太麻烦，建议加个一键买 10 个的按钮。

**初版方案（2026-08-09，纯客户端，未改契约/服务端）**：`kind==='item'` 的消耗品卡（目前只有 `protect_enhance`；`server/shared/src/economy.ts` 的 `SHOP_ITEMS` 里唯一一条 `kind:'item'`）在原有 Buy 按钮上方新增一枚 `shop.buyX10` 按钮（`ShopMixin.buildShopCards()`，`client/src/scenes/ShopScene/shop.ts`），`enabled = !busy && coins >= cost*10`。点击调用新方法 `ActionsMixin.onBuyBulk(itemId, itemName, qty)`（`actions.ts`）：在同一个 `BusyTracker` 锁下**顺序**调用 `cb.buy(itemId)` 10 次，遇到第一次 `ok:false`/抛错就停手；成功数 >0 时只在最后统一 `loadItems()` 刷新一次（不是每件刷新一次）+ toast「购买成功：{name} ×{已买数}」，10 次全部失败才走原有错误 toast 分支。当时的判断是：服务端批量接口跨三个服务改动，相对于"少点 9 次"这个纯 UX 请求不成比例，且顺序调用 10 次 `buy()` 与玩家手动点 10 次 Buy 效果等价，故按纯前端方案实现。

**2026-08-10 改为服务端批量**：用户反馈"×10 这个按钮点一下要转很久，比其它请求明显卡"——上面这条等价性判断漏了代价：顺序调用 10 次 `buy()` 就是把 client→meta→Redis + meta→commercial（内部 HTTP）→Mongo + meta→Mongo 这条三级链路原样跑 10 遍、完全排队等待，不是"跟手动点 10 次一样快"，而是确确实实慢 10 倍。改为 `POST /shop/buy` 新增可选 `qty`（默认 1，服务端一次请求内完成"校验上限→扣费 `cost×qty`→发货 `qty` 份"，全有或全无，不做部分成交）。落地范围/测试覆盖详见 [`ECONOMY_NUMBERS.md` §6.6](ECONOMY_NUMBERS.md#66-商店批量购买-qty2026-08-10-性能修复)。客户端 `onBuyBulk` 从"循环 10 次"改为一次 `cb.buy(itemId, 10)`——按钮的 UI/文案/`canBuy10` 判断逻辑不变，改动只在这一层。**仍然只加给 `kind==='item'`，没有扩到 `kind==='material'`**（`mat_buy_scrap`/`mat_buy_lead`）：材料档本身 `qty` 字段已经把多件打包成一次购买（如 `mat_buy_scrap` 一次买已经是 10 个 scrap），且材料档带 `MATERIAL_SHOP_DAILY_CAP`（按*购买次数*计，不是件数）——服务端虽然已支持材料档的 `qty`（`bumpCappedCounter` 的 `by` 参数一次性按 `qty` 校验+扣减每日计数），但这块的按钮/UX（比如按钮上限提示/自动按剩余次数封顶）还没做，留给未来有需要时再补前端。
- 按钮布局沿用 `drawCard()` 现成的"多按钮纵向堆叠"机制（`spec.buttons: BtnSpec[]`，月卡的 Buy+每日领取就是同一机制的先例）——`buttons: [x10Btn, buyBtn]`，x10 排在数组前面即画在上方，未改任何几何计算代码。
- **i18n**：三语新增 `shop.buyX10`（zh「一键购买 ×10」/ en「Buy ×10」/ de「×10 kaufen」）+ `shop.boughtNamedQty`（`{name} ×{qty}` 形式的成功 toast，与既有 `shop.boughtNamed`/`shop.item.material.title` 的插值写法一致）。
- **测试**（`client/test/shopActions.test.ts` — 方法级，`onBuyBulk`）：busy-lock、成功=一次调用（`cb.buy(itemId, qty)`）+ 一次刷新、`ok:false`=不刷新（全有或全无，2026-08-10 起不再有"中途失败保留部分成功"的分支）、`TimeoutError`、`qty=0` 防御性回归（不调用 `buy()`/不 toast/照常释放忙锁）。**`client/test/ui/shopScene.ui.ts` — 走真实按钮命中列表（不是直接调方法）**：①卡只够买 1 件时 ×10 禁用（无命中矩形）而 Buy 仍可点；②够买 10 件时点击 ×10 调用 `buy('protect_enhance', 10)` **一次**（2026-08-10 起，此前是十次）；③material 档不出现这个按钮；④点一次 ×10 后同步 `render()` 已把按钮画成禁用态——第二次真实点击根本摸不到命中矩形（busy-lock 在 UI 层的真实表现，不只是方法内部的 `if (busy) return`）；⑤**端到端**：钱包状态随 `buy()` 真实扣减 `cost×qty`、10 连购花光额度后下一帧 ×10 灰掉但 Buy 仍可点（`getCoins`/`buy`/`loadItems` 三者接线正确，不是分别孤立测过就直接假定拼起来也对）。服务端侧新增 `economy.e2e.test.ts`（qty 计费/发货/全有全无/材料每日上限/对账重放/schema 上限校验）+ `commercial/test/service.e2e.test.ts`（`shopCharge` qty 计费/全有全无/越界拒绝）+ `shared/test/dailyCounter.test.ts`（`bumpCappedCounter` 的 `by` 参数）。
- **验证**：`tsc --noEmit` 全绿；`npx vitest run test/shopActions.test.ts`（23 例）+ `npx vitest run --config vitest.ui.config.ts test/ui/shopScene.ui.ts`（43 例）全绿，无回归。**未做真人截图**：本次会话 Browser 预览面板同样报 "pane not displayed"（同 §20.5/§21–24 的已知环境限制，且本机当时 metaserver 未起，商城道具列表本就依赖服务端 `getShopItems`，离线也看不到这张卡）；多按钮纵向堆叠是 `drawCard()`/`drawButton()` 现有几何路径（月卡已在生产验证过同一路径），未新增布局代码，故以上面两个文件的 headless 像素坐标断言 + 既有生产先例作为验证依据。
- **涉及文件**：`client/src/scenes/ShopScene/shop.ts`、`client/src/scenes/ShopScene/base.ts`、`client/src/scenes/ShopScene/actions.ts`、`client/src/i18n/locales/{zh,en,de}.ts`、`client/test/shopActions.test.ts`、`client/test/ui/shopScene.ui.ts`。

---

## 26. 页头标题与金币读数在竖屏下重叠（2026-08-24）

**症状**：430pt 宽的竖屏下，卡背包页头的居中标题 "Hero Roster" 直接压在金币数 `95,946,835` 上，金币图标画在字母 `r` 上。Chrome 实测：标题右边缘 346.9px，金币文字从 325.3px 开始。

**根因**：`drawSceneHeader()` 给右侧的货币簇（各场景自己画在页头之上的 `drawHeaderCurrency`）**留的是固定 20% 条宽**（`TITLE_RIGHT_RESERVE_RATIO`）。这个比例做不到它要做的事——货币簇的宽度取决于调用方的数据：金币位数、有没有容量读数（`73/500`）、有几个材料 chip。卡背包这一组实测占了条宽的 ~27%，于是标题的允许区间伸进了货币簇里。原注释把固定比例说成是主动取舍（"cluster 是本函数返回后才由场景画的，没法拿到真实宽度"），但场景其实拿得到——它有金币数和容量串。

顺带说明为什么不是「把返回按钮/标题字号调小」：`backSize()` 由 `headerH` 推导，而 `PortraitLayout` 把设计高度拉长以保持页头恒占 12% 屏高，所以竖屏下返回胶囊吃掉 559/1080 设计 px（52% 条宽）。这是 12.07.2026 拍板的触控目标放大，不在本次范围内单方面回退。

**修法**（两段，各自独立成立）：

1. **真量一次，而不是猜。** `SceneHeader/currency.ts` 把「摆放」抽成一条内部路径 `buildCluster()`，`drawHeaderCurrency()` 与新导出的 **`headerCurrencyWidth()`** 共用它——所以量出来的数和画出来的宽**不可能对不上**。`drawSceneHeader()` 新增 `opts.rightReserve`（设计 px，另外自动加上和返回胶囊同一档的呼吸间距）；**8 个画货币簇的场景**全部改为先量后传。标题装不下时沿用既有的 `fit` 等比缩小——**让标题让位而不是让读数让位**是刻意的取舍：余额是玩家要读的实时数据，标题是他已经知道的标签。
2. **运行时兜底。** `SceneHeaderResult` 新增 `titleRight`（本次实际画出的内容右边缘），场景把它作为 `drawHeaderCurrency(..., leftBound)` 回传。标题在 `build()` 里烘一次、货币簇每帧重画，所以余额中途多一位数时第 1 段的预留会过期；这时整簇按右边缘等比缩小，而不是退回重叠。**故意不设下限**：缩到看不清说明预留算错了，静默重叠只会把问题藏起来。

**实测**（Chromium，430×932，dpr 2）：

| | 标题右边缘 | 金币文字左边缘 |
|---|---|---|
| 改前 | 346.9 px | 325.3 px（重叠 21.6 px） |
| 改后 | 299.2 px | 325.3 px |

余额短时预留也跟着变小：`1,234` 时标题右边缘回到 330.5 px。**横屏逐像素零差异**（1280×720 页头条 before/after diff = 0/481280 像素）——本次改动只在窄条上生效。

**影响面**：`AuctionScene` / `BattlePassScene` / `CardScene` / `EquipmentScene` / `FriendsScene`（world 页签）/ `GachaScene` / `RechargeScene` / `ShopScene`。其中后三个是**测试找出来的**，不是 grep 找出来的——先前那次 `grep -rn drawHeaderCurrency src/ | head` 被 `head` 截断在 5 条。

**连带拆分**：`EquipmentScene/core.ts` 因新增的 spec 方法涨到 549 行、超过 baseline，按 form① 挖出 `headerRow.ts`（`renderHeaderCurrency` / `renderMaterialsBand` / `headerCurrencySpec` 三者共享「这一行放不下材料标签所以另开一条带」这个前提，故归在一处），回落 489 行，**baseline 例外条目随之删除**。

**回归测试**：
- `client/test/ui/sceneHeaderCurrencyFit.ui.ts`（12 例）——量测与绘制一致、预留随数据变化、有/无预留的红绿对照、预留也装不下时的兜底、默认路径不变。**注意**：headless 的 `measureText` 是恒定 7px/字符且与字号无关（见 `claudedocs/client-testing.md`），本 bug 在 headless 里**根本复现不出来**（该 mock 下货币簇只有 171px，还小于旧的 216px 预留）——所以场景级「有没有重叠」那一条第一版写完就作废了，机制改在单元层用「长标题 + 放大 scale」按比例还原后再断言，文件头把这件事写明了。
- `client/test/headerCurrencyReserve.test.ts`（17 例，静态扫描）——每个 `drawHeaderCurrency` 调用点都必须传 `leftBound`，且同目录内必须有 `headerCurrencyWidth(...) + rightReserve` 的配对；调用点清单本身带 canary（改名不许让整个套件静默变空）。这是能机械守住的那一半，也正是它抓出了漏掉的三个场景。
- 像素证据只能靠浏览器：`web-e2e` 入口的 `__nwE2E` 现在**多暴露一个 `app`**（读 `PixiAppViews` 的 `private readonly app`——`wrapViews` 是唯一的注入点且只拿到 views，为测试专用需求开生产接缝更不划算），Playwright 因此能遍历真实显示树、读 `getBounds()` 出数，而不是靠肉眼看截图。

## 27. 页头标题不跟着页签走（皮肤页 / 商店充值页，2026-08-26）

**症状**：卡背包场景切到「皮肤」页签后，页头标题仍是「卡背包」、图标仍是卡背包的 `rosterIcon`——左侧导轨高亮在「皮肤」，页头却说这是卡背包（用户报的 bug，截图为横屏 1600×760）。

**根因**：页头是在 `CardSceneCore.build()` 里**一次性**画进 `this.container` 的，标题写死 `t('roster.title')`。`build()` 属于「层脚手架」，整个场景生命周期只跑一次；而 `render()` 每次重画的是 `bodyLayer`（导轨、内容网格）和 `headerOverlayLayer`（金币/容量读数）。于是页签一切，除了标题以外全都变了。`initialTab: 'skins'` 直接开进衣柜、以及 ADR-072 的 `showTab('skins')`（从装备页导轨跳过来）也同样中招。

**修法**：把标题条从 build 的一次性脚手架里拆出来，单独一层 `core.headerLayer`（插在 `loadingLayer` 与 `headerOverlayLayer` 之间，z 序不变），新增 `core.renderHeader()` 按 `core.tab` 取标题与图标（`roster.title`/`rosterIcon` 对 `roster.tab.skins`/`skinIcon`），由 `CardScene.render()` 在注册返回键 hit 之前调用——`backRect` 归页头所有，必须先重画再登记。形状与 `FriendsScene/chrome.ts` 的 `drawHeader()` 一致（标题键由当前页签推导，每次 render 重画）。货币簇的 `rightReserve` 仍走同一个 `headerCurrencySpec()`，§26 的量测约定不变。

**顺带**：皮肤页签的页头右上角原本还挂着卡牌容量读数 `74/500`（`headerCurrencySpec()` 不分页签）——数的是卡，画在一页皮肤上面。`capacity` 改成 `tab === 'skins' ? undefined : {...}`（`drawHeaderCurrency` 的该参数本就可选），金币照旧；预留宽度走同一个 spec，所以量测与绘制仍不可能对不上。

**同一 bug 类：商店的「充值」页签**（同一次审计发现，一并修）。`ShopScene` 的 `tab: 'shop' | 'coins'` 是**本场景内的两个页签**，却和抽卡/通行证/累计充值这些**同组的别的场景**共用一条导轨；`drawHeader()` 写死 `t('shop.title')`，于是充值页高亮在「充值」、页头却写着「商店」。改为按 `this.tab` 取 `shop.coinsTab`/`coinTabIcon`。它的页头本就每帧重画（`render()` → `drawHeader()`），所以不需要 CardScene 那种分层。

**其余页面审计结论**（这次把所有带导轨/页签的场景过了一遍）：

| 场景 | 页签性质 | 结论 |
|---|---|---|
| `CardScene`、`ShopScene` | 导轨里混着**同组别的页面**和本场景的本地页签 | **本次修**：页头必须报出高亮那格的名字 |
| `DailyScene`、`FriendsScene` | 主导轨，四/五个各自独立的功能 | 早已按页签换标题，无需改 |
| `AuctionScene`（全部/我的寄售/我的出价） | 同一个场馆内的**筛选**，导轨里没有别的场景 | 保持「拍卖行」——场馆名才是有用的上下文 |
| `EquipmentScene`（背包/锻造）、`AchievementScene`（成就分类） | `drawSidebarTabs(..., { sub: true })` 的**下挂子页签** | 保持父页标题 |
| `GachaScene`、`BattlePassScene`、`RechargeScene` | 导轨全是别的场景，自己那格 `active` | 标题本就等于高亮格 |
| `FamilyScene`、`SectScene` | 页头是自绘的组织名 | 不适用 |
| `EventScene` | 活动名横条，活动标题另画在正文里 | 保持「活动」 |
| `SettingsScene` 头像选择、世界地图领地面板 | 页签在弹窗/面板内，不涉及场景页头 | 不适用 |

判据一句话：**导轨里只要出现别的页面，页头就得说出高亮那格的名字**；纯粹是一个场所内部的筛选或下挂子页签时，页头保持场所名。

**回归测试**：
- `client/test/ui/cardSceneSkins.ui.ts` 新增 3 例——导轨来回切、`initialTab: 'skins'` / `showTab()` 两条入口、以及容量读数的进出。标题断言必须读 `core.headerLayer` 而不是整棵树：左侧导轨画的正是同样这两个词。
- `client/test/ui/shopGroupTabs.ui.ts` 新增 2 例——同样的双份文字问题，这里按几何区分（`getGlobalPosition().y < sceneHeaderHeight()` 才算页头那条带）。红绿对照做过：回退 `ShopScene` 的改动后这 2 例都红。
- `client/test/ui/headerTitleFollowsTab.ui.ts`（新文件，6 例）——上表那条判据本身的守卫，两半都盯：Card/Shop/Daily/Friends 四个「导轨里有别的页面」的场景必须按页签换标题（Daily/Friends 此前没人断言过页头，它们各自的用例只断言过「这个词出现在树里」，而导轨本身就画着这个词），Auction（三个筛选）/Equipment（背包·锻造子页签）则必须**不**换。统一按几何读页头（`getGlobalPosition().y < sceneHeaderHeight()`），不依赖各场景怎么搭层。红绿对照做过：把两处修复回退后 Card/Shop 两例红、其余四例绿。
- `client/test/ui/sceneHeaderCurrencyFit.ui.ts` 跟着改了一处**读法**（§26 那条断言原本从 `core.container.children` 里找标题，现在标题在 `core.headerLayer` 里）——不是放宽断言，是同一个断言指向新的层。它也是唯一抓到本次分层改动的既有测试。

**像素证据**：`web-e2e` + Playwright（浏览器面板不合成，走 stub 挂载法：`views.showCardRoster(cb)` / `views.showShop(cb)` 直接开场景，无后端无登录）。衣柜页头读「Skins」+ 皮肤图标、右上角只剩金币；商店充值页读「Top Up」+ 金币图标。


## 28. 收集册属性行：图标不再当标签用 + 竖屏改折行（2026-08-27）

**症状**（用户圈图，横屏中文）：收集册卡片右侧那行属性 `♡ 60　⚔ 12　射程 1` 三个词条**三种读法**——生命只有一个心形图标、攻击只有一个匕首图标、射程只有两个字没有图标。图标在这里被当成了标签本身，于是「哪个是生命哪个是攻击」得先学一遍；而射程反过来又证明了这一行本来就有地方写字。

**根因**：`CardCodexScene/tile.ts` 的 `drawStatChips()` 里是一个二选一分支——`s.icon ? 画图标 : 画文字标签`。`cardStats()` 给 `hp`/`atk` 填了 `IconKind`，`range` 填 `null`（`range` 这个 kind 从来没有美术，批次 7 清零矢量画法时它就不在表里）。所以不是漏了一个图标，是**排版规则**把「有没有图标」和「要不要写名字」绑成了一件事。

**修法**：
- **每个 chip 一律写全名**（`[图标] 生命 60`），图标降级成名字之上的冗余提示。`range` 这类还没有美术的词条自然退化成 `射程 1`，跟别的 chip 同构，不再是特例。
- **竖屏改折行，不再整行缩放**。写全名让这行宽了约三分之一，而竖屏信息面板窄，原来的 `row.scale.set(maxW / row.width)` 会把字压到名字那行的一半大小（实测缩放系数 0.60）。改成：每个 chip 先各自组装成一个不可拆的容器，然后在 1..N 行里挑**拟合系数最大**的那个行数（同时受面板宽度和「行顶到卡片底部」的高度预算约束），横屏仍是一行满字号，竖屏两行、字号几乎不缩。高度预算是新加的入参 `maxH`——没有它时三行会直接溢出卡片下边框（实拍见过）。

**射程等词条的图标缺口另开了一批**：全库词条盘点 + 出图 prompt 见 [`design/product/tab-icon-art-prompts-batch8.md`](../product/tab-icon-art-prompts-batch8.md)（`range`/`siege`/`crit`/`critmult` 四张，出图后只需把 `cardStats()` 里的 `icon: null` 换成 kind、`affixIconKind()` 加三行）。**本次不画占位图标**：一个看不懂的图标比没有图标更糟，而名字已经在那儿了。**（同日追加：四张图已出并接线，`射程` 现在有图标了；`range` 第一版 4.24:1 在 28px 上缩成一条发丝、被打回重构图。）**

**回归测试**：`client/test/ui/cardCodexScene.ui.ts` 新增 1 例——三个词条的**名字**都必须出现在树里（此前只断言过数值）。红绿对照：回退 `drawStatChips` 的改动后该例红。既有 18 例（含竖屏宽度/卡名裁切那组几何断言）全绿。

**像素证据**：`web-e2e` + Playwright stub 挂载（`views.showCardCodex(cb)`，无后端无登录），中英各一组、横屏 1280×720 + 竖屏 390×844 各一张。横屏与改动前逐字同位（只多了三个词），竖屏两行且落在卡片内。

- **涉及文件**：`client/src/scenes/CardCodexScene/tile.ts`（`drawStatChips` 重写 + `drawCardTile` 传高度预算）、`client/test/ui/cardCodexScene.ui.ts`。
