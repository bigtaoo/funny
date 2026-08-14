# 页签主图标 AI 化 — 试点 Prompt 文档

> 创建：2026-08-14 · 试点批定稿+接线：2026-08-14 · 批次 2 判断+prompt 定稿：2026-08-14
> 配套代码：[`client/src/render/icons.ts`](../../client/src/render/icons.ts)（`rosterIcon`/`equipIcon`/`skinIcon` 三个新 `IconKind`）· [`client/src/scenes/CardScene/list.ts`](../../client/src/scenes/CardScene/list.ts) · [`client/src/scenes/EquipmentScene/inventory.ts`](../../client/src/scenes/EquipmentScene/inventory.ts) · [`client/src/app/nav/game/campaignRoster.ts`](../../client/src/app/nav/game/campaignRoster.ts)
> 美术总纲：[`art-direction.md`](art-direction.md) §0（资产分工）/ §6.2（装饰物涂鸦管线，本文档打包脚本沿用其"抠白底"套路）/ §7.6（本次试点的记录条目）
> 同类文档：[`shop-art-prompts.md`](shop-art-prompts.md) · [`gacha-art-prompts.md`](gacha-art-prompts.md)
> 状态：**试点批（3/15）已定稿并接线**；**批次 2（trophy/book/medal/cards/brush 5 个复用槽位）判断+prompt 已定，等用户出图**——详见下方"批次 2"一节

## 背景

页签图标（HubTabs/CareerTabs/底部导航这类 tab 条上的图标）此前全部是 `icons.ts` 里的程序矢量线稿（`SketchPen` 现画）。反馈是辨识度和完成度不够，原因除了线稿本身简单，还在于**同一个图标被多处复用成不同含义**——比如 `trophy` 同时代表首页战绩/Career成就/通行证/成就分类"进阶"4 种东西。

**拍板**：
1. 页签主图标改走 AI 图，逐批出，不是白名单以外硬性铺开——**这是对 `art-direction.md` §0 资产分工边界的一次扩展**（原边界：角色/兵种走 AI 图，UI 走程序绘制；现在把"页签主图标"这一类 UI 元素也划进 AI 图，跟角色立绘同一理由——辨识度要求高、程序笔触画不出足够细节）。
2. 复用的图标借这次机会拆开，一图一义。
3. 先出一个小批验证风格 + 小尺寸效果，通过了再铺开剩下的。

## 试点范围（3 个）

[`CardScene/list.ts`](../../client/src/scenes/CardScene/list.ts) 养成组页签条——卡背包 / 装备 / 皮肤，以及 [`EquipmentScene/inventory.ts`](../../client/src/scenes/EquipmentScene/inventory.ts) 里镜像的同一个 `[Cards|Equipment|Skins]` 同伴组导航（从装备页跳回卡背包/皮肤时看到的同一条 rail，见 [`campaignRoster.ts`](../../client/src/app/nav/game/campaignRoster.ts) 的 `peerTab`/`trailingPeers`）：

| 页签 | 旧 IconKind（程序绘制，别处复用点仍在用） | 新 IconKind（AI 图，这一个同伴组两处出现都用） | 最终造型 |
|---|---|---|---|
| 卡背包 | `cards` | `rosterIcon` | 单张卡片，卡面是一个粗剪影的挥剑格斗小人（非头像、非扑克花色） |
| 装备 | `armor` | `equipIcon` | 鸢形盾，中脊 + 顶部两颗铆钉 |
| 皮肤 | `brush` | `skinIcon` | 一个挂绳戏剧面具，两个眼孔 + 一道笑弧，不画真人脸 |

**没动的其它复用点**：`cards` 还用在 Career组"图鉴"、拍卖行"我的"、拍卖筛选"卡牌"；`armor` 还用在拍卖筛选"装备"；`brush` 还用在拍卖筛选"皮肤"、成就分类"收藏"。这些继续用现有程序图标，**不受本次试点影响**——等试点上线观察一段时间，再决定这些点是直接复用试点产物、还是各自也拆专属图标。

## 概念反复记录（真正踩坑的地方在这，不在配色/线宽）

**卡背包**：
- v1「两张斜叠扑克牌 + 黑桃 A 花色」→ 读成"扑克/赌博"，跟"角色卡背包"没关系。
- v2「头像 + 卡框 + 星星角标」（去掉花色后想当然加的替代方案）→ 读成"工牌/身份证"——圆头像+方框+底部一条线，这个组合本身就是证件的通用视觉语法，跟内容画得好不好无关。
- v3「单卡 + 动态挥剑火柴人 + 卡后又飘一张卡角 + 运动弧线 + 地面阴影」→ 概念对了（不是脸不是花色），但**元素堆太多**，缩到页签实际渲染的 28-32px 糊成一团，跟 `mat_scrap` 图标当年"多形状撞色缩小后糊成一团"（[gacha-art-prompts.md:306](gacha-art-prompts.md:306)）是同一个坑。
- **v4（定稿）**：去掉背后飘的卡角、运动弧线、地面阴影、剑柄护手细节，人物和武器合并成一个连续粗剪影，卡框只留一根线。28px 下依然能认出"举剑的人"。

**皮肤**：
- v1「一支光秃秃的画笔」→ 太泛化，容易读成"编辑/画画"，不特指"换装扮"。
- v2「一支荧光笔，笔帽摘下放一旁」（贴合游戏内"皮肤=换整套文具媒材"的实际设定，见 `art-direction.md §9.1`）→ 概念上准确，但被质疑：这仍然是"一件文具"，跟装备材料图标（铅笔屑/笔芯/装订环…）已经占用的"文具单品"语言撞车，玩家看一眼分不出这是装备还是皮肤入口。
- **v3（定稿）**：整个跳出"文具/画画工具"这条线，改成戏剧面具挂小绳——业界最通用的"换装扮/cosplay"符号，跟装备的文具语言彻底拉开区分度。

**装备**：一次出图（鸢形盾 + 中脊 + 顶部铆钉）就通过，没有反复。

## 为什么在 28-32px 测试小尺寸——这不是新定的门槛

页签图标尺寸公式：`icon = sidebarItemHeight(h) * 0.34`，`sidebarItemHeight(h) = h*0.09`（[HubTabs.ts:127](../../client/src/ui/widgets/HubTabs.ts:127)），`h` 是屏幕实际高度（CSS px，来自 `platform.getScreenSize()`）。代入真实设备高度：手机竖屏（h≈667-844，本项目"浏览器+微信小游戏"的主战场）→ **图标 20-26px**；常见桌面浏览器窗口（h=1080）→ 33px；只有很大的桌面窗口才到 40px+。**这是现在正在跑的矢量图标已经在用的同一个盒子**，公式没有为这次改动新增或收紧，只是把内容从"程序现画"换成"贴 PNG"。

## 最终定稿 Prompt（3 图，跑通 GPT Image 2）

共用前缀 + 负向同下方历史记录（v4/v3 版本收紧了"极简剪影、砍多余细节"的措辞）：

### 卡背包（`tabicon_roster`，v4）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, bold and thick strokes. Extremely minimal: ONE plain rounded-corner card outline (single card only, no second card behind it, no peeking edges). Inside it, ONE small dynamic action-pose fighter silhouette mid-swing, drawn as a single connected bold thick-lined shape — head, body, swinging arm, and weapon blade merge into one continuous silhouette with as few separate strokes as possible, like a simplified pictogram, not an anatomically detailed figure. NO separate sword hilt/crossguard details, NO motion lines, NO ground shadow marks, NO hatching, NO extra decoration of any kind — just the card outline plus the one bold fighter silhouette, nothing else. Must stay clearly recognizable as "a card with a fighting character on it" when scaled down to 28x28 pixels — err on the side of too simple rather than too detailed. On a plain pure-white background, no grid lines, no other elements, no color, no shading, no gradient, no glow, no playing-card suit symbols, no face/portrait close-up, no text, no watermark. Style of West of Loathing / doodle art, but pushed toward icon-level simplicity.
```

### 装备（`tabicon_equip`，一版通过）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a round-topped kite shield seen face-on, a vertical center rib spine, two rivets near the top corners. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, multiple objects, scattered pieces, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

### 皮肤（`tabicon_skin`，v3）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single simple theatrical drama mask — an oval face-shaped mask with two eye cutout holes and one simple curved mouth line, no nose detail, no real human skin texture — hanging by a short loop of string or ribbon from the top, tilted slightly to one side as if swinging. Just ONE mask, not a pair of comedy/tragedy masks. Must read clearly as a costume/cosplay mask prop, not a real face, not a stationery item, not a pen or brush. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two masks, human face, portrait, pen, marker, paintbrush, pencil, multiple unrelated objects, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

## 出图后的处理管线（已跑通）

- **源图**：`art/ui/tabicons/tabicon_{roster,equip,skin}.webp`（白底黑线）。被否掉的中间版本存档在 `art/ui/tabicons/_rejected/`。
- **打包脚本**：[`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)。沿用 A 组 `pack_decos.cjs` 的"白底转透明"算法（`alpha = 255 - luminance`），额外做 B 组 `pack_labels.cjs` 那种"打包时覆盖 RGB 为目标色"——但**一张源图吐两份**：
  - `{name}_active.png`：RGB 覆盖为 `#ffffff`（白），配 active 页签的深色底（`C.dark` 0x2c2c2a）。
  - `{name}_inactive.png`：RGB 覆盖为 `#686868`（`C.mid`），配 inactive 页签的纸面底（`C.paper` 0xfaf6ee）。
  - 这是现有矢量图标"运行时 `tint` 换色"效果的静态替代——项目里没有"运行时 tint AI 位图"的先例，B 组的蓝/红两色也是打包时烘死成两份图，不是运行时换色，这里照抄同一手法。
- **产物**：`client/src/assets/tabicons/{roster,equip,skin}_{active,inactive}.png`（长边 128，透明底），已生成。
- **改图后重跑**：`node pack_tab_icons.cjs`（`JOBS` 数组按资产名/源文件名对应）。
- **验证方法**：小尺寸糊不糊靠肉眼猜不准，写了一次性 `sharp` contact-sheet 脚本，把打包产物按 28/32/40/64px 分别合成到深底/纸底背景上截图比对（脚本本身是一次性验证用，未留存）——v3 卡背包在此方法下才暴露出"糊成一团"，v4 才验证过关。

## 代码接线（已完成）

1. `icons.ts`：`IconKind` 新增 `'rosterIcon' | 'equipIcon' | 'skinIcon'`；`DRAW` 表类型收窄为 `Record<Exclude<IconKind, 这三个>, ...>`（这三个不走程序绘制，不需要 DRAW 条目）；`buildIcon()` 在分发给 `DRAW` 之前先查一张 `TAB_ICON_RASTER` 表，命中则返回一个按 `containScale` 居中缩放的 `PIXI.Sprite`（`color===0xffffff` 取 active 贴图，否则 inactive）；新增 `preloadTabIconTextures()`（复用 `assets/preloadTextures.ts` 的 `preloadTextureList`）供场景预热。
2. `CardScene.ts` / `EquipmentScene.ts` 构造函数：`this.render()` 之后 `void preloadTabIconTextures().then(() => this.render())`——纹理是 AI PNG（异步解码），首帧可能画不出来，预热完成后补一次 render 兜底（同 `ShopScene/card.ts` `artUrl` 贴图的 `baseTexture.valid` 处理思路，只是搬到了预热层而不是逐图标挂 `once('loaded')`，因为 `buildIcon()` 是给 30+ 调用点用的同步 API，不适合为这一个用例改成异步）。
3. `CardScene/list.ts` 三个 tab 的 `icon` 字段：`'cards'/'armor'/'brush'` → `'rosterIcon'/'equipIcon'/'skinIcon'`。
4. `EquipmentScene/inventory.ts` 两处（竖屏底栏 + 横屏侧栏）硬编码的 `icon: 'armor'`（"Equipment" 自己那个 tab）→ `'equipIcon'`。
5. `campaignRoster.ts` 的 `peerTab`（跳回卡背包）/`trailingPeers`（跳到皮肤）→ `'rosterIcon'`/`'skinIcon'`，保持装备页里看到的同一条 rail 跟卡背包页签本身用同一套图标。
6. `tsc --noEmit` 通过；`vitest --config vitest.ui.config.ts` 下 CardScene（6 个文件 23 个 test）+ EquipmentScene 相关（3 个文件 15 个 test）全部通过——这层是无渲染器的结构冒烟测试（二进制资源被桩成 1×1 透明 PNG），不是像素级视觉回归，能保证接线没有让场景崩掉，不能替代上面的 contact-sheet 小尺寸验证。

## 验收标准

- [x] 在 active（深底白线）和 inactive（纸底灰线）两种背景上单独看一眼都能认出是"卡/盾/面具"。
- [x] 缩到 28-32px（真实设备的常见尺寸，见上）依然不糊成色块。
- [x] 三张放一起风格统一（线宽、抖动幅度、细节密度接近）。
- [x] 上线观察后拍板：铺开第二批（见下）。

---

## 批次 2（2026-08-14 · 状态：判断+prompt 已定，等出图）

范围：`trophy`（3 义撞车）/ `book`（2 义撞车）/ `medal`（2 义撞车）/ `cards` 剩余复用点 / `brush` 剩余复用点，共 5 个槽位。逐个判断"复用现成 3 张图 vs 需要新概念"，结论如下。

### 判断结果总表

| 槽位 | 冲突方 | 处理 | 备注 |
|---|---|---|---|
| `trophy` | Career"成就"页签（`stats.achievements`） | **不动，保留 trophy** | 3 义里语义最贴的一个，留给它 |
| | 首页底栏"战绩"入口（`lobby.nav.stats`） | 新图 `statsTabIcon` | 见下 prompt |
| | 成就分类"进阶"（`progression`） | 新图 `progressTabIcon` | 见下 prompt |
| `book` | Career"统计"页签（`stats.title`） | **不动，保留 book** | |
| | 首页底栏"卡牌/养成"入口（`lobby.nav.cards`） | **复用 `rosterIcon`**（已接线） | 这个入口本来就是深链到 CardScene 的卡背包 tab，跟目标页共享同一张图，比新画一张更合理 |
| `medal` | 排行榜前三名奖牌（`LeaderboardScene`） | **不动，保留 medal** | 按名次染色（金/银/铜），"名次奖牌"是这个词最本分的含义 |
| | Career"称号"页签（`stats.titles`） | 新图 `honorTabIcon` | 见下 prompt。`TitlesScene.ts` 里"未收录称号兜底显示 medal"的那处**没有一并改**——那是称号墙内部单张称号卡的兜底图标，不是页签，且换了容易造成"点进称号 tab 看到新图标，墙上未知称号却是旧 medal"的不一致，留到称号系统本身要动的时候再看 |
| `cards` 剩余复用点 | Career"图鉴"（`collection.title`） | **复用 `rosterIcon`**（已接线） | 图鉴 = 角色卡合集，跟卡背包同一个"卡"概念 |
| | 拍卖筛选"卡牌"（主列表筛选条 `list.ts` + 建单选品 `itemPickerRender.ts` 两处） | **复用 `rosterIcon`**（已接线） | 同样是"这是一张角色卡"这个字面概念 |
| | 拍卖行"我的"tab（`list.ts` `mine`） | **不动，保留通用 `cards`** | 判断为不同概念——"我的挂单"包含卡/装备/材料/皮肤全部我的东西，不特指"卡"，硬套 `rosterIcon` 会在这个 tab 上出现一张具体的"战斗小人卡"图，反而制造新的语义偏差。留作未来"我的"专属图标的候选项，不在本批处理 |
| `brush` 剩余复用点 | 拍卖筛选"皮肤"（同上两处） | **复用 `skinIcon`**（已接线） | 字面"这是一件皮肤"概念 |
| | 成就分类"收藏"（`collection`） | 新图 `collectionTabIcon` | 见下 prompt；这个含义是"收藏/收集进度"（集齐N张卡/N款皮肤这类成就），不是"皮肤"本身，`skinIcon` 的戏剧面具在这里语义不对 |

**没有一并处理的相邻点**（同一批判断时顺手确认过，判定为超出"页签图标"范围，不动）：`itemLabels.ts` 的 `itemKind()` 本身（`card`→`cards`/`skin`→`brush`）保持不变，它同时喂给拍卖行的"单条挂单内容小图标"（`list.ts:417`）和建单表单的"品类小图标"（`createListing.ts:100`），这两处是内容态小徽标不是导航页签，没有验证过缩放到极小尺寸的效果，不在这批范围内；筛选条本身通过一个局部覆盖表（`FILTER_ICON_OVERRIDE`/`itemPickerRender.ts` 的 `icons` 表)单独指向新图标，不改 `itemKind()` 这个共享函数，两边互不影响。

### 已接线的纯复用改动（无需新图，已完成）

代码：[`CareerTabs.ts`](../../client/src/ui/widgets/CareerTabs.ts)（`collection.title` → `rosterIcon`）、[`LobbyScene/bottomNav.ts`](../../client/src/scenes/LobbyScene/bottomNav.ts)（`lobby.nav.cards` → `rosterIcon`）、[`AuctionScene/itemPickerRender.ts`](../../client/src/scenes/AuctionScene/itemPickerRender.ts)（筛选条 `icons` 表：`card`→`rosterIcon`、`skin`→`skinIcon`）、[`AuctionScene/list.ts`](../../client/src/scenes/AuctionScene/list.ts)（新增 `FILTER_ICON_OVERRIDE` 局部表，同样覆盖主筛选条的 `card`/`skin`）。`tsc --noEmit` 通过；`vitest --config vitest.ui.config.ts` 全量 181 文件 1629 用例通过。

### 待出图（4 张新概念，草案 prompt）

延续批次 1 的共用骨架（"手绘涂鸦、单色墨线、粗糙抖动笔触、单一大剪影、纯白底、缩到 32px 仍可辨"），四张互相之间也要避免撞视觉语言——尤其 `statsTabIcon`(柱状图) 与 `progressTabIcon`(箭头阶梯) 这两个"向上"母题在导航路径上是父子关系（首页"战绩"→成就墙"进阶"分类），必须一眼区分开；`honorTabIcon`(桂冠) 特意选了不同于圆形奖牌的开口造型，避免跟 `medal` 挤在同一堆"奖章"语言里；`collectionTabIcon`(拼图块) 特意避开本来就在同一个成就分类条上的 `book`(pve) 造型。

#### 战绩入口（`statsTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a simple bar chart — three solid vertical bars of ascending height side by side, evenly spaced, no baseline, no axis lines, no numbers, no grid. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, pie chart, line graph with dots, upward arrow, trophy, coins, money bag, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 成就分类·进阶（`progressTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: three upward-pointing chevron arrows (like stacked ^ ^ ^ shapes) stacked vertically with a small even gap between each, all the same size, all pointing straight up — a rank-up/level-up insignia. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, single arrow, circular badge, star shape, bar chart, crown, wings, multiple unrelated objects, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

#### Career·称号（`honorTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a simple laurel wreath — two curved leafy branches meeting and slightly overlapping at the bottom, open at the top (NOT a closed circle/ring), a few small simple leaf notches along each branch, symmetrical left-right. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, closed circular medal disc, round badge, hanging ribbon tails, crown, human face, text or letters inside the wreath, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

#### 成就分类·收藏（`collectionTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single chunky jigsaw puzzle piece — one classic interlocking puzzle piece shape with one rounded tab knob sticking out on one edge and one rounded socket notch cut into an adjacent edge, roughly square overall. Just ONE puzzle piece, not a pair or a grid of pieces. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, multiple puzzle pieces, puzzle grid, open book shape, gear/cog shape, other objects, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

### 出图后的下一步（沿用批次 1 管线，尚未执行）

1. 用户拿 4 条 prompt 跑 GPT Image 2，白底黑线图丢进 `art/ui/tabicons/`（文件名建议 `tabicon_stats.webp` / `tabicon_progress.webp` / `tabicon_honor.webp` / `tabicon_collection.webp`，跟批次 1 的 `tabicon_{roster,equip,skin}` 命名对齐）。
2. 扩 [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) 的 `JOBS` 数组，跑 `node pack_tab_icons.cjs` 产出 `{name}_active/inactive.png` 到 `client/src/assets/tabicons/`。
3. 小尺寸验证（28/32/40/64px contact sheet，深底/纸底两种背景）——尤其 `statsTabIcon`/`progressTabIcon` 这对要重点看它们放在一起是否真的分得清，不能只各自单独过关。
4. `icons.ts`：`IconKind` 新增 `'statsTabIcon' | 'progressTabIcon' | 'honorTabIcon' | 'collectionTabIcon'`，`TAB_ICON_RASTER` 表新增 4 条。
5. 接线：`LobbyScene/bottomNav.ts`（`lobby.nav.stats` → `statsTabIcon`）、`AchievementScene.ts`（`CATEGORY_ICON.progression` → `progressTabIcon`、`CATEGORY_ICON.collection` → `collectionTabIcon`）、`CareerTabs.ts`（`stats.titles` → `honorTabIcon`）。
6. `tsc --noEmit` + `vitest --config vitest.ui.config.ts` 全量回归。
7. 更新本文档"批次 2"状态 + `art-direction.md` §7.6，提交。
