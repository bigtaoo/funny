# funny — Notebook Wars

浏览器 + 微信小游戏的回合制策略游戏，配套工具链。

**仓库地图、模块快查、设计文档入口全在 [`claudedocs/README.md`](claudedocs/README.md)。** 本文件只放会话规则。

## 语言

- **对用户说话**：中文。其次英语，再次德语；不用其他任何语言。
- **写进仓库的一切**：代码、注释、commit message、PR 标题与正文 —— **英文**。
- **文档**（`design/`、`claudedocs/`）—— 中文。

> `git commit` / `gh pr create|edit` 的命令里出现中文会被 `.claude/hooks/no-cjk-vcs.mjs` 硬拦。
> 被拦了就把那段话改成英文重跑，别绕过它。

## 看画面

1. dev server 用 `preview_start` 启动（它只是进程启动器）。
2. 看和截图走用户本机真实 Chrome：`mcp__claude-in-chrome__list_connected_browsers` → `tabs_context_mcp{createIfEmpty:true}` → `navigate` 到 `localhost:<端口>` → `computer{screenshot}` / `zoom`。
3. 看完用 `tabs_close_mcp` 把标签页关掉，别留给用户收拾。

`mcp__Claude_Browser__*` 除 `preview_*`（启/停/日志）外**全部在 `.claude/settings.json` 里 deny**——没有第二条看画面的路，不用找退路。

可见改动没真的看过，就不算完成。几何/尺寸类改动配合数值核对，别盲调。

## 分支与提交

- 每个任务一个独立 worktree + 独立分支；**禁止直接提交 `main`**。小改动（文档订正一类）可直接在当日分支 `DD.MM.YYYY` 上做。
- 共享检出（主目录）里只 `git add` 自己改的文件路径，**不要 `git add -A`**——会卷进其它会话的 WIP。
- 先更新 `design/` 对应文档，再提交代码。
- 约定与清理陷阱：[`claudedocs/worktrees.md`](claudedocs/worktrees.md)。

## 验证

`tsc --noEmit` + webpack 构建，两者都要过（**类型过了不等于构建过了**：资源走 `import`，缺文件只有 webpack 报）。

## 结束任务（收尾前完整走一遍）

1. 更新 `design/` 相关文档。
2. 更新记忆（`MEMORY.md` + 对应 `index/<分类>.md`）。
3. 提交，并把任务分支合进当日分支（`DD.MM.YYYY`，不存在则创建）。
4. 先停掉在该 worktree 里起过的**所有**进程（dev server、微信 DevTools），再删任务分支 + worktree；删之前确认路径在 `.claude/worktrees/` 下，**绝不删主检出**。合并后 `cat .claude/launch.json` 确认端口没指向已删目录。

直接在主目录当日分支做的任务：第 3 步退化成一次普通提交，第 4 步不适用。

## 其它

- 工作目录：仓库根（本机 `D:\funny`）；命令用 Bash 工具执行。
- 权限：所有命令直接执行，无需确认。
- 上下文接近 200k token 时提醒用户切换会话。
