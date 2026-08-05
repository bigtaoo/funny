# Notebook Wars — 新手引导 / FTUE 设计

> 状态：设计中 · 权威：本文（首次体验**编排流程 + 专属教学关 + 首次功能引导**的单一入口）· 更新：2026-06-27
>
> **权威边界**：本文拥有 **① 专属教学关 `ch0_tutorial` 的编排/卡点/脚本特效**、**② 首次功能引导（per-feature first-use guide）机制**、**③ 功能开放策略（哪些首启即开、哪些设门槛）**。本文**不**拥有——故事文案（归 [`CAMPAIGN_STORY.md`](CAMPAIGN_STORY.md) / [`../product/world.md`](../product/world.md)）、引擎/波次数据结构（归 `@nw/engine` `campaign/`，见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) §16.7）、合规弹窗（归 [`COMPLIANCE_GLOBAL.md`](COMPLIANCE_GLOBAL.md) / [`COMPLIANCE_CN.md`](COMPLIANCE_CN.md)，**合规是开机第一步、不属于新手引导**，见 §6）、漏斗埋点字段（归 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md)）。

---

## 1. 设计目标

把"陌生玩家第一次打开 → 学会三类卡的操作 → 完成第一场必胜的教学 → 进大厅后该玩什么玩什么"压进一条**短、印象深、永不卡死、永不失败**的动线。北极星 = **教学完成率** 与 **D1 回访**。

**两条铁律**：

1. **教学关永不失败**。教学关 `ch0_tutorial` 用**固定种子 + 全脚本波次**（敌方不是 AI，是 `WaveDirector` 逐 tick 生成，见 §3.4），所有玩家流程完全一致，可设计专门的脚本特效强化印象。永不失败按构造保证（§3.5）。
2. **基调温和、不锁玩家**。教学可跳过、可重看；进大厅后功能不靠里程碑硬锁（仅 SLG 一道软门槛，§4），其余首次使用时弹**可关**的引导，页面常驻"?"再看。和 ADR-009/011「装备失败不碎、断签不惩罚」同一克制风格。

---

## 2. 首启序列（boot → FTUE flow）

```
冷启动
 └─ 【开机·合规层，非新手引导，§6】
 │    ① 年龄声明门（仅首启，neutral age gate）
 │    ② EU/UK 采集同意弹窗（按地区粗判，在任何埋点采集之前）
 │       —— 权威归 COMPLIANCE_GLOBAL，本文只约束「先合规 → 才埋点」的顺序
 │
 └─ 【FTUE 层，本文权威】
      ③ 首启故事 IntroScene（nw_seen_intro，可跳过）        [已有]
      ④ 登录门控 resolveEntry（含「单机试玩」入口）          [已有 SA-3]
      ⑤ ★ 教学关 ch0_tutorial（首次必经，可跳过，§3）       [新建]
      ⑥ 首胜结算 + 首次奖励 + 「明天再来」钩子（§5）         [部分已有]
      ⑦ 进大厅：功能首启即开 / 首次使用引导（§4）            [新建首次引导]
```

- **③④已实现**：IntroScene（`story.*` i18n、`nw_seen_intro` 门控）+ SA-3 登录门控。本文不改其内部，只把它们定位为 FTUE 的前两步。
- **⑤ 是本次新增的核心**：不再复用 `ch1_lv1`，改为**专属教学关**（理由：`ch1_lv1` 是正常 survive 关、会失败、波次为平衡服务，无法承载"卡点教学 + 必胜 + 脚本特效"）。教学关完成/跳过后写 `flags.tutorial_done`，再进不弹；设置/帮助里「重看教学」可再进一次。
- **教学关不计入战役章节进度**：它是独立 id `ch0_tutorial`，不占 ch1 的关卡序号，不影响 `progress`、星数、SLG 解锁判定（§4）。

---

## 3. 专属教学关 `ch0_tutorial`

> **设计前提**：假定玩家**从未玩过此类游戏（lane defense / 卡牌出兵）**。所以教学分两段：先**认知导览**（不动手，把"棋盘、敌我、方向、胜负、墨/手牌"讲透），再**动手三拍**（亲手放兵/建筑/法术）。每一步固定脚本、全员一致；三拍打完留一段**自由发挥**窗，再毕业。

### 3.1 阶段 A — 认知导览（orientation，不动手）

进场即暂停（引擎冻结、无敌人），用一串聚光灯把战场基本盘讲清。每步点一下「下一步」推进，可跳过。**色彩锚点：蓝 = 你，红 = 老师的批改军**（与 [`../product/art-direction.md`](../product/art-direction.md) 我蓝敌红一致）。

| 步 | 高亮 | 文案要点（讲透，给零基础） |
|---|---|---|
| **O1 我方** | 屏幕**下半 + 最底部的笔记本** | 竖屏："下面是你的地盘。最下面这本是**你的笔记本（基地）**。"；横屏："左边是你的地盘。最左边这本是你的笔记本（基地）。" |
| **O2 敌方** | 屏幕**上半 + 最顶部的笔记本** | 竖屏："上面是敌人——**老师的红笔批改军**。最上面那本是**它的笔记本**。"；横屏："右边是敌人——老师的红笔批改军。最右边那本是它的笔记本。" |
| **O3 区分敌我** | 同时点一个蓝兵、一个红兵 | "**蓝色永远是你的，红色永远是敌人的**。记住这一条就够了。" |
| **O4 行进方向** | 在一条车道上画两个反向箭头 | 竖屏："你的兵**从下往上**冲，去画花老师的笔记本；老师的兵**从上往下**压。"；横屏："你的兵**从左往右**冲；敌人**从右往左**压。" |
| **O5 车道概念** | 高亮几条纵列 | 竖屏标题"竖直车道"，文案："战场分成几条**竖道**，兵沿着自己那条道直直往前走，不会拐弯。"；横屏标题"横向车道"，文案改"横道"。 |
| **O6 胜负条件** | 先点己方基地、再点敌方基地 | "**你的笔记本被画花 = 你输；守住它、清掉所有红笔兵 = 你赢。**（真正对战里，也能反过来攻破对方笔记本取胜。）" |
| **O7 墨与手牌** | 高亮墨条 + 手牌区 | "出牌要花**墨**，墨会自己回涨；墨不够的牌是**灰的**。打出的牌进冷却，过一会儿**自动换一张新的**。" |

> O1–O7 是纯讲解，玩家只点「下一步」。讲完进阶段 B 第一次动手。**箭头/聚光灯都是表现层演出，引擎冻结不前进。**

### 3.2 阶段 B — 动手三拍（固定引导卡）

满手牌（§3.3），但**引导只锁定固定的三张卡**，顺序固定：**放兵 → 放建筑挡路 → 放法术清场**。每拍 = **高亮目标卡 + 目标道 → 卡住推进直到玩家真打出这张卡 → 放出专门设计的脚本反应**，让玩家立刻看到"我这一手起了什么作用"。三类卡操作同源（拖卡到场），差异在效果：

| 类别 | 引导卡 | 要让玩家记住的点 |
|---|---|---|
| **单位卡** | `infantry_1`（步兵） | 拖到场 → 派出会**向前推进**的兵 |
| **建筑卡** | `tower_1`（炮塔） | 钉在原地的**固定防线**，不动、守一条道 |
| **法术卡** | `meteor_1`（陨石） | **即时 AoE**、不留实体、费墨高、关键时刻一次清场 |

**Beat 1 · 放兵（单位卡）**
- 高亮手里的 `infantry_1` + 一条指定空道："把这张兵卡拖到这条道——派出你的第一个小兵，它会自己往上冲（横屏：往右冲）。"
- **卡点**：暂停推进，直到引擎事件「在该道放下一个单位」发生。
- **脚本反应**：玩家放兵后，该道顶端**正好走下 1 个最弱红兵**（孤身、无支援），与玩家的蓝兵迎面相遇被干掉。
- 收束："看——蓝兵往上推，挡住了红笔兵。这就是派兵。"

**Beat 2 · 放建筑挡路（建筑卡）**
- 高亮 `tower_1` + 另一条指定道："这次放一座**炮塔**。和兵不一样，建筑**钉在原地不动**，是你的固定防线。"
- **卡点**：暂停推进，直到引擎事件「在该道放下一个建筑」发生。
- **脚本反应**：玩家放塔后，该道**一小队（2–3 个红兵，间隔下来）压下来**，被炮塔逐个点掉 / 卡在塔前。对比 Beat 1 突出"兵会走、塔不动但能持续守一条道"。
- 收束："炮塔死死守住了这条道。兵负责推进，建筑负责防守。"

**Beat 3 · 放法术清场（法术卡）**
- **脚本铺垫**：先在第三条道**刷出一团挤在一起的红兵**（4–5 个，密集同列），故意让玩家觉得"靠兵和塔来不及"。
- 高亮 `meteor_1` + 那团敌人："敌人挤成一团时，用**法术**一次清掉。法术不留实体、**很费墨**，是你的大招。"
- **卡点**：暂停推进，直到引擎事件「在该团位置释放法术」发生。
- **脚本反应**：陨石落下、震屏 + 焦痕特效，那团敌人**一次清空**——全教学最爽的一下，刻意做大特效。
- 收束："漂亮！法术贵但够狠，留给关键时刻。"

### 3.2.1 阶段 C — 自由发挥 + 毕业

- 三拍打完，**解除所有卡点**：手牌正常冷却循环、满手卡随便出，引擎正常推进，但**仍无威胁波次**。
- 轻提示："现在随便试试别的卡吧——剩下的兵种、建筑、法术都解锁了。" 给玩家一个安全的沙盒喘口气。
- 屏幕常驻「**完成教学**」按钮；点击 → 脚本判定**胜利**。
- "你已经学会了全部基础——派兵、建防线、放大招。去真正的战场吧！" 接 §5 首胜钩子。

### 3.3 教学关数据（level JSON 草案）

存放：`client/src/game/campaign/levels/ch0_tutorial.json`（与其它关卡同目录、同 schema，不改 `@nw/engine` 数据结构）。

```jsonc
{
  "id": "ch0_tutorial",
  "chapter": 0,                 // 章节 0 = 教学，不计入 ch1 进度
  "seed": 1,                    // 固定种子，全员一致
  "objective": { "kind": "survive" },
  "startInk": 60,               // 给足墨，保证三类卡都出得起（尤其法术）
  "inkRegenMult": 2.0,          // 回墨快，不让玩家干等
  "enemyScale": { "hp": 1, "damage": 1 },
  "loadout": [                  // 满手牌池：教完进阶段 C 能自由发挥（不再砍成 3 张）
    "infantry_1", "infantry_2", "shieldbearer_1", "archer_1",
    "barracks_1", "tower_1", "tower_2", "haste_1", "meteor_1"
  ],
  "waves": {
    // 关键：每段 wave 都是"某个 beat 通过后"才该出现的反应波。
    // 绝对 tick 由教学导演的"暂停-放行"对齐（§3.4）：暂停时引擎时钟冻结，
    // 放行后这些相对 tick 才推进，所以脚本反应永远紧跟玩家动作。
    "entries": [
      // Beat 1 反应：单兵
      { "atTick": 30,  "unitType": "max", "col": 4, "count": 1 },
      // Beat 2 反应：一小队压塔道
      { "atTick": 30,  "unitType": "max", "col": 7, "count": 3, "spacingTicks": 24 },
      // Beat 3 铺垫：密集一团供法术清场
      { "atTick": 30,  "unitType": "max", "col": 2, "count": 5, "spacingTicks": 4 }
    ]
  },
  "rewards": { /* 见 §5，首胜软通货 + 引出签到，不新增金币龙头 */ },
  "nameKey": "campaign.tutorial.name",
  "briefKey": "campaign.tutorial.brief"
}
```

> tick/列号/数量均为草案，实装按手感调。**每段反应波的列号与 Beat 高亮的道一致**，保证玩家刚布的防御正好接住对应的敌人。

**脚本抽牌策略（teaching cards 必到手）**：手牌是「槽位 + 冷却自动抽」（`Player.drawPolicy` 默认 `UniformCardDrawPolicy`，见 `@nw/engine Card.ts`）。

> **为什么不靠"魔法种子"凑？** 抽牌用的是**种子化确定性 LCG**（`math/prng.ts`，从不调 `Math.random()`），所以"固定种子 → 固定抽牌序列"确实成立。但**不要**靠搜一个恰好把引导卡排到位的种子：每次补牌（打出即补 / 计时到期换牌）都从同一 `cardPrng` 抽，而**抽取的"请求顺序"受玩家出牌时机影响**（打出一张立刻触发一次补抽，与计时到期的补抽交织）。于是该确定序列同时耦合了**卡池内容/顺序、`HAND_SIZE`、冷却 tick 常量、玩家点击微观时机**——任何平衡改动都会悄悄打乱、引导卡跑位且无报错。

`drawPolicy` 本就是可替换接口——教学关注入一个 **`TutorialDrawPolicy`**：开局手牌固定含 `infantry_1`（Beat 1 用），打出后续抽保证 `tower_1`（Beat 2）、`meteor_1`（Beat 3）按序到手，其余槽位用 loadout 里其它卡填满（手牌看起来是满的）；进阶段 C 后切回 `UniformCardDrawPolicy` 正常随机循环。它**确定地**返回脚本卡、无视卡池/时机变化（抗后续平衡改动），同样是纯引擎确定性件、不破坏回放。导演只需高亮"已知在哪个槽"的引导卡。

### 3.4 教学导演（TutorialDirector，新工程件）

现有 `WaveDirector` 是纯 tick 驱动、不等玩家。卡点教学需要一个**表现层导演**，只在 `ch0_tutorial` 激活：

- **归属**：表现层（`client/src/render` 或 `scenes`），**不进 `client/src/game` / `@nw/engine` 纯引擎**（同音频/coach-mark 红线，保引擎确定性/回放/裁判不受影响）。
- **职责**：
  1. **阶段 A 认知导览**：按 O1–O7 顺序播聚光灯 + 反向箭头等纯演出（引擎全程冻结），点「下一步」推进。
  2. **阶段 B 卡点**：按 beat 顺序显示高亮目标卡 + 目标道（提示文案）。
  3. **暂停门**：开门期间冻结 BattleScene 的引擎推进（time-scale=0 / 停止 step），敌人不动、波次不出。玩家的拖卡输入仍被采集并作为指令处理。
  4. **beat 完成判定**：命中当前 beat（放了单位 / 放了建筑 / 放了法术）→ 关门、放行 → 引擎恢复推进，对应反应波（§3.3）随即播出。
  5. **阶段 C**：解除卡点、切回随机抽牌，展示「完成教学」按钮；点击后触发胜利演出。
- **判定来源**：锁步下客户端每 tick 已镜像**完整逻辑态**——导演**读同步态做差分**即可判定（目标道新增了我方单位/建筑、某处出现法术效果），**无需新铺引擎事件管线**。导演只读态、控时钟、控 UI，**不改写战斗状态**。
- **进度持久化**：`SaveData.flags.tutorial_step`（断点续教）/ `tutorial_done`（完成或跳过后不再弹）。
- **可跳过**：右上角常驻 skip → `tutorial_done=true` → 落大厅。设置/帮助「重看教学」清 `tutorial_done` 重进。
- **i18n**：`tutorial.*` 全语种（zh/en/de）。

### 3.5 永不失败（never-fail）—— 按构造 + 兜底

1. **按构造**：教学关**没有任何"非卡点"的进攻窗口**。每段敌人都是某个 beat 通过后才放出的反应波，且出现在玩家刚布防的同一条道——敌人永远撞上玩家刚做的防御。卡点期间引擎冻结，零威胁。
2. **兜底（推荐）**：教学关期间**基地血量不可破**（落到 1 即夹住）。实现优先放表现层（导演拦截基地致死）以免动 `@nw/engine`；若需引擎级保证，再评估加一个 `tutorial` 关卡标记（最小改动）。
3. 二者叠加 → 玩家全程发呆也只会卡在当前 beat 提示上，绝不会输、绝不会 game over。

---

## 4. 大厅功能开放策略（取代旧「里程碑灰显解锁」）

**总原则：默认全开放 + 首次使用引导，仅 SLG 一道软门槛。** 不再有"通 X 关解锁社交/排位"的灰显格子。

| 功能 | 开放时机 | 首次引导 |
|---|---|---|
| 战役关卡 | **首启即开** | 教学关本身即引导 |
| PvP 匹配 | **首启即开**（新号可直接匹配开打） | 首次进匹配弹引导 |
| 商店 / 盲盒 | **首启即开** | 首次进店弹引导 |
| 社交（好友/私聊/邮件） | **首启即开** | 首次进社交弹引导 |
| 拍卖行 / 养成 / 装备 / 战令 / 赛季 / 成就 | **首启即开** | 各自首次进入弹引导 |
| **SLG 大世界** | **通关第一章（ch1 全清）后解锁** | 解锁后首次进入弹引导 |

- **唯一门槛 = SLG**：理由——SLG 是最重、最吃理解的系统，新号直接进会迷路/被劝退；先让玩家在战役里建立基础认知。门槛判定 = `progress` 中 ch1 是否全清（与教学关 `ch0_tutorial` 无关，教学不计进度）。
- **未解锁的 SLG 入口**：灰显 + 「通关第一章解锁」气泡（全局唯一一处这种气泡）。
- **门控数据单一来源**：解锁阈值集中一处常量（建议客户端 `onboarding.ts`），客户端据 `progress` 判定 SLG 灰显/点亮。
- 与 SA-4「offline 模式社交/联机入口路由到登录」**叠加**：先过登录门，再谈功能引导。

### 4.1 首次功能引导（per-feature first-use guide）

- **触发**：每个功能页首次打开时，弹一段**可关**的引导覆盖层（1–N 步，简短）。
- **持久化**：`SaveData.flags.featSeen.<featureId>`（如 `featSeen.match`、`featSeen.shop`、`featSeen.social`、`featSeen.auction`、`featSeen.slg`…）。看过/关掉后不再自动弹。
- **再看入口**：**每个功能页自己挂一个「?」按钮**（不做集中列表），点击重开该页引导。
- **形式**：与教学关一致的轻提示风格（聚光灯/卡片），可随时关闭；不阻断玩家用功能。
- **i18n**：`guide.<featureId>.*` 全语种。

---

## 5. 首胜 / 回访钩子（与 RETENTION 对齐）

教学关毕业即首胜，要埋下"明天回来"的理由，但**不新增金币龙头**（ADR-011）：

- 教学关首胜即时奖励（一次性，软通货为主）。
- 首胜后**引出每日签到 / 每日任务入口**（机制权威归 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)），让玩家看到"明天有东西拿"。
- D0 结束温和提示「去打第一章 / 明日签到」，不强推。

### 5.1 作者欢迎邮件（打破第四面墙，一次性）

- **触发**：玩家生涯**首次真正通关一关**（`progress.cleared` 从空到非空，即 `pveClear` 结算前 `cur.progress.cleared.length === 0`）。教学关 `ch0_tutorial` 不计入 `progress`（§2），所以对正常 FTUE 路径而言，这封信会在**教学关之后、通关 `ch1_lv1` 时**首次触发，不是教学关本身。
- **内容与身份**：以真实作者「陶」的第一人称写一封短信——感谢玩家体验《Notebook Wars》、探索这个故事，欢迎任何反馈与交流，附联系邮箱 `tao@gamestao.com`。这封信是**打破第四面墙**的手法（呼应世界观：叙事里「陶」本身也是这个游戏的作者，见 [`../product/world.md`](../product/world.md) 尾声），不与战役剧情文案（[`CAMPAIGN_STORY.md`](CAMPAIGN_STORY.md)）混同——邮件文案权威在本节，不进 CAMPAIGN_STORY。
- **机制**：复用现有系统邮件通道（[`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md) §3.3），走 metaserver 内部 `insertSystemMail` 直调（同进程，不经 HTTP），dispatchKey 固定 `welcome.author`（`${dispatchKey}:${accountId}` 幂等，客户端重试/多端不会重复发信）。**最佳努力（best-effort）**：发信失败只记日志，不阻塞关卡结算响应，也不影响材料/卡牌/成就等正常发奖。
- **附件**：金币 ×1000（一次性 faucet，数字见 [`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md) §2.4 同级别一次性奖励口径），`expireDays: 30`（超时未领与其它系统邮件一致过期）。
- **与反馈入口解耦**：这封信与「游戏内反馈入口」（[`UI_DESIGN.md`](UI_DESIGN.md) 大厅入口一节）是两件独立的事——反馈入口常驻可用，不依赖玩家是否读过/领取过这封信。
- **i18n key**：`mail.welcome.author.subject` / `mail.welcome.author.body`，全语种（zh/en/de）。
- **测试覆盖**（用户要求"全部加测试"后追加，2026-08-05）：`test/pve.e2e.test.ts` 原有首触发+幂等去重+`mail_new` 推送一例；新增一例覆盖 best-effort 路径本身——`socialsvc.insertSystemMail` 抛异常（`ThrowingSocialsvc`）时结算仍正常返回材料奖励+写入 `progress.cleared`，不被邮件失败连坐（断言时特意让 `gateway.available=false`，避免撞上 L1 spot-check 对"生涯首次通关"必定触发复核的既有规则，见 `PVE_INTEGRITY_PLAN.md`/`pveRewards.ts shouldSpotCheck`）。

---

## 6. 合规挂钩（开机第一步，**不属于新手引导**）

> 关键修订：年龄门 / 采集同意是**冷启动后、进入任何 FTUE 之前**的强制开机步骤，权威归 [`COMPLIANCE_GLOBAL.md`](COMPLIANCE_GLOBAL.md) / [`COMPLIANCE_CN.md`](COMPLIANCE_CN.md)。本文只约束它与 FTUE 的**先后顺序**，不拥有其内容。

1. **年龄声明门**：首启、neutral age gate（不诱导），结果影响分级/COPPA。
2. **EU/UK 采集同意**：按地区粗判，**在任何埋点采集之前**弹。
3. 年龄门 + 同意状态持久化进 `flags`，不重复弹。

> 顺序铁律：**合规（年龄/同意）→ 才开始埋点采集 → 才进 IntroScene / 教学关**。否则首启漏斗事件本身就违规。教学可跳过、合规不可跳过——两类门要明确区分。

---

## 7. 漏斗埋点（字段权威归 ANALYTICS）

每个关键节点打点，用于诊断流失。**事件字段定义归 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md)**，本文只列**该埋哪些节点**：

`首启 → 合规通过（年龄/同意）→ intro 完成/跳过 → 登录方式（试玩/匿名/正式）→ 教学关开始 → 教学各 beat 完成/卡住时长/跳过 → 教学毕业（首胜）→ 首胜领奖 → 各功能首次引导 弹出/关闭/再看 → 次日回访`。

> 采集受 §6 同意门控；EU/UK 未同意则不采上述行为事件。教学**逐 beat 的完成率与卡住时长**是迭代脚本的核心数据。

> **逐节点核实（design-doc-audit-2026-07，对照代码）**：
> - ✅ **首启/合规通过**：`session_start`（标准）、`gdpr_consent`（`createAppCore.ts`）。
> - ✅ **intro 完成/跳过**：`intro_complete`/`intro_skip`（`app/nav/auth.ts` `goIntro()` 的 `onFinish(skipped)`），100% 采样，已纳入 `ANALYTICS_DESIGN.md` §9.6 `ONBOARDING_STEPS` 的 `intro_seen` 步骤——**本行此前记「`IntroScene.ts` 无埋点」已补齐（同一批次修复）**。
> - ❌ **登录方式（试玩/匿名/正式）**：未找到区分登录方式的专属事件；`login_gate_hit` 只在已登录会话触发游客态跳转时打点（`nav/social.ts`/`nav/world.ts`），不是登录方式选择本身。优先级较低，暂不强制。
> - ✅ **教学关开始/教学各 beat/教学毕业**：`tutorial_start`/`tutorial_step`（`step_key`=`orientation_1..7`/`beat_unit`/`beat_building`/`beat_spell`/`freeplay`）/`tutorial_complete`/`tutorial_skip` 全部已接（A9-9，`TutorialDirector.ts`→`GameRenderer`→`game.ts#goTutorial()`），100% 采样，`GET /internal/query?type=tutorial_funnel` 可查——**此前 §8/§9 把这条记成"待补"是过期记录，已订正**。
> - 🟡 **首胜领奖**：无独立事件，靠 `tutorial_complete`（毕业=首胜）代打，够用但没有单独区分"完成教学"与"实际领到奖励"两个时刻。
> - 🟡 **各功能首次引导 弹出/关闭/再看**：`feature_guide_shown`/`feature_guide_closed{feature}` 已接（`LobbyScene/overlays.ts`+`app/nav/lobby.ts` 的 `withGuide`），100% 采样，`GET /internal/query?type=feature_guide_funnel` 可查。**「再看」`feature_guide_replay` 事件名/采样已预留，但客户端尚无调用点**——见 §8/§10「各子页内「?」按钮未逐页接」，仍是独立待办。
> - ✅ **次日回访**：`session_start` 时间序列做 D1 cohort（`ANALYTICS_DESIGN.md` §9.5），不需要专属事件。
>
> intro 完成/跳过 + 功能首次引导弹出/关闭两处事件已补齐（design-doc-audit-2026-07 后续跟进，见 `ANALYTICS_DESIGN.md` §12.5）；「再看」事件与登录方式节点仍待后续接入（登录方式优先级较低，暂不强制）。

---

## 8. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| 首启故事 IntroScene + `nw_seen_intro` | ✅ 已有（含跳过、`story.*`） |
| 登录门控 + 单机试玩 | ✅ 已有（SA-3） |
| 关卡数据结构 / WaveDirector（脚本波次、固定种子） | ✅ 已有（`@nw/engine campaign/`），教学关复用，无需改 schema |
| **教学关 `ch0_tutorial` JSON**（满 loadout） | ✅ 已建。`client/src/game/campaign/levels/ch0_tutorial.json`，仅入 `CAMPAIGN_LEVELS` 不入 `CAMPAIGN_LEVEL_ORDER`（不计进度） |
| **TutorialDirector（认知导览 O1–O7 + 卡点暂停门 + 脚本反应 + 自由发挥窗）** | ✅ 已建。`client/src/render/TutorialDirector.ts`（表现层：读同步态差分 + 控时钟 + 控 UI） |
| **TutorialDrawPolicy（保证引导卡按拍到手，确定性纯引擎）** | ✅ 已建。`@nw/engine Card.ts`，`GameEngine` 据 `id===ch0_tutorial` 注入；含 `enterFreePlay()`（阶段 C 切随机） |
| `flags.tutorial_done` + 「重看教学」 | ✅ 已加。`tutorial_done` 门控；设置「帮助 → 重看新手教学」重跑。**`SaveData.flags.tutorial_step` 断点续教未做**（见 §10——⚠️ 与下面「FTUE 漏斗埋点」行提到的 `tutorial_step` **同名不同物**：这里指存档断点续教字段，未建；那里指 analyticsvc 的 `tutorial_step` 埋点事件，已建，两者互不影响，勿混淆） |
| 教学关永不失败兜底（基地不可破） | ✅ 已建。导演每 tick 夹 `baseHp≥1` + GameRenderer 未毕业时吞 `game_over/game_draw`（导演独占终局） |
| SLG 软门槛（通 ch1 解锁）+ 灰显气泡 | ✅ 已接。`progress.isFirstChapterCleared` + 大厅 `worldLocked` 灰显 + `showInfoToast`「通关第一章解锁」 |
| **首次功能引导机制（`flags.featSeen.*`）** | ✅ 机制已建。`SaveManager.featSeen/markFeatSeen` + 大厅 `showFeatureGuide` + `withGuide`（match/shop/social/cards/daily/world）+ `guide.*` 全语种 + `feature_guide_shown/closed` 埋点（design-doc-audit-2026-07 补齐，见 §7）。**各子页内「?」按钮未逐页接**（见 §10），因此 `feature_guide_replay` 事件暂无调用点 |
| 首胜奖励 + 签到入口引出 | 🟡 毕业=首胜走既有结算链；签到由大厅红点承载，未新增金币龙头（§5） |
| 年龄门 + EU/UK 同意弹窗 | ❌ 待建（合规，归 COMPLIANCE，开机层） |
| **作者欢迎邮件**（首次真正通关+1000金币，§5.1） | ✅ 已建（`server/metaserver/src/service/pve.ts` `pveClear`，e2e `test/pve.e2e.test.ts`） |
| FTUE 漏斗埋点 | ✅ 已接（design-doc-audit-2026-07 核实：本行与 §9 待办条目此前是过期记录——A9-9 早已落地逐 beat 埋点 `tutorial_step`，`step_key` 覆盖 `tutorial_start→orientation_1..7→beat_unit→beat_building→beat_spell→freeplay→tutorial_complete`，`TutorialDirector.ts`→`GameRenderer`→`game.ts#goTutorial()`→`analytics.track()`；100% 采样，`GET /internal/query?type=tutorial_funnel` 可查逐步转化率，字段权威见 `ANALYTICS_DESIGN.md` §9.9/§9.6。仅剩 §7 提到的「登录方式/首次功能引导 弹出关闭再看/次日回访」几个漏斗节点是否全部接齐未逐项复核，非本次审计范围） |

---

## 9. 待办（开发顺序）

1. ✅ **教学关 `ch0_tutorial.json`** + **TutorialDirector**（阶段 A O1–O7 → 阶段 B Beat 1–3 + 脚本反应波 → 阶段 C 自由发挥 + 毕业 + 永不失败兜底）+ **TutorialDrawPolicy** + `flags.tutorial_done` + 跳过/重看。
2. ✅ **首次功能引导机制**：`flags.featSeen.*` + `guide.*` i18n（各子页内「?」按钮待逐页接，§10）。
3. ✅ **SLG 软门槛**：解锁阈值（`isFirstChapterCleared`）+ 大厅 SLG 入口灰显气泡（通 ch1 点亮）。
4. **首胜钩子**：教学毕业奖励话术 + 引出每日签到入口（当前走既有结算 + 大厅红点，未做专门话术）。
5. **合规开机层**（年龄门 + EU/UK 同意，与 COMPLIANCE 联动，海外测试前必须）。
6. ~~FTUE 漏斗埋点接入~~ ✅ 已完成（`tutorial_start/complete/skip` + 逐 beat `tutorial_step` 全部已埋，见 §8「FTUE 漏斗埋点」行——design-doc-audit-2026-07 核实此条目此前是过期记录）。
7. 依教学完成率与 D1 数据迭代 beat 脚本与提示文案。

---

## 10. 实现记录（2026-06-27）

落地 §9 第 1–3 项 + 部分 4/6。关键实现决策与对设计的偏离：

- **引擎注入方式**：不改 level JSON schema。`GameEngine` 据 `config.level.id === TUTORIAL_LEVEL_ID('ch0_tutorial')` 注入 `TutorialDrawPolicy`；常量在 `@nw/engine campaign/tutorial.ts`（引擎/客户端单一来源）。
- **TutorialDrawPolicy**：前 3 抽确定性返回 `infantry_1→tower_1→meteor_1`（开局手牌即含三张引导卡），其后从 loadout 去掉三张引导卡的 filler 池抽（打出引导卡不会补成另一张引导卡）；`enterFreePlay()` 阶段 C 切回整副 loadout 随机。纯种子化、不调 `Math.random`。
- **导演时钟模型**（`TutorialDirector`）：开局先喂 1 tick 发牌（`emitInitialEvents` 在 `firstStep` 内）再冻结进导览；place 拍（兵/塔）= 冻结→玩家放→放行→反应波（关卡 atTick 20/140）→到 gate 冻结下一拍；clear 拍（法术）= 先放行刷铺垫敌团（atTick 300）到 setupTick 再冻结→玩家清场。判定走 `commitCardPlay` 钩子（allowCardPlay 否决误打）+ 读手牌槽差分高亮，不铺新引擎事件管线。
- **永不失败**：导演每 tick 夹 `bottomPlayer.baseHp≥1` + GameRenderer 在 `tutorial && !finished` 时吞掉 `game_over/game_draw`，导演经 `forceTutorialVictory()` 独占终局。
- **认知导览简化**：O1–O7 当前为「全屏暗化 + 居中指令卡 + 下一步」，**未做聚光灯挖洞/反向箭头**（设计原意），靠文案讲透。后续可加 spotlight cutout。
- **`tutorial_step` 未持久化**：`SaveData.flags` 是 `Record<string,boolean>`，存不了数字步进；教学短且永不失败，未毕业（`tutorial_done=false`）下次启动从头重跑，不做断点续教。如需，另开 `SaveData` 字段。
- **首次功能引导**：`featSeen.<id>` 用扁平 flag 键（不改 schema）。首启引导在**大厅**弹（`LobbyScene.showFeatureGuide` + core `withGuide` 包 match/shop/social/cards/daily/world），关闭后续接导航。**各子页内常驻「?」重看按钮未逐页接**——当前重看入口=设置「重看新手教学」(重跑教学关) + 各功能首次 `withGuide`；逐页「?」复用同一 `guide.*` i18n，后续在各 Scene 加按钮即可。拍卖在大世界内，未单独接首启引导。design-doc-audit-2026-07 后续跟进已给 `withGuide` 接上 `feature_guide_shown/closed` 埋点（§7）；`feature_guide_replay` 已预留但要等这里的「?」按钮落地才有调用点。
- **FTUE 注入点**：`createAppCore.goLobby` 一次性闸门——本会话首次将进大厅且 `!tutorial_done` → 改走 `goTutorial()`（步骤 ⑤，在登录/试玩之后、大厅之前）。
- **验证**：engine `tsc -b` + 18 项引擎测试通过；client `tsc --noEmit` + 生产 webpack 构建通过。
