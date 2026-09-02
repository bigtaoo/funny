# Notebook Wars — 音频系统设计

> 状态：**§7 的七步全部完成。** 战斗 + UI 触发点都已接，设置页有三档音量与静音；五轮实测都已做完（§0.1 战斗 / §0.2 UI / §0.3 微信 / §0.4 素材 / §0.5 BGM）；素材第一批已发货（10 个 cue 共 22 个样本，8 个 cue 刻意保留合成音，全部 CC0、无需署名）；**BGM 已发货（§7 第 7 步 ✅）——一条轨 `bgm.lobby`，74 秒循环、两个 deck 等功率交叉淡入、频带电平 −29 dBFS、失焦暂停 + ducking**。开放项四个：`bgm.battle` 缺 master、微信真机、**还没有人听过任何一个声音**、ducking 未在真实 stinger 下听过（2026-09-01）· 权威：本文（音频**系统**的单一入口）· 更新：2026-09-01
>
> **权威边界**：音频**美学方向**（音色取向、禁用清单）仍归 [`../product/art-direction.md`](../product/art-direction.md) §声音；本文拥有**系统实现**——资产清单与命名、触发表、播放层抽象、混音、设置项、平台约束。两者不重述对方。

---

## 0. 落地状态（2026-09-01）

§7 **七步全部完成**：平台接缝 + cue 目录 + 程序化合成音 + 样本加载/解码/并发上限/混音器 + 战斗触发点 + UI 触发点 + 设置页音量 + 微信后端 + 素材第一批 + **BGM**，五轮实测（§0.1 战斗 / §0.2 UI / §0.3 微信 / §0.4 素材 / §0.5 BGM）都已做完。开放项四个：`bgm.battle` 缺 master（§2.3）、微信真机（§0.3 末尾）、**还没有人听过任何一个声音**（§0.5 末尾）、ducking 未在真实 stinger 下听过。

**已存在的模块**（`client/src/audio/`，平台中立，无 PIXI 依赖）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `AudioCue` 词汇表（18 个）+ `AudioBus` 接口 |
| `cueCatalogue.ts` | 每个 cue 的 gain / priority（混音的单一来源） |
| `cueAssets.ts` | cue → 已发货文件 URL。**全仓库唯一持有音频 `import` 的文件**。2026-09-01 起有 10 个 cue / 22 个 variant（§0.4） |
| `audioSynth.ts` | 每个 cue 一把程序化合成音（文具拟音，见 §1）+ `tone`/`noise` 两个原语 |
| `decodeAudio.ts` | 归一 `decodeAudioData` 的 promise / callback 两种形状 |
| `SampleBank.ts` | 走 `assets/assetIO.ts` 拉字节 + 解码，逐文件尽力而为 |
| `VoiceBudget.ts` | 并发上限，按优先级抢占（对 §5 的一处改判，见那一节） |
| `CueMixer.ts` | 两级阶梯：有样本用样本，没有用合成音；合并增益、variant 不重复、±3% 音高抖动 |
| `audioBus.ts` | 模块级接缝（`setAudioBus`/`audioBus`/`playSfx`）+ `NullAudioBus` |
| `audioSettings.ts` | 三档音量 + 静音的持久化与换算（§4）。**2026-08-31 新增** |
| `musicCatalogue.ts` | BGM 轨目录（`path` + `lengthS` + `gain`）+ `XFADE_S` + `DUCK_CUES` + `DEFAULT_TRACK`。**持有 BGM 的 `import`**。**2026-09-01 新增** |
| `MusicPlayer.ts` | 两个长期存活的 deck，**一条等功率包络同时服务循环回绕和换轨**；ducking；失焦 hold。回绕时刻**读**自 deck 自己的 `position()`，不数时钟。**2026-09-01 新增** |

**后端**：`client/src/platform/web/WebAudioBus.ts`（`AudioContext` + SFX 总线 GainNode）+ `platform/wechat/WechatAudioBus.ts`；音乐各自多一个 deck 实现（`webMusicDeck.ts` = `Audio` 元素经 `MediaElementSource` 进自己的 `GainNode`；`wechatMusicDeck.ts` = `InnerAudioContext`）。装在 `entries/{web,crazygames,mobile,web-e2e,wechat}.ts`，**四个入口一行没改**——它们装的后端本来就都是 `ContextAudioBus`。

**战斗触发点（2026-08-31 新增）**：`render/GameRenderer/events.ts` 的 `EventsPanel.collectCue` 是引擎事件 → cue 的**单一映射表**，`GameRendererCore.update()` 在排完 `state.events` 之后调一次 `flushAudio()`。映射如下（完整理由写在代码里）：

| 引擎事件 | cue | 说明 |
|---|---|---|
| `card_played` | `sfx.card.play` | 不分敌我——听见对手落笔是信息 |
| `unit_attack_start` / `projectile_fired` | `sfx.unit.attack` | 近战只在**进入**交战时响一声（引擎没有“每一刀”事件，而为音效往 `@nw/engine` 加一个违反§6 红线）；远程每支箭一声，含箭塔 |
| `unit_attack_hit` | `sfx.unit.hit` | 含建筑/护送目标；溅射/穿透一帧多发，靠合并计数 |
| `base_hp_changed` | `sfx.base.hit` | 两侧基地都响（裂痕 VFX 本来就两侧都放；红暗角仍只给本地） |
| `spell_cast` | `sfx.spell.cast` | |
| `unit_died` / `building_destroyed` / `escort_died` | `sfx.unit.death` | 词汇表里没有单独的建筑/护送死亡 cue，而塔倒下没声音读起来像丢帧 |
| `resource_changed` | `sfx.ink.tick` | 仅本地、仅上升沿，且**每 10 点墨才滴一下**（`INK_TICK_STEP`，理由见下面的实测） |
| `game_over` | `sfx.result.victory` / `.defeat` | 写在已有的 `gameEnded` 一次性门**内部** |
| `game_draw` | `sfx.result.draw` | **2026-08-31 补上**（原先无声）。平局既不是胜也不是负，另外两个 stinger 哪个都是误报，所以它必须有自己的 cue。合成音是**同一个音重复两次、音高不动**——胜是三音上行、负是二音下行，方向就是那两个 stinger 携带的全部信息，而平局要说的恰恰是「没有方向」。与胜负同写在一次性门**内部** |
| `card_invalid`（不存在） | `sfx.card.invalid` | **还没有声音**：非法出牌是客户端判的（`input.ts` 直接拒掉），引擎不发事件——属于§7 第 4 步的 UI 侧 |

补充两个不在事件漏斗里的口子：`GameRendererCore.forceTutorialVictory()`（新手引导毕业的脚本胜利，引擎从不发 `game_over`）走 `EventsPanel.playResultStinger()`，好让战斗场景里的所有音频决策仍然只住在 `events.ts` 一个文件里。

**同帧合并**（§4）落地为 `Map<AudioCue, number>`：一帧内重复的 cue 只发一次 `playSfx(cue, count)`，抬增益而不重播。实测一局里 `sfx.unit.attack` 15 次调用承载 28 个事件（单帧最多合并 5 个）、`sfx.unit.hit` 48/53。

**UI 触发点（2026-08-31 新增，§7 第 4 步）**：这一步的**大头不是接线，是先把可点区域收敛掉**。本仓库没有按钮基类——40 个场景各自维护一张扁平的矩形命中表、各自做包含判定，其中 **22 处重复声明了 `interface Hit`**，另有十几处内联成 `hitRects: { rect; action }[]`（形状一模一样，只是回调叫 `action` 不叫 `fn`）。在那个世界里给「按钮响一声」接线，等于往几百个 `fn()` 调用点各塞一行 `playSfx`——一份注定漏接、注定腐烂的重复。

所以顺序反过来：新增 `client/src/ui/hits.ts`，把类型和派发都收到一处，`action` 统一改名 `fn`，**22 份重复的 `interface Hit` 全部消失**（`grep 'interface Hit' src/` 现在只命中 `ui/hits.ts` 自己）。于是 UI cue 只剩一个调用点 `runHit`，而「这个按钮该响什么」退化成 `fn` 旁边一个可选字段：

| 写法 | 含义 |
|---|---|
| 省略 `sound` | `sfx.ui.tap`。**默认值而不是必填项**——绝大多数按钮就是一次普通点击，让每个 push 点都写一遍只会让漏写的那几个看起来像刻意的决定 |
| `sound: 'sfx.ui.back'` | 返回/关闭。全部 27 处 `hdr.backRect`、模态的全屏 dismiss 遮罩、confirm/emblem 对话框的 Cancel、战斗投降确认的取消 |
| `sound: 'sfx.ui.reward'` | 领奖：成就 / 日常 / 周常 / 活动 / 战令双轨 / 充值里程碑的 claim 按钮 |
| `sound: null` | 静音，用于「这个矩形不是按钮」（只为吃掉穿透的透明遮挡层）。目前没有使用者，是留给它们的逃生口 |

三个派发入口对应三种真实存在的手势语义，不是三种写法：`dispatchHit`（按下即触发）、`hitTest`+`runHit`（命中和触发之间还要做别的事——滚动空间换算、模态层次、owner 归属）、`hitAction`（把命中包成闭包交给 `ScrollTapGesture`，pointer-up 时才决定是点击还是拖动；**cue 跟着闭包走，所以拖动被丢弃时不会错响**）。

**滑杆不是 hit**：音量条和喂卡数量条必须跟手，各自留在 `{ rect, onDrag }` 的表里——`hitTest` 的泛型因此只约束 `{ rect }`，让它们共用同一份包含判定却不经过 `runHit`。

另外三个 cue **刻意不走命中表**，因为它们不是「某次点击」：

| cue | 出口 | 为什么不在 hit 上 |
|---|---|---|
| `sfx.ui.error` | `net/log.ts` 的 `showToastMessage`（仅 `kind === 'error'`） | 失败来自异步结果——「币不够」「网络超时」「已经领过了」往往在按钮按下几秒后才回来。这个函数是所有失败已经必经的收口，逐个触发点加 cue 是几十行注定漏掉下一条路径的重复。`success` 一档故意不响：它太常见且多半无关紧要（「设置已保存」），而 `sfx.ui.reward` 被留给了真的拿到东西的地方 |
| `sfx.card.invalid` | `render/GameRenderer/input.ts` 的 `rejectPlay` | **词汇表里唯一没有引擎事件的战斗 cue**（上一轮留下的口子）：非法出牌是客户端判的，`@nw/engine` 从不知道玩家试过——给它加一个「你刚才干了件非法的事」事件，等于把表现层的关注点塞进确定性模拟（§6 红线）。覆盖三类：按了买不起的牌、把牌放到不是攻击列的格子、升级按钮画着可用但当下不够钱。每次按压最多响一次（三个调用点都在已经消费掉手势的路径上），所以连按买不起的牌是一次一声，不是每帧一声 |
| `sfx.ui.gacha.reveal.{common,rare,epic}` | `GachaScene/core.ts` 的 `revealCue(results)` | 抽卡结果不是点击，是网络返回。**一次抽一声，按这一抽里最好的稀有度**——十连是一帧铺开十张卡的一把扇形，十声会糊成一团、且最响的那个取决于谁最后播，正好与分层的意图相反。`legendary` 并入 epic 那一档（词汇表止于「史诗+」，而传说本来就有自己的拖尾特效在承担强调） |

**战斗 HUD 也一并收敛了**：投降/升级/换牌/头像四个按钮原本是 `handleDown` 里一串手写的 `overRect` if 链，现在是一张就地构造的 `Hit[]` + 一次 `dispatchHit`（顺序与旧 if 链逐条一致，`hitTest` 先 push 先赢所以优先级不变）。世界地图的 HUD（`WorldMapInput/headerButtons.ts` 的九个按钮）同理。

> **⚠️ 第一遍收工太早了，漏掉一整族按钮（当天复查时发现）。** 上面这一整套只覆盖「自己维护矩形表」的场景。本仓库还有**第二种**按钮：直接是 PIXI 显示对象、自带 `eventMode = 'static'` + `on('pointertap', …)`，**根本没有命中表**——`ResultScene`（结算页的主 CTA、次级按钮、返回芯片、对手资料行）、`ReplayScene`、`StatePlayerScene`，以及五个模态对话框（`AppealDialog` / `ConsentDialog` / `FeedbackDialog` / `ProfilePopup` / `ReconnectPromptDialog`）。一共 22 处，第一遍**全部是哑的**——其中最刺眼的是结算页：胜负 stinger 刚响完，玩家落到的那一屏，每个按钮都不出声。
>
> 补法是 `ui/hits.ts` 再导出一个 `tapHandler(fn, sound?)`：返回一个包好的监听器，内部仍然走 `runHit`，所以「哪个 cue」还是一处决策。用法 `node.on('pointertap', tapHandler(fn))` / `tapHandler(fn, 'sfx.ui.back')`。

> **⚠️⚠️ 补完第二族之后再扫一遍，又冒出第三族——而且是游戏的主界面。** `LobbyScene` 既没有命中表、也没有 PIXI 监听：它把**十八个**按钮（开始对战 / 战役 / 世界 / 日常 / 活动 / 邮件 / 反馈 / 拍卖 / 头像芯片 / 金币 / 段位 / 底栏五格 / 成就 toast…）写成一串手工 `if (x >= rect.x && x <= rect.x + rect.w && …) { …; return; }`。前两遍的排查各自只看了自己那一族的特征（`hits` 字段、`on('pointertap'`），**这一族两个特征都不具备**，所以两次都从它旁边走过去了。同类的还有 `TutorialDirector` 的三个按钮、`IntroScene`/`IllustratedInterludeScene`/`LevelPrepScene` 的 Skip、世界地图队伍行的三个动作按钮。
>
> 三族现在都收敛了：大厅那条 18 分支链变成一张就地 `Hit[]` + 一次 `dispatchHit`（push 顺序即旧链顺序，`hitTest` 先 push 先赢，优先级逐条不变；`w <= 0` 的槽位照旧不入表）。顺带删掉了五份各自手抄的私有 `inRect`/`overRect`/`hit()`。
>
> **教训写在这里，因为它比这次的代码更值钱**：「UI 触发点接完了吗」这个问题，前两次我都是**按已知的机制去数**（命中表数完了 → 完了；`pointertap` 数完了 → 完了），而正确的问法是**按玩家能点到的东西去数**。两次漏的都不是某个按钮，是一整类**我没意识到存在的输入机制**。
>
> **这类漏接对所有其它测试都是隐形的**：按钮照样渲染、照样命中、回调照样触发，唯一的症状是「游戏变安静了」，而这只有人坐下来玩才会注意到。所以配了源码扫描守卫 `client/test/uiTapSoundCoverage.test.ts`（形状同 `pageBakeCallSites.test.ts`），**四条断言正好对着这三族 + 一个类型口子**：
>
> | 扫什么 | 挡住哪一族 |
> |---|---|
> | `on\|once` × `pointertap\|pointerdown\|pointerup`，未包 `tapHandler` 即红 | 第二族（PIXI 原生）。allowlist 目前一条：`ResultScene` 尾声故事的全屏「点击继续」——翻页不是按钮 |
> | **手写矩形包含判定**（`x >= r.x && x <= r.x + r.w`）出现在 `ui/hits.ts` 之外即红 | 第三族（手工 if 链）。allowlist 四条，全是滚动空间换算或视口判定，各自带理由 |
> | 绕过 `runHit` 直接 `playSfx('sfx.ui.*')` 即红 | 「就地响一声」的捷径。**四个**合法出口在 allowlist 里各带理由（第四个是 §0.2 (B) 加的滑杆松手试听） |
> | 再声明一份 `interface Hit`/`ModalHit`/`LocalHit` 即红 | 第 23 份重复声明（别名 `type Hit = BaseHit<boolean>` 不算，那仍指向 `ui/hits.ts`） |
>
> 四条**全部做了变异验证**：各自注入一次对应的回归（拆掉一个 `tapHandler`、往大厅塞回一段手写包含判定、加一处直接 `playSfx`、加一份 `interface ModalHit`），确认都会红。写这一段的时候第三条当场抓到了我自己——大厅的两处遮罩消除我图省事写成了裸 `playSfx('sfx.ui.back')`。

**设置页（§4）**：`SettingsScene` 右栏加了一块音量区——三根滑杆（master / bgm / sfx）+ 一个静音开关，落在 `scenes/SettingsScene/audioPanel.ts`。**位置在 §0.2 (D) 被订正过一次**（原先撞在贯穿整宽的语言按钮行上，把 Deutsch 按钮吃掉一半，且是静默吃掉），现在是 `x0 = 0.60w` / `titleY = 0.30h`，由 `test/ui/settingsSliderOverlap.ui.ts` 守着。**master / sfx 两根滑杆松手时会试听一声 `sfx.ui.tap`**（§0.2 (B)：不试听的话它是一根完全盲的控件），bgm 那根保持静音。持久化走 `audio/audioSettings.ts`：一个 JSON 键 `nw_audio`，与 `nw_locale` / `nw_data_saver` 同级的**本地设置，不上云**（纯体验项，无防作弊价值，一次 `PUT /flags` 换不来任何东西）。形状抄 `assets/prefetchPolicy.ts`（`installAudioSettings({storage})` 在 `app.ts` 装一次），所以没装的环境（单元测试、headless）读到默认值、写入被丢掉，而不是抛错。**静音不清零滑杆**：`muted` 是独立于三个音量的覆盖，取消静音会回到玩家自己调的档位，而不是把他留在最底下。BGM 那根滑杆接的是 `setMusicVolume`，**2026-09-01 起它真的驱动一条床**；在那之前它接受并忽略——接上它是因为「设置里有个滑杆但拖了没反应」和「设置里没这一项」是两种体验，前者更糟，而这一项一定会有。**它现在是全游戏唯一一根自己试听自己的滑杆**：`SettingsScene` 不在静音场景里，所以拖的时候音乐正在响，通道音量同一帧生效——这也是它仍然不需要松手试听的原因（理由换了，行为没变）。

> **⚠️ 这一段是 2026-08-31 写的，两条都已过时，留着是因为它记着当时的状态：**「音频素材（§7 第 6 步）——18 个 cue **全部**是程序化合成音，`cueAssets.ts` 依旧是空的。BGM（§7 第 7 步）同样未开始。」素材已发货（§0.4：10 个 cue / 22 个样本）；BGM 已发货（§0.5：一条轨 `bgm.lobby`）。**仍然没有的**：`bgm.battle` 的 master（§2.3）。**微信真机**仍未验（DevTools 已验，见 §0.3 末尾那三条）。

**验证过的**：
- `test/audio/**` **127 个用例**（+4：`errorCueThrottle.test.ts`；**+18：`ContextAudioBus.test.ts`，2026-09-01**），`src/audio/**` 与 `src/ui/hits.ts` 行覆盖均 **100%**；两者都在 `vitest.config.ts` 的覆盖率门禁里（客户端整体 95.77% → **95.83%**，scope 又变大一点而百分比仍在上升）。
  > **2026-09-01 顺带堵上一个 scope 的洞**：门禁 include 有 `src/audio/**`、**没有** `platform/**`，所以「`src/audio/**` 100%」一直是真的，同时后端类 `WebAudioBus` 一个用例都没有。抽出 `ContextAudioBus` 之后它进了门禁，18 例 + **8 个变异全抓**（明细见 §0.3）。
  > **补记（2026-09-02）：那个洞只堵了一半，而且堵法本身留了一句会过期的话。** 抽出 `ContextAudioBus` 之后剩下的 `WebAudioBus` / `WechatAudioBus` 被判为「各自 ~15 行、只回答两个问题」而留在门禁外——量一下，**两个套件并集下两者都是 0%**。前提也早就不成立了：BGM 落地后平台要回答的从两个问题变成**四个**（上下文 / 手势 / deck / 前后台），其中三个带静默失败分支（`webkitAudioContext` 缺席 = 老 Safari 全哑；`createMusicDecks` 返回一个空上下文驱动不了的 deck = 静音且无日志；前后台接缝报错初值 = 床在后台响）。补 `test/audio/WebAudioBus.test.ts` **17 例** + `WechatAudioBus.test.ts` **19 例**，两者 100%，一并进 include。**四个变异全抓**（deck 改成需要 ctx / 去掉中断恢复 / 手势监听去掉 passive / `ensureMusic` 在无 ctx 时早退）。
  >
  > **并且这一轮真找出一个 bug，就在那句刚写下的注释里。** `WebAudioBus.onFocusChange` 结尾那句「当前值也报一次」（为「页面在后台标签页里加载完成」写的）是**空转**：它在 `ContextAudioBus` 的构造函数里同步执行，而 `music` 要到 `ensureMusic()` 才懒造，所以回调里 `this.music?.setPaused(hidden)` 无处落地，值被静默丢掉。修法是 `ContextAudioBus.hidden` 字段——存下来，等播放器造出来时补一次 hold（`MusicPlayer.update()` 在 hold 期间整段返回，所以效果是「床压根不起来」而不是「起来了再暂停」）。**两处必须同时在**，两边注释互相指着对方。
  >
  > 顺带一条同族的：`src/render/canvasTexture.ts`（微信不让 PIXI 嗅探资源类的第二道保险，`wechatHost.ts` 是第一道）落地时也是 0 用例——`textureFromCanvas` 从没被任何套件调用过。`test/canvasTexture.test.ts` **14 例**：行为 6 例 + 调用点扫描守卫 2 例 + 扫描器自测 6 例，同样进门禁。客户端整体 **94.8% → 96.1%**。
- `test/uiTapSoundCoverage.test.ts` **11 例**——源码扫描守卫，四条断言 + 各自的 canary 和 allowlist 保鲜检查（明细见上面那张表）。四条**全部做过变异验证**。`DIRECT_UI_CUE_ALLOWLIST` 现在四条（新增 `audioPanel.ts` 的松手试听）。
- `test/ui/settingsSliderOverlap.ui.ts` **14 例**（2026-08-31 新增，§0.2 (D)）——「任何滑杆矩形都不许与任何 hit 矩形相交」，3 种场景形状 × 4 种画布尺寸 + 两条结构断言。**做过变异验证**（把版面改回旧坐标，12 条全红）。
- `test/audio/errorCueThrottle.test.ts` **4 例**（2026-08-31 新增，§0.2 (A)）——错误音扇出合并。**做过变异验证**。
- UI 侧 `test/ui/uiAudioCues.ui.ts` **21 例**（+2：§0.2 (B) 把「滑杆静音」那条拆成拖动静音 / 松手试听一次 / bgm 静音三条），全部走真实 pointer 事件（PIXI 原生那族走真的 `EventBoundary.hitTest`）而不是直接调 hit 的 `fn`——否则一个「挂了 cue 但没人点得到」的按钮会通过。也做了变异验证：拆掉 `ResultScene` 主 CTA 的 `tapHandler`、把大厅头像芯片改成 `sound: null`，两例都会红。
- 主套件 **2359 例**、UI 套件 **2428 例**、`test:sim` 13 例全绿。收敛命中表触碰了 80+ 个源文件和 12 个测试文件，两套件是这次重构唯一的行为安全网，一次都没有降级为「改测试迁就实现」——每一处红都是测试自己的旧形状（`h.x` → `h.rect.x`、`action` → `fn`）。
- `tsc --noEmit`（`tsconfig.json` + `tsconfig.test.json`）、`eslint src`、500 行门禁、包体门禁、`test:sim`、`web` + `wechat` 两个 production 构建全通。
- **微信主包只多付 585 字节**（2188322 → 2188907；其中 §0.2 的两处修复 + 松手试听占 148 字节，`sfx.result.draw` 占 28 字节），依旧接近持平：cue 字符串字面量 + `ui/hits.ts` + `audioSettings.ts` 是进包了，但**收敛本身省下的比它们花掉的还多**——大厅那条 18 分支链、战斗/世界地图 HUD 的 if 链、五份手抄的私有 `inRect`，全都塌成了共享的一份。**播放引擎仍旧没进**（`grep createOscillator` 命中 0 次）：`entries/wechat.ts` 依旧不 import `WebAudioBus`，装的是 `NullAudioBus`，所以微信上这些 `playSfx` 全部落在空操作上。
  > **已过时（2026-09-01）**：微信后端落地后主包 2188907 → **2197453（+8546 字节）**，`createOscillator` / `createBiquadFilter` / `createWebAudioContext` 各命中 1 次——**播放引擎第一次真的进包**，微信上的 `playSfx` 不再是空操作。见 §0.3。
- **真浏览器实测，不是推断**（Chrome，`entries/web-e2e.ts` 的 `window.__nwAudio` + 在 SFX 总线上挂一个 `AnalyserNode` 读 PCM 峰值）：`AudioContext` 在第一次真实点击后 `running`（48 kHz），总线增益 0.8（§4 的 SFX 默认值），**当时的 17 个 cue 全部出声**（第 18 个 `sfx.result.draw` 是 §0.2 那一轮补的，交付峰值 0.1179），`loaded()` 诚实地报 `{cues:0, variants:0}`。游戏本身跑着时**连续 2 秒静默量到 0.000**——既确认总线没有本底噪声/直流偏移，也确认目前确实没有任何代码在触发 cue。交付峰值：

  | cue | 峰值 | | cue | 峰值 |
  |---|---|---|---|---|
  | `sfx.base.hit` | 0.151 | | `sfx.ui.gacha.reveal.epic` | 0.101 |
  | `sfx.card.play` | 0.146 | | `sfx.unit.death` | 0.099 |
  | `sfx.result.victory` | 0.132 | | `sfx.unit.hit` | 0.098 |
  | `sfx.spell.cast` | 0.129 | | `sfx.ui.tap` | 0.090 |
  | `sfx.result.defeat` | 0.117 | | `sfx.ui.reward` | 0.089 |
  | `sfx.card.invalid` | 0.105 | | `sfx.ui.error` | 0.078 |
  | | | | `sfx.unit.attack` | 0.058 |
  | | | | `sfx.ink.tick` | 0.028 |

  UI 那一族（0.067–0.101）整体坐在响的战斗音之下、`sfx.ink.tick` 是全表最轻——正是 §4 要的"安静的底、有冲击力的战斗"。

  > **⚠️ 这张表的精度被 §0.2 订正过，读它的时候必须知道：每格都是单次测量，而以噪声为主体的 cue
  > 有 27–38% 的运行间抖动**（白噪声每次的样本不同）。所以**相邻两行之间的名次没有意义**——
  > §0.2 用 12 次重复重测，`sfx.ui.tap`（0.073–0.110）、`sfx.unit.hit`（0.075–0.102）、
  > `sfx.unit.death`（0.087–0.115）三者的区间是**互相重叠**的，本表里它们那个 0.090 / 0.098 /
  > 0.099 的排序纯属抽样噪声。以音调为主体的 cue 反过来几乎完全确定（`sfx.ui.reward` 五次都是
  > 0.0892，`sfx.ui.back` 0.0704–0.0706，抖动 <1%），因为振荡器每次渲染的是同一段波形。
  > 本表能支撑的结论只有**分组**：响的战斗音（`card.play` / `base.hit` / `spell.cast` / 两个
  > stinger / `card.invalid`，0.107–0.160）明显高于 UI 那一族（0.067–0.106），而
  > `unit.attack`（0.044–0.059）和 `ink.tick`（0.0279，恒定）明显更低。`unit.hit` /
  > `unit.death` 与 UI 齐平，这**符合** catalogue 的意图而不是违背它（`sfx.ui.tap` gain 1.0 本来
  > 就高于 `unit.hit` 0.9 / `unit.death` 0.85）。以后要比较两个 cue 的响度，至少测 10 次取中位数。

- **⚠️ 实测抓出一条用例看不见的规律：授权峰值 ≠ 交付峰值。** `tone`/`noise` 的 `gain` 是**滤波器之前**的振幅，而白噪声过一道低通之后损失的能量取决于截止频率。`sfx.unit.hit` 最初写成 `gain 0.15 / cutoff 1400`，授权峰值排第二，**交付到总线只有 0.063**，与本该全表最轻的 `sfx.unit.attack`（0.065，只过 900 Hz 高通 + 4500 低通，损失小得多）齐平，正好和 catalogue 里"受击(0.9/60) 明显高于攻击(0.7/20)"的意图相反。改成 `gain 0.17 / cutoff 2400` 后交付 0.098 vs 0.058，意图恢复。**单元测试量的是节点图上的 gain，永远看不到这一层**；只有真 `AudioContext` + AnalyserNode 量得出来。以后新增/调整任何以噪声为主体的 cue，都要按这条重新实测一次，不能只看 `gain` 排序。

- **没有人听过任何一个合成音。** 上面那张表能排除缺陷、能证明混音的相对关系符合意图，**不能判断一个声音是否好听**——现在触发点已经接上、打一局就能听到它们，那个签收只差一个人坐下来听。

### 0.1 战斗触发点的真浏览器实测（2026-08-31）

环境：Chrome + `entries/web-e2e.ts`（`npm run start:e2e`），在 SFX 总线上挂 `ScriptProcessorNode` 读 PCM 峰值，并用新增的 `window.__nwAudio.log()`（总线包一层的 cue 流水账）看**哪个** cue 真的被触发了、合并了几个事件。跑了三局 campaign `ch1_lv2`。

- **游戏真的不静音了**：一局里总线峰值 0.231–0.274（上一轮还没接触发点时，同样的测量在游戏跑着时是 0.000），且远未削平。实际听到的 7 个 cue：`card.play` / `unit.attack` / `unit.hit` / `unit.death` / `base.hit` / `ink.tick` / `result.defeat`。
- **合并是真的在工作**：`sfx.unit.attack` 15 次调用 / 28 个事件（单帧最多 5），`sfx.unit.hit` 48/53，`sfx.base.hit` 7/9。单独量一下 `count` 的效果：`sfx.unit.hit` 在 count=1/2/4/8 下交付峰值 0.094 / 0.105 / 0.122 / 0.159——**单调上升但远低于线性**，正是"抬增益、不叠 8 个声道"。
- **胜负 stinger 的 60fps 陷阱确实被堵住**：三局每局 `sfx.result.defeat` 都只有 **1 次**调用，跨过了 2 秒结算延迟 + ResultScene 切场。需要注意的是这个门**不只保护 stinger**：引擎 `step()` 提前返回时不清队列，重复被消费的是**最后一帧的整批事件**，所以 `collectCue` 开头就是 `if (this.core.gameEnded) return`，否则最后一帧的阵亡和基地受击也会跟着 60fps 轮播。
- **⚠️ 实测抓出的第二条「单元测试看不见」的规律：`sfx.ink.tick` 天真地接在 `resource_changed` 上是个机关枪。** 那个事件每涨**一点**墨就发一次，而 `INK_REGEN_BASE` = 2 点/秒（后期加速到 4）——实测 12 秒内响了 **31 下**（2.6 Hz）。那不是 `cueCatalogue` 说的"背景节拍"，是一台节拍器卡住了。改成每累计 10 点墨滴一下（`INK_TICK_STEP`，大致是一张牌的均价，牌价 4–12）后重测：20 秒 5 下、约 4 秒一声。**单元测试只能断言"事件 → cue 映对了"，永远断言不了"这个频率能不能听"**——与上一轮"授权峰值 ≠ 交付峰值"是同一类盲区。以后任何接在**高频引擎事件**上的 cue，都要在真局里数一遍频率再签收。
- 未在真局里跑到的路径（仅用例覆盖）：`spell_cast`、`projectile_fired`、`building_destroyed`、`escort_died` —— 都归入上表已有的两个 cue，没有独立的交付风险。
- **微信主包不再是 0 字节，而是 +1234 字节**（2187088 → 2188322）：触发表的 cue 字符串字面量现在跟着 `events.ts` 进了包（`grep 'sfx.card.play'` 命中 1 次），但**播放引擎仍然没进**（`grep createOscillator` 命中 0 次）——`entries/wechat.ts` 依旧不 import `WebAudioBus`，装的是 `NullAudioBus`，所以微信上这些 `playSfx` 全部落在空操作上。
- 新增的测量面：`window.__nwAudio.log()` / `.clearLog()`（仅 `entries/web-e2e.ts`，与 `__nwE2E` 同类的永久测试基础设施）。AnalyserNode 只能告诉你"响了、多响"，告诉不了你"响的是哪个 cue"；一局里 cue 飞得比人眼快，没有这个流水账就无法回答"`card_played` 到底有没有变成一声 `sfx.card.play`"。

---

### 0.2 UI 触发点的真浏览器实测（2026-08-31，**已补完**）

上一轮欠着这一节，卡在「插件开的 Chrome 标签页是 `visibilityState === 'hidden'`，`AudioContext.resume()` 的 promise 永不 settle」。**这次先请人把 Chrome 窗口切到前台**，断言 `visibilityState === 'visible'` + `document.hasFocus()` 之后再动手，一次就通了：第一次真实点击后 `ctx.state === 'running'`（48 kHz，总线增益 0.8）。

> **两个必须先解决的坑，写在方法之前，因为它们各自能让整轮测量变成一堆 0：**
>
> 1. **标签页必须真的在前台。** 后台标签页里 rAF 冻住、`resume()` 不 settle，症状是「全部 cue 都不响 + 截图超时」，看起来完全像「音频坏了」。顺带一条观察：`visibilityState` 偶尔会在 `hasFocus() === true` 的同时报 `hidden`（Chrome 的窗口遮挡检测——另一个窗口盖在上面），此时**渲染和音频照样正常**；判断标准应该是「点击真的产生了 cue、画面真的在变」，而不是死盯 `visibilityState`。
> 2. **总线拿不到就什么都量不了，而事后 patch 是拿不到的。** `app.ts` 的 `preload()` 在启动时就建好了 `AudioContext`，所以「patch `AudioNode.prototype.connect` 收集 GainNode」这类事后注入永远晚一步。这一轮改成在 `entries/web-e2e.ts` 里加一个 `__nwAudio.nodes()`，直接穿透 TS 私有字段取 `WebAudioBus` 的 `ctx` / `sfx`——同一个文件里 `views.app` 已经是这个手法、也已经写明了理由（为一个测试需求在生产代码上开接缝是更差的交换）。

**方法**：`entries/web-e2e.ts` 的 `npm run start:e2e`；SFX 总线上挂 `ScriptProcessorNode` 读**逐样本**峰值（不是轮询 `AnalyserNode`——UI cue 只有几十毫秒，轮询会跨过瞬态）；cue 归因仍用 `__nwAudio.log()`。两种输入都用了，分工明确并在下面逐条标注：**真实点击**（`computer{left_click}`，用来回答「一次点击到底产生几个 cue」）和**合成 `PointerEvent`**（用来回答需要精确坐标或超出人手速度的问题——它们打在 `WebAdapter` 监听的同一个 canvas 上，走完全相同的 `InputManager → hitTest` 路径）。

#### 四个问题的答案

| 问题 | 答案 |
|---|---|
| UI cue 的**触发频率**会不会变成机关枪 | **来自手指的那条路不会。** 一次点击 = 恰好一个 cue，在**每一个**速率下都成立：12 次连击 → 12 个 cue，从 3.8 Hz 一路到 **42.6 Hz**（远超人手极限）都没有丢、也没有双发。总线峰值全程 0.101–0.116，与单次点击（p50 0.096 / max 0.110）**基本持平**——连击不会叠成一记闷响。根本原因是 UI cue **没有自主驱动源**：`ink.tick` 栽的那个坑是引擎定时器以 2.6 Hz 自己在响，而 `sfx.ui.tap` 的节奏就是玩家自己的节奏。**但机关枪确实存在，在另一条路上——见下面 (A)。** |
| `sfx.ui.tap` / `.back` / `.reward` 的**交付峰值**还在不在战斗音之下 | **在（但 §0 那张表的精度被订正了）。** 重测（每 cue 5 次取中位数）：UI 族 0.067–0.106，响的战斗音 0.107–0.160。`.tap` 0.0923 / `.back` 0.0706 / `.reward` 0.0892，与 §0 记的 0.090 / 0.067–0.101 一致。真正的发现是**「理应不变」这次对了，但那张表本来就不该被逐行读**：噪声型 cue 有 27–38% 的运行间抖动，音调型 <1%——见下面 (C)。 |
| 三根滑杆拖动时是不是**真的一声不响** | **是，而且过头了。** 三根滑杆各拖 80 次 pointer-move（共 240 次）：**0 个 cue，总线峰值 0.0000**。按下不响、拖动不响，`update()` 的每帧重绘也没顺带触发任何东西。但这也意味着 SFX 滑杆是一根**完全盲的**控件——没有 BGM、拖动不出声，玩家把它拖到 0.4 时手上没有任何参照，而这是全游戏唯一一个「听到结果就是它的全部意义」的控件。**已修：松手时试听一声**，见下面 (B)。 |
| 设置页那块音量区的**版面**对不对 | **不对，而且是这一轮最严重的问题。** 纸面算的位置和真实版面差一整行，后果是**语言按钮 Deutsch 有一半面积是死的**。见下面 (D)。 |

#### (A) ⚠️ 真正的机关枪在 `showToastMessage`，不在点击上——而且它还是一记爆音

`net/log.ts` 的 `showToastMessage` **每次调用都无条件发一声 `sfx.ui.error`**，没有去重、没有节流。而它下游的 `GlobalToast.show()` 第一行就是 `this.clear()`——**视觉上永远只有一个 toast**，后来的替换先前的。视觉层做了合并，音频层没有。

用应用自己装的 `unhandledrejection` 处理器跑真实路径（六个并发 `fetch` 打向死端口，故意不 catch，于是各自以 `TypeError` 命中 `uncaughtErrorMessage` → `showToastMessage`）：

| | 修前 | 修后 |
|---|---|---|
| cue 数 | **6 个，跨度 23 ms** | **1 个** |
| 总线峰值 | **0.3884** | **0.0782** |
| 玩家看到的 toast | 1 个 | 1 个 |

0.3884 是**单次错误音的 5.0 倍**，也是**全游戏最响那个 cue（`sfx.card.play` 0.159）的 2.4 倍**——即这条路能发出的声音比任何有意设计的声音都响一倍多，而屏幕上只有一条消息。

它之所以这么响，是 (C) 那条叠加律：`sfx.ui.error` 是**音调**，同瞬间的多个副本**线性相加**。

**修法**：`raiseErrorCue()`，前沿节流，一个 `ERROR_CUE_MERGE_MS = 400` 的窗口。三处判断都记在代码里：

- **为什么不用 `play(cue, count)` 那个合并**（战斗侧的做法）：`count` 是刻意**放大**的——「八个单位同时被击中」就该更有分量；「一次失败扇出成六个 rejection」不是六倍的失败。而且前沿触发零延迟、不需要挂一个会活过 teardown 的定时器。
- **为什么是 400 ms**：约等于这个 cue 自身长度（190 ms）的两倍。两次起音比这更近就会糊成一记嗡鸣而不是读作两件事，所以窗口内的第二声只增加噪声、不增加信息。真正分开的失败（重试退避、玩家的第二次点击）都是秒级间隔，照样响。
- **success 一档不参与**：它本来就不发声，也不武装节流窗口——否则一次「设置已保存」会把紧随其后的失败静音掉（这条专门有一个用例）。

守卫：`test/audio/errorCueThrottle.test.ts` 4 例（同瞬扇出 → 1 声 / 窗口边界 399 ms vs 400 ms / 前沿不累积 / success 不武装），**做过变异验证**（把窗口设成 0，三条红）。用例只能断言调用次数——那 0.3884 住在 `AudioContext` 的求和里，node 下看不见，这正是 §0「授权峰值 ≠ 交付峰值」的同一层盲区。

#### (B) SFX 滑杆原来是盲控件——松手时试听一声

「滑杆要跟手，好让玩家在挑的时候就听到自己挑的档位」是 `audioPanel.ts` 当初为「滑杆不是 hit」给出的理由。实测把这句话证伪了：**拖动一声不响**（这本身是对的，一次 pointer-move 一声就是 `ink.tick` 那个坑换成手指），而 BGM 还不存在，于是整个过程里没有任何可听的东西。

修法：`AudioSlider` 加一个可选 `onRelease`，由**面板**（不是场景）决定松手响不响。`master` / `sfx` 两根在 pointer-up 时试听一声 `sfx.ui.tap`；**`bgm` 那根保持静音**——当时的理由是它接的 `setMusicVolume` 接受并忽略，用一个 SFX cue 去试听它等于对「这根滑杆管什么」撒谎。**§7 第 7 步之后行为不变、理由变了**：那个通道现在驱动一条真的床，而床在拖动过程中**本来就在响**（`MusicPlayer` 下一帧就取到新的总线音量），所以再插一个 SFX cue 只会盖住它要演示的东西。另外两根仍然需要试听：它们的通道在两次 cue 之间是静的。

真浏览器复测（每根 60 次 pointer-move）：拖动中 0 cue / 峰值 0.0000，松手 master 与 sfx 各恰好 1 声、bgm 0 声。而且**试听真的跟随档位**——把 Sound 拖到四个位置分别量交付峰值：

| `sfx` 档位 | 总线增益 | 试听交付峰值 |
|---|---|---|
| 1.00 | 0.876 | 0.1037 |
| 0.54 | 0.470 | 0.0518 |
| 0.20 | 0.172 | 0.0231 |
| 0.04 | 0.033 | 0.0036 |

峰值/增益恒为 0.118——是真预览，不是摆设。

这个出口进了 `uiTapSoundCoverage.test.ts` 的 `DIRECT_UI_CUE_ALLOWLIST`（第 4 条，各带理由）：滑杆刻意**不是** hit，所以它必然绕过 `runHit`。用例侧把原来那条「滑杆按下+松手都静音」拆成两条——「按下与整个拖动（40 次 move）静音」保留了它本来保护的不变量，「松手恰好试听一次」是新增的，另加一条「bgm 静音」。

#### (D) ⚠️⚠️ 版面：音量区的第三根滑杆吃掉了半个语言按钮，而且是**静默**吃掉

截图一看就露了：`Sound` 标签压在 English 按钮上，Sound 滑杆的轨道从 Deutsch 按钮底下穿过去。量出来的几何（canvas 1920×855）：

| 矩形 | 位置 |
|---|---|
| Sound 滑杆命中区 | x 1274–1817, y 436–480 |
| Deutsch 按钮 | x 1190–1612, y 448–501 |
| 重叠 | x 1274–1612（Deutsch 宽度的 80%）× y 448–480（高度的 60%） |

**后果比「画面难看」严重得多，因为 `SettingsScene.handleDown()` 先查 `audioSliders`、再查 hit 表**（滑杆要抢占指针，所以它必须先）。于是重叠区里的按压**不是**「按钮被盖住」，而是**滑杆静默吃掉**：

```
tap(1400, 476)  ← Deutsch 按钮正中央
  修前：locale 没变；sfx 音量被拖到 0.219；cue 数 0
  修后：locale → de；音量未变；一声 sfx.ui.tap
```

**cue 数 0 是这个 bug 最恶劣的部分**：滑杆不是 hit，所以连「你按到了什么」的听觉反馈都没有。玩家的体验是「按了 Deutsch，什么都没发生」，而他的音量在背后悄悄掉了。逐点扫描确认 Deutsch 只有 y ≥ 481 的那 20 px（53 px 高度里的 38%）还活着。

**根因**是一句纸面上的假设写在原注释里：「左栏那个高度上是语言按钮」——即以为语言按钮留在左栏。它们不留：三个 locale × 0.22w + 两个 0.03w 间隙，从 0.12w 起算到 **0.84w**，语言行是一条**贯穿整宽**的行，占 y 0.525h–0.587h。右栏在那个高度上根本不是空的。

**修法**：把整块音量区搬到语言行**上方**——`titleY` 0.385h → **0.30h**，`x0` 0.56w → **0.60w**。第二个数字同样是实测逼出来的：右栏那块空白的左边界不是 0.56w（`drawHelp` 用的那个），而是 profile 区**改名按钮**的右边（x ≤ 0.58w，y ≈ 0.30h–0.37h）——**而改名按钮只在登录态存在，离线截图里根本看不见它**。修后三行滑杆底边 0.475h，距语言行 43 px。

**守卫**：`test/ui/settingsSliderOverlap.ui.ts` 14 例。断言的不是「这两个面板别撞」，而是一条更强的不变量：**任何 `audioSliders` 矩形都不许与任何 `hits` 矩形相交**——因为滑杆先查，相交就等于那个按钮是死的。跑 3 种场景形状 × 4 种画布尺寸，其中一种形状**特意是登录态**（改名按钮在场、Help 栏在场、销号按钮在场），正是离线截图看不到的那些矩形。另有两条：语言行确实贯穿整宽（把「为什么不能放回 0.56w」钉住，将来语言行若收窄回左栏，这条会红，好让人**有意识地**把音量区搬回去而不是碰巧）、三行滑杆之间不互相重叠。**变异验证**：把版面改回 0.56w / 0.385h，12 条（3 形状 × 4 尺寸）全红。

> **这一轮的教训，和上一轮是同一个形状换了一层皮。** 上一轮是「按已知的机制去数，而不是按玩家能点到的东西去数」，漏了两整族按钮。这一轮是**「按纸面算的坐标去放，而不是按真实渲染出来的版面去放」**——而且两次的共同点是：**错的那一版所有测试都是绿的**。按钮渲染正常、命中判定正常、滑杆工作正常、每个 cue 都出声；唯一的症状是一个按钮有一半按不动，而这只有人真的坐下来点它才会发现。所以两次的产出都不只是修一处代码，而是把「只有人眼能发现」的那一类退化变成一条源码/几何断言。
>
> 顺带一条方法上的教训：**离线截图看不到登录态的矩形。** 第一版几何算完以为 0.56w 可以留着，正是因为截图里没有改名按钮。真正兜住它的是那个跑「登录态」形状的用例，而不是截图。

#### (C) 新发现的第三条「用例永远看不见」的规律：同瞬叠加，音调线性、噪声开方

同一个 cue 在**同一瞬间**播 n 次，交付峰值：

| cue | 原语 | n=1 | n=2 | n=4 | n=6 | n=8 | n=8 倍率 |
|---|---|---|---|---|---|---|---|
| `sfx.ui.error` | tone | 0.0782 | 0.1565 | 0.3130 | 0.4695 | 0.6260 | **8.0×** |
| `sfx.ui.back` | tone | 0.0706 | 0.1412 | 0.2824 | 0.4235 | 0.5647 | **8.0×** |
| `sfx.ui.reward` | tone×2 | 0.0892 | 0.1783 | 0.3566 | 0.5299 | 0.7132 | **8.0×** |
| `sfx.ui.tap` | noise | 0.1149 | 0.1182 | 0.2200 | 0.2285 | 0.3256 | **2.8×** |
| `sfx.unit.hit` | noise | 0.0957 | 0.1566 | 0.2264 | 0.3258 | 0.4622 | 4.8× |

**音调型精确线性放大 n 倍**（振荡器每次渲染同一段波形、起音同相，±3% 音高抖动在几十毫秒内还来不及拉开），**噪声型只放大约 √n**（0.1149 × √8 = 0.325，实测 0.3256）。`sfx.ui.reward` 在 n=8 时已经到 0.713——离削波不远。

这条规律直接量化了**战斗侧的同帧合并到底值多少**：

| n | `play(cue, count=n)`（合并） | 播 n 次（裸叠） |
|---|---|---|
| 1 | 0.0783 | 0.0782 |
| 2 | 0.0900 | 0.1565 |
| 4 | 0.1017 | 0.3130 |
| 6 | 0.1086 | 0.4695 |
| 8 | 0.1135 | **0.6260** |

n=8 时合并比裸叠**安静 5.5 倍**。`EventsPanel.flushAudio` 的 `Map<AudioCue, number>` 因此不是一个优化，是一道**必需**的闸门——而 (A) 那个 bug 的本质就是「UI/toast 那条路没有这道闸门」。

**以后新增任何 cue 都要问一句**：它有没有可能在同一瞬间被触发多次？如果有，而且它以音调为主体，那就必须走合并（或节流），否则一次扇出就能发出比游戏里任何设计音都响一倍多的声音。

#### (E) 顺带补上平局 stinger —— 以及 (C) 那条律的另一面：**音调型 cue 的交付峰值取决于音符有没有重叠**

§7 第 3、4 步各自留下的口子，第 4 步那个（`sfx.card.invalid`）已在上一轮补上，这一轮补掉最后一个：`game_draw` 原先**完全无声**（另外两个 stinger 哪个都是误报，所以只能什么都不放）。

新增 `sfx.result.draw`：合成音是**同一个音（中音 C 523 Hz）重复两次、音高不动**。胜是三音上行、负是二音下行——方向就是那两个 stinger 携带的全部信息，而平局要说的恰恰是「没有方向」。第二声更长、略轻，于是它读作「停在这里了」而不是一次卡住的重复；起音与胜利的第一个音同音是刻意的，三个 stinger 由此共享同一个起点，玩家分辨结果靠的是**之后往哪走**。触发点写在 `game_draw` 分支那个已有的一次性门**内部**，和胜负同一处、同一个理由（60 fps 重复消费最后一帧）。

**但第一版实测偏轻，而原因是几何而不是增益**：授权 gain 0.12 写下去，交付峰值只有 **0.0943**，比同档的胜利（0.1316）/ 失败（0.1178）轻 25%——与 catalogue 里「三个 stinger 同权重（gain 1.0）」的意图相反。查下去是 (C) 那条叠加律的另一面：

| stinger | 音符时序 | 是否重叠 | 交付峰值 |
|---|---|---|---|
| victory | delay 0 / 0.09 / 0.18，dur 均 0.16 | 重叠很多 | 0.1316 |
| defeat | delay 0 / 0.12，dur 0.18 / 0.30 | 重叠 0.06 s | 0.1178 |
| draw（第一版） | delay 0 / 0.20，dur 0.16 / 0.30 | **完全不重叠** | **0.0943** |
| draw（现在） | 同上，gain 0.12→0.15 / 0.10→0.13 | 完全不重叠 | **0.1179** |

**音调型 cue 同相叠加**，所以「一个 cue 有多响」不只取决于每个音的 `gain`，还取决于**同时响着几个音**。胜利那三音里有两三个在互相重叠，白拿了一截增益；平局那个空隙——正是它的全部语义所在——把这一截让掉了。

**修法是抬授权增益，不是加重叠**：那个空隙不能动。抬到 0.15 / 0.13 后实测 0.1179，与失败齐平、略低于胜利，三者落回同一档。

> **这条要和 §0 那条「授权峰值 ≠ 交付峰值」并排读，它们是同一件事的两个面**：噪声型 cue 丢的是**滤波器**吃掉的能量（`sfx.unit.hit` 那次），音调型 cue 丢的是**没有重叠**因而没拿到的同相叠加。两者都只有真 `AudioContext` 量得出来——单元测试量的是节点图上的 `gain`，两层都看不见。所以**新增任何 cue 之后都必须实测一次交付峰值，并和它在 catalogue 里的同档邻居比一比**，不能只看 `gain` 排序。

守卫：`test/ui/gameRendererAudio.ui.ts` 那条原本断言「平局静音」的用例改成断言「平局恰好一声 `sfx.result.draw`」，另加一条「连续 5 帧重复消费 `game_draw` 仍然只有一声」——**做过变异验证**（把 `this.cue()` 提到一次性门之外，后者立刻红）。`cueCatalogue.test.ts` 里「结算档正好 2 个」改成 3 个，并注明这个数字是**刻意钉死**的，好让第四个结局必须是一次有意的编辑。

#### 其它记下来的数

- **微信主包再多 176 字节**（2188731 → 2188907）：`raiseErrorCue` 的节流状态 + `audioPanel.ts` 的 `playSfx` import（148 字节）+ `sfx.result.draw` 的字符串与合成音（28 字节）。**播放引擎依旧没进包**（`grep createOscillator` 命中 0 次，`grep 'sfx.card.play'` 命中 1 次）。
- 静默基线复测：2 秒静默 → 峰值 **0.0000**，且 `__nwAudio.log()` 为空（设置页闲置时没有任何代码在触发 cue）。
- 真实点击的一个观察：6 次真实连击只产出 4 个 cue——两次落空是**场景淡入淡出期间 `InputManager.suppressed` 闸掉的指针**，以及点在已经激活的那个 tab 上（激活项不 push hit）。两者都是既有的正确行为，不是漏接；但它说明「点了 N 次就该有 N 声」在真实导航里并不成立，量频率必须用同一个屏幕内的稳定靶（这里用的是 Equipment 页的 Weapon↔Armor 两个子标签）。
- 新增的测量面：`__nwAudio.nodes()`（仅 `entries/web-e2e.ts`）——返回 `{ctx, sfx}`，与 `log()` / `clearLog()` 同类的永久测试基础设施。
- **仍然没有人听过任何一个合成音。** 这一轮把「响得对不对」量到了尽头，「好不好听」还是只差一个人坐下来听。

### 0.3 微信后端的实测（2026-09-01，§7 第 5 步）

微信从此不再静音。落地形态**不是**本文 §3/§5 原先写的「`InnerAudioContext` 对象池」，而是
`platform/wechat/WechatAudioBus.ts` —— 走 `wx.createWebAudioContext()`，**整条管线一行没改**。

#### ⚠️ 拦住这一步的从来不是平台，是我们自己的 `.d.ts`

微信一直装 `NullAudioBus`，理由写在 `entries/wechat.ts` 和 `audio/audioBus.ts` 两处注释里：
「那个运行时没有振荡器、没有 GainNode，所以合成音、`AudioBuffer` 样本、总线增益这三样一行都
跑不起来」。**那句话的唯一依据是 `client/src/wx.d.ts` 里只声明了 `createInnerAudioContext`**
——即把「我们的声明文件写了什么」当成了「运行时提供什么」。

真实的小游戏运行时从基础库 **2.19.0** 起就提供 `wx.createWebAudioContext()`，一个标准 WebAudio
表面（DevTools 自带的小游戏 API 补全集里就有这一条，文档挂在
`minigame/dev/api/media/audio/WebAudioContext.html`）；本项目
`wechatgame/project.private.config.json` 钉的是 3.15.1，DevTools 实际装的基础库是 **3.17.2**，
早就在门槛之上。本文 §3 其实把这条备选写进了脚注，只是标着「本仓库没有设备可验证」——
**真正拦住它的是没人去验**。

> 一般化的教训，比这次的代码值钱：**一个平台 API 在 `.d.ts` 里缺席，唯一的症状就是没人去用它。**
> 没有编译错误、没有红用例、没有告警——缺席本身就是它的伪装。两处错误注释没有删掉，改成了
> 记录成因。

#### 于是「对象池」这个取舍不需要做

§5 原先要求「SFX 走对象池（如 8 个 `InnerAudioContext` 轮转）」。`InnerAudioContext` 是**按 URL
播放的流式播放器**：一个实例一次一条音轨，没有振荡器（合成音无处安放）、没有可写的总线增益
（三档音量只能逐实例乘进去）、没有 `AudioBuffer`（同一个 cue 的 n 次合并只能变成 n 个实例，正好
撞上 §0.2 (C) 那条线性叠加律）。用它铺 SFX 等于为这一个平台再养一套形状不同的混音器。

而对象池**真正想要的东西**——并发上限 + 按优先级抢占——早就在 `audio/VoiceBudget.ts` 里了，
平台中立、被用例守着、两个平台共用一份。`InnerAudioContext` 剩下的正当用途只有 BGM
（单实例、流式、`loop=true`），即 §7 第 7 步。

#### 顺带把后端类拉进了覆盖率门禁

接第二个平台时才看清楚：`WebAudioBus` 里真正属于 web 的只有**两行**——上下文从哪来
（`new AudioContext()`）、手势从哪来（`window.addEventListener`）。其余（总线 GainNode、SFX 音量、
`SampleBank`/`CueMixer` 的装配、preload、autoplay 闸门、`loaded` 统计）在任何提供 WebAudio 表面的
宿主上逐字相同。所以抽出平台中立的 `audio/ContextAudioBus.ts`，两个后端各自只回答那两个问题，
各约 15 行。

**这次抽取顺带修掉了一个此前没人注意到的洞**：`vitest.config.ts` 覆盖率门禁的 include 里有
`src/audio/**`、**没有** `platform/**`。所以「`src/audio/**` 行覆盖 100%」这句话一直是真的，
同时 `WebAudioBus` **一个用例都没有**——门禁的 scope 边界正好落在那个类外面。搬进 `audio/` 之后
它进了门禁，新增 `test/audio/ContextAudioBus.test.ts` **18 例**（懒建上下文 / 宿主无音频设备的三条
降级路径 / autoplay 闸门 / `count` 转发 / 建前设音量 / 夹取 / preload 不等闸门 / `ctx`+`sfx` 字段名
反射面）。**8 个变异全部被抓**（拆掉 failed 闩、拆掉 ctx 记忆、丢掉 `count`、忽略建前音量、
去掉 `running` 判断、去掉 `suspended` 判断、去掉手势接线、给 `sfx` 字段改名）。

#### 怎么测的：一条新的测量面，以及两条走不通的路

**两条死路，写下来省得下次再试：**

1. **`miniprogram-automator` 够不到小游戏。** `cli.bat auto --auto-port 9420` 起得来，
   `automator.connect()` 也真的连上了（WebSocket `readyState: 1`）——但 `evaluate` 和
   `callWxMethod` **永远不返回**。那套协议是给**小程序**做的（appservice + pages），小游戏没有
   那个 RPC 面，命令发出去没人接。
2. **IDE 的 `--remote-port 3799` 不是 CDP HTTP 端点。** launch.log 里能看到这个参数，但
   `/json/version` 打不通；devtools 进程监听的几个端口里只有两个是纯 WebSocket
   （`Upgrade Required`），没有可枚举 target 的 CDP 面。

**走通的路**：新增 `src/entries/wechat-e2e.ts` —— **`web-e2e.ts` 的小游戏孪生**，永不发布。
它不启动游戏，直接构造 `WechatAudioBus`、在 SFX 总线上挂 `ScriptProcessorNode` 读**逐样本**峰值
（不是轮询 `AnalyserNode`，理由同 §0.2），逐个 cue 播 10 次取中位数，把报告写到
`wx.env.USER_DATA_PATH`——那在 DevTools 里是**磁盘上的真实目录**，于是整轮测量完全无头：不需要网络
（也就不用动 `urlCheck` 域名白名单）、不需要读控制台、不需要人点一下。构建走
`npm run build:wechat-e2e`（`webpack.config.js` 里 `isWechat` 由 `=== 'wechat'` 改成
`startsWith('wechat')`——那些分支全都是关于**平台**的，不是关于哪个入口在构建）。

> **报告有三个出口，因为每一个都有自己缺席的方式**：文件（唯一无头的，也是将来真机日志能带回来的）、
> `GameGlobal.__nwAudioProbe`（有控制台的人的抓手）、以及一行 `console.log`。**第三个是这轮花掉一
> 小时买来的**：磁盘上什么都没有，这件事对「探针崩了」和「模拟器根本没跑它」是等价的，而这两者
> 要的修法完全不同。

#### ⚠️⚠️ 那一小时的真正去向：DevTools 开的是**另一个目录**，而且那份产物已经坏了一个多月

探针死活不落盘。查到最后：DevTools 窗口里开的是**主检出** `D:\funny\client\wechatgame`，而我构建
的是自己 worktree 里的同名目录。更糟的是主检出那份 `pixigame.js` 是 **2026-07-29** 构建的，里面还
带着 webpack 的 auto-publicPath 运行时（`document.currentScript` /
`getElementsByTagName("script")`）——小游戏运行时没有 DOM，所以它**一启动就
`TypeError: t.getElementsByTagName is not a function`**，连 `game.js` 第二行都过不去。

现在构建的包里那个运行时**已经不再生成**（`grep currentScript` = 0），所以这是一个「**旧产物**」
问题，不是「微信构建坏了」。但它的含义值得记下来：**主检出的 `wechatgame/` 产物是 gitignore 的，
没有任何东西保证它是新的**，而谁在 DevTools 里开它都会看到一个与当前代码毫无关系的崩溃。本轮收尾
时已把它刷新成当前构建。

两条可复用的排查经验：

- **`usr/` 目录是按 appid 分的，而 appid 不在 `project.private.config.json` 里。** 这个项目在
  DevTools 里注册的是真 appid `wx25a3b18a3e83ffce`，所以报告落在
  `WeappSimulator/WeappFileSystem/<user>/wx25a3b18a3e83ffce/usr/`，而我一直在
  `touristappid/usr/` 底下找。旁边还躺着 8 月 25 号某次会话留下的 `boot-report.json` /
  `tap-report.json` / `quality-probe.json`（仓库里已经没有对应代码）——**「写 USER_DATA_PATH」
  这条路以前就有人走通过**。
- **`nwassets/` 的出现是「真游戏入口没崩」的无头判据**：`WechatAssetIO` 在构造函数里
  `mkdirSync` 它，而那是 `entries/wechat.ts` 的第一件事。本轮换回正常构建后它当场出现，
  即真正的游戏入口（`setAssetIO` → `setAudioBus(new WechatAudioBus())` → `startApp`）
  在微信运行时里正常启动。

#### 测出来的数

环境：DevTools 3.17.2（`platform: devtools`，模拟设备报 `iOS 10.0.1`），48 kHz，总线增益 0.800
（§4 的 SFX 默认值），`loaded()` 诚实地报 `{cues:0, variants:0}`，2 秒静默基线 **0.0000**。

- **`wx.createWebAudioContext` 存在，且上下文的工厂方法一个不缺**：`createGain` /
  `createOscillator` / `createBufferSource` / `createBiquadFilter` / `createBuffer` /
  `createAnalyser` / `createScriptProcessor` / `decodeAudioData` **全部是 function**。
  `onTouchStart` / `onAudioInterruptionBegin` / `onAudioInterruptionEnd` 同样存在。
- **这个运行时上没有 autoplay 闸门**：`ctx.state` 在**没有任何手势**的情况下直接就是 `running`
  （web 上必须等第一次点击）。手势接线仍然保留——真机上未必如此，而一个用不到的 `resume()`
  是零成本。
- 18 个 cue **全部出声**，每个测 10 次取中位数（§0.2 (C) 定的口径）：

  | cue | 微信中位数 | Chrome（§0/§0.2） | 比值 | 运行间抖动 |
  |---|---|---|---|---|
  | `sfx.card.play` | 0.1583 | 0.1460 | 1.08× | 35% |
  | `sfx.base.hit` | 0.1341 | 0.1510 | 0.89× | 21% |
  | `sfx.result.victory` | 0.1316 | 0.1320 | **1.00×** | 1% |
  | `sfx.spell.cast` | 0.1254 | 0.1290 | 0.97× | 17% |
  | `sfx.result.draw` | 0.1179 | 0.1179 | **1.00×** | 0% |
  | `sfx.result.defeat` | 0.1178 | 0.1170 | **1.01×** | 4% |
  | `sfx.card.invalid` | 0.1172 | 0.1050 | 1.12× | 15% |
  | `sfx.ui.gacha.reveal.epic` | 0.1034 | 0.1010 | 1.02× | 18% |
  | `sfx.unit.hit` | 0.0963 | 0.0980 | 0.98× | 48% |
  | `sfx.ui.tap` | 0.0921 | 0.0923 | **1.00×** | 30% |
  | `sfx.unit.death` | 0.0902 | 0.0990 | 0.91× | 27% |
  | `sfx.ui.reward` | 0.0892 | 0.0892 | **1.00×** | 0% |
  | `sfx.ui.error` | 0.0782 | 0.0780 | **1.00×** | 2% |
  | `sfx.ui.gacha.reveal.rare` | 0.0765 | — | — | 0% |
  | `sfx.ui.back` | 0.0706 | 0.0706 | **1.00×** | 1% |
  | `sfx.ui.gacha.reveal.common` | 0.0668 | — | — | 0% |
  | `sfx.unit.attack` | 0.0485 | 0.0580 | 0.84× | 40% |
  | `sfx.ink.tick` | 0.0279 | 0.0280 | **1.00×** | 0% |

- **这张表最有说服力的不是「都出声了」，是它的形状正好复现了 §0.2 (C)**：以**音调**为主体的 cue
  与 Chrome **数值上一致到小数点后四位**（`result.draw` / `ui.reward` / `ui.back` / `ink.tick` /
  `result.victory` / `ui.error` / `ui.tap` 七个，比值 1.00–1.01×），它们自己的抖动也是 0–4%；
  以**噪声**为主体的 cue 落在 0.84–1.12× 之间，而它们的抖动是 15–48%——**偏差全部小于它们自己的
  采样噪声**。也就是说确定性的那一半逐位相同，随机的那一半只差在它自己的随机性上。

#### ⚠️ 这一轮**没有**验证到什么：真机

**DevTools 是 Chromium 模拟器。** 上面那七个音调型 cue 与 Chrome 一致到四位小数，这件事本身就是
证据——说明这个模拟器的 `createWebAudioContext` **不是一套独立实现，而是转发给 Chromium 的
WebAudio**。所以它能证明的是：API 表面齐全、我们的接线正确、整条管线在 WebAudio 语义下跑得通、
交付峰值与 catalogue 的意图一致。它**不能**证明 iOS/Android 微信客户端里那套原生实现给出同样的数。

真机仍是**开放项**，需要验的三件事写在这里，好让下一个人不用重新推导：

1. 低版本基础库（< 2.19.0）没有 `wx.createWebAudioContext` —— 代码已按「静音降级」处理
   （`ContextAudioBus` 的 `createContext` 返回 `null`，与 SSR/node 走同一条路），但没有设备验过。
2. 真机上 `ctx.state` 初始是不是 `running`。若不是，解锁走 `wx.onTouchStart`（已接）。
3. 原生实现的滤波器/叠加行为是否与 Chromium 一致——即上面那张表在真机上还成不成立。
   `entries/wechat-e2e.ts` 就是为这次复测留的：它写 `USER_DATA_PATH`，真机上可以随日志带回来。

#### 包体

微信主包 **2188907 → 2197453，+8546 字节**（基线是在同一环境下退到父提交重新构建的，
逐字节复现了 §0.2 记的 2188907）。**这是播放引擎第一次真的进包**——此前三轮里
`grep createOscillator` 一直是 0，只有 cue 字符串字面量跟着触发表进去；现在
`createOscillator` / `createBiquadFilter` / `createWebAudioContext` 各命中 1 次。
距 4 MB 主包红线仍有大量余量。

---

### 0.4 素材第一批的实测（2026-09-01，§7 第 6 步）

**发货了什么**：10 个 cue、22 个文件、**57578 字节**，四个来源全部可商用且**无需署名**
（三个 CC0 + 一个逐条 CC0）。8 个 cue 刻意仍走合成音。管线移植自 daydayup 的
`tools/audio-pipeline/`，落在 [`tools/audio-pipeline/`](../../tools/audio-pipeline/README.md)。

| 来源 | 授权 | 用了几个 | 补的是什么 |
|---|---|---|---|
| **freesound.org**（API 逐条筛 CC0） | CC0，per **sound** | 17 | 唯一**可查询**的源，也是 `sfx.card.invalid` 能存在的唯一原因 |
| **BigSoundBank**（LaSonotheque） | CC0，无需账号 | 2 | 铅笔签名笔画、翻页 |
| **Kenney Interface Sounds** | CC0 | 2 | `ui.tap` / `ui.back`。Kenney 六个音频包里**唯一**不落在 art-direction §10 禁用清单里的那个 |
| **OpenGameArt**（Luckius, Various Paper SFX） | CC0 | 1 | 揉纸 |

#### ⚠️ 这一步真正的决定不是「挑哪个文件」，是「哪些 cue 不该换」

18 个 cue 不是一类东西。**10 个换成样本、8 个保留合成音**，而这条线不是按「找不找得到」画的——
`sfx.ui.error` 有现成且形状完全对的 Kenney `error_00x`（daydayup 就发的这个），照样被否掉。
画线的依据是**这个 cue 的语义住在哪里**：

- **住在音色里 → 换。** 「笔尖落纸的唰」「厚本子的闷响」「纸团揉碎的多颗粒」——这些是真实材料的
  质感，合成噪声只是「一段被滤过的随机数」，永远差那一层纤维。
- **住在音与音的关系里 → 不换。** 三个结算 stinger **共享同一个起始音高**，玩家靠「之后往哪走」
  分辨胜/负/平；三档揭示是同一把声音逐档**加音、加亮**，于是「史诗」在第三个音落下之前就已经和
  「普通」分开了。这些是三个 cue 之间的**关系**，不是三个声音——捡回来的录音只能用别人的调性
  替换掉这个关系，不可能复现它。

实测数字正好站在同一侧：§0.3 那张表里，要换的这 10 个当时抖动 15–48%，保留的这 8 个是 0–4%。
逐条理由写在 `art/audio/credits.json` 的 `rationale` 与 **`kept_on_synth`**——后者是这一步交付物的
一半：`cueAssets.ts` 里一个空条目**与疏漏完全无法区分**，而这一步在前三轮里正是那个状态。

#### 峰值对齐的基准：一条能闭式验算的等式

§7 第 6 步早先被订正过一次（`gain` 参数 ≠ 交付峰值）。这一轮把它落成一条可验算的式子：

```
文件峰值 = 实测交付峰值 / (catalogue gain × SFX 总线 0.8)
```

三个数都写在 `process.py` 的 `TARGETS` 里而不是预先除好，好让读者能各自回溯到出处。**它在一个
cue 上可以闭式验算**：`sfx.ink.tick` 的合成音是单个无滤波的 `tone(gain: 0.07)`，而
`0.07 × 0.5 × 0.8 = 0.0280` —— 正是浏览器量到的 0.0280。这条等式不是猜的。

#### 管线新增的两道**源文件**门禁，都在挡「输出端看不见」的缺陷

| 拒收条件 | 为什么输出门禁看不见 |
|---|---|
| `clipped_samples > 0` | 把削波文件往下缩 15 dB，失真原样保留，而 `audit.py` 量输出会读到干干净净的 0。不是假想：`book_275160.ogg`（0.18 dBFS）带 **1207 个削波样本**，而它差一点就成了 `sfx.base.hit` |
| `attack_ms > cap_ms` | 沙沙声是**连续手势、没有起振点**，池子里一堆文件的峰值出现在 240 ms 处。把这种文件截到 120 ms 等于**切在它自己的峰值之前**，然后峰值对齐会把剩下那段极轻的爬升放大到目标电平。听起来就是「这个样本坏了」，而且没有别的症状 |

#### ⚠️ 管线自己造出来的那个缺陷（已修，已钉死）

去咔哒的头部淡入原本是 **4 ms**（daydayup 的取值），而保留的静音前导只有 **1 ms**——多出来的
3 ms 淡入盖在**可听信号**上，把 cue 自己的起振压掉了。22 个资产里有 3 个因此没过 lead-silence
门禁，**而那段延迟是管线自己发明的**。现在淡入正好覆盖 `PRE_ROLL_S`。

顺带排除了一个看起来更像元凶的嫌疑：**MP3 编码器在这里一个样本都没加**——libsndfile 会剥掉编码
填充，六个采样率梯位上用满量程起振实测 lead 全部 **0.00 ms**。

#### ⚠️ 另一个花了时间的假象：一个擦着门限的孤立样本

修完淡入还剩一个失败（`eraser_335951.ogg` 报 8.9 ms lead）。逐阶段量下来发现：**内存里是
1.00 ms，写盘再读是 8.94 ms**，差别来自**一个样本**——第 48 号窗口峰值 `0.00132`，门限
`0.0013125`，高出 0.00007；PCM_16 量化后读成 `0.00131`，掉到门限之下，扫描于是跳到真正的起振点。

也就是说 **8.94 ms 是真的**（那段录音自己的极轻前导，-58 dBFS，比该 cue 峰值低 40 dB，听不见），
而「1.00 ms」才是假象。**-40 dB 的相对门限分不开「管线加的延迟」和「录音自己的爬升」，而且在
边界上脆到一个 LSB 就能翻转。** 于是改的是门限本身，理由与这个文件无关也站得住：

> 战斗 cue 由 `EventsPanel.flushAudio()` 每帧排空一次，**每个 cue 本来就带 0–16.7 ms 的帧时钟
> 量化**。样本内部再留 5 ms 的预算，落在系统自身定时噪声之下。所以 `sfx` 档放宽到**一帧
> （16 ms）**；`ui` 档收到 **8 ms**（半帧）——按钮是全游戏最在意延迟的事件，而整个 cue 只有 43 ms。

#### 测出来的数（一）：MP3 有损编码把峰值挪了多少

峰值对齐是在**编码前**做的，而 MP3 是有损的——这是管线**结构上无法验证自己**的一件事。为此给
`entries/web-e2e.ts` 加了 `__nwAudio.samples()`（读每个**已解码** buffer 的峰值，**不需要手势**，
suspended 的上下文照样解码）。22 个文件全部解码成功，`loaded()` = `{cues:10, variants:22}`。

偏差落在 **−6.1% … +6.7%（约 ±0.56 dB）**。参照物：catalogue 里最小的一档**有意**混音差是
0.7 ↔ 0.9（约 2.2 dB）——编码误差是它的**四分之一**。最大偏差在 `sfx.spell.cast`（+6.7%），
`sfx.ui.back` 则精确到小数点后五位一字不差（16 kHz、内容最接近纯音，受损最小）。

#### 测出来的数（二）：活体交付峰值，对齐成立

同一条 `ScriptProcessorNode` 挂在 SFX 总线上，每个 cue 测 10 次取中位数（§0.2 (C) 定的口径），
2 秒静默基线 0.0000，总线增益 0.800，48 kHz。

> **⚠️ 这一段是在 in-app 浏览器面板里量的，不是用户的 Chrome**，因为 Chrome 那边插件把标签页收进
> 背景标签组、`document.visibilityState` 是 `hidden`：CDP 合成的点击拿不到 user activation，而
> Chrome 也不会在隐藏标签页里 resume 音频上下文——`ctx.resume()` 直接不 settle，把渲染进程挂死。
> in-app 面板可见，且**无 autoplay 闸门**（`ctx.state` 无手势直接是 `running`，与微信 DevTools
> 同样的行为）。**下一个人要在真 Chrome 里量，得先解决标签页可见性，不要在隐藏标签页上浪费时间。**

| cue | 样本（新） | 合成音（旧，§0/§0.2） | 比值 | 抖动 新 → 旧 |
|---|---|---|---|---|
| `sfx.base.hit` | 0.15120 | 0.1510 | **1.00×** | **0% ← 21%** |
| `sfx.card.play` | 0.14359 | 0.1460 | 0.98× | 3% ← 35% |
| `sfx.spell.cast` | 0.12679 | 0.1290 | 0.98× | 15% ← 17% |
| `sfx.card.invalid` | 0.10409 | 0.1050 | 0.99× | 11% ← 15% |
| `sfx.unit.death` | 0.09791 | 0.0990 | 0.99× | 15% ← 27% |
| `sfx.unit.hit` | 0.09720 | 0.0980 | 0.99× | **4% ← 48%** |
| `sfx.ui.tap` | 0.09198 | 0.0923 | **1.00×** | **2% ← 30%** |
| `sfx.ui.back` | 0.07058 | 0.0706 | **1.00×** | 0% ← 1% |
| `sfx.unit.attack` | 0.05544 | 0.0580 | 0.96× | 30% ← 40% |
| `sfx.ink.tick` | 0.02742 | 0.0280 | 0.98× | **17% ← 0%** |

**八个保留合成音的 cue 逐个复现旧值**（victory 0.13161 / defeat 0.11776 / draw 0.11787 /
reward 0.08915 / error 0.07825 / gacha common 0.06680 · rare 0.07756 · epic 0.10338），说明这一轮
没有碰到它们。

#### ⚠️ 第五条规律：换成样本之后，抖动的成因**翻了个方向**

前四条规律（§0 / §0.2 / §0.3）说的都是合成音世界里的事，其中第三条是「噪声型 cue 抖 27–48%、
音调型 <1%」。样本世界里**这条规律的因果整个换掉了**：

- 大部分 cue 变得**极其稳定**（`unit.hit` 48%→4%、`card.play` 35%→3%、`ui.tap` 30%→2%、
  `base.hit` 21%→**0%**）。原因显然：样本是**固定波形**，每次播放不再重新掷一遍噪声。
- 但 **`sfx.ink.tick` 从 0% 涨到 17%**，`unit.attack` 也仍然是 30%。它不是 variant 差异造成的
  ——ink.tick 两个 variant 的峰值是 0.06968 / 0.06964，几乎一样。真正的来源是
  **`CueMixer` 的 ±3% `playbackRate` 抖动**：重采样会挪动采样点相对波形的落点，而一个**又短又
  尖**的瞬态（水滴 120 ms、铅笔戳 57 ms）的峰值恰好对这件事最敏感。

一句话：**合成音世界里抖的是噪声型；样本世界里抖的是瞬态尖锐的那些**，而这两组几乎不重叠。
所以「比响度至少测 10 次取中位数」这条口径继续有效，但**该盯的 cue 换了一批**。

#### 这一轮**没有**验证到什么

1. **仍然没有人听过任何一个声音**——十轮实测量到的全是「响得对不对」，「好不好听」一个字都没测。
   这不是可以靠加测量解决的缺口，见 §7 第 6 步末尾。
2. **微信侧没有复测。** 微信主包为这批素材 **+0 字节的音频**（22 个 mp3 全部落在 `cdn/`，正如 §5
   那条订正预测的；`ASSET_PACKAGING` 的包体完整性门禁 `checkWechatPackage.mjs` 报 **323 条烘焙
   URL 全部在 `cdn/` 里、单 bundle**）。但那 22 个文件在**微信运行时**的 `decodeAudioData` 上没有
   验过。主包 2197453 → **2199054（+1601 字节）**，涨的全是 `cueAssets.ts` 烘焙进去的 22 条 URL
   字符串。（合入当日分支后是 2199139——多出的 85 字节属于同一天那个微信黑屏修复，不是音频。）
3. **真 Chrome 没有量到**（上面那条可见性告示）。

---

### 0.5 BGM 的实测（2026-09-01，§7 第 7 步 —— **已发货**）

**发货了什么**：一条轨 `bgm.lobby`，`client/src/assets/audio/music/bgm-lobby.mp3`，**653016 字节**、
24 kHz 立体声、**74.0 s 循环**、70.6 kbps VBR，频带电平 **−29.00 dBFS**（250–2000 Hz RMS）、
接缝 **0.57 dB**。母带是**项目自有**素材（`art/audio/sources/first-party/doodle-bed.flac`，13266428
字节，由投进来的 40.9 MB WAV 无损转出——逐样本比对相等），不需要署名。§2.3 的另一条轨 `bgm.battle`
仍然缺 master（brief 在 [`art/audio/suno/BRIEFS.md`](../../art/audio/suno/BRIEFS.md)），**它不在 `MusicTrack` union 里**，所以对局
现在是三处显式的 `music: null`，而不是漏接。

#### ⚠️ 这一轮真正的教训在代码之外：同一件事被做了两遍

§7 第 7 步在同一天被**两个会话各实现了一遍**。先一轮把代码与管线两半都建成，卡在「master 未生成」
上**故意没有合并**（那是对的：`musicCatalogue.ts` 静态 `import` 一个不存在的 mp3，合进去会让主检出
和所有并行会话的构建当场变红——`cueAssets.ts` 那条「缺文件 = 构建失败而非静默无声」的取舍第一次真的
触发），并把恢复步骤写进了记忆。第二轮拿到 master 之后**从零又实现了一遍**，因为开工前只依赖了自动
召回、没有去扫 `index/open.md`。

两份都能跑；留下的是**先一轮**那份，理由是它在两件对床垫最要紧的事上更好，而这两件事恰好都不是
「能不能出声」：

| | 留下的（先一轮） | 弃掉的（第二轮） |
|---|---|---|
| 循环 | 两个 deck + 2 秒**等功率交叉淡入**，接缝由播放器闭合 | `el.loop = true`——而这首自带首尾淡入淡出，于是每 3.5 分钟一次约 2 秒的空档 |
| 电平 | 文件归一到频带 −29 dBFS，**推导见下**，catalogue gain 恒为 1.0 | 保留母带峰值，靠一个 catalogue gain 压下来 |
| iOS | deck 走 `MediaElementSource` + `GainNode` | 每帧写 `el.volume`——**iOS Safari 上那个属性是只读的**，赋值被静默忽略，于是所有淡入淡出在 iOS 上退化成硬切 |

第三行是这次比较里最值钱的一条：它是一个**只在最难验证的那个目标上**发生、且**没有任何报错**的缺陷。
第二轮之所以躲开 `MediaElementSource`，是担心跨源媒体接进 WebAudio 图会变成静音——那个担心是对的，
而解法只是 `crossOrigin = 'anonymous'`，且 CDN 侧不需要任何新配置（SFX 的 `fetch` 本来就要求同一套
CORS 头）。**「这条路有坑」不等于「这条路走不通」**，而绕开它的代价落在了一个当时没想到的平台上。

> **一般规律，写在这里因为它比这次的代码更值钱**：`MEMORY.md` 是三层索引，自动召回只按每条记忆的
> `description` 匹配。**在一个上一轮明确留了未合并分支的领域动手之前，先扫一遍对应的
> `index/<cat>.md`**——那是一次 `cat`，而代价是把同一件事做两遍。

#### ⚠️ 电平目标是 −29 dBFS，**不是** daydayup 的 −30，而且这个数是推出来的

音乐没有可以对齐的合成音（§0.4 那条等式对它不成立），所以电平锚在**频带**上：250–2000 Hz 的 RMS，
也就是全部 18 个 cue 峰值所在的那个带。约束写死成一句可复算的话：**最轻的、但仍然必须听得清的 cue
要站在床上方 10 dB**。那个 cue 是 `sfx.unit.attack`（每场发射次数最多，catalogue gain 刻意最低的
0.7）。`sfx.ink.tick` **被明确排除在这条约束之外**——它是全表最轻、且已经被节流到每 10 点墨一响
的纹理音，拿它当约束会把床再压低 6 dB。

交付比较是两个交付值比：`cue 交付峰值 = 文件峰值 × catalogue gain × 0.8`，
`床交付中频 RMS = 文件中频 × 轨 gain × 0.5`。−29 dBFS 上床交付 **−35.02 dBFS**，梯子是（
`process_music.py` 每次跑完都从 `process.py` 的 `TARGETS` 重新打印一遍，所以电平漂了它仍然得把梯子
亮出来）：

| | | | |
|---|---|---|---|
| base.hit +18.6 | card.play +18.3 | spell.cast +17.2 | card.invalid +15.4 |
| unit.death +14.9 | unit.hit +14.8 | ui.tap +14.3 | ui.back +12.0 |
| **unit.attack +10.3** | ink.tick +4.0 | | |

**这仍然只是一个预测**——它说的是床被放在了正确的位置，不是说它在一局游戏底下好听。

#### 测出来的数（一）：区段是量出来的，而**最好的接缝没有被选中**

`--search` 把母带按 20–30 / 30–45 / 45–60 / 60–75 / 75–90 秒分桶，各报一个最优，用的是**门禁随后
用来验收的同一个度量**（`band_profile` + `profile_diff`，整窗）。这一点是 daydayup 付过三次学费的
地方：排序度量只要比验收度量粗一点、权重不同一点、或者作用在不同的信号上，就会产出「排得好、过不了
门」的候选。

| 桶 | 起点 | 长度 | 接缝 band-diff | 电平差 |
|---|---|---|---|---|
| 20–30 s | 13.5 s | 23.5 s | **0.27 dB** | 0.07 dB |
| 30–45 s | 91.5 s | 30.0 s | 1.83 dB | 0.42 dB |
| 45–60 s | 37.0 s | 49.0 s | 0.58 dB | 0.08 dB |
| **60–75 s** | **12.5 s** | **74.0 s** | **0.58 dB** | 0.09 dB |
| 75–90 s | 75.0 s | 76.0 s | 0.83 dB | 0.23 dB |

选的是 60–75 桶，**不是**接缝最好的 20–30 桶。理由是这个度量看不见的东西：23.5 秒的循环在一个玩家
会坐上几分钟的界面里每 24 秒转一圈，而**一个听不出来的接缝，如果玩家注意到的是重复，就一分钱也不值**。
0.58 dB 是门禁 2.5 dB 的四分之一，而 74 秒是三倍的音乐距离。没有加 low shelf：母带自己的 20–250 Hz
已经比中频低 14 dB，shelf 会去衰减一个本来就不挡路的东西。

#### 测出来的数（二）：交叉淡入回绕，在真浏览器里量到

把 live deck 直接 seek 到接缝前（`lengthS 74.0 − XFADE_S 2.0 = 72.0`），逐帧读两个 deck 的位置与增益：

| 时刻 | deck A 位置 / 增益 | deck B 位置 / 增益 | 交叉淡入中 |
|---|---|---|---|
| 起点 | 70.60 / 0.500 | — / 0 | 否 |
| +1.41 s | **72.01** / 0.500 | **0** / 0 | **是**（回绕触发） |
| +1.81 s | 72.41 / 0.477 | 0.41 / 0.149 | 是 |
| +2.41 s | 73.01 / 0.364 | 1.00 / 0.342 | 是 |
| +3.02 s | 73.62 / 0.178 | 1.62 / 0.467 | 是 |
| +3.42 s | 74.03 / 0.031 | 2.02 / 0.499 | 是 |
| +3.62 s | **停止** / 0 | 2.22 / **0.500** | 否 |

三件事被这张表一次证实：回绕**正好**发生在 `lengthS − XFADE_S`；两端是**等功率**的
（中点 0.364² + 0.342² = 0.2495 ≈ 0.5²，线性淡入在这里会掉 3 dB，一分钟一次、永远）；淡出结束后那个
deck 是被**停掉**的，而不是留在增益 0 上继续解码。稳态增益 0.500 = 总线（master 1 × bgm 0.5）× 轨
gain 1.0，与 −29 dBFS 的文件相乘正是上面那个 −35.02 dBFS。

> **量它花掉的力气本身是一条环境笔记**：本机能驱动的两个浏览器面**都是后台标签页**
> （`document.hidden === true`），而后台标签页里 **`requestAnimationFrame` 是冻住的**——于是
> PIXI 的 ticker 不跑，`SceneManager.onTick` 不跑，这套每帧推导的音乐**一个字节都不会动**。
> 所以上表是**手动驱动 `manager.onTick()`**（真的那个，不是替身）+ 真实墙钟间隔量出来的。
> 这也顺带说明：**每帧推导这个形状，在没有 rAF 的宿主上是彻底静默的**；它对生产没有影响
> （玩家的标签页在前台），但任何后续的无头测量都必须知道这一点。

#### 测出来的数（三）：ducking 在真实 stinger 下的包络（2026-09-01，事后补测）

上面那条环境坑第二次咬人：这次能驱动的是**真实 Chrome**（`claude-in-chrome` 插件而不是 in-app
面板），但插件驱动的标签页同样报 `document.hidden === true`（大概率是自动化窗口拿不到 OS 级焦点，
Page Visibility API 不看"标签页是不是当前活动标签"，看的是"这个浏览器窗口有没有焦点"）——所以还是
手动驱动，这次是 `app.ticker.update(t)`（PIXI 的 ticker 方法本身不检查可见性，只有**调度**它的那层
rAF 会被冻结，直接调用绕开了那一层）。用真实 `ContextAudioBus.play('sfx.result.victory')`（不是
`player.requestDuck()`）触发，逐帧读 `__nwAudio.music()`：

| 累计 ms | duck | deck 增益 | 阶段 |
|---|---|---|---|
| 16 | 0.89 | 0.445 | 攻击中 |
| 80 | 0.45 | 0.225 | 攻击结束 |
| 160–520 | 0.45 | 0.225 | 保持 |
| 620 | 0.5286 | 0.2643 | 释放开始 |
| 920 | 0.7643 | 0.3821 | 释放中 |
| ≥1500 | 1.0 | 0.5 | 完全放回 |

四个常数（攻击 80 ms / 保持 500 ms / 释放 700 ms / 底 0.45）与源码逐帧吻合，包括一个一帧的量化细节：
保持计时器在**上一帧**的值决定这一帧用哪个目标增益，所以释放不是恰好在第 500 ms 那一帧开始，而是在
跨过 500 ms 边界的**下一帧**——60 fps 下差不超过 16 ms，听不出来，但解释了"为什么不是整百的边界"。

这张表本身是一次性的（手动驱动出来的，不会再跑第二遍）；**沉淀下来的是**
[`client/test/browser/audioDucking.spec.ts`](../../client/test/browser/audioDucking.spec.ts)——
同一条链路，但跑在 Playwright 自己的浏览器里，那边**没有**这个 `document.hidden` 坑（连跑四次都过），
所以它不需要手动驱动 ticker，真墙钟等待即可。两者的关系：上面这张表是"这次测出来数字对不对"的一次性
证据，那条测试是"以后还对不对"的常驻回归——**它验证的是接线（cue 名字 → `DUCK_CUES` → 真
`GainNode`），不是好不好听**，`MusicPlayer.test.ts` 原有的包络单测完全不经过 `ContextAudioBus.play()`
所以看不见接线断掉。详见 [[audio-ducking-wiring-verified-2026-09-01]]。

#### 与 daydayup 的三处不同，**都是删减**

1. **deck 只有一个增益入口 `setGain`。** 那边 web 有一个上游的 music `GainNode`、微信没有音频图，
   于是「总线音量」和「本 deck 的淡入位置」是两个分别存储、各自触发重算的量。这里两个平台都把整个
   乘积 `fade × bus × duck` 在平台中立的一侧算完再推给 deck——乘积只在一处成形，两个 deck 实现
   于是没有形状差异。
2. **没有 `invalidate()`。** 那边需要它是因为音乐在一个可能还没下载完的**分包**里；本项目按
   ASSET_PACKAGING §4 方案 A 把全部资源托管在 CDN（见 §5 那条被划掉的「首包体积」），没有会迟到的
   分包，所以那会是一条没人调用的恢复路径。
3. **没有移植 `loop` 门禁。** 那边同时有 `loop` 和 `music` 两个 gate class，`loop` 要求
   `step_db ≤ −50`（末样本紧挨首样本），那是 `el.loop = true` 需要的。**MP3 两端都被补齐到帧边界，
   样本级精确回绕根本不存在**，所以两边的播放器都是交叉淡入——移植 `loop` 等于为一条本客户端没有的
   机制立一条门禁。这条判断也顺带订正了 §5 那一行（见那里）。

#### 测出来的数（三）：打包

- BGM 落在 `client/src/assets/audio/music/` 一个**子目录**里，而 §5 的 CDN 外置是按扩展名走的
  `asset/resource` 规则——实测子目录**不改变任何事**：23 个 mp3 照样烘成 `wechatgame/cdn/<hash>.mp3`，
  `checkWechatPackage.mjs` 报 **324 条烘焙 URL 全部在 `cdn/` 里、单 bundle**。
- 微信主包 2197453 → **2206391（+8938 字节）**，涨的是整个 BGM 运行时（播放器 + 两个 deck + 目录 +
  接线）。距 4 MB 红线仍有大量余量。
- **区段长度直接就是下载量**：74 秒 653016 字节。当初担心的 `dist.total` 余量（带占位估到约 95.9%）
  没有兑现——它是按 daydayup 两轨 500–620 KB 估的，而这里只发货了一轨。第二条轨落地时要重新量。

#### 顺带修的两处，都是「我们自己的声明挡住了运行时」那一族（同 §0.3）

- `wx.d.ts` 的 `IInnerAudioContext.onError` 原先声明成 `cb: () => {}`——一个**不收参数、返回一个
  对象**的回调。于是音频失败里唯一有用的东西 `errMsg` 在每个调用点都是取不到的。同一个文件里另外
  三处 `onError` 早就是对的形状。
- `WechatAudioBus.ts` 的头注释原先写「`InnerAudioContext` 的正当用途只剩 BGM（单实例、流式、
  `loop=true`）」。前两个成立，**第三个不成立**，成因与 §7 第 5 步那条错判一模一样：照着 API
  表面**能做什么**推断，而没有先问这个**格式**允许什么。

#### 这一轮仍然没有验证到什么

1. **还是没有人听过。** 而且这一轮**尝试过并失败了**：两个浏览器面都是后台标签页，Chrome 在那里
   推迟媒体加载、冻住 rAF。上面全部数字是驱动生产路径量出来的，但它们量的是「响得对不对」。
   「大厅里循环 74 秒会不会烦」「床和笔尖声打不打架」只有人坐下来听才知道。
2. `bgm.battle` 仍然缺 master，对局仍然安静。
3. 微信真机未验；ducking 已实现但**从未在真实 stinger 下听过**。

---

## 1. 美学基线（引自 art-direction，不在此复述）

一句话锚点：**轻巧、卡通、非写实的"文具拟音"**——铅笔沙沙、橡皮擦、翻笔记本页、笔帽咔哒；**禁止**金属碰撞、爆炸轰鸣等写实战争音效。所有音效服从「我蓝敌红 / 手绘笔记本」的整体调性。细节见 art-direction §声音。

---

## 2. 资产清单（最低可上线集 = MVP）

> 对齐 [`../product/mvp-gaps.md`](../product/mvp-gaps.md) §8「基础音效」。
>
> **素材状态（2026-09-01，§0.4）**：下面两张表里带 **🔊** 的 cue 已发货真实样本，带 **〜** 的
> **刻意**只有合成音（不是待办——理由逐条写在 `art/audio/credits.json` 的 `kept_on_synth`，摘要在
> §0.4「这一步真正的决定」）。来源与授权在 `art/audio/packs.json`，每个文件的出处、处理参数与挑选
> 理由在 `art/audio/credits.json`，管线在 [`tools/audio-pipeline/`](../../tools/audio-pipeline/README.md)。
> 四个来源全部可商用且**无需署名**。

### 2.1 战斗内 SFX（一次性短音）
| 事件 id | 触发 | 拟音建议 | 已发货素材 | 优先级 |
|---|---|---|---|---|
| `sfx.card.play` | 出牌/落子 | 笔尖落纸"唰" | 🔊 3 个（白板马克笔一笔 / 铅笔书写 / 签名起笔） | P0 |
| `sfx.card.invalid` | 费不够/非法出牌 | 橡皮擦短"吱" | 🔊 3 个（白板笔擦声 —— CC0 里**根本没有橡皮擦**，而马克笔的"吱"本身就是文具声，见 §0.4） | P0 |
| `sfx.unit.attack` | 单位攻击 | 铅笔短戳 | 🔊 2 个（铅笔落纸 / 签名起笔截到 60 ms） | P0 |
| `sfx.unit.hit` | 单位受击 | 软"噗"/揉纸 | 🔊 3 个（闷的单次撞击，**不是**沙沙声——沙沙的起振都在 200–400 ms，见 §0.4） | P0 |
| `sfx.base.hit` | 基地受击 | 厚本子闷响 | 🔊 **1 个**（整池里唯一同时够低、够快、零削波的文件；被否掉的三个近似候选写在 credits.json） | P0 |
| `sfx.spell.cast` | 法术（陨石等） | 翻页+落石涂抹 | 🔊 3 个（翻页） | P1 |
| `sfx.unit.death` | 单位阵亡 | 纸团揉碎 | 🔊 3 个（揉纸 / 揉干叶——同样的多颗粒） | P1 |
| `sfx.ink.tick` | 墨滴回涨节点（每回涨 10 点墨一声，不是每一点——理由见 §0.1） | 水滴"嘀" | 🔊 2 个（单滴水） | P2 |
| `sfx.result.victory` / `.defeat` / `.draw` | 结算（`game_over` / `game_draw`，写在一次性门内部） | 三音上行 / 二音下行 / **同音重复、音高不动** | 〜 **刻意保留合成音**：三者共享同一个起始音高，语义住在「之后往哪走」这个**关系**里，捡回来的录音只能替换掉它 | P0 |

### 2.2 UI SFX

全部已接（2026-08-31，§7 第 4 步）。「出口」一列是**唯一**发这个 cue 的地方——新增触发点时改那里，不要在别处调 `playSfx`。除下表四行之外还有第五个出口：`SettingsScene/audioPanel.ts` 的音量滑杆在**松手**时试听一声 `sfx.ui.tap`（滑杆刻意不是 hit，理由见 §0.2 (B)）。

| 事件 id | 触发 | 出口 | 已发货素材 | 优先级 |
|---|---|---|---|---|
| `sfx.ui.tap` | 按钮/格子点击 | `ui/hits.ts` 的 `runHit` 默认值——命中表走 `dispatchHit`/`hitAction`，PIXI 原生监听走 `tapHandler(fn)`，两条都汇进 `runHit` | 🔊 **1 个**（Kenney `select_002`）。刻意只有一个：同一个按钮每次按下答出不同的声音读起来是「不一致」，而 variant 是抗重复疲劳的手段——按钮音的重复本身就是它的语义 | P0 |
| `sfx.ui.back` | 返回/关闭 | 同上，hit 上写 `sound: 'sfx.ui.back'` / `tapHandler(fn, 'sfx.ui.back')`（27 处 `hdr.backRect` + 模态 dismiss 遮罩 + 对话框 Cancel + 结算页返回芯片） | 🔊 **1 个**（Kenney `back_002`，1833 Hz——包里最干净短文件中中心频率最低的那个，于是「离开」压在「进入」之下，与合成音那个 620→430 下滑建立的是同一个关系）。同样刻意只有一个 | P1 |
| `sfx.ui.reward` | 领奖/获得物品 | 同上，写在各 claim 按钮的 hit 上（成就/日常/周常/活动/战令/充值里程碑） | 〜 **刻意保留合成音**：两音上行的短 chime，而 CC0 里的替代品是数字确认音——正是 art-direction §10 要躲开的那种「没有灵魂的 app UI」 | P1 |
| `sfx.ui.gacha.reveal.common` / `.rare` / `.epic` | 盲盒揭示，按稀有度分层。实现成**三个独立 cue** 而不是一个 cue 的三个 variant：variant 是抗重复疲劳的随机取样，语义分层必须可寻址，否则调用方无法表达"这一抽是史诗" | `GachaScene/core.ts` 的 `revealCue(results)`，**一次抽一声**、取这一抽里最好的稀有度（legendary 并入 epic） | 〜 **刻意保留合成音**：三档是同一把声音逐档加音、加亮，于是「史诗」在第三个音落下之前就已经和「普通」分开。这是三个 cue 之间的**关系**，样本只能靠碰巧复现 | P1 |
| `sfx.ui.error` | 失败/余额不足 toast | `net/log.ts` 的 `showToastMessage`，仅 `kind === 'error'`（不是 hit：失败来自异步结果）。**经 `raiseErrorCue()` 前沿节流，400 ms 一声**——一次失败扇出成多个 rejection 时，视觉层（`GlobalToast.show()` 先 `clear()`）只显示一条消息，音频层原先却会发出 2.4 倍于全表最响 cue 的爆音，实测见 §0.2 (A) | 〜 **刻意保留合成音，而这是唯一一个「有现成素材却否掉」的 cue**：Kenney 的 `error_00x` 形状完全对（daydayup 就发的这个），但一记数字报错嗡音正是 §10 要躲开的调性，而「服务器说不行」这件事在文具世界里**没有对应的手势**（`sfx.card.invalid` 有——那是擦掉写错的东西） | P2 |

### 2.3 BGM（循环长音）
| 轨 id | 场景 | 备注 |
|---|---|---|
| `bgm.lobby` | **除对局之外的一切**（大厅/菜单/商店/世界地图/结算/首启故事） | 🎵 **已发货 2026-09-01**（§0.5）：74 s 循环、653016 字节、频带 −29 dBFS |
| `bgm.battle` | 对战 / 战役关卡内 | ⛔ **缺 master，因此不在 `MusicTrack` union 里**；三个对局场景声明 `music: null`（刻意的安静） |
| `bgm.intro` | 首启故事（IntroScene） | 🎵 **与 `bgm.lobby` 共用**（本表原稿就写着"可与 BGM_lobby 共用"），由 `IntroScene` 省略 `Scene.music` 落到默认值 |
| `bgm.victory` / `bgm.defeat` | 结算短乐句（stinger，非循环） | ✅ 从来就走 SFX 管线，见下 |

> 结算 stinger 走 SFX 管线（一次性），不占 BGM 槽 —— 已实现为 `sfx.result.victory` / `sfx.result.defeat` / **`sfx.result.draw`**（2026-08-31 补齐），是 catalogue 里优先级最高（120）的三个 cue，谁都不许抢。三者互斥（一局只可能以一种方式结束），所以彼此之间没有可排的名次；`cueCatalogue.test.ts` 把「结算档正好三个」钉死，好让第四个"结局"必须是一次有意的编辑。

> **订正（2026-09-01，§7 第 7 步）：这张表上真正是「轨」的只有两条，而 `MusicTrack` union 里现在
> 只有一条。** 这是收敛，不是欠账：
>
> - **`bgm.intro` 不存在。** 上表自己就写着「可与 BGM_lobby 共用」。一条只在首启放一次的独立轨要多
>   付一次生成、一份下载量，和一个几乎不会有人复听的验收。它由 `IntroScene` **省略** `Scene.music`
>   字段自动落到 `bgm.lobby`——不是特判，是默认值。
> - **`bgm.victory` / `bgm.defeat` 从来就不是轨**，上面那条尾注早就把它们归给了 SFX 管线。它们留在
>   这张表里只是历史。
> - **`bgm.battle` 有位置但没有文件，所以它也不在 union 里。** 一条没有 master 的轨如果先进 union，
>   它会以「这个界面就是安静的」的形式存在——而那和设计意图**长得一模一样**，永远不会有人发现。
>   所以对局场景写的是显式的 `music: null`，与「省略」（= 落到大厅床）是两回事。master 到了之后，
>   union、`MUSIC_CATALOGUE`、三处 `music: null` 与 `musicAssets.test.ts` 的轨数断言一起改；
>   缺条目**编译不过**，缺文件**构建不过**，两道门都是硬的。
>
> **⚠️ 合规：BGM 不是 CC0，它的记录必须与 `packs.json` 完全分开。**（这条原先写的是「Suno 生成」；
> 实际发货的 `bgm.lobby` 是**项目自有**素材，而结论一个字都不变——见下面 `music_terms` 那一段。） 22 个 SFX 源
> 全部 CC0 且无需署名，`audioAssets.test.ts` 的 `checkPacks` 断言的正是这一条，`packs.json` 顶层
> 还有 `all_sources_commercial_ok_without_attribution: true`。把音乐填进去只有两种结局，而两种都
> 坏：那条断言变红，或者有人「修好」它——**而一条被削弱的断言比没有断言更糟，因为它对另外 22 个
> 文件的保证从此静默地不再被检查**。所以音乐走 `credits.json` 里独立的 `music` / `music_terms`
> 两段（`note` 里必须用**明确的字面**写着 NOT CC0），**不进 `packs.json`**，另配
> `musicAssets.test.ts`，其中 `checkNotInPacks` **双向**断言这条分隔。形状抄 daydayup，它踩过同一处。
>
> **两条规则按 provenance 分岔（2026-09-01 落地时改的）**：`checkReproducible` 问的是「这个文件还能
> 不能再产出来」，而答案的形状取决于母带是什么——**生成的**母带只以 prompt 的形式存在（必须归档，
> daydayup 丢过一次，其 `credits.json` 里因此留着两条 `prompt_note`）；**项目自有的**母带是一个
> 文件，对应的要求是它在仓库里（`bgm.lobby` 的在，无损 FLAC）。给自有母带强制一个 prompt 字段，
> 等于用一段虚构去满足门禁——正是这条规则本来要挡的东西。`checkTerms` 同理：`terms_url` 只在**存在
> 第三方**时是必填的，而 `accepted_by` / `accepted_on` 两边都必填（「谁把它放进仓库、什么时候」是
> 一条非 CC0 记录里承重的那一半）。

---

## 3. 播放层抽象（`audio/audioBus.ts`）

> **订正（2026-08-31）：不挂在 `IPlatform` 上。** 本节原先写的是 `IPlatform.audio`，实现时改判了，理由：
>
> - `IPlatform` 已经承载 20 余个成员（画布/屏幕/安全区/存储/网络类型/语言/输入/SDK 生命周期/广告/鉴权/socket/IAP/分享）。音频跟它们一个都不耦合：不需要 canvas，不需要 layout，不参与鉴权。塞进去只是让那个接口再长一截，并强迫**四个**平台实现各自给出一个音频成员，而其中三个只想要同一个 web 实现。
> - 本仓库已经有一个正好合用的先例：**`assets/assetIO.ts`**——同样是"平台可替换、但与 `IPlatform` 其余部分无关"的能力，做法就是模块级单例 + 入口 `setAssetIO(...)` 安装一次。音频照抄这个形状，两处接缝于是共享同一个心智模型。
>
> 落地形态：`audio/audioBus.ts` 导出 `setAudioBus(bus)` / `audioBus()` / `playSfx(cue, count?)`，默认值是 `NullAudioBus`。**未安装就是安全状态**，也是测试里的常态——场景测试、UI 冒烟、headless E2E 都不需要打桩音频。

```ts
// client/src/audio/types.ts（已实现）
interface AudioBus {
  preload(): Promise<void>;                 // 拉取+解码已发货样本；启动不 await
  play(cue: AudioCue, count?: number): void; // 一次性；count = 本帧合并的事件数，抬增益不重播
  setSfxVolume(v: number): void;             // 0..1
  setMusicVolume(v: number): void;           // BGM 总线增益
  // 一帧的 BGM（§7 第 7 步，2026-09-01）。传一个已经在放的轨是
  // 空操作——正是这个性质让调用方可以是每帧一次的**推导**（`SceneManager.onTick` 读 `Scene.music`）
  // 而不是一个必须记得调用的事件钩子。
  updateMusic(desired: MusicTrack | null, dtMs: number): void;
  resume(): void;                            // 越过 autoplay 闸门（见 §5）
}
```

与本节原稿的另外三处差异，都是实现时发现原稿的形状不对：

- **`preload(ids)` → `preload()`。** 原稿设想"进场景前预载该场景所需 id"。SFX 全集是 ~100 KB 量级（daydayup 的同类集合实测 101.9 KB / 50 个文件），按场景切分省不下有意义的字节，却要求每个场景维护一份 id 清单——那是一份会腐烂的重复。BGM 是另一回事（单文件就可能几 MB），它落地时会有自己的按需接口。
- **`playSfx(id, {volume})` → `play(cue, count)`。** 单次播放不接受调用方传音量：混音权重是内容决策，住在 `cueCatalogue.ts` 一张表里（§4），否则"为什么攻击音把结算盖住了"要翻十个触发点。`count` 是本帧合并进来的事件数（§4 的合并规则）。
- **`unlock()` → `resume()`，且不需要调用方接。** `WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`。比走 `InputManager` 严格更宽：后者会在场景淡入淡出和模态框期间闸掉指针事件，而 autoplay 闸门只要"用户碰过页面"，被游戏逻辑丢弃的那次点击同样能解锁。§6 里"IntroScene 首 tap 挂 unlock()"这条因此不需要了。

**后端只有一套，平台各自只回答两个问题**（2026-09-01 接微信时抽的，见 §0.3）。`audio/ContextAudioBus.ts` 是平台中立的那一半——总线 GainNode、SFX 音量、`SampleBank`/`CueMixer` 的装配、preload、autoplay 闸门、`loaded` 统计；平台侧注入 `createContext()`（返回 `null` = 这个宿主没有音频设备，静音而不抛出）和可选的 `onGesture(cb)`。

- **Web / CrazyGames / Capacitor iOS 壳**：`platform/web/WebAudioBus.ts`（`AudioContext` + 解码缓冲，低延迟、可并发、好做混音/淡入），SFX 走 buffer source。**没有 `HTMLAudioElement` 降级**：没有 `AudioContext` 的环境（SSR、node 测试、极老 WebView）直接静音，因为那条降级路径无法承载合成音，等于要维护第二套永远测不到的播放实现。
- **微信小游戏**：`platform/wechat/WechatAudioBus.ts`（**2026-09-01 落地**，§7 第 5 步）——`wx.createWebAudioContext()` + `wx.onTouchStart`，另接 `wx.onAudioInterruptionEnd → resume()`（这个运行时没有 DOM，没有 `visibilitychange`，那两个回调是唯一的中断信号；只需要恢复那一半，因为最长的 cue 是几百毫秒，中断开始时早已播完）。**整条管线一行没改。**
  > **订正（2026-09-01）：本节原先写「微信没有振荡器、没有 GainNode，所以整条管线一行都跑不起来」，那是错的**——依据是 `client/src/wx.d.ts` 里只声明了 `createInnerAudioContext`，即把我们自己的类型声明当成了运行时的事实。小游戏从基础库 2.19.0 起就提供标准 WebAudio 表面。本节当时把这条备选写进了脚注、标着「没有设备可验证」；DevTools 实测见 §0.3，真机仍是开放项。
- 资产路径**不用平台资源约定之外的任何东西**：见 §5 的首包体积那一行的订正。

---

## 4. 混音与设置

> **已落地（2026-08-31）**：`audio/audioSettings.ts` + `scenes/SettingsScene/audioPanel.ts`。下面三条中的前两条实现时各有一处改判，就地记在条目里。

- **三档音量**：`master` / `bgm` / `sfx`（0–1）+ **一个** `muted`。实际增益 = `master × 通道`，`muted` 覆盖成 0。
  > **订正：不是「各自 `muted`」，是一个总的。** 原稿给每个通道一个静音位，那是三个开关 + 三根滑杆共六个控件，而它们能表达的状态里绝大多数（"只静音 BGM"）用滑杆拖到底就够了，且更符合直觉。留一个总静音是因为它表达的是滑杆表达不了的东西：**临时**闭嘴、且不丢失现在的档位——所以 `muted` 不清零音量，取消静音直接回到玩家调好的位置。
- **持久化**：一个 JSON 键 **`nw_audio`**（`{master,bgm,sfx,muted}`），与 `nw_locale` / `nw_data_saver` 同级的本地设置。**不上云权威**（纯本地体验设置，无防作弊价值）。
  > **订正：不进 `SaveData.flags`。** 原稿写的是 flags/设置段；实现时改走 `IStorage` 直存，形状抄 `assets/prefetchPolicy.ts`（`installAudioSettings({storage})` 在 `app.ts` 装一次）。理由：`flags` 是**服务端权威**的存档字段，写它要一次 `PUT /flags` 往返，而音量既不需要跨设备一致、也不需要防篡改——把它放进云存档只是给每次拖滑杆加一个网络请求和一条失败路径。四个值合成一个键而不是四个键，是因为它们只会被一起读写，"音量存下了但静音位丢了"没有任何有用的含义。
  > 解析是**逐字段兜底 + 夹到 0..1**：手改过或截断的值退化成默认值，绝不退化成静音——"音频坏了"是最难归因的一类 bug。
- **默认**：`master 1` / `bgm 0.5` / `sfx 0.8`，不静音（`DEFAULT_AUDIO_SETTINGS`）。**那个 `bgm 0.5` 是发货资产电平的另一半**（§0.5）：两条轨被归一到 250–2000 Hz RMS = −29 dBFS，而那个目标就是按 `−29 dBFS × 0.5` 交付推出来的。改这个默认值而不重切资产，等于把整条床相对于 cue 集平移。
- **松手试听（2026-08-31 新增，§0.2 (B)）**：`master` / `sfx` 两根滑杆在 pointer-up 时播一声 `sfx.ui.tap`。**不在拖动中播**——`onDrag` 每次 pointer-move 都跑（实测一次真实拖动约 60–120 次），一次 move 一声就是 §0.1 里 `sfx.ink.tick` 那个机关枪换成手指。`bgm` 不试听：它现在什么都不驱动，用 SFX cue 去试听它是对「这根滑杆管什么」撒谎。落在 `AudioSlider.onRelease` 上而不是场景里，好让「松手响不响」和「响什么」仍然是 `audioPanel.ts` 一处的决定。
- **同瞬叠加是混音的一条硬约束（§0.2 (C)）**：同一个 cue 在同一瞬间播 n 次，**音调型精确线性放大 n 倍**、噪声型只放大约 √n。所以任何**可能被同瞬触发多次**的 cue 都必须走合并（`play(cue, count)`，n=8 时比裸叠安静 5.5 倍）或节流；否则一次扇出发出的声音会比游戏里任何设计音都响一倍多。战斗侧靠 `EventsPanel.flushAudio` 的同帧合并，toast 侧靠 `raiseErrorCue()` 的节流。
- **Ducking（可选 P2）**：盲盒揭示 / 结算 stinger 播放时，BGM 短暂压低再恢复。✅ **2026-09-01 落地**：−6.9 dB，80 ms 压下 / 500 ms 保持 / 700 ms 放回（放回远慢于压下——快速恢复本身就是一个可听见的事件，而 ducking 的整个用意是让人**不**注意到床动过）。触发它的六个 cue 在 `musicCatalogue.ts` 的 `DUCK_CUES` 里，**不在 `cueCatalogue.ts`**：「什么东西该给我让路」是音乐的混音决定，往 `CueDef` 加一个 `ducks` 会要求 18 个 cue 每个都回答一个与它自己无关的问题。重复触发只重新计时、不叠加压低量（十连揭示不该把床压到听不见）。
  > **2026-09-01（后）：包络形状与「cue → 真的会让路」的接线现在两边都测了，「听起来对不对」仍然没有。** `MusicPlayer.test.ts` 一直断言的是前者——它直接调 `player.requestDuck()`，从不经过 `ContextAudioBus.play()`，所以 `sfx.result.victory` 哪天掉出 `DUCK_CUES`、或者 `play()` 里那行 `this.music?.requestDuck()` 被删掉，这套单测**一个都不会红**（编译过、构建过、游戏照玩，症状只是"床不知道为什么没让路"）。补的是 `client/test/browser/audioDucking.spec.ts`：真 `ContextAudioBus.play('sfx.result.victory')` → 真 `DUCK_CUES` 查表 → 真 `MusicPlayer` → 真 `GainNode`，Playwright 真渲染器 + 真墙钟跑一遍攻击/保持/释放/回到 1，四次连跑没翻车（详见 [[audio-ducking-wiring-verified-2026-09-01]]）。**这仍然只是接线验证，不是听感验证**：ducking 的判断刻意放在 SFX 闸门之外（`play()` 里那条注释），所以这条测试在 `AudioContext` 停留 `suspended`（CI 的常态）时同样通过——它证明了「压下去、放回来」这条包络真的传到了真实音频图，没有证明玩家耳朵里那一下听起来对。
- **失焦自动暂停**：页面/小游戏切后台（`visibilitychange` / `wx.onHide`）暂停 BGM，回前台恢复。✅ **2026-09-01 建成**（同上）：走 `ContextAudioBusDeps.onFocusChange`。web 用 `visibilitychange` 而不是 `blur`（后者在点开控制台或另一个窗口时也发，那时游戏仍然可见，停掉音乐只会让人以为它坏了）；微信没有 DOM，用 `onHide`/`onShow`，**并把音频中断接到同一个回调上**——对一条 60 秒的床来说「切出去了」和「来电话了」要的是同一件事。

---

## 5. 平台约束（必须处理，否则"没声音"）

| 约束 | 平台 | 处理 |
|---|---|---|
| **autoplay 限制**：首次音频必须在用户手势后才能响 | Web（所有现代浏览器）/ iOS Safari | 首个 tap（IntroScene/LoginScene 任意首次交互）调 `audio.unlock()` 解锁 `AudioContext`；解锁前的 BGM 请求排队，解锁后补播 |
| **iOS WebAudio 需手势解锁** | iOS 网页 | 同上，`AudioContext.resume()` 必须在手势回调内 |
| **同时音频实例数有限** | 微信小游戏 | ~~SFX 走对象池（如 8 个 InnerAudioContext 轮转）。~~ **订正 2（2026-09-01，§0.3）：`InnerAudioContext` 对象池不需要了。** 微信走 `wx.createWebAudioContext()`，SFX 与 web 共用 `audio/` 那条管线，而对象池真正想要的「并发上限 + 优先级抢占」本来就在平台中立的 `VoiceBudget.ts` 里，两个平台共用一份。`InnerAudioContext` 剩下的正当用途只有 BGM（单实例、流式，§7 第 7 步）。**订正 3（2026-09-01，§0.5）：上一句原先写的是「单实例、流式、`loop=true`」，第三个不成立**——MP3 两端被补齐到帧边界，样本级精确回绕根本不存在，而原生 `loop` 要么样本级精确要么不循环。BGM 用的是**两个** `InnerAudioContext` 交叉淡入，两边的 `loop` 都显式设成 `false`。下面这条**订正 1** 仍然成立，它描述的是 `VoiceBudget` 的语义：<br>**丢弃规则不是"最旧"而是"按优先级抢占"**——最旧那个很可能正是一局一次的结算 stinger，而新来的是第 40 个攻击音；丢最旧会砍掉唯一那次胜利音，换来一个听不出区别的攻击音。已实现于 `audio/VoiceBudget.ts`（同优先级判输，被抢占者 12ms 淡出而非硬切；按**时间**退休而不靠 `ended` 事件，因为一个"悄悄停止清扫"的上限会失效于静默——前 N 个 cue 之后混音直接变哑，看起来就是"音频坏了"） |
| ~~**首包体积**~~ | ~~微信小游戏~~ | **订正（2026-08-31）：这条约束对本项目不存在。** 原稿写"BGM 放分包/CDN 按需拉，首包只带 P0 SFX"，那是通用建议；而本项目按 ASSET_PACKAGING §4 的**方案 A** 早已把**全部**美术资源托管在 CDN（`asset/resource` 的 `publicPath = NW_ASSET_CDN`，产物进 `wechatgame/cdn/`，由 `project.private.config.json` 的 `packOptions.ignore` 排除出主包），主包是**纯代码 ~1.5 MB**。音频文件走同一条规则、同一个 `assetIO`，天然落在 CDN 上，**一个字节都不进主包**——所以"首包只带 P0 SFX"这个取舍不需要做，BGM 也不需要为体积单独分包。真正要留意的是**下载量与缓存**（同 §16 的资源预算口径），不是包体红线。<br>实测（2026-09-01，微信后端落地后）：微信主包为音频总共多付 **10441 字节**（2187088 → 2197453），其中**播放引擎本身 8546 字节**（2188907 → 2197453），此前三轮的 1819 字节全是触发表的 cue 字符串字面量。距 4 MB 主包红线仍有大量余量 |
| **解码开销** | 全平台 | **启动时 `preload()` 全量**（`app.ts` 在 L0 闸门之后 fire-and-forget，不 await）。订正原稿的"进场景前 preload 该场景所需 id"：SFX 全集是 ~100 KB 量级，按场景切分省不下有意义的字节，却要每个场景维护一份会腐烂的 id 清单。suspended 的 `AudioContext` 照样能解码，所以这一步既不需要网络闸门也不需要 autoplay 手势。BGM 落地时按轨流式，另说。<br>实测（2026-09-01，素材落地后）：**22 个文件 / 57578 字节全部解码成功**，`loaded()` 报 `{cues:10, variants:22}`；"~100 KB 量级"这个估算落在真实数字的两倍以内。解码确实在 suspended 上下文里完成——`__nwAudio.samples()` 就是靠这一点做到全程无手势的（§0.4） |

---

## 6. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| BGM 运行时 | ✅ **2026-09-01**（§7 第 7 步 / §0.5）。`audio/MusicPlayer.ts`（两个长期存活的 deck，**一条等功率包络同时服务循环回绕和换轨**）+ `audio/musicCatalogue.ts`（目录 + `XFADE_S` + `DUCK_CUES`，也是 BGM 的 `import` 所在）+ `platform/{web,wechat}/*MusicDeck.ts`。**四个入口一行没改**——它们装的后端本来就都是 `ContextAudioBus`。回绕在真浏览器里量到：正好在 `lengthS − XFADE_S` 触发，两端等功率（中点功率和 = 稳态²），淡出结束后那个 deck 被**停掉**。微信主包 +8938 字节 |
| BGM 素材 + 授权 | ✅ **2026-09-01**。`client/src/assets/audio/music/bgm-lobby.mp3`（653016 字节、74.0 s、频带 −29 dBFS），母带 `art/audio/sources/first-party/doodle-bed.flac`（无损，项目自有、无需署名）。区段由 `--search` 按门禁**同一个**度量挑出（0.58 dB / 74 s，**不是**接缝最好的那个候选，理由见 §0.5）。记录走 `credits.json` 的 `music` / `music_terms`，**不进 `packs.json`** |
| BGM 的门禁 | ✅ **2026-09-01** `client/test/audio/musicAssets.test.ts`（13 条纯规则 + 23 例变异）+ `audit.py --class music` + `selftest.py` 105 项。**最要紧的一条是 `lengthS` 仍然等于文件真实时长**——回绕在 `lengthS − XFADE_S` 触发，漂了就把交叉淡入放在一个门禁从未测量过的位置上，而文件照样能加载、能播、能过 `audit.py`，唯一症状是循环每分钟踉跄一次 |
| BGM 触发（哪条轨） | 🚧 同上。`Scene.music?`（**省略 = 大厅床**，与 §7 第 4 步 `Hit.sound` 同一个默认值形状；`null` = 静音）+ `SceneManager.onTick` 每帧推导。全仓库只有三个场景不走默认值：`GameScene` / `ReplayScene` / `StatePlayerScene`。**刻意不按场景名查表**：`setActiveScene` 那个现成漏斗取的是 `constructor.name`，production webpack 会把它混淆——ANR 归因能忍，音乐不能 |
| BGM 资产门禁 | 🚧 同上。`client/test/audio/musicAssets.test.ts`——13 条纯规则 + **22 例变异测试**（§0.4 那条教训：门禁写完当天就要写变异测试）。最该看住的一条是 **`lengthS` 仍然等于文件真实时长**：回绕在 `lengthS - XFADE_S` 处触发，长度漂了就把交叉淡入放到了 `xfade_band_diff` 从没测量过的地方，而文件照样加载、流式、播放、过 `audit.py`，唯一症状是循环每分钟踉跄一次 |
| 平台音频抽象 | ✅ `audio/audioBus.ts`（模块级接缝，**不是** `IPlatform` 成员——见 §3 订正）+ `audio/ContextAudioBus.ts`（平台中立的后端，2026-09-01 从 `WebAudioBus` 抽出）+ 两个各约 15 行的平台半边：`platform/web/WebAudioBus.ts` / `platform/wechat/WechatAudioBus.ts` |
| 微信音频后端 | ✅ **2026-09-01**（§7 第 5 步）。`wx.createWebAudioContext()`，管线原样复用，**不需要** `InnerAudioContext` 对象池（§5 订正 2）。`wx.d.ts` 补了三条声明（`createWebAudioContext` 声明为**可选**——低版本基础库真的没有，`ContextAudioBus` 把那种设备降级为静音）。DevTools 实测见 §0.3；**真机是开放项**，三件待验的事列在那一节末尾。微信主包 +8546 字节，播放引擎首次进包 |
| cue 词汇表 + 混音表 | ✅ `audio/types.ts`（**18 个** cue，2026-08-31 补入 `sfx.result.draw`）+ `audio/cueCatalogue.ts`（gain/priority）。往 union 里加 cue，在 catalogue 里给它决策之前**编译不过** |
| 程序化合成音（**8 个 cue 的永久声源** + 另外 10 个的兜底） | ✅ `audio/audioSynth.ts`，每个 cue 一把，文具拟音方向。**没有人听过**。自 2026-09-01 起它对 8 个 cue 不再是"占位"而是**发货实现**（§0.4 那条分界线），对另外 10 个是逐文件的兜底——任何一个样本拉不到/解不开，只有那个 variant 退回这里 |
| 样本加载 / 解码 / 并发上限 / 混音器 | ✅ `SampleBank` + `decodeAudio` + `VoiceBudget` + `CueMixer`，79 个用例 / 99.4% 行覆盖 |
| 资产文件 + 命名约定 | ✅ **2026-09-01**（§7 第 6 步 / §0.4）。`client/src/assets/audio/` 下 **22 个文件、57578 字节**，命名 `<cue id 的 '.' 换成 '-'>_NN.mp3`；webpack 的 `asset/resource` 规则原样涵盖，`custom.d.ts` 已声明 `*.mp3`，一行配置没改。10 个 cue 有样本、8 个刻意保留合成音。来源 `art/audio/packs.json`，逐文件出处与理由 `art/audio/credits.json`，管线 [`tools/audio-pipeline/`](../../tools/audio-pipeline/README.md) |
| 资产完整性门禁（每次提交都跑） | ✅ **2026-09-01** `client/test/audio/audioAssets.test.ts`（44 例）——不需要解码器也不需要 Python：按 MPEG 帧头解析 22 个 mp3，把磁盘文件 / `credits.json` / `packs.json` / `cueAssets.ts` / `AudioCue` union / 活的 `CUE_CATALOGUE` 六者互相钉住。**最该看住的一条是 `catalogue_gain` 仍然等于 `cueCatalogue.ts`**——改一个 gain，22 个文件的峰值对齐就悄悄失效，而文件照样能加载、能播、过掉其它所有测试，唯一症状是混音偏离了设计。结构是**十条纯规则 + 一套变异测试**（逐条把契约打坏、断言对应规则会红，标准同 `checkWechatPackage.mjs`：「a gate nobody has seen fail is not a gate」）。写那套变异测试**当场揪出它自己第一版看不见的两个洞**：①**没有任何用例验证「某个 cue 指向的是它自己的录音」**——把两个 cue 的 import 数组互换，全部旧用例照绿，而游戏两边都放错声音；②同一段录音被当成两个 cue 发货（`stroke_632474.ogg` 差一点同时进 `card.play` 和 `unit.attack`）。两者现在各是一条规则 |
| 解码峰值的测量面 | ✅ **2026-09-01** `entries/web-e2e.ts` 的 `__nwAudio.samples()`——报每个**已解码** buffer 的峰值，这是管线**结构上无法自证**的一件事（它在**有损编码之前**对齐峰值）。不依赖 autoplay 手势。实测偏差 −6.1%…+6.7%（§0.4） |
| 触发埋点：游戏事件 → `playSfx` | ✅ 2026-08-31。单一漏斗：`render/GameRenderer/core.ts` 的 `for (const event of state.events) this.events.handleEvent(event, state)` 之后跟一次 `this.events.flushAudio()`；映射表全在 `render/GameRenderer/events.ts` 的 `EventsPanel.collectCue` 一处（**不在纯引擎层**——音频是表现层，`@nw/engine` 一行没动）。完整映射与实测见 §0 / §0.1。<br>那个已知的坑按预期咬人了：game over 后引擎 `step()` 提前返回、**不排空事件队列**，重复被消费的是**最后一帧的整批事件**（不只是 `game_over`），所以 `collectCue` 第一行就是 `if (this.core.gameEnded) return`，胜负 stinger 则写在 `game_over`/`game_draw` 分支里那个已有的一次性门**内部**。真浏览器三局复测：每局 stinger 恰好 1 次 |
| UI 触发埋点 | ✅ 2026-08-31。先抽了 `ui/hits.ts`（共享 `Hit<S>` + `inRect`/`hitTest`/`runHit`/`dispatchHit`/`hitAction`/`tapHandler`），**22 份重复的 `interface Hit` 全部消失**，十几处内联的 `hitRects: { rect; action }[]` 一并收敛、`action` 改名 `fn`；UI cue 只在 `runHit` 一处发出，`sound` 省略即 `sfx.ui.tap`。覆盖三族按钮：①场景自持的矩形表；②战斗 HUD / 世界地图 HUD 的手写 `overRect` if 链；③**PIXI 原生 `pointertap` 按钮**（结算页 + 回放 + 五个对话框，第一遍漏掉的 22 处，见 §0 的 ⚠️）。防复发靠源码守卫 `test/uiTapSoundCoverage.test.ts` |
| 设置页音量项 | ✅ 2026-08-31。`scenes/SettingsScene/audioPanel.ts`（右栏，三根滑杆 + 静音开关）+ `audio/audioSettings.ts`（`nw_audio` 一个 JSON 键）。滑杆**不是 hit**：它要跟手，所以留在 `audioSliders: { rect; onDrag; onRelease? }` 里，按下即接管指针、`update()` 每帧最多重绘一次（render()-per-pointermove 会卡）。<br>**§0.2 订正了两件事**：①版面撞在贯穿整宽的语言按钮行上（滑杆先查 hit 后查，所以是**静默**吃掉半个 Deutsch 按钮），已搬到 `0.60w / 0.30h` 并配 `test/ui/settingsSliderOverlap.ui.ts` 守着「滑杆矩形不许与 hit 矩形相交」；②「跟手好让玩家听到档位」这句话原本是假的（拖动一声不响、又没有 BGM），现在 master / sfx 松手时试听一声 `sfx.ui.tap`，实测试听峰值与档位严格成正比 |
| 首启解锁手势 | ✅ 不需要调用方接：`WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`（见 §3） |
| 盲盒/结算 stinger | ✅ 2026-08-31。结算 stinger 在 `EventsPanel`（§7 第 3 步），盲盒揭示在 `GachaScene/core.ts` 的 `revealCue()`——**一次抽一声**，取这一抽里最好的稀有度 |
| 微信冒烟入口 | ✅ **2026-09-01** `entries/wechat-e2e.ts`（`npm run build:wechat-e2e`）——`web-e2e` 的小游戏孪生，永不发布。不启动游戏，直接构造 `WechatAudioBus`、在 SFX 总线挂 `ScriptProcessorNode` 读逐样本峰值，报告写 `wx.env.USER_DATA_PATH`（DevTools 里是磁盘真实目录，于是整轮无头）。**必须是一个入口而不是往运行中的游戏里注入脚本**：小游戏包是单个自执行 IIFE、什么都不导出，而 DevTools 的自动化端口说的是**小程序**协议——`miniprogram-automator` 连得上但 `evaluate`/`callWxMethod` 永不返回（§0.3 实测）。报告有三个出口（文件 / `GameGlobal.__nwAudioProbe` / `console.log`），理由见 §0.3 |
| 浏览器冒烟入口 | ✅ `entries/web-e2e.ts` 暴露 `window.__nwAudio`：`play(cue)` / `resume()` / `cues` / `loaded()` / `log()` / `clearLog()`（总线包一层的 cue 流水账——AnalyserNode 只告诉你“响了、多响”，告诉不了你“响的是哪个 cue、合并了几个事件”，而一局里 cue 飞得比人眼快），**加 2026-08-31 新增的 `nodes()`**——直接交出 `AudioContext` 与 SFX 总线 `GainNode`，好让冒烟自己挂 `ScriptProcessorNode`/`AnalyserNode` 量**交付**峰值。必须是一个显式接缝而不是事后 patch：`app.ts` 的 `preload()` 启动时就建好了上下文，patch `AudioNode.prototype.connect` 永远晚一步（§0.2 开头那两个坑） |

> **架构红线**：音频是**表现层**，触发点放在 render/scene 层订阅引擎事件，**不污染 `client/src/game`（纯 TS 确定性引擎）**——与 PIXI 渲染同级处理，保证引擎/回放/裁判确定性不受音频影响。

---

## 7. 待办（开发顺序）

1. ~~平台音频抽象 + Web(WebAudio) 实现 + 首手势解锁。~~ ✅ 2026-08-31（形态改判为模块级接缝，见 §3）
2. ~~cue 词汇表 + 混音表 + 程序化合成音 + 样本加载/解码/并发上限/混音器。~~ ✅ 2026-08-31
3. ~~**战斗触发点**。~~ ✅ 2026-08-31（`EventsPanel.collectCue` + `flushAudio`，含同帧合并与 game-over 一次性门；真浏览器实测见 §0.1）。留下的两个口子**现在都补完了**：`sfx.card.invalid` 在第 4 步接上（客户端判的非法出牌，引擎不发事件）；`sfx.result.draw` 在第 6 步接上（见那一条）。
4. ~~**UI 触发点**：先抽共享 hit 表 + 派发器（消掉 22 份重复的 `interface Hit`），再在那一处挂 `sfx.ui.*`；`SettingsScene` 三档音量 + 静音持久化。~~ ✅ 2026-08-31（`ui/hits.ts` + `audio/audioSettings.ts` + `SettingsScene/audioPanel.ts`；顺带补上了上一轮留下的 `sfx.card.invalid`。完整说明见 §0）。**真浏览器实测已补完**（§0.2），抓出并修掉两个缺陷：音量区版面撞语言按钮行（静默吃掉半个按钮）、`showToastMessage` 的错误音扇出成 2.4 倍爆音；顺带补上滑杆的松手试听。
5. ~~微信 `InnerAudioContext` 后端 + 对象池（**不需要为体积分包**，见 §5 订正）。~~ ✅ **2026-09-01**——但**形状与这一条写的完全不同**：走 `wx.createWebAudioContext()`，整条管线原样复用，**没有对象池**（§5 订正 2：池真正想要的东西早在 `VoiceBudget.ts` 里）。拦住这一步的一直是我们自己的 `wx.d.ts` 缺声明，不是平台。落地与实测见 §0.3。**真机验证仍是开放项**（三件事列在 §0.3 末尾）；`entries/wechat-e2e.ts` 就是为那次复测留的。
6. ~~**音频素材**（+ 平局 stinger）。~~ ✅ **2026-09-01**（落地与四项实测见 §0.4）。
   - ~~平局没有 stinger（词汇表缺 `sfx.result.draw`）。~~ ✅ 2026-08-31：真浏览器交付峰值 0.1179（与失败 0.1178 齐平）。过程与那条「音调型 cue 的峰值取决于音符有没有重叠」的新规律见 §0.2 (E)。
   - **发货形态与本条原先的设想有一处根本不同：不是「把 `cueAssets.ts` 填满」，是填 10 行、留 8 行空。** 原稿把这一步整个当成采购问题（「战斗音必须另找纸质 foley 或自录」），而实际做下来最关键的判断是**哪些 cue 不该换**——三个结算 stinger、`ui.reward`、三档 gacha、`ui.error` 的语义住在**音与音的关系**里（共享起始音高、逐档加音加亮），录音只能用别人的调性替换掉那个关系。`sfx.ui.error` 甚至是「有现成且形状完全对的素材却否掉」。两级阶梯（有样本用样本、没有用合成音）本来就是为这件事设计的，所以**代码一行没改**。逐条理由在 `art/audio/credits.json` 的 `kept_on_synth`。
   - **来源**（全部可商用、**无需署名**）：freesound.org 逐条筛 CC0（17 个，唯一**可查询**的源，也是 `sfx.card.invalid` 能存在的唯一原因——Kenney 和 BigSoundBank 里**根本没有橡皮擦**）/ BigSoundBank（2 个，CC0、无需账号）/ Kenney Interface Sounds（2 个，六个音频包里唯一不落在 art-direction §10 禁用清单里的那个）/ OpenGameArt Luckius（1 个）。本条原稿说「战斗音必须自录」——事实是纸质 foley 的 CC0 池子比预想深得多（单是 `paper crumple` 就 261 条），**一个字都不用自录，也没有用 AI 生成**。
   - ~~素材到位后**按合成音峰值对齐**再进仓。~~ ✅ 落成一条可闭式验算的等式：`文件峰值 = 实测交付峰值 / (catalogue gain × 总线 0.8)`，在 `sfx.ink.tick` 上验算成立（0.07 × 0.5 × 0.8 = 实测的 0.0280）。实测活体交付峰值 **0.96–1.00×** 于它替掉的合成音，`cueCatalogue.ts` 一个数都没动。
     > **⚠️ 订正（2026-08-31）：本条原先写的是「`tone`/`noise` 两个原语的峰值就是它们的 `gain` 参数，所以这一步不需要重新渲染测量」——这句话已经被两轮实测各证伪一次。** §0 发现噪声过一道低通会损失取决于截止频率的能量（`sfx.unit.hit` 授权 0.15、交付 0.063）；§0.2 (E) 发现音调型 cue 的峰值还取决于**音符有没有重叠**（`sfx.result.draw` 授权 0.12、交付 0.0943，只因两个音刻意不重叠）。所以对齐的基准**必须是实测的交付峰值**，不是 `gain` 参数。
     > **⚠️ 追加（2026-09-01）：这条订正当时还漏了一层——峰值是在 MP3 编码之前对齐的，而 MP3 是有损的。** 管线结构上无法自证这一层，所以新增了 `__nwAudio.samples()` 去量**已解码** buffer 的峰值。实测偏差 −6.1%…+6.7%（≈±0.56 dB），是 catalogue 里最小一档有意混音差（0.7↔0.9，≈2.2 dB）的四分之一，可以忽略；但**它是一层必须被量过才能忽略的东西**。
   - ~~值得整套移植 daydayup 的 `tools/audio-pipeline/`。~~ ✅ 移植完成，见 [`tools/audio-pipeline/README.md`](../../tools/audio-pipeline/README.md)：`fetch_freesound.py` / `fetch_packs.py` / `audit.py` / `process.py` / `write_packs.py` / `selftest.py`（**73 个检查**）。**不进 CI**（那会把 Python 塞进每次构建）——它建立的不变量由 `client/test/audio/audioAssets.test.ts` 每次提交复查。三处与 daydayup 不同的地方（`body_ms` 而不是 `duration_ms`、lead 门禁改成一帧、峰值基准的来源）与两个新增的**源文件**门禁都写在那个 README 里。
   - ~~接入方式：在 `audio/cueAssets.ts` 加一行 `import` + 一个条目。~~ ✅ 照此落地，其余代码一行未改。
   - **⚠️ 仍然欠着的一件事，和代码无关：没有人听过任何一个声音。** 四轮实测（§0.1–§0.4）量到的全部是「响得对不对」——授权峰值、交付峰值、同瞬叠加、抖动、包体、跨平台一致性。「好不好听」一个字都没测，而且**加不了测量**：它需要一个人坐下来打一局然后签收。这是 §7 剩下的两个开放项之一（另一个是微信真机，见 §0.3 末尾）。
7. **BGM** —— ✅ **2026-09-01 已发货**（一条轨 `bgm.lobby`；落地与四组实测见 §0.5）。
   - **轨数收敛为两条**（`bgm.lobby` / `bgm.battle`），不是本条原先写的「两到三轨」：`bgm.intro` 由 `IntroScene` 省略 `Scene.music` 落到大厅床，两个结算 stinger 从来就走 SFX 管线。理由见 §2.3 的订正。**发货的是其中一条**——`bgm.battle` 缺 master，因此它连 union 都不在，对局是三处显式的 `music: null`。
   - **本条原稿说「这半边没有可参照的先例」，那是错的**——daydayup 有整套（`MusicPlayer.ts` / `musicCatalogue.ts` / `weChatMusicDeck.ts` / `process_music.py` / `audit.py` 的 `loop`+`music` 两个 gate class）。实际做下来，参照的价值不在于抄，而在于它把**三处该删的东西**指出来了（deck 的双增益入口、`invalidate()`、`loop` 门禁），每一处都因为本项目的一个具体事实而不成立。见 §0.5。
   - **接口形状确实与 SFX 不同**，这半句是对的：单实例 + 淡入淡出 + 流式。落成 `AudioBus.updateMusic(desired, dtMs)` —— **每帧一次的推导，不是切场景时通知一声**。这是这一步唯一真正的接口决定：本仓库有 40 个场景、三族互不相同的按钮机制（§7 第 4 步为此漏了两遍），而「记得在新入口调一次」正是这个仓库反复付钱的那种 bug。
   - ~~素材来源~~ 拍板走 **Suno 生成**（CC0 音乐池几乎全是 chiptune，与「手绘笔记本」直接冲突），brief 交在 `art/audio/suno/BRIEFS.md`。**结果第一条轨没走这条路**：项目自己有一首合用的曲子（`doodle-bed`），于是 `bgm.lobby` 是**项目自有**素材，`process_music.py` 的 `SRC_DIR` 因此从 `art/audio/suno/` 放宽成 `art/audio/sources/`（一个目录一种出处）。那两条门禁规则也跟着按 provenance 分岔，见 §2.3。brief 留着给 `bgm.battle`。
   - **⚠️ 同一件事被做了两遍。** 第一轮建成但因缺素材未合并（判断是对的），第二轮拿到 master 后从零又实现了一遍，因为开工前只依赖自动召回、没有扫 `index/open.md`。留下的是第一轮那份，它在三件事上更好——交叉淡入循环、推导出来的电平、**以及 iOS**（第二轮每帧写 `el.volume`，而那个属性在 iOS Safari 上是只读的，所有淡入淡出会静默退化成硬切）。完整比较与教训见 §0.5。
   - **⚠️ 合规陷阱已提前设计掉**：BGM 不是 CC0，它的记录与 `packs.json` 完全分开，另配 `musicAssets.test.ts`。理由（一条被削弱的断言比没有断言更糟）见 §2.3。
   - **仍然欠着**：`bgm.battle` 的 master、还是没有人听过、微信真机、ducking 从未在真实 stinger 下听过。
