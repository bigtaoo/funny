# 美术设计总纲

版本：v0.3
状态：草稿，待评审

> **v0.3 大改（2026-06-14）**：确立「程序绘制 + 烘焙缓存」为主渲染路线；阵营改为**敌红我蓝换色**（覆盖 v0.2 §3.2/§4.2 的「同色 + 头顶点」旧条款，理由见下）；新增呼吸线（boiling lines）规范、角色「沿骨骼草稿」管线、文具皮肤与文具合成装备的美术口径。叙事框架（叛逆少年 / 红笔假想敌 / PvP=知己）见 `world.md` 与项目记忆，经济口径见 `design/game/ECONOMY_BALANCE.md`。

> **v0.4 修正（2026-06-14）**：**角色不走程序绘制，改用 AI 图位图资产**（撤销 §5.5「沿骨骼草稿」北极星）。实测：程序笔触画好抽象 UI 没问题，但复刻一张已设计的角色（脸/身材/造型）达不到质感、人眼极敏感。故确立下方「〇、资产分工」分界。程序绘制路线本身**不变**，仅缩回到 UI/棋盘/特效。

---

## 〇、资产分工（程序绘制 vs AI 图）

经实测拍定的硬分界——两条管线同属「手绘笔记本」视觉语言（AI 图也出涂鸦风），混用不打架：

| | 程序绘制（SketchPen） | AI 图（位图资产） |
|---|---|---|
| **对象** | 棋盘 / 网格 / UI 框 / HUD / 纸纹磨损 / 特效 / 简单装饰 | 角色 / 兵种 / 有个性的建筑 / 卡牌图 / 插画式地图元素 |
| **为什么** | 抽象几何元素，程序画出来*就是*设计本身，无「匹配参考图」问题，无恐怖谷 | 人对脸/身材/造型极敏感，程序复刻特定插画达不到质感 |
| **状态** | 已落地（美术第一~三刀，`client/src/render/sketch.ts` 等） | 现有 `art/units/*`；流程见下 |

**AI 图角色流程**：AI 出图 → 用户在 GIMP 切件/润色（`.xcf` 分图层）→ animator 绑骨做动画（Skin 模式 + anchor 红点已支持）→ 导出 `.tao`。**不引入中间生成/模板工具**：切件靠 GIMP、绑骨靠 animator，链路已齐全。（曾试 `tools/sketch-gen` 用 SketchPen 程序生成角色分件，质感够不着 AI 图，已废弃删除。）

**对 §1「主要资源只有角色」的影响**：仍成立——程序绘制扛掉 UI/棋盘/特效，需要外部资产的只剩角色（+ 少量有个性的建筑/插画），资源量依旧极小。

---

## 一、核心视觉概念

### "一场发生在用过的笔记本上的战争"

本游戏的全部视觉语言围绕同一个核心隐喻展开：**这场战争是一个孩子在自己的笔记本里一笔一笔画出来的**。

这不是一张精心设计的战棋盘，也不是史诗级的奇幻战场——它是一个安静孩子在无数个下午的产物，画在方格纸上，用了几种学生常备的笔，中间涂改过几处，边角还有几个跑题的涂鸦。**这本笔记本被反复翻了一年**：有折角、有手蹭花的笔迹、有马克笔透到背面的印子、有划掉的早期草稿——这个孩子能画出如此复杂的世界，本就不是一天两天的事。

这个概念有四层含义：

**视觉上**：美术风格统一在"手绘笔记本"这一物理载体下，所有元素——地图、单位、UI、特效——都应该能让人相信"这是一个真实存在的人用笔画出来的"。

**情感上**：表层是课间的轻松、课堂上的叛逆、和朋友互传本子的分享欲；底层是一个不爱社交、喜欢独处的孩子的孤独感——他画出的红笔敌人，本质是他给自己造的假想敌（一个镜像里的自己）。**做「funny 外壳 + 安静的忧郁内核」，魅力靠 tone/personality 扛，线条工艺过得去即可**（West of Loathing 路线，非 Cuphead 路线）。

**机制上（diegetic 框架）**：整个游戏发生在这本笔记本上，所有界面都从这个隐喻长出来——便利贴/撕纸条/胶带贴纸做面板，涂鸦方框做按钮，页边批注做菜单，翻页/橡皮擦一抹做转场，铅笔逐笔勾出画面做加载。**「程序绘制」因此不是省钱的妥协，而是卖点本身：整个游戏是一本会动的涂鸦本。**

**差异化上**：当前手游市场充斥着精细3D和过度设计的卡通风，这套视觉在货架上具有天然的辨识度，是市场里的一股清流；且因风格由代码强制生成，一致性自动保证、资源量极小（主要资源只有角色），是小团队的结构性优势。

---

## 二、目标受众与文化定位

**核心受众：13～22岁，在校学生为主**

这个年龄段的用户正处于建立个人审美认同的阶段，对"属于自己这一代"的视觉风格有强烈共鸣。方格纸和涂鸦是他们每天接触的物理现实，用这个语言做游戏，能绕过"我为什么要玩这个"的心理门槛——他们会觉得"这就是我会做的事"。

**文化参照**：
- 课桌上涂鸦的少年感
- Stick War 系列的直白趣味性
- 涂鸦艺术（Doodle Art）的随性能量
- 学生笔记本里那些认真画出来的"无聊小人"

---

## 三、色彩系统

整套配色模拟**真实文具**的颜色，而非数字设计的色板。主用三支学生常备笔：**铅笔（黑，结构/阴影/排线）、钢笔、马克笔（克制点缀）**。

### 3.1 基底色（背景层）

| 用途 | 颜色描述 | 参考值 |
|---|---|---|
| 方格纸底色 | 泛黄的米白，非纯白 | `#F5F0E8` |
| 格线颜色 | 浅蓝灰，低对比度 | `#C8D8E8` 透明度40% |
| 纸张磨损 | **翻了一年的笔记本**：折痕、暗角、手蹭花、马克笔透印——独立静态 overlay 层，全场共用 | — |

### 3.2 阵营色（敌我换色）— v0.3 改

**阵营由笔色区分：我方 = 蓝色钢笔，敌方 = 红色钢笔。**

- 红色圆珠笔是学生第二常备笔（老师批改/改错）。红=敌人是全人类通识，乱战中**敌我可读性最强**；且 diegetic——红笔=老师批改=权威=规训，正是这个叛逆少年的对立面。
- **为何覆盖 v0.2「同色不换色」的旧顾虑**：v0.2 怕换色破坏"都是同一个人画的"统一感。但本作叙事确立「红军是玩家想象出来的假想敌（镜像里的自己）」——**整本笔记本就是同一个孩子画的，他只是用蓝笔画自己、红笔画假想敌**。"同一个人画的"不仅没破，反而更强，且为战役末尾「红军即自己」的镜像 twist 在视觉上从第一关就埋好线。

> **兵种不靠颜色区分**（颜色已被阵营占用），靠**造型/图标/剪影**区分（与 §4.1「细节上限 2 个」一致）。马克笔色块只作克制的功能点缀（武器、盾面等），不承担兵种识别。

**阵营落地的两条机制**（按资产类型分）：
- **可染色资产**（程序草稿 `stickmanDraft.ts` / 占位圆）：整体用 faction ink（蓝/红）填充身体——颜色即阵营。
- **全彩 AI 美术资产**（`.tao` 骨骼动画单位）：身体是有质感的全彩图，**不能整体染色**（会毁掉美术）。阵营靠**脚下的马克笔色斑**——在单位影子位置叠一片柔和的阵营色椭圆（蓝=我/红=敌，`UnitView.drawFactionMarker`），略大于影子、灰影子盖在彩色斑上，读成"阵营色地块"。位置由 `StickmanRuntime.getShadowGround()` 取影子的真实屏幕坐标/尺寸对齐（不再用猜的固定 Y）。**为什么不用沿轮廓描边**：试过常驻轮廓描边（细的、离身体一道纸缝的线），但它和角色本身的手绘墨线是同频高频线条，两条抖动细线并排走会产生摩尔纹般的视觉振动 → 眼花。色斑是**低频信号**，落在脚下不与身体线条重叠，敌我读取反而更快、更契合文具手绘风。
- **描边的正确用法（瞬时 / 事件驱动）**：沿轮廓描边本身很酷，问题只在"常驻 + 贴在已有密集线条的角色上"。去掉这两个前提就好用——现用于三处：①**受击轮廓爆闪**（`UnitView.playHitEffect` + `StickmanRuntime.setOutlineFlash`）：单位挨打瞬间沿轮廓爆一圈**热橙**描边（不是白——描边落在身体外的纸色缝隙里，白线在米黄纸上几乎看不见），4 帧淡出、峰值 alpha 0.7（近战双方互殴都在挨打都会闪，故调短调淡免吵）。轮廓纹理仍按每骨 alpha 二值膨胀两次相减生成纯白「细空心线」（加载期、缓存进 `TaoAsset`，0 包体不烘进 `.tao`；微信无 `getImageData` 时 try/catch 降级），但**默认 `outlineLayer.visible=false`、只在 flash 几帧亮起 + 染 `tint`**，`_applyPose` 也只在 flash 时同步轮廓变换 → 常驻摩尔纹问题不存在、闲置零开销。②**手牌选中高亮**（`HandView`）：选中卡用 `SketchPen` 画手绘阵营蓝涂鸦框。③**基地受击脉冲**（`BoardView.triggerBaseHitPulse`）：基地挨打沿轮廓爆一圈手绘红框、0.5s 扩张+淡出（持续挨打时上一次未放完不重启，避免卡成静止框）。**刻意不用实时描边 filter**（满屏每单位一个 filter 在低端机/微信跑不动）。

### 3.3 功能强调色

| 用途 | 颜色 | 对应文具 |
|---|---|---|
| 重要提示 / 警告 | 亮黄荧光 | 黄色荧光笔 |
| 选中 / 激活状态 | 橙色荧光 | 橙色荧光笔 |
| 不可用 / 禁用状态 | 灰色涂改液质感 | 修正液 |
| 法术 / 特效爆发 | 红色马克笔粗线 | 红色马克笔 |

> UI 的功能色不受「敌我蓝红」约束，可用更合适的色（强调/状态）。敌我蓝红只约束**战场上的阵营单位/建筑**。

### 3.4 禁止使用

- 渐变色（打破手绘感）——上色拥抱**平涂 + 交叉排线（hatching）阴影**，不做柔光
- 发光效果 / 描边辉光（与纸面质感矛盾）
- 超过5种主色同时出现在同一画面

---

## 四、单位美术规范

### 4.1 造型风格：管状结构

所有单位采用**空心管状四肢 + 圆形关节**的结构，而非纯细线火柴人。这套结构在游戏实际格子尺寸（约48px）下仍然可读，且天然贴合骨骼动画的绑定方式。

**肢体**：每个肢体段（大腿、小腿、上臂、前臂、躯干）为**空心圆柱管状**，用外层粗描边 + 内层白色填充描边叠加实现，末端圆角。粗细参考：
- 躯干：外描边22px，内填充12px
- 大腿/上臂：外18px，内10px
- 小腿/前臂：外14px，内7px

**关节**：每个骨骼连接点（肩、肘、腕、髋、膝、踝）绘制**白色填充小圆圈**（描边黑色），半径6～9px，叠加在肢体段上方，同时作为骨骼动画的绑定锚点参考位置。

**头部**：空心圆形（白色填充，黑色描边），略大于"写实"比例（约占身高1/4）。侧视图下用**单个实心圆点**表示眼睛，位置偏向面朝方向。

**细节上限**：每个单位的辨识特征不超过2个。普通兵——持剑；盾兵——大圆盾；弓箭兵——持弓。过多细节在小格子里无法被感知。

### 4.2 视角、镜像与可染色规则 — v0.3 改

**视角**：所有单位采用**侧视图（Side Profile）**。

**朝向约定**：
- 己方单位（屏幕下方）：**面朝右**，向上推进
- 敌方单位（屏幕上方）：**水平镜像**（`scaleX: -1`），面朝左，向下推进
- 双方同列相遇时天然形成**面对面对峙**，无需额外处理

**可染色（关键约束）**：阵营靠笔色（蓝/红）区分 → **角色线稿不能在 GIMP 里画死成蓝色**，必须按「可染色」组织：**中性线稿层 + 运行时染色（runtime tint）**，或双色分层。同一套角色资产，我方渲染成蓝、敌方渲染成红。否则每个角色要画两遍。这一条与「红军即自己」的镜像 twist 天然一致——双方本就是同一批角色染了不同笔色。

**动画资产**：只需制作一套骨骼动画（`.tao`）。敌方靠代码翻转 + 染色，无需额外资产。

**设计禁忌**：单位身上禁止出现文字、数字或强烈不对称的标志性元素，否则镜像后会出现反字/镜像标志。

### 4.3 动画规范

动画使用**骨骼动画**（本项目 `.tao` / animator 工具）。帧率保留手绘的跳跃感，不必追求丝滑流畅。

| 动画类型 | 说明 |
|---|---|
| 行走 | 手脚交替，夸张摆幅，身体有轻微上下起伏 |
| 攻击 | 短促有力，武器前冲，击中瞬间画面轻微震动 |
| 受击 | 身体短暂后仰/变形（挤压拉伸原则） |
| 死亡 | 向后倒地，淡出消失，最终替换为手绘"×"符号 |
| 出生/放置 | 从小到大弹出，带轻微过冲（overshoot）弹性 |

### 4.4 建筑美术

建筑为**简笔几何形态**，像学生随手画的房子、箭楼：兵营=方框加小旗（旗上画兵种图标）；箭塔=梯形塔身加三角顶加一支弓；城墙=矩形砖块斜线填充；炮塔=圆形炮管从方形炮台伸出。所有建筑线条略粗于单位线条，便于作为"地标"快速识别。

---

## 五、程序绘制与烘焙缓存管线（v0.3 新增 · 主渲染路线）

**核心方针：游戏尽可能多地用程序绘制**（PIXI Graphics），而非外部位图。手绘质感来自"线条的随性"，不是像素细节，程序画反而是优势。

### 5.1 现状根因（要改的）

`BoardView.drawBackground` 把一张 `map.png` **整图拉伸**填满棋盘，而格子是运行时按 `cellSize` 动态算的（还分竖屏/横屏转置）——固定构图的位图**永远对不上动态网格**，换分辨率/朝向就全错位。**结论：去掉拉伸位图，改程序画。**

### 5.2 公共笔触层

- **`sketch.ts`**：手绘笔触原语，实现为 `SketchPen` 类（绑定一个 `PIXI.Graphics` + 一个 seeded `Prng`），方法 `stroke / line / rect / circle / hatch`，带**确定性 `Prng` seed 抖动 + 收笔变细（taper）+ 双描边（ghost）**。棋盘和 UI 共用同一支笔，质感才统一。
- **`theme.ts`**：调色板 / 线宽 / 抖动幅度集中一处，改风格只动这里。**单一来源**还含 `factionInk`（敌我蓝红，战场单位/基地染色取此）+ `fx`（lane/building/meteor/upgrade/hp 等功能状态色，§3.3 不受蓝红约束）；BoardView 高亮、UnitView 阵营色/血条均引用，不再各自硬编码。
- **纯几何 wobble 不够"铅笔"**：需叠一张可平铺的颗粒（grain）纹理 + 笔触纹理才像石墨/油墨。这是少数"程序画也要资源"的地方，但全场只需一张。

### 5.3 烘焙缓存

静态部分程序画完用 `renderer.generateTexture()` 烘成 `Texture` → `Sprite`，运行期零开销、笔触静止（避免每帧重画的抖动闪烁与 CPU 开销）。

- **缓存 key = `(w, h, orientation, cellSize)`**：命中复用，跨场战斗同尺寸只画一次（模块级 `Map`）。
- **静态烘焙**：纸底、格线、棋盘边框、no-build ✕、磨损 overlay、装饰。
- **动态 live**：高亮层、基地裂缝、陨石预览、单位、基地脉冲——继续 live Graphics 叠加；因都从同一 `layout` 坐标生成，自动与烘焙底图对齐。
- **铁律：绝不烘焙会变的文字/数字**（i18n 切换、金币、HP）→ 永远 `PIXI.Text` 活在上层。可拉伸面板用 9-slice 贴图。
- 渲染缓存细节另见 `design/product/client-rendering-cache.md`。

### 5.4 呼吸线（boiling lines）

手绘动画的灵魂——线条像活的。但与"静止贴图"的缓存冲突，按元素分层：

| 元素 | 处理 |
|---|---|
| 棋盘/格子 | **静止**（信息载体要稳，呼吸会晕） |
| 角色 | 靠 `.tao` 骨骼动画动，本就活 |
| UI 强调元素（标题/选中框/hover） | 烘 **2–3 个不同 seed 变体，~8fps 循环**，内存几乎不增、charm 保住 |

### 5.5 角色「沿骨骼草稿」管线（北极星）

让程序的笔和角色的笔**完全同源**：程序沿 `.tao` 的 11 根骨骼画"火柴人 plus"草稿（每根骨头一道收笔变细的铅笔描边、关节点、潦草脑袋）——**草稿天生绑定骨骼、出生即可动**；用户在 GIMP 按 bone slot（每骨一张 PNG）把它充实成有肉的角色。一次到位：笔触同源 + 出生可动 + 只做"微调"不从零画。

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
| `label_boss` | 红马克笔 | `the word "BOSS" hand-lettered in messy block capitals, underlined twice` | 待定 |
| `label_start` | 蓝钢笔 | `the text "[START]" hand-lettered in casual block capitals with square brackets` | 待定 |
| `label_win` | 蓝钢笔 | `the word "WIN!" hand-lettered cheerfully, slightly bouncing letters` | 待定 |
| `label_arrow_here` | 红圆珠笔 | `a long curved hand-drawn arrow with the scribbled word "here"` | 待定 |

#### C 组 — UI 大背景装饰（菜单/大厅纸面后方，浅铅笔淡色，~128–256px）

| 资产名 | 笔色 | prompt 主体 | 状态 |
|---|---|---|---|
| `bg_stick_soldier` ★ | 浅铅笔 | `a simple doodle stick-figure soldier holding a tiny spear, childlike` | 待定 |
| `bg_stick_squad` | 浅铅笔 | `a small row of three doodle stick-figure soldiers marching in a line` | 待定 |
| `bg_castle` | 浅铅笔 | `a simple doodle castle with two towers and a flag, hand-drawn, childlike` | 待定 |
| `bg_crossed_swords` | 浅铅笔 | `two simple doodle swords crossed in an X` | 待定 |
| `bg_shield` | 浅铅笔 | `a simple doodle kite shield with a plain cross emblem` | 待定 |
| `bg_banner_flag` | 浅铅笔 | `a small doodle triangular pennant flag on a pole, fluttering` | 待定 |
| `bg_catapult` | 浅铅笔 | `a tiny simple doodle catapult / trebuchet, childlike sketch` | 待定 |
| `bg_paper_plane` ★ | 浅铅笔 | `a small doodle paper airplane, simple folded-paper triangle shape` | 待定 |
| `bg_compass` | 浅铅笔 | `a small doodle compass rose with N S E W marks, hand-drawn` | 待定 |
| `bg_crown` | 浅铅笔 | `a tiny simple doodle crown, three points with dots` | 待定 |
| `bg_ink_splat` ★ | 浅铅笔/蓝 | `a small ink blot splatter stain, irregular, like a leaked pen` | 待定 |
| `bg_scribble_cloud` | 浅铅笔 | `a loose scribbled scratch cloud / thinking-scribble mass` | 待定 |

#### 资产目录约定

```
art/decor/                 # 源图 + GIMP .xcf 切件
client/src/assets/decor/   # 最终透明 PNG
  battle/  decor_*.png label_*.png   (A+B 组)
  ui/      bg_*.png                  (C 组)
```

- PNG-32 RGBA，透明底，单色；A 组 ~48–64px / B 组 ~96px 宽 / C 组 ~128–256px
- 风格须与 `sketch.ts` 程序笔触同频，不要卡通描边

> **实现状态**：装饰层渲染（锚点系统 + snap + 烘焙缓存）**代码尚未落地**，目前仅出素材阶段。素材齐后再做程序侧。

### 6.3 基地视觉

双方基地为**2×2格**手绘城堡图标，简笔轮廓，内含 HP 血条（铅笔格子填充的血量格）。血量减少时城堡轮廓出现裂缝涂鸦（live 层，见 §5.3）。

---

## 七、UI规范

### 7.1 核心原则

> **装饰层可以"乱"，功能层必须清晰。** 涂鸦感只用于背景装饰、卡片边框、按钮纹理等非信息载体；手牌、金币、血条等核心信息需 0.5 秒内可读，不被涂鸦干扰。

所有 UI 从「笔记本」diegetic 框架长出（§一）：便签纸面板、涂鸦方框按钮、页边批注菜单、翻页/橡皮擦转场。UI 同样走程序绘制 + 烘焙缓存（§五），文字永远 `PIXI.Text`。

### 7.2 手牌设计

- 每张卡牌是**便签纸/小卡片**形态，带轻微卷角或撕边
- 卡面：单位/建筑/法术简笔图标（与游戏内一致）+ 费用数字（手写字体）
- 底部轻微扇形展开；无法出牌时覆盖"涂改液白"半透明遮罩、费用数字被划掉

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
- **全屏场景共享原语**：所有 canvas 绘制的全屏场景（login / room / shop / gacha / result / replay / intro / settings）统一从 `client/src/render/sketchUi.ts` 取手绘 UI 原语——`buildPaperBackground`（纸底 + 抖动格线 + 红装订线，bake 缓存）、`sketchPanel`（平涂 + `SketchPen.rect` 涂鸦边框，**替代 `drawRoundedRect`**，落实「按钮非完美圆角」）、`sketchAccentBar`、`ui` 调色板（纸底/格线/红色引自 `theme.palette`）、`seedFor`（稳定 seed 防重渲染抖动）。新场景一律复用，不再各自手画背景/圆角按钮或硬编码调色板。**字体暂留 `monospace`**（手写字体需打包字体面，单列任务）。

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

基础角色 = 蓝/红钢笔线稿 + 铅笔阴影 + 克制马克笔点缀（"草稿兵"）。**彩色角色 = 付费皮肤**，皮肤轴 = **换整套文具/媒材**：荧光笔霓虹、金色中性笔、蜡笔、修正液惨白、水彩晕染……无限 on-theme SKU。

- **近零成本**：因美术是程序/参数化的，**一个皮肤 = 一个 theme 对象（调色板 + 笔刷纹理 swap），不是一套新美术**。程序画 + 皮肤产生复利，纯手绘做不到。
- **两条铁律**：① 皮肤只动填充/媒材，**绝不动敌我蓝红笔色**（荧光皮肤再骚，你还是蓝队、敌人还是红队）；② 纯 cosmetic，**不碰任何数值、不给识别优势**，不 pay-to-win。

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

*下一步：输出第一版单位概念草图（普通兵，可染色组织）+ 一个 `sketch.ts` 笔触 demo，验证程序画质感是否达标。*
