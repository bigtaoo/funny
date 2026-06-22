# Notebook Wars — 并行开发计划

> 创建：2026-06-22。本文把所有待实现功能按**依赖耦合度**分为三条并行轨道，理想状态是三个 Claude 会话同时推进。
>
> 轨道之间的唯一交界点在文末「交接点」一节注明，到达交接点前各轨道互不阻塞。

---

## 轨道总览

| 轨道 | 主题 | 核心原则 |
|---|---|---|
| **Track A** | 引擎重做 + 深度养成 | 最破坏性改动集中在一个 worktree，先动引擎再动数值 |
| **Track B** | 元系统留存（成就/赛季/称号/日常/活动） | 纯新增 API + 表，零引擎改动，与 Track A 完全独立 |
| **Track C** | 商业合规 + 验收加固 | 服务端硬化 + 真机联调，零游戏玩法改动 |

---

## Track A — 引擎重做 + 深度养成

> **worktree 建议**：`git worktree add ../funny-track-a track-a`

### ✅ A1  护甲机制入引擎（最优先，其余依赖此项）

**范围**：`server/engine/src/` 新增 `armor` 字段（flat 减伤）；`config.ts` 六张卡 + 建筑加护甲参数；伤害计算 `max(0, damage - armor)`；`BALANCE.md` 快照。

**验收**：`tsc -b` 干净；引擎单测新增护甲减伤用例；黄金回放不破（armor=0 行为等价旧引擎）。

**参考**：ADR-009 §养成轴、`server/engine/src/config.ts`。

---

### ✅ A2  单位 1–9 级 + 集卡合成 + trait（依赖 A1）

**A2-a 等级与合成**
- `server/engine/src/config.ts`：每单位九档 `UnitLevel[1..9]`（HP/ATK/SPD/armor 乘算），`5 × N → N+1` 合成配方表。
- `server/shared/src/pveRewards.ts`：`craftUnit(type, fromLevel)` 材料消耗函数。
- `POST /unit/craft`（metaserver）：校验材料 → 合成 → 写 `SaveData.unitCards` → 回推；乐观锁。
- `SaveData` 扩展 `unitCards: Record<UnitType, number[]>`（每级持有数量数组）。

**A2-b trait（单位特性，三档）**
- T3 暴击（每次攻击 15% 概率双倍伤害）/ T6 吸血（攻击回复 20% 伤害为 HP）/ T9 +1 出兵（每次产出 +1 单位）。
- 引擎 `applyTrait(unit, level)` 注入，仅 campaign/SLG 读，PvP 硬墙（`buildPvpBlueprints` 不传 unitCards）。

**A2-c 客户端 UI**
- `CollectionScene`（已占位）：背包网格 + 单位卡等级 + 合成按钮 + trait 展示。
- i18n `collection.*`（zh/en/de）。

**验收**：S12 硬墙单测——满级 `buildPvpBlueprints()` 与常量相等；PvP 引擎零 trait 泄漏；合成 e2e 扣材料原子。

---

### ✅ A3  战斗数值重算（依赖 A1 armor 落地）

- 重跑 TTK 速算表（基础兵 vs 基础兵、护甲 0/5/10/15/20 五档）。
- 调整 `config.ts` 数值使 PvE 关卡 1-6 章难度梯度合理。
- 更新 `design/game/BALANCE.md` 快照（带日期）。
- **注**：无需改引擎逻辑，只改 config 常量。

---

### ✅ A4  体力系统（可与 A2 并行）

**范围**：
- `SaveData.stamina: { current, regenAt }` + 每 6 分钟自然恢复 1 点，上限 120。
- `POST /pve/clear` 已有乐观锁，追加体力消耗参数（不同关卡 cost 1–5，定义在 level JSON）。
- 客户端 `LevelPrepScene` 显示体力消耗 + 不足时付费购买弹层（商店路由）。
- 服务端 `pveStamina` 集合（`dayKey` 不适用，实时扣）。

**验收**：体力耗尽拦截 + 恢复不超上限 + 付费补体力走 commercial。

---

### A5  装备系统全栈（可与 A2/A4 并行，不依赖 A1）

**A5-a 服务端（metaserver + commercial）**

按 `SERVER_API.md §2.8` 实现以下端点：
- `POST /equipment/craft`：文具材料 → 0 级基础件（写 `SaveData.equipment[]`，库存 ≤300 个实例）。
- `POST /equipment/enhance`：概率强化 +1→+9（成功率 90%/80%/…/10%，失败扣材料/金币，不掉级）；`commercial` 扣金币。
- `POST /equipment/salvage`：分解（返还 70% 打造材料，+5 及以上禁拆）。
- `POST /equipment/reforge`：洗练词条（0/1 条全随机，2 条可传 `lockAffixIndex?`）；`commercial` 扣锁定费。
- `POST /equipment/equip`：写 `saves.equippedEquipment[unitType][slot]`。
- 库存满时新实例转等值材料补偿。

**A5-b 客户端 UI**
- `EquipmentScene`：背包网格（300 格）/ 强化概率提示 / 洗练锁定交互 / 分解确认（+5 以上禁用）/ 穿戴面板（3 槽）。
- `GameScene`：战斗中 unit tooltip 显示装备词条（PvP 硬墙，仅 PvE/SLG 读）。
- i18n `equipment.*`。

**验收**：ADR-012 库存上限 300 单测；强化并发原子（`commercial $gte` 守卫）；分解 70% 返还精确；PvP 战斗零装备泄漏。

---

### A6  Anna 侧三角色（依赖 A1/A2，美术并行）

**引擎**（不依赖美术）：
- `config.ts` 新增 Max / Lena / Mara 三单位定义（数值锚点参照对位陶卡，各有一条差异化机制）。
- Max：`burstOnSingle: true`（出 1 强单体）；Lena：`disciplineArmor: 8`（固定减伤）；Mara：`markEnemies: true`（标记增伤）。
- PvE Ch2/4/6 通关奖励写 `pveRewards.ts`。

**美术**（独立子任务，animator worktree）：
- 新建三个 .tao 骨骼动画文件；`SKIN_ASSETS` 注册表填充。

**验收**：PvP 公平局（六张卡全送，无付费差异）；PvE 解锁路径 e2e。

---

### A7  SLG §16.5 数值调参（依赖 A3 完成）

- 每单位兵力滑杆打磨（围攻人数上下限）。
- 围攻结算伤害数值与 PvE 数值对齐（ADR-009 护甲统一后重跑）。
- 更新 `SLG_DESIGN.md §16.5`。

---

## Track B — 元系统留存

> **worktree 建议**：`git worktree add ../funny-track-b track-b`
>
> 全程零引擎改动。所有端点走 metaserver + commercial，存 Mongo 新集合。

### ✅ B1  成就系统（S9）—— 最优先，其余依赖其 statKey 基础设施

**服务端**：
- `achievements` 集合 `{accountId, statKey, count, claimedMilestones[]}`。
- `POST /stat/increment`（内部，由通关/结算等事件触发）：原子 `$inc`。
- `GET /achievements`：返回全量 + 已领取标记。
- `POST /achievement/claim`：幂等，发一次性金币（走 `commercial creditCoins`）。
- `ACHIEVEMENT_DEFS`（shared）：成就定义表（statKey / 里程碑阈值 / 奖励金币）。

**客户端**：
- `AchievementScene`：成就墙（分类：战斗/收集/社交/探索）+ 进度条 + 领取按钮 + 红点。
- 大厅导航入口。
- i18n `achievement.*`。

**验收**：计数器服务器权威（客户端无写口）；领取幂等（重复 POST 不双发）；红线单测绿。

---

### ✅ B2  天梯赛季 + 排行榜（S11，可与 B1 并行）

**服务端**：
- `seasons` 集合 `{seasonId, startAt, endAt, status}`。
- `ladderSeasons` 集合：每赛季快照 `{accountId, seasonId, peakElo, rank, rewards}`。
- `POST /internal/season/open`（admin 内部，手动触发）：写 `seasons` + 惰性迁移现有 `pvp.elo` → 向 1200 软重置（`elo = 1200 + (elo-1200)*0.5`）。
- `GET /leaderboard`：全服 Top100（从 `saves.pvp.elo` 实时查，加缓存 TTL 5min）。
- 赛季结算：admin 触发 `POST /internal/season/close` → 生成快照 → 发段位奖励走邮件 → 发段位首达称号（触发 B3）。
- `SERVER_API.md §2.11` 端点。

**客户端**：
- `LeaderboardScene`：全服 Top100 + 本人排名。
- `SeasonScene`：当前赛季信息 + 赛季结束倒计时 + 历史赛季快照。
- i18n `season.*` / `leaderboard.*`。

**验收**：软重置计算正确（1200 回归）；Top100 缓存 TTL；赛季切换 admin 操作不阻塞玩家。

---

### ✅ B3  称号系统（S10，依赖 B1 + B2 赛季快照就位）

**服务端**：
- `titles` 集合 `{accountId, titleId, grantedAt, source, seasonId?}`。
- `POST /internal/title/grant`（内部，多来源调用：赛季结算/成就系统/运营后台）。
- `GET /titles`：返回全量已授予称号。
- `PUT /title/equip`：选用当前显示称号（写 `saves.equippedTitle`）。
- `TITLE_DEFS`（shared）：称号定义表。

**四处展示**：头像悬浮（ProfilePopup 已有框架）/ 结算页 / 天梯排行榜行 / SettingsScene 资料页。

**验收**：多来源授予不重复；赛季快照称号与赛季 ID 绑定；ProfilePopup 显示对方当前称号。

---

### ✅ B4  战令（S11 Battle Pass，依赖 B2 赛季）

**服务端**：
- `battlepass` 集合 `{accountId, seasonId, tasks[], freeTrack[], paidTrack[], paidUnlocked}`。
- 任务计数复用 B1 `statKey`（`$inc` 链，非独立计数器）。
- `POST /battlepass/claim`：按 tier + track 幂等领奖（free 任何人 / paid 须 `paidUnlocked`）。
- `POST /battlepass/unlock`：IAP 购买付费战令（走 commercial）。

**客户端**：
- `BattlePassScene`：两轨道横向滚动 / 任务进度 / 解锁按钮。
- i18n `battlepass.*`。

**验收**：免费 / 付费双轨独立幂等；付费战令跨设备同步（服务器权威）。

---

### ✅ B5  每日签到 + 日常任务（ADR-011，依赖 B1 statKey）

**服务端**：
- `dailyTasks` 集合 `{accountId, dayKey, tasks[]}`：每日重置，任务定义表（杀敌 N / 胜利 N / 刷关 N）。
- 任务进度由 B1 `statKey` `$inc` 驱动（不另开写口）。
- `POST /daily/claim`：满足条件发奖（软通货：体力/材料/卡，金币 ≤2/天）。
- `checkin` 集合 `{accountId, month, checkedDays[]}`：月历累计，断签不清零。
- `POST /checkin`：幂等签到，返回今日奖励（主发体力/材料，极少金币）。

**客户端**：
- 大厅「每日」入口 / 签到月历 / 任务列表 + 领取红点。
- i18n `daily.*` / `checkin.*`。

**验收**：金币日上限 2 单测；`dayKey` 跨时区正确（服务器 UTC `Math.floor(ts/86400000)` 为准）。

---

### B6  限时活动容器（ADR-014，依赖 B1/B5 基础设施）

**服务端**：
- `events` 集合 `{eventId, title, windowStart, windowEnd, tasks[], rewards[]}`（admin 写入）。
- `POST /events/claim`：幂等积分兑换（积分活动期清零）。
- 发奖走 OPS 邮件路径（已有）；限定直购走 commercial 商店。
- `GET /events`：返回当前窗口内活动列表。
- `SERVER_API.md §2.9` 端点。

**客户端**：
- `EventScene`：活动列表 + 任务进度 + 积分商店 + 限定皮肤直购。
- i18n `event.*`。

**验收**：活动期外 claim 被拒；积分不跨活动结转；金币奖励计入月度预算上限（软断言 log）。

---

### B7  社交频道 S6-4（依赖 Track C Redis 就位，最后做）

- 独立 `social` 服务 + Redis pub/sub + gateway 订阅投递。
- 帮会/家族/国家频道（SLG 世界内）。

**验收**：频道消息 <500ms 延迟；gateway 掉线重连自动补订阅。

---

## Track C — 商业合规 + 验收加固

> **worktree 建议**：`git worktree add ../funny-track-c track-c`
>
> 服务端硬化 + 联调测试，零游戏玩法改动。

### C1  IAP 真实渠道验签（发布阻断，最优先）

**范围**（`commercial/src/iap.ts`）：
- Apple：`POST https://buy.itunes.apple.com/verifyReceipt`（sandbox / prod 双重试）；提取 `in_app[].product_id` 与 tier 对应表核对；`receiptId` 幂等。
- Google Play：`googleapi.androidpublisher.v3.purchases.products.get`；服务账户 JWT 签名；同样幂等。
- 环境变量 `NW_APPLE_PASSWORD` / `NW_GOOGLE_SERVICE_ACCOUNT_JSON`。
- dev 桩 `tier:xxx` 保留（`NODE_ENV=development` 时走桩）。

**验收**：伪造收据被拒；重放已验收据返回 `receiptId` 幂等成功不双发；单测覆盖 Apple/Google 响应解析。

---

### C2  广告奖励服务端校验（S2-4）

**范围**（`metaserver/src/ads.ts`）：
- `POST /ads/reward` 现在只做了客户端 UI，补服务端：平台回调签名校验（AdMob server-side verification / 微信广告回调）。
- `adsDaily` 集合已有 dayKey 计数，补「广告凭证唯一性」（凭证 hash 落库，重放拒绝）。
- 单次 3 coins / ≤5 条/天 / 间隔 ≥30min（`lastAdAt` 字段）。

**验收**：伪造回调被拒；超日上限 429；30min 间隔门。

---

### C3  PvP hash 对比（S4-2）

**范围**（`metaserver/src/internal.ts`）：
- `match_over` 已有 `hashOk` 落库，补：hash mismatch 时除 S1-J 裁判路径外，服务器主动记录 `matches.hashMismatch` 事件并触发警报（admin 后台可见）。
- `GET /admin/mismatches`（admin 服务）：列出 24h 内 mismatch 对局。

**验收**：人为构造分歧被检出并落 admin 后台。

---

### C4  PvE 反作弊处置（S4-4 待办）

**范围**：
- `pveVerifications` 已有 `status: 'suspicious'`，补后续处置：
  - 首次可疑：发警告邮件（走 OPS 邮件）+ `accounts.flags.pveWarnings++`。
  - 累计 3 次：`accounts.flags.banned=true` + 封号逻辑（auth 返 `ACCOUNT_BANNED`）。
- admin 后台 `GET /admin/suspicious-pve`：人工审核界面。

**验收**：三次触发封号单测；封号账号 auth 返 403；可疑记录 admin 可见。

---

### C5  合规接口（ADR-013/015，发布阻断）

**C5-a 抽卡概率公示**
- `GET /gacha/pools`（已有）扩展：每个 `GachaPool` 返回 `weightTable[]`（itemId / rarity / probability，按 ADR-013 Apple 3.1.1 要求）。
- 客户端 `GachaScene` 增加「概率详情」按钮 → 弹层展示。

**C5-b 账号删除**
- `DELETE /account`（metaserver）：软删除 `accounts.deletedAt`；异步清理 saves/wallets/社交数据（7 天宽限期）；返回确认 token。
- `SettingsScene` 增加「删除账号」入口（二次确认弹层）。
- Apple 5.1.1(v) 硬要求。

**C5-c GDPR 同意**
- 首次启动弹同意弹层（隐私政策 + Cookie 同意），用户接受后写 `flags.gdprConsent: true`。
- analyticsvc 埋点前检查 `gdprConsent`（`analyticsvc/src/index.ts`）。

**验收**：未同意用户无埋点数据；删账号 7 天后数据不可查；GachaPool 权重和 = 1（单测）。

---

### C6  验收联调（三项手动 + 一项 CI）

**C6-a 多设备存档同步（S0-8）**：A 设备改存档 push → B 设备 bootstrap pull → 数据一致；离线改 → 上线 409 合并不丢。

**C6-b 双真机对局（S1-9）**：两台设备友谊房完整一局逐 tick 一致；中途断一台重连续打（conn_resync）。

**C6-c 防刷 e2e（S2-7）**：本地改 `wallet.coins` 后任何花币动作被 commercial `$gte` 守卫拒绝。

**C6-d 对局 hash 比对 CI**：`test/e2e` 新增用例——headless 双客户端对局，一方注入错误 hash，断言 `matches.hashMismatch` 写入。

---

### C7  基础设施（为 B7 铺路）

**Redis 接入**：
- `docker-compose.prod.yml` 加 `redis` 服务（`redis:7-alpine`）。
- `gateway/src/index.ts` 接 `ioredis`，`InMemoryRoomRegistry` 可选切 `RedisRoomRegistry`（环境变量开关）。
- 为 B7 频道 pub/sub 预留 `redis.subscribe/publish` 封装。

**录像外存（S3/GCS）**：
- `metaserver/src/internal.ts`：大局录像（>256KB）改存 S3/GCS，`matches.replayRef = {bucket, key}` 替换 `replayBlobs` 集合。
- `GET /match/{roomId}/replay`：从对象存储 presigned URL 回传。
- 环境变量 `NW_REPLAY_BUCKET` / `NW_REPLAY_REGION`。

**中国区合规（可推迟到版号申请前）**：
- 实名认证接口（华为游戏服务 / 腾讯实名 API）。
- 未成年人防沉迷（登录累计时长检测）。
- 分龄充值限额（`accounts.birthYear` 字段）。
- 参照 `design/game/COMPLIANCE_CN.md`。

---

## 轨道间交接点

| 时间点 | 交接内容 | 从 → 到 |
|---|---|---|
| A1 完成后 | 护甲引擎 API 稳定（`armor` 字段合入 shared engine types） | Track A → Track B 可用新 unit 类型做成就 statKey 扩展 |
| B1 完成后 | `statKey` 基础设施 + `POST /stat/increment` 就位 | Track A 通关/升级事件开始调用；Track C PvE 反作弊可用 achievement 计数 |
| C7 Redis 就位后 | Redis 连接封装 + `RedisRoomRegistry` 接口 | Track B 开始 B7 频道实现 |
| Track A 全部完成后 | 装备系统 + 单位体系稳定 | SLG §16.5 调参；装备拍卖 A/D 缺口（在 Track A worktree 内接续） |

---

## 发布前硬门（P0，任一未完成不能上架）

1. **C1** IAP 真实验签（Apple/Google）
2. **C5-a** 抽卡概率公示
3. **C5-b** 账号删除端点（Apple 5.1.1(v)）
4. **C5-c** GDPR 同意弹层
5. **C2** 广告奖励验签（防伪造）
6. **C6-b** 双真机对局验收（联机核心功能）

---

## 内容上架前需要（P1，影响首发留存）

7. **A2** 单位养成（无深度则次日留存极低）
8. **A5** 装备系统（最深氪点）
9. **B1** 成就系统（留存钩子）
10. **B2** 天梯赛季（排位竞技目标）
11. **B4** 战令（商业化主收入）

---

## 参考文档

- 任务进度详情：[`META_TASKS.md`](META_TASKS.md)
- 经济/养成数值：[`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)
- 装备机制：[`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md)
- 单位养成：S12 节（`META_TASKS.md`）+ ADR-009（`DECISIONS.md`）
- 赛季设计：[`SEASON_DESIGN.md`](SEASON_DESIGN.md)
- 合规：[`COMPLIANCE_GLOBAL.md`](COMPLIANCE_GLOBAL.md) / [`COMPLIANCE_CN.md`](COMPLIANCE_CN.md)
- worktree 约定：[`claudedocs/worktrees.md`](../../claudedocs/worktrees.md)
