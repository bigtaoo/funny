# 录像分享 — 游戏外分享设计基准

> 状态：**已实现**（2026-06-24 拍板 → 2026-06-24 实现）· 权威：本文（录像分享机制）· 依赖底座：S1-RP 录像录制/回放（见 `META_TASKS.md`）· 契约 → `server/contracts/openapi.yml`

> **实现落点速查**：状态流格式/编解码 `client/src/game/replay/StateReplay.ts`；录制器单例 `client/src/game/replay/StateRecorder.ts`（挂 `GameRenderer.update` 帧钩子）；哑播放器 `client/src/scenes/StatePlayerScene.ts`；分享入口 `ResultScene` / `ReplayScene`（`onShare` 回调 → `createAppCore.doShareReplay`）；平台分叉 `IPlatform.shareReplay` / `getLaunchShareCode`（web/wechat/crazygames 三实现）；启动路由 `createAppCore.start → goStatePlayer`；服务端 `server/shared/src/mongo.ts`（`stateReplayShares` 集合 + TTL）+ `server/metaserver/src/service.ts`（`createStateReplayShare` / `getStateReplayShare`）+ `openapi.yml`（`POST /replay/share` / 公开 `GET /r/{shareCode}`）；round-trip 单测 `client/test/stateReplay.test.ts`。

把已有的「游戏内录像」延伸到**游戏外分享**：让没有账号、甚至没装游戏的人，点开一个链接 / 微信卡片就能直接看一局录像，并顺势引导下载试玩。

---

## 0. 一句话边界

| 概念 | 是什么 | 依赖逻辑版本 | 可信？ | 用途 |
|---|---|---|---|---|
| **输入流录像**（S1-RP，已存在） | 只存玩家指令，播放时**重跑引擎**算状态 | **是**（engineVersion + config） | 可信（服务器复算反作弊用它） | 游戏内回放 / 反作弊 / 好友分享 |
| **状态流录像**（本文，新增） | 存渲染层每帧的实体可视状态，播放器**只哑回放、不跑引擎** | **否**（只依赖渲染 schema） | **不可信**（客户端自产，可伪造） | **游戏外公开分享 / Web 落地页** |

**铁律**：两种格式各司其职，状态流绝不进反作弊/天梯结算路径；输入流绝不用于跨版本公开分享（会 desync）。

---

## 1. 为什么用状态流做游戏外分享

游戏外分享的硬约束是「收件人客户端版本不可控、甚至没有引擎」：

- **输入流**播放必须用**相同 engineVersion + 数值 config** 重跑引擎，跨版本 desync；要支持就得长期托管历史 config bundle —— 负担重。
- **状态流**播放只是把记录好的每帧状态画出来，**不跑引擎、不要 config**。它只依赖**渲染 schema**（实体有哪些可视字段），而渲染 schema 变化极少且通常增量兼容 —— 老录像在新客户端照样能放。

代价：体量比输入流大（5–20×），但绝对值仍小（车道战斗同屏单位有限），且可压缩（见 §3）。

---

## 2. 状态流由客户端自产（无需服务端 bake）

关键观察：**分享只发生在两个时机，此时状态流本来就在内存里。**

- **刚结算**（`ResultScene`）：这局刚跑完。
- **刚看完回放**（`ReplayScene`）：看回放 = 喂引擎跑出状态。

### 2.1 `StateRecorder`（客户端，引擎 tick 抓状态）

- 一个输出侧录制器，对称于现有输入侧 `RecordingInputSource`。
- 只要引擎推进一个 tick（**真打 或 看回放都算**），就抓一份当帧的实体可视状态。
- 单槽 ring（只保最近一局），仿现有 `ReplayStore` 的「最近 N 局」做法，内存占用可控。
- 接入点：渲染层每帧本就读 `engine.state`（见 `GameRenderer`），在那里挂钩抓取即可，对引擎零侵入。
- 若当前看的本来就是别人分享来的状态流，则**直接持有原始状态流**，连抓都不用，原样转发。

> 这样「刚结算 / 刚看完回放」时分享按钮按下，状态流读内存即得，**无需重跑、无需服务端复算**。

### 2.2 状态流格式（`StateReplay`）

镜像渲染所需的最小可视集，建议字段（实测再定稿）：

- 头部：`schemaVersion`（**渲染 schema 版本，非 engineVersion**）、`mode`、`boardMeta`（棋盘尺寸/车道/障碍，画背景用）、`players`（双方展示名/头像/段位，画 HUD 用）、`tickRate`、`endTick`、`winner`。
- 帧序列：每 tick 的实体列表 —— 单位 `{id, type, side, col/row 或量化坐标, hp, state/anim, facing, target?}`、建筑 `{id, type, side, col/row, hp}`、可选离散事件 `{spawn/death/hit/projectile}`（驱动特效）。

**压缩策略**：
- **delta 编码**：每帧只记相对上一帧变化的字段（位置/血量插值，未变实体不重复）。
- **量化**：坐标/血量降精度到展示够用即可。
- **稀疏事件**：spawn/death/hit/projectile 只在发生帧记一次。
- 落库前 JSON → 二进制/压缩（可后续）。

**版本兼容**：播放器按 `schemaVersion` 容错读取；新字段增量加、不破老录像。`schemaVersion` 不符时降级播放（缺字段用默认）或提示，不像输入流那样硬拒。

---

## 3. 服务端：只做「存 blob + 发码」

服务端**不碰引擎、不碰数值表**，只是个带访问控制的对象存储。

### 3.1 铸码（分享者本人已登录）

- `POST /replay/share`（meta JWT 鉴权）：上传 `StateReplay` blob → 校验体量上限 → 写存储 → 返回 `{shareCode, url}`。
- `shareCode`：不可猜随机串（≥128bit），防枚举。
- 存储：复用现有大录像外存路径（`replayBlobs` / 后续 S3/GCS `replayRef`），新增 `replayShares` 集合 `{shareCode, blobRef, createdBy, createdAt, expireAt?, viewCount, sizeBytes}`。
- 防滥用：每账号铸码**限流** + blob **体量上限**（超限拒绝，提示这局太长）+ 可选 `expireAt` 过期清理。

### 3.2 公开取（匿名）

- `GET /r/{shareCode}`（**无 JWT**）：取 blob 回传（或先回一个极薄落地页再异步拉 blob）；`viewCount++`。
- 限流防刷；`shareCode` 不存在/过期 → 友好 404 页（带「试玩」CTA）。

### 3.3 与现有 `GET /match/{roomId}/replay` 的关系

后者要求「本人参与」、给的是**输入流**，是游戏内功能，**保持不变**。本文新增的是独立的公开状态流通道，互不影响。

---

## 4. 客户端：无登录直达播放

### 4.1 启动路由（`r=` 参数）

- **Web / CrazyGames**：分享链接 `https://a.gamestao.com/r/{shareCode}`。启动时检测 `r` 参数 → **跳过登录** → 拉 blob → 直接进 `StatePlayerScene`。
- **微信小游戏**：不能分享任意外链。分享者用 `wx.shareAppMessage({ query: 'r=<shareCode>' })` 发成**游戏卡片**进聊天；收件人点开小游戏，读启动参数 `query.r` → 同样直达 `StatePlayerScene`。

### 4.2 `StatePlayerScene`（极薄哑播放器）

- **不加载 `@nw/engine`、不要 config、不要账号** —— 只把 `StateReplay` 每帧画出来。
- 复用渲染资产（SketchPen 棋盘 / UnitView / VFX），但数据源是状态流而非引擎。
- transport 覆盖层同 `ReplayScene`：播放/暂停、1×/2×/4×、进度条。
- 退出去向：**重放** / **返回登录** / **进大厅（试玩）** —— 后两个是拉新入口。
- 落地页轻量化收益：哑播放器无需引擎/数值 bundle，分享页包更小、非玩家加载更快。

### 4.3 分享入口（只在两处出现）

- `ResultScene`（结算页）：「分享这局」按钮 → 读 `StateRecorder` 内存 → `POST /replay/share` → 出码 → 平台分享（Web 复制链接 / 微信 `shareAppMessage`）。
- `ReplayScene`（回放看完）：同上。
- 其它场景不出现该按钮。

---

## 5. 信任与合规

- **状态流可伪造**（客户端自产），仅供观赏；**绝不**进反作弊/结算。文档与代码注释均标明。
- 分享内容含玩家展示名/头像 —— 公开可见，留意隐私；过期清理 + 可举报（后续）。
- 微信侧分享走平台 `shareAppMessage` 规范，不外链。

---

## 6. 实现任务切片（供编码会话）

1. ✅ **`StateReplay` 类型 + `StateRecorder`**（client）：引擎 tick 抓状态、delta/量化、单槽 ring；接入 `GameRenderer` 帧钩子，真打 + 回放两路都录。
2. ✅ **分享入口**：`ResultScene` / `ReplayScene` 加「分享这局」按钮 + 平台分叉（Web 链接 / 微信 `shareAppMessage`）；i18n `share.*` / `stateplayer.*`。
3. ✅ **服务端**：**新** `stateReplayShares` 集合（与输入流 `replayShares` 正交，§3.3）+ `POST /replay/share`（鉴权/限流/体量上限）+ 公开 `GET /r/{shareCode}`（匿名/viewCount++/TTL 过期）；openapi.yml 登记。
4. ✅ **`StatePlayerScene`**：哑状态播放器（复用 `BoardView`/`UnitView`/`BuildingView`/`VFXSystem`，无引擎）+ transport 覆盖层 + 退出三向。
5. ✅ **启动路由**：`IPlatform.getLaunchShareCode`（Web `?r=` / 微信 `query.r`）→ `createAppCore.start` 跳过 intro/登录直达播放器。
6. ✅ **验证**：client tsc + webpack（web）构建通过；状态流 round-trip 单测通过；`shared`/`metaserver` tsc 通过；openapi YAML 解析通过。

> **实现期与设计的偏差/补充**：
> - 服务端集合命名为 `stateReplayShares`（**非**复用 `replayShares` —— 后者是 S1-RP 输入流分享 `{roomId→replayBlobs}`，撞名会混淆，§3.3 要求正交）。
> - 哑播放器**不另设事件通道**：离散特效（死亡/受击/裂痕/建筑摧毁）由相邻满帧的差异**合成**；projectile 特效 v1 暂略（§2.2 标「可选」）。坐标在相邻帧间线性插值，播放更顺。
> - delta 粒度为「整条实体记录」级（变化实体整条记，未变实体省略 + 移除 id 列表），未做逐字段 diff —— 兼顾压缩与编解码简单/可测。

---

## 7. 待定参数（实现/上线期定）

> 实现期已先定如下默认值（代码内常量，上线期可据实测调）：

- 状态流字段最终集 + 量化精度 + 单局体量上限：字段见 `StateReplay.ts`（单位 id/type/side/col/row/hp/maxHp/state，建筑同少 state，基地 hp/maxHp）；坐标量化 2 位小数（`STATE_POS_QUANT=100`）、血量取整；客户端单槽采样上限 `MAX_FRAMES=12000`（30Hz≈6.7 分钟）。**真实一局实测后再定稿** —— 实测见下「2026-06-24 体量定稿」。

> **2026-06-24 体量定稿（真实对局实测）**：一局多兵种长局的状态流远超 512KB、甚至 >1MB，分享被 Fastify 默认 `bodyLimit`（1MB）抢先 413（`FST_ERR_CTP_BODY_TOO_LARGE`），优雅的 512KB→400 路径根本没机会跑。根因是旧 delta 编码「任一字段变化即整条重发」，而位置逐 tick 都在变 → 移动单位每帧全量重发，delta 几乎等于满帧。两处一并改：
> - **关键帧抽稀**（`encodeStateReplay`）：位置逐 tick 变化**不再每帧重发**，仅在拐点（线性插值还原误差 > `POS_KEYFRAME_EPS=0.06` 格）/ 状态·血量切换 / 端点 / 间隔超 `MAX_KEYFRAME_GAP=90` tick 处落关键帧；空 delta 帧整帧丢弃。中间位置由哑播放器**按 tick 线性插值**还原 —— `StatePlayerScene` 本就按 `frac=(t-a.tick)/(b.tick-a.tick)` 插值，**解码侧零改动**。匀速直线行走塌缩为端点。
> - **gzip 压缩**：抽稀后的 delta JSON 仍高度重复，分享前客户端 `CompressionStream('gzip')` + base64（`net/replayCompress.ts`），服务端 opaque 存压缩串，取回客户端解压。分享仅 Web 可达（需 fetch + 在线），故直接用浏览器原生 API。
> - **体量上限重定**：`STATE_REPLAY_MAX_BYTES=2MB`（压缩串；解压后约容纳数十 MB JSON，任意真实长局足够），Fastify `bodyLimit=4MB`（≥ 应用上限，令优雅 400 先于 413 触发）。openapi `blob` 类型由 `object` 改 `string`。两层抽稀+压缩后真实长局压缩串通常仅数十~一两百 KB。
- 铸码限流阈值 / 分享过期策略：每账号 `STATE_REPLAY_SHARE_PER_HOUR=20`/小时（429）；`STATE_REPLAY_EXPIRE_DAYS=14` 天 TTL 自清。永久 vs N 天上线期再定。
- 微信分享卡片封面：当前用 `shareAppMessage` 默认截图，静态图 vs 后续烤短动图待定。
