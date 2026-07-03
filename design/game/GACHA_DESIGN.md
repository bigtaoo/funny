# Notebook Wars — 盲盒系统完整设计

> 状态：实现中（G1/G2/G4/G5/G6 + 两阶段掉率(§2.1a)已落地 2026-07-03；G7–G10 美术展示层待美术） · 权威：本文 · 更新：2026-07-03
>
> **定位**：盲盒是游戏主要直接变现入口（另见月卡 §5、新手礼包 §6）。
> 经济数值权威 → [`ECONOMY_BALANCE.md §3–4`](ECONOMY_BALANCE.md)（价格/概率/保底数字）；
> 合规义务 → [`COMPLIANCE_GLOBAL.md §5`](COMPLIANCE_GLOBAL.md)（概率公示 Apple 3.1.1）；
> 发货实现 → `server/commercial/src/gacha.ts`；池定义 → `server/shared/src/economy.ts`。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| FOMO 驱动主消费 | 限定池才是主力收入，常驻池是托底。玩家为"有限时间内能拿到"而掏钱，不是为了保底 1% 概率。|
| 常驻池是安全垫 | 免费玩家无限积攒 → 一次性在常驻池发力；氪金玩家在限定池花光 → 常驻池兜底保底感。两池保底计数分开。 |
| 不卖 PvP 战力 | 盲盒产出：外观皮肤 + PvE 装备材料。PvP 永远公平（`ECONOMY_BALANCE §5`）。限定角色卡只是皮肤变体，不是战力差异。|
| 透明度 = 信任 | 每个物品的精确概率必须可查（Apple 3.1.1）。软保底开始点公示，让玩家感知"越来越近"而非等一个硬崖。|
| 月卡是留存锚 | 月卡的核心价值不是性价比，是让玩家"每天不登录就亏了"——自然提高 D7/D30 留存。|

---

## 2. 池分类

### 2.1 常驻池（Standard Pool）

- **id**: `standard`
- 永不下线，保底计数随账号存续
- 内容：文具材料 + 精良/成品装备 + 角色卡 + Anna 外观皮肤（见 `economy.ts GACHA_POOLS[0]` 与 §9.5 皮肤目录）
- 保底：90 抽大保底，十连保底 epic+（`ECONOMY_BALANCE §4.2`）
- 目的：给不跟限定的玩家提供去处，避免池内物品全重复感

### 2.1a 两阶段掉率算法（常驻池，拍板 2026-07-03）✅

常驻池的**基础抽**（非保底）改为**先类别、后物品**两阶段：

**阶段 1 — roll 类别**（`economy.ts CATEGORY_WEIGHTS`，`[adjustable]`，和为 1000；调校为有效 legendary 率≈1%，见下）：

| 类别 | 权重 | 占比 | 说明 |
|---|---|---|---|
| `material` | 701 | 70.1% | 文具材料（scrap/lead/binding） |
| `card` | 150 | 15.0% | 角色卡（花名册，[CHARACTER_CARDS_DESIGN](CHARACTER_CARDS_DESIGN.md)） |
| `equip_t1` | 100 | 10.0% | 一级装备 = fine 品（pen/cardstock/bookmark） |
| `equip_t2` | 30 | 3.0% | 二级装备 = rare 品（marker/leather/sticker） |
| `equip_t3` | 8 | 0.8% | 三级装备 = epic 品（highlighter/foil/seal），全 legendary 展示 |
| `skin` | 11 | 1.1% | 外观皮肤 |

**阶段 2 — 类别内 roll 具体物品**：按物品的**展示稀有度权重**加权。
- 皮肤用独立的**皮肤四档梯**（`SKIN_TIER_WEIGHTS`，见 §9.5）：普通 79 / 稀有 15 / 史诗 5 / 传说 1；空档（上线无普通/稀有皮肤）自动归一化剔除，上线阶段皮肤实际只落到 e1/e2(史诗)≈5:5 与 l1(传说)≈1。
- 角色卡用独立的**卡四档梯**（`CARD_TIER_WEIGHTS` = 普通600/稀有300/史诗150/**传说1**）：card 桶大(~15%)，传说 Anna 卡(max/lena/mara)对史诗卡按 **150:1** 重度压权，否则单它们就把 legendary 率拉到~2.1%。上线仅史诗/传说档有卡→单张传说卡≈0.033%。
- 其余类别用全局 `RARITY_WEIGHTS`（common700/rare230/epic60/legendary10）：材料偏 scrap。

**稀有度轴保留**：每件物品仍带**展示稀有度**（源自 `itemsByRarity` 反查，见 `itemRarityMap`），驱动结果卡配色、重复退币、以及**保底**。装备三档映射到展示稀有度：t1→rare、t2→epic、t3→legendary（沿用旧池分层，epic 装备属「传说级 jackpot」）。

**与保底的调和**（拍板：保留 legendary 稀有度轴，不重写 pity）：
- 硬保底（90 抽）：命中→从 `itemsByRarity.legendary` 均匀发一件 legendary 稀有度物品（皮肤 skin_l1 / 顶级装备 / Anna 传说卡）。
- 软保底（70 抽起爬升，§3）：覆盖两阶段，走 `rollRarityBoosted` 抬升 legendary 概率。
- 十连保底：无 epic+ 时最后一抽提升为 epic（从 `itemsByRarity.epic` 发）。
- 基础抽若命中 legendary 稀有度物品（如传说卡/epic 装备/传说皮肤）→ 同样重置 pity。
- **有效 legendary 率≈1%**（拍板 2026-07-03，调校后）：equip_t3 0.80% + 传说 Anna 卡 0.10%（card 桶内 150:1 压权）+ skin_l1 0.10%。此前未压权时为~3%（大头是 15% card 桶内的传说卡）；单靠 `CATEGORY_WEIGHTS` 压不下去（会砍掉整个 card/equip_t3 桶），故引入 `CARD_TIER_WEIGHTS` 压桶内传说 + equip_t3 微调 1%→0.8%。

**实现**：`commercial/src/gacha.ts rollCategory` + `rollCategoryItem`；类别结构 `economy.ts GACHA_POOLS[0].categories`。**仅常驻池启用**（设 `categories` 字段）；限定池（`buildLimitedPool`）与新手包（`rollStarterPack`）仍走旧扁平 rarity roll。概率公示 `poolEntries` 对两阶段池按 `P(类别)·P(物品|类别)` 展开。

### 2.2 限定池（Limited Pool）

- **有上下线时间**（建议 14 天，admin 手动控制）
- 每期主打 1 个限定 legendary（角色皮肤 / 限定文具装备）
- 限定 legendary **不进常驻池**（核心 FOMO 机制：错过就永久失去）
- **独立保底计数**：本期限定池的 pity 与常驻池分开记录
- **保底承接**：本期限定 pity 在下架时**不清零**，冻结保留至本 legendary 重复上线（如有「复刻」活动）；不转移到下一期限定
- 限定 legendary 首抽出货概率等于常驻池 legendary（1%），但池内 legendary 只有 1 个 → 大保底必出限定本体
- 「歪」机制（选项，可选实装）：若大保底出的不是本期限定（常驻 legendary 垫底时）→ 下次大保底**100% 出限定**，并在 UI 提示"下次必得"

### 2.3 单位卡池（Unit Card Pool）— 已下线（2026-07-03）

- ~~独立盲盒池 `units`（`UNIT_CARD_POOL_ID`）~~ 已彻底移除：它曾作为第二个非限定池出现，被客户端标签逻辑（只区分 limited/非limited）显示成第二个「常驻池」，与「平时只有一个常驻池」的设计意图冲突（S12-C 遗留，两套并存）。
- 角色卡改由 Hero Roster（[CHARACTER_CARDS_DESIGN.md](CHARACTER_CARDS_DESIGN.md)）承接，本就在 `standard` 常驻池中直接发放。
- **底层单位卡进度系统保留**：`cardInventory`/`grantCards`/`deriveUnitLevels` 及 PvE 关卡掉落 `levelCardReward`（S12-C）仍在用；本次仅删除 gacha 侧的 `units` 抽卡池及其发货路由。

---

## 3. 软保底（Soft Pity）

取代现有的"90 抽硬崖"，改为：

```
抽数      legendary 概率
1–69      1%（基础概率）
70–89     每抽 +5%（70抽=6%, 71抽=11%, ... 85抽≈81%）
≥90       100%（硬保底兜底）
```

**实现**：`rollGacha()` 增加 `softPityBase = 70, softPityStep = 0.05` 参数。超过 softPityBase 后，rollRarity 在滚点前先把 legendary 权重改成 `floor((pity - softPityBase + 1) * softPityStep * 1000)`，最高 1000（= 100%）。

**UI 显示**：不显示软保底数值（防止被计算"最优"等待点），但在概率详情弹层里说明"随抽数增加概率逐渐提升"。

---

## 4. 抽卡演出（Pull Reveal）

### 4.1 抽卡流程

```
点「单抽 / 十连」
→ 按钮进 busy 态（旋转铅笔 loader）
→ 发 API，服务端跑 RNG + 更新保底
→ 服务端返回结果列表
→ 全屏遮罩 fade-in
→ 逐张翻牌演出（见下）
→ 点击 / 滑动 → 关闭遮罩，刷新保底进度条
```

### 4.2 结果卡设计（每抽 1 张卡）

| 层 | 内容 | 实现 |
|---|---|---|
| 卡背景 | 稀有度底色纹理（4 张不同美术图，见 §9.1） | 美术资源 |
| 物品图 | 皮肤缩略图 / 装备图标（居中大图） | 美术资源 |
| 稀有度边框 | 按等级的笔记本风格边框（4 款） | 美术资源 |
| 标签 | `NEW` / `已拥有` badge | 程序绘制 |
| 名称 | 中文物品名 | 文案 |
| 退款提示 | 重复时显示退还金额 | 程序绘制 |

### 4.3 Legendary 特效

- 翻牌前：全屏**金光粒子爆发**（程序粒子，SketchPen 风格的笔触射线）
- 翻牌时：卡牌慢翻（~ 0.8s tween），伴随金光围绕卡边
- 翻牌后：卡牌有轻微光晕呼吸效果
- 以上特效全部程序实现（VFX Editor），**不需要单独美术图**；仅需卡背景纹理（§9.1）

### 4.4 十连模式

- 10 张卡同时在遮罩里排列（两排 5×2）
- 点击任意卡 → 进入单卡详情大图查看
- epic+ 卡默认展示在前（排序），视觉上先吸引眼球

---

## 5. 月卡（订阅）

### 5.1 产品定义

| 项 | 值 |
|---|---|
| 价格 | ¥30（对标中档 IAP 档，见 `ECONOMY_BALANCE §2.2`） |
| 有效期 | 购买后 **30 天**（精确到秒，服务端 `subscriptionExpiry` 字段） |
| 每日奖励 | 登录后发 **120 coins / 天**（需当日首次登录触发，服务端按 dayKey）；最近一次领取的 UTC 日 `subscription.lastClaimDayKey` 经 `WalletView.subscriptionLastClaimDay` 镜像进 `SaveData.monetization`，客户端据此判断「今日已领取」并置灰「领取」按钮（按钮标签即状态：可领 / 今日已领取 / 未开通置灰），不再依赖点击后的模糊提示 |
| 总价值 | 30 × 120 = **3,600 coins**（折算 120 coins/¥，等同于大档 IAP 率）|
| 免费天花板对比 | 无氪日上限 ~215 coins（`ECONOMY_BALANCE §6`），月卡使其 +120 → ~335/天 |
| 立即赠送 | 购买即刻额外发 **600 coins**（= 4 抽，即时满足感） |
| 可叠购 | **否**（全局单卡：有任意订阅卡生效期间，月卡与年卡的购买都锁定；服务端返回 `ALREADY_ACTIVE`。到期后再买——「买了必须用完才能再买」，不再叠购续期）|

### 5.1b 年卡（订阅）

| 项 | 值 |
|---|---|
| 价格 | **¥298**（= 12 张月卡 ¥360 的九折取整；UI 上原价 ¥360 划线 + 「省 ¥62」角标）|
| 有效期 | 购买后 **365 天** |
| 每日奖励 | 与月卡相同 **120 coins / 天**（订阅是同一字段，`/monthly-card/claim` 对年卡同样有效）|
| 立即赠送 | 购买即刻额外发 **600 coins**（与月卡一致）|
| 门控 | 与月卡共享**全局单卡**门控（见上）；有卡生效时购买返回 `ALREADY_ACTIVE` |

### 5.2 留存机制

- **每日推送**（本地通知，iOS/Android 权限已申请）："你今天的月卡奖励还没领！" → 跳转游戏
- **UI 入口**：商城页顶部固定卡面（月卡美术图，见 §9.3），到期前 3 天显示"即将到期"
- **过期提醒**：到期当天推一次"你的月卡已到期"

### 5.3 定价心理

¥30 月卡 3,600 coins（率 120）vs 直接买 3,300 coins（¥30 中档，率 110）→ 月卡多 9%，但分摊到 30 天，让"每天不登录就亏了"的心理强化每日留存。

---

## 6. 新手礼包（首次付费漏斗）

首次付费转化是变现的关键节点。拟设两个新手向产品：

### 6.1 首抽包

| 项 | 值 |
|---|---|
| 价格 | ¥6（最低 IAP 档） |
| 内容 | 1 次**保底 rare+** 的 10 连（即：十连中至少 1 个 rare，不占正常保底） |
| 限制 | 每账号**仅限购买 1 次** |
| 说明 | 不走常规 pity 计数，独立判断；商业侧单独标记 `starterUsed` |

### 6.2 新手成长包

| 项 | 值 |
|---|---|
| 价格 | ¥30 |
| 内容 | 3,300 coins（中档 IAP 正常量）+ **7 天限定月卡**（7 × 120 = 840 coins 加成） |
| 总价值 | 3,300 + 840 = 4,140 coins，实际 138 coins/¥ > 最大档 IAP 率（120）|
| 限制 | 账号前 7 天内可购（注册时间戳判断），**仅 1 次** |
| 说明 | 让新用户用最优惠的价格尝鲜月卡体验，培养习惯 |

---

## 7. 定向兑换（歪了补偿）

**目标**：让玩家感觉努力积累不会白费，减少大保底出"不想要的那个"的挫败感。

### 7.1 机制

- 每次大保底出货，根据是否命中本期限定来发放**命运点**（Fate Point，仅限定池有）：
  - 命中限定 legendary → 不发（已满足）
  - 歪出常驻 legendary → **发 1 个命运点**
- 命运点 **30 个** → 可在专属商店兑换**1 件自选限定 legendary**（历史已下线但曾上架的池）
- 命运点跨期累计，不清零，账号永久保留

### 7.2 实现要点

- `SaveData.fatePoints: number`（新字段）
- `commercial` 大保底逻辑里：歪出 → `fatePoints += 1`
- 兑换接口 `/commercial/redeem-fate`，扣 30 点 → 发货

---

## 8. 池内物品展示 UI

### 8.1 当前状态

GachaScene 顶部区域只有 4 个彩色圆点（common/rare/epic/legendary）加文字标签，玩家无法看到具体物品。

### 8.2 目标 UI

点击「① 概率详情」弹层（`oddsOpen` 状态已有）改造为两个 tab：

**Tab A：概率**
- 各稀有度概率（精确 % 值，含软保底说明）
- 大保底计数规则
- 十连保底说明
- 当前保底进度（`pity` 值）

**Tab B：物品列表**
- 按稀有度分组展示池内全部物品
- 每项：物品图标（60×60）+ 名称 + 概率（tier 内均分）
- 限定池在列表顶部加"限定标签"
- 已拥有的物品半透明显示

### 8.3 限定池 Banner

限定池替换默认盲盒区域的展示：
- Banner 大图（全宽，约 900×340px）展示限定角色立绘 + 池名
- 右上角倒计时（天:时:分:秒）
- 下方切换到常驻池的按钮

---

## 9. 美术资源清单

> ⚠️ 以下是美术需要交付的内容，按优先级排序。

### 9.1 【P0 · 必须先做】拉卡结果卡背景纹理（4 张）

每张对应一个稀有度，作为结果翻牌时的底图。风格：笔记本页面纹理 + 稀有度特有元素。

| 文件 | 稀有度 | 设计要求 | 尺寸 |
|---|---|---|---|
| `gacha_card_common.png` | 普通（灰） | 普通横线纸纹理，角落有铅笔阴影，低调 | 400×560px |
| `gacha_card_rare.png` | 稀有（蓝） | 钢笔墨水渐变纹理，边角有流动墨水感 | 400×560px |
| `gacha_card_epic.png` | 史诗（紫） | 荧光笔涂抹底色，带纸张浮雕感 | 400×560px |
| `gacha_card_legendary.png` | 传说（金） | 烫金纸质（竖纹压花），角落有金箔撕裂感 | 400×560px |

> 这 4 张是抽卡演出的直接背景，**没有它们无法做出抽卡体验**，优先级最高。

### 9.2 【P0 · 必须先做】稀有度边框（4 款）

结果卡上叠加在物品图外圈的边框，可以是 9-slice 资源。

| 文件 | 风格要求 |
|---|---|
| `frame_common.png` | 铅笔手绘双线矩形框，略歪 |
| `frame_rare.png` | 钢笔精细单线框，有墨水渗透角效果 |
| `frame_epic.png` | 马克笔粗线框，两头有荧光晕染 |
| `frame_legendary.png` | 金色烫印框，有压花压纹 |

### 9.3 【P1 · 月卡上线前】月卡卡面

用于商城顶部展示的月卡视觉卡片。

| 文件 | 设计要求 |
|---|---|
| `monthly_card.png` | 形如一张便利贴（浅黄底）或笔记本内页撕下的标贴，上写「月卡」，有日历/月亮图案装饰，右上角有金色印章感的「月」字；尺寸 ~560×240px |

### 9.4 【P1 · 限定池上线前】首期限定池 Banner

首个限定池必须有 Banner 大图，视觉上要让玩家一眼产生"我想要这个"的冲动。

| 文件 | 设计要求 |
|---|---|
| `banner_limited_01.png` | 横幅大图，约 900×340px（适配手机/平板横屏），左半角色立绘（首期 = 陶的限定皮肤「墨迹上将」或类似），右半池名 + 限定标签（红色"限定"印章）；笔记本页面背景，手绘笔触风格 |

### 9.5 【P1 · 限定池上线前】物品图标

池内物品列表需要每个物品的方形图标（60×60 展示，源图不小于 120×120）。

**皮肤分四档（拍板 2026-07-03）**：皮肤在抽卡 `skin` 类别内按独立梯度权重出货（`economy.ts SKIN_TIER_WEIGHTS`）：

| 皮肤档 | 权重 | 上线物品 |
|---|---|---|
| 普通 | 79 | （空，待补） |
| 稀有 | 15 | （空，待补） |
| 史诗 | 5 | `skin_e1`(Lena)、`skin_e2`(Mara) |
| 传说 | 1 | `skin_l1`(Max 旗舰) |

> 空档（普通/稀有）在 roll 时按已填充档归一化剔除，故上线阶段皮肤实际只落史诗/传说；补充皮肤时按档填入即自动生效。皮肤档即其展示稀有度（结果卡配色 / 重复退币）。

**上线皮肤目录（拍板 2026-07-02，宁缺毋滥）**：每个角色恰好 1 款皮肤、共 6 款，全部走**完整 `.tao`**（不做程序换色——v0.4 之后角色是全彩位图 `.tao`，无法程序 tint，详见 `art-direction §9.1`）。其余占位 SKU（`skin_c1~c4` / `skin_r1~r3`）已从 `economy.ts` 删除，等上线后按需再加。

| 物品 id | 渠道 | 角色 / 兵种 | 稀有度 | 图标设计要求 |
|---|---|---|---|---|
| `skin_shop_c1` | 商店直卖 300 | 李川 / Infantry | common | 陶方，灰白调 |
| `skin_shop_r1` | 商店直卖 800 | 苏远 / Archer | rare | 陶方，蓝色调 |
| `skin_shop_e1` | 商店直卖 1800 | 陈守 / ShieldBearer | epic | 陶方，紫色调 |
| `skin_e1` | 抽卡（标准池 epic） | Lena | epic | Anna 方，紫色调 |
| `skin_e2` | 抽卡（标准池 epic） | Mara | epic | Anna 方，紫色调 |
| `skin_l1` | 抽卡（标准池 legendary） | Max（旗舰） | legendary | Anna 方，金色 |
| 装备（`wp_pen` 等） | 抽卡 | — | — | 对应文具实物，程序侧会加稀有度边框 |
| 材料（`mat_scrap` 等） | 抽卡 | — | — | 碎纸/铅笔屑/装订针等文具感材料 |

> 客户端接线映射见 `client/src/render/UnitView.ts` `SKIN_ASSETS`（每款皮肤只重塑对应那一个兵种）；`.tao` 到位后填表即生效。皮肤图标可先用低分辨率概念稿占位。

### 9.6 【P2 · 可后做】常驻池静态 Banner

| 文件 | 设计要求 |
|---|---|
| `banner_standard.png` | 常驻池展示图，约 900×340px，画面感觉是"一个铺满各色文具的笔记本"，风格比限定池轻松，突出"随时可抽"感 |

---

## 10. 数值对齐（参考 ECONOMY_BALANCE）

本节不独立定数值，仅做对齐摘要（以 `ECONOMY_BALANCE.md` 为权威）：

| 项 | 值 | 来源 |
|---|---|---|
| 单抽价格 | 150 coins | §3.2 |
| 十连价格 | 1,350 coins（省 1 抽） | §3.2 |
| 大保底 | 90 抽 | §4.2 |
| 软保底起始 | 70 抽（本文 §3 新增） | 本文 |
| 十连保底 | epic+ | §4.2 |
| legendary 基础概率 | 1% | §4.1 |
| 重复退币 legendary | 1,500 coins | §4.3 |
| 月卡每日 | 120 coins × 30 天 | 本文 §5 |
| 月卡价格 | ¥30 | 本文 §5 |
| 年卡价格 | ¥298（12 月卡 ¥360 九折取整）× 365 天 | 本文 §5.1b |
| 订阅门控 | 全局单卡：有卡生效期间月卡/年卡均锁（`ALREADY_ACTIVE`） | 本文 §5.1 |
| 首抽包价格 | ¥6 | 本文 §6 |

---

## 11. 实现任务（按依赖顺序）

> 进度真源见 `META_TASKS.md` §S_GACHA。

| 步骤 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| G1 | 软保底：`rollGacha` 增加 softPity 参数，更新单测 | 无 | ✅ 2026-07-02 |
| G2 | 限定池：`GachaPoolDef` 加 `startAt/endAt/limited/featuredLegendary`，admin 接口创建/关闭 | 无 | ✅ 2026-07-02 |
| G3 | 限定池独立 pity：`wallet.gacha.pity` 已是 `Record<poolId, number>` | G2 | ✅ 早已具备（S5） |
| G4 | 歪了 / 命运点：`fatePoints` 字段，限定池歪出时 +1，兑换接口 | G3 | ✅ 2026-07-02 |
| G5 | 月卡：`subscription.expiry` 字段，购买接口，每日领取接口（dayKey） | 无 | ✅ 2026-07-02 |
| G6 | 首抽包 / 新手包：`starterUsed` 字段，单独发货逻辑 | 无 | ✅ 2026-07-02 |
| G6b | 两阶段掉率（§2.1a）：常驻池基础抽先类别后物品；皮肤分四档；保底保留 legendary 稀有度轴 | 无 | ✅ 2026-07-03 |
| G7 | 概率详情弹层改造（两 tab：概率 + 物品列表）| 美术 §9.2 / §9.5 | ⏳ 美术阻塞 |
| G8 | 限定池 Banner + 倒计时 UI | 美术 §9.4 | ⏳ 美术阻塞（当前占位程序 banner + 池切换 tab 已有） |
| G9 | 结果卡翻牌演出升级（legendary 粒子特效）| 美术 §9.1 | ⏳ 美术阻塞 |
| G10 | 月卡商城入口 + 到期提醒 | 美术 §9.3 | ⏳ 商城入口已有（占位）；本地推送提醒待做 |
| G11 | 自定义池（§12）：ops 自由配置 类别→物品 权重 + 币价 + 时间窗；服务端自动加载活跃池，客户端展示 | 无 | ✅ 2026-07-03 |

### 11.1 落地说明（2026-07-02）

**服务端（commercial 权威，meta 编排，均类型安全 + 纯单测绿；Mongo e2e 走 CI）：**
- **软保底（G1）**：`server/commercial/src/gacha.ts` `softPityLegendaryProb` + `rollRarityBoosted`；标准/限定/单位卡池 `softPityStart=70 / softPityStep=0.05`（`economy.ts SOFT_PITY_*`）。硬崖 90 仍作兜底（单位卡池已下线，见 §2.3）。软保底起点以下走原扁平权重表（旧行为不变，回归单测锁定）。
- **限定池（G2）**：config 存 commercial 新集合 `gachaPools`（admin 建/关，关闭=夹 `endAt` 到 now，永久保留以便命运点兑换）；池内容由 `@nw/shared buildLimitedPool()` 从常驻池**纯函数派生**（无漂移）。commercial `resolvePool` 只在 `[startAt,endAt)` 窗口内返回；越窗/未知→`POOL_UNAVAILABLE`。meta `getGachaPools` 追加当期活跃限定池（含 banner 元数据）。admin 端点 `/admin/gacha/pools`(GET/POST) + `/admin/gacha/pools/close`。
- **命运点 / 歪（G4）**：`wallet.fatePoints`（commercial 权威，镜像入 `SaveData.monetization.fatePoints`）。**限定池 legendary 层 = 主打 banner（约 50% 权重，靠 slot 重复）+ 常驻非角色卡 legendary 垫底**（`DEFAULT_LIMITED_FILLER_LEGENDARIES`）；抽到**非 banner** 的 legendary = 歪 → +1 命运点。兑换：`POST /fate/redeem`，扣 `FATE_POINT_REDEEM_COST=30`，兑换任一**历史 featured** legendary（查 `gachaPools`），meta 走 `deliverOrder(kind:'fate')` 发皮肤（幂等）。
  - **与 §2.2「大保底必出限定本体」的调和拍板**：§2.2 原描述池内 legendary 只有 1 个（则无从歪）；因用户明确要命运点，采用经典 **50/50 off-banner** 模型（歪出 → 命运点）。§2.2「下次必得」的保底翻转（需 per-pool guaranteed 标记）**本期未做**，留后续。
- **月卡 / 年卡（G5）**：`wallet.subscription{expiry,lastClaimDayKey}`。`POST /monthly-card/buy`（30 天）与 `POST /year-card/buy`（365 天）共享 `subscriptionCardBuy`：先幂等占 orderId 槽（并发同 orderId 走 E11000 分支返回既有结果），再做**全局单卡门控**——若 `subscription.expiry > now` 则回滚已占槽并返回 `ALREADY_ACTIVE`（不叠购、不续期，「用完再买」）；否则 `applySubscription` 设 expiry + 即赠 600 coins。`POST /monthly-card/claim` 每 UTC 日一次 +120 coins（`lastClaimDayKey` 守卫，月卡年卡通用）。真实 IAP 验单不在本期范围（当作已授权购买；接真实 SDK 时前置验单即可）。年卡 ¥298 仅前端展示价（服务端不扣币）。
- **新手包（G6）**：`wallet.starterUsed[]` 单账号一次。`POST /starter/buy`：`starter_draw`=常驻池 rare+ 保底十连（不动 pity，`rollStarterPack`），meta 走 `deliverOrder(kind:'starter')` 发货；`starter_growth`=3300 coins + 7 天月卡（成长包首 7 天窗口由 meta 按 `accounts.createdAt` 把关）。

**客户端（最小可用占位）：** GachaScene 加池切换 tab（常驻/限定）+ 命运点数与「兑换限定」按钮；ShopScene 顶部「交易」块加月卡（购买/每日领取）与两款新手包按钮。真实 banner/卡面/翻牌特效（G7–G10）待美术，程序占位可跑。`SaveData.monetization` 镜像段客户端只读。

**契约/生成物：** `openapi.yml` 加 4 端点（redeemFate/monthlyCardBuy/monthlyCardClaim/starterBuy）+ `GachaPool` 限定字段 + `SaveData.monetization`；`routes.gen.ts`（74 ops）与客户端 `openapi.ts` 均已重生。

### 11.2 两阶段掉率落地说明（2026-07-03）

- **数据（`@nw/shared/economy.ts`）**：新增 `GachaCategory` / `GACHA_CATEGORY_ORDER` / `CATEGORY_WEIGHTS` / `SKIN_TIER_WEIGHTS` / `CARD_TIER_WEIGHTS` / `withinCategoryWeight()` / `itemRarityMap()`；`GachaPoolDef` 加可选 `categories` 字段（仅常驻池填），`itemsByRarity` **保留**为展示稀有度/退币/保底发货的权威。
- **RNG（`commercial/src/gacha.ts`）**：`rollGacha` 基础抽在有 `categories` 时走 `rollCategory`+`rollCategoryItem`（两阶段）；无则退回 `rollRarity`（限定池/新手包不变）。硬/软/十连保底逻辑**未改**，仍走 `pickItem(itemsByRarity)`。
- **概率公示（`poolEntries`）**：两阶段池按 `P(类别)·P(物品|类别)` 展开，权重=概率×1e5（客户端归一化显示 %）；契约 `GachaPool.entries` 形状不变（itemId/weight/rarity），**无需改 openapi / 重生成**。客户端 GachaScene 只读 probability，无需改。
- **legendary 率调校（2026-07-03）**：`CATEGORY_WEIGHTS` 改和为 1000（equip_t3 微调 1%→0.8%）+ 新增 `CARD_TIER_WEIGHTS`（传说卡桶内 150:1 压权），有效 legendary 率 ~3% → **~1%**。见 §2.1a。
- **测试全绿**（合入 `worktree-gacha-custom-pools` 后复验）：commercial 全量 99（含两阶段/皮肤四档/卡四档/装备三档/`customGacha.test.ts`）；shared 全量 457（含 `gachaCatalog.test.ts`）；commercial/metaserver/admin `tsc` 均绿。
- **待办**：普通/稀有皮肤档待补物品；限定池两阶段化留后续（节日/自定义池已由 §12 ops 自定义池覆盖）。

## 12. 自定义池（ops 自由配置 / 节日限定）

> 落地 2026-07-03。**与 §2.2 派生式限定池并存的第二种池类型**（owner 拍板 2026-07-03）。§2.2 限定池内容从常驻池纯函数派生、带主打 legendary + 命运点 FOMO；本节的**自定义池**内容与概率完全由 ops 在后台自由编排，**无保底、无主打 legendary、无命运点**，规则更简单直接。

### 12.1 数据模型（`@nw/shared gachaCatalog.ts`）
- **类别（category）复用 §11.2 的规范枚举** `GachaCategory`（`economy.ts`）：`material | card | equip_t1 | equip_t2 | equip_t3 | skin`——两套池族共用一套类别词汇，避免重复概念。装备按 EquipRarity 归档（common/fine→equip_t1, rare→equip_t2, epic→equip_t3）。
- **物品目录 `GACHA_CATALOG`**：可被放入自定义池的全部物品，从既有注册表聚合——`EQUIPMENT_DEFS`（装备）、`CARD_DEFS`（角色卡）+ 皮肤/材料内联表。每项带 `{itemId, category, rarity, name}`；`rarity` 为**展示稀有度**（卡背色/概率分组），与标准池一致（装备 fine→rare, rare→epic, epic→legendary；角色卡 Anna→legendary, Tao→epic）。
- **`CustomPoolConfig`**：`{ id, name, costSingle, costTen?, startAt, endAt, categories: [{category, weight, items:[{itemId, weight}]}] }`。权重为**相对值**（不要求和为某数），归一化在抽卡/展示时进行。与 §11.2 的固定 `CATEGORY_WEIGHTS`/`withinCategoryWeight` 不同：自定义池的两级权重全部由 ops 现填。

### 12.2 两阶段加权抽取（`server/commercial/src/gacha.ts rollCustomGacha`）
1. 按 `category.weight` roll 出类别；2. 在该类别内按 `item.weight` roll 出物品。纯概率、无 pity/软保底/命运点。权重放大到 1e6 整数以守 `RandInt(n)` 契约、支持小数百分比。

### 12.3 存储 / 加载 / 展示
- **存储**：复用 commercial `gachaPools` 集合，`GachaPoolDoc` 加 `kind: 'derived' | 'custom'` 判别式（缺省=derived，向后兼容旧文档）。`createCustomPool` 校验（`validateCustomPool`）+ 拒绝遮蔽静态池 id + 编辑保留 createdBy/createdAt。
- **抽卡**：commercial `resolvePool` 返回判别联合；`gachaDraw` 按 kind 分支——自定义池用 `customPoolCost` 计价、`rollCustomGacha` 抽取、pity 不动、命运点=0。
- **自动加载**：meta `getGachaPools` 追加 commercial `listActiveLimitedPools`（按 `[startAt,endAt)` 过滤，两种 kind 都在内）中的自定义池，`customPoolEntries` 算出每项 `probability = P(类别)×P(类别内物品)` 供 Apple 3.1.1 概率公示。**服务器只返回未过期的**，越窗→`POOL_UNAVAILABLE`。
- **客户端**：`/gacha/pools` 已有链路无需改契约；自定义池带 `limited:true + name + endAt`，走既有池切换 tab + 概率弹层展示。GachaScene 加**到期倒计时/已结束**标签（`gacha.pool.endsIn/ended`）。

### 12.4 后台链路（ops → admin → meta → commercial）
- **能力点**：新增 `gacha.pools.manage`（super/ops 角色，`@nw/shared admin.ts`）；审计动作 `gacha.pool.create` / `gacha.pool.close`。
- **链路**：ops `pageGachaPools`（类别开关 + 权重 + 物品选择器 + 币价 + 时间窗，实时归一化 %）→ admin `/admin/gacha/pools*`（能力门 + 审计）→ meta `/admin/gacha/pools/custom`、`/admin/gacha/catalog`（x-internal-key）→ commercial `/internal/gacha/pool/custom`。关闭复用既有 `/admin/gacha/pools/close`。
