# Anna 方三角色设计文档

> 版本 v1.2 · 2026-07-02（新增 Aello/Björn/Lerna 三只怪物，命名+背景+视觉定稿）  
> 对应引擎定义见 `design/game/CHARACTER_DESIGN.md`；叙事铁律见 `design/product/characters.md`；美术规范见 `design/product/art-direction.md`

> **出图进度**（截至 2026-06-27，三角色全部定稿并接入游戏 ✅）：
> - **Max** 全身立绘已定稿（朝右 / 全身 / 面罩上翻露脸 / 冷钢蓝水彩）。
> - **Lena** 全身立绘已定稿（朝右 / 壮实低重心坦克体型 / 链甲+皮革+护腿步兵甲 / 深钴蓝几何打格圆盾 / 战辫无盔 / 短剑插腰）。
> - **Mara** 全身立绘已定稿（朝右 / 纤细高挑最轻盈 / 皮革无甲+单肩箭筒 / 长弓箭未满 / 腕缠蓝绳 / 松散波浪发 / 眼神望远）。三人完成度有意拉开层次：Max 凌厉、Lena 厚实、Mara 最轻最透（铅笔线最细、水彩最透）。
> - **Aello（鬼鸟 Harpy）** 全身立绘已定稿（2026-07-02，朝右 / 冷灰蓝单色调水彩 / 缠胸布无甲无武器 / 鹰爪化双腿 / 屈膝半游荡姿态）。生成朝左，人工水平镜像翻转成朝右，做法同 Max/Lena/Mara。已知小瑕疵接受不改：耳朵偏尖（非设定要求）、侧脸为闭眼而非设计稿要求的"冷淡望向侧后方"——缩放到卡面/战场尺寸后不可见，判定可用。
>
> **游戏接入状态**（2026-06-27 ✅）：
> - `.png` 立绘 + `.tao` 骨骼动画已放入 `client/src/assets/`，战场动画路径（`UnitView.ts STICKMAN_ASSETS`）早已接好。
> - `cardArt.ts CARD_ART_URLS` 补入三人（`unit_max/unit_lena/unit_mara`）——手牌立绘正常显示。
> - `CollectionScene.ts UNIT_NAME_KEY` 补入三人名称翻译映射——大厅养成页名称正常显示。
> - 翻译 key（`card.max/lena/mara.name/desc`）zh/en/de 均已存在，无需新增。
>
> **出图工具首选**：**ChatGPT（GPT-4o / DALL·E 3 出图）**——本项目"单段长自然语言 prompt、不分正负段、storybook 水彩"的需求由它支持最好，三角色定稿均出自 ChatGPT（Max/Lena/Mara）。免费备用：**Bing Image Creator**（同引擎）、**Mistral Le Chat**（FLUX，默认偏卡通，需 prompt 拉回写实）。Leonardo 免费档是每日刷新 token、单次生成贵模型/高清会一次吃上百 token，不是"低于 100 被锁"。⚠️ 上线前需核对所选工具的**商用授权**。

---

## 世界观定位

Anna Hartmann 是来自德国富裕家庭的少女。她的笔记本是她的欧洲——格林童话的骑士、中世纪铁匠城市、北欧神话的坚韧，还有她自己对"什么叫强大"的理解。她笔下的角色有荣耀感，有逻辑感，有一种"我已经算过了"的冷静。

陶的笔记本画的是中国历史军事语境里的人：步兵靠冲劲，弓手靠沉静，盾兵靠信任。Anna 的笔记本画的是欧洲骑士传奇语境里的战士：每一个人都曾相信靠自己就能赢，每一个人都在战场上学会了为什么不行。

两本笔记本相遇时，这种碰撞就是游戏的核心张力。

### 对位逻辑总表

| 方家（陶的笔记本） | Hartmann（Anna 的笔记本） | 对位核心 |
|---|---|---|
| **李川**——势如破竹，靠冲劲赢 | **Max**——精准爆发，靠决断力赢 | 同样是剑士，一个用气势压人，一个用一击定胜负 |
| **陈守**——沉默守护，靠信任蔽护 | **Lena**——纪律减伤，靠计算守护 | 同样是盾卫，一个靠身体，一个靠数学 |
| **苏远**——沉默观察，个人高爆发 | **Mara**——宏观战场，标记全队增伤 | 同样是弓手，一个靠独力，一个靠织网 |

---

## Max ——「独行骑士」

### 背景故事

Max 是 Anna 笔记本里来自格林童话原型的骑士少年——不是长子的荣耀，也不是次子的计谋，而是那个相信"只要自己够强就能赢得一切"的第三个孩子。

在 Anna 构建的幻想世界里，Max 是骑士学校的第一名。不是因为他努力，是因为他天生就快半拍——他在别人还在想的时候已经出手了。他的信条极度简单：**一个人只要足够强，就不需要依赖任何人。**

Anna 画他时加了一道旧的铅笔划痕贯穿他的盔甲——那是他第一次输掉的痕迹。她没有擦掉。

战场上，Max 的存在是一把精准的刀。他不冲阵，他找时机。当敌方最强的那个人冲上来时，他一击而定。这正是他的机制来源：**对满血目标施加斩首伤害（Strong Strike）**，一锤定音，然后退回位置——他不贪，他只要那一刀。

他的弧光是从"一个人赢"到"为整队赢一刀"。那个区别对他来说很长时间里都不存在，直到某一场战斗之后。

**一句话台词**：「先让我来。」

### 性格特征

- 冷静，近乎无情，但不是恶意——他只是从未想过"照顾别人"是他的工作
- 对自己要求极高，对失败的容忍度几乎为零（那道划痕他反复看过很多次）
- 话极少，但每句话都是结论，不是过程
- 隐藏特征：他在乎队友，只是他表达的方式是"帮你处理掉最难处理的那个"

### 视觉设计方案

**整体气质**：少年骑士，轮廓凌厉，铅笔线条干净利落，带着一种还没完全长开但已经很危险的感觉。

**外形描述**：
- 全身板甲，板甲线条被 Anna 用铅笔画得略显棱角分明——不是写实的弧面，是她对"骑士"的概念还原
- 头盔半开式：面罩上翻，露出冷静的眼睛和紧抿的嘴
- 体型：比同龄人高半头，但还是少年比例，没有夸张的肌肉感
- 盔甲上的旧划痕：从右肩到左腰的对角线，铅笔蹭花，有岁月感

**标志性元素**：
- 武器：单手宽刃直剑（战刃感），剑刃有手绘的冷钢光泽线；左手空——他不用盾
- 姿态：侧身微蹲，剑尖斜向前下方，重心在后脚——随时起爆
- 动作特征：出剑时无前摇，定格姿势永远是已经收剑后的那一刻

**颜色方案**（Anna 方蓝色系，Max 取冷钢蓝调）：
- 主色：冷钢蓝灰 `#6E8CAB`（盔甲本体）
- 高光：银白 `#D4DCE6`（盔甲棱线、剑刃）
- 阴影：深蓝灰 `#3A4D5C`（盔甲内槽、阴影区）
- 线稿：铅笔灰 `#7A7A7A`（全身轮廓线，略粗）
- 水彩晕：淡蓝 `#C2D4E8`（盔甲面板水彩渲染，保留笔触边缘）

---

### AI 图生成 Prompt

> 风格基准：手绘笔记本插画，铅笔线稿 + 水彩/马克笔上色，少年战记风，蓝灰冷色调。

**Prompt 1 — 全身立绘（角色卡用途 · 定稿所用，单段肯定句）**

> 朝向交给后期镜像；划痕后期手绘补；结尾压顶句压住"度"。

```
A full-length head-to-toe character illustration of a slender teenage boy knight standing in a clean side profile view, his whole body turned sideways as if about to walk forward, youthful lean build with thin arms and legs and clear adolescent proportions. He wears angular full plate armor made of flat faceted metal plates with sharp simple edges, the naive blocky shapes a child would draw for a knight. His visor is flipped fully up above his forehead so his entire face is clearly visible in profile: a calm serious realistic European boy face with a soft natural eye, light eyebrow, a small straight nose and a tight closed mouth, short slightly messy hair, an ordinary believable human face with grounded proportions. In his near hand he holds a single-handed broad straight steel sword lowered with the blade tip angled down toward the ground in a quiet ready stance, weight settled on the back leg. His other hand is open and empty at his side, carrying no shield, no extra objects floating in the air around him. Hand-drawn children's storybook notebook sketch, visible pencil outlines with slightly rough wobbly amateur lines, soft watercolor and marker fill, cool steel blue-grey armor tones around hex 6E8CAB, silver-white highlights along the plate edges and the sword blade, deep blue-grey shadows in the recesses, plain clean white paper background with faint paper texture, western medieval fantasy, gentle innocent picture-book tone. keep it clearly a talented teenager's notebook drawing not professional concept art, visible wobbly pencil construction lines, flat watercolor washes with rough brush edges, simple un-rendered faceted shapes, no smooth digital shading no realistic metallic reflections
```

**Prompt 2 — 动作瞬间（技能卡用途）**
```
knight teenager mid-strike pose, single broad sword swung horizontally, full plate armor with cool blue watercolor shading, moment of impact freeze frame, motion blur pencil lines, notebook sketch style, blue-grey color palette, dynamic diagonal composition, white vignette background, pencil and watercolor illustration, european medieval, hand-drawn children's book style
```
*Negative prompt*:
```
photorealistic, 3D render, anime eyes, blood, excessive detail, dark atmosphere, grim reaper, fantasy magic effects, text, watermark
```

**Prompt 3 — 表情/头像（UI 头像用途）**
```
close-up portrait of young male knight, half-open visor helmet, cold calm expression, tight-lipped, steel blue plate armor, pencil sketch with light watercolor tinting, notebook margin doodle quality, cool grey-blue tones, simple clean background, slight paper texture, western european knight, determined teenager face, hand-drawn illustration style
```
*Negative prompt*:
```
photorealistic, 3D, anime, cute, smiling, colorful background, complex armor detail, aging face, beard, helmet fully closed, fantasy glowing effects
```

---

## Lena ——「铁盾算法师」

### 背景故事

Lena 是 Anna 笔记本里某种程度上最像她自己的角色。Anna 是那种用数学思维解题的女生，而 Lena 是把这件事做到了战场上的人。

Lena 来自一个铁匠世家——不是打剑的，是打盾的。她父亲教她的不是力量，是**受力分析**：盾的哪个位置被打会崩，哪个角度能把重击分解成两次轻击，在什么时候静止比移动更省力。Lena 把这些全学会了，然后比任何骑士都更清楚怎么活到最后。

Anna 给 Lena 的盾牌内侧用小字画了受力公式——那是 Anna 觉得最酷的细节，"一个战士的盾上写着物理题"。

**机制来源**：Lena 的「纪律（Discipline）」减伤是固定量减伤，不按比例——这对应她的设计逻辑：不管对面打多重，她都能把每一击拆解到固定的损耗范围内。静止时减伤更高，因为她在"计算"。

她的弧光不是学会进攻，而是学会**相信队友**——她一直知道防守不能赢，但她花了很长时间才学会不把"进攻"这件事亲自做完。

**一句话台词**：「我已经算过了。」

### 性格特征

- 骄傲但不张扬，从不炫耀——她的自信体现在"不需要解释"上
- 做决定前极度精确，做决定后不再动摇（她没有后悔这个选项）
- 对混乱和冲动有轻微的不耐烦，但会忍
- 隐藏特征：她关心人，只是她的表达方式是"提前把所有危险都算没了"

### 视觉设计方案

**整体气质**：成熟感，不是年龄成熟，是态度成熟。铅笔线条比 Max 更厚实，有分量。水彩颜色比 Max 更暖，有点像铁匠铺的感觉——钢铁和皮革的组合。

**外形描述**：
- 链甲 + 皮革护具组合，不是板甲，更接近中世纪步兵甲——灵活且耐久
- 圆形大盾（正面向观众），盾面有铅笔打格的几何纹路，像工程图纸，又像花窗
- 头发：战辫，编得很细密，收在颈后；没有头盔（Anna 觉得看不到脸就不算"她的角色"）
- 体型：比 Max 矮半头，但肩宽，站姿很稳——重心极低

**标志性元素**：
- 主武器：大圆盾（占据画面左半部），盾缘有铆钉排列，内侧有小字公式
- 副武器：右手短剑，收于腰侧——不是主角
- 姿态：正面站定，盾略前倾，目光平静注视前方——她在等，不在冲
- 细节：盾牌内侧可见一行小字（受力计算，Anna 的手写体，马克笔写的）

**颜色方案**（Anna 方蓝色系，Lena 取深钴蓝 + 暖青铜调）：
- 主色：深钴蓝 `#4A6FA5`（链甲、皮革护具主调）
- 辅色：青铜暖绿 `#7B8C5A`（皮革带、扣件、盾缘）
- 高光：浅蓝白 `#BCCDE0`（链甲金属反光）
- 阴影：深橄榄蓝 `#2E4055`（盾面暗部、链甲凹处）
- 几何纹：铅笔细线（`#8A8A8A`），像工程图纸打格

---

### AI 图生成 Prompt

**Prompt 1 — 全身立绘（角色卡用途）**
```
a young woman warrior in chainmail and leather armor, holding a large round shield with geometric pencil-line patterns, short sword at hip, braided hair pulled back, standing firm in defensive stance facing forward, notebook sketch illustration style, pencil outlines with deep cobalt blue and warm bronze watercolor, white background, western medieval, children's storybook illustration, confident calm expression, shield slightly tilted forward, intricate rivets on shield edge
```
*Negative prompt*:
```
photorealistic, 3D render, anime, sexualized, revealing armor, fantasy magic, dark background, complex cityscape, modern, japanese, chibi, horror, excessive weapons
```

**Prompt 2 — 防御姿态特写（技能卡用途）**
```
shield raised in defensive block position, large round shield with geometric engineering-diagram patterns, chainmail-clad arm bracing firmly, watercolor and pencil sketch style, cobalt blue palette with bronze accents, motion lines showing impact absorption, notebook doodle aesthetic, white background, dynamic but still composition, western medieval warrior woman, hand-drawn illustration
```
*Negative prompt*:
```
photorealistic, 3D, blood, explosion, anime, glow effects, dark atmosphere, text overlay, modern elements
```

**Prompt 3 — 表情/头像（UI 头像用途）**
```
portrait of young woman warrior with calm confident expression, braided dark hair, wearing chainmail coif, steady gaze, subtle small smile, pencil sketch with cobalt blue and warm bronze watercolor tinting, notebook margin illustration style, simple light background, paper texture, western european medieval, hand-drawn children's book style
```
*Negative prompt*:
```
photorealistic, 3D, anime, helmet covering face, glamorous makeup, fearful expression, dark shadows, complex background, modern hairstyle
```

---

## Mara ——「战场织网者」

### 背景故事

Mara 是 Anna 笔记本里最特别的一个——她不是英雄，她是战术家。

Anna 给她设定的原型是欧洲民间故事里的猎手，但不是那种单枪匹马打熊的猎手，而是那种**知道整片森林里所有猎物在哪里**的人。她发现猎物，她标记它，然后把猎群引到位置——猎到的永远不是她一个人的功劳，但如果没有她，猎队就是一群瞎走的人。

Anna 喜欢 Mara 的原因是：她看懂的比任何人多，但她总是最后一个说话。

**机制来源**：Mara 的「标记（Mark）」机制——她的箭不是最强的，但每一支箭都在敌人身上留下标记，让全队对这个目标的伤害提升。这正是她的设计逻辑：她不是伤害的来源，她是伤害的放大器。她的视野是全队的视野，她的判断决定全队往哪打。

她最难受的那种战斗，是全队各打各的，没有人去打她标记的那个人。她第一个明白"我们配合得不够好"，但她花了很长时间才学会直接说出口，而不是默默把自己的箭调高。

**一句话台词**：「我看到了。」

### 性格特征

- 表面开朗健谈，实际上有点孤独——她的孤独来自"我看到的比大家多，但大家不一定在看我看的地方"
- 宏观思维，对战术全局的感知是天赋，但很难解释给别人听
- 对失误有极高的容忍度（对别人），但对"大家不配合"这件事很难忍
- 隐藏特征：她最需要的不是有人保护她，而是有人相信她看到的是真的

### 视觉设计方案

**整体气质**：轻盈，几乎没有重量感。和 Max、Lena 的铁器感完全不同——Mara 是皮革、羽毛、细绳的质感。铅笔线条最细，水彩最透，像是画在格子本页边空白处的小人。

**外形描述**：
- 轻装猎手：皮革短上衣 + 长腿皮裤，单肩斜背箭筒，无盔甲——她靠视野，不靠护甲
- 头发：松散波浪卷，一半扎起，一半散落（Anna 给她画的，比其他两个角色更随意）
- 体型：偏纤细高挑，有点比例夸张的修长腿——Anna 的手绘风格有意放大这个特征
- 左手腕：蓝色细绳缠绕三圈（标记色，呼应「标记」机制），Anna 用水彩点了蓝色小点

**标志性元素**：
- 武器：轻型长弓（比战弓细巧），弓弦半张，但箭还没搭满——她在瞄准，不急着射
- 眼神：看向画面之外的远处，不是看箭尖——她在读战场
- 箭羽：蓝白色（标记色系），羽毛用铅笔画了羽管细节

**颜色方案**（Anna 方蓝色系，Mara 取暖棕 + 天蓝点缀——最暖，但蓝调收边）：
- 主色：暖棕皮革 `#8C6D4F`（上衣、裤子、箭筒）
- 点缀：天蓝 `#7EB5D6`（手腕细绳、箭羽、衣领边线）
- 高光：奶白 `#F0E8DA`（皮革受光面、弓身高光）
- 阴影：深棕蓝 `#4A3728`（皮革凹陷处）
- 水彩蓝点：`#5BA3C9`（手腕标记色，水彩圆点笔触）

---

### AI 图生成 Prompt

**Prompt 1 — 全身立绘（角色卡用途）**
```
a slender young woman hunter in light leather armor, drawing a longbow at half-draw, gaze looking into distance beyond the arrow, loose wavy hair half-tied, diagonal arrow quiver on back, blue cord wrapped around left wrist, notebook sketch illustration style, pencil outlines with warm brown and sky blue watercolor, white background, western medieval ranger, children's storybook art, light and airy linework, tall elegant proportions, blue-white arrow fletching
```
*Negative prompt*:
```
photorealistic, 3D render, anime, heavy armor, dark forest background, horror, blood, sexy pose, revealing outfit, complex background, modern clothing, glow effects
```

**Prompt 2 — 标记瞬间（技能卡用途）**
```
hunter girl releasing arrow with a glowing blue marker trail, standing still while scanning distant battlefield, light leather outfit, loose hair flowing slightly, blue wrist cord glowing gently, notebook pencil and watercolor style, warm brown and sky blue palette, dynamic but composed stance, white background with faint pencil grid texture, western medieval, hand-drawn illustration
```
*Negative prompt*:
```
photorealistic, 3D, anime, excessive magic effects, dark background, blood, heavy particle effects, full armor, modern
```

**Prompt 3 — 表情/头像（UI 头像用途）**
```
close-up portrait of young woman hunter with warm open expression and slightly distant gaze, loose wavy hair, light leather collar, blue cord visible at wrist edge, sky blue and warm brown tones, pencil sketch with watercolor tinting, notebook margin illustration style, simple warm white background, paper texture, hand-drawn children's book style, european medieval, slightly wistful look
```
*Negative prompt*:
```
photorealistic, 3D, anime, cold expression, full armor, dark background, fantasy glow, text, watermark, complex accessories, modern hairstyle
```

---

## Anna 阵营的三只怪物——Aello / Björn / Lerna

> 归属拍板见 [`CHARACTER_DESIGN.md` §7](CHARACTER_DESIGN.md#7-六个-pve-复用兵种的阵营归属讨论中2026-07-02)：鬼鸟 Harpy / 狂战士 Berserker / 裂变兵 Splitter 三个 PvE 复用单位划给 Anna 的笔记本。它们**不是** Hartmann 家族试炼学员——Max/Lena/Mara 三人是「参选的孩子」，这三个是 Anna 在笔记本别处画的**怪物与游荡者**，跟方家的穷奇/獬豸/随军医官一样，是主角阵容之外的"世界background 角色"。
>
> **叙事归属与 PvE 波次配置互不干涉**（见 §7.1 关键澄清）：即使陶在 Ch3/Ch4 把它们当敌人打，它们仍然是 Anna 本子里画出来的东西——这正好印证「两家相遇」时陶撞见了对方笔记本里的怪物。
>
> 状态：Aello **已出图定稿**（2026-07-02，见下方最终 prompt）；Björn / Lerna 仍是首版命名+背景+视觉方向定稿，未出图。机制数值锚点见 `server/engine/src/config.ts`（Harpy/Berserker/Splitter 三个 blueprint）与 [`PVP_LOADOUT_DESIGN.md`](PVP_LOADOUT_DESIGN.md) §5 费用定标。

### Aello ——「鬼鸟」（Harpy）

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

**Prompt 1 — 全身立绘（角色卡用途）**
```
A full-length illustration of a burly adult norse warrior shown in clean side profile, broad-shouldered heavyset build far bulkier than a teenager, wearing simple leather armor with a full bearskin cloak draped over his shoulders and the bear's head resting near his shoulder, thick beard, low furrowed brow with an intense but focused gaze, holding a large two-handed battle axe lowered in a crouched ready stance with his weight low and forward. Hand-drawn children's storybook notebook sketch, visible thick bold pencil outlines rougher and heavier than a careful drawing, soft watercolor and marker fill, cool iron blue-grey armor tones around hex 4E5C6E, warm brown bearskin around hex 6B4A32, pale grey-white highlights on the axe blade, deep iron blue shadows in the armor recesses, plain clean white paper background with faint paper texture, norse mythology, gentle picture-book tone. keep it clearly a talented teenager's notebook drawing not professional concept art, visible wobbly pencil construction lines, flat watercolor washes with rough brush edges, simple un-rendered faceted shapes, no smooth digital shading no realistic fur rendering
```
*Negative prompt*:
```
photorealistic, 3D render, anime, blood, gore, horror, glowing magic effects, ornate armor, modern, text, watermark
```

**Prompt 2 — 狂暴瞬间（技能卡用途）**
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

死亡后分裂增殖的机制原型只有一个：**勒耳纳的九头蛇（Lernaean Hydra）**——砍下一头会长出两头，这是希腊神话里最直白的"越杀越多"。名字直接取自她的栖息地 **Lerna**（勒耳纳沼泽），和 Aello/Björn 一样，是从神话本体直接借来的名字，不另起人名。

#### 背景故事

Lerna 不是人，Anna 从一开始就没打算把她画成人形——她是笔记本沼泽页角落里的一团东西，安静的时候看起来只是水草缠成的一小簇。没人知道她"本体"有多大，因为她从来没有以完整的样子出现过：每次被打倒，留下的不是尸体，是两个更小、更快的东西从原地钻出来，头也不回地继续往前冲。

这正是她的机制来源：**死亡分裂**——倒下即成两只 Runner 冲出。对付她最蠢的办法就是一次次单点消灭，因为每一次"解决掉"都只是让她换了个更麻烦的形态；真正的答案是范围伤害，一次性把她和她分裂出来的东西一起清场。

Anna 没有给她台词，因为 Lerna 从未展现过能说话的部分。她画她的方式更像画一种天气，而不是画一个角色。

#### 性格特征

- 没有可辨识的"性格"——这是 Anna 刻意的设计：她是现象，不是人物
- 对她而言"死亡"这个概念不成立，倒下只是换一种存在方式继续前进
- 唯一近似"意图"的东西是持续不断地扩散、繁殖、逼近，没有目的地，只有方向

#### 视觉设计方案

**整体气质**：**非人形**——刻意不套 Max/Lena/Mara 的少年骨架模板，也不做常规怪兽的四足/双足站姿。参考九头蛇的多头缠绕形态，画成一团水草般纠缠的蛇身簇，安静时收成一小簇，即将行动时头部micro展开。

**外形描述**：
- 主体是三到五条缠绕交织的细长蛇身，共用一个模糊的根部（不给明确的"躯干"，强调"这不是一个个体，是一团现象"）
- 每条蛇身末端是小而钝的蛇头，没有锋利獠牙的写实感，更接近孩子画蛇的简化符号（一个圆点当眼睛，一条弧线当嘴）
- 体表：深浅不一的冷蓝鳞片纹理，用铅笔画细密的鳞片格线，水彩打底不做光泽渲染
- 没有四肢、没有站姿——她贴地蜿蜒，或蜷成一团静止

**标志性元素**：
- 分裂暗示：其中一条蛇身末端画得比其他几条更浅更透明，像是"即将长出来"的下一条，暗示机制本身
- 眼睛：所有蛇头的眼睛都是同一种空洞的圆点，没有情绪、没有焦点方向
- 底色：整团轮廓边缘用深蓝水彩晕开，像是从沼泽水面探出的一小片阴影

**颜色方案**（Anna 方蓝色系，Lerna 取深蓝绿——三人里最冷最陌生）：
- 主色：深蓝绿 `#3C5A54`（蛇身鳞片主调）
- 辅色：沼泽暗绿 `#4A5C3E`（鳞片阴影过渡）
- 高光：苍白青 `#A8C4B8`（鳞片脊线反光）
- 阴影：近黑蓝绿 `#1F2E2A`（缠绕交叠处的暗部）
- 半透明分裂头：浅蓝绿 `#7FA396`（预示"即将分裂"的那一条，透明度更高）

#### AI 图生成 Prompt

**Prompt 1 — 全身立绘（角色卡用途）**
```
A creature illustration of a small tangled cluster of three to five slender serpent bodies coiling together from one blurred shared base, shown from the side, each serpent neck ending in a small blunt simplified snake head with a single round dot eye and a simple curved line mouth like a child's drawing of a snake, no limbs, no upright posture, the whole cluster resting low and coiled as if part of it is about to uncoil into motion, one of the serpent tips rendered more pale and translucent than the others as if a new one is about to grow. Hand-drawn children's storybook notebook sketch, visible pencil scale texture drawn as fine cross-hatched lines without realistic gloss, soft watercolor fill, deep teal green scale tones around hex 3C5A54, pale cyan-green highlights along the scale ridges, near-black teal shadows where the bodies overlap, plain clean white paper background with faint paper texture, greek hydra mythology, gentle picture-book tone. keep it clearly a talented teenager's notebook drawing not professional concept art, visible wobbly pencil construction lines, flat watercolor washes with rough brush edges, simple un-rendered shapes, no smooth digital shading no realistic reptile skin rendering
```
*Negative prompt*:
```
photorealistic, 3D render, anime, horror, blood, gore, humanoid, limbs, fangs, glowing eyes, dark background, text, watermark
```

**Prompt 2 — 分裂瞬间（技能卡用途）**
```
tangled serpent cluster creature at the moment one translucent pale serpent tip splits away from the main coiled body, faint watercolor motion trail behind the splitting tip, notebook sketch style, deep teal green and pale cyan watercolor palette, low coiled composition, white vignette background, pencil and watercolor illustration, hydra mythology, hand-drawn children's book style
```
*Negative prompt*:
```
photorealistic, 3D, anime, gore, horror, dark atmosphere, glowing magic effects, text, watermark
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

三个角色的视觉参考全部在西欧中世纪 + 北欧传说的语境里，不混搭东方元素。这是角色设定的硬约束：Anna 的世界观是她从欧洲历史和格林童话里建立起来的，她不画东方的东西——就像陶不画西方骑士一样。两本笔记本的风格差异就是这个设定的体现。

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

| | Tao（陶·东方男孩） | Anna（西方女孩） |
|---|---|---|
| 笔 | 单色圆珠笔/钢笔涂鸦 | 铅笔线 + 克制水彩淡彩 |
| 造型 | 火柴人、大圆头两点眼、随性 | 真实少年比例、五官完整、更工整 |
| 气质 | 原始、冲、随手 | 一丝不苟、算过的工整感 |

**"度"的上限 —— Anna 侧 prompt 固定加这句"压顶句"**（防止滑向专业概念图）：

```
keep it clearly a talented teenager's notebook drawing not professional concept art, visible wobbly pencil construction lines, flat watercolor washes with rough brush edges, simple un-rendered faceted shapes, no smooth digital shading no realistic metallic reflections
```

> Max 定稿那张的金属渲染/脸已踩上限边缘，Lena、Mara 出图时往回收一档：盔甲/护具靠铅笔线区分块面、平涂淡彩，别渲染反光；五官保持少年手笔的简单。
