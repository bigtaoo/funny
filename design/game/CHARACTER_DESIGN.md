# 角色卡设计（CHARACTER_DESIGN）

> 状态：设计中 · 权威：本文（角色卡**机制/流派/外观**基准）· 更新：2026-07-01
>
> ⚠️ 本文只定**机制与流派**与数值**锚点（占位）**。落地实现时，运行数值进 `server/engine/src/config.ts`（`@nw/engine`），并同步 [BALANCE.md](BALANCE.md) 快照——本文的数字只是设计意图，不是数值权威（见 [README §0 铁律1](../README.md)）。
>
> ⚠️ **养成/获取/兵力/受伤系统** 已迁移至 [`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)（2026-07-01）。本文只保留角色外观、机制定位、流派设计。
> 人物背景 / 性格真源：[product/characters.md](../product/characters.md)；叙事铁律：[product/world.md](../product/world.md) + ADR-008（涛=东方 / Anna=西方 / 两本笔记本相遇）。

---

## 0. 核心决策（已拍板 2026-06-21）

**6 张卡，3 个定位，每定位「东西双版本」。但东西两侧来历不同：**

- **涛的三人 = 现有三张通用兵直接转为具名**，数值**原样不动**：
  - 李川 ＝ 普通兵（Infantry）· 陈守 ＝ 盾兵（ShieldBearer）· 苏远 ＝ 弓箭兵（Archer）
  - 它们是**全套战斗数值的锚点/地基**，首版保持现行面板、不加特殊机制（见 §3.2）。
- **Anna 的三人 = 重新画 + 重新设计**：Max / Lena / Mara 各对应一个定位，**以涛对位的兵为数值参照**做差异化变体（同定位、不同"做这件事的方式"）。

**这样既不动现有平衡地基（涛三兵＝参考系），又让 Anna 三人成为有独立机制的新卡。** 美术上涛三人沿用现有资产、Anna 三人需新绘 + 绑骨。

**铁律：Anna 的每张卡必须有一句话能说清"我和涛那张同定位的到底差在哪"。说不清＝白做。**

---

## 1. 定位对照表

| 定位 | 涛 / 方家（东方）＝现有兵·锚点 | Anna / Hartmann（西方）＝新画新设计 |
|---|---|---|
| 剑士（普通兵） | **李川**（普通兵原样） | **Max**：单点强攻变体 |
| 盾卫（盾兵） | **陈守**（盾兵原样） | **Lena**：纪律减伤变体 |
| 弓手（弓箭兵） | **苏远**（弓箭兵原样） | **Mara**：标记增伤变体 |

> 兵营产兵、PvE、新手默认仍用涛侧（＝现有兵种），无需改动；Anna 三人作为额外可获取卡进入池子。**获取方式见 §5（已定）。**

---

## 2. 三对卡规格

> 字段：**流派一句话**（涛 vs Anna 必须互不雷同）· **数值偏向**（Anna 相对涛对位兵的锚点，占位）· **机制** · **演出**。
> 涛侧锚点（[BALANCE §5.1](BALANCE.md)，原样）：普通兵 HP60/攻12/0.8s/速1.4/射程1/出2/费4；盾兵 HP240/攻8/1.2s/速0.85/出1/费6；弓箭兵 HP35/攻22/1.4s/速1.1/射程2/出1/费5。

### 2.1 剑士对（普通兵）

| | 李川 · 东方（锚点·原样） | Max · 西方（新设计） |
|---|---|---|
| 流派一句话 | **人多势众的群冲**（两个轻甲冲脸） | **半拍快的单点强攻**（一个精兵啃硬目标） |
| 性格依据 | 闹/停不下来/把队伍推起来 | 冷静果决/出手早半拍/一个人赢 |
| 数值偏向（占位） | HP60 / 攻12 / 0.8s / 速1.4 / **出2** / 费4 | **出1**、HP≈130 / 攻≈26 / 1.0s / 速1.3、费4（高对比·一个精兵） |
| 机制 | 无（基础兵·锚点） | **强击**：对满血/高血目标首击附加处决伤害（额外固定伤害或破甲）——专啃肉 |
| 演出 | 水墨连段刀光（现有） | 纹章重剑、单次爆发斩 |

> 对照点（Q3 拍板·拉大对比度）：同费 4，李川＝**2 个脆快身位**（120 总血、铺场、单个易被秒）、Max＝**1 个强韧精兵**（130 血、单体高攻、强击啃肉、不怕群拆但怕被风筝）。群体铺场 vs 单点凿穿，两种打法泾渭分明。

### 2.2 盾卫对（盾兵）

| | 陈守 · 东方（锚点·原样） | Lena · 西方（新设计） |
|---|---|---|
| 流派一句话 | **大盾肉墙**（高血挡路、扛住正面） | **站定吃减伤的纪律墙**（抗多段消耗） |
| 性格依据 | 站到更小学员前面/"他只是站过去" | 铁纪律零失误/算好站位/确信 |
| 数值偏向（占位） | HP240 / 攻8 / 1.2s / 速0.85 / 出1 / 费6 | HP≈200 / 攻低 / **受击固定减伤 −X** / 速≈0.7、费6 |
| 机制 | 无（基础兵·锚点） | **纪律**：每次受击固定减伤 −X；**站定不动**时减伤进一步提高——对群体/多段攻击极肉，但裸血低于陈守 |
| 演出 | 水墨大盾横展（现有） | 纹章方盾扎地、纹丝不动 |

> 对照点：陈守＝裸血更高、怕固定减伤被高攻一口吃；Lena＝裸血略低但每下都减、专克"多而小"的攻击与箭雨。

### 2.3 弓手对（弓箭兵）

| | 苏远 · 东方（锚点·原样） | Mara · 西方（新设计） |
|---|---|---|
| 流派一句话 | **高伤单发点射**（自己打脆皮） | **标记敌人的团队增伤**（让全队打得更疼） |
| 性格依据 | 读战局最快/箭在别人意识到前就飞出 | 看见整体/判断核心/同时看所有人 |
| 数值偏向（占位） | HP35 / 攻22 / 1.4s / 速1.1 / 射程2 / 出1 / 费5 | HP≈35 / 攻≈16 / 1.4s / 速1.1 / **射程≈2.5** / 出1、费5 |
| 机制 | 无（基础兵·锚点） | **标记**：命中给目标挂"标记"，被标记者受到的**全部伤害 +X%**——自身输出中等，价值在团队集火 |
| 演出 | 水墨快连射（现有） | 纹章瞄准线、标记符印浮现 |

> 对照点：苏远＝自身高单发、孤狼点杀；Mara＝自身偏低但放大全队火力、是团队核心而非独狼。

---

## 3. 平衡与镜像原则

1. **涛三兵＝参考系，首版数值不动**（避免动全套地基）。Anna 三人所有数字以对位的涛兵为基准做增减。
2. **同定位、同费用起步**（剑士 4 / 盾卫 6 / 弓手 5），先费用对齐再按实测拉开。
3. **一对之内总战力预算大致相等**：差在分布与机制，不是一边明显更强。
4. **涛侧首版无机制**（纯锚点）；若日后给涛三人也加 signature 机制，作为二期、单独记 ADR，不在 v1 动地基。
5. **机制要"可一句话验收"**：写不出 Anna 那张与涛那张的区别，就回炉。
6. **同定位可超过 2 张（Q5 拍板）**：未来允许同定位第 3 张（第三家族 / 神话层 / 联动）。约束：**新卡必须与已有两张都拉开足够差异空间**（同样"一句话验收"），不得是第三个微调变体。
7. **东西羁绊＝未来大系统，本期只记录不做（Q4 拍板）**：构想为"同场同时存在一对东西版本（如李川+Max）时触发微弱羁绊加成"，叙事＝两本笔记本相遇。涉及全局 buff 框架/UI/平衡，体量大，列入 backlog，成熟时另起设计文档并记 ADR。**本期不留实现接口，避免半成品。**
8. 数值最终以 `config.ts` 为准；本文锚点仅供首版填值起点。

---

## 4. 落地路径

1. 本文 + 你确认 §5 待定项 → 定稿 Anna 三人机制与首版数值。
2. `server/engine/src/config.ts`：涛三人＝给现有 `UNIT_*` / 卡定义挂具名/皮肤标识（数值不动）；新增 Anna 三个单位 + 三张卡定义，机制走单位特性字段（参考 PvE 既有特性范式：`aura_heal`、狂战 `HP<40%攻速×1.5`，[BALANCE §5.2](BALANCE.md)）。
3. 同步 [BALANCE.md](BALANCE.md) 快照（注明日期）；获取/皮肤若动经济，记 ECONOMY 文档。
4. 客户端：Anna 三角色新绘 + 绑骨动画（animator）；卡面 + 标记/减伤/处决的战斗内表现。
5. 记 [ADR](../DECISIONS.md)：①通用兵转具名归入涛阵营 ②引入 Anna 变体卡 —— 属会造成漂移的拍板。
6. 本文加入 [README §1.2 文档地图](../README.md)。

---

## 5. 获取方式（已拍板 2026-06-21）

六张卡按**模式**区分获取，避免 PvP 因卡牌收集进度造成 P2W：

| 模式 | 六张卡如何获得 |
|---|---|
| **PvP** | **六张全部直接送**（开局即全解锁，竞技公平、无收集墙） |
| **PvE / SLG** | 随战役进度发放——**通关对应章节各送一张**（Anna 三人对应战役偶数章 Ch2/Ch4/Ch6 出场顺序，章节→角色映射待定，见下） |
| **抽卡 / 活动** | 可获得**更多**（重复获取 → 转养成材料 / 碎片 / 皮肤；具体口径并入经济线，见 [ECONOMY_NUMBERS](ECONOMY_NUMBERS.md) / [EVENTS_DESIGN](EVENTS_DESIGN.md)） |

> 设计意图：**竞技场拼操作不拼卡池**（PvP 全送）；**养成线/收集欲**靠 PvE 进度解锁 + 抽卡活动加深（重复获取喂养成，不卡 PvP 公平）。

### 5.1 章节→角色映射（已定 2026-06-21）

Anna 三人随偶数章出场（[characters.md](../product/characters.md)：Ch2/Ch4/Ch6 从 Hartmann 视角），**通关该章即送对应角色**；涛三人对称地随奇数章（方家视角）发放，按**兵种位配对**（Ch1↔Ch2 剑士、Ch3↔Ch4 盾卫、Ch5↔Ch6 弓手）：

| 章节 | 视角出场 | 通关送 | 兵种位 |
|---|---|---|---|
| Ch1 | 方家 | **李川** `lichuang` | 剑士/普通兵 |
| Ch2 | Hartmann | **Max** `max` | 剑士（Max 变体） |
| Ch3 | 方家 | **陈守** `chenshou` | 盾卫/盾兵 |
| Ch4 | Hartmann | **Lena** `lena` | 盾卫（Lena 变体） |
| Ch5 | 方家 | **苏远** `suyuan` | 弓手/弓箭兵 |
| Ch6 | Hartmann | **Mara** `mara` | 弓手（Mara 变体） |

> 落地写进 PvE 奖励真源 `server/shared/pveRewards.ts`（[PVE_INTEGRITY_PLAN](PVE_INTEGRITY_PLAN.md)）：映射 `CHAPTER_ANCHOR_CARD`，首通某章送**对应锚点角色 2 级卡 × 1**（`CHARACTER_CARDS_DESIGN §4`，CC-11 已实装 2026-07-07）+ SLG 对应里程碑。奇数章→涛侧锚点的配对（Ch1/Ch3/Ch5 → 李川/陈守/苏远）在本任务定稿，与偶数章 Anna 变体的兵种位一一对应。

---

## 6. 全部拍板留痕

- **Q1（牌池关系）**：涛三人＝现有三兵转具名（数值不动·锚点）；Anna 三人＝新画新设计变体。✅
- **Q2（获取）**：PvP 六张直送；PvE/SLG 通关对应章节各送一张；抽卡/活动获更多。✅（见 §5）
- **Q3（Max 形态）**：出 1 强单体，拉大与李川的对比度。✅（见 §2.1）
- **Q4（羁绊）**：大系统，本期只记录、不做、不留接口。✅（见 §3.7）
- **Q5（同定位张数）**：允许超过 2 张，新卡须与已有两张都拉足差异。✅（见 §3.6）
- **Q6（涛侧机制）**：涛三人首版零机制，纯保平衡地基。✅（见 §3.4）

---

## 7. 六个 PvE 复用兵种的阵营归属（讨论中，2026-07-02）

> 状态：**方向已谈定，未定稿**——阵营归属+叙事定位已拍板，具体英雄名/背景故事/视觉 prompt 待下一会话（涛侧三个）+ 后续会话（Anna 侧三个）展开。本节只记录已谈定的框架，不是最终设计。

### 7.1 背景

`PVP_LOADOUT_DESIGN.md` 复用的 6 个 PvE 单位（跑兵 Runner / 铁甲兵 Ironclad / 狂战士 Berserker / 裂变兵 Splitter / 鬼鸟 Harpy / 医疗兵 Medic）目前是**中立可复用兵**：PvP 双方都能选，PvE 里是敌方波次（首入章节：Ironclad/Runner→ch1，Harpy/Berserker→ch3，Splitter/Medic→ch4，见 `CAMPAIGN_DESIGN.md`）。这层"哪一关先出场当敌人"是**已上线的波次配置，不受本节讨论影响**。

本节讨论的是**另一层、全新的东西**：给这 6 个兵种补上跟 Max/Lena/Mara 同等级的"这是谁的笔记本画出来的角色"归属——类似 Max/Lena/Mara 是 Anna 给李川/陈守/苏远三个涛侧锚点画的西方变体，这次反过来，要给这 6 个中立兵种也分出"涛画的 / Anna 画的"归属，让两边的角色阵容更丰满、更对称。

**关键澄清**：叙事归属（这个兵形象上是谁画的）与 PvE 敌方波次配置（这个兵在哪一关当敌人）是两层不同的东西，互不冲突。例如鬼鸟即使被涛在 Ch3 遇到当敌人打，它仍然可以是"Anna 笔记本画出来的怪"——反而印证了 Ch3/Ch4「两家相遇」的设定（涛在跟 Hartmann 家族交手时，撞见了对方笔记本里的怪物）。**不需要为了对齐叙事去改波次代码。**

### 7.2 归属拍板

| 单位 | 归属 | 理由 |
|---|---|---|
| 铁甲兵 Ironclad | **涛** | 已锚定"穷奇"（山海经异兽），中国神话血统已确立 |
| 跑兵 Runner | **涛** | 已锚定"獬豸"（山海经异兽），同上 |
| 医疗兵 Medic | **涛** | 无神话包袱，作为涛侧"随军医官"最自然，也给涛补上目前六人里缺的支援位 |
| 鬼鸟 Harpy | **Anna** | 词源即希腊神话哈耳庇厄（鹰翼女妖），西方血统最纯 |
| 狂战士 Berserker | **Anna** | "berserker" 本身是北欧神话词（披熊皮狂暴而战的战士），对上 Anna 世界观"北欧神话的坚韧"，机制（残血攻速×1.5）正对应狂战士传说 |
| 裂变兵 Splitter | **Anna** | 死亡分裂机制＝九头蛇 Hydra 神话原型（砍一头长两头），比机制本身更贴题；同时给 Anna 阵营补一个"怪物"位，跟 Max/Lena/Mara 三个人形骑士形成互补 |

**设计意图**：两边各 3 个，各自有神话/词源支撑（涛＝中国异兽体系，Anna＝希腊+北欧怪物体系），且都不动 Max/Lena/Mara/李川/陈守/苏远现有六人的设定。

### 7.3 战役章节结构（已拍板，供本节归属对照）

`CAMPAIGN_STORY.md` 六章分三段（非本节新增，此处仅记录讨论中复述的口径，供后续设计对齐）：

- **Ch1/Ch2**：涛 / Anna 各自内部试炼（各自为战）
- **Ch3/Ch4**：两家相遇（家族间比试）
- **Ch5/Ch6**：宗门大比 + 结局，剧情为方家 vs Hartmann 的**决赛对抗**（非并肩作战）；关卡玩法内容已完成、可玩，文案完整（见 `CAMPAIGN_STORY.md` §Ch5/Ch6、`world.md` 标「✅ 文案完整」）。因缺美术资源，暂**锁定不开放**。（订正 2026-07-07：原写「留白/锁定不做/并肩作战」与实际不符，玩法+文案均已完成，仅缺美术）

现有 12 个角色（6 锚点 + Max/Lena/Mara + 本节 6 个复用兵）足够支撑 Ch1–Ch6 全部内容需求。Ch5/Ch6 玩法与文案已完成，仅因缺美术资源暂锁定不开放。

### 7.4 视觉风格分工（承接 `art-direction.md` §4.1）

- **涛侧 3 个**（铁甲兵/跑兵/医疗兵）：走涛阵营既有的单色文具火柴人 plus 风格（空心管状四肢+圆形关节+大圆头单点眼，侧视朝右，≤2 识别特征/单位），跟 infantry/archer/shieldbearer 同源。**媒材按角色分**（呼应 §3「主用三支学生常备笔」+ 最初三个锚点角色各有不同笔触的先例，不是每个角色都默认铅笔）：穷奇＝铅笔厚涂交叉排线（已定稿）；獬豸/卫安＝**黑墨水钢笔**（2026-07-29 由铅笔改定，见 §7.6 修订记录——干净利落的钢笔线稿比铅笔更硬朗清爽，也避免整批复用兵全走同一种媒材显单调）。**蓝/红钢笔墨水保留给阵营专属语义**（`art-direction.md §3.2`：我方蓝钢笔/敌方红钢笔），中立复用兵（PvE 可作敌方出现）一律不用蓝/红墨水，避免固定烤色跟脚下的阵营色斑打架。**识别特征额外上色**（2026-07-29 二次修订）：黑墨水钢笔缩到实战渲染尺寸（M 档 ~54px）后仍偏难辨认——色相对比比线条粗细更扛缩小，所以在既有"马克笔色块只做克制的功能点缀（武器/盾面等）"规则（§3.2）上，把这条用法扩展到獬豸/卫安各自≤2 识别特征本身：獬豸的独角+尾巴＝**青色马克笔**，卫安的药箱+布条＝**绿色马克笔**，身体其余部分仍是纯黑线稿。两色均避开蓝/红（阵营）、黄/橙（警告/选中）、灰（禁用）、紫（装备 epic 稀有度，`EQUIPMENT_DESIGN.md`）。
- **Anna 侧 3 个**（鬼鸟/狂战士/裂变兵）：走 Anna 阵营既有的铅笔线+水彩淡彩写实风格（`ANNA_CHARACTERS.md` 模板），冷蓝色系；裂变兵作为怪物形态需要新想一套非人形骨架的呈现方式（不套 Max/Lena/Mara 的少年骨架模板）。

### 7.5 待办

- [x] 涛侧三个（铁甲兵/跑兵/医疗兵）具名+背景故事+视觉方案+出图 prompt——见 §7.6（本会话完成）
- [x] Anna 侧三个（鬼鸟/狂战士/裂变兵）具名+背景故事+视觉方案+出图 prompt——**已定稿**（2026-07-02，详见 [`ANNA_CHARACTERS.md`](ANNA_CHARACTERS.md#anna-阵营的三只怪物aello--björn--lerna)：鬼鸟＝**Aello**、狂战士＝**Björn**、裂变兵＝**Lerna**）
- [ ] 是否需要给这 6 个兵也定"跟 Max/Lena/Mara 的关系/羁绊"（例如裂变兵是否有"被驯服的怪物，谁收编的它"这层身份）——留待讨论（穷奇/獬豸/卫安/Aello/Björn/Lerna 六个暂时都不定）
- [ ] 是否要落 ADR（本节拍板的阵营归属属于会造成漂移的决定）——**等用户过目两侧设计后一并记**
- [x] **跑兵/医疗兵墨线过淡，实战几乎看不清**（2026-07-29 用户截图反馈，同日已解决）：对比 `client/src/assets/units/{medic,runner,infantry,ironclad}.tao` 的 spritesheet 发现，步兵/穷奇的骨骼部件有交叉排线打阴影，视觉重量够；跑兵（獬豸）/医疗兵（卫安）只有极细空心轮廓、几乎纯白，糊进米黄方格纸背景（`art-direction.md §3.1` `#F5F0E8`）里辨识度很差。**最终方案**（迭代到 v5/v7 才定稿，见 §7.6）：黑墨水钢笔线稿（不是铅笔排线，避免跟穷奇撞媒材）+ 识别特征实心马克笔上色（獬豸角/尾巴青色、卫安药箱/十字/布条绿色）+ 全身淡色荧光笔浅扫（把实心色块跟身体统一，不再像贴纸）。中途还顺带修了两个连带问题：獬豸 prompt 里混进的"耳朵"描述（模板残留，从没设计过耳朵）、卫安"双手举在身前"被误画成交握心虚的姿态（改成双手分开伸向病人）。GIMP 抠件 → animator 绑骨为下一步，不在本次会话范围内。

### 7.6 涛阵营三个新英雄（具名+背景+视觉，2026-07-02 定稿）

> 状态：**方向定稿，等待用户过目**。数值锚点全部原样引用 `PVP_LOADOUT_DESIGN.md` §5/§5.1（不改任何数字，本节只补叙事+视觉皮）。身高档位依据 `art-direction.md` §4.5.2。
>
> **与李川/陈守/苏远的关系设定**：穷奇/獬豸是异兽，不是方家试炼学员，不必比照"三人组"的同龄同框叙事；卫安是成年随军医官，同样不在试炼年龄段内。三者暂**不**定与 Max/Lena/Mara 的羁绊（见 §7.5 待办），先各自立住。

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

#### 卫安（医疗兵 Medic）

**神话原型**：无——刻意"无神话包袱"，作为方家侧唯一纯人类支援位，补足六人里此前缺的"随军医官"定位。

**定位**：M 普通 · 支援光环（hp90，PvP override attack4/interval1.2/range1，光环 hps8 半径2，siege4，费用6，见 §5/§5.1）。

**出身**：卫安家里三代都是随方家军队走的郎中，不是嫡系，也从没想过要往嫡系里挤。家训只有一句——"先看伤兵，再论输赢"。他没上过阵厮杀，但比谁都常听见濒死的人说的最后一句话；他自己说，正因为没打过仗，才更知道打仗是什么代价。

**性格**：话不多，但耐心；谁喊疼他先蹲下看伤口，看完了才回答别的问题。他对谁都一视同仁，不因为谁是嫡系就多看一眼，不因为谁是外围就少弯一次腰。他心里清楚自己打不过场上任何一个人，但也清楚——正因为有他在，别人才敢往前冲得更狠一点。

**关系**：暂不定（见 §7.6 前言）。留一个可能性：李川、陈守、苏远训练受伤，最后往往都是被拖去找卫安——三人私下都认他半个长辈半个自己人，他从不多问训练场上谁输谁赢，只问"伤在哪"。

**他现在还没想清楚的事**：他知道自己的价值是"让别人敢往前冲"，但偶尔会想，如果有一天没有人需要被治了，那自己算什么——这个问题他没敢深想。

**视觉方案**：
- **风格**：与李川/陈守/苏远同源——单色圆珠笔火柴人 plus 语言（空心管状肢体+圆形关节+大圆头单点眼），**人形**，成年体态（比三个孩子明显更宽更沉稳，但不到穷奇/獬豸那种异兽夸张度）。
- **体型**：M 普通档。
- **识别特征（≤2）**：① 背一个方形药箱（侧背带斜跨）；② 额头/手臂缠一道布条（战地包扎布，是他的"武器"——银针或绷带，非常规兵刃）。
- **姿态**：默认待机姿略含胸低头，像随时准备蹲下处理伤员，与三个少年昂首挺立的姿态形成对比。
- **朝向/染色**：同规范，侧视朝右，中性线稿+运行时 faction tint。

**出图 prompt**：
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick careless sketch. A hollow tube-limbed stick figure
character built from rounded pipe-like limb segments with circle joints at
each connection, a large round head with a single dot eye positioned
toward the facing direction, same construction language as a basic
soldier stick figure but adult proportions, sturdier and more settled than
a teenager, slightly hunched posture as if always ready to kneel down and
tend to someone. A square medicine satchel is slung across one shoulder
on a diagonal strap. A strip of bandage cloth is wrapped around his
forehead. No weapon, empty hands held forward as if about to bandage
something. Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (line art only, to be tinted
programmatically). Style of West of Loathing / doodle art.
```
负向：`color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions`

> **⚠️ 2026-07-29 用户截图反馈**：实机里几乎纯白、糊进纸色背景看不清——v1 prompt 同样没要求排线阴影，只有细描边。**需要重新出图**，见下方 v2 修订版（补齐排线，其余不变）。

**出图 prompt v2**（2026-07-29 修订，仅补齐排线阴影密度，姿态/构造/风格描述不变）：
```
Hand-drawn doodle in a worn school notebook, single dark-ink pen line art,
slightly wobbly imperfect strokes like a teenager sketching in the margins
during class, quick careless sketch. A hollow tube-limbed stick figure
character built from rounded pipe-like limb segments with circle joints at
each connection, a large round head with a single dot eye positioned
toward the facing direction, same construction language as a basic
soldier stick figure but adult proportions, sturdier and more settled than
a teenager, slightly hunched posture as if always ready to kneel down and
tend to someone. A square medicine satchel is slung across one shoulder
on a diagonal strap. A strip of bandage cloth is wrapped around his
forehead. No weapon, empty hands held forward as if about to bandage
something.

Dense cross-hatching pencil shading covers the torso, sleeves and legs of
his coat, giving the clothing a richly inked, textured look with the same
heavy ink density as the game's other stick-figure units — NOT a thin bare
outline, NOT a sparsely-lined empty silhouette.

Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (line art only, to be tinted
programmatically). Style of West of Loathing / doodle art.
```
负向：`color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v2 已出图确认可读，**但用户反馈媒材跟穷奇撞了**（六个复用兵不该全是铅笔厚涂，§7.4 已改为按角色分媒材）。**改用黑墨水钢笔重新出图**，见下方 v3（换媒材，姿态/构造不变；避开蓝/红钢笔墨水，两色是阵营专属语义 `art-direction.md §3.2`）。

**出图 prompt v3**（2026-07-29 修订，铅笔厚涂 → 黑墨水钢笔，姿态/构造/识别特征不变）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. A square medicine satchel is slung across
one shoulder on a diagonal strap. A strip of bandage cloth is wrapped
around his forehead. No weapon, empty hands held forward as if about to
bandage something.

Shading is built from solid black ink fills and a few bold parallel pen
strokes in the deepest shadow pockets (under the satchel, inner elbow,
folds of the coat) — NOT pencil cross-hatching, NOT a grainy graphite
texture. The outline itself is thick and saturated enough to read clearly
on its own, so shading stays sparse and confident rather than dense.
Overall ink density should feel closer to a fountain-pen sketch than a
pencil study — NOT a thin bare outline, NOT a sparsely-lined empty
silhouette either.

Side profile view, facing right. Isolated single character,
centered, on a plain pure-white background, no grid lines, no other
elements. Flat 2D, no 3D, no gradients, no glossy highlights, no thick
cartoon outline, no color fill (monochrome black ink line art only, to be
tinted programmatically — the ink itself must be neutral black, NOT blue,
NOT red). Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, colored ink, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v3 黑墨水钢笔已出图确认，**但用户反馈缩小到实战尺寸（M 档 ~54px，`unitSize.ts`）后纯黑线稿还是容易糊进纸色背景**——跟獬豸同一个问题（色相对比比线条粗细更扛缩小）。**改为给识别特征上色**：卫安的药箱+十字标志、额头布条改用**绿色马克笔**上色（医疗主题色，跟"马克笔色块只做克制的功能点缀"的既有规则同源扩展，`art-direction.md §3.2`）；绿色避开蓝(我方)/红(敌方)/黄(警告)/橙(选中)/灰(禁用)/紫(装备 epic 稀有度)。见下方 v4（其余构造/姿态/黑墨水钢笔线稿不变，只加这两处色块）。

**出图 prompt v4**（2026-07-29 修订，药箱+十字+布条改绿色马克笔上色，其余同 v3）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. No weapon, empty hands held forward as if
about to bandage something.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone,
flat with no gradient. A strip of bandage cloth is wrapped around his
forehead, ALSO colored solid green, the same shade as the satchel — the
rest of the body stays plain black-ink line art, only the satchel and the
forehead bandage carry color, everything else uncolored.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients, no glossy highlights, no thick cartoon outline. Only
the satchel and forehead bandage carry flat green marker color — every
other part of the body is monochrome black ink line art, to be tinted
programmatically (that untinted part must be neutral black, NOT blue, NOT
red). Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, colored body, full color fill, gradient on color fill, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v4 已出图，同獬豸一样反馈"色块边缘太干净像贴纸"——**改为在全身也扫一层淡绿色荧光笔浅色，实心块只留给药箱+十字+布条**，思路与獬豸 v5 一致（见上，同一原因：色相对比比线条粗细更扛缩小，但孤立的两块纯色实心块本身跟手绘线稿材质不符）。医生没有耳朵这类误带的问题，v5 只改上色部分。

**出图 prompt v5**（2026-07-29 修订，全身加淡绿色荧光笔浅扫，药箱/十字/布条维持实心）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager, slightly hunched posture as if always ready to
kneel down and tend to someone. No weapon, empty hands held forward as if
about to bandage something.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v5 上色效果确认可用，**但用户指出一个更根本的问题**：`medic.png` 这张图不只是 animator 绑骨参考图，`cardArt.ts` 里它**直接就是玩家在手牌/图鉴看到的卡面**——跟步兵/穷奇/獬豸这些卡面比，v5 出的是弓步前倾、单脚跨步的动态姿势，而其余卡面都是双脚平稳站定的中性站姿，摆在同一个手牌栏里会显得不统一。**v6 只改姿态**：双脚改回均匀站立（不跨步），保留上身含胸低头这个性格细节，上色部分不变。

**出图 prompt v6**（2026-07-29 修订，弓步跨步 → 双脚均匀站立，仅上身含胸低头，其余同 v5）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager. No weapon, empty hands held forward at waist
height as if about to bandage something.

POSE: neutral standing pose matching the game's other card portraits (a
calm soldier standing at ease) — both feet planted evenly on the ground
side by side, weight balanced evenly between them, NOT a lunge, NOT a
forward stride, NOT one foot stepping ahead of the other. The only
dynamic touch is the upper body: shoulders rounded forward and head tipped
down in a gentle hunch, as if always ready to kneel down and tend to
someone — but the legs and stance stay calm and grounded, not a dramatic
forward lean of the whole body.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`lunge, forward stride, one foot stepping ahead, uneven weight, dynamic action pose, mid-stride, walking gait, pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：v6 站姿修正了，**但用户反馈传达的性格不对**——双手收在身前、头低垂，读出来是"做错事被抓的小孩"（怯懦/心虚），不是"随时准备照顾伤员"的专业医官。根因大概率是"empty hands held forward at waist height"这句被理解成了双手交握/缩在身前——那是防御性/紧张的肢体语言，跟"张开手伸向病人"的照护动作完全反着。**v7 只改手部描述**：明确写"双手分开、掌心向上/向外张开，向前下方伸，像正伸向倒地的伤员"，不是交握、不是缩在身前；姿态其余部分（双脚站定、上身含胸低头）不变。

**出图 prompt v7**（2026-07-29 修订，双手交握 → 双手分开张开伸向前下方，其余同 v6）：
```
Hand-drawn doodle in a worn school notebook, drawn with a BLACK INK
FOUNTAIN PEN — NOT pencil, NOT graphite: confident bold wet-ink strokes
with slightly varying line weight (thicker where the nib presses down,
thinner on quick flicks), small ink blots and a couple of tiny smudges
where the pen dragged, crisp and dark rather than grainy or hatchy.
Slightly wobbly imperfect strokes like a teenager sketching in the
margins during class, quick careless sketch. A hollow tube-limbed stick
figure character built from rounded pipe-like limb segments with circle
joints at each connection, a large round head with a single dot eye
positioned toward the facing direction, same construction language as a
basic soldier stick figure but adult proportions, sturdier and more
settled than a teenager. No weapon.

Both arms reach forward and slightly downward, held clearly APART from
each other and away from the torso — NOT clasped together, NOT touching
each other, NOT tucked in against the body. Both hands are open with
fingers/mitts spread, palms angled up and forward, like a caregiver
actively reaching out to steady or bandage a patient lying on the ground
in front of him — an attentive, purposeful, competent reaching gesture,
NOT a shy or bashful or nervous pose, NOT hands clutched together at the
waist, NOT hugging himself.

POSE: neutral standing pose matching the game's other card portraits (a
calm soldier standing at ease) — both feet planted evenly on the ground
side by side, weight balanced evenly between them, NOT a lunge, NOT a
forward stride, NOT one foot stepping ahead of the other. The upper body
leans forward slightly from the hips with shoulders and head tipped
forward and down toward where his reaching hands are pointing — an alert,
focused, caring expression, like he's intently watching what his hands are
doing, NOT a downcast or ashamed or withdrawn posture.

A square medicine satchel with a simple plus-sign cross mark on its flap
is slung across one shoulder on a diagonal strap, the whole satchel and
its cross mark colored solid in a bright GREEN marker/highlighter tone —
fully solid and opaque, no gradient, the strongest color note in the
piece. A strip of bandage cloth is wrapped around his forehead, ALSO
colored fully solid green, the same shade as the satchel.

In addition, a very light, faint, semi-transparent wash of that same
green highlighter color is brushed loosely over the ENTIRE body — torso,
arms, legs, head — like a highlighter pen skimmed lightly and unevenly
across the whole already-inked drawing: low-opacity, streaky, uneven
coverage that lets the black ink linework and shading underneath stay
fully legible. This faint all-over wash is much lighter and lower-opacity
than the solid satchel and bandage, so those two still read as the
strongest color accent, but the whole figure now carries a consistent
pale green cast instead of the color being isolated to two disconnected
spots.

Shading elsewhere is built from solid black ink fills and a few bold
parallel pen strokes in the deepest shadow pockets (inner elbow, folds of
the coat) — NOT pencil cross-hatching, NOT a grainy graphite texture. The
outline itself is thick and saturated enough to read clearly on its own,
so shading stays sparse and confident rather than dense.

Side profile view, facing right. Isolated single character, centered, on
a plain pure-white background, no grid lines, no other elements. Flat 2D,
no 3D, no gradients (except the faint uneven highlighter wash described
above), no glossy highlights, no thick cartoon outline. Color is limited
to: solid green on the satchel/cross/bandage, and a faint uneven green
wash over the rest of the body — no other colors, no blue, no red. The
underlying linework is monochrome black ink, to be tinted programmatically.
Style of West of Loathing / doodle art.
```
负向：`clasped hands, hands together, hands touching each other, hands clutched at waist, hugging self, arms crossed, shy pose, bashful pose, nervous pose, ashamed pose, guilty pose, downcast eyes, withdrawn posture, lunge, forward stride, one foot stepping ahead, uneven weight, dynamic action pose, mid-stride, walking gait, pencil, graphite, cross-hatching, hatched shading, sketchy pencil texture, blue ink, red ink, purple, flat clean vector color fill, sticker-like color patch, sharp clean color edges, gradient, color fill, painterly, shading gradient, 3d render, photorealistic, thick bold outline, clean vector, multiple objects, text watermark, gray background, notebook grid lines, drop shadow, weapon, sword, bow, child proportions, thin bare outline, sparse linework, empty unshaded body, flat unshaded silhouette`

> **出图状态**：✅ v7 已出图确认定稿（2026-07-29），可进入 GIMP 抠件 → animator 绑骨流程。

---

**下一步**：涛侧（本节）+ Anna 侧（[`ANNA_CHARACTERS.md`](ANNA_CHARACTERS.md#anna-阵营的三只怪物aello--björn--lerna)）六人设计均已定稿，等待用户一并过目。过目通过后：① §7.5 两项均已勾；② 排期出图（同 §0 资产分工走 AI 图 → GIMP 抠件 → animator 绑骨 → `.tao`）；③ 落 ADR（阵营归属+六个新命名角色，一次性记完，不分两次）。
