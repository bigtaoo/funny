# PvP 构筑卡组 + 按段位解锁单位

版本：v0.4（P1/P2/P3/P4 全部完成）
日期：2026-06-30
状态：P1/P2/P3/P4 完成，待 P5 美术（非阻塞）

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

## 3. 解锁档位与单位分配（已定：三档，每档 2 个）

| 档位 | 段位门槛（ELO） | 解锁单位 | 选择理由 |
|---|---|---|---|
| **第一档** | diamond ≥ 1500 | Runner / Ironclad | 最干净的两个基础原型（快脆冲锋 + 抗箭重甲），数值直接可用 |
| **第二档** | grandmaster ≥ 2100 | Berserker / Splitter | 中等复杂度（残血狂暴 / 死亡分裂），有读条与博弈 |
| **第三档** | king ≥ 2400 | Harpy / Medic | 需 PvP 专属 override、最吃操作，放最高段 |

> **解锁判定 = 赛季峰值 `seasonPeakElo`**（`types.ts:71`），不是当前分。避免软重置/掉分后卡被锁回去、体验割裂；峰值随赛季重置。

> 三档把 diamond(1500)→king(2400) 的 900 ELO 空窗填上，中高段一路有新卡可拿。

---

## 4. 卡组构筑规则（已定）

| 项 | 设计值 | 说明 |
|---|---|---|
| 卡组大小 | **10 张** | `HAND_SIZE=6`，卡组 10 留出循环与取舍空间 |
| 结构规则 | **类别下限**：≥1 建筑、≥1 法术，其余槽位自由 | 防退化卡组（不允许全单位/全建筑/无进攻手段）；又不锁死后期法术流/建筑流等偏门打法。**不用固定配额**——固定 6/2/2 会把"未来加了第 3 个法术能否多带"提前焊死 |
| 可选库 | 基础 **10 种**（infantry/shieldbearer/archer/max/lena/mara + barracks/tower + haste/meteor）**＋** 按段位解锁的 0/2/4/6 个新单位 | max/lena/mara **恒入基础库**（见 §7）；新单位全是 Unit 类 |
| 每种张数 | 每种最多 1 张 | 去掉现有 `_1/_2` 重复条目带来的同卡叠抽 |
| 新手起手卡组 | **基础库正好 10 种 = 卡组 10 张 → 新手只能全带 = 固定起手卡组**（6 英雄 + 2 建筑 + 2 法术） | **刻意设计**：低段统一起手卡组，便于新手快速上手 + 玩家间交流讨论。真正的构筑取舍随"解锁单位"逐步开启（单位池 6→8→10→12，单位槽出现选择，类别下限仍保 ≥1 建筑 ≥1 法术） |

> **重大影响提示**：从「全池 18 条随机」改为「构筑 10 张」会**重写现有 PvP 平衡**（抽牌概率、节奏、克制关系全变）。BALANCE.md / difficultySim 需重跑。这是本方案最大的非美术工作量。

---

## 5. 数值：6 单位 PvP 化（P4 定稿，2026-06-30）

费用与现有锚点对齐（infantry4/archer5/shieldbearer6/max5/mara5/lena7/haste8/meteor12）。

| 单位 | 蓝图要点 | **费用（定稿）** | 提案 | PvP override / P4 结论 |
|---|---|---|---|---|
| Runner | hp30 快脆冲锋 | **3** | 3 | sim 59% 等墨胜率；降到 2 费会到 82%（过强）→ **保持 3**，不加 swarm |
| Berserker | hp110 atk18 残血狂暴 | **6** | 6 | sim 50%，均衡 → 无需改 |
| Ironclad | hp290 armor3 抗箭重甲 | **8** | 8 | sim 45%，定位防守肉盾合理 → 无需改 |
| Splitter | hp65 死亡裂 2 Runner | **5（↑由 4）** | 4 | sim 任何 4–6 费都 100% 等墨胜率（死亡分裂=3 体/125 等效血）→ 上调 5，对齐 5 费档；真正克制是 AOE 陨石（模拟器不建模）|
| **Harpy** | hp26 飞行 `canTargetFlying:false` | **7（高费）** | 7 | 保留飞行；高费即唯一护栏。**P4 解决 §5 推迟项：sim 证明 cost 7 下 harpy 从不压制（绕过近战赢不了对撞，6 只在基地竞速里输）→ 不加额外飞行机制**。类别下限强制 ≥1 建筑（箭塔是仅 2 建筑之一）实战已自然解 |
| **Medic** | hp90 atk0 光环奶 hps8 | **6** | 6 | **PvP override 定稿：attack=4 / interval=1.2 / range=1**（DPS≈3.3 象征性近战，不再是 0 攻呆牌）；光环 8 HP/s 半径 2 不变。sim 显示 6 费非压制（27%，且加入一个反而拖累速胜阵），无需削光环 |

> override 落点：`buildPvpBlueprints()`（`server/engine/src/balance/pveUpgrades.ts`）是 PvP 专属蓝图构造器，Medic 的 PvP 差异化数值放这里，**不污染** PvE 蓝图。硬墙只挡养成/装备泄漏，不挡静态 PvP override；守护测试见 `client/test/pvpBlueprintExpected.ts`（被 hardwall/siege/progression/equipment 复用）。

> **P4 平衡工具 = PvP 对战模拟器** `client/test/pvpSim.ts`（+ `pvpSim.test.ts`）。PvE difficultySim 不适用（单防守 AI vs 脚本波，无进攻 macro → 镜像必平局）；改用 **siege 确定性双军引擎**作对战台：等墨双方在中央 4 道对撞，以**残存军队血量/存活**判胜（双向各跑一次抵消 siege 守方超时优势），辅以解析「每墨战斗力」表交叉验证。局限：不建模法术（陨石 AOE=splitter 真克星）、箭塔防守、6 张手牌循环、墨经济、飞行的真实骚扰价值、奶的消耗战价值——故对 splitter/runner/berserker/ironclad 近战定标可靠，对 harpy/medic 取「不具压制性 + 设计推理」结论。

---

## 5.1 攻城值：到达基地扣血 = 攻城值（ADR-026 接线，2026-07-02）

**背景**：单位到达敌方基地曾扣 `unit.attack`（战斗攻击力）。这把「打兵」与「拆家」焊死成一个数字——攻城性价比无法独立于战力调整。攻城值（siege value）是一级蓝图属性（与 `attack`/`speed` 同级，见 [`DECISIONS.md` ADR-026](../DECISIONS.md)），把这根杠杆解出来。

- **扣血口径**：`MovementSystem` 到基地 `damage = unit.siegeValue`。`BASE_HP` 保持 100。
- **PvP 硬墙**：PvP 只读 `UnitBlueprint.siegeValue` **基础常量**（`buildPvpBlueprints()` 不吃任何养成），与 attack 处理同构；PvE/战役经 `applyUnitLevels` 按 +10%/级放大。
- **数值草案（全部 DRAFT，留实机体验修正）**——按角色定位排，`siege/ink` 刻意不平：

| 兵种 | 费用 | 定位 | **攻城值** | siege/ink |
|---|---|---|---|---|
| 步兵 Infantry | 4 | 线兵全能 | 11 | 2.75 |
| 盾兵 ShieldBearer | 6 | 破墙者 | 14 | 2.33 |
| 弓手 Archer | 5 | 玻璃大炮 | 8 | 1.60 |
| 铁甲 Ironclad | 8 | 最重坦/破墙顶 | 15 | 1.88 |
| 狂战 Berserker | 6 | 拆楼手 | 13 | 2.17 |
| 分裂 Splitter | 5 | 炸弹（裂变才是威胁） | 8 | 1.60 |
| 奔袭 Runner | 3 | 快速脆皮群冲 | 6 | 2.00 |
| 鹰身 Harpy | 7 | 飞兵绕后骚扰 | 7 | 1.00 |
| 医疗 Medic | 6 | 支援（几乎不拆家） | 4 | 0.67 |
| Max（Anna） | 6（锚点平衡 5→6） | 装甲先锋 | 12 | — |
| Lena（Anna） | 7 | 哨兵坦 | 14 | — |
| Mara（Anna） | 5 | 标记 dps | 8 | — |

> 六个英雄卡的值与 `@nw/shared` `CardDef.siegeValueBase` 保持一致；六个复用兵种仅存在于引擎蓝图（无 CARD_DEFS 卡）。关键效果：性价比杠杆立起（步兵最划算，弓手/Mara/Splitter 战斗专精付「攻城税」），且与 attack DPS 解耦（弓手 attack 22 却攻城 8，盾兵 attack 8 却攻城 14）。

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
- **max/lena/mara 的解锁口径（已定 = 恒入基础库）**：现注释称「PvE ch2/ch4/ch6 解锁后进 PvP」（`config.ts:342`），但引擎当前并未对 PvP 池做该过滤（默认全量），那句注释是愿景未落地。本方案统一口径为**恒入 PvP 基础库**（无 PvE 门槛），使基础库 = 10 = 卡组大小、新手起手卡组成立；落地时需删除/更正 `config.ts:342` 的过期注释。
- **i18n**：6 单位需补 `card.<unit>.name/desc`（zh/en/de），卡牌图标/卡面（现仅 archer 有 `card.png`，其余走程序卡框，可接受）。

---

## 8. 分期实现建议

1. **P0 文档**（本文）→ 拍板。✅
2. **P1 引擎层**：CARD_DEFINITIONS 增 6 条 + 费用 + i18n；`buildPvpBlueprints` 加 Harpy/Medic override；引擎 PvP 路径支持 top/bottom 双 drawPolicy + 双 PRNG 流。**先用「服务端固定下发双方全解锁卡组」跑通锁步**，再接解锁/构筑。✅ **（2026-06-30 完成）**
   - `config.ts`：6 条新卡（runner/ironclad/berserker/splitter/harpy/medic），各 1 张，cost 提案值已填（P4 sim 验证）；max/lena/mara 注释更正为「永久入 PvP 基础库」。
   - `pveUpgrades.ts`：`buildPvpBlueprints()` 加 Medic PvP override（attack=4/interval1.2/range1，TODO P4 定稿）；Harpy 高费护栏靠 CARD_DEFINITIONS cost=7 实现，无蓝图改动。
   - `types.ts`：`GameConfig` 新增 `decks?: { top: string[]; bottom: string[] }`。
   - `GameEngine.ts`：PvP/netplay `else` 分支加双 drawPolicy 逻辑，各自独立 PRNG 流（seed 派生，两端一致）。
   - i18n：zh/en/de 三语各补 12 个 `card.<unit>.name/desc` key。
3. **P2 传输层**：ticket/match_start 带 `decks`；gateway/matchsvc 取 ELO 算解锁集 + 校验 deck。✅ **（2026-06-30 完成）**
   - `server/shared/src/pvpDeck.ts`（新）：`PVP_BASE_CARDS`/`PVP_UNLOCK_TIERS`/`getPvpUnlockedCards`/`validatePvpDeck`/`defaultPvpDeck`，从 `@nw/shared` re-export。
   - `ticket.ts`：`TicketClaims` 增 `decks?`；`transport.proto`：`RoomCreate` 增 `deck`，`MatchStart` 增 `top_deck/bottom_deck`。
   - `metaserver/internal.ts`：`/internal/elo` 响应增 `seasonPeakElo`；`metaClient.ts`：`getElo()` 返回 `{ elo, seasonPeakElo }`。
   - `gateway`：读 `msg.deck`，用 `seasonPeakElo` 校验，回退 `defaultPvpDeck()`；matchsvcClient `enqueue/create/join` 增 `deck` 参数；`proto.ts` decode 增 `deck`。
   - `matchsvc`：`QueueEntry.deck`/`Slot.deck`；`enqueue/roomCreate/roomJoin/onPair/roomReady/startMatch` 全链路透传 deck；`startMatch` 构造 `decks` 注入 `TicketClaims`；`internalHttp.ts` 路由 decode `strArr(b.deck)`。
   - `gameserver`：`index.ts` 传 `claims.decks`；`RoomManager.join` 增参；`Room.Slot.decks?`/`addPlayer` 增参；`launch()` 从 slots 取 decks 下发 `topDeck/bottomDeck`；`proto/transport.ts` `match_start` 增 `topDeck?/bottomDeck?` + encode。
4. **P3 客户端构筑 UI**：可选库展示（带「段位解锁」锁标）、卡组编辑、存档存卡组、默认卡组。✅ **（2026-06-30 完成）**
   - `client/src/game/meta/pvpLoadout.ts`（新）：客户端镜像常量 + `getPvpUnlockedCards`/`defaultPvpDeck`/`validatePvpDeckClient`。
   - `client/src/scenes/DeckBuilderScene.ts`（新）：2列卡格、段位锁标、切换选中/取消、10张验证、确认回调。
   - `client/src/app/AppViews.ts`：增 `showDeckBuilder(cb)`。
   - `client/src/app/createAppCore.ts`：`goDeckBuilder()` 函数；`onStartRanked` 路由进构筑 UI；`queueRanked`/`createRanked` 透传 `getSavedDeck()`。
   - `client/src/app.ts`（PixiAppViews）：`showDeckBuilder` 实现。
   - `client/src/game/meta/SaveData.ts`：`pvpDeck?: string[]`（本地字段，不入 SyncPatch）。
   - `client/src/game/meta/SaveManager.ts`：`patchLocal()`；`reconcile`/`adoptCloud` 保留 `pvpDeck`。
   - `client/src/net/NetClient.ts`/`NetSession.ts`：`createRoom`/`createRanked` 支持 `deck` 参数。
   - `client/src/net/proto/transport.ts`：`MatchStart.encode/decode/fromPartial` 补 `topDeck`/`bottomDeck`（field 9/10）。
   - `client/src/game/net/NetInputSource.ts`：`MatchStartInfo.decks?` + `onMatchStart` 捕获。
   - `client/src/app/createAppCore.ts`（`goGameNet`）：引擎构造传 `decks: info.decks`。
   - i18n：`pvp.deckBuilder`/`pvp.confirmDeck` 三语补全。
   - Bug fix：`server/shared/src/pvpDeck.ts` `PVP_BASE_CARDS` 补 `_1` 后缀（engine `c.id` 格式要求）。
5. **P4 平衡** ✅ **（2026-06-30 完成）**：新建 PvP 对战模拟器 `client/test/pvpSim.ts`（+ `pvpSim.test.ts`，复用 siege 双军引擎跑等墨对撞）。结论：splitter 4→5（唯一改动），runner3/berserker6/ironclad8/harpy7/medic6 保持；Medic PvP override 定稿 attack4/interval1.2/range1；Harpy 不加飞行护栏（sim 证明非压制）。卡组大小维持 10。BALANCE.md §5.2/§7 已同步。
   - 顺带修复 P1 遗留回归：Medic PvP override 令 5 个硬墙测试（hardwall/siege/siege-battle/progression/equipment）断言 `buildPvpBlueprints()===UNIT_BLUEPRINTS` 失败——硬墙真不变量是「养成/装备不泄漏」而非「与常量逐字节相等」，新增 `client/test/pvpBlueprintExpected.ts` 共享期望（常量 + 静态 §5 override），5 处改为对比它。
6. **P5 美术（后补，非阻塞）**：6 单位 `.tao` 骨骼。

---

## 9. 拍板记录（2026-06-30 全部敲定）

- [x] **卡组大小 = 10 张**（§4）
- [x] **结构规则 = 类别下限**（≥1 建筑、≥1 法术，余位自由），不用固定配额（§4）
- [x] **新手 = 固定起手卡组**（基础库 10 = 卡组 10），构筑随解锁单位开启（§4）
- [x] **解锁档位 = 三档每档 2 个**：diamond1500(Runner/Ironclad) / grandmaster2100(Berserker/Splitter) / king2400(Harpy/Medic)（§3）
- [x] **解锁判定 = `seasonPeakElo`**（赛季峰值，不降级）（§3）
- [x] **max/lena/mara = 恒入基础库**（不再 PvE 门槛过滤）（§4、§7）
- [x] **Harpy 飞行护栏 → P4 决议：不加额外机制**（sim 证明 cost 7 非压制；类别下限带箭塔实战已解）（§5）
- [x] **Medic PvP 数值 → P4 定稿：attack4/interval1.2/range1，光环不变**（sim 证明 cost 6 非压制）（§5）
- [x] **6 单位费用 → P4 定标**（pvpSim）：splitter 4→5，余 5 个保持；卡组大小维持 10（§5、§8.5）

> P4 已用 PvP 对战模拟器（`client/test/pvpSim.ts`，非 PvE difficultySim）完成 6 单位费用 / Medic / Harpy 定标，详见 §5 + BALANCE.md §5.2。锚点 max/infantry 等墨偏强是 A6 既有 PvP 问题，留单独平衡 pass（非本任务范围）。
