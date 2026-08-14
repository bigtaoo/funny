# 家族/宗门徽章美术 — 图片生成 Prompt 文档

> 创建：2026-08-14
> 缺口来源：[`design/game/WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) §五 TODO（"等专门的行军动画素材（含旗帜/头像等帮会标识）出图后替换 `MARCH_TOKEN_ASSET`；目前旗帜/头像暂不做，涉及帮会图标体系，留待后续"）
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
2. **打包时转白线+透明底**：抠图脚本丢弃 RGB、只保留 alpha，重建为白线-on-transparent（同 `pack_faction_atlas.js` 的 `whiteLineFrame()` 逻辑），供客户端运行时 `tint` 成家族/宗门选定的强调色。**好处**：24 张单色图 × 任意强调色 = 视觉上远超24种的可辨认组合，不增加出图成本。
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

## 产出 → 接入流程

1. AI 出图（GPT Image 2，24 套 × 3-4 变体择优），白底深墨线，命名 `emblem_<key>.png` 落 `art/ui/emblems/`（新建目录，仿 `art/ui/camps/` 组织方式）。
2. 新写打包脚本 `art/ui/emblems/pack_emblem_atlas.js`，逻辑直接照抄 `art/ui/camps/pack_faction_atlas.js` 的 `whiteLineFrame()`（抠白底→取 alpha→重建白线透明→按 224/256 居中）+ shelf-pack 24 帧到一张图集。
3. 产出 `client/src/assets/emblems/emblems.png` + `emblems.json`（TexturePacker JSON-Hash，帧名即 `emblem_<key>`），供 `getEmblemTexture(key)` 之类的读取函数按帧名直接取用（沿用本项目"帧名即约定 key，出现即生效"的零改代码接线模式）。
4. **本文档范围到此为止**——以下是后续功能实现阶段需要做、但不在本次美术任务里的事项，先记录在这里避免遗漏：
   - `server/shared/src/slg/core.ts` 的家族/宗门文档需要加 `emblemKey`（+ 可选 `emblemColor` 强调色）字段；
   - 建家族/建宗门 UI 需要加"选徽章+选强调色"的选择器；
   - `WORLD_MAP_ART_SPEC.md` §五提到的 `MARCH_TOKEN_ASSET` 占位替换、`buildDotToken` 静态头像圆点，接入后应改为读取徽章图集而非复用兵种骨骼资产；
   - 需要更新 `WORLD_MAP_ART_SPEC.md` §五，把"留待后续"的 TODO 改成指向本文档。
