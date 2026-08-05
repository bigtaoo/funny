# 章末插画 — 图片生成 Prompt 文档

> 更新：2026-08-04
> 叙事出处：[`world.md`](world.md)「章末真实层：陶与 Anna」
> 同类文档：[`intro-story-art-prompts.md`](intro-story-art-prompts.md)（开场插画，本档的构图/风格惯例来源）· [`../game/CAMPAIGN_STORY.md`](../game/CAMPAIGN_STORY.md)
> 状态：草稿，尚未出图、未接代码——本文档只是 prompt 稿，落地方式（是否复用 IntroScene 的插画层机制、还是新建过场场景）待定

---

## 背景

六章战役之间，真实层同步推进一条陶与 Anna 的关系线（见 `world.md` 表格）。目前这条线只有文字设定，没有插画。本文档给每个章末节点各配一张场景插画的 AI 出图 prompt，风格延续开场插画（`intro_notebook.png`）的手绘本子插画路线——铅笔线稿 + 局部水彩、四色克制配色、横版构图、上三分之一留白给文字——但每张换一套贴合当章情绪的配色。

角色随时间线长大：Ch1 约 13～14 岁（对应德国文理中学 8 年级），Ch2 约 15 岁，Ch3 约 16 岁，Ch4 约 17 岁，Ch5 约 18 岁，终章（Ch6 后）是多年后的成年陶。陶始终是东亚男孩／男人，家在中欧（与开场插画一致，非东亚室内/器物）；Anna 是当地德国女孩，衣着随年龄自然变化，不设夸张发色或标志性配饰——她是"普通但外向"的人，不是奇幻角色卡里的 Hartmann 三人。深蓝色笔记本封面（`#2E4055`）作为贯穿六张图的视觉母题，每张都要出现至少一本笔记本。

## 目标文件

| 用途 | 目标文件（建议） | 建议尺寸 |
|---|---|---|
| Ch1 后·相识 | `client/src/assets/story/interlude_ch1_debate.png` | 长边 ≥1600px，横版 16:9 |
| Ch2 后·思想碰撞 | `client/src/assets/story/interlude_ch2_argument.png` | 同上 |
| Ch3 后·发现同好 | `client/src/assets/story/interlude_ch3_notebooks.png` | 同上 |
| Ch4 后·Anna 敞开 | `client/src/assets/story/interlude_ch4_confide.png` | 同上 |
| Ch5 后·陶动摇 | `client/src/assets/story/interlude_ch5_falter.png` | 同上 |
| 终章·尾声 | `client/src/assets/story/interlude_epilogue_desk.png` | 同上 |

出图工具、管线（AI 出图 → GIMP 精修 → `sharp` 压缩落地）同 `intro-story-art-prompts.md`。

---

## Ch1 后 · 相识（校辩论赛，正式赛制）

呼应：三个陌生人被分进同一支队。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, on the stage of a modest school auditorium set up for a formal debate competition — two small wooden lecterns facing each other across a short gap, a plain long table for an unseen moderator visible at the edge of the frame, rows of seated audience members softly blurred in the background with minimal linework so they read as background only, the audience overwhelmingly local German students and parents, fair-haired and light-skinned, in ordinary Central European casual clothes — a serious East Asian boy around thirteen years old in tidy contemporary school clothes (white shirt, dark tie) stands at one lectern, one hand raised mid-gesture as he argues a point, a few index cards held in his other hand, a small nameplate reading "Tao" resting on the front of his lectern. Facing him at the other lectern, a German girl the same age with an ordinary short bob and a simple white blouse and dark skirt leans slightly forward mid-rebuttal, her own hand extended as if countering his point, her feet planted flat and clearly visible together on the stage floor below the hem of her knee-length skirt, an engaged, unafraid expression rather than hostile, a small nameplate reading "Anna" resting on the front of her lectern. A small notebook with a deep blue cover sits closed on the floor by the boy's feet, forgotten for the moment. Warm stage light falls across both of them from above, a soft neutral shadow fills the blurred rows of audience seating behind; keep the palette to about four muted tones only — warm stage light around hex E8C989, soft neutral audience-shadow grey-green around hex 8FA396, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — the upper stage backdrop and a bare stretch of ceiling with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. The only readable text anywhere in the image is the two small nameplates, "Tao" and "Anna"; no other text, no logos, no watermark anywhere in the image.
```

## Ch2 后 · 思想碰撞

呼应：从各打各的到看见对方（陶有爱无路，Anna 有路不愿走）。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, on a low concrete step outside an ordinary Central European school building at dismissal time, a serious East Asian boy around fifteen years old in plain contemporary clothes sits with his school bag beside him, gesturing with one open hand mid-argument, his small deep blue notebook tucked half-visible under his arm. Facing him, a German girl the same age with a simple ponytail and a casual jacket stands with arms crossed, her whole upper body leaning forward toward him rather than pulling back, weight shifted onto her front foot as if she just stepped closer mid-argument, clearly arguing back rather than walking away, her expression more curious than angry. Neither is smiling, but neither looks like they want to leave. Bare autumn trees line the background, softly rendered with minimal detail. Cool overcast daylight falls evenly across the scene; keep the palette to about four muted tones only — cool overcast sky grey around hex A9B4BC, muted brick-red school wall around hex B06B54, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — the upper facade of the school building and open sky with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## Ch3 后 · 发现同好，按住不揭晓

呼应：苏远隔着场地认出 Hartmann 却没说出来。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, in a quiet corner of a school library with plain wooden shelves softly rendered in the background, a curious East Asian boy around sixteen years old in plain contemporary clothes sits at a small table, glancing sideways with a knowing half-smile at a German girl the same age sitting across from him, who is closing a notebook with a different colored cover just a moment too quickly, pressing it shut under one hand as if caught. On the boy's own side of the table sits his own small notebook with a deep blue cover, closed, one hand resting lightly on top of it in an unconsciously matching gesture. Neither notebook is open; neither of them says anything, but the boy's glance makes it clear he has noticed. Warm reading-lamp light pools on the tabletop between them, fading into the cooler shadow of the shelves further back; keep the palette to about four muted tones only — warm tabletop lamp light around hex D9A85C, soft cool library shadow around hex 6B7580, worn cream paper tone around hex F5F0E8, and a deep muted blue for the boy's notebook cover around hex 2E4055, with the girl's notebook cover in a single contrasting muted warm terracotta around hex A85C3F. The upper third of the composition stays plain and softly rendered — the upper shelves and a bare stretch of wall with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## Ch4 后 · Anna 第一次敞开

呼应：Mara 那个说不出名字的问题。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, on a plain park bench at dusk with a few bare bicycle racks softly rendered in the background, a German girl around seventeen years old in an ordinary casual jacket sits with her knees drawn up, looking down at her own hands rather than at her companion, mid-sentence, her expression open but a little tired in a way that doesn't match her usual cheerfulness. Beside her, a quiet East Asian boy the same age in plain contemporary clothes sits leaned slightly toward her, listening, not interrupting, his own small deep blue notebook resting closed on the bench between them, forgotten for the moment. Streetlights are just beginning to glow further down the path, soft and out of focus. Cool blue dusk light dominates the scene, with a single warm streetlamp glow in the distance; keep the palette to about four muted tones only — cool dusk blue-grey around hex 5A6B7A, faint warm distant streetlamp glow around hex D9A85C, worn cream paper tone around hex F5F0E8, and a deep muted blue for the notebook cover around hex 2E4055. The upper third of the composition stays plain and softly rendered — the upper tree branches and open dusk sky with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## Ch5 后 · 陶动摇，Anna 拉他一把

呼应：苏远「我们忘了一件事——我们是什么样的」。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, at a plain study desk in an ordinary bedroom with a half-visible school desk lamp and a stack of textbooks softly rendered in the background, a tired East Asian boy around eighteen years old in plain contemporary clothes sits slumped slightly forward, his own small deep blue notebook closed and pushed to the edge of the desk as if set aside, his expression distant rather than upset. Beside him, a German girl the same age in a casual jacket leans over from a chair pulled close, holding her own notebook open toward him with both hands, a single page turned so he can see it, her expression warm and a little insistent rather than pitying. Warm desk-lamp light pools over both notebooks, fading into the cooler dim of the rest of the room; keep the palette to about four muted tones only — warm desk-lamp light around hex D9A85C, dim cool room shadow around hex 4A5560, worn cream paper tone around hex F5F0E8, and a deep muted blue for the boy's notebook cover around hex 2E4055, with the girl's open notebook page rendered in the same worn cream tone with faint pencil sketch marks visible on it. The upper third of the composition stays plain and softly rendered — the upper wall and a bare shelf with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

## 终章（Ch6 后）· 尾声

呼应：陶把故事做成了游戏，弱化父亲视角（见 `world.md`「尾声」修订）。

```
A single quiet illustrated scene for a children's storybook, hand-drawn directly onto a worn notebook page with visible faint paper grain, loose wobbly pencil under-sketch construction lines left visible, light restrained watercolor wash applied in flat patches with rough uneven brush edges, no smooth digital shading, no gradients, no glossy highlights, no glow effects, kept clearly a modest hand-drawn illustration, not professional concept art, not photorealistic, not 3D render, not anime style. Wide horizontal composition. In the lower half of the frame, at a plain modest desk in a simple apartment room at night, a young East Asian man in his early twenties, dressed as an ordinary software engineer in a plain t-shirt or light sweater, sits facing a simple laptop computer, its screen glowing softly with a plain neutral light and no visible readable content. Two small notebooks lie stacked beside the keyboard — the top one with a deep blue cover worn soft at the corners, the one beneath it with a different worn muted terracotta cover just visible at the edge. His hand rests on the closed top notebook rather than on the keyboard, his expression calm and a little wistful, not sad. A plain window behind him shows a dark ordinary Central European street with a few distant lit windows, softly rendered with minimal detail. Cool blue laptop-screen glow meets warm ambient room lamplight from just outside the frame; keep the palette to about four muted tones only — cool laptop screen glow around hex 5A7A8A, warm ambient room lamplight around hex D9A85C, worn cream paper tone around hex F5F0E8, and a deep muted blue for the top notebook cover around hex 2E4055, with the second notebook's cover in the same muted terracotta around hex A85C3F used in the Ch3 illustration. The upper third of the composition stays plain and softly rendered — the upper window and a bare stretch of wall with minimal detail and no strong linework — leaving open empty space there for text to be overlaid later. No text, no logos, no watermark anywhere in the image itself.
```

---

## 落地状态

出图进度（逐章确定 prompt 与生成图，一章一章过）：

- [x] Ch1 · 相识（校辩论赛）—— prompt 定稿，生成图已确认
- [x] Ch2 · 思想碰撞 —— prompt 定稿，生成图已确认
- [x] Ch3 · 发现同好 —— prompt 定稿，生成图已确认
- [x] Ch4 · Anna 第一次敞开 —— prompt 定稿，生成图已确认
- [x] Ch5 · 陶动摇 —— prompt 定稿，生成图已确认
- [x] 终章 · 尾声 —— prompt 定稿，生成图已确认

六张图已处理落地（2026-08-05）：resize 长边封顶 1600px（原尺寸已小于此值的不放大）、16 色调色板 + dither 压缩（同 `intro_notebook.png` 的压缩配方），存至：

- `client/src/assets/story/interlude_ch1_debate.png`（349KB）
- `client/src/assets/story/interlude_ch2_argument.png`（421KB）
- `client/src/assets/story/interlude_ch3_notebooks.png`（279KB）
- `client/src/assets/story/interlude_ch4_confide.png`（263KB）
- `client/src/assets/story/interlude_ch5_falter.png`（275KB）
- `client/src/assets/story/interlude_epilogue_desk.png`（276KB）

文案定稿（2026-08-05）：六段真实层正文见 `world.md`「章末真实层：陶与 Anna」（Ch1～Ch5 各 4 行 + 尾声改稿 8 行，与开场 `story.line.1`~`.7` 首尾呼应）。落地方式拍板：新建可复用插画过场组件（抽取 `IntroScene` 的插画淡入 + 逐行文字 + 点按推进机制），而非在 `ResultScene` 里加插画。

代码接线已完成（2026-08-05），详见 `CAMPAIGN_STORY.md`「章末真实层插画落地」：

- [x] 接 i18n：zh/en/de 全补齐，`campaign.realLayer.ch1`~`.ch5`（`client/src/i18n/locales/{zh,en,de}.ts`），`campaign.epilogue` 改稿为终章文案
- [x] 新建 `IllustratedInterludeScene`（`client/src/scenes/IllustratedInterludeScene.ts`）——抽取 `IntroScene` 的淡入 + 逐行文字 + 点按推进/自动前进/跳过机制，插画满屏常驻（非 0.6 透明度背景），文字逐条替换显示在插画预留的上三分之一空白带
- [x] `LevelDefinition.story` 加 `realLayerKey?: TranslationKey`（`server/engine/src/campaign/LevelDefinition.ts` + `levelSchema.ts` 解析），移除原先只给 ch6 用的 `epilogueKey`
- [x] `chN_lv10.json`（N=1~6）全部加 `story.realLayerKey`；`ch6_lv10.json` 的值沿用既有 `campaign.epilogue`
- [x] 挂到结算流程（`client/src/app/nav/game.ts`）：胜利且该关有 `realLayerKey` 时，`ResultScene` 结算面板之后、返回地图之前插入这一屏；六张插画的资源映射见 `client/src/scenes/realLayerInterludeArt.ts`
- [x] `tsc --noEmit`（client + server/engine）+ 全量 `vitest run`（995 测试）通过
- 已知限制：本机没有可用后端（metaserver 等），E2E dev server（`game-e2e`，见 `.claude/launch.json`）里 `/bootstrap` 请求失败导致画布卡在 0×0，没能截图肉眼核对；已通过控制台直调 `views.showRealLayerInterlude(...)`（走 `window.__nwE2E`）确认调用链不报错、静态图片路径可达。真正的视觉核对留到有可用后端环境时补做
- [x] 测试补全（2026-08-05）：新建 `resolveRealLayerInterlude` 纯函数（`client/src/scenes/realLayerInterludeArt.ts`，从 `game.ts` 抽出胜负/`realLayerKey`/章节→插画的判断逻辑，方便脱离真实对局单测）+ 单测 `client/test/realLayerInterlude.test.ts`；`IllustratedInterludeScene` 专项行为测试 `client/test/ui/illustratedInterludeScene.ui.ts`（分行显示、淡入/点按补全/自动前进/跳过/防重复触发/插画满屏淡入）+ 加入 `scenes.ui.ts` 的启动 smoke 列表；`levelSchema.test.ts` 补 `realLayerKey` 解析 + 六个 `chN_lv10` 关卡赋值校验；新增 `client/test/campaign-real-layer-interlude-nav.test.ts`——用真实对局（`ch1_lv1` 胜率高，临时借用其 story 块拼一个 `realLayerKey` 再还原）跑通「结算面板 → 插画过场 → 回地图」这条真实导航链路，而不只是纯函数层面。全量 `vitest run` 1007 测试 + UI 套件 1116 测试通过
