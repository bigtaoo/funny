# 赛季系统总览 — 两套独立赛季的边界与对照 (Season Systems Overview)

> 状态：设计中 · 权威：**本文（两套赛季的「独立性契约 / 边界 / 对照」单一来源）** · 更新：2026-06-21
>
> 本文**不重述任何机制**——天梯赛季机制权威永远是 [`SEASON_DESIGN.md`](SEASON_DESIGN.md)，SLG 大区赛季机制权威永远是 [`SLG_DESIGN.md`](SLG_DESIGN.md)。
> 本文只做一件事：**把「为什么是两套、各自管什么、彼此绝不触碰什么、共享的账户资产怎么算」锁成一张对照表与一份互不干涉契约**，消解读两份文档时反复出现的「这两个赛季是不是一回事 / 谁会重置谁」的困惑。

---

## 0. 一句话定位

游戏里有**两套完全独立的赛季系统**，跑两条时钟、用两套重置粒度、各自结算、互不触发：

| | **天梯赛季** | **SLG 大区赛季** |
|---|---|---|
| 它服务的循环 | 1v1 锁步对战的爬梯（PvP 养成天梯） | 共享大地图的领土争霸（SLG 大世界） |
| 它解决的问题 | 让爬梯有终点、强者每季重新证明、运营有节律发奖 | 战略态周期归零保新鲜感与公平起跑，是变现发动机 |
| 机制权威文档 | [`SEASON_DESIGN.md`](SEASON_DESIGN.md) | [`SLG_DESIGN.md §2.3 / §8.3`](SLG_DESIGN.md) |

> **它们之所以是两套**：天梯衡量的是「个人战术强度」（ELO/段位），SLG 衡量的是「赛季服内集体领土态」（领地/兵力/国家）。两者节律不同（个人爬梯宜短、领土肝战宜长）、重置代价不同（拉平 ELO vs 清空地图）、归属维度不同（全服唯一天梯 vs 每大区一张地图）。强行合并必然在某一边失真。

---

## 1. 独立性铁律（= SEASON_DESIGN S1 的全局升格）

> 这条原本写在 [`SEASON_DESIGN.md §1 S1`](SEASON_DESIGN.md)，本文把它升格为**两套系统共同遵守的顶层契约**，并补全 SLG 侧表述。

1. **两条时钟，互不触发**：天梯赛季 = 6 周（`SEASON_DESIGN`）；SLG 大区赛季 = 2 个月（`SLG_DESIGN §SLG3`）。开任意一边的新赛季，**绝不**联动另一边。
2. **天梯赛季重置只动 `pvp` 段**：软重置 ELO/段位/连胜，**永不**碰任何 SLG 地图态（领地/兵力/世界文档/赛季资源）。
3. **SLG 大区重置永不动天梯**：清领地/兵力/地图态/赛季资源/繁荣度/国家/家族宗门编制，但 **`SLG_DESIGN §SLG4` 明文「保天梯段位/ELO」**——SLG 重置时天梯数据原封不动。
4. **这消解了一处表面矛盾**：`ECONOMY_BALANCE §2.6`「赛季末天梯重置」与 `SLG_DESIGN §SLG4`「跨季保段位」**说的是两个不同的赛季**——前者指天梯赛季的软重置，后者指 SLG 大区赛季不动天梯。二者从不冲突。

---

## 2. 核心对照表（边界单一来源）

> 任一行的「数字/具体阈值」都不在本表拍死——跟随各自机制权威文档与数值文档。本表只锁**结构性边界**。

| 维度 | 天梯赛季 | SLG 大区赛季 |
|---|---|---|
| **周期** | 6 周 | 2 个月 |
| **时钟载体** | `ladderSeasons` 单文档（全局唯一，无大区维度） | `worlds` 文档逐大区独立（`status: open/active/settling/closed` + `openAt/resetAt`） |
| **作用域** | 全服唯一一条天梯 | 每大区一张地图实例（~1 万活跃玩家/区，超出开新区） |
| **赛季切换触发** | admin 手动 `POST /admin/ladder/season/roll`（CAS 幂等；meta 不自带定时器） | `open`/`reset`/`close` admin 手动；**`settle` 到点自动**（`WorldDoc.settleAt` = openAt+2 月，scheduler 到期自动结算发奖发称号，`NW_SLG_AUTO_SETTLE=0` 可退回纯 admin，`SLG_DESIGN §17.7/§17.14`） |
| **重置粒度** | **软重置**（向基准 1200 回归一半，只压不抬） | **硬清**战略态 |
| **重置清掉什么** | `pvp.elo / rank / streak` 拉回基线；`seasonPeak*` 重置到新基线 | 领地 / 兵力 / 地图态 / 赛季资源(粮铁木) / 繁荣度 / 国家归属 / 家族宗门编制 |
| **跨季保留什么** | `wins/losses`（终身累计）、`reachedRanks`（终身首达账本）、已授段位称号 | 养成（装备/科技/材料）、皮肤、**天梯段位/ELO**、账号档案、好友关系、`coin` |
| **逐玩家迁移方式** | 惰性 `migrateIfStale`（玩家下次访问按 `pvp.seasonNo` 落后即补结算+软重置） | 赛季运维触发的地图态批量重置 + 大区重新分配（按宗门强弱平衡，G6 待补） |
| **结算/排名** | 按 `seasonPeakRank` 发峰值金币 + 授段位称号；全服 Top100（ELO 降序） | 大比按宗门占领首府(国家)数排名；中原首府额外加权 |
| **赛季奖励内容** | 金币（峰值，每季可重复）+ 永久段位称号 + 战令奖励 | 材料 / 皮肤 / 称号（如「十冠王」连续赛季成就）+ 运营叠加 |
| **战令** | 天梯战令（Battle Pass，6 周一季，`SEASON_DESIGN C 块`） | SLG 赛季战令（`SLG_DESIGN S8-8`，走 commercial，**与天梯战令是两个独立战令**） |
| **奖励发放路径** | 邮件（赛季结算金币/补发）+ 直接记账（首达金币/战令领取）+ `grantTitle` | 结算奖励（材料/皮肤/称号，走 SLG 运营发放） |
| **机制权威** | [`SEASON_DESIGN.md`](SEASON_DESIGN.md) | [`SLG_DESIGN.md`](SLG_DESIGN.md) |
| **数字权威** | `ECONOMY_NUMBERS §13`（软重置基准/峰值金币/战令曲线）；首达/胜利金币 → `ECONOMY_BALANCE §2.3` | `ECONOMY_BALANCE / ECONOMY_NUMBERS` + `SLG_DESIGN §14.7` 常量；国民加成/繁荣度阈值待铺 |

---

## 3. 互不干涉契约（实现红线）

写代码时这三条必须守住，否则两套赛季会互相污染：

1. **重置写入域隔离**
   - 天梯 `migrateIfStale` / `season/roll` 的写集合 = **仅** `saves.pvp.*` + `ladderSeasons`。**禁止**触碰 `worlds` / `worldTiles` / `marches` / SLG 任何集合。
   - SLG `resetSeason` 的写集合 = `worlds` / 地图态 / SLG 资源 / family·sect 编制。**禁止**触碰 `saves.pvp.*`（`SLG_DESIGN §SLG4` 已明文保段位——实现上即「reset 不在 pvp 段落笔」）。

2. **共享账户资产的归属唯一**
   两套赛季都跑在同一个账号上，下列资产**跨两套赛季持久、且只由其权威系统写**，赛季重置一律绕开：

   | 共享资产 | 权威系统 | 两套赛季对它的关系 |
   |---|---|---|
   | `coin`（金币，持久货币） | 经济系统（`ECONOMY_BALANCE`） | 两套赛季都能**产出**金币（天梯峰值/战令；SLG 任务/活动），但都须计入经济总预算跑模拟，**谁都不能新增金币龙头**（`SEASON_DESIGN S5` / `SLG_DESIGN §7.x`）。重置永不清 coin。 |
   | 称号（统一 `titleId` 容器） | [`TITLE_DESIGN.md`](TITLE_DESIGN.md) | 天梯赛季授 `ladder.s{N}.{rank}`；SLG 赛季授 SLG 大比/连冠称号。**两路都 `grantTitle` 进同一容器**，`$addToSet` 幂等、自动佩戴最高 weight。重置不丢已授称号。 |
   | 养成（装备/科技/材料）、皮肤 | 装备/经济系统 | 两套赛季只**发**养成奖励，重置都不清养成（天梯本就不碰；SLG `§SLG4` 明文保养成）。 |

3. **金币产出统一入经济预算**
   天梯峰值金币、天梯战令免费轨金币、SLG 赛季任务/活动金币——**全部并入 `ECONOMY` 总产出模拟**（`ECONOMY_BALANCE §9`），不因「分属两套赛季」而各自开龙头。这是两套系统唯一必须协同核账的点。

---

## 4. 常见困惑速查（FAQ）

- **「赛季结束了」指哪个？** 看语境：个人爬梯/段位/Top100/天梯战令 → 天梯赛季（6 周）；大地图/领土/宗门大比/SLG 战令 → SLG 大区赛季（2 个月）。
- **SLG 打完一个赛季，我的段位会掉吗？** 不会。SLG 重置只清战略态，`§SLG4` 明文保天梯段位/ELO。
- **天梯换季，我大地图上的领地会没吗？** 不会。天梯软重置只动 `pvp` 段，不碰任何 SLG 地图态。
- **两个战令是同一个吗？** 不是。天梯战令（`SEASON_DESIGN C 块`，6 周）与 SLG 赛季战令（`SLG_DESIGN S8-8`，2 个月，走 commercial）是两套独立战令，各自经验来源、各自周期、各自购买。
- **金币会因为有两套赛季而通胀吗？** 不会——两套赛季的金币产出统一并入经济总预算跑模拟（§3.3），谁都不许新增龙头。
- **称号会因为换季丢吗？** 不会。两套赛季授的称号都进同一 `titleId` 容器，`$addToSet` 幂等永留（`TITLE_DESIGN`）。

---

## 5. 与其他文档的关系

- **机制细节**：天梯 → [`SEASON_DESIGN.md`](SEASON_DESIGN.md)；SLG → [`SLG_DESIGN.md`](SLG_DESIGN.md)。本文不复制它们的结论。
- **可编码实现规格**：天梯 → `SEASON_DESIGN §13A/§13B`；SLG 大区 → `SLG_DESIGN §17`（§17.10 给出「SLG worldsvc 进程从不连 meta saves 库 → 写入域隔离是架构级保证」的代码层自检，兑现本文 §3.1 红线）。
- **数值**：`ECONOMY_NUMBERS`（§13 天梯 / SLG 常量）、`ECONOMY_BALANCE`（政策与预算）。
- **称号下游**：[`TITLE_DESIGN.md`](TITLE_DESIGN.md)（两套赛季结算都向它 `grantTitle`）。
- **接口契约**：[`SERVER_API.md`](SERVER_API.md)（`/admin/ladder/season/roll`、`/leaderboard`、`/world/season` 等）。
- **任务进度**：[`META_TASKS.md`](META_TASKS.md)（天梯 S11/SE-* · SLG S8-7）。
- 若本文与两份机制权威出现表述漂移，**以机制权威为准**并回修本文（README §0 铁律 2）。
