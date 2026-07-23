# 付费皮肤全彩立绘 — 图片生成 Prompt 文档

> 更新：2026-07-22
> 背景：`art-direction.md §9.1`（2026-07-02 拍板）——皮肤程序染色已失效，**一律走完整 `.tao`**，一款皮肤 = AI 出图 → GIMP 切件 → animator 绑骨 → 导出 `.tao`。上线只做 6 款，目录见 `GACHA_DESIGN §9.5` / `META_TASKS.md`。
> 同类文档：[`gacha-art-prompts.md`](gacha-art-prompts.md)（结果卡/边框/banner）· [`shop-art-prompts.md`](shop-art-prompts.md)（商店图标）——本文档专门管**皮肤本体的全身立绘**，风格比上述两份"课堂涂鸦"更精致一档（见下）。

---

## 进度

| 皮肤 id | 角色 / 兵种 | 稀有度 | 配色 | 状态 |
|---|---|---|---|---|
| `skin_shop_c1` | 李川 / Infantry | common | 灰白调 | ✅ 已出图定稿，[`art/skins/infantry.png`](../../art/skins/infantry.png)；§1 prompt 为此图基准 |
| `skin_shop_r1` | 苏远 / Archer | rare | 蓝色调 | ✅ 已出图定稿，[`art/skins/archer.png`](../../art/skins/archer.png)；§2 v3 prompt 命中（3/4 侧身回望 + 侧分短发 + 弓上弦） |
| `skin_shop_e1` | 陈守 / ShieldBearer | epic | 紫色调 | 🟡 已出图 [`art/skins/shieldbearer.png`](../../art/skins/shieldbearer.png)（§3 v2 prompt，体型/叉腿盾墙/寸头全中）；**留 1 项待调**：肤色偏深 + 黑卷发，与另两人（浅暖褐肤 + 棕发）不一致，破坏"方家三兄弟"读感，重出时加 `light warm tan skin matching his friends, brown hair not black` |
| `skin_e1` | Anna·Lena | epic | 紫色调 | 未开始 |
| `skin_e2` | Anna·Mara | epic | 紫色调 | 未开始 |
| `skin_l1` | Anna·Max | legendary | 金米调 | 未开始 |

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

## 出图后流程

1. 挑 4 变体里线条最干净、色块边界最清楚的一张，同名存入 `art/skins/`（文件名任意，非接线路径，纯素材库）。
2. GIMP 按骨架部位切件（头/躯干/上臂/前臂/大腿/小腿×2 侧），参照 `art/units/archer/`、`art/units/shieldbearer/` 现有分层的命名规则（`head.png` / `arm-left-up.png` / `leg-right-down.png` 等）。
3. animator 绑骨，`Skin` 模式挂到对应基础骨架（`archer.tao` / `shieldbearer.tao`）上，导出 `.tao`。
4. `UnitView.ts` `SKIN_ASSETS` 填入资产路径，`shop.ts` `SKIN_PLACEHOLDER_ART` 换成真实贴图 URL（详见 `GACHA_DESIGN.md` 2026-07-16 补充条目）。
