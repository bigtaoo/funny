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
3. **主目录 `funny\` = 集成区**：钉在**当前当日分支**（如 `12.07.2026`），不是字面意义的 `main`；用于 review / 合并 / 跑全量。各 feature 一律在自己的 worktree 里做，不要直接在主目录改动。
4. **公共依赖先合**：改 `server/contracts` / `@nw/shared` / `@nw/engine` 的分支**最先合 main**，其余分支立刻 `git fetch && git rebase origin/main` 跟上，降冲突。
5. **干完即删**：`git worktree remove <path>`，分支合并后 `git branch -d feat/<slug>`。
6. **自管自清**：每个会话管好自己的分支和 worktree，任务结束时自行合并并清理，无需维护全局索引。

## 命令速查

```bash
# 新建一条并行线（基于主目录当前钉住的当日分支，分支不存在时一并创建；
# 把 <day-branch> 换成 `git -C funny branch --show-current` 的实际值，例如 12.07.2026）
git worktree add -b feat/<slug> .claude/worktrees/<slug> <day-branch>

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
- worktree 内 `npm install` 的 `node_modules` 各自独立（已 gitignore）。**但不必每次都重新 `npm install`**：先 `grep "@nw/" <pkg>/package.json` 看该目录（如 `client/`）是不是纯第三方依赖、没有本地 workspace 包（`@nw/shared` 等）——没有的话直接 PowerShell `New-Item -ItemType Junction` 整个 `node_modules` 指到主目录同名目录即可，内容不随分支变化，省下一次完整安装。`server/` 之类含 `@nw/*` 的目录仍按下面陷阱说明单独处理。
- **⚠️ 陷阱（2026-07-05 实测踩过）：图快用 Junction/符号链接整个 `node_modules` 目录会让 `@nw/*`（npm workspaces 本地包）解析回主仓库**。`server/node_modules/@nw/shared` 等条目本身就是指向主仓库 `server/shared` 的符号链接；如果为了省 `npm install` 直接把整个 `server/node_modules` 挂成 junction 指到主仓库，worktree 里 `import '@nw/shared'` 实际读到的是**主仓库未重建的 `dist/`**，跟 worktree 里改的 `.ts` 源码毫无关系——测试照样"全绿"，因为断言大多是符号引用（`SLG_MAP_W` 等），值对不对都能过，等于验证了个寂寞。正确做法：只把第三方依赖整体挂 junction（内容不随会话变化，挂哪份都一样），`@nw/*` 这几个 workspace 本地包必须单独用 `New-Item -ItemType Junction`（PowerShell；Git Bash 的 `ln -s` 对目录在无权限时会静默退化成一次性拷贝，不会跟着源码实时变，肉眼看不出区别）指向 worktree 自己的 `server/<pkg>`，且改完 `.ts` 后要 `npm run build` 生成新 `dist/`（多数包靠 `main`/`types` 指向编译产物解析，改源码不够）。验证方法：`node -e "console.log(require.resolve('@nw/shared'))"` 看落地路径，或直接 `echo probe > 目标目录/PROBE.txt` 测试链接是否实时生效。
- **⚠️ 共享主目录里 `git add`+`git commit` 分两步会被邻会话的提交卷入（2026-08-08 实测踩过）**：在主目录（非独立 worktree）里改小改动时，若先 `git add <自己的文件>` 暂存、隔了几步再 `git commit`，中间这段间隙里另一个并发会话如果也在主目录跑了 `git commit`（不带 `-a`、不带 pathspec），它提交的是**当时索引的全部内容**——包括你已暂存但还没提交的文件。结果：你的改动被悄悄塞进了别人的提交（commit message 完全不提你的改动），`git log --oneline -- <你的文件>` 能看到内容确实进了历史、diff 也完整，只是挂在一条语义不相关的 commit 上。发现方式：`git commit` 报"no changes added to commit"却之前明明 `git add` 过；`git status --short` 突然清空。**处理**：内容没丢就不用回滚/rebase 补救（历史改写在共享分支上风险更大，多个会话都可能已经基于它继续），确认 `git show --stat <那个意外提交>` 里含有你的文件+diff 正确即可，实质是提交信息属性不准，不是数据丢失。**规避**：`git add` 和 `git commit` 尽量在同一次 Bash 调用里连着执行（`git add <files> && git commit -m ...`），缩短两步之间的窗口；改动多、耗时长的任务仍然优先走独立 worktree，而不是主目录当日分支。
- **⚠️ 陷阱（2026-08-08 实测踩过）：worktree 里起的 dev server 忘了停，`git worktree remove` 后目录删不掉、越攒越多**：`git worktree remove` 只是解除 git 对该目录的挂靠（更新 `.git/worktrees/` 记录），完全不检查、也不会杀掉目录里正在跑的进程。如果收尾时忘了停掉在该 worktree 里起的 `webpack serve`（或其它 dev server），进程会一直占着端口、持有目录内文件的句柄——事后 `rm -rf`/`Remove-Item -Recurse -Force` 会报 `Device or resource busy` / `Cannot remove the item ... because it is in use`，目录残留在磁盘上；由于 git 层面已经不认识这个目录了（`git worktree list` 里不出现、`.git/worktrees/` 下也没有对应记录），残留目录会被长期忽略，堆到几十个、几百 MB 都不会被 `git worktree prune` 之类命令发现或清理。**排查**：PowerShell `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CommandLine`，看 `CommandLine` 里是否包含该 worktree 的路径（如 `...\.claude\worktrees\<slug>\client\node_modules\...\webpack.js`），找到就是它。**修法**：`Stop-Process -Id <pid> -Force` 杀掉后目录才能正常删除。**规避**：结束任务流程第④步删 worktree 之前，先确认自己在该 worktree 里起过的所有 dev server（游戏/tools 各端口）都已经停掉——不要假设 `git worktree remove` 会连带清理进程；批量体检时可以 `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match '\.claude\\\\worktrees'` 一次性扫出所有残留进程。**变体（同日晚些时候实测）：锁目录的不一定是 node 进程**——清理另一个已结束会话遗留的 worktree 时，`node.exe` 进程列表是空的，真正占着目录 cwd 的是 Claude 客户端自己给那次会话开的一个 headless conhost（`conhost.exe --headless ...`，父进程是共享的 `claude.exe`）。这类 conhost 在 `CommandLine` 里不会出现任何 worktree 路径字样，只能靠**创建时间和该目录的 mtime 相近**来对应；`claude.exe` 本体是所有会话共享的基础设施，绝对不能杀，只能精确杀掉那一个具体的 conhost PID（`Stop-Process -Id <该 conhost 的 PID> -Force`）。杀错/杀共享父进程会连累其它正在跑的会话。如果一时找不到对应的 conhost（同一时段可能有十几个同构的 headless conhost，仅凭时间戳也分不清），且目录内容已经能清空、只剩一个空文件夹本身删不掉，这种情况可以直接放着——空文件夹本身不占实质资源，通常等对应会话的残留句柄自然释放后就能删掉，不值得为了一个空目录去逐个尝试杀掉候选进程。
- **补充技巧（2026-08-08 实测）：锁目录的也可能是自己起的 `npm install`（尤其 `server/` 装 `mongodb-memory-server-core` 那种带 postinstall 下载步骤的包），而且用 harness 的 `TaskStop` 停掉追踪中的 Bash 包装进程，不保证子进程（`npm install` → `postinstall.js`）真的同步退出**——`TaskStop` 后 harness 侧确认任务已不存在，但 `Get-CimInstance Win32_Process` 里对应的 `node.exe`（`npm-cli.js install` / `postinstall.js`）可能还挂着一段时间，此时贸然 `Stop-Process` 有误杀"其实是另一个并发会话自己的 `npm install`"的风险（多个 worktree 各自装 `server/` 依赖时，`CommandLine` 长得一模一样，Win32 API 也拿不到进程的当前工作目录，无法反查到底是哪个 worktree 的）。找不到能安全下手的 PID 时，**别在整个目录上死磕 `Remove-Item -Recurse`，改成逐层收窄**：`Get-ChildItem $root -Force | % { try { Remove-Item $_.FullName -Recurse -Force } catch { "kept: $($_.Name)" } }`，先删掉顶层能删的（`client`/`tools`/`wrangler`/`design`/`art`…），剩下 `server/`；再对 `server/` 下同样跑一遍，剩下 `node_modules/`；再对 `node_modules/` 下每个包目录跑一遍——最终能把残留体积从几十 MB 收窄到只剩一个真正被锁住的**空**子目录（如 `server/node_modules/mongodb-memory-server`）。这时就落回上面 07-25 那条陷阱结尾的结论：空文件夹本身不占实质资源，不值得为了它去猜/杀候选进程，放着等句柄自然释放即可——但先做这轮收窄，能把"放着不管"的代价从几十 MB 降到几十 KB，性价比远高于直接放弃整个目录。
- **⚠️⚠️ 更狠的陷阱（2026-07-25 实测踩过，会连累主目录）：上面这条"补救"手法本身有个隐藏前提——只有当 `server/node_modules` 是**真实目录**（`npm install` 装出来的）时，事后单独重挂 `@nw/*` 才是安全的。如果图快先把整个 `server/node_modules` 当一个单位 junction 到主仓库（如上一条陷阱描述的反面操作），那 worktree 里的 `server/node_modules` 跟主仓库的 `server/node_modules` 其实是**同一个物理目录**，只是路径不同——这时候在 worktree 里 `rmdir` + 重新 `New-Item -ItemType Junction` 单独修 `@nw/shared`/`@nw/engine`/`@nw/metaserver`/`@nw/commercial` 这几个条目，改的是那个唯一的物理目录，**主仓库那边看到的也是改过的结果**。任务做完 `git worktree remove` 把 worktree 删掉后，主仓库的 `server/node_modules/@nw/*` 就变成指向一个已经不存在的路径的悬空链接——`@nw/shared` 等包在主仓库（以及当时所有其它会话）里直接解析失败，`tsc`/测试全灭，而且现象是"主目录莫名其妙坏了"，不会直接联想到某个已经收尾、已经删除的 worktree。**正确顺序**：`server/node_modules` 只要含 `@nw/*` 就不要整体 junction 到主仓库——**直接在 worktree 里 `cd server && npm install` 走真实、独立的安装**（npm workspaces 会自动把 `@nw/*` 正确 symlink 到 worktree 自己的包目录），几十秒到一分钟，比排查"主仓库为什么坏了"便宜得多。`client/` 这类没有 `@nw/*` 依赖的目录，整体 junction 到主仓库仍然安全（单向只读引用，事后不会再修改这几个条目）。收尾前建议顺手 `git worktree list` 确认待删的路径只在自己这条线里出现，删除后 `node -e "console.log(require.resolve('@nw/shared'))"` 在主目录复测一次确认没被连累。
- **⚠️ 派给子 agent 的任务如果自己跑了 `git checkout <path>` 来"撤销手滑改的文件"，会连带清空同一个文件上你自己还没提交的改动（2026-08-09 实测踩过）**：主目录里同时有"我"在改设计文档、又派了一个子 agent 去改测试文件。子agent 误改了它任务范围之外的 `design/DECISIONS.md`/`design/game/SLG_DESIGN.md`（大概是顺手做了不该做的文档同步），发现后自己跑了 `git checkout -- design/DECISIONS.md design/game/SLG_DESIGN.md` 想撤销——但 `git checkout <path>` 撤的是**该路径在工作区里的全部未提交改动**，不区分"哪几行是子agent 刚加的、哪几行是我更早加的还没提交的"，于是把我自己那部分也一起冲掉了，且没有任何报错或提示——直到我后续 `git status --short -- design/` 发现该路径完全没有 diff 才察觉。**处理**：好在改动内容还留在这轮会话的上下文里，重新 Edit 一遍即可，没有真正丢失（只是多花一轮）。**规避**：①派子agent 任务时如果涉及可能touch 到"我这轮也在改的文件"，在任务描述里明确列出"仅改 X/Y/Z 路径，其它路径一律不要动，哪怕看到过时的表述"；②子agent（或自己）想撤销一处误改时，优先用 `git diff`/编辑器手动删掉那几行，而不是对整个文件 `git checkout`——后者的撤销粒度是"整个文件相对 HEAD"，在共享检出里几乎总是比你想要的粒度粗；③改完关键文档后，紧跟着就 `git add`+`git commit`（同一次调用），别让它以"未提交"状态在工作区里存活太久，存活时间越长，被另一个并发操作（无论是别的会话，还是自己派的子agent）连带清空的窗口就越大。
