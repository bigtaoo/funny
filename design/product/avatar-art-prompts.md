# 玩家头像美术 — 图片生成 Prompt 文档

> 创建：2026-08-14
> 背景：现状审计——`preset` 8 张线稿图标里有 4 个 key/图案错位（`art/ui/head/pack_avatar_atlas.cjs` 的 `MAP`），且线稿*物件*（书/奖杯/城堡…）本来就不适合当"脸"；`hero`/`skin` 两类直接裁剪战斗/皮肤立绘，风格三套打架（涂鸦火柴人 vs 写实数位画），`skin` 页签还偷懒复用了 `hero` 的图（`avatar.ts` 从未接 `cardArt.ts` 的 `SKIN_PORTRAIT_ART`）；`equip`/`material` 两类语义最弱、还会随装备/材料更新持续追加。owner 拍板**一次性做到位，以后不用回头改这块**（2026-08-14 对话）。
> 同类文档：[`family-emblem-art-prompts.md`](family-emblem-art-prompts.md)（同一批量出图+接入的文档格式）· [`skin-art-prompts.md`](skin-art-prompts.md)（6 位角色的体型/站姿/发型/道具人设，本文档的 `hero` 类目直接复用其人设结论）· [`characters.md`](characters.md)（人物性格）
> 美术总纲：[`art-direction.md`](art-direction.md) §〇（AI 图 vs 程序绘制分工）、§9.1（皮肤=文具/媒材轴）
> 数据结构依据：[`client/src/render/avatar.ts`](../../client/src/render/avatar.ts)（`AvatarCategory`/`buildAvatar`）、[`client/src/scenes/SettingsScene/avatarPicker.ts`](../../client/src/scenes/SettingsScene/avatarPicker.ts)（选择器 UI）、`UI_DESIGN.md` §"avatarId 数据格式"

---

## 产品方案（已与用户确认，2026-08-14）

| 分类 | 现状 | 本次方案 |
|---|---|---|
| `preset`（免费池） | 8 张线稿物件，4 个错位 | **全部替换**：20 张全新原创角色胸像（不是物件），notebook 涂鸦画风 |
| `hero`（抽到角色解锁） | 直接裁战斗/卡面立绘，三套画风打架 | **6 张全新专属胸像**，"日常/便装"版本（非战斗立绘、非付费皮肤），画风延续该角色已定的人设规范 |
| `skin`（拥有皮肤解锁） | 复用 `hero` 的图（bug：从未读 `SKIN_PORTRAIT_ART`） | **从已定稿的皮肤全身立绘裁一张专属胸像**（沿用皮肤配色，不重新出图），接线读 `SKIN_PORTRAIT_ART` |
| `title`（称号解锁） | 独立勋章画风，语义自洽 | ~~不动~~ → **2026-08-17 改拍板：整个分类从头像选择器删除**（见下方待办 §10）——称号本身仍可在 `TitlesScene` 装备/展示，只是不再作为头像候选 |
| `equip`（装备解锁） | 装备图标当头像，语义弱 | **整个分类删除**——装备随平衡性调整持续增删，头像跟着补图是填不完的坑 |
| `material`（材料解锁） | 3 种材料图标当头像，语义弱 | **整个分类删除**，理由同上 |

四类里 preset/hero/skin 是"脸"，title 是"勋章"——两种语义天然不同，不强求统一画风；但 preset/hero/skin 三者之间要统一**渲染契约**（见下）。

---

## 渲染契约：从"白线单色图标"改为"全彩胸像 + 运行时圆形裁切"

现状 `preset` 走的是 `pack_avatar_atlas.cjs` 的白线单色管线（复刻 emblem/faction 图腾那套——AI 出白底深墨线 → 丢弃原墨色只留 alpha → 重建纯白线 → 运行时铺在染色圆盘上）。**这套契约只适用于图标/图腾**，不适用于本次的人物胸像（人脸需要肤色/发色/表情，不能压成单色剪影）。

新契约改成与 `hero`/`skin` 已有的落地方式一致——**全彩位图 + 运行时圆形裁切**（`avatar.ts` 的 `buildPortraitIcon`）：

- 三类头像（preset/hero/skin）均为**独立 PNG**（不再打包进图集——数量小、且圆形裁切要求原图干净无相邻帧串色），仿照 `cardArt.ts` 的 `UNIT_ART_URLS` 单图 import 写法。
- **构图**：肩以上胸像，头部占画面上 2/3、留一点顶部余白，左右居中，纯白底方便 `buildPortraitIcon` 直接按宽度铺满做圆形裁切——不需要额外裁剪脚本。
- **裁切参数**（2026-08-15 视觉核对后定档，见 §四-8/9）：胸像**按每张图自己的头部框归一化**（`client/src/render/portraitHeadBox.ts`，由 `art/scripts/measureAvatarHeadBox.mjs` 量出发顶/颈线/头宽）——发顶落在圆的 5% 处、头（发顶→颈线）占满圆的 90%，宽头的按头宽上限 88% 收，最低不低于「铺满圆宽」。效果是 26 张统一取景、裁到脖子，肩部基本不入镜。**不要退回单一全局 zoom 常数**：这批图的头部几何差异很大（发顶 0.03–0.13H、颈线 0.52–0.69H、头宽 0.58–0.94W），全局常数必须迁就最松的一张，其余就都显小。全身立绘（`skin` 分类）没有头部框，回落到**按宽度铺满 + 顶部对齐 +3% headroom**（头贴着画面顶边，缩放会切进躯干）。胸像盘面填充 = 圆盘直径的 92%，即分类色只剩一圈细边，不再是厚圆环。
- **新增/重绘胸像时**：跑一次 `cd client && node ../art/scripts/measureAvatarHeadBox.mjs`，把输出贴进 `portraitHeadBox.ts`。漏了不会崩（缺表项回落到按宽度铺满），但那张会明显比同排的松。
- **不需要透明底/去白底处理**：`buildPortraitIcon` 本身用 `PIXI.Graphics` 遮罩裁圆，白色背景会被圆形遮罩天然裁掉，不必像图腾那样单独抠透明。
- 退回逻辑不变：`buildAvatarIcon`/`categoryIcon` 找不到贴图时仍降级到字母头像（`buildAvatar` 已有兜底），三类头像各自独立失败不互相影响。
- **淘汰** `art/ui/head/pack_avatar_atlas.cjs` 与 `client/src/assets/avatars/`（旧的白线图集），`art/ui/head/` 下 8 张旧线稿源图归档到 `art/leftover/`。

---

## Prompt 通用规范

沿用 `skin-art-prompts.md` 已验证的两套脸部规范（不重新发明）——按角色所属阵营选用对应一套，**新画的 20 个 preset 角色统一走"涛方简笔卡通脸"**（原创角色，不含阵营叙事包袱，用更省成本、更贴合"课堂涂鸦"总基调的一套即可，也是与 hero/skin 已有头像同风格、避免选择器里再打架的关键）。

> **对"无鼻无嘴"规则的一处刻意例外**：`skin-art-prompts.md` 的涛方共用前缀是 `no nose, no mouth`——这条规则在**全身立绘**里成立，因为辨识度由体型/站姿/发型扛（该文档 §"区分三人的核心原则"明说了这一点），脸本身只是个占位的圆。但**胸像头像里没有身体/站姿可看，脸就是全部画面**——20 个 preset 人设要读出"个性"，必须靠表情。故本文档的胸像版规范**保留无鼻**（维持辨识度不靠五官细节的既定审美），**但加回一条简笔嘴线**（同一支墨笔、单线勾勒，不画嘴唇/牙齿细节），按各人设的性格换笑/抿/撇等不同嘴型。这条例外只适用于本文档的胸像构图，不影响 `skin-art-prompts.md` 全身立绘的既有规则。

### 涛方简笔卡通脸（preset 全部 + hero 的李川/苏远/陈守）

```
Head-and-shoulders bust portrait, facing forward or a gentle three-quarter
turn, on a plain pure-white background, vertical framing with the head
filling about two-thirds of the frame and a little headroom above.
Rendering: clean confident dark-ink outlines of medium weight (not
sketchy-wobbly), flat color fills with cross-hatch pencil shading for
volume, matte paper look — no gradient, no glossy highlights, no glow, no
cel-shading, no airbrush, no photorealism.
Face: large round head, warm tan skin with light cross-hatching under the
jaw, two small solid-black dot eyes, no nose, small visible ear, and a
simple single-line mouth drawn in the same minimal doodle economy (not
naturalistic lips or teeth) — its shape is the main way this character's
personality/mood reads, see per-character description below.
Shoulders show a simple flat-color top with hand-stitched dashed seam
lines at the collar, matching the game's "notebook" costume language.
Soft flat white background, no scenery, no text, no watermark.
```

### Anna 方写实脸（hero 的 Max/Lena/Mara，沿用 `skin-art-prompts.md` 已定的写实脸规范）

```
Head-and-shoulders bust portrait, a calm three-quarter turn, on a plain
pure-white background, vertical framing with the head filling about
two-thirds of the frame and a little headroom above.
Rendering: clean confident dark-ink outlines of medium weight, flat color
fills with cross-hatch pencil shading for volume, matte picture-book look
— no gradient, no glossy highlights, no glow, no cel-shading, no airbrush.
Face: a realistic young European face with a soft natural eye, light
eyebrow, a small straight nose, a calm closed mouth — ordinary grounded
proportions, not stylized/cartoon.
Shoulders show a simple flat-color top, no armor, no weapon, no scenery.
Plain white background, no text, no watermark.
```

### 共用负向提示

```
gradient, glossy highlights, shiny, glow, painterly, soft airbrush shading,
watercolor, 3d render, full body, cropped at chest only showing collarbone,
weapon in frame, background scenery, multiple people, text, watermark,
sexualized, revealing clothing
```

每张建议生成 3-4 个变体择优（同项目惯例）。

---

## 一、hero 类目 — 6 张专属"日常胸像"

不复用战斗立绘/付费皮肤，画一版**便装、无武器、无战斗姿态**的胸像，代表"这个角色本身"。人设（发型/体型气质/表情）直接继承 `skin-art-prompts.md` 已拍板的辨识三件套结论，只取头部+发型这部分（体型/站姿/道具在胸像构图里用不上）。

| 帧名建议 | 角色 | 画风 | 辨识要点（继承自 skin 文档） |
|---|---|---|---|
| `hero_infantry` | 李川 | 涛方卡通脸 | 四散炸开的乱发（躁动），随性咧嘴的表情 |
| `hero_archer` | 苏远 | 涛方卡通脸 | 平顺侧分短发（克制精准），目光略微望向一侧 |
| `hero_shieldbearer` | 陈守 | 涛方卡通脸 | 近乎理平的寸头（纪律），沉稳表情 |
| `hero_max` | Max | Anna 写实脸 | 冷静果决的眼神，短发利落，不苟言笑 |
| `hero_lena` | Lena | Anna 写实脸 | 战辫（沿用皮肤发型），沉稳自信的神情 |
| `hero_mara` | Mara | Anna 写实脸 | 松散半扎波浪卷发，望向远处、略带思索的神情 |

### `hero_infantry` — 李川

```
[涛方简笔卡通脸 前缀]
Messy spiky brown hair rendered with short scratchy ink strokes, sticking
out in several directions. Mouth drawn as a wide open-corner grin, one
simple upward-curved line — restless, ready to talk before he's finished
thinking. Wears a plain slate-gray crew-neck top.
[共用负向]
```

### `hero_archer` — 苏远

```
[涛方简笔卡通脸 前缀]
Short, neat hair smoothed down and combed to one side with a clean even
side part, staying above the eyebrows, hugging the round head evenly — no
spiky tufts. His gaze is turned very slightly to one side, calm and
watchful. Mouth drawn as a short flat closed line, neither smiling nor
frowning — composed and unreadable. Wears a plain royal-blue sleeveless
top.
[共用负向]
```

### `hero_shieldbearer` — 陈守

```
[涛方简笔卡通脸 前缀]
Hair cropped very short and neat, almost buzzed close to the scalp — a
disciplined, compact rounded silhouette. A calm, grounded expression.
Mouth drawn as a short straight line held level and firm, the ink pressed
slightly heavier than the rest of the face — steady, unmoving, the look
of someone who has already decided to stand there. Wears a plain
deep-purple padded vest collar over a gray undershirt.
[共用负向]
```

### `hero_max` — Max

```
[Anna 写实脸 前缀]
Short neat hair, groomed and controlled. A calm, decisive, no-nonsense
expression — the look of someone who has already assessed the room.
Wears a plain steel-gray collared top.
[共用负向]
```

### `hero_lena` — Lena

```
[Anna 写实脸 前缀]
Hair pulled back into a tight, neat war braid at the nape of the neck, no
loose strands. A composed, quietly confident expression, steady eyes.
Wears a plain deep-blue collared top.
[共用负向]
```

### `hero_mara` — Mara

```
[Anna 写实脸 前缀]
Hair loose and wavy, half pulled back and half falling free, a few
flowing ink strokes, no shine. Her gaze is lifted slightly, looking off
into the distance past the viewer — watchful, a little wistful. Wears a
plain sky-blue collared top.
[共用负向]
```

> **二版迭代（2026-08-15）**：首版"半扎"读不出来（近乎纯散发，跟 prompt 描述的辨识点没对上），上衣颜色也偏深、跟 Max 的钢灰/Lena 的深蓝层次不够。二版把发型描述改成强约束——"挽起的部分必须能看出与散发的视觉分界"（明确写"小发髻/发夹"），颜色改用更精确的 pale sky-blue/powder-blue 参照词，负向提示里额外排除 dark navy blue 和"纯散发无扎起"两种回退结果。改对后收录，首版草稿归档 `art/leftover/hero_mara_draft1.webp`。

### 出图记录 + 定稿状态（2026-08-15）

6 张按上表逐张出图审核，**5 张一版过、`hero_mara` 迭代到二版**（见上方迭代记录）。

**资产处理**：6 张定稿源图在 `art/ui/head/` 原地重命名为 `hero_<key>.{png,webp}`（保留 AI 原始格式/分辨率，作为母版；`hero_mara` 首版草稿归档 `art/leftover/hero_mara_draft1.webp`）；母版按 512px 宽等比缩放 + `sharp` `{ palette: true, quality: 90, effort: 10, compressionLevel: 9 }` 压缩（同 preset 批次口径），产出 `client/src/assets/avatars/hero/hero_<key>.png`（单张 159~223KB）。新增 `client/src/render/heroAvatarArt.ts`（仿 `presetAvatarArt.ts` 写法），导出 `HERO_AVATAR_KEYS`/`HERO_AVATAR_ART_URLS`（key 沿用 `cardArt.ts` `UNIT_ART_URLS` 的 unit-id 命名：`infantry`/`archer`/`shieldbearer`/`max`/`lena`/`mara`）——**只是让这 6 张图可以被 import**，尚未接入 `avatar.ts`（`categoryIcon('hero', ...)` 仍读 `UNIT_ART_URLS` 战斗立绘），渲染路径切换留给下面「功能实现待办」。`tsc --noEmit` + webpack 生产构建已过。

---

## 二、preset 类目 — 20 张全新原创角色胸像

**定位**：这不是"抽到的角色"，是**免费送给所有玩家的默认头像池**，代表玩家自己。2026-08-14 复盘：初版按"优等生/运动健将/摄影爱好者"这类**身份标签**分组，问题是身份标签描述的是"在做什么"，不是"是什么样的人"——放在一张只有脸的胸像里，靠换个随身小物根本撑不起 20 个人的辨识度，也辜负了 art-direction.md §二"13～22 岁、个性感最强的年纪"这个定位。**改为直接从性格切入**：每个人设是一种鲜明的**情绪底色/待人姿态**，靠**表情（眼神+简笔嘴型，本文档专属例外见上）+ 一个配合性格的手势/小动作**表达，发型退居辅助辨识，不再需要"随身物"这根拐杖。20 张全部走**涛方简笔卡通脸**画风（与 hero/skin 头像同源，避免选择器里再打架）。

命名沿用 `avatar.ts` 的 key 风格（简短英文 slug），按情绪基调分四组各 5 个：

### A 组 — 张扬外放型（5）

| 帧名 | 性格切片 | 表情 + 手势 |
|---|---|---|
| `preset_gogetter` | 想到就做的行动派 | 眼神发亮，身体微微前倾，嘴角扬起一个自信的斜笑，像下一秒就要冲出画面 |
| `preset_sunny` | 走到哪笑到哪的开心果 | 张大嘴开怀大笑，眼睛弯成月牙 |
| `preset_hype` | 永远元气满满的应援担当 | 瞪大发亮的眼睛，一只手攥拳贴在脸颊旁，像随时要欢呼出声 |
| `preset_fanboy` | 追星追到走火入魔 | 星星眼，双手捧着自己的脸颊，陶醉又有点害羞的笑 |
| `preset_chuuni` | 中二病晚期 | 眼神凌厉地望向画面外远方，嘴角绷紧，一本正经摆出"身负使命"的架势 |

### B 组 — 内敛细腻型（5）

| 帧名 | 性格切片 | 表情 + 手势 |
|---|---|---|
| `preset_observer` | 慢热的安静观察者 | 目光落在画面外一点，神情专注但不冷漠，嘴角有一丝几乎看不出的浅笑 |
| `preset_emo` | 忧郁的诗人型 | 微微低头，刘海半遮一只眼睛，嘴角紧闭，若有所思 |
| `preset_dreamer` | 活在自己世界的白日梦想家 | 望向远方，眼神有点飘忽，嘴角挂着一个自己都没察觉的笑 |
| `preset_shy` | 一戳就红的敏感体质 | 眼神低垂，微微蹙眉，嘴唇抿起，一副欲言又止的样子 |
| `preset_lazy` | 佛系躺平选手 | 半闭着眼，头懒洋洋地歪向一侧，嘴巴微张，一副刚睡醒的模样 |

### C 组 — 棱角鲜明型（5）

| 帧名 | 性格切片 | 表情 + 手势 |
|---|---|---|
| `preset_aloof` | 谁也懒得搭理的高冷酷盖 | 半眯着眼，嘴角微微向下撇，一种谁都别来烦我的松弛感 |
| `preset_hothead` | 一点就着的暴脾气 | 皱眉瞪眼，嘴角向下绷紧，一只手在脸颊旁攥成拳头 |
| `preset_perfectionist` | 眼里揉不得沙的完美主义者 | 一丝不苟的表情，眉头习惯性地微蹙，嘴唇抿成一条精确的直线 |
| `preset_snark` | 见谁都能怼两句的毒舌学霸 | 似笑非笑，嘴角单边微微上扬，眼神里带着看好戏的促狭 |
| `preset_sly` | 打得一手好算盘的心机小狐狸 | 眯眼笑着，嘴角上扬带一点狡黠的弧度 |

### D 组 — 反差萌型（5）

| 帧名 | 性格切片 | 表情 + 手势 |
|---|---|---|
| `preset_tsundere` | 嘴硬心软的傲娇 | 侧过脸不看镜头，嘴角别扭地绷着，脸颊却泛起两抹藏不住的红晕 |
| `preset_peacemaker` | 谁都护着的老好人 | 温和舒展的笑容，眉眼放松，让人一看就安心 |
| `preset_nerdcrush` | 闷骚的学术型宅 | 眼镜滑到鼻尖，眼神专注地望向画面外，嘴角却藏不住一点得意的翘起 |
| `preset_softie` | 面冷心热、绷不住的类型 | 嘴角刻意绷紧装冷淡，眼神里却漏出一点藏不住的温柔/委屈 |
| `preset_curious` | 十万个为什么本人 | 瞪大眼睛，头微微歪向一侧，嘴巴张成一个小圆，像刚发现新大陆 |

> **性别**：本组不锁性别，20 个人设按气质自然分配（发型/五官不刻意做男女二元区分，出图时不必额外声明性别）。**发型**只需保证 20 张之间彼此不撞（炸毛/寸头/双马尾/齐刘海/波浪长发…轮流用，具体哪张配哪个发型出图时按当次效果自由分配，不强制锁死一一对应表），核心辨识度由上表的表情+手势描述扛。**出图 prompt 结构**：涛方简笔卡通脸前缀（其中"a simple single-line mouth"按该行"表情+手势"描述替换）+ 该行手势描述接在 `Shoulders show...` 之前 + 共用负向；20 条不逐一展开重复模板，结构与上方 `hero_*` 完全一致。

### 出图记录 + 定稿状态（2026-08-15）

20 张按 A~D 四组逐张出图审核，**19 张一版过、1 张迭代到二版**：

- `preset_hype`：首版嘴型是纯张大的椭圆，读起来像"被吓到"而非"兴奋应援"；二版把嘴角改成上扬的呼喊弧线、眼角加简笔星芒线（纯线稿，不是玻璃光斑），改对后收录。首版草稿归档 `art/leftover/`。
- `preset_softie`：首版"面冷"到位但"心热"没读出来——纯黑点眼睛无法单靠形状传递委屈，绷直的嘴线也没留余地。二版加了两处细节：内眼角笔触极轻微下垂（暗示压着的委屈，不到悲伤的程度）+ 嘴角绝大部分绷直但一端没压住、冒出一丝上翘的弧度（"装冷淡但没绷住"的裂缝）。改对后收录，首版草稿归档 `art/leftover/`。
- 其余 18 张（`gogetter`/`sunny`/`fanboy`/`chuuni`/`observer`/`emo`/`dreamer`/`shy`/`lazy`/`aloof`/`hothead`/`perfectionist`/`snark`/`sly`/`tsundere`/`peacemaker`/`nerdcrush`/`curious`）首版即达标直接收录。

**发型分配结果**（20 张互不撞款，供后续如需再出变体时参考，非强制锁死）：A 组＝炸毛短发后梳／双丸子头／高马尾／蓬松刘海鲍伯头／单侧遮眼长刘海；B 组＝齐肩内扣短bob／长直发单侧刘海／微卷中长波浪发／双边小辫／乱糟糟寸乱短发；C 组＝随性半长直发撩耳后／竖刺短寸头／一丝不苟齐刘海+低发髻／不对称短碎发+竖翘刘海／顺滑翘尾中长发；D 组＝高扎双马尾／蓬松圆短卷发／侧分刘海+滑框眼镜（20 张里唯一戴眼镜的）／微翘短发／短碎发单撮天线呆毛。

**资产处理**（2026-08-15，与用户确认过"不打包图集，走独立 PNG"，见下方渲染契约）：
- 20 张定稿源图在 `art/ui/head/` 原地重命名为 `preset_<key>.{png,webp}`（保留 AI 原始格式/分辨率，作为母版）；2 张迭代淘汰稿 + 8 张旧线稿源图（`house`/`book` 等物件图标，本次要淘汰的旧管线）一并移入 `art/leftover/`。
- 母版按 512px 宽等比缩放（胸像头像展示尺寸都在 100px 量级，1024~1536px 原图对运行时纯属浪费）+ `sharp` `{ palette: true, quality: 90, effort: 10, compressionLevel: 9 }` 压缩（同 `art/scripts/appendAtlasFrames.js` 的压缩口径），产出 `client/src/assets/avatars/preset/preset_<key>.png`，20 张共 ~3.3MB（单张 100~220KB，量级对齐 `client/src/assets/units/*.png`）。
- 新增 `client/src/render/presetAvatarArt.ts`（仿 `cardArt.ts` 的 `UNIT_ART_URLS` 写法），导出 `PRESET_AVATAR_KEYS`/`PRESET_AVATAR_ART_URLS`——**只是让这 20 张图可以被 import**，尚未接入 `avatar.ts`/`avatarPicker.ts`（`tsc --noEmit` + `webpack` 构建已过，但 `AVATAR_DEFS`/`presetDef` 渲染路径的切换、equip/material 分类删除等仍是下面「功能实现待办」的范围，未做）。

---

## 三、skin 类目 — 6 张胸像（从已定稿皮肤立绘裁切，非重新出图）

`skin-art-prompts.md` 的 6 款付费皮肤全身立绘里，4 款（`skin_shop_c1`/`skin_e1`/`skin_e2`/`skin_l1`）已出图定稿，2 款（`skin_shop_r1`/`skin_shop_e1`）仍在打磨头部问题（该文档 pending 事项）。本类目**不重新出图**，等 6 款全部定稿后，从每张成品立绘上**裁一版专属胸像**：

- 裁切区域：肩线以上（头部 + 一点点肩甲/领口），构图与本文档 §渲染契约的"胸像居中、顶部留白"一致。
- 若直接裁切后构图/留白不理想（例如头盔占比过大、肩部道具伸进画面），可对该角色**单独补一次小范围重绘**（只改裁切区域附近，不是重新出整张立绘），不算重新走一遍出图流程。
- 输出仍是独立 PNG（`avatar_skin_shop_c1.png` 等），供 `avatar.ts` 的 `categoryIcon('skin', ...)` 直接引用——**接线时要修的 bug**：现在 `categoryIcon` 的 `skin` 分支查的是 `UNIT_ART_URLS[SKIN_TARGET_UNIT[key]]`（即 hero 的图，跟皮肤本身完全无关），改完后应直接查新建的皮肤专属胸像表（类似 `cardArt.ts` 已有的 `SKIN_PORTRAIT_ART`，只是那张表现在存的是全身立绘 url，需要新增一张"裁好的胸像 url"表，或者复用同一 url 靠 `buildPortraitIcon` 的裁切逻辑二次裁剪）。

| 帧名建议 | 皮肤 | 依赖状态 |
|---|---|---|
| `avatar_skin_shop_c1` | 李川皮肤 | ✅ 立绘已定稿，可直接裁 |
| `avatar_skin_shop_r1` | 苏远皮肤 | 🟡 待 `skin-art-prompts.md` §2 pending 事项定稿 |
| `avatar_skin_shop_e1` | 陈守皮肤 | 🟡 待该文档"肤色/发色统一"的重出定稿 |
| `avatar_skin_e1` | Lena 皮肤 | ✅ 立绘已定稿，可直接裁 |
| `avatar_skin_e2` | Mara 皮肤 | ✅ 立绘已定稿，可直接裁 |
| `avatar_skin_l1` | Max 皮肤 | ✅ 立绘已定稿，可直接裁 |

---

## 四、功能实现待办（本文档只覆盖美术+渲染契约，以下留给功能实现阶段）

1. **删除 `equip`/`material` 分类**：✅ 2026-08-15（独立 worktree `feat/avatar-wiring`）——`client/src/render/avatar.ts`（`AvatarCategory` 类型、`CATEGORY_BG`、`categoryIcon`）、`client/src/scenes/SettingsScene/types.ts`（`AVATAR_TABS`/`AVATAR_TAB_LABEL_KEY`/`AVATAR_LOCKED_KEY`）、`avatarPicker.ts` 的 `pickerItems()` 对应两个 `case`、`nav/auth.ts` 的 `ownedEquipment`/`ownedMaterials` 传参均已删除。存量账号迁移：服务端 `isAvatarOwned`（`save.ts`）equip/material 落到 `default: false`（`PUT /avatar/equip` 一律 403，不再区分"已拥有/未拥有"），新增 `sanitizeEquippedAvatar` 接进 `app.ts` 的 `preSerialization` 钩子——存量 `equip:*`/`material:*` 头像读时静默换成 `preset:0`，只读不改库，跟 `equipmentInv`/`cardInv`/`skinCounts` 的读时回填同一约定。
2. **`pack_avatar_atlas.cjs` 退役**：✅ 2026-08-15——`art/ui/head/pack_avatar_atlas.cjs` + `client/src/render/atlas/avatarAtlas.ts` 整体删除（确认过 `avatarAtlas.ts` 除 `avatar.ts` 外无其它引用者，`bootManifest.ts` 没有直接依赖它，不需要改 boot 清单；`iconsAtlas.ts` 底层共享图集本身保留，equip/material/faction 三类图标仍在用）。`client/src/assets/avatars/{avatars.png,avatars.json}` 这两个文件在动手前已不存在（早前 `072131d8` 重组资产时已并入 `icons_atlas.png/json`，本条目当时的表述已过时）。
3. **新增独立 PNG import**：✅ 2026-08-15 `preset_*` 20 张 + `hero_*` 6 张均已完成——`client/src/render/presetAvatarArt.ts`/`heroAvatarArt.ts` 仿 `cardArt.ts` 写法分别导出 `PRESET_AVATAR_ART_URLS`/`HERO_AVATAR_ART_URLS`（图片分别在 `client/src/assets/avatars/preset/`、`client/src/assets/avatars/hero/`，见上方「资产处理」）。仍缺：皮肤胸像 url 表（§三，等 skin 立绘定稿后再做）。
4. **`avatar.ts` 改造**：✅ 2026-08-15——`AVATAR_DEFS`（8 项 icon+bg）整个替换成 20 项 preset 胸像表；`buildAvatar` 的 preset 分支改成直接调用 `buildPortraitIcon`（与 hero/skin 同一渲染路径，`CATEGORY_BG` 也统一成单一中性色，不再是每图标各自配色）；`categoryIcon('hero', ...)` 已改查 `HERO_AVATAR_ART_URLS`（不再是 `UNIT_ART_URLS`）。**`categoryIcon('skin', ...)` 仍未改**——继续兜底到 hero 的 `UNIT_ART_URLS`，因为专属皮肤胸像表（§三）还没做，等 skin 立绘全部定稿后再一起接。
5. **`i18n`**：✅ 2026-08-15——`zh`/`en`/`de` 三份 locale 各摘除 `avatarTab.equip`/`avatarTab.material`/`avatarLocked.equip`/`avatarLocked.material` 共 8 个 key。未发现写死"共 8 个预设"之类的文案。
6. **`UI_DESIGN.md` §"avatarId 数据格式"**：✅ 2026-08-15——`design/game/UI_DESIGN.md` §11 整节重写（分类枚举、20-preset/6-hero 独立 PNG 渲染契约、4-tab 选择器、服务端 equip/material 拒绝+迁移垫片、`everOwned.equipment`/`material` 仍在为 gacha 查重服务的澄清）。
7. **验证**：✅ 2026-08-15——`tsc --noEmit` + webpack 生产构建（client）均过；metaserver 自身 `dist` 重建后完整 `vitest` 套件 1658/1658 真实断言通过（1 个文件因缺同级 `socialsvc/dist` 跳过，跟本次改动无关）；`liveops-equip.test.ts` 新增/更新用例直接跑通"equip/material 恒 403"+"迁移垫片端到端"两条。**截图未能完成**——本次会话 Browser pane 未能 compositing（环境限制，非代码问题），改为在真实运行的 webpack dev server 上直接解析+抓取一张新 hero PNG 的构建产物 URL 验证资产管线在运行时确实可用（200、image/png、字节数与压缩后源图一致）；20 preset + 6 hero 网格的视觉核对（圆形裁切/锁定态/选中态）留给下次有可用 Browser pane 的会话补做。
8. **视觉核对 + 取景返修**：✅ 2026-08-15（补做 §7 欠下的截图核对，用户反馈"边框太粗、截取有问题"）。核对方式：Playwright 驱动 `npm run start:e2e`（9096）+ `window.__nwE2E.views.showSettings(...)`，四个 tab 逐个截图；取景参数先在纯 Canvas2D 对照页上拿全部 26 张真图跑过 old/new 并排，再落到代码里。改了三处（`client/src/render/avatar.ts`）：
   - **盘面填充 0.62 → 圆盘直径的 92%**：旧值让分类色占掉每边约 19% 直径，头像成了粗蓝环里的小脑袋。填充按**圆盘直径**（`size-4`）算而不是按格子边长，地图 token 的 16px 下限才不会把画像顶出铅笔描边。
   - **`buildPortraitIcon` 分 `'bust'`/`'full'` 两种取景**：胸像 zoom 1.10、上移 4%（26 张实测，再多就会切到 `hype` 马尾/`tsundere` 双马尾）；全身立绘保持原来的顶部对齐。
   - **纹理异步加载后不重新适配的 bug**：贴图未加载完时 `tex.width` 还是占位尺寸，算出的缩放比真实值大一倍，而头像是叶子构建函数、没有任何东西会重画它——冷启动第一次进设置页看到的就是"糊在头发上的特写"。改为 `baseTexture.once('loaded')` 里原地重算（带 `destroyed` 守卫）。回归用例：`client/test/ui/avatarPortraitFit.ui.ts`（撤掉修复即失败，已验证非空跑）。
   - 遗留：`skin` 分类仍在用全身立绘（§三的皮肤胸像表还没做），放大后脸依旧很小——等 skin 立绘定稿后一并解决。
10. **删除 `title` 分类**：✅ 2026-08-17——`client/src/scenes/SettingsScene/types.ts` 的 `AVATAR_TABS` 摘除 `'title'`（选择器只剩 preset/hero/skin 三个 tab）。**保留** `AvatarCategory` 类型本身的 `'title'` 分支、`avatar.ts` 的 `categoryIcon('title', ...)`、`avatarPicker.ts` 的 `pickerItems()` 的 `'title'` case——存量玩家若之前已把某个称号勋章设成头像（`avatarId` 形如 `title:xxx`），退役的只是"新选"入口，已选中的旧头像仍按原样正常渲染，不做迁移垫片（跟 §四-1 equip/material 那种"整类拒绝+服务端 403"不同，这里没有服务端语义变化，纯 UI 层收窄）。i18n key `avatarTab.title`/`avatarLocked.title` 暂未删（`AVATAR_TAB_LABEL_KEY`/`AVATAR_LOCKED_KEY` 仍是 `Record<AvatarCategory, ...>` 全量类型，删 key 需要连带改类型，收益不大，先留着）。
9. **头部框归一化（取景二轮）**：✅ 2026-08-15——用户反馈"边框好多了，但头像依然偏小，截取到脖子/肩部更好"。量了 26 张的实际几何后确认单一全局常数走到头了（见上方 §渲染契约的"不要退回单一全局 zoom 常数"），改为按图归一化：新增 `art/scripts/measureAvatarHeadBox.mjs`（sharp 逐行扫墨迹：发顶=首个有实质内容的行，颈线=头最宽行与肩部张开之间的最窄行，头宽=头部最宽行）+ `client/src/render/portraitHeadBox.ts`（26 项测量表）。`buildPortraitIcon` 改吃 `HeadBox | null`，null 即全身立绘的老取景。四档参数（头占圆 0.86/0.90/0.95 × 头宽上限）在 Canvas2D 对照页上比过，取 top 0.05 / span 0.90 / maxW 0.88。回归用例 `client/test/ui/avatarPortraitFit.ui.ts` 扩到 3 条，其中一条遍历全部 26 张断言"发顶在圈内、裁切落到颈线、画面铺满圆宽"——新增胸像忘了测头部框会被它抓住。真实渲染路径复核：Playwright + `__nwE2E.views.showSettings`，preset（含滚动后半屏）/hero/skin 三个页签均已截图确认。
