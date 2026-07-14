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
  isAnonymous: boolean;              // 仅有 device、无可恢复凭证 → true
}
```

**索引**：`deviceId`(sparse,unique)、`openid`(sparse,unique)、`password.loginId`(sparse,unique)、`oauth.provider+oauth.sub`(unique)。

> `displayName` 注册/设备登录时可选，多数账号（尤其游客）从不主动设置。`getDisplayName`/`getProfile`（`accounts.ts`）读取时会懒惰回填一个随机默认昵称（`ensureDisplayName`，与 `ensurePublicId` 同一套模式），避免对战历史、房间玩家列表等处永久退化成显示裸 id。默认昵称由 `@nw/shared` 的 `randomPlayerName()` 生成：从 `playerNamePool.ts`（约 290 个真实玩家昵称，取样自 Hypixel/Minecraft 公开昵称数据集 `FlorianCassayre/nicknames-datasets`，CeCILL-B，经机器+人工清洗去数字垃圾/乱码/脏话/政治词）里随机取一个，约 1/6 概率追加短数字后缀（模拟真人重名加数字，绝大多数名字无数字）。因此游客与 botsvc 机器人（同走设备登录）在词汇、大小写、数字分布上都与真人玩家一致，无法一眼区分；刻意不含 Cadet/Recruit/Scholar 这类 NPC 词。matchsvc 匹配超时回退的 AI 对手名也用同一生成器。

> `isAnonymous`：只挂 device identity = true；一旦绑定 password/oauth/wx = false。联机/商店/充值要求 `isAnonymous=false`。

---

## 3. REST 端点（meta 请求面，扩展 §2.1）

> 完整契约同步进 `SERVER_API.md §2.1`。所有返回统一 `{ token, accountId, isNew, isAnonymous }`（沿用现有 AuthResult，加 `isAnonymous`）。

```
# 现有（保留）
POST /auth/device   { deviceId }                 → AuthResult   # 匿名设备，自动 upsert
POST /auth/wx       { code }                      → AuthResult   # 微信 code 换 openid

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

> JWT 仍由 meta 签（`shared/src/jwt.ts`，30d）。持久化 token 只是免去重输密码，过期/失效仍回登录。

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
> - **C4 + S4-4（2026-06-29 完整落地）**：`AccountDoc.flags.pveWarnings`（可疑次数）+ `flags.banned`（账号封号）；pveVerify rejected 路径原子递增 `$inc flags.pveWarnings`，首次写警告系统邮件（`insertSystemMail`），达 `PVE_REJECT_BAN_THRESHOLD` 设 `flags.banned=true` + save 层 `antiCheat.pveBanned=true`；**pveClear** 先执行 `rejectIfBanned`（`accounts.flags.banned`）再检查 `antiCheat.pveBanned`——管理员手动封号即时生效；**pveVerify** 开头读 save 层 `pveBanned`，命中则 403；auth 层（authWx/authDevice/authLogin/authOAuth）在签 token 前执行 `rejectIfBanned`；`GET /internal/suspicious-pve` + `POST /internal/accounts/:id/ban` + `POST /internal/accounts/:id/unban`（管理员手动封/解封，同步清除 save 层 `pveBanned`）→ admin 层 `POST /admin/accounts/:id/ban` + `unban`（需 `anticheat.action` 权限，super/ops 拥有）+ `GET /admin/suspicious-pve`（前端入口）；AuditAction 补 `account.ban`/`account.unban` 留痕。
> - **C5-a**：`GET /gacha/pools` 返回的每个 entry 新增 `probability = weight/totalWeight`（Apple 3.1.1 概率公示要求）。
> - **C5-b**：`DELETE /account` → 软删除 `accounts.deletedAt = now()`（Apple 5.1.1(v) 要求）；`rejectIfBanned` 同时检查 `deletedAt`，命中返 410 `ACCOUNT_DELETED`；7 天后由 admin/cron 异步清理数据。
> - **C5-c**：`POST /account/gdpr-consent` → 设 `accounts.flags.gdprConsent=true/false`；analyticsvc POST /analytics/events：已识别用户（有 JWT）且 `batch.consent !== true` 时静默丢弃（无 PII 的匿名请求不受约束）。
