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
│   └── ops/               运维后台前端（TypeScript，端口 9093）
│
├── server/                Node.js 后端（npm workspaces，九进程）
│   ├── contracts/         openapi.yml + transport.proto + game.proto
│   ├── shared/            @nw/shared（类型/JWT/ticket/Mongo/ladder/economy）
│   ├── metaserver/        REST，无状态（auth/save/economy/social/pve/match-report）
│   ├── gateway/           控制面 WS（/gw，account→socket，房间/匹配中转）
│   ├── matchsvc/          私有匹配大脑（房间/ELO配对/game注册，不连库）
│   ├── gameserver/        数据面 WS（?ticket= 握手，锁步中继，永不连库）
│   ├── commercial/        钱包/交易（玩家不可达）
│   ├── admin/             运维后台后端（玩家不可达）
│   ├── worldsvc/          SLG 大世界（公网 REST 第四面，/world /family /auction）
│   └── analyticsvc/       埋点分析（端口 18085）
│
├── art/                   地图/角色概念图
└── design/                所有设计文档（game / tools / product）
```

> **文档约定**：所有设计文档统一放 `design/` 下，按模块分子目录（`game` / `tools` / `product`）。`CLAUDE.md`、`README.md` 保留在仓库根。实现进度详见 `design/game/META_TASKS.md`。

## 动画编辑器（tools/animator）

| 想查的内容 | 文件 | 章节 |
|---|---|---|
| 典型工作流 / 功能规格 / UI 布局 / 导出格式 | `design/tools/animator/REQUIREMENTS.md` | §2 §3 §8 |
| 目录结构 / 数据模型 / 渲染流程 / 事件总线 | `design/tools/animator/ARCHITECTURE.md` | §1 §2 §5 §3 |

```bash
cd tools/animator && npm run start   # 端口 9091
```

### 参数两层模型

**Binding（静态，所有帧共用）**：`anchorX/Y`（图片挂点比例，允许超出 0–1）、`rotation`（静态旋转偏移）、`scaleX/Y`（静态缩放）、`flipX`、`zOrder`

**Keyframe（动态，逐帧）**：`rotation`（delta）、`translateX/Y`、`scaleX/Y`、`alpha`

渲染公式：`sprite.rotation = bone_FK_angle + binding.rotation`（bone_FK_angle 已含 keyframe.rotation，不可重复叠加）

### 架构要点

- **11 根固定骨骼**：root → spine → head / 4 臂 / 4 腿
- **FK**：`Skeleton.computeFK(rootX, rootY, transforms, lengthScales?)` 纯函数；交互控制器 hit-test 须传 `state.boneLengthScales`
- **关键帧插值**：`sampleClip(clip, t)` 无外部依赖，可复制到游戏引擎
- **导出格式**：`.tao`（JSZip + spritesheet.png + animation.json v2）；`.tao.editor`（保留原始图 + 编辑状态）
- **骨骼长度**：`AppState.boneLengthScales`（稀疏 Map）序列化进两种格式
- **编辑器模式**：`'skin'`（静息姿调 Binding）/ `'animate'`（关键帧编辑）；快捷键 `S`
- **静息姿约定**：角色朝右，`r_`（解剖右）= 屏幕左，`l_`（解剖左）= 屏幕右

### 快捷键

| 键 | 动作 |
|---|---|
| `Space` | 播放 / 暂停 |
| `K` | 打关键帧 |
| `Delete`/`Backspace` | 删选中关键帧 |
| `Tab` | 切换 Skeleton / Sprite 预览 |
| `S` | 切换 Skin / Animate 模式 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |

### 事件总线（核心事件）

`bone:select`、`bone:rotate`、`time:change`、`play:state`、`anim:select`、`anim:list`、`kf:change`、`images:change`、`binding:change`、`attachment:change`、`rig:change`、`preview:mode`、`editor:mode`、`history:change`、`status`、`pose:reset`

### 渲染层级（从下到上）

`gridGfx → onionGfx → boneGfx → spriteLayer → overlayGfx → selGfx`

### 典型工作流

```
1. npm run start → http://localhost:9091
2. [蒙皮] 导入骨骼图片 → 🎨 Skin 模式 → 调 Binding（anchor/rotation/scale）
3. [动画] 🎬 Animate 模式 → 拖骨骼 → K 打帧 → Space 预览
4. 💾 Save .editor（保留图片+状态）→ ⬇ Export .tao（游戏引擎读取）
```

### 主要源文件

| 文件 | 职责 |
|---|---|
| `src/App.ts` | 组合根，连接所有模块，主循环 |
| `src/rendering/Renderer.ts` | PixiJS 渲染（骨骼 + sprite + 挂点） |
| `src/skeleton/Skeleton.ts` | 骨骼定义 + FK 计算 |
| `src/animation/AnimationController.ts` | clip CRUD + 播放 + 关键帧操作 |
| `src/animation/interpolate.ts` | `sampleClip` 插值（无依赖，游戏侧共享） |
| `src/images/ImageController.ts` | 逐张 PNG 导入、Blob + PIXI.Texture 管理 |
| `src/io/IOController.ts` | `.tao` 导出 / 导入；`.tao.editor` 存档 |
| `src/timeline/TimelineView.ts` | Canvas 时间轴渲染 + 交互 |
| `src/interaction/InteractionController.ts` | 鼠标拖拽 + 键盘快捷键 |

## 关卡编辑器（tools/level-editor）

设计基准：`design/tools/level-editor/DESIGN.md`

```bash
cd tools/level-editor && npm run start   # 端口 9092
```

- **数据单一来源**：直接 import 游戏侧 `LevelDefinition` / `parseLevelDefinition` / 棋盘常量（webpack `@game` alias）
- **关卡为 JSON 单一来源**：`client/src/game/campaign/levels/*.json`，`parseLevelDefinition` 运行时校验
- **四区布局**：棋盘格 / 波次时间线（横=秒/纵=车道）/ 实时 JSON / 右栏 Inspector
- **源文件**：`src/state/EditorState.ts`、`src/board/BoardPanel.ts`、`src/timeline/TimelinePanel.ts`、`src/inspector/InspectorPanel.ts`

## 美术资产分工

详见 `design/product/art-direction.md`：
- **程序绘制（SketchPen）**：棋盘/网格/UI框/HUD/特效——`client/src/render/sketch.ts`
- **AI 图（位图资产）**：角色/兵种/有个性建筑/卡牌图——`art/units/*`，animator 绑骨做动画

## 游戏主代码（client/）

- **渲染**：`pixi.js-legacy`，兼容微信小游戏 WebGL
- **游戏逻辑**：纯 TS，固定点数（`game/math/fixed.ts`），与渲染解耦
- **平台适配**：Web / 微信小游戏 / CrazyGames，多入口 webpack 构建
- **骨骼动画 Runtime**：`StickmanRuntime`（`src/render/stickman/`），加载 `.tao` ZIP，驱动 PIXI Sprite
- **确定性约束**：游戏逻辑（`client/src/game/`）内严禁使用 `Math.random()`，必须使用 `Prng`（`game/math/prng.ts`）
- **多语言（i18n）**：`zh.ts` 为键唯一来源（`TranslationKey`），`en`/`de` 声明为 `Record<TranslationKey, string>` 漏翻报错。`t(key, params?)` 取词，支持 `{param}` 插值
- **网络协议 codegen**：`transport.proto`/`game.proto` → ts-proto via buf → `src/net/proto/`；`openapi.yml` → openapi-typescript → `src/net/openapi.ts`；改契约须重跑 `npm run proto:gen` / `npm run rest:gen`
- **统一输入管线（M13）**：`InputSource` 接口，`LocalInputSource`（单机）/ `NetInputSource`（联机锁步）/ `RecordingInputSource`（录制）/ `ReplayInputSource`（回放）

### 游戏核心模块

| 文件 | 职责 |
|---|---|
| `game/GameEngine.ts` | 主循环、系统编排、命令处理；每 tick 从 `InputSource` 消费指令 |
| `game/net/InputSource.ts` | 统一输入管线接口 + `LocalInputSource` |
| `game/net/ReplayInputSource.ts` | `RecordingInputSource`（捕获确认帧，`snapshot()→Replay`）+ `ReplayInputSource`（喂 Replay，永不停步） |
| `game/net/NetInputSource.ts` | 联机锁步：`submit`→opaque `cmd_submit`；`frame_batch`→解码→`take(frame)`；未确认返 `null` 停步 |
| `game/meta/ReplayStore.ts` | 本地录像：key `nw_replays_v1`，最近 12 局 ring |
| `game/GameState.ts` | 纯数据状态，持有 Board / Player / PRNG |
| `game/systems/AISystem.ts` | AI 决策（威胁驱动三段式；注入 Prng + 难度档） |
| `game/math/prng.ts` | LCG 确定性随机数生成器 |
| `game/math/fixed.ts` | 定点数运算（`TICK_RATE = 30`） |
| `i18n/index.ts` | `t()` 取词 + 插值；`initI18n`/`setLocale`/`onLocaleChange` |
| `game/meta/SaveData.ts` | 元系统单一权威根；`makeNewSave`/`SyncPatch`/`SAVE_VERSION` |
| `game/meta/migrate.ts` | `migrate(raw)→SaveData`：顺序升级 + fillDefaults；改字段必加迁移步 |
| `game/meta/SaveManager.ts` | 云同步：离线优先→bootstrap→防抖 push→409 reconcile；PvE 通关/升级走 `/pve/*` API |
| `net/ApiClient.ts` | metaserver REST 客户端（fetch + ApiResp 包络） |
| `net/NetClient.ts` | WS 连接/重连（退避+代次）/ts-proto 编解码 |
| `net/NetSession.ts` | 联机会话：gateway(控制面 `/gw`) + game(数据面 `?ticket=`) 双连接；跨场景存活 |
| `net/proto/{transport,game}.ts` | ts-proto 生成（勿手改） |
| `scenes/RoomScene.ts` | 好友房 UI：idle→codeEntry→connecting→inRoom |
| `render/sketch.ts` | `SketchPen`：确定性 Prng 抖动的手绘笔触 |
| `render/sketchUi.ts` | 共享手绘 UI 原语（纸底/手绘按钮/面板/色板单一来源） |

## 服务端（server/）

设计基准：`design/game/`（`META_DESIGN.md` / `SERVER_API.md` / `META_TASKS.md` / `ECONOMY_BALANCE.md`）。

### 架构关键约束

- **M12**：metaserver/gateway/gameserver 严禁 import `client/src/game`；`PlayerCommand` 作 `bytes` opaque 转发不解码
- **M16**：gameserver 永不连库，身份来自 ticket
- **乐观锁**：存档/钱包 `findOneAndUpdate({_id, rev})` 守卫；rev 不匹配返回 409
- **三通道**：玩家只触达 `meta`(REST) + `gateway`(WS `/gw?token=`) + `game`(WS `?ticket=`)
- **钱包权威**：`SaveData.wallet.coins` 是只读镜像；商业操作经 commercial → meta 编排 → 回推
- **PvE 服务器权威**：通关/升级走 `/pve/clear`、`/pve/upgrade` API；`SyncPatch` 只同步 `equipped`/`flags`

### 九进程 + 端口

| 进程 | 端口 | 说明 |
|---|---|---|
| metaserver | 18080 | REST，无状态，可横扩 |
| gateway | 8086 | 控制面 WS，account→socket |
| matchsvc | 8091 (internal) | 私有匹配大脑，不连库 |
| gameserver | 8081 | 数据面 WS，哑中继 |
| commercial | 18082 | 钱包/交易，玩家不可达 |
| admin | 18083 | 运维后台后端，玩家不可达 |
| worldsvc | 18084 | SLG 大世界，公网第四面 |
| analyticsvc | 18085 | 埋点分析，fire-and-forget |
| mongo | 27017 | 副本集（单节点） |

**Windows TCP 排除端口注意**：`netsh interface ipv4 show excludedportrange` 查看被 WinNAT/Hyper-V 保留的端口段，撞上换端口（8082/8083 曾被保留，现用 8086）。

### 启动（dev）

```powershell
cd server
docker compose up -d        # MongoDB 副本集（⚠ 须 Linux containers 模式：docker context use desktop-linux）
npm install
npm run dev:all             # 起全部进程（dev-up.ps1）
```

### 本地全栈模拟（含客户端）

```powershell
./local-up.ps1              # 构建最新代码 + docker compose，浏览器开 http://localhost:8088
./local-up.ps1 -Fresh       # 先清空 mongo 数据卷
./local-down.ps1            # 停（保留 DB）
```

nginx 反代：`/` SPA，`/api/` → metaserver:8080，`/gw` → gateway WS，`/ws` → gameserver WS。

### 部署（production）

```bash
cd server
cp .env.example .env        # 填 NW_JWT_SECRET / NW_DOMAIN
./deploy/up.sh              # docker compose -f docker-compose.prod.yml up -d --build
```

### SLG worldsvc 要点

- `shared/slg.ts`：`proceduralTile(world,x,y)` 确定性程序化地图（单一来源，client/server 共用）
- `auctions.expireAt` **故意非 TTL**——过期需结算退还托管物，用普通索引+扫描器
- Redis（`NW_WORLD_REDIS_URL`）：行军 ZSET 仅精确唤醒提示，处理不依赖；缺 Redis 静默降级
- **S8-3b（待办）**：围攻经 `/gw/judge` 引擎复算替代廉价线性结算

### social/admin/analytics 要点

- **好友/私聊/邮件（S6）**：meta 存数据，gateway 投递实时 push；发送走 REST，接收走 push
- **运维后台（S7）**：两层鉴权（admin JWT ≠ 玩家 JWT）；补偿一律走邮件（不直接写钱包）；审批人 ≠ 发起人
- **埋点（A9）**：`/analytics/events` fire-and-forget（`writeConcern:{w:0}`）；`analyticsvc/src/scheduler.ts` 每小时 ETL 漏斗

## 文件格式

### `.tao`（游戏引擎导出）

ZIP 内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing）+ `spritesheet.json`（boneId→rect）

```json
{
  "version": 2,
  "bindings": { "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6, "rotation": 0, "scaleX": 1, "scaleY": 1 } },
  "animations": { "walk": { "duration": 0.5, "loop": true, "keyframes": [...] } },
  "attachmentPoints": [{ "id": "shadow", "parentBone": "root", "offsetX": 0, "offsetY": 52 }],
  "boneLengthScales": { "spine": 1.4 }
}
```

`boneLengthScales` 稀疏对象，只记录非 1.0 的骨骼；缺省或缺键均视为 1.0。

### `.tao.editor`（编辑器存档）

ZIP 内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始 PNG，无损）

保存用 File System Access API（`showSaveFilePicker`），Firefox 退回 `<a download>`。

## 会话说明

- **工作目录**：`C:\Users\TaoWang\Documents\funny`，Bash 命令直接执行，**不要**绕道 `wsl -d ubuntu`。
- **权限**：所有命令（包括 `rm` / `rmdir` / `git rm`）直接执行，**无需向用户确认**。
- **验证方式**：代码改动后只做 TypeScript 编译检查（`tsc --noEmit`）和 webpack 构建验证，**不要**启动游戏截图验证。
- **上下文提醒**：会话接近 200k token 上限时提醒切换新会话。
- **记录改动**：收到"记录改动"指令时，更新改动所在模块的对应设计文档（`design/` 下相应文件），**不再**往 CLAUDE.md 写已知修复表格。
