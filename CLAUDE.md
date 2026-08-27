# funny — Notebook Wars

浏览器 + 微信小游戏的回合制策略游戏，配套工具链。

## 目录结构（快查）

```
client/          主游戏（TS + PixiJS，port 9090）
tools/           animator(9091) / level-editor(9092) / ops(9093) / vfx-editor(9094) / map-editor(9095)
server/          11 个 Node 服务 + engine/contracts/shared 包（npm workspaces）
  contracts/     openapi.yml（ADR-040 起由 openapi/ 分域片段生成，勿直接编辑）
                 + openapi-world.yml + openapi-auction.yml + *.proto（game/replay/transport）
  shared/        @nw/shared
  metaserver/    REST 请求面
  gateway/       WS 控制面（/gw）
  matchsvc/      匹配大脑（不连库）
  gameserver/    WS 数据面（?ticket=，不连库）
  commercial/    钱包/交易
  admin/         运维后台后端
  worldsvc/      SLG（/world）
  socialsvc/     社交（/social/*）
  analyticsvc/   埋点（18085）
  auctionsvc/    拍卖行（/auction，独立库，18086）
  botsvc/        机器人玩家服务（内部管理面 18087）
art/             概念图
design/          所有设计文档（game/tools/product）
claudedocs/      模块级快查文档（按需加载）
```

## 文档索引

| 模块 | 快查 | 设计 |
|---|---|---|
| 游戏主代码 | [`claudedocs/client-modules.md`](claudedocs/client-modules.md) | `design/game/` |
| 客户端测试 | [`claudedocs/client-testing.md`](claudedocs/client-testing.md) | — |
| 客户端内存/生命周期 | [`claudedocs/client-memory-leak.md`](claudedocs/client-memory-leak.md) | — |
| 服务端 | [`claudedocs/server.md`](claudedocs/server.md) | `design/game/META_DESIGN.md` |
| botsvc | — | `design/game/BOTSVC_DESIGN.md` |
| 工具链测试/覆盖率 | [`claudedocs/tools-testing.md`](claudedocs/tools-testing.md) | — |
| animator | [`claudedocs/animator.md`](claudedocs/animator.md) | `design/tools/animator/` |
| level-editor | — | `design/tools/level-editor/DESIGN.md` |
| map-editor | — | `design/tools/map-editor/DESIGN.md` |
| vfx-editor | — | `design/tools/vfx-editor/DESIGN.md` |
| 文件格式 | [`claudedocs/file-formats.md`](claudedocs/file-formats.md) | — |

> 设计文档入口：[`design/README.md`](design/README.md)；关键拍板：[`design/DECISIONS.md`](design/DECISIONS.md)；实现进度：`design/game/META_TASKS.md`；数值权威：`server/engine/src/config.ts`

## 会话规则

- **⚠️ 会话语言（重点）**：与用户对话首选**中文**，其次**英语**，再次**德语**；**不要使用其他任何语言**。（注意区分：代码/注释/commit/PR 仍用英文，见 `MEMORY.md` 语言约定。）
- **worktree**：所有任务在独立 worktree + 独立分支；**禁止直接提交 `main`**，小改动（如文档订正）可直接在**当日分支**（`DD.MM.YYYY`）上进行。约定见 [`claudedocs/worktrees.md`](claudedocs/worktrees.md)。
- **工作目录**：仓库根目录（本机为 `D:\funny`）；用 Bash 工具，不要绕道 `wsl -d ubuntu`。
- **权限**：所有命令直接执行，无需确认。
- **验证**：`tsc --noEmit` + webpack 构建；涉及可见改动时，启动游戏（dev server）并截图核对效果。
- **看画面用哪个浏览器**：dev server 仍用 `preview_start`（它只是进程启动器）启，但**看和截图一律去用户本机的真实 Chrome**——`mcp__claude-in-chrome__*`：`list_connected_browsers` → `tabs_context_mcp{createIfEmpty:true}` → `navigate` 到 `localhost:<端口>` → `computer{screenshot}` / `zoom`；插件会把这些标签页收进它自己的 **Chrome 标签组**，**看完用 `tabs_close_mcp` 关掉**，别留着。**不要用 in-app Browser 面板**（`mcp__Claude_Browser__*` 的 `computer{screenshot}`）：它会另开一个 Firefox 式窗口要用户手动收拾，而且在本项目的 PIXI/WebGL 画布上截图历来直接超时。只有 `list_connected_browsers` 连不上 Chrome 时才退回面板，并在回复里说明。
- **记录改动**：先更新 `design/` 对应文档，再提交代码。
- **结束任务流程**（收尾前完整走一遍）：①更新 `design/` 相关文档 → ②更新记忆（`MEMORY.md` + 任务笔记）→ ③提交任务改动并合并进当日分支（`DD.MM.YYYY`，分支不存在则创建）→ ④先停掉该 worktree 里起的 dev server（否则目录会因进程占用删不掉、变孤儿残留，见 worktrees.md 陷阱），再删除任务分支 + worktree（先确认当前在 `.claude/worktrees/` 下，**绝不删主检出**）。合并后 `cat .claude/launch.json` 确认端口/路径没被指向已删的 worktree。共享检出（主目录）里只提交自己改的文件路径，别 `git add -A` 卷入其它会话的 WIP。若任务直接在主目录当日分支上做（无独立 worktree），③退化为一次普通提交、④不适用。竞态细节见 [`claudedocs/worktrees.md`](claudedocs/worktrees.md)。
- **上下文**：会话接近 200k token 时提醒切换。
