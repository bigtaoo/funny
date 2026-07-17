# 商店卡片美术 — 图片生成 Prompt 文档

> 更新：2026-07-17
> 配套代码：[`client/src/scenes/ShopScene/shop.ts`](../../client/src/scenes/ShopScene/shop.ts)（`buildShopCards()` 里的 `artUrl` 接线）
> 美术总纲：[`design/product/art-direction.md`](art-direction.md)
> 同类文档：[`gacha-art-prompts.md`](gacha-art-prompts.md) · [`design/game/EQUIPMENT_ICON_PROMPTS.md`](../game/EQUIPMENT_ICON_PROMPTS.md)

---

## 背景

商店卡片原本用矢量图标（`coinChest`/`trophy`/`capsule`/`gift`/`armor`）。改为图片后：

- **皮肤**：复用角色卡图占位（infantry / archer / shieldbearer），暂不重画。
- **月卡**：复用已有 `client/src/assets/gacha/monthly_card.png`（蓝笔便签票根），不重新生成。
- **本文档的 4 张**：年卡 / 强化保护石 / 新手抽卡礼包 / 新手成长礼包。生成后**同名覆盖**下列文件即可，无需改代码。

| 卡片 | 目标文件 | 代码位置 |
|---|---|---|
| 年卡 Year Card | `client/src/assets/shop/year_card.png` | `shop.ts` yearCard spec |
| 强化保护石 Enhance Protection Stone | `client/src/assets/shop/protect_stone.png` | `shop.ts` `protect_enhance` item |
| 新手抽卡礼包 | `client/src/assets/shop/starter_draw.png` | `shop.ts` `starter_draw` pack |
| 新手成长礼包 | `client/src/assets/shop/starter_growth.png` | `shop.ts` `starter_growth` pack |

> ✅ 这 4 张已出图 + 打包 + 接入（2026-07-17）。源图（白底 webp/png）在 `art/ui/shop/`，打包脚本见下。

## 打包 / 压缩 / 加载

- **源图**：`art/ui/shop/`（AI 出图，白底，全彩金色 doodle）。
- **打包脚本**：[`art/ui/shop/pack_shop.cjs`](../../art/ui/shop/pack_shop.cjs)（复用 client 的 `sharp`，沿用 decos-b 抠白底口径，但**不改色**——商店图是全彩，保留原 RGB；额外做调色板量化压缩）。流程：近白背景抠成透明（亮且低饱和 = 纸底）→ 裁透明留白 → 长边缩到 512 → 调色板 PNG 输出到 `client/src/assets/shop/`。
- **改图后重跑**：`node pack_shop.cjs`（`JOBS` 里改源文件名/资产名）。
- **产物**：4 张透明 PNG，各 ~100–140KB（源 227KB–1.9MB）。
- **加载**：无需额外代码——[`shop.ts`](../../client/src/scenes/ShopScene/shop.ts) 直接 `import` 这些路径作 `CardSpec.artUrl`，`ShopSceneBase.drawCard` 走已有的 `getArtTexture` 贴图路径（与皮肤同源）。
- **注**：背景已在打包时抠成透明，卡片把图画在米白纸面（`#F5F0E8`）上无白边（已验证 composite 无 fringe）。

---

## 使用说明

- **推荐工具**：Midjourney v6（最佳）/ DALL-E 3 / Stable Diffusion XL
- **尺寸**：**1:1 正方形**（商店卡里按方形小图渲染），建议 1024×1024。
- **背景**：**必须透明**（卡片直接把图画在米白纸面上，白底会露出一个白方块）。生成时若只能出白底，交给我跑一遍 `sharp` 白底转透明即可（同 decor 打包口径 `art/ui/decos/pack_decos.cjs`）。
- 单个居中主体，**无边框**。
- 每张建议生成 4 个变体后挑选。

### 风格铁律（对齐 [`art-direction.md`](art-direction.md) §3.4 / §6.2）

第一版出图翻车的教训——模型默认给了「精致贴纸」，踩了总纲三条红线，务必写死：

1. **线条**：细、抖、潦草的钢笔线（"课上 10 秒随手画"），**不是**粗、均匀、干净的卡通描边 / 矢量描边。
2. **上色**：平涂暖金/琥珀 + 交叉排线(cross-hatching)表现体积，**哑光纸感**；**禁**渐变、**禁**高光反光、**禁**发光、**禁**水彩晕染。
3. **调性**：West of Loathing（潦草即态度），**不是** Cuphead（精致）。参照仓库里的 `client/src/assets/shop/coins.png`（平涂金+墨线+排线）和 `gacha/monthly_card.png` 就是正确档位。

### 共用前缀（贴在每条主体前）

```
Hand-drawn doodle icon for a game shop item, drawn in a worn school notebook.
Loose dark-ink pen line art with slightly wobbly, imperfect, quick strokes —
a careless 10-second margin sketch, NOT a clean polished sticker. Flat warm
gold / amber marker fill with light pencil cross-hatching for volume — matte
paper look, NO smooth gradient, NO glossy highlights, NO shine, NO glow.
Thin-to-medium wobbly ink outline, NOT a thick uniform cartoon outline.
Single object centered, filling the frame, on a plain pure-white background,
no grid lines, no other elements. Flat 2D. Style of West of Loathing doodle
art (loose and characterful), NOT Cuphead (not polished).
```

### 共用负向提示

```
gradient, glossy highlights, shiny, gloss, glow, painterly, soft shading,
watercolor, watercolor bleed, 3d render, photorealistic, thick bold uniform
outline, clean vector, sticker, cel-shaded, drop shadow, multiple objects,
watermark, gray background, notebook grid lines
```

> Midjourney 末尾追加：`--ar 1:1 --style raw --no gradient, glossy, shiny, glow, 3D, thick clean outline, vector, sticker, drop shadow`

---

> 下面 4 条均为**完整可直接复制**的 prompt（已内嵌风格前缀 + 负向 + 参数）。

## 1. `year_card.png` — 年卡 Year Card

**主题**：比月卡更贵重的年度会员通行证。月卡是普通便签票根，年卡要「更高级、更值钱」——金色票券 + 小皇冠 + 星光；票面手写数字 "365"。

```
Hand-drawn doodle icon for a game shop item, drawn in a worn school notebook.
A premium annual pass: a warm-gold ticket / coupon with a dashed tear-edge, a
hand-scrawled "365" across it, a small lopsided crown doodle on top and a couple
of four-point sparkle marks around it. Should read grander than a plain ticket.
Loose dark-ink pen line art, slightly wobbly imperfect quick strokes — a careless
10-second margin sketch, NOT a clean polished sticker. Flat gold/amber marker fill
with light pencil cross-hatching for volume — matte paper look, NO gradient, NO
glossy highlights, NO shine, NO glow. Thin-to-medium wobbly ink outline, NOT a
thick uniform cartoon outline. Single object centered, filling the frame, plain
pure-white background, no grid lines. Flat 2D. Style of West of Loathing doodle
art, NOT Cuphead.
--ar 1:1 --style raw --no gradient, glossy, shiny, glow, 3D, thick clean outline, vector, sticker, drop shadow, watercolor
```

**调整建议**：若线条又变干净，加 `rough scratchy pen, uneven line weight`；若"年度/贵重"感不足，加 `ornate crown, VIP`。

---

## 2. `protect_stone.png` — 强化保护石 Enhance Protection Stone

**主题**：强化失败时防止材料损失的保护道具。符文宝石 / 护身石，带盾牌意象。**注意别再出光滑水彩蛋**——要平涂 + 排线的哑光石头。

```
Hand-drawn doodle icon for a game shop item, drawn in a worn school notebook.
A protective rune-stone: a rounded gem / pebble with a small shield emblem
scribbled on its face and a few short radiating "protection" tick-lines around it.
Loose dark-ink pen line art, slightly wobbly imperfect quick strokes — a careless
10-second margin sketch, NOT a clean polished sticker. Flat gold/amber marker fill
with light pencil cross-hatching for volume — matte paper look, NO gradient, NO
glossy highlights, NO white shine dots, NO glow, NO watercolor bleed. Thin-to-medium
wobbly ink outline, NOT a thick uniform cartoon outline. Single object centered,
filling the frame, plain pure-white background, no grid lines. Flat 2D. Style of
West of Loathing doodle art, NOT Cuphead.
--ar 1:1 --style raw --no gradient, glossy, shiny, glow, 3D, thick clean outline, vector, sticker, drop shadow, watercolor
```

**调整建议**：若还是光滑，狠加 `matte, no shine, flat fill, pencil hatching only`；盾牌不明显加 `clear shield doodle`。

---

## 3. `starter_draw.png` — 新手抽卡礼包

**主题**：送新手的抽卡礼包。礼物盒 + 扭蛋 + 弹出的英雄卡。

```
Hand-drawn doodle icon for a game shop item, drawn in a worn school notebook.
A starter gacha gift pack: a small opened gift box with a gacha capsule and two
or three fanned cards popping out, a scribbled ribbon, a couple of sparkle marks.
Loose dark-ink pen line art, slightly wobbly imperfect quick strokes — a careless
10-second margin sketch, NOT a clean polished sticker. Flat gold/amber marker fill
with light pencil cross-hatching for volume — matte paper look, NO gradient, NO
glossy highlights, NO shine, NO glow. Thin-to-medium wobbly ink outline, NOT a
thick uniform cartoon outline. Single object centered, filling the frame, plain
pure-white background, no grid lines. Flat 2D. Style of West of Loathing doodle
art, NOT Cuphead.
--ar 1:1 --style raw --no gradient, glossy, shiny, glow, 3D, thick clean outline, vector, sticker, drop shadow, watercolor
```

**调整建议**：卡片不清楚加 `cards clearly fanned`；太乱减到 `just a gift box and one capsule`。

---

## 4. `starter_growth.png` — 新手成长礼包

**主题**：帮助新手成长的礼包。成长/升级意象——向上箭头 + 经验球 + 钱袋。

```
Hand-drawn doodle icon for a game shop item, drawn in a worn school notebook.
A starter growth bundle: a small treasure pouch with a big upward level-up arrow
rising out of it and a round XP orb beside it, a couple of sparkle marks.
Loose dark-ink pen line art, slightly wobbly imperfect quick strokes — a careless
10-second margin sketch, NOT a clean polished sticker. Flat gold/amber marker fill
with light pencil cross-hatching for volume — matte paper look, NO gradient, NO
glossy highlights, NO shine, NO glow. Thin-to-medium wobbly ink outline, NOT a
thick uniform cartoon outline. Single object centered, filling the frame, plain
pure-white background, no grid lines. Flat 2D. Style of West of Loathing doodle
art, NOT Cuphead.
--ar 1:1 --style raw --no gradient, glossy, shiny, glow, 3D, thick clean outline, vector, sticker, drop shadow, watercolor
```

**调整建议**：「成长」感不足强调 `big upward arrow, level-up`；元素太多去掉钱袋 `just an upward arrow and an XP orb`。
