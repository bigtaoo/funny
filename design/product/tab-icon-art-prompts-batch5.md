# 批次 5：页面标题图标 + 剩余二级页签 — Prompt 文档

> 创建：2026-08-17 · 判断+prompt 定稿：2026-08-17 · 代码出口已先行落地（见下"出口"一节）
> 前四批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（试点/批次 2/批次 3/批次 4，共 19 个光栅图标）
> 配套代码：[`client/src/ui/widgets/SceneHeader.ts`](../../client/src/ui/widgets/SceneHeader.ts)（`opts.icon` + `buildTitleIcon`）· [`client/src/render/icons.ts`](../../client/src/render/icons.ts) · [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6
> 状态：**出口已开 + 纯复用已接线**；**24 张新图判断+prompt 已定，等出图**

## 背景：这一批跟前四批不是同一类位置

前四批的范围写死在"页签条上的图标"。用户 2026-08-17 圈图指出：**页面标题（`装备`）、顶部筛选条（`全部/武器/护具/饰品`）、左侧二级导航（`背包/锻造`）这三类位置全都没有图标**——不是图标画得不好，是根本没有。

梳理全部场景后确认缺口分两类：

| 类别 | 缺口 | 其中可复用现有 19 张 | 需新概念 |
|---|---|---|---|
| A. 页面标题（`drawSceneHeader` 的 title，+3 个自绘标题的场景） | 31 个标题态，**全部**没有图标 | 14 处 | 16 个 |
| B. 页签/筛选条仍是纯文字 | 25 个格子 | 6 格 | 8 个 |

去重后（A/B 有大量共享概念，比如"好友"既是标题又是 rail 页签）：**新出图 24 张**，另有 20 处纯复用不需要出图。24 张 × 3 种墨色 = 72 张 PNG，加上现有 57 张，最终 43 个光栅图标 / 129 张 PNG。

## 出口（代码侧，已落地，不等图）

出图前先把"图往哪挂"这件事解决掉，否则每个场景又会各画各的（批次 4 "没有出口"那条教训）：

1. **`drawSceneHeader(container, w, h, title, { icon })`** —— 新增 `opts.icon`，把 `[图标][间距][标题]` 当一个组居中（或左对齐），并处理两条边界：组不得压到返回按钮胶囊上，也不得越过右侧货币簇的预留区（`TITLE_RIGHT_RESERVE_RATIO`）；放不下就图标和文字**一起等比缩小**，沿用 `HubTabs` 给页签标签"缩到装得下"的既有做法。这两条都是实拍出来的：第一版只居中 → 图标画在"返回"字上；第二版只做左侧钳制 → 英文 `Hero Roster` 顶出右边界。
2. **`buildTitleIcon(kind, titleSize, titleColor)`** 导出 —— 给 `CampaignMapScene` / `FamilyScene` / `SectScene` 这三个 `title: null` 自绘标题的场景用，它们自己排版但不重新推导墨色规则。
3. **墨色**：纸面标题一律取第三种 `content` 墨（`C.dark`，跟标题文字同一档），不是页签非激活态那份刻意压暗的灰——`tabIconVariant()` 按颜色分不出这两者（批次 4 追加那节的结论），只能由调用点显式声明。
4. **预热**：`LobbyScene` 构造时 `preloadTabIconTextures()` + 完成后重绘，并把 `idlePrefetch` 的 `icons:reward` 波次提到 `battle` 之前。原因：光栅图标未解码时 `buildIcon` 画的是空白，而"设置/关卡准备/房间"这类**只渲染一次**的场景不会自愈——一次晚到的解码就是永久空白图标。所有二级场景都从大厅进入，在大厅预热等于覆盖全部。
5. **回归测试**：`client/test/ui/sceneHeaderTitleIcon.ui.ts`（墨色变体 + 三条布局约束：不压返回键、不越右边界、无图标时与改动前一致）。

**已接线的纯复用（无需新图，已完成）**：标题 14 处 —— 卡背包→`rosterIcon`、装备→`equipIcon`、收集册→`rosterIcon`、商店→`shopTabIcon`、扭蛋→`gachaTabIcon`、通行证→`battlepassTabIcon`、充值→`rechargeTabIcon`、统计→`statsTabIcon`、称号→`honorTabIcon`、成就→`achievementTabIcon`、关卡准备→`pveTabIcon`、战役章节→`pveTabIcon`、世界频道→`socialTabIcon`、排位匹配→`pvpTabIcon`；页签 6 格 —— 社交 rail「世界」→`socialTabIcon`、头像选择器「角色/皮肤」→`rosterIcon`/`skinIcon`，宗门「成员家族」「宗门频道」等待下方新图后复用家族/频道两张。

**出图后接线还要先补的三条"手绘"页签条**（它们不是 `HubTab`，目前没有 icon 字段，接线时要先加支持，各约 10 行）：`EquipmentScene/inventory.ts` 的部位筛选条、`FamilyScene/render.ts` 的成员/频道 tab、`SectScene/render.ts` 的同款 tab。刻意没有提前写——没有图可挂的渲染分支就是死代码。

## 判断结果总表（24 张新图 + 复用决策）

### A 组：页面标题（16 张）

| # | 位置 | i18n | 造型 | 避让 |
|---|---|---|---|---|
| 1 | 拍卖场 | `auction.title` | 竞价号牌（圆角牌+短柄，牌面空白） | 不是价签(`shopTabIcon`，有孔+绳)，不是拍卖锤(`bidTabIcon`，同屏还有"我的收购"tab) |
| 2 | 主城 | `city.title` | 城门楼（两侧塔楼+中间拱门+雉堞） | 不是房子(`homeTabIcon` 三角顶方屋) |
| 3 | 全服排行榜 | `leaderboard.title` | 领奖台（三块，**中间最高、两侧等高**） | 不是递增柱状图(`statsTabIcon`)——这是本批最容易撞的一对 |
| 4 | 个人设置 | `settings.title` | 齿轮 | — |
| 5 | 限时活动 | `event.title` | 一串三角小旗（bunting） | 不是礼物盒(下方 #11)，不是旗杆上的旗(SLG 程序 `flag`) |
| 6 | 构筑卡组 | `pvp.deckBuilder` | 扇形展开的三张牌（牌面空白） | 不是单张带小人的卡(`rosterIcon`) |
| 7 | 好友对战 | `room.title` | 半开的门 | 不是房子(`homeTabIcon`)；排位匹配那半已复用 `pvpTabIcon` |
| 8 | 主城防守 / 队伍编辑 | `world.defense.*` / `world.team.editTitle` | 带护鼻的简单头盔 | 不是盾（`equipIcon` 鸢形盾 + #21 胸甲已经占了两档护具语言） |
| 9 | 签到月历 | `daily.checkin.title` | 日历页（顶部两个挂环 + 格线 + 一个勾） | 唯一允许画格线的一张，格线是它的语义本身 |
| 10 | 每日任务 | `daily.tasks.title` | 写字板（顶部夹子 + 三条横线） | 不是日历（格 vs 线），不是藏宝图卷轴(`pveTabIcon`) |
| 11 | 周常宝箱 | `daily.weekly.title` | 系十字丝带的礼物方盒 | **不是宝箱**——拱盖箱子是`rechargeTabIcon`(充值) |
| 12 | 看广告 | `daily.ads.title` | 圆角屏幕框 + 中央播放三角 | — |
| 13 | 好友 | `friends.tab.friends` | 两个并肩半身小人剪影 | 不是地球(`socialTabIcon`)；家族(#14) 是三人围拢，人数和构图要拉开 |
| 14 | 家族 | `friends.tab.family` | 三个小人围成一组（一大两小） | 见 #13 |
| 15 | 宗门 | `friends.tab.sect` | 三层宝塔 | 不是城门楼(#2) |
| 16 | 邮件 | `friends.tab.mail` | 信封（封口三角） | — |

### B 组：只在页签条上的概念（8 张）

| # | 位置 | i18n | 造型 | 避让 |
|---|---|---|---|---|
| 17 | 装备·背包 | `equip.tabInv` | 双肩背包（翻盖+两条带） | — |
| 18 | 装备·锻造 | `equip.tabCraft` | 铁砧 | **不画锤子**——`bidTabIcon` 是拍卖锤 |
| 19 | 筛选·全部 | `equip.filterAll` | 2×2 四方格 | 通用件：其它页面的"全部"筛选以后一并复用 |
| 20 | 部位·武器 | `equip.slot.weapon` | 单把竖直的剑 | 不是交叉双剑(`pvpTabIcon`) |
| 21 | 部位·护具 | `equip.slot.armor` | 胸甲剪影 | 不是盾——同屏的页面标题和同伴页签都已经是 `equipIcon` 那面盾 |
| 22 | 部位·饰品 | `equip.slot.trinket` | 戒指（带一颗方宝石） | — |
| 23 | 头像·预设 | `settings.avatarTab.preset` | 圆框里的半身人像剪影 | **不能读成工牌/证件**——试点批"卡背包 v2"踩过这个坑（圆头像+方框+底线=证件的通用语法） |
| 24 | 家族/宗门·频道 | `family.channel` / `sect.tabChannel` | 对话气泡（圆角气泡+三个点） | 私聊页(`ChatScene`)标题也复用这一张 |

### 判断为复用、不出新图的点

- **家族/宗门「成员」** → 复用 #13 好友图。"一群人"跟"好友"在两个不同屏上是同一个字面概念，硬拆会得到两张互相撞脸的多人剪影（批次 2 判 `cards`→`rosterIcon` 的同一条判据）。
- **宗门「成员家族」** → 复用 #14 家族图；**宗门频道** → 复用 #24。
- **`ChatScene` 私聊标题** → 复用 #24 气泡（或后续改为直接画对方头像，届时不需要图标）。
- **`DefenseEditorScene` 的"队伍编辑"标题** → 与"主城防守"共用 #8，都是"排兵布阵"。
- **世界地图领地面板的 概览/列表/世界 三个 tab** → **本批不做**。它们在弹窗内、不是页面级导航，且"概览/列表"两个概念抽象、缩到 28px 很难画清楚；等页面级铺完再看要不要单独一批。

## Prompt（24 条，沿用前四批骨架）

共用骨架 + 批次 3 学到的三条硬约束（内部纹理线一律不要、边缘不要锯齿、宁可太素也不要太密）。全部要求 28×28 可辨——这是真机竖屏的实际渲染尺寸（`icon = h*0.09*0.34`，见前四批文档的推导）。

### 1 拍卖场（`tabicon_auction`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single auction bidder's paddle — a plain rounded-corner rectangular sign board with a short straight handle at the bottom, held upright, the board face completely blank. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, gavel or mallet, price tag shape, hole punched in the board, string or loop, hand holding it, numbers or text on the board, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 主城（`tabicon_city`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a castle gatehouse seen face-on — two square towers, one on each side, joined by a wall between them, with one tall arched gateway opening in the middle of that wall, and simple square crenellations along the top of both towers. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no brick or stone texture lines. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward too plain rather than too detailed. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, pitched triangular roof, house shape, windows, flags or banners, brick pattern, stone hatching, surrounding landscape, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

### 3 全服排行榜（`tabicon_leaderboard`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a winner's podium seen face-on — three solid blocks side by side, the MIDDLE block clearly the tallest, and the LEFT and RIGHT blocks equal to each other and shorter, forming a symmetrical stepped shape. The symmetry is essential: it must NOT read as bars of ascending height. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, ascending or staircase-shaped bars, bar chart look, axis lines, figures standing on the podium, trophy or medal on top, ranking numbers, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 4 个人设置（`tabicon_settings`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single gear/cog seen face-on — a circle with about six chunky square teeth around its rim and one plain round hole in the center. Few, large teeth rather than many small ones. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward fewer, bigger teeth rather than a finely toothed wheel. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, many thin teeth, a second overlapping gear, wrench or screwdriver, spokes, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 5 限时活动（`tabicon_event`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a short string of party bunting — one gently drooping line with exactly three triangular pennant flags hanging from it, evenly spaced, all the same size, flags left blank. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a single flag on a pole, planted flag, balloons, confetti or sparkle marks, gift box, more than three flags, text, letters, numbers, multiple objects, watermark, gray background, notebook grid lines, drop shadow.
```

### 6 构筑卡组（`tabicon_deck`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: three plain rounded-corner cards fanned out like a small hand of cards, overlapping each other, all card faces completely blank. Just the three outlines, nothing drawn inside them. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as a fanned stack of cards when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a character or figure drawn on any card, playing-card suit symbols, a single card, a neat squared-up stack, hand holding the cards, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 7 好友对战（`tabicon_room`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single door standing ajar — a plain rectangular doorway frame with the door panel swung partly open toward the viewer, one small round doorknob on the panel. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a whole house around the door, roof, windows, wood-grain or plank lines, light beams through the opening, figures walking through, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 8 主城防守 / 队伍编辑（`tabicon_defense`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a simple guard's helmet seen face-on — a rounded dome top, a horizontal brow band, and one vertical nose guard bar coming down the middle, with a plain open face gap. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, shield shape, a face or eyes visible inside, plume or feather crest, horns, chain mail texture, rivet dots all over it, text, letters, numbers, multiple objects, scattered pieces, watermark, gray background, notebook grid lines, drop shadow.
```

### 9 签到月历（`tabicon_checkin`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a wall calendar page — a rounded-corner rectangle with two small binding rings sticking up from its top edge, one horizontal line under the top edge separating a header strip, and a simple 3x2 grid of large empty cells below it, with ONE bold check mark filling one of the cells. The grid must stay coarse: six big cells, not a dense month grid. Single object, centered, filling the frame, on a plain pure-white background, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward fewer, bigger cells. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a full 7-column month grid, dense small squares, dates or numbers in the cells, more than one check mark, clock or hourglass, text, letters, numbers, multiple objects, watermark, gray background, drop shadow.
```

### 10 每日任务（`tabicon_tasks`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a clipboard seen face-on — a rounded-corner board with one small clip shape centered on its top edge, and exactly three short horizontal lines on the board face standing in for list items, evenly spaced. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a grid of cells or calendar look, check marks or checkboxes, more than three lines, rolled scroll edges, pen or pencil next to it, real words or letters on the lines, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 11 周常宝箱（`tabicon_weekly`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single wrapped gift box seen face-on — a plain square box with one vertical and one horizontal ribbon band crossing over its front, and a simple bow with two loops on top. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, treasure chest with an arched lid, keyhole or lock, open lid with contents spilling out, sparkle marks, stacked boxes, ribbon tails trailing off, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 12 看广告（`tabicon_ads`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a video screen — one rounded-corner rectangle, wider than it is tall, with a single bold solid right-pointing play triangle centered inside it. Nothing else inside the rectangle. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, television stand or antenna, phone or laptop body, progress bar or player controls, speaker or sound waves, hollow outlined triangle, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 13 好友（`tabicon_friends`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: exactly TWO people side by side, shown as simple head-and-shoulders silhouettes only (a round head on a rounded shoulder shape each), standing close together and slightly overlapping, both the same size, no facial features at all. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as "two people" when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, three or more figures, full bodies with arms and legs, eyes or mouths, speech bubbles, a circular frame or badge around them, holding hands, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 14 家族（`tabicon_family`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a family group of exactly THREE head-and-shoulders silhouettes clustered together — one clearly LARGER figure in the middle and two clearly SMALLER ones flanking it, the small ones set slightly lower, so the group reads as one triangular cluster rather than a row. No facial features. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as "a group of people" when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two figures only, all figures the same size, a straight side-by-side row, full bodies, eyes or mouths, a house or roof over them, shield or crest shape, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 15 宗门（`tabicon_sect`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a three-tiered East Asian pagoda seen face-on — three stacked levels, each with a wide upward-curving eave roof, the levels getting narrower toward the top, on a simple base. Just the outer silhouette of the roofs and body. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no roof-tile texture lines. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward a plain stepped silhouette rather than architectural detail. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, castle towers or crenellations, arched gateway, torii gate, roof tile lines, windows or doors, surrounding trees or mountains, text, letters, numbers, multiple objects, watermark, gray background, notebook grid lines, drop shadow.
```

### 16 邮件（`tabicon_mail`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single closed envelope seen face-on — a plain rectangle, wider than it is tall, with one large triangular flap folded down from the top edge, its point reaching the middle. Nothing else on the face. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an open envelope with a letter sticking out, stamp or postmark, address lines, wax seal, paper plane, mailbox, motion lines, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 17 背包（`tabicon_bag`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a school backpack seen face-on — a rounded-corner body, one flap folded over the top with a simple buckle in the middle, and one curved carry handle loop above the flap. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no stitching or fabric texture lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, shoulder straps drawn on the front, side pockets, zipper teeth, stitching dashes, items spilling out, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 18 锻造（`tabicon_craft`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a blacksmith's anvil seen from the side — a flat wide top face, one pointed horn on the left, a narrow waist, and a solid base. Just the one classic anvil silhouette. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a hammer or mallet of any kind, gavel, sparks or impact marks, a sword resting on it, fire or forge, tree stump under it, text, letters, numbers, multiple objects, scattered pieces, watermark, gray background, notebook grid lines, drop shadow.
```

### 19 筛选·全部（`tabicon_all`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable shape. Subject: four equal squares arranged in a 2x2 grid with a clear even gap between them, each square a plain rounded-corner outline, all the same size — a simple "show everything" grid symbol. Single object group, centered, filling the frame, on a plain pure-white background, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, more than four squares, a 3x3 grid, squares touching or sharing edges, one square highlighted or filled differently, calendar look, window frame with a cross bar, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 20 部位·武器（`tabicon_weapon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: ONE sword standing upright, point up — a straight tapering blade, one straight horizontal crossguard, a short grip and a small round pommel. Just the single sword, vertical and symmetrical. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two crossed swords, a second weapon, shield behind it, scabbard, shine or sparkle marks, blood, hand gripping it, tilted or diagonal placement, text, letters, numbers, multiple objects, watermark, gray background, notebook grid lines, drop shadow.
```

### 21 部位·护具（`tabicon_armorslot`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a breastplate / body-armor chest piece seen face-on — a symmetrical torso-shaped plate with two shoulder pieces at the top, a neck opening between them, and one vertical center line down the chest. It must read as worn body armor, NOT as a shield. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, shield shape, kite or heater shield outline, a person wearing it, helmet, arms or legs, chain mail texture, rivet dots all over, emblem or crest on the chest, text, letters, numbers, multiple objects, watermark, gray background, notebook grid lines, drop shadow.
```

### 22 部位·饰品（`tabicon_trinket`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single ring seen at a slight angle — a bold circular band with one simple faceted gemstone mounted on top, the gem drawn as a plain small diamond/square shape with two or three straight facet lines, nothing more. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, sparkle or twinkle marks around the gem, many facet lines, a necklace or chain, multiple rings, a ring box, hand or finger, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 23 头像·预设（`tabicon_avatar`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a profile-picture symbol — ONE plain circle outline with a single head-and-shoulders silhouette inside it, the shoulders reaching the bottom edge of the circle, no facial features. The frame must be a CIRCLE, and there must be no line, bar, or band anywhere else in the image. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must NOT read as an ID card or badge. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, rectangular frame or card around the figure, a horizontal line under the figure, ID card, name badge, lanyard, eyes or mouth, hair detail, two figures, camera or photo corners, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

### 24 频道（`tabicon_channel`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: ONE speech bubble — a rounded-corner rectangle with a short tail pointing down-left from its bottom edge, and three small dots in a horizontal row inside it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two overlapping bubbles, a thought-bubble with trailing circles, more than three dots, lines of text inside, a person or head next to it, envelope shape, megaphone, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 出图后的流程（沿用前四批）

1. 源图丢进 `art/ui/tabicons/`，命名 `tabicon_{auction,city,leaderboard,settings,event,deck,room,defense,checkin,tasks,weekly,ads,friends,family,sect,mail,bag,craft,all,weapon,armorslot,trinket,avatar,channel}.webp`。
2. [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) 的 `JOBS` 新增 24 条，跑 `node pack_tab_icons.cjs` → 72 张 PNG（3 种墨色）到 `client/src/assets/tabicons/`。
3. 一次性 `sharp` contact-sheet 验证：28/32/40/64px × `C.dark`/`C.paper`/`C.paper`(content 墨) 三种底。**本批必须额外看一对**：#3 领奖台 vs `statsTabIcon` 柱状图并排，#13 好友 vs #14 家族并排——这两对是判断阶段就点名的高危撞车。
4. `icons.ts`：`IconKind`/`RasterIconKind`/`TAB_ICON_RASTER` 各加 24 条；`preloadTabIconTextures()` 注释改成 129 张。
5. 接线（标题一律走 `drawSceneHeader` 的 `opts.icon`）：
   - 标题：`AuctionScene/core.ts`、`CityScene.ts`、`LeaderboardScene.ts`、`SettingsScene.ts`、`EventScene.ts`、`DeckBuilderScene.ts`、`RoomScene.ts`（非排位那半）、`DefenseEditorScene.ts`、`DailyScene.ts`（按 `TAB_TITLE_KEY` 四选一）、`FriendsScene/chrome.ts`（好友/家族/宗门/邮件四个 tab 标题）、`ChatScene.ts`（复用 #24）。
   - 自绘标题：`FamilyScene/core.ts`、`SectScene/core.ts` 用 `buildTitleIcon`（`CampaignMapScene` 已接）。
   - 页签：`socialTabRail.ts` 的 `TAB_DEFS` 补四条 `icon`；`DailyScene.ts` 四个 tab；`SettingsScene/types.ts` 的 `AVATAR_TAB_ICON.preset`；`EquipmentScene/inventory.ts` 的 `背包/锻造` 两个 `drawSidebarTabs` 项。
   - **先加 icon 支持再接线的三条手绘条**：装备部位筛选、家族 tab、宗门 tab（见上"出口"末段）。
6. `tsc --noEmit` + `vitest` + `vitest --config vitest.ui.config.ts` 全量。
7. 实拍：Playwright + `window.__nwE2E`（配方见记忆 `playwright-screenshot-recipe-2026-08-15`），至少覆盖竖屏 430×932 和横屏 1280×800 各一轮——**标题图标必须在真机竖屏宽度下看一眼**，本批出口阶段两次布局 bug（压到返回键、顶出右边界）都是只有实拍才暴露的。
8. 更新本文档状态 + `art-direction.md` §7.6 + [`tab-icon-art-prompts.md`](tab-icon-art-prompts.md) 顶部的批次索引。
