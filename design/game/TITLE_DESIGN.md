# 称号系统设计（Title / 公开身份名片）— DRAFT

> **状态**：✅ **已实现**（2026-06-22，`META_TASKS.md S10-1～5` 全 ✅）。ranked 队列（S1-R）已落地；赛季结算（S11-SE-4）已接入称号授予。
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
- 佩戴走专属端点 `PUT /title/equip`（`{titleId}` → 校验 **`titleId ∈ titles`**，否则 403）；`equipped.title` 与 `equipped`/`flags` 的其余字段一样是纯服务器权威段，无任何客户端可写的通用同步接口（ADR-056，取代了本文写下时还存在的 `PUT /save`/`SyncPatch` 通用同步端点）。
- 赛季峰值追踪：`pvp` 段加 `seasonPeakRank`（赛季内最高段位，赛季结算时读它授称号再清零）。
- **定义表**：`@nw/shared` 维护 `TITLE_DEFS: Record<TitleId, { weight: number; source; ... }>`（硬编码，同 `Achievement` 定义表风格），`weight` 即跨来源序的唯一来源（§6.1）。赛季类 titleId 按模板生成（`ladder.s{N}.{rank}` 共用同 `rank` 的 weight）。

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
- 「最高」= `weight` 最大；并列取**最新获得**（§6.1）。
- 新号**默认佩戴 `event.newbie` 起步称号**（2026-07-16 落地）：`makeNewSave` 建档即 `titles: ['event.newbie']` + `equipped.title = 'event.newbie'`；老号在 `GET /save` 惰性幂等补发（`grantTitleToPlayer`），故所有账号上线即拥有。`event.newbie` 为 T1（weight 1300），永远不会顶掉玩家已挣得的更高称号。

### 6.1 跨来源等级序（`weight` 数据驱动，2026-06-21 定）

**为什么按声望档分带、而非按来源分带**：若整源排序（如「SLG 整源 > 天梯整源」），纯 PvP 玩家的 `王者` 会被一个低阶 SLG 参与称号自动顶掉——体感很糟。改为**按声望档（T1…T6）交错**：每个称号定义带一个整数 `weight`，跨来源同档可比，自动佩戴 = `argmax(weight)`。

**单一序源**：每个称号定义在 `@nw/shared` 的 `TITLE_DEFS` 表里带 `weight: number`。序完全由该字段决定，`grantTitle` / 客户端 / 榜单全读同一字段，**不在任何地方写 source 比较逻辑**。

**weight 公式**：`weight = 档位基数(T*1000) + 来源偏移 + 档内序`。来源偏移仅用于**同档内**给确定性全序（避免并列），不表达「来源谁高」。

| 声望档 | 基数 | 天梯段位 | SLG 赛季 | 成就 | 活动 |
|---|---|---|---|---|---|
| **T6 传奇/唯一** | 6000 | — | 十冠王（连续赛季成就）/ 赛季占国第一门主 | 全成就集齐（元成就） | 内测创始 `event.founder` |
| **T5 顶级** | 5000 | 王者 king | 赛季冠军宗门成员 | 标志性顶阶（如全章节三星通关） | 大型赛事冠军 |
| **T4 高级** | 4000 | 宗师 grandmaster / 大师 master | 赛季高排名（占国前列） | 高阶里程碑（满阶稀有条目） | — |
| **T3 中级** | 3000 | 星耀 star / 钻石 diamond | 赛季中排名 | 中阶里程碑 | — |
| **T2 进阶** | 2000 | 铂金 platinum / 黄金 gold | 赛季参与（达标即得） | 普通满阶 | 节日参与 `event.*` |
| **T1 基础** | 1000 | 白银 silver / 青铜 bronze | — | 入门里程碑 | `event.newbie` 起步 |

> 来源偏移建议：天梯 `+0`、SLG `+100`、成就 `+200`、活动 `+300`（仅决定同档并列时的稳定序，无声望含义）。档内序再 `+0…+9`（如天梯同档两段：钻石 3000，星耀 3009）。

**并列与新鲜度**：`weight` 完全相等时（极少，仅同源同档跨赛季，如 `ladder.s3.king` vs `ladder.s4.king` 都是 5000）取**最新获得**。`titles: string[]` 数组顺序即获得顺序（`$addToSet` 新元素追加末尾），故「最新」= **末位索引更大者**，无需额外时间戳。

**授予时自动佩戴算法**（`grantTitle` 内）：
```
grant(t):
  if t ∉ titles: titles.push(t)              // $addToSet
  cur = equipped.title
  if cur == null
     or TITLE_DEFS[t].weight > TITLE_DEFS[cur].weight
     or (weight 相等 且 t 在 titles 中索引更大):
       equipped.title = t                      // 自动换上更高/更新的
```
> 玩家手动改佩戴后，下次获得**更高 weight** 仍会自动覆盖（符合「自动佩戴最高」语义）；只有获得**同档或更低**的不抢佩戴位。

**段位称号跨赛季**：每季 king 是不同 titleId（`ladder.s{N}.king`）但同 `weight=5000`；获得 S4 king 时与在戴的 S3 king 并列 → 取新（末位索引大）→ 自动戴 S4。展示短标签拼当季 `S{N}`。

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
| **资料弹层**（必做） | 佩戴称号 + 可展开「称号墙」看全部 `titles` | meta `GET /internal/profile` 已回 `{displayName, publicId}` → **加 `equippedTitle`**（已实现 = `ProfilePopup` 统一玩家信息面板）|
| **对战内名牌** | 对手名旁短标签 | 复用 `ProfilePopup` 已建的 ticket→`match_start` opponent 身份链路 → 加 `opponentTitle` |
| **聊天名前缀** | `[王者] 昵称`（短,限长） | social 渲染消息时附 sender 的 `equippedTitle`（`SOCIAL_DESIGN`）|
| **排行榜** | 名字旁短标签 | 天梯 / SLG 榜查询 join `titles`（取 `equippedTitle`）|

---

## 9. 实现记录 / 遗留

- [x] `@nw/shared/src/titles.ts`：`TITLE_DEFS`（4条永久称号）、`grantTitle` 纯函数、`ladderTitleId`、`titleWeight`、`LADDER_RANK_WEIGHTS`
- [x] `@nw/shared/src/types.ts`：`SaveData.titles?: string[]`（服务器权威段）
- [x] `@nw/shared/src/ticket.ts`：`TicketClaims.opponentTitle?: string`
- [x] `server/metaserver/src/titles.ts`：`grantTitleToPlayer` DB 写帮助函数（`$addToSet` 幂等 + 条件 `$set equipped.title`）
- [x] `server/metaserver/src/accounts.ts`：`getProfile` 返 `equippedTitle`
- [x] `server/metaserver/src/service.ts`：`claimAchievement` 顶阶→称号；`getLeaderboard` 含 `equippedTitle`
- [x] `server/metaserver/src/ladderSeason.ts`：`settleSeasonForPlayer` → `grantTitleToPlayer(ladderTitleId(prevSeasonNo, peakRank))`
- [x] `server/metaserver/src/internal.ts`：`POST /admin/grant-title` 活动授予
- [x] matchsvc：`QueueEntry.equippedTitle` → `sign()` → `TicketClaims.opponentTitle`
- [x] gameserver：`match_start` proto field 8（tag 66）`opponentTitle`；`Room.Slot.opponentTitle`；`RoomManager.join` 透传
- [x] 客户端 `client/src/game/meta/titles.ts`：mirror TITLE_DEFS + `titleWeight`/`getTitleKeys`/`formatLadderTitle`/`highestTitle`
- [x] 客户端 `client/src/net/proto/transport.ts`：`MatchStart.opponentTitle` field 8 encode/decode
- [x] 客户端 UI：`ProfilePopup` 称号行 + `LeaderboardScene` 称号芯片 + `TitlesScene` 称号墙 + `StatsScene` 顶栏入口（原设置页入口已于 2026-06-27 迁移至生涯顶栏）
- [x] i18n zh/en/de：`settings.titles`/`titles.*`/`title.*` 全文案
- [x] **L2-2（2026-06-23）独立称号端点**（设计对齐，此前仅靠 SaveData 回推展示）：
  - `GET /titles` → `{ titles: {id, source, seasonNo?}[], equipped }`；`source`/`seasonNo` 由 `parseTitleId` 从 titleId 命名约定派生（与客户端展示同源）。**授予时间 grantedAt 不入库**（`titles` 仅存 id 顺序），故端点不返回 grantedAt。
  - `PUT /title/equip` body `{titleId}` → 仅允许已授予称号（未授予 403）；空串 = 卸下；写 `save.equipped.title` 并回推完整 `SaveData`。
  - `@nw/shared/src/titles.ts`：新增 `parseTitleId(titleId) → {source, seasonNo?}`（纯函数，服务端/客户端可共用）。
  - `openapi.yml` 登记两端点（operationId `getTitles`/`equipTitle`），客户端 codegen 重生（顺带修复了此前累积的 codegen 漂移，使 `openapi.ts` 与 spec 完全同步）。
  - 存储仍复用 `save.titles[]` / `save.equipped.title`（服务器权威，PUT /save 不可写此二字段），未引入新存储。测试 `metaserver/test/titles.test.ts`。
- [x] **新手起步称号自动发放（2026-07-16）**：设计早已定「新号给一枚 `event.newbie` 起步称号」但 grant 一直「实现期定」未接线，导致所有账号称号墙全空（`event.newbie` 只在 `TITLE_DEFS` 有定义，无任何调用发放）。本次补齐：
  - `@nw/shared/src/titles.ts` 新增 `STARTER_TITLE = 'event.newbie'` 常量（单一来源）。
  - `@nw/shared/src/types.ts` `makeNewSave`：建档即 `titles: [STARTER_TITLE]` + `equipped: { title: STARTER_TITLE }`（新号，零额外 DB 开销，原子）。
  - `server/metaserver/src/service/save.ts` `getSave`：在权威读取前 `grantTitleToPlayer(cols, accountId, STARTER_TITLE, now())` 惰性幂等补发（老号，自愈，无需运维脚本；沿用与 `migrateIfStale` 相同的「读时惰性」模式）。补发用 `grantTitle` 纯函数的自动佩戴算法，只在「未佩戴任何称号」时才自动戴上，绝不顶掉玩家已挣得的更高称号（king 等）。
  - 测试：`server/metaserver/test/starter-title.e2e.test.ts`（新号拥有+佩戴、老号补发+自动戴、不抢已挣称号、幂等 4 例）；更新 `titles.test.ts`（新号断言）、`internal-ladder.test.ts`（admin 授予后 titles 含 newbie）。**founder 仍走 admin 手动发放（运营活动），不自动发**。
- [x] **称号墙全目录展示（2026-07-16）**：`TitlesScene` 由"只列已获得"改为展示全部固定称号（`TITLE_DEFS` 4 条，含 event/achievement）+ 已获得的赛季称号；未获得的固定称号灰显 + "未获得"角标、不可点击。是否展示称号完全由玩家决定：点未获得称号无反应，点已获得未佩戴称号→佩戴，再点已佩戴称号→取消佩戴（允许不展示任何称号）。赛季（ladder/slg）未获得的档位不枚举穷举（无固定目录、且跨赛季组合会爆炸），只展示玩家已获得的动态称号。纯客户端改动：`client/src/game/meta/titles.ts`（新增 `allTitleIds`）+ `client/src/scenes/TitlesScene.ts` + i18n `titles.locked`/`titles.tapUnequip`；未触碰 `GET/PUT /titles` 端点或 `save.titles`/`save.equipped` 存储（`TitlesScene` 走 `saveManager` 本地状态，不走该 REST 端点）。展示形式由整行列表改为图标卡网格（勋章 glyph + 短/全称 + 状态角标，每行按可用宽度自适应列数），复用 Equipment/Achievement 等页已有的 icon-card 网格排布手法，纯 `TitlesScene.ts` 内部改动。
- [x] **称号墙 4 枚永久称号换 AI 手绘勋章图标（2026-07-17）**：`TitlesScene` 原来 4 个称号共用同一个程序绘制通用 `medal` glyph，无法区分。按 `art-direction.md` §6.2 白底单色线稿口径出图（勋章+缎带剪影统一、靠中心图案区分主题：`event.founder`=旗+桂冠、`ach.all_chapters`=交叉剑+裂盾、`ach.pvp.veteran`=三道人字纹+划痕、`event.newbie`=新芽），源图 `art/ui/titiles/pack_titles.cjs` 抠白底→裁边→长边缩 256 → `client/src/assets/title_{founder,conqueror,veteran,newbie}.png`。`client/src/render/titleArt.ts` 新增 `TITLE_ICON_URLS`（titleId→url）+ `getTitleIconTexture`；`TitlesScene.drawTitleCard` 命中则用 `PIXI.Sprite` 按 owned/equipped/locked 同色 tint（单色线稿可安全 tint，不同于烤色的 spell 图标），否则回落旧 `buildIcon('medal', …)`——赛季称号（`ladder.s{N}.*`/`slg.s{N}.*`，id 空间不封闭）继续用通用 glyph。
- [x] **称号墙动态称号换程序生成分级勋章（2026-08-08）**：4 枚永久称号已有 AI 手绘图（见上条），但 9 个天梯段位（`ladder.s{N}.{bronze..king}`）+ 2 个 SLG 赛季称号（`slg.s{N}.{champion,top3}`）此前全部落到同一个通用 `medal` glyph（`icons/ui.ts drawMedal`），黄铜到王者视觉上完全无区分。参照 `art-direction.md` 里"棋盘/UI框/简单装饰"可程序绘制的口径 + SLG 商店道具分级图标（`icons/currency.ts` 金币梯度、`icons/slg.ts` 护甲/沙漏梯度）的"实心填充分 alpha 层次 + 细节随等级递增"手法，新增 `client/src/render/icons/titles.ts`：11 个新 `IconKind`（`titleBronze/Silver/Gold/Platinum/Diamond/Star/Master/Grandmaster/King` + `titleChampion/Top3`），每档独立轮廓（圆盘→六边形→星形→盾徽）+ 递增细节（内圈/切面射线/桂冠/皇冠/爆闪光线），全部保持单色描边（跟随调用方传入的 `color`，不引入渐变），故仍兼容 `TitlesScene` 原有 owned/equipped/locked 三态同色 tint 逻辑。`TitlesScene.ts` 新增 `fallbackTitleIcon()` 按 titleId 正则解析段位/SLG key 选图，未识别的新称号继续回落旧 `medal`。纯客户端改动，未碰服务端/存储；无自动化像素级视觉验收（本机 headless Browser 预览工具在本会话中无法合成 WebGL 画面，toDataURL 复现为纯黑——用未改动过的既有 `?sketch` demo 对照复现同样现象，判定是工具环境限制而非本次改动引入的问题），已过 `tsc --noEmit` + webpack dev 编译。
- [x] **称号墙竖屏卡片重叠修复（2026-08-11）**：玩家反馈竖屏下称号墙卡片又窄又高、锁定称号的全称换行后跟"Locked"角标重叠（如英文 "Notebook Conqueror"/"Ranked Veteran" 被硬拆断行压在角标上）。根因两条：① `drawTitleList()` 的 `cellH = h*0.32` 直接用 `h`，而 `ILayout.designWidth/designHeight` 在两朝向下含义互换（portrait 1080×1920、landscape 1920×1080）——landscape 的 `h` 是短边，portrait 的 `h` 却是长边，同一公式在 portrait 下把卡片撑到宽高比约 1:3.3（是 `CardCodexScene.tileH` 已修过的同一类短/长边错用 bug，见该文件 2026-08-09 注释）；② 卡片内状态角标（"Locked"/"Equipped"+"tap to unequip"）用固定比例从卡片底部反向定位，从不知道上方全称文本实际换行成几行，短卡宽 + 超大字号下英文全称换行后必然戳穿角标。修复：`cellH` 改用短边归一化 `(landscape ? h : w) * 0.32`（landscape 分支完全不变）；角标 y 坐标改为 `Math.max(固定底部偏移, 全称文本实测 contentBottom + 间距)`，正常情况不变，换行溢出时角标整体下让。验收：临时写了个不提交的独立 PIXI 挂载脚本（`createLayout`+`ScalingManager`+真实 `TitlesScene`，locale 强制 en 复现最长文案），在浏览器里用 `getBounds()` 读全部 Text 节点做逐对包围盒重叠检测——竖屏（812×375 换算的 1080×2344 设计画布）确认 "Notebook Conqueror"/"Ranked Veteran" 换行后与 "Locked" 不再重叠，横屏（812×375）确认单行不换行、与改前坐标一致（未回归）；`npm run test:ui`（`scenes.ui.ts` 121 例）+ `tsc --noEmit` 全绿。（顺带发现一个无关的、改前就存在、横竖屏等比例复现的极小瑕疵：已装备卡的 "New Player" 全称与 "Equipped" 角标包围盒有约 1px 亚像素级重叠，规模不随 cellH 变化——不是本次改动引入，且远低于可感知阈值，未处理。）纯 `client/src/scenes/TitlesScene.ts` 内部改动，未碰服务端/存储/i18n。
  - **补测试（同日）**：① `test/ui/titlesPortraitOverlap.ui.ts`（headless PIXI，`test:ui`）——竖屏 `cellH` 短边回归（`createLayout(1080,1920)` 断言 `cellH === round(1080*0.32)`，若退回长边 bug 会算出 614）+ 锁定卡「全称标签不超过 Locked 角标」的粗粒度包围盒守卫；同一断言在横屏（`createLayout(1920,1080)`）复跑一遍，`cellH === round(1080*0.32)`（横屏用的仍是短边 `h`，公式未变——确认横屏未受影响）。② `test/titlesBadgeOverflow.test.ts`（纯 node 单测，`npm test` 默认套件）——把角标"向下让位"算法从 `drawTitleCard` 内联的两处 `Math.max(...)` 提炼成导出的纯函数 `badgeYBelowContent(preferredY, contentBottom, gap)`，直接用数字断言而非依赖真实换行渲染。**踩坑记录**：最初想在 `.ui.ts` 里直接断言"Notebook Conqueror"真的换行了再检查不重叠，结果断言失败——`test/harness/pixiHeadless.ts` 的 `measureText` 桩把文字宽度算成 `字符数*7`（完全忽略字号），在本场景实际 `cellW`（竖屏 184）下，三个语言（zh/en/de）现有的全称文案都不会触发这个桩的换行判定（真实大字号渲染才会真正超宽换行）——headless 场景没法复现真实换行触发条件，遂改用上述"提炼纯函数直接单测"的路子精确覆盖角标算法本身，`.ui.ts` 里的重叠检查降级为粗粒度兜底（当前必然不换行故必然通过，但公式/字号回归导致 headless 也开始换行时仍会守住）。
- [ ] 社交消息 sender 前缀（`[称号]`）— 待 S6 social 消息体扩展
- [x] **SLG 赛季称号授予（2026-07-16）**：worldsvc 赛季结算早已发称号，但发的是扁平 id `slg.champion`/`slg.top3`（不带 `s{N}` 段）→ `titleWeight`/`parseTitleId` 都不认（权重 0、来源误判 achievement）、无 i18n → 授而不显、不可排序。本次补齐端到端：
  - `@nw/shared/src/slg/prosperity.ts`：`SettleReward.titleId` → `titleKey`（'champion'/'top3'），结算时由 `slgTitleId(season, key)` 戳上赛季号 → `slg.s{N}.champion`；`server/worldsvc/src/season.ts` 授予改用戳号 id。
  - `@nw/shared/src/titles.ts`：新增 `slgTitleId()` + `SLG_TITLE_WEIGHTS`（champion 5500 > top3 4500，T5+/T4，占位待 launch 校准）；`titleWeight`/`titleShortKey` 按 `slg.s{N}.{key}` 的 key 段解析（未知 key 回落 T3 3500）；`parseTitleId` 原已识别 slg。客户端 `client/src/game/meta/titles.ts` 镜像同步 + 新增 `formatSlgTitle`（`getTitleKeys` 返回 per-key `title.slg.{key}.{full,short}`，4 处显示点无需改）。
  - i18n zh/en/de：`title.slg.champion.*`/`title.slg.top3.*` + 结算邮件 `slg.settle.*`（正文 `|rank=|nations=` 参数插值——顺带让 `FriendsScene/mail.ts` 的 `mailText` 支持 `key|k=v` 拆参传 `t(key, params)`，此前整串当 key 查找 → 结算邮件正文显示原始 token）。
  - 测试：`server/shared/test/titles.test.ts`（champion>top3、slgTitleId 往返）、`client/test/titles.test.ts`（镜像）。「十冠王」/连冠等更高阶 SLG 称号仍为设计意图，未落地。
- [ ] `equipped.title` 短标签限长 UI 截断（建议 ≤ 4 字，前端展示截断即可）
  - **2026-08-16 核实（仍未做，且 en/de 文案本身已超预算）**：起因是 i18n 审计时注意到 `shared/src/titles.ts` 的 `shortKey` JSDoc 写着 `≤4 chars`，怀疑是过期注释——核完不是，是这条 TODO 一直没做。按**字符数**（不是字节，`${#v}` 那种量法对中文会翻倍误导）实测：zh 全部 2–3 字符在预算内；en 5–9（`Conqueror` 9、`Founder`/`Veteran` 7、`Ladder` 6）；de 7–9（`Rangliste` 9、`Eroberer` 8、`Neuling`/`Gründer` 7）。字体是 **monospace**（`sketchUi.txt`），宽度严格正比字符数，所以 en/de 短标签就是预算的 2–3 倍宽。
  - 5 个消费点里只有 `TitlesScene.ts:~356` 有钳制（超过 `cellW*0.88` 就 `scale.set` 缩下去）；`chatRow.ts`、`LeaderboardScene.ts:~356`、`ResultScene/builders.ts:~188`、`ProfilePopup.ts:~234` **都不换行、不截断、不缩放**。
  - ⚠️ **顺带算出一个更严重、且与语言无关的疑似问题（纯几何推算，未截图确认，不要当结论用）**：`LeaderboardScene` 行内 name 起于 `listW*0.18`、称号紧随其后、rank 列心在 `listW*0.68`。**横屏宽松**（name 预算 35–39 字符）；**竖屏很紧**——按 1080×1920 设计尺寸算 `rowH=125`、`nameFs=60`、`titleFs=42`，name 预算 zh 只有 7 个 ASCII 字符、de 只有 3 个，而默认名 `Player1234` 就是 10 个字符（360px）。即**竖屏下只要挂了称号，默认名就会顶到 rank 列**，跟语言无关，de/en 只是把余量从 7 字符压到 3 字符。竖屏 `designHeight` 在修长机型上还会继续拉高 → `rowH` 更大 → 更糟。推算依赖两个假设（monospace ASCII advance ≈0.6em、`「」` 全角 ≈1.0em），**没有真机/截图核对**，`leaderboardScroll.ui.ts` 也不覆盖列几何（headless harness 的 `measureText` 是 `length*7` 的桩，量不出真实宽度——见 `titlesBadgeOverflow.test.ts` 头注）。要动之前先起 dev server 截一张竖屏榜单确认。
- [ ] 成就→称号具体条目清单（§7，与 ACHIEVEMENT_DESIGN 对齐）
