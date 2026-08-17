# 角色卡 — 涛阵营英雄：穷奇（铁甲兵）/ 獬豸（跑兵）

> 从 [`CHARACTER_DESIGN.md`](CHARACTER_DESIGN.md) 拆出（2026-08-17，原文件 878 行）。**小节编号沿用原文**，`CHARACTER_DESIGN.md §N` 引用照旧有效。
> 本册内容：§7.6 的前两个具名英雄：背景 + 视觉 + 出图 prompt。总览与在先小节见 [`CHARACTER_DESIGN.md`](CHARACTER_DESIGN.md)。

---

#### 穷奇（铁甲兵 Ironclad）

**神话原型**：山海经异兽，传说性情暴虐、见人相斗则助强凌弱——本设计**反写**这层暴虐：不是它天性如此，是它欠了一笔债，替方家挡着，仅此而已。

**定位**：XL 巨型 · 最重坦 / 破墙顶（hp290 / armor3 / 慢速抗箭重甲，siege15，费用8，见 §5/§5.1）。

**出身**：方家外门镇守多少代都说不清，只知道传下来一句话——"穷奇欠方家一条命"。相传某代方家先祖濒死之际，以自己性命换它出手救了满门，从那以后它就没走，蹲在外门，谁进方家的门都得先过它这一关。它不算被驯服，方家上下心里都清楚：**它不是听谁的话，它是在还债**。债还完那天会怎样，没人敢问，也没人问过它。

**性格**：话（如果算它能说话）极少，多数时候闭着一只眼打盹，另一只眼永远睁着，盯着门口方向。移动慢得像在犹豫要不要动，可一旦真动了，什么都拦不住——这不是它天性凶暴，是它算准了"这一下必须够"，不做无用的动作。它对小学员没有恶意，甚至会在他们绕远路躲它的时候，故意把巨大的身子往旁边挪半步，让路更好走一点，然后继续装作没看见。

**关系**：暂不定（见 §7.6 前言）。留一个可能性：它见过陈守小时候一个人练站桩到天黑，多蹲了半夜没走，谁也没证实过这件事。

**它自己都没想过的事**：债到底是什么，它已经记不清最初的具体样子了，只记得"欠"这个感觉本身——这感觉比记忆本身活得还久。

**视觉方案**：
- **风格**：沿用涛阵营"单色圆珠笔火柴人 plus"语言（`infantry.png` 同源：空心管状肢体+圆形关节+大圆头单点眼），但骨架从人形改为**双足重甲异兽**——不是人套着甲，是异兽本身的躯体。
- **体型**：XL，明显碾压人类少年一档（`art-direction.md` §4.5.1），躯干宽厚、四肢粗短有力，重心极低。
- **识别特征（≤2）**：① 一对外露獠牙（口部两侧微微探出）；② 背部一撮火焰状鬃毛（穷奇传说带翼，简化为鬃毛以控制细节量，保留"凶兽"辨识度而不加飞行联想）。
- **甲纹**：躯干+四肢覆盖交叉排线（hatching）代表厚甲鳞片，笔触比人形单位更密更重，视觉上"扛揍"。
- **朝向/染色**：同全体单位规范，侧视朝右，中性线稿+运行时 faction tint（蓝）。

**出图 prompt**（沿用 `art-direction.md` §6.2 共用前缀语域，改写为单位专属主体；**v3 定稿，2026-07-02**——前两版因"猩猩式四点站姿/前肢触地重叠""举手打招呼像卡通萌兽"两轮反馈迭代，本版已出图确认解决绑骨可行性+人设气质，见对话记录）：
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick but deliberate sketch. A hollow tube-limbed beast
character built from rounded pipe-like limb segments and circle joints,
same construction language as a stick-figure soldier but reshaped into a
squat two-legged armored monster standing UPRIGHT on two thick hind legs
only, torso mostly vertical with only a slight forward lean (like a heavy
bodybuilder's stance, NOT bent over, NOT on all fours, NOT knuckle-walking).
The two hind legs are clearly separated side by side, weight balanced evenly
between them, both feet flat on the ground. Two short stubby forearms are
held up near the chest, bent at the elbow, ending in simple clenched
fist-like paws held in a guarded boxer stance — each paw is a rounded blunt
mitt with only two or three short stubby claw tips, NOT a detailed human
hand, NOT an open palm, NOT spread fingers, calm and still, not waving, not
greeting. The forearms are clearly lifted OFF the ground, not touching it,
not used for walking, not overlapping each other or the legs. A large round
head with a single dot eye positioned toward the facing direction, calm
half-lidded sleepy expression. Two small tusks protrude from the sides of
its mouth. A tuft of flame-shaped mane spikes runs along its back and spine.
Dense cross-hatching pencil texture covers the torso and limbs suggesting
thick armored scales. Neutral relaxed idle stance suitable as a rigging
reference pose, side profile view, facing right, every limb segment clearly
separated with no overlapping or crossing limbs, no foreshortening.
Isolated single character, centered, on a plain pure-white background, no
grid lines, no other elements. Flat 2D, no 3D, no gradients, no glossy
highlights, no thick cartoon outline, no color fill (line art only, to be
tinted programmatically). Style of West of Loathing / doodle art.
```
负向：`color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, wings, human proportions, on all fours, knuckle-walking, hunched over, bent spine, overlapping limbs, crossed arms, arms touching ground, dynamic action pose, three-quarter view, detailed human fingers, open palm, waving gesture, spread fingers, cheerful expression`

> **出图状态**：✅ 已出图确认（2026-07-02），可进入 GIMP 抠件 → animator 绑骨流程。

---

#### 獬豸（跑兵 Runner）

**神话原型**：山海经异兽，传说能辨是非曲直、见人争讼便以角触不直者——本设计取"管闲事"这层性格，弱化"司法审判"的沉重感，落成一只**沉不住气的幼兽**。

**定位**：S 小型 · 快速脆皮群冲（hp30 快脆冲锋，siege6，费用3，见 §5/§5.1）。

**出身**：方家训练场里养了不知道多少代的"活哨兵"，个头一直没怎么长大过——或许这本就是它的形态，或许是训练场的伙食一直没给够。学员们打闹拌嘴时，它总是场上第一个冲过去的，与其说是执法辨曲直，不如说它单纯闲不住、见着动静就要插一脚。方家没人正式驯养过它，它自己赖着不走，理由大概是"这里热闹"。

**性格**：急、闲不住、管不住自己的腿——谁被欺负了，它不问缘由第一个冲上去，冲完才想起来自己好像还没搞清楚谁对谁错。它跑得比谁都快，可也是三个孩子（李川陈守苏远）眼里"最沉不住气"的那个，训练时最先撑不住喊停的常常是它，不是没力气，是没耐心。

**关系**：暂不定（见 §7.6 前言）。留一个可能性：李川私下觉得獬豸跟自己是同一种毛病——都是"停不下来"，只是李川停不下来的是嘴，它停不下来的是腿。

**它自己都没想过的事**：它总冲第一个，却从没问过自己冲过去之后要做什么——通常是冲到了才现想。

**视觉方案**：
- **风格**：同穷奇，沿用管状肢体+圆形关节语言，骨架为**小型四足独角兽形异兽**（幼兽体态，非人形）。
- **体型**：S，全场最小最矮，四肢管状结构刻意拉长纤细，突出"快"而非"壮"。
- **识别特征（≤2）**：① 头顶一根短直角（獬豸标志性单角）；② 尾巴竖起呈问号状卷曲（暗示"急躁""随时要冲"的姿态）。
- **姿态**：与其余复用兵一致，走中性站立 rigging reference pose（四肢分离、不重叠），"急躁欲冲"的性格交给 animator 骨骼动画表现，不在静态图里强凹姿势。
- **朝向/染色**：同规范，侧视朝右，中性线稿+运行时 faction tint。

**出图 prompt**（定稿，2026-07-02，与穷奇同一"neutral rigging reference pose"逻辑：静态图定骨架站姿，急躁性格交给 animator 骨骼动画表现）：
```
Messy hand-drawn doodle scribbled in the margin of a worn school notebook,
single dark-ink ballpoint pen line art, visibly rough and wobbly imperfect
strokes with slight overshoot at line ends and small double-lined
correction marks, like a bored teenager quickly sketching during class —
NOT clean, NOT precise, NOT a smooth vector line. A small hollow
tube-limbed beast character built from rounded pipe-like limb segments and
circle joints, same construction language as a stick-figure soldier but
reshaped into a tiny four-legged unicorn-like creature: a compact stocky
body held low and close to the ground, noticeably smaller and shorter than
a human-sized character, a round head with a single dot eye positioned
toward the facing direction, alert and eager expression. A single short
straight horn sits on top of its head. Its tail curls upward into a tight
question-mark shape, alert and twitchy.

POSE: neutral relaxed standing stance suitable as a rigging reference
pose, all four legs standing normally on the ground with even weight,
front pair of legs and back pair of legs each clearly separated side by
side, all four legs straight and simply planted (not bent into a crouch,
not gathered together, not overlapping or crossing each other, not
mid-stride, not a walking gait). Ears slightly forward and tail held
alert to suggest a restless, itching-to-move temperament, but the body
pose itself stays calm and static like a T-pose reference.

Every limb segment clearly separated with no overlapping or crossing
limbs, no foreshortening, suitable as a rigging reference pose. Side
profile view, facing right. Isolated single character, centered, on a
plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline, no
color fill (line art only, to be tinted programmatically). Style of West
of Loathing / doodle art.
```
负向：`clean vector, smooth lines, 3d render, photorealistic, color fill, painterly, shading gradient, thick bold outline, crouching pose, bent legs, gathered legs, legs pulled under body, overlapping limbs, crossed limbs, foreshortening, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, walking gait, mid-stride, three-quarter view`

> **出图状态**：✅ 已出图确认（2026-07-02），可进入 GIMP 抠件 → animator 绑骨流程。**⚠️ 2026-07-29 用户截图反馈**：实机里这只兽近乎纯白、糊进纸色背景看不清——v1 prompt 从没要求排线阴影（对比穷奇 prompt 里明确写了"Dense cross-hatching pencil texture..."），只有细描边，墨线密度跟同阵营其它兵种不一致。**需要重新出图**，见下方 v2 修订版（补齐排线，其余不变）。

**出图 prompt v2**（2026-07-29 修订，仅补齐排线阴影密度，姿态/构造/风格描述不变）：
```
Messy hand-drawn doodle scribbled in the margin of a worn school notebook,
single dark-ink ballpoint pen line art, visibly rough and wobbly imperfect
strokes with slight overshoot at line ends and small double-lined
correction marks, like a bored teenager quickly sketching during class —
NOT clean, NOT precise, NOT a smooth vector line. A small hollow
tube-limbed beast character built from rounded pipe-like limb segments and
circle joints, same construction language as a stick-figure soldier but
reshaped into a tiny four-legged unicorn-like creature: a compact stocky
body held low and close to the ground, noticeably smaller and shorter than
a human-sized character, a round head with a single dot eye positioned
toward the facing direction, alert and eager expression. A single short
straight horn sits on top of its head. Its tail curls upward into a tight
question-mark shape, alert and twitchy.

Dense cross-hatching pencil shading covers the torso, haunches and all
four legs, giving the fur a richly inked, textured look with the same
heavy ink density as the game's other stick-figure units — NOT a thin bare
outline, NOT a sparsely-lined empty silhouette.

POSE: neutral relaxed standing stance suitable as a rigging reference
pose, all four legs standing normally on the ground with even weight,
front pair of legs and back pair of legs each clearly separated side by
side, all four legs straight and simply planted (not bent into a crouch,
not gathered together, not overlapping or crossing each other, not
mid-stride, not a walking gait). Ears slightly forward and tail held
alert to suggest a restless, itching-to-move temperament, but the body
pose itself stays calm and static like a T-pose reference.

Every limb segment clearly separated with no overlapping or crossing
limbs, no foreshortening, suitable as a rigging reference pose. Side
profile view, facing right. Isolated single character, centered, on a
plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline, no
color fill (line art only, to be tinted programmatically). Style of West
of Loathing / doodle art.
```
负向：`clean vector, smooth lines, 3d render, photorealistic, color fill, painterly, shading gradient, thick bold outline, crouching pose, bent legs, gathered legs, legs pulled under body, overlapping limbs, crossed limbs, foreshortening, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, walking gait, mid-stride, three-quarter view, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v2 已出图确认可读（补齐排线后跟纸色背景对比度足够），**但用户反馈媒材跟穷奇撞了**（同样是铅笔+网格厚涂，六个复用兵不该全长一个质感，§7.4 已改为按角色分媒材）。**改用黑墨水钢笔重新出图**，见下方 v3（换媒材，姿态/构造不变，不再用铅笔排线，改钢笔本身的线宽/浓淡对比给视觉重量；避开蓝/红钢笔墨水，两色是阵营专属语义 `art-direction.md §3.2`）。

**出图 prompt v3**（2026-07-29 修订，铅笔厚涂 → 黑墨水钢笔，姿态/构造/识别特征不变）：
```
Messy hand-drawn doodle scribbled in the margin of a worn school notebook,
drawn with a BLACK INK FOUNTAIN PEN — NOT pencil, NOT graphite: confident
bold wet-ink strokes with slightly varying line weight (thicker where the
nib presses down, thinner on quick flicks), small ink blots and a couple
of tiny smudges where the pen dragged, crisp and dark rather than grainy
or hatchy. Visibly rough and wobbly imperfect strokes with slight
overshoot at line ends and small double-lined correction marks, like a
bored teenager quickly sketching during class — NOT clean, NOT precise,
NOT a smooth vector line. A small hollow tube-limbed beast character built
from rounded pipe-like limb segments and circle joints, same construction
language as a stick-figure soldier but reshaped into a tiny four-legged
unicorn-like creature: a compact stocky body held low and close to the
ground, noticeably smaller and shorter than a human-sized character, a
round head with a single dot eye positioned toward the facing direction,
alert and eager expression. A single short straight horn sits on top of
its head. Its tail curls upward into a tight question-mark shape, alert
and twitchy.

Shading is built from solid black ink fills and a few bold parallel pen
strokes in the deepest shadow pockets (underside of the belly, inner
joints) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense. Overall ink
density should feel closer to a fountain-pen sketch than a pencil study —
NOT a thin bare outline, NOT a sparsely-lined empty silhouette either.

POSE: neutral relaxed standing stance suitable as a rigging reference
pose, all four legs standing normally on the ground with even weight,
front pair of legs and back pair of legs each clearly separated side by
side, all four legs straight and simply planted (not bent into a crouch,
not gathered together, not overlapping or crossing each other, not
mid-stride, not a walking gait). Ears slightly forward and tail held
alert to suggest a restless, itching-to-move temperament, but the body
pose itself stays calm and static like a T-pose reference.

Every limb segment clearly separated with no overlapping or crossing
limbs, no foreshortening, suitable as a rigging reference pose. Side
profile view, facing right. Isolated single character, centered, on a
plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline, no
color fill (monochrome black ink line art only, to be tinted
programmatically — the ink itself must be neutral black, NOT blue, NOT
red). Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, colored ink, clean vector, smooth lines, 3d render, photorealistic, color fill, painterly, shading gradient, thick bold outline, crouching pose, bent legs, gathered legs, legs pulled under body, overlapping limbs, crossed limbs, foreshortening, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, walking gait, mid-stride, three-quarter view, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v3 黑墨水钢笔已出图确认（线稿本身干净利落，跟穷奇的铅笔厚涂拉开了媒材区别），**但用户反馈缩小到实战尺寸后纯黑线稿还是容易糊进纸色背景**——静态参考图放大看没问题，但战场上单位实际渲染高度只有 ~46px（S 档，`unitSize.ts`），细线在这个尺寸下抗锯齿糊掉，色相对比比线条粗细更扛缩小。**改为给识别特征上色**：獬豸的独角+问号尾巴（§7.6"识别特征≤2"那两个）改用**青色马克笔**上色，跟"马克笔色块只做克制的功能点缀"的既有规则（`art-direction.md §3.2`：武器/盾面）同源扩展到这两个识别特征上；青色避开已被占用的蓝(我方)/红(敌方)/黄(警告)/橙(选中)/灰(禁用)/紫(装备 epic 稀有度，`EQUIPMENT_DESIGN.md`)。见下方 v4（其余构造/姿态/黑墨水钢笔线稿不变，只加这两处色块）。

**出图 prompt v4**（2026-07-29 修订，独角+尾巴改青色马克笔上色，其余同 v3）：
```
Messy hand-drawn doodle scribbled in the margin of a worn school notebook,
drawn with a BLACK INK FOUNTAIN PEN — NOT pencil, NOT graphite: confident
bold wet-ink strokes with slightly varying line weight (thicker where the
nib presses down, thinner on quick flicks), small ink blots and a couple
of tiny smudges where the pen dragged, crisp and dark rather than grainy
or hatchy. Visibly rough and wobbly imperfect strokes with slight
overshoot at line ends and small double-lined correction marks, like a
bored teenager quickly sketching during class — NOT clean, NOT precise,
NOT a smooth vector line. A small hollow tube-limbed beast character built
from rounded pipe-like limb segments and circle joints, same construction
language as a stick-figure soldier but reshaped into a tiny four-legged
unicorn-like creature: a compact stocky body held low and close to the
ground, noticeably smaller and shorter than a human-sized character, a
round head with a single dot eye positioned toward the facing direction,
alert and eager expression.

A single short straight horn sits on top of its head, colored solid in a
bright TEAL/CYAN marker/highlighter tone — the only colored element on
the horn, filled flat with no gradient, like a kid went over just that one
detail with a teal highlighter pen. Its tail curls upward into a tight
question-mark shape, alert and twitchy, ALSO colored solid teal/cyan the
same shade as the horn — the rest of the body stays plain black-ink line
art, only the horn and tail carry color, everything else uncolored.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (underside of the
belly, inner joints) — NOT pencil cross-hatching, NOT a grainy graphite
texture. The outline itself is thick and saturated enough to read clearly
on its own, so shading stays sparse and confident rather than dense.

POSE: neutral relaxed standing stance suitable as a rigging reference
pose, all four legs standing normally on the ground with even weight,
front pair of legs and back pair of legs each clearly separated side by
side, all four legs straight and simply planted (not bent into a crouch,
not gathered together, not overlapping or crossing each other, not
mid-stride, not a walking gait). Ears slightly forward and tail held
alert to suggest a restless, itching-to-move temperament, but the body
pose itself stays calm and static like a T-pose reference.

Every limb segment clearly separated with no overlapping or crossing
limbs, no foreshortening, suitable as a rigging reference pose. Side
profile view, facing right. Isolated single character, centered, on a
plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline. Only
the horn and tail carry flat teal/cyan marker color — every other part of
the body is monochrome black ink line art, to be tinted programmatically
(that untinted part must be neutral black, NOT blue, NOT red). Style of
West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, colored body, full color fill, gradient on color fill, clean vector, smooth lines, 3d render, photorealistic, painterly, shading gradient, thick bold outline, crouching pose, bent legs, gathered legs, legs pulled under body, overlapping limbs, crossed limbs, foreshortening, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, walking gait, mid-stride, three-quarter view, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v4 已出图，用户反馈两处问题：① 青色实心块边缘太干净利落，像贴纸而非画面本身一部分——**改为在全身也扫一层淡青色荧光笔浅色，实心块只留给角+尾巴**，让整只兽的色调统一，不是孤立两个色点；② 耳朵画得不好看——排查发现是 prompt 自己的锅：POSE 段落里一直混进一句"Ears slightly forward..."（沿用了通用动物姿态模板，但主体描述从没定义过耳朵这个特征），模型据此一直在画耳朵。**v5 一并修**：去掉这句、明确写"无耳朵"，并补上全身浅青色荧光笔扫色。

**出图 prompt v5**（2026-07-29 修订，去掉误带的耳朵描述 + 全身加淡青色荧光笔浅扫，角/尾巴维持实心）：
```
Messy hand-drawn doodle scribbled in the margin of a worn school notebook,
drawn with a BLACK INK FOUNTAIN PEN — NOT pencil, NOT graphite: confident
bold wet-ink strokes with slightly varying line weight (thicker where the
nib presses down, thinner on quick flicks), small ink blots and a couple
of tiny smudges where the pen dragged, crisp and dark rather than grainy
or hatchy. Visibly rough and wobbly imperfect strokes with slight
overshoot at line ends and small double-lined correction marks, like a
bored teenager quickly sketching during class — NOT clean, NOT precise,
NOT a smooth vector line. A small hollow tube-limbed beast character built
from rounded pipe-like limb segments and circle joints, same construction
language as a stick-figure soldier but reshaped into a tiny four-legged
unicorn-like creature: a compact stocky body held low and close to the
ground, noticeably smaller and shorter than a human-sized character, a
round bald head with NO ears, NO ear tufts, NO pointed ears anywhere on
it — smooth and rounded like the other stick-figure units' heads — with a
single dot eye positioned toward the facing direction, alert and eager
expression.

A single short straight horn sits on top of its head, colored solid in a
bright TEAL/CYAN marker/highlighter tone — fully solid and opaque, no
gradient, the strongest color note in the piece. Its tail curls upward
into a tight question-mark shape, alert and twitchy, ALSO colored fully
solid teal/cyan the same shade as the horn.

In addition, a very light, faint, semi-transparent wash of that same
teal/cyan highlighter color is brushed loosely over the ENTIRE body —
torso, all four legs, head — like a highlighter pen skimmed lightly and
unevenly across the whole already-inked drawing: low-opacity, streaky,
uneven coverage that lets the black ink linework and shading underneath
stay fully legible. This faint all-over wash is much lighter and lower-
opacity than the solid horn and tail, so the horn and tail still read as
the strongest color accent, but the whole figure now carries a consistent
pale teal cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (underside of the
belly, inner joints) — NOT pencil cross-hatching, NOT a grainy graphite
texture. The outline itself is thick and saturated enough to read clearly
on its own, so shading stays sparse and confident rather than dense.

POSE: neutral relaxed standing stance suitable as a rigging reference
pose, all four legs standing normally on the ground with even weight,
front pair of legs and back pair of legs each clearly separated side by
side, all four legs straight and simply planted (not bent into a crouch,
not gathered together, not overlapping or crossing each other, not
mid-stride, not a walking gait). Tail held alert and slightly twitchy to
suggest a restless, itching-to-move temperament, but the body pose itself
stays calm and static like a T-pose reference.

Every limb segment clearly separated with no overlapping or crossing
limbs, no foreshortening, suitable as a rigging reference pose. Side
profile view, facing right. Isolated single character, centered, on a
plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid teal/cyan on the horn and tail, and a faint uneven teal wash
over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`ears, ear tufts, pointed ears, cat ears, animal ears, pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, clean vector, smooth lines, 3d render, photorealistic, painterly, shading gradient, thick bold outline, crouching pose, bent legs, gathered legs, legs pulled under body, overlapping limbs, crossed limbs, foreshortening, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, walking gait, mid-stride, three-quarter view, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：✅ v5 已出图确认定稿（2026-07-29），可进入 GIMP 抠件 → animator 绑骨流程。

---


---

**接下页** → [`CHARACTER_DESIGN_HEROES_MEDIC.md`](CHARACTER_DESIGN_HEROES_MEDIC.md)：§7.6 的第三个具名英雄：背景 + 视觉 + 出图 prompt。
