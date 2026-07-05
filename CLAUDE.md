# funny — Notebook Wars

浏览器 + 微信小游戏的回合制策略游戏，配套工具链。

## 目录结构（快查）

```
client/          主游戏（TS + PixiJS，port 9090）
tools/           animator(9091) / level-editor(9092) / ops(9093) / vfx-editor(9094) / map-editor(9095)
server/          9 个 Node 服务 + engine/contracts/shared 包（npm workspaces）
  contracts/     openapi.yml + openapi-world.yml + *.proto
  shared/        @nw/shared
  metaserver/    REST 请求面
  gateway/       WS 控制面（/gw）
  matchsvc/      匹配大脑（不连库）
  gameserver/    WS 数据面（?ticket=，不连库）
  commercial/    钱包/交易
  admin/         运维后台后端
  worldsvc/      SLG（/world /auction）
  socialsvc/     社交（/social/*）
  analyticsvc/   埋点（18085）
art/             概念图
design/          所有设计文档（game/tools/product）
claudedocs/      模块级快查文档（按需加载）
```

## 文档索引

| 模块 | 快查 | 设计 |
|---|---|---|
| 游戏主代码 | [`claudedocs/client-modules.md`](claudedocs/client-modules.md) | `design/game/` |
| 服务端 | [`claudedocs/server.md`](claudedocs/server.md) | `design/game/META_DESIGN.md` |
| animator | [`claudedocs/animator.md`](claudedocs/animator.md) | `design/tools/animator/` |
| level-editor | — | `design/tools/level-editor/DESIGN.md` |
| map-editor | — | `design/tools/map-editor/DESIGN.md` |
| vfx-editor | — | `design/tools/vfx-editor/DESIGN.md` |
| 文件格式 | [`claudedocs/file-formats.md`](claudedocs/file-formats.md) | — |

> 设计文档入口：[`design/README.md`](design/README.md)；关键拍板：[`design/DECISIONS.md`](design/DECISIONS.md)；实现进度：`design/game/META_TASKS.md`；数值权威：`server/engine/src/config.ts`

## 会话规则

- **worktree**：所有任务在独立 worktree + 独立分支；微小文档订正可直接提 main。约定见 [`claudedocs/worktrees.md`](claudedocs/worktrees.md)。
- **工作目录**：`C:\Users\TaoWang\Documents\funny`，用 Bash 工具，不要绕道 `wsl -d ubuntu`。
- **权限**：所有命令直接执行，无需确认。
- **验证**：`tsc --noEmit` + webpack 构建，不要启动游戏截图。
- **记录改动**：先更新 `design/` 对应文档，再提交代码。
- **上下文**：会话接近 200k token 时提醒切换。
