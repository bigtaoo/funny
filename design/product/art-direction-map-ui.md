# 美术总纲 — 地图 / UI / 特效 / 品牌（六 起）

> 从 [`art-direction.md`](art-direction.md) 拆出（2026-08-17，原文件 611 行）。**小节编号沿用原文**，`art-direction.md §N` 引用照旧有效。
> 本册内容：六 地图与背景、七 UI 规范、八 特效、九 商业化美术、十–十三 声音/参考/范围/品牌。总览与在先小节见 [`art-direction.md`](art-direction.md)。

---

## 六、地图与背景规范

### 6.1 背景底层

- 方格纸纹理，格线极浅，不喧宾夺主（程序画，见 §五）
- 纸张略有纹理感（非纯色填充）
- **翻了一年的笔记本**：边缘泛黄、折痕、手蹭花、透印——独立静态 overlay 层（§3.1）

### 6.2 装饰物（涂鸦层）

在地图**非战斗区域边缘**、以及 UI 大背景纸面上点缀少量涂鸦，强化"用过的笔记本"质感，**不进战斗区、不压前景信息**（§7.1：装饰层可乱，功能层须清晰）。装饰作为离散精灵 snap 到锚点；错位无妨，纯氛围。

**资产生产方式**：AI 出图（单色手绘涂鸦）→ GIMP 抠白底存透明 PNG → 程序侧 `tint` 出蓝（我）/红（敌）。分三组（A 战场边缘小涂鸦 / B 战场角落手写标注 / C UI 大背景装饰）。

#### 共用 prompt 前缀（贴在每个 prompt 主体前）

```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick careless 5-second sketch, very loose, no shading or only
light pencil hatching, no outline cleanup. Isolated single object, centered,
on a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline. Style of
West of Loathing / doodle art.
```

#### 共用负向提示

```
color, painterly, shading, gradient, 3d render, photorealistic, thick bold
outline, clean vector, multiple objects, text watermark, gray background,
notebook grid lines, drop shadow
```

> **单色生成**，程序侧 `tint`。每件抽 2–3 张挑一张；标 ★ 的多抽几张存成随机变体（运行期随机选，避免重复得假）。C 组（UI 背景）把前缀里 `single dark-ink pen` 改成 `light grey pencil, faint`，直接出淡色衬底。

#### A 组 — 战场边缘小涂鸦（PvP + PvE 通用，~48–64px）

| 资产名 | 笔色 | prompt 主体（接前缀后） | 状态 |
|---|---|---|---|
| `decor_sun` | 铅笔 | `a tiny doodle sun with a few short radiating rays, childlike`（已采用带笑脸版，归 ~80–96px 档，小尺寸笑脸糊掉可接受） | ✅ 定稿 |
| `decor_star` ★ | 铅笔 | `a small lopsided five-pointed doodle star drawn in one stroke`（已采用开口星，当"大星"档；变体需补一张更接近实心轮廓的小尺寸星） | ✅ 定稿 |
| `decor_sparkle` ★ | 铅笔 | `a small four-point sparkle / twinkle shine mark`（已采用空心四角闪光，当大/中档；变体需补一张实心短尖的小尺寸闪光） | ✅ 定稿 |
| `decor_arrow` | 蓝钢笔 | `a short curved hand-drawn arrow pointing to the side` | ✅ 定稿 |
| `decor_exclaim` | 红圆珠笔 | `a single bold exclamation mark, gone over twice for emphasis` | ✅ 定稿 |
| `decor_question` | 红圆珠笔 | `a casual doodle question mark` | ✅ 定稿 |
| `decor_scribble_out` ★ | 铅笔 | `a line of scribbled-out crossed-through illegible draft text` | ✅ 定稿 |
| `decor_heart` | 红圆珠笔 | `a tiny doodle heart drawn in one careless stroke` | ✅ 定稿 |
| `decor_spiral` ★ | 铅笔 | `a small idle bored spiral loop scribble` | ✅ 定稿 |
| `decor_cloud` | 铅笔 | `a small simple doodle cloud outline, a few bumps` | ✅ 定稿 |
| `decor_lightning` | 铅笔 | `a tiny doodle lightning bolt zigzag` | ✅ 定稿 |
| `decor_flower` | 铅笔 | `a tiny simple doodle flower, five round petals` | ✅ 定稿 |

> **A 组已全部出图并打包**（2026-06-25）：源图（白底 webp/png）在 `art/ui/decos/`，打包脚本 `art/ui/decos/pack_decos.cjs`（复用 client 的 sharp：白底转透明 + 裁留白 + 等比缩放长边 64 + shelf-pack）。产物 `decor_atlas.png`(256×256) + `decor_atlas.json`（TexturePacker JSON-Hash，帧名不带扩展名，如 `decor_sun`）。改图后重跑 `node pack_decos.cjs` 即可。**注**：线条为原墨色、非白色，故不可直接 `tint` 上阵营色；红圆珠笔类（exclaim/heart/question）若要染红需另出白线版或单独红色图。

#### B 组 — 战场角落手写标注（~96px 宽；PvE 战役感更强，PvP 可只用 START）

| 资产名 | 笔色 | prompt 主体 | 状态 |
|---|---|---|---|
| `label_boss` | 红马克笔 | `the word "BOSS" hand-lettered in messy block capitals, underlined twice` | ✅ 出图 |
| `label_start` | 蓝钢笔 | `the text "[START]" hand-lettered in casual block capitals with square brackets` | ✅ 出图 |
| `label_win` | 蓝钢笔 | `the word "WIN!" hand-lettered cheerfully, slightly bouncing letters` | ✅ 出图 |
| `label_arrow_here` | 红圆珠笔 | `a long curved hand-drawn arrow with the scribbled word "here"` | ✅ 出图 |

> **B 组已出图**（2026-06-27）：源图（白底 webp）在 `art/ui/decos-b/`，打包脚本 `art/ui/decos-b/pack_labels.cjs`（同 A 组抠白底口径，额外**改色**：白底转透明算出 alpha 后覆盖线条 RGB 为目标墨色，保留抗锯齿边缘）。AI 出图为黑/深色线稿，**打包时按 spec 笔色 + 我蓝敌红改色**：`label_boss` / `label_arrow_here` → 红 `#d0262c`（权威/假想敌），`label_start` / `label_win` → 蓝 `#263a7a`（己方）。产物为透明底单色 PNG（长边 256 高分源，角落按需缩小）→ `client/src/assets/decor/battle/label_*.png`。改图/改色重跑 `node pack_labels.cjs`。**注**：角落标注放置逻辑（见下 §6.2 末）尚未接入代码。

#### C 组 — UI 大背景装饰（菜单/大厅等纸面后方，~128px；与 hub 无绑定，通用纸面氛围）

| 帧名（atlas frame） | 内容 | 状态 |
|---|---|---|
| `decoc_soldier` ★ | 单个戴罗马盔持长矛的火柴兵 | ✅ 打包 |
| `decoc_soldiers` | 三个钢盔火柴兵列队行军 | ✅ 打包 |
| `decoc_castle` | 双塔城堡 + 三面三角旗 + 城门 | ✅ 打包 |
| `decoc_swords` | 交叉双剑 | ✅ 打包 |
| `decoc_shield` | 鸢形盾 + 十字徽 | ✅ 打包 |
| `decoc_catapult` | 侧视投石车（带轮） | ✅ 打包 |
| `decoc_airplane` ★ | 纸飞机 | ✅ 打包 |
| `decoc_compass` | 八角罗盘（N/E/S/W） | ✅ 打包 |
| `decoc_crown` | 三尖皇冠 | ✅ 打包 |
| `decoc_inkblot` ★ | 墨渍飞溅（实心填充） | ✅ 打包 |
| `decoc_inkblot_outline` | 墨渍飞溅（仅描边） | ✅ 打包 |
| `decoc_thinking` | 思考乱线团（思维气泡） | ✅ 打包 |
| ~~`bg_banner_flag`~~ | 三角旗 | ✗ 剔除（源为实拍笔记本照片，带纸纹/暗封皮，抠白底出脏边，风格不符） |

> **C 组已出图 + 打包**（2026-06-27）：源图（白底 webp）在 `art/ui/decos-c/`（语义名 `decoc_*.webp`，被剔除的 pennant 留原哈希名不参与 glob），打包脚本 `art/ui/decos-c/pack_decos_c.cjs`（沿用 **A 组**抠白底口径：白底转透明 + 裁留白 + 等比缩放 + shelf-pack + TexturePacker JSON-Hash，**保留原墨色不改色/不 tint**）。仅按 C 组精细度上调参数：长边 64→**128**、图集宽 256→**512**。产物 `decor_c_atlas.png`(512×512) + `decor_c_atlas.json`（帧名不带扩展名，如 `decoc_crown`）→ **直接放 `client/src/assets/decor/`**（非 battle/、非 hub/，通用）。改图后重跑 `node pack_decos_c.cjs`。**注**：① 线条为原黑墨、非白色，故不可直接 `tint` 上阵营色；作淡背景时由渲染期 alpha 压淡（同 A 组 faint alpha 做法）。② 加载/放置逻辑尚未接入代码，加载方式可复刻 `decorAtlas.ts`（改 import 路径到 `decor/decor_c_atlas.{png,json}`）。

#### 资产目录约定

```
art/ui/decos{,-b,-c}/      # 源图（白底 webp/png）+ 打包脚本
client/src/assets/decor/   # 最终透明 PNG / 图集
  battle/  decor_atlas.* label_*.png   (A+B 组)
  decor_c_atlas.*                      (C 组，根目录、通用)
```

- PNG-32 RGBA，透明底；A 组 ~48–64px / B 组 ~96px 宽 / C 组 ~128px。A/C 组保留原墨色不 tint，B 组打包时改阵营笔色
- 风格须与 `sketch.ts` 程序笔触同频，不要卡通描边

> **实现状态**：A 组装饰层渲染**已落地**（2026-06-25，战斗场景内）。落地做法：
> - **图集加载**：`client/src/render/atlas/decorAtlas.ts` 用 `PIXI.Spritesheet` 加载 `client/src/assets/decor/battle/decor_atlas.png/.json`（帧名不带扩展名，如 `decor_sun`）。App 启动时 `loadDecorAtlas()` 后台预解码（fire-and-forget，纯装饰，失败不阻塞启动）；图集很小，进战斗前一般已就绪，未就绪则该局无装饰（可接受）。线条为原墨色，**不 `tint`**。
> - **锚点系统**：`client/src/render/decorLayer.ts`。沿棋盘**左右两侧**外缘纸条（`boardRect` 之外、其纵向区间内的两条边带）取锚点——边带由 `boardRect` 推导，天然落在顶部 HUD 之下、底部 HUD/手牌之上，故**绝不与战斗格/基地/HUD 重叠**。每槽按确定性 PRNG 随机挑帧 + 轻微旋转/缩放/位置抖动；`SKIP_PROB` 留空使其稀疏克制；faint alpha（0.4~0.62）不抢前景。竖屏边带仅 36px → 小号涂鸦；横屏边带宽裕 → 至多 64px。
> - **静态烘焙**：每条边带的涂鸦烘成一张静态纹理（`bake()`，key=`decor:{orientation}:{side}:{w}x{h}:{cell}`），运行期零开销。`BoardView` 在 `drawBoard()` 之后 `drawDecorations()` 加入，位于棋盘静态层之上、所有动态/游戏层之下；`interactiveChildren=false` 不吃指针。绝不烘焙文字/数字（§5 铁律）。
> - **确定性 vs「换局再变」**：布局按 `orientation+side` 固定种子，**跨局稳定**（与烘焙棋盘网格一致）。未做逐局重掷——那会产生无界的边带纹理缓存，对边角氛围不值当。
> - **B 组（角落手写标注）已出图 + 已接入**（2026-06-27）：
>   - **加载**：`client/src/render/labelDecor.ts` —— 4 张独立 PNG（非图集），App 启动 `loadLabelDecor()` 后台预解码（fire-and-forget，纯装饰，失败不阻塞）；线条已是 spec 笔色，**不 `tint`**。
>   - **角落放置**：`client/src/render/battleLabels.ts` `buildBattleLabels(layout, ctx)` —— 复用 A 组同款棋盘左右边带（`boardRect` 外缘，绝不碰格子/基地/HUD，`interactiveChildren=false`）。`[START]` 放本方基地侧、`BOSS` 放敌方基地侧；边带够宽则横排、窄则旋 90° 作侧栏批注。至多两张静态精灵，不烘焙（live 即可，headless 也安全）。`BoardView.showBattleLabels(ctx)` 在构造后由 `GameRenderer` 调用（战斗上下文构造期未知）。
>   - **上下文**：`GameScene` 算 `BattleLabelContext`——非教学局一律 `start:true`（「PvP 可只用 START」），`level.objective.kind==='boss'` 追加 `boss:true`；教学局留空（导演自带分镜）。
>   - **WIN!**：`label_win` 挂在胜利浮层（`HUDView.showGameOver`，仅本方获胜时），不走边带。
>   - **→ here 箭头**（`label_arrow_here`）：已加载、保留给教学指向，暂未自动放置。
> - **C 组（UI 大背景）已出图 + 已接入大厅**（图集 `decor_c_atlas.*`）：
>   - **加载/散布**：`client/src/render/atlas/decorCAtlas.ts` 加载图集；`client/src/render/decorCLayer.ts` `buildDecorCLayer(w,h)` 在纸面背景上按确定性 PRNG 散布、整层 `bake()` 烘焙、`interactiveChildren=false`。大厅 `LobbyScene.build()` 调用接入。
>   - **调参（2026-06-27）**：原 alpha `0.06–0.15` 几乎不可见 → 提到 `0.10–0.22`；散布改「边角密、中心疏」（`EDGE_SKIP=0.28 / CENTER_SKIP=0.80`），因为均匀网格会把涂鸦铺到中央内容带、被 hero/pillar 面板盖住浪费，反而显得"装饰太少"。现集中在四周边框区（笔记本涂鸦本就在边角）。
> - **大厅核心卡片大号手绘母题（2026-06-27）**：不上位图照片（§6.1 分工：UI=程序绘制），改用 SketchPen 线稿母题作卡面主视觉。`client/src/render/icons.ts` 新增 `castle`（城垛+塔楼+拱门+小旗，大世界 pillar）、`pencils`（交叉铅笔，呼应文具三笔，盖在「开始匹配」hero 右侧）；战役 pillar 复用放大的 `book`。pillar 母题 `h*0.6`、alpha 0.6 填充卡面上半，标题随后绘制盖其上仍清晰。同时「开始匹配」hero 加高（`0.135h→0.165h`）、内容栈上偏居中收掉 header 下留白。
> - **养成页内容图标按资产分工归位（2026-06-27）**：养成（CollectionScene）卡牌/单位/皮肤三 Tab 原为纯文字。按 §〇 资产分工——**角色/兵种=AI 图位图，UI=程序绘制**——落地：**卡牌图鉴 + 单位卡用真实位图立绘**（不是手绘符号），因其直接代表游戏内的卡牌/兵种，若另画一套手绘符号会和战斗里玩家看到的对不上、造成困惑。立绘 url 映射从 `HandView` 抽到 `render/cardArt.ts` 作单一真源（战斗手牌与养成页 import 同一份）；单位卡用 `UNIT_ART_URLS`（六兵种 png 全有）。**皮肤衣柜保留手绘图标**（`icons.ts` 新增 `brush` 笔刷 + 复用 `pencils`），因皮肤是服务器 id、无角色立绘可绑。期间一度尝试给卡牌/单位画手绘小人母题（`unit_melee/shield/archer` 等），按本条结论作废删除。详见 `design/game/UI_DESIGN.md` §4.5。

### 6.3 基地视觉

双方基地为**2×2格**手绘城堡图标，简笔轮廓，内含 HP 血条（铅笔格子填充的血量格）。血量减少时城堡轮廓出现裂缝涂鸦（live 层，见 §5.3）。

**城堡贴图留白（2026-08-09 修）**：城堡贴图（`BoardView.buildBaseRef`）此前 `sprite.width/height` 精确等于 2×2 格碰撞盒（`rect.w/h`），边到边零留白——贴脸放在紧邻基地那一列（`ATTACK_LANES` 里离 `BASE_COLS` 最近的列）的建筑（兵营/箭塔）因而与城堡墙体几乎零间距贴合，PvE/PvP 对局中读成"建筑糊在城堡上"（用户反馈）。修法：`BASE_ART_INSET = 0.86`，城堡贴图在 2×2 格内做等比内缩（贴图仍居中，呼吸动画/临界圈仍按原碰撞盒 `rect` 走，不受影响），把城堡边缘与相邻建筑格的视觉间隙从 ~7px 拉到 ~17px（70px 格边长的 24%）。

---

## 七、UI规范

### 7.1 核心原则

> **装饰层可以"乱"，功能层必须清晰。** 涂鸦感只用于背景装饰、卡片边框、按钮纹理等非信息载体；手牌、金币、血条等核心信息需 0.5 秒内可读，不被涂鸦干扰。

所有 UI 从「笔记本」diegetic 框架长出（§一）：便签纸面板、涂鸦方框按钮、页边批注菜单、翻页/橡皮擦转场。UI 同样走程序绘制 + 烘焙缓存（§五），文字永远 `PIXI.Text`。

### 7.2 手牌设计

- 每张卡牌是**便签纸/小卡片**形态，带轻微卷角或撕边
- 卡面：单位/建筑/法术简笔图标（与游戏内一致）+ 费用数字（手写字体）
- 底部轻微扇形展开；无法出牌时覆盖"涂改液白"半透明遮罩、费用数字被划掉

#### 7.2.1 法术卡图标（已落地，2026-06-27）

单局内 4 种法术（PvP：`haste` 急速冲锋 / `meteor` 陨石打击；PvE 关卡专属：`rockslide` 石壁崩塌 / `bridge_collapse` 桥梁坍塌）原先**只有文字无图**，现补齐卡面图标 + 法术卡专属视觉签名。

- **三色签名**（§3.3 法术=红马克笔；此处 UI 功能色，不受战场敌我蓝红约束）：三种牌型各带颜色标识——①卡面铺一层极淡颜色晕染（alpha≈0.07）；②左上角一道手绘**折角**替代原先干巴巴的类型字符。颜色对照：**单位卡 = ink-blue 蓝**（`palette.inkBlue`）、**建筑卡 = marker 金**（`palette.marker`）、**法术卡 = ink-red 红**（`palette.inkRed`），0.3 秒可辨。费用圈/名字/刷新条规则全卡统一，不破例（§7.1 功能层须清晰）。
- **图标本身**：手绘墨线 doodle + 单道红马克笔重点（与 §3.3「红马克笔粗线」同频），白底出图。**红重点已烤进图、不 tint**（法术图标是卡面插画，非战场可染色单位）。
- **资产管线**（同 §6.2 decor「抠白底」口径）：AI 出图（白底）→ `art/skills/pack_spells.cjs`（复用 client 的 sharp：近白→透明 + 裁透明边 + 长边缩 256）→ 导出 `client/src/assets/spell_${SpellType}.png` → [HandView.ts](../../client/src/render/HandView.ts) `CARD_ART_URLS` 按 `spell_${card.spellType}` 取用、`configureArt` 原样复用。改图后重命名覆盖源文件、重跑 `node pack_spells.cjs`。
- **出图 prompt**（共用前缀 + 负向 + 4 条主体）存 art/skills 旁的脚本注释口径无关，记录于下，便于后续补图：

  共用前缀：
  ```
  Hand-drawn doodle icon for a game spell card, drawn in a worn school notebook.
  Bold dark-ink pen line art with slightly wobbly imperfect strokes, plus ONE
  strong red marker accent stroke highlighting the key action. Energetic, a bit
  explosive, but still a quick loose sketch — not polished. Single clear icon,
  centered, filling the frame, on a plain pure-white background, no grid lines,
  no other elements. Flat 2D, no shading or only light pencil hatching. Style of
  West of Loathing / doodle art.
  ```
  共用负向：`full color, painterly, soft shading, gradient, glow, 3d render, photorealistic, thick clean cartoon outline, vector art, multiple objects, text, letters, watermark, gray background, notebook grid lines, drop shadow, blue ink`

  | 资产 | 主体 |
  |---|---|
  | `spell_haste` | parallel curved speed lines streaking sideways + wind-gust swirl + a running boot kicking dust; red accent traces the leading speed line |
  | `spell_meteor` | a chunky lumpy meteor plunging diagonally from the top corner, thick streaking trail + impact spark; red accent is the burning trail |
  | `spell_rockslide` | jagged boulders tumbling down a steep slope in a vertical cascade + dust puffs; red accent slashes across the falling rocks |
  | `spell_bridge_collapse` | a plank bridge cracking and snapping in the middle, two halves tilting into a gap + broken planks; red accent marks the central crack |

### 7.3 金币与资源显示

- 金币：手写数字字体 + 简笔硬币图标
- 上限提示：数字旁小感叹号涂鸦（非弹窗）
- 加速时：数字旁手绘速度线

### 7.4 字体

- 数字与核心信息：圆润手写感等宽字体，清晰优先
- 标题/装饰文字：随意手写风字体，可略歪
- 禁止：系统默认字体、过度设计的艺术字体

### 7.5 按钮与菜单

- 按钮：矩形 + 不规则手绘描边（非完美圆角）
- 菜单背景：大张方格纸，带笔记本装订线（左侧红色竖线）

#### 7.5.1 按钮状态规范（必须一眼可辨，不靠猜）

按钮的「能不能点」「点了没点到」必须在视觉上立刻读出来，**禁止**所有状态长得一样、靠用户试错。三态强制区分：

| 状态 | 何时 | 视觉 |
|---|---|---|
| **可用（enabled）** | 操作此刻就能成功（如表单已通过校验） | 实底（深色/纸面）+ 醒目手绘描边（金/蓝）+ 白/深粗字，饱和、显眼 |
| **不可用（disabled）** | 操作此刻不会成功（字段空 / 不合规 / 两次密码不一致 …） | 淡灰底（paper-grey）+ 灰字 + 更细描边 + 整体 alpha ≈ 0.55，明显「按不动」；**点击 inert**（无反应，配合就近的实时合规提示说明原因） |
| **按下（pressed）** | 点击可用按钮的瞬间 | 以**中心**为轴快速放大回弹（1.0 → ~1.12 → 1.0，约 0.12s），**动画结束才触发动作**；放大期间吞掉其它点击，防误触/重复提交 |

要点：
- 可用/不可用由「该操作此刻是否会成功」单一规则驱动，且**与真正的提交校验逐字一致**（同一个判定函数或镜像逻辑），二者永不打架；每次输入都重绘，所以条件一满足按钮**立刻**由灰变亮。
- 「按下放大」是 v0.3 起对旧条款「按下=轻微下压 + 纸张褶皱」的口径修订：先用**放大回弹**做点击确认（实现简单、反馈明确）；后续做正式纸面动效时可叠加褶皱，但「中心放大 + 延迟触发」的反馈契约保留。
- 错误信息为「黏性」时必须可被编辑清除：用户一改输入就清掉上一条错误（实时合规提示同步刷新），避免按钮看着像卡死。
- 首个落地参考实现：登录/注册场景 `client/src/scenes/LoginScene.ts`（`submitEnabled()` 判定 + `addButton(enabled)` 灰显 + `press` 放大回弹）。
- **全屏场景共享原语**：所有 canvas 绘制的全屏场景（login / room / shop / gacha / result / replay / intro / settings）统一从 `client/src/render/sketchUi.ts` 取手绘 UI 原语——`buildPaperBackground`（纸底 + 抖动格线 + 红装订线，bake 缓存）、`sketchPanel`（平涂 `Graphics` + 九宫装配的手绘边框——四条长边条按原生尺寸平铺 + 四个**半径各不相同**的手绘圆转角，切片来自 `render/panelFrame.ts` 启动时烘一次的图集；**替代 `drawRoundedRect`**，落实「按钮非完美圆角」——注意本条禁的是等半径/模板画的圆角，手转的不等半径圆角正是它要的东西，2026-08-20 起转角就是圆的，详见 [`panel-frame-art-prompts.md`](panel-frame-art-prompts.md)）、`sketchAccentBar`、`ui` 调色板（纸底/格线/红色引自 `theme.palette`）、`seedFor`（稳定 seed 防重渲染抖动）。新场景一律复用，不再各自手画背景/圆角按钮或硬编码调色板。**字体暂留 `monospace`**（手写字体需打包字体面，单列任务）。

### 7.6 页签主图标 AI 化（v0.7 试点 · 2026-08-14，状态：试点批 + 批次 2/3/4/5 全部出图并接线完成；共 43 个光栅图标 / 129 张 PNG）

页签条（HubTabs/CareerTabs/底部导航）上的图标此前全走 §〇 分工里"UI=程序绘制"这条路，反馈辨识度/完成度不够——起因一是线稿本身简单，二是同一图标被多处复用成不同含义（如 `trophy` 身兼战绩/成就/通行证/进阶 4 职）。**本次扩大 §〇 分工边界**：页签主图标比照角色立绘的理由（辨识度要求高、程序笔触画不出足够细节）改走 AI 图，复用点借机拆开一图一义；逐批出图，先出一个 3 图小批（`[Cards|Equipment|Skins]` 同伴组：卡背包/装备/皮肤）验证风格和小尺寸（真实设备 20-33px，见 prompt 文档）效果。管线沿用 §6.2 的"抠白底"套路，但换成"一张源图打包时吐 active(白)/inactive(灰) 两份"（B 组"打包时改色"的直接复用，不是运行时 tint——项目里没有运行时 tint AI 位图的先例）。

试点过程中卡背包/皮肤各反复了 3-4 版才定稿——卡背包先后踩了"读成扑克牌""读成工牌/证件""细节太密缩小糊成一团"三个坑，才收敛到"单张卡+挥剑小人粗剪影"；皮肤则是"文具/画笔"这条思路本身跟装备材料图标（也是文具）语义撞车，改走"戏剧面具"完全跳出文具语言才定案。详见 [`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（定稿 prompt + 反复记录 + 打包脚本 + 已完成的接线改动）。

**批次 2**（2026-08-14 判断+prompt，2026-08-15 出图+接线）铺开 `trophy`/`book`/`medal`/`cards`/`brush` 5 个复用槽位：能确认跟已出的 `rosterIcon`/`skinIcon` 是同一概念的直接复用接线（Career 图鉴、拍卖筛选卡牌/皮肤、首页"养成"入口），判断为不同概念的留一张不动（如拍卖"我的"tab 仍用通用 `cards`），真正需要新概念的 4 张（战绩入口=柱状图/成就"进阶"分类=箭头阶梯/Career"称号"=桂冠/成就"收藏"分类=拼图块）出图一次通过、contact-sheet 28px 验证全部过关，已接线。详见 `tab-icon-art-prompts.md` "批次 2"一节。

**批次 3**（2026-08-15 判断+出图+接线，全部完成）系统性梳理 `HubTabs`/`CareerTabs`/底部导航/成就墙分类条/拍卖筛选条后确认还有 12 个页签级图标仍是程序绘制。梳理中顺带发现批次 2 留了两处漏判：`trophy` 其实是 4 职不是 3 职（本节第一段一开始就写着"战绩/成就/通行证/进阶"4 职，但批次 2 的判断表只处理了 3 个，通行证 tab 一直没人管）；`book` 也漏了成就墙"pve"分类这第 3 个用法。这次一并了结：`armor`(拍卖装备筛选)/`book`(Career统计页签) 两处确认是深链同一目的地，直接复用 `equipIcon`/`statsTabIcon`，不必新出图；`trophy` 让"成就"用新出的 `achievementTabIcon`(奖杯) 正式转 AI，"通行证"另出 `battlepassTabIcon`(门票)；`book` 让"统计"复用 statsTabIcon，"pve 分类"另出 `pveTabIcon`(藏宝图)；其余 10 个单一含义、纯粹为了辨识度（商店/金币直充/扭蛋/充值/首页/社交/pvp分类/拍卖出价/拍卖材料）逐一出新图。出图第一轮 12 张里 3 张（充值宝箱木纹太密糊成一团、社交地球经纬线画成直线读成准星、材料铅笔屑锯齿边+放射线糊成一团）被 contact-sheet 打回重出，v2 收紧对应措辞后全部过关。已接线：`tsc --noEmit` + 全量 `vitest` 通过。详见 `tab-icon-art-prompts.md` "批次 3"一节。

**批次 4：奖励图标统一出处**（2026-08-15，用户报"周常宝箱这里的图标还是程序绘制的"）。批次 1-3 只梳理了**页签级**图标，明确把"奖励行里的图标"排除在外了——于是奖励行成了唯一还在画程序线稿的地方：日常签到日历、周常宝箱、通行证轨道、活动兑换、充值里程碑、邮件附件这 6 个屏幕，各自手写一张 `kind → IconKind` 表，`coins`/`material` 早就分别收敛到 `buildCoinIcon`/`buildMaterialIcon` 两个统一出口，但 `card`/`equipment`/`skin` 三种一直落在 `cards`/`armor`/`brush` 三个程序 glyph 上，明明 AI 图（`rosterIcon`/`equipIcon`/`skinIcon`）早就有了。视觉后果就是用户截图里那样：同一张卡片上，AI 画的铅笔芯位图和程序画的细线盾牌并排。**修法不是逐屏替换**（那正是漂移的根源），而是新增第四个统一出口 `client/src/render/rewardIcon.ts` 的 `buildRewardIcon(reward, size, color)`，内部按 kind 分派到既有的三个域出口 + 三张 AI 页签图，6 个屏幕全部改走它。**规则：任何新的"奖励图标"落点必须调 `buildRewardIcon`，不许再写 kind→IconKind 表。** 详见 `tab-icon-art-prompts.md` "批次 4"一节。 **追加（2026-08-16）**：AI 页签图原本只烘 active(白)/inactive(灰) 两种墨色，奖励行拿到的是页签非激活态那份刻意压暗的灰，放在纸面内容里比旁边全彩的材料/金币位图淡一档。加了第三种 `content` 墨（`C.dark` = `#2c2c2a`，同一行主文案的墨色），19 个图标各多出一张 PNG，共 57 张。**这一种永远不会被颜色判据自动选中**——content 和 inactive 都是纸底深墨，任何基于颜色的判据都分不开，只能由调用点显式声明 `{ variant: 'content' }`。

**批次 5：页面标题图标**（2026-08-17，用户圈图指出"所有页面类似位置都该有图标"）。前四批的范围一直是"页签条上的图标"，**页面标题从来没进过范围**——`drawSceneHeader` 只画文字，31 个标题态一个图标都没有；同类漏网的还有装备页的部位筛选条和背包/锻造二级导航。这次先把出口做出来再等图（批次 4 "没有出口"那条教训的直接应用）：`drawSceneHeader` 新增 `opts.icon`，把 `[图标][间距][标题]` 当一个组排版，并在两端设边界——不压返回按钮胶囊、不越右侧货币簇预留区，放不下就图标和文字一起等比缩小（沿用 `HubTabs` 给页签标签"缩到装得下"的做法）；`buildTitleIcon` 导出给三个自绘标题的场景（战役地图/家族/宗门）。**这两条边界都是实拍才暴露的**：只居中 → 图标画在"返回"字上；只钳左边 → 英文 `Hero Roster` 顶出右边界。同时把 `preloadTabIconTextures()` 挂进 `LobbyScene` 并把 `idlePrefetch` 的图标波次提到 battle 之前——所有二级场景都从大厅进入，而"设置/关卡准备/房间"这类只渲染一次的场景等不到第二次重绘，晚到的解码就是永久空白。14 处标题 + 6 格页签确认为纯复用已接线；24 张新图的判断表和 prompt 见 [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md)（单独文件，500 行文档约定）。

**批次 5 出图结果（2026-08-17 当日完成）**：24 张一次过关，**前四批各有 3 张在 contact-sheet 阶段被打回，这批零打回**——判断阶段就点名的三对高危撞车（领奖台 vs 柱状图、礼物盒 vs 拱盖宝箱、铁砧 vs 拍卖锤）在 prompt 里逐条写进 Avoid 后，28px 并排看全部拉得开。至此光栅图标 43 个 / PNG 129 张。接线覆盖 11 个 `drawSceneHeader` 标题（其中 DailyScene 按激活 tab 四选一、FriendsScene 按 tab 五选一）、2 个自绘标题（家族/宗门，走 `buildTitleIcon`）、社交 rail 5 格、日常 4 格、装备背包/锻造 + 部位筛选 4 格、头像预设 1 格。**接线时发现的一处结构陷阱**：装备页的「背包/锻造」在横屏走侧栏 `drawSidebarTabs`、竖屏走顶部 `drawHubTabs` 两条**各写一份 tab 数组**的分支，只改横屏那份的话竖屏静默保持无图标（实拍才看出来）；已收敛成 `EquipmentScene/types.ts` 的 `EQUIP_SUBTABS` 单一表，两条分支都读它。同类的"一个控件两处画"还有社交 rail（已是单表 `SOCIAL_TAB_ICON`，标题和页签共用）。

**批次 6：大厅首页主视觉**（2026-08-17，用户圈图指出首页那几个图标是不是图片）。前五批的范围全在**二级页面**（1–4 批是页签条，第 5 批是页面标题），于是全游戏被看得最多的那一屏一张 AI 图都没有：`开始匹配` 按钮水印、`战役`/`大世界` 两张 pillar 卡片、右上角段位 chip 四处仍是程序 `pencils`/`book`/`castle`/`trophy`——而**右上角金币早就是 AI 位图**，并排时程序图的单薄一眼可见。3 张新图（交叉铅笔+墨渍 / 摊开的线圈本 / 摊开的纸地图带虚线路线+小旗），段位 chip 判为纯复用 `leaderboardTabIcon`（点它就是进排行榜，且"奖杯类"造型已有奖杯/桂冠/圆牌三张，再加必撞）。**这批跟前五批有两点结构性不同**：①不是 28px 页签格子而是大尺寸主视觉（pillar motif = 卡片高的 60%），源图允许多一点线条细节；②这四处原本都是**运行时染色**（战役金/大世界蓝/hero accent/段位 `TIER_COLORS`），而光栅墨色是打包时烤死的——**结论是不给 pack 脚本加烤色**，改由调用点显式声明变体（近黑底的 hero 水印和段位 chip 强制 `active` 白墨，纸面 pillar 用 `content`，软锁的大世界卡用 `inactive`），颜色语言由卡片边框/左边缘墨条/chip 边框和文字继续承担，信息不丢。详见 [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)。

**批次 7：把矢量图标彻底清零**（2026-08-25 判断+prompt，同日出图+接线）。起点是用户把装备详情弹窗里「攻击/护甲/生命」三个词条图标当成缺失美术的占位符——核实后确认是「该出图但一直没出」：前六批的范围是导航类位置（页签条→页面标题→大厅首页），金币收口处理的是货币/奖励，剩下的 49 个矢量 kind 恰好全是批次 3 当年明确点名「不在这批范围」的那类。去重后 5 个判为复用现成图、44 个出新图，**`DRAW` 表清零、`icons/{motifs,equipment,slg,ui,titles,currency,primitives}.ts` 七个文件整体删除**，从此 `buildIcon` 背后没有任何程序画法。判断表和 prompt 见 [`tab-icon-art-prompts-batch7.md`](tab-icon-art-prompts-batch7.md)。

**批次 7 与批次 6 在「运行时染色」上给了相反的结论，这是有意的**。批次 6 遇到同一个问题（光栅墨色打包时烤死，四个调用点原本按状态传色）时选了「不给 pack 加烤色、由调用点声明变体」，因为那四处的颜色在卡片边框/墨条/chip 边框上都有冗余承载，丢掉图标那一份不丢信息。批次 7 这 44 个不一样：`medal` 的金/银/铜**就是**排行榜第几名、`star` 的颜色**就是**卡池稀有度、称号墙的金色**就是**「已装备」、`check` 的绿**就是**成功、HUD 墨水瓶的蓝**就是**「我方的墨」——颜色是唯一载体，映射成预烤灰会静默抹平。所以这批走第三条路：pack 脚本只烤一张白色母版（`inks: ['active']`），`buildInkIcon` 运行时 `sprite.tint = color`（白×tint 精确等于 tint），完全复刻矢量时代「`color` 按字面用」的契约。`render/titleArt.ts` 早就这么给四枚永久称号染色，不是新发明；pack 脚本头部那条「烤色不要运行时染色」说的是**成品全彩图**（金币位图），没有单一墨色可乘。代码上分成两张表两个入口：`TAB_ICON_RASTER`（46 个页签图，`color` 是明暗提示）与 `INK_ICON_ART`（49 个内容图，`color` 是字面墨色），`buildIcon` 先查前者、落到后者，两表不许有同名 kind（有测试盯）。

**批次 7 的实测发现（都在 28px contact sheet 上，不是猜的）**：①**沙漏三档（1h/8h/24h 加速）在 28px 上几乎分不开**——沙量差异靠的是点状沙粒，缩到 28px 全部糊掉，而且三张的外框（无立柱/细立柱/带旋钮粗立柱）还不一致，破了「同一只沙漏只是沙不同」的家族感。②`brush` 的笔锋在 28px 只剩一根竖棍，读成铅笔而不是毛笔。③`lead`（削尖的铅笔芯）画成了一个纯锥形，28px 上读成三角形，跟 `play` 的实心三角容易混。④`titleMaster` 与 `titleGrandmaster` 的差异只有一顶很小的皇冠，28px 上勉强。这四条已在 batch7 文档里标为**待重出**，其余 40 张验收通过；本轮先全部接线（矢量线稿比它们更糊），重出时只需换源图重跑 pack 脚本，代码不用动。

**批次 7 重出结果（2026-08-25 晚 ~ 08-26）**：沙漏三档／`lead`／`titleGrandmaster` 一版过关——沙漏那一条从「三档看起来一样」到「一眼分开」，改的只是"沙子用实心色块、别用点阵"这一句。`brush` 走到第三版才收口，而且**不是收在图上**：v2 的笔锋照要求做宽了，但整张图 27:128（1:4.74）——`pack_tab_icons.cjs` 裁到内容边界后归一化**长边**、运行时又 contain-fit 进**正方形**盒子，所以细长的图在 28px 格子里只占约 6px 宽，比 v1 更没存在感（**新图外轮廓长宽比尽量别超过 2:1**；实测全套 44 张里 brush 的 4.74 是唯一离群值，第二名 `weapon` 3.28 是竖立的剑、已上线可接受）。v3 把构图收成 108:128 解决了存在感，却读成钟形/蘑菇。**第四轮之前回头看了一层：这个图标该不该是画笔——不该。** 本节上面记着当年定 `skinIcon` 的原话就是"画笔跟装备材料图标（也是文具）语义撞车，改走戏剧面具才定案"，而 `brush` 至今是 6 处皮肤内容徽标，还跟面具同屏出现。于是 `brush` 改成 `skinIcon` 的第 6 个别名，零新资产、6 个调用点不改。**教训：返工到第三轮时要往上一层看**——v1→v3 每轮都在修「这支画笔画得对不对」，真正的问题是「这里不该是画笔」，而这个判断三个月前就做过，只是没落到这 6 个调用点上。**2026-08-26 拍板：皮肤图标永久定为面具，不再出画笔版本**（`_rejected/` 里的 v3 及其 v4 措辞只作归档，不再是待办）。

**批次 8：该有图标却从没进过表的那几个词条**（2026-08-27 判断+prompt，出图待办）。起点是用户圈收集册卡片上那行属性 `♡ 60　⚔ 12　射程 1`——生命只有图标、攻击只有图标、射程只有文字。批次 7 的范围是**已经在画的 49 个矢量 kind**，它天然回答不了「有没有哪个词条压根没进过那张表」，`range` 就是这种：从来没有过矢量画法，所以也没进过任何一批的清单。**这次分两半处理**：排版那一半不等图先修（每个词条一律写全名，图标退化成名字之上的冗余提示——没有美术的词条自然长成 `射程 1`，跟别的 chip 同构；见 [`LOBBY_IA_REDESIGN_LOG.md §28`](../game/LOBBY_IA_REDESIGN_LOG.md)），美术那一半按全库词条盘一遍：13 个词条里 5 个已有图标，`range`/`siege`/`crit`/`critmult` 四个出新图，`cost` 判为复用 `ink`（战斗里费用付的就是墨水），`power`/`troopCap` 所在的花名册那几行整行都还是纯文字、属于另一件事先不动，`lifesteal`/`regen`/`matdrop`/`stamina` 四个在 `AFFIX_FIELD_MAP` 里有但从来 roll 不出来、也没有 i18n，不出图。判断表和 prompt 见 [`tab-icon-art-prompts-batch8.md`](tab-icon-art-prompts-batch8.md)。**同日出图+接线完成**：v1 四张里 `range` 和 `critmult` 被打回——`range` 的量距线两端只有短竖线，内容外框 4.24:1，长边归一后进 28px 方格只剩 28×7（`brush` 4.74:1 那条教训的第二次现场，而且这次 `iconArtAspect.test.ts` 的 2.2 上限本来就会拦住它）；`critmult` 的 8 根等距、贴着外环的迸溅线缩小后连成一体，读成船舵。v2 三张一版过（`range` 改成贯穿全高的竖杆 → 0.96:1；`crit`/`critmult` 同一次请求出、箭头改成填满内圈的实心三角、迸溅线减到 5–6 根并与外环留空隙）。最终账 47 张自有美术 + 6 个别名 = 53 个 ink kind。**追加 8b（同日）**：属性行修完后，用户指出同一张卡上「士兵 / 费用 / 未解锁」三行还是纯文字——于是把这条判据反向用一次（同一块面板里有一行是「图标+名字」，其它行就不能只有名字）。盘完只需 2 张新图：`unit`（头盔）和 `spell`（卷轴）；`建筑` 复用 `castle`、`费用` 复用 `ink`（战斗里费用付的就是墨水）、`未解锁` 复用 `lock`。**`士兵` 三个复用候选全撞了**才决定出图：`rosterIcon`（卡框里的小人）跟本页页头的 `collectionTabIcon` 同一路造型、画在卡里会重影；`swords` 的既有语义是「对战/PVP」，再兼一图三义；`atk` 是同一面板下一行的匕首，并排两把刀。头盔 v1 出成了毛线帽（横箍带 = 罗口 + 封死的底边 + 把下半部切成两格的护鼻），v2 换侧面科林斯盔一版过——**正面视角的辨识全靠细缝，而细缝在 28px 上必然消失，侧面的眼窝是个大缺口**。副标题顺势把 `·` 分隔符去掉了（两个图标已经分隔两段）。全库合计 49 张自有美术 + 6 个别名。

**顺带一条通用判据**：图标是名字之上的冗余提示，不是名字的替身——一行里只要有任何一个词条没有图标，这行就得全部写名字。

**批次 9：世界地图弹窗图标槽剩下的 7 个空位**（2026-09-02 判断+prompt，出图待办）。`showModal` 长出图标槽（同日，见 [`SLG_LOG_2026-08.md`](../game/SLG_LOG_2026-08.md)）之后，24 个位点接上了现成美术，剩下两类填不了：三条结构状态行（瞭望塔/箭塔/阻挡）在墨色表里压根没有对应美术，当时**刻意保留了字符串里的 emoji 🗼🏹🚧**——删掉等于让这三行彻底失去标记，比留一个字体不受控的字形更糟；另外四处（坐标行借 `globe`、驻扎借 `unit`、停留借 `spd`、险地标题借 `siege`）是能用但语义借来的。判断表和 prompt 见 [`tab-icon-art-prompts-batch9.md`](tab-icon-art-prompts-batch9.md)。**这批有三条跟以往不同的地方**：①**不复用地图上那三张同名建筑图**（`icon_watchtower`/`icon_blocker`/`icon_arrowTower` 都已存在且语义一致）——它们是写实钢笔排线的另一套语言，而且 [`slg-building-art.md`](slg-building-art.md) §6 已经在它们各自真实的渲染高度（≈30px/≈17px）上量过，结论是「本来就是一团模糊的排线纹理」，当地景可以，当 26px 的信息标记不行；②**三个建造图标是一个集合而不是三张图**（同一个建造菜单里同屏），按沙漏三档的老规矩一次请求出三张；③`blocker` 这次明确要求**塞进正方形**而不是照地图那张的 2.91:1 画矮长条——`iconArtAspect.test.ts` 的 2.2 上限会直接拦，而正确解法是重出，不是往 `ELONGATED_ON_PURPOSE` 加豁免。「保护中」的盾**没有**进这批：`armor`/`armorHeavy` 那面正面圆盘在 26px 上读不出来是已经交过学费的结论，而"保护中"该画盾、画伞还是干脆用 `lock` 是一次独立的语义判断，不该顺手塞进一批以地块结构物为主题的出图里。

---

## 八、特效规范

特效最容易出戏，严格约束：

| 特效类型 | 实现方式 |
|---|---|
| 普通攻击命中 | 手绘星形爆炸符号（漫画感），1～2帧后淡出 |
| 陨石打击法术 | 红色马克笔粗线从上方划下，落点出现涂鸦爆炸圈 |
| 急速冲锋法术 | 单位身后手绘速度线（3～4条平行线），持续5秒 |
| 单位死亡 | 身体变成手绘"×"，0.3秒后淡出 |
| 建筑摧毁 | 图标碎成几个线段，像被用力划掉 |
| 基地受击 | 图标抖动，出现新的裂缝涂鸦线条 |

**禁止**：粒子爆炸、光效、烟雾等数字游戏常见特效——纸面世界里不存在。

---

## 九、商业化与养成美术（v0.3 新增）

> 数值口径见 `design/game/ECONOMY_BALANCE.md`；此处只定美术产出口径。

### 9.1 文具皮肤（付费 cosmetic）

基础角色 = 蓝/红钢笔线稿 + 铅笔阴影 + 克制马克笔点缀（"草稿兵"）。**彩色角色 = 付费皮肤**，皮肤轴 = **换整套文具/媒材**：荧光笔霓虹、金色中性笔、蜡笔、修正液惨白、水彩晕染……on-theme SKU。

> **v0.6 修正（2026-07-02）**：下方"近零成本 = theme 对象 swap"是 v0.3 假设"角色程序画线稿"时的口径，**v0.4 角色改 AI 全彩位图 `.tao` 后已失效**——全彩 sprite 无法程序 tint（`UnitView.ts` 明写 can't be body-tinted，阵营改用脚下色块 wash 区分）。故**皮肤一律走完整 `.tao`**，一款皮肤 = 一份新绑骨资产，非零成本。据此拍板**宁缺毋滥、砍数量**：上线只做 **6 款（每角色 1 款）**——涛三商店直卖 + Anna 三抽卡（epic×2 + legendary×1），其余等上线后补。目录见 `GACHA_DESIGN §9.5`，接线见 `UnitView.ts SKIN_ASSETS`。

- **两条铁律（不变）**：① 皮肤只动填充/媒材，**绝不动敌我蓝红笔色**（荧光皮肤再骚，你还是蓝队、敌人还是红队）；② 纯 cosmetic，**不碰任何数值、不给识别优势**，不 pay-to-win。

### 9.2 文具合成装备（玩法养成）

关卡产出文具材料（铅笔/橡皮/尺子/订书钉/回形针/胶带…），diegetic 合成 = **把装备"画"到角色身上**（沿 bone slot 程序叠加绘制，近零成本）。这是给 `ECONOMY_BALANCE §5.5` 既有「材料→9 级锻造」数值骨架穿的文具外壳。

- **稀有度映射媒材**：铅笔(普) → 钢笔(精) → 马克笔(稀) → 荧光笔/烫金(史诗)——与皮肤共用同一套文具稀有度视觉语言。
- **与皮肤分两个循环**：装备由玩法 grind 产出、**改 PvE 战力 + 视觉**；皮肤靠付费、**纯 cosmetic**。两者都说文具语言，但泾渭分明（详见经济文档）。

---

## 十、声音方向（参考）

声音不属美术，但视觉对音效有强烈暗示：整体偏**轻巧、卡通、非写实**；可用铅笔沙沙声、橡皮擦声、翻笔记本声作 UI 音效；禁止金属碰撞、爆炸轰鸣等写实战争音效。

---

## 十一、参考作品与风格对标

| 参考对象 | 借鉴方向 |
|---|---|
| West of Loathing | tone/幽默扛魅力、潦草即态度的成功范式 |
| Stick War 系列 | 火柴人动作表达力、简洁战场可读性 |
| Don't Starve | 手绘呼吸线/线条质感（工艺上限参考） |
| Doodle Army 系列 | 笔记本背景纹理用法 |
| Clash Royale | 手牌布局与信息层级（学结构，非风格） |

---

## 十二、美术范围（MVP阶段）

### 必须完成

- [x] `sketch.ts` 笔触原语（`SketchPen` 类）+ `theme.ts`（含 `factionInk`/`fx`）+ 程序 grain（`wearOverlay.ts`，§3.1 磨损 overlay：grain/折痕/暗角/透印，bake 缓存）
- [x] 棋盘背景改程序画 + 烘焙缓存（`BoardView.drawBoard` + `bake.ts`，替换拉伸 `map.png`）
- [~] 3种单位的可染色造型与动画：PvP 三兵种用 `.tao` 骨骼动画 + faction tint；无 `.tao` 的占位/PvE 怪走 `stickmanDraft.ts` 程序草稿（沿 11 骨骼，faction ink）
- [x] 2种建筑造型（兵营、箭塔，`BuildingView` 精灵）；基地改程序「2×2 手绘城堡」（`castle.ts`，§6.3）
- [x] 手牌UI（`HandView`：卡框 + 费用 + 选中/禁用 + 刷新进度条）
- [~] 核心特效（陨石/裂缝/受击红晕已程序化；攻击命中星形 / 急速速度线待补）
- [x] 金币/血条等核心HUD（程序画 + `PIXI.Text`，i18n 键化）

### MVP后扩展

- [x] UI 程序画 + 呼吸线（`boil.ts` `BoilingSprite`，大厅标题下划线 ~8fps boiling）
- [x] 角色「沿骨骼草稿」生成管线（§5.5，`stickmanDraft.ts` 沿 `.tao` 骨骼 FK 静息姿）
- [ ] 文具皮肤系统（theme 对象 swap）
- [ ] 文具合成装备的程序绘制叠加
- [ ] 笔记本封面主菜单 + 手绘翻页过场
- [ ] 多套"笔记本主题"换肤（不同纸张/笔迹）

---

## 十三、品牌标识（Logo / 图标）（v0.6 新增 · 2026-07-02 拍板，见 DECISIONS ADR-027）

### 13.1 概念

**盾徽 + 文具三笔**：一张奶油横格纸盾牌（软 U 形底、深藏青手绘描边），盾面上钢笔 / 铅笔 / 马克笔交叉成 X 徽记。呼应 §3「主用三支学生常备笔」与叙事「用文具运筹的战争」。

- **配色 = 蓝主导**：中央**钢笔蓝**（我方色，§3.2）最大最显眼，**铅笔琥珀**、**马克笔红**（敌方色）作陪衬——logo 本身即宣示「我蓝」的阵营身份。红只作点缀，不喧宾夺主。
- **盾底纸面**：泛黄米白 `#F5F0E8` + 浅蓝格线 + 红页边线（§3.1 基底色），把「笔记本」母题带进 mark。
- **不带字**：mark 内**绝不嵌文字**（AI 出字必糊，且镜像/多语言不稳）。字标 "Nivara"（对外名，见 `world.md` / 记忆 game-name）用真实字体单独排版，**待打包一款手写/圆头字体后落地**（与 §7.4 字体待办同批）。

### 13.2 大 / 小双版本（按尺寸分工）

细节手绘版在小尺寸会糊，故**两套 master、按尺寸切换**：

| 版本 | 文件 | 风格 | 适用尺寸 |
|---|---|---|---|
| **主视觉（master）** | `art/logo/logo.png`（2048² 透明） | 全细节手绘（纸纹/笔尖/排线/胶带） | **≥128px**：启动图、宣传、大图标 |
| **简版（simple）** | `art/logo/logo-simple.png`（1024² 透明） | 扁平实色、粗描边、无纹理无胶带 | **≤64px**：favicon 16/32/48、小图标 |

> 实测：master 降到 32px 三笔糊成一团只剩「盾+团块」；simple 在 32px 仍能读出「盾 + 蓝笔居中 + 红黄交叉」。故 favicon/小图标一律走 simple。

### 13.3 生成 / 加工流程（AI 图管线，同 §〇 分工）

1. **AI 出图**：prompt 见 ADR-027（盾徽 + 三笔交叉、蓝主导、明显纸纹、无字、无胶带——交叉不带遮挡才画得对连续性）。master 版胶带由用户 GIMP 后期补。
2. **GIMP 抠背景**：沿盾牌轮廓抠成透明底 PNG（master 2048² / simple 1024²）。
3. **降采样**：`System.Drawing`（HighQualityBicubic + 保留 alpha）批量出各尺寸 → `art/logo/derived/`。派生规则：`logo-{1024..128}`（master）、`logo-simple-{128..16}`（simple）。

### 13.4 资产落地位置

```
art/logo/
  logo.png              # master 2048² 透明（细节版，权威源）
  logo-simple.png       # simple 1024² 透明（扁平版，权威源）
  derived/              # 降采样派生库（master 各档 + simple 各档）
client/public/          # 出货图标（webpack CopyPlugin 拷到 dist 根）
  favicon-16/32/48.png  # ← simple 派生
  apple-touch-icon.png  # 180，← master
  icon-192/512.png      # ← master（PWA / 社交卡）
  site.webmanifest      # name/short_name = "Nivara"，theme #1b3a6b / bg #F5F0E8
```

- **Web / CrazyGames**：`public/{web,crazygames}/index.html` `<head>` 已加 `<link icon/apple-touch/manifest>` + `theme-color`；`webpack.config.js` CopyPlugin（`!isWechat` 分支）把图标 + manifest 拷到 dist 根。dev-server 同源生效。
- **微信小游戏**：图标**无代码接入点** → 须在**微信公众平台后台手动上传**，用 `art/logo/derived/logo-512.png`（master）。列入上线前 checklist。
- **`<title>` = `Nivara — Notebook Wars`**（2026-07-02 落地）：主名 Nivara + 副标题 Notebook Wars，四份入口 `client/public/{index,web/index,crazygames/index,wechat/index}.html` 同步；manifest name/short_name 已是 Nivara。局内标题已抽单一 i18n key `game.title`（zh/en/de 同值），`auth.title` 改插值 `{game}`——改名只改 `game.title` 一处（记忆 game-name）。
- **大厅头部品牌 lockup**（2026-07-06 落地）：`LobbyScene` 头部图标由简化扁平版换成 `art/logo/derived/logo-512.png`（详细笔触 crest），放大并左移（右对齐到标题左侧，`logoSize = tbH * 0.9`）；标题文案改为完整 lockup「Nivara - Notebook Wars」，走新 i18n key `lobby.brandTitle`（zh/en/de 同值，字面量），与 `game.title`（登录页短名）分开，避免登录标题跟着变长；标题左边缘与副标题 "Real-time Tower Defense" 左边缘对齐（均从副标题居中位置反推）。
- **lockup 居中修正**（2026-07-06 补丁）：上条的「从副标题居中位置反推标题左边缘」在标题比副标题宽得多时，会让 logo+标题整体视觉偏右（副标题居中在 `w/2`，但更宽的标题从副标题左边缘向右延展，重心不在 `w/2`）。改为把 logo+gap+标题当作一个整体 block 居中在 `w/2`，副标题改挂在标题自身的中点下方，不再挂在 `w/2`。

*下一步：输出第一版单位概念草图（普通兵，可染色组织）+ 一个 `sketch.ts` 笔触 demo，验证程序画质感是否达标。*
