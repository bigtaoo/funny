# Notebook Wars — 账号系统设计文档

> 创建：2026-06-14。本文件是**账号 / 登录 / 单机模式门槛**的设计基准。
> 配套：`META_DESIGN.md`（§2 信任边界、§3.3 账号身份）、`SERVER_API.md`（§2.1 auth 端点）、`UI_DESIGN.md`（§4.6 ProfileScene）、`ACCOUNT_DESIGN.md`（本文）。
> 状态：**已落地（SA-1~SA-4，2026-06-14/06-22）**（订正 2026-07-07：原标「设计稿，未实现」已滞后，与本文各实现备注一致）。任务编号见 `META_TASKS.md` SA-1~SA-4。

---

## 0. TL;DR

- 现状：**纯匿名**（device UUID / wx.login 自动换 accountId），无任何登录界面。
- 目标：**默认要求登录**才进大厅；登录界面提供「单机试玩」入口走纯本地匿名，**不联云、不联机**。
- 四种登录并存：**邮箱/用户名+密码**、**第三方 OAuth**、**微信**、**匿名升级绑定**。
- 一个 `accountId` 可绑定多种凭证（identity）；匿名设备账号可「升级」为带凭证的正式账号，**保留已有存档/钱包**。
- 联机 / 商店 / 充值 **必须正式登录**（有可恢复凭证）；单机试玩仅能玩 PvE 战役 + 本地 PvP-vs-AI + 看本地录像。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| A1 | **默认要求登录** + 登录界面带「单机试玩」入口 | 用户拍板。云存档/联机/付费都需要可恢复身份；单机入口降低首次门槛、断网可玩 |
| A2 | 四种登录方式并存（邮箱密码 / OAuth / 微信 / 匿名升级） | 覆盖 Web（密码/OAuth）+ 微信小游戏（wx.login）+ 试玩转正（匿名升级） |
| A3 | accountId 与 identity 解耦：**一账号多凭证** | 同一玩家可邮箱+OAuth 同时绑；匿名升级 = 给现有 accountId 挂一个新凭证，不换号 |
| A4 | 单机试玩 = **纯本地匿名**，不发任何网络请求 | 与现状「API 基址为 null 时纯本地」一致；试玩数据存本地，登录后可选合并 |
| A5 | 密码存 **哈希**，绝不明文；JWT 仍是会话载体（订正 2026-07-07：实际用 Node `crypto.scrypt`，见 §6 / `shared/password.ts`，非原写 bcrypt/argon2） | 自建账号体系的最低安全线 |
| A6 | 微信平台**跳过登录界面**，直接 wx.login 静默登录 | 小游戏环境天然有微信身份，强制登录界面是多余摩擦；其 `supportedLocales=['zh']` 同理是平台特化 |

---

## 2. 账号与凭证模型

### 2.1 概念

```
account（一个玩家）         identity（一种登录凭证，多对一）
  accountId ──────┬──────  { kind:'device',   deviceId }
                  ├──────  { kind:'password', loginId(email/username), hash }
                  ├──────  { kind:'oauth',    provider, sub }
                  └──────  { kind:'wx',       openid }
```

- 一个 `account` 可挂多条 `identity`；任一 identity 登录都解析到同一 `accountId`。
- 存档（meta `saves`）、钱包（commercial `wallets`）都以 `accountId` 为 key——**绑定/升级不动这些数据**。

### 2.2 Mongo（meta 库，扩展现有 `accounts` 集合）

现状 `accounts`：`{_id:accountId, openid?, deviceId?, createdAt}`（device/openid 唯一稀疏索引）。扩展为：

```ts
interface AccountDoc {
  _id: string;            // accountId
  createdAt: number;
  // 凭证（每种可选，至少一条）
  deviceId?: string;                 // 匿名设备（稀疏唯一）
  openid?: string;                   // 微信（稀疏唯一）
  password?: {                       // 邮箱/用户名密码
    loginId: string;                 // 规范化的 email 或 username（稀疏唯一）
    hash: string;                    // bcrypt/argon2
  };
  oauth?: { provider: string; sub: string }[];  // 多个第三方（provider+sub 唯一）
  // 资料
  displayName?: string;
  nameChosen?: boolean;              // 玩家是否主动定过名（注册带名/改过名）；缺省=当前名是系统默认，享一次免费改名
  isAnonymous: boolean;              // 仅有 device、无可恢复凭证 → true
}
```

**索引**：`deviceId`(sparse,unique)、`openid`(sparse,unique)、`password.loginId`(sparse,unique)、`oauth.provider+oauth.sub`(unique)。

> `displayName` 注册/设备登录时可选，多数账号（尤其游客）从不主动设置。`getDisplayName`/`getProfile`（`accounts.ts`）读取时会懒惰回填一个随机默认昵称（`ensureDisplayName`，与 `ensurePublicId` 同一套模式），避免对战历史、房间玩家列表等处永久退化成显示裸 id。默认昵称由 `@nw/shared` 的 `randomPlayerName()` 生成：从 `playerNamePool.ts`（约 290 个真实玩家昵称，取样自 Hypixel/Minecraft 公开昵称数据集 `FlorianCassayre/nicknames-datasets`，CeCILL-B，经机器+人工清洗去数字垃圾/乱码/脏话/政治词）里随机取一个，约 1/6 概率追加短数字后缀（模拟真人重名加数字，绝大多数名字无数字）。因此游客与 botsvc 机器人（同走设备登录）在词汇、大小写、数字分布上都与真人玩家一致，无法一眼区分；刻意不含 Cadet/Recruit/Scholar 这类 NPC 词。matchsvc 匹配超时回退的 AI 对手名也用同一生成器。

> **改名与一次免费机会**：改名（`POST /profile/rename`）默认扣 `RENAME_COST`（500 金币）。但从未主动定过名的玩家（游客、微信/OAuth，以及注册时跳过昵称字段的密码用户——他们顶着系统懒回填的默认名）享**一次免费改名**。判定用 `nameChosen`：注册时显式传 `displayName`、或任意一次改名成功，都会置 `nameChosen=true`；`ensureDisplayName` 的懒回填**不**置位（它只是默认名）。`profileRename` 先查 `hasFreeRename`（=`!nameChosen`）：为真则走免费路径（不扣费、不需要 commercial 服务，改名后置 `nameChosen`），否则走原扣费路径。`GET /save` 与改名响应都带 `freeRename` 布尔，客户端据此把改名按钮显示为「免费改名」且不受余额限制（见 `SettingsScene`）。

> `isAnonymous`：只挂 device identity = true；一旦绑定 password/oauth/wx = false。联机/商店/充值要求 `isAnonymous=false`。

---

## 3. REST 端点（meta 请求面，扩展 §2.1）

> 完整契约同步进 `SERVER_API.md §2.1`。所有返回统一 `{ token, accountId, isNew, isAnonymous }`（沿用现有 AuthResult，加 `isAnonymous`）。

```
# 现有（保留）
POST /auth/device   { deviceId }                 → AuthResult   # 匿名设备，自动 upsert
POST /auth/wx       { code }                      → AuthResult   # 微信 code 换 openid

# 新增：CrazyGames 门户 SSO（RETENTION_LAUNCH_PLAN.md §1.1/§3.1，2026-09-23）
POST /auth/crazygames { token }                   → AuthResult | OAUTH_FAILED
  # token = SDK.user.getUserToken()，服务端按 CrazyGames 公钥验 RS256（crazygamesAuth.ts），
  # 不复用 NW_JWT_SECRET——那签的是我们自己的 token，这是第三方签的。
  # 走 resolveByOAuth(cols, 'crazygames', userId, ...)：与 Google/Apple 同等耐久性（isAnonymous=false），
  # 不进 OAuthProvider 联合类型（google-only）——机制是验 JWT 不是换码，不走 /auth/oauth 那条路。
  # 未配置 NW_CRAZYGAMES_GAME_ID（游戏尚未在 CrazyGames 开发者后台登记）时返回 OAUTH_FAILED，
  # 不影响其它登录方式。
  # 2026-09-27 起 body 可带 guestToken（客户端当前会话）：该 CG userId 还没有账号、且 guestToken 是
  # 纯设备访客（isAnonymousAccount）时，bindOAuth 把 CG 身份挂到这个访客账号上（进度保留，不新开号）；
  # 已有账号的 CG 用户照旧回到自己的号，访客号不动。每次登录用 token 里的 username / profilePictureUrl
  # 覆盖 displayName（nameChosen=true）与 platformAvatarUrl（只收白名单 https 主机），并写
  # nameLockedBy='crazygames' → /profile/rename 一律拒绝。详见 CRAZYGAMES_LAUNCH.md §4.1。

# 新增：密码
POST /auth/register { loginId, password, displayName? }   → AuthResult | LOGIN_ID_TAKEN
POST /auth/login    { loginId, password }                 → AuthResult | INVALID_CREDENTIALS
POST /auth/password/reset/request { loginId }             → { ok }      # 发邮件（后期）
POST /auth/password/change { oldPassword, newPassword }   → { ok }      # 需 JWT

# 新增：OAuth（授权码流；provider ∈ google/github/…）
POST /auth/oauth    { provider, code, redirectUri }       → AuthResult | OAUTH_FAILED

# 新增：匿名升级 / 绑定（需现有 JWT；把新凭证挂到当前 accountId）
POST /auth/bind     { method:'password'|'oauth'|'wx', ...credential }
  → { ok, isAnonymous:false } | ALREADY_BOUND | LOGIN_ID_TAKEN
```

**绑定语义（A3 的落地）**：
- 客户端持当前（可能是匿名 device 的）JWT 调 `/auth/bind`。
- 若目标凭证**未被任何账号占用** → 挂到当前 accountId，`isAnonymous=false`，存档/钱包原样保留。
- 若目标凭证**已属另一账号** → 返回 `ALREADY_BOUND`，前端提示「该邮箱/微信已注册，是否改为登录该账号？」（登录会**切换 accountId**，当前匿名本地数据按 §5 处理）。

---

## 4. 客户端：登录界面 + 单机门槛

### 4.1 启动流程改造（`app.ts`）

现状：`initI18n → 建 SaveManager → void bootstrap() → seen_intro ? goLobby : goIntro`。

改为：

```
initI18n
  → 建 SaveManager（仍离线优先，loadLocal 同步可玩）
  → seen_intro? : goIntro（首次故事，不变）
  → goIntro 完成 / 非首次：
      微信平台 → 静默 wx.login → goLobby（A6，跳过登录界面）
      其他平台 →
        已有有效会话(本地存了 token 且未过期 + isAnonymous=false) → bootstrap → goLobby
        否则 → goLogin（新增 LoginScene）
```

### 4.2 新增 `LoginScene`（canvas，对齐 RoomScene 风格）

视图机 `landing → password → register → oauthWait`：

- **landing**（主界面）：
  - 「邮箱/用户名登录」→ `password` 视图
  - 「注册」→ `register` 视图
  - 「Google / GitHub 登录」→ 打开 OAuth 授权页（Web：`window.open`/重定向；回跳带 code → `/auth/oauth`）
  - 「**单机试玩**」→ 不登录，直接 `goLobby({ offline:true })`（见 §4.3）
- **password**：loginId + 密码输入 → `/auth/login` → 成功存 token → bootstrap → goLobby
- **register**：loginId + 密码 + 昵称 → `/auth/register` → 同上
- **oauthWait**：等待 OAuth 回跳的 spinner

> 复用 RoomScene 的输入键盘/视图机模式（`scenes/RoomScene.ts`）。i18n 新命名空间 `auth.*`（zh 为源，en/de 全翻）。

### 4.3 单机模式（offline）行为

- `goLobby({offline:true})`：大厅照常，但**屏蔽需要正式账号的入口**：
  - 联机/排位（社交格）→ 点击提示「单机模式，登录后可联机」+ 一个「去登录」按钮回 LoginScene。
  - 商店/充值 → 同样拦截引导登录。
  - 战役 PvE / PvP-vs-AI / 本地录像 → **可玩**（纯本地，确定性引擎，无需账号）。
- 单机产生的存档存本地（`nw_save_v1`，现有 LocalSaveStore），`accountId=''`。
- 大厅常驻一个「登录 / 注册」入口，随时可转正。

### 4.4 转正（单机 → 登录）时的本地数据

登录/注册成功后，本地已有匿名存档（PvE 进度等）。处理：
- 走 SaveManager 现有 `reconcile`：拉云端存档与本地**合并**（progress/materials 取并集/较大值，flags/equipped 本地覆盖——现状逻辑，见 `SaveManager.reconcile`）。
- 权威段（wallet/inventory/pvp）以云端为准（单机本就没有这些的有效值）。
- 即「单机试玩攒的 PvE 进度，登录后不丢」。

---

## 5. 会话与 token 管理

| 项 | 现状 | 改造 |
|---|---|---|
| token 存储 | ApiClient 内存（每次 bootstrap 重 auth） | 正式登录后 **持久化** token（localStorage `nw_token`）+ 过期时间，下次启动免重输密码 |
| 凭证回调 | `getAuthCredential()` 返 device/wx | 正式账号登录后，会话续期改用「持久 token 直接用，过期再走对应登录」；device/wx 仍自动续 |
| 匿名 device | 一直用 | 保留作单机/未登录态身份；绑定后该 accountId 升级，device identity 仍挂着（同设备免登录入口） |
| 登出 | 无 | 新增：清 `nw_token` + 回 LoginScene；本地存档保留（下次登录 reconcile） |

> **订正（2026-07-25，avatar-leak-across-account-switch bug）**：「本地存档保留」不能整段照字面实现——`reconcile` 对 `equipped`/`flags` 是**本地覆盖云端**（§4.4 就是靠这点让单机转正的进度不丢），但这条规则默认「本地 = 当前账号自己的离线改动」。若真按登出即保留本地存档，账号 A 登出、账号 B 登入时，A 残留在内存里的 `equipped`（含头像/称号）与 `flags`（含 `gdprConsent`）会被当成「A 的离线改动」原样合并进 B 的会话，甚至被标脏后反向覆盖 B 云端的存档。修复：`doLogout()` 现在会调用 `SaveManager.clearSyncedLocalSections()` 清空内存中的 `equipped`/`flags`/`pvpDeck`（`client/src/game/meta/SaveManager.ts`），并清掉头像的本地 fallback key `nw_player_avatar`（`client/src/app/nav/auth.ts`）——权威段（wallet/cardInv 等）不受影响，`reconcile` 本来就整段以云端为准。§4.3/4.4 的「单机转正」路径不受影响：`accountId` 从空串首次写入不算「切换」，所以离线试玩的头像/进度依旧照常并入登录后的账号。

> **订正（2026-07-28，stale-response-rollback bug）**：`reconcile` 对权威段（wallet/cardInv/equipmentInv 等）原是无条件整段采用云端值（`{...cloud}`），没有拿 `cloud.rev` 跟本地已持有的 `rev`比较。多数调用方（gacha 连抽连点等）没有 busy 防抖，短时间内会有多个请求同时在途；网络/DB 抖动下响应可能乱序到达——一个更早发出但更慢返回的请求，其响应可能晚于一个更晚发出但更快返回的请求到达。旧逻辑会把这个"迟到的旧响应"整段采纳，把 `cardInv`/`wallet` 等权威段**回滚**到更早的快照，连带"复活"本应已被消耗（如已合成掉）的卡牌实例——这些复活的 ID 服务端早已物理删除，玩家一操作立刻 404 CARD_NOT_FOUND，且现象必现于「连点抽卡 → 立即合成」。修复：`reconcile()` 现在会丢弃 `cloud.rev` 低于本地已持有 `rev` 的响应（`client/src/game/meta/SaveManager.ts`），乱序到达的旧响应不再覆盖更新的状态。

> JWT 仍由 meta 签（`shared/src/jwt.ts`，30d）。持久化 token 只是免去重输密码，过期/失效仍回登录。

> **订正（2026-09-10，ADR-089，iPhone 13 真机报告）**：上面「过期/失效仍回登录」两处都没有兑现，而且是两个互相独立的问题。
>
> **① 30 天从来不是「不活跃 30 天」，而是「上次输密码起 30 天」。** `signToken` 全仓只有 5 个调用点（`service/auth/credential.ts` 4 处 + `oauthBind.ts` 1 处），**全是显式登录/注册/OAuth 绑定**，此后没有任何一处会换 token。于是天天上线的玩家照样在第 30 天被踢。**改为滑动续期**：`metaserver/src/auth.ts` 的 `bearerAuth` 验签成功后看 `exp`，剩余不足 `TOKEN_RENEW_WINDOW_MS`（10 天）就用同一个 accountId 重签，塞进响应头 `x-nw-token`；客户端在 `ApiClientCore.fetchRaw()`（所有 REST 请求唯一收口）读到就换掉，并由 `createAppCore` 注册的 outlet 回写 `nw_token`。于是每 20 天之内开一次 app 就能无限续下去。
>
> - **不引入 refresh token**：续期的前提是手上那个 token 还有效，所以泄露的 token 依然被同一个 30 天上界封住；多一套存储/撤销表/端点换不回对应的收益。
> - **只在 metaserver 签**：`worldsvc`/`socialsvc`/`auctionsvc`/`analyticsvc` 只验签、不连账号库，没有「这个账号还活着吗」的依据；客户端换了 token 它们自然受益。
> - **CORS `exposedHeaders` 是成败开关**：`x-nw-token` 不在 CORS 安全列表响应头里，不加就是「服务端照签、客户端永远读不到、且没有任何一处报错」。Capacitor 的 origin 是 `capacitor://localhost`，跨域同样吃这条。
> - **回写只覆盖、不新建**：匿名 device/wx 会话的 token 只在内存里（`NetSession.freshToken` 的 `api.auth` 路径），写进 `nw_token` 会把游客**静默提升**成「已登录」——`resolveEntry` 不再给登录页、Settings 开始给出登出/改名/删号。所以 outlet 只在 `TOKEN_KEY` 已有值时才写。
>
> **② 真失效时只弹 toast、不导航**，玩家卡在一个所有请求都 401 的大厅里。**改为强制退回登录页**：`net/log.ts` 的 `sessionExpiredSink` + `notifySessionExpired()`（同文件 `appealSink` 那一套），触发点收在传输层三处（`ApiClientCore.request` / `WorldApiCore` 的 request 助手 / `NetSession.freshToken`），`app.ts` 把 sink 指向 `nav/auth.ts` 的 `forceLogout()`：toast 停 1.5 s → 复用 `doLogout()` 整套清理 → `goLogin({ notice: 'auth.err.sessionExpired' })`（LoginScene 的 landing 视图为此第一次有了错误行）。**对局中命中也直接踢回登录页**——走到这一步连续期都救不回来，gateway 必然也连不上。三个闸门：一次性 latch（并发 401 burst，下次登录成功才重新上膛）、teardown 窗口（`resetForLogout()` 的 best-effort flush 拿死 token 必然再 401，会自我递归）、离线模式与无持久化 token 的游客不触发。
>
> **顺带**：`client/src/net/apiErrorMessage.ts` 里 `UNAUTHORIZED`/`TOKEN_EXPIRED`/`FORBIDDEN` 三个 code 服务端从来没发过（401 只有 `UNAUTHENTICATED`，权限拒绝是 `NO_PERMISSION`），真 401 一直落到泛用文案。补上 `UNAUTHENTICATED`，并把权限拒绝拆到新文案 `common.err.forbidden`（「权限不足」≠「登录过期」）。

---

## 6. 安全要点

- 密码：注册时用 Node 内建 `crypto.scrypt` 哈希存储（订正 2026-07-07：实现为 `shared/password.ts`，自描述串 `scrypt$N$r$p$salt$hash`，零额外依赖、跨平台，非原设计所写 `argon2`/`bcrypt`）；登录时比对哈希。loginId 规范化（email 小写去空格 / username 大小写策略）。
- 速率限制：`/auth/login`、`/auth/register` 加 IP/账号维度限流（防撞库）——后期接，先留位。
- OAuth：标准授权码流，`state` 防 CSRF，服务端用 code 换 token 再取 `sub`，绝不信前端直传身份。
- 内部信任：commercial/matchsvc 不解析玩家 JWT，只信 meta/gateway 传来的 accountId（§信任边界与 `META_DESIGN §1.1` 一致）。

---

## 7. 实现拆分（建议任务，登记进 META_TASKS）

| 任务 | 内容 | 端 |
|---|---|---|
| SA-1 | accounts 模型扩展（password/oauth/多凭证 + 索引）+ `/auth/register`/`/auth/login` | server(meta) |
| SA-2 | `/auth/oauth`（先接一个 provider，如 Google）+ `/auth/bind` 绑定/升级 | server(meta) |
| SA-3 | 客户端 LoginScene（landing/password/register）+ app.ts 登录门控 + 持久 token | client |
| SA-4 | 单机模式门槛（大厅屏蔽联机/商店/充值入口 + 引导登录）+ 转正 reconcile 验证 | client |

---

## 8. 开放问题（已于 2026-06-14 拍板）

- [x] **loginId 用邮箱还是用户名还是都行** → **都允许**（`normalizeLoginId` 大小写/空格不敏感；邮箱可走后置找回密码，用户名不可）。
- [x] **OAuth 首期接哪个 provider** → **Google**（SA-2 已落地，见下）。
- [x] **找回密码** → **首期只做需登录的改密**（`/auth/password/change`）；找回密码（邮件服务）后置。
- [x] **单机试玩攒的钱包/抽卡** → **OK，从零开始**（单机无 commercial 参与；转正后权威段以云端为准，仅 PvE 进度并入）。
- [x] **微信是否也允许绑定邮箱** → **允许**（属 SA-2 bind，已实现）。

> 实现备注（SA-1/SA-3/SA-4，2026-06-14 落地）：
> - 密码哈希用 **Node 内置 `crypto.scrypt`**（`shared/password.ts`，零依赖、跨平台），**非 argon2/bcrypt**（避免 Windows 原生编译）。串格式 `scrypt$N$r$p$saltB64$hashB64`。
> - `isAnonymous` **计算得出不落库**（`isAnonymousAccount(doc)`），device-only=true，绑 password/oauth/wx=false。
> - `WEAK_PASSWORD` 由 handler 校验（openapi 的 password 不设 minLength，否则被 glue 通用校验抢先成 BAD_REQUEST）。
> - 客户端文本输入用**隐藏 `<input>`**（桌面 + 移动软键盘）+ canvas 渲染（密码掩码），**未用** RoomScene 的定制字符键盘。
> - 持久 token 存 `nw_token`；启动门控 `resolveEntry`（wx 静默 / 无 API 纯本地 / 有 token 复用 / 否则登录）。token 过期检测从简（乐观进大厅，pull 失败静默退化只读本地）。

> 实现备注（SA-2，2026-06-22 落地）：
> - `OAuthService`（`metaserver/src/oauth.ts`）：用 Google userinfo 端点（`/oauth2/v3/userinfo`）取 `sub`，避免 JWKS + JWT 签名验证复杂度；`NW_OAUTH_GOOGLE_CLIENT_ID/SECRET` 配置，未配置时返回 `OAUTH_FAILED`。
> - `resolveByOAuth`（`accounts.ts`）：按 `oauth.provider+sub` upsert——首次登录自动建账号，`isAnonymous=false`（OAuth = 可恢复凭证）。
> - `bindOAuth` / `bindPassword`（`accounts.ts`）：`$addToSet oauth` 或设 `password`；凭证已被其他账号占用时返 `already_bound`。
> - IP 滑动窗口限流（`SlidingRateLimiter` 20次/15min）应用于 `authLogin`/`authRegister`/`authOAuth` 三端点。
> - 客户端唤起 OAuth（`oauthWait` 视图）尚未实现，等有可联调回调域名时补。

> 实现备注（C4 PvE 反作弊 + C5 合规接口，2026-06-22 落地）：
> - **C4 + S4-4（2026-06-29 完整落地；2026-07-18 取消自动封号，改人工审核见 PVE_INTEGRITY_PLAN.md §8.6）**：`AccountDoc.flags.pveWarnings`（可疑次数，纯展示/审核信号，不再是封号条件）+ `flags.banned`（账号封号，现在**只能**由运营人工裁定写入）；pveVerify rejected 路径原子递增 `$inc flags.pveWarnings`，每次都写警告系统邮件（`insertSystemMail`）+ 在 `antiCheatReviews` 写一条 `kind:'pve_reject'` 审核记录（reject 次数达旧阈值 `PVE_REJECT_BAN_THRESHOLD` 只标 `severity:'high'` 供运营优先处理，不再自动设 `flags.banned`/`antiCheat.pveBanned`）；**pveClear** 先执行 `rejectIfBanned`（`accounts.flags.banned`）再检查 `antiCheat.pveBanned`——管理员手动封号即时生效；**pveVerify** 开头读 save 层 `pveBanned`，命中则 403；auth 层（authWx/authDevice/authLogin/authOAuth）在签 token 前执行 `rejectIfBanned`；`GET /internal/suspicious-pve` + `POST /internal/accounts/:id/ban` + `POST /internal/accounts/:id/unban`（管理员手动封/解封，同步清除 save 层 `pveBanned`）→ admin 层 `POST /admin/accounts/:id/ban` + `unban`（需 `anticheat.action` 权限，super/ops 拥有）+ `GET /admin/suspicious-pve`（前端入口）；`POST /admin/anticheat/reviews/:id/resolve`（`anticheat.action`，dismiss 或 ban，ban 时内部调用同一条 `/internal/accounts/:id/ban` 路径）；AuditAction 补 `account.ban`/`account.unban`/`anticheat.review.resolve` 留痕。
> - **C5-a**：`GET /gacha/pools` 返回的每个 entry 新增 `probability = weight/totalWeight`（Apple 3.1.1 概率公示要求）。
> - **C5-b**：`DELETE /account` → 软删除 `accounts.deletedAt = now()`（Apple 5.1.1(v) 要求）；`rejectIfBanned` 同时检查 `deletedAt`，命中返 410 `ACCOUNT_DELETED`；宽限期满后由 metaserver 清除任务跨服务清除（见下「C5-b 账号清除」）。`rejectIfBanned` 2026-07-27 起经 `metaserver/src/accountCache.ts` 缓存（60s TTL 兜底 + ban/unban/deleteAccount 三处写入点显式失效，立即生效不等 TTL）。
> - **C5-b 订正（2026-08-10，真实用户被锁死账号后发现）**：删除确认文案（`settings.deleteAccount.confirmBody`）、隐私政策 §7、`DELETE /account` 的实现备注三处一直承诺"7 天宽限期内重新登录可恢复"，但 `authWx`/`authDevice`/`authLogin`/`authOAuth` 都在签 token **之前**调用 `rejectIfBanned`，deletedAt 命中直接 410——真正能撤销的 `POST /account/cancel-deletion`（P0-13/B14）又需要 bearer token，删除后永远拿不到，等于承诺的恢复路径**从未生效**，账号一旦删除即永久锁死。修复：四个 auth 入口在 `rejectIfBanned` 之前新增 `restoreIfWithinGrace(accountId)`（`auth.ts`）——deletedAt 在 7 天宽限内则原子清除 `deletedAt`/`deletionConfirmToken`（同步 `accountCache.invalidateBanStatus`），让"重新登录"真正等于恢复；过期则不动，仍然 410。`cancel-deletion` 保留作为**同一会话内**的即时撤销（不必登出重进）。
> - **C5-c**：`POST /account/gdpr-consent` → 设 `accounts.flags.gdprConsent=true/false`；analyticsvc POST /analytics/events：已识别用户（有 JWT）且 `batch.consent !== true` 时静默丢弃（无 PII 的匿名请求不受约束）。
> - **C5-b 清除任务（2026-09-29 落地）**：此前「7 天后异步清理」只是文档/隐私政策/`AccountDoc` 注释里的承诺，**全仓库没有任何清除代码**——软删过了宽限期的账号数据在所有服务里原样留存。现在由 metaserver `accountPurge.ts` 执行，下面「C5-b 账号清除」一节是权威描述。

#### C5-b 账号清除（post-grace purge，2026-09-29）

**触发与调度**：metaserver 内 `purgeDeletedAccountsOnce`（`metaserver/src/accountPurge.ts`），`index.ts` 里 `setInterval` 每小时一轮（`NW_ACCOUNT_PURGE_INTERVAL_MS`，默认 1h，0 = 关）+ 开机 60s 后先跑一轮。沿用 reputationDecay / coinAnomalyAudit 的「有界批次 + 幂等 + 可重跑」形态；没用每日定时器——metaserver 一天部署不止一次时，每日 `setInterval` 永远等不到触发。

**选取**：`deletedAt <= now − ACCOUNT_DELETE_GRACE_MS` 且无 `purgedAt`，按 `deletedAt` 升序，每轮最多 50 个（`accounts.deletedAt` 有 partial 索引）。与 `restoreIfWithinGrace` 的 `now − deletedAt < GRACE` 严格互斥——被清除任务认领的账号不可能再被「重新登录恢复」。

**认领 / 续跑**：`findOneAndUpdate` 写 `purge.lockedUntil = now + 15min`（租约）+ `$inc purge.attempts`。每个服务确认完成后写 `purge.steps.<step> = ts`；重跑时跳过已确认的步骤。某步失败或返回 `done:false` → 立即停止（后面的步骤依赖前面的），`purge.lastError` 记原因，`lockedUntil = now + 30min` 作为退避，下一轮再试。**失败永不跳过**：某服务的内部 URL 没配置 = 该步失败，账号一直挂起（fail-closed，宁可卡住也不谎报「已清除」）。

**步骤顺序**（`ACCOUNT_PURGE_STEPS`，shared `accountDocs.ts`）与原因：

| 步 | 服务 | 做什么 | 为什么在这个位置 |
|---|---|---|---|
| social | socialsvc | 退出家族（族长→自动传位 / 独自一人→解散）、好友边（释放对方好友位）、好友申请、黑名单、私聊会话+消息、收件箱、自己发出的玩家邮件、家族消息、入族申请；**被举报的**举报单删除、**自己提交的**举报单保留但 `reporterId='deleted-account'` | worldsvc 要按 socialsvc 清除后的家族状态修门派 |
| world | worldsvc | 所有分服：行军/占领/驻军强制清空（含 Redis occ/cover）、被其争夺的地块解除争夺、其发起的攻城伤害、国家槽位 `$unset` 归属、门派/国家/旧家族频道消息、赛季榜单昵称置空、转服记录；门派对账（见下）；最后删地块+`playerWorld`、分服人口 −1 | 依赖 social 的家族结果；自身的 `playerWorld` 放最后删，重试时还能找到门派镜像 |
| auction | auctionsvc | 其无人出价的在售拍品直接关闭（`cancelled`+`settledAt`，物品不退回——退回也是退进一个即将被删的库存）；无挂起后删每日额度、出价记录、其已结算的历史挂单 | 可能返回 `done:false`：其挂单已有人出价、其是当前最高出价者、有未终结的交易日志行、有未结算的已关闭挂单——**对手方的币和物品绝不因此损失**，等正常到期结算后再清。必须在钱包删除前完成 |
| commercial | commercial | 删 `wallets`（月卡/年卡/首充/里程碑都在钱包文档上）、`gachaHistory`、`promoRedemptions`、`appleAccountTokens`、`appleConsumptionConsents`；**保留**交易记录（见下「留存」） | 等拍卖结算完成后才能删钱包 |
| analytics | analyticsvc | 删 `events`/`sessions`：`user_id` = 该账号；同设备上无 `user_id` 的登录前记录（设备号由 meta 传入，最多 20 个）；以及事件里带该账号的会话的匿名行 | 设备号只存在 meta 账号行上，必须在 meta 步骤之前 |
| meta | 本地 | 删 saves、pveStamina、卡牌/装备/皮肤/材料实例、各类幂等账本、replayShares、stateReplayShares、adsTokens、活动参与、天梯赛季快照、反馈、申诉、PvE 校验/拒绝、反作弊审核、旧 `mail`；`matches.players[]` 里该账号的 `displayName`/`publicId` 快照置空（对手的对局历史保留） | 账号行持有租约和设备号，最后处理 |

之后，每轮对本轮所有走完 meta 步骤的账号**统一扫一遍回放冷存档**（`replayArchive.ts scrubArchivedPlayers`）：抹掉 `<roomId>.meta.json` 里这些账号的昵称/publicId，保留 accountId（对手查看自己回放的鉴权还要用），并**恢复文件原 mtime**——365 天保留期按 mtime 计，直接改写会让清除反而把保留期重置。扫描失败则本轮不写墓碑，下一轮直接从这里续。

**墓碑**：`replaceOne` 成 `{ _id, createdAt, deletedAt, purgedAt }`——一次写入丢掉所有凭证（deviceId/openid/password/oauth）、昵称、publicId、flags；唯一稀疏索引随之释放，同一设备/邮箱可以注册新账号。保留墓碑而不是删行：JWT 有效期 30 天且会滑动续期，行被删掉时 `getOrCreateSave`/`ensurePublicId` 会为一个已清除的账号重新建出存档和 publicId。现在 `bearerAuth`（`metaserver/src/auth.ts`）对 `purgedAt` 已设的账号直接 410 `ACCOUNT_DELETED`（走 `accountCache` 的封禁状态缓存，热路径只是一次 Map 查询），且不再签发续期 token；**仅软删、未清除**的账号不拦——宽限期内 `POST /account/cancel-deletion` 需要可用的 token。

**领导角色**：
- **家族**（socialsvc）：普通成员直接退出。族长且还有其他成员 → 自动传位：优先已存在的 leader 行（崩溃重试时不会立第二个族长），其次长老，再次普通成员；同级按 `joinedAt` 最早、再按 `_id`。族长且独自一人 → 按 `dissolveFamily` 解散，并额外删入族申请（`dissolveFamily` 本身漏了这项）。理由：被删账号无法主动交接，`leaveFamily` 禁止族长退出，且系统里没有转让端点。
- **门派**（worldsvc）：候选门派 = 其 `playerWorld.sectId` 镜像 ∪ `leaderId` 为该账号的门派；一律以 socialsvc 为准重新计算（读 socialsvc 时绕过 10s 缓存，读失败直接报错重试——返回空列表会被误判为「门派已无家族」而解散）。门主家族仍在 → `leaderId` 更新为该家族现任族长（social 步骤可能刚传过位）；门主家族已解散 → 转给剩余家族中成员最多的（同数按 familyId 升序），无剩余家族 → 按 `dissolveSect` 解散（拆出公用 `tearDownSect`）。`memberFamilyCount` 每次按实际剩余家族数重算；换门主家族时丢弃 `removalVote`，否则只剔除已不在门派内的投票家族。

**留存（不删的部分）**：
- commercial `ledger`/`orders`/`recharges`/`paddleEvents`/`appleTransactionLinks`/`appleNotifications`：交易记录按税务/退款争议义务保留最小集。与身份解绑的方式：accountId 此时只是墓碑上的不透明 id，墓碑不含任何个人数据；`recharges.rawReceipt`、`paddleEvents.rawEvent` 置为空串（前者从无读取方，后者只给运维 Paddle 事件详情页用）。`appleTransactionLinks` 打 `accountPurgedAt` 标记：之后 Apple 的续订通知照常记录但不再发货（否则 `DID_RENEW` 会把已删的钱包重新建出来）；同一 Apple ID 的新账号恢复购买时清除该标记。**保留期限 = 10 个完整日历年，之后删除**（2026-09-29 拍板，对所有账号生效，不限已删除账号）：commercial `transactionRetention.ts` 每 6 小时清理创建时间早于「当前年 − 10 年的 1 月 1 日（UTC）」的记录——从记录所在年的年末起算，与 §147 AO / §257 HGB 的计法一致，而不是滚动的 now − 10y（后者最多会早删将近一年）。`appleTransactionLinks` 按 `updatedAt` 计，且该订阅在截止日之后没有任何 Apple 通知才删（`updatedAt` 只在购买/恢复购买时刷新，续订了十年以上的活跃订阅否则会丢路由）。
- worldsvc `sieges`（战报，30 天 TTL，只有 id）、对手针对其地块的攻城伤害行（地块没了之后由结算的失效目标分支取消并让对方部队返回）；meta 里他人反作弊记录中的 `judgeAccountId`；auctionsvc 已终结的交易日志（30 天 `purgeAt` TTL）、其仅作为买家出现的挂单；admin 库的审计日志/补偿单/交易审核单（运维问责记录，publicId 已随墓碑失效）。
- 其余本就有 TTL 的数据按原 TTL 过期；Mongo 备份最多保留 `NW_BACKUP_KEEP_DAYS`（默认 7 天，S3 副本的生命周期由存储桶策略决定）。

**令牌吊销表（2026-09-29，同日第二轮）**：worldsvc/socialsvc/auctionsvc/analyticsvc/gateway 只做无状态 JWT 验签、不连账号库，墓碑只挡得住 metaserver——一个在删除前泄露、还没过期的 token，原本能在这些服务里继续用最多 30 天，还能把刚清掉的数据重新建出来（新的 `playerWorld`、好友申请、带 `user_id` 的埋点）。现在：

- **表**：meta 库 `tokenRevocations`，`{ _id: accountId, revokedAt, reason: 'account_purged', expireAt }`，一个账号一行。清除任务**认领账号时、第一步之前**写入（`$setOnInsert`：重试不改 `revokedAt`，也不顺延过期）——不是等墓碑，因为各服务的清除步骤跑完之后、墓碑写下之前，泄露的 token 仍能往已清过的服务里写。
- **语义**：拒绝该账号 `iat × 1000 ≤ revokedAt` 的 token（秒精度，同一秒按「已吊销」算）；之后签发的不受影响，所以同一张表以后可以直接承载「退出所有设备」。
- **分发**：meta 内部端点 `GET /internal/auth/token-revocations?since=`（`SERVER_API_INTERNAL §15`）；各服务进程内的 `TokenRevocationList`（`shared/src/tokenRevocation.ts`）每 60 秒增量拉一次（`since` = 上次 `asOf` − 5 分钟重叠，吸收写入提交延迟和多实例时钟差），验签后查内存 Map，热路径零 I/O。meta 自己用同一个类，数据源直接读本库。选拉不选推：表很小，拉取方断线后下一轮自愈，不需要补发。
- **命中后**：metaserver/worldsvc/socialsvc/auctionsvc → 410 `ACCOUNT_DELETED`（shared `ERROR_HTTP_STATUS` 补了这个映射）；gateway WS 握手 → 4401（与过期 token 同码，客户端已把它当「重新登录」处理）；analyticsvc 不拒请求，按匿名入库、不挂 `user_id`。meta 对已吊销 token **不续期**，所以 token 最多比吊销晚 30 天失效。
- **过期**：`expireAt = revokedAt + 31 天`（token TTL 30 天，`signToken` 没有环境变量可改，+1 天余量），Mongo TTL 索引删行；各进程的内存表按同一窗口自行修剪。
- **失败模式**：进程启动后首次拉取成功前 fail-open（meta 暂时不可达时服务照常对外，而不是每个请求都硬依赖 meta）；之后拉取失败沿用上次的表。没配 meta 内部地址 → 启动时打一条 warn、不做检查（analyticsvc 为此新增 `NW_META_INTERNAL_URL`，gateway 复用 `NW_META_BASE_URL`）。
- **剩余窗口**：写入吊销行到各服务拉到它之间最多约 60 秒；清除任务的远程步骤就在同一轮紧接着执行，这 60 秒里泄露 token 的零星写入不会被回收。接受——前提是 token 已泄露**且**恰好落在这一分钟。

**测试**：metaserver `test/account-purge.e2e.test.ts`（宽限期边界、步骤顺序与参数、失败/挂起后从断点续跑、墓碑形态、冷存档 mtime、幂等、认领即写吊销行、内部端点）+ `test/account-deletion.test.ts`（已清除账号 / 已吊销 token → 410）；各服务 `test/accountPurge.e2e.test.ts`；吊销表：shared `test/tokenRevocation.test.ts`（iat 语义、fail-open、增量 since、修剪、HTTP 源）+ worldsvc/socialsvc/auctionsvc/analyticsvc `test/tokenRevocationHttp.test.ts` + gateway `test/tokenRevocation.test.ts`。

