# 批次 13：队伍体力的火苗（`flame`，1 张）— 语义判断 + Prompt 文档

> 创建：2026-09-17 · 状态：**判断 + prompt 已定，出图待办**。全库账（出图前）：**68 张自有美术 + 6 个别名 = 74 个 ink kind**
> 前十二批：[批 1–4](tab-icon-art-prompts.md) · [批 5](tab-icon-art-prompts-batch5.md) · [批 6](tab-icon-art-prompts-batch6.md) · [批 7](tab-icon-art-prompts-batch7.md) + [批 7 log](tab-icon-art-prompts-batch7-log.md) · [批 8](tab-icon-art-prompts-batch8.md) · [批 9](tab-icon-art-prompts-batch9.md) · [批 10](tab-icon-art-prompts-batch10.md) · [批 11](tab-icon-art-prompts-batch11.md) · [批 12](tab-icon-art-prompts-batch12.md)
> 上游：[`UI_DESIGN_LOG_2026-09.md` §58](../game/UI_DESIGN_LOG_2026-09.md) —— 那一轮把选队弹窗的 `Team 1 · Troops 2525 · Stamina 100` 换成「名字 + 两枚字形数字」的 chip 行，兵力借 `unit`、体力借 `hourglassMd`，**本批就是来替掉那只沙漏的**
> 配套代码：[`worldmap/net/march.ts`](../../client/src/scenes/worldmap/net/march.ts) · [`WorldMapPanels/core.ts`](../../client/src/scenes/worldmap/WorldMapPanels/core.ts) · [`inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts) · [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)

## 0. 为什么是这一枚：沙漏在这一屏上说的是「时间」

§58 落地当天用户就问了一句：「体力的图标一直都是漏斗吗？我记得漏斗是买的保护盾的时间计时。」

**记的方向对，道具记错了一个。** 保护盾是批 10 专门出的伞（`umbrella`），商城的保护罩是 `armor`/`armorHeavy` 两档；沙漏是**加速**。但这一问揭出来的东西是真的 —— 沙漏在这一屏上已经有三层「时间」的含义：

| 位点 | 图 | 说的是 |
|---|---|---|
| HUD buff 行 `world.speedup`（[`hud.ts`](../../client/src/scenes/worldmap/WorldMapPanels/hud.ts)） | `hourglassMd` | 行军加速**还剩多久** |
| 弹窗状态行 `world.occupying` / `world.team.besieging`（[`WorldMapInput.ts`](../../client/src/scenes/worldmap/WorldMapInput.ts)） | `hourglassMd` | 占领 / 围攻**倒计时** |
| 商城 `SPEEDUP_ICON_TIERS`（[`shop.ts`](../../client/src/scenes/worldmap/WorldMapPanels/shop.ts)） | `hourglassSm/Md/Lg` | 加速道具的 1h/8h/24h **档位** |

而体力不是时长，是**「这支队伍还能下几次令」的预算**（[SLG_DESIGN §4.6](../game/SLG_DESIGN.md)：上限 100、每次指令扣 15、每分钟回 1，所以满额 6 次）。同一个字形让 chip 上那个 `100` 读成「100 秒？100 分？」——**这是借来的语义，和批 10 的案情同一类**（那次是保护倒计时借着 `armorHeavy` 的四分圆，"语义靠文字承担"在有词的地方成立、在只剩数字的地方不成立）。§58 恰好把词删了，所以这只沙漏必须还回去。

**顺带说清 chip 字形的真实尺寸**：它按 `STAT_GLYPH_RATIO 1.25 × FS.label 24 = 30` 设计 px 画（[`core.ts`](../../client/src/scenes/worldmap/WorldMapPanels/core.ts)），**比按钮前置字形的 26 还大一档**。前十二批的验收尺度是 26/28px，这一张的主场比那更宽松。

## 1. 语义判断：为什么是火苗

判断方法照 [[pick-icon-glyphs-by-eye-not-name]]：先看屏上读成什么，再谈名字。库内现有 109 枚（63 墨线 + 46 页签）把大半条路提前占了，**下面每一条都是先被否掉、才轮到火苗**：

| 想法 | 否决理由 |
|---|---|
| 闪电 | `atkspd` 攻速。批 8 给 `spell` 写 Avoid 时就点名过「不要闪电（`atkspd` 已占）」，而攻速出现在所有装备词条行 + 卡牌属性行，是全库最广的几条语义之一 |
| 弹簧 / 线圈 | `binding` 就是「孤立的螺旋装订圈，三圈弹簧线」（批 7） |
| 心形 / 血滴 | `hp` 是单个对称心形（批 7） |
| 箭 / 箭袋 / 弓 | 批 8 给 `range` 写下的定论：「弓箭那条路走不通——弓箭兵、`atk` 的匕首、`crit` 的靶心插箭已经占满『武器』这套语言，再加一件就要靠细节区分，28px 上必糊」。箭袋的语义（还剩几支＝还能出几次）本来最贴，但它付的正是这条学费 |
| 齿轮 | `settingsTabIcon`（批 5） |
| 发条钥匙 | `key`（批 11）。而且"发条"本身又读回时间 |
| 油灯 / 台灯 | 「穹顶 + 竖杆」= 刚上线的 `umbrella`，且两者**同屏**（HUD 右列） |
| 液体 / 水位 / 墨量 | `ink` 是 SLG 资源（墨水），墨滴/瓶身都在它名下 |
| 军用水壶 | 圆瓶身跟 `ink` 的墨水瓶撞，破撞车要靠背带/壶盖这类 26px 上会消失的细节 |
| 靴子 / 脚印 | `footsteps` 已是「停留」状态，而且跟体力**同屏**（队伍面板） |
| 仪表盘指针 | 26px 上的四分圆 / 饼图是已经付过学费的失败（`armorHeavy`，批 7 v3 + 批 10 §0） |
| 干粮 / 粮袋 | 语义讲得通（粮草＝行军续航），但麻袋剪影跟 `coinSack`（束口钱袋）撞 |
| 马克杯 + 热气 | 热气在 26px 上必然消失，剩「带把手的圆筒」，跟 `trophy` / `achievementTabIcon` 两只奖杯并排容易混 |
| **电池** | **可用，是第二选择**。最无歧义的"能量/续航"，方形最抗缩小；代价是跳出文具语言（有先例：皮肤图标最后定成戏剧面具就是刻意跳出）。用户 2026-09-17 在火苗与电池之间选了火苗 |
| **火苗** | **采用**。见下 |

**火苗胜出的三条**：

1. **全库没有第二个火焰。** 最近的邻居是 `play`（实心三角）和 `lead`（底边张开的锥体）—— 都是尖头剪影，这是本张唯一的真风险（见 §2）。
2. **跟同屏的 `camp` 是同一套野营语汇，且由构造不会混**：批 9 给 `camp`（脊帐）写的 Avoid 列表里明确有一条「**不许篝火**」，所以帐篷那张图里保证没有火，两枚放一起是"帐篷"和"火"，不是两团三角。
3. **「火还旺不旺」天然就是续航**，不依赖语言（中文「劲头/火力」、德语无对应成语但图形直读、英语 "burning low"），而且和数字同向：数字大＝火旺。

**kind 名叫 `flame` 而不是 `stamina`，也不是 `campfire`**：前者是 [[pick-icon-glyphs-by-eye-not-name]] 的正面写法 —— 名字描述**画的是什么**，"这簇火代表体力"由调用点和本文档承担（`armor` 当年之所以坑，就是名字描述用途、屏上是另一回事）。不叫 `campfire` 是因为**不画柴堆**（§2 第 3 条）。

**同时存档一个没有走的方案（非字形）**：体力的真身是离散的 6 次，所以「六个小格填满几格」（`◼◼◼◼◻◻`，同 `render/levelStars.ts` 的 pips 约定）比任何字形都更准确地说出"还能出 4 次"，且零美术。用户选了火苗，故此方案**存档不推进**；若哪天体力规则改成按距离/按战斗扣（不再是整数次），这个方案连带作废，不必回头再看。

## 2. 硬约束（骨架之外，这一张特别容易踩的三条）

骨架沿用前十二批（见批 9 §2），不重复贴。这张要写进 prompt 的：

1. **破三角要花在轮廓上，不能花在内部。** 实心火苗就是个尖头团块，而 `play`（实心三角）和 `lead`（锥体）已经占了尖头剪影。标准解法「双层火焰 + 内层空心火芯」在这里是错的 —— 批 9 的 `camp` v1 已经用绷绳交过这笔学费：**破除撞车的那几笔如果自己在目标尺寸上会消失，就只剩下"把外框撑宽"这一个副作用**。内部线条是最先消失的一类，所以身份交给**外轮廓**：一个主火尖 + 一侧一个明显更矮的小火尖（高度差按整图高度的三分之一写死）+ 底沿**内凹**（不是三角形的平底）。这三处都在剪影上，contain-fit 之后还在。
2. **要矮胖，不要细高。** 火苗天然是竖的，很容易出到 2:1 以上；`pack_tab_icons.cjs` 裁边后长边归一到 128、运行时 contain-fit 进方框，细长图只占得满格子的一小半，同一行里比邻居轻一档（`camp` v1 的 2.00:1 就是这么被打回的）。**目标 ≤1.3:1**（宽≈高），硬拦线是 `iconArtAspect.test.ts` 的 2.2。
3. **只画火苗本体**：不画柴堆、不画石圈、不画火星、不画锅架。柴堆是交叉细杆（26px 上一团），石圈把外框撑宽，火星是散点 —— 而且「帐篷 + 篝火」那套完整营地图形跟同屏的 `camp` 直接抢语义。

## 3. Prompt（`tabicon_flame`，1 张）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one single flame, seen straight on, filled in as ONE SOLID BLACK area. The flame has TWO tongues: a tall main tongue whose tip leans slightly to one side, and beside it one much shorter second tongue that reaches only about two thirds of the main tongue's height, separated from it by a narrow white notch cut down between them the width of the pen line. The bottom edge of the flame is a shallow upward curve, so the shape sits on two small feet instead of on a flat base. The flame is nearly as wide as it is tall, squat and round-bellied rather than slim, so the whole drawing sits inside a square frame. Nothing else is drawn — no logs, no firewood, no ring of stones, no sparks, no inner core, no lighter, no candle. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the flame is one flat solid black area with a white notch between its two tongues. Must stay clearly recognizable when scaled down to 30x30 pixels, where the two uneven tongues and the curved-in base are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, halo, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an outline-only unfilled flame, inner flame core or concentric flame layers, a single smooth symmetric tongue, a plain triangle, a cone with a splayed flat base, a tall narrow silhouette more than one and a third times as tall as it is wide, logs, firewood, crossed sticks, a stone ring, a fire pit, sparks, embers, flying dots, smoke, a candle, a match, a lighter, a torch handle, a lamp, a leaf, a teardrop, a water drop, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 4. 出图后的接线清单

**① 源图归位** — `art/ui/tabicons/tabicon_flame.webp`（base 名逐字等于 kind 名；`.png` 也收，见批 12）。被打回的版本移进 `art/ui/tabicons/_rejected/`，命名 `tabicon_flame_v<n>_<为什么废>.webp`（`inkIconArt.test.ts` 会检查「每个 kind 恰好一个源图」）。

**② `pack_tab_icons.cjs`** — `JOBS` 末尾加一行带注释的，`inks: ['active']`（**只烤白色母版，运行时 tint**；烤三档墨色会静默改道走 `tabIconVariant` 并抹平所有 tint）：

```js
// Batch 13 (design/product/tab-icon-art-prompts-batch13.md): team stamina's own glyph. The picker's
// stat chip was borrowing `hourglassMd`, which on that same screen already means "how much TIME is
// left" three times over (speedup buff, occupy/siege countdown, the shop's speedup tiers) — while
// stamina is a budget of orders, not a duration. Two uneven tongues and a curved-in base, because a
// solid single-tongue flame is `play`'s triangle / `lead`'s cone.
{ src: 'tabicon_flame.webp',             name: 'flame', inks: ['active'] },
```

**③ 跑打包** — `node art/ui/tabicons/pack_tab_icons.cjs` → `client/src/assets/tabicons/flame_active.png`。**没有 merged-atlas 重打包这一步**。跑完确认「只有新增那一张变化，其余零字节改动」（这条管线的确定性批 9/批 10 各验过一次）。

**④ `inkIconRaster.ts`** — 三处：`import flameInkUrl from '../../assets/tabicons/flame_active.png';`（挂在批 13 的注释段下）、`InkIconKind` 加 `'flame'`、`INK_ICON_ART` 加一行。

**⑤ 调用点，一处**：[`march.ts`](../../client/src/scenes/worldmap/net/march.ts) 选队行的体力 chip `{ icon: 'hourglassMd' }` → `'flame'`，并把它上方那段注释里「`hourglassMd` for a time-refilled budget」那句**一并改掉**——它从此不成立，而过时注释会活两个月（[`UI_DESIGN_LOG_2026-08.md`](../game/UI_DESIGN_LOG_2026-08.md) §39/§40）。同一句话在 [`modalLine.ts`](../../client/src/scenes/worldmap/WorldMapPanels/modalLine.ts) 的 `stats` 文档注释里也有一份，同改。

**刻意不动**：

- **世界地图队伍面板的「在家 · 体力 N」行**（[`teamStatus.ts`](../../client/src/scenes/worldmap/logic/teamStatus.ts)）：那一行的字形槽已经被状态本身占着（在家 `home` / 停留 `footsteps` / 驻扎 `camp`），体力在状态文字里。给它再塞一枚火苗要先给那一行设计第二个槽位，是独立的一次版面判断。
- **HUD 与商城的沙漏**：加速 buff、占领/围攻倒计时、`SPEEDUP_ICON_TIERS` 全部保持 `hourglass*`——那三处说的**就是**时间，沙漏在那儿是对的。本批只把被借走的那一处还回来。

**backlog（不在本批）**：PvE 账号体力 `stamina.cost`（[`LevelPrepScene.ts`](../../client/src/scenes/LevelPrepScene.ts)，现在是纯文字 `Stamina 40/120`，一枚图标都没有）。同一张火苗能接，但那一行现在没有图标槽，加槽是另一处版面改动；而且 PvE 体力与队伍体力是两套独立数值（[SLG_DESIGN §4.6](../game/SLG_DESIGN.md) 末段），共用一枚字形是**刻意**的——"能量预算"是同一个概念，不要因为数值不通就画第二张。

**⑥ 测试**：

- `client/test/render/inkIconArt.test.ts` 的 `expect(OWN_ART.length).toBe(68)` → `69`，并把它上面那段算式注释补上批 13 的 1 张。
- `iconArtAspect.test.ts` **不要改** —— 超 2.2:1 是"这张该重出"的信号，不是"该加豁免"。
- `client/test/ui/worldMapTeamStaminaPicker.ui.ts` 的 `staminaOn()` 按 `s.icon === 'hourglassMd'` 找那枚 chip → 改成 `'flame'`；`client/test/ui/worldMapModalBtnStats.ui.ts` 的 `teamBtn()` fixture 同改（它只是夹具，但留着旧名字会让下一个人以为体力还是沙漏）。

**⑦ 验证**：`npm run typecheck`、`npm run lint`、`npm run build:web`（**类型过了不等于构建过了**：这张是 `import` 进来的资源，文件名错一个字母只有 webpack 会报）、`npm run check:filelength`、`vitest run` + `test:ui` 全量。

## 5. 验收口径

**用户 2026-09-17 拍板放宽了判定线**：「在最小尺寸分不清无所谓，大部分情况适用即可」。所以这一张的打回条件比前十二批**窄**：

- **不构成打回**：26px 上跟 `play` / `lead` 分不开。chip 字形实际画在 30 设计 px（§0 末段），26px 是这张图最不重要的场景。
- **构成打回**：30px 上读成三角形 / 锥体 / 叶子 / 水滴，或者读不出"这是火"；长宽比超 1.6:1（超 2.2 是硬拦线，`iconArtAspect.test.ts` 自己会红）；两个火尖等高（对称的双尖会读成王冠/兔耳）。

其余照旧：

1. **30px 和 28px × 深底 + 纸底两张 contact sheet。96px 预览不算数。** 深底 `#2c2c2a`（`C.dark`，chip 画在按钮的深色填充上，这是主场），纸底 `#f5f0e8`（`C.paper`，将来若接到信息行上）。脚本临时写在 scratchpad，用完删（别留在 `client/` 里，会被 lint 和 `check:filelength` 扫到）。
2. **成组并排看**，必须过的三组：
   - `flame` vs `play` vs `lead` —— 全库两张尖头剪影，§2 第 1 条整条就是为这一组写的；
   - `flame` vs `camp` —— **同屏**（队伍面板的驻扎行与选队弹窗的体力 chip），也是批 9 那条「camp 不许画篝火」的另一半；
   - `flame` vs `hourglassMd` vs `unit` —— 它要取代的那张，以及同一条 chip 行里的邻居（兵力）。三枚要在一行里立刻分成三件事。
3. **真机实拍**：选队弹窗走 §58 记下的那条路 —— 本机 docker 账号在世界地图上**一支队伍都没有**，真入口只会弹「尚无队伍」，所以用 `app.ts` 里的临时 hash harness（真 `WorldMapPanels` + 手搓 ctx + 真 `showModal`，提交前删）；换尺寸用 Playwright 落文件，`resize_window` 在最大化窗口上报成功却不生效。详见 [[worldmap-modal-visual-verify-2026-09-17]]。要摆出来的一屏：**五行队伍 chip 同屏**，兵力与体力两枚字形并排读成两件事。
4. **判定标准是"读成什么"，不是"好不好看"**。按批 7 log 的格式记下"v1 为什么塌"再重出，**只改导致返工的那一处措辞**（[[ai-art-density-cannot-be-prompted-2026-08-19]]）。
