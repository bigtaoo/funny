# 面板边框 AI 化 + 九宫装配 — Prompt 文档

> 创建：2026-08-20 · 状态：**v1 已出图并打回（§3.3），v2 prompt 待出图**
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

改为：源图画**一整个手绘矩形**，打包脚本从中切出四条**长边条**；运行时沿边**按顺序**贴该长条的连续窗口（`new PIXI.Texture(base, new Rectangle(...))`）。相邻窗口本来就是同一条线的前后段，**接缝在构造上不存在**——那只是"继续往下读同一条线"。

只有面板比长条还长时需要回绕，此时会有一处接缝。全项目只有聊天条（1920 设计 px）会触发。缓解见 §3 的软约束（两端 y 对齐）+ §5 的验收项。

### 2.4 运行时装配（`sketchPanel` 新实现）

对一个 `w × h` 面板：

1. **底色**：`Graphics.beginFill(fill, fillAlpha).drawRect(0, 0, w, h)` —— **完全不变**，4 顶点，可合批。
2. **四角**：4 个 corner sprite 贴在四角，原生缩放，`tint = border`。
3. **上边**：从 `frame_edge_h` 长条的 `offset` 处开始，向右连续开窗铺满 `[CORNER, w - CORNER]`，每个 sprite `tint = border`。
4. **下边**：同上，用**不同的** `offset`（否则上下两条边一模一样，一眼假）。
5. **左/右边**：用 `frame_edge_v` 长条（源图的左右两边切出来的，**不是把横条旋转**——旋转会让四条边的笔触方向全同源，而且真手画的竖线和横线握笔角度不同）。
6. **`opts.seed`**：不再是 no-op —— 用它派生 4 条边各自的 `offset`、以及角块的左右/上下翻转位。**238 处调用点传的 seed 全部继续生效**，per-instance 的手绘差异保住（这也解决了我原先担心的"换图后 `seedFor` 失去意义"）。
7. **`opts.width`**：实测调用点用到 9 种粗细（`2`×42、`1.6`×13、`2.6`×11、`2.4`×11、`1`×9、`1.2`×7、`1.8`×3、`1.5`×3、`5`×2）。打包时用 `dilateAlpha`（`pack_tab_icons.cjs` 已有的机制）烤 **3 档**：`thin`（≈1.2）/ `base`（≈2）/ `bold`（≈2.6），运行时取最近档。`width: 5` 那 2 处单独处理（要么归 bold，要么保留 Graphics 走法），接线时定。
8. **小面板降级**：`w < 2 × CORNER` 或 `h < 2 × CORNER` 时无处放两个角块。聊天未读徽章 22×18 就比两个角块并排还窄。此时**退回现有 `SketchPen` 画法**（小尺寸下程序抖动本来就读得出来，也没有性能问题）。阈值和分流写在 `sketchPanel` 里，调用点无感。

### 2.5 迁移面（已查实）

`sketchPanel` 返回类型从 `PIXI.Graphics` 变成 `PIXI.Container`，这是**唯一**的破坏点：

- **18 处**把返回值当画布继续画，绝大多数是 `sketchAccentBar(box, ...)`（AchievementScene / CardCodexScene/tile / FriendsScene×4 / LeaderboardScene / StatsScene/panels×2 …）。把 `sketchAccentBar` 的首参从 `PIXI.Graphics` 改成 `PIXI.Container`、内部自己挂一层 `Graphics`，**这 18 处一行都不用改**。
- **1 处**直接 `new SketchPen(bg, ...)`：[`LobbyScene/vsOverlay.ts:50`](../../client/src/scenes/LobbyScene/vsOverlay.ts:50)，单独收。
- 显式标注 `: PIXI.Graphics = sketchPanel(...)` 的：**0 处**。
- `tearDownChildren` / `disposeChild`（[`sketchUi.ts`](../../client/src/render/sketchUi.ts)）已经会递归进子容器，且对非 Text 叶子用 `texture: false` ——**共享图集 baseTexture 不会被误销毁**，这条现成的契约正好覆盖新结构，不用改。

---

## 3. 出图清单（试点：1 张源图）

| 文件名 | 尺寸 | 内容 |
|---|---|---|
| `art/ui/panelframe/panelframe_base.png` | 正方，≥1536×1536 | **一个完整的手绘矩形边框**，白底黑墨，框内空白 |

一张图同时供出 4 个角块 + 4 条长边条（打包脚本切，见 §4），**style 一致性因此免费**——四角和四边出自同一支笔、同一次落笔。

### 3.1 Prompt（v2 候选 —— v1 打回后重写，见 §3.3）

```
A single large rectangle border hand-drawn in dark ink on a clean white sheet of
paper, filling most of the frame with a generous even white margin on all four
sides, and nothing else in the image at all.

THE CORNERS. Each of the four corners is a turn the hand rounded as it went, not
a sharp point and not a drafted arc: the line curves through the corner over a
radius of roughly two to three times the line's own thickness, so the turn reads
as visibly rounded rather than pointed. The four corners are rounded by
noticeably DIFFERENT amounts from one another — one turn tighter and almost
angular, another looser and wider, the other two somewhere between — never four
matching arcs of the same radius, never the even uniform corner radius of a
printed box or a user-interface panel or a shape drawn round a template, coin, or
compass. On one or two of the four corners only, the pen carried a little past
the turn and left a short stub tail sticking out beyond the corner, no longer
than twice the line's thickness. The ink runs a touch heavier through each turn
where the hand slowed, but only a touch — no big round blot or blob at any
corner, nothing that reads as a dot, rivet, screw head, or tack.

THE FOUR SIDES. The sides run horizontally and vertically overall — the top and
bottom stay level end to end, the left and right stay upright end to end, with no
sag, bow, droop, lean, or taper to any side — but no side is a straight line. Each
side visibly wanders off a straight path and back again: at its widest the line
strays about two to three times its own thickness away from true, and each such
excursion spans roughly five to ten times the line's thickness before it comes
back, so the whole side reads as a long slow hand-drawn waver, an unhurried
rolling swell, NOT as a tight high-frequency tremble and NOT as a sharp zigzag
with angular kinks. The line's thickness also swells and thins unevenly along its
length, the ink runs darker where the pen slowed and lighter where it sped up, and
in a few short stretches the pen was retraced so a faint second stroke runs
alongside the first before merging back in.

Uniform flat dark ink of a single value throughout, roughly hex 2C2C2A, drawn
with a fine ink pen by a talented teenager in a school notebook. Plain clean white
background, absolutely empty inside the rectangle and outside it.

Avoid: sharp pointed mitred corners. An even uniform corner radius, all four
corners rounded the same amount, a corner arc drawn round a template or compass,
the rounded-rectangle look of a printed box or an app UI panel. A big ink blot,
blob, dot, rivet, screw head, or tack at any corner. Ruler-straight sides, sides
drawn along a straightedge, technical or drafting precision, a tight jittery
tremble, a sharp angular zigzag. A second inner or outer rectangle, a double
frame, nested boxes, ruled or dashed or dotted lines. Corner ornaments,
flourishes, scrollwork, washi tape, paper clips, staples, torn or deckled paper
edges, folded corners. Any text, letters, numbers, handwriting, labels, signature,
watermark. Any hatching, cross-hatching, shading, gradient, drop shadow, glow,
texture fill, paper grain, watercolor, or color of any kind. Any perspective,
tilt, rotation, or 3D depth. Any side that fades out, tapers to nothing, or breaks
into a long gap. Any content inside the rectangle.
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

## 4. 打包管线

新脚本 `art/ui/panelframe/pack_panel_frame.cjs`，**不能直接复用** `pack_tab_icons.cjs`：后者会「按内容 bbox 裁掉白边 + 按长边缩放到 128」，那两步会破坏切片的精确几何。沿用它的抠白底 + 染色 + `dilateAlpha` 三个函数，换掉裁剪/缩放逻辑。

步骤：

1. 载入源图 → `alpha = 255 - 亮度`（白底透明、墨不透明、抗锯齿边半透明），**RGB 全部写成纯白 `#ffffff`**。
   > 与前六批不同：那六批在打包时把 RGB 覆写成目标墨色（`_active` 白 / `_inactive` 灰 / `_content` 深墨 / `_accent` 蓝）。本次输出**纯白 alpha 蒙版**，颜色交给运行时 `Sprite.tint`。
   > **这不是破"没有运行时 tint AI 位图的先例"那条**：`pack_tab_icons.cjs` 的做法本来就是把 AI 图归约成「alpha 蒙版 + 一个平涂 RGB」，白蒙版 × tint 与打包时烤死墨色在数学上等价，只是把同一个乘法从打包时挪到绘制时。
   > 必须走 tint 的理由：实测现有调用点有 **30+ 种 fill/border 组合**（`C.paper`+`C.dark` 17 次、`0xeeeeee`+`C.mid` 15 次、`C.paper`+`C.gold`、`border: tierColor`、`fill: fillColor, border: borderColor` 这种整套运行时算出来的…），而颜色在这套 UI 里承担信息（金=可领/premium、蓝=可用、红=错误、灰=禁用、段位色）。一色一图会炸成上百张 PNG。`Sprite.tint` 在 pixi 批渲染器里是**逐顶点颜色，不打断合批**，所以 30+ 种颜色的成本是零。
2. **定位墨框**：找到四条边的墨心线，得到框的外接矩形。
3. **去漂移**（§3.2 第 1 条）：对每条边逐列（竖边逐行）量墨心坐标，拟合 2–3 阶多项式，按列平移抹平低频弯曲，保留高频抖动。抹平前后的最大偏移量写进产物报告。
4. **等比缩放**，使墨带厚度（含抖动的墨占用带宽）落到 `BAND = 24` 设计 px。缩放后各边可用长度就是长条长度，**实测值写进产物报告**（预期 1200–1400 px；聊天条 1920 会触发一次回绕，见 §2.3 / §5）。
5. **切片**：`CORNER = 20` 设计 px（容纳 2–3 倍线宽的圆转角 + 短过冲尾巴；v1 那种大墨团角要 51–102px，已放弃，见 §1.2 / §3.3）。切出 `corner_tl/tr/bl/br`（各 20×20）+ `edge_t/edge_b`（L×BAND）+ `edge_l/edge_r`（BAND×L）。`BAND` 由实测墨带厚度定，预期 10–14 设计 px。
6. **烤 3 档粗细**：`thin` / `base`（原样）/ `bold`，用 `dilateAlpha` 的膨胀/腐蚀通道。
7. **打进一张图集** `client/src/assets/panelframe/frame.png`（单张 PNG，一个 baseTexture —— §2.1 的"1 次合批"就靠这个），同时吐 `frame.json` 记录每个切片的 `{x, y, w, h}` + 角块的墨线出画位置 + 长条的墨心 y + 两端 y 差。
   > **运行时不硬编码任何切片坐标，一律读 `frame.json`。** 角块和边条的对齐点由脚本量出来，不靠手填。
8. 图集切片之间留 **2px padding**（`extrude` 边缘像素），否则双线性采样会从邻块漏像素进来，表现为边框上偶发的细小杂点。

用法：`node art/ui/panelframe/pack_panel_frame.cjs`，复用 `client/node_modules/sharp`（同前六批，无需额外安装）。

包体影响：一张 ~1400×1400 以内、内容极稀疏（细墨线 + 透明）的 PNG，相对主包 2.1 MB（[`ASSET_PACKAGING.md`](../game/ASSET_PACKAGING.md)）可忽略。显存：按 RGBA 上传约 ≤ 8 MB，**这一条要在真机验（见 §5）**——项目有过 iPad WebGL 显存耗尽导致 Safari 重载页面的事故记录，图集尺寸如果超预期就下调 `BAND` 重打。

---

## 5. 试点范围与验收

**试点只接世界地图 HUD**：兵力/领地条、buff 行、行军列表/战斗录像按钮、行军列表面板、toast。其余 230+ 处调用点保持现状（`sketchPanel` 内部按开关分流），过了再铺开。

验收（缺一条就重出图或调管线，不硬上）：

1. **观感**：真机截图，跟现状 Graphics 版**并排**看。要求"边线读得出是手画的"且"角部明显比程序图有细节"。这是本次的原始诉求，第一优先。
2. **平铺不露馅**：同一屏里 300px 宽和 1920px 宽的面板并排，边线抖动的**振幅和频率看起来一样**（这是选平铺而非拉伸的全部意义）。
3. **无接缝**：任何面板的边上看不到规律性重复或错位台阶。聊天条（1920 > 长条长度）那一处回绕接缝**单独确认可接受**，不可接受就把 `BAND` 调小换更长的条。
4. **性能**：把 §0 那份基准落成常驻测试（用户已定顺序：接线之后再补），要求 13 个面板的 CPU 建几何从 8.6 ms 降到 < 0.5 ms、强制 flush 从 13 降到 0。
5. **显存/真机**：微信小游戏 + iPad Safari 各跑一次世界地图，确认没有纹理相关的崩溃或重载。
6. **小面板降级**：聊天未读徽章（22×18）仍走 `SketchPen` 且外观无变化。

---

## 6. 未定项（等出图或接线时定）

- `width: 5` 那 2 处归 `bold` 还是保留 Graphics 走法。
- 是否需要第二张源图做"强调框"（金/蓝描边的按钮当前只靠 tint 区分颜色，不区分笔触个性）。**试点先不出**，看真机效果再说。
- 铺开时是否给 `sketchPanel` 加一个 `opts.frame: 'raster' | 'pen'` 逃生口，还是全量切换。
