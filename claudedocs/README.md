# claudedocs — 模块级快查文档索引

> 按需加载。`CLAUDE.md` 只放**会话规则**，这里放**查表内容**：仓库地图 + 各模块快查文档 + 设计文档入口。

## 目录结构

```
client/          主游戏（TS + PixiJS，port 9090）
tools/           animator(9091) / level-editor(9092) / ops(9093) / vfx-editor(9094) / map-editor(9095)
                 audio-pipeline/（Python，无端口：音频素材的抓取 → 审计 → 转换 → 峰值对齐）
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
claudedocs/      模块级快查文档（本目录）
```

## 文档索引

| 模块 | 快查 | 设计 |
|---|---|---|
| 游戏主代码 | [`client-modules.md`](client-modules.md) | `design/game/` |
| 客户端测试 | [`client-testing.md`](client-testing.md) | — |
| 客户端内存/生命周期 | [`client-memory-leak.md`](client-memory-leak.md) | — |
| 服务端 | [`server.md`](server.md) | `design/game/META_DESIGN.md` |
| botsvc | — | `design/game/BOTSVC_DESIGN.md` |
| 工具链测试/覆盖率 | [`tools-testing.md`](tools-testing.md) | — |
| animator | [`animator.md`](animator.md) | `design/tools/animator/` |
| level-editor | — | `design/tools/level-editor/DESIGN.md` |
| map-editor | — | `design/tools/map-editor/DESIGN.md` |
| vfx-editor | — | `design/tools/vfx-editor/DESIGN.md` |
| desktop-shell | — | `design/tools/desktop-shell/DESIGN.md` |
| 文件格式 | [`file-formats.md`](file-formats.md) | — |
| 并行开发（worktree） | [`worktrees.md`](worktrees.md) | — |
| 音频素材管线 | [`../tools/audio-pipeline/README.md`](../tools/audio-pipeline/README.md) | `design/game/AUDIO_DESIGN.md` §0.4 / §7 |

## 权威来源

- 设计文档入口：[`../design/README.md`](../design/README.md)
- 关键拍板：`design/DECISIONS.md`（ADR-070 起在 `design/DECISIONS_ADR-070-onward.md`）
- 实现进度：`design/game/META_TASKS.md`
- **数值权威**：`server/engine/src/config.ts`（文档里的数字都以它为准）
