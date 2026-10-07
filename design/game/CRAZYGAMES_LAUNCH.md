# CrazyGames 上架：官方要求 ↔ 我们的实现

> 状态：**2026-10-07 被拒**（理由只有一句「overall quality」，审核员轨迹见 §7）；2026-10-05 提交的构建是 `64c620eb`（来自提交 `b452aedf4`）；Basic Launch 代码侧 2026-09-27 完成 · 权威：本文（CrazyGames 专属要求的单一入口）
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
| 访客默认可玩、最多 1 次点击进游戏 | `IPlatform.silentAccountOnly`：CG 包**没有登录页**。启动 → 首次自动进新手关，**零点击**：2026-10-07 起 CG 包没有年龄+同意入口门（`IPlatform.entryNoticeOnly`，[`COMPLIANCE_GLOBAL.md` §3.3a](COMPLIANCE_GLOBAL.md)），条款与埋点提示改成大厅里的非阻塞通知条。开场故事不在首启播放（所有平台，[`ONBOARDING_DESIGN.md` §11.7](ONBOARDING_DESIGN.md)；原先的 `IPlatform.skipStoryIntro` 随之删除），所以不会多出第二次点击。 |
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

### 2.1 QA 预览里的半屏渲染（2026-10-05 修）

门户 QA 预览的 iframe 是 722×406。两次预览里新手关战斗和好友房都只画在左侧一窄条，切到前台也不恢复。两个成因，都在 `client/src`，都已修：

1. **预加载期间尺寸变化被丢掉**：`app.ts` 在资源预加载之后只比 safe-area insets 不比尺寸，而 viewport watcher 在预加载之后才装、以当时尺寸为基线 → 启动尺寸与最终尺寸不同时整局停在启动尺寸（画布也不 resize）。现在 `resettledLayout` 同时比尺寸，变了就 `renderer.resize` + 重算 layout。
2. **不可重建的屏（对局、房间、开场动画、SLG 地图）在尺寸变化后按新矩形缩放旧场景图**：现在 watcher 只 `scaling.refit()`（旧矩形 contain 进新视口），新 layout 在下一屏 `goto` 时生效。

3. **后台标签页启动时门户 iframe 报的是竖屏尺寸**（同日重新上传后复测发现）：修完 1、2 后，在后台标签页启动的预览不再被截断，但新手关仍是竖屏布局、居中缩在横屏框里——对局在标签页切到前台、iframe 拿到 722×406 之前就按竖屏建好了，而对局永不重建。修法：CG 构建的 `onLoadingComplete()` 在页面 `hidden` 时等到 `visible`，再等视口安静 300 ms（最长 1.5 s）才返回，首屏据此构建（`platform/web/visibleBoot.ts`）。前台启动零延迟。Loki 里同一构建的两条 crash 记录 `orient=landscape vp=723x361 / 720x361`，说明前台时游戏读到的尺寸是对的。

门户 iframe 是跨域的（`games.crazygames.com`），从外层页面读不到游戏自己启动时的 `innerWidth`，所以「启动时到底是多大」没有实测值；本机复现见 `UI_DESIGN.md` 安全区那一行。**重新上传构建后要在预览里再看一遍新手关和好友房。**

## 3. 没有充值时的玩家体验（`iapKind() === null`，CG 与微信共用）

金币是唯一付费货币，所有消费都能用免费金币完成，没有硬锁（不付费月入约 3.1k–8.9k，见 `ECONOMY_NUMBERS.md`）。
这次清掉的死路：

- **充值里程碑页签**：只在有支付渠道时出现（此前常驻「已充值 $0.00 / 未解锁」）。
- **大厅金币芯片**：没有支付渠道时是纯数字，不再是跳商店的按钮。
- **月卡续费提醒**：只在能续费的平台排程/弹出。
- **月卡每日领取**：别处买的月卡仍在有效期时，商店照常显示领取按钮（此前领取按钮嵌在「可购买」判断里，领不到自己付过钱的东西；也不再显示美元价格）。
- **体力不足**：没有支付渠道时提示「金币不足」，不再静默跳进商店。

~~兑换码入口只画在隐藏的金币页里，CG/微信上找不到~~——兑换码已于 2026-10-04 整体移除（ADR-108），奖励走邮件。

## 4. Full Launch 清单（Basic 评估期内做）

1. **账号集成**（✅ 2026-09-27 完成，分支 `feat/cg-account`）：
   - **用户名**：`/auth/crazygames` 每次登录用 token 里的 `username` 覆盖 `displayName`（截到 24 字，空的保留原名），同时写 `nameLockedBy='crazygames'`；`/profile/rename` 见到它一律 400（在扣费之前）。客户端：GET /save 返回 `nameLocked` → 设置页不给改名按钮。
   - **头像只用 CG 头像**（用户 2026-09-27 定）：通用「平台头像」机制，**头像 id 新增一种 `url:<https>`**，走现有的 avatarId 字段传给所有人（好友、家族、资料卡、PvP 对手的 `opponent_avatar_id`），协议/proto 一个字段都没加。
     - 服务端：账号行 `platformAvatarUrl`（只收白名单主机 `images.crazygames.com`，`shared/src/platformAvatar.ts`）；`getProfile` / `profileOf` / `profilesOf` 统一经 `effectiveAvatarId()`：有平台头像就是它，否则是装备的游戏头像。自己的头像由 GET /save 的 `platformAvatarId` 带回。
     - 客户端：`render/avatar.ts::buildAvatar` 认 `url:`——先画字母底、图片加载完再覆盖（加载失败就一直是字母）；**只在 `IPlatform.remoteAvatars` 为真的平台画**（现在只有 CG），网页/微信/原生看到 CG 玩家是字母头像，渲染行为不变。客户端再校验一次主机白名单（值来自别的玩家）。CG 头像服务器回 `Access-Control-Allow-Origin: *`，WebGL 纹理能直接用。有平台头像时设置页不开头像选择器。
     - 以后微信要接：它不能静默读头像（要玩家授权/自选），拿到后写同一个 `platformAvatarUrl`、白名单加主机、`WechatPlatform.remoteAvatars=true` 即可。
   - **访客登录 CG 后进度保留**：客户端在 `/auth/crazygames` 里带上当前会话 `guestToken`（只有这一种凭据会带）；服务端在该 CG `userId` 还没账号、且 guestToken 是纯设备访客时 `bindOAuth` 到这个访客号，否则走原来的 resolve-or-create（已有 CG 账号的人回自己的号，访客号不动）。
   - **游戏中途登录 CG**：`IPlatform.onPortalSignIn`（SDK `addAuthListener`）→ `resync()` 原地重新认证，**不跳场景**（对局中不会被踢回大厅），与设置页按钮共用同一个「最多一个在飞」的 resync。静默入口每次启动前先把存着的 token 交给 api，这样上次是访客、这次已登录 CG 的回访玩家也会被挂上。
   - **设置页「用 CrazyGames 登录」**：只给 CG 包里的访客（`!nameLocked`），提示「登录后进度跟着账号走」；只调门户自己的 `showAuthPrompt`，不是主按钮、不自动弹。显式登录会清掉之前的 `declinePortalIdentity`（否则服务端曾拒过一次后，按钮只会弹框然后照旧以设备身份登录——实测发现的）。
   - **验证**：metaserver 单测 10 例（绑定/已有号/有密码的号不绑/伪造 token/名字头像同步/白名单/改名拒绝/他人看到的头像）；客户端单测（guestToken 只随 CG 发、resync 去重、设置页三种状态、URL 白名单）；真 Chrome 里 CG 开发包：写入门户资料后设置页显示远程加载的 CG 头像、无改名、无账号区，访客态显示改名 + 「Sign in with CrazyGames」，点击后请求体带 `guestToken`。**本地后端没配 CG SSO，完整的「登录 → 挂号」链路要在门户 QA 工具里跑一遍。**
2. **多人**（✅ 2026-09-27 完成，分支 `feat/cg-account`）：接口是通用的 `IPlatform.rooms`（`PlatformRooms`）与 `IPlatform.watchChatDisabled`，**只有 `CrazyGamesPlatform` 实现**，网页/微信没有这两个字段，好友房和聊天行为不变。
   - **房间码不变**：我们仍用 6 位数字房间码；门户只以邀请参数 `room=<码>` 看到它（`platform/crazygames/crazyGamesRooms.ts`）。
   - **邀请链接**：房间页「复制」在 CG 上复制 `game.inviteLink({ room })`（门户游戏页链接，按钮改叫「复制链接」），网页/微信仍复制裸码。
   - **房间状态**：`room_state` 到达 → `updateRoom({ roomId: 码, isJoinable, inviteParams })`；可加入 = `WAITING` 且不满 2 人，可加入时 `showInviteButton`，否则 `hideInviteButton`。开局 → `isJoinable:false`；返回、加入失败、控制连接永久断开、对局结束或中途退出 → `leftRoom`。SDK 对 `updateRoom`/`leftRoom` 有 250 ms 节流且**超限直接抛错**，所以合并成「只发最新状态」、间隔 ≥ 300 ms，被节流就重试（最多 3 次）。
   - **从邀请启动**：启动 URL 带 `room=` → 加入该房；带 `instantJoin=true`（门户「和朋友玩」，即 SDK 的 `isInstantMultiplayer`）→ 直接建房。意图存进 `AppState.pendingRoomIntent`，**下一次有服务器连接的大厅入口**用它开房间页，**排在新手教程前面**（邀请人在房里等）；首次启动时静默登录还没回来就先显示大厅，登录完成那次大厅刷新再打开房间。进房后本局不再触发教程。非法房间码（不是 6 位数字）直接忽略。
   - **游戏中接受邀请**（`addJoinRoomListener`）：在房间页 → 关掉当前房、加入新房；在大厅 → 立即打开；在对局中 → **不打断对局**，记为待办，回到大厅时打开。
   - **连续对局**：结算页「再来一局」对友谊赛仍是回大厅（在游戏内，不回 CG 界面）；友谊赛结束后房间随对局结束，所以不做「同房再开」。
   - **CG 用户名**：见上一条账号集成（名字从门户同步、锁定）。
   - **`disableChat`**：`ui/chatPolicy.ts` 一个开关，开启后隐藏世界频道页签（和世界地图底栏的消息预览/未读数，底栏改显示「社交」、点进去落在好友页）、家族/国家频道（显示「聊天已关闭。」）、好友/家族成员资料卡上的「发消息」、好友页签上的私信未读数；`goChat` 本身也拦。好友、家族、国家、邮件照常。设置在运行中改变时，下一次重绘生效。
   - **验证**：`crazyGamesRooms.test.ts`（合并节流、邀请参数、leftRoom 只在告知过房间后发、节流重试、启动意图、加入监听）、`roomNav.test.ts` 平台房间 9 例、`lobbyRoomIntent.test.ts`（邀请优先于教程、未连上服务器时等待、resize 不消费）、`test/ui/chatDisabledSocialRail.ui.ts`。**门户侧的邀请按钮、个人页「加入」按钮要在门户 QA 工具里实测。**
3. **广告**：激励视频已按「完全可选、只在非战斗界面、只在 `adFinished` 发奖」实现。奖励仍以 `platform:'dev'` 提交，客户端可伪造，只靠冷却+每日上限——门户没有服务端回调，是取舍。
   - **看广告回体力**（✅ 2026-09-27，分支 `feat/cg-stop`）：关卡准备页体力不足时，「补充体力（金币）」旁边多一个「看广告 → +30」，每 UTC 日 3 次，当天用完按钮消失。开关是 `IPlatform.staminaRewardedAd`（只有 `CrazyGamesPlatform` 为真，iOS 壳的 AdMob 和微信都不出现）；服务端 `POST /pve/stamina/ad` 也只认 `x-nw-platform: crazygames`。数值见 ECONOMY_NUMBERS §3。顺带修了关卡准备页底部排版：原来的补充按钮压在「开战」按钮上（横屏最明显），现在「开战 → 补充行 → 体力行」自下而上排，补充行与开战按钮同宽。
4. **gameplayStop 缺口**（✅ 2026-09-27，分支 `feat/cg-stop`）：
   - **投降/退出关卡弹窗**会冻结对局，打开时 `gameplayStop`、取消时 `gameplayStart`；确认退出不再发 start（去向页面自己发 stop）。接线：`GameRendererCore.onPauseChange` → `GameSceneCallbacks.onPauseChange` → `PixiAppViews` 的 `withGameplayPause`（`showGame`/`showGameNet` 两个入口都包上，以后新增的对局入口自动覆盖）。
   - **回放不算 gameplay**：`goReplay`（结算页/战绩页）和分享回放 `goStatePlayer` 不再调 `gameplayStart`；进回放之前的页面都已发过 stop，所以战绩页看完回放返回时也不会停在「游戏中」。
   - 其他平台的 `onGameplayStart/Stop` 都是空实现，行为不变。
5. **内购**（受邀后）：Xsolla token（`user.getXsollaUserToken()`）、webhook、`analytics.trackOrder`；访客不能买；BE/NL/CN/RS/SK 禁售盲盒类，TW/KR/JP 另有公示要求；CG App 内（`applicationType` 为商店）禁用。

## 5. 不是代码的项

- **封面与预览视频**（美术）：封面三张 1920×1080 / 800×1200 / 800×800，预览视频横竖各一条 1080p、15–20 s、≤ 50 MB；
  规格与禁止项见 [`store-assets-checklist.md §4.1`](../product/release/store-assets-checklist.md)。现有的 1280×720 战斗截图不合格。

- 门户内容政策逐条核对（开发者后台）、[`acceptance-smoke.md`](release/acceptance-smoke.md) CrazyGames 列 9 行（门户 QA 工具里跑）。
- 封面 prompt 已出（[`crazygames-cover-art-prompts.md`](../product/crazygames-cover-art-prompts.md)，2026-09-28），用户 AI 出图；预览视频用户手机录。
- Atlas M0 升档、备份异地：**用户 2026-09-28 定：提审前不升，上线一天后看数据再决定。**
- `/pve/stamina/ad`：2026-09-28 核过线上已部署（`POST https://api.gamestao.com/api/pve/stamina/ad` 回 400 校验错，不是 404）。
- **2026-10-05 提交记录**（下次「Submit new version」照这份填）：
  - QA 页：Gameplay requirements / 全域名 / Browser checks / Friend invitation flows 四项由 Claude 实测后答 Yes（Edge 四种 iframe 尺寸启动无报错；
    两个新访客 A 建房、B 带 `?room=` 打开直接跳过新手关进房、双方开局同步）；Device checks: Mobile 用户真机测；
    「retains friends in a lobby at end of round」答 **No**；聊天答 with filter/moderation；disableChat 答 Yes。
    自动项「InviteLink functionality used」显示 Not detected——只有房间里点「Copy link」才会调 `inviteLink`，不是缺实现。
  - Details：Category **Strategy**；Tags **Tower Defense / 2 Player / Battle / War**（标签库里没有 Strategy）；
    Description = `store-assets-checklist §0.1b` 英文 App Store 稿去掉订阅段与 Apple EULA 链接、多人一句改为
    「or open a room and invite a friend」、末句改为「Card draws are random; the draw rates are published in-game on the odds page. Free to play.」；
    Controls = §4.1b 原文，`- ` 换成 `· `（Quill 编辑器会把 `- ` 自动转成列表）。
  - 门户坑：①QA 结果只活在点 Continue 弹出的那个 `qa-continue` 标签页里，预览页关早了或换新标签打开同一 URL 都会报「Failed to retrieve QA results」；
    ②封面/视频不能用脚本注入文件（控制台 `UploadType is not properly set`），必须手动拖；③Submit 前要先填 Billing，否则报「Error fetching payment details」。
  - 已提交构建里的小瑕疵：新手关「Skip tutorial »」文字比底板宽，821×462 下「»」被右缘截掉。
    **2026-10-05 已修**（`render/TutorialDirector/panels.ts::drawSkipButton`：先排字、底板宽度跟字走、从右缘向左长，
    封顶 `W*0.34`，超了用 `fitFont` 缩字号、不低于可读下限）；英/德 × 横/竖四种组合实测字都在底板内。
    **随下一次「Submit new version」上线**，已审核中的 `64c620eb` 不含此修复。
- **`NW_CRAZYGAMES_GAME_ID` 的值是 `133101`**（2026-10-05 核）：取自预览页 `__NEXT_DATA__` 的 `props.pageProps.game.id`。
  门户 URL 里的 `8f3d95b1-c884-4175-bb28-08728dae174d` 是 **`submission.id`**，不是 token 里的 `gameId`——
  官方 User 文档的 token 示例就是数字（`"gameId": "20267"`）。配错不会卡人（服务端拒 token → §2 回退设备访客），但等于没配。
- 生产环境 `NW_CRAZYGAMES_GAME_ID`：**2026-10-05 已配 `133101` 并实测通过**。流程：`sops set secrets/funny/prod.yaml` → `push-env.py funny prod funny-vps '~/funny/server/.env' --yes`（diff 只有这一个 key；备份 `.env.bak-20261005140500`）→ `docker compose -f docker-compose.cloud.yml --env-file .env up -d --no-build metaserver`。验证：容器 `printenv` 得 `133101`；假 token 从 `SSO not configured` 变成 `invalid or expired CrazyGames token`；门户预览（build `64c620eb`）里真 token 的 `POST /auth/crazygames -> 200`（签名 + `gameId` 都对上）。它只被 `/auth/crazygames` 读，对其他平台零影响。

## 6. 其余官方条目核对结果（2026-09-27 第二轮）

不需要改、但每条都对过代码的，免得下次再查一遍：

| 条目 | 结论 |
|---|---|
| 自定义全屏按钮禁止 | 全库没有 `requestFullscreen`。 |
| 别用 Esc / Ctrl+W 做操作、适配 AZERTY | 没有任何键盘操作（`WebAdapter` 只听 pointer 与 wheel）。 |
| 鼠标锁定（resources/mouse-control） | 点击为主的游戏不要求。 |
| 禁止应用商店链接、交叉推广 | 没有；唯一外链是隐私政策/用户协议（官方允许的例外）。 |
| 数据收集要有 T&C / 隐私告知 | 2026-10-07 起：大厅底部非阻塞通知条（条款 + 隐私链接；EU/美国时区附「允许 / 不用了」埋点提示），照 CG 的「simple notice rather than a pop-up」建议，见 [`COMPLIANCE_GLOBAL.md` §3.3a](COMPLIANCE_GLOBAL.md)。此前是首启阻塞弹窗 `EntryGateDialog`。 |
| Sitelock 白名单 | 没做 sitelock；服务端 CORS 是 `origin: true`，CG 网站与 App 的来源（`https://app.crazygames.com`、`capacitor://app.crazygames.com`）都放行。 |
| 不同刷新率下物理一致 | 30 Hz 定点 lockstep，与显示帧率无关。 |
| 桌面横屏可玩、DPR=1 可读 | 有横屏布局分支；门户在 iOS/低内存安卓上强制 DPR=1，这点要在门户 QA 工具里看一眼字清不清。 |
| UGC 审核 | 聊天与改名都走 `censorChat`，命中则拒绝改名。 |
| 可选：`happytime`、`reportGameCompletedPercentage`、`setGameContext` | 未接，都是可选。 |

Basic 期间的运营信息：更新**自动通过**；评估指标参考值——平均时长 10 分钟以上、次日留存 10–15%、玩满 1 分钟的转化 80% 以上；
累计 5 万次游玩后才有官方技术支持。

## 7. 2026-10-07 拒稿与审核员轨迹

**邮件原文要点**：Nivara: Notebook Wars 未通过，理由只有一句 overall quality does not yet meet the expectations of our platform，没有具体条目。

**审核员是谁**：后台查 2026-10-05 提交后到拒稿前的全部 CG 会话（analyticsvc `events` 的 `platform:'crazygames'`），按设备分组后，排除用户自测和我们自己的体检，只剩一条外部会话：

- 走 SSO 登录，`displayName` 为 `Testing2`，即门户 QA 号。metaserver `accounts` 里 `oauth.provider=crazygames`，所以 **SSO 首登在生产上实测通过**。
- 时间 2026-10-07 07:59 UTC，Windows Chrome 桌面，画布 1100×574。

**轨迹**：一共 **57 秒**，没打完新手关。

1. 在第 1 张讲解卡上停了 44.5 秒。
2. 第 2–7 张 1.2 秒内连点过去。
3. 放兵，约 3 秒做完。
4. 进入「Build a defense」，3 秒后关页。

逐事件时间表见 [`ONBOARDING_DESIGN.md` §11.1](ONBOARDING_DESIGN.md)。

他**没见过大厅、战役、结算页和 PvP**。所以判决落在「同意页 + 文字卡教学 + 前两拍」，重做方案在 ONBOARDING_DESIGN §11。§6 末尾引用的 Basic 参考指标里有一条「玩满 1 分钟的转化 80% 以上」，审核员恰好没撑过 60 秒。

**埋点缺口**：这条会话里没有 `load_time`，也没有 `gdpr_consent`，但存档里的同意标记已经是 true，说明 CG SSO 首登这条路丢掉了启动和同意页阶段的记录。**根因已查明并修复（2026-10-07）**：与 SSO 无关，是 `analytics.init()` 先挂上事件队列、后等采样配置，配置回来前点了同意，缓冲里的事件和 `gdpr_consent` 都被禁用兜底配置丢掉了——CG 包同意门是第一屏，QA 一秒内就点，正好落进这个窗口。详见 [`ANALYTICS_DESIGN.md` §3.6d](ANALYTICS_DESIGN.md)。

**入口门的处理**：CG 包从此不设入口门，条款改通知、埋点改非阻塞提示、没同意的人用匿名教学步计数——依据（CG 官方文档原文）与分区逻辑见 [`COMPLIANCE_GLOBAL.md` §3.3a](COMPLIANCE_GLOBAL.md)。

**同一次排查里体检出的其它问题**：
- 战役地图元素重叠；
- 结算页按钮被压住，DEFEAT 时仍发夸奖徽章；
- 手牌卡名压住插画。

审核员没有走到这些地方，它们不是这次被拒的直接原因，但重投前也要修，清单在会话记忆 `crazygames-rejection-audit-2026-10-07` 里。

### 7.1 体检问题修复（2026-10-07）

都在 722×406 门户画框下用真 Chrome 看过，回归测试在 `client/test/ui/reviewAuditFixes.ui.ts`。

| 问题 | 改法 |
|---|---|
| 战役地图：笔记本主人那行字压在 Back 上 | `CampaignMapScene/header.ts`：副标题中心夹在「Back 右缘 + 半宽」到「右侧按钮左缘 − 半宽」之间 |
| 战役地图：START 被第 1 关圆圈挡成 "STA" | `CampaignMapScene/drawing.ts`：START 改到旗杆上方 |
| 结算页：失败仍发夸奖徽章 | `computeBadges(stats, outcome)` 失败时返回空，只显示「Keep going!」；`badge_earned` 埋点同样不发 |
| 结算页：英文里用中文直角引号 | 新 i18n `result.badgeQuote`：en “…” / de „…“ / zh 「…」 |
| 结算页：徽章压在 PLAY AGAIN 下 | 徽章整块（主徽章 + 引语 + 次级徽章行）超出按钮上沿时，以顶部中点为基准等比缩小，最小 0.5 倍；有签到预览行时按它的上沿算。横屏原本让次级徽章行上提、与引语并排，现在只有引语宽度让得开图标时才上提（字体放大后引语会顶到图标上） |
| 结算页：战役失败没有 Retry | 战役失败时主按钮改成「RETRY」（回本关准备页），「BACK TO MAP」放进次级按钮行（`ResultSceneCallbacks.secondaryAction`） |
| 手牌：两词卡名折行压住插画 | `HandView/cellDraw.ts`：先不折行、按卡宽缩字；缩到下限仍放不下才折行；插画区底边跟着卡名上沿走 |
| 阵营只靠脚下淡色阴影区分；两座基地是同一张黑墨城堡 | 基地旗杆上加阵营色三角旗（`BoardView/bases.ts`，旗面朝棋盘中间）；单位脚下的阵营圈加一道阵营色描边（`UnitView/assets.ts`） |
| 墨不够时没有任何解释 | 一次性气泡提示，见 ONBOARDING_DESIGN §9 第 9 条 |

**复核后不用改的**：
- 「敌人从边框外排队走进来」：在当前 `ch1_lv1` 和新教学关里都没复现，刷怪点都在 12×18 棋盘内。
- 旧教学关的面板挡目标、Skip 压陨石圈、陨石只放倒 2 个：旧教学关已经整体重做（ONBOARDING_DESIGN §11），这几条随之作废。
- 「战役第 1 关一上来就输」：难度模拟器（`npx vitest run -c vitest.sim.config.ts test/difficulty/ch1`）显示新号打 `ch1_lv1` 胜率 100%，体检时输掉是我出牌的问题。但模拟器看到 `ch1_lv3` 新号胜率只有 40%（`ch1_lv4` 20%、`ch1_lv5` 0%），要到 T2 养成才稳过，这是一个难度断崖；平衡没动，待用户定。

**仍未处理（需要用户拍板，或者是几何级改动）**：
- 画风和字体混杂（卡通 / 火柴人 / 铅笔 / 精细黑墨；等宽 / 粗无衬线 / 衬线）。
- 722×406 下单位约 12px 高、正文约 8px。
- 大厅主按钮是 Ranked，新号第一局就打 PvP。
- CG 包的大厅通知条还没在浏览器里看过。

**查法**（只读）：
1. 在 analyticsvc 容器里查 `events`，按 `platform` + 时间窗筛选，再按 `device_id` 分组，逐条导出事件。
2. 拿 `user_id` 到 metaserver 容器查 `accounts`（看 `displayName`、`oauth`、`createdAt`）和 `saves`（看 `save.flags`）。
3. 查询脚本用完即删，连接串不要外传。
