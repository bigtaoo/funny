# 战场箭塔美术 — 重画 Prompt + 接线记录

> 创建：2026-08-19 · 状态：**待出图**（prompt 已定稿，打包脚本已备好，接线待图到位）
> 同类出图记录：[`back-arrow-art.md`](back-arrow-art.md) · [`player-base-image-prompts.md`](player-base-image-prompts.md) / [`-v2`](player-base-image-prompts-v2.md)
> 美术总纲：[`art-direction.md`](art-direction.md) §〇（程序绘制 vs AI 图 分工）· **§4.4 建筑美术（箭塔规格的原始出处）**
> 配套代码：[`client/src/render/BuildingView.ts`](../../client/src/render/BuildingView.ts) · [`client/src/render/cardArt.ts`](../../client/src/render/cardArt.ts) · [`client/src/assets/bootManifest.ts`](../../client/src/assets/bootManifest.ts) · 打包脚本 [`art/ui/game/pack_arrow_tower.cjs`](../../art/ui/game/pack_arrow_tower.cjs)
> 资产表：[`../game/DESIGN.md`](../game/DESIGN.md)（建筑精灵资源 / 卡面图）

## 这张图为什么必须重画

用户 2026-08-19 对着对战截图指出：现在战场上的箭塔用的是 `game_archer_barracks.png`——**这张图当初是画给「弓箭手兵营」的**（茅草屋 + 墙上挂弓 + 靶子 + 两棵光秃秃的树），弓箭手兵营那个设计后来没做，图被临时挪去当箭塔用，一直没换。

除了「它根本不是一座塔」，量下来还有三个硬问题（`sharp` 实测，非肉眼判断）：

| 指标 | 现箭塔 `game_archer_barracks` | 兵营 `game_infantry_barracks`（同族基准） | 基地 `game_base` |
|---|---|---|---|
| 墨色均值 | `rgb(56,74,71)` 灰绿 | `rgb(49,50,144)` 蓝 | `rgb(42,42,43)` 近黑 |
| 缩到 56px 后纸底（`#faf6ee`）有效对比度 | **84 / 246** | **122 / 246**（高 45%） | — |
| 墨迹 bbox 比例 | 1.57 : 1 | 1.54 : 1 | 1.26 : 1 |
| 墨量横向四等分 | 16% / 28% / 31% / 25% | — | — |

1. **墨色不同族**。三张建筑图分属三种墨（近黑 / 蓝 / 灰绿），箭塔那档灰绿墨在奶白纸底上只有兵营 69% 的对比度，实机读成「发灰、糊在纸上」。
2. **56px 的像素预算有 41% 花在布景上**。四等分墨量里，最外两带（两棵树 + 地面草皮）占 16%+25%=41%，真正的建筑只占 59% —— 战场贴图盒只有 `SPRITE_SIZE = 56`，这 41% 是纯浪费。
3. **画幅被强制拉方**。`BuildingView` 的 `sp.width = sp.height = SPRITE_SIZE` 把贴图硬拉成正方形（同 `BoardView/bases.ts` 的既有约定，见那里 2026-07-25 的注释），1.57:1 的原图因此被竖向拉伸 —— 游戏里的屋顶比原图更尖，就是这么来的。**新图必须按 1:1 取景**，否则同样会被拉变形。

## 设计定稿：石砌箭塔（遵 §4.4 已有规格）

`art-direction.md` §4.4 早就写下过箭塔长什么样——「**梯形塔身加三角顶加一支弓**」；茅草屋那张跟自家总纲都不符。定稿照 §4.4 走，只把它具体化到能出图的程度：

- **同族**：与 `game_base`（近黑墨城堡）、`game_infantry_barracks`（蓝墨城门楼）同一支——中世纪石砌、单色钢笔速写、手绘抖动、石面轻交叉排线、无上色无阴影无地台。
- **墨色**：取兵营那档蓝（`#313290`）。两者都是玩家**用卡牌造出来**的建筑，同墨色成一族；近黑墨留给不可建造的基地。实际墨色不靠出图碰运气，打包时用 `--tint` 强制（见下）。
- **剪影必须和兵营在 56px 上一眼分开**：兵营 = **宽矮**城门楼 + **垛口** + **拱门** + 旗；箭塔 = **细高梯形塔身**（下宽上窄）+ **三角尖顶**，**不画垛口、不画拱门**（垛口是兵营的辨识特征，箭塔再用就撞了——这也是不采用「垛口平顶箭塔」方案的原因）。
- **「这是箭塔」的辨识物**：顶下一层开放射击台，**一张弓从开口探出、搭着一支箭**；塔身中段一条竖长箭孔。
- **不画人**。战场单位是火柴人风格，塔上画个写实小人两种画风会打架（同 §11 头像那次「涂鸦火柴人 vs 写实数位画三套画风打架」的教训）。
- **不画旗**。兵营的旗是代码画的（`BuildingView.drawFlagWave`，箭塔分支 `flagGfx` 空着不用），箭塔走 `TOWER_SWAY` 轻微摆动；贴图里再烘一面静止的旗会和兵营的动画旗混淆。

### 构图约束（最容易翻车的一条）

渲染盒是 56×56 **正方形**且会强制拉伸，所以**墨迹 bbox 必须落在 0.95–1.10 之间**——不能交一张 1:2 的竖长图。做法不是把塔画矮，而是**把方框的下两角填实**：塔身细高居中、约占宽度一半，底部左侧一堆碎石、右侧一捆斜靠的箭，两者都压在塔身中点以下。剪影仍读作「高塔」，而 bbox 是方的。

这条不是拍脑袋：玩家基地那批 prompt 当初把等级递进写成「越来越高」（`tall tower` / `towering` / `soaring spire`），结果打包脚本等比塞进正方形 cell 后建筑高出地块整一格、往后压掉约两排格子，最后整批返工成「Grandeur through sprawl — nothing towers」（[`player-base-image-prompts.md`](player-base-image-prompts.md) §）。**能不能画高，取决于渲染盒的形状，不取决于这东西现实里多高。**

同理**禁止两侧布景**（树、灌木、栅栏、草丛）——见上面 41% 那条。

## 定稿 Prompt

```
Hand-drawn doodle building in a worn school notebook, single dark ink pen line art
(one pen, no color fill), slightly wobbly imperfect strokes, loose quick sketch with
light cross-hatching for stone texture — the style of a simple sketched medieval
castle drawn by hand in a notebook margin. Subject: ONE stone arrow tower, drawn as a
child would draw a tower: a TAPERED square stone shaft, clearly wider at its base and
narrowing as it rises, capped by a simple TRIANGULAR pitched roof — two straight lines
meeting at a peak, overhanging the shaft slightly. Directly under the roof is one open
shooting gallery, a single rectangular opening, and a longbow pokes out of that
opening with one arrow nocked and pointing outward. One narrow tall vertical arrow
slit on the middle of the shaft. At the foot of the tower and staying LOW — everything
here must sit below the tower's own midpoint — a small pile of rough stone rubble
blocks on the left side and a bundle of arrows leaning in a barrel on the right side;
these two fill the bottom corners so the whole drawing fits a SQUARE picture area.
The total drawn shape must be about as wide as it is tall (roughly 1:1, definitely not
a narrow vertical strip), with the tower centered and its base occupying about half
the picture width. Nothing else at all in the picture: no trees, no bushes, no grass,
no fence, no ground plate, no cast shadow, no flag, no people. Plain pure-white
background, no notebook grid lines. Flat 2D, no shading, no gradients. Bold confident
strokes, thick enough that the shape still reads as "a tapered tower with a pointed
roof and a bow sticking out of it" when the whole image is scaled down to 56x56
pixels — err on the side of too simple and too thick. Style of West of Loathing /
doodle art.

Avoid: color, painterly rendering, watercolor, gradients, glow, 3d render,
photorealistic look, thick clean cartoon outline, vector-art look, isometric
game-asset look, crenellations, battlements, square merlons along the top, flat roof,
arched gate, doorway, portcullis, drawbridge, round or cylindrical tower, wooden
watchtower, scaffolding, ladders, thatched roof, hut, cottage, house, wide squat
gatehouse, trees, bushes, grass tufts, ground plate, drop shadow, flag, banner,
pennant, archer figure, stick figure, people, animals, extremely tall thin
proportions (taller than twice its width), multiple towers, walls extending sideways,
text, letters, watermark, signature, gray or cream background, notebook grid lines,
paper texture, frame, border.
```

**墨色可以不管**：prompt 只要求「dark ink」，黑墨蓝墨都收——打包脚本用 `sharp` 的 `.tint()`（保亮度换色度）统一压到 `#313290`，比反复出图去碰那个蓝值可靠。

## 出图后的接线（图到位后走这一遍）

1. **源图**丢进 `art/ui/game/`（战场建筑源图都在这个目录，`pack_base_atlas.js` 的源图也在），然后：

   ```bash
   NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_arrow_tower.cjs <源图文件名>
   ```

   脚本做四件事并直接打印验收指标：近白→透明抠底 → `trim` → 长边缩到 256 → **`hardenAlpha()` 收紧边缘** → `--tint` 统一墨色 → 写出 `client/src/assets/buildings/game_arrow_tower.png`。

   > **`hardenAlpha` 不能省**。基地 2/3 级那次「贴图看着发虚/透明度不对」的病根就是缺这步：AI 出图边缘本身是羽化的，resize 到 256 又把每条边再抹开几像素，叠起来是一圈很宽的半透明渐变。修法与量化见 [`../game/UI_DESIGN_LOG_2026-06_07.md`](../game/UI_DESIGN_LOG_2026-06_07.md)（tier1/2 不透明像素占比 67.8%/87.8% → 98.7%/98.6%）。

2. **三处 import 一起换**（都指向同一张图，只换一处会出现「战场是新塔、手牌还是茅草屋」）：
   - [`client/src/render/BuildingView.ts`](../../client/src/render/BuildingView.ts) `archerTexUrl` — 战场贴图
   - [`client/src/render/cardArt.ts`](../../client/src/render/cardArt.ts) `towerArtUrl` → `CARD_ART_URLS['building_arrow_tower']` — 手牌卡面 + 图鉴
   - [`client/src/assets/bootManifest.ts`](../../client/src/assets/bootManifest.ts) `towerArtUrl` — L0 预载

   卡面侧不用改尺寸逻辑：`HandView/cellDraw.ts` 与 `CardCodexScene/tile.ts` 都走 `Math.min(...)` 等比 fit，只有战场那 56×56 是强制拉方（所以约束全压在构图上）。

3. **旧图处置**：`game_archer_barracks.png`（106 KB）从 `client/src/assets/buildings/` 删除、原图移到 `art/leftover/`（那里已有 `playerbase_l9/l10_pre20260813.png` 两张历史图，同一处置方式）。它本来是「弓箭手兵营」的设计，眼下游戏只有一种兵营，留在包里就是 106 KB 的死重（微信单包约束下不划算）。将来真做第二种兵营时从 `art/leftover/` 取回。

4. **文档**：`design/game/DESIGN.md` 两处资产表（建筑精灵资源 / 卡面图）的文件名改成 `game_arrow_tower.png`；本文状态改「已完成」并补出图轮次记录。

## 验收清单（图到位后我跑）

**量化**（`pack_arrow_tower.cjs` 直接打印，不达标就返工 prompt 而不是硬接）：

| 指标 | 阈值 | 同族基线 / 现箭塔 | 为什么 |
|---|---|---|---|
| 墨迹 bbox 比例 | 0.95–1.10 | 基地 1.26 / 兵营 1.54 / **现箭塔 1.56** | 战场强制拉方，超出就变形 |
| 56px 纸底有效对比度 | ≥ 115 | 兵营 122 / **现箭塔 84** | 低于此就读成「发灰糊在纸上」 |
| 墨量横向四等分，中间两带合计 | ≥ 75% | **现箭塔 59%** | 剩下 41% 是两棵树，白扔掉的像素预算 |
| 不透明像素 / 非全透明像素 | ≥ 90% | 基地 94.9% / 兵营 91.2% / **现箭塔 81.3%** | 边缘是否够利；低了就是基地 2/3 级那种「发虚」 |

> 最后一条的阈值是**按同族三张图实测校准**的（90% ≈ 兵营水平），不是照抄基地 atlas 那次记录里的 98.7%——那两张是大面积实心的城堡，这张是细线条塔，边缘 AA 像素占比天然更高。若某轮出图落在 85–89%，先调 `hardenAlpha` 的 `[90,170]` 窄带，而不是重画。
>
> 脚本已用现箭塔那张图**空跑自测**过：四项全部正确判 FAIL（1.56 / 83 / 59% / 79.2%），说明阈值和度量都咬得住问题图。

**实机**：起 dev server 打一局 PvE，截图核对三件事——① 塔与兵营在 56px 下一眼可辨；② 手牌卡面 / 图鉴格子里不变形；③ `TOWER_SWAY` 摆动时塔底不「离地」（塔身重心偏高的图摆起来容易露馅）。
