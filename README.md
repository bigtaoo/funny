# Notebook Wars

一款**手绘风格回合制策略游戏**，支持浏览器与微信小游戏双端，配套骨骼动画编辑器与关卡编辑器。

---

## 游戏玩法

双方各持一个基地，通过打出手牌派遣士兵、建造建筑，争夺对方基地的血量。

- **手牌系统**：6 张手牌自动轮换（30 秒未使用自动刷新），消耗金币打出
- **兵种**：普通兵 Infantry（群体、廉价）、盾兵 ShieldBearer（高血量、缓慢）、弓箭兵 Archer（远程）
- **建筑**：兵营（持续生产单位）、箭塔（全向攻击范围内所有敌人）
- **法术**：急速冲锋（加速己方单位）、陨石打击（2×2 范围秒杀）
- **基地升级**：消耗金币提升金币回速，最多升级 3 次
- **时间加速**：随对局时长金币回速逐步加快（3/6/10 分钟三档），13 分钟后全军攻击力翻倍，17 分钟强制平局

### 战场规则

```
Row 17 ── 敌方建筑行
Row 16 ── 敌方出兵行
  …         战斗区（14 行）
Row  1 ── 己方出兵行
Row  0 ── 己方建筑行（含基地，占中央 2 列）
```

单位沿各自列纵向推进，到达敌方建筑行后横向穿越，抵达基地列造成伤害。

---

## 技术范围

### 主游戏（`client/`）

| 层 | 技术 |
|---|---|
| 渲染 | PixiJS Legacy（兼容微信小游戏 WebGL） |
| 游戏逻辑 | 纯 TypeScript，定点数运算，与渲染完全解耦 |
| 随机性 | LCG 确定性 PRNG，游戏逻辑内禁用 `Math.random()` |
| 平台 | Web / 微信小游戏 / CrazyGames，多入口 Webpack 构建 |
| 输入 | 手动 hit-test，无 PIXI interactive，支持触屏拖拽打牌 |

**核心系统：**

- `MovementSystem`：定点数推进，友军半径碰撞，横穿逻辑
- `CombatSystem`：单位 & 箭塔攻击，箭塔全向 Chebyshev 范围寻敌
- `BuildingProductionSystem`：兵营定时生产
- `ResourceSystem`：多档加速金币回速
- `AISystem`：对手 AI，威胁驱动决策（防守 / 经济 / 升级规划，难度分级），确定性 PRNG
- `SpellSystem`：法术效果处理

### 服务端（`server/`）— 九进程

| 进程 | 职责 |
|---|---|
| `metaserver` | REST 无状态：账号/存档/经济/社交/PvE/战报 |
| `gateway` | 控制面 WS：房间/匹配中转，account→socket 映射 |
| `matchsvc` | 私有匹配大脑：ELO 配对/房间/game 注册，不连库 |
| `gameserver` | 数据面 WS：瘦锁步中继，ticket 验签，永不连库 |
| `commercial` | 钱包/充值/盲盒 RNG，玩家不可达 |
| `worldsvc` | SLG 大世界：领地/宗门/拍卖行（Redis + Mongo） |
| `admin` | 运维后台后端：监控/补偿审批/数据分析 |
| `analyticsvc` | 埋点采集，玩家不可达 |

Mongo 单节点副本集（事务 + change streams）；Redis 供 worldsvc 行军调度和宗门频道扇出。

### 工具（`tools/`）

| 工具 | 说明 |
|---|---|
| `animator/` | 骨骼动画编辑器（11 根固定骨骼 FK，关键帧时间轴，导出 `.tao`） |
| `level-editor/` | 战役关卡编辑器（纯 Canvas，直接引用游戏侧 `LevelDefinition`） |
| `ops/` | 运维后台前端（监控面板 / 匹配池 / 补偿工单） |

---

## 快速启动

### 方式一：Docker 一键全栈（推荐，模拟真实发布）

需要 Docker Desktop。一条命令重建最新代码并拉起**全部 9 个服务端进程 + 主客户端 + 3 个工具 + MongoDB + Redis**：

```powershell
./local-up.ps1            # 重建并启动；浏览器打开 http://localhost:8088
./local-up.ps1 -Fresh     # 顺带清空数据库后再起
./local-up.ps1 -Port 9000 # 换主游戏入口端口（客户端地址构建期烘焙，须 --build 重建）
./local-down.ps1          # 停止（保留数据）；-Fresh 连数据一起清
```

> 每次 `up` 都会 `--build`，即从当前代码重新构建镜像——改完代码重跑即可生效。
> 容器从镜像快照跑，编辑本地代码不影响运行中的容器，直到下次重跑（重建）。

**前端地址**（启动后浏览器直接打开）：

| 地址 | 说明 |
|---|---|
| http://localhost:8088 | **主游戏**——nginx 同源托管 SPA，并反代 `/api`(REST) `/gw`(控制面 WS) `/ws`(对战数据面 WS) `/world` `/family` `/auction`(SLG 大世界) `/analytics`(埋点) |
| http://localhost:9091 | **动画编辑器** animator |
| http://localhost:9092 | **关卡编辑器** level-editor |
| http://localhost:9093 | **运维后台** ops（跨源调 admin 后端 http://localhost:18083，种子账号 `admin` / `admin123`） |

**服务端九进程**（均跑同一镜像 `nw-server:local`，由 `command` 选进程）：
`metaserver`(REST) · `commercial`(钱包) · `gateway`(控制面 WS) · `matchsvc`(匹配) · `gameserver`(对战数据面 WS) · `worldsvc`(SLG 第四公网面) · `admin`(运维) · `analyticsvc`(埋点)。
对玩家暴露的入口只有主游戏 `:8088`（同源），其余服务经 nginx 反代或仅内网可达。

编排见 [`docker/docker-compose.local.yml`](docker/docker-compose.local.yml)。

### 方式二：仅起本地依赖（dev server 热更）

```bash
# 起 Mongo + Redis（服务端开发依赖）
docker compose -f docker/docker-compose.dev.yml up -d

# 各前端 dev server
cd client && npm install && npm run start          # 主游戏，端口 19090
cd tools/animator && npm install && npm run start  # 动画编辑器，端口 9091
cd tools/level-editor && npm install && npm run start  # 关卡编辑器，端口 9092
cd tools/ops && npm install && npm run start        # 运维后台，端口 9093
```

dev server 默认连本地裸跑的后端（见 `client/webpack.config.js` 注入的默认地址）；要联调完整后端，仍推荐方式一。

---

## 目录结构

```
funny/
├── client/        主游戏（TypeScript + PixiJS）
├── tools/
│   ├── animator/      骨骼动画编辑器（TypeScript + PixiJS）
│   ├── level-editor/  战役关卡编辑器（TypeScript + 纯 Canvas）
│   └── ops/           运维后台前端（TypeScript）
├── server/        Node.js 后端（npm workspaces，九进程）
├── docker/        Docker 编排文件
│   ├── docker-compose.local.yml     本地全栈模拟（9 进程 + 4 前端 + Mongo + Redis）
│   ├── docker-compose.prod.yml      生产（预构建镜像，无工具前端）
│   ├── docker-compose.server-prod.yml  服务端生产（含 Caddy 反代，自构建）
│   ├── docker-compose.dev.yml       本地开发依赖（Mongo + Redis）
│   └── docker-compose.ci.yml        CI E2E 叠加层（与 server-prod 合并使用）
├── art/           地图 & 角色概念图
├── design/        产品 & 美术设计文档
└── claudedocs/    模块级快查文档
```
