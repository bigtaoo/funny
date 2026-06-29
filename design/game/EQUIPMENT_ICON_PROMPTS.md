# 装备图标 AI 生成 Prompt

> 权威：[`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md) §20.2 / §17.2  
> 用途：AI 图像工具（Midjourney / DALL-E / Stable Diffusion 等）生成 12 张装备图标位图  
> 更新：2026-06-29

---

## 通用风格基底（所有 prompt 均附加此段）

```
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

> **注意**：生成后统一放入 `client/assets/equipment/<defId>.png`，尺寸标准 256×256，支持 2× 缩放至 128×128 背包格仍清晰可辨。

---

## 武器槽 Weapon（`wp_`）

### wp_pencil — 铅笔（普通 Common）

```
a wooden pencil standing upright at slight angle, freshly sharpened graphite tip,
yellow paint barrel with "HB" label, pink eraser cap, pencil shavings at base,
color palette: warm gray #9aa0a6, golden yellow, pale wood,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### wp_pen — 钢笔（精良 Fine）

```
a classic fountain pen at slight angle, ink-stained nib visible at tip,
dark navy barrel with gold trim clip, ink drop at nib,
color palette: ink blue #4477cc, deep navy, gold accent,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### wp_marker — 马克笔（稀有 Rare）

```
a thick art marker at slight angle, bold chisel tip, uncapped with cap beside it,
vibrant orange barrel, ink smear streak below tip,
color palette: marker orange #e08a2c, burnt orange, off-white,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### wp_highlighter — 荧光笔（史诗 Epic）

```
a highlighter pen at slight angle, wide chisel tip, semi-transparent fluorescent body,
purple barrel with gold foil label, luminous glow halo around tip,
color palette: fluorescent purple #aa55cc, gold #d9b44a, electric glow,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

## 护具槽 Armor（`ar_`）

### ar_draft — 草稿纸（普通 Common）

```
a small stack of draft paper sheets, slightly crumpled, pencil sketch lines visible on top sheet,
torn edge on one corner, grid or plain ruled pattern, slight fold crease,
color palette: paper white, pencil gray #9aa0a6, warm off-white,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### ar_cardstock — 卡纸（精良 Fine）

```
a rigid piece of cardstock / Bristol board, slightly glossy surface with subtle texture,
neat rounded corners, faint ruled lines, small ink pen mark in corner,
color palette: blue-tinted white, ink blue #4477cc border stripe, cool gray,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### ar_leather — 皮面封皮（稀有 Rare）

```
a leather notebook cover, closed and upright, worn stitched edges,
burnished texture, small brass clasp or strap closure,
color palette: cognac brown, warm orange #e08a2c accent stitching, aged leather tan,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### ar_foil — 烫金封皮（史诗 Epic）

```
a hardcover notebook with gold foil embossed cover, regal ornamental pattern,
deep purple cloth spine, corner metal protectors, foil catches light,
color palette: deep purple #aa55cc, gold foil #d9b44a, matte black,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

## 饰品槽 Trinket（`tk_`）

### tk_clip — 回形针（普通 Common）

```
a large paper clip, classic looped wire shape, slightly bent as if used,
simple metallic finish, casting a faint sketch shadow,
color palette: silver-gray #9aa0a6, light steel, subtle wire sheen,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### tk_bookmark — 书签（精良 Fine）

```
a fabric or ribbon bookmark with tassel at bottom, slightly curved,
ink-blue ribbon with small gold printed pattern, tassel threads loose,
color palette: ink blue #4477cc, gold thread, cream ribbon,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### tk_sticker — 贴纸（稀有 Rare）

```
a cute sticker sheet showing one peeled sticker being lifted, star or stamp shape,
vibrant orange and white pattern, peel edge visible with slight curl,
color palette: marker orange #e08a2c, warm white, bright accent,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

### tk_seal — 火漆印（史诗 Epic）

```
a wax seal stamp tool with ornate handle, pressed wax circle below showing embossed crest,
deep purple wax, gold handle with intricate engraving, wax slightly dripping,
color palette: royal purple #aa55cc, gold #d9b44a, dark crimson wax,
flat icon illustration, hand-drawn stationery item, notebook game aesthetic,
clean sketch linework with slight pencil texture, centered composition,
transparent background, no gradients, no shadows, icon-optimized silhouette,
square 1:1 aspect ratio, 256x256
```

---

## 使用备注

1. **一致性**：同批次生成时，在 Midjourney 用 `--style` 参数固定风格种子；DALL-E 可在同 session 内连续生成保持一致。
2. **背景处理**：生成后若背景不透明，用 remove.bg 或 Photoshop 选区删除；边缘保留素描线风格不要过度抠图。
3. **尺寸**：输出 256×256 PNG，`client/assets/equipment/` 目录。文件名即 `defId`（如 `wp_pencil.png`）。
4. **稀有度边框不在图内**：边框由程序叠加（`EQUIPMENT_DESIGN.md` §20.2），图标本身只出文具主体 + 对应颜色倾向，不画边框。
5. **等级指示器不在图内**：同上，程序绘制叠加（§20.6）。
