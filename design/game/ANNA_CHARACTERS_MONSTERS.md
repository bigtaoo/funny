# Anna 阵营 — 三只怪物 + 关系与设计注记

> 从 [`ANNA_CHARACTERS.md`](ANNA_CHARACTERS.md) 拆出（2026-08-17，原文件 559 行）。**小节编号沿用原文**，`ANNA_CHARACTERS.md §N` 引用照旧有效。
> 本册内容：Aello / Björn / Lerna，以及三角色关系弧与设计注记。总览与在先小节见 [`ANNA_CHARACTERS.md`](ANNA_CHARACTERS.md)。

---

## Anna 阵营的三只怪物——Aello / Björn / Lerna

> 归属拍板见 [`CHARACTER_DESIGN.md` §7](CHARACTER_DESIGN.md#7-六个-pve-复用兵种的阵营归属讨论中2026-07-02)：鬼鸟 Harpy / 狂战士 Berserker / 裂变兵 Splitter 三个 PvE 复用单位划给 Anna 的笔记本。它们**不是** Hartmann 家族试炼学员——Max/Lena/Mara 三人是「参选的孩子」，这三个是 Anna 在笔记本别处画的**怪物与游荡者**，跟方家的穷奇/獬豸/随军医官一样，是主角阵容之外的"世界background 角色"。
>
> **叙事归属与 PvE 波次配置互不干涉**（见 §7.1 关键澄清）：即使涛在 Ch3/Ch4 把它们当敌人打，它们仍然是 Anna 本子里画出来的东西——这正好印证「两家相遇」时涛撞见了对方笔记本里的怪物。
>
> 状态：Aello / Björn / Lerna **均已出图定稿**（2026-07-02，见下方最终 prompt）。机制数值锚点见 `server/engine/src/config.ts`（Harpy/Berserker/Splitter 三个 blueprint）与 [`PVP_LOADOUT_DESIGN.md`](PVP_LOADOUT_DESIGN.md) §5 费用定标。

### Aello ——「鬼鸟」（Harpy）

> **澄清（2026-07-07）**：本条 **Aello（鹰翼女妖，HP 22 / 速 2.2）** 与 `MYTHOLOGY_DESIGN.md` §4.2 的 **PvP 折纸纸飞机飞行卡「哈耳庇厄 Harpy」（HP 45 / 速 1.4）** 是**两个不同实体**，形象/数值均不同，两者仅共用「哈耳庇厄／Harpy」这一神话名，无需对齐数值。

**兵种**：飞行骚扰（PvE 敌方 / PvP 高费解锁牌）

#### 神话来源

哈耳庇厄（Harpy）在希腊神话里不是无名怪物——赫西俄德给她们三姐妹起了名字：**Aello**（风暴）、Ocypete（疾风）、Celaeno（幽暗）。她们是宙斯的差使，专司追杀违逆神谕的人，速度快到人类的马都追不上。取 **Aello** 这一个名字，扣住她 `speed 2.2`（全场最快）、飞行绕后的机制身份——她是「风暴」，不是「怪鸟」。

#### 背景故事

Aello 曾经是奥林匹斯的差使，任务是追猎宙斯点名的逃亡者——直到某一次，她追到的人只是个逃出家门的孩子。她没有下手，转身飞走，从此被逐出神谕序列，成了自己猎场之外的游荡者。

Anna 画她时没有给她一个"归宿"：她不站队，不驻防，只在战场边缘游荡，专挑防线上没设箭塔的空隙钻进去——这正是她的机制来源：**飞行**（地面近战摸不到她，只有箭塔/弓手能咬住），出场即高费，因为"无解"本身就要标好价格。

她话很少，因为她已经不属于任何一边的语言了。

**一句话台词**：「我不追你了，但我也不会停下来。」

#### 性格特征

- 疏离，不解释自己的行动逻辑——她自己也未必想清楚了那次为什么手软
- 对"被追猎的人"有一种说不出口的恻隐，但绝不会承认这是心软
- 快，永远在动，停下来对她而言等同于被重新编进某个序列
- 隐藏特征：她记得每一张自己曾经放过的脸，这是她唯一还留着的"神谕档案"

#### 视觉设计方案

**整体气质**：不是少年，是脱序的成年女性猛禽混血——冷、锐、不属于任何阵营的孤高感。铅笔线条比 Max/Lena/Mara 更潦草迅疾，呼应她的速度和游离状态。

**外形描述**：
- 人形上半身 + 巨大鹰翼后展（翼展远超肩宽，收拢时贴背，飞行时半张）
- 下肢为鹰爪化的腿部，站立时脚跟离地，随时能起飞的姿态
- 面部：锐利的成年女性五官，眼神冷淡疏远，不与观者对视（望向侧后方）
- 发型：短发或束起，被风向后扬起的动态感

**标志性元素**：
- 羽毛：翼尖到肩部渐变的深浅蓝灰羽毛，笔触快而利，像被风吹过的线条
- 姿态：微前倾滑翔式，不站得端正——她永远像下一秒就要离开
- 无武器：她的攻击是鹰爪本身，不持任何道具

**颜色方案**（Anna 方蓝色系，Aello 取风暴灰蓝——三人里最冷最暗）：
- 主色：风暴灰蓝 `#5A6B7A`（羽翼主色）
- 高光：冷白 `#C9D2D9`（羽尖、爪部反光）
- 阴影：暗蓝黑 `#2B333B`（翼下阴影、羽根）
- 线稿：铅笔灰（比 Max/Lena/Mara 更粗更急促的线条，表现速度感）
- 水彩晕：淡灰蓝 `#9FAFBC`（皮肤/羽毛过渡区）

#### AI 图生成 Prompt

**最终定稿 Prompt（GPT Image 2，2026-07-02 出图采用）**

用于全身立绘（角色卡用途）。模型对朝向有强烈"朝左偏好"，文字硬掰命中率低——生成后人工水平镜像翻转成朝右即可，不必为方向反复出图（同 Max/Lena/Mara 做法）。

```
An amateur doodle sketch by a bored talented teenager in the margin of a school notebook — NOT a finished illustration, NOT gallery-quality art, deliberately unpolished with shaky uneven linework and patchy incomplete watercolor that doesn't fully fill the shapes, applied consistently across the ENTIRE figure including the face and torso, not just the wings or legs — nowhere on the body should look more finished or smoothly rendered than anywhere else. Full-length side-profile illustration of a lean adult harpy woman on a plain white notebook page background, crouched in a restless, unsteady half-bent-knee stance with weight shifted forward as if mid-stride or about to leap into flight, not a posed or balanced figure. She has a humanoid torso with sharp, aloof, cold adult female facial features rendered with the same loose sketchy pencil linework and thin patchy watercolor as the rest of her body — no smooth shading on the face or skin, leave some construction lines visible and uncolored there too. Short dark windswept hair blown backward in wild uneven strands, gaze looking off to the side rather than at the viewer. Large feathered wings spread half-open behind her, feather color fading from storm grey-blue (hex 5A6B7A) at the base to pale cold white (hex C9D2D9) at the tips, with deep blue-black (hex 2B333B) shadows underneath — deliberately leave some outer wingtip feathers as bare uncolored pencil outlines, not fully painted in, and let the watercolor washes spill messily outside the linework in places. Keep the whole palette monochrome cool grey-blue, cold white and blue-black only — no warm tan, beige, or skin-tone colors anywhere, including the legs. Bird-like taloned legs replacing human feet, scaled in the same muted cool grey-blue tone as the rest of her, with visible loose cross-hatching pencil strokes on the leg surface. She wears no clothing beyond a simple wrapped chest binding, no armor, no weapons, no props — her only weapon is her own talons. Background is plain clean white paper with faint paper texture, no vignette, no gradient background, no text, no watermark, hand-drawn children's storybook notebook aesthetic, western Greek mythology inspiration (the harpy Aello), gentle picture-book tone, not dark or horror-themed, no blood, no glowing effects, no photorealism, no 3D render, no anime style.
```

已知小瑕疵（判定可接受，缩放到卡面/战场尺寸不可见）：耳朵偏尖非设定要求；侧脸为闭眼而非"冷淡望向侧后方"。

**Prompt 2 — 俯冲瞬间（技能卡用途，未按新版规范重出，沿用早期方向）**
```
harpy woman diving low over a battlefield edge, wings swept back for speed, talons extended forward, motion blur pencil lines trailing off the wingtips, notebook sketch style, storm grey-blue and cold white watercolor palette, dynamic diagonal composition, white vignette background, pencil and watercolor illustration, greek mythology, hand-drawn children's book style
```
*Negative prompt*:
```
photorealistic, 3D, anime, blood, gore, dark atmosphere, glowing magic effects, text, watermark
```

---

### Björn ——「狂战士」（Berserker）

**兵种**：残血爆发（PvE 敌方 / PvP 中费解锁牌）

#### 神话来源

"berserker"一词本身就是北欧神话词源——披熊皮（ber-serkr）而战、陷入战狂状态、感觉不到疼痛的战士。这不是怪物，是**人**，是北欧传说里一种真实存在过的战士流派。取名 **Björn**（古诺尔斯语"熊"），直接对应词源本身，不绕弯子。

#### 背景故事

Björn 不是 Hartmann 家族的孩子，他是 Anna 在笔记本边缘画的一个更古老的人——一个信仓「痛感不是停下来的理由」的北境战士。他年轻时输过一场决定性的战斗，输在自己还没伤到浑身是血就先撤了。从那之后，他给自己定了一条规矩：**打到最后一口气之前不准退。**

这正是他的机制来源：**残血狂暴**（HP 低于 40% 时攻速 ×1.5）——他不是越打越弱，是越接近极限，动作越快、越不管不顾。对面如果不能在他跌破血线前解决他，接下来的每一秒都会更难。

Anna 喜欢画他的理由很直接：他和 Max 是两种"不需要别人"的镜像——Max 的不需要是天赋带来的骄傲，Björn 的不需要是九死一生里学出来的规矩。

**一句话台词**：「痛，说明我还没输。」

#### 性格特征

- 沉默，不是话少那种沉默，是把所有情绪都调度成战斗动作的沉默
- 对"退"这个字有近乎生理性的排斥，哪怕理智告诉他该退
- 不庆祝胜利，只在乎自己有没有撑到最后——这让他显得冷漠，其实是他没有多余的力气分给别的情绪
- 隐藏特征：他会在战后独自检查伤口，那是他唯一允许自己安静下来的时刻

#### 视觉设计方案

**整体气质**：成年北境战士，体格远比 Max/Lena/Mara 三人厚重，粗犷、原始，铅笔线条比其他三人更粗重狂野，水彩带一点血色暖调（不是伤口，是他本身的"热"）。

**外形描述**：
- 皮革护甲外披一整张熊皮（兽头搭在肩后，兽爪垂在胸前），不穿板甲——他信奉的是灵活和痛觉，不是防护
- 体型：宽肩厚背，手臂线条粗壮，比 Max 高一头，但姿态比骑士更粗野松散
- 面部：络腮短须，眼神狂热但不失焦，眉骨压得很低
- 武器：双手巨斧或宽刃战斧，握姿低沉随时能挥出全力一击

**标志性元素**：
- 熊皮：肩部到背部的整张熊皮兽头，是他"berserker"身份最直白的标志
- 姿态：微弓身前倾，如猛兽蓄力，重心极低
- 细节：手臂上有旧战斗留下的浅疤痕（水彩淡淡带过，不做血腥特写）

**颜色方案**（Anna 方蓝色系，Björn 取铁蓝 + 熊皮暖棕——冷底暖裘）：
- 主色：铁蓝灰 `#4E5C6E`（皮革护甲）
- 辅色：熊皮暖棕 `#6B4A32`（兽皮、须发）
- 高光：浅灰白 `#C7CDD2`（斧刃反光、护甲边缘）
- 阴影：深铁蓝 `#293440`（护甲凹处、熊皮暗部）
- 水彩暖调点缀：`#8C4B3C`（体表运动时的血色红晕，非伤口）

#### AI 图生成 Prompt

**最终定稿 Prompt（2026-07-02 出图采用，单段肯定句，不分正负段）**

生成朝左，人工水平镜像翻转成朝右，做法同 Max/Lena/Mara/Aello。定稿前反复调过三处，记录在案避免以后重踩：① "crouched ready stance / 蓄力低伏"这类抽象姿态词连续两次把模型带偏（一次变行走、一次变解剖混乱的别扭蹲姿），改成宽松写法「自然行走、剪影清晰」后才稳定，遂放弃硬掰这处细节；② 熊爪必须明确写"是斗篷的一部分、贴胸垂下、不外伸"，否则容易被画成从人物背后伸出的第四条肢体；③ 出图工具一度把"notebook sketch"字面理解成"拍一张摊开笔记本的实拍照片"（带装订线/格子内页/木桌），需在 prompt 里显式排除，否则产出无法直接抠图接入管线。

```
An amateur doodle sketch by a bored talented teenager in the margin of a school notebook — NOT a finished illustration, NOT gallery-quality art, deliberately unpolished with shaky uneven pencil linework left visible everywhere, and patchy incomplete watercolor that leaves areas of white paper showing through unfilled, applied consistently across the ENTIRE figure including the face, beard, bearskin fur, and axe head — nowhere on the body should look more finished or fully colored than anywhere else. The character must be isolated alone on a plain clean white background with only a faint paper texture — NOT a photograph of an open notebook, no visible spiral binding, no ruled notebook lines, no desk or table surface, no perspective photo framing, just the character floating on flat white paper same as a character reference sheet. Full-length side-profile illustration of a hulking, imposing adult norse warrior, extremely broad and heavyset with a thick neck, wide trapezius, and bulky forearms — far bulkier and more physically intimidating than an ordinary man, built like a heavyweight brawler, not lean or slender anywhere on his frame. He strides forward with a heavy, purposeful, ground-eating gait, shoulders squared, chin low, glaring intensely ahead with a hard clenched jaw — a warrior who looks dangerous even just walking. He grips a large plain two-handed battle axe low in one thick fist, held with visible weight and confidence, blade forward and low, in a simple readable pose with clear silhouette and ordinary human anatomy. A full bearskin cloak is draped heavily over his shoulders and down his back, adding to his bulk, the bear's head resting right against his own head near his shoulder, and directly below it, resting flat against the front of his chest and upper arm, one bear forepaw drapes down with its claws clearly visible against his tunic — a single paw lying naturally against his chest, not reaching outward, unambiguously part of the cloak rather than a separate limb. The rest of the bearskin is rendered as a dense, heavy, loose scribbly zigzag mass of pencil marks, not individually drawn hairs, giving it real visual weight and volume. Short grizzled beard and windswept hair drawn with loose scratchy linework, low furrowed brow, intense hard-set gaze, no smooth shading on the face or skin, some construction lines left visible and uncolored around the jaw and hairline. Palette stays in cool iron blue-grey (hex 4E5C6E) for the tunic and leg wraps and warm brown (hex 6B4A32) for the bearskin, but pigment should be applied with a bit more saturation and confidence than a pale faint wash — bold enough patches to read as a strong, weighty figure, not a washed-out or delicate one, still with visible unpainted white gaps and no gradients or blending. A couple of loose pale grey patches highlight the axe blade. Hand-drawn children's storybook notebook aesthetic, norse mythology inspiration, gentle picture-book tone, not dark or horror-themed, no blood, no gore, no glowing effects, no ornate armor, no rune engravings, no tattoos, no photorealism, no 3D render, no anime style, no professional concept art finish, no dense cross-hatching, no dramatic cinematic lighting.
```

**Prompt 2 — 狂暴瞬间（技能卡用途，未按新版规范重出，沿用早期方向）**
```
norse warrior mid-swing with a two-handed axe, bearskin cloak flaring with the motion, intense focused expression, motion lines around the axe head, notebook sketch style, iron blue-grey and warm brown watercolor palette, dynamic low diagonal composition, white vignette background, pencil and watercolor illustration, norse mythology, hand-drawn children's book style
```
*Negative prompt*:
```
photorealistic, 3D, anime, blood spray, gore, dark atmosphere, glowing effects, text, watermark
```

---

### Lerna ——「裂变兵」（Splitter）

**兵种**：死亡分裂怪物（PvE 敌方 / PvP 中费解锁牌）

#### 神话来源

死亡后分裂增殖的机制灵感来自**勒耳纳的九头蛇（Lernaean Hydra）**——砍下一头会长出两头，这是希腊神话里最直白的"越杀越多"。名字直接取自她的栖息地 **Lerna**（勒耳纳沼泽）。**但外形不再复刻九头蛇的多头蛇身**（首版蛇形方案出图后反复测试，观感始终偏向"可爱的迷你尼斯湖水怪"，和"冷感现象"的设定意图相反）——机制上的九头蛇引用保留，视觉上完全改画成一团无固定形态的沼泽胶质软体，不做任何蛇/爬行类的细长身形。

#### 背景故事

Lerna 不是人，Anna 从一开始就没打算把她画成人形——她是笔记本沼泽页角落里的一团东西，安静的时候看起来只是一片贴着水面的胶状污渍。没人知道她"本体"有多大，因为她从来没有以完整的样子出现过：每次被打倒，留下的不是尸体，是一小团更小、更快的东西从原地脱落出来，头也不回地继续往前冲。

这正是她的机制来源：**死亡分裂**——倒下即成两只 Runner 冲出。对付她最蠢的办法就是一次次单点消灭，因为每一次"解决掉"都只是让她换了个更麻烦的形态；真正的答案是范围伤害，一次性把她和她分裂出来的东西一起清场。

Anna 没有给她台词，因为 Lerna 从未展现过能说话的部分。她画她的方式更像画一种天气，而不是画一个角色。

#### 性格特征

- 没有可辨识的"性格"——这是 Anna 刻意的设计：她是现象，不是人物
- 对她而言"死亡"这个概念不成立，倒下只是换一种存在方式继续前进
- 唯一近似"意图"的东西是持续不断地扩散、繁殖、逼近，没有目的地，只有方向

#### 视觉设计方案

**整体气质**：**非人形、非生物轮廓**——刻意不套 Max/Lena/Mara 的少年骨架模板，也不做任何蛇形/爬行类/四足兽的身形（首版蛇身簇方案已废弃，见上「神话来源」）。画成一整片低伏摊开的沼泽胶质水洼，安静时几乎融进水面，唯一的"生命迹象"是表面凸起的几个眼点。

**外形描述**：
- 主体是一整片不规则轮廓的半透明胶质水洼，贴着水面摊开，没有明确的"躯干"或"个体"边界——强调"这不是一个个体，是一团现象"
- 表面凸起三到五个大小不一、高低不一的圆润凸起，凸起与水洼主体连续过渡，**不做独立的脖子/领口/兜帽轮廓**，避免读成"多个头顶在脖子上"
- 每个凸起上只有一个空洞的圆点眼，没有嘴或只留极淡的一道痕迹，不做任何拟人表情
- 体表：深浅不一的冷蓝绿胶质纹理，铅笔画松散不均的波浪线暗示胶体内部，零星分布几处扁平留白气泡（不做玻璃高光/渐变光泽），水彩打底大面积不完全填色
- 没有四肢、没有站姿——整体贴地摊开，边缘随时在往外滴落

**标志性元素**：
- 分裂暗示：紧挨主体但已完全脱离的一小团独立胶质，颜色更浅更透明，体积明显更小，是"已经分裂出来的下一只"，而不是还连在主体上的部分
- 眼睛：所有凸起的眼睛都是同一种空洞的圆点，没有情绪、没有焦点方向
- 边缘：水洼轮廓极不规则，边缘有滴落的胶质水珠，周围散落几圈潦草的水纹和沼泽草丛线稿

**颜色方案**（Anna 方蓝色系，Lerna 取深蓝绿——三人里最冷最陌生）：
- 主色：深蓝绿 `#3C5A54`（胶质主调）
- 辅色：沼泽暗绿 `#4A5C3E`（凸起间过渡阴影）
- 高光：苍白青 `#A8C4B8`（扁平留白气泡/胶质透光处）
- 阴影：近黑蓝绿 `#1F2E2A`（凸起真正重叠处的暗部，克制使用）
- 已分裂的独立胶质团：浅蓝绿 `#7FA396`（体积更小、颜色更浅，暗示新生）

#### AI 图生成 Prompt

**最终定稿 Prompt（2026-07-02 出图采用，角色卡用途）**
```
An amateur doodle sketch by a bored talented teenager scribbled in the margin of a school notebook — NOT a finished illustration, NOT gallery-quality art, NOT a professional watercolor painting, deliberately unpolished with shaky uneven pencil linework, inconsistent line weight, and patchy incomplete watercolor that does NOT fully fill the shapes, applied consistently across the ENTIRE creature so that nowhere on it looks more finished, smooth, or carefully rendered than anywhere else, and the image contains ONLY the creature and its swamp setting — absolutely no handwriting, no captions, no bio notes, no labels, no artist signature, no social media handle, no decorative symbols or doodles in the corners, nothing outside the drawing itself. It is an illustration of a single amorphous puddle of translucent gelatinous ooze spreading low and flat across a patch of swamp water, with NO elongated necks, NO tapering serpent-like bodies, and NO snake silhouette anywhere — the mass has an irregular, blobby, uneven outline like a spilled puddle of thick jelly, with three to five soft rounded lumps or blisters bulging up unevenly and asymmetrically from the surface of the puddle at different heights and sizes, merging smoothly and continuously into the main puddle body with NO distinct collar, hood, or neckline shadow separating any lump from the mass beneath it — the transition from lump to puddle should read as one unbroken continuous surface, not as separate heads sitting on individual necks or collars. Each lump has a single flat round dot eye pressed into its jelly surface, showing no expression and no focus direction, with no mouth at all — no face-like features that could read as an individual head, a hood, or a friendly/cute character. The mass sits low and wide rather than tall, spreading outward more than it rises upward, with a soft uneven wobbling silhouette like something semi-liquid settling under its own weight. A little apart from the main puddle, a small separate blob of ooze has already fully split off, thinner, paler, and more washed-out than the rest, resting on its own nearby in the water as a second, smaller, newly-formed body — this second blob is the clearest sign of the splitting mechanic, distinct from the main mass rather than still attached to it. The rendering uses flat matte watercolor washes only, uneven and patchy, with visible dry-brush gaps, some areas left almost entirely uncolored pencil-only, and rough edges spilling outside the linework; to suggest gelatinous translucency there are a few sparse, irregularly sized and irregularly spaced flat pale patches embedded within the mass like uneven bubbles trapped in jelly — deliberately not evenly distributed, some clustered, some areas with none at all — kept flat and matte with no glossy highlight dot, no reflective rim light, and no 3D-sphere shading, just a flat lighter-toned wash outline, plus loose wavy pencil contour lines through the body suggesting a soft jelly interior, thin drips of clear ooze hanging unevenly off the lower edges of the puddle, and absolutely no glossy highlights, directional light sheen, gradient shading, or smooth reflective/wet-glass rendering anywhere. The color palette is deep teal-green translucent jelly tones around hex 3C5A54, swamp dark green transitional patches around hex 4A5C3E, pale cyan-green flat highlight/translucent patches around hex A8C4B8, near-black teal-green flat shadow patches used sparingly only where lumps genuinely overlap each other around hex 1F2E2A, and the separated smaller blob in pale blue-green around hex 7FA396, with loose scribbly pencil reeds and grass plus a rough scribbled watery patch beneath and around the mass carrying the same unfinished sketchy energy as the creature itself. The background is plain clean white notebook paper with faint paper texture, no vignette, no gradient background, and no text of any kind anywhere in the image, an unknown swamp ooze creature with gentle picture-book linework but an unsettling low creeping puddle-like composition, keeping it clearly a talented teenager's unpolished notebook doodle with no smooth digital shading, no glossy or wet-look rendering, no glass/crystal bubble rendering, no anime style, and no 3D render.
```
*Negative prompt*:
```
photorealistic, 3D render, anime, horror, blood, gore, humanoid, limbs, fangs, snake, serpent, elongated neck, tapering body, tall raised necks, hood, collar, individual heads on necks, separate head silhouette, loch ness monster silhouette, smiling face, happy expression, cute face, evenly spaced bubbles, uniform polka dots, glossy highlights, wet reflective sheen, gradient shading, glass beads, crystal spheres, smooth rendering, professional illustration, polished watercolor, handwriting, text, caption, label, signature, watermark, social media handle, logo, decorative symbols, pentagram, stars, doodles in margins
```

---

## 三角色关系与叙事弧

### 三人的动态关系

Anna 的三个角色在她的笔记本世界观里是同一支骑士队伍，但彼此之间的关系并不顺畅：

- **Max** 认为个人实力决定一切，对"配合"这个词有一种本能抵触
- **Lena** 认为配合是数学题——每个人发挥数学上最优的位置，结果自然最好；但她不擅长把这个解释给别人
- **Mara** 是三人里最能看清全局的，但她的视野很难被另外两人相信——Max 觉得"只是感觉"，Lena 觉得"没有数据支撑"

**叙事弧核心**：他们在战场上一次次失败，然后一次次以不同的理由重组。他们最后赢得的那场战斗，是 Max 第一次等了 Mara 标记之后再出手，Lena 第一次离开了最优防守位去保护 Mara 的侧翼。谁也没说话。

### 与方家角色的深层对比

这不只是"东方 vs 西方"的配色差异，而是两种关于"胜利"的假设的碰撞：

- **方家**的配合是默契——信任先于语言，陈守不需要解释他为什么往那个位置站
- **Hartmann** 的配合是学来的——最初每个人都有自己的逻辑，配合是克服自己逻辑的结果

当两本笔记本相遇，这两种配合方式会在同一个战场上碰撞。这正是游戏想要呈现的东西。

---

## 设计注记

### 关于"Anna 只画西方"

三个角色的视觉参考全部在西欧中世纪 + 北欧传说的语境里，不混搭东方元素。这是角色设定的硬约束：Anna 的世界观是她从欧洲历史和格林童话里建立起来的，她不画东方的东西——就像涛不画西方骑士一样。两本笔记本的风格差异就是这个设定的体现。

### 关于蓝色方案

三个角色都属于 Anna 方（蓝色系），但色调各有侧重：
- Max：冷钢蓝灰（最冷，最无情）
- Lena：深钴蓝 + 青铜暖绿（理性，有温度但克制）
- Mara：暖棕 + 天蓝点缀（最暖，最接近普通人）

这个色温梯度对应三人性格的暖度，也方便玩家快速识别"这三个是一队但各不相同"。

### 关于 AI Prompt 使用说明

- 推荐优先使用 **Midjourney v6** 或 **DALL-E 3**（对 children's book 风格支持好）
- 生成后需要检查：线稿是否有铅笔质感、是否保留了手绘边缘、颜色是否偏蓝系
- 若生成结果太精致（接近专业插画），可以在 prompt 中加强：`rough pencil sketch, amateur teenage artist style, slightly wobbly lines`
- Stable Diffusion 推荐模型：`dreamshaper` 或 `ghostmix`，配合 `pencil sketch` LoRA

#### 实操要点（2026-06-25 出图经验）

- **朝向**：立绘必须**朝右**（己方单位面朝右约定 + animator 骨骼 `rwa` 朝右设定，见 `design/product/art-direction.md` §朝向约定）。但图像模型有强烈"朝左偏好"，文字硬掰命中率低——**生成后水平镜像翻转即可**，无损，不必为方向烧次数。
- **划痕等手绘细节别交给 AI**：Max 的对角铅笔划痕反复被模型画成半空中的乱涂。结论：**从生成 prompt 删掉，定稿后手绘补一条线**。
- **否定句不可靠**：本项目所用工具对 `negative prompt` / `no xxx` 支持弱，**全部要素改写成肯定句**，单段输入（不分正/负两段）。

### 关于两本笔记本的画风差异（"度"的把控 · 2026-06-25 拍板）

Tao 阵营现有立绘是**单色圆珠笔/钢笔的火柴人涂鸦**，Anna 阵营（Max 定稿）是**铅笔线 + 水彩淡彩的写实少年**。拍板结论：**画风差异保留**——两个主角、一东一西、一男一女、一糙一工，差异本身合理（对应 Tao 随性 / Anna 精算的人设），**不硬拉统一**。但必须"控制好度"，靠下面三条共同地基锚住同属一本游戏的观感。

**共同地基（两侧都必须满足，任何一侧不得破）**：

1. **同纸张同构图**：纯白笔记本纸 + 极淡纸纹，角色居中、留白一致，不加背景。
2. **手绘会抖的线**：保留可见手绘线、轻微歪斜；**绝不**出现矢量般干净描边或 3D 渲染。
3. **文具媒介、禁数码渲染**：无气泡高光、无平滑渐变、无写实金属反光；上色只能是看得见笔触边缘的**平涂水彩/马克笔**，不是打光。

**允许的差异**：

| | Tao（涛·东方男孩） | Anna（西方女孩） |
|---|---|---|
| 笔 | 单色圆珠笔/钢笔涂鸦 | 铅笔线 + 克制水彩淡彩 |
| 造型 | 火柴人、大圆头两点眼、随性 | 真实少年比例、五官完整、更工整 |
| 气质 | 原始、冲、随手 | 一丝不苟、算过的工整感 |

**"度"的上限 —— Anna 侧 prompt 固定加这句"压顶句"**（防止滑向专业概念图）：

```
keep it clearly a talented teenager's notebook drawing not professional concept art, visible wobbly pencil construction lines, flat watercolor washes with rough brush edges, simple un-rendered faceted shapes, no smooth digital shading no realistic metallic reflections
```

> Max 定稿那张的金属渲染/脸已踩上限边缘，Lena、Mara 出图时往回收一档：盔甲/护具靠铅笔线区分块面、平涂淡彩，别渲染反光；五官保持少年手笔的简单。
