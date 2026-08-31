# Notebook Wars — 音频系统设计

> 状态：**战斗 + UI 触发点都已接，设置页有三档音量与静音；资产仍为零（17 个 cue 全部走程序化合成音）；UI 那一轮的真浏览器实测欠着（§0.2）**（2026-08-31）· 权威：本文（音频**系统**的单一入口）· 更新：2026-08-31
>
> **权威边界**：音频**美学方向**（音色取向、禁用清单）仍归 [`../product/art-direction.md`](../product/art-direction.md) §声音；本文拥有**系统实现**——资产清单与命名、触发表、播放层抽象、混音、设置项、平台约束。两者不重述对方。

---

## 0. 落地状态（2026-08-31）

§7 的第 1–4 步已完成：**平台接缝 + cue 目录 + 程序化合成音 + 样本加载/解码/并发上限/混音器 + 战斗触发点 + UI 触发点 + 设置页音量**。

**已存在的模块**（`client/src/audio/`，平台中立，无 PIXI 依赖）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `AudioCue` 词汇表（17 个）+ `AudioBus` 接口 |
| `cueCatalogue.ts` | 每个 cue 的 gain / priority（混音的单一来源） |
| `cueAssets.ts` | cue → 已发货文件 URL。**全仓库唯一持有音频 `import` 的文件**，目前为空 |
| `audioSynth.ts` | 每个 cue 一把程序化合成音（文具拟音，见 §1）+ `tone`/`noise` 两个原语 |
| `decodeAudio.ts` | 归一 `decodeAudioData` 的 promise / callback 两种形状 |
| `SampleBank.ts` | 走 `assets/assetIO.ts` 拉字节 + 解码，逐文件尽力而为 |
| `VoiceBudget.ts` | 并发上限，按优先级抢占（对 §5 的一处改判，见那一节） |
| `CueMixer.ts` | 两级阶梯：有样本用样本，没有用合成音；合并增益、variant 不重复、±3% 音高抖动 |
| `audioBus.ts` | 模块级接缝（`setAudioBus`/`audioBus`/`playSfx`）+ `NullAudioBus` |
| `audioSettings.ts` | 三档音量 + 静音的持久化与换算（§4）。**2026-08-31 新增** |

**后端**：`client/src/platform/web/WebAudioBus.ts`（`AudioContext` + SFX 总线 GainNode）。装在 `entries/{web,crazygames,mobile,web-e2e}.ts`；**微信保持 `NullAudioBus`（静音）**，理由见 §3。

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
| `game_draw` | — | 平局既不是胜也不是负，两个 stinger 哪个都是误报；要的是一个 `sfx.result.draw`，属于词汇表+素材决策（§7 第 6 步） |
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
> | 绕过 `runHit` 直接 `playSfx('sfx.ui.*')` 即红 | 「就地响一声」的捷径。三个合法出口在 allowlist 里各带理由 |
> | 再声明一份 `interface Hit`/`ModalHit`/`LocalHit` 即红 | 第 23 份重复声明（别名 `type Hit = BaseHit<boolean>` 不算，那仍指向 `ui/hits.ts`） |
>
> 四条**全部做了变异验证**：各自注入一次对应的回归（拆掉一个 `tapHandler`、往大厅塞回一段手写包含判定、加一处直接 `playSfx`、加一份 `interface ModalHit`），确认都会红。写这一段的时候第三条当场抓到了我自己——大厅的两处遮罩消除我图省事写成了裸 `playSfx('sfx.ui.back')`。

**设置页（§4）**：`SettingsScene` 右栏加了一块音量区——三根滑杆（master / bgm / sfx）+ 一个静音开关，落在 `scenes/SettingsScene/audioPanel.ts`。持久化走 `audio/audioSettings.ts`：一个 JSON 键 `nw_audio`，与 `nw_locale` / `nw_data_saver` 同级的**本地设置，不上云**（纯体验项，无防作弊价值，一次 `PUT /flags` 换不来任何东西）。形状抄 `assets/prefetchPolicy.ts`（`installAudioSettings({storage})` 在 `app.ts` 装一次），所以没装的环境（单元测试、headless）读到默认值、写入被丢掉，而不是抛错。**静音不清零滑杆**：`muted` 是独立于三个音量的覆盖，取消静音会回到玩家自己调的档位，而不是把他留在最底下。BGM 那根滑杆现在接的是 `setMusicVolume`，它接受并忽略（§7 第 7 步之前没有轨可放）——接上它是因为「设置里有个滑杆但拖了没反应」和「设置里没这一项」是两种体验，前者更糟，而这一项一定会有。

**还没有的**：音频素材（§7 第 6 步）——17 个 cue **全部**是程序化合成音，`cueAssets.ts` 依旧是空的。

**验证过的**：
- `test/audio/**` **105 个用例**（+26：`hits.test.ts` 16、`audioSettings.test.ts` 10），`src/audio/**` 与 `src/ui/hits.ts` 行覆盖均 **100%**；两者都在 `vitest.config.ts` 的覆盖率门禁里（客户端整体 95.77% → **95.83%**，scope 又变大一点而百分比仍在上升）。
- `test/uiTapSoundCoverage.test.ts` **11 例**——源码扫描守卫，四条断言 + 各自的 canary 和 allowlist 保鲜检查（明细见上面那张表）。四条**全部做过变异验证**。
- UI 侧 `test/ui/uiAudioCues.ui.ts` **19 例**，全部走真实 pointer 事件（PIXI 原生那族走真的 `EventBoundary.hitTest`）而不是直接调 hit 的 `fn`——否则一个「挂了 cue 但没人点得到」的按钮会通过。也做了变异验证：拆掉 `ResultScene` 主 CTA 的 `tapHandler`、把大厅头像芯片改成 `sound: null`，两例都会红。
- 主套件 **2355 例**、UI 套件 **2411 例**、`test:sim` 13 例全绿。收敛命中表触碰了 80+ 个源文件和 12 个测试文件，两套件是这次重构唯一的行为安全网，一次都没有降级为「改测试迁就实现」——每一处红都是测试自己的旧形状（`h.x` → `h.rect.x`、`action` → `fn`）。
- `tsc --noEmit`（`tsconfig.json` + `tsconfig.test.json`）、`eslint src`、500 行门禁、包体门禁、`test:sim`、`web` + `wechat` 两个 production 构建全通。
- **微信主包只多付 409 字节**（2188322 → 2188731），比接触发点之前的那一版还接近持平：cue 字符串字面量 + `ui/hits.ts` + `audioSettings.ts` 是进包了，但**收敛本身省下的比它们花掉的还多**——大厅那条 18 分支链、战斗/世界地图 HUD 的 if 链、五份手抄的私有 `inRect`，全都塌成了共享的一份。**播放引擎仍旧没进**（`grep createOscillator` 命中 0 次）：`entries/wechat.ts` 依旧不 import `WebAudioBus`，装的是 `NullAudioBus`，所以微信上这些 `playSfx` 全部落在空操作上。
- **真浏览器实测，不是推断**（Chrome，`entries/web-e2e.ts` 的 `window.__nwAudio` + 在 SFX 总线上挂一个 `AnalyserNode` 读 PCM 峰值）：`AudioContext` 在第一次真实点击后 `running`（48 kHz），总线增益 0.8（§4 的 SFX 默认值），**17 个 cue 全部出声**，`loaded()` 诚实地报 `{cues:0, variants:0}`。游戏本身跑着时**连续 2 秒静默量到 0.000**——既确认总线没有本底噪声/直流偏移，也确认目前确实没有任何代码在触发 cue。交付峰值：

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

### 0.2 UI 触发点的真浏览器实测 —— **⚠️ 欠着，没做成**（2026-08-31）

上一轮（§0.1）之所以值钱，是因为它在真浏览器里抓出了两条用例永远看不见的规律（授权峰值 ≠ 交付峰值；`sfx.ink.tick` 接在 `resource_changed` 上是 2.6 Hz 机关枪）。这一轮同样的验证**没能跑起来**，所以下面这些问题目前**只有推理，没有测量**：

| 还不知道的事 | 为什么用例答不了 |
|---|---|
| UI cue 的**触发频率**能不能听 | 用例只断言「点了 → 响了一次」。它答不了「一路点进商城再退出来」这串连击听起来是不是机关枪——这正是 §0.1 里 `ink.tick` 栽的那个坑，只是换成了手指的节奏 |
| `sfx.ui.tap` / `.back` / `.reward` 的**交付峰值**还在不在战斗音之下 | §0.1 那张表是**接触发点之前**测的。这一轮没动 `audioSynth.ts` 和 `cueCatalogue.ts`，所以峰值理应不变——但「理应不变」正是上一轮 `sfx.unit.hit` 翻车的说法 |
| 三根滑杆拖动时是不是**真的一声不响** | 用例断言的是「滑杆按下不发 cue」。它答不了拖动过程中 `update()` 每帧重绘会不会顺带触发点什么 |
| 设置页那块音量区的**版面**对不对 | 它塞在右栏 profile 余额行（≈0.37h）与省流量行（≈0.60h）之间那段空隙里，是纸面算出来的，没截过图 |

**卡在哪**：Chrome 里 `localhost:9096` 那个标签页始终是 `document.visibilityState === 'hidden'`（插件开的标签页不在前台）。后果是 `AudioContext.resume()` 的 promise **永远不 settle**、上下文停在 `suspended`，一个 cue 都发不出来；同时 PIXI 的 rAF ticker 被冻住，连截图都超时。`navigator.userActivation.hasBeenActive` 是 `true`，所以不是 autoplay 手势的问题，是 Chrome 不给后台标签页起 AudioContext。in-app 面板那个标签页同样是 hidden，退不回去。

**下次怎么做**：先让人把那个 Chrome 窗口切到前台、确认 `document.visibilityState === 'visible'`，**再**按 §0.1 的方法接 `ScriptProcessorNode`。另外注意一个 §0.1 没记的坑：`app.ts` 的 `preload()` 在启动时就创建了 `AudioContext`，所以「patch `AudioNode.prototype.connect` 收集 GainNode」必须在页面加载**之前**注入才拿得到总线；事后注入只能靠「下一次 cue 的 voice 节点连到谁」反查出总线。

## 1. 美学基线（引自 art-direction，不在此复述）

一句话锚点：**轻巧、卡通、非写实的"文具拟音"**——铅笔沙沙、橡皮擦、翻笔记本页、笔帽咔哒；**禁止**金属碰撞、爆炸轰鸣等写实战争音效。所有音效服从「我蓝敌红 / 手绘笔记本」的整体调性。细节见 art-direction §声音。

---

## 2. 资产清单（最低可上线集 = MVP）

> 对齐 [`../product/mvp-gaps.md`](../product/mvp-gaps.md) §8「基础音效」。占位素材用 **freesound.org（CC0）** 或自录文具声，正式资产后补。

### 2.1 战斗内 SFX（一次性短音）
| 事件 id | 触发 | 拟音建议 | 优先级 |
|---|---|---|---|
| `sfx.card.play` | 出牌/落子 | 笔尖落纸"唰" | P0 |
| `sfx.card.invalid` | 费不够/非法出牌 | 橡皮擦短"吱" | P0 |
| `sfx.unit.attack` | 单位攻击 | 铅笔短戳 | P0 |
| `sfx.unit.hit` | 单位受击 | 软"噗"/揉纸 | P0 |
| `sfx.base.hit` | 基地受击 | 厚本子闷响 | P0 |
| `sfx.spell.cast` | 法术（陨石等） | 翻页+落石涂抹 | P1 |
| `sfx.unit.death` | 单位阵亡 | 纸团揉碎 | P1 |
| `sfx.ink.tick` | 墨滴回涨节点（每回涨 10 点墨一声，不是每一点——理由见 §0.1） | 水滴"嘀" | P2 |

### 2.2 UI SFX

全部已接（2026-08-31，§7 第 4 步）。「出口」一列是**唯一**发这个 cue 的地方——新增触发点时改那里，不要在别处调 `playSfx`。

| 事件 id | 触发 | 出口 | 优先级 |
|---|---|---|---|
| `sfx.ui.tap` | 按钮/格子点击 | `ui/hits.ts` 的 `runHit` 默认值——命中表走 `dispatchHit`/`hitAction`，PIXI 原生监听走 `tapHandler(fn)`，两条都汇进 `runHit` | P0 |
| `sfx.ui.back` | 返回/关闭 | 同上，hit 上写 `sound: 'sfx.ui.back'` / `tapHandler(fn, 'sfx.ui.back')`（27 处 `hdr.backRect` + 模态 dismiss 遮罩 + 对话框 Cancel + 结算页返回芯片） | P1 |
| `sfx.ui.reward` | 领奖/获得物品 | 同上，写在各 claim 按钮的 hit 上（成就/日常/周常/活动/战令/充值里程碑） | P1 |
| `sfx.ui.gacha.reveal.common` / `.rare` / `.epic` | 盲盒揭示，按稀有度分层。实现成**三个独立 cue** 而不是一个 cue 的三个 variant：variant 是抗重复疲劳的随机取样，语义分层必须可寻址，否则调用方无法表达"这一抽是史诗" | `GachaScene/core.ts` 的 `revealCue(results)`，**一次抽一声**、取这一抽里最好的稀有度（legendary 并入 epic） | P1 |
| `sfx.ui.error` | 失败/余额不足 toast | `net/log.ts` 的 `showToastMessage`，仅 `kind === 'error'`（不是 hit：失败来自异步结果） | P2 |

### 2.3 BGM（循环长音）
| 轨 id | 场景 | 备注 |
|---|---|---|
| `bgm.lobby` | 大厅 / 菜单 / 商店 | 轻松、低存在感 | 
| `bgm.battle` | 对战 / 战役关卡内 | 节奏稍快、不喧宾夺主 |
| `bgm.intro` | 首启故事（IntroScene） | 叙事氛围，可与 BGM_lobby 共用 |
| `bgm.victory` / `bgm.defeat` | 结算短乐句（stinger，非循环） | 接 ResultScene |

> 胜负 stinger 走 SFX 管线（一次性），不占 BGM 槽 —— 已实现为 `sfx.result.victory` / `sfx.result.defeat`，是 catalogue 里优先级最高（120）的两个 cue，谁都不许抢。

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
  setMusicVolume(v: number): void;           // BGM 尚未实现，接受并忽略
  resume(): void;                            // 越过 autoplay 闸门（见 §5）
}
```

与本节原稿的另外三处差异，都是实现时发现原稿的形状不对：

- **`preload(ids)` → `preload()`。** 原稿设想"进场景前预载该场景所需 id"。SFX 全集是 ~100 KB 量级（daydayup 的同类集合实测 101.9 KB / 50 个文件），按场景切分省不下有意义的字节，却要求每个场景维护一份 id 清单——那是一份会腐烂的重复。BGM 是另一回事（单文件就可能几 MB），它落地时会有自己的按需接口。
- **`playSfx(id, {volume})` → `play(cue, count)`。** 单次播放不接受调用方传音量：混音权重是内容决策，住在 `cueCatalogue.ts` 一张表里（§4），否则"为什么攻击音把结算盖住了"要翻十个触发点。`count` 是本帧合并进来的事件数（§4 的合并规则）。
- **`unlock()` → `resume()`，且不需要调用方接。** `WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`。比走 `InputManager` 严格更宽：后者会在场景淡入淡出和模态框期间闸掉指针事件，而 autoplay 闸门只要"用户碰过页面"，被游戏逻辑丢弃的那次点击同样能解锁。§6 里"IntroScene 首 tap 挂 unlock()"这条因此不需要了。

- **Web / CrazyGames / Capacitor iOS 壳**：`platform/web/WebAudioBus.ts`（`AudioContext` + 解码缓冲，低延迟、可并发、好做混音/淡入），SFX 走 buffer source。**没有 `HTMLAudioElement` 降级**：没有 `AudioContext` 的环境（SSR、node 测试、极老 WebView）直接静音，因为那条降级路径无法承载合成音，等于要维护第二套永远测不到的播放实现。
- **微信小游戏**：**尚未实现，当前是 `NullAudioBus`（静音）。** `client/src/wx.d.ts` 只声明了 `wx.createInnerAudioContext`——那是一个按 URL 播放的播放器，**没有振荡器、没有 GainNode**，所以合成音、`AudioBuffer` 样本、总线增益这三样在那个运行时上一行都跑不起来。微信侧要的是本节原稿说的 `InnerAudioContext` 对象池（SFX 实例池复用，BGM 单实例 `loop=true`），是形状不同的一套后端，属于独立一步（§7 第 5 步）。在它落地之前微信静音，而不是装一个吞掉所有 cue 的假设备。
  > 备选：若目标基础库确认提供 `wx.createWebAudioContext()`（WebAudio 形状），现有整条管线可以原样复用，只换上下文来源——但本仓库没有设备可验证，所以没有先把这个 API 声明写进 `wx.d.ts`。
- 资产路径**不用平台资源约定之外的任何东西**：见 §5 的首包体积那一行的订正。

---

## 4. 混音与设置

> **已落地（2026-08-31）**：`audio/audioSettings.ts` + `scenes/SettingsScene/audioPanel.ts`。下面三条中的前两条实现时各有一处改判，就地记在条目里。

- **三档音量**：`master` / `bgm` / `sfx`（0–1）+ **一个** `muted`。实际增益 = `master × 通道`，`muted` 覆盖成 0。
  > **订正：不是「各自 `muted`」，是一个总的。** 原稿给每个通道一个静音位，那是三个开关 + 三根滑杆共六个控件，而它们能表达的状态里绝大多数（"只静音 BGM"）用滑杆拖到底就够了，且更符合直觉。留一个总静音是因为它表达的是滑杆表达不了的东西：**临时**闭嘴、且不丢失现在的档位——所以 `muted` 不清零音量，取消静音直接回到玩家调好的位置。
- **持久化**：一个 JSON 键 **`nw_audio`**（`{master,bgm,sfx,muted}`），与 `nw_locale` / `nw_data_saver` 同级的本地设置。**不上云权威**（纯本地体验设置，无防作弊价值）。
  > **订正：不进 `SaveData.flags`。** 原稿写的是 flags/设置段；实现时改走 `IStorage` 直存，形状抄 `assets/prefetchPolicy.ts`（`installAudioSettings({storage})` 在 `app.ts` 装一次）。理由：`flags` 是**服务端权威**的存档字段，写它要一次 `PUT /flags` 往返，而音量既不需要跨设备一致、也不需要防篡改——把它放进云存档只是给每次拖滑杆加一个网络请求和一条失败路径。四个值合成一个键而不是四个键，是因为它们只会被一起读写，"音量存下了但静音位丢了"没有任何有用的含义。
  > 解析是**逐字段兜底 + 夹到 0..1**：手改过或截断的值退化成默认值，绝不退化成静音——"音频坏了"是最难归因的一类 bug。
- **默认**：`master 1` / `bgm 0.5` / `sfx 0.8`，不静音（`DEFAULT_AUDIO_SETTINGS`）。BGM 那根滑杆现在接的是 `AudioBus.setMusicVolume`，它接受并忽略——接上它是因为「设置里有个滑杆但拖了没反应」和「设置里没这一项」是两种体验，前者更糟，而这一项一定会有（§7 第 7 步）。
- **Ducking（可选 P2）**：盲盒揭示 / 结算 stinger 播放时，BGM 短暂压低再恢复。
- **失焦自动暂停**：页面/小游戏切后台（`visibilitychange` / `wx.onHide`）暂停 BGM，回前台恢复。

---

## 5. 平台约束（必须处理，否则"没声音"）

| 约束 | 平台 | 处理 |
|---|---|---|
| **autoplay 限制**：首次音频必须在用户手势后才能响 | Web（所有现代浏览器）/ iOS Safari | 首个 tap（IntroScene/LoginScene 任意首次交互）调 `audio.unlock()` 解锁 `AudioContext`；解锁前的 BGM 请求排队，解锁后补播 |
| **iOS WebAudio 需手势解锁** | iOS 网页 | 同上，`AudioContext.resume()` 必须在手势回调内 |
| **同时音频实例数有限** | 微信小游戏 | SFX 走对象池（如 8 个 InnerAudioContext 轮转）。**订正：丢弃规则不是"最旧"而是"按优先级抢占"**——最旧那个很可能正是一局一次的结算 stinger，而新来的是第 40 个攻击音；丢最旧会砍掉唯一那次胜利音，换来一个听不出区别的攻击音。已实现于 `audio/VoiceBudget.ts`（同优先级判输，被抢占者 12ms 淡出而非硬切；按**时间**退休而不靠 `ended` 事件，因为一个"悄悄停止清扫"的上限会失效于静默——前 N 个 cue 之后混音直接变哑，看起来就是"音频坏了"） |
| ~~**首包体积**~~ | ~~微信小游戏~~ | **订正（2026-08-31）：这条约束对本项目不存在。** 原稿写"BGM 放分包/CDN 按需拉，首包只带 P0 SFX"，那是通用建议；而本项目按 ASSET_PACKAGING §4 的**方案 A** 早已把**全部**美术资源托管在 CDN（`asset/resource` 的 `publicPath = NW_ASSET_CDN`，产物进 `wechatgame/cdn/`，由 `project.private.config.json` 的 `packOptions.ignore` 排除出主包），主包是**纯代码 ~1.5 MB**。音频文件走同一条规则、同一个 `assetIO`，天然落在 CDN 上，**一个字节都不进主包**——所以"首包只带 P0 SFX"这个取舍不需要做，BGM 也不需要为体积单独分包。真正要留意的是**下载量与缓存**（同 §16 的资源预算口径），不是包体红线。<br>实测（2026-08-31，接完战斗触发点后重测）：微信主包为音频多付 **1234 字节**（2187088 → 2188322）——触发表的 cue 字符串字面量跟着 `events.ts` 进了包（`grep 'sfx.card.play'` 命中 1 次），但**播放引擎仍旧没进**（`grep createOscillator` 命中 0 次）：`entries/wechat.ts` 不 import `WebAudioBus`，装的是 `NullAudioBus`。接触发点之前这个数字是 0 字节 |
| **解码开销** | 全平台 | **启动时 `preload()` 全量**（`app.ts` 在 L0 闸门之后 fire-and-forget，不 await）。订正原稿的"进场景前 preload 该场景所需 id"：SFX 全集是 ~100 KB 量级，按场景切分省不下有意义的字节，却要每个场景维护一份会腐烂的 id 清单。suspended 的 `AudioContext` 照样能解码，所以这一步既不需要网络闸门也不需要 autoplay 手势。BGM 落地时按轨流式，另说 |

---

## 6. 实现挂钩与缺口

| 项 | 现状 |
|---|---|
| 平台音频抽象 | ✅ `audio/audioBus.ts`（模块级接缝，**不是** `IPlatform` 成员——见 §3 订正）+ `platform/web/WebAudioBus.ts` |
| cue 词汇表 + 混音表 | ✅ `audio/types.ts`（17 个 cue）+ `audio/cueCatalogue.ts`（gain/priority）。往 union 里加 cue，在 catalogue 里给它决策之前**编译不过** |
| 程序化合成音（占位声源 + 永久兜底） | ✅ `audio/audioSynth.ts`，每个 cue 一把，文具拟音方向。**没有人听过** |
| 样本加载 / 解码 / 并发上限 / 混音器 | ✅ `SampleBank` + `decodeAudio` + `VoiceBudget` + `CueMixer`，79 个用例 / 99.4% 行覆盖 |
| 资产文件 + 命名约定 | 🟡 目录与命名已定（`client/src/assets/audio/`，`<cue id 的 '.' 换成 '-'>_NN.mp3`，webpack 的 `asset/resource` 规则已涵盖 `mp3\|wav\|ogg`，无需改配置），`custom.d.ts` 已声明 `*.mp3`。**但一个文件都还没有**：`cueAssets.ts` 是空的，全部 cue 走合成音。素材是独立一步——见 §7 第 6 步为什么现成的 CC0 游戏音效包用不了 |
| 触发埋点：游戏事件 → `playSfx` | ✅ 2026-08-31。单一漏斗：`render/GameRenderer/core.ts` 的 `for (const event of state.events) this.events.handleEvent(event, state)` 之后跟一次 `this.events.flushAudio()`；映射表全在 `render/GameRenderer/events.ts` 的 `EventsPanel.collectCue` 一处（**不在纯引擎层**——音频是表现层，`@nw/engine` 一行没动）。完整映射与实测见 §0 / §0.1。<br>那个已知的坑按预期咬人了：game over 后引擎 `step()` 提前返回、**不排空事件队列**，重复被消费的是**最后一帧的整批事件**（不只是 `game_over`），所以 `collectCue` 第一行就是 `if (this.core.gameEnded) return`，胜负 stinger 则写在 `game_over`/`game_draw` 分支里那个已有的一次性门**内部**。真浏览器三局复测：每局 stinger 恰好 1 次 |
| UI 触发埋点 | ✅ 2026-08-31。先抽了 `ui/hits.ts`（共享 `Hit<S>` + `inRect`/`hitTest`/`runHit`/`dispatchHit`/`hitAction`/`tapHandler`），**22 份重复的 `interface Hit` 全部消失**，十几处内联的 `hitRects: { rect; action }[]` 一并收敛、`action` 改名 `fn`；UI cue 只在 `runHit` 一处发出，`sound` 省略即 `sfx.ui.tap`。覆盖三族按钮：①场景自持的矩形表；②战斗 HUD / 世界地图 HUD 的手写 `overRect` if 链；③**PIXI 原生 `pointertap` 按钮**（结算页 + 回放 + 五个对话框，第一遍漏掉的 22 处，见 §0 的 ⚠️）。防复发靠源码守卫 `test/uiTapSoundCoverage.test.ts` |
| 设置页音量项 | ✅ 2026-08-31。`scenes/SettingsScene/audioPanel.ts`（右栏，三根滑杆 + 静音开关）+ `audio/audioSettings.ts`（`nw_audio` 一个 JSON 键）。滑杆**不是 hit**：它要跟手，所以留在 `audioSliders: { rect; onDrag }` 里，按下即接管指针、`update()` 每帧最多重绘一次（render()-per-pointermove 会卡） |
| 首启解锁手势 | ✅ 不需要调用方接：`WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`（见 §3） |
| 盲盒/结算 stinger | ✅ 2026-08-31。结算 stinger 在 `EventsPanel`（§7 第 3 步），盲盒揭示在 `GachaScene/core.ts` 的 `revealCue()`——**一次抽一声**，取这一抽里最好的稀有度 |
| 浏览器冒烟入口 | ✅ `entries/web-e2e.ts` 暴露 `window.__nwAudio`：`play(cue)` / `resume()` / `cues` / `loaded()`，**加 2026-08-31 新增的 `log()` / `clearLog()`**——总线包一层的 cue 流水账。AnalyserNode 只告诉你“响了、多响”，告诉不了你“响的是哪个 cue、合并了几个事件”，而一局里 cue 飞得比人眼快 |

> **架构红线**：音频是**表现层**，触发点放在 render/scene 层订阅引擎事件，**不污染 `client/src/game`（纯 TS 确定性引擎）**——与 PIXI 渲染同级处理，保证引擎/回放/裁判确定性不受音频影响。

---

## 7. 待办（开发顺序）

1. ~~平台音频抽象 + Web(WebAudio) 实现 + 首手势解锁。~~ ✅ 2026-08-31（形态改判为模块级接缝，见 §3）
2. ~~cue 词汇表 + 混音表 + 程序化合成音 + 样本加载/解码/并发上限/混音器。~~ ✅ 2026-08-31
3. ~~**战斗触发点**。~~ ✅ 2026-08-31（`EventsPanel.collectCue` + `flushAudio`，含同帧合并与 game-over 一次性门；真浏览器实测见 §0.1）。留下两个口子给后续步骤：`sfx.card.invalid` 没有引擎事件（客户端判的，归第 4 步）；平局没有 stinger（词汇表缺 `sfx.result.draw`，归第 6 步）。
4. ~~**UI 触发点**：先抽共享 hit 表 + 派发器（消掉 22 份重复的 `interface Hit`），再在那一处挂 `sfx.ui.*`；`SettingsScene` 三档音量 + 静音持久化。~~ ✅ 2026-08-31（`ui/hits.ts` + `audio/audioSettings.ts` + `SettingsScene/audioPanel.ts`；顺带补上了上一轮留下的 `sfx.card.invalid`。完整说明见 §0）。**⚠️ 真浏览器实测欠着**，见 §0.2。**仍然留给第 6 步的口子**：平局没有 stinger（词汇表缺 `sfx.result.draw`）。
5. 微信 `InnerAudioContext` 后端 + 对象池（**不需要为体积分包**，见 §5 订正）。
6. **音频素材**。这一步的成本比它看起来高，原因是我们的美学方向：
   - art-direction §声音 明令**禁止**金属碰撞与爆炸轰鸣，而现成的 CC0 游戏音效包（如 Kenney 的 Impact / Sci-Fi / Digital 那几个：激光、金属撞击、玻璃碎、爆炸）**整个落在禁用清单里**。能直接复用的只有 Interface Sounds 那一包里的 UI 音（tap/back/toggle/error 形状），战斗音必须另找纸质 foley（freesound.org 的 CC0 拟音）或自录。
   - 素材到位后**按合成音峰值对齐**再进仓（`tone`/`noise` 两个原语的峰值就是它们的 `gain` 参数，`audioSynth.ts` 里 UI 那几个刻意各自只用一个原语，正是为了让这一步不需要重新渲染测量）。这样换样本不改变混音权重，`cueCatalogue.ts` 那张表不用跟着调。
   - 值得整套移植 daydayup 的 `tools/audio-pipeline/`（audit → 剔除削波/双声道假立体声 → 裁前后静音 → 按各文件自己的 rolloff 搜最小采样率 → 峰值对齐）——那部分与素材来源无关。
   - 接入方式：在 `audio/cueAssets.ts` 加一行 `import` + 一个条目，其余代码一行不用改。一个写错的文件名是**构建失败**而不是静默退回合成音。
7. BGM（`bgm.lobby` / `bgm.battle` / `bgm.intro` 两到三轨）+ 切场景淡入淡出 + 失焦暂停 + 可选 ducking。这半边**没有可参照的先例**，接口形状也与 SFX 不同（单实例 + 淡入淡出 + 流式），需要单独设计。
