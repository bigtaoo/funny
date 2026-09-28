# CrazyGames 封面出图 prompt

> 创建：2026-09-28。用途：CrazyGames 提审要的三张封面（[`store-assets-checklist.md §4.1`](release/store-assets-checklist.md)）。
> 为什么不直接用截图：官方封面规则明确**不收游戏截图**，要风格化的主视觉；现有 `art/store/icons/crazygames_thumb_1280x720.png` 就是战斗截图，尺寸也不对。
> 画风依据：[`art-direction.md`](art-direction.md) §一/§三（笔记本方格纸、蓝笔=我方、红笔=敌方、平涂+排线、无渐变无辉光）。

## 1. 出图时附上的参考图

AI 工具支持参考图时，把下面几张一起喂进去（风格参考 / 角色参考）：

| 参考 | 文件 | 用来锁什么 |
|---|---|---|
| 角色 · 盾位 Lena | `art/units/lena.png` | 角色画风（铅笔线 + 水彩）、蓝色圆盾 |
| 角色 · 弓手 Mara | `art/units/mara.png` | 同上，第二个主角 |
| Logo | `art/logo/logo.png` | 配色（深蓝 / 红 / 铅笔黄 / 米白方格纸）、钢笔 + 红马克笔 + 铅笔的道具语言 |
| 战场 | `art/store/en/battle__landscape_16x9.png` | 方格纸战场、蓝红两座手绘城堡——**只当构图参考，别让模型照搬 UI** |
| 大地图 | `art/store/en/world__landscape_16x9.png` | 等距小城、墨水瓶/回形针散落的桌面感（可选） |

## 2. 共同规则（每条 prompt 都已写进去，改 prompt 时别删）

- 画面上**只许有游戏名 “NOTEBOOK WARS”**，没有别的字（不写 New / Play / 宣传语、没有 UI、没有数字）。
- 不加边框，不放任何商店图标或 logo 角标。
- 手机缩略图尺寸下要一眼看清：主体 ≤ 3 个角色 + 1 个标题，背景简单。
- 不要渐变、发光、3D 光泽（art-direction §3.4）。
- 蓝方是主角，红方是对手，同一支笔画的——红方可以画成红墨水涂鸦小兵，**不画血腥**。

**标题字的两条路**（AI 画字常常错拼）：
- A：让 AI 直接画标题（prompt 里已写）。出来的字拼错或糊了就走 B。
- B：用每条末尾的「无字版」补丁去掉标题，出图后交给我：我按三种尺寸加上手写风标题并裁到精确像素（1920×1080 / 800×1200 / 800×800）。

**尺寸**：生成时选最接近的比例（16:9、2:3、1:1），分辨率尽量高；最终裁切缩放我来做，别在 AI 工具里硬拉伸。

## 3. 横版 1920×1080（16:9）

```
Key art illustration for a mobile strategy game called "NOTEBOOK WARS". Landscape 16:9.
An open school notebook with cream grid paper fills the whole frame, seen slightly from above,
with light blue grid lines, a soft red margin line, a few pencil smudges and a folded corner.
The war is drawn on the paper: on the left page a small blue-ink army charges right —
in front, a sturdy teenage girl shield-bearer with auburn braids, chainmail and a big round
cobalt-blue shield; behind her a slim teenage archer girl with long wavy blond hair drawing a bow
with blue-fletched arrows; a few tiny blue fountain-pen doodle soldiers follow.
On the right page a crowd of scribbled red-ballpoint doodle stick soldiers and a red-ink
hand-drawn castle rush toward them. A blue-ink hand-drawn castle stands behind the blue army.
Where the two sides meet in the center, a burst of red marker strokes and pencil hatching.
A yellow wooden pencil, a blue fountain pen and a red felt marker lie across the bottom edge of the paper.
Across the top, the title "NOTEBOOK WARS" is hand-lettered in bold dark-blue fountain-pen ink
with a red marker underline, clean and perfectly legible.
Style: pencil linework with soft watercolor wash, flat color with cross-hatching shading,
warm cream paper, palette of navy blue, cobalt, red, pencil yellow and cream.
Characters rendered like detailed storybook watercolor illustrations; the doodle soldiers
like quick ballpoint sketches. Clear silhouettes, uncluttered, readable at thumbnail size.
No text other than the title, no UI, no numbers, no border, no logo, no watermark,
no gradients, no glow, no 3D render, not a screenshot.
```

无字版补丁：把 “Across the top, the title … legible.” 整句换成
`Leave the top quarter of the paper empty (plain grid paper) for a title to be added later.`，
并把末尾 “No text other than the title” 改成 `No text at all`。

## 4. 竖版 800×1200（2:3）

```
Vertical 2:3 key art illustration for a mobile strategy game called "NOTEBOOK WARS".
A single page of cream grid notebook paper fills the frame, light blue grid lines, a thin red margin
line on the left, slight pencil smudges.
At the top, the title "NOTEBOOK WARS" hand-lettered in bold dark-blue fountain-pen ink, stacked on
two lines ("NOTEBOOK" above "WARS"), with a red marker underline, clean and perfectly legible.
Center: a sturdy teenage girl shield-bearer with auburn braids, chainmail and a large round
cobalt-blue shield, braced and facing up-right; just behind her shoulder a slim teenage archer
girl with long wavy blond hair aims a bow upward, blue-fletched arrow.
Upper right: a swarm of scribbled red-ballpoint doodle stick soldiers charging down at them,
with red marker speed lines. Bottom: a blue-ink hand-drawn castle, and a yellow pencil and a red
felt marker lying diagonally across the bottom corner.
Style: pencil linework with soft watercolor wash, flat color with cross-hatching shading,
palette of navy blue, cobalt, red, pencil yellow and cream. Storybook watercolor characters,
quick ballpoint-sketch enemies. Bold, simple composition, readable at small size.
No text other than the title, no UI, no numbers, no border, no logo, no watermark,
no gradients, no glow, no 3D render, not a screenshot.
```

无字版补丁：把 “At the top, the title … legible.” 换成
`Leave the top third of the page empty (plain grid paper) for a title to be added later.`，
末尾同样改成 `No text at all`。

## 5. 方形 800×800（1:1）

方形最小、在门户里最常以缩略图出现，只放**一个角色 + 一个对手群 + 标题**。

```
Square 1:1 key art for a mobile strategy game called "NOTEBOOK WARS".
Cream grid notebook paper background with light blue grid lines, simple and clean.
Title "NOTEBOOK WARS" hand-lettered in bold dark-blue fountain-pen ink across the top,
with a red marker underline, large, clean and perfectly legible.
Below it, a sturdy teenage girl shield-bearer with auburn braids and chainmail raises a big round
cobalt-blue shield, confident smile, facing right; from the right edge a few scribbled
red-ballpoint doodle stick soldiers charge at her shield, a burst of red marker strokes where they hit.
A yellow pencil lies along the bottom edge.
Style: pencil linework with soft watercolor wash, flat color with cross-hatching shading,
palette of navy blue, cobalt, red, pencil yellow and cream. Very few elements, strong silhouette,
readable as a tiny thumbnail.
No text other than the title, no UI, no numbers, no border, no logo, no watermark,
no gradients, no glow, no 3D render, not a screenshot.
```

无字版补丁：把 “Title … legible.” 换成
`Leave the top third empty (plain grid paper) for a title to be added later.`，末尾改成 `No text at all`。

## 6. 出图后的验收（交给我之前先自查）

- [ ] 标题拼写是 NOTEBOOK WARS（两个 O、一个 K），没有多余的字母或别的字。
- [ ] 缩到手机缩略图大小（约 200 px 宽）还能认出人物和标题。
- [ ] 没有 UI 元素、数字、边框、水印。
- [ ] 蓝方在画面里是主角，红方是涂鸦小兵；没有血。
- [ ] 横竖方三张像同一套主视觉（同样的角色、同样的纸和笔）。

交图后我这边做：裁切/缩放到精确像素、（无字版时）加标题、按门户上限压缩、放进 `art/store/crazygames/`，并更新 §4.1 状态。

## 7. 出图结果（2026-09-28）

三张都走 A 路（AI 直接画标题，拼写正确），未用无字版。处理：居中裁到精确比例 → Lanczos 缩放 → JPG q92。

| 成品 | 原图尺寸 | 大小 |
|---|---|---|
| `cover_landscape_1920x1080.jpg` | 1672×941（放大 1.15×） | 874 KB |
| `cover_portrait_800x1200.jpg` | 1024×1536 | 494 KB |
| `cover_square_800x800.jpg` | 1254×1254 | 311 KB |

原图留在 `art/store/crazygames/src/`，重裁时从这里出。
