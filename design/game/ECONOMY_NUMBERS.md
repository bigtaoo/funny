# 经济数值演算表（ECONOMY_NUMBERS）

> 状态：设计中 · **权威：本文（经济/养成数值的单一可信源）** · 更新：2026-06-21
>
> 本文是**经济与养成数值的演算沙盘**：所有可调参数集中在 §10，公式 + 派生表 + 演算示例便于调平衡。
> 与 [`ECONOMY_BALANCE.md`](ECONOMY_BALANCE.md) 分工：那份讲**为什么**（faucet/sink 哲学、鲸鱼天花板、反通胀），本份讲**多少**（数字）。
> 战斗运行数值（HP/攻/速）见 [`BALANCE.md`](BALANCE.md)；本文只管经济/养成。
> 标 `[可调]` 的是默认提案，待调参；标 `[DRAFT]` 的是结构待你拍板。

---

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
> - 换句话说：**本节 §4.1 的合成表不是"废案"，而是换了皮的现役数学**——Hero Roster 融合（`@nw/shared/cards.ts`：`FUSION_MATERIAL_COUNT=5` 同阵营同等级卡 → 目标 +1 级，`MAX_CARD_LEVEL=9`）本质仍是 5→1 指数模型，到 L 级总耗卡量仍是 `5^(L-1)`，与上表数字完全对得上（表头"T1..T9"直接读作"角色卡等级 1..9"即可，唯一变化是"合成对象"从「兵种卡」变成「角色卡」、且材料判定是**同阵营**——陶奇三人互通、Anna 三人互通——而非严格同兵种）。
> - **两条活的卡来源**（喂给上面这套融合公式）：① **抽卡**（`GACHA_POOLS` 常驻池）：陶奇三人各 4.97%/抽（合计 14.91%），Anna 三人各 0.8%/抽（合计 2.4%）；② **关卡掉卡**（上面的 `levelCardReward`，20 张/天封顶）：专精刷同一副本可稳定获得对应兵种的角色卡，是 F2P 的确定性主路径。
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
  - `m_crit`（饰品主词条，与移速二选一）：暴击**率** base 6 点，随强化放大（+9 ≈ 11.4 点）。
  - `s_critmult`（rare/epic 副词条）：暴击**伤害** +15..30%（引擎 `value/100` 加到倍率）。
  - 跨源封顶（EQUIPMENT_DESIGN §7.7，引擎 `EFFECT_CAPS`）：暴击率 T3+装备 Σ ≤ **50%**；暴击倍率 T3 基础 1.5× + `s_critmult` Σ ≤ **2.5×**。

### 5.2 强化成功率（每升一级 −10%）

每次强化消耗材料（+ 金币），**成功率每往上一级降 10%**，0→1 起 90%、8→9 仅 10%（**代码权威** `enhanceSuccessRate()`，`shared/src/equipment.ts` §99-105：`(EQUIP_MAX_LEVEL - fromLevel) / 10`；下表此前漏列 +0→1 一档，与 §5.4 期望成本表/EQUIPMENT_DESIGN §6.1 不一致，已按代码补齐）：

| 升级步 | +0→1 | +1→2 | +2→3 | +3→4 | +4→5 | +5→6 | +6→7 | +7→8 | +8→9 |
|---|---|---|---|---|---|---|---|---|---|
| 成功率 | 90% | 80% | 70% | 60% | 50% | 40% | 30% | 20% | **10%** |

- **失败后果**：**不掉级，只损耗本次材料/金币**（俗套温和档——强化失败不毁装备；销毁仅走分解，见 ADR-012 / EQUIPMENT_DESIGN §6.3）。
- **期望成本**：升到 +9 的期望尝试次数 = Σ(1/p)；如 +8→9 平均 10 次、+7→8 平均 5 次……**整套 3 件 +9 是鲸鱼级长期目标**，正是充值动机所在。
- `[可调]` 后期可加更狠档：失败掉级 / 碎裂 + 保护道具（氪点）——现不做。

### 5.3 长期通胀提示
**金币/材料 sink 主要来自"反复强化的失败损耗"**（高级低成功率 = 持续吞材料）。膨胀治理已上 [ADR-012](DECISIONS.md)：**分解回收**（+0~4 返 70%，30% 损耗本身是温和 sink）+ **库存硬上限 300 实例**封顶（堆叠件不计），机制权威见 EQUIPMENT_DESIGN §3.3 / §6.3。高级件（+5↑）不可分解，出口走拍卖/穿戴。

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
**注意**：装备膨胀靠分解回收 + 库存上限 300 治理（ADR-012，§5.3）；金币 sink 主要靠"持续强化的失败损耗"维持。

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
| 装备库存上限 / 同时挂拍 | 300 实例（堆叠不计）/ 5 件 | 装备 |
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

## 12. 留存系统数值（签到 / 每日任务 / 周常）`[DRAFT]`

> 机制权威：[`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)；本节为**数字单一源**。铁律：金币绝大部分从「每日任务满点」出，月度严格收敛进 §6.1「日常任务/签到 ~150/月」格；签到里程碑格另加一笔小额 `bonusCoins`（R1b，见下，200/月，独立计，不算重新拍板 §6.1 的 150）。

### 12.1 每日签到（月历式，代码权威 `CHECKIN_REWARDS`，2026-08-01 修订）

奖励主体是**材料**（scrap/lead/binding，受体力闸门/养成树自然约束，不进金币通胀推演）+ 里程碑的卡/装备。**不发体力**（2026-08-01 前曾发体力，因体力上限 120、自然回复 10/小时、玩家常在接近/顶到上限时领取而常态性溢出浪费，已改为材料，见 RETENTION_DESIGN §10.5）。30 格月历，里程碑大奖在第 7/14/21/30 格，**每格额外带一笔 `bonusCoins`**：

| 格位 | 普通格奖励 | 里程碑大奖 | 里程碑 `bonusCoins` |
|---|---|---|---|
| 普通格（26 格，非里程碑） | 材料（scrap ×3 或 lead ×2，轮换；第 26 格 binding ×1） | — | — |
| 第 7 格 | — | 材料包（lead ×5） | **+30** |
| 第 14 格 | — | 角色卡 ×1（`pickRandomCatalogItem('card')` 均匀随机） | **+40** |
| 第 21 格 | — | 中级材料包（lead ×5） | **+50** |
| 第 30 格（月末压轴） | — | 装备 ×1（`pickRandomCatalogItem('equip_t1')` 均匀随机） | **+80** |

- 签到里程碑 `bonusCoins` 合计 **200/月**（R1b，2026-08-01）：远小于日常任务 150/月、战令 960/月、排位赛最高 5,400/赛季等既有金币龙头，判断为可忽略量级，未跑 econ-sim；若后续继续加大，需回来跑。
- 常规格材料量级刻意压得很低（月度合计约几百 coin-eq，估值基准见 §13-SLG.1），远小于正常刷关产出（~178,360 coin-eq/月，§13-SLG.3），只是"顺手甜头"，不冲养成节奏。
- 跨月（`monthKey`）重置；漏签不回退（温和档，R5）。

### 12.2 每日任务（金币唯一出口，日上限）

| 参数 | 默认 `[可调]` | 说明 |
|---|---|---|
| 当日任务数 | 3~4 条 | 前期固定全集，不随机派发 |
| 每条任务点 | 1 点 | 完成即加（服务器结算点） |
| 当日满点阈值 | 3 点 | 完成大部分任务即满 |
| **每日任务完成金币** | **5 coins/天** | 每日任务达标即得（代码 `retention.ts DAILY_COINS_REWARD=5`，=150/月；与 §12.4 一致）；与广告 50/天并列为两条常规金币 faucet（签到里程碑 `bonusCoins` 200/月是第三条，量级小一个数量级，见 §12.1） |
| 重置 | 自然日 `dayKey`（服务器时区） | 任务点不跨日 |

> 每日金币 = 广告 50/天 + 每日任务完成 5/天 ≈ **~55 coins/天**。每日任务月度 = 5 × 30 = **~150/月**（对应 §6.1「日常任务/签到」格）；签到里程碑 `bonusCoins` 200/月单独计（R1b，§12.1），调平衡只动「每日任务完成金币」「广告」「签到里程碑 bonusCoins」，不另立第四条。

### 12.3 周常活跃宝箱 `[可调]` ✅ 2026-08-05 已实现，三档奖励 2026-08-08 调整（见下）

| 档 | 周活跃点阈值 | 宝箱内容 |
|---|---|---|
| 一档 | **9**（3 天满勤） | 中级材料包（`mat_lead` ×20） |
| 二档 | **15**（5 天满勤） | 低级装备（`equip_t1` 随机抽，同签到月末装备格走法） |
| 三档 | **21**（7 天满勤/满周） | 一张传说卡（Anna 阵营 `max`/`lena`/`mara` 随机抽，界面呈橙色；**2026-08-08 前**是一件商城皮肤，见下方修正 3） |

- 周活跃点 = 每日任务点（`pve.clear`/`pvp.match`/`gacha.draw` 各 1 分）按 ISO `weekKey` 累计，与每日任务点同一个结算入口（`accrueRetentionTask`），共用其幂等判定；跨周（ISO `weekKey`）重置。
- **相对原提案的修正（实现/调整过程中发现原占位数值/内容有硬伤，或产品反馈分量不够）**：
  1. **阈值从 30/60/100 改成 9/15/21**——每日任务点上限是 3（3 个任务各 1 分），一周顶多攒 21 分，原来的 30 分永远碰不到，功能会生下来就是死的。改成"3/5/7 天满勤"三档，保留"递进三档、顶档=近乎满周"的设计意图，但真的够得着。
  2. **三档"限定皮肤碎片"改成一件普通商城皮肤（2026-08-05）**——全仓库没有"碎片"这个货币概念（皮肤只支持整件发放，`server/metaserver/src/skin.ts`），从零建一套碎片累计+兑换子系统超出这次的范围；改成直接发一件 `skin_shop_*`（非限定，不含 gacha 稀有皮肤 `skin_e1/e2/l1`，避免免费周常白送 legendary）。
  3. **三档"商城皮肤"再改成"随机传说卡"（2026-08-08，产品反馈）**——一件普通商城皮肤对需要满周活跃才够到的顶档奖励而言分量偏轻；改为 `pickRandomCatalogItem('card', rng, 'legendary')`（新增 `rarity` 过滤参数）从 Anna 阵营卡里随机抽一张，比商城皮肤更有分量，也比 checkin 第 14 天"全品阶随机卡"里程碑更稀有——匹配这一档更高的门槛（7 天满勤/满周 vs checkin 的月历第 14 格）。原 `WEEKLY_CHEST_SKIN_POOL`/`pickWeeklyChestSkin` 随之删除（唯一调用点已不存在，未保留兼容垫片）。
- 实现：`server/shared/src/retention.ts`（`makeWeekKey` 新增 ISO 周算法、`WeeklyData`/`WEEKLY_CHEST_TIERS`/`claimWeeklyTier`）→ `server/shared/src/gachaCatalog.ts`（`pickRandomCatalogItem` 新增可选 `rarity` 过滤参数）→ `server/metaserver/src/service/liveops.ts`（`getRetention` 附带 weekly 字段、新增 `claimWeeklyChest`，tier-3 走 `settleWeeklyChestReward` 的 `'card'` 分支）→ `POST /retention/weekly/claim`（`server/contracts/openapi/paths/liveops.yml`）→ 客户端 `DailyScene` 新增第四个 tab（复用 `renderDailyTasks` 的卡片+进度条+领取按钮样式，未新建场景）。测试：`server/shared/test/retention.test.ts`、`server/shared/test/gachaCatalog.test.ts`（`pickRandomCatalogItem` 稀有度过滤）、`server/metaserver/test/retention.e2e.test.ts`（真实 Mongo，tier-3 + 发放弹性用例）、`client/test/retention.test.ts`、`client/test/ui/dailySceneWeeklyTab.ui.ts`（三种奖励类型各自的领取 toast 文案 + 领取失败的 error toast/busy 复位）。详见 [`RETENTION_DESIGN.md §10.8`](RETENTION_DESIGN.md)。

### 12.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| 签到月历格数 | 30（月历式） | 留存 |
| 签到里程碑格 | 7/14/21/30 | 留存 |
| 签到常规格 | 材料（不发体力，2026-08-01 起） | 留存 |
| 签到里程碑 bonusCoins | 30/40/50/80（=200/月，R1b） | 留存 |
| 每日任务数 / 满点阈值 | 3~4 / 3 点 | 留存 |
| 每日满点金币 | 5 coins/天（=150/月） | 留存 |
| 周常档阈值 | 9/15/21（2026-08-05 定案，见 §12.3） | 留存 ✅ |

---

## 13. 天梯赛季 / 战令数值（赛季时钟 · 软重置 · 峰值/首达金币 · Battle Pass）`[可调]`

> 机制权威：[`SEASON_DESIGN.md`](SEASON_DESIGN.md)；本节为**数字单一源**。提案值已内联进 SEASON_DESIGN §13A.1（`@nw/shared` 常量），本节收口登记并补经济约束。
> 铁律（SEASON S5 / ADR-009）：赛季/战令金币**计入 §6.4 月度总产出核算**（取代已失效的"§6.1 月度 ~300 预算"提法），不另立持久龙头；奖励**绝不进 PvP 蓝图**。

### 13.1 赛季时钟 / 软重置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `SEASON_DURATION_MS` | 6 周 | 天梯赛季时长；仅展示「预计结束」，硬切换由 admin 手动（SEASON §3.1） |
| `SEASON_RESET_BASELINE` | **1200**（= 黄金下限） | 软重置基准：`softReset(elo)= elo>基准 ? round((elo+基准)/2) : elo`（只压不抬） |

> 调高基准 → 强者每季保留更多分；调低 → 生态更平。天梯 6 周 ≠ SLG 大区 2 月（两条独立时钟，[`SEASON_OVERVIEW.md`](SEASON_OVERVIEW.md)）。

### 13.2 段位金币（首达 vs 峰值，两条独立账本）

- **首达金币 `FIRST_REACH_COINS`**：终身一次/段（`reachedRanks` 账本），升降不重复发。镜像 [`ECONOMY_BALANCE.md §2.3a`](ECONOMY_BALANCE.md)。
- **赛季峰值金币 `SEASON_PEAK_COINS`**：**每季可重复领**（按当季峰值段位），是高段玩家的持续 faucet——**最需控量的新 faucet**。现值见上表（青铜/白银=0，黄金起 100…王者 1,200，约首达的 25–34%），待 §9 总产出模拟持续确认。

| 段位 | 首达金币（终身一次） | 赛季峰值金币（每季） |
|---|---|---|
| bronze 青铜 | 100 | 0 |
| silver 白银 | 200 | 0 |
| gold 黄金 | 400 | 100 |
| platinum 铂金 | 700 | 200 |
| diamond 钻石 | 1,000 | 350 |
| star 星耀 | 1,500 | 500 |
| master 大师 | 2,000 | 700 |
| grandmaster 宗师 | 2,500 | 900 |
| king 王者 | 3,500 | 1,200 |

> 数字权威 = `server/shared/src/season.ts`（`FIRST_REACH_COINS` / `SEASON_PEAK_COINS`）。青铜/白银峰值金币现为 **0**（低段发币无意义且会激励刷小号）。
> **月度摊薄**：首达是一次性（爬满 ~11,900 摊薄进 §6.1「称号」行 ~20/月）；峰值金币按高段玩家每季实际峰值估，**已并入 §6.4 总产出核算表**（高段稳定王者 = 每季 1,200 × 30/42 ≈ 857/月，**这是此前完全没被计入任何月度估算的主要变量之一，调参时优先盯它**——注：本行此前写"月均~600"是未按 6 周赛季精确折月的旧估算，§6.4 已按 `×30/42` 重算为 857）。

### 13.3 战令 Battle Pass `[可调]`

| 参数 | 默认值 | 说明 |
|---|---|---|
| `BP_MAX_LEVEL` | 30 | 战令满级 |
| `BP_XP_PER_LEVEL` | 600 | 等差直线初版（每级等量，代码 `battlepass.ts=600`）；非线性曲线后置 |
| `BP_XP_RANKED_WIN` | 120 | ranked 胜一局经验 `[待模拟]` |
| `BP_XP_RANKED_LOSS` | 40 | ranked 负一局经验 `[待模拟]` |

- **免费轨打满约束**：`BP_MAX_LEVEL × BP_XP_PER_LEVEL / 经验日均 ≈ 42 天`（须满足「正常活跃 F2P 6 周打满免费轨」，`ECONOMY_BALANCE §2.6`）。当前 `30 × 600 = 18,000` 总经验，日均经验须约 ~430 才 6 周打满（`BP_XP_PER_LEVEL` 已从 1000 下调到 600）。任务点→XP 系数等其余来源待 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md) 落地后补（本轮经验仅 ranked 产出，SEASON §13B.0-D1）。
- **免费轨金币上限**：整季免费轨金币总额须 **< 一次十连**（`ECONOMY_BALANCE §2.6`；免费轨合计 960 < 1,350 ✅），已并入 [§6.4](#64-月度总产出核算2026-07-27审计补齐取代此前从未真正跑过的并入-9承诺) 月度总产出核算。
- **付费 Pass 定价**：对标 `ECONOMY_BALANCE §2.2` 小档 ¥6 区间（变现脊梁 + sink）。
- **奖励表重规划（`BATTLEPASS_DEFS`，2026-07-03）**：两轨均**递进**——材料档随等级爬升 scrap→lead→binding 且数量渐增；整 5 级里程碑必发金币且逐段增大，收束于 Lv30 的赛季大奖。仅用 `coins` / `material`（claim 路径实发的两类）；不发卡/皮肤（卡会进 PvP 战力、皮肤属变现脊梁，均排除）。数字 `[可调]`：改 `@nw/shared/battlepass.ts` 的 `REWARD_ROWS` → 同步 client `battlepassDefs.ts` → 回写本节。
  - **免费轨**：里程碑金币 Lv5/10/15/20/25/30 = 60/150/90/220/120/320（**合计 960**，满足「整季 < 一次十连 1,350」上限）；其余级发材料（前段 scrap 2→6、中段 lead 1→4、后段 binding 1→4）。材料在 `/battlepass/claim` 响应内与领取标记原子写入 `save.materials`。
  - **付费轨**：多数级发金币（变现龙头，逐段 20→50），少数级发更厚材料包（Lv3 scrap5 / Lv7·12 lead / Lv17·22·27 binding 2→4）；里程碑金币 Lv5/10/15/20/25/30 = 60/220/90/320/120/**520**（Lv30 为全轨最大单发）。每级付费金币 ≥ 同级免费。

### 13.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| `SEASON_DURATION_MS` / `SEASON_RESET_BASELINE` | 6 周 / 1200 | 赛季 |
| `FIRST_REACH_COINS`（9 段） | 100…3500（累计 11,900） | 赛季（终身一次） |
| `SEASON_PEAK_COINS`（9 段） | 0…1200（青铜/白银=0） | 赛季（每季可重复，控量重点） |
| `BP_MAX_LEVEL` / `BP_XP_PER_LEVEL` | 30 / 600 | 战令 |
| `BP_XP_RANKED_WIN/LOSS` | 120 / 40 | 战令 |
| 付费 Pass 价 | ¥6 区间 | 战令（变现） |

---

## 13-SLG. SLG 大世界持久经济数值（settle 结算奖励 · 材料估值 · A 轨聚合）`[DRAFT]`

> 机制/核验权威：[`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)（核验方法/判据/签字）+ [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) §17/§21；本节为 **SLG DRAFT 数字单一源** + econ-sim 基准结论。
> 铁律（SLG_ECONOMY_CHECK §0.1 / §1，2026-06-30 拍板）：SLG 是「时间长得多的一场对战」，局内一切（赛季资源粮铁木/领地/城建/兵力/繁荣度）**季末全清**，唯一带出赛季的持久产出 = **settle 结算奖励（发到排名宗门每个成员，per-head）+ 日常/活动少量材料（细水）**。国民产出加成 `0.10`、防御加成 `0.15` 等是**纯季内节奏，永不进 §6.1 月度金币预算**。`SETTLE_REWARDS.coins` 维持 **0**（任何 >0 走 §2.4 签字并入 §6.1）。

### 13-SLG.1 材料 → 金币估值基准（保守上界，§2.4）

项目无显式材料定价。从**已发布常量自洽反推**（econ-sim `valuation.ts` 据此自动计算，永不与代码脱节）：

```
value(material) = DUPE_REFUND_COINS[该材料所在 gacha 稀有度档] / GACHA_MATERIAL_GRANTS[mat_*]
```

| 材料 | gacha 档 | dupe 退币 | 单格发放量 | **估值（coins/个）** |
|---|---|---|---|---|
| `scrap` | common | 10 | 10 | **1.00** |
| `lead` | rare | 50 | 3 | **16.67** |
| `binding` | epic | 400 | 1 | **400.00** |

> 取 epic 高退币值给 binding ⇒ **偏保守（高估 settle 产出）**，过则真过。`binding=400` 是**全部聚合结论的最大杠杆**——它独占 champion 人均价值的 ~84%，也是头部倾斜判据爆表的根因。调估值优先动这里。
> 旁证（非主依据）：单抽 150 coins、装备打造 `wp_marker(rare)=lead6+binding2` 等量级与上表同序，不矛盾。

### 13-SLG.2 settle 可调参数表（`@nw/shared/slg.ts`，DRAFT）

| 参数 | 默认 | 域 | 说明 |
|---|---|---|---|
| `SETTLE_REWARDS.champion.items` | scrap500/lead200/binding50 | settle | rank1 宗门**每成员** |
| `SETTLE_REWARDS.top3.items` | scrap300/lead120/binding25 | settle | rank2–3 每成员 |
| `SETTLE_REWARDS.top10.items` | scrap150/lead60/binding10 | settle | rank4–10 每成员 |
| `SETTLE_REWARDS.participant.items` | scrap50/lead20/**binding0** | settle | 其余全部人头（主导项） |
| `SETTLE_REWARDS.*.coins` | **0** | settle | 红线：保持 0 |
| `CENTER_CAPITAL_MULT` / `CENTER_CAPITAL_IDX` | ×2 / 9 | settle | 持中原首府的宗门成员材料 ×2 |
| `WORLD_CAPACITY` | **500**（ADR-032，2026-07-07 起；此前本表长期记 10000 已过期未同步——`prosperity.ts` 早在 2026-07-07 就把常量从 10000 降到 500，本节 §13-SLG.3 的三场景 JSON 从未跟着重算，见 §13-SLG.6） | 运维 | 单 shard 人口上限（触发开新 shard）→ shard 数 |
| 细水（日常/活动材料/人/日） | 场景输入 | settle | §0.1 计入 A 轨聚合 |

繁荣度三参 `PROSPERITY_W_*`(10/50/5)、`PROSPERITY_DECAY_PER_DAY`(0.05)、`SECT_FOUND_PROSPERITY_MIN`(2000)、`sectStrengthScore` 权重、国民加成 0.10/0.15、碾压结算阈值**不在本节经济预算内**（分属 SLG_ECONOMY_CHECK B/C/D/E/F 轨，各自核验，登记见该文档）。

### 13-SLG.3 演算示例（econ-sim 三场景，2026-06-30 首跑）

工具：`server/tools/econ-sim/`（纯 TS，import `@nw/shared`，不连库，对标 difficultySim）。跑法 `npx tsx src/index.ts`。口径固定 per-head（§2.2），场景差异 = 人口 × 宗门人数分布 × 首府持有率。

基准（per-player 月度常规材料刷量 = 40 关/日 ×30 ×0.7 复刷 × 中段普通关掉落 = **~178,360 coin-eq/月**）。

| 场景 | 人口 | settle 全服月度 coin-eq | champion 人均/季 | participant 人均/季 |
|---|---|---|---|---|
| conservative | 20k | 16.1M | 47,667c | 383c |
| baseline | 50k | 85.7M | 47,667c | 383c |
| aggressive | 100k | 714.5M | 47,667c | 403c |

判据对照（三场景一致）：

| 判据 | 视角 | 门控 | 结果 | 数 |
|---|---|---|---|---|
| **人均稀释**（participant） | 人均 | 是 | ✅ PASS | 0.11%（≪15%）|
| **人均稀释**（champion 最坏头） | 人均 | 是 | ✅ PASS | 13.36%（<15%，贴边）= 头部倾斜的真护栏 |
| **全服通胀（vs 材料龙头·正确口径）** | 全服 | 是 | ✅ PASS | 0.45% / 0.96% / 4.01%（≪10%）|
| **coin 子项** | — | 是 | ✅ PASS | Σcoins=0 |
| 头部倾斜（champion/participant 人均） | 人均 | **否·informational** | ~118–124× | 已降级非门控（见 §13-SLG.4-2）|
| 全服通胀（vs 金币龙头·跨类参考） | 全服 | 否·informational | 67%–595% | 量纲错配·名义换算（见下注）|

> **CORE 判决（仅看门控行）= 三场景全 PASS ✅**（conservative / baseline / aggressive）。

### 13-SLG.4 结论与待拍板

1. **安全主结论 ✅**：settle **不撑爆持久经济**。人均稀释（养成体验）与全服通胀（材料龙头同单位口径）在保守估值（binding=400）+ 激进场景（10万人/满编宗门）下仍 ≪ 阈值——A 轨「不破红线」成立。**coin 子项 = 0**，红线 1 自然满足。**三场景 CORE 全 PASS**。
2. **头部倾斜：已降级为 informational（2026-06-30 经济负责人拍板，采纳方案 a）**：champion 人均 ≈ participant 的 ~118–124×，纯结构性（participant `binding=0`，champion `binding=50(×2)`，binding 估值 400）。**决定：不设头部倾斜硬墙**——per-head 口径下「冠军该多拿」，10× 对竞技 SLG 过严；真正护栏是 **champion 绝对人均稀释 ≤ 15%**（判据 1b，实测 13.36% PASS，贴边但守住）——即「拿得多但不至于架空体力闸门」。该判据在 econ-sim 仍计算上报但不计入 CORE 判决。**后续若 champion 绝对稀释逼近 15%（如调高 champion binding 或首府 mult），优先压它，而非看比值。**
3. **「vs 金币龙头」口径是跨类参考、非门控** ⚠：settle 实发 `coins=0`，把材料 coin-equiv 去比**金币**龙头（§6.1）是名义换算、量纲错配（材料经济与金币经济不同数量级、不可兑），故 econ-sim 标为 informational、不计入 core 判决。**经济约束的正确分母 = 材料龙头**（同单位、可比），即上表「正确口径」行。已回注 SLG_ECONOMY_CHECK §2.3 分母口径。

### 13-SLG.5 经济约束（红线复述）

- settle/细水是 SLG **唯一**持久 faucet；赛季资源/城建/国民加成零持久沉淀，**不进本节也不进 §6.1**。
- `SETTLE_REWARDS.coins` 改非 0 ⇒ 必并入 §6.1 月度预算 + 经济负责人签字（§2.4）。
- settle 任何材料/装备/皮肤**绝不进 PvP 蓝图**（`buildPvpBlueprints` 零养成参，§9 硬墙）。
- 皮肤限定件纯 cosmetic（ADR-003）；legendary 仍只走盲盒。
- 数值是 DRAFT：终态判据 = 上线后 analyticsvc 实测（settle 实发总量 / participant 人头 / 首府持有率）对账，偏差回 SLG_ECONOMY_CHECK §10 重跑（惰性下季生效）。

> 门控阈值 15%/10% 维持提案值（实测留足余量）；头部倾斜 10× 已弃用（降级 informational，见上）。**A 轨已过核验（2026-06-30）**——`SETTLE_REWARDS` / `CENTER_CAPITAL_MULT` 的 SLG_DESIGN §17/§21 `DRAFT` 可降级为「已过 A 轨核验（2026-06-30）」；其余参数（繁荣度/国民加成/分区/容量）待 B–F 轨各自核验（SLG_ECONOMY_CHECK §4–§8）。**⚠️ 2026-07-15 重跑发现回归，见 §13-SLG.6——上面 §13-SLG.3/.4 的「三场景全 PASS」结论已过期，勿直接引用，待 §13-SLG.6 修复后重新登记。**

### 13-SLG.6 场景配置过期导致的回归 + 免费/满氪对比缺口（2026-07-15）

**根因（场景 JSON 过期，不是数值真的破防）**：`server/tools/econ-sim/scenarios/{baseline,aggressive,conservative}.json` 从 `ad6ec80a`（首次建 econ-sim）之后**从未再改过**；`topSectMembers`（各档宗门的绝对人数）是按当时 `WORLD_CAPACITY=10000`（→人口/10000 个 shard）校准的绝对值。2026-07-07 `WORLD_CAPACITY` 改到 500 后（见上表订正），`shardCount = ceil(population / WORLD_CAPACITY)` 涨了 20×，但场景 JSON 里的 `topSectMembers` 没跟着按比例缩小——`headsServerWide = topSectMembers × shardCount` 因此被放大 20×：
- `baseline`：champion 200 人/shard × 100 shard = 20,000 人头，占 5 万人口的 **40%**（不合理）
- `aggressive`：champion 900 人/shard × 200 shard = 180,000 人头，**超过 10 万总人口**（物理不可能——赢家宗门比全服人还多）

重跑 econ-sim（2026-07-15）验证了这个根因：`conservative`（topSectMembers 相对较小）仍 PASS，`baseline`/`aggressive`（未按比例缩放）CORE FAIL 在"全服通胀 vs 材料龙头"判据（10.4%/52.4%，阈值 10%）。**这是场景配置的校准 bug，不是 `SETTLE_REWARDS` 本身破防**——真实游戏里一个 shard 只有 500 人，champion 宗门绝不可能有 900 人。

**修复**：把三个场景 JSON 的 `topSectMembers` 按新旧容量比 `500/10000 = 0.05` 重新缩放（baseline champion 200→10、top3 150→8、top10 80→4；aggressive champion 900→45、top3 700→35、top10 400→20；conservative 同比核对），使宗门人数重新落在单 shard 500 人的合理区间内，再重跑确认三场景恢复 CORE PASS，回填本节 §13-SLG.3。

**免费玩家 vs 满氪玩家差距（本节此前从未量化，用户 2026-07-15 要求补）**：A 轨 econ-sim 只测「settle 结算奖励」这一条持久经济通路，不覆盖赛季内「练兵/建城节奏」这条真正被内购加速影响的通路——那条通路的核验在 B 轨（`cityRun.ts`，§13-SLG-CITY），目前只有 casual/active/hardcore 三档**活跃度**画像，没有对照"充值多少"。而 `SLG_SHOP_ITEMS`（`slg_speedup_*`/`slg_res_*`）在本次核验中发现**没有购买次数上限**（见 SLG_DESIGN.md §7.2 新增的购买频次限制），理论上满氪玩家可无限购买把 casual 画像下数天到一月的建造/练兵曲线压缩为瞬间完成，差距在补购买限制之前是无上界的。补丁：`cityRun.ts` 新增一个"满氪对照"输出——按 `SLG_SHOP_ITEMS` 现价 + 新增的每日购买上限，算出"每日最大氪金"能把 casual 画像的建造/练兵天数压缩到多少天，与免费天数并排列出，回填本节。


> §13-SLG-NATION / §13-SLG-CITY / §13-SLG-C / §13-SLG-D / §13-SLG-E / §13-SLG-F / §13-SLG-STRONGHOLD 的核验过程与结论已拆分至 [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md)（章节号延续本文档编号，未重新编号）。

## 14. 活动 / Live-ops 数值（双倍封顶 · 积分 · 里程碑）`[可调]`

> 机制权威：[`EVENTS_DESIGN.md`](EVENTS_DESIGN.md)；本节为**数字单一源**。红线（ADR-014）：①不新增金币龙头（活动金币计入 §6.1 月度预算，主发软通货/限定皮肤碎片/积分）；②加成期硬封顶且只作用于受体力闸门约束的 PvE 产出；③积分活动期清零、不入持久经济；④PvP 硬墙恒不读活动加成。

### 14.1 加成期乘子（硬封顶，最敏感）

| 参数 | 默认值 | 上限（硬封顶） | 说明 |
|---|---|---|---|
| PvE 掉落倍率 `dropRate` | — | **≤ 2.0×** | 只作用于 PvE 材料/卡产出；体力总闸仍在（ADR-009），双倍 = 同体力翻倍产出，非无限刷 |
| 体力消耗倍率 `staminaCost` | — | **≥ 0.5×**（最多打五折） | 等效变相提产，与 dropRate 不叠满（见下） |
| 加成期单次时长 | — | **≤ 7 天** | 单个加成活动窗口上限 |
| 同时生效加成活动数 | — | **≤ 1** | 防多活动乘子叠乘冲垮预算 |
| 综合产出封顶 | — | **≤ 常态 2.5×** | dropRate × (1/staminaCost) 的合成上限，超配置拒绝上线（EVENTS §3 校验） |

> 服务器加载活动配置时校验乘子不超封顶（EVENTS §3「非法配置拒绝上线」），防运营误放超量奖励。

### 14.2 活动积分（局部货币，清零）

| 参数 | 默认值 | 说明 |
|---|---|---|
| 积分符号 | `eventPoints` | **不进 SaveData 持久经济**，活动 `settled` 即清零（EVENTS §2/§4） |
| 积分日产上限 | 按活动配置 | 受任务/里程碑数量自然约束 |
| 兑换商店产出 | 软通货 / 限定皮肤碎片 / 限定物 | **不**兑换金币、不破皮肤稀有度铁律（ADR-014 ③） |

### 14.3 活动奖励档（金币计入月度预算）

| 活动类型 | 主奖励载体 | 金币（若有） | 月度估算 `[可调]` |
|---|---|---|---|
| 登录活动 | 软通货（体力/材料/抽卡碎片）为主 | 极少/无 | 计入 §6.1「活动 ~40/月」 |
| 活动任务 | 软通货 + 活动积分 | 满档小额 | 同上 |
| 限定直购 | commercial 商店 SKU（金币/IAP） | — | 变现，不增 faucet |
| 节日主题 | 软通货 + 换皮 | 极小 | 同上 |

> **月度口径**：活动金币（若有）与登录/任务一起**收敛进 §6.1「活动 ~40/月」格**，不另开持续龙头（同 ADR-011/ADR-014）。活动是「叠加正向收益、可错过不可剥夺」的受控容器。

---

## 15. 角色卡 / Hero Roster 数值（CHARACTER_CARDS_DESIGN 全套） `[DRAFT]`

> 机制权威：[`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)；本节为**角色卡数字单一源**。常量真源：养成/背包 = `server/shared/src/cards.ts`；SLG 运行态 = `server/shared/src/slg.ts`；卡池 = `server/shared/src/economy.ts`。
> 状态：全部 `[DRAFT]` 占位值（已随 CC-1~5 落地代码），终态判据 = 上线后 analyticsvc 实测（升级速率 / 背包占用 / 受伤频率 / 卡池出货）对账，偏差惰性下版本生效。CHARACTER_CARDS_DESIGN §16 开放问题已在此登记。

### 15.1 卡定义（CardDef，`cards.ts`）

| 卡（defId） | 兵种 | 阵营 | troopCapBase | troopCapGrowth | powerWeights (hp/atk) | 招牌技能成长 [L1..L9] |
|---|---|---|---|---|---|---|
| lichuang 李川 | infantry | tao | 200 | 50 | 0.4 / 0.6 | 无（NO_SKILL） |
| chenshou 陈守 | shieldbearer | tao | 100 | 25 | 0.7 / 0.3 | 无（NO_SKILL） |
| suyuan 苏远 | archer | tao | 100 | 25 | 0.3 / 0.7 | 无（NO_SKILL） |
| max Max | max | anna | 100 | 25 | 0.4 / 0.6 | burstOnSingle：0,0,5,5,10,10,15,15,20 |
| lena Lena | lena | anna | 100 | 25 | 0.7 / 0.3 | disciplineArmor：0,0,2,2,4,4,6,6,8 |
| mara Mara | mara | anna | 100 | 25 | 0.3 / 0.7 | markEnemies%：0,0,10,10,15,15,20,20,25 |

> `troopCap(card) = troopCapBase + troopCapGrowth × level`。Tao 三人 = 现有兵种具名版，属性不变（CHARACTER_DESIGN §1 铁律），故 NO_SKILL。

### 15.2 升级：融合（`cards.ts`，2026-07-19 由连续 XP 曲线重设计）

- 规则：目标卡 + **5 张同阵营、同等级**材料卡一次性融合 → 目标 `level + 1`；材料必须严格等于目标当前等级，不支持混级/打折顶替
- `FUSION_MATERIAL_COUNT` = 5，`MAX_CARD_LEVEL` = 9（原散落各处的字面量 9 收拢为命名常量）
- `applyFusion(target) = target.level >= MAX_CARD_LEVEL ? target : { ...target, level: target.level + 1 }`
- 旧版连续 XP 曲线（`cost(n→n+1) = 5^n`，L9 累计约 488 280 XP）与 `feedXp()`/`LEVEL_CUMULATIVE_XP`/`CardInstance.xp` 字段已移除；总卡量需求量级不变（材料仍需逐级独立融合，等同于原 `5^level` 曲线），改动的是交互体验（离散凑 5 张 vs 连续攒经验条），不是经济投放节奏

### 15.3 背包 / 补偿（`cards.ts`）

| 参数 | 常量 | 默认值 | 说明 |
|---|---|---|---|
| 卡背包硬上限 | `CARD_INV_CAP` | 500（2026-07-19 由 150 扩容） | 独立于装备背包 300 |
| 背包满补偿 | `CARD_FULL_COMPENSATION_COINS` | 10 coins/张 | 抽卡/通关溢出转 coin sink |
| 预警阈值 + 溢出邮寄上限 | `CARD_INV_OVERFLOW_BUFFER` | 10（2026-07-19 合并自 `CARD_INV_WARN`+`INV_FULL_MAIL_COUNT` 两个常量） | 剩余槽位 ≤10 时 UI 预警；满仓溢出时最多邮寄 10 张实体卡，其余转 coin |
| 融合幂等 TTL | `CARD_FEED_IDEM_TTL_SEC` | 7 天 | 同装备幂等纪律 |

### 15.4 SLG 兵力 / 受伤（`slg.ts`）

| 参数 | 常量 | 默认值 | 说明 |
|---|---|---|---|
| 每队最大卡数 | `CARD_TEAM_MAX_SIZE` | 12 | CHARACTER_CARDS_DESIGN §8.2 |
| 最大队伍数 | `SIEGE_TEAM_CAP` | 5 | 不变 |
| 基地兵力池基础上限 | `TROOP_CAP_BASE` | 10 000 | 统一池（2026-07-21）；新手初始即满值，练兵场每级 +`DRILL_TROOPCAP_STEP`(1000)。退役了独立的 `BASE_TROOP_STOCK_INITIAL` |
| HP 归零保底存活率 | `CARD_BASE_SURVIVAL` | 0.2 | `survivalRate = max(0.2, min(1, 残存/出战))` |
| 受伤锁队时长 | `CARD_INJURY_DURATION_MS` | 5 min | 整队锁定 |
| 受伤立即恢复价 | `CARD_RECOVER_COIN_COST` | 50 coins | 单卡 |
| 移出队伍资源返还 | `CARD_TROOP_REFUND_RATE` | 0.8 | 返还训练资源（非兵力本身） |
| 单兵训练粮成本 | `CARD_TROOP_PAPER_COST` | 2 paper/兵 | 入基地兵力池 `playerWorld.troops` |
| 士气加成 | — | (currentTroops/troopCap)×0.2 | 满员 +20% ATK |

### 15.5 卡池（`economy.ts` standard 池）

角色卡挂在标准池 `standard` 内（rarity 权重 `RARITY_WEIGHTS`：common 700 / rare 230 / epic 60 / legendary 10；池内同稀有度平均分权）：

| 稀有度 | 新增角色卡条目 | 该档条目数 | 单卡近似权重 |
|---|---|---|---|
| epic | lichuang / chenshou / suyuan（Tao 三人） | 9 | round(60/9) ≈ 7 |
| legendary | max / lena / mara（Anna 三人） | 7 | round(10/7) ≈ 1 |

- 抽到即入 `cardInv`（1 级实例，XP=0）；背包满转 §15.3 补偿
- ~~单位卡盲盒池（`UNIT_CARD_POOL_ID`）~~ 已于 2026-07-03 彻底移除（S12-C 遗留的第二个非限定池，被客户端显示成重复的「常驻池」）；单位卡进度仅保留 PvE 关卡掉落（`levelCardReward` → `cardInv`，见 §4 2026-08-03 订正——**不是**发进 `cardInventory`/`deriveUnitLevels`，那条链路本身已在 CC-9(2026-07-03) 退役，本行此前的表述过期），gacha 抽卡池及其发货路由（`unitCardPoolItems`/`GACHA_RARITY_TO_CARD_LEVEL`/`deliverCardGrant`）已删。角色卡走 Hero Roster，本就在 `standard` 常驻池发放

### 15.6 重复卡处理 / "碎片兑换表"——2026-08-03 拍板正式关闭

`DUPE_REFUND_COINS`（`server/shared/src/economy.ts`：common=10/rare=50/epic=400/legendary=1500）代码注释里提过一个未落地的设想："重复卡→碎片，碎片再兑换指定卡"，因为碎片会落进客户端同步的 `materials` 字段（与 client PUT /save 的权威冲突）而搁置，转为统一金币退还（`DUPE_REFUND_COINS`本身）。**核实结果：`DUPE_REFUND_COINS` 目前未接入任何真实发货路径**——全仓库唯一引用点是 `server/tools/econ-sim`（SLG settle 材料估值用，见 §13-SLG.1），`metaserver/src/service/economy.ts` 的抽卡/商店发货逻辑从未调用它；换言之"抽到重复卡/皮肤怎么处理"这件事目前完全没有兑现逻辑，重复项就静静地留在背包/`inventory.skins`里。

**2026-08-03 拍板：正式放弃"碎片兑换"设想，不再是开放项**——理由：融合校验本就是"同阵营互通"（陶奇三人/Anna三人互为材料），抽到的重复卡天然可用作任意同阵营目标的融合材料，碎片系统能带来的增量价值很小；且真要做还得新开一个类似 `cardInv`/`equipmentInv` 那样的服务器权威集合来绕开 `materials` 字段的客户端同步冲突，成本明显高于收益。`DUPE_REFUND_COINS` 保持现状（仅供 econ-sim 估值用），"抽到重复卡/皮肤零兑现"这件事本身**不算 bug**——皮肤重复本来就无所谓（不消耗、不占背包上限之外的资源），卡重复天然是融合燃料。若未来要做，需求得从"仅供 SLG 估值的孤立常量"重新论证，不建议照搬本节的旧设想直接实现。

### 14.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| PvE 掉落倍率上限 | ≤ 2.0× | 活动（加成期） |
| 体力消耗倍率下限 | ≥ 0.5× | 活动（加成期） |
| 加成期单次时长 / 并发数 | ≤ 7 天 / ≤ 1 | 活动（加成期） |
| 综合产出合成封顶 | ≤ 常态 2.5× | 活动（加成期） |
| 活动积分 | 活动期清零、不沉淀 | 活动（局部货币） |
| 活动金币月度归口 | 并入 §6.1「活动 ~40/月」 | 活动（经济红线） |
</content>
