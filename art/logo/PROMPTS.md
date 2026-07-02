# Logo / 图标 — AI 出图 Prompt 记录

> 本文档记录 Nivara 品牌 logo（盾徽 + 文具三笔）迭代过程中实际使用的 AI 出图 prompt，供后续补图 / 重出 / 换风格时直接取用。
> 拍板见 [`design/DECISIONS.md`](../../design/DECISIONS.md) ADR-027，全貌见 [`design/product/art-direction.md`](../../design/product/art-direction.md) §13。
> 参数：`--ar 1:1`（图标为方形）；Midjourney 加 `--style raw --v 6`。每档抽 4 图挑选。

---

## 0. 迭代脉络（拍板点）

1. 方向：**盾徽为主体 + 文具三笔作盾面徽记**（钢笔蓝 / 铅笔琥珀 / 马克笔红）。
2. 配色：**蓝主导**（我方蓝），红仅点缀。
3. 纸纹：**明显**（品牌点）。
4. **不带字**（AI 出字必糊）；字标 Nivara 后期用真实字体单独排。
5. 交叉遮挡坑：胶带盖住三笔交叉处时，AI 画不对遮挡后的笔身连续性（下半段乱接/全变蓝）→ 最终**出图不画胶带**，master 版胶带由 GIMP 后期补。
6. 大 / 小双版本：master 细节版（≥128px）；simple 扁平版（≤64px，小尺寸不糊）。

---

## 1. master 主图 —— 最终采用版（盾徽 · 三笔交叉 · 无胶带）

> `art/logo/logo.png` 即由此版生成后，用户 GIMP 抠透明底 + 后期补胶带而来。

```
Game logo icon, a rounded shield crest with a soft U-shaped bottom, drawn
in a hand-drawn notebook doodle style with bold navy ink outlines and flat
colors. The shield face is cream ruled notebook paper with clearly visible
blue horizontal ruled lines and a bold red vertical margin, prominent paper
texture. Three stationery pens cross in a clear X on the shield face, large
and filling most of the shield, tips fanning upward near the top: a big
dominant blue fountain pen in the center, an amber wooden pencil, and a
smaller red marker as an accent. Each pen is ONE continuous unbroken piece
from tip to tail, fully visible where they overlap, correct over-and-under
crossing, colors never blending between pens. Blue is the dominant color,
red only a small accent. Balanced composition filling the shield top to
bottom, nothing binding or wrapping the pens. Centered, plain off-white
background. Clean, playful, high contrast, clear silhouette. App icon.
No text.
```

**负向：**

```
tape, masking tape, ribbon, band, string, rope, anything wrapping or
binding the pens, text, letters, words, typography, watermark, signature,
photorealistic, 3D render, glossy, metallic, gradient mesh, drop shadow,
neon glow, cluttered, extra objects, realistic hands, busy background,
sharp gothic pointed shield, red-dominant, discontinuous pen, broken pen,
mismatched pen halves, color bleeding between pens, all-blue bundle,
overly detailed, low contrast, blurry
```

**防翻车关键词**：`Each pen is ONE continuous unbroken piece from tip to tail` + `correct over-and-under crossing`（逼交叉上下段接对）；`nothing binding or wrapping the pens` + 负向 `tape/ribbon/band`（不自作主张加带子）。

---

## 2. simple 小图标 —— 最终采用版（扁平 · ≤64px）

> `art/logo/logo-simple.png` 即由此版生成。去纸纹 / 去排线 / 去胶带，只留可辨识骨架，保证 32px 不糊。

```
Minimalist flat app icon, simple bold emblem. A rounded shield with a soft
U-shaped bottom, thick navy outline, solid cream fill (no paper texture, no
ruled lines). On the shield, three stationery pens crossed in a simple X:
a bold blue fountain pen upright in the center (dominant), one amber pencil
and one red marker crossing behind it. Flat solid colors only, thick clean
outlines, no shading, no gradient, no texture, no tape. Extremely simplified,
high contrast, instantly readable at 32 pixels. Centered, transparent
background. No text.
```

**负向：** `texture, ruled lines, paper grain, gradient, shading, tape, thin lines, fine detail, realistic, 3D, text`

---

## 3. 历史迭代版（存档，非最终；备回溯 / 换风格参考）

### 3a. 首版方向 A — 手绘笔记本风（带胶带、平衡三色）

```
Game logo icon, a rounded shield crest with a soft U-shaped bottom (not a
sharp pointed shield), drawn in a hand-drawn notebook doodle style. The
shield face is cream ruled notebook paper with clearly visible blue
horizontal ruled lines and a bold red vertical margin, prominent paper
texture. On the shield, three stationery pens fan upward as the central
emblem: a large dominant blue fountain pen in the center, flanked by a
smaller warm amber wooden pencil and a small red marker as an accent,
crossing near the base and bound by a strip of masking tape. Blue is the
dominant color, red used only as a small accent. Bold confident ink
outlines, flat colors, playful and clean. Centered composition, plain
off-white background. Vector-friendly, high contrast, clear silhouette
that reads at small sizes. App icon. No text.
```

### 3b. 方向 B — 矢量扁平 / 徽章气质（带胶带）

```
Flat vector logo, minimalist emblem badge. A rounded shield with a soft
curved U-shaped bottom (no sharp tip). Three crossed stationery tools form
the crest: a large dominant blue fountain pen at center, a graphite pencil,
and a small red marker as an accent, fanned upward and tied with a small
band at the crossing. Blue is the dominant color, red is a minor accent.
Cream shield face with clearly visible notebook paper ruled lines and
strong paper texture. Thick clean outlines, limited palette led by blue
with red accent, plus cream and amber. Bold, iconic, symmetrical, centered,
white background. Highly legible at 32px. Modern mobile game app icon.
No text, no letters.
```

### 3c. 微调 v2 — 笔簇上移放大 + 胶带收窄 + 露出交叉（后被「无胶带」版取代）

在 3a 基础上改动：
- `three stationery pens fan upward as the central emblem, large and filling most of the shield face, their tips reaching near the top`
- `The three pens cross in a clearly visible X near the lower-middle of the shield, and are bound by a NARROW strip of masking tape that leaves the crossing point exposed`
- 负向补：`wide tape covering the crossing, empty space at top`

> v2 暴露了「胶带遮挡处笔身接不上」的问题 → 决定改为 §1 的无胶带版，后期补胶带。

---

## 4. 备用解法（未采用，存档）

- **花束式收束**（不交叉，从底部一点向上发散，避免遮挡连续性问题）：主体加
  `Three stationery pens rise from a single binding point at the bottom and fan upward like a bouquet, WITHOUT crossing over or overlapping each other ... each pen a single continuous piece from tip to base`；负向 `crossed pens, pens overlapping`。
- **局部重绘（inpaint）**：只框选胶带以下区域，提示 `continue the three pens: amber left, blue center, red right`。
