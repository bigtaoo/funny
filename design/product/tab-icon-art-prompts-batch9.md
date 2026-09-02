# 批次 9：世界地图弹窗图标槽的 7 个空位（瞭望塔 / 箭塔 / 阻挡 / 定位针 / 营帐 / 脚印 / 险地）— Prompt 文档

> 创建：2026-09-02 · 状态：**7 张已出图、已接线、已实拍验收（同日）**——6 张一版过，`camp` 判为「可用但最弱」并登记 v2 重出 prompt（见 §7）。全库账：**56 张自有美术 + 6 个别名 = 62 个 ink kind**
> 前八批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（批 1–4，19 张）· [`batch5`](tab-icon-art-prompts-batch5.md)（页面标题，24 张）· [`batch6`](tab-icon-art-prompts-batch6.md)（大厅首页，3 张）· [`batch7`](tab-icon-art-prompts-batch7.md)（矢量清零，43 张）+ [`batch7-log`](tab-icon-art-prompts-batch7-log.md)（重出记录）· [`batch8`](tab-icon-art-prompts-batch8.md)（数值词条 4 张 + 8b 卡片元信息 2 张）
> 配套代码：[`inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts) · [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) · [`modalLine.ts`](../../client/src/scenes/worldmap/WorldMapPanels/modalLine.ts) · 调用点见 §5
> 上游：[`SLG_LOG_2026-08.md` 「2026-09-02：地块弹窗」](../game/SLG_LOG_2026-08.md) 一节的「待补图」段（提交 `e2c83254f`）
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6 · 批次叙事：[`art-direction-map-ui.md`](art-direction-map-ui.md)

## 0. 这批从哪来：图标槽先落地，空位才浮出来

`showModal` 在 2026-09-02 长出图标槽之前，地块弹窗是整张世界地图上唯一没有任何图形语言的地方。那次给 24 个位点接了现成美术，剩下的分成两类：

- **只能空着的**：三条状态行（`world.hasWatchtower` / `hasArrowTower` / `hasBlocker`）在墨色表里没有对应美术，当时**保留了字符串里的 emoji 🗼🏹🚧**——因为把 emoji 删掉等于让这三行彻底失去标记，比留一个字体不受控的字形更糟。三个建造按钮同理，只能共用 `hammer`。
- **借用别人美术的**：坐标行借 `globe`、「移动并驻扎」借 `unit`（士兵头盔）、「移动到此（停留）」借 `spd`（双人字尖括号）、险地弹窗标题借 `siege`（裂开的城墙）。四处都能用，语义是借的。

**本批出 7 张把这两类清干净。**

### 为什么不复用 `art/slg/slg-map/` 里已有的三张建筑图

`icon_watchtower.png` / `icon_blocker.png` / `icon_arrowTower.png` **都已经存在**，语义一模一样。它们不能拿来当弹窗图标，理由不是"不好看"，是已经量过：

- 那是**另一套美术语言**——写实钢笔排线、3/4 俯视透视、长边 256、立在菱形格上（见 [`slg-building-art.md`](slg-building-art.md) §1–§2），跟 tabicon 这套"West of Loathing 涂鸦线稿"不是一个笔。
- [`slg-building-art.md` §6](slg-building-art.md) 已经在**它们各自真实的渲染高度**（watchtower ≈30px、blocker ≈17px）上跑过 6× 最近邻放大核对，原文结论是「两张已验收的图在这个尺寸下本来就是一团模糊的排线纹理，不是清晰线稿」——那在地图上可以接受（它是地景的一部分，玩家不靠它读信息），在 26px 的弹窗行里当**信息标记**用不行。

所以是三张新图，不是三次复用。地图那三张不动。

### 「保护中」的盾不在本批

上游那段「待补图」还点了一项**盾**（`world.protected`——注意它其实不在弹窗里，是 [`WorldMapPanels/hud.ts`](../../client/src/scenes/worldmap/WorldMapPanels/hud.ts) 的保护倒计时 buff 行，目前无图标）。本批不出：`armor`/`armorHeavy`（正面圆盘小盾）在 26px 上读不出来是这个项目已经交过学费的结论（见 [[pick-icon-glyphs-by-eye-not-name]] 与 batch7-log），而"保护中"到底该画盾、画伞、还是干脆用 `lock`，是一次独立的语义判断，不该顺手塞进一批以「地块结构物」为主题的出图里。**留在 backlog，下一批连同判据一起做。**

## 1. 盘点：7 张，各自现在长什么样

| # | kind | 位点 | 现状 | 优先级 |
|---|---|---|---|---|
| 1 | `watchtower` | 状态行 `world.hasWatchtower` + 按钮 `world.actWatchtower` | 行里挂 emoji 🗼；按钮共用 `hammer` | **P0** |
| 2 | `arrowTower` | 状态行 `world.hasArrowTower` + 按钮 `world.actArrowTower` | 行里挂 emoji 🏹；按钮共用 `hammer` | **P0** |
| 3 | `blocker` | 状态行 `world.hasBlocker` + 按钮 `world.actBlocker` | 行里挂 emoji 🚧；按钮共用 `hammer` | **P0** |
| 4 | `mapPin` | `coordLine()` 的 `(x, y)` 行，10 处弹窗共用 | 借 `globe` | P1 |
| 5 | `camp` | 按钮「移动并驻扎」（己方地块 + 盟友地块两处） | 借 `unit`（士兵头盔） | P1 |
| 6 | `footsteps` | 按钮「移动到此（停留）」（己方地块 + 空地两处） | 借 `spd`（双人字尖括号） | P1 |
| 7 | `stronghold` | 险地弹窗标题行 `world.stronghold` | 借 `siege`（裂开的城墙） | P1 |

**P0 那三个是同一个菜单里的**：己方地块的建造菜单会同屏出现瞭望塔 / 箭塔 / 阻挡三个按钮，所以它们不是三张独立的图，是**一个必须互相分得开的集合**——按沙漏三档和 `crit`/`critmult` 的老规矩，**三张放在同一个请求里连续出**。

出图后全库账：49 张自有美术 + 6 个别名 → **56 张自有美术 + 6 个别名 = 62 个 ink kind**。

## 2. 共用硬约束（骨架之外，这批必须写进 prompt 的三条）

骨架沿用前八批，不重复贴：

> `Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: …. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, …, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.`

三条这批**特别容易踩**的，已经写进下面每条 prompt：

1. **整体剪影不许超过 2.2:1**。`pack_tab_icons.cjs` 裁到内容外框后把**长边**归一到 128，运行时再 contain-fit 进**方框**——所以一张细长的图只画得满它拿到的格子的一小部分。`brush` v2 的 4.74:1 在 28px 里只有 6 像素宽（读成"一根头发上顶个点"），`range` v1 的 4.24:1 缩成一条发丝，都是这么废掉的，现在有 [`iconArtAspect.test.ts`](../../client/test/render/iconArtAspect.test.ts) 的 `MAX_RATIO = 2.2` 硬拦。**本批最危险的是 `blocker`**：地图上那张 `icon_blocker` 是 2.91:1，按同样的"矮而宽"去画必然被拦。所以 prompt 里明写「整体塞进一个正方形」，而**不是**去 `ELONGATED_ON_PURPOSE` 加豁免——那张表是债，不是属性。
2. **细节只许长在外轮廓上，不许靠内部纹理或点阵**。沙漏三档栽在"沙粒点阵"、`critmult` v1 栽在"8 根等距迸溅线连成一体读成船舵"、`scrap` 栽在"撕边糊成一块"。本批的对应雷区：`footsteps` 的脚趾不能画成一排小圆点，`blocker` 的木桩之间必须留出**跟线宽同量级的白纸缝**（[[ai-art-density-cannot-be-prompted-2026-08-19]] 的几何写法，别用形容词）。
3. **家族一次出**。三个建造图标（1/2/3）同屏，一次请求；`blocker` 与 `stronghold` 都带 X 形记号，出图后必须并排看一遍（见 §6）。

## 3. 造型判断表

避让栏里点名的每一个 kind，都是**照着它实际画的东西**写的，不是照名字——这批开工前先把 26 个近邻烤成深底 contact sheet 看过一遍（配方见 [[pick-icon-glyphs-by-eye-not-name]]）。几个反直觉的：`castle` 是**带城垛 + 塔顶小旗 + 拱门**的完整城堡，`city` 是**带城垛 + 拱门**的城墙段，`cabinet` 是**竖立的抽屉柜**——三张都会跟"塔"撞；`lead` 是**底边张开的锥体**，正好是帐篷的剪影；`close` 是**一个大 X**；`scrap` 是**一张横向撕开的纸**。

| # | kind | 造型 | 为什么是这个形 | 必须避让 |
|---|---|---|---|---|
| 1 | `watchtower` | 敞开式木望楼：四条向外撇开的腿 + X 形斜撑（腿之间**透纸**），顶上一方带栏杆的小平台，平台上一顶简单的尖屋顶。整体宽≈高 | 「塔」这个语义在本库里已经被 `castle`/`city`/`cabinet` 三面包夹，唯一没被占的剪影特征是**下半部是镂空的架子**。宽脚架同时压住 2.2:1 门禁，也跟地图上那张 `icon_watchtower` 的构图语言对得上（那张 v2 正是为了"宽脚架"重出的） | 不许城垛/雉堞（`castle`/`city`）、不许拱门（同）、不许塔顶小旗（`castle`，且 `flag` 本身就是一面旗）、不许实心塔身或竖直方箱（`cabinet`）、不许梯子、不许任何箭或武器（那是 2 号） |
| 2 | `arrowTower` | 窄塔身、**实墙**、简单尖顶，立在小基座上；上部三分之一有个开口，**一支大箭水平向右飞出**，实心三角箭头完全离开墙体 | 跟 1 号的差别必须在**剪影层**成立而不是靠细节：1 号是"宽的、镂空的"，2 号是"窄的、实心的、伸出一支箭"。箭同时把整体拉宽，避开细长塔的 2.2:1 风险 | 不许同心圆/靶（`crit`）、箭两端不许加短竖端线（`range`）、不许向下的匕首 + 迸溅（`atk`）、不许弓、不许多支箭、不许城垛/拱门/小旗、不许 1 号的撇腿斜撑 |
| 3 | `blocker` | 路障：**两道长横杆**横贯画面，后面三根削尖木桩交叉成 X 对绑在上面，桩与桩之间留大片白纸；**整体塞进正方形**，不是一条矮长条 | 「挡路的东西」在本库里最容易撞 `siege`（三排砖 + 裂缝）。区分点选在**通透 vs 实心**：路障是能看穿的格栅，砖墙是实心块。横杆是第二道保险——它让这张图不会退化成 `close` 的那个大 X | 不许砖块/砖缝/裂缝（`siege`）、不许**一个**孤立的大 X（`close`）、不许对勾（`check`）、不许撕纸边（`scrap`）、不许画成远宽于高的长条（2.2:1 门禁）、不许把栅栏画满/画实、不许门/城堡 |
| 4 | `mapPin` | 标准地图针：上圆下尖的水滴形，圆头正中一个**空心圆**，底端收成锐点 | 坐标行要读成"位置"。水滴形是这个概念全世界最省线条的写法，26px 上剪影极稳；空心圆是它跟"水滴/气球"分开的唯一必要细节 | 不许经纬线或大陆块（`globe`）、不许折叠地图 + 虚线路线（`worldTabIcon`）、不许墨水瓶（`ink`）、不许气球线、不许旗杆（`flag`）、不许针脚下画投影椭圆或地面线（那是第二个物件） |
| 5 | `camp` | 脊帐：两片斜面在顶上的脊杆相交，**一路斜到地面、没有竖直墙**；正面中央一个倒 V 形入口、两片门帘向外翻折；两侧各一根绷绳拉到地钉；帐下一条短地面线 | 「驻扎」= 部队钉在这儿住下，帐篷是最直白的写法。**但裸帐篷就是一个三角形**，而本库里 `lead`（底边张开的锥体）和 `play`（实心三角）都已经占了三角剪影——入口 + 绷绳 + 地面线是把它从三角形里拽出来的三件东西，缺一不可 | 不许实心填充的三角（`play`）、不许裸锥体或底边毛糙的锥体（`lead`）、不许竖直墙 + 方门（`home` 是"三角顶 + 方身 + 方门"的房子）、不许脊上插旗（`flag`/`castle`）、不许篝火、不许两顶以上、不许山峰 |
| 6 | `footsteps` | **正好两个**鞋底印：一左一右，各画成一条闭合的鞋底外轮廓 + 足弓处一道横向凹口；两印错开、朝左下 → 右上斜着走，各自画大，合起来接近正方形 | 「移动到此（停留）」要读成"走过去"，跟 5 号的"住下"一动一静。脚印是"曾经走过"最省的写法，而且跟本库里任何东西都不撞 | 不许尖括号/箭头（`spd` 就是双人字尖括号，这是最要命的一条）、不许超过两个印、不许赤脚 + 一排独立的圆脚趾点（点阵在 28px 上必糊）、不许把脚跟和前掌拆成两块、不许侧视的鞋、不许虚线足迹、不许箭头 |
| 7 | `stronghold` | 嶙峋岩峰：一簇三个尖岩，中间最高，画成**一条连贯的粗外轮廓**；岩根横着一道粗重的扁平 X 形路障记号 | 险地在本项目里已经有既定视觉词汇：`terrain_stronghold` 的定稿就是「顶视岩石团块 + 扁平 X 形路障记号」。26px 上山峰剪影极稳，X 补上"此路凶险"的语义 | **不许骷髅、不许骨头**——`terrain_stronghold` v1 就是因为混入骷髅骨头被打回（见 [`slg-terrain-art.md`](slg-terrain-art.md) §5），`slg-building-art.md` 的负向表里也明写了这条，本项目的险地语言里没有骷髅；另外不许城堡/城垛（`castle`/`city`）、不许砖排 + 裂缝（`siege`）、不许一整排木桩栅栏（那是 3 号）、不许孤立的 X（`close`）、不许圆滑小山丘/雪顶/太阳/云/树 |

## 4. 完整 prompt

### 1–3 三个建造图标（`tabicon_watchtower` / `tabicon_arrowTower` / `tabicon_blocker`）

> **三张必须在同一个请求 / 同一段对话里连续出。** 它们会同屏出现在同一个建造菜单里，所以"互相分得开"是验收条件之一，而分不分得开取决于三张是不是同一只笔画的——沙漏三档和 `crit`/`critmult` 都是这么定的规矩。

**1 瞭望塔（`tabicon_watchtower`）**

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an open timber lookout tower — a small square platform with a simple railing and a plain peaked roof over it, standing on four wooden legs that splay outward and are braced with X-shaped cross-bracing, the legs spread wide so the whole structure is about as wide as it is tall, and the space between the legs left completely open so the bare paper shows through. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a castle or fortress silhouette, crenellations or battlements, an arched gateway, a flag or pennant, a solid filled tower body, a tall narrow box or chest of drawers, a ladder, an arrow or any weapon, a person or figure standing in the tower, a silhouette more than twice as tall as it is wide, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**2 箭塔（`tabicon_arrowTower`）**

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a narrow defensive tower with plain solid walls and a simple pointed roof, standing on a small base, with one bold arrow flying out horizontally to the right from a single opening in the upper third of the tower — the arrow drawn large, with a solid triangular arrowhead well clear of the tower wall and a short straight shaft. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, crenellations or battlements, an arched gateway, a flag or pennant, splayed open legs or cross-bracing under the tower, concentric circles or a target, short vertical end bars at the ends of the arrow, a downward-pointing dagger, splash or impact lines, a bow, more than one arrow, arrow fletching, a ladder, a silhouette more than twice as tall as it is wide, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**3 阻挡（`tabicon_blocker`）**

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a wooden barricade blocking a path — two long horizontal rails running all the way across, with three sharpened wooden stakes crossed into X pairs and lashed behind the rails, and wide gaps of bare white paper left between the stakes so the barricade clearly reads as an open see-through lattice; the whole barricade is about as tall as it is wide and fits inside a square. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a brick wall, courses of bricks, a crack running through a wall, one single large X on its own, a check mark, a torn sheet of paper, a low strip much wider than it is tall, a solid filled or closely packed fence, a gate or doorway, a castle, barbed wire, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 4 地图定位针（`tabicon_mapPin`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a map location pin — one rounded teardrop shape, wide and round at the top and tapering smoothly to a sharp point at the bottom, with a single plain hollow circle in the middle of the round head. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a globe with meridian lines or continents, a folded map, a dotted route line, an ink bottle, a plain water droplet with no circle, a balloon with a string, a flag on a pole, a sewing pin with a straight shaft, a shadow ellipse or ground line under the pin, more than one pin, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 5 营帐（`tabicon_camp`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a ridge tent pitched on the ground — two straight sloping side panels meeting at a ridge pole along the top and running all the way down to the ground with no vertical walls, an inverted-V entrance opening in the middle of the front panel with its two flaps folded back to each side, one guy rope on each side running from the ridge down to a small peg in the ground, and one short straight ground line under the tent. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a solid filled triangle, a bare cone, a cone with a ragged or flared bottom edge, a pencil lead or crayon tip, a house with vertical walls and a square door, a pitched roof sitting on a box, a flag or pennant on the ridge pole, a campfire, smoke, more than one tent, a mountain or hill, trees, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 6 脚印（`tabicon_footsteps`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a short trail of exactly two boot-sole footprints — one left print and one right print, each drawn as a single closed sole outline with one horizontal notch line across the arch, the two prints offset from each other and angled so the trail walks from the lower left toward the upper right, each print drawn large so the two together fill a roughly square frame. Centered on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, chevrons or arrowheads, an arrow, more than two prints, bare feet with separate round toe dots, a print split into separate heel and forefoot pieces, a shoe or boot seen from the side, a footprint inside a circle, dotted or dashed trail marks, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

> 这张是本批唯一一个"物件不止一个"的主体，所以骨架里的 `Single object` 换成了 `Centered`，而"正好两个印"由主体句自己钉死；`scattered pieces` / `confetti dots` 两条负向保留——它们防的是脚趾点阵和虚线足迹，不是这两个印本身。

### 7 险地记号（`tabicon_stronghold`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a jagged rocky crag — a cluster of three sharp rock peaks with the tallest in the middle, drawn as one bold connected outline — with a single bold flat X-shaped barricade mark drawn across the rocks near the base. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no hatching or texture inside the rocks. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a skull, bones, a castle or fortress silhouette, crenellations or battlements, courses of bricks, a crack running through a wall, a row of stakes or a fence, an X standing on its own with nothing behind it, a smooth rounded hill, a snow cap, a sun, clouds, trees, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 5. 出图后的接线清单

行号以 `e2c83254f` 为准，改的时候按符号找、别照行号点。

**① 源图归位** — `art/ui/tabicons/tabicon_<kind>.webp`，**base 名必须逐字等于 kind 名，大小写保留**（`tabicon_arrowTower.webp` → `arrowTower_active.png` → kind `arrowTower`）。`inkIconArt.test.ts` 就是靠这条对账的，命名错了会红。被打回的版本移进 `art/ui/tabicons/_rejected/`，命名 `tabicon_<kind>_v<n>_<为什么废>.webp`（同一测试会检查"每个 kind 恰好一个源图"）。

**② `art/ui/tabicons/pack_tab_icons.cjs`** — `JOBS` 末尾加一段带注释的 7 行，全部 `inks: ['active']`（**只烤白色母版，运行时 tint**；烤三档墨色会静默把这批改道走 `tabIconVariant` 并抹平所有 tint）：

```js
// Batch 9 (design/product/tab-icon-art-prompts-batch9.md): the world-map tile modal's remaining
// icon slots — three tile structures that only had an emoji in the localised string, plus four
// slots that were borrowing someone else's art. Same `inks: ['active']` contract as batches 7/8.
{ src: 'tabicon_watchtower.webp', name: 'watchtower', inks: ['active'] },
{ src: 'tabicon_arrowTower.webp', name: 'arrowTower', inks: ['active'] },
{ src: 'tabicon_blocker.webp',    name: 'blocker',    inks: ['active'] },
{ src: 'tabicon_mapPin.webp',     name: 'mapPin',     inks: ['active'] },
{ src: 'tabicon_camp.webp',       name: 'camp',       inks: ['active'] },
{ src: 'tabicon_footsteps.webp',  name: 'footsteps',  inks: ['active'] },
{ src: 'tabicon_stronghold.webp', name: 'stronghold', inks: ['active'] },
```

**③ 跑打包** — `node art/ui/tabicons/pack_tab_icons.cjs`，直接产出 `client/src/assets/tabicons/<kind>_active.png` 七张。**没有 merged-atlas 重打包这一步**（那是 `slg-map` 那条线的事）。

**④ `client/src/render/icons/inkIconRaster.ts`** — 三处：7 个 `import`（带一段批次 9 注释）、`InkIconKind` 加一行、`INK_ICON_ART` 加 7 行。

**⑤ 调用点，每处一行**：

| 文件 | 位置 | 改成 |
|---|---|---|
| `worldmap/WorldMapInput.ts` | :109 `world.actWatchtower` 按钮 | `icon: 'hammer'` → `'watchtower'` |
| 同 | :120 `world.actArrowTower` 按钮 | `icon: 'hammer'` → `'arrowTower'` |
| 同 | :121 `world.actBlocker` 按钮 | `icon: 'hammer'` → `'blocker'` |
| 同 | :135 `head.push(t('world.hasWatchtower'))` | → `{ text: t('world.hasWatchtower'), icon: 'watchtower' }` |
| 同 | :136 / :170 / :197 三处 structure 行（同一个三元表达式） | → `{ text: …, icon: tile.structure.kind === 'arrowTower' ? 'arrowTower' : 'blocker' }` |
| 同 | :102 / :301 `world.actMove` 按钮 | `icon: 'spd'` → `'footsteps'` |
| 同 | :103 / :162 `world.actGarrison` 按钮 | `icon: 'unit'` → `'camp'` |
| 同 | :258 险地标题 `world.stronghold` | `icon: 'siege'` → `'stronghold'` |
| `worldmap/WorldMapPanels/modalLine.ts` | `coordLine()` | `icon: 'globe'` → `'mapPin'`，并删掉那句 "`globe` is a stand-in until the map-pin art lands" |

**这几处刻意不动**（不是漏了）：

- `WorldMapInput.ts:307` 的驻军数量行和 `WorldMapPanels/core.ts:248` 的 `world.deployTitle` 仍用 `unit`——它们说的是"这儿有多少兵"，不是"驻扎"这个动作，头盔正确。
- `:188` / `:229` / `:263` / `WorldMapInput/cityPanel.ts:109` 的进攻按钮仍用 `siege`（裂开的城墙 = 攻城），本批只把**险地标题**从 `siege` 挪走。
- 三个建造按钮从 `hammer` 挪走之后，`hammer` 在这张图上还留着建造/拆除等别的位点，不空。

**⑥ i18n 删 emoji，三键 × 三语共 9 行**（键名和文案其余部分一字不动，只去掉行首的 emoji 和它后面那个空格）：

| 文件 | 行 | 现在 | 改成 |
|---|---|---|---|
| `client/src/i18n/locales/zh.ts` | 897 / 912 / 913 | `'🗼 已建瞭望塔'` / `'🏹 箭塔'` / `'🚧 阻挡'` | `'已建瞭望塔'` / `'箭塔'` / `'阻挡'` |
| `client/src/i18n/locales/en.ts` | 875 / 890 / 891 | `'🗼 Watchtower built'` / `'🏹 Arrow tower'` / `'🚧 Blocker'` | 同左去 emoji |
| `client/src/i18n/locales/de.ts` | 875 / 890 / 891 | `'🗼 Wachturm gebaut'` / `'🏹 Pfeilturm'` / `'🚧 Sperre'` | 同左去 emoji |

删 emoji 和接 `icon:` **必须同一次改完**：只删不接会让这三行彻底失去标记（这正是 2026-09-02 那轮决定先留着 emoji 的理由）。

**⑦ 测试**：

- `client/test/render/inkIconArt.test.ts` 的 `expect(OWN_ART.length).toBe(49)` → `56`，并把它上面那段"49 = …"的算式注释补上批次 9 的 7 张。
- `client/test/render/iconArtAspect.test.ts` **不要改**。某张超 2.2:1 是"这张图该重出"的信号，不是"该加豁免"——`ELONGATED_ON_PURPOSE` 是债，`atk` v6 把自己的那行还掉了才是正常终点。
- 读 `showModal` 的那批 UI 测试文件此前已统一改成 `.map(modalLineText)`，本批把三条状态行从 `string` 变成 `{ text, icon }`，断言不用再动一次。若有用例直接比对 `lines` 数组字面量（而非 `modalLineText`），那处会红——按 `.map(modalLineText)` 改。

**⑧ 验证**：`tsc --noEmit -p tsconfig.test.json`、`npm run lint`、`npm run build:web`、`npm run check:filelength`、UI + 单元全量。**类型过了不等于构建过了**：这 7 张是 `import` 进来的资源，文件名错一个字母只有 webpack 会报。

## 6. 验收口径（这条别省，上一轮就是在这里推翻了两个选择）

1. **深底 + 纸底两张 contact sheet，26px 和 28px 各看一遍。96px 预览不算数。** 深底取 `#2c2c2a`（`C.dark`，也就是按钮填充），纸底取奶油纸色——弹窗信息行画在纸上、按钮画在深底上，同一张图两种衬底都得成立。脚本临时写在 scratchpad，用完删（别留在 `client/` 里，会被 lint 和 `check:filelength` 扫到）。
2. **成组并排看，不是逐张看**：
   - `watchtower` / `arrowTower` / `blocker` 三张同屏（它们真的会同屏）；
   - `blocker` vs `siege` vs `stronghold`（三张都有"横向结构 + X 或裂缝"）；
   - `camp` vs `lead` vs `play` vs `home`（四张都是三角剪影）；
   - `footsteps` vs `spd`（借位换真图，得比原来更好读才算换对）；
   - `mapPin` vs `globe` vs `ink`（前者原来就借的后者之一）。
3. **真实弹窗实拍**，走 [[worldmap-standalone-debug-render]] 的零改源码套路（`start:e2e` + `__nwE2E.views.showWorldMap` + reject-fast `worldApi` Proxy，直接 poke `ctx.tileCache` 再调 `ctx.input.onTileClick`）。要摆出来的四种态：己方地块（三个建造按钮 + 驻扎/停留同屏，注意**窄列不画按钮图标**的 `btnW >= 200` 门禁，得挑宽列的那种菜单）、已建瞭望塔的地块（状态行）、带 `structure` 的地块（箭塔 / 阻挡两种）、险地弹窗（标题行）。看画面按 `CLAUDE.md`「看画面」走用户本机真实 Chrome。
4. **判定标准是"读成什么"，不是"好不好看"**：一个读成另一件事的图标比没有图标更糟——`hammer` 共用至少诚实地说了"这是个建造按钮"。任何一张在 26px 上分不出来，就按 batch7-log 的格式记下"v1 为什么塌"再重出，**只改导致返工的那一处措辞**，别凭印象改别的地方。

## 7. 出图记录（2026-09-02 当日出图 + 接线 + 验收）

### 打包结果：7 张全部过 2.2:1 门禁

裁边 + 长边归一到 128 之后的实测尺寸（`iconArtAspect.test.ts` 的上限是 2.2，本批无一需要豁免）：

| kind | 尺寸 | 比 | kind | 尺寸 | 比 |
|---|---|---|---|---|---|
| `watchtower` | 106×128 | 1.21 | `camp` | 128×64 | **2.00** |
| `arrowTower` | 84×128 | 1.52 | `footsteps` | 94×128 | 1.36 |
| `blocker` | 128×107 | 1.20 | `stronghold` | 128×126 | 1.02 |
| `mapPin` | 86×128 | 1.49 | | | |

`blocker` 落在 1.20——§2 那条"塞进正方形"的措辞起了作用，地图上那张同名图是 2.91。**顺带验到一条**：重跑打包脚本后 188 张既有资源**零字节变化**，即这条管线是确定性的，加 JOBS 行不会顺手改动别人的图。

### 26/28px 双衬底 + 真机实拍：6 张过，`camp` 记为「可用但最弱」

深底（`C.dark` `#2c2c2a`，按钮填充）+ 纸底（`C.paper` `#faf6ee`，信息行）各看 26px 和 28px，然后按 §6 的五组并排看，最后在真实弹窗里实拍。

**成组比对全部无撞车**：建造三件套（宽镂空 / 窄实心带臂 / 矮格栅）三种剪影一眼分开；`blocker` vs `siege` vs `stronghold` vs `close`（通透格栅 / 实心砖块 / 岩峰带 X / 孤立大 X）互不相似；`footsteps` vs `spd` 差异极大；`mapPin` vs `globe` vs `ink` 清清楚楚。

**`camp`（营帐）判为可用但最弱，登记 v2**。它不跟 `lead`/`play`/`home` 混——§3 要求的「入口 + 绷绳 + 地面线」确实把它从三角剪影里拽出来了——但代价付错了维度：

- **绷绳把外框拉宽到 2.00:1**，是全库除 `weapon`/`event` 两个豁免项之外最扁的一张。contain-fit 进方框后只占一半高度，于是在同一行里比左右邻居**明显轻一档**。
- 而绷绳本身**在 26px 上完全消失**——它只贡献了宽度，没贡献可读性。26px 上剩下的读法是"一个矮篷子/一道支架"，要知道它是帐篷才看得出是帐篷。

这不是"读成了另一件事"（那要打回重出），是"读得比邻居弱"，所以照 batch 7 对 `atk`/`scrap` 的处理**先上线、登记重出**。

**v2 prompt（只改导致返工的那一处：去掉绷绳和地面线，改用脊杆端头破三角，整体收成方形）**：

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a ridge tent pitched on the ground, seen straight on — two straight sloping side panels meeting at a ridge pole along the top and running down to the ground with no vertical walls, a large inverted-V entrance opening in the middle of the front panel with its two flaps folded back to each side, and the ridge pole poking out as a short stub beyond the peak at each end. The tent stands as tall as it is wide, filling a square frame. No ropes, no pegs, no ground line. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, guy ropes, tent pegs, a ground line, a wide flat silhouette more than one and a half times as wide as it is tall, a solid filled triangle, a bare cone, a cone with a ragged or flared bottom edge, a pencil lead or crayon tip, a house with vertical walls and a square door, a flag or pennant on the ridge pole, a campfire, smoke, more than one tent, a mountain or hill, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

重出落地是**零代码改动**：覆盖 `art/ui/tabicons/tabicon_camp.webp`（旧图移进 `_rejected/`，命名 `tabicon_camp_v1_flat2to1ropesvanish.webp`）、重跑 `node art/ui/tabicons/pack_tab_icons.cjs`，测试不用碰。

### 实拍中查到的一件事：三个建造按钮的图标今天基本画不出来

真机量到的数字：己方地块菜单 7–9 个按钮时 **`btnW = 166`**，而 `WorldMapPanels/core.ts` 的按钮图标门禁是 **`btnW >= 200`**。也就是说 `watchtower`/`arrowTower`/`blocker`/`camp`/`footsteps` 这五个**按钮**上的图标，在最常见的那个菜单里一个都不画。

- 这不是本批引入的，是 2026-09-02 图标槽那轮就记在案的既有排版问题（当时三个建造按钮共用 `hammer`，同样画不出来），**根治办法是缩短标签**（有图标之后 `移动到此（停留）`/`移动并驻扎` 可以只留 `停留`/`驻扎`），属于产品决定。
- **本批真正兑现的是那三条状态行**：`已建瞭望塔`/`箭塔`/`阻挡` 从 emoji 换成了手绘墨线，这是三个 P0 的主要目的；坐标行的 `mapPin` 和险地标题的 `stronghold` 也都在真实弹窗里就位。
- 按钮那条路没有白接：验收时用同一条 `showModal` 路径造了一个宽列弹窗（`btnW = 284`/`210`），确认五个字形在**深色按钮填充**上都渲染正确、也都分得开——标签一缩短就会自动显示，不需要再改代码。

### 验证

`tsc --noEmit -p tsconfig.test.json`、`tsc --noEmit -p tsconfig.fulllink.json`、`npm run lint`（0 error）、`npm run build:web`、`npm run check:filelength`、单元 241 文件 2787 例、UI 254 文件 2430 例——全绿。`inkIconArt.test.ts` 的 `OWN_ART.length` 从 49 改到 56（算式注释同步）；`iconArtAspect.test.ts` 一字未动，7 张全部自己过关。

三处重复的 `structure` 三元表达式（己方/盟友/敌方分支各一份）收敛成 `WorldMapInput/tileInfoLines.ts::structureLine()`——本来就是三份拷贝，现在还要多同意一个 icon，等于三份各自漂移的机会。

**可视化验证**走 [[worldmap-standalone-debug-render]] 的零改源码套路，在用户本机真实 Chrome 里实拍：己方地块（瞭望塔 + 箭塔两条状态行、坐标行）、`阻挡` 状态行、险地弹窗（`stronghold` 标题与同弹窗内 `siege` 围攻按钮并存不撞）、以及上面那个宽列按钮弹窗。踩到两个跟本批无关但值得记的坑：`showWorldMap` 的 `cb` **必须带 `worldId`**（缺了 `proceduralTile` 里的 `worldSeed(world)` 直接 `undefined.length` 抛在 `WorldMapScene` 构造函数里），以及**标签页在后台时 rAF 被节流、`SceneManager` 的淡入淡出卡在 `elapsedMs: 0` 不推进**（`manager.current` 一直停在 `IntroScene`，看着像挂了）——截一张图让它前台化就继续跑了。
