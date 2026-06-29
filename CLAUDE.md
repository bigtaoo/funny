# funny — Notebook Wars

## 项目概况

浏览器 + 微信小游戏的回合制策略游戏，配套骨骼动画编辑器。

## 目录结构

```
funny/
├── client/          主游戏（TypeScript + PixiJS）
│   ├── src/
│   │   ├── game/          游戏逻辑（纯 TS，无 PIXI 依赖）
│   │   ├── render/        渲染层（PixiJS）
│   │   ├── layout/        响应式布局
│   │   ├── scenes/        场景管理
│   │   └── entries/       多平台入口（web / wechat / crazygames）
│   └── webpack.config.js
│
├── tools/
│   ├── animator/          骨骼动画编辑器（TypeScript + PixiJS，端口 9091）
│   ├── level-editor/      战役关卡编辑器（TypeScript + 纯 Canvas，端口 9092）
│   ├── ops/               运维后台前端（TypeScript，端口 9093）
│   └── vfx-editor/        战斗特效编辑器（TypeScript + PixiJS，端口 9094）
│
├── server/                Node.js 后端（npm workspaces，9 个应用进程 + engine/contracts/shared 包）
│   ├── contracts/         openapi.yml + openapi-world.yml + transport.proto + game.proto + replay.proto
│   ├── shared/            @nw/shared（类型/JWT/ticket/Mongo/ladder/economy）
│   ├── metaserver/        REST，无状态（auth/save/economy/pve/match-report）
│   ├── gateway/           控制面 WS（/gw，account→socket，房间/匹配中转）
│   ├── matchsvc/          私有匹配大脑（房间/ELO配对/game注册，不连库）
│   ├── gameserver/        数据面 WS（?ticket= 握手，锁步中继，永不连库）
│   ├── commercial/        钱包/交易（玩家不可达）
│   ├── admin/             运维后台后端（玩家不可达）
│   ├── worldsvc/          SLG 大世界（公网 REST 第四面，/world /auction）
│   ├── socialsvc/         社交（公网 REST 第五面，/social/*；家族/好友/邮件/频道/push路由）
│   └── analyticsvc/       埋点分析（端口 18085）
│
├── art/                   地图/角色概念图
├── design/                所有设计文档（game / tools / product）
└── claudedocs/            模块级快查文档（按需加载）
```

> **文档约定**：**设计文档统一入口 = [`design/README.md`](design/README.md)**（索引 / 权威来源登记 / 文档规约）；关键拍板见 [`design/DECISIONS.md`](design/DECISIONS.md)；战斗数值以 `server/engine/src/config.ts`（`@nw/engine`）为准、快照见 `design/game/BALANCE.md`；实现进度见 `design/game/META_TASKS.md`；模块细节见 `claudedocs/`。

## 各模块入口

| 模块 | 快查文档 | 设计文档 |
|---|---|---|
| 动画编辑器（animator） | [`claudedocs/animator.md`](claudedocs/animator.md) | `design/tools/animator/` |
| 关卡编辑器（level-editor） | — | `design/tools/level-editor/DESIGN.md` |
| 特效编辑器（vfx-editor） | — | `design/tools/vfx-editor/DESIGN.md` |
| 游戏主代码（client） | [`claudedocs/client-modules.md`](claudedocs/client-modules.md) | `design/game/` |
| 服务端（server，9 个应用进程） | [`claudedocs/server.md`](claudedocs/server.md) | `design/game/META_DESIGN.md` |
| 文件格式（.tao / .tao.editor） | [`claudedocs/file-formats.md`](claudedocs/file-formats.md) | — |

### 关卡编辑器补充

```bash
cd tools/level-editor && npm run start   # 端口 9092
```

数据单一来源：直接 import 游戏侧 `LevelDefinition` / `parseLevelDefinition` / 棋盘常量（webpack `@game` alias）；关卡 JSON 存 `client/src/game/campaign/levels/*.json`。

### 特效编辑器补充

```bash
cd tools/vfx-editor && npm install && npm run start   # 端口 9094
```

数据单一来源：解释器/类型/采样/校验直接 import 游戏侧 `client/src/render/vfx/`（webpack alias `@vfx`，prng 经 `@nw/engine`）；特效 JSON 存 `client/src/effects/*.json`，编辑器导出后**手动放入**该目录再构建（DESIGN §8 回写流程）。

### 美术资产分工

详见 `design/product/art-direction.md`：程序绘制（SketchPen）负责棋盘/网格/UI——`client/src/render/sketch.ts`；AI 图（位图）负责角色/兵种——`art/units/*`，animator 绑骨做动画。

## 并行开发计划

**计划文档**：[`design/game/PARALLEL_DEV_PLAN.md`](design/game/PARALLEL_DEV_PLAN.md)

三条并行轨道，每条在独立 worktree 内进行：

| 轨道 | 主题 | worktree 路径 |
|---|---|---|
| **Track A** | 引擎重做 + 深度养成（S12/装备/体力/Anna） | `../funny-track-a` / branch `track-a` |
| **Track B** | 元系统留存（成就/赛季/称号/战令/日常/活动） | `../funny-track-b` / branch `track-b` |
| **Track C** | 商业合规 + 验收加固（IAP/合规/反作弊/联调） | `../funny-track-c` / branch `track-c` |

**触发约定**：
- 收到「继续 Track A / B / C」或「并行开发 Track X」时，**先读 `PARALLEL_DEV_PLAN.md`**，找到对应轨道内第一个未完成的任务（按文档顺序，A1→A2→… 依此类推），直接开始实现，无需再问。
- 每个任务完成后，在 `PARALLEL_DEV_PLAN.md` 对应任务标题前加 `✅ ` 标记，然后自动推进到下一个任务（会话 token 允许时）。
- 任务结束工作流同常规：记录文档 → 提交 → 合并 main → 删 worktree。

## 会话说明

- **⚠️ 必须在自己的 worktree 下开展任务，不要直接在 main 分支操作**：开始任务前先用 `git worktree` 建立独立工作目录 + 独立分支，所有改动在 worktree 内完成；约定见 `claudedocs/worktrees.md`。任务结束自行合并回 main 并清理 worktree，无需维护全局索引。仅有微小的文档订正可在主目录直接提交。
- **工作目录**：`C:\Users\TaoWang\Documents\funny`，Bash 命令直接执行，**不要**绕道 `wsl -d ubuntu`。
- **权限**：所有命令（包括 `rm` / `rmdir` / `git rm`）直接执行，**无需向用户确认**。
- **验证方式**：代码改动后只做 TypeScript 编译检查（`tsc --noEmit`）和 webpack 构建验证，**不要**启动游戏截图验证。
- **上下文提醒**：会话接近 200k token 上限时提醒切换新会话。
- **记录改动**：收到"记录改动"指令时，更新改动所在模块的对应设计文档（`design/` 下相应文件），**不再**往 CLAUDE.md 写已知修复表格。
