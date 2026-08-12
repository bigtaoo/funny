# 开场插画 — 图片生成 Prompt 文档

> 更新：2026-07-28
> 配套代码：`client/src/scenes/IntroScene.ts`（`story.line.*` 逐行淡入 + 插画层，已接线——见文末「代码接线计划」）
> 美术总纲：[`art-direction.md`](art-direction.md)
> 叙事出处：[`world.md`](world.md)「序 · 本子（真实层框架）」
> 同类文档：[`shop-art-prompts.md`](shop-art-prompts.md) · [`../game/ANNA_CHARACTERS.md`](../game/ANNA_CHARACTERS.md)（AI 图 prompt 惯例的参照来源）

---

## 背景

开场 `IntroScene` 目前只有纯文字（`story.line.1`~`.7`，见 `CAMPAIGN_STORY.md`「真实层框架落地」一节）+ 纸面背景，没有插画层。要加一张"父亲把笔记本递给涛"的场景插画，铺在文字后面、透明度 0.6，与第 3 行（`story.line.3`："生日那天，父亲递给他一个笔记本，说'记点东西吧。'"）同步淡入，之后常驻到 IntroScene 结束。

这张图不是角色卡立绘（单人物、白底、AI 图管线里"孤立角色"那一类），而是**双人物叙事场景插画**——同属 §〇「AI 图」资产分工里的"插画式地图元素"一类，走同一条 AI 出图 → GIMP 精修 → 落地的管线，只是构图是场景而非单角色。

## 目标文件

| 用途 | 目标文件 | 建议尺寸 |
|---|---|---|
| 开场插画 | `client/src/assets/story/intro_notebook.png` | 长边 ≥1600px，横版（约 16:9），透明或纯白背景均可（代码侧按 0.6 alpha 叠在纸面背景上，纯白底会自然融进米白纸色） |

`story/` 是新增子目录（与现有 `assets/units/` `assets/buildings/` `assets/spells/` `assets/decor/` 并列）。

## 出图工具

同 `ANNA_CHARACTERS.md` 惯例：首选 **ChatGPT（GPT-4o / DALL·E 3）**，备用 Bing Image Creator / Mistral Le Chat(FLUX)。上线前需核对所选工具的商用授权。

## AI 图生成 Prompt

**单段肯定句**（同 Aello/Björn/Lerna 的"最终定稿"惯例——否定句在本项目常用工具上不可靠，全部要素改写成肯定句）：

### v1（2026-07-28 出图，已废弃）

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, no photorealism, no 3D render, no anime style — kept clearly a modest hand-drawn illustration, not professional concept art. Wide horizontal composition. In the lower half of the frame, inside a small plain modest apartment kitchen at evening, a tired East Asian father in ordinary everyday clothes with his coat half on stands already half-turned toward a doorway as if about to leave again, one arm extended holding out a small plain notebook with a deep blue cover and grid-paper pages toward a quiet East Asian boy around nine or ten years old standing at a small table nearby. The boy wears simple ordinary contemporary clothes, reaching up with both hands to receive the notebook, calm and a little uncertain, not smiling, not crying, just quiet. Warm amber lamp light spills from a ceiling lamp above the table, meeting a cool muted blue-grey dusk light from a small window behind them; keep the palette to about four muted tones only — warm amber lamp light around hex D9A85C, soft cool dusk blue-grey around hex 5A6B7A, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — a bare wall or window with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

**出图反馈（用户，2026-07-28）**：出图整体风格/构图/留白都对，但两处不符合设定——① 房间读成了中式室内（茶壶、柜子风格），但涛一家实际住在德国；② 父亲画成了粗犷外套、略显潦倒的样子，但父亲的职业是软件工程师，不该是那种状态。两条都改写进 v2。

### v2（当前，用于实际出图）

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, no photorealism, no 3D render, no anime style — kept clearly a modest hand-drawn illustration, not professional concept art. Wide horizontal composition. In the lower half of the frame, inside a plain modest Central European apartment kitchen at evening — simple minimalist Western furniture, plain white or pale wood cabinets, an ordinary European ceiling pendant lamp, no East Asian decor, teapots, or furniture anywhere in the room — a tired East Asian father dressed as an ordinary software engineer just home from work stands already half-turned toward a doorway as if about to leave again, wearing a plain simple button-front shirt or sweater with a light jacket half slipping off one shoulder and a laptop bag strap resting over the other shoulder, no bulky work coat, no disheveled or worn-down look, just ordinary office tiredness with a calm neutral face, not haggard. He extends one arm holding out a small plain notebook with a deep blue cover and grid-paper pages toward a quiet East Asian boy around nine or ten years old standing at a small table nearby. The boy wears simple ordinary contemporary clothes, reaching up with both hands to receive the notebook, calm and a little uncertain, not smiling, not crying, just quiet. Warm amber lamp light spills from the ceiling pendant lamp above the table, meeting a cool muted blue-grey dusk light from a small window behind them showing an ordinary European city street outside with plain buildings, no East Asian rooftops or signage; keep the palette to about four muted tones only — warm amber lamp light around hex D9A85C, soft cool dusk blue-grey around hex 5A6B7A, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — a bare wall or window with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## 代码接线计划（已完成，2026-07-28）

v2 出图（源图 `D:\funny\art\story\cf1f6fad-c3b1-43ad-8899-8f5d3a67fec7.png`，1536×1024）经 `sharp` 压缩（`resize(width:1200)` + `png({palette:true, colors:128})`）落地为 `client/src/assets/story/intro_notebook.png`（1200×800，~237KB，与 `shop-art-prompts.md` 同类单图 ~100–140KB 的量级相近）。`client/src/scenes/IntroScene.ts` 接线：

- [x] `import introIllustrationUrl from '../assets/story/intro_notebook.png'` + `getArtTexture()`（复用 `render/cardArt.ts` 的纹理缓存，同 `ART_TEX_OPTIONS`）建插画 sprite，叠在 `buildPaperBackground` 之上、文字行之下。
- [x] 插画初始 `alpha = 0`，随 `story.line.3`（`ILLUSTRATION_LINE_INDEX = 2`，0-indexed）的淡入进度同步涨到 `ILLUSTRATION_TARGET_ALPHA = 0.6`（`syncIllustrationAlpha()`，每帧按 `shownCount` 与该行当前 `alpha` 计算，不需要额外计时器，用户点击瞬间完成该行淡入时天然同步跳到 0.6）；第 3 行之后保持 0.6 常驻到场景结束。
- [x] cover-fit 铺满整个画布：`scale = Math.max(w/tex.width, h/tex.height)`，`anchor(0.5,0.5)` 居中；纹理未就绪时挂 `baseTexture.once('loaded', ...)` 补算缩放（同 `CardScene/base.ts drawArtFit` 的既有套路）。
- [x] **顺带修的一个既有 bug**：上一轮只往 i18n 文件里加了 `story.line.5`~`.7` 的文案，却忘了把 `IntroScene.ts` 的 `STORY_LINE_KEYS` 数组也扩到 7 项——之前那三行（含点题的第 7 行）实际上从未被渲染过。这次一并补上。
- [x] **开场自动推进**（用户 2026-07-28 追加需求）：不再要求每行都手动 tap——每行淡入完成后最多等 `AUTO_ADVANCE_DELAY = 5` 秒无操作就自动前进（`step()` 抽出 tap 和自动计时共用的推进逻辑）；但**最后一行例外**，不自动结束——IntroScene 结束后接的是 `gateConsent` 隐私同意流程，自动跳过去会让用户来不及看完结尾就已经被带去隐私页，故最后一行停住等显式 tap。

验证：`tsc --noEmit` + webpack 生产构建通过；浏览器 dev server 手测（用户直接确认效果，截图工具当次环境下拿不到画面）。
