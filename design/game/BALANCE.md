# 战斗数值快照（BALANCE）

> 状态：实现中 · **权威：`server/engine/src/config.ts`（`@nw/engine`；本文是它的快照，非权威）** · 更新：2026-06-22（A7/S12-E 数值拍板）
>
> ⚠️ 改数值改 `config.ts`，然后同步本文 + 注明日期。**不要**只改本文。
> 本文取代 `product/v1-balance.md`（未落地）与 `core-gameplay-loop.md` 内联数值（设计意图）作为文档侧数值参考。
> 引擎已抽成 `@nw/engine`（G3-2b-0，2026-06-21）：config.ts 真身在 `server/engine/src/`，client 经 alias 引用、旧 `client/src/game/config.ts` 留 re-export shim。

来源：[`server/engine/src/config.ts`](../../server/engine/src/config.ts)（截至 2026-06-21）。

---

## 1. 棋盘

| 项 | 值 |
|---|---|
| 尺寸 | 12 列 × 18 行（0-indexed，row 0–17） |
| 基地列 | 5、6（中央两列） |
| 进攻道（10 条） | 0,1,2,3,4,7,8,9,10,11 |
| 己方（Bottom）建筑行 / 出兵行 | row 0 / row 1 |
| 敌方（Top）建筑行 / 出兵行 | row 17 / row 16 |

## 2. 资源（墨 ink）

| 项 | 值 |
|---|---|
| 基础回墨 | 2 ink/s |
| 墨上限 | **300** |
| 基地升级费用 | **50 / 100 / 200**（共 3 级） |
| 每级回墨加成 | +1 ink/s（→ 3 / 4 / 5 ink/s） |
| 基地 HP | **100** |

## 3. 时间加速（按 tick 阈值，30Hz）

| 时间 | 效果 |
|---|---|
| 0–3 min | ×1.0 |
| 3–6 min | 产墨 ×1.5 |
| 6–10 min | 产墨 ×2.0 |
| 10–13 min | 产墨 ×4.0 |
| 13 min | 全单位攻击力 ×2 |
| 15 min | 倒计时开始 |
| 17 min | 强制平局 |

## 4. 手牌

| 项 | 值 |
|---|---|
| 手牌数 | 6 |
| 自动刷新倒计时 | 30 s（900 ticks），单槽 2 分钟未出则刷新 |
| 开局错峰偏移 | 随机 [0, 15 s]（450 ticks） |

## 5. 单位

### 5.1 PvP 牌池单位（有卡牌 → 进 PvP）
| 单位 | HP | 攻 | 攻击间隔 | 移速(格/s) | 射程 | 出数 | 碰撞半径(fp) | 基础护甲 |
|---|---|---|---|---|---|---|---|---|
| 普通兵 Infantry | 60 | 12 | 0.8s | 1.4 | 1（近战） | 2 | 400 | 0 |
| 盾兵 ShieldBearer | 240 | 8 | 1.2s | 0.85 | 1（近战） | 1 | 500 | 0 |
| 弓箭兵 Archer | 35 | 22 | 1.4s | 1.1 | 2（远程，投射物 14 格/s） | 1 | 350 | 0 |

> PvP 单位基础护甲全为 0；护甲仅通过单位养成（S12）+装备（A5）获得，PvP 路径不注入护甲（硬墙 `buildPvpBlueprints`）。

### 5.2 PvE 专属单位（无卡牌 → 永不进 PvP 池）
| 单位 | HP | 攻 | 攻击间隔 | 移速 | 射程 | 半径 | 特性 | 基础护甲 |
|---|---|---|---|---|---|---|---|---|
| 重甲 Ironclad | 290 | 10 | 1.5s | 0.5 | 1 | 520 | 抗箭肉盾 | **3**（A3，2026-06-22） |
| 疾行 Runner | 30 | 9 | 0.7s | 1.9 | 1 | 250 | 快脆，密集冲锋 | 0 |
| 哈耳庇厄 Harpy | 26 | 8 | 0.9s | 2.2 | 1 | 210 | flying（仅弓兵/箭塔可打），无视阻挡 | 0 |
| 医护 Medic | 90 | 0 | — | 0.55 | 0 | 440 | aura_heal 半径 2、8 HP/s，无攻击 | 0 |
| 狂战 Berserker | 110 | 18 | 1.1s | 1.1 | 1 | 420 | HP<40% 攻速 ×1.5 | 0 |
| 分裂 Splitter | 65 | 7 | 1.0s | 0.8 | 1 | 470 | 死亡生成 Runner ×2 | 0 |

> Ironclad armor=3（A3 2026-06-22）：确立抗箭肉盾定位。箭塔 TTK 从 ~29 s → ~36 s，迫使玩家用法术/近战清除。

## 6. 建筑

| 建筑 | HP | 攻 | 攻击间隔 | 射程 | 产兵 | 基础护甲 |
|---|---|---|---|---|---|---|
| 兵营 Barracks | 200 | — | — | — | 普通兵 ×1 / **6s** | 0 |
| 箭塔 ArrowTower | 120 | 15 | 1.5s | **2 格** | —（可打飞行，投射物 14 格/s） | 0 |

> 远程攻击（弓兵/箭塔）发射跟踪制导投射物，飞抵目标才结算伤害（必中，仅加飞行延迟；目标先死则箭 fizzle）。机制详见 `DESIGN.md` §6b，数值权威源 `config.ts`。
> 建筑护甲已实现（A1，2026-06-22）：`BuildingBlueprint.armor` + `Building.takeDamage` flat 减伤；当前基础值均为 0，A3 调参时可按需设定。

## 7. 卡牌（费用，墨）

| 卡 | 费用 | 类型 | 备注 |
|---|---|---|---|
| 普通兵 ×2 | 4 | 兵 | 一卡出 2 |
| 盾兵 ×2 | 6 | 兵 | |
| 弓箭兵 ×2 | 5 | 兵 | |
| 兵营 ×2 | 14 | 建筑 | |
| 箭塔 ×2 | 12 | 建筑 | |
| 急速冲锋 | 8 | 法术 | 移速 ×2，持续 5 s |
| 陨石打击 | 12 | 法术 | 2×2 区域，伤害 9999（秒杀）；**只伤敌方**单位/建筑，不误伤己方 |

> PvP 牌池 = 上表 12 张（`CARD_DEFINITIONS`）。

## 8. 单位养成（S12-E 校准，2026-06-22）

| 项 | 值 |
|---|---|
| 护甲成长（`STAT_GROWTH_PER_LEVEL.armor`） | **1 flat/级**（↓ 旧值 2/级） |
| L9 护甲上限（养成贡献） | **+8 flat** |
| 装备护甲封顶（`EFFECT_CAPS.armorFlat`） | **12**（↓ 旧值 20） |
| L9 + 满装备理论最大护甲 | **≤ 20**（8+12） |

> 背景：armor:2/级时 L9 玩家单位有 +16 护甲，Ironclad (10 攻) 等低攻敌对玩家造成 max(1,10-16)=1 伤害，
> TTK 爆炸。改为 armor:1/级（L9 = +8）后 Ironclad 实伤恢复到 max(1,10-8)=2，与敌方 HP 同步上调，维持难度。

### 7.1 PvE 专属法术卡（不进 PvP 池，硬墙）
| 卡 | 费用 | 效果 |
|---|---|---|
| 落石 Rockslide | 3 | 伤害 80 |
| 断桥 BridgeCollapse | 4 | 阻断 8 s |

---

## 9. TTK 速算表（S12-E 重算，2026-06-22）

> **公式**：TTK(s) = ceil(目标HP / max(1, 攻击-护甲)) × 攻击间隔(s)  
> 护甲档位对应玩家单位养成等级：0→L1, 5→L6, 8→L9; 10/15/20 为装备+养成上限参考。  
> S12-E 校准：armor 成长 2→1 flat/级，L9 最高 +8；装备封顶 12；综合上限 ≤20。

### 9.1 PvP 单位互打（基础兵，护甲 0/5/10/15/20 五档）

| 攻击方 | 防御方 | a=0 | a=5 | a=10 | a=15 | a=20 |
|---|---|---|---|---|---|---|
| Infantry | Infantry | 4.0s | 7.2s | 24.0s | 48.0s | 48.0s |
| Infantry | ShieldBearer | 16.0s | 28.0s | 96.0s | 192.0s | 192.0s |
| Infantry | Archer | 2.4s | 4.0s | 14.4s | 28.0s | 28.0s |
| ShieldBearer | Infantry | 9.6s | 24.0s | 72.0s | 72.0s | 72.0s |
| ShieldBearer | ShieldBearer | 36.0s | 96.0s | 288.0s | 288.0s | 288.0s |
| ShieldBearer | Archer | 6.0s | 14.4s | 42.0s | 42.0s | 42.0s |
| Archer | Infantry | 4.2s | 5.6s | 7.0s | 12.6s | 42.0s |
| Archer | ShieldBearer | 15.4s | 21.0s | 28.0s | 49.0s | 168.0s |
| Archer | Archer | 2.8s | 4.2s | 4.2s | 7.0s | 25.2s |

> a=15/20 处 Infantry 攻（12-15=−3，取 max(1)→1 dmg/hit）：TTK = ceil(60/1)×0.8 = 48.0s；同理 ShieldBearer 攻（8-15→1）= 288.0s，到 a=10 也触发 max(1)，故 a=10/15/20 相同。

### 9.2 箭塔 vs PvE 肉盾（armor 0 vs armor 3）

| 目标 | HP | 护甲 | 箭塔 TTK | Infantry TTK |
|---|---|---|---|---|
| Ironclad（旧 armor=0） | 290 | 0 | ~30s (15 dmg/hit) | ~20s (12 dmg/hit) |
| Ironclad（新 armor=3） | 290 | 3 | **~37.5s** (12 dmg/hit) | ~26.4s (9 dmg/hit) |
| ShieldBearer（玩家L9+8甲） | 240 | 8 | ~22s (7 dmg/hit) | — |

> Ironclad armor=3 后箭塔 TTK ~37.5s（原 ~30s），迫使玩家用近战/法术组合清除；单靠箭塔守不住。

### 9.3 PvE ch1–6 难度梯度评估（S12-E 校准后，2026-06-22）

> **结论：关卡文件无需修改，难度梯度在 Ironclad armor=3 后仍合理。**

| 章 | 首次引入 Ironclad | 对比 armor=0 变化 | 玩法影响 |
|---|---|---|---|
| ch1（简单） | lv2（tick 300，1–2 个/波） | 单近战 TTK +3s（13s→16s 约 2 infantry） | 仍可快速以步兵清除；教导「近战克装甲」 |
| ch2–3（入门） | 早期出现，数量增加 | 单波 Ironclad 需 4 infantry 才能在道路上清除 | 迫使玩家建兵营组合箭塔+步兵 |
| ch4–5（中级） | 多 Ironclad + 其他威胁混合 | 同波次威胁增加，需法术/兵营/箭塔三选 | 考验多线反应能力 |
| ch6（挑战） | 高密度 Ironclad + Berserker/Medic | 全阵 armor 叠加，裸箭塔已无法单一应对 | 需要关卡专属法术（Rockslide/BridgeCollapse）配合 |

**关键数值**（2 infantry 对 1 Ironclad armor=3）：
- DPS = 2 × max(1, 12−3) / 0.8s = 22.5 DPS
- TTK = ceil(290/9) × 0.8 = 33 × 0.8 = **26.4s**（单 infantry 序列；实际两兵同攻约 13s）
- Ironclad 行进速度 0.5 格/s，穿越 14 行战斗区需 28s → 2 infantry 部署后可在到达基地前清除

---

## 10. 体力系统（A4，2026-06-22）

| 项 | 值 |
|---|---|
| 体力上限 | **120** |
| 自然恢复速率 | **1 点 / 6 分钟** |
| 关卡消耗默认 | **1**（level JSON 未指定时） |
| 关卡消耗范围 | 1–5（在 level JSON `staminaCost` 字段定义） |
| 付费补充 | **30 金币 → +60 体力**（走 commercial.spend） |
| 错误码 | `INSUFFICIENT_STAMINA`（HTTP 402）|

**实现说明**：
- 服务端 `pveStamina` 集合（`_id=accountId`），原子 `findOneAndUpdate` + `$gte` 守卫，与 SaveData rev-lock 分离。
- `regenAt=0` 表示已满（无需计时）；`regenAt>0` 表示下次 +1 点的时间戳(ms)。
- 体力快照在 `getSave` / `pveClear` 返回时注入 `save.stamina`，不写回 saves 集合。
- 客户端 `LevelPrepScene` 红色提示不足 + "补充体力"按钮（先尝试直接 purchaseStamina，失败则路由到商店）。
</content>
