# 付费皮肤全彩立绘 — 图片生成 Prompt 文档

> 更新：2026-07-22
> 背景：`art-direction.md §9.1`（2026-07-02 拍板）——皮肤程序染色已失效，**一律走完整 `.tao`**，一款皮肤 = AI 出图 → GIMP 切件 → animator 绑骨 → 导出 `.tao`。上线只做 6 款，目录见 `GACHA_DESIGN §9.5` / `META_TASKS.md`。
> 同类文档：[`gacha-art-prompts.md`](gacha-art-prompts.md)（结果卡/边框/banner）· [`shop-art-prompts.md`](shop-art-prompts.md)（商店图标）——本文档专门管**皮肤本体的全身立绘**，风格比上述两份"课堂涂鸦"更精致一档（见下）。

---

## 进度

| 皮肤 id | 角色 / 兵种 | 稀有度 | 配色 | 状态 |
|---|---|---|---|---|
| `skin_shop_c1` | 李川 / Infantry | common | 灰白调 | ✅ 已出图定稿，[`art/skins/infantry.png`](../../art/skins/infantry.png)；§1 prompt 为此图基准 |
| `skin_shop_r1` | 苏远 / Archer | rare | 蓝色调 | 🟡 已出图 [`art/skins/archer.png`](../../art/skins/archer.png)（§2 v3 prompt，3/4 侧身回望 + 侧分短发 + 弓上弦全对）；**owner 反馈头部违和**（2026-08-13）：脖子过细过长像接上去的、头转向和肩线角度不协调、耳朵贴得太低靠近下颌、发型右侧一撮不对称翘毛破坏头部圆润轮廓——§2 v4 prompt 待用 GPT Image 2 重出 |
| `skin_shop_e1` | 陈守 / ShieldBearer | epic | 紫色调 | 🟡 已出图 [`art/skins/shieldbearer.png`](../../art/skins/shieldbearer.png)（§3 v2 prompt，体型/叉腿盾墙/寸头全中）；**留 1 项待调**：肤色偏深 + 黑卷发，与另两人（浅暖褐肤 + 棕发）不一致，破坏"方家三兄弟"读感，重出时加 `light warm tan skin matching his friends, brown hair not black` |
| `skin_e1` | Anna·Lena | epic | 橙色调（原紫色调） | ✅ 已出图定稿（2026-07-26），2026-08-09 改色为橙，[`art/skins/lena.png`](../../art/skins/lena.png)；§6 v2 prompt 命中 |
| `skin_e2` | Anna·Mara | epic | 橙色调（原紫色调） | ✅ 已出图定稿（2026-07-26），2026-08-09 改色为橙，[`art/skins/mara.png`](../../art/skins/mara.png)；§5 v2 prompt 命中 |
| `skin_l1` | Anna·Max | legendary | 橙色调（原金米调） | ✅ 已出图定稿（2026-07-26），2026-08-09 改色为橙，[`art/skins/max.png`](../../art/skins/max.png)；§4 v2 prompt 命中 |

> **2026-08-09 改色为橙**：owner 要求把 Lena/Mara/Max 三款皮肤的配色统一改成橙色（原 epic 紫金公式 + legendary 金米调）。做法是**程序化改色**，不是重新出图：对已出图定稿的成品资产（`client/src/assets/units/skins/skin_{lena,mara,max}.{png,tao}`、`art/skins/{lena,mara,max}/*.png`、对应的 `.tao.editor` 动画师工程内嵌图）做色相区间替换——只对主色带（Lena/Mara 的深紫/亮紫/薰衣草，Max 的金/米）做色相偏移+饱和度/明度提升到橙色，金饰边、蓝方阵营锚点（蓝宝石/蓝绳）、肤色、发色、黑色描线、白底透明不动。因此本文档下方各条 prompt 里写的具体色号（`#6B3F73`/`#AA55CC`/`#C9A227` 等）已不是当前上线资产的真实颜色，只保留作历史记录/若未来要从零重新出图时的参照——重新出图时需先把 prompt 里的色号语言换成橙色公式再用。`.xcf` 分层源文件未跟着改色（GIMP 图层改色需手工做，本次未做），仅供将来重新出图的分层基底，不代表当前上线外观。

三个角色的身高档位（`art-direction.md` 身高规格表）：李川 M 普通 / 苏远 **S 小个子** / 陈守 **L 高个子**——立绘构图要读得出这个身高差，不能三人等高。

---

## 使用说明

- **推荐工具**：Midjourney v6 / DALL-E 3
- **尺寸**：竖版全身立绘，参考图实际产出 **1024×1536（2:3）**，Midjourney 参数 `--ar 2:3`
- **视角**：站姿/走姿侧身四分之三侧面（约 3/4 side profile），不是正面，也不是纯 90° 侧面
- **背景**：纯白，方便后续 GIMP 抠图切件（头/躯干/双臂/双腿分层，见 `art-direction.md` AI 图角色流程）
- 每张建议生成 4 个变体后挑选，优先选**五官简化、线条干净、色块边界清楚**的一版——切件时颜色/线条越清楚，GIMP 抠图越省事
### 区分三人的核心原则（2026-07-22 重写，别再犯）

**误区**：早期把姿态（都走路）+ 脸型 + 服装轮廓（背心+短裤+靴）全锁进共用前缀，三人只靠"换上衣色 + 换武器 + 贴配件（羽毛/护腕/十字带）"区分。结果三张图长得像同一具身体套皮——脸是空白的（两个点），头发/体型/姿态本该扛辨识度，却全被锁成同一种；而贴上去的职业道具只说明"这是个弓箭手"，不说明"这是苏远"，堆再多都像装备栏不像人。

**正解**：辨识度来自**人物本身的三件事——体型 + 站姿 + 发型轮廓**，它们都由性格推导、天生不同、不靠堆道具；**渲染风格**才是三人共享、让他们成一套的东西；职业道具只保留最低限度。统一对照轴用"**他们怎么占据画面空间**"（直接来自性格，天然给出三种不同剪影）：

| 角色 | 体型 | 怎么占空间（站姿） | 发型（由性格来） | 职业道具（最低限度） |
|---|---|---|---|---|
| 李川 M（已定稿） | 中等 | **穿行**——迈步走动、重心前倾，闲不住 | 四散炸开的乱发（躁动） | 剑 |
| 苏远 S | 最矮最瘦 | **把自己收小**——双脚并拢、手臂贴身、安静站定、目光望向别处 | **平顺侧分的利落短发**（克制精准），非炸毛 | 弓 + 背后箭袋 + 一只朴素护腕 |
| 陈守 L | 最高最壮 | **钉在原地**——双脚叉开、重心压低、像一堵墙 | **近乎理平的寸头**（纪律） | 圆盾（骷髅纹）+ 短匕 |

三个剪影因此天然不同：一个在动、一个缩成一小团、一个占满地面。**不要**再往身上贴羽毛头饰/无指手套/胸前十字背带这类"凑数"配件。

### 共用前缀（贴在每条主体前）——只锁"渲染风格 + 脸 + 家族统一元素"，不锁发型/姿态/体型

```
Full-body character illustration, three-quarter view facing left, on a plain
pure-white background; full body visible head to boots, centered, filling
most of the frame.
Rendering: clean confident dark-ink outlines of medium weight (not
sketchy-wobbly), flat color fills with cross-hatch pencil shading for volume
and folds, matte paper look — NO gradient, NO glossy highlights, NO glow, NO
cel-shading, NO airbrush.
Face: large round head, warm tan skin with light cross-hatching under the
jaw, two small solid-black dot eyes, no nose, no mouth, small visible ear.
Shared "family" cues (all three friends share these so they read as one set):
hand-stitched dashed seam lines on the clothing, and tall brown leather
lace-up boots with a folded cuff and cross-hatch shading. Soft cross-hatched
oval ground shadow beneath the feet, otherwise empty background.
```

> 每个角色在此之上，用【**体型 + 站姿 + 发型**】三件事拉开区别（都由性格来，不靠堆道具）——见各条 prompt。

### 共用负向提示

```
gradient, glossy highlights, shiny, glow, painterly, soft airbrush shading,
watercolor, 3d render, photorealistic, realistic face, detailed facial
features, nose, mouth, cel-shaded anime, thick uniform cartoon outline,
multiple characters, background scenery, watermark, cropped, close-up,
low body, missing legs, missing feet
```

> Midjourney 末尾追加：`--ar 2:3 --style raw --no gradient, glossy, shiny, glow, realistic face, cel-shading, background scenery`

---

## 1. `skin_shop_c1` — 李川 · Infantry（common，灰白调）✅ 已出图

**已产出**：[`art/skins/infantry.png`](../../art/skins/infantry.png)。作为**基准款**，李川的辨识三件套：①体型中等（M）；②站姿**穿行**——迈步走动、重心前倾（闲不住的躁动，另外两人不要照抄这个步态）；③发型四散炸开的乱发。下方 prompt 留作复现/微调基准。

```
Full-body character illustration of a child warrior, standing/walking pose,
three-quarter side profile view, facing left, on a plain pure-white background.
Simplified cartoon face: large round head, warm tan skin tone with light
cross-hatching under the jaw for shading, two small solid-black dot eyes, no
nose, no mouth, small visible ear. Messy spiky brown hair rendered with short
scratchy ink strokes. Clean confident dark-ink outlines (medium weight, not
sketchy-wobbly), flat color fills for clothing with cross-hatch pencil
shading for volume and folds — NO gradient, NO glossy highlights, NO glow,
NO cel-shading, NO airbrush. Average medium build, average height.
Wears a slate-gray short-sleeve crew-neck t-shirt with visible hand-stitched
dashed seam lines at collar and sleeve hems, and dark charcoal-gray shorts
with a matching stitched hem. Tall brown leather lace-up boots with visible
stitching and cross-hatch shading, folded cuff at the top.
Holds a simple straight sword with a plain gray steel blade (soft cross-hatch
shading for the metal, no shine) and a dark brown wrapped hilt, gripped in
one hand, pointed diagonally down-forward, held low and steady rather than
raised in attack.
Soft cross-hatched oval ground shadow beneath the feet, otherwise empty
background. Full body visible head to boots, centered, filling most of the
frame.
--ar 2:3 --style raw --no gradient, glossy, shiny, glow, realistic face, cel-shading, background scenery
```

---

## 2. `skin_shop_r1` — 苏远 · Archer（rare，蓝色调）

**人设参照**（`characters.md` 苏远）：安静、观察、不急着表态；读战局最快；单独训练长大，把自己收得很紧的那种精准；对自己要求比家族还高。**辨识三件套**：①体型——三人里最矮最瘦（S 档）；②站姿——**把自己收小**：双脚并拢、手臂贴身、安静站定，目光望向一侧远处（他总在悄悄看别处、确认别人在），不走路、不叉腿、不拉弓；③发型——**平顺、侧分的利落短发**（克制精准的性格），刻意区别于李川的炸毛和陈守的寸头。道具只留弓+背后箭袋+一只朴素护腕。

> 2026-07-22 v3（下方为直接可复制的完整合并版，不再依赖 `[共用前缀]`）：v2 出图头发/性别/弓/配件全对，但**站姿丢了性格**（画成正面证件照、双脚分开、正视镜头）+ **体型没读出瘦小**。v3 把"瘦小体型"和"3/4 侧身 + 侧头望别处 + 并脚收臂"两条提到最前标 most important，并在负向压掉 `front view / facing viewer / standing at attention / feet apart / average build`。

```
Full-body character illustration of a young boy archer, three-quarter side
view, his body turned about 45 degrees to the left so one shoulder is closer
to the viewer, on a plain pure-white background; full body visible head to
boots, centered, filling most of the frame.
Rendering: clean confident dark-ink outlines of medium weight (not
sketchy-wobbly), flat color fills with cross-hatch pencil shading for volume
and folds, matte paper look — NO gradient, NO glossy highlights, NO glow, NO
cel-shading, NO airbrush.
Face: large round head, warm tan skin with light cross-hatching under the
jaw, two small solid-black dot eyes, no nose, no mouth, small visible ear.
This is a young BOY, clearly male, NOT a girl.
Build (most important): the smallest and slightest of three friends — a
small, short, skinny little boy with thin arms and legs, a narrow chest and
narrow shoulders, noticeably petite and clearly a full head shorter and much
skinnier than an average child. Emphatically NOT muscular, NOT average-sized,
NOT tall, NOT a curvy or feminine figure — just a small skinny kid.
Pose (most important): a closed, self-contained, reserved standing pose that
takes up as little space as possible — feet together nearly touching, both
arms held in close to his body, shoulders slightly drawn in. His head is
clearly turned to look off to one side, over and past his own shoulder,
gazing calmly into the distance as if quietly watching something far away —
a still, watchful, introverted stance. NOT facing forward, NOT looking at
the viewer, NOT standing at attention with feet apart, NOT walking, NOT
mid-stride, NOT drawing the bow, NOT an action pose.
Hair: short, neat and tidy, smoothed down and combed to one side with a
clean side part, lying fairly flat and staying above the eyebrows — a
controlled, precise boy's haircut. Deliberately NOT a big spiky puffy
explosion of hair, NOT buzzed to the scalp, NOT long bangs over the face.
Clothing: a sleeveless royal-blue athletic top with hand-stitched dashed
seams at the collar and armholes, and neutral gray-blue shorts with a
stitched hem. A single plain brown leather bracer on his bow-arm forearm —
the only piece of gear, nothing else added. Tall brown leather lace-up boots
with a folded cuff and cross-hatch shading. Soft cross-hatched oval ground
shadow beneath the feet, otherwise empty background.
Weapon: a slim quiver holding a few fletched arrows on his back; he holds a
clearly recognizable recurve bow — strung, with a taut visible bowstring
running the full length from tip to tip and distinct curved wooden limbs,
the classic recurve-bow silhouette — held upright and quietly at his side in
one hand, its lower tip a few inches off the ground, NOT drawn back, NOT
nocked with an arrow, NOT aiming, staying rigid and clearly bow-shaped (not
floppy, not bent like a whip or stick). Wood-brown bow with a small
royal-blue string-wrap accent.
--ar 2:3 --style raw --no gradient, glossy, shiny, glow, realistic face, cel-shading, background scenery, front view, facing viewer, standing at attention, feet apart, walking pose, mid-stride, spiky puffy explosion hair, buzzed hair, drawn bowstring, aiming, action pose, unstrung bow, missing bowstring, floppy bow, bent stick, bow touching ground, girl, feminine, muscular, average build, tall, adult, long bangs, hair over face, curvy waist, shoujo style
```

**调整建议**：
- **体型"最矮最瘦"单图难自证**：AI 没有对比参照时倾向画标准娃。这条最终建议**三人出好后并排比对再定夺**；单出苏远时靠 `small skinny little boy, petite, thin limbs` 反复压。若还是偏壮，加 `child around 7 years old, tiny, delicate slim frame`（注意别把 `delicate` 单独用，会带出女性化，务必与 `boy` 同句）。
- 若三人还是像"同一身体换色"，优先检查**这三件套是否读出来了**：他明显更矮更瘦？他缩成一小团、侧身望别处（对比李川在走、陈守叉腿钉住）？头发是平顺侧分（对比另两人）？哪个没出来就加强哪个，不要再往身上加配件。
- **⚠️ 踩坑①（弓）**：`unstrung`/`relaxed tension` 会被理解成"卸了弦"，弓变成没弦、垂地的软棍（参照 [`art/units/game_archer.jpg`](../../art/units/game_archer.jpg)，弓必须有清晰弦+反曲弧度）。已用 `strung, taut visible bowstring ... held upright, NOT drawn`。还垮就加负向 `unstrung, no visible string, limp, bent branch`。
- **⚠️ 踩坑②（性别）**：只写"瘦小安静"模型默认画成女孩（侧分长刘海垂脸+收腰）。苏远通篇是「他」，男孩。已加 `young BOY, clearly male` + 平顺短发但明确"男孩短发/不过眉/不垂脸" + 禁收腰。还偏女性化就加 `androgynous, delicate features, girl` 到负向、正向补 `plain boyish face`。
- **⚠️ 踩坑③（发型撞李川）**：苏远若又出炸毛，就和李川一个样。务必强调 `neat flat side-parted short cut, smooth, NOT spiky, NOT puffy`。

> 2026-08-13 v4（owner 反馈头部违和，出图工具换成 **GPT Image 2**，故不再用 Midjourney 的 `--ar`/`--no` 参数语法，负向诉求改写成正向描述句直接摆进正文）：v3 的姿态/发型方向本身没错（回望 + 侧分短发），问题出在落地细节——脖子被画成又细又长的"接头"、头转的角度比肩线转的角度大太多导致脖子拧巴、耳朵位置滑到接近下颌线、侧分发型右侧多长了一撮不对称的翘毛让头顶轮廓不圆。v4 保留 v3 的建置/姿态/服装/武器描述，只重写"脖子+头身角度+耳朵+发型轮廓"这四句，并把整条转成 GPT Image 2 友好的连续段落式描述（不用符号化负向列表，用"must/should NOT"直接写进句子里）。

```
Full-body character illustration of a young boy archer, three-quarter side
view, his body turned about 45 degrees to the left so one shoulder is closer
to the viewer, on a plain pure-white background, vertical portrait
composition about a 2:3 ratio; full body visible head to boots, centered,
filling most of the frame.
Rendering: clean confident dark-ink outlines of medium weight, not
sketchy-wobbly, flat color fills with cross-hatch pencil shading for volume
and folds, matte paper picture-book look. Do not use any gradient, glossy
highlight, glow, cel-shading, or airbrush effect anywhere in the image.
Face and neck (rewritten — this is the part to get right): large round
head, warm tan skin with light cross-hatching under the jaw, two small
solid-black dot eyes, no nose, no mouth, small visible ear placed at the
mid-height of the head, level with the eyes, not sliding down toward the
jawline. His neck must be short and a normal, sturdy thickness that matches
a child's proportions — it should look like the head is firmly attached to
the shoulders, not a thin long stalk with the head balanced on top like a
bobblehead. His head is turned to gaze off to one side, over and past his
own shoulder, but the turn is gentle — only a little more rotated than his
shoulder line, so the neck stays relaxed and straight rather than twisting
at a sharp angle. This is a young BOY, clearly male, NOT a girl.
Build (most important): the smallest and slightest of three friends — a
small, short, skinny little boy with thin arms and legs, a narrow chest and
narrow shoulders, noticeably petite and clearly a full head shorter and much
skinnier than an average child. He should not look muscular, average-sized,
tall, or have a curvy or feminine figure — just a small skinny kid.
Pose: a closed, self-contained, reserved standing pose that takes up as
little space as possible — feet together nearly touching, both arms held in
close to his body, shoulders slightly drawn in, gazing calmly into the
distance as if quietly watching something far away — a still, watchful,
introverted stance. He should not be facing forward, looking at the viewer,
standing at attention with feet apart, walking, mid-stride, or drawing the
bow.
Hair (rewritten): short, neat and tidy, smoothed down and combed to one side
with a clean, even side part, lying flat and staying above the eyebrows —
the head's overall silhouette should stay smooth and rounded all the way
around, like a single clean dome. Do not add any extra tuft, cowlick, flip,
or stray clump of hair sticking up or out on either side — the hairline
should be even and symmetrical in how closely it hugs the head, not bulkier
or spikier on one side than the other. This is a controlled, precise boy's
haircut, not a big spiky puffy explosion of hair, not buzzed to the scalp,
not long bangs over the face.
Clothing: a sleeveless royal-blue athletic top with hand-stitched dashed
seams at the collar and armholes, and neutral gray-blue shorts with a
stitched hem. A single plain brown leather bracer on his bow-arm forearm —
the only piece of gear, nothing else added. Tall brown leather lace-up boots
with a folded cuff and cross-hatch shading. Soft cross-hatched oval ground
shadow beneath the feet, otherwise empty background.
Weapon: a slim quiver holding a few fletched arrows on his back; he holds a
clearly recognizable recurve bow — strung, with a taut visible bowstring
running the full length from tip to tip and distinct curved wooden limbs,
the classic recurve-bow silhouette — held upright and quietly at his side in
one hand, its lower tip a few inches off the ground. The bow must not be
drawn back, not nocked with an arrow, not aiming, and must stay rigid and
clearly bow-shaped rather than floppy or bent like a whip or stick, and must
not touch the ground. Wood-brown bow with a small royal-blue string-wrap
accent.
```

**如果 v4 还是没收住**：优先检查是不是只改对了一半——脖子变粗了但头身角度还是拧巴，或者发型对称了但脖子还是细长，四处要同时读出来才算过；单独截图头部区域放大自检，对照 [`art/skins/infantry.png`](../../art/skins/infantry.png)（李川头部是这条线里唯一没被吐槽过的，脖子短粗、头身角度基本正对，可以当"正常"的参照基准）。

---

## 3. `skin_shop_e1` — 陈守 · ShieldBearer（epic，紫色调）

**人设参照**（`characters.md` 陈守）：话少但看人看事都准；七岁起自己走进盾卫的位置，认真到不像个孩子；对另外两人是"我站在你们前面"那种沉默的责任感。**辨识三件套**：①体型——三人里最高最壮（L 档）；②站姿——**钉在原地**：双脚叉开、重心压低、像一堵挪不动的墙，盾护在身前（他的定位就是"站着不动、把身体挡在前面"，走路与这个身份矛盾）；③发型——**近乎理平的寸头**（纪律），刻意区别于另两人。道具只留圆盾（骷髅纹）+ 短匕，不要额外背带之类凑数件。

> 2026-07-22 v2（下方为直接可复制的完整合并版，不再依赖 `[共用前缀]`）：套用苏远 v3 已验证成功的结构——明确 3/4 侧身、体型标 most important、负向堵掉"正面证件照/标准身材"。

```
Full-body character illustration of a young boy shield-bearer, three-quarter
side view, his body turned about 45 degrees to the left so one shoulder is
closer to the viewer, on a plain pure-white background; full body visible
head to boots, centered, filling most of the frame.
Rendering: clean confident dark-ink outlines of medium weight (not
sketchy-wobbly), flat color fills with cross-hatch pencil shading for volume
and folds, matte paper look — NO gradient, NO glossy highlights, NO glow, NO
cel-shading, NO airbrush.
Face: large round head, warm tan skin with light cross-hatching under the
jaw, two small solid-black dot eyes, no nose, no mouth, small visible ear.
This is a young BOY, clearly male, NOT a girl.
Build (most important): the tallest and broadest of three friends — a big,
solid, sturdy boy with thick heavy arms and legs, a wide barrel chest and
broad shoulders, clearly a full head taller and much bulkier and heavier
than an average child. He reads as the big heavy one. Emphatically NOT
skinny, NOT petite, NOT average-sized, NOT slender.
Pose (most important): he stands firmly planted and immovable, feet spread
wide apart, weight low and centered, rooted to the ground like a wall,
taking up a lot of horizontal space. He holds a round shield up and forward
at chest height in a calm, steady protective guard. A rooted, unmoving,
grounded stance — NOT walking, NOT mid-stride, NOT feet together, NOT
lunging, NOT an attacking or action pose.
Hair: cropped very short and neat, almost buzzed close to the scalp — a
clean, disciplined haircut with a compact rounded silhouette. Deliberately
NOT a big spiky puffy explosion of hair, NOT a flat side-parted style, NOT
long hair.
Clothing: a deep-purple padded sleeveless vest over a plain gray undershirt,
with hand-stitched dashed seams along the vest edges, and dark charcoal
long trousers (long trousers, sturdier than the others' shorts) with a
stitched hem. Tall brown leather lace-up boots with a folded cuff and
cross-hatch shading. Soft cross-hatched oval ground shadow beneath the feet,
otherwise empty background.
Weapon: a round wooden shield with a crude, childlike hand-drawn skull
emblem in deep-purple ink on its face, held up and forward at chest height
in a protective guarding stance; a short plain dagger in his other, lowered
hand, held low and NOT raised to strike.
--ar 2:3 --style raw --no gradient, glossy, shiny, glow, realistic face, cel-shading, background scenery, front view, facing viewer, standing at attention, walking pose, mid-stride, feet together, attacking pose, lunging, spiky puffy explosion hair, side-parted hair, long hair, skinny, petite, slender, average build, girl, feminine, adult
```

**调整建议**：
- 三人若还像"同一身体换色"，先确认三件套读出来没：他明显最高最壮、占地面最宽？双脚叉开钉住（对比苏远缩成一团、李川在走）？寸头（对比另两人）？缺哪个补哪个，别加背带/护具凑数。
- 身高/体型差不够就加 `broad shoulders, stocky, towering over an average child, chubby sturdy build`；盾纹太精致跳风格就加 `simple crude childlike hand-drawn skull, minimal detail on shield`。
- 体型"最壮"和苏远"最瘦"一样，单图难自证，最终以三人并排比对为准。

---

## Anna 阵营皮肤：共用地基与踩坑（2026-07-26）

Anna 三人（Lena/Mara/Max）不套用上面 Tao 侧的"共用前缀"——那条前缀锁的是**大圆头+两点眼+无鼻无嘴**的简笔卡通脸，是涛方专属画风；Anna 阵营角色卡本身就是写实五官（见 `ANNA_CHARACTERS.md`），皮肤延续写实脸，不改成卡通脸。三人共用的是下面这几条：

- **配色按稀有度走官方公式，不按角色个人色**：皮肤的"紫/金"来自 `EQUIPMENT_DESIGN.md` 已定的稀有度双色公式（epic = 荧光紫 `#aa55cc` + 烫金 `#d9b44a`；legendary 本文取金米 `#C9A227`+`#F0E6C8`，比装备的橙 `#e08a2c` 更暖，是皮肤文档自己的既定基调，见进度表），不是 `ANNA_CHARACTERS.md` 里三人各自的私有蓝色调——这样同稀有度的皮肤（Lena/Mara 都是 epic）天然配色统一，区分度全靠体型/站姿/道具/发型，和 Tao 侧"用职业道具+体型站姿区分"是同一个方法论。
- **每人身上留一处冷色点缀**（Max 胸口蓝钻、Mara 手腕蓝绳），呼应"仍是蓝方阵营成员"——皮肤换色但不脱队。
- **"精致一档"不等于可以数码渲染**：皮肤 tier 的 prompt 要求"clean ink, not sketchy-wobbly"，比角色卡的抖动铅笔线更干净，但**去掉抖动线这道天然刹车后，AI 会直接冲向专业幻想原画的抛光金属/渐变高光**（Max v1、Mara v1 都踩了这个坑——盔甲镜面反光、皮革渐变光泽）。**每次都要显式写"flat matte, no gradient, no glossy sheen"，而且要点名到每个部件**（Max v1 漏了这句导致全身反光；Mara v1 只在上衣提了平涂，裤子/靴子没提名，照样长出了光泽感）——不能指望一句笼统的"matte overall"能兜住全身。
- **女性角色要显式写"实用/非性感化"**：Mara v1 出来是收腰胸衣式紧身皮衣+低胸开领+高跟靴，偏时装猎手而非实用猎手，也踩了 `ANNA_CHARACTERS.md` 给 Lena 定过的红线（负向提示 `sexualized, revealing armor`——这条对全阵营通用，游戏全年龄向）。v2 改成"立领扣到底、不露领口、平底靴"才收回来。
- **头盔/面部遮挡类道具要写清楚"哪部分必须露脸"**：Max v1 给了全罩盔（面部虽然露出但不是"面罩上翻"那个读法），v2 明确写"开面盔+前段面罩掀起、额头到下巴全露"才对上他的标志性半开面罩。
- **佩剑等"入鞘不用"的副武器要显式写"完全被剑鞘遮住，不露刃"**：Lena v1 只写了"短剑挂腰间，未拔出"，出来是一截贴腿垂下的长条渐变银紫色刀刃状物体，像没入鞘的长剑；v2 加上"opaque scabbard fully conceals the blade, no visible blade/metal, reaching only to mid-thigh"才收成正常的入鞘佩剑。

---

## 4. `skin_l1` — Anna·Max（legendary，金米调）✅ 已出图

**人设参照**（`ANNA_CHARACTERS.md` Max）：独行骑士，半开面罩露出冷静的眼睛，单手阔剑不持盾，一击而定。旗舰皮肤主题定调见 [`gacha-art-prompts.md`](gacha-art-prompts.md)：`a majestic armored commander with gold ink details`，金米色调。辨识特征保留：①半开面罩露脸；②单手阔剑垂地待发姿态；③空手无盾。新增旗舰元素：奶白滚金披风；胸甲留一颗小蓝钻作为"仍属蓝方"的锚点（配色本身已全面转金米，不再是他角色卡的冷钢蓝）。

> 2026-07-26 v2（可直接复制的完整版）：v1 用"clean ink not sketchy-wobbly"但没压住数码渲染倾向，出来是专业幻想游戏立绘级别的抛光镜面盔甲+渐变高光+过密蚀刻花纹，且头盔是全罩式而非"面罩上翻"。v2 在开头加"flat matte picture-book, not digital painting, not concept art"压顶句，逐部件重申"no gradient/no glossy"，收紧纹样密度，并把头盔明确写成"开面盔+前段面罩掀起"。

```
A full-length head-to-toe character illustration of a teenage boy knight standing in a confident three-quarter side view, his body turned about forty-five degrees so one shoulder faces the viewer, weight settled back on his rear leg in a calm, commanding stance rather than a crouched combat pose. This must read as a flat, matte, hand-drawn picture-book illustration, like ink-and-marker artwork in a notebook, absolutely not a digital painting, not professional fantasy concept art, not video game splash art, not a 3D render, and not a photorealistic or airbrushed image. He wears golden full plate armor made of flat faceted metal plates with sharp clean edges, colored in completely flat single-tone gold blocks with only a few simple hand-drawn cross-hatch pencil lines for shadow in the recessed corners — no gradients anywhere, no soft blending, no chrome-like mirror reflections, no bright specular highlight streaks, no glossy sheen of any kind on the metal, which should look as dull and matte as colored paper. Keep any etched trim minimal: a few simple repeated linear borders along the plate edges only, not dense ornamental engraving covering the surfaces. He wears an open-faced helmet with the front visor section fully flipped up above his brow, so his whole face from forehead to chin is plainly visible, not a closed helm, nothing obscuring any part of his face: a calm, serious, realistic European teenage boy face with a soft natural eye, light eyebrow, a small straight nose, and a tight closed mouth, short neat hair, ordinary grounded human proportions. A short cream-and-gold trimmed cape hangs from his shoulders in a few clean flat folds, colored as flat cream with simple hatch-line shading only, no fabric sheen. In his near hand he holds a single-handed broad straight steel sword with a gold-wrapped hilt and a gold cross-guard, the blade flat pale grey with hatch-line shading only and no shiny reflection, its tip resting on the ground in a quiet grounded stance. His other hand rests open and empty at his side, carrying no shield. Color palette is warm flat gold around hex C9A227 for the main armor plates, flat pale cream-ivory around hex F0E6C8 for the cape, flat deep bronze-brown around hex 6B4E1E used only as small hatch-shaded recesses, with one small flat cool steel-blue diamond gem around hex 6E8CAB set into the chest plate as his only cold-toned detail. A soft cross-hatched oval ground shadow sits beneath his boots. The background is plain clean white paper with only a faint paper texture, nothing else in frame. Full body visible from head to boots, centered and filling most of the frame, vertical portrait composition about a 2:3 ratio.
```

**调整建议**：若重出时又滑向抛光渲染，先检查是不是漏点了具体部位（"no gloss"必须点名到腿甲/靴子，不能只在开头笼统提一句）；若头盔又变回全罩式，加强"visor flipped up, whole face visible, NOT a closed grand helm"。

---

## 5. `skin_e2` — Anna·Mara（epic，紫色调）✅ 已出图

**人设参照**（`ANNA_CHARACTERS.md` Mara）：战场织网者，标记机制，眼神望向战场远处而非箭尖，弓半张但不急着射。辨识特征保留：①三人里最纤细高挑，长腿；②站姿松弛望远，非拉弓瞄准姿态；③松散波浪卷发半扎；④左手腕蓝绳缠三圈。配色改用 epic 官方双色公式（荧光紫 `#aa55cc` + 烫金 `#d9b44a`），不再是她角色卡的暖棕+天蓝。

> 2026-07-26 v2（可直接复制的完整版）：v1 配色/道具/姿态都对，但两处需要打回：① 裤子/靴子仍有数码渐变光泽（v1 的"no gloss"只写在上衣皮革那句里，没有点名裤子和靴子）；② 服装偏性感时装猎手——收腰胸衣式紧身剪裁+低胸开领+高跟及膝靴，踩了游戏全年龄向的红线（`ANNA_CHARACTERS.md` Lena 负向提示 `sexualized, revealing armor` 对全阵营通用）。v2 把领口改立领扣到底、靴子改平底，并把"no gradient/no gloss"扩展到裤子和靴子。

```
A full-length head-to-toe character illustration of a slender, tall young huntress standing in a light, poised three-quarter side view, her body turned about forty-five degrees so one shoulder faces the viewer, weight even between both feet, one foot set slightly forward in a calm, watchful stance rather than a drawn-bow action pose. This must read as a flat, matte, hand-drawn picture-book illustration, like ink-and-marker artwork in a notebook, absolutely not a digital painting, not professional fantasy concept art, not video game splash art, not a 3D render, and not a photorealistic or airbrushed image. She has an elongated, slender, elegant build with long legs, clearly the leanest and tallest silhouette of the three friends. She wears a practical, modest huntress outfit in flat deep-purple leather — a fitted but loose-cut jacket buttoned up to the collar with no exposed neckline or chest, straight-cut trousers, and flat-soled knee-high boots with no heel — colored in completely flat single-tone purple blocks with only simple hand-drawn cross-hatch pencil lines for shadow in the folds and seams, no gradients anywhere on the jacket, trousers, or boots, no soft blending, no glossy sheen or shine of any kind on the leather, which must look as dull and matte as colored paper across every part of the outfit including the legs and boots. Along the jacket edges, seams, belt, and boot tops runs a thin gilt-gold trim line with a few simple flat marker-drawn decorative flourishes — small hand-drawn curling vine-like linework, not dense embroidery, kept minimal and clean. A slim quiver of purple-and-gold fletched arrows sits diagonally across her back. Her face is calm, warm, and slightly wistful, a realistic young European woman's face with a soft natural eye, light eyebrow, a small straight nose and a gently closed mouth, her gaze lifted and looking off into the distance past the viewer rather than at anything close — watchful, reading the wider scene, not focused on a nearby target. Her hair is loose and wavy, half pulled back and half falling free, rendered with a few flowing hand-drawn ink strokes, no shine. Around her left wrist, wrapped three times, is a simple sky-blue cord, colored flat around hex 7EB5D6, her only cool-toned accent tying her back to the blue faction. In one hand she holds a slim recurve longbow at rest by her side, string slack and not drawn, the bow itself flat pale wood-brown with a gilt-gold wrapped grip, hatch-line shading only and no shine on the wood or string. Color palette is flat deep purple around hex 6B3F73 for the main leather, bright accent purple around hex AA55CC used sparingly on small trim details and buckles, gilt gold around hex D9B44A for the trim lines and grip, pale lavender-white around hex E4D6E8 for flat highlights, and deep plum-black around hex 3A2440 used only as small hatch-shaded recesses. A soft cross-hatched oval ground shadow sits beneath her boots. The background is plain clean white paper with only a faint paper texture, nothing else in frame — no scenery, no other characters, no text, no watermark. Full body visible from head to boots, centered and filling most of the frame, vertical portrait composition about a 2:3 ratio.
```

**调整建议**：Lena（`skin_e1`）出图时可直接复用这套 epic 紫金配色公式，靠体型（三人里最矮壮，圆盾+护具）/站姿（钉住不动）/发型（战辫）区分，不必重新试配色；同样要提防"clean ink"降低了对性感化剪裁和数码光泽的天然抵抗力，两条负向要求要显式写进去。

---

## 6. `skin_e1` — Anna·Lena（epic，紫色调）✅ 已出图

**人设参照**（`ANNA_CHARACTERS.md` Lena）：铁盾算法师，纪律减伤，钉在原地不动的盾卫。辨识特征保留：①三人里最矮壮，肩宽重心低；②站姿钉住不动，盾护身前；③无头盔、战辫；④副武器短剑入鞘挂腰，不是主战武器。配色改用 epic 官方双色公式（同 Mara，荧光紫 `#aa55cc` + 烫金 `#d9b44a`），盾心一颗小蓝宝石作为"仍属蓝方"的锚点。

> 2026-07-26 v2（可直接复制的完整版）：v1 盾牌几何格纹+无头盔+站姿+配色全部一次命中，唯独佩剑翻车——只写"未拔出"不够，出来是一截贴腿垂下的渐变银紫刀刃状物体，读起来像没入鞘的长剑。v2 把佩剑那句改成"入鞘完全遮住刀刃、长度到大腿附近、只露剑柄"，其余不变。

```
A full-length head-to-toe character illustration of a sturdy young woman warrior standing in a firm, grounded three-quarter side view, her body turned about forty-five degrees so one shoulder faces the viewer, feet planted a little more than shoulder-width apart, weight low and centered, rooted in place like she is not going anywhere — a calm, immovable defensive stance, not walking, not mid-stride, not an attacking pose. This must read as a flat, matte, hand-drawn picture-book illustration, like ink-and-marker artwork in a notebook, absolutely not a digital painting, not professional fantasy concept art, not video game splash art, not a 3D render, and not a photorealistic or airbrushed image. She has a sturdy, broad-shouldered build with a low, solid center of gravity — noticeably broader and shorter than a willowy figure, reading as the sturdiest and most grounded of the three friends, not slender, not delicate. She wears practical chainmail and leather armor — a fitted mail hauberk over a padded underlayer, sturdy leather leg wraps, and flat-soled leather boots — fully covering her from neck to boots with no exposed midriff or chest, colored in completely flat single-tone purple blocks with only simple hand-drawn cross-hatch pencil lines suggesting the texture of the mail links and leather folds, no gradients anywhere on the armor, leggings, or boots, no soft blending, no glossy sheen or metallic shine of any kind, which must look as dull and matte as colored paper across every part of her outfit. Along the armor edges, belt, and boot cuffs runs a thin gilt-gold trim line with a few simple flat marker-drawn decorative flourishes, kept minimal and clean, not dense embroidery. Her hair is pulled back into a tight, neat war braid at the nape of her neck, no helmet, her whole face plainly visible: a calm, composed, realistic young European woman's face with a soft steady eye, light eyebrow, a small straight nose, and a calm closed mouth, an expression of quiet confidence, not smiling, not fierce. In front of her torso she holds a large round shield up at a calm, steady angle, the shield face a flat deep-purple with a fine gilt-gold geometric grid pattern etched across it like an engineering diagram, flat rivets along the rim, a small cool steel-blue gem set at the very center of the shield boss as her only cold-toned accent tying her back to the blue faction. A short plain sword hangs at her hip, fully hidden inside an opaque solid-color scabbard that completely conceals the blade — no visible blade, no exposed metal — the scabbard reaching only to about mid-thigh, clearly shorter than a longsword, with just the hilt and cross-guard visible above the scabbard's mouth, not drawn, not held, not touching her hand. Color palette is flat deep purple around hex 6B3F73 for the main armor, bright accent purple around hex AA55CC used sparingly on small trim details and the shield's grid lines, gilt gold around hex D9B44A for the trim and rivets, pale lavender-white around hex E4D6E8 for flat highlights, and deep plum-black around hex 3A2440 used only as small hatch-shaded recesses. A soft cross-hatched oval ground shadow sits beneath her boots. The background is plain clean white paper with only a faint paper texture, nothing else in frame — no scenery, no other characters, no text, no watermark. Full body visible from head to boots, centered and filling most of the frame, vertical portrait composition about a 2:3 ratio.
```

**六款上线皮肤（`GACHA_DESIGN.md §9.5`）全部出图定稿**，三人并排比对若发现体型区分度不够（Lena 矮壮 vs Mara 纤细高挑 vs 涛方三兄弟的身高梯度），再回头加强 build 描述；否则可以进入"出图后流程"。

---

## 出图后流程

1. 挑 4 变体里线条最干净、色块边界最清楚的一张，同名存入 `art/skins/`（文件名任意，非接线路径，纯素材库）。
2. GIMP 按骨架部位切件（头/躯干/上臂/前臂/大腿/小腿×2 侧），参照 `art/units/archer/`、`art/units/shieldbearer/` 现有分层的命名规则（`head.png` / `arm-left-up.png` / `leg-right-down.png` 等）。
3. animator 绑骨，`Skin` 模式挂到对应基础骨架（`archer.tao` / `shieldbearer.tao`）上，导出 `.tao`。
4. `UnitView.ts` `SKIN_ASSETS` 填入资产路径，`shop.ts` `SKIN_PLACEHOLDER_ART` 换成真实贴图 URL（详见 `GACHA_DESIGN.md` 2026-07-16 补充条目）。
