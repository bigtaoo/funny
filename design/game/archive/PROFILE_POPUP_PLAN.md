# 查看玩家资料弹层（Profile Popup）实现计划

> 状态：**已实现**（2026-06-15）。形态：**点击头像/槽位/对手名 → 弹出资料卡**。
> 落地摘要见文末「实现记录」。
>
> 形态已定：**点击头像 → 弹出资料卡**。
> 背景：9 位数字公开 id 是**纯展示**字段，所有交互（REST/auth/路由/结算/匹配）一律用 uuid(accountId)，
> publicId 从不做标识符。已落地的展示点见下「现状」。本计划补「查看**其他**玩家资料」的入口。

## 现状（已落地，勿重复做）

- `AccountDoc.publicId`（9 位、稀疏唯一索引）+ `ensurePublicId` 惰性生成；auth / `GET /save` 回带；
  `meta GET /internal/profile` 给 gateway 取 `{displayName, publicId}`。
- gateway 把真实昵称 + publicId 经 matchsvc 进 `room_state`（`PlayerSlot.public_id`，proto field 5）。
- **房间界面**（`RoomScene`）：每个玩家槽已显示 `昵称 #id`（被动文本，非弹层）。
- **个人资料页**（`SettingsScene`，大厅左上角头像进入）：显示自己的 `昵称`、`ID #publicId`（i18n `settings.playerId`）。
- 客户端持久化自身 publicId 到 `nw_player_public_id`（`app.ts`）。
- `NetSession.freshToken` 优先用登录 token 连 gateway（房间身份=真账号，非设备匿名账号）。

## 缺口（本计划目标）

| 界面 | 现状 | 目标 |
|---|---|---|
| 房间/匹配界面 | 已显示昵称#id（被动） | 头像/槽位**可点** → 资料弹层 |
| 游戏内（`HUDView` 顶部对手条）| 只显示 HP/金币，**无昵称/id**；且客户端对局中**根本没收到对手身份** | 对手（和自己）头像可点 → 资料弹层（仅 netplay）|
| 结算界面（`ResultScene`）| 只显本地玩家徽章/胜负/ELO，无对手身份、无数据 | 显示对手昵称 + 可点 → 资料弹层（仅 netplay）|

**根因**：对局中客户端只拿到 `MatchStart{room_id,mode,seed,start_frame,local_side}`，**没有对手昵称/publicId**。
ticket 有 `opponent`(名字) 但客户端看不到 ticket 内部，publicId 也没进 ticket。ranked 直接开局、不经房间，
所以排位对手连房间界面都看不到。**必须把对手身份下发到对局**。

## 实现步骤

### A. 把对手身份下发到对局（ticket → match_start）

1. `server/shared/src/ticket.ts`：`TicketClaims` 加 `opponentPublicId: string`（紧挨现有 `opponent`）。
2. `server/contracts/transport.proto`：`MatchStart` 加 `string opponent_name = 6; string opponent_public_id = 7;`
   - 跑 `cd client && npm run proto:gen` 重生 `client/src/net/proto/transport.ts`。
   - gameserver 运行期 protobufjs 读 `.proto`，**但** `gameserver/src/proto/transport.ts` 是手写 encode 包装：
     `ServerMsg` 的 `match_start` 分支加 `opponentName/opponentPublicId` 两字段，`encodeServer` 的 `match_start`
     case 里加 `opponent_name`/`opponent_public_id`（snake_case，keepCase）。
3. `server/matchsvc/src/Matchmaking.ts`：`QueueEntry` 加 `publicId`；`enqueue(accountId, name, publicId, elo)`。
4. `server/matchsvc/src/Matchsvc.ts`：
   - `enqueue(accountId, name, _publicId, elo)` 现在**丢弃** `_publicId` → 改为传给 `matchmaking.enqueue`。
   - `startMatch(mode, a, b)` 的 `a/b` 加 `publicId` 字段（friendly 槽位已有 `publicId`；ranked 的 `onPair`
     现在拿到的 `QueueEntry` 含 publicId）。`sign()` 的 `claims` 加 `opponentPublicId: opp.publicId`。
5. `server/gameserver/src/`：
   - `index.ts` 握手处 `manager.join(conn, claims.opponent, claims.seed, mode)` → 多传 `claims.opponentPublicId`。
   - `RoomManager.join` / `Room.addPlayer` 签名加 `opponentPublicId`，存进 `Slot`（`Slot.name` 现已是
     **对手**名字，新增 `Slot.publicId` = 对手 publicId）。
   - `Room.launch()` 的 `match_start` 加 `opponentName: s.name, opponentPublicId: s.publicId`
     （`s.name` 本就是该 slot 的对手名）。

### B. 客户端拿到对手身份

6. `client/src/game/net/NetInputSource.ts`：`MatchStartInfo` 加 `opponentName: string; opponentPublicId: string`；
   `onMatchStart` 从 `m.opponentName / m.opponentPublicId` 填入。

### C. 资料弹层组件

7. 新建 `client/src/render/ProfilePopup.ts`（或 `scenes/`）：自包含 PIXI overlay——暗底 + 资料卡
   （`buildAvatar` 头像 + 昵称 + `#publicId`，rank 可选）+ 关闭按钮 / 点外部关闭。
   - **关键**：用 PIXI `interactive + on('pointertap')`（`ResultScene` 按钮即此法，证明交互管理器在用），
     这样**跨场景统一**（RoomScene/SettingsScene 用手写 hit-list、GameRenderer 用 InputManager，但 PIXI
     交互覆盖层在三者之上都可点）。加在场景 container 最顶层。
   - 资料字段：昵称、`#publicId`。**rank 暂不下发对手 ELO**，先不显示对手段位（要显示需再扩 match_start
     带 opponent elo/rank，或 meta 查询——本期不做）。自己的弹层可复用 SettingsScene 的数据（有 rank）。

### D. 三处入口接线

8. `RoomScene`：每个 slot 的头像/名字区加 hit → 打开弹层（数据取该 slot 的 `name`+`publicId`，room_state 已有）。
   注意 RoomScene 每次 `render()` 重建，弹层需作为场景状态持久（`this.popup` + 在 render 末尾绘制）。
9. `app.goGameNet` → `GameScene`(opts) → `GameRenderer`：把 `MatchStartInfo` 的 `opponentName/opponentPublicId`
   + 本地玩家昵称/id 透传进 `GameRenderer`。`GameRenderer.handleDown` 加 HUD 对手条 / 自己条命中区 → 打开弹层。
   **仅 netplay**（`netEnabled`）才接线；vs-AI / campaign 无真人对手，不可点。
10. `ResultScene`：构造参数加可选 `opponent?: {name, publicId}` + `localPlayer?: {name, publicId}`；
    显示对手昵称（标题区或徽章区附近）+ 头像可点 → 弹层。`app.goResult` / `finishNet` 把对手身份透传进来。

### E. i18n / 验证

- 新增需要的 i18n key（如弹层标题 `profile.title`、关闭 `profile.close`）zh/en/de 全翻（`zh.ts` 为键唯一来源）。
- 验证：client `tsc` + `npx vitest run` + web 构建；server `tsc -b shared metaserver gateway matchsvc gameserver commercial`
  + matchsvc/gateway/meta 测试。注意改了签名的测试要同步（`matchsvc.test.ts` 的 `enqueue`、`matchsvcClient.test.ts`）。

## 注意

- vs-AI（`goGame`）/ campaign 没有真人对手：对手头像不可点或显示「AI」无 id。
- 改 `transport.proto` 必 `npm run proto:gen`；改 `webpack.config.js`/`DefinePlugin` 才需重启 dev server（本任务不涉及）。
- 已确认的关键事实：`gameserver` 的 `Slot.name` = **对手**名字（来自对方视角的 `ticket.opponent`），
  所以 `match_start` 里「对手名」直接取 `s.name`，不要再去找另一个 slot。

## 实现记录（2026-06-15）

**A 对手身份下发（服务端）**：`TicketClaims.opponentPublicId`；`transport.proto MatchStart` 加
`opponent_name=6 / opponent_public_id=7`（`npm run proto:gen` 重生 client proto + gameserver 手写
`proto/transport.ts` 的 `match_start` encode 补两字段）；`Matchmaking.QueueEntry.publicId` +
`enqueue(accountId,name,publicId,elo)`；`Matchsvc` onPair/startMatch/sign 全程透传 publicId（gateway 早已
经 `/mm/queue/enqueue` 带 publicId 入参，无需改 gateway）；`gameserver` `RoomManager.join` /
`Room.addPlayer` / `Slot.publicId` 透传，`Room.launch` 的 `match_start` 取 `s.name`/`s.publicId`。

**B 客户端接收**：`NetInputSource.MatchStartInfo` 加 `opponentName/opponentPublicId`，`onMatchStart` 填入。

**C 组件**：新建 `client/src/render/ProfilePopup.ts`——PIXI interactive 覆盖层（暗底点击关闭 + 资料卡
`buildAvatar` 头像 + 昵称 + `#publicId` + 可选 rank/ELO + 关闭按钮）。跨场景统一：宿主只需把
`popup.container` 加到最顶层，并在自己的 down-handler 里 `if (popup.isOpen) return`（弹层自带 PIXI 关闭）。

**D 三入口**：① `RoomScene` 每个占用槽位注册 hit → `openProfile(slot)`；render() 末尾恒重加 popup 容器。
② `GameRenderer`（仅 netplay）：top строй右侧绘对手昵称 + `HUDView.getEnemyInfoRect()`/`getPlayerInfoRect()`
两个命中区——对手区在卡牌检测前、自己区在卡牌检测后（卡牌优先）；`GameScene.options.profiles` 透传，
`app.goGameNet` 用 `info.opponentName/publicId` + 本地 `playerName()`/`nw_player_public_id`/`saveManager.pvp`
组 profiles。③ `ResultScene` 加可选 `ResultProfiles{opponent,local}`，标题下渲染「{本地名}（你）」+
「vs {对手名}」两行可点（PIXI interactive）→ 弹层；`app.goResult` 第 6 参透传。

**E i18n**：`profile.{title,close,id,rank,you}` + `result.vs` zh/en/de 全翻。

**验证**：server `tsc -b` 六包 + matchsvc 17/gameserver 42/gateway 5 测试绿（`matchmaking.test`/`room.test`/
`roomManager.test` 同步加 publicId 参数）；client `tsc` + 132 测试 + web 构建绿。

**未做**：对手 rank/ELO 未下发（`match_start` 只带 name+publicId），故对手卡不显示段位；本地卡显示段位。
要显示对手段位需再扩 `match_start`（带 opponent elo/rank）或 meta 查询，本期不做。vs-AI/campaign 无真人
对手，不接线。
