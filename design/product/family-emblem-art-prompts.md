# 家族/宗门徽章美术 — 图片生成 Prompt 文档

> 创建：2026-08-14 · **✅ 24/24 出图完成 + 已打包接入 + 功能接入全部完成（2026-08-14 同日）**：源图在
> `art/icons/`（命名 `emblem_<key>.webp`），图集 + 功能接入（字段/权限/选择器 UI/四处展示面/行军令牌角标）
> 见 §「产出 → 接入流程」。
> 缺口来源：[`design/game/WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) §五 TODO（"等专门的行军动画素材（含旗帜/头像等帮会标识）出图后替换 `MARCH_TOKEN_ASSET`；目前旗帜/头像暂不做，涉及帮会图标体系，留待后续"）——该 TODO 已解决，见下方"已知遗留"：不是替换，是叠加角标（与 2026-07-26 的领队兵种展示决策共存）。
> 数据结构依据：[`server/shared/src/slg/core.ts`](../../server/shared/src/slg/core.ts)（`familyId`/`sectId`/`FamilyRole`）、[`SLG_DESIGN.md`](../game/SLG_DESIGN.md) §2/§4（宗门≤30家族≤900人，家族≤30人）
> 美术总纲：[`art-direction.md`](art-direction.md)
> 同类文档：[`gacha-art-prompts.md`](gacha-art-prompts.md)（稀有度边框同为"单色线稿+程序处理"套路）· 阵营图腾参考：`art/ui/camps/pack_faction_atlas.js`（tao 龙纹章 / anna 鹰纹章，白线单色+运行时 tint 的先例，本文档沿用同一契约）

---

## 产品方案（已与用户确认，2026-08-14）

- **固定一批徽章供玩家选**：出 **24 套**图腾，家族、宗门创建/改标识时从同一套池子里选一个（不做"自定义拼图案"，控制出图量和实现复杂度）。
- 家族（≤30人小团体）和宗门（≤30家族的大区势力）**共用同一套池**，靠"是否被同宗门/同家族其他成员占用"或干脆不做占用限制（产品细节留给功能设计阶段，本文档只覆盖美术）。
- 世界地图上行军令牌/驻军标识替换 `MARCH_TOKEN_ASSET` 占位——这是本次出图要补的功能缺口（`WORLD_MAP_ART_SPEC.md` §五）。

## 视觉方案

沿用阵营图腾（dragon/eagle）已验证的契约，而不是重新定规范：

1. **单色线稿**：AI 出图为深色墨线 + 纯白底（复用 `art-direction.md` §6.2 共用 prompt 前缀/负向提示），**不在 AI 阶段上色**。
2. **打包时转白线+透明底**：GPT Image 2 出的源图是不透明的白底深墨线（没有现成 alpha 通道，跟阵营图腾的源图不一样），实际打包脚本（`art/icons/pack_emblem_atlas.js`）综合了两套现成逻辑——先按 `pack_decos.cjs` 的口径把白底转透明（`alpha = 255 - luminance`），再按 `pack_faction_atlas.js` 的 `whiteLineFrame()` 口径丢弃原墨色只留 alpha、重建为纯白线，供客户端运行时 `tint` 成家族/宗门选定的强调色。**好处**：24 张单色图 × 任意强调色 = 视觉上远超24种的可辨认组合，不增加出图成本。
3. **不在图内画徽章底座/边框**：徽章底座（圆形/盾形程序绘制）由 UI 侧统一加，不同图案共用同一个底座保证一致性，也不需要 24 张各画一次边框（同项目里装备稀有度边框"程序叠加"的既定做法）。
4. **尺寸**：跟随 `pack_faction_atlas.js` 现有约定——256px 图集格子，图腾主体占约 224px（留 16px 透明边距）。图腾本身**不需要方向感**（不像士兵朝向），构图居中对称即可。

## Prompt 模板（GPT Image 2 版）

> 出图工具为 **GPT Image 2**（非 Midjourney），不支持 `--ar`/`--style raw`/`--no` 这类参数标记——
> 下面把 `art-direction.md` §6.2 共用前缀 + 徽章主体 + 负向提示，合并成**一段可直接复制的完整自然语言
> prompt**（否定项写成句子而非 flag）。24 条完整 prompt 见下表后的代码块（每条独立、开箱可用）。

统一句式（`{SYMBOL}` 是唯一变量）：

```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly
imperfect strokes like a teenager quickly sketching in the margins during class, a very loose
sketch, no shading or only light pencil hatching, no outline cleanup. Subject: {SYMBOL}, drawn
as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or
clearly centered composition, simple and graphic so it still reads clearly as a small icon at
64x64px display size, minimal interior line detail, no fine texture. Isolated single object,
centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects
in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration
only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no
painterly shading, no photorealism, no clean vector look, no drop shadow.
```

每张建议生成 3-4 个变体择优（同项目惯例）。

---

## 24 套图腾清单

分四组，覆盖动物图腾（辨识度最高、最贴合"家族/宗门"势力感）、自然元素、文具/校园符号（呼应游戏整体"笔记本"母题，避免整套徽章看起来像抄别的游戏）、几何/纹章符号。**已避开与阵营图腾（tao=龙、anna=鹰）重复的主体**，避免玩家把家族徽章误认成阵营标识。

### A 组 — 动物图腾（8）

| 帧名 | 图腾描述 `[图腾描述]` |
|---|---|
| `emblem_fox` | a fox head in profile, pointed ears, alert expression |
| `emblem_bear` | a bear head facing forward, round ears, small tusks-free simple snout |
| `emblem_owl` | an owl facing forward, large round eyes, small hooked beak, wings folded |
| `emblem_shark` | a shark head in profile with visible triangular teeth, dorsal fin hint |
| `emblem_boar` | a wild boar head in profile with two curved tusks |
| `emblem_stag` | a stag head facing forward with a full branching set of antlers |
| `emblem_snake` | a coiled snake forming a rough circle, head raised, forked tongue out |
| `emblem_scorpion` | a scorpion viewed from above, raised tail with stinger, claws forward |

### B 组 — 自然/元素（6）

| 帧名 | 图腾描述 |
|---|---|
| `emblem_flame` | a single stylized flame, licking upward, doodle style |
| `emblem_lightning` | a bold jagged lightning bolt, diagonal |
| `emblem_skull` | a simple front-facing skull, doodle style, round eye sockets |
| `emblem_mountain` | a stylized twin-peak mountain silhouette with a small flag on top |
| `emblem_wave` | a single stylized ocean wave curling over, doodle swirl |
| `emblem_moonstar` | a crescent moon with a small five-pointed star nested beside it |

### C 组 — 文具/校园符号（5）

呼应游戏"笔记本/文具"总基调，让整套徽章一眼能认出是这个游戏的东西，不是随便一套通用纹章包。

| 帧名 | 图腾描述 |
|---|---|
| `emblem_crossedpens` | two writing pens crossed in an X shape, nibs pointing outward |
| `emblem_penquill` | a single feather quill pen standing upright, ink drop at the tip |
| `emblem_inkdrop` | a single bold ink drop/blob shape with a small highlight line |
| `emblem_openbook` | an open book viewed from the front, a bookmark ribbon hanging down the middle |
| `emblem_magnifier` | a magnifying glass, round lens with handle, doodle style |

### D 组 — 几何/纹章符号（5）

| 帧名 | 图腾描述 |
|---|---|
| `emblem_shield` | a simple heraldic shield outline split by a single vertical line down the middle |
| `emblem_starcircle` | a five-pointed star inscribed inside a single circle outline |
| `emblem_crown` | a simple three-point crown, front view |
| `emblem_laurel` | a laurel wreath, two curved leafy branches meeting at the bottom, open at the top |
| `emblem_anchor` | a ship anchor, doodle style, simple curved flukes |

> **出图记录（2026-08-14）**：`emblem_mountain` 出了两版候选（简单三角旗 / 双燕尾旗），采用了细节量级跟其他23张更一致的双燕尾旗版，另一版存档 `art/leftover/`。`emblem_inkdrop` 经过3轮迭代——首版纯泪滴形状太空、容易被认成水滴；改成"实心填色+尖刺盾形"跑偏了风格（不是线稿，废弃）；最终版在轮廓内加了一道高光弧线+顶部甩尾小勾+两个实心小墨点才定稿，首版草稿存档 `art/leftover/`。

---

## 24 条完整 Prompt（GPT Image 2，直接复制）

已把统一句式代入每个图腾描述，逐条可直接复制粘贴，不用再手动拼接。

### A 组 — 动物图腾

`emblem_fox`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a fox head in profile, pointed ears, alert expression, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_bear`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a bear head facing forward, round ears, a simple snout, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_owl`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: an owl facing forward, large round eyes, a small hooked beak, wings folded, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_shark`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a shark head in profile with visible triangular teeth and a hint of a dorsal fin, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_boar`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a wild boar head in profile with two curved tusks, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_stag`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a stag head facing forward with a full branching set of antlers, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_snake`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a coiled snake forming a rough circle, head raised, forked tongue out, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_scorpion`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a scorpion viewed from above, raised tail with a stinger, claws forward, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

### B 组 — 自然/元素

`emblem_flame`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a single stylized flame, licking upward, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_lightning`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a bold jagged lightning bolt, diagonal, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_skull`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a simple front-facing skull with round eye sockets, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_mountain`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a stylized twin-peak mountain silhouette with a small flag on top, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_wave`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a single stylized ocean wave curling over, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_moonstar`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a crescent moon with a small five-pointed star nested beside it, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

### C 组 — 文具/校园符号

`emblem_crossedpens`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: two writing pens crossed in an X shape, nibs pointing outward, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_penquill`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a single feather quill pen standing upright, an ink drop at the tip, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_inkdrop`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a single bold ink drop/blob shape with a small highlight line, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_openbook`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: an open book viewed from the front, a bookmark ribbon hanging down the middle, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_magnifier`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a magnifying glass, a round lens with a handle, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

### D 组 — 几何/纹章符号

`emblem_shield`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a simple heraldic shield outline split by a single vertical line down the middle, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_starcircle`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a five-pointed star inscribed inside a single circle outline, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_crown`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a simple three-point crown, front view, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_laurel`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a laurel wreath, two curved leafy branches meeting at the bottom and open at the top, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

`emblem_anchor`
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes like a teenager quickly sketching in the margins during class, a very loose sketch, no shading or only light pencil hatching, no outline cleanup. Subject: a ship anchor with simple curved flukes, drawn as a small heraldic emblem/badge icon — front-facing or profile silhouette, symmetrical or clearly centered composition, simple and graphic so it still reads clearly as a small icon at 64x64px display size, minimal interior line detail, no fine texture. Isolated single object, centered, on a plain pure-white background, square 1:1 image, no grid lines, no other objects in frame, no border or frame drawn around it, no text, no watermark. Flat 2D illustration only — no 3D, no gradients, no glossy highlights, no thick cartoon outline, no color, no painterly shading, no photorealism, no clean vector look, no drop shadow.
```

---

## 产出 → 接入流程（✅ 2026-08-14 已完成 1-3）

1. ✅ AI 出图（GPT Image 2），白底深墨线，命名 `emblem_<key>.webp`，**留在 `art/icons/`**（用户直接在这个落地目录里重命名，未新建 `art/ui/emblems/`——跟原计划的目录不同，改这条记录对齐实际路径）。候选/废弃版本存 `art/leftover/`（见上方「出图记录」）。
2. ✅ 打包脚本 `art/icons/pack_emblem_atlas.js`——源图是不透明白底图（没有现成 alpha），逻辑综合 `pack_decos.cjs` 的白底转透明（`alpha = 255 - luminance`）+ `pack_faction_atlas.js` 的 `whiteLineFrame()`（丢弃原墨色只留 alpha、重建纯白线、224/256 居中），24 帧按 6×4 网格布局（不需要 shelf-pack——所有帧尺寸一致）。`node art/icons/pack_emblem_atlas.js` 运行，产物用 `{ palette: true, quality: 90, effort: 10, compressionLevel: 9 }` 压缩（同 `art/scripts/appendAtlasFrames.js` 的压缩口径）。
3. ✅ 产出 `client/src/assets/emblems/emblems.png`（1536×1024，~195KB）+ `emblems.json`（TexturePacker JSON-Hash，帧名即 `emblem_<key>`）。接入两个新模块：
   - [`client/src/render/atlas/emblemAtlas.ts`](../../client/src/render/atlas/emblemAtlas.ts)——`createAtlasLoader` 薄封装，同 `iconsAtlas.ts` 的写法；
   - [`client/src/render/emblemIcon.ts`](../../client/src/render/emblemIcon.ts)——导出 `EMBLEM_KEYS`（24 个 key 的 union type）/`loadEmblemAtlas`/`getEmblemIconTexture`/`buildEmblemIcon(key,size,tint)`，`tint` 参数就是让家族/宗门自选强调色，同 `factionIcon.ts` 的 `buildFactionIcon` 契约（无程序回退图，因为还没有消费方）。
   - **故意不接入 `bootManifest.ts` L0**：`preloadBoot` 的注释明确写着"不需要的东西不要放这里，每条都拖慢首屏"，而这套图集目前还没有任何调用方（没有 `emblemKey` 字段、没有选择器 UI），放 L0 只会白白多一次首屏请求。等真正的消费方（下面第4点）落地后，按该场景的 L1 lazy-load 套路接（参考 `cityAtlasLoader.ts` 等在场景入口加载的写法），不要放 L0。
   - 验证：`tsc --noEmit` 全绿、`npm run typecheck` 全绿、`webpack --mode production` 构建通过（2 条 warning 是这个项目一直有的大图资源体积提醒，跟本次改动无关）；因为还没有 UI 消费这套图集，没有可视化改动可截图核对。
4. **✅ 功能接入完成（2026-08-14 同日）**——上面第 4 点列的三项缺口全部补齐：
   - **数据字段**：`server/shared/src/slg/core.ts` 新增 `EMBLEM_KEYS`（从 `emblemIcon.ts` 收敛为唯一权威副本，client 侧改为 `import { EMBLEM_KEYS } from '@nw/shared'` 再重导出）+ `EMBLEM_COLORS`（8 色预设强调色板，非自由调色）+ `isEmblemKey`/`isEmblemColor` 校验函数；socialsvc 的 `FamilyDoc`/`FamilyView` 与 worldsvc 的 `SectDoc`/`SectView`/`SectMemberFamilyView` 均加 `emblemKey?`/`emblemColor?`。
   - **权限口径**（产品拍板，与用户确认）：家族徽章**只有族长**能改（比 `setAnnouncement` 的族长+长老更严）——`POST /social/family/emblem`；宗门徽章**只有盟主**能改（`sect.leaderId`，不是任意家族族长）——`POST /sect/emblem`。两个端点均已过 `openapi-social.yml`/`openapi-world.yml` → codegen → `client/src/net/openapi-*.ts`。
   - **选择器 UI**：新增共享对话框 [`client/src/ui/dialogs/emblemPickerDialog.ts`](../../client/src/ui/dialogs/emblemPickerDialog.ts)（24 图标 6×4 网格 + 8 色强调色行 + 确认/取消，选中态实时预览 tint），FamilyScene/SectScene 各自的 `ActionsPanel.openEmblemPicker()` 调用它、提交后回填 `core.family`/`core.sect` 本地状态；族长/盟主的徽章 tap 入口做在 header.ts 的身份簇（横屏）与 render.ts 的信息带（竖屏），未选徽章时画一个虚线圆占位邀请点选。
   - **展示面覆盖四处**：①家族/宗门主页（header.ts 横屏 + render.ts 竖屏，本次唯一新增的"设置"入口）；②`FriendsScene/orgForm.ts` 的家族浏览行 + 详情预览、`SectScene/lists.ts` 的宗门成员家族列表行；③`/social/profile/{publicId}/extra` 新增 `familyEmblemKey`/`familyEmblemColor`，`ProfilePopup.ts` 在"家族：xxx"文字前画徽章（**无宗门徽章**——socialsvc 只在建/加宗门那一刻把 `sectId`/`sectName` 镖到 `FamilyDoc`，宗门自身后续字段变化不会回灌，跟 `sectName` 本身"改名不同步"是同一个既有限制，非本次引入）；④世界地图行军/驻军/占领令牌角标——**不是替换令牌本身**（那会倒退 2026-07-26"令牌按真实领队兵种显示"的既有决策，`tokens.ts` 里已有注释挑明"帮会/旗帜有意排除在外"），而是叠加一个不随镜像翻转的小角标（`syncEmblemBadge`，独立 top-level 显示对象，不挂在会翻转的 stickman 容器下）；数据链路：`worldsvc` 新增 `combatShared.ts::resolveOwnerEmblems()`（复用 `playerWorld.familyId` 只读镖像 + `getFamiliesByIds` 批量查）在 `getMarches`/`getOccupations`/`getStationed` 的响应组装处按 index 贴回 `emblemKey`/`emblemColor`（不像 `leaderUnitType` 那样在派发时冻结——家族归属不敏感，实时解析更合理），socialsvc 失败时静默退化为"这批不带徽章"而不影响令牌本身。
   - **验证**：server（socialsvc 156 + worldsvc 493 测试，含新增 `resolve-owner-emblems.test.ts` 7 例纯函数单测 + `family.e2e.test.ts`/`sect.e2e.test.ts` 各一条权限+校验用例）、client（1321 单测 + 1594 UI 冒烟，含 `composition-wiring.ui.ts` 新增的 lazy-hook 到位断言）全绿；`tsc --noEmit`/`tsc -b`/`webpack --mode production` 全绿。未做真实登录态截图核对（需要拉起 5 个后端服务 + Mongo + 建号建家族，本次改动的可视化路径已由构造真实场景树的 UI 冒烟测试覆盖）。
   - **已知遗留**（非本次范围，记录避免遗漏）：march-token 角标走的是 `PlayerWorldDoc.familyId`「joinWorld 时解析一次、只读镖像」口径（同 `familyMemberIds`/`allySectMemberIds` 已接受的既有取舍）——玩家事后换家族不会实时反映在角标上；宗门徽章变化不会回灌 socialsvc（上面第③点提过，是既有 `sectName` 限制的自然延伸，不是新缺口）。
