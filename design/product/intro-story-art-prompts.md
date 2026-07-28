# 开场插画 — 图片生成 Prompt 文档

> 更新：2026-07-28
> 配套代码：`client/src/scenes/IntroScene.ts`（`story.line.*` 逐行淡入，插画待接线——见文末「代码接线计划」）
> 美术总纲：[`art-direction.md`](art-direction.md)
> 叙事出处：[`world.md`](world.md)「序 · 本子（真实层框架）」
> 同类文档：[`shop-art-prompts.md`](shop-art-prompts.md) · [`../game/ANNA_CHARACTERS.md`](../game/ANNA_CHARACTERS.md)（AI 图 prompt 惯例的参照来源）

---

## 背景

开场 `IntroScene` 目前只有纯文字（`story.line.1`~`.7`，见 `CAMPAIGN_STORY.md`「真实层框架落地」一节）+ 纸面背景，没有插画层。要加一张"父亲把笔记本递给陶"的场景插画，铺在文字后面、透明度 0.6，与第 3 行（`story.line.3`："生日那天，父亲递给他一个笔记本，说'记点东西吧。'"）同步淡入，之后常驻到 IntroScene 结束。

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

**出图反馈（用户，2026-07-28）**：出图整体风格/构图/留白都对，但两处不符合设定——① 房间读成了中式室内（茶壶、柜子风格），但陶一家实际住在德国；② 父亲画成了粗犷外套、略显潦倒的样子，但父亲的职业是软件工程师，不该是那种状态。两条都改写进 v2。

### v2（当前，用于实际出图）

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, no photorealism, no 3D render, no anime style — kept clearly a modest hand-drawn illustration, not professional concept art. Wide horizontal composition. In the lower half of the frame, inside a plain modest Central European apartment kitchen at evening — simple minimalist Western furniture, plain white or pale wood cabinets, an ordinary European ceiling pendant lamp, no East Asian decor, teapots, or furniture anywhere in the room — a tired East Asian father dressed as an ordinary software engineer just home from work stands already half-turned toward a doorway as if about to leave again, wearing a plain simple button-front shirt or sweater with a light jacket half slipping off one shoulder and a laptop bag strap resting over the other shoulder, no bulky work coat, no disheveled or worn-down look, just ordinary office tiredness with a calm neutral face, not haggard. He extends one arm holding out a small plain notebook with a deep blue cover and grid-paper pages toward a quiet East Asian boy around nine or ten years old standing at a small table nearby. The boy wears simple ordinary contemporary clothes, reaching up with both hands to receive the notebook, calm and a little uncertain, not smiling, not crying, just quiet. Warm amber lamp light spills from the ceiling pendant lamp above the table, meeting a cool muted blue-grey dusk light from a small window behind them showing an ordinary European city street outside with plain buildings, no East Asian rooftops or signage; keep the palette to about four muted tones only — warm amber lamp light around hex D9A85C, soft cool dusk blue-grey around hex 5A6B7A, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — a bare wall or window with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## 代码接线计划（待美术落地后执行）

用户已确认插画在开场如何呈现：与 `story.line.3` 同步淡入，之后常驻到场景结束。落地时改 `client/src/scenes/IntroScene.ts`：

1. `import introIllustrationUrl from '../assets/story/intro_notebook.png';`，`PIXI.Sprite.from(introIllustrationUrl)` 建一层插画 sprite，叠在 `buildPaperBackground` 之上、文字行之下（`addChild` 顺序：纸面背景 → 插画 sprite → 文字行 → 提示/跳过）。
2. 插画初始 `alpha = 0`，目标 `alpha = 0.6`。复用现有的逐行淡入计时器（`fadeT`/`FADE_DURATION`）——当 `shownCount - 1 === 2`（对应第 3 行，0-indexed）时，插画 alpha 跟着该行的淡入进度同步涨到 0.6，而不是新开一套独立计时器。
3. 用户点击瞬间完成当前行淡入的既有逻辑（`current.alpha = 1`）需要同步把插画 alpha 直接置到 0.6（若当前行正是第 3 行）。
4. 第 3 行之后（第 4~7 行淡入期间），插画保持 0.6，不再变化，直到整个 IntroScene 结束（跳过或看完）。

**在此之前**：`client/src/assets/story/intro_notebook.png` 这个路径还不存在，不要提前加这行 `import`——TS 的 `*.png` 模块声明不检查物理文件是否存在，但 webpack 打包会因文件缺失直接报错，会破坏共享主目录的构建。等文件落地后再一次性接线 + 验证（`tsc` + webpack 生产构建 + 浏览器截图核对淡入时机），走独立 worktree + 分支，完工后按惯例合并进当日分支。
