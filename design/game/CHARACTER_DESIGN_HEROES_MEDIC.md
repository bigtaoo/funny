# 角色卡 — 涛阵营英雄：卫安（医疗兵）

> 从 [`CHARACTER_DESIGN.md`](CHARACTER_DESIGN.md) 拆出（2026-08-17，原文件 878 行）。**小节编号沿用原文**，`CHARACTER_DESIGN.md §N` 引用照旧有效。
> 本册内容：§7.6 的第三个具名英雄：背景 + 视觉 + 出图 prompt。总览与在先小节见 [`CHARACTER_DESIGN.md`](CHARACTER_DESIGN.md)。

---

#### 卫安（医疗兵 Medic）

**神话原型**：无——刻意"无神话包袱"，作为方家侧唯一纯人类支援位，补足六人里此前缺的"随军医官"定位。

**定位**：M 普通 · 支援光环（hp90，PvP override attack4/interval1.2/range1，光环 hps8 半径2，siege4，费用6，见 §5/§5.1）。

**出身**：卫安家里三代都是随方家军队走的郎中，不是嫡系，也从没想过要往嫡系里挤。家训只有一句——"先看伤兵，再论输赢"。他没上过阵厮杀，但比谁都常听见濒死的人说的最后一句话；他自己说，正因为没打过仗，才更知道打仗是什么代价。

**性格**：话不多，但耐心；谁喊疼他先蹲下看伤口，看完了才回答别的问题。他对谁都一视同仁，不因为谁是嫡系就多看一眼，不因为谁是外围就少弯一次腰。他心里清楚自己打不过场上任何一个人，但也清楚——正因为有他在，别人才敢往前冲得更狠一点。

**关系**：暂不定（见 §7.6 前言）。留一个可能性：李川、陈守、苏远训练受伤，最后往往都是被拖去找卫安——三人私下都认他半个长辈半个自己人，他从不多问训练场上谁输谁赢，只问"伤在哪"。

**他现在还没想清楚的事**：他知道自己的价值是"让别人敢往前冲"，但偶尔会想，如果有一天没有人需要被治了，那自己算什么——这个问题他没敢深想。

**视觉方案**：
- **风格**：与李川/陈守/苏远同源——单色圆珠笔火柴人 plus 语言（空心管状肢体+圆形关节+大圆头单点眼），**人形**，成年体态（比三个孩子明显更宽更沉稳，但不到穷奇/獬豸那种异兽夸张度）。
- **体型**：M 普通档。
- **识别特征（≤2）**：① 背一个方形药箱（侧背带斜跨）；② 额头/手臂缠一道布条（战地包扎布，是他的"武器"——银针或绷带，非常规兵刃）。
- **姿态**：默认待机姿略含胸低头，像随时准备蹲下处理伤员，与三个少年昂首挺立的姿态形成对比。
- **朝向/染色**：同规范，侧视朝右，中性线稿+运行时 faction tint。

**出图 prompt**：
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick careless sketch. A hollow tube-limbed stick figure
character built from rounded pipe-like limb segments with circle joints at
each connection, a large round head with a single dot eye positioned
toward the facing direction, same construction language as a basic
soldier stick figure but adult proportions, sturdier and more settled than
a teenager, slightly hunched posture as if always ready to kneel down and
tend to someone. A square medicine satchel is slung across one shoulder
on a diagonal strap. A strip of bandage cloth is wrapped around his
forehead. No weapon, empty hands held forward as if about to bandage
something. Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (line art only, to be tinted
programmatically). Style of West of Loathing / doodle art.
```
负向：`color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions`

> **⚠️ 2026-07-29 用户截图反馈**：实机里几乎纯白、糊进纸色背景看不清——v1 prompt 同样没要求排线阴影，只有细描边。**需要重新出图**，见下方 v2 修订版（补齐排线，其余不变）。

**出图 prompt v2**（2026-07-29 修订，仅补齐排线阴影密度，姿态/构造/风格描述不变）：
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick careless sketch. A hollow tube-limbed stick figure
character built from rounded pipe-like limb segments with circle joints at
each connection, a large round head with a single dot eye positioned
toward the facing direction, same construction language as a basic
soldier stick figure but adult proportions, sturdier and more settled than
a teenager, slightly hunched posture as if always ready to kneel down and
tend to someone. A square medicine satchel is slung across one shoulder
on a diagonal strap. A strip of bandage cloth is wrapped around his
forehead. No weapon, empty hands held forward as if about to bandage
something.

Dense cross-hatching pencil shading covers the torso, sleeves and legs of
his coat, giving the clothing a richly inked, textured look with the same
heavy ink density as the game's other stick-figure units — NOT a thin bare
outline, NOT a sparsely-lined empty silhouette.

Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (line art only, to be tinted
programmatically). Style of West of Loathing / doodle art.
```
负向：`color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v2 已出图确认可读，**但用户反馈媒材跟穷奇撞了**（六个复用兵不该全是铅笔厚涂，§7.4 已改为按角色分媒材）。**改用黑墨水钢笔重新出图**，见下方 v3（换媒材，姿态/构造不变；避开蓝/红钢笔墨水，两色是阵营专属语义 `art-direction.md §3.2`）。

**出图 prompt v3**（2026-07-29 修订，铅笔厚涂 → 黑墨水钢笔，姿态/构造/识别特征不变）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. A square medicine satchel is slung across
one shoulder on a diagonal strap. A strip of bandage cloth is wrapped
around his forehead. No weapon, empty hands held forward as if about to
bandage something.

Shading is built from solid black ink fills and a few bold parallel pen
strokes in the deepest shadow pockets (under the satchel, inner elbow,
folds of the coat) — NOT pencil cross-hatching, NOT a grainy graphite
texture. The outline itself is thick and saturated enough to read clearly
on its own, so shading stays sparse and confident rather than dense.
Overall ink density should feel closer to a fountain-pen sketch than a
pencil study — NOT a thin bare outline, NOT a sparsely-lined empty
silhouette either.

Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (monochrome black ink line art only, to be
tinted programmatically — the ink itself must be neutral black, NOT blue,
NOT red). Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, colored ink, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v3 黑墨水钢笔已出图确认，**但用户反馈缩小到实战尺寸（M 档 ~54px，`unitSize.ts`）后纯黑线稿还是容易糊进纸色背景**——跟獬豸同一个问题（色相对比比线条粗细更扛缩小）。**改为给识别特征上色**：卫安的药箱+十字标志、额头布条改用**绿色马克笔**上色（医疗主题色，跟"马克笔色块只做克制的功能点缀"的既有规则同源扩展，`art-direction.md §3.2`）；绿色避开蓝(我方)/红(敌方)/黄(警告)/橙(选中)/灰(禁用)/紫(装备 epic 稀有度)。见下方 v4（其余构造/姿态/黑墨水钢笔线稿不变，只加这两处色块）。

**出图 prompt v4**（2026-07-29 修订，药箱+十字+布条改绿色马克笔上色，其余同 v3）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. No weapon, empty hands held forward as if
about to bandage something.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone,
flat with no gradient. A strip of bandage cloth is wrapped around his
forehead, ALSO colored solid green, the same shade as the satchel — the
rest of the body stays plain black-ink line art, only the satchel and the
forehead bandage carry color, everything else uncolored.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline. Only
the satchel and forehead bandage carry flat green marker color — every
other part of the body is monochrome black ink line art, to be tinted
programmatically (that untinted part must be neutral black, NOT blue, NOT
red). Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, colored body, full color fill, gradient on color fill, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v4 已出图，同獬豸一样反馈"色块边缘太干净像贴纸"——**改为在全身也扫一层淡绿色荧光笔浅色，实心块只留给药箱+十字+布条**，思路与獬豸 v5 一致（见上，同一原因：色相对比比线条粗细更扛缩小，但孤立的两块纯色实心块本身跟手绘线稿材质不符）。医生没有耳朵这类误带的问题，v5 只改上色部分。

**出图 prompt v5**（2026-07-29 修订，全身加淡绿色荧光笔浅扫，药箱/十字/布条维持实心）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. No weapon, empty hands held forward as if
about to bandage something.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v5 上色效果确认可用，**但用户指出一个更根本的问题**：`medic.png` 这张图不只是 animator 绑骨参考图，`cardArt.ts` 里它**直接就是玩家在手牌/图鉴看到的卡面**——跟步兵/穷奇/獬豸这些卡面比，v5 出的是弓步前倾、单脚跨步的动态姿势，而其余卡面都是双脚平稳站定的中性站姿，摆在同一个手牌栏里会显得不统一。**v6 只改姿态**：双脚改回均匀站立（不跨步），保留上身含胸低头这个性格细节，上色部分不变。

**出图 prompt v6**（2026-07-29 修订，弓步跨步 → 双脚均匀站立，仅上身含胸低头，其余同 v5）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager. No weapon, empty hands held forward at waist
height as if about to bandage something.

POSE: neutral standing pose matching the game's other card portraits (a
calm soldier standing at ease) — both feet planted evenly on the ground
side by side, weight balanced evenly between them, NOT a lunge, NOT a
forward stride, NOT one foot stepping ahead of the other. The only
dynamic touch is the upper body: shoulders rounded forward and head tipped
down in a gentle hunch, as if always ready to kneel down and tend to
someone — but the legs and stance stay calm and grounded, not a dramatic
forward lean of the whole body.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`lunge, forward stride, one foot stepping ahead, uneven weight, dynamic action pose, mid-stride, walking gait, pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v6 站姿修正了，**但用户反馈传达的性格不对**——双手收在身前、头低垂，读出来是"做错事被抓的小孩"（怯懦/心虚），不是"随时准备照顾伤员"的专业医官。根因大概率是"empty hands held forward at waist height"这句被理解成了双手交握/缩在身前——那是防御性/紧张的肢体语言，跟"张开手伸向病人"的照护动作完全反着。**v7 只改手部描述**：明确写"双手分开、掌心向上/向外张开，向前下方伸，像正伸向倒地的伤员"，不是交握、不是缩在身前；姿态其余部分（双脚站定、上身含胸低头）不变。

**出图 prompt v7**（2026-07-29 修订，双手交握 → 双手分开张开伸向前下方，其余同 v6）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager. No weapon.

Both arms reach forward and slightly downward, held clearly APART from
each other and away from the torso — NOT clasped together, NOT touching
each other, NOT tucked in against the body. Both hands are open with
fingers/mitts spread, palms angled up and forward, like a caregiver
actively reaching out to steady or bandage a patient lying on the ground
in front of him — an attentive, purposeful, competent reaching gesture,
NOT a shy or bashful or nervous pose, NOT hands clutched together at the
waist, NOT hugging himself.

POSE: neutral standing pose matching the game's other card portraits (a
calm soldier standing at ease) — both feet planted evenly on the ground
side by side, weight balanced evenly between them, NOT a lunge, NOT a
forward stride, NOT one foot stepping ahead of the other. The upper body
leans forward slightly from the hips with shoulders and head tipped
forward and down toward where his reaching hands are pointing — an alert,
focused, caring expression, like he's intently watching what his hands are
doing, NOT a downcast or ashamed or withdrawn posture.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`clasped hands, hands together, hands touching each other, hands clutched at waist, hugging self, arms crossed, shy pose, bashful pose, nervous pose, ashamed pose, guilty pose, downcast eyes, withdrawn posture, lunge, forward stride, one foot stepping ahead, uneven weight, dynamic action pose, mid-stride, walking gait, pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：✅ v7 已出图确认定稿（2026-07-29），可进入 GIMP 抠件 → animator 绑骨流程。

---

**下一步**：涛侧（本节）+ Anna 侧（[`ANNA_CHARACTERS.md`](ANNA_CHARACTERS_MONSTERS.md#anna-阵营的三只怪物aello--björn--lerna)）六人设计均已定稿，等待用户一并过目。过目通过后：① §7.5 两项均已勾；② 排期出图（同 §0 资产分工走 AI 图 → GIMP 抠件 → animator 绑骨 → `.tao`）；③ 落 ADR（阵营归属+六个新命名角色，一次性记完，不分两次）。
