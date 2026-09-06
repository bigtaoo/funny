# 签到月历「可领取」指示图 — Prompt + 接线计划

> 创建：2026-09-05 · 出图+接线完成：2026-09-05 · 状态：**已完成**（2 张新图 / 2 张 PNG，两张都用上了）
> 配套代码：[`client/src/scenes/DailyScene/panels/checkin.ts`](../../client/src/scenes/DailyScene/panels/checkin.ts)（`renderCheckin`，2026-09-06 从 `panels.ts` 拆出）
> 设计背景：[`../game/RETENTION_DESIGN.md §10.16`](../game/RETENTION_DESIGN.md)
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6 · 同类单图先例：[`back-arrow-art.md`](back-arrow-art.md)

## 这两张图要解决什么

§10.16 已经把"可签到格 = 唯一焦点"用**纯代码通道**做出来了（最粗描边 + 二次描框 + 放大 + 呼吸 + 标题行点名），实拍确认有效。这两张图是**再加一档**的可选增强，属于"锦上添花"而不是"缺了就不成立"：

- **A 弯箭头**（主推）：画在格子外侧，指进格子。笔记本里"手写批注箭头"的语汇，和用户自己在反馈截图上圈红圈的动作是同一个手势。
- **B 放射星芒**（备选/补充）：画在格子**背后**，不需要格子外有空地——网格四条边上的格子（第 1/6/25/30 天这类）留给箭头的空间最紧张，星芒对位置没有要求。

两张都出也行（A 用在有空地的格子，B 兜底边缘格）；只出一张就出 A。

## 尺寸与形状约束（先看这条再写 prompt）

打包管线按**长边**归一到 128px（`art/ui/tabicons/pack_tab_icons.cjs` 那套），所以**决定最终笔画粗细的是"笔画占图形长边的比例"，不是画布上的绝对像素**。返回箭头那张 2.06:1 的扁形状因此吃了 3 道膨胀才够（见 [`back-arrow-art.md`](back-arrow-art.md)「会不会太细」）。

这两张都要求**接近正方形**（1:1 ~ 1.2:1），画面里**只有一个图形**：

- 屏上尺寸：A 约 `0.5 × cellH`（横屏 1920 设计宽下约 55px），B 约 `1.5 × cellH`。
- A 只画一个朝向（右下），代码里用 `scale.x = -1` / 旋转覆盖四个方向——所以**不要**画对称图案，也不要在图里带任何文字或数字。
- 出图后按 `pack_tab_icons.cjs` 的口径量一遍：内容 bbox 宽高比、笔宽占长边的百分比、折算到实际显示尺寸的像素宽（目标 ≥ 2px），不够就加膨胀道数——**能吃几道膨胀是形状的属性，不是全局常量**。

## A · 弯箭头（`checkin_cue_arrow.png`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished, bold and thick strokes. Subject: ONE curved arrow sweeping from the upper-left of the frame down to the lower-right, ending in an open V-shaped arrowhead that points down and to the right (two short strokes meeting at the tip, NOT a filled solid triangle). The shaft is a single gentle arc — one smooth bend, no loop, no spiral, no S-curve, no second bend. Just the arc and the head, nothing else: no tail feathers, no dashes, no motion lines, no circle or box around it, no target, no hand, no cursor. The arrowhead is large and open, roughly a third of the arrow's total length. The stroke is drawn with a thick marker-weight pen: the ink line's width is about one twelfth of the frame's width, uniform along the whole shaft, so the arrow still reads as an arrow when the picture is shrunk to 48 by 48 pixels. The drawing fills the frame corner to corner and is roughly as tall as it is wide. Plain pure-white background, no grid lines, no paper texture, no other elements. Flat 2D, no shading, no gradient, no gloss. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, drop shadow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, looping undo arrow, circular refresh arrow, double chevron, two or three stacked chevrons without a shaft, straight arrow with no curve, upward or leftward direction, filled solid triangle head, arrow through a target, mouse cursor, hand pointer, pointing finger, multiple arrows, confetti dots, sparkles, text, letters, numbers, watermark, gray background, notebook grid lines.
```

出图尺寸建议 1024×1024。

## B · 放射星芒（`checkin_cue_burst.png`）

集中線的语汇：格子盖在它中间，只有外圈的放射笔画露出来。所以**中间必须是空的**，且笔画数量/间距要给死，不能用形容词描述"密度"（形容词控制不了密度，会在 3–4 倍之间乱摆——见记忆 `ai-art-density-cannot-be-prompted`）。

```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished, bold and thick strokes. Subject: a starburst of exactly TWELVE straight strokes radiating outward from the centre of a square frame, evenly spaced around the full circle like the hours on a clock face. The middle of the frame is EMPTY: every stroke starts at the edge of an empty circular area whose diameter is half the frame's width, and runs outward from there to near the frame's edge — nothing at all is drawn inside that empty middle, no dot, no ring, no circle outline, no star shape. The strokes are straight lines, not triangles and not tapered wedges; each is drawn with a thick marker-weight pen about one fortieth of the frame's width, and the white gaps between neighbouring strokes are far wider than the strokes themselves. The twelve strokes alternate in length: six longer ones reaching almost to the frame edge and six shorter ones stopping about two thirds of the way out. Plain pure-white background, no grid lines, no paper texture, no other elements. Flat 2D, no shading, no gradient, no gloss. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, drop shadow, 3d render, photorealistic look, vector-art look, sun with a face, sun disc, filled centre, solid black centre, circle or ring in the middle, five-pointed star, sparkle or twinkle shapes, spiral, curved rays, more than twelve rays, dense hatching, cross-hatching, text, letters, numbers, watermark, gray background, notebook grid lines.
```

出图尺寸建议 1024×1024。

## 接线计划（写 prompt 时的设想，实际落地见下节的三处修正）

1. 打包：走 `art/ui/tabicons/pack_tab_icons.cjs` 的同一套 `inkify` + `dilateAlpha` 管线（**不要** `sharp.tint()`，它对黑墨是静默 no-op）。墨色只需要 `content`（`C.dark`）一档；箭头/星芒都只画在纸面上，不会出现在深色格里。
2. 位置（A）：画在可签到格外侧、朝向网格**外缘**的那个角——即左半边的格子用镜像后的箭头从左侧指入，右半边从右侧指入，第一行的格子从下方指入。选"哪边空地大"，别硬编成固定一侧。
3. 位置（B）：以格子中心为心，边长 `1.5 × cellH`，**加在可签到格容器的最底层**（跟着一起呼吸）。
4. 两张都**不进 `uiCache`**：AI PNG 是异步解码的，烘进缓存会把"没有图的那一帧"永久留在缓存 key 上（返回箭头踩过，见 `back-arrow-art.md`「接线要点」）。
5. 尺寸走常量比例，不读纹理宽度；配一条对着真 PNG IHDR 校验比例的测试（同 `backArrowArt.test.ts`）。
6. 验收：在真 Chrome 里按 §10.16 的四种状态各看一遍，重点看**边缘格**（第 1/6/25/30 天）有没有被裁切或压到邻格。

## 实际落地（2026-09-05 当天完成）

两张图一次过，都用上了。源图 `art/ui/tabicons/tabicon_cueArrow.png` / `tabicon_cueBurst.png`（各 1254×1254），产物 `client/src/assets/tabicons/cue{Arrow,Burst}_checkinCue.png`。

### 墨色不是 `content`，是新加的 `checkinCue`

计划里写的是烤 `content`（`C.dark` 墨黑）。实际改成在 `INKS` 里新加一档 **`checkinCue` = `#2e7d32`**，也就是可签到格描边的那个绿。理由：这两张图的全部意义就是"指向那一个绿格子"，用墨黑画出来会读成"页面上又多了一个重要元素"，用同色画出来才读成"那个格子的一部分"。代价是这个绿在两个地方各存了一份（packer 的 `INKS` 表、`panels/checkin.ts` 的 `INK_CLAIMABLE`），编译器和渲染器都不会去比对它们——所以 `client/test/render/checkinCueArt.test.ts` 用正则把两处都读出来直接断言相等，并且顺带断言 PNG 调色板里真的有这个颜色（防"表改了、图没重打"）。

### 打包管线的一个静默 bug（本轮触发并修掉）

`pack_tab_icons.cjs` 第 1 步是"alpha = 255 − 亮度"（白纸→透明）。**箭头这张出图自带 alpha 通道**（透明背景 + 黑笔画），而此前 46 张源图全是不透明白底，所以这条路径从没被走过：sharp 会把全透明像素的 RGB 清零，于是笔画外的每一个像素都是"亮度 0 = 满墨"，打出来是**一整块纯色方块**。失败是静默的——方块也是合法 PNG，`console.table` 照样打印尺寸。

修法：`process()` 里先 `metadata()`，`hasAlpha` 就 `.flatten({ background: '#ffffff' })` 再进原管线。**以后任何一张带透明背景的源图都不会再踩这个坑**。

### 量出来的数（不靠眼睛）

| | bbox | 长边笔宽 | 归一到 128 | 显示尺寸下 peak/mean alpha |
|---|---|---|---|---|
| 星芒源图 | 1169×1145 | 27px = 2.31% | 2.96px | @140px：100% / 20.8%；@200px：100% / 20.9% |
| 箭头（打包后） | 128×126 | — | — | @45px：100% / 18.9%；@62px：100% / 18.8% |
| （参照）已验收的返回箭头 | — | — | — | @24px：100% / 30.7% |

两张都是 `thicken: 2`，在最小显示尺寸（箭头 ~45px）仍有 100% peak alpha、10.5% 全不透明像素占比——跟返回箭头同一量级，没有 08-19 那批"细到半透明"的问题，不需要再加膨胀道数。

### 位置：三条都跟计划不一样，都是实拍改的

1. **箭头永远从下方来**，横向朝纸面外缘（左半边格子→左下，右半边→右下）。计划里写的"第一行从下、其余从上"实拍后否掉了：从上方来时，箭尾正好落在**上一行里程碑格右上角的金币徽章**上（第 24 天可领时最明显）。改成一律从下之后，箭尾要么落在下一行格子没有内容的下半部，要么（最后一行）落在空白纸面上；`col ≥ COLS/2` 时朝右，最后一列的箭尾直接甩进右侧页边距。
2. **星芒被裁掉了顶边**。计划里只说"以格子中心为心"，实拍第 1 天（第一行）时，向上的几道光线**直接穿过"签到月历"这行小标题**。加了一个从 `gridTop` 起算的矩形 mask——只裁上边，左右和下方随它铺开（那三个方向只会碰到纸）。
3. **星芒不跟着呼吸，且比计划淡**。`1.6 × cellH` 改 `1.5`，alpha 定在 `0.4`：`0.5` 时向下的光线把下一行格子的数字盖得发糊。它仍然加在可签到格容器里（所以会跟着缩放），mask 也在同一个容器里一起缩放——因为 mask 只管顶边、而缩放是绕格心的，顶边最多多露 9% × burstSize 的一条，实拍看不出来。

### 验收

真 Chrome 逐个状态看过：第 1 天（左上角，标题裁切）、第 4 天（普通格）、第 24 天（右半边、下一行是里程碑，徽章不被压）、第 30 天（右下角，箭尾进页边距）。`tsc` 绿、`vitest` 3196 例 + UI 42 例全绿、`webpack --mode production` 通过。
