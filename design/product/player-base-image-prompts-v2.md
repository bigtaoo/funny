# 玩家基地 Prompt — v2 出图轮（2026-08-13 起）

> 从 [`player-base-image-prompts.md`](player-base-image-prompts.md) 拆出（2026-08-17，原文件 915 行）。**小节编号沿用原文**，`player-base-image-prompts.md §N` 引用照旧有效。
> 本册内容：Lv.1–10 的 v2 prompt 与逐张返工记录。总览与在先小节见 [`player-base-image-prompts.md`](player-base-image-prompts.md)。

---

## 2026-08-13：仍有 5 张没顶满，出 v2 prompt

用户反馈"还有几张图没法完全铺到格子上"。核对 8-08 收尾时记的 `contentWidthFrac`（满宽目标 0.9375）：Lv.1 0.94 / Lv.4 0.94 / Lv.7 0.94 已满宽；Lv.5 0.91 / Lv.8 0.91 够接近，之前判定"达标"未再返工；但 **Lv.3 0.82（最窄）/ Lv.9 0.83 / Lv.10 0.84 / Lv.6 0.85 / Lv.2 0.89** 明显偏窄，两侧仍留白。

沿用 8-08 第三轮已验证有效的套路——抽象宽高比数字（如"12:7"）AI 出图对不齐，得换成**具体锚点指令**（远端插旗/物体贴边、允许被画幅边缘裁掉一半）——给这 5 级各写一条 v2 prompt，只改构图锚点部分，画风/特征物延续原 prompt：

### `playerbase_l2` v2「文具围栏」
```
A wide desk-pad ground plate with a low camp covering about a third of it: an
open pencil case wall extended left and right by a row of laid-down pencils as
a short palisade that runs the full width of the frame, its far-left and
far-right pencil tips touching the very edges of the picture (put a tiny paper
flag stuck at each of those two outer tips so the width reads clearly,
cropping half a flag off the edge is fine), a ruler laid flat as a bridge/gate
at the front, a squat ink bottle at one back corner, a small flat tent inside.
Everything hugs the plate and stays low; the fence's two ends are the widest
points of the whole image, not the tent or bottle.
[+ style]
```

### `playerbase_l3` v2「书本壁垒」
```
A wide desk-pad ground plate about half covered by a low stronghold of flat
stacked notebooks forming a wall drawn as a WIDE FLAT RECTANGLE, not a square —
stretch it so the wall's own left and right ends touch the very left and right
edges of the picture frame (put a single upright pencil stub at each of those
two far corners, tip poking just past the frame edge if needed), book spines
making crenellations along the top the whole way across, a stapler set into
the middle of the front wall as a gate. Wide and squat — the wall is only two
or three books high, and its two far corners are the widest points in the
image, wider than Lv2's fence.
[+ style]
```

### `playerbase_l6` v2「文具石堡」
```
A wide desk-pad ground plate filled edge to edge by a stone-like fortress of
thick hardcover books laid flat, drawn as a wide flat rectangle rather than a
block — its outer wall's left and right corners touch the very left and right
edges of the picture frame, with a correction-tape roll lying on its side as a
squat round corner tower AT each of those two far corners (half a tower may
crop off the frame edge, that's fine, it must not float with empty plate
beside it), a broad low binder as the central keep, a ruler-and-compass
drawbridge across the front between the two corner towers. Heavy
cross-hatching for stony texture. Wide, heavy, low — the two corner towers are
the widest points of the whole image, clearly wider than Lv5's fortress.
[+ style]
```

### `playerbase_l9` v2「书院巨城」
```
A wide desk-pad ground plate overflowing with an elaborate citadel complex:
several broad book-stack blocks connected by ruler-walls into wings and
courtyards that run the FULL WIDTH of the picture frame, with one short
pencil stub standing upright AT the far-left edge and another AT the
far-right edge of the frame (their tips may crop off the very edge, that's
fine — they must not float with empty plate beside them), two more pencil
stubs at the back corners as stumpy spires of barely varying height, a wide
central binder-keep flying a paper pennant, dense parallel ruler-lines
everywhere suggesting grandeur. A single small gold-ink accent on the
far-right pencil tip as the only exception to the two-tone palette. The two
outermost pencil stubs are the widest points of the whole image — grandeur
through sprawl and line density, nothing towers.
[+ style with gold-accent exception]
```

### `playerbase_l10` v2「文具帝都」
```
A wide desk-pad ground plate packed edge to edge with the grandest capital
complex: concentric rings of book-walls enclosing dense courtyards of binders
and rulers, stretched into a wide flat oval so the outermost ring's left and
right sides touch the very left and right edges of the picture frame — put
one short pen or pencil stub standing upright AT the far-left tip and another
AT the far-right tip of that ring (half a stub may crop off the frame edge,
that's fine), four more stubby spires of near-equal height spaced around the
rest of the ring, a broad central fountain-pen laid at a shallow angle with
its golden nib pointing forward, a monumental stapler-gatehouse spanning the
front edge between the inner rings, and dense ruler-line cross-hatching
throughout. The most magnificent of the set through density, layering and
footprint — NOT through height; no taller than Lv9. The two outermost spires
(far-left and far-right tips) are the widest points of the whole image,
clearly wider than Lv9. The stubby spires may be filled solid deep blue as
the pinnacle signal. Small gold-ink accents on the pen nib and a few spire
tips are the only exception to the two-tone palette.
[+ style with gold-accent exception]
```

**待办**：用户拿这 5 条 prompt 出图后，按 8-08 第三轮的流程核对（离线复现几何 + `contentWidthFrac`，达到或接近 0.9375 才采用），落地后照旧跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js`，未采用的候选图和被替换的旧图移入 `art/leftover/`。

### 2026-08-13（同日第二轮）：v2 prompt 出的图机位整体错了，未采用

用户按上面 5 条 v2 prompt 出图放进 `art/slg/slg-playerbase/`（`1790904c`→Lv.2、`fadb8a8c`→Lv.3、`8bca89bc`→Lv.6、`ac069d0a`→Lv.9、`a3e07823`→Lv.10）。目测核对，5 张全部**机位不对，未采用**，问题比"宽度不够"更根本：

- **画布不是正方形**：现有全套（`playerbase_l1` 等）都是 1254×1254；这 5 张是 1672×941 / 1536×1024 / 1704×923 等**横版长方形**。
- **构图不是旋转菱形地台**：现有正确图的地台画的是旋转45°的菱形（四角指向画布上/下/左/右，像扑克牌"♦"），这 5 张画的是"正面/略俯视看一张平铺长方形垫子"——有地平线、往远处延伸的透视，不是俯视机位。拼进等轴测地图后 `cityPlotMaskPoints` 拿菱形去裁一张长方形画面，形状对不上。
- **另外两张有独立的风格违规**：Lv.6（`8bca89bc`）、Lv.9（`ac069d0a`）地台上画出了方格网格线，违反"no grid lines"硬规；Lv.9 那张基本是纯蓝线稿，没有淡黄绿水彩填充，违反"严格双色调"硬规。

好消息：**宽度锚点这部分做对了**——护栏/书墙/塔尖确实顶到了画面边缘甚至裁出画布，v2 prompt 里"远端插旗/贴边裁切"那套指令本身有效，只是被套进了错的画布形状/机位里。因此 v3 不推翻内容，只把"旋转菱形地台 + 正方形画布 + 俯视机位"这条最关键的指令挪到每条 prompt **最前面**（原来只在末尾通用 style 里提一句"isometric diamond ground plate"，这次的生成工具显然没吃到），并在每条里点名参照 `playerbase_l1.png`/`l4.png`/`l7.png` 的机位；锚点内容原样保留。

### `playerbase_l2` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. This is NOT a front-facing tabletop diorama —
there is no horizon, no receding table edge, no vanishing point behind the
objects; the camera looks straight down at a gentle 25-degree tilt, matching
the look of playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A low camp covers about a third of the diamond: an open pencil case wall
extended by a row of laid-down pencils as a short palisade running out toward
the diamond's own far-left and far-right corners, with a tiny paper flag stuck
at each of those two corner tips (a flag may crop off the very edge of the
square frame, that's fine), a ruler laid flat as a bridge/gate at the front, a
squat ink bottle at one back corner, a small flat tent inside. Everything hugs
the plate and stays low; the diamond's left and right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l3` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A low stronghold of flat stacked notebooks covers about half the diamond,
forming a wall stretched so its own two ends reach the diamond's far-left and
far-right corners (put a single upright pencil stub at each of those two
corners, tip poking just past the frame edge if needed), book spines making
crenellations along the top, a stapler set into the middle of the wall as a
gate. Wide and squat — the wall is only two or three books high, and the
diamond's left/right corners are the widest points in the image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l6` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A stone-like fortress of thick hardcover books fills the diamond edge to edge:
its outer wall reaches the diamond's far-left and far-right corners, with a
correction-tape roll lying on its side as a squat round corner tower AT each
of those two corners (half a tower may crop off the frame edge, that's fine),
a broad low binder as the central keep, a ruler-and-compass drawbridge across
the front between the two corner towers. Heavy cross-hatching for stony
texture. Wide, heavy, low — the diamond's left/right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l9` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

An elaborate citadel complex overflows the diamond: several broad book-stack
blocks connected by ruler-walls into wings and courtyards that reach the
diamond's far-left and far-right corners, with one short pencil stub standing
upright AT the far-left corner and another AT the far-right corner (tips may
crop off the very edge, that's fine), two more pencil stubs at the back
corners as stumpy spires of barely varying height, a wide central binder-keep
flying a paper pennant, dense parallel ruler-lines suggesting grandeur. A
single small gold-ink accent on the far-right pencil tip as the only exception
to the two-tone palette. The diamond's left/right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from the small gold accent, notebook
doodle aesthetic, no text.
```

### `playerbase_l10` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame — NOT a circle or oval, and NOT a front-facing
tabletop diorama with a horizon; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

The grandest capital complex packs the diamond edge to edge: concentric rings
of book-walls enclosing dense courtyards of binders and rulers, the outermost
ring reaching the diamond's far-left and far-right corners — put one short pen
or pencil stub standing upright AT the far-left corner and another AT the
far-right corner (half a stub may crop off the frame edge, that's fine), four
more stubby spires of near-equal height spaced around the rest of the ring, a
broad central fountain-pen laid at a shallow angle with its golden nib
pointing forward, a monumental stapler-gatehouse spanning the front between
the inner rings, dense ruler-line cross-hatching throughout. NOT taller than
Lv9. The diamond's left/right corners are the widest points of the whole
image. The stubby spires may be filled solid deep blue as the pinnacle signal.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from small gold accents on the pen nib
and spire tips, notebook doodle aesthetic, no text.
```

**建议**：若生图工具支持传参考图，直接把 `playerbase_l1.png`/`l4.png` 当机位参考图传入，比纯文字描述"旋转菱形"更可靠——本轮翻车大概率是文字机位指令没被生成工具吃到，参考图能直接锁镜头角度。5 张未采用的候选图已移入 `art/leftover/`（保留原 UUID 文件名）。

### 2026-08-13（同日第三轮）：机位对了，但地台画得太陡——量出新问题、出 v4、Lv.2/3 命中

用户按 v3 prompt 先出了 Lv.2/Lv.3 两张（`7ffc6c01`→Lv.2、`135d6f06`→Lv.3）探路。机位终于对了（旋转菱形，不再是横版桌面），但离线核对 `contentWidthFrac` 反而比 v2 那批更差：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac |
|---|---|---|---|
| `7ffc6c01` | Lv.2 | 1.21 | 0.68（比 v2 的 0.89 还差） |
| `135d6f06` | Lv.3 | 1.17 | 0.66（比 v2 的 0.82 还差） |

排查：打包脚本按高度预算（`CONTENT_H_FRAC=0.5625`）和宽度预算（`CONTENT_W_FRAC=0.9375`）取先触底的一个整体等比缩放（`fit:'inside'`）——两者的比值 `0.9375/0.5625 ≈ 1.667` 就是"内容外接框宽高比"必须达到的门槛，低于它就会被高度先卡住、连带宽度也缩没了。能满宽的参照图（`playerbase_l1`/`l4`，宽高比 1.8~1.84）地台画得"扁"，上尖大致在画布 25% 高、下尖 75% 高；这两张新图的地台画得"陡"，上尖几乎顶到画布顶部（~8%）、下尖几乎顶到底部（~92%），外接框宽高比只有 1.17~1.21——机位对了，但地台自身的高宽比还停留在接近"正方形旋转45°"，没做成 2:1 的扁菱形。

修法：v3 prompt 开头那段"旋转菱形"指令后面追加"squashed FLAT"的具体比例锚点（上尖约在画布 1/4 高、下尖约在 3/4 高，参照 `playerbase_l1.png`/`l4.png` 的扁度），物体描述段落不变。用户按这条 v4 重出 Lv.2/Lv.3（`bf10f349`→Lv.2、`5ab60853`→Lv.3），离线核对：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 结论 |
|---|---|---|---|---|
| `bf10f349` | Lv.2 | 2.07 | **0.94（满宽）** | 采用 |
| `5ab60853` | Lv.3 | 2.11 | **0.94（满宽）** | 采用 |

两次失败的候选（v2 那批 `7ffc6c01`/`135d6f06`、更早的横版长方形批次）全部移入 `art/leftover/`。已改名覆盖 `playerbase_l2/3.png`，重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库；额外从合并后的 `world_atlas.png` 按 frame 坐标截出这两个 cell 的实际像素核对（不是只信打包脚本报的数字）——菱形贴边到 cell 边界，旗子/笔尖精确在角上裁出画布，跟 `playerbase_l1`/`l4` 一致。

**Lv.6/9/10 待办**：直接沿用这条 v4 的"压扁菱形"开头（"squashed FLAT... top corner ~1/4 down, bottom corner ~3/4 down"）替换各自 v3 prompt 的开头段落，物体描述段落不变，出图后重复同样的核对流程。

### `playerbase_l2` v4（已采用，供 l6/9/10 抄开头段落）
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down — leaving a generous margin of white space above and below,
matching the flat diamond proportions of playerbase_l1.png / playerbase_l4.png
(NOT the steeper, taller diamond you may have drawn before). This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt onto that flat diamond.

A low camp covers about a third of the diamond: an open pencil case wall
extended by a row of laid-down pencils as a short palisade running out toward
the diamond's own far-left and far-right corners, with a tiny paper flag stuck
at each of those two corner tips (a flag may crop off the very edge of the
square frame, that's fine), a ruler laid flat as a bridge/gate at the front, a
squat ink bottle at one back corner, a small flat tent inside. Everything hugs
the plate and stays low; the diamond's left and right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l3` v4（已采用）
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down — leaving a generous margin of white space above and below,
matching the flat diamond proportions of playerbase_l1.png / playerbase_l4.png
(NOT the steeper, taller diamond you may have drawn before). This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt onto that flat diamond.

A low stronghold of flat stacked notebooks covers about half the diamond,
forming a wall stretched so its own two ends reach the diamond's far-left and
far-right corners (put a single upright pencil stub at each of those two
corners, tip poking just past the frame edge if needed), book spines making
crenellations along the top, a stapler set into the middle of the wall as a
gate. Wide and squat — the wall is only two or three books high, and the
diamond's left/right corners are the widest points in the image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### 2026-08-13（同日第四轮）：Lv.6/9/10 用 v4 开头仍不够扁——竖起来的构件把外接框顶高了，出 v5

用户按 v4 开头（"squashed FLAT"）+ 各自 v3 物体描述重出了 Lv.6/9/10（`2d100fae`→Lv.6、`2972edb1`→Lv.9、`83228644`→Lv.10）。离线核对，三张**都不如现在线上的图**，未采用：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 对比现有线上图 |
|---|---|---|---|---|
| `2d100fae` | Lv.6 | 1.37 | 0.77 | 现有 0.85，新图更差 |
| `2972edb1` | Lv.9 | 1.34 | 0.75 | 现有 0.83，新图更差 |
| `83228644` | Lv.10 | 1.34 | 0.75 | 现有 0.84，新图更差 |

跟 Lv.2/3 那次不是同一个病：地台本身压得还行（不再是接近1:1的陡菱形），但 Lv.6/9/10 都比 Lv.2/3 多了**立起来的构件**——Lv.6 的修正带卷角楼、Lv.9/10 的铅笔角塔+旗子/笔尖——这些竖直元素把整体外接框往上抻高，宽高比停在 1.34~1.37，还是够不到命中满宽需要的 ≥1.667 门槛（对比 `playerbase_l1`/`l4`/`l7`——同样带旗子/塔尖但压得更矮，宽高比 1.67~1.84）。

修法：v4 的"压扁地台"开头不变，在物体描述段落后面加一句**具体的整体外接框比例自检**（"画一个包住画面里所有非白色内容——包括地台本身和任何竖起来的塔尖/旗子——的最小外框，宽必须至少是高的1.7倍；不够就把塔尖压得更矮"），逼着生成工具把塔尖/角楼画得更矮，而不是停留在"squat"这种形容词上。三张未采用的候选已移入 `art/leftover/`，图集未改动（现有 Lv.6/9/10 虽未满宽但比这批新候选更好，暂不替换）。

### `playerbase_l6` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down. This is NOT a front-facing tabletop diorama — no horizon, no
receding table edge; camera looks straight down at a gentle 25-degree tilt.

A stone-like fortress of thick hardcover books fills the diamond edge to edge:
its outer wall reaches the diamond's far-left and far-right corners, with a
correction-tape roll lying on its side as a squat round corner tower AT each
of those two corners (half a tower may crop off the frame edge, that's fine),
a broad low binder as the central keep, a ruler-and-compass drawbridge across
the front between the two corner towers. Heavy cross-hatching for stony
texture.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every tower sticking
up from it — that box's width must be at least 1.7 times its height. If the
corner towers you drew would make that box taller than that, shrink them:
make them noticeably SQUATTER and shorter, no taller than roughly one-fifth of
the plate's own width, until the whole silhouette reads clearly wider than
tall at that ratio.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l9` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down. This is NOT a front-facing tabletop diorama — no horizon, no
receding table edge; camera looks straight down at a gentle 25-degree tilt.

An elaborate citadel complex overflows the diamond: several broad book-stack
blocks connected by ruler-walls into wings and courtyards that reach the
diamond's far-left and far-right corners, with one short pencil stub standing
upright AT the far-left corner and another AT the far-right corner (tips may
crop off the very edge, that's fine), two more pencil stubs at the back
corners as stumpy spires of barely varying height, a wide central binder-keep
flying a paper pennant, dense parallel ruler-lines everywhere suggesting
grandeur. A single small gold-ink accent on the far-right pencil tip as the
only exception to the two-tone palette.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every pencil stub or
pennant sticking up from it — that box's width must be at least 1.7 times its
height. If the pencil stubs/pennant you drew would make that box taller than
that, shrink them: make them noticeably SQUATTER and shorter, no taller than
roughly one-fifth of the plate's own width, until the whole silhouette reads
clearly wider than tall at that ratio — grandeur through sprawl and line
density, nothing towers.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from the small gold accent, notebook
doodle aesthetic, no text.
```

### `playerbase_l10` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square) — NOT a circle or oval either. The diamond's
left and right corners touch the very edges of the frame, but its top corner
sits only about a quarter of the way down from the top of the canvas and its
bottom corner about three-quarters of the way down. This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt.

The grandest capital complex packs the diamond edge to edge: concentric rings
of book-walls enclosing dense courtyards of binders and rulers, the outermost
ring reaching the diamond's far-left and far-right corners — put one short pen
or pencil stub standing upright AT the far-left corner and another AT the
far-right corner (half a stub may crop off the frame edge, that's fine), four
more stubby spires of near-equal height spaced around the rest of the ring, a
broad central fountain-pen laid at a shallow angle with its golden nib
pointing forward, a monumental stapler-gatehouse spanning the front between
the inner rings, dense ruler-line cross-hatching throughout.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every spire or pen
sticking up from it — that box's width must be at least 1.7 times its height.
If the spires you drew would make that box taller than that, shrink them:
make every spire noticeably SQUATTER and shorter, no taller than roughly
one-fifth of the plate's own width, until the whole silhouette reads clearly
wider than tall at that ratio — it must not be taller than Lv9's silhouette.
The stubby spires may be filled solid deep blue as the pinnacle signal.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from small gold accents on the pen nib
and spire tips, notebook doodle aesthetic, no text.
```

### 2026-08-13（同日第五轮）：换用户出图工具为 GPT Image 2，v5 数字自检明显更好用；Lv.6 命中，Lv.9/10 待定

用户改用 GPT Image 2 出图，按 v5 prompt（含"外接框宽高比≥1.7 自检"那句）重出 Lv.6/9/10：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 结论 |
|---|---|---|---|---|
| `isometric_book_fortress.png` | Lv.6 | 1.66 | **0.93** | 采用，覆盖 `playerbase_l6.png`，已重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库 |
| `citadel_diamond_doodle.png` | Lv.9 | 1.53 | 0.86 | 比现有 0.83 有改善，但未到满宽，**待用户拍板**是否接受或再出一版 |
| `citadel_diamond_doodle_1024.png` | Lv.10 | 3.08 | 0.94（满宽） | 宽度达标，但外接框比 Lv.9 平了一倍多——画面主体比 Lv.9 矮很多，跟"Lv.10 不该比 Lv.9 矮"的硬规有点冲突，构图内容也换成了链环+台阶（不是原 prompt 的钢笔造型）。**待用户确认**是否满意这个方向 |

数字自检（"整体外接框宽高比≥1.7，不够就把塔尖压更矮"）这次效果明显比上一轮的"squat"形容词好——Lv.6 一次命中。Lv.9/Lv.10 两张候选先留在 `art/slg/slg-playerbase/`（未改名，不是 playerbase_lN 也不是 leftover），等用户决定采用/重出再处理。

### 2026-08-13（同日第六轮）：新出的 Lv.10 候选比例精准命中，采用；Lv.9 仍待定

用户又用 GPT Image 2 单独重出一张 Lv.10（webp 格式），离线核对：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | contentTop | 结论 |
|---|---|---|---|---|---|
| `Abh9kQ...na1fn...1024.webp` | Lv.10 | **1.78** | **0.94（满宽）** | 0.47 | 采用——跟 `playerbase_l1`/`l4`（宽高比 1.8~1.84）几乎同一区间，不是靠"压极扁"取巧命中宽度，是真按 2:1 菱形比例画出来的 |

跟上一版 `citadel_diamond_doodle_1024`（宽高比 3.08，靠整体压得极扁凑满宽，破坏"Lv.10 不该比 Lv.9 矮"的硬规）不同，这次比例、构图（钢笔金尖居中、四周铅笔角塔、订书机门楼+台阶）、画风（蓝墨线+淡黄绿水彩，金色点缀限定在钢笔/铅笔尖）都跟原 prompt 和现有 `l1`/`l4`/`l6` 一致，直接采用。

打包脚本原生支持 `.webp` 源文件（见脚本头注释"mixed png/webp AI-generation batch"），直接改名 `playerbase_l10.webp` 覆盖旧的 `playerbase_l10.png`（无需转格式），重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库，并从合并后的 `world_atlas.png` 截出实际 cell 像素核对（菱形贴边，跟 `l1`/`l4`/`l6` 同一水准）。被替换的旧图从 git 历史取出存进 `art/leftover/playerbase_l10_pre20260813.png`；上一版走偏的 `citadel_diamond_doodle_1024.png` 候选也移入 `art/leftover/`。

**Lv.9 仍待定**：`citadel_diamond_doodle.png` 候选（0.86，比现有 0.83 好但未到满宽）还留在 `art/slg/slg-playerbase/`，等用户决定接受还是再出一版冲满宽。**至此 10 张里已有 9 张（Lv.1/2/3/4/5/6/7/8/10）达到或接近满宽，只剩 Lv.9 待收尾。**

### 2026-08-13（同日第七轮）：Lv.9 v6 prompt 命中，10 张全部达标收口

针对上一轮 Lv.9 候选（0.86，宽高比 1.53）未到满宽的问题，出了 v6 prompt——在 v5 基础上做两处修改：①开头直接点名参照刚采用的 `playerbase_l10.png`（同样是"环形+四角立件"构图，比例已验证对了）；②自检句把目标提到 1.75:1 并明确"比照 l10 的 1.78:1"，追加"院落建筑也要压低压平"（怀疑上次不只是塔尖高，中间院落方块也偏高）。

用户用 GPT Image 2 按 v6 重出（`isometric_citadel_wide_diamond.png`），离线核对：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 结论 |
|---|---|---|---|---|
| `isometric_citadel_wide_diamond.png` | Lv.9 | **1.75** | **0.94（满宽）** | 采用——跟 Lv.10 的 1.78/0.94 几乎同一水准，"参照已命中的同构图等级 + 把自检数字提高"这个套路一次成功 |

覆盖 `playerbase_l9.png`，重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库，`world_atlas.png` 实际 cell 像素核对贴边无误。旧图存进 `art/leftover/playerbase_l9_pre20260813.png`，上一版未采用的 `citadel_diamond_doodle.png` 候选一并归档。

**10 张玩家基地图全部收口**，最终 `contentWidthFrac`：Lv.1 0.94 / Lv.2 0.94 / Lv.3 0.94 / Lv.4 0.94 / Lv.5 0.91 / Lv.6 0.93 / Lv.7 0.94 / Lv.8 0.91 / Lv.9 0.94 / Lv.10 0.94——全部达到或非常接近满宽（0.9375），且比例都落在 `l1`/`l4`/`l10` 那种真实 2:1 菱形区间内，不是靠压扁取巧。这轮返工过程中沉淀的两条经验，供以后同类返工参考：
1. **数字自检比形容词好使**："外接框宽高比≥X:1"这种可验证的具体数字，比"squat"/"wide"这类形容词更容易让生图工具真正执行到位（尤其是换到 GPT Image 2 之后更明显）。
2. **拿同批里已经命中的构图相近的等级当参照**，比抽象数字更直接——Lv.9/10 都是"环形+四角立件"构图，Lv.10 先命中后，直接让 Lv.9 参照它，一次成功。
