# SLG 地图资源 — 分级读数重构

> 从 [`slg-resource-art.md`](slg-resource-art.md) 拆出（2026-08-24，原文件 758 行，ADR-067 第七轮）。**小节编号沿用原文**，既有的 `slg-resource-art.md §6.x` 引用按本文查即可。
>
> 本文是**分级读数的当前权威**，覆盖 hub 里 §5.3 #2 与 §5.4 的形态跃迁条款。母题层规范（§0–§4）与分级出图 prompt 表（§5）仍在 hub。

## 6. 分级读数重构（2026-08-19 定 · 权威 · 覆盖 §5.3 #2 / §5.4 的形态跃迁条款）

> 触发：用户截图圈出三块 4 级墨水地，反馈「图片大小和第一眼印象明显不是一种地」。查证后发现问题不在这三格，而在**分级读数的整套契约自我否定**。

### 6.1 病根：按宽归一惩罚横向生长

旧契约（`pack_resources.cjs` 注释 + §5.4-lo 末句）：「渲染按宽归一 → 画得越高越满 = 屏上等级越高」。渲染层 `drawResMotif` 的 `denom = tex.width` 忠实实现了它。

但高等级的丰度在画稿里是**横着铺开**（多瓶并排、一簇、一堆）表达的，内容 bbox 变宽，按宽归一立刻把整幅压小——**画得越多，屏上越小**。任何用横向表达"更多"的画法都满足不了这个契约。

实测（把每帧墨量 Σα 按游戏真实缩放折算成"落在一格上的墨量"，相对 ink l1 = 1.00）：

| | l1 | l2 | l3 | l4 | l5 | l6 | l7 | l8 | l9 | l10 |
|---|---|---|---|---|---|---|---|---|---|---|
| ink | 1.00 | 4.35 | 2.59 | **6.44** | 3.80 | 3.52↓ | 3.50 | 2.14 | 2.11 | 3.72 |
| paper | 0.25 | 0.59 | 0.68 | 1.97 | 2.28 | 0.67↓ | 0.83 | 1.26 | 1.79 | 2.97 |
| graphite | 0.86 | 1.20 | 1.17 | 2.50 | 1.45 | 0.99↓ | 1.41 | 2.43 | 2.17 | 3.23 |
| metal | 1.05 | 1.19 | 1.58 | 1.75 | 1.85 | 1.40↓ | 2.02 | 2.62 | 1.79 | 3.52 |

**四类全部在 l5→l6 回落**——正是画法从「单母题长高」（§5.4-lo）跳到「容器/多体大簇」（§5.4 l6–10）的接缝。且 ink l4（6.44）是全十级里视觉最重的一帧，比 l10 重 1.7 倍——这就是用户圈出 4 级地的直接原因。

同级之间的大小差另有来源：`motifJitter` 的 `scale ∈ [0.85,1.15]`，相邻格实测能到 1.15 vs 0.88 = 1.31×。

### 6.2 裁决

1. **剪影铁律（§5.3 #3）优先，§5.4 的「l6–10 形态逐级跃迁，追求最佳表现」作废。** 同一 resType 的 l1–l10 必须是**同一个主体物件**；等级只通过「个数 + 堆量 + 溢出/碎屑」增长。不得引入容器、载具、器皿、卷状物（现有违规见 §6.5）。
2. **5→6 的画风跳变作废。** l1–l10 是一条连续的量级线，不再分低档段/高档段。
3. **归一化从「按宽」改为「按等效面积」** `√(w·h)`。横排与竖立占同样视觉面积，横向生长不再被惩罚——**画稿从此不必为了"更高"而扭曲构图**。
4. **尺寸改由显式曲线承载**：`LEVEL_SCALE = 0.80 → 1.30`（线性，l10 占地 0.30×1.30 = 0.39 tp，仍在 2026-07-17 判定过大的 0.40 以内，且只有稀有的高级格吃到）。等级→尺寸从"画稿隐式"变成"代码显式"。
5. **⚠️ 墨量判据已于第二批出图后改为「不许倒挂」，见 §6.7——本条的「单调递增」要求作废。** alpha 只做小幅修正，不当通道：`alpha ∈ [0.85, 1.00]`，仅用来削平画稿之间的小落差，替换裸线性 `0.55+0.45*(lv-1)/9`。全图是一支笔画的，某格 0.4、邻格 1.0 读作「换了笔」，不是「资源更少」。
   > **这一条是被实测打回来改的**：第一版门禁允许 alpha 自由补偿总墨量 Σα，结果它给当前这批画稿判了**通过**——它的"解"是把 ink l4 压到 alpha 0.37、l9 留在 1.00，总墨量确实单调了，但浓淡在格间乱跳，正是本契约要防的观感。**Σα 不是正确的感知模型**：一个大而淡的形状和一个小而黑的形状墨量可以相等，眼睛读到的完全不同。→ 等级读数只由「占地曲线 + 画稿自身疏密」承载，于是「某级画得比下一级还空」成为**代码救不了的画稿硬伤**，只能由构建期拒绝。
6. **抖动只保留 rot/offset**，`scale` 收窄到 `[0.96,1.04]`。同级不再有可察觉的大小差。
7. **精确等级恢复为显式通道**（§5.4 的原始诉求「格面上能读出精确等级，否则玩家误伤」在决策变更 II 里被放弃，现在补回，但不用符号编码）：沿用 2026-08-01 主城标签的先例（[`WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) 四节末：符号点阵"让人迷惑"→ 换纯文字 `Lv.{n}`），资源格同样画文字，但**仅 l6+ 且仅近 zoom 显示**——会误伤的是强守军区，低档靠体量读三档足够；`resourceDensity=1.0` 下全等级都标就是满屏噪音。**用位图数字图集或 BitmapText，不要每格 `new PIXI.Text`**（Text 纹理销毁泄漏）。

### 6.3 构建期强制（`pack_resources.cjs`）

画稿层的单调性不再靠画师自觉，改为门禁：

- 每帧计算 `inkMass = Σα`、`density = inkMass/(w·h)`、`equivEdge = √(w·h)`，连同解出的 `sizeMul = LEVEL_SCALE(lv)/equivEdge` 和 `alphaMul` 一起写进**每个 frame 条目的 `nw` 字段**——不是 `meta`：`mergeAtlasPages.js` 只取源 json 的 `data.frames`、`meta` 自己重写，放 `meta` 会被静默丢弃；frame 条目是 `{...f}` 整体展开的，自定义字段能穿过合并落进 `world_atlas.json`，也就是客户端真正加载的那一份。PIXI 的 Spritesheet 只读已知键，忽略 `nw`。
- **等级读数整条在构建期解完**：渲染层因此不含任何 level→尺寸/透明度逻辑，只剩 `scale = tp × MOTIF_SIZE_FRAC × nw.sizeMul × jitter.scale`、`alpha = nw.alphaMul`。图集成为等级读数的唯一权威，client 与 map-editor 两份渲染器不可能再漂移（旧代码靠注释里的「must stay in lockstep」人肉保证）。
- **求解**：`reach(lv) = density × LEVEL_SCALE(lv)²` 是满笔时的落屏墨量。从 l1 起按最低可行值**前向贪心**，每级至少比上一级高 `INK_GROWTH = 1.06`，同时每帧 alpha 必须留在 `[ALPHA_MIN=0.85, 1]`。这给出最低可行曲线——某级的 `reach` 连它都达不到（容差 `GATE_EPS = 1.02`），就是**真的画得比下一级还空**，与调参无关。
- 不达标 pack 直接 `exit 1`，逐帧打印短缺百分比和两条修法（画满这一级，或画淡下一级）。过渡期可 `--report-only` 照常出图（新美术还没到位时不阻塞渲染层开发），CI 不带这个开关。
- **为什么必须是硬门禁**：alpha 只能把画满的**压淡**，`alpha ≤ 1` 意味着**没法把画空的补浓**。

### 6.4 重画清单（17 张 / 46）

两类并集。**B 类**＝§6.3 门禁实测判定（短缺%＝该帧满笔仍差多少才够压过下一级），**A 类**＝剪影铁律违规，门禁看不见，靠 §6.2 #1 裁决。

| 资源 | 帧 | 类 | 原因 |
|---|---|---|---|
| ink | l5 | B | 短缺 7%；圆肚壶偏离 l1–l4 的圆肩直筒瓶族 |
| | l6 | B | 短缺 9%；换成方肩瓶（轻度换族） |
| | l7 | B | 短缺 8% |
| | l8 | **A** | **试管架**＝实验室器材/容器 |
| | l9 | B | **短缺 85%**（全表最严重）：一个大而空的单体瓶，读作"空"而非"高" |
| paper | l6 | B | **短缺 129%**（全表之最）：糊成方块/箱，直接违反 §5.3 #3「轮廓要一眼读成一摞纸」 |
| | l7 | **A** | 换成**卷轴+绑带** |
| | l9 | **A** | **大圆筒/卷纸**，读作卫生纸卷 |
| graphite | l5 | B | 短缺 6% |
| | l6 | B | 短缺 39%；换成瘦长晶柱，偏离尖锐棱块族 |
| | l8 | **A** | **矿车**＝载具 |
| | l9 | B | 短缺 15%；单个大晶体独大 + 偏空 |
| metal | l5 | **A** | 主体夹被碎屑堆**淹没**，剪影读不出（破 §5.3 #3） |
| | l6 | B | 短缺 15% |
| | l8 | **A** | **铁盒/罐**＝容器 |
| | l9 | B | 短缺 41%，量级比 l8 还回退 |
| sticker | l8 | B | 短缺 8%；**贴纸卷**＝卷状条带 |

> **ink l4 / graphite l4 不在清单里**（初稿曾列为"减密度"）。它们 density 确实冲顶，但门禁改成「保持笔触浓度」判据后，正确修法是把**上面那级画满**，而不是把这级画淡——`0.85` 的 alpha 下限只允许微调，画淡不是可用手段。同理 graphite l3、paper l8 落在 `GATE_EPS` 容差内，不必重画。
>
> **系统性规律**：**l8 普遍冒出容器/载具**（试管架、矿车、铁盒、贴纸卷），**l9 普遍是"一个大而空的单体"**（ink 短缺 85%、metal 41%、graphite 15%）。成因就是 §5.4 那句"形态逐级跃迁，追求最佳表现"——它和 §5.3 #3 的剪影铁律在文档内部本就矛盾，本次由 §6.2 #1 裁决。

### 6.5 出图 prompt（接 §5.5 共用前缀 + §5.6 共用负向，另加下面两段增补）

**共用前缀增补**（面积归一后留白直接浪费密度；横向不再被罚）：

```
The subject fills the frame edge to edge with only a thin even margin — no large
empty areas anywhere in the frame. The composition may spread horizontally or
vertically, whichever reads better; wide compositions are not penalised. Draw it
with dense pen hatching so the whole subject reads dark and solid at a glance —
not as thin hollow outlines with white interiors.
```

> 末句是 2026-08-19 第一批出图后补的（§6.6）：8 张不达标的帧里有一半是生成器把主体画成了**空心白轮廓**——瓶子没灌墨、石块不打阴影线、纸叠只有边线。密度是等级读数的载体，必须在 prompt 里明说，不能指望"filling the frame"顺带带出来。

**共用负向增补**：

```
rack, tray, shelf, crate, box, tin, jar lid, container, cart, wagon, wheels,
scroll, rolled paper, tube, cylinder, laboratory glassware, test tubes, ribbon
```

**主体句**（帧名 → prompt）：

- `res_ink_l5`：`A single round-shouldered glass inkwell bottle brimming with ink, its cork lying beside it, a second empty bottle tipped over behind it, ink drops and a spreading blot pooled around both`
- `res_ink_l6`：`Two round-shouldered glass inkwell bottles standing close together, both filled with ink, a cork and a few ink drops at their base`
- `res_ink_l7`：`Three round-shouldered glass inkwell bottles clustered close together, all filled with ink, one slightly taller, corks and ink drops scattered at their bases`
- `res_ink_l8`：`Five round-shouldered glass inkwell bottles packed tightly together in a loose freestanding cluster, all filled with ink, corks and ink drops crowded around their bases`
- `res_ink_l9`：`Seven round-shouldered glass inkwell bottles crowded together in a dense freestanding heap at slightly varied heights, all filled with ink, several corks and a spreading ink blot pooled underneath`
- `res_paper_l6`：`A tall loose stack of blank sheets with a second shorter stack leaning against it, edges fanned and uneven, a few loose sheets sliding off the top`
- `res_paper_l7`：`Two tall loose stacks of blank sheets standing side by side, edges fanned and uneven, several loose sheets slipping out between them`
- `res_paper_l9`：`Five loose stacks of blank sheets crowded together at differing heights, edges fanned and uneven, loose sheets spilling all around their bases`
- `res_graphite_l5`：`A single large angular faceted graphite ore chunk standing upright with a generous loose scatter of ore shards heaped all around its base, hatching on two facets`
- `res_graphite_l6`：`Two angular faceted graphite ore chunks of different sizes resting against each other, a scatter of small ore shards heaped around their bases`
- `res_graphite_l8`：`A dense freestanding pile of six angular faceted graphite ore chunks heaped up, smaller shards filling the gaps between them`
- `res_graphite_l9`：`A dense freestanding heap of eight angular faceted graphite ore chunks piled together, many small shards filling every gap, no single chunk dominating`
- `res_metal_l5`：`A single metal binder clip standing clearly in front of a loose heap of small metal hardware, the clip's triangular body and two looped wire handles fully readable against the heap`
- `res_metal_l6`：`Two metal binder clips standing side by side, one slightly turned, with a scatter of small metal bits and fasteners heaped around their bases`
- `res_metal_l8`：`Five metal binder clips packed tightly together at different angles in a freestanding cluster, small metal bits filling the gaps between them`
- `res_metal_l9`：`Seven metal binder clips crowded into a dense freestanding heap at varied angles, looped wire handles overlapping, small metal hardware filling every gap`
- `res_sticker_l8`：`A thick stack of star-shaped stickers with more loose stars fanned out around it, several stars overlapping the stack`

> **⚠️ 新美术落地时会撞上一个管线陷阱**：客户端真正加载的是**合并页** `client/src/assets/slg/world_atlas.{png,json}`，而 2026-07-27 的资产整理把 `terrain/city/playerbase/building/city_bld` 这些源图集**从仓库里删掉了**，`mergeAssetAtlases.js` 已不可重跑（缺输入）。本次因为画稿未变、帧尺寸未变，可以用 `node art/scripts/patchMergedAtlas.js client/src/assets/slg/res_atlas.json client/src/assets/slg/world_atlas.json` 就地回贴（它会连带搬运 `nw` 这类自定义 per-frame 字段）。**但新画稿的长宽比一定会变，帧尺寸随之改变，`patchMergedAtlas.js` 会直接拒绝**（它只支持同尺寸回贴）。届时必须：从 git 历史恢复那几个被删的源图集 → 重跑 `mergeAssetAtlases.js` 做整页重排 → 或者给 patch 脚本加"重排整页"能力。**出图之前先把这条路打通**，否则图出完了进不去客户端。
>
> **20 → 17 张的调整**：`res_ink_l4` / `res_graphite_l4` / `res_graphite_l3` / `res_paper_l8` 的 prompt 已撤（理由见 §6.4 末），新增 `res_graphite_l5`。
>
> 出图后丢进 `art/slg/slg-map/` 重跑 `node art/slg/slg-map/pack_resources.cjs`——§6.3 的校验器会直接判定通过/不通过，不达标的帧会打印在违规表里，按表迭代即可。**不需要人肉目测单调性。**

### 6.6 第一批出图落地（2026-08-19）

17 张出图，**13 张落地，1 张退回，4 张需重出**；同时新图把 4 张留用的老帧比了下去，也进入重画队列。

**落地 13 张**（`art/leftover/res_*.pre-2026-08-19.*` 保留了被替换的旧帧）：ink l5/l6/l8/l9、paper l7/l9、graphite l6/l9、metal l5/l6/l8/l9、sticker l8。剪影违规全部修掉——l8 那批容器/载具（试管架、矿车、铁盒、贴纸卷）没了，metal l5 的夹子从碎屑堆里露出来了，paper l6 不再是方块。

**退回 1 张**：`graphite_l5` 新图密度 0.087 反而低于旧帧 0.115，且画成细长晶柱（往 l6 那个已判违规的毛病上飘）→ 旧帧恢复，新图存 `art/leftover/res_graphite_l5.rejected-2026-08-19-too-sparse.webp`。

**新增管线修正：强制灰度化**。新图带蓝调（`b-r` +6~+51），而它们要并排的老帧全是中性黑（+0~+7），在地图上读作"换了支笔"。`pack_resources.cjs` 现在把所有帧的 RGB 折成 luma 再打包（当时 sticker 的色带在这之后施加，所以铜→金不受影响；该色带已于 2026-08-20 整套删除，见 §6.12.6）——不靠出图纪律，hue 漂移结构上不可能再发生。

**待重出 8 张**：

| 帧 | 现状 | 判定 | 病因 |
|---|---|---|---|
| `res_ink_l7` | 新图 0.246 | 差 22% | 三只瓶子画成了**空玻璃瓶**，没灌墨（prompt 写了 all filled，生成器没照做） |
| `res_ink_l10` | 旧帧 0.210 | 差 49% | 新 l9 密度 0.379 已经反超顶级，l10 必须是全系最满的一张 |
| `res_graphite_l5` | 旧帧 0.115 | 差 6% | 旧帧本身偏空（新图更差已退回） |
| `res_graphite_l7` | 旧帧 0.105 | 差 18% | 被新 l6（0.152）反超 |
| `res_graphite_l8` | 新图 0.095 | 差 7% | 石块画成**圆钝白多面体**、无阴影线、缝隙没碎屑填充 |
| `res_metal_l7` | 旧帧 0.135 | 差 19% | 被新 l6（0.197）反超 |
| `res_paper_l6` | 新图 0.078 | 差 66% | 纸叠只有**空心边线**，侧面没有密集叠层线与排线 |
| `res_paper_l8` | 旧帧 0.083 | 差 55% | 被新 l7（0.157）反超 |

> **规律**：新画稿普遍比同族老帧密得多，于是"偏空"的判定自动传导到了相邻的老帧上。这正是门禁该有的行为——它不认"这张是新出的"，只认整条曲线。第二批要盯的是**密度**，剪影这一关已经过了。

### 6.7 判据再修正：墨量「不许倒挂」，不是「必须递增」（2026-08-19 第二批后 · 权威）

**「墨量随等级单调递增」这个要求本身不可满足**，而不是画稿不努力。实测证据：

> `res_ink_l4` 是**一只**灌满墨的瓶子，density **0.390**；`res_ink_l9` 是**七只**瓶子，density **0.376**。

等面积归一下，一个大而实心的物体天然比一群带白玻璃间隙的小物体更密。于是「**物件数**」和「**墨量**」互相竞争——要求两者同时随等级递增，任何画稿都做不到。两轮出图把这个矛盾演示了一遍：批 1 偏空 3–4 倍（l6 那批"跳到多体大簇"），我在 prompt 里加了 `dense pen hatching / reads dark and solid`，批 2 就回来了偏满 3–4 倍（graphite l8 density 0.637、metal l7 0.585，而同族邻帧只有 0.15）。**用形容词调密度会震荡，不会收敛。**

**新判据**：`R(lv) = density × LEVEL_SCALE(lv)²` 必须始终不低于「它下方所有等级里最重的那个」的 90%（`INK_TOLERANCE = 0.10`）。也就是只禁止**读反**，不要求每级都更重。

- 为什么这样才对：玩家真正需要的是「不要去打明显打不过的格子」，也就是**高等级绝不能看起来比低等级资源少**。相邻等级的可分辨性由**占地曲线**（代码保证单调，画稿破坏不了）+ **物件数** + **l6 起的 `Lv.N` 文字标签**三条通道承担，不该压在墨量上。
- 求解时每帧都取「规则允许的最轻」（alpha 可在 `[0.85,1]` 内削），这样单张过黑的画稿不会把它上面所有等级的门槛一起抬高。这条余量实测很有用：graphite l7/l8、metal l7/l8 都是靠把下方那张过黑的帧削 15% 才通过的——15% 在格子尺寸上看不出来，但能换回正确的读数。
- 报错指名**下方那张卡住它的帧**，因为那张和触发检查的这张一样可能是真凶（批 2 就是这样失败的），并直接给出目标 density。

**第二批落地**：8 张里只留 `res_ink_l10`（顶级最重方向正确，补掉旧帧差 49% 的缺口）；其余 7 张过黑，退回上一版，批 2 文件存 `art/leftover/res_*.rejected-b2-too-dark.*`。另 `res_paper_l6` 那张带**内缩 13px 的画框**，边缘检测抓不到 → `pack_resources.cjs` 新增 `stripBorderRing()` 环扫描（四边同一内缩处同时变黑即判定），自动剥除并打印警告。

**当前仍读反的 3 张**（新判据下）：

| 帧 | 现 density | 目标 | 处境 |
|---|---|---|---|
| `res_ink_l7` | 0.246 | ≈0.28–0.36 | 比 l6（0.365）轻 13%。批 1 版瓶子是空玻璃（0.243），批 2 版实心黑（0.518），两头都不对 |
| `res_paper_l6` | 0.078 | ≈0.12–0.17 | 比 l5（0.152）轻 36% |
| `res_paper_l8` | 0.083 | ≈0.12–0.17 | 比 l7（0.155）轻 32% |

**第三批 prompt 的写法改变**（不再用形容词描述密度，改用可复现的几何指令）：
1. **禁止实心填充**：`no area is ever filled solid black; the darkest tone is parallel pen hatching with white paper visible between the strokes`。
2. **锁定排线占空比**：`the gaps between hatching strokes are as wide as the strokes themselves` —— 排线区恒定约 50% 覆盖率，这是唯一能让色调可预测的说法。
3. **锁定排线面积占比**：`hatch only <具体部位>，其余表面保持纯白` —— 用部位而不是程度来控制总量。

### 6.8 第三批（3 张）· 几何指令写法验证成功，但要给"墨液"开个口子

**paper l6 / l8 一次命中**：`density 0.160 / 0.138`，落在目标带 0.12–0.17 内，门禁直接通过。paper 全族现在 l4–l10 = `0.126 / 0.159 / 0.160 / 0.157 / 0.138 / 0.172 / 0.171`——齐整到这个程度，说明 §6.7 那三条几何指令（禁实心、排线间距=线宽、按部位而非程度控制排线面积）是可复现的写法，形容词不是。

**ink l7 再次落空，是我的 prompt 有缺陷**：目标 0.28–0.36，实际 **0.153**（比批 1 的 0.246 还低，已存 `art/leftover/res_ink_l7.candidate-b3-0.153.webp`，未采用）。病因是负向里的 `solid black fill / blacked-in shape / ink wash` ——**对墨水瓶来说瓶里的墨本来就是一块实心黑**，ink 全族 l4–l10 都是这么画的（density 0.344–0.514）。禁令一刀切下去，墨液变成了稀疏排线，密度直接砍半。

> **规则修正**：§6.7 第 1 条「禁止实心填充」的适用范围是**物体的材质表面**（玻璃、石棱、金属、纸），**不含被容纳的液体**。墨水瓶里的墨、溢出的墨渍照旧画实心黑——那是 ink 这一族的家族特征，也是它区别于其它四族的剪影依据之一。写 ink 的 prompt 时必须从负向里删掉这几个词。

### 6.9 第四批（ink l7 第三次）· 密度对了但笔触跑了 —— 「墨的画法」定版

`density 0.379`（目标带 0.30–0.38 顶端）、无画框、无蓝调，主体数量全对。**但笔触是另一支笔**：粗而均匀的描边 + 纯平涂实心黑，完全没有排线质感；同族 l4/l6/l8/l9 都是速写钢笔（细而有变化的线，墨是密排交叉线，近看能看出笔画）。存 `art/leftover/res_ink_l7.candidate-b4-0.379-wrong-pen.png`，未采用。

病因是我 §6.8 的修正过冲：prompt 写成 `SOLID BLACK MASS — completely opaque, no white showing through`，把生成器推进了平涂矢量模式，描边跟着一起变粗。

> **「墨」的画法定版（三档里取中间那档）**：
> - ❌ 排线间距=线宽（§6.7 通用档）→ density 0.153，太浅
> - ❌ 完全不透明平涂 → density 0.379 但笔触变粗描边+平涂，破坏"一支笔"
> - ✅ **密排交叉线，笔画几乎相接、区域远看近黑，近看仍是笔画，缝隙间留少量白点** ← ink 族专用档，就是 l6/l8/l9 的实际画法
>
> 一并写进 ink 的 prompt：`thin sketchy varied-width pen strokes throughout, bottle outlines thin and slightly broken, never a thick uniform contour`；负向补 `flat fill, solid flat black area, vector, sticker art, thick uniform outline, crisp clean edges`。

### 6.10 收尾状态与剩余工作（2026-08-19）

**美术侧已完成**：五轮出图共 30 张，落地 17 张，46 个分级帧全部通过 §6.7 门禁。被换下的旧帧与落选候选全在 `art/leftover/`（`pre-*` = 被替换的旧帧，`rejected-*` = 判定不合格，`candidate-*` = 同一槽位的落选版本），未删除。

**构建期长出的四道自动防线**（都是被真实事故打出来的，不是预设计）：

| 防线 | 触发事故 |
|---|---|
| 墨量倒挂门禁（§6.7） | 用户圈出 4 级墨水地"明显不是一种地" |
| 强制灰度化（§6.6） | 新图带蓝调 `b-r +6~+52`，老帧全中性黑 |
| 画框环扫描（§6.7 末） | `res_paper_l6` 带内缩 13px 的画框，边缘检测抓不到 |
| 实心平涂占比（§6.9） | ink l7 密度达标但变成粗描边+平涂，破坏"一支笔" |

**剩余工作**：§6.10 当时列的五项全部完成（2026-08-19，见 §6.11）。此后 2026-08-20 的实机复核又开出一项美术欠项——`res_sticker_l9/l10` 剪影退回重画（§6.12.1）；同日两帧全部重画落地（l9 用了两版），见 §6.12.5。

### 6.11 渲染层接线落地（2026-08-19 · §6.10 的五项全部完成）

**1. 整页重排 —— 选了「给 patch 脚本加重排能力」，没有恢复被删的源图集。**
`patchMergedAtlas.js` 现在比较帧尺寸自动分流：尺寸全同走原来的**就地回贴**（JSON diff 最小），任一帧尺寸变了就走新的**整页重排**——按**帧粒度**（不是原来的「每个源图集一整块」粒度）把合并页拆开重排，源图集有的帧取源图集的新像素，其余帧从旧合并页原样搬过来。这条路只需要合并页本身 + 那一个源图集，所以不必把 2026-07-27 删掉的 5 个图集（≈1 MB 二进制）重新塞回仓库、也不必让 `mergeAssetAtlases.js` 复活。副产品：旧页是整块拼的、带着每个源图集内部的空隙，利用率只有 32.9%，重排后 **2048×4550 → 1954×1828、86.3%**——顺带甩掉了「高度 4550 超过部分 GPU 4096 上限」这个一直存在的隐患。

> **两个踩到的坑，都留在脚本注释里**：
> - **不要用 sharp 的 `composite` 拼帧**：它为了混合会预乘 alpha，取整回来时每个抗锯齿边缘像素都会漂 1–2。这里帧落在空画布的互不重叠矩形上、根本不需要混合，改成裸的逐行 `Buffer.copy`，重排后**每一帧都与来源逐字节相同**——"这次重排有没有动到不该动的美术"才成为可验证的问题（实测：0 像素差）。
> - **sharp 0.32 的 `png()` 只要带上 `palette`/`quality`/`colours`/`dither`/`effort` 里任意一个就会静默转 8-bit 调色板**（合并页正是这么变成 palette-8 的）。而 6 个子图集合起来有 **392 种 RGBA**，256 格根本装不下：量化会动到 28–54% 的可见像素、单通道最大 43/255、**alpha 最大 12–38**——alpha 漂移直接体现为钢笔抗锯齿边缘发脆。现在只传 `compressionLevel: 9`，无损，代价是 1092 KB → 1747 KB。**⚠️ 补记（2026-08-20）**：当时这两条修正**只落在整页重排这一条路径**上，就地回贴那条两个坑都还留着，直到 §6.12.7 才一并修掉。这是个 CDN 托管、本地缓存、进场才懒加载的场景图集，不进微信主包（`ASSET_PACKAGING.md` §4），这 650 KB 换零漂移划算。

**2–3. 渲染层接线 + 两份渲染器合并（同一次改动）。** 纯计算下沉到 `@nw/shared/slg/core.ts`，挨着 `citySpriteTiles` 那批：`resMotifPlacement()`（返回 scale/alpha/rotation/x/y）、`resMotifJitter()`、`RES_MOTIF_SIZE_FRAC` / `RES_MOTIF_FOG_ALPHA`、`ResMotifFrameRead` 类型。两个渲染器各自只剩十来行贴图适配器，等级→尺寸/透明度逻辑一行不剩；抖动 `scale` 收窄到 `[0.96,1.04]`，`rot`/`dx`/`dy` 原样。图集的 `nw` 由各自的 `getResFrameRead(frameName)` 读 bundle 进来的 JSON 拿到（PIXI 的 Spritesheet 只保留它认识的键，`nw` 到不了 Texture）——沿用 `cityAtlasLoader.getCityContentTopFracForLevel` 读 `contentTop` 的先例。

**4. `Lv.N` 标签。** `drawResLevelLabel()`：`resLevelLabelText(level, tp)`（`@nw/shared`）决定画不画、画什么——`RES_LEVEL_LABEL_MIN_LEVEL = 6`、`RES_LEVEL_LABEL_MIN_TP = 64`；文案纯 `Lv.{n}`，沿用 2026-08-01 主城标签先例。实现是**一个共享 BitmapFont + 每个瓦片槽位复用一个 `BitmapText`**（按名字挂在瓦片 Graphics 上，不需要时只 `visible = false`），不是每格 `new PIXI.Text`——`resourceDensity=1.0` 下满屏都是资源格，每格一个 Text 就是每格一张 canvas 纹理，正好撞上已知的 Text 纹理销毁泄漏。配套改了 `WorldMapRenderer/pool.ts` 的槽位复位：原来只删 Sprite 子节点，现在**非 Sprite 子节点一律隐藏**——否则缩到 L2/L3（那两条路径根本不碰这个子节点）时标签会浮在没有母题的格子上。
> **刻意的不对称**：标签只在客户端画，map-editor 不画。编辑器里等级是设计师自己在 UI 里设的、本来就知道；标签是给玩家判断"这块守军打不打得过"的可供性，不是地形长相的一部分。这一条写在编辑器源码注释里，免得日后被当成漂移"修"回来。

**5. 验收。**
- `art/scripts/resContactSheet.js`：按游戏真实缩放（`tp × MOTIF_SIZE_FRAC × nw.sizeMul`、alpha = `nw.alphaMul`）输出 5 类 × l1–l10 总览，每格垫一个同 pitch 的菱形轮廓，好判断有没有溢出格子。它读的就是渲染层读的那份 `nw`，所以图集要是错的、这张表就跟着错，不会替它遮丑。产物 `art/slg/slg-map/res_contact_sheet.png`。
- 单测三层：`server/shared/test/core.test.ts` 钉公式本身；`client/test/ui/worldMapResMotifLevelRead.ui.ts` 拿**真实 bundle 的 `world_atlas.json`** 钉端到端（每帧都有 `nw`、alpha 落在 `[0.85,1]`、四类资源 l1→l10 占地严格递增且首尾正好落在 0.80/1.30、同 resType 同 level 200 组 `(tx,ty)` 每个都在均值 ±5% 内、`drawResMotif` 确实走共享公式、雾下只画类型帧）；`tools/map-editor/test/resMotifCallSite.test.ts` 用源码扫描钉编辑器确实路由过去（编辑器的 vitest 按设计不覆盖 PIXI 层，沿用 `rasterizeCallSites.test.ts` 的做法；已反向验证过：把 `sp.alpha` 改回 `0.55+0.45*(lv-1)/9` 会红）。
> **「包围盒极差 < 5%」的口径**：断言写成「200 个样本每个都在均值 ±5% 内」。抖动区间 `[0.96,1.04]` 的**极值比**是 1.083，本来就不可能小于 5%；真正要防的是"相邻同级格子看起来不一样大"，±5% 是对它更贴切也更严的说法。两个数都在测试里断言了。


### 6.12 实机复核（2026-08-20）· sticker l9/l10 剪影退回 + `Lv.N` 标签在真实密度下的定稿

§6.11 收尾后按游戏真实缩放出图（`resContactSheet.js`）+ 在真实客户端上按真实地图数据截图复核，得到三件结论：一条美术退回、一条判据的**否证**、一条标签定稿。

#### 6.12.1 `res_sticker_l9` / `res_sticker_l10` 判为 §6.2 #1 剪影违规 → 退回重画

§6.4 的重画清单只列了 sticker l8（贴纸卷），但 **l9/l10 是同一个毛病的更重版本**——它们来自 §5.7-sticker 那张表的「l9 = 卷+堆 / l10 = 铜钱仓（大卷+多高叠）」，而「卷」正是 §6.2 #1 明令禁止的**卷状物**。当时漏掉是因为 §6.4 是拿门禁跑出来的 B 类清单做底稿，A 类只补了肉眼过一遍——而 l9/l10 的卷被一圈散落星星包着，缩略图上不明显。

实机确认（`world:1:0` 的 sticker l9+ 最密区 `(872,998)`，L1 zoom）：l9 帧在地图上读成一个**光壁圆筒**，旁边点两颗星，是全屏唯一的平滑筒状剪影——既不像贴纸叠，也和 ink 族的圆罐撞脸。l10 稍好（叠体占比更高）但仍带一个立着的大卷。

**判决**：两帧退回，按 l6→l8 已经成立的家族画法（**星形贴纸叠 + 散落翘角星**，个数递增）重出。§5.7-sticker 那张表的 l8/l9/l10 三行（贴纸卷 / 卷+堆 / 大卷+多高叠）**作废**，以本节为准。

**门禁给出的密度目标带**（按 §6.7 判据在现有 sticker 家族 `l6=0.091 / l7=0.100 / l8=0.112 / l9=0.103 / l10=0.175` 上解出来的）：

| 帧 | 目标 density | 说明 |
|---|---|---|
| `res_sticker_l9` | **0.09–0.14** | 硬下限 0.077（被 l8 卡）；落在带内即通过 |
| `res_sticker_l10` | **0.12–0.20** | 硬下限随 l9 落点浮动（l9=0.13 时为 0.089）；必须 ≥ l9 |

> sticker 全族的 density（0.09–0.18）本来就比 ink（0.25–0.51）稀疏一大截——星形是空心轮廓件。门禁是**按族**判的，不要照 ink 的数值去堆密度，那会把星星画成实心黑块（§6.9 的老毛病）。

**出图 prompt**（接 §5.5 共用前缀 + §5.6 共用负向 + §6.5 两段增补，另加下面这段）：

共用负向再补（这两帧的病根词，必须显式禁掉）：

```
roll, rolled tape, sticker roll, spool, reel, tube, cylinder, can, tin, drum,
strip, tape dispenser, ribbon
```

主体句：

- `res_sticker_l9`：`A dense freestanding heap of five-pointed star-shaped stickers: three uneven stacks of stars crowded together at slightly different heights, each stack's star points and peeling corners sticking out past the edges of the stack, with a generous scatter of loose peeled stars heaped around and between them. Hatch only the visible side edges of each stack and the shaded half of each loose star; the star faces stay pure white. No area is ever filled solid black; the gaps between hatching strokes are as wide as the strokes themselves.`
- `res_sticker_l10`：`An overflowing freestanding hoard of five-pointed star-shaped stickers: five uneven stacks of stars crowded shoulder to shoulder at varied heights, every stack visibly made of stars — points and peeling corners jutting out all round its silhouette — with loose peeled stars spilling out of the gaps and heaped thickly around the base, the richest pile of the set. Hatch only the visible side edges of each stack and the shaded half of each loose star; the star faces stay pure white. No area is ever filled solid black; the gaps between hatching strokes are as wide as the strokes themselves.`

> **剪影自查**（§5.7-sticker 的老提醒仍然有效，且这次就是栽在这里）：每一叠都必须让**星形的尖角 + 翘角**戳出叠体轮廓，否则会糊成 paper 的「一摞扁矩形」；同时**不许出现任何平滑筒壁**，否则又变成本次退回的原因。
>
> 落地路径已通：帧长宽比会变、帧尺寸随之变，`patchMergedAtlas.js` 会自动走 §6.11 的**整页重排**分支，不再需要恢复 2026-07-27 删掉的源图集。顺序仍是 `pack_resources.cjs` → `patchMergedAtlas.js` → `resContactSheet.js` 目检。

#### 6.12.2 否证：剪影铁律**做不成构建期门禁**（别再试形状签名这条路）

§6.4 写了「A 类违规门禁看不见」，本次试着让它看得见：按 `pack_resources.cjs` 的同一条抠图管线取出 46 帧的**填洞后外轮廓**（背景 flood-fill，玻璃/纸面这类内部留白算进主体），算三个形状签名——`solidity`（轮廓面积 / 凸包面积）、`compact`（P²/4πA，平滑团≈1、锯齿轮廓远大于 1）、内部留白占比——再看每帧偏离本族中位数多少。假设是「同族十级同一主体」应当聚成一簇，违规帧应当是离群点。

**结果是明确的否证**：`sticker l9` 的 solidity 0.802 = 本族中位数、compact 比值 1.09；`l10` 是 0.878 / 0.99。两帧都躺在分布正中央。而已经人工判过合格的帧里，`metal l6` 的 compact 比值 3.32、`graphite l5` 2.69、`sticker l7` 1.98——离群程度是违规帧的 2–3 倍。

病因很朴素：l9/l10 的圆筒**被一圈散落星星包着**，锯齿的散星支配了外轮廓，平滑筒壁藏在凸包内部，全局形状签名根本触不到它。要抓「主体中间有一块平滑柱体」得上真正的形状检测（长直平行边 / 大面积平滑凸子区域），而这套稿子的线是刻意手抖的，误判率不会低——那已经不是「被事故打出来的一道便宜防线」（§6.10 那四道都是几十行的像素统计），而是一个会自己长出维护成本的分类器。

**结论：不建这道门禁。** 剪影铁律（§6.2 #1）继续靠**出图后目检**裁决，`resContactSheet.js` 是这条判据的唯一工具。已把测得的数据留在这里，免得日后有人再花一轮去试同一条路。

#### 6.12.3 `Lv.N` 标签：l6+ 这个阈值**根本没有限制屏上标签数**

§6.11 只在人造的高等级密集区看过标签。本次拿真实地图数据复核，先把 `proceduralTile` 在整张 1500×1500 上扫了一遍：

| | l1 | l2 | l3 | l4 | l5 | l6 | l7 | l8 | l9 | l10 |
|---|---|---|---|---|---|---|---|---|---|---|
| 占资源格 | 20.1% | 33.0% | 18.1% | 8.8% | 8.0% | 5.4% | 3.5% | 1.9% | 0.90% | 0.23% |

l6+ 合计 **11.9% 的资源格**（不是之前以为的 1.7%），而且**不是均匀撒开的**：世界中心一带有整块饱和区——扫出一个 **32×32 全部 ≥6** 的连续块（`(672,520)` 一带），另有 `(754,346)` 这样十级俱全的过渡带。低等级区是真的干净（`(160,160)` 一带 20×20 里 l6+ = 0）。

于是 `RES_LEVEL_LABEL_MIN_LEVEL = 6` 这个阈值的原注释（「不然会每格都有字」）**说反了**：在饱和区里 l6+ 就是每格都有字。实测（真实客户端，`showWorldMap` + reject-fast stub，L1 zoom）：

| 视口 | tp | 池内瓦片 | 饱和区可见标签 | 过渡带 | 低等级区 |
|---|---|---|---|---|---|
| 1920×1080 | 174 | 650 | **650 / 650** | 335 | 0 |
| 1080×2340 | 98 | 3660 | **2706 / 3660** | 714 | 60 |

**唯一在撑住可读性的东西是标签自身的字重**，而字重当时是 `tp * 0.13` 无上限：同一个 zoom 档，竖屏（1080 设计宽）tp=98 → 13px（合适），横屏（1920）tp=174 → **23px**（是母题自身宽度的 44%）。桌面上整屏读作一面文字墙，母题被自己的注解压住——正好把 §6 这一整轮美术工作盖掉。

**定稿：给字号加上限。** `resLevelLabelFontPx(tp) = clamp(round(tp × 0.13), 9, 17)`（`@nw/shared`，挨着 `resLevelLabelText`）。竖屏 13px 不变（主平台不动），桌面 23 → 17px，落回竖屏本来就有的那个字重。**策略不动**（仍是 l6+ / tp ≥ 64）：过渡带那张图证明标签是有用的——`Lv.10 → Lv.9 → Lv.8 → Lv.7 → Lv.6` 的等级带在屏上直接读成一条斜坡，正是 §6.2 #7 想要的可供性。改的只是权重，不是通道。

- 代码：`server/shared/src/slg/core.ts` 新增 `RES_LEVEL_LABEL_TP_FRAC / _MIN_PX / _MAX_PX / resLevelLabelFontPx()`；`client/.../tileGraphics/resources.ts` 只改 `label.fontSize` 一行。`RES_LEVEL_LABEL_MIN_LEVEL` 的注释按上面的实测改写（原文声称阈值能防「每格都有字」，实测不成立）。
- 测试：`server/shared/test/core.test.ts` 钉公式（到顶即停、下限、对 tp 单调）；`client/test/ui/worldMapResMotifLevelRead.ui.ts` 钉两个真实 tp 的落点（98→13、174→17）。已反向验证：改回 `Math.max(9, Math.round(tp*0.13))` 会红。
- **标签与母题重叠是已知且接受的**：标签在 `y = tp*0.15`，而母题半高最大能到 `0.20 tp`（`LEVEL_SCALE` 1.30 时）再叠 `dy` 抖动 0.09 tp——菱形内没有一处能容下不压图的文字。靠 BitmapFont 自带的白描边保可读，不再挪位。

> **留给用户拍板的一条（本次没动）**：竖屏 L1 一屏 **3660** 格。这不是标签问题，是 zoom 档位问题——`makeZoomCfgs` 的最近档是 `floor(w/11)`，竖屏设计高远大于横屏，同一个除数在竖屏摊出的格数是横屏的 5.6 倍。要么给竖屏单独收紧最近档的除数，要么加第四档。改动会影响整张地图的观感，不在本任务范围内。

#### 6.12.4 §6.11 两处取舍：复核后**都保留**

- **合并页无损编码**（1092 KB → 1747 KB）：保留。这是 CDN 托管、进场才懒加载、不进微信主包的场景图集（`ASSET_PACKAGING.md` §4），而 palette-8 的代价是 alpha 最多漂 12/255，直接体现为钢笔抗锯齿边缘发脆——本轮整套工作的落点就是这批线稿的手感，用它换 650 KB 不划算。真要改回去是一行（`patchMergedAtlas.js` 的 `png()` 传 `palette: true, dither: 0`）。
- **「同级包围盒 200 样本各自在均值 ±5% 内」**：保留。抖动区间 `[0.96,1.04]` 的极值比是 1.083，原口径「极差 < 5%」数学上不可满足；真要按极值比 < 5% 收，得把抖动收到 `[0.975,1.025]`，代价是同级格子的大小变化几乎看不见了（抖动存在的理由就是打破印章感，见 `resMotifJitter` 注释）。两个数（±5% 与极值比 1.083）测试里都断言了。

#### 6.12.5 重画（2026-08-20）：l10 一次命中，l9 第二版命中（第一版满幅平铺、无外轮廓）

`res_sticker_l10` **落地**：density **0.259**（目标带 0.12–0.20 之上，门禁全绿——l9 只要不超过它就行，方向对），画成一个**穹顶状堆体**，外轮廓一圈星尖，画幅四角留白，格子里一眼读成「一大堆星星贴纸」。旧帧存 `art/leftover/res_sticker_l10.pre-2026-08-20-roll.webp`。

`res_sticker_l9` **退回**（存 `art/leftover/res_sticker_l9.rejected-2026-08-20-no-silhouette.webp`）。density 0.181 达标、无蓝调、无画框、无筒壁——**剪影这一关反而输得更彻底**：生成器把「filling the frame edge to edge / no large empty areas」当成了「把画布铺满」，星星一直铺到四个角，内容 bbox 占原图 99%×95%、aspect 1.03，抠图后就是一个**正方形**。contact sheet 上它读成一块方形噪点，连「是个东西」都读不出来，比它要替换的卷筒更糟（§6.4 里 `paper_l6` 那次「糊成方块」是同一个失效）。**l9 暂时恢复旧卷筒帧**——一个族不对但读得出来的物件，仍然是比一块噪点更小的害。l9 是当前唯一的美术欠项。

> **写 prompt 的教训**：§6.5 那句「填满画幅、不留大块空白」对**单体/小簇**是对的（它当初解决的是留白浪费密度），但对「一堆」这种主体是**歧义**的——l10 同一句话出了穹顶、l9 出了平铺，等于抛硬币。凡是主体为「heap / hoard / pile」的帧，必须**另外显式约束外轮廓**：说清「一个土丘、四角留白、轮廓要能看见」，并且用**个数 + 单颗占画幅比例**（几何量）来控制铺满程度，而不是「填满」这种程度词——这和 §6.7 用几何指令替形容词是同一条原则，只不过这次要管的量是**构图**而非色调。

**l9 重出 prompt**（GPT Image 2 单段版，已把上面那条教训写进去；负向折进正文）：

```
A hand-drawn doodle icon for a strategy-game map tile, drawn in a worn school notebook with one dark-ink pen. Slightly wobbly imperfect strokes, like a teenager sketching in the margins, but clean enough to read at a small size. Flat 2D line art in neutral black ink on a plain pure-white background — no colour anywhere, no blue or navy tint to the ink, no grey background, no notebook grid or ruled lines, no drop shadow, no ground line, no text, letters or numbers, and no drawn border or frame of any kind around the image.

The subject is ONE single low mound of five-pointed star-shaped stickers, seen from slightly above and to one side, standing alone on empty white paper. Its outer edge must be clearly visible all the way round as a spiky star-tipped silhouette, and all four corners of the picture stay empty white — this is one object on a page, NOT a pattern and NOT stars tiled across the whole canvas. The mound is wider than it is tall, roughly two thirds as tall as it is wide. It is built from three uneven stacks of stars leaning together, with about eight loose peeled stars scattered around and between their bases. Draw about twenty stars in total and no more, big enough to count: the largest star spans roughly one third of the picture's width. Every stack must visibly be made of stars — star points and peeling corners sticking out past the edges of the stack all the way round. Do not draw any roll, rolled tape, sticker roll, spool, reel, tube, cylinder, can, tin, drum, strip of tape, tape dispenser, ribbon, box, crate, tray, rack or container of any kind: nothing in this picture may have a smooth curved wall. Do not let the stacks read as a pile of flat rectangular sheets either.

Tone: hatch only the visible side edges of each stack and the shaded half of each loose star; every star face stays pure white. The white gaps between hatching strokes are as wide as the strokes themselves. No area is ever filled solid black, and there is no flat opaque fill and no thick uniform contour — the darkest tone in the picture is parallel pen hatching with white paper visible between the strokes.

The mound sits centred and takes up most of the picture's width, leaving a clear white margin all round it. Style of West of Loathing / doodle art — no painterly rendering, no shading gradients, no glow, no 3D render, no photorealism, no clean vector look, no thick bold cartoon outline.
```

收图判据：density 只要落 **0.09–0.18**（下限 0.077 由 l8 卡，上限只需低于 l10 的 0.259，门禁会判）；真正要看的是 **① 抠图后 aspect 不能接近 1.0 且内容 bbox 不能占满原图**（平铺的标志，`pack_resources.cjs` 打印的 `w×h` 一眼能看出来）、**② 星星能数得出来**（跟 l6–l8 一族）、**③ 没有筒壁**。

**第二版一次命中并落地**：density **0.098**、内容 bbox 占原图 **92%×60%**、抠图后 **128×84（aspect 1.52）**——对照第一版的 99%×95% / aspect 1.03，「显式约束外轮廓 + 用个数和单颗占比控制铺满」这条写法是有效的，和 §6.7 那三条几何指令是同一性质的可复现写法。画面是三叠不等高的星叠靠在一起 + 约八颗散星堆在底部，星形数得出来、四角留白、无筒壁。实机 tp=174 下和 metal/paper 的簇状母题互不撞。第一版存 `art/leftover/res_sticker_l9.rejected-2026-08-20-no-silhouette.webp`，中途顶班的旧卷筒帧存 `res_sticker_l9.interim-roll-2026-08-20.webp`。

> **顺手证否的第二条美术判据：构图也做不成门禁。** 既然「满幅平铺」这个失效很具体，试过拿**内容 bbox 四角的墨覆盖率取最小值**当判据（墙纸四角都有墨 → 最小值高；正常主体至少一角留白 → 最小值低）。实测分不开：被退回的那张是 **0.138**，而已判合格的 `res_metal_l9` 是 **0.124**、`res_ink_l6` 是 **0.212**——最差的合格帧比违规帧还高，排序是反的。和 §6.12.2 的剪影一样，**构图判据也只能靠 `resContactSheet.js` 出图人眼裁决**，别再试这条路。

> **一条已知、按契约接受的软观感**：我在 prompt 里要了「wider than it is tall」（本意是和 l10 的穹顶区分开），结果 l9 用掉的垂直空间比 l8 那朵星花少，扫一眼时**质量感略轻于 l8**。占地曲线确实给了它 +16% 的面积（`levelScale` 1.2444 vs 1.1556，等面积归一），而 §6.7 已经明确把相邻等级的可分辨性交给「占地曲线 + 物件数 + l6 起的 `Lv.N` 标签」三条通道、不压在墨量上——所以这在既定契约之内。若日后想让 l9 读得更重，把 prompt 里那句宽高比改成「和 l8 差不多高、但叠数更多」再抽一版即可，不必改代码或判据。

**顺手修掉的一个打包期 bug**：`pack_resources.cjs` 的主扫描 `^res_.*\.(webp|png)$` 会把**自己这条管线的产物** `res_contact_sheet.png` 当成第 51 个源帧收进图集（`resContactSheet.js` 就写在同一个目录里，§6.11）。之前没暴露是因为上一轮的顺序恰好是「先打包、后出 contact sheet」；这一轮重跑时它就进去了。现在按文件名显式排除（而不是给 contact sheet 改名/换目录——它的路径写在文档里，也是目检习惯的一部分）。

#### 6.12.6 sticker 的 tan→gold 色带在屏上**基本不存在** → 用户拍板取消，五族统一黑墨

复核新 l10 时顺手量了一下「铜→金」这条色带到底有多少落在屏上。把每帧按 alpha 合成到地图纸色 `#f2ece0` 上取均值（也就是眼睛实际拿到的颜色），暖度 `r-b`：

| | sticker l6 | l7 | l8 | l9 | l10 | graphite l10（**免色带**） | 纸色本身 |
|---|---|---|---|---|---|---|---|
| `r-b` | 16.5 | 16.6 | 16.3 | 16.6 | 14.5 | **14.6** | 18.0 |

sticker 各级之间**没有梯度**，而且和明确豁免色带的 `graphite_l10` 一模一样（14.5 vs 14.6）——色带贡献可视为 0，`tan → gold` 的等级斜坡在屏上读不出来。

**病根是结构性的，不是参数没调对**：`applyBand` 是对帧 RGB 做**部分乘法**，而这批帧经过 §5.8 的抠图后只剩「近黑线芯（RGB≈0–40，不透明）+ 半透明灰边（RGB=luma，alpha=255−luma）+ 全透明留白」。乘法对近黑像素无能为力（`0 × 任何颜色 = 0`），而占面积最大的留白是**全透明**、上屏拿的是纸色而不是色带色。色带是 2026-07-17 之前 sticker 还是「母题 + 合成计数托盘」（有大片实心填充区）时设计的，`bakeCountFrames` 一删它就失去了作用对象——只是没人量过，`§5.7-sticker` / `§5.9` 至今仍把它当成活着的主题加分项在写。

**拍板：取消色带（2026-08-20，用户拍板）。** 铜矿和其余四族一样是纯黑墨，只靠五角星剪影区分。

理由不只是省事：**这张地图上的颜色是功能性的，已经被归属占满**——自己蓝 / 敌人红 / 同宗门紫 / 结盟宗门琥珀（ADR-003 / ADR-060）。真把铜矿做成金色，它就会在敌方红、盟友琥珀的格子里和「这块地是谁的」抢读，而后者是玩家每一眼都要读的信息。同时实测五角星剪影**已经够用**（§6.12.5 的实机放大图里星形在 tp=174 的格子上清晰可辨）。曾考虑的另两条路都记在这里免得重新讨论：把颜色烘进 `nw.tint` 让渲染层照读（唯一不破 §6.11「渲染层零等级逻辑」的保色方案，但抢读问题照旧）；打包期垫底色 wash（会动「白底线稿」这条美术铁律，且 wash 浓度又是一个需要门禁的自由参数，§6.7 的老教训）。

**已执行**：`pack_resources.cjs` 删掉 `BAND` / `BAND_STRENGTH` / `applyBand` / `tintLevelFrame` 及其调用（原位留了一段注释记录为什么不要再加回来——**若日后真要按级上色，正确做法是烘进 `nw`，不要在打包期再加 tint pass**）。重跑后 sticker 暖度 `r-b` 从 16.5/14.5 变成 16.4/13.3，也就是删掉前后眼睛看不出区别——这本身就是色带无效的最后一道确认。文档里把它当活功能写的地方（顶部决策变更 II、§5.7-sticker、§5.8、§5.9、§6.6）已一并订正。

#### 6.12.7 顺带修掉：`patchMergedAtlas.js` 的**就地回贴**路径一直在做有损量化 + 混合漂移

§6.11 记的两个坑（「不要用 sharp 的 `composite` 拼帧」「`png()` 带 `palette` 会静默转 8-bit」）当时**只修了整页重排那条路径**。就地回贴那条（帧尺寸没变时走的分支，也是日常跑得最多的一条）两个坑都还在：

```js
.composite(composites).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
```

于是**合并页的编码取决于「这次有没有帧尺寸变化」**——变了走重排、无损；没变走就地、量化成 palette-8（alpha 最多漂 12–38，钢笔抗锯齿边缘发脆）。这一轮正好撞上：删色带只改像素不改尺寸 → 走就地 → 页面从 1746 KB 掉到 1088 KB，`paletteBitDepth` 变 8。差一点就把上一轮刚换来的无损又丢回去，而且**没有任何报错**。

**修法**：就地回贴改成和重排同一套做法——裸的逐行 `Buffer.copy`（帧各自落在互不重叠的矩形里，`composite` 的混合本来就没有作用对象），编码只传 `compressionLevel: 9`。

**验收**（这就是无损+逐字节的意义所在，"这次回贴有没有动到不该动的美术"变成可回答的问题）：
- 50 个回贴帧与 `res_atlas.png` 中的来源**逐字节相同**：50/50
- 39 个搬运帧与回贴前的合并页**逐字节相同**：39/39
- 页面 1727.7 KB，非 palette。

#### 6.12.8 第三处同类 bug：`pack_resources.cjs` 自己写 `res_atlas.png` 时也在量化 + 混合

加测试时（§6.12.9）撞出来的：`pack_resources.cjs` 的最终合页也是

```js
.composite(composites).png({ palette: true, compressionLevel: 9, effort: 10 })
```

也就是**同一对 sharp 陷阱在这条管线里出现了三次**——合并页的整页重排（§6.11 修）、合并页的就地回贴（§6.12.7 修）、以及这里的源图集本身。而这一处是**最上游**的：`res_atlas.png` 一被量化，下游那两处修得再干净也只是在无损地搬运已经损坏的像素。

**实测损伤在 alpha，不在颜色**（我最初判断错了，写在这里免得后人重复这个误判）：把「每个可见像素必须中性」写成断言时它在量化图上炸了，报 spread 37；但逐像素量下去，**那些像素全部在 alpha 下限之下**（不可见），可见像素的非中性比例前后都是 **0.0%**。真正的损失是 alpha 精度：**240 个不同 alpha 值被压到 143**。而这批帧是白底抠图的线稿，**alpha 就是画本身**——每一笔和每一条抗锯齿边缘都由它承载，所以这是实打实的边缘发脆，正是 §6.11 为合并页付过 655 KB 去避免的那件事。

**修法**：和另外两处统一——裸的逐行 `Buffer.copy` 拼页（帧之间有 `PAD`，互不重叠，`composite` 的混合本来就没有作用对象）+ 编码只传 `compressionLevel: 9`。

**代价（需要知情）**：`res_atlas.png` 415 KB → **904 KB**，**但它不在发布路径上**——客户端只 import 合并页（`client/src/render/atlas/resAtlasLoader.ts` 里只有 `world_atlas.json`），`res_atlas.png` 是 `patchMergedAtlas.js` 的输入 + map-editor 这个开发工具读的图集。真正影响发布体积的是合并页：**1723 KB → 2001.5 KB（+278 KB / +16%）**，因为它现在承载的是真无损的灰阶而不是量化过的。这和前两次的判断一致（CDN 托管、本地缓存、进场懒加载、不进微信主包，`ASSET_PACKAGING.md` §4），且这一次买到的是「§6.6 的强制灰度化 + alpha 精度在成品里真的成立」。**若哪天要压体积，正确的做法是压合并页的内容（帧数/尺寸），不是把量化加回来。**

#### 6.12.9 管线测试补齐（2026-08-20）

这条管线（`pack_resources.cjs` → `patchMergedAtlas.js` → `resContactSheet.js`）此前**零测试覆盖**，而今天挖出的三个 bug 全是静默的：没有报错、没有数字变化、只有事后逐像素量才看得见。补了 4 条断言在 `client/test/ui/worldMapResMotifLevelRead.ui.ts` 的新 `describe('the shipped atlas artifacts')` 里——**都是对提交进仓库的成品文件断言**，不依赖脚本内部实现，所以脚本重写也不会失效：

| 断言 | 挡住的事故 | 反向验证 |
|---|---|---|
| `res_atlas.json` 恰好 50 个 `res_*` 帧 | contact sheet 被当第 51 个源帧收进去（§6.12.5 末） | 去掉排除 → 红 ✅ |
| 两个 PNG 都不是 palette 编码；`res_atlas` 可见 alpha 值 > 200 种 | 三处 `palette: true`（§6.11 / §6.12.7 / §6.12.8） | packer 加回 `palette: true` → 红 ✅ |
| 合并页里每个 `res_*` 帧与 `res_atlas` **逐字节相同** | `composite` 的 alpha 预乘漂移；顺带也挡住量化和「回贴动到了不该动的帧」 | 回贴改回 `composite` → 红 ✅ |
| 每个帧的**可见**像素中性（channel spread ≤ 2） | 重新加 tint pass / 丢掉强制灰度化（§6.6 / §6.12.6） | — |

> **一个必须写下来的口径**：中性断言只算 `alpha ≥ ALPHA_TRIM` 的像素。不加这个下限的版本会在量化图上因为**不可见**像素而失败——报的是 37 的 spread，但那些像素肉眼根本看不到，可见像素前后都是 0.0% 非中性。也就是说**这条断言并不能抓量化**（抓量化的是 palette 那条），过紧只会让它为了一件和它无关的事变红。测试的门槛要对着它真正守的东西设。
>
> **仍然没有测试的**：`resContactSheet.js`（产物是给人看的，它错了人眼当场就发现）、以及 §6.12.2 / §6.12.5 两次证否的美术判据（剪影、构图都做不成门禁）。
