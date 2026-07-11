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
- **生命周期**：建目录干活 → 提交到自己分支 → 干完把**分支合进当日集成分支** → 然后才 `git worktree remove` + `git branch -d`。分支已推上远端后本地删了不丢东西；否则合并落地前文件夹和分支都得留着。
- **集成走「当日分支」而非直接进 main**：feature 分支先 `--no-ff` 合进当日日期分支（命名 `DD.MM.YYYY`，如 `11.07.2026`），当日分支再开 PR 进 `main`（历史上如 PR #23/#24）。当日分支若已被 PR 合入 main，复用前先 `git branch -f <日期> origin/main` 快进到最新再合。

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
- **⚠️ 陷阱（2026-07-05 实测踩过）：图快用 Junction/符号链接整个 `node_modules` 目录会让 `@nw/*`（npm workspaces 本地包）解析回主仓库**。`server/node_modules/@nw/shared` 等条目本身就是指向主仓库 `server/shared` 的符号链接；如果为了省 `npm install` 直接把整个 `server/node_modules` 挂成 junction 指到主仓库，worktree 里 `import '@nw/shared'` 实际读到的是**主仓库未重建的 `dist/`**，跟 worktree 里改的 `.ts` 源码毫无关系——测试照样"全绿"，因为断言大多是符号引用（`SLG_MAP_W` 等），值对不对都能过，等于验证了个寂寞。正确做法：只把第三方依赖整体挂 junction（内容不随会话变化，挂哪份都一样），`@nw/*` 这几个 workspace 本地包必须单独用 `New-Item -ItemType Junction`（PowerShell；Git Bash 的 `ln -s` 对目录在无权限时会静默退化成一次性拷贝，不会跟着源码实时变，肉眼看不出区别）指向 worktree 自己的 `server/<pkg>`，且改完 `.ts` 后要 `npm run build` 生成新 `dist/`（多数包靠 `main`/`types` 指向编译产物解析，改源码不够）。验证方法：`node -e "console.log(require.resolve('@nw/shared'))"` 看落地路径，或直接 `echo probe > 目标目录/PROBE.txt` 测试链接是否实时生效。
