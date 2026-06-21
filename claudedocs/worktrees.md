# 并行开发：git worktree 约定 + 索引

> 解决「多会话并行开发」的两难：都在 main 会互踩提交；共用一个目录建分支会因 `git checkout` 全局切换打架。
> worktree = 一个仓库挂多个工作目录，各自钉死在不同分支，互不切换。**每条并行线一个 worktree，一个会话进一个目录。**

## 心智模型（先读这个）

**一条线 = 一个文件夹 = 一个分支，三位一体。**

```
.claude\worktrees\auction-house\   ← 文件夹(worktree)：工作目录的壳，是你打开的「门」
        ↓ 检出在
feat/auction-house                 ← 分支：你的提交真正存放处，是「门后的房间和东西」
```

- **开会话靠「选文件夹」，不靠「切分支」。** 打开对应 worktree 文件夹，git 自动知道它在哪条分支，提交就落到那条分支。桌面 app 的分支切换器用不上、无视即可。
- **「Couldn't switch branches」不是 bug**：同一分支不能被两个工作目录同时检出；它已被某 worktree 占用，所以别处切不过去。解法是开那个 worktree 的文件夹，而不是切分支。
- **分支不能随便删。** 删 `feat/xxx` = 删那条线还没合进 main 的提交，且被 worktree 占用时 git 直接拒绝。只有「没绑 worktree 且内容已在别处」的游离/重复分支才能删。
- **生命周期**：开文件夹干活 → 提交到自己分支 → 干完把**分支合进 main** → 然后才 `git worktree remove` 拆文件夹 + `git branch -d` 删分支。**合并之前，文件夹和分支都得留着。**

| 新会话要做 | 打开这个文件夹 |
|---|---|
| 集成 / 合并 / review | `funny\`（主目录，钉 main）|

> 拍卖行/装备 + 成就系统 worktree 均已于 2026-06-21 合并 main 后删除；**成就系统 S9 全部落地**（S9-7/S9-8 在 `nice-wu-5c3478` 收口，见索引表）；后续装备 E2~E4 续做时重新 `git worktree add`。

## 两种工作模式（怎么开会话）

桌面 app 新建会话时有个 **`worktree` 复选框**，行为是「**勾选 = 给本会话新建一个全新 worktree+分支**」：会切一条 `claude/<随机名>` 分支，**默认从 `main` 的 tip 切**（受 `worktree.baseRef` 影响，默认 `fresh`=origin/HEAD）。分支下拉里选 `feat/xxx` 只是选「从哪切」，**叠加勾选 worktree 仍会另造新分支**，不会进已有的那条 feat 线——这点最容易踩坑。

由此分两种模式，按任务大小二选一：

### A. 用完即弃（一次性 worktree）— 一轮对话能做完并合 main 的活
改 bug、加小功能、调数值、写文档这类。

1. 新建会话 → 项目 `funny` → **勾 `worktree`**（分支留 `main`即可）→ app 自动造 `claude/<随机名>`。
2. 干活、提交到这条临时分支。
3. **收尾(可让 Claude 代做)**：到主目录 `funny\` 把临时分支合进 main → `git worktree remove` 删目录 → `git branch -D` 删分支。

> 好处：**零维护**，不用记目录↔分支对应。代价：跨多轮对话会丢半成品（见下）。

### B. 长期 feature worktree — 跨多轮才能做完的大功能
成就、拍卖行、SLG/G5 这类。**不能**用 A：会话被上下文上限打断后开新会话，「从 main 全新开始」拿不到上一轮那条 `claude/xxx` 临时分支上的半成品。

→ 用带名字的 `feat/<slug>` worktree（见索引表），**打开对应文件夹**（**别勾 worktree 新建**），多轮提交攒在同一条 feat 线上，整块做完再合 main。打不开子目录就命令行 `cd .claude/worktrees/<slug> && claude`。

## 约定（规则）

1. **位置**：所有 worktree 放在 `C:\Users\TaoWang\Documents\funny\.claude\worktrees\<task-slug>\`，已在 `.gitignore` 忽略，不会污染 main。
2. **命名**：目录名 `<task-slug>` 用短横线短名；对应分支统一 `feat/<task-slug>`（目录名与分支后缀一致，避免错配）。
3. **主目录 `funny\` = 集成区**：理想状态钉在 `main`，用于 review / 合并 / 跑全量。各 feature 一律在自己的 worktree 里做。
4. **一线一会话**：开新会话时进入对应 worktree 目录即可，无需每次说明工作目录——查下方索引表对号入座。
5. **公共依赖先合**：改 `server/contracts` / `@nw/shared` / `@nw/engine` 的分支**最先合 main**，其余分支立刻 `git fetch && git rebase origin/main` 跟上，降冲突。
6. **共享索引文件**（`design/META_TASKS.md` 等多分支都动的）尽量只追加、单独小提交，冲突好解。
7. **干完即删**：`git worktree remove <path>`，分支合并后 `git branch -d feat/<slug>`。

## 实时索引

| 任务 | task-slug | 分支 | worktree 目录 | 状态 |
|---|---|---|---|---|
| 集成 / review | — | `main` | `funny\`（主目录）| ✅ 钉 main，集成区 |
| S9 成就系统 | achievement | ~~`feat/achievement-system`~~（已删） | ~~`.claude\worktrees\achievement`~~（已删） | ✅ **已合 main 并清理**（merge 605437dd，2026-06-21）：S9-1/2/4 服务端基座 + S9-3 PvE 章节计数 + S9-5 客户端成就墙（AchievementScene + StatsScene 入口 + 大厅红点 + i18n 三语）。SaveData 合并冲突解为装备+成就字段并存；openapi.ts 从权威 yml 重生。后续会话续做 S9-5b（达成 toast）/S9-6（PvP 计数/L1）/S9-3b（引擎分类型埋点 + PvE 喂入，见下行）均已完成；**仅剩 S9-7（反作弊 L2/L3）/ S9-8（埋点+校准）**，续做重新 `git worktree add` |
| S9-3b PvE 喂入 | reverent-golick-747a15 | ~~`claude/reverent-golick-747a15`~~（已删） | ~~`.claude\worktrees\reverent-golick-747a15`~~（已删） | ✅ **已合 main 并清理**（2026-06-21）：裁判 PvE 复算 kill/cast 经 `JudgeVerdict.stats_json`（proto + 两套 codec）→ gateway 透传 → meta `pveVerify` 仅 verified 时过 L1 caps 入账。meta 159 + gateway judge 4 + gameserver 42 + 引擎 combat 10 绿。详见 `design/game/ACHIEVEMENT_DESIGN.md §11` |
| S9-7/S9-8 成就收口 | nice-wu-5c3478 | `claude/nice-wu-5c3478` | `.claude\worktrees\nice-wu-5c3478` | ✅ **完成待合 main**（2026-06-21）：S9-7 反作弊 L2/L3（meta `anticheatAudit.auditOnce` 定时抽查批经 peer 裁判复算 per-side 成就计数 → 比对超报 → 回滚+升 `statSuspicion`+`antiCheatReviews` 审查队列；裁判 `judgeRunner` PvP 分支扩 per-side `statsJson`；`MatchDoc.reportedStats`/`audited`；OPS 链 meta→admin(`anticheat.view`)→ops `pageSuspicions`）+ S9-8（`achievement_view_wall` 漏斗 + 红线 e2e + `coin-pool` 校准）。`@nw/shared antiCheatAudit.ts` 18 单测 + meta 9 e2e；**meta 191 全绿**、admin 18 绿、`tsc -b` 全包 + client tsc/webpack + ops webpack 成功。**成就系统全部落地**。详见 `ACHIEVEMENT_DESIGN.md §11` |
| SLG 拍卖行/装备 | auction-house | ~~`feat/auction-house`~~（已删） | ~~`.claude\worktrees\auction-house`~~（已删） | ✅ **已合 main 并清理**（merge 92348b8b，2026-06-21）：装备 E0 数据模型（shared/SaveData/openapi 契约 + 存档 v1→v2）+ E1 引擎注入（applyEquipment/clampEffectCaps + 三套蓝图 + 硬墙/单调/封顶单测）。拍卖主干 S8-5 早在 main；缺口 A（装备交易）待装备 E2~E4 续做。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上 |

> 改并行线时同步更新本表（增删 worktree、状态变化）。

## 命令速查

```bash
# 新建一条并行线（基于 main，分支不存在时一并创建）
git worktree add -b feat/<slug> .claude/worktrees/<slug> main
# 已有分支，只挂目录
git worktree add .claude/worktrees/<slug> feat/<slug>

git worktree list                         # 看所有 worktree
git worktree remove .claude/worktrees/<slug>   # 删目录（工作树需干净）
git worktree prune                        # 清理失效记录

# 每条线日常保持跟 main 同步
git fetch origin && git rebase origin/main
```

## 注意

- worktree 共用同一个 `.git`，分支/历史/对象库全共享；磁盘只多一份工作文件。
- **同一分支不能被两个 worktree 同时检出**（git 会拒绝）。
- worktree 内 `npm install` 的 `node_modules` 各自独立（已 gitignore），首次进新 worktree 需各自装依赖。
