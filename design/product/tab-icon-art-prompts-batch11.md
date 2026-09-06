# 批次 11：按钮前置图标的 10 枚缺口 — 语义判断 + Prompt 文档

> 创建：2026-09-06 · 状态：**全批完成（同日）**——10 张出图 → **9 枚上线**、`handshake` 两版都读不出「两只手」，结案为不画、继续借 `friends`（§7）。9 枚已打包 + 接线 + 三语实拍（§8/§9）。全库账：**66 张自有美术 + 6 个别名 = 72 个 ink kind**
> 前十批：[批 1–4](tab-icon-art-prompts.md) · [批 5](tab-icon-art-prompts-batch5.md) · [批 6](tab-icon-art-prompts-batch6.md) · [批 7](tab-icon-art-prompts-batch7.md) + [批 7 log](tab-icon-art-prompts-batch7-log.md) · [批 8](tab-icon-art-prompts-batch8.md) · [批 9](tab-icon-art-prompts-batch9.md) · [批 10](tab-icon-art-prompts-batch10.md)
> 上游：[`UI_DESIGN.md` §2「按钮前置图标（2026-09-05）」](../game/UI_DESIGN.md) —— 那一轮 96 处接线、26 枚图标、**零新美术**，末尾列的「仍缺 10 枚」就是本批
> 配套代码：[`buttonLabel.ts`](../../client/src/ui/widgets/buttonLabel.ts) · [`inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts) · [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)

## 0. 为什么是这 10 枚，而不是别的

上一轮的判据是**宁可没图标，也不让一个符号表达两种含义**（批次 2 去重表定下的红线）。据此撤掉过三处「看着能用」的复用：登录入口借 `avatar`（那是头像选择）、改名借 `brush`（那是皮肤）、加入房间借 `duel`（那是切磋）。这 10 个动作就是**复用池里真的没有对应物**的那些。

按钮侧的接线**已经做完**：全部走 `drawButtonLabel`，出图后每处只填一个 `icon:` 参数。所以本批的工作量 = 10 张图 + 10 行调用点。

## 1. 语义判断：每一枚为什么长这样

判断照 [[pick-icon-glyphs-by-eye-not-name]]：先看**现有 114 枚在 26px 上读成什么**，再决定新图画什么。本批 10 枚里有 4 枚的第一直觉造型是被占用的，下表把它们单列出来——这才是本文档存在的理由。

| kind | 用在哪 | 造型 | 为什么不是第一直觉的那个 |
|---|---|---|---|
| `trash` | `mail.delete` / `settings.deleteAccount` / `friends.confirmRemove` | 桶身留白的锥形桶 + **分离的实心黑盖条**（盖与桶之间留一道白缝） | 直觉造型没被占。唯一要躲的是 `bag`（双肩包，翻盖 + 两条带）——靠**锥形收窄 + 盖条与桶体断开**拉开 |
| `key` | `auth.loginEntry` / 登录页 / 设置页入口 | 45° 斜放的钥匙：**实心黑圆头 + 白孔**，短杆，末端两枚方齿 | 不能用 `lock`。挂锁在本库是**负向**标记（未解锁），批 10 已经为同一条理由否决过一次 |
| `userPlus` | `auth.register` / `auth.submitRegister` / `auth.toRegister` | 正面半身小人（实心黑圆头 + 实心黑肩），右上角一个**正交粗加号** | **不加圆框**——`avatar` 是「圆框里的半身人像」，批 5 #23 还专门警告过「圆头像 + 方框 = 证件」这条通用语法。本图靠「无框 + 加号」跟它分开；也不能画成两个人（`friends`）或三个人（`family`） |
| `power` | `auth.logout`（退出登录） | 手绘电源符号：顶部开口的粗圆环 + 环心一根短竖杆穿过缺口 | **不能画门**。半开的门是 `room`（好友对战 / 创建房间）。「门 + 向外箭头」还会跟本批的 `enter`（加入）在 26px 上撞成一对双胞胎 |
| `penWrite` | `settings.rename` / `world.nationRename` | 45° 斜放的马克笔（**笔身实心黑**，笔尖朝左下）+ 笔尖下方一道**分离的**波浪签名线 | 「一支笔」在本库是重灾区：`lead`（裸铅芯）、`pencils`（交叉两支铅笔）、`duel`（交叉铅笔 + 墨渍）、`skin`/`brush`（毛笔）。本图的身份不在笔本身，**在「笔 + 刚写下的一道线」这个组合** |
| `megaphone` | `lobby.strip.feedback` / `feedback.title` | 斜指左上的扩音喇叭：**实心黑喇叭筒** + 下方一小截留白握把，筒口用一道浅弧收口 | **不能画对话气泡**——那是 `channel`（家族/宗门频道 + 私聊标题）。要躲的第二个是 `play`（播放三角）：所以喇叭斜放、筒口画弧不画直边、并且必须有握把 |
| `sheets` | `room.copy`（房间码）/ `profile.copied` | 两张正立的纸错开叠放：后一张**只露出左上两条边的白描线**，前一张**整块填实黑** + 右上角一个白色折角 | 最危险的一对是 `cards`（两张叠放卡片 + 角标圆点 + 一条分隔线）——结构几乎一样。区分放在**黑白反相**上：`cards` 是白底描线，本图是一块实心黑。另外禁掉圆角、角标点、分隔线、扇形三张（`deck`） |
| `enter` | `room.join` / `family.join` / `social.family.joinById` | 正面门框（两根粗立柱 + 一道横楣，底部不封口，框内透纸）+ 一支**实心黑三角头箭头**从左侧插进框口 | 上一轮的清单写的是「加入(门)」，但**门已经归 `room`**（创建房间），两个按钮常常同屏。所以本图不画门扇：没有门板、没有把手、没有透视，只有一个正面门框和一支进去的箭头 |
| `eraser` | `world.defense.clear` / 搜索框清空 | 单块橡皮，斜约 20°，**下半块实心黑**（工作端）上半块留白，下方一道分离的短横线代表纸面 | 不能画成「铅笔尾部的橡皮头」——那是 `lead`/`pencils` 的地盘；也不能画卷屑（`material` 就是铅笔屑），不能画砖块（`siege` 是三排砖 + 裂缝） |
| `handshake` | `sect.ally`（结盟，现借 `friends`） | 左右两条留白小臂斜向上交汇，中间**两只手合成一整块实心黑**，只在顶部切一个白色缺口当拇指 | 手指是 26px 的头号杀手（批 7 总结第一条：活下来的是实心块）。所以**一根手指都不画**。也不能出现人（`friends` 两人 / `family` 三人） |

**没有走的两条路**，各记一句：

- **`enter` 用一个光秃秃的加号**。加号在手绘抖动笔触下稍一倾斜就读成 `close` 的那个 X，而同一排按钮里 `check`/`close` 是全库用量前两名（19 / 18 次）。门框 + 箭头贵一点，但不会读错。
- **`power` 用挥手告别**。会跟本批的 `handshake` 在「手」这个母题上撞，而且「挥手」在 26px 上就是一团黑加几根线。

## 2. 硬约束（骨架之外，本批必须写进 prompt 的四条）

骨架沿用前十批，不重复贴（见批 8 §「Prompt 骨架」）；§3 的十条已经组装成完整 prompt，直接复制即可。

1. **验收尺寸是 26×26，不是 28×28**。`buttonLabel.ts` 的 `ICON_RATIO = 1.35`，按钮字号 16–20px → 图标框 22–27px，`minFit` 还会把整组再缩一档。所以 prompt 里写死 26。
2. **身份由实心块承担，不由线条承担**（批 7 总结第一条）。本批每一枚都指定了「哪一块是 ONE SOLID BLACK」：桶盖条、钥匙头、人头与肩、喇叭筒、前面那张纸、箭头、橡皮下半块、合握的手。**没有指定实心块的图不要出**。
3. **整体塞进正方形**，硬拦线是 [`iconArtAspect.test.ts`](../../client/test/render/iconArtAspect.test.ts) 的 `MAX_RATIO = 2.2`，目标 ≤1.5。本批天然细长的是钥匙（斜放解决）、笔（斜放解决）、握手（两臂上扬 35° 解决）、两张纸（用近方的纸型解决）——四处都已经把构图写死在 prompt 里，**不靠模型自觉**。
4. **相邻两个部件之间留出跟线宽同量级的白纸缝**（几何写法，别用形容词，见 [[ai-art-density-cannot-be-prompted-2026-08-19]]）：桶盖与桶体、笔尖与签名线、橡皮与纸面线、钥匙的两枚齿之间。缝没了，这四枚在 26px 上都会糊成一坨。

## 3. Prompt（10 条，直接复制）

### `tabicon_trash`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one waste bin seen straight on from the side, standing upright. The bin body is a simple tapered bucket, clearly wider at its top than at its bottom, drawn as bare white line art with absolutely nothing inside it. Above the body sits a separate lid: ONE SOLID BLACK horizontal bar, slightly wider than the bin's mouth, with a small solid black knob standing on the middle of it, and a clear white gap the width of the pen line between the lid and the body. The bin is about as wide as it is tall, so the whole drawing sits inside a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the lid is one flat solid black area and everything else is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where the solid lid bar above a tapered empty bucket is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, vertical ribs or grooves on the bin body, horizontal bands around the bin, any lines or marks inside the bin, a lid touching the body with no gap, an open swinging lid, rubbish or crumpled paper sticking out, recycling arrows, a skull, crossbones, a big X, a check mark, a backpack with a flap and straps, a bucket with a swing handle, wheels, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_key`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one single door key lying at a 45 degree diagonal, its head at the lower left and its teeth at the upper right. The head is a big round bow filled in as ONE SOLID BLACK disc with a clean round white hole punched through its centre. A short straight shaft runs up to the right from the head and ends in exactly two chunky square teeth that both point to the same side, each tooth as thick as the shaft, with a clear white gap the width of the pen line between the two teeth. The shaft and the teeth are bare white line art with a bold outline. The key is drawn large and on the diagonal so that it fills a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the round head is one flat solid black area and everything else is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where the solid round head with its white hole and the two blocky teeth are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a padlock, any lock body, a keyhole, a shackle, a key ring or chain, more than one key, ornate filigree on the head, a heart-shaped head, a skeleton-key barrel, more than two teeth, a horizontal key wider than one and a half times its height, thin wispy strokes, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_userPlus`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one simple person seen from the front as a head-and-shoulders bust, plus one plus sign — exactly two marks and nothing else. The head is ONE SOLID BLACK circle; below it the shoulders are ONE SOLID BLACK rounded mound, wider than the head, with a clear white gap the width of the pen line between head and shoulders. In the upper right, clearly separated from the figure by white paper, stands one bold plus sign with a strictly horizontal arm and a strictly vertical arm of equal length, drawn as thick heavy strokes, about a third as tall as the figure. Together the two marks fill a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the head and shoulders are flat solid black areas. Must stay clearly recognizable when scaled down to 26x26 pixels, where a solid bust and a thick upright plus beside it are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a circular frame or ring around the person, a rectangular badge, card or ID outline around the person, facial features, eyes, hair detail, arms, hands, a second person, a group of people, a tilted plus, a diagonal cross or X, a check mark, a star, a speech bubble, a magnifying glass, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_power`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one power symbol drawn by hand — a bold thick ring, a circle whose heavy stroke is broken by one clean gap at the very top, and one short thick perfectly vertical bar standing at the centre of that ring, rising from just inside the ring, up through the gap, and ending a little above the ring. The two strokes are equally heavy, the ring is left unfilled, the gap is about as wide as the bar is thick, and nothing else is drawn. The symbol is as wide as it is tall and fills a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 26x26 pixels, where the broken ring and the upright bar through its top are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a padlock, a shackle, a keyhole, a horseshoe, a magnet with two prongs, a C shape with no bar, a gap anywhere other than the top, a tilted or slanted bar, a bar that does not reach past the ring, arrows, a door, an exclamation mark, a clock face or hands, sparks, radiating lines, a filled-in disc, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_penWrite`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one pen that has just written a line, drawn as exactly two marks. The pen is a short stubby marker lying at a 45 degree diagonal with its tip pointing down to the lower left; its barrel is ONE SOLID BLACK tapered bar with a narrow white band across it just behind the tip, and its upper end is plain and blunt. Below and to the left of the tip runs one bare white-line wavy stroke, a single smooth scribble like a signature just laid down, about as long as the pen, with a clear white gap the width of the pen line between the pen's tip and the start of that wave. The diagonal pen and the wave together fill a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the pen barrel is one flat solid black area and the wavy stroke is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where a heavy diagonal pen above a single wavy line are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a wooden pencil with a sharpened wooden cone, an eraser head on the pen, a bare graphite tip with no barrel, two crossed pencils, a paintbrush with bristles, a quill feather, ink splashes, droplets or blots, a sheet of paper or notebook under the writing, ruled lines, a hand holding the pen, an arrow, more than one wavy stroke, cursive letters, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_megaphone`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one hand-held megaphone pointing up and to the left on a diagonal. Its horn is a wide cone filled in as ONE SOLID BLACK trapezoid, narrow at the lower right and flaring out to a wide mouth at the upper left; the wide mouth is closed off by a shallow open curve rather than a straight edge, and one small solid black disc caps the narrow end. A short bare white-line handle grip hangs down from the underside of the cone near that narrow end. Nothing at all comes out of the mouth. The diagonal horn plus its grip fill a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the horn is one flat solid black area and the grip is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where a heavy flaring cone with a small grip under it is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, sound waves, radiating arcs or lines leaving the mouth, music notes, a plain equilateral triangle, a right-pointing play triangle, a traffic cone, an ice cream cone, a funnel, a trumpet with valves or curved tubing, a person holding it, a speech bubble, three dots, a lightbulb, a flag, a bell, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_sheets`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: exactly two identical upright sheets of paper, one behind the other and offset diagonally, as when a page has been duplicated. The back sheet is bare white line art and only its top edge and its left edge peek out behind, up and to the left. The front sheet is filled in as ONE SOLID BLACK rectangle whose top right corner is folded over, that folded corner left as a clean white triangle. Both sheets are plain rectangles with square corners, only slightly taller than they are wide, and the pair together sits inside a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the front sheet is one flat solid black area and the back sheet is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where a solid black page with a white folded corner and a thin outline of a second page behind it are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, rounded playing-card corners, a pip or dot in a corner, a divider line across a sheet, a fan of three tilted cards, tilted or rotated sheets, torn or ragged paper edges, ruled writing lines on the sheets, a paper clip, a clipboard with a clip at the top, an envelope with a triangular flap, an arrow, a hand, a third sheet, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_enter`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one open gateway with an arrow going into it. The gateway is a plain upright doorway frame seen flat from the front — two thick vertical posts and one thick horizontal lintel across their tops, open at the bottom, the space inside left as plain white paper. One bold arrow comes in from the left: its shaft is a short thick straight horizontal bar and its head is a big SOLID BLACK triangle pointing right, and that arrowhead sits inside the gateway's opening, past the left post. The frame and the arrow together fill a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the arrowhead is one flat solid black area and the gateway is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where an upright open frame with a heavy black arrowhead inside it is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a hinged door panel swung open at an angle, a door leaf, a doorknob or handle, hinges, perspective or a three-quarter view, a house, a roof or gable over the frame, a keyhole, a key, a padlock, a plus sign, a walking person, stairs, more than one arrow, a curved arrow, a thin wispy arrow, an arrow pointing out of the frame, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_eraser`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one rubber eraser, a single block seen from the side and tilted about twenty degrees so its working end points down to the left. The block is a plain rounded rectangle cut across its middle by ONE straight line: the lower half, the working end, is filled in as ONE SOLID BLACK area, and the upper half is left as bare white line art. Directly below the block runs one short straight bare horizontal line, about as long as the eraser is wide, standing for the sheet of paper, with a clear white gap the width of the pen line between the eraser and that line. Nothing else is drawn. The block and the line together fill a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the working end is one flat solid black area. Must stay clearly recognizable when scaled down to 26x26 pixels, where a tilted block that is black at its lower end, sitting just above a short line, is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a pencil, a wooden barrel or a sharpened tip attached to the eraser, an eraser mounted on the end of a pencil, eraser crumbs, dust, specks or dots, motion lines or swooshes, curly pencil shavings, a brick or a wall of bricks, cracks, domino pips, dice, a chalkboard duster with a handle, a hand, a wavy line being rubbed out, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_handshake`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: two forearms shaking hands, coming in from the lower left and the lower right and meeting in the middle. Each forearm is a plain bare white-line tube with one short straight line across it for a cuff, angled upward at about thirty five degrees, and each stops where the hands meet. There, the two clasped hands are drawn as ONE SOLID BLACK rounded mass about a third as wide as the whole drawing, with a single white notch cut into its top edge for the thumb; no separate fingers are drawn anywhere. The arms are angled steeply enough that the whole drawing sits inside a square frame rather than becoming a wide flat strip. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the clasped hands are one flat solid black area and the arms are bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where two arms rising into one solid black clasp are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, individual fingers, knuckles, fingernails, more than one notch in the black mass, drawn people, heads, faces, shoulders or bodies, a group of figures, sleeves with buttons or cufflinks, a heart shape, a wide flat silhouette more than twice as wide as it is tall, motion lines, sparkles, a high five, a fist bump, a single waving hand, an arrow, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 4. 出图后的接线清单

**① 源图归位** — `art/ui/tabicons/tabicon_<kind>.webp`，base 名逐字等于 kind 名。被打回的版本进 `art/ui/tabicons/_rejected/`，命名 `tabicon_<kind>_v<n>_<为什么废>.webp`（`inkIconArt.test.ts` 检查「每个 kind 恰好一个源图」）。

**② `pack_tab_icons.cjs`** — `JOBS` 末尾加 10 行，**一律 `inks: ['active']`**（只烤白色母版、运行时 tint）。这也顺手绕开了上一轮的墨色变体坑：ink 图标由 `buildInkIcon` tint，`variant` 参数被忽略，调用点不必判断底色深浅。

**③ 跑打包** — `node art/ui/tabicons/pack_tab_icons.cjs` → `client/src/assets/tabicons/<kind>_active.png`。跑完确认「只有新增那 10 张变化，其余 199 张零字节改动」。

**④ `inkIconRaster.ts`** — 三处：10 行 `import`（挂在批 11 的注释段下）、`InkIconKind` 加 10 个、`INK_ICON_ART` 加 10 行。

**⑤ 调用点，10 处**，每处只填一个 `icon:`：

| kind | 调用点 |
|---|---|
| `trash` | `FriendsScene/mail.ts` 删除邮件 · `SettingsScene` 删除账号（含确认弹窗）· 好友列表移除 |
| `key` | `AuthScene` 登录 · 大厅 / 设置的「登录 / 注册」入口 |
| `userPlus` | `AuthScene` 注册 / 注册并登录 / 去注册 |
| `power` | `SettingsScene` 退出登录 |
| `penWrite` | `SettingsScene` 改名（同时**去掉 i18n 里的 `✎` 前缀**，三语都要）· 世界地图国名改名 |
| `megaphone` | 大厅侧栏「反馈」· 反馈对话框提交 |
| `sheets` | `RoomScene` 复制房间码（**去掉 `📋` 前缀**，三语）· 个人页复制 ID |
| `enter` | `RoomScene` 加入房间 · `FamilyScene` 加入 / 按 ID 加入 |
| `eraser` | `DefenseEditorScene` 清空 · 搜索框清空 |
| `handshake` | `SectScene` 结盟（把现借的 `friendsTabIcon` 换掉） |

**⑥ 测试** — `client/test/render/inkIconArt.test.ts` 的 `expect(OWN_ART.length).toBe(57)` → `67`，并补上批 11 的算式注释。`iconArtAspect.test.ts` **不要改**：超 2.2:1 是「这张该重出」的信号，不是「该加豁免」。

**⑦ 验证** — `npm run typecheck`、`npm run lint`、`npm run build:web`（**类型过了不等于构建过了**：这 10 张走 `import`，文件名错一个字母只有 webpack 会报）、`npm run check:filelength`、`vitest run` + `test:ui` 全量。

## 5. 验收口径

1. **26px × 深底（`C.dark` `#2c2c2a`）+ 纸底（`C.paper` `#f5f0e8`）两张 contact sheet。96px 预览不算数。** 脚本临时写在 scratchpad，用完删。
2. **成组并排看**，本批必须过的六组：
   - `sheets` vs `cards` vs `deck` vs `scrap`（纸类，本批最危险的一组）；
   - `enter` vs `room`（半开的门，**加入 / 创建常常同屏**）vs `home`；
   - `penWrite` vs `lead` vs `pencils` vs `duel` vs `skin`（笔类五张）；
   - `userPlus` vs `avatar` vs `friends` vs `family`（人像四张）；
   - `megaphone` vs `play` vs `channel` vs `event`；
   - `eraser` vs `material` vs `siege`；外加 `trash` vs `bag`、`key` vs `lock`、`power` vs `lock` 三对。
3. **真机实拍三语**（本批按钮的德语标签最长）：登录页、设置页、房间页、宗门页各一屏，`de` / `zh` / `en` 三次。德语下要专门确认这些按钮**没有被 `minFit` 判成放不下而丢掉图标**——丢了是这个按钮的宽度要调，不是图标的问题。
4. **判定标准是「读成什么」，不是「好不好看」**。任何一张在 26px 上读成邻居那张，就按批 7 log 的格式记下 v1 为什么塌，**只改导致返工的那一处措辞**再重出。

## 6. 出图记录（2026-09-06 第一轮：10 张出图，8 张过、2 张打回）

**打包结果**：`node art/ui/tabicons/pack_tab_icons.cjs` 后新增 8 个 PNG，其余 199 张**零字节变化**（管线确定性再验一次）。长宽比全部远在 2.2 门禁内，最扁的是 `handshake` 128×89（1.44）——但它因为别的原因被打回。

**8 张过**（26px × 深底 + 纸底，按 §5 的六组并排看过）：

| kind | 26px 上读成什么 | 并排结论 |
|---|---|---|
| `trash` | 带分离盖条的锥形桶 | vs `bag` 完全不同档：桶是空心梯形 + 一条浮在上面的实心盖，包是圆角方块 + 翻盖 |
| `key` | 实心圆头 + 白孔 + 两枚方齿 | vs `lock` 一眼分开（挂锁是闭合的锁体 + 锁梁） |
| `userPlus` | 实心半身小人 + 粗加号 | vs `avatar`（圆框人像）/ `friends`（两人）/ `family`（三人）都不混，无框这条起了作用 |
| `power` | 顶部开口粗环 + 竖杆 | 没有读成挂锁，也没读成马蹄铁 |
| `penWrite` | 斜放实心笔 + 下方一道波浪 | 笔类五张（`lead`/`pencils`/`duel`/`skin`）并排，靠「笔 + 刚写的线」这个组合区分成立 |
| `megaphone` | 斜置实心喇叭 + 小握把 | vs `play` 的正三角：斜置 + 握把 + 弧形筒口三条一起起作用，没读成播放键 |
| `enter` | 门框 + 插进去的实心黑箭头 | vs `room`（半开的门，有门扇和把手）区分明显；vs `home` 不混 |
| `eraser` | 斜置双色块 + 下方一道纸线 | **勉强过**：本批唯一一张「靠标签兜底」的。它更像一块两色的块状物，是不是橡皮要靠 `清空` 二字确认；但库里没有第二个两色斜块，不会读成别的东西，先上线 |

**2 张打回**（源图已进 `art/ui/tabicons/_rejected/`，`pack_tab_icons.cjs` 的两行同时撤掉，等 v2）：

| kind | v1 为什么塌 |
|---|---|
| `sheets` | **读成一张纸，不是两张**。后面那张只露出约 1px 的边，缩到 26px 就并进前一张的轮廓里了；结果是「一张带折角的文档」——`copy` 的语义完全没传达，而 `cards` 反倒是清清楚楚的两张。根因在 prompt：只写了「露出上边和左边」，没写**露多少** |
| `handshake` | **读成一个 V**（或纸飞机 / 一只鸟）。两条小臂出成了发丝线、中间的手只有指甲盖大，26px 上剩下「两根斜线 + 一个小黑点」。根因也在 prompt：写了「合握的手是一整块实心黑」但**没给尺寸**，而 §2 第 4 条的「留白纸缝」只约束了缝、没约束线宽；另外「塞进正方形」把两臂逼成了陡峭的 V——**这一张本来就该是横的**，1.5:1 仍然远在 2.2 门禁内 |

**两条教训**（都是同一条的两种写法）：**几何量必须给数**。「露出来」「一整块」「粗一点」这类形容词模型都会满足到最省事的那一档；写成「offset by a quarter of the sheet's width」「half as wide as the whole drawing」「at least a fifth as wide」它才会照做。这跟 [[ai-art-density-cannot-be-prompted-2026-08-19]] 是同一条，只是那次约束的是密度，这次是**部件的绝对尺寸**。

### v2 Prompt

**`tabicon_sheets` v2**（把偏移量和缝写成数值；纸整体画小一点给偏移留地方）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: exactly two upright sheets of paper, one behind the other, drawn so that it is instantly obvious there are TWO of them. The back sheet is bare white line art and is offset up and to the left by a quarter of a sheet's width, so a wide band of it — several times the thickness of the pen line — is plainly visible along the top and down the left side. The front sheet is filled in as ONE SOLID BLACK rectangle with its top right corner folded over, that folded corner left as a clean white triangle, and a clear white gap the width of the pen line runs all the way around the front sheet so its black body never touches the back sheet's outline. Both sheets are plain rectangles with square corners, only slightly taller than they are wide, and each sheet is drawn small enough that the pair together, offset, fills a square frame. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the front sheet is one flat solid black area and the back sheet is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where TWO separate pages must still be countable: a solid black page with a white folded corner, and a second outlined page clearly sticking out behind it. Style of West of Loathing / doodle art. Avoid: a single sheet, a back sheet peeking out by only a hair, the two sheets touching or overlapping outlines, rounded playing-card corners, a pip or dot in a corner, a divider line across a sheet, a fan of three tilted cards, tilted or rotated sheets, torn or ragged paper edges, ruled writing lines, a paper clip, a clipboard with a clip, an envelope with a triangular flap, an arrow, a hand, a third sheet, color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**`tabicon_handshake` v2**（改成横构图；小臂与手块都给到绝对尺寸）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: two forearms shaking hands, coming in almost horizontally from the left edge and the right edge and meeting in the middle. Each forearm is a thick tube — at least a fifth as wide as the whole drawing is wide — drawn as bare white line art with one short straight line across it for a cuff, tilted only slightly, about fifteen degrees. Where they meet, the two clasped hands are ONE SOLID BLACK rounded mass, about half as wide as the whole drawing and taller than the arms are thick, with a single white notch cut into its top edge for the thumb; no separate fingers are drawn anywhere. The drawing is wider than it is tall, about three units wide to two units tall, and no more than twice as wide as it is tall. Centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the clasped hands are one flat solid black area and the arms are bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where one big solid black clasp with a thick arm running into it from each side is what reads. Style of West of Loathing / doodle art. Avoid: thin hairline arms, arms drawn as single strokes, a steep V or chevron shape, two diagonal lines meeting at a point, a paper plane, a bird, a small black dot in the middle, individual fingers, knuckles, fingernails, more than one notch in the black mass, drawn people, heads, faces, shoulders or bodies, sleeves with buttons or cufflinks, a heart shape, motion lines, sparkles, a high five, a fist bump, a single waving hand, an arrow, color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, text, letters, numbers, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 7. 第二轮（同日）：`sheets` 过，`handshake` 二次打回并**结案为「不画」**

**`sheets` v2 过**。裁边后 95×128（1.32:1）。26px 上 `sheets` / `cards` / `scrap` 并排：后一张纸露出的白带够宽，两张纸数得出来；跟 `cards`（白底描线 + 角标点 + 分隔线）的黑白反相区分成立。v1 的病灶就是「露多少」没给数值，v2 给了「a quarter of a sheet's width」就一次过。

**`handshake` v2 又塌了，而且是另一种塌法**：读成**两根横杆中间夹一个没有细节的黑球**（哑铃 / 领结）。同时裁边后 128×53 = **2.42:1，直接超 `iconArtAspect.test.ts` 的 2.2 门禁**——我在 v2 prompt 里写的「about three units wide to two units tall」被模型当耳旁风，因为两条几乎水平的小臂天然把画面拉扁。

**结案：这一枚不画了，`sect.ally` 继续借 `friends`。** 理由不是「再试一版就好」，而是两版失败指向同一件事：

- v1 塌在「手太小」，v2 按尺寸把手放大之后，**手一旦大到 26px 能看见，就必须画出手指或指缝才能读成「手」**；而「不许画手指」正是 26px 的铁律（批 7 总结第一条）。**这两条要求在 26px 上互相矛盾**——这是这一枚跟本批另外九枚的本质区别，不是 prompt 措辞问题。
- 项目的红线是「宁可没图标，也不让一个符号表达两种含义」，从来不是「每个按钮都必须有图标」。`friends`（两个并肩小人）在结盟按钮上表达的是「另一个组织」，跟「好友」同源但不冲突，这是**上一轮就做出的、经过审视的借用**，不是欠账。
- 真要给结盟一枚自己的图，下次**换母题**，别再画手：两个互扣的圆环 / 一枚对半分的印记 / 两面斜插的小旗，都是「26px 上靠外轮廓就能读」的候选。`crit` 是同心圆、`flag` 是单面旗，互扣双环和斜插双旗都还没被占。

两版源图都在 `_rejected/`：`tabicon_handshake_v1_hairline_arms_read_as_a_V.webp`、`tabicon_handshake_v2_clasp_became_a_featureless_ball_2.4to1.webp`。

## 8. 接线记录（2026-09-06，九枚）

`OWN_ART` 57 → **66**（不是文档开头预告的 67 —— 少了 `handshake`）。打包后 `client/src/assets/tabicons/` 从 196 涨到 205 个文件，其余 196 张零字节变化。

| kind | 落在哪 |
|---|---|
| `trash` | `FriendsScene/mail.ts` 删除邮件 · `SettingsScene/panels.ts` 删除账号 · `SettingsScene/overlays.ts` 删除确认弹窗的红按钮 |
| `key` | `LoginScene/forms.ts` 登录入口 + 登录提交 · `SettingsScene/panels.ts` 离线态「登录 / 注册」 |
| `userPlus` | `LoginScene/forms.ts` 注册入口 + 注册提交 |
| `power` | `SettingsScene/panels.ts` 退出登录 |
| `penWrite` | `SettingsScene/panels.ts` 改名 · `WorldMapPanels/territoryWorldTab.ts` 国名改名 |
| `megaphone` | `LobbyScene/mainContent.ts` 侧栏反馈格（`stack` 布局，图标在上） |
| `sheets` | `RoomScene/views.ts` 复制房间码 |
| `enter` | `RoomScene/views.ts` 加入房间 · `FriendsScene/orgBrowse.ts` 家族列表行「加入」×2 |
| `eraser` | `RoomScene/views.ts` 房间码键盘「清空」· `DefenseEditorScene/render.ts` 清空 |

**顺手做掉的三件事**：

1. **i18n 里的 emoji 前缀删了**（三语）：`settings.rename`/`settings.renameFree` 的 `✎`、`room.copy` 的 `📋`。真图标进来之后它们就是重复的，而且 emoji 在微信小游戏字体里本来就是另一套渲染。
2. **`panelButtonIn` 接上了 `drawButtonLabel`**（`WorldMapPanels/core.ts`）。上一轮 96 处没覆盖到它——它自己画一行居中 `txt`。加了可选 `icon` 参数，顺带让所有世界地图面板行按钮获得「太长就整组缩，缩不下就丢图标」的兜底（原本是直接溢出）。
3. **`DefenseEditorScene` 的三枚动作按钮**（保存 / 填满 / 清空）也是上一轮漏掉的一簇，一并接上 `check` / `unit` / `eraser`，零新美术——只给「清空」加图标会让同一簇三枚里两枚光秃秃。

**刻意没动的两处**：好友行的 `✕` 移除按钮（`addButton` 里 `label === '✕'` 的特例路径画的是 `close`，方形图标按钮，不是 `[图标][文案]` 这个形状）；`social.family.joinById` 保留 `zoom`——那个按钮打开的是「按 ID 搜索」子页，放大镜比门更准。

## 9. 三语实拍（2026-09-06，`start:e2e` + 真机 Chrome）

德语跑全套（本批标签最长的一语），中文/英文抽查。**没有一枚按钮触发 `minFit` 的丢图标降级**：

- **登录页（de）**：`Anmelden` 挂钥匙、`Registrieren` 挂人像+加号，深底浅墨，清楚。
- **设置页（de/zh）**：`Umbenennen (100 Münzen)` —— 本批最长的一条标签 —— 图标仍在；`Abmelden` 电源符号、`Konto löschen` 垃圾桶。中文下 `改名（100 金币）` 的 `✎` 已消失，图标接上。
- **删除账号确认弹窗（de）**：红底白墨的垃圾桶 + 取消的 `close`，整组居中。
- **房间页（de/en）**：**`Raum erstellen`（`room` 半开的门）和 `Raum beitreten`（`enter` 门框+箭头）上下相邻**——这一屏就是 §1 里「不画第二扇门」的理由，实拍确认两者一眼分得开。键盘页 `Löschen` 的橡皮在纸底上是深墨，清楚。`Copy`/`Kopieren` 的两张纸按标签色被 tint 成蓝色（`C.accent`），比深墨略淡但结构仍在。
- **大厅侧栏（de）**：喇叭在 `Täglich`(日历) / `Post`(信封) / `Auk.`(号牌) 三张之间，方格 `stack` 布局，不撞。
- **主城防守页脚（de）**：`Leeren`(橡皮) + `Speichern`(对勾) 一簇，按钮宽 70px 仍装得下图标+文案。

验证命令全绿：`typecheck`、`lint`（两条既有 warning，与本批无关）、`build:web`、`vitest run`（261 文件 / 3208 用例）、`test:ui`（261 文件 / 2514 用例）。`check:filelength` 报的 `DailyScene/panels.ts` 567 行是**本批之前就有的**，未触碰。
