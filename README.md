# Notebook Wars

一款**手绘风格回合制策略游戏**，支持浏览器与微信小游戏双端，配套独立的骨骼动画编辑器。

---

## 游戏玩法

双方各持一个基地，通过打出手牌派遣士兵、建造建筑，争夺对方基地的血量。

- **手牌系统**：6 张手牌自动轮换（30 秒未使用自动刷新），消耗墨水打出
- **兵种**：普通兵 Infantry（群体、廉价）、盾兵 ShieldBearer（高血量、缓慢）、弓箭兵 Archer（远程）
- **建筑**：兵营（持续生产单位）、箭塔（全向攻击范围内所有敌人）
- **法术**：急速冲锋（加速己方单位）、陨石打击（2×2 范围秒杀）
- **基地升级**：消耗墨水提升墨水回速，最多升级 3 次
- **时间加速**：随对局时长墨水回速逐步加快（3/6/10 分钟三档），13 分钟后全军攻击力翻倍，17 分钟强制平局

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

### 动画编辑器（`tools/animator/`）

独立运行的骨骼动画编辑工具，用于制作游戏角色动画。

- **11 根固定骨骼**，FK 正向运动学
- 关键帧时间轴，支持多 clip 管理
- Undo/Redo 命令模式（100 步）
- 导出 `.tao`（ZIP：spritesheet + animation.json）供游戏 Runtime 读取（`StickmanRuntime`，普通兵已接入）

```bash
cd tools/animator
npm run start   # 开发服务器，端口 9091
```

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
| http://localhost:8088 | **主游戏**——nginx 同源托管 SPA，并反代 `/api`(REST) `/gw`(控制面 WS) `/ws`(对战数据面 WS) `/world` `/auction`(SLG 大世界) `/social`(社交第五公网面，含家族) `/analytics`(埋点) |
| http://localhost:9091 | **动画编辑器** animator |
| http://localhost:9092 | **关卡编辑器** level-editor |
| http://localhost:9093 | **运维后台** ops（跨源调 admin 后端 http://localhost:18083，种子账号 `admin` / `admin123`） |

**服务端九进程**（均跑同一镜像 `nw-server:local`，由 `command` 选进程）：
`metaserver`(REST) · `commercial`(钱包) · `gateway`(控制面 WS) · `matchsvc`(匹配) · `gameserver`(对战数据面 WS) · `worldsvc`(SLG 第四公网面) · `socialsvc`(社交第五公网面) · `admin`(运维) · `analyticsvc`(埋点)。
对玩家暴露的入口只有主游戏 `:8088`（同源），其余服务经 nginx 反代或仅内网可达。

编排见 [`docker-compose.local.yml`](docker-compose.local.yml)。

### 方式二：单模块 dev server（改前端时热更最快）

```bash
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
│   ├── ops/           运维后台前端（TypeScript）
│   └── vfx-editor/    战斗特效编辑器（TypeScript + PixiJS）
├── server/        Node.js 后端（npm workspaces，九进程）
├── art/           地图 & 角色概念图
└── design/        产品 & 美术设计文档
```
