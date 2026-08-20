# 面板边框 AI 化 + 九宫装配 — Prompt 文档

> 创建：2026-08-20 · 状态：**已落地**（程序生成图集 + sprite 九宫装配；三版 AI 出图全部打回，记录见 §3.3/§3.4，落地结果见 §5）
> 配套代码（改动落点）：[`client/src/render/sketchUi.ts`](../../client/src/render/sketchUi.ts) 的 `sketchPanel` / `sketchButton` / `sketchAccentBar`
> 美术总纲：[`art-direction.md`](art-direction.md) §0（资产分工）/ §6.2（抠白底管线）· [`art-direction-map-ui.md`](art-direction-map-ui.md) §7.5（按钮与菜单 —— 本次要**修订**其中一条口径，见下方 §1）
> 同类文档（管线沿用）：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（批 1–4）· [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md) · [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)

---

## 0. 起因与实测数据

用户圈图反馈世界地图 HUD 的面板"都是方的，不如圆角好看"，并提出"背景框种类不多，不如直接出图 + 九宫缩放"。

**排查结论：面板"看着方"不是因为没做圆角。** §7.5 明文要求「矩形 + 不规则手绘描边（非完美圆角）」，全游戏面板/按钮都走单一出口 `sketchPanel`（**238 处调用 / 86 个文件**），而 `SketchPen.rect` 确实在抖（±2.5px 角部过冲 + 双笔 ghost + 沿边 `segLen=10` 重采样抖动）。真正的原因是**笔触幅度不随面板尺寸走**：`pen.jitter = 1.1`，画在 20px 的徽章上读得出来，画在 320px 宽的面板上占比不到 1%，眼睛读到的就是直角矩形。

**排查中量出一个此前不知道的性能问题。** 拿世界地图 HUD 真实的 13 个面板尺寸（`headerHud.ts` / `hud.ts`：兵力条 300×78、buff 行 300×30 ×2、行军/录像按钮 300×44、行军列表 300×220、召回 96×36、立返 120×36、战报徽章 300×40、聊天条 1920×56、未读徽章 22×18、缩放按钮 90×44、toast 520×60），在 `vitest.ui.config.ts` 的 headless PIXI harness 里量：

| 方案 | CPU 建几何 | 顶点数 | 合批 |
|---|---|---|---|
| **现状**（SketchPen Graphics） | **8.6 ms** | **132,300** | **13/13 不可合批** → 13 次强制 `batch.flush()` + 13 次直绘 |
| 九宫 · 边**拉伸**（4 角 + 4 个缩放边） | 0.15 ms | 468 | 104 sprite 共用一张底图 → **1 次合批** |
| 九宫 · 边**平铺**（振幅与尺寸无关） | **0.20 ms** | **1,076** | 256 sprite 共用一张底图 → **1 次合批** |

单看聊天条（1920×56）：47,788 顶点 / 3.9 ms。

**而这一整套每秒重建一次** —— [`WorldMapRenderer/lifecycle.ts:53`](../../client/src/scenes/worldmap/WorldMapRenderer/lifecycle.ts:53) 的 `hudTickTimer >= 1 → renderHud()` 无条件跑（为了让行军倒计时不冻住，P1-1 引入）。8.6 ms 是开发机 JIT 预热后的数；低端机 / 微信小游戏按 3–5× 估（**未实测真机**），即每秒一次 30–50 ms 的卡顿。

机制侧两条确认（读 pixi 源码，非推测）：
- `GraphicsGeometry.BATCHABLE_SIZE = 100`，`isBatchable()` 是 `points.length < 200`，即**不到 100 顶点**才合批。sketch 面板动辄上万顶点，全部走 `renderer.batch.flush(); _renderDirect()`（[`Graphics.js:365`](../../client/node_modules/@pixi/graphics/lib/Graphics.js:365)）——它不只自己占一次 draw call，**还打断周围内容的批**。
- `pixi.js-legacy@7.4` 打包了 `NineSlicePlane`，但它是 `Mesh`，不参与 sprite 批渲染 → **本方案不用它**（见 §2）。

**所以出图 + 九宫不是性能风险，是性能净收益（43× CPU / 130× 顶点 / 13 次 flush → 1 次合批），顺带才解决"看着方"。** 这是当初把所有自绘框收敛到单一出口的最大一次红利：238 处调用点一处不改。

---

## 1. 拍板

1. **面板边框改走 AI 图 + 九宫装配。** 这是对 `art-direction.md` §0 资产分工边界的又一次扩展，但**理由跟前六批不同**：前六批是"辨识度要求高、程序笔触画不出足够细节"，本次实测下来"细节"这条站不住（4–8px 线宽里没有像素容得下墨点积聚/纸纤维/笔尖分叉，详见 §3.3 的认知修正）。本次的真实理由是：**① 性能——这是唯一能解 §0 那个每秒 8.6 ms / 132k 顶点 / 13 次 flush 的路子；② 抖动幅度和转角形状改由打包时决定，摆脱"程序笔触幅度不随面板尺寸走"这个病根。**
2. **转角做"手绘圆转角"：真的圆，但四个角圆得不一样。**（2026-08-20 v1 打回后修订，原文是"不做等半径圆角 / 靠角部过冲 + 墨团"，见 §3.3）
   - **不做**等半径圆角（CSS `border-radius` 那种）：那是通用手游 UI 的语言，跟纸底 + 格线 + 红装订线并排会打架；而且四个角、每个面板都一模一样，正是要摆脱的机械感，还会让 `seedFor` 的 per-instance 变化无处可用。
   - **不靠大墨团**：实测（§3.3）墨团要压到 ≤3 倍线宽才装得进 30–44px 高的面板，那个尺寸下它读成"角上一个点"而不是"墨积聚"，而且**墨团盖在尖角上，尖角还在下面**——治不了"太尖锐"。
   - **做**：手转过去的圆角——半径约 2–3 倍线宽，**四个角半径/松紧各不相同**，部分角带一小截过冲尾巴。
   - **这一条不需要修订 §7.5。** §7.5 的原文是「非**完美**圆角」，禁的是等半径/模板画的圆角，不是"圆"本身。手转的不等半径圆角恰恰就是它要的东西——反倒是 v1 那张"尺子画出来的直角方框"违背了 §7.5 的本意。
   - 附带收益：转角半径 2–3 倍线宽 → 角块约 **20 设计 px**，比墨团方案的 51–102px 小一个数量级，**所有面板尺寸都装得下**，`sketchPanel` 的小面板降级路径能少走很多。
3. **§7.5 需要修订一句口径**（接线时落）：原文说 `sketchPanel` 是「平涂 + `SketchPen.rect` 涂鸦边框」，改为「平涂（`Graphics`）+ 九宫装配的手绘边框位图」。「替代 `drawRoundedRect`」「按钮非完美圆角」两条结论不变。
4. **颜色走运行时 `Sprite.tint`，不在打包时烤死。** 见 §4。
5. **先试点再铺开。** 只出**一张**源图，只接世界地图 HUD 的 4–5 个框，真机截图并排看，过了再改 `sketchPanel` 全局。沿用批 1「3 图小批验风格」的纪律。

---

## 2. 装配方案（几何契约）

### 2.1 为什么不用 `NineSlicePlane`

它是 `Mesh` → 每个框一次独立 draw call，等于退回现状的 draw call 数。改为**自己用 Sprite 拼**：所有切片来自同一张图集 baseTexture → 全部进 sprite 批渲染器，一屏所有框合成 **1 次** draw call。

### 2.2 为什么边"平铺"而不是"拉伸"

拉伸会把墨线的抖动周期按面板宽度成比例拉长，读出来是"被拉变形的线"，而且**振幅仍然不随尺寸走**——那正是"看着方"的原始病因，换成位图也治不好。平铺则让振幅永远是原生的，与面板尺寸无关。实测代价：0.20 ms vs 0.15 ms，等于免费。

### 2.3 为什么"长条 + 顺序开窗"而不是"小块循环贴"

小块循环贴要求切块**自身左右可拼接**（左端墨线的进入 y / 角度 / 粗细要等于右端的出去 y / 角度 / 粗细）。**AI 出图无法可靠满足这个约束**，硬要就得反复重出。

改为：画**长边条**（最终是程序生成，见 §4；当时的设想是从一张手绘矩形源图里切）；运行时沿边**按顺序**贴该长条的连续窗口（`new PIXI.Texture(base, new Rectangle(...))`）。相邻窗口本来就是同一条线的前后段，**接缝在构造上不存在**——那只是"继续往下读同一条线"。

只有面板比长条还长时需要回绕。改走程序生成之后这一条也没了：抖动用的是**循环** noise，长条首尾天然接得上（§4），聊天条那个 1920 > 1024 的回绕不再有接缝。

### 2.4 运行时装配（`sketchPanel` 新实现）

对一个 `w × h` 面板：

1. **底色**：`Graphics.beginFill(fill, fillAlpha).drawRect(0, 0, w, h)` —— **完全不变**，4 顶点，可合批。
2. **四角**：4 个 corner sprite 贴在四角，原生缩放，`tint = border`。
3. **上边**：从 `frame_edge_h` 长条的 `offset` 处开始，向右连续开窗铺满 `[CORNER, w - CORNER]`，每个 sprite `tint = border`。
4. **下边**：同上，用**不同的** `offset`（否则上下两条边一模一样，一眼假）。
5. **左/右边**：用 `edgeV` 长条（另一条独立波形的长条，sprite 转 90° 贴上去；不跟横边共用同一条波形，否则四条边一眼看出同源）。
6. **`opts.seed`**：不再是 no-op —— 用它派生 4 条边各自的 `offset`、以及角块的左右/上下翻转位。**238 处调用点传的 seed 全部继续生效**，per-instance 的手绘差异保住（这也解决了我原先担心的"换图后 `seedFor` 失去意义"）。
7. **`opts.width`**：实测调用点用到 9 种粗细（`2`×42、`1.6`×13、`2.6`×11、`2.4`×11、`1`×9、`1.2`×7、`1.8`×3、`1.5`×3、`5`×2）。图集烤 **3 档**：`1.2 / 2.0 / 2.6`，运行时取最近档。`width: 5` 那 2 处归到 `bold`（比原来细，留观察，见 §6）。
8. **小面板降级**：`w < 2 × cell` 或 `h < 2 × cell` 时无处放两个角块。落地后 `cell` 按幅度档算出来是 **12 / 15 / 18** 设计 px（阈值 24 / 30 / 36），全项目只有聊天未读徽章 22×18 会触发。此时**退回现有 `SketchPen` 画法**（小尺寸下程序抖动本来就读得出来，也没有性能问题）。阈值和分流写在 `sketchPanel` 里，调用点无感。

### 2.5 迁移面（已查实）

`sketchPanel` 返回类型从 `PIXI.Graphics` 变成 `PIXI.Container`，这是**唯一**的破坏点：

- **18 处**把返回值当画布继续画，绝大多数是 `sketchAccentBar(box, ...)`（AchievementScene / CardCodexScene/tile / FriendsScene×4 / LeaderboardScene / StatsScene/panels×2 …）。把 `sketchAccentBar` 的首参从 `PIXI.Graphics` 改成 `PIXI.Container`、内部自己挂一层 `Graphics`，**这 18 处一行都不用改**。
- **1 处**直接 `new SketchPen(bg, ...)`：[`LobbyScene/vsOverlay.ts:50`](../../client/src/scenes/LobbyScene/vsOverlay.ts:50)，单独收。
- 显式标注 `: PIXI.Graphics = sketchPanel(...)` 的：**0 处**。
- `tearDownChildren` / `disposeChild`（[`sketchUi.ts`](../../client/src/render/sketchUi.ts)）已经会递归进子容器，且对非 Text 叶子用 `texture: false` ——**共享图集 baseTexture 不会被误销毁**，这条现成的契约正好覆盖新结构，不用改。

---

## 3. 出图尝试（三版全部打回，**最终未采用**）

| 文件名 | 尺寸 | 内容 |
|---|---|---|
| `art/ui/panelframe/panelframe_base.png` | 正方，≥1536×1536 | **一个完整的手绘矩形边框**，白底黑墨，框内空白 |

一张图同时供出 4 个角块 + 4 条长边条（打包脚本切，见 §4），**style 一致性因此免费**——四角和四边出自同一支笔、同一次落笔。

### 3.1 Prompt（v3 候选 —— v2 打回后只改转角标定和抖动的"次数/波长"，见 §3.3）

```
A single large rectangle border hand-drawn in dark ink on a clean white sheet of
paper, filling most of the frame with a generous even white margin on all four
sides, and nothing else in the image at all.

THE CORNERS. Every one of the four corners is a turn the hand rounded as it went
— not one of them is a sharp point, and not one of them is a wide sweeping curve.
Each turn rounds over a radius of between two and three and a half times the
line's own thickness: small enough that the corner still reads as a corner, large
enough that it is clearly not pointed. Within that narrow range the four differ
from one another — the tightest about twice the line thickness, the loosest about
three and a half times, the other two in between — so no two corners match, but
none of them falls outside the range. Do not leave any corner almost square, and
do not let any corner balloon into a long arc that eats into the sides. On one or
two of the four corners only, the pen carried a little past the turn and left a
short stub tail sticking out beyond the corner, no longer than twice the line's
thickness. The ink runs a touch heavier through each turn where the hand slowed,
but only a touch — no big round blot or blob at any corner, nothing that reads as
a dot, rivet, screw head, or tack.

THE FOUR SIDES. Each side stays level over its whole length — the top and bottom
horizontal end to end, the left and right upright end to end — with NO long slow
bow, sag, droop, lean, arc, or taper: a side must never wander away from level
over a long stretch before coming back. Within that, no side is a straight line
either. Each side is covered end to end by MANY separate small excursions — at
least twenty along each side — where the line strays off true and returns: each
single excursion reaches about two to three times the line's own thickness away
from true at its widest, and completes and comes back within roughly five to ten
times the line's thickness of travel along the side. The result reads as a busy
hand-drawn waver repeating the whole way along, NOT as one or two big smooth
curves bending the whole side, NOT as a tight fine tremble, and NOT as a sharp
angular zigzag. The line's thickness also swells and thins unevenly along its
length, the ink runs darker where the pen slowed and lighter where it sped up, and
in a few short stretches the pen was retraced so a faint second stroke runs
alongside the first before merging back in.

Uniform flat dark ink of a single value throughout, roughly hex 2C2C2A, drawn
with a fine ink pen by a talented teenager in a school notebook. Plain clean white
background, absolutely empty inside the rectangle and outside it.

Avoid: sharp pointed mitred corners, any corner left almost square, any corner
rounded into a wide sweeping arc, all four corners rounded the same amount, an
even uniform corner radius, a corner arc drawn round a template or compass, the
rounded-rectangle look of a printed box or an app UI panel. A big ink blot, blob,
dot, rivet, screw head, or tack at any corner. One or two big smooth bows spanning
a whole side, a side that drifts off level and returns only once, a sagging or
bowed or leaning side. Ruler-straight sides, sides drawn along a straightedge,
technical or drafting precision, a tight jittery tremble, a sharp angular zigzag.
A second inner or outer rectangle, a double frame, nested boxes, ruled or dashed
or dotted lines. Corner ornaments, flourishes, scrollwork, washi tape, paper clips,
staples, torn or deckled paper edges, folded corners. Any text, letters, numbers,
handwriting, labels, signature, watermark. Any hatching, cross-hatching, shading,
gradient, drop shadow, glow, texture fill, paper grain, watercolor, or color of
any kind. Any perspective, tilt, rotation, or 3D depth. Any side that fades out,
tapers to nothing, or breaks into a long gap. Any content inside the rectangle.
```

### 3.2 四条硬约束 —— 为什么单独拎出来

前六批的教训是「判断阶段就点名的高危项写进 Avoid 就不会被打回」（批 5 因此 0 打回）。v1 打回的两条（1、2）现在都进了 Avoid：

1. **抖动幅度**（v1 在这条上被打回）。**指标：偏离直线 2–3 倍线宽**。v1 实测只有 **0.06 倍**（p90 0.13、max 0.19），比现在的程序笔触（`jitter 1.1 / width 2.2` = 0.50 倍，加 ghost 第二笔有效散布约 0.9 倍）**直 5–15 倍**，接进去只会比现状更方更硬。
2. **抖动波长**（v1 未测，但 D 行实验暴露了这个坑）。只放大振幅不放大波长会读成**锯齿**而不是手抖——把 `pen.jitter` 从 1.1 直接调到 4.0（`segLen` 不变）就是这个下场，见 §3.3 的对比图 D 行。所以 prompt 里把"每次起伏跨 5–10 倍线宽"和 Avoid 里的 `sharp angular zigzag` 一起写进去。
3. **四条边不能整体下坠/倾斜/弯弓。** 手绘矩形最常见的失真就是上边中段下沉。一条下沉的边被切成长条后顺序平铺，会在面板上表现为**阶梯状错位**。缓解不止靠 prompt —— §4 的打包脚本**强制做一步去漂移**（逐列量墨心 y，拟合低阶多项式，按列平移抹平低频弯曲，**保留高频抖动**）。v1 在这条上表现极好（漂移仅 0.94–2.57px / 1300–1400px 跨度），措辞照抄。
4. **不能有第二重框 / 内嵌矩形。** 切片会把内框切成"边条上多一条平行线"，平铺后变成一条贯穿全边的诡异双线（跟"笔尖回描的短段第二笔"完全不同——后者是局部的，要的就是它）。v1 也过了这条。

另加一条管线约束（v1 也过了）：**墨色必须单一平值**。打包脚本用 `alpha = 255 - 亮度` 抠白底（§4），墨色深浅不均会直接变成边框透明度不均。

### 3.3 概念反复记录

**v1（2026-08-20，打回）** —— `panelframe_base` 第一版：一个尺子般精准的直角方框，四角带小墨团 + 十字过冲尾巴。

量化否决（脚本量的，不是目测）：

| 指标 | v1 实测 | 要求 |
|---|---|---|
| 边线偏离直线 / 线宽 | **p50 0.06× · p90 0.13× · max 0.19×** | 2–3× |
| 转角墨团 / 线宽 | **8×**（转角线宽冲到 64–65px，边线 8px） | ≤3×，且不要读成点 |
| 角块特征尺寸 | **51 设计 px**（4px 线）/ **102 设计 px**（8px 线） | ≤20 设计 px |
| 低频漂移 | 0.94–2.57px / 1300–1400px 跨度 ✅ | — |
| 四边首尾 y 差 | 0 ~ −2.5px ✅（回绕接缝可接受） | — |
| 边线粗细变化 | 6–11px（mean 8.25）✅ | — |
| 无内框 / 框内空 / 无文字 / 无阴影 | ✅ | — |

两条硬伤：

1. **比现在的程序笔触还直 5–15 倍。** 接进去会让面板更方更硬，正是用户诉求的反面。
2. **角块尺寸在小面板上物理不成立。** 世界地图 HUD 大量面板只有 30–44px 高，51px（更别说 102px）的角块放不下——实测渲染里 300×44 面板的框直接塌成一根线。

**用户反馈（同日）**：「转角太直太尖锐了，要么加墨团，要么直接做圆角。」

**判断：两个都不选，走第三条——手绘圆转角**（详见 §1.2 拍板）。加墨团治不了尖锐（墨团盖在尖角上，尖角还在下面），而且尺寸装不进小面板；等半径圆角违背 §7.5 且四角雷同、把 `seedFor` 的变化空间也一起干掉。手转的不等半径圆角同时满足"不尖锐"和 §7.5 的「非完美圆角」，角块还能压到 20 设计 px。

**顺带否掉的一条替代路（对比图 D 行）**：只把 `pen.jitter` 从 1.1 调到 4.0、不出图。抖动量够了，但因为 `segLen=10` 没动，折角太陡，**读成锯齿 zigzag 而不是手抖**。这条路要成立必须振幅和波长一起放大（jitter 4 配 segLen 30–40），而且**它完全不解 §0 那个每秒 8.6 ms / 132k 顶点 / 13 次 flush 的性能问题**——所以只作为兜底记录，不作为方案。

**同时暴露的一条认知修正**：原 §1.1 写的出图理由是"追求程序笔触画不出的细节（墨点积聚 / 纸纤维 / 笔尖分叉）"，实测站不住——**4–8px 线宽里没有像素容得下这些细节**，位图的细节优势只存在于角部，而角部一旦画得有细节就大到小面板放不下。所以本次出图的真实收益重新表述为：**① 性能（唯一只能靠这条路解的，43× CPU / 130× 顶点 / 13 次 flush → 1 次合批）；② 抖动幅度与转角形状由我们在打包时决定，不再受"程序笔触幅度不随尺寸走"的约束。** 不是"更精致"。


**v2（2026-08-20，打回 —— 方向对，标定不对）** —— 按 §1.2 的"手绘圆转角"重写 prompt 后的第一版。1536×1024（生成器选了 3:2，不是要求的正方；不是问题，见下）。

| 指标 | v1 | **v2 实测** | 要求 |
|---|---|---|---|
| 转角半径 / 线宽 | 尖角 + 8× 墨团 | **TL 1.3× · BR 2.3× · BL 7.6× · TR 9.5×** | 2–3.5×，四角**都**在带内 |
| 角块尺寸（ink 4px） | 51 设计 px | **50 设计 px** | ≤20 |
| 抖动 \|dev\| / 线宽（**去漂移后**） | 0.06× | **0.24–0.40×** | 2–3× |
| 低频漂移 | 0.94–2.57px ✅ | **9.5–19.7px** ⚠️ | 越小越好（管线可修） |
| 四边首尾 y 差 | 0 ~ −2.5px ✅ | −10.5 ~ +14.0px ⚠️ | 越小越好 |
| 墨色单一（0–47 区间占比） | ✅ | **88.7%** ✅ | — |
| 无内框 / 框内空 / 无文字 / 无阴影 | ✅ | ✅ | — |

**成立的部分**：转角"圆"这件事目视和量化都成立，四角圆度确实各不相同 —— §1.2 那个"手绘圆转角"的判断是对的，方向不用回炉。

**两条要重出的**：

1. **半径标定散得太开（1.3×–9.5×，跨度 8.4 倍）。** "四个角圆得不一样"这条指令生效过头了：TL（1.3×）基本还是个尖角，用户抱怨的"太尖锐"在那个角上没解决；TR（9.5×）和 BL（7.6×）又大到把角块顶到 50 设计 px，跟 v1 一样装不进 30–44px 高的面板。修法是把范围写成**带**（2–3.5×）并明确"四个角**都**要落在带内"，Avoid 里同时点名"某个角接近直角"和"大扫弧"。
2. **抖动是靠"整条边弯"凑出来的，不是手抖。** 原始 \|dev\| 看着不错（bottom p90 达 1.33×），但拆开看低频漂移占了 9.5–19.7px，**减掉整条边的弯曲之后只剩 0.24–0.40×**。
   - **这是 v2 prompt 自身的一处矛盾，我写漏了**：同一段里既要求 `no sag, bow, droop, lean, or taper`，又要求 `strays about two to three times its own thickness away from true`——模型把两条一起满足的最省力办法就是"整条边缓慢弯过去"（局部看处处平缓，整体看弯了 20px）。v3 补上缺的那一半约束：**给起伏次数下限**（每条边至少 20 次独立起伏）+ 明确禁止"整条边只弯一次再回来"。按线宽 8.75px、边长 1408px 算，波长 5–10 倍线宽 = 44–88px，本该有 16–32 次起伏，v2 实际只有一两次大弯。
   - 顺带说明为什么低频漂移不能留着不管：§4 步骤 3 的去漂移是**必须**跑的。ink 4px（缩放 0.55×）时，bottom 那条边 19.7px 的弯曲落到 300px 宽的面板上约 8 设计 px 的下坠——44px 高的面板上塌 18%，一眼是坏的；而且不同面板取到长条的不同段，有的下坠有的上翘，还不一致。

**不是问题的**：画布 3:2 而非正方 → 竖边 896px，ink 4px 时竖条 410 设计 px，最高的面板（行军列表 220px）够用。将来出现更高的面板才需要回绕。


**v3（2026-08-20，打回 —— 但这一版把问题定性了）** —— 1402×1122。漂移修好了、转角收窄了一半，**抖动幅度原地不动**。

| 指标 | v1 | v2 | **v3** | 要求 |
|---|---|---|---|---|
| 抖动 \|dev\| / 线宽（去漂移后） | 0.06× | 0.24–0.40× | **0.26–0.37×** | 2–3× |
| 转角半径 / 线宽 | 尖角 + 8× 墨团 | 1.25–10.44× | **1.32–5.25×** | 2–3.5× |
| 角块尺寸 | 51 设计 px（ink4） | 50 设计 px（ink4） | **22 设计 px（ink3）/ 29（ink4）** | ≤20 |
| 低频漂移 | 0.9–2.6px | 9.5–19.7px | **3.4–9.2px** | 越小越好 |
| 四边首尾 y 差 | 0 ~ −2.5px | −10.5 ~ +14.0px | **−4.0 ~ +3.0px** | 越小越好 |
| 墨色单一（0–47 占比） | ✅ | 88.7% | **88.9%** | — |

**"给起伏次数下限 + 禁止整条边只弯一次"这条改动生效了**：漂移从 9.5–19.7px 掉到 3.4–9.2px，首尾 y 差从 ±14px 掉到 ±4px。转角带也从 8.4 倍跨度收到 4.0 倍，角块尺寸 ink3 时 22 设计 px 已经接近 ≤20 的目标。

**但抖动幅度三版下来是 0.06× → 0.35× → 0.32×，第二版之后完全平台化。** 这是决定性的：

- 目标 2–3× 是按"明显比现状更抖"定的。**现状 `SketchPen` 是 `jitter 1.1 / width 2.2` = 0.5×，加 ghost 第二笔偏移后有效散布约 0.9×。** 也就是说 v3 的线**比游戏里现在跑着的程序笔触还直**（0.32× vs 0.5×）。
- 三轮 prompt 只在第一轮换来一次提升（0.06→0.35），之后再怎么改措辞都不动。**生成器画的是"工整的手绘线"，不肯把振幅推到线宽的 2–3 倍。** 这个指标 prompt 磨不出来。

### 3.4 结论：改走"程序生成一次 + 九宫装配"（已拍板并落地，见 §4/§5）

三轮实测把两条原以为属于"出图"的收益逐条否掉了：

1. **"位图有程序画不出的细节"** —— §3.3 已否：4–8px 线宽里没有像素容得下墨点积聚/纸纤维/笔尖分叉。
2. **"抖动幅度和转角形状改由打包时决定"**（§1.1 修订后的主要理由之一）—— v3 否：交给 AI 出图，这两个指标恰恰**不可控**，磨了三轮转角还有一个角是 1.32×、抖动卡在 0.32×。而它们在代码里就是两个数字。

而 §0 那个真正的收益 —— **43× CPU / 130× 顶点 / 13 次强制 flush → 1 次合批** —— 来自 **§2 的九宫装配（sprite 合批）**，**跟图是 AI 画的还是程序画的完全无关**。

所以建议：**图集改成程序生成一次**（`SketchPen` 画 4 条长边条 + 4 个角块 → `bake()` 成一张 RenderTexture），§2 的装配方案（长条顺序开窗、平铺不拉伸、tint 上色、`seedFor` 派生偏移、小面板降级）**一字不改**。

| | AI 出图 | 程序生成一次 |
|---|---|---|
| 性能收益 | 43× | **43×（相同，收益来自装配不来自图源）** |
| 抖动幅度 | 卡在 0.32×，磨不动 | **代码里一个数，想要多少给多少** |
| 转角半径 | 1.32–5.25×，抽奖 | **2.0/2.4/2.8/3.2× 四角精确指定** |
| 长条长度 | 621–931 设计 px（聊天条 1920 要回绕） | **2048px，全项目零回绕接缝** |
| 变体数量 | 一张图 | **边条/角块各出 N 套，`seedFor` 有更多可选** |
| 包体 | 一张 PNG | **0** |
| 显存 | AI 图集 | 一张 ~2048×256 RenderTexture，更小 |
| 管线 | 抠白底 + 去漂移 + 切片 + 3 档膨胀 + manifest | **不需要**（无白底可抠、无漂移可去、切片坐标是自己算的） |
| 失去的 | — | AI 的墨迹质感（按第 1 条，在这个线宽下价值为 0） |

一次性烘焙成本：4 条长条 + 4 个角块 ≈ 4 万顶点、启动时约 3 ms，**画一次**，不是每秒 13 次。`bake()` 无 renderer 时回落到实时 Graphics 的既有契约（`buildPaperBackground` 就是这么做的）照用。

建议起点参数（都可即时调）：线宽 base 2.2（thin/base/bold 三档不变）· 抖动振幅 2.5× 线宽 ≈ 5.5px · 波长 6× 线宽 ≈ 13px（比现 `segLen=10` 稍长，避开 §3.3 记的锯齿坑）· 转角半径 2.0/2.4/2.8/3.2× 线宽 · 长条 2048px。

---

## 4. 图集生成（已落地）

代码：[`client/src/render/panelFrame.ts`](../../client/src/render/panelFrame.ts)。**没有出图、没有打包脚本、没有资产** —— §3.4 定案后原计划的 `pack_panel_frame.cjs`（抠白底 / 去漂移 / 切片 / 3 档膨胀 / manifest）整套都不需要了：没有白底可抠、没有漂移可去、切片坐标是自己算出来的。

- **一张图集，启动时懒烘一次**：`bakeLazy('panelFrameAtlas:v1', …)`（复用 `render/bake.ts`，纸底走的就是它）。宽 1024，高按布局算出来。**所有切片同一个 baseTexture** —— §2.1 的「一屏所有框合成 1 次 draw call」就靠这个。
- **内容**：3 档线宽（`1.2 / 2.0 / 2.6`，`opts.width` 取最近档）× 3 档抖动幅度 = 9 个组合；每组 2 条长边条（横边 / 竖边各一条，波形不同）+ 4 个转角块（TL/TR/BR/BL 各自半径不同）。共 18 条长条 + 36 个角块。
- **抖动**：两个八度的**循环** 1-D value noise（`WAVE = 26` px 一个控制点，第二个八度波长 1/3、幅度 0.34），叠加 `SketchPen` 的细颤（`jitter 0.5`）+ 它自带的 ghost 第二笔。**循环**是关键：长条要在比它宽的面板上首尾相接平铺，不循环的话回绕处会有台阶。
- **抖动幅度分档，按面板短边选**：`≤48px → 1.4` / `≤120px → 2.4` / 其余 `3.6`。**必须按尺寸压幅度**，否则边框会走进内容里 —— 3.6px 的起伏在 30px 高的 buff 行上占十分之一，上下两条边几乎要碰上。
- **转角半径**：基准 `[5.0, 6.6, 8.0, 6.2]`（TL/TR/BR/BL），按幅度档缩放 `0.55 / 0.80 / 1.00`。四角各不相同（§1.2 的「手绘圆转角」），其中两个角多画一小段过冲弧（`OVERSHOOT`）。
- **颜色**：图集里画的是纯白墨，运行时每个 sprite `tint = opts.border`。`Sprite.tint` 在 pixi 批渲染器里是逐顶点颜色，**不打断合批**，所以调用点那 30+ 种 fill/border 组合、段位色、运行时算出来的颜色，成本都是零。
- **⚠️ 整数对齐（实测踩过）**：`inset` / `half` / 转角半径**必须是整数**，`addPanelFrame` 里还要把 `w`/`h` 各 `Math.round` 一次（面板尺寸常常是屏幕的分数）。否则每个窗口 sprite 落在小数位置、以不同的亚像素相位采样图集，**两个窗口交界处会出现可见的错位台阶** —— 第一版实拍截图上边就有一处，放大后一眼可见。底色 `Graphics` 保持精确尺寸（半像素的填充边看不见，半像素的纹理偏移看得见）。

包体 0，显存一张 1024×~250 的 RenderTexture。

## 5. 落地结果（2026-08-20）

**性能**（`test/ui/panelFrameAssembly.ui.ts` 的常驻门禁，同一组 13 个世界地图 HUD 面板）：

| | 改前 | 改后 |
|---|---|---|
| CPU 建几何 | 8.60 ms | **0.47 ms** |
| 顶点数 | 132,300 | **704**（其中约 650 是那个 22×18 徽章的降级兜底） |
| 不可合批（强制 flush） | 13 | **1**（同上，就是那个徽章） |
| 一次性图集烘焙 | — | **6.0 ms**，只跑一次 |

即整张图集的代价**不到旧实现一秒钟的开销**（旧的是每秒 8.6 ms，因为 `renderHud()` 每秒重建一次）。

**观感**（真 WebGL 截图，Playwright 1280×800 @dpr2，同一屏 old/new 对比，放大 4×）：转角明显是圆的（旧的是尖角 + 过冲），边线是一条有起伏的连续笔画（旧的是高频细毛刺，在大面板上读成直线）。无接缝、无台阶、无越界。

**测试**：`tsc --noEmit` 干净；单元 1499 通过；UI smoke 通过（`test/ui/panelFrameAssembly.ui.ts` 新增 **17 例**）；production webpack 构建通过。

新增测试覆盖三类不变量，且**逐条做过变异验证**（改坏实现确认会红，不是空断言）：

- **接缝**：相邻窗口在屏幕上首尾相接**且**在长条上首尾相接（两者缺一分别是「跳到线的另一段」和「留缝」）；长条走到尽头时回绕到原点；四条边由角块 + 窗口**端到端无洞**覆盖；侧边真的转了 90° 且方向对（缺 `rotation` 时窗口会变成横躺的）。
- **上色 / 缓存**：每个切片都按 `border` 打 tint；底色和 `fillAlpha` 留在面板自己身上；图集只渲染一次；**只丢掉 `panelFrame` 的 memo、保留 bake 缓存时不重画**。最后这条是补上来的 —— 原来那句「只渲染一次」是**空断言**：`panelFrame` 自己的 memo 把「`bakeLazy` 到底有没有缓存」完全遮住了，变异测试里把 bake 的缓存删掉它照样绿。
- **迁移面**：`tearDownChildren` 不销毁共享图集纹理（世界地图 HUD 每秒 teardown 一次，销毁了下一帧就空屏或崩）；`sketchAccentBar` 在图集面板上挂一层新 ink、在小面板兜底的裸 `Graphics` 上直接画（保持改前行为）。

**迁移**：`sketchPanel` 返回 `PIXI.Container`（走图集时）。238 个调用点**一个没改**。改动的只有：
- `sketchAccentBar` 首参 `PIXI.Graphics` → `PIXI.Container`（内部自己挂 ink 层），于是那 18 个把面板当画布继续画的调用点一行没动；
- 新增 `inkLayer(target)` 出口，`LobbyScene/vsOverlay.ts` 那唯一一处直接 `new SketchPen(panel, …)` 改走它；
- `CampaignMapScene/drawing.ts` 的 `drawTape` 首参同样放宽成 `Container`（它本来就只 `addChild`）。

**一个刻意的取舍**：**兜底路径返回的是裸 `Graphics`，不是包一层的 `Container`**。headless UI smoke 故意不带 renderer，而它有 23 处断言是结构化定位面板的（`instanceof PIXI.Graphics`、`constructor === PIXI.Container`）。无条件包一层会把底色挪深一级、把位置搬到父节点上，凭白弄坏这 23 条断言。兜底时返回裸 `Graphics` 让「无 renderer」这条路径的节点形状跟改前**完全一致**。

**规则**：任何新的面板/按钮落点继续调 `sketchPanel` / `sketchButton`，不要自己画框；要在面板上加墨走 `inkLayer()`。

## 6. 未做 / 待观察

- **真机没验**：微信小游戏 + iPad Safari 上的显存和帧率还没跑过（原 §5 验收项 5）。图集比 AI 图集小得多，风险低，但没实测就是没实测。
- **`opts.width: 5`** 那 2 处按最近档归到 `bold`(2.6)，视觉上比原来细。目前没看出问题，留观察。
- **参数没调过第二轮**：`WAVE = 26`、幅度 `1.4/2.4/3.6`、半径 `[5.0,6.6,8.0,6.2]` 都是第一版就定的值，截图看着对就没再动。它们全是 `panelFrame.ts` 顶部的常量，随时可改，不需要重新出图 —— 这正是选程序生成而非 AI 出图的理由之一。
- **三张被打回的 AI 源图**已按「为什么被打回」重命名归档进 `art/leftover/`（`panelframe_v1_sharp_corners_ink_blots.webp` / `panelframe_v2_rounded_radius_spread.png` / `panelframe_v3_wobble_plateau.png`），`art/ui/panelframe/` 随之删除 —— 最终实现没有任何面板边框美术资产。量化结论在 §3.3。
