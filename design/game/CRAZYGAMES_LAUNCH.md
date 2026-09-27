# CrazyGames 上架：官方要求 ↔ 我们的实现

> 状态：Basic Launch 代码侧已完成（2026-09-27，同日第二轮补门户静音/安全区/分享链接）· 权威：本文（CrazyGames 专属要求的单一入口）
> 来源：[docs.crazygames.com/requirements](https://docs.crazygames.com/requirements/intro/)（2026-09-27 逐页核过两轮：
> 要求 8 页 + SDK intro/game + resources 的 CrazyGames App / Basic Launch 指标 / 加载 / 鼠标四页）；
> SDK 行为以 `https://sdk.crazygames.com/crazygames-sdk-v3.js` 源码为准（文档页之外的细节都是在源码里查到的）。
> 相关：[`store-assets-checklist.md §4`](../product/release/store-assets-checklist.md)（商店素材与提审清单）、
> [`COMMERCIAL_DESIGN_IAP.md`](COMMERCIAL_DESIGN_IAP.md)（`iapKind()===null` 渠道）、
> [`RETENTION_LAUNCH_PLAN.md`](RETENTION_LAUNCH_PLAN.md)（留存目标与 SSO 的由来）。

## 1. 两档上线与时间窗

| | Basic Launch（首次提交默认走这档） | Full Launch |
|---|---|---|
| 变现 | **完全没有**：视频广告、横幅、内购全部关闭（SDK 内部 `launchFlow === 'basic'` 时 `requestAd` 直接回 `adError`，`prefetchAd` 抛 `adsDisabledBasicLaunch`） | 只能用平台 SDK 广告；内购**仅邀请制**，必须走平台的 Xsolla |
| SDK | 可选，只要求 `gameplayStart` | 全接：gameplay/loading、Data 或自有后端存档、User 模块账号集成 |
| 账号 | 访客默认直接玩；**禁止任何外部登录方式** | 以 CG `userId` 为身份、显示 CG 用户名/头像、老用户自动登录、**不许登出后换外部账号登录** |
| 多人 | — | `inviteLink` / `updateRoom` / 邀请参数；聊天必须响应 `disableChat`，至少脏词过滤 |

**时间窗**：Basic 至少上线 7 天且满 500 次游玩，最长 21 天；按平均游戏时长、进入游戏转化率、留存评估。
达标 → 被邀请做 Full；指标一般 → 可能允许改进后再 Basic 一次；不达标 → 只能作为新游戏重投。
**这 7–21 天就是做 §4 Full 清单的时间**，Full 的活不需要在 Basic 提交前做完。
（文档还提到「多人游戏可能跳过 Basic」——我们是多人游戏，提交时可以问平台，但不作为计划前提。）

## 2. Basic Launch：要求 → 实现（2026-09-27 完成）

| 要求 | 实现 |
|---|---|
| 访客默认可玩、最多 1 次点击进游戏 | `IPlatform.silentAccountOnly`：CG 包**没有登录页**。启动 → 年龄+同意合屏（唯一一次点击，`EntryGateDialog`）→ 大厅 → 首次自动进新手关。`IPlatform.skipStoryIntro` 跳过开场故事（它的「跳过」按钮会是第二次点击）。 |
| 禁止外部登录方式 | CG 包里账号密码登录/注册表单**不可达**：`goLogin()` 在 silentAccountOnly 平台上改为重跑静默入口；设置页与大厅不给登录/登出/删号入口；大厅离线态不画「登录」字样。 |
| 进度保存（Data 模块或自有后端） | 走自有后端：静默拿到的会话 token **写入 `TOKEN_KEY`**，于是所有「已登录」闸门（邮件/每日/排行/排位/大地图/拍卖/改名）把访客当真账号。身份优先级：门户已登录 → CG SSO；否则 → 匿名设备账号。 |
| 门户身份被服务端拒绝时 | `IPlatform.declinePortalIdentity()`：SSO 校验失败（本部署没配 `NW_CRAZYGAMES_GAME_ID`、换钥、坏 token）就本会话改用设备身份重试一次，**不能让门户玩家落到「没有账号」**。本地 dev 服务器就是这个场景：SDK 本地模式会给一个演示 CG token。 |
| token 失效 | `forceLogout` 在 silentAccountOnly 平台上不弹「请重新登录」，直接清 token 重跑静默入口（不走 `doLogout`：它的存档清空是给「换账号」用的，且延迟的 `setToken(null)` 会和新 token 赛跑）。 |
| 英文本地化 + 用 SDK 语言 | `getLanguage()` 先读 `SDK.user.systemInfo.locale`；`supportedLocales` 改为 `['en','de','zh']`，不认识的语言回退**英文**（此前回退中文）。 |
| 无广告 | 同一个包自动判断：`probeAds()` 在 init 后调 `prefetchAd('midgame')`，捕获 `adsDisabledBasicLaunch` → `hasRewardedAd()` 为 false（每日页「看广告」页签消失），结算页不再请求插屏。**升到 Full 不需要重新打包改开关。** |
| 加载事件 | 改用 v3 的 `game.loadingStart()/loadingStop()`。此前调用的 `sdkGameLoadingStart/Stop` 是 v2 名字，v3 里只作为内部 postMessage 类型存在，`?.` 让它一直静默 no-op——旧测试 stub 的也是 v2 名字，所以一直是绿的。 |
| 手机：禁文字选中 | `public/crazygames/index.html`：`html, body, canvas` 上 `user-select:none` + `-webkit-touch-callout:none`（可编辑元素不受影响）。 |
| 只用相对路径 | 模板里 favicon 改相对路径，去掉 manifest / apple-touch（iframe 内无意义，且根绝对路径在门户子路径下 404）。 |
| iOS 音频在手势中 resume | `WebAudioBus` 手势监听补上 `pointerup/touchend/click`（iOS 只认触摸结束为用户激活）。web 包同样受益。 |
| 门户静音设置 | SDK game 模块：`game.settings.muteAudio` 为真时**必须静音，且优先于游戏内开关**。`watchPortalMute()` 在 init 后读一次、再挂 `addSettingsChangeListener` 跟随。静音有两个互不相干的原因（广告在播 / 门户静音），共用 `setAudioSuspended` 这一个开关，所以平台里各记一个布尔、取「或」（`syncAudio()`）：广告结束不能解开门户静音，门户在广告中途解除静音也不能让声音盖在广告上。不写盘、不改玩家自己的静音。 |
| CG App 安全区 | resources/crazygames-app：App 里游戏全屏贴边，刘海/圆角会挡 UI。CG 平台现在和 web 一样实现 `getSafeAreaInsets` / `onSafeAreaInsetsChanged`（复用 `platform/web/safeAreaProbe.ts`），模板加 `viewport-fit=cover`（不加它 `env()` 永远是 0）。网站 iframe 里读数仍是 0，布局不变。**只有单测覆盖**：本地模拟不出 App 的贴边环境，要在 App 里真机看一次。 |
| 分享链接不能指向门户外 | `shareReplay` 此前用 `window.location` 拼链接——在门户里那是 **iframe 自己的游戏文件地址**，别人点开是门户外的裸游戏。现在门户上用 `game.inviteLink({ r })` 生成门户游戏页链接（实测形如 `/game/<slug>?czy_invite=…&utm_source=…&r=<code>`），门户把 query 透传进 iframe，`getLaunchShareCode()` 照旧读 `r`；无 SDK（本地 dev）才退回页面 URL。 |
| 包体 | 25 MB / 358 文件（上限 250 MB / 1500）。**首包实测 5.4 MB 到首帧、5.6 MB 进新手关**（生产构建、全新访客，2026-09-27），远低于手机首页要求的 20 MB 与 Basic 指南建议值，无需调整。 |

## 3. 没有充值时的玩家体验（`iapKind() === null`，CG 与微信共用）

金币是唯一付费货币，所有消费都能用免费金币完成，没有硬锁（不付费月入约 3.1k–8.9k，见 `ECONOMY_NUMBERS.md`）。
这次清掉的死路：

- **充值里程碑页签**：只在有支付渠道时出现（此前常驻「已充值 $0.00 / 未解锁」）。
- **大厅金币芯片**：没有支付渠道时是纯数字，不再是跳商店的按钮。
- **月卡续费提醒**：只在能续费的平台排程/弹出。
- **月卡每日领取**：别处买的月卡仍在有效期时，商店照常显示领取按钮（此前领取按钮嵌在「可购买」判断里，领不到自己付过钱的东西；也不再显示美元价格）。
- **体力不足**：没有支付渠道时提示「金币不足」，不再静默跳进商店。

**仍未做**：兑换码入口只画在隐藏的金币页里，CG/微信上找不到——需要时挪到设置页。

## 4. Full Launch 清单（Basic 评估期内做）

1. **账号集成**：
   - CG `username` 替代随机名池（服务端 `/auth/crazygames` 目前只取 `userId`），每次登录都同步；CG 包禁改名。
   - **头像只用 CG 头像**（用户 2026-09-27 定）：做成通用的「平台头像」机制——账号带一个平台头像地址，所有画头像的地方走同一个入口，有平台头像就画它、没有才用游戏自带头像。这次只有 CG 写入；其他平台不写就不变。微信规则不同（不能静默读头像，要玩家授权/自选），以后单独接。
   - 访客后来登录 CG：用 `addAuthListener` 接住游戏中途的登录，重跑静默入口；服务端在该 CG `userId` 首次出现且客户端当前是设备访客时，**把 CG 身份挂到这个访客账号上**（进度原样保留），已有账号则切过去。
   - 不能只靠本地数据认访客（官方原话）：设备 id 在本地存储里，清了就丢。设置页加一行「用 CrazyGames 登录以保存进度」（只调 `showAuthPrompt`，不做主按钮、不自动弹）。
2. **多人**：好友房接 `inviteLink` / `updateRoom` / `leftRoom` / 邀请参数 / `addJoinRoomListener`；`isInstantMultiplayer` 时启动直接进多人；连续对局不回 CG 界面；显示 CG 用户名；聊天（好友/家族/国家频道）响应 `disableChat`（服务端已有脏词过滤 `server/shared/src/chatFilter.ts`，改名也过同一套过滤）。
3. **广告**：激励视频已按「完全可选、只在非战斗界面、只在 `adFinished` 发奖」实现；考虑补「看广告回体力」（设计里有，未实现）。奖励仍以 `platform:'dev'` 提交，客户端可伪造，只靠冷却+每日上限——门户没有服务端回调，是取舍。
4. **gameplayStop 缺口**：投降弹窗暂停、从战绩页看回放返回时没有 stop；回放被算作 gameplay。
5. **内购**（受邀后）：Xsolla token（`user.getXsollaUserToken()`）、webhook、`analytics.trackOrder`；访客不能买；BE/NL/CN/RS/SK 禁售盲盒类，TW/KR/JP 另有公示要求；CG App 内（`applicationType` 为商店）禁用。

## 5. 不是代码的项

- **封面与预览视频**（美术）：封面三张 1920×1080 / 800×1200 / 800×800，预览视频横竖各一条 1080p、15–20 s、≤ 50 MB；
  规格与禁止项见 [`store-assets-checklist.md §4.1`](../product/release/store-assets-checklist.md)。现有的 1280×720 战斗截图不合格。

- 门户内容政策逐条核对（开发者后台）、[`acceptance-smoke.md`](release/acceptance-smoke.md) CrazyGames 列 9 行（门户 QA 工具里跑）。
- 上线前：Atlas M0 升档、备份异地（均为 2026-07 起挂着的决定）。
- 生产环境是否配置了 `NW_CRAZYGAMES_GAME_ID`：没配也不会卡死玩家（§2 回退），但门户玩家都会变成设备访客。

## 6. 其余官方条目核对结果（2026-09-27 第二轮）

不需要改、但每条都对过代码的，免得下次再查一遍：

| 条目 | 结论 |
|---|---|
| 自定义全屏按钮禁止 | 全库没有 `requestFullscreen`。 |
| 别用 Esc / Ctrl+W 做操作、适配 AZERTY | 没有任何键盘操作（`WebAdapter` 只听 pointer 与 wheel）。 |
| 鼠标锁定（resources/mouse-control） | 点击为主的游戏不要求。 |
| 禁止应用商店链接、交叉推广 | 没有；唯一外链是隐私政策/用户协议（官方允许的例外）。 |
| 数据收集要有 T&C / 隐私告知 | 首启同意弹窗（`EntryGateDialog`）。 |
| Sitelock 白名单 | 没做 sitelock；服务端 CORS 是 `origin: true`，CG 网站与 App 的来源（`https://app.crazygames.com`、`capacitor://app.crazygames.com`）都放行。 |
| 不同刷新率下物理一致 | 30 Hz 定点 lockstep，与显示帧率无关。 |
| 桌面横屏可玩、DPR=1 可读 | 有横屏布局分支；门户在 iOS/低内存安卓上强制 DPR=1，这点要在门户 QA 工具里看一眼字清不清。 |
| UGC 审核 | 聊天与改名都走 `censorChat`，命中则拒绝改名。 |
| 可选：`happytime`、`reportGameCompletedPercentage`、`setGameContext` | 未接，都是可选。 |

Basic 期间的运营信息：更新**自动通过**；评估指标参考值——平均时长 10 分钟以上、次日留存 10–15%、玩满 1 分钟的转化 80% 以上；
累计 5 万次游玩后才有官方技术支持。
