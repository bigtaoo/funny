# PvP 构筑卡组 + 按段位解锁单位

版本：v0.1（设计稿，待实现）
日期：2026-06-30
状态：设计中

> **一句话**：把现有 6 个 PvE-only 单位（ironclad/runner/harpy/medic/berserker/splitter）复用为 PvP 可出单位，按天梯段位解锁；同时把 PvP 从「全池随机发牌」升级为「固定卡组构筑」（Clash Royale 式）。动机：美术资源紧张，单为 PvE 投入单位回报减半，复用后将来补 `.tao` 一次投入两个模式都吃到。

> **权威边界**：本文是「PvP 卡组构筑 + 单位解锁机制」的权威来源。单位数值仍以 `@nw/engine`（`server/engine/src/config.ts` `UNIT_BLUEPRINTS`）为准，本文只登记 PvP 专属 override 的意图；段位阈值以 `server/shared/src/ladder.ts` `RANK_TIERS` 为准；赛季/段位机制归 [SEASON_DESIGN.md](SEASON_DESIGN.md)。

---

## 1. 现状盘点（实现前的事实）

| 维度 | 现状 | 出处 |
|---|---|---|
| PvP 抽牌池 | 默认吃**全量** `CARD_DEFINITIONS`，无 loadout、无构筑 | `Card.ts:20`、`GameEngine.ts:303` |
| loadout 管线 | 已有，仅 PvE 用：`loadout?: string[]` 白名单过滤 `CARD_DEFINITIONS` | `LevelDefinition.ts:54-55`、`GameEngine.ts:259-305` |
| 6 个 PvE 单位 | 蓝图齐全且已调过数值，但**无 `CARD_DEFINITIONS` 条目**（不可出牌），渲染走程序火柴人（无 `.tao`） | `config.ts:182-265` |
| PvP 专属蓝图 | 已有 `buildPvpBlueprints()`（去升级/装备/等级），是 PvP 数值 override 的落点 | `GameEngine.ts:136-141` |
| 锁步牌池一致性 | 双方**各自本地**用同一 seed 构造，因为牌池全量相同；ticket / `match_start` **不带 loadout** | `Room.ts:169-179`、`Matchsvc.ts:365-376` |
| 引擎抽牌策略 | 自定义路径**只给 `bottomPlayer`** 绑 drawPolicy（PvE 对面是 AI/波次，不抽牌） | `GameEngine.ts:301-303` |
| ELO/段位 | 服务端权威，存 Mongo `SaveData.pvp.elo`；排队时 gateway 拿得到 | `types.ts:62-72`、`Gateway.ts:411`、`internal.ts:101-111` |
| 段位阈值 | bronze0/silver1100/gold1200/platinum1350/**diamond1500**/star1700/master1900/grandmaster2100/**king2400** | `ladder.ts:17-28` |
| 手牌常量 | `HAND_SIZE = 6` | `config.ts:105` |

---

## 2. 三项拍板（已定）

1. **卡组模型 = 固定 N 张构筑（Clash Royale 式）**。开局前自选一套固定卡组，对局只从这套抽牌。这是 meta 级改动，取代现有「全池随机」。
2. **解锁门槛对齐段位**：`diamond`(ELO≥1500) 解锁第一档 3 个，`king`(ELO≥2400) 解锁第二档 3 个。
3. **Harpy / Medic 直接上**，靠 PvP 专属 override 兜平衡：
   - **Harpy**：保留飞行，但**抬高费用**——飞行无解的代价是高费，高费下即使对方手里没有解也不亏。
   - **Medic**：PvP 里**加一点小攻击**（不再是纯 0 攻击的呆牌）；若光环过强，再加限制（降 hps / 缩半径 / 设治疗上限）。

---

## 3. 解锁档位与单位分配

| 档位 | 段位门槛（ELO） | 解锁单位 | 选择理由 |
|---|---|---|---|
| **第一档** | diamond ≥ 1500 | Runner / Berserker / Ironclad | 三个数值能直接用、无需改造的「干净」单位 |
| **第二档** | king ≥ 2400 | Splitter / Harpy / Medic | 需 PvP 专属 override，且更吃操作，放高段 |

> **可调点**：diamond(1500)→king(2400) 之间隔 900 ELO（中间还有 star/master/grandmaster 三段），跨度偏大。若想更平滑，可拆成 diamond(1500)/grandmaster(2100)/king(2400) 三档每档 2 个。**默认按拍板的 diamond/king 两档**，三档方案列为备选。

> **不降级**：解锁是「曾达到过」还是「当前分数」？建议**按当前赛季峰值 `seasonPeakElo`**（`types.ts:71`）判定，避免软重置后掉段就锁卡、玩家体验割裂。赛季重置时随峰值重置。

---

## 4. 卡组构筑规则

| 项 | 设计值 | 说明 |
|---|---|---|
| 可选库 | 基础 10 种（infantry/shieldbearer/archer/max/lena/mara + barracks/tower/haste/meteor）**＋** 已解锁的 0/3/6 个新单位 | max/lena/mara 是否仍需 PvE 解锁见 §7 遗留 |
| 卡组大小 | **建议 10 张**（`HAND_SIZE=6`，卡组需明显大于手牌留出循环与构筑取舍；待 `difficultySim` 验证 8 vs 10 vs 12） | 含建筑/法术；每种最多带 1 张（去掉现有 `_1/_2` 重复条目带来的同卡叠抽） |
| 默认卡组 | 新玩家给一套预设（现有 6 基础单位思路），未自定义直接用 | 降低上手门槛 |
| 法术/建筑 | 同样纳入可选库，玩家自行取舍 | — |

> **重大影响提示**：从「全池 18 条随机」改为「玩家选 10 张构筑」会**重写现有 PvP 平衡**（抽牌概率、节奏、克制关系全变）。BALANCE.md / difficultySim 需重跑。这是本方案最大的非美术工作量。

---

## 5. 数值：6 单位 PvP 化（提案，待 difficultySim 验证）

费用与现有锚点对齐（infantry4/archer5/shieldbearer6/max5/mara5/lena7/haste8/meteor12）。

| 单位 | 蓝图要点 | 提案费用 | PvP override |
|---|---|---|---|
| Runner | hp30 快脆冲锋 | 3 | 单张偏弱，考虑 `spawnCount` 提到 2~3 形成 swarm，否则降到 2 费 |
| Berserker | hp110 atk18 残血狂暴 | 6 | 无需改 |
| Ironclad | hp290 armor3 抗箭重甲 | 8 | 无需改 |
| Splitter | hp65 死亡裂 2 Runner | 4 | 无需改（对 AOE 是正反馈，PvP 有趣） |
| **Harpy** | hp26 飞行 `canTargetFlying:false` | **7（高费）** | 保留飞行；高费即护栏。**复核**：确认双方可选库里**永远有**能打飞行的牌（archer/tower）——否则补一条「箭塔/弓手必入或保底可解」规则 |
| **Medic** | hp90 atk0 光环奶 hps8 | **6** | `buildPvpBlueprints` 里给 PvP-Medic：attack≈4 / interval1.2 / range1；光环 hps 降到 5~6、radius 1.5；如仍过强加单位治疗上限 |

> override 落点：`buildPvpBlueprints()`（`GameEngine.ts:136`）已是 PvP 专属蓝图构造器，Harpy/Medic 的 PvP 差异化数值放这里，**不污染** PvE 蓝图。

---

## 6. 实现架构（承重墙：锁步一致性）

### 6.1 核心难点
锁步要求两个客户端跑出**逐帧一致**的模拟。卡组不再相同后：
1. **每个客户端必须知道双方卡组**（不能本地各造各的）。
2. 引擎必须给 **top 和 bottom 都**绑 drawPolicy（现仅 bottom 有）。
3. 双方抽牌用**各自独立的 PRNG 流**（同一 match seed 派生两条子流，保证两端对每一方算出相同序列）。

### 6.2 数据流改动

| 环节 | 改动 | 文件 |
|---|---|---|
| 客户端提交卡组 | 排队/建房请求带上玩家选定的 `deck: string[]` | `AppViews.ts`（room_create）、gateway 入队 |
| 服务端校验 | gateway/matchsvc 取玩家 `seasonPeakElo` → 算「已解锁卡集」→ **校验提交的 deck 全在已解锁集 + 基础库内**，非法则拒绝/回退默认卡组 | `Gateway.ts:411` 附近、`internal.ts` ELO 端点 |
| 下发双方卡组 | ticket（`TicketClaims`）或 `match_start` 增加 `decks: { top: string[]; bottom: string[] }` | `Matchsvc.ts:365`、`Room.ts:169` |
| 引擎消费 | PvP 路径按 `decks` 给 top/bottom 各建 `UniformCardDrawPolicy`（复用 §1 已有的白名单过滤逻辑，从 PvE 路径推广到 PvP） | `GameEngine.ts:259-305` 推广 |

### 6.3 防作弊
解锁判定与 deck 合法性校验**全在服务端**（ELO 服务端权威）。客户端无法提交 ELO 未解锁的单位——服务端按 `seasonPeakElo` 算出的已解锁集是唯一真源，非法 deck 直接拒。

---

## 7. 美术现实 & 遗留

- **复用 ≠ 自动有美术**：这 6 个仍无 `.tao` 骨骼，进 PvP 后是程序火柴人，与精绘骨骼单位并排会有风格落差。可接受为**分期**：先开逻辑闭环，`.tao` 后补；补一次双模式都受益（本方案的核心 ROI）。
- **max/lena/mara 的解锁口径**：现注释称「PvE ch2/ch4/ch6 解锁后进 PvP」（`config.ts:342`），但引擎当前并未对 PvP 池做该过滤（默认全量）。本方案落地时需统一口径：要么把它们也纳入「可选库需先解锁」，要么明确基础库恒含。**待定**。
- **i18n**：6 单位需补 `card.<unit>.name/desc`（zh/en/de），卡牌图标/卡面（现仅 archer 有 `card.png`，其余走程序卡框，可接受）。

---

## 8. 分期实现建议

1. **P0 文档**（本文）→ 拍板。
2. **P1 引擎层**：CARD_DEFINITIONS 增 6 条 + 费用 + i18n；`buildPvpBlueprints` 加 Harpy/Medic override；引擎 PvP 路径支持 top/bottom 双 drawPolicy + 双 PRNG 流。**先用「服务端固定下发双方全解锁卡组」跑通锁步**，再接解锁/构筑。
3. **P2 传输层**：ticket/match_start 带 `decks`；gateway/matchsvc 取 ELO 算解锁集 + 校验 deck。
4. **P3 客户端构筑 UI**：可选库展示（带「段位解锁」锁标）、卡组编辑、存档存卡组、默认卡组。
5. **P4 平衡**：difficultySim 重跑，定卡组大小（8/10/12）与 6 单位费用；更新 BALANCE.md。
6. **P5 美术（后补，非阻塞）**：6 单位 `.tao` 骨骼。

---

## 9. 待拍板清单（实现前）

- [ ] 卡组大小：8 / 10 / 12（建议 10，待 sim）
- [ ] 解锁档位：diamond/king 两档 vs diamond/grandmaster/king 三档（默认两档）
- [ ] 解锁判定口径：当前 ELO vs `seasonPeakElo`（建议峰值）
- [ ] max/lena/mara 是否纳入「需解锁」或恒入基础库（§7）
- [ ] Harpy 飞行保底解规则是否需要（§5 复核）
- [ ] Medic PvP 攻击/光环具体数值（§5）
