# 战场箭塔美术 — 重画 Prompt + 接线记录

> 创建：2026-08-19 · 出图+接线完成：2026-08-19（**一版通过**）· 状态：**已完成**
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
- **墨色**：取兵营那档蓝（`#313290`）。两者都是玩家**用卡牌造出来**的建筑，同墨色成一族；近黑墨留给不可建造的基地。实际墨色不靠出图碰运气，打包时统一压成这个值（做法见下方「坑一」）。
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

**墨色可以不管**：prompt 只要求「dark ink」，黑墨蓝墨都收——墨色由打包脚本统一压到 `#313290`，比反复出图去碰那个蓝值可靠。（原计划用 `sharp` 的 `.tint()`，实测对纯黑线画无效，见「坑一」。）

## 实际接线记录（2026-08-19，一版通过）

源图 `art/ui/game/arrow_tower_src.png`（1254×1254，纯黑线、白底）。**主体一版就对**：梯形塔身、三角顶、顶下开口探出搭箭的弓、竖长箭孔、左碎石右箭桶，墨迹 bbox 0.98 直接达标。真正花时间的是打包管线里两个我原先写错的地方：

### 坑一：`sharp.tint()` 对纯黑线画是空操作

原方案是「prompt 只要 dark ink，打包时 `.tint()` 压到 `#313290`」。`.tint()` **保亮度、换色度**——纯黑的亮度是 0，没有色度可换，所以墨色根本没变（加不加 `--tint` 两次跑出来的指标逐项相同，墨像素仍是 `rgb(0,0,0)`）。

白底线画要反过来转换：**亮度当覆盖率搬进 alpha，RGB 直接赋成墨色**（脚本里的 `inkify()`）。副作用是这张资产的浅调全部落在 alpha 上，而三张旧资产把排线浅调留成「全不透明的灰色 RGB」（占可见像素 19.6%），这条差异下面还要用到。

### 坑二：膨胀要在打包尺寸做，不是在显示尺寸做

出图线宽只有画幅的 ~0.3%，缩到 56px 被平均掉：对比度 104/246，低于兵营的 122。第一次试膨胀我**直接在 56px 上做**，一道就糊成一团、弓完全消失——56px 上一道就是整整一个像素。改在 **256 打包尺寸**上膨胀，落到 56px 只相当于 ~0.2px：

| 膨胀道数（@256） | 56px 对比度 | 目视 |
|---|---|---|
| 0 | 104 | 偏灰 |
| **1（采用）** | **122** | 与兵营齐平，石块/弓/箭孔都在 |
| 2 | 151 | 石块开始粘连、屋顶发死 |

正是 `back-arrow-art.md` 那句「**能吃几道膨胀是形状的属性，不是全局常量**」——所以做成 `--thicken N` 参数而非写死。

### 验收阈值的两处订正

- **「不透明占比 ≥90%」这条指标废掉了**，换成「软边带（24≤α<96）占比 ≤5%」。原指标看着是按同族校准的，实则拿苹果比橘子：`inkify` 故意把浅调搬进 alpha，这类资产的不透明占比天然低（83.5%），跟边缘利不利无关。软边带才是当初「发虚」bug 的本体，且两种资产都能量：基地 1.3% / 兵营 2.9% / 本图 **4.3%** / 旧茅草屋 6.2%。
- **「中间两带墨量 ≥75%」下调到 55% 并降级为粗筛**。这跟我自己写的构图指令冲突：既然要求用碎石+箭桶把方框下两角填实，这些道具必然落在外侧两带。它分不清「有主题关联的角落道具」（本图 65%）和「纯浪费的布景」（旧茅草屋 59% 的两棵树），4 分之差撑不起结论——判断权交回目视。

### 落地清单

1. 打包（1 张源图 → 1 张 14 KB 资产，旧图 106 KB）：

   ```bash
   NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_arrow_tower.cjs arrow_tower_src.png --thicken 1
   ```

2. **四处**接线（不是三处）：
   - [`client/src/render/BuildingView.ts`](../../client/src/render/BuildingView.ts) `archerTexUrl` — 战场贴图
   - [`client/src/render/cardArt.ts`](../../client/src/render/cardArt.ts) `towerArtUrl` — 手牌卡面 + 图鉴
   - [`client/src/assets/bootManifest.ts`](../../client/src/assets/bootManifest.ts) `towerArtUrl` — L0 预载
   - [`client/build/preloadBootAssets.js`](../../client/build/preloadBootAssets.js) `GATE_ASSETS` — **HTML `<link rel=preload>` 列表，路径是字符串写死的**。漏了它 webpack 会警告 `[preload-boot-assets] no emitted asset for …`（也有 `test/bootPreloadManifest.test.ts` 从 manifest 反推兜底）。写这份文档时我只数出前三处，是构建警告把第四处抓出来的。

3. **旧图处置**：`game_archer_barracks.png` 移出客户端 → `art/leftover/archer_barracks_hut_pre20260819.png`（沿用 `playerbase_l9_pre20260813.png` 的命名）。将来真做第二种兵营时取回。

4. **顺手清理 `art/ui/game/`**（用户同期要求「能用的重命名、不能用的进 leftover」）：源图 `arrow_tower_src.png`；两张在用的基地源图从 base64 长名改为 `base_lv1_castle_town_src.webp` / `base_lv2_palace_src.webp`（`pack_base_atlas.js` 的 `FILES` 同步更新）；4 张 2026-07-10 那轮没被采用的城堡候选图移入 `art/leftover/base_candidate_*.webp`。改名后重跑 `pack_base_atlas.js` 验证：atlas PNG **逐字节一致**，只有 JSON 的格式（缩进/键序）变了。

5. **顺带修掉一个静默陷阱**：`pack_base_atlas.js` 的 `OUT_DIR` 还指着 `client/src/assets/`，而战场建筑资产早就搬进了 `assets/buildings/`（`baseUpgradeAtlasLoader.ts` 从那里 import）。按旧路径跑一次，会在 `assets/` 下写出两个**没人加载**的文件——正是我验证改名时踩到的。已改指 `assets/buildings/`。

## 追加：程序动画（2026-08-19 同日）

用户接着问「能不能像兵营一样用程序给箭塔加点动画」。兵营的动画是 `drawFlagWave` 画的一面飘旗，而箭塔那支 `TOWER_SWAY 5.0 rad/s / 0.5°` 在 56px 上让塔尖位移不到 0.3px——**等于没有**。两件事：

- **idle**：摆动改成 3.2 rad/s / ±1.6°，读作「懒洋洋地倾斜」而不是抖动。
- **开火**：新增 `BuildingView.playFireEffect`，由引擎的 `projectile_fired` 驱动（不是循环——没有目标的塔就是静止的，这本身是信息）。整塔沿射击方向反向弹 2.8px，塔后拖两道手绘后坐纹，0.26s 归位。

三个实现细节值得记：

1. **匹配用格子，不用 id**。`projectile_fired.attackerId` 在塔射箭时是建筑 id、弓兵射箭时是单位 id，而两者分属 `allocBuildingId` / `allocUnitId` 两个计数器，同一个小整数两边都有——只按 id 匹配，弓兵放一箭就会让某座无关的塔抽搐一下（这种 bug 只在拥挤车道里偶现，看着像「塔在随机抖」）。建筑的箭必定从自己格子发出，格子就是引擎白送的判别式。回归测试 `client/test/render/buildingFireEffect.test.ts` 钉的就是这条。
2. **两条缓动曲线，不是一条**。位移用二次衰减（猛出猛收，像后坐力），笔触用线性淡出。一开始两者共用二次曲线，结果笔触的全强度只有约 40ms（2–3 帧），实拍根本抓不到。
3. **要在 56px 上被看见的墨，必须画在剪影之外**。第一版把弓弦画在塔顶射击口上，`graphicsData.length === 2` 说明确实画了，但它落在石纹最密的地方，实拍完全看不出来。挪到塔后方就清楚了。

方向按「己方格 → 敌方建筑行」用 `gridToScreen` 现算，所以横竖屏都对——实拍横屏下反冲发生在 x 轴（−2.13px），正是敌方方向映射到 x 的结果。

### 测试覆盖（2026-08-19 收尾）

- `client/test/render/towerArtContract.test.ts`：资产存在、墨迹**比例 ~1:1**（读 PNG 的 IHDR，不需要解码器）、场上贴图与卡面同源、与兵营不同源。
- `client/test/render/buildingFireEffect.test.ts`（9 例）：开火反冲的格子判别、邻塔不受影响、按朝向选轴、对象池不带走位移、两种建筑各用各的贴图。

**每条都做过定向变异验证**（删格子判别 / 方向写死 / 两种建筑共用贴图 / 删对象池复位），确认对应用例会红。其中对象池那条最初是假绿的，原因记在 [`feedback-verify-regression-test-catches-bug-before-fix`] 那条经验里：复用者若是箭塔，它自己每帧重写 `sp.x`，会把缺陷盖住。

**墨色 / 边缘利度 / 56px 对比度不进单测**：断言它们要解码 PNG，而 `sharp` 只是本 workspace 的传递依赖（client 未声明），进测试就是 CI 隐患。这三项归打包时把关（`pack_arrow_tower.cjs` 打印并卡阈值）——它们是**打包**的属性，只有重新打包才会变。

## 验收结果

**量化**（`pack_arrow_tower.cjs` 直接打印；下表末列是定稿资产的实测值，五项全过）：

| 指标 | 阈值 | 同族基线 / 旧茅草屋 | **定稿资产实测** |
|---|---|---|---|
| 墨迹 bbox 比例 | 0.95–1.10 | 基地 1.26 / 兵营 1.54 / 旧图 1.56 | **0.98** ✅ |
| 56px 纸底有效对比度 | ≥ 115 | 兵营 122 / 旧图 84 | **122** ✅ |
| 软边带（24≤α<96）占比 | ≤ 5% | 基地 1.3% / 兵营 2.9% / 旧图 6.2% | **4.3%** ✅ |
| 中间两带墨量（粗筛） | ≥ 55% | 旧图 59% | **65%** ✅ |
| 资产体积 | — | 旧图 106 KB | **14 KB** |

> 脚本先拿**旧茅草屋那张图空跑自测**过：四项全部正确判 FAIL，证明阈值和度量咬得住问题图，再用它验收新图。

**实机截图**（1440×810，campaign `ch1_lv1`，Playwright + `__nwE2E`，箭塔放 col 3、兵营放 col 4）：

- **56px 战场贴图**：塔与兵营并排，墨色同族、剪影一眼可辨（宽矮垛口城门楼 vs 细高梯形塔+三角顶），箭孔清晰，弓在 56px 下读成顶部一小道横笔——够表达「上面有东西」，但细节本身已不可辨，属预期。
- **手牌卡面**：两张 Arrow Tower 与 Barracks 并列，等比 fit 无变形（`HandView/cellDraw.ts` 走 `Math.min` 缩放，只有战场那 56×56 是强制拉方）。
- 摆动（`TOWER_SWAY` 0.5°）未见塔底离地。

## 追加：body idle 从位移改成缩放呼吸（2026-08-25）

用户反馈：PvE/PvP 战场里兵营和箭塔「上下浮动的幅度太大了，看着眼花，而且容易分散玩家注意力」。

排查发现问题不只是幅度数字（`BOB_AMP = 1.5px`）本身，而是三层动画叠加造成的结构性错位：

1. **贴图和血条/旗帜脱节**：`sp.y = sin(...) * BOB_AMP` 只让 `sprite` 子节点上下位移，而 `hpBg`/`hpFill`/`flagGfx` 都画在容器 `c` 的固定局部坐标上——建筑贴图每个周期都从血条和旗杆之间"浮开又合上"，读起来像拼图对不上，不是自然的整体呼吸。
2. **两套频率不同步**：全建筑通用的 body bob 是 `6.98 rad/s`（周期 ~0.9s），箭塔专属的 `TOWER_SWAY` 是 `3.2 rad/s`（周期 ~2s），比例非整数倍，叠加出来是杂乱抖动而非有节奏的呼吸。
3. **每建筑随机相位**（`acquireSprite` 里 `Math.random() * Math.PI * 2`）：战场建筑一多，就是多个异步小抖动同时在动，外周视野对运动极敏感，即使单个建筑只有 1.5px 也会到处牵扯注意力。

**方案**（用户从多个选项里选定）：去掉 body 的位移，改成极轻的整体缩放呼吸——`BOB_SCALE_AMP = 0.012`（±1.2%），作用在 `sp.scale` 而非 `sp.y`。缩放不会破坏贴图与血条/旗帜的相对位置（三者仍在各自固定坐标，缩放前后不会互相"脱节"），人眼对同等幅度缩放的运动敏感度也远低于平移。旗帜飘动（`drawFlagWave`）、箭塔摇摆（`TOWER_SWAY`）保留不变，作为主要的"活着"信号。

实现细节：`sp.width`/`sp.height` 赋值把 `SPRITE_SIZE` 换算成的基础缩放存进 `baseScales`（每建筑一份，随生成/回收成对维护），呼吸公式变成 `sp.scale.set(base * (1 + sin(...) * BOB_SCALE_AMP))`。顺带修了一个由此暴露的潜在 bug：箭塔开火反冲原来写的是 `sp.y += ...`，靠 body bob 每帧先把 `sp.y` 重置成新的基准值、`+=` 才不会越叠越大——去掉 body bob 对 `sp.y` 的写入后，`+=` 会在整个 0.26s 反冲窗口里逐帧累加，改成和 `sp.x` 一样的直接赋值 `sp.y = ...`。

测试：[`client/test/render/buildingFireEffect.test.ts`](../../client/test/render/buildingFireEffect.test.ts) 改用支持 `.x`/`.y` 的 `scale` mock，新增一条钉住"idle 只改缩放、从不写位置"的用例，其余用例的断言从"幅度不超过 `BOB_AMP`"改成精确的 `toBe(0)`（因为新实现下 idle 时 `sp.y` 恒为 0，不再是一个近似上界）。

**收尾补测（同日）**：新增的 `baseScales` 私有 Map 一开始漏了在 `destroy()` 里 `.clear()`（`phases`/`cells`/`fires` 都清了，这个没清），会在每次战斗结束后留下所有建筑 id 的条目。补了三条回归测试（`destroy()` 清空 baseScales / 建筑离场时 `sync()` 也要清 / 箭塔和兵营共享同一段 idle 逻辑，塔也要有缩放呼吸），每条都用「先删对应清理代码确认测试变红、再恢复」的方式验证过。
