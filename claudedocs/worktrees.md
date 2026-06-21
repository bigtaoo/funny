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
| 拍卖行/装备 | `funny\.claude\worktrees\auction-house` |
| 成就系统 | `funny\.claude\worktrees\achievement` |
| G5 视野 | `funny\.claude\worktrees\slg-g5-alliance-vision` |
| 集成 / 合并 / review | `funny\`（主目录，钉 main）|

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
| S9 成就系统 | achievement | `feat/achievement-system` | `.claude\worktrees\achievement` | ✅ 进行中（S9-3 已提交 f9a61ac5）|
| G5 联盟领地视野 | slg-g5-alliance-vision | `feat/slg-g5-alliance-vision` | `.claude\worktrees\slg-g5-alliance-vision` | ✅ 已建（tip c6188745）|
| SLG 拍卖行/装备 | auction-house | `feat/auction-house` | `.claude\worktrees\auction-house` | ✅ WIP 已提交（5243ae9，equipment 模块 + 存档迁移 + openapi 契约）；改了 @nw/shared/openapi 公共依赖，**合 main 优先**，其余 worktree 随后 rebase |

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
