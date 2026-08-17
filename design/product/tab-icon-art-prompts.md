# 页签主图标 AI 化 — 试点 Prompt 文档

> 创建：2026-08-14 · 试点批定稿+接线：2026-08-14 · 批次 2 判断+prompt 定稿：2026-08-14 · 批次 2 出图+接线完成：2026-08-15 · 批次 3 判断+prompt 定稿：2026-08-15
> 配套代码：[`client/src/render/icons.ts`](../../client/src/render/icons.ts)（`rosterIcon`/`equipIcon`/`skinIcon` 三个新 `IconKind`）· [`client/src/scenes/CardScene/list.ts`](../../client/src/scenes/CardScene/list.ts) · [`client/src/scenes/EquipmentScene/inventory.ts`](../../client/src/scenes/EquipmentScene/inventory.ts) · [`client/src/app/nav/game/campaignRoster.ts`](../../client/src/app/nav/game/campaignRoster.ts)
> 美术总纲：[`art-direction.md`](art-direction.md) §0（资产分工）/ §6.2（装饰物涂鸦管线，本文档打包脚本沿用其"抠白底"套路）/ §7.6（本次试点的记录条目）
> 同类文档：[`shop-art-prompts.md`](shop-art-prompts.md) · [`gacha-art-prompts.md`](gacha-art-prompts.md)
> 状态：**试点批（3/15）已定稿并接线**；**批次 2（trophy/book/medal/cards/brush 5 个复用槽位）已全部完成**；**批次 3（铺开剩余 12 个页签主图标，判断+prompt 已定，等出图）**——详见下方"批次 3"一节
> **批次 5 在单独文件**：[`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md) —— 页面**标题**图标（本文档四批从未覆盖过的位置）+ 剩余二级页签，24 张新图，代码出口已先行落地。本文档保持 1–4 批的记录不动（500 行文档约定，ADR-067）。

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

1. `icons.ts`：`IconKind` 新增 `'rosterIcon' | 'equipIcon' | 'skinIcon'`；`DRAW` 表类型收窄为 `Record<Exclude<IconKind, 这三个>, ...>`（这三个不走程序绘制，不需要 DRAW 条目）；`buildIcon()` 在分发给 `DRAW` 之前先查一张 `TAB_ICON_RASTER` 表，命中则返回一个按 `containScale` 居中缩放的 `PIXI.Sprite`（调用方传的 `color` 只当作"底色深浅"的提示：浅色墨水取 active 白线图，否则取 inactive 灰线图；2026-08-15 起是亮度阈值判断，不再是 `color===0xffffff` 严格相等，原因见文末"批次 3 收尾修复"）；新增 `preloadTabIconTextures()`（复用 `assets/preloadTextures.ts` 的 `preloadTextureList`）供场景预热。
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

### 出图后的管线（已跑通，2026-08-15）

用户用 4 条 prompt 跑 GPT Image 2 出图，文件名分别对应 `tabicon_stats.webp`（bar_chart_doodle_icon）/ `tabicon_progress.webp`（rank-up-doodle-icon-final）/ `tabicon_honor.webp`（laurel_wreath_doodle）/ `tabicon_collection.webp`（puzzle_doodle_icon），一次通过、没有反复：

1. 源图丢进 `art/ui/tabicons/`，[`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) 的 `JOBS` 数组新增 4 条，跑 `node pack_tab_icons.cjs` 产出 `{stats,progress,honor,collection}_{active,inactive}.png` 到 `client/src/assets/tabicons/`。
2. 小尺寸验证：一次性 `sharp` contact-sheet 脚本（同批次 1 手法，未留存），28/32/40/64px 分别合成到 `C.dark`(0x2c2c2a)/`C.paper`(0xfaf6ee) 背景上截图比对。**四张全部一次过关**——`statsTabIcon`(柱状图)/`progressTabIcon`(箭头阶梯) 在 28px 依然清晰且互相不混淆；`honorTabIcon`(桂冠) 虽然是四张里细节密度最高的一张，缩到 28px 仍能读出"花环"轮廓，没有像试点批 v3 卡背包那样糊成一团；`collectionTabIcon`(拼图块) 线条比同批的柱状图/箭头明显更细（outline 而非实心剪影），跟试点批 `equipIcon`/`skinIcon` 也是细线 outline、`rosterIcon` 是实心剪影的粗细混搭先例一致，判断不算新问题，未要求重出。
3. `icons.ts`：`IconKind` 新增 `'statsTabIcon' | 'progressTabIcon' | 'honorTabIcon' | 'collectionTabIcon'`；新增 `RasterIconKind` 联合类型统一给 `TAB_ICON_RASTER`/`DrawableIconKind` 的 `Exclude` 复用（现在是 7 个光栅图标，不再各处手写重复的联合）。
4. 接线：`LobbyScene/bottomNav.ts`（`lobby.nav.stats` → `statsTabIcon`）、`AchievementScene.ts`（`CATEGORY_ICON.progression` → `progressTabIcon`、`CATEGORY_ICON.collection` → `collectionTabIcon`）、`CareerTabs.ts`（`stats.titles` → `honorTabIcon`）。
5. `tsc --noEmit` 通过；`vitest --config vitest.ui.config.ts` 全量 181 文件 1629 用例通过。

### 状态：批次 2 全部完成 ✅

5 个复用槽位（trophy/book/medal/cards/brush）全部处理完毕：3 个纯复用接线 + 4 张新图出图/打包/验证/接线，均已落地。

---

## 批次 3（2026-08-15 · 状态：判断+prompt 已定，等出图）

铺开试点批文档一直提的"剩下的页签图标"：把 `icons.ts` 的 `IconKind` 列表和 `HubTabs`/`CareerTabs`/底部导航/`AchievementScene`分类条/`AuctionScene`筛选条的接线点全部过一遍（结算页动作按钮、装备强化按钮、头像底色、内容态数值徽标这些不算"页签"，排除在外），确认还有 **12 个页签级图标仍是 `SketchPen` 程序绘制**。逐个判断复用 vs 新概念，结论如下。

### 判断结果总表

| 槽位 | 位置 | 处理 | 备注 |
|---|---|---|---|
| `armor` | 拍卖筛选"装备"（`itemPickerRender.ts`） | **纯复用，直接接线为 `equipIcon`** | 跟批次 2 里 cards/brush 复用 rosterIcon/skinIcon 是同一道理——字面就是"这是装备"，不需要新概念、不需要新出图 |
| `book` | Career"统计"页签（`stats.title`） | **纯复用，直接接线为 `statsTabIcon`** | 查代码确认 `lobby.nav.stats` 底部导航按钮就是深链到这同一个"统计"页签（`nav.goStats()` → `StatsScene`，跟 `CareerTabs.stats.title` 同一个目的地），不是勉强套用，是本来就同一个东西，跟"首页养成入口复用 rosterIcon"同一模式。这样 book 的 2 义冲突（批次 2 只判断了 Career统计/首页卡牌入口 2 义，漏了下面这第 3 义）就只剩下面 `pve` 分类那一边需要新概念 |
| `book` | 成就墙"pve"分类（`AchievementScene.ts` `CATEGORY_ICON.pve`） | **新图 `pveTabIcon`** | 批次 2 判断表遗漏的第 3 个 book 用法。book 让给"统计"义（上面已复用），这里跳出"书"这条线，改走"藏宝图"——PvE 关卡=闯关地图，跟 pvp 分类的交叉剑（下面）、其余分类图标（进阶=箭头阶梯/收藏=拼图块）都不撞 |
| `trophy` | Career"成就"页签（`stats.achievements`） | **新图 `achievementTabIcon`**，正式转 AI | 批次 2 判断"3 义里最贴的一个，留给它、继续用程序图标"；这次批次 3 是系统性铺开，顺带发现这不是 3 义而是 4 义（漏了下面这条），干脆把 achievements 也转成 AI 图，彻底了结冲突而不是再拖一次 |
| `trophy` | Shop组hub"通行证"tab（`battlepass.title`，4 个场景文件共享同一条 tab 定义：`GachaScene/page.ts`/`RechargeScene.ts`/`BattlePassScene/nav.ts`/`ShopScene/core.ts`） | **新图 `battlepassTabIcon`** | 批次 2 判断表完全没算到这个用法——trophy 实际上是 4 义不是 3 义。战令跟"成就"是不同概念（战令=订阅制通行证，成就=荣誉奖杯），造型走"门票"，避免跟 `achievementTabIcon`(奖杯)/`honorTabIcon`(桂冠，称号用)/`medal`(圆形奖牌) 挤在同一堆"奖章/荣誉"语言里 |
| `tag` | Shop组hub"商店"tab（同上 4 文件共享） | **新图 `shopTabIcon`** | 单一含义，纯粹辨识度升级 |
| `tag` | 拍卖"全部"筛选（`list.ts` `all`） | **复用同一张 `shopTabIcon`** | 跟上面商店 tab 字面同一个"价签"概念，两处不同屏，参照批次 1/2 的复用模式一并接线，不单独出图 |
| `coin` | Shop组hub"金币直充"tab | **新图 `coinTabIcon`** | 单一含义，纯粹辨识度升级 |
| `capsule` | Shop组hub"扭蛋"tab | **新图 `gachaTabIcon`** | 同上 |
| `coinChest` | Shop组hub"充值"tab | **新图 `rechargeTabIcon`** | 同上 |
| `home` | 底部导航"首页" | **新图 `homeTabIcon`** | 同上 |
| `globe` | 底部导航"社交" | **新图 `socialTabIcon`** | 同上 |
| `swords` | 成就墙"pvp"分类 | **新图 `pvpTabIcon`** | 同上 |
| `hammer` | 拍卖"我的出价"tab（`list.ts` `bids`） | **新图 `bidTabIcon`** | 同上 |
| `scrap` | 拍卖筛选"材料" | **新图 `materialTabIcon`** | 同上 |

**没有一并处理的相邻点**（判断时顺手确认过，判定不在这批范围）：`atk`/`hp`/`spd`/`atkspd`/`armorHeavy`/`lock`/`star`/`zoom`/`gift`/`flag`/`desk`/`cabinet`/`hourglass*`/`titleXxx` 系列/`close`/`check`/`play` 这些要么是内容态数值徽标（装备属性、结算奖励行），要么是动作按钮（结算页操作、装备强化/卸下），要么是头像底色装饰——不是导航页签，不在"页签主图标"范围内，维持程序绘制。

批次 3 落地后，`trophy`/`book`/`armor`/`swords`/`hammer`/`scrap`/`tag`/`coin`/`capsule`/`coinChest`/`home`/`globe` 这些 `SketchPen` 常量仍然保留在 `DRAW` 表里——只是不再有任何**页签**指向它们，全部改指向对应的新光栅 `IconKind`；这些常量继续服务于头像底色、结算页动作按钮/奖励行、装备属性显示、GachaScene 稀有度标记等非页签场景。

### 待出图（12 张新概念，草案 prompt）

延续前两批的共用骨架（手绘涂鸦、单色墨线、粗糙抖动笔触、单一大剪影、纯白底、缩到 32px 仍可辨）。互相之间刻意避让：`pveTabIcon`(藏宝图) 不画成书/册页避免撞回 `book`；`achievementTabIcon`(奖杯) / `battlepassTabIcon`(门票) / `honorTabIcon`(桂冠，已有) / `medal`(圆牌，程序绘制) 四者要在同一堆"荣誉类"视觉里各自留出辨识空间——奖杯保留最经典的双耳杯身，门票是矩形+虚线撕口，都不画成圆形奖章或桂冠。

#### 商店入口（`shopTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single classic price tag — a rounded-corner tag shape with one small circular hole punched near the top and a short loop of string threaded through the hole, hanging at a slight tilt. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, shopping bag, shopping cart, storefront or awning, dollar sign, percent sign, multiple tags, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 金币直充（`coinTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single thick coin seen face-on — a bold circle outline with one plain concentric inner circle (embossed rim) inside it, nothing engraved on the face. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, dollar sign or any currency symbol, stack of coins, piggy bank, coin slot, sparkle marks, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 扭蛋（`gachaTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single round gashapon capsule toy — a circle divided by one horizontal line straight across the middle into a top half and a bottom half, like a vending-machine capsule. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, vending machine body, multiple capsules, egg shape, stars or sparkles, closed solid circle with no dividing line, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 充值（`rechargeTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single closed treasure chest seen from the front — a rectangular body with a curved arched lid on top and one small latch or lock detail at the front center. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, open lid with gold/contents spilling out, coins scattered around it, sparkle marks, separate hanging padlock shape, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 底部导航·首页（`homeTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single simple house — a triangular roof sitting on a square body, with one small rectangular doorway notch cut into the bottom center, no windows. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, chimney, window details, door handle, tree or landscape elements, turret or castle-like crenellations, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 底部导航·社交（`socialTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single globe — a circle outline with one horizontal curved line and one vertical curved line crossing through the middle like a simple latitude/longitude grid, evoking a world globe. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, continents or landmasses drawn on the surface, stand or base underneath, speech-bubble shape, multiple circles, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 成就墙·pvp分类（`pvpTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: two simple swords crossed in an X shape, each with a straight blade and one small crossguard, meeting at the center. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, single sword, shield behind the swords, spark or impact marks at the crossing point, scabbard, more than two weapons, multiple objects, scattered pieces, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

#### 拍卖·我的出价（`bidTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single auction gavel — a cylindrical mallet head with a short handle, resting at a slight diagonal angle, no sound block or striking plate beneath it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, sound block or striking plate, judge's robe or a hand holding it, claw hammer / carpenter's tool look, multiple gavels, multiple objects, scattered pieces, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

#### 拍卖·材料筛选（`materialTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single curled pencil shaving — one continuous spiral ribbon curl, like a peeled pencil-sharpener shaving, tapering at both ends. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, the pencil itself, a sharpener body, multiple shavings or a pile, sawdust dots, straight uncurled strip, multiple objects, scattered pieces, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

#### Career·成就（`achievementTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single classic trophy cup — a wide cup bowl with two curved side handles, sitting on a short stem and a small round base, nothing engraved on the cup. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, star or laurel decoration on the cup, confetti or sparkle marks, ribbon or medal hanging from it, multiple trophies, text or numbers on the base, watermark, gray background, notebook grid lines, drop shadow.
```

#### Shop组hub·通行证（`battlepassTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single rectangular admission ticket, oriented horizontally, with one vertical dashed perforation line dividing it into a larger main section and a smaller stub, and one small round punch-hole near the stub edge. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, circular medal or disc shape, wristband or lanyard, star or trophy shapes, multiple tickets, text or numbers printed on the ticket, watermark, gray background, notebook grid lines, drop shadow.
```

#### 成就墙·pve分类（`pveTabIcon`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: a single rolled parchment scroll, partly unrolled to reveal a short dotted path line ending in a small X mark, like a simplified treasure map — rolled tube ends on the left and right, a flat unrolled section in the middle showing the path. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading or only light pencil hatching for volume. Must stay clearly recognizable when scaled down to 32x32 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, closed book or book-with-pages shape, flag or castle drawn on the map, sword or crossed swords, compass rose, text or numbers on the map, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 出图后的流程（沿用批次 1/2，等图片）

1. 用户跑 12 条 prompt，源图丢进 `art/ui/tabicons/`（命名建议 `tabicon_{shop,coin,gacha,recharge,home,social,pvp,bid,material,achievement,battlepass,pve}.webp`）。
2. [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) 的 `JOBS` 数组新增 12 条，跑 `node pack_tab_icons.cjs`。
3. 一次性 `sharp` contact-sheet 脚本，28/32/40/64px 分别合成到 `C.dark`/`C.paper` 背景上截图比对（同前两批手法）。
4. `icons.ts`：`IconKind`/`RasterIconKind` 新增 12 个；`TAB_ICON_RASTER` 补对应条目。
5. 接线：
   - `GachaScene/page.ts` / `RechargeScene.ts` / `BattlePassScene/nav.ts` / `ShopScene/core.ts` 四处共享的 shop-group tab 定义：`tag`→`shopTabIcon`、`coin`→`coinTabIcon`、`capsule`→`gachaTabIcon`、`trophy`(battlepass)→`battlepassTabIcon`、`coinChest`→`rechargeTabIcon`。
   - `LobbyScene/bottomNav.ts`：`home`→`homeTabIcon`、`globe`→`socialTabIcon`。
   - `CareerTabs.ts`：`book`(stats.title)→`statsTabIcon`（纯复用）、`trophy`(achievements)→`achievementTabIcon`。
   - `AchievementScene.ts` `CATEGORY_ICON`：`pve: 'book'`→`'pveTabIcon'`、`pvp: 'swords'`→`'pvpTabIcon'`。
   - `AuctionScene/itemPickerRender.ts`：`equipment: 'armor'`→`'equipIcon'`（纯复用）、`material: 'scrap'`→`'materialTabIcon'`。
   - `AuctionScene/list.ts`：`all: 'tag'`→`'shopTabIcon'`（纯复用）、`bids: 'hammer'`→`'bidTabIcon'`。
6. `tsc --noEmit` + `vitest --config vitest.ui.config.ts` 全量跑一遍。
7. 更新本文档"批次 3"状态 + `art-direction.md` §7.6。

### 出图后验证（2026-08-15，第一轮：12 张出图，9 过 3 打回）

用户跑完 12 条 prompt 一次性交了图。沿用批次 1/2 的手法（`pack_tab_icons.cjs` 的抠白底+染色算法，一次性 `sharp` 脚本合成到 28/32/40/64px、`C.dark`/`C.paper` 背景，未留存）逐张验证，结果 **9 过 3 打回**：

- **过关（9 张）**：`shopTabIcon`(价签)、`coinTabIcon`(硬币)、`gachaTabIcon`(扭蛋)、`homeTabIcon`(房子)、`pvpTabIcon`(交叉剑)、`bidTabIcon`(拍卖锤)、`battlepassTabIcon`(门票)、`achievementTabIcon`(奖杯)、`pveTabIcon`(藏宝图) —— 28px 下轮廓清楚，予以采用。
- **打回重出（3 张）**：

| IconKind | 问题 | 28px 实际效果 |
|---|---|---|
| `rechargeTabIcon`(充值/宝箱) | 箱身画满木纹平行线，密度超标 | 缩小后箱体细节糊成一团模糊噪点，箱盖弧线和锁扣快看不清——批次 1 卡背包 v3 那个"细节太密糊成一团"的坑又踩了一次 |
| `socialTabIcon`(社交/地球) | prompt 要"经纬线弯曲"，出图给的是两条近乎笔直的线（一竖一横） | 缩小后是"圆+十字"，读成准星/靶心，不读"地球/世界"——不是糊，是语义读错 |
| `materialTabIcon`(材料/铅笔屑) | 螺旋边缘画成锯齿状，中间加了一圈放射状短线（像"太阳芒"） | 缩小后整个变成一团模糊毛边圆点，完全看不出是螺旋卷屑——这批里最严重的一个 |

3 张的 v2 prompt（收紧了具体导致糊/读错的元素——充值去掉全部木纹线只留外轮廓+锁；社交把"弯曲"要求写死成"必须明显鼓起、不能是直线"；材料把锯齿边缘和放射短线明确列进 avoid）：

#### 充值（`rechargeTabIcon`，v2）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces, no wood-grain texture lines. Subject: a single closed treasure chest seen from the front — a rectangular body with a curved arched lid on top, ONE single horizontal line where the lid meets the body, and one clearly bold keyhole-lock shape at the front center. No plank divisions, no wood-grain hatching, no parallel texture lines anywhere on the body or lid — just the plain outer silhouette and the one lock shape. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward too plain rather than too detailed. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, wood-grain lines, plank seams, multiple horizontal bands, sparkle marks, multiple objects, scattered pieces, confetti dots, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 社交（`socialTabIcon`，v2）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single globe — a circle outline, with one horizontal line straight across the middle (the equator), and two vertical lines that each bow outward into a distinct lens/almond curve (NOT straight lines) — like the curved meridian lines on a world map, clearly bulging left and right, touching the circle only at top and bottom. The curve must be obvious and pronounced, not subtle. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as a world globe (not a crosshair or target) when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, straight vertical line, crosshair or target look, continents drawn on the surface, stand or base underneath, multiple circles, text, letters, numbers, watermark, gray background, notebook grid lines, drop shadow.
```

#### 材料（`materialTabIcon`，v2）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces, no radiating lines, no sunburst pattern. Subject: a single curled pencil shaving — one continuous spiral ribbon curl with SMOOTH curved edges (NOT jagged, NOT zigzag, NOT sawtooth), like a peeled pencil-sharpener shaving, tapering smoothly at both ends. The outline itself should be the only linework — no internal texture lines, no radiating short marks, no hatching of any kind inside or around the curl. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as a smooth curl when scaled down to 28x28 pixels — err toward too plain rather than too detailed. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, jagged/zigzag/sawtooth edges, radiating hatch lines, sunburst pattern, the pencil itself, a sharpener body, multiple shavings, sawdust dots, straight uncurled strip, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

用户已确认节奏：不分批打包，等这 3 张 v2 也出好、12 张齐了再一起打包+验证+接线。

### 第二轮验证 + 接线（2026-08-15，全部完成 ✅）

3 张 v2 图交回来，同样用 contact-sheet 方法（28/32/40/64px、`C.dark`/`C.paper`）验证，**全部过关**：

- `rechargeTabIcon` v2：去掉木纹线后箱体轮廓+锁孔干净利落，28px 依然认得出锁孔。
- `socialTabIcon` v2：经纬线真弯了，读"地球"不读"准星"。
- `materialTabIcon` v2：光滑螺旋卷，没有锯齿也没有放射线，缩小后仍是清楚的卷曲形状。

被打回的 v1 版本存档到 `art/ui/tabicons/_rejected/`（`tabicon_recharge_v1_woodgrain.webp`/`tabicon_social_v1_crosshair.webp`/`tabicon_material_v1_jagged.webp`）。12 张源图归位为 `tabicon_{shop,coin,gacha,recharge,home,social,pvp,bid,material,achievement,battlepass,pve}.webp`。

**接线（已完成）**：
1. [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) `JOBS` 新增 12 条，跑 `node pack_tab_icons.cjs` 产出 24 张 PNG（`client/src/assets/tabicons/`），现在总共 38 张（19 个光栅 `IconKind` × 2）。
2. `icons.ts`：`IconKind`/`RasterIconKind`/`TAB_ICON_RASTER` 新增 12 个条目；`preloadTabIconTextures()` 注释同步改成 38 张。
3. 逐点接线：
   - `GachaScene/page.ts`/`RechargeScene.ts`/`BattlePassScene/nav.ts`/`ShopScene/core.ts` 四处共享的 shop-group tab：`tag`→`shopTabIcon`、`coin`→`coinTabIcon`、`capsule`→`gachaTabIcon`、`trophy`(battlepass)→`battlepassTabIcon`、`coinChest`→`rechargeTabIcon`。
   - `LobbyScene/bottomNav.ts`：`home`→`homeTabIcon`、`globe`→`socialTabIcon`、`lobby.nav.shop`(`coin`)→`gachaTabIcon`（同日跟进，见下）。
   - `CareerTabs.ts`：`book`(stats.title)→`statsTabIcon`（纯复用，代码确认深链同一个 `StatsScene`）、`trophy`(achievements)→`achievementTabIcon`（正式转 AI）。
   - `AchievementScene.ts` `CATEGORY_ICON`：`pve: 'book'`→`'pveTabIcon'`、`pvp: 'swords'`→`'pvpTabIcon'`。
   - `AuctionScene/itemPickerRender.ts`：`equipment: 'armor'`→`'equipIcon'`（纯复用）、`material: 'scrap'`→`'materialTabIcon'`。
   - `AuctionScene/list.ts`：`all: 'tag'`→`'shopTabIcon'`（纯复用）、`bids: 'hammer'`→`'bidTabIcon'`（`mine` 维持通用 `cards`，批次 2 已判断过不动）。
4. `tsc --noEmit` 通过；`vitest --config vitest.ui.config.ts` 全量 181 文件 1629 用例通过。
5. 游戏内截图验证本次跳过——没有起后端服务（bootstrap 失败），Browser 面板当时也没在客户端那边显示，截图请求超时。风险最高的点（缩小后会不会糊）已经用跟批次 1/2 完全一致的 contact-sheet 像素级方法过了一遍，比启动整个游戏点开各个 tab 更能验证这件事。

**遗留发现，已同日处理**：梳理 `LobbyScene/bottomNav.ts` 时发现 `lobby.nav.shop`（底部导航"商店"按钮）当前用的是程序绘制的 `coin` 图标，点进去实际深链到的是 `GachaScene`（`nav.goGacha()`），而 `app/nav/shop/nav.ts` 的 `goGacha()` 确认 GachaScene 分组永远以 `'gacha.title'` 为激活 tab（不是"商店"）——按这批里 `lobby.nav.cards`→`rosterIcon`/`lobby.nav.stats`→`statsTabIcon` 的"深链复用"逻辑，改为复用 `gachaTabIcon`。`tsc --noEmit` + 全量 `vitest` 通过。

### 状态：批次 3 全部完成 ✅

12 个页签图标（10 个纯辨识度升级 + 2 个了结 trophy/book 遗留冲突）全部出图、验证、接线完毕，另有 2 处（`armor`→`equipIcon`、`book`→`statsTabIcon`）确认为纯复用无需新图。

---

## 批次 3 收尾修复：深色底选错贴图（2026-08-15）

**现象**：用户反馈主页底部导航"养成/商城"两个新图标几乎看不清（"生涯"的实心柱状图、"社交"的粗线地球勉强能看，线条最细的 roster 卡牌 / gacha 扭蛋球彻底糊进底色）。

**根因**：`buildRasterTabIcon()` 原本用 `color === 0xffffff` 严格相等来选贴图变体，但只有 HubTabs 的 active 格子恰好传 `0xffffff`。`LobbyScene/bottomNav.ts` 的非激活槽位传的是 `C.light`（0xdddddd），落进 else 分支拿到**纸底用的 `#686868` 灰线图**，而这条底栏填的是 `C.cover`（0x3a352f，近黑）——灰线画在近黑底上，再叠 0.72 alpha，等于隐形。这不是资源问题（图本身没错），也不是"AI 图太细"，是变体选择的判定条件太窄。批次 3 那次"游戏内截图验证跳过"（见上一节第 5 条）正好漏掉的就是这一类问题：contact-sheet 只验证了"图在正确的底色上糊不糊"，验证不了"代码有没有挑到正确的那张图"。

**修复**：
1. `icons.ts`：新增 `isLightInk(color)`（Rec.601 亮度，阈值 0.70），`buildRasterTabIcon()` 改为按它选变体——调用方传的 ink 颜色被解读为"我这块底是深是浅"的提示。`C.light`(0xdddddd)/`0xffffff` 过阈值取白线图；HubTabs 非激活格的 `C.mid`(0x888888, 亮度 ≈0.53) 不过阈值，仍取纸底灰线图，行为不变。
2. `LobbyScene/bottomNav.ts`：五个槽位（含 disabled）统一用浅色 ink，状态差异只由 alpha 表达（active 1.0 / 普通 0.85 / disabled 0.35）——原来 disabled 传 `C.mid` 同样会在深色底上消失。非激活 alpha 从 0.72 提到 0.85。
3. 顺带修好同一个 bug 的第二处：`AuctionScene/list.ts` 的分类 chip，激活态是 `C.dark` 填充 + `C.light` 墨水，此前同样拿到灰线图画在深底上。


**验证**：`tsc --noEmit` 通过；Playwright（`start:e2e` 9096 + `window.__nwE2E.views.showLobby()`）实拍底栏截图确认五个图标全部清晰可辨——这次没有再跳过截图。

**回归测试**（两层，都确认过把 `tabIconVariant` 改回旧的严格相等判断就会红）：
- `test/render/icons.test.ts` → `describe('tabIconVariant …')`：把阈值从两侧钉死。列出每个真实调用点传的墨水色（HubTabs 激活 `0xffffff` / 底栏 `C.light` / 拍卖 chip 的 `C.light`+`C.dark` / HubTabs 非激活 `ui.mid` 0x686868）各自该取哪张图，再加一条"≤0x888888 的灰一律取纸底图"的单调性检查——阈值放宽会让纸面页签白线画白底，收紧就是这次的深底 bug 复发。
- `test/ui/lobbyBottomNavIconInk.ui.ts`：补另一半——**调用点实际传了什么**，这是任何针对 helper 的单元测试都看不见的部分。`vi.mock` 包一层 `buildIcon`（保留真实实现，只记录入参），构造真实 `LobbyScene`，断言五个槽位（在线 + 离线两种模式）传的墨水都解析到白线图。断言的是"解析出的变体"而不是具体色值，这样它是一条可读性契约：任何仍然读作"深底白线"的颜色都放行，而把槽位悄悄调暗的调色改动会红。
- UI 全量套件 185 文件 1649 用例通过。



---

## 批次 4：奖励图标统一出处（2026-08-15，无新出图）

> ⚠️ 本节 2026-08-15 写过一次，但在合并进当日分支时被自己的冲突解决脚本整段吞掉了——脚本里用 `indexOf('\n---\n\n## 批次 4')` 定位要保留的片段，而这个文件是 **CRLF** 行尾，`\n---\n` 永远匹配不上，`indexOf` 返回 -1，`slice(-1)` 只留下最后一个字符，无声地丢了整节。2026-08-16 补回。教训：在这个仓库里对文件内容做 `indexOf`/正则切片，一律用 `\r?\n`，别假设 `\n`。

**起因**：用户截图圈出"周常宝箱"tab 的第 2/3 档奖励图标——"这里的图标还是用的旧的程序绘制的，我反复强调所有的图标走统一出处"。截图里同一个 tab 上，第 1 档的材料（铅笔芯）是 AI 位图，第 2/3 档的装备/卡牌却是细线程序 glyph（`armor`/`cards`），并排放着一眼看得出两套画法。

**为什么前三批漏了它**：批次 3 的梳理范围写死在"页签级图标"，开头就明确排除了"结算页动作按钮、装备强化/分解按钮、头像背景 glyph、属性徽章"——奖励行也在这条排除线的另一侧，从来没被点名过。

**根因不是"少接一处线"，是没有出口**。奖励行出现在 6 个互不相干的屏幕上，每个屏幕自己手写一张 `kind → IconKind` 表：

| 屏幕 | coins | material | card | equipment | skin |
|---|---|---|---|---|---|
| `DailyScene/panels.ts`（签到日历 + 周常宝箱） | ✗ `buildIcon('coin')` | ✓ `buildMaterialIcon` | ✗ `cards` | ✗ `armor` | ✗ `brush` |
| `BattlePassScene/cell.ts` | ✓ `buildCoinIcon` | ✓ | — | — | ✗ `brush` |
| `EventScene.ts` | ✗ `buildIcon('coin')` | ✓ | — | — | ✗ `brush` |
| `RechargeScene.ts` | ✓ | ✓ | — | — | — |
| `FriendsScene/mail.ts`（附件缩略图） | ✗ `buildIcon('coins')` | ✓ | ✓ 真卡图 | ✓ `buildEquipIcon` | ✗ `brush` |
| `AchievementScene.ts`（成就奖励币） | ✗ `buildIcon('coin')` | — | — | — | — |

`coins`/`material` 各自早就有统一出口，但**没人负责 `card`/`equipment`/`skin`**，于是它们一直躺在程序 glyph 上——即便批次 1 出的 `rosterIcon`/`equipIcon`/`skinIcon` 正是这三个概念的 AI 图。另外 `buildCoinIcon` 明明存在，还是有 4 处直接调了 `buildIcon('coin')`，这也说明"靠每个调用点自己记得挑对函数"这条路本身就不成立。

**修法：新增第四个统一出口，而不是逐屏替换。** `client/src/render/rewardIcon.ts`：

```ts
buildRewardIcon(reward: {kind, id?, count?}, size, color, opts?) : DisplayObject | null
  coins     → buildCoinIcon(opts.coinKind ?? coinIconTier(count))   // AI 金币图集
  material  → buildMaterialIcon(materialKind(id) ?? 'scrap')        // AI 材料图集
  card      → buildIcon('rosterIcon', …, { variant })  ┐
  equipment → buildIcon('equipIcon',  …, { variant })  ├ 批次 1 的 AI 页签图，纯复用（同批次 2/3
  skin      → buildIcon('skinIcon',   …, { variant })  ┘ 的复用判据：同一个概念就不再出新图）
  stamina / 未知 kind → null（调用方画纯 "+N" 文本，不画错图）
```

两个 `opts` 旋钮对应两处真实的既有差异，不是预留的抽象：`coinKind` 让 `RechargeScene` 保留自己那套更粗的金币档位阈值（它的面额到五位数，用通用阈值会全部触顶变宝箱）；`materialFallback: null` 让 `EventScene`/邮件在材料 id 不认识时退化成纯文字行，而不是错标成碎屑。

**顺带修掉的两类问题**：
1. **光栅图第一帧空白**：`buildRasterTabIcon` 走的是 `Texture.from` 懒加载，纹理没解码时画空。此前只有 `CardScene`/`EquipmentScene` 调了 `preloadTabIconTextures()`，其余用 AI 页签图的场景（含成就墙分类条）第一帧其实是空的，靠后续重绘自愈。新增 `preloadRewardIconArt()`（`allSettled` 并发预热页签 PNG + 金币图集 + 材料图集，永不 reject），6 个奖励屏幕在构造器里调一次并在 resolve 后重绘。
2. **邮件的 `MAT_ITEM_ICON` 表删除**，材料解析统一走 `materialKind()`（同样只认 `scrap`/`lead`/`binding` 短 id，`mat_` 前缀是 gacha 的另一套命名空间——那条注释保留在 `mail.ts` 类上方）。

**验证**：`tsc --noEmit` 通过；`vitest` + `vitest --config vitest.ui.config.ts` 全绿；新增 `test/render/rewardIcon.test.ts` 钉死"三种物品奖励必须落到 AI 图、不许回落程序 glyph"这条路由。**实拍验证**：Playwright（worktree 里 `TARGET=web-e2e` + `NW_API_BASE` 指向 public API，注册一次性账号 → `lobbyCb.onOpenDaily()` → 点 sidebar 各 tab）截了签到日历/周常宝箱两屏，确认第 2/3 档已是 AI 盾牌/卡牌图，日历里 14 日（卡牌）/30 日（装备）/里程碑金币角标同样全部转 AI。脚本踩到的坑记在 `playwright-screenshot-recipe` 那条记忆里（新账号被 FTUE 反复弹回；IntroScene 的纹理回调打死 ticker——后者已在下一节修掉）。

### 状态：批次 4 完成 ✅

---

## 批次 4 追加：第三种 content 墨色（2026-08-16）

批次 4 收尾时留了一条待美术拍板的项：AI 页签图只烘了 active(白) / inactive(`#686868` 灰) 两种墨色，奖励行拿到的是灰色那份——那是**页签非激活态**刻意压暗的墨，放到纸面内容里，比旁边全彩的材料/金币位图淡一档。用户当天拍板要加。

**做法**：`pack_tab_icons.cjs` 增加第三种 ink `INK_CONTENT = #2c2c2a`（= `sketchUi.ts` 的 `C.dark`，也就是同一行主文案的墨色），每张源图现在吐 3 份，19 个图标共 57 张 PNG。选 `C.dark` 而不是另调一个新灰：奖励图标要跟它旁边那行标签一样"实"，直接复用主文案墨色就没有第二个需要维护的色值。

**代码侧**：
- `icons.ts` 新增 `RasterIconVariant = 'active' | 'inactive' | 'content'`，`TAB_ICON_RASTER` 每行三个 url，`buildIcon(kind, size, color, opts?: { variant })` 多一个可选旋钮（只对光栅 kind 生效，程序 glyph 照旧按 `color` 直接画）。
- **`tabIconVariant()` 故意不会自动返回 `content`**：content 和 inactive 都是"纸底上的深墨"，任何基于颜色的判据都分不开这两者，只能由调用点显式声明。
- `buildRewardIcon` 用 `tabIconVariant(color) === 'active' ? 'active' : 'content'`——纸底走 content，而**万一**哪天有奖励行画在深色底上（调用方传浅墨），仍然拿白线图。那不是防御性代码：底栏那次"灰线画在近黑底上等于隐形"就是漏了这一支。
- `preloadTabIconTextures()` 现在预热 57 张。

**回归测试**（两条，覆盖两个互相看不见的失败面）：
- `test/render/tabIconContentVariant.test.ts`：①**资源侧**（纯 fs，不过打包器）——目录里每个图标必须齐三个变体、总数 = 3×套数、且三份 PNG 两两字节不同（打包脚本跑了一半、或两个 suffix 指向同一种 ink，代码照样能画出东西，只有比像素才抓得到）；②**代码侧**——`TAB_ICON_RASTER` 每个 kind 必须齐三个 key。两半不能合并：vitest 下所有 `.png` import 都被 stub 成同一个 data URI，所以 url 的"互不相同"只在磁盘上有意义，而 key 的"齐不齐"只在模块里有意义。
- `test/render/rewardIcon.test.ts` 增补：三种物品奖励在纸面墨色（`0x336644`/`C.dark`/`C.mid`）下都必须请求 `{ variant: 'content' }`；传 `C.light` 时必须回到 `'active'`。

**同批修掉的一个 canvas 冻结 bug**（批次 4 实拍时踩到的）：见下一节。

---

## 附：实拍时踩出的 canvas 冻结 bug

跟图标无关，但正是批次 4 用 Playwright 实拍时撞上的——它解释了那次“截图全是同一张过期帧”的现象：脚本明明已经走到 Daily 页（`__nwE2E.state.screen === 'daily'`），截出来的却一直是几秒前的教程画面。根因是 `IntroScene`/`IllustratedInterludeScene` 的插图 `once('loaded')` 回调在场景销毁后读**已销毁 Sprite** 的 `.scale`，从 `Ticker._tick` 里的 PIXI Runner 抛出，整个 update 循环中止、画面永久定格，只能刷新页面。

**修复由另一条并行会话落地**（`d15f9087` + `41cd834b`）：两个场景加 `destroyed` 判断并在 `destroy()` 注销监听，另外扫出 `CardScene/feed.ts` 与 `FriendsScene.render()` 两处同类；回归测试 `test/ui/storySceneLateTextureLoad.ui.ts` + 一条静态契约检查。契约写在 `claudedocs/client-modules.md` 的菜单场景生命周期契约一节。

**本会话独立做了一遍同一个修复，合并时整半丢弃**（保留对方已合入的版本，不叠两套写法）。留下的两条经验值得记：

- **已销毁 Container 和已销毁 Sprite 不是一回事**（实测，不是推断）：PIXI 对已销毁 Container 的 `add/removeChild/removeChildren` 完全容忍、不抛；只有已销毁 **Sprite** 的 `transform` 访问才炸。所以“回调只是重绘”的调用点最坏是白干一遍活，“回调直接摸 Sprite”的才是冻屏级——扫这类问题时先按这条分级，别把二十多处全当同等严重。
- **没亲眼看它红过的回归测试等于没有**：本会话第一版 `FriendsScene` 用例断言的是“destroy 后 render 不抛”，把修复撤掉照样绿（因为它本来就不抛）。改成断言“destroy 后 render 不会把子节点重新塞回容器”才咬合。撤掉改动看它变红——这一步必须做。
- **撤改动看红时，`perl -0pi -e 's/…\n//'` 会静默失效**：这个仓库的文件是 CRLF，`\n` 匹配不上，脚本什么都没删、测试当然照样绿，很容易误判成“测试没咬合”。用 `\r?\n`。同一个假设还在更早一次合并冲突里吞掉过本文档“批次 4”整节（`indexOf('\n---\n\n## 批次 4')` 返回 -1 → `slice(-1)`）。
