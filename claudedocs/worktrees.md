# 并行开发：git worktree 约定

> worktree = 一个仓库挂多个工作目录，各自钉死在不同分支，互不切换。**每条并行线一个 worktree，一个会话进一个目录。**

## 心智模型

**一条线 = 一个文件夹 = 一个分支，三位一体。**

```
.claude\worktrees\<slug>\   ← 文件夹(worktree)：工作目录的壳
        ↓ 检出在
feat/<slug>                 ← 分支：提交真正存放处
```

- **开会话靠「选文件夹」，不靠「切分支」。** 打开对应 worktree 文件夹，git 自动知道它在哪条分支。
- **「Couldn't switch branches」不是 bug**：同一分支不能被两个工作目录同时检出；解法是开那个 worktree 的文件夹。
- **生命周期**：建目录干活 → 提交到自己分支 → 干完把**分支合进 main** → 然后才 `git worktree remove` + `git branch -d`。合并之前，文件夹和分支都得留着。

## 约定（规则）

1. **位置**：所有 worktree 放在 `C:\Users\TaoWang\Documents\funny\.claude\worktrees\<task-slug>\`，已在 `.gitignore` 忽略，不会污染 main。
2. **命名**：目录名 `<task-slug>` 用短横线短名；对应分支统一 `feat/<task-slug>`（目录名与分支后缀一致，避免错配）。
3. **主目录 `funny\` = 集成区**：钉在 `main`，用于 review / 合并 / 跑全量。各 feature 一律在自己的 worktree 里做。
4. **公共依赖先合**：改 `server/contracts` / `@nw/shared` / `@nw/engine` 的分支**最先合 main**，其余分支立刻 `git fetch && git rebase origin/main` 跟上，降冲突。
5. **干完即删**：`git worktree remove <path>`，分支合并后 `git branch -d feat/<slug>`。
6. **自管自清**：每个会话管好自己的分支和 worktree，任务结束时自行合并并清理，无需维护全局索引。

## 命令速查

```bash
# 新建一条并行线（基于 main，分支不存在时一并创建）
git worktree add -b feat/<slug> .claude/worktrees/<slug> main

# 已有分支，只挂目录
git worktree add .claude/worktrees/<slug> feat/<slug>

git worktree list                              # 看所有 worktree
git worktree remove .claude/worktrees/<slug>  # 删目录（工作树需干净）
git worktree prune                            # 清理失效记录

# 每条线保持跟 main 同步
git fetch origin && git rebase origin/main
```

## 注意

- worktree 共用同一个 `.git`，分支/历史/对象库全共享；磁盘只多一份工作文件。
- **同一分支不能被两个 worktree 同时检出**（git 会拒绝）。
- worktree 内 `npm install` 的 `node_modules` 各自独立（已 gitignore），首次进新 worktree 需各自装依赖。
