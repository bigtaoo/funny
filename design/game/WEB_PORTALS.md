# 网页门户自测（itch.io / Newgrounds）

> 2026-10-17 立项。背景：CrazyGames Basic Launch 10-17 以 5/15 被拒（见 `CRAZYGAMES_LAUNCH.md`），
> 被拒的游戏只能当新游戏重投。在把游戏打磨到「自己觉得能过」之前，先用免费门户拿小样本真玩家数据，
> 每天十几个人也够看方向。

## 1. 目标与自测线

拿和 CG 同口径的数据（同一套匿名漏斗、会话时长、次留），对照下面这条线判断「能不能重投 CG」：

| 指标 | 自测线 | CG 10-17 实测（参考） |
|---|---|---|
| 桌面 `alive_60s / open` | ≥ 65% | 远低于 |
| 会话时长 | 中位 ≥ 5 min、均值 ≥ 8 min | 约 2 min 中位 |
| 新手关通关 | 开始教程的人 ≥ 50% 打过 ch1_lv3 | 大多卡在 lv1–2 |
| D1 回访 | ≥ 5% | ≈ 0 |

## 2. 构建形态

和 CrazyGames 构建同一形态：**访客直进、无登录页、无付费、无广告**，只是不带任何门户 SDK。

- 两个 webpack TARGET：`itch`、`newgrounds`。共用 `src/entries/portal.ts` 与 `public/portal/index.html`；
  TARGET 的值本身就是渠道名，打进 `globalThis.TARGET`，所以分析与服务端按渠道分开计数。
- 离源（off-origin）：包跑在门户自己的域名（`html.itch.zone`、`uploads.ungrounded.net`）下，
  生产构建烤入绝对后端地址（`https://api.gamestao.com`），和 CG 一样排除 Paddle 与五个网页付费/法务页面。
- 版本号：生产构建未设 `NW_BUILD_VERSION` 时用短 commit hash（与 CG 同规则）。
- `PortalPlatform`（`platform/portal/PortalPlatform.ts`）继承 `WebPlatform`，只改：
  - `silentAccountOnly` / `entryNoticeOnly` / `freePveStamina` = true（与 CG 一致的进入路径与免体力）；
  - `iapKind()` = null（商店充值入口全部隐藏）；
  - 语言顺序英文优先（`en, de, zh`）。
  - 无广告：继承的 `hasRewardedAd()` 在浏览器里本来就是 false。
- 法务链接走托管站绝对地址（`ConsentDialog.legalUrl`，门户域名下 `/privacy.html` 是 404）。

已知限制：回放分享链接指向当前 iframe 的地址（itch 是 `html.itch.zone/...`），能打开但不是商店页。样本期可接受。

## 3. 渠道打标

| 层 | 值来源 | 改动 |
|---|---|---|
| 预加载 open tick（HTML 内联） | `?p=<TARGET>` | 模板按 TARGET 注入 |
| 客户端事件 / 漏斗 / anomaly | `clientPlatformName()` | 统一到 `platform/clientPlatform.ts` |
| `X-NW-Platform` 请求头 | 同上 | 无（自动跟随） |
| 服务端允许名单 | `shared/src/webPortals.ts` 的 `WEB_PORTAL_PLATFORMS` | 并入 `SIGNUP_PLATFORMS`（留存按渠道分群）、`FLAG_PLATFORMS`、analyticsvc `BOOT_PLATFORMS` |
| PvE 免体力 | `PVE_STAMINA_FREE_CLIENT_PLATFORMS` | 由单值改为列表：crazygames + 门户 |

不在允许名单里的值会被记成 `unknown` 或忽略——所以**必须先部署服务端（analyticsvc + metaserver + admin），再上传门户包**，否则头几天的数据全落 `unknown`。

钱包分桶（`spendChannelOf`）对未知平台默认 `web`，门户包没有充值入口，不需要改。

## 4. 上传与发布

- 构建：`npm run build:itch` / `npm run build:newgrounds`（`client/`），把 `dist/` 整个打 zip。
  **zip 内路径必须是正斜杠**：Windows PowerShell 5.1 的 `Compress-Archive` 会写出 `static\xxx.png` 这种反斜杠路径，
  itch 解压后 `index.html` 能打开，但 `static/` 下全部 404，页面只剩一张空白纸（2026-10-17 首传时踩到）。
  用 Python `zipfile`（`arcname` 用 `/`）或 7-Zip 打包；上传前数一下包里的 `static\`，应为 0。
- itch 嵌入页里点 Run game 后游戏真正跑起来，才算上传完成。
- itch.io：Kind of project = HTML，勾 "This file will be played in the browser"，视口 1280×720，
  勾 Mobile friendly、Fullscreen button；定价 No payments。
- Newgrounds：Games 投稿上传 zip，尺寸同上，勾 Touchscreen friendly。编辑页自动保存（没有 Save 按钮），改完刷新一遍核对——
  宽度和 Commentary 第一次没存住，要真的在字段里打字再移走焦点才落盘；文件栏显示 "13B" 是显示问题，Preview 能跑就行。
  投稿协议要求：**用到 AI 必须在 Commentary 里写明用在哪、怎么用**（2026-10-17 已加 AI disclosure 段）；
  第三方追踪要开局告知并可退出（我们是自家分析，入口告知条 + 设置里可关）。发布后先进 "Under Judgment"，由玩家投票决定去留。
  2026-10-17 已发布：`https://www.newgrounds.com/portal/view/1057164`。
- 账号注册、上传、发帖由用户本人完成。上传包与商店页文案放在仓库根 `portal-uploads/`（`.git/info/exclude` 排除，不入库）。

## 5. 看数据

与 CG 同一套查询（`notebook_wars_analytics`）：`boots_daily` / `funnel_anon_daily` 按 `platform = itch | newgrounds` 过滤；
留存报表按 `signupPlatform` 分群。每周对一次 §1 的自测线。

- 生产只读查询：`ssh funny-vps`，`docker exec -w /app server-analyticsvc-1 node -e "<脚本>"`，脚本里用
  `process.env.NW_ANALYTICS_MONGO_URI` 连库（不要把连接串打印出来）。
- 2026-10-17 上线当天核对过：itch / newgrounds 两个渠道都正确落库（各 3 次 boot），另有 3 条 `unknown` 在 10:07–10:18 UTC，
  是渠道打标上线前的测试。itch 漏斗 `open 9 / loaded 2`，差值来自反斜杠 zip 那几次打开（资源 404，加载不起来）。
- **10-17 当天全部是自测流量**，对照自测线时从 2026-10-18 起算。
