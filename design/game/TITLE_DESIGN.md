# 称号系统设计（Title / 公开身份名片）— DRAFT

> **状态**：设计占位（2026-06-21 拍板）。**未实现**——依赖 ranked 队列（`META_TASKS.md S1-R`）与赛季系统，待二者落地后实现，见 `META_TASKS.md S10`。
> **机制权威 = 本文**。数值（段位首达金币）去 [`ECONOMY_BALANCE.md §2.3`](ECONOMY_BALANCE.md)；成就→称号映射机制基准见 [`ACHIEVEMENT_DESIGN.md`](ACHIEVEMENT_DESIGN.md)。

---

## 1. 定位

称号是游戏唯一的**公开身份名片**：玩家随处展示的「战绩标签」。

- **对外炫耀只走称号**（`ACHIEVEMENT_DESIGN §7` 已定）：成就墙纯自看不对外，对外身份一律靠称号。
- **统一身份容器**（2026-06-21 拍板）：称号是一个**独立的 titleId 集合**，聚合多来源（天梯段位 / SLG 赛季 / 成就 / 运营活动）。玩家**拥有一堆、佩戴其一**，可切换。
- **与经济解耦**：天梯段位首达金币（`ECONOMY_BALANCE §2.3`）是经济 faucet，仅首次发；称号是身份系统，授予规则独立（见 §4）。同一结算事件的两个 side-effect，逻辑分开。

---

## 2. 数据模型（复用现有结构，改动极小）

`SaveData`（`server/shared/src/types.ts`）新增一个**服务器权威**字段；佩戴复用已存在的 `equipped` 通用穿戴位：

```ts
// —— 服务器权威段（客户端只读，与 pvp/wallet 同性质）——
titles: string[];              // 拥有的 titleId 集合,服务端 $addToSet 授予,玩家改不了

// —— 客户端同步段（复用已存在的 equipped: Record<string,string>）——
equipped['title'] = titleId;   // 当前佩戴展示的 titleId
```

- `titles` 进**服务器权威段**：仅由 ranked 赛季结算 / worldsvc SLG 结算 / 成就 claim / admin 授予，玩家无法伪造。
- 佩戴走**已有 `SyncPatch`（`equipped`）**，零新写接口；服务端在 `PUT /save` 校验 **`equipped.title ∈ titles`**，否则拒绝/落回。
- 赛季峰值追踪：`pvp` 段加 `seasonPeakRank`（赛季内最高段位，赛季结算时读它授称号再清零）。

---

## 3. titleId 命名 = `<来源>.<赛季?>.<key>`

**赛季快照类**（2026-06-21 拍板）把赛季编号编进 id；永久类不带赛季段。

| 来源 | 形态 | 例 | 永久性 |
|---|---|---|---|
| 天梯段位 | `ladder.s{N}.{rank}` | `ladder.s3.king` → "S3 王者" | 每赛季快照**该季峰值段位**一枚,永久留存 |
| SLG 赛季 | `slg.s{N}.{key}` | `slg.s2.tenwin` → "S2 十冠王" | 同上（`SLG_DESIGN §U3` 既有「十冠王」）|
| 成就 | `ach.{key}` | `ach.meteor_master` | **永久**,无赛季段 |
| 运营/活动 | `event.{key}` | `event.founder`（内测） | **永久** |

`rank` 取值与 `server/shared/src/ladder.ts` 的 `RankId` 同源（bronze…king，9 段）。

---

## 4. 永久性 = 赛季快照（拍板）

段位称号**按赛季快照**，不实时反映当前段位：

- **每赛季末**：按该季 `seasonPeakRank` 授予一枚 `ladder.s{N}.{peakRank}`，**一季最多一枚**（取峰值）。
- **掉段不丢**：称号一旦进 `titles` 即永久保留，赛季重置/掉段都不删除——历史可翻（「S1 黄金 / S2 钻石 / S3 王者」）。
- SLG 赛季称号同理（`slg.s{N}.*`）。成就 / 活动称号为**永久无赛季**。

> 与经济侧的区别（别混）：`ECONOMY_BALANCE §2.3` 首达金币**仅首次发**（控量）；称号**每赛季快照一枚**。两条逻辑独立。

---

## 5. 统一授予接口

meta 内部单点 `grantTitle(accountId, titleId)`：

- `$addToSet` 幂等 + 回推 `SaveData`（与成就金币「直接记账、不走邮件」同路径）。
- **若开启「自动佩戴最高/最新」**（§6），授予时若新称号等级高于当前佩戴位则一并更新 `equipped.title`。
- 四个来源都调它：
  1. **ranked 赛季结算**（meta）：读 `pvp.seasonPeakRank` → `grantTitle(ladder.s{N}.{peakRank})` → 清零峰值。
  2. **SLG 赛季结算**（worldsvc）：赛季奖励事件 → `grantTitle(slg.s{N}.*)`。
  3. **成就 claim**（meta）：**部分顶阶/标志性成就**额外授予一枚永久称号（见 §7）。
  4. **运营/活动**（admin 后台）：走类似补偿的审计路径手动授予 `event.*`。

---

## 6. 自动佩戴（拍板：自动佩戴最高/最新）

- 获得**更高等级**称号时自动换上，玩家无感即享炫耀；仍可在资料页手动改回任意已拥有称号。
- 「等级」排序需定义跨来源的可比序（建议：天梯段位序 > SLG > 成就 > 活动，同源按赛季/阶序）。具体序表实现期定。
- 新号默认无佩戴（`equipped.title` 缺省），或给一枚 `event.newbie` 起步称号（实现期定）。

---

## 7. 成就 → 称号（拍板：部分里程碑发称号）

- **仅顶阶 / 标志性成就**额外授予一枚永久 `ach.*` 称号（如「陨石大师 III」「全章节通关」），让成就也能变成对外名片。
- 普通成就仍只发金币、纯自看（`ACHIEVEMENT_DESIGN` 不变）。
- 定义模型加可选字段即可支持：`Achievement.titleId?: string`（达成顶阶时 `grantTitle`）。
- 红线不破：成就仍**只发金币 + 称号，绝不发战力**。

---

## 8. 四处展示 + 下发链路（拍板：四处全展示）

每个 titleId 配 i18n **全称 + 短标签**两套文案（`title.<id>.full` / `.short`），赛季段运行期拼 `S{N}`。短标签用于前缀/名牌/榜（需限长，建议 ≤ 4 字）。

| 展示位 | 形态 | 下发链路 |
|---|---|---|
| **资料弹层**（必做） | 佩戴称号 + 可展开「称号墙」看全部 `titles` | meta `GET /internal/profile` 已回 `{displayName, publicId}` → **加 `equippedTitle`**（`PROFILE_POPUP_PLAN` 链路）|
| **对战内名牌** | 对手名旁短标签 | 复用 `PROFILE_POPUP_PLAN` 已建的 ticket→`match_start` opponent 身份链路 → 加 `opponentTitle` |
| **聊天名前缀** | `[王者] 昵称`（短,限长） | social 渲染消息时附 sender 的 `equippedTitle`（`SOCIAL_DESIGN`）|
| **排行榜** | 名字旁短标签 | 天梯 / SLG 榜查询 join `titles`（取 `equippedTitle`）|

---

## 9. 待实现 / 遗留

- [ ] 依赖 ranked 队列（`META_TASKS S1-R`）+ 赛季系统（`ECONOMY_BALANCE §2.6`）先落地。
- [ ] 跨来源「等级」可比序表（§6 自动佩戴用）。
- [ ] i18n 文案表 `title.*`（full/short）。
- [ ] `equipped.title` 短标签限长与 UI 截断规则。
- [ ] 新号默认佩戴策略（无 / `event.newbie`）。
- [ ] 成就→称号映射的具体条目清单（§7，与 `ACHIEVEMENT_DESIGN` 条目对齐）。
