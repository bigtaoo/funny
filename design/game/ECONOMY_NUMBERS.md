# 经济数值演算表（ECONOMY_NUMBERS）

> 状态：设计中 · **权威：本文（经济/养成数值的单一可信源）** · 更新：2026-06-21
>
> 本文是**经济与养成数值的演算沙盘**：所有可调参数集中在 §10，公式 + 派生表 + 演算示例便于调平衡。
> 与 [`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md) 分工：那份讲**为什么**（faucet/sink 哲学、鲸鱼天花板、反通胀），本份讲**多少**（数字）。
> 战斗运行数值（HP/攻/速）见 [`BALANCE.md`](BALANCE.md)；本文只管经济/养成。
> 标 `[可调]` 的是默认提案，待调参；标 `[DRAFT]` 的是结构待你拍板。
> ⚠️ ADR-065（2026-08-12）：引擎内部把 HP/攻击/护甲/暴击/强化倍率等连续型战斗数值改成了定点整数（×1000），本文数字口径不受影响，仍是真实单位——定点化只是 `server/engine` 内部运行时表示，不改变这里演算的数字本身。

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `ECONOMY_NUMBERS.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ 经济数值演算表（ECONOMY_NUMBERS） | **本文** |
| §12 留存、§13 赛季战令、§13-SLG 大世界持久经济、§14 活动、§15 角色卡 | [`ECONOMY_NUMBERS_LIVEOPS.md`](ECONOMY_NUMBERS_LIVEOPS.md) |

## 1. 货币与资源总览

| 资源 | 符号 | 持久 | 来源 | 消耗 | 权威 |
|---|---|---|---|---|---|
| 墨 | `ink` | 否（单局清零） | 局内回墨 | 局内出牌 | config.ts / BALANCE.md |
| 金币 | `coins` | 是 | 看广告（等值挂钩）/ 充值 / 称号成就一次性 | 皮肤直购 / 抽卡 / 体力购买 | 服务器（commercial） |
| 体力 | `stamina` | 是 | 自然恢复 / 金币购买 / 道具 | 打关卡 | 服务器 |
| 单位卡 | `unitCard[type][tier]` | 是 | 关卡掉落（体力门控） | 合成升级（5→1） | 服务器 |
| 养成材料 | `materials`(scrap/lead/binding…) | 是 | 关卡掉落 | 单位/装备养成 | 服务器（pveRewards） |
| 装备 | `equipment` | 是 | 关卡掉落 / 文具合成 | 装备升级 | 服务器 [DRAFT] |

> 货币命名铁律见 ADR-002：局内 `ink`、持久 `coins`。

---

## 2. 体力（Stamina） `[可调]`

体力是**关卡刷材料的总闸门**：自然恢复有上限，决定每日能刷多少。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `STAMINA_MAX` | 120 | 自然恢复上限（溢出停涨；可随账号等级提升，后置） |
| `STAMINA_REGEN` | 1 / 6 min | = 10/h = **240/天**（满状态下日产出闸门） |
| `STAMINA_REFILL_COIN` | **30 coins → +60 体力**（固定，走 commercial.spend） | 当前实装为定额、无递增、无每日次数上限（`purchaseStamina` 仅校验 amount=60） |
| `STAMINA_REFILL_AD` | 1 广告 → +30 `[可调]` | 每日 ≤3 次 `[可调]`（设计项，未实装则忽略） |

**每日有效体力** = 240（自然）+ 金币补充（30 金币/60 体力，按需购买）≈ **240 不氪起步 / 氪金按 30 金币/60 体力线性叠加**。

> 实装权威见 `BALANCE.md §10` 与 `metaserver service.purchaseStamina`。原「50→120 ×2 递增 + 每日 5 次上限」为旧设计提案，未落地，已对齐为定额 30→60。

> **扣费时机（2026-07-06 拍板）**：体力在**进入关卡时**扣（`POST /pve/enter`），不在结算时扣——`/pve/clear` 不再触碰体力。中途撤退/打输**不退还**。离线也照扣：客户端本地镜像立即扣减（`SaveManager.spendStaminaForLevel`），联网后再用 `/pve/enter` 对账服务器权威值（`pveStamina` collection），与既有"关卡结算离线排队"（§8.4）同构。

---

## 3. 关卡产出（体力门控） `[可调]`

不同关卡**产出不同**，但体力消耗统一为**定额 10/次**（2026-07-06 拍板，取代下表旧提案的按类型 6/12/18/10 分级——该分级从未落地，代码此前默认统一按 1 点扣，现改为统一 10 点，`PveLevelConfig.staminaCost` 仍支持按关卡覆盖，当前所有关卡未覆盖）。

| 关卡类型 | 体力消耗 | 材料产出 | 单位卡掉落 | 备注 |
|---|---|---|---|---|
| 普通关 | 10 | 基准 ×1 | 该章单位 T1 卡，期望 ~0.5/次 | 主刷点 |
| 精英关 | 10 | ×2.2 | T1 卡 ~1.2/次 + 小概率材料 | 性价比略高 |
| Boss 关 | 10 | ×3.5 | 保底装备/高级材料 | 每日次数限 |
| 活动关 | 10 | 活动货币 | 限定材料 | 限时 |

**每日刷关上限**（不氪 240 体力）：240÷10 = **24 次/天**。
→ 单一单位 T1 卡日产 ≈ 24 × 0.5 = **12 张/天**（若全刷该单位掉落关）。

> 首通 vs 复刷：首通额外发**首通奖励**（一次性，含剧情/皮肤碎片）；复刷只发上表常规产出，受体力闸门约束。`[可调]` 复刷材料可折 70%。

---

## 4. 单位养成（合成树，指数 sink）

**机制**（ADR-009）：每个单位卡分 1–9 级；**5 张 N 级 → 合成 1 张 (N+1) 级，100% 成功**。
单位的强度等级 = 当前最高合成到的卡级。

> **实现状态（2026-06-21，META_TASKS S12）**：引擎脊柱已落地——`@nw/engine/balance/progression.ts`（`applyUnitLevels` = 等级→蓝图唯一注入点，§4.2 连续属性 + §4.4 三档 trait；暴击机制走 `GameState.combatPrng` + `CombatSystem`，PvP 硬墙不读）。**§4.2 / §4.4 的数值即代码常量**（`STAT_GROWTH_PER_LEVEL` / `TRAIT_BREAKPOINTS`），调参只动那里。**已落地（S12-B，2026-06-21）**：§4.1 合成核心——`@nw/shared/unitCards.ts`（`applyCardMerge` 5→1 + `deriveUnitLevels`）+ SaveData `unitLevels`/`cardInventory`（服务器权威，SAVE_VERSION→3）+ meta `POST /pve/merge`（真 Mongo e2e 绿）+ 引擎 `GameConfig.unitLevels`。**⚠️ 已退役（CC-8，2026-07-02）**：本节描述的「按兵种 5→1 collect-and-merge」模型自 Hero Roster 迁移（CC-1，见 CHARACTER_CARDS_DESIGN）起作废——`applyCardMerge`/`MERGE_COPIES` 与 `POST /pve/merge` 端点已删除，单位养成改为花名册 per-card（`cardInv`）；`deriveUnitLevels`/`cardInventory` 作为掉卡→强度派生仍现役。**已落地（S12-C，2026-06-21）**：§4.1 卡片**两条来源**——①独立单位卡盲盒池（`UNIT_CARD_POOL_ID`+`unitCardPoolItems`，稀有度→卡级 `GACHA_RARITY_TO_CARD_LEVEL` common→T1…legendary→T4）②关卡掉卡（`levelCardReward(levelId)` 确定性整数，ch1–2→T1/ch3–4→T2/ch5–6→T3，终关双倍）；meta `deliverCardGrant` 乐观锁发货入 cardInventory + 重算 unitLevels（不走皮肤 dupe 退币），`/pve/clear`+`/pve/verify` 响应加 `grantedCards`。**待落地**：客户端养成/合成 UI 与实际对局 play-wiring + anti-cheat judge 对齐（S12-D）。**⚠️ 已退役（2026-07-03）**：①「独立单位卡盲盒池」`units` 已彻底移除（`UNIT_CARD_POOL_ID`/`unitCardPoolItems`/`GACHA_RARITY_TO_CARD_LEVEL`/`deliverCardGrant` 全删）——它作第二个非限定池被显示成重复「常驻池」；②关卡掉卡 `levelCardReward` + `cardInventory`/`deriveUnitLevels` 仍现役。

> **§3 单位卡掉落口径落地（S12-C）**：表内「期望 ~0.5/次」概率掉落实现为**确定性整数**（每关固定张数，服务器权威 + L1 抽检幂等优先）；tier/张数即 `levelCardReward` 常量，调「高级卡获取速率」动那里。（盲盒补充源 `units` 池已于 2026-07-03 移除，单位卡现仅靠关卡掉落。）

### 4.1 合成成本（以 T1 卡为单位）

| 目标级 | 该级 = 多少张 T1 卡 | 累计到该级总消耗(T1) |
|---|---|---|
| T1 | 1 | 1 |
| T2 | 5 | 6 |
| T3 | 25 | 31 |
| T4 | 125 | 156 |
| T5 | 625 | 781 |
| T6 | 3,125 | 3,906 |
| T7 | 15,625 | 19,531 |
| T8 | 78,125 | 97,656 |
| **T9** | **390,625** | **488,281** |

> ⚠️ **9 级是长期目标**：纯刷 T1 卡升满 T9 不现实（390,625÷日产 20 ≈ 19,500 天）。可达性靠**多卡源**（用户拍板）：
> - **后期关卡直接产 T3 卡**（= 25 张 T1 当量，越后期掉越高级，跳过底层合成）。
> - **抽奖出卡** / **金币直购卡包** / **拍卖行收购**。
> - 付费玩家凑齐 T9 不是问题；F2P 主力停在 T5–T6（精英刷 T3 卡合成上去，数周到数月）。
>
> 调平衡主调"高级卡获取速率"（后期关 T3 掉率、卡包定价、拍卖供给），**不动 5→1 合成系数**。

> **⚠️ 2026-08-03 二次核实（economy-numbers-gaps 任务）**：上面 2026-07-02/07-03 两条"已退役"记录本身有一处遗留误差，且和本节的关系容易读错，这里一并订正：
> - `deriveUnitLevels`/`cardInventory`/`unitLevels`（`@nw/shared/unitCards.ts`）**才是真正的死代码**——`SaveData.unitLevels` 字段在 v4（2026-07-01 Hero Roster 迁移）已整体删除，CC-9（2026-07-03）进一步确认写它的代码路径是死代码并退役；`cardInventory` 字段仍挂在 SaveData 上但无人读写。
> - `levelCardReward()`（同文件）**仍是活的**：`server/metaserver/src/service/pve.ts` 的 `grantClearReward`/`grantSpotCheckReward` 每次通关都调用它（不只首通），把返回的 cardKey 解析出 `unitId` 后按 `CARD_DEFS.unitType` 匹配，发一张**花名册（Hero Roster，`cardInv`）**里的 1 级 CardInstance——不是发进已废弃的 `cardInventory`。掉卡按 `PVE_DAILY_CLEAR_REWARD_CAP=20`/天封顶（`server/shared/src/pveRewards.ts`），与体力上限（§2，24 次/天）分开计。
> - 换句话说：**本节 §4.1 的合成表不是"废案"，而是换了皮的现役数学**——Hero Roster 融合（`@nw/shared/cards.ts`：`FUSION_MATERIAL_COUNT=5` 同阵营同等级卡 → 目标 +1 级，`MAX_CARD_LEVEL=9`）本质仍是 5→1 指数模型，到 L 级总耗卡量仍是 `5^(L-1)`，与上表数字完全对得上（表头"T1..T9"直接读作"角色卡等级 1..9"即可，唯一变化是"合成对象"从「兵种卡」变成「角色卡」、且材料判定是**同阵营**——涛奇三人互通、Anna 三人互通——而非严格同兵种）。
> - **两条活的卡来源**（喂给上面这套融合公式）：① **抽卡**（`GACHA_POOLS` 常驻池）：涛奇三人各 4.97%/抽（合计 14.91%），Anna 三人各 0.8%/抽（合计 2.4%）；② **关卡掉卡**（上面的 `levelCardReward`，20 张/天封顶）：专精刷同一副本可稳定获得对应兵种的角色卡，是 F2P 的确定性主路径。
> - **F2P 现实可达性**（按②20 张/天专精刷估算，与上表 T 列对齐）：L4 ≈ 8 天、L5 ≈ 39 天、L6 ≈ 195 天（~6.5 月）、**L7 ≈ 781 天（~2 年）**、L8/L9 已进入十年量级——比旧版"F2P 主力 T5–T6"的估计还要慢一档（旧版有"后期关直产 T3 卡"的跳级捷径，Hero Roster 目前没有等价机制）。
> - **2026-08-03 拍板**：**不新增免费加速通道**（不给精英/Boss 关加大掉卡数，不加金币直购卡包）——T7+ 明确定位为**付费/抽卡运气专属**，F2P 现实止步 L5–L6（数月量级），与旧版哲学同向但门槛更高、且是**有意维持的门槛，不是待修的 bug**。后续若要再开放，改这里的掉卡倍率或补一个付费卡包（§6.3 曾提过的设想，本次已撤回）。

### 4.2 每级属性加成 `[可调]`（PvE 专属，硬墙隔离 PvP）

加成相对单位 BALANCE.md 基础值，**逐级叠加（additive）**：

| 轴 | 每级 | T9 累计（满级） | 说明 |
|---|---|---|---|
| HP | +12% | +96% | |
| 攻击力 | +10% | +80% | |
| 攻速（攻击间隔↓） | +4% | +32% | 有下限封顶防破帧 |
| 移速 | +3% | +24% | |
| **护甲 armor** | +1（flat） | +8（L9） | S12-E 校准 2→1；见 §4.3 与 `BALANCE.md §8` |

### 4.3 护甲 armor（新增机制）✅ flat（用户确认）

游戏当前无护甲。引入 **flat 减伤**：
`实际伤害 = max(1, 来袭伤害 − armor)`（保底 1，防全免疫）。
- 读数直观；对低攻多段单位（疾行群）削弱明显、对高攻单位影响小，天然"重甲扛杂兵"克制。
- 仅 PvE 养成注入；PvP 蓝图 armor 恒为 0（硬墙）。
- ⚠️ **战斗数值需重新演算**（用户已点明）：引入 armor 后所有 TTK / 交战速算（原 BALANCE 推演）都要重算——护甲落地引擎时，配套重做一轮战斗平衡（单独任务，见 §11）。

### 4.4 单位养成特性（俗套基线，后期完善）`[可调]`

> **命名约定（2026-06-21 改）**：本节原称"里程碑特性"，因与**成就系统**（其触发条件俗称"统计里程碑"，见 [`ECONOMY_BALANCE.md §2.4`](ECONOMY_BALANCE.md)）撞词，统一改名为 **单位养成特性**（trait）。"里程碑 / milestone" 一词此后**专留给成就系统**，不再指单位养成。

**定位**：单位养成除 §4.2 的 5 条连续属性轴外，再叠加**离散的特性解锁**——升级到特定等级时一次性获得一个**质变型**能力（连续轴是量变，特性是质变）。落地方式（用户：先按俗套定，后期完善）：**三档通用特性**，在 T3 / T6 / T9 解锁节点（"trait breakpoint"）触发，所有单位通用。

#### 解锁表（通用三档）

| 解锁节点 | 特性 | 内部 key（建议） | 效果 | 数值 `[可调]` |
|---|---|---|---|---|
| **T3** | 暴击 crit | `trait_crit` | 攻击有概率暴击，造成倍率伤害 | 暴击率 **10%**、暴伤 **×1.5** |
| **T6** | 吸血 lifesteal | `trait_lifesteal` | 造成伤害时按比例回复自身 HP | 伤害的 **15%** 转治疗，溢出不保留 |
| **T9** | 额外出兵 +1 | `trait_spawn_plus` | 出牌时多召唤 1 个单位 | `spawnCount +1`（满级爽点） |

#### 规则细化（落地约定）

- **叠加性**：特性与 §4.2 连续轴**独立叠加**——T9 单位同时拥有满级属性（HP +96% 等）+ 三档特性全开。低于解锁等级不享有该特性（T2 无暴击）。
- **结算口径**：
  - **暴击**：每次攻击独立 roll；暴伤在最终伤害（已减护甲前/后？→ **暂定减护甲前的原始伤害 ×1.5 再过 armor**，保持"暴击是攻击侧加成"语义）。多段攻击每段独立判定。
  - **吸血**：按**实际造成伤害**（已过目标 armor、已被 max(1,…) 保底后的值）的 15% 回血；治疗不超过自身 maxHP，溢出丢弃；对建筑/无血量目标造成的伤害是否吸血 → **暂定吸**（简化），后期可按目标类型过滤。
  - **额外出兵**：`spawnCount` 在出牌结算时 +1，**不额外消耗 ink/费用**（等级福利）；与卡牌本身的群体出兵叠加（如本就出 3 个 → 出 4 个）。
- **隔离铁律（与全 PvE 养成一致）**：三档特性**仅 PvE / SLG 注入**；**PvP 锁步蓝图恒不读特性**（与 armor、装备同走硬墙），保证竞技公平。引擎侧蓝图中特性字段在 PvP 模式恒为关闭/0。
- **确定性**：暴击的随机 roll 必须走引擎统一的**种子化 RNG**（与现有锁步/重播一致），不可用 `Math.random`，以免破坏 PvE 回放/SLG 围攻权威结算的确定性。

#### 后期差异化路线（开放）

俗套三档是**最小可用基线**，目的是先让"升满级有质变爽点"成立。最初的候选方向只是示意（弓兵射程/暴击穿透、医护光环、重甲反伤/护甲随血量、法术单位范围+减速灼烧），未定案。

**2026-08-05 已落地（v1，T9-only 差异化）**：上面那张候选表跟真实花名册对不上——花名册只有 6 个可养成单位（Infantry/ShieldBearer/Archer + Max/Lena/Mara），**医护（Medic）是 PvE 专属敌兵，没有卡、根本不在养成体系里**，也没有独立的"法术单位"角色。按实际花名册重新分配，且**只替换 T9（"大招"档），T3 暴击 10%/T6 吸血 15% 保持全兵种通用不变**（这两档已经过战斗平衡校准，全部重做等于开一次新的平衡工程；用户拍板缩小范围）：

| 单位 | 定位 | T9 专属特性 | 实现方式（复用/新增引擎机制） |
|---|---|---|---|
| Archer 弓箭兵 | 远程 | 射程 2→3 | 直接改 `range`，零新机制 |
| ShieldBearer 盾兵 | 重甲 | HP≤40% 时护甲额外 +6 | 照抄 Berserker 现成的 `berserkerThreshold` 阈值机制（新增 `armorEnrageThreshold`/`armorEnrageBonus` + `Unit.effectiveArmor` getter） |
| Lena | 重甲/哨卫 | 受击反弹 20% 伤害给攻击者 | 新机制（`reflectPct`，`CombatSystem.resolveAttackHit` 新增一段，是这批里唯一真正的新战斗逻辑） |
| Mara | 远程/游击 | 箭矢命中附加减速 20%/1.5s | 复用现成的 `slowOnHit` 字段（已实现但此前无单位使用） |
| Max | 先锋终结者 | 现有 `burstOnSingle` 倍率 ×2→×2.5 | 数值增强既有技能（新增 `burstOnSingleMult` 参数化原硬编码 `×2`） |
| Infantry | 标尺/全能 | 不变，保持通用 +1 出兵 | 它是 cp/ink=1.0 的平衡基准单位，故意不特化 |

实现：`server/engine/src/balance/progression.ts` `PER_UNIT_T9_TRAITS`（可辨识联合 `UnitT9Trait`），`applyUnitLevels` 在 T9 判定处优先查这张表，查不到（目前只有 Infantry）才落回通用 `bonusSpawn`。PvP 硬墙不受影响（`buildPvpBlueprints` 从不调用 `applyUnitLevels`，新字段在 PvP 蓝图里恒为 0/undefined，测试覆盖）。测试：`server/engine/src/__tests__/unit_t9_traits.test.ts`（14 例，五个单位逐一在真实 CombatSystem tick 里跑一遍——不只是查 blueprint 字段，Archer 射程+1 真的能打到多 1 格外的目标、Mara 减速真的让目标变慢、Lena 反伤连**建筑攻击者**（箭塔）也覆盖到、护甲随血量提升的数值明确标注"故意不受装备护甲上限约束"）+ `pvp_hardwall.test.ts` 更新（Archer/ShieldBearer 的 T9 断言改成各自专属效果，不再是统一 `+1 spawnCount`）。

> 差异化做的时候，三档**解锁节点（T3/T6/T9）不变**，只替换每档的具体效果；通用三档作为未差异化单位的兜底。仍仅 PvE 注入。

---

## 5. 装备养成（可失败，最深氪点）— 俗套基线 `[可调]`

用户拍板：装备是**最深的坑**，**越往上成功率越低**；满级整套极稀有（"几万人里一个"）；**有限回收**（[ADR-012](DECISIONS.md)：+0~4 可分解返 70% 打造材料，+5 起不可分解，机制权威见 EQUIPMENT_DESIGN §6.3）。先按俗套定，后期完善。

### 5.1 结构（俗套基线）
- **槽位**：每单位 3 件——**武器 / 护具 / 饰品**。
- **来源**：关卡掉落 + **文具合成**（叙事：用文具材料合成装备，见 [[project-narrative-economy]]）+ 抽卡 + 拍卖行。
- **加成**：仅 PvE/SLG 注入数值（攻/血/护甲等），**PvP 恒不读**（硬墙）。
- **强化等级**：+1 → +9（与单位卡同深度，但走概率而非合成）。
- **暴击词条**（B 方案，数值权威在代码 `@nw/shared/equipment.ts` + `@nw/engine/balance/equipment.ts`，此处为 DRAFT 基线）：
  - `m_crit`（饰品主词条，与移速二选一）：暴击**率** base 6 点，随强化放大（+9 ≈ **30 点**，[ADR-063](DECISIONS.md) 非线性倍率表 ×5.00，2026-08-10 从 ×4.06 再拔高；旧线性系数下曾是 ×1.9≈11.4 点）。
  - `s_critmult`（rare/epic 副词条）：暴击**伤害** +15..30%（引擎 `value/100` 加到倍率）。
  - 跨源封顶（EQUIPMENT_DESIGN §7.7，引擎 `EFFECT_CAPS`）：暴击率 T3+装备 Σ ≤ **50%**；暴击倍率 T3 基础 1.5× + `s_critmult` Σ ≤ **2.5×**。

### 5.2 强化成功率（每升一级 −10%）

每次强化消耗材料（+ 金币），**成功率每往上一级降 10%**，0→1 起 90%、8→9 仅 10%（**代码权威** `enhanceSuccessRate()`，`shared/src/equipment.ts` §99-105：`(EQUIP_MAX_LEVEL - fromLevel) / 10`；下表此前漏列 +0→1 一档，与 §5.4 期望成本表/EQUIPMENT_DESIGN §6.1 不一致，已按代码补齐）：

| 升级步 | +0→1 | +1→2 | +2→3 | +3→4 | +4→5 | +5→6 | +6→7 | +7→8 | +8→9 |
|---|---|---|---|---|---|---|---|---|---|
| 成功率 | 90% | 80% | 70% | 60% | 50% | 40% | 30% | 20% | **10%** |

- **失败后果**（[ADR-063](DECISIONS.md)，2026-08-10 收紧）：
  - **+0~+6**：不掉级，只损耗本次材料/金币（俗套温和档——强化失败不毁装备；销毁仅走分解，见 ADR-012 / EQUIPMENT_DESIGN §6.3）。
  - **+7~+8**：失败额外有 **20%/25%** 概率掉 1 级——高级的主词条倍率被拉得很陡（EQUIPMENT_DESIGN §7.3），代价必须同步拉高，否则理性玩家没有冲过 +6 的理由。保护道具（氪点）可同时挡住材料损耗和掉级。
- **期望成本**：升到 +9 的期望尝试次数 = Σ(1/p)；如 +8→9 平均 10 次、+7→8 平均 5 次（掉级风险会进一步推高实际期望次数，未在此纳入模拟——见 `server/tools/econ-sim` 后续 TODO）……**整套 3 件 +9 是鲸鱼级长期目标**，正是充值动机所在。

### 5.3 长期通胀提示
**金币/材料 sink 主要来自"反复强化的失败损耗"**（高级低成功率 = 持续吞材料）。膨胀治理已上 [ADR-012](DECISIONS.md)：**分解回收**（+0~4 返 70%，30% 损耗本身是温和 sink）+ **库存硬上限 1000 实例**（[ADR-064](DECISIONS.md) 2026-08-10 由 300 扩容）封顶（堆叠件不计），机制权威见 EQUIPMENT_DESIGN §3.3 / §6.3。高级件（+5↑）不可分解，出口走拍卖/穿戴。

#### 5.3.1 ADR-030 深水 sink 占位数值（2026-07-03，除洗练金币外全 DRAFT，待经济模拟）

盲盒管"抽到"，本节管"抽空之后"——补长尾鲸鱼深水区 + 非 SLG 玩家的装备出口（政策见 ECONOMY_BALANCE §3.4，决策见 [ADR-030](DECISIONS.md)）。全部**不新增金币龙头、不卖直接战力**。

| sink | 数值 | 权威/落点 | 状态 |
|---|---|---|---|
| 洗练基础金币（每次，按目标稀有度） | fine **80** / rare **200** / epic **500** | 代码 `@nw/shared REFORGE_COIN_COST`（`reforgeCoinCost()`） | ✅ 已实装（`reforgeEquipment` 走 commercial 扣费）；数值按 enhance 量级（+8→9 =360）估的 DRAFT |
| SLG 便利：迁城令 | `[待铺]` coins | SLG_CITY_DESIGN / SLG_DESIGN | 未实装（coin 只买方便，不买上限/战力，红线同 ADR-022） |
| SLG 便利：开新地块 | `[待铺]` coins | 同上 | 未实装 |
| SLG 便利：宗门科技捐献 | `[待铺]` coins | 同上 | 未实装 |
| 外观广度定价（主城/城池皮肤·宗门旗徽·头像框·称号装饰·战斗特效·录像装饰） | `[待铺]` coins（按稀有度分档） | ECONOMY_BALANCE §3.4 / art-direction | 未实装（纯外观，文具 bone-slot 程序绘制，近零美术成本） |
| PvE 多人副本产出（材料/装备 faucet，受体力闸门） | `[待铺]` | CAMPAIGN_DESIGN | 未实装（faucet 计入反通胀预算，不新增金币龙头） |

> `[待铺]` 数值待与盲盒/皮肤定价一起过一次经济模拟（§9 / ECONOMY_BALANCE §6 反通胀预算）后再拍。**改这些数值须同步 [ADR-030](DECISIONS.md) 与各落点文档。**

### 5.4 `protect_enhance` 保护道具定价核算（2026-08-02 更新：binding 起征点 +6→+4，价格维持 500 不变）

商城 `SHOP_ITEMS`（`server/shared/src/economy.ts`）里 `protect_enhance` 定价 **500 coins**（flat，不分等级）。用途：用在下一次强化上，若该次**失败**则不损耗材料（**金币仍照扣**，见 EQUIPMENT_DESIGN §E7）。价格本身用户已拍板维持不变，本节只补上核算，供后续调参时对照，而不是重新定价的提案。

**2026-08-02 改动**：`enhanceCost()`（`server/shared/src/equipment.ts` + 客户端镜像 `client/src/game/meta/equipmentDefs.ts`）的 `binding` 起征点从 **+6** 提前到 **+4**（`lv >= 4 ? lv - 3 : 0`，原为 `lv >= 6 ? lv - 5 : 0`）——用户明确要求"鼓励玩家用保护石"，把中期材料消耗调高，让保护石从更早的等级就开始划算，而不是只在 +7 起才回本。scrap/lead 公式与金币公式不变。

用 `server/tools/econ-sim`（D-track，`npx tsx src/enhanceProtectRun.ts` 或 `npm run enhance-protect`）按 A-track 同一套材料估值基准（`valuation.ts`：scrap=1 / lead≈16.67 / binding=400 coin-eq，见 §13-SLG）逐级算出"保一次失败"实际值多少（**下表为调整后数值**）：

| 强化步 | 成功率 | 期望尝试次数 | 单次材料 coin-eq | 单次金币成本 | 爬到该级的期望材料损耗 coin-eq |
|---|---|---|---|---|---|
| +0→1 | 90% | 1.11 | 4 | 40 | 0 |
| +1→2 | 80% | 1.25 | 6 | 80 | 2 |
| +2→3 | 70% | 1.43 | 8 | 120 | 3 |
| +3→4 | 60% | 1.67 | 27 | 160 | 18 |
| +4→5 | 50% | 2.00 | 445 | 200 | 445 |
| +5→6 | 40% | 2.50 | 864 | 240 | 1,296 |
| +6→7 | 30% | 3.33 | 1,283 | 280 | 2,993 |
| +7→8 | 20% | 5.00 | 1,701 | 320 | 6,805 |
| +8→9 | 10% | 10.00 | **2,120** | 360 | **19,080** |

**结论**：500 的 flat 价现在从 **+5 起**就"划算"（单次失败材料损耗 ≥ 500，原为 +7 起）；+4→5 单次材料损耗 445，虽未过盈亏线，但已逼近，且爬到 +5 的期望材料损耗（445，等于单次值——期望尝试数刚好 2.00）已经和票价打平，也值得买。低级（+0~+3）依旧是"用亏"区间——binding 不在这几档出现，材料损耗天然低，符合"早期不该逼玩家氪保护石"的直觉。高级（+6 及以上）比调整前更"赚"（+8→9 单次价值从 1,320 涨到 2,120，是挂牌价的 **4.2 倍**，原为 2.6 倍），保护石作为"鲸鱼向深水保险"的定位（EQUIPMENT_DESIGN §6.2）更加明确。这仍是**有意的不对称**：flat 价没法同时贴合 9 个数量级不同的材料损耗，若要更精细可以按 `enhanceCost(fromLevel).coins` 分级定价，但这是后续调参项，不在本次范围内。

数值口径：见 [`server/tools/econ-sim/src/enhanceProtect.ts`](../../server/tools/econ-sim/src/enhanceProtect.ts)（`protectValueByLevel()` / `breakEvenLevels()`），跑法见 [`server/tools/econ-sim/src/enhanceProtectRun.ts`](../../server/tools/econ-sim/src/enhanceProtectRun.ts)。

---

## 6. 金币（coins）

### 6.1 来源（金币龙头）`[可调]`

F2P 金币龙头：广告（主力）+ 战斗 / 活动 / 称号 / 任务。

| 来源 | 量 | 月度估算 `[可调]` | 说明 |
|---|---|---|---|
| 看广告 | **10 coins/条**，≤5 条/天，每条间隔 ≥10 min | ≤50/天上限（10×5）；活跃实际 ~900–1,500/月 | 主动小额，门槛=时间 |
| 日常任务/签到 | 每日若干（机制见 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)；数值 §12） | ~150（+200/月签到里程碑 bonusCoins，R1b，独立小计） | 每日任务满点金币 5/天 ×30（日上限收敛到此）；签到本体主发材料/卡/装备，里程碑格另加小额 bonusCoins（合计 200/月，见 §12.1） |
| 活动 | 限时 | ~40 | 周常 + 节日活动 |
| 称号（天梯段位） | 一次性，~11,900 满爬 | 摊薄 ~20 | 保留龙头（ADR-009） |
| 成就（里程碑） | 一次性，分阶 | 摊薄 ~10 | 保留龙头 |
| 战斗收益 | 分段胜利金币 `VICTORY_COINS_BY_RANK`（bronze/silver/gold=5、platinum/diamond=8、star/master=12、grandmaster/king=18，每日上限 `VICTORY_DAILY_WIN_CAP=10` 胜） | gold ~450 / king ~5,400（**独立龙头，不计入上面「日常任务」的 150**） | 见 ECONOMY_BALANCE §2.3b；月度全量核算见 [§6.4](#64-月度总产出核算2026-07-27审计补齐取代此前从未真正跑过的并入-9承诺) |
| 充值（IAP） | 见 ECONOMY_BALANCE §2.2 档位 | — | 付费主路；PvE/SLG 体验明显更好 |
| **首充双倍**（终身一次） | `FIRST_PURCHASE_BONUS_MULTIPLIER=2` | — | 账号生命周期内**第一笔**充值（任意档位）金币翻倍；代码权威 `server/shared/src/economy.ts`，`firstPurchasedAt`/`firstPurchaseUsed` CAS 门控（`commercial/src/service/base.ts`），客户端 Coins 页签徽标已接（`monetization.firstPurchaseUsed` 门控，见 `ShopScene` 首充 2× 徽标）。**本行为 2026-08-03 补登**——此前该常量早已随 Paddle IAP 一起上线（`e0f04939`），只是从未写进本文档，不是新拍板的数值 |

> **当前 `AD_COIN=10`**（2026-06-27 拍板，原 50 偏高已下调；与实装代码 `ADS_REWARD_COINS` 一致）。在 `ADS_DAILY_CAP=5` 下仅广告 ≤50/天 ≈ 1,500/月。**这一行的月度估算不含胜利金币/赛季峰值/战令免费轨——把这些一起算的月度总产出见 [§6.4](#64-月度总产出核算2026-07-27审计补齐取代此前从未真正跑过的并入-9承诺)（保守档 ~2,900、高段档 ~8,700），"早期~300/月目标"这条基线已彻底失效，不要再用它做判断**。

> **定位重申**：完全不想充值、又不想沦为陪衬的玩家，可以**只玩 PvP**（绝对公平、零养成参，见 §9）。
> 养成（金币/卡/装备）只让 PvE/SLG 体验更好，不碰 PvP。

### 6.2 广告金币：固定 10 coins/条 `[可调]`

- `AD_COIN = 10`（`ADS_REWARD_COINS`，`shared/economy.ts`）、每日 ≤5 条（`ADS_DAILY_CAP=5`）、每条间隔 ≥10 min（`ADS_MIN_INTERVAL_MS=10min`，2026-07-21 由 30min 下调——DailyScene「看广告」页签上线时拍板，间隔太长会让这条龙头形同虚设）。
- 与代码及 ECONOMY_BALANCE §2.1 一致（均为 10）。早期「50」「3 coins」「等值挂钩」提案均已弃（50 偏高，2026-06-27 下调至 10，上线后再议）。
- 服务器 dayKey 计数 + 冷却时间戳校验（C2 反作弊）。
- **客户端入口（2026-07-21 补齐）**：此前仅服务端 `/ads/reward` + 广告平台回调验签已实装，客户端从未接入——`DailyScene`「每日」页新增独立「看广告」页签（与「签到月历」「每日任务」并列，非任务池的第 4 项），展示今日已看/上限 + 领取按钮/冷却倒计时/上限态；`GET /retention` 响应新增 `ads: {watchedToday, cap, rewardCoins, cooldownMs, nextAvailableAt}` 供页签直接渲染，不必客户端自算冷却。
- **平台落地范围（2026-07-21 拍板）**：`IPlatform.hasRewardedAd()` 决定该页签是否显示——**没有真实广告可看的平台直接隐藏整个页签，绝不放模拟广告占位**。CrazyGames（其 SDK 自带 `requestAd('rewarded', …)`）恒真；微信小游戏用真实 `wx.createRewardedVideoAd`，`WECHAT_REWARDED_AD_UNIT_ID` 待运营在 mp.weixin.qq.com 建好激励视频广告单元后填入，填之前页签保持隐藏；原生 App（Capacitor iOS）已接 AdMob（`window.NWAds` 原生桥，`IAP_CREDENTIALS.md §2.1`，代码已写但未经 Xcode 编译验证）；纯网页（Paddle/`a.gamestao.com` 渠道，无原生桥可探测）仍是 `false`——需要接入 Google AdSense 的 H5 Games Ads（`Ad Placement API`，与 AdMob 是两套账号体系，AdMob 不支持网页）才会显示。

### 6.3 消耗（sink）

皮肤直购 / 抽卡 / 体力购买 / 装备强化（金币部分）/ 金币↔材料兑换（§6.5）。主 sink 见各节。
**注意**：装备膨胀靠分解回收 + 库存上限 1000 治理（ADR-012，[ADR-064](DECISIONS.md)，§5.3）；金币 sink 主要靠"持续强化的失败损耗"维持。

> **T7+ 单位卡等级：2026-08-03 拍板维持现状，明确定位为付费/抽卡专属**（不加免费加速通道）——本节此前提到的"直购单位卡包"是从未落地的设想，正式撤回；§4 末尾有完整说明与理由。

### 6.4 月度总产出核算（2026-07-27 审计补齐，取代此前从未真正跑过的"并入 §9"承诺）

> **背景**：§13.2/§13.3/§13.4 多处写"须并入 §9 总产出模拟"，但 §9（见下）实际是「与其他系统的硬墙」，从来不是一张产出模拟表——这条交叉引用一直是悬空的，§6.1/§8 的"~1,500/月"月度估算也从未把胜利金币（已实装 `VICTORY_COINS_BY_RANK`）、赛季峰值金币、战令免费轨并进来算总量。本节补齐这张表，**取代**§6.1 末尾"早期 ~300/月目标"这条已经名存实亡的基准线。

按活跃度/段位分两档核算「稳定活跃 F2P 每月总金币产出」（30 天月，6 周赛季按 `×30/42` 折月）：

| 来源 | 数值权威 | 保守档（金段/日均 3 胜） | 高段档（王者/日均 10 胜封顶） |
|---|---|---|---|
| 广告 | `ADS_REWARD_COINS=10 × ADS_DAILY_CAP=5` | 1,500 | 1,500 |
| 日常任务/签到 | RETENTION_DESIGN §12 | 150 | 150 |
| **签到里程碑 bonusCoins**（30+40+50+80=200/月，R1b，2026-08-01） | `shared/retention.ts` | 200 | 200 |
| 活动 | §14 | 40 | 40 |
| 称号（摊薄） | ECONOMY_BALANCE §2.4 | 20 | 20 |
| 成就（摊薄） | 同上 | 10 | 10 |
| **胜利金币**（`VICTORY_COINS_BY_RANK`，日上限 `VICTORY_DAILY_WIN_CAP=10` 胜） | `shared/economy.ts` | gold=5/胜 ×3 胜/天×30 = **450** | king=18/胜 ×10 胜/天×30 = **5,400** |
| **赛季峰值金币**（`SEASON_PEAK_COINS`，§13.2，每季按稳定峰值段位重复领） | `shared/season.ts` | gold=100/季 ×30/42 ≈ **71** | king=1,200/季 ×30/42 ≈ **857** |
| **战令免费轨**（§13.3，里程碑 60+150+90+220+120+320=960/季） | `shared/battlepass.ts` | 960 ×30/42 ≈ **686** | 同左 **686** |
| **月度合计** | — | **≈ 3,127** | **≈ 8,863** |

- **结论：无氪 F2P 的月度金币产出区间是 ~2,900–8,700，不是 §6.1 沿用至今的 "~1,500"（更不是最早的 "~300" 目标）**——胜利金币（高段 5,400/月）和赛季峰值（高段 857/月）是两个此前完全没被计入任何月度估算的变量，胜利金币尤其大，因为它是无日历上限的"只要天天打分段排位就有"的常青龙头（唯一门槛是 `VICTORY_DAILY_WIN_CAP` 每日 10 胜，对高活跃玩家形同虚设）。
- **对购买力的影响**：一次十连 1,350（§13.3 引用值）——保守档 ≈ 2.2 次/月，高段档 ≈ 6.4 次/月。§8「epic(1,800)≈5周」的估算只按 1,500/月广告算，实际高段玩家远快于此。
- **不是"经济崩了"，是"基线过时"**：`ADS_DAILY_CAP`/`AD_COIN` 这两个可调参数（§6.2）已经是 2026-06-27 拍板后的收敛值，胜利金币的 §2.3b 拍板本身也是有意的常青龙头设计——问题纯粹是**没人把两者放在一起重新核对总量、重新定基线**。上线前建议：①把本节的 3,127/8,863 当新基线（不是 300，也不是 1,500；2026-08-01 起含签到里程碑 bonusCoins 200/月，R1b）；②若仍嫌高，优先动 `VICTORY_DAILY_WIN_CAP`（结构杠杆最大）或 `SEASON_PEAK_COINS` 高段值，而非再压广告。
- **待续**：SLG 战力购买力（§13-SLG）、拍卖行成交额未纳入本表——SLG 是独立"卖战力"经济区（SLG7 天梯隔离），其金币产出/消耗应单独核算，不与本表的天梯/PvE 侧预算混为一谈。

### 6.5 金币↔材料兑换（2026-08-03 拍板落地）

商店新增两个材料直购档（`server/shared/src/economy.ts` `SHOP_ITEMS`，`kind='material'`），是此前"经济数值空白清单"里最后一项真正落地的：

| 商品 id | 售价 | 内容 | 单价（对照估值） | 每日购买次数上限 |
|---|---|---|---|---|
| `mat_buy_scrap` | 20 coins | scrap ×10 | 2 coins/个（§13-SLG.1 估值 1 coin-eq，~2×） | 5 次/天（=50 scrap/天） |
| `mat_buy_lead` | 105 coins | lead ×3 | 35 coins/个（§13-SLG.1 估值 16.67 coin-eq，~2×） | 6 次/天（=18 lead/天） |

- **定价依据**：直接复用 §13-SLG.1 已有的材料估值基准（`DUPE_REFUND_COINS`/`GACHA_MATERIAL_GRANTS` 反推：scrap=1 / lead≈16.67 coin-eq），加约 **2× 溢价**——刻意让这条通道比刷本/抽卡"贵"，只做"追赶手段"而非"绕开体力闸门的平价替代"，呼应 ADR-022"氪金买方便、不买上限/供给"红线（同 SLG 迁城令等便利类消耗的定价哲学）。
- **binding 不可直购**：最深材料继续只能刷本/抽卡产出，呼应 legendary 皮肤只走盲盒的 ADR-003（"最稀缺的一档必须留在概率/劳动通道里"）。
- **每日购买次数上限**（`MATERIAL_SHOP_DAILY_CAP`，Redis `bumpCappedCounter`，同 ads/pve 每日计数器机制）：按购买次数计（不是按材料个数），到点后 `shopBuy` 在扣费前拒绝（400），不会出现"扣了币发不出材料"的中间态。
- 落地：`server/metaserver/src/economy.ts`（`deliverOrder` 新增 `kind==='material'` 分支，走 `deliverMailGrant` 的 `materialInc` 参数）+ `service/economy.ts`（`shopBuy` 每日上限校验）+ 客户端 `ShopScene`（材料档在消耗品之后、皮肤之前渲染，标题用共享的 `material.*` 翻译 + 数量后缀）。
- **副产品修复**：实现过程中发现 `shopBuy` 一直把 `def.grants` 而非请求 `itemId` 传给 `deliverOrder` 的路由查找——`kind='item'`（如 `protect_enhance`）因为 `grants === id` 从未暴露，这次材料档首次出现 `grants !== id`（`mat_buy_scrap` → `scrap`）才使其现形（会被误当皮肤发放）。已随本次改动一并修复。

**2026-08-04 修复（用户截图报告 2 项）**：
1. **材料档图标错用程序 glyph，不是 AI 位图**：材料图标早在 §20.10/20.12（`EQUIPMENT_DESIGN.md`）就已从 `SketchPen` 程序绘制换成 AI 位图（`materialAtlas.ts`/`buildMaterialIcon`），装备页/抽卡揭示/每日签到/事件/战令都已切换，唯独 `ShopScene`（本节的材料直购档）当初没跟进，还在走 `buildCoinIcon`→`buildIcon` 的程序 glyph 回退路径（`scrap` 撕纸剪影/`lead` 削尖石墨条，在小尺寸下分别读成"书签"和"羽毛笔"，与游戏其它地方的位图观感不一致）。修复：`ShopScene/base.ts` `CardSpec` 新增 `materialKind` 字段，`drawCard` 材料档改走 `buildMaterialIcon`（`ShopScene/shop.ts` 材料循环设置 `materialKind: item.grants`）。
2. **每日限购档只写"限购次数有限"，不显示已购/上限**：`getShopItems`（`service/economy.ts`）新增 `dailyLimit`/`purchasedToday` 两个字段（`ShopItem` schema，`contracts/openapi/schemas.yml`）——材料档用现成的 `readCounterField`（`dailyCounter.ts`，只读，不占用 `bumpCappedCounter` 的计数）读当日已购次数；非限购商品两字段整体省略。客户端状态行改渲染"今日已购 {used}/{limit}"，到量后 Buy 按钮置灰 + 文案变"今日已达上限"（不必再靠一次失败购买才发现封顶），`onBuy` 购买成功后重新拉取 `/shop/items` 让计数实时刷新。

### 6.6 商店批量购买 `qty`（2026-08-10 性能修复）

**问题**（用户截图报告）：`protect_enhance` 的"×10"按钮点一下要转很久，明显比其它请求慢。根因：`ShopScene/actions.ts` 的 `onBuyBulk` 在一个 busy-lock 下**顺序**发 10 次独立 `POST /shop/buy`（每次 await 完才发下一次），而单次 `/shop/buy` 本身就是 client→meta→Redis + meta→commercial（内部 HTTP）→Mongo + meta→Mongo 三级串联——买 10 个等于把这条链路原样跑 10 遍且完全排队，而不是网络拥堵。

**修复**：`POST /shop/buy` 新增可选 `qty`（默认 1，`contracts/openapi/paths/economy.yml` 校验 `1–20`，`SHOP_BUY_MAX_QTY` 常量同步兜底防御），服务端一次请求内完成"校验每日上限（若有）→ 扣费 `cost×qty` → 发货 `qty` 份"，全链路只走一次，不再是客户端循环。语义是**全有或全无**：余额不够整批或每日限购容不下整批 `qty`，整单直接拒绝、分文不扣、一件不发——不做"买到第几件算第几件"的部分成交，这与"×10"按钮本来就要求 `coins ≥ cost×10` 才可点是同一假设，不需要额外的部分发货记账。

- **落地范围**：`shared/dailyCounter.ts`（`bumpCappedCounter` 新增 `by` 参数，一次性按 `qty` 增量+校验每日计数器，超额整体回滚不留半截）、`commercial/service/shop.ts`（`shopCharge` 新增 `qty`，`cost` 仍是目录单价、按 `cost×qty` 一次扣款+记账，`qty` 落盘到 `OrderDoc.result` 供崩溃后对账重放）、`metaserver/service/economy.ts`（`shopBuy` 读取/钳制 `qty`）、`metaserver/economy.ts`（`deliverOrder` 按 `qty` 发货：`kind='item'` 按份数 `$inc`、`kind='material'` 按"每份 `qty` 个 × 请求 `qty`"、皮肤按 `qty` 份各生成一个真实实例）。
- **客户端**：`ShopScene/actions.ts` `onBuyBulk` 从"循环 10 次 `cb.buy(itemId)`"改为一次 `cb.buy(itemId, 10)`；`ApiClient.shopBuy(itemId, qty?)` 透传。
- **兼容性**：`qty` 缺省 = 1，行为与改动前逐字节一致；`server/contracts/openapi.yml`/`client/src/net/openapi.ts` 随 `npm run gen:api:contracts && gen:api:server`（metaserver）/`npm run rest:gen`（client）重新生成。

---

## 7. 皮肤（skins）获取矩阵

稀有度沿用四色（`UI rarity`）：common 灰 / rare 蓝 / epic 紫 / **legendary 橙**（`#e08a2c`）。

| 稀有度 | 获取方式 | 备注 |
|---|---|---|
| common 灰 | **金币直购** | |
| rare 蓝 | **金币直购** | |
| epic 紫 | **金币直购**（1,800） | 商店可购（与 ECONOMY_BALANCE §3.1 一致） |
| legendary 金/橙 | **仅抽卡** | 最高级只走盲盒（保稀缺） |
| 活动限定（任意色） | **直接购买** | 限时上架 |

定价参数 `[可调]`：

| 项 | 默认 | 说明 |
|---|---|---|
| common 皮肤 | 300 coins | |
| rare 皮肤 | 800 coins | |
| epic（可购） | 1,800 coins | 与 ECONOMY_BALANCE §3.1 / 代码 `SHOP_ITEMS` 一致 |
| 抽卡单抽 | 见 ECONOMY_BALANCE 盲盒（保底/RNG 权威在 commercial） | epic 高级/legendary 唯一来源 |
| 活动限定 | 按活动定价 | |

> 铁律（ADR-003）：皮肤纯 cosmetic，绝不动敌我蓝红、不给数值/识别优势。

---

## 8. 演算示例（便于调平衡）

- **F2P 金币**：广告 10×5 = 50/天上限（~1,500/月）+ 任务/活动/称号/成就。攒 common 皮肤(300) ≈ 6 天、epic(1,800) ≈ 5 周（**仅靠广告算，未计入胜利金币/赛季峰值/战令——把这些一起算的真实月度总产出与 F2P 实际购买力见 [§6.4](#64-月度总产出核算2026-07-27审计补齐取代此前从未真正跑过的并入-9承诺)，高段玩家远快于此**）。付费可瞬间拉满。
- **单位养成**：底层刷 T1 慢，但**后期关直产 T3 卡**（=25 T1 当量）大幅提速；F2P 主力 T5–T6（数周–数月），T9 靠付费/抽卡/拍卖。
- **装备养成**：+8→9 仅 10% → 平均 10 次/级，整套 3 件 +9 ≈ 鲸鱼级；失败只损材料不碎。
- **体力闸门**：240 自然体力 = 24 普通关/天（定额 10/关），限死刷量；多刷靠氪体力（30 金币/60 体力，定额）或等次日。

---

## 9. 与其他系统的硬墙

- 所有单位/装备养成**仅注入 PvE 蓝图**（`buildCampaignBlueprints`/`buildSiegeBlueprints`），PvP 永走 `buildPvpBlueprints()` 零养成参（见 [`PVE_INTEGRITY_PLAN.md`](PVE_INTEGRITY_PLAN.md) / SLG_DESIGN §6.1）。
- SLG 与 PvE **共用同一棵养成树**（材料/卡/装备通用），但都对天梯零影响。
- 数据权威全在服务器（ADR-006）：体力/卡/材料/养成/金币客户端只读，变更走 API。

---

## 10. 可调参数总表（演算入口）

| 参数 | 默认 | 域 |
|---|---|---|
| `STAMINA_MAX` | 120 | 体力 |
| `STAMINA_REGEN` | 1/6min (240/天) | 体力 |
| `STAMINA_REFILL_COIN` | 30 金币 → +60（定额，无递增/无每日上限） | 体力 |
| 普通/精英/Boss/活动 体力消耗 | 均 10（定额，2026-07-06） | 关卡 |
| 各关材料产出倍率 | 1 / 2.2 / 3.5 | 关卡 |
| T1 卡掉落期望 | 0.5/普通关 | 关卡 |
| 合成系数 | 5→1（固定，指数） | 单位 |
| 单位满级 | 9 | 单位 |
| 每级加成 HP/攻/攻速/移速/护甲 | 12/10/4/3% + armor1（L9=+8） | 单位 |
| 单位养成特性 T3/T6/T9 | 暴击(10%/×1.5) / 吸血(15%) / +1出兵 | 单位 |
| armor 公式 | flat：max(1, dmg−armor) | 单位 |
| 后期关 T3 卡掉率 | `[可调]` | 关卡 |
| 装备槽位 | 武器/护具/饰品 ×3 | 装备 |
| 装备成功率 +0→9 | 90→80→70→60→50→40→30→20→10% | 装备 |
| 装备失败后果 | 损材料、不掉级、不碎 | 装备 |
| 装备分解返还 / 等级门槛 | 70% 打造材料 / +5 起不可分解 | 装备 |
| 装备库存上限 / 同时挂拍 | 1000 实例（堆叠不计，ADR-064 2026-08-10 由 300 扩容）/ 5 件 | 装备 |
| `AD_COIN` / 上限 / 冷却 | 10 / 5 条每天 / 10 min | 金币 |
| F2P 月金币（实际） | ~1,500 上限（广告 ≤50/天，§6.1 上线后再议） | 金币 |
| 首充双倍 `FIRST_PURCHASE_BONUS_MULTIPLIER` | 2×（终身一次） | 金币 |
| 金币→材料兑换 scrap/lead 单价 / 每日购买上限 | 2/35 coins 个 / 5/6 次天（§6.5） | 金币 |
| 皮肤价 common/rare/epic | 300/800/1800 | 皮肤 |

---

## 11. 开放问题

- [ ] **战斗数值随护甲重新演算**（armor 落地引擎时配套重做 TTK/交战平衡，更新 BALANCE.md）—— 独立任务。
- [ ] 装备系统后期完善（差异化加成、是否加掉级/碎裂硬档 + 保护道具氪点）—— §5 现为俗套基线。
- [x] ~~单位养成特性后期做"每单位差异化特性"~~ → **2026-08-05 落地（v1，T9-only）**，见 §4.4 详述——Archer/ShieldBearer/Lena/Mara/Max 各有专属 T9 效果，Infantry 保留通用兜底；T3/T6 仍全兵种通用（范围决定，避免重开平衡工程）。
- [x] ~~T7+ 卡获取通道调参~~ → **2026-08-03 拍板：不加免费加速通道，明确定位付费/抽卡专属**，见 §4 末尾详述（F2P 现实止步 L5–L6）。
- [x] ~~碎片兑换表~~ → **2026-08-03 正式放弃**，见 §15.6（`DUPE_REFUND_COINS` 未接入真实发货路径，重复卡本就是融合燃料，不值得新开一套服务器权威碎片系统）。
- [x] ~~金币→材料兑换~~ → **2026-08-03 落地**，见 §6.5（scrap/lead 可直购，binding 不可购，均带每日上限）。
- [x] ~~首充双倍奖励~~ → 早已是代码常量（`FIRST_PURCHASE_BONUS_MULTIPLIER=2`），本次仅补登文档，见 §6.1。
- [ ] 体力具体数值最终拍板（现为提案默认）；是否随账号等级成长。
- [ ] F2P 月度 ~300 金币的各龙头分配最终调参（任务/活动/称号具体数额）——注：本行基线本身已被 §6.4 的月度总产出核算取代，"~300"已不是当前判断依据。
- [x] ~~稀有度命名统一~~ → **legendary = 橙 `#e08a2c`**（已定 2026-06-21）。
- [ ] 首通奖励具体内容表（剧情/碎片/材料数额）。
- [ ] 留存数值（签到月历奖励表 / 每日任务满点阈值与金币 / 周常宝箱）最终拍板 + 模拟验证（见 §12，机制 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)）。
- [~] 赛季/战令数值（§13）：软重置基准 1200 / 段位首达·峰值金币 / 战令曲线已铺提案；**赛季峰值金币（每季可重复，高段持续 faucet）须并入 §9 总产出模拟**——最需控量的新变量。
- [~] 活动数值（§14）：加成期乘子封顶 / 积分清零 / 月度归口已铺；具体活动配置（里程碑阈值/积分产出/兑换表）随每次活动 admin 配置，引用本节封顶不另定。

---


---

**接下页** → [`ECONOMY_NUMBERS_LIVEOPS.md`](ECONOMY_NUMBERS_LIVEOPS.md)：§12 留存、§13 赛季战令、§13-SLG 大世界持久经济、§14 活动、§15 角色卡。
