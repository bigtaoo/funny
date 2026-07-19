# Gacha 系统美术 — 图片生成 Prompt 文档

> 更新：2026-06-28
> 配套文档：[`design/game/GACHA_DESIGN.md`](../game/GACHA_DESIGN.md) §9 美术资源清单
> 美术总纲：[`design/product/art-direction.md`](art-direction.md)

---

## 使用说明

- **推荐工具**：Midjourney v6（最佳）/ DALL-E 3 / Stable Diffusion XL（写实向模型不适用）
- **风格基调**：手绘笔记本涂鸦，像一个学生在课堂上画的——铅笔/钢笔/马克笔三支笔，无渐变色，用平涂+交叉排线表达阴影，纸面有磨损感（折痕/暗角/墨水渗透）
- **禁忌**：渐变色、发光辉光、超过 5 种主色、数字设计感的精致效果——要 West of Loathing 的质感，不要 Cuphead 的质感
- **Midjourney 通用参数**：在每条 prompt 末尾加 `--style raw --no gradient, glowing effects, 3D rendering, shiny, CGI`
- 每张图建议生成 4 个变体后挑选，高频调整词见各条目「调整建议」

---

## P0 · 结果卡背景纹理（4 张）

> 这是翻牌动画的直接底图，风格决定整个拉卡体验的基调。
> 尺寸：**400×560px**（5:7 比例），竖版卡片。Midjourney 参数：`--ar 5:7`

---

### 1. `gacha_card_common.png` — 普通（灰）

**主题**：铅笔在普通横线本上随手画的页面。这张"不起眼"本身就是设计——它应该让玩家一眼觉得"就是个普通的，没啥"，反而衬托出高稀有度的视觉重量。

```
A worn notebook page used as a card background, portrait format.
Yellowish-cream lined paper with faint blue horizontal rules.
Corners slightly dog-eared and gray from pencil smudging.
Light pencil hatching texture in the margins, soft diagonal cross-hatching in bottom-right corner.
Small incidental pencil doodles at card edges: a tiny star, a arrow, a scribble.
Monochromatic gray pencil tones only. Matte paper texture, no shine.
Flat illustration, hand-drawn doodle art style, student notebook aesthetic.
No characters, no text, no gradients, no glow.
--ar 5:7 --style raw --no gradient, glowing, CGI, digital art, shiny
```

**调整建议**：如果灰度太暗，加 `very light pencil marks, faint`；如果感觉太空，加 `dense margin doodles, corner decorations`

---

### 2. `gacha_card_rare.png` — 稀有（蓝）

**主题**：不小心把钢笔墨水洒在页面上留下的美丽痕迹。蓝色钢笔墨水是游戏里的"我方色"，稀有度用它来升华。

```
A notebook page card background, portrait format, blue fountain pen ink theme.
Cream-yellow paper base with faint horizontal rules showing through.
Large organic fountain pen ink bleed/splash in the upper portion, deep royal blue, uneven edges with micro-feathering where ink soaked into paper fibers.
Smaller ink droplet clusters in two corners, varying sizes.
Thin single-line fountain pen border traced around the card edge, slightly wobbly, ink heavier at corners.
Blue ink tones only against cream paper. Matte paper texture.
Flat illustration, hand-drawn notebook aesthetic, stationery art style.
No characters, no text, no digital gradients, no glowing.
--ar 5:7 --style raw --no gradient, glow, CGI, shiny, smooth
```

**调整建议**：加 `fountain pen nibs visible at edges` 增加细节；墨水太实加 `watercolor bleed, transparent`

---

### 3. `gacha_card_epic.png` — 史诗（紫）

**主题**：紫色荧光笔大胆扫过的页面。马克笔那种蜡质、稍不均匀、压纸痕迹感——比钢笔粗犷，比铅笔强势。

```
A notebook page card background, portrait format, purple marker/highlighter theme.
Cream-yellow paper with visible paper grain texture.
Bold purple marker sweeps across most of the card — thick, confident strokes with slight streaking and uneven ink coverage (typical of alcohol markers), showing paper texture underneath.
The marker strokes overlap in 2-3 layers creating darker purple intersections.
Marker ink bleeds slightly at stroke edges, waxy and saturated.
Thin double-stroke marker border around the card edges.
Deep purple and cream tones only. Matte and slightly waxy texture.
Flat illustration, hand-drawn bold marker style, student art aesthetic.
No characters, no text, no digital gradients, no glowing effects.
--ar 5:7 --style raw --no gradient, glow, digital, smooth, CGI
```

**调整建议**：加 `grape purple, violet` 调色相；如太重加 `lighter marker pass, translucent strokes`

---

### 4. `gacha_card_legendary.png` — 传说（金）

**主题**：一页品质截然不同的纸——更厚、金色压花纹理、像从一本收藏级笔记本里撕下来的页面。撕裂的边缘、压花线条、金箔碎片。其他三张是"学生的普通本子"，这张是"这个孩子从某个地方得到的一张特别的纸"。

```
A premium notebook page used as a card background, portrait format, gold and cream theme.
Heavy cream-textured paper, clearly thicker and more refined than ordinary notebook paper.
Diagonal pale gold ruled lines (faint, embossed-looking) cover the surface.
Corners decorated with torn gold foil pieces — irregular, crinkled, slightly lifting from the page.
A fine double-line gold ink border around the card, slightly imperfect as if hand-traced.
Two small decorative pressed-flower or gold star sticker elements in opposite corners.
Top edge has a slightly torn, irregular paper texture as if carefully removed from a bound book.
Gold, cream, and ivory tones only. Matte paper with subtle metallic sheen ONLY on the gold foil pieces.
Flat illustration, premium stationery aesthetic, hand-drawn notebook art style.
No characters, no text, no digital gradients, no overall glowing.
--ar 5:7 --style raw --no gradient, glow, CGI, plastic, shiny background
```

**调整建议**：加 `antique gold, aged paper` 如果想要更旧；加 `bright gold leaf` 如果想更华丽；加 `minimal decoration` 如果太花哨

---

## P0 · 稀有度边框（4 款）

> 叠加在物品图片外圈，适合做 9-slice 拉伸（四角固定，四边可拉伸）。
> 尺寸：**240×240px** 正方形（展示用，源图越大越好，建议 480×480 生成后缩）
> 要求：**内圈透明**（需在生成后用 GIMP 抠出内圈透明），外框约占 20px 宽度

```
（通用说明：每张 prompt 后加）
Square decorative border frame only, the center must be EMPTY/transparent placeholder.
Frame width approximately 15-20% of total image width on each side.
Viewed from directly above, flat 2D, no perspective.
No background fill inside the frame, no object inside the frame.
Hand-drawn illustration style, notebook aesthetic.
--ar 1:1 --style raw --no background fill, 3D, shadow inside frame, object in center
```

---

### 5. `frame_common.png` — 普通边框

```
A hand-drawn double-line pencil rectangle frame, slightly crooked and imperfect.
Pencil sketch style, gray graphite marks on white.
The four corners have small pencil cross-hatch marks as corner accents.
Lines are slightly wobbly, not ruler-straight — drawn freehand by a student.
Thin inner line and slightly thicker outer line, both in pencil gray.
Center is empty/transparent. No fill, no pattern inside.
Flat 2D, minimal, clean. --ar 1:1 --style raw --no background, gradient, decoration inside
```

---

### 6. `frame_rare.png` — 稀有边框

```
A fine single-line fountain pen ink rectangle frame, hand-drawn.
Royal blue fountain pen ink, slightly heavier/darker ink pooling at the four corners (natural fountain pen behavior).
Ink slightly feathers at corners where it touched the paper longer.
Clean, elegant, precise but clearly hand-drawn (not ruler).
Small ink dot accents at corner midpoints.
Center is empty/transparent. No fill inside.
Flat 2D, stationery aesthetic. --ar 1:1 --style raw --no background, gradient, fill inside
```

---

### 7. `frame_epic.png` — 史诗边框

```
A bold thick marker rectangle frame, hand-drawn in purple.
Deep purple alcohol marker stroke, confident and slightly uneven coverage showing paper texture underneath.
Stroke is thick (marker-thick, not pen-thin), with slight streaking along the direction of drawing.
The four corners are rounded, slightly blob-like where the marker lingered.
Center is empty/transparent. No fill inside.
Flat 2D, bold marker art style. --ar 1:1 --style raw --no background, gradient, fill inside
```

---

### 8. `frame_legendary.png` — 传说边框

```
A decorative gold ink calligraphy-style rectangle border frame, hand-drawn.
Rich gold ink with slight metallic sheen (like gold ink pen), consistent brush-calligraphy line weight with slight swelling at brushstroke ends.
Small ornamental diamond or star accents pressed at the four corners, like tiny gold foil stamps.
Inner edge of the frame has a faint thin line echo (double border), outer edge is the main bold stroke.
Center is completely empty/transparent. No fill inside.
Flat 2D, premium stationery aesthetic, calligraphy art style.
--ar 1:1 --style raw --no background, gradient, fill inside, 3D
```

---

## P1 · 月卡卡面

### 9. `monthly_card.png` — 月卡

> 尺寸：**560×240px**（7:3 横版），Midjourney 参数：`--ar 7:3`
> 视觉感：从笔记本上撕下的一张便利贴/标贴，用于商城顶部展示，让玩家一眼认出"这是订阅"

```
A sticky note or detached notebook page designed as a monthly game subscription ticket/pass.
Warm yellow sticky note paper texture (classic canary yellow), horizontal format, slightly wider than tall.
Hand-lettered text area placeholder: a blank lined area suggesting where "月卡" title would go.
Decorative elements drawn in ballpoint pen: a small crescent moon in top-left, a simple 30-day calendar grid (6x5 squares with some filled in, representing a month), a bold circular stamp/seal in the top-right with decorative ring.
Bottom-right corner has a small star sticker and a perforated ticket stub edge (dashed line near right edge suggesting it can be torn).
Slight shadow underneath the sticky note, as if it's peeling off a surface.
Warm yellow, cream, and black/dark blue pen marks only. Hand-drawn doodle style, stationery aesthetic.
No text (leave blank for text overlay), no gradients, no digital effects.
--ar 7:3 --style raw --no gradient, glow, digital text, CGI
```

**调整建议**：如果太卡通加 `minimal decoration, clean`；如果太空加 `dense calendar details, doodle border`

---

## P1 · 限定池 Banner

### 10. `banner_limited_01.png` — 首期限定 Banner

> 尺寸：**900×340px**（约 8:3 横版），Midjourney 参数：`--ar 8:3`
> 首期限定主题：陶的限定皮肤（名字待定，以"墨迹上将"为占位）
> 左半角色立绘区 + 右半文字区（文字用程序叠加，prompt 里留空白）

```
A game gacha banner illustration in notebook doodle art style, landscape format.
Left two-thirds: A young Asian teenage boy (around 15-16 years old) in a stylized military commander costume made of stationery items — his armor is constructed from layered notebook pages, his cape is flowing graph paper, his weapon is an oversized fountain pen held like a sword/scepter.
The character has bold confident pose, facing slightly right, rendered in hand-drawn ink line art with blue-ink color scheme (fountain pen blue as the primary color).
Heavy ink outlines, flat color fills with cross-hatching for shadows, no gradients.
Background behind character: splashes and drips of dark blue-black ink spreading outward like an explosion, on cream notebook paper texture.
Right one-third: a clean cream-colored notebook page area, mostly empty (for text overlay), with faint horizontal rules, a red circular "LIMITED" stamp impression in upper area.
Along the bottom edge: a decorative border of small ink splatter dots.
Overall: hand-drawn doodle art, student notebook aesthetic, bold and striking.
No gradients, no glowing effects, no 3D rendering.
--ar 8:3 --style raw --no gradient, glow, CGI, smooth shading, realistic
```

**调整建议**：
- 角色太写实加 `stick figure style, simplified shapes, cartoon`
- 角色太卡通加 `detailed ink illustration, confident linework`
- 背景太乱加 `minimal ink splash, clean background`

---

## P2 · 常驻池 Banner

### 11. `banner_standard.png` — 常驻池 Banner

> 尺寸：**900×340px**（约 8:3 横版），Midjourney 参数：`--ar 8:3`
> 感觉：轻松、"随时都在"、不抢镜，画面感像"一个铺满文具的笔记本摊开在桌上"

```
A game gacha banner illustration in notebook doodle art style, landscape format, warm and welcoming tone.
A spread-open notebook lying flat, viewed from slight above angle. The notebook pages are filled with hand-drawn stationery items arranged as if collected:
Left page: pencils, pens, erasers, rulers, paper clips drawn in pencil sketch style, arranged in a loose flat-lay composition.
Right page: a few colorful marker-drawn items (purple marker, blue fountain pen, gold ballpoint) with small doodle decorations — tiny stars, arrows, brackets.
Between the pages: some items slightly overlapping the center spine.
Cream and warm tones for the notebook, with the stationery items in pencil gray, blue, purple, and gold.
Very light and airy composition, not crowded. Felt-tip pen borders on each page.
Flat illustration, top-down view, hand-drawn stationery art, notebook aesthetic.
No characters, no text, no gradients, no glowing.
--ar 8:3 --style raw --no gradient, glow, CGI, 3D, shadows, dark
```

**调整建议**：加 `bird's eye view, perfectly flat lay` 如果需要更俯视；加 `cozy and warm` 如果氛围不够温馨

---

## 附：物品图标模板 Prompt

> 适用于后续各池内皮肤/装备/材料的方形图标。尺寸：**120×120px** (`--ar 1:1`)

### 皮肤图标（通用模板）

```
A small square icon of [具体物品描述], notebook doodle art style.
Hand-drawn ink illustration, flat color with hatching for shadows.
[主色调] color scheme. Simple, readable at small size (60x60 display).
Centered subject on transparent or white background.
Bold ink outlines, minimal detail, stationery/notebook aesthetic.
--ar 1:1 --style raw --no gradient, glow, 3D, realistic
```

> 替换 `[具体物品描述]` 和 `[主色调]`（上线皮肤目录 6 款，每角色 1 款，见 `GACHA_DESIGN §9.5`）：
> - `skin_shop_c1`（陶·李川/Infantry，商店 common）：`a simple stickman soldier drawn in pencil`, `gray pencil`
> - `skin_shop_r1`（陶·苏远/Archer，商店 rare）：`a neat stickman archer with fountain pen details`, `royal blue`
> - `skin_shop_e1`（陶·陈守/ShieldBearer，商店 epic）：`an elaborate stickman shield bearer with marker-drawn armor`, `deep purple`
> - `skin_e1`（Anna·Lena，抽卡 epic）：`an elaborate sentinel warrior with marker-drawn detail`, `deep purple`
> - `skin_e2`（Anna·Mara，抽卡 epic）：`a sleek marksman with marker-drawn detail`, `deep purple`
> - `skin_l1`（Anna·Max，抽卡 legendary·旗舰）：`a majestic armored commander with gold ink details`, `gold and cream`

### 文具材料图标（通用模板）

```
A small square icon of [文具物品] as crafting material in a game.
Drawn in hand-sketched notebook style, pencil and ink marks.
Simple centered object, white or transparent background.
Clear silhouette, readable at 60x60 pixels.
Stationery/school supply aesthetic, student notebook art style.
--ar 1:1 --style raw --no gradient, glow, 3D
```

> 替换 `[文具物品]`：
> - `mat_scrap`：~~`pile of torn paper scraps and pencil shavings`~~ → 2026-07-19 换成单体剪影版（原版多形状+撞色，缩小到签到格子 ~28px 糊成一团），见下方专用 prompt
> - `mat_lead`：`three pencil lead sticks, mechanical pencil refills`
> - `mat_binding`：`a small metal ring binder clip`
> - `wp_pen`：`a fountain pen nib and cap, slightly open`
> - `ar_cardstock`：`a small stack of thick cardstock papers`
> - `tk_bookmark`：`a simple paper bookmark with tassel`
> - `wp_marker`：`an uncapped purple alcohol marker`
> - `ar_leather`：`a small piece of leather notebook cover material`
> - `tk_sticker`：`a sheet of small decorative stickers`
> - `wp_highlighter`：`a gold metallic highlighter marker`
> - `ar_foil`：`crinkled gold foil sheet, partially unrolled`
> - `tk_seal`：`a wax seal stamp with star impression`

### `mat_scrap` 专用 prompt（2026-07-19 替换，见 EQUIPMENT_DESIGN §20.12）

原通用模板的 `pile of torn paper scraps and pencil shavings` 天生是多体堆叠（撕纸+铅笔屑+散落黑点，两种撞色），签到日历格子里图标只有 ~28px，糊成一团色块。改用单体折页剪影，颜色和阴影处理对齐 `lead`/`binding`：

```
A small square icon of a single torn notebook-paper scrap, folded once with
a jagged torn edge, punched ring-binder holes visible, as crafting material
in a game.
Drawn in hand-sketched notebook style, pencil and ink outline, cross-hatch
shading for depth.
Cream/off-white paper with warm tan shadow tones, faint blue ruled lines,
solid black binder holes — same warm muted palette as a used school notebook.
One bold silhouette only — no scattered pieces, no confetti dots, no second
bright accent color.
Simple centered object, white or transparent background.
Clear thick outline, readable at 40x40 pixels.
Stationery/school supply aesthetic, student notebook art style, matching the
shading style of a bundle of pencils and a spiral binder ring icon in the
same set.
--ar 1:1 --style raw --no gradient, glow, 3D, multiple objects, pile, pure line art, no color
```
