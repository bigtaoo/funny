# 批次 12：家族成员行的升/降级方向标 — 语义判断 + Prompt 文档

> 创建：2026-09-10 · 状态：**prompt 已定稿，未出图**（本文档就是待办本身）
> 前十一批：[批 1–4](tab-icon-art-prompts.md) · [批 5](tab-icon-art-prompts-batch5.md) · [批 6](tab-icon-art-prompts-batch6.md) · [批 7](tab-icon-art-prompts-batch7.md) + [批 7 log](tab-icon-art-prompts-batch7-log.md) · [批 8](tab-icon-art-prompts-batch8.md) · [批 9](tab-icon-art-prompts-batch9.md) · [批 10](tab-icon-art-prompts-batch10.md) · [批 11](tab-icon-art-prompts-batch11.md)
> 上游：[`UI_DESIGN_LOG_2026-08.md` §46](../game/UI_DESIGN_LOG_2026-08.md) —— 那一轮把家族成员行的升/降级按钮改成 `↑ Elder` / `↓ Member`，**箭头是文字渲染的**，本批就是来替掉这两个字符的
> 配套代码：[`FamilyScene/lists.ts`](../../client/src/scenes/FamilyScene/lists.ts) · [`buttonLabel.ts`](../../client/src/ui/widgets/buttonLabel.ts) · [`inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts) · [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)

## 0. 为什么是这两枚

2026-09-10 那轮把家族成员行的角色按钮从「Promote to Elder」/「Demote to Member」缩成 `↑ Elder` / `↓ Member`——方向由**箭头 + 颜色 + 权重**编码三遍，实拍确认 27px 上分得清。但那两个箭头是 `↑`/`↓` 两个字符，由文字渲染器按 CJK 回退字体画出来，而 [`UI_DESIGN.md` §「返回箭头改为手绘 glyph（2026-08-19）」](../game/UI_DESIGN.md) 早就为返回按钮否决过同一种做法：**笔画细、字形随平台变，跟旁边手绘图标不是一套语言**。

当时没有一并解决，是因为返回按钮那条禁令的前提是**已经有** `backArrow` 这枚替代资源，而上/下方向在全库 66 张自有美术里没有对应物，本批之前不引入新美术。所以那一轮把这条张力**明写进了** `UI_DESIGN_LOG_2026-08.md` §46 的末尾，并指明路子是「给方向补两枚 glyph」。这就是那两枚。

**优先级低，别当 bug 修**：现状（文字箭头）是可用的，箭头在这里是**冗余**编码——填充、描边、字色已经各自说了一遍方向，箭头掉字形不会让按钮失去区分度。返回按钮当时是把箭头当**唯一**图形在用，那才是必须改。

## 1. 语义判断：为什么是「实心头 + 短粗杆的竖箭头」，而不是别的

判断照 [[pick-icon-glyphs-by-eye-not-name]]：先看**现有那些图（46 枚页签 + 66 张墨线自有美术）在 27px 上读成什么**，再决定新图画什么。方向标是全库最容易撞车的一类——**已经有七处在用箭头或 chevron**，每一处都占掉了一种画法：

| 已占用 | 它长什么样 | 所以本批不能画什么 |
|---|---|---|
| `spd`（移速） | 两个朝右的 `>>` chevron，**没有杆** | **不能用 chevron**。反过来也是好消息：`spd` 自己的 avoid 表里就写着「a full arrow with a shaft and head」——「带杆带头的整支箭」是它主动让出来的地界 |
| `share`（分享） | 一个浅口托盘 + 从盘中直伸出去的向上箭头 | **箭头下面不能有横线/托盘/底座**。这是本批最实的一条：上箭头 + 一道底线正是 `share`，也正是全世界的「上传」 |
| `back`（返回） | 裸横箭头，一根杆 + **两笔开口 V 形箭头**，2.06:1 | 箭头**必须是竖的**，且头**必须是实心三角**，不是两笔开口 V |
| `enter`（加入） | 实心右向箭头头，**画在门框洞里** | 不能加任何外框 |
| `replay`（回放） | 环形箭头 | 杆不能弯 |
| `crit`/`critmult` | 靶心 + 实心箭头头 | 不带靶、不带环 |
| `progressTabIcon`（生涯 / 成就「进阶」） | **三个上 chevron 竖着摞**，rank-up 徽记 | 不能摞、不能三个。它的 avoid 表里同样写着「single arrow」——**又一处主动让出「单支箭」的邻居** |

剩下能站住的造型只有一个：**竖直的一支箭，实心三角箭头 + 短粗杆，四周什么都没有**。

**为什么不直接借 `progressTabIcon`**——它在语义上是全库离「升级」最近的一张（rank-up 徽记）。因为它是**生涯页签的身份**，同时又是成就墙「进阶」分类的图标，借过来就是让一个符号担三种含义，正是批 2 去重表定下的红线；而且它只有「上」没有「下」，降级那半边照样得新画，画完两枚还不成对。

**两枚是一个 family，必须成对评审**——除了方向以外逐处相同（同样的头宽、同样的杆长、同样的笔重），互为镜像。同族先例是 `crit`/`critmult` 和批 9 的三种建筑。

**命名用语义名 `promote`/`demote`，不用 `arrowUp`/`arrowDown`。** 全库的命名法是按意思（`enter`/`power`/`userPlus`），而且语义名顺手挡掉一种退化：叫 `arrowUp` 的东西迟早会被当成通用上箭头借去别处用，那正是「一个符号两种含义」。

## 2. 硬约束（骨架之外，本批必须写进 prompt 的四条）

骨架沿用前十一批，不重复贴（见批 8 §「Prompt 骨架」）；§3 的两条已经组装成完整 prompt，直接复制即可。

1. **验收尺寸是 27×27，不是 26 也不是 28。** `FS.bodyLg = 20`（`lists.ts` 里角色按钮的字号）× `buttonLabel.ts` 的 `ICON_RATIO = 1.35` = 27。按钮宽度会按 `buttonLabelIconW()` 预留出图标位（见 §4），所以 `minFit` 不会把这一组缩档——27 就是它真实渲染的尺寸，prompt 里写死 27。
2. **竖箭头天生是 1:2.5，会撞 `iconArtAspect.test.ts` 的 `MAX_RATIO = 2.2`**（`back` 实测 2.06:1 就是这个形状的下限）。**靠构图解决，不靠模型自觉**：箭头头画到**满框宽**、占掉高度的一半多，杆短而粗、只有框宽的三分之一——整体接近正方形，目标 ≤1.5。前几批同样的手法用在钥匙（斜放）、笔（斜放）、握手（两臂上扬 35°）上。
3. **身份由实心块承担**（批 7 总结第一条）：实心块就是**箭头头**那一整个三角，杆是描线。没有指定实心块的图不要出。
4. **方向必须单看一枚就读得出，不是并排才能比。** 家族名单里一行只出现一个（成员行是升级、长老行是降级），玩家没有对照物。所以 avoid 表里写死「杆不能长过头的高度」——头必须是画面里压倒性的那团黑，黑团在上还是在下就是方向本身。

**标签已经把词说了**（按钮上就写着 `Elder` / `Member`），glyph 只需要承担方向。这是本批可以画得这么简单的原因，也是评审时不要往里加东西的原因。

## 3. Prompt（2 条，直接复制）

### `tabicon_promote`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one single short stubby arrow pointing straight up, and nothing else at all. Its head is ONE SOLID BLACK triangle, as wide as the whole drawing and a little taller than half the drawing's height, with a flat horizontal base and a sharp apex at the top. Hanging straight down from the middle of that base is a short thick shaft, a plain upright bar about one third as wide as the head and shorter than the head is tall, drawn as bare white line art with a bold outline and a blunt flat bottom end. Because the head is so wide and the shaft so short, the arrow is about as wide as it is tall and sits inside a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the triangular head is one flat solid black area and the shaft is bare line art. Must stay clearly recognizable when scaled down to 27x27 pixels, where one heavy black triangle at the TOP with a small stub under it is what reads, so that the direction is obvious from a single icon seen on its own. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, any horizontal line, bar, tray, base, ground line, platform or step under the arrow, an open tray or U shape the arrow rises out of, a chevron or double chevron, a V-shaped open arrowhead drawn as two separate strokes, a curved or bent or circular arrow, a two-headed arrow, more than one arrow, a long thin shaft taller than the head, a slanted or diagonal arrow, a horizontal arrow, a doorway or any frame, box, circle, ring or badge around the arrow, a target or bullseye, a plus sign, a star, a crown, a chart or rising line, motion lines, sparkles, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### `tabicon_demote`

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one single short stubby arrow pointing straight down, and nothing else at all. Its head is ONE SOLID BLACK triangle, as wide as the whole drawing and a little taller than half the drawing's height, with a flat horizontal top edge and a sharp apex at the bottom. Standing straight up from the middle of that top edge is a short thick shaft, a plain upright bar about one third as wide as the head and shorter than the head is tall, drawn as bare white line art with a bold outline and a blunt flat top end. Because the head is so wide and the shaft so short, the arrow is about as wide as it is tall and sits inside a square frame. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the triangular head is one flat solid black area and the shaft is bare line art. Must stay clearly recognizable when scaled down to 27x27 pixels, where one heavy black triangle at the BOTTOM with a small stub above it is what reads, so that the direction is obvious from a single icon seen on its own. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, any horizontal line, bar, tray, base, ground line, platform or step above or below the arrow, an open tray or U shape the arrow drops into, a chevron or double chevron, a V-shaped open arrowhead drawn as two separate strokes, a curved or bent or circular arrow, a two-headed arrow, more than one arrow, a long thin shaft taller than the head, a slanted or diagonal arrow, a horizontal arrow, a doorway or any frame, box, circle, ring or badge around the arrow, a target or bullseye, a minus sign, a star, a chart or falling line, motion lines, sparkles, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 4. 出图后的接线清单

**① 源图归位** — `art/ui/tabicons/tabicon_promote.webp` / `tabicon_demote.webp`，base 名逐字等于 kind 名。被打回的版本进 `art/ui/tabicons/_rejected/`，命名 `tabicon_<kind>_v<n>_<为什么废>.webp`（`inkIconArt.test.ts` 检查「每个 kind 恰好一个源图」）。

**② `pack_tab_icons.cjs`** — `JOBS` 末尾加两行，**一律 `inks: ['active']`**（只烤白色母版、运行时 tint）。这两枚尤其需要 tint 而不是烤墨：升级按钮的字是金 `0xa9750f`、降级是灰 `MUTED`，两种墨色由 `buildInkIcon` 从标签色跟出来。

**③ 跑打包** — `node art/ui/tabicons/pack_tab_icons.cjs` → `client/src/assets/tabicons/<kind>_active.png`。跑完确认「只有新增那 2 张变化，其余零字节改动」。

**④ `inkIconRaster.ts`** — 三处：2 行 `import`（挂在批 12 的注释段下，注释里写清 §1 那张撞车表的结论）、`InkIconKind` 加 `'promote' | 'demote'`、`INK_ICON_ART` 加 2 行。

**⑤ 调用点，1 处** —— [`FamilyScene/lists.ts`](../../client/src/scenes/FamilyScene/lists.ts) 的角色切换按钮。这处**不是**填一个 `icon:` 就完事，因为它当前自己画一个居中 `txt()`、而且**按标签宽度自定宽**：

- `roleW` 的算式要先加上 `buttonLabelIconW(FS.bodyLg)`（`buttonLabel.ts` 导出这个函数正是为了「自定宽的 pill 先把图标位算进去，别让整组在只够放字的盒子里被缩档」——宗门头部的结盟 pill 是同一个用法）；
- 然后把 `txt()` + 手摆坐标换成 `drawButtonLabel(list, bx, btnY, roleW, btnH, t(...), toElder ? 'promote' : 'demote', roleColor, FS.bodyLg)`，**不传 `variant`**（纸底按钮，让标签色决定，见 `UI_DESIGN.md` §2 的墨色变体那条）；
- 三语 i18n 值里的 `↑ `/`↓ ` 前缀**同时删掉**（`family.setElder`/`family.setMember`，en/de/zh 各一处）——真图标进来后它们是重复的。批 11 删 `settings.rename` 的 `✎` 与 `room.copy` 的 `📋` 是同一件事。

**⑥ 测试** — `client/test/render/inkIconArt.test.ts` 的 `expect(OWN_ART.length).toBe(66)` → `68`，并补上批 12 的算式注释。`iconArtAspect.test.ts` **不要改**：这两枚超 2.2:1 恰恰是「头画得不够宽、杆画得太长」的信号，也就是「这张该重出」，不是「该加豁免」。

顺带一条：[`familyKickOfficerGuard.ui.ts`](../../client/test/ui/familyKickOfficerGuard.ui.ts) 的 `findKickHits` 已经在 09-10 那轮改成按布局语义认按钮（取每行 x 最大的那个按钮高度 rect），**不再依赖标签宽度**，所以本批把标签又改短一截不会再弄红它。若它又红了，先怀疑是不是有人把它改回了几何指纹。

**⑦ 验证** — `npm run typecheck`、`npm run lint`、`npm run build:web`（**类型过了不等于构建过了**：这 2 张走 `import`，文件名错一个字母只有 webpack 会报）、`npm run check:filelength`、`vitest run` + `test:ui` 全量。

## 5. 验收口径

1. **27px × 纸底（`C.paper` `#f5f0e8`）两张 contact sheet，金墨 `#a9750f` 和灰墨 `#5a574f` 各一遍。** 96px 预览不算数。脚本临时写在 scratchpad，用完删。这两枚**不需要**深底那张——它们只出现在纸底的成员卡上。
2. **单看一枚要读得出方向**（§2 第 4 条）。评审方式：把两张分别单独放大到 27px 看，**别并排**；并排永远分得清，那不是这个按钮的处境。
3. **成组并排看**，本批必须过的三组：
   - `promote` vs `demote` vs `spd`（横 chevron）vs `progressTabIcon`（竖摞三 chevron）vs `back`（裸横箭头）——箭头族，本批最危险的一组，且 `progressTabIcon` 就在底栏常驻；
   - `promote` vs `share`（托盘上箭头）——只要有人手滑给底下加了一道线，这两张就是同一张；
   - `demote` vs `enter`（框里的实心箭头头）——确认没有任何外框痕迹。
4. **真机实拍三语，横屏分栏 + 竖屏整栏各一次**（家族页两种朝向的列宽不同）。德语下要专门确认按钮**没有被 `minFit` 判成放不下而丢掉图标**——丢了是 `roleW` 忘了加 `buttonLabelIconW`，不是图标的问题。竖屏怎么逼出来见 `UI_DESIGN_LOG_2026-08.md` §46 末尾（`resize_window` 在开发机上不生效）。
5. **判定标准是「读成什么」，不是「好不好看」**。任何一张在 27px 上读成邻居那张，就按批 7 log 的格式记下 v1 为什么塌，**只改导致返工的那一处措辞**再重出。
6. **允许结案为「不画」**。批 11 的 `handshake` 是先例：两版都塌、根因是尺寸与约束互相矛盾而非措辞，于是结案继续借用。这两枚的兜底就是现状——文字 `↑`/`↓`，它已经在跑了。
