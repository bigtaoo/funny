# Notebook Wars — 新手引导 / FTUE 设计

> 状态：设计中 · 权威：本文（首次体验**编排流程 + 专属教学关 + 首次功能引导**的单一入口）· 更新：2026-10-07
>
> **2026-10-07：第一分钟重做已实现**（CrazyGames 以「整体质量」拒稿，审核员 57 秒就在教学关第二拍关页）。§3 已改写成新版教学关；为什么这样改、当时的取舍见 [§11](#11-v2第一分钟重做2026-10-07已实现)。
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
      ③ （已撤）首启故事 IntroScene —— 2026-10-07 移出首启，见 §11.7
      ④ 登录门控 resolveEntry（含「单机试玩」入口）          [已有 SA-3]
      ⑤ ★ 教学关 ch0_tutorial（首次必经，可跳过，§3）       [2026-10-07 重做]
      ⑥ 毕业卡 → 直接进 ch1_lv1（首胜 = 作者信 1000 金币）   [§3.6]
      ⑦ 回战役地图：一行字故事卡（≤3 s，§11.7）
      ⑧ 进大厅：功能首启即开 / 首次使用引导（§4）
```

- **④已实现**：SA-3 登录门控。**故事不再放在首启**：所有平台冷启动直接到合规层 + 登录门控，故事压成战役地图首开时的一张卡，完整 7 行版在设置「重看开场故事」里（§11.7）。
- **⑤**：不复用 `ch1_lv1`，用**专属教学关**（`ch1_lv1` 是正常 survive 关、会失败、波次为平衡服务，承载不了「卡点教学 + 必胜 + 脚本特效」）。完成/跳过后写 `flags.tutorial_done`，再进不弹；设置/帮助里「重看教学」可再进一次。
- **⑥**：新账号毕业后一键进 `ch1_lv1`，不经大厅（大厅主按钮是天梯，新号首局约 50 秒输掉）。重看教学 / 已通关过的账号毕业后回大厅。
- **教学关不计入战役章节进度**：它是独立 id `ch0_tutorial`，不占 ch1 的关卡序号，不影响 `progress`、星数、SLG 解锁判定（§4）。

---

## 3. 专属教学关 `ch0_tutorial`

> **2026-10-07 重做后的版本**。旧版（O1–O7 七张讲解卡 + 动手三拍 + 自由发挥）的问题和数据见 §11.1；本节只写现行设计。
>
> **设计前提**：假定玩家没玩过 lane defense，也**不读字**。所以能用画面说的不用字，任一时刻屏幕上最多一条指令，全程没有「下一步」按钮（验收标准见 §11.2）。

### 3.1 流程

战斗从第 0 tick 就是活的。三拍都是「先动后停」：引擎跑到这一拍的 `setupTick`（这一拍的敌人已经出生、走了一小段），冻结，出一行指令，等玩家把引导卡拖到目标上；放行后引擎接着跑，下一拍的敌人在这一拍的反应还没演完时就到场，拍与拍之间没有空等。

| 引擎 tick（≈秒） | 阶段 | 画面 | 文字（en） |
|---|---|---|---|
| 0 → 45（0–1.5 s） | 开场 | 第 4 道一个红兵朝我方走；两边基地上浮 `YOU`（蓝）/ `ENEMY`（红），2.6 s 起淡出 | — |
| 45 冻结 | Beat 1 | 第 4 道整道高亮；步兵卡外框呼吸 | **Stop it!** Drag this card onto the glowing lane. |
| 放兵后 | 反应 | 两个蓝兵迎上去，约 tick 125 打掉红兵 | *Troops march forward.*（2 s 淡出） |
| 140 冻结 | Beat 2 | 第 7 道 3 个红兵压下来；第 7 道建筑格高亮；箭塔卡呼吸 | **More coming!** Drop the tower on the glowing spot. |
| 放塔后 | 反应 | 箭塔一箭一个 | *Towers hold a lane.* |
| 268 冻结 | Beat 3 | 第 2、3 道 4 个红兵挤成 2×2；敌团上脉冲圈；陨石卡呼吸 | **Meteor!** Drop it on the crowd. |
| 放陨石后 | 反应 | 陨石特效 + 0.35 s 震屏，4 个全倒 | — |
| 场上清空 +0.5 s | 毕业 | HUD 的 WIN 印章 + 胜利音效，0.5 s 后毕业卡弹出（§3.6） | **You win!** Protect your notebook. Break theirs. |

熟练玩家整段引擎时间约 9 s（浏览器实测：进关到 WIN，关内计时器显示 0:09）。

**原 O1–O7 讲的东西去哪了**：O1–O3 我方/敌方/基地/颜色 → `YOU`/`ENEMY` 标签 + 单位本身的颜色；O4 行进方向 → 直接看红兵走过来、蓝兵走出去；O5 车道 → 亮起的那条道；O6 胜负 → 毕业卡那一句；O7 墨与手牌 → 教学关墨给得足、碰不到，不在教学里讲（实战里第一次墨不够时的情境提示是待办，见 §9）。

### 3.2 玩家不动或做错时：分级示范，不代打

| 情况 | 反应 |
|---|---|
| 冻结的第 0 s | 引导卡外框呼吸 + 目标高亮 + 一行指令 |
| Beat 1 第 2 s、Beat 2/3 第 4 s 仍没碰牌 | **幽灵卡**：引导卡的拖拽残影（放大 1.4 倍）带一个蓝色指尖，从手牌槽滑到目标（1.2 s），停 0.6 s，循环；玩家一按住任意手牌就停 |
| 拖错卡、或放到离目标太远的地方 | 卡弹回（无效音效），**立刻**开始播幽灵卡，不等计时 |
| 放到目标附近 | 吸附到目标：兵/塔左右差 1 道以内算对；陨石在最佳 2×2 落点 ±2 格内算对，落点改成那个最佳 2×2 |

判断「对的卡」按**卡牌 id**，不按卡牌类型——兵营也是建筑、加速也是法术，按类型会把它们放过去（旧版就有这个 bug，浏览器里拖兵营能过第二拍）。

**不在空闲时替玩家出牌**：教学要教的就是「拖」；替他放了，下一拍他还是不会。挂机的人看到的是游戏自己在打，像宣传片。审核员的数据也说明问题不是不会操作（Beat 1 不到 3 s 就放下了），是不想读字。

### 3.3 关卡数据

`server/engine/src/campaign/levels/ch0_tutorial.json`，与其它关卡同 schema：

```jsonc
{
  "startInk": 60, "inkRegenMult": 2,          // 墨给足，三张引导卡都出得起
  "enemyScale": { "hp": 0.065, "damage": 1 }, // 红兵（max，190 HP + 2 甲）缩到约 12 HP：一次步兵交锋、一支箭就倒
  "board": { "laneLength": { "2": 8, "3": 8, "4": 10, "7": 13 } }, // 这几道的敌人从棋盘中段出生
  "waves": { "entries": [
    { "atTick": 2,   "unitType": "max", "col": 4, "count": 1 },
    { "atTick": 100, "unitType": "max", "col": 7, "count": 3, "spacingTicks": 20 },
    { "atTick": 230, "unitType": "max", "col": 2, "count": 2, "spacingTicks": 30 },
    { "atTick": 230, "unitType": "max", "col": 3, "count": 2, "spacingTicks": 30 }
  ] }
}
```

这几组数是用无头引擎逐 tick 跑出来定的：

- **敌人每秒只走约 1 格**，满长车道 16 格要走 15 s。旧版红兵在第 16 行出生，第一拍的反应要 7 s 以上，箭塔要等敌人走到第 2 行才够得着。`laneLength` 让这几条道的敌人从中段出生；被截掉的格子画一层很淡的铅笔灰。
- **红兵太硬**：`max` 是 190 HP + 2 甲的坦克兵，箭塔 15 伤 / 1.5 s，打完旧版那 3 个要将近一分钟——旧版全靠基地夹血撑着，玩家看到的是「放了塔也挡不住」。`enemyScale.hp` 0.065 后，一支箭一个。
- **陨石只打 2×2**（`SpellSystem.castMeteor`）：旧版 5 个红兵排成一列，最多砸中 2 个，文案却说「漂亮」。现在 4 个分两道、各 2 个，冻结时正好挤在一个 2×2 里，导演再把落点吸附到覆盖最多敌人的那个 2×2。

`TutorialDrawPolicy` 不变：前三抽确定地给 `infantry_1 → tower_1 → meteor_1`，之后只从其余卡里抽。旧版阶段 C 用的 `enterFreePlay()` 已删除（没有调用方了）。

### 3.4 教学导演（`TutorialDirector`）

- **位置**：`client/src/render/TutorialDirector.ts`（状态机）+ `TutorialDirector/`（`beats.ts` 三拍数据与计时常量、`geometry.ts` 目标点与陨石落点、`panels.ts` 指令条/基地标签/Skip/毕业卡、`types.ts`）。纯表现层：读同步态、控引擎时钟、画 UI，不改战斗状态（唯一例外是 §3.5 的基地夹血）。对出牌只做一件事：把引导卡的落点吸附到目标上，然后照常发 `play_card`，回放与裁判不受影响。
- **接线**：`goTutorial`（`campaignRoster.ts`）把 `TutorialConfig`（毕业按钮文案、奖励预告、`onStep`/`onBeatDone` 埋点回调）经 `GameSceneOptions.tutorial` → `GameRenderer` → `GameRendererCore` 交给导演。`GameRenderer/input.ts` 在落牌时问 `allowCardPlay(cardId, col, row)`，按住/拖动手牌时报 `setHoldingCard`，拖拽结束清掉棋盘高亮时报 `markHighlightDirty`（导演下一帧把目标重新点亮——拖拽和导演的高亮画在同一层）。
- **版面**（§11.5）：指令条在「棋盘顶部」和「手牌正上方」两个位置里，选压住目标、引导卡、Skip 最少的那个。字号按实际显示 ≥ 14 CSS px 算（标题 ≥ 18 px），用 `bake.currentDesignScale()` 反推设计像素——FS 表的地板有上限，在手机上托不到 14 px。Skip 按文字大小画在右上角、贴边；教学关里 HUD 自己的「退出关卡」按钮隐藏（两个退出原本叠在同一个角）。不再用全屏暗化。

### 3.5 永不失败（never-fail）

1. **按构造**：每拍的敌人都弱到一碰就倒，而且走向玩家刚布防的那条道；冻结期间零威胁。
2. **兜底**：导演每帧把 `bottomPlayer.baseHp` 夹在 ≥ 1；毕业前 `GameRenderer` 吞掉引擎的 `game_over/game_draw`，终局只由导演决定。

### 3.6 毕业

- 陨石放行后，等场上敌人清空（最多 2 s）再停 0.5 s → `forceVictory()`：HUD 的 WIN 印章 + 结算音效，**不**自动退场。
- 再 0.5 s 毕业卡以「盖章」的弹性动画弹出：一句目标（*Protect your notebook. Break theirs.*）、一行奖励预告、一个按钮。按钮之外的点击都吃掉，避免误触跳过这一刻。
- **CG 包、非 EU 地区、还没告知过统计的玩家**：按钮下面多一行 ≥14 CSS px 的小字「我们会收集游玩数据用于改进游戏，可随时在设置里关闭」。卡弹出那一刻才放行同意前缓冲里的埋点——「先告知再上传」（COMPLIANCE_GLOBAL §3.3b）。EU 玩家不加这行：他们在大厅被问。
- **新账号**（没写过 `tutorial_done`、`progress.cleared` 为空）：预告「First win: +1,000 coins」，按钮 **Next battle »**，一键进 `ch1_lv1`（记 `level_attempt`、扣入场体力，体力不够就退回准备页）。这 1000 金币就是服务器在首次通关时寄出的作者信（§5.1），数值读同一个常量 `@nw/shared/onboarding` 的 `WELCOME_MAIL_COINS`，不新开金币口子。
- **重看教学 / 已通关的账号**：不预告，按钮 **Continue**，回大厅。
- Skip 任何时候都回大厅（写 `tutorial_done`）。

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

### 4.2 SLG 开局多步引导链

大世界的 §4.1 首次引导（大厅入口那张 `guide.world` 说明卡）只覆盖"点开大世界前"这一刻——2026-08-12 用户反馈：新玩家进了大世界，连自己的主城在哪、要点哪里都不知道。§4.1 的机制（一次性整屏卡片，无地图内高亮）解决不了"在地图上找不到具体点哪"这类空间性问题，因此在其基础上加一条**进图之后**的多步引导链，专门覆盖开局前几步操作：找到主城 → 建造 → 返回 → 占地。

| 步骤 | 触发条件 | 高亮目标 | 完成条件 | 持久化 key |
|---|---|---|---|---|
| step1 | 进入大世界、`me.mainBaseTile` 已知且未见过 | 主城 3×3 footprint（随镜头 pan/zoom 跟随） | 点击主城，或点气泡的跳过 | `guide.world.step1` |
| step2 | 进入 CityScene、step1 已完成且未见过 | 建筑格子网格第一张卡 | 点击任意建筑格/训练格，或跳过 | `guide.world.step2` |
| step3 | step2 已完成且未见过 | 页面头部"返回"按钮 | 点击返回，或跳过 | `guide.world.step3` |
| step4 | 回到大世界、step3 已完成且未见过 | 无固定目标（占地目标因人而异）→ 底部纯文字提示卡，"知道了"按钮 | 点"知道了" | `guide.world.step4` |

- **形式**：呼吸描边高亮环 + 小气泡（自动上/下避让，带跳过角标），画法参考战斗教学关 `TutorialDirector` 的卡片/呼吸环技巧，但重写成独立轻量组件 `client/src/render/GuideOverlay.ts`（不复用 `TutorialDirector` 本体——那是战斗专属，且会拦截全部输入）。**不拦截输入**：高亮只是视觉提示，玩家仍可随时点地图上任何东西，完全符合 §4.1 "轻提示…不阻断玩家用功能" 的既定原则；每步也都能跳过。
- **持久化**：四个 key 都是普通 `SaveData.flags` 布尔值（`guide.world.step{1..4}`），复用 `SaveManager.getFlag/setFlag` 现有通道，**未改 `SaveData` schema、未改服务端**。
- **与 §4.1 的关系**：两层独立生效——大厅入口卡片（`guide.world.title/body`，文案已改为提到"点击你的主城"）先给一句话预期，进图后这条链再给具体的空间指引；互不依赖，任一层被跳过不影响另一层。
- **接线要点**：WorldMapScene 侧（step1/step4）状态挂在 `WorldMapContext.guideStep` + 每帧在 `WorldMapRendererLifecycle.update()` 里现算主城屏幕坐标；CityScene 侧（step2/step3）因为 `render()` 每次全量 `tearDownChildren` 重建，引导层挂在一个从不被清空的独立 sibling container（`CityScene.ts` 构造函数里 `guide.root` 单独 addChild，不进 `core.container`）。

---

## 5. 首胜 / 回访钩子（与 RETENTION 对齐）

教学关毕业即首胜，要埋下"明天回来"的理由，但**不新增金币龙头**（ADR-011）：

- 教学关首胜即时奖励（一次性，软通货为主）。
- 首胜后**引出每日签到 / 每日任务入口**（机制权威归 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)），让玩家看到"明天有东西拿"。
- D0 结束温和提示「去打第一章 / 明日签到」，不强推。

### 5.1 作者欢迎邮件（打破第四面墙，一次性）

- **触发**：玩家生涯**首次真正通关一关**（`progress.cleared` 从空到非空，即 `pveClear` 结算前 `cur.progress.cleared.length === 0`）。教学关 `ch0_tutorial` 不计入 `progress`（§2），所以对正常 FTUE 路径而言，这封信会在**教学关之后、通关 `ch1_lv1` 时**首次触发，不是教学关本身。
- **内容与身份**：以真实作者「涛」的第一人称写一封短信——感谢玩家体验《Notebook Wars》、探索这个故事，欢迎任何反馈与交流，可回邮箱 `tao@gamestao.com`，也可以在大厅「反馈」页面留言（两条渠道并列给出，方便玩家挑顺手的用）。这封信是**打破第四面墙**的手法（呼应世界观：叙事里「涛」本身也是这个游戏的作者，见 [`../product/world.md`](../product/world.md) 尾声），不与战役剧情文案（[`CAMPAIGN_STORY.md`](CAMPAIGN_STORY.md)）混同——邮件文案权威在本节，不进 CAMPAIGN_STORY。
- **机制**：复用现有系统邮件通道（[`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md) §3.3），走 metaserver 内部 `insertSystemMail` 直调（同进程，不经 HTTP），dispatchKey 固定 `welcome.author`（`${dispatchKey}:${accountId}` 幂等，客户端重试/多端不会重复发信）。**最佳努力（best-effort）**：发信失败只记日志，不阻塞关卡结算响应，也不影响材料/卡牌/成就等正常发奖。
- **附件**：金币 ×1000（一次性 faucet，数字见 [`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md) §2.4 同级别一次性奖励口径），`expireDays: 30`（超时未领与其它系统邮件一致过期）。
- **与反馈入口解耦**：这封信与「游戏内反馈入口」（[`UI_DESIGN.md`](UI_DESIGN.md) 大厅入口一节）在**触发机制**上是两件独立的事——反馈入口常驻可用，不依赖玩家是否读过/领取过这封信；但信的**文案**里会顺带指路到反馈页面，作为邮箱之外的备选联系渠道。
- **i18n key**：`mail.welcome.author.subject` / `mail.welcome.author.body`，全语种（zh/en/de）。
- **测试覆盖**（用户要求"全部加测试"后追加，2026-08-05）：`test/pve.e2e.test.ts` 原有首触发+幂等去重+`mail_new` 推送一例；新增一例覆盖 best-effort 路径本身——`socialsvc.insertSystemMail` 抛异常（`ThrowingSocialsvc`）时结算仍正常返回材料奖励+写入 `progress.cleared`，不被邮件失败连坐（断言时特意让 `gateway.available=false`，避免撞上 L1 spot-check 对"生涯首次通关"必定触发复核的既有规则，见 `PVE_INTEGRITY_PLAN.md`/`pveRewards.ts shouldSpotCheck`）。

---

## 6. 合规挂钩（开机第一步，**不属于新手引导**）

> 关键修订：年龄门 / 采集同意是**冷启动后、进入任何 FTUE 之前**的强制开机步骤，权威归 [`COMPLIANCE_GLOBAL.md`](COMPLIANCE_GLOBAL.md) / [`COMPLIANCE_CN.md`](COMPLIANCE_CN.md)。本文只约束它与 FTUE 的**先后顺序**，不拥有其内容。

1. **年龄声明门**：首启、neutral age gate（不诱导），结果影响分级/COPPA。
2. **EU/UK 采集同意**：按地区粗判，**在任何埋点采集之前**弹。
3. 年龄门 + 同意状态持久化进 `flags`，不重复弹。

> 顺序铁律：**合规（年龄/同意）→ 才开始埋点采集 → 才进教学关**。否则首启漏斗事件本身就违规。教学可跳过、合规不可跳过——两类门要明确区分。
>
> **CrazyGames 例外（2026-10-07）**：门户要求「进来就玩，最多点一下」，并建议隐私/条款做成不挡人的通知。所以 CG 包**开机不设门**：年龄门不弹（门户本身限 13+，与我们的 `MIN_AGE_YEARS` 相同），条款改成大厅里的一条通知，分析同意在需要选择的地区改成不挡人的询问，回答之前事件只留在内存里。顺序铁律仍然成立——没同意之前没有任何带身份的事件离开设备。权威见 [`COMPLIANCE_GLOBAL.md` §3.3a](COMPLIANCE_GLOBAL.md)。

---

## 7. 漏斗埋点（字段权威归 ANALYTICS）

每个关键节点打点，用于诊断流失。**事件字段定义归 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md)**，本文只列**该埋哪些节点**：

`首启 → 合规通过（年龄/同意）→ intro 完成/跳过 → 登录方式（试玩/匿名/正式）→ 教学关开始 → 教学各 beat 完成/卡住时长/跳过 → 教学毕业（首胜）→ 首胜领奖 → 各功能首次引导 弹出/关闭/再看 → 次日回访`。

> 采集受 §6 同意门控；EU/UK 未同意则不采上述行为事件。教学**逐 beat 的完成率与卡住时长**是迭代脚本的核心数据。

> **逐节点核实（design-doc-audit-2026-07，对照代码）**：
> - ✅ **首启/合规通过**：`session_start`（标准）、`gdpr_consent`（`createAppCore.ts`）。
> - ✅ **intro 完成/跳过**：`intro_complete`/`intro_skip`（`app/nav/auth.ts` `goIntro()` 的 `onFinish(skipped)`），100% 采样，已纳入 `ANALYTICS_DESIGN.md` §9.6 `ONBOARDING_STEPS` 的 `intro_seen` 步骤——**本行此前记「`IntroScene.ts` 无埋点」已补齐（同一批次修复）**。
> - ❌ **登录方式（试玩/匿名/正式）**：未找到区分登录方式的专属事件；`login_gate_hit` 只在已登录会话触发游客态跳转时打点（`nav/social.ts`/`nav/world.ts`），不是登录方式选择本身。优先级较低，暂不强制。
> - ✅ **教学关开始/教学各 beat/教学毕业**：`tutorial_start`/`tutorial_step`（`step_key`=`beat_unit`/`beat_building`/`beat_spell`/`graduate`，2026-10-07 前还有 `orientation_1..7`/`freeplay`）/`tutorial_beat_done`（每拍的空闲时长、是否放过幽灵卡、拖错次数）/`tutorial_complete`/`tutorial_skip` 全部已接（A9-9，`TutorialDirector.ts`→`GameRenderer`→`game.ts#goTutorial()`），100% 采样，`GET /internal/query?type=tutorial_funnel` 可查——**此前 §8/§9 把这条记成"待补"是过期记录，已订正**。
> - 🟡 **首胜领奖**：无独立事件，靠 `tutorial_complete`（毕业=首胜）代打，够用但没有单独区分"完成教学"与"实际领到奖励"两个时刻。
> - 🟡 **各功能首次引导 弹出/关闭/再看**：`feature_guide_shown`/`feature_guide_closed{feature}` 已接（`LobbyScene/overlays.ts`+`app/nav/lobby.ts` 的 `withGuide`），100% 采样，`GET /internal/query?type=feature_guide_funnel` 可查。**「再看」`feature_guide_replay` 事件名/采样已预留，但客户端尚无调用点**——见 §8/§10「各子页内「?」按钮未逐页接」，仍是独立待办。
> - ✅ **次日回访**：`session_start` 时间序列做 D1 cohort（`ANALYTICS_DESIGN.md` §9.5），不需要专属事件。
>
> intro 完成/跳过 + 功能首次引导弹出/关闭两处事件已补齐（design-doc-audit-2026-07 后续跟进，见 `ANALYTICS_DESIGN.md` §12.5）；「再看」事件与登录方式节点仍待后续接入（登录方式优先级较低，暂不强制）。

---

## 8. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| 开场故事 | ✅ 2026-10-07 移出首启：战役地图首开一行字卡 + 设置「重看开场故事」（§11.7） |
| 登录门控 + 单机试玩 | ✅ 已有（SA-3） |
| 关卡数据结构 / WaveDirector（脚本波次、固定种子） | ✅ 已有（`@nw/engine campaign/`），教学关复用，无需改 schema |
| **教学关 `ch0_tutorial` JSON**（满 loadout） | ✅ 已建。`server/engine/src/campaign/levels/ch0_tutorial.json`（2026-09-26 前在 `client/src/game/campaign/levels/`），仅入 `CAMPAIGN_LEVELS` 不入 `CAMPAIGN_LEVEL_ORDER`（不计进度） |
| **TutorialDirector（三拍先动后停 + 幽灵卡示范 + 拖错反馈 + 落点吸附 + 毕业卡）** | ✅ 2026-10-07 重做（§3.4）。`client/src/render/TutorialDirector.ts` + `TutorialDirector/` |
| **TutorialDrawPolicy（保证引导卡按拍到手，确定性纯引擎）** | ✅ 已建。`@nw/engine Card.ts`，`GameEngine` 据 `id===ch0_tutorial` 注入（`enterFreePlay()` 随阶段 C 一起删了） |
| `flags.tutorial_done` + 「重看教学」 | ✅ 已加。`tutorial_done` 门控；设置「帮助 → 重看新手教学」重跑。**`SaveData.flags.tutorial_step` 断点续教未做**（见 §10——⚠️ 与下面「FTUE 漏斗埋点」行提到的 `tutorial_step` **同名不同物**：这里指存档断点续教字段，未建；那里指 analyticsvc 的 `tutorial_step` 埋点事件，已建，两者互不影响，勿混淆） |
| 教学关永不失败兜底（基地不可破） | ✅ 已建。导演每 tick 夹 `baseHp≥1` + GameRenderer 未毕业时吞 `game_over/game_draw`（导演独占终局） |
| SLG 软门槛（通 ch1 解锁）+ 灰显气泡 | ✅ 已接。`progress.isFirstChapterCleared` + 大厅 `worldLocked` 灰显 + `showInfoToast`「通关第一章解锁」 |
| **首次功能引导机制（`flags.featSeen.*`）** | ✅ 机制已建。`SaveManager.featSeen/markFeatSeen` + 大厅 `showFeatureGuide` + `withGuide`（match/shop/social/cards/daily/world）+ `guide.*` 全语种 + `feature_guide_shown/closed` 埋点（design-doc-audit-2026-07 补齐，见 §7）。**各子页内「?」按钮未逐页接**（见 §10），因此 `feature_guide_replay` 事件暂无调用点 |
| **SLG 开局多步引导链（§4.2，2026-08-12）** | ✅ 已建。新组件 `client/src/render/GuideOverlay.ts`（呼吸高亮环+气泡，不拦截输入）+ `guide.world.step{1..4}` flags + WorldMapScene/CityScene 接线；无独立埋点（复用已有 `feature_guide_*`/`screen_view` 口径即可回答"引导链有没有被看到"，未单独加 per-step 埋点，若后续要看逐步流失率再补） |
| 首胜奖励 + 签到入口引出 | ✅ 毕业卡预告「首胜 +1000」并一键进 `ch1_lv1`（§3.6），金币是既有作者信；签到由大厅红点承载 |
| 年龄门 + EU/UK 同意弹窗 | ✅ 已建（合规，归 COMPLIANCE，开机层）：年龄 + 同意 + 使用条款合成一屏 `EntryGateDialog`，`createAppCore.ts` `gateConsent` 驱动。第一屏的体验问题见 §11.8 |
| **作者欢迎邮件**（首次真正通关+1000金币，§5.1） | ✅ 已建（`server/metaserver/src/service/pve.ts` `pveClear`，e2e `test/pve.e2e.test.ts`） |
| FTUE 漏斗埋点 | ✅ 已接（design-doc-audit-2026-07 核实：本行与 §9 待办条目此前是过期记录——A9-9 早已落地逐 beat 埋点 `tutorial_step`，`step_key` 覆盖 `tutorial_start→beat_unit→beat_building→beat_spell→graduate→tutorial_complete`（2026-10-07 起；`orientation_*`/`freeplay` 退役），`TutorialDirector.ts`→`GameRenderer`→`game.ts#goTutorial()`→`analytics.track()`；100% 采样，`GET /internal/query?type=tutorial_funnel` 可查逐步转化率，字段权威见 `ANALYTICS_DESIGN.md` §9.9/§9.6。仅剩 §7 提到的「登录方式/首次功能引导 弹出关闭再看/次日回访」几个漏斗节点是否全部接齐未逐项复核，非本次审计范围） |

---

## 9. 待办（开发顺序）

1. ✅ **教学关 `ch0_tutorial.json`** + **TutorialDirector** + **TutorialDrawPolicy** + `flags.tutorial_done` + 跳过/重看。2026-10-07 按 §11 重做成三拍先动后停 + 幽灵卡 + 毕业卡（§3）。
2. ✅ **首次功能引导机制**：`flags.featSeen.*` + `guide.*` i18n（各子页内「?」按钮待逐页接，§10）。
3. ✅ **SLG 软门槛**：解锁阈值（`isFirstChapterCleared`）+ 大厅 SLG 入口灰显气泡（通 ch1 点亮）。
4. **首胜钩子**：
   - ✅ **结算页「明天回来」预览**（2026-09-23，RETENTION_LAUNCH_PLAN.md §3.3）：`ResultScene` 在「赢 + 本月签到还一天没领」时画一行签到奖励预览（图标+数量+「Day N 签到」文案），复用既有 `CHECKIN_REWARDS`/`RetentionView`，不新增经济。**范围收窄**：不是字面意义的「教学毕业」——`goTutorial` 的胜利分支直接进大厅、从不经过 `ResultScene`（见 `campaignRoster.ts` `onGameEnd`），真正的「首个真实结算页」是新手打完 `ch1_lv1` 之后。用「本月还没签到过」这个更宽松、更健壮的信号代替「字面上的第一场胜利」，覆盖新手无论先玩哪个模式赢下第一局的情况，也避免为了精确定位"首胜"去改教学关的导航（风险更大、收益不明显）。
   - ✅ 教学毕业本身（2026-10-07）：毕业卡预告首胜作者信 1000 金币，一键进 `ch1_lv1`（§3.6）。
5. **合规开机层**（年龄门 + EU/UK 同意，与 COMPLIANCE 联动，海外测试前必须）。
6. ~~FTUE 漏斗埋点接入~~ ✅ 已完成（`tutorial_start/complete/skip` + 逐 beat `tutorial_step` 全部已埋，见 §8「FTUE 漏斗埋点」行——design-doc-audit-2026-07 核实此条目此前是过期记录）。
7. 依教学完成率与 D1 数据迭代 beat 脚本与提示文案。数据：`tutorial_step` 逐拍漏斗 + `tutorial_beat_done`（空闲时长/幽灵卡/拖错）+ 未同意玩家的匿名逐拍计数（ANALYTICS_DESIGN §3.6d）。
9. ✅ **墨不够的情境提示**（原 O7 的内容，§3.1；2026-10-07 实现）。实战里玩家第一次按到墨不够的牌（拖或点选都算）时，在手牌上方弹一个深色气泡「Not enough ink yet — it refills over time.」，停 3 秒、最后 0.5 秒淡出，不暂停战斗。只弹一次：存档 flag `hint.ink`（`appConstants.ts` 的 `inkHintGate` 第一次 `claim()` 时写入并放行，之后一律拒绝）。PvE（vs AI、战役）和联机对局都接了，教学关里不弹，因为教学关有自己的引导。实现见 `render/GameRenderer/inkHint.ts`、`GameRenderer/input.ts` `rejectPlay`，测试见 `test/ui/reviewAuditFixes.ui.ts`。
8. ✅ **SLG 开局多步引导链**（§4.2，2026-08-12，用户反馈"进大世界不知道点主城"后新增）：主城→建造→返回→占地四步高亮，`GuideOverlay` 组件 + `guide.world.step{1..4}` flags。

---

## 10. 实现记录（2026-06-27）

> 下面是 v1 教学关的实现记录。导演时钟模型、阶段 A/C、`enterFreePlay()` 已被 2026-10-07 的重做取代（§3、§11），保留作历史。

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

---

## 11. v2：第一分钟重做（2026-10-07，已实现）

> 状态：**已实现**（分支 `feat/onboarding-first-minute`）。现行设计已并回 §2/§3；本节保留当时的依据、验收标准和拍板记录。

### 11.1 为什么重做：审核员的 57 秒

CrazyGames 2026-10-07 以「overall quality does not yet meet the expectations of our platform」拒稿。后台（analyticsvc `events` + metaserver `accounts`）查到拒稿前**唯一的外部访客**是门户 QA 号，完整轨迹见 [`CRAZYGAMES_LAUNCH.md` §7](CRAZYGAMES_LAUNCH.md)：

| 相对时间 | 事件 |
|---|---|
| 0 s | `session_start`，0.3 s 后 `tutorial_start`（CG 包跳过开场故事，过完同意页直接进教学关） |
| 0 → 44.5 s | 停在 O1「This is your side」 |
| 44.8 → 46.0 s | **O2–O7 六张卡 1.2 秒内连点过去**，每张约 0.2 s |
| 46.0 s | 进 Beat 1 放兵，约 2.7 s 就放下了 |
| 52.7 s | 进 Beat 2「Build a defense」。中间约 4 s 是在等引擎跑到 `gateTick 120` |
| 55.6 s | 关页（`churn_signal explicit_exit`） |

读出来的东西：

- **讲解型文字卡没人读。**加「5 秒自动前进」只会让人多等：他点完六张只用了 1.2 s，自动前进反而要 30 s。web 首启的 `IntroScene` 本来就是「每行 5 秒自动前进」（7 行），说明自动前进解决不了「不想读字」。
- **拖卡这个操作不难。**第一拍不到 3 s 就完成了，所以问题不在操作，在节奏和信息密度。
- **拍与拍之间有空等。**放行后要等到 `gateTick` 才出下一拍，玩家只能干看着。
- CrazyGames 给 Basic 的参考指标里有一条「玩满 1 分钟的转化 80% 以上」（CRAZYGAMES_LAUNCH §6 末尾），而审核员恰好没撑过第 60 秒。

### 11.2 验收标准

1. 教学开始后 **≤ 1.5 s** 画面上就有东西在动，**≤ 3 s** 出现第一个要玩家做的操作。
2. **全程 0 个「Next」**，没有任何要点掉才能继续的文字卡。
3. 任一时刻屏幕上**最多一条指令**：标题 ≤ 4 个词，正文 ≤ 10 个词（按英文算）。
4. **能用画面表达的就不用字。**
5. 引擎只在「等玩家出这张牌」的那一刻冻结，而且冻结前先让敌人动起来（**先动后停**）。
6. **拍与拍之间不空等**：上一拍的反应结束后 ≤ 1.5 s 出下一拍。
7. **不替玩家操作**：玩家不动只会看到越来越明显的示范，最后那一下必须玩家自己拖（§11.4）。
8. **有收尾**：最后一下（陨石）要爽，紧接着胜利 + 奖励的时刻，然后才离开教学。
9. 熟练玩家 30 s 内能打完，纯新手 ≤ 75 s。

### 11.3–11.6 流程、空闲示范、版面、毕业

已按提案实现，现行设计并回 §3：流程 §3.1，空闲示范与拖错 §3.2，版面规则 §3.4，毕业 §3.6。实现时和提案不一样的地方：

- **时间轴是跑出来的，不是估的。** 提案假设「红兵走到 1/3 处」只要 1.5 s，实际敌人每秒只走 1 格、满长车道要 15 s；而且红兵（`max`）190 HP + 2 甲，箭塔要将近一分钟才打完旧版那 3 个，陨石的 2×2 范围也盖不住一列 5 个。所以关卡改了 `laneLength`、`enemyScale.hp` 和波次站位（§3.3），提案里「本拍反应波全灭才进下一拍」的门也换成了「下一拍的敌人在这一拍的反应还没演完时就到场」——拍间空档实测 ≤ 0.5 s。
- **Beat 3 是 4 个敌人**，不是 5 个：同一条道里单位按碰撞体积排队，一列最多 2 个落在 2×2 里，所以两道各 2 个。
- **落点吸附**：提案没写。兵/塔差 1 道、陨石差 2 格以内，都吸到目标上，避免「差一格就被判错」。
- **按卡牌 id 判对错**：浏览器实测发现兵营（也是建筑）能过第二拍——旧代码就按类型判，一起修了。
- **毕业页**做成战斗场景里的一张卡（WIN 印章下方），没有新开场景，也没复用 `ResultScene`。
- **Skip** 按文字大小画、贴右上角；教学关隐藏 HUD 自己的「退出关卡」（两个退出叠在一起）。

### 11.7 故事放在哪

**现状：**

- web 和微信首启时，`IntroScene` 排在**同意页之前**：7 行字，每行 5 秒自动前进，最后一行要点一下才走。玩家要先看大约 35 秒文字才见到同意页，之后才是教学关。
- CG 包已经用 `skipStoryIntro` 跳过了这一段。
- `ch1_lv1` 的准备页有一大段叙事散文，开打前还有一层黑屏剧情（`level.story.introKey`）。

**三种做法：**

| 做法 | 评价 |
|---|---|
| 删掉 | 世界观和作者那封邮件（§5.1）都靠故事撑着，删掉可惜 |
| 压到 3 秒、放在首启 | 仍然是「玩之前先看」，只是看得短一些 |
| **往后放 + 压缩（推荐）** | 首启所有平台都像 CG 一样不播 `IntroScene`；故事挪到**第一次打开战役地图**时，压成 1 张插画 + 1 行字，≤ 3 s，点一下就过；完整的 7 行版放进「重看故事」入口 |

另外，`ch1_lv1` 准备页去掉大段叙事，只留关卡名和「开始」；开打前的黑屏 intro 改到赢之后再放（并进 outro）。文案本身的权威仍在 [`CAMPAIGN_STORY.md`](CAMPAIGN_STORY.md)，本文只管放在哪、放多长。

**已实现（2026-10-07）：**

- **首启**：`createAppCore.start()` 不再分支，所有平台直接 `gateConsent(() => resolveEntry())`。`IPlatform.skipStoryIntro` 随之删除。
- **压缩版**：第一次打开战役地图时，`CampaignMapScene` 在地图上盖一张卡（`scenes/CampaignMapScene/storyCard.ts`）：插画复用 `assets/story/intro_notebook.png`，文字一行 `story.card`（zh/en/de）。0.35 s 淡入，2.65 s 起自动淡出，3.0 s 消失；点任意处立即淡出，这一下点击被卡吃掉，不会穿透去选关。是否出卡由 `goCampaignMap` 的 `getStoryCard()` 按 `flags.seen_intro`（`SEEN_INTRO_FLAG`）决定，在场景构造时问，所以关掉之后 resize 重建不会再出。旗子沿用旧的 `seen_intro`：看过旧版首启故事的老存档不会再看到卡。新玩家多半是打完 `ch1_lv1` 回地图时才第一次看到，所以文案写成「你在打的是谁画的世界」，不写成「故事开始了」。
- **埋点**：`intro_complete`（自动消失）/ `intro_skip`（点掉）改由这张卡发出，「重看开场故事」不发。analyticsvc `ONBOARDING_STEPS` 的 `intro_seen` 从第 2 步挪到最后一步（`first_clear` 之后），否则它会在漏斗第 2 步造成一个假的断崖。
- **重看**：设置 → 帮助 →「重看开场故事」（`settings.replayStory`）播完整 7 行 `IntroScene`，结束或跳过后回到设置页。`nav.goIntro(onDone)` 只剩这一个调用方。
- **`ch1_lv1`**：只改关卡 JSON，代码不针对关卡 id 做特判。删 `briefKey`，准备页就没有那段散文；`story.introKey: campaign.ch1.intro` 改成 `story.outroKey`，开战前不再有黑屏，赢了之后在结算页的 outro 里播。`LevelPrepScene` 的通用 brief 和 intro 逻辑原样保留，其它关卡的简报不受影响。`client/test/levelSchema.test.ts` 把这两条例外写死。

### 11.8 同意页（权威不在本文，列为同一批）

CG 包第一屏原来是年龄 + 同意 + 使用条款合成的一屏 `EntryGateDialog`。审计记录它是「一整页法律文字 + 出生年份步进器」。

**核实结果（2026-10-07，CrazyGames 官方开发文档）**：

- 门户**没有**替游戏收我们自己的分析同意：它的 CMP 只管它自己的广告和 cookie，SDK 也不暴露任何同意/年龄状态（`user` / `systemInfo` 里只有国家、语言、设备）。
- 但门户明确要求「新玩家直接进游戏，做不到的话最多点一下」，并建议隐私/条款做成**简单通知**而不是挡人的弹窗；门户受众限 13 岁以上，等于我们的 `MIN_AGE_YEARS`。

**已实现**：CG 包开机不设门（年龄门跳过、条款改大厅通知条、需要选择的地区改成不挡人的分析询问，回答前事件只在内存里，另有不带任何标识的逐拍匿名计数）；其它平台保留合成一屏，但文字压短、出生年份改成两下点选（先选年代再选年份）。依据、地区逻辑和取舍见 [`COMPLIANCE_GLOBAL.md` §3.3a](COMPLIANCE_GLOBAL.md)。

### 11.9 埋点

全部已实现：

- **新的 `step_key` 序列**：`tutorial_start → beat_unit → beat_building → beat_spell → graduate → tutorial_complete`。`orientation_*` 和 `freeplay` 退役（analyticsvc `TUTORIAL_ORDERED_KEYS` 已改，旧事件不再匹配任何一步）。
- **每拍完成时**发 `tutorial_beat_done { beat, idle_ms, ghost_shown, wrong_drops }`（100% 采样）。
- **未同意玩家的匿名逐拍计数**：同一组 step，只带平台和步骤名，不带任何标识（ANALYTICS_DESIGN §3.6d）。下一位审核员如果在欧盟没点同意，也能看到他走到哪一拍。
- **同意停留时长**：`gdpr_consent` 加 `dwell_ms` 和 `mode`（`gate` / `notice` / `prompt`），只在「同意」这条路上带。
- **补洞（根因已查明）**：和 SSO 无关。`analytics.init()` 先建好事件队列，再去拉采样配置；配置回来之前 `shouldTrack()` 用的是「禁用」兜底，于是这段时间里的事件——包括同意那一刻重放的 `boot`/`first_frame`/`load_time` 和紧接着的 `gdpr_consent`——全被丢掉。QA 一秒内就点了同意，正好落在这个窗口里；配置回来后 `init()` 才发 `session_start`，所以会话从 `session_start` 开始。存档里的同意标记走的是另一条路（flag 同步），所以是 true。修法：配置回来之前不开放队列，事件一律缓冲（`client/test/analyticsConfigRace.test.ts` 复现了旧行为）。

### 11.10 改动面（实际）

| 位置 | 改了什么 |
|---|---|
| `client/src/render/TutorialDirector.ts` + `TutorialDirector/{beats,geometry,panels,types}.ts` | 重写（§3.4） |
| `client/src/render/GameRenderer/{core,input}.ts`、`GameRenderer.ts`、`scenes/GameScene.ts`、`ReplayScene.ts` | `tutorial` 选项从 boolean 换成 `TutorialConfig`；落牌吸附、按住手牌/清高亮回报；毕业拆成「WIN」和「离开」两步；教学关隐藏 HUD 退出按钮 |
| `client/src/render/bake.ts` | `currentDesignScale()`，给教学字号反推设计像素 |
| `client/src/app/nav/game/campaignRoster.ts` | `goTutorial`：毕业文案/预告、埋点回调、毕业直进 `ch1_lv1` |
| `server/engine/src/campaign/levels/ch0_tutorial.json` | 波次、`laneLength`、`enemyScale`（§3.3） |
| `server/engine/src/Card.ts` | 删 `TutorialDrawPolicy.enterFreePlay()` |
| `server/shared/src/onboarding.ts`（新）+ 客户端别名 `@nw/shared/onboarding` | `WELCOME_MAIL_COINS`，metaserver 发信与毕业卡预告共用 |
| i18n `en/de/zh` | 删 `tutorial.o1–o7`/`next`/`complete`/`free.*`/`beat1–3.*`，加 `tutorial.you/enemy/b1–b3/grad.*` |
| analyticsvc `defs.ts` / `eventConfig.ts`，ops `analytics.ts` | 新 step 序列、`tutorial_beat_done`、步骤标签 |
| 故事（§11.7）、同意页（§11.8）、埋点补洞（§11.9） | 见各节 |

`@nw/engine` 的模拟逻辑没动；`enterFreePlay()` 删除前后，不调用它时行为完全一样。

### 11.11 拍板记录（2026-10-07，用户：「都按你的建议来」）

1. 毕业后去哪 → **直接进 `ch1_lv1`**（新账号）；重看/已通关回大厅。
2. 毕业奖励 → **不开新的金币口子**，预告首次通关本来就会寄出的作者信 1000 金币（§3.6）。
3. 故事 → **往后放 + 压缩**（§11.7）。
4. 阶段 C 自由发挥 → **取消**。
5. CG 同意弹窗 → 核实门户不替我们收分析同意，但要求进门即玩 → **CG 包开机不设门**（§11.8）。
