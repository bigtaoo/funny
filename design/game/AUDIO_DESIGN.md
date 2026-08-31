# Notebook Wars — 音频系统设计

> 状态：**战斗 + UI 触发点都已接，设置页有三档音量与静音；两轮真浏览器实测都已做完（§0.1 战斗 / §0.2 UI），第二轮抓出并修掉两个缺陷；平局 stinger 已补齐（18 个 cue）；资产仍为零（全部走程序化合成音）**（2026-08-31）· 权威：本文（音频**系统**的单一入口）· 更新：2026-08-31
>
> **权威边界**：音频**美学方向**（音色取向、禁用清单）仍归 [`../product/art-direction.md`](../product/art-direction.md) §声音；本文拥有**系统实现**——资产清单与命名、触发表、播放层抽象、混音、设置项、平台约束。两者不重述对方。

---

## 0. 落地状态（2026-08-31）

§7 的第 1–4 步已完成：**平台接缝 + cue 目录 + 程序化合成音 + 样本加载/解码/并发上限/混音器 + 战斗触发点 + UI 触发点 + 设置页音量**，两轮真浏览器实测（§0.1 / §0.2）都已做完。

**已存在的模块**（`client/src/audio/`，平台中立，无 PIXI 依赖）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `AudioCue` 词汇表（18 个）+ `AudioBus` 接口 |
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

**设置页（§4）**：`SettingsScene` 右栏加了一块音量区——三根滑杆（master / bgm / sfx）+ 一个静音开关，落在 `scenes/SettingsScene/audioPanel.ts`。**位置在 §0.2 (D) 被订正过一次**（原先撞在贯穿整宽的语言按钮行上，把 Deutsch 按钮吃掉一半，且是静默吃掉），现在是 `x0 = 0.60w` / `titleY = 0.30h`，由 `test/ui/settingsSliderOverlap.ui.ts` 守着。**master / sfx 两根滑杆松手时会试听一声 `sfx.ui.tap`**（§0.2 (B)：不试听的话它是一根完全盲的控件），bgm 那根保持静音。持久化走 `audio/audioSettings.ts`：一个 JSON 键 `nw_audio`，与 `nw_locale` / `nw_data_saver` 同级的**本地设置，不上云**（纯体验项，无防作弊价值，一次 `PUT /flags` 换不来任何东西）。形状抄 `assets/prefetchPolicy.ts`（`installAudioSettings({storage})` 在 `app.ts` 装一次），所以没装的环境（单元测试、headless）读到默认值、写入被丢掉，而不是抛错。**静音不清零滑杆**：`muted` 是独立于三个音量的覆盖，取消静音会回到玩家自己调的档位，而不是把他留在最底下。BGM 那根滑杆现在接的是 `setMusicVolume`，它接受并忽略（§7 第 7 步之前没有轨可放）——接上它是因为「设置里有个滑杆但拖了没反应」和「设置里没这一项」是两种体验，前者更糟，而这一项一定会有。

**还没有的**：音频素材（§7 第 6 步）——18 个 cue **全部**是程序化合成音，`cueAssets.ts` 依旧是空的。

**验证过的**：
- `test/audio/**` **109 个用例**（+4：`errorCueThrottle.test.ts`），`src/audio/**` 与 `src/ui/hits.ts` 行覆盖均 **100%**；两者都在 `vitest.config.ts` 的覆盖率门禁里（客户端整体 95.77% → **95.83%**，scope 又变大一点而百分比仍在上升）。
- `test/uiTapSoundCoverage.test.ts` **11 例**——源码扫描守卫，四条断言 + 各自的 canary 和 allowlist 保鲜检查（明细见上面那张表）。四条**全部做过变异验证**。`DIRECT_UI_CUE_ALLOWLIST` 现在四条（新增 `audioPanel.ts` 的松手试听）。
- `test/ui/settingsSliderOverlap.ui.ts` **14 例**（2026-08-31 新增，§0.2 (D)）——「任何滑杆矩形都不许与任何 hit 矩形相交」，3 种场景形状 × 4 种画布尺寸 + 两条结构断言。**做过变异验证**（把版面改回旧坐标，12 条全红）。
- `test/audio/errorCueThrottle.test.ts` **4 例**（2026-08-31 新增，§0.2 (A)）——错误音扇出合并。**做过变异验证**。
- UI 侧 `test/ui/uiAudioCues.ui.ts` **21 例**（+2：§0.2 (B) 把「滑杆静音」那条拆成拖动静音 / 松手试听一次 / bgm 静音三条），全部走真实 pointer 事件（PIXI 原生那族走真的 `EventBoundary.hitTest`）而不是直接调 hit 的 `fn`——否则一个「挂了 cue 但没人点得到」的按钮会通过。也做了变异验证：拆掉 `ResultScene` 主 CTA 的 `tapHandler`、把大厅头像芯片改成 `sound: null`，两例都会红。
- 主套件 **2359 例**、UI 套件 **2428 例**、`test:sim` 13 例全绿。收敛命中表触碰了 80+ 个源文件和 12 个测试文件，两套件是这次重构唯一的行为安全网，一次都没有降级为「改测试迁就实现」——每一处红都是测试自己的旧形状（`h.x` → `h.rect.x`、`action` → `fn`）。
- `tsc --noEmit`（`tsconfig.json` + `tsconfig.test.json`）、`eslint src`、500 行门禁、包体门禁、`test:sim`、`web` + `wechat` 两个 production 构建全通。
- **微信主包只多付 585 字节**（2188322 → 2188907；其中 §0.2 的两处修复 + 松手试听占 148 字节，`sfx.result.draw` 占 28 字节），依旧接近持平：cue 字符串字面量 + `ui/hits.ts` + `audioSettings.ts` 是进包了，但**收敛本身省下的比它们花掉的还多**——大厅那条 18 分支链、战斗/世界地图 HUD 的 if 链、五份手抄的私有 `inRect`，全都塌成了共享的一份。**播放引擎仍旧没进**（`grep createOscillator` 命中 0 次）：`entries/wechat.ts` 依旧不 import `WebAudioBus`，装的是 `NullAudioBus`，所以微信上这些 `playSfx` 全部落在空操作上。
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

修法：`AudioSlider` 加一个可选 `onRelease`，由**面板**（不是场景）决定松手响不响。`master` / `sfx` 两根在 pointer-up 时试听一声 `sfx.ui.tap`；**`bgm` 那根保持静音**——它现在接的是接受并忽略的 `setMusicVolume`（§7 第 7 步之前没有轨），用一个 SFX cue 去试听它等于对「这根滑杆管什么」撒谎。

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
| `sfx.result.victory` / `.defeat` / `.draw` | 结算（`game_over` / `game_draw`，写在一次性门内部） | 三音上行 / 二音下行 / **同音重复、音高不动** | P0 |

### 2.2 UI SFX

全部已接（2026-08-31，§7 第 4 步）。「出口」一列是**唯一**发这个 cue 的地方——新增触发点时改那里，不要在别处调 `playSfx`。除下表四行之外还有第五个出口：`SettingsScene/audioPanel.ts` 的音量滑杆在**松手**时试听一声 `sfx.ui.tap`（滑杆刻意不是 hit，理由见 §0.2 (B)）。

| 事件 id | 触发 | 出口 | 优先级 |
|---|---|---|---|
| `sfx.ui.tap` | 按钮/格子点击 | `ui/hits.ts` 的 `runHit` 默认值——命中表走 `dispatchHit`/`hitAction`，PIXI 原生监听走 `tapHandler(fn)`，两条都汇进 `runHit` | P0 |
| `sfx.ui.back` | 返回/关闭 | 同上，hit 上写 `sound: 'sfx.ui.back'` / `tapHandler(fn, 'sfx.ui.back')`（27 处 `hdr.backRect` + 模态 dismiss 遮罩 + 对话框 Cancel + 结算页返回芯片） | P1 |
| `sfx.ui.reward` | 领奖/获得物品 | 同上，写在各 claim 按钮的 hit 上（成就/日常/周常/活动/战令/充值里程碑） | P1 |
| `sfx.ui.gacha.reveal.common` / `.rare` / `.epic` | 盲盒揭示，按稀有度分层。实现成**三个独立 cue** 而不是一个 cue 的三个 variant：variant 是抗重复疲劳的随机取样，语义分层必须可寻址，否则调用方无法表达"这一抽是史诗" | `GachaScene/core.ts` 的 `revealCue(results)`，**一次抽一声**、取这一抽里最好的稀有度（legendary 并入 epic） | P1 |
| `sfx.ui.error` | 失败/余额不足 toast | `net/log.ts` 的 `showToastMessage`，仅 `kind === 'error'`（不是 hit：失败来自异步结果）。**经 `raiseErrorCue()` 前沿节流，400 ms 一声**——一次失败扇出成多个 rejection 时，视觉层（`GlobalToast.show()` 先 `clear()`）只显示一条消息，音频层原先却会发出 2.4 倍于全表最响 cue 的爆音，实测见 §0.2 (A) | P2 |

### 2.3 BGM（循环长音）
| 轨 id | 场景 | 备注 |
|---|---|---|
| `bgm.lobby` | 大厅 / 菜单 / 商店 | 轻松、低存在感 | 
| `bgm.battle` | 对战 / 战役关卡内 | 节奏稍快、不喧宾夺主 |
| `bgm.intro` | 首启故事（IntroScene） | 叙事氛围，可与 BGM_lobby 共用 |
| `bgm.victory` / `bgm.defeat` | 结算短乐句（stinger，非循环） | 接 ResultScene |

> 结算 stinger 走 SFX 管线（一次性），不占 BGM 槽 —— 已实现为 `sfx.result.victory` / `sfx.result.defeat` / **`sfx.result.draw`**（2026-08-31 补齐），是 catalogue 里优先级最高（120）的三个 cue，谁都不许抢。三者互斥（一局只可能以一种方式结束），所以彼此之间没有可排的名次；`cueCatalogue.test.ts` 把「结算档正好三个」钉死，好让第四个"结局"必须是一次有意的编辑。

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
- **松手试听（2026-08-31 新增，§0.2 (B)）**：`master` / `sfx` 两根滑杆在 pointer-up 时播一声 `sfx.ui.tap`。**不在拖动中播**——`onDrag` 每次 pointer-move 都跑（实测一次真实拖动约 60–120 次），一次 move 一声就是 §0.1 里 `sfx.ink.tick` 那个机关枪换成手指。`bgm` 不试听：它现在什么都不驱动，用 SFX cue 去试听它是对「这根滑杆管什么」撒谎。落在 `AudioSlider.onRelease` 上而不是场景里，好让「松手响不响」和「响什么」仍然是 `audioPanel.ts` 一处的决定。
- **同瞬叠加是混音的一条硬约束（§0.2 (C)）**：同一个 cue 在同一瞬间播 n 次，**音调型精确线性放大 n 倍**、噪声型只放大约 √n。所以任何**可能被同瞬触发多次**的 cue 都必须走合并（`play(cue, count)`，n=8 时比裸叠安静 5.5 倍）或节流；否则一次扇出发出的声音会比游戏里任何设计音都响一倍多。战斗侧靠 `EventsPanel.flushAudio` 的同帧合并，toast 侧靠 `raiseErrorCue()` 的节流。
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
| cue 词汇表 + 混音表 | ✅ `audio/types.ts`（**18 个** cue，2026-08-31 补入 `sfx.result.draw`）+ `audio/cueCatalogue.ts`（gain/priority）。往 union 里加 cue，在 catalogue 里给它决策之前**编译不过** |
| 程序化合成音（占位声源 + 永久兜底） | ✅ `audio/audioSynth.ts`，每个 cue 一把，文具拟音方向。**没有人听过** |
| 样本加载 / 解码 / 并发上限 / 混音器 | ✅ `SampleBank` + `decodeAudio` + `VoiceBudget` + `CueMixer`，79 个用例 / 99.4% 行覆盖 |
| 资产文件 + 命名约定 | 🟡 目录与命名已定（`client/src/assets/audio/`，`<cue id 的 '.' 换成 '-'>_NN.mp3`，webpack 的 `asset/resource` 规则已涵盖 `mp3\|wav\|ogg`，无需改配置），`custom.d.ts` 已声明 `*.mp3`。**但一个文件都还没有**：`cueAssets.ts` 是空的，全部 cue 走合成音。素材是独立一步——见 §7 第 6 步为什么现成的 CC0 游戏音效包用不了 |
| 触发埋点：游戏事件 → `playSfx` | ✅ 2026-08-31。单一漏斗：`render/GameRenderer/core.ts` 的 `for (const event of state.events) this.events.handleEvent(event, state)` 之后跟一次 `this.events.flushAudio()`；映射表全在 `render/GameRenderer/events.ts` 的 `EventsPanel.collectCue` 一处（**不在纯引擎层**——音频是表现层，`@nw/engine` 一行没动）。完整映射与实测见 §0 / §0.1。<br>那个已知的坑按预期咬人了：game over 后引擎 `step()` 提前返回、**不排空事件队列**，重复被消费的是**最后一帧的整批事件**（不只是 `game_over`），所以 `collectCue` 第一行就是 `if (this.core.gameEnded) return`，胜负 stinger 则写在 `game_over`/`game_draw` 分支里那个已有的一次性门**内部**。真浏览器三局复测：每局 stinger 恰好 1 次 |
| UI 触发埋点 | ✅ 2026-08-31。先抽了 `ui/hits.ts`（共享 `Hit<S>` + `inRect`/`hitTest`/`runHit`/`dispatchHit`/`hitAction`/`tapHandler`），**22 份重复的 `interface Hit` 全部消失**，十几处内联的 `hitRects: { rect; action }[]` 一并收敛、`action` 改名 `fn`；UI cue 只在 `runHit` 一处发出，`sound` 省略即 `sfx.ui.tap`。覆盖三族按钮：①场景自持的矩形表；②战斗 HUD / 世界地图 HUD 的手写 `overRect` if 链；③**PIXI 原生 `pointertap` 按钮**（结算页 + 回放 + 五个对话框，第一遍漏掉的 22 处，见 §0 的 ⚠️）。防复发靠源码守卫 `test/uiTapSoundCoverage.test.ts` |
| 设置页音量项 | ✅ 2026-08-31。`scenes/SettingsScene/audioPanel.ts`（右栏，三根滑杆 + 静音开关）+ `audio/audioSettings.ts`（`nw_audio` 一个 JSON 键）。滑杆**不是 hit**：它要跟手，所以留在 `audioSliders: { rect; onDrag; onRelease? }` 里，按下即接管指针、`update()` 每帧最多重绘一次（render()-per-pointermove 会卡）。<br>**§0.2 订正了两件事**：①版面撞在贯穿整宽的语言按钮行上（滑杆先查 hit 后查，所以是**静默**吃掉半个 Deutsch 按钮），已搬到 `0.60w / 0.30h` 并配 `test/ui/settingsSliderOverlap.ui.ts` 守着「滑杆矩形不许与 hit 矩形相交」；②「跟手好让玩家听到档位」这句话原本是假的（拖动一声不响、又没有 BGM），现在 master / sfx 松手时试听一声 `sfx.ui.tap`，实测试听峰值与档位严格成正比 |
| 首启解锁手势 | ✅ 不需要调用方接：`WebAudioBus` 自己在 `window` 上挂 `pointerdown`/`keydown`/`touchstart`（见 §3） |
| 盲盒/结算 stinger | ✅ 2026-08-31。结算 stinger 在 `EventsPanel`（§7 第 3 步），盲盒揭示在 `GachaScene/core.ts` 的 `revealCue()`——**一次抽一声**，取这一抽里最好的稀有度 |
| 浏览器冒烟入口 | ✅ `entries/web-e2e.ts` 暴露 `window.__nwAudio`：`play(cue)` / `resume()` / `cues` / `loaded()` / `log()` / `clearLog()`（总线包一层的 cue 流水账——AnalyserNode 只告诉你“响了、多响”，告诉不了你“响的是哪个 cue、合并了几个事件”，而一局里 cue 飞得比人眼快），**加 2026-08-31 新增的 `nodes()`**——直接交出 `AudioContext` 与 SFX 总线 `GainNode`，好让冒烟自己挂 `ScriptProcessorNode`/`AnalyserNode` 量**交付**峰值。必须是一个显式接缝而不是事后 patch：`app.ts` 的 `preload()` 启动时就建好了上下文，patch `AudioNode.prototype.connect` 永远晚一步（§0.2 开头那两个坑） |

> **架构红线**：音频是**表现层**，触发点放在 render/scene 层订阅引擎事件，**不污染 `client/src/game`（纯 TS 确定性引擎）**——与 PIXI 渲染同级处理，保证引擎/回放/裁判确定性不受音频影响。

---

## 7. 待办（开发顺序）

1. ~~平台音频抽象 + Web(WebAudio) 实现 + 首手势解锁。~~ ✅ 2026-08-31（形态改判为模块级接缝，见 §3）
2. ~~cue 词汇表 + 混音表 + 程序化合成音 + 样本加载/解码/并发上限/混音器。~~ ✅ 2026-08-31
3. ~~**战斗触发点**。~~ ✅ 2026-08-31（`EventsPanel.collectCue` + `flushAudio`，含同帧合并与 game-over 一次性门；真浏览器实测见 §0.1）。留下的两个口子**现在都补完了**：`sfx.card.invalid` 在第 4 步接上（客户端判的非法出牌，引擎不发事件）；`sfx.result.draw` 在第 6 步接上（见那一条）。
4. ~~**UI 触发点**：先抽共享 hit 表 + 派发器（消掉 22 份重复的 `interface Hit`），再在那一处挂 `sfx.ui.*`；`SettingsScene` 三档音量 + 静音持久化。~~ ✅ 2026-08-31（`ui/hits.ts` + `audio/audioSettings.ts` + `SettingsScene/audioPanel.ts`；顺带补上了上一轮留下的 `sfx.card.invalid`。完整说明见 §0）。**真浏览器实测已补完**（§0.2），抓出并修掉两个缺陷：音量区版面撞语言按钮行（静默吃掉半个按钮）、`showToastMessage` 的错误音扇出成 2.4 倍爆音；顺带补上滑杆的松手试听。
5. 微信 `InnerAudioContext` 后端 + 对象池（**不需要为体积分包**，见 §5 订正）。
6. **音频素材**（+ 平局 stinger）。
   - ~~平局没有 stinger（词汇表缺 `sfx.result.draw`）——第 3、4 步各自留给这一步的口子。~~ ✅ 2026-08-31：`sfx.result.draw` 已进词汇表 / catalogue / 合成音 / `game_draw` 触发点，真浏览器交付峰值 0.1179（与失败 0.1178 齐平）。过程与那条「音调型 cue 的峰值取决于音符有没有重叠」的新规律见 §0.2 (E)。
   - **素材本身仍未开始**，成本比它看起来高，原因是我们的美学方向：
   - art-direction §声音 明令**禁止**金属碰撞与爆炸轰鸣，而现成的 CC0 游戏音效包（如 Kenney 的 Impact / Sci-Fi / Digital 那几个：激光、金属撞击、玻璃碎、爆炸）**整个落在禁用清单里**。能直接复用的只有 Interface Sounds 那一包里的 UI 音（tap/back/toggle/error 形状），战斗音必须另找纸质 foley（freesound.org 的 CC0 拟音）或自录。
   - 素材到位后**按合成音峰值对齐**再进仓。这样换样本不改变混音权重，`cueCatalogue.ts` 那张表不用跟着调。
     > **⚠️ 订正（2026-08-31）：本条原先写的是「`tone`/`noise` 两个原语的峰值就是它们的 `gain` 参数，所以这一步不需要重新渲染测量」——这句话已经被两轮实测各证伪一次。** §0 发现噪声过一道低通会损失取决于截止频率的能量（`sfx.unit.hit` 授权 0.15、交付 0.063）；§0.2 (E) 发现音调型 cue 的峰值还取决于**音符有没有重叠**（`sfx.result.draw` 授权 0.12、交付 0.0943，只因两个音刻意不重叠）。所以对齐的基准**必须是实测的交付峰值**，不是 `gain` 参数——本文 §0 的那张表就是这个基准（读它前先看那张表下面关于精度的警告：噪声型 cue 要测 10 次以上取中位数）。「UI 那几个各自只用一个原语」仍然是真的，但它省下的只是一层复杂度，不是那次测量。
   - 值得整套移植 daydayup 的 `tools/audio-pipeline/`（audit → 剔除削波/双声道假立体声 → 裁前后静音 → 按各文件自己的 rolloff 搜最小采样率 → 峰值对齐）——那部分与素材来源无关。
   - 接入方式：在 `audio/cueAssets.ts` 加一行 `import` + 一个条目，其余代码一行不用改。一个写错的文件名是**构建失败**而不是静默退回合成音。
7. BGM（`bgm.lobby` / `bgm.battle` / `bgm.intro` 两到三轨）+ 切场景淡入淡出 + 失焦暂停 + 可选 ducking。这半边**没有可参照的先例**，接口形状也与 SFX 不同（单实例 + 淡入淡出 + 流式），需要单独设计。
